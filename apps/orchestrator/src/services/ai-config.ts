/**
 * The AI gating state machine and who is allowed to move it.
 *
 * Contract source: ADR-017 · ADR-031 (multi-provider) · docs/05 §4.2 ·
 * Invariant 5 ("BYOK gating … `ai_status != active` → all `/api/ai/*`
 * endpoints return 403; UI locks are cosmetic on top of that server-side
 * check").
 *
 *     not_configured ──save key──► pending_validation ──test ok──► active
 *           ▲                                              │
 *           └──────────── admin disables ◄─────────────────┤
 *                                                          ▼ invalid key /
 *                                error ◄──────── credit exhausted / revoked
 *
 * -- Configuration is ADMIN-only, and that is enforced HERE ---------------------
 * docs/05 §5 makes BYOK setup "admin-only, org-level"; the role that means is
 * `ADMIN` (decided 2026-08-20 — see docs/05 §5). A Director runs the trust and a
 * Principal runs a school, but the key is a billable credential for the whole
 * org, and "who may spend the org's money with a provider" is a narrower
 * question than "who may read the org's numbers".
 *
 * The check lives in this service rather than in the route because it is an
 * authorisation rule, not a transport concern: every future caller of
 * `saveApiKey` inherits it, and a new route cannot forget to ask. The SPA hides
 * the form for non-admins, but that is cosmetic on top of this — exactly the
 * relationship Invariant 5 describes for the AI lock itself.
 *
 * -- One provider at a time (ADR-031) --------------------------------------
 * `PRIMARY KEY (org_id)` on `tenant_ai_config` is unchanged: an admin picks
 * Anthropic OR Gemini, not both at once. Switching providers overwrites this
 * row exactly like "Replace Key" already does for a same-provider swap.
 */

import type { RowDataPacket } from 'mysql2';
import { ERROR_CODES, PlatformError, type Role } from '@sap/shared';
import { platformDb } from '../db/platform-db.js';
import { auditSink } from '../db/audit.js';
import { PROVIDERS, DEFAULT_PROVIDER, type AiProviderId } from './ai-providers/index.js';
import { decryptApiKey, encryptApiKey } from './key-vault.js';

export type AiStatus = 'not_configured' | 'pending_validation' | 'active' | 'error';

export interface AiConfig {
  readonly ai_status: AiStatus;
  readonly provider: AiProviderId;
  readonly model: string;
  readonly billing_mode: 'byok' | 'platform';
  readonly monthly_query_cap: number;
  /** e.g. `sk-ant-…1G4a`, or null when no key is installed. Never the key itself. */
  readonly key_hint: string | null;
  readonly last_validated_at: string | null;
  readonly last_error: string | null;
}

/**
 * The roles that may configure AI. One entry today, and a named constant rather
 * than an inline comparison so the answer to "who can do this?" is greppable and
 * changing it is one edit rather than a search for `=== 'ADMIN'`.
 */
const CONFIG_ROLES: readonly Role[] = ['ADMIN'];

export function canConfigureAi(role: Role): boolean {
  return CONFIG_ROLES.includes(role);
}

/** The message a non-admin is shown, in one place so screen and API agree. */
export const CONTACT_ADMIN =
  'Contact your admin for key configuration.';

function requireConfigRole(role: Role): void {
  if (canConfigureAi(role)) return;
  throw new PlatformError({
    code: ERROR_CODES.PERMISSION_DENIED,
    message: CONTACT_ADMIN,
    details: { required_role: 'ADMIN' },
  });
}

const NOT_CONFIGURED: AiConfig = {
  ai_status: 'not_configured',
  provider: DEFAULT_PROVIDER,
  model: PROVIDERS[DEFAULT_PROVIDER].defaultModel,
  billing_mode: 'byok',
  monthly_query_cap: 1500,
  key_hint: null,
  last_validated_at: null,
  last_error: null,
};

/**
 * An org with no row is `not_configured`, not an error.
 *
 * The row is created on first save. Treating "no row" as a state rather than a
 * missing precondition is what lets a brand-new org open Settings and see a
 * wizard instead of a failure.
 */
export async function readAiConfig(orgId: string): Promise<AiConfig> {
  const [rows] = await platformDb.query<RowDataPacket[]>(
    `SELECT ai_status, provider, model, billing_mode, monthly_query_cap, key_hint,
            last_validated_at, last_error
       FROM tenant_ai_config WHERE org_id = ?`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) return NOT_CONFIGURED;

  return {
    ai_status: String(row['ai_status']) as AiStatus,
    provider: String(row['provider']) as AiProviderId,
    model: String(row['model']),
    billing_mode: row['billing_mode'] === 'platform' ? 'platform' : 'byok',
    monthly_query_cap: Number(row['monthly_query_cap'] ?? 0),
    key_hint: row['key_hint'] === null ? null : String(row['key_hint']),
    last_validated_at:
      row['last_validated_at'] instanceof Date
        ? row['last_validated_at'].toISOString()
        : row['last_validated_at'] === null
          ? null
          : String(row['last_validated_at']),
    last_error: row['last_error'] === null ? null : String(row['last_error']),
  };
}

