import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import { classifyStall, type HarnessStall } from './harness-stall-detector';

describe('classifyStall (D-010)', () => {
  it('ignores a tick that is merely late by less than the stall bound', () => {
    expect(classifyStall(1099, 0, 0)).toBeNull();
  });
  it('a gap in which the thread neither ran nor waited to run is not-scheduled', () => {
    expect(classifyStall(5000, 3, 2)).toBe('not-scheduled');
    expect(classifyStall(5000, 3, null)).toBe('not-scheduled');
  });
  it('a gap spent running is busy and one spent runnable-but-waiting is starved — neither is a suspension', () => {
    expect(classifyStall(5000, 4900, 50)).toBe('busy');
    expect(classifyStall(5000, 300, 4000)).toBe('starved');
    expect(classifyStall(5000, 4900, null)).toBe('busy');
  });
});

/**
 * Real kernel behaviour, not a model of it: a child process runs the detector,
 * the test STOPS it with SIGSTOP (the same not-runnable state a cgroup freeze
 * produces), then makes it block its own loop with a busy wait. Only the first
 * may be classified not-scheduled.
 */
describe('startStallDetector on a real process', () => {
  it('classifies a SIGSTOP window as not-scheduled and a busy loop as busy', async () => {
    const moduleUrl = new URL('./harness-stall-detector.ts', import.meta.url).href;
    const script = `
      import { startStallDetector } from ${JSON.stringify(moduleUrl)};
      const t0 = performance.now(); let label = 'idle';
      const d = startStallDetector({ label: () => label, now: () => performance.now() - t0 });
      const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
      say({ ready: true, source: d.source });
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        for (const cmd of chunk.split('\\n').filter(Boolean)) {
          if (cmd === 'busy') { label = 'busy'; const end = Date.now() + 1500; while (Date.now() < end) {} label = 'idle'; say({ busyDone: true }); }
          if (cmd === 'stop') { say({ stalls: d.stop() }); process.exit(0); }
        }
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = readline.createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
    const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
    try {
      const ready = await next();
      expect(ready.ready).toBe(true);
      if (process.platform === 'linux') expect(ready.source).toBe('schedstat');
      await sleep(300);
      child.kill('SIGSTOP'); await sleep(1600); child.kill('SIGCONT');
      await sleep(300);
      child.stdin!.write('busy\n');
      expect((await next()).busyDone).toBe(true);
      await sleep(300);
      child.stdin!.write('stop\n');
      const stalls = (await next()).stalls as HarnessStall[];
      const notScheduled = stalls.filter((s) => s.kind === 'not-scheduled');
      expect(notScheduled).toHaveLength(1);
      expect(notScheduled[0].gapMs).toBeGreaterThanOrEqual(1500);
      // The busy wait blocked the loop just as long, but the thread was RUNNING.
      const blocked = stalls.filter((s) => s.kind !== 'not-scheduled');
      expect(blocked).toHaveLength(1);
      expect(blocked[0].gapMs).toBeGreaterThanOrEqual(1400);
      expect(blocked[0].runMs + (blocked[0].waitMs ?? 0)).toBeGreaterThan(blocked[0].gapMs * 0.5);
      expect(blocked[0].atMs).toBeGreaterThan(notScheduled[0].atMs);
    } finally {
      child.kill('SIGCONT'); child.kill('SIGKILL');
    }
  }, 30000);
});
