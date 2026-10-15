import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, Worker } from 'node:worker_threads';
import {
  resolveSentinelConfig,
  startEventLoopSentinel,
  SENTINEL_DEFAULTS,
} from './event-loop-sentinel-host';
import { SENTINEL_SAB_INT32_LEN } from './event-loop-sentinel';
import { summarizeHotStacks, type CpuProfileLike } from './event-loop-stall-profile';
import type { SentinelWorkerData } from './event-loop-sentinel.worker';

/** Burns the CALLING thread for `ms`. Named so a profile can point at it. */
function sentinelTestSpinHotPath(ms: number): number {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) {
    for (let i = 0; i < 1_000; i++) x += Math.sqrt(x + i);
  }
  return x;
}

/**
 * esbuild the real worker to a standalone `.mjs` — the SAME artifact
 * `bundle-host.sh` ships to the bundled host. Returns null (test skips) if the
 * local esbuild binary is absent, so this never fails for an environment
 * reason. ~20ms in practice.
 */
function buildWorkerMjs(footer?: string): string | null {
  const repoRoot = resolve(__dirname, '../../..');
  const esbuild = join(repoRoot, 'node_modules/.bin/esbuild');
  const src = resolve(__dirname, 'event-loop-sentinel.worker.ts');
  if (!existsSync(esbuild) || !existsSync(src)) return null;
  const out = join(mkdtempSync(join(tmpdir(), 'sentinel-worker-')), 'w.mjs');
  try {
    execFileSync(
      esbuild,
      [
        src,
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--target=node22',
        `--outfile=${out}`,
        ...(footer ? [`--footer:js=${footer}`] : []),
      ],
      { stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' },
    );
  } catch {
    return null;
  }
  return existsSync(out) ? out : null;
}

describe('resolveSentinelConfig', () => {
  it('is ARMED by default — a detector that ships disabled is never turned on', () => {
    expect(resolveSentinelConfig({}).mode).toBe('kill');
  });

  it.each(['0', 'off', 'false', 'OFF', ' Off '])('%s disables it', (v) => {
    expect(resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL: v }).mode).toBe('off');
  });

  it('observe detects and logs but never kills', () => {
    expect(
      resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' }).mode,
    ).toBe('observe');
  });

  it('an unrecognised value stays ARMED rather than silently disabling', () => {
    // Failing open here is deliberate: a typo must not quietly remove the
    // watchdog, which is the failure mode that leaves nobody watching.
    expect(resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL: 'yes' }).mode).toBe(
      'kill',
    );
  });

  it('honours a wedge-threshold override', () => {
    const c = resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL_WEDGE_MS: '45000' });
    expect(c.thresholds.wedgeAfterMs).toBe(45_000);
  });

  it.each(['0', '-1', 'abc', '', 'NaN'])(
    'a bad wedge override (%s) falls back to the safe default, never to 0',
    (v) => {
      // A 0 ms threshold would kill on the first observation. The parse must
      // degrade to the default rather than to the most dangerous value.
      const c = resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL_WEDGE_MS: v });
      expect(c.thresholds.wedgeAfterMs).toBe(SENTINEL_DEFAULTS.wedgeAfterMs);
    },
  );

  it('the default wedge threshold sits far above measured normal loop lag', () => {
    // Worst observed legitimate event-loop lag on this host is ~3475 ms
    // (round-3 cpuprofile captures). A threshold near that would make the
    // sentinel a random killer, so assert the margin explicitly.
    expect(SENTINEL_DEFAULTS.wedgeAfterMs).toBeGreaterThan(3475 * 4);
    // And a kill needs the debounce too, so the real floor is higher still.
    expect(
      SENTINEL_DEFAULTS.wedgeAfterMs +
        SENTINEL_DEFAULTS.observeIntervalMs * SENTINEL_DEFAULTS.observationsToAct,
    ).toBeGreaterThan(20_000);
  });

  it('the startup grace exceeds the wedge threshold, so boot can never kill', () => {
    expect(SENTINEL_DEFAULTS.startupGraceMs).toBeGreaterThan(
      SENTINEL_DEFAULTS.wedgeAfterMs,
    );
  });
});

