/**
 * observation-candidate-acceptance-promotion-2026-09-30 P-006 (D-013/D-014) —
 * executing a recorded intake decision against a fully migrated Postgres.
 *
 * The acceptance bar (WI-10004569): concurrent accepts, retries, stale source
 * edits and partial failures never produce duplicate work or a false ready
 * receipt. Every case drives the REAL default dependencies (createIssue,
 * mergeIssuePayload, linkIssue, setIssueState, the advisory-lock transaction);
 * partial failures are injected by overriding exactly one dependency.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, currentBuild: 'abc1234def5678' as string | null }));
vi.mock('./intake-promotion', async (orig) => {
  const actual = await orig<typeof import('./intake-promotion')>();
  const currentTargetBuild = async () => h.currentBuild;
  return {
    ...actual,
    currentIntakeTargetBuild: currentTargetBuild,
    // Keep execution on the same controlled target as promotion after the
    // server wrapper began composing its own lexical default dependencies.
    verifyAcceptedWorkItemBugReproduction: (item: Parameters<typeof actual.verifyAcceptedWorkItemBugReproduction>[0]) =>
      actual.verifyAcceptedWorkItemBugReproduction(item, {
        currentTargetBuild,
        ledger: actual.defaultReproductionLedgerDeps(),
      }),
  };
});
beforeEach(() => { h.currentBuild = 'abc1234def5678'; });
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { claimIssue, createIssue, getIssue, issuesOutLinksMany } = await import('../issues-engineer');
const {
  assertIntakeLockPool,
  currentIntakeSourceRevision,
  defaultIntakePromotionDeps: productionIntakePromotionDeps,
  executeIntakeDecision,
  intakePromotionKey,
  isPromotionKeyConflict,
  readIntakeDispositionState,
  readIntakeInvestigation,
  readIntakePromotionReceipt,
  readIntakeReproduction,
  defaultReproductionLedgerDeps,
} = await import('./intake-promotion');
const { parseIntakeDecision } = await import('./bulk-dispositions');
const { stampFiledBugReproduction, verifyCurrentBugReproductionReceipt } = await import('./bug-reproduction');
const { createImplementationReadiness, evaluateImplementationAcceptance, readImplementationReadiness, readVerificationTask } =
  await import('../harness/improvements/agent-review-policy');
const { recordIssueOccurrence } = await import('../issue-occurrence-ledger');

type Decision = import('./bulk-dispositions').BulkIntakeDecision;
type DecisionInput = import('./bulk-dispositions').BulkIntakeDecisionInput;
type Deps = import('./intake-promotion').IntakePromotionDeps;

// Real PG locks, writers and ledger reads, with a controlled target checkout build.
const defaultIntakePromotionDeps = () => productionIntakePromotionDeps({ currentTargetBuild: async () => 'abc1234def5678' });

let db: OrgTestDb;

beforeAll(async () => {
  // Sized like the pool getOrgPg() itself gets in a vitest worker (VITEST_ORG_POOL_MAX),
  // per the rig's D-024 note: the double-accept cases run a lock holder, its writer and
  // a waiter at once, so the default 2-connection admin pool, not the executor, would
  // decide whether they can make progress.
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const FILER = 'su-filer';
const REVIEWER = 'su-reviewer';
const FULL_ACCEPTANCE = {
  problem: 'the gate reports green while a leg never ran',
  evidence: ['run 4512 output shows zero files collected'],
  outcome: 'a zero-collection leg is reported as unmeasured',
  scope: 'green-checkpoint leg aggregation only',
  completionCheck: 'a leg with zero collected files yields status=unmeasured in the gate verdict',
};

function tag(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function file(opts: {
  kind?: 'bug' | 'change' | 'task';
  observation?: boolean;
  createdBy?: string;
  outcome?: string;
  payload?: Record<string, unknown>;
}) {
  const t = tag();
  const payload: Record<string, unknown> = { ...opts.payload };
  if (opts.observation) payload.lane = 'observation';
  if (opts.outcome) {
    payload.implementationReadiness = createImplementationReadiness({
      status: 'unknown',
      source: 'creation-enrollment',
      reason: 'no-acceptance-evidence-at-creation',
      updatedAt: new Date().toISOString(),
      evidence: { acceptance: { outcome: opts.outcome } },
    });
  }
  return createIssue({
    kind: opts.kind ?? 'bug',
    title: `intake source ${t}`,
    body: `observed behaviour ${t}`,
    scope: 'harness:papercusp',
    createdBy: opts.createdBy ?? FILER,
    payload,
  });
}

/** A review-time reproduction receipt (P-013 / D-023). */
const REPRO = { kind: 'failing-test', ref: 'npm run test:file -- gate-legs.test.ts', buildSha: 'abc1234def' } as const;

