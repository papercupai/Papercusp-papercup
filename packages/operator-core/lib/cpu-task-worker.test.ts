/**
 * cpu-task-worker.test.ts — protocol contract + functional tests for the
 * worker-thread CPU offload module.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 *
 * What's tested here:
 *   - API surface (exports exist with right types)
 *   - Initial module state (nothing spawned)
 *   - serializeJsonResponse: small-batch sync fallback path
 *   - serializeJsonResponse: large-batch worker path (end-to-end)
 *   - BigInt→Number coercion on both paths
 *   - that the output is NEVER compressed (inverse guard, 2026-07-26)
 *   - getCpuWorkerState diagnostics
 *   - _resetCpuWorker test seam
 *
 * The worker script (.mjs) is co-located — no external dep needed.
 * All tests run in Node via vitest, so worker_threads is available.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Dynamic import lets afterEach reset module state between tests.
async function mod() {
  return import('./cpu-task-worker');
}

afterEach(async () => {
  const m = await mod();
  await m._resetCpuWorker();
});

describe('cpu-task-worker — repository census guard', () => {
  it('packages the parser in the shipped worker without repository node_modules', async () => {
    const { build } = await import('esbuild');
    const shippingScript = readFileSync(resolve(__dirname, '../../../apps/operator/bin/bundle-host-common.sh'), 'utf8');
    const workerBlock = shippingScript.slice(shippingScript.indexOf('if [ "$output" = "cpu-task-worker.script.mjs" ]; then'));
    const shippingBanner = /--banner:js="([^"]+)"/.exec(workerBlock)?.[1];
    expect(shippingBanner, 'the CPU worker must use its maintained shipping banner').toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'cpu-worker-package-'));
    const output = join(dir, 'cpu-task-worker.script.mjs');
    let worker: Worker | undefined;
    try {
      await build({
        entryPoints: [resolve(__dirname, 'cpu-task-worker.script.mjs')],
        outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
        banner: { js: shippingBanner! },
      });
      const verdict = await new Promise<unknown>((resolveReply, reject) => {
        const replies: unknown[] = [];
        worker = new Worker(output);
        worker.on('error', reject);
        worker.on('message', (message) => {
          if (message.kind === 'ready') worker!.postMessage({
            kind: 'broad_tree_scan', id: 1,
            source: "const APP_ROOTS = []; function walk() { return readdir(APP_ROOTS); }",
          });
          else {
            replies.push(message);
            if (message.id === 1) worker!.postMessage({
              kind: 'broad_tree_scan', id: 2,
              source: "// ROOTS walk readdirSync()\nconst fixture = 'ROOTS walk readdirSync()';",
            });
            else resolveReply(replies);
          }
        });
      });
      expect(verdict, JSON.stringify(verdict)).toMatchObject([
        { kind: 'broad_tree_scan_ok', id: 1, broadTreeScan: true },
        { kind: 'broad_tree_scan_ok', id: 2, broadTreeScan: false },
      ]);
    } finally {
      await worker?.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects traversal identifiers and calls but ignores comments and string fixtures', async () => {
    const m = await mod();
    expect(await m.detectBroadRepoTreeScanOffThread(
      "const REPO_ROOTS = ['src']; function walk() { return fs.readdirSync(REPO_ROOTS[0]); }",
    )).toBe(true);
    expect(await m.detectBroadRepoTreeScanOffThread(
      "// REPO_ROOTS walk readdirSync()\nconst fixture = 'REPO_ROOTS walk readdirSync()';",
    )).toBe(false);
    expect(await m.detectBroadRepoTreeScanOffThread(
      "const FIXTURE_DIRS = ['fixtures']; fs.readdirSync(FIXTURE_DIRS[0]);",
    )).toBe(false);
  });

  it('distinguishes fresh fixture roots returned by a helper from repository census roots', async () => {
    const m = await mod();
    const fixtureInventory = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-'));
  const donor = path.join(root, 'donor');
  return { root, donor };
}
function inventory(root) {
  function visit(file) { for (const name of fs.readdirSync(file)) visit(path.join(file, name)); }
  visit(root);
}
const f = fixture();
const runRoot = path.join(f.root, 'graph');
inventory(f.donor);
`;
    expect(await m.detectBroadRepoTreeScanOffThread(fixtureInventory)).toBe(false);
    expect(await m.detectBroadRepoTreeScanOffThread(fixtureInventory + `
const REPO_ROOTS = ['packages']; REPO_ROOTS.forEach(inventory);
`)).toBe(true);
    // A local same-name binding must not borrow the outer fixture's provenance.
    expect(await m.detectBroadRepoTreeScanOffThread(fixtureInventory + `
function census(runRoot) { inventory(runRoot); } census(process.cwd());
`)).toBe(true);
  });

  it.each([
    "let runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-'));",
    "const runRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-')), '..', 'repo');",
    "const runRoot = fs.mkdtempSync(path.join(process.cwd(), 'fixture-'));",
    "const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-')); runRoot.path = process.cwd();",
    "const fs = { mkdtempSync: () => process.cwd() }; const runRoot = fs.mkdtempSync();",
  ])('keeps ambiguous or mutable root provenance conservative: %s', async declaration => {
    const m = await mod();
    const namespaces = declaration.startsWith('const fs =') ? '' : "const fs = require('node:fs');";
    expect(await m.detectBroadRepoTreeScanOffThread(`
${namespaces} const os = require('node:os'), path = require('node:path');
${declaration}
function walk(root) { return readdirSync(root); } walk(runRoot);
`)).toBe(true);
  });

  it('serves a main-thread heartbeat while parsing a large source and still returns the guard verdict', async () => {
    const m = await mod();
    await m.detectBroadRepoTreeScanOffThread('const small = 1;');
    const source = Array.from({ length: 30_000 }, (_, i) => `const value${i} = ${i};`).join('\n')
      + "\nconst APP_ROOTS = ['src']; function walk() { return readdir(APP_ROOTS[0]); }";
    let settled = false;
    const scan = m.detectBroadRepoTreeScanOffThread(source).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(await scan).toBe(true);
    expect(m.getCpuWorkerState().pendingCount).toBe(0);
  });

  it('rejects unavailable analysis instead of falling back to main-thread parsing', async () => {
    const m = await mod();
    await m.detectBroadRepoTreeScanOffThread('const small = 1;');
    const spawn = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(() => {
      throw new Error('analysis transport unavailable');
    });
    try {
      await expect(m.detectBroadRepoTreeScanOffThread('const small = 1;'))
        .rejects.toThrow('analysis transport unavailable');
      expect(m.getCpuWorkerState().pendingCount).toBe(0);
    } finally { spawn.mockRestore(); }
  });

  it('rejects oversized sources before spawning or cloning them', async () => {
    const m = await mod();
    await expect(m.detectBroadRepoTreeScanOffThread('x'.repeat(m.TREE_SCAN_MAX_SOURCE_CHARS + 1)))
      .rejects.toThrow('source exceeds');
    expect(m.getCpuWorkerState()).toMatchObject({ alive: false, pendingCount: 0 });
  });

  it('bounds admission during startup and settles every waiter when ready never arrives', async () => {
    const m = await mod();
    const emit = Worker.prototype.emit;
    const delivery = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event, ...args) {
      if (event === 'message' && args[0]?.kind === 'ready') return true;
      return emit.call(this, event, ...args);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const admitted = Array.from({ length: m.TREE_SCAN_MAX_REQUESTS }, () =>
        m.detectBroadRepoTreeScanOffThread('const small = 1;'));
      const settled = Promise.allSettled(admitted);
      await expect(m.detectBroadRepoTreeScanOffThread('const extra = 1;'))
        .rejects.toThrow('admission limit');
      await vi.advanceTimersByTimeAsync(m.TREE_SCAN_DEADLINE_MS);
      for (const result of await settled) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason.message).toContain('deadline exceeded');
      }
      expect(m.getCpuWorkerState()).toMatchObject({ alive: false, pendingCount: 0, keepAlive: false });
    } finally {
      vi.useRealTimers();
      delivery.mockRestore();
      errors.mockRestore();
    }
    // Admission is released after failure, and the next actual worker serves.
    expect(await m.detectBroadRepoTreeScanOffThread('const small = 1;')).toBe(false);
  });

  it('terminates a timed-out real parser job and ignores its late exit after replacement', async () => {
    const m = await mod();
    await m.detectBroadRepoTreeScanOffThread('const small = 1;');
    let oldWorker: Worker | undefined;
    const postMessage = Worker.prototype.postMessage;
    const posts = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, ...args) {
      oldWorker = this;
      return postMessage.call(this, message, ...args);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const source = Array.from({ length: 30_000 }, (_, i) => `const value${i} = ${i};`).join('\n');
      const scan = m.detectBroadRepoTreeScanOffThread(source);
      const failed = expect(scan).rejects.toThrow('deadline exceeded');
      await Promise.resolve(); // The real thread receives the source before expiry.
      expect(oldWorker).toBeDefined();
      vi.advanceTimersByTime(m.TREE_SCAN_DEADLINE_MS);
      await failed;
      expect(m.getCpuWorkerState()).toMatchObject({ alive: false, pendingCount: 0 });
      vi.useRealTimers();
      posts.mockRestore();
      const replacement = m.detectBroadRepoTreeScanOffThread(
        'const APP_ROOTS = []; function walk() { return readdir(APP_ROOTS); }',
      );
      oldWorker!.emit('exit', 1); // Delayed completion from the retired generation.
      expect(await replacement).toBe(true);
      expect(m.getCpuWorkerState()).toMatchObject({ alive: true, pendingCount: 0 });
      expect(JSON.parse(await m.serializeJsonResponse({ ok: true }, m.OFFLOAD_MIN_ITEMS)))
        .toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
      posts.mockRestore();
      errors.mockRestore();
    }
  });
});

describe('cpu-task-worker — API surface', () => {
  it('exports the expected functions', async () => {
    const m = await mod();
    expect(typeof m.serializeJsonResponse).toBe('function');
    expect(typeof m._resetCpuWorker).toBe('function');
    expect(typeof m.getCpuWorkerState).toBe('function');
    expect(typeof m.OFFLOAD_MIN_ITEMS).toBe('number');
  });

  it('getCpuWorkerState starts in idle state', async () => {
    const m = await mod();
    const s = m.getCpuWorkerState();
    expect(s.alive).toBe(false);
    expect(s.disabled).toBe(false);
    expect(s.pendingCount).toBe(0);
    expect(typeof s.minItems).toBe('number');
  });
});

describe('cpu-task-worker — sync fallback (small batch)', () => {
  it('returns a JSON string for a small batch', async () => {
    const m = await mod();
    // itemCount < OFFLOAD_MIN_ITEMS → sync fallback
    const body = await m.serializeJsonResponse({ results: [1, 2, 3] }, 1);
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toEqual({ results: [1, 2, 3] });
  });

  it('converts BigInt values to Number in the sync path', async () => {
    const m = await mod();
    const body = await m.serializeJsonResponse({ id: BigInt('9007199254740993') }, 1);
    const parsed = JSON.parse(body) as { id: number };
    // BigInt 9007199254740993n converts to Number 9007199254740992 (JS precision limit)
    expect(typeof parsed.id).toBe('number');
  });

  // INVERSE guard (2026-07-26): this module used to gzip large payloads. It
  // must not again — the operator is a loopback desktop sidecar, so
  // compression is pure CPU for bytes that never leave the machine, and the
  // gzipSync it replaced was itself a ~50–100 ms main-thread block.
  it('returns an uncompressed string even for a large payload', async () => {
    const m = await mod();
    // Comfortably over the old 1024-byte gzip threshold.
    const bigArray = Array.from({ length: 100 }, (_, i) => ({ index: i, value: 'x'.repeat(20) }));
    const body = await m.serializeJsonResponse({ rows: bigArray }, 1);
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(1024);
    // Parseable directly — no decompression step exists.
    const parsed = JSON.parse(body) as { rows: typeof bigArray };
    expect(parsed.rows.length).toBe(100);
  });
});

describe('cpu-task-worker — worker thread path (large batch)', () => {
  it('serializes a large batch via the worker and returns JSON string', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({ id: i }));
    const body = await m.serializeJsonResponse({ rows }, rows.length);
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body) as { rows: typeof rows };
    expect(parsed.rows.length).toBe(rows.length);
  });

  // INVERSE guard — the worker path must not reintroduce compression either.
  it('returns an uncompressed string from the worker path for a large payload', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({
      id: i,
      data: 'x'.repeat(50),
    }));
    const body = await m.serializeJsonResponse({ rows }, rows.length);
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body) as { rows: typeof rows };
    expect(parsed.rows.length).toBe(rows.length);
  });

  it('converts BigInt values to Number via the worker path', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({
      id: BigInt(i),
      name: `row-${i}`,
    }));
    const body = await m.serializeJsonResponse({ rows }, rows.length);
    const parsed = JSON.parse(body) as { rows: { id: number; name: string }[] };
    // All BigInt ids must have been coerced to Number
    for (const row of parsed.rows) {
      expect(typeof row.id).toBe('number');
    }
  });

  it('after a large-batch call, getCpuWorkerState shows worker alive', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({ id: i }));
    await m.serializeJsonResponse({ rows }, rows.length);
    const s = m.getCpuWorkerState();
    // Worker should have been spawned and stay alive.
    expect(s.alive || s.disabled).toBe(true);
  });
});

describe('cpu-task-worker — _resetCpuWorker test seam', () => {
  it('returns state to fully idle after reset', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({ id: i }));
    await m.serializeJsonResponse({ rows }, rows.length);
    await m._resetCpuWorker();
    const s = m.getCpuWorkerState();
    expect(s.alive).toBe(false);
    expect(s.disabled).toBe(false);
    expect(s.pendingCount).toBe(0);
  });
});

/**
 * WI-37688 — the three transient-failure traps this module inherited from
 * local-embedder-worker.ts. Each of these failed before the fix:
 *   - a single crash left `disabled` latched on forever
 *   - an in-flight request was dropped without settling
 *   - the worker was never unref'd, so a one-off process could not exit
 */
