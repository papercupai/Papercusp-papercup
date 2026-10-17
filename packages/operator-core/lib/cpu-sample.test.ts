// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createTextCollector } from './child-output';
import * as cdpInspector from '../../../scripts/cdp-inspector.mjs';
import { captureCpuProfile, persistCpuProfile, readInspectorProcessIdentity } from '../../../scripts/cpu-sample.mjs';

it('creates a raw profile and verifies an existing read-only capture without rewriting it', () => {
  const out = mkdtempSync(join(tmpdir(), 'cpu-sample-save-'));
  const file = join(out, 'profile.cpuprofile');
  const raw = Buffer.from('{"nodes":[{"id":1}],"samples":[1]}');
  try {
    expect(persistCpuProfile(file, raw)).toEqual({ created: true, bytes: raw.length });
    expect(readFileSync(file)).toEqual(raw);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o444);
    const before = statSync(file);
    expect(persistCpuProfile(file, raw)).toEqual({ created: false, bytes: raw.length });
    const after = statSync(file);
    expect([after.ino, after.uid, after.mode, after.mtimeMs, after.ctimeMs])
      .toEqual([before.ino, before.uid, before.mode, before.mtimeMs, before.ctimeMs]);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

it('creates an explicitly shared profile despite a restrictive umask and preserves existing permissions', () => {
  const out = mkdtempSync(join(tmpdir(), 'cpu-sample-shared-'));
  const file = join(out, 'profile.cpuprofile');
  const raw = Buffer.from('{"nodes":[{"id":1}],"samples":[1]}');
  const previousUmask = process.umask(0o077);
  try {
    expect(persistCpuProfile(file, raw, { mode: 0o644 })).toEqual({ created: true, bytes: raw.length });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    chmodSync(file, 0o444);
    const before = statSync(file);
    expect(persistCpuProfile(file, raw, { mode: 0o644 })).toEqual({ created: false, bytes: raw.length });
    const after = statSync(file);
    expect([after.ino, after.uid, after.mode, after.mtimeMs, after.ctimeMs])
      .toEqual([before.ino, before.uid, before.mode, before.mtimeMs, before.ctimeMs]);
    expect(readFileSync(file)).toEqual(raw);
  } finally {
    process.umask(previousUmask);
    rmSync(out, { recursive: true, force: true });
  }
});

it('rejects unsupported profile permissions before creating an output', () => {
  const out = mkdtempSync(join(tmpdir(), 'cpu-sample-mode-'));
  const file = join(out, 'profile.cpuprofile');
  try {
    expect(() => persistCpuProfile(file, '{}', { mode: 0o666 as 420 }))
      .toThrow('creation mode must be 0600 or 0644');
    expect(existsSync(file)).toBe(false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

it('refuses a differing profile without overwriting the existing capture', () => {
  const out = mkdtempSync(join(tmpdir(), 'cpu-sample-collision-'));
  const file = join(out, 'profile.cpuprofile');
  const original = '{"nodes":[{"id":1}],"samples":[1]}';
  try {
    writeFileSync(file, original);
    expect(() => persistCpuProfile(file, '{"nodes":[],"samples":[]}'))
      .toThrow('already contains different bytes');
    expect(readFileSync(file, 'utf8')).toBe(original);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

async function withTarget(run: (target: { pid: number; port: number; out: string }) => Promise<void>) {
  const out = mkdtempSync(join(tmpdir(), 'cpu-sample-test-'));
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--cpu-prof',
    '--cpu-prof-dir=' + out, '--cpu-prof-name=killed.cpuprofile', '-e',
    'function profiledWork(){const until=Date.now()+10;while(Date.now()<until)Math.sqrt(Math.random());}setInterval(profiledWork,15);console.log("CPU_SAMPLE_TARGET_READY");',
    'cpu-sample-target', '--probe-target'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inspector did not open')), 5000);
      let inspectorPort: number | undefined;
      let ready = false;
      const settle = () => { if (inspectorPort && ready) { clearTimeout(timer); resolve(inspectorPort); } };
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stderr!.on('data', chunk => {
        const match = String(chunk).match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) { inspectorPort = Number(match[1]); settle(); }
      });
      child.stdout!.on('data', chunk => {
        if (String(chunk).includes('CPU_SAMPLE_TARGET_READY')) { ready = true; settle(); }
      });
    });
    await run({ pid: child.pid!, port, out });
    child.kill('SIGTERM');
    expect((await exit)[1]).toBe('SIGTERM');
    // The explicit inspector stop preserves data that exit-only --cpu-prof loses.
    expect(existsSync(join(out, 'killed.cpuprofile'))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
    rmSync(out, { recursive: true, force: true });
  }
}

it('collects a real startup profile before SIGTERM without changing the child exit', async () => {
  await withTarget(async ({ pid, port }) => {
    const result = await captureCpuProfile({ pid, startPort: port, attachExisting: true,
      expectedEntry: 'cpu-sample-target', expectedArg: '--probe-target', durationMs: 250, deadlineMs: 7000 });
    expect(result.target.pid).toBe(pid);
    expect(result.profile.samples.length).toBeGreaterThan(0);
    // V8 may inline the callback into its timer caller (especially with a second
    // --cpu-prof session). Verify sampled work and a real interval, not its name.
    const samples = new Set(result.profile.samples);
    expect(result.profile.endTime).toBeGreaterThan(result.profile.startTime);
    expect(result.profile.nodes.some((node: { id: number; callFrame: { functionName: string } }) =>
      samples.has(node.id) && !['(root)', '(idle)', '(program)', '(garbage collector)']
        .includes(node.callFrame.functionName))).toBe(true);
  });
}, 15000);

it.each([
  { expectedEntry: 'different-entry', expectedArg: '--probe-target' },
  { expectedEntry: 'cpu-sample-target', expectedArg: '--different-argument' },
])('refuses an inspector whose entry or required argument differs: %j', async mismatch => {
  await withTarget(async ({ pid, port }) => {
    await expect(captureCpuProfile({ pid, startPort: port, attachExisting: true,
      ...mismatch, durationMs: 250, deadlineMs: 7000 })).rejects.toThrow('identity mismatch');
  });
}, 15000);

it('requires an exact entry when the pid is unknown', async () => {
  await expect(captureCpuProfile({ pid: 0, attachExisting: true, startPort: 9229,
    durationMs: 250 })).rejects.toThrow('exact expected entry');
});

async function withBusyTarget(run: (target: { pid: number; port: number; entry: string;
  output: () => string }) => Promise<void>, waitForStartup = false) {
  const out = mkdtempSync(join(tmpdir(), 'cpu-sample-busy-'));
  const entry = join(out, 'startup.mjs');
  // The target immediately enters a synchronous loop, so an async console.log
  // can remain buffered in Node's pipe writer. Flush the marker before the
  // loop to make the startup/output assertion deterministic.
  writeFileSync(entry, 'import { writeSync } from "node:fs";writeSync(1, "CPU_SAMPLE_BUSY_READY\\n");function busyStartup(){while(true)Math.sqrt(Math.random());}busyStartup();');
  // The test runner loads the committed-source guard through NODE_OPTIONS. Do
  // not inherit that loader into the paused fixture: its git-backed module
  // checks can consume the short profile window before the target reaches the
  // busy loop, leaving the profile attributed only to the loader itself.
  const child = spawn(process.execPath, [waitForStartup ? '--inspect-wait=127.0.0.1:0' : '--inspect=127.0.0.1:0', entry, '--probe-target'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
  const exit = once(child, 'exit');
  const output = createTextCollector(child.stdout);
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('busy inspector did not open')), 5000);
      let inspectorPort: number | undefined;
      let ready = waitForStartup;
      const settle = () => { if (inspectorPort && ready) { clearTimeout(timer); resolve(inspectorPort); } };
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stderr!.on('data', chunk => {
        const match = String(chunk).match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) { inspectorPort = Number(match[1]); settle(); }
      });
      child.stdout!.on('data', chunk => {
        if (String(chunk).includes('CPU_SAMPLE_BUSY_READY')) { ready = true; settle(); }
      });
    });
    await run({ pid: child.pid!, port, entry, output: () => output.peek() });
  } finally {
    child.kill('SIGTERM');
    await exit;
    rmSync(out, { recursive: true, force: true });
  }
}

it.skipIf(process.platform !== 'linux')('profiles a synchronously busy target with kernel identity before SIGTERM', async () => {
  await withBusyTarget(async ({ pid, port, entry }) => {
    const result = await captureCpuProfile({ pid: 0, startPort: port, attachExisting: true, procIdentity: true,
      expectedEntry: entry, expectedArg: '--probe-target', durationMs: 250, deadlineMs: 7000 });
    expect(result.target).toMatchObject({ pid, entry, identity: 'proc' });
    const samples = new Set(result.profile.samples);
    // Optimized startup code can appear under an anonymous/inlined frame.
    // Bind measured samples to the exact target source, not a function label.
    const frames = result.profile.nodes.filter((node: { id: number }) => samples.has(node.id));
    expect(frames.map((node: { callFrame: unknown }) => node.callFrame)).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: pathToFileURL(entry).href }),
    ]));
  });
}, 15000);

