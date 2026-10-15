/**
 * pipeline-events.test.ts — pure unit coverage for the window-fold logic (mig 177) and
 * the EI-18676650746298156 candidate-prefix matcher. The append/summarize/recent/
 * findGreenCheckpointVerdictForCandidate DB round-trip is covered in
 * pipeline-events.integration.test.ts (real Postgres).
 */
import { describe, expect, it } from 'vitest';
import { foldPipelineWindow, emptyWindow, candidatePrefixMatches, readGatePipelineWindow } from './pipeline-events';

describe('readGatePipelineWindow — complete historical population', () => {
  const target = { workspaceId: 'ws', installSlug: 'install' };
  const window = { windowStartMs: 100, windowEndMs: 200, nonTerminalStatuses: ['decision-pending'] };
  const row = { id: '1', kind: 'green_checkpoint', status: 'advanced', detail: { gateFireId: 'fire' },
    created_at: new Date(150), population_count: '1' };
  const sql = (rows: unknown[]) => (async () => rows) as unknown as import('postgres').Sql;

  it('distinguishes an empty successful read from a failed read', async () => {
    expect(await readGatePipelineWindow(target, window, sql([])))
      .toMatchObject({ status: 'complete', total: 0, rows: [] });
    const failed = (async () => { throw new Error('read failed'); }) as unknown as import('postgres').Sql;
    expect(await readGatePipelineWindow(target, window, failed))
      .toMatchObject({ status: 'unavailable', total: null, rows: [], reason: 'read failed' });
  });

  it('returns explicit incomplete coverage when the exact population is capped', async () => {
    expect(await readGatePipelineWindow(target, { ...window, maxRows: 1 },
      sql([{ ...row, population_count: 2 }, { ...row, id: '2', population_count: 2 }])))
      .toMatchObject({ status: 'capped', total: 2, rows: [expect.objectContaining({ id: '1' })] });
  });

  it.each(['not-a-count', '0', '2'])('rejects an inconsistent population count %s', async (population_count) => {
    expect((await readGatePipelineWindow(target, window, sql([{ ...row, population_count }]))).status)
      .toBe('unavailable');
  });

  it('keeps source detail and exact event timestamp', async () => {
    expect(await readGatePipelineWindow(target, window, sql([row])))
      .toMatchObject({ status: 'complete', total: 1,
        rows: [{ id: '1', createdAtMs: 150, detail: { gateFireId: 'fire' } }] });
  });

  it('refuses invalid scope/windows before querying', async () => {
    let calls = 0;
    const query = (async () => { calls++; return []; }) as unknown as import('postgres').Sql;
    expect((await readGatePipelineWindow(target, { ...window, windowEndMs: 100 }, query)).status).toBe('invalid');
    expect((await readGatePipelineWindow({ ...target, workspaceId: '' }, window, query)).status).toBe('invalid');
    expect(calls).toBe(0);
  });
});

