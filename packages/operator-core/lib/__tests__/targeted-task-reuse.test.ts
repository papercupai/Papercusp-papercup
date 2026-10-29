import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  armTargetedTaskReuse,
  defaultRunnerIdentity,
  isUnitVitestTaskScript,
  LANE_SCRIPTS,
  nodeVersionRunnerIdentity,
  resolveWorkspacePackage,
  restoreCandidateCheckpointForReuse,
} from '../../../../scripts/lib/targeted-task-reuse.mjs';
import { decideReuseSkip, parseReuseSkipList } from '@papercusp/test-config/test-pass-reuse-skip';
import { gateReuseObservations, recordGateReuseDecision } from '../../../../scripts/lib/test-pass-reuse.mjs';
import { summarizeFallbackWindow } from '../degradation/fallback-observations';
import { judgeDegradation } from '../system-health/degradation-watchdog';

/**
 * EI-24538088938561684: the green checkpoint's frozen-repair verification re-runs a failing
 * workspace task (`<ws> :: test:lane-stateful`) directly at the repair head. That re-run must get
 * the suite's per-file pass reuse (with its audit sample) and record pass proofs; every uncertain
 * case must run every file, exactly as before.
 */

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW = Date.parse('2026-10-01T06:00:00Z');
const RUNNER = 'v25.9.0 linux x64';
const CTX = 'green-checkpoint';
const WS = '@fixture/lane-ws';
const SCRIPT = 'test:lane-stateful';

const proof = (sha: string, modules: string[]) => ({
  recordedSha: sha,
  recordedAtMs: NOW - 3600_000,
  executedModules: modules,
  readPaths: [] as string[],
  inputsCaptured: true,
  opaqueReasons: [] as string[],
  runContext: CTX,
  runnerIdentity: RUNNER,
});

let root: string;
let temps: string[];
let ended: number;

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture(scriptBody = 'vitest run --passWithNoTests') {
  writeJson(join(root, 'package.json'), { name: 'fixture-root', workspaces: ['packages/*'] });
  writeJson(join(root, 'packages/lane-ws/package.json'), {
    name: WS,
    scripts: {
      [SCRIPT]: scriptBody,
      'test:lane-pure': scriptBody,
      test: scriptBody,
      'lint:tsc': 'tsc --noEmit',
    },
  });
  laneSplitFixture();
}

function laneSplitFixture() {
  const file = join(root, 'libs/test-config/src/lane-split.ts');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `
export function isUnitTestFile(file) { return file.endsWith('.test.ts'); }
export function classifyLanes(_root, files) {
  return { stateful: files.filter((file) => !file.includes('pure')) };
}
`);
}

function independentGitRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'targeted-reuse-integration-'));
  temps.push(directory);
  const initialized = spawnSync('git', ['init', '-q'], { cwd: directory, encoding: 'utf8' });
  if (initialized.status !== 0) throw new Error(String(initialized.stderr));
  return directory;
}

/** The injection seams, typed from the module's own declaration (fakes are partial on purpose). */
type Deps = NonNullable<Parameters<typeof armTargetedTaskReuse>[0]['deps']>;

/** Seams for a clean checkout at HEAD with two proofs: a.test.ts reusable, b.test.ts input-changed. */
function deps(over: Record<string, unknown> = {}): Deps {
  return {
    recordReuse: async () => undefined,
    git: (_root: string, args: string[]) => (args[0] === 'rev-parse' ? `${HEAD}\n` : ''),
    runnerIdentity: () => RUNNER,
    connect: async () => ({ end: async () => void (ended += 1) }),
    loadProofFiles: async () => ({
      files: ['packages/lane-ws/a.test.ts', 'packages/lane-ws/b.test.ts'],
      rows: 2,
    }),
    loadProofs: async () => ({
      proofs: new Map([
        ['packages/lane-ws/a.test.ts', proof(HEAD, ['packages/lane-ws/a.test.ts', 'packages/lane-ws/src/a.ts'])],
        ['packages/lane-ws/b.test.ts', proof(OLD, ['packages/lane-ws/b.test.ts', 'packages/lane-ws/src/b.ts'])],
      ]),
      rows: 2,
    }),
    changedBetween: () => (a: string, b: string) =>
      a === OLD && b === HEAD ? new Set(['packages/lane-ws/src/b.ts']) : new Set<string>(),
    now: () => NOW,
    makeTempDir: () => {
      const d = mkdtempSync(join(tmpdir(), 'targeted-reuse-test-'));
      temps.push(d);
      return d;
    },
    ...over,
  } as unknown as Deps;
}

const baseEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  GREEN_CHECKPOINT: '1',
  PAPERCUSP_TEST_RUN_SOURCE: 'ci',
  AFFECTED_TEST_REUSE_AUDIT_RATE: '0',
  PATH: process.env.PATH,
  ...extra,
});

