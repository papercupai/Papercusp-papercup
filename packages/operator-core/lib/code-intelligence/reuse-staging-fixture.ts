/** D038: the controlled R20 journey on staging, with D039 disposal and retained
 * client evidence. Importing this module never runs an acceptance action. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nativeCliCall } from './native-cli.fixture';
import { runNativeReuseJourney, type ManagedReuseJourney } from './__fixtures__/reuse-api-journey';
import { cleanupReuseFixture, createReuseFixture, trackReuseFixture, reuseFixtureLifecyclePorts,
  activatePreparedReuseFixture, type ReuseFixtureIdentity, type ReuseFixtureLifecyclePorts } from './reuse-fixture-lifecycle';

export interface ReuseStagingRuntime {
  kind: 'staging-operator';
  operatorUrl: string;
  workspace: string;
  owner: string;
  buildId: string;
  handlerHash: string;
  sourceFingerprint: string;
  testFingerprint: string;
  environmentFingerprint: string;
}

export function assertReuseStagingRuntime(runtime: ReuseStagingRuntime) {
  const url = new URL(runtime.operatorUrl);
  assert(runtime.kind === 'staging-operator' && url.protocol === 'http:' && url.port === '3170'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && url.pathname === '/api/mcp' && !url.search && !url.hash && !url.username && !url.password,
  'Explicit local staging MCP endpoint required');
  assert(runtime.workspace.trim() && !runtime.workspace.startsWith('test-runtime-')
    && runtime.owner.trim() && runtime.buildId.trim(), 'Explicit shared staging identity required');
  for (const field of ['handlerHash', 'sourceFingerprint', 'testFingerprint', 'environmentFingerprint'] as const)
    assert(/^[a-f0-9]{64}$/.test(runtime[field]), `Exact ${field} required`);
}

export function stagingReuseCliEnvironment(runtime: ReuseStagingRuntime, harness: string | null,
  inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  assertReuseStagingRuntime(runtime);
  const env = { ...inherited, PAPERCUSP_SID: runtime.owner, PAPERCUSP_WORKSPACE: runtime.workspace,
    PAPERCUSP_HARNESS_SLUG: harness ?? '' };
  return env;
}

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
export interface ReuseStagingOptions {
  runtime: ReuseStagingRuntime;
  prepared: ReuseFixtureIdentity;
  repo: string;
  /** Read current pipeline/artifact evidence immediately before execution.
   * A changed serving artifact refuses before creating any fixture resource. */
  verifyRuntime: () => Promise<ReuseStagingRuntime>;
  /** Actual pot membership, explicitly selected rather than inferred from workspace. */
  pot: string;
}

/** Local preparation only: no harness, plan, session, claim or native action. */
export const prepareStagingReuseFixture = createReuseFixture;
export const stagingFixturePlanSlug = (fixture: ReuseFixtureIdentity) => fixture.planSlug;
export interface ReuseStagingPorts {
  call?: Call;
  journey?: typeof runNativeReuseJourney;
  lifecycle?: ReuseFixtureLifecyclePorts;
  findSession?: (scope: { workspace: string; owner: string; root: string; session: string; plan: string }) => Promise<number[]>;
}

