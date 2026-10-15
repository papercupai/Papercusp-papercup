import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CgroupFs } from '../task-manager/cgroup-read';
import {
  admitCheckpointMemory,
  CHECKPOINT_MEMORY_ADMISSION_ENV,
  CHECKPOINT_MEMORY_BUDGET_ENV,
  CHECKPOINT_SMALL_RUN_ALLOWANCE_G,
  CHECKPOINT_SMALL_RUN_MAX_G,
  type CheckpointMemoryProbe,
  checkpointMemoryBudgetG,
  measureCheckpointCommitment,
} from './checkpoint-memory-admission';

const GIB = 1024 ** 3;

/** One fake checkpoint process: a pid, the cgroup it sits in, and that cgroup's memory.max. */
interface FakeRun {
  pid: number;
  cgroup: string;
  /** Raw `memory.max` contents — a byte count, or the literal `max`. */
  memoryMax: string;
}

/**
 * Build a probe over a synthetic /proc + /sys. Everything the real probe reads is a file, so
 * the fake is a path->contents map rather than a mocked module: the test exercises the real
 * parsing and grouping, not a stub of it.
 */
function fakeProbe(opts: {
  runs?: FakeRun[];
  /** Pids present but NOT green-checkpoint — they must be ignored. */
  noise?: { pid: number; cmdline: string }[];
  selfPid?: number;
  totalMemG?: number;
  /** Simulate an unreadable /proc: readDir returns nothing. */
  procUnreadable?: boolean;
}): CheckpointMemoryProbe {
  const runs = opts.runs ?? [];
  const noise = opts.noise ?? [];
  const selfPid = opts.selfPid ?? 999_999;
  const files = new Map<string, string>();
  for (const r of runs) {
    files.set(`/proc/${r.pid}/cmdline`, `node\0/repo/apps/operator/lib/release/green-checkpoint.ts\0`);
    files.set(`/proc/${r.pid}/cgroup`, `0::${r.cgroup}\n`);
    files.set(`/sys/fs/cgroup${r.cgroup}/memory.max`, r.memoryMax);
  }
  for (const n of noise) files.set(`/proc/${n.pid}/cmdline`, n.cmdline);

  const fs: CgroupFs = {
    readFile: (path) => files.get(path) ?? null,
    readDir: (path) => {
      if (path !== '/proc' || opts.procUnreadable) return [];
      return [...runs.map((r) => String(r.pid)), ...noise.map((n) => String(n.pid)), String(selfPid), 'self'];
    },
    isDir: () => true,
  };

  return {
    fs,
    listPids: () =>
      fs
        .readDir('/proc')
        .filter((e) => /^\d+$/.test(e))
        .map(Number),
    totalMemBytes: () => (opts.totalMemG ?? 256) * GIB,
    selfPid: () => selfPid,
  };
}

const reserved = (pid: number, cgroup: string): FakeRun => ({
  pid,
  cgroup,
  memoryMax: String(40 * GIB),
});

describe('measureCheckpointCommitment', () => {
  it('sums memory.max across distinct checkpoint cgroups', () => {
    const m = measureCheckpointCommitment(
      fakeProbe({ runs: [reserved(101, '/user.slice/run-a.scope'), reserved(202, '/user.slice/run-b.scope')] }),
    );
    expect(m.measured).toBe(true);
    expect(m.scopes).toHaveLength(2);
    expect(m.committedG).toBe(80);
  });

  it("counts a run's cap ONCE even when many of its forks are in the same cgroup", () => {
    // The real failure this pins: a reserved run has 8 vitest forks, all inside the one scope.
    // Summing per-PID instead of per-cgroup would report 320 GiB for a single 40 GiB run and
    // refuse every subsequent launch on a host that is barely loaded.
    const forks = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => reserved(100 + i, '/user.slice/run-a.scope'));
    const m = measureCheckpointCommitment(fakeProbe({ runs: forks }));
    expect(m.scopes).toHaveLength(1);
    expect(m.committedG).toBe(40);
  });

  it('ignores processes that are not green-checkpoint, and excludes the caller itself', () => {
    const m = measureCheckpointCommitment(
      fakeProbe({
        runs: [reserved(101, '/user.slice/run-a.scope')],
        noise: [
          { pid: 55, cmdline: 'node\0/repo/apps/operator/bin/hono-host.ts\0' },
          { pid: 56, cmdline: 'postgres: writer process\0' },
        ],
        selfPid: 57,
      }),
    );
    expect(m.scopes).toHaveLength(1);
    expect(m.committedG).toBe(40);
  });

  it('reports a `memory.max=max` scope as unbounded rather than folding it in as zero', () => {
    // Counting an unbounded scope as 0 GiB is the fail-open direction, which is deliberate —
    // but it must be VISIBLE, or the sum silently understates real commitment.
    const m = measureCheckpointCommitment(
      fakeProbe({
        runs: [reserved(101, '/user.slice/run-a.scope'), { pid: 202, cgroup: '/user.slice/run-b.scope', memoryMax: 'max' }],
      }),
    );
    expect(m.committedG).toBe(40);
    expect(m.unbounded).toBe(1);
    expect(m.detail).toContain('memory.max=max');
  });

  it('treats an empty /proc listing as UNMEASURED, not as an empty machine', () => {
    // This process is itself in /proc, so a zero-entry listing can only be a failed read.
    const m = measureCheckpointCommitment(fakeProbe({ procUnreadable: true }));
    expect(m.measured).toBe(false);
    expect(m.committedG).toBe(0);
  });
});

