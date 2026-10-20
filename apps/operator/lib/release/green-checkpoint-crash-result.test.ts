import { describe, expect, it, vi } from 'vitest';

import {
  buildCrashCheckpointResult,
  buildTerminalFailureCheckpointResult,
  checkpointVerdictFromResult,
  createFatalProcessHandler,
  emitTerminalCheckpointResult,
  GREEN_CHECKPOINT_RESULT_MARKER,
} from './green-checkpoint';
// EI-21465187777146773: the CONSUMER half of the seam these builders sit on. Imported for real
// (as torn-sweep-classification-path.test.ts does) rather than restated as a literal — the whole
// defect was that the producer's vocabulary and the consumer's class list drifted apart while
// both suites stayed green.
import { classifyGateStallStatus } from '@papercusp/operator-core/lib/harness/routines/release-actions';
import {
  classifyGateAbort,
  gateAbortLever,
  isRecordedInconclusiveStatus,
} from '@papercusp/operator-core/lib/release/gate-abort-status';
import { classifyGateOutcomeStatus } from '@papercusp/operator-core/lib/release/gate-fire-ledger';
import { readFileSync } from 'node:fs';

describe('EI-21462448110688084: process-level fatal errors await terminal finalization', () => {
  it('adapts producer results to the durable verdict vocabulary without mutating the marker result', () => {
    const result = {
      ...buildTerminalFailureCheckpointResult({
        candidate: '6e94004367c8',
        error: new Error('repair tick fixture'),
        runId: 'run-repair-tick',
      }),
      repairTickLegs: {
        head: '6e94004367c8560d25d689bf2d3fbe0afb6860f2',
        atMs: 123,
        ok: false,
        failingSignatures: ['lint:failed'],
        legs: [
          { id: 'lint:passed', status: 'pass' as const, durationMs: 1 },
          { id: 'lint:optional', status: 'skipped' as const, durationMs: 0 },
          {
            id: 'lint:failed',
            status: 'fail' as const,
            durationMs: 2,
            outputTail: 'failed fixture',
          },
        ],
      },
    };

    const verdict = checkpointVerdictFromResult(result);

    expect(verdict.repairTickLegs).toEqual({
      head: '6e94004367c8560d25d689bf2d3fbe0afb6860f2',
      atMs: 123,
      ok: false,
      failingSignatures: ['lint:failed'],
      legs: [
        { id: 'lint:passed', status: 'pass', durationMs: 1 },
        {
          id: 'lint:failed',
          status: 'fail',
          durationMs: 2,
          outputTail: 'failed fixture',
        },
      ],
    });
    expect(result.repairTickLegs.legs.map((leg) => leg.status)).toEqual([
      'pass',
      'skipped',
      'fail',
    ]);
  });

  it('records a terminal disposition before its marker and wake are observable', async () => {
    const order: string[] = [];
    const markers: string[] = [];
    const result = buildTerminalFailureCheckpointResult({
      candidate: '6e94004367c8',
      error: new Error(
        'dependency-generation.sh exited 74: no prewarmed dependency generation for input fingerprint fixture',
      ),
      runId: 'run-prelock',
    });

    await emitTerminalCheckpointResult(result, {
      record: async (terminal) => {
        order.push('record');
        expect(terminal.recorded).toBeUndefined();
        return true;
      },
      writeHuman: (terminal) => {
        order.push('human');
        expect(terminal.recorded).toBe(true);
      },
      writeMarker: (line) => {
        order.push('marker');
        markers.push(line);
      },
      emitInconclusive: async (terminal) => {
        order.push('wake');
        expect(terminal.recorded).toBe(true);
      },
      retire: async (terminal) => {
        order.push('retire');
        expect(terminal.recorded).toBe(true);
      },
    });

    expect(order).toEqual(['record', 'human', 'marker', 'wake', 'retire']);
    const marker = JSON.parse(markers[0]!.slice(markers[0]!.indexOf('{')));
    expect(marker).toMatchObject({
      candidate: '6e94004367c8',
      green: null,
      reason: 'dependency-prewarm-missing',
      recorded: true,
    });
  });

  it('keeps a rejected qualification diagnostic local without waking or retiring the incumbent run', async () => {
    const result = {
      ...buildTerminalFailureCheckpointResult({
        candidate: 'repair-head',
        error: new Error('scheduled qualification runner activation refused: conflict'),
        runId: 'rejected-run',
      }),
      recorded: true,
    };
    const markers: string[] = [];
    const emitInconclusive = vi.fn(async () => {});
    const emitTerminalEvents = vi.fn(async () => {});
    const retire = vi.fn(async () => {});

    await emitTerminalCheckpointResult(result, {
      record: async () => false,
      writeHuman: () => {},
      writeMarker: (line) => markers.push(line),
      emitInconclusive,
      emitTerminalEvents,
      retire,
    });

    expect(markers).toHaveLength(1);
    expect(JSON.parse(markers[0]!.slice(markers[0]!.indexOf('{')))).toMatchObject({
      candidate: 'repair-head',
      runId: 'rejected-run',
      green: null,
      recorded: false,
    });
    expect(emitInconclusive).not.toHaveBeenCalled();
    expect(emitTerminalEvents).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });

  it('does not exit until the typed-result finalizer completes', async () => {
    let finish!: (owned: boolean) => void;
    const finalize = vi.fn(
      () => new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const exit = vi.fn();
    const handler = createFatalProcessHandler(finalize, exit);

    const fatal = new Error('dependency-generation output escaped the run promise');
    handler(fatal);
    expect(finalize).toHaveBeenCalledWith(fatal);
    expect(exit).not.toHaveBeenCalled();

    finish(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('claims only the first fatal event while finalization is in flight', () => {
    const finalize = vi.fn(() => new Promise<boolean>(() => {}));
    const handler = createFatalProcessHandler(finalize, vi.fn());
    handler(new Error('first'));
    handler(new Error('second'));
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('emits and cleans an exact candidate when dependency generation dies after the after-copy manifest begins', async () => {
    const candidate = '8104d3804ac4d134cead82a10c89c54d5efa53b7';
    const markerLines: string[] = [];
    const emitted: string[] = [];
    const cleaned: string[] = [];
    const exited: number[] = [];
    const handler = createFatalProcessHandler(
      async (error) => {
        const result = buildTerminalFailureCheckpointResult({
          candidate,
          error,
          runId: 'scheduled-05a2a744',
        });
        await emitTerminalCheckpointResult(result, {
          writeHuman: vi.fn(),
          writeMarker: (line) => markerLines.push(line),
          emitInconclusive: async (terminal) => {
            emitted.push(`${terminal.candidate}:${terminal.green}`);
          },
          retire: async (terminal) => {
            cleaned.push(terminal.candidate);
          },
        });
        return true;
      },
      (code) => exited.push(code),
    );

    handler(
      new Error(
        'dependency-generation stdout: capturing live dependency manifest (after copy)\n' +
          'dependency-generation process exited 1',
      ),
    );
    await vi.waitFor(() => expect(exited).toEqual([1]));

    expect(markerLines).toHaveLength(1);
    expect(markerLines[0]).toContain(GREEN_CHECKPOINT_RESULT_MARKER);
    const terminal = JSON.parse(markerLines[0].slice(markerLines[0].indexOf('{')));
    expect(terminal).toMatchObject({
      candidate,
      green: null,
      // EI-21465187777146773: the marker a CAUGHT crash publishes now carries the same
      // no-verdict status an UNREPORTED crash gets from checkpointFallbackStatus.
      reason: 'error',
      crashed: true,
      runId: 'scheduled-05a2a744',
    });
    expect(emitted).toEqual([`${candidate}:null`]);
    expect(cleaned).toEqual([candidate]);
  });
});

/**
 * EI-18850448565330905 — a green-checkpoint run that dies inside a non-test leg (a
 * PG-backed plane lint, or anything else that throws instead of reporting a normal red
 * through allowNonZero/haltedBy) used to leave NO `__GREEN_CHECKPOINT_RESULT__` marker at
 * all: the CLI entrypoint's `.catch` only `console.error`'d and exited. Every downstream
 * reader then saw either nothing or a stale PREVIOUS verdict, and the raw log read as
 * truncated/OOM-killed rather than as a reported failure.
 *
 * `buildCrashCheckpointResult` is the pure core of the fix — the CLI's `.catch` blocks now
 * resolve a best-effort candidate (via `revParse`, not exercised here) and pass it plus the
 * caught error into this function before calling `emitResult`. These tests pin its SHAPE,
 * since the `require.main === module` CLI block itself is not unit-testable in isolation.
 */
describe('EI-18850448565330905: buildCrashCheckpointResult never leaves a crash unreported', () => {
  it('produces an INCONCLUSIVE, non-advancing verdict flagged as crashed', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('lint:plane-ratchet exited 1'), runId: 'run-1' });
    expect(r.green).toBeNull();
    expect(r.advanced).toBe(false);
    expect(r.reason).toBe('error');
    expect(r.crashed).toBe(true);
    expect(r.from).toBeNull();
    expect(r.candidate).toBe('abc123');
    expect(r.runId).toBe('run-1');
  });

  it('keeps an exhausted server_login_retry setup failure as no verdict', () => {
    const error = Object.assign(
      new Error('server_login_retry: database system is not yet accepting connections'),
      { code: '08P01' },
    );
    const result = buildTerminalFailureCheckpointResult({
      candidate: 'abc123',
      error,
      runId: 'run-retry-exhausted',
    });

    expect(result.green).toBeNull();
    expect(result.advanced).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.crashed).toBe(true);
  });

  /**
   * EI-20702428259478130 — these two pin the DISCRIMINATION, which is the whole point of the
   * field and the part a future edit is most likely to "simplify" away.
   *
   * `green: false` is the type's assertion that a verdict was rendered and the code is RED. A
   * crash renders no verdict, so as `false` this result was indistinguishable in the ledger from
   * a real test failure — and worse, `green === null` is the ONLY dispatch for
   * `green-checkpoint:inconclusive` (green-checkpoint.ts's emitInconclusiveVerdict), so every
   * agent parked on `checkpoint:await` was told the CODE was broken on the one class of run where
   * the truth is "the gate is wedged".
   */
  it('is strictly null — not false — so the inconclusive-verdict dispatch fires', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('boom'), runId: 'run-6' });
    // The literal condition at the emitResult dispatch site. `=== null` does not admit `false`,
    // which is exactly why the bug was invisible: both are falsy.
    expect(r.green === null).toBe(true);
    expect(r.green).not.toBe(false);
  });

  /**
   * EI-21465187777146773 — this test's PROPERTY is inherited unchanged from the one it replaces
   * ("a persistent crash must keep counting and keep firing the held-gate alarm"); only the
   * counter it counts in has moved. Read the whole comment before touching the expectation.
   *
   * The predecessor pinned `reason === 'not-green'`, and its reasoning was sound at the time:
   * release-actions derives `status` from `reason` and NEVER from `green`, so softening the
   * reason would have made a crash-looping gate go silent — and silence is how `main` freezes
   * with nobody told. What it could not express is that 'not-green' bought that loudness by
   * asserting something false: a red verdict, with an EMPTY failing-test list, about code no run
   * had judged. EI-21462211894072863 built the class that gets both — `'error'` counts in
   * `gate_health.consecutiveNoVerdict` and escalates at the same `stallReds` threshold, saying
   * WEDGED rather than RED — so staying loud no longer costs a fabricated verdict.
   *
   * ⚠ Asserting the reason STRING alone is what let this defect exist: the producer said
   * 'not-green' while the consumer's no-verdict class only ever recognized 'error', and both
   * suites stayed green through the disagreement. So the assertion runs the builder's OWN output
   * through the real consumer instead, in the manner of torn-sweep-classification-path.test.ts.
   */
  it('⭐ a crash still COUNTS — the builder\'s own reason routes to no-verdict, never red, never a silent noop', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('boom'), runId: 'run-7' });
    expect(r.reason).toBe('error');
    // The seam. Both collapse directions are stated explicitly so neither is reachable silently:
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('red'); // the fabricated verdict
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('noop'); // the silence WI-39841 feared
    // …and a moved pin still wins, exactly as for every other status.
    expect(classifyGateStallStatus(r.reason, true)).toBe('reset');
  });

  it('⭐ and stays VISIBLE — the reason is a recorded abort, classified transient (a crash latches nothing)', () => {
    // Counting it is only half of "loud": a reader has to be able to see it. A reason outside
    // RECORDED_INCONCLUSIVE_STATUSES records a tick nobody can be advised about.
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('boom'), runId: 'run-8' });
    expect(isRecordedInconclusiveStatus(r.reason)).toBe(true);
    expect(classifyGateAbort(r.reason)).toBe('transient');
    // The advice must not send the reader at a failing-test list this tick never produced —
    // the exact response the no-verdict split exists to prevent.
    expect(gateAbortLever(r.reason)).toMatch(/do NOT triage/i);
  });

  /**
   * PERMANENT FALSIFIABILITY CONTROL (repo convention: for a module you import, keep a
   * deliberately-wrong implementation in the test file rather than mutating the shared tree — a
   * mutation probe would hold a real source file modified for the life of the run, which
   * git-sync's whole-tree sweep can commit even when nothing goes wrong).
   *
   * `preFix` below is the real builder's output with ONLY `reason` put back to what it was before
   * this change — deliberately constructed by spread rather than as a re-implemented function, so
   * the divergence is provably a single field. The calibration block pins that the rest agrees, so
   * the failure it produces is attributable to THIS fix and not to an unrelated difference.
   *
   * Note it is falsifiable in the right direction: if the real builder ever went back to
   * 'not-green', `real.reason` and `preFix.reason` would be the same value and the two divergence
   * assertions would demand two different classes of it, failing here rather than silently passing.
   */
  it('CONTROL: the pre-fix crash result FAILS the property the fixed one satisfies', () => {
    const opts = { candidate: 'abc123', error: new Error('boom'), runId: 'run-control' };
    const real = buildCrashCheckpointResult(opts);
    const preFix = { ...real, reason: 'not-green' as const };

    // CALIBRATION — everything the fix did not touch must still agree, or the divergence below
    // says nothing about this change. `green: null` in particular: the pre-fix builder ALREADY
    // returned it, which is why the tri-state alone never fixed the streak.
    expect(preFix.green).toBe(real.green);
    expect(preFix.green).toBeNull();
    expect(preFix.crashed).toBe(real.crashed);
    expect(preFix.summary).toBe(real.summary);
    expect(preFix.advanced).toBe(real.advanced);

    // …and diverges at EXACTLY the defect: the old reason banked a red for a run that judged
    // nothing, and was not even a status a reader could be advised about.
    expect(classifyGateStallStatus(preFix.reason, false)).toBe('red');
    expect(classifyGateStallStatus(real.reason, false)).toBe('no-verdict');
    expect(isRecordedInconclusiveStatus(preFix.reason)).toBe(false);
  });

  it('carries the thrown Error\'s stack (falling back to its message) in the summary', () => {
    const err = new Error('boom');
    const r = buildCrashCheckpointResult({ candidate: 'deadbeef', error: err, runId: 'run-2' });
    expect(r.summary).toContain('green-checkpoint crashed before producing a normal verdict');
    expect(r.summary).toContain(err.stack ?? err.message);
  });

  it('stringifies a non-Error throw rather than losing it', () => {
    const r = buildCrashCheckpointResult({ candidate: 'deadbeef', error: 'a plain string rejection', runId: 'run-3' });
    expect(r.summary).toContain('a plain string rejection');
  });

  it('handles an Error with no stack by falling back to its message', () => {
    const err = new Error('no-stack');
    err.stack = undefined;
    const r = buildCrashCheckpointResult({ candidate: 'deadbeef', error: err, runId: 'run-4' });
    expect(r.summary).toContain('no-stack');
  });

  it('is JSON-serializable (the CLI emits it verbatim on the result-marker line)', () => {
    const r = buildCrashCheckpointResult({ candidate: 'abc123', error: new Error('boom'), runId: 'run-5' });
    expect(() => JSON.stringify(r)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(r));
    expect(parsed.crashed).toBe(true);
    // Survives the round-trip as null (JSON has a null; the risk would be it becoming absent,
    // which downstream `?? null` coercions would then read as an ordinary missing field).
    expect(parsed.green).toBeNull();
    expect('green' in parsed).toBe(true);
  });
});