describe('gate reuse on the degradation rail (P-004)', () => {
  const TASK = `${WS}::${SCRIPT}`;

  it('records the real repair selector mismatch and composes it into a degraded task key', async () => {
    fixture();
    const observations: ReturnType<typeof gateReuseObservations> = [];
    const proofs = new Map(Array.from({ length: 25 }, (_, i) => {
      const file = `packages/lane-ws/${i}.test.ts`;
      return [file, { ...proof(HEAD, [file]), runnerIdentity: 'proof-v2 old-runner' }];
    }));
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD,
      env: baseEnv(), deps: deps({ loadProofs: async () => ({ proofs, rows: 25 }),
        recordReuse: async (task: string, decision: Parameters<typeof gateReuseObservations>[1]) => observations.push(...gateReuseObservations(task, decision)) }) });
    expect(armed.reused).toBe(0);
    expect(observations).toEqual([{ eligible: 25, applied: 0, populationKnown: true, reason: 'otherRunner', scope: TASK }]);
    const window = summarizeFallbackWindow('gate-pass-reuse', 60_000, observations.map((row) => ({ ...row, samples: 1 })));
    expect(judgeDegradation(window, { mechanism: 'gate-pass-reuse', scope: TASK })).toMatchObject({ kind: 'collapsed', reason: 'otherRunner' });
    armed.finish();
  });

  it.each(['dirty-checkout(2)', 'proofs-unavailable(timeout)', 'disabled-by-env', 'script-cannot-run-zero-files'])('does not invent a denominator for an unmeasured off-path decision (%s)', async (reason) => {
    const decisions = gateReuseObservations(TASK, { offReason: reason, eligible: 0 });
    expect(decisions).toEqual([{ eligible: 0, applied: 0, populationKnown: true, reason: reason.split('(')[0], scope: TASK }]);
  });

  it('records healthy primary decisions and excludes overlapping diagnostic counters', () => {
    const decisions = gateReuseObservations(TASK, { summary: { candidates: 25, reused: 25, inertGlobal: 25 } });
    expect(decisions).toEqual([{ eligible: 25, applied: 25, populationKnown: true, reason: 'applied', scope: TASK }]);
    const window = summarizeFallbackWindow('gate-pass-reuse', 60_000, decisions.map((row) => ({ ...row, samples: 1 })));
    expect(judgeDegradation(window, { mechanism: 'gate-pass-reuse', scope: TASK }).kind).toBe('recovered');
  });

  it('uses the same primitive for both round types, flushes before exit, and never throws on telemetry failure', async () => {
    const calls: Array<{ mechanism: string; eligible: number; applied: number }> = [];
    let flushed = 0;
    const writer = {
      observeFallback: (mechanism: string, decision: { eligible: number; applied: number }) => calls.push({ mechanism, ...decision }),
      flushFallbackObservations: async () => { flushed++; return { failed: 0 }; },
    };
    const gateContext = { runContext: 'green-checkpoint' as const, writer };
    expect(await recordGateReuseDecision(TASK, { summary: { candidates: 20, otherRunner: 20, reused: 0 } }, gateContext)).toBe(true);
    expect(await recordGateReuseDecision(TASK, { offReason: 'proofs-unavailable' }, gateContext)).toBe(true);
    expect(calls.map((row) => row.mechanism)).toEqual(['gate-pass-reuse', 'gate-pass-reuse']);
    expect(flushed).toBe(2);
    expect(await recordGateReuseDecision(TASK, { offReason: 'dirty-checkout' }, {
      runContext: 'green-checkpoint',
      writer: { ...writer, flushFallbackObservations: async () => { throw new Error('database offline'); } },
    })).toBe(false);
  });

  it('writes only green-checkpoint observations with a dedicated tenant, producer tag, and run correlation', async () => {
    const calls: Array<{ mechanism: string; eligible: number; applied: number; options: Record<string, unknown> }> = [];
    let flushed = 0;
    const writer = {
      observeFallback: (mechanism: string, decision: { eligible: number; applied: number }, options: Record<string, unknown>) =>
        calls.push({ mechanism, ...decision, options }),
      flushFallbackObservations: async () => { flushed++; return { failed: 0 }; },
    };
    expect(await recordGateReuseDecision(TASK, { offReason: 'dirty-checkout' }, { runContext: 'clean-local', writer })).toBe(true);
    expect(calls).toEqual([]);
    expect(flushed).toBe(0);

    const runGroupId = '64eab084-4e87-4e2b-99bd-3be2eb7c191f';
    expect(await recordGateReuseDecision(TASK, { offReason: 'dirty-checkout' }, {
      runContext: 'green-checkpoint', runGroupId, writer,
    })).toBe(true);
    expect(calls).toMatchObject([{
      mechanism: 'gate-pass-reuse', eligible: 0, applied: 0,
      options: { workspaceId: 'default', processTag: 'gate-reuse:green-checkpoint', correlationId: runGroupId },
    }]);
    expect(flushed).toBe(1);
  });

  it('does not let a throwing observation dependency change the repair skip decision', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(),
      deps: deps({ recordReuse: async () => { throw new Error('telemetry unavailable'); } }) });
    expect(armed.reused).toBe(1);
    armed.finish();
  });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'targeted-reuse-root-'));
  temps = [];
  ended = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('isUnitVitestTaskScript / LANE_SCRIPTS', () => {
  it('binds npm proof identity to the actual workspace PATH and refuses composite or hooked launchers', () => {
    fixture();
    const workspaceRoot = join(root, 'packages/lane-ws');
    const bin = join(workspaceRoot, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    writeFileSync(join(root, 'node_modules/.papercusp-dependency-generation'),
      `identity=v1-${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\n`);
    writeFileSync(join(bin, 'vitest'), '#!/usr/bin/env node\n', { mode: 0o755 });
    const actualExecutable = process.env.PAPERCUSP_RUNTIME_TEST_BUN || process.execPath;
    symlinkSync(actualExecutable, join(bin, 'node'));
    const task = { workspaceRoot, scriptText: 'vitest run' };
    const identity = defaultRunnerIdentity(root, process.env, 'proof-v3', task);
    expect(identity).toMatch(/^proof-v3 runtime-v1 [a-f0-9]{64}$/);
    expect(defaultRunnerIdentity(root, process.env, 'proof-v3', { ...task, scriptText: 'vitest run && bun other.ts' })).toBeNull();
    expect(defaultRunnerIdentity(root, process.env, 'proof-v3', { ...task, preScript: 'bun setup.ts' })).toBeNull();
    writeFileSync(join(bin, 'vitest'), '#!/usr/bin/env bun\n');
    expect(defaultRunnerIdentity(root, process.env, 'proof-v3', task)).toBeNull();
  });

  it('names the unit tasks affected-tests arms reuse on, and nothing else', () => {
    expect([...LANE_SCRIPTS]).toEqual(['test:lane-pure', 'test:lane-stateful']);
    expect(isUnitVitestTaskScript('test')).toBe(true);
    expect(isUnitVitestTaskScript('test:lane-stateful')).toBe(true);
    expect(isUnitVitestTaskScript('test:integration')).toBe(false);
    expect(isUnitVitestTaskScript('lint:tsc')).toBe(false);
  });
});

describe('resolveWorkspacePackage', () => {
  it('finds a root workspace by package name through the workspaces globs', () => {
    fixture();
    expect(resolveWorkspacePackage(root, WS)).toMatchObject({
      dirRel: 'packages/lane-ws',
      scripts: { [SCRIPT]: 'vitest run --passWithNoTests' },
    });
    expect(resolveWorkspacePackage(root, '@fixture/absent')).toBeNull();
  });
});

describe('restoreCandidateCheckpointForReuse', () => {
  it('restores dirty output for the ordinary candidate suite only with a matching candidate and isolated roots', () => {
    fixture();
    const integrationRoot = independentGitRoot();
    const releaseRoot = independentGitRoot();
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(String(result.stderr));
      return String(result.stdout ?? '');
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'tracked.txt'), 'committed contents\n');
    git(['add', '.']);
    git(['commit', '-qm', 'candidate checkpoint']);
    const judgedSha = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'tracked.txt'), 'test output mutation\n');
    writeFileSync(join(root, 'untracked-output.txt'), 'test output\n');
    const env = {
      GREEN_CHECKPOINT: '1',
      PAPERCUSP_TEST_RUN_COMMIT: judgedSha,
      PC_TEST_REUSE_DISPOSABLE_CHECKPOINT_ROOT: root,
      PC_TEST_REUSE_INTEGRATION_ROOT: integrationRoot,
      PC_TEST_REUSE_RELEASE_ROOT: releaseRoot,
    };

    const restored = restoreCandidateCheckpointForReuse({ root, judgedSha, env });

    expect(restored).toEqual({ ok: true, restored: true });
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('committed contents\n');
    expect(existsSync(join(root, 'untracked-output.txt'))).toBe(false);
    expect(git(['status', '--porcelain', '--ignore-submodules=none'])).toBe('');
  });

  it('leaves a dirty candidate untouched when the gate candidate identity mismatches', () => {
    fixture();
    writeFileSync(join(root, 'tracked.txt'), 'preserve this unverified output\n');

    const restored = restoreCandidateCheckpointForReuse({
      root,
      judgedSha: HEAD,
      env: {
        GREEN_CHECKPOINT: '1',
        PAPERCUSP_TEST_RUN_COMMIT: 'b'.repeat(40),
        PC_TEST_REUSE_DISPOSABLE_CHECKPOINT_ROOT: root,
        PC_TEST_REUSE_INTEGRATION_ROOT: root,
        PC_TEST_REUSE_RELEASE_ROOT: root,
      },
    });

    expect(restored).toEqual({ ok: false, reason: 'candidate-checkpoint-identity-unverified' });
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('preserve this unverified output\n');
  });

  /**
   * WI-6554700010030332: a pot with no release checkout (calendar has calendar + calendar-checkpoint
   * but no calendar-release) still passes the conventional `<slug>-release` path. Every restore on
   * such pots was refused checkpoint-root-unverified (107 refusals, 0 restores in the checkpoint
   * logs), which left pure-lane proof capture skipping dirty-checkout and test reuse blocked.
   */
  function dirtyCommittedCheckpoint() {
    fixture();
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(String(result.stderr));
      return String(result.stdout ?? '');
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'tracked.txt'), 'committed contents\n');
    git(['add', '.']);
    git(['commit', '-qm', 'candidate checkpoint']);
    const judgedSha = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'tracked.txt'), 'test output mutation\n');
    writeFileSync(join(root, 'untracked-output.txt'), 'test output\n');
    const envFor = (releaseRoot: string) => ({
      GREEN_CHECKPOINT: '1',
      PAPERCUSP_TEST_RUN_COMMIT: judgedSha,
      PC_TEST_REUSE_DISPOSABLE_CHECKPOINT_ROOT: root,
      PC_TEST_REUSE_INTEGRATION_ROOT: independentGitRoot(),
      PC_TEST_REUSE_RELEASE_ROOT: releaseRoot,
    });
    return { git, judgedSha, envFor };
  }

  it('restores when the configured release checkout does not exist at all', () => {
    const { git, judgedSha, envFor } = dirtyCommittedCheckpoint();
    const parent = mkdtempSync(join(tmpdir(), 'targeted-reuse-no-release-'));
    temps.push(parent);
    const absentRelease = join(parent, 'pot-release');
    expect(existsSync(absentRelease)).toBe(false);

    const restored = restoreCandidateCheckpointForReuse({ root, judgedSha, env: envFor(absentRelease) });

    expect(restored).toEqual({ ok: true, restored: true });
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('committed contents\n');
    expect(existsSync(join(root, 'untracked-output.txt'))).toBe(false);
    expect(git(['status', '--porcelain', '--ignore-submodules=none'])).toBe('');
  });

  it.each([
    ['exists but is not its own Git worktree root', () => {
      const directory = mkdtempSync(join(tmpdir(), 'targeted-reuse-plain-release-'));
      temps.push(directory);
      return directory;
    }],
    ['is a dangling symlink', () => {
      const parent = mkdtempSync(join(tmpdir(), 'targeted-reuse-dangling-release-'));
      temps.push(parent);
      const link = join(parent, 'pot-release');
      symlinkSync(join(parent, 'never-created'), link);
      return link;
    }],
    ['is relative, so absence cannot be proven', () => 'pot-release-that-does-not-exist'],
    ['is a missing path inside the checkpoint itself', () => join(root, 'nested-release')],
    ['is a missing path inside the checkpoint reached through a symlinked parent', () => {
      const parent = mkdtempSync(join(tmpdir(), 'targeted-reuse-alias-release-'));
      temps.push(parent);
      symlinkSync(root, join(parent, 'checkpoint-alias'));
      return join(parent, 'checkpoint-alias', 'nested-release');
    }],
  ])('still refuses and preserves the dirty checkout when the release root %s', (_label, releaseFor) => {
    const { judgedSha, envFor } = dirtyCommittedCheckpoint();
    const releaseRoot = releaseFor();

    const restored = restoreCandidateCheckpointForReuse({ root, judgedSha, env: envFor(releaseRoot) });

    expect(restored).toEqual({ ok: false, reason: 'checkpoint-root-unverified' });
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('test output mutation\n');
    expect(existsSync(join(root, 'untracked-output.txt'))).toBe(true);
  });
});

