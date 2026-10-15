import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, appendFile, rename } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { RpcFrame, SuStdioReceipt } from '../su-session-stdio-peer';
import { GatewayRequestTelemetry } from '../inference-gateway/request-stage-telemetry';

const NEVER_EMIT_MARKER = 'never-emit-me';
const preflightClock = vi.hoisted(() => ({ id: 'preflight-test-clock', now: () => 5_000_000 }));
vi.mock('../process-monotonic-clock', () => ({ processMonotonicClock: preflightClock }));

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open), readdir: vi.fn(original.readdir), readlink: vi.fn(original.readlink), stat: vi.fn(original.stat) };
});

import {
  collectTranscriptFiles,
  measureTranscriptFile,
  ownerIdFromPath,
  scanLaunchTranscripts,
  captureCompletedCarrySource,
  captureCarrySourcePreflight,
  recheckCarrySourceSnapshot,
  captureCarryNativeConfiguration,
  recheckCarryNativeConfiguration,
  captureCarryArtifactManifest,
  recheckCarryArtifactManifest,
  captureCarryRuntimeSnapshot,
  recheckCarryRuntimeSnapshot,
  captureCarryRequestEvidence,
  type CarryDependencyScope,
} from './scan-launch-transcripts';
import { createCarryTrialRecipe } from './launch-cost-metrics';
import { canonicalJson } from '../authority/authority-rpc-envelope';

