import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCarryNoteChecks, withCarryNoteWalls, splitCarryNoteChecks, splitCarryNoteWalls } from './carry-note';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), get: vi.fn(), set: vi.fn(), log: vi.fn() }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));
vi.mock('./work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: mocks.get,
  setWorkItemCheckpointWithPrior: mocks.set,
}));
vi.mock('./tool-call-log-store', () => ({ toolCallRowsFor: mocks.log }));
vi.mock('./tool-call-log', () => ({ renderToolCallLog: () => 'Edit feature.ts; test:file feature.test.ts passed' }));
vi.mock('./flush-refusal-marker', () => ({
  clearRefused: vi.fn(), wasRecentlyRefused: vi.fn(() => false), markRefused: vi.fn(),
  __resetRefusalMarkers: vi.fn(), REFUSAL_MARKER_TTL_MS: 600_000,
}));
import { readHeldWorkItems, CARRY_BRIEF_MAX_HELD_ITEMS } from './carry-brief';
import { autoCheckpointStaleHeldItems } from './turn-end-tracking-io';
import { runFlushGate } from './enforcement-gate-io';

const nowMs = 1_792_095_000_000;
const input = { ownerId: 'su-respawn', workspaceId: 'papercusp-workspace', sessionId: 'session-current',
  sinceIso: new Date(nowMs - 60_000).toISOString(), journalNote: null, nowMs };
const notes = new Map<string, string | null>();
type SnapshotOptions = NonNullable<Parameters<typeof import('./work-item-checkpoint').setWorkItemCheckpointWithPrior>[2]>;

beforeEach(() => {
  vi.clearAllMocks();
  notes.clear();
  // readHeldWorkItems splices its issue-family kind list via sql.unsafe(...) (carry-brief.ts),
  // so the fake client must expose it; the fragment value is opaque to this fake's row builder.
  Object.assign(mocks.sql, { unsafe: (fragment: string) => fragment });
  mocks.sql.mockImplementation(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const rows = Array.from(notes.keys(), (id) => ({ issue_id: id, title: id, body: '', scope: 'harness:papercusp',
      taken_by: input.ownerId, workspace_id: input.workspaceId,
      source_plan_slug: 'paperwork', source_plan_item_ids: ['P-013'] }));
    const limit = values.at(-1) as number | null;
    return limit === null ? rows : rows.slice(0, limit);
  });
  mocks.get.mockImplementation(async ({ workItemId }: { workItemId: string }) => ({
    checkpoint: notes.get(workItemId) ?? null, updatedAtMs: nowMs,
  }));
  mocks.log.mockResolvedValue([]);
  mocks.set.mockImplementation(async ({ workItemId }: { workItemId: string }, note: string | null | undefined, opts: SnapshotOptions) => {
    const prior = notes.get(workItemId) ?? null;
    const priorLength = prior?.length ?? 0;
    const blockedReason = opts.guard?.(prior, priorLength);
    if (blockedReason) return { stored: prior, priorLength, blockedReason };
    const stored = opts.transform ? opts.transform(prior, note) : note ?? null;
    notes.set(workItemId, stored ?? null);
    return { stored, priorLength };
  });
});
afterEach(() => { delete process.env.PAPERCUSP_FLUSH_GATE; vi.restoreAllMocks(); });