describe('WI-40916 / EI-212278: materialization admission refusal is not a code red', () => {
  const refusal = new Error(
    'bash /repo/scripts/pc-heavy.sh --exclusive-all-slots -- bash setup-release-checkout.sh ' +
      'exited 75: [pc-heavy] REFUSED materialization after 900s: only 13/16 heavy slots drained',
  );

  it('classifies the exact bounded drain refusal as infra-inconclusive', () => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'abc123',
      error: refusal,
      runId: 'run-materializing',
    });
    expect(r.green).toBeNull();
    expect(r.advanced).toBe(false);
    expect(r.reason).toBe('infra-inconclusive');
    expect(r.crashed).toBeUndefined();
    expect(r.summary).toContain('No code verdict was rendered');
    expect(r.summary).toContain('13/16 heavy slots drained');
  });

  it.each([
    ['wrong mode', 'pc-heavy.sh npm test exited 75: [pc-heavy] REFUSED materialization'],
    ['wrong exit', 'pc-heavy.sh --exclusive-all-slots exited 1: [pc-heavy] REFUSED materialization'],
    ['missing marker', 'pc-heavy.sh --exclusive-all-slots exited 75: unknown failure'],
  ])('keeps an unknown crash counting when the signature is incomplete: %s', (_label, message) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'abc123',
      error: new Error(message),
      runId: 'run-generic',
    });
    // EI-21465187777146773: the generic crash path now says 'error'. The discrimination this
    // test exists for is UNCHANGED and is still the load-bearing part — an incomplete signature
    // must not be absorbed into the measured infra class, because 'infra-inconclusive' is a
    // true NOOP (it disturbs no counter at all) while a crash has to keep counting.
    expect(r.reason).toBe('error');
    expect(r.crashed).toBe(true);
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
    expect(classifyGateStallStatus('infra-inconclusive', false)).toBe('noop');
  });
});

