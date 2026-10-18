import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { claimAdvSessionResume, getAdvSessionInWorkspace, latestAdvSessionByCoordOwner } from '../../adv-sessions';
import { makeDelivery } from '../../../test/_multi-session-testbed';
import { executeWake, type ExecuteWakeDeps } from './wake-executor';

// P-023 independent author, green-main P-040: exercise the real executor and
// PostgreSQL election/claim together. No real agent process may be launched.
const WORKSPACE = 'wake-incarnation-fixture';
const OWNER = 'su-wake-incarnation-fixture';
const ORIGINAL_NATIVE = '00000000-0000-4000-8000-000000000001';
const CURRENT_NATIVE = '00000000-0000-4000-8000-000000000002';
let db: OrgTestDb | undefined;
let fixture: BaselineCoordFixture | undefined;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture = await setupBaselineCoordFixture({ dsn: db.adminDsn });
  sql = fixture.admin;
});
afterAll(async () => {
  try { await fixture?.dispose(); }
  finally { await db?.cleanup(); }
});
beforeEach(async () => { await sql`TRUNCATE harness_shared.adv_sessions`; });

async function seed(nativeId: string, ageSeconds: number): Promise<number> {
  const [row] = await sql<Array<{ id: number | string }>>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, cwd, started_at, ended_at, exit_code)
    VALUES (${WORKSPACE}, 'claude', 'console', ${OWNER}, ${nativeId}, ${process.cwd()},
      now() - make_interval(secs => ${ageSeconds}), now(), 0)
    RETURNING id`;
  const id = Number(row.id);
  expect(Number.isSafeInteger(id) && id > 0).toBe(true);
  return id;
}

function delivery(original: number) {
  return makeDelivery({ workspaceId: WORKSPACE, subscriberId: OWNER,
    eventKey: 'fixture:retained-wake', payload: { message: 'Continue the held work.' },
    wakeHandle: { kind: 'adv-session', advSessionId: original, agent: 'claude',
      sessionId: ORIGINAL_NATIVE, cwd: process.cwd(), pid: null },
  });
}

function dependencies(claimResume: NonNullable<ExecuteWakeDeps['claimResume']>) {
  const spawned = vi.fn<NonNullable<ExecuteWakeDeps['spawnDetached']>>(() => 4242);
  const deps: ExecuteWakeDeps = {
    getSession: (id) => getAdvSessionInWorkspace(id, WORKSPACE),
    getLatestSessionForOwner: latestAdvSessionByCoordOwner,
    claimResume,
    resolveWakeModeFn: async () => 'auto',
    getSessionLifecycle: async () => null,
    findPsuHost: async () => null,
    findPty: () => null,
    presence: async () => null,
    alive: () => false,
    spawnDetached: spawned,
    sendCoordMessage: async () => { throw new Error('Unexpected inbox fallback in the resume fixture'); },
    tagTurn: ({ text, origin }) => ({
      taggedText: text, envelope: '', nonce: 'fixture', origin, ledgerWritten: true,
    }),
    collectSessionFiles: async () => [],
    getLoopStatusFn: async () => null,
    accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: () => {} }),
    ensureInboxWakeArmedForActiveSession: async () => true,
    observeFallback: () => {},
  };
  return { deps, spawned };
}

describe('retained wake across real PostgreSQL incarnations', () => {
  it('elects the successor despite a newer mutable timestamp on the predecessor', async () => {
    const original = await seed(ORIGINAL_NATIVE, 3600);
    const current = await seed(CURRENT_NATIVE, 1800);
    await sql`UPDATE harness_shared.adv_sessions SET started_at = now() WHERE id = ${original}`;
    const claim = vi.fn(claimAdvSessionResume);
    const { deps, spawned } = dependencies(claim);

    expect(await executeWake(delivery(original), deps)).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(claim).toHaveBeenCalledWith(current, null, undefined, OWNER);
    expect(spawned).toHaveBeenCalledTimes(1);
    const argv = spawned.mock.calls[0]?.[1];
    expect(argv).toContain(CURRENT_NATIVE);
    expect(argv).not.toContain(ORIGINAL_NATIVE);
    expect(await getAdvSessionInWorkspace(original, WORKSPACE)).toMatchObject({ id: original, endedAt: expect.any(String) });
    expect(await getAdvSessionInWorkspace(current, WORKSPACE)).toMatchObject({ id: current, endedAt: null });
  });

  it('parks when a successor registers after election but before the real resume claim', async () => {
    const original = await seed(ORIGINAL_NATIVE, 3600);
    let current: number | undefined;
    const claim = vi.fn(async (...args: Parameters<typeof claimAdvSessionResume>) => {
      current = await seed(CURRENT_NATIVE, 0);
      return claimAdvSessionResume(...args);
    });
    const { deps, spawned } = dependencies(claim);

    expect(await executeWake(delivery(original), deps)).toMatchObject({
      kind: 'park', reason: expect.stringContaining('was lost or superseded'),
    });
    expect(claim).toHaveBeenCalledWith(original, null, undefined, OWNER);
    expect(spawned).not.toHaveBeenCalled();
    expect(current).toBeTypeOf('number');
    expect(await getAdvSessionInWorkspace(original, WORKSPACE)).toMatchObject({ id: original, endedAt: expect.any(String) });
    expect(await getAdvSessionInWorkspace(current!, WORKSPACE)).toMatchObject({ id: current, endedAt: expect.any(String) });
  });
});
