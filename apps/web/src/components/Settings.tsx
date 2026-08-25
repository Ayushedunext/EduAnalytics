/**
 * Settings — AI configuration (org) and messaging channels (school).
 *
 * Contract source: docs/05 §5 (the 3-step wizard; admin-only, org-level) ·
 * docs/10 §2 rows 47–48 · ADR-017 · ADR-024. The layout follows the UX
 * prototype (docs/11, Artifacts) so the built screen matches what was designed.
 *
 * -- Three things this screen must never do -----------------------------------
 *
 * 1. Show the key. The input is `type="password"`, so it is dots while being
 *    typed or pasted; after saving, the server returns only `sk-ant-…1G4a` and
 *    there is no endpoint that would return more. The value is held in component
 *    state for the length of one submit and cleared — never localStorage, never
 *    a URL, never a re-render of what was typed.
 *
 * 2. Decide who may configure. `can_configure` is the server's answer
 *    (services/ai-config.ts). Non-admins get "contact your admin" here AND a 403
 *    if they call the endpoint anyway — this panel is the polite half of a rule
 *    enforced somewhere it cannot be bypassed, exactly like the AI lock itself
 *    (Invariant 5).
 *
 * 3. Claim a state it has not been told about. "Connected" appears only when the
 *    server says a channel is connected; the not-connected row states what the
 *    school would have to provision, because that is the actionable fact
 *    (docs/07 §4).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  disableAi,
  disconnectChannel,
  getSettings,
  saveAiKey,
  type AiConfig,
  type AiProviderId,
  type ChannelRow,
  type ProviderMeta,
  type SettingsResponse,
  type SessionResponse,
} from '../api/client';

/** docs/05 §4.2's state machine, as the four things a reader needs to know. */
const STATUS_LABEL: Record<AiConfig['ai_status'], { text: string; tone: string }> = {
  not_configured: { text: 'Not configured', tone: 'nodata' },
  pending_validation: { text: 'Could not verify', tone: 'nodata' },
  active: { text: 'Active', tone: 'live' },
  error: { text: 'Needs attention', tone: 'nodata' },
};

interface Props {
  session: SessionResponse;
  onAiStatusChange: (status: string) => void;
}

export function Settings({ session, onAiStatusChange }: Props): JSX.Element {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getSettings()
      .then((data) => {
        setSettings(data);
        setError(null);
      })
      .catch((err: unknown) => {
        // Fail loud (§10): an empty settings page would read as "nothing to set up".
        setError(err instanceof Error ? err.message : 'Could not load settings.');
      });
  }, []);

  useEffect(load, [load]);

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[980px]">
        <h1 className="page-title">Settings · AI &amp; Messaging</h1>

        {error !== null && <div className="notice mt-4">{error}</div>}

        {settings === null ? (
          <div className="mt-10 text-[13px] text-[var(--color-muted)] animate-pulse">
            {error === null ? 'Loading your configuration…' : ''}
          </div>
        ) : (
          <>
            <AiPanel
              settings={settings}
              onChanged={(ai) => {
                setSettings({ ...settings, ai });
                onAiStatusChange(ai.ai_status);
              }}
            />
            <ChannelsPanel
              settings={settings}
              canConfigure={session.can_configure_ai}
              onChanged={(channels) => { setSettings({ ...settings, channels }); }}
            />
          </>
        )}
      </div>
    </main>
  );
}

