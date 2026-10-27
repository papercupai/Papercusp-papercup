import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePureProofCaptureArchive, type PureProofCaptureArchive } from
  '@papercusp/operator-core/lib/release/test-pass-reuse-report';

import {
  PURE_PROOF_CAPTURE_HARD_GRACE_MS,
  SELF_WATCHDOG_MS,
  createNormalCheckpointFinalizer,
  archivePureProofCapture,
  readGatePromotionDecision,
  stampGatePromotion,
  runPostVerdictPureProofCapture,
} from './green-checkpoint';

/**
 * gate-test-reuse-yield-2026-10-01 P-006 (D-005 §1): the CLI runs the pure-lane proof capture
 * AFTER the verdict is recorded and before the run lock is released. This wrapper must never cost
 * the run anything: it honours the kill switch without touching the watchdog, cancels the
 * self-watchdog only when capture really runs (its fire path would record a second, emergency
 * verdict), carries the phase's knobs past the gate env allowlist, swallows a capture failure, and
 * stops waiting at a hard deadline.
 */

const cfg = {
  checkpointRoot: '/ck/root',
  checkpointLogDir: '/ck/logs',
  greenCheckpointCapacityMode: 'shared' as const,
};
const KEYS = ['PC_PURE_PROOF_CAPTURE', 'PC_PURE_PROOF_CAPTURE_BUDGET_MS', 'PC_PURE_PROOF_CAPTURE_SLICE'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CLI normal finalization and pure-proof capture', () => {
  const result = { green: true, candidate: 'a'.repeat(40) } as Parameters<
    ReturnType<typeof createNormalCheckpointFinalizer>
  >[0];

  function finalizer(overrides: Partial<Parameters<typeof createNormalCheckpointFinalizer>[0]> = {}) {
    let claimed = false;
    const deps = {
      claimTerminal: vi.fn(() => {
        if (claimed) return false;
        claimed = true;
        return true;
      }),
      emitResult: vi.fn(async () => {}),
      captureProofs: vi.fn(async () => {}),
      releaseAndExit: vi.fn(),
      ...overrides,
    };
    return { deps, finalize: createNormalCheckpointFinalizer(deps) };
  }

  it('waits for durable verdict recording, then capture, before release', async () => {
    const recorded = deferred<void>();
    const captured = deferred<void>();
    const h = finalizer({ emitResult: vi.fn(() => recorded.promise), captureProofs: vi.fn(() => captured.promise) });
    const done = h.finalize(result);
    expect(h.deps.emitResult).toHaveBeenCalledWith(result);
    expect(h.deps.captureProofs).not.toHaveBeenCalled();
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
    recorded.resolve();
    await recorded.promise;
    expect(h.deps.captureProofs).toHaveBeenCalledTimes(1);
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
    captured.resolve();
    await done;
    expect(h.deps.releaseAndExit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('refuses a signal/crash-owned terminal path without emitting or capturing', async () => {
    const h = finalizer({ claimTerminal: vi.fn(() => false) });
    await h.finalize(result);
    expect(h.deps.claimTerminal).toHaveBeenCalledExactlyOnceWith('normal');
    expect(h.deps.emitResult).not.toHaveBeenCalled();
    expect(h.deps.captureProofs).not.toHaveBeenCalled();
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
  });

  it('rejects duplicate completion while the first verdict recording is in flight', async () => {
    const recorded = deferred<void>();
    const h = finalizer({ emitResult: vi.fn(() => recorded.promise) });
    const first = h.finalize(result);
    await h.finalize(result);
    expect(h.deps.emitResult).toHaveBeenCalledTimes(1);
    expect(h.deps.captureProofs).not.toHaveBeenCalled();
    recorded.resolve();
    await first;
    await h.finalize(result);
    expect(h.deps.captureProofs).toHaveBeenCalledTimes(1);
    expect(h.deps.releaseAndExit).toHaveBeenCalledTimes(1);
  });

  it('leaves verdict-recording failures to the existing fatal handler without capturing', async () => {
    const error = new Error('verdict write failed');
    const h = finalizer({ emitResult: vi.fn(async () => { throw error; }) });
    await expect(h.finalize(result)).rejects.toBe(error);
    expect(h.deps.captureProofs).not.toHaveBeenCalled();
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
  });

  it('awaits archive completion before releasing, using clocks from the final callback', async () => {
    const archived = deferred<void>();
    const clock = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20);
    const archiveCapture = vi.fn(() => archived.promise);
    const h = finalizer({ now: clock, archiveCapture });
    const done = h.finalize(result);
    await vi.waitFor(() => expect(archiveCapture).toHaveBeenCalledTimes(1));
    expect(archiveCapture).toHaveBeenCalledWith(result, undefined,
      { resolvedAtMs: 10, terminalEmissionCompletedAtMs: 20 });
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
    archived.resolve();
    await done;
    await h.finalize(result);
    expect(archiveCapture).toHaveBeenCalledTimes(1);
    expect(h.deps.releaseAndExit).toHaveBeenCalledTimes(1);
  });

  it('reports an archive failure without changing the recorded verdict or trapping the lock', async () => {
    const error = new Error('artifact unavailable');
    const warnArchive = vi.fn();
    const h = finalizer({ archiveCapture: async () => { throw error; }, warnArchive });
    await h.finalize(result);
    expect(warnArchive).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.deps.releaseAndExit).toHaveBeenCalledExactlyOnceWith(0);
  });
});

