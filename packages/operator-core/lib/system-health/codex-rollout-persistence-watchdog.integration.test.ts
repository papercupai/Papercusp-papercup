/** Executes the original watchdog's conflict/rearm and recovery SQL in isolated PostgreSQL. */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { checkCodexRolloutPersistence, codexRolloutConditionKey } from './codex-rollout-persistence-watchdog';

vi.mock('../attention-notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../attention-notify')>()),
  notifyAttention: vi.fn(async () => undefined),
  notifyAttentionOnce: vi.fn(async () => undefined),
}));

const WS = 'codex-watchdog-pg', OWNER = 'codex-owner-pg', ID = 42;
const phase = (kind: 'persistence' | 'provider') =>
  kind === 'persistence' ? 'codex-rollout-stall:42' : 'codex-provider-failure:42';
const key = (kind: 'persistence' | 'provider') => codexRolloutConditionKey(kind, WS, String(ID), OWNER);
let db: FreshPgDb, root: string, history: string, rollout: string;
let previousHome: string | undefined, now: number;
let open: Map<string, number>;
let warn: ReturnType<typeof vi.spyOn>;
const broadcast = vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
  expect(event.oneShot).toBe(true);
  if (!open.has(event.conditionKey!)) open.set(event.conditionKey!, now);
  return true;
});
const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
const options = () => ({ now: () => now, pidAlive: () => true,
  readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
  rail: { broadcast, resolve } });
const pass = () => checkCodexRolloutPersistence(db.sql, options());
const legacy = () => db.sql<Array<{ phase: string; escalation: string | null; workspace_id: string }>>`
  SELECT phase, escalation, workspace_id FROM harness_shared.harness_escalations ORDER BY phase`;

async function writeFailure(): Promise<void> {
  await writeFile(rollout, [1, 2, 3].map(turn => JSON.stringify({ timestamp: new Date(now).toISOString(),
    type: 'event_msg', payload: { type: 'task_complete', status: 'error', turn_id: String(turn),
      error: { codex_error_info: 'usageLimitExceeded', message: 'provider failed' } } })).join('\n') + '\n');
  await utimes(history, new Date(now - 60_000), new Date(now - 60_000));
  await utimes(rollout, new Date(now - 17 * 60_000), new Date(now - 17 * 60_000));
}

async function writeRecovery(): Promise<void> {
  now += 1000;
  await writeFile(rollout, JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg',
    payload: { type: 'task_complete', status: 'completed' } }) + '\n');
  await utimes(history, new Date(now), new Date(now));
  await utimes(rollout, new Date(now), new Date(now));
}