describe('checkpointMemoryBudgetG', () => {
  it('derives half of host RAM by default', () => {
    expect(checkpointMemoryBudgetG({}, fakeProbe({ totalMemG: 251 }))).toBe(125);
  });

  it('honours an absolute env override', () => {
    expect(checkpointMemoryBudgetG({ [CHECKPOINT_MEMORY_BUDGET_ENV]: '90' }, fakeProbe({ totalMemG: 251 }))).toBe(90);
  });

  it('ignores a non-positive or unparseable override rather than collapsing the budget to zero', () => {
    const probe = fakeProbe({ totalMemG: 251 });
    expect(checkpointMemoryBudgetG({ [CHECKPOINT_MEMORY_BUDGET_ENV]: '0' }, probe)).toBe(125);
    expect(checkpointMemoryBudgetG({ [CHECKPOINT_MEMORY_BUDGET_ENV]: 'lots' }, probe)).toBe(125);
  });
});

describe('admitCheckpointMemory', () => {
  it('admits when the request fits under the budget', () => {
    // 2 live runs = 80 GiB committed, + 40 requested = 120 <= 125.
    const a = admitCheckpointMemory({
      requestG: 40,
      env: {},
      probe: fakeProbe({
        runs: [reserved(101, '/user.slice/run-a.scope'), reserved(202, '/user.slice/run-b.scope')],
        totalMemG: 251,
      }),
    });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe('admitted');
    expect(a.committedG).toBe(80);
  });

  it('REFUSES when committed + request would exceed the budget', () => {
    // 3 live runs = 120 GiB committed, + 40 requested = 160 > 125. This is the whole point of
    // the module: the per-root run-lock permits all four, and nothing else says no.
    const a = admitCheckpointMemory({
      requestG: 40,
      env: {},
      probe: fakeProbe({
        runs: [
          reserved(101, '/user.slice/run-a.scope'),
          reserved(202, '/user.slice/run-b.scope'),
          reserved(303, '/user.slice/run-c.scope'),
        ],
        totalMemG: 251,
      }),
    });
    expect(a.admit).toBe(false);
    expect(a.reason).toBe('over-budget');
    expect(a.detail).toContain('DEFERRING');
  });

  // WI-10006274: observed 2026-10-06 — three 40 GiB Papercusp runs deferred a working-copy pot
  // whose whole suite is two node:test cases, so its standing PR waited on the large runs.
  it('admits a SMALL run beside three large ones, within the bounded small-run allowance', () => {
    const threeLarge = [
      reserved(101, '/user.slice/run-a.scope'),
      reserved(202, '/user.slice/run-b.scope'),
      reserved(303, '/user.slice/run-c.scope'),
    ];
    const a = admitCheckpointMemory({
      requestG: CHECKPOINT_SMALL_RUN_MAX_G,
      env: {},
      probe: fakeProbe({ runs: threeLarge, totalMemG: 251 }),
    });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe('admitted-small-run');
    expect(a.detail).toContain('small-run allowance');
  });

  it('still REFUSES a small run once the allowance is spent, so the host bound holds', () => {
    // 120 GiB committed; a budget chosen so 120 + small request lands 1 GiB past
    // budget + allowance. Admitting it would breach the bound the allowance promises.
    const budgetG = 120 + CHECKPOINT_SMALL_RUN_MAX_G - CHECKPOINT_SMALL_RUN_ALLOWANCE_G - 1;
    const a = admitCheckpointMemory({
      requestG: CHECKPOINT_SMALL_RUN_MAX_G,
      env: { [CHECKPOINT_MEMORY_BUDGET_ENV]: String(budgetG) },
      probe: fakeProbe({
        runs: [
          reserved(101, '/user.slice/run-a.scope'),
          reserved(202, '/user.slice/run-b.scope'),
          reserved(303, '/user.slice/run-c.scope'),
        ],
        totalMemG: 251,
      }),
    });
    expect(a.admit).toBe(false);
    expect(a.reason).toBe('over-budget');
  });

  it('never extends the allowance to a LARGE run', () => {
    const a = admitCheckpointMemory({
      requestG: CHECKPOINT_SMALL_RUN_MAX_G + 1,
      env: {},
      probe: fakeProbe({
        runs: [
          reserved(101, '/user.slice/run-a.scope'),
          reserved(202, '/user.slice/run-b.scope'),
          reserved(303, '/user.slice/run-c.scope'),
        ],
        totalMemG: 251,
      }),
    });
    expect(a.admit).toBe(false);
    expect(a.reason).toBe('over-budget');
  });

  it('FAILS OPEN when commitment cannot be measured', () => {
    // The status quo this replaces is entirely unbounded, so an unmeasurable probe must not be
    // more restrictive than no probe at all.
    const a = admitCheckpointMemory({ requestG: 40, env: {}, probe: fakeProbe({ procUnreadable: true }) });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe('admitted-unmeasurable');
  });

  it('FAILS OPEN when the commitment probe THROWS, not just when it reads empty', () => {
    // Gate candidate 36318748: a throw out of the probe is not fail-open, it is fail-CRASH —
    // the MOST restrictive outcome available, because it aborts the caller rather than merely
    // refusing the run. It propagated out of release-actions.ts's admission call on the
    // checkpoint host and red-pinned the gate. The contract is "unmeasurable ⇒ admit", and a
    // throw is the strongest possible evidence that the commitment is unmeasurable.
    const throwing = {
      ...fakeProbe({}),
      listPids: () => {
        throw new TypeError('undefined is not iterable');
      },
    };
    const a = admitCheckpointMemory({ requestG: 40, env: {}, probe: throwing });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe('admitted-unmeasurable');
    // The refusal must name what threw, or a fail-open is indistinguishable from a healthy read.
    expect(a.detail).toContain('undefined is not iterable');
  });

  it('never refuses a lone run, even when its own cap exceeds the whole budget', () => {
    // Over-refusal freezes `main` for every pot. A misconfigured budget must not be able to
    // stop the only run on the host.
    const a = admitCheckpointMemory({
      requestG: 40,
      env: { [CHECKPOINT_MEMORY_BUDGET_ENV]: '8' },
      probe: fakeProbe({ totalMemG: 251 }),
    });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe('admitted-sole-run');
  });

  it('admits unconditionally when the env kill-switch is set', () => {
    const a = admitCheckpointMemory({
      requestG: 40,
      env: { [CHECKPOINT_MEMORY_ADMISSION_ENV]: '0' },
      probe: fakeProbe({
        runs: [
          reserved(101, '/user.slice/run-a.scope'),
          reserved(202, '/user.slice/run-b.scope'),
          reserved(303, '/user.slice/run-c.scope'),
        ],
        totalMemG: 251,
      }),
    });
    expect(a.admit).toBe(true);
    expect(a.reason).toBe('admitted-disabled');
  });

  it('always states the numbers behind its verdict', () => {
    // A bound whose log line does not carry committed/request/budget is one nobody can audit,
    // and is indistinguishable from a bound that is silently failing open.
    for (const probe of [
      fakeProbe({ runs: [reserved(101, '/user.slice/run-a.scope')], totalMemG: 251 }),
      fakeProbe({
        runs: [
          reserved(101, '/user.slice/run-a.scope'),
          reserved(202, '/user.slice/run-b.scope'),
          reserved(303, '/user.slice/run-c.scope'),
        ],
        totalMemG: 251,
      }),
    ]) {
      const a = admitCheckpointMemory({ requestG: 40, env: {}, probe });
      expect(a.detail).toMatch(/40/);
      expect(a.detail).toMatch(/125/);
    }
  });
});

