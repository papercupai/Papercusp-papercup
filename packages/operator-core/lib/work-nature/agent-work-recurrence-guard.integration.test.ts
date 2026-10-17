/**
 * agent-work-recurrence-guard.integration.test.ts — the P-012 recurrence guard for the ONE
 * work predicate (plan enterprise-data-sources-2026-10-01; P-009 / D-011 / D-022 / D-024).
 *
 * WHAT IT PROVES. Seeds one work_items row per (nature, audience) class from the P-007
 * census seed table (WORK_SELECTION_SEED_ROWS), plus the two natures that have no live
 * instances yet (document, event), then DRAINS every self-select door until it returns
 * nothing — exactly what an agent told to "drain the queue" does. Every door may serve
 * only rows that are agent work, and every door must serve at least one row, so a door
 * that silently stopped serving anything cannot pass vacuously.
 *
 * WHY IT IS A RECURRENCE GUARD, not a one-off check: the door table is tied to the census.
 * Every `selection` row of WORK_SELECTION_CENSUS must be exercised by a door here or name
 * the door it delegates to (COVERED_BY). Adding a selection path to the census without a
 * door fails this file, and a door whose census id disappears fails it too.
 *
 * THE BY-ID ASYMMETRY IS DELIBERATE (D-024). The by-id claim applies only the CATEGORY half
 * of the predicate (nature + audience). Readiness floors — owner action, the observation
 * lane — stay off the by-id door (work-item-dependency-edges-2026-08-02#D-008: claiming by
 * name is the operator override). So the by-id test asserts only that every non-agent
 * CATEGORY is refused and agent work is still served; it says nothing about lane or owner
 * action rows, and must not be "tidied" into the self-select expectation.
 *
 * FIXTURE NOTE. This narrow fixture has no D-018 stamping trigger (production derives
 * nature/audience from datatype_registry at mint), so each row's category is written
 * directly, as the trigger would stamp it for that kind (stampedCategory below).
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   npm run test:file -- packages/operator-core/lib/work-nature/agent-work-recurrence-guard.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  applyClaimPathReadDeps,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { WORK_SELECTION_CENSUS, WORK_SELECTION_SEED_ROWS, type WorkSelectionSeedRow } from '../work-selection-census';
import { isAgentWork } from './agent-work-predicate';
import type { ResolutionStepEvent } from '../scheduler/get-next';
import { pendingDetachedCount } from '../detached-imports';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const leaderDispatchAdmission = vi.hoisted(() => ({
  resolveFleetScopeContext: vi.fn(),
  fleetControlWindDownRefusal: vi.fn(),
  leaderDispatchedAdmission: vi.fn(),
  selfFiledFalloutAdmission: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('../work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: async () => ({ releases: [], failures: 0, skipped: null }),
}));
vi.mock('../scheduler/fleet-scope-admission', () => ({
  resolveFleetScopeContext: (...a: unknown[]) => leaderDispatchAdmission.resolveFleetScopeContext(...a),
  fleetControlWindDownRefusal: (...a: unknown[]) => leaderDispatchAdmission.fleetControlWindDownRefusal(...a),
  leaderDispatchedAdmission: (...a: unknown[]) => leaderDispatchAdmission.leaderDispatchedAdmission(...a),
  selfFiledFalloutAdmission: (...a: unknown[]) => leaderDispatchAdmission.selfFiledFalloutAdmission(...a),
}));

const WS = 'default';
const H = 'papercup';

const wi = await import('../work-items');
const { getOrgPg } = await import('@papercusp/db-org');
const { boundedOrgTxn } = await import('../pg-bounded-txn');
const { getNextWorkItemDefault, readIssueClaimability } = await import('../scheduler/get-next');

// ---------------------------------------------------------------------------
// The seed population.
// ---------------------------------------------------------------------------

/** Every value the work_items.nature column carries (migration 1322 column comment, D-011). */
const NATURES = ['work', 'record', 'document', 'event'] as const;

/**
 * Natures with no work_items instances today. The census defers their seeds to P-012; the
 * column admits them, so a guard over "every nature" seeds them too.
 */
const EXTRA_SEEDS: readonly WorkSelectionSeedRow[] = [
  { itemKind: 'org-document', nature: 'document', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'P-012: document nature (D-005)' },
  { itemKind: 'slack-message', nature: 'event', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'P-012: event nature (D-001)' },
];

