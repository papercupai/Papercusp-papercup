/**
 * Intake acceptance end-to-end (observation-candidate-acceptance-promotion-2026-09-30).
 *
 * One real-Postgres fixture carrying the REAL migration chain for the claim floors
 * (654 … 1301), the readiness projections (1037/831/1294) and the P-011 adoption
 * ledger (1310). Each describe is the rating basis of one acceptance BAR (rubric rev4
 * methods name these titles verbatim):
 *   R-6 / R-24 / R-25 — one acceptance floor on every claim path (view, inline drain,
 *                        by-id claimIssue, TS twin) and its narrow reviewer exception;
 *   R-10 / R-32 / R-33 — the shared stage aggregation (readWorkItemReadinessProjection);
 *   R-11 / R-34 / R-35 / R-36 / R-37 — P-011: creation enrolment, protected legacy
 *                        cohorts, fail-closed NULL state, fast-path receipts, canary-gated
 *                        enforcement.
 * Post-cutover rows seed created_ts = cutover + 60s explicitly (D-018 §3), so every case
 * stays valid when P-011 lowers the sentinel cutover.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  ADV_SESSIONS_CLAIM_MIN_DDL,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WATCHDOG_TICKS_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../test/_work-items-schema';
import { WIDE_TRIGGER_DDL } from './scheduler/dependency-trigger-fixture';
import {
  IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER,
  IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS,
  WORK_ITEM_PRESENTATION_STAGES,
  acceptanceSourceRevision,
  countWorkItemPresentationStages,
  createImplementationReadiness,
  createVerificationTask,
  deriveWorkItemIntakeStage,
  deriveWorkItemPresentationStage,
  evaluateImplementationAcceptance,
  implementationReadinessAdmitsClaim,
  mintAgentReviewClaimAdmission,
  readAgentReviewState,
  sealImplementationAcceptance,
  type AgentReviewState,
  type ImplementationAcceptanceAuthority,
} from './harness/improvements/agent-review-policy';
import {
  ACCEPTANCE_CANARY_RUNTIME,
  ACCEPTANCE_CANARY_STEPS,
  ENFORCEMENT_CUTOVER_CANARY_ATTESTATION,
  ENFORCEMENT_CUTOVER_SENTINEL,
  LEGACY_ADOPTION_MAX_COHORT,
  acceptanceCanaryProbes,
  applyLegacyAdoptionCohort,
  authorizeEnforcementCutoverAdvance,
  enforcementCutoverAttested,
  reportLegacyAdoptionCohort,
  revertLegacyAdoptionCohort,
  runAcceptanceCanary,
} from './harness/improvements/legacy-acceptance-adoption';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
/** Real migration text minus psql meta, GRANTs and bare BEGIN/COMMIT (the pooled test client rejects them). */
const readMigration = (f: string) => {
  const path = existsSync(resolve(SQL_DIR, f)) ? resolve(SQL_DIR, f) : resolve(SQL_DIR, `${f}.DRAFT`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');
};

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql, currentBuild: 'abcdef1' as string | null,
  beforeBuild: null as (() => Promise<void>) | null,
}));
vi.mock('./attention/intake-promotion', async (orig) => {
  const actual = await orig<typeof import('./attention/intake-promotion')>();
  const currentTargetBuild = async () => { await h.beforeBuild?.(); return h.currentBuild; };
  return {
    ...actual,
    currentIntakeTargetBuild: currentTargetBuild,
    // Exercise the real server wrapper with this fixture's build adapter.
    // Replacing an export cannot replace the wrapper's lexical default binding.
    verifyAcceptedWorkItemBugReproduction: (item: Parameters<typeof actual.verifyAcceptedWorkItemBugReproduction>[0]) =>
      actual.verifyAcceptedWorkItemBugReproduction(item, {
        currentTargetBuild,
        ledger: actual.defaultReproductionLedgerDeps(),
      }),
  };
});
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('./agent-tools/coordination/log', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, coordScopeWorkspace: () => 'default' };
});
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return { ...actual, getFlag: async (key: FlagKey) => FLAG_DEFAULTS[key] ?? false };
});

const wi = await import('./work-items');
const issues = await import('./issues-engineer');
const { readWorkItemReadinessProjection } = await import('./work-items-admission-promoter');
const { claimNextVerificationTask, claimNextVerificationWork } = await import('./harness/improvements/agent-review');

const H = 'papercup';
const WS = 'default';
const OP = `operator:${WS}`;
const PRE = 1;
const POST = IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS + 60_000;
const TITLE = 'Bounded parser drops the trailing token';
const SUMMARY = 'The bounded parser drops the last token of every line.';
const AT = '2026-10-01T00:00:00.000Z';
const PROPOSAL = {
  problem: 'The bounded parser drops the trailing token of a line.',
  evidence: ['parser.test.ts trailing-token fixture fails on HEAD'],
  outcome: 'Every token of a line survives parsing.',
  scope: 'Fix the bounded parser defect only.',
  completionCheck: 'The trailing-token regression fixture passes.',
};
let db: FreshPgDb;

