// change-kind-declared-proof-2026-10-15 P-002 (R-2, R-6; D-001, D-002, D-003) — the change-kind
// close gate through the REAL close handler and REAL persistence. The unit suites
// (change-kind-proof.test.ts, complete.test.ts) mock the declaration store and the state write;
// this suite does not. Declarations are written with the production writer, read back by the
// production reader inside work_items:complete, and the terminal status is read back from the
// base table — so a refusal that still let the row go terminal, or a declaration recorded by a
// refused close that later passes as an "earlier" one, fails here.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { teardownTestPg } from '@papercusp/test-config/pg';
import * as refactorFacts from '../../change-kind-refactor-facts';
import type { RefactorFactsIo } from '../../change-kind-refactor-facts';

const OWNER = 'su-0d0d0d0d-1111-4222-8333-555555555555';
const WS = 'default';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async (workspace: string, callback: (sql: postgres.Sql) => unknown) =>
    h.sql.begin(async (sql) => {
      await sql`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(sql as unknown as postgres.Sql);
    }),
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workspace-registry')>(),
  activeWorkspaceId: () => 'default',
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...await importOriginal<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: () => ({ ownerId: 'su-0d0d0d0d-1111-4222-8333-555555555555', ownerLabel: 'change-kind integration', source: 'test' }),
  deriveFleetMembership: async () => null,
}));
// Keep this fixture out of the live coordination/independent-auditor lanes. Neither the
// change-kind gate, the declaration store nor the state persistence is mocked.
vi.mock('../../events', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../events')>(),
  fireReactionInProcess: async () => ({ ok: true }),
}));
vi.mock('../../grading-integrity', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../grading-integrity')>(),
  dispatchPendingGradingAudits: async () => ({ requestedTargetIds: [], receipts: [] }),
}));
vi.mock('../../harness/improvements/completion-verification-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../harness/improvements/completion-verification-store')>(),
  spawnCompletionVerificationForClose: async () => ({ outcome: 'no-dependents' }),
  applyCompletionVerdictForClose: async () => null,
  acceptCompletionOnSettlementForSubject: async () => null,
}));

const { createIssue } = await import('../../issues-engineer');
const { getWorkItem } = await import('../../work-items');
const { declareChangeKinds, readChangeKinds } = await import('../../work-item-change-kinds');
const { CHANGE_KIND_GATE_CUTOVER } = await import('../../change-kind-proof');
const { default: complete } = await import('./complete');
let db: OrgTestDb;

beforeAll(async () => {
  // These are evidence-input fixtures, not files changed by this test. Guard the
  // premise before paying for database setup: dirty fixture bytes would activate
  // the unrelated committed-content floor and conceal the mismatch verdict.
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  for (const relative of ['apps/operator/app/dao/page.tsx', 'packages/operator-core/lib/change-kind-catalog.ts']) {
    const working = execFileSync('git', ['hash-object', relative], { cwd: root, encoding: 'utf8' }).trim();
    const committed = execFileSync('git', ['rev-parse', `HEAD:${relative}`], { cwd: root, encoding: 'utf8' }).trim();
    expect(working, `Evidence fixture must match committed HEAD: ${relative}`).toBe(committed);
  }
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

// Pinned to the gate's own constant so moving the cutover moves these fixtures with it.
const AFTER_CUTOVER = new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) + 3_600_000).toISOString();
const BEFORE_CUTOVER = new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) - 86_400_000).toISOString();

const rootCause = {
  contractVersion: 2,
  hypothesis: 'the queue panel reads the stale sort key',
  alternativeHypothesis: 'the queue panel receives rows in the wrong order from the server',
  distinguishingTest: 'Feed the panel a server response whose order is known and compare the rendered order.',
  testResult: 'The rendered order differs from the known server order.',
  testProcedure: 'Render the panel against the fixture response and read the row order.',
  predictedObservations: {
    hypothesis: 'the rendered order differs from the server order',
    alternativeHypothesis: 'the rendered order equals the server order',
  },
  actualObservation: 'the rendered order differs from the server order',
  evidenceRefs: ['test:complete.change-kinds.integration.test.ts'],
};

type CloseResult = Record<string, unknown> & {
  ok?: boolean;
  stateError?: string;
  error?: string;
  changeKindWarning?: string;
  completionAuthority?: string;
  countsTowardBurnDown?: boolean;
  changeKindProof?: { kinds: string[] | null; missing: Array<{ kind: string; proof: string[] }> };
};

/** A claimed issue-family item; `takenAt` is the claim-start the gate compares to the cutover. */
async function claimedIssue(label: string, takenAt: string): Promise<{ id: string; harness: string }> {
  const issue = await createIssue({
    kind: 'bug', scope: 'harness:papercusp', createdBy: OWNER,
    title: `change-kind gate fixture ${label} ${Date.now()} ${Math.random()}`,
    body: 'An isolated change-kind close fixture; the production close handler must enforce per-kind proof.',
  });
  await db.adminSql`UPDATE harness_shared.work_items SET taken_by = ${OWNER}, taken_at = ${takenAt}::timestamptz,
    admission = 'admitted' WHERE feature_id = ${issue.id}`;
  const existing = await getWorkItem(issue.id);
  expect(existing).not.toBeNull();
  expect(existing!.takenAt && Date.parse(existing!.takenAt)).toBe(Date.parse(takenAt));
  if (!existing?.harness) throw new Error('The isolated claimed fixture must have a harness.');
  return { id: issue.id, harness: existing.harness };
}

async function close(item: { id: string; harness: string }, extra: Record<string, unknown>, completion: Record<string, unknown>): Promise<CloseResult> {
  const args = complete.args.parse({
    id: item.id, harness: item.harness, state: 'done', assumptions: 'none', ...extra,
    completion: { verifiedHow: 'unit', rootCauseVerification: rootCause, ...completion },
  });
  const response = await complete.handler(args, { uiClientId: OWNER, isSuperuser: true, workspaceId: WS } as never);
  return (response as { data: { results: CloseResult[] } }).data.results[0]!;
}

async function storedStatus(id: string): Promise<string> {
  const [row] = await db.adminSql<Array<{ status: string }>>`SELECT status FROM harness_shared.work_items WHERE feature_id = ${id}`;
  return row!.status;
}

const VITEST_ONLY = {
  summary: 'restyled the queue panel',
  testsRun: 'testing:run { files: ["apps/operator/components/QueuePanel.test.tsx"] }',
  testResult: '12 passed',
};

describe('work_items:complete — change-kind gate through real persistence (change-kind-declared-proof P-002)', () => {
  it('accepts registered guard detector proof and refuses missing detector proof or dirty parent runs through persistence', async () => {
    const path = 'packages/operator-core/lib/release/orphan.ts';
    const conditionKey = `sync-delta-guard:lint:guard-reachability:${path}`;
    const landing = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    let measurable = true;
    let parentDirty = false;
    const io: RefactorFactsIo = {
      async git(args) {
        if (args[0] === 'rev-parse') return args.at(-1)?.includes('^1') ? parent : landing;
        if (args.includes('-U0')) return 'diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@';
        return args.includes('--no-renames') ? 'src/x.ts\n' : '';
      },
      async readRuns(ids) {
        return ids.map((id) => ({ id, filePath: 'src/x.test.ts', commitSha: id === 1 ? parent : landing,
          status: 'pass', worktreeDirty: id === 1 && parentDirty }));
      },
      async coverage() { return { members: [{ member: 'src/x.ts:1-1', coveringFiles: ['src/x.test.ts'] }], errors: [] }; },
      async readFiled(finding) {
        return refactorFacts.filedGuardFindingFromPayload({ filedBy: 'system:sync-batch-lint-guards', paths: [path],
          _conditionUpsert: { conditionKey } }, finding);
      },
      async readSource() { return null; },
      async guardReachabilityCensus() {
        return { modules: { measurable, population: 1, inventory: [{ module: 'packages/a/lib/release/kept.ts', dead: false }] } };
      },
    };
    // Replace native I/O only: real adapter, facts resolver, close gate and persistence all run.
    const native = vi.spyOn(refactorFacts, 'nativeRefactorFactsResolver').mockImplementation(() => refactorFacts.createRefactorFactsResolver(io));
    try {
      const completion = {
        summary: 'removed the unused detector module', testsRun: 'npm run test:file -- src/x.test.ts', testResult: '1 passed',
        kindEvidence: [{ kind: 'refactor', landingCommit: landing, beforeRuns: [1], afterRuns: [101], finding: conditionKey,
          typecheck: 'status=clean', behaviouralStrands: 'exit 0, no strands' }],
      };
      const item = await claimedIssue('guard-detector-proof', AFTER_CUTOVER);
      await declareChangeKinds({ workspaceId: WS, featureId: item.id, kinds: ['refactor'], step: 'claim', declaredBy: OWNER });

      measurable = false;
      const unknown = await close(item, {}, completion);
      expect(unknown.ok, JSON.stringify(unknown)).toBe(false);
      expect(unknown.error).toContain('unmeasured or incomplete');
      expect(await storedStatus(item.id)).not.toBe('done');

      measurable = true;
      parentDirty = true;
      const dirty = await close(item, {}, completion);
      expect(dirty.ok, JSON.stringify(dirty)).toBe(false);
      expect(dirty.error).toContain('dirty tree');
      expect(await storedStatus(item.id)).not.toBe('done');

      parentDirty = false;
      const accepted = await close(item, {}, completion);
      expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
      expect(accepted.stateError).toBeUndefined();
      expect(await storedStatus(item.id)).toBe('done');
      expect(native).toHaveBeenCalled();
    } finally {
      native.mockRestore();
    }
  }, 90_000);

  it('refuses a ui-declared close that carries only a Vitest run: the row stays open and the reply names the missing proof (R-2, D-002)', async () => {
    const item = await claimedIssue('ui-refused', AFTER_CUTOVER);
    const declared = await declareChangeKinds({ workspaceId: WS, featureId: item.id, kinds: ['ui'], step: 'claim', declaredBy: OWNER });
    expect(declared).toMatchObject({ recorded: true, current: ['ui'] });
    const before = await storedStatus(item.id);

    const result = await close(item, {}, VITEST_ONLY);

    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.stateError).toMatch(new RegExp(`^REJECTED — ${item.id} declares change kind\\(s\\) ui`));
    expect(result.error).toContain('a recorded run of the real app');
    expect(result.changeKindProof?.missing.map((m) => m.kind)).toEqual(['ui']);
    // The terminal transition was refused in the base table, not just in the reply.
    expect(await storedStatus(item.id)).toBe(before);
    expect(before).not.toBe('done');
  }, 60_000);

  it('lands a logic-declared close that carries a passing test run as done (R-6)', async () => {
    const item = await claimedIssue('logic-pass', AFTER_CUTOVER);
    await declareChangeKinds({ workspaceId: WS, featureId: item.id, kinds: ['logic'], step: 'claim', declaredBy: OWNER });

    const result = await close(item, {}, {
      summary: 'fixed the stale sort key',
      testsRun: 'testing:run { files: ["packages/operator-core/lib/queue-sort.test.ts"] }',
      testResult: '9 passed, 0 failed',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.stateError).toBeUndefined();
    expect(result.changeKindProof).toBeUndefined();
    expect(await storedStatus(item.id)).toBe('done');
  }, 60_000);

  it('a first declaration at close is refused until a reason is recorded, including on retry (D-001)', async () => {
    // D-001: a declaration that first arrives at close REQUIRES changeKindReason, so a reasonless one
    // is refused. (R-4's "lands as proposed" is the ui-mismatch path, owned by P-004 — not this gate.)
    const item = await claimedIssue('close-time-reason', AFTER_CUTOVER);
    const noCode = { summary: 'confirmed the report was a duplicate; nothing changed', testsRun: 'none — no code changed', testResult: 'n/a' };

    const first = await close(item, { changeKinds: ['no-code-change'] }, noCode);
    expect(first.ok, JSON.stringify(first)).toBe(false);
    expect(first.stateError).toMatch(new RegExp(`^REJECTED — ${item.id} declares change kind\\(s\\) no-code-change`));
    expect(first.error).toContain('`changeKindReason`');
    expect(await storedStatus(item.id)).not.toBe('done');

    // The refused close still recorded its declaration at step 'complete' …
    const views = await readChangeKinds(WS, [item.id]);
    expect(views.get(item.id)?.history.map((d) => d.step)).toContain('complete');

    // … which must not satisfy D-001 on a reasonless retry.
    const retry = await close(item, { changeKinds: ['no-code-change'] }, noCode);
    expect(retry.ok, JSON.stringify(retry)).toBe(false);
    expect(retry.error).toContain('`changeKindReason`');
    expect(await storedStatus(item.id)).not.toBe('done');

    const reasoned = await close(item, {
      changeKinds: ['no-code-change'],
      changeKindReason: 'the declaration arrives at close because the item was a duplicate report with no change',
    }, noCode);
    expect(reasoned.ok, JSON.stringify(reasoned)).toBe(true);
    expect(reasoned.countsTowardBurnDown, JSON.stringify(reasoned)).toBe(true);
    expect(await storedStatus(item.id)).toBe('done');
  }, 90_000);

  it('a claim taken before the cutover with no declaration closes with a warning, not a refusal (D-003)', async () => {
    const item = await claimedIssue('pre-cutover', BEFORE_CUTOVER);

    const result = await close(item, {}, {
      summary: 'fixed the stale sort key',
      testsRun: 'testing:run { files: ["packages/operator-core/lib/queue-sort.test.ts"] }',
      testResult: '9 passed, 0 failed',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.changeKindWarning).toContain(CHANGE_KIND_GATE_CUTOVER);
    expect(await storedStatus(item.id)).toBe('done');
  }, 60_000);

  it('a claim taken after the cutover with no declaration at all is refused (D-001, D-003)', async () => {
    const item = await claimedIssue('post-cutover-undeclared', AFTER_CUTOVER);

    const result = await close(item, {}, VITEST_ONLY);

    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.stateError).toMatch(new RegExp(`^REJECTED — ${item.id} has no change-kind declaration`));
    expect(await storedStatus(item.id)).not.toBe('done');
  }, 60_000);
});
