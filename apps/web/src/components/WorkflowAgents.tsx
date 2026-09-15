/**
 * Workflow Agents (docs/07) — the fleet view and the builder.
 *
 * -- Why the builder is a guided form, not a freeform drag-and-drop canvas --
 * The reference screens (docs/11 Artifacts) show a form on the left driving a
 * generated flow preview on the right, not a blank canvas a school drags
 * nodes onto — and only one template (`absence-alert`) has a real evaluator
 * behind it yet (@sap/agent-graph's `FETCH_SOURCES`/`RUNNABLE_*` sets, and
 * docs/11's 2026-09-15 entry). So this builder edits the DATA on a fixed
 * 8-node shape (trigger → fetch → dedup → if/else → two message branches →
 * two ends) rather than letting a school assemble an arbitrary graph from the
 * full node palette docs/07 §2 describes. Freeform authoring is real future
 * work, tracked in that same roadmap entry, not something this file pretends
 * to offer.
 *
 * The flow preview on the right IS `@xyflow/react` — CODING_GUIDELINES §4
 * fixes React Flow as the builder canvas — rendering the exact graph this
 * form edits, read-only (no drag-to-rewire yet).
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AGENT_TEMPLATES,
  FETCH_SOURCES,
  findTemplate,
  type AgentEdge,
  type AgentGraph,
  type AgentNode,
  type ChannelId,
} from '@sap/agent-graph';

/** Fields that identify or contact a record, never a sensible condition to
 * branch on — every other field a fetch source declares is a candidate. */
const NON_CONDITION_FIELDS = new Set(['student_id', 'student_name', 'class', 'section', 'parent_phone']);
import {
  ApiFailure,
  createAgent,
  getAgent,
  getAgentRuns,
  getAgentsHome,
  getRunSteps,
  publishAgent,
  runAgentNow,
  saveAgentDraft,
  setAgentActive,
  testRunAgent,
  type AgentDetail,
  type AgentRunRow,
  type AgentRunStepRow,
  type AgentSummary,
  type AgentTestRunResult,
  type AgentsHomeResponse,
  type SessionResponse,
} from '../api/client';

interface Props {
  session: SessionResponse;
  schoolIds: readonly string[];
}

type View = { kind: 'home' } | { kind: 'builder'; agentId: string } | { kind: 'runs'; agentId: string; agentName: string };

export function WorkflowAgents({ session, schoolIds }: Props): ReactElement {
  const [view, setView] = useState<View>({ kind: 'home' });

  if (view.kind === 'builder') {
    return (
      <AgentBuilder
        agentId={view.agentId}
        session={session}
        onBack={() => { setView({ kind: 'home' }); }}
        onViewRuns={(agentName) => { setView({ kind: 'runs', agentId: view.agentId, agentName }); }}
      />
    );
  }

  if (view.kind === 'runs') {
    return (
      <AgentRunsView
        agentId={view.agentId}
        agentName={view.agentName}
        onBack={() => { setView({ kind: 'home' }); }}
        onEditFlow={() => { setView({ kind: 'builder', agentId: view.agentId }); }}
      />
    );
  }

  return (
    <AgentsHome
      schoolIds={schoolIds}
      onOpen={(agentId) => { setView({ kind: 'builder', agentId }); }}
      onViewRuns={(agentId, agentName) => { setView({ kind: 'runs', agentId, agentName }); }}
    />
  );
}

// ---------------------------------------------------------------------------
// Fleet view
// ---------------------------------------------------------------------------

