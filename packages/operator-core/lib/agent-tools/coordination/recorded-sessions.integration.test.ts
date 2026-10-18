/**
 * recorded-sessions.integration.test.ts — the `listRecordedLiveSessions` SQL
 * against REAL Postgres (the shared baseline-schema DB via the coord fixture)
 * (presence-derive-from-session-log-2026-06-22 P-001).
 *
 * The pure projection (synthesizeRecordedRosterRows) is unit-tested; this guards
 * the IO seam — the recency bound, the ended_at / coord_owner_id / workspace
 * filters, and the per-owner dedup — end-to-end, through the module's own
 * getOrgPg() handle. Explicitly covers claude + codex + omp recorded sessions
 * (the owner's "works for codex and omp" requirement) since those CLIs weren't
 * present to live-test when the fix landed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { hostname } from 'node:os';
import type postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import {
  acquireAdvSessionResume,
  advSessionsByCoordOwner,
  claimAdvSessionResume,
  finalizeAdvSessionResume,
  getLatestActiveAdvSessionByOwner,
  latestAdvSessionByCoordOwner,
  listRecordedLiveSessions,
  reactivateAdvSessionByOwner,
  releaseAdvSessionResume,
} from '../../adv-sessions';
import { resolveSessionStates } from './liveness-oracle';
import { getPresence, probeProcessLiveness } from './presence';
import { liveAssigneeProbe, liveSettledProbe } from '../../work-items-events';

let fx: BaselineCoordFixture | null = null;
let admin: postgres.Sql;

const WS = `rec-ws-${randomBytes(6).toString('hex')}`;
const OTHER_WS = `${WS}-other`;

async function cleanOwnedRows(): Promise<void> {
  await admin`
    DELETE FROM harness_shared.agent_launch_idempotency
     WHERE workspace_id IN (${WS}, ${OTHER_WS})`;
  await admin`
    DELETE FROM harness_shared.adv_sessions
     WHERE workspace_id IN (${WS}, ${OTHER_WS})`;
}

async function seedAdv(opts: {
  coordOwnerId: string | null;
  workspaceId?: string;
  agent?: string;
  mode?: 'omp' | 'console';
  role?: string | null;
  label?: string | null;
  startedAgoSec?: number;
  ended?: boolean;
  pid?: number | null;
  display?: string | null;
}): Promise<void> {
  await admin`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, role, label, coord_owner_id, started_at, ended_at, pid, display)
    VALUES (
      ${opts.workspaceId ?? WS}, ${opts.agent ?? 'claude'}, ${opts.mode ?? 'console'},
      ${opts.role ?? null}, ${opts.label ?? null}, ${opts.coordOwnerId},
      now() - ${`${opts.startedAgoSec ?? 60} seconds`}::interval,
      ${opts.ended ? new Date() : null}, ${opts.pid ?? null}, ${opts.display ?? null}
    )
  `;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});

describe('WI-10006572 — real recorded reader / absent presence / local OS PID', () => {
  it.each([false, true])('elects the newest registration after predecessor activity is bumped (successor ended=%s)', async (ended) => {
    const ownerId = `s-registration-${WS}-${ended}`;
    await seedAdv({ coordOwnerId: ownerId, startedAgoSec: 7200, pid: 72 });
    await seedAdv({ coordOwnerId: ownerId, startedAgoSec: 3600, pid: 73, ended });
    const rows = await admin`
      SELECT id FROM harness_shared.adv_sessions
       WHERE workspace_id = ${WS} AND coord_owner_id = ${ownerId}
       ORDER BY id ASC`;
    const predecessorId = Number(rows[0].id);
    const successorId = Number(rows[1].id);
    await admin`
      UPDATE harness_shared.adv_sessions SET started_at = now()
       WHERE id = ${predecessorId}`;

    // Resume activity changes started_at, but cannot change registration order.
    expect.soft((await latestAdvSessionByCoordOwner(ownerId))?.id).toBe(successorId);
    expect.soft((await advSessionsByCoordOwner(1, [ownerId])).get(ownerId)?.id).toBe(successorId);
    expect.soft((await advSessionsByCoordOwner(500)).get(ownerId)?.id).toBe(successorId);
    const priorWorkspace = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
    try {
      const active = await getLatestActiveAdvSessionByOwner(ownerId);
      expect.soft(active?.id ?? null).toBe(ended ? null : successorId);
    } finally {
      if (priorWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspace;
    }
  });

  it('targeted latest-per-owner reads retain PID/locality outside the global recent window', async () => {
    const a = `s-hydration-a-${WS}`;
    const b = `s-hydration-b-${WS}`;
    await seedAdv({ coordOwnerId: a, startedAgoSec: 7200, pid: 72, display: 'terminal' });
    await seedAdv({ coordOwnerId: a, startedAgoSec: 3600, pid: 73, display: 'terminal' });
    await seedAdv({ coordOwnerId: b, startedAgoSec: 8000, pid: 74, ended: true });
    const rows = await advSessionsByCoordOwner(2, [a, b]);
    expect([...rows.keys()]).toEqual([a, b]);
    expect(rows.get(a)).toMatchObject({ pid: 73, display: 'terminal' });
    expect(rows.get(b)?.endedAt).not.toBeNull();
    expect((await advSessionsByCoordOwner(500, [])).size).toBe(0);
  });

  it('both hydration paths detect an exited recorded local PID without changing the binding', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid;
    await once(child, 'exit');
    expect(pid).toBeGreaterThan(0);
    expect(probeProcessLiveness({ host: hostname(), pid })).toBe(false);
    const ownerId = `s-hydration-dead-${WS}`;
    await seedAdv({ coordOwnerId: ownerId, startedAgoSec: 3600, pid, display: 'terminal' });
    expect(await getPresence(ownerId)).toBeNull();
    const before = (await advSessionsByCoordOwner(1, [ownerId])).get(ownerId)!;
    const options = {
      fetchWakeabilityFn: async () => new Map([[ownerId, { wakeable: true, liveTurn: false }]]),
      findHostFn: () => null,
    };
    for (const hydration of [{ hydratePerId: true }, { hydrateBatch: true }]) {
      const out = await resolveSessionStates([{ ownerId }], { ...options, ...hydration });
      expect(out.get(ownerId)?.sessionState).toBe('ended');
    }
    const after = (await advSessionsByCoordOwner(1, [ownerId])).get(ownerId)!;
    expect(after).toEqual(before);
    expect(after.endedAt).toBeNull(); // verdict assembly must never write a fake exit
  });

  it('the same dead PID with no host provenance is unknown, never a guessed local death', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid;
    await once(child, 'exit');
    expect(pid).toBeGreaterThan(0);
    expect(probeProcessLiveness({ host: hostname(), pid })).toBe(false);
    const ownerId = `s-hydration-unknown-${WS}`;
    await seedAdv({ coordOwnerId: ownerId, startedAgoSec: 3600, pid });
    const out = await resolveSessionStates([{ ownerId }], {
      hydratePerId: true,
      fetchWakeabilityFn: async () => new Map([[ownerId, { wakeable: false, liveTurn: false }]]),
      findHostFn: () => null,
    });
    expect(out.get(ownerId)).toMatchObject({
      sessionState: null, signalMissing: true, confirmLiveness: true,
    });
  });

  it('bounds the latest session lookup used to stamp an await wake handle', async () => {
    let unlock!: () => void;
    let reportLockAcquired!: () => void;
    const locked = new Promise<void>((resolve) => { reportLockAcquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = admin.begin(async tx => {
      await tx`LOCK TABLE harness_shared.adv_sessions IN ACCESS EXCLUSIVE MODE`;
      reportLockAcquired();
      await release;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await locked;
    const startedAt = Date.now();
    try {
      await expect(latestAdvSessionByCoordOwner(`s-await-lock-${WS}`)).resolves.toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    } finally {
      unlock();
      await blocker;
      warn.mockRestore();
    }
  });

  it('keeps work-item done-key latch probes fail-soft and bounded by their read transaction', async () => {
    let unlock!: () => void;
    let reportLockAcquired!: () => void;
    const locked = new Promise<void>((resolve) => { reportLockAcquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = admin.begin(async tx => {
      await tx`LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE`;
      reportLockAcquired();
      await release;
    });
    await locked;
    const startedAt = Date.now();
    try {
      await expect(liveSettledProbe(`EI-await-lock-${WS}`)).resolves.toEqual({ verdict: 'unknown' });
      await expect(liveAssigneeProbe(`EI-await-lock-${WS}`)).resolves.toEqual({ verdict: 'unknown' });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    } finally {
      unlock();
      await blocker;
    }
  });
});
afterAll(async () => {
  await cleanOwnedRows().catch(() => {});
  if (fx) await fx.dispose();
});
beforeEach(async () => {
  await cleanOwnedRows();
});

describe('listRecordedLiveSessions (real PG)', () => {
  it('surfaces a live recorded session with a coord_owner_id', async () => {
    await seedAdv({ coordOwnerId: 's-live-1', role: 'mug', label: 'hive · papercusp/queen' });
    const rows = await listRecordedLiveSessions({ workspaceId: WS });
    expect(rows.map((r) => r.coordOwnerId)).toEqual(['s-live-1']);
    expect(rows[0].role).toBe('mug');
  });

  it('excludes ended sessions (ended_at IS NOT NULL)', async () => {
    await seedAdv({ coordOwnerId: 's-ended', ended: true });
    await seedAdv({ coordOwnerId: 's-live' });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId);
    expect(owners).toEqual(['s-live']);
  });

  it('excludes rows with a NULL coord_owner_id (unaddressable)', async () => {
    await seedAdv({ coordOwnerId: null });
    await seedAdv({ coordOwnerId: 's-has-owner' });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId);
    expect(owners).toEqual(['s-has-owner']);
  });

  it('excludes sessions older than the recency bound (zombie guard)', async () => {
    await seedAdv({ coordOwnerId: 's-old', startedAgoSec: 7200 });
    await seedAdv({ coordOwnerId: 's-fresh', startedAgoSec: 30 });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS, maxAgeMs: 60_000 })).map((r) => r.coordOwnerId);
    expect(owners).toEqual(['s-fresh']);
  });

  it('filters by workspace when given', async () => {
    await seedAdv({ coordOwnerId: 's-mine', workspaceId: WS });
    await seedAdv({ coordOwnerId: 's-other', workspaceId: OTHER_WS });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId);
    expect(owners).toEqual(['s-mine']);
  });

  it('pushes a targeted owner selector into the live-session read', async () => {
    await seedAdv({ coordOwnerId: 's-target', label: 'target label' });
    await seedAdv({ coordOwnerId: 's-other' });

    const exact = await listRecordedLiveSessions({ workspaceId: WS, ownerIds: ['s-target'] });
    expect(exact.map((r) => r.coordOwnerId)).toEqual(['s-target']);

    const prefix = await listRecordedLiveSessions({ workspaceId: WS, ownerIds: ['target l'] });
    expect(prefix.map((r) => r.coordOwnerId)).toEqual(['s-target']);
  });

  it('dedups to the most-recent row per coord_owner_id', async () => {
    await seedAdv({ coordOwnerId: 's-dup', label: 'older', startedAgoSec: 300 });
    await seedAdv({ coordOwnerId: 's-dup', label: 'newer', startedAgoSec: 10 });
    const rows = await listRecordedLiveSessions({ workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('newer');
  });

  it('is CLI-agnostic — claude, codex AND omp recorded sessions all surface', async () => {
    await seedAdv({ coordOwnerId: 's-claude', agent: 'claude', mode: 'console' });
    await seedAdv({ coordOwnerId: 'su-codex', agent: 'codex', mode: 'console' });
    await seedAdv({ coordOwnerId: 'su-omp', agent: 'omp', mode: 'omp', label: 'su · engineer' });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId).sort();
    expect(owners).toEqual(['s-claude', 'su-codex', 'su-omp']);
  });
});

/**
 * claimAdvSessionResume (EI-21247460909447431) — the single-winner resume claim.
 *
 * The regression this pins: an `ended_at IS NOT NULL`-only predicate cannot
 * claim a row whose process died WITHOUT recording its exit, making such a
 * session permanently un-resumable (the wake parks forever, reporting a race
 * that never happened). That state is the common one, not an edge case.
 */
