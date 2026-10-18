/**
 * SPEC-BQL-P-009-RECEIPT: close through the production handler and read the
 * authority from real Postgres. The unit matrix mocks the state writer and
 * therefore cannot detect a persistence layer that discards the downgrade.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { teardownTestPg } from '@papercusp/test-config/pg';

const OWNER = 'su-0d0d0d0d-1111-4222-8333-444444444444';
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
  resolveAgentIdentity: () => ({ ownerId: 'su-0d0d0d0d-1111-4222-8333-444444444444', ownerLabel: 'receipt integration', source: 'test' }),
  deriveFleetMembership: async () => null,
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/flags/server')>(),
  getFlag: async (key: string) => key === 'papercusp-terminal-criteria-enforcement',
}));
// Keep this fixture out of the live coordination/independent-auditor lanes.
// Neither the criterion nor getWorkItem/state persistence is mocked.
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
const { default: complete } = await import('./complete');
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const rootCause = {
  contractVersion: 2,
  hypothesis: 'the coupon calculation uses the wrong percentage',
  alternativeHypothesis: 'the delivery charge causes the total mismatch',
  distinguishingTest: 'Apply the canonical coupon above the free-delivery threshold and inspect discount and delivery separately.',
  testResult: 'The recorded discount differs while delivery is zero.',
  testProcedure: 'Inspect the fixture response for subtotal 9999 and SAVE10.',
  predictedObservations: {
    hypothesis: 'the discount differs and delivery is zero',
    alternativeHypothesis: 'the discount is correct and delivery is nonzero',
  },
  actualObservation: 'the discount differs and delivery is zero',
  evidenceRefs: ['test:complete-reproduction.integration.test.ts'],
};

describe('BQL receipt authority through the close handler and real persistence', () => {
  it.each([
    ['pending reproduction', 'revision-requested', 'reproduction', 'done', 'proposed'],
    ['pending reproduction', 'revision-requested', 'reproduction', 'resolved', 'proposed'],
    ['pending reproduction', 'revision-requested', 'reproduction', 'dropped', 'committed'],
    ['receipt accepted', 'accepted', undefined, 'done', 'committed'],
    ['receipt accepted', 'accepted', undefined, 'resolved', 'committed'],
    ['receipt accepted', 'accepted', undefined, 'dropped', 'committed'],
    ['not reviewed', undefined, undefined, 'done', 'committed'],
    ['not reviewed', undefined, undefined, 'resolved', 'committed'],
    ['not reviewed', undefined, undefined, 'dropped', 'committed'],
  ] as const)('persists %s closed as %s/%s/%s with %s authority', async (label, reviewStatus, revisionKind, state, authority) => {
    const issue = await createIssue({
      kind: 'bug', scope: 'harness:papercusp', createdBy: OWNER,
      title: `receipt authority fixture ${label} ${state} ${Date.now()} ${Math.random()}`,
      body: 'An isolated close-authority fixture; the production close handler must preserve the reproduction-validation floor.',
    });
    const review = reviewStatus ? { agentReview: { status: reviewStatus, revisionKind, submittedBy: OWNER, ledgerIdeaId: issue.id, round: 2 } } : {};
    await db.adminSql`UPDATE harness_shared.work_items SET payload = ${JSON.stringify(review)}::text::jsonb,
      taken_by = ${OWNER}, admission = 'admitted' WHERE feature_id = ${issue.id}`;
    const existing = await getWorkItem(issue.id);
    expect(existing).not.toBeNull();
    const args = complete.args.parse({
      id: issue.id, harness: existing!.harness, state, assumptions: 'none',
      // change-kind-declared-proof P-002: a successful close of a claim taken after the gate's
      // cutover must declare its change kind; this fixture changes no files.
      changeKinds: ['no-code-change'],
      changeKindReason: 'isolated close-authority fixture; no code is changed',
      completion: {
        summary: state === 'dropped' ? 'The isolated attempt did not reproduce.' : 'The isolated verification was completed.',
        verifiedHow: 'unit', testsRun: 'isolated receipt authority fixture',
        testResult: 'Read back the terminal authority from the base table.',
        rootCauseVerification: rootCause,
      },
    });
    const response = await complete.handler(args, { uiClientId: OWNER, isSuperuser: true, workspaceId: WS } as never);
    const result = (response as { data: { results: Array<Record<string, unknown>> } }).data.results[0];
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, completionAuthority: authority });
    expect(result.stateError).toBeUndefined();
    const [stored] = await db.adminSql`SELECT status, authority FROM harness_shared.work_items WHERE feature_id = ${issue.id}`;
    expect(stored).toEqual({ status: state === 'resolved' ? 'done' : state, authority });
    if (reviewStatus === 'revision-requested' && state !== 'dropped') {
      expect(result.countsTowardBurnDown).toBe(false);
      expect(result.terminalCriteriaWarning).toContain('reproduction-receipt');
    } else {
      expect(result.terminalCriteriaWarning ?? '').not.toContain('reproduction-receipt');
    }
  }, 60_000);
});
