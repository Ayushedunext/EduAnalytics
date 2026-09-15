/**
 * @sap/agent-graph — the workflow-agent contract (ADR-022).
 *
 * [MANDATORY] CODING_GUIDELINES §1: these types are imported, never
 * copy-pasted between services.
 *
 * -- Why the Drizzle schema is NOT re-exported here --------------------------
 * `apps/web` imports this package's types too (the builder renders the same
 * `AgentGraph` shape the server validates) and must never pull `drizzle-orm`
 * into a browser bundle for a table definition it will never query. The
 * Drizzle schema lives at the separate `@sap/agent-graph/db-schema` entry
 * point (src/db-schema.ts), imported only by apps/orchestrator and
 * apps/agent-runtime.
 */

export * from './types.js';
export * from './validate.js';
export * from './templates.js';
export * from './queue-contract.js';
export * from './channel-resolution.js';
export * from './fetch-source-sql.js';
