import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLocalGit } from '../../scratch-git-clone';
import { findBoxIdentityPaths, redactIdentityLeaks } from '../../../../../scripts/lib/identity-leak-patterns.mjs';
import {
  MAX_RECORDED_PASSED_CASES,
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  parseTestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';
import {
  MAX_OPERATIONAL_EVIDENCE_BYTES,
  inspectCommittedOperationalEvidence,
  operationalExecution,
  parseOperationalEvidenceArtifact,
  recordOperationalRun,
  executeOperationalRun,
  resolveOperationalSourceRoot,
  executePlanTerminalCensus,
  executeGitScratchPlacement,
  inspectPlanTerminalCensus,
  verifyOperationalCheckDefinitionAtCommit,
  recoverArchivedMutationFailures,
  verifyOriginalOperationalEvidence,
  type ArchivedMutationRun,
  type CommittedOperationalEvidence,
  type RecordOperationalRunDeps,
} from './record-run';

const ARTIFACT = {
  schemaVersion: 1 as const,
  kind: 'operational-test-evidence' as const,
  name: 'two-host chat parity',
  framework: 'playwright' as const,
  command: ['node', 'driver.mjs'],
  exitCode: 0,
  startedAt: '2026-09-08T02:01:00.000Z',
  finishedAt: '2026-09-08T02:05:00.000Z',
  summary: 'Desktop and portal assertions passed.',
  assertions: [
    { id: 'desktop', passed: true, evidence: 'desktop marker' },
    { id: 'portal', passed: true, evidence: 'portal marker' },
  ],
};

const EVIDENCE: CommittedOperationalEvidence = {
  artifact: ARTIFACT,
  filePath: 'docs/evidence/p013-run.json',
  sha256: 'a'.repeat(64),
  commit: 'b'.repeat(40),
};

describe('native Git scratch placement execution', () => {
  function fixture() {
    const ref = 'a'.repeat(40);
    const clonePath = '/mnt/data/tmp/papercusp-git-scratch-owned';
    const paths = new Set<string>();
    const persist = vi.fn(async (_params: Parameters<RecordOperationalRunDeps['persist']>[0]) => ({ written: 1, ids: [321] }));
    const clone = vi.fn(async (options: Parameters<typeof import('../../scratch-git-clone').createScratchClone>[0]) => {
      if (options.destination) throw new Error('scratchClone refuses repository materialisation on the root filesystem');
      paths.add(clonePath);
      return { path: clonePath, source: '/repo', requestedRef: ref, sha: ref, submodules: 0, borrowedRepositories: 1 };
    });
    const git = vi.fn<typeof runLocalGit>(async (args: string[]) => ({
      code: args[0] === 'symbolic-ref' ? 1 : 0,
      output: args[0] === 'rev-parse' ? ref : '',
    }));
    const deps = { clone, git,
      device: vi.fn(async (path: string) => path.startsWith('/mnt/data') ? 2 : 1),
      realpath: vi.fn(async (path: string) => path),
      exists: vi.fn(async (path: string) => paths.has(path)),
      remove: vi.fn(async (path: string) => { paths.delete(path); }),
      execution: { snapshot: vi.fn(() => ({ commit: 'b'.repeat(40), porcelain: '' })),
        readRuntime: vi.fn(async () => 'c'.repeat(64)), verifyDefinition: vi.fn(async () => true), persist },
    };
    const ctx = { workspaceId: 'workspace-test', harnessSlug: 'papercusp', projectDir: '/repo' };
    return { ref, deps, ctx, paths, clonePath, persist };
  }

  it('records actual default/refusal assertions with bracketing witnesses and removes only owned probes', async () => {
    const f = fixture();
    expect(await executeGitScratchPlacement(f.ref, f.ctx, f.deps)).toMatchObject({
      ok: true, status: 'pass', runtimeEnvironmentMeasured: true, testRunIds: [321],
    });
    expect(f.deps.clone).toHaveBeenCalledWith(expect.objectContaining({ source: '/repo', ref: f.ref }));
    expect(f.paths.size).toBe(0);
    expect(f.deps.remove).toHaveBeenCalledWith(f.clonePath);
    expect(f.persist.mock.calls[0][0].rows[0].execution).toMatchObject({
      operational: { command: ['testing:record-run', 'gitScratchPlacement', f.ref] }, failed: 0,
    });
    expect(f.deps.execution.readRuntime).toHaveBeenCalledTimes(2);
  });

  it('rejects a nonempty tree before copying and persists a failed check, never a historical pass', async () => {
    const f = fixture();
    f.deps.git.mockResolvedValueOnce({ code: 0, output: 'product-source' });
    expect(await executeGitScratchPlacement(f.ref, f.ctx, f.deps)).toMatchObject({ status: 'fail' });
    expect(f.deps.clone).not.toHaveBeenCalled();
    expect(f.persist.mock.calls[0][0].rows[0].outputTail).toContain('exact empty committed tree');
  });

  it.each([
    { mode: 'detached', code: 1, status: 'pass' },
    { mode: 'attached', code: 0, status: 'fail' },
    { mode: 'not-a-repository', code: 128, status: 'fail' },
  ] as const)('uses the production runner exit contract for $mode HEAD', async ({ mode, code, status }) => {
    const repo = mkdtempSync(join(tmpdir(), 'record-run-detached-head-'));
    try {
      if (mode !== 'not-a-repository') {
        git(repo, ['init', '-q']);
        git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
          'commit', '--allow-empty', '-qm', 'HEAD state fixture']);
        if (mode === 'detached') git(repo, ['checkout', '--detach', '-q', 'HEAD']);
      }
      const f = fixture();
      const scriptedGit = f.deps.git.getMockImplementation()!;
      const actual = await runLocalGit(['symbolic-ref', '-q', 'HEAD'], repo, new AbortController().signal);
      expect(actual.code).toBe(code);
      if (mode === 'detached') expect(actual.output).toContain('[scratch-git-runner]');
      f.deps.git.mockImplementation(async (args, cwd, signal) => args[0] === 'symbolic-ref'
        ? runLocalGit(args, repo, signal) : scriptedGit(args, cwd, signal));
      expect(await executeGitScratchPlacement(f.ref, f.ctx, f.deps)).toMatchObject({ status });
      const row = f.persist.mock.calls[0][0].rows[0];
      if (mode === 'detached') {
        expect(row.execution).toMatchObject({ passedCaseTitles: expect.arrayContaining(['git-detached-head']) });
      } else {
        expect(row.outputTail).toContain(`symbolic-ref -q HEAD exitCode=${code}`);
      }
      expect(f.paths.size).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fails when a root-side request is accepted and removes its uniquely owned probe', async () => {
    const f = fixture();
    f.deps.clone.mockImplementation(async options => {
      const path = options.destination ?? f.clonePath;
      f.paths.add(path);
      return { path, source: '/repo', requestedRef: f.ref, sha: f.ref, submodules: 0, borrowedRepositories: 1 };
    });
    expect(await executeGitScratchPlacement(f.ref, f.ctx, f.deps)).toMatchObject({ status: 'fail' });
    expect(f.persist.mock.calls[0][0].rows[0].outputTail).toContain('git-root-refused-before-write');
    expect(f.paths.size).toBe(0);
  });

  it('detects actual root-device placement despite a data-looking pathname', async () => {
    const f = fixture();
    f.deps.device.mockImplementation(async path => path === f.clonePath ? 1 : path.startsWith('/mnt/data') ? 2 : 1);
    expect(await executeGitScratchPlacement(f.ref, f.ctx, f.deps)).toMatchObject({ status: 'fail' });
    expect(f.persist.mock.calls[0][0].rows[0].outputTail).toContain('git-default-data-filesystem');
    expect(f.paths.size).toBe(0);
  });

  it('preserves a cleanup failure as a failed native measurement', async () => {
    const f = fixture();
    f.deps.remove.mockRejectedValue(new Error('owned probe cleanup failed'));
    expect(await executeGitScratchPlacement(f.ref, f.ctx, f.deps)).toMatchObject({ status: 'fail' });
    expect(f.persist.mock.calls[0][0].rows[0].outputTail).toContain('owned probe cleanup failed');
  });
});