describe('armTargetedTaskReuse', () => {
  it.each([
    ['test:lane-pure', 'pure', 1],
    ['test:lane-stateful', 'stateful', 2],
  ] as const)('limits %s reuse observations to the selected lane', async (script, lane, expected) => {
    fixture();
    const files = [
      'packages/lane-ws/pure.test.ts',
      'packages/lane-ws/stateful-a.test.ts',
      'packages/lane-ws/stateful-b.test.ts',
    ];
    const proofs = new Map(files.map((file) => [file, proof(HEAD, [file])]));
    const loadedScopes: string[][] = [];
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script,
      expectedSha: HEAD,
      env: baseEnv(),
      deps: deps({
        loadProofFiles: async () => ({ files, rows: files.length }),
        loadProofs: async ({ files: requestedFiles }: { files?: string[] }) => {
          loadedScopes.push(requestedFiles ?? []);
          const selected = new Map([...proofs].filter(([file]) => requestedFiles?.includes(file)));
          return { proofs: selected, rows: selected.size };
        },
      }),
    });

    expect(armed.reused).toBe(expected);
    expect(armed.lines.join('\n')).toContain(`candidates=${expected}`);
    expect(armed.lines.join('\n')).toContain(`lane=${lane} otherLane=${files.length - expected}`);
    expect(loadedScopes).toEqual([lane === 'pure'
      ? ['packages/lane-ws/pure.test.ts']
      : ['packages/lane-ws/stateful-a.test.ts', 'packages/lane-ws/stateful-b.test.ts']]);
    armed.finish();
  });

  it('skips the file whose proof is valid at the repair head, runs the input-changed one, and arms recording', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: SCRIPT,
      expectedSha: HEAD,
      env: baseEnv(),
      scope: 'targeted-gate',
      deps: deps(),
    });

    expect(armed.reused).toBe(1);
    expect(armed.recording).toBe(true);
    expect(armed.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE).toBe(WS);
    expect(armed.env.PC_EXECUTED_SOURCE_MAP_NO_PERSIST).toBeUndefined();
    expect(armed.lines).toHaveLength(2);
    expect(armed.lines[0]).toMatch(
      /^TARGETED_TEST_PASS_REUSE ws=@fixture\/lane-ws::test:lane-stateful candidates=2 reused=1 .*inputChanged=1 .* scope=targeted-gate rows=2 sha=aaaaaaaaaaaa auditRate=0 lane=stateful otherLane=0 runtime=/,
    );
    // WI-6554700010030941: the exclusion's cause path is named, not only counted.
    const causesPrefix = 'TARGETED_TEST_PASS_REUSE_EXCLUSION_CAUSES ';
    expect(armed.lines[1]!.startsWith(causesPrefix)).toBe(true);
    const causes = JSON.parse(armed.lines[1]!.slice(causesPrefix.length));
    expect(causes).toMatchObject({ version: 1, ws: '@fixture/lane-ws::test:lane-stateful', total: 1, byReason: { inputChanged: 1 }, distinctPaths: 1 });
    expect(causes.topPaths).toHaveLength(1);
    expect(causes.topPaths[0]).toMatchObject({ reason: 'inputChanged', files: 1 });
    expect(typeof causes.topPaths[0].path).toBe('string');
    expect(causes.topPaths[0].path.length).toBeGreaterThan(0);
    const runtime = JSON.parse(decodeURIComponent(armed.lines[0]!.split(' runtime=')[1]!));
    expect(runtime).toEqual({ version: 1, judgedSha: HEAD, runnerIdentity: RUNNER,
      runContext: CTX, runGroupId: null, dirty: false });
    expect(ended).toBe(1);

    // The skip list is what the workspace's vitest config reads: workspace-relative, and accepted
    // by the reader under the same run context and runner identity.
    const listPath = armed.env.PC_TEST_REUSE_SKIP_LIST!;
    const list = parseReuseSkipList(readFileSync(listPath, 'utf8'));
    expect(list.files).toEqual(['a.test.ts']);
    expect(list.judgedSha).toBe(HEAD);
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: RUNNER })).toMatchObject({ applied: true });

    expect(armed.finish()).toEqual([
      expect.stringMatching(/^TARGETED_EXECUTED_SOURCE_MAP_RESULT task=@fixture\/lane-ws::test:lane-stateful outcome=no-report/),
    ]);
    expect(existsSync(listPath)).toBe(false);
  });

  // WI-6554700010008589: gate run 762a13a6 judged a frozen repair head whose recorder writes proof-v2
  // while this selector's constant is newer, and reused nothing (every proof `otherRunner`). The arm
  // must take the JUDGED tree's format for the identity, the skip list and the legacy drift rule.
  it('matches the judged tree recorder format and applies the legacy drift rule to its proofs', async () => {
    const LEGACY_RUNNER = `proof-v2 ${RUNNER}`;
    const legacyProofs = async () => ({
      proofs: new Map([
        ['packages/lane-ws/a.test.ts', { ...proof(OLD, ['packages/lane-ws/a.test.ts', 'packages/lane-ws/src/a.ts']), runnerIdentity: LEGACY_RUNNER }],
        ['packages/lane-ws/b.test.ts', { ...proof(OLD, ['packages/lane-ws/b.test.ts', 'packages/lane-ws/src/b.ts']), runnerIdentity: LEGACY_RUNNER }],
      ]),
      rows: 2,
    });
    const legacyDeps = (drift: string[]) =>
      deps({
        proofFormat: () => 'proof-v2',
        runnerIdentity: (_root: string, _env: unknown, format: string) => `${format} ${RUNNER}`,
        loadProofs: legacyProofs,
        changedBetween: () => (a: string, b: string) => (a === OLD && b === HEAD ? new Set(drift) : new Set<string>()),
      });

    fixture();
    const armed = await armTargetedTaskReuse({
      root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), scope: 'targeted-gate',
      deps: legacyDeps(['packages/lane-ws/c.test.ts']),
    });
    expect(armed.reused).toBe(2);
    expect(armed.lines[0]).toMatch(/ otherRunner=0 /);
    expect(armed.lines[0]).toMatch(/ proofFormat=proof-v2\(legacy\) auditRate=0 lane=stateful otherLane=0 runtime=/);
    const list = parseReuseSkipList(readFileSync(armed.env.PC_TEST_REUSE_SKIP_LIST!, 'utf8'));
    expect(list.runnerIdentity).toBe(LEGACY_RUNNER);
    // The judged tree's own consumer computes ITS identity, so it accepts the list.
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: LEGACY_RUNNER })).toMatchObject({ applied: true });
    armed.finish();

    // A non-test drift path may be a module a legacy proof loaded without recording it: run both.
    fixture();
    const strict = await armTargetedTaskReuse({
      root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), scope: 'targeted-gate',
      deps: legacyDeps(['packages/lane-ws/c.test.ts', 'packages/lane-ws/src/unrecorded.ts']),
    });
    expect(strict.reused).toBe(0);
    expect(strict.lines[0]).toMatch(/ legacyFormatDrift=2 /);
    strict.finish();
  });

  // gate-test-reuse-yield-2026-10-01 P-006 (D-005): the pure-lane runner's script never names
  // --passWithNoTests, yet it runs zero files as a pass, so the repair-head rerun may reuse too.
  it('arms reuse for the pure-lane runner script, which runs an all-reused lane as a pass', async () => {
    fixture('PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- node ../../scripts/run-vitest-pure-lane.mjs');
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: 'test:lane-pure',
      expectedSha: HEAD,
      env: baseEnv(),
      deps: deps({
        loadProofFiles: async () => ({
          files: ['packages/lane-ws/pure-a.test.ts', 'packages/lane-ws/pure-b.test.ts'],
          rows: 2,
        }),
        loadProofs: async () => ({
          proofs: new Map([
            ['packages/lane-ws/pure-a.test.ts', proof(HEAD, ['packages/lane-ws/pure-a.test.ts'])],
            ['packages/lane-ws/pure-b.test.ts', proof(OLD, ['packages/lane-ws/pure-b.test.ts', 'packages/lane-ws/src/b.ts'])],
          ]),
          rows: 2,
        }),
      }),
    });
    expect(armed.reused).toBe(1);
    expect(armed.lines.join('\n')).not.toMatch(/script-cannot-run-zero-files/);
  });

  it('keeps the soundness audit: an audit draw runs a reusable file instead of skipping it', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: SCRIPT,
      expectedSha: HEAD,
      env: baseEnv({ AFFECTED_TEST_REUSE_AUDIT_RATE: '1' }),
      deps: deps(),
    });
    expect(armed.reused).toBe(0);
    expect(armed.env.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
    expect(armed.lines[0]).toMatch(/ reused=0 .*audited=1 /);
    armed.finish();
  });

  it('reuses plain Vitest passes while changed and unproven files still run', async () => {
    fixture('vitest run');
    for (const file of ['a.test.ts', 'b.test.ts', 'c.test.ts']) writeFileSync(join(root, 'packages/lane-ws', file), '');
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), deps: deps() });
    expect(armed.reused).toBe(1);
    expect(armed.args).toEqual([]);
    const list = JSON.parse(readFileSync(armed.env.PC_TEST_REUSE_SKIP_LIST!, 'utf8'));
    expect(list.files).toEqual(['a.test.ts']);
    expect(armed.lines.join('\n')).toMatch(/inputChanged=1/);
    armed.finish();
  });

  it('supplies the zero-file flag only when the complete disk population is reused', async () => {
    fixture('vitest run');
    writeFileSync(join(root, 'packages/lane-ws/a.test.ts'), '');
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), deps: deps({
      loadProofs: async () => ({ proofs: new Map([['packages/lane-ws/a.test.ts', proof(HEAD, ['packages/lane-ws/a.test.ts'])]]), rows: 1 }),
    }) });
    expect(armed.reused).toBe(1);
    expect(armed.args).toEqual(['--passWithNoTests']);
    armed.finish();
  });

  it('the real Vitest consumer preserves passes across lint-only repair, then executes changed and unproven files', async () => {
    fixture('vitest run');
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const wsRoot = join(root, 'packages/lane-ws');
    // Own the fixture's generation marker: writing through a shared node_modules
    // symlink would falsely publish a generation for the real mutable checkout.
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(join(repoRoot, 'node_modules/vitest'), join(root, 'node_modules/vitest'), 'dir');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    writeFileSync(join(root, 'node_modules/.papercusp-dependency-generation'),
      `identity=v1-${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\n`);
    mkdirSync(join(wsRoot, 'src'));
    const skipConsumer = join(repoRoot, 'libs/test-config/src/test-pass-reuse-skip.ts');
    writeFileSync(join(wsRoot, 'vitest.config.mts'),
      `import { resolveReuseSkipExclude } from ${JSON.stringify(skipConsumer)};\n` +
      `export default { test: { include: ['*.test.ts'], exclude: resolveReuseSkipExclude(), maxWorkers: 1 } };\n`);
    for (const name of ['a', 'b']) {
      writeFileSync(join(wsRoot, `src/${name}.ts`), 'export const value = true;\n');
      writeFileSync(join(wsRoot, `${name}.test.ts`),
        `import { it, expect } from 'vitest'; import { value } from './src/${name}';\n` +
        `it('${name}', () => expect(value).toBe(true));\n`);
    }
    const run = (env: Record<string, string | undefined>, args: string[] = []) => {
      const result = spawnSync(join(repoRoot, 'node_modules/.bin/vitest'), ['run', '--reporter=json', ...args], {
        cwd: wsRoot, env, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.stdout.trim(), `Vitest status=${result.status} signal=${result.signal}\n${result.stderr}`).not.toBe('');
      return { status: result.status, report: JSON.parse(result.stdout) };
    };
    const runGroupId = '64eab084-4e87-4e2b-99bd-3be2eb7c191f';
    const env = { ...process.env, ...baseEnv(), PAPERCUSP_TEST_RUN_GROUP: runGroupId,
      PC_TEST_LANE: undefined, PC_TEST_REUSE_SKIP_LIST: undefined,
      PC_EXECUTED_SOURCE_MAP_WORKSPACE: undefined, PC_EXECUTED_SOURCE_MAP_RESULT: undefined,
      PC_EXECUTED_SOURCE_MAP_OUT: undefined, PC_TEST_FILTER_LIST: undefined,
      // The fixture checkout intentionally has no Git metadata; don't propagate the outer
      // committed-source loader into this nested Vitest process, where its config audit requires
      // a real HEAD tree and is unrelated to the reuse consumer being exercised here.
      NODE_OPTIONS: undefined };
    const first = run(env);
    expect(first.status).toBe(0);
    expect(first.report.testResults.map((r: { name: string }) => r.name.split('/').at(-1)).sort()).toEqual(['a.test.ts', 'b.test.ts']);
    const identity = defaultRunnerIdentity(root, env);
    expect(identity).toMatch(/^proof-v3 runtime-v1 [a-f0-9]{64}$/);
    const loadProofs = async () => ({ rows: 2, proofs: new Map(
      ['a', 'b'].map(name => [`packages/lane-ws/${name}.test.ts`, {
        ...proof(OLD, [`packages/lane-ws/${name}.test.ts`, `packages/lane-ws/src/${name}.ts`]), runnerIdentity: identity,
      }]),
    ) });
    // A lint implementation outside both recorded input closures must preserve BOTH passes.
    // Exercise the actual consumer, rather than treating a selector count as an executed skip.
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/check-lint-fixture.mjs'), 'export const lintFixed = true;\n');
    const lintRepair = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env,
      deps: deps({ runnerIdentity: () => identity, loadProofs,
        changedBetween: () => () => new Set(['scripts/check-lint-fixture.mjs']) }) });
    try {
      const list = parseReuseSkipList(readFileSync(lintRepair.env.PC_TEST_REUSE_SKIP_LIST!, 'utf8'));
      expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: identity })).toMatchObject({ applied: true, skipped: 2 });
      const runtime = JSON.parse(decodeURIComponent(lintRepair.lines[0]!.split(' runtime=')[1]!));
      expect(runtime).toEqual({ version: 1, judgedSha: HEAD, runnerIdentity: identity,
        runContext: CTX, runGroupId, dirty: false });
      expect(lintRepair.lines[0]).toMatch(/candidates=2 reused=2 .*inputChanged=0 /);
      const preserved = run(lintRepair.env, lintRepair.args);
      expect(preserved.status).toBe(0);
      expect(preserved.report.testResults).toEqual([]);
      expect(preserved.report.numTotalTests).toBe(0);
    } finally { lintRepair.finish(); }
    writeFileSync(join(wsRoot, 'src/b.ts'), 'export const value = false;\n');
    writeFileSync(join(wsRoot, 'c.test.ts'), "import { it, expect } from 'vitest'; it('c', () => expect(true).toBe(true));\n");
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env,
      deps: deps({ runnerIdentity: () => identity, loadProofs }) });
    try {
      expect(armed.reused).toBe(1);
      const second = run(armed.env, armed.args);
      expect(second.status).toBe(1);
      expect(second.report.testResults.map((r: { name: string }) => r.name.split('/').at(-1)).sort()).toEqual(['b.test.ts', 'c.test.ts']);
      expect(second.report.numFailedTests).toBe(1);
      expect(second.report.numPassedTests).toBe(1);
    } finally { armed.finish(); }
    // Three sequential spawnSync children at 30s each: the parent must outlive ALL child
    // budgets, or the child timeout is unreachable (lint:test-timing-budgets).
  }, 120_000);

  it('reports what the recorder did after the task ran', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({ root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), deps: deps() });
    const resultFile = armed.env.PC_EXECUTED_SOURCE_MAP_RESULT!;
    writeFileSync(
      resultFile,
      `${JSON.stringify({ workspaceName: WS, outcome: 'written', rows: 3, retired: 0, skipped: 1, sha: HEAD, dirty: false, error: null })}\n`,
    );
    expect(armed.finish()).toEqual([
      `TARGETED_EXECUTED_SOURCE_MAP_RESULT task=${WS}::${SCRIPT} outcome=written rows=3 retired=0 skipped=1 dirty=false sha=aaaaaaaaaaaa`,
    ]);
    expect(existsSync(resultFile)).toBe(false);
  });

  it('strips skip-list, no-persist and result channels inherited from an outer environment', async () => {
    fixture();
    const inherited = baseEnv({
      PC_TEST_REUSE_SKIP_LIST: '/tmp/foreign-skip.json',
      PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
      PC_EXECUTED_SOURCE_MAP_RESULT: '/tmp/foreign-result.jsonl',
      PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/foreign-out.json',
    });
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: 'lint:tsc',
      expectedSha: HEAD,
      env: inherited,
      deps: deps(),
    });
    expect(armed.lines).toEqual([]);
    expect(armed.recording).toBe(false);
    for (const key of [
      'PC_TEST_REUSE_SKIP_LIST',
      'PC_EXECUTED_SOURCE_MAP_NO_PERSIST',
      'PC_EXECUTED_SOURCE_MAP_RESULT',
      'PC_EXECUTED_SOURCE_MAP_OUT',
      'PC_EXECUTED_SOURCE_MAP_WORKSPACE',
    ]) {
      expect(armed.env[key]).toBeUndefined();
    }
    // The caller's env object is not mutated.
    expect(inherited.PC_TEST_REUSE_SKIP_LIST).toBe('/tmp/foreign-skip.json');
  });

  it('does not arm recording when the runner switch is off', async () => {
    fixture();
    const armed = await armTargetedTaskReuse({
      root,
      workspace: WS,
      script: SCRIPT,
      expectedSha: HEAD,
      env: baseEnv({ AFFECTED_RECORD_EXECUTED_SOURCES: '0' }),
      deps: deps(),
    });
    expect(armed.recording).toBe(false);
    expect(armed.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE).toBeUndefined();
    armed.finish();
  });

  describe('fails open: no skip list, every file runs, recording stays armed', () => {
    const cases: Array<[string, () => void, Record<string, unknown>, Record<string, string>, RegExp]> = [
      ['the checkout is not the expected sha', fixture, {}, {}, /reason=head-mismatch\(aaaaaaaaaaaa!=cccccccccccc\)/],
      ['the checkout is dirty', fixture, { git: (_r: string, a: string[]) => (a[0] === 'rev-parse' ? HEAD : ' M x.ts\n') }, {}, /reason=dirty-checkout\(1\)/],
      ['git status cannot be read', fixture, { git: (_r: string, a: string[]) => (a[0] === 'rev-parse' ? HEAD : null) }, {}, /reason=checkout-status-unknown/],
      ['the script cannot receive Vitest args', () => fixture('node --test'), {}, {}, /reason=script-cannot-run-zero-files/],
      ['reuse is disabled by env', fixture, {}, { AFFECTED_TEST_REUSE: '0' }, /reason=disabled-by-env/],
      ['the database is unreachable', fixture, { connect: async () => { throw new Error('ECONNREFUSED 5432'); } }, {}, /reason=pg-unavailable\(ECONNREFUSED_5432\)/],
      ['the proof read fails', fixture, { loadProofs: async () => { throw new Error('relation missing'); } }, {}, /reason=proofs-unavailable\(relation_missing\)/],
      ['the runner identity is unknown', fixture, { runnerIdentity: () => null }, {}, /reason=no-runner-identity/],
    ];
    it.each(cases)('when %s', async (_name, setup, over, extraEnv, reason) => {
      setup();
      const expectedSha = String(reason).includes('head-mismatch') ? 'c'.repeat(40) : HEAD;
      const armed = await armTargetedTaskReuse({
        root,
        workspace: WS,
        script: SCRIPT,
        expectedSha,
        env: baseEnv(extraEnv),
        deps: deps(over),
      });
      expect(armed.reused).toBe(0);
      expect(armed.env.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
      expect(armed.env.PC_EXECUTED_SOURCE_MAP_WORKSPACE).toBe(WS);
      expect(armed.lines).toHaveLength(1);
      expect(armed.lines[0]).toMatch(/^TARGETED_TEST_PASS_REUSE ws=@fixture\/lane-ws::test:lane-stateful scope=targeted applied=false /);
      expect(armed.lines[0]).toMatch(reason);
      armed.finish();
    });

    it('restores dirty files in an opted-in disposable checkpoint before deciding reuse', async () => {
      fixture();
      const integrationRoot = independentGitRoot();
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(String(result.stderr));
        return String(result.stdout ?? '');
      };
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Test']);
      writeFileSync(join(root, 'tracked.txt'), 'committed contents\n');
      git(['add', '.']);
      git(['commit', '-qm', 'checkpoint source']);
      const expectedSha = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(join(root, 'tracked.txt'), 'test changed this\n');
      writeFileSync(join(root, 'untracked-output.txt'), 'test output\n');

      const armed = await armTargetedTaskReuse({
        root,
        workspace: WS,
        script: SCRIPT,
        expectedSha,
        env: baseEnv(),
        restoreDirtyCheckpoint: true,
        checkpointRoot: root,
        integrationRoot,
        releaseRoot: integrationRoot,
        deps: deps({
          git: (cwd: string, args: string[]) => {
            const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
            return result.status === 0 ? String(result.stdout ?? '') : null;
          },
          loadProofs: async () => ({
            proofs: new Map([
              ['packages/lane-ws/a.test.ts', proof(expectedSha, ['packages/lane-ws/a.test.ts'])],
            ]),
            rows: 1,
          }),
          changedBetween: () => () => new Set<string>(),
        }),
      });

      expect(armed.lines).toContain(`TARGETED_CHECKPOINT_RESTORED sha=${expectedSha.slice(0, 12)}`);
      expect(armed.reused).toBe(1);
      expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('committed contents\n');
      expect(existsSync(join(root, 'untracked-output.txt'))).toBe(false);
      expect(git(['status', '--porcelain', '--ignore-submodules=none'])).toBe('');
      armed.finish();
    });

    it('restores dirty initialized submodules in the opted-in disposable checkpoint', async () => {
      fixture();
      const subRoot = mkdtempSync(join(tmpdir(), 'targeted-reuse-submodule-'));
      temps.push(subRoot);
      const git = (cwd: string, args: string[]) => {
        const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(String(result.stderr));
        return String(result.stdout ?? '');
      };
      git(subRoot, ['init', '-q']);
      git(subRoot, ['config', 'user.email', 'test@example.invalid']);
      git(subRoot, ['config', 'user.name', 'Test']);
      writeFileSync(join(subRoot, 'source.txt'), 'submodule source\n');
      git(subRoot, ['add', '.']);
      git(subRoot, ['commit', '-qm', 'submodule source']);
      const firstSubmoduleSha = git(subRoot, ['rev-parse', 'HEAD']).trim();
      writeFileSync(join(subRoot, 'source.txt'), 'pinned submodule source\n');
      git(subRoot, ['add', '.']);
      git(subRoot, ['commit', '-qm', 'pinned submodule source']);
      const pinnedSubmoduleSha = git(subRoot, ['rev-parse', 'HEAD']).trim();

      git(root, ['init', '-q']);
      git(root, ['config', 'user.email', 'test@example.invalid']);
      git(root, ['config', 'user.name', 'Test']);
      git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRoot, 'modules/child']);
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'checkpoint with submodule']);
      const expectedSha = git(root, ['rev-parse', 'HEAD']).trim();
      git(join(root, 'modules/child'), ['checkout', '-q', '--detach', firstSubmoduleSha]);
      writeFileSync(join(root, 'modules/child/source.txt'), 'submodule test mutation\n');
      writeFileSync(join(root, 'modules/child/untracked-output.txt'), 'submodule test output\n');

      const armed = await armTargetedTaskReuse({
        root,
        workspace: WS,
        script: SCRIPT,
        expectedSha,
        env: baseEnv(),
        restoreDirtyCheckpoint: true,
        checkpointRoot: root,
        integrationRoot: subRoot,
        releaseRoot: subRoot,
        deps: deps({
          git: (cwd: string, args: string[]) => {
            const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
            return result.status === 0 ? String(result.stdout ?? '') : null;
          },
          loadProofs: async () => ({
            proofs: new Map([
              ['packages/lane-ws/a.test.ts', proof(expectedSha, ['packages/lane-ws/a.test.ts'])],
            ]),
            rows: 1,
          }),
          changedBetween: () => () => new Set<string>(),
        }),
      });

      expect(armed.lines).toContain(`TARGETED_CHECKPOINT_RESTORED sha=${expectedSha.slice(0, 12)}`);
      expect(armed.reused).toBe(1);
      expect(readFileSync(join(root, 'modules/child/source.txt'), 'utf8')).toBe('pinned submodule source\n');
      expect(git(join(root, 'modules/child'), ['rev-parse', 'HEAD']).trim()).toBe(pinnedSubmoduleSha);
      expect(existsSync(join(root, 'modules/child/untracked-output.txt'))).toBe(false);
      expect(git(root, ['status', '--porcelain', '--ignore-submodules=none'])).toBe('');
      armed.finish();
    });

    it('does not restore a dirty checkout when its HEAD differs from the expected SHA', async () => {
      fixture();
      const integrationRoot = independentGitRoot();
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(String(result.stderr));
        return String(result.stdout ?? '');
      };
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Test']);
      writeFileSync(join(root, 'tracked.txt'), 'committed contents\n');
      git(['add', '.']);
      git(['commit', '-qm', 'checkpoint source']);
      const actualSha = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(join(root, 'tracked.txt'), 'preserve this mismatch\n');

      const armed = await armTargetedTaskReuse({
        root,
        workspace: WS,
        script: SCRIPT,
        expectedSha: 'c'.repeat(40),
        env: baseEnv(),
        restoreDirtyCheckpoint: true,
        checkpointRoot: root,
        integrationRoot,
        releaseRoot: integrationRoot,
        deps: deps({
          git: (cwd: string, args: string[]) => {
            const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
            return result.status === 0 ? String(result.stdout ?? '') : null;
          },
        }),
      });

      expect(actualSha).not.toBe('c'.repeat(40));
      expect(armed.lines[0]).toContain('reason=head-mismatch');
      expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('preserve this mismatch\n');
      expect(git(['status', '--porcelain'])).not.toBe('');
      armed.finish();
    });

    it('does not restore when the configured checkpoint root is the integration checkout', async () => {
      fixture();
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(String(result.stderr));
        return String(result.stdout ?? '');
      };
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Test']);
      writeFileSync(join(root, 'tracked.txt'), 'committed contents\n');
      git(['add', '.']);
      git(['commit', '-qm', 'checkpoint source']);
      const expectedSha = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(join(root, 'tracked.txt'), 'preserve shared source\n');

      const armed = await armTargetedTaskReuse({
        root,
        workspace: WS,
        script: SCRIPT,
        expectedSha,
        env: baseEnv(),
        restoreDirtyCheckpoint: true,
        checkpointRoot: root,
        integrationRoot: root,
        releaseRoot: root,
        deps: deps({
          git: (cwd: string, args: string[]) => {
            const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
            return result.status === 0 ? String(result.stdout ?? '') : null;
          },
        }),
      });

      expect(armed.lines[0]).toContain('reason=checkpoint-root-unverified');
      expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('preserve shared source\n');
      expect(git(['status', '--porcelain'])).not.toBe('');
      armed.finish();
    });

    it('when the workspace cannot be resolved', async () => {
      fixture();
      const armed = await armTargetedTaskReuse({
        root,
        workspace: '@fixture/absent',
        script: SCRIPT,
        expectedSha: HEAD,
        env: baseEnv(),
        deps: deps(),
      });
      expect(armed.env.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
      expect(armed.lines[0]).toMatch(/reason=workspace-unresolved/);
      armed.finish();
    });

    it('closes the database client even when the proof read fails', async () => {
      fixture();
      const armed = await armTargetedTaskReuse({
        root,
        workspace: WS,
        script: SCRIPT,
        expectedSha: HEAD,
        env: baseEnv(),
        deps: deps({ loadProofs: async () => { throw new Error('boom'); } }),
      });
      expect(ended).toBe(1);
      armed.finish();
    });
  });
});