describe('WI-41252 / D-066: dependency-generation torn snapshots are not code reds', () => {
  it.each([
    [
      'new generation changed during copy',
      'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo exited 75: ' +
        '[dependency-generation] FATAL: live node_modules changed during generation build; refusing a torn snapshot',
    ],
    [
      'existing generation changed while pinning',
      'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo exited 75: ' +
        '[dependency-generation] FATAL: live node_modules changed while pinning an existing generation',
    ],
    [
      'exact-ref inputs changed before selector publication',
      'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo ' +
        '--ensure-ref e8d04df9 exited 75: [dependency-generation] FATAL: dependency inputs ' +
        'changed during generation prewarm; refusing a stale selector',
    ],
    [
      // 2026-09-03: this site used to return exit 1 (a hard crash, no verdict recorded
      // with the right reason) even though it is the same live-input-drift family as the
      // other three — source_before/source_after can match while a node_modules tree the
      // manifest recorded still vanishes from the live tree during the tens-of-seconds
      // after-copy scan. See apps/operator/bin/release/dependency-generation.sh.
      'post-copy manifest lost the incremental-reuse contract',
      'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo exited 75: ' +
        '[dependency-generation] FATAL: verified source manifest lost the incremental-reuse contract',
    ],
  ])('classifies %s as infra-inconclusive with the exact dependency phase', (_label, message) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'dfe7bd9f4e56',
      error: new Error(message),
      runId: 'run-dependency-generation',
    });

    expect(r).toMatchObject({
      advanced: false,
      candidate: 'dfe7bd9f4e56',
      from: null,
      green: null,
      reason: 'infra-inconclusive',
      runId: 'run-dependency-generation',
    });
    expect(r.crashed).toBeUndefined();
    expect(r.summary).toContain('pinning an immutable dependency generation');
    expect(r.summary).toContain('refused a torn snapshot');
    expect(r.summary).toContain('stale exact-ref selector');
    expect(r.summary).toContain('No code verdict was rendered');
  });

  it.each([
    ['wrong exit', 'dependency-generation.sh exited 1: refusing a torn snapshot'],
    ['missing script identity', 'publisher exited 75: refusing a torn snapshot'],
  ])('keeps an incomplete dependency signature on the generic crash path: %s', (_label, message) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'dfe7bd9f4e56',
      error: new Error(message),
      runId: 'run-generic',
    });
    // EI-21465187777146773: 'error' is the generic crash path's reason now — still counting
    // (no-verdict), still NOT the measured infra noop the exact signatures earn.
    expect(r.reason).toBe('error');
    expect(r.crashed).toBe(true);
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
  });

  it('WI-6554700010018253: an incomplete source install is a STANDING no-verdict, not self-clearing drift', () => {
    // Shape copied from the measured 2026-10-20 drill-pot gate abort (install papercusp-pr-drill-20261014).
    const r = buildTerminalFailureCheckpointResult({
      candidate: '11d56fad7ef9',
      error: new Error(
        'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /clones/drill ' +
          '--ensure-ref 11d56fad --retain-as checkpoint-candidate exited 75: ' +
          '[dependency-generation] LOCK_TREE_DEFECT\tmissing\tnode_modules/parse5\tlocked 8.0.1\n' +
          '[dependency-generation] PHASE schema=1 phase=source-lock-tree-audit outcome=failed duration_ms=4449\n' +
          '[dependency-generation] SUMMARY schema=1 result=lock-tree-incomplete source=a2d5 identity=v1-a2d5\n' +
          '[dependency-generation] FATAL: source dependency trees do not realise their lockfiles',
      ),
      runId: 'run-lock-tree',
    });

    expect(r).toMatchObject({
      advanced: false,
      candidate: '11d56fad7ef9',
      green: null,
      reason: 'dependency-generation-unusable',
    });
    expect(r.crashed).toBeUndefined();
    expect(r.summary).toContain('npm run install:safe');
    expect(r.summary).toContain('/clones/drill');
    expect(r.summary).not.toContain('wait for dependency writers to settle');
    // Counted, so the no-verdict invariant can see a gate stuck on it.
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
  });

  it('uses the dependency-generation writer\'s reserved exit-75 contract, not message prose', () => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'dfe7bd9f4e56',
      error: new Error('dependency-generation.sh exited 75: future live-input drift wording'),
      runId: 'run-dependency-generation',
    });

    expect(r.reason).toBe('infra-inconclusive');
    expect(r.green).toBeNull();
    expect(r.crashed).toBeUndefined();
  });
});

