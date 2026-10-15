/**
 * bulk-run-store.integration.test.ts — the Inbox bulk-resolve run substrate
 * against real Postgres (inbox-bulk-resolve-2026-08-23, P-001).
 *
 * Validates migration 912's `attention_bulk_runs` + `attention_bulk_run_items`
 * and the store's SQL against the full migrated schema. Follows the org-fixture
 * mock pattern used by triage-store.integration.test.ts: the store routes
 * through `getOrgPg().sql` as the table owner, so we mock it to the fixture's
 * admin (RLS-bypass) client and mock the workspace resolver.
 *
 * The tests are deliberately weighted toward the two properties that would fail
 * SILENTLY in production rather than loudly in review:
 *   - counters are DERIVED from item rows, so a re-reported item (the real
 *     consult-reply path) cannot double-count;
 *   - `settleRunPhase` reads the item rows rather than trusting the caller, so
 *     a miscounting resolver cannot park the pane in `review` with nothing to
 *     review, nor mark a run `complete` while items still need the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  ws: 'ws-bulk-run-test',
  deliverOwnerDigest: vi.fn(async () => ({ delivered: true })),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('./bulk-run-owner-digest', () => ({
  UNATTENDED_BULK_REQUESTER: 'system:inbox-bulk-resolve',
  deliverUnattendedRunOwnerDigest: h.deliverOwnerDigest,
}));

const {
  BulkRunAlreadyActiveError,
  createRun,
  getRun,
  getRunItems,
  getSettledInboxMessageIds,
  getLatestRun,
  getActiveRun,
  getRunningRun,
  setRunPhase,
  unsafeSetRunPhaseForFixtures,
  failRunIfExecuting,
  executeBulkRunAction,
  executeBulkRunItemReversal,
  reportOutcomes,
  getPendingReviewItems,
  getItemIdsAwaitingOwnerReview,
  markItemAccepted,
  markItemDismissed,
  settleRunPhase,
  recordRunHeartbeat,
  classifyRunLiveness,
  restartRun,
  resumeReviewRun,
  reclassifyLegacySkipped,
  RUN_HEARTBEAT_STALE_MS,
} = await import('./bulk-run-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { upsertTriage, readTriageByWorkspace } = await import('./triage-store');

/** A three-item snapshot shaped like what InboxPane posts. */
function seed(prefix: string) {
  return [
    {
      itemId: `coord-escalation:${prefix}-1`,
      kind: 'coord-escalation',
      title: 'Quarantine the flaky gate test?',
      ref: { kind: 'coord-escalation', msgId: `${prefix}-m1` },
      ownerAgentId: 'su-aaa',
    },
    {
      itemId: `work-item-needs-human:${prefix}-2`,
      kind: 'work-item-needs-human',
      title: 'Need the PostHog key',
      ref: { kind: 'work-item-needs-human', workItemId: 'WI-1' },
      ownerAgentId: 'su-bbb',
    },
    {
      itemId: `smoke-fail:${prefix}-3`,
      kind: 'smoke-fail',
      title: 'Desktop smoke red',
      ref: { kind: 'smoke-fail' },
      ownerAgentId: null,
    },
  ];
}

