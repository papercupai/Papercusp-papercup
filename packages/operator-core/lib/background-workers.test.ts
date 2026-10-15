import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __pendingOperatorHostStartsForTests,
  __resetOperatorHostProcessForTests,
  backgroundWorkersEnabled,
  dbosLaunchesHere,
  declareOperatorHostProcess,
  isHostSingleton,
  isOperatorHostProcess,
  reactionMatcherShouldArm,
  requestOnlyHost,
  utilityHostEnabled,
  whenOperatorHostProcess,
} from './background-workers';

const saved = {
  VITEST: process.env.VITEST,
  PAPERCUSP_BACKGROUND_WORKERS: process.env.PAPERCUSP_BACKGROUND_WORKERS,
  PAPERCUSP_HONO_PORT: process.env.PAPERCUSP_HONO_PORT,
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('backgroundWorkersEnabled (EI-126 / EI-312 leg 1)', () => {
  it('vitest workers NEVER run background machinery, whatever the env says', () => {
    process.env.VITEST = 'true'; // (it already is — explicit for the contract)
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    expect(backgroundWorkersEnabled()).toBe(false);
  });

  it('explicit flag wins outside tests: 0 → off, anything else → on', () => {
    delete process.env.VITEST;
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
    expect(backgroundWorkersEnabled()).toBe(false);
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    expect(backgroundWorkersEnabled()).toBe(true);
  });

  it('no flag: default ON, except the :3170 staging host (request-only by design)', () => {
    delete process.env.VITEST;
    delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(backgroundWorkersEnabled()).toBe(false);
    process.env.PAPERCUSP_HONO_PORT = '3070';
    expect(backgroundWorkersEnabled()).toBe(true);
    delete process.env.PAPERCUSP_HONO_PORT;
    expect(backgroundWorkersEnabled()).toBe(true);
  });
});

describe('utilityHostEnabled (EI-368)', () => {
  it('opt-in only — exactly PAPERCUSP_UTILITY_HOST=1', () => {
    expect(utilityHostEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(utilityHostEnabled({ PAPERCUSP_UTILITY_HOST: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(utilityHostEnabled({ PAPERCUSP_UTILITY_HOST: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is independent of backgroundWorkers — the gym keeps DBOS while skipping the dogfood legs', () => {
    const gymEnv = { PAPERCUSP_UTILITY_HOST: '1', PAPERCUSP_DBOS_ENABLE: '1' } as unknown as NodeJS.ProcessEnv;
    expect(utilityHostEnabled(gymEnv)).toBe(true);
    expect(backgroundWorkersEnabled(gymEnv)).toBe(true);
  });
});

describe('reactionMatcherShouldArm (EI-307)', () => {
  it('arms on STAGING (:3170) — the EI-307 fix, where backgroundWorkersEnabled does NOT', () => {
    const stagingEnv = {
      PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_BACKGROUND_WORKERS: '0',
    } as unknown as NodeJS.ProcessEnv;
    // The crux contrast: the matcher must arm on the request-serving staging host,
    // even though staging runs no background LOOPS.
    expect(reactionMatcherShouldArm(stagingEnv)).toBe(true);
    expect(backgroundWorkersEnabled(stagingEnv)).toBe(false);
  });

  it('arms on the green host + when the port is unset (default operator host)', () => {
    expect(reactionMatcherShouldArm({ PAPERCUSP_HONO_PORT: '3070' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(reactionMatcherShouldArm({} as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it('NEVER arms under vitest (a worker must not poke the live wake system)', () => {
    expect(reactionMatcherShouldArm({ VITEST: 'true', PAPERCUSP_HONO_PORT: '3070' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('arms in a clustered request worker even though background loops are disabled', () => {
    const clusterWorkerEnv = {
      PAPERCUSP_HONO_PORT: '3070',
      PAPERCUSP_BACKGROUND_WORKERS: '0',
    } as unknown as NodeJS.ProcessEnv;
    expect(reactionMatcherShouldArm(clusterWorkerEnv)).toBe(true);
    expect(backgroundWorkersEnabled(clusterWorkerEnv)).toBe(false);
  });
});

describe('dbosLaunchesHere (request-only readiness false-503 fix)', () => {
  it('a background-workers host with DBOS enabled launches DBOS', () => {
    expect(dbosLaunchesHere({ PAPERCUSP_DBOS_ENABLE: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(dbosLaunchesHere({ PAPERCUSP_HONO_PORT: '3070', PAPERCUSP_DBOS_ENABLE: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
  it('a request-only host (BACKGROUND_WORKERS=0) does NOT launch DBOS, even with DBOS enabled', () => {
    expect(dbosLaunchesHere({ PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
  it('the :3170 staging host does NOT launch DBOS', () => {
    expect(dbosLaunchesHere({ PAPERCUSP_HONO_PORT: '3170', PAPERCUSP_DBOS_ENABLE: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
  it('DBOS disabled → never launches here, whatever the host', () => {
    expect(dbosLaunchesHere({ PAPERCUSP_DBOS_ENABLE: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(dbosLaunchesHere({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
  it('is vitest-guard-FREE (a pure readiness predicate, unlike backgroundWorkersEnabled)', () => {
    // It gates a readiness DECISION, not machinery, so it must compute the real
    // env-derived value even under vitest — the health handler tests rely on this.
    expect(dbosLaunchesHere({ VITEST: 'true', PAPERCUSP_DBOS_ENABLE: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('isHostSingleton (EI-19304005891638175 — backgroundWorkersEnabled() is NOT a host-singleton check)', () => {
  it('cluster PRIMARY + background workers ON → true (the intended once-per-host case)', () => {
    expect(
      isHostSingleton({ isPrimary: true, env: { PAPERCUSP_BACKGROUND_WORKERS: '1' } as unknown as NodeJS.ProcessEnv }),
    ).toBe(true);
  });

  it('cluster WORKER + background workers ON → false — the exact bug: backgroundWorkersEnabled() alone would say true here', () => {
    const workerEnv = { PAPERCUSP_BACKGROUND_WORKERS: '1' } as unknown as NodeJS.ProcessEnv;
    // A forked cluster worker inherits its primary's env, so this is the measured
    // 17/17 :3070 release-cluster case — every worker reads backgroundWorkersEnabled
    // true even though only the primary should arm a once-per-host fallback wake.
    expect(backgroundWorkersEnabled(workerEnv)).toBe(true);
    expect(isHostSingleton({ isPrimary: false, env: workerEnv })).toBe(false);
  });

  it('cluster PRIMARY + background workers OFF (e.g. :3170 staging) → false', () => {
    expect(
      isHostSingleton({ isPrimary: true, env: { PAPERCUSP_HONO_PORT: '3170' } as unknown as NodeJS.ProcessEnv }),
    ).toBe(false);
  });

  it('cluster WORKER + background workers OFF → false (both gates independently say no)', () => {
    expect(
      isHostSingleton({ isPrimary: false, env: { PAPERCUSP_HONO_PORT: '3170' } as unknown as NodeJS.ProcessEnv }),
    ).toBe(false);
  });

  it('inherits the VITEST short-circuit from backgroundWorkersEnabled — never a singleton under test, even as the primary', () => {
    expect(
      isHostSingleton({
        isPrimary: true,
        env: { VITEST: 'true', PAPERCUSP_BACKGROUND_WORKERS: '1' } as unknown as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it('defaults `env` to process.env and `isPrimary` to the real node:cluster.isPrimary when omitted', () => {
    // The unforked default (vitest itself is never cluster-forked) — this process
    // IS primary, so the only thing left deciding the outcome is backgroundWorkersEnabled(),
    // which is false under vitest regardless of what's actually in process.env.
    expect(isHostSingleton()).toBe(false);
  });
});

describe('requestOnlyHost (EI-9534 — no hive-directory swarm on a secondary host)', () => {
  it('explicit PAPERCUSP_BACKGROUND_WORKERS=0 → request-only; anything else → not', () => {
    expect(requestOnlyHost({ PAPERCUSP_BACKGROUND_WORKERS: '0' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(requestOnlyHost({ PAPERCUSP_BACKGROUND_WORKERS: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('no flag: the :3170 staging host is request-only; other ports / unset are not', () => {
    expect(requestOnlyHost({ PAPERCUSP_HONO_PORT: '3170' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(requestOnlyHost({ PAPERCUSP_HONO_PORT: '3070' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(requestOnlyHost({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is the exact negation of backgroundWorkersEnabled MINUS the vitest short-circuit', () => {
    // vitest-guard-FREE (like dbosLaunchesHere): a boot-wiring gate must bite even
    // under vitest so a test can flip it via env — otherwise every unit test would
    // look request-only and wrongly suppress swarm-injecting directory-wire tests.
    expect(requestOnlyHost({ VITEST: 'true', PAPERCUSP_BACKGROUND_WORKERS: '0' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(requestOnlyHost({ VITEST: 'true', PAPERCUSP_HONO_PORT: '3070' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('whenOperatorHostProcess / declareOperatorHostProcess (WI-10006280 — host-only import-time loops)', () => {
  beforeEach(() => __resetOperatorHostProcessForTests());
  afterEach(() => __resetOperatorHostProcessForTests());

  it('queues a start until the process declares itself a host, and never runs it otherwise', () => {
    const start = vi.fn();
    whenOperatorHostProcess('loop-a', start);
    expect(start).not.toHaveBeenCalled();
    expect(isOperatorHostProcess()).toBe(false);
    expect(__pendingOperatorHostStartsForTests()).toEqual(['loop-a']);
  });

  it('runs every queued start, in order, when the host declares — exactly once even if declared twice', () => {
    const order: string[] = [];
    whenOperatorHostProcess('loop-a', () => order.push('a'));
    whenOperatorHostProcess('loop-b', () => order.push('b'));
    declareOperatorHostProcess();
    declareOperatorHostProcess();
    expect(order).toEqual(['a', 'b']);
    expect(isOperatorHostProcess()).toBe(true);
    expect(__pendingOperatorHostStartsForTests()).toEqual([]);
  });

  it('runs a start immediately when the host has already declared (registry imported after boot)', () => {
    declareOperatorHostProcess();
    const start = vi.fn();
    whenOperatorHostProcess('late-loop', start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(__pendingOperatorHostStartsForTests()).toEqual([]);
  });

  it('a start that throws neither blocks the declaration nor the starts queued after it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = vi.fn();
    whenOperatorHostProcess('broken-loop', () => {
      throw new Error('relation "event_awaits" does not exist');
    });
    whenOperatorHostProcess('healthy-loop', after);
    expect(() => declareOperatorHostProcess()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('broken-loop');
    warn.mockRestore();
  });
});
