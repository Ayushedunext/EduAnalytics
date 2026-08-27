/**
 * Ask AI — chat + artifact canvas (ADR-030, docs/05, docs/10 §3).
 *
 * Split layout: a narrow chat rail (streaming status steps, suggestion
 * chips) on the left, a wide artifact canvas on the right. Every widget in
 * the canvas is drawn by the same shared renderer every predefined report
 * uses (`@sap/chart-spec/react`'s `ChartSpecView`) — one visual language
 * across predefined, custom and AI reports (ADR-015), and it schema-validates
 * before drawing, so an invalid or model-tampered spec never reaches the
 * screen as a partial render.
 *
 * Single-turn per question: each question is answered independently and
 * appended to the transcript — there is no persisted conversational memory
 * between turns. "✎ Refine" (below) is not that memory; it is a one-shot
 * seed of the CURRENTLY SELECTED turn's own definition into the next
 * question, the same mechanism the saved-report "Refine with AI" side panel
 * (`AskAiPanel.tsx`) already uses via `report_id` — here there is no id yet,
 * so the seed is the turn's own `spec`/`queries`, echoed straight back to
 * the server (`routes/ai.ts`'s inline `seed`). Clicking an earlier question
 * in the chat re-shows that turn's own answer in the canvas; it does not
 * re-run it.
 *
 * docs/10 §3 lists five actions on every AI artifact: ⬇ PDF · 💾 Save · 🧠
 * Logic · ⧉ Clone · ✎ Refine. Only Save, Logic and Refine appear here, on
 * purpose: PDF export and Clone are both, everywhere else in this codebase,
 * operations on a PERSISTED report id (`GET /api/reports/:id/export.pdf`,
 * `POST /api/reports/clone` — ADR-021 "the PDF renderer reads the identical
 * spec" as a saved definition, not an ad-hoc draft). An unsaved Ask AI turn
 * has no id. Inventing an id-less PDF/clone path would be a second, parallel
 * mechanism for something one click of 💾 Save already does today — Save
 * hands you straight into the Report Editor, which already has PDF, Clone,
 * Edit and Versions. So here, Save is how you reach those two, not a sixth
 * button that duplicates it.
 *
 * The sidebar already keeps this route unreachable while AI isn't active
 * (Sidebar.tsx's `muted` nav item), but the locked card below is the same
 * "locked, never hidden" affordance docs/10 §3 asks every AI surface to show
 * on its own — reachable directly (a stale tab, a bookmark) without depending
 * on the sidebar having done its job first.
 */

import { useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import {
  askAI,
  saveAiReportAsCustom,
  ApiFailure,
  type AskAiDraft,
  type AskAiInlineSeed,
  type AskAiQuery,
  type AskAiSpec,
  type ReportLogic,
  type SessionResponse,
} from '../api/client';
import { LogicPanel } from './LogicPanel';

interface Turn {
  readonly id: string;
  readonly question: string;
  readonly steps: readonly string[];
  readonly spec: AskAiSpec | null;
  readonly queries: readonly AskAiQuery[];
  readonly draft: AskAiDraft | null;
  readonly logic: ReportLogic | null;
  readonly error: string | null;
  readonly done: boolean;
}

interface Props {
  session: SessionResponse;
  schoolIds: readonly string[];
  seedQuestion?: string;
  onBack: () => void;
  onSaved: (id: string) => void;
  onSettings: () => void;
}

const SUGGESTIONS = [
  { label: 'Gender-wise strength', question: 'Show gender-wise student strength for all my schools' },
  { label: 'Fee defaulters', question: 'Show fee defaulters across my schools' },
  { label: 'Attendance compare', question: 'Compare attendance across schools' },
];

export function AskAI({ session, schoolIds, seedQuestion, onBack, onSaved, onSettings }: Props): JSX.Element {
  const [input, setInput] = useState(seedQuestion ?? '');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refiningId, setRefiningId] = useState<string | null>(null);
  const [showLogic, setShowLogic] = useState(false);
  const [busy, setBusy] = useState(false);

  const scopeLabel = session.scope.map((s) => s.school_name).join(' · ');

  const ask = (raw: string, seed?: AskAiInlineSeed): void => {
    const question = raw.trim();
    if (question === '' || busy) return;

    const id = `${String(Date.now())}-${String(Math.random())}`;
    setTurns((prev) => [
      ...prev,
      { id, question, steps: [], spec: null, queries: [], draft: null, logic: null, error: null, done: false },
    ]);
    setSelectedId(id);
    setInput('');
    setBusy(true);

    const update = (patch: Partial<Turn>): void => {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    };

    askAI(
      question,
      schoolIds,
      (event) => {
        if (event.type === 'status') {
          setTurns((prev) =>
            prev.map((t) => (t.id === id ? { ...t, steps: [...t.steps, event.step] } : t)),
          );
        } else if (event.type === 'result') {
          update({ spec: event.spec, queries: event.queries, draft: event.draft, logic: event.logic, done: true });
        } else {
          update({ error: event.message, done: true });
        }
      },
      undefined,
      seed,
    )
      .catch((err: unknown) => {
        // Fail loud (§10): a silently empty turn would read as "no answer".
        update({
          error: err instanceof ApiFailure ? err.message : 'Ask AI could not answer that.',
          done: true,
        });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const refiningTurn = refiningId !== null ? (turns.find((t) => t.id === refiningId) ?? null) : null;
  const refiningSpec = refiningTurn?.spec ?? null;

  if (session.ai_status !== 'active') {
    return (
      <main className="flex-1 overflow-y-auto px-7 py-6">
        <button type="button" className="backLink" onClick={onBack}>
          ← Home
        </button>
        <div className="card lockedCard mt-4">
          <div className="icon">🔒</div>
          <h2>AI reports are locked</h2>
          {/* Two sentences for two people (docs/10 §2) — a Teacher sent to
              Settings for a permission they don't have reads as a dead end. */}
          <p>
            {session.can_configure_ai
              ? 'Connect your organization’s Anthropic key in Settings to unlock natural-language reports for every school and user.'
              : 'Ask your administrator to complete AI setup — they can connect the organization’s Anthropic key in Settings.'}
          </p>
          <div className="okLine">✓ Predefined dashboards are already available — no setup needed</div>
          {session.can_configure_ai && (
            <button type="button" className="btn btnPrimary" onClick={onSettings}>
              Go to AI Setup →
            </button>
          )}
        </div>
      </main>
    );
  }

  const selected = turns.find((t) => t.id === selectedId) ?? null;

  return (
    <main className="flex-1 flex flex-col min-h-0 px-7 py-6">
      <button type="button" className="backLink" onClick={onBack}>
        ← Home
      </button>
      <h1 className="page-title mt-3">Ask AI</h1>
      <div className="page-sub">
        {scopeLabel} · answers are built from live queries against your schools, not from what the
        model already knows
      </div>

      <div className="askSplit">
        <section className="card askChat">
          <div className="askChatMsgs">
            <div className="askBubble askBubble--ai">
              Hi {session.user.name}! Ask me anything about <b>{scopeLabel}</b> — strength, fees,
              attendance, exams. I can only see the schools you&rsquo;ve selected.
            </div>

            {turns.map((turn) => (
              <div key={turn.id} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  className={`askBubble askBubble--user ${turn.id === selectedId ? 'is-selected' : ''}`}
                  onClick={() => { setSelectedId(turn.id); }}
                >
                  {turn.question}
                </button>

                {!turn.done && (
                  <ul className="askStatusList">
                    {turn.steps.length === 0 && <li className="askStatusLine">⋯ Confirming scope</li>}
                    {turn.steps.map((step, i) => (
                      <li key={i} className="askStatusLine">⋯ {step}</li>
                    ))}
                  </ul>
                )}

                {turn.done && turn.spec !== null && (
                  <div className="askBubble askBubble--ai">
                    <b>{turn.spec.title}</b> is ready — see it on the right →
                  </div>
                )}

                {turn.error !== null && <div className="notice">{turn.error}</div>}
              </div>
            ))}
          </div>

          <div className="askChips">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                className="chipbtn"
                disabled={busy}
                onClick={() => { ask(s.question); }}
              >
                {s.label}
              </button>
            ))}
          </div>

          {refiningTurn !== null && refiningSpec !== null && (
            <div className="askRefineChip">
              <span>
                ✎ Refining <b>{refiningSpec.title}</b>
              </span>
              <button type="button" onClick={() => { setRefiningId(null); }} aria-label="Cancel refining">
                ✕
              </button>
            </div>
          )}

          <form
            className="askChatForm"
            onSubmit={(e) => {
              e.preventDefault();
              const seed =
                refiningTurn !== null && refiningSpec !== null
                  ? { reportName: refiningSpec.title, queries: refiningTurn.queries, widgets: refiningSpec.widgets }
                  : undefined;
              ask(input, seed);
              setRefiningId(null);
            }}
          >
            <input
              className="askChatInput"
              placeholder={refiningTurn !== null ? 'Describe the change you want…' : 'Type a question…'}
              value={input}
              onChange={(e) => { setInput(e.target.value); }}
              disabled={busy}
            />
            <button type="submit" className="chipbtn chipbtn--ai" disabled={busy || input.trim() === ''}>
              {busy ? '…' : 'Send'}
            </button>
          </form>
        </section>

        <section className="card askCanvas">
          {selected === null ? (
            <div className="askCanvasEmpty">
              <div className="icon">📈</div>
              <b>Your report appears here</b>
              <div className="msg">
                Ask a question or tap a suggestion — charts, tables and a narrative stream in live.
              </div>
            </div>
          ) : selected.spec !== null ? (
            <>
              <div className="askArtifactTitle">{selected.spec.title}</div>
              <div className="askArtifactSub">
                {selected.spec.meta.scope.map((s) => s.school_name).join(' · ')} · answered from{' '}
                {selected.spec.meta.served_from}
              </div>
              {/* The spec goes in unvalidated on purpose: ChartSpecView validates it
                  against the schema before drawing (ADR-015, CODING_GUIDELINES §10). */}
              <ChartSpecView spec={selected.spec} />

              <div className="askArtifactActions">
                {selected.draft !== null && (
                  <SaveAsReport turn={selected} schoolIds={schoolIds} onSaved={onSaved} />
                )}
                {selected.logic !== null && (
                  <button
                    type="button"
                    className="chipbtn"
                    onClick={() => { setShowLogic((v) => !v); }}
                  >
                    🧠 {showLogic ? 'Hide logic' : 'Logic'}
                  </button>
                )}
                <button
                  type="button"
                  className="chipbtn"
                  disabled={busy}
                  onClick={() => { setRefiningId(selected.id); }}
                >
                  ✎ Refine
                </button>
              </div>

              {showLogic && selected.logic !== null && (
                <LogicPanel report={{ logic: selected.logic, spec: { meta: { served_from: selected.spec.meta.served_from } } }} />
              )}
            </>
          ) : selected.error !== null ? (
            <div className="notice">{selected.error}</div>
          ) : (
            <div className="askCanvasEmpty">
              <div className="icon">🤖</div>
              <b>Building your report…</b>
              <div className="msg">
                {selected.steps.length > 0
                  ? selected.steps[selected.steps.length - 1]
                  : 'Confirming scope'}
                …
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

/**
 * "Save as report" — makes an Ask AI answer a permanent, re-runnable report
 * (ADR-018). Re-run always re-executes this exact statement (AUDIT_REPORT
 * C17), so saving here does not spend a token again, today or later.
 */
function SaveAsReport({
  turn,
  schoolIds,
  onSaved,
}: {
  turn: Turn;
  schoolIds: readonly string[];
  onSaved: (id: string) => void;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        className="chipbtn"
        disabled={saving}
        onClick={() => {
          if (turn.draft === null) return;
          const name = window.prompt('Name this report', turn.spec?.title ?? turn.question);
          if (name === null || name.trim() === '') return;
          setSaving(true);
          setError(null);
          saveAiReportAsCustom({ name: name.trim(), school_ids: schoolIds, queries: [...turn.queries], draft: turn.draft })
            .then((saved) => { onSaved(saved.id); })
            .catch((err: unknown) => {
              setError(err instanceof ApiFailure ? err.message : 'Could not save this report.');
            })
            .finally(() => { setSaving(false); });
        }}
      >
        {saving ? 'Saving…' : '💾 Save as report'}
      </button>
      {error !== null && <span className="notice">{error}</span>}
    </>
  );
}
