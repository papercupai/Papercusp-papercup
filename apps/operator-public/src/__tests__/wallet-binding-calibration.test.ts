/** Calibrate the DAO HR hosted SQLite fixture against workerd's local D1.
 * This proves the wallet persistence boundary, not GitHub availability or the
 * complete native hire journey. Neither runtime uses a remote D1 database.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import { createWalletBindingChallenge } from '@papercusp/operator-core/lib/cupboard/wallet-binding';
import { startDaoHrWalletBindingFixture } from '../../../../scripts/fixtures/dao-hr-wallet-binding';
import { walletBindingRoute } from '../routes/wallet-binding';
import { consumeWalletBindingChallenge, getWalletBinding, getWalletBindingChallenge,
  insertWalletBindingChallenge } from '../wallet-binding-store';
import type { Env } from '../env';
import { makeSqliteDb } from './sqlite-d1';

const account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
const other = privateKeyToAccount(`0x${'0'.repeat(63)}2`);
const wallet = account.address.toLowerCase();
const originalFetch = globalThis.fetch;

describe('DAO HR wallet fixture calibration against workerd D1', () => {
  let directory: string;
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'daohr-wallet-d1-calibration-'));
    const configPath = join(directory, 'wrangler.json');
    const shippedConfig = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
    const compatibilityDate = shippedConfig.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
    if (!compatibilityDate) throw new Error('Shipped Worker has no compatibility date');
    writeFileSync(configPath, JSON.stringify({
      name: 'daohr-wallet-calibration', compatibility_date: compatibilityDate,
      d1_databases: [{ binding: 'DB', database_name: 'calibration', database_id: crypto.randomUUID() }],
    }));
    platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath, envFiles: [], persist: false, remoteBindings: false,
    });
    const migrations = new URL('../../migrations/', import.meta.url);
    for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
      // Match Wrangler's local migration execution: D1.exec treats each line
      // as a statement and rejects comments and multiline CREATE statements.
      const statements = unstable_splitSqlQuery(readFileSync(new URL(file, migrations), 'utf8'));
      await platform.env.DB.batch(statements.map(statement => platform!.env.DB.prepare(statement)));
    }
  }, 60_000);

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    try { await platform?.dispose(); }
    finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  });

  it('matches missing and foreign signature refusal, principal scope and one-time binding through the hosted route', async () => {
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'api.github.com') return originalFetch(input, init);
      const token = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        .get('authorization');
      if (token === 'Bearer calibration-owner') return Response.json({ id: 42, login: 'calibration-owner' });
      if (token === 'Bearer calibration-other') return Response.json({ id: 43, login: 'calibration-other' });
      throw new Error('Calibration refuses non-synthetic GitHub credentials');
    });
    const hosted = await startDaoHrWalletBindingFixture();
    try {
      const route = walletBindingRoute();
      const env = { DB: platform!.env.DB, CUPBOARD_HOST: '127.0.0.1' } as Env;
      const boundaries = [
        { name: 'hosted SQLite fixture', request: (path: string, init: RequestInit) => fetch(hosted.url + path, init) },
        { name: 'workerd D1', request: (path: string, init: RequestInit) => Promise.resolve(route.request('http://127.0.0.1' + path, init, env)) },
      ];
      for (const boundary of boundaries) {
        const headers = { Authorization: 'Bearer calibration-owner', 'Content-Type': 'application/json' };
        const json = (body: unknown): RequestInit => ({ method: 'POST', headers, body: JSON.stringify(body) });
        const issued = await boundary.request('/commerce/wallet-bindings/challenges', json({ walletAddress: wallet }));
        expect(issued.status, boundary.name).toBe(201);
        const challenge = await issued.json() as { challengeId: string; message: string };
        expect(challenge.message).toContain('urn:papercusp:principal:gh:42');
        const verify = (signature: string, init?: RequestInit) => boundary.request('/commerce/wallet-bindings',
          { ...json({ challengeId: challenge.challengeId, signature }), ...init });
        expect((await verify('')).status, boundary.name).toBe(422);
        const foreign = await verify(await other.signMessage({ message: challenge.message }));
        expect(foreign.status, boundary.name).toBe(422);
        expect(await foreign.json()).toMatchObject({ error: 'address_mismatch' });
        expect(await (await boundary.request('/commerce/wallet-bindings/me', { headers })).json())
          .toMatchObject({ bound: false, binding: null });
        const signature = await account.signMessage({ message: challenge.message });
        expect((await verify(signature, { headers: { ...headers, Authorization: 'Bearer calibration-other' } })).status)
          .toBe(404);
        const accepted = await verify(signature);
        expect(accepted.status, boundary.name).toBe(201);
        expect(await accepted.json()).toMatchObject({ bound: true, rotated: false,
          binding: { walletAddress: wallet, challengeId: challenge.challengeId } });
        const replay = await verify(signature);
        expect(replay.status, boundary.name).toBe(409);
        expect(await replay.json()).toMatchObject({ error: 'challenge_already_used' });
        expect(await (await boundary.request('/commerce/wallet-bindings/me', { headers })).json())
          .toMatchObject({ bound: true, binding: { walletAddress: wallet, challengeId: challenge.challengeId } });
      }
    } finally { await hosted.stop(); }
  }, 60_000);

  it('matches D1 atomic rollback and concurrent same-millisecond challenge consumption', async () => {
    const sqlite = makeSqliteDb();
    try {
      for (const db of [sqlite.db, platform!.env.DB]) {
        await db.prepare('DELETE FROM wallet_bindings').run();
        await db.prepare('DELETE FROM wallet_binding_challenges').run();
        const nowMs = Date.now();
        const challenge = (principalId: string) => createWalletBindingChallenge({
          principalId, walletAddress: wallet, chainId: 1, domain: '127.0.0.1',
          nowMs,
        });
        const first = challenge('gh:42');
        await insertWalletBindingChallenge(db, first);
        const results = await Promise.all(['winner-a', 'winner-b'].map(consumeToken =>
          consumeWalletBindingChallenge(db, { challengeId: first.challengeId, principalId: 'gh:42',
            walletAddress: wallet, nowMs, consumeToken })));
        expect(results.filter(result => result.ok)).toHaveLength(1);
        expect(results.filter(result => !result.ok)).toEqual([{ ok: false, code: 'challenge_already_used' }]);
        const consumed = await getWalletBindingChallenge(db, first.challengeId, 'gh:42');
        expect(consumed?.consumedToken).toBe(['winner-a', 'winner-b'][results.findIndex(result => result.ok)]);
        expect(await getWalletBinding(db, 'gh:42')).toMatchObject({ walletAddress: wallet, challengeId: first.challengeId });
        const conflicting = challenge('gh:43');
        await insertWalletBindingChallenge(db, conflicting);
        expect(await consumeWalletBindingChallenge(db, { challengeId: conflicting.challengeId,
          principalId: 'gh:43', walletAddress: wallet, nowMs, consumeToken: 'collision' }))
          .toEqual({ ok: false, code: 'wallet_already_bound' });
        expect(await getWalletBindingChallenge(db, conflicting.challengeId, 'gh:43'))
          .toMatchObject({ consumedAtMs: null, consumedToken: null });
        expect(await getWalletBinding(db, 'gh:43')).toBeNull();
      }
    } finally { sqlite.raw.close(); }
  }, 60_000);
});
