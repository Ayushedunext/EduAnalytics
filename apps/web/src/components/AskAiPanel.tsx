/**
 * "✎ Refine with AI" — a side panel opened from one chart on a custom
 * report (docs/06 §1, ADR-033's explicitly-deferred action, built here).
 *
 * Reuses the exact Ask AI engine `AskAI.tsx` already drives
 * (`askAI()` → `POST /api/ai/ask`, streaming status/result/error events) —
 * the only difference is `reportId`, which seeds the turn with this
 * report's current definition (`services/ai-chat.ts`'s `seedContext`)
 * instead of starting blank. Each turn is independent (no persisted
 * conversational memory between turns yet, same limitation `AskAI.tsx`
 * already documents) but always re-seeded from the SAME original report, so
 * asking two different follow-up questions never compounds on each other's
 * answer by accident.
 *
 * A turn's answer is a PROPOSAL until "Apply as a new version" is clicked —
 * nothing here writes to the report until the user explicitly says so,
 * mirroring the "Save as a new version" pattern the Visual/SQL editors
 * already use (ReportEditor.tsx).
 */

import { useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import {
  applyRefinement,
  askAI,
  ApiFailure,
  type AskAiDraft,
  type AskAiQuery,
  type AskAiSpec,
  type CustomReportResponse,
} from '../api/client';

interface Turn {
  readonly id: string;
  readonly question: string;
  readonly steps: readonly string[];
  readonly spec: AskAiSpec | null;
  readonly queries: readonly AskAiQuery[];
  readonly draft: AskAiDraft | null;
  readonly error: string | null;
  readonly done: boolean;
  readonly applying: boolean;
  readonly appliedVersion: number | null;
  readonly applyError: string | null;
}

interface Props {
  readonly reportId: string;
  readonly widgetTitle: string;
  readonly schoolIds: readonly string[];
  readonly onApplied: (updated: CustomReportResponse) => void;
  readonly onClose: () => void;
}

export function AskAiPanel({ reportId, widgetTitle, schoolIds, onApplied, onClose }: Props): JSX.Element {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = (raw: string): void => {
    const question = raw.trim();
    if (question === '' || busy) return;

    const id = `${String(Date.now())}-${String(Math.random())}`;
    setTurns((prev) => [
      ...prev,
      {
        id,
        question,
        steps: [],
        spec: null,
        queries: [],
        draft: null,
        error: null,
        done: false,
        applying: false,
        appliedVersion: null,
        applyError: null,
      },
    ]);
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
          setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, steps: [...t.steps, event.step] } : t)));
        } else if (event.type === 'result') {
          update({ spec: event.spec, queries: event.queries, draft: event.draft, done: true });
        } else {
          update({ error: event.message, done: true });
        }
      },
      reportId,
    )
      .catch((err: unknown) => {
        update({ error: err instanceof ApiFailure ? err.message : 'Ask AI could not answer that.', done: true });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const apply = (turn: Turn): void => {
    if (turn.draft === null) return;
    setTurns((prev) => prev.map((t) => (t.id === turn.id ? { ...t, applying: true, applyError: null } : t)));
    applyRefinement(reportId, { queries: [...turn.queries], draft: turn.draft })
      .then((updated) => {
        setTurns((prev) =>
          prev.map((t) => (t.id === turn.id ? { ...t, applying: false, appliedVersion: updated.current_version } : t)),
        );
        onApplied(updated);
      })
      .catch((err: unknown) => {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turn.id
              ? { ...t, applying: false, applyError: err instanceof ApiFailure ? err.message : 'Could not apply this change.' }
              : t,
          ),
        );
      });
  };

  return (
    <aside className="askAiPanel" role="dialog" aria-label={`Ask AI about ${widgetTitle}`}>
      <div className="askAiPanelHead">
        <div>
          <div className="askAiPanelTitle">✦ Ask AI</div>
          <div className="askAiPanelSub">about &ldquo;{widgetTitle}&rdquo;</div>
        </div>
        <button type="button" className="askAiPanelClose" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="askAiPanelBody">
        {turns.length === 0 && (
          <p className="askAiPanelHint">
            Ask a question about this chart, or ask for a change — e.g. &ldquo;why is online payment the
            largest slice?&rdquo; or &ldquo;show this as a bar chart, cash payments only&rdquo;.
          </p>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="askAiTurn">
            <div className="askAiTurnQuestion">{turn.question}</div>

            {!turn.done && (
              <ul className="askAiTurnSteps">
                {turn.steps.length === 0 && <li>Reading this chart…</li>}
                {turn.steps.map((step, i) => (
                  <li key={i}>{step}…</li>
                ))}
              </ul>
            )}

            {turn.error !== null && <div className="notice mt-2">{turn.error}</div>}

            {turn.spec !== null && (
              <div className="askAiTurnSpec">
                {turn.spec.narrative !== undefined && <p className="askAiTurnNarrative">{turn.spec.narrative}</p>}
                <ChartSpecView spec={turn.spec} />
              </div>
            )}

            {turn.done && turn.draft !== null && (
              <div className="askAiTurnActions">
                {turn.appliedVersion !== null ? (
                  <span className="askAiTurnApplied">
                    ✓ Applied as version {turn.appliedVersion} — export it with the ⬇ PDF button above.
                  </span>
                ) : (
                  <button type="button" className="chipbtn chipbtn--ai" disabled={turn.applying} onClick={() => { apply(turn); }}>
                    {turn.applying ? 'Applying…' : 'Apply as a new version'}
                  </button>
                )}
                {turn.applyError !== null && <span className="notice">{turn.applyError}</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="askAiPanelForm"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          className="askAiPanelInput"
          placeholder="Ask or request a change…"
          value={input}
          onChange={(e) => { setInput(e.target.value); }}
          disabled={busy}
        />
        <button type="submit" className="chipbtn chipbtn--ai" disabled={busy || input.trim() === ''}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>
    </aside>
  );
}
