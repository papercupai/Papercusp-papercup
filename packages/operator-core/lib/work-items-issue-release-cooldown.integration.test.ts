/**
 * work-items-issue-release-cooldown.integration.test.ts — migration 499 + 1055: the issue-family
 * release-cooldown floor, mirroring the feature family's (mig 485 / EI-6956).
 *
 * ROOT CAUSE (confirmed live 2026-07-04, backlog-drain fleet, on real work-items WI-652 /
 * WI-2381): the feature-family release path stamps `last_released_by`/`last_released_at` on
 * release, and `claimNextWorkItem`'s shared `claimFloorsWhereSql` floor excludes a row from
 * the SAME releasing claimant for `releaseCooldownSec()` (default 300s) afterward. The
 * issue-family (bug/change/task) release path (`releaseIssue` → the `engineer_issues` view's
 * INSTEAD OF trigger) had NEITHER half: releasing an issue-family item never stamped any
 * cooldown provenance, and `claimNextIssueWorkItem` never read one as a floor — so the very
 * next self-select call from the SAME agent re-claimed the SAME top-ranked item, forever,
 * whenever it was still the oldest/highest-ranked eligible row (the generalized form of the
 * observed WI-652/WI-2381 "ping-pong"). Migration 1055 closes the remaining multi-agent
 * overwrite hole by retaining one keyed sidecar row per releasing agent.
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • releasing a CLAIMED issue-family item stamps last_released_by/at on the base row
 *     (via the engineer_issues_view_dml trigger — no view column-list change needed);
 *   • releasing an item that was NEVER claimed is a no-op on the stamp (nothing to release);
 *   • claimNextWorkItem's issue tier SKIPS a row released by the SAME assignee within the
 *     cooldown window, serving a sibling instead;
 *   • a DIFFERENT assignee is NOT cooldown-excluded (the floor is per-releasing-claimant);
 *   • a second peer release does not erase the first peer's sidecar cooldown;
 *   • once the cooldown window elapses, the SAME assignee can claim it again;
 *   • diagnoseClaimNextMiss's issue-ready count honors the same floor (no false "ready").
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-issue-release-cooldown.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// WI-10004742 / EI-24400810686776632: claimNextWorkItem reads the operation-worker receipt from
// adv_sessions + session_briefs, which this fixture never builds, so every claim failed closed.
// The subject is the release cooldown, not operation claims: stub the read to "no operation worker".
vi.mock('./blueprint/operation-worker-binding', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' }) };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

async function seedIssue(id: string, opts: { createdTs?: number; takenBy?: string | null } = {}) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'bug', ${`title ${id}`}, 'open', ${opts.takenBy ?? null}, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

async function readCooldownCols(id: string): Promise<{ takenBy: string | null; lastReleasedBy: string | null; lastReleasedAt: Date | null }> {
  const rows = await db.sql<{ taken_by: string | null; last_released_by: string | null; last_released_at: Date | null }[]>`
    SELECT taken_by, last_released_by, last_released_at FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  const r = rows[0];
  return { takenBy: r?.taken_by ?? null, lastReleasedBy: r?.last_released_by ?? null, lastReleasedAt: r?.last_released_at ?? null };
}

/** Push legacy and sidecar release timestamps back beyond the cooldown window. */
async function backdateRelease(id: string, secondsAgo: number) {
  await db.sql`
    UPDATE harness_shared.work_items
       SET last_released_at = now() - make_interval(secs => ${secondsAgo})
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  await db.sql`
    UPDATE harness_shared.work_item_release_cooldowns
       SET released_at = now() - make_interval(secs => ${secondsAgo})
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-issue-release-cooldown');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // releaseWorkItem retires lifecycle-bound awaits and emits a claim-released
  // event. The shared, audited event-substrate list keeps those tables complete,
  // so a missing event column cannot hide the cooldown assertions (WI-10004700).
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'work-items-issue-release-cooldown.integration.test.ts',
  });
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_release_cooldowns, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
  delete process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC; // default (300s) unless a test overrides it
});
afterEach(() => {
  setFlagOverridesForTest({});
  delete process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC;
});