interface Seeded {
  id: string;
  seed: WorkSelectionSeedRow;
  nature: string;
  audience: string | null;
  status: string;
}

/**
 * What the D-018 trigger stamps for the seed's kind. Two census labels are not nature
 * values: 'internal-excluded' (an observation-lane row) and 'retired' (chunk) are kinds the
 * registry maps to work/agent, so the exclusion must come from the lane or from the
 * terminal status — D-022 point 2 says to seed chunk terminal rather than add a chunk case.
 * The needs-owner-action row is a bug, which the trigger stamps work/agent; stamping it
 * 'human' would let the audience test hide a broken needs_owner_action exclusion.
 */
function stampedCategory(seed: WorkSelectionSeedRow): { nature: string; audience: string | null; status: string } {
  if (seed.nature === 'internal-excluded') return { nature: 'work', audience: 'agent', status: seed.status };
  if (seed.nature === 'retired') return { nature: 'work', audience: 'agent', status: 'passed' };
  if (seed.payload.needsOwnerAction === true) return { nature: 'work', audience: 'agent', status: seed.status };
  return { nature: seed.nature, audience: seed.audience, status: seed.status };
}

const SEEDS: Seeded[] = [...WORK_SELECTION_SEED_ROWS, ...EXTRA_SEEDS].map((seed, i) => ({
  id: `NG-${String(i).padStart(2, '0')}-${seed.itemKind}`,
  seed,
  ...stampedCategory(seed),
}));
const EXPECTED = new Set(SEEDS.filter((s) => s.seed.expectAgentClaimable).map((s) => s.id));
const label = (id: string) => {
  const s = SEEDS.find((x) => x.id === id);
  return s ? `${id} (${s.nature}/${s.audience ?? '-'} ${JSON.stringify(s.seed.payload)} ${s.status})` : `${id} (not seeded)`;
};