describe('cpu-task-worker — transient-failure recovery (WI-37688)', () => {
  /** A batch big enough to take the worker path. */
  function bigBatch(m: { OFFLOAD_MIN_ITEMS: number }) {
    return Array.from({ length: m.OFFLOAD_MIN_ITEMS + 1 }, (_, i) => ({ id: i }));
  }

  it('a single worker crash does NOT disable the offload, and the next call respawns', async () => {
    const m = await mod();
    const rows = bigBatch(m);
    // EI-20505664003243915: every crash is now logged with its cause, including
    // a transient one that never trips the breaker. Asserted rather than merely
    // silenced — these are precisely the crashes that used to vanish, leaving a
    // later trip with nothing to explain it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await m.serializeJsonResponse({ rows }, rows.length);
    expect(m.getCpuWorkerState().alive).toBe(true);

    expect(m._injectWorkerCrashForTest(new Error('transient boom'))).toBe(true);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('transient boom');

    // The latch is the defect: one transient crash must not turn the offload
    // off for the rest of the process lifetime.
    const afterCrash = m.getCpuWorkerState();
    expect(afterCrash.disabled).toBe(false);
    expect(afterCrash.alive).toBe(false);

    // ...and the very next call must self-heal by respawning.
    const json = await m.serializeJsonResponse({ rows }, rows.length);
    expect(JSON.parse(json)).toEqual({ rows });
    const healed = m.getCpuWorkerState();
    expect(healed.alive).toBe(true);
    expect(healed.disabled).toBe(false);
    // A success resets the crash run — otherwise unrelated crashes spread out
    // over a long-lived process would eventually trip the breaker.
    expect(healed.consecutiveCrashes).toBe(0);
    errSpy.mockRestore();
  });

  it('a crash run BROKEN BY a served request does not trip the breaker', async () => {
    const m = await mod();
    const rows = bigBatch(m);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Crash, serve, crash, serve, crash... A worker that is answering
    // requests is working, however flaky — it must keep being respawned.
    for (let i = 0; i < 4; i++) {
      const json = await m.serializeJsonResponse({ rows }, rows.length);
      expect(JSON.parse(json)).toEqual({ rows });
      expect(m._injectWorkerCrashForTest(new Error(`flaky ${i}`))).toBe(true);
      expect(m.getCpuWorkerState().consecutiveCrashes).toBe(1);
    }
    expect(m.getCpuWorkerState().disabled).toBe(false);
    // A flaky-but-serving worker leaves a per-crash trail: the state resets, so
    // without the log there would be no evidence it is degrading at all.
    expect(errSpy.mock.calls.flat().join(' ')).toContain('flaky 3');
    errSpy.mockRestore();
  });

  it('gives up after a run of crashes that serve NOTHING, so a broken worker is not respawned per request', async () => {
    const m = await mod();
    const rows = bigBatch(m);
    // WI-37700: the trip is now ANNOUNCED, so the log line is expected here rather
    // than incidental — assert it instead of suppressing it (a silenced spy would
    // let the announcement be deleted with this suite still green, which is the one
    // property the announcement has to have).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Remove the answer so every spawned worker goes ready and then serves
    // nothing — the "spawns fine, dies on every message" case the breaker
    // exists for.
    const realPost = Worker.prototype.postMessage;
    (Worker.prototype as unknown as { postMessage: () => void }).postMessage = () => {};

    try {
      for (let i = 0; i < 3; i++) {
        const inFlight = m.serializeJsonResponse({ rows }, rows.length);
        // Wait for the request to actually be in flight rather than sleeping
        // a guessed interval.
        for (let t = 0; t < 200 && m.getCpuWorkerState().pendingCount === 0; t++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(m.getCpuWorkerState().pendingCount).toBe(1);
        expect(m._injectWorkerCrashForTest(new Error(`boom ${i}`))).toBe(true);
        await inFlight; // rejected internally, answered by the sync fallback
      }
    } finally {
      (Worker.prototype as unknown as { postMessage: typeof realPost }).postMessage =
        realPost;
    }

    // Still CORRECT — the sync fallback answers — but the offload has been
    // given up on rather than respawned on every single request.
    expect(m.getCpuWorkerState()).toMatchObject({ disabled: true, consecutiveCrashes: 3 });
    const json = await m.serializeJsonResponse({ rows }, rows.length);
    expect(JSON.parse(json)).toEqual({ rows });

    // WI-37700: and it SAID SO, exactly once, naming the cause. Before this the trip
    // was byte-identical to healthy operation from the outside.
    const trips = errSpy.mock.calls.filter((c) => String(c[0]).includes('worker-breaker TRIPPED'));
    expect(trips).toHaveLength(1);
    expect(String(trips[0][0])).toContain('cpuWorker');
    expect(String(trips[0][0])).toContain('3 consecutive runtime crashes');
    errSpy.mockRestore();
  });

  it('settles an in-flight request when the worker goes away instead of dropping it', async () => {
    const m = await mod();
    const rows = bigBatch(m);

    // Warm the worker on the real path first, so the request under test is
    // the only thing in flight.
    await m.serializeJsonResponse({ rows }, rows.length);

    // Remove the answer: with postMessage stubbed the worker can never reply,
    // so the request stays pending for as long as we need it to. Hoping the
    // worker is "slow enough" would race it (EI-20053788422725852).
    const realPost = Worker.prototype.postMessage;
    (Worker.prototype as unknown as { postMessage: () => void }).postMessage = () => {};

    let settled = false;
    try {
      const inFlight = m.serializeJsonResponse({ rows }, rows.length).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await new Promise((r) => setTimeout(r, 50));
      // One snapshot, asserted as an invariant object — reading pendingCount
      // and keepAlive in two separate expects is a race, not an assertion.
      expect(m.getCpuWorkerState()).toMatchObject({ pendingCount: 1, keepAlive: true });

      // The worker goes away underneath the in-flight request.
      await m._resetCpuWorker();

      await Promise.race([inFlight, new Promise((r) => setTimeout(r, 2000))]);
      // Pre-fix this was false: the promise never settled and the awaiting
      // HTTP handler in rest-query.ts would never send a response.
      expect(settled).toBe(true);
    } finally {
      (Worker.prototype as unknown as { postMessage: typeof realPost }).postMessage =
        realPost;
    }

    expect(m.getCpuWorkerState()).toMatchObject({ pendingCount: 0, keepAlive: false });
  });

  it('holds the event loop open only while a request is in flight', async () => {
    const m = await mod();
    const rows = bigBatch(m);

    expect(m.getCpuWorkerState()).toMatchObject({ keepAlive: false });
    await m.serializeJsonResponse({ rows }, rows.length);

    // Idle again after the round-trip: the worker is alive but must NOT be
    // holding the loop open, or a one-off process never exits.
    expect(m.getCpuWorkerState()).toMatchObject({ alive: true, keepAlive: false });
  });

  it('filters stdin-only input-type flags before spawning file workers', () => {
    const modulePath = resolve(__dirname, 'cpu-task-worker.ts');
    const source =
      `const { serializeJsonResponse, OFFLOAD_MIN_ITEMS, getCpuWorkerState, _resetCpuWorker } = ` +
      `await import(${JSON.stringify(modulePath)});\n` +
      `const rows = Array.from({ length: OFFLOAD_MIN_ITEMS + 1 }, (_, id) => ({ id }));\n` +
      `await serializeJsonResponse({ rows }, rows.length);\n` +
      `console.log(JSON.stringify(getCpuWorkerState()));\n` +
      `await _resetCpuWorker();\n`;

    for (const inputTypeArgs of [['--input-type=module'], ['--input-type', 'module']]) {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', ...inputTypeArgs],
        {
          cwd: resolve(__dirname, '../../../'),
          // The test runner injects committed-source-loader through NODE_OPTIONS;
          // this child must import the working-tree module under test.
          env: { ...process.env, NODE_OPTIONS: '' },
          input: source,
          encoding: 'utf8',
          timeout: 120_000,
        },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const state = JSON.parse(child.stdout.trim());
      expect(state.servedByWorker).toBeGreaterThan(0);
      expect(state.eligibleFallbacks).toBe(0);
      expect(state.consecutiveCrashes).toBe(0);
    }
  }, 180_000);

  it('lets a host whose event loop is otherwise idle EXIT on its own (child process)', async () => {
    // Ground truth for the test above. `keepAlive` reports what the module
    // last applied to the handle, which is one inference away from the thing
    // that actually matters — whether the process can exit. That gap is not
    // hypothetical: a mutant that stopped ref'ing entirely SURVIVED the
    // in-tree probe against the state assertions alone (WI-37688).
    //
    // The defect only exists when nothing else holds the loop open, which is
    // unreproducible inside vitest — its runner always has work pending. So
    // this spawns a bare host that awaits one serialize and does nothing
    // else, which is every CLI, bench and one-off driver.
    //
    // The discriminating predicate is EXIT, not output: the sync fallback
    // guarantees an answer on every branch, so pre-fix the child printed its
    // marker and then hung forever (measured: `timeout 15` exit 124, with a
    // registered beforeExit handler that never ran).
    const dir = mkdtempSync(join(tmpdir(), 'cpu-task-idle-loop-'));
    try {
      const modulePath = resolve(__dirname, 'cpu-task-worker.ts');
      const child = join(dir, 'idle-host.mts');
      writeFileSync(
        child,
        `const { serializeJsonResponse, OFFLOAD_MIN_ITEMS } = await import(${JSON.stringify(modulePath)});\n` +
          `const rows = Array.from({ length: OFFLOAD_MIN_ITEMS + 1 }, (_, i) => ({ id: i }));\n` +
          `const json = await serializeJsonResponse({ rows }, rows.length);\n` +
          `console.log('CHILD_SERIALIZED len=' + json.length);\n`,
      );

      // A child still holding the loop open never exits, so execFile rejects
      // on its timeout — that rejection IS the failure signal.
      const { stdout } = await promisify(execFile)('npx', ['tsx', child], {
        cwd: resolve(__dirname, '..'),
        timeout: 120_000,
      });

      expect(stdout).toContain('CHILD_SERIALIZED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

/**
 * WI-37700 — the breaker ANNOUNCEMENT seam.
 *
 * WI-37696 made this breaker readable on /api/health/deep. That surface can only ever
 * SAMPLE it: the operator host is a node:cluster reuseport fleet and this module's state
 * is per-process, so one GET reports 1 of N workers. The announcement therefore comes
 * from inside the process that owns the state — which is only worth anything if it fires
 * exactly on the false→true edge and never again.
 *
 * Driven through the CRASH-RUN latch rather than the spawn-failure one because that is
 * the branch a test can actually reach: `new Worker(<bad path>)` reports asynchronously
 * via an 'error' event, so the synchronous catch around the constructor cannot be
 * triggered from here without inventing a production seam to satisfy a test.
 */
describe('cpu-task-worker — breaker announcement (WI-37700)', () => {
  afterEach(async () => {
    const m = await mod();
    m.configureCpuWorkerBreakerNotifier(null);
  });

  /** A batch big enough to take the worker path (local copy — the WI-37688 block's
   *  helper is scoped to that describe, and widening it would couple two suites). */
  function bigBatch(m: { OFFLOAD_MIN_ITEMS: number }) {
    return Array.from({ length: m.OFFLOAD_MIN_ITEMS + 1 }, (_, i) => ({ id: i }));
  }

  /** Drive the breaker to its latch the same way the WI-37688 suite above does. */
  async function tripViaCrashRun(m: Awaited<ReturnType<typeof mod>>): Promise<void> {
    const rows = bigBatch(m);
    const realPost = Worker.prototype.postMessage;
    (Worker.prototype as unknown as { postMessage: () => void }).postMessage = () => {};
    try {
      for (let i = 0; i < 3; i++) {
        const inFlight = m.serializeJsonResponse({ rows }, rows.length);
        for (let t = 0; t < 200 && m.getCpuWorkerState().pendingCount === 0; t++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        m._injectWorkerCrashForTest(new Error(`boom ${i}`));
        await inFlight;
      }
    } finally {
      (Worker.prototype as unknown as { postMessage: typeof realPost }).postMessage = realPost;
    }
  }

  it('notifies exactly once on the false→true edge, naming the worker, cause and pid', async () => {
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    m.configureCpuWorkerBreakerNotifier((s) => seen.push(s));

    await tripViaCrashRun(m);

    expect(m.getCpuWorkerState().disabled).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('cpuWorker');
    expect(seen[0]).toContain('3 consecutive runtime crashes');
    // The pid is what makes a clustered host's report actionable — "one worker of N"
    // is useless without saying which.
    expect(seen[0]).toContain(String(process.pid));

    // Subsequent requests do not re-announce. ⚠ Honest note on WHAT this proves: a
    // mutation probe removing tripBreaker's `if (_workerDisabled) return;` leaves this
    // green, because once latched `serializeJsonResponse` short-circuits to the sync
    // fallback and never re-enters ensureWorker — so the once-only property currently
    // comes from that bypass, not from the guard. This assertion pins the OBSERVABLE
    // behaviour (a permanent degradation announces once, not once per request); the
    // guard itself is documented as defence in depth rather than claimed as tested.
    const rows = bigBatch(m);
    await m.serializeJsonResponse({ rows }, rows.length);
    await m.serializeJsonResponse({ rows }, rows.length);
    expect(seen).toHaveLength(1);

    errSpy.mockRestore();
  });

  it('logs the trip even with NO notifier wired, so an unwired host is not silent', async () => {
    // The log line is the floor and the notifier the improvement: a trip that only ever
    // reached an unwired seam would be exactly as invisible as before this item.
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.configureCpuWorkerBreakerNotifier(null);

    await tripViaCrashRun(m);

    const trips = errSpy.mock.calls.filter((c) => String(c[0]).includes('worker-breaker TRIPPED'));
    expect(trips).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('survives a notifier that throws — a degradation path must not become an error', async () => {
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.configureCpuWorkerBreakerNotifier(() => {
      throw new Error('coord exploded');
    });

    await tripViaCrashRun(m);

    // The latch still set, and the module still serving: this runs inside an HTTP
    // route handler, so a throwing notifier must not turn a survivable fallback into
    // a failed response.
    expect(m.getCpuWorkerState().disabled).toBe(true);
    const rows = bigBatch(m);
    const json = await m.serializeJsonResponse({ rows }, rows.length);
    expect(JSON.parse(json)).toEqual({ rows });
    errSpy.mockRestore();
  });

  it('re-announces after _resetCpuWorker clears the latch and it trips again', async () => {
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    m.configureCpuWorkerBreakerNotifier((s) => seen.push(s));

    await tripViaCrashRun(m);
    await m._resetCpuWorker();
    await tripViaCrashRun(m);

    expect(seen).toHaveLength(2);
    errSpy.mockRestore();
  });
});

describe('cpu-task-worker — breaker re-arm + served detector (EI-20505664003243915)', () => {
  afterEach(async () => {
    const m = await mod();
    m.configureCpuWorkerBreakerNotifier(null);
  });

  function bigBatch(m: { OFFLOAD_MIN_ITEMS: number }) {
    return Array.from({ length: m.OFFLOAD_MIN_ITEMS + 1 }, (_, i) => ({ id: i }));
  }

  /**
   * Drive N crashes with the worker's postMessage stubbed out, so each request
   * stays pending and the injected crash lands on a real in-flight round-trip.
   * Same shape as the WI-37700 block's helper; kept local for the same reason.
   */
  async function crashRun(m: Awaited<ReturnType<typeof mod>>, times: number, label = 'boom') {
    const rows = bigBatch(m);
    const realPost = Worker.prototype.postMessage;
    (Worker.prototype as unknown as { postMessage: () => void }).postMessage = () => {};
    try {
      for (let i = 0; i < times; i++) {
        const inFlight = m.serializeJsonResponse({ rows }, rows.length);
        for (let t = 0; t < 200 && m.getCpuWorkerState().pendingCount === 0; t++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        m._injectWorkerCrashForTest(new Error(`${label} ${i}`));
        await inFlight;
      }
    } finally {
      (Worker.prototype as unknown as { postMessage: typeof realPost }).postMessage = realPost;
    }
  }

  it('carries the CRASH CAUSE into the announcement, not just the crash count', async () => {
    // The defect: `err` was in scope in the 'error' handler and reached only
    // rejectAllPending/rejectReady, both swallowed by serializeJsonResponse's bare
    // catch — so the one durable record of a trip said THAT the worker died and
    // never WHY. The 2026-08-15 trip left no recoverable cause anywhere.
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    m.configureCpuWorkerBreakerNotifier((s) => seen.push(s));

    await crashRun(m, 3, 'ENOMEM-simulated');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('ENOMEM-simulated 2');
    expect(m.getCpuWorkerState().lastCrashError).toContain('ENOMEM-simulated 2');
    errSpy.mockRestore();
  });

  it('does NOT admit a probe before the cooldown has elapsed', async () => {
    // FALSIFIABILITY CONTROL for the re-arm window: delete the cooldown
    // comparison in serializeJsonResponse and this test fails, because the very
    // next eligible request would probe and (with a healthy worker) close the
    // breaker. Without it, the re-arm tests below would also pass for an
    // implementation that re-armed instantly — i.e. for no breaker at all.
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await crashRun(m, 3);
    expect(m.getCpuWorkerState().disabled).toBe(true);

    const rows = bigBatch(m);
    const json = await m.serializeJsonResponse({ rows }, rows.length);

    const s = m.getCpuWorkerState();
    expect(s.disabled).toBe(true);
    expect(s.reArms).toBe(0);
    expect(s.servedByWorker).toBe(0);
    expect(s.verdict).toBe('disabled');
    expect(s.reArmInMs ?? 0).toBeGreaterThan(0);
    // Still byte-correct via the sync fallback — a latched breaker degrades, never fails.
    expect(JSON.parse(json)).toEqual({ rows });
    errSpy.mockRestore();
  });

  it('re-arms after the cooldown when a probe is actually SERVED, and announces recovery', async () => {
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    m.configureCpuWorkerBreakerNotifier((s) => seen.push(s));

    await crashRun(m, 3);
    expect(m.getCpuWorkerState().disabled).toBe(true);

    // The seam rewinds the REAL trip timestamp the REAL comparison reads.
    expect(m._advanceBreakerClockForTest(60_000)).toBe(true);

    const rows = bigBatch(m);
    const json = await m.serializeJsonResponse({ rows }, rows.length);

    const s = m.getCpuWorkerState();
    expect(s.disabled).toBe(false);
    expect(s.reArms).toBe(1);
    expect(s.servedByWorker).toBeGreaterThan(0);
    expect(s.verdict).toBe('serving');
    expect(JSON.parse(json)).toEqual({ rows });
    // Recovery is announced for the same reason the trip is: the fallback is
    // byte-identical, so a recovery is as invisible as the degradation was.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('RECOVERED');
    errSpy.mockRestore();
  });

  it('a probe that CRASHES does not close the breaker, and backs the next probe off', async () => {
    // The property that stops re-arm from reintroducing respawn-per-request:
    // only a SERVED request closes the breaker, never a mere spawn.
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await crashRun(m, 3);
    expect(m._advanceBreakerClockForTest(60_000)).toBe(true);
    const before = m.getCpuWorkerState().reArmInMs ?? 0;

    await crashRun(m, 1, 'probe-died');

    const s = m.getCpuWorkerState();
    expect(s.disabled).toBe(true);
    expect(s.reArms).toBe(0);
    expect(s.reArmFailures).toBe(1);
    expect(s.verdict).toBe('disabled');
    // Backoff doubled: the next probe waits longer than the first did.
    expect(s.reArmInMs ?? 0).toBeGreaterThan(before);
    errSpy.mockRestore();
  });

  it('the clock seam refuses to no-op silently when the breaker is not latched', async () => {
    // A seam that returned void would let every re-arm test above pass against a
    // breaker that never latched — the assertions would be measuring nothing.
    const m = await mod();
    expect(m.getCpuWorkerState().disabled).toBe(false);
    expect(m._advanceBreakerClockForTest(60_000)).toBe(false);
  });

  it('verdict separates PROVEN-working from silently-falling-back', async () => {
    // The reading `disabled:false` cannot give. All three states below report
    // disabled:false, and before this item nothing could tell them apart.
    const m = await mod();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // (1) Nothing asked yet — benign, but NOT evidence the offload works.
    expect(m.getCpuWorkerState().verdict).toBe('idle-unproven');

    // (2) One crash: handle cleared, breaker NOT latched, nothing ever served.
    //     This is the invisible degradation — a healthy-looking row.
    await crashRun(m, 1);
    const mid = m.getCpuWorkerState();
    expect(mid.disabled).toBe(false);
    expect(mid.servedByWorker).toBe(0);
    expect(mid.eligibleFallbacks).toBeGreaterThan(0);
    expect(mid.verdict).toBe('silently-falling-back');

    // (3) A real served round-trip is the only thing that proves it.
    const rows = bigBatch(m);
    await m.serializeJsonResponse({ rows }, rows.length);
    expect(m.getCpuWorkerState().verdict).toBe('serving');
    errSpy.mockRestore();
  });

  it('the admission predicate refuses at the cooldown boundary and admits on it', async () => {
    // Pins the REAL predicate the request path calls, at the boundary — the one
    // place an off-by-one or an inverted comparison hides. The integration tests
    // above prove it is WIRED; this proves it is RIGHT. Neither alone is enough:
    // a predicate that always returned true would pass a wiring test, and a
    // correct predicate nothing calls would pass this one.
    const m = await mod();
    const base = m._reArmCooldownMs(0);
    const at = (elapsed: number, reArmFailures = 0) =>
      m._breakerAdmitsProbe({
        disabled: true,
        halfOpen: false,
        trippedAt: 1_000_000,
        reArmFailures,
        now: 1_000_000 + elapsed,
      });

    expect(at(base - 1)).toBe(false);
    expect(at(base)).toBe(true);

    // A failed probe must lengthen the wait, or the backoff is decorative: the
    // elapsed time that just admitted a probe must no longer admit one.
    expect(at(base, 1)).toBe(false);
    expect(at(m._reArmCooldownMs(1), 1)).toBe(true);

    // Each guard clause, independently — every one of these is a state in which
    // admitting a probe would be wrong for a different reason.
    expect(
      m._breakerAdmitsProbe({
        disabled: false,
        halfOpen: false,
        trippedAt: 1,
        reArmFailures: 0,
        now: 1e12,
      }),
    ).toBe(false); // not latched — the worker path is already open
    expect(
      m._breakerAdmitsProbe({
        disabled: true,
        halfOpen: true,
        trippedAt: 1,
        reArmFailures: 0,
        now: 1e12,
      }),
    ).toBe(false); // a probe is already in flight — exactly one at a time
    expect(
      m._breakerAdmitsProbe({
        disabled: true,
        halfOpen: false,
        trippedAt: null,
        reArmFailures: 0,
        now: 1e12,
      }),
    ).toBe(false); // latched with no trip time recorded — unknown, not elapsed
  });

  it('backoff grows exponentially and is capped, so a broken worker cannot be respawned per request', async () => {
    const m = await mod();
    const c0 = m._reArmCooldownMs(0);
    expect(m._reArmCooldownMs(1)).toBe(c0 * 2);
    expect(m._reArmCooldownMs(2)).toBe(c0 * 4);
    // Capped — without a ceiling the cooldown doubles into effective permanence,
    // which is the very defect the re-arm exists to remove.
    const huge = m._reArmCooldownMs(50);
    expect(huge).toBe(m._reArmCooldownMs(60));
    expect(huge).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('does not count small-batch sync stringifies as offload fallbacks', async () => {
    // If every sync stringify counted, `eligibleFallbacks` would be dominated by
    // the designed small-batch path and the silent-failure signal would be buried.
    const m = await mod();
    await m.serializeJsonResponse({ a: 1 }, 1);
    await m.serializeJsonResponse({ a: 2 }, 1);
    const s = m.getCpuWorkerState();
    expect(s.eligibleFallbacks).toBe(0);
    expect(s.verdict).toBe('idle-unproven');
  });
});