describe('carry request evidence controller', () => {
  function fixture(suffix = '') {
    const threadId = `thread${suffix}`, peerId = `peer${suffix}`, armId = `arm${suffix}`, path = `/native/rollout${suffix}`;
    const receipts: SuStdioReceipt[] = [];
    const emit = (phase: SuStdioReceipt['phase'], frame: RpcFrame) => receipts.push({ phase, frame,
      peerId, clockId: 'clock', sequence: receipts.length + 1, atMs: receipts.length });
    const rpc = (id: string, method: string, params: RpcFrame, result: RpcFrame) => {
      emit('write-started', { id, method, params }); emit('write-completed', { id, method, params }); emit('received', { id, result });
    };
    rpc('open', 'thread/fork', { threadId: 'predecessor' }, { thread: { id: threadId, path,
      turns: [{ id: 'old', status: 'completed' }] } });
    rpc('turn', 'turn/start', { threadId }, { turn: { id: 'new' } });
    emit('received', { method: 'turn/started', params: { threadId, turn: { id: 'new', status: 'inProgress' } } });
    emit('received', { method: 'turn/completed', params: { threadId, turn: { id: 'new', status: 'completed' } } });
    rpc('read', 'thread/read', { threadId, includeTurns: true }, { thread: { id: threadId, path,
      turns: [{ id: 'old', status: 'completed' }, { id: 'new', status: 'completed' }] } });
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ ownerId: 'owner', provider: 'codex', protocol: 'openai-responses', transport: 'bearer-http' });
    span.recordAttempt(); span.finish('ok', 200);
    const gateway = telemetry.snapshot(), row = gateway.recent[0];
    row.nativeCorrelation = { status: 'observed', sessionId: threadId, threadId, turnId: 'new', windowId: null };
    row.upstreamWrites.calls = [{ ordinal: 1, accountId: 'local-routing-label', clockId: 'clock', clock: 'performance.now',
      outcome: 'returned', responseStatus: 200, matchedRequests: 1, unexpectedRequests: 0, droppedRequests: 0,
      droppedEvents: 0, events: [{ phase: 'created', requestOrdinal: 1, atMs: 1 }] }];
    const input = { workspaceId: 'workspace', ownerId: 'owner', gateway, native: { receipts,
      state: { peerId, clockId: 'clock', emitted: receipts.length, enabled: true, sinkFailed: false, exited: true, pendingWrites: 0 },
      arms: [{ threadId, armId }] } };
    const rows = [
      { session_id: threadId, usage_event_key: createHash('sha256').update(`old${suffix}`).digest('hex'), usage_provenance: { turnId: 'old' }, population_count: '2' },
      { session_id: threadId, usage_event_key: createHash('sha256').update(`new${suffix}`).digest('hex'), usage_provenance: { turnId: 'new' }, population_count: '2' },
    ];
    const query = vi.fn(async () => rows), array = vi.fn((values: string[]) => values);
    const sql = Object.assign(query, { array }) as unknown as Sql;
    return { input, rows, query, array, sql };
  }

  it('queries derived scope and retains inherited usage outside the new-turn join', async () => {
    const { input, sql, query, array, rows } = fixture(), before = structuredClone(input);
    const evidence = await captureCarryRequestEvidence(sql, input);
    expect(evidence).toMatchObject({ status: 'observations-linked', missing: [], violations: [],
      admission: 'not-established', accountingComplete: false,
      native: { status: 'closed-peer-reconciled' }, canonical: { coverage: 'complete-selected-snapshot', ingestionCoverage: 'not-established' },
      inheritedUsage: [{ usage_event_key: rows[0].usage_event_key }],
      population: { turns: [{ usageEventKeys: [rows[1].usage_event_key] }], nativePopulationCoverage: 'not-established', chargeJoin: 'unavailable' } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(array.mock.calls).toEqual([[['thread']], [['thread']], [['/native/rollout']]]);
    expect(input).toEqual(before);
    expect(evidence.captureSha256).toBe(createHash('sha256').update(canonicalJson(input)).digest('hex'));
    expect(evidence).not.toHaveProperty('costUsd');
    expect(evidence).not.toHaveProperty('receipts');
  });

  it('does not query an incomplete or unassigned native population', async () => {
    const { input, sql, query } = fixture(); input.native.receipts.pop();
    const evidence = await captureCarryRequestEvidence(sql, input);
    expect(evidence.status).not.toBe('observations-linked');
    expect(evidence).toMatchObject({ canonical: null, population: null, accountingComplete: false });
    expect(query).not.toHaveBeenCalled();
  });

  it('joins separate closed peers against one complete gateway and SQL population', async () => {
    const first = fixture(), second = fixture('-second');
    const gateway = first.input.gateway;
    gateway.recent.push({ ...second.input.gateway.recent[0], requestId: 2 });
    gateway.requests = { ...gateway.requests, started: 2, finalized: 2, sampled: 2 };
    gateway.outcomes.ok = 2;
    first.rows.push(...second.rows);
    first.rows.forEach(row => { row.population_count = '4'; });
    const input = { ...first.input, native: [first.input.native, second.input.native] };
    const result = await captureCarryRequestEvidence(first.sql, input);
    expect(result).toMatchObject({ status: 'observations-linked', accountingComplete: false,
      native: { turns: [{ armId: 'arm' }, { armId: 'arm-second' }] },
      population: { unmatchedGatewayRequestIds: [], unmatchedUsageRows: [] } });
    expect(result.inheritedUsage).toHaveLength(2);
    expect(first.query).toHaveBeenCalledTimes(1);
    expect(first.array.mock.calls[0][0]).toEqual(['thread', 'thread-second']);
    // Dropping a whole peer must leave its gateway request visibly unmatched.
    await expect(captureCarryRequestEvidence(first.sql, { ...input, native: [first.input.native] }))
      .resolves.toMatchObject({ population: { unmatchedGatewayRequestIds: [2] } });
  });

  it.each(['peer', 'arm', 'thread', 'source', 'truncated', 'live'] as const)(
    'rejects invalid peer sets before SQL (%s)', async kind => {
      const first = fixture(), second = fixture(kind === 'thread' ? '' : '-second');
      if (kind === 'peer') {
        second.input.native.state.peerId = first.input.native.state.peerId;
        second.input.native.receipts.forEach(receipt => { receipt.peerId = first.input.native.state.peerId; });
      }
      if (kind === 'arm') second.input.native.arms[0].armId = first.input.native.arms[0].armId;
      if (kind === 'source') for (const receipt of second.input.native.receipts) {
        const thread = (receipt.frame.result as RpcFrame | undefined)?.thread as RpcFrame | undefined;
        if (thread) thread.path = '/native/rollout';
      }
      if (kind === 'truncated') second.input.native.receipts.pop();
      if (kind === 'live') second.input.native.state.exited = false;
      const result = await captureCarryRequestEvidence(first.sql, { ...first.input, native: [first.input.native, second.input.native] });
      expect(result.status).not.toBe('observations-linked');
      expect(first.query).not.toHaveBeenCalled();
    });

  it.each([0, 129])('rejects a peer count outside the bound (%s)', async count => {
    const { input, sql, query } = fixture();
    expect((await captureCarryRequestEvidence(sql, { ...input, native: Array(count).fill(input.native) })).violations)
      .toContain('native-capture-set-bound');
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['duplicate-inherited', 'duplicate-across-partitions', 'malformed-inherited', 'unknown-turn', 'wrong-session'] as const)(
    'does not discard inconsistent canonical evidence (%s)', async kind => {
      const { input, sql, rows } = fixture();
      if (kind === 'duplicate-inherited') { rows.push(structuredClone(rows[0])); rows.forEach(row => { row.population_count = '3'; }); }
      if (kind === 'duplicate-across-partitions') rows[1].usage_event_key = rows[0].usage_event_key;
      if (kind === 'malformed-inherited') rows[0].usage_event_key = 'bad';
      if (kind === 'unknown-turn') rows[0].usage_provenance.turnId = 'unobserved';
      if (kind === 'wrong-session') rows[0].session_id = 'different';
      const evidence = await captureCarryRequestEvidence(sql, input);
      expect(evidence.status).not.toBe('observations-linked');
      expect(evidence.canonical?.rows).toHaveLength(rows.length);
    });

  it('retains an unknown canonical query outcome as a rejection, not empty or zero usage', async () => {
    const { input, sql, query } = fixture(); query.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(captureCarryRequestEvidence(sql, input)).rejects.toThrow('database unavailable');
  });

  it('freezes native and gateway captures before awaiting SQL', async () => {
    const { input, sql, query, rows } = fixture();
    let finish!: (result: typeof rows) => void;
    query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const hash = createHash('sha256').update(canonicalJson(input)).digest('hex');
    const pending = captureCarryRequestEvidence(sql, input);
    input.native.receipts.length = 0; input.gateway.recent.length = 0; input.ownerId = 'changed';
    finish(rows);
    expect(await pending).toMatchObject({ status: 'observations-linked', captureSha256: hash });
  });
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'launch-cost-scan-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build `<root>/<owner>/projects/<project>/<session>.jsonl` and return its path. */
async function writeTranscript(
  owner: string,
  session: string,
  lines: unknown[],
  project = '-repo',
): Promise<string> {
  const dir = join(root, owner, 'projects', project);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${session}.jsonl`);
  await writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return filePath;
}

function usageEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-09-18T06:31:53.858Z',
    entrypoint: 'cli',
    version: '2.1.0',
    cwd: '/repo',
    sessionId: 'session-a',
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 128_745,
        cache_read_input_tokens: 103_666,
        output_tokens: 296,
      },
    },
    ...overrides,
  };
}

describe.skipIf(process.platform !== 'linux')('observed carry runtime artifacts', () => {
  const boot = '00000000-0000-0000-0000-000000000001';
  const procStat = (pid: number, parent: number, ticks = '7') => {
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = String(parent); fields[19] = ticks;
    return `${pid} (name with ) spaces) ${fields.join(' ')}\n`;
  };
  afterEach(async () => {
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fsPromises.open).mockImplementation(original.open);
    vi.mocked(fsPromises.readdir).mockImplementation(original.readdir);
    vi.mocked(fsPromises.readlink).mockImplementation(original.readlink);
    vi.mocked(fsPromises.stat).mockImplementation(original.stat);
  });
  async function fixture() {
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const proc = join(root, 'proc');
    const put = async (path: string, value: string) => {
      const target = join(proc, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, value);
    };
    const files = [join(root, 'wrapper'), join(root, 'native child'), join(root, 'libshared.so')];
    for (const path of files) await writeFile(path, `fixture bytes ${path}`);
    const mapping = async (path: string, index: number) => {
      const s = await original.stat(path, { bigint: true });
      const major = ((s.dev >> 8n) & 0xfffn) | ((s.dev >> 32n) & 0xfffff000n);
      const minor = (s.dev & 0xffn) | ((s.dev >> 12n) & 0xffffff00n);
      return `${index}000-${index}fff r-xp 0000 ${major.toString(16)}:${minor.toString(16)} ${s.ino} ${path}\n`;
    };
    await put('sys/kernel/random/boot_id', boot);
    for (const [pid, parent, exe] of [[100, 1, 0], [200, 100, 1]]) {
      await put(`${pid}/stat`, procStat(pid, parent));
      await symlink(files[exe], join(proc, String(pid), 'exe'));
      await put(`${pid}/maps`, await mapping(files[exe], 1) + await mapping(files[2], 2) +
        '3000-3fff rw-p 0000 00:00 0 [heap]\n4000-4fff rw-s 0000 00:10 17 anon_inode:[io_uring]\n');
      await put(`${pid}/task/${pid}/children`, '');
      await mkdir(join(proc, String(pid), 'fd'), { recursive: true });
    }
    // The main thread has no children; only a worker thread knows the native child.
    await put('100/task/101/children', '200 ');
    const redirect = (path: Parameters<typeof original.open>[0]) => typeof path === 'string' && path.startsWith('/proc/')
      ? join(proc, path.slice('/proc/'.length)) : path;
    vi.mocked(fsPromises.open).mockImplementation((path, ...args) => original.open(redirect(path), ...args));
    // The runtime reader uses the string-returning overloads without options.
    vi.mocked(fsPromises.readdir).mockImplementation(((path: string) => original.readdir(redirect(path))) as typeof original.readdir);
    vi.mocked(fsPromises.readlink).mockImplementation(((path: string) => original.readlink(redirect(path))) as typeof original.readlink);
    vi.mocked(fsPromises.stat).mockImplementation(((path: string, options: unknown) => original.stat(redirect(path), options as never)) as typeof original.stat);
    return { files, put, proc, mapping };
  }

  it('binds the wrapper, non-main-thread child and shared mappings into the existing artifact manifest', async () => {
    const { files } = await fixture();
    const runtime = await captureCarryRuntimeSnapshot(100);
    expect(runtime.processes.map(p => [p.pid, p.parentPid, p.executable])).toEqual([[100, 1, files[0]], [200, 100, files[1]]]);
    expect(runtime.processes.every(p => p.identity === `linux:${boot}:7`)).toBe(true);
    expect(runtime.artifacts.map(a => a.filePath).sort()).toEqual([...files].sort());
    await expect(recheckCarryRuntimeSnapshot(runtime)).resolves.toBeUndefined();
    const peer = { request: vi.fn(async (frame: Record<string, unknown>) => frame.method === 'config/read'
      ? { config: {}, layers: [] } : { data: [], nextCursor: null }), send: vi.fn(), close: vi.fn(async () => {}),
      done: Promise.resolve(), pid: () => 100 };
    const configuration = await captureCarryNativeConfiguration(peer, { threadId: 'fixture', cwd: root, servers: [] });
    const input = { protocolRef: 'fixture-only', artifacts: runtime.artifacts, configuration };
    const manifest = await captureCarryArtifactManifest(input);
    expect(manifest.artifacts.map(a => a.filePath).sort()).toEqual([...files].sort());
    await expect(recheckCarryArtifactManifest(manifest, peer)).resolves.toBeUndefined();
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('fixture bytes');
    expect(serialized).not.toContain('cmdline');
    expect(manifest.evidenceKind).toBe('observation-only');
  });

  it('retains writable shared files explicitly, including mixed mappings and permission drift', async () => {
    const { files, put, mapping } = await fixture();
    const executable = await mapping(files[1], 1), library = await mapping(files[2], 2);
    // Private writable mappings are not shared on-disk writes. A second
    // writable-shared mapping of the same file must survive deduplication.
    await put('200/maps', executable + library.replace('r-xp', 'rw-p'));
    expect((await captureCarryRuntimeSnapshot(100)).writableSharedFiles).toEqual([]);
    await put('200/maps', executable + library + (await mapping(files[2], 3)).replace('r-xp', 'rw-s'));
    const snapshot = await captureCarryRuntimeSnapshot(100);
    expect(snapshot.writableSharedFiles).toEqual([files[2]]);
    expect(snapshot.artifacts.map(a => a.filePath)).toContain(files[2]);
    await expect(recheckCarryRuntimeSnapshot(snapshot)).resolves.toBeUndefined();
    await put('200/maps', executable + library);
    await expect(recheckCarryRuntimeSnapshot(snapshot)).rejects.toThrow('changed after capture');
  });

  it('retains regular open storage absent from maps, write access and duplicate descriptors', async () => {
    const { files, put, proc } = await fixture();
    const database = join(root, 'state.sqlite'), wal = database + '-wal';
    await writeFile(database, 'database'); await writeFile(wal, 'wal');
    for (const [fd, path, flags] of [[7, database, '0100000'], [8, database, '0100002'], [9, wal, '0102001']] as const) {
      await symlink(path, join(proc, '200/fd', String(fd)));
      await put(`200/fdinfo/${fd}`, `pos:\t0\nflags:\t${flags}\n`);
    }
    // Kernel objects are not regular on-disk dependencies.
    await symlink('socket:[123]', join(proc, '200/fd/10'));
    await symlink('anon_inode:[eventpoll]', join(proc, '200/fd/11'));
    await symlink('anon_inode:inotify', join(proc, '200/fd/12'));
    const snapshot = await captureCarryRuntimeSnapshot(100);
    expect(snapshot.artifacts.map(a => a.filePath).sort()).toEqual([...files, database, wal].sort());
    expect(snapshot.writableOpenFiles).toEqual([database, wal]);
    expect(snapshot.processes[1].openFiles).toEqual([
      expect.objectContaining({ fd: 7, filePath: database, access: 'read' }),
      expect.objectContaining({ fd: 8, filePath: database, access: 'read-write' }),
      expect.objectContaining({ fd: 9, filePath: wal, access: 'write' }),
    ]);
    expect(snapshot.writableSharedFiles).toEqual([]);
    await expect(recheckCarryRuntimeSnapshot(snapshot)).resolves.toBeUndefined();
    await put('200/fdinfo/7', 'pos:\t20\nflags:\t0100000\n');
    await expect(recheckCarryRuntimeSnapshot(snapshot)).resolves.toBeUndefined();
    await put('200/fdinfo/8', 'pos:\t0\nflags:\t0100000\n');
    await expect(recheckCarryRuntimeSnapshot(snapshot)).rejects.toThrow('changed after capture');
  });

  it.each(['missing-flags', 'invalid-flags', 'deleted', 'replaced', 'missing-table', 'bad-fd', 'too-many-fds', 'closed']) (
    'refuses incomplete or changing descriptor observation: %s', async fault => {
      const { files, put, proc } = await fixture();
      await symlink(files[2], join(proc, '200/fd/7'));
      await put('200/fdinfo/7', 'pos:\t0\nflags:\t0100000\n');
      if (fault === 'missing-flags') await put('200/fdinfo/7', 'pos:\t0\n');
      if (fault === 'invalid-flags') await put('200/fdinfo/7', 'flags:\t8\n');
      if (fault === 'deleted') {
        await rm(join(proc, '200/fd/7')); await symlink(files[2] + ' (deleted)', join(proc, '200/fd/7'));
      }
      if (fault === 'replaced') {
        // The descriptor keeps the old inode even when its name resolves anew.
        const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const old = await original.stat(files[2], { bigint: true });
        const delegated = vi.mocked(fsPromises.stat).getMockImplementation()!;
        vi.mocked(fsPromises.stat).mockImplementation(((path: string, options: unknown) =>
          path === '/proc/200/fd/7' ? Promise.resolve({ ...old, ino: old.ino + 1n, isFile: () => true }) : delegated(path, options as never)) as typeof original.stat);
      }
      if (fault === 'missing-table') await rm(join(proc, '200/fd'), { recursive: true });
      if (fault === 'bad-fd' || fault === 'too-many-fds') {
        const delegated = vi.mocked(fsPromises.readdir).getMockImplementation()!;
        vi.mocked(fsPromises.readdir).mockImplementation(((path: string) => path === '/proc/200/fd'
          ? Promise.resolve(fault === 'bad-fd' ? ['x'] : Array.from({ length: 4097 }, (_, i) => String(i)))
          : delegated(path, undefined as never)) as typeof fsPromises.readdir);
      }
      if (fault === 'closed') {
        const snapshot = await captureCarryRuntimeSnapshot(100);
        await rm(join(proc, '200/fd/7'));
        await expect(recheckCarryRuntimeSnapshot(snapshot)).rejects.toThrow('changed after capture');
      } else await expect(captureCarryRuntimeSnapshot(100)).rejects.toThrow();
    });

  it.each(['bad-parent', 'missing-child', 'cycle', 'deleted', 'replaced-file', 'partial-maps', 'malformed-maps',
    'empty-maps', 'bad-boot', 'oversized-record', 'no-threads', 'escaped-path', 'missing-executable',
    'duplicate-path-inode', 'too-many-children', 'bad-child'])('refuses %s runtime observations', async fault => {
    const { files, put, proc, mapping } = await fixture();
    if (fault === 'bad-parent') await put('200/stat', procStat(200, 9));
    if (fault === 'missing-child') await rm(join(proc, '200'), { recursive: true });
    if (fault === 'cycle') await put('200/task/200/children', '100');
    if (fault === 'deleted') await put('200/maps', (await mapping(files[1], 1)).trimEnd() + ' (deleted)\n');
    if (fault === 'replaced-file') { await rename(files[1], files[1] + '.old'); await writeFile(files[1], 'replacement'); }
    if (fault === 'partial-maps') await put('200/maps', (await mapping(files[1], 1)).trimEnd());
    if (fault === 'malformed-maps') await put('200/maps', 'not a mapping\n');
    if (fault === 'empty-maps') await put('200/maps', '');
    if (fault === 'bad-boot') await put('sys/kernel/random/boot_id', 'unknown');
    if (fault === 'oversized-record') await put('200/maps', 'x'.repeat(2 * 1024 * 1024 + 1));
    if (fault === 'no-threads') await rm(join(proc, '200/task/200'), { recursive: true });
    if (fault === 'escaped-path') await put('200/maps', '1000-1fff r-xp 0000 00:00 1 /ambiguous\\012name\n');
    if (fault === 'missing-executable') await put('200/maps', await mapping(files[2], 1));
    if (fault === 'duplicate-path-inode') await put('200/maps', await mapping(files[1], 1) + `2000-2fff r-xp 0000 00:00 0 ${files[1]}\n`);
    if (fault === 'too-many-children') await put('200/task/200/children', Array.from({ length: 65 }, (_, i) => i + 300).join(' '));
    if (fault === 'bad-child') await put('200/task/200/children', 'not-a-pid');
    await expect(captureCarryRuntimeSnapshot(100)).rejects.toThrow();
  });

  it('rejects PID reuse and a new child at recheck without replacing the frozen observation', async () => {
    const { put } = await fixture();
    const snapshot = await captureCarryRuntimeSnapshot(100);
    await put('200/stat', procStat(200, 100, '8'));
    await expect(recheckCarryRuntimeSnapshot(snapshot)).rejects.toThrow('changed after capture');
    expect(snapshot.processes[1].identity).toBe(`linux:${boot}:7`);
    await put('200/stat', procStat(200, 100));
    await put('200/task/200/children', '300');
    await expect(recheckCarryRuntimeSnapshot(snapshot)).rejects.toThrow();
  });

  it('detects a process changing between the two inventory passes', async () => {
    const { put } = await fixture();
    const open = vi.mocked(fsPromises.open).getMockImplementation()!;
    let statReads = 0;
    vi.mocked(fsPromises.open).mockImplementation(async (path, ...args) => {
      if (path === '/proc/200/stat' && ++statReads === 3) await put('200/stat', procStat(200, 100, '8'));
      return open(path, ...args);
    });
    await expect(captureCarryRuntimeSnapshot(100)).rejects.toThrow('changed during observation');
  });

  it.each([0, -1, 1.5, NaN, Infinity])('refuses an invalid root pid %s', async pid => {
    await expect(captureCarryRuntimeSnapshot(pid)).rejects.toThrow('live Linux peer PID');
  });
});

describe('frozen carry artifact bindings', () => {
  async function fixture() {
    const filePath = join(root, 'task.json');
    await writeFile(filePath, '{"task":"offline fixture"}');
    const config = { config: { model: 'fixture' }, layers: [] };
    const peer = { request: vi.fn(async (frame: Record<string, unknown>) => frame.method === 'config/read'
      ? config : { data: [], nextCursor: null }), send: vi.fn(), close: vi.fn(async () => {}),
    done: Promise.resolve(), pid: () => 1 };
    const configuration = await captureCarryNativeConfiguration(peer, { threadId: 'fixture-thread', cwd: root, servers: [] });
    return { peer, config, input: { protocolRef: 'fixture-only:no-inference', configuration,
      artifacts: [{ id: 'task', filePath, maxBytes: 200_000 }] } };
  }

  async function scriptFixture() {
    const { input, peer } = await fixture();
    const sources = {
      entry: ['import "./dep.mjs";', 'import "node:fs";', 'import(computed);',
        `import "https://private.invalid/${NEVER_EMIT_MARKER}";`, 'require("./leaf.cjs");',
        'import "./missing.mjs";', 'import "./outside.mjs";',
        'const text = "import(\'never-emit-me\')";'].join('\n'),
      dep: 'export { value } from "./entry.mjs";',
      leaf: 'module.exports = 1;',
    };
    for (const [id, source] of Object.entries(sources)) {
      const filePath = join(root, `${id}.${id === 'leaf' ? 'cjs' : 'mjs'}`);
      await writeFile(filePath, source);
      input.artifacts.push({ id, filePath, maxBytes: 200_000 });
    }
    await writeFile(join(root, 'outside.mjs'), 'export const outside = true;');
    return { peer, input: { ...input, scriptArtifactIds: ['entry', 'dep'] } };
  }

  it('binds AST import sites from frozen bytes and keeps every unsupported boundary explicit', async () => {
    const { input, peer } = await scriptFixture();
    const manifest = await captureCarryArtifactManifest(input);
    expect(manifest.scriptCensus).toMatchObject({ evidenceKind: 'selected-static-import-sites',
      scriptArtifactIds: ['dep', 'entry'], runtimeClosureEstablished: false });
    expect(manifest.scriptCensus!.sites.map(({ artifactId, line, disposition, targetArtifactId }) =>
      ({ artifactId, line, disposition, targetArtifactId }))).toEqual([
      { artifactId: 'dep', line: 1, disposition: 'bound-script-candidate', targetArtifactId: 'entry' },
      { artifactId: 'entry', line: 1, disposition: 'bound-script-candidate', targetArtifactId: 'dep' },
      { artifactId: 'entry', line: 2, disposition: 'node-builtin', targetArtifactId: undefined },
      { artifactId: 'entry', line: 3, disposition: 'computed-specifier', targetArtifactId: undefined },
      { artifactId: 'entry', line: 4, disposition: 'external-module', targetArtifactId: undefined },
      { artifactId: 'entry', line: 5, disposition: 'unscanned-artifact-candidate', targetArtifactId: 'leaf' },
      { artifactId: 'entry', line: 6, disposition: 'unresolved-relative', targetArtifactId: undefined },
      { artifactId: 'entry', line: 7, disposition: 'unbound-relative', targetArtifactId: undefined },
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/never-emit-me|private\.invalid|import\(|module\.exports/);
    await expect(recheckCarryArtifactManifest(manifest, peer)).resolves.toBeUndefined();
    await writeFile(join(root, 'missing.mjs'), 'export const late = true;');
    await expect(recheckCarryArtifactManifest(manifest, peer)).rejects.toThrow('manifest metadata');
  });

  it('does not arbitrarily bind duplicate artifact paths or treat unscanned leaves as a closed graph', async () => {
    const { input } = await scriptFixture();
    input.artifacts.push({ ...input.artifacts.find(artifact => artifact.id === 'dep')!, id: 'dep-alias' });
    const manifest = await captureCarryArtifactManifest(input);
    expect(manifest.scriptCensus!.sites.find(site => site.artifactId === 'entry' && site.line === 1))
      .toMatchObject({ disposition: 'ambiguous-relative' });
    expect(manifest.scriptCensus!.runtimeClosureEstablished).toBe(false);
  });

  it('freezes transitive relative candidates, deduplicates cycles and keeps package/data gaps explicit', async () => {
    const { input, peer } = await scriptFixture();
    await writeFile(join(root, 'outside.mjs'), 'export { nested } from "./nested.mjs";');
    await writeFile(join(root, 'nested.mjs'), 'import "./outside.mjs"; import "./value.json"; export const nested = 1;');
    await writeFile(join(root, 'value.json'), '{"private":"never-emit-me"}');
    const manifest = await captureCarryArtifactManifest({ ...input, relativeScriptRoots: ['entry'] });
    const census = manifest.scriptCensus!, walk = census.relativeTraversal!;
    expect(walk.artifacts.map(artifact => basename(artifact.filePath)).sort())
      .toEqual(['nested.mjs', 'outside.mjs', 'value.json']);
    expect(walk.scannedArtifactIds).toHaveLength(5); // entry, dep, leaf, outside, nested
    expect(census.sites.some(site => site.disposition === 'unbound-relative')).toBe(false);
    expect(census.sites.map(site => site.disposition)).toEqual(expect.arrayContaining([
      'computed-specifier', 'external-module', 'unresolved-relative', 'unscanned-artifact-candidate',
    ]));
    expect(census.runtimeClosureEstablished).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain('never-emit-me');
    await expect(recheckCarryArtifactManifest(manifest, peer)).resolves.toBeUndefined();
    await writeFile(join(root, 'nested.mjs'), 'export const nested = 2;');
    await expect(recheckCarryArtifactManifest(manifest, peer)).rejects.toThrow('manifest metadata');
  });

  it('detects same-byte retargeting of a discovered dependency symlink', async () => {
    const { input, peer } = await scriptFixture();
    await writeFile(join(root, 'target-one.mjs'), 'export const stable = 1;');
    await writeFile(join(root, 'target-two.mjs'), 'export const stable = 1;');
    await rm(join(root, 'outside.mjs'));
    await symlink(join(root, 'target-one.mjs'), join(root, 'outside.mjs'));
    const manifest = await captureCarryArtifactManifest({ ...input, relativeScriptRoots: ['entry'] });
    await rm(join(root, 'outside.mjs'));
    await symlink(join(root, 'target-two.mjs'), join(root, 'outside.mjs'));
    await expect(recheckCarryArtifactManifest(manifest, peer)).rejects.toThrow('manifest metadata');
  });

  it('separates same-byte artifact metadata drift from content changes', async () => {
    const { input, peer } = await fixture();
    const artifactPath = input.artifacts[0].filePath;
    const beforeStat = await fsPromises.stat(artifactPath);
    const content = await readFile(artifactPath, 'utf8');
    const manifest = await captureCarryArtifactManifest(input);
    await fsPromises.chmod(artifactPath, (beforeStat.mode ^ 0o200) & 0o7777);
    try {
      const failure = await recheckCarryArtifactManifest(manifest, peer).catch(error => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      const observationsStart = message.indexOf('observations=') + 'observations='.length;
      const observations = JSON.parse(message.slice(observationsStart, message.lastIndexOf(')')));
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ id: 'task', fields: ['identity'],
        before: { sha256: manifest.artifacts[0].sha256 }, after: { sha256: manifest.artifacts[0].sha256 } });
      expect(observations[0].before.identity).not.toEqual(observations[0].after.identity);
      expect(await readFile(artifactPath, 'utf8')).toBe(content);
    } finally {
      await fsPromises.chmod(artifactPath, beforeStat.mode & 0o7777);
    }
  });

  it.each([[], ['entry', 'entry'], ['leaf'], ['absent']].map(relativeScriptRoots => ({ relativeScriptRoots })))
    ('refuses invalid relative traversal roots $relativeScriptRoots', async ({ relativeScriptRoots }) => {
      const { input } = await scriptFixture();
      await expect(captureCarryArtifactManifest({ ...input, relativeScriptRoots })).rejects.toThrow('unique selected script roots');
    });

  it('refuses a partial traversal when the frozen artifact bound is exhausted', async () => {
    const { input } = await scriptFixture();
    for (let index = input.artifacts.length; index < 256; index++) {
      input.artifacts.push({ ...input.artifacts[0], id: `unrelated-${index}` });
    }
    await expect(captureCarryArtifactManifest({ ...input, relativeScriptRoots: ['entry'] }))
      .rejects.toThrow('relative census exceeds artifact bound');
  });

  it.each([[], ['entry', 'entry'], ['missing']].map(scriptArtifactIds => ({ scriptArtifactIds })))
    ('refuses invalid selected script ids $scriptArtifactIds', async ({ scriptArtifactIds }) => {
    const { input } = await scriptFixture();
    await expect(captureCarryArtifactManifest({ ...input, scriptArtifactIds })).rejects.toThrow('unique declared script');
  });

  it('resolves extensionless CLI links and their relative imports from the frozen real script path', async () => {
    const { input, peer } = await scriptFixture();
    const entry = input.artifacts.find(artifact => artifact.id === 'entry')!;
    const original = entry.filePath, alias = join(root, 'bin', 'cli');
    await mkdir(join(root, 'bin')); await symlink(original, alias); entry.filePath = alias;
    const manifest = await captureCarryArtifactManifest(input);
    expect(manifest.artifacts.find(artifact => artifact.id === 'entry'))
      .toMatchObject({ filePath: alias, resolvedPath: original });
    expect(manifest.scriptCensus!.sites.find(site => site.artifactId === 'entry' && site.line === 1))
      .toMatchObject({ disposition: 'bound-script-candidate', targetArtifactId: 'dep' });
    await expect(recheckCarryArtifactManifest(manifest, peer)).resolves.toBeUndefined();
  });

  it('refuses a declared non-script instead of guessing its format', async () => {
    const { input } = await scriptFixture();
    await expect(captureCarryArtifactManifest({ ...input, scriptArtifactIds: ['task'] }))
      .rejects.toThrow('supported script format');
  });

  it('refuses syntax errors instead of accepting a partial AST as a dependency census', async () => {
    const { input } = await scriptFixture();
    await writeFile(join(root, 'entry.mjs'), 'import { from "bad";');
    await expect(captureCarryArtifactManifest(input)).rejects.toThrow('cannot parse artifact entry');
  });

  it('bounds selected source bytes and import sites before accepting a census', async () => {
    const { input } = await scriptFixture();
    input.artifacts.find(artifact => artifact.id === 'entry')!.maxBytes = 5 * 1024 * 1024;
    await writeFile(join(root, 'entry.mjs'), ' '.repeat(4 * 1024 * 1024 + 1));
    await expect(captureCarryArtifactManifest(input)).rejects.toThrow('source-byte bound');
    await writeFile(join(root, 'entry.mjs'), 'import "node:fs";\n'.repeat(4097));
    await expect(captureCarryArtifactManifest(input)).rejects.toThrow('import-site bound');
  });

  it('hashes complete binary/text bytes, binds roles and config, and roundtrips without returning contents', async () => {
    const { input, peer } = await fixture();
    const bytes = Buffer.alloc(131_079, 0xf0); bytes[131_078] = 0x17;
    await writeFile(input.artifacts[0].filePath, bytes);
    input.artifacts.push({ id: 'runtime', filePath: process.execPath, maxBytes: 512 * 1024 * 1024 });
    const manifest = await captureCarryArtifactManifest(input);
    const task = manifest.artifacts.find(a => a.id === 'task')!;
    expect(task.bytes).toBe(bytes.length);
    expect(task.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(manifest.artifacts.find(a => a.id === 'runtime')!.sha256).toBe(
      createHash('sha256').update(await readFile(process.execPath)).digest('hex'));
    expect(manifest.evidenceKind).toBe('observation-only');
    expect(task).not.toHaveProperty('contents');
    await expect(recheckCarryArtifactManifest(JSON.parse(JSON.stringify(manifest)), peer)).resolves.toBeUndefined();
    input.artifacts.reverse();
    expect((await captureCarryArtifactManifest(input)).sha256).toBe(manifest.sha256);
    input.protocolRef = 'different-protocol';
    expect((await captureCarryArtifactManifest(input)).sha256).not.toBe(manifest.sha256);
    expect(peer.send).not.toHaveBeenCalled();
  });

  it.each(['content', 'append', 'truncate', 'replace', 'missing', 'config', 'binding'])('rejects %s drift', async change => {
    const { input, peer, config } = await fixture();
    const manifest = await captureCarryArtifactManifest(input), path = input.artifacts[0].filePath;
    if (change === 'content') await writeFile(path, '{"task":"CHANGED fixture"}');
    if (change === 'append') await appendFile(path, '\nchanged');
    if (change === 'truncate') await writeFile(path, 'x');
    if (change === 'replace') {
      await writeFile(path + '.replacement', await readFile(path));
      await rename(path + '.replacement', path);
    }
    if (change === 'missing') await rm(path);
    if (change === 'config') config.config.model = 'different-model';
    if (change === 'binding') manifest.artifacts[0].sha256 = '0'.repeat(64);
    await expect(recheckCarryArtifactManifest(manifest, peer)).rejects.toThrow();
  });

  it('rejects a link retarget even when both files have the same bytes', async () => {
    const { input, peer } = await fixture();
    const original = input.artifacts[0].filePath, link = join(root, 'linked-task');
    await symlink(original, link);
    input.artifacts[0].filePath = link;
    const manifest = await captureCarryArtifactManifest(input);
    await writeFile(original + '.twin', await readFile(original));
    await rm(link); await symlink(original + '.twin', link);
    await expect(recheckCarryArtifactManifest(manifest, peer)).rejects.toThrow('changed after manifest freeze');
  });

  it('does not serialize caller-added raw config or artifact content', async () => {
    const { input } = await fixture();
    Object.assign(input.configuration, { rawConfig: 'private-bearer-marker' });
    Object.assign(input.artifacts[0], { contents: 'private-artifact-marker' });
    const json = JSON.stringify(await captureCarryArtifactManifest(input));
    expect(json).not.toContain('private-bearer-marker');
    expect(json).not.toContain('private-artifact-marker');
  });

  it('pins the caller inputs before its first asynchronous read', async () => {
    const { input, peer } = await fixture();
    const pending = captureCarryArtifactManifest(input);
    input.protocolRef = 'mutated'; input.artifacts.length = 0; input.configuration.threadId = 'mutated';
    const manifest = await pending;
    expect(manifest.protocolRef).toBe('fixture-only:no-inference');
    expect(manifest.configuration.threadId).toBe('fixture-thread');
    expect(manifest.artifacts).toHaveLength(1);
    const recheck = recheckCarryArtifactManifest(manifest, peer);
    manifest.artifacts.length = 0;
    await expect(recheck).resolves.toBeUndefined();
  });

  it.each(['empty', 'directory', 'missing', 'oversized', 'duplicate', 'relative', 'zero-cap', 'fractional-cap',
    'unbounded-cap', 'empty-set', 'empty-protocol', 'missing-config'])('refuses %s artifacts before accepting a binding', async fault => {
    const { input } = await fixture();
    const artifact = input.artifacts[0];
    if (fault === 'empty') await writeFile(artifact.filePath, '');
    if (fault === 'directory') artifact.filePath = root;
    if (fault === 'missing') artifact.filePath += '.missing';
    if (fault === 'oversized') artifact.maxBytes = 1;
    if (fault === 'duplicate') input.artifacts.push({ ...artifact });
    if (fault === 'relative') artifact.filePath = 'relative';
    if (fault === 'zero-cap') artifact.maxBytes = 0;
    if (fault === 'fractional-cap') artifact.maxBytes = 1.5;
    if (fault === 'unbounded-cap') artifact.maxBytes = Infinity;
    if (fault === 'empty-set') input.artifacts.length = 0;
    if (fault === 'empty-protocol') input.protocolRef = ' ';
    if (fault === 'missing-config') input.configuration.configSha256 = '';
    await expect(captureCarryArtifactManifest(input)).rejects.toThrow();
  });

  it('detects a write during a descriptor read and closes the descriptor', async () => {
    const { input } = await fixture();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const closed = vi.fn();
    vi.mocked(fsPromises.open).mockImplementationOnce(async (...args) => {
      const fh = await original.open(...args), read = fh.read.bind(fh), close = fh.close.bind(fh);
      vi.spyOn(fh, 'close').mockImplementation(async () => { closed(); await close(); });
      vi.spyOn(fh, 'read').mockImplementationOnce((async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        await appendFile(input.artifacts[0].filePath, 'changed during read');
        return result;
      }) as typeof fh.read);
      return fh;
    });
    await expect(captureCarryArtifactManifest(input)).rejects.toThrow('changed during capture');
    expect(closed).toHaveBeenCalledOnce();
  });

  async function dependencyFixture() {
    const fixtureResult = await fixture();
    for (const id of ['launcher', 'checker', 'shared']) {
      const filePath = join(root, id); await writeFile(filePath, `offline ${id}`);
      fixtureResult.input.artifacts.push({ id, filePath, maxBytes: 200_000 });
    }
    const dependencyScope: CarryDependencyScope = { recipeSha256: createCarryTrialRecipe().sha256,
      roots: [{ role: 'launcher', artifactIds: ['launcher'] }, { role: 'task', artifactIds: ['task'] }],
      nodes: [{ artifactId: 'launcher', dependsOn: ['checker', 'shared'] },
        { artifactId: 'checker', dependsOn: ['shared'] }, { artifactId: 'shared', dependsOn: ['checker'] },
        { artifactId: 'task', dependsOn: [] }],
      unresolved: ['default-run plugin and shell dependencies', 'transient and unloaded native dependencies'] };
    return { ...fixtureResult, input: { ...fixtureResult.input, dependencyScope } };
  }

  it('binds the recipe, cyclic dependency declarations and explicit missing scope without asserting completeness', async () => {
    const { input, peer } = await dependencyFixture();
    const manifest = await captureCarryArtifactManifest(input);
    expect(manifest.dependencyScope).toMatchObject({ evidenceKind: 'declaration-only',
      recipeSha256: createCarryTrialRecipe().sha256, unresolved: input.dependencyScope.unresolved,
      missingRoles: ['native-runtime', 'scripts', 'seed', 'source', 'pricing', 'checker', 'instrument'] });
    expect(manifest.dependencyScope!.nodes.find(node => node.artifactId === 'checker')!.dependsOn).toEqual(['shared']);
    await expect(recheckCarryArtifactManifest(JSON.parse(JSON.stringify(manifest)), peer)).resolves.toBeUndefined();
    expect(peer.send).not.toHaveBeenCalled();
    input.artifacts.reverse(); input.dependencyScope.roots.reverse(); input.dependencyScope.nodes.reverse();
    input.dependencyScope.nodes.forEach(node => node.dependsOn.reverse()); input.dependencyScope.unresolved.reverse();
    expect((await captureCarryArtifactManifest(input)).sha256).toBe(manifest.sha256);
    input.dependencyScope.unresolved.push('additional unmeasured input');
    expect((await captureCarryArtifactManifest(input)).sha256).not.toBe(manifest.sha256);
  });

  it.each(['recipe', 'missing-node', 'duplicate-node', 'unknown-node', 'dangling-edge', 'duplicate-edge',
    'unreachable', 'unknown-root', 'duplicate-root', 'missing-roots', 'empty-root', 'duplicate-root-artifact',
    'invalid-role', 'empty-residue', 'duplicate-residue', 'oversized-residue'])('rejects %s dependency declarations before file reads', async fault => {
    const { input } = await dependencyFixture();
    const scope = input.dependencyScope;
    if (fault === 'recipe') scope.recipeSha256 = '0'.repeat(64);
    if (fault === 'missing-node') scope.nodes.pop();
    if (fault === 'duplicate-node') scope.nodes[3] = scope.nodes[0];
    if (fault === 'unknown-node') scope.nodes[3].artifactId = 'missing';
    if (fault === 'dangling-edge') scope.nodes[0].dependsOn.push('missing');
    if (fault === 'duplicate-edge') scope.nodes[0].dependsOn.push('checker');
    if (fault === 'unreachable') scope.nodes[0].dependsOn = [];
    if (fault === 'unknown-root') scope.roots[0].artifactIds = ['missing'];
    if (fault === 'duplicate-root') scope.roots.push(scope.roots[0]);
    if (fault === 'missing-roots') scope.roots = [];
    if (fault === 'empty-root') scope.roots[0].artifactIds = [];
    if (fault === 'duplicate-root-artifact') scope.roots[0].artifactIds.push('launcher');
    if (fault === 'invalid-role') Object.assign(scope.roots[0], { role: 'invented' });
    if (fault === 'empty-residue') scope.unresolved.push(' ');
    if (fault === 'duplicate-residue') scope.unresolved.push(scope.unresolved[0]);
    if (fault === 'oversized-residue') scope.unresolved.push('x'.repeat(2001));
    vi.mocked(fsPromises.open).mockClear();
    await expect(captureCarryArtifactManifest(input)).rejects.toThrow('carry dependency scope');
    expect(fsPromises.open).not.toHaveBeenCalled();
  });

  it('pins graph inputs and strips caller-added raw fields', async () => {
    const { input, peer } = await dependencyFixture();
    Object.assign(input.dependencyScope, { privateConfig: 'private-graph-marker' });
    Object.assign(input.dependencyScope.nodes[0], { sourceText: 'private-node-marker' });
    Object.assign(input.dependencyScope.roots[0], { rawConfig: 'private-root-marker' });
    const pending = captureCarryArtifactManifest(input);
    input.dependencyScope.nodes[0].dependsOn.length = 0; input.dependencyScope.unresolved.length = 0;
    const manifest = await pending;
    expect(manifest.dependencyScope!.unresolved).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain('private-');
    const recheck = recheckCarryArtifactManifest(manifest, peer);
    manifest.dependencyScope!.nodes.length = 0;
    await expect(recheck).resolves.toBeUndefined();
  });

  it('recomputes missing roles instead of trusting even a rehashed declaration', async () => {
    const { input, peer } = await dependencyFixture();
    const manifest = await captureCarryArtifactManifest(input);
    manifest.dependencyScope!.missingRoles = [];
    const { sha256: _oldHash, ...body } = manifest;
    manifest.sha256 = createHash('sha256').update(canonicalJson(body)).digest('hex');
    await expect(recheckCarryArtifactManifest(manifest, peer)).rejects.toThrow('changed after manifest freeze');
  });

  it('keeps a declaration-only boundary when the caller assigns every role and reports no residue', async () => {
    const { input, peer } = await dependencyFixture();
    const partial = await captureCarryArtifactManifest(input);
    for (const role of partial.dependencyScope!.missingRoles) {
      input.dependencyScope.roots.push({ role, artifactIds: ['launcher'] });
    }
    input.dependencyScope.unresolved = [];
    const manifest = await captureCarryArtifactManifest(input);
    expect(manifest.dependencyScope).toMatchObject({ evidenceKind: 'declaration-only', missingRoles: [], unresolved: [] });
    expect(manifest).not.toHaveProperty('admitted');
    expect(manifest).not.toHaveProperty('complete');
    await expect(recheckCarryArtifactManifest(manifest, peer)).resolves.toBeUndefined();
    expect(peer.send).not.toHaveBeenCalled();
  });

  it.each(['edge', 'residue', 'role', 'recipe'])('rejects changed %s in a serialized dependency binding', async change => {
    const { input, peer } = await dependencyFixture();
    const manifest = await captureCarryArtifactManifest(input);
    if (change === 'edge') manifest.dependencyScope!.nodes[0].dependsOn = [];
    if (change === 'residue') manifest.dependencyScope!.unresolved = [];
    if (change === 'role') manifest.dependencyScope!.missingRoles = [];
    if (change === 'recipe') manifest.dependencyScope!.recipeSha256 = '0'.repeat(64);
    await expect(recheckCarryArtifactManifest(manifest, peer)).rejects.toThrow('binding is invalid');
  });
});

describe('native carry configuration manifest component', () => {
  const fixture = () => {
    const config = { config: { model: 'fixture', secret: NEVER_EMIT_MARKER }, layers: [{ name: 'fixture-layer' }] };
    const server = (name: string) => ({ name, authStatus: 'bearerToken', runtimeStatus: 'connected', toolsError: null,
      tools: { read: { name: 'read', inputSchema: { type: 'object' }, description: 'read-only fixture' } } });
    const pages: Record<string, unknown>[] = [{ data: [server('a')], nextCursor: 'page-2' }, { data: [server('b')], nextCursor: null }];
    let page = 0;
    const peer = { request: vi.fn(async (frame: Record<string, unknown>) => {
      if (frame.method === 'config/read') { page = 0; return config; }
      return pages[page++] ?? pages.at(-1)!;
    }), send: vi.fn(), close: vi.fn(async () => {}), done: Promise.resolve(), pid: () => 1 };
    const scope = { threadId: 'native-thread', cwd: '/fixture',
      servers: ['a', 'b'].map(name => ({ name, authStatus: 'bearerToken', tools: ['read'] })) };
    return { config, pages, peer, scope };
  };

  it('reads every inventory page, hashes full configuration, and returns no credential', async () => {
    const { peer, scope } = fixture();
    const result = await captureCarryNativeConfiguration(peer, scope);
    expect(result.servers).toEqual(scope.servers);
    expect(result.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.toolInventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(NEVER_EMIT_MARKER);
    expect(peer.request).toHaveBeenNthCalledWith(3, { method: 'mcpServerStatus/list', params: {
      threadId: 'native-thread', detail: 'toolsAndAuthOnly', cursor: 'page-2',
    } });
    await expect(recheckCarryNativeConfiguration(peer, result)).resolves.toBeUndefined();
    expect(peer.send).not.toHaveBeenCalled();
  });

  it.each(['credential', 'layer', 'schema', 'description'])('detects %s drift even when names remain identical', async change => {
    const { peer, scope, config, pages } = fixture();
    const before = await captureCarryNativeConfiguration(peer, scope);
    if (change === 'credential') config.config.secret = 'rotated';
    if (change === 'layer') config.layers[0].name = 'changed-layer';
    const server = (pages[0].data as Array<{ tools: { read: { inputSchema: { type: string }; description: string } } }>)[0];
    if (change === 'schema') server.tools.read.inputSchema.type = 'string';
    if (change === 'description') server.tools.read.description = 'different contract';
    await expect(recheckCarryNativeConfiguration(peer, before)).rejects.toThrow('configuration changed');
  });

  it('ignores object key and server page order but retains array semantics', async () => {
    const { peer, scope, config, pages } = fixture();
    const before = await captureCarryNativeConfiguration(peer, scope);
    config.config = { secret: config.config.secret, model: config.config.model };
    [pages[0].data, pages[1].data] = [pages[1].data, pages[0].data];
    await expect(recheckCarryNativeConfiguration(peer, before)).resolves.toBeUndefined();
    config.layers.push({ name: 'second' });
    const twoLayers = await captureCarryNativeConfiguration(peer, scope);
    config.layers.reverse();
    await expect(recheckCarryNativeConfiguration(peer, twoLayers)).rejects.toThrow('configuration changed');
  });

  it.each(['missing-config', 'missing-layers', 'missing-cursor', 'repeated-cursor', 'invalid-cursor', 'missing-server',
    'duplicate-server', 'unexpected-server', 'disconnected', 'tools-error', 'wrong-auth', 'missing-tool', 'extra-tool',
    'missing-schema', 'wrong-tool-name', 'bad-scope'])('refuses %s as incomplete or mismatched evidence', async fault => {
    const { peer, scope, config, pages } = fixture();
    const server = (pages[0].data as Array<Record<string, unknown>>)[0];
    const tools = server.tools as Record<string, Record<string, unknown>>;
    if (fault === 'missing-config') (config as Record<string, unknown>).config = null;
    if (fault === 'missing-layers') (config as Record<string, unknown>).layers = null;
    if (fault === 'missing-cursor') delete pages[0].nextCursor;
    if (fault === 'repeated-cursor') { pages[1].data = []; pages[1].nextCursor = 'page-2'; }
    if (fault === 'invalid-cursor') pages[0].nextCursor = '';
    if (fault === 'missing-server') pages[1].data = [];
    if (fault === 'duplicate-server') pages[1].data = [server];
    if (fault === 'unexpected-server') server.name = 'unlisted';
    if (fault === 'disconnected') server.runtimeStatus = 'starting';
    if (fault === 'tools-error') server.toolsError = 'unavailable';
    if (fault === 'wrong-auth') server.authStatus = 'notLoggedIn';
    if (fault === 'missing-tool') delete tools.read;
    if (fault === 'extra-tool') tools.write = { name: 'write', inputSchema: {} };
    if (fault === 'missing-schema') delete tools.read.inputSchema;
    if (fault === 'wrong-tool-name') tools.read.name = 'write';
    if (fault === 'bad-scope') scope.servers.push(scope.servers[0]);
    await expect(captureCarryNativeConfiguration(peer, scope)).rejects.toThrow(/carry/);
  });

  it('bounds an endless inventory without accepting a partial manifest', async () => {
    const { peer, scope } = fixture();
    let page = 0;
    peer.request.mockImplementation(async frame => frame.method === 'config/read'
      ? { config: {}, layers: [] } as never : { data: [], nextCursor: `page-${++page}` });
    await expect(captureCarryNativeConfiguration(peer, scope)).rejects.toThrow('page bound');
    expect(page).toBe(64);
  });

  it('accepts a measured empty inventory only when no servers are required', async () => {
    const { peer, scope, pages } = fixture();
    scope.servers = []; pages[0] = { data: [], nextCursor: null };
    expect((await captureCarryNativeConfiguration(peer, scope)).servers).toEqual([]);
  });

  it('pins the allowlist before awaiting native reads', async () => {
    const { peer, scope, pages } = fixture();
    const pending = captureCarryNativeConfiguration(peer, scope);
    scope.servers[0].name = 'new-server';
    (pages[0].data as Array<Record<string, unknown>>)[0].name = 'new-server';
    await expect(pending).rejects.toThrow('frozen allowlist');
  });
});

describe('completed native carry source capture', () => {
  const setup = async () => {
    const entries = [
      { type: 'session_meta', payload: { id: 'native-thread' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'native-turn' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'native-turn' } },
    ];
    const path = join(root, 'native.jsonl');
    const body = () => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path, body());
    const thread = { id: 'native-thread', path, forkedFromId: null as string | null, status: { type: 'idle' },
      turns: [{ id: 'native-turn', status: 'completed', error: null, itemsView: 'full', items: [] }] };
    const peer = { request: vi.fn(async (_request: RpcFrame) => ({ thread })), send: vi.fn(), close: vi.fn(async () => {}),
      done: Promise.resolve(), pid: () => 1 };
    return { entries, path, body, peer, thread };
  };
  const forkSetup = async () => {
    const fixture = await setup();
    const parentPath = join(root, 'parent.jsonl');
    const parentBody = [
      { type: 'session_meta', payload: { id: 'parent-thread' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'parent-turn' } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(parentPath, parentBody);
    Object.assign(fixture.entries[0].payload, { forked_from_id: 'parent-thread' });
    fixture.thread.forkedFromId = 'parent-thread';
    fixture.thread.turns.unshift({ ...fixture.thread.turns[0], id: 'parent-turn' });
    await writeFile(fixture.path, fixture.body());
    const parent = { ...fixture.thread, id: 'parent-thread', path: parentPath, forkedFromId: null as string | null,
      turns: [{ ...fixture.thread.turns[0], id: 'parent-turn' }] };
    fixture.peer.request.mockImplementation(async request => ({
      thread: (request.params as RpcFrame).threadId === 'parent-thread' ? parent : fixture.thread,
    }));
    return { ...fixture, parent, parentPath, parentBody };
  };
  it('binds the native parent chain as well as the child bytes', async () => {
    const { peer, parentPath, parentBody } = await forkSetup();
    const source = await captureCompletedCarrySource(peer, 'native-thread', 'native-turn');
    expect(source).toMatchObject({ forkedFromId: 'parent-thread', ancestors: [
      { threadId: 'parent-thread', turnId: 'parent-turn', filePath: parentPath, forkedFromId: null },
    ] });
    expect(source.ancestors[0].snapshot.bytes.toString()).toBe(parentBody);
    await expect(recheckCarrySourceSnapshot(source)).resolves.toBeUndefined();
  });
  const preflightSetup = async (inputTokens: unknown = 30_000) => {
    const fixture = await setup();
    const usage = { type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: inputTokens, cached_input_tokens: 29_000, output_tokens: 10 },
      total_token_usage: { input_tokens: 650_000, cached_input_tokens: 600_000, output_tokens: 100 },
    } } };
    const rows: unknown[] = [fixture.entries[0], fixture.entries[1],
      { type: 'turn_context', payload: { turn_id: 'native-turn', model: 'gpt-6-sol' } }, usage, usage,
      fixture.entries[2]];
    const write = () => writeFile(fixture.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await write();
    const receipt: SuStdioReceipt = { phase: 'received', peerId: 'preparation-peer', sequence: 12,
      clockId: preflightClock.id, atMs: preflightClock.now() - 1000,
      frame: { method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } } } };
    const observe = async (sourceId = 'S-I0', receipts = [receipt]) => captureCarrySourcePreflight({
      source: await captureCompletedCarrySource(fixture.peer, 'native-thread', 'native-turn'), sourceId, receipts,
    });
    return { ...fixture, rows, write, receipt, observe };
  };
  it('observes last-request input from the exact native cut, not cumulative totals, cached subsets or duplicate notices', async () => {
    const fixture = await preflightSetup();
    const observed = await fixture.observe();
    expect(observed).toMatchObject({ dispatchAuthorized: false, missing: [],
      history: { inputTokens: 30_000, model: 'gpt-6-sol', inBand: true },
      idle: { ageMs: 1000, phase: 'window-open', evidenceRef: 'native:preparation-peer:12' } });
    const bytes = Buffer.from(await readFile(fixture.path));
    expect(observed.sourceRef).toBe(`codex:native-thread/native-turn@${createHash('sha256').update(bytes).digest('hex')}`);
    expect(observed.history!.evidenceRef).toBe(`${observed.sourceRef}#usage-byte=${bytes.indexOf(Buffer.from('{"type":"event_msg","payload":{"type":"token_count"'))}`);
    expect((await fixture.observe('L-I0')).history).toMatchObject({ inputTokens: 30_000, inBand: false });
  });
  it.each([
    ['S-I0', 59_999, 'window-open'], ['S-I0', 60_000, 'expired'],
    ['S-I1', 359_999, 'too-early'], ['S-I1', 360_000, 'window-open'],
    ['S-I1', 600_000, 'window-open'], ['S-I1', 600_001, 'expired'],
    ['S-I2', 3_899_999, 'too-early'], ['S-I2', 3_900_000, 'window-open'],
    ['S-I2', 4_500_000, 'window-open'], ['S-I2', 4_500_001, 'expired'],
  ])('retains the registered %s dispatch window at age %s', async (sourceId, age, phase) => {
    const fixture = await preflightSetup(); fixture.receipt.atMs = preflightClock.now() - Number(age);
    expect((await fixture.observe(String(sourceId))).idle).toMatchObject({ ageMs: age, phase });
  });
  it.each(['missing', 'duplicate', 'other-clock', 'future', 'failed', 'other-turn'])('refuses a %s completion receipt', async fault => {
    const fixture = await preflightSetup();
    if (fault === 'other-clock') fixture.receipt.clockId = 'old-controller';
    if (fault === 'future') fixture.receipt.atMs = preflightClock.now() + 1;
    if (fault === 'failed') ((fixture.receipt.frame.params as RpcFrame).turn as RpcFrame).status = 'failed';
    if (fault === 'other-turn') ((fixture.receipt.frame.params as RpcFrame).turn as RpcFrame).id = 'other';
    expect(await fixture.observe('S-I0', fault === 'missing' ? [] : fault === 'duplicate'
      ? [fixture.receipt, fixture.receipt] : [fixture.receipt])).toMatchObject({ idle: null,
      missing: ['same-clock-completion-receipt-unavailable'], dispatchAuthorized: false });
  });
  it.each([null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('does not infer history size from invalid input %s', async input => {
    expect(await (await preflightSetup(input)).observe()).toMatchObject({ history: null,
      missing: ['last-completed-request-input-unavailable'] });
  });
  it.each(['missing-usage', 'other-turn', 'later-context', 'compacted'])('refuses stale history after %s', async fault => {
    const fixture = await preflightSetup();
    if (fault === 'missing-usage') fixture.rows.splice(3, 2);
    if (fault === 'other-turn') (fixture.rows[2] as { payload: { turn_id: string } }).payload.turn_id = 'other';
    if (fault === 'later-context') fixture.rows.splice(-1, 0, { type: 'turn_context', payload: { turn_id: 'later', model: 'gpt-6-sol' } });
    if (fault === 'compacted') fixture.rows.splice(-1, 0, { type: 'compacted', payload: {} });
    await fixture.write();
    expect(await fixture.observe()).toMatchObject({ history: null, missing: ['last-completed-request-input-unavailable'] });
  });
  it('rejects disk drift and changed in-memory bytes before a preflight observation', async () => {
    const fixture = await preflightSetup();
    const source = await captureCompletedCarrySource(fixture.peer, 'native-thread', 'native-turn');
    const observe = () => captureCarrySourcePreflight({ source, sourceId: 'S-I0', receipts: [fixture.receipt] });
    source.snapshot.bytes[0] ^= 1;
    await expect(observe()).rejects.toThrow('bytes do not match');
    source.snapshot.bytes[0] ^= 1;
    await appendFile(fixture.path, '{}\n');
    await expect(observe()).rejects.toThrow('byte cap');
    await writeFile(fixture.path, source.snapshot.bytes.toString().replace('gpt-6-sol', 'gpt-6-foo'));
    await expect(observe()).rejects.toThrow('changed after its frozen cut');
  });
  it.each(['append', 'rewrite-same-length', 'delete'])('rejects parent %s even when child bytes did not change', async change => {
    const { peer, parentPath, parentBody } = await forkSetup();
    const source = await captureCompletedCarrySource(peer, 'native-thread', 'native-turn');
    if (change === 'append') await appendFile(parentPath, '{}\n');
    if (change === 'rewrite-same-length') await writeFile(parentPath, parentBody.replace('parent-turn', 'parent-burn'));
    if (change === 'delete') await rm(parentPath);
    await expect(recheckCarrySourceSnapshot(source)).rejects.toThrow();
  });
  it.each(['cycle', 'same-path', 'wrong-id', 'busy', 'failed'])('rejects a %s parent before stopping the peer', async fault => {
    const { peer, path, parent } = await forkSetup();
    if (fault === 'cycle') parent.forkedFromId = 'native-thread';
    if (fault === 'same-path') parent.path = path;
    if (fault === 'wrong-id') parent.id = 'wrong-parent';
    if (fault === 'busy') parent.status = { type: 'active' };
    if (fault === 'failed') parent.turns[0].status = 'failed';
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow(/carry source/);
    expect(peer.close).not.toHaveBeenCalled();
  });
  it('rejects a parent link present only on disk, instead of certifying a child-only cut', async () => {
    const { peer, thread } = await forkSetup();
    thread.forkedFromId = null;
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow(/parent/);
  });
  it('applies one aggregate byte cap to the child and parent chain', async () => {
    const { peer, body, parentBody } = await forkSetup();
    const cap = Buffer.byteLength(body() + parentBody) - 1;
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn', cap)).rejects.toThrow(/byte cap/);
  });
  it('captures the grandparent and rejects a shortened frozen chain', async () => {
    const { peer, thread, parent, parentPath, parentBody } = await forkSetup();
    const grandPath = join(root, 'grand.jsonl');
    await writeFile(grandPath, parentBody.replaceAll('parent-thread', 'grand-thread').replaceAll('parent-turn', 'grand-turn'));
    parent.forkedFromId = 'grand-thread';
    await writeFile(parentPath, parentBody.replace('"id":"parent-thread"', '"id":"parent-thread","forked_from_id":"grand-thread"'));
    const grand = { ...parent, id: 'grand-thread', path: grandPath, forkedFromId: null,
      turns: [{ ...parent.turns[0], id: 'grand-turn' }] };
    peer.request.mockImplementation(async request => ({ thread: (request.params as RpcFrame).threadId === thread.id ? thread
      : (request.params as RpcFrame).threadId === parent.id ? parent : grand }));
    const source = await captureCompletedCarrySource(peer, 'native-thread', 'native-turn');
    expect(source.ancestors.map(member => member.threadId)).toEqual(['parent-thread', 'grand-thread']);
    await expect(recheckCarrySourceSnapshot(source)).resolves.toBeUndefined();
    await expect(recheckCarrySourceSnapshot({ ...source, ancestors: source.ancestors.slice(0, 1) })).rejects.toThrow('parent chain');
    await appendFile(grandPath, '{}\n');
    await expect(recheckCarrySourceSnapshot(source)).rejects.toThrow();
  });
  it('bounds native ancestor discovery before opening any file', async () => {
    const { peer, thread } = await setup();
    let reads = 0;
    peer.request.mockImplementation(async request => ({ thread: { ...thread,
      id: String((request.params as RpcFrame).threadId), path: join(root, `missing-${reads}.jsonl`),
      forkedFromId: `ancestor-${++reads}` } }));
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow('depth bound');
    expect(peer.request).toHaveBeenCalledTimes(32);
    expect(peer.close).not.toHaveBeenCalled();
  });
  it('rejects a symlinked parent as well as a symlinked child', async () => {
    const { peer, parentPath, parent } = await forkSetup();
    const link = join(root, 'parent-link.jsonl'); await symlink(parentPath, link); parent.path = link;
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow();
  });
  it('waits for native teardown and captures exact bytes, without editing the source', async () => {
    const { peer, path } = await setup();
    const bytes = await readFile(path);
    const closing: string[] = [];
    peer.close.mockImplementation(async () => { closing.push('closed'); });
    peer.done = Promise.resolve().then(() => { closing.push('exited'); });
    const result = await captureCompletedCarrySource(peer, 'native-thread', 'native-turn');
    expect(closing.sort()).toEqual(['closed', 'exited']);
    expect(peer.request).toHaveBeenCalledWith({ method: 'thread/read', params: { threadId: 'native-thread', includeTurns: true } });
    expect(result.snapshot.bytes).toEqual(bytes);
    expect(await readFile(path)).toEqual(bytes);
    await expect(recheckCarrySourceSnapshot(result)).resolves.toBeUndefined();
  });
  it('reads only after close completes, so a native final flush is included', async () => {
    const { peer, path, body } = await setup();
    await writeFile(path, '');
    peer.close.mockImplementation(async () => { await writeFile(path, body()); });
    expect((await captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).snapshot.bytes.toString()).toBe(body());
  });
  it.each(['busy', 'wrong-thread', 'wrong-turn', 'failed', 'partial-view', 'relative-path', 'later-turn', 'duplicate-turn'])('rejects native %s before teardown', async fault => {
    const { peer, thread } = await setup();
    if (fault === 'busy') thread.status.type = 'active';
    if (fault === 'wrong-thread') thread.id = 'other';
    if (fault === 'wrong-turn') thread.turns[0].id = 'other';
    if (fault === 'failed') thread.turns[0].status = 'failed';
    if (fault === 'partial-view') thread.turns[0].itemsView = 'summary';
    if (fault === 'relative-path') thread.path = 'native.jsonl';
    if (fault === 'later-turn') thread.turns.push({ ...thread.turns[0], id: 'later' });
    if (fault === 'duplicate-turn') thread.turns.push(thread.turns[0]);
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow(/carry source/);
    expect(peer.close).not.toHaveBeenCalled();
  });
  it.each(['partial-record', 'empty', 'bad-json', 'wrong-header', 'duplicate-header', 'no-header', 'later-start', 'wrong-terminal', 'terminal-error'])('rejects %s in the original source', async fault => {
    const { peer, path, entries, body } = await setup();
    if (fault === 'wrong-header') entries[0].payload.id = 'other';
    if (fault === 'duplicate-header') entries.unshift(entries[0]);
    if (fault === 'no-header') entries.shift();
    if (fault === 'later-start') entries.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } });
    if (fault === 'wrong-terminal') entries[2].payload.turn_id = 'other';
    if (fault === 'terminal-error') Object.assign(entries[2].payload, { status: 'failed' });
    await writeFile(path, fault === 'empty' ? '' : fault === 'bad-json' ? '{bad}\n' : body() + (fault === 'partial-record' ? '{' : ''));
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow();
  });
  it('propagates teardown failure before reading a source that otherwise looks valid', async () => {
    const { peer } = await setup();
    peer.close.mockRejectedValue(new Error('tracked teardown failed'));
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow('tracked teardown failed');
  });
  it('does not capture after a rejected native process-exit receipt', async () => {
    const { peer } = await setup();
    peer.done = Promise.reject(new Error('native exit failed')); void peer.done.catch(() => {});
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow('native exit failed');
  });
  it.each([NaN, Infinity, 0, -1, 65 * 1024 * 1024])('refuses unsafe byte cap %s before native reads', async cap => {
    const { peer } = await setup();
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn', cap)).rejects.toThrow(/byte cap/);
    expect(peer.request).not.toHaveBeenCalled();
  });
  it('honors the byte cap and refuses a symlinked source', async () => {
    const { peer, path, thread } = await setup();
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn', 1)).rejects.toThrow(/byte cap/);
    const link = join(root, 'link.jsonl'); await symlink(path, link); thread.path = link;
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow();
  });
  it.each(['append', 'rewrite-same-length', 'truncate', 'partial-tail'])('rejects source %s before the next arm', async change => {
    const { peer, path, body } = await setup();
    const source = await captureCompletedCarrySource(peer, 'native-thread', 'native-turn');
    if (change === 'append') await appendFile(path, '{}\n');
    if (change === 'rewrite-same-length') await writeFile(path, body().replace('task_complete', 'task_completE'));
    if (change === 'truncate') await writeFile(path, '');
    if (change === 'partial-tail') await appendFile(path, '{');
    await expect(recheckCarrySourceSnapshot(source)).rejects.toThrow();
  });
});

