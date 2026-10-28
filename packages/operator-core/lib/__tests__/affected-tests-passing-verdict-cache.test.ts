import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { delimiter as pathDelimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPassingTaskVerdictIdentity,
  captureNpmTaskRuntimeIdentity,
  capturePassingTaskRuntimeIdentity,
  CAPABILITY_BASH_SEAM_IDENTITY_ENV,
  closureDigestManifestPath,
  decidePassingTaskVerdict,
  diffClosureDigests,
  diffIdentityEnvDigests,
  emptyClosureDigestManifest,
  emptyPassingTaskVerdictCache,
  formatIdentityEnvDeltaLine,
  formatPassingTaskVerdictSummary,
  hashDependencyFileSet,
  identityEnvDigests,
  mergeClosureDigestManifest,
  mergePassingTaskVerdictUpdates,
  readClosureDigestManifest,
  SHELL_VOLATILE_IDENTITY_ENV,
  namespacePassingTaskVerdictDecision,
  PASSING_TASK_VERDICT_CACHE_MAX_GROUPS,
  PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
  PASSING_TASK_SHARED_MODULE_INPUTS,
  PC_HEAVY_VOLATILE_IDENTITY_ENV,
  passingTaskVerdictCacheEntry,
  passingTaskVerdictCrossRunIdentityEnvironment,
  passingTaskVerdictCrossRunGateConfig,
  passingTaskVerdictDependencyProvenance,
  passingTaskVerdictIdentityEnvironment,
  passingTaskVerdictSharedInputProvenance,
  passingTaskVerdictEntry,
  readPassingTaskVerdictCache,
  shouldStorePassingTaskVerdict,
  writePassingTaskVerdictCacheAtomic,
} from '../../../../scripts/lib/passing-task-verdict-cache.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// The supervised copy-out mutation probe reads its relocated subject. Ordinary
// suite runs always read the canonical repo source.
const AFFECTED_TESTS_PATH =
  process.env.PAPERCUSP_MUTATION_PROBE === '1' && process.env.PAPERCUSP_AFFECTED_TESTS_SOURCE_OVERRIDE
    ? process.env.PAPERCUSP_AFFECTED_TESTS_SOURCE_OVERRIDE
    : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
const AFFECTED_TESTS_SRC = readFileSync(AFFECTED_TESTS_PATH, 'utf8').replaceAll(
  '"',
  "'",
);
const GREEN_CHECKPOINT_SRC = readFileSync(resolve(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts'), 'utf8');
// D-007 pins which npm scripts opt into reuse, so the script table is part of the contract.
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

const identity = (overrides: Record<string, unknown> = {}) =>
  buildPassingTaskVerdictIdentity({
    taskKey: '@papercusp/web :: test',
    command: { cmd: 'npm', argv: ['run', 'test'], cwd: '/checkpoint' },
    environment: { CI: '1', VITEST_MAX_FORKS: '2' },
    gateConfig: { retry: true, timeoutMs: 1000 },
    dependencyHash: 'dep-a',
    runtimeIdentity: runtimeTuple(),
    ...overrides,
  })!;

const runtimeTuple = (overrides: Record<string, unknown> = {}) => ({
  name: 'node', version: '25.9.0', executable: '/pinned/node',
  binarySha256: 'a'.repeat(64), platform: 'linux', arch: 'x64',
  nativeDependencyGeneration: 'b'.repeat(64), lockfileSha256: 'c'.repeat(64),
  configurationSha256: 'd'.repeat(64), ...overrides,
});

describe('P005 runtime-specific passing proofs', () => {
  it('measures npm\'s workspace PATH interpreter, including a Bun binary named node', () => {
    if (process.platform === 'win32') return; // The POSIX shebang route explicitly declines Windows.
    const root = mkdtempSync(join(tmpdir(), 'runtime-npm-path-'));
    try {
      const workspaceRoot = join(root, 'pkg');
      const bin = join(workspaceRoot, 'node_modules/.bin');
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, 'node_modules'));
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      writeFileSync(join(root, 'node_modules/.papercusp-dependency-generation'),
        `identity=v1-${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\n`);
      writeFileSync(join(bin, 'vitest'), '#!/usr/bin/env node\n', { mode: 0o755 });
      const executable = process.env.PAPERCUSP_RUNTIME_TEST_BUN || process.execPath;
      symlinkSync(executable, join(bin, 'node'));
      const actual = captureNpmTaskRuntimeIdentity({ root, workspaceRoot,
        scriptText: 'vitest run --config vitest.config.ts', environment: process.env });
      expect(actual).toMatchObject({ name: process.env.PAPERCUSP_RUNTIME_TEST_BUN ? 'bun' : 'node',
        binarySha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
      });
      // Same argv and PATH cannot turn a non-Node shebang into a Node proof.
      writeFileSync(join(bin, 'vitest'), '#!/usr/bin/env bun\n');
      expect(captureNpmTaskRuntimeIdentity({ root, workspaceRoot,
        scriptText: 'vitest run', environment: process.env })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not label an opaque npm script with npm\'s own interpreter', () => {
    for (const scriptText of ['bun x vitest run', 'npm run child', 'vitest run && bun other.ts',
      'NODE_OPTIONS=--require=other vitest run', 'vitest run $(runtime-selector)']) {
      expect(captureNpmTaskRuntimeIdentity({ root: '/missing', workspaceRoot: '/missing',
        scriptText, environment: process.env })).toBeNull();
    }
    for (const hook of [{ preScript: 'bun setup.ts' }, { postScript: 'bun check.ts' }]) {
      expect(captureNpmTaskRuntimeIdentity({ root: '/missing', workspaceRoot: '/missing',
        scriptText: 'vitest run', environment: process.env, ...hook })).toBeNull();
    }
  });

  // WI-6554700010030941: the operator-core lanes are wrapped (`PC_TEST_LANE=… pc-heavy.sh -- …`),
  // and the bare-only match gave them no identity, so the gate reused ZERO verdicts. These run
  // against a PINNED fixture root, so a null here is the unwrap refusing, not the missing pin.
  it('gives the real wrapped lane scripts an identity bound to their launcher bytes', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'runtime-npm-lanes-'));
    try {
      const workspaceRoot = join(root, 'packages/operator-core');
      const bin = join(workspaceRoot, 'node_modules/.bin');
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, 'node_modules'));
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      writeFileSync(join(root, 'node_modules/.papercusp-dependency-generation'),
        `identity=v1-${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\n`);
      writeFileSync(join(bin, 'vitest'), '#!/usr/bin/env node\n', { mode: 0o755 });
      symlinkSync(process.env.PAPERCUSP_RUNTIME_TEST_BUN || process.execPath, join(bin, 'node'));
      writeFileSync(join(root, 'scripts/pc-heavy.sh'), '#!/usr/bin/env bash\nexec "$@"\n', { mode: 0o755 });
      writeFileSync(join(root, 'scripts/run-vitest-pure-lane.mjs'), 'spawn("vitest")\n');
      writeFileSync(join(root, 'scripts/other.sh'), '#!/usr/bin/env bash\nexec "$@"\n', { mode: 0o755 });
      const capture = (scriptText: string) =>
        captureNpmTaskRuntimeIdentity({ root, workspaceRoot, scriptText, environment: process.env });
      const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

      const stateful = 'PC_TEST_LANE=stateful ../../scripts/pc-heavy.sh -- vitest run --passWithNoTests';
      const pure = 'PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- node ../../scripts/run-vitest-pure-lane.mjs';
      expect(capture(stateful)?.launcherDigests).toEqual({
        script: sha(stateful), 'scripts/pc-heavy.sh': sha(readFileSync(join(root, 'scripts/pc-heavy.sh'))),
      });
      expect(capture(pure)?.launcherDigests).toEqual({
        script: sha(pure), 'scripts/pc-heavy.sh': sha(readFileSync(join(root, 'scripts/pc-heavy.sh'))),
        'scripts/run-vitest-pure-lane.mjs': sha(readFileSync(join(root, 'scripts/run-vitest-pure-lane.mjs'))),
      });
      // The bare form keeps its pre-existing identity: no launcherDigests key at all.
      const bare = capture('vitest run --passWithNoTests');
      expect(bare).not.toBeNull();
      expect(bare).not.toHaveProperty('launcherDigests');

      for (const opaque of [
        'NODE_OPTIONS=--require=./preload.cjs vitest run', // changes the runtime; preload bytes unhashed
        'PC_TEST_LANE=pure NODE_OPTIONS=--inspect vitest run',
        'PC_TEST_LANE=pure ../../scripts/other.sh -- vitest run', // not the measured wrapper
        `PC_TEST_LANE=pure ${join(tmpdir(), 'pc-heavy.sh')} -- vitest run`, // same name, outside root
        'PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- vitest run; rm -rf x',
        'PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- node ../../scripts/other.sh',
        'vitest run && echo done',
      ]) expect(capture(opaque), opaque).toBeNull();

      // Editing a wrapper changes the proof identity, so a verdict proved under the old bytes misses.
      const before = identity({ runtimeIdentity: capture(stateful) });
      writeFileSync(join(root, 'scripts/pc-heavy.sh'), '#!/usr/bin/env bash\nexport X=1\nexec "$@"\n');
      const after = identity({ runtimeIdentity: capture(stateful) });
      expect(before.fingerprint).not.toBe(after.fingerprint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['dependencyHash', 'command', 'environment', 'gateConfig'])
  ('refuses a missing %s input even with a measured runtime', (field) => {
    expect(identity({ [field]: undefined })).toBeNull();
  });

  it('measures the selected executable and refuses missing dependency-generation identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-verdict-identity-'));
    try {
      const nodeModules = join(root, 'node_modules');
      mkdirSync(nodeModules);
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      const environment = { ...process.env };
      const executable = process.env.PAPERCUSP_RUNTIME_TEST_BUN || process.execPath;
      const request = { root, environment, executable };
      expect(capturePassingTaskRuntimeIdentity(request)).toBeNull();
      const marker = join(nodeModules, '.papercusp-dependency-generation');
      writeFileSync(marker, `identity=v1-${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\n`);
      const actual = capturePassingTaskRuntimeIdentity(request);
      expect(actual).toMatchObject({ name: process.env.PAPERCUSP_RUNTIME_TEST_BUN ? 'bun' : 'node',
        platform: process.platform, arch: process.arch,
        binarySha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
        lockfileSha256: createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex'),
      });
      expect(actual).not.toBeNull();
      expect(identity({ runtimeIdentity: actual })).not.toBeNull();
      writeFileSync(marker, 'schema=1\nidentity=unpublished\n');
      expect(capturePassingTaskRuntimeIdentity(request)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an entirely absent runtime tuple and legacy proofs', () => {
    expect(identity({ runtimeIdentity: undefined })).toBeNull();
    const current = identity();
    const legacy = passingTaskVerdictEntry(current);
    delete (legacy.components as { runtime?: string }).runtime;
    expect(decidePassingTaskVerdict({ enabled: true, cacheRead: { reason: 'cache-ready' },
      entry: legacy, identity: identity() })).toEqual({ hit: false, reason: 'runtime-identity-changed' });
  });

  it.each([
    ['name', 'bun'], ['version', '1.4.4'], ['binarySha256', 'e'.repeat(64)],
    ['platform', 'darwin'], ['arch', 'arm64'],
    ['nativeDependencyGeneration', 'f'.repeat(64)],
    ['lockfileSha256', '1'.repeat(64)], ['configurationSha256', '2'.repeat(64)],
  ])('rejects %s drift in both directions', (field, changed) => {
    const a = identity({ runtimeIdentity: runtimeTuple() });
    const b = identity({ runtimeIdentity: runtimeTuple({ [field]: changed }) });
    for (const [prior, next] of [[a, b], [b, a]]) {
      expect(decidePassingTaskVerdict({ enabled: true, cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(prior), identity: next })).toEqual({
        hit: false, reason: 'runtime-identity-changed',
      });
    }
  });

  it.each(['name', 'version', 'executable', 'binarySha256', 'platform', 'arch',
    'nativeDependencyGeneration', 'lockfileSha256', 'configurationSha256'])
  ('fails closed when %s is absent', (field) => {
    expect(identity({ runtimeIdentity: runtimeTuple({ [field]: undefined }) })).toBeNull();
  });

  it('preserves a current Node proof after a passing or failing Bun attempt', () => {
    const node = identity({ runtimeIdentity: runtimeTuple() });
    const bun = identity({ runtimeIdentity: runtimeTuple({ name: 'bun', version: '1.4.4' }) });
    expect(bun.fingerprint).not.toBe(node.fingerprint);
    const nodeEntry = passingTaskVerdictEntry(node);
    let cache = mergePassingTaskVerdictUpdates(emptyPassingTaskVerdictCache(), 'run', { task: nodeEntry });
    // A failed Bun attempt must not write or retire any Node proof.
    expect(shouldStorePassingTaskVerdict({ enabled: true, cacheStatus: 'miss', initialStatus: 1,
      finalStatus: 1, absorptionRan: false, identity: bun })).toBe(false);
    expect(passingTaskVerdictCacheEntry(cache, 'run', 'task', node)).toEqual(nodeEntry);
    cache = mergePassingTaskVerdictUpdates(cache, 'run', { task: passingTaskVerdictEntry(bun) });
    for (const current of [node, bun]) {
      expect(decidePassingTaskVerdict({ enabled: true, cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictCacheEntry(cache, 'run', 'task', current), identity: current }).hit).toBe(true);
    }
  });
});

