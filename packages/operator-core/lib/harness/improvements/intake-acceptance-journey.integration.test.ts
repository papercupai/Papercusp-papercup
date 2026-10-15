/**
 * observation-candidate-acceptance-promotion-2026-09-30 P-012 (R-12): the chained intake
 * journey on a fully migrated Postgres.
 *
 * Each stage is proven in isolation by its owning item's suite (P-006
 * attention/intake-promotion.integration.test.ts, P-011
 * work-items-intake-acceptance.integration.test.ts). This file proves the stages
 * COMPOSE through the real default dependencies, with no seeded intermediate state:
 *
 *   observation filed → independent promote decision (a double accept yields one item)
 *   → accepted ready work → by-id claim admitted under the post-cutover acceptance floor
 *   → completion with committed authority → counted as a verified completion by both the
 *   TS classifier and the shared SQL aggregation.
 *
 * Negative and concurrency cases sit inside the journey, at the stage they guard:
 * self-review and a source edited after the decision are refused without writing,
 * a concurrent double accept converges on one item, an unaccepted candidate is refused
 * at the claim floor, and a committed close of unaccepted work is never counted as a
 * verified completion.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { FilterNode } from '../../scheduler/claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../../attention/intake-promotion', async (orig) => {
  const actual = await orig<typeof import('../../attention/intake-promotion')>();
  const currentTargetBuild = async () => BUILD;
  return {
    ...actual,
    currentIntakeTargetBuild: currentTargetBuild,
    // Supply the build adapter at the server wrapper's dependency boundary.
    // Its lexical default does not read the mocked export; ledger reads stay real.
    verifyAcceptedWorkItemBugReproduction: (item: Parameters<typeof actual.verifyAcceptedWorkItemBugReproduction>[0]) =>
      actual.verifyAcceptedWorkItemBugReproduction(item, {
        currentTargetBuild,
        ledger: actual.defaultReproductionLedgerDeps(),
      }),
  };
});

const { createIssue, claimIssue } = await import('../../issues-engineer');
const {
  currentIntakeSourceRevision,
  defaultIntakePromotionDeps,
  defaultReproductionLedgerDeps,
  executeIntakeDecision,
  readIntakeReproduction,
} = await import('../../attention/intake-promotion');
const { stampFiledBugReproduction } = await import('../../attention/bug-reproduction');
const { parseIntakeDecision } = await import('../../attention/bulk-dispositions');
const { setWorkItemState } = await import('../../work-items');
const { readWorkItemReadinessProjection } = await import('../../work-items-admission-promoter');
const { readIssueClaimability } = await import('../../scheduler/get-next');
const {
  IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS,
  createImplementationReadiness,
  deriveWorkItemPresentationStage,
} = await import('./agent-review-policy');

type DecisionInput = import('../../attention/bulk-dispositions').BulkIntakeDecisionInput;

let db: OrgTestDb;

beforeAll(async () => {
  // POST_CUTOVER is beyond a far-future sentinel. Filing grace is an independent
  // caller-relative floor; leave it neutral so it cannot mask receipt admission.
  vi.stubEnv('PAPERCUSP_FILING_GRACE_SEC', '0');
  // The double accept runs a lock holder, its writer and a waiter at once (see the P-006 suite).
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  vi.unstubAllEnvs();
});

const FILER = 'su-journey-filer';
const REVIEWER = 'su-journey-reviewer';
const WORKER = 'su-journey-worker';
// Control the target checkout identity, keeping the production ledger reads and writers.
const BUILD = 'abc1234def'.padEnd(40, '0');
const OTHER_BUILD = 'b'.repeat(40);
/** D-018 §3: rows dated after the cutover are judged by the acceptance floor whatever the sentinel is. */
const POST_CUTOVER = IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS + 60_000;
const ACCEPTANCE = {
  problem: 'the nightly export drops rows whose note field contains a tab',
  evidence: ['export run 811 has 412 source rows and 409 exported rows'],
  outcome: 'every source row appears in the export',
  scope: 'the tab-escaping step of the nightly export only',
  completionCheck: 'an export of a fixture with tabbed notes has as many rows as its source',
};