async function seedAll(): Promise<void> {
  for (const [i, s] of SEEDS.entries()) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, item_kind, status, taken_by, workspace_id, created_ts, updated_ts,
         origin, payload, nature, audience)
      VALUES (${H}, ${s.id}, ${`seed ${s.id}`}, ${s.seed.itemKind}, ${s.status}, NULL, ${WS}, ${100 + i}, 0,
              'local', ${JSON.stringify(s.seed.payload)}::text::jsonb, ${s.nature}, ${s.audience})`;
  }
}

// ---------------------------------------------------------------------------
// The door table — every `selection` path of the P-007 census.
// ---------------------------------------------------------------------------

interface DrainDoor {
  name: string;
  /** WORK_SELECTION_CENSUS ids this door exercises. */
  census: string[];
  /** Claim the next item; null when the door has nothing left to serve. */
  next: () => Promise<string | null>;
}

const DRAIN_DOORS: DrainDoor[] = [
  {
    name: 'claimNextWorkItem (feature floors + frontier placement)',
    census: ['claim-floors-feature', 'frontier-placement-clause', 'claim-next-tool'],
    next: async () => (await wi.claimNextWorkItem({ harness: H, assignee: 'drain-probe' }))?.id ?? null,
  },
  {
    name: 'claimNextIssueWorkItem (issue family)',
    census: ['claim-next-tool'],
    next: async () => (await wi.claimNextIssueWorkItem({ harness: H, assignee: 'drain-probe' }, WS))?.id ?? null,
  },
  {
    name: 'getNextWorkItemDefault (scheduler:get_next)',
    census: ['get-next-issue'],
    next: async () => (await getNextWorkItemDefault({ assignee: 'drain-probe' }, {
      harness: H,
      onResolutionStep(step, event) {
        resolutionSteps.push({ step, event });
        if (resolutionSteps.length > 64) resolutionSteps.shift();
      },
    }))?.workItem.id ?? null,
  },
];

/** Census selection rows with no door of their own, and the door that carries them. */
const COVERED_BY: Record<string, string> = {
  'fleet-scope-admission': 'getNextWorkItemDefault — the census row delegates to the get-next floors',
  'claimable-tool': 'readIssueClaimability preview test below',
  'by-id-claim': 'claimWorkItem by-id test below',
};

async function drain(door: DrainDoor): Promise<string[]> {
  const served: string[] = [];
  for (let i = 0; i <= SEEDS.length; i++) {
    let id: string | null;
    try {
      id = await door.next();
    } catch (error) {
      // EI-25821274890357735: an acquisition deadline alone cannot distinguish an
      // unreachable client from queued transactions. Measure this isolated fixture,
      // using a separate diagnostic connection so the failing pool cannot hide it.
      console.error('[agent-work-fixture-diagnostic]', JSON.stringify({
        door: door.name, served, transactions: fixtureTransactions.slice(-16),
        resolutionSteps: resolutionSteps.slice(-24), detachedWork: pendingDetachedCount(),
        database: await fixtureDatabaseWaits(),
      }));
      throw error;
    }
    if (id === null) return served;
    if (served.includes(id)) throw new Error(`${door.name} served ${id} twice — the claim did not stick`);
    served.push(id);
  }
  throw new Error(`${door.name} served more rows than were seeded: ${served.join(', ')}`);
}

// ---------------------------------------------------------------------------

let db: FreshPgDb;
const resolutionSteps: Array<{ step: string; event: ResolutionStepEvent }> = [];
interface FixtureTransaction {
  requestedAt: number;
  acquiredAt?: number;
  settledAt?: number;
}
const fixtureTransactions: FixtureTransaction[] = [];

async function fixtureDatabaseWaits(): Promise<unknown> {
  const probe = postgres(db.url, {
    max: 1, connect_timeout: 3, prepare: false,
    connection: { application_name: 'agent-work-fixture-diagnostic', statement_timeout: 1500 },
  });
  try {
    return await probe`
      SELECT pid, state, wait_event_type, wait_event,
             extract(epoch FROM (clock_timestamp() - query_start)) AS query_age_seconds,
             split_part(ltrim(query), ' ', 1) AS statement,
             pg_blocking_pids(pid) AS blocked_by
        FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
       ORDER BY pid LIMIT 12`;
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  } finally {
    await probe.end({ timeout: 1 });
  }
}

beforeAll(async () => {
  db = await createFreshPgDb('agent-work-recurrence-guard');
  h.sql = db.sql;
  // Preserve the real client's transaction semantics; only record request,
  // callback entry (connection acquired), and settlement in this test process.
  const begin = db.sql.begin.bind(db.sql) as (...args: unknown[]) => Promise<unknown>;
  db.sql.begin = ((...args: unknown[]) => {
    const callback = args.at(-1) as (tx: postgres.TransactionSql) => unknown;
    const measurement: FixtureTransaction = { requestedAt: Date.now() };
    fixtureTransactions.push(measurement);
    return begin(...args.slice(0, -1), async (tx: postgres.TransactionSql) => {
      measurement.acquiredAt = Date.now();
      return callback(tx);
    }).finally(() => { measurement.settledAt = Date.now(); });
  }) as typeof db.sql.begin;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // The claim path reads the active operation-worker receipt (adv_sessions / session_briefs /
  // blueprint_specifications). Without them every claim throws "operation claim authority
  // unavailable" — the WI-10005130 fixture gap — and this guard would measure nothing.
  await db.sql
    .unsafe(`
      CREATE TABLE harness_shared.adv_sessions (
        id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
        role text, started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz, ended_by text, launch_spec jsonb
      );
      CREATE TABLE harness_shared.session_briefs (
        workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb,
        PRIMARY KEY (workspace_id, owner_id)
      );
      CREATE TABLE harness_shared.blueprint_specifications (
        workspace_id text NOT NULL, harness_slug text NOT NULL,
        specification_revision text NOT NULL, artifact jsonb NOT NULL,
        PRIMARY KEY (workspace_id, harness_slug, specification_revision)
      );
      ALTER TABLE harness_shared.work_items
        ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
        ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
        ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`)
    .simple();
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'agent-work-recurrence-guard.integration.test.ts' });
  await ensureCoordCapabilityTables(db.sql);
  // The shared claim-path read dependencies (WI-10005130). LAST on purpose: every statement
  // is IF NOT EXISTS, so it fills only what the hand-built tables and the event-substrate
  // migrations above did not create; run first, those would fail with "already exists".
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  expect(getOrgPg().sql).toBe(db.sql);
  resolutionSteps.length = 0;
  fixtureTransactions.length = 0;
  await db.sql`
    TRUNCATE harness_shared.work_items,
             harness_shared.event_awaits,
             harness_shared.event_wake_deliveries,
             harness_shared.event_key_fires,
             harness_shared.predicate_watches`;
  leaderDispatchAdmission.resolveFleetScopeContext.mockReset().mockResolvedValue(null);
  leaderDispatchAdmission.fleetControlWindDownRefusal.mockReset().mockResolvedValue(null);
  leaderDispatchAdmission.leaderDispatchedAdmission.mockReset().mockResolvedValue(false);
  leaderDispatchAdmission.selfFiledFalloutAdmission.mockReset().mockReturnValue(false);
  await seedAll();
});

describe('P-012: the seed population and the door table are complete', () => {
  it('the transaction client uses the isolated fixture database', async () => {
    const expectedDatabase = decodeURIComponent(new URL(db.url).pathname.slice(1));
    const rows = await getOrgPg().sql.begin((tx) => tx`SELECT current_database() AS database`);
    expect(rows[0]?.database).toBe(expectedDatabase);
    expect(fixtureTransactions).toHaveLength(1);
    expect(fixtureTransactions[0].acquiredAt).toBeDefined();
    expect(fixtureTransactions[0].settledAt).toBeDefined();
  });

  it('diagnostics distinguish a queued transaction from an unreachable database', async () => {
    // Reserve the helper's four real connections, leaving BEGIN queued while a
    // separate diagnostic connection can prove that this same database is reachable.
    const reserved = await Promise.all(Array.from({ length: 4 }, () => db.sql.reserve()));
    const callback = vi.fn(async (tx: typeof db.sql) => tx`SELECT 1`);
    try {
      await expect(boundedOrgTxn(callback, {
        client: db.sql, acquireTimeoutMs: 25, acquireRetries: 0, connectionSetupRetries: 0,
      })).rejects.toMatchObject({ name: 'DbCallDeadlineError' });
      expect(fixtureTransactions).toHaveLength(1);
      expect(fixtureTransactions[0].acquiredAt).toBeUndefined();
      expect(callback).not.toHaveBeenCalled();
      const waits = await fixtureDatabaseWaits();
      expect(Array.isArray(waits)).toBe(true);
      const clients = waits as Array<{ state: string; blocked_by: number[] }>;
      expect(clients).toHaveLength(4);
      expect(clients.every((row) => row.state === 'idle' && row.blocked_by.length === 0)).toBe(true);
    } finally {
      for (const client of reserved) client.release();
    }
    // A deadline cannot cancel postgres.js's queued BEGIN. Observe its late
    // acquisition/rollback and verify that the caller callback still never ran.
    await vi.waitFor(() => expect(fixtureTransactions[0].settledAt).toBeDefined());
    expect(fixtureTransactions[0].acquiredAt).toBeDefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it('seeds every nature, a human-audience work row, and agrees with the predicate twin', () => {
    expect(new Set(SEEDS.map((s) => s.nature))).toEqual(new Set(NATURES));
    expect(SEEDS.some((s) => s.nature === 'work' && s.audience === 'human')).toBe(true);
    // The census expectation and the in-memory predicate must agree row by row, so a seed
    // whose expectation drifts from the predicate fails here, not as a confusing door failure.
    for (const s of SEEDS) {
      const terminal = !['open', 'wip', 'blocked'].includes(s.status);
      const agent = isAgentWork({
        nature: s.nature,
        audience: s.audience,
        lane: (s.seed.payload.lane as string | undefined) ?? null,
        needsOwnerAction: s.seed.payload.needsOwnerAction === true,
      });
      expect({ id: s.id, claimable: agent && !terminal }).toEqual({ id: s.id, claimable: s.seed.expectAgentClaimable });
    }
  });

  it('every census `selection` path has a door here, and every door names a live census row', () => {
    const selection = WORK_SELECTION_CENSUS.filter((r) => r.role === 'selection').map((r) => r.id);
    const doored = new Set([...DRAIN_DOORS.flatMap((d) => d.census), ...Object.keys(COVERED_BY)]);
    expect(selection.filter((id) => !doored.has(id))).toEqual([]);
    expect([...doored].filter((id) => !selection.includes(id))).toEqual([]);
  });
});

describe('P-012: a drained self-select door serves only agent work', () => {
  it.each(DRAIN_DOORS.map((d) => [d.name, d] as const))('%s', async (_name, door) => {
    const served = await drain(door);
    expect(served.filter((id) => !EXPECTED.has(id)).map(label)).toEqual([]);
    expect(served.length).toBeGreaterThan(0);
  });

  it('the feature and issue claim doors together drain EXACTLY the agent work, nothing else', async () => {
    const served = [...(await drain(DRAIN_DOORS[0]!)), ...(await drain(DRAIN_DOORS[1]!))];
    expect(served.filter((id) => !EXPECTED.has(id)).map(label)).toEqual([]);
    expect([...EXPECTED].filter((id) => !served.includes(id)).map(label)).toEqual([]);
  });
});

describe('P-012: the guard can fail (permanent negative control)', () => {
  // A guard that has never failed is untested. This neuters the ONE predicate inside the
  // test database only (never the shared tree), drains the claim doors, and requires the
  // guard's own condition to find non-agent rows. If the doors ever stop routing through
  // work_item_is_agent_work, this control starts serving nothing extra and fails, which
  // says the self-select assertions above have gone vacuous.
  it('with work_item_is_agent_work neutered to true, the claim doors serve non-agent rows', async () => {
    const rows = await db.sql<{ def: string }[]>`
      SELECT pg_get_functiondef('harness_shared.work_item_is_agent_work(text,text,text,boolean)'::regprocedure) AS def`;
    const original = rows[0]!.def;
    const neutered = original.replace(/AS \$function\$[\s\S]*?\$function\$/, 'AS $function$ SELECT true $function$');
    expect(neutered).not.toBe(original);
    await db.sql.unsafe(neutered);
    try {
      const served = [...(await drain(DRAIN_DOORS[0]!)), ...(await drain(DRAIN_DOORS[1]!))];
      expect(served.filter((id) => !EXPECTED.has(id)).length).toBeGreaterThan(0);
    } finally {
      await db.sql.unsafe(original);
    }
  });
});

describe('P-012: the claimable preview surfaces only agent work', () => {
  it('readIssueClaimability (work_items:claimable) never lists a non-agent row', async () => {
    const result = await readIssueClaimability(undefined, { harness: H, workspaceId: WS, client: db.sql as never }, { limit: 100 });
    const text = JSON.stringify(result);
    const surfaced = SEEDS.filter((s) => text.includes(`"${s.id}"`)).map((s) => s.id);
    expect(surfaced.filter((id) => !EXPECTED.has(id)).map(label)).toEqual([]);
    expect(surfaced.length).toBeGreaterThan(0);
  });
});

describe('P-012 / D-024: the by-id claim refuses every non-agent category', () => {
  it('observe agrees with named claims on categories and preserves readiness and status overrides', async () => {
    const categoryAgent = (s: Seeded) => s.nature === 'work' && s.audience === 'agent';
    const nonAgent = SEEDS.filter((s) => s.status === 'open' && !categoryAgent(s));
    const agent = SEEDS.filter(categoryAgent);
    expect(new Set(nonAgent.map((s) => s.nature))).toEqual(new Set(NATURES));
    expect(nonAgent.some((s) => s.audience === 'human')).toBe(true);
    expect(agent.some((s) => s.seed.payload.lane === 'observation')).toBe(true);
    expect(agent.some((s) => s.seed.payload.needsOwnerAction === true)).toBe(true);
    expect(agent.some((s) => !['open', 'wip', 'blocked'].includes(s.status))).toBe(true);

    const mismatches: string[] = [];
    for (const s of nonAgent) {
      const observed = await wi.observeWorkItem(s.id, { harness: H });
      const claimed = await wi.claimWorkItem(s.id, 'observe-category-probe', { harness: H });
      expect(observed?.notAgentWork).toEqual({ nature: s.nature, audience: s.audience });
      if (observed?.available !== false || observed.gated !== true || claimed !== null) {
        mismatches.push(`${label(s.id)} → available=${observed?.available}, gated=${observed?.gated}, claimed=${claimed?.id ?? null}`);
      }
    }
    expect(mismatches).toEqual([]);

    for (const s of agent) {
      const observed = await wi.observeWorkItem(s.id, { harness: H });
      const terminal = !['open', 'wip', 'blocked'].includes(s.status);
      expect({ id: s.id, available: observed?.available, gated: observed?.gated }).toEqual({
        id: s.id, available: !terminal, gated: undefined,
      });
      if (!terminal) {
        expect((await wi.claimWorkItem(s.id, 'observe-category-probe', { harness: H }))?.assignee).toBe('observe-category-probe');
      }
    }
  });

  it.each([H, `operator:${WS}`])('observes the resolved issue category in %s and revalidates held dispatches', async (rowHarness) => {
    const s = SEEDS.find((s) => s.seed.itemKind === 'bug')!;
    await db.sql`UPDATE harness_shared.work_items SET audience = 'human', harness_slug = ${rowHarness}
      WHERE workspace_id = ${WS} AND feature_id = ${s.id}`;
    expect(await wi.observeWorkItem(s.id, { harness: H })).toMatchObject({
      available: false, gated: true, notAgentWork: { nature: 'work', audience: 'human' },
    });
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'held-category-probe'
      WHERE workspace_id = ${WS} AND feature_id = ${s.id}`;
    const held = await wi.observeWorkItem(s.id, { harness: H });
    expect(held).toMatchObject({ available: false, claimedBy: 'held-category-probe' });
    expect(held?.gated).toBeUndefined();
    expect(await wi.observeWorkItem(s.id, { harness: H, revalidateHeld: true })).toMatchObject({
      available: false, claimedBy: 'held-category-probe', gated: true,
      notAgentWork: { nature: 'work', audience: 'human' },
    });
    expect((await db.sql`SELECT taken_by FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND feature_id = ${s.id}`)[0]?.taken_by).toBe('held-category-probe');
  });

  it('the category lookup honors the resolved workspace instead of the active workspace', async () => {
    const s = SEEDS.find((s) => s.nature === 'work' && s.audience === 'human')!;
    const otherWorkspace = 'category-foreign-workspace';
    await db.sql`UPDATE harness_shared.work_items SET workspace_id = ${otherWorkspace}
      WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${s.id}`;
    expect(await wi.readNonAgentWorkCategory(s.id, H)).toBeNull();
    expect(await wi.readNonAgentWorkCategory(s.id, H, otherWorkspace)).toEqual({ nature: 'work', audience: 'human' });
  });

  it('refuses records, documents, events and human-audience work by id, and still serves agent work', async () => {
    const live = SEEDS.filter((s) => s.status === 'open');
    const categoryAgent = (s: Seeded) => s.nature === 'work' && s.audience === 'agent';
    const plainAgent = live.filter(
      (s) => categoryAgent(s) && s.seed.payload.lane === undefined && s.seed.payload.needsOwnerAction === undefined,
    );
    const nonAgent = live.filter((s) => !categoryAgent(s));
    expect(nonAgent.length).toBeGreaterThan(0);
    expect(plainAgent.length).toBeGreaterThan(0);

    const servedNonAgent: string[] = [];
    for (const s of nonAgent) {
      if ((await wi.claimWorkItem(s.id, 'byid-probe', { harness: H })) !== null) servedNonAgent.push(label(s.id));
    }
    expect(servedNonAgent).toEqual([]);

    const refusedAgent: string[] = [];
    for (const s of plainAgent) {
      if ((await wi.claimWorkItem(s.id, 'byid-probe', { harness: H }))?.assignee !== 'byid-probe') refusedAgent.push(label(s.id));
    }
    expect(refusedAgent).toEqual([]);
  });
});

