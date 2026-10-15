/** Real coord:send → ReportBlock capture → immutable Reports storage (P-012). */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: fixture.sql }),
  withWorkspace: async <T>(workspaceId: string, callback: (sql: postgres.Sql) => Promise<T>): Promise<T> =>
    fixture.sql.begin(async (transaction) => {
      await transaction`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return callback(transaction as unknown as postgres.Sql);
    }) as Promise<T>,
}));
// Sender-wide decorative enrichment is outside this producer contract. Keep
// message persistence, ReportBlock normalization and publication fully real.
vi.mock('./agent-tools/coordination/based-on', async (original) => ({
  ...await original<typeof import('./agent-tools/coordination/based-on')>(),
  deriveBasedOn: async () => [],
}));
vi.mock('./agent-tools/coordination/derive-awaiting', async (original) => ({
  ...await original<typeof import('./agent-tools/coordination/derive-awaiting')>(),
  deriveAwaiting: async () => [],
}));
vi.mock('./agent-tools/coordination/derive-draft-suspension', async (original) => ({
  ...await original<typeof import('./agent-tools/coordination/derive-draft-suspension')>(),
  deriveDraftSuspension: async () => null,
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { activeWorkspaceId } = await import('./workspace-registry');
const { drainDetached } = await import('./detached-imports');
const { getReport } = await import('./report-library');
const { captureCoordReport } = await import('./report-capture');
const { resetCoordLog } = await import('./agent-tools/coordination/log');
const { default: send } = await import('./agent-tools/coordination/tools/send');

const OWNER = 'su-reports-coord-producer-fixture';
const PLAN = 'reports-coord-producer-fixture-plan';
const reportBlock = {
  title: 'Coordination producer readback',
  plans: [{ slug: PLAN, title: 'Measured plan', status: 'wip', summary: 'Exact measured summary.',
    items: [{ id: 'P-012', text: 'Stored report verified', status: 'done', ref: 'wi:WI-fixture' }] }],
};
// Validate the public fixture before creating a database. Adapter-internal
// ReportBlock fields do not necessarily belong to coord:send's public schema.
const cardArgs = Object.fromEntries((['human', 'agents'] as const).map((audience) => [audience,
  send.args.parse({ to: audience === 'human' ? ['human'] : ['*'], expects: 'none', wake: false,
    scope: 'local', summary: 'Reports producer fixture', body: [{ text: 'Measured status card.' }],
    report: reportBlock }),
]));

describe('Reports coordination producer against migrated private PostgreSQL', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    fixture.sql = db.adminSql;
    resetCoordLog();
  }, 180_000);
  afterAll(async () => {
    await drainDetached();
    resetCoordLog();
    await db?.cleanup();
  });
  beforeEach(async () => {
    await drainDetached();
    await db.adminSql`TRUNCATE harness_shared.coord_event_log`;
    await db.adminSql`TRUNCATE harness_shared.report_library CASCADE`;
  });

  async function sendCard(audience: 'human' | 'agents', key: string) {
    const args = cardArgs[audience];
    const context = { uiClientId: OWNER, isSuperuser: true, workspaceId: activeWorkspaceId(),
      harnessSlug: 'papercusp', runId: 'reports-coord-producer-fixture-session', idempotencyKey: key,
      log: () => {} };
    const response = await send.handler(args as never, context as never);
    expect(response, JSON.stringify(response)).toMatchObject({ data: { results: [{ ok: true }] } });
    await drainDetached();
    return response;
  }

  it('publishes the delivered ReportBlock and retains exact origin, body and retry identity', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      await sendCard('human', 'reports-producer-retry');
      const messages = await db.adminSql<Array<{ msg_id: string; body: { to: string[]; report: unknown } }>>`
        SELECT msg_id, body FROM harness_shared.coord_event_log
         WHERE surface = 'messages' AND writer_key = ${OWNER}`;
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toMatchObject({ to: ['human'], report: reportBlock });
      const messageId = messages[0].msg_id;
      const requestKey = `capture:coord:${createHash('sha256').update(messageId).digest('hex')}`;
      const reports = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`;
      expect(reports).toHaveLength(1);
      const report = await getReport(db.adminSql, activeWorkspaceId(), reports[0].report_id, { isOwner: true });
      expect(report).toMatchObject({ title: reportBlock.title, kind: 'status-digest', visibility: 'owner',
        source: 'capture:coord', requestKey, subject: { kind: 'plan', ref: PLAN, label: 'Measured plan' },
        // Explicit local scope has no pot origin; identity remains server-stamped.
        origin: { authorOwnerId: OWNER, harnessSlug: null, authorSessionRef: OWNER } });
      expect(report!.bodyMd).toBe(`## Measured plan (wip)\nExact measured summary.\n- P-012: Stored report verified (done) — wi:WI-fixture\n\n\nSource reference: ${messageId}\n`);

      // Re-enter the adapter itself after the real producer has settled. An
      // outer send replay can return early without exercising capture again.
      const capturedId = await captureCoordReport({ workspaceId: activeWorkspaceId(), ownerId: OWNER,
        harnessSlug: null, sessionRef: OWNER, msgId: messageId, summary: 'Reports producer fixture',
        report: messages[0].body.report as typeof reportBlock });
      expect(capturedId).toBe(report!.reportId);
      expect(await getReport(db.adminSql, activeWorkspaceId(), capturedId!, { isOwner: true })).toEqual(report);
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`)
        .toEqual(reports);

      await sendCard('human', 'reports-producer-retry');
      const retried = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`;
      expect(retried).toEqual(reports);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not publish a ReportBlock addressed only to agents', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      await sendCard('agents', 'reports-producer-agent-only');
      const messages = await db.adminSql`SELECT msg_id FROM harness_shared.coord_event_log
        WHERE surface = 'messages' AND writer_key = ${OWNER}`;
      expect(messages).toHaveLength(1);
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library`).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