describe('native operational execution witnesses', () => {
  function fixture() {
    const fingerprint = 'c'.repeat(64);
    const deps = {
      sourceRoot: vi.fn(async () => process.cwd()),
      snapshot: vi.fn(() => ({ commit: 'b'.repeat(40), porcelain: '' })),
      readRuntime: vi.fn(async () => fingerprint),
      verifyDefinition: vi.fn(async () => true),
      persist: vi.fn(async (_params: Parameters<RecordOperationalRunDeps['persist']>[0]) =>
        ({ written: 1, ids: [123] })),
    };
    const run = vi.fn(async () => ({ exitCode: 0, summary: 'Actual assertions passed.',
      assertions: [{ id: 'actual-result', passed: true, evidence: 'Observed result' }],
      runtimeEnvironmentBefore: { fingerprint: 'forged' }, testLayer: 'e2e',
      startedAt: '2000-01-01T00:00:00Z' }));
    const definition = { filePath: 'scripts/check.ts', name: 'native check',
      command: ['node', 'scripts/check.ts'], framework: 'node' as const,
      runtimeUnits: ['staging-api'], run };
    const ctx = { workspaceId: 'workspace-test', harnessSlug: 'papercusp', projectDir: process.cwd() };
    return { fingerprint, deps, definition, ctx };
  }

  it('brackets the actual execution and writes independent witnesses, never callback pins or layers', async () => {
    const f = fixture();
    const order: string[] = [];
    f.deps.readRuntime.mockImplementation(async () => { order.push('observe'); return f.fingerprint; });
    f.definition.run.mockImplementation(async () => {
      order.push('execute');
      return { exitCode: 0, summary: 'Actual assertions passed.',
        assertions: [{ id: 'actual-result', passed: true, evidence: 'Observed result' }],
        runtimeEnvironmentBefore: { fingerprint: 'forged' }, testLayer: 'e2e', startedAt: '2000-01-01T00:00:00Z' };
    });
    const result = await executeOperationalRun(f.definition, f.ctx, f.deps);
    expect(result).toMatchObject({ ok: true, testRunIds: [123], status: 'pass', runtimeEnvironmentMeasured: true });
    expect(order).toEqual(['observe', 'execute', 'observe']);
    const recorded = f.deps.persist.mock.calls[0][0];
    const execution = recorded.rows[0].execution as Record<string, any>;
    expect(execution.runtimeEnvironmentBefore.fingerprint).toBe(f.fingerprint);
    expect(execution.runtimeEnvironmentAfter.fingerprint).toBe(f.fingerprint);
    expect(Date.parse(execution.runtimeEnvironmentBefore.observedAt)).toBeLessThanOrEqual(recorded.rows[0].startedAt.getTime());
    expect(Date.parse(execution.runtimeEnvironmentAfter.observedAt)).toBeGreaterThanOrEqual(recorded.rows[0].finishedAt.getTime());
    expect(execution).not.toHaveProperty('testLayer');
    expect(execution.runStartedAt).not.toBe('2000-01-01T00:00:00Z');
    expect(recorded.worktreeDirty).toBe(false);
    expect(f.deps.readRuntime).toHaveBeenCalledWith(['staging-api'], 'workspace-test');
  });

  it('records the loaded instrument source independently of the canonical operation tree', async () => {
    const f = fixture();
    const sourceRoot = join(process.cwd(), '.native-runtime-source');
    const result = await executeOperationalRun(f.definition, f.ctx, {
      ...f.deps, sourceRoot: async () => sourceRoot,
    });
    expect(result).toMatchObject({ ok: true, status: 'pass' });
    expect(f.deps.snapshot.mock.calls).toEqual([[sourceRoot], [sourceRoot]]);
    expect(f.deps.verifyDefinition).toHaveBeenCalledWith(sourceRoot, 'scripts/check.ts', 'b'.repeat(40));
    expect(f.deps.persist.mock.calls[0][0]).toMatchObject({ root: sourceRoot, worktreeDirty: false });
    expect(f.ctx.projectDir).toBe(process.cwd());
  });

  it.each([null, new Error('loaded source unavailable')])(
    'refuses unavailable execution source without substituting the operation tree: %s', async unavailable => {
      const f = fixture();
      const result = await executeOperationalRun(f.definition, f.ctx, {
        ...f.deps, sourceRoot: async () => {
          if (unavailable instanceof Error) throw unavailable;
          return unavailable;
        },
      });
      expect(result).toMatchObject({ ok: false, error: 'operational_source_root_unavailable' });
      expect(f.deps.snapshot).not.toHaveBeenCalled();
      expect(f.definition.run).not.toHaveBeenCalled();
      expect(f.deps.persist).not.toHaveBeenCalled();
    },
  );

  it('resolves the loaded file from a Git worktree whose .git is a file', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'native-operational-worktree-'));
    const worktree = mkdtempSync(join(tmpdir(), 'native-operational-linked-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.name', 'Test']);
      git(repo, ['config', 'user.email', 'test@example.invalid']);
      mkdirSync(join(repo, 'instrument'));
      writeFileSync(join(repo, 'instrument', 'loaded.mjs'), 'export const loaded = true;\n');
      git(repo, ['add', 'instrument/loaded.mjs']);
      git(repo, ['commit', '-qm', 'loaded instrument']);
      rmSync(worktree, { recursive: true, force: true });
      git(repo, ['worktree', 'add', '-q', worktree, 'HEAD']);
      expect((await resolveOperationalSourceRoot(pathToFileURL(join(worktree, 'instrument', 'loaded.mjs')).href)))
        .toBe(worktree);
      expect((await resolveOperationalSourceRoot(pathToFileURL(join(worktree, 'instrument')).href))).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('fails closed for a missing loaded instrument path', async () => {
    await expect(resolveOperationalSourceRoot(pathToFileURL(join(tmpdir(), 'missing-native-instrument.mjs')).href))
      .resolves.toBeNull();
  });

  it('retains the original native command scope despite callback properties or argument mutation', async () => {
    const f = fixture();
    const command = ['executeGreenMainAdmissionWindow', 'workspace-test', 'install-test',
      '1791000000000', '1791604800000'];
    f.definition.command = [...command];
    f.definition.run.mockImplementation(async () => {
      f.definition.command[2] = 'different-install';
      return { exitCode: 0, summary: 'Original history checked.',
        assertions: [{ id: 'actual-result', passed: true, evidence: 'Observed' }],
        operational: { schemaVersion: 1, command: ['forged'] } } as any;
    });
    expect(await executeOperationalRun(f.definition, f.ctx, f.deps)).toMatchObject({ ok: true });
    expect(f.deps.persist.mock.calls[0][0].rows[0].execution)
      .toMatchObject({ operational: { schemaVersion: 1, command } });
  });

  it('keeps failed measurements absent and persists the actual thrown-check failure', async () => {
    const f = fixture();
    f.deps.readRuntime.mockRejectedValue(new Error('ledger unavailable'));
    f.definition.run.mockRejectedValue(new Error('native assertion failed'));
    expect(await executeOperationalRun(f.definition, f.ctx, f.deps)).toMatchObject({ ok: true, status: 'fail', runtimeEnvironmentMeasured: false });
    const execution = f.deps.persist.mock.calls[0][0].rows[0].execution;
    expect(execution).toMatchObject({ passed: 0, failed: 1, failedCaseTitles: ['native-check-exception'] });
    const output = f.deps.persist.mock.calls[0][0].rows[0].outputTail;
    expect(output).toContain('native-check-exception');
    expect(output).toContain('native assertion failed');
    expect(execution).not.toHaveProperty('runtimeEnvironmentBefore');
    expect(execution).not.toHaveProperty('runtimeEnvironmentAfter');
  });

  it('awaits both source reads before execution and persistence, retaining unreadable provenance', async () => {
    const f = fixture();
    const order: string[] = [];
    let releaseBefore!: (value: { commit: string; porcelain: string | null }) => void;
    let releaseAfter!: (value: { commit: string; porcelain: string | null }) => void;
    const snapshot = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { releaseBefore = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseAfter = resolve; }));
    f.deps.readRuntime.mockImplementation(async () => { order.push('runtime'); return f.fingerprint; });
    f.definition.run.mockImplementation(async () => {
      order.push('execute');
      return {
        exitCode: 0,
        summary: 'Actual check passed.',
        assertions: [{ id: 'actual-result', passed: true, evidence: 'Observed' }],
        runtimeEnvironmentBefore: { fingerprint: 'forged' },
        testLayer: 'e2e',
        startedAt: '2000-01-01T00:00:00Z',
      };
    });
    const pending = executeOperationalRun(f.definition, f.ctx, { ...f.deps, snapshot });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    expect(order).toEqual([]);
    releaseBefore({ commit: 'b'.repeat(40), porcelain: '' });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    expect(order).toEqual(['runtime', 'execute', 'runtime']);
    expect(f.deps.persist).not.toHaveBeenCalled();
    releaseAfter({ commit: 'b'.repeat(40), porcelain: null });
    expect(await pending).toMatchObject({ ok: true, status: 'pass' });
    expect(f.deps.persist.mock.calls[0][0].worktreeDirty).toBe(true);
  });

  it('retains the semantic failure after a long CLI trace in the canonical ledger output', async () => {
    const f = fixture();
    const cause = 'processes:kill refused: incomplete task 0mv8ao23519l3q0xtp0';
    f.definition.run.mockRejectedValue(new Error('MCP cleanup command failed\n' + 'connection trace\n'.repeat(400) + cause));
    expect(await executeOperationalRun(f.definition, f.ctx, f.deps)).toMatchObject({ ok: true, status: 'fail' });
    const recorded = f.deps.persist.mock.calls[0][0].rows[0];
    expect(recorded.outputTail).toContain('MCP cleanup command failed');
    expect(recorded.outputTail).toContain('[exception truncated:');
    expect(recorded.outputTail).toContain(cause);
    expect(recorded.outputTail!.length).toBeLessThanOrEqual(2200);
    expect(recorded.execution).toMatchObject({ failed: 1, failedCaseTitles: ['native-check-exception'] });
  });

  it('retains source/runtime changes rather than laundering them into stable proof', async () => {
    const f = fixture();
    f.deps.snapshot.mockReturnValueOnce({ commit: 'a'.repeat(40), porcelain: '' });
    f.deps.readRuntime.mockResolvedValueOnce('d'.repeat(64));
    expect(await executeOperationalRun(f.definition, f.ctx, f.deps)).toMatchObject({ runtimeEnvironmentMeasured: false });
    const recorded = f.deps.persist.mock.calls[0][0];
    const execution = recorded.rows[0].execution as Record<string, any>;
    expect(recorded.worktreeDirty).toBe(true);
    expect(execution.runtimeEnvironmentBefore.fingerprint).not.toBe(execution.runtimeEnvironmentAfter.fingerprint);
  });

  it('refuses invalid selectors before executing and reports failed ledger writes', async () => {
    const f = fixture();
    expect(await executeOperationalRun({ ...f.definition, runtimeUnits: ['duplicate', 'duplicate'] }, f.ctx, f.deps))
      .toMatchObject({ ok: false, error: 'invalid_runtime_units' });
    expect(f.definition.run).not.toHaveBeenCalled();
    f.deps.persist.mockResolvedValue({ written: 0, ids: [] });
    expect(await executeOperationalRun(f.definition, f.ctx, f.deps)).toMatchObject({ ok: false, error: 'ledger_write_failed' });
  });

  it('records a source-only execution under its committed check identity without inventing a runtime witness', async () => {
    const f = fixture();
    const result = await executeOperationalRun({ ...f.definition, runtimeUnits: [] }, f.ctx, f.deps);
    expect(result).toMatchObject({ ok: true, status: 'pass', testRunIds: [123], runtimeEnvironmentMeasured: false });
    expect(f.definition.run).toHaveBeenCalledOnce();
    expect(f.deps.snapshot).toHaveBeenCalledTimes(2);
    expect(f.deps.readRuntime).not.toHaveBeenCalled();
    const recorded = f.deps.persist.mock.calls[0][0];
    expect(recorded.worktreeDirty).toBe(false);
    expect(recorded.rows[0].filePath).toBe('scripts/check.ts');
    expect(recorded.rows[0].execution).not.toHaveProperty('runtimeEnvironmentBefore');
    expect(recorded.rows[0].execution).not.toHaveProperty('runtimeEnvironmentAfter');
    expect(recorded.rows[0].execution).not.toHaveProperty('testLayer');
  });

  it('refuses a future output artifact before executing or publishing a clean ledger row', async () => {
    const f = fixture();
    f.deps.verifyDefinition.mockResolvedValue(false);
    expect(await executeOperationalRun(f.definition, f.ctx, f.deps)).toMatchObject({
      ok: false, error: 'operational_check_definition_unavailable',
      filePath: 'scripts/check.ts', commit: 'b'.repeat(40),
    });
    expect(f.deps.verifyDefinition).toHaveBeenCalledWith(expect.any(String), 'scripts/check.ts', 'b'.repeat(40));
    expect(f.definition.run).not.toHaveBeenCalled();
    expect(f.deps.readRuntime).not.toHaveBeenCalled();
    expect(f.deps.persist).not.toHaveBeenCalled();
  });

  it('checks the exact historical definition rather than accepting a later working-tree artifact', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'native-operational-definition-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.name', 'Test']);
      git(repo, ['config', 'user.email', 'test@example.invalid']);
      mkdirSync(join(repo, 'scripts'));
      writeFileSync(join(repo, 'scripts/check.ts'), 'export const expected = 47;\n');
      git(repo, ['add', 'scripts/check.ts']);
      git(repo, ['commit', '-qm', 'committed check definition']);
      const commit = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'scripts/output.json'), '{"passed":true}\n');
      await expect(verifyOperationalCheckDefinitionAtCommit(repo, 'scripts/check.ts', commit)).resolves.toBe(true);
      await expect(verifyOperationalCheckDefinitionAtCommit(repo, 'scripts/output.json', commit)).resolves.toBe(false);
      await expect(verifyOperationalCheckDefinitionAtCommit(repo, 'scripts', commit)).resolves.toBe(false);
      await expect(verifyOperationalCheckDefinitionAtCommit(repo, 'scripts/check.ts', null)).resolves.toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('canonical plan terminal census', () => {
  function row(status = 'done', text = 'Completed item') {
    return { version: 7, contentHash: 'plan-hash', content: '', items: [{ id: 'P-001', status, text,
      importance: 'normal', blockedBy: [], decisionRefs: [], phase: null }] } as Parameters<typeof inspectPlanTerminalCensus>[0];
  }
  it('passes done and explicit dropped reasons, and enumerates each item', async () => {
    const plan = row()!;
    plan.items.push({ ...plan.items[0], id: 'P-002', status: 'dropped', text: 'Old item — note: Superseded by the verified replacement.' });
    expect(await inspectPlanTerminalCensus(plan)).toMatchObject({ exitCode: 0, assertions: [
      { id: 'plan-terminal-census:population', passed: true },
      { id: 'plan-terminal-census:P-001', passed: true },
      { id: 'plan-terminal-census:P-002', passed: true },
    ] });
  });
  it.each(['todo', 'wip', 'blocked', 'needs-human', 'dropped'])('fails an unresolved or unexplained %s item', async status => {
    expect(await inspectPlanTerminalCensus(row(status))).toMatchObject({ exitCode: 1,
      assertions: [{ passed: true }, { id: 'plan-terminal-census:P-001', passed: false }] });
  });
  it('cannot pass a missing, empty, duplicate or oversized population', async () => {
    for (const population of [null, { ...row()!, items: [] },
      { ...row()!, items: [row()!.items[0], row()!.items[0]] },
      { ...row()!, items: Array.from({ length: 99 }, (_, i) => ({ ...row()!.items[0], id: `P-${i}` })) }]) {
      expect(await inspectPlanTerminalCensus(population)).toMatchObject({ exitCode: 1,
        assertions: [{ id: 'plan-terminal-census:population', passed: false }] });
    }
  });
  it('records actual per-item failures and fails a population that changes during execution', async () => {
    const persist = vi.fn(async (_params: Parameters<RecordOperationalRunDeps['persist']>[0]) => ({ written: 1, ids: [123] }));
    const execution = { snapshot: vi.fn(() => ({ commit: 'b'.repeat(40), porcelain: '' })),
      readRuntime: vi.fn(async () => 'c'.repeat(64)), verifyDefinition: vi.fn(async () => true), persist };
    const readPlan = vi.fn(async () => row('dropped'));
    const ctx = { workspaceId: 'workspace-test', harnessSlug: 'papercusp', projectDir: process.cwd() };
    const result = await executePlanTerminalCensus('prior-plan', ctx, { readPlan, execution });
    expect(result).toMatchObject({ ok: true, status: 'fail', testRunIds: [123] });
    expect(persist.mock.calls[0][0].rows[0].execution).toMatchObject({ failed: 1,
      failedCaseTitles: ['plan-terminal-census:P-001'],
      operational: { command: ['testing:record-run', 'planTerminalCensus', 'prior-plan'] } });
    readPlan.mockResolvedValueOnce(row()).mockResolvedValueOnce({ ...row()!, version: 8 });
    expect(await executePlanTerminalCensus('prior-plan', ctx, { readPlan, execution })).toMatchObject({ status: 'fail' });
    expect(persist.mock.calls[1][0].rows[0].execution).toMatchObject({ failed: 1,
      failedCaseTitles: ['plan-terminal-census:unchanged'] });
    expect(persist.mock.calls[1][0].rows[0].outputTail).toContain('Plan changed or became unavailable');
  });
});

