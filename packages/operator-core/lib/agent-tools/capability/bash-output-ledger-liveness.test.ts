/**
 * capability:bash_output — diagnoseFromLedger (EI-18759519171684432).
 *
 * Before this fix, a stranded job (in-memory JOBS map entry gone, log file
 * survived) was diagnosed ENTIRELY from operator uptime vs the log's birth time
 * (diagnoseStrandedCause) — a heuristic that rules out ONE cause (a whole-operator
 * restart) but was never sound evidence that the job's OWN process actually died.
 * Live repro: a `test:affected` run was still executing (confirmed via `ps`, its
 * log file still growing) while the tool confidently told the caller "CONFIRMED
 * NOT the cause … the job's OWN process died independently" and advised re-running
 * it — doubling the load on an already-loaded box.
 *
 * `diagnoseFromLedger` consults the durable task-manager ledger row instead (it
 * survives the exact failure that wipes the in-memory registry) and, when the
 * ledger still shows the job non-terminal, RE-PROBES the recorded pid's process
 * identity (immune to PID reuse) rather than guessing. Pure unit tests — a fake
 * TaskRow + an injected probe function, no PG, no subprocess.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  appendJobDiedMarker,
  confirmedAliveStopAdvice,
  diagnoseFromLedger,
  isLedgerConfirmedUnobservedDeath,
  parseJobLogDiedMarker,
  taskScopeIsActive,
  terminalResourceLimitFields,
  terminalStatusFromLedger,
} from './bash_output';
import { formatJobLogDiedMarker, formatJobLogEndMarker } from './bash-jobs';
import { formatTaskBudgetRefusal } from '../../../../../scripts/lib/task-exit-class.mjs';
import type { TaskRow } from '../../task-manager/types';
import { serviceUnitForTask, scopeUnitForTask } from '../../task-manager/types';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'tsk0000001',
    workspaceId: 'ws-1',
    rootTaskId: 'tsk0000001',
    class: 'bash-job',
    title: 'npm run test:affected',
    argv: ['bash', '-o', 'pipefail', '-c', 'npm run test:affected'],
    launchedBy: 'capability:bash',
    confined: true,
    state: 'running',
    startedAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
    detail: { bashJobId: '5f4ad9a1-272' },
    ...overrides,
  };
}

describe('diagnoseFromLedger (EI-18759519171684432)', () => {
  it('gives processes:kill the taskId-only handle, not the diagnostic systemd scope', () => {
    expect(confirmedAliveStopAdvice()).toBe(
      'To stop it, use processes:kill with the taskId below — never a bare kill.',
    );
    expect(confirmedAliveStopAdvice()).not.toContain('scopeUnit');
  });

  it('reports no_ledger_row when no matching ledger row exists (job predates the ledger, or the write raced)', () => {
    expect(diagnoseFromLedger(null)).toEqual({ kind: 'no_ledger_row' });
  });

  it('reports confirmed_dead straight from a TERMINAL ledger state — stronger evidence than any heuristic', () => {
    const row = fakeRow({ state: 'exited', exitCode: 1, exitReason: null });
    expect(diagnoseFromLedger(row)).toEqual({
      kind: 'confirmed_dead',
      state: 'exited',
      exitCode: 1,
      exitReason: null,
      confined: true,
    });
  });

  it('reports confirmed_dead for every terminal state (killed / timed_out / stranded), carrying the recorded reason', () => {
    for (const state of ['killed', 'timed_out', 'stranded'] as const) {
      const row = fakeRow({ state, exitCode: null, exitReason: `test-${state}` });
      expect(diagnoseFromLedger(row)).toEqual({
        kind: 'confirmed_dead',
        state,
        exitCode: null,
        exitReason: `test-${state}`,
        confined: true,
      });
    }
  });

  it('reports confined:false on a stranded UNCONFINED row — EI-19315479997523199 (this is what lets the handler tell "routine operator restart" apart from "a confined job died unexpectedly")', () => {
    const row = fakeRow({
      state: 'stranded',
      confined: false,
      exitReason: 'process identity linux:boot-x:1 is gone from the kernel',
    });
    expect(diagnoseFromLedger(row)).toEqual({
      kind: 'confirmed_dead',
      state: 'stranded',
      exitCode: null,
      exitReason: 'process identity linux:boot-x:1 is gone from the kernel',
      confined: false,
    });
  });

  it('reports confirmed_alive when the ledger is non-terminal AND the pid re-probe matches the recorded identity — THE live-repro regression', () => {
    const row = fakeRow({
      state: 'running',
      pid: 2820845,
      processIdentity: 'linux:boot-abc:123456',
      scopeUnit: 'pc-tsk0000001.scope',
      cgroupPath: '/papercusp.slice/pc-tsk0000001.scope',
    });
    const probe = (pid: number) => ({
      processIdentity: pid === 2820845 ? 'linux:boot-abc:123456' : null,
      cgroupPath: '/papercusp.slice/pc-tsk0000001.scope',
      cmdline: 'bash -o pipefail -c npm run test:affected',
    });
    expect(diagnoseFromLedger(row, probe)).toEqual({
      kind: 'confirmed_alive',
      pid: 2820845,
      scopeUnit: 'pc-tsk0000001.scope',
      taskId: 'tsk0000001',
    });
  });

  it('does NOT report confirmed_alive when the probed identity differs (a DIFFERENT process now holds that pid — PID reuse)', () => {
    const row = fakeRow({
      state: 'running',
      pid: 999,
      processIdentity: 'linux:boot-abc:111',
      scopeUnit: 'pc-tsk0000001.scope',
      cgroupPath: '/papercusp.slice/pc-tsk0000001.scope',
    });
    const probe = () => ({
      processIdentity: 'linux:boot-abc:999',
      cgroupPath: '/papercusp.slice/pc-tsk0000001.scope',
      cmdline: 'bash -o pipefail -c npm run test:affected',
    }); // a different process now owns pid 999
    expect(diagnoseFromLedger(row, probe)).toEqual({ kind: 'ledger_inconclusive' });
  });

  it('does NOT report confirmed_alive when the probe finds nothing (process genuinely gone) — falls to inconclusive, not a death claim', () => {
    const row = fakeRow({
      state: 'running',
      pid: 999,
      processIdentity: 'linux:boot-abc:111',
      scopeUnit: 'pc-tsk0000001.scope',
      cgroupPath: '/papercusp.slice/pc-tsk0000001.scope',
    });
    const probe = () => ({ processIdentity: null, cgroupPath: null, cmdline: '' });
    expect(diagnoseFromLedger(row, probe)).toEqual({ kind: 'ledger_inconclusive' });
  });

  it('never reports progress from CPU movement in a shared or mismatched cgroup', () => {
    const row = fakeRow({
      state: 'running',
      pid: 999,
      processIdentity: 'linux:boot-abc:111',
      scopeUnit: 'pc-tsk0000001.scope',
      cgroupPath: '/papercusp.slice/pc-tsk0000001.scope',
    });
    const probe = () => ({
      processIdentity: 'linux:boot-abc:111',
      cgroupPath: '/papercusp.slice/shared-workers.slice',
      cmdline: 'bash -o pipefail -c npm run test:affected',
    });
    expect(diagnoseFromLedger(row, probe)).toEqual({ kind: 'ledger_inconclusive' });
  });

  it('keeps the liveness proof after the pinned process execs a different command', () => {
    const row = fakeRow({
      state: 'running',
      pid: 999,
      processIdentity: 'linux:boot-abc:111',
      scopeUnit: 'pc-tsk0000001.scope',
      cgroupPath: '/papercusp.slice/pc-tsk0000001.scope',
    });
    const probe = () => ({
      processIdentity: 'linux:boot-abc:111',
      cgroupPath: '/papercusp.slice/pc-tsk0000001.scope',
      cmdline: 'node unrelated-worker.mjs',
    });
    // The command line may legitimately change when the shell execs npm/tsc.
    // Boot/start identity + owned cgroup still prove this is the same task.
    expect(diagnoseFromLedger(row, probe)).toEqual({
      kind: 'confirmed_alive',
      pid: 999,
      scopeUnit: 'pc-tsk0000001.scope',
      taskId: 'tsk0000001',
    });
  });

  it('reports ledger_inconclusive when the row is non-terminal but carries no pid/processIdentity to re-probe', () => {
    const row = fakeRow({ state: 'pending', pid: null, processIdentity: null });
    expect(
      diagnoseFromLedger(row, () => {
        throw new Error('should-not-be-called');
      }),
    ).toEqual({ kind: 'ledger_inconclusive' });
  });

  it('never calls the probe for a terminal row — the recorded exit is authoritative on its own', () => {
    const row = fakeRow({ state: 'exited', exitCode: 0, pid: 123, processIdentity: 'linux:boot-abc:1' });
    let called = false;
    diagnoseFromLedger(row, () => {
      called = true;
      return { processIdentity: 'linux:boot-abc:1', cgroupPath: '/x', cmdline: 'x' };
    });
    expect(called).toBe(false);
  });
});

describe('taskScopeIsActive (EI-21238945235772551)', () => {
  const taskId = 'tsk0000001';
  const serviceUnit = serviceUnitForTask(taskId);
  const base = {
    taskId,
    class: 'bash-job' as const,
    confined: true,
    scopeUnit: serviceUnit,
  };

  it.each(['active', 'activating', 'reloading', 'deactivating'])(
    'accepts systemd ActiveState=%s for the canonical confined bash-job service',
    async (activeState) => {
      const exec = vi.fn(async (_file: string, _args: readonly string[], _options: object) => ({
        stdout: `Id=${serviceUnit}\nLoadState=loaded\nActiveState=${activeState}\n`,
      }));

      await expect(taskScopeIsActive(base, exec)).resolves.toBe(true);
      expect(exec).toHaveBeenCalledWith('systemctl', expect.arrayContaining([
        '--user', 'show', '--no-pager', expect.stringContaining('Result,ExecMainCode,ExecMainStatus'), serviceUnit,
      ]), {
        timeout: 2_000,
        maxBuffer: 64 * 1024,
      });
    },
  );

  it('rejects an inactive service, a scope-shaped unit, and non-bash or unconfined rows without probing', async () => {
    const exec = vi.fn(async () => ({ stdout: `Id=${serviceUnit}\nLoadState=loaded\nActiveState=active\n` }));

    await expect(taskScopeIsActive({ ...base, scopeUnit: 'pc-tsk0000001.service' }, exec)).resolves.toBe(true);
    await expect(taskScopeIsActive({ ...base, scopeUnit: scopeUnitForTask(taskId) }, exec)).resolves.toBe(false);
    await expect(taskScopeIsActive({ ...base, class: 'agent-session' }, exec)).resolves.toBe(false);
    await expect(taskScopeIsActive({ ...base, confined: false }, exec)).resolves.toBe(false);

    const inactiveExec = vi.fn(async () => ({ stdout: `Id=${serviceUnit}\nLoadState=loaded\nActiveState=inactive\n` }));
    await expect(taskScopeIsActive(base, inactiveExec)).resolves.toBe(false);
    expect(inactiveExec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('fails soft when systemd is unavailable or the ledger task id is malformed', async () => {
    const failedExec = vi.fn(async () => {
      throw new Error('systemctl unavailable');
    });
    await expect(taskScopeIsActive(base, failedExec)).resolves.toBe(false);

    await expect(
      taskScopeIsActive(
        { ...base, taskId: 'not a valid task id', scopeUnit: 'pc-not a valid task id.service' },
        failedExec,
      ),
    ).resolves.toBe(false);
    expect(failedExec).toHaveBeenCalledTimes(1);
  });
});

describe('terminalStatusFromLedger (EI-20232536598731015)', () => {
  it('preserves a durable clean exit as normal completed BashOutput status', () => {
    expect(terminalStatusFromLedger(fakeRow({ state: 'exited', exitCode: 0 }))).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('does not turn a non-zero or unobserved terminal row into success', () => {
    expect(terminalStatusFromLedger(fakeRow({ state: 'exited', exitCode: 1 }))).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(terminalStatusFromLedger(fakeRow({ state: 'ended_unobserved', exitCode: null }))).toEqual({
      status: 'failed',
      exitCode: null,
    });
  });

  it('returns null while the durable row is still live', () => {
    expect(terminalStatusFromLedger(fakeRow({ state: 'running' }))).toBeNull();
  });
});

describe('terminalResourceLimitFields (EI-21437837415175286)', () => {
  it('labels a failed test job sampled exactly at TasksMax as infrastructure-undetermined', () => {
    expect(
      terminalResourceLimitFields(
        fakeRow({
          state: 'exited',
          exitCode: 254,
          pidsCurrent: 2_048,
          tasksMax: 2_048,
          detail: { bashJobId: '5f4ad9a1-272', workloadClass: 'test-run' },
        }),
        '/usr/bin/bash: fork: retry: Resource temporarily unavailable',
      ),
    ).toEqual({
      failure_class: 'infrastructure-resource-limit',
      resource_limit: {
        kind: 'pids',
        observed_tasks: 2_048,
        configured_tasks_max: 2_048,
        source: 'task-ledger-cgroup-sample',
      },
      test_verdict: 'undetermined',
      resource_advice:
        'This task reached its own cgroup TasksMax (2048/2048); its non-zero shell exit is an UNDETERMINED test run, not a red suite verdict.',
    });
  });

  it('does not manufacture a limit verdict below the cap, while live, or after a clean exit', () => {
    expect(
      terminalResourceLimitFields(fakeRow({ state: 'exited', exitCode: 1, pidsCurrent: 2_047, tasksMax: 2_048 })),
    ).toBeNull();
    expect(terminalResourceLimitFields(fakeRow({ state: 'running', pidsCurrent: 2_048, tasksMax: 2_048 }))).toBeNull();
    expect(
      terminalResourceLimitFields(fakeRow({ state: 'exited', exitCode: 0, pidsCurrent: 2_048, tasksMax: 2_048 })),
    ).toBeNull();
  });

  it('does not replace a complete real-red test verdict merely because the task touched TasksMax', () => {
    expect(
      terminalResourceLimitFields(
        fakeRow({
          state: 'exited',
          exitCode: 1,
          pidsCurrent: 4_096,
          tasksMax: 4_096,
          pidsEventsMax: 3,
          detail: { bashJobId: '5f4ad9a1-272', workloadClass: 'test-run' },
        }),
        'Test Files 4 failed | 2827 passed\nTests 4 failed | 41131 passed',
      ),
    ).toBeNull();
  });

  it('uses cumulative pids.events evidence after workers drain below TasksMax', () => {
    const result = terminalResourceLimitFields(
      fakeRow({
        state: 'exited',
        exitCode: 254,
        pidsCurrent: 7,
        tasksMax: 2_048,
        pidsEventsMax: 3,
        detail: { bashJobId: '5f4ad9a1-272', workloadClass: 'test-run' },
      }),
    );
    expect(result).toEqual({
      failure_class: 'infrastructure-resource-limit',
      resource_limit: {
        kind: 'pids',
        observed_tasks: 7,
        configured_tasks_max: 2_048,
        historical_pids_events_max: 3,
        source: 'task-ledger-historical-pids-events',
      },
      test_verdict: 'undetermined',
      resource_advice:
        "This task's cgroup recorded 3 refused fork attempts at TasksMax 2048; its latest pids.current sample was 7/2048. This is an UNDETERMINED test run, not a red suite verdict.",
    });
  });

  it('retains the exact bash wait-for-loss fallback when the log itself was lost', () => {
    expect(
      terminalResourceLimitFields(
        fakeRow({
          state: 'exited',
          exitCode: 254,
          pidsCurrent: 4_096,
          tasksMax: 4_096,
          detail: { bashJobId: '5f4ad9a1-272', workloadClass: 'test-run' },
        }),
      ),
    ).toMatchObject({
      failure_class: 'infrastructure-resource-limit',
      test_verdict: 'undetermined',
    });
  });

  it('keeps non-test resource exhaustion explicit without inventing a test verdict', () => {
    const result = terminalResourceLimitFields(
      fakeRow({
        state: 'killed',
        exitCode: 137,
        pidsCurrent: 4_096,
        tasksMax: 4_096,
        detail: { bashJobId: '5f4ad9a1-272', workloadClass: 'other' },
      }),
      'node: spawn EAGAIN',
    );
    expect(result).toMatchObject({
      failure_class: 'infrastructure-resource-limit',
      resource_limit: { kind: 'pids', observed_tasks: 4_096, configured_tasks_max: 4_096 },
    });
    expect(result).not.toHaveProperty('test_verdict');
  });
});

describe('terminalResourceLimitFields — pre-launch budget refusal (EI-21442389733525112)', () => {
  // The exact shape of the row that went unclassified, from harness_shared.task_ledger:
  //   task 0mt8v501616ghmdcqxv  tasks_max=512  pids_current=NULL  exit=1  workloadClass=test-run
  // Its sibling (pids_current=512, tasks_max=512, exit=254) classified correctly, which is
  // what made the gap invisible: the same root cause reported as infrastructure in one form
  // and as a bare test red in the other.
  const refusedRow = (overrides: Partial<TaskRow> = {}) =>
    fakeRow({
      state: 'exited',
      exitCode: 1,
      pidsCurrent: null,
      tasksMax: 512,
      detail: { bashJobId: '5f4ad9a1-272', workloadClass: 'test-run' },
      ...overrides,
    });

  // Built with the REAL emitter, so this suite fails if the emitter and the parser ever
  // stop agreeing on the marker's grammar — the drift a hand-copied literal would hide.
  const pidsRefusalLog = [
    '[pc-heavy] slot acquired — starting real work',
    'AFFECTED_TESTS_RESULT status=aborted tasks=0 failed=0 reason=exit-without-verdict code=1',
    `Error: task cgroup pids.max=512 leaves 0 after pidsReserve=1024, below one pidsPerConcurrentTask=4096 envelope; refusing before launch ${formatTaskBudgetRefusal(
      { kind: 'pids', unit: 'tasks', limit: 512, reserve: 1_024, requiredPerTask: 4_096 },
    )}`,
  ].join('\n');

  it('classifies a refusal the ledger could not sample as infrastructure-undetermined', () => {
    const result = terminalResourceLimitFields(refusedRow(), pidsRefusalLog);
    expect(result).toMatchObject({
      failure_class: 'infrastructure-resource-limit',
      test_verdict: 'undetermined',
      resource_limit: {
        kind: 'pids',
        unit: 'tasks',
        configured_limit: 512,
        reserve: 1_024,
        required_per_task: 4_096,
        source: 'pre-launch-budget-refusal',
      },
    });
    // The advice must say the thing an agent needs to hear first, and name a remedy that is
    // actually reachable. The old text pointed at processes:limit on THIS taskId — but this
    // row is terminal by construction, so that call always answers not_live (verified against
    // real task 0mt9a68dm1ejyc3in6q, EI-21468591394619357). The levers that exist apply at
    // the next launch.
    expect(result?.resource_advice).toContain('NOTHING RAN');
    expect(result?.resource_advice).toContain('not a red suite verdict');
    expect(result?.resource_advice).toContain('already exited');
    expect(result?.resource_advice).toContain('relaunch');
  });

  // CONTROL. Without this the suite would pass on a classifier that returned the verdict for
  // any null-sample row, which is precisely the over-broad fix to avoid: `pidsCurrent: null`
  // is also what a task that died for unrelated reasons looks like.
  it('does not classify an identical row whose log carries no refusal marker', () => {
    expect(terminalResourceLimitFields(refusedRow(), 'Test Files 1 failed | 340 passed')).toBeNull();
    expect(terminalResourceLimitFields(refusedRow(), '')).toBeNull();
  });

  // The historical control, kept permanently. This is the EXACT message the scheduler threw
  // before this fix, and the exact log the unclassified run produced. If the classifier ever
  // starts keying on the human sentence — or on anything other than the marker — this test
  // goes green for the wrong reason and the grammar contract silently stops being load-bearing.
  it('does not classify the pre-fix message that carried no marker', () => {
    expect(
      terminalResourceLimitFields(
        refusedRow(),
        [
          '[pc-heavy] slot acquired — starting real work',
          'AFFECTED_TESTS_RESULT status=aborted tasks=0 failed=0 reason=exit-without-verdict code=1',
          'Error: task cgroup pids.max=512 leaves 0 after pidsReserve=1024, below one',
          '       pidsPerConcurrentTask=4096 envelope; refusing before launch',
          '    at resolveTaskBudget (scripts/lib/budgeted-task-scheduler.mjs:377)',
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('does not promote prose that merely discusses a budget refusal', () => {
    expect(
      terminalResourceLimitFields(
        refusedRow(),
        'note: we should check whether TASK_BUDGET_REFUSAL fires when pids.max is low',
      ),
    ).toBeNull();
  });

  it('keeps a non-test refusal explicit without inventing a test verdict', () => {
    const result = terminalResourceLimitFields(
      refusedRow({ detail: { bashJobId: '5f4ad9a1-272', workloadClass: 'other' } }),
      pidsRefusalLog,
    );
    expect(result).toMatchObject({ failure_class: 'infrastructure-resource-limit' });
    expect(result).not.toHaveProperty('test_verdict');
  });

  it('classifies the memory refusal site too, in its own unit', () => {
    const result = terminalResourceLimitFields(
      refusedRow(),
      `task cgroup memory.max=2048MB leaves 512MB after reserve, below one workerMemoryMb=1024MB token; refusing before launch ${formatTaskBudgetRefusal(
        { kind: 'memory', unit: 'mb', limit: 2_048, reserve: 1_536, requiredPerTask: 1_024 },
      )}`,
    );
    expect(result).toMatchObject({
      resource_limit: { kind: 'memory', unit: 'mb', source: 'pre-launch-budget-refusal' },
    });
    expect(result?.resource_advice).toContain('memoryMaxMb');
  });

  // The new path must be strictly additive: a row that satisfies the older cgroup-sample
  // evidence keeps reporting that source even if a marker is also present in its log.
  it('never displaces the cgroup-sample verdict when both evidences are present', () => {
    expect(
      terminalResourceLimitFields(
        refusedRow({ exitCode: 254, pidsCurrent: 512 }),
        `${pidsRefusalLog}\n/usr/bin/bash: fork: retry: Resource temporarily unavailable`,
      ),
    ).toMatchObject({
      resource_limit: { source: 'task-ledger-cgroup-sample', observed_tasks: 512 },
    });
  });

  // EI-21468591394619357: exit 0 no longer suppresses the refusal verdict. Real row
  // 0mt9a68dm1ejyc3in6q exited 0 (trailing `; echo "EXIT=$?" >> log` — the shell reports the
  // echo's status, not the suite's) with workloadClass=test-run and tasks=0: the marker is
  // the scheduler's own pre-launch statement that nothing ran, so a clean exit beside it is a
  // masked abort, not a green run. The cgroup-sample branch keeps its clean-exit exclusion
  // (a sample AT the cap on a clean exit proves pressure, not causality).
  it('classifies a clean-exit masked abort when the refusal marker is present', () => {
    const result = terminalResourceLimitFields(refusedRow({ exitCode: 0 }), pidsRefusalLog);
    expect(result).toMatchObject({
      failure_class: 'infrastructure-resource-limit',
      test_verdict: 'undetermined',
      resource_limit: { source: 'pre-launch-budget-refusal' },
    });
    expect(result?.resource_advice).toContain('masked abort');
  });

  it('still refuses to classify a clean exit without the marker, or a live task', () => {
    expect(terminalResourceLimitFields(refusedRow({ exitCode: 0 }), 'Test Files 12 passed')).toBeNull();
    expect(
      terminalResourceLimitFields(
        fakeRow({ state: 'exited', exitCode: 0, pidsCurrent: 7, tasksMax: 2_048, pidsEventsMax: 3 }),
      ),
    ).toBeNull();
    expect(
      terminalResourceLimitFields(refusedRow({ state: 'running', exitCode: null }), pidsRefusalLog),
    ).toBeNull();
  });
});

describe('JOB DIED recovery marker (EI-20011476155595470)', () => {
  it('formats an unobserved terminal state without presenting it as a clean JOB END', () => {
    const marker = formatJobLogDiedMarker(
      'ended_unobserved',
      null,
      'scope pc-tsk0000001.scope was released before the child exit was observed',
      Date.UTC(2026, 7, 21, 9, 0, 0),
    );
    expect(marker).toContain('[capability:bash] JOB DIED');
    expect(marker).toContain('state=ended_unobserved');
    expect(marker).toContain('exit=null');
    expect(marker).toContain('2026-08-21');
    expect(marker).not.toContain('[capability:bash] JOB END');
    expect(parseJobLogDiedMarker(`output\n${marker}`)).toEqual({
      status: 'failed',
      state: 'ended_unobserved',
      exitCode: null,
    });
  });

  it('appends exactly one marker and preserves an already-observed JOB END', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-died-marker-'));
    try {
      const logPath = join(dir, 'job.log');
      writeFileSync(logPath, 'partial output\n');
      expect(appendJobDiedMarker(logPath, 'stranded', null, 'process identity vanished', Date.UTC(2026, 7, 21))).toBe(
        true,
      );
      expect(appendJobDiedMarker(logPath, 'stranded', null, 'process identity vanished', Date.UTC(2026, 7, 22))).toBe(
        false,
      );
      const withDied = readFileSync(logPath, 'utf8');
      expect(withDied.match(/^\[capability:bash\] JOB DIED:/gm)).toHaveLength(1);
      expect(parseJobLogDiedMarker(withDied)?.state).toBe('stranded');

      writeFileSync(logPath, `${withDied}${formatJobLogEndMarker('failed', 1, Date.UTC(2026, 7, 23))}`);
      expect(appendJobDiedMarker(logPath, 'stranded', null, 'late retry', Date.UTC(2026, 7, 24))).toBe(false);
      expect(readFileSync(logPath, 'utf8').match(/^\[capability:bash\] JOB DIED:/gm)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recognizes only the reconciler states that prove an unobserved death', () => {
    expect(isLedgerConfirmedUnobservedDeath('stranded')).toBe(true);
    expect(isLedgerConfirmedUnobservedDeath('ended_unobserved')).toBe(true);
    expect(isLedgerConfirmedUnobservedDeath('exited')).toBe(false);
    expect(isLedgerConfirmedUnobservedDeath('killed')).toBe(false);
    expect(isLedgerConfirmedUnobservedDeath('timed_out')).toBe(false);
  });
});
