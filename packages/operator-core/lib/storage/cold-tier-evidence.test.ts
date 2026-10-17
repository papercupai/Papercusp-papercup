import { describe, expect, it, vi } from 'vitest';
import { assessColdMounts, assessColdMoves, hasColdMoveAside, kopiaJson, measureColdMounts, measureNativeColdEnvironment, parseColdMounts,
  COLD_MOUNTS_INSTRUMENT_KEY, COLD_MOVES_INSTRUMENT_KEY, type ColdMountObservation } from './cold-tier-evidence';
import { COLD_ARCHIVE_INTEGRITY_ACTION, observeColdArchiveIntegrity } from './cold-tier-evidence';
import { DURABLE_HEADROOM_TARGETS_INSTRUMENT_KEY, POSTGRES_RETENTION_INSTRUMENT_KEY } from './retention-interval-evidence';
import { getRegisteredInstrument } from '../rubric-instrument-registry';

const at = (h: number) => new Date(Date.UTC(2026, 9, 15, h)).toISOString();
const uuid = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const current = (): ColdMountObservation => ({ host: 'fixture-host', bootId: uuid[1]!, at: at(10), mounts: [
  { path: '/mnt/cold-a', source: '/dev/sda2', uuidSource: '/dev/sda2', uuid: uuid[0]!, type: 'xfs', nofail: true },
  { path: '/mnt/cold-b', source: '/dev/sdb3', uuidSource: '/dev/sdb3', uuid: uuid[1]!, type: 'xfs', nofail: true },
] });
const previous = () => ({ ...current(), bootId: uuid[0]!, at: at(1) });

