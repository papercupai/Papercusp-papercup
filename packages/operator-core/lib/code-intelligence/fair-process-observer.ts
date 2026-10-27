/** Kernel witness for the existing task-backed fair-comparison runner.
 * Optional host capability; absence or a damaged witness remains UNKNOWN.
 */
import { readProcessIdentity } from '../process-identity';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import { absCgroupDir, readProcessCgroupPath, sampleCgroup } from '../task-manager/cgroup-read';
import { deriveUserManagerRoot, scopeCgroupRelPath, taskIdFromScopeUnit } from '../task-manager/types';

export interface FairProcessWitness {
  schemaVersion: 1;
  scope: 'launch-root-process-descendants';
  clockTicksPerSecond: number;
  counters: { writers: number; version: number; errors: number; root_pid: number; root_start: string;
    current: number; peak: number; births: number; exits: number; threads: number; migrations: number };
  members: { pid: number; startNs: string }[];
  cgroupPaths: string[];
  /** Ordered kernel attach records retain the identity of already-exited probes. */
  scopeAttachments?: { index: number; pid: number; startNs: string; cgroupPath: string; commandAtAttach: string }[];
}

/** Validate the writer's units and conservation laws before exposing its peak.
 * Scope root and RPC payload can differ: do not subtract the payload from an
 * unrelated cgroup census and call the result a descendant measurement.
 */
export function qualifyFairProcessWitness(value: FairProcessWitness,
  expected: { cgroupPath: string; payloadPid: number; payloadIdentity: string },
  identity: typeof readProcessIdentity = readProcessIdentity) {
  const unknown: string[] = [];
  const c = value?.counters;
  if (value?.schemaVersion !== 1 || value.scope !== 'launch-root-process-descendants' || !c ||
      !Number.isSafeInteger(value.clockTicksPerSecond) || value.clockTicksPerSecond <= 0 ||
      !Array.isArray(value.members) || !Array.isArray(value.cgroupPaths))
    return { peakChildProcesses: null, unknown: ['process-observer-invalid-witness'] };
  for (const key of ['writers', 'version', 'errors', 'root_pid', 'current', 'peak', 'births', 'exits', 'threads', 'migrations'] as const)
    if (!Number.isSafeInteger(c[key]) || c[key] < 0) unknown.push(`process-observer-invalid-counter:${key}`);
  if (c.writers || c.errors || !c.root_pid || !/^\d+$/.test(c.root_start)) unknown.push('process-observer-incomplete');
  if (c.births - c.exits !== c.current || c.peak < c.current || c.peak > c.births)
    unknown.push('process-observer-counter-conservation-failed');
  if (!value.cgroupPaths.includes(expected.cgroupPath)) unknown.push('process-observer-target-scope-unobserved');
  if (new Set(value.members.map(row => row.pid)).size !== value.members.length ||
      value.members.some(row => !Number.isSafeInteger(row.pid) || row.pid <= 0 || !/^\d+$/.test(row.startNs)))
    unknown.push('process-observer-invalid-membership');
  const payload = value.members.find(row => row.pid === expected.payloadPid);
  // /proc's starttime is clock ticks; BPF stores nanoseconds. Read the actual
  // process identity too, rather than assuming the original payload is alive.
  const payloadTicks = expected.payloadIdentity.split(':').at(-1);
  if (!payload || !/^\d+$/.test(payload.startNs) || !/^\d+$/.test(payloadTicks ?? '') ||
      BigInt(payload.startNs) * BigInt(value.clockTicksPerSecond) / 1_000_000_000n !== BigInt(payloadTicks!) ||
      identity(expected.payloadPid) !== expected.payloadIdentity)
    unknown.push('process-observer-payload-lineage-unverified');
  const root = value.members.find(row => row.pid === c.root_pid && row.startNs === c.root_start);
  if (value.members.length - (root ? 1 : 0) !== c.current)
    unknown.push('process-observer-membership-conservation-failed');
  const attachments = value.scopeAttachments;
  if (attachments !== undefined && (!Array.isArray(attachments) ||
      attachments.length !== c.migrations + (c.root_pid ? 1 : 0) ||
      attachments.some((row, index) => !row || row.index !== index ||
        !Number.isSafeInteger(row.pid) || row.pid <= 0 || !/^\d+$/.test(row.startNs) ||
        typeof row.commandAtAttach !== 'string' || !value.cgroupPaths.includes(row.cgroupPath)) ||
      value.cgroupPaths.some(path => !attachments.some(row => row.cgroupPath === path)) ||
      attachments[0]?.pid !== c.root_pid || attachments[0]?.startNs !== c.root_start))
    unknown.push('process-observer-scope-attachment-conservation-failed');
  return { peakChildProcesses: unknown.length ? null : c.peak, unknown };
}