/**
 * P-007 (green-main-fast-2026-08-25) — a MISSING prewarmed dependency generation.
 *
 * Measured live 2026-08-26T00:04Z on papercusp: candidate b3e519a1, runId 231966bc. The gate died
 * in 90 seconds having executed ZERO tests, because no immutable dependency generation had been
 * published for the candidate's input fingerprint. It surfaced as `reason:'error', crashed:true`
 * — an anonymous stack trace — which is the defect this block pins.
 *
 * The DETAIL string below is copied verbatim from that run's log (paths shortened only), so the
 * signature is pinned to a real observed failure rather than to a plausible reconstruction of one.
 */
describe('P-007: a missing prewarmed dependency generation is a typed STANDING prerequisite, not an anonymous crash', () => {
  const REAL_MISSING_PREWARM_DETAIL =
    'Error: /node /repo/scripts/npm-install-safe.mjs --repo-root /repo --exec-under-lock -- ' +
    'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo ' +
    '--select-inputs-from /repo-checkpoint exited 74: NPM_INSTALL_SAFE guarding reader\n' +
    '[dependency-generation] FATAL: no prewarmed dependency generation for input fingerprint ' +
    'b0ea5991b1a86415cf8a0a8d807f27433c7e270ce79d567a848f6696a37908b0';

  const classify = () =>
    buildTerminalFailureCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error(REAL_MISSING_PREWARM_DETAIL),
      runId: '231966bc',
    });

  it('classifies the exact exit-74 selector refusal as its own typed reason', () => {
    const r = classify();
    expect(r).toMatchObject({
      advanced: false,
      candidate: 'b3e519a1bfce',
      from: null,
      green: null,
      reason: 'dependency-prewarm-missing',
      runId: '231966bc',
    });
    // Not a crash: the cause is MEASURED, so it must not carry the unknown-crash evidence flag.
    expect(r.crashed).toBeUndefined();
  });

  it('names the missing fingerprint and the producer, so the summary alone is actionable', () => {
    const summary = classify().summary ?? '';
    // The whole point of the type: the operator learns WHICH fingerprint is unpublished without
    // going to dig it out of the run log.
    expect(summary).toContain(
      'b0ea5991b1a86415cf8a0a8d807f27433c7e270ce79d567a848f6696a37908b0',
    );
    expect(summary).toMatch(/no prewarmed immutable dependency generation/i);
    expect(summary).toMatch(/NO code verdict was rendered/i);
    // It must say the condition PERSISTS — the advice that a re-fire may finish is what burned a
    // scarce owner authorization on 2026-08-26.
    expect(summary).toMatch(/does NOT clear on its own/i);
    expect(summary).toContain('WI-41491');
  });

  it('⭐ THE DEFECT: it is advised as a STANDING condition, never as a transient crash', () => {
    const r = classify();
    // A reader must be able to see it at all…
    expect(isRecordedInconclusiveStatus(r.reason)).toBe(true);
    // …and be told the truth about re-firing. 'transient' promises "a re-fire may well finish";
    // for an unpublished fingerprint the next run dies on the identical selector miss.
    expect(classifyGateAbort(r.reason)).toBe('standing-condition');
    expect(classifyGateAbort(r.reason)).not.toBe('transient');
    // 'unknown' is the DEFAULTED sentinel — a recorded status landing there means the advice was
    // inherited rather than decided (EI-21290961259437085).
    expect(classifyGateAbort(r.reason)).not.toBe('unknown');
    // ⚠ The lever text CANNOT stand in for the two assertions above: gateAbortLever deliberately
    // gives 'standing-condition' and 'unknown' the same wording, so it passes either way. What it
    // does prove is the operator-facing consequence — the advice tells you to clear the condition…
    expect(gateAbortLever(r.reason)).toMatch(/re-firing aborts the same way/i);
    // …and, decisively, never carries the transient lever's invitation to just run it again. That
    // sentence is what a human acts on, and acting on it here costs a whole authorization.
    expect(gateAbortLever(r.reason)).not.toMatch(/nothing is blocking a re-fire/i);
  });

  it('⭐ THE COUPLING: the consumer knows the new reason, so it can never fabricate a code red', () => {
    const r = classify();
    // classifyGateStallStatus ends in `return 'red'`. An unmapped reason would therefore convert
    // a prerequisite outage into a fabricated verdict about code no test ever executed — strictly
    // worse than the untyped crash this replaced. This assertion is the guard on that fallthrough.
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('red');
    // …and NOT silenced either: unlike the self-clearing infra aborts, this one persists until the
    // producer publishes, so 'noop' would let the gate render nothing indefinitely, unnoticed.
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('noop');
    // A moved pin still wins, exactly as for every other status.
    expect(classifyGateStallStatus(r.reason, true)).toBe('reset');
  });

  /**
   * PERMANENT FALSIFIABILITY CONTROL (repo convention: for a module you import, keep the
   * deliberately-wrong behaviour in the test file rather than mutating the shared tree).
   *
   * This control needs no reconstruction at all: before this fix the missing-prewarm detail fell
   * THROUGH to `buildCrashCheckpointResult`, and that function is still exported — so `preFix`
   * below is not an approximation of the old behaviour, it IS the old behaviour, produced by the
   * same code path from the same input.
   *
   * Falsifiable in the right direction: if the classifier ever stopped recognising the signature,
   * `real` would become identical to `preFix` and the divergence assertions would demand two
   * different values of one object — failing here rather than silently passing.
   */
  it('CONTROL: the pre-fix path gives the OPPOSITE operational advice on the same input', () => {
    const opts = {
      candidate: 'b3e519a1bfce',
      error: new Error(REAL_MISSING_PREWARM_DETAIL),
      runId: '231966bc',
    };
    const real = buildTerminalFailureCheckpointResult(opts);
    const preFix = buildCrashCheckpointResult(opts); // literally what this input produced before

    // CALIBRATION — everything the fix did not touch must still agree, or the divergence below
    // says nothing about THIS change. Both already refused to claim a verdict; that was never
    // the defect.
    expect(preFix.green).toBe(real.green);
    expect(preFix.green).toBeNull();
    expect(preFix.advanced).toBe(real.advanced);
    expect(preFix.candidate).toBe(real.candidate);
    expect(preFix.runId).toBe(real.runId);

    // …and diverges at EXACTLY the defect. The old path produced an anonymous crash…
    expect(preFix.reason).toBe('error');
    expect(preFix.crashed).toBe(true);
    expect(preFix.summary).toMatch(/crashed before producing a normal verdict/i);
    // …which was advised as TRANSIENT, i.e. "just run it again" — on a fingerprint that was still
    // unpublished, so the next run would die identically. This is the measured 2026-08-26 harm.
    expect(classifyGateAbort(preFix.reason)).toBe('transient');
    expect(gateAbortLever(preFix.reason)).toMatch(/nothing is blocking a re-fire/i);

    // The fixed path names the condition and says it persists.
    expect(real.reason).toBe('dependency-prewarm-missing');
    expect(classifyGateAbort(real.reason)).toBe('standing-condition');
    expect(gateAbortLever(real.reason)).toMatch(/re-firing aborts the same way/i);
  });

  it.each([
    // 75 is the TORN-SNAPSHOT code, a different and self-clearing condition.
    [
      'wrong exit code',
      'dependency-generation.sh exited 75: no prewarmed dependency generation for input fingerprint abc123',
      'infra-inconclusive',
      undefined,
    ],
    // Some other tool exiting 74 must not borrow this classification.
    [
      'missing script identity',
      'some-other-tool exited 74: no prewarmed dependency generation for input fingerprint abc123',
      'error',
      true,
    ],
  ])(
    'keeps an incomplete signature on the generic crash path: %s',
    (_label, message, expectedReason, expectedCrashed) => {
      const r = buildTerminalFailureCheckpointResult({
        candidate: 'b3e519a1bfce',
        error: new Error(message),
        runId: 'run-generic',
      });
      expect(r.reason).not.toBe('dependency-prewarm-missing');
      expect(r.reason).toBe(expectedReason);
      expect(r.crashed).toBe(expectedCrashed);
    },
  );

  /**
   * CLASS-LEVEL GUARD. The first version of this fix typed ONE of the script's eight `return 74`
   * sites and left seven siblings on the anonymous-crash path — the instance fixed, the class
   * left armed. These are the REAL messages, transcribed from
   * apps/operator/bin/release/dependency-generation.sh.
   *
   * Every one of them must land as a typed STANDING no-verdict. If someone adds a ninth exit-74
   * refusal, it inherits the classification automatically (the match is on the exit CODE, which
   * is the script's contract, not on these strings) — and if someone changes 74's meaning, this
   * block fails and forces the decision to be made deliberately rather than by drift.
   */
  it.each([
    'prewarmed dependency generation gen-1 has no immutable token',
    'prewarmed dependency generation gen-1 was replaced after validation',
    'prewarmed dependency generation gen-1 has an invalid immutable marker',
    'no prewarmed dependency generation for input fingerprint b0ea5991',
    'invalid prewarmed dependency selector for b0ea5991',
    'dependency generation gen-1 is missing or invalid',
    'dependency generation gen-1 has no source fingerprint',
    'dependency generation gen-1 disappeared before it could be leased',
  ])('every exit-74 refusal is typed and STANDING, never an anonymous crash: %s', (fatal) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error(
        'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo ' +
          `exited 74: [dependency-generation] FATAL: ${fatal}`,
      ),
      runId: 'run-74-family',
    });

    // Never the anonymous crash bucket…
    expect(r.reason).not.toBe('error');
    expect(r.crashed).toBeUndefined();
    // …always a recorded, named abort…
    expect(isRecordedInconclusiveStatus(r.reason)).toBe(true);
    // …and never advised as "just run it again", which is the harm the whole block exists to stop.
    expect(classifyGateAbort(r.reason)).toBe('standing-condition');
    expect(gateAbortLever(r.reason)).not.toMatch(/nothing is blocking a re-fire/i);
    // …and it can never reach classifyGateStallStatus's `return 'red'` default.
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
    // No verdict about the code, in either direction.
    expect(r.green).toBeNull();
  });

  it('routes the two exit-74 causes to DIFFERENT reasons, because their remedies differ', () => {
    const missing = buildTerminalFailureCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error(REAL_MISSING_PREWARM_DETAIL),
      runId: 'run-a',
    });
    const unusable = buildTerminalFailureCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error(
        'bash /repo/apps/operator/bin/release/dependency-generation.sh exited 74: ' +
          '[dependency-generation] FATAL: dependency generation gen-1 has an invalid immutable marker',
      ),
      runId: 'run-b',
    });

    // Absent fingerprint -> the PRODUCER must publish it.
    expect(missing.reason).toBe('dependency-prewarm-missing');
    expect(missing.summary).toContain('WI-41491');
    // Present but bad -> the generation STORE must be repaired. Collapsing these into one reason
    // would send the reader at the wrong remedy half the time.
    expect(unusable.reason).toBe('dependency-generation-unusable');
    expect(unusable.summary).toMatch(/repaired or republished/i);
    expect(unusable.summary).toMatch(/failing closed is correct/i);
  });
});