function sealed(authority: ImplementationAcceptanceAuthority, title = TITLE) {
  const result = sealImplementationAcceptance({
    proposal: PROPOSAL, authority, reason: 'fixture acceptance', source: { kind: 'bug', title, summary: SUMMARY }, acceptedAt: AT,
    // P-006: a bug's acceptance carries its reproduction receipt.
    reproduction: { kind: 'failing-test', ref: 'fixture.test.ts', buildSha: 'abcdef1' },
  });
  if (!result.ok) throw new Error('fixture contract must seal');
  return result.contract;
}
const REVIEW: ImplementationAcceptanceAuthority = { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-author', round: 1 };
const readiness = (
  status: 'ready' | 'unknown' | 'not-ready',
  source: 'agent-review' | 'creation-enrollment' | 'capture-policy',
  acceptance?: object,
) => ({
  implementationReadiness: createImplementationReadiness({
    status, source, updatedAt: AT,
    // A non-ready verdict is a hold: it carries the registered reason its real writer uses
    // (hold-registry.ts, D-026), since createImplementationReadiness refuses any other.
    reason:
      status === 'ready'
        ? `${source} fixture`
        : source === 'creation-enrollment' ? 'no-acceptance-evidence-at-creation' : 'awaiting-agent-review',
    ...(acceptance ? { evidence: { acceptance: acceptance as Record<string, unknown> } } : {}),
  }),
});
const qualifying = () => readiness('ready', 'agent-review', sealed(REVIEW));
const selfReviewed = () => readiness('ready', 'agent-review', { ...sealed(REVIEW), authority: { ...REVIEW, reviewer: 'su-author' } });

async function seed(id: string, o: {
  kind?: string; status?: string; takenBy?: string | null; createdTs?: number; payload?: Record<string, unknown> | null;
  admission?: string | null; title?: string; summary?: string; lane?: string | null; closedTs?: number | null;
  authority?: string | null; terminalOwner?: string | null; terminalCompletionRef?: string | null; updatedTs?: number;
} = {}) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, payload, origin,
       title, summary, admission, closed_ts, authority, terminal_owner, terminal_completion_ref)
    VALUES (${H}, ${id}, ${o.kind ?? 'bug'}, ${o.status ?? 'open'}, ${o.takenBy ?? null}, ${WS},
            ${o.createdTs ?? PRE}, ${o.updatedTs ?? 1},
            -- \`lane\` is GENERATED from payload.lane, so observation rows carry it in the payload.
            ${o.payload ? db.sql.json(o.payload as never) : null}, 'local',
            ${o.title ?? TITLE}, ${o.summary ?? SUMMARY}, ${o.admission === undefined ? null : o.admission},
            ${o.closedTs ?? null}, ${o.authority ?? null},
            ${o.terminalOwner ?? null}, ${o.terminalCompletionRef ?? null})`;
}

