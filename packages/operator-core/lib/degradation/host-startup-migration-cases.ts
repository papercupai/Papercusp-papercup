/** Real entrypoint ASTs executed at dependency seams, following host-bootstrap.startup-guards.test.ts.
 * Importing the entrypoints would start shared services. These cases execute the original
 * functions/statements with isolated dependencies; they do not copy their implementations.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { RailMigrationCase } from './rail-migration-cases';

export function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
}
export function original(path: string, marker: string, kind: 'function' | 'try' | 'if' | 'expression'): string {
  const file = source(path);
  let match: ts.Node | undefined;
  const isKind = (node: ts.Node) => kind === 'function' ? ts.isFunctionDeclaration(node)
    : kind === 'try' ? ts.isTryStatement(node) : kind === 'if' ? ts.isIfStatement(node) : ts.isExpressionStatement(node);
  const visit = (node: ts.Node): void => {
    if (isKind(node) && node.getText(file).includes(marker)
      && (!match || node.getWidth(file) < match.getWidth(file))) match = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!match) throw new Error(`missing original ${kind}: ${path} / ${marker}`);
  return match.getText(file);
}
export function execute(text: string, bindings: Record<string, unknown>, functionName?: string): unknown {
  const code = functionName ? `${text}\n${functionName};` : `(async () => { ${text} })();`;
  const compiled = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  } }).outputText;
  return runInNewContext(compiled, { ...bindings, exports: {}, Date, console: { warn() {}, log() {}, error() {}, info() {} } });
}
const boot = 'apps/operator/bin/host-bootstrap.ts';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The original superuser resolution block, without importing transport listeners/auth state. */
function workspaceStatements(): string {
  const file = source('packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts');
  let statements: ts.NodeArray<ts.Statement> | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) && node.statements.some((s) => ts.isVariableStatement(s)
      && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'workspaceId'))) {
      statements = node.statements;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!statements) throw new Error('missing original workspace resolution block');
  const start = statements.findIndex((s) => ts.isVariableStatement(s)
    && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'workspaceId'));
  const end = statements.findIndex((s) => ts.isIfStatement(s)
    && s.getText(file).startsWith("if (workspaceId && workspaceId !=="));
  if (start < 0 || end < start) throw new Error('missing original resolution observation');
  return statements.slice(start, end + 1).map((s) => s.getText(file)).join('\n');
}

const startupSites = [
  { id: 'cache-coherence', path: 'apps/operator/bin/hono-host.ts', marker: 'void startOperatorStateCacheCoherence()', kind: 'expression',
    row: 'log-only-fallback|apps/operator/bin/hono-host.ts|startRequestServers|1' },
  { id: 'kernel-resolver', path: boot, marker: '[kernel-resolver] FAILED', kind: 'try',
    row: 'log-only-fallback|apps/operator/bin/host-bootstrap.ts|runBootstrap|1' },
  { id: 'spawner-warmup', path: boot, marker: '[spawner-sidecar] warm boot failed', kind: 'if',
    row: 'log-only-fallback|apps/operator/bin/host-bootstrap.ts|runBootstrap|2' },
  { id: 'gateway-supervision', path: boot, marker: '[gateway-sidecar] supervision failed', kind: 'if',
    row: 'log-only-fallback|apps/operator/bin/host-bootstrap.ts|runBootstrap|3' },
] as const;

export const HOST_STARTUP_MIGRATION_CASES: RailMigrationCase[] = startupSites.map((site) => ({
  id: `host-startup-${site.id}-failure-and-verified-primary`, item: 'P-012', route: 'observation', mechanism: 'host-startup', rowIds: [site.row],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string; scope?: string | null }> = [];
    const text = original(site.path, site.marker, site.kind);
    let fail = true;
    let enabled = true;
    const spawnerCalls: unknown[][] = [];
    const work = async () => { if (fail) throw new Error('controlled dependency failure'); };
    const spawnSpawnerSidecar = async (...args: unknown[]) => {
      spawnerCalls.push(args);
      return work();
    };
    const bindings = () => ({
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('host-startup'); observations.push(row); return true;
      },
      startOperatorStateCacheCoherence: work, backgroundSpawnerSidecarEnabled: enabled,
      backgroundWorkers: enabled, utilityHost: false, process: { env: {} },
      require: () => ({ installControlAnchorKernelResolver: () => { if (fail) throw new Error('resolver unavailable'); },
        installGovernancePolicyEnforcement() {},
        spawnSpawnerSidecar, SPAWNER_WARMUP_READY_TIMEOUT_MS: 30_000,
        registerSpawnerSidecarShutdownHooks() {},
        ensureGatewaySidecar: work, registerGatewaySidecarShutdownHooks() {} }),
    });
    await execute(text, bindings()); await tick();
    fail = false;
    await execute(text, bindings()); await tick();
    expect(observations.map(({ applied, scope }) => [applied, scope])).toEqual([[0, site.id], [1, site.id]]);
    if (site.kind === 'if') {
      enabled = false;
      await execute(text, bindings()); await tick();
      expect(observations).toHaveLength(2);
    }
    if (site.id === 'spawner-warmup') {
      expect(spawnerCalls).toEqual([
        [undefined, { readyTimeoutMs: 30_000 }],
        [undefined, { readyTimeoutMs: 30_000 }],
      ]);
    }
    return { route: 'observation', mechanism: 'host-startup', observations };
  },
}));