/**
 * Record a decision exactly as the report path does: bound to the revision judged now.
 * A promote carries {@link REPRO} unless the case passes `reproduction` itself (null =
 * none), so cases about other properties are not refused by the D-023 bug gate.
 */
async function decide(sourceId: string, input: DecisionInput, decidedBy = REVIEWER): Promise<Decision> {
  const sourceRevision = await currentIntakeSourceRevision(sourceId);
  const withReceipt =
    input.disposition === 'promote' && !('reproduction' in input) ? { ...input, reproduction: REPRO } : input;
  const parsed = parseIntakeDecision(withReceipt, { decidedBy, sourceRevision });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.decision;
}

function exec(sourceId: string, decision: Decision, deps?: Deps, runId = 'run-p006') {
  return executeIntakeDecision({ sourceId, decision, runId, itemId: `att-${sourceId}` }, {
    ...(deps ?? defaultIntakePromotionDeps()),
    verifyReproduction: deps?.verifyReproduction ?? ((receipt) =>
      verifyCurrentBugReproductionReceipt(receipt, 'abc1234def5678', defaultReproductionLedgerDeps())),
  });
}

async function promotedFrom(sourceId: string): Promise<string[]> {
  const rows = await db.adminSql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE payload -> 'intakeSource' ->> 'id' = ${sourceId}
       AND feature_id <> ${sourceId}`;
  return rows.map((r) => r.feature_id);
}

describe('remote member report promotion (unified pipeline D-051)', () => {
  it('authors one local executable target, preserving the foreign source and reporter context on retry', async () => {
    const source = await file({ payload: {
      reporter: { kind: 'end-user' }, reporterKinds: ['end-user'],
      reportContext: { appVersion: '0.9.4', screen: { route: '/board' } },
    } });
    // Fixture represents the row the existing member projection writes upstream.
    await db.adminSql`UPDATE harness_shared.work_items SET origin = 'remote', author_pubkey = 'foreign-installed-member'
      WHERE feature_id = ${source.id}`;
    const before = await payloadOf(source.id);
    const decision = await decide(source.id, { disposition: 'promote', reason: 'reproduced upstream', acceptance: FULL_ACCEPTANCE });
    const first = await exec(source.id, decision);
    expect(first).toMatchObject({ ok: true, mode: 'distinct', created: true });
    if (!first.ok || !first.workItemId) throw new Error(JSON.stringify(first));
    expect(first.workItemId).not.toBe(source.id);
    const target = await getIssue(first.workItemId);
    expect(target?.origin).toBe('local');
    expect(target?.payload).toMatchObject({ intakeSource: { id: source.id, mode: 'distinct' },
      reporter: { kind: 'end-user' }, reporterKinds: ['end-user'], reportContext: { appVersion: '0.9.4' } });
    expect(await payloadOf(source.id)).toEqual(before);
    expect((await getIssue(source.id))?.origin).toBe('remote');
    const retry = await exec(source.id, decision);
    expect(retry).toMatchObject({ ok: true, workItemId: first.workItemId, created: false, converged: true });
    expect(await promotedFrom(source.id)).toEqual([first.workItemId]);
    expect(await payloadOf(source.id)).toEqual(before);
    h.currentBuild = null;
    expect(await claimIssue(first.workItemId, 'su-upstream-fixer')).toBeNull();
    h.currentBuild = 'b'.repeat(40);
    expect(await claimIssue(first.workItemId, 'su-upstream-fixer')).toBeNull();
    h.currentBuild = 'abc1234def5678';
    expect(await claimIssue(first.workItemId, 'su-upstream-fixer')).toMatchObject({ assignee: 'su-upstream-fixer' });
  });
});

async function outLinks(id: string): Promise<string[]> {
  const links = (await issuesOutLinksMany([id])).get(id) ?? [];
  return links.map((l) => `${l.rel}:${l.dst.ref}`);
}

async function payloadOf(id: string): Promise<Record<string, unknown>> {
  const issue = await getIssue(id);
  return (issue?.payload ?? {}) as Record<string, unknown>;
}

async function isReadyAndQualifying(id: string): Promise<boolean> {
  const issue = await getIssue(id);
  if (!issue) return false;
  const readiness = readImplementationReadiness(issue.payload);
  const verdict = evaluateImplementationAcceptance(issue.payload, {
    kind: issue.kind,
    title: issue.title,
    summary: issue.body ?? '',
  });
  return readiness?.status === 'ready' && verdict.state === 'qualifying';
}

describe('promote / investigate', () => {
  it('a double accept of an observation yields exactly one distinct ready item, and a retry converges on it', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, {
      disposition: 'promote',
      reason: 'reproduced twice',
      workKind: 'fix',
      acceptance: FULL_ACCEPTANCE,
    });

    const [a, b] = await Promise.all([exec(obs.id, decision), exec(obs.id, decision)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.workItemId).toBe(b.workItemId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect([a.converged, b.converged].sort()).toEqual([false, true]);
    expect(a.mode).toBe('distinct');

    const promotedId = a.workItemId!;
    expect(await promotedFrom(obs.id)).toEqual([promotedId]);
    const promoted = await getIssue(promotedId);
    expect(promoted?.kind).toBe('bug');
    expect(await isReadyAndQualifying(promotedId)).toBe(true);
    const [admission] = await h.sql<{ admission: string; admitted_by: string }[]>`
      SELECT admission, admitted_by FROM harness_shared.work_items WHERE feature_id = ${promotedId}`;
    expect(admission).toEqual({ admission: 'auto', admitted_by: 'bypass:intake-decision' });
    expect(readIntakePromotionReceipt(promoted?.payload)).toMatchObject({
      key: intakePromotionKey(obs.id, decision.sourceRevision!),
      mode: 'distinct',
      decidedBy: REVIEWER,
    });

    // The observation is evidence: retained, still an observation, pointing at its work.
    const source = await getIssue(obs.id);
    expect(source?.state).toBe(obs.state);
    expect((source?.payload as Record<string, unknown>).lane).toBe('observation');
    expect((source?.payload as Record<string, unknown>).intakeExecution).toMatchObject({ workItemId: promotedId });
    expect(await outLinks(promotedId)).toContain(`promoted-from:${obs.id}`);
    expect(await outLinks(obs.id)).toContain(`promoted-to:${promotedId}`);

    const retry = await exec(obs.id, decision);
    expect(retry).toMatchObject({ ok: true, workItemId: promotedId, created: false, converged: true });
    expect(await promotedFrom(obs.id)).toEqual([promotedId]);
  });

  it('promotes a same-kind candidate in place: it keeps its id, becomes sealed and ready, and re-execution converges', async () => {
    const cand = await file({ kind: 'bug' });
    expect(readImplementationReadiness(cand.payload)?.status).toBe('unknown');
    const decision = await decide(cand.id, { disposition: 'promote', reason: 'real', acceptance: FULL_ACCEPTANCE });

    const first = await exec(cand.id, decision);
    expect(first).toMatchObject({ ok: true, workItemId: cand.id, created: false, converged: false, mode: 'in-place' });
    expect(await isReadyAndQualifying(cand.id)).toBe(true);
    expect(await promotedFrom(cand.id)).toEqual([]);

    const again = await exec(cand.id, decision);
    expect(again).toMatchObject({ ok: true, workItemId: cand.id, converged: true, mode: 'in-place' });
  });

  it('investigate turns a bug candidate into a distinct ready task and leaves the candidate in place', async () => {
    const cand = await file({ kind: 'bug' });
    const decision = await decide(cand.id, {
      disposition: 'investigate',
      reason: 'cause unknown',
      acceptance: FULL_ACCEPTANCE,
    });
    const result = await exec(cand.id, decision);
    expect(result).toMatchObject({ ok: true, outcome: 'promoted', created: true, mode: 'distinct' });
    if (!result.ok) return;
    expect((await getIssue(result.workItemId!))?.kind).toBe('task');
    expect(await isReadyAndQualifying(result.workItemId!)).toBe(true);
    expect((await getIssue(cand.id))?.state).toBe(cand.state);
  });
});

// P-008 / D-020 §4 (R-26): an investigation is accountable work, so it carries the
// unresolved question, the evidence to collect, the exit check and its owner — and
// an investigation nobody owns never becomes claimable work.
describe('investigations record question, evidence, exit check and owner (R-26)', () => {
  const RECORDED = {
    schemaVersion: 'intake-execution-v1',
    question: FULL_ACCEPTANCE.problem,
    evidenceToCollect: FULL_ACCEPTANCE.evidence,
    exitCheck: FULL_ACCEPTANCE.completionCheck,
    owner: 'agent',
    decidedBy: REVIEWER,
  };

  it('refuses an unowned investigation and writes nothing', async () => {
    const cand = await file({ kind: 'bug' });
    const before = await payloadOf(cand.id);
    const decision = await decide(cand.id, {
      disposition: 'investigate',
      reason: 'cause unknown',
      owner: 'unknown',
      acceptance: FULL_ACCEPTANCE,
    });
    expect(decision.owner).toBe('unknown');
    const result = await exec(cand.id, decision);
    expect(result).toMatchObject({ ok: false, refusal: 'investigation-unowned' });
    expect(await promotedFrom(cand.id)).toEqual([]);
    expect(await payloadOf(cand.id)).toEqual(before);
  });

  it('a distinct investigation task carries the investigation record from the sealed contract', async () => {
    const cand = await file({ kind: 'bug' });
    const decision = await decide(cand.id, {
      disposition: 'investigate',
      reason: 'cause unknown',
      owner: 'agent',
      acceptance: FULL_ACCEPTANCE,
    });
    const result = await exec(cand.id, decision);
    expect(result).toMatchObject({ ok: true, mode: 'distinct', created: true });
    if (!result.ok) return;
    const task = await getIssue(result.workItemId!);
    expect(task?.kind).toBe('task');
    expect(readIntakeInvestigation(task?.payload)).toEqual(RECORDED);
    expect(readIntakeInvestigation(await payloadOf(cand.id))).toBeNull();
  });

  it('an in-place investigation (a task candidate) records it on the candidate itself', async () => {
    const cand = await file({ kind: 'task' });
    const decision = await decide(cand.id, {
      disposition: 'investigate',
      reason: 'needs a scoped probe',
      owner: 'agent',
      acceptance: FULL_ACCEPTANCE,
    });
    expect(await exec(cand.id, decision)).toMatchObject({ ok: true, mode: 'in-place', workItemId: cand.id });
    expect(readIntakeInvestigation(await payloadOf(cand.id))).toEqual(RECORDED);
    expect(await isReadyAndQualifying(cand.id)).toBe(true);
  });

  it('a promote records no investigation', async () => {
    const cand = await file({ kind: 'bug' });
    const decision = await decide(cand.id, { disposition: 'promote', reason: 'real', acceptance: FULL_ACCEPTANCE });
    expect(await exec(cand.id, decision)).toMatchObject({ ok: true, mode: 'in-place' });
    expect(readIntakeInvestigation(await payloadOf(cand.id))).toBeNull();
  });
});

describe('the promotion key is fenced by the database, not only by the lock', () => {
  // Migration 1298's partial unique index is what makes "exactly one promoted item"
  // hold even for a writer that never reaches the advisory lock (a different client,
  // an overlapping run, a retry racing a slow first attempt).
  it('two executors that bypass the advisory lock still yield exactly one promoted item', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, {
      disposition: 'promote',
      reason: 'fence probe',
      workKind: 'fix',
      acceptance: FULL_ACCEPTANCE,
    });
    const unlocked: Deps = { ...defaultIntakePromotionDeps(), withLocks: (_ids, fn) => fn() };

    const [a, b] = await Promise.all([exec(obs.id, decision, unlocked), exec(obs.id, decision, unlocked)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.workItemId).toBe(b.workItemId);
    expect(await promotedFrom(obs.id)).toEqual([a.workItemId]);
    expect(await isReadyAndQualifying(a.workItemId!)).toBe(true);
  });

  it('control: with every application-level lookup blinded, only the unique index stops a second promoted row', async () => {
    // Deterministic, unlike the race above: the second execution cannot see the first
    // one's row through any dependency, so it reaches createItem and only the database
    // can refuse it. Without migration 1298 this test creates a duplicate and fails.
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, { disposition: 'promote', reason: 'fence control', acceptance: FULL_ACCEPTANCE });
    const blind: Deps = {
      ...defaultIntakePromotionDeps(),
      withLocks: (_ids, fn) => fn(),
      findByPromotionKey: async () => null,
      findPromotedFromSource: async () => [],
    };
    const first = await exec(obs.id, decision, blind);
    expect(first).toMatchObject({ ok: true, created: true });
    const second = await exec(obs.id, decision, blind).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isPromotionKeyConflict(second)).toBe(true);
    expect(await promotedFrom(obs.id)).toHaveLength(1);
  });

  it('a second row carrying the same promotion key is refused as a promotion-key conflict', async () => {
    const t = tag();
    const payload = { intakePromotion: { key: `intake-exec:fence-${t}:rev` } };
    const base = { kind: 'task' as const, body: 'fence', scope: 'harness:papercusp', createdBy: FILER, payload };
    await createIssue({ ...base, title: `fence first ${t}` });
    const err = await createIssue({ ...base, title: `fence second ${t}` }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(isPromotionKeyConflict(err)).toBe(true);
    expect(isPromotionKeyConflict(new Error('unrelated failure'))).toBe(false);
  });

  it('refuses a one-connection pool instead of letting the lock holder wait forever for its own writers', () => {
    expect(() => assertIntakeLockPool({ options: { max: 1 } })).toThrow(/at least 2 connections/);
    expect(() => assertIntakeLockPool({ options: { max: 2 } })).not.toThrow();
    expect(() => assertIntakeLockPool(db.adminSql)).not.toThrow();
  });
});

describe('refusals write nothing', () => {
  it('a source edited after the decision is refused, and no ready receipt appears anywhere', async () => {
    for (const observation of [false, true]) {
      const src = await file({ observation });
      const decision = await decide(src.id, { disposition: 'promote', reason: 'r', acceptance: FULL_ACCEPTANCE });
      await db.adminSql`
        UPDATE harness_shared.work_items SET summary = summary || ' (edited after review)'
         WHERE feature_id = ${src.id}`;
      const result = await exec(src.id, decision);
      expect(result).toMatchObject({ ok: false, refusal: 'source-revision-changed' });
      const payload = await payloadOf(src.id);
      expect(payload.intakePromotion).toBeUndefined();
      expect(readImplementationReadiness(payload)?.status ?? null).not.toBe('ready');
      expect(await promotedFrom(src.id)).toEqual([]);
    }
  });

  it('refuses an unjudged revision, self-review and an incomplete contract without writing', async () => {
    const cand = await file({ kind: 'bug' });
    const unjudged = parseIntakeDecision(
      { disposition: 'promote', reason: 'r', acceptance: FULL_ACCEPTANCE },
      { decidedBy: REVIEWER },
    );
    if (!unjudged.ok) throw new Error(unjudged.error);
    expect(await exec(cand.id, unjudged.decision)).toMatchObject({ ok: false, refusal: 'source-revision-unjudged' });

    const selfReview = await decide(cand.id, { disposition: 'promote', reason: 'r', acceptance: FULL_ACCEPTANCE }, FILER);
    expect(await exec(cand.id, selfReview)).toMatchObject({ ok: false, refusal: 'acceptance-invalid-authority' });

    const incomplete = await decide(cand.id, { disposition: 'promote', reason: 'r', acceptance: { problem: 'p' } });
    const refused = await exec(cand.id, incomplete);
    expect(refused).toMatchObject({ ok: false, refusal: 'acceptance-incomplete' });
    expect(refused.ok ? [] : refused.missing).toEqual(
      expect.arrayContaining(['evidence', 'outcome', 'scope', 'completionCheck']),
    );

    const retry = await decide(cand.id, { disposition: 'retry', reason: 'unclear', missingInformation: 'a repro' });
    expect(await exec(cand.id, retry)).toMatchObject({ ok: false, refusal: 'retry-not-executable' });

    const payload = await payloadOf(cand.id);
    expect(payload.intakePromotion).toBeUndefined();
    expect(readImplementationReadiness(payload)?.status).toBe('unknown');
  });
});

// P-013 (D-023 / D-024): a bug is accepted only with a reproduction on the current build.
describe('bug reproduction receipt', () => {
  const BUILD = 'abc1234def5678';

  it('refuses stale and unresolved target builds on the real promotion transition, including a converged retry', async () => {
    const cand = await file({ kind: 'bug' });
    const decision = await decide(cand.id, { disposition: 'promote', reason: 'reproduced', acceptance: FULL_ACCEPTANCE });
    const withBuild = (build: string | null): Deps => ({
      ...defaultIntakePromotionDeps(),
      verifyReproduction: (receipt) => verifyCurrentBugReproductionReceipt(receipt, build, defaultReproductionLedgerDeps()),
    });
    for (const build of [null, 'b'.repeat(40)]) {
      expect(await exec(cand.id, decision, withBuild(build))).toMatchObject({ ok: false, refusal: 'reproduction-unverified' });
      expect((await payloadOf(cand.id)).intakePromotion).toBeUndefined();
      expect(evaluateImplementationAcceptance(await payloadOf(cand.id), {
        kind: cand.kind, title: cand.title, summary: cand.body,
      }).state).not.toBe('qualifying');
    }
    expect(await exec(cand.id, decision, withBuild(BUILD))).toMatchObject({ ok: true, outcome: 'promoted' });
    expect(await exec(cand.id, decision, withBuild('b'.repeat(40)))).toMatchObject({ ok: false, refusal: 'reproduction-unverified' });
  });

  it('does not accept a caller-supplied receipt citing a passing or missing test run', async () => {
    const cand = await file({ kind: 'bug' });
    const passed = await testRun('pass');
    for (const id of [passed, 9007199254740990]) {
      const decision = await decide(cand.id, {
        disposition: 'promote', reason: 'claimed failure', acceptance: FULL_ACCEPTANCE,
        reproduction: { kind: 'failing-test', ref: `test_runs:${id}`, buildSha: BUILD },
      });
      expect(await exec(cand.id, decision)).toMatchObject({ ok: false, refusal: 'reproduction-unverified' });
      expect((await payloadOf(cand.id)).intakePromotion).toBeUndefined();
    }
  });

  async function stampedPayload(ref: string, buildSha = BUILD) {
    const stamp = await stampFiledBugReproduction({ ref, buildSha }, { filedBy: FILER }, defaultReproductionLedgerDeps());
    if (!stamp.ok) throw new Error(stamp.error);
    return { reproduction: stamp.stored };
  }

  async function testRun(status: 'fail' | 'pass', commitSha = BUILD): Promise<number> {
    const [row] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.test_runs (file_path, framework, status, commit_sha, worktree_dirty)
      VALUES (${`p013/${tag()}.test.ts`}, 'vitest', ${status}, ${commitSha}, false)
      RETURNING id`;
    return Number(row!.id);
  }

  it('refuses a bug promote without a receipt and writes nothing', async () => {
    const cand = await file({ kind: 'bug' });
    const decision = await decide(cand.id, {
      disposition: 'promote',
      reason: 'looks real',
      acceptance: FULL_ACCEPTANCE,
      reproduction: null,
    });
    const refused = await exec(cand.id, decision);
    expect(refused).toMatchObject({ ok: false, refusal: 'reproduction-missing' });
    expect(refused.ok ? '' : refused.detail).toContain('investigate');
    const payload = await payloadOf(cand.id);
    expect(payload.intakePromotion).toBeUndefined();
    expect(readIntakeReproduction(payload)).toBeNull();
    expect(readImplementationReadiness(payload)?.status).toBe('unknown');

    // An observation promoted as a fix is a bug promote too.
    const obs = await file({ observation: true });
    const obsDecision = await decide(obs.id, {
      disposition: 'promote',
      reason: 'r',
      workKind: 'fix',
      acceptance: FULL_ACCEPTANCE,
      reproduction: null,
    });
    expect(await exec(obs.id, obsDecision)).toMatchObject({ ok: false, refusal: 'reproduction-missing' });
    expect(await promotedFrom(obs.id)).toEqual([]);
  });

  it('records the review receipt on the promoted bug (origin review)', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, { disposition: 'promote', reason: 'r', workKind: 'fix', acceptance: FULL_ACCEPTANCE });
    const result = await exec(obs.id, decision);
    expect(result).toMatchObject({ ok: true, created: true, mode: 'distinct' });
    if (!result.ok) return;
    expect(readIntakeReproduction(await payloadOf(result.workItemId!))).toMatchObject({
      receipt: { kind: 'failing-test', buildSha: 'abc1234def' },
      origin: 'review',
      decidedBy: REVIEWER,
    });
  });

  it('a bug filed with a verified encounter (a failing test_runs row) promotes with no review receipt (D-024)', async () => {
    const runId = await testRun('fail');
    const cand = await file({ kind: 'bug', payload: await stampedPayload(`test_runs:${runId}`) });
    expect((cand.payload as Record<string, { verification: { status: string } }>).reproduction.verification.status).toBe(
      'verified',
    );
    const decision = await decide(cand.id, {
      disposition: 'promote',
      reason: 'encountered',
      acceptance: FULL_ACCEPTANCE,
      reproduction: null,
    });
    expect(await exec(cand.id, decision)).toMatchObject({ ok: true, mode: 'in-place', workItemId: cand.id });
    expect(readIntakeReproduction(await payloadOf(cand.id))).toMatchObject({
      receipt: { kind: 'encounter', ref: `test_runs:${runId}` },
      origin: 'filing',
    });
  });

  it('an encounter the ledger refutes (a passing run, or another build) is not born verified and still needs review', async () => {
    for (const stamped of [
      await stampedPayload(`test_runs:${await testRun('pass')}`),
      await stampedPayload(`test_runs:${await testRun('fail', 'fedcba9876543')}`),
    ]) {
      expect(stamped.reproduction.verification.status).toBe('refuted');
      const cand = await file({ kind: 'bug', payload: stamped });
      const decision = await decide(cand.id, {
        disposition: 'promote',
        reason: 'r',
        acceptance: FULL_ACCEPTANCE,
        reproduction: null,
      });
      expect(await exec(cand.id, decision)).toMatchObject({ ok: false, refusal: 'reproduction-missing' });
    }
  });

  it('leaves a change promote and an investigation of a bug ungated (D-023 §6)', async () => {
    const change = await file({ kind: 'change' });
    const changeDecision = await decide(change.id, {
      disposition: 'promote',
      reason: 'r',
      acceptance: FULL_ACCEPTANCE,
      reproduction: null,
    });
    expect(await exec(change.id, changeDecision)).toMatchObject({ ok: true, mode: 'in-place' });
    expect(readIntakeReproduction(await payloadOf(change.id))).toBeNull();

    const bug = await file({ kind: 'bug' });
    const investigate = await decide(bug.id, { disposition: 'investigate', reason: 'cannot reproduce yet', acceptance: FULL_ACCEPTANCE });
    expect(await exec(bug.id, investigate)).toMatchObject({ ok: true, created: true });
  });
});

