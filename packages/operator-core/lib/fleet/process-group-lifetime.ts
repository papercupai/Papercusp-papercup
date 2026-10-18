import type { ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { pinModuleState } from '@papercusp/module-singleton';
import { linuxPgrpFromProcStat, linuxPpidFromProcStat, linuxProcStateFromStat,
  linuxStartTicksFromProcStat } from '@papercusp/operator-core/lib/process-identity';

/** A failed signal-zero fence needs member evidence, not a guessed cause. */
async function groupExitEvidence(group: number) {
  const members: { pid: number; parentPid: number | null; state: string | null; startTicks: string | null }[] = [];
  let unreadable = 0;
  let omitted = 0;
  let liveMembers = 0;
  try {
    const names = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
    // Read in bounded parallel batches: serial async reads keep the event loop
    // responsive but make the exit fence take seconds on a busy host.
    for (let start = 0; start < names.length; start += 64) {
      const batch = await Promise.all(names.slice(start, start + 64).map(async name => {
        try { return { name, stat: await readFile(`/proc/${name}/stat`, 'utf8') }; }
        catch (error) { return { name, error }; }
      }));
      for (const entry of batch) try {
        if ('error' in entry) throw entry.error;
        const { name, stat } = entry;
        const pgrp = linuxPgrpFromProcStat(stat);
        if (pgrp === null) {
          // The destructive PID parser excludes group zero. It is a valid
          // kernel record, and cannot belong to this positive owned group.
          const rawPgrp = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[2];
          if (stat.lastIndexOf(')') >= 0 && rawPgrp === '0') continue;
          unreadable++;
          continue;
        }
        if (pgrp !== group) continue;
        const state = linuxProcStateFromStat(stat);
        if (state === null) unreadable++;
        else if (state !== 'Z' && state !== 'X') liveMembers++;
        if (members.length === 64) { omitted++; continue; }
        members.push({ pid: Number(name), parentPid: linuxPpidFromProcStat(stat),
          state, startTicks: linuxStartTicksFromProcStat(stat) });
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable++;
      }
      // Keep pipe delivery and deadline timers responsive while collecting
      // evidence from a large /proc population under fleet load.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return { group, members, unreadable, omitted, liveMembers };
  } catch (error) {
    return { group, members, unreadable, omitted, liveMembers, error: String(error) };
  }
}

// The operator's normal shutdown does not await individual routine promises.
// Keep exact live groups enrolled until their exit fence, so a host replacement
// cannot leave a bulk fetch writing after the old host has gone away.
const shutdownGroups = pinModuleState('operator-core.process-group-lifetime.shutdown', () => {
  const groups = new Set<(signal: NodeJS.Signals) => void>();
  const signalAll = (signal: NodeJS.Signals): void => {
    for (const stop of groups) stop(signal);
  };
  process.on('exit', () => signalAll('SIGKILL'));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const stop = (): void => {
      signalAll('SIGTERM');
      if (process.listenerCount(signal) === 1) {
        // Preserve Node's default termination when no host owns a graceful
        // shutdown handler. Installing a cleanup listener must not keep it alive.
        signalAll('SIGKILL');
        process.removeListener(signal, stop);
        process.kill(process.pid, signal);
      } else {
        const escalation = setTimeout(() => signalAll('SIGKILL'), 2_000);
        escalation.unref?.();
      }
    };
    process.on(signal, stop);
  }
  return groups;
});

/** Shared exit fence for the sidecar and local Git runners. The caller owns a
 * referenced child spawned with detached:true on POSIX, retains its deadline
 * and escalation until this fence completes, and calls waitForExit after close.
 * This is extracted from execProcess so local execution uses the same proof
 * without importing the sidecar's admission/runtime dependencies. */
export function processGroupLifetime(child: ChildProcess, report: (message: string) => void) {
  const group = process.platform !== 'win32' ? child.pid : undefined;
  const lifetime = {
    signal(signal: NodeJS.Signals): void {
      try {
        if (group === undefined) child.kill(signal);
        else process.kill(-group, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          report(`process-group ${signal} failed: ${String(error)}`);
        }
      }
    },
    async waitForExit(options: { timeoutMs?: number } = {}): Promise<void> {
      if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
        throw new Error('process-group exit deadline must be a positive safe integer');
      }
      const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
      if (group === undefined) {
        while (child.exitCode === null && child.signalCode === null) {
          if (Date.now() >= deadline) throw new Error('child exit unverified before deadline');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        shutdownGroups.delete(lifetime.signal);
        return;
      }
      // A successful parent can close its pipes while helpers still run. A
      // deadline or an unsuccessful probe must never manufacture an exit receipt.
      let probeFailureReported = false;
      let nextMemberProbe = 0;
      for (;;) {
        let groupFound = false;
        try {
          process.kill(-group, 0);
          groupFound = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            shutdownGroups.delete(lifetime.signal);
            return;
          }
          if (!probeFailureReported) {
            report(`process-group exit unverified: ${String(error)}`);
            probeFailureReported = true;
          }
        }
        // Linux signal 0 also succeeds for an unreaped dead task. A kernel
        // exit may precede Node's child exit notification, so that notification
        // cannot gate this proof. Verify every visible member is dead before
        // releasing the fence; unreadable/live members stay open.
        // Only sample this exceptional case, and do not scan on every 10ms tick.
        if (groupFound && process.platform === 'linux' && Date.now() >= nextMemberProbe) {
          const evidence = await groupExitEvidence(group);
          nextMemberProbe = Date.now() + 100;
          if (!evidence.error && evidence.unreadable === 0 && evidence.members.length > 0 && evidence.liveMembers === 0) {
            report(`process-group dead members exit evidence: ${JSON.stringify(evidence)}`);
            shutdownGroups.delete(lifetime.signal);
            return;
          }
        }
        if (Date.now() >= deadline) {
          const evidence = process.platform === 'linux' ? await groupExitEvidence(group) : { group, platform: process.platform };
          report(`process-group exit deadline evidence: ${JSON.stringify(evidence)}`);
          throw new Error(`process-group ${group} exit unverified before deadline; ${JSON.stringify(evidence)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    /** Keep escalation and the exit fence alive even after the leader exits. */
    async terminate(options: { graceMs?: number; killWaitMs?: number } = {}): Promise<void> {
      const graceMs = options.graceMs ?? 5_000;
      const killWaitMs = options.killWaitMs ?? 5_000;
      if (![graceMs, killWaitMs, graceMs + killWaitMs].every(ms => Number.isSafeInteger(ms) && ms > 0)) {
        throw new Error('process-group termination deadlines must be positive safe integers');
      }
      lifetime.signal('SIGTERM');
      const escalation = setTimeout(() => lifetime.signal('SIGKILL'), graceMs);
      try { await lifetime.waitForExit({ timeoutMs: graceMs + killWaitMs }); }
      finally { clearTimeout(escalation); }
    },
  };
  if (child.pid !== undefined) shutdownGroups.add(lifetime.signal);
  return lifetime;
}