async function viewIds(prefix: string): Promise<string[]> {
  const rows = await db.sql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items_claimable
     WHERE workspace_id = ${WS} AND harness_slug IN (${H}, ${OP}) AND feature_id LIKE ${`${prefix}%`}`;
  return rows.map((r) => r.feature_id).sort();
}
async function drainIds(prefix: string, assignee = 'drain-probe'): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 100; i++) {
    const id = (await wi.claimNextIssueWorkItem({ harness: H, assignee }, WS))?.id ?? null;
    if (!id) break;
    out.push(id);
  }
  return out.filter((id) => id.startsWith(prefix)).sort();
}
async function floorLabels(prefix: string): Promise<Record<string, string[]>> {
  const rows = await db.sql<{ feature_id: string; floors: string[] }[]>`
    SELECT feature_id, harness_shared.work_item_claim_floors(
             workspace_id, status, taken_by, origin, title, terminal_owner, terminal_completion_ref,
             payload, feature_id, item_kind, summary, created_ts) AS floors
      FROM harness_shared.work_items WHERE feature_id LIKE ${`${prefix}%`}`;
  return Object.fromEntries(rows.map((r) => [r.feature_id, r.floors]));
}
async function holder(id: string): Promise<string | null> {
  const [row] = await db.sql<{ taken_by: string | null }[]>`SELECT taken_by FROM harness_shared.work_items WHERE feature_id = ${id}`;
  return row?.taken_by ?? null;
}
async function byIdClaims(id: string, assignee: string, opts: Record<string, unknown> = {}): Promise<boolean> {
  try {
    await issues.claimIssue(id, assignee, { workspaceId: WS, ...opts } as never);
  } catch {
    /* a refusal may throw; the row's holder is the verdict */
  }
  return (await holder(id)) === assignee;
}
async function payloadOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await db.sql<{ payload: Record<string, unknown> | null }[]>`SELECT payload FROM harness_shared.work_items WHERE feature_id = ${id}`;
  return row?.payload ?? {};
}

beforeAll(async () => {
  db = await createFreshPgDb('work-items-intake-acceptance');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(ADV_SESSIONS_CLAIM_MIN_DDL);
  await db.sql.unsafe(WATCHDOG_TICKS_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'work-items-intake-acceptance.integration.test.ts' });
  await db.sql.unsafe(readMigration('675-normalize-plan-items-decisions.sql')).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';
    -- 952 adds first_claimed_at beside a dedup_shard_map rebuild this fixture does not carry;
    -- 1037's stamp trigger and the shared stage aggregation (R-10/R-32/R-33) read the column.
    ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS first_claimed_at timestamptz;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer,
      ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    CREATE TABLE IF NOT EXISTS harness_shared.session_briefs (
      workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb, PRIMARY KEY (workspace_id, owner_id));
    CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default',
      surface text NOT NULL, writer_key text, msg_id text NOT NULL, body jsonb NOT NULL, harness_slug text,
      ts timestamptz NOT NULL DEFAULT now());`).simple();
  for (const f of [
    '379-maintained-ready-column.sql',
  ]) await db.sql.unsafe(readMigration(f)).simple();
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
  for (const f of [
    '654-work-item-claim-floors-ssot.sql',
    '744-plan-lane-floor-op-status.sql',
    '759-plan-blockedby-claim-floor.sql',
    '853-plan-item-terminal-claim-floor.sql',
    '188-work-item-claims.sql',
    '194-scout-routed-ideas.sql',
    '333-scout-routed-ideas-source-target-hive.sql',
    '471-scout-routed-ideas-origin.sql',
    '558-scout-routed-ideas-created-by.sql',
    'archive/025-harness-registry-and-feature-notes.sql',
    '860-agent-review-claim-floor.sql',
    '863-owner-action-claim-floor.sql',
    '864-migrate-legacy-human-parks-to-agent-review.sql',
    '1070-plan-item-sibling-claim-floor.sql',
    '1072-plan-assignment-claim-floor.sql',
    '1081-plan-route-decision-claim-floor.sql',
    '1301-acceptance-claim-floor.sql',
    // P-006 / WI-10006220: floor #16 re-rendered with the kind-specific verification check.
    '1368-acceptance-claim-floor-kind-verification.sql',
    // P-007 Phase C / WI-10006221: re-rendered with the completion-verification policy.
    '1373-completion-verification-claim-floor.sql',
    // The shared stage aggregation reads these projections (R-10/R-32/R-33).
    '831-issue-occurrence-ledger.sql',
    '1037-work-item-first-claim-stamp.sql',
    '1294-work-item-readiness-payload-projections.sql',
    // P-011: the adoption + canary ledger under test.
    '1310-acceptance-adoption-runs.sql',
  ]) await db.sql.unsafe(readMigration(f)).simple();
}, 240_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  h.currentBuild = 'abcdef1';
  h.beforeBuild = null;
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked,
                       harness_shared.harness_plans, harness_shared.plan_item_claims, harness_shared.plan_items,
                       harness_shared.acceptance_adoption_runs`;
});

describe('accepted bug target-build freshness at execution', () => {
  it('refuses a changed acceptance payload between verification and by-id assignment', async () => {
    await seed('WI-FRESHNESS-RACE', { payload: qualifying(), createdTs: POST });
    h.beforeBuild = async () => {
      h.beforeBuild = null;
      await db.sql`UPDATE harness_shared.work_items
        SET payload = jsonb_set(payload, '{implementationReadiness,evidence,acceptance,verification,receipt,buildSha}', '"bbbbbbb"')
        WHERE feature_id = 'WI-FRESHNESS-RACE'`;
    };
    expect(await byIdClaims('WI-FRESHNESS-RACE', 'fixer')).toBe(false);
    expect(await holder('WI-FRESHNESS-RACE')).toBeNull();
  });

  it('refuses a stale by-id claim and rolls back an inline scheduler claim', async () => {
    await seed('WI-FRESHNESS-STALE', { payload: qualifying(), createdTs: POST });
    h.currentBuild = 'bbbbbbb';
    expect(await byIdClaims('WI-FRESHNESS-STALE', 'fixer')).toBe(false);
    expect(await wi.claimNextIssueWorkItem({ harness: H, assignee: 'fixer' }, WS)).toBeNull();
    expect(await holder('WI-FRESHNESS-STALE')).toBeNull();
    const observed = await wi.observeWorkItem('WI-FRESHNESS-STALE', { harness: H });
    expect(observed).toMatchObject({ available: false, gated: true, reproductionRefused: { status: 'refuted' } });
    h.currentBuild = 'abcdef1';
    expect((await wi.claimNextIssueWorkItem({ harness: H, assignee: 'fixer' }, WS))?.id).toBe('WI-FRESHNESS-STALE');
  });

  it('revalidates a retained assignment without releasing ownership', async () => {
    await seed('WI-FRESHNESS-HELD', { payload: qualifying(), createdTs: POST });
    expect(await byIdClaims('WI-FRESHNESS-HELD', 'fixer')).toBe(true);
    h.currentBuild = null;
    expect(await wi.observeWorkItem('WI-FRESHNESS-HELD', { harness: H, revalidateHeld: true, assignee: 'fixer' }))
      .toMatchObject({ available: false, gated: true, reproductionRefused: { status: 'unresolved' } });
    expect(await holder('WI-FRESHNESS-HELD')).toBe('fixer');
    expect(await issues.claimIssue('WI-FRESHNESS-HELD', 'fixer', { workspaceId: WS })).toBeNull();
  });
});

describe('R-6 one execution boundary on every claim path', () => {
  const matrix = [
    { id: 'WI-R6-ACCEPTED', payload: qualifying, admit: true },
    { id: 'WI-R6-ABSENT', payload: () => null, admit: false },
    { id: 'WI-R6-ENROLLED', payload: () => readiness('unknown', 'creation-enrollment'), admit: false },
    { id: 'WI-R6-BARE-READY', payload: () => readiness('ready', 'agent-review'), admit: false },
    { id: 'WI-R6-HELD-ACCEPTED', payload: () => ({ ...qualifying(), _claimHold: true }), admit: false },
  ];

  it('the advertised view, the inline self-pull drain and the TS twin admit the same post-cutover rows', async () => {
    for (const c of matrix) await seed(c.id, { createdTs: POST, payload: c.payload() });
    const expected = matrix.filter((c) => c.admit).map((c) => c.id).sort();
    expect(await viewIds('WI-R6-')).toEqual(expected);
    for (const c of matrix.filter((m) => !m.id.includes('HELD'))) {
      expect([c.id, implementationReadinessAdmitsClaim({ payload: c.payload() ?? {}, kind: 'bug', title: TITLE, summary: SUMMARY, createdAtMs: POST })])
        .toEqual([c.id, c.admit]);
    }
    expect(await drainIds('WI-R6-')).toEqual(expected);
  });

  it('a by-id claim by a new holder is refused for unaccepted rows and admitted for accepted ones', async () => {
    for (const c of matrix.filter((m) => !m.id.includes('HELD'))) await seed(c.id, { createdTs: POST, payload: c.payload() });
    for (const c of matrix.filter((m) => !m.id.includes('HELD'))) {
      expect([c.id, await byIdClaims(c.id, 'worker-by-id')]).toEqual([c.id, c.admit]);
    }
  });
});

describe('R-24 weak acceptance substitutes never qualify', () => {
  const weak = [
    { id: 'WI-R24-DEDUP-ADMITTED', admission: 'admitted', payload: () => null },
    { id: 'WI-R24-AUTO-ENROLLED', admission: 'auto', payload: () => readiness('unknown', 'creation-enrollment') },
    { id: 'WI-R24-UNREVIEWED-READY', admission: 'unreviewed', payload: () => readiness('ready', 'capture-policy') },
    { id: 'WI-R24-SELF-REVIEWED', admission: null, payload: selfReviewed },
    { id: 'WI-R24-LEGACY-NULL', admission: null, payload: () => null },
  ];

  it('every substitute is refused with the implementation-readiness label on the view, drain, by-id and TS paths', async () => {
    for (const c of weak) await seed(c.id, { createdTs: POST, payload: c.payload(), admission: c.admission });
    const labels = await floorLabels('WI-R24-');
    for (const c of weak) expect([c.id, labels[c.id]?.includes('implementation-readiness')]).toEqual([c.id, true]);
    expect(await viewIds('WI-R24-')).toEqual([]);
    expect(await drainIds('WI-R24-')).toEqual([]);
    for (const c of weak) {
      expect([c.id, implementationReadinessAdmitsClaim({ payload: c.payload() ?? {}, kind: 'bug', title: TITLE, summary: SUMMARY, createdAtMs: POST })])
        .toEqual([c.id, false]);
      expect([c.id, await byIdClaims(c.id, 'worker-weak')]).toEqual([c.id, false]);
    }
  });
});

describe('R-25 reviewer access stays scoped to the intake row', () => {
  const review = { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'idea-r25', round: 1, submittedAt: AT } as unknown as AgentReviewState;
  const source = { kind: 'bug', title: TITLE, summary: SUMMARY };

  it('the minted reviewer admission opens only that row to that reviewer; workers stay refused and the row stays unadvertised', async () => {
    await seed('WI-R25-PENDING', {
      createdTs: POST, admission: 'pending',
      payload: { agentReview: review, ...readiness('unknown', 'creation-enrollment') },
    });
    await seed('WI-R25-OTHER', {
      createdTs: POST, admission: 'pending',
      payload: { agentReview: { ...review, ledgerIdeaId: 'idea-other' }, ...readiness('unknown', 'creation-enrollment') },
    });
    expect(await viewIds('WI-R25-')).toEqual([]);
    expect(await byIdClaims('WI-R25-PENDING', 'worker-r25')).toBe(false);
    const admission = mintAgentReviewClaimAdmission({
      itemId: 'WI-R25-PENDING',
      reviewer: 'su-reviewer',
      harnessSlug: H,
      review,
      source,
      parties: { reporters: [], implementers: [] },
    });
    expect(admission).not.toBeNull();
    // The admission is bound to its row: presenting it for the sibling row admits nothing.
    expect(await byIdClaims('WI-R25-OTHER', 'su-reviewer', { agentReviewAdmission: admission })).toBe(false);
    expect(await byIdClaims('WI-R25-PENDING', 'su-reviewer', { agentReviewAdmission: admission })).toBe(true);
    expect(readAgentReviewState(await payloadOf('WI-R25-PENDING'))?.reviewedSourceRevision)
      .toBe(acceptanceSourceRevision(source));

    await seed('WI-R25-STALE', {
      createdTs: POST,
      admission: 'pending',
      payload: { agentReview: { ...review, ledgerIdeaId: 'idea-r25-stale' }, ...readiness('unknown', 'creation-enrollment') },
    });
    const staleAdmission = mintAgentReviewClaimAdmission({
      itemId: 'WI-R25-STALE',
      reviewer: 'su-reviewer',
      harnessSlug: H,
      review: { ...review, ledgerIdeaId: 'idea-r25-stale' },
      source,
      parties: { reporters: [], implementers: [] },
    });
    expect(staleAdmission).not.toBeNull();
    await db.sql`
      UPDATE harness_shared.work_items
         SET summary = 'Corrected issue body.'
       WHERE workspace_id = ${WS} AND feature_id = 'WI-R25-STALE'`;
    expect(await byIdClaims('WI-R25-STALE', 'su-reviewer', { agentReviewAdmission: staleAdmission })).toBe(false);
    expect(await holder('WI-R25-STALE')).toBeNull();

    // ...and the submitter can never mint one for its own filing.
    expect(
      mintAgentReviewClaimAdmission({
        itemId: 'WI-R25-PENDING',
        reviewer: 'su-author',
        harnessSlug: H,
        review,
        source,
        parties: { reporters: [], implementers: [] },
      }),
    ).toBeNull();
    expect(await drainIds('WI-R25-')).toEqual([]);
  });
});

// P-007 (D-021 / D-023): a verification task never reaches its own reporter or implementer,
// on the self-pull drain or the by-id writer. The rule depends on who is claiming, so it is a
// claim-door filter and NOT a claimant-free floor: the advertised view still lists the row.
describe('P-007 a verification task skips its parties and serves a verifier', () => {
  const verification = createVerificationTask({
    subject: 'WI-P7-SUBJECT',
    check: 'reproduction',
    reporters: ['su-reporter'],
    implementers: ['su-builder'],
  });

  it('the drain and the by-id writer refuse the reporter and the implementer, and serve an independent verifier', async () => {
    await seed('WI-P7-TASK', { createdTs: POST, payload: { ...qualifying(), verification } });
    // Claimant-free surfaces are unchanged: no floor label, still advertised.
    expect((await floorLabels('WI-P7-'))['WI-P7-TASK']).toEqual([]);
    expect(await viewIds('WI-P7-')).toEqual(['WI-P7-TASK']);
    for (const party of ['su-reporter', 'su-builder']) {
      expect([party, await drainIds('WI-P7-', party)]).toEqual([party, []]);
      expect([party, await byIdClaims('WI-P7-TASK', party)]).toEqual([party, false]);
    }
    expect(await holder('WI-P7-TASK')).toBeNull();
    expect(await drainIds('WI-P7-', 'su-verifier')).toEqual(['WI-P7-TASK']);
    expect(await holder('WI-P7-TASK')).toBe('su-verifier');
  });

  it('a row with no verification block is served to the same agents (the filter is not a blanket refusal)', async () => {
    await seed('WI-P7-PLAIN', { createdTs: POST, payload: qualifying() });
    expect(await byIdClaims('WI-P7-PLAIN', 'su-reporter')).toBe(true);
  });

  // Phase B (D-027): the verifier lane's task door. It self-selects only rows carrying a
  // verification block, skips the task's own parties in SQL, and claims through the by-id writer.
  it('the verifier-lane task door skips the parties, serves an independent verifier, and never serves plain work', async () => {
    await seed('WI-P7-TASK', { createdTs: POST, payload: { ...qualifying(), verification } });
    await seed('WI-P7-PLAIN', { createdTs: POST, payload: qualifying() });
    for (const party of ['su-reporter', 'su-builder']) {
      expect([party, (await claimNextVerificationTask({ verifier: party, harnessSlug: H }))?.id ?? null]).toEqual([party, null]);
    }
    expect(await holder('WI-P7-TASK')).toBeNull();
    const served = await claimNextVerificationWork({ verifier: 'su-verifier', harnessSlug: H });
    expect(served?.kind).toBe('verification-task');
    expect(served?.workItem.id).toBe('WI-P7-TASK');
    expect(await holder('WI-P7-TASK')).toBe('su-verifier');
    // The implementation pool row is never reached through the verifier lane.
    expect(await claimNextVerificationTask({ verifier: 'su-verifier-2', harnessSlug: H })).toBeNull();
    expect(await holder('WI-P7-PLAIN')).toBeNull();
  });
});

/** A population carrying every stage, used by R-10/R-32/R-33. */
async function seedStagePopulation() {
  const ok = qualifying();
  const rows = [
    { id: 'WI-ST-OBSERVATION', lane: 'observation', payload: { lane: 'observation' } },
    { id: 'WI-ST-PENDING-CANDIDATE', payload: readiness('unknown', 'creation-enrollment') },
    { id: 'WI-ST-REVISED-CANDIDATE', payload: readiness('not-ready', 'agent-review') },
    { id: 'WI-ST-ACCEPTED-READY', payload: ok },
    { id: 'WI-ST-ACCEPTED-ACTIVE', payload: ok, takenBy: 'worker-active' },
    { id: 'WI-ST-ACCEPTED-BLOCKED', payload: { ...ok, _claimHold: true } },
    { id: 'WI-ST-VERIFIED', payload: ok, status: 'done', authority: 'committed', closedTs: Date.now() - 1000 },
    // An abandoned terminal outcome. `failed` is NOT an issue-family terminal status
    // (ISSUE_TERMINAL_STATUSES = resolved|closed|done|dropped), so it must not stand in here.
    { id: 'WI-ST-DROPPED', payload: ok, status: 'dropped', closedTs: Date.now() - 1000 },
    { id: 'WI-ST-UNREACHED-TRIAGE', payload: null },
  ];
  for (const r of rows) {
    await seed(r.id, {
      payload: r.payload as Record<string, unknown> | null, lane: r.lane ?? null, takenBy: r.takenBy ?? null,
      status: r.status ?? 'open', authority: r.authority ?? null, closedTs: r.closedTs ?? null, admission: 'admitted',
      createdTs: Date.now() - 60_000,
    });
  }
  return rows;
}
const projection = () => readWorkItemReadinessProjection({ workspaceId: WS, harnessSlug: H, sql: db.sql as never, windowDays: 7 });

describe('R-10 every queue stage and triage failure is shown', () => {
  it('each seeded row lands in its named stage under one workspace/harness/window', async () => {
    const rows = await seedStagePopulation();
    const p = await projection();
    expect(p.presentation?.counts).toMatchObject({
      candidate: 2, unknown: 1, 'accepted-ready': 1, 'accepted-active': 1, 'accepted-blocked': 1,
      'verified-completion': 1, 'terminal-other': 1,
    });
    // Observation rows are shown by the shared classifier, never inside the work population.
    const observation = rows.find((r) => r.id === 'WI-ST-OBSERVATION')!;
    expect(deriveWorkItemPresentationStage({ kind: 'bug', status: 'open', payload: observation.payload }).stage).toBe('observation');
    expect(p.scope).toMatchObject({ workspaceId: WS, harnessSlug: H, population: 'root issue-family rows excluding observation-lane records' });
    expect(p.flow.windowDays).toBe(7);
    // The failed / never-triaged rows are visible, not dropped.
    expect(p.presentation!.counts['terminal-other'] + p.presentation!.counts.unknown).toBe(2);
  });
});

describe('R-32 counts carry scope, window, units and writer', () => {
  it('every count block the shared aggregation returns is labelled', async () => {
    await seedStagePopulation();
    const p = await projection();
    expect(p.presentation).toMatchObject({ unit: 'work-item rows', writer: 'readWorkItemReadinessProjection', mutuallyExclusive: true });
    expect(p.scope.workspaceId).toBe(WS);
    expect(p.scope.harnessSlug).toBe(H);
    expect(p.flow.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.flow.recurrence).toMatchObject({ writer: 'harness_shared.work_item_occurrences' });
    expect(Object.keys(p.flow.recurrence.units).sort()).toEqual(['canonicalClusters', 'duplicateOccurrences', 'rawOccurrences']);
    // A count block stripped of any label is not a valid count (negative control).
    const stripped = { ...p.presentation, writer: undefined };
    expect(stripped).not.toMatchObject({ writer: 'readWorkItemReadinessProjection' });
  });
});

describe('R-33 measures stay distinct and stage totals reconcile', () => {
  it('stage counts partition the population exactly once and equal the TS partition', async () => {
    const rows = await seedStagePopulation();
    const p = await projection();
    const work = rows.filter((r) => r.lane !== 'observation');
    const expected = countWorkItemPresentationStages(work.map((r) => ({
      kind: 'bug', status: r.status ?? 'open', payload: r.payload, title: TITLE, summary: SUMMARY,
      assignee: r.takenBy ?? null, completionAuthority: r.authority ?? null,
    })));
    expect(p.presentation?.counts).toEqual(expected.counts);
    const total = WORK_ITEM_PRESENTATION_STAGES.reduce((sum, s) => sum + (p.presentation!.counts[s] ?? 0), 0);
    expect(total).toBe(p.presentation!.population);
    expect(p.presentation!.population).toBe(work.length);
    // Completions are a separate measure from consumption/dedup closures.
    expect(p.presentation!.verifiedCompletions).toBe(1);
    expect(p.flow.recurrence.duplicateOccurrences).toBe(0);
  });
});

describe('R-11 new intake gets an attributable stage', () => {
  it('rows created through the real create path carry creation-enrollment and derive a candidate stage', async () => {
    for (const kind of ['bug', 'change', 'task'] as const) {
      const created = await issues.createIssue({ title: `r11 ${kind} intake`, body: 'created by the real path', kind, createdBy: 'su-r11' });
      const [row] = await db.sql<{ item_kind: string; status: string; payload: unknown; title: string; summary: string | null }[]>`
        SELECT item_kind, status, payload, title, summary FROM harness_shared.work_items WHERE feature_id = ${created.id}`;
      const ready = (row!.payload as { implementationReadiness?: { source?: string; status?: string } }).implementationReadiness;
      expect([kind, ready?.source, ready?.status]).toEqual([kind, 'creation-enrollment', 'unknown']);
      const stage = deriveWorkItemIntakeStage({ kind: row!.item_kind, status: row!.status, payload: row!.payload, title: row!.title, summary: row!.summary });
      expect([kind, stage.primaryStage, stage.reason]).toEqual([kind, 'candidate', 'awaiting-qualifying-acceptance']);
    }
  });

  it("the canary's new-intake-stage step passes through the same create path", async () => {
    const receipt = await runAcceptanceCanary(db.sql as never, {
      workspaceId: WS, harnessSlug: H, actor: 'su-canary', runtime: ACCEPTANCE_CANARY_RUNTIME, buildSha: 'test-build',
      probe: {
        create: async () => issues.createIssue({ title: 'acceptance canary probe', body: 'probe', createdBy: 'su-canary', assignee: 'su-canary' }),
        drop: async (id, runId) => { await issues.setIssueState(id, 'dropped' as never, 'su-canary', `acceptance-canary:${runId}`, { skipCompletionGate: true }); },
      },
    });
    const step = receipt.steps.find((s) => s.step === 'new-intake-stage')!;
    expect(step.ok).toBe(true);
    const [probe] = await db.sql<{ status: string }[]>`SELECT status FROM harness_shared.work_items WHERE feature_id = ${step.evidence.probeId as string}`;
    expect(probe!.status).toBe('dropped');
  });
});

describe('R-34 legacy work backfills in protected cohorts', () => {
  async function seedLegacy() {
    for (let i = 0; i < 6; i++) await seed(`WI-L-${i}`, { createdTs: 100 + i, payload: null });
    await seed('WI-L-CLAIMED', { createdTs: 200, payload: null, takenBy: 'worker-live', status: 'wip' });
    await seed('WI-L-PARKED', { createdTs: 201, payload: { _claimHold: true } });
    await seed('WI-L-TERMINAL', { createdTs: 202, payload: null, status: 'done' });
    await seed('WI-L-ENROLLED', { createdTs: 203, payload: readiness('unknown', 'creation-enrollment') });
    await seed('WI-L-OBS', { createdTs: 204, payload: { lane: 'observation' }, lane: 'observation' });
    await seed('WI-L-POST', { createdTs: POST, payload: null });
  }

  it('the report is a bounded dry run that names protected rows and leaves every row untouched', async () => {
    await seedLegacy();
    const before = await db.sql`SELECT feature_id, payload, updated_ts FROM harness_shared.work_items ORDER BY feature_id`;
    const report = await reportLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, selector: { kind: 'bug' }, limit: 4, actor: 'su-adopt' });
    expect(report).toMatchObject({ dryRun: true, examined: 4, unit: 'work-item rows', writer: 'reportLegacyAdoptionCohort' });
    expect(report.eligible).toEqual(['WI-L-0', 'WI-L-1', 'WI-L-2', 'WI-L-3']);
    expect(report.remainingLegacyOutsideCohort).toBe(4); // WI-L-4, WI-L-5, CLAIMED, PARKED stay visible
    expect(await db.sql`SELECT feature_id, payload, updated_ts FROM harness_shared.work_items ORDER BY feature_id`).toEqual(before);
    const full = await reportLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, selector: { kind: 'bug' }, limit: 10_000, actor: 'su-adopt' });
    expect(full.limit).toBe(LEGACY_ADOPTION_MAX_COHORT);
    expect(full.protected).toEqual([{ id: 'WI-L-CLAIMED', reason: 'in-flight-claim' }, { id: 'WI-L-PARKED', reason: 'claim-hold' }]);
    expect(full.eligible).not.toContain('WI-L-TERMINAL');
    expect(full.eligible).not.toContain('WI-L-ENROLLED');
    expect(full.eligible).not.toContain('WI-L-OBS');
    expect(full.eligible).not.toContain('WI-L-POST');
  });

  it('apply enrols only unchanged reported rows, never touches a claim taken after the report, and is single-use', async () => {
    await seedLegacy();
    const report = await reportLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, selector: { kind: 'bug' }, limit: 10, actor: 'su-adopt' });
    // A worker claims one reported row between report and apply.
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'worker-late', status = 'wip', updated_ts = 9 WHERE feature_id = 'WI-L-1'`;
    const viewBefore = await viewIds('WI-L-');
    const applied = await applyLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, reportRunId: report.runId, actor: 'su-adopt' });
    if (!applied.ok) throw new Error(`apply refused: ${applied.refusal}`);
    expect(applied.adopted).toEqual(['WI-L-0', 'WI-L-2', 'WI-L-3', 'WI-L-4', 'WI-L-5']);
    expect(applied.skipped).toEqual([{ id: 'WI-L-1', reason: 'changed-since-report' }]);
    expect(await holder('WI-L-1')).toBe('worker-late');
    expect((await payloadOf('WI-L-1')).implementationReadiness).toBeUndefined();
    const adopted = await payloadOf('WI-L-0');
    expect(adopted).toMatchObject({ implementationReadiness: { status: 'unknown', source: 'creation-enrollment' }, legacyAcceptanceAdoption: { runId: applied.runId } });
    // No freeze: claimability of the cohort is unchanged; the stage moves to reviewable intake.
    expect(await viewIds('WI-L-')).toEqual(viewBefore);
    expect(deriveWorkItemIntakeStage({ kind: 'bug', status: 'open', payload: adopted, title: TITLE, summary: SUMMARY }).primaryStage).toBe('candidate');
    expect(await applyLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, reportRunId: report.runId, actor: 'su-adopt' }))
      .toMatchObject({ ok: false, refusal: 'already-applied' });
  });

  it('recovery restores the prior state except where a reviewer has decided since', async () => {
    await seedLegacy();
    const report = await reportLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, selector: { kind: 'bug' }, limit: 3, actor: 'su-adopt' });
    const applied = await applyLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, reportRunId: report.runId, actor: 'su-adopt' });
    if (!applied.ok) throw new Error('apply refused');
    // A reviewer accepts WI-L-2 after adoption; recovery must keep that decision.
    await db.sql`UPDATE harness_shared.work_items SET payload = payload || ${db.sql.json(qualifying() as never)}::jsonb WHERE feature_id = 'WI-L-2'`;
    const reverted = await revertLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, applyRunId: applied.runId, actor: 'su-adopt' });
    if (!reverted.ok) throw new Error('revert refused');
    expect(reverted.restored).toEqual(['WI-L-0', 'WI-L-1']);
    expect(reverted.kept).toEqual([{ id: 'WI-L-2', reason: 'reviewed-since-adoption' }]);
    expect(await payloadOf('WI-L-0')).toEqual({});
    expect((await payloadOf('WI-L-2')).implementationReadiness).toMatchObject({ status: 'ready', source: 'agent-review' });
    expect(await revertLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, applyRunId: applied.runId, actor: 'su-adopt' }))
      .toMatchObject({ ok: false, refusal: 'already-reverted' });
  });

  it('an expired report cannot be applied', async () => {
    await seedLegacy();
    const report = await reportLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, selector: { kind: 'bug' }, limit: 2, actor: 'su-adopt' });
    expect(await applyLegacyAdoptionCohort(db.sql as never, { workspaceId: WS, harnessSlug: H, reportRunId: report.runId, actor: 'su-adopt', now: () => Date.now() + 2 * 60 * 60_000 }))
      .toMatchObject({ ok: false, refusal: 'report-expired' });
  });
});