beforeAll(async () => {
  db = await createFreshPgDb('codex-watchdog');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id integer PRIMARY KEY, coord_owner_id text, pid integer, workspace_id text,
      agent text NOT NULL, ended_at timestamptz
    );
    CREATE TABLE harness_shared.harness_escalations (
      harness_slug text NOT NULL, phase text NOT NULL, escalation text,
      mtime_ms bigint NOT NULL, workspace_id text,
      PRIMARY KEY (harness_slug, phase)
    );`);
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  open = new Map(); now = Date.now() + 1000;
  previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  root = await mkdtemp(join(tmpdir(), 'codex-watchdog-pg-'));
  process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
  const day = join(root, 'session-42', 'sessions', '2026', '10', '12');
  await mkdir(day, { recursive: true });
  history = join(root, 'session-42', 'history.jsonl');
  rollout = join(day, 'rollout-original.jsonl');
  await writeFile(history, '{}\n'); await writeFailure();
  await db.sql`TRUNCATE harness_shared.adv_sessions, harness_shared.harness_escalations`;
  await db.sql`INSERT INTO harness_shared.adv_sessions (id, coord_owner_id, pid, workspace_id, agent)
    VALUES (${ID}, ${OWNER}, 123, ${WS}, 'codex')`;
});
afterEach(async () => {
  warn?.mockRestore();
  if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
});

describe('original Codex watchdog SQL (real PostgreSQL)', () => {
  it('refreshes both keyed alarms through a legacy conflict, clears on measured recovery, and rearms', async () => {
    expect(await pass()).toMatchObject({ alarmed: ['42'], providerAlarmed: ['42'],
      providerPreservedSessionIds: ['42'], providerEndedSessionIds: [] });
    expect(warn).toHaveBeenCalled();
    expect([...open.keys()].sort()).toEqual([key('persistence'), key('provider')].sort());
    expect(await legacy()).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: phase('persistence'), escalation: expect.any(String), workspace_id: WS }),
      expect.objectContaining({ phase: phase('provider'), escalation: expect.any(String), workspace_id: WS }),
    ]));
    expect(await pass()).toMatchObject({ alarmed: [], providerAlarmed: [] });
    expect(broadcast).toHaveBeenCalledTimes(4);
    expect(resolve).not.toHaveBeenCalled();

    await writeRecovery();
    expect(await pass()).toMatchObject({ recovered: ['42'], providerRecovered: ['42'] });
    expect(open.size).toBe(0);
    expect((await legacy()).map(row => row.escalation)).toEqual([null, null]);
    expect(await pass()).toMatchObject({ recovered: [], providerRecovered: [] });

    now += 1000; await writeFailure();
    expect(await pass()).toMatchObject({ alarmed: ['42'], providerAlarmed: ['42'] });
    expect((await legacy()).every(row => row.escalation !== null)).toBe(true);
    expect(open.size).toBe(2);
  });

  it('preserves durable and legacy episodes for absent, ended, excluded, or foreign registrations', async () => {
    await pass(); await writeRecovery();
    for (const change of [
      { owner: OWNER, workspace: WS, agent: 'codex', ended: true },
      { owner: OWNER, workspace: WS, agent: 'claude', ended: false },
      { owner: null, workspace: WS, agent: 'codex', ended: false },
      { owner: 'foreign-owner', workspace: WS, agent: 'codex', ended: false },
      { owner: OWNER, workspace: 'foreign-workspace', agent: 'codex', ended: false },
    ]) {
      await db.sql`UPDATE harness_shared.adv_sessions SET coord_owner_id = ${change.owner},
        workspace_id = ${change.workspace}, agent = ${change.agent},
        ended_at = ${change.ended ? new Date(now) : null} WHERE id = ${ID}`;
      await pass();
      expect(resolve, JSON.stringify(change)).not.toHaveBeenCalled();
      expect((await legacy()).every(row => row.escalation !== null)).toBe(true);
      expect(open.size).toBe(2);
    }
    await db.sql`DELETE FROM harness_shared.adv_sessions`;
    await pass();
    expect(resolve).not.toHaveBeenCalled(); expect(open.size).toBe(2);
    expect((await legacy()).every(row => row.escalation !== null)).toBe(true);
  });

  it('does not clear the legacy episode when keyed recovery delivery fails', async () => {
    await pass(); await writeRecovery();
    const failedResolve = vi.fn(async () => false);
    const result = await checkCodexRolloutPersistence(db.sql, { ...options(),
      rail: { broadcast, resolve: failedResolve } });
    expect(failedResolve).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ recovered: [], providerRecovered: [] });
    expect((await legacy()).every(row => row.escalation !== null)).toBe(true);
    expect(open.size).toBe(2);
  });

  it('preserves both episodes when the real candidate query fails', async () => {
    await pass(); await writeRecovery();
    await db.sql`ALTER TABLE harness_shared.adv_sessions RENAME TO adv_sessions_unreadable`;
    try {
      await pass();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('pass failed (non-fatal)'));
      expect(resolve).not.toHaveBeenCalled(); expect(open.size).toBe(2);
      expect((await legacy()).every(row => row.escalation !== null)).toBe(true);
    } finally {
      await db.sql`ALTER TABLE harness_shared.adv_sessions_unreadable RENAME TO adv_sessions`;
    }
  });
});