describe('attention bulk-run store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // WI-41012 — single-flight makes a workspace hold at most one pending/running
  // run, so tests can no longer share one. Each gets its own workspace, which
  // is closer to production anyway: a run left mid-flight by one test is not a
  // fixture the next test should inherit.
  let wsSeq = 0;
  beforeEach(() => {
    wsSeq += 1;
    h.ws = `ws-bulk-run-test-${wsSeq}`;
    h.deliverOwnerDigest.mockClear();
  });

  it('delivers the P-010 owner digest from the run-store pass-ending seam only for unattended runs', async () => {
    const unattended = await createRun({
      items: seed('owner-digest'),
      requestedBy: 'system:inbox-bulk-resolve',
      harnessSlug: 'papercusp',
    });
    await unsafeSetRunPhaseForFixtures({ runId: unattended.runId, phase: 'complete' });

    expect(h.deliverOwnerDigest).toHaveBeenCalledTimes(1);
    expect(h.deliverOwnerDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: unattended.runId,
        requestedBy: 'system:inbox-bulk-resolve',
        phase: 'complete',
      }),
      expect.arrayContaining([expect.objectContaining({ itemId: 'coord-escalation:owner-digest-1' })]),
    );

    h.deliverOwnerDigest.mockClear();
    const foreground = await createRun({
      items: seed('foreground'),
      requestedBy: 'owner:aviynw',
      harnessSlug: 'papercusp',
    });
    await unsafeSetRunPhaseForFixtures({ runId: foreground.runId, phase: 'complete' });
    expect(h.deliverOwnerDigest).not.toHaveBeenCalled();
  });

  it('creates a run from the snapshot, preserving order and ref shape', async () => {
    const run = await createRun({
      items: seed('a'),
      filterSnapshot: { tier: 'needs', kinds: ['coord-escalation'], query: 'gate', shownCount: 3 },
      requestedBy: 'owner:aviynw',
      harnessSlug: 'papercusp',
    });

    expect(run.phase).toBe('pending');
    expect(run.totalItems).toBe(3);
    // The filter snapshot is provenance and must survive the jsonb round-trip.
    expect(run.filterSnapshot.tier).toBe('needs');
    expect(run.filterSnapshot.query).toBe('gate');

    const items = await getRunItems(run.runId);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(items[0]!.itemId).toBe('coord-escalation:a-1');
    // The ref snapshot is what makes a later re-dispatch possible at all.
    expect(items[0]!.ref).toMatchObject({ kind: 'coord-escalation', msgId: 'a-m1' });
    expect(items.every((i) => i.outcome === 'pending')).toBe(true);
  });

  it('returns only exact message refs with a reported outcome in settled Inbox runs for this workspace', async () => {
    const resolver = 'su-bulk-resolver';
    const reviewRun = await createRun({
      items: [
        { itemId: 'reply-reviewed', kind: 'coord-message', title: 'reviewed reply', ref: { kind: 'coord-message', msgId: 'm-reviewed' }, ownerAgentId: resolver },
        { itemId: 'reply-pending', kind: 'coord-message', title: 'pending reply', ref: { kind: 'coord-message', msgId: 'm-pending' }, ownerAgentId: resolver },
        { itemId: 'wrong-ref-kind', kind: 'coord-message', title: 'wrong ref kind', ref: { kind: 'work-item', msgId: 'm-wrong-ref' }, ownerAgentId: resolver },
      ],
      requestedBy: 'owner:receipt-test',
      harnessSlug: 'papercusp',
    });
    await setRunPhase({ runId: reviewRun.runId, phase: 'running', resolverOwner: resolver });
    await recordRunHeartbeat({ runId: reviewRun.runId, resolverOwner: resolver });
    const reviewReport = await reportOutcomes({
      runId: reviewRun.runId,
      resolverOwner: resolver,
      outcomes: [
        { itemId: 'reply-reviewed', outcome: 'recommended' },
        { itemId: 'wrong-ref-kind', outcome: 'recommended' },
      ],
    });
    expect(reviewReport.refused).toBeNull();
    expect((await settleRunPhase({ runId: reviewRun.runId, resolverOwner: resolver }))?.phase).toBe('review');

    const completeRun = await createRun({
      items: [
        { itemId: 'reply-complete', kind: 'coord-message', title: 'completed reply', ref: { kind: 'coord-message', msgId: 'm-complete' }, ownerAgentId: resolver },
      ],
      requestedBy: 'owner:receipt-test',
      harnessSlug: 'papercusp',
    });
    await setRunPhase({ runId: completeRun.runId, phase: 'running', resolverOwner: resolver });
    await recordRunHeartbeat({ runId: completeRun.runId, resolverOwner: resolver });
    await reportOutcomes({
      runId: completeRun.runId,
      resolverOwner: resolver,
      outcomes: [{ itemId: 'reply-complete', outcome: 'dismissed' }],
    });
    expect((await settleRunPhase({ runId: completeRun.runId, resolverOwner: resolver }))?.phase).toBe('complete');

    const failedRun = await createRun({
      items: [
        { itemId: 'reply-failed', kind: 'coord-message', title: 'failed reply', ref: { kind: 'coord-message', msgId: 'm-failed' }, ownerAgentId: resolver },
      ],
      requestedBy: 'owner:receipt-test',
      harnessSlug: 'papercusp',
    });
    await setRunPhase({ runId: failedRun.runId, phase: 'running', resolverOwner: resolver });
    await recordRunHeartbeat({ runId: failedRun.runId, resolverOwner: resolver });
    await reportOutcomes({
      runId: failedRun.runId,
      resolverOwner: resolver,
      outcomes: [{ itemId: 'reply-failed', outcome: 'recommended' }],
    });
    await setRunPhase({ runId: failedRun.runId, phase: 'failed', resolverOwner: resolver });

    const intakeRun = await createRun({
      runKind: 'intake-triage',
      items: [
        { itemId: 'reply-intake', kind: 'coord-message', title: 'intake reply', ref: { kind: 'coord-message', msgId: 'm-intake' }, ownerAgentId: resolver },
      ],
      requestedBy: 'owner:receipt-test',
      harnessSlug: 'papercusp',
    });
    await setRunPhase({ runId: intakeRun.runId, phase: 'running', resolverOwner: resolver });
    await recordRunHeartbeat({ runId: intakeRun.runId, resolverOwner: resolver });
    await reportOutcomes({
      runId: intakeRun.runId,
      resolverOwner: resolver,
      outcomes: [{ itemId: 'reply-intake', outcome: 'recommended' }],
    });
    expect((await settleRunPhase({ runId: intakeRun.runId, resolverOwner: resolver }))?.phase).toBe('review');

    const foreignWorkspace = 'ws-bulk-run-foreign-receipt-test';
    const foreignRun = await createRun({
      workspaceId: foreignWorkspace,
      items: [
        { itemId: 'reply-foreign', kind: 'coord-message', title: 'foreign reply', ref: { kind: 'coord-message', msgId: 'm-foreign' }, ownerAgentId: resolver },
      ],
      requestedBy: 'owner:receipt-test',
      harnessSlug: 'papercusp',
    });
    await setRunPhase({ runId: foreignRun.runId, phase: 'running', resolverOwner: resolver, workspaceId: foreignWorkspace });
    await recordRunHeartbeat({ runId: foreignRun.runId, resolverOwner: resolver, workspaceId: foreignWorkspace });
    await reportOutcomes({
      runId: foreignRun.runId,
      resolverOwner: resolver,
      workspaceId: foreignWorkspace,
      outcomes: [{ itemId: 'reply-foreign', outcome: 'dismissed' }],
    });
    expect((await settleRunPhase({ runId: foreignRun.runId, resolverOwner: resolver, workspaceId: foreignWorkspace }))?.phase).toBe('complete');

    expect(
      await getSettledInboxMessageIds(
        ['m-reviewed', 'm-pending', 'm-wrong-ref', 'm-complete', 'm-failed', 'm-intake', 'm-foreign'],
      ),
    ).toEqual(new Set(['m-reviewed', 'm-complete']));
  });

  it('refuses a run over zero items', async () => {
    await expect(createRun({ items: [] })).rejects.toThrow(/zero items/i);
  });

  // migration 943 / P-003 (D-003): the run row records the launch settings it
  // was STARTED with. These are weighted, like the rest of this file, toward the
  // failure that would be silent: a snapshot that reads back empty, or that is
  // re-derived from the owner's (mutable) current profile on a later read.
  it('persists the click-time launch snapshot and re-reads it from the row, not from a default', async () => {
    const created = await createRun({
      items: seed('ls'),
      launchSnapshot: {
        model: 'sonnet',
        effort: 'high',
        account: 'pool:2',
        carry: 'cold',
        backend: 'claude',
      },
    });

    // Present on the INSERT ... RETURNING path.
    expect(created.launchSnapshot).toMatchObject({
      model: 'sonnet',
      effort: 'high',
      account: 'pool:2',
      carry: 'cold',
      backend: 'claude',
    });

    // …and on the independent SELECT path. This is the half that actually
    // matters: RETURNING would still pass if `launch_snapshot` were missing
    // from RUN_COLUMNS, and every later read (report, reload, restart) uses
    // that column list rather than the insert's return value.
    const reread = await getRun(created.runId);
    expect(reread?.launchSnapshot).toEqual(created.launchSnapshot);
  });

  it('keeps the launch snapshot across phase transitions, so a report shows what the run launched with', async () => {
    const run = await createRun({
      items: seed('ls2'),
      launchSnapshot: { model: 'opus', effort: 'max', account: 'default', carry: 'warm', backend: 'claude' },
    });

    await setRunPhase({ runId: run.runId, phase: 'running' });
    expect((await getRun(run.runId))?.launchSnapshot.model).toBe('opus');

    await setRunPhase({ runId: run.runId, phase: 'review' });
    const settled = await getRun(run.runId);
    // A run's launch record is immutable provenance: a later phase must not
    // clear it or re-derive it. If this ever reads back the current default
    // instead of 'opus', the snapshot has stopped being a snapshot.
    expect(settled?.launchSnapshot).toMatchObject({ model: 'opus', effort: 'max', backend: 'claude' });
  });

  it('accepts a run created with NO launch settings, storing {} rather than failing (pre-943 / older-release compatibility)', async () => {
    // The deployed release inserts runs without this column at all. The
    // migration is only backward-compatible if that path still works AND is
    // distinguishable from "the owner chose null" — an absent field means
    // "inherit the launcher default", which is why {} is the recorded value.
    const run = await createRun({ items: seed('ls3') });
    expect(run.launchSnapshot).toEqual({});
    expect((await getRun(run.runId))?.launchSnapshot).toEqual({});
  });

  it('persists typed recommendation metadata and the owner automation policy', async () => {
    const run = await createRun({
      items: seed('typed'),
      automationPolicy: { mode: 'safe-medium-plus', minConfidence: 'medium' },
      launchSnapshot: { model: 'sonnet', effort: 'high', account: 'default', carry: 'warm', backend: 'claude' },
    });
    expect(run.automationPolicy).toEqual({ mode: 'safe-medium-plus', minConfidence: 'medium' });
    expect(run.launchSnapshot.automationPolicy).toEqual({ mode: 'safe-medium-plus', minConfidence: 'medium' });

    const reported = await reportOutcomes({
      runId: run.runId,
      outcomes: [
        {
          itemId: 'work-item-needs-human:typed-2',
          outcome: 'recommended',
          disposition: 'owner_action',
          recommendationKind: 'owner_action',
          recommendationLabel: 'Provide the external key',
          recommendationRationale: 'The item explicitly names a credential only the owner can provide.',
          evidenceBasis: ['work-item-needs-human:typed-2', 'credential dependency'],
          responsibility: 'owner',
          confidenceLevel: 'high',
          rationale: 'The item explicitly names a credential only the owner can provide.',
        },
      ],
    });
    expect(reported.updated).toEqual(['work-item-needs-human:typed-2']);
    const item = (await getRunItems(run.runId)).find((row) => row.itemId === 'work-item-needs-human:typed-2');
    expect(item).toMatchObject({
      outcome: 'recommended',
      disposition: 'owner_action',
      recommendationKind: 'owner_action',
      recommendationLabel: 'Provide the external key',
      confidenceLevel: 'high',
      responsibility: 'owner',
    });
    expect(item?.recommendation?.actionId).toBeNull();
  });

  // observation-candidate-acceptance-promotion-2026-09-30 P-004 (R-3/R-18/R-19),
  // migration 1296 `intake_decision`.
  it('persists intake decisions, enforces the reason/target/missing-info CHECK, and resumes only named rows', async () => {
    const intake = (n: number) => ({
      itemId: `improvement:intake-${n}`,
      kind: 'improvement',
      title: `Observation ${n}`,
      ref: { kind: 'improvement', id: `EI-${n}` },
      ownerAgentId: null,
    });
    const run = await createRun({ items: [intake(1), intake(2), intake(3)] });
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-intake' });
    const decision = (disposition: string, extra: Record<string, unknown> = {}) => ({
      disposition,
      reason: `because ${disposition}`,
      decidedBy: 'su-intake',
      owner: 'agent',
      targetRef: null,
      missingInformation: null,
      decidedAt: '2026-10-01T10:00:00.000Z',
      // readIntakeDecision normalizes every stored decision to the full P-006 (D-014) shape,
      // so a round-trip carries these keys even when the writer omitted them.
      workKind: null,
      acceptance: null,
      sourceRevision: null,
      reproduction: null, // P-013: promote-only; null whenever the writer gave none
      ...extra,
    });
    const reported = await reportOutcomes({
      runId: run.runId,
      resolverOwner: 'su-intake',
      outcomes: [
        {
          itemId: 'improvement:intake-1',
          outcome: 'recommended',
          disposition: 'routed',
          recommendationKind: 'routed',
          recommendationLabel: 'Promote to accepted work',
          responsibility: 'engineering',
          confidenceLevel: 'high',
          rationale: 'because promote',
          intakeDecision: decision('promote', { owner: 'engineering', workKind: 'fix', sourceRevision: 'rev-7' }) as never,
        },
        {
          itemId: 'improvement:intake-2',
          outcome: 'recommended',
          disposition: 'cleanup_candidate',
          recommendationKind: 'cleanup_candidate',
          recommendationLabel: 'Merge / link into existing work',
          responsibility: 'agent',
          confidenceLevel: 'medium',
          rationale: 'because merge',
          intakeDecision: decision('merge', { targetRef: 'WI-9' }) as never,
        },
      ],
    });
    expect(reported.updated.sort()).toEqual(['improvement:intake-1', 'improvement:intake-2']);

    const rows = await getRunItems(run.runId);
    const byId = new Map(rows.map((row) => [row.itemId, row]));
    expect(byId.get('improvement:intake-1')?.intakeDecision).toEqual(decision('promote', { owner: 'engineering', workKind: 'fix', sourceRevision: 'rev-7' }));
    expect(byId.get('improvement:intake-2')?.intakeDecision).toMatchObject({ disposition: 'merge', targetRef: 'WI-9' });
    // R-19: the unreached row stays pending with no decision.
    expect(byId.get('improvement:intake-3')).toMatchObject({ outcome: 'pending', intakeDecision: null });

    // The CHECK repeats the validator for any non-TypeScript writer (R-3/R-18).
    const sql = db.adminSql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    const setRaw = (value: Record<string, unknown>) =>
      sql`UPDATE harness_shared.attention_bulk_run_items
             SET intake_decision = ${JSON.stringify(value)}::jsonb
           WHERE run_id = ${run.runId} AND item_id = 'improvement:intake-3'`;
    await expect(setRaw(decision('reject', { reason: '  ' }))).rejects.toThrow(/intake_decision_check/);
    await expect(setRaw(decision('reject', { decidedBy: '' }))).rejects.toThrow(/intake_decision_check/);
    await expect(setRaw(decision('merge'))).rejects.toThrow(/intake_decision_check/);
    await expect(setRaw(decision('retry'))).rejects.toThrow(/intake_decision_check/);
    await expect(setRaw(decision('ignore'))).rejects.toThrow(/intake_decision_check/);

    // An intake input that could not be decided is an explicit, visible failure.
    await reportOutcomes({
      runId: run.runId,
      resolverOwner: 'su-intake',
      outcomes: [{ itemId: 'improvement:intake-3', outcome: 'failed', error: 'evidence link 404s' }],
    });
    expect((await getRunItems(run.runId)).find((row) => row.itemId === 'improvement:intake-3')).toMatchObject({
      outcome: 'failed',
      intakeDecision: null,
    });

    // Resume resets only the named rows; earlier decisions survive (R-19).
    await settleRunPhase({ runId: run.runId, resolverOwner: 'su-intake' });
    const resumed = await resumeReviewRun({
      runId: run.runId,
      itemIds: ['improvement:intake-2', 'improvement:intake-3'],
      resolverOwner: 'su-next',
    });
    expect(resumed.ok).toBe(true);
    const after = new Map((await getRunItems(run.runId)).map((row) => [row.itemId, row]));
    expect(after.get('improvement:intake-1')?.intakeDecision).toMatchObject({ disposition: 'promote' });
    expect(after.get('improvement:intake-2')).toMatchObject({ outcome: 'pending', intakeDecision: null });
  });

  it('de-dupes repeated ids in the snapshot rather than aborting the seed', async () => {
    const dupe = seed('b');
    const run = await createRun({ items: [...dupe, dupe[0]!] });
    expect(run.totalItems).toBe(3);
    expect(await getRunItems(run.runId)).toHaveLength(3);
  });

  it('rolls back the run and earlier item rows when manifest seeding fails', async () => {
    const ws = `ws-create-run-rollback-${Date.now()}`;
    const runId = `bulk-rollback-${Date.now()}`;

    // JSON.stringify runs while the second item is being seeded, after the
    // run row and first item have already been written. The transaction must
    // remove both instead of leaving a partial pending run behind.
    await expect(
      createRun({
        workspaceId: ws,
        runId,
        items: [
          { itemId: 'first-item', ref: {} },
          { itemId: 'second-item', ref: { unsupported: BigInt(1) } },
        ],
      }),
    ).rejects.toThrow(/BigInt|serialize/i);

    expect(await getRun(runId, ws)).toBeNull();
    expect(await getRunItems(runId, ws)).toEqual([]);

    // A retry is not blocked by a stranded single-flight row.
    const retry = await createRun({
      workspaceId: ws,
      runId: `${runId}-retry`,
      items: [{ itemId: 'retry-item', ref: {} }],
    });
    expect(retry.phase).toBe('pending');
    expect(await getRunItems(retry.runId, ws)).toHaveLength(1);
  });

  it('derives counters from item rows, so a re-reported item cannot double-count', async () => {
    const run = await createRun({ items: seed('c') });

    // First pass: the resolver recommends an item it cannot settle alone.
    await reportOutcomes({
      runId: run.runId,
      outcomes: [
        {
          itemId: 'coord-escalation:c-1',
          outcome: 'recommended',
          actionId: 'quarantine',
          rationale: 'Red 6 days; failure predates the change.',
          confidence: 'high',
          consulted: true,
        },
      ],
    });
    let after = await getRun(run.runId);
    expect(after!.recommended).toBe(1);
    expect(after!.autoResolved).toBe(0);

    // The consulted asker answers in time, so the SAME item is re-reported as
    // resolved. An incrementing counter would now read recommended:1 too.
    await reportOutcomes({
      runId: run.runId,
      outcomes: [
        {
          itemId: 'coord-escalation:c-1',
          outcome: 'auto_resolved',
          actionId: 'quarantine',
          rationale: 'Asker confirmed the flake and withdrew the gate question.',
          confidence: 'high',
          consulted: true,
          consultReply: 'withdrawn — quarantined on my side',
        },
      ],
    });
    after = await getRun(run.runId);
    expect(after!.autoResolved).toBe(1);
    expect(after!.recommended).toBe(0);
    expect(after!.totalItems).toBe(3);
  });

  it('reports unknown item ids instead of widening the run', async () => {
    const run = await createRun({ items: seed('d') });
    const res = await reportOutcomes({
      runId: run.runId,
      outcomes: [
        { itemId: 'coord-escalation:d-1', outcome: 'skipped', error: 'actions never loaded' },
        { itemId: 'improvement:not-in-this-run', outcome: 'auto_resolved', actionId: 'dismiss' },
      ],
    });
    expect(res.updated).toEqual(['coord-escalation:d-1']);
    expect(res.unknown).toEqual(['improvement:not-in-this-run']);
    // The run must still hold exactly the snapshot it was created with.
    expect(await getRunItems(run.runId)).toHaveLength(3);
  });

  it('reclassifies legacy skipped rows into typed recommendations without changing outcomes', async () => {
    const run = await createRun({ items: seed('legacy-classify') });
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-resolver' });
    await reportOutcomes({
      runId: run.runId,
      resolverOwner: 'su-resolver',
      outcomes: [
        {
          itemId: 'work-item-needs-human:legacy-classify-2',
          outcome: 'skipped',
          error: 'No terminal option offered (open/discuss are both non-terminal)',
        },
      ],
    });
    await settleRunPhase({ runId: run.runId, resolverOwner: 'su-resolver' });

    const result = await reclassifyLegacySkipped({ runId: run.runId });
    expect(result.refused).toBeNull();
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toMatchObject({
      itemId: 'work-item-needs-human:legacy-classify-2',
      outcome: 'skipped',
      disposition: 'investigate',
      recommendationKind: 'investigate',
      confidenceLevel: 'insufficient',
    });
    expect((await getRun(run.runId))?.skipped).toBe(1);
  });

  it('settles to review while items still need the owner, and to complete once none do', async () => {
    const run = await createRun({ items: seed('e') });
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-resolver' });

    await reportOutcomes({
      runId: run.runId,
      outcomes: [
        { itemId: 'coord-escalation:e-1', outcome: 'auto_resolved', actionId: 'resolve', rationale: 'moot' },
        {
          itemId: 'work-item-needs-human:e-2',
          outcome: 'recommended',
          actionId: 'answer',
          rationale: 'owner holds the key',
        },
        { itemId: 'smoke-fail:e-3', outcome: 'skipped', error: 'no terminal action for this kind' },
      ],
    });

    const settled = await settleRunPhase({ runId: run.runId, resolverOwner: 'su-resolver' });
    expect(settled!.phase).toBe('review');
    expect(settled!.resolverOwner).toBe('su-resolver');
    expect(settled!.startedAt).toBeTruthy();

    // Both rows still need the owner. A resolver skip is evidence that it could
    // not act, not an implicit owner dismissal.
    const pending = await getPendingReviewItems(run.runId);
    expect(pending.map((i) => i.itemId)).toEqual(['work-item-needs-human:e-2', 'smoke-fail:e-3']);
    expect(settled!.finishedAt).toBeTruthy();

    // Accepting the recommendation is not enough while the skipped row remains
    // unresolved.
    const accepted = await markItemAccepted({
      runId: run.runId,
      itemId: 'work-item-needs-human:e-2',
      actionId: 'answer',
      note: 'Owner accepted the drafted reply',
    });
    expect(accepted!.outcome).toBe('auto_resolved');

    expect((await settleRunPhase({ runId: run.runId }))!.phase).toBe('review');

    const dismissed = await markItemDismissed({
      runId: run.runId,
      itemId: 'smoke-fail:e-3',
      note: 'Owner reviewed and declined this row',
    });
    expect(dismissed!.outcome).toBe('dismissed');

    const done = await settleRunPhase({ runId: run.runId });
    expect(done!.phase).toBe('complete');
    expect(done!.finishedAt).toBeTruthy();
    expect((await getRun(run.runId))!.autoResolved).toBe(2);
    expect((await getRun(run.runId))!.skipped).toBe(1);
  });

  // WI-10004720 follow-up: the scheduled seeder skips these ids, so each fire
  // seeds items nobody has looked at instead of re-seeding the feed's head.
  it('reports item ids still awaiting the owner in open review runs of the kind, workspace-scoped', async () => {
    const held = await createRun({ items: seed('held') });
    await reportOutcomes({
      runId: held.runId,
      outcomes: [
        { itemId: 'coord-escalation:held-1', outcome: 'recommended', actionId: 'quarantine', rationale: 'needs owner' },
        { itemId: 'work-item-needs-human:held-2', outcome: 'auto_resolved', actionId: 'answer' },
        { itemId: 'smoke-fail:held-3', outcome: 'recommended', actionId: 'retry', rationale: 'needs owner' },
      ],
    });
    await unsafeSetRunPhaseForFixtures({ runId: held.runId, phase: 'review' });
    const dismissed = await markItemDismissed({
      runId: held.runId,
      itemId: 'smoke-fail:held-3',
      note: 'Owner declined this recommendation',
    });
    expect(dismissed!.outcome).toBe('dismissed');

    // A finished run holds nothing: its rows are no longer waiting on anyone.
    const done = await createRun({ items: seed('done') });
    await unsafeSetRunPhaseForFixtures({ runId: done.runId, phase: 'complete' });

    const ids = await getItemIdsAwaitingOwnerReview(h.ws, 'inbox-resolve');
    // recommended + owner-dismissed-in-open-review are held; auto_resolved is not.
    expect([...ids].sort()).toEqual(['coord-escalation:held-1', 'smoke-fail:held-3']);

    expect((await getItemIdsAwaitingOwnerReview(h.ws, 'plan-cleanup')).size).toBe(0);
    expect((await getItemIdsAwaitingOwnerReview(`${h.ws}-other`, 'inbox-resolve')).size).toBe(0);
  });

  it('never settles to complete while an item was never reached', async () => {
    const run = await createRun({ items: seed('f') });
    // Resolver crashed after one item — the other two are still `pending`.
    await reportOutcomes({
      runId: run.runId,
      outcomes: [{ itemId: 'coord-escalation:f-1', outcome: 'auto_resolved', actionId: 'resolve' }],
    });
    const settled = await settleRunPhase({ runId: run.runId });
    // Requirement 2: an unreached item is visible, never silently absent.
    expect(settled!.phase).toBe('review');
  });

  it('releases only granted above-floor recommendations for automatic re-review, preserving owner dismissals', async () => {
    const run = await createRun({ items: seed('risk-held') });
    await reportOutcomes({ runId: run.runId, outcomes: [
      { itemId: 'coord-escalation:risk-held-1', outcome: 'recommended', actionId: 'resolve', rationale: 'supported', confidenceLevel: 'high' },
      { itemId: 'work-item-needs-human:risk-held-2', outcome: 'recommended', actionId: 'resolve', rationale: 'owner decision', confidenceLevel: 'medium' },
      { itemId: 'smoke-fail:risk-held-3', outcome: 'recommended', actionId: 'resolve', rationale: 'owner dismissed', confidenceLevel: 'high' },
    ] });
    await unsafeSetRunPhaseForFixtures({ runId: run.runId, phase: 'review' });
    await markItemDismissed({ runId: run.runId, itemId: 'smoke-fail:risk-held-3', note: 'Declined by owner' });
    const riskLevels = { low: 'automatic', medium: 'automatic', high: 'automatic' } as const;
    const highFloor = await getItemIdsAwaitingOwnerReview(h.ws, 'inbox-resolve', { level: 'L0', minConfidence: 'high', riskLevels });
    expect([...highFloor].sort()).toEqual(['smoke-fail:risk-held-3', 'work-item-needs-human:risk-held-2']);
    const mediumFloor = await getItemIdsAwaitingOwnerReview(h.ws, 'inbox-resolve', { level: 'L0', minConfidence: 'medium', riskLevels });
    expect([...mediumFloor]).toEqual(['smoke-fail:risk-held-3']);
    expect((await getRun(run.runId))!.automationPolicy).not.toHaveProperty('riskLevels');
  });

  // EI-25573324094056113: the release is one-shot. A recommendation made by a run
  // whose own receipt already permitted automatic action has had its auto-accept
  // pass; re-releasing it every fire re-consulted the same assignee ~40 times.
  it('holds a recommendation its own run already adjudicated under the same automatic policy', async () => {
    const riskLevels = { low: 'automatic', medium: 'automatic', high: 'automatic' } as const;
    const standing = { level: 'L2', minConfidence: 'medium', riskLevels } as const;

    const before = await createRun({ items: seed('once-before'), automationPolicy: { mode: 'review-all', level: 'L0', minConfidence: 'high' } });
    await reportOutcomes({ runId: before.runId, outcomes: [
      { itemId: 'coord-escalation:once-before-1', outcome: 'recommended', disposition: 'routed', recommendationKind: 'routed', rationale: 'routed to the assignee', confidenceLevel: 'high' },
    ] });
    await unsafeSetRunPhaseForFixtures({ runId: before.runId, phase: 'review' });

    const under = await createRun({ items: seed('once-under'), automationPolicy: { mode: 'safe-high', ...standing } });
    await reportOutcomes({ runId: under.runId, outcomes: [
      { itemId: 'coord-escalation:once-under-1', outcome: 'recommended', disposition: 'routed', recommendationKind: 'routed', rationale: 'routed to the assignee', confidenceLevel: 'high' },
    ] });
    await unsafeSetRunPhaseForFixtures({ runId: under.runId, phase: 'review' });
    expect((await getRun(under.runId))!.automationPolicy).toMatchObject({ level: 'L2', riskLevels });

    // Only the reported rows; seed()'s unreported siblings stay `pending` and are held either way.
    const reported = (ids: Set<string>) => [...ids].filter((id) => id.startsWith('coord-escalation:once-'));
    const held = reported(await getItemIdsAwaitingOwnerReview(h.ws, 'inbox-resolve', standing));
    // The pre-autonomy recommendation gets its one fresh adjudication; the one
    // already made under this policy stays held for the owner.
    expect(held).toEqual(['coord-escalation:once-under-1']);
    // Without a standing automatic policy both are held, as before.
    const reviewOnly = reported(await getItemIdsAwaitingOwnerReview(h.ws, 'inbox-resolve'));
    expect(reviewOnly.sort()).toEqual(['coord-escalation:once-before-1', 'coord-escalation:once-under-1']);
  });

  it('admits owner acceptance only in review and never rewrites an executing or handled row', async () => {
    const run = await createRun({ items: seed('owner-accept-rail') });
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-resolver' });
    await reportOutcomes({
      runId: run.runId,
      resolverOwner: 'su-resolver',
      outcomes: [
        {
          itemId: 'work-item-needs-human:owner-accept-rail-2',
          outcome: 'recommended',
          actionId: 'answer',
          draftAnswer: 'Use key A',
        },
      ],
    });

    expect(
      await markItemAccepted({
        runId: run.runId,
        itemId: 'work-item-needs-human:owner-accept-rail-2',
        actionId: 'answer',
      }),
    ).toBeNull();
    expect((await getRunItems(run.runId)).find((row) => row.itemId.endsWith('-2'))?.outcome).toBe('recommended');

    await settleRunPhase({ runId: run.runId, resolverOwner: 'su-resolver' });
    expect(
      await markItemAccepted({
        runId: run.runId,
        itemId: 'work-item-needs-human:owner-accept-rail-2',
        actionId: 'answer',
      }),
    ).toMatchObject({ outcome: 'auto_resolved', actionId: 'answer' });
    expect(
      await markItemAccepted({
        runId: run.runId,
        itemId: 'work-item-needs-human:owner-accept-rail-2',
        actionId: 'drop',
      }),
    ).toBeNull();
    expect((await getRunItems(run.runId)).find((row) => row.itemId.endsWith('-2'))).toMatchObject({
      outcome: 'auto_resolved',
      actionId: 'answer',
    });
  });

  it('selectively resumes unresolved review rows without widening membership or resetting handled rows', async () => {
    const run = await createRun({ items: seed('resume-review') });
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-prior' });
    await reportOutcomes({
      runId: run.runId,
      resolverOwner: 'su-prior',
      outcomes: [
        {
          itemId: 'coord-escalation:resume-review-1',
          outcome: 'auto_resolved',
          actionId: 'resolve',
          rationale: 'done',
        },
        {
          itemId: 'work-item-needs-human:resume-review-2',
          outcome: 'recommended',
          actionId: 'answer',
          rationale: 'needs owner',
          draftAnswer: 'Use key A',
        },
        { itemId: 'smoke-fail:resume-review-3', outcome: 'skipped', error: 'no current option' },
      ],
    });
    await settleRunPhase({ runId: run.runId, resolverOwner: 'su-prior' });

    await (h.sql as typeof db.adminSql)`
      UPDATE harness_shared.attention_bulk_runs
         SET started_at = now() - interval '1 hour',
             heartbeat_at = now() - interval '1 hour'
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}`;
    const resumed = await resumeReviewRun({
      runId: run.runId,
      itemIds: ['smoke-fail:resume-review-3', 'not-in-snapshot'],
      resolverOwner: 'su-next',
    });
    expect(resumed).toMatchObject({
      ok: true,
      requeuedIds: ['smoke-fail:resume-review-3'],
      preservedOutcomes: 2,
      run: { phase: 'pending', resolverOwner: 'su-next', finishedAt: null },
    });
    if (!resumed.ok) return;
    expect(resumed.run.heartbeatAt).toBeNull();
    expect(classifyRunLiveness(resumed.run)).toMatchObject({ state: 'live' });
    expect(await restartRun({ runId: run.runId, resolverOwner: 'su-racer' })).toMatchObject({
      ok: false,
      reason: 'not_restartable',
    });
    const items = await getRunItems(run.runId);
    expect(items).toHaveLength(3);
    expect(items.find((row) => row.itemId.endsWith('-1'))?.outcome).toBe('auto_resolved');
    expect(items.find((row) => row.itemId.endsWith('-2'))?.outcome).toBe('recommended');
    expect(items.find((row) => row.itemId.endsWith('-3'))).toMatchObject({
      outcome: 'pending',
      actionId: null,
      error: null,
    });
  });

  it('a failed run keeps its partial outcomes and carries the error', async () => {
    const run = await createRun({ items: seed('g') });
    await reportOutcomes({
      runId: run.runId,
      outcomes: [{ itemId: 'coord-escalation:g-1', outcome: 'auto_resolved', actionId: 'resolve' }],
    });
    const failed = await setRunPhase({
      runId: run.runId,
      phase: 'failed',
      error: 'resolver session ended without reporting',
    });
    expect(failed!.phase).toBe('failed');
    expect(failed!.error).toMatch(/without reporting/);
    expect(failed!.finishedAt).toBeTruthy();
    // Requirement 8: partial work survives; the rest stay hand-resolvable.
    const items = await getRunItems(run.runId);
    expect(items.filter((i) => i.outcome === 'auto_resolved')).toHaveLength(1);
    expect(items.filter((i) => i.outcome === 'pending')).toHaveLength(2);
  });

  it('fails a run whose resolver exits, without overwriting an already-settled run', async () => {
    const run = await createRun({ items: seed('resolver-exit') });
    await setRunPhase({
      runId: run.runId,
      phase: 'running',
      resolverOwner: 'su-resolver-exit',
    });

    const failed = await failRunIfExecuting({
      runId: run.runId,
      resolverOwner: 'su-resolver-exit',
      error: 'resolver process ended before settling the run: exit 1',
    });
    expect(failed).toMatchObject({
      phase: 'failed',
      resolverOwner: 'su-resolver-exit',
      error: expect.stringMatching(/exit 1/),
    });
    expect(failed!.finishedAt).toBeTruthy();

    const settled = await createRun({ items: seed('resolver-late-exit') });
    await setRunPhase({ runId: settled.runId, phase: 'review' });
    expect(
      await failRunIfExecuting({
        runId: settled.runId,
        error: 'late clean exit after review',
      }),
    ).toBeNull();
    expect((await getRun(settled.runId))!.phase).toBe('review');
  });

  it('getActiveRun ignores terminal runs; getLatestRun does not', async () => {
    // Its own workspace: the tests above deliberately leave runs in
    // non-terminal phases, and those ARE active — asking "is anything active?"
    // against the shared workspace would be answering about them, not about
    // this test's runs.
    const ws = 'ws-bulk-run-active-test';

    const older = await createRun({ items: seed('h'), workspaceId: ws });
    await unsafeSetRunPhaseForFixtures({ runId: older.runId, phase: 'complete', workspaceId: ws });

    const newer = await createRun({ items: seed('i'), workspaceId: ws });
    await setRunPhase({ runId: newer.runId, phase: 'running', workspaceId: ws });

    expect((await getActiveRun(ws))!.runId).toBe(newer.runId);
    expect((await getLatestRun(ws))!.runId).toBe(newer.runId);

    // With every run terminal, the pane falls back to idle rather than showing
    // a stale running strip.
    await unsafeSetRunPhaseForFixtures({ runId: newer.runId, phase: 'complete', workspaceId: ws });
    expect(await getActiveRun(ws)).toBeNull();
    expect((await getLatestRun(ws))!.runId).toBe(newer.runId);
  });

  it('scopes reads to the workspace', async () => {
    const run = await createRun({ items: seed('j') });
    expect(await getRun(run.runId, 'ws-someone-else')).toBeNull();
    expect(await getRunItems(run.runId, 'ws-someone-else')).toHaveLength(0);
  });

  // ── WI-41012 / WI-41013 — the two properties the acceptance rubric added
  // after the fact, and which the shipped code did NOT have. Both are about an
  // agent acting on the owner's inbox when it should not be acting at all.

  it('refuses a SECOND run while one is pending or running (single-flight)', async () => {
    const ws = `ws-single-flight-${Date.now()}`;
    const first = await createRun({ items: seed('sf1'), workspaceId: ws });
    expect(first.phase).toBe('pending');

    // A second start — a double-click, or two clients — must not create a
    // second run: each run LAUNCHES A RESOLVER, so two runs is two agents
    // racing over the same items with terminal authority.
    await expect(createRun({ items: seed('sf2'), workspaceId: ws })).rejects.toBeInstanceOf(BulkRunAlreadyActiveError);

    await setRunPhase({ runId: first.runId, phase: 'running', workspaceId: ws });
    await expect(createRun({ items: seed('sf3'), workspaceId: ws })).rejects.toThrow(/already active/i);

    // The refusal NAMES the run in flight, so the caller can point at it rather
    // than telling the owner "something went wrong".
    const err = await createRun({ items: seed('sf4'), workspaceId: ws }).catch((e) => e);
    expect(err.code).toBe('run_already_active');
    expect(err.activeRunId).toBe(first.runId);
    expect(err.activePhase).toBe('running');

    // Only the first run exists — the refusals created nothing.
    expect((await getRunningRun(ws))!.runId).toBe(first.runId);
  });

  it('a run awaiting the OWNER in review does not block a new run', async () => {
    // `review` means the agent is done and the human has not looked yet.
    // Blocking on it would strand the whole feature behind a list the owner may
    // never come back to, so single-flight deliberately excludes it.
    const ws = `ws-review-unblocks-${Date.now()}`;
    const first = await createRun({ items: seed('rv1'), workspaceId: ws });
    await setRunPhase({ runId: first.runId, phase: 'review', workspaceId: ws });

    const second = await createRun({ items: seed('rv2'), workspaceId: ws });
    expect(second.runId).not.toBe(first.runId);
    expect(second.phase).toBe('pending');
  });

  it('refuses the resolver’s report once the run has been stopped, and writes nothing', async () => {
    const ws = `ws-stop-rail-${Date.now()}`;
    const run = await createRun({ items: seed('stop'), workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'running', workspaceId: ws });
    const [one, two] = await getRunItems(run.runId, ws);

    // Normal in-run report lands.
    const ok = await reportOutcomes({
      runId: run.runId,
      workspaceId: ws,
      outcomes: [{ itemId: one!.itemId, outcome: 'auto_resolved', actionId: 'ack', rationale: 'moot' }],
    });
    expect(ok.refused).toBeNull();
    expect(ok.updated).toEqual([one!.itemId]);

    // The owner presses Stop: the route settles the run where it stands.
    const settled = await settleRunPhase({ runId: run.runId, workspaceId: ws });
    expect(settled!.phase).toBe('review');

    // The resolver is a separate process and has not noticed. Its next report
    // must be REFUSED, not silently dropped — it has usually already taken the
    // action it is reporting, and a silent drop would leave it believing the
    // record exists.
    const after = await reportOutcomes({
      runId: run.runId,
      workspaceId: ws,
      outcomes: [{ itemId: two!.itemId, outcome: 'auto_resolved', actionId: 'ack', rationale: 'late' }],
    });
    expect(after.refused).toEqual({ reason: 'run_not_accepting_reports', phase: 'review' });
    expect(after.updated).toEqual([]);
    expect(after.unknown).toEqual([two!.itemId]);

    // And nothing moved: the late item is untouched, the early one intact.
    const rows = await getRunItems(run.runId, ws);
    expect(rows.find((r) => r.itemId === two!.itemId)!.outcome).toBe('pending');
    expect(rows.find((r) => r.itemId === one!.itemId)!.outcome).toBe('auto_resolved');
  });

  it('keeps refusing reports once a run is complete or failed', async () => {
    const ws = `ws-stop-terminal-${Date.now()}`;
    const run = await createRun({ items: seed('term'), workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'failed', error: 'gave up', workspaceId: ws });
    const items = await getRunItems(run.runId, ws);

    const res = await reportOutcomes({
      runId: run.runId,
      workspaceId: ws,
      outcomes: [{ itemId: items[0]!.itemId, outcome: 'skipped', error: 'too late' }],
    });
    expect(res.refused?.reason).toBe('run_not_accepting_reports');
    expect((await getRunItems(run.runId, ws))[0]!.outcome).toBe('pending');
  });

  it('serializes Stop with terminal actions: the winner completes before the loser may proceed', async () => {
    const ws = `ws-authoritative-stop-${Date.now()}`;
    const [item] = seed('authority');
    const run = await createRun({ items: [item!], workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'running', workspaceId: ws });

    let releaseAction!: () => void;
    const actionMayFinish = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let markActionStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve;
    });

    // `audit` is REQUIRED (WI-41023): the audit write joins the action's
    // transaction so an unaudited `auto_resolved` cannot commit. Recording the
    // call here also pins WHEN it runs — inside the authority window, after the
    // action and before the outcome row.
    let auditedInsideAuthority = false;
    const action = executeBulkRunAction({
      runId: run.runId,
      itemId: item!.itemId,
      actionId: 'resolve',
      rationale: 'The owner gate is moot.',
      workspaceId: ws,
      execute: async () => {
        markActionStarted();
        await actionMayFinish;
        return { resolved: true };
      },
      audit: async () => {
        auditedInsideAuthority = true;
      },
    });
    await actionStarted;

    // Stop must queue behind the SAME run-row authority lock. Acknowledging it
    // while this callback is still in flight would recreate WI-41022: the owner
    // sees "stopped" and then the already-authorized action completes unseen.
    let stopAcknowledged = false;
    const stop = settleRunPhase({ runId: run.runId, workspaceId: ws }).then((result) => {
      stopAcknowledged = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopAcknowledged).toBe(false);

    releaseAction();
    const [acted, stopped] = await Promise.all([action, stop]);
    expect(acted.refused).toBeNull();
    expect(acted.actionResult).toEqual({ resolved: true });
    expect(stopped!.phase).toBe('complete');
    expect((await getRunItems(run.runId, ws))[0]).toMatchObject({
      outcome: 'auto_resolved',
      actionId: 'resolve',
      rationale: 'The owner gate is moot.',
    });
    // An `auto_resolved` row that committed without its audit having run is
    // precisely the WI-41023 defect.
    expect(auditedInsideAuthority).toBe(true);

    // The opposite ordering is the revocation guarantee: once Stop commits,
    // a later actor must be refused before its irreversible callback begins.
    const [lateItem] = seed('revoked');
    const lateRun = await createRun({ items: [lateItem!], workspaceId: ws });
    await setRunPhase({ runId: lateRun.runId, phase: 'running', workspaceId: ws });
    expect((await settleRunPhase({ runId: lateRun.runId, workspaceId: ws }))!.phase).toBe('review');

    let dispatchedAfterStop = false;
    let auditedAfterStop = false;
    const late = await executeBulkRunAction({
      runId: lateRun.runId,
      itemId: lateItem!.itemId,
      actionId: 'resolve',
      rationale: 'Must never execute.',
      workspaceId: ws,
      execute: async () => {
        dispatchedAfterStop = true;
        return { resolved: true };
      },
      audit: async () => {
        auditedAfterStop = true;
      },
    });
    expect(late.refused).toEqual({ reason: 'run_authority_revoked', phase: 'review' });
    expect(dispatchedAfterStop).toBe(false);
    // The refusal short-circuits BEFORE the audit too, so a revoked run leaves
    // no audit row for an action it never took — the audit trail must not imply
    // a resolution that did not happen.
    expect(auditedAfterStop).toBe(false);
    expect((await getRunItems(lateRun.runId, ws))[0]!.outcome).toBe('pending');
  });

  it('preserves a canonical terminal receipt when a stale report queues behind the action', async () => {
    const ws = `ws-stale-report-${Date.now()}`;
    const items = seed('stale-report');
    const resolverOwner = 'su-stale-report-resolver';
    const run = await createRun({ items, workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner, workspaceId: ws });

    let releaseAction!: () => void;
    const actionMayFinish = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let markActionStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve;
    });

    let auditCount = 0;
    let canonicalAudit: unknown;
    const action = executeBulkRunAction({
      runId: run.runId,
      itemId: items[0]!.itemId,
      actionId: 'resolve',
      rationale: 'Canonical action completed.',
      draftAnswer: 'The canonical drafted answer.',
      confidence: 'high',
      consulted: true,
      consultReply: 'The asking agent confirmed this action.',
      resolverOwner,
      workspaceId: ws,
      execute: async () => {
        markActionStarted();
        await actionMayFinish;
        return { resolved: true };
      },
      audit: async (tx) => {
        auditCount += 1;
        await upsertTriage({
          itemId: items[0]!.itemId,
          action: 'resolve',
          note: 'Bulk resolve: Canonical action completed.',
          triagedBy: resolverOwner,
          workspaceId: ws,
          sql: tx,
        });
        canonicalAudit = await tx`
          SELECT workspace_id, item_id, action, note, triaged_by, triaged_at
            FROM harness_shared.attention_triage
           WHERE workspace_id = ${ws} AND item_id = ${items[0]!.itemId}
        `;
      },
    });
    await actionStarted;

    let reportSettled = false;
    const staleReport = reportOutcomes({
      runId: run.runId,
      resolverOwner,
      workspaceId: ws,
      outcomes: [
        {
          itemId: items[0]!.itemId,
          outcome: 'recommended',
          actionId: 'retry',
          rationale: 'Recommendation from the pre-action manifest.',
        },
        {
          itemId: items[1]!.itemId,
          outcome: 'recommended',
          actionId: 'ack',
          rationale: 'This sibling still needs review.',
        },
      ],
    }).then((result) => {
      reportSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reportSettled).toBe(false);

    releaseAction();
    const [acted, reported] = await Promise.all([action, staleReport]);
    expect(acted.refused).toBeNull();
    expect(acted.item).toMatchObject({
      outcome: 'auto_resolved',
      actionId: 'resolve',
      rationale: 'Canonical action completed.',
    });
    expect(auditCount).toBe(1);
    expect(reported).toMatchObject({
      updated: [items[1]!.itemId],
      unknown: [],
      refused: null,
      run: { autoResolved: 1, recommended: 1 },
      preserved: [
        expect.objectContaining({
          itemId: items[0]!.itemId,
          outcome: 'auto_resolved',
          disposition: 'auto_resolved',
          actionId: 'resolve',
          rationale: 'Canonical action completed.',
          revertHandle: {
            kind: 'attention-bulk-item',
            version: 1,
            workspaceId: ws,
            runId: run.runId,
            itemId: items[0]!.itemId,
          },
        }),
      ],
    });

    const receipt = (reported as { preserved?: Array<{ decidedAt: string | null; reversalWindowUntil: string | null }> })
      .preserved?.[0];
    expect(Date.parse(receipt?.reversalWindowUntil ?? '')).toBeGreaterThan(
      Date.parse(receipt?.decidedAt ?? ''),
    );
    const rows = await getRunItems(run.runId, ws);
    expect(rows).toHaveLength(3);
    // Equality covers the entire receipt, including decision, consultation,
    // reversal and timestamp metadata that a stale report must never rewrite.
    expect(reported.preserved).toEqual([acted.item]);
    expect(rows.find((row) => row.itemId === items[0]!.itemId)).toEqual(acted.item);
    expect(rows.find((row) => row.itemId === items[0]!.itemId)).toMatchObject({
      outcome: 'auto_resolved',
      actionId: 'resolve',
      rationale: 'Canonical action completed.',
    });
    expect(rows.find((row) => row.itemId === items[1]!.itemId)).toMatchObject({
      outcome: 'recommended',
      actionId: 'ack',
    });
    expect(rows.find((row) => row.itemId === items[2]!.itemId)).toMatchObject({
      outcome: 'pending',
      actionId: null,
    });

    const triage = await readTriageByWorkspace(ws);
    expect([...triage.keys()]).toEqual([items[0]!.itemId]);
    expect(triage.get(items[0]!.itemId)).toMatchObject({
      action: 'resolve',
      note: 'Bulk resolve: Canonical action completed.',
      triagedBy: resolverOwner,
    });
    expect(await db.adminSql`
      SELECT workspace_id, item_id, action, note, triaged_by, triaged_at
        FROM harness_shared.attention_triage
       WHERE workspace_id = ${ws} AND item_id = ${items[0]!.itemId}
    `).toEqual(canonicalAudit);
  });

  it('preserves dismissal metadata while classifying a mixed report and deriving every counter', async () => {
    const ws = `ws-dismissed-stale-report-${Date.now()}`;
    const items = [...seed('dismissed-stale'), ...seed('mixed-report')];
    const run = await createRun({ items, workspaceId: ws });
    await reportOutcomes({
      runId: run.runId,
      workspaceId: ws,
      outcomes: [{
        itemId: items[0]!.itemId,
        outcome: 'recommended',
        actionId: 'resolve',
        rationale: 'Original recommendation.',
        draftAnswer: 'Original drafted answer.',
        confidence: 'high',
        consulted: true,
        consultReply: 'Original consultation reply.',
      }],
    });
    await unsafeSetRunPhaseForFixtures({ runId: run.runId, phase: 'review', workspaceId: ws });
    const dismissed = await markItemDismissed({
      runId: run.runId, itemId: items[0]!.itemId, workspaceId: ws,
      note: 'Owner declined the original recommendation.',
    });
    expect(dismissed).toMatchObject({ outcome: 'dismissed', consulted: true });
    // Exercise the accepting-reports boundary with an already dismissed row.
    await unsafeSetRunPhaseForFixtures({ runId: run.runId, phase: 'running', workspaceId: ws });
    const acted = await executeBulkRunAction({
      runId: run.runId, itemId: items[1]!.itemId, workspaceId: ws,
      actionId: 'resolve', rationale: 'Canonical sibling action.',
      execute: async () => ({ resolved: true }), audit: async () => {},
    });
    const report = await reportOutcomes({
      runId: run.runId,
      workspaceId: ws,
      outcomes: [
        { itemId: items[0]!.itemId, outcome: 'failed', error: 'Stale failure must not erase dismissal.' },
        { itemId: items[1]!.itemId, outcome: 'recommended', actionId: 'retry' },
        { itemId: items[2]!.itemId, outcome: 'recommended', actionId: 'ack' },
        { itemId: items[3]!.itemId, outcome: 'skipped', error: 'Not applicable.' },
        { itemId: items[4]!.itemId, outcome: 'failed', error: 'An ordinary report failure.' },
        { itemId: 'unknown-item', outcome: 'recommended' },
      ],
    });
    expect(report.updated).toEqual(items.slice(2, 5).map((item) => item.itemId));
    expect(report.unknown).toEqual(['unknown-item']);
    expect(report.preserved).toEqual([dismissed, acted.item]);
    const rows = await getRunItems(run.runId, ws);
    expect(rows.find((row) => row.itemId === items[0]!.itemId)).toEqual(dismissed);
    expect(rows.find((row) => row.itemId === items[1]!.itemId)).toEqual(acted.item);
    const tally = (outcome: string) => rows.filter((row) => row.outcome === outcome).length;
    expect(report.run).toMatchObject({
      autoResolved: tally('auto_resolved'),
      recommended: tally('recommended'),
      skipped: tally('skipped') + tally('dismissed'),
      failed: tally('failed'),
    });
    expect(report.run).toMatchObject({ autoResolved: 1, recommended: 1, skipped: 2, failed: 1 });
    expect(rows.find((row) => row.itemId === items[5]!.itemId)?.outcome).toBe('pending');
  });

  it('returns a canonical terminal receipt when a late report is refused after Stop', async () => {
    const ws = `ws-stopped-report-${Date.now()}`;
    const [item] = seed('stopped-report');
    const resolverOwner = 'su-stopped-report-resolver';
    const run = await createRun({ items: [item!], workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner, workspaceId: ws });

    await executeBulkRunAction({
      runId: run.runId,
      itemId: item!.itemId,
      actionId: 'resolve',
      rationale: 'Canonical action completed before Stop.',
      resolverOwner,
      workspaceId: ws,
      execute: async () => ({ resolved: true }),
      audit: async () => {},
    });
    await setRunPhase({ runId: run.runId, phase: 'review', resolverOwner, workspaceId: ws });

    const reported = await reportOutcomes({
      runId: run.runId,
      resolverOwner,
      workspaceId: ws,
      outcomes: [
        {
          itemId: item!.itemId,
          outcome: 'recommended',
          actionId: 'retry',
          rationale: 'Recommendation from the pre-action manifest.',
        },
      ],
    });

    expect(reported).toMatchObject({
      updated: [],
      unknown: [item!.itemId],
      refused: { reason: 'run_not_accepting_reports', phase: 'review' },
      preserved: [
        expect.objectContaining({
          itemId: item!.itemId,
          outcome: 'auto_resolved',
          disposition: 'auto_resolved',
          actionId: 'resolve',
          rationale: 'Canonical action completed before Stop.',
          revertHandle: {
            kind: 'attention-bulk-item',
            version: 1,
            workspaceId: ws,
            runId: run.runId,
            itemId: item!.itemId,
          },
        }),
      ],
    });
    expect((await getRunItems(run.runId, ws))[0]).toMatchObject({
      outcome: 'auto_resolved',
      actionId: 'resolve',
      rationale: 'Canonical action completed before Stop.',
    });
  });

  it('persists a typed bounded handle and appends one compensation without rewriting the action audit', async () => {
    const ws = `ws-reversal-${Date.now()}`;
    const [item] = seed('reversal');
    const run = await createRun({ items: [item!], workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'running', workspaceId: ws });

    await executeBulkRunAction({
      runId: run.runId,
      itemId: item!.itemId,
      actionId: 'resolve',
      rationale: 'The escalation was stale.',
      workspaceId: ws,
      execute: async () => ({ resolved: true }),
      audit: async () => {},
    });

    const applied = (await getRunItems(run.runId, ws))[0]!;
    expect(applied).toMatchObject({
      outcome: 'auto_resolved',
      actionId: 'resolve',
      rationale: 'The escalation was stale.',
      revertedAt: null,
      revertNote: null,
      revertHandle: {
        kind: 'attention-bulk-item',
        version: 1,
        workspaceId: ws,
        runId: run.runId,
        itemId: item!.itemId,
      },
    });
    expect(Date.parse(applied.reversalWindowUntil!)).toBeGreaterThan(Date.parse(applied.decidedAt!));

    const compensationCalls: string[] = [];
    const reverted = await executeBulkRunItemReversal({
      runId: run.runId,
      itemId: item!.itemId,
      workspaceId: ws,
      execute: async (lockedItem) => {
        compensationCalls.push(lockedItem.itemId);
        return { result: { reopened: true }, note: 'reopened the original escalation' };
      },
    });
    expect(reverted.refused).toBeNull();
    expect(reverted.result).toEqual({ reopened: true });
    expect(reverted.item).toMatchObject({
      // The decision is immutable; compensation is appended alongside it.
      outcome: 'auto_resolved',
      actionId: 'resolve',
      rationale: 'The escalation was stale.',
      revertNote: 'reopened the original escalation',
    });
    expect(reverted.item!.revertedAt).toBeTruthy();

    const duplicate = await executeBulkRunItemReversal({
      runId: run.runId,
      itemId: item!.itemId,
      workspaceId: ws,
      execute: async () => {
        compensationCalls.push('duplicate');
        return { result: null, note: 'must not run' };
      },
    });
    expect(duplicate.refused).toBe('already_reverted');
    expect(compensationCalls).toEqual([item!.itemId]);
  });

  it('uses the database deadline and refuses expired compensation before entering the callback', async () => {
    const ws = `ws-reversal-expired-${Date.now()}`;
    const [item] = seed('reversal-expired');
    const run = await createRun({ items: [item!], workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'running', workspaceId: ws });
    await executeBulkRunAction({
      runId: run.runId,
      itemId: item!.itemId,
      actionId: 'resolve',
      rationale: 'Applied for deadline test.',
      workspaceId: ws,
      execute: async () => ({ resolved: true }),
      audit: async () => {},
    });
    await (h.sql as typeof db.adminSql)`
      UPDATE harness_shared.attention_bulk_run_items
         SET decided_at = now() - interval '2 hours',
             reversal_window_until = now() - interval '1 hour'
       WHERE workspace_id = ${ws}
         AND run_id = ${run.runId}
         AND item_id = ${item!.itemId}`;

    const execute = vi.fn(async () => ({ result: null, note: 'must not run' }));
    const result = await executeBulkRunItemReversal({
      runId: run.runId,
      itemId: item!.itemId,
      workspaceId: ws,
      execute,
    });
    expect(result.refused).toBe('window_expired');
    expect(execute).not.toHaveBeenCalled();
  });

  // P-007. The properties here are the ones that fail SILENTLY: a heartbeat that
  // keeps writing after the owner pressed Stop, a restart that quietly re-opens
  // items the previous resolver already finished, or one that widens the run past
  // what the owner saw. Each test below is paired with the control that would pass
  // if the guard were absent.
  describe('P-007 — resolver heartbeat, derived staleness, safe restart', () => {
    const ws = () => h.ws as string;
    const age = async (runId: string, interval: string) =>
      (h.sql as typeof db.adminSql)`
        UPDATE harness_shared.attention_bulk_runs
           SET heartbeat_at = now() - ${interval}::interval
         WHERE workspace_id = ${ws()} AND run_id = ${runId}`;

    it('records a heartbeat on an executing run and exposes it on the row', async () => {
      const run = await createRun({ items: seed('hb'), runId: `hb-${Date.now()}` });
      expect(run.heartbeatAt).toBeNull(); // a fresh run has NEVER reported

      const beat = await recordRunHeartbeat({ runId: run.runId, resolverOwner: 'su-resolver' });
      expect(beat).not.toBeNull();
      expect(beat!.heartbeatAt).not.toBeNull();
      expect(beat!.resolverOwner).toBe('su-resolver');
      // and it is durable, not just returned
      expect((await getRun(run.runId, ws()))!.heartbeatAt).not.toBeNull();
    });

    it('REFUSES a heartbeat once the run is no longer executing — a late beat cannot resurrect it', async () => {
      const run = await createRun({ items: seed('hb-late'), runId: `hb-late-${Date.now()}` });
      // CONTROL: while executing, the same call succeeds.
      expect(await recordRunHeartbeat({ runId: run.runId })).not.toBeNull();

      await setRunPhase({ runId: run.runId, phase: 'review' });
      expect(await recordRunHeartbeat({ runId: run.runId })).toBeNull();
      await unsafeSetRunPhaseForFixtures({ runId: run.runId, phase: 'complete' });
      expect(await recordRunHeartbeat({ runId: run.runId })).toBeNull();
    });

    it('derives liveness from the heartbeat, and from the START time when nothing has beaten yet', () => {
      const t0 = Date.parse('2026-08-24T12:00:00.000Z');
      const at = (ms: number) => new Date(t0 + ms).toISOString();
      const base = { phase: 'running' as const, startedAt: at(0), createdAt: at(0) };

      // never reported: measured from the start, so a just-launched run is LIVE …
      expect(classifyRunLiveness({ ...base, heartbeatAt: null }, t0 + 1_000)).toMatchObject({
        state: 'live',
      });
      // … and one that never beat at all eventually goes stale, measured from start.
      expect(classifyRunLiveness({ ...base, heartbeatAt: null }, t0 + RUN_HEARTBEAT_STALE_MS + 1_000)).toMatchObject({
        state: 'stale',
        measuredFrom: 'start',
      });

      // reported recently → live; reported long ago → stale, measured from the beat.
      expect(classifyRunLiveness({ ...base, heartbeatAt: at(60_000) }, t0 + 61_000)).toMatchObject({ state: 'live' });
      expect(classifyRunLiveness({ ...base, heartbeatAt: at(0) }, t0 + RUN_HEARTBEAT_STALE_MS + 1_000)).toMatchObject({
        state: 'stale',
        measuredFrom: 'heartbeat',
      });

      // a run that is not executing is not a liveness question at all
      expect(classifyRunLiveness({ ...base, phase: 'review', heartbeatAt: null }, t0 + 10 ** 9)).toMatchObject({
        state: 'not-executing',
        phase: 'review',
      });
    });

    it('REFUSES to restart a HEALTHY executing run — restarting one would race a live resolver', async () => {
      const run = await createRun({ items: seed('rs-live'), runId: `rs-live-${Date.now()}` });
      await recordRunHeartbeat({ runId: run.runId });

      const refused = await restartRun({ runId: run.runId });
      expect(refused).toEqual({ ok: false, reason: 'not_restartable', phase: 'pending' });
      // and nothing moved
      expect((await getRun(run.runId, ws()))!.heartbeatAt).not.toBeNull();
    });

    it.each(['pending', 'running', 'failed'] as const)(
      'gives a restarted %s run a fresh grace period before its first heartbeat',
      async (phase) => {
        const run = await createRun({ items: seed(`rs-grace-${phase}`) });
        await unsafeSetRunPhaseForFixtures({ runId: run.runId, phase });
        await (h.sql as typeof db.adminSql)`
          UPDATE harness_shared.attention_bulk_runs
             SET created_at = now() - interval '2 hours',
                 started_at = now() - interval '1 hour',
                 heartbeat_at = now() - interval '1 hour'
           WHERE workspace_id = ${ws()} AND run_id = ${run.runId}`;
        const oldRun = (await getRun(run.runId, ws()))!;
        if (phase !== 'failed') {
          expect(classifyRunLiveness(oldRun)).toMatchObject({ state: 'stale' });
        }

        const restarted = await restartRun({ runId: run.runId, resolverOwner: 'su-fresh' });
        expect(restarted.ok).toBe(true);
        if (!restarted.ok) return;
        expect(restarted.run.heartbeatAt).toBeNull();
        expect(restarted.run.createdAt).toBe(oldRun.createdAt);
        expect(restarted.run.startedAt).not.toBe(oldRun.startedAt);
        expect(classifyRunLiveness(restarted.run)).toMatchObject({ state: 'live' });

        // The SQL restart guard and watchdog classifier must agree: a second
        // restart cannot rotate the new owner during startup, even before a beat.
        expect(await restartRun({ runId: run.runId, resolverOwner: 'su-racer' })).toEqual({
          ok: false,
          reason: 'not_restartable',
          phase: 'pending',
        });
        const running = await setRunPhase({
          runId: run.runId,
          phase: 'running',
          resolverOwner: 'su-fresh',
        });
        expect(running!.startedAt).toBe(restarted.run.startedAt);
        expect(classifyRunLiveness(running!)).toMatchObject({ state: 'live' });
      },
    );

    it('restarts a STALE executing run, preserving completed outcomes and NOT widening membership', async () => {
      const run = await createRun({ items: seed('rs-stale'), runId: `rs-stale-${Date.now()}` });
      await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-dead' });
      await reportOutcomes({
        runId: run.runId,
        outcomes: [
          {
            itemId: 'coord-escalation:rs-stale-1',
            outcome: 'auto_resolved',
            actionId: 'quarantine',
            rationale: 'finished before the resolver died',
            confidence: 'high',
          },
        ],
      });
      await age(run.runId, '1 hour');

      const res = await restartRun({ runId: run.runId, resolverOwner: 'su-fresh' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // handed to a new resolver, with liveness reset so it must prove itself again
      expect(res.run.phase).toBe('pending');
      expect(res.run.resolverOwner).toBe('su-fresh');
      expect(res.run.heartbeatAt).toBeNull();
      expect(res.run.error).toBeNull();

      // THE GUARANTEE: the finished item is still finished, and still counted.
      const items = await getRunItems(run.runId, ws());
      expect(items).toHaveLength(3); // membership NOT widened
      const done = items.find((i) => i.itemId === 'coord-escalation:rs-stale-1')!;
      expect(done.outcome).toBe('auto_resolved');
      expect(done.actionId).toBe('quarantine');
      expect(res.run.autoResolved).toBe(1);
      expect(res.preservedOutcomes).toBe(1);
      expect(items.filter((i) => i.outcome === 'pending')).toHaveLength(2);
    });

    it('rejects every prior-owner write after restart rotates the resolver owner', async () => {
      const run = await createRun({ items: seed('rs-owner'), runId: `rs-owner-${Date.now()}` });
      await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-prior' });
      expect(
        await failRunIfExecuting({
          runId: run.runId,
          resolverOwner: 'su-prior',
          error: 'prior resolver exited',
        }),
      ).toMatchObject({ phase: 'failed', resolverOwner: 'su-prior' });

      const restarted = await restartRun({ runId: run.runId, resolverOwner: 'su-replacement' });
      expect(restarted.ok).toBe(true);
      if (!restarted.ok) return;
      expect(restarted.run).toMatchObject({ phase: 'pending', resolverOwner: 'su-replacement' });

      const execute = vi.fn(async () => ({ resolved: true }));
      const audit = vi.fn(async () => undefined);
      const action = await executeBulkRunAction({
        runId: run.runId,
        itemId: 'coord-escalation:rs-owner-1',
        actionId: 'resolve',
        rationale: 'stale resolver must not act',
        resolverOwner: 'su-prior',
        execute,
        audit,
      });
      expect(action.refused).toEqual({ reason: 'resolver_owner_mismatch', phase: 'pending' });
      expect(execute).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();

      const report = await reportOutcomes({
        runId: run.runId,
        resolverOwner: 'su-prior',
        outcomes: [
          {
            itemId: 'coord-escalation:rs-owner-1',
            outcome: 'auto_resolved',
            actionId: 'resolve',
          },
        ],
      });
      expect(report.refused).toEqual({ reason: 'resolver_owner_mismatch', phase: 'pending' });
      expect(report.updated).toEqual([]);
      expect(await recordRunHeartbeat({ runId: run.runId, resolverOwner: 'su-prior' })).toBeNull();
      expect(
        await failRunIfExecuting({
          runId: run.runId,
          resolverOwner: 'su-prior',
          error: 'late prior-owner exit observer',
        }),
      ).toBeNull();
      expect(await settleRunPhase({ runId: run.runId, resolverOwner: 'su-prior' })).toBeNull();

      const unchanged = await getRun(run.runId, ws());
      expect(unchanged).toMatchObject({ phase: 'pending', resolverOwner: 'su-replacement' });
      expect(unchanged!.heartbeatAt).toBeNull();
      expect((await getRunItems(run.runId, ws())).every((item) => item.outcome === 'pending')).toBe(true);

      // CONTROL: the replacement owner can still advance the same row.
      expect(await recordRunHeartbeat({ runId: run.runId, resolverOwner: 'su-replacement' })).toMatchObject({
        resolverOwner: 'su-replacement',
      });
    });

    it('restarts a FAILED run and reuses its click-time launch snapshot rather than current defaults', async () => {
      const run = await createRun({
        items: seed('rs-failed'),
        runId: `rs-failed-${Date.now()}`,
        launchSnapshot: { model: 'opus' },
      });
      await failRunIfExecuting({ runId: run.runId, error: 'resolver exited 137' });
      expect((await getRun(run.runId, ws()))!.phase).toBe('failed');

      const res = await restartRun({ runId: run.runId, resolverOwner: 'su-fresh' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.run.phase).toBe('pending');
      expect(res.run.error).toBeNull();
      // D-003: the restart must relaunch with what the OWNER chose, not today's default.
      expect(res.run.launchSnapshot.model).toBe('opus');
    });

    it('distinguishes an unknown run from one it refused, so a diagnostic cannot report a live run as missing', async () => {
      const run = await createRun({ items: seed('rs-404'), runId: `rs-404-${Date.now()}` });
      await recordRunHeartbeat({ runId: run.runId });

      expect(await restartRun({ runId: 'no-such-run' })).toEqual({
        ok: false,
        reason: 'run_not_found',
        phase: null,
      });
      expect(await restartRun({ runId: run.runId })).toEqual({
        ok: false,
        reason: 'not_restartable',
        phase: 'pending',
      });
    });
  });
});
