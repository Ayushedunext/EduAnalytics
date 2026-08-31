# 10 — UI/UX & Design System

## 1. Design language

Clean, whitespace-heavy, card-based; the AI is the hero feature but nothing depends on it. Reference feel: *Linear's calm + Stripe Dashboard's data density, tuned for school administrators — friendly, not fintech-cold.*

### Tokens (source of truth)

| Token | Value | Use |
|---|---|---|
| Deep Teal | `#028090` | Primary actions, primary chart series |
| Ink | `#032E36` | Headings, sidebar/nav, dark bands |
| Seafoam | `#00A896` | Secondary series, secondary accents |
| Mint | `#02C39A` | Success, active/ON states |
| Amber | `#F2A93B` | Warnings, fees-outstanding, secondary chart series |
| Red | `#E05252` | Errors, defaulter counts, FALSE branches |
| Slate `#334155` / Muted `#64748B` | Body text / captions |
| Canvas `#F1F5F9` / Card `#FFFFFF` | Page background / cards |

Type: **Inter**, one scale — Page title 28 semibold · Card heading 18 semibold · Body/table 14 · Caption/kicker 11 (+2 tracking); tabular figures for all numbers. Components: 8 px radius cards with soft shadows; primary (filled teal) / secondary (teal outline) / ghost buttons; chips; KPI cards (big number + delta pill); switches.

### Principles

1. **Calm surfaces** — data is the color, chrome is quiet.
2. **One chart language** — teal-family series, amber for warnings, no gridline clutter, values labelled on bars; identical across predefined, custom, AI reports and PDFs (a direct consequence of spec-driven rendering, doc 05). Categorical series are capped at **four** steps (`#028090`, `#02c39a`, `#f2a93b`, `#e05252`) — a CVD/contrast audit (2026-08-22) failed the prior seven-color rotation, since two teal-family steps that close together are indistinguishable at chart-mark size regardless of color vision. A category past the fourth is never a fifth generated hue; it folds into a recessive "Other" fill (`#64748b` at reduced opacity).
3. **Tenant theming** — each school/trust gets accent color + logo (topbar, buttons, PDF header) from the same token system; no per-client CSS forks.
4. **Feels instant** — skeleton loaders, streamed AI widgets, optimistic filter changes; UI responds within 100 ms even while data loads.

## 2. Screen inventory