/**
 * The status the rest of the product gates on.
 *
 * Its own function because it is called on the session route for every user of
 * the org, where the rest of the config is neither needed nor appropriate to
 * hand out — a Teacher's session response has no business carrying the key hint
 * or the billing mode.
 */
export async function readAiStatus(orgId: string): Promise<AiStatus> {
  return (await readAiConfig(orgId)).ai_status;
}

/**
 * The decrypted key, for the one caller that is allowed to hold it: the
 * Ask-AI chat loop making the actual provider call (services/ai-chat.ts).
 *
 * Deliberately separate from `readAiConfig`, which never touches the
 * ciphertext (docs/08 §6: "platform operators cannot read tenant keys in
 * plaintext" — a function that could return one is a function that should not
 * exist on any path a human-facing endpoint calls). `null` covers every
 * reason a call cannot proceed — no row, no key, or `ai_status` not `active`
 * — as one state, since the caller's only correct response to any of them is
 * the same `AI_NOT_ACTIVE` refusal (Invariant 5).
 */
export async function getDecryptedApiKeyForOrg(
  orgId: string,
): Promise<{ apiKey: string; model: string; provider: AiProviderId } | null> {
  const [rows] = await platformDb.query<RowDataPacket[]>(
    'SELECT encrypted_api_key, model, provider, ai_status FROM tenant_ai_config WHERE org_id = ?',
    [orgId],
  );
  const row = rows[0];
  if (row === undefined || row['ai_status'] !== 'active' || row['encrypted_api_key'] === null) {
    return null;
  }
  return {
    apiKey: decryptApiKey(row['encrypted_api_key'] as Buffer),
    model: String(row['model']),
    provider: String(row['provider']) as AiProviderId,
  };
}

export interface SaveResult {
  readonly config: AiConfig;
  /** Present when validation failed: what to tell the admin. */
  readonly error: string | null;
}

/**
 * Save a key: validate live, then store — in that order.
 *
 * The order matters. Storing first and validating after would leave a rejected
 * key sitting in the vault, and the next code path to read it (a background job,
 * a retry, a future feature) would use it. A key that never passed a test never
 * enters the vault.
 *
 * `pending_validation` is therefore not persisted on the happy path — it is the
 * state this call is IN, and it exists in docs/05's diagram to describe the
 * moment, not to be a durable row. It is written only when validation fails
 * transiently, where the distinction between "we could not check" and "the key
 * is bad" is a real one for the admin reading the banner.
 */
export async function saveApiKey(args: {
  orgId: string;
  actorSub: string;
  role: Role;
  provider: AiProviderId;
  apiKey: string;
  model: string;
  monthlyQueryCap: number;
  correlationId: string;
}): Promise<SaveResult> {
  requireConfigRole(args.role);

  const provider = PROVIDERS[args.provider];

  if (!provider.looksLikeValidKey(args.apiKey)) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `That does not look like a ${provider.label} API key.`,
      correlationId: args.correlationId,
    });
  }
  if (!provider.isValidModelId(args.model)) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Choose one of the offered models.',
      details: { allowed: provider.models.map((m) => m.id).join(', ') },
      correlationId: args.correlationId,
    });
  }
  if (!Number.isInteger(args.monthlyQueryCap) || args.monthlyQueryCap < 1) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'The monthly cap must be a whole number of queries.',
      correlationId: args.correlationId,
    });
  }

  const outcome = await provider.validateApiKey({ apiKey: args.apiKey, model: args.model });

  if (!outcome.ok) {
    /**
     * A failed test does not touch the stored key. An org that already had a
     * working key keeps it — pasting a typo should not disable AI for every
     * school in the trust — and an org that had none stays unconfigured. Only
     * the visible error changes.
     */
    await recordFailure({
      orgId: args.orgId,
      actorSub: args.actorSub,
      provider: args.provider,
      model: args.model,
      monthlyQueryCap: args.monthlyQueryCap,
      message: outcome.message,
      transient: outcome.transient,
    });
    await auditSink.write({
      kind: 'config.changed',
      at: new Date().toISOString(),
      actor_sub: args.actorSub,
      org_id: args.orgId,
      correlation_id: args.correlationId,
      subject: 'ai_key',
      action: 'validate_failed',
      // [MANDATORY] §13: the reason, never the key.
      summary: `Key validation failed against ${provider.label} ${args.model}`,
    });
    return { config: await readAiConfig(args.orgId), error: outcome.message };
  }

  await platformDb.query(
    `INSERT INTO tenant_ai_config
       (org_id, provider, encrypted_api_key, key_hint, model, billing_mode, monthly_query_cap,
        ai_status, last_validated_at, last_error, updated_by)
     VALUES (?, ?, ?, ?, ?, 'byok', ?, 'active', CURRENT_TIMESTAMP, NULL, ?)
     ON DUPLICATE KEY UPDATE
       provider          = VALUES(provider),
       encrypted_api_key = VALUES(encrypted_api_key),
       key_hint          = VALUES(key_hint),
       model             = VALUES(model),
       monthly_query_cap = VALUES(monthly_query_cap),
       ai_status         = 'active',
       last_validated_at = CURRENT_TIMESTAMP,
       last_error        = NULL,
       updated_by        = VALUES(updated_by)`,
    [
      args.orgId,
      args.provider,
      encryptApiKey(args.apiKey),
      provider.keyHint(args.apiKey),
      args.model,
      args.monthlyQueryCap,
      args.actorSub,
    ],
  );

  await auditSink.write({
    kind: 'config.changed',
    at: new Date().toISOString(),
    actor_sub: args.actorSub,
    org_id: args.orgId,
    correlation_id: args.correlationId,
    subject: 'ai_key',
    action: 'saved',
    summary: `AI activated on ${provider.label} ${args.model}, cap ${String(args.monthlyQueryCap)} queries/month`,
  });

  return { config: await readAiConfig(args.orgId), error: null };
}

