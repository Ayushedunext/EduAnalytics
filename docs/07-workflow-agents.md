# 07 — Workflow Agents (No-Code Automation)

## 1. Concept

A **Workflow Agent = Trigger + Flow + Schedule**, drawn by the school as a flowchart, stored as a JSON graph, executed by the platform:

```
WHEN  <trigger fires>        schedule tick / data condition / email received /
                             ERP event webhook / manual
FOR EACH <matched record>    e.g. each student absent today
DO    <walk the flowchart>   conditions → branches → actions → waits → escalation
```

Canonical example (the requirement's own): *every school day at 10:30, fetch students absent today; skip if the parent was already notified; if consecutive absences ≥ 3 → WhatsApp "3rd-day" alert + notify class teacher + wait till 2 PM + escalate to Principal; else → WhatsApp "absent today", SMS fallback on delivery failure.*

Schools create **unlimited agents**. Multi-school orgs can deploy one agent to any/all of their schools.

## 2. Node palette

| Category | Nodes | Notes |
|---|---|---|
| **Triggers** (exactly 1) | ⏰ Schedule · 🗄️ Data condition · 📧 Email received (IMAP watch) · ⚡ ERP event (webhook) · ▶️ Manual | Schedule + data condition combine naturally ("at 10:30, find absentees") |
| **Data** | 🔍 Fetch records (no-SQL visual filters; advanced SELECT-only tab) · 🧮 Compute | Replicas only |
| **Logic** | ◇ If/Else (field–op–value, AND/OR groups) · ◇ Multi-branch · ⏳ Wait (duration / until-time, school TZ) · 🔁 Dedup guard |
| **Actions** | 📱 WhatsApp · 💬 SMS · ✉️ Email · 🔔 ERP app notification · 👤 Notify staff · 🤖 AI-compose (BYOK-gated) · 🌐 Webhook · 📝 Log |
| **End** | ● End · 🚩 Escalate & end |

Every node exposes downstream **variables** (`{{student.name}}`, `{{parent.phone}}`, `{{fee.pending_amount}}`, …) picked from a dropdown, never typed blind.

## 3. Execution architecture

```
BUILDER (React Flow canvas) ──publish──► agent_definitions (versioned; runs pin a version)
                                              │
SCHEDULER (per-agent cron; ticks default 5 min or exact time)
   ▼
TRIGGER EVALUATOR
   · data conditions: SQL on READ REPLICA via the MCP-style read-only layer (capped)
   · IMAP poll ~2 min for mail triggers · webhook receiver for ERP events
   ▼ matched rows
RUN ORCHESTRATOR (queue: SQS/BullMQ) — one RUN per record
   · walks the graph as a PERSISTED STATE MACHINE
   · Wait nodes = delayed jobs, not threads → restarts lose nothing
   · idempotency: auto-derived DEDUP KEY (agent+node+record+date)
   ▼
ACTION WORKERS — WhatsApp BSP · SMS(DLT) · SMTP · ERP notify API · Claude
   ▼
run_log / run_steps / message_log  (per-node input/output/status)
```

**Design rules:**
1. **Read from replicas, write nowhere** — the only "writes" are messages and ERP-API notifications; agents structurally cannot corrupt school data, and trigger load never touches ERP primaries.
2. **Poll + event hybrid** — ticks for schedule/data triggers; webhooks for instant ERP events.
3. **Idempotency by default** — overlapping ticks can never double-message a parent for the same event.
4. **Versioned + auditable** — publish creates version N; running agents pin versions; every run logs every node ("prove we informed the parent at 10:31").

Storage (platform DB, never school DBs): `agents(id, school_or_org_id, name, status, version, graph_json, schedule, stats)` · `agent_runs(run_id, agent_id, record_ref, status, started, finished)` · `run_steps(run_id, node_id, status, payload_in, payload_out, ts)` · `message_log(…)`.

## 4. Channels — configured by the school, selected per message node

**Ownership decision:** messaging providers belong to the school/org, configured once in Settings › Messaging Channels: **Email (SMTP)**, **SMS (DLT provider + registered Sender ID)**, **WhatsApp Business (BSP, e.g. Gupshup/Twilio/Meta Cloud API)** — each with a Connected/Not-connected status.

**Per-node channel selection:** every message action node presents checkboxes of the school's channels; the first checked is **PRIMARY**; a **fallback channel** dropdown handles delivery failure (e.g., WhatsApp failed → SMS). **Only connected channels are selectable**; publishing an agent that references a disconnected channel is refused; a later disconnect flags dependent agents until reconnected or edited.

**India compliance is a first-class constraint:** SMS requires DLT-registered sender + approved templates; WhatsApp requires BSP/WABA-approved templates. Hence the **Template Manager** (create → submit → approved library); message nodes reference approved templates only — free text cannot be sent on those channels. Template variable slots map to node variables. *Open item:* BSP/SMS provider choice gates approval timelines more than any code (doc 11).

## 5. Always-on guardrails (platform-level, every agent)

🔁 Dedup (never double-message for the same event) · 🌙 Quiet hours (default 8 PM–7 AM, school-level policy; bounded per-node overrides) · 📊 Daily message cap per school (e.g., 2,000) · ⏸ Auto-pause after N consecutive failures · unsubscribe handling · per-agent kill switch · 📑 full per-node audit log · replicas-only reads.

## 6. Builder & operations UX

- **Agents Home (fleet):** KPI strip (active agents, runs, success %, messages today vs cap); rows with schedule, channels, last-run, ON/OFF toggle; template gallery (absence alert, fee reminder 30/60/90, low attendance monthly, exam low-marks, library overdue, birthday wishes, admission follow-up, teacher-absent→substitute, transport broadcast).
- **Builder:** 3-panel — palette | canvas (React Flow: snap-grid, auto-layout, minimap, ✓/✗ edge labels) | properties drawer for the selected node. **Flow linting** blocks Publish on broken graphs (unconnected node, action before trigger, unapproved template). Live counts on nodes after test runs ("41 rows", "38 sent").
- **Test run (dry):** evaluates today's real data on the replica, sends nothing; lights nodes with counts; shows the exact rendered messages per branch; alternative mode sends everything to the tester's own phone/email.
- **Runs & History:** run list; selecting a run **replays it on the same flowchart** — per-node status/payload; failed node shows the provider error with Retry; CSV export of message_log.
- **Per-agent settings:** deployed schools (trust picker), schedule, caps, quiet hours, failure alerts, kill switch, version history + rollback.
- **AI (BYOK-gated):** "**Describe your workflow**" — plain-language sentence → Claude drafts the flow JSON onto the canvas for review; **AI-compose** node drafts message text within an approved template's variable slots (tone, language options). The builder is fully functional without AI.

## 7. Assumptions

1. ERP events (admission created, fee paid) can be emitted as webhooks or a small ERP patch adds them; until then, data-condition polling covers the same cases with tick latency.
2. Trigger evaluation frequency (5-min default ticks) is acceptable; "instant" reactions come only from webhook/mail triggers.
3. Channel config is school-level in v1; trust-level defaults with per-school overrides (e.g., one BSP account, per-school SMS sender IDs) is the anticipated evolution — flagged as an early schema decision (doc 11).

## 8. Extensibility

- New action workers (voice call, parent-app push) plug into the worker interface; flow semantics untouched.
- New trigger types register with the evaluator (e.g., rollup-threshold triggers: "attendance % dropped below X").
- Agent templates are data; the gallery grows without releases.