describe('releaseWorkItem stamps release-cooldown provenance on an issue-family row (mig 499)', () => {
  it('a release from a CLAIMED state stamps last_released_by/at on the base work_items row', async () => {
    await seedIssue('WI-rel-1', { takenBy: 'bee-a' });
    const released = await wi.releaseWorkItem('WI-rel-1', { harness: H });
    expect(released?.assignee ?? null).toBeNull();

    const cols = await readCooldownCols('WI-rel-1');
    expect(cols.takenBy).toBeNull();
    expect(cols.lastReleasedBy).toBe('bee-a');
    expect(cols.lastReleasedAt).not.toBeNull();
    expect(Date.now() - new Date(cols.lastReleasedAt as Date).getTime()).toBeLessThan(10_000);
  });

  it('releasing an item that was never claimed is a no-op on the stamp (nothing to release)', async () => {
    await seedIssue('WI-rel-2'); // takenBy defaults to null
    await wi.releaseWorkItem('WI-rel-2', { harness: H });
    const cols = await readCooldownCols('WI-rel-2');
    expect(cols.lastReleasedBy).toBeNull();
    expect(cols.lastReleasedAt).toBeNull();
  });
});

describe('claimNextWorkItem SKIPS an issue-family item within ITS OWN release cooldown (mig 499)', () => {
  it('the releasing assignee is excluded; a sibling is served instead', async () => {
    await seedIssue('WI-cool-a', { createdTs: 100, takenBy: 'bee-1' });
    await seedIssue('WI-cool-b', { createdTs: 200 });
    await wi.releaseWorkItem('WI-cool-a', { harness: H });

    // Oldest-first would normally re-serve WI-cool-a (createdTs:100) to bee-1 — the
    // cooldown must skip it and serve WI-cool-b instead.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-cool-b');

    // WI-cool-a is still unclaimed (skipped, not claimed by anyone else either — it was
    // the only OTHER candidate and bee-1 already took it).
    const cols = await readCooldownCols('WI-cool-a');
    expect(cols.takenBy).toBeNull();
  });

  it('a DIFFERENT assignee is NOT excluded — the floor is per-releasing-claimant', async () => {
    await seedIssue('WI-cool-c', { createdTs: 100, takenBy: 'bee-1' });
    await wi.releaseWorkItem('WI-cool-c', { harness: H });

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' });
    expect(got?.id).toBe('WI-cool-c');
  });

  it('keeps independent cooldowns when a peer releases the same item afterward (migration 1055)', async () => {
    await seedIssue('WI-cool-peer', { createdTs: 100, takenBy: 'bee-1' });
    await wi.releaseWorkItem('WI-cool-peer', { harness: H });

    // Let a second agent take and release the same row. The legacy stamp now names
    // bee-2, but the sidecar must retain bee-1's still-live cooldown as well.
    const peerClaim = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' });
    expect(peerClaim?.id).toBe('WI-cool-peer');
    await wi.releaseWorkItem('WI-cool-peer', { harness: H });

    const cooldowns = await db.sql<{ agent_id: string }[]>`
      SELECT agent_id
        FROM harness_shared.work_item_release_cooldowns
       WHERE workspace_id = ${WS} AND feature_id = 'WI-cool-peer'
       ORDER BY agent_id`;
    expect(cooldowns.map((row) => row.agent_id)).toEqual(['bee-1', 'bee-2']);

    // The first releaser remains excluded even though the peer's later release
    // overwrote the single-valued legacy stamp.
    const firstReleaserRetry = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(firstReleaserRetry).toBeNull();
  });

  it('once the cooldown window elapses, the SAME assignee can claim it again', async () => {
    await seedIssue('WI-cool-d', { createdTs: 100, takenBy: 'bee-1' });
    await wi.releaseWorkItem('WI-cool-d', { harness: H });
    await backdateRelease('WI-cool-d', 10_000); // well past the 300s default

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-cool-d');
  });

  it('PAPERCUSP_RELEASE_COOLDOWN_SEC=0 disables the floor entirely (byte-identical to no cooldown)', async () => {
    process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC = '0';
    await seedIssue('WI-cool-e', { createdTs: 100, takenBy: 'bee-1' });
    await wi.releaseWorkItem('WI-cool-e', { harness: H });

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-cool-e');
  });
});

/** One sidecar release per agent, `secondsAgo` in the past (the PK is one row per agent). */
async function seedReleases(id: string, agents: readonly string[], secondsAgo = 60) {
  for (const agent of agents) {
    await db.sql`
      INSERT INTO harness_shared.work_item_release_cooldowns
        (workspace_id, harness_slug, feature_id, agent_id, released_at)
      VALUES (${WS}, ${H}, ${id}, ${agent}, now() - make_interval(secs => ${secondsAgo}))`;
  }
}