export async function runStagingReuseFixture(options: ReuseStagingOptions, ports: ReuseStagingPorts = {}) {
  const { runtime, repo, pot, prepared: fixture } = options;
  assertReuseStagingRuntime(runtime);
  assert(fixture.workspaceId === runtime.workspace && fixture.owner === runtime.owner,
    'Prepared fixture runtime ownership mismatch');
  assert(pot.trim() && repo.startsWith('/'), 'Explicit pot and source repository required');
  assert(isDeepStrictEqual(await options.verifyRuntime(), runtime), 'Staging runtime identity changed');
  const endpoint = new URL(runtime.operatorUrl);
  endpoint.searchParams.set('workspace', runtime.workspace);
  endpoint.searchParams.set('client', runtime.owner);
  const rawCall: Call = ports.call ?? (async (name, args) => nativeCliCall(endpoint.toString(), name, args,
    undefined, { env: stagingReuseCliEnvironment(runtime, endpoint.searchParams.get('harness')) }));
  const identity = await rawCall('coord:whoami', {});
  assert(identity.workspaceId === runtime.workspace && identity.ownerId === runtime.owner,
    'Staging transport ownership mismatch');
  // Runtime and transport are revalidated immediately before consuming the
  // frozen identity. No shared fixture writes happened during preparation.
  await activatePreparedReuseFixture(fixture);
  // All filesystem and database namespaces derive from the same unique token.
  // Short authored namespaces preserve the mandatory brief budget. Collisions
  // refuse before registration; the journal still retains the full UUID.
  const harness = `r-${fixture.token.slice(0, 8)}`, planSlug = stagingFixturePlanSlug(fixture);
  const lifecycle = ports.lifecycle ?? {
    ...reuseFixtureLifecyclePorts,
    async readHarness(workspaceId: string, slug: string) {
      // This standalone client does not run the operator's cache invalidation
      // subscriber. Registration happened in another process; identity checks
      // must observe that committed registry write immediately.
      const { loadHarnessRegistry } = await import('../harness-registry');
      return (await loadHarnessRegistry(workspaceId, { fresh: true })).projects
        .find(entry => entry.slug === slug) ?? null;
    },
  };
  let sessionPending = false;
  let sequence = 0;
  const receipt = async (record: unknown) => {
    const payload = JSON.stringify(record);
    await appendFile(join(fixture.evidenceRoot, 'client.jsonl'), JSON.stringify({ sequence: ++sequence,
      sha256: createHash('sha256').update(payload).digest('hex'), payload: record }) + '\n', { mode: 0o600 });
  };
  const call: Call = async (name, args) => {
    await receipt({ phase: 'request', name, args });
    try {
      const response = await rawCall(name, args);
      await receipt({ phase: 'response', name, response });
      return response;
    } catch (error) {
      await receipt({ phase: 'error', name, error: String(error) });
      throw error;
    }
  };
  const managed: ManagedReuseJourney = {
    root: fixture.root, harness, planSlug, sessionId: `controlled-cli-${fixture.token}`,
    snapshotPath: join(homedir(), '.papercusp/graph-snapshot', harness, 'dependency-snapshot.json'),
    async register(baseline) {
      const entry = { slug: harness, path: fixture.root,
        registrationOnly: { commitSha: baseline }, hive_slug: pot };
      // Journal before the fallible registration; cleanup can find a write
      // whose transport response was lost, without touching a sibling entry.
      assert(await lifecycle.readHarness(fixture.workspaceId, harness) === null, 'Fixture harness already exists');
      await trackReuseFixture(fixture, { harness: entry });
      const response = await call('harness:create', { slug: harness, path: fixture.root, pot,
        registrationOnly: true, expectedCommit: baseline,
        projection: { pick: ['ok', 'slug', 'path'] } });
      assert(response.ok === true, JSON.stringify(response));
      assert(isDeepStrictEqual(await lifecycle.readHarness(fixture.workspaceId, harness), entry),
        'Registered fixture identity mismatch');
      // The fixture does not exist during registration; only subsequent calls
      // may select it as their transport harness.
      endpoint.searchParams.set('harness', harness);
    },
    async trackClaim(id) { await trackReuseFixture(fixture, { claim: { id, harness } }); },
    async retainProof(proof) {
      await writeFile(join(fixture.evidenceRoot, 'proof.json'), JSON.stringify(proof, null, 2),
        { mode: 0o600, flag: 'wx' });
      await receipt({ phase: 'proof', sha256: createHash('sha256').update(JSON.stringify(proof)).digest('hex') });
    },
    async createSession(create) {
      await receipt({ phase: 'session-intent', sessionId: managed.sessionId, planSlug, root: fixture.root });
      sessionPending = true;
      const id = await create();
      assert(id, 'Controlled session writer returned no id');
      const session = await lifecycle.readSession(id);
      assert(session && session.workspaceId === fixture.workspaceId && session.owner === fixture.owner
        && session.root === fixture.root && session.sessionId === managed.sessionId && session.planSlug === planSlug,
      'Controlled session identity mismatch');
      await trackReuseFixture(fixture, { session });
      sessionPending = false;
      return id;
    },
  };
  let failure: unknown, failed = false;
  try {
    await writeFile(join(fixture.evidenceRoot, 'runtime.json'), JSON.stringify({ runtime, fixture, harness,
      planSlug, snapshotPath: managed.snapshotPath,
      scope: 'controlled staging CLI fixture; no model invocation, live-user census or shipment' }, null, 2),
    { mode: 0o600, flag: 'wx' });
    const { runWithWorkspace } = await import('../workspace-als');
    await runWithWorkspace(runtime.workspace, () => (ports.journey ?? runNativeReuseJourney)({ call,
      workspace: runtime.workspace, root: fixture.root, owner: runtime.owner, repo,
      handlerHash: runtime.handlerHash, claimOnly: true, managed }));
  } catch (error) { failure = error; failed = true; }
  try {
    // If the session writer or its readback failed after commit, recover using
    // only the exact pre-journaled identity. Never dispose an unverified row.
    if (sessionPending) {
      const scope = { workspace: runtime.workspace, owner: runtime.owner, root: fixture.root,
        session: managed.sessionId, plan: planSlug };
      const find = ports.findSession ?? (async (pin: typeof scope) => {
        const { boundedOrgTxn } = await import('../pg-bounded-txn');
        const rows = await boundedOrgTxn(tx => tx<{ id: number }[]>`SELECT id FROM harness_shared.adv_sessions
          WHERE workspace_id = ${pin.workspace} AND coord_owner_id = ${pin.owner} AND cwd = ${pin.root}
            AND session_id = ${pin.session} AND plan_slug = ${pin.plan}`,
        { readOnly: true, phase: 'reuse-fixture:session-recovery' });
        return rows.map(row => Number(row.id));
      });
      const ids = await find(scope);
      assert(ids.length <= 1, 'Ambiguous controlled session identity');
      if (ids[0]) {
        const session = await lifecycle.readSession(ids[0]);
        assert(session && session.workspaceId === runtime.workspace && session.owner === runtime.owner
          && session.root === fixture.root && session.sessionId === managed.sessionId && session.planSlug === planSlug,
        'Recovered controlled session identity mismatch');
        await trackReuseFixture(fixture, { session });
      }
    }
    const cleanup = await cleanupReuseFixture(fixture, lifecycle);
    await receipt({ phase: 'cleanup', cleanup });
  } catch (error) {
    throw new AggregateError(failed ? [failure, error] : [error],
      `Fixture cleanup incomplete; retained recovery journal: ${fixture.evidenceRoot}`);
  }
  if (failed) throw new Error(`Staging fixture failed; retained evidence: ${fixture.evidenceRoot}`, { cause: failure });
  return { fixture, harness, planSlug, evidenceRoot: fixture.evidenceRoot };
}
