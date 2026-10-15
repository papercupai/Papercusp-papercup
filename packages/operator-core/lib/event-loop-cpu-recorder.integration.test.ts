import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const recorderPath = fileURLToPath(new URL('./event-loop-cpu-recorder.ts', import.meta.url));
const eagerAdapterPath = fileURLToPath(new URL('./event-loop-cpu-profiler-eager-adapter.cc', import.meta.url));
const nodeIncludePath = join(dirname(dirname(process.execPath)), 'include', 'node');
const hasNode259ProfilerHeaders =
  process.platform === 'linux' &&
  process.versions.node.startsWith('25.9.') &&
  existsSync(join(nodeIncludePath, 'v8-profiler.h'));

describe('real monitor CPU recorder in an isolated Node process', () => {
  it('retains useful 100Hz samples across rotations, discards delayed work and releases its sampler', async () => {
    const { stdout } = await exec(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', `
      import { LoopCpuRecorder } from ${JSON.stringify(recorderPath)};
      import { performance, PerformanceObserver } from 'node:perf_hooks';
      const retained = Array.from({ length: 25000 }, (_, i) => new Function('x', 'return x + ' + i));
      const observer = [], memory = [], starts = [], stops = [];
      const gcEntries = [];
      const gcObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          gcEntries.push({ startTime: entry.startTime, durationMs: entry.duration, kind: entry.detail?.kind ?? null });
        }
      });
      gcObserver.observe({ entryTypes: ['gc'] });
      const recorder = new LoopCpuRecorder(2000, (line, detail) => observer.push({ line, ...detail }));
      const measureIdle = async () => {
        const start = performance.now(), before = process.cpuUsage(), threadBefore = process.threadCpuUsage?.();
        await new Promise(r => setTimeout(r, 500));
        const end = performance.now();
        const cpu = process.cpuUsage(before);
        const threadCpu = threadBefore && process.threadCpuUsage?.(threadBefore);
        await new Promise(r => setImmediate(r));
        return {
          wallMs: end - start,
          cpuMs: (cpu.user + cpu.system) / 1000,
          threadCpuMs: threadCpu ? (threadCpu.user + threadCpu.system) / 1000 : null,
          gcEvents: gcEntries.filter(entry => entry.startTime >= start && entry.startTime <= end)
            .map(({ kind, durationMs }) => ({ kind, durationMs })),
        };
      };
      const before = await measureIdle();
      let useful = 0, maxSamples = 0, maxBytes = 0;
      const work = () => {
        const until = performance.now() + 130;
        let x = 0;
        while (performance.now() < until) x = retained[x % retained.length](x) % 100000;
      };
      let active, after, delayedRejected, abortRejected, unavailable;
      try {
        if (!await recorder.update(true, true)) throw new Error('recorder failed to start');
        active = await measureIdle();
        for (let i = 0; i < 40; i++) {
          if (!await recorder.update(true, true)) throw new Error('rotation failed');
          const pending = recorder.record(160);
          // Let Profiler.start complete before synchronous work begins.
          await new Promise(r => setImmediate(r));
          work();
          const { profile, startMs, stopMs, samplingIntervalUs } = await pending;
          if (samplingIntervalUs !== 10000) throw new Error('wrong sample interval');
          const ids = new Set(profile.nodes.filter(n => ['work', 'now'].includes(n.callFrame.functionName)).map(n => n.id));
          for (let changed = true; changed;) {
            changed = false;
            for (const n of profile.nodes) if (ids.has(n.id)) for (const c of n.children ?? []) {
              if (!ids.has(c)) { ids.add(c); changed = true; }
            }
          }
          if (profile.samples.filter(id => ids.has(id)).length >= 3) useful++;
          maxSamples = Math.max(maxSamples, profile.samples.length);
          maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(profile)));
          starts.push(startMs); stops.push(stopMs);
          if (i % 5 === 0) { global.gc(); memory.push(process.memoryUsage()); }
        }
        const controller = new AbortController();
        const cancelled = recorder.record(60000, controller.signal).then(() => false, () => true);
        controller.abort();
        abortRejected = await cancelled;
        // A late tick must discard without publishing the now-oversized anchor.
        await new Promise(r => setTimeout(r, 2100));
        delayedRejected = !await recorder.update(true, true);
        unavailable = await recorder.record(1).then(() => false, () => true);
        if (!await recorder.update(true, true)) throw new Error('safe recovery failed');
        await recorder.update(false, true);
        after = await measureIdle();
      } finally { recorder.stop(); gcObserver.disconnect(); }
      global.gc();
      process.stdout.write(JSON.stringify({ observer, memory, starts, stops, useful, maxSamples,
        maxBytes, before, active, after, delayedRejected, abortRejected, unavailable }));
    `], { timeout: 35_000, maxBuffer: 128 * 1024 });
    const result = JSON.parse(stdout);
    console.info('P-003 product warm recorder:', JSON.stringify(result));
    console.info('P-003 active CPU window diagnostics:', JSON.stringify({
      before: result.before,
      active: result.active,
      after: result.after,
      warmups: result.observer.filter((e: { warmupMs?: number }) => 'warmupMs' in e),
    }));
    expect(result.useful).toBe(40);
    expect(result.observer.filter((e: { warmupMs?: number }) => 'warmupMs' in e)).toHaveLength(2);
    expect(result.delayedRejected).toBe(true);
    expect(result.abortRejected).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.maxSamples).toBeGreaterThan(3);
    expect(result.maxBytes).toBeLessThan(8 * 1024 * 1024);
    const heaps = result.memory.map((row: { heapUsed: number }) => row.heapUsed);
    expect(Math.max(...heaps) - Math.min(...heaps)).toBeLessThan(16 * 1024 * 1024);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(median(result.starts)).toBeLessThan(result.observer[0].warmupMs / 2);
    // Broad runaway detector. Exact observations are logged, not a production SLO.
    expect(result.active.cpuMs / result.active.wallMs).toBeLessThan(0.15);
    expect(result.after.cpuMs / result.after.wallMs).toBeLessThan(0.02);
  }, 45_000);

  it.skipIf(!hasNode259ProfilerHeaders)(
    'measures the test-only eager V8 profiler lifecycle beside LoopCpuRecorder',
    async () => {
      const maxSamples = 64;
      const tempDir = await mkdtemp(join(tmpdir(), 'papercusp-eager-profiler-'));
      const addonPath = join(tempDir, 'eager-profiler.node');

      try {
        const compile = await exec(
          process.env.CXX ?? 'c++',
          [
            '-std=c++20',
            '-shared',
            '-fPIC',
            '-O2',
            '-I' + nodeIncludePath,
            eagerAdapterPath,
            '-o',
            addonPath,
          ],
          { timeout: 30_000, maxBuffer: 128 * 1024 },
        );
        expect(existsSync(addonPath)).toBe(true);

        const run = async (
          strategy: 'inspector' | 'eager',
          v8Flags: string[] = [],
          includeRecoverySampleChains = false,
          includeV8TierTraces = false,
        ) => {
          const workerSource =
            "const { parentPort } = require('node:worker_threads'); " +
            "let waiting = false; " +
            "function tick() { if (waiting) return; waiting = true; parentPort.postMessage(1); } " +
            "parentPort.on('message', () => { waiting = false; setTimeout(tick, 5); }); " +
            'tick();';
          const childScript = [
            "import { createRequire } from 'node:module';",
            "import { writeSync } from 'node:fs';",
            "import { Session as InspectorSession } from 'node:inspector';",
            "import { performance } from 'node:perf_hooks';",
            "import { setTimeout as delay } from 'node:timers/promises';",
            "import { Worker } from 'node:worker_threads';",
            'import { LoopCpuRecorder } from ' + JSON.stringify(recorderPath) + ';',
            'const strategy = ' + JSON.stringify(strategy) + ';',
            'const maxSamples = ' + maxSamples + ';',
            'const includeRecoverySampleChains = ' + includeRecoverySampleChains + ';',
            'const includeV8TierTraces = ' + includeV8TierTraces + ';',
            'const addonPath = ' + JSON.stringify(addonPath) + ';',
            'const require = createRequire(import.meta.url);',
            "const eager = strategy === 'eager' ? require(addonPath) : null;",
            'const recorderLogs = [];',
            "const recorder = strategy === 'inspector' ? new LoopCpuRecorder(1500, (line, detail) => recorderLogs.push({ line, ...detail })) : null;",
            'const worker = new Worker(' + JSON.stringify(workerSource) + ', { eval: true, execArgv: [] });',
            'let gapWindow = null;',
            "worker.on('message', () => {",
            '  const now = performance.now();',
            '  if (gapWindow) { gapWindow.maxMs = Math.max(gapWindow.maxMs, now - gapWindow.lastMs); gapWindow.lastMs = now; }',
            "  worker.postMessage('ack');",
            '});',
            'await new Promise(resolve => worker.once("online", resolve));',
            'await delay(40);',
            'async function measure(action) {',
            '  await delay(20);',
            '  const window = { maxMs: 0, lastMs: performance.now() };',
            '  gapWindow = window;',
            '  const startedAt = performance.now();',
            '  const value = await action();',
            '  await delay(25);',
            '  gapWindow = null;',
            '  return { value, durationMs: performance.now() - startedAt, workerGapMaxMs: window.maxMs };',
            '}',
            'let cursor = 1;',
            'let churnedFunctions = 0;',
            'let hotFrameCalls = 0;',
            'let captureHotFrameWindows = false;',
            'let hotFrameWindowsNs = [];',
            'const retained = Array.from({ length: 25000 }, (_, i) => {',
            "  const fn = new Function('return function map_' + i + '(x) { return x + ' + i + '; }')();",
            '  fn(i);',
            '  return fn;',
            '});',
            'function cpuHotFrame(durationMs = 8) {',
            '  hotFrameCalls++;',
            '  const startedNs = captureHotFrameWindows ? process.hrtime.bigint() : null;',
            '  const until = performance.now() + durationMs;',
            '  while (performance.now() < until) cursor = retained[cursor % retained.length](cursor) % retained.length;',
            '  if (startedNs !== null) hotFrameWindowsNs.push([startedNs, process.hrtime.bigint()]);',
            '}',
            'let memoryWindow = null;',
            'function sampleMemory() {',
            '  if (!memoryWindow) return;',
            '  const current = process.memoryUsage();',
            '  memoryWindow.peakRss = Math.max(memoryWindow.peakRss, current.rss);',
            '  memoryWindow.peakHeapUsed = Math.max(memoryWindow.peakHeapUsed, current.heapUsed);',
            '}',
            'async function workFor(durationMs) {',
            '  const until = performance.now() + durationMs;',
            '  while (performance.now() < until) {',
            '    cpuHotFrame();',
            '    const batch = Array.from({ length: 32 }, (_, offset) => {',
            "      const name = 'churn_' + churnedFunctions + offset;",
            "      const fn = new Function('x', 'return x + ' + (churnedFunctions + offset));",
            "      Object.defineProperty(fn, 'name', { value: name });",
            '      fn(cursor);',
            '      return fn;',
            '    });',
            '    churnedFunctions += batch.length;',
            '    void batch;',
            '    sampleMemory();',
            '    await delay(5);',
            '  }',
            '  return churnedFunctions;',
            '}',
            'function summarize(profile, workWindow = null, includeSampleChains = false, hotFrameWindows = null) {',
            '  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];',
            '  const samples = Array.isArray(profile?.samples) ? profile.samples : [];',
            '  const timeDeltasUs = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];',
            '  let cumulativeSampleTimeUs = 0;',
            '  const sampleOffsetsUs = timeDeltasUs.map(deltaUs => (cumulativeSampleTimeUs += deltaUs));',
            '  const timeDeltaSumUs = timeDeltasUs.reduce((sum, deltaUs) => sum + deltaUs, 0);',
            '  const sortedTimeDeltasUs = [...timeDeltasUs].sort((a, b) => a - b);',
            '  const profileDuration = Number.isFinite(profile?.startTime) && Number.isFinite(profile?.endTime) ? profile.endTime - profile.startTime : null;',
            '  const nodesById = new Map(nodes.map(node => [node.id, node]));',
            '  const parentById = new Map();',
            '  for (const node of nodes) for (const child of node.children ?? []) parentById.set(child, node.id);',
            '  const sampleChains = includeSampleChains ? samples.map((sampleId, sampleIndex) => {',
            '    const chain = [];',
            '    const seen = new Set();',
            '    let nodeId = sampleId;',
            '    let missingNodeId = null;',
            '    let cycleDetected = false;',
            '    while (nodeId !== undefined) {',
            '      if (seen.has(nodeId)) { cycleDetected = true; break; }',
            '      seen.add(nodeId);',
            '      const node = nodesById.get(nodeId);',
            '      if (!node) { missingNodeId = nodeId; break; }',
            '      const parentNodeId = parentById.get(nodeId) ?? null;',
            '      const callFrame = node.callFrame ?? {};',
            '      chain.push({ nodeId: node.id, parentNodeId, hitCount: node.hitCount ?? null, callFrame: {',
            '        functionName: callFrame.functionName ?? null,',
            '        scriptId: callFrame.scriptId ?? null,',
            '        url: callFrame.url ?? null,',
            '        lineNumber: callFrame.lineNumber ?? null,',
            '        columnNumber: callFrame.columnNumber ?? null,',
            '      } });',
            '      nodeId = parentById.get(nodeId);',
            '    }',
            '    return { sampleIndex, sampleId, sampleOffsetUs: sampleOffsetsUs[sampleIndex] ?? null, sampleNodeResolved: chain[0]?.nodeId === sampleId, missingNodeId, cycleDetected, chainComplete: nodeId === undefined && missingNodeId === null && !cycleDetected, chain };',
            '  }) : undefined;',
            '  const sampleFrames = samples.map(sampleId => {',
            '    const frames = [], seen = new Set();',
            '    let nodeId = sampleId;',
            '    while (nodeId !== undefined && !seen.has(nodeId)) {',
            '      seen.add(nodeId);',
            '      const node = nodesById.get(nodeId);',
            '      if (!node) break;',
            '      frames.push(node.callFrame?.functionName ?? "");',
            '      nodeId = parentById.get(nodeId);',
            '    }',
            '    return frames;',
            '  });',
            '  const isMapFrame = name => /^map_[0-9]+$/.test(name);',
            '  const mapFrameNames = [...new Set(sampleFrames.flat().filter(isMapFrame))];',
            '  const nodeFunctionCounts = new Map();',
            '  for (const node of nodes) { const name = node.callFrame?.functionName || "(empty)"; nodeFunctionCounts.set(name, (nodeFunctionCounts.get(name) ?? 0) + 1); }',
            '  const hotSamples = sampleFrames.filter(frames => frames.includes("cpuHotFrame")).length;',
            '  const mapSamples = sampleFrames.filter(frames => frames.some(isMapFrame)).length;',
            '  const usefulSamples = sampleFrames.filter(frames => frames.includes("cpuHotFrame") || frames.some(isMapFrame)).length;',
            '  const rankCounts = counts => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16);',
            '  const leafCounts = new Map();',
            '  const frameCounts = new Map();',
            '  const pathCounts = new Map();',
            '  for (const frames of sampleFrames) {',
            '    const leaf = frames[0] || "(empty)";',
            '    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);',
            '    const path = frames.slice(0, 6).join(" <- ");',
            '    pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);',
            '    for (const name of new Set(frames)) frameCounts.set(name, (frameCounts.get(name) ?? 0) + 1);',
            '  }',
            '  const summarizeTimedSamples = (startUs, endUs) => {',
            '    const indexes = sampleOffsetsUs.flatMap((offsetUs, index) => index < sampleFrames.length && offsetUs >= startUs && offsetUs <= endUs ? [index] : []);',
            '    const timedFrameCounts = new Map(), timedPathCounts = new Map();',
            '    for (const index of indexes) {',
            '      const frames = sampleFrames[index] ?? [];',
            '      const path = frames.slice(0, 6).join(" <- ") || "(empty)";',
            '      timedPathCounts.set(path, (timedPathCounts.get(path) ?? 0) + 1);',
            '      for (const name of new Set(frames)) timedFrameCounts.set(name, (timedFrameCounts.get(name) ?? 0) + 1);',
            '    }',
            '    return { samples: indexes.length, hotSamples: indexes.filter(index => sampleFrames[index].includes("cpuHotFrame")).length, mapSamples: indexes.filter(index => sampleFrames[index].some(isMapFrame)).length, usefulSamples: indexes.filter(index => sampleFrames[index].includes("cpuHotFrame") || sampleFrames[index].some(isMapFrame)).length, sampleFrameCounts: rankCounts(timedFrameCounts), samplePathCounts: rankCounts(timedPathCounts).slice(0, 8) };',
            '  };',
            '  const timedWork = workWindow ? {',
            '    possible: summarizeTimedSamples(workWindow.possibleStartUs, workWindow.possibleEndUs),',
            '    definite: summarizeTimedSamples(workWindow.definiteStartUs, workWindow.definiteEndUs),',
            '  } : null;',
            '  const summarizeWindows = (windows, startKey, endKey) => {',
            '    const indexes = sampleOffsetsUs.flatMap((offsetUs, index) => index < sampleFrames.length && windows.some(window => offsetUs >= window[startKey] && offsetUs <= window[endKey]) ? [index] : []);',
            '    const frameCounts = new Map(), pathCounts = new Map();',
            '    for (const index of indexes) {',
            '      const frames = sampleFrames[index] ?? [];',
            '      const path = frames.slice(0, 6).join(" <- ") || "(empty)";',
            '      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);',
            '      for (const name of new Set(frames)) frameCounts.set(name, (frameCounts.get(name) ?? 0) + 1);',
            '    }',
            '    return { samples: indexes.length, hotSamples: indexes.filter(index => sampleFrames[index].includes("cpuHotFrame")).length, mapSamples: indexes.filter(index => sampleFrames[index].some(isMapFrame)).length, usefulSamples: indexes.filter(index => sampleFrames[index].includes("cpuHotFrame") || sampleFrames[index].some(isMapFrame)).length, sampleFrameCounts: rankCounts(frameCounts), samplePathCounts: rankCounts(pathCounts).slice(0, 8) };',
            '  };',
            '  const timedHotFrameWindows = hotFrameWindows ? {',
            '    possible: summarizeWindows(hotFrameWindows, "possibleStartUs", "possibleEndUs"),',
            '    definite: summarizeWindows(hotFrameWindows, "definiteStartUs", "definiteEndUs"),',
            '  } : null;',
            '  return { samples: samples.length, nodes: nodes.length, hotSamples, mapSamples, mapFrameNames: mapFrameNames.slice(0, 8), nodeFunctionCounts: rankCounts(nodeFunctionCounts).slice(0, 16), usefulSamples, timeDeltaCount: timeDeltasUs.length, sampleOffsetCount: sampleOffsetsUs.length, sampleOffsetStartUs: sampleOffsetsUs[0] ?? null, sampleOffsetEndUs: sampleOffsetsUs.at(-1) ?? null, timeDeltaSumUs, timeDeltaMinUs: sortedTimeDeltasUs[0] ?? null, timeDeltaMedianUs: sortedTimeDeltasUs[Math.floor(sortedTimeDeltasUs.length / 2)] ?? null, timeDeltaMaxUs: sortedTimeDeltasUs.at(-1) ?? null, profileDuration, workWindow: workWindow ? { ...workWindow, ...timedWork } : null, hotFrameWindows: timedHotFrameWindows, sampleLeafCounts: rankCounts(leafCounts), sampleFrameCounts: rankCounts(frameCounts), samplePathCounts: rankCounts(pathCounts).slice(0, 8), ...(sampleChains ? { sampleChains } : {}), bytes: Buffer.byteLength(JSON.stringify(profile)) };',
            '}',
            'async function captureInspector(durationMs) {',
            '  const rotate = setInterval(() => { void recorder.update(true, true); }, 40);',
            '  try {',
            '    const pending = recorder.record(durationMs + 50);',
            '    await delay(15);',
            '    const beforeWork = { hotFrameCalls, churnedFunctions };',
            '    await workFor(durationMs);',
            '    const workload = { hotFrameCalls: hotFrameCalls - beforeWork.hotFrameCalls, churnedFunctions: churnedFunctions - beforeWork.churnedFunctions };',
            '    const recording = await pending;',
            '    return { profile: summarize(recording.profile), workload, startMs: recording.startMs, stopMs: recording.stopMs };',
            '  } finally { clearInterval(rotate); }',
            '}',
            'const elapsedUs = (startNs, endNs) => Number(endNs - startNs) / 1000;',
            'async function captureEager(durationMs, alreadyStarted = false, workStartOffsetMs = 0, startCallWindow = null, includeSampleChains = false, inspectorControl = null) {',
            '  if (alreadyStarted && !startCallWindow) throw new Error("already-started eager capture needs its start-call timing window");',
            '  const startCallStartedNs = alreadyStarted ? startCallWindow.startedNs : process.hrtime.bigint();',
            '  if (!alreadyStarted) eager.start(maxSamples);',
            '  const startCallReturnedNs = alreadyStarted ? startCallWindow.returnedNs : process.hrtime.bigint();',
            '  if (workStartOffsetMs > 0) await delay(workStartOffsetMs);',
            '  const beforeWork = { hotFrameCalls, churnedFunctions };',
            '  const workStartNs = process.hrtime.bigint();',
            '  if (includeSampleChains) {',
            '    captureHotFrameWindows = true;',
            '    hotFrameWindowsNs = [];',
            '    if (includeV8TierTraces) writeSync(1, "@@recovery-work-trace-start@@\\n");',
            '  }',
            '  await workFor(durationMs);',
            '  if (includeSampleChains && includeV8TierTraces) writeSync(1, "@@recovery-work-trace-end@@\\n");',
            '  if (includeSampleChains) captureHotFrameWindows = false;',
            '  const workEndNs = process.hrtime.bigint();',
            '  let inspectorControlCapture = null;',
            '  if (inspectorControl) {',
            '    const { profile } = await inspectorControl.post("Profiler.stop");',
            '    const controlStart = inspectorControl.startCallWindow;',
            '    const controlWorkWindow = { possibleStartUs: elapsedUs(controlStart.startedNs, workStartNs), definiteStartUs: elapsedUs(controlStart.startedNs, workStartNs), definiteEndUs: elapsedUs(controlStart.startedNs, workEndNs), possibleEndUs: elapsedUs(controlStart.startedNs, workEndNs) };',
            '    const controlHotFrameWindowsUs = includeSampleChains ? hotFrameWindowsNs.map(([startedNs, endedNs]) => ({ possibleStartUs: elapsedUs(controlStart.startedNs, startedNs), definiteStartUs: elapsedUs(controlStart.startedNs, startedNs), definiteEndUs: elapsedUs(controlStart.startedNs, endedNs), possibleEndUs: elapsedUs(controlStart.startedNs, endedNs) })) : undefined;',
            '    inspectorControlCapture = { profile: summarize(profile, controlWorkWindow, false, controlHotFrameWindowsUs), hotFrameWindowsUs: controlHotFrameWindowsUs, startCallUs: elapsedUs(controlStart.startedNs, controlStart.returnedNs) };',
            '    inspectorControl.session.disconnect();',
            '  }',
            '  const workload = { hotFrameCalls: hotFrameCalls - beforeWork.hotFrameCalls, churnedFunctions: churnedFunctions - beforeWork.churnedFunctions };',
            '  const stopCallStartedNs = process.hrtime.bigint();',
            '  const finished = eager.finish(true, false);',
            '  const stopCallReturnedNs = process.hrtime.bigint();',
            '  const workWindow = { possibleStartUs: elapsedUs(startCallReturnedNs, workStartNs), definiteStartUs: elapsedUs(startCallStartedNs, workStartNs), definiteEndUs: elapsedUs(startCallReturnedNs, workEndNs), possibleEndUs: elapsedUs(startCallStartedNs, workEndNs) };',
            '  const hotFrameWindowsUs = includeSampleChains ? hotFrameWindowsNs.map(([startedNs, endedNs]) => ({ possibleStartUs: elapsedUs(startCallReturnedNs, startedNs), definiteStartUs: elapsedUs(startCallStartedNs, startedNs), definiteEndUs: elapsedUs(startCallReturnedNs, endedNs), possibleEndUs: elapsedUs(startCallStartedNs, endedNs) })) : undefined;',
            '  return { profile: summarize(JSON.parse(finished.profileJson), workWindow, includeSampleChains), hotFrameWindowsUs, inspectorControl: inspectorControlCapture, workload, timing: { startCallUs: elapsedUs(startCallStartedNs, startCallReturnedNs), workDurationUs: elapsedUs(workStartNs, workEndNs), stopCallUs: elapsedUs(stopCallStartedNs, stopCallReturnedNs) }, sampleCount: finished.sampleCount, serialized: finished.serialized, disposed: finished.disposed };',
            '}',
            'async function revokeInspector(enabled, safe) {',
            '  const pending = recorder.record(60000).then(() => false, () => true);',
            '  await delay(15);',
            '  const measured = await measure(() => recorder.update(enabled, safe));',
            '  return { updateReturned: measured.value, durationMs: measured.durationMs, workerGapMaxMs: measured.workerGapMaxMs, captureRejected: await pending };',
            '}',
            'async function revokeEager() {',
            '  eager.start(maxSamples);',
            '  const measured = await measure(() => eager.finish(false, true));',
            '  return { ...measured.value, durationMs: measured.durationMs, workerGapMaxMs: measured.workerGapMaxMs };',
            '}',
            'const startup = await measure(() => strategy === "inspector" ? recorder.update(true, true) : eager.create());',
            'for (const fn of retained) fn(1);',
            'await delay(50);',
            'if (includeV8TierTraces) writeSync(1, "@@primary-trace-start@@\\n");',
            'const primary = await measure(() => strategy === "inspector" ? captureInspector(1000) : captureEager(1000, false, 0, null, false));',
            'if (includeV8TierTraces) writeSync(1, "@@primary-trace-end@@\\n");',
            'const disabledRevocation = strategy === "inspector" ? await revokeInspector(false, true) : await revokeEager();',
            'let recoveryInspectorControl = null;',
            'if (strategy === "eager" && includeRecoverySampleChains) {',
            '  const session = new InspectorSession();',
            '  session.connect();',
            '  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));',
            '  await post("Profiler.enable");',
            '  await post("Profiler.setSamplingInterval", { interval: 10000 });',
            '  const startedNs = process.hrtime.bigint();',
            '  await post("Profiler.start");',
            '  recoveryInspectorControl = { session, post, startCallWindow: { startedNs, returnedNs: process.hrtime.bigint() } };',
            '}',
            '// Initialize the paired control before the capped eager capture so Inspector setup cannot consume its sample budget before work starts.',
            'if (includeV8TierTraces) writeSync(1, "@@recovery-lifecycle-trace-start@@\\n");',
            'let eagerProfileStartCallWindow = null;',
            'const recoveryWarmup = await measure(() => {',
            '  if (strategy === "inspector") return recorder.update(true, true);',
            '  eager.create();',
            '  const startedNs = process.hrtime.bigint();',
            '  const profileId = eager.start(maxSamples);',
            '  eagerProfileStartCallWindow = { startedNs, returnedNs: process.hrtime.bigint() };',
            '  return profileId;',
            '});',
            'const recoveryCapture = await measure(() => strategy === "inspector" ? captureInspector(350) : captureEager(350, true, 0, eagerProfileStartCallWindow, includeRecoverySampleChains, recoveryInspectorControl));',
            'if (includeV8TierTraces) writeSync(1, "@@recovery-lifecycle-trace-end@@\\n");',
            'const recoveryPhaseOffsetsMs = [0, 2, 4, 6, 8, 8, 6, 4, 2, 0];',
            'const recoveryPhaseSweep = [];',
            'if (strategy === "eager") {',
            '  for (const workStartOffsetMs of recoveryPhaseOffsetsMs) {',
            '    const measured = await measure(() => captureEager(350, false, workStartOffsetMs));',
            '    const profile = measured.value.profile;',
            '    recoveryPhaseSweep.push({ workStartOffsetMs, profile: { samples: profile.samples, nodes: profile.nodes, hotSamples: profile.hotSamples, mapSamples: profile.mapSamples, mapFrameNames: profile.mapFrameNames, nodeFunctionCounts: profile.nodeFunctionCounts, usefulSamples: profile.usefulSamples, timeDeltaCount: profile.timeDeltaCount, sampleOffsetCount: profile.sampleOffsetCount, timeDeltaSumUs: profile.timeDeltaSumUs, timeDeltaMinUs: profile.timeDeltaMinUs, timeDeltaMedianUs: profile.timeDeltaMedianUs, timeDeltaMaxUs: profile.timeDeltaMaxUs, profileDuration: profile.profileDuration, workWindow: profile.workWindow, sampleFrameCounts: profile.sampleFrameCounts.slice(0, 8), samplePathCounts: profile.samplePathCounts.slice(0, 4), bytes: profile.bytes }, workload: measured.value.workload, durationMs: measured.durationMs, workerGapMaxMs: measured.workerGapMaxMs });',
            '  }',
            '}',
            'const unsafeRevocation = strategy === "inspector" ? await revokeInspector(true, false) : await revokeEager();',
            'const memoryBefore = process.memoryUsage();',
            'memoryWindow = { peakRss: memoryBefore.rss, peakHeapUsed: memoryBefore.heapUsed };',
            'if (strategy === "inspector") await recorder.update(true, true);',
            'else { eager.create(); eager.start(maxSamples); }',
            'await workFor(2100);',
            'const memoryPeak = { ...memoryWindow };',
            'memoryWindow = null;',
            'const delayedCleanup = strategy === "inspector"',
            '  ? await measure(() => recorder.update(true, true))',
            '  : await measure(() => eager.finish(false, true));',
            'if (global.gc) global.gc();',
            'const memoryAfter = process.memoryUsage();',
            'const delayed = {',
            '  cleanup: delayedCleanup.value,',
            '  durationMs: delayedCleanup.durationMs,',
            '  workerGapMaxMs: delayedCleanup.workerGapMaxMs,',
            '  memory: { beforeRss: memoryBefore.rss, peakRss: memoryPeak.peakRss, peakRssDelta: memoryPeak.peakRss - memoryBefore.rss, beforeHeapUsed: memoryBefore.heapUsed, peakHeapUsed: memoryPeak.peakHeapUsed, retainedHeapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed },',
            '};',
            'const result = {',
            '  strategy,',
            '  v8Flags: process.execArgv.filter(flag => flag.startsWith("--trace-") || flag.startsWith("--no-turbo-inlining")),',
            '  startup: { durationMs: startup.durationMs, workerGapMaxMs: startup.workerGapMaxMs },',
            '  primary: { ...primary.value, durationMs: primary.durationMs, workerGapMaxMs: primary.workerGapMaxMs },',
            '  disabledRevocation,',
            '  recoveryWarmup: { durationMs: recoveryWarmup.durationMs, workerGapMaxMs: recoveryWarmup.workerGapMaxMs },',
            '  recoveryCapture: { ...recoveryCapture.value, durationMs: recoveryCapture.durationMs, workerGapMaxMs: recoveryCapture.workerGapMaxMs },',
            '  recoveryPhaseSweep,',
            '  unsafeRevocation,',
            '  delayed,',
            '  serializations: strategy === "eager" ? eager.serializationCount() : null,',
            '  churnedFunctions,',
            '  recorderWarmups: recorderLogs.filter(entry => "warmupMs" in entry).map(entry => entry.warmupMs),',
            '};',
            'if (strategy === "inspector") recorder.stop();',
            'if (strategy === "eager") eager.dispose();',
            'await worker.terminate();',
            'if (includeV8TierTraces) writeSync(3, JSON.stringify(result));',
            'else process.stdout.write(JSON.stringify(result));',
          ].join('\n');

          const childArgs = [...v8Flags, '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', childScript];
          let stdout: string;
          let traceLines: Record<'primary' | 'recoveryLifecycle' | 'recoveryWork', Array<{ line: string; count: number }>> | undefined;
          if (includeV8TierTraces) {
            const captured = await new Promise<{
              json: string;
              traceLines: Record<'primary' | 'recoveryLifecycle' | 'recoveryWork', Array<{ line: string; count: number }>>;
            }>((resolve, reject) => {
              const child = spawn(process.execPath, childArgs, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
              let json = '';
              let pendingLine = '';
              let stderrTail = '';
              const traceCountsByWindow = {
                primary: new Map<string, number>(),
                recoveryLifecycle: new Map<string, number>(),
                recoveryWork: new Map<string, number>(),
              };
              let activeTraceWindow: keyof typeof traceCountsByWindow | null = null;
              let settled = false;
              const relevantNames = /cpuHotFrame|workFor/;
              const relevantEvents = /marking|compiling|completed|optimizing|bailout|deopt|inlin/i;
              const onLine = (line: string) => {
                if (line === '@@primary-trace-start@@') { activeTraceWindow = 'primary'; return; }
                if (line === '@@primary-trace-end@@') { activeTraceWindow = null; return; }
                if (line === '@@recovery-lifecycle-trace-start@@') { activeTraceWindow = 'recoveryLifecycle'; return; }
                if (line === '@@recovery-lifecycle-trace-end@@') { activeTraceWindow = null; return; }
                if (line === '@@recovery-work-trace-start@@') { activeTraceWindow = 'recoveryWork'; return; }
                if (line === '@@recovery-work-trace-end@@') { activeTraceWindow = 'recoveryLifecycle'; return; }
                if (activeTraceWindow !== null && relevantNames.test(line) && relevantEvents.test(line)) {
                  const boundedLine = line
                    .replace(/0x[0-9a-f]+/gi, '<addr>')
                    .replace(/opt id \d+/g, 'opt id <n>')
                    .replace(/bytecode offset \d+/g, 'bytecode offset <n>')
                    .replace(/deopt exit \d+/g, 'deopt exit <n>')
                    .replace(/FP to SP delta \d+/g, 'FP to SP delta <n>')
                    .slice(0, 500);
                  const counts = traceCountsByWindow[activeTraceWindow];
                  const existing = counts.get(boundedLine);
                  if (existing !== undefined) counts.set(boundedLine, existing + 1);
                  else if (counts.size < 24) counts.set(boundedLine, 1);
                }
              };
              child.stdout?.on('data', chunk => {
                pendingLine += chunk.toString();
                const lines = pendingLine.split(/\r?\n/);
                pendingLine = lines.pop() ?? '';
                for (const line of lines) onLine(line);
              });
              child.stdio[2]?.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-8_000); });
              child.stdio[3]?.on('data', chunk => { json += chunk.toString(); });
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill('SIGKILL');
                reject(new Error(`V8 trace child exceeded 90 seconds${stderrTail ? `: ${stderrTail}` : ''}`));
              }, 90_000);
              timer.unref();
              child.once('error', error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
              });
              child.once('close', (code, signal) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (pendingLine) onLine(pendingLine);
                if (code !== 0) {
                  reject(new Error(`V8 trace child exited code=${code} signal=${signal}${stderrTail ? `: ${stderrTail}` : ''}`));
                  return;
                }
                const summarizeCounts = (counts: Map<string, number>) =>
                  [...counts].map(([line, count]) => ({ line, count }));
                resolve({
                  json,
                  traceLines: {
                    primary: summarizeCounts(traceCountsByWindow.primary),
                    recoveryLifecycle: summarizeCounts(traceCountsByWindow.recoveryLifecycle),
                    recoveryWork: summarizeCounts(traceCountsByWindow.recoveryWork),
                  },
                });
              });
            });
            stdout = captured.json;
            traceLines = captured.traceLines;
          } else {
            const result = await exec(process.execPath, childArgs, { timeout: 90_000, maxBuffer: 128 * 1024 });
            stdout = result.stdout;
          }
          const result = JSON.parse(stdout);
          if (includeV8TierTraces) {
            result.v8TierTraceLines = traceLines ?? [];
          }
          return result;
        };

        const inspector = await run('inspector');
        const eager = await run('eager', [], true);
        const eagerNoTurboInlining = await run('eager', ['--no-turbo-inlining']);
        const eagerNoMaglevInlining = await run('eager', ['--no-maglev-inlining']);
        const eagerNoCompilerInlining = await run('eager', ['--no-turbo-inlining', '--no-maglev-inlining']);
        const inliningTraceScript = [
          "import { performance } from 'node:perf_hooks';",
          "import { setTimeout as delay } from 'node:timers/promises';",
          'let cursor = 1;',
          'let churnedFunctions = 0;',
          'const retained = Array.from({ length: 25000 }, (_, i) => {',
          "  const fn = new Function('return function map_' + i + '(x) { return x + ' + i + '; }')();",
          '  fn(i);',
          '  return fn;',
          '});',
          'function cpuHotFrame(durationMs = 8) {',
          '  const until = performance.now() + durationMs;',
          '  while (performance.now() < until) cursor = retained[cursor % retained.length](cursor) % retained.length;',
          '}',
          'async function workFor(durationMs) {',
          '  const until = performance.now() + durationMs;',
          '  while (performance.now() < until) {',
          '    cpuHotFrame();',
          '    const batch = Array.from({ length: 32 }, (_, offset) => {',
          "      const name = 'churn_' + churnedFunctions + offset;",
          "      const fn = new Function('x', 'return x + ' + (churnedFunctions + offset));",
          "      Object.defineProperty(fn, 'name', { value: name });",
          '      fn(cursor);',
          '      return fn;',
          '    });',
          '    churnedFunctions += batch.length;',
          '    void batch;',
          '    await delay(5);',
          '  }',
          '}',
          'for (let i = 0; i < 4; i++) await workFor(1500);',
          "process.stdout.write('@@inline-trace-control-finished@@');",
        ].join('\n');
        const { stdout: inlineTraceStdout, stderr: inlineTraceStderr } = await exec(
          process.execPath,
          ['--trace-turbo-inlining', '--input-type=module', '-e', inliningTraceScript],
          { timeout: 20_000, maxBuffer: 512 * 1024 },
        );
        const inlineTraceText = inlineTraceStdout + '\n' + inlineTraceStderr;
        const inlineTraceLines = inlineTraceText.split(/\r?\n/).filter(line =>
          (line.includes('SharedFunctionInfo workFor') || line.includes('SharedFunctionInfo cpuHotFrame')) &&
          (line.includes('Inlining') || line.includes('Considering')),
        );
        const cpuHotFrameInlinedIntoWorkFor = inlineTraceLines.some(line =>
          line.includes('SharedFunctionInfo cpuHotFrame') &&
          line.includes('into') &&
          line.includes('SharedFunctionInfo workFor'),
        );
        const median = (xs: number[]) => {
          const sorted = [...xs].sort((a, b) => a - b);
          const middle = Math.floor(sorted.length / 2);
          return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
        };
        const requiredPhaseMedianUsefulSamples = 3;
        const eagerPhaseMedianUsefulSamples = median(eager.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile.workWindow?.definite?.usefulSamples ?? 0));
        const noTurboInliningPhaseMedianUsefulSamples = median(eagerNoTurboInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile.workWindow?.definite?.usefulSamples ?? 0));
        const noMaglevInliningPhaseMedianUsefulSamples = median(eagerNoMaglevInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile.workWindow?.definite?.usefulSamples ?? 0));
        const noCompilerInliningPhaseMedianUsefulSamples = median(eagerNoCompilerInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile.workWindow?.definite?.usefulSamples ?? 0));
        const summarizeTierTrace = (result: typeof eager) => {
          const window = result.recoveryCapture.profile.workWindow;
          const sampleChains: NonNullable<TimedProfile['sampleChains']> = result.recoveryCapture.profile.sampleChains ?? [];
          const definiteSamples = sampleChains
            .filter(sample => {
              const offsetUs = sample.sampleOffsetUs;
              return offsetUs !== null && window !== undefined &&
                offsetUs >= window.definiteStartUs && offsetUs <= window.definiteEndUs;
            });
          const frameCounts = new Map<string, number>();
          const pathCounts = new Map<string, number>();
          for (const sample of definiteSamples) {
            const frames = sample.chain.map(frame => frame.callFrame.functionName || '(empty)');
            for (const frame of new Set(frames)) frameCounts.set(frame, (frameCounts.get(frame) ?? 0) + 1);
            const path = frames.slice(0, 6).join(' <- ');
            pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
          }
          const usefulExamples = definiteSamples
            .filter(sample => sample.chain.some(frame =>
              frame.callFrame.functionName === 'cpuHotFrame' || /^map_[0-9]+$/.test(frame.callFrame.functionName ?? ''),
            ))
            .slice(0, 6)
            .map(sample => ({ sampleOffsetUs: sample.sampleOffsetUs,
              frames: sample.chain.slice(0, 7).map(frame => frame.callFrame.functionName || '(empty)') }));
          return {
            flags: result.v8Flags,
            traceLines: result.v8TierTraceLines,
            recoveryPhaseMedianUsefulSamples: median(
              result.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile.workWindow?.definite?.usefulSamples ?? 0),
            ),
            definiteWorkWindow: {
              sampleCount: definiteSamples.length,
              frameCounts: [...frameCounts].sort((a, b) => b[1] - a[1]).slice(0, 10),
              pathCounts: [...pathCounts].sort((a, b) => b[1] - a[1]).slice(0, 6),
              usefulExamples,
            },
          };
        };
        let comparativeTierTrace: Record<string, unknown> | null = null;
        if (process.env.PAPERCUSP_CAPTURE_V8_TIER_TRACE === '1') {
          const traceFlags = ['--trace-opt', '--trace-deopt', '--trace-turbo-inlining', '--trace-maglev-inlining'];
          const tracedDefault = await run('eager', traceFlags, true, true);
          const tracedNoTurboInlining = await run(
            'eager',
            ['--no-turbo-inlining', ...traceFlags],
            true,
            true,
          );
          comparativeTierTrace = {
            default: summarizeTierTrace(tracedDefault),
            noTurboInlining: summarizeTierTrace(tracedNoTurboInlining),
            interpretation: 'Trace lines are grouped by their observed primary, recovery-lifecycle, or exact recovery-work output window; V8 trace lines do not carry timestamps here. Recovery-work events overlap the measured work interval. Sample offsets are relative to each profile start. Opaque optimization-status integers and missing frame names do not establish that a frame was inlined.',
          };
        }
        const gates = {
          sampleCap: eager.primary.sampleCount <= maxSamples &&
            eager.recoveryCapture.profile.samples <= maxSamples &&
            eager.recoveryPhaseSweep.every((capture: TimedCapture) => capture.profile.samples <= maxSamples) &&
            eager.delayed.cleanup.sampleCount <= maxSamples,
          primaryFixtureVisible: (eager.primary.profile.workWindow?.definite?.usefulSamples ?? 0) >= 1,
          recoveredHotFrames: (eager.recoveryCapture.profile.workWindow?.definite?.usefulSamples ?? 0) >= 3,
          repeatedRecoveryCoverage:
            eager.recoveryPhaseSweep.length === 10 &&
            eagerNoTurboInlining.recoveryPhaseSweep.length === 10 &&
            eagerNoMaglevInlining.recoveryPhaseSweep.length === 10 &&
            eagerNoCompilerInlining.recoveryPhaseSweep.length === 10 &&
            eagerPhaseMedianUsefulSamples >= requiredPhaseMedianUsefulSamples &&
            noTurboInliningPhaseMedianUsefulSamples >= requiredPhaseMedianUsefulSamples &&
            noMaglevInliningPhaseMedianUsefulSamples >= requiredPhaseMedianUsefulSamples &&
            noCompilerInliningPhaseMedianUsefulSamples >= requiredPhaseMedianUsefulSamples,
          discardedWithoutSerialization:
            !eager.disabledRevocation.serialized &&
            !eager.unsafeRevocation.serialized &&
            !eager.delayed.cleanup.serialized,
          disposedOnRevocation:
            eager.disabledRevocation.disposed &&
            eager.unsafeRevocation.disposed &&
            eager.delayed.cleanup.disposed,
          boundedMemory:
            eager.delayed.memory.peakRssDelta < 128 * 1024 * 1024 &&
            eager.delayed.memory.retainedHeapDelta < 16 * 1024 * 1024,
          lowerRecoveryGap:
            eager.recoveryWarmup.workerGapMaxMs < inspector.recoveryWarmup.workerGapMaxMs,
        };
        type TimedSampleSummary = {
          samples: number;
          hotSamples: number;
          mapSamples: number;
          usefulSamples: number;
          sampleFrameCounts: Array<[string, number]>;
          samplePathCounts: Array<[string, number]>;
        };
        type TimedProfile = {
          samples: number;
          nodes: number;
          nodeFunctionCounts: Array<[string, number]>;
          hotSamples: number;
          mapSamples: number;
          usefulSamples: number;
          timeDeltaCount: number;
          sampleOffsetCount: number;
          sampleOffsetStartUs: number | null;
          sampleOffsetEndUs: number | null;
          timeDeltaMinUs: number | null;
          timeDeltaMedianUs: number | null;
          timeDeltaMaxUs: number | null;
          timeDeltaSumUs: number;
          sampleChains?: Array<{
            sampleIndex: number;
            sampleId: number;
            sampleOffsetUs: number | null;
            sampleNodeResolved: boolean;
            missingNodeId: number | null;
            cycleDetected: boolean;
            chainComplete: boolean;
            chain: Array<{
              nodeId: number;
              parentNodeId: number | null;
              hitCount: number | null;
              callFrame: {
                functionName: string | null;
                scriptId: string | null;
                url: string | null;
                lineNumber: number | null;
                columnNumber: number | null;
              };
            }>;
          }>;
          profileDuration: number | null;
          workWindow: null | {
            possibleStartUs: number;
            definiteStartUs: number;
            definiteEndUs: number;
            possibleEndUs: number;
            possible: TimedSampleSummary;
            definite: TimedSampleSummary;
          };
          hotFrameWindows: null | {
            possible: TimedSampleSummary;
            definite: TimedSampleSummary;
          };
        };
        type TimedWindow = {
          possibleStartUs: number;
          definiteStartUs: number;
          definiteEndUs: number;
          possibleEndUs: number;
        };
        type TimedCapture = {
          workStartOffsetMs?: number;
          workload?: { hotFrameCalls: number; churnedFunctions: number };
          timing?: { startCallUs: number; workDurationUs: number; stopCallUs: number };
          durationMs?: number;
          workerGapMaxMs: number;
          inspectorControl?: { profile: TimedProfile; hotFrameWindowsUs?: TimedWindow[]; startCallUs: number };
          hotFrameWindowsUs?: TimedWindow[];
          profile: TimedProfile;
        };
        const summarizeCapture = (capture: TimedCapture) => {
          const profile = capture.profile;
          const summarizeTimedSamples = (samples: TimedSampleSummary) => ({
            samples: samples.samples,
            hotSamples: samples.hotSamples,
            mapSamples: samples.mapSamples,
            usefulSamples: samples.usefulSamples,
            sampleFrameCounts: samples.sampleFrameCounts.slice(0, 6),
            samplePathCounts: samples.samplePathCounts.slice(0, 4),
          });
          const summarizeProfile = (timedProfile: TimedProfile, hotFrameWindowsUs?: TimedWindow[]) => ({
            samples: timedProfile.samples,
            nodes: timedProfile.nodes,
            nodeFunctionCounts: timedProfile.nodeFunctionCounts,
            hotSamples: timedProfile.hotSamples,
            mapSamples: timedProfile.mapSamples,
            usefulSamples: timedProfile.usefulSamples,
            timeDeltaCount: timedProfile.timeDeltaCount,
            sampleOffsetCount: timedProfile.sampleOffsetCount,
            sampleOffsetStartUs: timedProfile.sampleOffsetStartUs,
            sampleOffsetEndUs: timedProfile.sampleOffsetEndUs,
            timeDeltaSumUs: timedProfile.timeDeltaSumUs,
            timeDeltaMinUs: timedProfile.timeDeltaMinUs,
            timeDeltaMedianUs: timedProfile.timeDeltaMedianUs,
            timeDeltaMaxUs: timedProfile.timeDeltaMaxUs,
            profileDuration: timedProfile.profileDuration,
            workWindow: timedProfile.workWindow ? {
              possibleStartUs: timedProfile.workWindow.possibleStartUs,
              definiteStartUs: timedProfile.workWindow.definiteStartUs,
              definiteEndUs: timedProfile.workWindow.definiteEndUs,
              possibleEndUs: timedProfile.workWindow.possibleEndUs,
              possible: summarizeTimedSamples(timedProfile.workWindow.possible),
              definite: summarizeTimedSamples(timedProfile.workWindow.definite),
            } : null,
            hotFrameWindows: timedProfile.hotFrameWindows ? {
              possible: summarizeTimedSamples(timedProfile.hotFrameWindows.possible),
              definite: summarizeTimedSamples(timedProfile.hotFrameWindows.definite),
            } : null,
            hotFrameWindowBoundsUs: hotFrameWindowsUs?.length ? {
              count: hotFrameWindowsUs.length,
              possibleStartUs: Math.min(...hotFrameWindowsUs.map(window => window.possibleStartUs)),
              definiteStartUs: Math.min(...hotFrameWindowsUs.map(window => window.definiteStartUs)),
              definiteEndUs: Math.max(...hotFrameWindowsUs.map(window => window.definiteEndUs)),
              possibleEndUs: Math.max(...hotFrameWindowsUs.map(window => window.possibleEndUs)),
            } : null,
            ...(timedProfile.sampleChains ? { sampleChainsCaptured: timedProfile.sampleChains.length } : {}),
          });
          return {
            workStartOffsetMs: capture.workStartOffsetMs ?? null,
            workload: capture.workload,
            timing: capture.timing ?? null,
            durationMs: capture.durationMs ?? null,
            workerGapMaxMs: capture.workerGapMaxMs,
            profile: summarizeProfile(profile, capture.hotFrameWindowsUs),
            ...(capture.inspectorControl ? {
              inspectorControl: {
                profileTimeOrigin: 'Profiler.start call invocation',
                startCallUs: capture.inspectorControl.startCallUs,
                profile: summarizeProfile(
                  capture.inspectorControl.profile,
                  capture.inspectorControl.hotFrameWindowsUs,
                ),
              },
            } : {}),
          };
        };
        const summarizeStrategy = (result: {
          startup: { durationMs: number; workerGapMaxMs: number };
          primary: TimedCapture;
          disabledRevocation: { serialized: boolean; disposed: boolean; sampleCount: number; durationMs: number; workerGapMaxMs: number };
          recoveryWarmup: { durationMs: number; workerGapMaxMs: number };
          recoveryCapture: TimedCapture;
          recoveryPhaseSweep: TimedCapture[];
          unsafeRevocation: { serialized: boolean; disposed: boolean; sampleCount: number; durationMs: number; workerGapMaxMs: number };
          delayed: { cleanup: { serialized: boolean; disposed: boolean; sampleCount: number }; durationMs: number; workerGapMaxMs: number; memory: { peakRssDelta: number; retainedHeapDelta: number } };
          serializations: number | null;
          churnedFunctions: number;
          recorderWarmups: number[];
        }) => ({
          startup: result.startup,
          primary: summarizeCapture(result.primary),
          disabledRevocation: result.disabledRevocation,
          recoveryWarmup: result.recoveryWarmup,
          recoveryCapture: summarizeCapture(result.recoveryCapture),
          recoveryPhaseSweep: result.recoveryPhaseSweep.map(summarizeCapture),
          unsafeRevocation: result.unsafeRevocation,
          delayed: result.delayed,
          serializations: result.serializations,
          churnedFunctions: result.churnedFunctions,
          recorderWarmups: result.recorderWarmups,
        });
        const summarizeInlineAttribution = (capture: TimedCapture) => {
          const samples = capture.profile.sampleChains ?? [];
          const hotWindows = capture.hotFrameWindowsUs ?? [];
          const containsFrame = (sample: NonNullable<TimedProfile['sampleChains']>[number], name: string) =>
            sample.chain.some(frame => frame.callFrame.functionName === name);
          const isInHotFrameWindow = (
            sample: NonNullable<TimedProfile['sampleChains']>[number],
            certainty: 'possible' | 'definite',
          ) => {
            if (sample.sampleOffsetUs === null) return false;
            return hotWindows.some(window => {
              const startUs = certainty === 'definite' ? window.definiteStartUs : window.possibleStartUs;
              const endUs = certainty === 'definite' ? window.definiteEndUs : window.possibleEndUs;
              return sample.sampleOffsetUs! >= startUs && sample.sampleOffsetUs! <= endUs;
            });
          };
          const workSamples = samples.filter(sample => containsFrame(sample, 'workFor'));
          const hotFrameSamples = samples.filter(sample => containsFrame(sample, 'cpuHotFrame'));
          const bothSamples = samples.filter(sample =>
            containsFrame(sample, 'workFor') && containsFrame(sample, 'cpuHotFrame'),
          );
          const possibleHotWindowSamples = samples.filter(sample => isInHotFrameWindow(sample, 'possible'));
          const definiteHotWindowSamples = samples.filter(sample => isInHotFrameWindow(sample, 'definite'));
          return {
            sampleCount: capture.profile.samples,
            capturedChains: samples.length,
            measuredHotFrameWindows: hotWindows.length,
            workForSamples: workSamples.length,
            cpuHotFrameSamples: hotFrameSamples.length,
            workForAndCpuHotFrameSamples: bothSamples.length,
            possibleHotWindowSamples: possibleHotWindowSamples.length,
            possibleHotWindowCpuHotFrameSamples: possibleHotWindowSamples.filter(sample => containsFrame(sample, 'cpuHotFrame')).length,
            definiteHotWindowSamples: definiteHotWindowSamples.length,
            definiteHotWindowCpuHotFrameSamples: definiteHotWindowSamples.filter(sample => containsFrame(sample, 'cpuHotFrame')).length,
            definiteHotWindowPaths: definiteHotWindowSamples.slice(0, 8).map(sample => sample.chain
              .slice(0, 6)
              .map(frame => frame.callFrame.functionName)),
            exampleWorkForPaths: workSamples.slice(0, 4).map(sample => sample.chain
              .slice(0, 6)
              .map(frame => ({ functionName: frame.callFrame.functionName, lineNumber: frame.callFrame.lineNumber }))),
          };
        };
        const primaryInlineAttribution = summarizeInlineAttribution(eager.primary);
        const recoveryInlineAttribution = summarizeInlineAttribution(eager.recoveryCapture);
        const recoveryInspectorHotWindow = eager.recoveryCapture.inspectorControl?.profile.hotFrameWindows?.definite;
        const recoveryInspectorInlineAttribution = eager.recoveryCapture.inspectorControl
          ? {
              sampleCount: eager.recoveryCapture.inspectorControl.profile.samples,
              definiteHotWindowSamples: recoveryInspectorHotWindow?.samples ?? 0,
              definiteHotWindowCpuHotFrameSamples: recoveryInspectorHotWindow?.hotSamples ?? 0,
              definiteHotWindowPaths: recoveryInspectorHotWindow?.samplePathCounts ?? [],
            }
          : null;
        const inspectorHotWindowCpuHotFrameSamples = recoveryInspectorInlineAttribution?.definiteHotWindowCpuHotFrameSamples ?? 0;
        const eagerHotWindowCpuHotFrameSamples = recoveryInlineAttribution.definiteHotWindowCpuHotFrameSamples;
        const hasPairedHotWindowSampleCoverage =
          (recoveryInspectorInlineAttribution?.definiteHotWindowSamples ?? 0) >= 3 &&
          recoveryInlineAttribution.definiteHotWindowSamples >= 3;
        const inlineStackDiagnostic = {
          cpuHotFrameInlinedIntoWorkFor: cpuHotFrameInlinedIntoWorkFor,
          relevantCompilerTraceLines: inlineTraceLines.slice(0, 20),
          eagerPrimary: primaryInlineAttribution,
          eagerAfterProfilerRecreation: recoveryInlineAttribution,
          inspectorSameWindowControl: recoveryInspectorInlineAttribution,
          pairedControlConclusion: hasPairedHotWindowSampleCoverage
            ? inspectorHotWindowCpuHotFrameSamples > eagerHotWindowCpuHotFrameSamples
              ? `Inspector names cpuHotFrame in ${inspectorHotWindowCpuHotFrameSamples} definite hot-window samples versus ${eagerHotWindowCpuHotFrameSamples} for eager; this is a measured eager-attribution deficit, but does not isolate code-map replay from symbolization.`
              : inspectorHotWindowCpuHotFrameSamples === eagerHotWindowCpuHotFrameSamples
                ? `Both profiles name cpuHotFrame in ${eagerHotWindowCpuHotFrameSamples} definite hot-window samples; this run shows no same-window attribution deficit.`
                : `Eager names cpuHotFrame in ${eagerHotWindowCpuHotFrameSamples} definite hot-window samples versus ${inspectorHotWindowCpuHotFrameSamples} for Inspector; this run shows no eager-attribution deficit.`
            : 'The paired profiles did not both produce at least three definite hot-window samples, so they cannot distinguish attribution paths.',
          interpretation: hasPairedHotWindowSampleCoverage
            ? `${cpuHotFrameInlinedIntoWorkFor ? 'The compiler trace reports cpuHotFrame inlining into workFor.' : 'The compiler trace does not show cpuHotFrame inlining into workFor.'} Paired definite-window counts were eager=${eagerHotWindowCpuHotFrameSamples} and Inspector=${inspectorHotWindowCpuHotFrameSamples}; the difference is measured but does not identify its mechanism.`
            : 'The paired profiles lack enough definite hot-window samples to distinguish attribution paths or interpret the compiler-trace comparison.',
        };
        console.info('P-003 paired eager V8 profiler measurement:', JSON.stringify({
          inspector: summarizeStrategy(inspector),
          eager: summarizeStrategy(eager),
          noTurboInlining: summarizeStrategy(eagerNoTurboInlining),
          noMaglevInlining: summarizeStrategy(eagerNoMaglevInlining),
          noCompilerInlining: summarizeStrategy(eagerNoCompilerInlining),
          phaseSweepMedianDefiniteWorkWindowUsefulSamples: {
            requiredPhaseMedianUsefulSamples,
            default: eagerPhaseMedianUsefulSamples,
            noTurboInlining: noTurboInliningPhaseMedianUsefulSamples,
            noMaglevInlining: noMaglevInliningPhaseMedianUsefulSamples,
            noCompilerInlining: noCompilerInliningPhaseMedianUsefulSamples,
          },
          inlineStackDiagnostic,
          gates: { ...gates, candidateQualified: Object.values(gates).every(Boolean) },
        }));
        if (comparativeTierTrace) {
          console.info('P-003 comparative V8 tier trace:', JSON.stringify(comparativeTierTrace));
        }

        expect(eager.primary.serialized).toBe(true);
        expect(eager.primary.profile.samples).toBeLessThanOrEqual(maxSamples);
        // Prove the fixture is visible in V8-emitted sample stacks before
        // interpreting a post-disposal miss as lifecycle recovery failure.
        expect(eager.primary.profile.workWindow?.definite.usefulSamples ?? 0).toBeGreaterThanOrEqual(1);
        expect(eager.primary.profile.bytes).toBeLessThan(8 * 1024 * 1024);
        expect(recoveryInspectorInlineAttribution?.definiteHotWindowSamples).toBeGreaterThanOrEqual(3);
        expect(eager.recoveryCapture.profile.workWindow?.definite.samples ?? 0).toBeGreaterThanOrEqual(3);
        const recoverySampleChains = eager.recoveryCapture.profile.sampleChains ?? [];
        expect(recoverySampleChains).toHaveLength(eager.recoveryCapture.profile.samples);
        for (const [index, sample] of recoverySampleChains.entries()) {
          expect(sample.sampleIndex).toBe(index);
          expect(sample.sampleId).toBeDefined();
          expect(sample.sampleNodeResolved).toBe(sample.chain[0]?.nodeId === sample.sampleId);
          expect(sample.chainComplete).toBe(sample.missingNodeId === null && !sample.cycleDetected);
          for (const frame of sample.chain) {
            expect(Object.keys(frame.callFrame).sort()).toEqual([
              'columnNumber',
              'functionName',
              'lineNumber',
              'scriptId',
              'url',
            ]);
          }
        }
        expect(eagerNoTurboInlining.recoveryCapture.workload.hotFrameCalls).toBeGreaterThan(0);
        expect(eagerNoTurboInlining.recoveryCapture.workload.churnedFunctions).toBeGreaterThan(0);
        expect(eagerNoMaglevInlining.recoveryCapture.workload.hotFrameCalls).toBeGreaterThan(0);
        expect(eagerNoMaglevInlining.recoveryCapture.workload.churnedFunctions).toBeGreaterThan(0);
        expect(eagerNoCompilerInlining.recoveryCapture.workload.hotFrameCalls).toBeGreaterThan(0);
        expect(eagerNoCompilerInlining.recoveryCapture.workload.churnedFunctions).toBeGreaterThan(0);
        const recoveryPhaseOffsetsMs = [0, 2, 4, 6, 8, 8, 6, 4, 2, 0];
        expect(eager.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.workStartOffsetMs)).toEqual(recoveryPhaseOffsetsMs);
        expect(eagerNoTurboInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.workStartOffsetMs)).toEqual(recoveryPhaseOffsetsMs);
        expect(eagerNoMaglevInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.workStartOffsetMs)).toEqual(recoveryPhaseOffsetsMs);
        expect(eagerNoCompilerInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.workStartOffsetMs)).toEqual(recoveryPhaseOffsetsMs);
        for (const capture of [
          ...eager.recoveryPhaseSweep,
          ...eagerNoTurboInlining.recoveryPhaseSweep,
          ...eagerNoMaglevInlining.recoveryPhaseSweep,
          ...eagerNoCompilerInlining.recoveryPhaseSweep,
        ]) {
          expect(capture.workload.hotFrameCalls).toBeGreaterThan(0);
          expect(capture.workload.churnedFunctions).toBeGreaterThan(0);
          expect(capture.profile.samples).toBeLessThanOrEqual(maxSamples);
          expect(capture.profile.bytes).toBeLessThan(8 * 1024 * 1024);
        }
        for (const profile of [
          eager.recoveryCapture.profile,
          eagerNoTurboInlining.recoveryCapture.profile,
          eagerNoMaglevInlining.recoveryCapture.profile,
          eagerNoCompilerInlining.recoveryCapture.profile,
          ...eager.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile),
          ...eagerNoTurboInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile),
          ...eagerNoMaglevInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile),
          ...eagerNoCompilerInlining.recoveryPhaseSweep.map((capture: TimedCapture) =>capture.profile),
        ]) {
          expect(profile.timeDeltaCount).toBe(profile.samples);
          expect(profile.sampleOffsetCount).toBe(profile.samples);
          expect(profile.profileDuration).toBeGreaterThan(0);
          expect(profile.workWindow.definite.samples).toBeLessThanOrEqual(profile.workWindow.possible.samples);
        }
        expect(eager.disabledRevocation.serialized).toBe(false);
        expect(eager.unsafeRevocation.serialized).toBe(false);
        expect(eager.delayed.cleanup.serialized).toBe(false);
        expect(eager.delayed.cleanup.disposed).toBe(true);
        expect(eager.serializations).toBe(2 + eager.recoveryPhaseSweep.length);
        expect(Number.isFinite(eager.recoveryWarmup.workerGapMaxMs)).toBe(true);
        expect(Number.isFinite(eager.delayed.workerGapMaxMs)).toBe(true);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    process.env.PAPERCUSP_CAPTURE_V8_TIER_TRACE === '1' ? 240_000 : 120_000,
  );
});

describe('reusable eager CPU profiler capture windows', () => {
  it.skipIf(!hasNode259ProfilerHeaders)(
    'compares retaining eager code logging across stopped sampling windows with dispose and recreate',
    async () => {
      const maxSamples = 64;
      const captureCount = 12;
      const tempDir = await mkdtemp(join(tmpdir(), 'papercusp-eager-reuse-'));
      const addonPath = join(tempDir, 'eager-profiler.node');

      try {
        await exec(
          process.env.CXX ?? 'c++',
          ['-std=c++20', '-shared', '-fPIC', '-O2', '-I' + nodeIncludePath, eagerAdapterPath, '-o', addonPath],
          { timeout: 30_000, maxBuffer: 128 * 1024 },
        );
        expect(existsSync(addonPath)).toBe(true);

        type Capture = {
          index: number;
          startMs: number;
          stopMs: number;
          startGapMaxMs: number;
          stopGapMaxMs: number;
          workGapMaxMs: number;
          lifecycleGapMaxMs: number;
          activeFrameCalls: number;
          disposed: boolean;
          profile: {
            samples: number;
            definiteSamples: number;
            usefulSamples: number;
            mapSamples: number;
            cpuHotFrameSamples: number;
            disabledHotFrameSamples: number;
            bytes: number;
          };
        };
        type LifecycleRun = {
          mode: 'reuse' | 'recreate';
          trial: number;
          captures: Capture[];
          cleanupGapMaxMs: number | null;
          memory: { peakRssDelta: number; retainedHeapDelta: number };
          serializations: number;
        };
        const run = async (mode: 'reuse' | 'recreate', trial: number): Promise<LifecycleRun> => {
          const workerSource = [
            "const { parentPort } = require('node:worker_threads');",
            'let waiting = false;',
            'function tick() { if (waiting) return; waiting = true; parentPort.postMessage(1); }',
            "parentPort.on('message', () => { waiting = false; setTimeout(tick, 5); });",
            'tick();',
          ].join(' ');
          const childScript = [
            "import { createRequire } from 'node:module';",
            "import { performance } from 'node:perf_hooks';",
            "import { setTimeout as delay } from 'node:timers/promises';",
            "import { Worker } from 'node:worker_threads';",
            'const require = createRequire(import.meta.url);',
            'const mode = ' + JSON.stringify(mode) + ';',
            'const maxSamples = ' + maxSamples + ';',
            'const captureCount = ' + captureCount + ';',
            'const addon = require(' + JSON.stringify(addonPath) + ');',
            'let cursor = 1;',
            'const retained = Array.from({ length: 25000 }, (_, i) => {',
            "  const fn = new Function('return function map_' + i + '(x) { return x + ' + i + '; }')();",
            '  fn(i);',
            '  return fn;',
            '});',
            'let activeFrameCalls = 0;',
            'let disabledFrameCalls = 0;',
            'function cpuHotFrame(durationMs = 4) {',
            '  activeFrameCalls++;',
            '  const until = performance.now() + durationMs;',
            '  while (performance.now() < until) cursor = retained[cursor % retained.length](cursor) % retained.length;',
            '}',
            'function disabledHotFrame(durationMs = 4) {',
            '  disabledFrameCalls++;',
            '  const until = performance.now() + durationMs;',
            '  while (performance.now() < until) cursor = retained[cursor % retained.length](cursor) % retained.length;',
            '}',
            'async function workFor(durationMs, frame) {',
            '  const until = performance.now() + durationMs;',
            '  while (performance.now() < until) { frame(); await delay(5); }',
            '}',
            'const worker = new Worker(' + JSON.stringify(workerSource) + ', { eval: true, execArgv: [] });',
            'let gapWindow = null;',
            "worker.on('message', () => { const now = performance.now(); if (gapWindow) { gapWindow.maxMs = Math.max(gapWindow.maxMs, now - gapWindow.lastMs); gapWindow.lastMs = now; } worker.postMessage('ack'); });",
            'await new Promise(resolve => worker.once("online", resolve));',
            'await delay(40);',
            'async function measure(action) {',
            '  await delay(20);',
            '  const window = { maxMs: 0, lastMs: performance.now() };',
            '  gapWindow = window;',
            '  const startedNs = process.hrtime.bigint();',
            '  const value = action();',
            '  const returnedNs = process.hrtime.bigint();',
            '  await delay(20);',
            '  gapWindow = null;',
            '  return { value, durationMs: Number(returnedNs - startedNs) / 1e6, workerGapMaxMs: window.maxMs };',
            '}',
            'async function measureWork(durationMs, frame) {',
            '  await delay(20);',
            '  const window = { maxMs: 0, lastMs: performance.now() };',
            '  gapWindow = window;',
            '  const startedNs = process.hrtime.bigint();',
            '  await workFor(durationMs, frame);',
            '  const endedNs = process.hrtime.bigint();',
            '  await delay(20);',
            '  gapWindow = null;',
            '  return { startedNs, endedNs, workerGapMaxMs: window.maxMs };',
            '}',
            'const elapsedUs = (startNs, endNs) => Number(endNs - startNs) / 1000;',
            'function summarize(profile, workWindow) {',
            '  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];',
            '  const samples = Array.isArray(profile?.samples) ? profile.samples : [];',
            '  const deltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];',
            '  const byId = new Map(nodes.map(node => [node.id, node]));',
            '  const parentById = new Map();',
            '  for (const node of nodes) for (const child of node.children ?? []) parentById.set(child, node.id);',
            '  let offsetUs = 0;',
            '  const offsets = deltas.map(delta => (offsetUs += delta));',
            '  const sampledFrames = samples.map((sampleId, index) => {',
            '    const frames = [], seen = new Set();',
            '    let nodeId = sampleId;',
            '    while (nodeId !== undefined && !seen.has(nodeId)) {',
            '      seen.add(nodeId);',
            '      const node = byId.get(nodeId);',
            '      if (!node) break;',
            '      frames.push(node.callFrame?.functionName ?? "");',
            '      nodeId = parentById.get(nodeId);',
            '    }',
            '    return { offsetUs: offsets[index] ?? null, frames };',
            '  });',
            '  const definite = sampledFrames.filter(sample => sample.offsetUs !== null && sample.offsetUs >= workWindow.definiteStartUs && sample.offsetUs <= workWindow.definiteEndUs);',
            '  return {',
            '    samples: samples.length,',
            '    definiteSamples: definite.length,',
            '    usefulSamples: definite.filter(sample => sample.frames.includes("cpuHotFrame") || sample.frames.some(name => /^map_[0-9]+$/.test(name))).length,',
            '    mapSamples: definite.filter(sample => sample.frames.some(name => /^map_[0-9]+$/.test(name))).length,',
            '    cpuHotFrameSamples: definite.filter(sample => sample.frames.includes("cpuHotFrame")).length,',
            '    disabledHotFrameSamples: definite.filter(sample => sample.frames.includes("disabledHotFrame")).length,',
            '    bytes: Buffer.byteLength(JSON.stringify(profile)),',
            '  };',
            '}',
            'addon.create();',
            'const memoryBefore = process.memoryUsage();',
            'let peakRss = memoryBefore.rss;',
            'let peakHeapUsed = memoryBefore.heapUsed;',
            'const captures = [];',
            'for (let index = 0; index < captureCount; index++) {',
            '  const callsBefore = activeFrameCalls;',
            '  const start = await measure(() => {',
            '    if (mode === "recreate" && index > 0) addon.create();',
            '    const startedNs = process.hrtime.bigint();',
            '    addon.start(maxSamples);',
            '    return { startedNs, returnedNs: process.hrtime.bigint() };',
            '  });',
            '  const work = await measureWork(350, cpuHotFrame);',
            '  const stop = await measure(() => addon.finish(true, mode === "recreate"));',
            '  const workWindow = {',
            '    definiteStartUs: elapsedUs(start.value.returnedNs, work.startedNs),',
            '    definiteEndUs: elapsedUs(start.value.startedNs, work.endedNs),',
            '  };',
            '  const profile = JSON.parse(stop.value.profileJson);',
            '  captures.push({',
            '    index,',
            '    startMs: start.durationMs,',
            '    stopMs: stop.durationMs,',
            '    startGapMaxMs: start.workerGapMaxMs,',
            '    stopGapMaxMs: stop.workerGapMaxMs,',
            '    workGapMaxMs: work.workerGapMaxMs,',
            '    lifecycleGapMaxMs: Math.max(start.workerGapMaxMs, stop.workerGapMaxMs),',
            '    activeFrameCalls: activeFrameCalls - callsBefore,',
            '    disposed: stop.value.disposed,',
            '    profile: summarize(profile, workWindow),',
            '  });',
            '  const memory = process.memoryUsage();',
            '  peakRss = Math.max(peakRss, memory.rss);',
            '  peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);',
            '  if (index % 3 === 2 && global.gc) global.gc();',
            '  await workFor(80, disabledHotFrame);',
            '}',
            'let cleanup = null;',
            'if (mode === "reuse") cleanup = await measure(() => addon.dispose());',
            'const memoryAfter = process.memoryUsage();',
            'await worker.terminate();',
            'process.stdout.write(JSON.stringify({ mode, trial: ' + trial + ', captures, cleanupGapMaxMs: cleanup?.workerGapMaxMs ?? null,',
            '  memory: { peakRssDelta: peakRss - memoryBefore.rss, retainedHeapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed },',
            '  serializations: addon.serializationCount() }));',
          ].join('\n');

          const { stdout } = await exec(
            process.execPath,
            ['--expose-gc', '--input-type=module', '-e', childScript],
            { timeout: 30_000, maxBuffer: 128 * 1024 },
          );
          return JSON.parse(stdout) as LifecycleRun;
        };

        const results: LifecycleRun[] = [];
        for (let trial = 0; trial < 3; trial++) {
          const order: Array<'reuse' | 'recreate'> = trial % 2 === 0 ? ['reuse', 'recreate'] : ['recreate', 'reuse'];
          for (const mode of order) results.push(await run(mode, trial));
        }
        const median = (values: number[]) => {
          const sorted = [...values].sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        };
        const summaries = results.map(result => ({
          mode: result.mode,
          trial: result.trial,
          captures: result.captures.length,
          medianUsefulSamples: median(result.captures.map(capture => capture.profile.usefulSamples)),
          minimumUsefulSamples: Math.min(...result.captures.map(capture => capture.profile.usefulSamples)),
          maxStartMs: Math.max(...result.captures.map(capture => capture.startMs)),
          maxStopMs: Math.max(...result.captures.map(capture => capture.stopMs)),
          maxStartGapMs: Math.max(...result.captures.map(capture => capture.startGapMaxMs)),
          maxStopGapMs: Math.max(...result.captures.map(capture => capture.stopGapMaxMs)),
          maxWorkGapMs: Math.max(...result.captures.map(capture => capture.workGapMaxMs)),
          maxLifecycleGapMs: Math.max(...result.captures.map(capture => capture.lifecycleGapMaxMs)),
          disabledHotFrameSamples: result.captures.reduce((sum, capture) => sum + capture.profile.disabledHotFrameSamples, 0),
          sampleCapRespected: result.captures.every(capture => capture.profile.samples <= maxSamples),
          memory: result.memory,
          serializations: result.serializations,
        }));
        console.info('P-003 reusable eager profiler lifecycle comparison:', JSON.stringify(summaries));

        expect(results).toHaveLength(6);
        for (const result of results) {
          expect(result.captures).toHaveLength(captureCount);
          expect(result.serializations).toBe(captureCount);
          expect(result.captures.every(capture => capture.profile.samples > 0)).toBe(true);
          expect(result.captures.every(capture => capture.profile.definiteSamples > 0)).toBe(true);
          expect(result.captures.every(capture => capture.activeFrameCalls > 0)).toBe(true);
          expect(result.captures.every(capture => capture.profile.samples <= maxSamples)).toBe(true);
          expect(result.captures.every(capture => capture.disposed === (result.mode === 'recreate'))).toBe(true);
          expect(result.captures.every(capture => Number.isFinite(capture.lifecycleGapMaxMs))).toBe(true);
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