describe('measureTranscriptFile — the streaming guarantee', () => {
  it('the real CLI refuses a passing target on partial usage and accepts the fully reported control', async () => {
    const path = await writeTranscript('su-cli', 'session-cli', [usageEntry({
      message: { model: 'claude-model', usage: { input_tokens: 2000 } },
    })]);
    const cli = fileURLToPath(new URL('../../../../scripts/measure-launch-cost.ts', import.meta.url));
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', cli, '--root', root, '--target', '1000000'], {
      encoding: 'utf8', timeout: 15000,
    });
    const partial = run();
    expect(partial.status).toBe(1);
    expect(partial.stderr).toContain('UNKNOWN target result');
    expect(partial.stdout).toContain('known lower bounds');
    expect(partial.stdout).not.toContain('PASS median');
    await writeFile(path, JSON.stringify(usageEntry()) + '\n');
    const complete = run();
    expect(complete.status).toBe(0);
    expect(complete.stdout).toContain('PASS median');
  });

  it('finds a usage row that sits far past any bounded read window', async () => {
    // ⚠ THE LOAD-BEARING TEST OF THIS FILE.
    // A real psu transcript opens with a ~580 KB system-prompt entry on ONE line. Any reader
    // that inspects a bounded prefix (a 600 KB read window, `head -c`, a capped file-read tool)
    // never reaches the usage row and reports ZERO ROWS — which is indistinguishable from "this
    // session has no data" and is exactly how this corpus reads as empty. This fixture puts a
    // ~700 KB first line ahead of the usage row, so a non-streaming implementation fails here.
    const hugeSystemPrompt = {
      type: 'system',
      timestamp: '2026-09-18T06:31:00.000Z',
      content: 'x'.repeat(700_000),
    };
    const filePath = await writeTranscript('su-a', 'session-a', [hugeSystemPrompt, usageEntry()]);

    const outcome = await measureTranscriptFile(filePath, { root });

    expect(outcome).toHaveProperty('sample');
    const { sample } = outcome as { sample: { totalPromptTokens: number; bytesBeforeSample: number } };
    expect(sample.totalPromptTokens).toBe(232_413);
    // Positive control for the claim above: the sample really did sit past a 600 KB window, so
    // a passing assertion here cannot be explained by the fixture having been small all along.
    expect(sample.bytesBeforeSample).toBeGreaterThan(600_000);
  });

  it('reports the full sample shape from the first qualifying row', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'user', timestamp: '2026-09-18T06:30:00.000Z' },
      usageEntry(),
      usageEntry({ timestamp: '2026-09-18T07:00:00.000Z' }),
    ]);

    const outcome = await measureTranscriptFile(filePath, { root });
    const { sample } = outcome as { sample: Record<string, unknown> };

    expect(sample).toMatchObject({
      ownerId: 'su-a',
      sessionId: 'session-a',
      day: '2026-09-18',
      model: 'claude-opus-5',
      entrypoint: 'cli',
      cliVersion: '2.1.0',
      inputTokens: 2,
      cacheCreationTokens: 128_745,
      cacheReadTokens: 103_666,
      totalPromptTokens: 232_413,
      // The FIRST usage row, not the last: line 2 of the file.
      lineNumber: 2,
    });
  });

  it('skips past small usage rows to the real launch turn', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'assistant', timestamp: '2026-09-18T06:29:00.000Z', message: { usage: { input_tokens: 40 } } },
      usageEntry(),
    ]);
    const outcome = await measureTranscriptFile(filePath, { root });
    expect((outcome as { sample: { totalPromptTokens: number } }).sample.totalPromptTokens).toBe(
      232_413,
    );
  });

  it('tolerates blank and malformed lines without aborting the scan', async () => {
    const dir = join(root, 'su-a', 'projects', '-repo');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'session-a.jsonl');
    await writeFile(filePath, `\n{not json\n\n${JSON.stringify(usageEntry())}\n`, 'utf8');

    const outcome = await measureTranscriptFile(filePath, { root });
    expect(outcome).toHaveProperty('sample');
  });
});

