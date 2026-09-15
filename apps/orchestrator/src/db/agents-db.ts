/**
 * Drizzle handle for the agent + channel tables, over the SAME platform-DB
 * pool every other orchestrator service already shares
 * (db/platform-db.ts) — this is a second query INTERFACE onto one connection
 * pool, not a second pool. CODING_GUIDELINES §9, decided 2026-09-15.
 */

import { drizzle } from 'drizzle-orm/mysql2';
import * as agentDbSchema from '@sap/agent-graph/db-schema';
import { platformDb } from './platform-db.js';

export const agentsDb = drizzle(platformDb, { schema: agentDbSchema, mode: 'default' });
