/** Linux host adapter. No caller-selected command, path, PID, scope or seed. */
import { createHash } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { moduleRepoRoot } from './module-repo-root';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { RuntimeCustodyRefusal, runtimeCustodyFingerprint, RUNTIME_RESOURCE_KINDS,
  type RuntimeLease, type RuntimeResourceIntent } from './blind-review-runtime-custody';
import type { RuntimeNamespaceBackend } from './blind-review-runtime-lifecycle';
import { assertRuntimeSeed } from './blind-review-runtime-seed';
import { runtimeSourceImageOrigin } from './blind-review-source-image';
import { managedSpawn, markManagedSpawnTeardown, type ManagedSpawnResult } from './task-manager/managed-spawn';
import { killScopeUnit } from './task-manager/control';
import { parseProcCgroup } from './task-manager/cgroup-read';
import { deriveUserManagerRoot, scopeCgroupRelPath, scopeUnitForTask } from './task-manager/types';

const helper = join(moduleRepoRoot(import.meta.url), 'scripts/lib/blind-review-sealed-source.py');
const REQUIRED = RUNTIME_RESOURCE_KINDS.filter(kind => kind !== 'capture');
const MAX_FRAME = 16 * 1024;
type Provision = Parameters<RuntimeNamespaceBackend['provision']>[0];
type Creator = { cancel: AbortController; stopped: boolean; closed: boolean; child?: ChildProcess;
  control?: Duplex; spawn?: Promise<ManagedSpawnResult>; task?: ManagedSpawnResult };
// Shared between factory instances in this process. Never replay/adopt a
// runtime merely because another factory has no local ChildProcess handle.
const creators = new Map<string, Creator>();
function refuse(code: string): never { throw new RuntimeCustodyRefusal(code); }

export function runtimeManagedTaskId(lease: Pick<RuntimeLease, 'id' | 'lease_epoch' | 'runtime_nonce' | 'workspace_id'>) {
  z.string().uuid().parse(lease.id); z.string().uuid().parse(lease.runtime_nonce);
  z.string().min(1).max(200).parse(lease.workspace_id);
  if (!/^[1-9][0-9]{0,18}$/.test(String(lease.lease_epoch))) refuse('runtime_identity_mismatch');
  return 'br' + createHash('sha256').update(JSON.stringify([
    lease.workspace_id, lease.id, String(lease.lease_epoch), lease.runtime_nonce,
  ])).digest('hex').slice(0, 60);
}

function inventory(lease: RuntimeLease, resources: readonly RuntimeResourceIntent[]) {
  if (resources.length !== REQUIRED.length || new Set(resources.map(r => r.id)).size !== REQUIRED.length)
    refuse('runtime_inventory_incomplete');
  const byId = new Map<string, RuntimeResourceIntent>();
  for (const kind of REQUIRED) {
    const rows = resources.filter(r => r.kind === kind);
    const row = rows[0];
    if (rows.length !== 1 || !row || row.lease_id !== lease.id || row.slot !== 'main' ||
        row.identity !== null || !z.string().uuid().safeParse(row.id).success ||
        row.ownership_tag !== runtimeCustodyFingerprint({ leaseId: lease.id,
          epoch: String(lease.lease_epoch), kind, slot: 'main' })) refuse('runtime_inventory_incomplete');
    byId.set(row.id, row);
  }
  return byId;
}

function showScope(unit: string, signal: AbortSignal): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/systemctl', ['--user', 'show', '-p', 'ControlGroup', '-p', 'LoadState',
      '-p', 'ActiveState', unit], { timeout: 8_000, maxBuffer: 16 * 1024, signal }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const entries = String(stdout).trim().split('\n').map(line => {
          const index = line.indexOf('=');
          if (index < 1) refuse('runtime_scope_observation_invalid');
          return [line.slice(0, index), line.slice(index + 1)];
        });
        resolve(Object.fromEntries(entries));
      } catch (error) { reject(error); }
    });
  });
}
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Strict reads: permission/IO errors never masquerade as an empty cgroup. */
async function countProcesses(directory: string, depth = 0): Promise<number> {
  if (depth > 32) refuse('runtime_cgroup_observation_incomplete');
  let content: string, entries;
  try {
    content = await readFile(directory + '/cgroup.procs', 'utf8');
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) { if (isMissing(error)) return 0; throw error; }
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.some(line => !/^[1-9][0-9]*$/.test(line))) refuse('runtime_cgroup_observation_invalid');
  let count = lines.length;
  for (const entry of entries) if (entry.isDirectory()) count += await countProcesses(directory + '/' + entry.name, depth + 1);
  return count;
}