it.skipIf(process.platform !== 'linux')('starts profiling before releasing an exact cold startup target', async () => {
  await withBusyTarget(async ({ pid, port, entry, output }) => {
    expect(output()).toBe('');
    const result = await captureCpuProfile({ pid, startPort: port, attachExisting: true, procIdentity: true,
      resumeStartup: true, expectedEntry: entry, expectedArg: '--probe-target', durationMs: 250, deadlineMs: 7000 });
    expect(result.startupResumed).toBe(true);
    await vi.waitFor(() => expect(output()).toContain('CPU_SAMPLE_BUSY_READY'), { timeout: 3000 });
    const sampled = new Set(result.profile.samples);
    const sampledUrls = [...new Set<string>(result.profile.nodes
      .filter((node: { id: number }) => sampled.has(node.id))
      .map((node: { callFrame: { url: string } }) => node.callFrame.url))];
    const sampledSourceUrls = sampledUrls.filter(url => url && !url.startsWith('node:'));
    const targetUrl = pathToFileURL(entry).href;
    if (!sampledSourceUrls.includes(targetUrl)) {
      throw new Error('expected startup source URL ' + targetUrl + '; sampled source URLs: ' + JSON.stringify(sampledSourceUrls));
    }
  }, true);
}, 15000);

it.skipIf(process.platform !== 'linux')('releases its waiting child when profiler setup fails', async () => {
  const createClient = cdpInspector.createCdpClient;
  const spy = vi.spyOn(cdpInspector, 'createCdpClient').mockImplementationOnce((...args) => {
    const client = createClient(...args);
    const send = client.send;
    client.send = (method, ...params) => method === 'Profiler.setSamplingInterval'
      ? Promise.reject(new Error('injected profiler setup failure')) : send(method, ...params);
    return client;
  });
  try {
    await withBusyTarget(async ({ pid, port, entry, output }) => {
      await expect(captureCpuProfile({ pid, startPort: port, attachExisting: true, procIdentity: true,
        resumeStartup: true, expectedEntry: entry, expectedArg: '--probe-target', durationMs: 250, deadlineMs: 7000 }))
        .rejects.toThrow('injected profiler setup failure');
      await vi.waitFor(() => expect(output()).toContain('CPU_SAMPLE_BUSY_READY'), { timeout: 3000 });
    }, true);
  } finally { spy.mockRestore(); }
}, 15000);