describe('immutable capture receipt in checkpoint artifacts', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pure-capture-archive-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const receipt = (): PureProofCaptureArchive => ({ version: 1, runId: 'run-1', gateFireId: 'fire-1',
    pid: 123, processStartedAtMs: 1, judgedSha: 'a'.repeat(40), resolvedAtMs: 70,
    terminalEmissionCompletedAtMs: 90, verdictRecordedAtMs: 80,
    promotion: { candidate: 'a'.repeat(12), recordedAtMs: 60, promoted: false, reason: 'not-green' },
    capture: null, archivedAtMs: 210 });

  it('writes and reads the production receipt once and refuses to overwrite original evidence', () => {
    const r = receipt();
    const file = archivePureProofCapture(dir, r, () => {})!;
    expect(parsePureProofCaptureArchive(JSON.parse(readFileSync(file, 'utf8')))).toEqual(r);
    const bytes = readFileSync(file, 'utf8');
    expect(archivePureProofCapture(dir, { ...r, archivedAtMs: 220 }, () => {})).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('rejects malformed receipts without creating a file outside the artifact directory', () => {
    expect(archivePureProofCapture(dir, { ...receipt(), runId: '../foreign' }, () => {})).toBeNull();
  });

  it('measures the actual promotion writer and chooses the final trailer after pending', () => {
    vi.useFakeTimers();
    vi.setSystemTime(50);
    const file = join(dir, 'suite.log');
    writeFileSync(file, 'suite output\n');
    stampGatePromotion(file, { candidate: 'a'.repeat(40), green: false, promoted: false, reason: 'decision-pending' });
    expect(readGatePromotionDecision(readFileSync(file, 'utf8'))).toBeNull();
    vi.setSystemTime(60);
    stampGatePromotion(file, { candidate: 'a'.repeat(40), green: false, promoted: false, reason: 'not-green' });
    const promotion = readGatePromotionDecision(readFileSync(file, 'utf8'));
    expect(promotion).toEqual(receipt().promotion);
    const r = { ...receipt(), promotion };
    const archived = archivePureProofCapture(dir, r, () => {})!;
    expect(parsePureProofCaptureArchive(JSON.parse(readFileSync(archived, 'utf8')))).toEqual(r);
  });

  it.each(['', 'GATE_PROMOTION candidate=aaaaaaaaaaaa promoted=false reason=not-green',
    'GATE_PROMOTION candidate=aaaaaaaaaaaa promoted=false reason=not-green recordedAtMs=bad',
    'GATE_PROMOTION candidate=aaaaaaaaaaaa promoted=false reason=not-green recordedAtMs=50 recordedAtMs=60',
    'GATE_PROMOTION candidate=aaaaaaaaaaaa promoted=false reason=superseded-by-refire recordedAtMs=50'])(
    'keeps historical, invalid or superseded promotion evidence unknown: %s', (output) => {
      expect(readGatePromotionDecision(output)).toBeNull();
    },
  );
});

describe('runPostVerdictPureProofCapture', () => {
  const namedResult = () => ({ state: 'done', reason: null, sha: 'a'.repeat(40), slices: 1,
    files: 1, rows: 1, retired: 0, failed: 0, isolatedFail: 0, remaining: 0, stoppedBy: 'complete',
    timedOutSlices: 0, hung: [] as string[],
    evidence: { version: 1, runGroupId: 'run-1:pure-proof-capture', startedAtMs: 100, completedAtMs: 200,
      clean: true, proofs: [{ file: 'packages/operator-core/lib/a.test.ts', testRunId: '1',
        recordedAtMs: 150, runnerIdentity: 'runner', runContext: 'green-checkpoint',
        runGroupId: 'run-1:pure-proof-capture', source: 'local' }] }, lines: [] });

  it('returns the validated named producer population through the production wrapper', async () => {
    const result = namedResult();
    const capture = vi.fn(async () => result);
    const parsed = await runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {}, capture as never);
    const { lines: _lines, ...expected } = result;
    expect(parsed).toEqual(expected);
  });

  it('carries the real wrapper result through finalization into a create-only named proof archive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-capture-wrapper-'));
    try {
      const r = namedResult();
      const clock = vi.fn().mockReturnValueOnce(70).mockReturnValueOnce(90);
      let file: string | null = null;
      const releaseAndExit = vi.fn();
      const finalize = createNormalCheckpointFinalizer({
        claimTerminal: () => true, now: clock, emitResult: async () => {},
        captureProofs: () => runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {},
          vi.fn(async () => r) as never),
        archiveCapture: async (_result, capture, boundaries) => {
          file = archivePureProofCapture(dir, { version: 1, runId: 'run-1', gateFireId: 'fire-1',
            pid: 123, processStartedAtMs: 1, judgedSha: r.sha, ...boundaries,
            verdictRecordedAtMs: 80, promotion: null, capture: capture as PureProofCaptureArchive['capture'],
            archivedAtMs: 210 }, () => {});
        }, releaseAndExit,
      });
      await finalize({ green: false, candidate: r.sha } as Parameters<typeof finalize>[0]);
      expect(file).not.toBeNull();
      const archived = parsePureProofCaptureArchive(JSON.parse(readFileSync(file!, 'utf8')))!;
      const { lines: _lines, ...expected } = r;
      expect(archived.capture).toEqual(expected);
      expect(archived.resolvedAtMs).toBe(70);
      expect(archived.terminalEmissionCompletedAtMs).toBe(90);
      expect(releaseAndExit).toHaveBeenCalledExactlyOnceWith(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['aggregate-only', 'foreign process group', 'dirty proof', 'partial population'])(
    'returns unknown for %s instead of archiving a qualified population', async (condition) => {
      const r = namedResult();
      if (condition === 'foreign process group') {
        r.evidence.runGroupId = 'other:pure-proof-capture';
        r.evidence.proofs[0]!.runGroupId = r.evidence.runGroupId;
      } else if (condition === 'dirty proof') r.evidence.clean = false;
      else if (condition === 'partial population') r.evidence.proofs = [];
      const capture = vi.fn(async () => condition === 'aggregate-only' ? { rows: 1 } : r);
      expect(await runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {}, capture as never)).toBeNull();
    },
  );

  it('honours the kill switch: no capture, and the watchdog stays armed', async () => {
    process.env.PC_PURE_PROOF_CAPTURE = '0';
    const cancel = vi.fn();
    const capture = vi.fn();
    const logs: string[] = [];
    await runPostVerdictPureProofCapture(cfg, 'run-1', cancel, (l) => logs.push(l), capture as never);
    expect(capture).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(logs).toEqual(['PURE_PROOF_CAPTURE state=skipped reason=disabled-by-env']);
  });

  it('cancels the watchdog first, then captures in the checkpoint tree under the gate env', async () => {
    process.env.PC_PURE_PROOF_CAPTURE_BUDGET_MS = '60000';
    process.env.PC_PURE_PROOF_CAPTURE_SLICE = '50';
    const order: string[] = [];
    const cancel = vi.fn(() => order.push('cancel'));
    const capture = vi.fn(async (_o: Record<string, unknown>) => {
      order.push('capture');
      return {} as never;
    });
    const logs: string[] = [];
    await runPostVerdictPureProofCapture(cfg, 'run-1', cancel, (l) => logs.push(l), capture as never);
    expect(order).toEqual(['cancel', 'capture']);
    const arg = capture.mock.calls[0][0] as {
      root: string;
      runGroupId: string;
      logFile: string;
      env: Record<string, string | undefined>;
      deps: { readNextFireAtMs: unknown };
    };
    expect(arg.root).toBe('/ck/root');
    expect(arg.runGroupId).toBe('run-1:pure-proof-capture');
    expect(arg.logFile).toBe('/ck/logs/pure-proof-capture-run-1.log');
    expect(arg.env.GREEN_CHECKPOINT).toBe('1');
    // Carried past canonicalGreenCheckpointSourceEnv's allowlist, which would otherwise drop them.
    expect(arg.env.PC_PURE_PROOF_CAPTURE_BUDGET_MS).toBe('60000');
    expect(arg.env.PC_PURE_PROOF_CAPTURE_SLICE).toBe('50');
    expect(typeof arg.deps.readNextFireAtMs).toBe('function');
    expect(logs).toContain('GATE_RUN_PHASE phase=pure-proof-capture');
  });

  it('swallows a capture failure into one log line', async () => {
    const logs: string[] = [];
    const capture = vi.fn(async () => {
      throw new Error('boom went the capture');
    });
    await expect(
      runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, (l) => logs.push(l), capture as never),
    ).resolves.toBeNull();
    expect(logs).toContain('PURE_PROOF_CAPTURE state=error reason=boom_went_the_capture');
  });

  it('never runs past the run ceiling: the slice deadline and the hard deadline both stop at it', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const startedAt = now - SELF_WATCHDOG_MS + 2_000; // 2s of run left
    const logs: string[] = [];
    let nextFire: number | null = null;
    const capture = vi.fn(async (o: { deps: { readNextFireAtMs: () => Promise<number | null> } }) => {
      nextFire = await o.deps.readNextFireAtMs();
      return new Promise<never>(() => {});
    });
    let settled = false;
    const done = runPostVerdictPureProofCapture(
      cfg,
      'run-1',
      () => {},
      (l) => logs.push(l),
      capture as never,
      startedAt,
      async () => null, // no scheduled fire: the ceiling alone is the stop line
    ).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    // The phase is told the ceiling (or an earlier fire) as its stop line.
    expect(nextFire).not.toBeNull();
    expect(nextFire!).toBeLessThanOrEqual(startedAt + SELF_WATCHDOG_MS);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(logs).toContain('PURE_PROOF_CAPTURE state=abandoned reason=hard-deadline(2000ms)');
  });

  it('hands capture the earlier of the next fire and the ceiling, and the ceiling when the fire is unreadable', async () => {
    const startedAt = Date.now() - SELF_WATCHDOG_MS + 600_000; // 10 min of run left
    const seen: Array<number | null> = [];
    const capture = vi.fn(async (o: { deps: { readNextFireAtMs: () => Promise<number | null> } }) => {
      seen.push(await o.deps.readNextFireAtMs());
    });
    const before = Date.now();
    // A fire in 60s is earlier than the ceiling: it wins.
    await runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {}, capture as never, startedAt, async () => 60);
    // A fire in 3h is later than the ceiling: the ceiling wins.
    await runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {}, capture as never, startedAt, async () => 10_800);
    // An unreadable fire leaves the ceiling in force.
    await runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {}, capture as never, startedAt, async () => {
      throw new Error('routines row unreadable');
    });
    const after = Date.now();
    const ceiling = startedAt + SELF_WATCHDOG_MS;
    expect(seen[0]).toBeGreaterThanOrEqual(before + 60_000);
    expect(seen[0]).toBeLessThanOrEqual(after + 60_000);
    expect(seen[1]).toBe(ceiling);
    expect(seen[2]).toBe(ceiling);
  });

  it('stops waiting at budget + grace when capture hangs', async () => {
    vi.useFakeTimers();
    process.env.PC_PURE_PROOF_CAPTURE_BUDGET_MS = '1000';
    const logs: string[] = [];
    const capture = vi.fn(() => new Promise<never>(() => {}));
    let settled = false;
    const done = runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, (l) => logs.push(l), capture as never).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1000 + PURE_PROOF_CAPTURE_HARD_GRACE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
    expect(logs).toContain(
      `PURE_PROOF_CAPTURE state=abandoned reason=hard-deadline(${1000 + PURE_PROOF_CAPTURE_HARD_GRACE_MS}ms)`,
    );
  });
});
