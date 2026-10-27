/** P001 real PG principal-cache boundary capture, not host dispatch/RLS proof. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const seams = vi.hoisted(() => ({ sql: null as Sql | null, listener: null as Sql | null,
  enabled: true, ready: false, notifications: [] as string[] }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: seams.sql }),
  getOrgPgListener: () => ({ sql: seams.enabled ? {
    listen: async (channel: string, callback: (payload: string) => void) => {
      const handle = await seams.listener!.listen(channel, payload => {
        seams.notifications.push(payload); callback(payload);
      });
      seams.ready = true;
      return handle;
    },
  } : {} }),
  withWorkspace: async (workspace: string, callback: (tx: unknown) => Promise<unknown>) =>
    seams.sql!.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx);
    }),
}));
import { resolveBearer, _resetAuthCacheForTests, _authCacheTuning,
  PRINCIPAL_INVALIDATE_CHANNEL } from '../../../../agent-mcp/src/auth';

const WS = 'p001-cache-boundaries';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const sources = ['packages/operator-core/lib/agent-tools/memory/principal-cache-source-freshness.integration.test.ts',
  'packages/agent-mcp/src/auth.ts'];
const pin = () => sources.map(path => ({ path,
  sha256: sha(readFileSync(new URL('../../../../../' + path, import.meta.url))) }));
const receipts: unknown[] = [];
const completed: string[] = [];
let pins: ReturnType<typeof pin>;
let db: FreshPgDb;
let listener: Sql;
let token: string;

async function caps() {
  const principal = await resolveBearer(token);
  const value = principal ? [...principal.capabilities].sort() : null;
  receipts.push({ phase: 'reader', capabilities: value, at: Date.now() });
  return value;
}
async function writer(notify: boolean, rollback = false) {
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
    "import postgres from 'postgres'; const sql=postgres(process.env.P001_DB,{max:1,prepare:false}); " +
    "try { try { await sql.begin(async tx=>{ await tx`UPDATE harness_shared.pi_sessions " +
    "SET capabilities='[]'::jsonb WHERE session_id='cache-reader'`; " +
    "if(process.env.P001_NOTIFY==='yes') await tx`SELECT pg_notify(${process.env.P001_CHANNEL},${JSON.stringify({workspace_id:'p001-cache-boundaries',slug:'pi:cache-reader'})})`; " +
    "if(process.env.P001_ROLLBACK==='yes') throw new Error('intentional-rollback'); }); " +
    "} catch(e) { if(e.message!=='intentional-rollback') throw e; } " +
    "console.log(JSON.stringify({pid:process.pid,committed:process.env.P001_ROLLBACK!=='yes'})); " +
    "} finally {await sql.end();}"], { timeout: 30_000,
    env: { ...process.env, P001_DB: db.url, P001_CHANNEL: PRINCIPAL_INVALIDATE_CHANNEL,
      P001_NOTIFY: notify ? 'yes' : 'no', P001_ROLLBACK: rollback ? 'yes' : 'no' } });
  expect(result.stderr).toBe('');
  const receipt = JSON.parse(result.stdout.trim());
  expect(receipt.pid).not.toBe(process.pid);
  expect(receipt.committed).toBe(!rollback);
  receipts.push({ phase: 'writer', notify, rollback, ...receipt, readerPid: process.pid });
}

beforeAll(async () => {
  pins = pin();
  db = await createFreshPgDb('p001-principal-cache');
  seams.sql = db.sql;
  listener = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  seams.listener = listener;
  await db.sql.unsafe(`CREATE TABLE harness_shared.token_index
    (token text PRIMARY KEY,kind text,harness_slug text,workspace_id text);
    CREATE TABLE harness_shared.pi_sessions (workspace_id text,session_id text,bearer_hash text,
      capabilities jsonb,allowed_tools jsonb,ended_at timestamptz,expires_at timestamptz);`);
}, 60_000);
beforeEach(async () => {
  vi.restoreAllMocks();
  await _resetAuthCacheForTests();
  seams.enabled = true; seams.ready = false; seams.notifications.length = 0;
  token = randomUUID();
  await db.sql.unsafe('TRUNCATE harness_shared.token_index,harness_shared.pi_sessions');
  await db.sql`INSERT INTO harness_shared.token_index VALUES (${token},'pi','pi:cache-reader',${WS})`;
  await db.sql`INSERT INTO harness_shared.pi_sessions VALUES
    (${WS},'cache-reader',${sha(token)},${db.sql.json(['memory:search:read'])},NULL,NULL,now()+interval '1 hour')`;
});

describe('P001 persisted principal cache freshness boundaries', () => {
  it('observes a separate-process committed NOTIFY and reloads changed capabilities before TTL', async () => {
    expect(await caps()).toEqual(['memory:search:read']);
    await expect.poll(() => seams.ready, { timeout: 10_000 }).toBe(true);
    await writer(true);
    await expect.poll(() => seams.notifications.length, { timeout: 10_000 }).toBe(1);
    expect(await caps()).toEqual([]);
    expect(JSON.parse(seams.notifications[0])).toEqual({ workspace_id: WS, slug: 'pi:cache-reader' });
    completed.push('notify-commit');
  }, 40_000);

  it('does not invalidate from a rolled-back writer transaction and receives its next committed notification', async () => {
    expect(await caps()).toEqual(['memory:search:read']);
    await expect.poll(() => seams.ready, { timeout: 10_000 }).toBe(true);
    await writer(true, true);
    const [row] = await db.sql`SELECT capabilities FROM harness_shared.pi_sessions WHERE session_id='cache-reader'`;
    expect(row.capabilities).toEqual(['memory:search:read']);
    expect(await caps()).toEqual(['memory:search:read']);
    expect(seams.notifications).toEqual([]);
    await writer(true);
    await expect.poll(() => seams.notifications.length, { timeout: 10_000 }).toBe(1);
    expect(await caps()).toEqual([]);
    completed.push('notify-rollback');
  }, 40_000);

  it('retains the measured positive TTL then refreshes after its clock boundary when LISTEN is unavailable', async () => {
    seams.enabled = false;
    const start = Date.now();
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect(await caps()).toEqual(['memory:search:read']);
    await writer(false);
    now = start + _authCacheTuning.ttlMs - 1;
    expect(await caps()).toEqual(['memory:search:read']);
    now = start + _authCacheTuning.ttlMs + 1;
    expect(await caps()).toEqual([]);
    vi.restoreAllMocks();
    completed.push('positive-ttl');
  }, 40_000);
});
afterAll(async () => {
  vi.restoreAllMocks();
  const after = pin();
  let cleanup = 'not-attempted';
  try {
    expect(after).toEqual(pins);
    expect([...completed].sort()).toEqual(['notify-commit', 'notify-rollback', 'positive-ttl'].sort());
  } finally {
    await _resetAuthCacheForTests();
    await listener?.end({ timeout: 5 });
    try { await db?.cleanup(); cleanup = 'dropped'; }
    finally { if (process.env.PAPERCUSP_P001_CACHE_CAPTURE_OUT) writeFileSync(process.env.PAPERCUSP_P001_CACHE_CAPTURE_OUT,
      JSON.stringify({ sourcePins: pins, sourceStable: JSON.stringify(after) === JSON.stringify(pins), cleanup,
        completed, receipts, notifications: seams.notifications, tuning: _authCacheTuning,
        limitations: ['Private admin PG/projected schema; no production RLS or host dispatch.',
          'Actual resolveBearer and dedicated postgres LISTEN; writer uses explicit SQL/pg_notify, not provisioning API.',
          'Positive TTL tested with Date.now seam, not a wall-clock minute; negative TTL/expiry/identity-cache cases remain open.',
          'No UI/full operator runtime/spec binding/provenance upgrade.'] }, null, 2)); }
  }
}, 30_000);
