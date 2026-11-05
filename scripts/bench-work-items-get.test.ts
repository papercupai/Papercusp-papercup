import { describe, expect, it } from 'vitest';
import { judgeSamples, runSummaryCohort, validateSummary, mcpIdentityFixture, identityPreparation, identityPreparationProbe, identityRuntimePreparation, IdentityPreparationError, isolatedIdentityRuntimeContract, identityProcessGroupCensus, identityLoadedHealth, identitySelectedSource, identityExecutableFingerprint, identityFileMappings, identityMappedFileFingerprints, type IdentityRuntime, type Sample, type McpIdentityFixture } from './bench-work-items-get';
import { AgentMcpConnectionError } from '../packages/operator-core/lib/agent-mcp-client';
import { maybeBatchNudge } from '../packages/operator-core/lib/code-run-batch-nudge';
import type { PerfWorkloadManifest } from '../packages/operator-core/lib/system-health/perf-workload-run';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifierSourceFiles } from '../packages/operator-core/lib/verifier-source';
import { identityWorkloadFixture } from './bench-work-items-get';
import { perfProtocolHash } from '../packages/operator-core/lib/system-health/perf-workload-protocol';
// @ts-expect-error -- The maintained CLI preflight is JavaScript without declarations.
import { assertPrivateIntegrationEvidence } from './test-files.mjs';

const identity: McpIdentityFixture = { ownerId: 'su-fixture', ownerLabel: 'Fixture', source: 'test', workspaceId: 'test-workspace',
  userId: null, fleetSlug: null, fleetRole: null, inbox_wake_key: 'coord:inbox-wake:su-fixture' };
const identityFixture = () => mcpIdentityFixture(identity, 'superuser=1&client=su-fixture&workspace=test-workspace&format=json');

describe('identity-only fixture export', () => {
  it('reproduces exact schedule bytes across fresh fixtures and retains the response oracle', () => {
    const a = identityWorkloadFixture(identityFixture(), 5, 'repeat-one');
    const b = identityWorkloadFixture(identityFixture(), 5, 'repeat-one');
    expect(a).toEqual(b);
    expect(a.fixtureHash).toBe(perfProtocolHash({ groups: a.groups }));
    expect(a.acceptance).toBe('unknown');
    expect(a.groups.map(group => [group.stratum, group.concurrency])).toEqual([['warm', 1], ['burst', 4]]);
    expect(a.groups[0].requests.map(row => row.atMs)).toEqual([0, 15000, 30000, 45000, 60000]);
    expect(a.groups[1].requests.map(row => row.atMs)).toEqual([0, 0, 0, 0, 15000]);
    for (const group of a.groups) for (const request of group.requests) {
      expect(request.expectedBodySha256).toBe(identityFixture().request.expectedBodySha256);
      expect(request.atMs + request.timeoutMs).toBeLessThanOrEqual(group.exposureMs);
    }
  });
  it('namespaces output groups by request, stratum and repeat and changes the fixture pin', () => {
    const a = identityWorkloadFixture(identityFixture(), 5, 'repeat-one');
    const b = identityWorkloadFixture(identityFixture(), 5, 'repeat-two');
    const ids = [a, b].flatMap(value => value.groups.flatMap(group => group.requests.map(row =>
      JSON.parse(row.body!).params._meta.outputGroupId)));
    expect(new Set(ids).size).toBe(20);
    expect(ids.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/.test(id))).toBe(true);
    expect(a.fixtureHash).not.toBe(b.fixtureHash);
    expect(a.fixtureHash).not.toBe(identityWorkloadFixture(identityFixture(), 4, 'repeat-one').fixtureHash);
  });
  it.each([0, -1, 1.5, NaN, 10001])('refuses invalid count %s before runtime allocation', count => {
    expect(() => identityWorkloadFixture(identityFixture(), count, 'repeat-one')).toThrow('count');
  });
  it('requires an explicit repeat identity without claiming independent repetition', () => {
    expect(() => identityWorkloadFixture(identityFixture(), 1, ' ')).toThrow('repeat-id');
    expect(identityWorkloadFixture(identityFixture(), 1, 'repeat-one').reason).toContain('no-repeat-independence');
  });
});

