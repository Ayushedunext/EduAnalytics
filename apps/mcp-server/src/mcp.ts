/**
 * The MCP tool surface.
 *
 * Contract source: ADR-006 (the six tools ARE the contract; renaming or aliasing
 * one is an ADR) · docs/04 §2 · CODING_GUIDELINES §2.
 *
 * -- One server instance per request -----------------------------------------
 * `buildMcpServer` takes the verified call context and closes over it, so every
 * tool registered on the returned server can only ever see one session's allowed
 * set. That is not an optimisation, it is the enforcement: there is no ambient
 * "current context" for a handler to read the wrong value from, and a handler
 * that somehow ran without a context would have no context object to run with.
 * The transport is stateless (docs/04 §1, §6), so a server per request is the
 * natural lifetime anyway.
 *
 * -- What this slice does not register ---------------------------------------
 * docs/04 §2 lists six tools. Five are here. `run_rollup` needs the Rollup
 * Store, whose technology is still an open decision (CODING_GUIDELINES §23 —
 * Aurora MySQL vs ClickHouse, "resolve by ADR before Phase 2 builds on it"), so
 * it is not stubbed: a registered tool is a promise to the model that it will
 * work, and one that always errors would teach it to route around a path the
 * product depends on. It arrives with the store it reads from.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './scope.js';
import { fail, type ToolResponse } from './tools/result.js';
import { getSchema, getSchemaInput } from './tools/get-schema.js';
import { getDimensions, getDimensionsInput } from './tools/get-dimensions.js';
import { runQuery, runQueryInput } from './tools/run-query.js';
import { runMulti, runMultiInput } from './tools/run-multi.js';
import { runPredefined, runPredefinedInput } from './tools/run-predefined.js';

export const SERVER_NAME = 'school-analytics';
export const SERVER_VERSION = '0.1.0';

/**
 * Every handler is wrapped, so no tool can answer with an unshaped error and
 * none can leak diagnostics by forgetting to catch (tools/result.ts).
 */
function guarded<A>(
  tool: string,
  context: ToolContext,
  handler: (context: ToolContext, args: A) => Promise<ToolResponse>,
): (args: A) => Promise<ToolResponse> {
  return async (args: A) => {
    try {
      return await handler(context, args);
    } catch (err) {
      return fail(err, { tool, correlationId: context.call.correlation_id });
    }
  };
}

export function buildMcpServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only analytics over school ERP data. Call get_schema first to learn the tables, ' +
        'then get_dimensions for a school to learn its real filter values before writing SQL. ' +
        'Query one school with run_query and several with run_multi. ' +
        'The set of schools you may query is fixed by the session and is not something you choose or widen; ' +
        'the server adds every tenant filter, row cap and time cap itself.',
    },
  );

  server.registerTool(
    'get_schema',
    {
      title: 'Get schema',
      description:
        'Tables, columns, relationships and query rules for a schema version. Read this before writing any SQL.',
      inputSchema: getSchemaInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded('get_schema', context, getSchema),
  );

  server.registerTool(
    'get_dimensions',
    {
      title: 'Get dimensions',
      description:
        "One school's real filter values: academic years, classes, sections, fee heads, departments. " +
        'Use these exact strings in WHERE clauses rather than guessing at labels.',
      inputSchema: getDimensionsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded('get_dimensions', context, getDimensions),
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run query',
      description:
        'Run one SELECT against one school. Results are capped at 5,000 rows and 10 seconds, so aggregate in SQL rather than returning detail for later summarising.',
      inputSchema: runQueryInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded('run_query', context, runQuery),
  );

  server.registerTool(
    'run_multi',
    {
      title: 'Run query across schools',
      description:
        'Run the same SELECT across several schools in parallel and merge the rows, each tagged with its school_id. ' +
        'At most 25 schools. A school that fails is reported in per_school and the rest of the result still returns.',
      inputSchema: runMultiInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded('run_multi', context, runMulti),
  );

  server.registerTool(
    'run_predefined',
    {
      title: 'Run a predefined report',
      description:
        'Run a vetted report from the catalog against one or more schools. You choose the report and its filter values; the SQL is the platform’s and cannot be supplied. ' +
        'Prefer this over run_query whenever a catalog report answers the question — it is faster, parameterised, and costs no planning.',
      inputSchema: runPredefinedInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded('run_predefined', context, runPredefined),
  );

  return server;
}