function tag(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Row {
  feature_id: string;
  workspace_id: string;
  harness_slug: string;
  item_kind: string;
  status: string;
  title: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  taken_by: string | null;
  terminal_owner: string | null;
  terminal_completion_ref: string | null;
  authority: string | null;
}

async function row(id: string): Promise<Row> {
  const [r] = await db.adminSql<Row[]>`
    SELECT feature_id, workspace_id, harness_slug, item_kind, status, title, summary, payload,
           taken_by, terminal_owner, terminal_completion_ref, authority
      FROM harness_shared.work_items WHERE feature_id = ${id}`;
  if (!r) throw new Error(`no work_items row for ${id}`);
  return r;
}

async function stage(id: string): Promise<string> {
  const r = await row(id);
  return deriveWorkItemPresentationStage({
    kind: r.item_kind,
    status: r.status,
    payload: r.payload,
    title: r.title,
    summary: r.summary,
    assignee: r.taken_by,
    terminalOwner: r.terminal_owner,
    terminalCompletionRef: r.terminal_completion_ref,
    completionAuthority: r.authority,
  }).stage;
}

async function promotedFrom(sourceId: string): Promise<string[]> {
  const rows = await db.adminSql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE payload -> 'intakeSource' ->> 'id' = ${sourceId} AND feature_id <> ${sourceId}`;
  return rows.map((r) => r.feature_id);
}

/**
 * Record a decision exactly as the report path does: bound to the revision judged now.
 * Every promote in this journey is a bug fix, so it carries the D-023 reproduction
 * receipt the reviewer recorded (P-013); the receipt gate itself is covered in
 * attention/intake-promotion.integration.test.ts.
 */
async function decide(sourceId: string, input: DecisionInput, decidedBy: string) {
  const sourceRevision = await currentIntakeSourceRevision(sourceId);
  const withReceipt =
    input.disposition === 'promote' && input.reproduction === undefined
      ? { ...input, reproduction: { kind: 'failing-test', ref: 'export-tabbed-rows.test.ts', buildSha: 'abc1234def' } }
      : input;
  const parsed = parseIntakeDecision(withReceipt, { decidedBy, sourceRevision });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.decision;
}

function exec(sourceId: string, decision: Awaited<ReturnType<typeof decide>>, runId: string, targetBuild = BUILD) {
  return executeIntakeDecision(
    { sourceId, decision, runId, itemId: `att-${sourceId}` },
    defaultIntakePromotionDeps({ currentTargetBuild: async () => targetBuild }),
  );
}

/** A by-id claim's verdict is the row's holder afterwards; a refusal may throw or return. */
async function claims(id: string, assignee: string, workspaceId: string): Promise<boolean> {
  try {
    await claimIssue(id, assignee, { workspaceId } as never);
  } catch {
    /* refused */
  }
  return (await row(id)).taken_by === assignee;
}

/** The scheduler's self-select read, scoped to one row. */
async function claimability(id: string, workspaceId: string, harness: string) {
  const filter: FilterNode = { field: 'id', op: 'in', value: [id] };
  return readIssueClaimability(filter, {
    harness, workspaceId, states: ['open'], assignee: WORKER, client: db.adminSql,
  }, { limit: 10 });
}

async function selfSelectable(id: string, workspaceId: string, harness: string): Promise<boolean> {
  const read = await claimability(id, workspaceId, harness);
  return read.rows.some((r) => r.id === id);
}

async function verifiedCompletions(workspaceId: string, harnessSlug: string): Promise<number> {
  const projection = await readWorkItemReadinessProjection({ workspaceId, harnessSlug, sql: db.adminSql });
  if (!projection.presentation) throw new Error('readiness projection returned no presentation block');
  return projection.presentation.verifiedCompletions;
}

describe('R-12 observation → candidate → accepted work → verified completion', () => {
  it('composes end to end through the real paths, with its negative and concurrency cases at each stage', async () => {
    const t = tag();

    // 1. An observation is evidence: it is not work and nothing can claim it.
    const obs = await createIssue({
      kind: 'bug',
      title: `nightly export drops tabbed rows ${t}`,
      body: `export run 811 lost three rows ${t}`,
      scope: 'harness:papercusp',
      createdBy: FILER,
      payload: { lane: 'observation' },
    });
    const { workspace_id: ws, harness_slug: harness } = await row(obs.id);
    expect(await stage(obs.id)).toBe('observation');
    // R-1 gates self-selection; a by-id claim of an observation is a deliberate escape hatch
    // (work-items-observation-lane-exclusion.integration.test.ts), so it is not asserted here.
    expect(await selfSelectable(obs.id, ws, harness)).toBe(false);

    // 2a. Reviewer independence: the filer cannot accept its own report.
    const selfReview = await decide(obs.id, { disposition: 'promote', reason: 'r', workKind: 'fix', acceptance: ACCEPTANCE }, FILER);
    expect(await exec(obs.id, selfReview, `journey-self-${t}`)).toMatchObject({ ok: false, refusal: 'acceptance-invalid-authority' });
    expect(await promotedFrom(obs.id)).toEqual([]);

    // 2b. Source-change race: a decision judged before an edit is refused and writes nothing.
    const stale = await decide(obs.id, { disposition: 'promote', reason: 'r', workKind: 'fix', acceptance: ACCEPTANCE }, REVIEWER);
    await db.adminSql`UPDATE harness_shared.work_items SET summary = summary || ' (third occurrence)' WHERE feature_id = ${obs.id}`;
    expect(await exec(obs.id, stale, `journey-stale-${t}`)).toMatchObject({ ok: false, refusal: 'source-revision-changed' });
    expect(await promotedFrom(obs.id)).toEqual([]);

    // 3. Concurrency: two executors of the same fresh decision yield exactly one accepted item.
    const decision = await decide(obs.id, { disposition: 'promote', reason: 'reproduced', workKind: 'fix', acceptance: ACCEPTANCE }, REVIEWER);
    const [a, b] = await Promise.all([exec(obs.id, decision, `journey-a-${t}`), exec(obs.id, decision, `journey-b-${t}`)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.workItemId).toBe(b.workItemId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const workId = a.workItemId!;
    expect(await promotedFrom(obs.id)).toEqual([workId]);
    expect(await stage(obs.id)).toBe('observation');
    expect(await stage(workId)).toBe('accepted-ready');

    // A control candidate that no reviewer accepted, filed through the same create path.
    const candidate = await createIssue({
      kind: 'bug',
      title: `settings page renders the wrong locale ${t}`,
      body: `locale fallback picks en-GB for fr-CA users ${t}`,
      scope: 'harness:papercusp',
      createdBy: FILER,
      payload: {
        implementationReadiness: createImplementationReadiness({
          status: 'unknown',
          source: 'creation-enrollment',
          reason: 'no-acceptance-evidence-at-creation',
          updatedAt: new Date().toISOString(),
        }),
      },
    });
    expect(await stage(candidate.id)).toBe('candidate');

    // 4. The claim floor judges both rows as post-cutover intake: accepted work is admitted,
    //    the unaccepted candidate is refused.
    await db.adminSql`UPDATE harness_shared.work_items SET created_ts = ${POST_CUTOVER}
                       WHERE feature_id IN (${workId}, ${candidate.id})`;
    expect(await claims(candidate.id, WORKER, ws)).toBe(false);
    expect(await claims(workId, WORKER, ws)).toBe(true);
    expect(await stage(workId)).toBe('accepted-active');

    // 5. Completion with committed authority is a verified completion on both readers.
    const before = await verifiedCompletions(ws, harness);
    await setWorkItemState(workId, 'resolved', {
      harness,
      by: WORKER,
      completionAuthority: 'committed',
      completionEvidence: {
        verifiedHow: 'integration',
        testsRun: 'export fixture with tabbed notes',
        testResult: 'passed',
      },
    });
    expect(await stage(workId)).toBe('verified-completion');
    expect(await verifiedCompletions(ws, harness)).toBe(before + 1);

    // A committed close of work nobody accepted is history, never a verified completion.
    await setWorkItemState(candidate.id, 'resolved', {
      harness,
      by: FILER,
      completionAuthority: 'committed',
      completionEvidence: { verifiedHow: 'integration', testsRun: 'locale fixture', testResult: 'passed' },
    });
    expect(await stage(candidate.id)).toBe('terminal-other');
    expect(await verifiedCompletions(ws, harness)).toBe(before + 1);

    // The observation stays evidence throughout, pointing at the work it produced.
    const source = await row(obs.id);
    expect(source.payload?.lane).toBe('observation');
    expect(source.payload?.intakeExecution).toMatchObject({ workItemId: workId });
  });
});

describe('ledger encounter → independent promotion → post-cutover claim admission', () => {
  async function ledgerRun(status: 'fail' | 'pass', commitSha = BUILD, dirty = false): Promise<number> {
    const [run] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.test_runs (file_path, framework, status, commit_sha, worktree_dirty)
      VALUES (${`journey/${tag()}.test.ts`}, 'vitest', ${status}, ${commitSha}, ${dirty})
      RETURNING id`;
    return Number(run!.id);
  }

  async function fileEncounter(ref: string) {
    const stamp = await stampFiledBugReproduction({ ref, buildSha: BUILD }, { filedBy: FILER }, defaultReproductionLedgerDeps());
    if (!stamp.ok) throw new Error(stamp.error);
    const source = await createIssue({
      kind: 'bug',
      title: `ledger encounter journey ${tag()}`,
      body: 'the nightly export drops tabbed rows',
      scope: 'harness:papercusp',
      createdBy: FILER,
      payload: { reproduction: stamp.stored },
    });
    await db.adminSql`UPDATE harness_shared.work_items SET created_ts = ${POST_CUTOVER} WHERE feature_id = ${source.id}`;
    return { source, stamp: stamp.stored, stored: await row(source.id) };
  }

  it('admits a clean matching failure only after a current-build independent acceptance', async () => {
    const ref = `test_runs:${await ledgerRun('fail')}`;
    const { source, stamp, stored } = await fileEncounter(ref);
    expect(stamp.verification.status).toBe('verified');
    expect(await stage(source.id)).toBe('candidate');
    expect(await selfSelectable(source.id, stored.workspace_id, stored.harness_slug)).toBe(false);
    expect(await claims(source.id, WORKER, stored.workspace_id)).toBe(false);

    const input = { disposition: 'promote', reason: 'canonical ledger encounter', acceptance: ACCEPTANCE, reproduction: null } as const;
    const selfReview = await decide(source.id, input, FILER);
    expect(await exec(source.id, selfReview, `ledger-self-${tag()}`)).toMatchObject({
      ok: false, refusal: 'acceptance-invalid-authority',
    });
    const decision = await decide(source.id, input, REVIEWER);
    // A verified filing cannot authorize a fix on a different target build.
    expect(await exec(source.id, decision, `ledger-stale-${tag()}`, OTHER_BUILD)).toMatchObject({
      ok: false, refusal: 'reproduction-unverified',
    });
    expect((await row(source.id)).payload?.intakePromotion).toBeUndefined();
    expect(await selfSelectable(source.id, stored.workspace_id, stored.harness_slug)).toBe(false);
    expect(await claims(source.id, WORKER, stored.workspace_id)).toBe(false);

    expect(await exec(source.id, decision, `ledger-accepted-${tag()}`)).toMatchObject({
      ok: true, mode: 'in-place', workItemId: source.id,
    });
    const accepted = await row(source.id);
    expect(readIntakeReproduction(accepted.payload)).toMatchObject({
      receipt: { kind: 'encounter', ref, buildSha: BUILD }, origin: 'filing', decidedBy: REVIEWER,
    });
    expect(accepted.payload?.intakePromotion).toMatchObject({ decidedBy: REVIEWER });
    expect(await stage(source.id)).toBe('accepted-ready');
    expect(await promotedFrom(source.id)).toEqual([]);
    const selected = await claimability(source.id, stored.workspace_id, stored.harness_slug);
    expect({ status: accepted.status, breakdown: selected.breakdown }).toMatchObject({
      status: 'open', breakdown: { matchedByFilter: 1, claimable: 1, excluded: { cooldown: 0, agentReview: 0 } },
    });
    expect(selected.rows.map((r) => r.id)).toContain(source.id);
    expect(await claims(source.id, WORKER, stored.workspace_id)).toBe(true);
    expect(await stage(source.id)).toBe('accepted-active');
  });

  it.each([
    { name: 'passing run', status: 'pass', commitSha: BUILD, dirty: false, verification: 'refuted' },
    { name: 'failure on another build', status: 'fail', commitSha: OTHER_BUILD, dirty: false, verification: 'refuted' },
    { name: 'failure on a dirty worktree', status: 'fail', commitSha: BUILD, dirty: true, verification: 'refuted' },
    { name: 'missing ledger row', status: null, commitSha: BUILD, dirty: false, verification: 'unresolved' },
  ] as const)('keeps a $name unaccepted and unclaimable through both admission paths', async (control) => {
    const id = control.status === null ? 9007199254740990 : await ledgerRun(control.status, control.commitSha, control.dirty);
    const ref = `test_runs:${id}`;
    const { source, stamp, stored } = await fileEncounter(ref);
    expect(stamp.verification.status).toBe(control.verification);
    const input = { disposition: 'promote', reason: control.name, acceptance: ACCEPTANCE } as const;
    const noReceipt = await decide(source.id, { ...input, reproduction: null }, REVIEWER);
    expect(await exec(source.id, noReceipt, `ledger-no-receipt-${tag()}`)).toMatchObject({
      ok: false, refusal: 'reproduction-missing',
    });
    // Re-citing the same row in a reviewer decision cannot launder the ledger verdict.
    const cited = await decide(source.id, {
      ...input, reproduction: { kind: 'failing-test', ref, buildSha: BUILD },
    }, REVIEWER);
    expect(await exec(source.id, cited, `ledger-cited-${tag()}`)).toMatchObject({
      ok: false, refusal: 'reproduction-unverified',
    });
    const refused = await row(source.id);
    expect(refused.payload?.intakePromotion).toBeUndefined();
    expect(readIntakeReproduction(refused.payload)).toBeNull();
    expect(await promotedFrom(source.id)).toEqual([]);
    expect(await stage(source.id)).toBe('candidate');
    const selected = await claimability(source.id, stored.workspace_id, stored.harness_slug);
    expect(selected.breakdown).toMatchObject({
      matchedByFilter: 1, claimable: 0, excluded: { cooldown: 0, agentReview: 1 },
    });
    expect(selected.rows).toEqual([]);
    expect(await claims(source.id, WORKER, stored.workspace_id)).toBe(false);
    expect((await row(source.id)).taken_by).toBeNull();
  });
});