describe('passing affected-task verdict identity', () => {
  it('reuses relocated immutable commands only while command selection and dependency bytes match', () => {
    const parent = mkdtempSync(join(tmpdir(), 'verdict-clone-identity-'));
    try {
      const roots = [join(parent, 'a'), join(parent, 'b')];
      for (const root of roots) {
        mkdirSync(root);
        writeFileSync(join(root, 'subject.ts'), 'export const value = 1;\n');
      }
      const fromClone = (root: string, commandOverrides = {}) => {
        const proof = hashDependencyFileSet({ root, files: ['subject.ts'] });
        if (!proof.ok) throw new Error(proof.reason);
        return identity({
          commandRoot: root,
          command: {
            cmd: join(root, 'node_modules/.bin/vitest'),
            argv: ['run', join(root, 'subject.ts')],
            cwd: root,
            scriptText: 'vitest run',
            relatedFilterDigest: 'complete-selection',
            ...commandOverrides,
          },
          dependencyHash: proof.hash,
        });
      };
      const prior = fromClone(roots[0]);
      const verdict = (next: ReturnType<typeof identity>) => decidePassingTaskVerdict({
        enabled: true, cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(prior), identity: next,
      });
      expect(verdict(fromClone(roots[1]))).toEqual({ hit: true, reason: 'identity-match' });
      expect(verdict(fromClone(roots[1], { argv: ['run', 'different.test.ts'] })).reason).toBe('command-changed');
      expect(verdict(fromClone(roots[1], { relatedFilterDigest: 'narrow-selection' })).reason).toBe('command-changed');
      expect(verdict(fromClone(roots[1], { cmd: join(parent, 'external-tool') })).reason).toBe('command-changed');
      expect(verdict(fromClone(roots[1], { cwd: `${roots[1]}-sibling` })).reason).toBe('command-changed');
      writeFileSync(join(roots[1], 'subject.ts'), 'export const value = 2;\n');
      expect(verdict(fromClone(roots[1]))).toEqual({ hit: false, reason: 'dependency-closure-changed' });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('retains absolute command identity when relocatable clone mode is absent', () => {
    const command = { cmd: 'npm', argv: ['run', 'test'], cwd: '/clone-a' };
    expect(identity({ command }).components.command)
      .not.toBe(identity({ command: { ...command, cwd: '/clone-b' } }).components.command);
  });

  it('is stable across object key order and hits only on a complete identity match', () => {
    const first = identity();
    const same = identity({
      environment: { VITEST_MAX_FORKS: '2', CI: '1' },
      gateConfig: { timeoutMs: 1000, retry: true },
    });
    expect(same).toEqual(first);
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(first, 'then'),
        identity: same,
      }),
    ).toEqual({ hit: true, reason: 'identity-match' });
  });

  it.each([
    ['command', { command: { cmd: 'npm', argv: ['run', 'test:changed'], cwd: '/checkpoint' } }, 'command-changed'],
    ['environment', { environment: { CI: '1', VITEST_MAX_FORKS: '1' } }, 'environment-changed'],
    ['gate config', { gateConfig: { retry: false, timeoutMs: 1000 } }, 'gate-config-changed'],
    ['implementation', { implementationVersion: 'v-next' }, 'implementation-version-changed'],
    ['dependency closure', { dependencyHash: 'dep-b' }, 'dependency-closure-changed'],
  ])('reports an operator-visible %s miss reason', (_label, overrides, reason) => {
    const prior = identity();
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(prior),
        identity: identity(overrides),
      }),
    ).toEqual({ hit: false, reason });
  });

  it('treats missing, corrupt, and incomplete provenance as misses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-verdict-cache-read-'));
    const path = join(dir, 'cache.json');
    try {
      expect(readPassingTaskVerdictCache(path).reason).toBe('cache-file-missing');
      writeFileSync(path, '{broken');
      expect(readPassingTaskVerdictCache(path).reason).toBe('cache-corrupt');
      expect(
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: { reason: 'cache-ready' },
          identity: null,
        }),
      ).toEqual({ hit: false, reason: 'provenance-incomplete' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the initial proof group only for cache identity while preserving the verifier child env', () => {
    const childEnvironment = {
      CI: '1',
      PAPERCUSP_TEST_RUN_GROUP: 'verifier-run',
      AFFECTED_TASK_VERDICT_PROOF_GROUP: 'initial-run',
    };
    const normalized = passingTaskVerdictIdentityEnvironment(childEnvironment);

    expect(normalized).toEqual({
      environment: {
        CI: '1',
        PAPERCUSP_TEST_RUN_GROUP: 'initial-run',
      },
      proofGroupApplied: true,
      cacheGroup: 'initial-run',
    });
    expect(childEnvironment).toEqual({
      CI: '1',
      PAPERCUSP_TEST_RUN_GROUP: 'verifier-run',
      AFFECTED_TASK_VERDICT_PROOF_GROUP: 'initial-run',
    });

    const prior = identity({ environment: normalized.environment });
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(prior),
        identity: identity({
          environment: passingTaskVerdictIdentityEnvironment(childEnvironment).environment,
        }),
      }),
    ).toEqual({ hit: true, reason: 'identity-match' });
  });

  it('ignores per-attempt pc-heavy transport state while keeping the shared proof identity', () => {
    const normalizeAttempt = (suffix: string) =>
      passingTaskVerdictIdentityEnvironment({
        CI: '1',
        AFFECTED_TASK_VERDICT_PROOF_GROUP: 'bounded-series',
        PC_HEAVY_PREEMPT_READY_FILE: `/tmp/ready-${suffix}`,
        PC_HEAVY_PREEMPT_RESULT_FILE: `/tmp/result-${suffix}`,
        PC_HEAVY_CALLER_PID: suffix === 'a' ? '100' : '200',
        PC_HEAVY_CALLER_START_TICKS: suffix === 'a' ? '1000' : '2000',
        PC_HEAVY_PREEMPT_NOTIFY_FD: suffix === 'a' ? '11' : '14',
      });

    expect(normalizeAttempt('a')).toEqual(normalizeAttempt('b'));
    expect(normalizeAttempt('a')).toEqual({
      environment: { CI: '1', PAPERCUSP_TEST_RUN_GROUP: 'bounded-series' },
      proofGroupApplied: true,
      cacheGroup: 'bounded-series',
    });
  });

  it('leaves missing or malformed proof state fail-closed on the verifier run identity', () => {
    const prior = identity({
      environment: { CI: '1', PAPERCUSP_TEST_RUN_GROUP: 'initial-run' },
    });
    for (const proof of [undefined, { corrupt: true }]) {
      const childEnvironment = {
        CI: '1',
        PAPERCUSP_TEST_RUN_GROUP: 'verifier-run',
        ...(proof === undefined
          ? {}
          : { AFFECTED_TASK_VERDICT_PROOF_GROUP: proof }),
      };
      const normalized = passingTaskVerdictIdentityEnvironment(childEnvironment);
      expect(normalized.proofGroupApplied).toBe(false);
      expect(
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: { reason: 'cache-ready' },
          entry: passingTaskVerdictEntry(prior),
          identity: identity({ environment: normalized.environment }),
        }),
      ).toEqual({ hit: false, reason: 'environment-changed' });
    }
  });

  it('renders bounded hit/miss counts and reasons for the composite verdict', () => {
    expect(
      formatPassingTaskVerdictSummary(
        [
          { status: 'hit', reason: 'identity-match' },
          { status: 'miss', reason: 'environment-changed' },
          { status: 'miss', reason: 'dependency-closure-changed' },
          { status: 'miss', reason: 'environment-changed' },
        ],
        { proofGroupApplied: true, cacheGroup: 'initial-run' },
      ),
    ).toBe(
      'AFFECTED_TASK_CACHE_SUMMARY hits=1 misses=3 proofIdentity=initial-run group=53ef7ff1e88c ' +
        'reasons={"dependency-closure-changed":1,"environment-changed":2,"identity-match":1}',
    );
  });

  it('namespaces cache decisions on both hits and misses', () => {
    expect(namespacePassingTaskVerdictDecision({ hit: true, reason: 'identity-match' }, 'cross-run')).toEqual({
      hit: true,
      reason: 'cross-run:identity-match',
    });
    expect(namespacePassingTaskVerdictDecision({ hit: false, reason: 'no-prior-verdict' }, 'cross-run')).toEqual({
      hit: false,
      reason: 'cross-run:no-prior-verdict',
    });
  });
});

