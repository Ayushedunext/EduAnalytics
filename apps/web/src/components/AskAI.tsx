/**
 * Ask AI — chat + artifact canvas (ADR-030, docs/05).
 *
 * Every widget here is drawn by the same shared renderer every predefined
 * report uses (`@sap/chart-spec/react`'s `ChartSpecView`) — one visual
 * language across predefined, custom and AI reports (ADR-015), and it
 * schema-validates before drawing, so an invalid or model-tampered spec never
 * reaches the screen as a partial render.
 *
 * Single-turn per question for this slice: each question is answered
 * independently and appended to the transcript below. There is no persisted
 * conversational memory between turns yet — docs/05 §2's "Refine" follow-up
 * threading, and "Ask AI about this data/slice" carrying dashboard context
 * into the conversation, are later work.
 */

import { useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import {
  askAI,
  saveAiReportAsCustom,
  ApiFailure,
  type AskAiDraft,
  type AskAiQuery,
  type AskAiSpec,
  type SessionResponse,
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
}

interface Props {
  session: SessionResponse;
  schoolIds: readonly string[];
  seedQuestion?: string;
  onBack: () => void;
  onSaved: (id: string) => void;
}

export function AskAI({ session, schoolIds, seedQuestion, onBack, onSaved }: Props): JSX.Element {
  const [input, setInput] = useState(seedQuestion ?? '');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = (raw: string): void => {
    const question = raw.trim();
    if (question === '' || busy) return;

    const id = `${String(Date.now())}-${String(Math.random())}`;
    setTurns((prev) => [
      ...prev,
      { id, question, steps: [], spec: null, queries: [], draft: null, error: null, done: false },
    ]);
    setInput('');
    setBusy(true);

    const update = (patch: Partial<Turn>): void => {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    };

    askAI(question, schoolIds, (event) => {
      if (event.type === 'status') {
        setTurns((prev) =>
          prev.map((t) => (t.id === id ? { ...t, steps: [...t.steps, event.step] } : t)),
        );
      } else if (event.type === 'result') {
        update({ spec: event.spec, queries: event.queries, draft: event.draft, done: true });
      } else {
        update({ error: event.message, done: true });
      }
    })
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

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1180px]">
        <button type="button" className="backLink" onClick={onBack}>
          ← Home
        </button>

        <h1 className="page-title mt-3">Ask AI</h1>
        <div className="page-sub">
          {session.scope.map((s) => s.school_name).join(' · ')} · answers are built from live
          queries against your schools, not from what the model already knows
        </div>

        {turns.length === 0 && !busy && (
          <div className="mt-8 text-[13px] text-[var(--color-muted)]">
            Ask anything about your schools — e.g. “school-wise strength, gender-wise” or
            “which classes have the most fee defaulters?”.
          </div>
        )}

        <div className="mt-6 flex flex-col gap-6">
          {turns.map((turn) => (
            <div key={turn.id} className="card p-4">
              <div className="font-medium text-[14px] mb-2">{turn.question}</div>

              {!turn.done && (
                <ul className="text-[12px] text-[var(--color-muted)] list-none p-0 m-0 flex flex-col gap-1">
                  {turn.steps.length === 0 && <li>Confirming scope…</li>}
                  {turn.steps.map((step, i) => (
                    <li key={i}>{step}…</li>
                  ))}
                </ul>
              )}

              {turn.error !== null && <div className="notice mt-2">{turn.error}</div>}

              {/* The spec goes in unvalidated on purpose: ChartSpecView validates it
                  against the schema before drawing (ADR-015, CODING_GUIDELINES §10). */}
              {turn.spec !== null && <ChartSpecView spec={turn.spec} />}

              {turn.done && turn.spec !== null && turn.draft !== null && (
                <SaveAsReport turn={turn} schoolIds={schoolIds} onSaved={onSaved} />
              )}
            </div>
          ))}
        </div>

        <form
          className="mt-6 flex gap-2 sticky bottom-0 bg-[var(--color-canvas)] py-3"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <input
            className="flex-1 border rounded-md px-3 py-2 text-[13px]"
            placeholder="Ask anything about your schools…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
            }}
            disabled={busy}
          />
          <button type="submit" className="chipbtn" disabled={busy || input.trim() === ''}>
            {busy ? 'Asking…' : 'Ask'}
          </button>
        </form>
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
    <div className="mt-2 flex items-center gap-2">
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
    </div>
  );
}
