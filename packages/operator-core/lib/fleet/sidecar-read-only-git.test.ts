/**
 * sidecar-read-only-git.test.ts — WI-10004674 / WI-10003465.
 *
 * Pins (1) the read-only git classification that gates the deferred receipt, now
 * shared with the client-side latency sampler, and (2) the rolling latency window
 * the perf-regression rig grades. Pure — no sidecar, no PG, no real git.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SIDECAR_READ_LATENCY_MAX_SAMPLES,
  SIDECAR_READ_LATENCY_WINDOW_MS,
  gitSubcommandOf,
  qualifiesForLazyReceipt,
  readSidecarReadLatency,
  recordSidecarExecLatency,
  resetSidecarReadLatencyForTest,
} from './sidecar-read-only-git';
// The classifier moved out of sidecar-exec-process.ts; its public re-export must still resolve.
import * as execProcessModule from './sidecar-exec-process';

const NOW = Date.parse('2026-10-01T10:00:00.000Z');
const READ = { command: 'git', args: ['rev-parse', 'HEAD'] } as const;

beforeEach(() => resetSidecarReadLatencyForTest());

describe('qualifiesForLazyReceipt — the shared read-only git classifier', () => {
  it('accepts read-only subcommands, including behind global options', () => {
    expect(qualifiesForLazyReceipt(READ)).toBe(true);
    expect(qualifiesForLazyReceipt({
      command: 'git',
      args: ['-C', '/repo', 'check-ignore', '-q', '--no-index', '--', '.papercusp/state'],
    })).toBe(true);
    expect(qualifiesForLazyReceipt({ command: '/usr/bin/git', args: ['-C', '/repo', 'log', '-1'] })).toBe(true);
    expect(qualifiesForLazyReceipt({ command: 'git', args: ['--no-pager', '-c', 'a=b', 'cat-file', '-t', 'x'] })).toBe(
      true,
    );
  });

  it('rejects mutating subcommands, hook-capable ones, unknown options and non-git commands', () => {
    for (const sub of ['commit', 'push', 'fetch', 'checkout', 'merge', 'status', 'gc']) {
      expect(qualifiesForLazyReceipt({ command: 'git', args: [sub] }), sub).toBe(false);
    }
    // An option the parser does not know could swallow the next token: never guess.
    expect(qualifiesForLazyReceipt({ command: 'git', args: ['--exec-path=/x', 'log'] })).toBe(false);
    expect(qualifiesForLazyReceipt({ command: 'node', args: ['rev-parse'] })).toBe(false);
    expect(qualifiesForLazyReceipt({ command: 'git', args: [] })).toBe(false);
  });

  it('gitSubcommandOf skips -C/-c values and returns null when no subcommand is present', () => {
    expect(gitSubcommandOf(['-C', 'rev-parse', 'log'])).toBe('log');
    expect(gitSubcommandOf(['--bare'])).toBeNull();
  });

  it('is still re-exported from sidecar-exec-process (existing importers keep working)', () => {
    expect(execProcessModule.qualifiesForLazyReceipt).toBe(qualifiesForLazyReceipt);
    expect(execProcessModule.gitSubcommandOf).toBe(gitSubcommandOf);
  });
});

describe('recordSidecarExecLatency / readSidecarReadLatency', () => {
  it('reports no verdict (null percentiles) when nothing was recorded — NOT a healthy zero', () => {
    expect(readSidecarReadLatency({ nowMs: NOW })).toEqual({
      sample: 0,
      p50Ms: null,
      p95Ms: null,
      windowMs: SIDECAR_READ_LATENCY_WINDOW_MS,
    });
  });

  it('computes nearest-rank p50/p95 over the window', () => {
    for (let i = 1; i <= 100; i += 1) recordSidecarExecLatency(READ, i, NOW - 1000);
    const r = readSidecarReadLatency({ nowMs: NOW });
    expect(r.sample).toBe(100);
    expect(r.p50Ms).toBe(50);
    expect(r.p95Ms).toBe(95);
  });

  it('records ONLY read-only git reads — a slow fetch/push must not drown the per-read signal', () => {
    recordSidecarExecLatency({ command: 'git', args: ['fetch', 'origin'] }, 30_000, NOW);
    recordSidecarExecLatency({ command: 'git', args: ['push'] }, 30_000, NOW);
    recordSidecarExecLatency({ command: 'npm', args: ['test'] }, 30_000, NOW);
    expect(readSidecarReadLatency({ nowMs: NOW }).sample).toBe(0);
    recordSidecarExecLatency(READ, 5, NOW);
    expect(readSidecarReadLatency({ nowMs: NOW }).sample).toBe(1);
  });

  it('drops samples older than the window', () => {
    recordSidecarExecLatency(READ, 9_999, NOW - SIDECAR_READ_LATENCY_WINDOW_MS - 1);
    recordSidecarExecLatency(READ, 10, NOW - 1);
    const r = readSidecarReadLatency({ nowMs: NOW });
    expect(r.sample).toBe(1);
    expect(r.p50Ms).toBe(10);
  });

  it('ignores a non-finite or negative elapsed value (a clock glitch must not poison the window)', () => {
    recordSidecarExecLatency(READ, Number.NaN, NOW);
    recordSidecarExecLatency(READ, -3, NOW);
    recordSidecarExecLatency(READ, Number.POSITIVE_INFINITY, NOW);
    expect(readSidecarReadLatency({ nowMs: NOW }).sample).toBe(0);
  });

  it('bounds memory: past the cap the OLDEST samples are dropped, the newest are kept', () => {
    const total = SIDECAR_READ_LATENCY_MAX_SAMPLES + 50;
    for (let i = 0; i < total; i += 1) recordSidecarExecLatency(READ, i, NOW - 1);
    const r = readSidecarReadLatency({ nowMs: NOW });
    expect(r.sample).toBe(SIDECAR_READ_LATENCY_MAX_SAMPLES);
    // the 50 oldest (0..49) are gone, so the smallest retained value is 50
    expect(r.p50Ms).toBeGreaterThanOrEqual(50);
  });
});