describe('R-35 NULL state never manufactures acceptance', () => {
  it('NULL payload, missing readiness and an expired fail-open (admission unreviewed) stay refused post-cutover', async () => {
    await seed('WI-R35-NULL', { createdTs: POST, payload: null });
    await seed('WI-R35-EMPTY', { createdTs: POST, payload: {} });
    await seed('WI-R35-FAIL-OPEN', { createdTs: POST, payload: null, admission: 'unreviewed' });
    await seed('WI-R35-FAIL-OPEN-READY', { createdTs: POST, payload: readiness('ready', 'capture-policy'), admission: 'unreviewed' });
    expect(await viewIds('WI-R35-')).toEqual([]);
    expect(await drainIds('WI-R35-')).toEqual([]);
    const labels = await floorLabels('WI-R35-');
    for (const id of Object.keys(labels)) expect([id, labels[id]!.includes('implementation-readiness')]).toEqual([id, true]);
    const [{ admits }] = await db.sql<{ admits: boolean | null }[]>`
      SELECT harness_shared.work_item_implementation_readiness_admits(NULL::jsonb, 'bug', ${TITLE}, ${SUMMARY}, ${POST}::bigint) AS admits`;
    expect(admits).toBe(false); // FALSE, never NULL — NOT(floor) keeps meaning "held"
  });

  it("the canary's fail-closed probes are refused by the deployed SQL floor and its TS twin", async () => {
    const receipt = await runAcceptanceCanary(db.sql as never, {
      workspaceId: WS, harnessSlug: H, actor: 'su-canary', runtime: ACCEPTANCE_CANARY_RUNTIME, buildSha: 'test-build',
      probe: { create: async () => { throw new Error('not exercised here'); }, drop: async () => {} },
    });
    const step = receipt.steps.find((s) => s.step === 'fail-closed')!;
    expect(step.ok).toBe(true);
    expect((step.evidence.verdicts as Array<{ sql: boolean }>).every((v) => v.sql === false)).toBe(true);
  });
});