describe('host mechanical carry-respawn checkpoint (R-13)', () => {
  it('saves all 13 held items, including fresh ones outside both preview caps, without agent bookkeeping', async () => {
    for (let i = 1; i <= 13; i++) notes.set(`WI-${i}`, `Judgment ${i}: keep the chosen route.`);
    const out = await runFlushGate({ ...input, boundary: 'compaction', mode: 'host-snapshot', brief: null });
    expect(out.verdict).toBe('mechanical-fallback');
    expect(out.fallback?.checkpointedItems).toEqual([...notes.keys()]);
    expect(mocks.sql.mock.calls[0]!.at(-1)).toBeNull(); // real reader's SQL LIMIT NULL, not the six-item preview
    for (const [id, note] of notes) {
      expect(note).toContain(`Judgment ${id.slice(3)}: keep the chosen route.`);
      expect(note).toContain('system respawn snapshot');
      expect(note).toContain(`work-item: ${id}; harness: papercusp`);
      expect(note).toContain(`holder: ${input.ownerId}`);
      expect(note).toContain(`session: ${input.sessionId}`);
      expect(note).toContain('plan: paperwork; items: P-013');
      expect(note).toContain('test:file feature.test.ts passed');
    }
  });

  it('keeps the ordinary carry reader preview bounded', async () => {
    for (let i = 1; i <= 13; i++) notes.set(`WI-${i}`, null);
    expect(await readHeldWorkItems(input.ownerId, input.workspaceId)).toHaveLength(CARRY_BRIEF_MAX_HELD_ITEMS);
    expect(await readHeldWorkItems(input.ownerId, input.workspaceId, { limit: null })).toHaveLength(13);
  });

  it('preserves judgment, check identities and owner-gated walls through repeated snapshots', async () => {
    const authored = withCarryNoteWalls(withCarryNoteChecks('Judgment: do not change route.', [
      { id: 'test-proof', claim: 'Focused tests passed.', verified: 'Native suite log', sinceMs: 1 },
    ]), [{ id: 'publish', claim: 'Owner approval required to publish.', sinceMs: 2 }]);
    notes.set('WI-1', authored);
    await autoCheckpointStaleHeldItems({ ...input, mode: 'respawn' });
    await autoCheckpointStaleHeldItems({ ...input, mode: 'respawn', nowMs: nowMs + 1 });
    const saved = notes.get('WI-1')!;
    expect(saved).toContain('Judgment: do not change route.');
    expect(splitCarryNoteChecks(saved).checks).toEqual(splitCarryNoteChecks(authored).checks);
    expect(splitCarryNoteWalls(saved).walls).toEqual(splitCarryNoteWalls(authored).walls);
    expect(saved.match(/auto-checkpoint mechanical/g)).toHaveLength(1);
  });

  it('reuses the supplied carry snapshot and writes advisory checkpoints concurrently', async () => {
    const heldItems = [
      { id: 'WI-1', title: 'one', body: '', harness: 'papercusp', checkpoint: null, checkpointUpdatedAtMs: null },
      { id: 'WI-2', title: 'two', body: '', harness: 'papercusp', checkpoint: null, checkpointUpdatedAtMs: null },
    ] as const;
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.set.mockImplementation(async ({ workItemId }: { workItemId: string }, _note: string | null | undefined, opts: SnapshotOptions) => {
      started.push(workItemId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      const prior = notes.get(workItemId) ?? null;
      const stored = opts.transform ? opts.transform(prior, _note) : _note ?? null;
      notes.set(workItemId, stored ?? null);
      return { stored, priorLength: prior?.length ?? 0 };
    });
    const pending = autoCheckpointStaleHeldItems({ ...input, heldItems });
    try {
      await vi.waitFor(() => expect(started).toEqual(['WI-1', 'WI-2']));
      expect(maxActive).toBe(2);
      expect(mocks.sql).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    await expect(pending).resolves.toEqual([
      { id: 'WI-1', mechanical: true },
      { id: 'WI-2', mechanical: true },
    ]);
  });

  it('merges into the locked current row when an authored note changes during tool-log IO', async () => {
    notes.set('WI-1', 'Old judgment.');
    mocks.log.mockImplementation(async () => { notes.set('WI-1', 'New judgment: keep the wall.'); return []; });
    expect(await autoCheckpointStaleHeldItems({ ...input, mode: 'respawn' })).toHaveLength(1);
    expect(notes.get('WI-1')).toContain('New judgment: keep the wall.');
    expect(notes.get('WI-1')).not.toContain('Old judgment.');
  });

  it.each(['off', 'on'])('refuses an incomplete host save with the advisory flush ladder %s', async (enabled) => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PAPERCUSP_FLUSH_GATE = enabled;
    notes.set('WI-1', 'Judgment.');
    mocks.set.mockRejectedValueOnce(new Error('persistence unavailable'));
    const out = await runFlushGate({ ...input, boundary: 'compaction', mode: 'host-snapshot', brief: null });
    expect(out.verdict).toBe('refuse');
    expect(out.snapshotFailure).toMatchObject({
      phase: 'checkpoint-write', code: 'checkpoint-write-failed', elapsedMs: expect.any(Number),
      checkpointStage: 'write-item', workItemId: 'WI-1', completedWorkItemIds: [],
      errorFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
    });
    expect(out.refusalText).toContain('checkpoint-write-failed');
    expect(out.refusalText).toContain('session remains intact');
    expect(out.refusalText).not.toContain('work_items:checkpoint');
    expect(log).toHaveBeenCalledWith(expect.stringContaining(out.snapshotFailure!.errorFingerprint!));
  });

  it('preserves a locked-store refusal code and affected item context', async () => {
    notes.set('WI-1', null);
    mocks.set.mockResolvedValueOnce({ stored: null, priorLength: 0, blockedReason: 'write_refused' });

    const out = await runFlushGate({ ...input, boundary: 'compaction', mode: 'host-snapshot', brief: null });

    expect(out.verdict).toBe('refuse');
    expect(out.snapshotFailure).toEqual({
      phase: 'checkpoint-write',
      code: 'checkpoint-write-blocked',
      workItemId: 'WI-1',
      blockedReason: 'write_refused',
      elapsedMs: expect.any(Number),
    });
    expect(out.refusalText).toContain('WI-1');
    expect(out.refusalText).toContain('write_refused');
    expect(out.refusalText).not.toContain('Error(');
  });

  it('attributes a storage exception after a partial save without exposing its secret message', async () => {
    notes.set('WI-1', 'First judgment.');
    notes.set('WI-2', 'Second judgment.');
    const writer = mocks.set.getMockImplementation()!;
    mocks.set.mockImplementationOnce(writer).mockRejectedValueOnce(Object.assign(
      new Error('connection postgresql://fixture:never-emit@invalid/database failed'), { code: '08006' }));
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await runFlushGate({ ...input, boundary: 'compaction', mode: 'host-snapshot', brief: null });
      expect(out.verdict).toBe('refuse');
      expect(out.snapshotFailure).toMatchObject({ code: '08006', checkpointStage: 'write-item',
        workItemId: 'WI-2', completedWorkItemIds: ['WI-1'], errorFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/) });
      expect(notes.get('WI-1')).toContain('system respawn snapshot');
      expect(notes.get('WI-2')).toBe('Second judgment.');
      expect(JSON.stringify(out)).not.toContain('never-emit');
      expect(JSON.stringify(log.mock.calls)).not.toContain('never-emit');
      expect(JSON.stringify(log.mock.calls)).toContain(out.snapshotFailure!.errorFingerprint);
    } finally { log.mockRestore(); }
  });

  it('distinguishes a held-item read failure from an item write failure', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.sql.mockRejectedValueOnce(Object.assign(new Error('read unavailable'), { code: '57014' }));
    const out = await runFlushGate({ ...input, boundary: 'compaction', mode: 'host-snapshot', brief: null });
    expect(out.verdict).toBe('refuse');
    expect(out.snapshotFailure).toMatchObject({ code: '57014', checkpointStage: 'read-held-items', completedWorkItemIds: [] });
    expect(out.snapshotFailure).not.toHaveProperty('workItemId');
    expect(mocks.set).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('read-held-items'));
  });

  it('does not silently claim success for a blocked checkpoint write', async () => {
    notes.set('WI-1', null);
    mocks.set.mockResolvedValueOnce({ stored: null, priorLength: 0, blockedReason: 'write_refused' });
    await expect(autoCheckpointStaleHeldItems({ ...input, mode: 'respawn' })).rejects.toThrow('WI-1: write_refused');
  });
});
