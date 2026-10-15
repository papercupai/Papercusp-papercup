import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readTerminalHostAcceptance, validateTerminalHostAcceptance } from './psu-pty-host-acceptance-evidence';

// The committed measurement is the calibration fixture. Tests deliberately falsify the observations
// most likely to produce a false pass, including PID reuse, vacuous tracing and probe-induced progress.
const captured = JSON.parse(readFileSync(new URL('../../../docs/evidence/terminal-host-final-acceptance-2026-10-14.json', import.meta.url), 'utf8'));
const current = { ...captured.runtime };
const changed = (edit: (artifact: typeof captured) => void) => {
  const artifact = structuredClone(captured);
  edit(artifact);
  return validateTerminalHostAcceptance(artifact, current);
};

describe('terminal-host acceptance evidence validation', () => {
  it('calibrates against the committed positive measurement without claiming the captured child is current', () => {
    const result = validateTerminalHostAcceptance(captured, current);
    expect(result.passed).toBe(true);
    expect(result.limitation).toContain('does not re-trace');
    expect(result.capturedNativeId).toBe(captured.trace.nativeBefore);
  });

  it('rejects a reused PID, another owner, or a changed advertised host version', () => {
    for (const identity of [
      { ...current, starttime: '1' }, { ...current, ownerId: 'another-owner' },
      { ...current, hostCodeVersion: '0'.repeat(64) },
    ]) expect(validateTerminalHostAcceptance(captured, identity).passed).toBe(false);
  });

  it('rejects a wrong loaded module or absent captured repair', () => {
    expect(changed(artifact => { artifact.loadedSource.loaded[1].loadedSha256 = '0'.repeat(64); }).passed).toBe(false);
    expect(changed(artifact => { artifact.loadedSource.loaded[1].dualStreamDrain = false; }).passed).toBe(false);
    expect(changed(artifact => { artifact.loadedSource.loaded[0].unknownPidEarlyReturn = false; }).passed).toBe(false);
  });

  it('cannot pass a zero/zero trace or a global-lock observation', () => {
    expect(changed(artifact => { artifact.trace.localFdinfoOpens = 0; }).passed).toBe(false);
    expect(changed(artifact => { artifact.trace.globalLockOpens = 1; }).passed).toBe(false);
    expect(changed(artifact => { artifact.trace.hostStart = '1'; }).passed).toBe(false);
  });

  it('requires post-detach progress rather than attached-probe progression or a short unknown window', () => {
    expect(changed(artifact => { artifact.postDetachChecks = artifact.postDetachChecks.slice(0, 1); }).passed).toBe(false);
    expect(changed(artifact => { artifact.postDetachChecks[1].observedAfter = artifact.postDetachChecks[1].observedBefore; }).passed).toBe(false);
    expect(changed(artifact => { artifact.postDetachChecks[1].durationSec = 12; }).passed).toBe(false);
  });

  it('rejects peer-incarnation churn, a changed measured child, and an inspector left open', () => {
    expect(changed(artifact => { artifact.trace.afterInventorySha256 = '0'.repeat(64); }).passed).toBe(false);
    expect(changed(artifact => { artifact.trace.nativeAfter = 'another-child'; }).passed).toBe(false);
    expect(changed(artifact => { artifact.loadedSource.inspectorClosed = false; }).passed).toBe(false);
  });

  it('fails closed on absent measurement fields', () => {
    expect(validateTerminalHostAcceptance({}, current).passed).toBe(false);
    expect(validateTerminalHostAcceptance(null, current).passed).toBe(false);
  });

  it('reads the discovery pid and kernel starttime, rejecting wrong-owner discovery before probing a PID', () => {
    const paths: string[] = [];
    const fields = ['S', ...Array(18).fill('0'), current.starttime];
    const read = (path: string) => {
      paths.push(path);
      if (path === 'discovery') return JSON.stringify({ ownerId: current.ownerId, pid: current.pid, hostCodeVersion: current.hostCodeVersion });
      if (path === 'artifact') return JSON.stringify(captured);
      if (path === `/proc/${current.pid}/stat`) return `${current.pid} (name with spaces) ${fields.join(' ')}`;
      throw new Error(`unexpected read ${path}`);
    };
    expect(readTerminalHostAcceptance('artifact', 'discovery', current.ownerId, read).passed).toBe(true);
    expect(paths).toEqual(['discovery', `/proc/${current.pid}/stat`, 'artifact']);
    paths.length = 0;
    expect(() => readTerminalHostAcceptance('artifact', 'discovery', 'another-owner', read)).toThrow('Discovery');
    expect(paths).toEqual(['discovery']);
  });
});