const MUTATION_PROBE = {
  schemaVersion: 1 as const,
  runnerPath: 'scripts/mutation-probe.sh' as const,
  runnerSha256: 'c'.repeat(64),
  runnerCommit: 'd'.repeat(40),
  cwd: '.',
  argv: [
    '--file',
    'packages/operator-core/lib/agent-tools/testing/record-run.ts',
    '--mutate',
    's/return result.data/return null/',
    '--test',
    'npm run test:file -- packages/operator-core/lib/agent-tools/testing/record-run.test.ts',
  ],
  result: {
    verdict: 'caught' as const,
    expected: 'caught' as const,
    target: 'copy-out',
    baselineExit: 0,
    guardExit: 1,
    mutantParse: 'ok',
    assertionEvidence: 'assertion-failure',
    relocation: 'overlay',
  },
};

function mutationEvidence(command = ['scripts/mutation-probe.sh']) {
  return {
    ...ARTIFACT,
    command,
    summary: 'Mutation-probe runner rejected the mutation as expected.',
    assertions: [{ id: 'mutation-caught', passed: true, evidence: 'MUTATION_PROBE_RESULT verdict=caught' }],
    mutationProbes: [{ ...MUTATION_PROBE, argv: [...MUTATION_PROBE.argv] }],
  };
}

