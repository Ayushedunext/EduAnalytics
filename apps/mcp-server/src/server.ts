/**
 * MCP server entry point.
 *
 * Contract source: docs/04 §1/§6 · ADR-006.
 *
 * Binds to a private address by default (`MCP_BIND_HOST`, default loopback).
 * docs/04 §1 and docs/08 §9 put this service on a private subnet whose security
 * group admits only the orchestrator, and the bind address is the same rule
 * expressed where a developer will actually notice it: a local run cannot
 * accidentally be reachable from the network.
 */

import { config, contextSecret } from './config.js';
import { auditSink } from './audit.js';
import { assertPlatformDbReachable } from './db/platform-db.js';
import { closeAllPools, livePoolCount, sweepIdlePools } from './db/pools.js';
import { createMcpHttpServer, MCP_PATH } from './http.js';

await assertPlatformDbReachable();
console.log('[mcp] platform DB reachable');

const server = createMcpHttpServer({ audit: auditSink, contextSecret });

/** docs/03 §3: close pools idle beyond the window. Unref'd — housekeeping. */
setInterval(() => {
  void sweepIdlePools()
    .then((closed) => {
      if (closed > 0) {
        console.log(`[mcp] swept ${String(closed)} idle pools (${String(livePoolCount())} live)`);
      }
    })
    .catch((err: unknown) => {
      console.error('[mcp] pool sweep failed:', err);
    });
}, 60_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[mcp] ${signal} — closing pools`);
    void closeAllPools().finally(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  });
}

server.listen(config.MCP_PORT, config.MCP_BIND_HOST, () => {
  console.log(`[mcp] listening on http://${config.MCP_BIND_HOST}:${String(config.MCP_PORT)}${MCP_PATH}`);
  console.log(`[mcp] row cap ${String(config.ROW_CAP)} · timeout ${String(config.QUERY_TIMEOUT_MS)}ms`);
});
