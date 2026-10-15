import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDependencyGenerationRetention } from './dependency-generation-retention';
import { resolveDependencyGenerationRoot } from './dependency-generation-prebuild';

const registry = vi.hoisted(() => ({
  read: vi.fn(),
  load: vi.fn(),
  contentPath: vi.fn(),
  integrationRoot: vi.fn(),
}));
vi.mock('../workspace-registry', () => ({ readRegistry: registry.read }));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: registry.load,
  resolveHarnessContentPath: registry.contentPath,
}));
vi.mock('../harness/routines/release-actions', () => ({ resolveIntegrationRoot: registry.integrationRoot }));
// WI-10007542: the prune start runs behind governed admission. The seam is faked so this
// unit suite never reaches the durable admission tables.
const governed = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../resource-governor/execution', () => ({ runGovernedOperation: governed.run }));

let fixture: string;
let integration: string;
let output: string;
let script: string;

beforeEach(() => {
  vi.resetAllMocks();
  fixture = mkdtempSync(join(tmpdir(), 'dependency-retention-'));
  integration = join(fixture, 'integration');
  output = join(fixture, 'prune-arguments');
  script = join(fixture, 'tooling/apps/operator/bin/release/dependency-generation.sh');
  mkdirSync(integration, { recursive: true });
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, 'printf "%s\\n" "$@" >> "$PAPERCUSP_RETENTION_TEST_OUTPUT"\n');
  writeFileSync(output, '');
  vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', '');
  vi.stubEnv('PAPERCUSP_RETENTION_TEST_OUTPUT', output);
  registry.integrationRoot.mockReturnValue(join(fixture, 'tooling'));
  registry.read.mockReturnValue({ workspaces: [{ id: 'ws-1' }] });
  registry.load.mockResolvedValue({ projects: [{ slug: 'project' }] });
  registry.contentPath.mockReturnValue(integration);
  governed.run.mockImplementation((_input: unknown, start: (context: unknown) => Promise<unknown>) => start({}));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(fixture, { recursive: true, force: true });
});

function recordStore(store: string, previous: string[] = []): void {
  mkdirSync(join(integration, '.papercusp'), { recursive: true });
  writeFileSync(join(integration, '.papercusp/dependency-generation-root'), `${[store, ...previous].join('\n')}\n`);
}

function pruneArguments(): string[] {
  return readFileSync(output, 'utf8').trim().split('\n').filter(Boolean);
}