describe('R-36 fast paths need an authorized policy receipt', () => {
  it('severity, security tags and explicit assignment do not waive the floor; a scoped policy receipt admits', async () => {
    for (const p of acceptanceCanaryProbes().filter((x) => x.step === 'fast-path')) {
      await seed(`WI-R36-${p.probe}`, { createdTs: POST, payload: p.payload, title: 'acceptance canary probe', summary: 'synthetic row; never written' });
      if (p.probe === 'policy-receipt') {
        const acceptance = evaluateImplementationAcceptance(p.payload, {
          kind: 'bug', title: 'acceptance canary probe', summary: 'synthetic row; never written',
        });
        if (acceptance.contract?.verification.check === 'reproduction') {
          h.currentBuild = acceptance.contract.verification.receipt.buildSha;
        }
      }
    }
    expect(await viewIds('WI-R36-')).toEqual(['WI-R36-policy-receipt']);
    // Explicit assignment by id is not a waiver either.
    expect(await byIdClaims('WI-R36-explicit-assignment', 'su-assigned')).toBe(false);
    expect(await byIdClaims('WI-R36-critical-severity', 'worker-sev')).toBe(false);
    expect(await byIdClaims('WI-R36-policy-receipt', 'worker-policy')).toBe(true);
    // A policy outside the allowlist is not a receipt.
    const forged = readiness('ready', 'capture-policy', { ...sealed({ kind: 'policy', policy: 'trusted-tool-failure-promotion', actor: 'x' }), authority: { kind: 'policy', policy: 'severity-critical', actor: 'x' } });
    expect(implementationReadinessAdmitsClaim({ payload: forged, kind: 'bug', title: TITLE, summary: SUMMARY, createdAtMs: POST })).toBe(false);
  });

  it("the canary's fast-path step records the same verdicts", async () => {
    const receipt = await runAcceptanceCanary(db.sql as never, {
      workspaceId: WS, harnessSlug: H, actor: 'su-canary', runtime: ACCEPTANCE_CANARY_RUNTIME, buildSha: 'test-build',
      probe: { create: async () => { throw new Error('not exercised here'); }, drop: async () => {} },
    });
    expect(receipt.steps.find((s) => s.step === 'fast-path')!.ok).toBe(true);
    expect(receipt.status).toBe('failed'); // the create step was deliberately broken
  });
});