describe('dependency-closure hashing and persistence', () => {
  it('enumerates a broad workspace closure with bounded tracked-file visits and exact directory boundaries', () => {
    const names = Array.from({ length: 256 }, (_, index) => `@fixture/dep-${index}`);
    const workspaces = new Map(names.map((name, index) => [name, {
      dir: `packages/dep-${index}`, deps: index === 0 ? names.slice(1) : [],
    }]));
    const owned = names.map((_, index) => `packages/dep-${index}/source.ts`);
    owned.push('packages/dep-1/nested/source.ts');
    const files = ['package.json', ...owned, 'packages/dep-1-neighbor/source.ts',
      ...Array.from({ length: 2048 }, (_, index) => `docs/unrelated-${index}.md`)];
    let visits = 0;
    const trackedFiles = new Proxy(files, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
        return Reflect.get(target, key, receiver);
      },
    });
    const input = {
      root: '/unused', taskKey: names[0] + ' :: test', script: 'test', workspaceName: names[0], workspaces,
      trackedScan: { files: trackedFiles, unscannedPresent: [] }, repoWideTaskKeys: new Set<string>(),
      sharedInputProvenance: { ok: true as const, files: ['package.json'] },
      hashFiles: ({ files }: { files: string[] }) => ({
        ok: true as const, hash: 'fixture', listHash: 'fixture', fileCount: files.length, files: [...files],
      }),
    };
    const proof = passingTaskVerdictDependencyProvenance(input);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error(proof.reason);
    expect(proof.semantic.files).toEqual(['package.json', ...owned]);
    // A deterministic work bound, independent of wall-clock load: rescanning
    // the tracked population once per closure directory exceeds this budget.
    expect(visits).toBeLessThanOrEqual(files.length * 8);
    workspaces.set('@fixture/missing', { dir: 'packages/missing', deps: [] });
    workspaces.get(names[0])!.deps.push('@fixture/missing');
    expect(passingTaskVerdictDependencyProvenance(input)).toEqual({
      ok: false, reason: 'provenance-incomplete:workspace-not-enumerated:packages/missing',
    });
  });

  it('keeps integration tasks non-reusable in resumable runs', () => {
    expect(
      passingTaskVerdictDependencyProvenance({
        root: '/unused',
        taskKey: '@papercusp/operator-core :: test:integration',
        script: 'test:integration',
        workspaceName: '@papercusp/operator-core',
        workspaces: new Map(),
        trackedScan: { files: ['package.json'], unscannedPresent: [] },
        repoWideTaskKeys: new Set(),
      }),
    ).toEqual({
      ok: false,
      reason: 'provenance-incomplete:external-integration-task',
    });
  });

  it('binds paths, bytes, modes/symlink targets, and refuses enumeration gaps', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-verdict-content-'));
    try {
      mkdirSync(join(root, 'pkg'));
      writeFileSync(join(root, 'pkg', 'a.ts'), 'one');
      symlinkSync('a.ts', join(root, 'pkg', 'link.ts'));
      const first = hashDependencyFileSet({
        root,
        files: ['pkg/link.ts', 'pkg/a.ts'],
      });
      expect(first.ok).toBe(true);
      writeFileSync(join(root, 'pkg', 'a.ts'), 'two');
      const second = hashDependencyFileSet({
        root,
        files: ['pkg/a.ts', 'pkg/link.ts'],
      });
      if (!first.ok || !second.ok) throw new Error('test fixture should be hashable');
      expect(second.hash).not.toBe(first.hash);
      expect(
        hashDependencyFileSet({
          root,
          files: ['pkg/a.ts'],
          unavailable: ['libs/unavailable'],
        }),
      ).toEqual({
        ok: false,
        reason: 'provenance-incomplete:unscanned-submodule:libs/unavailable',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WI-595883 recurrence guard (P-010, gate-verdict-liveness-and-repair-reliability-2026-08-31):
  // the original defect was the closure hash DIFFERING between consecutive runs whose closure
  // files were byte- and mode-identical, which made every cross-run cache lookup miss. This pins
  // the property directly: over an UNTOUCHED tree, the hash is a pure function of (path set,
  // kinds/modes, bytes) — input ORDER, input DUPLICATES, a fresh digest cache, and file MTIMES
  // must all be invisible. The sibling test above ('binds paths, bytes, ...') is the calibration
  // control proving the instrument detects a real byte change, so an accidentally-constant hash
  // cannot pass this suite.
  it('WI-595883 recurrence: consecutive hashes over an untouched tree are identical', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-verdict-determinism-'));
    try {
      mkdirSync(join(root, 'pkg', 'nested'), { recursive: true });
      writeFileSync(join(root, 'pkg', 'a.ts'), 'alpha');
      writeFileSync(join(root, 'pkg', 'nested', 'b.ts'), 'beta');
      writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      symlinkSync('a.ts', join(root, 'pkg', 'link.ts'));
      const files = ['pkg/a.ts', 'pkg/nested/b.ts', 'run.sh', 'pkg/link.ts'];
      const first = hashDependencyFileSet({ root, files, digestCache: new Map() });
      // Reversed order + a duplicated entry + a fresh digest cache: none of these is a tree
      // change, so the whole identity — content hash, membership hash, and the persisted
      // closure listing — must not move.
      const second = hashDependencyFileSet({
        root,
        files: [...files].reverse().concat('pkg/a.ts'),
        digestCache: new Map(),
      });
      if (!first.ok || !second.ok) throw new Error('test fixture should be hashable');
      expect(second.hash).toBe(first.hash);
      expect(second.listHash).toBe(first.listHash);
      expect(second.files).toEqual(first.files);
      // Mtime independence: rewind every fixture file to the epoch. Bytes are untouched, so a
      // hash that moves here is reading filesystem metadata the identity must not depend on.
      for (const f of files) utimesSync(join(root, f), 0, 0);
      const third = hashDependencyFileSet({ root, files, digestCache: new Map() });
      if (!third.ok) throw new Error('test fixture should be hashable');
      expect(third.hash).toBe(first.hash);
      expect(third.listHash).toBe(first.listHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically replaces a complete cache and preserves updates merged over a fresh read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-verdict-cache-write-'));
    const path = join(dir, 'cache.json');
    try {
      const update = { ['@papercusp/web :: test']: passingTaskVerdictEntry(identity(), 'now') };
      const next = mergePassingTaskVerdictUpdates(
        emptyPassingTaskVerdictCache(),
        'proof-a',
        update,
        '2026-08-23T00:00:00.000Z',
      );
      writePassingTaskVerdictCacheAtomic(path, next, 'nonce');
      expect(readPassingTaskVerdictCache(path)).toEqual({ cache: next, reason: 'cache-ready' });
      expect(passingTaskVerdictCacheEntry(next, 'proof-a', '@papercusp/web :: test')).toEqual(
        update['@papercusp/web :: test'],
      );
      expect(readdirSync(dir)).toEqual(['cache.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains independent proof groups and bounds old groups without cross-overwrite', () => {
    let cache = emptyPassingTaskVerdictCache();
    for (let i = 0; i < PASSING_TASK_VERDICT_CACHE_MAX_GROUPS + 2; i++) {
      cache = mergePassingTaskVerdictUpdates(
        cache,
        `proof-${i}`,
        { [`task-${i}`]: passingTaskVerdictEntry(identity({ taskKey: `task-${i}` })) },
        new Date(i * 1_000).toISOString(),
      );
    }
    expect(Object.keys(cache.groups)).toHaveLength(PASSING_TASK_VERDICT_CACHE_MAX_GROUPS);
    expect(cache.groups['proof-0']).toBeUndefined();
    expect(cache.groups['proof-1']).toBeUndefined();
    expect(passingTaskVerdictCacheEntry(cache, 'proof-2', 'task-2')).toBeDefined();
    expect(passingTaskVerdictCacheEntry(cache, 'proof-33', 'task-33')).toBeDefined();
  });
});

describe('gate wiring safety contract', () => {
  it('normalizes command paths only on the explicitly marked committed clone path', () => {
    expect(AFFECTED_TESTS_SRC).toContain("commandRoot: process.env.PAPERCUSP_LINT_AS_COMMITTED_CLONE === '1' ? ROOT : null");
    const launcher = readFileSync(resolve(REPO_ROOT, 'scripts/lint-as-committed.mjs'), 'utf8');
    expect(launcher).toContain('lintAsCommittedChildEnv(process.env, repoRoot)');
  });

  it('enables reuse only for a green checkpoint or an explicit bounded resume series', () => {
    expect(AFFECTED_TESTS_SRC).toContain("process.env.GREEN_CHECKPOINT === '1'");
    expect(AFFECTED_TESTS_SRC).toContain("process.env.AFFECTED_TASK_VERDICT_RESUME === '1'");
    expect(AFFECTED_TESTS_SRC).toContain('passingTaskVerdictIdentityEnvironment(childEnv)');
    expect(AFFECTED_TESTS_SRC).toContain('formatPassingTaskVerdictSummary(');
  });

  // AUTO-BAR-R-8 identity drift guard: changing either the cache version or the checkout-root
  // scope can make a verdict earned by one tree or environment appear valid in another. The
  // filename is the durable identity boundary, so pin both pieces of that expression here.
  it('pins the passing-task cache filename to its version and checkout-root scope', () => {
    const rootScopeStart = AFFECTED_TESTS_SRC.indexOf('const TASK_VERDICT_CACHE_ROOT_SCOPE =');
    const cachePathStart = AFFECTED_TESTS_SRC.indexOf('const TASK_VERDICT_CACHE_PATH =');
    const cachePathEnd = AFFECTED_TESTS_SRC.indexOf('const taskVerdictCacheRead =', cachePathStart);

    expect(rootScopeStart).toBeGreaterThan(-1);
    expect(cachePathStart).toBeGreaterThan(rootScopeStart);
    expect(cachePathEnd).toBeGreaterThan(cachePathStart);

    const rootScopeSource = AFFECTED_TESTS_SRC.slice(rootScopeStart, cachePathStart);
    const cachePathSource = AFFECTED_TESTS_SRC.slice(cachePathStart, cachePathEnd);
    expect(rootScopeSource).toContain('.update(ROOT)');
    expect(rootScopeSource).toContain(".digest('hex')");
    expect(cachePathSource).toContain(
      '`papercusp-affected-passing-verdicts-v2-${TASK_VERDICT_CACHE_ROOT_SCOPE}.json`',
    );
  });

  it('persists a validated clean first pass from the task-settlement callback', () => {
    const persist = AFFECTED_TESTS_SRC.indexOf('function persistCleanFirstPassTaskVerdict(');
    // Anchor on the ASSIGNMENT, not the declaration: the contract is that the persist
    // callback is defined before the pool is CONSTRUCTED, which is independent of whether
    // the pool is held in a `const` or hoisted into a `let` and assigned later. Pinning
    // `const initialPool = await` made a pure refactor (`let initialPool;` + assignment)
    // read as a contract violation, and the resulting `expected <n> to be less than -1`
    // hid the real cause — so assert the anchor resolved before comparing positions.
    const pool = AFFECTED_TESTS_SRC.indexOf('initialPool = await runBudgetedTaskShards');
    expect(persist).toBeGreaterThan(-1);
    expect(pool).toBeGreaterThan(-1);
    expect(persist).toBeLessThan(pool);
    const callback = AFFECTED_TESTS_SRC.slice(pool).match(
      /onTaskSettled:\s*(\(scheduled\)\s*=>\s*\{[\s\S]*?\n  \}),/,
    );
    expect(callback, 'the task settlement callback must be wired').not.toBeNull();
    const persisted: unknown[] = [];
    const coverage: unknown[] = [];
    const partialResume: unknown[] = [];
    const initialExecutedMapReads = new Map<string, unknown>();
    const executedMapSnapshot = { status: 'unknown', reason: 'report-not-written' };
    const onTaskSettled = runInNewContext(`(${callback![1]})`, {
      observedCompletedTasks: 0,
      foldSettledTaskCoverage: (task: unknown) => coverage.push(task),
      persistCleanFirstPassTaskVerdict: (task: unknown) => persisted.push(task),
      persistPartialResumeCheckpoint: (task: unknown, value: unknown) => partialResume.push([task, value]),
      taskKey: (task: { key: string }) => task.key,
      executedMapResultFiles: new Map([['test-task', '/results/test-task.json']]),
      initialExecutedMapReads,
      executedMapReportExpectations: new Map(),
      readExecutedMapResults: (path: string) => {
        expect(path).toBe('/results/test-task.json');
        return executedMapSnapshot;
      },
    });
    const settledTask = { task: { t: { key: 'test-task' } }, value: { status: 0 } };
    onTaskSettled(settledTask);
    expect(persisted).toEqual([settledTask]);
    expect(coverage).toEqual([settledTask]);
    // The partial-resume checkpoint is persisted from the same settlement, with the task and
    // its settled value (EI-25175929888724957: the VM context must supply every callee).
    expect(partialResume).toEqual([[settledTask.task, settledTask.value]]);
    expect(initialExecutedMapReads.get('test-task')).toEqual({
      ...executedMapSnapshot, expectsReport: null,
    });
    expect(AFFECTED_TESTS_SRC).not.toContain('taskVerdictCacheUpdates');
  });

  it('executes the real first-pass persist path and writes a reusable cache artifact', () => {
    const start = AFFECTED_TESTS_SRC.indexOf('function persistCleanFirstPassTaskVerdict(');
    const end = AFFECTED_TESTS_SRC.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const persistSource = AFFECTED_TESTS_SRC.slice(start, end + 2);
    const writeCall = '    writePassingTaskVerdictCacheAtomic(';
    expect(persistSource.split(writeCall)).toHaveLength(2);

    const taskName = '@papercusp/web :: test';
    const proof = identity({ taskKey: taskName });
    const runPersist = (source: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'pc-first-pass-persist-'));
      const cachePath = join(dir, 'cache.json');
      const errors: string[] = [];
      try {
        const persist = runInNewContext(`${source}\npersistCleanFirstPassTaskVerdict`, {
          capturedTaskSummaryFailure: () => null,
          shouldStorePassingTaskVerdict,
          TASK_VERDICT_CACHE_ENABLED: true,
          taskKey: (task: { key: string }) => task.key,
          readPassingTaskVerdictCache,
          TASK_VERDICT_CACHE_PATH: cachePath,
          TASK_VERDICT_LOCAL_CROSS_RUN_ONLY: false,
          TASK_VERDICT_CACHE_GROUP: 'first-pass-test',
          mergePassingTaskVerdictUpdates,
          passingTaskVerdictEntry,
          PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
          writePassingTaskVerdictCacheAtomic,
          RUN_TOKEN: 'first-pass-test',
          createHash,
          outSync: () => undefined,
          errSync: (message: string) => errors.push(message),
          taskVerdictPersistDefects: [],
        }, { timeout: 1000 }) as (settled: unknown) => void;
        persist({
          task: { t: { key: taskName } },
          value: { status: 0, __cacheStatus: 'miss', __cacheIdentity: proof },
        });
        const read = readPassingTaskVerdictCache(cachePath);
        return {
          reason: read.reason,
          entry: passingTaskVerdictCacheEntry(read.cache, 'first-pass-test', taskName),
          errors,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    expect(runPersist(persistSource)).toMatchObject({
      reason: 'cache-ready',
      entry: { fingerprint: proof.fingerprint, components: proof.components },
      errors: [],
    });
    // A bypass before the actual atomic write must make this test fail. The callback-only
    // guard above would still pass because its persistence function is stubbed.
    const bypassWrite = persistSource.replace(writeCall, `    return;\n${writeCall}`);
    expect(runPersist(bypassWrite)).toMatchObject({ reason: 'cache-file-missing' });
  });

  // Anchor on the suite LAUNCH, not on an `await` spelling. P-004
  // (green-gate-zero-wait-convergence-2026-09-08) deliberately turned the suite into a
  // promise so a repair-verification run can start the independent legs while the suite is
  // still in flight; pinning `const r = await exec(cmd, args` made that intentional
  // refactor read as a contract violation, and the resulting `expected -1 to be greater
  // than -1` hid the real cause — the same trap the sibling test above documents.
  //
  // The durable safety property is NOT source order, so assert it directly: on the serial
  // path the legs stay gated on the suite being considered passing (WI-6053 — legs that
  // silently "passed" because a red suite skipped them).
  it('leaves downstream assurance after the suite', () => {
    const suite = GREEN_CHECKPOINT_SRC.indexOf('const suitePromise = exec(cmd, args');
    const postSuite = GREEN_CHECKPOINT_SRC.indexOf('runPostSuiteLegs(', suite);
    expect(suite).toBeGreaterThan(-1);
    expect(postSuite).toBeGreaterThan(suite);
    expect(GREEN_CHECKPOINT_SRC).toMatch(
      /suiteCompleted\s*\?\s*await runPostSuiteLegs\(/,
    );
  });
});

// EI-21577710345620735 — cross-run reuse.
//
// The per-run group deliberately confines reuse to ONE gate run, which is why a red gate re-tests
// the ~100 tasks that already passed: their proof exists but is filed under last run's group and
// is unreachable. These tests pin BOTH halves of the fix, and the second half matters more than
// the first: reuse that fires when it must not is a gate that certifies unverified code.
describe('cross-run passing-task verdict reuse', () => {
  const crossRunIdentity = (
    environment: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) =>
    buildPassingTaskVerdictIdentity({
      runtimeIdentity: runtimeTuple(),
      taskKey: '@papercusp/web :: test',
      command: { cmd: 'npm', argv: ['run', 'test'], cwd: '/checkpoint' },
      gateConfig: passingTaskVerdictCrossRunGateConfig({ retry: true, timeoutMs: 1000 }),
      dependencyHash: 'dep-a',
      ...overrides,
      environment: passingTaskVerdictCrossRunIdentityEnvironment(environment).environment,
    })!;

  const runA = {
    CI: '1',
    AFFECTED_BASE: 'a2d69cef',
    PAPERCUSP_TEST_RUN_GROUP: 'run-A',
    VITEST_MAX_FORKS: '8',
    VITEST_MAX_WORKERS: '8',
    VITEST_MAX_THREADS: '8',
  };
  // Same tree, next hourly fire: new run group, and a different fork allocation because the box
  // was busier. Neither says anything about what the task exercised.
  const runB = {
    ...runA,
    PAPERCUSP_TEST_RUN_GROUP: 'run-B',
    VITEST_MAX_FORKS: '4',
    VITEST_MAX_WORKERS: '4',
    VITEST_MAX_THREADS: '4',
  };

  it('resolves to one stable group so run N+1 can reach run N proof', () => {
    expect(passingTaskVerdictCrossRunIdentityEnvironment(runA).cacheGroup).toBe(
      PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
    );
    expect(passingTaskVerdictCrossRunIdentityEnvironment(runB).cacheGroup).toBe(
      PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
    );
  });

  // Without this the feature is INERT, and inert is the failure mode that does not announce
  // itself: every lookup simply misses and the gate looks exactly as deadlocked as before.
  it('ignores run group and fork allocation, so an unchanged task hits in the next run', () => {
    expect(crossRunIdentity(runB).fingerprint).toBe(crossRunIdentity(runA).fingerprint);
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(crossRunIdentity(runA)),
        identity: crossRunIdentity(runB),
      }),
    ).toMatchObject({ hit: true });
  });

  // The task timeout is DERIVED FROM DURATION HISTORY (timeoutDurationEstimate), so every run
  // moves the next run's value. Left in the identity it is self-invalidating: run J hit, and
  // byte-identical run K missed with `gate-config-changed` purely because J recorded a duration.
  // Same class as run group and fork allocation above — a resource envelope, not a description
  // of what the task exercises.
  const batchTimeoutPolicy = {
    overrideMs: null,
    floorMs: 2_700_000,
    headroomMultiplier: 3,
    quantumMs: 60_000,
    maxMs: 5_400_000,
  };
  // Built through the SAME normaliser the runner calls, so this can never pass against a local
  // reimplementation of the rule while the runner does something else.
  const withTimeout = (effectiveMs: number | null, source: string | null) => ({
    gateConfig: passingTaskVerdictCrossRunGateConfig({
      retry: true,
      affectedBase: 'a2d69cef',
      batchTimeout: { ...batchTimeoutPolicy, effectiveMs, source },
    }),
  });

  it('ignores a history-derived task timeout, so recording a duration does not evict the proof', () => {
    // Run A fell back to the floor (no history). Run B had A's duration, so its bound moved.
    const proven = crossRunIdentity(runA, withTimeout(null, 'floor'));
    const next = crossRunIdentity(runB, withTimeout(1_234_000, 'history'));
    expect(next.fingerprint).toBe(proven.fingerprint);
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(proven),
        identity: next,
      }),
    ).toMatchObject({ hit: true });
  });

  // The falsifier for the exclusion above: neutralising the DERIVED bound must not smuggle out
  // the STATIC timeout policy with it. A real config change still has to invalidate.
  // The falsifier for the exclusion above: neutralising the DERIVED bound must not smuggle out
  // the STATIC timeout policy with it. A real config change still has to invalidate.
  it('ignores resolved timeout policy because runner policy files own invalidation', () => {
    const proven = crossRunIdentity(runA, withTimeout(null, 'floor'));
    const policyChanged = crossRunIdentity(runB, {
      gateConfig: passingTaskVerdictCrossRunGateConfig({
        retry: true,
        affectedBase: 'a2d69cef',
        batchTimeout: { ...batchTimeoutPolicy, floorMs: 600_000, effectiveMs: null, source: 'floor' },
      }),
    });
    expect(policyChanged.fingerprint).toBe(proven.fingerprint);
  });

  // Identity-level agreement is not wiring: the runner has to actually ROUTE its cross-run
  // gateConfig through the normaliser, and it is the runner — not this module — that reads
  // durationHistory. Without this the rule can be correct and simply never called.
  it('routes the cross-run gateConfig through the normaliser in affected-tests.mjs', () => {
    const runner = readFileSync(resolve(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');
    expect(runner).toMatch(
      /gateConfig:\s*passingTaskVerdictCrossRunGateConfig\(\s*cacheIdentitySpec\.gateConfig\s*\)/,
    );
    // and it must actually be imported, not just referenced
    expect(runner).toMatch(/^\s*passingTaskVerdictCrossRunGateConfig,\s*$/m);
  });

  // The falsifiability controls. Each asserts a MISS: if any of these ever hits, the gate is
  // reusing a verdict that no longer describes the code under test.
  it('MISSES when a dependency byte changed — the property the gate rests on', () => {
    const proven = crossRunIdentity(runA, { dependencyHash: 'dep-a' });
    const changed = crossRunIdentity(runB, { dependencyHash: 'dep-a-MUTATED' });
    expect(changed.fingerprint).not.toBe(proven.fingerprint);
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictEntry(proven),
        identity: changed,
      }),
    ).toMatchObject({ hit: false });
  });

  it('MISSES when the command changed, not when ambient environment or resolved gate state changed', () => {
    const proven = crossRunIdentity(runA);
    expect(crossRunIdentity(runB, { command: { cmd: 'npm', argv: ['run', 'test:integration'] } }).fingerprint).not.toBe(
      proven.fingerprint,
    );
    expect(crossRunIdentity(runB, { gateConfig: passingTaskVerdictCrossRunGateConfig({ retry: false, timeoutMs: 1000 }) }).fingerprint).toBe(
      proven.fingerprint,
    );
    expect(crossRunIdentity({ ...runB, AFFECTED_BASE: 'newgreen' }).fingerprint).toBe(proven.fingerprint);
  });

  it('ignores arbitrary inherited environment drift: related inputs own invalidation', () => {
    expect(crossRunIdentity({ ...runB, SOME_NEW_TOGGLE: '1' }).fingerprint).toBe(
      crossRunIdentity(runA).fingerprint,
    );
    expect(passingTaskVerdictCrossRunIdentityEnvironment({ ANYTHING: 'caller-state' }).environment).toEqual({});
  });

  // The cap is an LRU written for disposable per-run groups. The cross-run group is the one whose
  // entire value is surviving into later runs, and evicting it degrades silently to "no reuse".
  it('never evicts the cross-run group under the MAX_GROUPS cap', () => {
    let cache = emptyPassingTaskVerdictCache();
    cache = mergePassingTaskVerdictUpdates(
      cache,
      PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
      { '@papercusp/web :: test': passingTaskVerdictEntry(crossRunIdentity(runA)) },
      '2020-01-01T00:00:00.000Z', // deliberately the OLDEST entry in the cache
    );
    for (let i = 0; i < PASSING_TASK_VERDICT_CACHE_MAX_GROUPS + 5; i += 1) {
      cache = mergePassingTaskVerdictUpdates(
        cache,
        `run-${i}`,
        { '@papercusp/web :: test': passingTaskVerdictEntry(identity()) },
        `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      );
    }
    expect(Object.keys(cache.groups)).toContain(PASSING_TASK_VERDICT_CROSS_RUN_GROUP);
    expect(
      passingTaskVerdictCacheEntry(cache, PASSING_TASK_VERDICT_CROSS_RUN_GROUP, '@papercusp/web :: test'),
    ).toBeDefined();
  });

  it('is wired into affected-tests.mjs on both the lookup and the store path', () => {
    expect(AFFECTED_TESTS_SRC).toContain('passingTaskVerdictCrossRunIdentityEnvironment(childEnv)');
    // The store must reach the cross-run group, or run N+1 has nothing to read.
    expect(AFFECTED_TESTS_SRC).toContain('PASSING_TASK_VERDICT_CROSS_RUN_GROUP');
    expect(AFFECTED_TESTS_SRC).toContain('__crossRunCacheIdentity');
  });

  it('keeps cross-run miss instrumentation instead of reporting only fallback hits', () => {
    expect(AFFECTED_TESTS_SRC).toContain('cacheDecision = namespacePassingTaskVerdictDecision(');
    expect(AFFECTED_TESTS_SRC).not.toContain('if (crossRunDecision.hit)');
  });
});

// D-007 (plan gate-stop-chasing-the-tip-2026-08-19, WI-572013) — the owner selected behavior B:
// the ROOT ordinary `npm test` reuses previously clean whole-task verdicts across local runs,
// under the SAME complete identity contract the gate uses. Two properties are pinned here, and
// the second is the load-bearing one: widening WHICH commands may reuse must not widen WHAT is
// reusable. Every miss rule above still applies unchanged to a local run.
describe('D-007 root `npm test` local cross-run reuse', () => {
  // Bound the persist function by its real closing brace, not a magic byte count: a fixed slice
  // silently stops covering the tail of the function as comments/code are added, which turns
  // these guards into false greens exactly when the function is being edited.
  const persistFnSource = (): string => {
    const start = AFFECTED_TESTS_SRC.indexOf('function persistCleanFirstPassTaskVerdict(');
    expect(start).toBeGreaterThan(-1);
    const end = AFFECTED_TESTS_SRC.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    return AFFECTED_TESTS_SRC.slice(start, end);
  };
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('opts the root test script into resumable execution', () => {
    // The whole feature is inert without this: TASK_VERDICT_CACHE_ENABLED gates on
    // GREEN_CHECKPOINT or AFFECTED_TASK_VERDICT_RESUME, and an ordinary local run sets neither.
    expect(PACKAGE_JSON.scripts?.test).toContain('AFFECTED_TASK_VERDICT_RESUME=1');
    expect(PACKAGE_JSON.scripts?.test).toContain('scripts/affected-tests.mjs');
  });

  it('keeps D-007 scope: related/all sweeps and direct file runs stay fresh', () => {
    // D-007 scopes reuse to the root affected-tests command ONLY. These have different selection
    // or execution semantics, so a proof taken under one is not a proof for another.
    for (const name of ['test:related', 'test:all', 'test:all:integration', 'test:integration-only', 'test:file']) {
      expect(PACKAGE_JSON.scripts?.[name]).not.toContain('AFFECTED_TASK_VERDICT_RESUME=1');
    }
  });

  it('routes a local run with no proof group to the stable cross-run group', () => {
    // Root `npm test` sets no PC_HEAVY_RETRY_PREEMPTIONS, so pc-heavy returns before its
    // proof-group export and the run legitimately has none. That is the local path.
    expect(AFFECTED_TESTS_SRC).toContain('const TASK_VERDICT_LOCAL_CROSS_RUN_ONLY =');
    expect(AFFECTED_TESTS_SRC).toContain('PASSING_TASK_VERDICT_CROSS_RUN_GROUP');
    // It must reuse the EXISTING cross-run identity, never mint a shared child run group.
    expect(AFFECTED_TESTS_SRC).toContain('passingTaskVerdictCrossRunIdentityEnvironment(childEnv)');
  });

  it('stays fail-closed: a green checkpoint never takes the local path', () => {
    // D-007: "never while GREEN_CHECKPOINT is active (a gate without proof state must stay
    // fail-closed)". The gate must keep its caller-supplied per-run boundary.
    const local = AFFECTED_TESTS_SRC.indexOf('const TASK_VERDICT_LOCAL_CROSS_RUN_ENABLED =');
    expect(local).toBeGreaterThan(-1);
    const clause = AFFECTED_TESTS_SRC.slice(local, local + 220);
    expect(clause).toContain("process.env.AFFECTED_TASK_VERDICT_RESUME === '1'");
    expect(clause).toContain("process.env.GREEN_CHECKPOINT !== '1'");
  });

  it('reports the local run as cross-run scope rather than current-run', () => {
    // Without cacheScope the summary reads proofIdentity=current-run for a run whose whole
    // purpose is reuse ACROSS runs — an observability lie that hides whether B is live.
    expect(AFFECTED_TESTS_SRC).toContain('cacheScope: TASK_VERDICT_CACHE_SCOPE');
    expect(formatPassingTaskVerdictSummary([{ status: 'hit', reason: 'cross-run:hit' }], {
      proofGroupApplied: false,
      cacheGroup: PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
      cacheScope: 'cross-run',
    })).toContain('proofIdentity=cross-run');
  });

  // REGRESSION (WI-572013): the store path's else-branch referenced `perRunMerged`, a binding the
  // function does not declare. Because the body is wrapped in a catch, the ReferenceError was
  // swallowed and reported as `status=failed`, so reuse degraded to "nothing is ever stored" —
  // outwardly identical to "reuse is on, nothing was reusable". Two guards: the dead binding is
  // gone, and the catch now re-throws programmer errors so the class cannot be silent again.
  it('does not reference an undeclared binding on the store path', () => {
    // Strip comments first: this guard is about CODE. Prose that merely NAMES the dead binding
    // (including the regression note left at the fix site) must not trip it.
    const body = stripComments(persistFnSource());
    const used = body.includes('perRunMerged');
    const declared = /(?:const|let|var)\s+perRunMerged\b/.test(body);
    // Either the binding is absent entirely, or it is genuinely declared before use.
    expect(used && !declared).toBe(false);
  });

  it('reports a programmer error loudly instead of degrading to silent no-reuse', () => {
    const body = persistFnSource();
    expect(body).toContain('error instanceof ReferenceError');
    expect(body).toContain('error instanceof TypeError');
    expect(body).toContain('taskVerdictPersistDefects.push(');
    expect(body).toContain('status=defect');
    // And it must be surfaced where the cache is already reported, not only per-task on stderr.
    expect(AFFECTED_TESTS_SRC).toContain('AFFECTED_TASK_CACHE_DEFECTS count=');
  });

  // A persist-path defect costs REUSE, never correctness: the suite simply does more work. This
  // callback is awaited inside runBudgetedTasks' try/catch, which re-throws
  // (budgeted-task-scheduler.mjs), so throwing here would abort the whole suite and turn a lost
  // optimization into a gate outage that blocks every agent's deploys. Loud, counted, NOT fatal.
  it('never aborts the suite from the settlement callback', () => {
    const body = stripComments(persistFnSource());
    expect(body).not.toContain('throw ');
    // The scheduler contract this depends on: settlement is awaited inside a re-throwing catch.
    const scheduler = readFileSync(resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs'), 'utf8');
    expect(scheduler).toContain('await onTaskSettled(scheduled)');
  });

  // Widening the ENTRY POINT must not widen the ADMISSION RULE. These re-assert, against the
  // real decision function, that a local-shaped run still misses on the things D-007 enumerates.
  it('still misses on a dependency-closure change in a local run', () => {
    const cache = mergePassingTaskVerdictUpdates(
      emptyPassingTaskVerdictCache(),
      PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
      { '@papercusp/web :: test': passingTaskVerdictEntry(identity({ dependencyHash: 'dep-a' })) },
    );
    const decide = (dependencyHash: string) =>
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: 'cache-ready' },
        entry: passingTaskVerdictCacheEntry(
          cache,
          PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
          '@papercusp/web :: test',
        ),
        identity: identity({ dependencyHash }),
      });
    expect(decide('dep-a').hit).toBe(true);
    // One byte anywhere in the closure changed => execute. This is the property B rests on.
    expect(decide('dep-b').hit).toBe(false);
  });

  it('still refuses to store a failed or absorbed local task', () => {
    const base = {
      enabled: true,
      cacheStatus: 'miss',
      initialStatus: 0,
      finalStatus: 0,
      absorptionRan: false,
      identity: identity(),
    };
    expect(shouldStorePassingTaskVerdict(base)).toBe(true);
    expect(shouldStorePassingTaskVerdict({ ...base, initialStatus: 1 })).toBe(false);
    expect(shouldStorePassingTaskVerdict({ ...base, finalStatus: 1 })).toBe(false);
    expect(shouldStorePassingTaskVerdict({ ...base, absorptionRan: true })).toBe(false);
    expect(shouldStorePassingTaskVerdict({ ...base, identity: null })).toBe(false);
    // A cache HIT must never be re-stored: that would refresh a proof nothing re-verified.
    expect(shouldStorePassingTaskVerdict({ ...base, cacheStatus: 'hit' })).toBe(false);
  });
});

// EI-21748784988454958. The whole cross-run feature was INERT in production and every test above
// still passed, because they build environments by hand and none of them contained the variable
// that actually breaks it. `pc-heavy.sh` exports PC_HEAVY_ADMISSION_ID="pc-heavy-$$-$(date +%s%N)"
// into every child, the identity hashes the COMPLETE environment minus a hand-written strip list,
// and that list did not name it — so `environment` differed on EVERY invocation. Root `npm test`
// (package.json:175) and the green-checkpoint gate both run under pc-heavy, so NEITHER could ever
// hit. The observable symptom is indistinguishable from "the cache is working and nothing was
// reusable", which is why it survived so long.
describe('pc-heavy per-invocation variables are excluded from the cache identity', () => {
  const PC_HEAVY_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/pc-heavy.sh'), 'utf8');

  const identityFor = (environment: Record<string, unknown>) =>
    buildPassingTaskVerdictIdentity({
      runtimeIdentity: runtimeTuple(),
      taskKey: '@papercusp/web :: test',
      command: { cmd: 'npm', argv: ['run', 'test'], cwd: '/repo' },
      gateConfig: { retry: true, timeoutMs: 1000 },
      dependencyHash: 'dep-a',
      environment: passingTaskVerdictCrossRunIdentityEnvironment(environment).environment,
    })!;

  // A realistic child environment for two separate `npm test` invocations on an UNCHANGED tree.
  const invocationOne = {
    CI: '1',
    AFFECTED_BASE: 'a2d69cef',
    PAPERCUSP_TEST_RUN_GROUP: 'run-A',
    PC_HEAVY_ADMISSION_ID: 'pc-heavy-2582689-1787966068993715006',
    PC_HEAVY_PSI_FINALIZATION_FILE: '/tmp/pc-heavy-ready/finalization.aBc123',
    PC_HEAVY_PREEMPT_START_FILE: '/tmp/pc-heavy-slots/scratch/start.xY9z01',
  };
  const invocationTwo = {
    ...invocationOne,
    PAPERCUSP_TEST_RUN_GROUP: 'run-B',
    PC_HEAVY_ADMISSION_ID: 'pc-heavy-2599104-1787967914220388311',
    PC_HEAVY_PSI_FINALIZATION_FILE: '/tmp/pc-heavy-ready/finalization.Qq77Zz',
    PC_HEAVY_PREEMPT_START_FILE: '/tmp/pc-heavy-slots/scratch/start.Kj4m22',
    // Live WI-1024071 Run D gained this conditional wrapper flag while Run C lacked it. It
    // controls whether pc-heavy may preempt an exclusive materializer, not what the task tests.
    PC_HEAVY_PREEMPT_EXCLUSIVE: '0',
  };

  it('hits across two invocations of the real root `npm test` environment', () => {
    expect(identityFor(invocationTwo).fingerprint).toBe(identityFor(invocationOne).fingerprint);
  });

  it.each([
    'PC_HEAVY_ADMISSION_ID',
    'PC_HEAVY_PSI_FINALIZATION_FILE',
    'PC_HEAVY_PREEMPT_START_FILE',
    'PC_HEAVY_PREEMPT_EXCLUSIVE',
  ])('a new %s alone does not invalidate the identity', (name) => {
    const changed = { ...invocationOne, [name]: 'something-entirely-different' };
    expect(identityFor(changed).fingerprint).toBe(identityFor(invocationOne).fingerprint);
  });

  it('ignores even stable wrapper configuration because it is not a related task input', () => {
    const moved = { ...invocationOne, PC_HEAVY_ADMISSION_DIR: '/somewhere/else/psi-admissions' };
    const base = { ...invocationOne, PC_HEAVY_ADMISSION_DIR: '/run/user/1000/pc-heavy-slots/psi-admissions' };
    expect(identityFor(moved).fingerprint).toBe(identityFor(base).fingerprint);
  });

  // ---- the DERIVED guard: pc-heavy.sh owns this truth, so read it rather than restating it ----
  //
  // Resolve one level of indirection: `PC_HEAVY_X="$_local"` is only volatile if some assignment
  // to `_local` is. Returns the set of names whose value reaches a per-invocation expression.
  //
  // Deliberately matches an assignment with OR WITHOUT `export`. pc-heavy also injects variables
  // as a command prefix — `PC_HEAVY_PREEMPT_RESULT_FILE="$_pc_heavy_retry_result_file" \` at
  // pc-heavy.sh:3250 — which reaches the child exactly like an export but matches no `export`
  // pattern. An `export`-only derivation silently under-reported that one.
  //
  // The bias is intentional: this errs toward OVER-inclusion. Naming a variable that never
  // reaches the child is harmless (deleting an absent key is a no-op), whereas missing one that
  // does is precisely the bug this whole block exists to prevent.
  const volatileExportedNames = (): string[] => {
    const VOLATILE = /\$\$|\$RANDOM|\$BASHPID|\bdate\s+\+%s|\bmktemp\b|_scratch_mktemp\b/;
    const localAssignments = new Map<string, string[]>();
    for (const m of PC_HEAVY_SRC.matchAll(/^\s*(?:local\s+)?(_[A-Za-z0-9_]+)=(.*)$/gm)) {
      const [, name, rhs] = m;
      localAssignments.set(name, [...(localAssignments.get(name) ?? []), rhs]);
    }
    const found = new Set<string>();
    for (const m of PC_HEAVY_SRC.matchAll(/^\s*(?:export\s+)?(PC_HEAVY_[A-Z0-9_]+)=(.*)$/gm)) {
      const [, name, rhs] = m;
      if (VOLATILE.test(rhs)) {
        found.add(name);
        continue;
      }
      for (const ref of rhs.matchAll(/\$\{?(_[A-Za-z0-9_]+)\b/g)) {
        if ((localAssignments.get(ref[1]) ?? []).some((v) => VOLATILE.test(v))) found.add(name);
      }
    }
    return [...found].sort();
  };

  // CALIBRATION. Without this the guard below passes vacuously whenever the parser breaks or
  // pc-heavy.sh is restructured — a zero-length derived set matches an empty residue perfectly,
  // and reads exactly like "nothing is volatile". Assert the instrument still finds the variable
  // that caused the bug before trusting anything it says.
  it('the derivation actually detects the known-volatile exports (positive control)', () => {
    const derived = volatileExportedNames();
    // The variable that caused the bug: a plain `export NAME=` with an inline $$ / date +%s%N.
    expect(derived).toContain('PC_HEAVY_ADMISSION_ID');
    // Indirect + command-prefix form: injected without `export` (pc-heavy.sh:3250) and volatile
    // only through `_pc_heavy_retry_result_file` -> `_pc_heavy_scratch_mktemp` (:3147). This
    // pins BOTH the no-export branch and the one level of local-variable resolution; an
    // export-only or non-resolving derivation drops it and fails here.
    expect(derived).toContain('PC_HEAVY_PREEMPT_RESULT_FILE');
    expect(derived.length).toBeGreaterThanOrEqual(4);
  });

  it('every per-invocation export pc-heavy.sh makes is stripped from the identity', () => {
    const unstripped = volatileExportedNames().filter(
      (name) => !PC_HEAVY_VOLATILE_IDENTITY_ENV.includes(name),
    );
    expect(unstripped).toEqual([]);
  });

  // FALSIFIABILITY CONTROL, kept permanently rather than proven once by mutating the shared tree.
  // The guard above is only worth having if it FAILS on an incomplete list, and "expect([]) passes"
  // is equally consistent with a guard that can never fail. This replays the exact pre-fix list and
  // asserts the same comparison rejects it — so a future refactor that quietly defeats the
  // derivation breaks HERE instead of going green while production reuse is dead again.
  it('the same comparison rejects the pre-fix strip list (control)', () => {
    const PRE_FIX_LIST = [
      'PC_HEAVY_PREEMPT_READY_FILE',
      'PC_HEAVY_PREEMPT_RESULT_FILE',
      'PC_HEAVY_CALLER_PID',
      'PC_HEAVY_CALLER_START_TICKS',
      'PC_HEAVY_PREEMPT_NOTIFY_FD',
    ];
    const unstripped = volatileExportedNames().filter((name) => !PRE_FIX_LIST.includes(name));
    expect(unstripped).toContain('PC_HEAVY_ADMISSION_ID');
    expect(unstripped.length).toBeGreaterThan(0);
  });

  // The SECOND structural defeater, found only by running the thing end to end. Removing the
  // volatile environment variables above changed the miss reason from `environment-changed` to
  // `gate-config-changed` — reuse was blocked twice over. gateConfig embeds `scheduler`, the host
  // budget resolveTaskBudget derived from THIS box at launch (worker/fork allocation, concurrency,
  // pid envelope), and SCHEDULER_WORKER_BUDGET comes from VITEST_MAX_WORKERS/FORKS/THREADS
  // (affected-tests.mjs:456-462) — the very variables the environment clone already normalises
  // out. So gateConfig silently re-admitted what the environment component had just excluded.
  //
  // Discriminated by single-variable experiment, not by reading: pinning AFFECTED_BASE alone
  // still missed; pinning the memory budget too still missed; pinning the WORKER BUDGET produced
  // `cross-run:identity-match` with zero task spawns.
  it('neutralises the host worker/fork budget in the cache identity gateConfig', () => {
    // Bound the assertion by the REAL brace structure of the spec object. A fixed-size slice
    // silently stops covering the field it is meant to police as the surrounding code grows —
    // a false green that appears exactly while this area is being edited.
    const start = AFFECTED_TESTS_SRC.indexOf('const cacheIdentitySpec = {');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = AFFECTED_TESTS_SRC.indexOf('{', start); i < AFFECTED_TESTS_SRC.length; i += 1) {
      const ch = AFFECTED_TESTS_SRC[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(start);
    const spec = AFFECTED_TESTS_SRC.slice(start, end + 1);
    // The identity must not carry the resolved host budget.
    expect(spec).toContain('scheduler: null');
    // ...and the spec really is the block we think it is (guards against matching some other
    // object should the source be restructured).
    expect(spec).toContain('dependencyHash');
    expect(spec).toContain('affectedBase');
  });

  // The REAL scheduler config must keep its scheduler — the exclusion above is identity-only and
  // must never leak into what actually governs execution.
  it('still hands the real run a populated scheduler config', () => {
    expect(AFFECTED_TESTS_SRC).toContain('scheduler: SCHEDULER_CONFIG');
  });

  // Belt and braces on the mechanism itself: prove the strip list is what does the work, by
  // checking each named variable really is absent from the hashed clone.
  it('removes every listed variable from the identity clone but not the real child env', () => {
    const environment = Object.fromEntries(
      PC_HEAVY_VOLATILE_IDENTITY_ENV.map((n) => [n, 'per-invocation-value']),
    );
    const { environment: clone } = passingTaskVerdictIdentityEnvironment(environment);
    expect(Object.keys(clone)).toEqual([]);
    // The input object is never mutated — the child still receives its real plumbing.
    expect(environment.PC_HEAVY_ADMISSION_ID).toBe('per-invocation-value');
  });
});

// ---------------------------------------------------------------------------
// WI-595883 — shell-volatile identity, and making a cache miss say WHY.
// ---------------------------------------------------------------------------

describe('shell-volatile variables are outside the cross-run identity', () => {
  const withShellState = (extra: Record<string, string>): Record<string, string> => ({
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    ...extra,
  });

  // MEASURED, not assumed: two runs of the same unchanged task missed with
  // `environment-changed` for the sole reason that one shell had run `cd` and the other had not.
  it('matches two runs that differ only in shell bookkeeping', () => {
    const before = passingTaskVerdictCrossRunIdentityEnvironment(
      withShellState({ OLDPWD: '/tmp', _: '/usr/bin/node', SHLVL: '2' }),
    ).environment;
    const after = passingTaskVerdictCrossRunIdentityEnvironment(
      withShellState({ OLDPWD: '/var/tmp/elsewhere', _: '/usr/bin/timeout', SHLVL: '4' }),
    ).environment;
    expect(after).toEqual(before);
    expect(before).toEqual({});
  });

  // CONTROL. Without the strip these very inputs differ, so the assertion above is load-bearing
  // rather than vacuously true of any two environments. The per-run identity keeps them on
  // purpose — it is confined to one run, where the shell state cannot drift.
  it('control: the same two inputs DO differ before the strip is applied', () => {
    const before = passingTaskVerdictIdentityEnvironment(
      withShellState({ OLDPWD: '/tmp', _: '/usr/bin/node', SHLVL: '2' }),
    ).environment;
    const after = passingTaskVerdictIdentityEnvironment(
      withShellState({ OLDPWD: '/var/tmp/elsewhere', _: '/usr/bin/timeout', SHLVL: '4' }),
    ).environment;
    expect(after).not.toEqual(before);
  });

  it('strips every listed name and never mutates the caller environment', () => {
    const environment = withShellState(
      Object.fromEntries(SHELL_VOLATILE_IDENTITY_ENV.map((name) => [name, 'shell-state'])),
    );
    const { environment: clone } = passingTaskVerdictCrossRunIdentityEnvironment(environment);
    for (const name of SHELL_VOLATILE_IDENTITY_ENV) {
      expect(clone).not.toHaveProperty(name);
      expect(environment[name]).toBe('shell-state');
    }
  });
});

// WI-1024071 live two-run reproduction, 2026-08-30. Run A and Run B selected the same 21 tasks
// over the same explicit changed path and shared cache, but every task missed. ENV_DELTA named
// only the post-compaction caller seam below; the rotating Codex arg0 PATH directory contained
// only `.lock`. Pin the complete observed delta so the real instrument cannot silently go inert
// again while narrower hand-built identity tests stay green.
describe('Codex resume and retry-attempt plumbing are outside the cross-run identity', () => {
  const stablePathParts = [
    '/repo/node_modules/.bin',
    '/opt/codex/vendor/codex-path',
    '/usr/bin',
    '/bin',
  ];
  const pathWithArg0 = (session: string, suffix: string): string =>
    [
      stablePathParts[0],
      stablePathParts[1],
      `/home/agent/.papercusp/su-codex-homes/${session}/tmp/arg0/codex-arg0${suffix}`,
      ...stablePathParts.slice(2),
    ].join(pathDelimiter);

  const runA = {
    LANG: 'C.UTF-8',
    PATH: pathWithArg0('session-21178', 'iRIaLF'),
    CODEX_SESSION_ID: '01a050-before-compaction',
    CODEX_THREAD_ID: '01a050-before-compaction',
    AFFECTED_RETRY_FAILED: '0',
  };
  const runB = {
    LANG: 'C.UTF-8',
    PATH: pathWithArg0('session-21178', 'uTUqd9'),
    CODEX_SESSION_ID: '01a051-after-compaction',
    CODEX_THREAD_ID: '01a051-after-compaction',
    DISABLE_AUTO_COMPACT: '1',
    DISABLE_COMPACT: '1',
  };

  it('matches the complete measured Run A -> Run B environment delta', () => {
    const before = passingTaskVerdictCrossRunIdentityEnvironment(runA).environment;
    const after = passingTaskVerdictCrossRunIdentityEnvironment(runB).environment;
    expect(after).toEqual(before);
    expect(before).toEqual({});
  });

  it('control: the per-run identity still distinguishes the same caller state', () => {
    const before = passingTaskVerdictIdentityEnvironment(runA).environment;
    const after = passingTaskVerdictIdentityEnvironment(runB).environment;
    expect(after).not.toEqual(before);
    expect(after.PATH).not.toBe(before.PATH);
  });

  it('does not admit arbitrary caller PATH or CODEX state into related-input identity', () => {
    const environment = passingTaskVerdictCrossRunIdentityEnvironment({
      PATH: ['/repo/bin', '/tmp/codex-arg0-is-a-real-tool-dir', '/usr/bin'].join(pathDelimiter),
      CODEX_MODEL: 'gpt-result-affecting-control',
    }).environment;
    expect(environment).toEqual({});
  });

  it('excludes all resolved retry/load policy from related-input identity', () => {
    const failFast = passingTaskVerdictCrossRunGateConfig({
      retryFailed: false,
      retryLoad1Threshold: 40,
    });
    const absorbUnderLoad = passingTaskVerdictCrossRunGateConfig({
      retryFailed: true,
      retryLoad1Threshold: 40,
    });
    expect(absorbUnderLoad).toEqual(failFast);
    expect(failFast).toEqual({});
    expect(
      passingTaskVerdictCrossRunGateConfig({ retryFailed: true, retryLoad1Threshold: 80 }),
    ).toEqual(failFast);
  });
});

// ---------------------------------------------------------------------------
// EI-21762403020037943 — launcher-seam markers: the same defeater one level up
// from the shell, and the guard that stops the NEXT launcher re-introducing it.
// ---------------------------------------------------------------------------

describe('capability:bash seam markers are outside the cross-run identity', () => {
  const BASH_JOBS_SRC = readFileSync(
    resolve(REPO_ROOT, 'packages/operator-core/lib/agent-tools/capability/bash-jobs.ts'),
    'utf8',
  );
  const BASH_SRC = readFileSync(
    resolve(REPO_ROOT, 'packages/operator-core/lib/agent-tools/capability/bash.ts'),
    'utf8',
  );

  // ---- the DERIVED guard: the capability:bash seam owns these names, so read them ----
  //
  // `bash-jobs.ts` declares every env name this seam stamps into a child as an exported
  // `*_ENV` constant bound to a string literal. Parse those rather than restating them, so a
  // launcher key added tomorrow is compared against the strip list instead of silently
  // defeating cross-run measurement the way the task id did.
  const seamOwnedEnvNames = (): string[] =>
    [...BASH_JOBS_SRC.matchAll(/^export const ([A-Za-z0-9_]+_ENV) = '([^']+)';/gm)]
      .map((m) => m[2])
      .sort();

  // Every `*_ENV` identifier used as a computed key WRITE (`[X]: …` in a child-env object
  // literal, or `childEnv[X] = …`). A `delete childEnv[X]` is deliberately not a stamp and does
  // not match. This is the completeness half: the derivation above only sees names this seam
  // DECLARES, so anything stamped from an imported constant would escape it.
  const stampedEnvIdentifiers = (src: string): string[] =>
    [...new Set([...src.matchAll(/\[([A-Za-z0-9_]+_ENV)\]\s*(?::|=[^=])/g)].map((m) => m[1]))].sort();

  // Stamped, but deliberately NOT cache-identity names. The runner consumes and deletes both
  // fields before spawning the workload (bash-jobs.ts:1451-1463), so they never reach a test
  // task and cannot be a defeater. Listed rather than pattern-skipped so a third one has to be
  // reasoned about here instead of slipping through.
  const RUNNER_CONTROL_SEAM = ['SYSTEMD_RUNNER_OUTPUT_PATH_ENV', 'SYSTEMD_RUNNER_REDACTIONS_ENV'];

  // CALIBRATION. Without this every guard below passes vacuously whenever a parser breaks or the
  // seam is restructured — an empty derived set is a subset of anything and reads exactly like
  // "nothing is stamped". Assert both instruments still find the marker that caused the bug.
  it('the derivation actually finds the seam-owned env names (positive control)', () => {
    const owned = seamOwnedEnvNames();
    // The name that caused the bug: minted fresh per background job (bash-jobs.ts:1445).
    expect(owned).toContain('PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID');
    // The foreground seam's pair, stamped from bash.ts but DECLARED here — pins that the
    // derivation reads declarations, not just the one file's own assignments.
    expect(owned).toContain('PAPERCUSP_CAPABILITY_BASH_FOREGROUND');
    expect(owned).toContain('PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS');
    expect(owned.length).toBeGreaterThanOrEqual(4);

    // ...and the stamp scanner really sees both shapes: the `Object.assign` object literal in
    // bash-jobs.ts and the direct `childEnv[X] =` assignment beneath it.
    const stamped = stampedEnvIdentifiers(BASH_JOBS_SRC);
    expect(stamped).toContain('CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV');
    expect(stamped).toContain('SYSTEMD_RUNNER_OUTPUT_PATH_ENV');
    expect(stampedEnvIdentifiers(BASH_SRC)).toContain('CAPABILITY_BASH_FOREGROUND_ENV');
  });

  it('every env name the capability:bash seam owns is stripped from the cross-run identity', () => {
    const unstripped = seamOwnedEnvNames().filter(
      (name) => !CAPABILITY_BASH_SEAM_IDENTITY_ENV.includes(name),
    );
    expect(unstripped).toEqual([]);
  });

  // The hole the derivation alone cannot see: a future stamp whose name comes from an IMPORTED
  // constant is never declared in bash-jobs.ts, so `seamOwnedEnvNames` would not know about it.
  // Fail here instead, so the author has to decide whether it is a defeater or runner plumbing.
  it('no child-env stamp escapes the derivation unaccounted for', () => {
    const declared = new Set(
      [...BASH_JOBS_SRC.matchAll(/^export const ([A-Za-z0-9_]+_ENV) = '([^']+)';/gm)].map((m) => m[1]),
    );
    const unaccounted = [...stampedEnvIdentifiers(BASH_JOBS_SRC), ...stampedEnvIdentifiers(BASH_SRC)]
      .filter((ident) => !declared.has(ident) && !RUNNER_CONTROL_SEAM.includes(ident))
      .sort();
    expect(unaccounted).toEqual([]);
  });

  // FALSIFIABILITY CONTROL for the guard above, proven against a SYNTHETIC source rather than by
  // mutating the shared tree (a probe that edits a tracked file can be committed by the git-sync
  // sweep even when nothing goes wrong). `expect([]) passes` is equally consistent with a scanner
  // that can never see anything; this replays the exact filter over a source that stamps a name
  // imported from elsewhere — tomorrow's launcher key — and asserts it is reported.
  it('the same filter reports a stamp imported from elsewhere (control)', () => {
    const SYNTHETIC_SEAM = [
      "import { FUTURE_LAUNCHER_ID_ENV } from '../../somewhere-else';",
      'const childEnv = { ...base };',
      'Object.assign(childEnv, {',
      '  [CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV]: enrolment.taskId,',
      '  [FUTURE_LAUNCHER_ID_ENV]: mintUniqueId(),',
      '});',
    ].join('\n');
    const declared = new Set(
      [...BASH_JOBS_SRC.matchAll(/^export const ([A-Za-z0-9_]+_ENV) = '([^']+)';/gm)].map((m) => m[1]),
    );
    const unaccounted = stampedEnvIdentifiers(SYNTHETIC_SEAM).filter(
      (ident) => !declared.has(ident) && !RUNNER_CONTROL_SEAM.includes(ident),
    );
    // The already-declared name is correctly accounted for; only the new import escapes.
    expect(unaccounted).toEqual(['FUTURE_LAUNCHER_ID_ENV']);
  });

  // FALSIFIABILITY CONTROL, kept permanently rather than proven once by mutating the shared tree.
  // The guard above is only worth having if it FAILS on an incomplete list, and "expect([]) passes"
  // is equally consistent with a guard that can never fail. This replays the EXACT pre-fix
  // cross-run strip set — shell-volatile names only — and asserts the same comparison rejects it.
  it('the same comparison rejects the pre-fix strip set (control)', () => {
    const PRE_FIX_STRIP: readonly string[] = SHELL_VOLATILE_IDENTITY_ENV;
    const unstripped = seamOwnedEnvNames().filter((name) => !PRE_FIX_STRIP.includes(name));
    expect(unstripped).toContain('PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID');
    expect(unstripped.length).toBeGreaterThan(0);
  });

  // MEASURED, not assumed: a grader's two `capability:bash` jobs over an unchanged task missed
  // with `cross-run:environment-changed`, ENV_DELTA `changed=1
  // changedKeys=[PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID]`. This is that reproduction.
  it('matches two runs that differ only in the launcher seam that started them', () => {
    const base = { PATH: '/usr/bin', LANG: 'C.UTF-8' };
    const backgroundJobOne = passingTaskVerdictCrossRunIdentityEnvironment({
      ...base,
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'bash-job-aaaaaaaa',
      PAPERCUSP_CAPABILITY_BASH_FOREGROUND: '',
      PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS: '',
      PC_HEAVY_DURABLE_CALLER: '1',
    }).environment;
    const foregroundRunLater = passingTaskVerdictCrossRunIdentityEnvironment({
      ...base,
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: '',
      PAPERCUSP_CAPABILITY_BASH_FOREGROUND: '1',
      PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS: '50000',
      PC_HEAVY_DURABLE_CALLER: '',
    }).environment;
    expect(foregroundRunLater).toEqual(backgroundJobOne);
    expect(backgroundJobOne).toEqual({});
  });

  // CONTROL. Without the strip these very inputs differ, so the assertion above is load-bearing
  // rather than vacuously true of any two environments. The PER-RUN identity keeps them on
  // purpose — it is confined to one run, where the launching seam cannot drift.
  it('control: the per-run identity still separates the same two inputs', () => {
    const base = { PATH: '/usr/bin', LANG: 'C.UTF-8' };
    const one = passingTaskVerdictIdentityEnvironment({
      ...base,
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'bash-job-aaaaaaaa',
    }).environment;
    const two = passingTaskVerdictIdentityEnvironment({
      ...base,
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'bash-job-bbbbbbbb',
    }).environment;
    expect(two).not.toEqual(one);
  });

  it('strips every listed name and never mutates the caller environment', () => {
    const environment: Record<string, string> = {
      PATH: '/usr/bin',
      ...Object.fromEntries(CAPABILITY_BASH_SEAM_IDENTITY_ENV.map((name) => [name, 'seam-state'])),
    };
    const { environment: clone } = passingTaskVerdictCrossRunIdentityEnvironment(environment);
    for (const name of CAPABILITY_BASH_SEAM_IDENTITY_ENV) {
      expect(clone).not.toHaveProperty(name);
      expect(environment[name]).toBe('seam-state');
    }
  });

  it('ignores an unlisted launcher neighbour because no inherited environment is related input', () => {
    const base = { PATH: '/usr/bin' };
    const withFlag = passingTaskVerdictCrossRunIdentityEnvironment({
      ...base,
      PAPERCUSP_CAPABILITY_BASH_SANDBOX_DISABLED: '1',
    }).environment;
    expect(withFlag).toEqual({});
  });
});

describe('closure hashing separates membership from content', () => {
  it('reports a listHash that moves with membership but not with content', () => {
    const root = mkdtempSync(join(tmpdir(), 'wi595883-closure-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'one');
      writeFileSync(join(root, 'b.txt'), 'two');
      // `hashDependencyFileSet` fails closed on any enumeration gap, so narrow before asserting
      // — an unreadable fixture must surface as its own reason, not as a confusing property error.
      const hashed = (files: string[]) => {
        const result = hashDependencyFileSet({ root, files });
        if (!result.ok) throw new Error(`expected a hashable closure, got ${result.reason}`);
        return result;
      };

      const base = hashed(['a.txt', 'b.txt']);
      expect(base.fileCount).toBe(2);
      expect(base.files).toEqual(['a.txt', 'b.txt']);

      writeFileSync(join(root, 'a.txt'), 'CHANGED');
      const contentMoved = hashed(['a.txt', 'b.txt']);
      expect(contentMoved.hash).not.toBe(base.hash);
      // The whole point: content churn must NOT look like a membership change.
      expect(contentMoved.listHash).toBe(base.listHash);

      writeFileSync(join(root, 'c.txt'), 'three');
      const membershipMoved = hashed(['a.txt', 'b.txt', 'c.txt']);
      expect(membershipMoved.listHash).not.toBe(base.listHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P-011 names this explicitly ("unrelated changes still hit") and it is the entire value
  // proposition: if an edit anywhere in the tree invalidated every task, the cache would be a
  // pure cost. The closure FILTER is what makes it true, so exercise the filter, not the hash.
  it('an edit outside the task closure does not move its proof, but one inside does', () => {
    const root = mkdtempSync(join(tmpdir(), 'wi595883-unrelated-'));
    try {
      mkdirSync(join(root, 'pkg/target'), { recursive: true });
      mkdirSync(join(root, 'pkg/unrelated'), { recursive: true });
      writeFileSync(join(root, 'pkg/target/x.ts'), 'target-one');
      writeFileSync(join(root, 'pkg/unrelated/y.ts'), 'unrelated-one');

      const provenance = () =>
        passingTaskVerdictDependencyProvenance({
          root,
          taskKey: '@target :: test',
          script: 'test',
          workspaceName: '@target',
          workspaces: new Map([
            ['@target', { dir: 'pkg/target', deps: [] }],
            ['@unrelated', { dir: 'pkg/unrelated', deps: [] }],
          ]),
          trackedScan: {
            files: ['pkg/target/x.ts', 'pkg/unrelated/y.ts'],
            unscannedPresent: [],
          },
          repoWideTaskKeys: new Set<string>(),
          // A FRESH cache per call — a shared one would return the first run's digests and make
          // this pass no matter what the filter does.
          digestCache: new Map(),
        });

      const before = provenance();
      if (!before.ok) throw new Error(`expected hashable provenance, got ${before.reason}`);
      expect(before.files).toEqual(['pkg/target/x.ts']);

      const proofIdentity = (
        dependencyHash: string,
        inheritedEnvironment: Record<string, unknown>,
      ) =>
        buildPassingTaskVerdictIdentity({
          runtimeIdentity: runtimeTuple(),
          taskKey: '@target :: test',
          command: { cmd: 'npm', argv: ['run', 'test'], cwd: '/repo/pkg/target' },
          gateConfig: passingTaskVerdictCrossRunGateConfig({ retryFailed: false }),
          dependencyHash,
          environment: passingTaskVerdictCrossRunIdentityEnvironment(inheritedEnvironment)
            .environment,
        })!;
      const storedProof = passingTaskVerdictEntry(
        proofIdentity(before.hash, {
          CODEX_SESSION_ID: 'run-a',
          PC_HEAVY_PREEMPT_EXCLUSIVE: '0',
          PATH: '/run-a/bin',
        }),
      );
      const decide = (
        dependencyHash: string,
        inheritedEnvironment: Record<string, unknown>,
      ) =>
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: { reason: 'cache-ready' },
          entry: storedProof,
          identity: proofIdentity(dependencyHash, inheritedEnvironment),
        });

      writeFileSync(join(root, 'pkg/unrelated/y.ts'), 'unrelated-CHANGED');
      const afterUnrelated = provenance();
      if (!afterUnrelated.ok) throw new Error(afterUnrelated.reason);
      expect(afterUnrelated.hash).toBe(before.hash);
      expect(
        decide(afterUnrelated.hash, {
          CODEX_SESSION_ID: 'run-b',
          SOME_FUTURE_CALLER_FLAG: 'anything',
          PATH: '/completely/different/caller/bin',
        }),
      ).toEqual({ hit: true, reason: 'identity-match' });

      // CONTROL: the same probe must still notice a change INSIDE the closure, or the assertion
      // above would hold for a filter that simply hashed nothing.
      writeFileSync(join(root, 'pkg/target/x.ts'), 'target-CHANGED');
      const afterInside = provenance();
      if (!afterInside.ok) throw new Error(afterInside.reason);
      expect(afterInside.hash).not.toBe(before.hash);
      expect(decide(afterInside.hash, {})).toEqual({
        hit: false,
        reason: 'dependency-closure-changed',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ordinary-task shared inputs are derived, narrow, and fail closed', () => {
  it('ignores unrelated root/scripts churn but binds real runner and test-config modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'wi1024071-shared-inputs-'));
    try {
      const initial = new Map<string, string>([
        ['package.json', '{"private":true}\n'],
        ['package-lock.json', '{"lockfileVersion":3}\n'],
        ['README.md', 'unrelated root doc\n'],
        ['scripts/affected-tests.mjs', "import './lib/runtime.mjs';\n"],
        ['scripts/lib/runtime.mjs', 'export const runtime = 1;\nconst child = "import schema from \'./child-only.ts\';";\n'],
        ['scripts/unrelated-maintenance.mjs', 'export const unrelated = 1;\n'],
        ['scripts/pc-heavy.sh', '#!/bin/sh\n'],
        ['libs/test-config/package.json', '{"exports":{}}\n'],
        [
          'libs/test-config/src/vitest-config.ts',
          "import { resolve } from 'node:path';\nconst setup = resolve(__dirname, 'setup.ts');\nexport { setup };\n",
        ],
        ['libs/test-config/src/setup.ts', 'export const setup = true;\n'],
        ['libs/test-config/src/lane-split.ts', 'export const lane = true;\n'],
        ['pkg/target/src/index.ts', 'target:v1\n'],
        ['pkg/dependency/src/index.ts', 'dependency:v1\n'],
        ['pkg/unrelated/src/index.ts', 'unrelated:v1\n'],
      ]);
      for (const [file, contents] of initial) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), contents);
      }
      const files = [...initial.keys()];
      const trackedScan = { files, unscannedPresent: [] as string[] };
      const shared = () => passingTaskVerdictSharedInputProvenance({ root, trackedScan });
      const sharedBefore = shared();
      if (!sharedBefore.ok) throw new Error(sharedBefore.reason);
      expect(sharedBefore.files).toContain('scripts/affected-tests.mjs');
      expect(sharedBefore.files).toContain('scripts/lib/runtime.mjs');
      expect(sharedBefore.files).toContain('libs/test-config/src/vitest-config.ts');
      expect(sharedBefore.files).toContain('libs/test-config/src/setup.ts');
      expect(sharedBefore.files).not.toContain('README.md');
      expect(sharedBefore.files).not.toContain('scripts/unrelated-maintenance.mjs');

      const workspaces = new Map([
        ['@target', { dir: 'pkg/target', deps: ['@dependency'] }],
        ['@dependency', { dir: 'pkg/dependency', deps: [] }],
        ['@unrelated', { dir: 'pkg/unrelated', deps: [] }],
      ]);
      const ordinary = () =>
        passingTaskVerdictDependencyProvenance({
          root,
          taskKey: '@target :: test',
          script: 'test',
          workspaceName: '@target',
          workspaces,
          trackedScan,
          repoWideTaskKeys: new Set<string>(),
          sharedInputProvenance: shared(),
          digestCache: new Map(),
        });
      // Calibrate an executable copy, then remove only the repaired semantic
      // inclusion. The negative control must reproduce the stale setup pass.
      const source = readFileSync(resolve(REPO_ROOT, 'scripts/lib/passing-task-verdict-cache.mjs'), 'utf8');
      const start = source.indexOf('export function passingTaskVerdictDependencyProvenance(');
      const end = source.indexOf('/** A clean first pass', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const functionSource = source.slice(start, end).replace('export function', 'function');
      const omission = 'sharedSemanticFiles.has(file) ||';
      expect(functionSource.split(omission)).toHaveLength(2);
      const evaluateCopy = (text: string) => runInNewContext(
        `${text}\npassingTaskVerdictDependencyProvenance(input)`,
        {
          input: {
            root, taskKey: '@target :: test', script: 'test', workspaceName: '@target',
            workspaces, trackedScan, repoWideTaskKeys: new Set<string>(),
            sharedInputProvenance: shared(), digestCache: new Map(),
          },
          hashDependencyFileSet,
          pathInsideDir: (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`),
        },
        { timeout: 1000 },
      );
      const repoWide = () =>
        passingTaskVerdictDependencyProvenance({
          root,
          taskKey: '@target :: lint:guard',
          script: 'lint:guard',
          workspaceName: '@target',
          workspaces,
          trackedScan,
          repoWideTaskKeys: new Set(['@target :: lint:guard']),
          sharedInputProvenance: shared(),
          digestCache: new Map(),
        });
      const before = ordinary();
      const guardBefore = repoWide();
      if (!before.ok || !guardBefore.ok) throw new Error('expected hashable fixture provenance');
      expect(evaluateCopy(functionSource).semantic.hash).toBe(before.semantic.hash);
      const mutantBefore = evaluateCopy(functionSource.replace(omission, ''));
      expect(before.semantic.files).toEqual([
        ...sharedBefore.files.filter((file) => file !== 'scripts/pc-heavy.sh'),
        'pkg/dependency/src/index.ts',
        'pkg/target/src/index.ts',
      ].sort());
      expect(before.execution?.files).toEqual(sharedBefore.files);

      const semanticIdentity = (dependencyHash: string) =>
        buildPassingTaskVerdictIdentity({
          runtimeIdentity: runtimeTuple(),
          taskKey: '@target :: test',
          command: { cmd: 'npm', argv: ['run', 'test'], cwd: '/repo/pkg/target' },
          gateConfig: passingTaskVerdictCrossRunGateConfig({ retryFailed: false }),
          dependencyHash,
          environment: passingTaskVerdictCrossRunIdentityEnvironment({
            CODEX_SESSION_ID: 'run-a',
            PATH: '/run-a/bin',
          }).environment,
        })!;
      const storedSemanticProof = passingTaskVerdictEntry(
        semanticIdentity(before.semantic.hash),
      );
      const decideSemantic = (dependencyHash: string) =>
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: { reason: 'cache-ready' },
          entry: storedSemanticProof,
          identity: semanticIdentity(dependencyHash),
        });

      writeFileSync(join(root, 'README.md'), 'unrelated root doc:changed\n');
      writeFileSync(join(root, 'scripts/unrelated-maintenance.mjs'), 'export const unrelated = 2;\n');
      writeFileSync(join(root, 'pkg/unrelated/src/index.ts'), 'unrelated:v2\n');
      const afterUnrelated = ordinary();
      const guardAfterUnrelated = repoWide();
      if (!afterUnrelated.ok || !guardAfterUnrelated.ok) throw new Error('expected hashable fixture provenance');
      expect(afterUnrelated.semantic.hash).toBe(before.semantic.hash);
      expect(afterUnrelated.execution?.hash).toBe(before.execution?.hash);
      expect(guardAfterUnrelated.semantic.hash).not.toBe(guardBefore.semantic.hash);

      writeFileSync(join(root, 'libs/test-config/src/setup.ts'), 'export const setup = false;\n');
      const afterConfig = ordinary();
      if (!afterConfig.ok) throw new Error(afterConfig.reason);
      expect(afterConfig.semantic.hash).not.toBe(before.semantic.hash);
      expect(afterConfig.execution?.hash).not.toBe(before.execution?.hash);
      expect(afterConfig.hash).not.toBe(before.hash);
      expect(decideSemantic(afterConfig.semantic.hash)).toEqual({
        hit: false,
        reason: 'dependency-closure-changed',
      });
      const mutantAfter = evaluateCopy(functionSource.replace(omission, ''));
      expect(mutantAfter.semantic.hash).toBe(mutantBefore.semantic.hash);
      expect(mutantAfter.execution.hash).not.toBe(mutantBefore.execution.hash);

      writeFileSync(
        join(root, 'libs/test-config/src/setup.ts'),
        initial.get('libs/test-config/src/setup.ts')!,
      );
      writeFileSync(join(root, 'pkg/target/src/index.ts'), 'target:v2\n');
      const afterWorkspace = ordinary();
      if (!afterWorkspace.ok) throw new Error(afterWorkspace.reason);
      expect(afterWorkspace.semantic.hash).not.toBe(before.semantic.hash);
      expect(afterWorkspace.execution?.hash).toBe(before.execution?.hash);
      expect(decideSemantic(afterWorkspace.semantic.hash)).toEqual({
        hit: false,
        reason: 'dependency-closure-changed',
      });

      writeFileSync(
        join(root, 'pkg/target/src/index.ts'),
        initial.get('pkg/target/src/index.ts')!,
      );
      writeFileSync(join(root, 'pkg/dependency/src/index.ts'), 'dependency:v2\n');
      const afterDependency = ordinary();
      if (!afterDependency.ok) throw new Error(afterDependency.reason);
      expect(afterDependency.semantic.hash).not.toBe(before.semantic.hash);
      expect(afterDependency.execution?.hash).toBe(before.execution?.hash);
      expect(decideSemantic(afterDependency.semantic.hash)).toEqual({
        hit: false,
        reason: 'dependency-closure-changed',
      });

      writeFileSync(
        join(root, 'pkg/dependency/src/index.ts'),
        initial.get('pkg/dependency/src/index.ts')!,
      );
      writeFileSync(join(root, 'scripts/lib/runtime.mjs'), 'export const runtime = 2;\n');
      const afterRunner = ordinary();
      if (!afterRunner.ok) throw new Error(afterRunner.reason);
      expect(afterRunner.semantic.hash).not.toBe(before.semantic.hash);
      expect(afterRunner.execution?.hash).not.toBe(before.execution?.hash);
      expect(afterRunner.hash).not.toBe(before.hash);
      expect(decideSemantic(afterRunner.semantic.hash)).toEqual({
        hit: false,
        reason: 'dependency-closure-changed',
      });
      writeFileSync(join(root, 'scripts/lib/runtime.mjs'), initial.get('scripts/lib/runtime.mjs')!);

      // Dependency resolution, membership and imported result interpretation are
      // semantic even though the workspace's own bytes did not change.
      for (const file of ['package-lock.json', 'package.json', 'libs/test-config/src/lane-split.ts']) {
        writeFileSync(join(root, file), `${initial.get(file)}\nsemantic-change\n`);
        const changed = ordinary();
        if (!changed.ok) throw new Error(changed.reason);
        expect(decideSemantic(changed.semantic.hash), file).toEqual({
          hit: false, reason: 'dependency-closure-changed',
        });
        writeFileSync(join(root, file), initial.get(file)!);
      }

      // The proven admission wrapper is different: scheduling churn must not
      // discard valid test-semantic proof.
      writeFileSync(join(root, 'scripts/pc-heavy.sh'), '#!/bin/sh\n# new admission policy\n');
      const afterScheduling = ordinary();
      if (!afterScheduling.ok) throw new Error(afterScheduling.reason);
      expect(afterScheduling.execution?.hash).not.toBe(before.execution?.hash);
      expect(decideSemantic(afterScheduling.semantic.hash)).toEqual({
        hit: true, reason: 'identity-match',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins the shared test-config entrypoints to the package export table', () => {
    const testConfig = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'libs/test-config/package.json'), 'utf8'),
    ) as { exports?: Record<string, { import?: string } | string> };
    const target = (key: string) => {
      const value = testConfig.exports?.[key];
      return typeof value === 'string' ? value : value?.import;
    };
    expect(PASSING_TASK_SHARED_MODULE_INPUTS).toContain(
      `libs/test-config/${target('./vitest-config')?.replace(/^\.\//, '')}`,
    );
    expect(PASSING_TASK_SHARED_MODULE_INPUTS).toContain(
      `libs/test-config/${target('./lane-split')?.replace(/^\.\//, '')}`,
    );
  });

  it('computes the derived shared-input graph once and supplies it to every task proof', () => {
    expect(AFFECTED_TESTS_SRC).toMatch(/^\s*passingTaskVerdictSharedInputProvenance,\s*$/m);
    expect(
      AFFECTED_TESTS_SRC.match(/passingTaskVerdictSharedInputProvenance\(\{/g) ?? [],
    ).toHaveLength(1);
    expect(AFFECTED_TESTS_SRC).toContain(
      'sharedInputProvenance: taskVerdictSharedInputProvenance',
    );
  });

  it('removes the selection base only from ordinary reusable child processes', () => {
    const predicateStart = AFFECTED_TESTS_SRC.indexOf(
      'function isOrdinaryReusableTask(',
    );
    expect(predicateStart).toBeGreaterThan(-1);
    const predicateEnd = AFFECTED_TESTS_SRC.indexOf('\n}', predicateStart);
    const predicate = AFFECTED_TESTS_SRC.slice(predicateStart, predicateEnd);
    expect(predicate).toContain('!taskVerdictGuardKeys.has(taskKey(t))');
    expect(predicate).toContain("t.script !== 'test:integration'");
    expect(predicate).toContain("t.script !== 'test:el-suite'");

    const childStart = AFFECTED_TESTS_SRC.indexOf('const childEnv = {');
    const childEnd = AFFECTED_TESTS_SRC.indexOf('let cacheIdentity = null;', childStart);
    const childSetup = AFFECTED_TESTS_SRC.slice(childStart, childEnd);
    expect(childSetup).toContain('if (isOrdinaryReusableTask(context.t))');
    expect(childSetup).toContain('delete childEnv.AFFECTED_BASE;');
  });

  it('pins forwarded base refs to commits and refuses reuse when a required base cannot resolve', () => {
    expect(AFFECTED_TESTS_SRC).toContain(
      "gitTry(['rev-parse', '--verify', '--quiet', `${explicitBase}^{commit}`])",
    );
    expect(AFFECTED_TESTS_SRC).toContain(
      'guardBaseResolved: repoWideGuardBaseSha != null',
    );
    expect(AFFECTED_TESTS_SRC).toContain(
      'provenance-incomplete:affected-base-unresolved',
    );
  });
});

describe('a cache miss explains itself', () => {
  const manifest = (
    files: Record<string, string>,
    tasks: Record<string, { fileCount: number; listHash: string }> = {},
  ) => ({
    ...emptyClosureDigestManifest(),
    files,
    tasks,
  });

  it('names the path whose digest moved', () => {
    const delta = diffClosureDigests({
      prior: manifest({ 'scripts/a.mjs': 'file:420:aaa', 'scripts/b.mjs': 'file:420:bbb' }),
      observed: { 'scripts/a.mjs': 'file:420:aaa', 'scripts/b.mjs': 'file:420:MOVED' },
      files: ['scripts/a.mjs', 'scripts/b.mjs'],
    });
    expect(delta.changed).toEqual(['scripts/b.mjs']);
    expect(delta.changedCount).toBe(1);
    expect(delta.unexplained).toBe(false);
  });

  // The reading that no aggregate hash can produce, and the one WI-595883 was filed to test:
  // the hash moved while every file it covers is byte-, mode- and membership-identical.
  it('reports unexplained when every observed file is identical', () => {
    const files = { 'scripts/a.mjs': 'file:420:aaa' };
    const delta = diffClosureDigests({
      prior: manifest(files, { 'ws :: test': { fileCount: 1, listHash: 'L1' } }),
      observed: files,
      files: ['scripts/a.mjs'],
      listHash: 'L1',
      taskKey: 'ws :: test',
    });
    expect(delta.unexplained).toBe(true);
    expect(delta.membershipChanged).toBe(false);
    expect(delta.changedCount).toBe(0);
  });

  it('reports a membership change instead of blaming file contents', () => {
    const delta = diffClosureDigests({
      prior: manifest(
        { 'scripts/a.mjs': 'file:420:aaa' },
        { 'ws :: test': { fileCount: 1, listHash: 'L1' } },
      ),
      observed: { 'scripts/a.mjs': 'file:420:aaa', 'scripts/new.mjs': 'file:420:nnn' },
      files: ['scripts/a.mjs', 'scripts/new.mjs'],
      listHash: 'L2',
      taskKey: 'ws :: test',
    });
    expect(delta.membershipChanged).toBe(true);
    expect(delta.priorFileCount).toBe(1);
    expect(delta.unexplained).toBe(false);
  });

  // A path the sidecar never observed is not evidence that it moved.
  it('separates never-observed paths from changed ones', () => {
    const delta = diffClosureDigests({
      prior: manifest({ 'scripts/a.mjs': 'file:420:aaa' }),
      observed: { 'scripts/a.mjs': 'file:420:aaa', 'scripts/fresh.mjs': 'file:420:fff' },
      files: ['scripts/a.mjs', 'scripts/fresh.mjs'],
    });
    expect(delta.changedCount).toBe(0);
    expect(delta.unknownPrior).toEqual(['scripts/fresh.mjs']);
  });

  it('names the environment variable that moved, and classifies added and removed', () => {
    const delta = diffIdentityEnvDigests({
      prior: { PATH: 'p1', LANG: 'l1', GONE: 'g1' },
      observed: { PATH: 'CHANGED', LANG: 'l1', FRESH: 'f1' },
    });
    expect(delta.changedKeys).toEqual(['PATH']);
    expect(delta.addedKeys).toEqual(['FRESH']);
    expect(delta.removedKeys).toEqual(['GONE']);
    expect(delta.unexplained).toBe(false);
  });

  it('says so when no prior environment was ever recorded', () => {
    const delta = diffIdentityEnvDigests({ prior: undefined, observed: { PATH: 'p1' } });
    expect(delta.known).toBe(false);
    expect(delta.unexplained).toBe(false);
  });

  // This environment carries live credentials. Nothing but a digest may reach the sidecar, and
  // the reported line is keys-only. (The fixture is deliberately NOT key-shaped: a realistic
  // token literal in a tree file trips the secrets guard and the publish guard.)
  it('never records a raw environment value', () => {
    const secret = 'REDACTED-FIXTURE-VALUE-MUST-NOT-BE-STORED';
    const digests = identityEnvDigests({ ANTHROPIC_API_KEY: secret, PATH: '/usr/bin' });
    expect(JSON.stringify(digests)).not.toContain(secret);
    expect(digests.ANTHROPIC_API_KEY).toMatch(/^[0-9a-f]{16}$/);
    const line = formatIdentityEnvDeltaLine({
      taskKey: 'ws :: test',
      reason: 'cross-run:environment-changed',
      manifestReason: 'manifest-ready',
      delta: diffIdentityEnvDigests({
        prior: { ANTHROPIC_API_KEY: 'old-digest' },
        observed: digests,
      }),
    });
    expect(line).toContain('ANTHROPIC_API_KEY');
    expect(line).not.toContain(secret);
  });

  it('distinguishes an identical value from a differing one of the same type', () => {
    expect(identityEnvDigests({ A: 'x' }).A).toBe(identityEnvDigests({ A: 'x' }).A);
    expect(identityEnvDigests({ A: 'x' }).A).not.toBe(identityEnvDigests({ A: 'y' }).A);
  });
});

describe('the closure sidecar fails open and keeps prior observations', () => {
  it('retains files this run did not observe', () => {
    const merged = mergeClosureDigestManifest({
      prior: { ...emptyClosureDigestManifest(), files: { 'old.mjs': 'file:420:old' } },
      observed: { 'new.mjs': 'file:420:new' },
      taskShapes: { 'ws :: test': { fileCount: 2, listHash: 'L1' } },
      identityEnv: { 'cross-run-v1': { PATH: 'p1' } },
    });
    expect(merged.files).toEqual({ 'old.mjs': 'file:420:old', 'new.mjs': 'file:420:new' });
    expect(merged.tasks['ws :: test']).toEqual({ fileCount: 2, listHash: 'L1' });
    expect(merged.identityEnv['cross-run-v1']).toEqual({ PATH: 'p1' });
  });

  it('evicts unobserved paths first when capped', () => {
    const merged = mergeClosureDigestManifest({
      prior: { ...emptyClosureDigestManifest(), files: { stale: 'file:420:s' } },
      observed: { fresh: 'file:420:f' },
      cap: 1,
    });
    expect(Object.keys(merged.files)).toEqual(['fresh']);
  });

  // A sidecar can only ever improve an error message, so every failure mode must be inert.
  it.each([
    ['missing', undefined, 'manifest-missing'],
    ['corrupt', 'not json', 'manifest-corrupt'],
    ['version-skewed', JSON.stringify({ version: 999, files: {} }), 'manifest-unusable'],
    ['shape-invalid', JSON.stringify({ version: 1, files: [] }), 'manifest-unusable'],
  ])('reads a %s sidecar as an empty manifest', (_label, body, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'wi595883-sidecar-'));
    try {
      const path = join(dir, 'manifest.json');
      if (body !== undefined) writeFileSync(path, body as string);
      const { manifest: read, reason } = readClosureDigestManifest(path);
      expect(reason).toBe(expected);
      expect(read.files).toEqual({});
      expect(read.identityEnv).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the sidecar beside the cache rather than inside an entry', () => {
    expect(closureDigestManifestPath('/tmp/verdicts.json')).toBe(
      '/tmp/verdicts.json.closure-manifest.json',
    );
  });
});

describe('affected-tests wires the miss diagnostics in', () => {
  // The pure helpers above are worthless if the runner never calls them, and the runner is not
  // importable from a unit test — so pin the call sites the same way this file already pins
  // D-007's script table.
  it.each([
    'reportClosureDeltaForMiss(context, cacheDecision)',
    'formatClosureDeltaLine(',
    'formatIdentityEnvDeltaLine(',
    'mergeClosureDigestManifest({',
    'identityEnvDigests(crossRunEnvironment)',
  ])('calls %s', (fragment) => {
    expect(AFFECTED_TESTS_SRC).toContain(fragment.replaceAll('"', "'"));
  });
});

// DEFECT-1 REGRESSION GUARD (the other half of what made cross-run reuse inert).
//
// `defineVitestConfig` sets `cacheDir: '.vitest-tmp'`, and `.vitest-tmp/vitest/<hash>/results.json`
// records a per-run `duration`. When that file is TRACKED it sits in the affected-tests dependency
// closure and changes on EVERY run, so the closure hash — the one component the whole cache's
// validity rests on — moved on its own and reuse could never hit.
//
// It survived a long time because the SUPERPROJECT .gitignore does cover `.vitest-tmp/`, and a
// superproject ignore DOES NOT REACH INSIDE A SUBMODULE. Seven submodules tracked the file.
describe('vitest cache artifacts stay out of the dependency closure', () => {
  const tracked = (pathspec: string) =>
    execFileSync('git', ['ls-files', '--recurse-submodules', '--', pathspec], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // A sync spawn blocks the worker's event loop, so vitest cannot time it out,
      // and the pure lane shares one fork across ~2,740 files — an unbounded call
      // here wedges every one of them until the batch watchdog fires 45 min later
      // (WI-41180). `--recurse-submodules` walks seven submodules, so this is a
      // realistic staller under fleet load, not a theoretical one.
      timeout: 120_000,
      killSignal: 'SIGKILL',
    })
      .split('\n')
      .filter(Boolean);

  it('tracks no .vitest-tmp artifact in the superproject or any submodule', (ctx) => {
    // POSITIVE CONTROL FIRST. A zero-row answer is only evidence of absence if the instrument can
    // still see inside submodules — an uninitialised checkout, or a git that quietly stopped
    // recursing, would otherwise report a clean tree by failing to look. Without this the guard's
    // green is indistinguishable from its blindness.
    const control = tracked('*libs/generic/rrf/src/*.ts');
    if (control.length === 0) {
      ctx.skip(
        'submodule contents are not enumerable in this checkout — the guard cannot answer here, ' +
          'and reporting green would assert an absence it never measured',
      );
      return;
    }
    expect(tracked('*.vitest-tmp/*')).toEqual([]);
  });
});

// WI-10003603: affected-tests stamps a per-run result-file path for the executed-source-map
// reporter. It is an output channel; hashing it would make a frozen-repair verifier's per-run
// identity miss against the original gate run's proof on the path alone.
describe('per-run identity ignores reporter output channels', () => {
  it.each(['PC_EXECUTED_SOURCE_MAP_RESULT', 'PAPERCUSP_TEST_FAILURE_DETAILS_PATH'])(
    'two runs differing only in %s share one identity environment', (channel) => {
    const base = { PAPERCUSP_TEST_RUN_GROUP: 'g', NODE_ENV: 'test' };
    const a = passingTaskVerdictIdentityEnvironment({ ...base, [channel]: '/tmp/x/run-1.jsonl' });
    const b = passingTaskVerdictIdentityEnvironment({ ...base, [channel]: '/tmp/x/run-2.jsonl' });
    expect(a.environment).toEqual(b.environment);
    expect(a.environment).not.toHaveProperty(channel);
    // The task's real inputs are still hashed.
    expect(a.environment).toMatchObject(base);
  });
});
