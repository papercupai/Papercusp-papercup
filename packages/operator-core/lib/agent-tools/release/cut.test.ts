/**
 * cut.test.ts — the release:cut TOOL routing + safety gates (P-5 Unit B). Mocks the cut
 * primitives (launch / status / handoff / preflight) + PG/identity I/O so it asserts the
 * decision logic — preflight, dry-run vs fire, the operator role gate, the cut-in-flight
 * refusal, LOCAL-only invariants — without spawning a real build or touching PG.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/cut.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ExecFileOptions } from 'node:child_process';
import type { PreflightResult, CutStatus, HandoffResult, ReleaseGate } from '../../release-cut-launch';

const { auditSqlM, reclaimGatherM, reclaimRenderM } = vi.hoisted(() => ({
  auditSqlM: vi.fn(),
  reclaimGatherM: vi.fn(),
  reclaimRenderM: vi.fn(),
}));

// Partial-mock: keep the REAL pure helpers the handler uses (isValidVersion, buildCutArgv,
// desktopRoot, CHANNELS, CUT_UNIT, cutUnitFor, legsForPlatform, ...) and override only the
// functions that do real I/O.
vi.mock('../../release-cut-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release-cut-launch')>()),
  launchDetachedCut: vi.fn(),
  readCutStatus: vi.fn(),
  collectHandoff: vi.fn(),
  preflightCut: vi.fn(),
  abortLeg: vi.fn(),
  readOrCreateGate: vi.fn(),
}));
// P-001: the handler now opens a managed release operation before firing. Both of these
// do real I/O (a task-ledger write and a `git ls-tree`), so they are overridden for the
// same reason the launch primitives are — this suite asserts DECISION logic.
vi.mock('../../release-cut-operation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release-cut-operation')>()),
  beginCutOperation: vi.fn(),
  readSourceGitlinks: vi.fn(() => ({})),
}));
vi.mock('../../task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/store')>()),
  markSpawned: vi.fn(),
}));
vi.mock('../capability/bash-task-provenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../capability/bash-task-provenance')>()),
  resolveBashTaskProvenance: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: auditSqlM } }) as never,
}));
vi.mock('../../release-cut-reclaim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release-cut-reclaim')>()),
  gatherCutReclaimPlan: reclaimGatherM,
  renderReclaimPlan: reclaimRenderM,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'test-ws',
}));
vi.mock('../../resource-governor/execution', () => ({
  runGovernedOperation: async (_input: unknown, run: (context: unknown) => Promise<unknown>) => run({}),
}));
vi.mock('../locks/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/identity')>()),
  readIdentity: () => ({ ownerId: 'o', ownerLabel: 'tester', coordinationDomain: 'd' }) as never,
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

import { launchDetachedCut, readCutStatus, collectHandoff, preflightCut, abortLeg, readOrCreateGate } from '../../release-cut-launch';
import { beginCutOperation } from '../../release-cut-operation';
import { markSpawned } from '../../task-manager/store';
import { BashProvenanceRefusal, resolveBashTaskProvenance } from '../capability/bash-task-provenance';
import { loadHarnessRegistry } from '../../harness-registry';
import { execFile } from 'node:child_process';
import { gatherCutReclaimPlan, renderReclaimPlan } from '../../release-cut-reclaim';
const beginOpM = vi.mocked(beginCutOperation);
const markSpawnedM = vi.mocked(markSpawned);
const provenanceM = vi.mocked(resolveBashTaskProvenance);
const launchM = vi.mocked(launchDetachedCut);
const statusM = vi.mocked(readCutStatus);
const handoffM = vi.mocked(collectHandoff);
const preflightM = vi.mocked(preflightCut);
const abortLegM = vi.mocked(abortLeg);
const gateM = vi.mocked(readOrCreateGate);
const registryM = vi.mocked(loadHarnessRegistry);
const execFileM = vi.mocked(execFile);
const reclaimGatherMock = vi.mocked(gatherCutReclaimPlan);
const reclaimRenderMock = vi.mocked(renderReclaimPlan);

/**
 * WI-10005193: cut.ts runs its children through callback-style execFile (runFileAsync) so the
 * operator main thread is never blocked. Drive the mock from a synchronous implementation:
 * its return value is the child's stdout and a throw is the child's failure. The callback fires
 * on a later macrotask, as a real child's exit does.
 */
type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;
function installExecFile(
  impl: (command: string, args: readonly string[], options: ExecFileOptions, callback: ExecFileCallback) => unknown,
) {
  execFileM.mockImplementation(impl as never);
}
function mockExecFile(impl: (command: string, args: readonly string[], options: unknown) => string) {
  installExecFile((command, args, options, callback) => {
    let stdout = '';
    let failure: Error | null = null;
    try {
      stdout = impl(command, args, options);
    } catch (err) {
      failure = err as Error;
    }
    setImmediate(() => callback(failure, failure ? '' : stdout, ''));
    return { stdin: { end: () => undefined } };
  });
}
const {
  default: tool,
  defaultWorktreeStatus,
  runFileAsync,
  resolveCutRoot,
  isAutoManagedCutWorktree,
  validateReleaseResumeResidue,
  prepareSeedlessCutRoot,
  RELEASE_SEEDLESS_PLACEHOLDER_NAME,
  RELEASE_SEEDLESS_PLACEHOLDER_CONTENT,
} = await import('./cut');

// The real live operator runs from an auto-managed `papercup-release` checkout,
// which the production guard must refuse. Most handler tests exercise unrelated
// routing, so give their implicit root an isolated fixture name.
process.env.PAPERCUSP_DESKTOP_ROOT = '/tmp/release-cut-fixture/papercusp-desktop';
// Hermetic: a shell that declares an edit tree (the :3170 drop-in does) would otherwise
// redirect canonicalDesktopRoot away from the fixture this suite asserts.
delete process.env.PAPERCUSP_CANONICAL_TREE;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

function mkPreflight(over: Partial<PreflightResult> = {}, inFlight = false): PreflightResult {
  return {
    go: !inFlight,
    desktopRoot: '/root/papercusp-desktop',
    checks: [
      { name: 'cutter', ok: true, detail: 'ok' },
      { name: 'signing-key', ok: true, detail: 'ok' },
      { name: 'no-cut-in-flight', ok: !inFlight, detail: inFlight ? 'a cut is already running' : 'no cut in flight' },
    ],
    blockers: inFlight ? ['no-cut-in-flight: a cut is already running'] : [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A bare vi.fn() never invokes execFile's callback, which would HANG an unstubbed path
  // instead of failing it. Fail loud; each test that expects a child stubs its own output.
  mockExecFile((command, args) => {
    throw new Error(`unstubbed execFile in cut.test.ts: ${command} ${args.join(' ')}`);
  });
  auditSqlM.mockResolvedValue([]);
  registryM.mockResolvedValue({ projects: [] });
  preflightM.mockReturnValue(mkPreflight());
  launchM.mockResolvedValue({
    launched: true,
    unit: 'pc-task1.service',
    version: '0.0.8',
    channel: 'alpha',
    legs: {},
    argv: [],
    logPath: '/tmp/papercup-release-cut.log',
    donePath: '/tmp/papercup-release-cut.done',
    operationId: 'op-1',
    taskId: 'task1',
  });
  beginOpM.mockResolvedValue({
    taskId: 'task1',
    operationId: 'op-1',
    identity: {
      version: '0.0.8',
      channel: 'alpha',
      platform: null,
      sourceSha: 'f'.repeat(40),
      gitlinks: {},
    },
    seed: {} as never,
    unit: 'pc-task1.service',
  });
  markSpawnedM.mockResolvedValue(undefined);
  provenanceM.mockResolvedValue({
    launchedBy: 'o', sessionId: 'o', harnessSlug: null, workItemId: null, planSlug: null, goalRef: null,
  });
});

describe('release:cut reclaim timing diagnostics', () => {
  it('correlates planner phases to the MCP request without logging target paths', async () => {
    const privateTarget = '/tmp/private-release-cut-target';
    reclaimGatherMock.mockImplementationOnce(async (options) => {
      options.onPhase?.({ phase: 'release-records', stage: 'start' });
      options.onPhase?.({ phase: 'release-records', stage: 'finish', elapsedMs: 65_000, outcome: 'fulfilled' });
      return {} as never;
    });
    // Partial render: only `counts` is read on this path. A checked assertion to the real
    // return type, not an `as never` escape (lint:mock-cast-escape).
    reclaimRenderMock.mockReturnValueOnce(
      { counts: { reclaimable: 0, namedOnly: 0, protected: 0 } } as ReturnType<typeof renderReclaimPlan>,
    );
    const log = vi.fn();

    const response = await tool.handler(
      { op: 'reclaim', targets: [privateTarget] } as never,
      { role: 'operator', requestOrigin: { mcpRequestTraceId: 'mcp-reclaim-trace' }, log } as never,
    );

    expect(body(response)).toMatchObject({ ok: true, op: 'reclaim', dryRun: true });
    const prefix = '[release:cut] reclaim timing ';
    const entries = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith(prefix))
      .map((message) => JSON.parse(message.slice(prefix.length)) as Record<string, unknown>);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ traceId: 'mcp-reclaim-trace', phase: 'handler', stage: 'start' }),
      expect.objectContaining({ traceId: 'mcp-reclaim-trace', phase: 'release-records', stage: 'start' }),
      expect.objectContaining({ traceId: 'mcp-reclaim-trace', phase: 'release-records', stage: 'finish', elapsedMs: 65_000 }),
      expect.objectContaining({ traceId: 'mcp-reclaim-trace', phase: 'response-serialization', stage: 'finish' }),
      expect.objectContaining({ traceId: 'mcp-reclaim-trace', phase: 'handler', stage: 'finish' }),
    ]));
    expect(JSON.stringify(entries)).not.toContain(privateTarget);
  });
});

