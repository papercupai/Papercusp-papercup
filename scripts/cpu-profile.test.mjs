import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { aggregateCpuProfile, classifyCpuFrame, nodeCpuProfileArgs, sampleDurations } from './lib/cpu-profile.mjs';

test('startup profiling preserves both main and worker captures', { timeout: 15_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'cpu-profile-isolates-'));
  try {
    const result = spawnSync(process.execPath, [...nodeCpuProfileArgs(directory), '-e', `
      const { Worker } = require('node:worker_threads');
      const worker = new Worker(
        'function cpuProfileWorkerMarker() { const end = Date.now() + 250; while (Date.now() < end) Math.sqrt(Math.random()); } cpuProfileWorkerMarker();',
        { eval: true },
      );
      function cpuProfileMainMarker() {
        const end = Date.now() + 250;
        while (Date.now() < end) Math.sqrt(Math.random());
      }
      cpuProfileMainMarker();
      worker.on('exit', () => {});
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const profiles = readdirSync(directory).filter(name => name.endsWith('.cpuprofile'))
      .map(name => ({ name, nodes: JSON.parse(readFileSync(join(directory, name), 'utf8')).nodes }));
    const main = profiles.find(profile => profile.nodes.some(node => node.callFrame.functionName === 'cpuProfileMainMarker'));
    const worker = profiles.find(profile => profile.nodes.some(node => node.callFrame.functionName === 'cpuProfileWorkerMarker'));
    assert.ok(main, 'main-thread CPU profile must survive worker shutdown');
    assert.ok(worker, 'worker CPU profile must survive main-thread shutdown');
    assert.notEqual(main.name, worker.name);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('observer and non-work frames are excluded while GC remains real workload', () => {
  assert.equal(classifyCpuFrame('(garbage collector)'), null);

  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: 'inspectorPump', url: 'node:inspector', lineNumber: 1 } },
      { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: 2 } },
      { id: 3, callFrame: { functionName: '(program)', url: '', lineNumber: 3 } },
      { id: 4, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: 4 } },
      { id: 5, callFrame: { functionName: 'realWork', url: 'file:///repo/app.mjs', lineNumber: 5 } },
    ],
    samples: [1, 2, 3, 4, 5],
    timeDeltas: [100, 200, 300, 400, 500],
  };

  const result = aggregateCpuProfile(profile);

  // Sample i is credited with the FOLLOWING interval; the last sample (no endTime)
  // gets the median interval (400); the 100 µs lead-in is credited to no frame.
  assert.equal(result.totalUs, 1800);
  assert.equal(result.excludedUs, 900);
  assert.deepEqual(result.excludedByKind, { profiler: 200, 'non-work': 700 });
  assert.equal(result.realUs, 900);
  assert.equal(result.leadInUs, 100);
  assert.equal(result.unsampledGapUs, 0);
  assert.deepEqual(result.frames.map(([frame, us]) => [frame.split(' @ ', 1)[0], us]), [
    ['(garbage collector)', 500],
    ['realWork', 400],
  ]);
});

// WI-10005421: a sentinel stall profile opens with a ~2 s lead-in before its first
// sample and can contain a mid-profile stretch the sampler never recorded. Neither
// may be credited to the frame that happened to be on top next to it.
test('a stall profile does not credit unsampled stretches to an adjacent frame', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: 'firstLeaf', url: 'file:///repo/a.mjs', lineNumber: 1 } },
      { id: 2, callFrame: { functionName: 'steady', url: 'file:///repo/b.mjs', lineNumber: 2 } },
    ],
    samples: [1, 2, 2, 2, 1, 2],
    // 2 s lead-in, 1 ms sampling, then a 1.5 s unsampled gap after the 4th sample.
    timeDeltas: [2_000_000, 1000, 1000, 1000, 1_500_000, 1000],
  };

  const result = aggregateCpuProfile(profile);
  const self = Object.fromEntries(result.frames.map(([frame, us]) => [frame.split(' @ ', 1)[0], us]));

  assert.deepEqual(self, { firstLeaf: 2000, steady: 4000 });
  assert.equal(result.totalUs, 6000);
  assert.equal(result.leadInUs, 2_000_000);
  assert.equal(result.unsampledGapUs, 1_499_000);
  assert.equal(result.gapCount, 1);
  assert.equal(result.nominalIntervalUs, 1000);
});

test('the last sample is credited up to endTime when the profile records one', () => {
  const profile = {
    nodes: [{ id: 1, callFrame: { functionName: 'only', url: 'file:///repo/a.mjs', lineNumber: 1 } }],
    samples: [1, 1, 1],
    startTime: 10_000,
    timeDeltas: [500, 1000, 1000],
    endTime: 13_300,
  };

  const { durations, leadInUs, gaps } = sampleDurations(profile);

  assert.deepEqual([...durations], [1000, 1000, 800]);
  assert.equal(leadInUs, 500);
  assert.deepEqual(gaps, []);
});
