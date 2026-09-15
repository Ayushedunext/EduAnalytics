/**
 * Flow linting — what blocks Publish (docs/07 §6: "Flow linting blocks
 * Publish on broken graphs: unconnected node, action before trigger,
 * unapproved template").
 *
 * Deliberately pure: this module knows nothing about the platform database or
 * the MCP server. Channel-connection and template-approval state are facts
 * the ORCHESTRATOR knows (services/channels.ts, a future Template Manager
 * store); they are passed in here as plain sets so this package stays testable
 * without a database and reusable from apps/agent-runtime, which re-validates
 * a graph before running it for the same reason CODING_GUIDELINES §9's
 * "validate on read, not only on write" discipline applies everywhere else —
 * a version written by an older builder must not be trusted blind by a newer
 * runtime.
 */

import {
  RUNNABLE_ACTION_KINDS,
  RUNNABLE_TRIGGER_KINDS,
  isMessageAction,
  type AgentGraph,
  type ChannelId,
} from './types.js';

export interface FlowLintError {
  readonly node_id?: string;
  readonly message: string;
}

export interface FlowLintContext {
  /** Channels this school (or org default, ADR-034) currently has connected. */
  readonly connectedChannels: ReadonlySet<ChannelId>;
  /** Template ids with an APPROVED status in the Template Manager (ADR-024). */
  readonly approvedTemplateIds: ReadonlySet<string>;
}

const TRIGGER_KIND_SET = new Set<string>(['schedule', 'manual', 'email_received', 'erp_event']);

export function validateGraph(
  graph: AgentGraph,
  ctx: FlowLintContext,
): { ok: true } | { ok: false; errors: readonly FlowLintError[] } {
  const errors: FlowLintError[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // -- Exactly one trigger, and it is runnable ------------------------------
  const triggers = graph.nodes.filter((n) => TRIGGER_KIND_SET.has(n.data.kind));
  if (triggers.length === 0) {
    errors.push({ message: 'A flow needs exactly one trigger to start it.' });
  } else if (triggers.length > 1) {
    for (const t of triggers) errors.push({ node_id: t.id, message: 'Only one trigger is allowed per agent.' });
  } else {
    const trigger = triggers[0];
    if (trigger !== undefined && !RUNNABLE_TRIGGER_KINDS.has(trigger.data.kind as never)) {
      errors.push({
        node_id: trigger.id,
        message: `The "${trigger.data.kind}" trigger is not runnable yet (docs/11 §2) — use Schedule or Manual for now.`,
      });
    }
  }
  const triggerId = triggers.length === 1 ? triggers[0]?.id : undefined;

  // -- Unconnected node / action before trigger -----------------------------
  // One reachability pass covers both named checks: a node with no path FROM
  // the trigger is simultaneously "unconnected" (nothing reaches it) and, if
  // it is an action, "before" the trigger in the only sense that matters —
  // the trigger never fires it.
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const reachable = new Set<string>();
  if (triggerId !== undefined) {
    const stack = [triggerId];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || reachable.has(id)) continue;
      reachable.add(id);
      for (const next of outgoing.get(id) ?? []) stack.push(next);
    }
  }
  for (const node of graph.nodes) {
    if (node.id === triggerId) continue;
    if (!reachable.has(node.id)) {
      errors.push({ node_id: node.id, message: 'This node is not connected to the trigger.' });
    }
  }

  // -- End nodes: every non-end node needs somewhere to go ------------------
  for (const node of graph.nodes) {
    if (node.data.kind === 'end' || node.data.kind === 'escalate_end') continue;
    if (reachable.has(node.id) && (outgoing.get(node.id) ?? []).length === 0) {
      errors.push({ node_id: node.id, message: 'This node has no outgoing connection — every branch must reach an End.' });
    }
  }

  // -- Per-node content checks ------------------------------------------------
  for (const node of graph.nodes) {
    if (!RUNNABLE_ACTION_KINDS.has(node.data.kind as never) && isActionKind(node.data.kind)) {
      errors.push({
        node_id: node.id,
        message: `The "${node.data.kind}" action is not available yet (docs/11 §2) — use a message, notify-staff, or log action for now.`,
      });
    }

    if (isMessageAction(node.data)) {
      for (const channel of node.data.channels) {
        if (!ctx.connectedChannels.has(channel)) {
          errors.push({
            node_id: node.id,
            message: `"${channel}" is not connected for this school — connect it in Settings or choose a different channel.`,
          });
        }
      }
      if (!ctx.approvedTemplateIds.has(node.data.template_id)) {
        errors.push({
          node_id: node.id,
          message: 'This node references a template that is not approved yet.',
        });
      }
    }
  }

  // -- Dangling ids on edges --------------------------------------------------
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      errors.push({ message: `Edge "${edge.id}" refers to a node that does not exist.` });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function isActionKind(kind: string): boolean {
  return ['message', 'erp_notify', 'notify_staff', 'ai_compose', 'webhook', 'log'].includes(kind);
}