| Screen | Essentials |
|---|---|
| **(ERP) menu → launch** | "📊 Analytics" item; handoff interstitial may show token-verification steps; there is **no login screen** in this product |
| **Main shell** | Sidebar (Dashboard, Dashboards, Attendance…, ⚡ Agents, 🤖 Ask AI, My Reports, Export History, ⚙ Settings); topbar: crumb · **school picker** · AY selector · avatar |
| **School picker** | Multi-select with Select-all / Only-this-school; hidden for single-school users; every page, chat message and PDF carries the selection |
| **Dashboard / overview** | Greeting; hero **ask-bar** (locked state: disabled + 🔒 + "complete AI setup in Settings"; admins get "Set up now →", others "ask your administrator"); KPI strip; **"Your dashboards"** — one live preview card per `available` dashboard (its own lead widget, same cache entry the dashboard itself uses), catalog order (Fee Collection, Fee Defaulters, Staff Overview, Admissions Funnel, Attendance Analytics, Enrollment Overview), skeleton per card until its preview resolves; **"More dashboards"** — a single slim chip strip for `coming`/`blocked` dashboards (status pill, tooltip reason), not full tiles. Superseded 2026-08-26: the prototype's two link-tile galleries ("Director dashboards" / "School dashboards") duplicated the sidebar's own nav one-for-one; Home's job is now to show something FROM each dashboard, not a second way TO it — the sidebar remains the one menu (Main shell row, below). **Renamed 2026-08-31: "Home" is now "Dashboard".** The screen is the one overview a user lands on, and "Home" said where it sat in the nav rather than what it showed. The nav label and the topbar crumb are the only user-visible strings that moved; the route key, `/api/home` and `Home.tsx` keep their names, because `Dashboard*` already denotes the predefined reports throughout the orchestrator (`DASHBOARD_IDS`, `buildDashboard`) and renaming into that collision would cost more clarity than it bought. The plural "Dashboards" therefore stays the name of the predefined-report group and is never a label for this screen. **KPI strip amended 2026-08-31:** four summary cards, in this order — Students (gender mix), Staff on roll (permanent / not permanent / unclassified), Student attendance (present and absent student-days) and Total fees (collected / pending). Each leads with one figure and carries its parts beneath it (`kpi.breakdown`, 2–3 parts, pre-formatted server-side like the figure itself). Card order is the server's widget order and is contract, not presentation: `Home.tsx` gives the first card the hero treatment. Two cards changed meaning rather than merely gaining a split — fees now leads with the year's DEMAND and shows arrears as a part (the bare outstanding figure could not be read without the size of the book it came from), and the staff split names an "Unclassified" part wherever `stafftype` holds one of the ERP's opaque codes rather than guessing it into permanent or not. **Grid amended 2026-08-31:** the card grid is a curated six in a fixed server-side order — Fee Collection, Fee Defaulters, Attendance, Enrollment, Staff Overview, Transport — sent as `grid` on `/api/home` rather than derived in the SPA. Each card draws the report's DRILL-ENTRY chart (level 1, one bar per school, `DASHBOARD_DRILL_QUERY`) where a curated path exists, and its lead chart where it does not; Staff Overview and Transport have no path yet and render inert until they grow one. Every `available` dashboard used to get a card, which was nine and growing — the sidebar drawn larger. The "More dashboards" strip below now carries three kinds: built-but-not-gridded dashboards are clickable with no pill, while `coming` and `blocked` keep their pill and stay inert. |
| **Predefined dashboard** | Title + scope line; filter pills; KPI strip; charts; data table; footer: ⬇ PDF · ↺ Refresh · 🧠 View logic · ⧉ Clone & customize · 🤖 Ask AI about this data; drillable panels carry the "⌄ Drill-down · 3 levels" chip; a cloneable chart (docs/06 §3) carries its own small ⧉ in its panel header — a popover for name, academic year and, on a bucketable widget, week/month/quarter/year — separate from the page-level Clone button, which still clones the whole dashboard |
| **Drill view states** | Pointer cursor + hover hint → in-place chart swap → breadcrumb `Report ▸ Apr-26 ▸ Class 9` (clickable crumbs) + ← Back + ⟲ Reset + "level n of 3" + recomputed slice total; deepest-level note |
| **Ask AI** | Split: chat (35%) with streaming status steps, suggestion chips, Refine · artifact canvas (65%) with KPI chips, chart, table, narrative, and actions ⬇ PDF · 💾 Save · 🧠 Logic · ⧉ Clone · ✎ Refine; mobile: two swipeable tabs. Locked state: centered card with 🔒, "predefined dashboards already available", setup CTA |
| **Report editor** | Renamable title; **Report type: Simple / ⌄ Drill-down (3 levels)**; visual logic editor (source, filter chips, group-by/levels, chart per level) beside the **live-regenerating SQL** panel; ✨ Modify with AI; interactive preview (clickable through levels for drill reports); Save as my report |
| **Custom report view** | Report + version + "cloned from"; 🧠 View logic panel; Edit / Clone / PDF; each chart carries its own **✦ Ask AI** button (owner-only; locked, not hidden, when AI isn't set up) opening a side panel — chat about that chart or ask for a change, with **Apply as a new version** to persist a proposal (docs/06 §1) |
| **My Reports** | Custom reports (CUSTOM badge, version, View/Edit/Clone/PDF) + AI snapshots (AI badge, Re-run/PDF); ＋ New custom report |
| **Agents home** | Fleet KPIs; agent rows (status dot, schedule, channel icons, last run, ON/OFF switch, Edit flow, Runs); template gallery |
| **Agent builder** | 3-panel: palette | canvas | properties; toolbar ▶ Test run · 💾 Save draft · 🚀 Publish; lint badges; live counts after test; 🤖 "Describe your workflow" drawer |
| **Test-run panel** | Dry-run: node counts, exact rendered message previews per branch, "send test to my phone" |
| **Runs & history** | Run list · flowchart replay with per-node status/payload · Retry on failures · CSV export |
| **Settings — AI (org)** | 3-step BYOK wizard (Console guide + PDF, key + model + monthly cap, Test & Save, verification); post-activation: status, per-school usage/cost meter, Replace/Disable; error banner path |
| **Settings — Messaging channels (school)** | Email(SMTP) / SMS(DLT) / WhatsApp(BSP) provider rows with Connected status + Connect/Disconnect; Template Manager note (approved templates only) |

## 3. UX conventions (bind all screens)

- **Locked ≠ hidden:** gated features stay visible with a lock and a path to unlock (drives setup better than hiding).
- **Scope is always on screen:** picker chip in the topbar; scope line under report titles; scope printed on PDFs.
- **Transparency affordances everywhere:** 🧠 View logic and ⧉ Clone appear on every report surface, including AI artifacts.
- **Status streaming for anything slow:** AI steps, agent test runs, PDF generation — never a bare spinner.
- **Destructive/irreversible actions** (publish agent, disable AI, disconnect channel) confirm consequences in plain language, and every such state has a reverse path.
- **Empty states teach:** My Reports and Agents explain how their first item is created.

## 4. Assumptions

Desktop-first (admin work); layouts degrade to single-column at ~980 px; the Ask-AI split becomes tabs on mobile. Localization (Hindi/regional) is anticipated in message templates (AI-compose language option) before full UI localization.

## 5. Reference artifacts

A clickable HTML prototype implements every screen above with sample data ("Sunrise Trust": Delhi/Noida/Gurgaon) including the ERP login → launch handoff, drill-down, clone/editor, agents and BYOK gating; a 19-slide architecture deck mirrors the same design system. Both are **design references, not production code** — the design system tokens and conventions in this document are the binding spec.
