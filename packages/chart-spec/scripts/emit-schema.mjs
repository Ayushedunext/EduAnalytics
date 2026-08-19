/**
 * Emits the canonical chart-spec JSON Schema from the Zod schemas.
 *
 * AUDIT_REPORT C9: ADR-015 fixed the philosophy but only example JSON existed;
 * /packages/chart-spec needed a field-level schema, and it is also the
 * validation target named in CODING_GUIDELINES §10.
 *
 * Generated, never hand-edited: the Zod schema in src/spec.ts is the single
 * source of truth. Two hand-maintained copies of a contract is exactly the
 * drift CODING_GUIDELINES §1 warns about. Run `npm run schema -w @sap/chart-spec`
 * after any change to src/spec.ts.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { chartSpecSchema, chartSpecDraftSchema } from '../dist/spec.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'schema');
mkdirSync(outDir, { recursive: true });

const emit = (name, schema, title) => {
  const json = zodToJsonSchema(schema, {
    name: title,
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });
  const path = join(outDir, name);
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`wrote ${name}`);
};

emit('chart-spec.schema.json', chartSpecSchema, 'ChartSpec');
emit('chart-spec-draft.schema.json', chartSpecDraftSchema, 'ChartSpecDraft');
