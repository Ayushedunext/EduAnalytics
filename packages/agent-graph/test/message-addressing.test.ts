/**
 * Addressing and message rendering (ADR-036, ADR-035).
 *
 * [MANDATORY] CODING_GUIDELINES §14: publish-time flow linting is a gate, and a
 * gate that is not tested is a gate that quietly opens. Two rules are new here
 * and both fail in ways nobody notices at the time:
 *
 *  - an email node with no address publishes happily and then fails at 10:31,
 *    in a `message_log` row nobody is reading;
 *  - a message body with an unfilled `{{slot}}` goes out under the school's
 *    name and cannot be recalled.
 *
 * Pure: no database, no SMTP, no configuration.
 */

import { describe, expect, it } from 'vitest';
import { validateGraph, type FlowLintContext } from '../src/validate.js';
import { messageSubject, renderMessageBody, slotsNotCoveredBy, unresolvedSlots } from '../src/render-message.js';
import { CONTACT_FIELD_BY_CHANNEL, FETCH_SOURCES, UNPOPULATED_FIELDS } from '../src/types.js';
import type { AgentGraph, ChannelId } from '../src/types.js';

const APPROVED = 'absence-3rd-day';

function ctx(overrides: Partial<FlowLintContext> = {}): FlowLintContext {
  return {
    connectedChannels: new Set<ChannelId>(['email', 'sms', 'whatsapp']),
    approvedTemplateIds: new Set([APPROVED]),
    ...overrides,
  };
}

