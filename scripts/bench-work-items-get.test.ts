import { describe, expect, it } from 'vitest';
import { judgeSamples, runSummaryCohort, validateSummary, mcpIdentityFixture, identityPreparation, identityPreparationProbe, IdentityPreparationError, isolatedIdentityRuntimeContract, identityProcessGroupCensus, identityLoadedHealth, identitySelectedSource, type IdentityRuntime, type Sample, type McpIdentityFixture } from './bench-work-items-get';
import { AgentMcpConnectionError } from '../packages/operator-core/lib/agent-mcp-client';
import { maybeBatchNudge } from '../packages/operator-core/lib/code-run-batch-nudge';
import type { PerfWorkloadManifest } from '../packages/operator-core/lib/system-health/perf-workload-run';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifierSourceFiles } from '../packages/operator-core/lib/verifier-source';

const identity: McpIdentityFixture = { ownerId: 'su-fixture', ownerLabel: 'Fixture', source: 'test', workspaceId: 'test-workspace',
  userId: null, fleetSlug: null, fleetRole: null, inbox_wake_key: 'coord:inbox-wake:su-fixture' };
const identityFixture = () => mcpIdentityFixture(identity, 'superuser=1&client=su-fixture&workspace=test-workspace&format=json');

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
