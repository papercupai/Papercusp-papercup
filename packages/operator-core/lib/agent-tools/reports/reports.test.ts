/**
 * reports.test.ts — the `reports:*` verbs (plan reports-library-2026-09-15, P-003).
 *
 * These are the TOOL-LAYER unit tests: validation and the visibility wiring. The
 * store's own behaviour (real lineage, a real 512KB refusal, the actual SQL matrix)
 * is covered against a migration-applied Postgres in
 * `report-library.integration.test.ts` — so the store is mocked here and these
 * tests pin the decisions the TOOL layer makes, not the store's.
 *
 * Two of these are security invariants rather than behaviour checks:
 *
 *   1. ORIGIN IS UNFORGEABLE (R-2). `publishReport`'s 3rd argument must come from
 *      ctx and nothing else. A caller that could set its own author id could forge
 *      the one axis a reader uses to decide how much to trust a report.
 *   2. EVERY READ PATH PASSES A VIEWER (R-7). The store's `visibleTo` gate is
 *      OPT-IN: `getReport`/`listReports`/`searchReports` all fall back to `TRUE`
 *      when `viewer` is undefined. So a verb that simply FORGETS to pass one does
 *      not fail — it silently returns every report in the workspace. That failure
 *      is invisible in a mocked-store test unless asserted directly, and invisible
 *      in an integration test whose fixture happens to use a viewer who can see
 *      everything anyway. Hence an explicit per-verb assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportBodyTooLargeError, ReportRequestConflictError, REPORT_BODY_MAX_BYTES } from '../../report-library';
import { goalOwnerReportFixture } from '../../../test/fixtures/goal-owner-report';
import { serializeGoalOwnerReportSnapshot } from '@papercusp/chat-protocol';
import { FLAGS } from '@papercusp/flags';

// ── Mocks ────────────────────────────────────────────────────────────────────
const {
  publishReportM,
  getReportM,
  listReportsM,
  searchReportsM,
  retireReportM,
  listReportLineageM,
  emitAwaitedEventM,
  notifySyncInvalidateM,
  getFlagM,
  indexReportM,
  operationBindingM,
  operationMatchM,
  getWorkItemM,
  readScorecardEvidenceM,
} = vi.hoisted(() => ({
  publishReportM: vi.fn(),
  getReportM: vi.fn(),
  listReportsM: vi.fn(),
  searchReportsM: vi.fn(),
  retireReportM: vi.fn(),
  listReportLineageM: vi.fn(),
  emitAwaitedEventM: vi.fn(),
  notifySyncInvalidateM: vi.fn(),
  getFlagM: vi.fn(),
  indexReportM: vi.fn(),
  operationBindingM: vi.fn(),
  operationMatchM: vi.fn(),
  getWorkItemM: vi.fn(),
  readScorecardEvidenceM: vi.fn(),
}));

// Partial mock: the real enums + the real error CLASS are kept, because the tool
// layer DERIVES its zod schemas from those constants and maps that error by
// instanceof — stubbing them would make the tests pass against a fiction.
vi.mock('../../report-library', async (importActual) => {
  const actual = await importActual<typeof import('../../report-library')>();
  return {
    ...actual,
    publishReport: publishReportM,
    getReport: getReportM,
    listReports: listReportsM,
    searchReports: searchReportsM,
    retireReport: retireReportM,
    listReportLineage: listReportLineageM,
  };
});
// PARTIAL: other modules in this import graph pull further exports (e.g. `generated`)
// off db-org, so replacing the whole module breaks collection rather than the test.
vi.mock('@papercusp/db-org', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: emitAwaitedEventM }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: notifySyncInvalidateM }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-fallback' }));
vi.mock('../../detached-imports', () => ({ trackDetached: (p: unknown) => p }));
vi.mock('../../search/report-index', () => ({ indexReport: indexReportM }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: getFlagM }));
vi.mock('../../blueprint/operation-worker-binding', () => ({
  readActiveOperationWorkerClaimBinding: operationBindingM,
  matchOperationWorkerClaim: operationMatchM,
}));
vi.mock('../../work-items', () => ({ getWorkItem: getWorkItemM }));
vi.mock('../../scorecards', () => ({ readScorecardEvidence: readScorecardEvidenceM }));

const publishTool = (await import('./publish')).default;
const getTool = (await import('./get')).default;
const listTool = (await import('./list')).default;
const searchTool = (await import('./search')).default;
const retireTool = (await import('./retire')).default;
const { toReportFull, toReportSummary, zReportWire } = await import('./_shared');
const { reportRecordFixture, reportFullFixture, reportSummaryFixture } =
  await import('../../../../../apps/operator-vite/src/components/reports/reports-test-fixture');

describe('Reports component fixture calibration', () => {
  it('calibrates the exact mocked reader row against the canonical full wire producer', () => {
    expect(reportFullFixture).toEqual(toReportFull(reportRecordFixture));
    expect(zReportWire.parse(reportFullFixture)).toEqual(reportSummaryFixture);
  });
  it('calibrates mocked list and lineage rows against the canonical summary producer', () => {
    expect(reportSummaryFixture).toEqual(toReportSummary(reportRecordFixture));
    expect(reportSummaryFixture).not.toHaveProperty('body_md');
  });
});

describe('Reports delivery guidance', () => {
  it('requires readback and content verification before citation for new reports and corrections', () => {
    expect(publishTool.description).toContain('reports:get { id: report_id }');
    expect(publishTool.description).toContain('verify the complete body and visibility');
    expect(publishTool.guidance?.chaining).toContain('reports:publish → reports:get { id: report_id } → verify');
    expect(publishTool.guidance?.chaining).toContain('Claim saved or delivered only after readback succeeds');
    expect(publishTool.guidance?.chaining).toContain('new report_id → verify the correction → cite it');
    expect(publishTool.description).toContain('descriptive Markdown link to the GUI report page');
    expect(publishTool.description).toContain('returned same-origin path directly as its Markdown target');
    expect(publishTool.description).toContain('absolute HTTP(S) URL only when a verified GUI origin is available');
    expect(publishTool.description).toContain('never guess or ask the owner for an origin solely to format the link');
    // Each rule is stated ONCE across description + chaining (the tool is at its prompt-weight
    // cap), so pin the combined delivery text: a rule dropped from both still fails here.
    const delivery = `${publishTool.description}\n${publishTool.guidance?.chaining ?? ''}`;
    expect(delivery).toContain('returned same-origin path directly');
    expect(publishTool.guidance?.chaining).toContain('/reports?sel=<report_id>');
    expect(publishTool.guidance?.chaining).toContain('never cite a bare id');
    expect(delivery).toContain('never guess or ask the owner for an origin solely to format the link');
  });
});

type Out = { data?: any; content?: Array<{ text: string }> };
const body = (o: Out) => (o.data ?? JSON.parse(o.content![0].text));

const CTX = {
  workspaceId: 'ws1',
  harnessSlug: 'papercusp',
  ownerId: 'su-author',
  runId: 'run-abc',
  log: vi.fn(),
};

const record = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws1',
  reportId: 'rpt_1',
  title: 'Audit',
  summary: '',
  bodyMd: 'body',
  kind: 'audit',
  subject: { kind: 'none', ref: null, label: null },
  origin: { harnessSlug: 'papercusp', authorOwnerId: 'su-author', authorSessionRef: 'run-abc' },
  visibility: 'owner',
  supersedesReportId: null,
  lineageId: 'rpt_1',
  source: 'agent',
  tags: [],
  publishedAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  retiredAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getFlagM.mockResolvedValue(true);
  indexReportM.mockResolvedValue({ chunks: 1, embedded: 1 });
  publishReportM.mockResolvedValue(record());
  getReportM.mockResolvedValue(record());
  listReportsM.mockResolvedValue([record()]);
  searchReportsM.mockResolvedValue([{ report: record(), rank: 0.42 }]);
  retireReportM.mockResolvedValue(record({ retiredAt: '2026-09-15T01:00:00.000Z' }));
  listReportLineageM.mockResolvedValue([record()]);
  emitAwaitedEventM.mockResolvedValue(undefined);
  operationBindingM.mockResolvedValue({ status: 'none' });
  operationMatchM.mockReturnValue({ allowed: true });
  readScorecardEvidenceM.mockResolvedValue({ kind: 'not_found' });
});

// ── R-2: origin is stamped, never accepted ───────────────────────────────────
describe('reportsLibrary kill-switch (P-004)', () => {
  it.each([
    ['publish', publishTool, { title: 'A' }],
    ['get', getTool, { id: 'rpt_1' }],
    ['list', listTool, {}],
    ['search', searchTool, { query: 'A' }],
    ['retire', retireTool, { id: 'rpt_1' }],
  ] as const)('refuses %s before any store read/write or notification when disabled', async (_, tool, args) => {
    getFlagM.mockResolvedValue(false);
    const result = body(await tool.handler(args as never, CTX as never) as Out);
    expect(result).toMatchObject({ ok: false, error: 'flag_disabled', flag: FLAGS.REPORTS_LIBRARY });
    expect(getFlagM).toHaveBeenCalledWith(FLAGS.REPORTS_LIBRARY, 'system');
    for (const store of [publishReportM, getReportM, listReportsM, searchReportsM, retireReportM, listReportLineageM]) {
      expect(store).not.toHaveBeenCalled();
    }
    expect(emitAwaitedEventM).not.toHaveBeenCalled();
    expect(notifySyncInvalidateM).not.toHaveBeenCalled();
  });
});

describe('reports:publish — origin is server-stamped (R-2)', () => {
  it('SPEC-P-003-origin-ctx-stamped: origin comes from ctx, as publishReport\'s separate 3rd argument', async () => {
    await publishTool.handler({ title: 'A' } as never, CTX as never);
    const [, input, origin] = publishReportM.mock.calls[0];
    expect(origin).toEqual({
      harnessSlug: 'papercusp',
      authorOwnerId: 'su-author',
      authorSessionRef: 'run-abc',
    });
    // The payload the caller controls carries no author axis at all.
    expect(input).not.toHaveProperty('origin');
    expect(input).not.toHaveProperty('authorOwnerId');
  });

  it('the args schema REFUSES caller-supplied provenance rather than silently dropping it', () => {
    const schema = publishTool.args as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ title: 'A' }).success).toBe(true);
    for (const forged of ['origin', 'author_owner_id', 'authorOwnerId', 'origin_harness_slug', 'requestScope', 'request_scope']) {
      expect(schema.safeParse({ title: 'A', [forged]: 'su-someone-else' }).success).toBe(false);
    }
  });

  it('a caller cannot reach origin even by naming the store\'s own field spelling', async () => {
    await publishTool.handler(
      { title: 'A', authorOwnerId: 'su-forged', harnessSlug: 'other-pot' } as never,
      CTX as never,
    );
    const [, , origin] = publishReportM.mock.calls[0];
    expect(origin.authorOwnerId).toBe('su-author');
    expect(origin.harnessSlug).toBe('papercusp');
  });
});

// ── R-1: validation + the body cap ───────────────────────────────────────────
describe('reports:publish — validation (R-1)', () => {
  it('binds native retry scope to the applied operation while retaining the actual author', async () => {
    const binding = { harnessSlug: 'app', storageHarnessSlug: 'pot-home', workItemId: 'WI-native',
      operationId: 'daily-report', specificationRevision: 'rev-1', pin: { requestKey: 'accepted-run' } };
    operationBindingM.mockResolvedValue({ status: 'bound', binding });
    getWorkItemM.mockResolvedValue({ id: 'WI-native', harness: 'pot-home', assignee: 'su-author', payload: {} });
    await publishTool.handler({ title: 'Edition', request_key: 'daily' } as never, CTX as never);
    const scope = publishReportM.mock.calls[0][2].requestScope;
    expect(scope).toMatch(/^operation:[a-f0-9]{64}$/);
    expect(publishReportM.mock.calls[0][2]).toMatchObject({ authorOwnerId: 'su-author', authorSessionRef: 'run-abc' });
    expect(operationBindingM).toHaveBeenCalledWith('ws1', 'su-author');
    expect(getWorkItemM).toHaveBeenCalledWith('WI-native', 'pot-home');
    expect(operationMatchM).toHaveBeenCalledWith({ status: 'bound', binding }, expect.objectContaining({ id: 'WI-native' }));
    getWorkItemM.mockResolvedValue({ id: 'WI-native', harness: 'pot-home', assignee: 'retry-author', payload: {} });
    await publishTool.handler({ title: 'Edition', request_key: 'daily' } as never,
      { ...CTX, ownerId: 'retry-author', runId: 'retry-session' } as never);
    expect(publishReportM.mock.calls[1][2]).toMatchObject({ requestScope: scope, authorOwnerId: 'retry-author' });
    operationBindingM.mockResolvedValue({ status: 'bound', binding: { ...binding, workItemId: 'WI-other' } });
    getWorkItemM.mockResolvedValue({ id: 'WI-other', assignee: 'su-author' });
    await publishTool.handler({ title: 'Edition', request_key: 'daily' } as never, CTX as never);
    expect(publishReportM.mock.calls[2][2].requestScope).not.toBe(scope);
  });
  it('refuses unavailable, mismatched, missing and unheld operation bindings before publication', async () => {
    operationBindingM.mockResolvedValue({ status: 'unavailable', reason: 'activation cannot be verified' });
    expect(body(await publishTool.handler({ title: 'A', request_key: 'daily' } as never, CTX as never) as Out))
      .toMatchObject({ ok: false, error: 'operation_binding_unavailable' });
    operationBindingM.mockResolvedValue({ status: 'bound', binding: { workItemId: 'WI-native', storageHarnessSlug: 'pot' } });
    for (const item of [null, { id: 'WI-native', assignee: 'peer' }, { id: 'WI-native', assignee: 'su-author' }]) {
      getWorkItemM.mockResolvedValue(item);
      operationMatchM.mockReturnValue({ allowed: false, reason: 'canonical pin differs' });
      expect(body(await publishTool.handler({ title: 'A', request_key: 'daily' } as never, CTX as never) as Out))
        .toMatchObject({ ok: false, error: 'operation_binding_mismatch' });
    }
    operationMatchM.mockReturnValue({ allowed: true });
    getWorkItemM.mockResolvedValue({ id: 'WI-native', assignee: 'peer' });
    expect(body(await publishTool.handler({ title: 'A', request_key: 'daily' } as never, CTX as never) as Out))
      .toMatchObject({ ok: false, error: 'operation_binding_mismatch' });
    expect(publishReportM).not.toHaveBeenCalled();
    expect(emitAwaitedEventM).not.toHaveBeenCalled();
  });
  it('passes a retry key separately from server-stamped origin and reports content conflicts', async () => {
    await publishTool.handler({ title: 'Edition', request_key: 'daily-2026-10-07' } as never, CTX as never);
    expect(publishReportM.mock.calls[0][1].requestKey).toBe('daily-2026-10-07');
    publishReportM.mockRejectedValue(new ReportRequestConflictError('daily-2026-10-07'));
    const result = body(await publishTool.handler({ title: 'Changed', request_key: 'daily-2026-10-07' } as never, CTX as never) as Out);
    expect(result).toMatchObject({ ok: false, error: 'request_key_conflict' });
    const schema = publishTool.args as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ title: 'A', request_key: ' ' }).success).toBe(false);
    expect(schema.safeParse({ title: 'A', request_key: 'x'.repeat(201) }).success).toBe(false);
  });
  it('passes the typed snapshot through the existing publish/get wire with exact body identity', async () => {
    const snapshot = goalOwnerReportFixture('ws1');
    const bodyMd = serializeGoalOwnerReportSnapshot(snapshot);
    const r = record({ bodyMd, goalOwnerReport: snapshot, subject: { kind: 'goal', ref: snapshot.goalId, label: null } });
    publishReportM.mockResolvedValue(r);
    const published: any = body(await publishTool.handler({ title: 'GOAL snapshot', goal_owner_report: snapshot } as never, CTX as never) as Out);
    expect(publishReportM.mock.calls[0]![1]).toMatchObject({ workspaceId: 'ws1', goalOwnerReport: snapshot });
    expect(published.goal_owner_report).toEqual(snapshot);
    expect(published.body_sha256).toMatch(/^[a-f0-9]{64}$/);
    getReportM.mockResolvedValue(r);
    const fetched: any = body(await getTool.handler({ id: 'rpt_1' } as never, CTX as never) as Out);
    expect(fetched.results[0].report).toMatchObject({ report_id: published.report_id, body_sha256: published.body_sha256, goal_owner_report: snapshot, body_md: bodyMd });
  });
  it('SPEC-P-003-body-cap-refusal-carries-overage: an over-cap body is refused WITH its overage', async () => {
    const bytes = REPORT_BODY_MAX_BYTES + 1234;
    publishReportM.mockRejectedValue(new ReportBodyTooLargeError(bytes));
    const out: any = body(await publishTool.handler({ title: 'A', body_md: 'x' } as never, CTX as never) as Out);
    expect(out).toMatchObject({
      ok: false,
      error: 'body_too_large',
      bytes,
      limitBytes: REPORT_BODY_MAX_BYTES,
      overageBytes: 1234,
    });
  });

  it('maps the store\'s named errors to distinct, actionable refusal codes', async () => {
    const cases: Array<[string, string]> = [
      ['cannot supersede "rpt_x": no such report in workspace ws1', 'supersedes_not_found'],
      ['report subject.ref is required when subject.kind is "plan"', 'subject_ref_required'],
      ['invalid report kind "bogus"; expected one of audit', 'invalid_field'],
      ['report title is required', 'invalid_field'],
    ];
    for (const [message, error] of cases) {
      publishReportM.mockRejectedValue(new Error(message));
      const out: any = body(await publishTool.handler({ title: 'A' } as never, CTX as never) as Out);
      expect(out).toMatchObject({ ok: false, error });
    }
  });

  it('rejects an out-of-vocabulary kind / visibility / subject.kind at the schema', () => {
    const schema = publishTool.args as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ title: 'A', kind: 'bogus' }).success).toBe(false);
    expect(schema.safeParse({ title: 'A', visibility: 'everyone' }).success).toBe(false);
    expect(schema.safeParse({ title: 'A', subject: { kind: 'nonsense' } }).success).toBe(false);
    expect(schema.safeParse({ title: 'A', kind: 'postmortem', visibility: 'pot' }).success).toBe(true);
  });

  it('returns a stable id AND its UI path (R-1)', async () => {
    const out: any = body(await publishTool.handler({ title: 'A' } as never, CTX as never) as Out);
    expect(out).toMatchObject({ ok: true, report_id: 'rpt_1', path: '/reports?sel=rpt_1', lineage_id: 'rpt_1' });
    const link = new URL(out.path, 'http://localhost');
    expect(link.pathname).toBe('/reports');
    expect(link.searchParams.get('sel')).toBe(out.report_id);
  });
});

// ── The published row must survive a failing side effect ─────────────────────
describe('reports:publish — side effects are reported, never fatal', () => {
  it.each([
    ['original', record(), { title: 'A' }],
    ['correction', record({ reportId: 'rpt_2', supersedesReportId: 'rpt_1' }), { title: 'A corrected', supersedes: 'rpt_1' }],
  ])('indexes the committed %s with its exact workspace and body', async (_, committed, args) => {
    publishReportM.mockResolvedValue(committed);
    const out = body(await publishTool.handler(args as never, CTX as never) as Out);
    expect(out.ok).toBe(true);
    await vi.waitFor(() => expect(indexReportM).toHaveBeenCalledExactlyOnceWith({}, committed));
  });

  it('keeps a committed report readable when indexing needs sweep recovery', async () => {
    indexReportM.mockRejectedValue(new Error('embedder unavailable'));
    const out = body(await publishTool.handler({ title: 'A' } as never, CTX as never) as Out);
    expect(out).toMatchObject({ ok: true, report_id: 'rpt_1' });
    await vi.waitFor(() => expect(CTX.log).toHaveBeenCalledWith(
      'Report rpt_1 indexing pending sweep recovery: Error: embedder unavailable',
    ));
    expect(body(await getTool.handler({ id: 'rpt_1' } as never, CTX as never) as Out).results[0].report.report_id).toBe('rpt_1');
  });

  it('emits report:published:<id> carrying the id, lineage and path', async () => {
    await publishTool.handler({ title: 'A' } as never, CTX as never);
    expect(emitAwaitedEventM).toHaveBeenCalledTimes(1);
    const [opts] = emitAwaitedEventM.mock.calls[0];
    expect(opts.key).toBe('report:published:rpt_1');
    expect(opts.payload).toMatchObject({ report_id: 'rpt_1', lineage_id: 'rpt_1', path: '/reports?sel=rpt_1' });
  });

  it('a failing emit still reports the publish as ok, flagged event_emitted:false', async () => {
    // The row is already committed: failing the call here would tell the caller the
    // publish failed when it did not, and the retry would duplicate the report.
    emitAwaitedEventM.mockRejectedValue(new Error('bus down'));
    const out: any = body(await publishTool.handler({ title: 'A' } as never, CTX as never) as Out);
    expect(out.ok).toBe(true);
    expect(out.report_id).toBe('rpt_1');
    expect(out.event_emitted).toBe(false);
  });

  it('invalidates the Reports sync query after a successful publish', async () => {
    await publishTool.handler({ title: 'A' } as never, CTX as never);
    // The invalidation is detached behind a dynamic import, so it settles over
    // several microtask ticks — a single `await Promise.resolve()` lands before it
    // and would read as "never invalidated".
    await vi.waitFor(() => expect(notifySyncInvalidateM).toHaveBeenCalledWith('reports.library', {}));
    expect(notifySyncInvalidateM).toHaveBeenCalledWith('reports.get', {});
  });

  it('does NOT emit or invalidate when the publish was refused', async () => {
    publishReportM.mockRejectedValue(new ReportBodyTooLargeError(REPORT_BODY_MAX_BYTES + 1));
    await publishTool.handler({ title: 'A' } as never, CTX as never);
    expect(emitAwaitedEventM).not.toHaveBeenCalled();
    expect(notifySyncInvalidateM).not.toHaveBeenCalled();
    expect(indexReportM).not.toHaveBeenCalled();
  });
});

// ── R-7: the visibility gate is wired on EVERY read path ─────────────────────
describe('visibility matrix (R-7) — every read passes a viewer', () => {
  const expectedViewer = { isOwner: false, ownerId: 'su-author', potSlug: 'papercusp' };

  it('SPEC-P-003-read-visibility-enforced: get / list / search all hand the store a viewer', async () => {
    await getTool.handler({ id: 'rpt_1' } as never, CTX as never);
    expect(getReportM.mock.calls[0][3]).toEqual(expectedViewer);
    expect(getReportM.mock.calls[0][4]).toBeUndefined();
    expect(readScorecardEvidenceM).not.toHaveBeenCalled();

    await listTool.handler({} as never, CTX as never);
    expect(listReportsM.mock.calls[0][1].viewer).toEqual(expectedViewer);

    await searchTool.handler({ query: 'gate' } as never, CTX as never);
    expect(searchReportsM.mock.calls[0][1].viewer).toEqual(expectedViewer);
  });

  it('never claims owner authority for an agent session — `owner` visibility would mean nothing', async () => {
    await listTool.handler({} as never, { ...CTX, isSuperuser: true, isPowerUser: true } as never);
    expect(listReportsM.mock.calls[0][1].viewer.isOwner).toBe(false);
  });

  it('a viewer with no identity still gets a viewer object, not an omitted gate', async () => {
    // The store treats an ABSENT viewer as `TRUE` (see everything). An anonymous
    // caller must therefore still produce a viewer — one that sees `workspace` only.
    await listTool.handler({} as never, { workspaceId: 'ws1', log: vi.fn() } as never);
    const passed = listReportsM.mock.calls[0][1].viewer;
    expect(passed).toBeDefined();
    expect(passed).toEqual({ isOwner: false, ownerId: null, potSlug: null });
  });

  it('the lineage read is gated too — history cannot be a way around the matrix', async () => {
    await getTool.handler({ id: 'rpt_1', lineage: true } as never, CTX as never);
    expect(listReportLineageM.mock.calls[0][3]).toEqual(expectedViewer);
  });

  it('an invisible report reads as not_found, never as forbidden', async () => {
    getReportM.mockResolvedValue(null);
    const out = body(await getTool.handler({ id: 'rpt_secret' } as never, CTX as never) as Out);
    expect(out.results[0]).toMatchObject({ ok: false, id: 'rpt_secret', error: 'not_found' });
  });
});

describe('reports:get — judge-only scorecard citation scope', () => {
  const judgeCtx = { ...CTX, role: 'judge' };
  const judgeExpectedViewer = { isOwner: false, ownerId: 'su-author', potSlug: 'papercusp' };

  it('reads an owner report only after the exact citation is found in the named scorecard', async () => {
    readScorecardEvidenceM.mockResolvedValue({
      kind: 'found',
      scorecard: {
        criteria: [{ key: 'evidence', rating: 'pass', evidence: 'Audited report:rpt_private.' }],
      },
    });
    getReportM.mockResolvedValue(record({ reportId: 'rpt_private' }));

    const out = body(await getTool.handler({
      id: 'rpt_private',
      scorecardIssueId: 'EI-123',
    } as never, judgeCtx as never) as Out);

    expect(readScorecardEvidenceM).toHaveBeenCalledWith('EI-123');
    expect(getReportM).toHaveBeenCalledWith(
      expect.anything(),
      'ws1',
      'rpt_private',
      judgeExpectedViewer,
      { kind: 'scorecard-citation', reportId: 'rpt_private' },
    );
    expect(out.results[0]).toMatchObject({ ok: true, id: 'rpt_private' });
  });

  it('accepts a bare report id in evidenceRef only when it matches exactly', async () => {
    readScorecardEvidenceM.mockResolvedValue({
      kind: 'found',
      scorecard: {
        criteria: [{
          key: 'evidence',
          rating: 'pass',
          evidence: 'See the attached report.',
          evidenceRef: 'rpt_private',
        }],
      },
    });
    getReportM.mockResolvedValue(record({ reportId: 'rpt_private' }));

    const exact = body(await getTool.handler({
      id: 'rpt_private',
      scorecardIssueId: 'EI-123',
    } as never, judgeCtx as never) as Out);
    expect(exact.results[0]).toMatchObject({ ok: true, id: 'rpt_private' });

    readScorecardEvidenceM.mockResolvedValue({
      kind: 'found',
      scorecard: {
        criteria: [{
          key: 'evidence',
          rating: 'pass',
          evidence: 'See the attached report.',
          evidenceRef: 'rpt_private-extra',
        }],
      },
    });
    getReportM.mockClear();

    const prefix = body(await getTool.handler({
      id: 'rpt_private',
      scorecardIssueId: 'EI-123',
    } as never, judgeCtx as never) as Out);
    expect(prefix.results[0]).toMatchObject({ ok: false, id: 'rpt_private', error: 'not_found' });
    expect(getReportM).not.toHaveBeenCalled();
  });

  it('does not grant the scoped path to other roles or similarly prefixed ids', async () => {
    readScorecardEvidenceM.mockResolvedValue({
      kind: 'found',
      scorecard: {
        criteria: [{ key: 'evidence', rating: 'pass', evidence: 'report:rpt_private-extra' }],
      },
    });

    const nonJudge = body(await getTool.handler({
      id: 'rpt_private',
      scorecardIssueId: 'EI-123',
    } as never, { ...CTX, role: 'reviewer' } as never) as Out);
    expect(nonJudge.results[0]).toMatchObject({ ok: false, id: 'rpt_private', error: 'not_found' });
    expect(readScorecardEvidenceM).not.toHaveBeenCalled();
    expect(getReportM).not.toHaveBeenCalled();

    const uncited = body(await getTool.handler({
      id: 'rpt_private',
      scorecardIssueId: 'EI-123',
    } as never, judgeCtx as never) as Out);
    expect(uncited.results[0]).toMatchObject({ ok: false, id: 'rpt_private', error: 'not_found' });
    expect(getReportM).not.toHaveBeenCalled();
  });

  it.each([
    ['bulk reads', { ids: ['rpt_private'], scorecardIssueId: 'EI-123' }],
    ['lineage reads', { id: 'rpt_private', scorecardIssueId: 'EI-123', lineage: true }],
  ])('rejects %s from the scoped path', async (_label, args) => {
    const out = body(await getTool.handler(args as never, judgeCtx as never) as Out);
    expect(out.results[0]).toMatchObject({ ok: false, error: 'invalid_evidence_scope' });
    expect(readScorecardEvidenceM).not.toHaveBeenCalled();
    expect(getReportM).not.toHaveBeenCalled();
  });
});

// ── Retire: soft, author-only, existence-preserving ──────────────────────────
describe('reports:retire — write authority is narrower than the read matrix', () => {
  it('retires a report the caller authored', async () => {
    const out = body(await retireTool.handler({ id: 'rpt_1' } as never, CTX as never) as Out);
    expect(out.results[0]).toMatchObject({ ok: true, id: 'rpt_1' });
    expect(retireReportM).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(notifySyncInvalidateM).toHaveBeenCalledWith('reports.get', {}));
    expect(notifySyncInvalidateM).toHaveBeenCalledWith('reports.library', {});
  });

  it('refuses not_author for a VISIBLE report the caller did not write — and does not retire it', async () => {
    getReportM.mockResolvedValue(record({ origin: { harnessSlug: 'papercusp', authorOwnerId: 'su-someone-else', authorSessionRef: null } }));
    const out = body(await retireTool.handler({ id: 'rpt_1' } as never, CTX as never) as Out);
    expect(out.results[0]).toMatchObject({ ok: false, id: 'rpt_1', error: 'not_author' });
    expect(retireReportM).not.toHaveBeenCalled();
  });

  it('an invisible report is not_found — retire cannot be used to probe which ids exist', async () => {
    getReportM.mockResolvedValue(null);
    const out = body(await retireTool.handler({ id: 'rpt_hidden' } as never, CTX as never) as Out);
    expect(out.results[0]).toMatchObject({ ok: false, error: 'not_found' });
    expect(retireReportM).not.toHaveBeenCalled();
  });

  it('one refusal never fails the rest of the batch', async () => {
    getReportM
      .mockResolvedValueOnce(record({ reportId: 'rpt_1' }))
      .mockResolvedValueOnce(null);
    const out = body(await retireTool.handler({ ids: ['rpt_1', 'rpt_gone'] } as never, CTX as never) as Out);
    expect(out.counts).toMatchObject({ ok: 1, failed: 1 });
  });
});

// ── List / search projections ────────────────────────────────────────────────
describe('reports:list / reports:search — projections', () => {
  it('omits the body from list rows but reports its size', async () => {
    const out: any = body(await listTool.handler({} as never, CTX as never) as Out);
    expect(out.reports[0]).not.toHaveProperty('bodyMd');
    expect(out.reports[0]).not.toHaveProperty('body_md');
    expect(out.reports[0]).toMatchObject({ report_id: 'rpt_1', path: '/reports?sel=rpt_1', body_bytes: 4 });
  });

  it('every verb names the id identically — publish and list cannot disagree', async () => {
    // The defect this pins: spreading the camelCase domain record into a response
    // made publish answer `report_id` and list answer `reportId` for one field.
    const published: any = body(await publishTool.handler({ title: 'A' } as never, CTX as never) as Out);
    const listed: any = body(await listTool.handler({} as never, CTX as never) as Out);
    const got = body(await getTool.handler({ id: 'rpt_1' } as never, CTX as never) as Out);
    for (const row of [published, listed.reports[0], got.results[0].report]) {
      expect(row.report_id).toBe('rpt_1');
      expect(row).not.toHaveProperty('reportId');
    }
  });

  it('search returns the rank so a strong match is distinguishable from a passing mention', async () => {
    const out: any = body(await searchTool.handler({ query: 'gate' } as never, CTX as never) as Out);
    expect(out).toMatchObject({ ok: true, count: 1, query: 'gate' });
    expect(out.hits[0]).toMatchObject({ rank: 0.42, report_id: 'rpt_1' });
    expect(out.hits[0]).not.toHaveProperty('bodyMd');
  });

  it('passes the three independent axes through as independent filters (R-2)', async () => {
    await listTool.handler(
      { kind: 'postmortem', subject: { kind: 'plan', ref: 'p1' }, origin_harness_slug: 'other', tags: ['t'] } as never,
      CTX as never,
    );
    expect(listReportsM.mock.calls[0][1]).toMatchObject({
      kind: 'postmortem',
      subject: { kind: 'plan', ref: 'p1' },
      originHarnessSlug: 'other',
      tags: ['t'],
    });
  });

  it('rejects a search query too short to be meaningful', () => {
    const schema = searchTool.args as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ query: 'a' }).success).toBe(false);
    expect(schema.safeParse({ query: 'green gate' }).success).toBe(true);
  });
});
