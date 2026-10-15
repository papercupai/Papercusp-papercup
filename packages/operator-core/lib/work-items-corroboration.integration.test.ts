/**
 * Corroboration count, end-to-end on real Postgres
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-012, D-049).
 *
 * The count is the number of distinct reporters in `harness_shared.work_item_occurrences`
 * (migration 831). It ORDERS the verifier lane and is shown on the item, and it is never a
 * verification receipt: the claim floor (654 … 1373) must give the same answer for a bug
 * with forty reporters as for one with none.
 *
 * Describe titles are the rating basis of the specs they name:
 *   SPEC-P-012          — a heavily corroborated bug still needs a receipt to be claimable;
 *   AUTO-BAR-R-3-P-012  — this item's slice of R-3 (D-045): no unverified bug is claimable
 *                         however corroborated, a verified one becomes claimable, and the
 *                         verifier lane serves the most-corroborated subject first.
 *
 * The fixture mirrors work-items-intake-acceptance.integration.test.ts (same claim-floor
 * migration chain); it is a separate file so that file's bound acceptance evidence keeps
 * its blob.
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
  IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS,
  createImplementationReadiness,
  createVerificationTask,
  sealImplementationAcceptance,
  type ImplementationAcceptanceAuthority,
} from './harness/improvements/agent-review-policy';

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
  sql: undefined as unknown as postgres.Sql,
  currentBuild: 'abcdef1' as string | null,
  beforeBuild: null as (() => Promise<void>) | null,
}));
vi.mock('./attention/intake-promotion', async (orig) => {
  const actual = await orig<typeof import('./attention/intake-promotion')>();
  const currentTargetBuild = async () => { await h.beforeBuild?.(); return h.currentBuild; };
  return {
    ...actual,
    currentIntakeTargetBuild: currentTargetBuild,
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
const { claimNextVerificationTask } = await import('./harness/improvements/agent-review');
const { readCorroboration, readCorroborationSummary, corroborationReportersSql, readOccurrenceReporters } = await import(
  './harness/improvements/corroboration'
);
const { readReporterStatus } = await import('./harness/improvements/reporter-status');

const H = 'papercup';
const WS = 'default';
const OP = `operator:${WS}`;
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
const REVIEW: ImplementationAcceptanceAuthority = { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-author', round: 1 };
let db: FreshPgDb;

/** A sealed bug contract WITH its reproduction receipt (P-006). */
function sealedWithReceipt() {
  const result = sealImplementationAcceptance({
    proposal: PROPOSAL, authority: REVIEW, reason: 'fixture acceptance', source: { kind: 'bug', title: TITLE, summary: SUMMARY }, acceptedAt: AT,
    reproduction: { kind: 'failing-test', ref: 'fixture.test.ts', buildSha: 'abcdef1' },
  });
  if (!result.ok) throw new Error('fixture contract must seal');
  return result.contract;
}
const readiness = (status: 'ready' | 'unknown', source: 'agent-review' | 'creation-enrollment', acceptance?: object) => ({
  implementationReadiness: createImplementationReadiness({
    status, source, updatedAt: AT,
    reason: status === 'ready' ? `${source} fixture` : 'no-acceptance-evidence-at-creation',
    ...(acceptance ? { evidence: { acceptance: acceptance as Record<string, unknown> } } : {}),
  }),
});
const verified = () => readiness('ready', 'agent-review', sealedWithReceipt());
/** Every corroboration signal a payload can carry, and none of them a receipt. */
const HEAVY_CORROBORATION_PAYLOAD = {
  repeatCount: 40,
  reporters: Array.from({ length: 12 }, (_, i) => `su-reporter-${i}`),
  reporterKinds: ['agent', 'watchdog', 'end-user'],
};

