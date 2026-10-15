import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { serializeIdentitySafeJson } from '../../../scripts/lib/identity-leak-patterns.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cacheRoot = fileURLToPath(new URL('../../../libs/generic/cache/', import.meta.url));
const fingerprint = (source: string) => createHash('sha256').update(source).digest('hex');
const moduleUrl = (source: string) => 'data:text/javascript;base64,' +
  Buffer.from(transformSync(source, { loader: 'ts', format: 'esm', target: 'node25' }).code).toString('base64');

function sources(control: boolean, historical = true) {
  // Optional historical comparison reads objects, never changes the shared tree.
  // The recurring guard's control removes only pruning from the current source.
  const ref = control && historical ? process.env.CACHE_RETENTION_BASELINE_REF : undefined;
  const read = (path: string) => ref
    ? execFileSync('git', ['show', ref + ':src/' + path], { cwd: cacheRoot, encoding: 'utf8' })
    : readFileSync(cacheRoot + 'src/' + path, 'utf8');
  let cache = read('cache.ts');
  const l1 = read('l1.ts');
  const generationStore = readFileSync(cacheRoot + 'src/generation-store.ts', 'utf8');
  const sourceHashes = { cache: fingerprint(cache), l1: fingerprint(l1), generationStore: fingerprint(generationStore) };
  if (control && !ref) {
    const pruningCalls = cache.match(/^\s*this\.l1\.prune\([^\n]+\);/gm);
    if (pruningCalls?.length !== 1) throw Error('Exactly one pruning intervention required');
    cache = cache.replace(/^\s*this\.l1\.prune\([^\n]+\);/m, '');
  }
  const linked = cache
    .replace("'./l1'", JSON.stringify(moduleUrl(l1)))
    // A data module has no filesystem base URL. Compile both pure dependencies
    // into data modules too, so child startup cannot depend on tsx path resolution.
    .replace("'./generation-store'", JSON.stringify(moduleUrl(generationStore)));
  return { module: moduleUrl(linked), sourceHashes, effectiveCacheHash: fingerprint(cache),
    controlKind: !control ? 'current' : ref ? 'historical:' + ref : 'current-with-pruning-removed' };
}