/** The adapter roots each server at its declared project, which can be a
 * nested directory. Require canonical source custody and the exact observed
 * task; a sibling prefix or an escaping symlink cannot prove inclusion. */
export function fairLspTasksObserved(treeRoot: string,
  tasks: readonly { taskId: string; rootPath: string }[], paths: readonly string[], peak: number | null) {
  if (peak === null) return false;
  try {
    const root = realpathSync(treeRoot);
    return tasks.every(task => {
      const path = relative(root, realpathSync(task.rootPath));
      return path !== '..' && !path.startsWith('../') && !isAbsolute(path) &&
        paths.some(scope => taskIdFromScopeUnit(basename(scope)) === task.taskId);
    });
  } catch { return false; }
}

/** Independent managed scopes are not included in the worker's memory. Sum
 * scope peaks as a labelled conservative bound; never double-count nested
 * groups, or silently turn an already-deleted server scope into zero bytes. */
export function fairObservedScopeCosts(paths: readonly string[], primary: string,
  read: typeof sampleCgroup = sampleCgroup) {
  const unknown: string[] = [];
  const valid = [...new Set([primary, ...paths])].filter(path => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.') ||
        (!taskIdFromScopeUnit(basename(path)) && path !== primary)) {
      unknown.push('process-observer-unowned-cost-scope'); return false;
    }
    return true;
  });
  const roots = valid.filter(path => !valid.some(parent => parent !== path && path.startsWith(`${parent}/`)));
  const scopes = roots.map(cgroupPath => ({ cgroupPath, taskId: taskIdFromScopeUnit(basename(cgroupPath)),
    ...read(absCgroupDir(cgroupPath)) }));
  for (const scope of scopes) for (const field of ['memoryBytes', 'peakMemoryBytes', 'cpuUsec'] as const)
    if (scope[field] === null || !Number.isSafeInteger(scope[field]) || scope[field]! < 0)
      unknown.push(`process-observer-scope-cost-unreadable:${scope.cgroupPath}:${field}`);
  const sum = (field: 'memoryBytes' | 'peakMemoryBytes') => scopes.every(scope => scope[field] !== null &&
    Number.isSafeInteger(scope[field]) && scope[field]! >= 0) ? scopes.reduce((total, scope) => total + scope[field]!, 0) : null;
  return { scopes, memoryCurrentBytes: sum('memoryBytes'), memoryPeakBytes: sum('peakMemoryBytes'),
    memoryPeakBasis: 'sum-of-scope-peaks-upper-bound' as const, unknown };
}

/** Reuse the worker's bounded line protocol and the managed task ledger. The
 * helper is a sibling of the workload, so its memory/processes are overhead. */
