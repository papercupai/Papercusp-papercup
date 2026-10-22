/** R-1/R-5: declarations cross the real tool handlers and the public get projection. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { teardownTestPg } from '@papercusp/test-config/pg';

const OWNER = 'su-0d0d0d0d-1111-4222-8333-555555555555';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async (workspace: string, callback: (sql: postgres.Sql) => unknown) =>
    h.sql.begin(async (sql) => {
      await sql`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(sql as unknown as postgres.Sql);
    }),
}));
vi.mock('../../workspace-registry', async (original) => ({
  ...await original<typeof import('../../workspace-registry')>(),
  activeWorkspaceId: () => 'default',
}));
vi.mock('../coordination/identity', async (original) => ({
  ...await original<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: () => ({
    ownerId: 'su-0d0d0d0d-1111-4222-8333-555555555555',
    ownerLabel: 'change-kind handler integration', source: 'test',
  }),
  deriveFleetMembership: async () => null,
}));
// Isolate unrelated live coordination and review effects. The tools, declaration
// writer/reader, checkpoint/state persistence, and get projection remain real.
vi.mock('../../events', async (original) => ({
  ...await original<typeof import('../../events')>(),
  fireReactionInProcess: async () => ({ ok: true }),
}));
vi.mock('../../memory/recall-stats', async (original) => ({
  ...await original<typeof import('../../memory/recall-stats')>(),
  recordRecallStats: async () => {},
}));
vi.mock('../../memory/claim-port', () => ({
  buildClaimRecallBlock: async () => null,
}));
vi.mock('../../grading-integrity', async (original) => ({
  ...await original<typeof import('../../grading-integrity')>(),
  dispatchPendingGradingAudits: async () => ({ requestedTargetIds: [], receipts: [] }),
}));
vi.mock('../../harness/improvements/completion-verification-store', async (original) => ({
  ...await original<typeof import('../../harness/improvements/completion-verification-store')>(),
  spawnCompletionVerificationForClose: async () => ({ outcome: 'no-dependents' }),
  applyCompletionVerdictForClose: async () => null,
  acceptCompletionOnSettlementForSubject: async () => null,
}));

const { default: create } = await import('./create');
const { default: claim } = await import('./claim');
const { default: checkpoint } = await import('./checkpoint');
const { default: complete } = await import('./complete');
const { default: get } = await import('./get');
const CTX = { uiClientId: OWNER, isSuperuser: true, workspaceId: 'default', payloadTierOverride: 'full' };
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

type Tool = { args: { parse: (args: unknown) => unknown }; handler: (args: never, ctx: never) => Promise<unknown> };
type Declaration = { kinds: string[]; step: string; declaredBy: string; declaredAt: string; reason: string | null };
type Row = { ok: boolean; id: string; changeKinds?: { current: string[] | null; history: Declaration[]; readFailed?: true }; workItem?: { state: string } };

async function call(tool: Tool, args: Record<string, unknown>): Promise<Row> {
  const response = await tool.handler(tool.args.parse(args) as never, CTX as never) as { data: { results: Row[] } };
  const row = response.data.results[0]!;
  expect(row, JSON.stringify(response.data)).toMatchObject({ ok: true });
  return row;
}

async function read(id: string, current: string[], steps: string[]): Promise<Declaration[]> {
  const row = await call(get, { id, harness: 'papercusp', threadLimit: 0 });
  expect(row.changeKinds?.readFailed).toBeUndefined();
  expect(row.changeKinds?.current).toEqual(current);
  const history = row.changeKinds!.history;
  expect(history.map((entry) => entry.step)).toEqual(steps);
  for (const entry of history) {
    expect(entry.declaredBy).toBe(OWNER);
    expect(Number.isNaN(Date.parse(entry.declaredAt))).toBe(false);
  }
  expect(history.map((entry) => Date.parse(entry.declaredAt))).toEqual(
    history.map((entry) => Date.parse(entry.declaredAt)).sort((a, b) => a - b),
  );
  return history;
}

describe('change-kind declarations through real handlers and work_items:get', () => {
  it('returns current kinds and ordered declaration metadata after create, claim, checkpoint and complete', async () => {
    const created = await call(create, {
      kind: 'change', harness: 'papercusp',
      title: `handler declaration fixture ${Date.now()}`,
      body: 'Isolated declaration/get contract fixture; no product files change.',
      assign_to: 'self', state: 'wip', force: true, changeKinds: ['logic'],
    });
    const id = created.id;
    expect(id).toMatch(/^WI-/);
    expect(await read(id, ['logic'], ['create'])).toMatchObject([{ kinds: ['logic'], reason: null }]);

    await call(claim, { id, harness: 'papercusp', changeKinds: ['logic', 'docs'] });
    await read(id, ['logic', 'docs'], ['create', 'claim']);

    await call(checkpoint, {
      id, harness: 'papercusp', checkpoint: 'Verified the isolated declaration fixture; next close it.',
      changeKinds: ['docs'], changeKindReason: 'The logic portion was inspection only.',
    });
    const checkpointHistory = await read(id, ['docs'], ['create', 'claim', 'checkpoint']);
    expect(checkpointHistory[2]).toMatchObject({ kinds: ['docs'], reason: 'The logic portion was inspection only.' });

    await call(complete, {
      id, harness: 'papercusp', state: 'done', assumptions: 'none',
      changeKinds: ['no-code-change'], changeKindReason: 'The contract fixture changed no product files.',
      completion: {
        summary: 'Verified declaration storage and public readback; no product files changed.',
        verifiedHow: 'tests', testsRun: 'none — declaration contract fixture', testResult: 'n/a', filesChanged: [],
        kindEvidence: [{ kind: 'no-code-change' }],
      },
    });
    const history = await read(id, ['no-code-change'], ['create', 'claim', 'checkpoint', 'complete']);
    expect(history[3]).toMatchObject({ kinds: ['no-code-change'], reason: 'The contract fixture changed no product files.' });
    expect(history.slice(0, 3)).toEqual(checkpointHistory);
    expect((await call(get, { id, harness: 'papercusp', threadLimit: 0 })).workItem?.state).toBe('done');
  }, 180_000);
});