/**
 * WI-10005193: release:cut is an MCP tool, so its children run on the OPERATOR MAIN THREAD.
 * Measured 2026-10-02T02:28:01Z on :3170: an event-loop-sentinel stall profile put 54% of samples
 * in execFileSync < defaultListWorktrees / defaultWorktreeStatus < resolveCutRoot, and prepare-tag
 * could hold the thread for its whole 120s timeout (the sentinel SIGKILLs the host at 20s).
 */
describe('release:cut — children never block the operator event loop (WI-10005193)', () => {
  async function useRealExecFile() {
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    installExecFile((command, args, options, callback) =>
      real.execFile(command, [...args], { ...options, encoding: 'utf8' }, callback),
    );
  }

  it('keeps the event loop turning while a child runs', async () => {
    await useRealExecFile();
    let ticks = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      ticks += 1;
      setTimeout(tick, 10);
    };
    setTimeout(tick, 10);
    let out: string;
    try {
      out = await runFileAsync(process.execPath, [
        '-e',
        'const t = Date.now(); while (Date.now() - t < 400) {} process.stdout.write("done")',
      ]);
    } finally {
      stopped = true;
    }
    expect(out).toBe('done');
    // A synchronous spawn holds the loop for the child's whole lifetime, so no timer can fire
    // before the result is returned: ticks would be 0. The child busy-loops for 400ms.
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  it('closes the child stdin, so a child that reads stdin sees EOF instead of hanging', async () => {
    await useRealExecFile();
    const out = await runFileAsync(
      process.execPath,
      ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"))'],
      { timeout: 10_000 },
    );
    expect(out).toBe('eof');
  });

  it('rejects with the child failure, as execFileSync threw', async () => {
    await useRealExecFile();
    await expect(
      runFileAsync(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)']),
    ).rejects.toThrow(/boom/);
  });

  it('cut.ts makes no synchronous child-process call', () => {
    const source = readFileSync(new URL('./cut.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Positive control: the stripped text is still the module (comment stripping ate nothing real).
    expect(code).toMatch(/\brunFileAsync\(/);
    expect(code).not.toMatch(/\b(?:execFileSync|spawnSync|execSync)\s*\(/);
  });
});

describe('release:cut — constrained root selector', () => {
  const worktreeRoot = '/registered/isolated-worktree';
  const desktopRoot = `${worktreeRoot}/papercusp-desktop`;

  it('reads worktree status without optional Git index writes', async () => {
    mockExecFile(() => '');

    await expect(defaultWorktreeStatus(worktreeRoot)).resolves.toBe('');
    expect(execFileM).toHaveBeenCalledWith(
      'git',
      ['-C', worktreeRoot, 'status', '--porcelain'],
      expect.objectContaining({
        timeout: 10_000,
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
      }),
      expect.any(Function),
    );
  });

  it('resolves a registered project slug to a clean linked worktree desktop root', async () => {
    const loadRegistry = vi.fn(async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }));
    const listWorktrees = vi.fn(() => [{ path: worktreeRoot, prunable: false }]);
    const status = vi.fn(() => '');

    const result = await resolveCutRoot('isolated', {
      loadRegistry,
      listWorktrees,
      status,
      canonicalPath: (candidate) => candidate,
    });

    expect(result).toEqual({
      ok: true,
      selector: 'isolated',
      worktreeRoot,
      desktopRoot,
    });
    expect(loadRegistry).toHaveBeenCalledWith('test-ws');
    expect(listWorktrees).toHaveBeenCalledWith(worktreeRoot);
    expect(status).toHaveBeenCalledWith(worktreeRoot);
  });

  it('accepts the selected worktree\'s papercusp-desktop child path', async () => {
    const result = await resolveCutRoot(desktopRoot, {
      loadRegistry: async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }),
      listWorktrees: () => [{ path: worktreeRoot, prunable: false }],
      status: () => '',
      canonicalPath: (candidate) => candidate,
    });

    expect(result).toEqual({
      ok: true,
      selector: desktopRoot,
      worktreeRoot,
      desktopRoot,
    });
  });

  it('rejects prunable worktrees and paths outside registered worktrees', async () => {
    const deps = {
      loadRegistry: async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }),
      listWorktrees: () => [{ path: worktreeRoot, prunable: true }],
      status: () => '',
      canonicalPath: (candidate: string) => candidate,
    };

    const prunable = await resolveCutRoot('isolated', deps);
    expect(prunable).toMatchObject({ ok: false, reason: expect.stringMatching(/root_not_registered/) });

    const outside = await resolveCutRoot('/unregistered/worktree', {
      ...deps,
      listWorktrees: () => [{ path: worktreeRoot, prunable: false }],
    });
    expect(outside).toMatchObject({ ok: false, reason: expect.stringMatching(/root_not_registered/) });
  });

  it('rejects a selected worktree with uncommitted changes', async () => {
    const result = await resolveCutRoot('isolated', {
      loadRegistry: async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }),
      listWorktrees: () => [{ path: worktreeRoot, prunable: false }],
      status: () => ' M packages/operator-core/lib/release-cut-launch.ts\n',
      canonicalPath: (candidate) => candidate,
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/root_not_clean/) });
  });

  it('WI-10003598: a read-only resolution (handoff) accepts the dirty root a finished cut leaves', async () => {
    const deps = {
      loadRegistry: async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }),
      listWorktrees: () => [{ path: worktreeRoot, prunable: false }],
      // What a finished cut leaves: the moved desktop gitlink and the lockfile.
      status: () => ' M package-lock.json\n M papercusp-desktop\n',
      canonicalPath: (candidate: string) => candidate,
    };
    const readOnly = await resolveCutRoot('isolated', deps, { readOnly: true });
    expect(readOnly).toMatchObject({ ok: true });
    // The same root still refuses a write op, and an unregistered root still refuses a read.
    expect(await resolveCutRoot('isolated', deps)).toMatchObject({ ok: false, reason: expect.stringMatching(/root_not_clean/) });
    expect(
      await resolveCutRoot('/unregistered/worktree', deps, { readOnly: true }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/root_not_registered/) });
  });

  it('accepts only the exact cutter-owned version residue for a completed-seed retry', async () => {
    const packageHead = '{\n  "name": "desktop",\n  "version": "0.0.17"\n}\n';
    const packageWorktree = '{\n  "name": "desktop",\n  "version": "0.0.18"\n}\n';
    const cargoLockHead = [
      '# @generated',
      'version = 3',
      '',
      '[[package]]',
      'name = "papercusp-desktop"',
      'version = "0.0.17"',
      'dependencies = []',
      '',
    ].join('\n');
    const cargoLockWorktree = cargoLockHead.replace(
      'name = "papercusp-desktop"\nversion = "0.0.17"',
      'name = "papercusp-desktop"\nversion = "0.0.18"',
    );
    const result = validateReleaseResumeResidue({
      superprojectStatus: ' m papercusp-desktop\n',
      desktopStatus: ' M package.json\n M src-tauri/Cargo.lock\n',
      version: '0.0.18',
      files: {
        'package.json': { head: packageHead, worktree: packageWorktree },
        'src-tauri/Cargo.lock': { head: cargoLockHead, worktree: cargoLockWorktree },
      },
    });
    expect(result).toEqual({ ok: true });

    expect(validateReleaseResumeResidue({
      superprojectStatus: ' m papercusp-desktop\n',
      desktopStatus: ' M package.json\n M src-tauri/Cargo.lock\n M src/main.rs\n',
      version: '0.0.18',
      files: {
        'package.json': { head: packageHead, worktree: packageWorktree },
        'src-tauri/Cargo.lock': { head: cargoLockHead, worktree: cargoLockWorktree },
      },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/non-cutter path/) });

    expect(validateReleaseResumeResidue({
      superprojectStatus: ' m papercusp-desktop\n',
      desktopStatus: ' M package.json\n',
      version: '0.0.18',
      files: { 'package.json': { head: packageHead, worktree: packageWorktree.replace('desktop', 'tampered') } },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/changes beyond/) });

    expect(validateReleaseResumeResidue({
      superprojectStatus: ' m papercusp-desktop\n',
      desktopStatus: ' M src-tauri/Cargo.lock\n',
      version: '0.0.18',
      files: {
        'src-tauri/Cargo.lock': {
          head: cargoLockHead,
          worktree: cargoLockWorktree.replace('dependencies = []', 'dependencies = ["tampered"]'),
        },
      },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/changes beyond/) });
  });

  it('accepts only source-identical staged environment sidecars on a completed-seed retry', () => {
    const stagedPath = 'src-tauri/env-sidecars/staging/harness/prompts/agent.tools.md';
    const source = 'committed prompt bytes\n';
    const input = {
      superprojectStatus: ' m papercusp-desktop\n',
      desktopStatus: ' M ' + stagedPath + '\n',
      version: '0.0.18',
      files: { [stagedPath]: { expectedSource: source, worktree: source } },
    };
    expect(validateReleaseResumeResidue(input)).toEqual({ ok: true });
    expect(validateReleaseResumeResidue({
      ...input,
      files: { [stagedPath]: { expectedSource: source, worktree: source + 'tampered' } },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/differs from its committed source sidecar/) });
    expect(validateReleaseResumeResidue({
      ...input,
      desktopStatus: ' M src-tauri/env-sidecars/staging/bin/unapproved\n',
      files: {
        'src-tauri/env-sidecars/staging/bin/unapproved': { expectedSource: source, worktree: source },
      },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/non-cutter path/) });
  });

  it('loads the committed sidecar source snapshot when resolving a completed-seed retry', async () => {
    const sourcePaths: string[] = [];
    const result = await resolveCutRoot('isolated', {
      loadRegistry: async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }),
      listWorktrees: () => [{ path: worktreeRoot, prunable: false }],
      status: () => ' m papercusp-desktop\n',
      desktopStatus: () => ' M src-tauri/env-sidecars/staging/serve.mjs\n',
      canonicalPath: (candidate) => candidate,
      headFile: (_root, relativePath) => {
        sourcePaths.push(relativePath);
        return 'committed serve bytes';
      },
      readFile: () => 'committed serve bytes',
      exists: () => true,
    }, { reuseSeedVersion: '0.0.18' });
    expect(result).toMatchObject({ ok: true });
    expect(sourcePaths).toEqual(['src-tauri/sidecar/serve.mjs']);
  });

  it('requires the completed seed manifest before admitting reuseSeed residue', async () => {
    const result = await resolveCutRoot('isolated', {
      loadRegistry: async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }),
      listWorktrees: () => [{ path: worktreeRoot, prunable: false }],
      status: () => '',
      canonicalPath: (candidate) => candidate,
      exists: () => false,
    }, { reuseSeedVersion: '0.0.18' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/root_resume_seed_missing/) });
  });

  it('admits seedless only when the seed root contains the exact canonical placeholder', async () => {
    const result = await resolveCutRoot('isolated', {
      loadRegistry: async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }),
      listWorktrees: () => [{ path: worktreeRoot, prunable: false }],
      status: () => '',
      canonicalPath: (candidate) => candidate,
      exists: () => true,
      readDir: () => [RELEASE_SEEDLESS_PLACEHOLDER_NAME],
      isRegularFile: () => true,
      readFile: () => RELEASE_SEEDLESS_PLACEHOLDER_CONTENT,
    }, { seedless: true });
    expect(result).toMatchObject({ ok: true, desktopRoot });
  });

  it('rejects seedless when any payload accompanies the placeholder', async () => {
    const result = await resolveCutRoot('isolated', {
      loadRegistry: async () => ({ projects: [{ slug: 'isolated', path: worktreeRoot }] }),
      listWorktrees: () => [{ path: worktreeRoot, prunable: false }],
      status: () => '',
      canonicalPath: (candidate) => candidate,
      exists: () => true,
      readDir: () => [RELEASE_SEEDLESS_PLACEHOLDER_NAME, 'manifest.json'],
      isRegularFile: () => true,
      readFile: () => RELEASE_SEEDLESS_PLACEHOLDER_CONTENT,
    }, { seedless: true });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/root_seedless_shape_invalid/) });
  });

  it('materializes the canonical placeholder only from an absent or empty seed root', () => {
    let seedRootExists = false;
    let entries: string[] = [];
    let placeholderContent = '';
    const result = prepareSeedlessCutRoot(desktopRoot, {
      exists: () => seedRootExists,
      makeDir: () => { seedRootExists = true; },
      readDir: () => entries,
      writeFile: (_absolutePath, content) => {
        entries = [RELEASE_SEEDLESS_PLACEHOLDER_NAME];
        placeholderContent = content;
      },
      isRegularFile: () => true,
      readFile: () => placeholderContent,
    });
    expect(result).toBeNull();
    expect(entries).toEqual([RELEASE_SEEDLESS_PLACEHOLDER_NAME]);
    expect(placeholderContent).toBe(RELEASE_SEEDLESS_PLACEHOLDER_CONTENT);
  });

  it('accepts porcelain submodule residue only when its frozen gitlink is independently verified', () => {
    const head = '{\n  "version": "0.0.17"\n}\n';
    const input = {
      superprojectStatus: ' M papercusp-desktop\n',
      desktopStatus: ' M package.json\n',
      version: '0.0.18',
      files: { 'package.json': { head, worktree: head.replace('0.0.17', '0.0.18') } },
    };
    expect(validateReleaseResumeResidue(input)).toMatchObject({ ok: false });
    expect(validateReleaseResumeResidue({ ...input, desktopHeadMatches: false })).toMatchObject({ ok: false });
    expect(validateReleaseResumeResidue({ ...input, desktopHeadMatches: true })).toEqual({ ok: true });
    expect(
      validateReleaseResumeResidue({
        ...input,
        desktopHeadMatches: true,
        files: { 'package.json': { head, worktree: head.replace('0.0.17', '0.0.19') } },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/changes beyond/) });
  });

  it('rejects the live deploy/checkpoint/staging roots that can move during a cut', async () => {
    expect(isAutoManagedCutWorktree('/workspace/papercup-release')).toBe(true);
    expect(isAutoManagedCutWorktree('/workspace/papercusp-checkpoint')).toBe(true);
    expect(isAutoManagedCutWorktree('/workspace/papercusp-staging')).toBe(true);
    expect(isAutoManagedCutWorktree('/workspace/papercusp-relcut-0018')).toBe(false);

    const result = await resolveCutRoot('/workspace/papercup-release', {
      loadRegistry: async () => ({ projects: [{ slug: 'papercusp', path: '/workspace/papercusp' }] }),
      listWorktrees: () => [{ path: '/workspace/papercup-release', prunable: false }],
      status: () => '',
      canonicalPath: (candidate) => candidate,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/root_not_isolated/) });
  });
});