export async function startFairProcessObserver(cgroupPath: string,
  channelFactory: typeof import('./fair-comparison-cli').createFairWorkerChannel,
  completion: typeof import('./fair-comparison-cli').fairWorkerCompletion) {
  const { managedSpawn } = await import('../task-manager/managed-spawn');
  let launched: Awaited<ReturnType<typeof managedSpawn>> | null = null;
  let closed: Promise<void> | null = null;
  let failure: string | null = null;
  const stop = async () => {
    if (!launched) return;
    const task = launched;
    task.child.stdin?.end();
    // Closing stdin lets the helper detach probes and release maps itself.
    // Fence that close before escalating; a scope can include a briefly
    // privileged startup process which an immediate user signal cannot kill.
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let graceful = false;
    try { graceful = await Promise.race([closed?.then(() => true) ?? Promise.resolve(false),
      new Promise<boolean>(done => { closeTimer = setTimeout(() => done(false), 10_000); })]); }
    finally { clearTimeout(closeTimer); }
    const { killTask, killScopeUnit } = await import('../task-manager/control');
    if (!graceful) {
      const result = await killTask(task.taskId, { signal: 'SIGKILL', includeSubtree: true, reapTerminalResidue: true });
      if (!result.ok && result.error !== 'already_gone') {
        const scope = result.error === 'not_live' && task.scopeUnit
          ? await killScopeUnit(task.scopeUnit, { escalateAfterMs: 500 }) : null;
        if (!scope || (!scope.ok && scope.error !== 'already_gone'))
          throw new Error(`process observer cleanup refused: ${result.error}`);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([closed, completion({ taskId: task.taskId, scopeUnit: task.scopeUnit,
        workspaceId: task.row.workspaceId, completion: task.waitForCompletion }).then(result => {
        if (result.status !== 'recorded') throw new Error(`process observer terminal write ${result.status}`);
      })]), new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error('process observer cleanup deadline')), 10_000); })]);
    } finally { clearTimeout(timer); }
    launched = null;
  };
  try {
    if (process.platform !== 'linux') throw new Error('Linux BPF process observation unavailable');
    const helper = fileURLToPath(new URL('../../../../scripts/lib/fair-process-observer.py', import.meta.url));
    const argv = ['-n', '/usr/bin/python3', '-u', helper, '--cgroup', cgroupPath];
    launched = await managedSpawn('sudo', argv, { class: 'test-run', title: 'fair comparison process observer',
      argv: ['sudo', ...argv], launchedBy: process.env.PAPERCUSP_SID ?? 'human', workItemId: 'WI-10007889',
      runtimeMaxSec: 8 * 3600 + 60 }, { requireRegistration: true, spawnOptions: { stdio: ['pipe', 'pipe', 'pipe'] } });
    const task = launched;
    if (!task.confined || !task.scopeUnit) throw new Error('process observer confinement unavailable');
    const child = task.child;
    closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : new Promise(done => child.once('close', () => done()));
    const channel = channelFactory({ send: (line, done) => { child.stdin!.write(line, done); },
      isLive: () => child.exitCode === null && child.signalCode === null && !child.stdin!.destroyed,
      deadlineMs: () => 10_000, drainCapMs: 10_000, now: () => performance.now() });
    let ready!: () => void, refuse!: (error: Error) => void;
    const started = new Promise<void>((done, reject) => { ready = done; refuse = reject; });
    let buffer = '', stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line === 'FAIR_PROCESS_OBSERVER_READY=1') ready();
        else channel.receive(line);
      }
    });
    const failed = () => { const error = new Error(`process observer exited: ${stderr}`); refuse(error); channel.failAll(error); };
    child.once('close', failed);
    child.once('error', error => { refuse(error); channel.failAll(error); });
    if (child.exitCode !== null || child.signalCode !== null) failed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([started, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error('process observer startup deadline')), 60_000);
    })]); } finally { clearTimeout(timer); }
    const observerCgroup = scopeCgroupRelPath(deriveUserManagerRoot(readProcessCgroupPath(process.pid)), 'test-run', task.scopeUnit);
    return { stop, async sample() {
      const witness = await channel.rpc<FairProcessWitness>('sample');
      return { witness, unknown: [] as string[], overhead: { taskId: task.taskId, cgroupPath: observerCgroup,
        ...sampleCgroup(absCgroupDir(observerCgroup)) } };
    } };
  } catch (error) {
    failure = `process-observer-unavailable:${String(error)}`;
    try { await stop(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'process observer startup and cleanup failed');
    }
  }
  return { stop, async sample() { return { witness: null, unknown: [failure!], overhead: null }; } };
}