// P-007 (D-021 / D-023): `investigate` spawns a verification task. Its claim writer refuses
// the subject's reporters and implementers, and the decision itself needs a reviewer who is
// independent of the whole party set, not only of the filer the seal already checks.
describe('verification task parties (P-007)', () => {
  const REPRODUCER = 'su-reproducer';
  const BUILDER = 'su-builder';
  const VERIFIER = 'su-verifier';
  const INVESTIGATE = { disposition: 'investigate', reason: 'cause unknown', acceptance: FULL_ACCEPTANCE } as const;

  /** A bug whose reproduction receipt was filed by someone other than the bug's filer. */
  async function bugWithReproducer() {
    const stamp = await stampFiledBugReproduction(
      { ref: 'npm run test:file -- trailing-token.test.ts', buildSha: 'abc1234def5678' },
      { filedBy: REPRODUCER },
      defaultReproductionLedgerDeps(),
    );
    if (!stamp.ok) throw new Error(stamp.error);
    return file({ kind: 'bug', payload: { reproduction: stamp.stored } });
  }

  it('investigate stamps the task with the subject parties, and its claim writer refuses them', async () => {
    const cand = await bugWithReproducer();
    const result = await exec(cand.id, await decide(cand.id, INVESTIGATE));
    expect(result).toMatchObject({ ok: true, created: true, mode: 'distinct' });
    if (!result.ok) return;
    const taskId = result.workItemId!;

    const task = readVerificationTask(await payloadOf(taskId));
    expect(task).toMatchObject({ subject: cand.id, check: 'reproduction', implementers: [] });
    expect([...(task?.reporters ?? [])].sort()).toEqual([FILER, REPRODUCER].sort());
    // The reviewer who ordered the check is independent of the subject, so it is no party.
    expect(task?.reporters).not.toContain(REVIEWER);

    for (const party of [FILER, REPRODUCER]) {
      expect([party, await claimIssue(taskId, party)]).toEqual([party, null]);
    }
    expect((await getIssue(taskId))?.assignee ?? null).toBeNull();
    // Control: the same writer serves an independent verifier, so the refusals above are
    // the party rule and not some other floor.
    expect(await claimIssue(taskId, VERIFIER)).toMatchObject({ id: taskId, assignee: VERIFIER });
  });

  it('refuses a decision recorded by a reporter or an implementer of the source, and writes nothing', async () => {
    const cand = await bugWithReproducer();
    await db.adminSql`UPDATE harness_shared.work_items SET terminal_owner = ${BUILDER} WHERE feature_id = ${cand.id}`;
    for (const [decidedBy, role] of [[REPRODUCER, 'reporter'], [BUILDER, 'implementer']] as const) {
      const refused = await exec(cand.id, await decide(cand.id, INVESTIGATE, decidedBy));
      expect([decidedBy, refused]).toMatchObject([decidedBy, { ok: false, refusal: 'acceptance-invalid-authority' }]);
      expect(refused.ok ? '' : refused.detail).toContain(`is a ${role} of ${cand.id}`);
    }
    expect(await promotedFrom(cand.id)).toEqual([]);
    // Control: an independent reviewer's decision on the same source goes through.
    expect(await exec(cand.id, await decide(cand.id, INVESTIGATE))).toMatchObject({ ok: true, created: true });
  });

  it('refuses an occurrence-only reporter and carries that party into the investigation claim guard', async () => {
    const cand = await bugWithReproducer();
    const reporter = 'su-occurrence-only';
    await db.adminSql`
      INSERT INTO harness_shared.work_item_occurrences
        (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter, source_tool, report_kind, reported_title)
      SELECT workspace_id, harness_slug, feature_id, ${reporter}, 'improvements:capture', 'coalesced', title
        FROM harness_shared.work_items WHERE feature_id = ${cand.id}`;
    const before = await payloadOf(cand.id);
    expect(await exec(cand.id, await decide(cand.id, INVESTIGATE, reporter))).toMatchObject({ ok: false, refusal: 'acceptance-invalid-authority' });
    expect(await payloadOf(cand.id)).toEqual(before);
    const accepted = await exec(cand.id, await decide(cand.id, INVESTIGATE));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok || !accepted.workItemId) throw new Error(JSON.stringify(accepted));
    expect(readVerificationTask(await payloadOf(accepted.workItemId))?.reporters).toContain(reporter);
    expect(await claimIssue(accepted.workItemId, reporter)).toBeNull();
    expect(await claimIssue(accepted.workItemId, VERIFIER)).toMatchObject({ assignee: VERIFIER });
  });
});

