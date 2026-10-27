/** D038 safety checks only: no staging server, native claim or R20 replay. */
import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runStagingReuseFixture, assertReuseStagingRuntime, type ReuseStagingOptions,
  stagingReuseCliEnvironment, prepareStagingReuseFixture, stagingFixturePlanSlug,
  type ReuseStagingPorts } from './reuse-staging-fixture';
import { nativeCliCall } from './native-cli.fixture';
import * as registry from '../harness-registry';
import { runNativeReuseJourney, privateReuseHarnessRegistration, createControlledReusePlan } from './__fixtures__/reuse-api-journey';
import { ensureDatedSlug } from '../agent-tools/plans/new';
import { cleanupReuseFixture, type ReuseFixtureIdentity, type ReuseFixtureLifecyclePorts } from './reuse-fixture-lifecycle';

const runtime = { kind: 'staging-operator' as const, operatorUrl: 'http://127.0.0.1:3170/api/mcp',
  workspace: 'safety-workspace', owner: 'su-safety', buildId: 'safety-build',
  handlerHash: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), testFingerprint: 'c'.repeat(64),
  environmentFingerprint: 'd'.repeat(64) };
let options: ReuseStagingOptions;
const roots: ReuseFixtureIdentity[] = [];
beforeEach(async () => {
  const prepared = await prepareStagingReuseFixture(runtime.workspace, runtime.owner);
  roots.push(prepared);
  options = { runtime, prepared, repo: '/safety-repo', pot: 'safety-pot', verifyRuntime: async () => runtime };
});
afterEach(async () => {
  for (const fixture of roots.splice(0)) {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.evidenceRoot, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function harness() {
  const entries = new Map<string, any>(), claims = new Map<string, any>(), sessions = new Map<number, any>();
  const lifecycle: ReuseFixtureLifecyclePorts = {
    readHarness: async (_workspace, slug) => entries.get(slug) ?? null,
    removeHarness: vi.fn(async (_workspace, entry) => { entries.delete(entry.slug); }),
    readClaim: async pin => claims.get(pin.id) ?? null,
    releaseClaim: vi.fn(async (_fixture, pin) => { claims.get(pin.id).owner = null; return true; }),
    readSession: async id => sessions.get(id) ?? null,
    endSession: vi.fn(async (_fixture, pin) => { sessions.get(pin.id).ended = true; return true; }),
  };
  const call = vi.fn(async (name: string, args: Record<string, any>) => {
    if (name === 'coord:whoami') return { workspaceId: runtime.workspace, ownerId: runtime.owner };
    if (name === 'harness:create') {
      entries.set(args.slug, { slug: args.slug, path: args.path,
        registrationOnly: { commitSha: args.expectedCommit }, hive_slug: args.pot });
      return { ok: true };
    }
    return { ok: true, receipt: 'actual test-port response' };
  });
  const remember = async (root: string) => {
    const fixture = JSON.parse(await readFile(join(root, '.reuse-fixture-owner.json'), 'utf8')) as ReuseFixtureIdentity;
    if (!roots.some(row => row.token === fixture.token)) roots.push(fixture);
    return fixture;
  };
  return { entries, claims, sessions, lifecycle, call, remember };
}

it('pins ptool scope instead of inheriting another harness or owner', () => {
  const inherited = { PAPERCUSP_SID: 'sibling', PAPERCUSP_WORKSPACE: 'other',
    PAPERCUSP_HARNESS_SLUG: 'papercusp', PAPERCUSP_MCP_PROXY_PORT: '9071' };
  const env = stagingReuseCliEnvironment(runtime, 'r-fixture', inherited);
  const invoke = vi.fn(() => ({ status: 0, stdout: '{"ok":true}', stderr: '', signal: null }));
  expect(nativeCliCall(runtime.operatorUrl, 'fixture:read', {}, invoke as never, { env })).toEqual({ ok: true });
  expect((invoke.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env)
    .toMatchObject({ PAPERCUSP_SID: runtime.owner, PAPERCUSP_WORKSPACE: runtime.workspace,
      PAPERCUSP_HARNESS_SLUG: 'r-fixture', PAPERCUSP_MCP_PROXY_PORT: '9171' });
  expect(inherited.PAPERCUSP_SID).toBe('sibling');
});

it.each(['http://127.0.0.1:3070/api/mcp', 'http://example.invalid:3170/api/mcp',
  'http://127.0.0.1:3170/api/mcp?client=other'])('refuses unsafe endpoint %s before setup', async operatorUrl => {
  const fx = harness();
  await expect(runStagingReuseFixture({ ...options, runtime: { ...runtime, operatorUrl } }, fx)).rejects.toThrow('staging MCP');
  expect(fx.call).not.toHaveBeenCalled();
});

it('refuses private workspaces, missing fingerprints, moved artifacts and transport ownership', async () => {
  expect(() => assertReuseStagingRuntime({ ...runtime, workspace: 'test-runtime-private' })).toThrow('shared staging');
  expect(() => assertReuseStagingRuntime({ ...runtime, testFingerprint: '' })).toThrow('testFingerprint');
  const fx = harness();
  await expect(runStagingReuseFixture({ ...options, verifyRuntime: async () => ({ ...runtime, buildId: 'moved' }) }, fx))
    .rejects.toThrow('runtime identity changed');
  expect(fx.call).not.toHaveBeenCalled();
  await expect(runStagingReuseFixture(options, { ...fx,
    call: async () => ({ workspaceId: runtime.workspace, ownerId: 'sibling' }) })).rejects.toThrow('ownership mismatch');
});

it('prepares only local identity, rejects tampering and runtime mismatch before shared writes', async () => {
  const fx = harness();
  const fixture = options.prepared;
  expect(stagingFixturePlanSlug(fixture)).toMatch(new RegExp(`^r-${fixture.token.slice(0, 8)}-\\d{4}-\\d{2}-\\d{2}$`));
  const journal = JSON.parse(await readFile(join(fixture.evidenceRoot, 'lifecycle.json'), 'utf8'));
  expect(journal).toMatchObject({ claims: [], sessions: [], cleaned: false });
  expect(journal.harness).toBeUndefined(); expect(journal.executionStarted).toBeUndefined();
  await expect(runStagingReuseFixture({ ...options, prepared: { ...fixture, owner: 'sibling' } }, fx))
    .rejects.toThrow('runtime ownership mismatch');
  expect(fx.call).not.toHaveBeenCalled();
  await expect(runStagingReuseFixture({ ...options, prepared: { ...fixture, token: 'tampered' } }, fx))
    .rejects.toThrow('ownership mismatch');
  expect(fx.call.mock.calls.map(([name]) => name)).toEqual(['coord:whoami']);
  expect((await lstat(fixture.root)).isDirectory()).toBe(true);
});

it('binds the prepared dated plan across midnight using the canonical plan writer', async () => {
  const fixture = await prepareStagingReuseFixture(runtime.workspace, runtime.owner,
    new Date('2026-10-25T23:59:59.999Z'));
  roots.push(fixture);
  const slug = stagingFixturePlanSlug(fixture);
  expect(slug).toBe(`r-${fixture.token.slice(0, 8)}-2026-10-25`);
  const marker = JSON.parse(await readFile(join(fixture.root, '.reuse-fixture-owner.json'), 'utf8'));
  const journal = JSON.parse(await readFile(join(fixture.evidenceRoot, 'lifecycle.json'), 'utf8'));
  expect(marker.planSlug).toBe(slug); expect(journal.planSlug).toBe(slug);
  const call = vi.fn(async (name: string, args: Record<string, any>) => name === 'plans:new'
    ? { ok: true, slug: ensureDatedSlug(args.slug, '2026-10-26') }
    : { results: [{ ok: true, itemId: 'P-001' }] });
  const harnessSlug = `r-${fixture.token.slice(0, 8)}`;
  await expect(createControlledReusePlan(call, harnessSlug, slug, 'a.ts')).resolves.toMatchObject({ planItem: 'P-001' });
  expect(call.mock.calls.map(([name, args]) => ({ name, slug: args.slug, harness: args.harness }))).toEqual([
    { name: 'plans:new', slug, harness: harnessSlug }, { name: 'plans:add-item', slug, harness: harnessSlug },
  ]);
  const fx = { ...harness(), journey: vi.fn(async () => {}) };
  await expect(runStagingReuseFixture({ ...options, prepared: { ...options.prepared, planSlug: slug } }, fx))
    .rejects.toThrow('ownership mismatch');
  expect(fx.journey).not.toHaveBeenCalled();
});

it('refuses a canonicalized or missing plan response before adding anchors', async () => {
  for (const response of [{ ok: true, slug: 'unexpected-2026-10-26' }, { ok: true }]) {
    const call = vi.fn(async () => response);
    await expect(createControlledReusePlan(call, 'r-fixture', 'r-fixture-2026-10-25', 'a.ts'))
      .rejects.toThrow('plan identity changed');
    expect(call).toHaveBeenCalledTimes(1);
  }
});

it('consumes the frozen identity once and refuses repeat execution before shared writes', async () => {
  const fx = harness();
  const journey = vi.fn(async () => {});
  const result = await runStagingReuseFixture(options, { ...fx, journey });
  expect(result.fixture).toEqual(options.prepared);
  expect(result.planSlug).toBe(stagingFixturePlanSlug(options.prepared));
  await expect(runStagingReuseFixture(options, { ...fx, journey })).rejects.toThrow('already used');
  expect(journey).toHaveBeenCalledTimes(1);
  expect(fx.call.mock.calls.map(([name]) => name)).toEqual(['coord:whoami', 'coord:whoami']);
});

it('keeps private guards intact and refuses direct shared-workspace use', async () => {
  expect(() => privateReuseHarnessRegistration(runtime.workspace, 'r', '/tmp/r', 'a'.repeat(40))).toThrow('Private');
  await expect(runNativeReuseJourney({ call: vi.fn(), workspace: runtime.workspace, owner: runtime.owner,
    root: '/tmp/must-not-exist', repo: options.repo, handlerHash: runtime.handlerHash, claimOnly: true }))
    .rejects.toThrow('Private runtime');
});

it.each(['setup', 'claim', 'test', 'success'] as const)('cleans owned resources and retains receipts after %s', async phase => {
  const fx = harness();
  let fixture!: ReuseFixtureIdentity;
  const beforeEnv = { ...process.env };
  const journey: ReuseStagingPorts['journey'] = async ({ managed, root, call }) => {
    fixture = await fx.remember(root); expect(managed).toBeDefined();
    const m = managed!;
    expect(m.snapshotPath).toContain(`/graph-snapshot/${m.harness}/`);
    expect(m.sessionId).toContain(fixture.token);
    if (phase === 'setup') throw new Error('setup failed');
    await m.register('a'.repeat(40));
    fx.claims.set('WI-safety', { workspaceId: runtime.workspace, harness: m.harness, owner: null });
    await m.trackClaim('WI-safety');
    fx.claims.get('WI-safety').owner = runtime.owner;
    await call('work_items:claim', { id: 'WI-safety', harness: m.harness });
    if (phase === 'claim') throw new Error('claim failed');
    await m.createSession(async () => {
      fx.sessions.set(1, { id: 1, sessionId: m.sessionId, startedAt: '2026-10-25 20:00:00.123456+00',
        planSlug: m.planSlug, workspaceId: runtime.workspace, owner: runtime.owner, root, ended: false });
      return 1;
    });
    await call('testing:run', { work_item_id: 'WI-safety', harness: m.harness, files: ['a.test.ts'] });
    if (phase === 'test') throw new Error('test failed');
    await m.retainProof({ scope: 'safety test port only', fixture: fixture.token });
  };
  const result = runStagingReuseFixture(options, { ...fx, journey });
  if (phase === 'success') await result; else await expect(result).rejects.toThrow('retained evidence');
  await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(process.env).toEqual(beforeEnv);
  expect(fx.entries.size).toBe(0);
  expect([...fx.claims.values()].every(row => row.owner === null)).toBe(true);
  expect([...fx.sessions.values()].every(row => row.ended)).toBe(true);
  const receipts = (await readFile(join(fixture.evidenceRoot, 'client.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(receipts.at(-1).payload.phase).toBe('cleanup');
  expect(JSON.parse(await readFile(join(fixture.evidenceRoot, 'runtime.json'), 'utf8')).runtime).toEqual(runtime);
  if (phase === 'success') expect(JSON.parse(await readFile(join(fixture.evidenceRoot, 'proof.json'), 'utf8')))
    .toEqual({ scope: 'safety test port only', fixture: fixture.token });
  await expect(cleanupReuseFixture(fixture, fx.lifecycle)).resolves.toMatchObject({ cleaned: true });
});

it('recovers a session committed before the writer response failed', async () => {
  const fx = harness(); let fixture!: ReuseFixtureIdentity;
  await expect(runStagingReuseFixture(options, { ...fx, findSession: async () => [7],
    journey: async ({ managed, root }) => {
      fixture = await fx.remember(root); const m = managed!;
      await m.register('a'.repeat(40));
      await m.createSession(async () => {
        fx.sessions.set(7, { id: 7, sessionId: m.sessionId, startedAt: '2026-10-25 20:00:00.123456+00',
          planSlug: m.planSlug, workspaceId: runtime.workspace, owner: runtime.owner, root, ended: false });
        throw new Error('response lost after canonical commit');
      });
    } })).rejects.toThrow('retained evidence');
  expect(fx.sessions.get(7).ended).toBe(true);
  await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses changed ownership and preserves the recovery journal', async () => {
  const fx = harness(); let fixture!: ReuseFixtureIdentity;
  await expect(runStagingReuseFixture(options, { ...fx, journey: async ({ managed, root }) => {
    fixture = await fx.remember(root); const m = managed!;
    await m.register('a'.repeat(40));
    fx.claims.set('WI-safety', { workspaceId: runtime.workspace, harness: m.harness, owner: 'sibling' });
    await m.trackClaim('WI-safety');
  } })).rejects.toThrow('cleanup incomplete');
  expect(fx.lifecycle.releaseClaim).not.toHaveBeenCalled();
  expect(fx.lifecycle.removeHarness).not.toHaveBeenCalled();
  expect((await lstat(fixture.root)).isDirectory()).toBe(true);
  expect(await readFile(join(fixture.evidenceRoot, 'lifecycle.json'), 'utf8')).toContain('WI-safety');
});

it('sees a cross-process harness collision hidden by the local cache before registration', async () => {
  const fx = harness(); let existing: registry.ProjectEntry | undefined;
  const read = vi.spyOn(registry, 'loadHarnessRegistry').mockImplementation(async (_workspace, opts) => ({
    projects: opts?.fresh && existing ? [existing] : [],
  }));
  await expect(runStagingReuseFixture(options, { call: fx.call, journey: async ({ managed, root }) => {
    await fx.remember(root); const m = managed!;
    existing = { slug: m.harness, path: '/sibling-owned-root' };
    await m.register('a'.repeat(40));
  } })).rejects.toThrow('retained evidence');
  expect(read).toHaveBeenCalledWith(runtime.workspace, { fresh: true });
  expect(fx.call.mock.calls.map(([name]) => name)).toEqual(['coord:whoami']);
  // No fixture membership was ever registered/journaled, so failure cleanup
  // removes only the new runtime root and never invokes canonical PG writers.
  await expect(lstat(roots[0]!.root)).rejects.toMatchObject({ code: 'ENOENT' });
});
