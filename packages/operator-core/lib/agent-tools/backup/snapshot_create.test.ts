/**
 * snapshot_create.test.ts — the backup:snapshot_create HANDLER's deadline race
 * (EI-18875467740392530: this tool ALWAYS reported a bare 60s dispatch-stack
 * timeout on this workspace while the underlying kopia snapshot succeeded
 * 2.5-10+ minutes later — the opposite of the truth, on the designated
 * pre-destructive safety rail). Pins the fix: `wb.snapshot()` is raced against
 * SAFE_DEADLINE_MS; when it wins, the handler returns the real result; when the
 * deadline wins, the handler returns `{ stillRunning: true, snapshotId }` using
 * the id `onStarted` already delivered — never an opaque timeout that reads as
 * "no snapshot exists".
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/backup/snapshot_create.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ snapshot: vi.fn(), reconcileSnapshotReceipt: vi.fn() }));
vi.mock('../../backup', () => ({
  workspaceBackupFor: vi.fn(() => ({
    snapshot: h.snapshot,
    reconcileSnapshotReceipt: h.reconcileSnapshotReceipt,
  })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../dbos/dbos-flags', () => ({ dbosBackupActive: vi.fn(() => false) }));
vi.mock('../../dbos/bootstrap', () => ({ dbosStarted: vi.fn(() => false) }));

const { workspaceBackupFor } = await import('../../backup');
const forM = vi.mocked(workspaceBackupFor);
const mod = await import('./snapshot_create');
const tool = mod.default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = { reason: 'manual' }) =>
  tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backup:snapshot_create handler — deadline race', () => {
  it('reconciles an exact prior receipt without starting a second snapshot', async () => {
    h.reconcileSnapshotReceipt.mockResolvedValue({
      snapshotId: 99,
      reconciled: true,
      stillRunning: false,
      status: 'ok',
      kopiaSnapshotId: 'kopia-recovered',
    });

    const out = await call({ reason: 'pre_destructive', resumeSnapshotId: 99 });

    expect(h.reconcileSnapshotReceipt).toHaveBeenCalledWith(99);
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(body(out)).toMatchObject({
      snapshotId: 99,
      reconciled: true,
      kopiaSnapshotId: 'kopia-recovered',
    });
  });

  it('returns the real result when the snapshot finishes before the deadline', async () => {
    h.snapshot.mockImplementation(async (_reason, _ctx, opts) => {
      opts?.onStarted?.(11);
      return { snapshotId: 11, kopiaSnapshotId: 'kopia-fast', bytesAdded: 5, durationMs: 20 };
    });

    const out = await call();
    expect(forM).toHaveBeenCalledWith('ws-1');
    expect(body(out)).toEqual({ snapshotId: 11, kopiaSnapshotId: 'kopia-fast', bytesAdded: 5, durationMs: 20 });
  });

  it('requires an exact receipt for producer resume', async () => {
    await expect(call({ reason: 'pre_destructive', resumeProducer: true })).rejects.toThrow('requires resumeSnapshotId');
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('re-drives only the requested existing receipt when explicitly requested', async () => {
    h.reconcileSnapshotReceipt.mockResolvedValue({ snapshotId: 99, stillRunning: true, status: 'running' });
    h.snapshot.mockResolvedValue({ snapshotId: 99, kopiaSnapshotId: 'recovered', dbDumpOk: true });
    const out = await call({ reason: 'pre_destructive', resumeSnapshotId: 99, resumeProducer: true });
    expect(h.snapshot).toHaveBeenCalledWith('pre_destructive', undefined,
      expect.objectContaining({ resumeSnapshotId: 99, onStarted: expect.any(Function) }));
    expect(body(out)).toMatchObject({ snapshotId: 99, kopiaSnapshotId: 'recovered', dbDumpOk: true });
  });

  it('does not restart an already terminal receipt even with producer resume requested', async () => {
    const receipt = { snapshotId: 99, stillRunning: false, status: 'ok', kopiaSnapshotId: 'existing', dbDumpOk: true };
    h.reconcileSnapshotReceipt.mockResolvedValue(receipt);
    expect(body(await call({ reason: 'pre_destructive', resumeSnapshotId: 99, resumeProducer: true }))).toEqual(receipt);
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('returns stillRunning + the durable snapshotId (never a bare timeout) when the snapshot outlives the deadline', async () => {
    vi.useFakeTimers();
    let releaseSnapshot!: (v: unknown) => void;
    const held = new Promise((resolve) => { releaseSnapshot = resolve; });
    h.snapshot.mockImplementation(async (_reason, _ctx, opts) => {
      opts?.onStarted?.(99); // the durable row exists long before kopia finishes
      return held; // never resolves within this test — simulates the real multi-minute run
    });

    const outPromise = call();
    // Let the onStarted callback + the race setup run, then cross the deadline.
    await vi.advanceTimersByTimeAsync(mod.SAFE_DEADLINE_MS);
    const out = await outPromise;

    expect(body(out)).toEqual({
      stillRunning: true,
      snapshotId: 99,
      note: expect.stringContaining('Poll backup:snapshot_list'),
    });

    // Clean up the still-pending background promise so it doesn't leak into
    // the next test (its own .catch inside the handler already covers a real
    // rejection; here we just let it settle harmlessly).
    releaseSnapshot({ snapshotId: 99, kopiaSnapshotId: 'kopia-late', bytesAdded: 1, durationMs: 999 });
  });

  it('reports snapshotId: null on timeout if onStarted has not fired yet (row insert itself still pending)', async () => {
    vi.useFakeTimers();
    let releaseSnapshot!: (v: unknown) => void;
    const held = new Promise((resolve) => { releaseSnapshot = resolve; });
    // Deliberately never call onStarted before the deadline fires.
    h.snapshot.mockImplementation(async () => held);

    const outPromise = call();
    await vi.advanceTimersByTimeAsync(mod.SAFE_DEADLINE_MS);
    const out = await outPromise;

    expect(body(out)).toMatchObject({ stillRunning: true, snapshotId: null });
    releaseSnapshot({ snapshotId: 1, kopiaSnapshotId: 'k', bytesAdded: 0, durationMs: 1 });
  });
});
