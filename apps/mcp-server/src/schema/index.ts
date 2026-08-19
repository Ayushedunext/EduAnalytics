/**
 * The live schema catalogs.
 *
 * ADR-014: 3–5 versions are live across the fleet at any time, so this list
 * stays short by design. It is an explicit import list rather than a
 * self-registering module set: with side-effect registration, whether a catalog
 * exists depends on whether some module happened to be imported first, and the
 * failure mode is "this school has no schema document" appearing in one process
 * and not another. Naming them here makes the set a fact of the build.
 *
 * Adding a version (ADR-014's "ERP schema migrations = flipping a registry value
 * per school") is a new file plus one line here.
 */

import type { SchemaCatalog } from './catalog.js';
import { ERP_V1 } from './erp-v1.js';

const CATALOGS: readonly SchemaCatalog[] = [ERP_V1];

const BY_VERSION = new Map(CATALOGS.map((catalog) => [catalog.schema_version, catalog]));

export function getCatalog(schemaVersion: string): SchemaCatalog | undefined {
  return BY_VERSION.get(schemaVersion);
}

export function knownSchemaVersions(): string[] {
  return [...BY_VERSION.keys()];
}

export { ERP_V1 };
export * from './catalog.js';
