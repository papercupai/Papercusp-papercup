/**
 * get-next.integration.test.ts — the deterministic spec-driven `get_next` resolver
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, Phase 3 / D-002, D-003, D-010).
 *
 * Proves against real Postgres (testcontainer; Docker required), modelled on
 * work-items-claim-readiness.integration.test.ts (the floors share that test's
 * bootstrap — get_next ANDs in the IDENTICAL claimFloorsWhereSql fragment):
 *
 *   • a spec filter + rank claims the CORRECT item (narrow + reorder);
 *   • a FLOOR ALWAYS applies — a blocked / non-ready / claimed / wrong-status item is
 *     NEVER claimed, even when spec.filter would explicitly select it (D-002: a spec
 *     can only narrow + reorder, never widen past or re-assert a floor);
 *   • two CONCURRENT get_next claim DIFFERENT items (FOR UPDATE SKIP LOCKED);
 *   • DEFAULT_CLAIM_SPEC reproduces today's ordering (feature_order ASC NULLS LAST,
 *     then created_ts ASC) — "no spec == current behavior" (D-003);
 *   • provenance: every claim records the specId@revision that selected it.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/get-next.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEventSubstrateMigrationsForTest,
  COORD_SUBSCRIPTION_SUBSTRATE,
  createFreshPgDb,
  type FreshPgDb,
} from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import type { ClaimSpec } from './claim-spec';
import { OrgTxnTimeoutError } from '../pg-bounded-txn';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { acknowledgeActivation, desiredActivation, prepareActivation } from '../session-activation';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { getNextWorkItem, getNextWorkItemDefault } = await import('./get-next');
const { DEFAULT_CLAIM_SPEC, validateClaimSpec } = await import('./claim-spec');
const wi = await import('../work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

interface SeedOpts {
  createdTs?: number;
  status?: string;
  takenBy?: string | null;
  featureOrder?: number | null;
  tags?: string[];
  paths?: string[];
  riskTier?: string;
  estCost?: number;
  kind?: string;
  title?: string;
  clusterPriority?: number | string;
}
async function seedFeature(id: string, opts: SeedOpts = {}) {
  const payloadValue = {
    ...(opts.paths ? { paths: opts.paths } : {}),
    ...(opts.riskTier ? { risk_tier: opts.riskTier } : {}),
    ...(opts.clusterPriority !== undefined ? { clusterPriority: opts.clusterPriority } : {}),
  };
  const payload = Object.keys(payloadValue).length > 0 ? payloadValue : null;
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, feature_order, tags, payload, expected_cost_cents, title)
    VALUES (${H}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, ${WS},
       ${opts.createdTs ?? 0}, 0, ${opts.featureOrder ?? null},
       ${opts.tags ? db.sql.json(opts.tags) : null},
       ${payload ? db.sql.json(payload) : null},
       ${opts.estCost ?? null}, ${opts.title ?? ''})`;
}

/** An ISSUE-family row (bug|change|task) — NOT visible through harness_features_consolidated
 *  (excluded by its WHERE), so this inserts on the work_items BASE table directly. Used by the
 *  WI-1407 tier-3 fallback tests (getNextWorkItem widening past the whole feature family). */
async function seedIssue(
  id: string,
  // `title` (EI-18665895916759270): the column a WI-3268 `not:{title glob}` exclusion leg reads —
  // defaults to the id so every existing caller keeps a non-null, non-matching title.
  opts: { createdTs?: number; state?: string; kind?: string; title?: string; featureOrder?: number | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, title, feature_order)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${opts.state ?? 'open'}, ${WS}, ${opts.createdTs ?? 0}, 0,
            ${opts.title ?? id}, ${opts.featureOrder ?? null})`;
}

async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

/** A validated spec or fail the test loudly — every spec under test must pass the validator. */
function spec(s: ClaimSpec): ClaimSpec {
  const v = validateClaimSpec(s);
  expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  return s;
}

const BEE = { assignee: 'bee-1' };

beforeAll(async () => {
  db = await createFreshPgDb('sched-get-next');
  h.sql = db.sql;
  // Every successful claim emits `work-item:claimed:<id>` through the real awaited-event
  // surface, whose first write is migration 632's durable fire latch. Production treats a
  // missing latch table as fail-soft, but vitest-fail-on-console correctly turns that warning
  // into a fixture failure. Keep the fixture honest about the runtime table instead of mocking
  // the emit away: this suite is meant to exercise the complete claim path.
  // The key-fire latch resolves subscribers from event_awaits (WI-10004234), so the
  // whole shared event substrate is needed, not just event_key_fires (WI-10004700). The
  // latch's subscriber lookup also reads coord_entity_subscriptions (123, last widened by
  // 1257), so apply the same coordination extras as work-items-release-request.
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'scheduler/get-next.integration.test.ts',
    ...COORD_SUBSCRIPTION_SUBSTRATE,
  });
  // The claim path records the latest coordination-post id in the claimed row's
  // payload.  This focused fixture exercises real claims but does not bootstrap the
  // full coordination substrate, so provide the minimal runtime shape that query
  // reads.  Without it, every claim that reaches the UPDATE fails with a misleading
  // missing-relation error before any scheduler floor can be evaluated.
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_thread_posts (
      id BIGSERIAL PRIMARY KEY,
      workspace_id text NOT NULL
    );`).simple();
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      role text, started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz, ended_by text, launch_spec jsonb
    );
    CREATE TABLE harness_shared.session_briefs (
      workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb,
      PRIMARY KEY (workspace_id, owner_id)
    );
  `).simple();
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: false });
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps,
    harness_shared.adv_sessions, harness_shared.session_briefs`;
});