function deps(overrides: Partial<RecordOperationalRunDeps> = {}): RecordOperationalRunDeps {
  return {
    inspectEvidence: vi.fn(() => EVIDENCE),
    findIds: vi.fn(async () => []),
    persist: vi.fn(async () => ({ written: 1, ids: [77] })),
    readArchivedRun: vi.fn(async () => null),
    verifyOriginalEvidence: vi.fn(async () => true),
    ...overrides,
  };
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  return (result.stdout ?? '').trim();
}

function archivedMutationFixture() {
  const filePath = 'packages/operator-core/example.integration.test.ts';
  const scope = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' };
  const titles = ['suite > long DOM failure', 'suite > literal "quoted": failure'];
  const probe = { ...MUTATION_PROBE, result: { ...MUTATION_PROBE.result,
    assertionEvidence: 'test-file-assertion-failure' } };
  const original: ArchivedMutationRun = {
    id: 42, file_path: filePath, source: 'mutation-probe', status: 'fail', framework: 'vitest',
    workspace_id: scope.workspaceId, harness_slug: scope.harnessSlug,
    commit_sha: probe.runnerCommit, worktree_dirty: false,
    started_at: ARTIFACT.startedAt, finished_at: ARTIFACT.finishedAt,
    execution_details: { schemaVersion: 1, root: '/immutable', filePath, runGroupId: null,
      ...scope, testNamePattern: null, testLayer: 'integration', mutationPhase: 'mutant',
      commitSha: probe.runnerCommit, worktreeDirty: false,
      passed: 1, failed: 2, skipped: 0, collectionFailed: false },
  };
  const archiveLog = [
    'TEST_FILE_PROVENANCE head=dddddddddd testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-09-08T02:00:00.000Z',
    ...titles.map(title => `TEST_FILE_ASSERTION_FAILURE file=${JSON.stringify(`/immutable/${filePath}`)} name=${JSON.stringify(title)} message=${JSON.stringify('<aside>'.repeat(1500))}`),
    '      Tests  2 failed | 1 passed (3)',
    'TEST_FILE_PROVENANCE head=dddddddddd testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-09-08T02:06:00.000Z',
    'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=dddddddddd uncommittedPaths=0/1 provenance=stamped startedAt=2026-09-08T02:00:00.000Z skippedTests=0',
    `MUTATION_PROBE_EVIDENCE_JSON=${JSON.stringify(probe)}`,
  ].join('\n');
  const evidence: CommittedOperationalEvidence = { ...EVIDENCE, archiveLog,
    artifact: { ...ARTIFACT, framework: 'shell', mutationProbes: [probe], archivedMutation: {
      originalTestRunId: 42, rawLogFile: 'docs/evidence/mutation.log',
      rawLogSha256: createHash('sha256').update(archiveLog).digest('hex'),
    } } };
  return { evidence, original, scope, titles };
}

