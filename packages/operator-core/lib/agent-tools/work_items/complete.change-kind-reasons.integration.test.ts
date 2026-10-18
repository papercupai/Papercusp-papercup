// P023 independent acceptance for change-kind-declared-proof P-004 / R-4.
// Preserve the P-002 real-handler/private-Postgres fixture while keeping its
// prospective assertion-red cases out of P-002 implementation evidence.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { teardownTestPg } from '@papercusp/test-config/pg';

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
const { default: list } = await import('./list');
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
  evidenceRefs: ['test:complete.change-kind-reasons.integration.test.ts'],
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

describe('R4 declaration reasons and change-kind mismatch audit', () => {
  const LOGIC_PROOF = {
    summary: 'changed a type-only import in the existing page',
    testsRun: 'npx vitest run change-kind-proof.test.ts',
    testResult: '9 passed, 0 failed',
    verifiedHow: 'manual',
  };
  // Absolute paths are an accepted completion input and leave the unrelated
  // relative-path vintage detector outside this declaration-mismatch fixture.
  const UI_PATH = fileURLToPath(new URL('../../../../../apps/operator/app/dao/page.tsx', import.meta.url));
  const LOGIC_PATH = fileURLToPath(new URL('../../change-kind-catalog.ts', import.meta.url));

  it('a reasonless narrowing lands proposed and never counts toward done through the real handler', async () => {
    const item = await claimedIssue('r4-narrowing', AFTER_CUTOVER);
    await declareChangeKinds({ workspaceId: WS, featureId: item.id, kinds: ['ui', 'logic'], step: 'claim', declaredBy: OWNER });

    const result = await close(item, { changeKinds: ['logic'] }, LOGIC_PROOF);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.completionAuthority).toBe('proposed');
    expect(result.countsTowardBurnDown).toBe(false);
    expect((await getWorkItem(item.id))?.completionAuthority).toBe('proposed');
  }, 90_000);

  it('a reasoned narrowing lands done and retains its declaration reason', async () => {
    const item = await claimedIssue('r4-reasoned-narrowing', AFTER_CUTOVER);
    await declareChangeKinds({ workspaceId: WS, featureId: item.id, kinds: ['ui', 'logic'], step: 'claim', declaredBy: OWNER });
    const reason = 'UI implementation moved to a separate item; this item only changes the import.';
    const accepted = await close(item, { changeKinds: ['logic'], changeKindReason: reason }, LOGIC_PROOF);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(accepted.countsTowardBurnDown, JSON.stringify(accepted)).toBe(true);
    expect(await storedStatus(item.id)).toBe('done');
    const view = (await readChangeKinds(WS, [item.id])).get(item.id);
    expect(view?.current).toEqual(['logic']);
    expect(view?.history.some((entry) => entry.step === 'complete' && entry.reason === reason)).toBe(true);
  }, 90_000);

  it.each(['', '   '])('rejects an explicitly blank reason %j at the existing input boundary', (reason) => {
    expect(complete.args.safeParse({
      id: 'EI-r4-schema', state: 'done', assumptions: 'none', changeKindReason: reason,
      completion: LOGIC_PROOF,
    }).success).toBe(false);
  });

  it('a UI-looking file without ui or a reason lands proposed and never counts toward done', async () => {
    const item = await claimedIssue('r4-reasonless-mismatch', AFTER_CUTOVER);
    await declareChangeKinds({ workspaceId: WS, featureId: item.id, kinds: ['logic'], step: 'claim', declaredBy: OWNER });

    const result = await close(item, {}, { ...LOGIC_PROOF, filesChanged: [UI_PATH] });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.completionAuthority).toBe('proposed');
    expect(result.countsTowardBurnDown).toBe(false);
    expect((await getWorkItem(item.id))?.completionAuthority).toBe('proposed');
  }, 60_000);

  it('a reasoned mismatch lands and the ordinary list audit selects it while excluding a logic-only control', async () => {
    const mismatch = await claimedIssue('r4-reasoned-mismatch', AFTER_CUTOVER);
    const control = await claimedIssue('r4-pure-logic-control', AFTER_CUTOVER);
    for (const item of [mismatch, control]) {
      await declareChangeKinds({ workspaceId: WS, featureId: item.id, kinds: ['logic'], step: 'claim', declaredBy: OWNER });
    }
    const reason = 'The TSX change only adjusts an imported type; it does not change rendered behavior.';
    const accepted = await close(mismatch, { changeKindReason: reason }, { ...LOGIC_PROOF, filesChanged: [UI_PATH] });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(accepted.countsTowardBurnDown, JSON.stringify(accepted)).toBe(true);
    expect(await storedStatus(mismatch.id)).toBe('done');

    const ordinary = await close(control, {}, { ...LOGIC_PROOF, filesChanged: [LOGIC_PATH] });
    expect(ordinary.ok, JSON.stringify(ordinary)).toBe(true);
    expect(ordinary.countsTowardBurnDown, JSON.stringify(ordinary)).toBe(true);

    const parsed = list.args.safeParse({ harness: mismatch.harness, audit: 'change-kind-mismatch', audience: 'any', limit: 100 });
    expect(parsed.success, 'The ordinary list tool must accept the R4 mismatch audit.').toBe(true);
    if (!parsed.success) return;
    const response = await list.handler(parsed.data, { uiClientId: OWNER, isSuperuser: true, workspaceId: WS } as never);
    const rows = (response as { data: Array<{ id: string }> }).data;
    expect(rows.map((row) => row.id)).toContain(mismatch.id);
    expect(rows.map((row) => row.id)).not.toContain(control.id);
  }, 90_000);
});