describe('both scope-creating seams consult the bound (anti-drift)', () => {
  // D-007: a bound applied at ONE launcher is not a bound — the other seam stays unbounded and
  // the per-root run-lock will happily let it stack another 40 GiB on the host. These two call
  // sites are the entire enforcement surface, so their absence is the regression to catch.
  // The subject paths are env-overridable so `scripts/mutation-probe.sh` can prove these
  // assertions actually FAIL on a de-wired seam by pointing them at a mutated COPY outside the
  // tree. Without the override the only way to falsify them is to edit the real source, which
  // on this swept checkout risks git-sync committing the mutant (see CLAUDE.md, "Proving a
  // guard is falsifiable"). Defaults are the real files, so a normal run is unaffected.
  const read = (envVar: string, rel: string) => {
    const override = process.env[envVar];
    return override ? readFileSync(override, 'utf8') : readFileSync(new URL(rel, import.meta.url), 'utf8');
  };

  it('the SCHEDULED seam (release-actions.ts) calls admitCheckpointMemory before launching', () => {
    const src = read('PAPERCUSP_PROBE_RELEASE_ACTIONS_SRC', '../harness/routines/release-actions.ts');
    expect(src).toContain('admitCheckpointMemory');
    // It must gate the spawn, not merely observe it.
    expect(src).toMatch(/if \(!memoryAdmission\.admit\)/);
    // And the admission must be measured against the SAME cap the scope commits.
    expect(src).toMatch(/memoryMaxG:\s*checkpointMemoryG/);
  });

  it('the MANUAL seam (release-checkpoint-launch.ts) calls admitCheckpointMemory before launching', () => {
    const src = read('PAPERCUSP_PROBE_CHECKPOINT_LAUNCH_SRC', '../release-checkpoint-launch.ts');
    expect(src).toContain('admitCheckpointMemory');
    expect(src).toMatch(/if \(!memoryAdmission\.admit\)/);
    expect(src).toContain("reason: 'memory_budget'");
  });
});