/** The smallest graph that reaches a message node: trigger → message → end. */
function graphWith(message: Record<string, unknown>): AgentGraph {
  return {
    nodes: [
      { id: 'trigger', position: { x: 0, y: 0 }, data: { kind: 'manual', label: 'Run now' } },
      {
        id: 'msg',
        position: { x: 0, y: 100 },
        data: {
          kind: 'message',
          channels: ['email'],
          primary: 'email',
          template_id: APPROVED,
          template_preview: 'Hello.',
          also_notify_staff: false,
          ...message,
        },
      },
      { id: 'end', position: { x: 0, y: 200 }, data: { kind: 'end' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'msg' },
      { id: 'e2', source: 'msg', target: 'end' },
    ],
  } as AgentGraph;
}

function messagesFrom(result: ReturnType<typeof validateGraph>): string[] {
  return result.ok ? [] : result.errors.map((e) => e.message);
}

describe('flow lint — addressing (ADR-036)', () => {
  it('refuses an email node that can reach nobody, naming why', () => {
    const result = validateGraph(graphWith({}), ctx());
    expect(result.ok).toBe(false);
    expect(messagesFrom(result).join(' ')).toContain('item 10');
  });

  it('accepts the same node once it names its own address', () => {
    const result = validateGraph(graphWith({ recipient: 'principal@school.edu' }), ctx());
    expect(result.ok).toBe(true);
  });

  it('accepts an email node with no address once a record can supply one', () => {
    /**
     * The whole point of the ordered resolution: on the day docs/11 §2 item 10
     * is answered, every node that left `recipient` empty becomes publishable
     * again by flipping one caller's flag — no edit, no migration.
     */
    const result = validateGraph(graphWith({}), ctx({ recordCanSupplyContact: true }));
    expect(result.ok).toBe(true);
  });

  it('refuses a recipient on a channel whose sender registration does not exist', () => {
    const result = validateGraph(
      graphWith({ channels: ['sms'], primary: 'sms', recipient: 'someone@school.edu' }),
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(messagesFrom(result).join(' ')).toContain('registered sender');
  });

  it('still refuses an unapproved template, address or no address', () => {
    const result = validateGraph(
      graphWith({ template_id: 'not-approved', recipient: 'principal@school.edu' }),
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(messagesFrom(result).join(' ')).toContain('not approved');
  });

  it('still refuses a disconnected channel, address or no address', () => {
    const result = validateGraph(
      graphWith({ recipient: 'principal@school.edu' }),
      ctx({ connectedChannels: new Set<ChannelId>([]) }),
    );
    expect(result.ok).toBe(false);
    expect(messagesFrom(result).join(' ')).toContain('not connected');
  });
});

describe('renderMessageBody', () => {
  const record = { student_name: 'Aarav', 'student.class': '9-B', consecutive_days: 3 };

  it('fills a flat key and a dotted path the same way', () => {
    expect(renderMessageBody('{{student_name}} · {{student.class}}', record)).toBe('Aarav · 9-B');
  });

  /**
   * The case the shipped gallery actually depends on: templates are written in
   * docs/07's dotted vocabulary, and the records a run carries are the flat
   * `fields` a fetch source declares. Before this bridge existed, every
   * template in the gallery rendered entirely unresolved — and, with the
   * refusal rule above, would have sent nothing at all.
   */
  it('bridges the docs’ dotted names to a source’s flat fields', () => {
    const feeRecord = { student_name: 'Aarav', class: '9-B', balance_amount: 12500, days_overdue: 63 };
    expect(
      renderMessageBody(
        '{{student.name}} ({{student.class}}) owes ₹{{fee.balance_amount}}, {{fee.days_overdue}} days overdue.',
        feeRecord,
      ),
    ).toBe('Aarav (9-B) owes ₹12500, 63 days overdue.');
    expect(unresolvedSlots('{{student.name}} {{fee.balance_amount}}', feeRecord)).toEqual([]);
  });

  it('prefers a literal key over the last-segment fallback', () => {
    /* Rule order is what makes rendering deterministic: the broadest rule is
       last, so anything a more literal one can answer never reaches it. */
    const both = { 'fee.balance_amount': 'literal', balance_amount: 'fallback' };
    expect(renderMessageBody('{{fee.balance_amount}}', both)).toBe('literal');
  });

  it('does not invent a value for a name no rule can reach', () => {
    expect(unresolvedSlots('{{parent.phone}}', { student_name: 'Aarav' })).toEqual(['parent.phone']);
  });

  it('fills numbers', () => {
    expect(renderMessageBody('{{consecutive_days}} days', record)).toBe('3 days');
  });

  it('leaves an unresolved slot standing rather than blanking it', () => {
    /**
     * "Dear parent,  has been absent" reads as a bug in the school's message
     * rather than as missing data. The slot survives so the failure is visible
     * — and `unresolvedSlots` is what stops it being sent at all.
     */
    expect(renderMessageBody('Dear parent, {{parent.name}} —', record)).toBe('Dear parent, {{parent.name}} —');
  });

  it('reports every unresolved slot once', () => {
    const slots = unresolvedSlots('{{a}} {{b}} {{a}} {{student_name}}', record);
    expect([...slots].sort()).toEqual(['a', 'b']);
  });

  it('treats null and undefined as unresolved, not as the text "null"', () => {
    expect(unresolvedSlots('{{x}}', { x: null })).toEqual(['x']);
    expect(renderMessageBody('{{x}}', { x: null })).toBe('{{x}}');
  });

  it('reports nothing when every slot resolves', () => {
    expect(unresolvedSlots('{{student_name}}', record)).toEqual([]);
  });
});

describe('messageSubject', () => {
  it('uses the agent name — the one string the school wrote about this message', () => {
    expect(messageSubject('Absence alert — Class 9')).toBe('Absence alert — Class 9');
  });

  it('falls back rather than sending an empty subject', () => {
    expect(messageSubject('   ')).toBe('A message from your school');
  });
});

describe('addressing a record, by channel', () => {
  /**
   * The bug this exists to prevent is invisible today: every contact field is
   * null (docs/11 §2 item 10), so ANY mapping "works". It becomes visible on
   * the first day a real column lands — as every email failing at the SMTP
   * server, with an error that reads like an outage rather than like a phone
   * number in a To: header.
   */
  it('sends email to an address and the phone channels to a number', () => {
    expect(CONTACT_FIELD_BY_CHANNEL.email).toBe('parent_email');
    expect(CONTACT_FIELD_BY_CHANNEL.sms).toBe('parent_phone');
    expect(CONTACT_FIELD_BY_CHANNEL.whatsapp).toBe('parent_phone');
  });

  it('names a field every runnable source actually declares', () => {
    /* A channel mapped to a column no source returns would resolve to
       undefined for ever, which looks exactly like the missing-contact case
       and would hide a real mapping mistake inside a known gap. */
    for (const [id, source] of Object.entries(FETCH_SOURCES)) {
      if (!source.runnable) continue;
      for (const channel of ['email', 'sms', 'whatsapp'] as const) {
        expect(source.fields, `${id} must declare ${CONTACT_FIELD_BY_CHANNEL[channel]}`).toContain(
          CONTACT_FIELD_BY_CHANNEL[channel],
        );
      }
    }
  });

  it('lists every contact field as unpopulated while item 10 is open', () => {
    for (const channel of ['email', 'sms', 'whatsapp'] as const) {
      expect(UNPOPULATED_FIELDS).toContain(CONTACT_FIELD_BY_CHANNEL[channel]);
    }
  });
});

describe('slotsNotCoveredBy — what the builder warns about', () => {
  const fields = FETCH_SOURCES.fee_defaulters_30_60_90.fields.filter(
    (f) => !UNPOPULATED_FIELDS.includes(f),
  );

  it('accepts the shipped fee template', () => {
    expect(
      slotsNotCoveredBy(
        'Dear parent, {{student.name}} ({{student.class}}) has fee dues of ₹{{fee.balance_amount}} overdue by {{fee.days_overdue}} days.',
        fields,
      ),
    ).toEqual([]);
  });

  it('flags a contact variable, because it is declared but never filled', () => {
    expect(slotsNotCoveredBy('Call {{parent.phone}}', fields)).toEqual(['parent.phone']);
  });

  it('flags a variable this source does not have at all', () => {
    /* `consecutive_days` belongs to the absence source, not the fee one — the
       warning is per agent, not per product. */
    expect(slotsNotCoveredBy('{{consecutive_days}}', fields)).toEqual(['consecutive_days']);
  });

  it('agrees with the runtime rule it stands in for', () => {
    /* The builder promises what the sender will do; a second, looser
       implementation here is how that promise starts being false. */
    const template = '{{student.name}} · {{parent.phone}}';
    const record: Record<string, unknown> = { student_name: 'Aarav', parent_phone: null };
    expect(slotsNotCoveredBy(template, fields)).toEqual(unresolvedSlots(template, record));
  });
});