describe('archived mutation identity recovery (EI-25248905256718690)', () => {
  it('reads hash-pinned historical bytes after publishing a portable log, without changing receipt identity', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'record-archived-publication-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.email', 'test@example.invalid']);
      git(repo, ['config', 'user.name', 'Test']);
      mkdirSync(join(repo, 'docs/evidence'), { recursive: true });
      mkdirSync(join(repo, 'scripts'));
      const runner = '#!/bin/sh\nexit 0\n';
      writeFileSync(join(repo, 'scripts/mutation-probe.sh'), runner);
      const { evidence, original, scope, titles } = archivedMutationFixture();
      const privatePath = ['file:', '', 'home', 'archive-writer', 'runner.js'].join('/');
      const runnerSha256 = createHash('sha256').update(runner).digest('hex');
      const raw = `${evidence.archiveLog!.replace(MUTATION_PROBE.runnerSha256, runnerSha256)}\n    at ${privatePath}:1:2\n`;
      writeFileSync(join(repo, 'docs/evidence/mutation.log'), raw);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'original raw proof']);
      const rawLogCommit = git(repo, ['rev-parse', 'HEAD']);
      const publicView = redactIdentityLeaks(raw, []);
      expect(findBoxIdentityPaths(raw)).not.toHaveLength(0);
      expect(findBoxIdentityPaths(publicView)).toHaveLength(0);
      expect(publicView).not.toBe(raw);
      writeFileSync(join(repo, 'docs/evidence/mutation.log'), publicView);
      const artifact = { ...evidence.artifact,
        mutationProbes: evidence.artifact.mutationProbes!.map(probe => ({ ...probe,
          runnerSha256 })),
        archivedMutation: { ...evidence.artifact.archivedMutation!, rawLogCommit,
          rawLogSha256: createHash('sha256').update(raw).digest('hex') },
      };
      const publish = (value: typeof artifact) => {
        const bytes = JSON.stringify(value);
        writeFileSync(join(repo, 'docs/evidence/archive.json'), bytes);
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'portable publication']);
        return createHash('sha256').update(bytes).digest('hex');
      };
      const hash = publish(artifact);
      const loaded = await inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', hash);
      expect(loaded.archiveLog).toBe(raw);
      const saved = structuredClone(original);
      expect(recoverArchivedMutationFailures(loaded, original, scope).titles)
        .toEqual(titles);
      expect(original).toEqual(saved);
      expect(git(repo, ['show', `${rawLogCommit}:docs/evidence/mutation.log`])).toBe(raw.trim());
      const badHash = publish({ ...artifact, archivedMutation: { ...artifact.archivedMutation,
        rawLogSha256: createHash('sha256').update(publicView).digest('hex') } });
      await expect(inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', badHash))
        .rejects.toThrow('evidence_archive_sha256_mismatch');
      const unavailable = publish({ ...artifact, archivedMutation: { ...artifact.archivedMutation,
        rawLogCommit: 'e'.repeat(40) } });
      await expect(inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', unavailable))
        .rejects.toThrow('evidence_archive_commit_unavailable');
      const unsafe = { ...artifact, archivedMutation: { ...artifact.archivedMutation, rawLogCommit: 'HEAD' } };
      expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(unsafe))))
        .toThrow('archivedMutation.rawLogCommit');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('requires the archive hash and exact committed log bytes before reading a receipt', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'record-archived-mutation-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.email', 'test@example.invalid']);
      git(repo, ['config', 'user.name', 'Test']);
      mkdirSync(join(repo, 'docs/evidence'), { recursive: true });
      mkdirSync(join(repo, 'scripts'));
      const runner = '#!/bin/sh\nexit 0\n';
      writeFileSync(join(repo, 'scripts/mutation-probe.sh'), runner);
      const { evidence } = archivedMutationFixture();
      const artifact = { ...evidence.artifact, mutationProbes: evidence.artifact.mutationProbes!.map(probe => ({
        ...probe, runnerSha256: createHash('sha256').update(runner).digest('hex'),
      })) };
      const artifactBytes = JSON.stringify(artifact);
      const hash = createHash('sha256').update(artifactBytes).digest('hex');
      writeFileSync(join(repo, 'docs/evidence/archive.json'), artifactBytes);
      writeFileSync(join(repo, 'docs/evidence/mutation.log'), evidence.archiveLog!);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'archive fixture']);
      expect(await inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', hash))
        .toMatchObject({ archiveLog: evidence.archiveLog });
      writeFileSync(join(repo, 'docs/evidence/mutation.log'), 'tampered');
      await expect(inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json', hash))
        .rejects.toThrow('evidence_archive_sha256_mismatch');
      const changedArtifact = { ...artifact, archivedMutation: { ...artifact.archivedMutation!,
        rawLogSha256: createHash('sha256').update('tampered').digest('hex') } };
      const changedBytes = JSON.stringify(changedArtifact);
      writeFileSync(join(repo, 'docs/evidence/archive.json'), changedBytes);
      // Only commit the JSON: a matching hash must not certify an uncommitted raw log.
      git(repo, ['add', 'docs/evidence/archive.json']);
      git(repo, ['commit', '-qm', 'changed artifact fixture']);
      await expect(inspectCommittedOperationalEvidence(repo, 'docs/evidence/archive.json',
        createHash('sha256').update(changedBytes).digest('hex'))).rejects.toThrow('evidence_archive_not_committed');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('recovers exact machine identities despite long DOM messages and preserves the original receipt', async () => {
    const { evidence, original, scope, titles } = archivedMutationFixture();
    const saved = structuredClone(original);
    const d = deps({ inspectEvidence: vi.fn(() => evidence), readArchivedRun: vi.fn(async () => original) });
    const result = await recordOperationalRun({ evidenceFile: evidence.filePath, expectedSha256: evidence.sha256,
      harness: scope.harnessSlug }, { ...scope, projectDir: process.cwd() }, d);
    expect(result).toMatchObject({ ok: true, status: 'fail', recoveredFromTestRunId: 42, testRunIds: [77] });
    expect(d.readArchivedRun).toHaveBeenCalledWith(42, scope);
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ source: 'mutation-probe',
      root: '/immutable', commit: original.commit_sha, worktreeDirty: false,
      rows: [expect.objectContaining({ filePath: original.file_path, status: 'fail',
        outputTail: expect.stringContaining('No new test execution.'),
        execution: { passed: 1, failed: 2, skipped: 0, collectionFailed: false,
          testLayer: 'integration', failedCaseTitles: titles } })] }));
    expect(original).toEqual(saved);
  });

  it('returns the existing recovery record without inserting a second one', async () => {
    const { evidence, original, scope } = archivedMutationFixture();
    const d = deps({ inspectEvidence: vi.fn(() => evidence), readArchivedRun: vi.fn(async () => original),
      findIds: vi.fn(async () => [88]) });
    expect(await recordOperationalRun({ evidenceFile: evidence.filePath, expectedSha256: evidence.sha256,
      harness: scope.harnessSlug }, scope, d)).toMatchObject({ ok: true, alreadyRecorded: true, testRunIds: [88] });
    expect(d.persist).not.toHaveBeenCalled();
  });

  it.each([
    ['missing receipt', (r: ArchivedMutationRun) => null],
    ['wrong id', (r: ArchivedMutationRun) => ({ ...r, id: 43 })],
    ['wrong workspace', (r: ArchivedMutationRun) => ({ ...r, workspace_id: 'elsewhere' })],
    ['wrong harness', (r: ArchivedMutationRun) => ({ ...r, harness_slug: 'elsewhere' })],
    ['ordinary failed run', (r: ArchivedMutationRun) => ({ ...r, source: 'local' })],
    ['successful run', (r: ArchivedMutationRun) => ({ ...r, status: 'pass' })],
    ['dirty execution', (r: ArchivedMutationRun) => ({ ...r, worktree_dirty: true })],
    ['different commit', (r: ArchivedMutationRun) => ({ ...r, commit_sha: 'e'.repeat(40) })],
    ['malformed measurement', (r: ArchivedMutationRun) => ({ ...r, execution_details: {} })],
    ['different time window', (r: ArchivedMutationRun) => ({ ...r, finished_at: '2026-09-09T02:00:00.000Z' })],
  ])('refuses %s before inserting evidence', async (_name, change) => {
    const { evidence, original, scope } = archivedMutationFixture();
    const d = deps({ inspectEvidence: vi.fn(() => evidence), readArchivedRun: vi.fn(async () => change(original)) });
    expect(await recordOperationalRun({ evidenceFile: evidence.filePath, expectedSha256: evidence.sha256,
      harness: scope.harnessSlug }, scope, d)).toMatchObject({ ok: false });
    expect(d.persist).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign file', (s: string) => s.replace('/immutable/packages/', '/foreign/packages/')],
    ['missing failure', (s: string) => s.split('\n').filter(line => !line.includes('literal')).join('\n')],
    ['misleading DOM identity', (s: string) => s.replace('name="suite > long DOM failure"', 'name="<aside>"')],
    ['wrong counts', (s: string) => s.replace('2 failed | 1 passed', '2 failed | 2 passed')],
    ['unproven verdict', (s: string) => s.replace('provenance=stamped', 'provenance=unknown')],
    ['different probe', (s: string) => s.replace('"guardExit":1', '"guardExit":0')],
  ])('rejects %s from a saved log', (_name, change) => {
    const { evidence, original, scope } = archivedMutationFixture();
    // A changed, syntactically valid title must not disagree with prior structured identities.
    const receipt = { ...original, execution_details: { ...(original.execution_details as object),
      failedCaseTitles: archivedMutationFixture().titles } };
    expect(() => recoverArchivedMutationFailures({ ...evidence, archiveLog: change(evidence.archiveLog!) }, receipt, scope)).toThrow();
  });
});