describe('hourly dependency-generation retention discovery', () => {
  it('skips an absent integration even when the environment names a live shared store', async () => {
    const store = join(fixture, 'global-store');
    mkdirSync(store);
    vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', store);
    const missing = join(fixture, 'retired-project');
    registry.contentPath.mockReturnValue(missing);
    const result = await runDependencyGenerationRetention();
    expect(result.skippedIntegrations).toEqual([{ root: missing, reason: 'integration is absent or not a directory' }]);
    expect(pruneArguments()).toEqual([]);
    expect(governed.run).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
  });

  it('sweeps one physical store once and lets a current alias override retired mode', async () => {
    const shared = join(fixture, 'shared');
    const replacement = join(fixture, 'replacement');
    const alias = join(fixture, 'shared-alias');
    const other = join(fixture, 'other-integration');
    mkdirSync(shared); mkdirSync(replacement); mkdirSync(join(other, '.papercusp'), { recursive: true });
    symlinkSync(shared, alias, 'dir');
    recordStore(replacement, [shared]);
    writeFileSync(join(other, '.papercusp/dependency-generation-root'), `${alias}\n`);
    registry.load.mockResolvedValue({ projects: [{ slug: 'first' }, { slug: 'second' }] });
    registry.contentPath.mockImplementation((_registry, slug) => slug === 'first' ? integration : other);
    const result = await runDependencyGenerationRetention();
    expect(result.stores).toHaveLength(2);
    expect(result.stores.find((row) => row.generationRoot === alias)).toMatchObject({ retired: false, status: 'pruned' });
    expect(pruneArguments()).toEqual([
      '--integration', integration, '--generation-root', replacement, '--prune-only', '--no-recorded-store-cascade',
      '--integration', other, '--generation-root', alias, '--prune-only', '--no-recorded-store-cascade',
    ]);
    expect(governed.run).toHaveBeenCalledTimes(2);
  });

  it('sweeps recorded former stores once when the actor already enumerates them', async () => {
    const current = join(fixture, 'current');
    const former = join(fixture, 'former');
    const identity = `v1-${'d'.repeat(64)}`;
    mkdirSync(join(current, identity, 'tree'), { recursive: true });
    mkdirSync(former);
    writeFileSync(join(current, identity, '.papercusp-dependency-generation'), `identity=${identity}\nsnapshot=fixture\ncreated=2\n`);
    recordStore(current, [former]);
    vi.stubEnv('PAPERCUSP_RETENTION_ACTUAL_SCRIPT',
      resolve(__dirname, '../../../../apps/operator/bin/release/dependency-generation.sh'));
    // Count calls through the real CLI and preserve the original pruner.
    writeFileSync(script, [
      'source "$PAPERCUSP_RETENTION_ACTUAL_SCRIPT"',
      'eval "$(declare -f dependency_generation_apply_retention | sed "1s/dependency_generation_apply_retention/fixture_original_retention/")"',
      'dependency_generation_apply_retention() { printf "%s\\n" "$1" >> "$PAPERCUSP_RETENTION_TEST_OUTPUT"; fixture_original_retention "$@"; }',
      'dependency_generation_main "$@"',
    ].join('\n'));

    const result = await runDependencyGenerationRetention();

    expect(result.status).toBe('complete');
    expect(pruneArguments()).toEqual([current, former]);
    expect(readFileSync(join(current, identity, '.papercusp-dependency-generation'), 'utf8'))
      .toContain(`identity=${identity}`);
    expect(result.stores.map((store) => store.status)).toEqual(['pruned', 'pruned']);
  });

  it('returns failed prune diagnostics while continuing an independent store', async () => {
    const current = join(fixture, 'current');
    const former = join(fixture, 'former');
    mkdirSync(current); mkdirSync(former); recordStore(current, [former]);
    writeFileSync(script, 'if [ "$4" = "$PAPERCUSP_RETENTION_FAIL_STORE" ]; then printf "pin kept\\n"; printf "refused fixture\\n" >&2; exit 7; fi\nprintf "retained independent store\\n"\n');
    vi.stubEnv('PAPERCUSP_RETENTION_FAIL_STORE', current);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runDependencyGenerationRetention();
    expect(result.status).toBe('partial');
    expect(result.stores[0]).toMatchObject({ status: 'failed', exitCode: 7, stdout: 'pin kept\n', stderr: 'refused fixture\n' });
    expect(result.stores[1]).toMatchObject({ status: 'pruned', generationRoot: former, stdout: 'retained independent store\n' });
    expect(existsSync(current)).toBe(true);
    expect(existsSync(former)).toBe(true);
  });

  it('sweeps recorded former stores with their existing pin/lease guard, preserving first-line selection', async () => {
    const current = join(fixture, 'current');
    const old = join(fixture, 'old');
    mkdirSync(current); mkdirSync(old);
    recordStore(current, [old, old, 'relative-not-a-store', current]);
    expect(resolveDependencyGenerationRoot(integration, {})).toBe(current);
    await runDependencyGenerationRetention();
    expect(pruneArguments()).toEqual([
      '--integration', integration, '--generation-root', current, '--prune-only', '--no-recorded-store-cascade',
      '--integration', integration, '--generation-root', old, '--prune-only', '--no-recorded-store-cascade', '--retired-store',
    ]);
    expect(governed.run).toHaveBeenCalledTimes(2);
  });

  it('keeps the current store on line one across real shell root moves', () => {
    const actual = resolve(__dirname, '../../../../apps/operator/bin/release/dependency-generation.sh');
    const roots = ['first', 'second', 'third'].map((name) => join(fixture, name));
    roots.forEach((root) => mkdirSync(root));
    const result = spawnSync('bash', ['-c',
      'source "$1"; for store in "$3" "$4" "$5" "$4"; do PAPERCUSP_DEPENDENCY_GENERATION_ROOT="$store" dependency_generation_resolve_root "$2" >/dev/null || exit; done',
      '_', actual, integration, ...roots], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const lines = readFileSync(join(integration, '.papercusp/dependency-generation-root'), 'utf8').trim().split('\n');
    expect(lines[0]).toBe(roots[1]);
    expect(new Set(lines)).toEqual(new Set(roots));
    expect(lines).toHaveLength(3);
    expect(resolveDependencyGenerationRoot(integration, {})).toBe(roots[1]);
  });

  it('retired-store pruning keeps real pins, foreign leases, and the replacement store', () => {
    const actual = resolve(__dirname, '../../../../apps/operator/bin/release/dependency-generation.sh');
    const current = join(fixture, 'current');
    const old = join(fixture, 'old');
    mkdirSync(current); mkdirSync(old);
    const ids = ['a', 'b', 'c'].map((value) => `v1-${value.repeat(64)}`);
    ids.forEach((id) => {
      mkdirSync(join(old, id, 'tree'), { recursive: true });
      writeFileSync(join(old, id, '.papercusp-dependency-generation'), `identity=${id}\nsnapshot=fixture\ncreated=1\n`);
      writeFileSync(join(old, id, 'tree/dependency.txt'), 'rebuildable');
    });
    const consumer = join(fixture, 'consumer');
    mkdirSync(join(consumer, 'node_modules'), { recursive: true });
    writeFileSync(join(consumer, 'node_modules/.papercusp-dependency-generation'), `identity=${ids[0]}\n`);
    mkdirSync(join(old, '.pins')); mkdirSync(join(old, '.leases'));
    writeFileSync(join(old, '.pins/consumer'), `identity=${ids[0]}\ncheckout=${consumer}\n`);
    writeFileSync(join(old, '.leases/foreign'), `identity=${ids[2]}\nhost=foreign-fixture-host\npid=1\n`);
    writeFileSync(join(current, 'retained.txt'), 'current');
    recordStore(current, [old]);
    const notReady = spawnSync('bash', [actual, '--integration', integration, '--generation-root', old,
      '--prune-only', '--retired-store'], { encoding: 'utf8', timeout: 10_000 });
    expect(notReady.status, notReady.stderr).toBe(2);
    expect(notReady.stderr).toContain('replacement dependency store is not published');
    expect(existsSync(join(old, ids[1]!))).toBe(true);
    const replacementId = `v1-${'d'.repeat(64)}`;
    mkdirSync(join(current, replacementId, 'tree'), { recursive: true });
    writeFileSync(join(current, replacementId, '.papercusp-dependency-generation'), `identity=${replacementId}\nsnapshot=fixture\ncreated=2\n`);
    // The pre-existing actor's current-store-only invocation must also retire
    // former stores, even before a background host loads the new TS discovery.
    const result = spawnSync('bash', [actual, '--integration', integration, '--generation-root', current,
      '--prune-only'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(old, ids[0]!))).toBe(true);
    expect(existsSync(join(old, ids[1]!))).toBe(false);
    expect(existsSync(join(old, ids[2]!))).toBe(true);
    expect(existsSync(join(current, replacementId))).toBe(true);
    expect(readFileSync(join(current, 'retained.txt'), 'utf8')).toBe('current');
    const refused = spawnSync('bash', [actual, '--integration', integration, '--generation-root', current,
      '--prune-only', '--retired-store'], { encoding: 'utf8', timeout: 10_000 });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('cannot retire the current');
  });

  it('invokes prune-only for a recorded store without a legacy directory', async () => {
    const store = join(fixture, 'recorded-store');
    mkdirSync(store);
    recordStore(store);
    expect(existsSync(join(integration, '.papercusp/dependency-generations'))).toBe(false);

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only', '--no-recorded-store-cascade']);
  });

  it('discovers an environment-configured store ahead of a missing recorded store', async () => {
    const store = join(fixture, 'configured-store');
    mkdirSync(store);
    recordStore(join(fixture, 'missing-recorded-store'));
    vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', store);

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only', '--no-recorded-store-cascade']);
  });

  it('retains discovery of the default tree-local store', async () => {
    const store = join(integration, '.papercusp/dependency-generations');
    mkdirSync(store, { recursive: true });

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only', '--no-recorded-store-cascade']);
  });

  it('skips a missing selected store even if an unused legacy directory exists', async () => {
    mkdirSync(join(integration, '.papercusp/dependency-generations'), { recursive: true });
    recordStore(join(fixture, 'missing-recorded-store'));

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual([]);
  });

  it('does not create or sweep stores that have never existed', async () => {
    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual([]);
    expect(existsSync(join(integration, '.papercusp'))).toBe(false);
    expect(governed.run).not.toHaveBeenCalled();
  });

  it('sweeps a shared integration root once across workspace registrations', async () => {
    const store = join(integration, '.papercusp/dependency-generations');
    mkdirSync(store, { recursive: true });
    registry.read.mockReturnValue({ workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }] });

    await runDependencyGenerationRetention();

    expect(registry.load).toHaveBeenCalledTimes(2);
    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only', '--no-recorded-store-cascade']);
    // One admission per swept root, owned by the first workspace that registered it.
    expect(governed.run).toHaveBeenCalledTimes(1);
    expect(governed.run.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1',
      namespace: 'dependency-generation-retention',
      admissionClass: 'process',
      payloadRef: `dependency-generation-retention:${integration}`,
    });
  });

  it('starts no prune when governed admission refuses the root', async () => {
    mkdirSync(join(integration, '.papercusp/dependency-generations'), { recursive: true });
    governed.run.mockRejectedValueOnce(new Error('admission refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runDependencyGenerationRetention();

    expect(pruneArguments()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[dependency-generation-retention] ${integration}: admission refused`);
  });

  it('continues discovering stores after a workspace registry failure', async () => {
    const store = join(integration, '.papercusp/dependency-generations');
    mkdirSync(store, { recursive: true });
    registry.read.mockReturnValue({ workspaces: [{ id: 'broken' }, { id: 'ws-1' }] });
    registry.load.mockRejectedValueOnce(new Error('registry unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runDependencyGenerationRetention();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace broken: registry unavailable'));
    expect(pruneArguments()).toEqual(['--integration', integration, '--generation-root', store, '--prune-only', '--no-recorded-store-cascade']);
  });

  it('skips registry discovery when the maintained script is absent', async () => {
    rmSync(script);

    await runDependencyGenerationRetention();

    expect(registry.read).not.toHaveBeenCalled();
    expect(pruneArguments()).toEqual([]);
  });
});