function AgentsHome({
  schoolIds,
  onOpen,
  onViewRuns,
}: {
  schoolIds: readonly string[];
  onOpen: (id: string) => void;
  onViewRuns: (id: string, name: string) => void;
}): ReactElement {
  const [data, setData] = useState<AgentsHomeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    getAgentsHome()
      .then(setData)
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not load agents.'); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = useCallback(() => {
    setCreating(true);
    createAgent({ name: 'Untitled agent', school_ids: [...schoolIds] })
      .then(({ agent }) => { onOpen(agent.id); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not create agent.'); })
      .finally(() => { setCreating(false); });
  }, [schoolIds, onOpen]);

  const handleToggle = useCallback(
    (agent: AgentSummary, active: boolean) => {
      setAgentActive(agent.id, active)
        .then(load)
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not update this agent.'); });
    },
    [load],
  );

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1400px]">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
          <div>
            <h1 className="page-title">Workflow Agents</h1>
            <div className="pageContext">
              <span>Your school builds its own automations — unlimited agents, runs read replicas only, zero ERP load</span>
            </div>
          </div>
          <button type="button" className="btn btnPrimary" onClick={handleCreate} disabled={creating}>
            {creating ? 'Creating…' : '+ Create agent'}
          </button>
        </div>

        {error !== null && <div className="notice mb-4">{error}</div>}

        {data === null ? (
          <div className="text-[13px] text-[var(--color-muted)]">Loading…</div>
        ) : (
          <>
            <div className="kpis">
              <Kpi label="Active agents" value={String(data.kpis.active_agents)} tone="positive" />
              <Kpi label="Runs this week" value={String(data.kpis.runs_this_week)} />
              <Kpi
                label="Run success rate"
                value={data.kpis.success_rate_pct === null ? '—' : `${String(data.kpis.success_rate_pct)}%`}
                tone={data.kpis.success_rate_pct !== null && data.kpis.success_rate_pct < 90 ? 'warning' : 'positive'}
              />
              <Kpi label="Messages today" value={`${String(data.kpis.messages_today)} / ${String(data.kpis.messages_cap)} cap`} />
            </div>

            <div className="card" style={{ marginTop: 14 }}>
              {data.agents.length === 0 ? (
                <div className="p-6 text-[13px] text-[var(--color-text-muted)]">
                  No agents yet — create one, or start from a template below.
                </div>
              ) : (
                data.agents.map((agent) => (
                  <div className="agentRow" key={agent.id}>
                    <span className={`agentDot${agent.status === 'active' ? ' on' : ''}`} aria-hidden="true" />
                    <div className="agentBody">
                      <b>{agent.name}</b>
                      <p className="agentMeta">
                        {agent.schedule_label ?? 'Manual trigger'}
                        {agent.last_run_at !== null && ` · last run: ${new Date(agent.last_run_at).toLocaleString()} · ${agent.last_run_status ?? ''}`}
                      </p>
                    </div>
                    <div className="agentRowActions">
                      <button type="button" className="btn btnGhost" onClick={() => { onViewRuns(agent.id, agent.name); }}>
                        Runs
                      </button>
                      <button type="button" className="btn btnOutline" onClick={() => { onOpen(agent.id); }}>
                        Edit flow
                      </button>
                      <label className="toggleSwitch" title={agent.status === 'draft' ? 'Publish this agent first' : agent.status === 'active' ? 'Turn off' : 'Turn on'}>
                        <input
                          type="checkbox"
                          checked={agent.status === 'active'}
                          disabled={agent.status === 'draft'}
                          onChange={(e) => { handleToggle(agent, e.target.checked); }}
                        />
                        <span className="toggleTrack" />
                      </label>
                    </div>
                  </div>
                ))
              )}
            </div>

            <h2 className="text-[12px] font-bold tracking-wide uppercase text-[var(--color-text-muted)] mt-7 mb-3">
              Start from a template
            </h2>
            <div className="mgrid">
              {data.templates.map((t) => (
                <div
                  key={t.id}
                  className={`card mtile${t.runnable ? ' clickable' : ' mtileEmpty'}`}
                  role={t.runnable ? 'button' : undefined}
                  tabIndex={t.runnable ? 0 : undefined}
                  aria-disabled={!t.runnable}
                  title={t.runnable ? undefined : 'Not built yet — see docs/11'}
                  onClick={() => {
                    if (!t.runnable) return;
                    setCreating(true);
                    createAgent({ name: t.title, school_ids: [...schoolIds], template_id: t.id })
                      .then(({ agent }) => { onOpen(agent.id); })
                      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not create agent.'); })
                      .finally(() => { setCreating(false); });
                  }}
                >
                  <div className="mtileHead">
                    <span className="mtileIc" aria-hidden="true">{t.icon}</span>
                    <b>{t.title}</b>
                  </div>
                  <p className="mtileBlurb">{t.blurb}</p>
                  {!t.runnable && (
                    <p className="mtileReason">
                      <span className="pill nodata">not built yet</span> see docs/11
                    </p>
                  )}
                </div>
              ))}
            </div>

            <p className="text-[11.5px] text-[var(--color-muted)] mt-6 leading-relaxed">
              Guardrails on every agent: dedup (never double-message a parent for the same event), quiet hours,
              a daily message cap per school, auto-pause on repeated failures, and a full per-node audit log
              (ADR-025).
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'warning' }): ReactElement {
  return (
    <div className={`kpi${tone !== undefined ? ` kpi--${tone}` : ''}`}>
      <span className="kpiLabel">{label}</span>
      <span className="kpiFigure">
        <span className="kpiValue">{value}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs & History (docs/07 §6)
// ---------------------------------------------------------------------------

/**
 * Deliberately simpler than docs/07 §6's "replay it on the same flowchart":
 * a run list plus a per-node trail as a plain sequence, not overlaid on the
 * `@xyflow/react` canvas. The data (`run_steps`) is the same either way; the
 * animated-replay-on-the-diagram affordance is a UI enhancement tracked
 * alongside the rest of docs/11's deferred list, not a data gap.
 */
function AgentRunsView({
  agentId,
  agentName,
  onBack,
  onEditFlow,
}: {
  agentId: string;
  agentName: string;
  onBack: () => void;
  onEditFlow: () => void;
}): ReactElement {
  const [runs, setRuns] = useState<AgentRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentRunStepRow[] | null>(null);
  const [stepsLoading, setStepsLoading] = useState(false);

  const load = useCallback(() => {
    getAgentRuns(agentId)
      .then(({ runs: r }) => { setRuns(r); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not load runs.'); });
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const openRun = useCallback(
    (runId: string) => {
      setSelectedRunId(runId);
      setStepsLoading(true);
      setSteps(null);
      getRunSteps(agentId, runId)
        .then(({ steps: s }) => { setSteps(s); })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not load this run.'); })
        .finally(() => { setStepsLoading(false); });
    },
    [agentId],
  );

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1400px]">
        <div className="flex items-center gap-3 flex-wrap mb-1">
          <button type="button" className="btn btnGhost" onClick={onBack}>← Agents</button>
          <h1 className="page-title" style={{ marginBottom: 0 }}>{agentName} — Runs & History</h1>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btnGhost" onClick={load}>Refresh</button>
          <button type="button" className="btn btnOutline" onClick={onEditFlow}>Edit flow</button>
        </div>

        {error !== null && <div className="notice mt-3">{error}</div>}

        {runs === null ? (
          <div className="text-[13px] text-[var(--color-muted)] mt-5">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="card mt-5" style={{ padding: 20 }}>
            <p className="text-[13px] text-[var(--color-text-secondary)]">
              No runs yet. Publish this agent, then either wait for its schedule to fire or click
              "Run now" in the builder to trigger one immediately.
            </p>
          </div>
        ) : (
          <div className="agentBuilderGrid mt-5">
            <div className="card" style={{ padding: 0 }}>
              {runs.map((run) => (
                <div
                  key={run.runId}
                  className={`agentRow${run.runId === selectedRunId ? ' selectedRun' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { openRun(run.runId); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRun(run.runId); } }}
                >
                  <span className={`pill ${runStatusPill(run.status)}`}>{run.status}</span>
                  <div className="agentBody">
                    <b>{new Date(run.startedAt).toLocaleString()}</b>
                    <p className="agentMeta">{run.schoolId} · {summarizeRecord(run.recordRef)}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="card agentPanel">
              <div className="agentPanelHead"><span className="agentPanelDot" />Run detail — per-node trail</div>
              {selectedRunId === null ? (
                <p className="text-[12.5px] text-[var(--color-text-muted)]">Select a run on the left to see what each node did.</p>
              ) : stepsLoading ? (
                <p className="text-[12.5px] text-[var(--color-text-muted)]">Loading…</p>
              ) : steps === null || steps.length === 0 ? (
                <p className="text-[12.5px] text-[var(--color-text-muted)]">No steps recorded for this run.</p>
              ) : (
                steps.map((step) => (
                  <div key={step.id} className={`runStep ${step.status}`}>
                    <div className="runStepHead">
                      <span>{step.nodeId}</span>
                      <span className={`pill ${stepStatusPill(step.status)}`}>{step.status}</span>
                    </div>
                    {step.error !== null && <p className="agentHint warn">{step.error}</p>}
                    {step.payloadOut !== null && (
                      <pre className="runStepPayload">{JSON.stringify(step.payloadOut, null, 2)}</pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function runStatusPill(status: AgentRunRow['status']): string {
  switch (status) {
    case 'completed':
      return 'live';
    case 'failed':
      return 'danger';
    case 'waiting':
      return 'warning';
    default:
      return 'info';
  }
}

function stepStatusPill(status: AgentRunStepRow['status']): string {
  switch (status) {
    case 'succeeded':
      return 'live';
    case 'failed':
      return 'danger';
    case 'skipped':
      return 'warning';
    default:
      return 'info';
  }
}

function summarizeRecord(record: Record<string, unknown>): string {
  const name = record['student_name'];
  if (typeof name !== 'string') {
    return Object.entries(record).slice(0, 2).map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
  }
  if (record['consecutive_days'] !== undefined) return `${name} · ${String(record['consecutive_days'])} day(s) absent`;
  if (record['balance_amount'] !== undefined) return `${name} · ₹${String(record['balance_amount'])} overdue by ${String(record['days_overdue'])} day(s)`;
  return name;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const EMPTY_GRAPH: AgentGraph = { nodes: [], edges: [] };

function AgentBuilder({
  agentId,
  session,
  onBack,
  onViewRuns,
}: {
  agentId: string;
  session: SessionResponse;
  onBack: () => void;
  onViewRuns: (agentName: string) => void;
}): ReactElement {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [graph, setGraph] = useState<AgentGraph>(EMPTY_GRAPH);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [testResult, setTestResult] = useState<AgentTestRunResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    getAgent(agentId)
      .then(({ agent: a }) => {
        setAgent(a);
        setName(a.name);
        const asGraph = a.graph as unknown as Partial<AgentGraph>;
        setGraph(Array.isArray(asGraph.nodes) && asGraph.nodes.length > 0 ? (asGraph as AgentGraph) : EMPTY_GRAPH);
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not load this agent.'); });
  }, [agentId]);

  // Autosave the draft shortly after the last edit — the builder's own
  // "updates live as you configure" promise (docs/11 Artifacts), without a
  // network call on every keystroke.
  useEffect(() => {
    if (agent === null || graph.nodes.length === 0) return;
    setSaveState('saving');
    const handle = setTimeout(() => {
      saveAgentDraft(agentId, { name, graph: graph as unknown as Record<string, unknown> })
        .then(() => { setSaveState('saved'); })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not save your changes.'); });
    }, 700);
    return () => { clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, name]);

  const applyTemplate = useCallback((templateId: string) => {
    const built = findTemplate(templateId)?.buildGraph();
    if (built !== null && built !== undefined) setGraph(built);
  }, []);

  const updateNode = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } as AgentNode['data'] } : n)),
    }));
  }, []);

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const trigger = nodeById.get('trigger');
  const fetchNode = nodeById.get('fetch');
  const condition = nodeById.get('condition');
  const actionTrue = nodeById.get('action-true');
  const actionFalse = nodeById.get('action-false');

  const handlePublish = useCallback(() => {
    setPublishing(true);
    setError(null);
    publishAgent(agentId)
      .then(({ agent: a }) => { setAgent(a); })
      .catch((err: unknown) => {
        setError(err instanceof ApiFailure ? err.message : 'Could not publish this agent.');
      })
      .finally(() => { setPublishing(false); });
  }, [agentId]);

  const handleTestRun = useCallback(() => {
    setTesting(true);
    setTestResult(null);
    testRunAgent(agentId)
      .then(setTestResult)
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Test run failed.'); })
      .finally(() => { setTesting(false); });
  }, [agentId]);

  const handleRunNow = useCallback(() => {
    runAgentNow(agentId).catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not run this agent.'); });
  }, [agentId]);

  if (agent === null) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="px-7 py-6">{error ?? 'Loading…'}</div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1400px]">
        <div className="flex items-center gap-3 flex-wrap mb-1">
          <button type="button" className="btn btnGhost" onClick={onBack}>← Agents</button>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); }}
            className="text-[19px] font-semibold text-[var(--color-text-primary)] bg-transparent border-none outline-none"
            style={{ minWidth: 120 }}
            aria-label="Agent name"
          />
          <span className={`pill ${agent.status === 'active' ? 'live' : agent.status === 'paused' ? 'warning' : 'soon'}`}>
            {agent.status === 'active' ? 'Live' : agent.status === 'paused' ? 'Paused' : 'Draft'}
          </span>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Draft saved' : ''}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btnGhost" onClick={() => { onViewRuns(name); }}>Runs & History</button>
          <button type="button" className="btn btnOutline" onClick={handleTestRun} disabled={testing || graph.nodes.length === 0}>
            {testing ? 'Running…' : '▶ Test run (dry — sends nothing)'}
          </button>
          {agent.status === 'active' && (
            <button type="button" className="btn btnOutline" onClick={handleRunNow}>Run now</button>
          )}
          <button type="button" className="btn btnPrimary" onClick={handlePublish} disabled={publishing || graph.nodes.length === 0}>
            {publishing ? 'Publishing…' : '🚀 Publish agent'}
          </button>
        </div>

        {error !== null && <div className="notice mt-3">{error}</div>}
        {testResult !== null && (
          <div className="agentTestRun">
            <b>{testResult.matched_count}</b> record(s) match right now. {testResult.note}
          </div>
        )}

        {graph.nodes.length === 0 ? (
          <div className="card mt-5" style={{ padding: 20 }}>
            <p className="text-[13px] text-[var(--color-text-secondary)] mb-3">
              Start this agent from a template — only Absence alert is runnable today (docs/11 §2).
            </p>
            <div className="mgrid">
              {AGENT_TEMPLATES.map((t) => (
                <div
                  key={t.id}
                  className={`card mtile${t.runnable ? ' clickable' : ' mtileEmpty'}`}
                  role={t.runnable ? 'button' : undefined}
                  tabIndex={t.runnable ? 0 : undefined}
                  aria-disabled={!t.runnable}
                  onClick={() => { if (t.runnable) applyTemplate(t.id); }}
                >
                  <div className="mtileHead">
                    <span className="mtileIc" aria-hidden="true">{t.icon}</span>
                    <b>{t.title}</b>
                  </div>
                  <p className="mtileBlurb">{t.blurb}</p>
                  {!t.runnable && <p className="mtileReason"><span className="pill nodata">not built yet</span></p>}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="agentBuilderGrid mt-5">
            <div>
              <div className="card agentPanel">
                <div className="agentPanelHead"><span className="agentPanelDot" />Trigger — when does it run?</div>
                {trigger?.data.kind === 'schedule' && (
                  <div className="agentField">
                    <label>Schedule</label>
                    <input
                      type="text"
                      value={trigger.data.label}
                      onChange={(e) => { updateNode('trigger', { label: e.target.value }); }}
                    />
                    <p className="agentHint">Cron: <code>{trigger.data.cron}</code> ({trigger.data.tz})</p>
                  </div>
                )}
              </div>

              <div className="card agentPanel">
                <div className="agentPanelHead"><span className="agentPanelDot" />Data — who does it apply to?</div>
                {fetchNode?.data.kind === 'fetch_records' && (
                  <div className="agentField">
                    <label>Source</label>
                    <select value={fetchNode.data.source} disabled>
                      <option value={fetchNode.data.source}>{FETCH_SOURCES[fetchNode.data.source].label}</option>
                    </select>
                    <p className="agentHint">Runs on the read replica via the MCP server's tools — never a direct database connection (ADR-006).</p>
                  </div>
                )}
                <div className="agentField">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked disabled />
                    Skip records already messaged today (dedup)
                  </label>
                  <p className="agentHint">Always on — platform-enforced, not a per-agent option (ADR-025).</p>
                </div>
              </div>

              <div className="card agentPanel">
                <div className="agentPanelHead"><span className="agentPanelDot" />Condition — branch the flow</div>
                {condition?.data.kind === 'if_else' && (
                  <div className="agentInline">
                    <div className="agentField">
                      <label>Field</label>
                      <select value={condition.data.field} onChange={(e) => { updateNode('condition', { field: e.target.value }); }}>
                        {(fetchNode?.data.kind === 'fetch_records' ? FETCH_SOURCES[fetchNode.data.source].fields : [])
                          .filter((f) => !NON_CONDITION_FIELDS.has(f))
                          .map((f) => (
                            <option key={f} value={f}>{f}</option>
                          ))}
                      </select>
                    </div>
                    <div className="agentField">
                      <label>Is</label>
                      <select value={condition.data.op} onChange={(e) => { updateNode('condition', { op: e.target.value as typeof condition.data.op }); }}>
                        <option value=">=">{'>='}</option>
                        <option value=">">{'>'}</option>
                        <option value="==">{'=='}</option>
                      </select>
                    </div>
                    <div className="agentField">
                      <label>Value</label>
                      <input
                        type="number"
                        value={condition.data.value}
                        onChange={(e) => { updateNode('condition', { value: Number(e.target.value) }); }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {actionTrue?.data.kind === 'message' && (
                <BranchPanel
                  title="Action — ✓ TRUE branch"
                  variant="branchTrue"
                  data={actionTrue.data}
                  onChange={(patch) => { updateNode('action-true', patch); }}
                />
              )}
              {actionFalse?.data.kind === 'message' && (
                <BranchPanel
                  title="Action — ✗ FALSE branch"
                  variant="branchFalse"
                  data={actionFalse.data}
                  onChange={(patch) => { updateNode('action-false', patch); }}
                />
              )}
            </div>

            <div className="agentFlowPreview">
              <FlowPreview graph={graph} />
            </div>
          </div>
        )}

        <p className="text-[11px] text-[var(--color-muted)] mt-4">
          Signed in via the ERP · {session.user.role} · read-only data
        </p>
      </div>
    </main>
  );
}

function BranchPanel({
  title,
  variant,
  data,
  onChange,
}: {
  title: string;
  variant: 'branchTrue' | 'branchFalse';
  data: Extract<AgentNode['data'], { kind: 'message' }>;
  onChange: (patch: Partial<Extract<AgentNode['data'], { kind: 'message' }>>) => void;
}): ReactElement {
  const CHANNELS: readonly ChannelId[] = ['whatsapp', 'sms', 'email'];

  function toggleChannel(channel: ChannelId): void {
    const has = data.channels.includes(channel);
    const channels = has ? data.channels.filter((c) => c !== channel) : [...data.channels, channel];
    onChange({ channels, primary: channels[0] ?? data.primary });
  }

  return (
    <div className={`card agentPanel agentBranch ${variant}`}>
      <div className={`agentBranchLabel ${variant}`}>{title}</div>
      <div className="agentChecklist">
        {CHANNELS.map((channel) => (
          <label key={channel}>
            <input type="checkbox" checked={data.channels.includes(channel)} onChange={() => { toggleChannel(channel); }} />
            {channel === 'whatsapp' ? 'WhatsApp' : channel === 'sms' ? 'SMS' : 'Email'}
            {data.primary === channel && <span className="pill info" style={{ marginLeft: 4 }}>primary</span>}
          </label>
        ))}
      </div>
      <div className="agentField">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={data.also_notify_staff}
            onChange={(e) => { onChange({ also_notify_staff: e.target.checked }); }}
          />
          Also notify class teacher
        </label>
      </div>
      <div className="agentField">
        <label>Message</label>
        <textarea
          value={data.template_preview}
          onChange={(e) => { onChange({ template_preview: e.target.value }); }}
        />
        <p className="agentHint">
          Variables: {'{{student.name}}'} · {'{{student.class}}'} · {'{{parent.phone}}'} · {'{{days}}'} ·{' '}
          {'{{fee.balance_amount}}'} · {'{{fee.days_overdue}}'} — availability depends on this agent's data source.
        </p>
        <p className="agentHint warn">
          Sends on approved templates only (ADR-024) — editing this text here changes the preview; the
          approved template library that gates real sending is a follow-up (docs/11 §2).
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flow preview (@xyflow/react, read-only)
// ---------------------------------------------------------------------------

function FlowPreview({ graph }: { graph: AgentGraph }): ReactElement {
  const nodes: Node[] = useMemo(() => graph.nodes.map(toFlowNode), [graph.nodes]);
  const edges: Edge[] = useMemo(() => graph.edges.map(toFlowEdge), [graph.edges]);

  return (
    <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
      <Background gap={16} />
    </ReactFlow>
  );
}

function toFlowNode(node: AgentNode): Node {
  const { title, subtitle, kindClass } = describeNode(node);
  return {
    id: node.id,
    position: node.position,
    data: {
      label: (
        <div className={`flowNode ${kindClass}`}>
          <b>{title}</b>
          {subtitle !== null && <span>{subtitle}</span>}
        </div>
      ),
    },
    draggable: false,
  };
}

function describeNode(node: AgentNode): { title: string; subtitle: string | null; kindClass: string } {
  const d = node.data;
  switch (d.kind) {
    case 'schedule':
      return { title: `⏰ ${d.label}`, subtitle: null, kindClass: 'trigger' };
    case 'manual':
      return { title: '▶️ Manual trigger', subtitle: null, kindClass: 'trigger' };
    case 'fetch_records':
      return { title: '🔍 Fetch records', subtitle: d.source, kindClass: '' };
    case 'dedup_guard':
      return { title: '🔁 Skip if already notified', subtitle: null, kindClass: '' };
    case 'if_else':
      return { title: `◇ ${d.field} ${d.op} ${String(d.value)} ?`, subtitle: null, kindClass: 'condition' };
    case 'wait':
      return { title: '⏳ Wait', subtitle: d.mode, kindClass: '' };
    case 'message': {
      const isTrue = node.id === 'action-true';
      return {
        title: `${d.channels.includes('whatsapp') ? '📱' : '💬'} Send message`,
        subtitle: d.channels.join(' + '),
        kindClass: isTrue ? 'action-true' : 'action-false',
      };
    }
    case 'notify_staff':
      return { title: '👤 Notify staff', subtitle: d.role, kindClass: '' };
    case 'erp_notify':
      return { title: '🔔 ERP notification', subtitle: null, kindClass: '' };
    case 'log':
      return { title: '📝 Log', subtitle: null, kindClass: '' };
    case 'end':
    case 'escalate_end':
      return { title: '● End', subtitle: null, kindClass: 'end' };
    default:
      return { title: d.kind, subtitle: null, kindClass: '' };
  }
}

function toFlowEdge(edge: AgentEdge): Edge {
  const color = edge.branch === 'true' ? '#3d7a2f' : edge.branch === 'false' ? '#a8375a' : '#94a3b8';
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.branch === 'true' ? '✓ TRUE' : edge.branch === 'false' ? '✗ FALSE' : undefined,
    style: { stroke: color },
    labelStyle: { fill: color, fontWeight: 700, fontSize: 10 },
  };
}