describe('measureTranscriptFile — typed skips, never silent drops', () => {
  it('reports no-usage-row for a transcript with no usage at all', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'user', timestamp: '2026-09-18T06:30:00.000Z' },
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'no-usage-row' },
    });
  });

  it('reports all-below-threshold when every usage row is under the floor', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'assistant', timestamp: '2026-09-18T06:30:00.000Z', message: { usage: {
        input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      } } },
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'all-below-threshold' },
    });
  });

  it('does not classify incomplete small counts as proven below the launch threshold', async () => {
    const filePath = await writeTranscript('su-incomplete', 'session-incomplete', [
      { type: 'assistant', timestamp: '2026-09-18T06:30:00.000Z', message: { usage: { input_tokens: 40 } } },
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({ skip: { filePath, reason: 'incomplete-usage' } });
  });

  it('reports sidechain-only when the only large turns are sub-agent turns', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      usageEntry({ isSidechain: true }),
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'sidechain-only' },
    });
    // ...and measures it when sidechains are explicitly requested.
    const included = await measureTranscriptFile(filePath, { root, includeSidechains: true });
    expect(included).toHaveProperty('sample');
  });

  it('reports undatable rather than inventing a day', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      usageEntry({ timestamp: 'whenever' }),
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toMatchObject({
      skip: { reason: 'undatable' },
    });
  });

  it('reports unreadable for a file that does not exist', async () => {
    const filePath = join(root, 'su-a', 'projects', '-repo', 'missing.jsonl');
    expect(await measureTranscriptFile(filePath, { root })).toMatchObject({
      skip: { reason: 'unreadable' },
    });
  });

  it('applies day, model and owner filters as filtered-out skips', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [usageEntry()]);
    expect(await measureTranscriptFile(filePath, { root, since: '2026-09-19' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    expect(await measureTranscriptFile(filePath, { root, until: '2026-09-17' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    expect(
      await measureTranscriptFile(filePath, { root, modelContains: 'sonnet' }),
    ).toMatchObject({ skip: { reason: 'filtered-out' } });
    expect(await measureTranscriptFile(filePath, { root, ownerPrefix: 'role-' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    // Inclusive bounds on both ends.
    expect(
      await measureTranscriptFile(filePath, { root, since: '2026-09-18', until: '2026-09-18' }),
    ).toHaveProperty('sample');
  });
});

describe('collectTranscriptFiles', () => {
  it('finds transcripts nested under owner/projects/<project>', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await writeTranscript('role-b', 'session-b', [usageEntry()], '-other');
    await writeFile(join(root, 'not-a-transcript.txt'), 'ignored', 'utf8');

    const files = await collectTranscriptFiles(root);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('does not follow directory symlinks', async () => {
    // The repo guide's `find -L` incident: a symlink DAG under this tree ran 32h and consumed
    // 1.86 TB of swap. A transcript tree has no legitimate need to traverse a link, so a link
    // that would double the corpus must contribute nothing.
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await symlink(join(root, 'su-a'), join(root, 'su-a-link'), 'dir');

    const files = await collectTranscriptFiles(root);
    expect(files).toHaveLength(1);
  });

  it('respects maxDepth', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    // owner(1)/projects(2)/-repo(3)/file — depth 2 stops before the file's directory.
    expect(await collectTranscriptFiles(root, 2)).toHaveLength(0);
    expect(await collectTranscriptFiles(root, 3)).toHaveLength(1);
  });

  it('returns an empty list for a root that does not exist', async () => {
    expect(await collectTranscriptFiles(join(root, 'nope'))).toEqual([]);
  });
});

describe('ownerIdFromPath', () => {
  it('reads the first path segment below the root', () => {
    expect(ownerIdFromPath('/r', '/r/su-abc/projects/-repo/s.jsonl')).toBe('su-abc');
  });

  it('returns unknown for a path outside the root', () => {
    expect(ownerIdFromPath('/r', '/elsewhere/s.jsonl')).toBe('unknown');
  });
});

describe('scanLaunchTranscripts', () => {
  it('measures every transcript and censuses each skip by reason', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await writeTranscript('su-b', 'session-b', [
      usageEntry({ sessionId: 'session-b', timestamp: '2026-09-11T10:00:00.000Z' }),
    ]);
    await writeTranscript('su-c', 'session-c', [{ type: 'user' }]);
    await writeTranscript('su-d', 'session-d', [usageEntry({ isSidechain: true })]);

    const report = await scanLaunchTranscripts({ root });

    expect(report.filesScanned).toBe(4);
    expect(report.filesMeasured).toBe(2);
    expect(report.skippedByReason['no-usage-row']).toBe(1);
    expect(report.skippedByReason['sidechain-only']).toBe(1);
    expect(report.skipped).toHaveLength(2);
    // filesScanned === filesMeasured + skipped.length: no file is silently dropped.
    expect(report.filesMeasured + report.skipped.length).toBe(report.filesScanned);
    // Samples are ordered oldest-first by measured timestamp.
    expect(report.samples.map((s) => s.day)).toEqual(['2026-09-11', '2026-09-18']);
  });

  it('returns an honest empty report for an empty tree rather than failing', async () => {
    const report = await scanLaunchTranscripts({ root });
    expect(report.filesScanned).toBe(0);
    expect(report.samples).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});
