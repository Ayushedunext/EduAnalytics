/**
 * POST /api/ai/ask — Ask AI (ADR-030, docs/05).
 *
 * Gated on `ai_status === 'active'` (Invariant 5) — checked here, on every
 * request, independent of what the UI shows; the three locked entry points in
 * the SPA are cosmetic on top of this.
 *
 * Streams newline-delimited JSON status/result/error events over a chunked
 * response. Not WebSocket, despite docs/05 §2's original wording — no WS/SSE
 * infrastructure exists anywhere in this codebase, and `EventSource` cannot
 * carry a POST body, so a plain chunked response avoids a new dependency
 * entirely (docs/05 §2 has been corrected to describe this).
 *
 * A GET would be side-effect-free by contract (ADR-029 clause 3) and CSRF-
 * exempt; this is a POST because it spends the org's own AI budget, which is
 * exactly the kind of request CSRF exists to protect regardless of what it
 * writes to our own database.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { resolveRequestedSchools } from '../middleware/scope.js';
import { readAiStatus } from '../services/ai-config.js';
import { runAskAi, type AskAiEvent } from '../services/ai-chat.js';

export const aiRouter = Router();

const MAX_QUESTION_LENGTH = 2000;

aiRouter.post('/api/ai/ask', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = req.session;
    if (session === undefined) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
        correlationId: req.correlationId,
      });
    }

    /** Invariant 5: re-checked here regardless of the client's own belief about it. */
    const status = await readAiStatus(session.org_id);
    if (status !== 'active') {
      throw new PlatformError({
        code: ERROR_CODES.AI_NOT_ACTIVE,
        message: 'AI reports are not set up for this organization.',
        correlationId: req.correlationId,
      });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = typeof body['question'] === 'string' ? body['question'].trim() : '';
    if (question === '' || question.length > MAX_QUESTION_LENGTH) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Ask a question of up to ${String(MAX_QUESTION_LENGTH)} characters.`,
        correlationId: req.correlationId,
      });
    }

    const schoolIds = await resolveRequestedSchools(req);

    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
    });

    const send = (event: AskAiEvent): void => {
      res.write(JSON.stringify(event) + '\n');
    };

    try {
      await runAskAi({
        session,
        schoolIds,
        question,
        correlationId: req.correlationId,
        onEvent: send,
      });
    } catch (err) {
      /**
       * A failure reaching this point already has a real chunked response in
       * flight, so it cannot become an HTTP status the way `errorHandler`
       * gives every other route — the event stream IS this route's error
       * channel, and it must end with one even when nothing else went right.
       */
      const platformError =
        err instanceof PlatformError
          ? err
          : new PlatformError({
              code: ERROR_CODES.INTERNAL,
              message: 'Ask AI could not answer that question.',
              diagnostics: { reason: err instanceof Error ? err.message : String(err) },
              correlationId: req.correlationId,
            });
      send({ type: 'error', code: platformError.code, message: platformError.message });
    } finally {
      res.end();
    }
  })().catch(next);
});