describe('resumable native cold archive integrity', () => {
  function setup(total = 2) {
    const population = { total, fingerprint: 'a'.repeat(32), pending: false, residue: false };
    let saved: Record<string, unknown> | null = null;
    const unsafe = vi.fn(async (query: string, args: unknown[] = []) => {
      if (query.includes('count(*)::int AS total')) return [population];
      if (query.startsWith('SELECT details')) return saved ? [{ details: saved }] : [];
      if (query.startsWith('SELECT *')) return [{ source_kind: 'codex', session_id: args[1] === '' ? 'a' : 'b',
        file_count: 1, bytes_raw: '20', bytes_stored: '10' }];
      saved = JSON.parse(String(args[4])); return [];
    });
    const deps = { identity: async () => ({ host: 'native-host', bootId: uuid[0]! }), buildSha: () => 'native-build',
      now: () => Date.parse(at(10)), verify: vi.fn(async () => ({ fileCount: 1, bytesRaw: 20, bytesStored: 10,
        manifestSha256: 'f'.repeat(64), primaryDevice: 2, replicaDevice: 3 })) };
    return { sql: { unsafe } as never, unsafe, population, deps, read: () => saved,
      set: (value: Record<string, unknown>) => { saved = value; } };
  }
  it('cannot pass a partial page and resumes exact verified population through the native audit seam', async () => {
    const s = setup();
    expect((await observeColdArchiveIntegrity(s.sql, 'workspace', s.deps)).verdict).toBe('unknown');
    expect(s.read()).toMatchObject({ complete: false, total: 2, verified: 1, cursor: ['codex', 'a'],
      host: 'native-host', runtimeBuild: 'native-build' });
    const result = await observeColdArchiveIntegrity(s.sql, 'workspace', s.deps);
    expect(result.verdict).toBe('pass');
    expect(result.observationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(s.read()).toMatchObject({ complete: true, total: 2, verified: 2, cursor: ['codex', 'b'] });
    expect(s.unsafe.mock.calls.at(-1)![1]![0]).toBe(result.observationId);
    expect(s.unsafe.mock.calls.at(-1)![1]).toContain(COLD_ARCHIVE_INTEGRITY_ACTION);
    expect(s.deps.verify).toHaveBeenCalledTimes(2);
  });
  it.each(['pending', 'residue', 'empty', 'build'] as const)('refuses %s evidence before reading cold files', async missing => {
    const s = setup();
    if (missing === 'pending') s.population.pending = true;
    if (missing === 'residue') s.population.residue = true;
    if (missing === 'empty') s.population.total = 0;
    expect((await observeColdArchiveIntegrity(s.sql, 'workspace', { ...s.deps,
      buildSha: () => missing === 'build' ? null : 'native-build' })).verdict).toBe('unknown');
    expect(s.deps.verify).not.toHaveBeenCalled();
  });
  it('records a failed actual read without advancing its cursor', async () => {
    const s = setup(); s.deps.verify.mockRejectedValue(new Error('replica checksum mismatch'));
    expect((await observeColdArchiveIntegrity(s.sql, 'workspace', s.deps)).verdict).toBe('fail');
    expect(s.read()).toMatchObject({ complete: false, verified: 0, cursor: ['', ''],
      error: expect.stringContaining('replica checksum mismatch') });
  });
  it('does not inherit an expired epoch or publish a pass while the population changes', async () => {
    const s = setup();
    s.set({ schemaVersion: 1, total: 2, verified: 1, cursor: ['codex', 'a'], complete: false,
      startedAt: '2026-10-01T00:00:00.000Z' });
    await observeColdArchiveIntegrity(s.sql, 'workspace', s.deps);
    expect(s.read()).toMatchObject({ verified: 1, cursor: ['codex', 'a'] });
    s.deps.verify.mockImplementationOnce(async () => { s.population.fingerprint = 'b'.repeat(32);
      return { fileCount: 1, bytesRaw: 20, bytesStored: 10, manifestSha256: 'f'.repeat(64), primaryDevice: 2, replicaDevice: 3 }; });
    expect((await observeColdArchiveIntegrity(s.sql, 'workspace', s.deps)).verdict).toBe('unknown');
    expect(s.read()).toMatchObject({ verified: 1, populationFingerprint: 'a'.repeat(32), complete: false });
  });
});

describe('native storage environment evidence', () => {
  const setup = () => ({ identity: vi.fn(async () => ({ host: 'fixture-host', bootId: uuid[0]! })),
    buildSha: () => 'abc123', resolve: vi.fn(async () => ({ verdict: 'pass' as const, detail: '7 verified cutovers and snapshot native.' })) });
  const measure = (deps: Parameters<typeof measureNativeColdEnvironment>[4], requirePass = false) =>
    measureNativeColdEnvironment('workspace', 'papercusp', COLD_MOVES_INSTRUMENT_KEY, requirePass, deps);
  it('re-observes the registered native check in the exact scope without inventing a process', async () => {
    const deps = setup();
    const first = await measure(deps, true);
    expect(first).toMatch(/^sha256-native-storage-environment-v1:[a-f0-9]{64}$/);
    expect(await measure(deps)).toBe(first);
    expect(deps.resolve).toHaveBeenCalledWith(COLD_MOVES_INSTRUMENT_KEY, expect.objectContaining({ workspaceId: 'workspace', harnessSlug: 'papercusp' }));
    expect(deps.resolve).toHaveBeenCalledTimes(2);
    deps.identity.mockResolvedValue({ host: 'other-host', bootId: uuid[0]! });
    expect(await measure(deps)).not.toBe(first);
    deps.identity.mockResolvedValue({ host: 'fixture-host', bootId: uuid[1]! });
    expect(await measure(deps)).not.toBe(first);
    expect(await measure({ ...setup(), buildSha: () => 'different-build' })).not.toBe(first);
  });
  it.each(['fail', 'unknown'] as const)('refuses a %s observation on bind and cannot keep old evidence current', async verdict => {
    const deps = { ...setup(), resolve: vi.fn(async () => ({ verdict, detail: 'native prerequisite missing' })) };
    expect(await measureNativeColdEnvironment('workspace', 'papercusp', COLD_MOVES_INSTRUMENT_KEY, false, deps)).toBeNull();
    await expect(measureNativeColdEnvironment('workspace', 'papercusp', COLD_MOVES_INSTRUMENT_KEY, true, deps)).rejects.toThrow(`is ${verdict}`);
  });
  it('fails closed on missing build, native reader failure, or a boot transition during the read', async () => {
    expect(await measure({ ...setup(), buildSha: () => null })).toBeNull();
    await expect(measure({ ...setup(), buildSha: () => null }, true)).rejects.toThrow('build identity unavailable');
    await expect(measure({ ...setup(), resolve: vi.fn(async () => { throw new Error('permission denied'); }) })).rejects.toThrow('permission denied');
    const deps = setup();
    deps.identity.mockResolvedValueOnce({ host: 'fixture-host', bootId: uuid[0]! }).mockResolvedValueOnce({ host: 'fixture-host', bootId: uuid[1]! });
    await expect(measure(deps)).rejects.toThrow('host changed during observation');
  });
});

describe('native cold mount evidence', () => {
  it('parses exact kernel mounts and unique UUID/nofail fstab entries', () => {
    const kernel = '1 0 8:2 / /mnt/cold-a rw - xfs /dev/sda2 rw\n2 0 8:19 / /mnt/cold-b rw - xfs /dev/sdb3 rw';
    const fstab = `UUID=${uuid[0]} /mnt/cold-a xfs defaults,nofail 0 2\nUUID=${uuid[1]} /mnt/cold-b xfs nofail 0 2`;
    expect(parseColdMounts(kernel, fstab)).toMatchObject(current().mounts.map(({ uuidSource, ...m }) => m));
    expect(parseColdMounts(kernel, fstab + '\n/dev/sdb3 /mnt/cold-b xfs nofail 0 2')[1]!.uuid).toBe('');
  });
  it('requires a real same-host boot transition with stable volume identities', () => {
    expect(assessColdMounts(current(), previous()).verdict).toBe('pass');
    for (const witness of [null, current(), { ...previous(), host: 'other' }, { ...previous(), at: at(11) }]) {
      expect(assessColdMounts(current(), witness).verdict).toBe('unknown');
    }
    const changed = current(); changed.mounts[0]!.uuid = uuid[1]!;
    expect(assessColdMounts(changed, previous()).verdict).toBe('fail');
  });
  it.each(['nofail', 'type', 'source', 'uuidSource', 'uuid'] as const)('rejects a bad %s even when a previous boot was good', field => {
    const now = current(); Object.assign(now.mounts[0]!, { [field]: field === 'nofail' ? false : '' });
    expect(assessColdMounts(now, previous()).verdict).toBe('fail');
  });
  it('retains native boot observations in the existing workspace/host audit seam', async () => {
    const unsafe = vi.fn().mockResolvedValueOnce([{ details: previous() }]).mockResolvedValueOnce([]);
    expect((await measureColdMounts({ unsafe } as never, 'workspace', async () => current())).verdict).toBe('pass');
    expect(unsafe.mock.calls[0]![1]).toEqual(['workspace', 'storage:cold-mount-observation', 'fixture-host', uuid[1], Date.parse(at(10))]);
    expect(unsafe.mock.calls[1]![0]).toContain('WHERE NOT EXISTS');
  });
  it('registers executable platform checks on the maintained rescore seam', () => {
    for (const key of [COLD_MOUNTS_INSTRUMENT_KEY, COLD_MOVES_INSTRUMENT_KEY, DURABLE_HEADROOM_TARGETS_INSTRUMENT_KEY, POSTGRES_RETENTION_INSTRUMENT_KEY]) {
      expect(getRegisteredInstrument(key)).toMatchObject({ evaluator: 'platform', rescore: { scope: 'harness', resolve: expect.any(Function) } });
    }
  });
});

const moves = () => ['kopia-repo', 'papercusp-backups', 'Debug'].map(name => {
  const destination = name === 'Debug' ? `/mnt/cold-b/${name}` : name === 'kopia-repo' ? '/mnt/cold-a/Backup/kopia-repo' : `/mnt/cold-a/${name}`;
  return { name, source: `/mnt/data/${name}`, destination, repointed: true, asideAbsent: true,
    log: `${at(1)} COPY ${name}\n${at(2)} VERIFY1 ${name} entries src=2 dst=2 bytes src=100 dst=100\n${at(3)} VERIFY2 ${name} entries src=2 dst=2 bytes src=100 dst=100\n${at(4)} DONE ${name} -> ${destination} (source removed, symlink left)` };
});
const backup = () => ({ repositoryPath: '/mnt/cold-a/Backup/kopia-repo', host: 'host', snapshotHost: 'host',
  snapshotId: 'native-snapshot', startedAt: at(5), finishedAt: at(6), complete: true });
describe('verified cold bulk cutover', () => {
  it('reads the root-only repository through the installed backup helper with argv and a bounded inventory', async () => {
    const execute = vi.fn((_file, _args, _options, callback) => callback(null, '{"native":true}'));
    const args = ['snapshot', 'list', '--all', '--max-results=1', '--json'];
    expect(await kopiaJson(args, execute)).toEqual({ native: true });
    expect(execute.mock.calls[0]).toEqual(['/usr/bin/bash', ['-c',
      'source "$1" && kopia_as_root /usr/bin/sudo /usr/bin/kopia "--config-file=$2" "${@:3}"',
      'cold-tier-evidence', expect.stringContaining('/.config/kopia/kopia-cache-bootstrap.sh'),
      expect.stringContaining('/.config/kopia/repository.config'), ...args],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, shell: false }, expect.any(Function)]);
    await expect(kopiaJson(['snapshot', 'delete', 'x'], execute)).rejects.toThrow('not read-only');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('refuses native read failures and malformed JSON', async () => {
    await expect(kopiaJson(['repository', 'status', '--json'], (_f, _a, _o, callback) => callback(new Error('denied'), '')))
      .rejects.toThrow('unavailable');
    await expect(kopiaJson(['repository', 'status', '--json'], (_f, _a, _o, callback) => callback(null, 'bad')))
      .rejects.toThrow('malformed');
  });
  it('detects retained originals from both cold-tier move protocols before certifying source removal', () => {
    expect(hasColdMoveAside('kopia-repo', 'kopia-repo', ['kopia-repo', 'kopia-repo.moving-to-cold-a-e9919'], [])).toBe(true);
    expect(hasColdMoveAside('papercusp-backups', 'papercusp-backups', ['papercusp-backups.moving-to-cold-a-next'], [])).toBe(true);
    expect(hasColdMoveAside('Debug', 'Debug', [], ['.moving-to-cold-b-Debug'])).toBe(true);
    expect(hasColdMoveAside('Debug', 'Debug', [], ['.moving-to-cold-b-Debug-retry'])).toBe(true);
    expect(hasColdMoveAside('back', 'back', [], ['.moving-to-cold-a-back-retry'])).toBe(true);
    expect(hasColdMoveAside('Debug', 'Debug', ['Debug'], ['.moving-to-cold-b-Debug_JAMES'])).toBe(false);
    expect(hasColdMoveAside('kopia-repo', 'kopia-repo', ['kopia-repo'], [])).toBe(false);
  });
  it('requires each move and an actual post-cutover backup from the moved repository', () => {
    expect(assessColdMoves(moves(), backup(), at(8)).verdict).toBe('pass');
    expect(assessColdMoves(moves().slice(0, 2), backup(), at(8)).verdict).toBe('unknown');
    for (const bad of [null, { ...backup(), startedAt: at(3) }, { ...backup(), snapshotHost: 'remote' },
      { ...backup(), complete: false }, { ...backup(), repositoryPath: '/mnt/data/Backup/kopia-repo' }]) {
      expect(assessColdMoves(moves(), bad, at(8)).verdict).toBe('unknown');
    }
  });
  it('accepts Kopia hostname canonicalization while refusing a different host', () => {
    const native = { ...backup(), host: 'fixture-server-NodeA',
      snapshotHost: 'fixture-server-nodea' };
    expect(assessColdMoves(moves(), native, at(8)).verdict).toBe('pass');
    expect(assessColdMoves(moves(), { ...native, snapshotHost: 'other-server-nodea' }, at(8)).verdict).toBe('unknown');
  });
  it('catches middle verification mismatch, missing verification and wrong DONE destination', () => {
    for (const edit of [(s: string) => s.replace('bytes src=100 dst=100', 'bytes src=100 dst=99'),
      (s: string) => s.replace(/^.* VERIFY1 .*\n/m, ''), (s: string) => s.replace(' -> /mnt/cold-a/Backup/kopia-repo', ' -> /wrong')]) {
      const input = moves(); input[0]!.log = edit(input[0]!.log);
      expect(assessColdMoves(input, backup(), at(8)).verdict).toBe('fail');
    }
  });
  it('does not borrow another directory proof, stale success, symlink or failed removal', () => {
    const input = moves(); input[0]!.log = input[1]!.log;
    expect(assessColdMoves(input, backup(), at(8)).verdict).toBe('unknown');
    const retried = moves(); retried[0]!.log += `\n${at(7)} COPY kopia-repo`;
    expect(assessColdMoves(retried, backup(), at(8)).verdict).toBe('unknown');
    for (const field of ['repointed', 'asideAbsent'] as const) {
      const bad = moves(); bad[0]![field] = false;
      expect(assessColdMoves(bad, backup(), at(8)).verdict).toBe('fail');
    }
  });
});