it('rejects an out-of-range CDP request timeout before signalling any target', async () => {
  for (const requestTimeoutMs of [0, 499, 60001, 1.5]) {
    await expect(captureCpuProfile({ pid: 1, attachExisting: true, expectedEntry: '/x', startPort: 9229,
      requestTimeoutMs })).rejects.toThrow('requestTimeoutMs must be an integer between 500 and 60000');
  }
});

it.skipIf(process.platform !== 'linux')('passes the caller request timeout to the CDP client so a busy target can answer', async () => {
  // WI-10008237: a fixed 2000ms budget refused Profiler.start on bg-host at loop p95 ~300ms.
  const createClient = cdpInspector.createCdpClient;
  const seen: unknown[] = [];
  const spy = vi.spyOn(cdpInspector, 'createCdpClient').mockImplementation((...args) => {
    seen.push(args[1]);
    return createClient(...args);
  });
  try {
    await withBusyTarget(async ({ pid, port, entry }) => {
      const result = await captureCpuProfile({ pid, startPort: port, attachExisting: true, procIdentity: true,
        resumeStartup: true, expectedEntry: entry, expectedArg: '--probe-target', durationMs: 250, deadlineMs: 7000,
        requestTimeoutMs: 4500 });
      expect(result.profile.samples.length).toBeGreaterThan(0);
    }, true);
  } finally { spy.mockRestore(); }
  expect(seen).toEqual([expect.objectContaining({ requestTimeoutMs: 4500 })]);
}, 15000);

it.skipIf(process.platform !== 'linux')('refuses startup resume for a target launched without a startup wait', async () => {
  await withBusyTarget(async ({ pid, port, entry }) => {
    await expect(captureCpuProfile({ pid, startPort: port, attachExisting: true, procIdentity: true,
      resumeStartup: true, expectedEntry: entry, expectedArg: '--probe-target', durationMs: 250, deadlineMs: 7000 }))
      .rejects.toThrow('exact loopback --inspect-wait');
  });
}, 15000);

it.skipIf(process.platform !== 'linux')('refuses a matching entry whose PID does not own the inspector socket', async () => {
  await withBusyTarget(({ port, entry }) => {
    expect(() => readInspectorProcessIdentity({ pid: process.pid, port, expectedEntry: entry,
      expectedArg: '--probe-target' })).toThrow('identity mismatch');
    expect(() => readInspectorProcessIdentity({ pid: 0, port, expectedEntry: entry,
      expectedArg: '--wrong-argument' })).toThrow('identity mismatch');
    return Promise.resolve();
  });
}, 15000);
