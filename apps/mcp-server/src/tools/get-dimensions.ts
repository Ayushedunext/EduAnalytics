/**
 * `get_dimensions(school_id)` — docs/04 §2.
 *
 * The valid filter values for one school: academic years, classes, sections,
 * student categories, fee heads, departments, designations. Per school and
 * daily-cached — the one piece of schema-adjacent metadata ADR-014 does NOT
 * collapse per version, because class names and fee heads are a school's own
 * data, not the vendor's schema.
 *
 * Its purpose is stated plainly in docs/04 §2: "so the AI never guesses filter
 * values". A model that guesses `classname = 'Class 12'` against a school that
 * writes `XII` produces an empty report and a confident narrative about it — a
 * success-shaped failure (CODING_GUIDELINES §10), and the kind users do not
 * report as a bug because it looks like an answer.
 *
 * -- Vetted SQL takes the same path as everything else -----------------------
 * [MANDATORY] CODING_GUIDELINES §7: the rails apply uniformly, "including
 * 'trusted' predefined SQL". These statements are written in this repository and
 * are as trusted as SQL gets here, and they still go through the same guard and
 * executor as a model's — validated, tenant-filtered, capped, rate-limited,
 * audited. A second path for trusted SQL is precisely how a rail stops being
 * always-on.
 *
 * -- Groups follow the session's domain permissions --------------------------
 * docs/08 §4.5: "accountant → fees only". An accountant gets fee heads and no
 * class list, and the response names the groups it left out. Returning a shorter
 * list silently would leave the model planning against dimensions it cannot see
 * and concluding the school has none.
 */

import { z } from 'zod';
import { safeIdSchema } from '@sap/shared';
import { config } from '../config.js';
import { DOMAIN_PERM, type DataDomain } from '../schema/catalog.js';
import { resolveConnectionTarget } from '../db/registry.js';
import { runScopedSelect } from '../query-service.js';
import { requireInScope, type ToolContext } from '../scope.js';
import { ok } from './result.js';

const TOOL = 'get_dimensions';

export const getDimensionsInput = {
  school_id: safeIdSchema.describe(
    'A school from the session scope. The set of schools is fixed by the launch token; this only selects among them.',
  ),
} satisfies z.ZodRawShape;

interface DimensionQuery {
  readonly key: string;
  readonly domain: DataDomain;
  readonly sql: string;
}

/**
 * One statement per dimension group, written against the `erp-v1` catalog. A
 * future schema version with different table names brings its own list, selected
 * the same way its catalog is — no branching inside these queries.
 */
const ERP_V1_DIMENSIONS: readonly DimensionQuery[] = [
  {
    key: 'academic_years',
    domain: 'students',
    sql: 'SELECT DISTINCT academicyearname FROM students_data_set ORDER BY academicyearname DESC',
  },
  {
    key: 'classes',
    domain: 'students',
    // classseq travels with the label: classes sort by sequence, never
    // alphabetically, or X lands before IX (catalog rule, schema/erp-v1.ts).
    sql: 'SELECT DISTINCT classname, classseq FROM students_data_set ORDER BY classseq',
  },
  {
    key: 'sections',
    domain: 'students',
    sql: 'SELECT DISTINCT sectionname FROM students_data_set ORDER BY sectionname',
  },
  {
    key: 'student_types',
    domain: 'students',
    sql: 'SELECT DISTINCT studenttype FROM students_data_set ORDER BY studenttype',
  },
  {
    key: 'fee_categories',
    domain: 'fees',
    sql: 'SELECT DISTINCT feecategory FROM fee_compile_data_set ORDER BY feecategory',
  },
  {
    key: 'fee_components',
    domain: 'fees',
    sql: 'SELECT DISTINCT componentname FROM fee_compile_data_set ORDER BY componentname',
  },
  {
    key: 'departments',
    domain: 'staff',
    sql: 'SELECT DISTINCT departmentname FROM employees_data_set ORDER BY departmentname',
  },
  {
    key: 'designations',
    domain: 'staff',
    sql: 'SELECT DISTINCT designationname FROM employees_data_set ORDER BY designationname',
  },
];

const DIMENSIONS_BY_VERSION: Readonly<Record<string, readonly DimensionQuery[]>> = {
  'erp-v1': ERP_V1_DIMENSIONS,
};

interface CacheEntry {
  payload: unknown;
  loadedAt: number;
}

/**
 * Keyed by school AND permission class. The values themselves are not PII, but
 * WHICH groups a response contains depends on the caller's permissions — the
 * reasoning ADR-028 gives for `permission_class` in the result-cache key, applied
 * to a smaller cache. Without it, an accountant would be served a Principal's
 * cached class list.
 */
const cache = new Map<string, CacheEntry>();

export async function getDimensions(
  context: ToolContext,
  args: { school_id: string },
): Promise<ReturnType<typeof ok>> {
  const [schoolId] = await requireInScope(context, [args.school_id], TOOL);
  if (schoolId === undefined) throw new Error('unreachable: scope check returned no school');

  const cacheKey = `${schoolId}|${context.call.permission_class}`;
  const cached = cache.get(cacheKey);
  if (
    cached !== undefined &&
    (Date.now() - cached.loadedAt) / 1000 < config.DIMENSIONS_CACHE_TTL_SECONDS
  ) {
    return ok(cached.payload);
  }

  const target = await resolveConnectionTarget(schoolId);
  const queries = DIMENSIONS_BY_VERSION[target.tenant.schema_version] ?? [];

  const dimensions: Record<string, unknown> = {};
  const omitted: { group: string; requires: string }[] = [];

  for (const query of queries) {
    const required = DOMAIN_PERM[query.domain];
    if (required !== null && !context.call.perms.includes(required)) {
      omitted.push({ group: query.key, requires: required });
      continue;
    }
    const outcome = await runScopedSelect({
      context,
      schoolId,
      sql: query.sql,
      tool: TOOL,
    });
    // Single-column groups flatten to a plain list; multi-column ones (classes,
    // which carry classseq for ordering) stay as objects.
    dimensions[query.key] =
      outcome.columns.length === 1
        ? outcome.rows
            .map((row) => row[outcome.columns[0]!])
            .filter((value) => value !== null && value !== '')
        : [...outcome.rows];
  }

  const payload = {
    school_id: schoolId,
    schema_version: target.tenant.schema_version,
    dimensions,
    /**
     * Named, not hidden. A model that cannot see fee heads has to know that it
     * cannot, rather than concluding the school has none (§10).
     */
    omitted_groups: omitted,
  };

  cache.set(cacheKey, { payload, loadedAt: Date.now() });
  return ok(payload);
}

export function clearDimensionCache(): void {
  cache.clear();
}
