/** Original routing producer statements, executed at their real dependency seams. */
import ts from 'typescript';
import { execute, source } from './host-startup-migration-cases';
import type { RailMigrationCase } from './rail-migration-cases';
type Observation = { eligible: number; applied: number; reason: string; scope?: string | null };
const root = 'packages/operator-core/lib/';
function sink(mechanism: string, observations: Observation[]) {
  return (name: string, row: Observation, options: { workspaceId?: string }) => {
    if (name !== mechanism || options.workspaceId !== 'fixture') throw new Error('unexpected routing observation partition');
    observations.push(row); return true;
  };
}
function statements(path: string, name: string): ts.NodeArray<ts.Statement> {
  const fn = source(path).statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) throw new Error(`missing original function ${name}`);
  return fn.body.statements;
}
export const AGENT_ROUTING_MIGRATION_CASES: RailMigrationCase[] = [{
  id: 'escalation-standdown-original-reader-failure-empty-held-and-injected-exclusion',
  item: 'P-013', route: 'observation', mechanism: 'workspace-routing-read',
  rowIds: [`log-only-fallback|${root}attention/reconcile-escalations.ts|rerouteUnackedEscalationsOnce|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const body = statements(`${root}attention/reconcile-escalations.ts`, 'rerouteUnackedEscalationsOnce');
    const selected = ['const workspaceId =', 'const standdownFn ='].map(prefix => {
      const node = body.find(node => node.getText().startsWith(prefix));
      if (!node) throw new Error(`missing original ${prefix}`);
      return node.getText();
    }).join('\n');
    const observations: Observation[] = [];
    let fail = true, held = false;
    const bindings = { opts: { workspaceId: 'fixture' }, coordWorkspaceId: () => 'wrong-workspace', coordSql: () => ({}),
      observeFallback: sink('workspace-routing-read', observations),
      listLoopStanddownOwners: async () => { if (fail) throw new Error('standdown unavailable'); return new Set(held ? ['held-owner'] : []); } };
    const run = (input = bindings) => execute(`${selected}\nreturn await standdownFn(0);`, input) as Promise<Set<string>>;
    expect([...(await run())]).toEqual([]);
    fail = false; expect([...(await run())]).toEqual([]);
    held = true; expect([...(await run())]).toEqual(['held-owner']);
    await execute(`${selected}\nreturn await standdownFn(0);`, { ...bindings,
      opts: { workspaceId: 'fixture', listLoopStanddownOwnersFn: async () => new Set(['injected']) } });
    expect(observations.map(row => [row.applied, row.reason, row.scope])).toEqual([
      [0, 'standdown-read-failed', 'escalation-standdown'], [1, 'applied', 'escalation-standdown'], [1, 'applied', 'escalation-standdown']]);
    return { route: 'observation', mechanism: 'workspace-routing-read', observations };
  },
}, {
  id: 'scheduled-blueprint-original-primary-and-unconfigured-default',
  item: 'P-013', route: 'observation', mechanism: 'scheduled-blueprint-resolution',
  rowIds: [`log-only-fallback|${root}blueprint/blueprint-run-action.ts|handleBlueprintRun|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const body = statements(`${root}blueprint/blueprint-run-action.ts`, 'handleBlueprintRun');
    const start = body.findIndex(node => node.getText().startsWith('const resolve ='));
    const end = body.findIndex(node => node.getText().startsWith("observeFallback('scheduled-blueprint-resolution'"));
    if (start < 0 || end < start) throw new Error('missing original blueprint resolution');
    const text = body.slice(start, end + 1).map(node => node.getText()).join('\n');
    const observations: Observation[] = [];
    let configured = false, fallbackCalls = 0;
    const bindings = { installSlug: 'pot', workspaceId: 'fixture', _resolver: null,
      resolveBlueprint: async () => configured ? { id: 'configured' } : null,
      codingFallback: () => { fallbackCalls++; return { id: 'coding-default' }; },
      observeFallback: sink('scheduled-blueprint-resolution', observations) };
    expect(await execute(`${text}\nreturn bp;`, bindings)).toEqual({ id: 'coding-default' });
    configured = true; expect(await execute(`${text}\nreturn bp;`, bindings)).toEqual({ id: 'configured' });
    expect(fallbackCalls).toBe(1);
    expect(observations.map(row => [row.applied, row.reason, row.scope])).toEqual([[0, 'blueprint-unconfigured', 'pot'], [1, 'applied', 'pot']]);
    return { route: 'observation', mechanism: 'scheduled-blueprint-resolution', observations };
  },
}, {
  id: 'tracked-backend-original-default-rescue-explicit-refusal-supported-codex-and-untracked-exclusion',
  item: 'P-013', route: 'observation', mechanism: 'agent-launch-readiness',
  rowIds: [`log-only-fallback|${root}endpoint-route/routes/harness/spawn.ts|handler|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const file = source(`${root}endpoint-route/routes/harness/spawn.ts`);
    let block: ts.Block | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node) && node.expression.getText() === 'isHiveLaunch || isOverwatchLaunch' && ts.isBlock(node.thenStatement)
          && node.thenStatement.getText().includes('let trackedInteractiveBackend')) block = node.thenStatement;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!block) throw new Error('missing original tracked backend block');
    const end = block.statements.findIndex(node => ts.isIfStatement(node) && node.getText().includes('return Response.json'));
    if (end < 0) throw new Error('missing original backend refusal');
    const text = block.statements.slice(0, end + 1).map(node => node.getText()).join('\n');
    const observations: Observation[] = [];
    let backend = 'omp', explicit = false, tracked = true, resolutions = 0;
    const run = () => execute(`let routeBackend = initialBackend; let routeBackendModel = {}; let backendFallbackForSpawnEnv;\nif (tracked) { ${text} }\nreturn { backend: routeBackend, fallback: backendFallbackForSpawnEnv };`, {
      initialBackend: backend, tracked, project: { slug: 'pot' }, role: 'worker', spawnModelPin: null,
      isOverwatchLaunch: false, interactiveBackendFromSpawnBackend: (value: string) => value,
      backendFeatureGuard: (value: string) => ({ supported: value === 'claude-code', reason: 'unsupported' }),
      isOmpBackendExplicitlyConfigured: () => explicit,
      resolveSpawnBackendModel: () => { resolutions++; return { backend: 'claude-code' }; },
      activeWorkspaceId: () => 'fixture', observeFallback: sink('agent-launch-readiness', observations),
      Response: { json: (body: unknown, options: { status: number }) => ({ body, status: options.status }) } });
    expect(await run()).toEqual({ backend: 'claude-code', fallback: 'claude-code' });
    explicit = true; expect(await run()).toMatchObject({ status: 400 });
    backend = 'claude-code'; expect(await run()).toEqual({ backend: 'claude-code', fallback: undefined });
    backend = 'codex'; expect(await run()).toEqual({ backend: 'codex', fallback: undefined });
    tracked = false; await run();
    expect(resolutions).toBe(1);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'default-backend-unsupported'], [0, 'configured-backend-unsupported'], [1, 'applied'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'agent-launch-readiness', observations };
  },
}];

/** Execute the complete original launch producer without real enqueue, HTTP, timers or PG. */
function launchFixture() {
  const path = `${root}blueprint/launch-blueprint.ts`;
  const node = source(path).statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(decl => ts.isIdentifier(decl.name) && decl.name.text === 'defaultFire'));
  if (!node) throw new Error('missing original defaultFire');
  const observations: Observation[] = [];
  const state = { durable: 'off', recordFails: false, fetchFails: false, httpFails: false,
    noTurn: false, retry: false, retryTimerFails: false, bookkeepingFails: false, incumbent: false,
    fetches: 0, timers: 0, records: 0, finishes: 0 };
  const sql = Object.assign(async () => state.incumbent ? [{ spawn_id: 'incumbent', harness_slug: 'pot' }] : [],
    { begin: async (fn: (tx: unknown) => unknown) => fn(sql) });
  const bindings = {
    Error, process: { pid: 1 }, randomUUID: () => 'fixture-id',
    buildInvokeBody: () => ({}), dbosOrchestratorActive: () => state.durable !== 'off',
    require: () => ({ durableSpawnFire: async () => {
      if (state.durable === 'failed') throw new Error('enqueue unavailable');
      if (state.durable === 'uncertain') throw Object.assign(new Error('enqueue response lost'), { name: 'DurableSpawnEnqueueUncertainError' });
      return state.durable === 'primary';
    }, gatewayWholesaleThrottled: async () => false }),
    getOrgPg: () => ({ sql }), recordSpawn: async () => {
      state.records++; if (state.recordFails) throw new Error('record unavailable');
    }, spawnAccountRouteFromLaunch: () => null, recordSpawnAccountRoute: async () => {},
    recordSpawnPid: async () => {}, heartbeatSpawns: async () => {},
    managedSetInterval: () => {
      state.timers++;
      if (state.retryTimerFails && state.timers === 2) throw new Error('retry timer unavailable');
      return { stop() {} };
    }, SPAWN_HEARTBEAT_INTERVAL_MS: 1, RELEASE_FIXER_FALLBACK_RETRY_LIMIT: 1, INVOKE_OUTPUT_TAIL_LIMIT: 2_000,
    loopbackFetch: async () => {
      state.fetches++;
      if (state.fetchFails) throw new Error('request unavailable');
      const text = state.noTurn && state.fetches === 1 ? 'no-turn' : 'turn';
      return { ok: !state.httpFails, status: state.httpFails ? 503 : 200, text: async () => text };
    }, agentProducedTurn: (text: string) => ({ ran: text === 'turn', failureClass: 'infra_loss', detail: 'no-turn' }),
    isCodexLaunchModelSpec: () => false,
    isReleaseFixerNoTurnFailure: () => state.noTurn,
    isRetryableReleaseFixerNoTurnFailure: () => state.retry,
    recordReleaseFixerNoTurnEscalation: async () => {
      if (state.bookkeepingFails) throw new Error('post-outcome bookkeeping unavailable'); return false;
    }, finishSpawn: async () => { state.finishes++; }, describeFetchError: () => 'request unavailable',
    observeFallback: sink('blueprint-launch', observations),
  };
  const fire = execute(node.getText(), bindings, 'defaultFire') as
    (input: Record<string, unknown>, retries?: number, allowDurable?: boolean) => Promise<{ spawnId: string | null; durable: boolean }>;
  const input = { url: '/isolated-invoke', role: 'worker', installSlug: 'pot', blueprintId: 'scan', workspaceId: 'fixture' };
  const drain = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setTimeout(resolve, 0)); };
  return { state, observations, fire, input, drain };
}
const launchRows = (ordinal: number) => [`log-only-fallback|${root}blueprint/launch-blueprint.ts|defaultFire|${ordinal}`];
AGENT_ROUTING_MIGRATION_CASES.push({
  id: 'blueprint-durable-original-failure-uncertain-rethrow-primary-and-deliberate-exclusion',
  item: 'P-013', route: 'observation', mechanism: 'blueprint-launch', rowIds: launchRows(1),
  run: async () => {
    const { expect } = await import('vitest');
    const f = launchFixture();
    f.state.durable = 'failed'; expect((await f.fire(f.input)).durable).toBe(false); await f.drain();
    f.state.durable = 'uncertain'; await expect(f.fire(f.input)).rejects.toThrow('enqueue response lost');
    expect(f.state.fetches).toBe(1); expect(f.state.records).toBe(1);
    f.state.durable = 'primary'; expect((await f.fire(f.input)).durable).toBe(true);
    f.state.durable = 'declined'; await f.fire(f.input); await f.drain();
    f.state.durable = 'off'; await f.fire(f.input); await f.drain();
    f.state.durable = 'primary'; await f.fire(f.input, 0, false); await f.drain();
    const observations = f.observations.filter(row => row.scope === 'durable-enqueue');
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'durable-enqueue-failed'], [0, 'durable-enqueue-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'blueprint-launch', observations };
  },
}, {
  id: 'blueprint-record-original-failure-untracked-child-primary-and-incumbent-admission',
  item: 'P-013', route: 'observation', mechanism: 'blueprint-launch', rowIds: launchRows(2),
  run: async () => {
    const { expect } = await import('vitest');
    const f = launchFixture();
    f.state.recordFails = true;
    expect((await f.fire({ ...f.input, role: 'mug' })).spawnId).toBeNull(); expect(f.state.fetches).toBe(0);
    await f.fire(f.input); await f.drain();
    expect(f.observations.filter(row => row.scope === 'invoke-run').map(row => row.applied)).toEqual([1]);
    f.state.recordFails = false; await f.fire(f.input); await f.drain();
    f.state.incumbent = true; expect((await f.fire({ ...f.input, role: 'mug' })).spawnId).toBe('incumbent');
    expect(f.state.fetches).toBe(2);
    const observations = f.observations.filter(row => row.scope === 'spawn-record');
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'spawn-record-failed'], [0, 'spawn-record-failed'], [1, 'applied'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'blueprint-launch', observations };
  },
}, {
  id: 'blueprint-retry-original-no-turn-primary-http-request-and-no-double-outcome',
  item: 'P-013', route: 'observation', mechanism: 'blueprint-launch', rowIds: launchRows(3),
  run: async () => {
    const { expect } = await import('vitest');
    const f = launchFixture();
    f.state.noTurn = true; f.state.retry = true;
    await f.fire({ ...f.input, blueprintId: 'release-fix' }); await f.drain();
    expect(f.state.fetches).toBe(2);
    f.state.retry = false; f.state.httpFails = true; await f.fire(f.input); await f.drain();
    f.state.httpFails = false; f.state.fetchFails = true; await f.fire(f.input); await f.drain();
    f.state.fetchFails = false; f.state.bookkeepingFails = true;
    await f.fire({ ...f.input, blueprintId: 'release-fix' }); await f.drain();
    const observations = f.observations.filter(row => row.scope === 'invoke-run');
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'invoke-no-turn'], [1, 'applied'], [0, 'invoke-http-failed'], [0, 'invoke-request-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'blueprint-launch', observations };
  },
}, {
  id: 'blueprint-retry-start-original-failure-and-later-completed-primary',
  item: 'P-013', route: 'observation', mechanism: 'blueprint-launch', rowIds: launchRows(4),
  run: async () => {
    const { expect } = await import('vitest');
    const f = launchFixture();
    f.state.noTurn = true; f.state.retry = true; f.state.retryTimerFails = true;
    await f.fire({ ...f.input, blueprintId: 'release-fix' }); await f.drain();
    expect(f.state.fetches).toBe(1);
    f.state.noTurn = false; f.state.retry = false; await f.fire(f.input); await f.drain();
    const observations = f.observations.filter(row => row.scope === 'invoke-run');
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'invoke-no-turn'], [0, 'retry-start-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'blueprint-launch', observations };
  },
});
