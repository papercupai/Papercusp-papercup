import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { createLinuxRuntimeNamespaceBackend, runtimeManagedTaskId } from './blind-review-runtime-backend';
import { RUNTIME_RESOURCE_KINDS, runtimeCustodyFingerprint, type RuntimeLease,
  type RuntimeResourceIntent } from './blind-review-runtime-custody';
import { createRuntimeSeed } from './blind-review-runtime-seed';
import type { RuntimeSourceImage } from './blind-review-source-image';
import { managedSpawn } from './task-manager/managed-spawn';

const kernel = vi.hoisted(() => ({ running: false, wrongScope: false, unreadable: false,
  show: null as string | null, killLeavesResidue: false }));
vi.mock('./blind-review-source-image', () => ({ runtimeSourceImageOrigin: vi.fn(() => ({})) }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: vi.fn(), markManagedSpawnTeardown: () => () => {} }));
vi.mock('./task-manager/control', () => ({ killScopeUnit: vi.fn(async () => {
  if (!kernel.killLeavesResidue) kernel.running = false;
  return { ok: true };
}) }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async (path: string) => {
    if (path === '/proc/self/cgroup') return '0::/user.slice/user-' + process.getuid!() + '.slice/user@' + process.getuid!() + '.service/app.slice/unit.scope\n';
    if (kernel.unreadable) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (path.endsWith('/cgroup.events')) return 'populated 1\n';
    if (path.endsWith('/cgroup.procs') && kernel.running) return '123\n';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }), readdir: vi.fn(async () => []),
}));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  execFile: vi.fn((_file, args, _options, callback) => {
    const unit = args.at(-1);
    const cgroup = '/user.slice/user-' + process.getuid!() + '.slice/user@' + process.getuid!() +
      '.service/papercusp.slice/papercusp-desktop.slice/' + unit;
    callback(null, kernel.show ?? (kernel.wrongScope ? 'ControlGroup=/foreign\nLoadState=loaded\nActiveState=active\n' :
      kernel.running ? 'ControlGroup=' + cgroup + '\nLoadState=loaded\nActiveState=active\n' :
        'ControlGroup=\nLoadState=not-found\nActiveState=inactive\n'));
  }),
}));

function fixture() {
  const lease: RuntimeLease = { id: randomUUID(), lease_epoch: 1, runtime_nonce: randomUUID(), workspace_id: 'test-private',
    binding_id: 12, activation_audit_seq: 3, replacement_epoch: 0, request_id: randomUUID(), request_hash: 'a'.repeat(64),
    state: 'allocating', receipt_id: randomUUID(), admission: {}, expires_at: new Date(Date.now() + 120_000), revoked_at: null };
  const resources: RuntimeResourceIntent[] = RUNTIME_RESOURCE_KINDS.filter(kind => kind !== 'capture').map(kind => ({
    id: randomUUID(), lease_id: lease.id, kind, slot: 'main', identity: null,
    ownership_tag: runtimeCustodyFingerprint({ leaseId: lease.id, epoch: '1', kind, slot: 'main' }),
  }));
  const cancel = new AbortController();
  return { lease, resources, seed: createRuntimeSeed(lease), image: { handle: { fd: 77 }, imageSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64), imageBytes: 100 } as RuntimeSourceImage,
  signal: cancel.signal, cancel, beforeCreate: vi.fn(async () => {}), record: vi.fn(async (_id: string, _identity: Record<string, string>) => {}) };
}

/** Duplex boundary simulator; the actual inherited fd is exercised in the namespace suite. */
function guest(mode: 'valid' | 'replay' | 'unplanned' | 'oversized' | 'incomplete' | 'failed' = 'valid') {
  const sent: Record<string, unknown>[] = [];
  let frames: Record<string, unknown>[] = [], cursor = 0;
  const stream = new Duplex({ read() {}, write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()); sent.push(message);
    if (message.version === 1) {
      let sequence = 0;
      frames = message.resources.flatMap((r: { id: string }) => [
        { type: 'before', seq: ++sequence, intentId: r.id },
        { type: 'created', seq: ++sequence, intentId: r.id, identity: { observed: 'private' } },
      ]);
      frames.push({ type: 'ready', seq: ++sequence });
      if (mode === 'replay') frames[1]!.seq = 1;
      if (mode === 'unplanned') frames[0]!.intentId = randomUUID();
      if (mode === 'incomplete') frames = [{ type: 'ready', seq: 1 }];
      if (mode === 'oversized') frames = [{ type: 'before', seq: 1, intentId: 'x'.repeat(20_000) }];
      if (mode === 'failed') frames = [{ type: 'failed', seq: 1, stage: 'database', code: 'guest_migration_failed' }];
    }
    const frame = frames[cursor++];
    if (frame) queueMicrotask(() => stream.push(Buffer.from(JSON.stringify(frame) + '\n')));
    done();
  } });
  const child = new EventEmitter() as EventEmitter & { stdio: unknown[]; kill: ReturnType<typeof vi.fn> };
  child.stdio = [null, null, null, null, null, stream]; child.kill = vi.fn();
  vi.mocked(managedSpawn).mockImplementation(async (_command, _argv, _spec, opts) => {
    kernel.running = true;
    opts!.onSpawn!(child as never, opts!.taskId!);
    return { taskId: opts!.taskId!, scopeUnit: 'pc-' + opts!.taskId! + '.scope', confined: true,
      child, row: {}, waitForCompletion: async () => ({ status: 'recorded' }) } as never;
  });
  return { sent, stream };
}

beforeEach(() => { vi.clearAllMocks(); Object.assign(kernel, {
  running: false, wrongScope: false, unreadable: false, show: null, killLeavesResidue: false,
}); });