describe('claimAdvSessionResume (single-winner Channel 2 resume claim)', () => {
  async function seedRow(startedAgo: string, ended: boolean): Promise<number> {
    const rows = await admin`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, coord_owner_id, started_at, ended_at, exit_code, ended_by)
      VALUES (${WS}, 'claude', 'console', ${`s-claim-${Math.random().toString(36).slice(2, 10)}`},
              now() - ${startedAgo}::interval, ${ended ? new Date() : null}, ${ended ? 137 : null},
              ${ended ? 'self' : null})
      RETURNING id`;
    return Number(rows[0].id);
  }

  it('claims a cleanly-ENDED row and makes it live/listable', async () => {
    const id = await seedRow('90 minutes', true);

    expect(await claimAdvSessionResume(id)).toBe(true);

    const [row] = await admin`
      SELECT coord_owner_id, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE id = ${id}`;
    expect(row.ended_at).toBeNull();
    expect(row.exit_code).toBeNull();
    expect(row.ended_by).toBeNull();
    expect(row.ended_signal).toBeNull();
    expect((await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId))
      .toContain(row.coord_owner_id);
  });

  it.each(['legacy unkeyed', 'legacy keyed'] as const)('refuses a retired row for %s resume', async (path) => {
    const id = await seedRow('90 minutes', true);
    await admin`
      UPDATE harness_shared.adv_sessions
         SET retired_at = now(), retired_by = 'fleet:kill:test', retired_reason = 'resume regression test'
       WHERE id = ${id}
    `;
    const [before] = await admin`
      SELECT session_id, started_at, ended_at, exit_code, ended_by, ended_signal,
             retired_at, retired_by, retired_reason, resume_claim_key, resume_claimed_at
        FROM harness_shared.adv_sessions WHERE id = ${id}
    `;

    const key = path === 'legacy keyed' ? `retired-resume-${id}` : null;
    await expect(claimAdvSessionResume(id, key)).resolves.toBe('retired');

    const [after] = await admin`
      SELECT session_id, started_at, ended_at, exit_code, ended_by, ended_signal,
             retired_at, retired_by, retired_reason, resume_claim_key, resume_claimed_at
        FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(after).toEqual(before);
  });

  it('claims a row that was NEVER marked ended (process died without recording its exit)', async () => {
    // The regression: this row is indistinguishable from a live one by ended_at
    // alone, but its process is long gone. It must be resumable.
    const id = await seedRow('2 days', false);
    expect(await claimAdvSessionResume(id)).toBe(true);
  });

  it('LOSES to a resumer that just claimed the same row (single-winner preserved)', async () => {
    // A winning claim bumps started_at to now(), so a second claimant inside the
    // window must lose — this is what stops two writers on one session.
    const id = await seedRow('2 days', false);
    expect(await claimAdvSessionResume(id)).toBe(true);
    expect(await claimAdvSessionResume(id)).toBe(false);
  });

  it('replays the same response key after an unknown transport result without opening a second claim', async () => {
    const id = await seedRow('2 days', false);
    const key = `resume-replay-${Math.random().toString(36).slice(2, 10)}`;

    expect(await claimAdvSessionResume(id, key)).toBe(true);
    expect(await claimAdvSessionResume(id, key)).toBe(true);
    expect(await claimAdvSessionResume(id, `${key}-competitor`)).toBe(false);
  });

  it('repairs and claims a recent half-terminal row carrying ended_by without ended_at', async () => {
    const id = await seedRow('10 seconds', false);
    await admin`
      UPDATE harness_shared.adv_sessions
         SET ended_by = 'self'
       WHERE id = ${id}`;

    expect(await claimAdvSessionResume(id, `resume-half-${id}`)).toBe(true);
    const [row] = await admin`
      SELECT ended_at, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE id = ${id}`;
    expect(row.ended_at).toBeNull();
    expect(row.ended_by).toBeNull();
    expect(row.ended_signal).toBeNull();
  });

  it('returns false for an unknown id', async () => {
    expect(await claimAdvSessionResume(99999999)).toBe(false);
  });

  it.each([
    ['legacy unkeyed', false, false],
    ['legacy keyed', true, false],
    ['owner unkeyed', false, true],
    ['owner keyed', true, true],
  ] as const)('%s does not reactivate a superseded row even after its started_at was bumped', async (_label, keyed, explicitOwner) => {
    const ownerId = `s-claim-current-${randomBytes(6).toString('hex')}`;
    const [predecessor] = await admin`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, coord_owner_id, started_at, ended_at, exit_code, ended_by)
      VALUES (${WS}, 'claude', 'console', ${ownerId}, now() - interval '3 days', now() - interval '2 days', 137, 'signal')
      RETURNING id`;
    const [successor] = await admin`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, coord_owner_id, started_at, ended_at, exit_code, ended_by)
      VALUES (${WS}, 'claude', 'console', ${ownerId}, now() - interval '2 days', NULL, NULL, NULL)
      RETURNING id`;

    // A delayed legacy resumer may already have bumped the predecessor. A
    // mutable activity timestamp must not make that row the latest incarnation.
    await admin`
      UPDATE harness_shared.adv_sessions SET started_at = now()
       WHERE id = ${Number(predecessor.id)}`;
    const key = keyed ? `superseded-${predecessor.id}` : null;
    const expectedOwner = explicitOwner ? ownerId : null;
    expect(await claimAdvSessionResume(Number(predecessor.id), key, undefined, expectedOwner)).toBe(false);
    expect(await claimAdvSessionResume(Number(successor.id), key, undefined, expectedOwner)).toBe(true);

    const [oldRow] = await admin`
      SELECT ended_at, ended_by
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${WS} AND id = ${Number(predecessor.id)}`;
    expect(oldRow.ended_at).not.toBeNull();
    expect(oldRow.ended_by).toBe('signal');
  });

  it('does not replay a successful keyed predecessor claim after a successor registers', async () => {
    const predecessorId = await seedRow('2 days', false);
    const key = `superseded-replay-${predecessorId}`;
    expect(await claimAdvSessionResume(predecessorId, key)).toBe(true);
    const [predecessor] = await admin`
      SELECT coord_owner_id FROM harness_shared.adv_sessions WHERE id = ${predecessorId}`;
    await seedAdv({ coordOwnerId: predecessor.coord_owner_id, startedAgoSec: 60 });

    expect(await claimAdvSessionResume(predecessorId, key)).toBe(false);
  });
});

/**
 * P-001/P-005 — a resume reservation is not liveness. The shared reservation
 * protocol is backend-neutral: Claude, OMP, and Codex all acquire the same
 * adv-session lease before their backend-specific argv is constructed.
 */
describe('explicit resume reservation lifecycle (lossless handoff)', () => {
  async function seedEnded(agent: 'claude' | 'omp' | 'codex'): Promise<{
    id: number;
    sessionId: string;
    cwd: string;
  }> {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sessionId = `native-${agent}-${suffix}`;
    const cwd = `/tmp/resume-${agent}-${suffix}`;
    const rows = await admin`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, coord_owner_id, session_id, cwd,
         started_at, ended_at, exit_code, ended_by)
      VALUES (${WS}, ${agent}, ${agent === 'omp' ? 'omp' : 'console'},
              ${`s-reservation-${agent}-${suffix}`}, ${sessionId}, ${cwd},
              now() - interval '10 minutes', now(), 130, 'self')
      RETURNING id`;
    return { id: Number(rows[0].id), sessionId, cwd };
  }

  it.each(['claude', 'omp', 'codex'] as const)(
    '%s stays ended while reserved and becomes live only after finalize',
    async (agent) => {
      const { id, sessionId, cwd } = await seedEnded(agent);
      const key = `resume-${agent}-${id}`;

      const acquired = await acquireAdvSessionResume(id, key, 60);
      expect(acquired).toMatchObject({ status: 'acquired', acquired: true });

      const [reserved] = await admin`
        SELECT ended_at, exit_code, resume_claim_key, resume_claimed_at
          FROM harness_shared.adv_sessions
         WHERE id = ${id}`;
      expect(reserved.ended_at).not.toBeNull();
      expect(reserved.exit_code).toBe(130);
      expect(reserved.resume_claim_key).toBe(key);
      expect(reserved.resume_claimed_at).not.toBeNull();

      expect(await finalizeAdvSessionResume(id, key)).toBe(true);
      // A response lost after commit replays the durable finalize receipt.
      expect(await finalizeAdvSessionResume(id, key)).toBe(true);
      const [live] = await admin`
        SELECT ended_at, exit_code, ended_by, ended_signal, session_id, cwd,
               resume_claim_key, resume_claimed_at
          FROM harness_shared.adv_sessions
         WHERE id = ${id}`;
      expect(live).toMatchObject({
        ended_at: null,
        exit_code: null,
        ended_by: null,
        ended_signal: null,
        resume_claim_key: null,
        resume_claimed_at: null,
        session_id: sessionId,
        cwd,
      });
    },
  );

  it('replays one attempt, reports a typed competing reservation, and releases immediately', async () => {
    const { id } = await seedEnded('claude');
    const key = `resume-owner-${id}`;
    const competitor = `${key}-competitor`;

    expect(await acquireAdvSessionResume(id, key, 60)).toMatchObject({
      status: 'acquired',
      acquired: true,
    });
    expect(await acquireAdvSessionResume(id, key, 60)).toMatchObject({
      status: 'acquired',
      acquired: true,
      replayed: true,
    });
    expect(await acquireAdvSessionResume(id, competitor, 60)).toMatchObject({
      status: 'reserved',
      acquired: false,
    });

    expect(await releaseAdvSessionResume(id, key)).toBe(true);
    expect(await releaseAdvSessionResume(id, key)).toBe(true);
    expect(await acquireAdvSessionResume(id, competitor, 60)).toMatchObject({
      status: 'acquired',
      acquired: true,
    });
  });

  it.each(['claude', 'omp', 'codex'] as const)(
    '%s lets a new claimant replace an expired reservation without a five-minute wait',
    async (agent) => {
      const { id } = await seedEnded(agent);
      const first = `resume-expired-${id}`;
      const next = `${first}-next`;
      expect(await acquireAdvSessionResume(id, first, 60)).toMatchObject({ acquired: true });
      await admin`
        UPDATE harness_shared.adv_sessions
           SET resume_claimed_at = now() - interval '61 seconds'
         WHERE id = ${id}`;

      expect(await acquireAdvSessionResume(id, next, 60)).toMatchObject({
        status: 'acquired',
        acquired: true,
      });
    },
  );

  it.each(['claude', 'omp', 'codex'] as const)('%s admits exactly one of two simultaneous resumers', async (agent) => {
    const { id } = await seedEnded(agent);
    const keys = [`resume-race-a-${id}`, `resume-race-b-${id}`] as const;
    const outcomes = await Promise.all([
      acquireAdvSessionResume(id, keys[0], 60),
      acquireAdvSessionResume(id, keys[1], 60),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'acquired')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'reserved')).toHaveLength(1);

    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === 'acquired');
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    expect(await finalizeAdvSessionResume(id, keys[winnerIndex])).toBe(true);
    expect(await finalizeAdvSessionResume(id, keys[loserIndex])).toBe(false);
    const [row] = await admin`
        SELECT ended_at, resume_claim_key, resume_claimed_at
          FROM harness_shared.adv_sessions
         WHERE id = ${id}`;
    expect(row).toMatchObject({
      ended_at: null,
      resume_claim_key: null,
      resume_claimed_at: null,
    });
  });

  it.each(['claude', 'omp', 'codex'] as const)(
    '%s crash-before-spawn release makes the next attempt immediately claimable',
    async (agent) => {
      const { id } = await seedEnded(agent);
      const crashed = `resume-crashed-${id}`;
      const recovery = `${crashed}-recovery`;
      expect(await acquireAdvSessionResume(id, crashed, 60)).toMatchObject({ acquired: true });
      expect(await releaseAdvSessionResume(id, crashed)).toBe(true);
      expect(await releaseAdvSessionResume(id, crashed)).toBe(true);
      expect(await acquireAdvSessionResume(id, recovery, 60)).toMatchObject({
        status: 'acquired',
        acquired: true,
      });
    },
  );
});

describe('reactivateAdvSessionByOwner (non-exclusive genuine-activity repair)', () => {
  it('does not reactivate a fleet-retired row', async () => {
    const owner = `s-owner-retired-${WS}`;
    await seedAdv({ coordOwnerId: owner, ended: true });
    await admin`
      UPDATE harness_shared.adv_sessions
         SET retired_at = now(), retired_by = 'fleet:kill:test', retired_reason = 'activity regression test'
       WHERE workspace_id = ${WS} AND coord_owner_id = ${owner}
    `;
    const [before] = await admin`
      SELECT session_id, started_at, ended_at, exit_code, ended_by, ended_signal,
             retired_at, retired_by, retired_reason
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${WS} AND coord_owner_id = ${owner}
    `;

    await expect(reactivateAdvSessionByOwner(owner)).resolves.toBe(false);

    const [after] = await admin`
      SELECT session_id, started_at, ended_at, exit_code, ended_by, ended_signal,
             retired_at, retired_by, retired_reason
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${WS} AND coord_owner_id = ${owner}
    `;
    expect(after).toEqual(before);
  });

  it.each(['claude', 'omp', 'codex'])('%s startup activity preserves a keyed resume reservation', async (agent) => {
    const owner = `s-owner-reserved-${agent}`;
    await seedAdv({ coordOwnerId: owner, agent, ended: true });
    const [row] = await admin`SELECT id, ended_at FROM harness_shared.adv_sessions WHERE coord_owner_id = ${owner}`;
    const key = `pui-resume-${row.id}`;
    expect(await acquireAdvSessionResume(row.id, key, 300)).toMatchObject({ acquired: true });

    // MCP startup itself emits genuine presence before engine readiness. That
    // activity must not steal the explicit launcher's single-writer lease.
    expect(await reactivateAdvSessionByOwner(owner)).toBe(false);
    const [reserved] = await admin`
      SELECT ended_at, resume_claim_key FROM harness_shared.adv_sessions WHERE id = ${row.id}`;
    expect(reserved).toMatchObject({ ended_at: row.ended_at, resume_claim_key: key });
    expect(await finalizeAdvSessionResume(row.id, key)).toBe(true);
  });

  it('lets concurrent repairs settle safely, then degrades to an already-live no-op', async () => {
    const owner = 's-owner-repair';
    await seedAdv({ coordOwnerId: owner, ended: true });
    await admin`
      UPDATE harness_shared.adv_sessions
         SET exit_code = 137
       WHERE coord_owner_id = ${owner}`;

    // D-001: these are best-effort activity repairs, not competing launch claims.
    // Both callers must be allowed to finish. Depending on statement interleaving,
    // the second writer may update the same selected row or observe it already live.
    const results = await Promise.all([
      reactivateAdvSessionByOwner(owner),
      reactivateAdvSessionByOwner(owner),
    ]);
    expect(results).toContain(true);
    expect(results.every((result) => typeof result === 'boolean')).toBe(true);

    const [row] = await admin`
      SELECT ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${owner}`;
    expect(row.ended_at).toBeNull();
    expect(row.exit_code).toBeNull();

    // Once live, false means harmless no-op. It is not an exclusive-claim loss.
    await expect(reactivateAdvSessionByOwner(owner)).resolves.toBe(false);
  });
});