async function setEvidenceAdvancedAt(id: string, value: string) {
  await db.sql`
    UPDATE harness_shared.work_items
       SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('evidenceAdvancedAt', ${value}::text)
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
}

describe('WI-6554700010008444: release damping stops cross-member reselect churn (BQL#D-020)', () => {
  afterEach(() => {
    delete process.env.PAPERCUSP_RELEASE_DAMPING_RELEASERS;
    delete process.env.PAPERCUSP_RELEASE_DAMPING_WINDOW_SEC;
  });

  it('three distinct releasers with no new evidence: a fourth member is served a sibling instead', async () => {
    await seedIssue('WI-damp-a', { createdTs: 100 });
    await seedIssue('WI-damp-b', { createdTs: 200 });
    await seedReleases('WI-damp-a', ['bee-1', 'bee-2', 'bee-3']);
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-4' });
    expect(got?.id).toBe('WI-damp-b');
    expect((await readCooldownCols('WI-damp-a')).takenBy).toBeNull();
  });

  it('two releasers stay under the threshold, so the oldest row is still served', async () => {
    await seedIssue('WI-damp-c', { createdTs: 100 });
    await seedReleases('WI-damp-c', ['bee-1', 'bee-2']);
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-4' });
    expect(got?.id).toBe('WI-damp-c');
  });

  it('new evidence after the releases re-admits the row at once', async () => {
    await seedIssue('WI-damp-d', { createdTs: 100 });
    await seedReleases('WI-damp-d', ['bee-1', 'bee-2', 'bee-3'], 120);
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-4' })).toBeNull();
    await setEvidenceAdvancedAt('WI-damp-d', new Date().toISOString());
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-4' });
    expect(got?.id).toBe('WI-damp-d');
  });

  it('evidence OLDER than the releases does not re-admit it', async () => {
    await seedIssue('WI-damp-e', { createdTs: 100 });
    await setEvidenceAdvancedAt('WI-damp-e', new Date(Date.now() - 3_600_000).toISOString());
    await seedReleases('WI-damp-e', ['bee-1', 'bee-2', 'bee-3'], 60);
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-4' })).toBeNull();
  });

  it('releases older than the damping window age out and the row is re-offered', async () => {
    await seedIssue('WI-damp-f', { createdTs: 100 });
    await seedReleases('WI-damp-f', ['bee-1', 'bee-2', 'bee-3'], 14_400 + 60);
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-4' });
    expect(got?.id).toBe('WI-damp-f');
  });

  it('an unparsable evidenceAdvancedAt fails open to counting releases and never throws', async () => {
    await seedIssue('WI-damp-g', { createdTs: 100 });
    await setEvidenceAdvancedAt('WI-damp-g', '2026-13-45T99:00:00Z');
    await seedReleases('WI-damp-g', ['bee-1', 'bee-2', 'bee-3']);
    await expect(wi.claimNextWorkItem({ harness: H, assignee: 'bee-4' })).resolves.toBeNull();
  });

  it('PAPERCUSP_RELEASE_DAMPING_RELEASERS=0 disables the leg', async () => {
    process.env.PAPERCUSP_RELEASE_DAMPING_RELEASERS = '0';
    await seedIssue('WI-damp-h', { createdTs: 100 });
    await seedReleases('WI-damp-h', ['bee-1', 'bee-2', 'bee-3']);
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-4' });
    expect(got?.id).toBe('WI-damp-h');
  });

  it('a by-id claim of a damped row still succeeds (damping gates self-select only)', async () => {
    await seedIssue('WI-damp-i', { createdTs: 100 });
    await seedReleases('WI-damp-i', ['bee-1', 'bee-2', 'bee-3']);
    await wi.claimWorkItem('WI-damp-i', 'bee-4', { harness: H });
    expect((await readCooldownCols('WI-damp-i')).takenBy).toBe('bee-4');
  });
});

describe('diagnoseClaimNextMiss honors the same issue-family cooldown floor (mig 499)', () => {
  it('a same-assignee cooldown row is pending-but-not-ready (never falsely ready)', async () => {
    await seedIssue('WI-cool-diag-1', { createdTs: 100, takenBy: 'bee-1' });
    await wi.releaseWorkItem('WI-cool-diag-1', { harness: H });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'bee-1' });
    expect(diag.pendingUnclaimed).toBeGreaterThan(0);
    expect(diag.readyUnclaimed).toBe(0);
  });

  it('a different-assignee diagnosis still counts it ready (the floor is per-caller)', async () => {
    await seedIssue('WI-cool-diag-2', { createdTs: 100, takenBy: 'bee-1' });
    await wi.releaseWorkItem('WI-cool-diag-2', { harness: H });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'bee-2' });
    expect(diag.readyUnclaimed).toBeGreaterThanOrEqual(1);
  });
});
