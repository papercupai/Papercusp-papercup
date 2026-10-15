/** Actual work_items:complete → audit capture → immutable Reports store (P-012). */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
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
// A fixture completion must not release this host's real edit locks.
vi.mock('./work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: async () => ({ releases: [], failures: 0, skipped: null }),
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { activeWorkspaceId } = await import('./workspace-registry');
const { createWorkItem, getWorkItem } = await import('./work-items');
const { drainDetached } = await import('./detached-imports');
const { getReport, publishReport } = await import('./report-library');
const { captureAuditCompletion } = await import('./report-capture');
const { modeById, axisKeyFor } = await import('./modes/registry');
const { default: complete } = await import('./agent-tools/work_items/complete');
const { PROJECTED_DEPS } = await import('./projected-tool-deps');
await import('./agent-tools/reports/publish');
await import('./agent-tools/mode/set');
await import('./agent-tools/tools/invoke');
await import('./agent-tools/work_items/set_state');
const publicTools = new Map(['work_items:complete', 'work_items:set_state', 'tools:invoke',
  'reports:publish', 'mode:set'].map(name => {
  const tool = lookupByMcpName(name);
  if (!tool) throw new Error(`Public audit fixture requires registered tool ${name}`);
  return [name, tool] as const;
}));

const OWNER = 'su-reports-audit-producer-fixture';
const SESSION = 'reports-audit-producer-fixture-session';
const HARNESS = 'papercusp';
const auditMode = modeById('audit');
if (!auditMode) throw new Error('Audit mode fixture requires the registered audit definition');
const auditAxis = axisKeyFor(auditMode);
const note = {
  summary: 'The private audit fixture preserves its exact verdict.',
  testsRun: 'Private PostgreSQL audit fixture readback',
  testResult: 'Fixture observation recorded',
  verifiedHow: 'integration' as const,
  filesChanged: [],
};
// Reject fixture schema errors before allocating a database.
const terminalTemplate = complete.args.parse({ id: 'WI-123', harness: HARNESS, state: 'done',
  assumptions: 'none', completion: note });
const progressTemplate = complete.args.parse({ id: 'WI-123', harness: HARNESS, recordOnly: true,
  completion: note });

describe('Reports audit producer against migrated private PostgreSQL', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    fixture.sql = db.adminSql;
  }, 180_000);
  afterAll(async () => {
    await drainDetached();
    await db?.cleanup();
  });
  beforeEach(async () => {
    await drainDetached();
    await db.adminSql`TRUNCATE harness_shared.report_library CASCADE`;
    await db.adminSql`DELETE FROM harness_shared.agent_modes WHERE owner_id = ${OWNER}`;
  });

  async function seed(audit: boolean) {
    if (audit) await db.adminSql`
      INSERT INTO harness_shared.agent_modes
        (workspace_id, owner_id, axis_key, mode, reason, set_by)
      VALUES (${activeWorkspaceId()}, ${OWNER}, ${auditAxis}, 'audit', 'Private test fixture', ${OWNER})`;
    return createWorkItem({ kind: 'task', title: 'Reports audit producer fixture', harness: HARNESS,
      workspaceId: activeWorkspaceId(), createdBy: OWNER, assignee: OWNER });
  }

  async function finish(id: string, terminal = true) {
    const args = structuredClone(terminal ? terminalTemplate : progressTemplate);
    args.id = id;
    const response = await complete.handler(args as never, {
      uiClientId: OWNER, isSuperuser: true, workspaceId: activeWorkspaceId(), harnessSlug: HARNESS,
      runId: SESSION, log: () => {},
    } as never);
    expect(response, JSON.stringify(response)).toMatchObject({ data: { results: [{ ok: true }] } });
    await drainDetached();
    return args;
  }

  // Exercise the generic public dispatcher with its real production AUDIT
  // admission port. Direct handler calls above cannot observe that boundary.
  async function dispatch(name: string, args: unknown, owner = OWNER) {
    const ctx = { uiClientId: owner, isSuperuser: true, workspaceId: activeWorkspaceId(),
      harnessSlug: HARNESS, runId: SESSION, signal: new AbortController().signal,
      log: () => {}, progress: () => {}, emit: () => {} } as UnifiedToolContext;
    ctx.dispatchTool = async (nestedName, nestedArgs) => {
      const result = await dispatch(nestedName, nestedArgs, owner);
      return result.ok && result.result
        ? { ...result.result, content: result.result.content ?? [] }
        : { isError: true, content: [{ type: 'text', text: result.error?.message ?? 'dispatch failed' }],
          _meta: { dispatchError: result.error } };
    };
    const tool = publicTools.get(name);
    expect(tool, name).toBeDefined();
    return dispatchProjectedTool(tool!, name, args, ctx, {
      checkCapabilityEnvelope: PROJECTED_DEPS.checkCapabilityEnvelope,
    });
  }

  it('captures the delivered audit after standalone mode exit while public subject mutations remain refused', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      const item = await seed(true);
      const args = { ...structuredClone(terminalTemplate), id: item.id };
      expect(await dispatch('work_items:complete', args)).toMatchObject({ ok: false,
        error: { code: 'capability_denied' } });
      const nested = await dispatch('tools:invoke', { name: 'work_items:complete', args });
      expect(nested).toMatchObject({ ok: false });
      expect(nested.error?.message).toContain('read-only toward the audited subject');
      expect(await dispatch('work_items:set_state', { id: item.id, state: 'done' }))
        .toMatchObject({ ok: false, error: { code: 'capability_denied' } });
      expect(await getWorkItem(item.id, HARNESS)).toMatchObject({ state: 'open' });
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library`).toHaveLength(0);

      expect(await dispatch('reports:publish', { title: item.title, kind: 'audit',
        subject: { kind: 'work_item', ref: item.id }, body_md: 'The delivered private audit verdict.',
        request_key: `audit-delivery:${item.id}` })).toMatchObject({ ok: true });
      // The exit is its own successful call, never batched with completion.
      expect(await dispatch('mode:set', { mode: 'audit', enabled: false, reason: 'Audit delivered' }))
        .toMatchObject({ ok: true });
      expect(await db.adminSql`SELECT mode FROM harness_shared.agent_modes
        WHERE workspace_id = ${activeWorkspaceId()} AND owner_id = ${OWNER} AND mode = 'audit'`)
        .toHaveLength(0);
      expect(await dispatch('work_items:complete', args)).toMatchObject({ ok: true });
      await drainDetached();
      const stored = await getWorkItem(item.id, HARNESS);
      expect(stored).toMatchObject({ state: 'done', terminalOwner: OWNER });
      const reference = stored!.terminalCompletionRef ?? item.id;
      const requestKey = `capture:audit:${createHash('sha256').update(reference).digest('hex')}`;
      const rows = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`;
      expect(rows).toHaveLength(1);
      const report = await getReport(db.adminSql, activeWorkspaceId(), rows[0].report_id, { isOwner: true });
      expect(report).toMatchObject({ kind: 'audit', visibility: 'owner', source: 'capture:audit',
        subject: { kind: 'work_item', ref: item.id }, origin: { authorOwnerId: OWNER,
          harnessSlug: HARNESS, authorSessionRef: SESSION } });
      expect(report!.bodyMd).toContain(`Source reference: ${reference}`);
      // Public dispatch reparses the input; its internal default-status marker
      // is removed by completion before publication, not from the caller copy.
      expect(JSON.parse(report!.bodyMd.match(/```json\n([\s\S]*?)\n```/)![1]))
        .toEqual({ ...note, status: 'done' });
      // Preserve the exact normalized producer payload while re-entering the
      // adapter with the persisted item's source identity. Replaying complete
      // alone can be short-circuited by its terminal-state idempotency guard.
      const normalizedCompletion = { ...note, status: 'done' };
      const capturedId = await captureAuditCompletion({ workspaceId: activeWorkspaceId(), ownerId: stored!.terminalOwner!,
        harnessSlug: stored!.harness, sessionRef: SESSION, itemId: stored!.id, completionRef: reference,
        title: stored!.title, completion: normalizedCompletion });
      const retryFailures = capturedId ? [] : await db.adminSql`SELECT title, body
        FROM harness_shared.engineer_issues WHERE title = 'Reports automatic capture failed'`;
      expect(capturedId, JSON.stringify(retryFailures)).toBe(report!.reportId);
      expect(await getReport(db.adminSql, activeWorkspaceId(), capturedId!, { isOwner: true })).toEqual(report);
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`)
        .toEqual(rows);
      expect(await dispatch('work_items:complete', args)).toMatchObject({ ok: true });
      await drainDetached();
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`)
        .toEqual(rows);
    } finally { vi.unstubAllEnvs(); }
  });

  it('publishes an actual terminal audit completion with persisted source and exact verdict', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      const item = await seed(true);
      await publishReport(db.adminSql, { workspaceId: activeWorkspaceId(), title: item.title,
        kind: 'audit', subject: { kind: 'work_item', ref: item.id }, bodyMd: 'Delivered audit' },
      { authorOwnerId: OWNER, harnessSlug: HARNESS, authorSessionRef: SESSION });
      const args = await finish(item.id);
      const stored = await getWorkItem(item.id, HARNESS);
      expect(stored).toMatchObject({ state: 'done', terminalOwner: OWNER });
      // The terminal evidence writer omits empty file lists. The report below
      // separately preserves the full normalized completion payload.
      expect(stored!.terminalCompletionEvidence).toMatchObject({ summary: note.summary,
        testsRun: note.testsRun, testResult: note.testResult, verifiedHow: note.verifiedHow });
      expect(stored!.terminalCompletionEvidence?.filesChanged).toBeUndefined();
      const reference = stored!.terminalCompletionRef ?? item.id;
      const requestKey = `capture:audit:${createHash('sha256').update(reference).digest('hex')}`;
      const rows = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`;
      expect(rows).toHaveLength(1);
      const report = await getReport(db.adminSql, activeWorkspaceId(), rows[0].report_id, { isOwner: true });
      expect(report).toMatchObject({ title: item.title, kind: 'audit', visibility: 'owner',
        source: 'capture:audit', requestKey, subject: { kind: 'work_item', ref: item.id },
        origin: { authorOwnerId: OWNER, harnessSlug: HARNESS, authorSessionRef: SESSION } });
      expect(report!.bodyMd).toContain(note.summary);
      expect(report!.bodyMd).toContain(`Source reference: ${reference}`);
      const verdict = report!.bodyMd.match(/```json\n([\s\S]*?)\n```/);
      expect(verdict).not.toBeNull();
      expect(JSON.parse(verdict![1])).toEqual(args.completion);

      await finish(item.id);
      const retry = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`;
      expect(retry).toEqual(rows);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not publish an ordinary terminal completion outside audit mode', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      const item = await seed(false);
      await finish(item.id);
      expect(await getWorkItem(item.id, HARNESS)).toMatchObject({ state: 'done' });
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library`).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not publish a record-only non-terminal audit progress note', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      const item = await seed(true);
      await finish(item.id, false);
      expect(await getWorkItem(item.id, HARNESS)).toMatchObject({ state: 'open' });
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library`).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['author', 'workspace', 'harness', 'subject', 'kind', 'source'] as const)(
    'does not borrow a delivered report with mismatched %s provenance', async mismatch => {
      vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
      try {
        const item = await seed(false);
        await publishReport(db.adminSql, {
          workspaceId: mismatch === 'workspace' ? 'other-private-audit-workspace' : activeWorkspaceId(),
          title: item.title, kind: mismatch === 'kind' ? 'review' : 'audit',
          subject: { kind: 'work_item', ref: mismatch === 'subject' ? 'WI-unrelated' : item.id },
          bodyMd: 'An unrelated delivered verdict', source: mismatch === 'source' ? 'capture:audit' : 'agent',
        }, { authorOwnerId: mismatch === 'author' ? 'su-other-private-author' : OWNER,
          harnessSlug: mismatch === 'harness' ? 'other-private-harness' : HARNESS, authorSessionRef: SESSION });
        const args = { ...structuredClone(terminalTemplate), id: item.id };
        expect(await dispatch('work_items:complete', args)).toMatchObject({ ok: true });
        await drainDetached();
        expect(await getWorkItem(item.id, HARNESS)).toMatchObject({ state: 'done' });
        const captures = await db.adminSql`SELECT report_id FROM harness_shared.report_library
          WHERE source = 'capture:audit' AND workspace_id = ${activeWorkspaceId()}
            AND subject_ref = ${item.id}`;
        // The synthetic existing capture is a control input, never a new capture.
        expect(captures).toHaveLength(mismatch === 'source' ? 1 : 0);
      } finally { vi.unstubAllEnvs(); }
    });
});