/**
 * EI-26520203347017584 (Asana 1219723974934266). The drill pot's gate refused 24 runs in a row
 * with exit 74 and every summary said "the generation store must be repaired or republished".
 * The store was fine. The pot's integration checkout had never initialized its
 * papercusp-desktop submodule, so the selector could not build the candidate's input manifest.
 *
 * Exit 74 covers two families with different remedies. The store-side refusals say a published
 * generation is missing or unusable. The input-side refusals fire while the selector reads the
 * candidate's inputs out of the integration checkout, before any generation is consulted. The
 * exit code cannot separate them, so the selector's own FATAL wording is the discriminator. The
 * last test in this block pins that wording to the real script, so a reworded FATAL fails here
 * instead of quietly sliding back onto the store-repair advice.
 */
describe('EI-26520203347017584: an integration-checkout input defect is advised as a CHECKOUT repair, not a store repair', () => {
  const CANDIDATE = '2df9d19e197c0ff10d18f9ad1a05fe584f790d05';
  const SUBMODULE_SHA = '9f3c2b1a0e8d7c6b5a49382716f5e4d3c2b1a090';
  // The gate's real selector invocation (shape copied from the drill pot's gate_health detail,
  // paths shortened): the candidate's inputs are read from the `--integration` checkout.
  const CHECKOUT = '/clones/papercusp-pr-drill-20261014';
  const SELECTOR_PREFIX =
    `bash /op/apps/operator/bin/release/dependency-generation.sh --integration ${CHECKOUT} ` +
    `--ensure-ref ${CANDIDATE} --retain-as checkpoint-candidate exited 74: NPM_INSTALL_SAFE guarding reader\n`;
  const UNAVAILABLE_SUBMODULE_DETAIL =
    `/node /op/scripts/npm-install-safe.mjs --repo-root ${CHECKOUT} --exec-under-lock -- ${SELECTOR_PREFIX}` +
    `[dependency-generation] submodule papercusp-desktop is not initialized in ${CHECKOUT}; initializing it for ${SUBMODULE_SHA}\n` +
    `[dependency-generation] FATAL: exact dependency-input ref ${CANDIDATE} requires unavailable submodule ` +
    `papercusp-desktop@${SUBMODULE_SHA} (hydrating the integration checkout from the submodule's own remote ` +
    'did not produce that commit; this is an integration-checkout defect, not a generation-store one)';

  /**
   * The verdict's OWN words, without the raw detail the builder appends at the end. The echoed
   * FATAL already says "integration-checkout defect", so an advice assertion run over the whole
   * summary could pass on the log line alone. The builder appends `error.stack` verbatim, so
   * stripping exactly that suffix leaves only what the classifier wrote.
   */
  function classify(message: string) {
    const error = new Error(message);
    const result = buildTerminalFailureCheckpointResult({
      candidate: CANDIDATE,
      error,
      runId: 'run-checkout-74',
    });
    const summary = result.summary ?? '';
    const suffix = ` ${error.stack ?? error.message}`;
    expect(summary.endsWith(suffix), 'the raw selector detail must stay attached as evidence').toBe(true);
    return { result, advice: summary.slice(0, summary.length - suffix.length) };
  }

  it('classifies the unavailable-submodule refusal as its own typed reason, still a no-verdict refusal', () => {
    const { result } = classify(UNAVAILABLE_SUBMODULE_DETAIL);
    expect(result).toMatchObject({
      advanced: false,
      candidate: CANDIDATE,
      from: null,
      green: null,
      reason: 'integration-checkout-defective',
      runId: 'run-checkout-74',
    });
    // A measured, named cause: not the anonymous crash bucket.
    expect(result.crashed).toBeUndefined();
  });

  it('⭐ THE DEFECT: names the unavailable submodule and advises repairing the checkout, never the store', () => {
    const { advice } = classify(UNAVAILABLE_SUBMODULE_DETAIL);
    // Names the defective input, so the summary alone tells the operator where to look.
    expect(advice).toContain(`papercusp-desktop@${SUBMODULE_SHA}`);
    expect(advice).toContain(CHECKOUT);
    expect(advice).toMatch(/repair the integration checkout/i);
    // Still a refusal: no verdict, nothing to triage.
    expect(advice).toMatch(/NO code verdict was rendered/);
    expect(advice).toMatch(/must not be triaged/i);
    // The reported harm: advice that sent the operator to the generation store.
    expect(advice).not.toMatch(/generation store must be repaired or republished/i);
    expect(advice).not.toMatch(/dependency generation it selected is unusable/i);
  });

  it('stays a counted, STANDING no-verdict: never a red, never silenced, never "just re-fire"', () => {
    const { result } = classify(UNAVAILABLE_SUBMODULE_DETAIL);
    expect(isRecordedInconclusiveStatus(result.reason)).toBe(true);
    // The checkout stays broken until someone repairs it; the next run refuses identically.
    expect(classifyGateAbort(result.reason)).toBe('standing-condition');
    expect(gateAbortLever(result.reason)).not.toMatch(/nothing is blocking a re-fire/i);
    // classifyGateStallStatus defaults to 'red'; an unmapped reason would fabricate a code red.
    expect(classifyGateStallStatus(result.reason, false)).toBe('no-verdict');
    expect(classifyGateStallStatus(result.reason, true)).toBe('reset');
    // The fire ledger must not read it as a verdict either.
    expect(classifyGateOutcomeStatus(result.reason)).toBe('no-verdict');
  });

  it.each([
    [
      'submodule with no gitlink at the candidate',
      `[dependency-generation] FATAL: exact dependency-input ref ${CANDIDATE} has no gitlink for submodule papercusp-desktop`,
      'papercusp-desktop',
    ],
    [
      'candidate ref missing from the checkout',
      `[dependency-generation] FATAL: dependency-input ref is not a commit: ${CANDIDATE}`,
      CANDIDATE,
    ],
    [
      'gate --ensure-ref missing from the checkout',
      `[dependency-generation] FATAL: --ensure-ref is not a commit: ${CANDIDATE}`,
      CANDIDATE,
    ],
  ])('the sibling input-side refusal is a checkout defect too: %s', (_label, fatal, named) => {
    const { result, advice } = classify(`${SELECTOR_PREFIX}${fatal}`);
    expect(result.reason).toBe('integration-checkout-defective');
    expect(result.green).toBeNull();
    expect(advice).toContain(CHECKOUT);
    expect(advice).toContain(named);
    expect(advice).toMatch(/repair the integration checkout/i);
    expect(advice).not.toMatch(/generation store must be repaired or republished/i);
  });

  it('CONTROL: the store-side exit-74 refusals keep their store remedies', () => {
    for (const fatal of [
      'prewarmed dependency generation gen-1 has no immutable token',
      'prewarmed dependency generation gen-1 was replaced after validation',
      'dependency generation gen-1 is missing or invalid',
      'dependency generation gen-1 disappeared before it could be leased',
    ]) {
      const { result, advice } = classify(`${SELECTOR_PREFIX}[dependency-generation] FATAL: ${fatal}`);
      expect(result.reason, fatal).toBe('dependency-generation-unusable');
      expect(advice, fatal).toMatch(/generation store must be repaired or republished/i);
    }
    const { result: missing } = classify(
      `${SELECTOR_PREFIX}[dependency-generation] FATAL: no prewarmed dependency generation for input fingerprint b0ea5991`,
    );
    expect(missing.reason).toBe('dependency-prewarm-missing');
  });

  it('CONTROL: the checkout wording alone, without the selector exit-74 contract, stays a generic crash', () => {
    const { result } = classify(
      `some-other-tool exited 74: FATAL: exact dependency-input ref ${CANDIDATE} requires unavailable submodule ` +
        `papercusp-desktop@${SUBMODULE_SHA}`,
    );
    expect(result.reason).toBe('error');
    expect(result.crashed).toBe(true);
  });

  /**
   * PIN (derived-truth ladder rung 2): the classifier matches the selector's FATAL wording, so
   * that wording is a contract. Read the real script and require each input-side FATAL to still
   * exist and still exit 74.
   */
  it('PIN: every input-side FATAL the classifier matches still exists in dependency-generation.sh and exits 74', () => {
    const script = readFileSync(
      new URL('../../bin/release/dependency-generation.sh', import.meta.url),
      'utf8',
    );
    const lines = script.split('\n');
    for (const fragment of [
      'requires unavailable submodule $submodule_path@$submodule_object',
      'has no gitlink for submodule $submodule_path',
      'FATAL: dependency-input ref is not a commit: $ref',
      'FATAL: --fingerprint-ref is not a commit: $fingerprint_ref',
      'FATAL: --predict-ref is not a commit: $predict_ref',
      'FATAL: --ensure-ref is not a commit: $ensure_ref',
    ]) {
      const at = lines.findIndex((line) => line.includes(fragment));
      expect(at, `dependency-generation.sh no longer emits: ${fragment}`).toBeGreaterThan(-1);
      expect(lines.slice(at, at + 3).join('\n'), fragment).toMatch(/return 74\b/);
    }
  });
});

