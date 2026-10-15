/**
 * turn-end-tracking-io.test.ts — unit coverage for `checkpointOnRelease`
 * (EI-18734870651452334).
 *
 * Bug: a work-item claim released with NO agent-written checkpoint (compaction,
 * a dead-session force-release, the stale-claim reaper backstop) is
 * indistinguishable from never-started work — the next claimant can silently
 * rebuild an already-shipped feature. The P-015 turn-end sweep already
 * mechanically checkpoints STALE held items, but only at turn end; this closes
 * the gap at the RELEASE seam itself, which is where the actual loss happens.
 *
 * These tests exercise the function in isolation (deps mocked) — the wiring
 * into `releaseWorkItem` is fire-and-forget by design (never blocks/fails the
 * release), so it is proven here at the unit level rather than via a timing-
 * dependent integration assertion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const getWorkItemCheckpointWithMeta = vi.fn();
const setWorkItemCheckpointWithPrior = vi.fn();
const readHeldWorkItems = vi.fn();
const toolCallRowsFor = vi.fn();
const renderToolCallLog = vi.fn();
const applySessionTaskOp = vi.fn();
// An owner with no attached PUI conversation keeps its own task list (D-019).
const taskSessionIdForOwner = vi.fn(async (_sql: unknown, _workspaceId: string, ownerId: string) => ownerId);
const getLoopStatus = vi.fn();
const listActiveAwaits = vi.fn();
const recentTurnJournal = vi.fn();
const wakeRecipients = vi.fn();
const sql = vi.fn();
const reportDisabled = vi.fn();
const captureObservation = vi.fn();
vi.mock('./agent-tools/reports/_shared', () => ({ reportsLibraryDisabled: (...a: unknown[]) => reportDisabled(...a) }));
vi.mock('./harness/improvements/capture-core', () => ({ captureImprovement: (...a: unknown[]) => captureObservation(...a) }));

vi.mock('./work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...a: unknown[]) => getWorkItemCheckpointWithMeta(...a),
  setWorkItemCheckpointWithPrior: (...a: unknown[]) => setWorkItemCheckpointWithPrior(...a),
}));
vi.mock('./carry-brief', () => ({ readHeldWorkItems: (...a: unknown[]) => readHeldWorkItems(...a) }));
vi.mock('./tool-call-log-store', () => ({
  toolCallRowsFor: (...a: unknown[]) => toolCallRowsFor(...a),
}));
vi.mock('./tool-call-log', () => ({
  renderToolCallLog: (...a: unknown[]) => renderToolCallLog(...a),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));
vi.mock('./session-tasks', () => ({
  applySessionTaskOp: (...a: unknown[]) => applySessionTaskOp(...a),
  taskSessionIdForOwner: (...a: [unknown, string, string]) => taskSessionIdForOwner(...a),
}));
vi.mock('./harness/routines/loop', () => ({
  getLoopStatus: (...a: unknown[]) => getLoopStatus(...a),
}));
vi.mock('./events/await/store', () => ({
  INBOX_WAKE_KEY_PREFIX: 'coord:inbox-wake:',
  listActiveAwaits: (...a: unknown[]) => listActiveAwaits(...a),
}));
vi.mock('./turn-journal-store', () => ({
  recentTurnJournal: (...a: unknown[]) => recentTurnJournal(...a),
}));
vi.mock('./agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: (...a: unknown[]) => wakeRecipients(...a),
}));

const { autoCheckpointStaleHeldItems, checkpointOnRelease, sweepOpenTaskReminder, wakeOpenTaskReminder, observeUnpublishedReportTurn } = await import('./turn-end-tracking-io');

const REF = { releasingOwnerId: 'su-holder-1', workspaceId: 'ws-1', harness: 'papercusp', workItemId: 'WI-1' };

afterEach(() => {
  vi.clearAllMocks();
});

describe('Reports turn-end observation IO', () => {
  const input = { workspaceId: 'ws-1', ownerId: 'writer', sessionId: 'session-1', sinceIso: '2026-10-07T00:00:00Z',
    turnRef: 'session-1:turn-4', assistantText: '## Findings\n' + 'Measured finding. '.repeat(35) + '\n## Verdict\nThe audit is complete.' };
  it('files an observation with a stable source key for an unpublished fixture', async () => {
    reportDisabled.mockResolvedValue(null); sql.mockResolvedValue([]); captureObservation.mockResolvedValue({ created: true });
    expect(await observeUnpublishedReportTurn(input)).toBe(true);
    expect(captureObservation.mock.calls[0][0]).toMatchObject({ lane: 'observation', initialState: 'done', createdBy: 'writer' });
    expect(captureObservation.mock.calls[0][0].body).toContain(input.turnRef);
    await observeUnpublishedReportTurn(input);
    expect(captureObservation.mock.calls[1][0].watchdogKey).toBe(captureObservation.mock.calls[0][0].watchdogKey);
  });
  it('does not file when the author published, the flag is off or the turn is ordinary progress', async () => {
    reportDisabled.mockResolvedValue(null); sql.mockResolvedValue([{ report_id: 'rpt_saved' }]);
    expect(await observeUnpublishedReportTurn(input)).toBe(false);
    reportDisabled.mockResolvedValue({ ok: false });
    expect(await observeUnpublishedReportTurn(input)).toBe(false);
    expect(await observeUnpublishedReportTurn({ ...input, assistantText: 'Still verifying.' })).toBe(false);
    expect(captureObservation).not.toHaveBeenCalled();
  });
});

describe('checkpointOnRelease (EI-18734870651452334)', () => {
  it('is a no-op when a real agent-written checkpoint already exists — never overwrites it', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({
      checkpoint: 'I already wrote real progress here',
      updatedAtMs: Date.now(),
    });

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: false });
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
  });

  it('writes a mechanical checkpoint when the checkpoint is missing (null)', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    toolCallRowsFor.mockResolvedValue([{ tool: 'Edit' }]);
    renderToolCallLog.mockReturnValue('Edit x3, Bash x1');
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'written', priorLength: 0 });

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: true });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
    const [ref, block] = setWorkItemCheckpointWithPrior.mock.calls[0] as [typeof REF, string];
    expect(ref).toEqual({ harness: REF.harness, workItemId: REF.workItemId, workspaceId: REF.workspaceId });
    expect(block).toContain('auto-checkpoint mechanical');
    expect(block).toContain(REF.releasingOwnerId);
    expect(block).toContain('EI-18734870651452334');
    expect(block).toContain('Edit x3, Bash x1');
  });

  it('writes a mechanical checkpoint when the checkpoint is present but blank/whitespace', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: '   ', updatedAtMs: Date.now() });
    toolCallRowsFor.mockResolvedValue([]);
    renderToolCallLog.mockReturnValue('');
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'written', priorLength: 0 });

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: true });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('still writes the mechanical checkpoint (journal note alone) when the tool-log fetch throws', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    toolCallRowsFor.mockRejectedValue(new Error('ledger unavailable'));
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'written', priorLength: 0 });

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: true });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
    const [, block] = setWorkItemCheckpointWithPrior.mock.calls[0] as [typeof REF, string];
    expect(block).toContain('EI-18734870651452334');
  });

  it('fails soft (never throws, returns written:false) when reading the existing checkpoint throws', async () => {
    getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('db down'));

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: false });
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
  });

  it('fails soft (never throws, returns written:false) when the checkpoint write itself throws', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    toolCallRowsFor.mockResolvedValue([]);
    renderToolCallLog.mockReturnValue('');
    setWorkItemCheckpointWithPrior.mockRejectedValue(new Error('write failed'));

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: false });
  });

  it('preserves a checkpoint authored after the missing-checkpoint read', async () => {
    const authored = '## Did\nThe holder checkpointed before the release snapshot committed.';
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    toolCallRowsFor.mockResolvedValue([]);
    setWorkItemCheckpointWithPrior.mockImplementation(async (_ref, _note, opts) => {
      const blockedReason = opts.guard(authored, authored.length);
      return { stored: authored, priorLength: authored.length, blockedReason };
    });

    expect(await checkpointOnRelease(REF)).toEqual({ written: false });
    await expect(setWorkItemCheckpointWithPrior.mock.results[0].value).resolves.toMatchObject({
      stored: authored, blockedReason: 'checkpoint-written-before-release-snapshot',
    });
  });
});

describe('automatic stale-held checkpoint preservation (EI-25379632433059487)', () => {
  const nowMs = 1_784_000_000_000;
  const input = { ownerId: 'su-holder-1', workspaceId: 'ws-1', sessionId: 'session-1',
    sinceIso: '2026-07-14T18:00:00Z', journalNote: 'Holder-session activity.', nowMs };
  const ref = { harness: 'papercusp', id: 'WI-1', checkpointUpdatedAtMs: 1 };
  type WriteOptions = NonNullable<Parameters<typeof import('./work-item-checkpoint').setWorkItemCheckpointWithPrior>[2]>;

  function lockedStore(initial: string | null) {
    const state = { note: initial };
    setWorkItemCheckpointWithPrior.mockImplementation(async (_ref, note: string | null | undefined, opts: WriteOptions) => {
      const priorLength = state.note?.length ?? 0;
      const blockedReason = opts.guard?.(state.note, priorLength);
      if (blockedReason) return { stored: state.note, priorLength, blockedReason };
      state.note = (opts.transform ? opts.transform(state.note, note) : note) ?? null;
      return { stored: state.note, priorLength };
    });
    toolCallRowsFor.mockResolvedValue([]);
    renderToolCallLog.mockReturnValue('');
    return state;
  }

  it('keeps the three-check ledger and walls through successive locked snapshots', async () => {
    const { splitCarryNoteChecks, splitCarryNoteWalls, withCarryNoteChecks, withCarryNoteWalls } = await import('./carry-note');
    const initial = withCarryNoteWalls(withCarryNoteChecks('## Did\nAuthored progress.', [
      { id: 'check-a', claim: 'Spill evidence.', sinceMs: 1, verified: 'Saved fixture.' },
      { id: 'check-b', claim: 'Quota evidence.', sinceMs: 2, falsifier: 'Repeated scan.' },
      { id: 'check-c', claim: 'Diagnostic evidence.', sinceMs: 3, observed: 'Original diagnostic retained.' },
    ]), [{ id: 'custody', claim: 'Keep source custody.', sinceMs: 4 }]);
    const state = lockedStore(initial);
    readHeldWorkItems.mockImplementation(async () => [{ ...ref, checkpoint: state.note }]);

    expect(await autoCheckpointStaleHeldItems(input)).toEqual([{ id: ref.id, mechanical: true }]);
    expect(await autoCheckpointStaleHeldItems({ ...input, journalNote: 'Later activity.' }))
      .toEqual([{ id: ref.id, mechanical: true }]);
    expect(splitCarryNoteChecks(state.note!).checks).toEqual(splitCarryNoteChecks(initial).checks);
    expect(splitCarryNoteWalls(state.note!).walls).toEqual(splitCarryNoteWalls(initial).walls);
    expect(state.note).toContain('Authored progress.');
    expect(state.note).toContain('Later activity.');
    expect(state.note).not.toContain('Holder-session activity.');
  });

  it.each([null, '## Did\nOld stale progress.'])('skips a snapshot when newer authored evidence replaces %s during tool-log IO', async (stale) => {
    const { withCarryNoteChecks } = await import('./carry-note');
    const state = lockedStore(stale);
    const authored = withCarryNoteChecks('## Did\nNew authored progress.', [
      { id: 'new-evidence', claim: 'The latest probe passed.', sinceMs: 2, verified: 'New proof.' },
    ]);
    readHeldWorkItems.mockResolvedValue([{ ...ref, checkpoint: stale }]);
    toolCallRowsFor.mockImplementation(async () => { state.note = authored; return []; });

    expect(await autoCheckpointStaleHeldItems(input)).toEqual([]);
    expect(state.note).toBe(authored);
  });

  it('reports only committed snapshots when the store refuses an older write', async () => {
    readHeldWorkItems.mockResolvedValue([{ ...ref, checkpoint: null }]);
    toolCallRowsFor.mockResolvedValue([]);
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'Newer progress.', priorLength: 15,
      blockedReason: 'stale_write_older_than_current' });

    expect(await autoCheckpointStaleHeldItems(input)).toEqual([]);
  });
});

describe('open-task reminder IO (P-005)', () => {
  const activeTask = {
    id: 'task-a',
    content: 'Finish implementation',
    activeForm: 'Finishing implementation',
    status: 'in_progress',
    blockerRef: null,
    explanation: null,
    position: 0,
    createdAt: '2026-08-26T20:00:00.000Z',
    updatedAt: '2026-08-26T20:00:00.000Z',
    links: [],
  };

  it('reads owner-keyed canonical tasks and the prior journal attempt', async () => {
    applySessionTaskOp.mockResolvedValue({
      op: 'view',
      changedTaskId: null,
      tasks: [activeTask],
      links: [],
    });
    getLoopStatus.mockResolvedValue({ active: false });
    listActiveAwaits.mockResolvedValue([]);
    recentTurnJournal.mockResolvedValue([]);

    const first = await sweepOpenTaskReminder({
      ownerId: 'su-owner-1',
      workspaceId: 'ws-1',
    });

    expect(applySessionTaskOp).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        op: 'view',
        workspaceId: 'ws-1',
        sessionId: 'su-owner-1',
      }),
    );
    expect(first?.tripwire.attempt).toBe(1);

    recentTurnJournal.mockResolvedValue([{ tripwire: first?.tripwire }]);
    const second = await sweepOpenTaskReminder({
      ownerId: 'su-owner-1',
      workspaceId: 'ws-1',
    });
    expect(second?.tripwire.attempt).toBe(2);
  });

  it('reads the attached PUI conversation list for an SU owner bound to one (D-019)', async () => {
    taskSessionIdForOwner.mockResolvedValueOnce('chat-pui-1');
    applySessionTaskOp.mockResolvedValue({ op: 'view', changedTaskId: null, tasks: [activeTask], links: [] });
    getLoopStatus.mockResolvedValue({ active: false });
    listActiveAwaits.mockResolvedValue([]);
    recentTurnJournal.mockResolvedValue([]);

    expect(await sweepOpenTaskReminder({ ownerId: 'su-attached-1', workspaceId: 'ws-1' })).not.toBeNull();
    expect(taskSessionIdForOwner).toHaveBeenCalledWith(sql, 'ws-1', 'su-attached-1');
    expect(applySessionTaskOp).toHaveBeenCalledWith(sql, expect.objectContaining({ sessionId: 'chat-pui-1' }));
  });

  it('suppresses when a loop or bounded await already guarantees continuation', async () => {
    applySessionTaskOp.mockResolvedValue({
      op: 'view',
      changedTaskId: null,
      tasks: [activeTask],
      links: [],
    });
    recentTurnJournal.mockResolvedValue([]);
    listActiveAwaits.mockResolvedValue([]);
    getLoopStatus.mockResolvedValue({ active: true });
    expect(await sweepOpenTaskReminder({ ownerId: 'su-1', workspaceId: 'ws-1' })).toBeNull();

    getLoopStatus.mockResolvedValue({ active: false });
    listActiveAwaits.mockResolvedValue([
      {
        eventKey: 'work-item:done:WI-1',
        expiresTs: '2026-08-26T21:00:00.000Z',
        timeoutBehavior: 'wake',
      },
    ]);
    expect(await sweepOpenTaskReminder({ ownerId: 'su-1', workspaceId: 'ws-1' })).toBeNull();

    listActiveAwaits.mockResolvedValue([]);
    expect(await sweepOpenTaskReminder({ ownerId: 'su-1', workspaceId: 'ws-1' })).not.toBeNull();
  });

  it('targets the owner with the persisted decision prompt', async () => {
    wakeRecipients.mockResolvedValue({ woken: 1 });
    const decision = {
      prompt: '⟦open-task-reminder 1/3⟧ Continue the task.',
      tasks: [activeTask],
      tripwire: {
        kind: 'open-task-reminder' as const,
        note: 'continue',
        signature: 'abc',
        attempt: 1,
        maxAttempts: 3,
        taskCount: 1,
        taskIds: ['task-a'],
      },
    };

    await expect(
      wakeOpenTaskReminder({
        ownerId: 'su-owner-1',
        workspaceId: 'ws-1',
        decision,
      }),
    ).resolves.toBe(true);
    expect(wakeRecipients).toHaveBeenCalledWith(['su-owner-1'], {
      summary: decision.prompt,
      payload: decision.tripwire,
      source: 'turn-end-open-task-reminder',
      workspaceId: 'ws-1',
    });
  });

  it('reports false when the wake key has no queued recipient', async () => {
    wakeRecipients.mockResolvedValue({ woken: 0 });
    const decision = {
      prompt: '⟦open-task-reminder 1/3⟧ Continue the task.',
      tasks: [activeTask],
      tripwire: {
        kind: 'open-task-reminder' as const,
        note: 'continue',
        signature: 'abc',
        attempt: 1,
        maxAttempts: 3,
        taskCount: 1,
        taskIds: ['task-a'],
      },
    };

    await expect(
      wakeOpenTaskReminder({
        ownerId: 'su-owner-1',
        workspaceId: 'ws-1',
        decision,
      }),
    ).resolves.toBe(false);
  });
});