describe('retained isolated runtime preparation failures', () => {
  it.each([
    [{ PAPERCUSP_TEST_RUNS_DB_URL: '' }, 'PAPERCUSP_TEST_RUNS_DB_URL must not be blank'],
    [{ PAPERCUSP_TEST_RUNS_DB_URL: 'https://secret@host.invalid/token' }, 'PAPERCUSP_TEST_RUNS_DB_URL must be a valid PostgreSQL URL'],
    [{ PAPERCUSP_TEST_RUN_RECEIPT_FILE: '/tmp/receipt' }, 'PAPERCUSP_TEST_RUNS_DB_URL is required for durable isolated test receipts'],
  ])('retains the actual pre-builder refusal without running the compiler (%j)', async (env, code) => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-prepare-failure-'));
    let builderStarted = false;
    try {
      await expect(identityRuntimePreparation(dir, async stage => {
        stage('bundle');
        assertPrivateIntegrationEvidence(env);
        builderStarted = true;
      })).rejects.toThrow(code);
      const path = join(dir, 'preparation-failure.json');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ kind: 'unqualified-identity-runtime-preparation-failure',
        acceptance: 'unknown', stage: 'bundle', diagnostic: { code }, artifacts: [], hostStarted: false });
      expect(builderStarted).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(join(dir, 'prepare'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps original artifact references and safe errno while omitting opaque credentials and causes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-prepare-failure-'));
    const error = Object.assign(new Error('postgres://user:SECRET@localhost/db', { cause: 'Bearer SECRET' }), { code: 'EACCES' });
    try {
      mkdirSync(join(dir, 'prepare'));
      const artifact = join(dir, 'prepare/operator-api-build.log');
      writeFileSync(artifact, 'original compiler output');
      await expect(identityRuntimePreparation(dir, async stage => { stage('bundle'); throw error; })).rejects.toBe(error);
      const bytes = readFileSync(join(dir, 'preparation-failure.json'), 'utf8');
      expect(JSON.parse(bytes)).toMatchObject({ diagnostic: { code: 'unclassified-failure', fsCode: 'EACCES' }, artifacts: [artifact] });
      expect(bytes).not.toContain('SECRET');
      expect(bytes).not.toContain('stack');
      expect(readFileSync(artifact, 'utf8')).toBe('original compiler output');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reports a known assertion without serializing its actual or expected values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-prepare-failure-'));
    try {
      await expect(identityRuntimePreparation(dir, async stage => {
        stage('bundle');
        throw new Error('Pinned selected source receipt changed\n+ actual SECRET\n- expected SECRET');
      })).rejects.toThrow('Pinned selected');
      const bytes = readFileSync(join(dir, 'preparation-failure.json'), 'utf8');
      expect(JSON.parse(bytes).diagnostic).toEqual({ code: 'Pinned selected source receipt changed' });
      expect(bytes).not.toContain('SECRET');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('retains source failures before later stages and refuses to overwrite prior failure evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-prepare-failure-'));
    try {
      await expect(identityRuntimePreparation(dir, async () => { throw new SyntaxError('SECRET'); })).rejects.toThrow('SECRET');
      const path = join(dir, 'preparation-failure.json');
      const original = readFileSync(path, 'utf8');
      expect(JSON.parse(original)).toMatchObject({ stage: 'source-verification', diagnostic: { code: 'invalid-json' } });
      await expect(identityRuntimePreparation(dir, async stage => { stage('credential'); throw new Error('other'); })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(path, 'utf8')).toBe(original);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('returns successful preparation without inventing a failure record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-prepare-success-'));
    try {
      expect(await identityRuntimePreparation(dir, async stage => { stage('host-log'); return 'prepared'; })).toBe('prepared');
      expect(existsSync(join(dir, 'preparation-failure.json'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('independently selected identity source archive', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'identity-source-'));
    const root = join(dir, 'source'); mkdirSync(root);
    writeFileSync(join(root, 'entry.ts'), 'export const selected = true;');
    const files = verifierSourceFiles(root);
    const source = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
      testedInputs: [{ path: 'entry.ts', sha256: files[0].sha256 }], files };
    const receipt = join(dir, 'source.json');
    writeFileSync(receipt, JSON.stringify(source));
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(source));
    return { dir, root, receipt, source, env: { VERIFY_TAURI_SOURCE_RECEIPT: receipt,
      VERIFY_TAURI_SOURCE_REF: source.sourceCommit } };
  }
  it('verifies actual archive bytes and matches the loaded host without claiming other closure dimensions', () => {
    const f = fixture();
    try {
      const pin = identitySelectedSource(f.root, f.env, f.source.sourceCommit.slice(0, 12));
      expect(pin).toMatchObject({ sourceCommit: f.source.sourceCommit, scope: 'verified-source-archive-only',
        receipt: { path: f.receipt, sha256: createHash('sha256').update(readFileSync(f.receipt)).digest('hex') } });
      writeFileSync(join(f.root, 'entry.ts'), 'export const selected = false;');
      expect(() => identitySelectedSource(f.root, f.env)).toThrow();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('refuses foreign, missing and unknown loaded source identities', () => {
    const f = fixture();
    try {
      for (const sha of [null, '', 'b'.repeat(12), 'aaaaaa', 'a'.repeat(41)])
        expect(() => identitySelectedSource(f.root, f.env, sha)).toThrow('loaded source differs');
      expect(() => identitySelectedSource(f.root, { ...f.env, VERIFY_TAURI_SOURCE_REF: 'b'.repeat(40) })).toThrow();
      expect(() => identitySelectedSource(f.root, {})).toThrow('independent selected source receipt required');
      expect(() => identitySelectedSource(f.root, { ...f.env, VERIFY_TAURI_SOURCE_RECEIPT: 'relative.json' })).toThrow('exact selected');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('keeps an ordinary working source diagnostic unqualified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-working-source-'));
    try { expect(identitySelectedSource(dir, {})).toBeNull(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('actual executable bytes in the identity manifest', () => {
  it.runIf(process.platform === 'linux')('hashes the actual running executable through its proc link', async () => {
    const fingerprint = await identityExecutableFingerprint(`/proc/${process.pid}/exe`);
    expect(fingerprint.sha256).toBe(createHash('sha256').update(readFileSync(process.execPath)).digest('hex'));
    expect(BigInt(fingerprint.bytes)).toBeGreaterThan(0n);
    expect(BigInt(fingerprint.ino)).toBeGreaterThan(0n);
    expect(JSON.parse(JSON.stringify(fingerprint))).toEqual(fingerprint);
  });

  it.each(['replace', 'mutate', 'retarget'] as const)('rejects executable %s during hashing and closes the descriptor', async change => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-executable-'));
    const original = join(dir, 'original');
    const replacement = join(dir, 'replacement');
    const link = join(dir, 'exe');
    writeFileSync(original, 'old executable');
    writeFileSync(replacement, 'new executable');
    symlinkSync(original, link);
    let descriptor: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await expect(identityExecutableFingerprint(link, async path => {
        descriptor = await open(path, 'r');
        const createReadStream = descriptor.createReadStream.bind(descriptor);
        descriptor.createReadStream = options => {
          const stream = createReadStream(options);
          stream.once('data', () => {
            if (change === 'replace') renameSync(replacement, original);
            else if (change === 'mutate') writeFileSync(original, 'changed executable bytes');
            else { rmSync(link); symlinkSync(replacement, link); }
          });
          return stream;
        };
        return descriptor;
      })).rejects.toThrow('executable changed during snapshot');
      expect(descriptor?.fd).toBe(-1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails closed for missing and non-file executable links', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-executable-'));
    try {
      await expect(identityExecutableFingerprint(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(identityExecutableFingerprint(dir)).rejects.toThrow('not a regular file');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('observed native backing-file bytes', () => {
  const maps = '1000-2000 r--p 00000000 103:204 123 /lib/native library.so\n' +
    '2000-3000 r-xp 00001000 103:204 123 /lib/native library.so\n' +
    '3000-4000 rw-p 00000000 00:00 0 [heap]\n';
  const fingerprint = { path: '/host/lib/native library.so', sha256: 'a'.repeat(64),
    bytes: '8192', dev: ((0x103n << 8n) | (0x200n << 12n) | 4n).toString(),
    ino: '123', mode: '33188', mtimeNs: '1', ctimeNs: '1' };
  it('deduplicates backing files while retaining their complete mapping census and coverage limits', async () => {
    const opened: string[] = [];
    const result = await identityMappedFileFingerprints(123, { maps: async () => maps,
      start: async () => '456', fingerprint: async path => { opened.push(path); return fingerprint; } });
    expect(opened).toEqual(['/lib/native library.so']);
    expect(result.mappings).toHaveLength(2);
    expect(result.files).toEqual([{ path: '/lib/native library.so', fingerprint }]);
    expect(result.notCovered).toEqual(['anonymous-and-jit-memory', 'kernel-anonymous-io-uring-buffers', 'modified-private-pages', 'unobserved-dynamic-imports']);
  });
  it('retains kernel io_uring mappings without pretending that their buffers have file hashes', async () => {
    const withRing = maps + '4000-5000 rw-s 00000000 00:10 789 anon_inode:[io_uring]\n';
    const opened: string[] = [];
    const result = await identityMappedFileFingerprints(123, { maps: async () => withRing, start: async () => '456',
      fingerprint: async path => { opened.push(path); return fingerprint; } });
    expect(opened).toEqual(['/lib/native library.so']);
    expect(result.mappings.at(-1)).toMatchObject({ path: 'anon_inode:[io_uring]', backing: 'kernel-anonymous', inode: '789' });
    expect(result.notCovered).toContain('kernel-anonymous-io-uring-buffers');
  });
  it.each(['', 'invalid', '1000-1000 r--p 0 00:00 0',
    maps.replace('2000-3000', '1500-3000'), maps.replace('123 /lib', '123 [unknown] /lib'),
    maps.replaceAll('library.so', 'library.so (deleted)'), maps.replaceAll('library.so', 'library\\012.so')])(
    'refuses missing, malformed, overlapping or opaque maps (%s)', value => {
      expect(() => identityFileMappings(value)).toThrow();
    });
  it.each(['dev', 'ino'] as const)('refuses a replaced pathname with a different %s', async key => {
    await expect(identityMappedFileFingerprints(123, { maps: async () => maps, start: async () => '456',
      fingerprint: async () => ({ ...fingerprint, [key]: '999' }) })).rejects.toThrow('backing file identity differs');
  });
  it.each(['maps', 'start'] as const)('rejects a %s change while hashing', async change => {
    let changed = false;
    await expect(identityMappedFileFingerprints(123, {
      maps: async () => changed && change === 'maps' ? maps.replaceAll('r-xp', 'r--p') : maps,
      start: async () => changed && change === 'start' ? '457' : '456',
      fingerprint: async () => { changed = true; return fingerprint; },
    })).rejects.toThrow('mappings changed during snapshot');
  });
  it('fails closed on read permission errors and never invents an empty closure', async () => {
    await expect(identityMappedFileFingerprints(123, { maps: async () => maps, start: async () => '456',
      fingerprint: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(identityMappedFileFingerprints(123, { maps: async () => '3000-4000 rw-p 0 00:00 0 [heap]',
      start: async () => '456', fingerprint: async () => fingerprint })).rejects.toThrow('mappings unavailable');
  });
  it.runIf(process.platform === 'linux')('pins real libraries of a live process through its mount namespace', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await once(child.stdout!, 'data');
      const result = await identityMappedFileFingerprints(child.pid!);
      expect(result.files.some(file => file.fingerprint.sha256 === createHash('sha256').update(readFileSync(process.execPath)).digest('hex'))).toBe(true);
      const library = result.files.find(file => /libc\.so/.test(file.path));
      expect(library).toBeDefined();
      expect(library!.fingerprint.sha256).toBe(createHash('sha256').update(readFileSync(library!.fingerprint.path)).digest('hex'));
    } finally { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  });
});

describe('explicit isolated identity runtime boundary', () => {
  const environment = (): NodeJS.ProcessEnv => ({ HOME: '/tmp/private-fixture/home', PAPERCUSP_HOME: '/tmp/private-fixture/home/.papercusp',
    PAPERCUSP_WORKSPACES_ROOT: '/tmp/private-fixture/workspaces', PAPERCUSP_WORKSPACE: 'test-runtime-fixture',
    PAPERCUSP_WORKSPACE_ID: 'test-runtime-fixture', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:49152', PAPERCUSP_HONO_PORT: '49152',
    PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_DBOS_ROUTINES: '0', PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    PAPERCUSP_PG_PORT: '49153', HARNESS_ADMIN_DATABASE_URL: 'postgres://admin:secret@127.0.0.1:49153/test',
    HARNESS_DATABASE_URL: 'postgres://app:secret@127.0.0.1:49153/test' });
  it('admits the explicit private boundary without retaining credentials', () => {
    expect(isolatedIdentityRuntimeContract(environment())).toEqual({ origin: 'http://127.0.0.1:49152', root: '/tmp/private-fixture', workspace: 'test-runtime-fixture' });
    expect(isolatedIdentityRuntimeContract({ ...environment(), HARNESS_DATABASE_URL: 'postgres://app:secret@localhost:49153/test' }).workspace).toBe('test-runtime-fixture');
  });
  it.each([
    { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170', PAPERCUSP_HONO_PORT: '3170' },
    { PAPERCUSP_OPERATOR_URL: 'http://remote.example:49152' }, { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:49152/path' },
    { PAPERCUSP_WORKSPACE: 'papercusp-workspace' }, { PAPERCUSP_BACKGROUND_WORKERS: '1' },
    { PAPERCUSP_HOME: '/home/shared/.papercusp' }, { PAPERCUSP_WORKSPACES_ROOT: '/tmp/private-fixture-elsewhere/workspaces' },
    { HARNESS_DATABASE_URL: 'postgres://app@127.0.0.1:5432/live' }, { HARNESS_ADMIN_DATABASE_URL: 'postgres://admin@remote:49153/test' },
  ])('refuses a mixed or ambient route %j', overrides => {
    expect(() => isolatedIdentityRuntimeContract({ ...environment(), ...overrides })).toThrow('contract required');
  });
  it.runIf(process.platform === 'linux')('censuses an actual owned process group without importing shared cgroup siblings', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    await once(child, 'spawn');
    try { expect(await identityProcessGroupCensus(child.pid!)).toEqual([child.pid]); }
    finally { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    expect(await identityProcessGroupCensus(child.pid!)).toEqual([]);
  });
  it.each(['ENOENT', 'ESRCH'])('tolerates a process disappearing during enumeration (%s)', async code => {
    expect(await identityProcessGroupCensus(123, { list: async () => ['789'],
      readStat: async () => { throw Object.assign(new Error('exited'), { code }); } })).toEqual([]);
  });
  it('fails closed on unreadable or malformed process identities', async () => {
    await expect(identityProcessGroupCensus(123, { list: async () => ['789'],
      readStat: async () => { throw Object.assign(new Error('permission'), { code: 'EACCES' }); } })).rejects.toThrow('permission');
    await expect(identityProcessGroupCensus(123, { list: async () => ['789'], readStat: async () => 'malformed' })).rejects.toThrow('identity');
  });
  it('excludes kernel group zero from a positive owned group', async () => {
    expect(await identityProcessGroupCensus(123, { list: async () => ['2'],
      readStat: async () => '2 (kthreadd) S 0 0 0 0' })).toEqual([]);
  });
  const privateRuntime: IdentityRuntime = { kind: 'isolated-operator-api', origin: 'http://127.0.0.1:49152',
    mainPid: 123, processIdentity: 'linux:boot:123', bundlePath: '/tmp/private-fixture/hono-host.mjs', bundleSha256: 'a'.repeat(64) };
  const health = { ok: true, service: 'papercusp-operator', sha: null, version: '1', ts: 'observation-only' };
  it('preserves unknown source identity in a digest-pinned private diagnostic', () => {
    expect(identityLoadedHealth(health, privateRuntime)).toEqual({ ok: true, service: 'papercusp-operator', sha: null, version: '1' });
    expect(identityLoadedHealth({ ...health, sha: 'abcdef1234' }, { kind: 'staging', origin: 'http://127.0.0.1:3170' }).sha).toBe('abcdef1234');
    expect(() => identityLoadedHealth(health, { kind: 'staging', origin: 'http://127.0.0.1:3170' })).toThrow('identity unavailable');
  });
  it.each([{ mainPid: undefined }, { mainPid: 0 }, { processIdentity: undefined }, { bundlePath: 'relative.mjs' },
    { bundleSha256: undefined }, { bundleSha256: 'not-a-digest' }])('rejects missing private artifact identity %j', override => {
    expect(() => identityLoadedHealth(health, { ...privateRuntime, ...override })).toThrow('identity unavailable');
  });
  it.each([{ sha: undefined }, { sha: 'abcdef+dirty' }, { bundleStale: false }, { bundleStale: {} },
    { ok: false }, { service: 'foreign' }])('rejects invalid or stale loaded identity %j', override => {
    expect(() => identityLoadedHealth({ ...health, ...override }, privateRuntime)).toThrow('identity unavailable');
  });
});

describe('attributed current-build identity workload preparation', () => {
  it('pins exact complete SSE bytes independently of the response and rejects foreign attribution', () => {
    const fixture = identityFixture();
    const wire = JSON.parse(fixture.expectedBody.split('data: ')[1].trim());
    expect(JSON.parse(wire.result.content[0].text)).toEqual(identity);
    expect(fixture.request.expectedBodySha256).toBe(createHash('sha256').update(fixture.expectedBody).digest('hex'));
    expect(fixture.expectedBody.startsWith(':stream-open\n\nevent: message\n')).toBe(true);
    expect(fixture.expectedBody.endsWith('\n\n')).toBe(true);
    const call = JSON.parse(fixture.request.body);
    expect(call.params).toMatchObject({ name: 'coord:whoami', arguments: {} });
    expect(call.params._meta.outputGroupId).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => mcpIdentityFixture(identity, 'superuser=1&client=other&workspace=test-workspace&format=json')).toThrow('attribution');
    expect(() => mcpIdentityFixture({ ...identity, inbox_wake_key: 'other' }, '')).toThrow('verified identity');
  });
  it('retains three independently validated warmup replies and closes its session', async () => {
    let calls = 0; let closed = 0;
    const groups: string[] = [];
    const fixture = identityFixture();
    const prepare = identityPreparation(fixture, async () => {
      fixture.identity.ownerId = 'mutated-after-registration';
      return { callTool: async params => { calls++; groups.push(params._meta!.outputGroupId); return { content: [{ type: 'text', text: JSON.stringify(identity) }] }; },
        close: async () => { closed++; } };
    });
    const receipt = await prepare({ arm: 'a', journey: 'identity', stratum: 'warm', requestId: null });
    expect(calls).toBe(3); expect(closed).toBe(1);
    expect(new Set(groups).size).toBe(1);
    expect(receipt).toMatchObject({ applicationColdResetQualified: false, observations: [
      { matched: true }, { matched: true }, { matched: true },
    ] });
    await prepare({ arm: 'b', journey: 'identity', stratum: 'warm', requestId: null });
    expect(calls).toBe(6); expect(closed).toBe(2);
    expect(new Set(groups.slice(3)).size).toBe(1);
    expect(groups[3]).not.toBe(groups[0]);
  });
  it.each([false, true])('preserves strict warmup validation with the real advisory writer (mislabel turns: %s)', async mislabelTurns => {
    const sessionKey = `identity-preparation-${randomUUID()}`;
    let calls = 0; let closed = 0;
    const prepare = identityPreparation(identityFixture(), async () => ({
      callTool: async params => {
        const nudge = maybeBatchNudge({ sessionKey, callOrigin: 'agent', toolName: params.name,
          args: params.arguments, effect: 'read', canCodeRun: true,
          turnId: mislabelTurns ? randomUUID() : params._meta!.outputGroupId,
          now: 10_000 + ++calls * 2_000 });
        return { content: [{ type: 'text', text: JSON.stringify(identity) },
          ...(nudge ? [{ type: 'text', text: nudge.text }] : [])] };
      },
      close: async () => { closed++; },
    }));
    const result = prepare({ arm: 'a', journey: 'identity', stratum: 'warm', requestId: null });
    if (mislabelTurns) {
      await expect(result).rejects.toMatchObject({ failures: [
        { stage: 'validate', diagnostic: { code: 'warmup-content-shape' } },
      ] });
    } else {
      await expect(result).resolves.toMatchObject({ observations: [
        { matched: true }, { matched: true }, { matched: true },
      ] });
      expect(calls).toBe(3);
    }
    expect(closed).toBe(1);
  });
  it.each(['foreign', 'malformed', 'tool-error'])('rejects %s warmup and closes its session', async mode => {
    let closed = 0;
    const prepare = identityPreparation(identityFixture(), async () => ({
      callTool: async () => mode === 'tool-error' ? { isError: true } : { content: [{ type: 'text',
        text: mode === 'malformed' ? 'not JSON' : JSON.stringify({ ...identity, ownerId: 'foreign' }) }] },
      close: async () => { closed++; },
    }));
    await expect(prepare({ arm: 'a', journey: 'identity', stratum: 'burst', requestId: null })).rejects.toThrow();
    expect(closed).toBe(1);
  });
  it('refuses unsupported cold reset before opening a session', async () => {
    let connects = 0;
    const prepare = identityPreparation(identityFixture(), async () => { connects++; throw new Error('must not connect'); });
    await expect(prepare({ arm: 'b', journey: 'identity', stratum: 'cold', requestId: 'pair' })).rejects.toThrow('cold reset');
    expect(connects).toBe(0);
  });
  it('retains both the primary validation failure and cleanup failure without leaking opaque errors', async () => {
    const prepare = identityPreparation(identityFixture(), async () => ({
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ...identity, ownerId: 'foreign' }) }] }),
      close: async () => { throw new Error('Bearer secret-token'); },
    }));
    const error = await prepare({ arm: 'a', journey: 'identity', stratum: 'warm', requestId: null }).catch(error => error);
    expect(error).toBeInstanceOf(IdentityPreparationError);
    expect(error.failures).toEqual([
      { stage: 'validate', diagnostic: { code: 'warmup attribution differs' } },
      { stage: 'close', diagnostic: { code: 'unclassified-failure' } },
    ]);
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });
  it('retains safe connection failure diagnostics even when the final census also fails', async () => {
    const manifest: PerfWorkloadManifest = { source: { sha: 'pinned' }, configuration: {}, runtime: {}, host: {}, workload: {}, fixture: {} };
    let captures = 0;
    const prepare = identityPreparation(identityFixture(), async () => {
      throw new AgentMcpConnectionError('http', Object.assign(new Error('Bearer secret-token'), { code: 'ECONNREFUSED' }));
    });
    const probe = await identityPreparationProbe(async () => {
      if (++captures > 1) throw new Error('staging census changed during snapshot');
      return manifest;
    }, () => prepare({ arm: 'a', journey: 'identity', stratum: 'warm', requestId: null }));
    expect(probe.initial.manifest).toEqual(manifest);
    expect(probe.initial.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(probe.failures).toEqual([{ stage: 'connect', diagnostic: { code: 'http_connection_failed',
      connection: { category: 'network', systemCode: 'ECONNREFUSED' } } }]);
    expect(probe.final).toEqual({ manifest: null, hash: null, failure: { code: 'staging census changed during snapshot' } });
    expect(probe.preparation).toBeNull();
    expect(probe.manifestStable).toBe(false);
    expect(JSON.stringify(probe)).not.toContain('secret-token');
  });
  it('retains preparation evidence when the initial census is unavailable, without claiming a stable manifest', async () => {
    const probe = await identityPreparationProbe(async () => { throw new Error('staging census changed during snapshot'); },
      async () => ({ observations: [{ matched: true }] }));
    expect(probe.preparation).toEqual({ observations: [{ matched: true }] });
    expect(probe.initial.failure).toEqual({ code: 'staging census changed during snapshot' });
    expect(probe.final.failure).toEqual(probe.initial.failure);
    expect(probe.manifestStable).toBe(false);
  });
});

function response(ids: string[]) {
  return { ok: true, results: ids.map(id => ({ id, ok: true, availability: 'available',
    workItem: { id, state: 'open' } })), counts: { ok: ids.length, failed: 0 },
    read: { schemaVersion: 'work-items-get-read-v1', mode: 'projected', requested: ids.length,
      available: ids.length, absent: 0, unavailable: 0, elapsedMs: 10,
      outerStageAttribution: 'dispatch/projection/serialization time' } };
}

describe('live work-item summary cohort oracle', () => {
  it('refuses duplicate identities, missing state, unavailable rows and lost top-level disclosure', () => {
    expect(validateSummary(response(['WI-A', 'WI-B']), ['WI-A', 'WI-B'])).toEqual([]);
    const duplicate = response(['WI-A', 'WI-A']);
    expect(validateSummary(duplicate, ['WI-A', 'WI-B'])).not.toEqual([]);
    const missingState = response(['WI-A']);
    missingState.results[0]!.workItem.state = '';
    expect(validateSummary(missingState, ['WI-A'])).not.toEqual([]);
    const unavailable = response(['WI-A']);
    unavailable.results[0]!.availability = 'unavailable';
    expect(validateSummary(unavailable, ['WI-A'])).not.toEqual([]);
    expect(validateSummary({ ...response(['WI-A']), read: undefined }, ['WI-A'])).not.toEqual([]);
  });

  it('refuses an incomplete or duplicated matrix and non-finite latency', () => {
    const sample: Sample = { size: 1, repeat: 1, wallMs: 10, valid: true, failures: [], read: {} };
    expect(judgeSamples([sample], 1, 1).passed).toBe(true);
    expect(judgeSamples([sample], 1, 2).passed).toBe(false);
    expect(judgeSamples([sample, sample], 1, 2).passed).toBe(false);
    expect(judgeSamples([{ ...sample, wallMs: NaN }], 1, 1).passed).toBe(false);
    expect(judgeSamples([{ ...sample, wallMs: 2_001 }], 1, 1).passed).toBe(false);
  });

  it('retains failed calls instead of dropping them from the p95 denominator', async () => {
    let ticks = 0;
    let calls = 0;
    const out = await runSummaryCohort({ ids: ['WI-A', 'WI-B'], repeats: 2,
      now: () => ticks++ * 10, call: async ids => {
        if (++calls === 2) throw new Error('opaque private transport detail');
        return response(ids);
      } });
    expect(out.samples).toHaveLength(4);
    expect(out.samples.map(sample => [sample.size, sample.repeat])).toEqual([[1, 1], [2, 1], [1, 2], [2, 2]]);
    expect(out.samples[1]!.valid).toBe(false);
    expect(JSON.stringify(out)).not.toContain('opaque private transport detail');
    expect(out.verdict.complete).toBe(true);
    expect(out.verdict.passed).toBe(false);
  });

  it('validates matrix inputs before making an MCP call', async () => {
    let calls = 0;
    const call = async () => { calls += 1; return {}; };
    await expect(runSummaryCohort({ ids: ['WI-A', 'WI-A'], repeats: 1, call })).rejects.toThrow('distinct');
    await expect(runSummaryCohort({ ids: ['WI-A'], repeats: 0, call })).rejects.toThrow('repeats');
    expect(calls).toBe(0);
  });
});