async function seed(id: string, o: { createdTs?: number; payload?: Record<string, unknown> | null } = {}) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, payload, origin, title, summary)
    VALUES (${H}, ${id}, 'bug', 'open', NULL, ${WS}, ${o.createdTs ?? POST}, 1,
            ${o.payload ? db.sql.json(o.payload as never) : null}, 'local', ${TITLE}, ${SUMMARY})`;
}
async function setPayload(id: string, payload: Record<string, unknown>) {
  await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json(payload as never)} WHERE feature_id = ${id}`;
}
/** One occurrence row, as capture writes it on mint and on every fold. */
async function occur(
  id: string,
  reporter: string | null,
  o: { kind?: string; harness?: string; ws?: string; at?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_item_occurrences
      (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter, source_tool, report_kind, reported_title, occurred_at)
    VALUES (${o.ws ?? WS}, ${o.harness ?? H}, ${id}, ${reporter}, 'improvements:capture', ${o.kind ?? 'coalesced'}, ${TITLE},
            ${o.at ?? AT})`;
}
async function corroborate(id: string, reporters: number) {
  for (let i = 0; i < reporters; i++) await occur(id, `su-reporter-${i}`, { kind: i === 0 ? 'canonical-created' : 'coalesced' });
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
async function floorLabels(id: string): Promise<string[]> {
  const [row] = await db.sql<{ floors: string[] }[]>`
    SELECT harness_shared.work_item_claim_floors(
             workspace_id, status, taken_by, origin, title, terminal_owner, terminal_completion_ref,
             payload, feature_id, item_kind, summary, created_ts) AS floors
      FROM harness_shared.work_items WHERE feature_id = ${id}`;
  return row?.floors ?? [];
}
async function reportersScalar(id: string): Promise<number> {
  const [row] = await db.sql<{ n: string | number }[]>`
    SELECT ${corroborationReportersSql(db.sql as never)} AS n FROM harness_shared.work_items wi WHERE wi.feature_id = ${id}`;
  return Number(row?.n);
}

beforeAll(async () => {
  db = await createFreshPgDb('work-items-corroboration');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(ADV_SESSIONS_CLAIM_MIN_DDL);
  await db.sql.unsafe(WATCHDOG_TICKS_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'work-items-corroboration.integration.test.ts' });
  await db.sql.unsafe(readMigration('675-normalize-plan-items-decisions.sql')).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';
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
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
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
    '1368-acceptance-claim-floor-kind-verification.sql',
    '1373-completion-verification-claim-floor.sql',
    // The occurrence ledger the count reads.
    '831-issue-occurrence-ledger.sql',
    '1037-work-item-first-claim-stamp.sql',
    '1294-work-item-readiness-payload-projections.sql',
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
                       harness_shared.work_item_occurrences`;
});

