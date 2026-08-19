/**
 * Dev signing keys for the stub ERP.
 *
 * The real ERP owns its private key and publishes only the public half at a
 * JWKS endpoint (docs/02 §2, ADR-003). Asymmetric signing is the point: the
 * platform never holds a shared secret, so nothing it stores can forge a token.
 * This file plays the ERP's side of that arrangement locally.
 *
 * Generated on first run into .keys/, which is git-ignored. A dev keypair that
 * never exists in the repo cannot be committed by accident -- and per
 * CODING_GUIDELINES §12 no key material may reach this repository at all.
 */

import { generateKeyPair, exportJWK, importJWK, type JWK, type KeyLike } from 'jose';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const keyDir = join(here, '..', '.keys');
const keyFile = join(keyDir, 'signing-key.json');

/** RS256, as fixed by ADR-003. */
const ALG = 'RS256';

interface StoredKeys {
  /** Key id. Present so key rotation is demonstrable, as docs/02 §6 requires. */
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

async function generate(): Promise<StoredKeys> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  const kid = `erp-stub-${new Date().toISOString().slice(0, 10)}`;
  return {
    kid,
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg: ALG, use: 'sig' },
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: ALG, use: 'sig' },
  };
}

function load(): StoredKeys | null {
  if (!existsSync(keyFile)) return null;
  return JSON.parse(readFileSync(keyFile, 'utf8')) as StoredKeys;
}

/** Load the dev keypair, generating and persisting one on first run. */
export async function getKeys(): Promise<{
  kid: string;
  privateKey: KeyLike | Uint8Array;
  publicJwk: JWK;
}> {
  let stored = load();
  if (stored === null) {
    stored = await generate();
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(keyFile, JSON.stringify(stored, null, 2));
    console.log(`[erp-stub] generated a new dev signing key (kid=${stored.kid})`);
  }
  return {
    kid: stored.kid,
    privateKey: await importJWK(stored.privateJwk, ALG),
    publicJwk: stored.publicJwk,
  };
}

/**
 * The JWKS document served at /.well-known/jwks.json.
 *
 * A real ERP publishes several keys during rotation, so the orchestrator must
 * select by `kid` rather than assuming one key. Serving an array of one keeps
 * that code path honest from the start (docs/02 §6: "keys cached with rotation
 * grace").
 */
export function jwks(publicJwk: JWK): { keys: JWK[] } {
  return { keys: [publicJwk] };
}