function AiPanel({
  settings,
  onChanged,
}: {
  settings: SettingsResponse;
  onChanged: (ai: AiConfig) => void;
}): JSX.Element {
  const { ai, can_configure: canConfigure } = settings;
  const status = STATUS_LABEL[ai.ai_status];
  const active = ai.ai_status === 'active';

  /**
   * `replacing` exists because an active org must not be shown a key field by
   * default. docs/05 §5: "after activation the page becomes a status panel" —
   * the form comes back only when someone deliberately chooses to replace the
   * key, which also makes an accidental overwrite a two-step action.
   */
  const [replacing, setReplacing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  /**
   * ADR-031: which provider the form is currently filling in for — seeded
   * from the org's stored choice, not always Anthropic. Changing it resets
   * `model` to that provider's own first offering, since a model id from one
   * provider's catalog means nothing to another's.
   */
  const [provider, setProviderState] = useState<AiProviderId>(ai.provider);
  const currentProvider: ProviderMeta =
    settings.providers.find((p) => p.id === provider) ?? settings.providers[0]!;
  const [model, setModel] = useState(ai.model);
  const [cap, setCap] = useState(String(ai.monthly_query_cap));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(ai.last_error);
  const [done, setDone] = useState<string | null>(null);

  function setProvider(next: AiProviderId): void {
    setProviderState(next);
    const firstModel = settings.providers.find((p) => p.id === next)?.models[0]?.id;
    if (firstModel !== undefined) setModel(firstModel);
  }

  /**
   * Advisory only — catches the mismatch before a live API call has to. Only
   * detectable one direction today: Anthropic's `sk-ant-` prefix is reliable
   * enough to assert on; Gemini's isn't (a real key seen this session,
   * `AQ.Ab8RN6...`, doesn't match the commonly assumed shape), so
   * `key_prefix` is null for it and this never fires the other way. The
   * server's own `looksLikeValidKey`/`validateApiKey` remain the real gate —
   * this only saves a round trip for the case it can actually detect.
   */
  const trimmedKey = apiKey.trim();
  const suggestedProvider =
    trimmedKey === ''
      ? undefined
      : settings.providers.find(
          (p) => p.id !== provider && p.key_prefix !== null && trimmedKey.startsWith(p.key_prefix),
        );

  const showForm = canConfigure && (!active || replacing);

  function submit(): void {
    setBusy(true);
    setProblem(null);
    setDone(null);
    saveAiKey({ provider, api_key: apiKey, model, monthly_query_cap: Number(cap) })
      .then((result) => {
        // Cleared on every outcome: the key has done its one journey, and
        // holding it in state past that is holding a secret for no reason.
        setApiKey('');
        onChanged(result.ai);
        if (result.error === null) {
          setReplacing(false);
          setDone('Verified. AI reports are unlocked for every school and user in this org.');
        } else {
          setProblem(result.error);
        }
      })
      .catch((err: unknown) => {
        setApiKey('');
        setProblem(err instanceof Error ? err.message : 'The key could not be saved.');
      })
      .finally(() => { setBusy(false); });
  }

  function turnOff(): void {
    setBusy(true);
    disableAi()
      .then((result) => {
        onChanged(result.ai);
        setDone(null);
        setProblem(null);
        setReplacing(false);
      })
      .catch((err: unknown) => {
        setProblem(err instanceof Error ? err.message : 'AI could not be disabled.');
      })
      .finally(() => { setBusy(false); });
  }

  return (
    <section className="mt-5">
      <div className="settingsHead">
        <div>
          <h2 className="settingsTitle">AI Configuration — {settings.org_name}</h2>
          <p className="settingsSub">
            One key unlocks AI reports for all {settings.school_count}{' '}
            {settings.school_count === 1 ? 'school' : 'schools'} &amp; every user
          </p>
        </div>
        <span className={`pill ${status.tone}`}>● {status.text}</span>
      </div>

      {/* ① The provider account. Guidance only — nothing here touches the API. */}
      <div className="card stepCard">
        <div className="stepRow">
          <span className="stepNum">1</span>
          <div className="stepBody">
            <h3 className="stepTitle">Create an account with {currentProvider.label}</h3>
            <p className="stepText">
              <a
                className="stepLink"
                href={currentProvider.console_url}
                /* Opens in a new tab, and `noopener` with it: a bare
                   target="_blank" hands the opened page a live `window.opener`
                   reference back into this session's tab. */
                target="_blank"
                rel="noopener noreferrer"
              >
                {currentProvider.console_url.replace(/^https?:\/\//, '')}
              </a>{' '}
              {provider === 'anthropic' ? (
                <>
                  → sign up free → <b>Billing</b>: add a card or prepaid credits (even $5 ≈
                  hundreds of reports) → <b>API Keys</b> → Create Key → copy it — it’s shown only
                  once and starts with <code>sk-ant-…</code>
                </>
              ) : (
                <>
                  → sign in with a Google account → <b>Create API key</b> → copy it. Gemini has a
                  free usage tier, so this can be tested before any billing is set up.
                </>
              )}
            </p>
            <div className="stepActions">
              <a
                className="btn btnOutline"
                href={currentProvider.console_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open {currentProvider.label} ↗
              </a>
              <button
                type="button"
                className="btn btnGhost"
                disabled
                title="The illustrated setup guide (docs/05 §5) is not written yet"
              >
                📄 PDF guide
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ② The key itself. */}
      <div className="card stepCard">
        <div className="stepRow">
          <span className="stepNum">2</span>
          <div className="stepBody">
            <h3 className="stepTitle">Connect the key to this dashboard</h3>

            {!canConfigure && (
              /**
               * The non-admin path. Stated plainly and without a disabled form
               * behind it: showing the field greyed out invites someone to
               * hunt for the permission that would enable it, when the answer
               * is a person, not a setting.
               */
              <div className="adminOnly">
                <span className="adminOnlyIcon">🔒</span>
                <div>
                  <b>{settings.contact_admin}</b>
                  <p className="stepText mt-1">
                    The Anthropic key is billed to the whole organisation, so only an admin can
                    connect or replace it. Every dashboard on the left works without it.
                  </p>
                </div>
              </div>
            )}

            {canConfigure && active && !replacing && (
              <div className="keyStatus">
                <div>
                  <div className="keyMasked">{ai.key_hint ?? currentProvider.key_placeholder}</div>
                  <p className="stepText">
                    {ai.last_validated_at === null
                      ? 'Verified.'
                      : `Verified ${new Date(ai.last_validated_at).toLocaleString()}.`}{' '}
                    {providerLabel(settings, ai.provider)} · {modelLabel(settings, ai.provider, ai.model)} · cap{' '}
                    {ai.monthly_query_cap.toLocaleString('en-IN')} queries/month.
                  </p>
                </div>
                <div className="stepActions">
                  <button
                    type="button"
                    className="btn btnOutline"
                    onClick={() => { setReplacing(true); }}
                    disabled={busy}
                  >
                    Replace key
                  </button>
                  <button type="button" className="btn btnGhost" onClick={turnOff} disabled={busy}>
                    Disable AI
                  </button>
                </div>
              </div>
            )}

            {showForm && (
              <>
                {/* ADR-031: an org picks one provider, not both — switching
                    resets the model choice below to that provider's own list. */}
                <div className="modelChoice mb-2">
                  {settings.providers.map((option) => (
                    <label key={option.id}>
                      <input
                        type="radio"
                        name="ai-provider"
                        value={option.id}
                        checked={provider === option.id}
                        onChange={() => { setProvider(option.id); }}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                <input
                  /* Dots, not text — the key is never legible on screen, not
                     even to the person pasting it. */
                  type="password"
                  className="keyInput"
                  placeholder={currentProvider.key_placeholder}
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => { setApiKey(e.target.value); }}
                  aria-label={`${currentProvider.label} API key`}
                />
                {suggestedProvider !== undefined && (
                  <p className="stepText mt-1 text-[var(--color-amber)]">
                    This looks like {article(suggestedProvider.label)} {suggestedProvider.label} key,
                    not {article(currentProvider.label)} {currentProvider.label} one.{' '}
                    <button
                      type="button"
                      className="stepLink bg-transparent border-0 p-0 cursor-pointer"
                      onClick={() => { setProvider(suggestedProvider.id); }}
                    >
                      Switch to {suggestedProvider.label}
                    </button>
                  </p>
                )}
                <div className="keyRow">
                  <div className="modelChoice">
                    {currentProvider.models.map((option) => (
                      <label key={option.id}>
                        <input
                          type="radio"
                          name="ai-model"
                          value={option.id}
                          checked={model === option.id}
                          onChange={() => { setModel(option.id); }}
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                  <label className="capField">
                    Monthly cap
                    <input
                      type="number"
                      min={1}
                      value={cap}
                      onChange={(e) => { setCap(e.target.value); }}
                    />
                    queries
                  </label>
                </div>
                <div className="stepActions mt-3">
                  <button
                    type="button"
                    className="btn btnPrimary"
                    onClick={submit}
                    disabled={busy || apiKey.trim() === ''}
                  >
                    {busy ? 'Testing…' : 'Test & Save Connection'}
                  </button>
                  {active && (
                    <button
                      type="button"
                      className="btn btnGhost"
                      onClick={() => { setReplacing(false); setApiKey(''); }}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}

            {problem !== null && <div className="notice mt-3">{problem}</div>}
            {done !== null && <div className="okNotice mt-3">{done}</div>}
          </div>
        </div>
      </div>

      {/* ③ What happens after activation. */}
      <div className="card stepCard">
        <div className="stepRow">
          <span className="stepNum">3</span>
          <div className="stepBody">
            <h3 className="stepTitle">
              Usage &amp; control <span className="stepMuted">· appears after activation</span>
            </h3>
            <p className="stepText">
              Once active: per-school usage meter, estimated cost, replace-key and disable controls.
              If the key is revoked or credit runs out, chat auto-locks with a fix-it banner —
              dashboards keep working.
            </p>
          </div>
        </div>
      </div>

      {/* The security posture, stated where the key is entered rather than in a
          policy document nobody reading this screen will open (ADR-017). */}
      <p className="settingsFine">
        Key stored AES-256 encrypted · masked after save · never logged · revocable anytime from
        the provider's own console.
      </p>
    </section>
  );
}

/** "a Google key" vs "an Anthropic key" — provider labels are server data, not a fixed set. */
function article(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a';
}

function providerLabel(settings: SettingsResponse, providerId: string): string {
  return settings.providers.find((p) => p.id === providerId)?.label ?? providerId;
}

function modelLabel(settings: SettingsResponse, providerId: string, modelId: string): string {
  const models = settings.providers.find((p) => p.id === providerId)?.models ?? [];
  return models.find((m) => m.id === modelId)?.label ?? modelId;
}

function ChannelsPanel({
  settings,
  canConfigure,
  onChanged,
}: {
  settings: SettingsResponse;
  canConfigure: boolean;
  onChanged: (channels: ChannelRow[]) => void;
}): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);

  const bySchool = new Map<string, ChannelRow[]>();
  for (const row of settings.channels) {
    const list = bySchool.get(row.school_id) ?? [];
    list.push(row);
    bySchool.set(row.school_id, list);
  }

  function disconnect(row: ChannelRow): void {
    const id = `${row.school_id}:${row.channel}`;
    setBusy(id);
    disconnectChannel(row.school_id, row.channel)
      .then((result) => { onChanged(result.channels); })
      .finally(() => { setBusy(null); });
  }

  return (
    <section className="mt-8">
      <h2 className="settingsTitle">Messaging Channels — configured by your school</h2>
      <p className="settingsSub">
        Workflow-agent message steps can only use channels connected here
      </p>

      {[...bySchool.entries()].map(([schoolId, rows]) => (
        <div key={schoolId} className="card channelCard">
          {/* Named per school because the connection belongs to the school, not
              the trust: sender reputation, DLT attribution and WABA quality
              ratings are per school (docs/07 §4). */}
          {bySchool.size > 1 && <div className="channelSchool">{rows[0]?.school_name}</div>}
          {rows.map((row) => (
            <div key={row.channel} className="channelRow">
              <span className="channelIcon">{row.icon}</span>
              <div className="channelBody">
                <b>{row.title}</b>
                <p className="channelDetail">
                  {row.status === 'connected' ? (row.detail ?? 'Connected') : row.requirement}
                </p>
              </div>
              {row.status === 'connected' ? (
                <>
                  <span className="pill live">● Connected</span>
                  <button
                    type="button"
                    className="btn btnOutline"
                    disabled={!canConfigure || busy === `${row.school_id}:${row.channel}`}
                    title={canConfigure ? undefined : 'Only an admin can change messaging channels'}
                    onClick={() => { disconnect(row); }}
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  <span className="pill nodata">Not connected</span>
                  {/**
                   * Deliberately inert. Connecting needs an SMTP password, a
                   * DLT registration or a BSP token, and the platform has
                   * nowhere safe to put those yet — a button that flipped the
                   * flag without them would tell a school it can send messages
                   * it cannot. Shown rather than hidden, per "locked ≠ hidden".
                   */}
                  <button
                    type="button"
                    className="btn btnGhost"
                    disabled
                    title="Provider credential storage is not built yet (docs/07 §4)"
                  >
                    Connect
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      ))}

      <p className="settingsFine">
        SMS and WhatsApp can only send templates approved by the DLT registrar and the WhatsApp
        Business provider — that approval is a per-school process, not a setting on this page
        (ADR-024).
      </p>
    </section>
  );
}