/** Compare systemd's exact unit to its deterministic kernel location. */
async function observeScope(taskId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const unit = scopeUnitForTask(taskId);
  const manager = deriveUserManagerRoot(parseProcCgroup(await readFile('/proc/self/cgroup', 'utf8')));
  if (!manager || !process.getuid || !manager.endsWith('/user@' + process.getuid() + '.service'))
    refuse('runtime_user_manager_unknown');
  // Positive visibility control before interpreting an ENOENT below as absence.
  await readFile('/sys/fs/cgroup' + manager + '/cgroup.events', 'utf8');
  const expected = scopeCgroupRelPath(manager, 'desktop', unit);
  const state = await showScope(unit, signal);
  if (!['loaded', 'not-found'].includes(state.LoadState ?? '') ||
      !['active', 'activating', 'deactivating', 'inactive', 'failed'].includes(state.ActiveState ?? '') ||
      state.ControlGroup === undefined || state.ControlGroup && state.ControlGroup !== expected ||
      state.LoadState === 'not-found' && (state.ControlGroup || state.ActiveState !== 'inactive'))
    refuse('runtime_scope_identity_mismatch');
  const processes = await countProcesses('/sys/fs/cgroup' + expected);
  signal.throwIfAborted();
  return { unit, cgroup: expected, processes,
    absent: processes === 0 && ['inactive', 'failed'].includes(state.ActiveState!) };
}

const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('before'), seq: z.number().int().positive(), intentId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('created'), seq: z.number().int().positive(), intentId: z.string().uuid(),
    identity: z.record(z.string().min(1).max(80), z.string().min(1).max(512))
      .refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 16) }).strict(),
  z.object({ type: z.literal('ready'), seq: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('failed'), seq: z.number().int().positive(),
    stage: z.enum(['process', 'listener', 'display', 'database', 'workspace', 'profile', 'channel', 'credential']),
    code: z.string().regex(/^[a-z_]{1,100}$/) }).strict(),
]);

function superviseControl(input: Provision, creator: Creator, taskId: string) {
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Enrollment may be awaiting markSpawned when a child fails immediately.
  void ready.catch(() => {});
  let buffer = Buffer.alloc(0), sequence = 0, frames = 0, ended = false, completed = false;
  let chain = Promise.resolve();
  const resources = new Map(input.resources.map(r => [r.id, r]));
  const authorized = new Set<string>(), recorded = new Set<string>();
  function fail(error: unknown) {
    if (ended) return;
    ended = true; creator.closed = true; creator.control?.destroy(); rejectReady(error);
    // Also fence post-ready service failure. The durable lease is cut off by
    // the lifecycle reaper; no further management operation can succeed here.
    creator.cancel.abort(error);
  }
  async function frame(line: Buffer) {
    if (ended || completed) refuse('runtime_control_closed');
    input.signal.throwIfAborted(); creator.cancel.signal.throwIfAborted();
    if (++frames > 256) refuse('runtime_control_frame_limit');
    const message = frameSchema.parse(JSON.parse(line.toString('utf8')));
    if (message.seq !== ++sequence) refuse('runtime_control_sequence_invalid');
    if (message.type === 'failed') refuse('runtime_guest_' + message.stage + '_' + message.code);
    if (message.type === 'ready') {
      if (input.resources.some(r => !recorded.has(r.id))) refuse('runtime_inventory_incomplete');
      const observation = await observeScope(taskId, input.signal);
      if (observation.absent || observation.processes < 1) refuse('runtime_scope_not_live');
      creator.control!.write(JSON.stringify({ ok: true, seq: sequence }) + '\n');
      completed = true; resolveReady(); return;
    }
    const resource = resources.get(message.intentId);
    if (!resource || resource.kind === 'managed-scope' || resource.kind === 'capture') refuse('resource_intent_missing');
    if (message.type === 'before') {
      // Some resource kinds own several children/files. Every create asks
      // again, even when its aggregate inventory identity is already recorded.
      await input.beforeCreate();
      input.signal.throwIfAborted(); creator.cancel.signal.throwIfAborted();
      authorized.add(resource.id);
    } else {
      if (!authorized.has(resource.id) || recorded.has(resource.id)) refuse('runtime_resource_order_invalid');
      await input.record(resource.id, message.identity);
      input.signal.throwIfAborted(); creator.cancel.signal.throwIfAborted();
      recorded.add(resource.id);
    }
    creator.control!.write(JSON.stringify({ ok: true, seq: sequence }) + '\n');
  }
  return {
    ready, fail,
    recordScope(id: string) { recorded.add(id); },
    attach(child: ChildProcess) {
      creator.child = child;
      const descriptors: ReadonlyArray<unknown> = child.stdio;
      const stream = descriptors[5] as Duplex | null | undefined;
      if (!stream || typeof stream.write !== 'function') return fail(new Error('runtime_control_missing'));
      creator.control = stream;
      stream.on('error', fail);
      stream.on('end', () => fail(new Error('runtime_control_closed')));
      stream.on('close', () => fail(new Error('runtime_control_closed')));
      stream.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 2 * MAX_FRAME) return fail(new Error('runtime_control_frame_too_large'));
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          if (!line.length || line.length > MAX_FRAME) return fail(new Error('runtime_control_frame_too_large'));
          chain = chain.then(() => frame(line)); void chain.catch(fail);
        }
      });
      child.once('error', fail);
      child.once('close', () => fail(new Error('runtime_guest_exited')));
    },
  };
}