HOST_STARTUP_MIGRATION_CASES.push({
  id: 'packaged-mcp-proxy-missing-entry-listen-error-import-error-and-primary-spawn',
  item: 'P-012', route: 'observation', mechanism: 'host-startup',
  rowIds: [1, 2, 3].map((n) => `log-only-fallback|apps/operator/bin/host-bootstrap.ts|startPackagedMcpProxy|${n}`),
  run: async () => {
    const { expect } = await import('vitest');
    const { EventEmitter } = await import('node:events');
    const { dirname, join } = await import('node:path');
    const text = original(boot, 'function startPackagedMcpProxy()', 'function');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let hasEntry = false;
    let importFails = false;
    const child = new EventEmitter();
    const server = new EventEmitter();
    const state = { packagedMcpProxyShutdownRequested: false, packagedMcpProxyProcess: null };
    const start = execute(text, {
      BOOTSTRAP_STATE: state, process: { env: {}, argv: ['node', '/fixture/serve.mjs'], execPath: 'node', pid: 1 },
      registerSidecarShutdownHooks() {}, stopPackagedMcpProxy() {},
      pinTenantLoopbackPort() {}, MCP_PROXY_TENANT_SERVICE: 'fixture', loopbackPortHeldByForeignUid: () => false,
      packagedMcpProxyAlive: async () => false, dirname, join, existsSync: () => hasEntry,
      activeWorkspaceId: () => 'fixture', randomUUID: () => 'fixture', MCP_PROXY_RETRY_WINDOW_MS: 1,
      beginGovernedExecution: async () => ({ cancel: async () => {}, finish: async () => {}, context: {} }),
      governedExecutionRuntime: () => ({}), spawn: () => child,
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('host-startup'); observations.push(row); return true;
      },
      require: () => { if (importFails) throw new Error('proxy import unavailable');
        return { startMcpProxy: () => server, readOperatorJsonTarget: () => null }; },
    }, 'startPackagedMcpProxy') as () => void;
    start(); await tick();
    server.emit('error', new Error('listen failed')); await tick();
    importFails = true; start(); await tick();
    hasEntry = true; start(); await tick();
    expect(observations.map((row) => row.reason)).toEqual(['packaged-entry-missing', 'fallback-listen-failed', 'fallback-start-failed']);
    // Merely returning a child cannot manufacture primary success.
    child.emit('spawn'); await tick();
    expect(observations.at(-1)?.applied).toBe(1);
    child.emit('error', new Error('spawn failed')); await tick();
    expect(observations.at(-1)?.reason).toBe('packaged-spawn-failed');
    state.packagedMcpProxyShutdownRequested = true;
    const before = observations.length;
    start(); await tick(); expect(observations).toHaveLength(before);
    return { route: 'observation', mechanism: 'host-startup', observations };
  },
});

HOST_STARTUP_MIGRATION_CASES.push({
  id: 'mcp-workspace-registry-fallback-explicit-session-primary-and-unscoped-exclusion',
  item: 'P-012', route: 'observation', mechanism: 'mcp-workspace-resolution',
  rowIds: ['log-only-fallback|packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts|tryBuildSpawnContext|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const text = workspaceStatements();
    const run = async (workspace: string, sessionWorkspace: string | null, active: string, all = false) => execute(text, {
      headerWs: '', wsParam: workspace, headerClient: 'fixture', clientParam: '', headerHarness: '',
      headers: new Headers(), harnessUrlParam: '', suIdentity: 'fixture',
      url: new URL(`http://fixture/?${all ? 'all_workspaces=1' : ''}`),
      getFlag: async () => true, FLAGS: { SCOPED_SUPERUSER_CLAMP: 'clamp' },
      workspaceForCoordOwner: async () => sessionWorkspace, activeWorkspaceId: () => active,
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('mcp-workspace-resolution'); observations.push(row); return true;
      },
    });
    await run('', null, 'active');
    await run('explicit', null, 'active');
    await run('', 'session', 'active');
    await run('', null, '');
    expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
      [0, 'registry-fallback'], [1, 'applied'], [1, 'applied'], [0, 'workspace-unresolved'],
    ]);
    await run('*', null, 'active'); await run('', null, 'active', true);
    expect(observations).toHaveLength(4);
    return { route: 'observation', mechanism: 'mcp-workspace-resolution', observations };
  },
});

