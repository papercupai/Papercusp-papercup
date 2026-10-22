/** The existing journal endpoint must actually invoke the native-policy producer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  record: vi.fn(async () => ({ recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded' })),
  persist: vi.fn(async () => ({ status: 'completed', recorded: true, elapsedMs: 12 })),
  path: vi.fn(async (): Promise<string | null> => '/native/session'),
  turn: vi.fn(async (): Promise<{ text: string; ts: Date } | null> => null),
  extract: vi.fn(() => null as null | { note: string; source: string; flagged: boolean }),
  latest: vi.fn(async () => null),
  ledger: vi.fn(async () => []),
  journal: vi.fn(async () => ({ id: 'journal-row', deduped: false })),
  observeReport: vi.fn(async () => false),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'holder', workspaceId: 'workspace' }), requireWorkspaceId: () => 'workspace',
}));
vi.mock('../../goal-placement-turn-receipts', () => ({
  boundedRecordGoalPlacementTurnEnd: h.record,
  boundedRecordGoalPlacementTurnEndOutcome: h.persist,
}));
vi.mock('../../turn-journal', () => ({
  resolveTranscriptPath: h.path, readLastAssistantTurn: h.turn,
  extractJournalFromAssistantText: h.extract, detectClaimLedgerMismatch: vi.fn(),
}));
vi.mock('../../turn-journal-store', () => ({
  latestJournalCreatedAt: h.latest, ledgerEntriesSince: h.ledger, recordTurnJournal: h.journal,
}));
vi.mock('../../turn-provenance/turn-ref', () => ({ resolveCurrentTurnStamp: vi.fn(async () => null) }));
vi.mock('../../turn-end-tracking-io', () => ({
  boundedArtifactSweep: vi.fn(async () => null),
  boundedOpenTaskReminderSweep: vi.fn(async () => null),
  boundedUnguardedHaltSweep: vi.fn(async () => null),
  boundedAutoCheckpoint: vi.fn(async () => []),
  boundedUnpublishedReportTurn: h.observeReport,
  boundedCoordWatermarkSettle: vi.fn(async () => null),
}));
vi.mock('../../session-cursor-io', () => ({ boundedBuildAndPersistCursor: vi.fn(async () => false) }));
import tool from './record-turn';

/** Narrow a tool result union to its `data` payload; a result without one fails the test. */
function responseData(result: object): unknown {
  if (!('data' in result)) throw new Error('tool result carried no data payload');
  return result.data;
}