describe('foldPipelineWindow', () => {
  it('folds (kind,status,count) rows into the typed per-kind summary', () => {
    const w = foldPipelineWindow(
      [
        { kind: 'git_sync', status: 'synced', n: 100 },
        { kind: 'git_sync', status: 'nothing', n: 40 },
        { kind: 'git_sync', status: 'conflict', n: 3 },
        { kind: 'git_sync', status: 'error', n: 1 },
        { kind: 'merge_resolver', status: 'ok', n: 2 },
        { kind: 'merge_resolver', status: 'failed', n: 1 },
        { kind: 'green_checkpoint', status: 'advanced', n: 5 },
        { kind: 'green_checkpoint', status: 'up-to-date', n: 18 },
        { kind: 'green_checkpoint', status: 'not-green', n: 2 },
      ],
      1000,
    );
    expect(w.sinceMs).toBe(1000);
    expect(w.gitSync).toEqual({ total: 144, synced: 100, nothing: 40, conflict: 3, error: 1 });
    expect(w.mergeResolver).toEqual({ total: 3, ok: 2, failed: 1, error: 0 });
    expect(w.greenCheckpoint).toMatchObject({ total: 25, advanced: 5, upToDate: 18, notGreen: 2 });
  });

  it('counts unknown statuses toward the kind total but not a named bucket', () => {
    const w = foldPipelineWindow([{ kind: 'git_sync', status: 'weird-future-status', n: 7 }], 0);
    expect(w.gitSync.total).toBe(7);
    expect(w.gitSync.synced + w.gitSync.nothing + w.gitSync.conflict + w.gitSync.error).toBe(0);
  });

  /**
   * EI-20702428259478130. The green_checkpoint fold is TOTAL, unlike the other kinds:
   * every produced status lands in exactly one bucket. The list below is not invented —
   * it is the full DISTINCT status set measured on harness_shared.pipeline_events over
   * 30d (2026-08-17), with that query's real counts. Before this, five of these ten had
   * no bucket, so 1205/9783 events (12.3%) incremented `total` and no sub-counter.
   */
  const GREEN_CHECKPOINT_STATUSES_30D: Array<[string, number]> = [
    ['up-to-date', 7254],
    ['not-green', 964],
    ['skipped-disabled', 850],
    ['advanced', 360],
    ['skipped-locked', 176],
    ['error', 152],
    ['advanced-prefix', 13],
    ['migrations-pending', 8],
    ['desktop-perf-held', 5],
    ['release-fixer-skipped-stale', 1],
  ];

  it('buckets every green_checkpoint status: total always equals the sum of the parts', () => {
    const w = foldPipelineWindow(
      GREEN_CHECKPOINT_STATUSES_30D.map(([status, n]) => ({ kind: 'green_checkpoint', status, n })),
      0,
    );
    const g = w.greenCheckpoint;
    expect(g.total).toBe(9783);
    // The invariant. A new status with no bucket breaks THIS line, not a dashboard.
    expect(
      g.advanced +
        g.upToDate +
        g.advancedPrefix +
        g.notGreen +
        g.notFastForward +
        g.createFailed +
        g.error +
        g.skipped +
        g.other,
    ).toBe(g.total);
    expect(g).toEqual({
      total: 9783,
      advanced: 360,
      upToDate: 7254,
      notGreen: 964,
      notFastForward: 0,
      createFailed: 0,
      advancedPrefix: 13,
      error: 152,
      skipped: 1026, // skipped-disabled 850 + skipped-locked 176, matched by prefix
      other: 14, // migrations-pending 8 + desktop-perf-held 5 + release-fixer-skipped-stale 1
    });
  });

  it('keeps an infra death out of the green count and visible as `error`', () => {
    // The regression that made this item: a gate that DIED on every tick. `error` used to
    // fall through every bucket, so the readout divided 0 greens by 0 judged ticks and the
    // Git tab rendered "main-green rate —/100%" instead of a gate that never once ran.
    const w = foldPipelineWindow([{ kind: 'green_checkpoint', status: 'error', n: 24 }], 0);
    expect(w.greenCheckpoint.error).toBe(24);
    expect(w.greenCheckpoint.total).toBe(24);
    expect(w.greenCheckpoint.advanced + w.greenCheckpoint.upToDate + w.greenCheckpoint.advancedPrefix).toBe(0);
    expect(w.greenCheckpoint.other).toBe(0); // named, not swept into the remainder
  });

  it('counts a partial advance as its own green rather than dropping it', () => {
    // advanced-prefix DID move `main` (WI-38218). It had no bucket, so a successful prefix
    // promotion was invisible in the rollup — the same drift, on the green side.
    const w = foldPipelineWindow([{ kind: 'green_checkpoint', status: 'advanced-prefix', n: 3 }], 0);
    expect(w.greenCheckpoint.advancedPrefix).toBe(3);
    expect(w.greenCheckpoint.advanced).toBe(0); // distinct from a full advance
    expect(w.greenCheckpoint.other).toBe(0);
  });

  it('sweeps an unrecognised green_checkpoint status into `other`, never into silence', () => {
    const w = foldPipelineWindow([{ kind: 'green_checkpoint', status: 'some-status-added-later', n: 5 }], 0);
    expect(w.greenCheckpoint.other).toBe(5);
    expect(w.greenCheckpoint.total).toBe(5);
  });

  it('coerces string counts (postgres count(*) can arrive as text) and ignores unknown kinds', () => {
    const w = foldPipelineWindow(
      [
        { kind: 'git_sync', status: 'synced', n: '12' },
        { kind: 'totally-unknown-kind', status: 'ok', n: 9 }, // ignored entirely
      ],
      0,
    );
    expect(w.gitSync.synced).toBe(12);
    expect(w.gitSync.total).toBe(12);
    expect(w.deploy.total).toBe(0);
  });

  it('folds auto-serve deploy attempts (ok / rolled-back / failed / refused)', () => {
    const w = foldPipelineWindow(
      [
        { kind: 'deploy', status: 'ok', n: 5 },
        { kind: 'deploy', status: 'rolled-back', n: 1 },
        { kind: 'deploy', status: 'failed', n: 1 },
        { kind: 'deploy', status: 'refused', n: 2 },
      ],
      0,
    );
    expect(w.deploy).toEqual({
      total: 9,
      ok: 5,
      rolledBack: 1,
      failed: 1,
      refused: 2,
      coalesced: 0,
      staleLockReclaimed: 0,
      other: 0,
    });
  });

  it('EI-18835078701597295: the deploy chain is TOTAL — every produced status lands in a bucket', () => {
    // The statuses below are all REAL production emitters that previously landed in NO
    // bucket: coalesced (deploy-cli), stale-lock-reclaimed (deploy-deps), and
    // certification-* (release-actions). The sub-buckets silently undercounted against
    // `total` and a reader diffing them saw an unnamed gap — the same defect
    // EI-20702428259478130 fixed for greenCheckpoint (12.3% of events unbucketed).
    const w = foldPipelineWindow(
      [
        { kind: 'deploy', status: 'ok', n: 2 },
        { kind: 'deploy', status: 'coalesced', n: 4 },
        { kind: 'deploy', status: 'stale-lock-reclaimed', n: 1 },
        { kind: 'deploy', status: 'certification-launched', n: 3 },
        { kind: 'deploy', status: 'a-status-invented-next-year', n: 7 },
      ],
      0,
    );
    expect(w.deploy.coalesced).toBe(4);
    expect(w.deploy.staleLockReclaimed).toBe(1);
    expect(w.deploy.other).toBe(10); // certification-launched + the unknown future status
    const { total, ...buckets } = w.deploy;
    expect(Object.values(buckets).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('emptyWindow is all zeros', () => {
    const w = emptyWindow(42);
    expect(w.sinceMs).toBe(42);
    expect(w.gitSync.total).toBe(0);
    expect(w.mergeResolver.total).toBe(0);
    expect(w.greenCheckpoint.total).toBe(0);
  });
});

// EI-18676650746298156: checkpoint:await's candidateSha already-judged latch matches on
// this function alone — buildCheckpointDetail truncates the WRITTEN `detail.candidate` to
// 12 chars, and a caller's candidateSha can be anywhere from 4 to 64 chars, so the matcher
// must work correctly regardless of which side is shorter.
describe('candidatePrefixMatches — prefix-safe candidate-sha comparison', () => {
  it('matches a full 40-char sha against its own 12-char stored (truncated) prefix', () => {
    const full = '94c1234567890abcdef1234567890abcdef12345';
    const stored = full.slice(0, 12);
    expect(candidatePrefixMatches(full, stored)).toBe(true);
  });

  it('matches a short caller-supplied prefix (4 chars, the arg floor) against a longer stored value', () => {
    expect(candidatePrefixMatches('94c1', '94c1234567')).toBe(true);
  });

  it('matches two equal-length values', () => {
    expect(candidatePrefixMatches('94c1234567', '94c1234567')).toBe(true);
  });

  it('rejects genuinely different candidates even when both are 12 chars', () => {
    expect(candidatePrefixMatches('94c1234567ab', 'ffffffffffff')).toBe(false);
  });

  it('rejects a same-length near-miss (differs only in the last char)', () => {
    expect(candidatePrefixMatches('94c1234567ab', '94c1234567ac')).toBe(false);
  });

  it('WI-5685 shape: a DIFFERENT (later) candidate that happens to share a short prefix is not conflated once the overlap is long enough to disambiguate', () => {
    // Two distinct real commits that happen to share their first 4 hex chars but diverge
    // after that — the exact scenario the 4-char floor exists to still get right once the
    // compared prefix is long enough to tell them apart.
    expect(candidatePrefixMatches('94c1aaaaaaaa', '94c1bbbbbbbb')).toBe(false);
  });

  it('refuses to match below the 4-char floor — never risk a false positive on a coincidental short overlap', () => {
    expect(candidatePrefixMatches('94c', '94c')).toBe(false);
    expect(candidatePrefixMatches('9', '9')).toBe(false);
  });

  it('rejects empty/missing values on either side', () => {
    expect(candidatePrefixMatches('', 'anything')).toBe(false);
    expect(candidatePrefixMatches('anything', '')).toBe(false);
    expect(candidatePrefixMatches('', '')).toBe(false);
  });
});