async function recordFailure(args: {
  orgId: string;
  actorSub: string;
  provider: AiProviderId;
  model: string;
  monthlyQueryCap: number;
  message: string;
  transient: boolean;
}): Promise<void> {
  const [rows] = await platformDb.query<RowDataPacket[]>(
    'SELECT ai_status FROM tenant_ai_config WHERE org_id = ?',
    [args.orgId],
  );
  const existing = rows[0] === undefined ? null : String(rows[0]['ai_status']);

  /**
   * An org that is live stays live through a failed *save attempt*: their
   * working key is untouched, so relocking every school because an admin
   * mistyped a replacement would be the platform inventing an outage. `error` is
   * for a key that WAS ours and stopped working (docs/05 §4.2's revoked /
   * credit-exhausted path), not for a rejected new one.
   */
  const status: AiStatus =
    existing === 'active' ? 'active' : args.transient ? 'pending_validation' : 'error';

  /**
   * `provider` is written even on this failure path — it is the first-ever
   * save attempt's only chance to record which provider was chosen, since a
   * failed attempt with no prior row leaves nothing else to correct it later
   * (ADR-031).
   */
  await platformDb.query(
    `INSERT INTO tenant_ai_config
       (org_id, provider, model, monthly_query_cap, ai_status, last_error, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       provider          = VALUES(provider),
       model             = VALUES(model),
       monthly_query_cap = VALUES(monthly_query_cap),
       ai_status         = VALUES(ai_status),
       last_error        = VALUES(last_error),
       updated_by        = VALUES(updated_by)`,
    [args.orgId, args.provider, args.model, args.monthlyQueryCap, status, args.message.slice(0, 255), args.actorSub],
  );
}

/**
 * Disable AI for the org, and drop the key while doing it.
 *
 * Keeping the ciphertext "in case they come back" would mean a disabled org is
 * still storing a live billable credential it believes it has withdrawn. The
 * admin re-pastes on re-enable; that is a ten-second cost against holding
 * someone else's secret with no mandate to.
 *
 * `provider` is left untouched — it is informational once no key is stored,
 * and re-selecting a provider from a blank slate on re-enable is a worse
 * experience than remembering which one the org was using.
 */
export async function disableAi(args: {
  orgId: string;
  actorSub: string;
  role: Role;
  correlationId: string;
}): Promise<AiConfig> {
  requireConfigRole(args.role);

  await platformDb.query(
    `UPDATE tenant_ai_config
        SET encrypted_api_key = NULL,
            key_hint          = NULL,
            ai_status         = 'not_configured',
            last_error        = NULL,
            updated_by        = ?
      WHERE org_id = ?`,
    [args.actorSub, args.orgId],
  );

  await auditSink.write({
    kind: 'config.changed',
    at: new Date().toISOString(),
    actor_sub: args.actorSub,
    org_id: args.orgId,
    correlation_id: args.correlationId,
    subject: 'ai_status',
    action: 'disabled',
    summary: 'AI disabled for the org; stored key removed',
  });

  return readAiConfig(args.orgId);
}