describe('partial failures', () => {
  it('a failed insert leaves nothing; a failed link after the insert converges on retry without a duplicate', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, { disposition: 'promote', reason: 'r', acceptance: FULL_ACCEPTANCE });
    const real = defaultIntakePromotionDeps();

    await expect(
      exec(obs.id, decision, {
        ...real,
        createItem: async () => {
          throw new Error('injected insert failure');
        },
      }),
    ).rejects.toThrow('injected insert failure');
    expect(await promotedFrom(obs.id)).toEqual([]);
    expect((await payloadOf(obs.id)).intakeExecution).toBeUndefined();

    await expect(
      exec(obs.id, decision, {
        ...real,
        link: async () => {
          throw new Error('injected link failure');
        },
      }),
    ).rejects.toThrow('injected link failure');
    // The insert committed WITH its own receipt and contract (one write), so the
    // ready verdict it carries is true; only the graph edges and pointer are owed.
    const [orphan] = await promotedFrom(obs.id);
    expect(orphan).toBeDefined();
    expect(await isReadyAndQualifying(orphan)).toBe(true);
    expect((await payloadOf(obs.id)).intakeExecution).toBeUndefined();

    const recovered = await exec(obs.id, decision);
    expect(recovered).toMatchObject({ ok: true, workItemId: orphan, created: false, converged: true });
    expect(await promotedFrom(obs.id)).toEqual([orphan]);
    expect((await payloadOf(obs.id)).intakeExecution).toMatchObject({ workItemId: orphan });
    expect(await outLinks(orphan)).toContain(`promoted-from:${obs.id}`);
    expect(await outLinks(obs.id)).toContain(`promoted-to:${orphan}`);
  });
});

