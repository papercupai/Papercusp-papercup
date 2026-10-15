import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerProjectedTool, lookupByMcpName, _resetProjectionRegistryForTests } from '@papercusp/tooldef';
import type { ProjectedTool } from '@papercusp/tooldef';
import { loadIsolatedHostedTestUserKit } from '../isolated-hosted-test-user.mts';

const roots: string[] = [];
const kits: Awaited<ReturnType<typeof loadIsolatedHostedTestUserKit>>[] = [];
const repo = resolve(import.meta.dirname, '../../../../..');
afterEach(async () => {
  const outcomes = await Promise.allSettled(kits.splice(0).map(kit => kit.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  _resetProjectionRegistryForTests();
  const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (errors.length) throw new AggregateError(errors, 'fixture disposal failed');
});

function fixture(options: { refused?: boolean; brokenImport?: boolean; slowImport?: boolean; slowCreate?: boolean; cleanupFailure?: boolean; actualCore?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'isolated-hosted-user-test-'));
  roots.push(root);
  mkdirSync(join(root, 'e2e'));
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const events = join(root, 'events.jsonl');
  const record = `import { appendFileSync } from 'node:fs';
    const record = event => appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ event, pid: process.pid }) + '\\n');`;
  const core = options.actualCore ? join(repo, 'packages/operator-core') : root;
  if (!options.actualCore) {
    mkdirSync(join(root, 'lib/workspace-host'), { recursive: true });
    mkdirSync(join(root, 'lib/auth/hosted'), { recursive: true });
    const tooldef = pathToFileURL(join(repo, 'libs/generic/tooldef/src/tool-projection.ts')).href;
    writeFileSync(join(root, 'lib/workspace-host/observability-store.ts'), `
      ${record}
      record('candidate-import');
      ${options.brokenImport ? "throw new Error('candidate_import_failed_before_admission');" : `
        import { registerProjectedTool } from ${JSON.stringify(tooldef)};
        registerProjectedTool({ pluginName: 'fixture', description: 'candidate version',
          inputSchema: { type: 'object', properties: { candidate: { type: 'string' } } },
          capabilities: [], expose: { mcp: { name: 'goals:create' } }, fn: async () => ({}) });
      `}
    `);
    writeFileSync(join(root, 'lib/auth/hosted/workspace-admission.ts'), 'export {};');
    writeFileSync(join(root, 'lib/auth/hosted/workspace-admission-dependencies.ts'),
      options.slowImport ? 'await new Promise(() => {}); export {};' : 'export {};');
  }
  writeFileSync(join(root, 'e2e/hosted-test-user.ts'), `
    ${record}
    export function isolatedHostedWorkspaceContext() {
      record('runtime-check');
      ${options.refused ? "throw new Error('hosted_test_workspace_requires_private_runtime');" : "return 'test-runtime-fixture';"}
    }
    export function hostedTestSourceRoots() { return { core: ${JSON.stringify(core)} }; }
    export async function loadHostedTestUserKit() {
      record('kit-load');
      return { async create() {
        record('create');
        ${options.slowCreate ? 'await new Promise(() => {});' : ''}
        return { sessionId: 'private-session', organizationId: 'private-org', workspaceId: 'private-workspace',
          cookie: origin => ({ name: 'fixture-cookie', value: 'private-cookie', url: origin, secure: true }),
          async cleanup() { record('cleanup'); ${options.cleanupFailure ? "throw new AggregateError([new Error('revoke failed'), new Error('provider cleanup failed')], 'cleanup failed');" : ''} },
        };
      } };
    }
  `);
  const environment = { ...process.env, FIXTURE_EVENTS: events, PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    PAPERCUSP_WORKSPACE: 'test-runtime-fixture' };
  return { root, environment, events: () => readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

function assertExited(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('isolated retained hosted TEST admission', () => {
  it('keeps an incompatible parent registry intact and preflights candidate imports before account creation', async () => {
    const parent: ProjectedTool = { pluginName: 'fixture', description: 'parent version', inputSchema: { type: 'object' },
      capabilities: [], expose: { mcp: { name: 'goals:create' } }, fn: async () => ({ content: [] }) };
    registerProjectedTool(parent);
    expect(() => registerProjectedTool({ ...parent, description: 'candidate version',
      inputSchema: { type: 'object', properties: { candidate: { type: 'string' } } } })).toThrow(/MCP tool name.*registered twice/);
    const f = fixture();
    const kit = await loadIsolatedHostedTestUserKit({ portalRoot: f.root, environment: f.environment });
    kits.push(kit);
    expect(f.events().map(row => row.event)).toEqual(['runtime-check', 'candidate-import', 'kit-load']);
    expect(lookupByMcpName('goals:create')).toBe(parent);
    const user = await kit.create({ preassignedWorkspace: true });
    expect(user.workspaceId).toBe('private-workspace');
    expect(user.cookie('https://localhost:4439')).toEqual({ name: 'fixture-cookie', value: 'private-cookie', url: 'https://localhost:4439', secure: true });
    await user.cleanup('test finished');
    expect(f.events().map(row => row.event)).toEqual(['runtime-check', 'candidate-import', 'kit-load', 'create', 'cleanup']);
    assertExited(f.events()[0].pid);
  }, 75_000);

  it('imports the actual candidate observability and admission closure without registering candidate tools in the parent', async () => {
    const parent: ProjectedTool = { pluginName: 'legacy', description: 'incompatible parent goals',
      inputSchema: { type: 'object', properties: { parentOnly: { type: 'boolean' } } }, capabilities: [],
      expose: { mcp: { name: 'goals:create' } }, fn: async () => ({ content: [] }) };
    registerProjectedTool(parent);
    const f = fixture({ actualCore: true });
    const kit = await loadIsolatedHostedTestUserKit({ portalRoot: f.root, environment: f.environment });
    kits.push(kit);
    expect(f.events().map(row => row.event)).toEqual(['runtime-check', 'kit-load']);
    expect(lookupByMcpName('goals:create')).toBe(parent);
    await kit.close();
    assertExited(f.events()[0].pid);
  }, 90_000);

  it.each([{ refused: true, message: 'hosted_test_workspace_requires_private_runtime' },
    { brokenImport: true, message: 'candidate_import_failed_before_admission' }])(
    'refuses unsafe or broken admission imports before kit loading or provider creation: $message', async ({ message, ...options }) => {
      const f = fixture(options);
      await expect(loadIsolatedHostedTestUserKit({ portalRoot: f.root, environment: f.environment })).rejects.toThrow(message);
      expect(f.events().map(row => row.event)).not.toContain('kit-load');
      expect(f.events().map(row => row.event)).not.toContain('create');
      assertExited(f.events()[0].pid);
    }, 75_000);

  it('reaps the child and preserves every cleanup failure', async () => {
    const f = fixture({ cleanupFailure: true });
    const kit = await loadIsolatedHostedTestUserKit({ portalRoot: f.root, environment: f.environment });
    kits.push(kit);
    const user = await kit.create({});
    const failure = await user.cleanup('cleanup failure control').catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error: Error) => error.message)).toEqual(['revoke failed', 'provider cleanup failed']);
    assertExited(f.events()[0].pid);
    await kit.close();
  }, 75_000);

  it('retains completed import stages and reaps a child stuck before admission', async () => {
    const f = fixture({ slowImport: true });
    const failure = await loadIsolatedHostedTestUserKit({ portalRoot: f.root,
      environment: f.environment, timeoutMs: 5_000 }).catch(error => error);
    expect(failure.message).toContain('Hosted TEST fixture preflight timed out at lib/auth/hosted/workspace-admission-dependencies.ts');
    expect(JSON.parse(failure.message.split('\nHosted TEST import stages: ')[1])).toEqual(failure.importStages);
    expect(failure.importStages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'fixture-module-import', phase: 'finished' }),
      expect.objectContaining({ stage: 'lib/workspace-host/observability-store.ts', phase: 'finished' }),
      expect.objectContaining({ stage: 'lib/auth/hosted/workspace-admission.ts', phase: 'finished' }),
      expect.objectContaining({ stage: 'lib/auth/hosted/workspace-admission-dependencies.ts', phase: 'started' }),
    ]));
    expect(failure.importStages.some((row: { stage: string; phase: string }) =>
      row.stage.endsWith('workspace-admission-dependencies.ts') && row.phase === 'finished')).toBe(false);
    expect(failure.importStages.map((row: { elapsedMs: number }) => row.elapsedMs)).toEqual(
      [...failure.importStages.map((row: { elapsedMs: number }) => row.elapsedMs)].sort((a, b) => a - b));
    expect(f.events().map(row => row.event)).not.toContain('kit-load');
    expect(f.events().map(row => row.event)).not.toContain('create');
    assertExited(f.events()[0].pid);
  }, 75_000);

  it('reaps a child whose admission stops responding', async () => {
    const f = fixture({ slowCreate: true });
    const kit = await loadIsolatedHostedTestUserKit({ portalRoot: f.root, environment: f.environment, timeoutMs: 5_000 });
    kits.push(kit);
    await expect(kit.create({})).rejects.toThrow('Hosted TEST fixture create timed out');
    assertExited(f.events()[0].pid);
  }, 75_000);
});