HOST_STARTUP_MIGRATION_CASES.push({
  id: 'db-discovery-quarantine-host-wiring-verified-probes-and-uncertain-exclusion',
  item: 'P-012', route: 'observation', mechanism: 'db-discovery-identity',
  rowIds: ['log-only-fallback|libs/papercusp/libs/db/src/connection.ts|_quarantineDiscoveryEndpointIfProvenForeign|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const db = await import('@papercusp/db-org/connection');
    const identity = await import('../../../../libs/papercusp/libs/db/src/store-identity');
    const { createServer } = await import('node:net');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const fixture = mkdtempSync(join(tmpdir(), 'db-identity-rail-'));
    const previous = { home: process.env.PAPERCUSP_HOME, skip: process.env.PAPERCUSP_SKIP_PG_DISCOVERY };
    const socket = createServer();
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
      const address = socket.address();
      if (!address || typeof address === 'string') throw new Error('fixture socket missing');
      process.env.PAPERCUSP_HOME = fixture; delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
      db._resetUrlCacheForTests(); db._resetDiscoveryQuarantineForTests(); identity._resetStoreIdentityForTests();
      writeFileSync(join(fixture, 'embedded-pg.json'), JSON.stringify({ port: address.port, pid: process.pid,
        url: `postgresql://127.0.0.1:${address.port}/papercusp` }));
      // Execute the actual host callback installation, not a test-created substitute.
      let installedObserver: Parameters<typeof db.setDiscoveryIdentityObserver>[0] = null;
      await execute(original(boot, 'setDiscoveryIdentityObserver((mechanism, observation)', 'expression'), {
        setDiscoveryIdentityObserver: (observer: typeof installedObserver) => {
          installedObserver = observer; db.setDiscoveryIdentityObserver(observer);
        },
        observeFallback: (mechanism: string, row: typeof observations[number]) => {
          expect(mechanism).toBe('db-discovery-identity'); observations.push(row); return true;
        },
      });
      const validate = execute(original('libs/papercusp/libs/db/src/connection.ts', 'function validateDiscoveryTargetOnce(', 'function'), {
        _identityProbeTestGeneration: 0, parseStoreIdentity: identity.parseStoreIdentity,
        pinOrVerifyStoreIdentity: identity.pinOrVerifyStoreIdentity, describeStoreIdentityMismatch: identity.describeStoreIdentityMismatch,
        _quarantineDiscoveryEndpointIfProvenForeign: db._quarantineDiscoveryEndpointIfProvenForeign,
        discoveryIdentityTelemetry: { observeFallback: installedObserver },
      }, 'validateDiscoveryTargetOnce') as (sql: unknown, label: string, options: { url: string; checkSchema: boolean }) => void;
      const trusted = { url: 'postgresql://127.0.0.1:5432/papercusp' };
      const foreign = { url: `postgresql://127.0.0.1:${address.port}/papercusp` };
      const sql = async () => [{ t: 'present', system_identifier: '123', database: 'papercusp' }];
      validate(sql, 'fixture', { ...trusted, checkSchema: false }); await tick();
      expect(observations).toEqual([{ eligible: 1, applied: 1, reason: 'applied' }]);
      expect(db._quarantineDiscoveryEndpointIfProvenForeign(foreign, foreign)).toBe(false);
      expect(observations).toHaveLength(1);
      for (let i = 0; i < 2; i++) expect(db._quarantineDiscoveryEndpointIfProvenForeign(trusted, foreign)).toBe(true);
      expect(observations.filter((row) => row.applied === 0)).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      validate(sql, 'fixture', { ...trusted, checkSchema: false }); await tick();
      validate(async () => [{ t: null, system_identifier: null, database: null }], 'unknown', { ...trusted, checkSchema: false }); await tick();
      expect(observations.map((row) => row.applied)).toEqual([1, 0, 0, 1]);
      return { route: 'observation', mechanism: 'db-discovery-identity', observations };
    } finally {
      db.setDiscoveryIdentityObserver(null); db._resetDiscoveryQuarantineForTests(); db._resetUrlCacheForTests(); identity._resetStoreIdentityForTests();
      if (previous.home === undefined) delete process.env.PAPERCUSP_HOME; else process.env.PAPERCUSP_HOME = previous.home;
      if (previous.skip === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY; else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = previous.skip;
      await new Promise<void>((resolve) => socket.close(() => resolve())); rmSync(fixture, { recursive: true, force: true }); warn.mockRestore();
    }
  },
});