describe('merge', () => {
  it('appends evidence with bidirectional links; a duplicate candidate closes, a distinct remedy and an observation stay', async () => {
    const target = await file({ kind: 'bug', outcome: 'retry the flaky leg' });
    const duplicate = await file({ kind: 'bug', outcome: 'Retry  the flaky leg' });
    const distinct = await file({ kind: 'bug', outcome: 'quarantine the leg instead' });
    const obs = await file({ observation: true });

    const results = [];
    for (const src of [duplicate, distinct, obs]) {
      const decision = await decide(src.id, { disposition: 'merge', reason: 'same cause', targetRef: target.id });
      results.push(await exec(src.id, decision));
      // Re-execution converges and appends nothing twice.
      expect(await exec(src.id, decision)).toMatchObject({ ok: true, converged: true, workItemId: target.id });
      expect(await outLinks(src.id)).toContain(`merged-into:${target.id}`);
      expect(await outLinks(target.id)).toContain(`merged-from:${src.id}`);
    }
    expect(results.map((r) => r.ok && r.distinctRemedy)).toEqual([false, true, false]);

    expect((await getIssue(duplicate.id))?.state).toBe('dropped');
    expect((await getIssue(distinct.id))?.state).toBe(distinct.state);
    expect((await getIssue(obs.id))?.state).toBe(obs.state);

    const merged = (await payloadOf(target.id)).intakeMergedSources as { sourceId: string }[];
    expect(merged.map((m) => m.sourceId)).toEqual([duplicate.id, distinct.id, obs.id]);

    const elsewhere = await file({ kind: 'bug' });
    const again = await decide(distinct.id, { disposition: 'merge', reason: 'moved', targetRef: elsewhere.id });
    expect(await exec(distinct.id, again)).toMatchObject({ ok: false, refusal: 'already-merged-elsewhere' });
  });
});