describe('release:cut — explicit registered root routing', () => {
  const worktreeRoot = '/registered/isolated-worktree';
  const desktopRoot = `${worktreeRoot}/papercusp-desktop`;
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';

  function useRegisteredRoot() {
    registryM.mockResolvedValue({ projects: [{ slug: 'isolated', path: worktreeRoot }] });
    mockExecFile((command, args) => {
      if (command !== 'git') throw new Error(`unexpected command ${command}`);
      if (args[2] === 'worktree') return `worktree ${worktreeRoot}\nHEAD deadbeef\n\n`;
      if (args[2] === 'status') return '';
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
  }

  it('routes preflight through the selected desktop root', async () => {
    useRegisteredRoot();

    const b = body(await tool.handler({ op: 'preflight', root: 'isolated' } as never, { role: 'cup' } as never));

    expect(b).toMatchObject({ ok: true, op: 'preflight', root: desktopRoot, rootSelector: 'isolated', worktreeRoot });
    expect(preflightM).toHaveBeenCalledWith({}, { root: desktopRoot });
  });

  it('transports explicit tag deferral through preflight and both preview/confirmed launch paths', async () => {
    useRegisteredRoot();
    const common = { root: 'isolated', version: '0.0.29', channel: 'alpha', sourceSha, deferTag: true };
    const preflight = { op: 'preflight', ...common };
    expect(tool.args.safeParse(preflight).success).toBe(true);
    await tool.handler(preflight as never, { role: 'operator' } as never);
    expect(preflightM).toHaveBeenLastCalledWith({}, {
      root: desktopRoot, release: { version: common.version, channel: common.channel, sourceSha }, deferTag: true,
    });
    for (const op of ['run', 'run-leg']) {
      const args = { op, ...common, ownerName: 'Avi', ...(op === 'run-leg' ? { platform: 'linux' } : {}) };
      expect(tool.args.safeParse(args).success).toBe(true);
      const preview = body(await tool.handler(args as never, { role: 'operator' } as never));
      expect(preview.wouldRun).toContain("PAPERCUSP_RELEASE_DEFER_TAG='1'");
      await tool.handler({ ...args, confirm: true } as never, { role: 'operator' } as never);
      expect(launchM).toHaveBeenLastCalledWith(expect.objectContaining({
        root: desktopRoot, expectedSourceSha: sourceSha, runtime: expect.objectContaining({ deferTag: true }),
      }));
      expect(preflightM).toHaveBeenLastCalledWith({}, expect.objectContaining({ root: desktopRoot, deferTag: true }));
    }
  });

  it('routes status through a registered root and reads that root\'s status files', async () => {
    useRegisteredRoot();
    statusM.mockReturnValue({
      state: 'done',
      running: false,
      exitCode: 0,
      logTail: 'root-scoped log',
      logPath: '/tmp/root-scoped.log',
      donePath: '/tmp/root-scoped.done',
      operation: { operationId: 'op-root', taskId: 'taskroot001', startedAtSec: 1_700_000_000 },
    });
    const args = { op: 'status', root: 'isolated' };
    expect(tool.args.safeParse(args).success).toBe(true);

    const b = body(await tool.handler(args as never, { role: 'cup' } as never));

    expect(b).toMatchObject({
      ok: true,
      op: 'status',
      root: desktopRoot,
      rootSelector: 'isolated',
      worktreeRoot,
      state: 'done',
    });
    expect(statusM).toHaveBeenCalledWith({ platform: undefined, root: desktopRoot });
  });

  it('passes carried release context to preflight so it checks the exact release tag (EI-24611322499942803)', async () => {
    useRegisteredRoot();
    const args = {
      op: 'preflight',
      root: 'isolated',
      version: '0.0.20',
      channel: 'alpha',
      sourceSha,
      mac: true,
      windows: true,
    };

    expect(tool.args.safeParse(args).success).toBe(true);
    const b = body(await tool.handler(args as never, { role: 'cup' } as never));

    expect(b).toMatchObject({ ok: true, op: 'preflight', root: desktopRoot, rootSelector: 'isolated', worktreeRoot });
    expect(preflightM).toHaveBeenCalledWith(
      { mac: true, windows: true },
      { root: desktopRoot, release: { version: '0.0.20', channel: 'alpha', sourceSha } },
    );
  });

  it('routes run dry-run command construction through the selected desktop root', async () => {
    useRegisteredRoot();

    const b = body(
      await tool.handler(
        { op: 'run', version: '0.0.8', channel: 'alpha', sourceSha, root: 'isolated', ownerName: 'Avi' } as never,
        { role: 'operator' } as never,
      ),
    );

    expect(b).toMatchObject({ ok: true, op: 'run', dry_run: true, root: desktopRoot, rootSelector: 'isolated', worktreeRoot });
    expect(b.wouldRun).toContain(`--working-directory=${desktopRoot}`);
    expect(launchM).not.toHaveBeenCalled();
    expect(preflightM).toHaveBeenCalledWith(
      {},
      { root: desktopRoot, release: { version: '0.0.8', channel: 'alpha', sourceSha } },
    );
  });

  it('routes run-leg through the selected desktop root', async () => {
    useRegisteredRoot();

    const b = body(
      await tool.handler(
        { op: 'run-leg', platform: 'mac', version: '0.0.8', channel: 'alpha', sourceSha, root: 'isolated', ownerName: 'Avi' } as never,
        { role: 'operator' } as never,
      ),
    );

    expect(b).toMatchObject({ ok: true, op: 'run-leg', dry_run: true, root: desktopRoot, rootSelector: 'isolated', worktreeRoot });
    expect(b.wouldRun).toContain(`--working-directory=${desktopRoot}`);
    expect(preflightM).toHaveBeenCalledWith(
      { mac: true },
      { platform: 'mac', root: desktopRoot, release: { version: '0.0.8', channel: 'alpha', sourceSha } },
    );
    expect(launchM).not.toHaveBeenCalled();
  });

  it('routes gate-status through the selected desktop root', async () => {
    useRegisteredRoot();
    gateM.mockReturnValue({
      gate: {
        version: '0.0.8',
        channel: 'alpha',
        buildSha: 'abc1234',
        dirty: false,
        derivedAt: '2026-07-11T00:00:00.000Z',
        derivedBy: 'tester (role:cup)',
      },
      created: true,
    });

    const b = body(await tool.handler({ op: 'gate-status', version: '0.0.8', channel: 'alpha', root: 'isolated' } as never, { role: 'cup' } as never));

    expect(b).toMatchObject({ ok: true, op: 'gate-status', root: desktopRoot, rootSelector: 'isolated', worktreeRoot });
    expect(gateM).toHaveBeenCalledWith('0.0.8', 'alpha', 'tester', { root: desktopRoot });
  });

  it('routes handoff through the selected desktop root', async () => {
    useRegisteredRoot();
    handoffM.mockReturnValue({
      version: '0.0.8',
      targetRoot: `${desktopRoot}/src-tauri/target`,
      scannedRoots: [`${desktopRoot}/src-tauri/target`],
      found: false,
      artifacts: [],
      manifests: [],
      provenance: [],
      unsignedNames: [],
      unsignedInfoNames: [],
    });

    const b = body(await tool.handler({ op: 'handoff', version: '0.0.8', root: 'isolated' } as never, { role: 'cup' } as never));

    expect(b).toMatchObject({ ok: false, op: 'handoff', root: desktopRoot, targetRoot: `${desktopRoot}/src-tauri/target` });
    expect(handoffM).toHaveBeenCalledWith('0.0.8', { root: desktopRoot });
  });
});

describe('release:cut — preflight (read-only)', () => {
  it('returns the go/no-go, never launches', async () => {
    preflightM.mockReturnValue(mkPreflight());
    const b = body(await tool.handler({ op: 'preflight' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'preflight', go: true });
    expect(launchM).not.toHaveBeenCalled();
  });
  it('surfaces blockers when not ready', async () => {
    preflightM.mockReturnValue(mkPreflight({ go: false, blockers: ['signing-key: missing'] }));
    const b = body(await tool.handler({ op: 'preflight' } as never, { role: 'operator' } as never));
    expect(b.go).toBe(false);
    expect(b.note).toMatch(/signing-key: missing/);
  });
});

describe('release:cut — prepare-tag (explicit create-only remote ref)', () => {
  const sourceSha = 'f9030aa73955125a3f155444b0dc81668dc62ac0';
  const args = { op: 'prepare-tag', version: '0.0.18', channel: 'alpha', sourceSha };

  it('is a dry-run by default and discloses the only remote write', async () => {
    const b = body(await tool.handler(args as never, { role: 'cup' } as never));

    expect(b).toMatchObject({
      ok: true,
      op: 'prepare-tag',
      dry_run: true,
      tag: 'desktop-v0.0.18-alpha',
      remoteRefWrite: true,
      githubRelease: false,
      artifactUpload: false,
    });
    expect(b.wouldRun).toContain(`PAPERCUSP_RELEASE_PREPARE_TAG_SHA='${sourceSha}'`);
    expect(b.wouldRun).toContain("PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM='1'");
    expect(execFileM).not.toHaveBeenCalled();
  });

  it('previews an implicit auto-managed root without allowing a confirmed write', async () => {
    const priorRoot = process.env.PAPERCUSP_DESKTOP_ROOT;
    process.env.PAPERCUSP_DESKTOP_ROOT = '/workspace/papercusp-release/papercusp-desktop';
    try {
      const preview = body(await tool.handler(args as never, { role: 'operator' } as never));
      expect(preview).toMatchObject({
        ok: true, op: 'prepare-tag', dry_run: true, ready: false,
        tag: 'desktop-v0.0.18-alpha', remoteRefWrite: true,
      });
      expect(preview.blocker).toMatch(/root_not_isolated/);
      expect(preview.wouldRun).toContain('<registered-isolated-worktree>/papercusp-desktop');
      expect(preview.wouldRun).not.toContain('/workspace/papercusp-release/');
      expect(execFileM).not.toHaveBeenCalled();

      const confirmed = body(await tool.handler({ ...args, confirm: true } as never, { role: 'operator' } as never));
      expect(confirmed).toMatchObject({ ok: false, refused: true });
      expect(confirmed.reason).toMatch(/root_not_isolated/);
      expect(execFileM).not.toHaveBeenCalled();
    } finally {
      process.env.PAPERCUSP_DESKTOP_ROOT = priorRoot;
    }
  });

  it('rejects malformed source authority before resolving or writing a ref', async () => {
    const b = body(await tool.handler({ ...args, sourceSha: 'f9030aa' } as never, { role: 'operator' } as never));

    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_source_sha/);
    expect(execFileM).not.toHaveBeenCalled();
  });

  it('role-gates the confirmed remote write', async () => {
    const b = body(await tool.handler({ ...args, confirm: true } as never, { role: 'cup' } as never));

    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(execFileM).not.toHaveBeenCalled();
  });

  it('runs the release-owned helper with exact source + explicit confirmation', async () => {
    mockExecFile(() => 'created exact tag\n');

    const b = body(await tool.handler({ ...args, confirm: true } as never, { role: 'operator' } as never));

    expect(b).toMatchObject({
      ok: true,
      op: 'prepare-tag',
      tag: 'desktop-v0.0.18-alpha',
      sourceSha,
      remoteRefWrite: true,
      githubRelease: false,
      artifactUpload: false,
      output: 'created exact tag',
    });
    expect(execFileM).toHaveBeenCalledWith(
      expect.stringMatching(/papercusp-desktop\/bin\/release-local\.sh$/),
      ['0.0.18', 'alpha'],
      expect.objectContaining({
        env: expect.objectContaining({
          PAPERCUSP_RELEASE_PREPARE_TAG_SHA: sourceSha,
          PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM: '1',
        }),
      }),
      expect.any(Function),
    );
  });

  it('binds a tag from a build-dirty isolated root without allowing a dirty build launch', async () => {
    const worktreeRoot = '/registered/isolated-worktree';
    registryM.mockResolvedValue({ projects: [{ slug: 'isolated', path: worktreeRoot }] });
    mockExecFile((command, argv) => {
      if (command === 'git' && argv[2] === 'worktree') return `worktree ${worktreeRoot}\nHEAD ${sourceSha}\n\n`;
      if (command === 'git' && argv[2] === 'status') return ' M papercusp-desktop\n';
      if (command.endsWith('/bin/release-local.sh')) return 'created exact tag\n';
      throw new Error(`unexpected command: ${command} ${argv.join(' ')}`);
    });
    const bound = body(await tool.handler({ ...args, root: 'isolated', confirm: true } as never, { role: 'operator' } as never));
    expect(bound).toMatchObject({ ok: true, sourceSha, tag: 'desktop-v0.0.18-alpha' });
    const run = body(await tool.handler({ op: 'run', version: args.version, channel: args.channel, sourceSha,
      root: 'isolated', ownerName: 'Avi', deferTag: true, confirm: true } as never, { role: 'operator' } as never));
    expect(run).toMatchObject({ ok: false, refused: true });
    expect(run.reason).toMatch(/root_not_clean/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('returns a structured refusal when create detects an existing mismatch', async () => {
    mockExecFile(() => {
      throw new Error('origin refs/tags/desktop-v0.0.18-alpha already exists at deadbeef');
    });

    const b = body(await tool.handler({ ...args, confirm: true } as never, { role: 'operator' } as never));

    expect(b).toMatchObject({ ok: false, op: 'prepare-tag', refused: true, tag: 'desktop-v0.0.18-alpha' });
    expect(b.reason).toMatch(/prepare_tag_failed/);
    expect(b.reason).toMatch(/already exists/);
  });
});

describe('release:cut — status (read-only)', () => {
  it('accepts version/channel/sourceSha context carried by release-cut status callers', async () => {
    const statusArgs = {
      op: 'status',
      version: '0.0.19',
      channel: 'stable',
      sourceSha: '1feac8dd867c6566af834445a58b5a2e43b14649',
    };
    expect(tool.args.safeParse(statusArgs).success).toBe(true);

    statusM.mockReturnValue({
      state: 'idle',
      running: false,
      exitCode: null,
      logTail: null,
      logPath: '/tmp/papercup-release-cut.log',
      donePath: '/tmp/papercup-release-cut.done',
      // Idle: no started marker on the host, so there is no operation to attribute.
      operation: null,
    });
    const b = body(await tool.handler(statusArgs as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'idle' });
    expect(statusM).toHaveBeenCalledWith({ platform: undefined });
  });

  it('reports an in-flight cut without launching', async () => {
    const running: CutStatus = {
      state: 'running',
      running: true,
      exitCode: null,
      logTail: 'building…',
      logPath: '/tmp/papercup-release-cut.log',
      donePath: '/tmp/papercup-release-cut.done',
      operation: { operationId: 'op-1', taskId: 'task1', startedAtSec: 1_700_000_000 },
    };
    statusM.mockReturnValue(running);
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'running' });
    expect(b.note).toMatch(/in flight/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('reports an interrupted cut instead of collapsing a stopped unit to idle', async () => {
    const interrupted: CutStatus = {
      state: 'interrupted',
      running: false,
      exitCode: null,
      logTail: 'stopped by systemd',
      logPath: '/tmp/papercup-release-cut.log',
      donePath: '/tmp/papercup-release-cut.done',
      operation: { operationId: 'op-1', taskId: 'task1', startedAtSec: 1_700_000_000 },
    };
    statusM.mockReturnValue(interrupted);
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'interrupted' });
    expect(b.note).toMatch(/interrupted/i);
    // P-001: a managed interruption is RESUMABLE, and the note must say so — the whole
    // point of threading the operation id is that this case stops meaning "rebuild".
    expect(b.note).toMatch(/op-1/);
    expect(b.note).toMatch(/resumes/i);
    expect(launchM).not.toHaveBeenCalled();
  });
});

describe('release:cut — handoff (LOCAL deliverable)', () => {
  const found: HandoffResult = {
    version: '0.0.8',
    targetRoot: '/root/papercusp-desktop/src-tauri/target',
    scannedRoots: ['/root/papercusp-desktop/src-tauri/target'],
    found: true,
    artifacts: [
      { path: '/a/x.AppImage', name: 'x.AppImage', bytes: 1, sha256: 'deadbeef', signed: true },
    ],
    manifests: ['/a/latest.json'],
    provenance: ['/a/build-provenance.json'],
    unsignedNames: [],
    unsignedInfoNames: [],
  };

  it('rejects a malformed version before touching the fs', async () => {
    const b = body(await tool.handler({ op: 'handoff', version: 'v1.2' } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_version/);
    expect(handoffM).not.toHaveBeenCalled();
  });
  it('returns local paths + sha256 and the ship-gate reminder when all signed', async () => {
    handoffM.mockReturnValue(found);
    const b = body(await tool.handler({ op: 'handoff', version: '0.0.8' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'handoff', found: true });
    expect(b.artifacts[0]).toMatchObject({ sha256: 'deadbeef', signed: true });
    expect(b.shipGate).toMatch(/bin\/verify-provenance\.sh/);
    expect(b.shipGate).toMatch(/D-019's published signable suffixes/);
    expect(b.shipGate).toMatch(/DiskSpanning \.bin slices are intentionally excluded/);
    expect(b.shipGate).toMatch(/normalized \.zip remains signature-required/);
    expect(b.note).toMatch(/Never publish to GitHub/i);
  });
  it('loudly blocks hand-off when an UPDATER artifact is unsigned', async () => {
    handoffM.mockReturnValue({ ...found, unsignedNames: ['x.AppImage'], artifacts: [{ ...found.artifacts[0]!, signed: false }] });
    const b = body(await tool.handler({ op: 'handoff', version: '0.0.8' } as never, { role: 'operator' } as never));
    expect(b.shipGate).toMatch(/UNSIGNED/);
    expect(b.shipGate).toMatch(/x\.AppImage/);
  });
  it('an unsigned NON-updater artifact (dmg) is informational, NOT a blocker (WI-4243)', async () => {
    handoffM.mockReturnValue({
      ...found,
      unsignedInfoNames: ['y_0.0.8.dmg'],
      artifacts: [
        ...found.artifacts,
        { path: '/a/y_0.0.8.dmg', name: 'y_0.0.8.dmg', bytes: 1, sha256: 'cafef00d', signed: false },
      ],
    });
    const b = body(await tool.handler({ op: 'handoff', version: '0.0.8' } as never, { role: 'operator' } as never));
    expect(b.shipGate).toMatch(/All updater artifacts are signed/);
    expect(b.shipGate).not.toMatch(/Do NOT hand these over/);
    expect(b.shipGate).toMatch(/y_0\.0\.8\.dmg/); // still disclosed, as info
    expect(b.shipGate).toMatch(/not a blocker/);
  });
  it('found:false when nothing was cut for that version', async () => {
    handoffM.mockReturnValue({ version: '0.0.9', targetRoot: '/t', scannedRoots: ['/t', '/cargo-t'], found: false, artifacts: [], manifests: [], provenance: [], unsignedNames: [], unsignedInfoNames: [] });
    const b = body(await tool.handler({ op: 'handoff', version: '0.0.9' } as never, { role: 'cup' } as never));
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/no 0\.0\.9 artifacts/);
    expect(b.reason).toMatch(/\/cargo-t/); // every scanned root is named, not just src-tauri/target
  });
});

describe('release:cut — run (operator-gated write)', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  const runArgs = { op: 'run', version: '0.0.8', channel: 'alpha', sourceSha, ownerName: 'Avi' };
  const migrationBootSmokeOverride = {
    sourceSha,
    proofRef: 'WI-10003146#exact-source-pass',
    reason: 'Frozen source has the old aggregate Vitest deadline',
  };

  it('publishes seedless and fullHistory as explicit run arguments', () => {
    expect(tool.args.safeParse({ ...runArgs, seedless: true }).success).toBe(true);
    expect(tool.args.safeParse({ ...runArgs, fullHistory: true }).success).toBe(true);
  });
  it('transports D166 inputs through the public cut schema, preview and detached runtime', async () => {
    const seedUuidIdempotency = { plansPath: '/private/plans.json', plansSha256: 'a'.repeat(64), sourceStoreDir: '/private/frozen-original',
      censusPath: '/private/census.json', censusSha256: 'b'.repeat(64) };
    expect(tool.args.safeParse({ ...runArgs, seedUuidIdempotency }).success).toBe(true);
    expect(tool.args.safeParse({ ...runArgs, seedUuidIdempotency: { ...seedUuidIdempotency, plansSha256: 'bad' } }).success).toBe(false);
    expect(tool.args.safeParse({ ...runArgs, seedUuidIdempotency: { ...seedUuidIdempotency, censusPath: undefined } }).success).toBe(false);
    expect(tool.args.safeParse({ ...runArgs, seedUuidIdempotency: { ...seedUuidIdempotency, censusSha256: 'bad' } }).success).toBe(false);
    const preview = body(await tool.handler({ ...runArgs, seedUuidIdempotency } as never, { role: 'operator' } as never));
    expect(preview.wouldRun).toContain("PAPERCUSP_SEED_UUID_PLAN_PATH='/private/plans.json'");
    expect(preview.wouldRun).toContain("PAPERCUSP_SEED_UUID_CENSUS_PATH='/private/census.json'");
    expect(preview.wouldRun).toContain(`PAPERCUSP_SEED_UUID_CENSUS_SHA256='${'b'.repeat(64)}'`);
    await tool.handler({ ...runArgs, seedUuidIdempotency, confirm: true } as never, { role: 'operator' } as never);
    expect(launchM).toHaveBeenCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ seedUuidIdempotency }) }));
  });
  it('refuses UUID plans with seed reuse or seedless before opening a managed operation', async () => {
    const seedUuidIdempotency = { plansPath: '/private/plans.json', plansSha256: 'a'.repeat(64), sourceStoreDir: '/private/frozen-original',
      censusPath: '/private/census.json', censusSha256: 'b'.repeat(64) };
    for (const bad of [{ reuseSeed: true }, { seedless: true }]) {
      const result = body(await tool.handler({ ...runArgs, seedUuidIdempotency, ...bad } as never, { role: 'operator' } as never));
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('seed_uuid_mode_conflict') });
    }
    expect(beginOpM).not.toHaveBeenCalled(); expect(launchM).not.toHaveBeenCalled();
  });
  it('binds the whole-cut task, detached tests, and preview to the same caller harness', async () => {
    const ctx = { role: 'operator', harnessSlug: 'customer-app' } as never;
    const preview = body(await tool.handler(runArgs as never, ctx));
    expect(preview.wouldRun).toContain("PAPERCUSP_TEST_RUN_HARNESS='customer-app'");
    await tool.handler({ ...runArgs, confirm: true } as never, ctx);
    expect(beginOpM).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'customer-app' }));
    expect(launchM).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ harnessSlug: 'customer-app' }),
    }));
  });
  it('attributes the whole cut to the explicit parent despite a stale subtask goal', async () => {
    provenanceM.mockResolvedValue({
      launchedBy: 'o', sessionId: 'o', harnessSlug: null, workItemId: 'WI-parent', planSlug: null, goalRef: 'WI-subtask',
    });
    const args = { ...runArgs, work_item_id: 'WI-parent', confirm: true };
    expect(tool.args.safeParse(args).success).toBe(true);
    const b = body(await tool.handler(args as never, { role: 'operator' } as never));
    expect(b.ok).toBe(true);
    expect(provenanceM).toHaveBeenCalledWith(expect.anything(), null, undefined, {
      explicitWorkItemId: 'WI-parent', requireExplicitForMultipleHeldItems: true,
    });
    expect(beginOpM).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'WI-parent' }));
  });
  it('refuses an explicit unheld whole-cut item before opening or launching the task', async () => {
    provenanceM.mockRejectedValue(new BashProvenanceRefusal('work_item_not_held', 'WI-other is not held'));
    const b = body(await tool.handler({ ...runArgs, work_item_id: 'WI-other', confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: false, refused: true, reason: 'WI-other is not held' });
    expect(beginOpM).not.toHaveBeenCalled();
    expect(launchM).not.toHaveBeenCalled();
  });
  it('requires an explicit item for a whole cut when several items are held', async () => {
    provenanceM.mockRejectedValue(new BashProvenanceRefusal('work_item_id_required', 'name the release item'));
    const b = body(await tool.handler({ ...runArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: false, refused: true, reason: 'name the release item' });
    expect(beginOpM).not.toHaveBeenCalled();
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses conflicting seed controls before resolving or launching a root', async () => {
    const b = body(await tool.handler(
      { ...runArgs, reuseSeed: true, seedless: true } as never,
      { role: 'operator' } as never,
    ));
    expect(b).toMatchObject({ ok: false, refused: true });
    expect(b.reason).toMatch(/seed_mode_conflict/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses fullHistory when the selected mode skips the seed cut', async () => {
    for (const conflicting of [{ reuseSeed: true }, { seedless: true }]) {
      const b = body(
        await tool.handler({ ...runArgs, fullHistory: true, ...conflicting } as never, { role: 'operator' } as never),
      );
      expect(b).toMatchObject({ ok: false, refused: true });
      expect(b.reason).toMatch(/seed_history_mode_conflict/);
    }
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses mismatched proof before a launch or audit write', async () => {
    const b = body(await tool.handler({
      ...runArgs,
      migrationBootSmokeOverride: { ...migrationBootSmokeOverride, sourceSha: 'a'.repeat(40) },
      confirm: true,
    } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/source_mismatch/);
    expect(launchM).not.toHaveBeenCalled();
    expect(auditSqlM).not.toHaveBeenCalled();
  });

  it('previews the exceptional bypass and requires a durable audit write before launch', async () => {
    const args = { ...runArgs, migrationBootSmokeOverride };
    const preview = body(await tool.handler(args as never, { role: 'operator' } as never));
    expect(preview.wouldRun).toContain("PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE='1'");
    expect(auditSqlM).not.toHaveBeenCalled();

    auditSqlM.mockRejectedValueOnce(new Error('audit unavailable'));
    const refused = body(await tool.handler({ ...args, confirm: true } as never, { role: 'operator' } as never));
    expect(refused.refused).toBe(true);
    expect(refused.reason).toMatch(/release_cut_audit_required/);
    expect(launchM).not.toHaveBeenCalled();

    const launched = body(await tool.handler({ ...args, confirm: true } as never, { role: 'operator' } as never));
    expect(launched.launched).toBe(true);
    expect(launched.migrationBootSmokeOverrideAuditId).toMatch(/^relcut-/);
    expect(launchM).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ migrationBootSmokeOverride }),
    }));
    const auditDetails = JSON.parse(auditSqlM.mock.calls[1][1][5] as string);
    expect(auditDetails).toMatchObject({ sourceSha, proofRef: migrationBootSmokeOverride.proofRef });
  });

  it('is role-gated: a cup cannot cut, and no build fires', async () => {
    const b = body(await tool.handler({ ...runArgs, confirm: true } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('rejects a malformed version even for an operator', async () => {
    const b = body(await tool.handler({ op: 'run', version: 'bogus', channel: 'alpha', confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_version/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('rejects a missing or abbreviated source SHA before launching', async () => {
    for (const bad of [undefined, '1feac8dd']) {
      const b = body(await tool.handler({ ...runArgs, sourceSha: bad, confirm: true } as never, { role: 'operator' } as never));
      expect(b.refused).toBe(true);
      expect(b.reason).toMatch(/bad_source_sha/);
    }
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses to start a second cut when one is already in flight', async () => {
    preflightM.mockReturnValue(mkPreflight({}, /* inFlight */ true));
    const b = body(await tool.handler({ ...runArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/cut_in_flight/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('dry-run (no confirm) previews the exact LOCAL command and does NOT launch', async () => {
    const b = body(await tool.handler(runArgs as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(b.localOnly).toBe(true);
    expect(b.wouldRun).toMatch(/systemd-run/);
    expect(b.wouldRun).toContain(`bash -c 'source "$1" "$2" "$3"'`);
    expect(b.wouldRun).toContain('/tmp/release-cut-fixture/papercusp-desktop/bin/release-local.sh');
    expect(b.orchestratorRoot).toBe('/tmp/release-cut-fixture/papercusp-desktop');
    expect(b.wouldRun).toContain("PAPERCUSP_PUBLISH_GITHUB='0'");
    expect(b.wouldRun).toContain(`PAPERCUSP_EXPECTED_SOURCE_SHA='${sourceSha}'`);
    expect(b.wouldRun).toContain("PAPERCUSP_RELEASE_OWNER_NAME='Avi'");
    expect(b.wouldRun).not.toMatch(/gh release|push origin/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('reuseSeed dry-run restores only validated cutter-owned version files before relaunch', async () => {
    const b = body(await tool.handler({ ...runArgs, reuseSeed: true } as never, { role: 'operator' } as never));
    expect(b.wouldRun).toContain('git restore -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock &&');
    expect(b.wouldRun).toContain("PAPERCUSP_SKIP_SEED_CUT='1'");
    expect(launchM).not.toHaveBeenCalled();
  });

  it('fullHistory dry-run renders the required present-empty seed depth', async () => {
    const b = body(await tool.handler({ ...runArgs, fullHistory: true } as never, { role: 'operator' } as never));
    expect(b.fullHistory).toBe(true);
    expect(b.wouldRun).toContain("PAPERCUSP_SEED_DEPTH=''");
    expect(launchM).not.toHaveBeenCalled();
  });

  it('confirm:true fires the detached LOCAL cut', async () => {
    const b = body(await tool.handler({ ...runArgs, confirm: true, mac: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, op: 'run', launched: true, localOnly: true });
    expect(launchM).toHaveBeenCalledWith(expect.objectContaining({
      version: '0.0.8',
      channel: 'alpha',
      expectedSourceSha: sourceSha,
      runtime: {
        ownerName: 'Avi',
        ownerEmail: undefined,
        reuseSeed: undefined,
        // WI-10001570: the CANONICAL desktop root, so release-local.sh can write the
        // version bump back out of its throwaway worktree. Asserted as the literal
        // canonical path rather than expect.any(String) on purpose — passing the CUT
        // root here would satisfy a loose matcher while being exactly the silent no-op
        // this field exists to prevent.
        canonicalDesktopRoot: '/tmp/release-cut-fixture/papercusp-desktop',
        // P-001: the whole-cut path threads the same managed-release identity as a leg.
        releaseTaskId: 'task1',
        releaseOperationId: 'op-1',
        enqueuedAtMs: expect.any(Number),
      },
      legs: { mac: true, windows: undefined, arm64: undefined },
      root: expect.any(String),
      orchestratorRoot: '/tmp/release-cut-fixture/papercusp-desktop',
    }));
    expect(markSpawnedM).toHaveBeenCalledWith('task1', { confined: true, scopeUnit: 'pc-task1.service' });
    expect(launchM.mock.invocationCallOrder[0]).toBeLessThan(markSpawnedM.mock.invocationCallOrder[0]!);
  });

  it('opens the whole-cut operation with a null platform identity', async () => {
    await tool.handler({ ...runArgs, confirm: true, mac: true } as never, { role: 'operator' } as never);
    expect(beginOpM).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ platform: null }) }),
    );
  });
});

describe('release:cut — status (per-leg, WI-4233)', () => {
  it('passes platform through to readCutStatus and surfaces it in the reply', async () => {
    statusM.mockReturnValue({
      state: 'done',
      running: false,
      exitCode: 0,
      logTail: 'mac build ok',
      logPath: '/tmp/papercup-release-cut-mac.log',
      donePath: '/tmp/papercup-release-cut-mac.done',
      operation: { operationId: 'op-mac', taskId: 'taskmac1234', startedAtSec: 1_700_000_000 },
    });
    const b = body(await tool.handler({ op: 'status', platform: 'mac' } as never, { role: 'cup' } as never));
    expect(statusM).toHaveBeenCalledWith({ platform: 'mac' });
    expect(b).toMatchObject({ ok: true, op: 'status', platform: 'mac', state: 'done', unit: 'pc-taskmac1234.service' });
    expect(b.note).toContain("leg 'mac' (unit pc-taskmac1234.service)");
  });
});

describe('release:cut — gate-status (BUILD_SHA gate, WI-4233)', () => {
  const gate: ReleaseGate = {
    version: '0.0.8',
    channel: 'alpha',
    buildSha: 'abc1234',
    dirty: false,
    derivedAt: '2026-07-11T00:00:00.000Z',
    derivedBy: 'tester (role:cup)',
  };

  it('rejects a malformed version before touching the gate store', async () => {
    const b = body(await tool.handler({ op: 'gate-status', version: 'v1.2', channel: 'alpha' } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_version/);
    expect(gateM).not.toHaveBeenCalled();
  });
  it('open to any role (read/establish, not a heavy write) and reports created:true for the first caller', async () => {
    gateM.mockReturnValue({ gate, created: true });
    const b = body(await tool.handler({ op: 'gate-status', version: '0.0.8', channel: 'alpha' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'gate-status', created: true, buildSha: 'abc1234' });
    expect(b.note).toMatch(/Gate established/);
  });
  it('a later caller reading the existing gate gets created:false and a mismatch warning in the note', async () => {
    gateM.mockReturnValue({ gate, created: false });
    const b = body(await tool.handler({ op: 'gate-status', version: '0.0.8', channel: 'alpha' } as never, { role: 'cup' } as never));
    expect(b.created).toBe(false);
    expect(b.note).toMatch(/STOP/);
  });
});

describe('release:cut — abort-leg (operator-gated)', () => {
  it('is role-gated: a cup cannot abort a leg', async () => {
    const b = body(await tool.handler({ op: 'abort-leg', platform: 'mac' } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(abortLegM).not.toHaveBeenCalled();
  });
  it('an operator can stop a leg\'s unit', async () => {
    abortLegM.mockReturnValue({ stopped: true, unit: 'papercup-release-cut-mac' });
    const b = body(await tool.handler({ op: 'abort-leg', platform: 'mac' } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, op: 'abort-leg', platform: 'mac', stopped: true, unit: 'papercup-release-cut-mac' });
    expect(abortLegM).toHaveBeenCalledWith('mac');
  });
  it('a failed stop reports ok:false with the reason, not a throw', async () => {
    abortLegM.mockReturnValue({ stopped: false, unit: 'papercup-release-cut-mac', reason: 'not loaded' });
    const b = body(await tool.handler({ op: 'abort-leg', platform: 'mac' } as never, { role: 'operator' } as never));
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/not loaded/);
  });
});

describe('release:cut — run-leg (fleet-split, operator-gated write)', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  const legArgs = { op: 'run-leg', platform: 'mac', version: '0.0.8', channel: 'alpha', sourceSha, ownerName: 'Avi' };

  it('is role-gated: a cup cannot fire a leg', async () => {
    const b = body(await tool.handler({ ...legArgs, confirm: true } as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(launchM).not.toHaveBeenCalled();
  });
  it('rejects a malformed version even for an operator', async () => {
    const b = body(await tool.handler({ ...legArgs, version: 'bogus', confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/bad_version/);
    expect(launchM).not.toHaveBeenCalled();
  });
  it('refuses to start a leg already in flight (checks its OWN unit, via preflightCut)', async () => {
    preflightM.mockReturnValue(mkPreflight({}, /* inFlight */ true));
    const b = body(await tool.handler({ ...legArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/cut_in_flight/);
    expect(preflightM).toHaveBeenCalledWith(
      { mac: true },
      { platform: 'mac', root: expect.any(String), release: { version: '0.0.8', channel: 'alpha', sourceSha } },
    );
    expect(launchM).not.toHaveBeenCalled();
  });
  it('dry-run (no confirm) previews the command scoped to just this leg and does NOT launch', async () => {
    const b = body(await tool.handler(legArgs as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(b.platform).toBe('mac');
    expect(b.legs).toEqual({ mac: true });
    expect(b.unit).toBe('papercup-release-cut-mac');
    expect(b.wouldRun).toMatch(/--unit=papercup-release-cut-mac/);
    expect(b.note).toContain('completed same-version Linux leg');
    expect(b.note).toContain('op:run');
    expect(launchM).not.toHaveBeenCalled();
  });
  it('confirm:true fires the detached LOCAL leg with only that platform\'s flag set', async () => {
    launchM.mockResolvedValue({
      launched: true,
      unit: 'pc-task1.service',
      version: '0.0.8',
      channel: 'alpha',
      legs: { mac: true },
      argv: [],
      logPath: '/tmp/papercup-release-cut-mac.log',
      donePath: '/tmp/papercup-release-cut-mac.done',
      operationId: 'op-1',
      taskId: 'task1',
    });
    const b = body(await tool.handler({ ...legArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, op: 'run-leg', platform: 'mac', launched: true, localOnly: true, unit: 'pc-task1.service' });
    expect(markSpawnedM).toHaveBeenCalledWith('task1', { confined: true, scopeUnit: 'pc-task1.service' });
    expect(launchM).toHaveBeenCalledWith(expect.objectContaining({
      version: '0.0.8',
      channel: 'alpha',
      expectedSourceSha: sourceSha,
      runtime: {
        ownerName: 'Avi',
        ownerEmail: undefined,
        reuseSeed: undefined,
        // WI-10001570: the CANONICAL desktop root, so release-local.sh can write the
        // version bump back out of its throwaway worktree. Asserted as the literal
        // canonical path rather than expect.any(String) on purpose — passing the CUT
        // root here would satisfy a loose matcher while being exactly the silent no-op
        // this field exists to prevent.
        canonicalDesktopRoot: '/tmp/release-cut-fixture/papercusp-desktop',
        // P-001: the managed-release journal identity opened just before this launch.
        // Asserted as the exact ids rather than expect.any(String) for the same reason
        // as canonicalDesktopRoot above — a loose matcher is satisfied by the
        // half-configured pair that release-local.sh refuses.
        releaseTaskId: 'task1',
        releaseOperationId: 'op-1',
        enqueuedAtMs: expect.any(Number),
      },
      legs: { mac: true },
      platform: 'mac',
      root: expect.any(String),
    }));
  });
  it('a linux leg needs no WITH_* flag at all', async () => {
    launchM.mockResolvedValue({
      launched: true,
      unit: 'pc-task1.service',
      version: '0.0.8',
      channel: 'alpha',
      legs: {},
      argv: [],
      logPath: '/tmp/papercup-release-cut-linux.log',
      donePath: '/tmp/papercup-release-cut-linux.done',
      operationId: 'op-1',
      taskId: 'task1',
    });
    const b = body(await tool.handler({ ...legArgs, platform: 'linux', confirm: true } as never, { role: 'operator' } as never));
    expect(b.legs).toEqual({});
    expect(launchM).toHaveBeenCalledWith(expect.objectContaining({
      version: '0.0.8',
      channel: 'alpha',
      expectedSourceSha: sourceSha,
      legs: {},
      platform: 'linux',
      root: expect.any(String),
    }));
  });

  // P-001. The managed operation is opened BEFORE the launch, so a ledger failure lands
  // in the one place where it can still be reported honestly.
  it('opens the managed operation with the leg’s own platform identity', async () => {
    await tool.handler({ ...legArgs, confirm: true } as never, { role: 'operator' } as never);
    expect(beginOpM).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ platform: 'mac', version: '0.0.8', channel: 'alpha', sourceSha }),
      }),
    );
  });
  it('attributes a leg to the explicit parent despite a stale subtask goal', async () => {
    provenanceM.mockResolvedValue({
      launchedBy: 'o', sessionId: 'o', harnessSlug: null, workItemId: 'WI-parent', planSlug: null, goalRef: 'WI-subtask',
    });
    const args = { ...legArgs, work_item_id: 'WI-parent', confirm: true };
    expect(tool.args.safeParse(args).success).toBe(true);
    const b = body(await tool.handler(args as never, { role: 'operator' } as never));
    expect(b.ok).toBe(true);
    expect(provenanceM).toHaveBeenCalledWith(expect.anything(), null, undefined, {
      explicitWorkItemId: 'WI-parent', requireExplicitForMultipleHeldItems: true,
    });
    expect(beginOpM).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'WI-parent' }));
  });
  it('binds a leg task and its detached test proof to the caller harness', async () => {
    const ctx = { role: 'operator', harnessSlug: 'customer-app' } as never;
    const preview = body(await tool.handler(legArgs as never, ctx));
    expect(preview.wouldRun).toContain("PAPERCUSP_TEST_RUN_HARNESS='customer-app'");
    await tool.handler({ ...legArgs, confirm: true } as never, ctx);
    expect(beginOpM).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'customer-app' }));
    expect(launchM).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ harnessSlug: 'customer-app' }),
    }));
  });
  it('refuses an explicit unheld leg item before opening or launching the task', async () => {
    provenanceM.mockRejectedValue(new BashProvenanceRefusal('work_item_not_held', 'WI-other is not held'));
    const b = body(await tool.handler({ ...legArgs, work_item_id: 'WI-other', confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: false, refused: true, reason: 'WI-other is not held' });
    expect(beginOpM).not.toHaveBeenCalled();
    expect(launchM).not.toHaveBeenCalled();
  });
  it('requires an explicit item for a leg when several items are held', async () => {
    provenanceM.mockRejectedValue(new BashProvenanceRefusal('work_item_id_required', 'name the release item'));
    const b = body(await tool.handler({ ...legArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: false, refused: true, reason: 'name the release item' });
    expect(beginOpM).not.toHaveBeenCalled();
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses to launch when the task ledger cannot reserve a killable service unit', async () => {
    beginOpM.mockRejectedValue(new Error('ledger down'));
    const b = body(await tool.handler({ ...legArgs, confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: false, op: 'run-leg', refused: true });
    expect(b.reason).toMatch(/UNMANAGED/);
    expect(b.reason).toMatch(/ledger down/);
    expect(launchM).not.toHaveBeenCalled();
    expect(markSpawnedM).not.toHaveBeenCalled();
  });
});