async function unforcedExpiryCohort(control: boolean) {
  const source = sources(control, false);
  const script = `
    import { readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { getHeapStatistics } from 'node:v8';
    const { Cache } = await import(${JSON.stringify(source.module)});
    const hash = x => createHash('sha256').update(x).digest('hex');
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const processIdentity = { pid: process.pid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      executableSha256: hash(readFileSync(process.execPath)), node: process.version };
    const children = () => readFileSync('/proc/self/task/' + process.pid + '/children', 'utf8').trim();
    const memory = label => {
      const rollup = readFileSync('/proc/self/smaps_rollup', 'utf8');
      const pss = rollup.match(/^Pss:\\s+(\\d+) kB$/m);
      const heap = getHeapStatistics();
      if (!pss || !(heap.total_allocated_bytes > 0)) throw Error('PSS and cumulative allocation counters required');
      if (children()) throw Error('Unexpected descendant outside the bounded cache runtime');
      return { label, at: Date.now(), monotonicMs: performance.now(), ...processIdentity,
        memory: process.memoryUsage(), pssBytes: Number(pss[1]) * 1024,
        allocatedBytes: heap.total_allocated_bytes, descendants: [] };
    };
    const idleMs = 200;
    const idle = () => new Promise(resolve => setTimeout(resolve, idleMs));
    const collect = async () => { for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setImmediate(resolve)); global.gc();
    } };
    let now = 0;
    const cache = new Cache({ clock: () => now, maxL1Entries: 50000 });
    const weak = [];
    const samples = [memory('empty')];
    for (let i = 0; i < 438; i++) await cache.getOrSet('fixture', 'cold-' + i, () => {
      const value = Array.from({ length: 948 }, (_, row) => ({ row, body: (i + ':' + row + ':').padEnd(256, 'x') }));
      weak.push(new WeakRef(value)); return value;
    }, { hardTtlMs: 100 });
    const usefulValue = i => ({ useful: i, body: ('useful:' + i + ':').padEnd(256, 'u') });
    for (let i = 0; i < 604; i++) await cache.getOrSet('fixture', 'warm-' + i, () => usefulValue(i));
    const usefulDigest = async () => {
      const h = createHash('sha256');
      for (let i = 0; i < 604; i++) {
        const value = await cache.getOrSet('fixture', 'warm-' + i, () => { throw Error('Useful context rebuilt'); });
        if (JSON.stringify(value) !== JSON.stringify(usefulValue(i))) throw Error('Useful content changed');
        h.update(JSON.stringify(value));
      }
      return { entries: 604, sha256: h.digest('hex') };
    };
    const usefulBefore = await usefulDigest();
    samples.push(memory('populated'));
    await idle(); samples.push(memory('idle-before-end'));
    now = 100;
    const entriesBefore = cache.l1.size;
    const started = performance.now(), cpu = process.cpuUsage();
    for (let i = 0; i < 32; i++) {
      const value = await cache.getOrSet('fixture', 'warm-' + i, () => { throw Error('Useful context rebuilt'); });
      if (value.useful !== i) throw Error('Useful read changed');
    }
    const used = process.cpuUsage(cpu);
    const reads = { count: 32, wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000 };
    samples.push(memory('ordinary-end'));
    const entriesAfter = cache.l1.size;
    await idle(); samples.push(memory('idle-after-end'));
    // Diagnostic collection is deliberately AFTER the complete unforced window.
    await collect();
    const diagnostic = { sample: memory('diagnostic-after-collection'),
      expiredReachable: weak.filter(ref => ref.deref()).length, entries: cache.l1.size };
    const usefulAfter = await usefulDigest();
    cache.clearL1(); await collect();
    const cleanup = { entries: cache.l1.size, expiredReachable: weak.filter(ref => ref.deref()).length,
      descendants: [], finalStats: { ...cache.stats }, sample: memory('cleared-after-collection') };
    process.stdout.write(JSON.stringify({ processIdentity, samples, idleMs, entriesBefore, entriesAfter,
      usefulBefore, usefulAfter, reads, diagnostic, cleanup,
      profilerOperations: [], unforcedWindowGcCalls: 0, diagnosticGcCalls: 6 }));
  `;
  const { stdout } = await exec(process.execPath, ['--expose-gc', '--input-type=module', '-e', script],
    { timeout: 30_000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
  return { mode: control ? 'baseline' : 'pruned', controlKind: source.controlKind,
    sourceHashes: source.sourceHashes, effectiveCacheHash: source.effectiveCacheHash,
    moduleSha256: fingerprint(source.module), runtimeScriptSha256: fingerprint(script),
    ...JSON.parse(stdout), terminalExitCode: 0, signal: null, reaped: true };
}

async function cohort(control: boolean) {
  const source = sources(control);
  const { stdout } = await exec(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { performance } from 'node:perf_hooks';
    const { Cache } = await import(${JSON.stringify(source.module)});
    let now = 0;
    const cache = new Cache({ clock: () => now, maxL1Entries: 50000 });
    const weak = [];
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const collect = async () => { for (let i = 0; i < 3; i++) { await settle(); global.gc(); } };
    const memory = () => {
      const pss = readFileSync('/proc/self/smaps_rollup', 'utf8').match(/^Pss:\\s+(\\d+) kB$/m);
      return { ...process.memoryUsage(), pssBytes: pss ? Number(pss[1]) * 1024 : null };
    };
    const idle = async () => {
      const start = performance.now(), cpu = process.cpuUsage();
      await new Promise(resolve => setTimeout(resolve, 100));
      const used = process.cpuUsage(cpu);
      return { wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 };
    };
    await collect();
    const empty = memory();
    async function fill() {
      // R9 measured 1042 entries / 438 expired; payloads are synthetic, unique
      // 948-row contexts, not copied production content or retained-byte estimates.
      for (let i = 0; i < 438; i++) await cache.getOrSet('fixture', 'cold-' + i, () => {
        const value = Array.from({ length: 948 }, (_, row) => ({ row, body: (i + ':' + row + ':').padEnd(256, 'x') }));
        weak.push(new WeakRef(value));
        return value;
      }, { hardTtlMs: 100 });
      for (let i = 0; i < 604; i++) await cache.getOrSet('fixture', 'warm-' + i, () => ({ useful: i }));
    }
    await fill();
    await collect();
    const populated = memory();
    const idleBefore = await idle();
    now = 100;
    await collect();
    const expiredIdle = { memory: memory(), entries: cache.l1.size, reachable: weak.filter(ref => ref.deref()).length };
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < 32; i++) {
      const value = await cache.getOrSet('fixture', 'warm-' + (i % 604), () => { throw new Error('useful context rebuilt'); });
      if (value.useful !== i % 604) throw new Error('useful context changed');
    }
    const used = process.cpuUsage(cpu);
    const reclamation = { wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, reads: 32 };
    await collect();
    const ordinary = { memory: memory(), entries: cache.l1.size, reachable: weak.filter(ref => ref.deref()).length };
    const idleAfter = await idle();
    // Warm up both arms, then report equal-size blocks; exact timing is evidence,
    // not a machine-dependent CI latency assertion.
    for (let i = 0; i < 2000; i++) await cache.getOrSet('fixture', 'warm-' + (i % 604), () => { throw new Error('miss'); });
    const blocks = [];
    for (let block = 0; block < 9; block++) {
      const before = process.cpuUsage(), t = performance.now();
      for (let i = 0; i < 10000; i++) await cache.getOrSet('fixture', 'warm-' + (i % 604), () => { throw new Error('miss'); });
      const cpu = process.cpuUsage(before);
      blocks.push({ reads: 10000, wallMs: performance.now() - t, cpuMs: (cpu.user + cpu.system) / 1000 });
    }
    cache.clearL1();
    await collect();
    const cleared = { memory: memory(), entries: cache.l1.size, reachable: weak.filter(ref => ref.deref()).length };
    process.stdout.write(JSON.stringify({ pid: process.pid, node: process.version, empty, populated,
      expiredIdle, ordinary, cleared, idleBefore, idleAfter, reclamation, blocks, stats: cache.stats }));
  `], { timeout: 20_000, maxBuffer: 64 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
  return { control, controlKind: source.controlKind, sourceHashes: source.sourceHashes, ...JSON.parse(stdout) };
}

describe('cache retained roots and resource costs in isolated processes', () => {
  it.runIf(process.env.PAPERCUSP_P011_EXPIRY_RESOURCES === '1')(
    'records order-reversed unforced expiry resource windows and complete useful content', async () => {
      const destination = process.env.PAPERCUSP_P011_EXPIRY_RESOURCES_REPORT;
      if (!destination) throw Error('Canonical expiry resource report required');
      const report: any = { schemaVersion: 'p011-expiry-unforced-resources-v1',
        plane: 'isolated-current-source-cache', incomplete: true, cohorts: [],
        testSource: { sha256: fingerprint(readFileSync(fileURLToPath(import.meta.url), 'utf8')) },
        workload: { expiredEntries: 438, rowsPerExpiredEntry: 948, bodyCodeUnits: 256,
          usefulEntries: 604, usefulBodyCodeUnits: 256, reads: 32, idleMs: 200 },
        limitations: ['Private cache runtime; no live operator or production savings claim.',
          'Unforced PSS and cumulative V8 allocation are separate from subsequent diagnostic GC/root reclamation.',
          'Named cache/l1/generation-store input hashes are not the complete operator executed graph.',
          'V8, external and OS counters do not establish native physical allocation ownership.'] };
      try {
        for (const control of [true, false, false, true]) {
          const arm = await unforcedExpiryCohort(control);
          report.cohorts.push(arm);
          for (const prior of report.cohorts) expect(arm.sourceHashes).toEqual(prior.sourceHashes);
          expect(arm.entriesBefore).toBe(1042);
          expect(arm.entriesAfter).toBe(control ? 1042 : 604);
          expect(arm.diagnostic.expiredReachable).toBe(control ? 438 : 0);
          expect(arm.usefulAfter).toEqual(arm.usefulBefore);
          expect(arm.cleanup.entries).toBe(0);
          expect(arm.cleanup.expiredReachable).toBe(0);
          expect(arm.cleanup.finalStats.builds).toBe(1042);
        }
        report.sourceHashesAfter = sources(false, false).sourceHashes;
        expect(report.sourceHashesAfter).toEqual(report.cohorts[0].sourceHashes);
        report.testSource.afterSha256 = fingerprint(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
        expect(report.testSource.afterSha256).toBe(report.testSource.sha256);
        report.incomplete = false;
      } catch (error) {
        report.error = String(error); throw error;
      } finally {
        writeFileSync(resolve(root, destination), serializeIdentitySafeJson(report));
      }
    }, 150_000);

  it('reclaims untouched expired contexts during useful reads, preserves live contexts, and releases on clear', async () => {
    const control = await cohort(true);
    const current = await cohort(false);
    console.info('P011 cache resource comparison:', JSON.stringify({ control, current }));
    for (const arm of [control, current]) {
      expect(arm.expiredIdle.entries).toBe(1042);
      expect(arm.expiredIdle.reachable).toBe(438);
      expect(arm.cleared.entries).toBe(0);
      expect(arm.cleared.reachable).toBe(0);
      expect(arm.stats.builds).toBe(1042);
      expect(arm.stats.singleFlightJoins).toBe(0);
    }
    expect(control.ordinary.entries).toBe(1042);
    expect(control.ordinary.reachable).toBe(438);
    expect(current.ordinary.entries).toBe(604);
    expect(current.ordinary.reachable).toBe(0);
    // Large class-level guard; PSS/RSS need not shrink with allocator retention.
    expect(control.ordinary.memory.heapUsed - current.ordinary.memory.heapUsed).toBeGreaterThan(8 * 1024 * 1024);
  }, 45_000);
});