describe('P-012 the count is distinct reporters in the occurrence ledger', () => {
  it('inherits source filings on distinct promotion without double-counting reporters or changing remote authorship', async () => {
    await seed('WI-SOURCE');
    await db.sql`UPDATE harness_shared.work_items SET origin = 'remote' WHERE feature_id = 'WI-SOURCE'`;
    await seed('WI-TARGET', { payload: { intakeSource: { id: 'WI-SOURCE', mode: 'distinct' } } });
    await occur('WI-SOURCE', 'su-a');
    await occur('WI-SOURCE', 'su-b');
    await occur('WI-TARGET', 'su-a');
    await occur('WI-SOURCE', 'foreign-workspace', { ws: 'elsewhere' });
    await occur('WI-SOURCE', 'foreign-harness', { harness: 'elsewhere' });
    const ledger = await readCorroboration(db.sql as never, { workspaceId: WS, items: [{ id: 'WI-SOURCE', harness: H }, { id: 'WI-TARGET', harness: H }] });
    expect(ledger.get('WI-TARGET')).toMatchObject({ reporters: 2, filings: 3 });
    expect(ledger.get('WI-SOURCE')).toMatchObject({ reporters: 2, filings: 2 });
    expect(await reportersScalar('WI-TARGET')).toBe(2);
    expect(await readOccurrenceReporters(db.sql as never, { workspaceId: WS, harness: H, id: 'WI-TARGET' })).toEqual(['su-a', 'su-b']);
    expect((await db.sql`SELECT origin, payload FROM harness_shared.work_items WHERE feature_id = 'WI-SOURCE'`)[0]).toMatchObject({ origin: 'remote', payload: null });
  });

  it('counts distinct non-blank reporters, counts filings without promotions, and stays in its workspace and harness', async () => {
    await seed('WI-CO-A', { payload: { reporterKinds: ['agent', 'end-user'] } });
    await occur('WI-CO-A', 'su-a', { kind: 'canonical-created', at: '2026-10-01T00:00:00.000Z' });
    await occur('WI-CO-A', 'su-b', { kind: 'coalesced', at: '2026-10-02T00:00:00.000Z' });
    await occur('WI-CO-A', ' su-a ', { kind: 'duplicate', at: '2026-10-03T00:00:00.000Z' }); // same reporter, padded
    await occur('WI-CO-A', 'su-a', { kind: 'promoted', at: '2026-10-04T00:00:00.000Z' }); // an admission step, not a report
    await occur('WI-CO-A', null, { kind: 'regression', at: '2026-10-05T00:00:00.000Z' }); // a filing with no reporter
    await occur('WI-CO-A', '   ', { kind: 'coalesced', at: '2026-10-05T12:00:00.000Z' });
    await occur('WI-CO-A', 'su-elsewhere-harness', { harness: 'other-harness' });
    await occur('WI-CO-A', 'su-elsewhere-workspace', { ws: 'other-workspace' });

    const ledger = await readCorroboration(db.sql as never, { workspaceId: WS, items: [{ id: 'WI-CO-A', harness: H }] });
    expect(ledger.get('WI-CO-A')).toEqual({
      reporters: 2,
      filings: 5,
      firstFiledAt: '2026-10-01T00:00:00.000Z',
      lastFiledAt: '2026-10-05T12:00:00.000Z',
    });
    // The ORDER BY scalar and the batch read agree.
    expect(await reportersScalar('WI-CO-A')).toBe(2);

    const summary = await readCorroborationSummary(
      { workspaceId: WS, id: 'WI-CO-A', harness: H, payload: { reporterKinds: ['end-user', 'agent', 'bogus'] } },
      db.sql as never,
    );
    expect(summary).toMatchObject({ reporters: 2, filings: 5, reporterKinds: ['agent', 'end-user'] });
    expect(summary?.note).toMatch(/never a verification receipt/);
  });

  it('an item nothing corroborates reads 0 in the scalar and no block on the item', async () => {
    await seed('WI-CO-NONE');
    expect(await reportersScalar('WI-CO-NONE')).toBe(0);
    expect(await readCorroborationSummary({ workspaceId: WS, id: 'WI-CO-NONE', harness: H, payload: null }, db.sql as never)).toBeNull();
  });
});