/**
 * WI-6554700010029685: repair head 327e4d1d of frozen candidate 8c03b5dc pins a recorder (libs/test-config
 * @ c389255bc0) that writes `<format> <process.version> <process.platform> <process.arch>`. The gate's
 * selector measured the runtime fingerprint instead, so its proof read matched nothing (`rows=0`) or it
 * gave up (`no-runner-identity`), and every repair round re-ran ~5,900 files. The identity must follow
 * the JUDGED recorder's scheme, exactly as the proof format already does (WI-6554700010008589).
 */
describe('runner identity follows the judged recorder scheme (WI-6554700010029685)', () => {
  /** Verbatim from libs/test-config @ c389255bc0 src/test-pass-reuse-skip.ts. */
  const LEGACY_RECORDER = [
    "export const REUSE_PROOF_FORMAT = 'proof-v3';",
    '/** Proof format + node version + platform + arch of this process (D-004 rule 6, P-001). */',
    'export function executedSourceRunnerIdentity(): string {',
    '  return `${REUSE_PROOF_FORMAT} ${process.version} ${process.platform} ${process.arch}`;',
    '}',
    '',
  ].join('\n');
  const legacyRecorder = () => {
    const file = join(root, 'libs/test-config/src/test-pass-reuse-skip.ts');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, LEGACY_RECORDER);
  };
  /** A lane script shape the fingerprint capture refuses (env prefix + wrapper), as operator-core's are. */
  const WRAPPED = 'PC_TEST_LANE=stateful ../../scripts/pc-heavy.sh -- vitest run --passWithNoTests';

  it('measures the PATH node exactly as a pre-fingerprint lineage does, and null when the probe fails', () => {
    const calls: Array<{ file: string; args: string[]; cwd: unknown; env: unknown }> = [];
    const env = { PATH: '/x' };
    const exec = (file: string, args: string[], options: { cwd?: unknown; env?: unknown }) => {
      calls.push({ file, args, cwd: options.cwd, env: options.env });
      return 'v25.9.0 linux x64\n';
    };
    expect(nodeVersionRunnerIdentity('/judged', env, 'proof-v3', exec)).toBe('proof-v3 v25.9.0 linux x64');
    expect(calls).toEqual([{ file: 'node', args: ['-p', "process.version + ' ' + process.platform + ' ' + process.arch"],
      cwd: '/judged', env }]);
    expect(nodeVersionRunnerIdentity('/judged', env, 'proof-v3', () => { throw new Error('ENOENT'); })).toBeNull();
    expect(nodeVersionRunnerIdentity('/judged', env, 'proof-v3', () => '  \n')).toBeNull();
  });

  it('takes the node-version identity for a legacy judged tree, whatever the task script shape', () => {
    fixture(WRAPPED);
    legacyRecorder();
    const task = { workspaceRoot: join(root, 'packages/lane-ws'), scriptText: WRAPPED };
    const legacy = defaultRunnerIdentity(root, process.env, 'proof-v3', task);
    expect(legacy).toMatch(/^proof-v3 v\d+\.\d+\.\d+ \S+ \S+$/);
    expect(legacy).toBe(nodeVersionRunnerIdentity(root, process.env, 'proof-v3'));
    // The pre-fix measurement of the same task: the fingerprint capture refuses the wrapper.
    expect(defaultRunnerIdentity(root, process.env, 'proof-v3', task, 'runtime-fingerprint')).toBeNull();
    // An unclassifiable recorder keeps the fingerprint measurement (the pre-fix behaviour).
    expect(defaultRunnerIdentity(root, process.env, 'proof-v3', task, null)).toBeNull();
  });

  it('arms reuse on a legacy lineage from the default identity seam, and the judged consumer accepts the list', async () => {
    fixture();
    legacyRecorder();
    const expected = nodeVersionRunnerIdentity(root, baseEnv(), 'proof-v3');
    expect(expected).not.toBeNull();
    const seen: unknown[] = [];
    // The proof read keys on the identity, as the database read does: any other identity loads nothing.
    const loadProofs = async ({ runnerIdentity }: { runnerIdentity: string }) => {
      seen.push(runnerIdentity);
      const rows = runnerIdentity === expected
        ? [['packages/lane-ws/a.test.ts', { ...proof(HEAD, ['packages/lane-ws/a.test.ts', 'packages/lane-ws/src/a.ts']), runnerIdentity: expected }]] as const
        : [];
      return { proofs: new Map(rows), rows: rows.length };
    };
    const seams = deps({ loadProofs }) as Record<string, unknown>;
    delete seams.runnerIdentity; // the default seam is the thing under test
    delete seams.proofFormat;
    const armed = await armTargetedTaskReuse({
      root, workspace: WS, script: SCRIPT, expectedSha: HEAD, env: baseEnv(), scope: 'targeted-gate',
      deps: seams as Deps,
    });
    expect(seen).toEqual([expected]);
    expect(armed.reused).toBe(1);
    const list = parseReuseSkipList(readFileSync(armed.env.PC_TEST_REUSE_SKIP_LIST!, 'utf8'));
    expect(list.runnerIdentity).toBe(expected);
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: expected! })).toMatchObject({ applied: true });
    armed.finish();
  });
});