describe('R-37 canary adoption precedes broad enforcement', () => {
  const runCanary = (create: () => Promise<{ id: string }>, runtime: string = ACCEPTANCE_CANARY_RUNTIME) =>
    runAcceptanceCanary(db.sql as never, {
      workspaceId: WS, harnessSlug: H, actor: 'su-canary', runtime, buildSha: 'test-build',
      probe: { create, drop: async (id, runId) => { await issues.setIssueState(id, 'dropped' as never, 'su-canary', `acceptance-canary:${runId}`, { skipCompletionGate: true }); } },
    });
  const realCreate = () => issues.createIssue({ title: 'acceptance canary probe', body: 'probe', createdBy: 'su-canary', assignee: 'su-canary' });
  const check = (proposedCutoverMs = Date.now() + 60_000) =>
    authorizeEnforcementCutoverAdvance(db.sql as never, { workspaceId: WS, harnessSlug: H, proposedCutoverMs });

  it('the cutover refuses to move with no receipt, a failed receipt, or a receipt for another runtime', async () => {
    expect(await check()).toMatchObject({ ok: false, refusal: 'no-successful-canary-receipt', runtime: 'operator-api' });
    const failed = await runCanary(async () => { throw new Error('create path down'); });
    expect(failed.status).toBe('failed');
    expect(await check()).toMatchObject({ ok: false, refusal: 'no-successful-canary-receipt' });
    const elsewhere = await runCanary(realCreate, 'bg-host');
    expect(elsewhere.status).toBe('passed');
    expect(await check()).toMatchObject({ ok: false, refusal: 'no-successful-canary-receipt' });
  });

  it('a passed four-step receipt on the named runtime authorizes a later cutover, never an earlier one', async () => {
    const passed = await runCanary(realCreate);
    expect(passed.status).toBe('passed');
    expect(passed.steps.map((s) => s.step)).toEqual([...ACCEPTANCE_CANARY_STEPS]);
    expect(await check()).toMatchObject({ ok: true, receiptRunId: passed.runId, runtime: 'operator-api' });
    expect(await check(Date.parse(passed.recordedAt) - 60_000)).toMatchObject({ ok: false, refusal: 'cutover-precedes-canary' });
  });

  it('the compiled cutover moves off the D-018 sentinel only with a canary attestation', () => {
    expect(enforcementCutoverAttested(IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER, ENFORCEMENT_CUTOVER_CANARY_ATTESTATION).ok).toBe(true);
    if (IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER === ENFORCEMENT_CUTOVER_SENTINEL) {
      expect(ENFORCEMENT_CUTOVER_CANARY_ATTESTATION).toBeNull();
    }
    expect(enforcementCutoverAttested('2026-10-05T00:00:00.000Z', null)).toEqual({ ok: false, refusal: 'cutover-moved-without-canary-attestation' });
    expect(enforcementCutoverAttested('2026-10-05T00:00:00.000Z', {
      receiptRunId: 'lac-canary-x', runtime: 'operator-api', buildSha: 'abc', recordedAt: '2026-10-04T00:00:00.000Z',
    })).toEqual({ ok: true, enforcing: true });
  });
});
