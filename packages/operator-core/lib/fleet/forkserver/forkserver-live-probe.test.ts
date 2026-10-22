import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLiveForkserverCheck } from './live-instrument';

const instrument = fileURLToPath(new URL('../../../../../docs/evidence/sidecar-forkserver-live-probe.py', import.meta.url));

function summarize(trace: string) {
  const script = 'import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])["summarize_trace"](sys.stdin.buffer.read())))';
  return JSON.parse(execFileSync('python3', ['-c', script, instrument], { input: trace, encoding: 'utf8' }));
}

describe('live forkserver trace instrument', () => {
  it('keeps a ptrace refusal visible rather than certifying zero fork activity', () => {
    expect(summarize('strace: attach: ptrace(PTRACE_SEIZE, 42): Operation not permitted\n'))
      .toMatchObject({ forkCallCount: 0, instrumentErrors: [expect.stringContaining('Operation not permitted')] });
  });

  it('counts fork syscall attempts and their duration separately from ordinary reads', () => {
    const result = summarize('09:00:00 clone3({flags=CLONE_VM}, 88) = -1 ENOSYS <0.000010>\n'
      + '09:00:00 clone(child_stack=NULL) = 42 <0.002000>\n'
      + '09:00:00 read(4, "", 16) = 0 <0.080000>\n');
    expect(result).toMatchObject({ forkCallCount: 2, traceLineCount: 3, instrumentErrors: [] });
    expect(result.forkSeconds).toBeCloseTo(0.00201);
    expect(result.readSeconds).toBeCloseTo(0.08);
  });

  it('does not count ordinary IPC reads as fork activity or treat an empty trace as sampled activity', () => {
    expect(summarize('09:00:00 read(4, "ok", 16) = 2 <0.000010>\n'))
      .toMatchObject({ forkCallCount: 0, traceLineCount: 1, instrumentErrors: [] });
    expect(summarize('')).toMatchObject({ forkCallCount: 0, traceLineCount: 0 });
  });

  it('fails the live check for excessive read time even with no fork calls', () => {
    const measuredAt = Date.parse('2026-10-22T14:00:00Z');
    const assertionIds = ['stable-live-runtime', 'trace-instrument-available', 'forkserver-positive-control',
      'sidecar-no-child-forks', 'sidecar-fork-and-read-budget'];
    const result = {
      kind: 'operational-test-evidence', finishedAt: new Date(measuredAt).toISOString(),
      windowSeconds: 3, sidecarBlockedPercent: 10,
      assertions: assertionIds.map(id => ({ id, passed: id !== 'sidecar-fork-and-read-budget' })),
      traces: [{ label: 'sidecar', forkCallCount: 0, forkSeconds: 0, readSeconds: 0.3, unmeasuredCallCount: 0 }],
    };
    expect(parseLiveForkserverCheck(JSON.stringify(result), { now: measuredAt })).toBe(0);
    result.sidecarBlockedPercent = 1;
    result.traces[0]!.readSeconds = 0.03;
    result.assertions.forEach(assertion => { assertion.passed = true; });
    expect(parseLiveForkserverCheck(JSON.stringify(result), { now: measuredAt })).toBe(1);
    expect(parseLiveForkserverCheck(JSON.stringify(result), { now: measuredAt + 31_000 })).toBeNull();
    result.assertions[1]!.passed = false;
    expect(parseLiveForkserverCheck(JSON.stringify(result), { now: measuredAt })).toBeNull();
  });

  it('refuses a trace whose blocking read had not returned when tracing stopped', () => {
    expect(summarize('09:00:00 read(4,  <unfinished ...>\n')).toMatchObject({ unmeasuredCallCount: 1 });
  });
});