describe('managed disposable runtime backend', () => {
  it('binds the finite managed scope, creates only after cutoff checks and records every planned resource', async () => {
    const f = fixture(), g = guest(), backend = createLinuxRuntimeNamespaceBackend();
    await backend.provision(f);
    const [command, argv, spec, opts] = vi.mocked(managedSpawn).mock.calls[0]!;
    expect(command).toBe('/usr/bin/python3'); expect(argv).toContain('runtime-exec');
    expect(spec).toMatchObject({ runtimeMaxSec: 960, class: 'desktop' });
    expect(opts).toMatchObject({ requireRegistration: true, requireConfinement: true,
      deadlineEpochMs: new Date(f.lease.expires_at!).getTime(),
      spawnOptions: { stdio: ['ignore', 'ignore', 'ignore', 77, 'ignore', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } } });
    expect(f.beforeCreate).toHaveBeenCalledTimes(9);
    expect(f.record.mock.calls.map(call => call[0]).sort()).toEqual(f.resources.map(r => r.id).sort());
    expect(g.sent[0]).toMatchObject({ version: 1, seed: f.seed });
    // Lifecycle aborts its provisioning signal after success. A ready runtime
    // remains alive until explicit cutoff/teardown, not that local finally.
    f.cancel.abort(); expect(g.stream.destroyed).toBe(false);
    await backend.teardown(f.lease, new AbortController().signal);
    expect(await backend.inspect(f.lease, f.resources, new AbortController().signal)).toMatchObject({
      scopeAbsent: true, creatorStopped: true, absentIntentIds: f.resources.map(r => r.id),
    });
  });

  it.each(['replay', 'unplanned', 'oversized', 'incomplete'] as const)('fails closed on %s management evidence', async mode => {
    const f = fixture(), g = guest(mode), backend = createLinuxRuntimeNamespaceBackend();
    await expect(backend.provision(f)).rejects.toThrow();
    expect(g.stream.destroyed).toBe(true);
    expect(f.record).toHaveBeenCalledTimes(1); // managed scope only
    await backend.teardown(f.lease, new AbortController().signal);
  });

  it('never acknowledges a failed durable record or permits the next create', async () => {
    const f = fixture(), g = guest(), backend = createLinuxRuntimeNamespaceBackend();
    f.record.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(backend.provision(f)).rejects.toThrow('database unavailable');
    expect(f.beforeCreate).toHaveBeenCalledTimes(2);
    expect(g.sent).toHaveLength(2); // config, before ACK; created has no ACK
    await backend.teardown(f.lease, new AbortController().signal);
  });

  it('preserves a bounded guest failure stage without accepting ready or product logs', async () => {
    const f = fixture(), g = guest('failed'), backend = createLinuxRuntimeNamespaceBackend();
    await expect(backend.provision(f)).rejects.toThrow('runtime_guest_database_guest_migration_failed');
    expect(g.stream.destroyed).toBe(true); expect(f.record).toHaveBeenCalledTimes(1);
    await backend.teardown(f.lease, new AbortController().signal);
  });

  it.each(['wrong-tag', 'missing', 'recorded', 'foreign-lease', 'expired', 'copied-seed'])(
    'rejects invalid admission inputs before spawning (%s)', async kind => {
      const f = fixture(), backend = createLinuxRuntimeNamespaceBackend(); guest();
      if (kind === 'wrong-tag') f.resources[0]!.ownership_tag = '0'.repeat(64);
      if (kind === 'missing') f.resources.pop();
      if (kind === 'recorded') f.resources[0]!.identity = { taskId: 'old' };
      if (kind === 'foreign-lease') f.resources[0]!.lease_id = randomUUID();
      if (kind === 'expired') f.lease.expires_at = new Date(0);
      if (kind === 'copied-seed') f.seed = JSON.parse(JSON.stringify(f.seed));
      await expect(backend.provision(f)).rejects.toThrow();
      expect(managedSpawn).not.toHaveBeenCalled();
    });

  it.each(['wrong-scope', 'unreadable', 'malformed'])(
    'never interprets an incomplete discovery read as absence (%s)', async kind => {
      const f = fixture(), backend = createLinuxRuntimeNamespaceBackend(); guest();
      if (kind === 'wrong-scope') kernel.wrongScope = true;
      if (kind === 'unreadable') kernel.unreadable = true;
      if (kind === 'malformed') kernel.show = 'not a property\n';
      await expect(backend.inspect(f.lease, f.resources, f.signal)).rejects.toThrow();
      await expect(backend.provision(f)).rejects.toThrow(); expect(managedSpawn).not.toHaveBeenCalled();
    });

  it('does not accept controller success while kernel scope residue remains', async () => {
    const f = fixture(), backend = createLinuxRuntimeNamespaceBackend(); guest();
    await backend.provision(f); kernel.killLeavesResidue = true;
    await expect(backend.teardown(f.lease, f.signal)).rejects.toThrow('runtime_scope_teardown_unverified');
    expect(await backend.inspect(f.lease, f.resources, f.signal)).toMatchObject({ scopeAbsent: false, absentIntentIds: [] });
    kernel.killLeavesResidue = false; await backend.teardown(f.lease, f.signal);
  });

  it('derives a distinct recovery scope for every lease epoch, nonce and workspace', () => {
    const { lease } = fixture(), original = runtimeManagedTaskId(lease);
    expect(original).toMatch(/^[a-z0-9]{4,64}$/);
    expect(runtimeManagedTaskId({ ...lease })).toBe(original);
    for (const changed of [{ lease_epoch: 2 }, { runtime_nonce: randomUUID() }, { workspace_id: 'other' }, { id: randomUUID() }])
      expect(runtimeManagedTaskId({ ...lease, ...changed })).not.toBe(original);
  });
});
