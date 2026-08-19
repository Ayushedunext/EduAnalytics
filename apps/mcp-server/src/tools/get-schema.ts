/**
 * `get_schema(schema_version)` — docs/04 §2.
 *
 * Returns the tables, columns, relationships and rules for one schema version.
 * Cached per version, not per school (ADR-014): all schools run the vendor's ERP
 * schema in 3–5 live versions, so 1,500 databases collapse to a handful of
 * documents. That is also what makes Anthropic prompt caching effective, which
 * ADR-026 calls the single biggest AI cost and latency lever — thousands of
 * schools share a byte-identical schema block.
 *
 * The document is served from the process (schema/catalog.ts), so "cached" here
 * needs no cache: it is a constant. The daily refresh docs/04 §2 mentions
 * becomes relevant when catalogs are generated from live introspection rather
 * than committed to the repository.
 *
 * -- Why the version is checked against scope --------------------------------
 * `schema_version` is not a tenant identifier, so it is not scope-bearing in the
 * ADR-007 sense. It is still not a free parameter: a caller who could name any
 * version could enumerate the schemas of ERP deployments this session has
 * nothing to do with. So the answer is limited to versions some school in the
 * session's own scope actually runs — the same instinct as scope enforcement,
 * applied to metadata.
 */

import { ERROR_CODES, PlatformError, safeSchemaVersionSchema } from '@sap/shared';
import { z } from 'zod';
import { getCatalog } from '../schema/index.js';
import { registryRow } from '../db/registry.js';
import type { ToolContext } from '../scope.js';
import { ok } from './result.js';

export const getSchemaInput = {
  schema_version: safeSchemaVersionSchema.describe(
    'The schema version to describe. Use the version reported for a school in scope.',
  ),
} satisfies z.ZodRawShape;

export async function getSchema(
  context: ToolContext,
  args: { schema_version: string },
): Promise<ReturnType<typeof ok>> {
  const inScopeVersions = await schemaVersionsInScope(context);

  if (!inScopeVersions.has(args.schema_version)) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'That schema version is not in use by any school available to this session.',
      details: { available_versions: [...inScopeVersions].join(', ') },
    });
  }

  const catalog = getCatalog(args.schema_version);
  if (catalog === undefined) {
    /**
     * A school claims a version the server has no document for. ADR-014's
     * trade-off, surfaced rather than papered over: "a school on a hotfixed
     * schema must be assigned a version honestly". Answering with the wrong
     * catalog would produce SQL that fails against the real database, and the
     * error would look like a query bug rather than a configuration one.
     */
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'Analytics has no schema document for this school yet.',
      diagnostics: { schema_version: args.schema_version },
    });
  }

  return ok(catalog);
}

/** Distinct schema versions across the schools this session may query. */
async function schemaVersionsInScope(context: ToolContext): Promise<Set<string>> {
  const versions = new Set<string>();
  for (const schoolId of context.call.school_ids) {
    const row = await registryRow(schoolId);
    if (row !== undefined) versions.add(row.schema_version);
  }
  return versions;
}