describe('D-035: work_items:set_state and work_items:complete refuse every non-agent category by id', () => {
  // The by-id claim above is one of THREE doors that act on a row by id. A real-model S36 run
  // (test_runs 20493622) worked record/document/event/human rows through set_state and
  // complete without claiming them. These cases drive the REAL handlers, so a mutant that
  // drops either door's `return notAgentWork` is caught here, not only a broken helper.
  const categoryAgent = (s: Seeded) => s.nature === 'work' && s.audience === 'agent';
  // An attributable caller: resolveAgentIdentity refuses an empty context before any door runs.
  const PROBE_CTX = { isSuperuser: true, uiClientId: 'door-probe', workspaceId: WS, harnessSlug: H } as never;
  const firstResult = (out: unknown) => {
    const data = (out as { data?: { results?: Array<Record<string, unknown>> } & Record<string, unknown> }).data;
    return (data?.results?.[0] ?? data ?? {}) as Record<string, unknown>;
  };

  it('the shared gate refuses every non-agent seed at both doors and passes every agent seed', async () => {
    const { refuseNonAgentWorkAtDoor, NOT_AGENT_WORK } = await import('./agent-work-door-gate');
    const nonAgent = SEEDS.filter((s) => !categoryAgent(s));
    const agent = SEEDS.filter(categoryAgent);
    expect(nonAgent.length).toBeGreaterThan(0);
    expect(agent.length).toBeGreaterThan(0);
    for (const door of ['work_items:set_state', 'work_items:complete'] as const) {
      const passedNonAgent: string[] = [];
      for (const s of nonAgent) {
        const r = await refuseNonAgentWorkAtDoor(door, s.id, H, PROBE_CTX);
        if (r?.error !== NOT_AGENT_WORK || r.door !== door || r.nature !== s.nature) passedNonAgent.push(label(s.id));
      }
      expect(passedNonAgent).toEqual([]);
      const refusedAgent: string[] = [];
      for (const s of agent) if ((await refuseNonAgentWorkAtDoor(door, s.id, H, PROBE_CTX)) !== null) refusedAgent.push(label(s.id));
      expect(refusedAgent).toEqual([]);
    }
  });

  it('the set_state and complete handlers refuse every non-agent seed and write nothing', async () => {
    const setState = (await import('../agent-tools/work_items/set_state')).default;
    const complete = (await import('../agent-tools/work_items/complete')).default;
    const nonAgent = SEEDS.filter((s) => !categoryAgent(s));
    const before = new Map(nonAgent.map((s) => [s.id, s.status]));

    const setStateLeaks: string[] = [];
    const completeLeaks: string[] = [];
    for (const s of nonAgent) {
      const viaSetState = firstResult(await setState.handler({ id: s.id, state: 'wip', harness: H } as never, PROBE_CTX));
      if (viaSetState.error !== 'not_agent_work') setStateLeaks.push(`${label(s.id)} → ${JSON.stringify(viaSetState).slice(0, 160)}`);
      const viaComplete = firstResult(
        await complete.handler(
          {
            id: s.id,
            harness: H,
            state: 'done',
            assumptions: 'none',
            completion: { summary: 'door probe', testsRun: 'none', testResult: 'none', verifiedHow: 'none', filesChanged: [] },
          } as never,
          PROBE_CTX,
        ),
      );
      if (viaComplete.error !== 'not_agent_work') completeLeaks.push(`${label(s.id)} → ${JSON.stringify(viaComplete).slice(0, 160)}`);
    }
    expect(setStateLeaks).toEqual([]);
    expect(completeLeaks).toEqual([]);

    const rows = await db.sql<{ feature_id: string; status: string }[]>`
      SELECT feature_id, status FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ANY(${[...before.keys()]})`;
    expect(rows.filter((r) => r.status !== before.get(r.feature_id)).map((r) => label(r.feature_id))).toEqual([]);
  });

  // D-038 (WI-10005369): the owner's Queue UI reaches set_state through the palette bridge
  // (capabilities/invoke.ts). This ctx is that bridge's server-built identity, field for field.
  const OWNER_UI_CTX = {
    workspaceId: WS,
    harnessSlug: H,
    role: 'operator',
    spawnId: 'palette',
    isSuperuser: false,
    uiClientId: 'pui-4242',
    principal: {
      kind: 'system',
      slug: 'loopback',
      workspaceId: WS,
      authMethod: 'process-internal',
      trust: 'trusted',
      capabilities: new Set(['*']),
      roles: new Set<string>(),
    },
  } as never;
  const humanSeed = () => {
    const s = SEEDS.find((x) => x.nature === 'work' && x.audience === 'human' && !['done', 'dropped', 'passed'].includes(x.status));
    expect(s, 'the seed set must carry a non-terminal human-audience work row').toBeDefined();
    return s as Seeded;
  };

  it('D-038 (i): an agent caller is refused on a human-audience row at both doors', async () => {
    const { refuseNonAgentWorkAtDoor, NOT_AGENT_WORK } = await import('./agent-work-door-gate');
    const s = humanSeed();
    for (const door of ['work_items:set_state', 'work_items:complete'] as const) {
      const r = await refuseNonAgentWorkAtDoor(door, s.id, H, PROBE_CTX);
      expect(r?.error, `${door} ${label(s.id)}`).toBe(NOT_AGENT_WORK);
      expect(r?.audience).toBe('human');
    }
  });

  it('D-038 (iii): an agent carrying spoofed UI markers is still refused, at the gate and through the real handler', async () => {
    const { refuseNonAgentWorkAtDoor, NOT_AGENT_WORK, isOwnerUiCaller } = await import('./agent-work-door-gate');
    const { classifyCallOrigin, CALL_ORIGIN_HEADER } = await import('../telemetry-call-origin');
    const s = humanSeed();
    const loopback = (OWNER_UI_CTX as { principal: unknown }).principal;
    const spoofs: Record<string, unknown> = {
      // An su bearer that also claims the palette spawn id and the loopback principal.
      'superuser+palette': { isSuperuser: true, uiClientId: 'pui-1', spawnId: 'palette', principal: loopback },
      // A caller-supplied uiClientId and a DECLARED ui origin header, without the palette spawn id.
      'declared-ui-origin': {
        isSuperuser: false,
        uiClientId: 'pui-1',
        spawnId: 'mcp-7f3a',
        principal: loopback,
        requestOrigin: { headers: { [CALL_ORIGIN_HEADER]: 'ui' } },
      },
      // The palette spawn id on an agent principal.
      'palette-on-agent-principal': {
        isSuperuser: false,
        spawnId: 'palette',
        principal: { kind: 'agent', slug: 'su-spoof', authMethod: 'bearer' },
      },
    };
    // Calibration: the telemetry classifier DOES call the declared header 'ui', which is exactly
    // why the gate must not key on it.
    expect(classifyCallOrigin({ requestOrigin: { headers: { [CALL_ORIGIN_HEADER]: 'ui' } }, spawnId: 'mcp-7f3a' }).origin).toBe('ui');
    // Positive control: the real bridge identity IS recognised, so the refusals below are not vacuous.
    expect(isOwnerUiCaller(OWNER_UI_CTX)).toBe(true);
    for (const [name, ctx] of Object.entries(spoofs)) {
      expect(isOwnerUiCaller(ctx as never), name).toBe(false);
      const r = await refuseNonAgentWorkAtDoor('work_items:set_state', s.id, H, ctx as never);
      expect(r?.error, name).toBe(NOT_AGENT_WORK);
    }
    // Argument-level spoof through the real handler: UI-looking args from an agent caller.
    const setState = (await import('../agent-tools/work_items/set_state')).default;
    const viaArgs = firstResult(
      await setState.handler(
        { id: s.id, state: 'dropped', completionRef: 'spoof', assumptions: 'none', harness: H, spawnId: 'palette', callerOrigin: 'ui', viaUi: true } as never,
        PROBE_CTX,
      ),
    );
    expect(viaArgs.error).toBe('not_agent_work');
  });

  it("D-038 (ii): the owner's UI identity is admitted on a human-audience row and the Queue close lands", async () => {
    const { refuseNonAgentWorkAtDoor } = await import('./agent-work-door-gate');
    const s = humanSeed();
    for (const door of ['work_items:set_state', 'work_items:complete'] as const) {
      expect(await refuseNonAgentWorkAtDoor(door, s.id, H, OWNER_UI_CTX), door).toBeNull();
    }
    // The exact closeWorkItem call (apps/operator/app/admin/plans/plans-api.ts) through the real handler.
    const setState = (await import('../agent-tools/work_items/set_state')).default;
    const out = firstResult(
      await setState.handler(
        { id: s.id, state: 'dropped', completionRef: 'owner closed from the Queue', assumptions: 'none', harness: H } as never,
        OWNER_UI_CTX,
      ),
    );
    expect(out.error, JSON.stringify(out).slice(0, 300)).not.toBe('not_agent_work');
    const [row] = await db.sql<{ status: string }[]>`
      SELECT status FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${s.id}`;
    expect(row?.status, JSON.stringify(out).slice(0, 300)).toBe('dropped');
  });
});
