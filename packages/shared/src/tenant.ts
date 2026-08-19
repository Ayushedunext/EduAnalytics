/**
 * Tenant registry contract — the platform's copy of the ERP's school topology.
 *
 * Contract source: docs/02 §5 (registry columns) · docs/03 §2 (resolution) ·
 * ADR-005 (sync, not runtime calls) · ADR-013 (registry + secrets + pools).
 *
 * "The registry IS the configuration" (docs/04 §4) — onboarding a school is a
 * data change, not a deployment.
 */

import { z } from 'zod';
import {
  safeDbNameSchema,
  safeHostnameSchema,
  safeIdSchema,
  safeSchemaVersionSchema,
} from './identifiers.js';

/** docs/02 §6: non-active schools are excluded from scope, shown disabled. */
export const TENANT_STATUSES = ['active', 'suspended', 'migrating'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const tenantRegistryRowSchema = z
  .object({
    school_id: safeIdSchema,
    org_id: safeIdSchema,
    school_name: z.string().min(1),
    region: z.string().min(1),
    status: z.enum(TENANT_STATUSES),

    /**
     * [MANDATORY] ADR-009 / CODING_GUIDELINES §9: the REPLICA host, and only
     * ever the replica host. Primary hostnames must never appear in code,
     * config, or this registry — "unaddressable" is the mechanism that turns
     * zero-ERP-load from a policy into a guarantee. There is deliberately no
     * `primary_host` field, and one must not be added.
     */
    replica_host: safeHostnameSchema,

    /**
     * [MANDATORY] Allowlisted because this value is interpolated into SQL as an
     * identifier -- `USE \`db\`` / `FROM \`db\`.students` -- where a bound
     * parameter is not legal syntax. It is the one unavoidable
     * string-concatenation site in the data path, so it is constrained at the
     * point it enters the registry rather than trusted at the point it is used.
     * Always emit it through quoteMySqlIdentifier(), never a raw template.
     */
    db_name: safeDbNameSchema,

    /**
     * Pointer only. Credentials live in AWS Secrets Manager (ADR-013): the
     * registry is a frequently-read topology table and is the wrong store for
     * secrets. Never inline a password here.
     */
    secret_arn: z.string().min(1),

    /** e.g. 'erp-v4.2'. Schema + prompt caches key on this (ADR-014). */
    schema_version: safeSchemaVersionSchema,

    /**
     * Row-level tenant discriminator — docs/02 §5.
     *
     * NULL under the assumed model, where `db_name` separates tenants (docs/03
     * §1). Non-null where a schema version consolidates an org's schools into
     * one database distinguished by a column; the MCP server binds this value
     * into every statement as a PARAMETER.
     *
     * Deliberately NOT `safeIdSchema`: this is a data value compared against a
     * column, never interpolated as an identifier, so identifier-safety rules do
     * not apply to it and imposing them would reject legitimate keys from an ERP
     * that formats them differently.
     *
     * Equally deliberately a separate column rather than an assumed equality
     * with `school_id`. They coincide in the first real dataset, and code that
     * leaned on that coincidence would query the wrong school — silently, and
     * with a plausible-looking answer — on the first deployment where they part.
     */
    tenant_key: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type TenantRegistryRow = z.infer<typeof tenantRegistryRowSchema>;

export const orgRegistryRowSchema = z
  .object({
    org_id: safeIdSchema,
    org_name: z.string().min(1),
    school_count: z.number().int().nonnegative(),
  })
  .strict();

export type OrgRegistryRow = z.infer<typeof orgRegistryRowSchema>;

/** A school is servable iff its row exists and it is active (docs/02 §6). */
export function isServable(row: TenantRegistryRow): boolean {
  return row.status === 'active';
}

/**
 * Resolved tenant handed to the data layer. Carries no credentials — the
 * secret is fetched by ARN at connection time and never travels with the
 * tenant descriptor (ADR-013; CODING_GUIDELINES §12).
 */
export interface ResolvedTenant {
  readonly school_id: string;
  readonly org_id: string;
  readonly replica_host: string;
  readonly db_name: string;
  readonly schema_version: string;
  readonly tenant_key: string | null;
}

export function toResolvedTenant(row: TenantRegistryRow): ResolvedTenant {
  return Object.freeze({
    school_id: row.school_id,
    org_id: row.org_id,
    replica_host: row.replica_host,
    db_name: row.db_name,
    schema_version: row.schema_version,
    tenant_key: row.tenant_key,
  });
}