describe('blueprint worker claim under a scheduler spec', () => {
  it('serves only the exact pinned item and refuses a changed pin', async () => {
    const operationRevision = 'c'.repeat(64);
    const launchRevision = { specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) };
    const worker = 'scheduler-operation-worker';
    const pin = {
      kind: 'blueprint-operation', harnessSlug: H, operationId: 'execute',
      specificationRevision: operationRevision, operationVersion: '1.0.0', input: {},
    };
    await seedFeature('WI-scheduler-pinned', { createdTs: 1 });
    await seedFeature('WI-scheduler-ordinary', { createdTs: 2 });
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin })}
      WHERE feature_id = 'WI-scheduler-pinned'`;
    const activation = acknowledgeActivation(prepareActivation(desiredActivation(
      { actorId: worker, principalId: worker, sessionId: worker }, launchRevision,
    ), launchRevision), launchRevision);
    await db.sql`INSERT INTO harness_shared.adv_sessions
      (workspace_id, coord_owner_id, role, launch_spec)
      VALUES (${WS}, ${worker}, 'worker', ${db.sql.json({
        workspaceId: WS, harnessSlug: H, role: 'worker', ...launchRevision,
        specificationArtifact: { configuration: { grants: {} } },
        acceptedOperation: {
          kind: 'blueprint-operation-worker', workItemId: 'WI-scheduler-pinned',
          operationId: 'execute', specificationRevision: operationRevision,
          pin,
          identity: { ref: 'worker', revision: '1.0.0', contentHash: 'd'.repeat(64) },
          requiredTools: ['scheduler:get_next'],
        },
      })})`;
    await db.sql`INSERT INTO harness_shared.session_briefs
      (workspace_id, owner_id, control_state)
      VALUES (${WS}, ${worker}, ${db.sql.json({ activation })})`;

    expect((await getNextWorkItem(DEFAULT_CLAIM_SPEC, { assignee: worker }, { harness: H }))?.workItem.id)
      .toBe('WI-scheduler-pinned');
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL,
      payload = ${db.sql.json({ blueprintOperation: { ...pin, specificationRevision: 'e'.repeat(64) } })}
      WHERE feature_id = 'WI-scheduler-pinned'`;
    expect(await getNextWorkItem(DEFAULT_CLAIM_SPEC, { assignee: worker }, { harness: H }))
      .toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Filter + rank: claims the CORRECT item.
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — an unaffordable claim ladder fails LOUDLY, never as a drain (EI-18805386252364731)', () => {
  // The regression this guards: the claim query runs on the `harness_admin` pool, which has NO
  // statement_timeout (migrations share it), so an over-cost spec used to HANG until the MCP
  // client gave up minutes later. A member reads a pull that never returned as "lane drained"
  // and parks — while the lane is full. The bug is not the slowness; it is that exhaustion and
  // emptiness were indistinguishable.
  it('an exhausted budget raises a TYPED error, on an item it would otherwise have claimed', async () => {
    await seedFeature('F-affordable', { createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'budget-guard',
      revision: 1,
      view: { filter: { field: 'id', op: 'in', value: ['F-affordable'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });

    // Budget gone BEFORE the data is touched. The claim must not come back as `null` — that is
    // the exact shape a genuine drain has, and the whole defect was that the two were the same.
    await expect(getNextWorkItem(s, BEE, { harness: H, claimBudgetMs: 0 })).rejects.toBeInstanceOf(
      OrgTxnTimeoutError,
    );

    // Teeth: the SAME spec, same rows, with a real budget DOES claim. So the rejection above was
    // about the budget and not about there being nothing to find — without this second half the
    // test would still pass if the filter simply matched no rows.
    const phases: string[] = [];
    expect((await getNextWorkItem(s, BEE, {
      harness: H,
      onResolutionStep: (step) => phases.push(step),
    }))?.workItem.id).toBe('F-affordable');
    expect(phases).toEqual([
      'candidate-ready-flag-read',
      'candidate-worker-binding-read',
      'candidate-feature-tier-1',
      'candidate-holder-interests',
    ]);
  });

  it('returns the committed claim while optional holder-interest arming is still pending', async () => {
    const id = 'F-holder-interest-arm-pending';
    await seedFeature(id);

    let markArmStarted!: () => void;
    const armStarted = new Promise<void>((resolve) => {
      markArmStarted = resolve;
    });
    type InterestWatch = Awaited<ReturnType<typeof wi.armWorkItemHolderInterests>>;
    let finishArm!: (watch: InterestWatch) => void;
    let armFinished = false;
    const pendingArm = new Promise<InterestWatch>((resolve) => {
      finishArm = (watch) => {
        armFinished = true;
        resolve(watch);
      };
    });
    const armSpy = vi.spyOn(wi, 'armWorkItemHolderInterests').mockImplementation(() => {
      markArmStarted();
      return pendingArm;
    });

    let result: Awaited<ReturnType<typeof getNextWorkItem>> | undefined;
    let error: unknown;
    const pull = getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H }).then(
      (value) => {
        result = value;
      },
      (caught) => {
        error = caught;
      },
    );

    try {
      const first = await Promise.race([
        armStarted.then(() => 'arm-started' as const),
        pull.then(() => 'pull-returned' as const),
      ]);
      expect(first).toBe('arm-started');
      // Let the claim's return continuation run, but keep the optional arm unresolved.
      await Promise.resolve();
      expect(armFinished).toBe(false);
      expect(error).toBeUndefined();
      expect(result?.workItem).toMatchObject({ id, assignee: BEE.assignee });
      const rows = await db.sql<{ taken_by: string | null }[]>`
        SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id = ${id}`;
      expect(rows[0]?.taken_by).toBe(BEE.assignee);
    } finally {
      finishArm(undefined);
      await pull;
      armSpy.mockRestore();
    }
  });

  // COVERAGE NOTE — why this second, source-level test exists.
  //
  // The behavioural test above only exercises the JS ladder-deadline branch. The OTHER half of
  // the fix is that the claim statement itself runs under a DB-side `SET LOCAL statement_timeout`
  // — and that half is what actually rescues a wedged query, because postgres-js does not cancel
  // an in-flight query from JS. A revert that kept the deadline check but put the UPDATE back on
  // the raw unbounded `harness_admin` pool would restore the original hang while the test above
  // still passed: a guard can fail at the right times and still be scoped to the wrong
  // population. There is no way to observe SET LOCAL from outside its own transaction, so the
  // executed-SQL path is pinned at the source level instead.
  it('the claim statement runs through boundedOrgTxn, never the raw unbounded admin pool', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'get-next.ts'), 'utf8');
    expect(src).toContain('boundedOrgTxn');
    // The pre-fix form: the claim UPDATE issued directly on the pool handle.
    expect(src).not.toMatch(/await sql<FeatureRowDb\[\]>`\s*\n?\s*UPDATE harness_shared\.harness_features_consolidated/);
  });

  it('bounds candidate authority reads before entering the feature ladder', async () => {
    await seedFeature('F-candidate-bound');
    const s = spec({
      specVersion: '1.0',
      specId: 'candidate-bound',
      revision: 1,
      view: { filter: { field: 'id', op: '=', value: 'F-candidate-bound' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    let releaseLock!: () => void;
    let locked!: () => void;
    const holding = db.sql.begin(async (tx) => {
      await tx`LOCK TABLE harness_shared.adv_sessions IN ACCESS EXCLUSIVE MODE`;
      locked();
      await new Promise<void>((resolve) => { releaseLock = resolve; });
    });
    await new Promise<void>((resolve) => { locked = resolve; });
    const steps: string[] = [];
    try {
      await expect(getNextWorkItem(s, BEE, {
        harness: H,
        onResolutionStep: (step) => steps.push(step),
      })).rejects.toBeInstanceOf(OrgTxnTimeoutError);
      expect(steps).toEqual(['candidate-ready-flag-read', 'candidate-worker-binding-read']);
    } finally {
      releaseLock();
      await holding;
    }
    // The timeout was the authority read, not an empty spec view: after the lock
    // clears the same spec and candidate must become claimable without widening.
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-candidate-bound');
  });

  it('captures one bounded, PID-targeted candidate wait snapshot', async () => {
    await seedFeature('F-candidate-wait-snapshot');
    const claimBudgetMs = 2_000;
    let releaseBlocker: (() => void) | undefined;
    let signalBlockerReady!: () => void;
    const blockerReady = new Promise<void>((resolve) => { signalBlockerReady = resolve; });
    let blockerPid: number | undefined;
    const holding = db.sql.begin(async (tx) => {
      // Lock the relation the candidate UPDATE itself touches, after its target
      // backend identity has been read on the same transaction.
      await tx`LOCK TABLE harness_shared.harness_features_consolidated IN ACCESS EXCLUSIVE MODE`;
      const [row] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      blockerPid = Number(row!.pid);
      signalBlockerReady();
      await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    });
    await blockerReady;

    const steps: string[] = [];
    const outcome = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, {
      harness: H,
      client: db.sql,
      claimBudgetMs,
      captureCandidateWait: true,
      onResolutionStep: (step, event) => {
        if (event.phase === 'start') steps.push(step);
      },
    }).then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    try {
      expect(steps).toContain('candidate-feature-tier-1');
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected' || !(outcome.error instanceof OrgTxnTimeoutError)) {
        throw new Error('bounded candidate reproduction did not return OrgTxnTimeoutError');
      }
      expect(outcome.error.pgCode).toBe('57014');
      expect(outcome.error.timeoutSource).toBe('pg');
      expect(outcome.error.candidateWaitSnapshot).toMatchObject({
        status: 'sampled',
        waitEventType: 'Lock',
        blockingPids: expect.arrayContaining([blockerPid]),
      });
      const snapshot = outcome.error.candidateWaitSnapshot;
      expect(snapshot?.statementCapMs).toBeLessThanOrEqual(claimBudgetMs);
      expect(snapshot?.sampleAfterMs).toBe(Math.floor((snapshot?.statementCapMs ?? 0) * 0.8));
      expect(JSON.stringify(snapshot)).not.toContain('queryText');

      if (process.env.SCHEDULER_TIMEOUT_REPRO === '1') {
        console.info(`SCHEDULER_TIMEOUT_REPRO ${JSON.stringify({
          phase: 'candidate-feature-tier-1',
          timeoutSource: outcome.error.timeoutSource,
          pgCode: outcome.error.pgCode,
          candidateWaitSnapshot: snapshot,
          blockerPid,
          interpretation: 'one instantaneous sample; not evidence for the full statement duration',
        })}`);
      }
    } finally {
      releaseBlocker?.();
      await holding;
    }
  });
});

describe('get_next — spec filter + rank selects the correct item', () => {
  it('a tags filter NARROWS to the matching item', async () => {
    await seedFeature('F-sync', { tags: ['sync'], createdTs: 100 });
    await seedFeature('F-docs', { tags: ['docs'], createdTs: 50 }); // older but filtered out
    const s = spec({
      specVersion: '1.0',
      specId: 'sync-only',
      revision: 3,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-sync');
    expect(r?.claimedUnder).toEqual({ specId: 'sync-only', revision: 3 });
  });

  it('an `id in [...]` PIN narrows to exactly the pinned set (the fixed-wave exception)', async () => {
    await seedFeature('F-pinned', { createdTs: 100 });
    await seedFeature('F-other', { createdTs: 50 }); // older (would win on age) but NOT pinned
    const s = spec({
      specVersion: '1.0',
      specId: 'redrive-wave',
      revision: 1,
      view: { filter: { field: 'id', op: 'in', value: ['F-pinned', 'F-missing'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-pinned');
  });

  it('an `id` pin still respects the ready floor — a pinned-but-BLOCKED item is not claimed', async () => {
    await seedFeature('F-pin-blocked', { createdTs: 100 });
    await seedFeature('F-pin-blocker', { createdTs: 50 });
    await blockByFeature('F-pin-blocked', 'F-pin-blocker');
    const s = spec({
      specVersion: '1.0',
      specId: 'pin-blocked',
      revision: 1,
      view: { filter: { field: 'id', op: 'in', value: ['F-pin-blocked'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    // The id-pin selects F-pin-blocked, but the ready floor excludes it ⇒ nothing claimable.
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('rank by priority (feature_order) desc picks the HIGHEST-priority item', async () => {
    // feature_order is an INVERTED scale (lower = higher priority); `priority desc`
    // ("highest priority first") ⇒ feature_order ASC ⇒ the order-1 item wins.
    await seedFeature('F-lo', { featureOrder: 9, createdTs: 10 });
    await seedFeature('F-hi', { featureOrder: 1, createdTs: 999 }); // newest, but top priority
    const s = spec({
      specVersion: '1.0',
      specId: 'by-priority',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-hi');
  });

  it('cluster_priority desc drains the largest persisted resolver cluster first', async () => {
    await seedFeature('F-standalone-old', { createdTs: 10 });
    await seedFeature('F-small-cluster', { createdTs: 20, clusterPriority: 3 });
    await seedFeature('F-large-cluster', { createdTs: 999, clusterPriority: 12 });
    const s = spec({
      specVersion: '1.0',
      specId: 'largest-cluster-first',
      revision: 1,
      view: {},
      rank: {
        mode: 'lexicographic',
        terms: [
          { expr: 'cluster_priority', dir: 'desc' },
          { expr: 'age', dir: 'asc' },
        ],
      },
    });

    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-large-cluster');
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-small-cluster');
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-standalone-old');
  });

  it('cluster_priority treats a malformed legacy payload as neutral instead of aborting the claim', async () => {
    await seedFeature('F-malformed-old', { createdTs: 10, clusterPriority: 'not-a-number' });
    await seedFeature('F-valid-new', { createdTs: 999, clusterPriority: 2 });
    const s = spec({
      specVersion: '1.0',
      specId: 'malformed-cluster-priority-safe',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'cluster_priority', dir: 'desc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-valid-new');
  });

  it('a relational filter on risk_tier (payload) excludes over-ceiling items', async () => {
    await seedFeature('F-risky', { riskTier: '4', tags: ['sync'], createdTs: 10 });
    await seedFeature('F-safe', { riskTier: '1', tags: ['sync'], createdTs: 20 });
    const s = spec({
      specVersion: '1.0',
      specId: 'low-risk-sync',
      revision: 1,
      view: {
        filter: {
          all: [
            { field: 'tags', op: 'contains', value: 'sync' },
            { field: 'risk_tier', op: '<=', value: 2 },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-safe');
  });

  it('the live affinity rank term prefers an item whose paths overlap the bee held_paths', async () => {
    await seedFeature('F-far', { paths: ['apps/ui/page.tsx'], featureOrder: 1, createdTs: 10 });
    await seedFeature('F-near', { paths: ['libs/sync/queue.ts'], featureOrder: 1, createdTs: 20 });
    // Lexicographic: affinity desc FIRST, then priority — equal priority, so affinity
    // breaks the tie. The bee holds libs/sync/*, so F-near (overlapping path) wins.
    const s = spec({
      specVersion: '1.0',
      specId: 'affine',
      revision: 1,
      view: {},
      rank: {
        mode: 'lexicographic',
        terms: [
          { expr: 'affinity(bee.held_paths,item.paths)', dir: 'desc' },
          { expr: 'priority', dir: 'desc' },
        ],
      },
    });
    const r = await getNextWorkItem(s, { assignee: 'bee-1', heldPaths: ['libs/sync/'] }, { harness: H });
    expect(r?.workItem.id).toBe('F-near');
  });

  it('soft-demotes a known lock-conflicting candidate behind independent work', async () => {
    await seedFeature('F-hot', { paths: ['libs/sync/queue.ts'], featureOrder: 1, createdTs: 10 });
    await seedFeature('F-independent', { paths: ['apps/ui/page.tsx'], featureOrder: 9, createdTs: 20 });
    const s = spec({
      specVersion: '1.0',
      specId: 'lock-aware-placement',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    const r = await getNextWorkItem(
      s,
      { assignee: 'bee-1', contendedPaths: ['libs/sync/queue.ts'] },
      { harness: H },
    );
    expect(r?.workItem.id).toBe('F-independent');
  });

  it('never hard-excludes a lock-conflicting item when it is the only candidate', async () => {
    await seedFeature('F-only-hot', { paths: ['libs/sync/queue.ts'], createdTs: 10 });
    const r = await getNextWorkItem(
      DEFAULT_CLAIM_SPEC,
      { assignee: 'bee-1', contendedPaths: ['libs/sync'] },
      { harness: H },
    );
    expect(r?.workItem.id).toBe('F-only-hot');
  });

  it('a glob filter on paths (payload) matches by path prefix', async () => {
    await seedFeature('F-sync-lib', { paths: ['libs/sync/index.ts'], createdTs: 10 });
    await seedFeature('F-ui', { paths: ['apps/ui/page.tsx'], createdTs: 5 });
    const s = spec({
      specVersion: '1.0',
      specId: 'sync-path',
      revision: 1,
      view: { filter: { field: 'paths', op: 'glob', value: 'libs/sync/**' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-sync-lib');
  });

  it('WI-3268: a NOT+glob title filter durably EXCLUDES a keyword class (e.g. p2p) with no tags data', async () => {
    // These items carry NO tags — the pre-existing tag-based exclusion path is a no-op for
    // them (mirrors real papercusp p2p work-items, which are untagged). Title-keyword
    // exclusion is the only lever that can filter them out.
    await seedFeature('F-p2p-1', { title: '[p2p-wiring] offer-store publish leg', createdTs: 5, featureOrder: 1 });
    await seedFeature('F-p2p-2', { title: 'Hyperswarm sidecar isolation', createdTs: 6, featureOrder: 1 });
    await seedFeature('F-normal', { title: 'Fix dashboard pagination bug', createdTs: 100, featureOrder: 9 });
    const s = spec({
      specVersion: '1.0',
      specId: 'exclude-p2p',
      revision: 1,
      view: {
        filter: {
          not: {
            any: [
              { field: 'title', op: 'glob', value: '*p2p*' },
              { field: 'title', op: 'glob', value: '*hyperswarm*' },
            ],
          },
        },
      },
      // priority desc would otherwise favor the p2p items (featureOrder 1 < 9), proving the
      // exclusion — not merely rank ordering — is what keeps them out.
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-normal');
  });

  it('WI-3268: title exclusion is case-insensitive-agnostic-safe — an exact non-matching glob claims nothing excluded', async () => {
    await seedFeature('F-p2p-only', { title: 'p2p federation rig', createdTs: 1, featureOrder: 1 });
    const s = spec({
      specVersion: '1.0',
      specId: 'exclude-p2p-empty',
      revision: 1,
      view: { filter: { not: { field: 'title', op: 'glob', value: '*p2p*' } } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    // The only seeded item matches the excluded pattern ⇒ nothing eligible.
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('EI-18690730909662985: `word` excludes a real p2p title but ADMITS one that merely CONTAINS "p2p" inside a larger word', async () => {
    // `glob`'s `*p2p*` is a bare SUBSTRING match — it wrongly excludes a title like
    // "nonp2p-bug-drain" (the false positive observed live in fleet nonp2p-bug-drain-0725).
    // `word` anchors to Postgres `\m`/`\M` word boundaries so only a real "p2p" WORD is excluded.
    await seedFeature('F-p2p-real', { title: 'p2p handshake retry storm', createdTs: 1, featureOrder: 1 });
    await seedFeature('F-p2p-substring', {
      title: 'Fleet nonp2p-bug-drain scheduler regex false positive',
      createdTs: 2,
      featureOrder: 1,
    });
    const s = spec({
      specVersion: '1.0',
      specId: 'exclude-p2p-word',
      revision: 1,
      view: { filter: { not: { field: 'title', op: 'word', value: 'p2p' } } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-p2p-substring');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. The FLOORS always apply — a spec can never widen past them (D-002).
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — floors ALWAYS apply (D-002: spec narrows+reorders, never un-floors)', () => {
  it('NEVER claims a blocked item even when spec.filter selects it', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 50 });
    await seedFeature('F-blocked', { tags: ['sync'], status: 'open', createdTs: 100 });
    await blockByFeature('F-blocked', 'F-blocker');
    // The spec EXPLICITLY selects F-blocked (tags=sync) — but the readiness floor (a
    // non-terminal blocker) holds it back regardless of the spec.
    const s = spec({
      specVersion: '1.0',
      specId: 'wants-blocked',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();

    // Satisfy the blocker ⇒ the SAME spec now claims it (the floor lifted, not the spec).
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-blocked');
  });

  it('NEVER claims an already-claimed item the spec selects', async () => {
    await seedFeature('F-taken', { tags: ['sync'], takenBy: 'someone-else', createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'wants-taken',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('NEVER claims a non-claimable-status item the spec selects', async () => {
    await seedFeature('F-passed', { tags: ['sync'], status: 'passed', createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'wants-passed',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('skips a blocked higher-ranked item for a ready lower-ranked one', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 1 });
    await seedFeature('F-top', { featureOrder: 1, status: 'open', createdTs: 10 }); // top priority, but blocked
    await seedFeature('F-next', { featureOrder: 5, status: 'open', createdTs: 20 }); // lower priority, ready
    await blockByFeature('F-top', 'F-blocker');
    const s = spec({
      specVersion: '1.0',
      specId: 'priority',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-next');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2b. `states` rides the spec (drain-claim-spec-hardening-2026-07-13 D-002, fixes
//     EI-11300): a fleet leader sets `states` ONCE on the spec; every member inheriting
//     it defaults to that claimable-status subset instead of the plain ['open'] floor.
//     A per-call `opts.states` override still wins. work-item-status-full-unify P-004/P-005:
//     the default claimable token is 'open' (feature `todo` retired); `failing` is opt-in re-drive.
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — `states` rides the spec (D-002, EI-11300)', () => {
  it('a spec-carried `states` claims an item OUTSIDE the plain [\'open\'] default', async () => {
    await seedFeature('F-failing', { status: 'failing', createdTs: 10 });
    const s = spec({
      specVersion: '1.0',
      specId: 'drain-failing',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      states: ['failing'],
    });
    // No per-call `states` override — falls back to the spec's own `states`.
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-failing');
  });

  it('WITHOUT a spec `states` and no per-call override, the plain [\'open\'] default is unchanged', async () => {
    await seedFeature('F-failing-2', { status: 'failing', createdTs: 10 });
    const s = spec({
      specVersion: '1.0',
      specId: 'no-states',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('an explicit per-call `opts.states` OVERRIDES the spec\'s `states` (member judgment wins)', async () => {
    await seedFeature('F-open-only', { status: 'open', createdTs: 5 });
    await seedFeature('F-failing-3', { status: 'failing', createdTs: 1 }); // older, but excluded by the override
    const s = spec({
      specVersion: '1.0',
      specId: 'spec-wants-failing',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      states: ['failing'],
    });
    // The caller explicitly passes states:['open'] — this wins over the spec's ['failing'].
    const r = await getNextWorkItem(s, BEE, { harness: H, states: ['open'] });
    expect(r?.workItem.id).toBe('F-open-only');
  });

  it('a spec `states` covering BOTH open+failing claims whichever ranks first', async () => {
    await seedFeature('F-multi-failing', { status: 'failing', featureOrder: 1, createdTs: 10 });
    await seedFeature('F-multi-open', { status: 'open', featureOrder: 9, createdTs: 20 });
    const s = spec({
      specVersion: '1.0',
      specId: 'drain-both',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      states: ['open', 'failing'],
    });
    // featureOrder 1 (highest priority) wins regardless of which status it carries.
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-multi-failing');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Concurrency — two get_next claim DIFFERENT items (FOR UPDATE SKIP LOCKED).
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — concurrent claims take DIFFERENT items (SKIP LOCKED)', () => {
  it('two simultaneous get_next never double-claim', async () => {
    await seedFeature('F-a', { tags: ['sync'], createdTs: 100 });
    await seedFeature('F-b', { tags: ['sync'], createdTs: 200 });
    const s = spec({
      specVersion: '1.0',
      specId: 'race',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const [r1, r2] = await Promise.all([
      getNextWorkItem(s, { assignee: 'bee-1' }, { harness: H }),
      getNextWorkItem(s, { assignee: 'bee-2' }, { harness: H }),
    ]);
    const ids = [r1?.workItem.id, r2?.workItem.id].sort();
    expect(ids).toEqual(['F-a', 'F-b']); // both claimed, DIFFERENT items
    expect(r1?.workItem.id).not.toBe(r2?.workItem.id);
  });

  it('with only ONE eligible item, exactly one of two racers wins', async () => {
    await seedFeature('F-solo', { tags: ['sync'], createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'race-one',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const [r1, r2] = await Promise.all([
      getNextWorkItem(s, { assignee: 'bee-1' }, { harness: H }),
      getNextWorkItem(s, { assignee: 'bee-2' }, { harness: H }),
    ]);
    const winners = [r1, r2].filter((r) => r != null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.workItem.id).toBe('F-solo');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. DEFAULT_CLAIM_SPEC == today's ordering (D-003: no spec = current behavior).
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — DEFAULT_CLAIM_SPEC reproduces current ordering (D-003)', () => {
  it('with feature_order set, prefers lower feature_order (the Queen-intended order)', async () => {
    await seedFeature('F-hi', { featureOrder: 1, createdTs: 999 });
    await seedFeature('F-lo', { featureOrder: 9, createdTs: 10 });
    await seedFeature('F-mid', { featureOrder: 5, createdTs: 500 });
    // Same ordering claimNextWorkItem applies with a swarmId (feature_order ASC NULLS
    // LAST, then created_ts ASC) — the default spec's priority desc → age asc.
    expect((await getNextWorkItemDefault(BEE, { harness: H }))?.workItem.id).toBe('F-hi');
  });

  it('with NO feature_order anywhere, falls to oldest-first (created_ts ASC) — the legacy claim', async () => {
    await seedFeature('F-old', { createdTs: 10 });
    await seedFeature('F-new', { createdTs: 99 });
    // DEFAULT_CLAIM_SPEC and the legacy affinity-blind claimNextWorkItem must agree.
    const viaDefault = await getNextWorkItemDefault({ assignee: 'bee-A' }, { harness: H });
    expect(viaDefault?.workItem.id).toBe('F-old');
    // Re-seed and cross-check the legacy path picks the SAME item.
    await db.sql`TRUNCATE harness_shared.work_items `;
    await seedFeature('F-old', { createdTs: 10 });
    await seedFeature('F-new', { createdTs: 99 });
    const viaLegacy = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-B' });
    expect(viaLegacy?.id).toBe('F-old');
    expect(viaLegacy?.id).toBe(viaDefault?.workItem.id);
  });

  it('the default spec records default-fixed-ordering@0 provenance', async () => {
    await seedFeature('F-only', { createdTs: 10 });
    const r = await getNextWorkItemDefault(BEE, { harness: H });
    expect(r?.claimedUnder).toEqual({ specId: DEFAULT_CLAIM_SPEC.specId, revision: 0 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Fallback ladder (fleet-backlog-lessons-2026-07-01 P-005, WI-1407): a spec narrowed to
//    one feature-family `kind` widens PAST it (tier 2, widenPastKind) before falling through
//    to the adjacent issue family (tier 3, gated by SCHEDULER_ISSUES_CLAIMABLE) — instead of
//    exiting the moment its exact-kind tier reads empty.
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — fallback ladder (WI-1407): widenPastKind (tier 2) + issue fallthrough (tier 3)', () => {
  afterAll(() => {
    setFlagOverridesForTest(null); // never leak an override past this describe block
  });

  // EI-21288979130080074: the family split must not hide an explicitly prioritized
  // issue behind an unprioritized/promoted feature row. The issue preclaim compares
  // both families atomically using the same feature claim floors.
  it('cross-family priority: a strictly better issue priority preclaims before the feature tier', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedFeature('F-cross-family-feature', { featureOrder: 10, createdTs: 10 });
    await seedIssue('EI-cross-family-better', { featureOrder: 1, createdTs: 100 });
    const phaseDurations: number[] = [];
    const s = spec({
      specVersion: '1.0',
      specId: 'cross-family-priority',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });

    expect((await getNextWorkItem(s, BEE, {
      harness: H,
      onResolutionStep: (step, event) => {
        if (step === 'candidate-priority-issue-preclaim' && event.phase === 'end') {
          phaseDurations.push(event.elapsedMs);
        }
      },
    }))?.workItem.id).toBe('EI-cross-family-better');
    expect(phaseDurations).toHaveLength(1);
    expect(phaseDurations[0]).toEqual(expect.any(Number));
    expect(phaseDurations[0]).toBeGreaterThanOrEqual(0);
    if (process.env.SCHEDULER_PHASE_TIMING === '1') {
      console.log(`SCHEDULER_PHASE_TIMING candidate-priority-issue-preclaim=${phaseDurations[0]!.toFixed(2)}ms`);
    }
  });

  it.each([
    { label: 'equal', featureOrder: 10, issueOrder: 10 },
    { label: 'worse', featureOrder: 10, issueOrder: 20 },
  ])('cross-family priority: an $label issue priority leaves the feature tier first', async ({ featureOrder, issueOrder }) => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedFeature('F-cross-family-feature', { featureOrder, createdTs: 10 });
    await seedIssue('EI-cross-family-not-better', { featureOrder: issueOrder, createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'cross-family-priority-boundary',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });

    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-cross-family-feature');
  });

  it('tier 1: an exact kind match wins outright — no widening needed', async () => {
    await seedFeature('F-exact', { createdTs: 100, kind: 'feature' });
    await seedFeature('RT-older', { createdTs: 10, kind: 'chunk' }); // older, wrong kind
    const s = spec({
      specVersion: '1.0',
      specId: 'kind-feature',
      revision: 1,
      view: { filter: { field: 'kind', op: '=', value: 'feature' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-exact');
  });

  // enterprise-data-sources-2026-10-01 D-022 point 2: chunks are excluded by the STATUS
  // floors, not by a kind case, and every live chunk row is terminal (done/passed/dropped).
  // So a retired chunk is seeded terminal; an open chunk is a state that no longer occurs.
  it('retired chunks remain outside tier 2 after a feature-narrowed miss', async () => {
    await seedFeature('RT-1', { createdTs: 100, kind: 'chunk', status: 'done' });
    const s = spec({
      specVersion: '1.0',
      specId: 'kind-feature-widen',
      revision: 1,
      view: { filter: { field: 'kind', op: '=', value: 'feature' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('a co-existing tags narrowing cannot re-admit retired chunks', async () => {
    await seedFeature('RT-sync', { createdTs: 100, kind: 'chunk', tags: ['sync'], status: 'passed' });
    await seedFeature('RT-docs', { createdTs: 10, kind: 'chunk', tags: ['docs'], status: 'dropped' }); // older, wrong tag
    const s = spec({
      specVersion: '1.0',
      specId: 'kind-and-tag',
      revision: 1,
      view: {
        filter: {
          all: [
            { field: 'kind', op: '=', value: 'feature' },
            { field: 'tags', op: 'contains', value: 'sync' },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('retired chunks stay excluded after a historical blocker settles', async () => {
    await seedFeature('CH-blocker', { createdTs: 1, kind: 'chunk', status: 'wip' });
    await seedFeature('CH-blocked', { createdTs: 50, kind: 'chunk', status: 'dropped' });
    await blockByFeature('CH-blocked', 'CH-blocker');
    const s = spec({
      specVersion: '1.0',
      specId: 'kind-blocked-widen',
      revision: 1,
      view: { filter: { field: 'kind', op: '=', value: 'feature' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='CH-blocker'`;
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('tier 3: kind="feature" narrowed and the WHOLE feature family dry falls through to an open issue when SCHEDULER_ISSUES_CLAIMABLE is ON', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('EI-t3-on', { state: 'open', createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'kind-feature-issue-fallthrough',
      revision: 2,
      view: { filter: { field: 'kind', op: '=', value: 'feature' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const phaseEvents: Array<{ step: string; phase: string }> = [];
    const r = await getNextWorkItem(s, BEE, {
      harness: H,
      onResolutionStep: (step, event) => phaseEvents.push({ step, phase: event.phase }),
    });
    expect(r?.workItem.id).toBe('EI-t3-on');
    expect(r?.claimedUnder).toEqual({ specId: 'kind-feature-issue-fallthrough', revision: 2 });
    expect(phaseEvents.filter(({ step }) => step === 'candidate-issue-claim-update').map(({ phase }) => phase))
      .toEqual(['start', 'end']);
    expect(phaseEvents.filter(({ step }) => step === 'candidate-issue-post-claim-reread').map(({ phase }) => phase))
      .toEqual(['start', 'end']);
  });

  it('reuses the bounded candidate authority read for the issue tier', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('EI-one-authority-read', { state: 'open' });
    const operationClaims = await import('../blueprint/operation-worker-binding');
    const read = vi.spyOn(operationClaims, 'readActiveOperationWorkerClaimBinding');
    try {
      expect((await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H }))?.workItem.id)
        .toBe('EI-one-authority-read');
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  it('retries the issue-family claim after one transient PostgreSQL contention error', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('EI-scheduler-contention-retry', { state: 'open' });

    const originalSql = h.sql;
    let injectedFailures = 0;
    const interceptSql = (client: typeof originalSql): typeof originalSql => new Proxy(client, {
      apply(target, thisArg, args) {
        const strings = args[0];
        const statement = Array.isArray(strings) ? strings.join('').replace(/\s+/g, ' ') : '';
        if (statement.includes('UPDATE harness_shared.work_items AS target') && injectedFailures === 0) {
          injectedFailures += 1;
          throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        }
        return Reflect.apply(target, thisArg, args);
      },
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'begin') return value;
        return (...args: unknown[]) => {
          const callback = args.at(-1);
          if (typeof callback === 'function') {
            args[args.length - 1] = (transaction: postgres.TransactionSql) =>
              callback(interceptSql(transaction as unknown as typeof originalSql));
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    h.sql = interceptSql(originalSql);

    try {
      const result = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H });
      expect(result?.workItem.id).toBe('EI-scheduler-contention-retry');
    } finally {
      h.sql = originalSql;
    }

    expect(injectedFailures).toBe(1);
  });

  it('tier 3: an issue-kind spec narrows issue fallback instead of claiming an older task', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('WI-task-owner-reserved', { state: 'open', createdTs: 10, kind: 'task' });
    await seedIssue('EI-bug', { state: 'open', createdTs: 100, kind: 'bug' });
    const s = spec({
      specVersion: '1.0',
      specId: 'bug-change-issue-fallthrough',
      revision: 3,
      view: {
        filter: {
          all: [
            { field: 'kind', op: 'in', value: ['bug', 'change'] },
            { field: 'id', op: '!=', value: 'WI-task-owner-reserved' },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('EI-bug');
    expect(r?.workItem.kind).toBe('bug');
    expect(r?.claimedUnder).toEqual({ specId: 'bug-change-issue-fallthrough', revision: 3 });
  });

  it('tier 3: the SAME kind-narrowed request stays dry when SCHEDULER_ISSUES_CLAIMABLE is OFF (the flag, not the kind narrowing, gates it — WI-1407 regression)', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: false });
    await seedIssue('EI-t3-off', { state: 'open', createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'kind-feature-issue-gated-off',
      revision: 1,
      view: { filter: { field: 'kind', op: '=', value: 'feature' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  // EI-7481: a bug-only spec (an ISSUE-family kind) must never leak into the FEATURE family.
  // widenPastKind's "widen to the rest of the feature family" (tier 2) is meaningful only when
  // the dropped kind constraint admitted a feature-family kind — an issue-only kind='bug' spec
  // has no feature-family sibling to widen to (its lane is issues), so tier 2 must be a no-op and
  // the bug-only member must NOT claim a feature/chunk.
  it('tier 2 (EI-7481): a bug-only kind spec does NOT widen into the feature family', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: false });
    await seedFeature('F-in-backlog', { createdTs: 100 }); // a claimable feature the bug spec must ignore
    const s = spec({
      specVersion: '1.0',
      specId: 'bugs-only-drain',
      revision: 3,
      view: { filter: { field: 'kind', op: '=', value: 'bug' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    // Tier 1 dry (no bug in the feature table), tier 2 must not widen to F-in-backlog, tier 3 off.
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  // EI-7481 (the reported shape): under a bare-leaf `kind='bug'` spec with the issue lane ON, the
  // whole ladder must stay in the bug lane — never a feature (tier-2 leak) and never a `task`
  // (tier-3 leak, WI-2118's ping-pong): it claims the open BUG and only the bug.
  it('tier 3 (EI-7481): a bare-leaf bug spec claims the bug — never a feature or a task', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedFeature('F-feature-lane', { createdTs: 1 }); // oldest — would win tier-2 widen if it leaked
    await seedIssue('WI-2118', { state: 'open', createdTs: 10, kind: 'task' }); // the forbidden task
    await seedIssue('EI-real-bug', { state: 'open', createdTs: 100, kind: 'bug' });
    const s = spec({
      specVersion: '1.0',
      specId: 'bugs-only-drain',
      revision: 3,
      view: { filter: { field: 'kind', op: '=', value: 'bug' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('EI-real-bug');
    expect(r?.workItem.kind).toBe('bug');
  });

  // EI-18665895916759270 (live incident, 2026-07-25, fleet nonp2p-bug-drain-0725): 10 live members
  // claimed NOTHING for ~25 min because tier 3 — the ONLY tier that serves issue-family work —
  // matched zero rows for any spec carrying a `not` leg, while work_items:claimable (which
  // compiles the SAME tree via issueClaimCandidateSubquery) correctly reported 43. The two halves
  // of the failure, one test each:
  //
  //  (a) the `not` leg must be HONORED by the claim path, not merely re-checked in JS AFTER an
  //      unentitled claim. Before the specFilterSql threading, tier 3 saw only issueKinds/ids, so
  //      it drew a violator and leaned on the post-claim matchesWorkItemClaimSpec release-retry —
  //      which shares MAX_PLAN_LANE_ATTEMPTS (5), so a narrow lane reported a FALSE drain on ~88%
  //      of pulls (and burned 30-40s per miss doing five claim+release round-trips).
  //  (b) …and threading it must NOT drag the feature-family `kind` leaf into a query whose rows
  //      are all bug/change/task — an unsatisfiable predicate that zeroes the tier outright. That
  //      is the pairing the two asserts below pin: a `not` leg alongside a `kind='feature'` spec.
  it('tier 3 (EI-18665895916759270): a `not` leg is honored by the CLAIM path — the excluded item is skipped and the other is served', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    // Older, so it wins the age-asc rank and WOULD be claimed if the `not` leg were dropped.
    await seedIssue('EI-p2p-excluded', { state: 'open', createdTs: 1, kind: 'bug', title: 'p2p sidecar flake' });
    await seedIssue('EI-in-lane', { state: 'open', createdTs: 100, kind: 'bug', title: 'scheduler drift' });
    const s = spec({
      specVersion: '1.0',
      specId: 'nonp2p-bug-drain',
      revision: 2,
      view: {
        filter: {
          all: [
            { field: 'kind', op: 'in', value: ['bug'] },
            { not: { field: 'title', op: 'glob', value: '*p2p*' } },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('EI-in-lane'); // NOT the older excluded one
  });

  // The other half: the SAME `not` leg on a feature-narrowed spec must still fall through to the
  // adjacent open issue (WI-1407's tier-3 contract). Threading the raw tree compiled
  // `kind='feature'` into the issue query — always false there — so this returned null.
  it('tier 3 (EI-18665895916759270): a feature-narrowed spec with a `not` leg still falls through to an issue (the kind leaf is widened past, the `not` is kept)', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('EI-p2p-skip', { state: 'open', createdTs: 1, kind: 'bug', title: 'p2p relay retry' });
    await seedIssue('EI-fallthrough', { state: 'open', createdTs: 100, kind: 'bug', title: 'lock lease audit' });
    const s = spec({
      specVersion: '1.0',
      specId: 'feature-lane-with-exclusion',
      revision: 4,
      view: {
        filter: {
          all: [
            { field: 'kind', op: '=', value: 'feature' },
            { not: { field: 'title', op: 'glob', value: '*p2p*' } },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    // Widened past `kind='feature'` (else zero rows), but the `not` leg still excludes the p2p one.
    expect(r?.workItem.id).toBe('EI-fallthrough');
  });

  it.each([false, true])('WI-10002617: a feature-only fleet never claims an adjacent change (priority=%s)', async (priority) => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('EI-fleet-outside', { kind: 'change', featureOrder: 1 });
    const s = spec({
      specVersion: '1.0', specId: 'strict-feature-fleet', revision: 6,
      view: { filter: { all: [
        { field: 'kind', op: 'in', value: ['feature'] },
        { not: { field: 'title', op: 'word', value: 'p2p' } },
      ] } },
      rank: { mode: 'lexicographic', terms: priority
        ? [{ expr: 'priority', dir: 'desc' }, { expr: 'age', dir: 'asc' }]
        : [{ expr: 'age', dir: 'asc' }] },
    });
    const opts = { harness: H, fleetSlug: 'strict-feature-fleet' };
    expect(await getNextWorkItem(s, BEE, opts)).toBeNull();
    const [outside] = await db.sql`SELECT taken_by FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = 'EI-fleet-outside'`;
    expect(outside.taken_by).toBeNull();

    await seedFeature('F-fleet-inside', { featureOrder: 100 });
    expect((await getNextWorkItem(s, BEE, opts))?.workItem.id).toBe('F-fleet-inside');
    const [stillOutside] = await db.sql`SELECT taken_by FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = 'EI-fleet-outside'`;
    expect(stillOutside.taken_by).toBeNull();
  });

  it('WI-10002617: a fleet still claims an issue admitted by a nested mixed-family filter', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('EI-fleet-admitted', { kind: 'change' });
    const s = spec({
      specVersion: '1.0', specId: 'mixed-family-fleet', revision: 1,
      view: { filter: { all: [
        { any: [
          { field: 'kind', op: '=', value: 'feature' },
          { field: 'id', op: '=', value: 'EI-fleet-admitted' },
        ] },
        { not: { field: 'title', op: 'word', value: 'p2p' } },
      ] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H, fleetSlug: 'mixed-family-fleet' }))?.workItem.id)
      .toBe('EI-fleet-admitted');
  });

  // EI-10062 (and its duplicate trail: EI-9887/9888/9896/10002/10040): a leader's hand-curated
  // `id IN (...)` drain-list spec has NO `kind` leaf at all, so issueKindsForFallback found no
  // lane constraint to carry over and tier 3 widened to the ENTIRE unrestricted issue family —
  // once every named id was claimed/terminal, the fleet started claiming unrelated open issues
  // from a completely different work-stream instead of correctly reporting nothing left.
  it('tier 3 (EI-10062): an exhausted id-allowlist spec must NOT widen to an unrelated open issue', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    // The named id is already resolved (not floor-eligible) — the allowlist is exhausted.
    await seedIssue('WI-named', { state: 'resolved', createdTs: 5, kind: 'bug' });
    // An unrelated OPEN bug that is NOT in the allowlist — must never be claimed.
    await seedIssue('EI-unrelated', { state: 'open', createdTs: 100, kind: 'bug' });
    const s = spec({
      specVersion: '1.0',
      specId: 'id-allowlist-drain',
      revision: 20,
      view: { filter: { all: [{ field: 'id', op: 'in', value: ['WI-named'] }] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  // Sanity companion to the above: the fix must not break the WORKING case — an id-allowlist
  // spec still claims the named item when it is genuinely open, and ignores an unrelated open
  // issue that isn't in the list.
  it('tier 1 (EI-10062 sanity): an id-allowlist spec claims the named item, ignoring an unrelated open issue', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    // Tier 1's attempt() queries harness_features_consolidated (the feature-family table)
    // directly — seedFeature (not seedIssue) puts the named target where tier 1 can see it.
    await seedFeature('EI-target', { createdTs: 5 });
    await seedFeature('EI-unrelated', { createdTs: 1 }); // older — would win if the allowlist leaked
    const s = spec({
      specVersion: '1.0',
      specId: 'id-allowlist-drain',
      revision: 20,
      view: { filter: { all: [{ field: 'id', op: 'in', value: ['EI-target'] }] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('EI-target');
  });

  // WI-4309: EI-10062's original fix skipped tier 3 ENTIRELY whenever the spec carried an id
  // constraint — correct for the exhausted-allowlist case above, but it also meant an
  // ISSUE-ONLY id-allowlist (no `kind` leaf, e.g. a leader's hand-curated bug-drain wave of
  // EI-/WI- ids) could NEVER be served: tier 1 only queries the feature-family table (can't
  // match an issue-family id), tier 2 has no `kind` leaf to widen, and tier 3 was skipped too —
  // a false, PERMANENT drain even while the named item sat open+unclaimed. The fix threads the
  // extracted id set through tier 3 instead of disabling it.
  it('tier 3 (WI-4309): an issue-only id-allowlist spec serves a named OPEN issue, not a false drain', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    // Named + open — must be served. seedIssue (not seedFeature): an issue-family row, so tier 1
    // structurally cannot see it (harness_features_consolidated excludes issue-family kinds).
    await seedIssue('EI-named-open', { state: 'open', createdTs: 100, kind: 'bug' });
    // Unrelated open issue NOT in the allowlist — must never be claimed (still EI-10062-safe).
    await seedIssue('EI-unrelated-open', { state: 'open', createdTs: 1, kind: 'bug' });
    const s = spec({
      specVersion: '1.0',
      specId: 'id-allowlist-drain-open',
      revision: 21,
      view: { filter: { all: [{ field: 'id', op: 'in', value: ['EI-named-open', 'WI-also-named-but-absent'] }] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('EI-named-open');
    expect(r?.claimedUnder).toEqual({ specId: 'id-allowlist-drain-open', revision: 21 });
  });

  // WI-4309 companion: a bare (non-`all`-wrapped) `id in [...]` leaf — the OTHER shape
  // idValuesForFallback must extract from — also serves the named issue.
  it('tier 3 (WI-4309): a bare `id in [...]` leaf (not wrapped in `all`) also serves the named open issue', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('EI-bare-leaf-target', { state: 'open', createdTs: 100, kind: 'change' });
    await seedIssue('EI-bare-leaf-unrelated', { state: 'open', createdTs: 1, kind: 'change' });
    const s = spec({
      specVersion: '1.0',
      specId: 'id-allowlist-bare-leaf',
      revision: 1,
      view: { filter: { field: 'id', op: 'in', value: ['EI-bare-leaf-target'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('EI-bare-leaf-target');
  });

  // WI-5275 (live incident, 2026-07-17, backlog-drain-clean@12): an id leaf nested in an
  // `any` (OR) branch is a WIDENING exception, not a closed-world narrowing constraint — the
  // OLD code (the now-removed filterHasIdConstraint) treated ANY id leaf found anywhere in the
  // tree as "the spec names an explicit id set", and since positiveIdCohortIds correctly
  // refuses to extract a set from an `any` shape, the ladder fell into "can't safely extract ⇒
  // skip tier 3 entirely" — permanently starving the WHOLE fleet of its entire bug/change/task
  // backlog (tier 3 is the ONLY path that serves issue-family work) whenever a spec pinned even
  // one extra id via an `any` clause, exactly the live backlog-drain-clean@12 shape. The fix:
  // tier 3 always runs; it narrows by `ids` only when positiveIdCohortIds can safely extract a
  // genuine closed-world set (unchanged EI-10062/WI-4309 guarantee below).
  //
  // At THIS layer (getNextWorkItem, called directly, no wrapper) tier 3's SQL-side query can
  // only narrow by kind/id when those are safely extractable — that has ALWAYS been true (a
  // title/plan/paths constraint was never pushed into tier 3's SQL either, even pre-fix); full
  // filter correctness for whatever tier 3's SQL can't narrow by has always been the CALLER's
  // job (claim-spec-store.ts's getNextForBee: mandatory post-claim `matchesWorkItemClaimSpec` +
  // bounded release-and-retry — independently covered by
  // get-next-for-bee-plan-lane-guard.test.ts's generic "quarantines an issue-family fallback
  // that fails the complete claim spec" case, which doesn't care what filter shape caused the
  // mismatch). So this test proves exactly what changed at this layer: a single item that only
  // an `any`-nested id leaf admits is now SERVED instead of producing a false, permanent miss.
  it('tier 3 (WI-5275): an id leaf nested in `any` no longer starves tier 3 — it still serves a matching item', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    // Only admitted via the `any`'s id branch — kind='task' does not match the kind='bug' branch.
    await seedIssue('EI-any-named', { state: 'open', createdTs: 100, kind: 'task' });
    const s = spec({
      specVersion: '1.0',
      specId: 'id-allowlist-any-shape',
      revision: 1,
      view: {
        filter: {
          any: [
            { field: 'id', op: 'in', value: ['EI-any-named'] },
            { field: 'kind', op: '=', value: 'bug' },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('EI-any-named');
  });

  // backlog-drain-clean@6 live incident (2026-07-17): a fleet leader's spec excluded 2
  // already-handled ids via `{ not: { field:'id', op:'in', value:[...] } }` — a NEGATIVE
  // exclusion, structurally identical in intent to `id != X` (already proven safe above)
  // but expressed via the `not` combinator instead of the `!=` op. Before the fix,
  // filterHasIdConstraint's `return walk(node.not)` recursed into the inner leaf and read
  // it AS IF UNNEGATED — a bare `{field:'id', op:'in'}` reads as a positive closed-world
  // allowlist — so this ordinary exclusion inside an otherwise wide-open kind-restricted
  // spec was misdiagnosed as "the spec names an explicit id set", landed on the
  // can't-safely-extract branch (positiveIdCohortIds correctly returns null for a
  // not-wrapped leaf), and skipped tier 3 ENTIRELY — a whole 10-member issue-family fleet
  // silently starved against a genuinely open, unbounded issue lane. This is the OPPOSITE
  // shape of the `any` conservatism test above: a `not`-wrapped id leaf must NEVER count
  // as a positive constraint (a negation can't express a closed-world allowlist), so tier
  // 3 must run and serve the non-excluded item.
  it('tier 3: a NOT-wrapped id EXCLUSION (`not:{id in [...]}`) is a negative exclusion, not a positive allowlist — tier 3 still serves the non-excluded open issue', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssue('EI-excluded', { state: 'open', createdTs: 100, kind: 'bug' });
    await seedIssue('EI-other', { state: 'open', createdTs: 200, kind: 'bug' });
    const s = spec({
      specVersion: '1.0',
      specId: 'not-id-exclusion',
      revision: 1,
      view: {
        filter: {
          all: [
            { field: 'kind', op: 'in', value: ['bug'] },
            { not: { field: 'id', op: 'in', value: ['EI-excluded'] } },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('EI-other');
  });

  // EI-11291 (drain-claim-spec-hardening-2026-07-13 P-001): a `kind`-filtered claim spec
  // must match on the `item_kind` discriminator, NEVER the legacy `kind` column (unrelated
  // free-text metadata — 'security'/'infra'/etc on a handful of rows, NULL on the rest). The
  // live repro that filed the EI found no evidence the mapping was actually wrong (the
  // FIELD_MAP already targeted item_kind) — this test pins the exact repro shape the EI names
  // AND additionally proves the legacy `kind` column, even when POPULATED with a conflicting
  // value, can never win (P-001/D-001's COALESCE(item_kind, kind) — item_kind first).
  it('EI-11291: a bare-leaf `{ field:"kind", op:"in", value:["bug"] }` spec matches an open item_kind=\'bug\' row, ignoring a populated legacy `kind` column', async () => {
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    // The legacy `kind` column is populated with an UNRELATED value (real production rows carry
    // things like 'security'/'infra' there) — if the evaluator ever regressed to reading `kind`
    // instead of `item_kind`, this row would silently fail to match, reproducing EI-11291 exactly.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, kind, status, workspace_id, created_ts, updated_ts)
      VALUES (${H}, 'EI-11291-bug', 'bug', 'infra', 'open', ${WS}, 100, 0)`;
    const s = spec({
      specVersion: '1.0',
      specId: 'ei-11291-kind-bug-drain',
      revision: 1,
      view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H, states: ['open'] });
    expect(r?.workItem.id).toBe('EI-11291-bug');
    expect(r?.workItem.kind).toBe('bug');
  });
});