describe('WI-10004849: dependency-generation exits 76/77 are infra, not crashes or code reds', () => {
  it.each([
    [77, 'DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT', 'disk-headroom'],
    [76, 'DEPENDENCY_GENERATION_LOCK_TIMEOUT', 'infra-inconclusive'],
  ])('preserves the typed infra refusal through the real argument-bearing command (exit %s)', (exitCode, marker, reason) => {
    const result = buildTerminalFailureCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error(
        'node /repo/scripts/npm-install-safe.mjs --repo-root /repo/app --exec-under-lock -- ' +
          'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo/app ' +
          `--ensure-ref b3e519a1bfce --retain-as checkpoint-candidate exited ${exitCode}: ` +
          `[dependency-generation] ${marker} avail=1 need=2`,
      ),
      runId: 'run-with-argv',
    });

    expect(result.reason).toBe(reason);
    expect(result.green).toBeNull();
    expect(result.crashed).toBeUndefined();
    expect(result.summary).toContain('NO code verdict');
  });

  it('exit 77 (headroom) is disk-headroom and exit 76 (lock timeout) is infra-inconclusive', () => {
    const headroom = buildTerminalFailureCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error(
        'bash /repo/apps/operator/bin/release/dependency-generation.sh exited 77: ' +
          '[dependency-generation] DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT avail=1 need=2',
      ),
      runId: 'run-a',
    });
    const lock = buildTerminalFailureCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error(
        'bash /repo/apps/operator/bin/release/dependency-generation.sh exited 76: ' +
          '[dependency-generation] DEPENDENCY_GENERATION_LOCK_TIMEOUT',
      ),
      runId: 'run-b',
    });
    expect(headroom.reason).toBe('disk-headroom');
    expect(headroom.green).toBeNull();
    expect(headroom.summary).toMatch(/NO code verdict/);
    expect(lock.reason).toBe('infra-inconclusive');
    expect(lock.green).toBeNull();
    // green-main-cycle-time P-022: the typed blocker runGreenCheckpoint's one bounded retry keys on.
    expect(headroom.preconditionBlocker).toBe('disk-headroom');
    expect(lock.preconditionBlocker).toBe('copy-lock');
  });

  it('an unrelated dependency-generation exit stays on the crash path', () => {
    const other = buildTerminalFailureCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error('bash /repo/apps/operator/bin/release/dependency-generation.sh exited 1: boom'),
      runId: 'run-c',
    });
    expect(other.reason).not.toBe('disk-headroom');
    expect(other.reason).not.toBe('infra-inconclusive');
    // Never a precondition retry: an untyped exit stays on the crash path.
    expect(other.preconditionBlocker).toBeUndefined();
  });
});

