/**
 * Development probe — talks to a running MCP server as a real MCP client.
 *
 * DEVELOPMENT ONLY. It stands in for the orchestrator until the orchestrator
 * grows its MCP client, and it exists because "the server starts" is not
 * evidence that the server works. It exercises the actual protocol over the
 * actual transport with a signed call context, which is the only way to see the
 * out-of-band scope mechanism doing its job.
 *
 *   npm run mcp:probe                     # the Director: all three schools
 *   npm run mcp:probe -- accountant       # fees only, no students.read
 *   npm run mcp:probe -- principal-mb     # one school
 *
 * The identities mirror tools/erp-stub/src/identities.ts, so what the probe
 * shows is what a real launch of that identity would produce.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  MCP_CONTEXT_HEADER,
  permissionClass,
  signCallContext,
  type McpCallContext,
} from '@sap/shared';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The repo-root .env, named explicitly — see the note in src/config.ts.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const URL_ = process.env['MCP_URL'] ?? 'http://127.0.0.1:3100/mcp';
const SECRET = process.env['MCP_CONTEXT_SECRET'];
if (SECRET === undefined || SECRET === '') {
  console.error('MCP_CONTEXT_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
const secret = new TextEncoder().encode(SECRET);

const IDENTITIES: Record<string, Omit<McpCallContext, 'permission_class' | 'correlation_id'>> = {
  director: {
    sub: 'erp-user-1001',
    org_id: 'stmarks',
    role: 'DIRECTOR',
    school_ids: ['stmarksg', 'stmarksj', 'stmarksmb'],
    perms: ['fees.read', 'students.read', 'staff.read'],
  },
  'principal-mb': {
    sub: 'erp-user-2001',
    org_id: 'stmarks',
    role: 'PRINCIPAL',
    school_ids: ['stmarksmb'],
    perms: ['fees.read', 'students.read', 'staff.read'],
  },
  accountant: {
    sub: 'erp-user-3001',
    org_id: 'stmarks',
    role: 'ACCOUNTANT',
    school_ids: ['stmarksmb'],
    perms: ['fees.read'],
  },
};

const key = process.argv[2] ?? 'director';
const identity = IDENTITIES[key];
if (identity === undefined) {
  console.error(`unknown identity "${key}". Try: ${Object.keys(IDENTITIES).join(', ')}`);
  process.exit(1);
}

const context: McpCallContext = {
  ...identity,
  permission_class: permissionClass({ role: identity.role, perms: identity.perms }),
  correlation_id: randomUUID(),
};

const token = await signCallContext(context, secret);

const client = new Client({ name: 'mcp-probe', version: '0.1.0' });
await client.connect(
  // Cast is SDK interop under exactOptionalPropertyTypes — see src/http.ts.
  new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { [MCP_CONTEXT_HEADER]: token } },
  }) as unknown as Transport,
);

console.log(`\nidentity: ${key}  scope: ${identity.school_ids.join(', ')}`);
console.log(`perms:    ${identity.perms.join(', ')}\n`);

const tools = await client.listTools();
console.log(`tools:    ${tools.tools.map((t) => t.name).join(', ')}\n`);

await show('get_schema', { schema_version: 'erp-v1' }, (text) => {
  const catalog = JSON.parse(text) as { tables: { name: string }[] };
  return `${String(catalog.tables.length)} tables: ${catalog.tables.map((t) => t.name).join(', ')}`;
});

await show('get_dimensions', { school_id: identity.school_ids[0]! });

await show('run_query', {
  school_id: identity.school_ids[0]!,
  sql:
    'SELECT classname, classseq, COUNT(*) AS students ' +
    "FROM students_data_set WHERE academicyearname = '2025-26' AND deactivation_date IS NULL " +
    'GROUP BY classname, classseq ORDER BY classseq',
});

// Note the year literal above: this dataset writes '2025-26', not '2025-2026'.
// Getting that wrong returns zero rows and no error, which is exactly the
// failure get_dimensions exists to prevent (docs/04 §2) — the probe guessed it
// wrong once before the dimension output corrected it.
//
// PII masking (docs/04 rail 6): the accountant sees [masked] where a Principal
// sees names, on the same query against the same rows.
await show('run_query', {
  school_id: identity.school_ids[0]!,
  sql:
    'SELECT studentname, enrollmentno, balance_amount FROM fee_compile_data_set ' +
    "WHERE academicyearname = '2025-26' AND balance_amount > 0 ORDER BY balance_amount DESC LIMIT 3",
});

// The row cap (ADR-008), which MySQL applies rather than the server discarding
// rows after transport: this school has ~48,000 student rows.
await show(
  'run_query',
  { school_id: identity.school_ids[0]!, sql: 'SELECT studentname FROM students_data_set' },
  (text) => {
    const r = JSON.parse(text) as { rows: unknown[]; truncated: boolean; masked_columns: string[] };
    return `rows=${String(r.rows.length)} truncated=${String(r.truncated)} masked=${
      r.masked_columns.join(',') || 'none'
    }`;
  },
);

if (identity.school_ids.length > 1) {
  await show('run_multi', {
    school_ids: identity.school_ids,
    sql:
      "SELECT COUNT(*) AS students FROM students_data_set WHERE academicyearname = '2025-26' AND deactivation_date IS NULL",
  });
}

// The vetted path: the caller names a report and a filter value, never SQL.
await show(
  'run_predefined',
  {
    report_id: identity.perms.includes('students.read') ? 'enrollment-overview' : 'fee-collection',
    school_ids: [identity.school_ids[0]!],
    params: { academic_year: '2026-27' },
  },
  (text) => {
    const r = JSON.parse(text) as {
      title: string;
      schools: { school_id: string; queries?: { key: string; status: string; rows?: unknown[] }[] }[];
    };
    const lines = (r.schools[0]?.queries ?? []).map(
      (q) => `  ${q.status.padEnd(7)} ${q.key.padEnd(14)} rows=${String(q.rows?.length ?? 0)}`,
    );
    return [r.title, ...lines].join('\n');
  },
);

// The scope check, layer 2 (ADR-007). `stmarksj` is real and in the same org —
// it is simply not in a Principal's or an Accountant's token.
await show('run_query', {
  school_id: 'stmarksj',
  sql: 'SELECT COUNT(*) AS n FROM students_data_set',
});

await client.close();

async function show(
  name: string,
  args: Record<string, unknown>,
  summarise?: (text: string) => string,
): Promise<void> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const text = result.content.map((c) => c.text ?? '').join('');
  const label = `${result.isError === true ? 'ERROR' : 'ok   '} ${name}`;
  console.log(`── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  if (result.isError !== true && summarise !== undefined) console.log(summarise(text));
  else console.log(text.length > 1600 ? `${text.slice(0, 1600)}\n… (truncated)` : text);
  console.log();
}
