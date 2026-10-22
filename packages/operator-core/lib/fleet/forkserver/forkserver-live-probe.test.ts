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
      'git-sync-overlap-progress', 'sidecar-no-child-forks', 'sidecar-fork-and-read-budget'];
    const before = { pid: 50, parentPid: 40, startTicks: '100', marker: 'PAPERCUSP_GIT_SYNC_PUSH=1',
      atWindowSeconds: 0.1, cpuTicks: 1, rchar: 10, wchar: 0, syscr: 2, syscw: 0 };
    const result = {
      kind: 'operational-test-evidence', finishedAt: new Date(measuredAt).toISOString(),
      windowSeconds: 3, sidecarBlockedPercent: 10,
      assertions: assertionIds.map(id => ({ id, passed: id !== 'sidecar-fork-and-read-budget' })),
      traces: [{ label: 'sidecar', forkCallCount: 0, forkSeconds: 0, readSeconds: 0.3, unmeasuredCallCount: 0 }],
      runtime: { forkserverPids: [40] },
      gitSyncWitness: { before, after: { ...before, atWindowSeconds: 0.2, rchar: 20 } },
    };
    expect(parseLiveForkserverCheck(JSON.stringify(result), { now: measuredAt })).toBe(0);
    result.sidecarBlockedPercent = 1;
    result.traces[0]!.readSeconds = 0.03;
    result.assertions.forEach(assertion => { assertion.passed = true; });
    expect(parseLiveForkserverCheck(JSON.stringify(result), { now: measuredAt })).toBe(1);
    const valid = JSON.stringify(result);
    for (const mutate of [
      (r: any) => { delete r.gitSyncWitness; },
      (r: any) => { r.gitSyncWitness.after.rchar = 10; },
      (r: any) => { r.gitSyncWitness.after.startTicks = '101'; },
      (r: any) => { r.gitSyncWitness.after.atWindowSeconds = 4; },
      (r: any) => { r.gitSyncWitness.before.marker = 'unrelated'; },
      (r: any) => { r.runtime.forkserverPids = [99]; },
    ]) {
      const invalid = JSON.parse(valid); mutate(invalid);
      expect(parseLiveForkserverCheck(JSON.stringify(invalid), { now: measuredAt })).toBeNull();
    }
    expect(parseLiveForkserverCheck(JSON.stringify(result), { now: measuredAt + 31_000 })).toBeNull();
    result.assertions[1]!.passed = false;
    expect(parseLiveForkserverCheck(JSON.stringify(result), { now: measuredAt })).toBeNull();
  });

  it('refuses a trace whose blocking read had not returned when tracing stopped', () => {
    expect(summarize('09:00:00 read(4,  <unfinished ...>\n')).toMatchObject({ unmeasuredCallCount: 1 });
  });

  it('requires complete sidecar timing while allowing the forkserver to wait in IPC', () => {
    const sidecar = { label: 'sidecar', instrumentErrors: [], traceLineCount: 1, unmeasuredCallCount: 0 };
    const forkserver = { label: 'forkserver', instrumentErrors: [], traceLineCount: 2, unmeasuredCallCount: 1 };
    const script = 'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); p=json.load(sys.stdin); print(json.dumps(m["trace_instrument_available"](p["traces"],p["attached"])))';
    const available = (traces: object[], attached = true) => JSON.parse(execFileSync('python3',
      ['-c', script, instrument], { input: JSON.stringify({ traces, attached }), encoding: 'utf8' }));
    expect(available([sidecar, forkserver])).toBe(true);
    expect(available([{ ...sidecar, unmeasuredCallCount: 1 }, forkserver])).toBe(false);
    expect(available([sidecar, { ...forkserver, instrumentErrors: ['ptrace refused'] }])).toBe(false);
    expect(available([sidecar, forkserver], false)).toBe(false);
  });

  it('observes only git-sync marked Git children and requires progress inside the trace window', () => {
    const script = `import json,runpy,sys,tempfile,time
from pathlib import Path
m=runpy.run_path(sys.argv[1])
with tempfile.TemporaryDirectory() as d:
 p=Path(d); parent=p/'40'; child=p/'50'
 (parent/'task'/'40').mkdir(parents=True); child.mkdir()
 (parent/'task'/'40'/'children').write_text('50')
 fields=['S','40']+['0']*17+['100']
 (child/'stat').write_text('50 (git) '+ ' '.join(fields))
 (p/'git').touch(); (child/'exe').symlink_to(p/'git')
 (child/'io').write_text('rchar: 10\\nwchar: 0\\nsyscr: 2\\nsyscw: 0\\n')
 (child/'environ').write_bytes(b'PAPERCUSP_GIT_SYNC_PUSH=1\\0')
 before=m['read_git_sync_samples']([40],time.monotonic()-0.1,p)[0]
 after=dict(before,atWindowSeconds=before['atWindowSeconds']+0.1,rchar=20)
 (child/'environ').write_bytes(b'UNRELATED=1\\0')
 print(json.dumps({'sample':before,'unrelated':m['read_git_sync_samples']([40],time.monotonic(),p),
 'progress':m['git_sync_progress'](before,after,3),
 'idle':m['git_sync_progress'](before,dict(after,rchar=10),3),
 'outside':m['git_sync_progress'](before,dict(after,atWindowSeconds=4),3)}))`;
    const result = JSON.parse(execFileSync('python3', ['-c', script, instrument], { encoding: 'utf8' }));
    expect(result).toMatchObject({ sample: { pid: 50, parentPid: 40, marker: 'PAPERCUSP_GIT_SYNC_PUSH=1' },
      unrelated: [], progress: true, idle: false, outside: false });
  });
});