describe('testing:record-run', () => {
  it('derives a pass, persists through the shared writer, and returns numeric IDs', async () => {
    const inspectEvidence = vi.fn(async () => EVIDENCE);
    const d = deps({ inspectEvidence });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toMatchObject({ ok: true, alreadyRecorded: false, status: 'pass', testRunIds: [77] });
    expect(inspectEvidence).toHaveBeenCalledTimes(1);
    expect(d.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessSlug: 'papercusp',
        workspaceId: 'papercusp-workspace',
        runGroupId: `operational:${'a'.repeat(40)}`,
        commit: 'b'.repeat(40),
        worktreeDirty: false,
        rows: [expect.objectContaining({ framework: 'playwright', status: 'pass', durationMs: 240_000 })],
      }),
    );
  });

  it('persists an execution contract the shared ledger parser accepts (WI-10007016)', async () => {
    const d = deps({ inspectEvidence: vi.fn(async () => EVIDENCE) });
    await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );
    const params = vi.mocked(d.persist).mock.calls[0]![0];
    // Without BOTH root and row.execution the shared writer stores NULL execution_details.
    expect(typeof params.root).toBe('string');
    expect(params.root!.length).toBeGreaterThan(0);
    const row = params.rows[0]!;
    expect(row.execution).toMatchObject({
      passed: ARTIFACT.assertions.length, failed: 0, skipped: 0, collectionFailed: false,
    });
    const parsed = parseTestRunExecutionDetails({
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: params.root, filePath: row.filePath, runGroupId: params.runGroupId,
      workspaceId: params.workspaceId, harnessSlug: params.harnessSlug, testNamePattern: null,
      ...row.execution, mutationPhase: null, commitSha: params.commit, worktreeDirty: params.worktreeDirty,
    });
    expect(parsed).toBeDefined();
  });

  it('counts failing assertions and an unexplained nonzero exit as failed cases', () => {
    const ok = { id: 'ok', passed: true, evidence: 'held' };
    expect(operationalExecution({ ...ARTIFACT, exitCode: 1, assertions: [ok, { id: 'bad', passed: false, evidence: 'no' }] }))
      .toMatchObject({ passed: 1, failed: 1, failedCaseTitles: ['bad'] });
    expect(operationalExecution({ ...ARTIFACT, exitCode: 2, assertions: [ok] }))
      .toMatchObject({ passed: 1, failed: 1, failedCaseTitles: ['nonzero-exit-2'] });
    expect(operationalExecution({ ...ARTIFACT, exitCode: 0, assertions: [ok] })).not.toHaveProperty('failedCaseTitles');

    const capped = operationalExecution({
      ...ARTIFACT,
      assertions: Array.from({ length: MAX_RECORDED_PASSED_CASES + 1 }, (_, index) => ({
        id: 'passed check ' + index,
        passed: true,
        evidence: 'measured pass',
      })),
    });
    expect(capped).toMatchObject({
      passed: MAX_RECORDED_PASSED_CASES + 1, failed: 0, passedCaseTitlesTruncated: true,
    });
    expect(capped.passedCaseTitles).toHaveLength(MAX_RECORDED_PASSED_CASES);
  });

  it('is idempotent when the artifact hash already has a scoped row', async () => {
    const persist = vi.fn(async () => ({ written: 1, ids: [99] }));
    const d = deps({ findIds: vi.fn(async () => [41]), persist,
      readArchivedRun: vi.fn(async () => operationalReceipt({ execution_details: {
        schemaVersion: 1, root: '/immutable', filePath: EVIDENCE.filePath,
        runGroupId: `operational:${EVIDENCE.sha256.slice(0, 40)}`,
        workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', testNamePattern: null,
        mutationPhase: null, commitSha: EVIDENCE.commit, worktreeDirty: false,
        ...operationalExecution(ARTIFACT),
      } })) });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toMatchObject({ ok: true, alreadyRecorded: true, testRunIds: [41] });
    expect(persist).not.toHaveBeenCalled();
  });

  function operationalReceipt(overrides: Partial<ArchivedMutationRun> = {}): ArchivedMutationRun {
    return { id: 41, file_path: EVIDENCE.filePath, status: 'pass', source: 'local',
      framework: ARTIFACT.framework, workspace_id: 'papercusp-workspace', harness_slug: 'papercusp',
      commit_sha: EVIDENCE.commit, worktree_dirty: false, started_at: ARTIFACT.startedAt,
      finished_at: ARTIFACT.finishedAt, execution_details: null, ...overrides };
  }

  it('recovers a legacy NULL receipt from the same committed artifact without rewriting or rerunning it', async () => {
    const original = operationalReceipt();
    const d = deps({ findIds: vi.fn().mockResolvedValueOnce([41]).mockResolvedValueOnce([]),
      readArchivedRun: vi.fn(async () => original) });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', projectDir: process.cwd() }, d,
    );
    expect(result).toMatchObject({ ok: true, alreadyRecorded: false, recoveredFromTestRunId: 41,
      testRunIds: [77], status: 'pass' });
    expect(d.verifyOriginalEvidence).toHaveBeenCalledWith(original, EVIDENCE, expect.any(String));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({
      runGroupId: `operational-recovery:41:${EVIDENCE.sha256.slice(0, 40)}`,
      commit: EVIDENCE.commit, rows: [expect.objectContaining({
        outputTail: expect.stringContaining('RECOVERED OPERATIONAL: original_test_run_id=41'),
        execution: expect.objectContaining({ passed: 2, failed: 0, passedCaseTitles: ['desktop', 'portal'] }),
        startedAt: new Date(ARTIFACT.startedAt), finishedAt: new Date(ARTIFACT.finishedAt),
      })],
    }));
    expect(original.execution_details).toBeNull();
  });

  it('reuses the recovered receipt on repeat calls', async () => {
    const d = deps({ findIds: vi.fn().mockResolvedValueOnce([41]).mockResolvedValueOnce([77]),
      readArchivedRun: vi.fn().mockResolvedValueOnce(operationalReceipt()).mockResolvedValueOnce(
        operationalReceipt({ id: 77, execution_details: {
          schemaVersion: 1, root: '/immutable', filePath: EVIDENCE.filePath,
          runGroupId: `operational-recovery:41:${EVIDENCE.sha256.slice(0, 40)}`,
          workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', testNamePattern: null,
          mutationPhase: null, commitSha: EVIDENCE.commit, worktreeDirty: false,
          ...operationalExecution(ARTIFACT),
        } }),
      ) });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', projectDir: process.cwd() }, d,
    );
    expect(result).toMatchObject({ ok: true, alreadyRecorded: true, recoveredFromTestRunId: 41, testRunIds: [77] });
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('fails closed if the recovery row itself lacks execution details', async () => {
    const d = deps({ findIds: vi.fn().mockResolvedValueOnce([41]).mockResolvedValueOnce([77]),
      readArchivedRun: vi.fn(async () => operationalReceipt()) });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', projectDir: process.cwd() }, d,
    );
    expect(result).toMatchObject({ ok: false, error: 'evidence_operational_recovery_invalid' });
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('checks the actual historical committed bytes, including when HEAD has different evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'record-run-operational-recovery-'));
    try {
      git(root, ['init', '-q']);
      git(root, ['config', 'user.email', 'record-run-test@example.invalid']);
      git(root, ['config', 'user.name', 'record-run-test']);
      mkdirSync(join(root, 'docs/evidence'), { recursive: true });
      const bytes = JSON.stringify(ARTIFACT);
      writeFileSync(join(root, EVIDENCE.filePath), bytes);
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'original evidence']);
      const original = operationalReceipt({ commit_sha: git(root, ['rev-parse', 'HEAD']) });
      const evidence = { ...EVIDENCE, sha256: createHash('sha256').update(bytes).digest('hex') };
      writeFileSync(join(root, EVIDENCE.filePath), JSON.stringify({ ...ARTIFACT, exitCode: 1 }));
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'different evidence']);
      expect(await verifyOriginalOperationalEvidence(original, evidence, root)).toBe(true);
      expect(await verifyOriginalOperationalEvidence({ ...original, commit_sha: git(root, ['rev-parse', 'HEAD']) }, evidence, root)).toBe(false);
      expect(await verifyOriginalOperationalEvidence({ ...original, commit_sha: null }, evidence, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 'fail' }, { framework: 'node' }, { source: 'mutation-probe' },
    { workspace_id: 'other' }, { harness_slug: 'other' }, { file_path: 'other.json' },
    { started_at: '2026-09-08T02:02:00Z' }, { finished_at: null },
    { worktree_dirty: true }, { commit_sha: null }, { execution_details: {} },
  ])('refuses recovery when the original receipt contradicts the artifact: %j', async (overrides) => {
    const d = deps({ findIds: vi.fn(async () => [41]),
      readArchivedRun: vi.fn(async () => operationalReceipt(overrides)) });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', projectDir: process.cwd() }, d,
    );
    expect(result).toMatchObject({ ok: false });
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('refuses recovery when the original commit does not contain the verified artifact bytes', async () => {
    const d = deps({ findIds: vi.fn(async () => [41]),
      readArchivedRun: vi.fn(async () => operationalReceipt()), verifyOriginalEvidence: vi.fn(async () => false) });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', projectDir: process.cwd() }, d,
    );
    expect(result).toMatchObject({ ok: false });
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('derives a failure from either a non-zero exit or a failed assertion', async () => {
    const failedEvidence: CommittedOperationalEvidence = {
      ...EVIDENCE,
      artifact: { ...ARTIFACT, assertions: [{ id: 'portal', passed: false, evidence: 'missing card' }] },
    };
    const d = deps({ inspectEvidence: vi.fn(() => failedEvidence) });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toMatchObject({ ok: true, status: 'fail' });
    expect(d.persist).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [expect.objectContaining({ status: 'fail' })] }),
    );
  });

  it('rejects malformed or temporally inverted evidence artifacts', () => {
    expect(() => parseOperationalEvidenceArtifact(Buffer.from('{}'))).toThrow('evidence_schema_invalid');
    expect(() =>
      parseOperationalEvidenceArtifact(
        Buffer.from(JSON.stringify({ ...ARTIFACT, finishedAt: '2026-09-08T01:00:00.000Z' })),
      ),
    ).toThrow('evidence_time_order_invalid');
  });

  it('requires exact per-probe replay metadata for mutation-probe evidence', () => {
    const { mutationProbes: _mutationProbes, ...withoutReplay } = mutationEvidence();
    expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(withoutReplay))))
      .toThrow('evidence_mutation_probe_replay_required');
    expect(parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(mutationEvidence()))))
      .toMatchObject({ mutationProbes: [MUTATION_PROBE] });
  });

  // EI-25254538716868224: classify by the runner's signatures, never by the phrase "mutation probe".
  it('requires replay metadata whenever the artifact carries scripts/mutation-probe.sh signatures', () => {
    const { mutationProbes: _replay, ...base } = mutationEvidence();
    const quiet = { ...base, summary: 'Guard rejected the mutant.', assertions: [{ id: 'm', passed: true, evidence: 'guard failed' }] };
    const variants = [
      { ...quiet, command: ['bash', 'scripts/mutation-probe.sh', '--file', 'a.ts'] },
      { ...quiet, command: ['./mutation-probe.sh'] },
      { ...quiet, command: ['node', 'x.mjs'], assertions: [{ id: 'm', passed: true, evidence: 'MUTATION_PROBE_RESULT verdict=caught' }] },
      { ...quiet, command: ['node', 'x.mjs'], summary: 'MUTATION_PROBE_EVIDENCE_JSON={"verdict":"caught"}' },
      { ...quiet, command: ['node', 'x.mjs'], summary: 'Ran scripts/mutation-probe.sh in copy-out mode.' },
    ];
    for (const variant of variants) {
      expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(variant))))
        .toThrow('evidence_mutation_probe_replay_required');
    }
  });

  it('does not demand a mutation-probe.sh replay for evidence that merely names a branch or CI label', () => {
    const ciMutant = {
      ...ARTIFACT,
      framework: 'operational' as const,
      command: ['gh', 'workflow', 'run', 'ci.yml', '--ref', 'mutation-probe/p015-offline-message'],
      summary: 'macOS CI mutation probe: the Swift mutant on branch mutation-probe/p015-offline-message was caught.',
      assertions: [{ id: 'caught', passed: true, evidence: "job concluded failure with 'MUTATION_PROBE unit=failure ui=failure'" }],
    };
    const parsed = parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(ciMutant)));
    expect(parsed.mutationProbes).toBeUndefined();
    expect(parsed.command).toContain('mutation-probe/p015-offline-message');
  });

  it('rejects mutable shared scratch command references even when replay argv is present', () => {
    const artifact = mutationEvidence(['bash .papercusp/scratch/p009-probes.sh']);
    expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(artifact))))
      .toThrow('evidence_mutation_probe_scratch_command_invalid');
  });

  it('rejects replay metadata without the exact file, mutation, and guard inputs', () => {
    const artifact = mutationEvidence();
    artifact.mutationProbes[0].argv = ['--file', 'src/file.ts', '--test', 'vitest run'];
    expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(artifact))))
      .toThrow('evidence_mutation_probe_replay_incomplete');
  });

  it('verifies replay records against the pinned runner commit or the artifact commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'record-run-replay-'));
    const runnerPath = 'scripts/mutation-probe.sh';
    const evidencePath = 'docs/evidence/mutation-run.json';
    const runnerBytes = Buffer.from('#!/usr/bin/env bash\nprintf runner\\n\n');
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'docs/evidence'), { recursive: true });
      writeFileSync(join(root, runnerPath), runnerBytes);
      git(root, ['init', '-q']);
      git(root, ['config', 'user.email', 'record-run-test@example.invalid']);
      git(root, ['config', 'user.name', 'record-run-test']);
      git(root, ['add', runnerPath]);
      git(root, ['commit', '-qm', 'runner source']);
      const runnerCommit = git(root, ['rev-parse', 'HEAD']);
      const artifactRunnerBytes = Buffer.from('runner source v2');
      writeFileSync(join(root, runnerPath), artifactRunnerBytes);
      git(root, ['add', runnerPath]);
      git(root, ['commit', '-qm', 'updated runner source']);
      const runnerSha256 = createHash('sha256').update(artifactRunnerBytes).digest('hex');
      const artifact = {
        ...mutationEvidence(),
        mutationProbes: [{ ...MUTATION_PROBE, runnerCommit, runnerSha256 }],
      };

      const commitArtifact = async (value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value));
        writeFileSync(join(root, evidencePath), bytes);
        git(root, ['add', evidencePath]);
        git(root, ['commit', '-qm', 'mutation evidence']);
        return createHash('sha256').update(bytes).digest('hex');
      };

      const validSha = await commitArtifact(artifact);
      await expect(inspectCommittedOperationalEvidence(root, evidencePath, validSha)).resolves.toMatchObject({
        artifact: { mutationProbes: [{ runnerCommit, runnerSha256 }] },
      });

      const invalidSha = await commitArtifact({
        ...artifact,
        mutationProbes: [{ ...MUTATION_PROBE, runnerCommit, runnerSha256: 'e'.repeat(64) }],
      });
      await expect(inspectCommittedOperationalEvidence(root, evidencePath, invalidSha))
        .rejects.toThrow('evidence_mutation_probe_runner_sha256_mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the size, byte cap, and raw-artifact remedy for oversized evidence without persisting it', async () => {
    const actualBytes = MAX_OPERATIONAL_EVIDENCE_BYTES + 17;
    const expectedError =
      `evidence_too_large: ${actualBytes} bytes exceeds the ${MAX_OPERATIONAL_EVIDENCE_BYTES}-byte limit. ` +
      'Store bulky payloads as a raw artifact pinned by SHA-256 and keep the docs/evidence JSON small.';
    const d = deps({
      inspectEvidence: vi.fn(async () => {
        parseOperationalEvidenceArtifact(Buffer.alloc(actualBytes));
        return EVIDENCE;
      }),
    });
    const result = await recordOperationalRun(
      { evidenceFile: EVIDENCE.filePath, expectedSha256: EVIDENCE.sha256, harness: 'papercusp' },
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() },
      d,
    );

    expect(result).toEqual({ ok: false, error: expectedError });
    expect(d.findIds).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('names every failing field path in evidence_schema_invalid (WI-10003460)', () => {
    const { startedAt: _startedAt, finishedAt: _finishedAt, ...withoutTimestamps } = ARTIFACT;
    let message = '';
    try {
      parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(withoutTimestamps)));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^evidence_schema_invalid: /);
    expect(message).toContain('startedAt: ');
    expect(message).toContain('finishedAt: ');
    const nested = { ...ARTIFACT, assertions: [{ id: 'a', passed: 'yes', evidence: 'e' }] };
    expect(() => parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(nested))))
      .toThrow('assertions.0.passed: ');
  });
});
