/**
 * Tests for POST /api/admin/spawn-signing/rotate.
 *
 * Rotation is a deliberate global revocation. The HTTP exercise is therefore
 * opt-in and requires an explicitly named isolated operator, bearer, and DB.
 * It must never infer :3070/:3170 or reuse the developer's superuser token.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/admin-rotate.mjs.
 *
 *   - 401 without bearer / wrong bearer
 *   - 200 with correct bearer
 *   - Old signed URL fails after rotation (invalid_signature)
 *   - New signed URL (signed AFTER rotation) succeeds
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { Client } from 'pg';

interface IsolatedTarget {
  baseUrl: string;
  bearer: string;
  databaseUrl: string;
}

const SHARED_OPERATOR_PORTS = new Set(['3055', '3070', '3170']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function resolveIsolatedTarget(env: NodeJS.ProcessEnv): IsolatedTarget | null {
  const rawUrl = env.PAPERCUSP_TEST_ISOLATED_OPERATOR_URL?.trim();
  if (!rawUrl) return null;

  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || !url.port || Number(url.port) < 1024) {
    throw new Error('rotation integration target must be an explicit loopback HTTP service on a high port');
  }
  if (SHARED_OPERATOR_PORTS.has(url.port)) {
    throw new Error('rotation integration test refuses shared Papercusp operator ports');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('rotation integration target must be a bare local origin without credentials');
  }

  const bearer = env.PAPERCUSP_TEST_ISOLATED_OPERATOR_BEARER?.trim();
  const databaseUrl = env.PAPERCUSP_TEST_ISOLATED_DATABASE_URL?.trim();
  if (!bearer || !databaseUrl) {
    throw new Error('isolated rotation test requires its own bearer and database URL');
  }

  const database = new URL(databaseUrl);
  const databaseName = decodeURIComponent(database.pathname.slice(1));
  const databaseHost = database.hostname.replace(/^\[|\]$/g, '');
  const databasePort = database.port || '5432';
  if (
    LOOPBACK_HOSTS.has(databaseHost) &&
    (databasePort === '5432' || databasePort === '5433') &&
    databaseName === 'papercusp'
  ) {
    throw new Error('rotation integration test refuses the shared papercusp database');
  }

  return { baseUrl: url.origin, bearer, databaseUrl };
}

const target = resolveIsolatedTarget(process.env);
const itIsolated = target ? it : it.skip;

describe('admin rotate integration target isolation', () => {
  it('does not infer a live target from OP_PORT or the home token', () => {
    expect(resolveIsolatedTarget({ OP_PORT: '3070' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it.each(['3055', '3070', '3170'])('refuses shared Papercusp port %s', (port) => {
    expect(() => resolveIsolatedTarget({
      PAPERCUSP_TEST_ISOLATED_OPERATOR_URL: 'http://localhost:' + port,
      PAPERCUSP_TEST_ISOLATED_OPERATOR_BEARER: 'test-only',
      PAPERCUSP_TEST_ISOLATED_DATABASE_URL: 'postgresql://localhost:55432/papercusp_test',
    } as NodeJS.ProcessEnv)).toThrow('rotation integration test refuses shared Papercusp operator ports');
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('refuses the shared local papercusp database via %s', (host) => {
    expect(() => resolveIsolatedTarget({
      PAPERCUSP_TEST_ISOLATED_OPERATOR_URL: 'http://localhost:39001',
      PAPERCUSP_TEST_ISOLATED_OPERATOR_BEARER: 'test-only',
      PAPERCUSP_TEST_ISOLATED_DATABASE_URL: 'postgresql://' + host + ':5432/papercusp',
    } as NodeJS.ProcessEnv)).toThrow('rotation integration test refuses the shared papercusp database');
  });

  it('accepts an explicitly configured isolated loopback target', () => {
    expect(resolveIsolatedTarget({
      PAPERCUSP_TEST_ISOLATED_OPERATOR_URL: 'http://localhost:39001',
      PAPERCUSP_TEST_ISOLATED_OPERATOR_BEARER: 'test-only',
      PAPERCUSP_TEST_ISOLATED_DATABASE_URL: 'postgresql://localhost:55432/papercusp_test',
    } as NodeJS.ProcessEnv)).toEqual({
      baseUrl: 'http://localhost:39001',
      bearer: 'test-only',
      databaseUrl: 'postgresql://localhost:55432/papercusp_test',
    });
  });
});

// ── Signing helpers (inlined; mirror admin-rotate.mjs) ──────────────
const SIGNED = new Set(['harness','workspace','role','run','spawn','feature','chunk','parent_spawn','exp']);
function canonical(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of params.entries()) {
    if (k === 'sig' || !SIGNED.has(k)) continue;
    pairs.push([k, v]);
  }
  pairs.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
  return pairs.map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
function sign(params: URLSearchParams, key: Buffer, ttlSec = 3600): void {
  params.delete('sig');
  params.set('exp', String(Math.floor(Date.now()/1000) + ttlSec));
  const sig = createHmac('sha256', key).update(canonical(params)).digest('base64url');
  params.set('sig', sig);
}
function freshParams(role = 'operator'): URLSearchParams {
  const p = new URLSearchParams();
  p.set('harness', 'sheets');
  p.set('workspace', 'default');
  p.set('role', role);
  p.set('run', 'r_admin_' + Date.now());
  p.set('spawn', 's_admin_' + randomBytes(4).toString('hex'));
  return p;
}
async function callMcp(params: URLSearchParams, payload: unknown) {
  if (!target) throw new Error('isolated operator target is not configured');
  const r = await fetch(`${target.baseUrl}/api/mcp?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    // 30s, not 10s: these are behavioral assertions, not latency SLAs.
    signal: AbortSignal.timeout(30000),
  });
  return { status: r.status, text: await r.text() };
}
async function readKey(): Promise<Buffer> {
  if (!target) throw new Error('isolated database is not configured');
  const client = new Client({ connectionString: target.databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ value_b64: string }>(
      'SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = $1',
      ['spawn-signing-key'],
    );
    if (!result.rows[0]) throw new Error('isolated database has no spawn-signing-key row');
    return Buffer.from(result.rows[0].value_b64, 'base64');
  } finally {
    await client.end();
  }
}

async function cleanup(pattern: string) {
  if (!target) return;
  const client = new Client({ connectionString: target.databaseUrl });
  await client.connect();
  try {
    await client.query(
      'DELETE FROM harness_shared.spawn_sig_verification_failures WHERE claimed_spawn LIKE $1',
      [pattern],
    );
  } catch (e) {
    console.warn(`[test cleanup] ${e instanceof Error ? e.message : e}`);
  } finally {
    await client.end();
  }
}

describe('POST /api/admin/spawn-signing/rotate', () => {
  afterAll(async () => cleanup('s_admin_%'));

  // Loopback requests resolve the loopback principal (trust 'unverified-loopback');
  // the route requires trust:['trusted'] → 403 per require-principal.ts's
  // documented contract (no-principal→401, wrong-trust→403). 401 is only for a
  // non-loopback request with no/invalid bearer.
  itIsolated('no auth (loopback principal, wrong trust) → 403', async () => {
    const r = await fetch(`${target!.baseUrl}/api/admin/spawn-signing/rotate`, { method: 'POST' });
    expect(r.status).toBe(403);
  });

  itIsolated('wrong bearer (falls back to loopback, wrong trust) → 403', async () => {
    const r = await fetch(`${target!.baseUrl}/api/admin/spawn-signing/rotate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong_token_xxxxxxx' },
    });
    expect(r.status).toBe(403);
  });

  itIsolated('pre-rotate sig accepted, then rotate, then old sig rejected, new sig accepted', async () => {
    const initialKey = await readKey();

    // Pre-rotate: sign + verify it works
    const preParams = freshParams('operator');
    sign(preParams, initialKey);
    const pre = await callMcp(preParams, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(pre.text).toContain('"result"');

    // Rotate
    const rotateRes = await fetch(`${target!.baseUrl}/api/admin/spawn-signing/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target!.bearer}` },
    });
    expect(rotateRes.status).toBe(200);
    const rotateBody = await rotateRes.json();
    expect(typeof (rotateBody as any).rotatedAt).toBe('string');

    // Old URL now fails
    const postOld = await callMcp(preParams, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(postOld.text).toContain('invalid_signature');

    // New key from PG works
    const newKey = await readKey();
    expect(newKey.equals(initialKey)).toBe(false);

    const newParams = freshParams('operator');
    sign(newParams, newKey);
    const postNew = await callMcp(newParams, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autoloop:control', arguments: { op: 'resume' } } });
    expect(postNew.text).toContain('"result"');
  });
});
