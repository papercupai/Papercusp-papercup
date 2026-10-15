/**
 * confinement.test.ts — P-023 / WI-2141828 / D-111.
 *
 * The load-bearing test here is `ignores the stored cgroup_path`. ~1300 historical
 * agent-session rows hold the SPAWNER's cgroup in that column (the pre-EI-9748
 * `papercup-dev-api.service` value), and D-111 binds this read surface never to present
 * one as current truth. A resolver that simply echoed the column would pass every other
 * assertion in this file, so that test is what separates a fix from a rename.
 *
 * No module mocking: a fake `CgroupFs` drives the operator's own /proc read, so the real
 * parse + derivation path is exercised end to end.
 */
import { describe, expect, it } from 'vitest';

import type { CgroupFs } from './cgroup-read';
import { resolveTaskConfinement } from './confinement';

const USER_MANAGER = '/user.slice/user-1000.slice/user@1000.service';
/** Where the operator itself lives — and the exact wrong value the ledger recorded. */
const OPERATOR_CGROUP = `${USER_MANAGER}/papercup-dev-api.service`;

/** A fake /proc for the CURRENT process, which is how the resolver finds the user-manager root. */
function fsWithOwnCgroup(path: string): CgroupFs {
  return {
    readFile: (p: string) => (p === `/proc/${process.pid}/cgroup` ? `0::${path}\n` : null),
    readDir: () => [],
    isDir: () => false,
  };
}

const operatorFs = fsWithOwnCgroup(OPERATOR_CGROUP);

const AGENT_SESSION_SCOPE = `${USER_MANAGER}/papercusp.slice/papercusp-agent.slice/papercusp-agent-session.slice/pc-abc.scope`;

describe('resolveTaskConfinement', () => {
  it('ignores the stored cgroup_path and DERIVES from the scope unit (D-111)', () => {
    // Exactly the shape of a historical row: confined, a good scope_unit, and a
    // cgroup_path naming the operator because the /proc read caught the spawner.
    const c = resolveTaskConfinement(
      {
        confined: true,
        scopeUnit: 'pc-abc.scope',
        class: 'agent-session',
        cgroupPath: OPERATOR_CGROUP,
      },
      operatorFs,
    );

    expect(c.source).toBe('derived-from-scope-unit');
    expect(c.cgroupPath).toBe(AGENT_SESSION_SCOPE);
    // The point of the whole item: the wrong stored value must not survive the read.
    expect(c.cgroupPath).not.toBe(OPERATOR_CGROUP);
  });

  it('answers "an operator restart does not kill this agent" for a post-EI-9748 session', () => {
    const c = resolveTaskConfinement(
      { confined: true, scopeUnit: 'pc-abc.scope', class: 'agent-session', cgroupPath: OPERATOR_CGROUP },
      operatorFs,
    );
    expect(c).toMatchObject({ confined: true, insideOperatorCgroup: false });
  });

  // Positive control for the assertion above: without it, an `insideOperatorCgroup` that
  // was hardcoded `false` — or a containment test that never matches anything — would look
  // exactly like a correct answer.
  it('reports insideOperatorCgroup TRUE when the operator really does contain the scope', () => {
    const nested = fsWithOwnCgroup(`${USER_MANAGER}/papercusp.slice`);
    const c = resolveTaskConfinement(
      { confined: true, scopeUnit: 'pc-abc.scope', class: 'agent-session' },
      nested,
    );
    expect(c).toMatchObject({ confined: true, insideOperatorCgroup: true });
  });

  it('uses the reconcile-observed path for an exact unaccounted task scope', () => {
    const scopeUnit = 'pc-abc123.scope';
    const observedPath = `${USER_MANAGER}/papercusp.slice/papercusp-sidecar.slice/${scopeUnit}`;
    const c = resolveTaskConfinement(
      {
        taskId: 'abc123',
        state: 'unaccounted',
        confined: false,
        scopeUnit,
        class: 'other',
        cgroupPath: observedPath,
      },
      operatorFs,
    );

    expect(c).toEqual({
      confined: true,
      cgroupPath: observedPath,
      scopeUnit,
      source: 'observed-at-reconcile',
      insideOperatorCgroup: false,
    });
  });

  it('does not infer a task scope when the unit ID differs from the residue ID', () => {
    const scopeUnit = 'pc-other123.scope';
    const c = resolveTaskConfinement(
      {
        taskId: 'abc123',
        state: 'unaccounted',
        confined: false,
        scopeUnit,
        class: 'other',
        cgroupPath: `${USER_MANAGER}/papercusp.slice/papercusp-sidecar.slice/${scopeUnit}`,
      },
      operatorFs,
    );

    expect(c).toMatchObject({ confined: false, scopeUnit: null, source: 'recorded-at-spawn' });
  });

  it('expands the systemd slice hierarchy rather than treating the name as one directory', () => {
    const c = resolveTaskConfinement({ confined: true, scopeUnit: 'pc-1.scope', class: 'bash-job' }, operatorFs);
    expect(c.cgroupPath).toBe(
      `${USER_MANAGER}/papercusp.slice/papercusp-bash.slice/papercusp-bash-job.slice/pc-1.scope`,
    );
  });

  it('reports a confined task with no scope unit as UNKNOWN, never as unconfined', () => {
    const c = resolveTaskConfinement({ confined: true, scopeUnit: null, class: 'agent-session' }, operatorFs);

    expect(c.source).toBe('not-derivable');
    expect(c.cgroupPath).toBeNull();
    // The silent-wrong-answer this branch exists to prevent: a null path read as "nothing
    // confines it". `confined` must stay true so the caller cannot reach that reading.
    expect(c.confined).toBe(true);
  });

  it('keeps the spawn-time /proc read for an unconfined task, where it is correct', () => {
    const c = resolveTaskConfinement(
      {
        confined: false,
        class: 'bash-job',
        cgroupPath: OPERATOR_CGROUP,
        unconfinedReason: 'scope support unavailable',
      },
      operatorFs,
    );

    expect(c).toMatchObject({
      confined: false,
      source: 'recorded-at-spawn',
      cgroupPath: OPERATOR_CGROUP,
      reason: 'scope support unavailable',
    });
  });

  it('compares cgroup containment segment-wise, so a shared name prefix is not containment', () => {
    // `papercusp-agent.slice` is a string prefix of `papercusp-agent-session.slice`. A
    // startsWith() test without the separator would call this contained and report that an
    // operator restart kills the agent — the exact wrong answer, restored by a typo.
    const siblingFs = fsWithOwnCgroup(`${USER_MANAGER}/papercusp.slice/papercusp-agent.slice/papercusp-agent`);
    const c = resolveTaskConfinement(
      { confined: true, scopeUnit: 'pc-abc.scope', class: 'agent-session' },
      siblingFs,
    );
    expect(c).toMatchObject({ insideOperatorCgroup: false });
  });

  it('still derives a path when the process is not under a user manager at all', () => {
    const container = fsWithOwnCgroup('/system.slice/papercusp.service');
    const c = resolveTaskConfinement({ confined: true, scopeUnit: 'pc-9.scope', class: 'bash-job' }, container);

    expect(c.source).toBe('derived-from-scope-unit');
    expect(c.cgroupPath).toBe('/papercusp.slice/papercusp-bash.slice/papercusp-bash-job.slice/pc-9.scope');
  });
});