describe('retain / reject', () => {
  it('records an occurrence watermark, deletes and terminalizes nothing, and a later occurrence reopens the same decision', async () => {
    const cand = await file({ kind: 'bug' });
    const occurrence = (title: string) =>
      recordIssueOccurrence(
        { canonicalId: cand.id, sourceTool: 'system', reportKind: 'duplicate', reportedTitle: title },
        db.adminSql as never,
      );
    const first = await occurrence('first report');
    expect(first).not.toBeNull();

    const decision = await decide(cand.id, { disposition: 'reject', reason: 'not reproducible on current build' });
    const result = await exec(cand.id, decision);
    expect(result).toMatchObject({ ok: true, outcome: 'rejected', workItemId: null, converged: false });

    const after = await getIssue(cand.id);
    expect(after?.state).toBe(cand.state);
    expect(readImplementationReadiness(after?.payload)?.status).toBe('not-ready');
    expect(readIntakeDispositionState(after?.payload, first!.occurrenceId)).toMatchObject({
      disposition: 'reject',
      occurrenceWatermark: first!.occurrenceId,
      reopened: false,
    });
    expect(await exec(cand.id, decision)).toMatchObject({ ok: true, converged: true });

    const later = await occurrence('it happened again');
    expect(readIntakeDispositionState(after?.payload, later!.occurrenceId)).toMatchObject({
      disposition: 'reject',
      reopened: true,
    });
    const deps = defaultIntakePromotionDeps();
    expect(await deps.latestOccurrenceId(cand.id)).toBe(later!.occurrenceId);
  });

  it('retains an observation without touching its readiness', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, { disposition: 'retain', reason: 'useful context for the gate audit' });
    expect(await exec(obs.id, decision)).toMatchObject({ ok: true, outcome: 'retained' });
    const payload = await payloadOf(obs.id);
    expect(payload.lane).toBe('observation');
    expect(payload.implementationReadiness).toBeUndefined();
    expect(readIntakeDispositionState(payload, null)).toMatchObject({ disposition: 'retain', reopened: false });
  });
});