describe('WI-10002039: an UNAUTHORIZED promotion push is a typed STANDING access fault, not an anonymous crash', () => {
  // Verbatim from the run's own log, 2026-09-20T10:26:45Z (hello-world-3). Quoted rather than
  // paraphrased for the reason the P-007 block above quotes its own: the discriminator matches
  // real producer output, so a fixture that drifts from it silently stops testing the real path.
  const REAL_PUSH_403_DETAIL =
    'Error: green-checkpoint push failed: green candidate 6653fb41543d was NOT published to ' +
    // Path generalised to /repo (as the P-007 fixture above does): a hardcoded home directory in
    // shipped source reds the identity-lint leg and freezes `main` for the whole fleet.
    'origin/main; local main remains at d554832e80f1. git -C ' +
    '/repo/.papercusp-workspaces/clones/hello-world-3 push origin ' +
    '6653fb41543dd412a319ab8c392db6eaa0967ae5:refs/heads/main exited 128: remote: Permission to ' +
    'octocat/Hello-World.git denied to papercupai.\n' +
    "fatal: unable to access 'https://github.com/octocat/Hello-World.git/': The requested URL " +
    'returned error: 403';

  const classify = () =>
    buildTerminalFailureCheckpointResult({
      candidate: '6653fb41543d',
      error: new Error(REAL_PUSH_403_DETAIL),
      runId: 'run-push-403',
    });

  it('classifies the refusal as its own typed reason rather than the unknown-crash bucket', () => {
    const r = classify();
    expect(r).toMatchObject({
      advanced: false,
      candidate: '6653fb41543d',
      from: null,
      green: null,
      reason: 'promotion-unauthorized',
      runId: 'run-push-403',
    });
    // MEASURED cause ⇒ it must not carry the unknown-crash evidence flag.
    expect(r.crashed).toBeUndefined();
  });

  it('names the remote and the remedy, so the summary alone is actionable', () => {
    const summary = classify().summary ?? '';
    // The operator learns WHICH remote refused without digging through a stack trace.
    expect(summary).toContain('https://github.com/octocat/Hello-World.git/');
    // It must say the suite is NOT what failed — triaging this candidate's files is wasted work.
    expect(summary).toMatch(/not a code red/i);
    expect(summary).toMatch(/do not triage/i);
    // It must say the condition PERSISTS, and name a remedy a human can actually execute.
    expect(summary).toMatch(/does NOT self-clear/i);
    expect(summary).toMatch(/write access|repoint origin|stop scheduling/i);
    // The invariant must be restated, so nobody "fixes" this by letting the ref advance.
    expect(summary).toMatch(/refusing to advance is CORRECT/i);
  });

  it('⭐ THE DEFECT: advised as a STANDING condition — never "nothing is blocking a re-fire"', () => {
    const r = classify();
    // A reader must be able to see it at all…
    expect(isRecordedInconclusiveStatus(r.reason)).toBe(true);
    // …and be told the truth about re-firing. This is the whole fix: as 'error' it inherited the
    // TRANSIENT lever, which invited a re-fire into a 403 that refuses every re-fire identically.
    expect(classifyGateAbort(r.reason)).toBe('standing-condition');
    expect(gateAbortLever(r.reason)).not.toMatch(/nothing is blocking a re-fire/i);
  });

  it('counts as a no-verdict — never a fabricated red, never silent', () => {
    const r = classify();
    // It must never reach classifyGateStallStatus's trailing `return 'red'`: a red here would
    // name NO failing test and would dispatch a release-fixer at a phantom file list.
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('red');
    // …and not 'noop' either: the condition is standing, so repeated aborts must keep counting
    // toward the existing consecutiveNoVerdict escalation. The fix changes the NAME, not the volume.
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('noop');
    // No verdict about the code, in either direction.
    expect(r.green).toBeNull();
  });

  it.each([
    ['401 credential rejection', 'The requested URL returned error: 401'],
    ['git credential helper failure', 'fatal: Authentication failed for https://example.com/x.git'],
    ['no credential available', 'fatal: could not read Username for https://example.com: terminal prompts disabled'],
  ])('recognises the other authorization shapes: %s', (_label, tail) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: '6653fb41543d',
      error: new Error(
        'green-checkpoint push failed: green candidate 6653fb41543d was NOT published to ' +
          `origin/main. git push origin 6653fb41543d:refs/heads/main exited 128: ${tail}`,
      ),
      runId: 'run-auth-shape',
    });
    expect(r.reason).toBe('promotion-unauthorized');
    expect(classifyGateAbort(r.reason)).toBe('standing-condition');
  });

  /**
   * NEGATIVE CONTROL — the discriminator must DISCRIMINATE.
   *
   * Without this, the block above passes just as happily against a rule that typed EVERY push
   * failure as unauthorized, which would be a real regression: a non-fast-forward or a network
   * blip is TRANSIENT, genuinely does clear, and must keep its existing handling. A guard that
   * cannot fail is not a guard, and this is the cheapest honest way to prove this one can.
   */
  it.each([
    // A push that failed for a NON-authorization reason. These keep their existing handling:
    // a non-fast-forward or a resolver blip is transient and genuinely does clear.
    [
      'a non-fast-forward push',
      'green-checkpoint push failed: green candidate 6653fb41543d was NOT published to origin/main. ' +
        'git push origin 6653fb41543d:refs/heads/main exited 128: ' +
        '! [rejected] main -> main (non-fast-forward)',
    ],
    [
      'a network failure during push',
      'green-checkpoint push failed: green candidate 6653fb41543d was NOT published to origin/main. ' +
        'git push origin 6653fb41543d:refs/heads/main exited 128: ' +
        'fatal: unable to access: Could not resolve host: github.com',
    ],
    [
      'a missing repository',
      'green-checkpoint push failed: green candidate 6653fb41543d was NOT published to origin/main. ' +
        'git push origin 6653fb41543d:refs/heads/main exited 128: ' +
        "fatal: repository 'https://example.com/nope.git/' not found",
    ],
    // A 401/403 that is NOT the promotion push. The discriminator is deliberately anchored on the
    // push wrapper (a string only `pushGreenCandidateOrThrow` emits), so an authorization failure
    // somewhere else in the run must NOT be reported as "this gate can never promote".
    [
      'a 403 outside the push path entirely',
      'Error: setup-release failed: fetching the release manifest: ' +
        "unable to access 'https://example.com/manifest.json': The requested URL returned error: 403",
    ],
  ])('does NOT claim %s as an authorization fault', (_label, detail) => {
    const r = buildTerminalFailureCheckpointResult({
      candidate: '6653fb41543d',
      error: new Error(detail),
      runId: 'run-negative-control',
    });
    expect(r.reason).not.toBe('promotion-unauthorized');
  });
});