describe('startEventLoopSentinel', () => {
  it.each([
    { name: 'inline module', startupArgs: ['--input-type=module'] },
    { name: 'split inline module', startupArgs: ['--input-type', 'module'] },
    { name: 'diagnostic report directory', startupArgs: [`--report-directory=${tmpdir()}`] },
    { name: 'split diagnostic report directory', startupArgs: ['--report-directory', tmpdir()] },
    { name: 'diagnostic report filename', startupArgs: ['--report-filename=sentinel-test.json'] },
    { name: 'split diagnostic report filename', startupArgs: ['--report-filename', 'sentinel-test.json'] },
    { name: 'fatal error diagnostic report', startupArgs: ['--report-on-fatalerror'] },
    { name: 'disabled fatal error diagnostic report', startupArgs: ['--no-report-on-fatalerror'] },
    { name: 'inline module with diagnostic reports', startupArgs: [
      '--input-type=module', `--report-directory=${tmpdir()}`,
      '--report-filename=sentinel-test.json', '--report-on-fatalerror',
    ] },
  ])('keeps the real watcher alive with $name startup flags', ({ startupArgs }) => {
    // Exercise the host constructor, not a Worker with test-only execArgv: [].
    // EI-25465494437288816: inherited --input-type rejects a file-backed worker.
    // EI-25526230785366035: process-wide report flags reject explicit worker argv.
    const hostUrl = pathToFileURL(resolve(__dirname, 'event-loop-sentinel-host.ts')).href;
    const script = `
      import { startEventLoopSentinel } from ${JSON.stringify(hostUrl)};
      const logs = [];
      const h = startEventLoopSentinel({
        env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
        allowHeartbeatInTest: true,
        log: (line, detail) => logs.push({ line, detail }),
      });
      try {
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log(JSON.stringify({ active: h.active(), alive: h.workerAlive(),
          beats: h.beats(), logs }));
      } finally {
        await h.stop();
      }
    `;
    const result = spawnSync(process.execPath, [
      '--import=tsx', '--no-warnings', ...startupArgs, '--eval', script,
    ], {
      cwd: resolve(__dirname, '../../..'),
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(state.active, JSON.stringify(state.logs)).toBe(true);
    expect(state.alive, JSON.stringify(state.logs)).toBe(true);
    expect(state.beats).toBeGreaterThan(0);
    expect(state.logs.some((entry: { line: string }) => /disabled|EXITED/.test(entry.line))).toBe(false);
  }, 30_000);

  it('preserves inherited loaders and runtime flags in a bundled watcher', () => {
    const built = buildWorkerMjs(`parentPort.postMessage({
      kind: 'sync-spawn-stall', producer: JSON.stringify(process.execArgv),
      producerFn: 'sentinel-launch-test', stack: '', pct: 100
    });`);
    expect(built, 'the bundled-worker fixture must build').not.toBeNull();
    const hostUrl = pathToFileURL(resolve(__dirname, 'event-loop-sentinel-host.ts')).href;
    const script = `
      import { startEventLoopSentinel } from ${JSON.stringify(hostUrl)};
      let workerArgs;
      const h = startEventLoopSentinel({
        env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
        workerPath: ${JSON.stringify(built)}, log: () => {},
        onSyncSpawnStall: message => { workerArgs = JSON.parse(message.producer); },
      });
      try {
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log(JSON.stringify({ alive: h.workerAlive(), workerArgs }));
      } finally { await h.stop(); }
    `;
    const result = spawnSync(process.execPath, [
      '--import=tsx', '--no-warnings', '--input-type=module',
      `--report-directory=${tmpdir()}`, '--report-filename=sentinel-test.json',
      '--report-on-fatalerror', '--report-on-signal', '--report-signal=SIGUSR2',
      '--report-uncaught-exception', '--eval', script,
    ], {
      cwd: resolve(__dirname, '../../..'),
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(state.alive).toBe(true);
    expect(state.workerArgs).toContain('--import=tsx');
    expect(state.workerArgs).toContain('--no-warnings');
    expect(state.workerArgs).not.toContain('--input-type=module');
    expect(state.workerArgs).not.toContain(`--report-directory=${tmpdir()}`);
    expect(state.workerArgs).not.toContain('--report-filename=sentinel-test.json');
    expect(state.workerArgs).not.toContain('--report-on-fatalerror');
    expect(state.workerArgs).toContain('--report-on-signal');
    expect(state.workerArgs).toContain('--report-signal=SIGUSR2');
    expect(state.workerArgs).toContain('--report-uncaught-exception');
  }, 30_000);

  it('wires blocked-directory attribution into the real worker kill diagnostic', () => {
    // EI-22803283447097859: the worker knew the main thread was in
    // `iterate_dir`, but its last log did not name the directory and ptrace was
    // denied after the restart. Pin both halves of the detector: syscall arg0
    // must resolve through the live fd table, and the resulting path must be
    // included in the fields shared by STALLED and WEDGED emissions.
    const source = readFileSync(resolve(__dirname, 'event-loop-sentinel.worker.ts'), 'utf8');
    expect(source).toContain('parseProcDirectoryFd');
    expect(source).toContain('readlinkSync(`/proc/${pid}/fd/${fd}`)');
    expect(source).toContain('mainThreadBlockedDirectory');
    expect(source).toContain('Object.assign(out, readMainThreadDirectoryWait(wchan))');
  });

  it('captures live children before the zero-CPU block-mode classifier', () => {
    // EI-24367382715904715: the staging host changed from anon_pipe_read to
    // ep_poll and consumed partial CPU before SIGKILL. The former conditional
    // child read left the kill record without the operation to investigate.
    const source = readFileSync(resolve(__dirname, 'event-loop-sentinel.worker.ts'), 'utf8');
    const activity = source.slice(source.indexOf('function mainThreadActivity()'));
    expect(activity.indexOf('const children = readMainThreadChildren();')).toBeGreaterThan(0);
    expect(activity.indexOf('const children = readMainThreadChildren();')).toBeLessThan(
      activity.indexOf('if (isLikelySyncSubprocessBlock(activity))'),
    );
    expect(activity).toContain('if (children.length) out.mainThreadLiveChildren = children.join');
  });

  it('mode=off spawns nothing and reports inactive', () => {
    const lines: string[] = [];
    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'off' },
      log: (l) => lines.push(l),
    });
    expect(h.active()).toBe(false);
    expect(h.beats()).toBe(0);
    expect(h.sab).toBeNull();
    expect(lines.join(' ')).toContain('disabled');
  });

  it('NEVER throws, whatever the runtime does to the worker', async () => {
    // The hard requirement: a watchdog must not be able to take down the host
    // it protects. Whether the worker spawns in THIS runtime is not the point —
    // that it degrades quietly rather than throwing is.
    const lines: string[] = [];
    let h: ReturnType<typeof startEventLoopSentinel> | undefined;
    expect(() => {
      h = startEventLoopSentinel({ env: {}, log: (l) => lines.push(l) });
    }).not.toThrow();
    await h!.stop();
  });

  it('REGRESSION: the worker thread stays ALIVE — it must not exit on its own', async () => {
    // The bug this guards (measured 2026-08-04): a `timer.unref()` inside the
    // worker left its event loop with no handle, so the thread exited cleanly
    // with code 0 immediately after reporting ready. The host still logged
    // "armed", active() still returned true, and the sentinel was silently
    // absent.
    //
    // Two reasons the ORIGINAL tests could not catch it, both worth knowing:
    //  - `beats()` is incremented by the MAIN thread, so it keeps ticking
    //    happily whether or not anything is watching it.
    //  - `new Worker(...)` does NOT throw on an unloadable path; the failure
    //    arrives asynchronously on 'error'. So `active()` only ever meant "the
    //    constructor returned", never "a watcher is running".
    //
    // This is the work-item's own class turned on the sentinel itself: a guard
    // that reports healthy while not running.
    //
    // Must run the REAL worker, and the `.ts` form only loads under tsx — a
    // plain-node Worker (vitest's pool) cannot resolve its extensionless
    // import. So build the same artifact the bundled host ships and use that.
    const built = buildWorkerMjs();
    if (!built) return; // esbuild unavailable — covered by the never-throws test

    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
      workerPath: built,
    });
    try {
      expect(h.active()).toBe(true);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(h.workerAlive()).toBe(true);
    } finally {
      await h.stop();
    }
  }, 30_000);

  /**
   * WI-10004766 / WI-10003454: the in-stall profile, end to end — the REAL
   * worker, a really blocked main thread, a real `.cpuprofile`.
   *
   * Both `connectToMainThread()` and `/proc/<pid>/task/<pid>` describe the
   * PROCESS main thread, so this only means something when the test itself runs
   * there (vitest's forks pool). Under a threads pool it would profile an idle
   * thread and prove nothing, so it skips instead.
   */
  async function runStallTrial(block: () => void): Promise<{ dir: string; files: string[] }> {
    const built = buildWorkerMjs();
    if (!built) throw new Error('esbuild unavailable');
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-stall-'));
    const sab = new SharedArrayBuffer(SENTINEL_SAB_INT32_LEN * Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(sab);
    const data: SentinelWorkerData = {
      sab,
      // Observe mode, no grace, a wedge threshold the trial never reaches.
      thresholds: { wedgeAfterMs: 60_000, observationsToAct: 3, startupGraceMs: 0 },
      observeIntervalMs: 100,
      mode: 'observe',
      pid: process.pid,
      stallProfile: { dir, afterMs: 400, captureMs: 500, cooldownMs: 60_000, maxProfiles: 5 },
    };
    const worker = new Worker(built, { workerData: data });
    try {
      await new Promise<void>((r) => worker.once('message', () => r()));
      // A moving heartbeat first, so the worker has a live counter and a CPU baseline.
      for (let i = 0; i < 6; i++) {
        Atomics.add(view, 0, 1);
        await new Promise((r) => setTimeout(r, 100));
      }
      block();
      // The worker writes the file on ITS thread during the block; allow a
      // short tail for a capture that straddled the block's end. The heartbeat
      // RESUMES here, as on a real host: without it the "stall" would continue
      // through this polling loop, where a 100 ms observe window turns one
      // 10 ms clock tick of runner noise into 0.1 cores ('partial') and
      // captures something that is not the block under test.
      const deadline = Date.now() + 3_000;
      let files: string[] = [];
      while (Date.now() < deadline) {
        Atomics.add(view, 0, 1);
        files = readdirSync(dir).filter((f) => f.startsWith('stall-') && f.endsWith('.cpuprofile'));
        if (files.length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { dir, files };
    } finally {
      await worker.terminate();
    }
  }

  it('WI-10004766: profiles a SPINNING main thread mid-stall and points at the spinning code', async () => {
    if (process.platform !== 'linux' || !isMainThread || !buildWorkerMjs()) return;
    const { dir, files } = await runStallTrial(() => sentinelTestSpinHotPath(2_500));
    expect(files).toHaveLength(1);
    const profile = JSON.parse(readFileSync(join(dir, files[0]), 'utf8')) as CpuProfileLike;
    const summary = summarizeHotStacks(profile, { depth: 6 });
    // ~500 samples at V8's 1 ms default; a much lower count means the capture
    // ran mostly after the block, i.e. it did not see the stall.
    expect(summary.samples).toBeGreaterThan(200);
    // The FILE, not the function name: V8 may inline the spin into its caller
    // (measured in the probe), which removes the name but never the url.
    expect(summary.hot[0].stack).toContain('event-loop-sentinel-host.test');
    expect(summary.hot[0].pct).toBeGreaterThan(50);
  }, 60_000);

  it('CONTROL: a PARKED main thread recovering from a futex wait is not profiled', async () => {
    if (process.platform !== 'linux' || !isMainThread || !buildWorkerMjs()) return;
    const { files } = await runStallTrial(() => {
      // The inspector reply is queued behind this native wait. Resuming the
      // heartbeat must discard that late reply rather than profile recovery.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);
    });
    expect(files).toEqual([]);
  }, 60_000);

  /** Run the real sentinel against a child main thread, retaining its fd-2 evidence. */
  function runParkedDiagnosticTrial(kind: 'idle' | 'blocked' | 'recovered', mode = 'observe') {
    const built = buildWorkerMjs();
    if (!built) throw new Error('esbuild unavailable');
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-parked-'));
    const script = `
      import { Worker } from 'node:worker_threads';
      const sab = new SharedArrayBuffer(${SENTINEL_SAB_INT32_LEN} * 4);
      const view = new Int32Array(sab);
      const worker = new Worker(${JSON.stringify(built)}, { execArgv: [], workerData: {
        sab, pid: process.pid, mode: ${JSON.stringify(mode)}, observeIntervalMs: 100,
        thresholds: { wedgeAfterMs: 1500, observationsToAct: 2, startupGraceMs: 0 },
        stallProfile: { dir: ${JSON.stringify(dir)}, afterMs: 400, captureMs: 500,
          cooldownMs: 60000, maxProfiles: 5 }
      }});
      await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      for (let i = 0; i < 6; i++) {
        Atomics.add(view, 0, 1);
        await new Promise(r => setTimeout(r, 100));
      }
      if (${JSON.stringify(kind)} === 'idle') {
        // Timers still run; only the sentinel heartbeat is missing.
        await new Promise(r => setTimeout(r, 2000));
      } else {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
          ${kind === 'blocked' ? 4500 : 1500});
      }
      Atomics.add(view, 0, 1);
      const heartbeat = setInterval(() => Atomics.add(view, 0, 1), 100);
      await new Promise(r => setTimeout(r, 600));
      clearInterval(heartbeat);
      await worker.terminate();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status === 0 || result.signal === 'SIGKILL', result.stderr).toBe(true);
    return {
      status: result.status,
      signal: result.signal,
      stderr: result.stderr,
      files: readdirSync(dir).filter(f => f.startsWith('stall-') && f.endsWith('.cpuprofile')),
    };
  }

  it.skipIf(process.platform !== 'linux')('WI-10005529: identifies a responsive parked main with a missing heartbeat', () => {
    const result = runParkedDiagnosticTrial('idle');
    expect(result.status).toBe(0);
    expect(result.files, result.stderr).toHaveLength(1);
    expect(result.stderr).toContain('mainThreadInspectorResponse: responsive');
    expect(result.stderr).toContain('mainThreadEventLoopResponse: responsive');
    expect(result.stderr).toContain('mainThreadActivity: parked');
    expect(result.stderr).toContain('STALL profiled');
  }, 30_000);

  it.skipIf(process.platform !== 'linux')('WI-10005529: bounds an unanswered parked probe while observations continue', () => {
    const result = runParkedDiagnosticTrial('blocked');
    expect(result.status).toBe(0);
    expect(result.files, result.stderr).toEqual([]);
    expect(result.stderr).toContain('mainThreadEventLoopResponse: not-answered');
    expect(result.stderr).toContain('Runtime.evaluate not answered within 3000ms');
    expect(result.stderr).toContain('WEDGED — observe mode, NOT killing');
    // WI-10006344: an unanswered probe names where the main thread is blocked
    // (here Atomics.wait = an interruptible futex sleep), on the failure line itself.
    const failed = result.stderr.split('\n').find(l => l.includes('STALL profile capture failed'));
    expect(failed, result.stderr).toBeDefined();
    expect(failed).toContain('mainThreadState: S');
  }, 30_000);

  it.skipIf(process.platform !== 'linux')('WI-10005529: discards a probe answered only after heartbeat recovery', () => {
    const result = runParkedDiagnosticTrial('recovered');
    expect(result.status).toBe(0);
    expect(result.files, result.stderr).toEqual([]);
    expect(result.stderr).toContain('STALL profile discarded — heartbeat recovered before profiler start');
    expect(result.stderr).not.toContain('STALL profiled');
  }, 30_000);

  it.skipIf(process.platform !== 'linux')('WI-10005529: inspector responsiveness does not suppress the existing kill policy', () => {
    const result = runParkedDiagnosticTrial('idle', 'kill');
    expect(result.signal).toBe('SIGKILL');
    expect(result.stderr).toContain('mainThreadInspectorResponse: responsive');
    expect(result.stderr).toContain('mainThreadEventLoopResponse: responsive');
    expect(result.stderr).toContain('WEDGED — SIGKILLing the host');
  }, 30_000);

  it('CONTROL: re-introducing the unref bug DOES trip the regression test above', async () => {
    // A guard that has never failed is a guard nobody has tested. Rebuild the
    // worker with the exact defect restored — `timer.unref()` at module scope,
    // injected via esbuild's --footer — and assert workerAlive() goes false.
    // Without this, the test above would still pass if workerAlive() were
    // hard-wired to true, or if the worker never spawned at all.
    //
    // The mutation is applied to a BUILT COPY in a temp dir, never to the tree:
    // git-sync sweeps the whole working tree every few minutes, so a source
    // file held mutated for the duration of a test can be committed by a sweep
    // that lands mid-run (CLAUDE.md, "Proving a guard is falsifiable").
    const mutant = buildWorkerMjs('timer.unref?.();');
    if (!mutant) return;

    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
      workerPath: mutant,
    });
    try {
      await new Promise((r) => setTimeout(r, 1_500));
      expect(h.workerAlive()).toBe(false);
    } finally {
      await h.stop();
    }
  }, 30_000);

  it('when active, the heartbeat actually advances the shared counter', async () => {
    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
      allowHeartbeatInTest: true,
    });
    try {
      if (!h.active()) return; // spawn unsupported here — covered by the test above
      const before = h.beats();
      await new Promise((r) => setTimeout(r, 2_500));
      // If this fails, the SAB wiring is broken and the sentinel would read a
      // permanently frozen counter — i.e. it would think the loop is wedged.
      expect(h.beats()).toBeGreaterThan(before);
    } finally {
      await h.stop();
    }
  }, 10_000);

  it('EI-19484853609145439: the SAB is sized for SENTINEL_SAB_IDX (heartbeat + last-known lag), not just the heartbeat', async () => {
    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
    });
    try {
      if (!h.active()) return; // spawn unsupported here — covered by the test above
      expect(h.sab).not.toBeNull();
      const { SENTINEL_SAB_INT32_LEN } = await import('./event-loop-sentinel');
      expect(h.sab!.byteLength).toBe(SENTINEL_SAB_INT32_LEN * Int32Array.BYTES_PER_ELEMENT);
      // Index 0 (the heartbeat) must still be the same live counter `beats()`
      // reads — extending the SAB must not shift the existing layout.
      const view = new Int32Array(h.sab!);
      expect(Atomics.load(view, 0)).toBe(h.beats());
    } finally {
      await h.stop();
    }
  }, 10_000);
});