export function createLinuxRuntimeNamespaceBackend(): RuntimeNamespaceBackend {
  return {
    async provision(input) {
      input.signal.throwIfAborted(); runtimeSourceImageOrigin(input.image); assertRuntimeSeed(input.seed, input.lease);
      const taskId = runtimeManagedTaskId(input.lease), resources = inventory(input.lease, input.resources);
      if (input.lease.state !== 'allocating' || creators.has(taskId)) refuse('runtime_provisioning_interrupted');
      const deadline = new Date(input.lease.expires_at ?? '').getTime();
      if (!Number.isFinite(deadline) || deadline - Date.now() < 2_000) refuse('lease_expired_or_revoked');
      const creator: Creator = { cancel: new AbortController(), stopped: false, closed: false };
      creators.set(taskId, creator);
      const control = superviseControl(input, creator, taskId);
      const abort = () => control.fail(input.signal.reason ?? new Error('runtime_provisioning_cancelled'));
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        const observation = await observeScope(taskId, input.signal);
        if (!observation.absent) refuse('runtime_scope_already_present');
        await input.beforeCreate(); input.signal.throwIfAborted(); creator.cancel.signal.throwIfAborted();
        const scope = [...resources.values()].find(r => r.kind === 'managed-scope')!;
        const argv = ['-I', '-S', helper, 'runtime-exec', '--sha256', input.image.imageSha256,
          '--max-bytes', String(input.image.imageBytes), '--manifest-sha256', input.image.manifestSha256, '--control-fd', '5'];
        creator.spawn = managedSpawn('/usr/bin/python3', argv, {
          class: 'desktop', launchedBy: 'system:blind-review-runtime-broker', title: 'Disposable blind review runtime',
          argv: ['/usr/bin/python3', ...argv], runtimeMaxSec: 960,
          detail: { runtimeLeaseId: input.lease.id, leaseEpoch: String(input.lease.lease_epoch),
            runtimeNonce: input.lease.runtime_nonce, ownershipTag: scope.ownership_tag },
        }, { workspaceId: input.lease.workspace_id, taskId, deadlineEpochMs: deadline,
          signal: creator.cancel.signal, requireRegistration: true, requireConfinement: true,
          spawnOptions: { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
            stdio: ['ignore', 'ignore', 'ignore', input.image.handle.fd, 'ignore', 'pipe'] }, onSpawn: control.attach });
        creator.task = await creator.spawn;
        if (!creator.task.confined || creator.task.scopeUnit !== scopeUnitForTask(taskId)) refuse('runtime_scope_identity_mismatch');
        input.signal.throwIfAborted(); creator.cancel.signal.throwIfAborted();
        await input.record(scope.id, { taskId, scopeUnit: creator.task.scopeUnit });
        control.recordScope(scope.id);
        creator.control!.write(JSON.stringify({ version: 1, seed: input.seed,
          resources: input.resources.filter(r => r.kind !== 'managed-scope').map(r => ({
            id: r.id, kind: r.kind, ownershipTag: r.ownership_tag })) }) + '\n');
        await control.ready;
      } catch (error) { control.fail(error); throw error; }
      finally { creator.stopped = true; input.signal.removeEventListener('abort', abort); }
    },

    async teardown(lease, signal) {
      signal.throwIfAborted();
      const taskId = runtimeManagedTaskId(lease), creator = creators.get(taskId);
      if (creator) {
        creator.cancel.abort(new Error('runtime_revoked'));
        creator.closed = true; creator.control?.destroy();
        if (creator.spawn) await creator.spawn.catch(() => undefined);
      }
      signal.throwIfAborted();
      const undo = creator?.child ? markManagedSpawnTeardown(creator.child) : undefined;
      try {
        const result = await killScopeUnit(scopeUnitForTask(taskId), { escalateAfterMs: 500 });
        if (!result.ok && result.error !== 'already_gone') refuse('runtime_scope_teardown_unverified');
        // Controller success alone is insufficient (SIGKILL may still be
        // pending). Observe kernel absence afresh, including restart recovery.
        if (!(await observeScope(taskId, signal)).absent) refuse('runtime_scope_teardown_unverified');
        if (creator && !creator.stopped) refuse('runtime_creator_not_fenced');
        creators.delete(taskId);
      } finally { undo?.(); }
    },

    async inspect(lease, resources, signal) {
      const taskId = runtimeManagedTaskId(lease), creator = creators.get(taskId);
      const observation = await observeScope(taskId, signal);
      const creatorStopped = !creator || creator.stopped;
      // Every guest file/socket/profile/database is exclusively inside these
      // private namespaces, with no host bind or ambient fd. A live/unknown
      // scope can never prove the inventory absent, recorded or not.
      const absent = observation.absent && creatorStopped;
      return { creatorStopped, scopeAbsent: absent,
        checkedKinds: [...RUNTIME_RESOURCE_KINDS], absentIntentIds: absent ? resources.map(r => r.id) : [] };
    },
  };
}