describe('P016 installed reporter status follows the distinct canonical fix', () => {
  it.each(['end-user', 'chat'])('reads %s canonical status and question while keeping the answer on the scoped source', async (kind) => {
    await seed('WI-REPORT-SOURCE', { payload: { reporter: { kind }, reporterAnswer: { questionId: 'q1', text: 'CSV export', answeredAt: AT } } });
    await seed('WI-REPORT-FIX', { payload: { ...verified(), reporter: { kind }, intakeSource: { id: 'WI-REPORT-SOURCE', mode: 'distinct' },
      reporterQuestion: { id: 'q1', text: 'Which export?', askedBy: 'su-fixer', askedAt: AT } } });
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'su-fixer' WHERE feature_id = 'WI-REPORT-FIX'`;
    expect(await readReporterStatus({ id: 'WI-REPORT-SOURCE', harness: H, workspaceId: WS }, db.sql as never)).toMatchObject({
      sourceId: 'WI-REPORT-SOURCE', canonicalId: 'WI-REPORT-FIX', status: 'being-fixed', followUp: { question: { text: 'Which export?' }, answer: { text: 'CSV export' } },
    });
    expect(await readReporterStatus({ id: 'WI-REPORT-FIX', harness: H, workspaceId: WS }, db.sql as never)).toBeNull();
    expect(await readReporterStatus({ id: 'WI-REPORT-SOURCE', harness: H, workspaceId: 'other' }, db.sql as never)).toBeNull();
    expect(await readReporterStatus({ id: 'WI-REPORT-SOURCE', harness: 'other', workspaceId: WS }, db.sql as never)).toBeNull();
    expect((await db.sql`SELECT payload -> 'reporterAnswer' AS answer FROM harness_shared.work_items WHERE feature_id = 'WI-REPORT-FIX'`)[0].answer).toBeNull();
  });
});

describe('SPEC-P-012 a heavily corroborated bug still requires a verification receipt before it becomes claimable', () => {
  it('forty reporters and every payload signal do not make an unverified bug claimable; the receipt does', async () => {
    const unverified = { ...readiness('unknown', 'creation-enrollment'), ...HEAVY_CORROBORATION_PAYLOAD };
    await seed('WI-CR-HEAVY', { payload: unverified });
    await seed('WI-CR-QUIET', { payload: readiness('unknown', 'creation-enrollment') });
    await corroborate('WI-CR-HEAVY', 40);
    expect(await reportersScalar('WI-CR-HEAVY')).toBe(40);

    // The floor gives the corroborated bug exactly the answer it gives the quiet one.
    const heavyFloors = await floorLabels('WI-CR-HEAVY');
    expect(heavyFloors.length).toBeGreaterThan(0);
    expect(heavyFloors).toEqual(await floorLabels('WI-CR-QUIET'));
    expect(await viewIds('WI-CR-')).toEqual([]);
    expect(await drainIds('WI-CR-')).toEqual([]);

    // The receipt, and only the receipt, opens it. The ledger is unchanged.
    await setPayload('WI-CR-HEAVY', { ...verified(), ...HEAVY_CORROBORATION_PAYLOAD });
    expect(await floorLabels('WI-CR-HEAVY')).toEqual([]);
    expect(await viewIds('WI-CR-')).toEqual(['WI-CR-HEAVY']);
    expect(await drainIds('WI-CR-')).toEqual(['WI-CR-HEAVY']);
    expect(await reportersScalar('WI-CR-HEAVY')).toBe(40);
  });

  it('a ready verdict with no acceptance contract is not a receipt either, however corroborated', async () => {
    await seed('WI-CR-NOCONTRACT', { payload: { ...readiness('ready', 'agent-review'), ...HEAVY_CORROBORATION_PAYLOAD } });
    await corroborate('WI-CR-NOCONTRACT', 25);
    expect((await floorLabels('WI-CR-NOCONTRACT')).length).toBeGreaterThan(0);
    expect(await viewIds('WI-CR-')).toEqual([]);
    expect(await drainIds('WI-CR-')).toEqual([]);
  });
});

describe('AUTO-BAR-R-3-P-012 verification work is served most-corroborated subject first', () => {
  const task = (subject: string) =>
    ({ ...verified(), verification: createVerificationTask({ subject, check: 'reproduction', reporters: ['su-r1'], implementers: ['su-b1'] }) });

  it('the verifier lane serves the task whose subject has more distinct reporters before an older one', async () => {
    await seed('WI-VT-LOW', { createdTs: POST, payload: task('WI-VS-LOW') });
    await seed('WI-VT-HIGH', { createdTs: POST + 60_000, payload: task('WI-VS-HIGH') });
    await corroborate('WI-VS-LOW', 1);
    await corroborate('WI-VS-HIGH', 3);
    // Filings volume is not independence: one reporter filing many times stays at 1.
    for (let i = 0; i < 10; i++) await occur('WI-VS-LOW', 'su-reporter-0', { kind: 'coalesced' });

    const first = await claimNextVerificationTask({ verifier: 'su-verifier', harnessSlug: H });
    const second = await claimNextVerificationTask({ verifier: 'su-verifier-2', harnessSlug: H });
    expect([first?.id ?? null, second?.id ?? null]).toEqual(['WI-VT-HIGH', 'WI-VT-LOW']);
  });

  it('with no corroboration on either subject the lane falls back to oldest first (the calibration)', async () => {
    await seed('WI-VT-LOW', { createdTs: POST, payload: task('WI-VS-LOW') });
    await seed('WI-VT-HIGH', { createdTs: POST + 60_000, payload: task('WI-VS-HIGH') });
    const first = await claimNextVerificationTask({ verifier: 'su-verifier', harnessSlug: H });
    expect(first?.id).toBe('WI-VT-LOW');
  });

  it('the parties are still refused however corroborated the subject is', async () => {
    await seed('WI-VT-HIGH', { payload: task('WI-VS-HIGH') });
    await corroborate('WI-VS-HIGH', 5);
    expect(await claimNextVerificationTask({ verifier: 'su-r1', harnessSlug: H })).toBeNull();
    expect(await claimNextVerificationTask({ verifier: 'su-b1', harnessSlug: H })).toBeNull();
    expect((await claimNextVerificationTask({ verifier: 'su-verifier', harnessSlug: H }))?.id).toBe('WI-VT-HIGH');
  });
});