beforeEach(() => {
  h.record.mockReset().mockResolvedValue({ recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded' });
  h.persist.mockReset().mockResolvedValue({ status: 'completed', recorded: true, elapsedMs: 12 });
  h.path.mockReset().mockResolvedValue('/native/session');
  h.turn.mockReset().mockResolvedValue(null);
  h.extract.mockReset().mockReturnValue(null);
  h.latest.mockReset().mockResolvedValue(null);
  h.ledger.mockReset().mockResolvedValue([]);
  h.journal.mockReset().mockResolvedValue({ id: 'journal-row', deduped: false });
  h.observeReport.mockReset().mockResolvedValue(false);
});
describe('journal native placement seam', () => {
  it('samples before journal prose extraction and does not require a journal note', async () => {
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { reason: 'no_assistant_turn', goalPlacementTurnEnd: {
      recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded',
    } } });
    expect(h.record).toHaveBeenCalledExactlyOnceWith({ ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'native', sourceKind: 'codex' });
  });
  it('returns and durably records a native-session-mismatch outcome', async () => {
    h.record.mockResolvedValueOnce({ recorded: false, reason: 'native-session-mismatch' });
    const input = { ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'native', sourceKind: 'codex' };
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { reason: 'no_assistant_turn', goalPlacementTurnEnd: {
      recorded: false, reason: 'native-session-mismatch',
    } } });
    expect(h.persist).toHaveBeenCalledExactlyOnceWith(input, { recorded: false, reason: 'native-session-mismatch' });
  });
  it('preserves turn-end diagnostics through the journal outcome-writer seam', async () => {
    const input = { ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'native', sourceKind: 'codex' };
    const outcome = {
      recorded: false,
      reason: 'turn-end-read-unavailable',
      diagnostics: { boundary: 'timeout' as const, elapsedMs: 3_500, activeStage: 'current-session', stages: [] },
    };
    h.record.mockResolvedValueOnce(outcome);
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { goalPlacementTurnEnd: { ...outcome,
      outcomeAppendTiming: { status: 'completed', recorded: true, elapsedMs: 12 },
    } } });
    expect(h.persist).toHaveBeenCalledExactlyOnceWith(input, outcome);
  });
  it('returns but does not diagnose the no-canonical-goal outcome', async () => {
    h.record.mockResolvedValueOnce({ recorded: false, reason: 'no-canonical-goal' });
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { goalPlacementTurnEnd: {
      recorded: false, reason: 'no-canonical-goal',
    } } });
    expect(h.persist).not.toHaveBeenCalled();
  });
  it('includes the native outcome on the no-note response branch', async () => {
    h.turn.mockResolvedValueOnce({ text: 'assistant response', ts: new Date('2026-10-01T00:00:00.000Z') });
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { reason: 'no_note', goalPlacementTurnEnd: {
      recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded',
    } } });
  });
  it('includes the native outcome on a recorded journal response', async () => {
    h.turn.mockResolvedValueOnce({ text: 'assistant response', ts: new Date('2026-10-01T00:00:00.000Z') });
    h.extract.mockReturnValueOnce({ note: 'journal note', source: 'agent', flagged: false });
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(result).toMatchObject({ data: { ok: true, id: 'journal-row', goalPlacementTurnEnd: {
      recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded',
    } } });
  });
  it('does not use a cross-owner journal write as opportunity evidence', async () => {
    const result = await tool.handler({ owner: 'another-owner', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(h.record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: { reason: 'no_assistant_turn', goalPlacementTurnEnd: null } });
  });
  it('returns the recorded turn while report observation remains pending', async () => {
    h.turn.mockResolvedValueOnce({ text: '## Findings\nUnpublished report.', ts: new Date('2026-10-01T00:00:00.000Z') });
    h.extract.mockReturnValueOnce({ note: 'journal note', source: 'agent', flagged: false });
    h.observeReport.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never),
        new Promise<{ data: { error: string } }>(resolve => {
          deadline = setTimeout(() => resolve({ data: { error: 'pending report detector delayed the journal response' } }), 250);
        }),
      ]);
      expect(result).toMatchObject({ data: { ok: true, unpublishedReportObservationScheduled: true } });
      expect(responseData(result)).not.toHaveProperty('unpublishedReportObserved');
      expect(h.observeReport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        ownerId: 'holder', workspaceId: 'workspace', assistantText: '## Findings\nUnpublished report.',
      }));
    } finally {
      clearTimeout(deadline);
    }
  }, 1000);
  it("does not persist the operator '*' auto-scope as report observation harness attribution", async () => {
    h.turn.mockResolvedValueOnce({ text: 'Unpublished report.', ts: new Date('2026-10-01T00:00:00.000Z') });
    h.extract.mockReturnValueOnce({ note: 'journal note', source: 'agent', flagged: false });
    const result = await tool.handler(
      { owner: 'holder', session_id: 'native', source_kind: 'codex' },
      { harnessSlug: '*' } as never,
    );
    expect(result).toMatchObject({ data: { ok: true, unpublishedReportObservationScheduled: true } });
    // The observation input types harnessSlug as `string | undefined` (absent = workspace scope),
    // so the '*' auto-scope must resolve to an explicit undefined, never a concrete harness.
    expect(h.observeReport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harnessSlug: undefined }));
  });
  it('isolates a report observer error from journal success', async () => {
    h.turn.mockResolvedValueOnce({ text: 'Unpublished report.', ts: new Date('2026-10-01T00:00:00.000Z') });
    h.extract.mockReturnValueOnce({ note: 'journal note', source: 'agent', flagged: false });
    h.observeReport.mockImplementationOnce(() => { throw new Error('observer unavailable'); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
      expect(result).toMatchObject({ data: { ok: true, id: 'journal-row' } });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('observer unavailable'));
    } finally { warning.mockRestore(); }
  });
  it('does not schedule a second observation for a deduped journal turn', async () => {
    h.turn.mockResolvedValueOnce({ text: 'Unpublished report.', ts: new Date('2026-10-01T00:00:00.000Z') });
    h.extract.mockReturnValueOnce({ note: 'journal note', source: 'agent', flagged: false });
    h.journal.mockResolvedValueOnce({ id: 'journal-row', deduped: true });
    const result = await tool.handler({ owner: 'holder', session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(responseData(result)).not.toHaveProperty('unpublishedReportObservationScheduled');
    expect(h.observeReport).not.toHaveBeenCalled();
  });
  it('returns the native outcome even when journal transcript discovery fails', async () => {
    h.path.mockResolvedValue(null);
    const result = await tool.handler({ session_id: 'native', source_kind: 'codex' }, {} as never);
    expect(h.record).toHaveBeenCalledExactlyOnceWith({ ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'native', sourceKind: 'codex' });
    expect(result).toMatchObject({ data: { reason: 'transcript_not_found', goalPlacementTurnEnd: {
      recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded',
    } } });
  });
});
