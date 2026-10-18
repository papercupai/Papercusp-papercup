/**
 * scripts/source-preview.mjs export — plan dhh-source-preview-2026-09-28 R-1/R-3/R-4
 * (P-001, P-002).
 *
 * The preview must be the SAME public-safe cut the desktop installer ships
 * (sidecar/source.tar.zst), minus node_modules — not a second, hand-kept list.
 * The parity case proves that by running the shared selection library in its
 * INSTALLER mode over the same clean tree and comparing file sets, so a future
 * edit that forks the two selections fails here.
 *
 * Every case drives a synthetic superproject under tmpdir; nothing touches the
 * shared checkout.
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, promises as fsPromises, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ADDED_FILES,
  SELECTION_LIB,
  TAURI_VERIFIER_INPUTS,
  allowlistTops,
  exportSnapshot,
  loadReleaseHost,
  materializeCommit,
  measureVerifierSourceBytes,
  prepareVerifierSource,
  prepareVerifierDependencies,
  runVerifierDependencyCommand,
  captureVerifierDependencies,
  runVerifierCommand,
  verifierCommandAdmissionEnv,
  readVerifierPhaseMeasurements,
  estimateVerifierCommandBudget,
  admitVerifierCommandBudget,
  validateVerifierInputs,
  runCli,
  verifyVerifierSource,
  verifierSourceChildEnv,
  releasesPageUrl,
  sourceYear,
} from '../../../scripts/source-preview.mjs';
import { DROPPED, INTERNAL_DOC_CONTENTS, SHIPPED, childEnv, git, makeSuperproject, write, type Superproject } from './source-preview.fixture';
import { captureTestSourceSnapshot } from './testing-worktree';
import { cleanupEndedVerifierDirectories, verifierSourceFiles, writeVerifierTaskReceipt } from './verifier-source';
import { closeTask } from './task-manager/store';
import type { TaskRow } from './task-manager/types';

let tmp: string;
let fx: Superproject;
let out: string;

describe('verifier command disclosure admission', () => {
  const marker = 'PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT';

  it('admits in the caller checkout and transports the actual verdict without changing the caller environment', () => {
    const env = { PATH: '/fixture/bin', DATABASE_URL: 'postgresql://fixture.invalid/application' };
    const preflight = vi.fn(() => ({ verdict: 'admit' as const }));
    const child = verifierCommandAdmissionEnv({ repo: '/caller/checkout', env, preflight });
    expect(preflight).toHaveBeenCalledExactlyOnceWith({ roots: ['/caller/checkout'], env });
    expect(child).toEqual({ ...env, [marker]: 'admitted-by-test-router' });
    expect(env).not.toHaveProperty(marker);
    expect(child).not.toHaveProperty('HARNESS_ADMIN_DATABASE_URL');
  });

  it.each(['restricted_write_held', 'restricted_hold_state_unknown'])(
    'refuses %s before source preparation and never creates an admission marker', (error) => {
      const env = { PATH: '/fixture/bin' };
      const preflight = vi.fn(() => ({ verdict: 'refuse' as const, error, hint: 'nothing may start' }));
      expect(() => verifierCommandAdmissionEnv({ repo: '/caller/checkout', env, preflight }))
        .toThrow(expect.objectContaining({ exitCode: 3, message: expect.stringContaining(error) }));
      expect(env).not.toHaveProperty(marker);
    },
  );

  it('preserves upstream admission but does not turn a test-runner skip into a new admission', () => {
    const preflight = vi.fn(() => ({ verdict: 'skipped', reason: 'nested-in-test-runner' } as const));
    expect(verifierCommandAdmissionEnv({ repo: '/caller/checkout', env: { VITEST: '1' }, preflight }))
      .toEqual({ VITEST: '1' });
    const upstream = { [marker]: 'admitted-by-testing-run' };
    expect(verifierCommandAdmissionEnv({ repo: '/caller/checkout', env: upstream,
      preflight: () => ({ verdict: 'skipped', reason: 'testing-run' }) })).toEqual(upstream);
  });

  it('keeps the caller database available after freezing excludes its local config', () => {
    const repo = mkdtempSync(join(tmpdir(), 'verifier-control-plane-'));
    try {
      write(repo, 'apps/operator/.env.local',
        'DATABASE_URL=postgresql://fixture.invalid/caller-control-plane\nUNRELATED_SECRET=must-not-forward\n');
      const env = { PATH: '/fixture/bin' };
      const child = verifierCommandAdmissionEnv({ repo, env, preflight: () => ({ verdict: 'admit' }) });
      rmSync(join(repo, 'apps/operator/.env.local'));
      expect(child.DATABASE_URL).toBe('postgresql://fixture.invalid/caller-control-plane');
      expect(child[marker]).toBe('admitted-by-test-router');
      expect(child).not.toHaveProperty('UNRELATED_SECRET');
      expect(env).toEqual({ PATH: '/fixture/bin' });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it.each(['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'])(
    'preserves an explicit %s instead of importing a higher-priority local pin', (key) => {
      const repo = mkdtempSync(join(tmpdir(), 'verifier-control-plane-pin-'));
      try {
        write(repo, 'apps/operator/.env.local', 'HARNESS_ADMIN_DATABASE_URL=postgresql://fixture.invalid/local\n');
        const env = { [key]: 'postgresql://fixture.invalid/explicit' };
        const child = verifierCommandAdmissionEnv({ repo, env,
          preflight: () => ({ verdict: 'skipped', reason: 'nested-in-test-runner' }) });
        expect(child).toEqual(env);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  );

  it.each([{ PAPERCUSP_PG_PORT: '54321' }, { PAPERCUSP_SKIP_PG_DISCOVERY: '1' }])(
    'keeps isolated PG selection %j away from caller database credentials', (env) => {
      const repo = mkdtempSync(join(tmpdir(), 'verifier-control-plane-isolation-'));
      try {
        write(repo, 'apps/operator/.env.local', 'DATABASE_URL=postgresql://fixture.invalid/live\n');
        const child = verifierCommandAdmissionEnv({ repo, env,
          preflight: () => ({ verdict: 'skipped', reason: 'nested-in-test-runner' }) });
        expect(child).toEqual(env);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  );
});
let manifest: Awaited<ReturnType<typeof exportSnapshot>>['manifest'];

const NATIVE_RUNTIME_FILES = [
  'papercusp-desktop/src-tauri/sidecar.lock',
  'papercusp-desktop/src-tauri/gen/schemas/acl-manifests.json',
  'papercusp-desktop/src-tauri/gen/schemas/capabilities.json',
  'papercusp-desktop/src-tauri/gen/schemas/desktop-schema.json',
  'papercusp-desktop/src-tauri/gen/schemas/linux-schema.json',
  'papercusp-desktop/src-tauri/sidecar/PLACEHOLDER-README.txt',
  'papercusp-desktop/src-tauri/sidecar/db-sql/PLACEHOLDER-README.txt',
  'papercusp-desktop/src-tauri/sidecar/spa/PLACEHOLDER-README.txt',
  'papercusp-desktop/src-tauri/seed/PLACEHOLDER-README.txt',
  'papercusp-desktop/src-tauri/doc-vector-seed/PLACEHOLDER-README.txt',
];

const VITEST_RESULT_CACHE = 'packages/operator-core/.vitest-tmp/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json';
// Outputs of apps/operator-vite's maintained prebuild, including both ORT roots.
const SPA_RUNTIME_FILES = [
  'apps/operator/public/wake-runtime/ort.bundle.min.mjs',
  'apps/operator/public/vad-runtime/ort-wasm-simd-threaded.wasm',
  'apps/operator/public/vditor/dist/index.js',
  'apps/operator/public/vditor-local/d3.min.js',
  'apps/operator/public/monaco/.version',
  'apps/operator/public/excalidraw/chunk-6U3AYISY.js',
  'apps/operator/public/porcupine/porcupine_params.pv',
  'apps/operator/public/elevenlabs-runtime/rawAudioProcessor.js',
  'apps/operator/public/silero_vad_v5.onnx',
  'apps/operator/public/silero_vad_legacy.onnx',
  'apps/operator/public/vad.worklet.bundle.min.js',
  'apps/operator/public/ort-wasm-simd-threaded.wasm',
  'apps/operator/public/ort-wasm-simd-threaded.jsep.mjs',
];
const DEPENDENCY_POLICY_PATH = 'apps/operator/bin/release/dependency-generation.sh';
const DEPENDENCY_POLICY = readFileSync(new URL('../../../' + DEPENDENCY_POLICY_PATH, import.meta.url), 'utf8');

/** Real private loader closure; no links back to the checkout's dependencies. */
function installVerifierTsx(root: string): void {
  const installed = new Set<string>();
  const copy = (name: string, requireFrom: NodeJS.Require) => {
    if (installed.has(name)) return;
    let manifestPath: string;
    try { manifestPath = requireFrom.resolve(name + '/package.json'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      let dir = dirname(requireFrom.resolve(name));
      while (!existsSync(join(dir, 'package.json'))) {
        const parent = dirname(dir);
        if (parent === dir) throw new Error('package root missing: ' + name);
        dir = parent;
      }
      manifestPath = join(dir, 'package.json');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.name).toBe(name);
    installed.add(name);
    cpSync(dirname(manifestPath), join(root, 'node_modules', name), { recursive: true, dereference: true });
    const localRequire = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copy(dependency, localRequire);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try { localRequire.resolve(dependency + '/package.json'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
      copy(dependency, localRequire);
    }
  };
  copy('tsx', createRequire(import.meta.url));
}

function listFiles(dir: string): string[] {
  const acc: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else acc.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return acc.sort();
}

/** What the INSTALLER selection would put in source.tar.zst for the same clean tree. */
function installerListing(mono: string): string[] {
  const r = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    '. "$1"',
    'source_tree_selection "$(dirname "$1")/.." "$2" installer',
    'tar "${SELECTION_EXCLUDES[@]}" -C "$2" -cf - "${SELECTION_INCLUDES[@]}" | tar -tf -',
  ].join('\n'), '_', SELECTION_LIB, mono], { encoding: 'utf8', env: childEnv(), maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, '')).sort();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-export-test-'));
  fx = makeSuperproject(tmp);
  out = join(tmp, 'export');
  ({ manifest } = await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out, env: childEnv() }));
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('source-preview export — R-1 selection parity with the installer cut', () => {
  it('ships every selected tracked file, including the submodule contents', () => {
    const files = listFiles(out);
    for (const p of SHIPPED) expect(files, p).toContain(p);
  });

  it('drops every excluded class, node_modules at any depth, and all git metadata', () => {
    const files = listFiles(out);
    for (const p of DROPPED) expect(files, p).not.toContain(p);
    expect(files.filter((f) => f.split('/').includes('node_modules'))).toEqual([]);
    expect(files.filter((f) => f.split('/').includes('.git'))).toEqual([]);
  });

  it('retains the exact eligible bytes from both internal documentation roots', () => {
    for (const [path, body] of Object.entries(INTERNAL_DOC_CONTENTS)) {
      expect(readFileSync(join(out, path), 'utf8'), path).toBe(body);
    }
  });

  it('equals the installer selection over the same clean commit, minus node_modules', () => {
    const mono = join(tmp, 'parity-mono');
    rmSync(mono, { recursive: true, force: true });
    spawnSync('mkdir', ['-p', mono]);
    materializeCommit({ repo: fx.repo, sha: fx.commit, dest: mono, allow: allowlistTops() });
    const installer = installerListing(mono).filter((f) => !f.split('/').includes('node_modules'));
    const preview = listFiles(out).filter((f) => !ADDED_FILES.includes(f));
    expect(preview).toEqual(installer);
    // The comparison is only meaningful if the installer side really shipped node_modules.
    expect(installerListing(mono)).toContain('node_modules/leftpad/index.js');
    for (const path of Object.keys(INTERNAL_DOC_CONTENTS)) expect(installer, path).toContain(path);
    expect(installer).not.toContain('libs/papercusp/plugins/gitnexus-bridge/index.ts');
    expect(installer).toContain('libs/papercusp/plugins/markdown-preview/papercusp.json');
  });
});

describe('verifier dependency staging preparation boundary', () => {
  function fixture(recordedStaging?: string) {
    const dest = mkdtempSync(join(tmp, 'dependency-staging-'));
    write(dest, 'input.mjs', 'export default 1;\n');
    // The no-op models a completed helper that incorrectly left staging behind.
    write(dest, 'papercusp-desktop/bin/lib/pinned-deps.sh', '#!/bin/bash\nexit 0\n');
    if (recordedStaging) write(dest, recordedStaging + '/source.mjs', 'recorded source');
    const files = verifierSourceFiles(dest);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40), submodules: [],
      testedInputs: [{ path: 'input.mjs', sha256: files.find(file => file.path === 'input.mjs')!.sha256 }], files };
    write(dest, '.verifier-source.json', JSON.stringify(receipt));
    return { dest, receipt };
  }

  it.each(['node_modules.pinned-deps-tmp', 'node_modules.pinned-deps-tmp.12345',
    'apps/operator/node_modules.pinned-deps-tmp.12345'])(
    'retains strict source/runtime verification outside preparation for %s, including empty staging', async staging => {
      const { dest, receipt } = fixture();
      await fsPromises.mkdir(join(dest, staging), { recursive: true });
      for (const options of [{}, { runtimeArtifacts: true }])
        await expect(verifyVerifierSource(dest, receipt, options)).rejects.toThrow('unexpected dependency staging');
      await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true, dependencyStaging: true }))
        .resolves.toEqual(receipt);
      write(dest, staging + '/partial', 'retained bytes');
      await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true }))
        .rejects.toThrow('unexpected dependency staging');
    },
  );

  it.each(['node_modules.pinned-deps-tmp.0', 'node_modules.pinned-deps-tmp.0123',
    'node_modules.pinned-deps-tmp.-1', 'node_modules.pinned-deps-tmp.123.tmp',
    'node_modules.pinned-deps-tmp-other'])(
    'rejects the empty staging lookalike %s before the helper', async staging => {
      const { dest, receipt } = fixture();
      await fsPromises.mkdir(join(dest, staging));
      const phases: string[] = [];
      await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
        runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
        .rejects.toThrow('invalid dependency staging name');
      expect(phases).toEqual(['deps.source.before']);
      expect(existsSync(join(dest, staging))).toBe(true);
    },
  );

  it.each(['symlink', 'dangling-link', 'file', 'ambiguous-pids', 'ambiguous-stable', 'redirected-parent'])(
    'rejects %s before helper execution without removing retained evidence', async defect => {
      const { dest, receipt } = fixture();
      const staging = join(dest, 'node_modules.pinned-deps-tmp.12345');
      if (defect === 'symlink') symlinkSync('.', staging);
      else if (defect === 'dangling-link') symlinkSync('absent', staging);
      else if (defect === 'file') writeFileSync(staging, 'retained bytes');
      else if (defect === 'redirected-parent') {
        const external = mkdtempSync(join(tmp, 'redirected-staging-'));
        write(external, 'node_modules.pinned-deps-tmp/partial', 'external bytes');
        symlinkSync(external, join(dest, 'app'));
      } else {
        await fsPromises.mkdir(staging);
        await fsPromises.mkdir(join(dest, defect === 'ambiguous-pids'
          ? 'node_modules.pinned-deps-tmp.67890' : 'node_modules.pinned-deps-tmp'));
      }
      const before = readdirSync(dest).sort();
      const phases: string[] = [];
      await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
        runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
        .rejects.toThrow(/dependency staging|symlink escapes source root/);
      expect(phases).toEqual(['deps.source.before']);
      expect(readdirSync(dest).sort()).toEqual(before);
    },
  );

  it.each(['input.mjs', 'node_modules.pinned-deps-tmp/source.mjs',
    'node_modules.pinned-deps-tmp.12345/source.mjs', 'apps/operator/node_modules.pinned-deps-tmp/source.mjs'])(
    'never exempts changed recorded source at %s', async input => {
      const { dest, receipt } = fixture(input === 'input.mjs' ? undefined : dirname(input));
      write(dest, input, 'changed recorded source');
      if (input === 'input.mjs') write(dest, 'node_modules.pinned-deps-tmp/partial', 'retained bytes');
      const phases: string[] = [];
      await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
        runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
        .rejects.toThrow('changed ' + input);
      expect(phases).toEqual(['deps.source.before']);
    },
  );

  it('rejects unfinished empty staging after the helper and before any invoked Node command', async () => {
    const { dest, receipt } = fixture();
    await fsPromises.mkdir(join(dest, 'node_modules.pinned-deps-tmp'));
    const phases: string[] = [];
    await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
      runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
      .rejects.toThrow('unexpected dependency staging');
    expect(phases).toEqual(['deps.source.before', 'deps.snapshot', 'deps.source.after-snapshot']);
    expect(existsSync(join(dest, 'node_modules.pinned-deps-tmp'))).toBe(true);
  });
});

describe('EI-25303741091409100 — pinned verifier source identity', () => {
  const budgetPhases = { 'source.freeze': 103_607, 'receipt.write': 377,
    'deps.source.before': 11_836, 'deps.snapshot': 140_626, 'deps.source.after-snapshot': 22_222,
    'deps.inputs': 212, 'deps.measure': 3_197, 'deps.source.after-preflight': 9_789,
    'deps.census': 556_985, 'deps.receipt.write': 2_778 };

  it('reserves at least two minutes and exposes the absolute child cutoff even without history', () => {
    expect(() => admitVerifierCommandBudget(null, { nowMs: 1_000,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '121000' } })).toThrow('TASK_DEADLINE_REFUSAL');
    expect(admitVerifierCommandBudget(null, { nowMs: 1_000,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '121001' } })).toMatchObject({
      cleanupReserveMs: 120_000, childCutoffEpochMs: 1_001,
    });
    expect(admitVerifierCommandBudget(null, { nowMs: 1_000, env: {} }))
      .toMatchObject({ deadlineEpochMs: null, childCutoffEpochMs: null, cleanupReserveMs: 120_000 });
    const small = Object.fromEntries(Object.keys(budgetPhases).map(phase => [phase, 1]));
    expect(estimateVerifierCommandBudget(small).cleanupMs).toBe(120_000);
    expect(estimateVerifierCommandBudget({ ...small, cleanup: 180_000 }).cleanupMs).toBe(180_000);
    expect(estimateVerifierCommandBudget({ ...small, 'source.freeze': 190_000 }).cleanupMs).toBe(190_000);
    expect(estimateVerifierCommandBudget({ ...small, 'deps.snapshot': 200_000 }).cleanupMs).toBe(200_000);
  });

  it('refuses a 900-second envelope from measured phases before preparation and reserves the full final census', () => {
    const estimate = estimateVerifierCommandBudget(budgetPhases, 60_000);
    expect(estimate).toMatchObject({ dependencyCheckMs: 556_985, sourceCheckMs: 22_222,
      cleanupMs: 140_626, childEstimateMs: 60_000, unknownChild: false });
    expect(estimate.totalMs).toBeGreaterThan(900_000);
    expect(() => admitVerifierCommandBudget(estimate, { nowMs: 1_000, preparation: true,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '901000' } })).toThrow('TASK_DEADLINE_REFUSAL');
    expect(() => admitVerifierCommandBudget(estimate, { nowMs: 1_000,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '49368' } })).toThrow('TASK_DEADLINE_REFUSAL');
    expect(admitVerifierCommandBudget(estimate, { nowMs: 1_000, env: {} }).deadlineEpochMs).toBeNull();
    expect(admitVerifierCommandBudget(estimate, { nowMs: 1_000, preparation: true,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(estimate.totalMs + 1_001) } }).knownEstimateMs).toBe(estimate.totalMs);
    expect(estimateVerifierCommandBudget(budgetPhases).unknownChild).toBe(true);
  });

  it('does not count failed or unfinished phase records as completed budget observations', () => {
    const path = join(tmp, 'verifier-budget-history.jsonl');
    const rows = [
      { phase: 'deps.census', event: 'started', elapsedMs: 0 },
      { phase: 'deps.census', event: 'failed', elapsedMs: 15, durationMs: 15 },
      { phase: 'child.preflight', event: 'started', elapsedMs: 16 },
    ].map((row, index) => ({ schemaVersion: 'verifier-phase-v1', sequence: index + 1, ...row }));
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n'));
    expect(readVerifierPhaseMeasurements(path)).toEqual({});
    expect(() => estimateVerifierCommandBudget(readVerifierPhaseMeasurements(path)))
      .toThrow('requires completed phase');
    writeFileSync(path, JSON.stringify({ ...rows[0], sequence: 9 }));
    expect(() => readVerifierPhaseMeasurements(path)).toThrow('Invalid verifier phase budget receipt');
  });

  it('transports a complete list beyond the argv/env limit through file and piped stdout receipts', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-large-list-fixture'));
    const paths = Array.from({ length: 2000 }, (_, i) =>
      `apps/operator/acceptance/${String(i).padStart(4, '0')}-${'x'.repeat(70)}.ts`);
    paths.push('apps/operator/acceptance/space and,comma.ts');
    for (const path of paths) write(fixture.repo, path, `// ${path}\n`);
    git(fixture.repo, ['add', 'apps/operator/acceptance']);
    git(fixture.repo, ['commit', '-qm', 'large complete verifier list']);
    const sha = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const inputsFile = join(tmp, 'verifier-large-inputs.json');
    const serialized = JSON.stringify(paths);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(128 * 1024);
    writeFileSync(inputsFile, serialized);
    const dest = join(tmp, 'verifier-large-export');
    const receiptFile = join(tmp, 'verifier-large-receipt.json');
    const tooling = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const result = spawnSync(process.execPath, [join(__dirname, '../../../scripts/source-preview.mjs'),
      'verifier-prepare', '--repo', fixture.repo, '--ref', sha, '--out', dest,
      '--inputs', tooling, '--inputs-file', inputsFile, '--receipt', receiptFile],
    { encoding: 'utf8', env: childEnv(), timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt.sourceCommit).toBe(sha);
    expect(receipt.submodules.length).toBeGreaterThan(0);
    expect(receipt.testedInputs).toEqual([...paths, tooling].sort().map((path) => ({ path,
      sha256: createHash('sha256').update(readFileSync(join(fixture.repo, path))).digest('hex') })));
    expect(statSync(receiptFile).mode & 0o777).toBe(0o600);
    const expected = await validateVerifierInputs({ repo: fixture.repo, ref: sha,
      inputs: [tooling], inputsFile });
    const checked = spawnSync(process.execPath, [join(__dirname, '../../../scripts/source-preview.mjs'),
      'verifier-inputs-check', '--repo', fixture.repo, '--ref', sha,
      '--inputs', tooling, '--inputs-file', inputsFile],
    { encoding: 'utf8', env: childEnv(), timeout: 60_000, maxBuffer: 1024 * 1024 });
    expect(checked.status, checked.stderr).toBe(0);
    const expectedText = `${JSON.stringify(expected)}\n`;
    expect(Buffer.byteLength(checked.stdout)).toBe(Buffer.byteLength(expectedText));
    expect(JSON.parse(checked.stdout)).toEqual(expected);
  }, 120_000);

  it('flushes a large CLI rejection to piped stderr before preserving exit code 2', () => {
    const inputsFile = join(tmp, 'verifier-large-invalid-inputs.json');
    const invalid = `../${'x'.repeat(200_000)}`;
    writeFileSync(inputsFile, JSON.stringify([invalid]));
    const priorOptions = process.env.NODE_OPTIONS, priorPath = process.env.NODE_PATH;
    let env: NodeJS.ProcessEnv;
    try {
      // A runner's inherited loader must neither add stderr nor substitute the
      // CLI being tested. A missing loader makes contamination fail decisively.
      process.env.NODE_OPTIONS = '--import=/nonexistent/source-preview-test-loader.mjs';
      process.env.NODE_PATH = '/nonexistent/source-preview-test-dependencies';
      env = childEnv();
    } finally {
      if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = priorOptions;
      if (priorPath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = priorPath;
    }
    const result = spawnSync(process.execPath, [join(__dirname, '../../../scripts/source-preview.mjs'),
      'verifier-inputs-check', '--repo', fx.repo, '--ref', fx.commit, '--inputs-file', inputsFile],
    { encoding: 'utf8', env, timeout: 60_000, maxBuffer: 1024 * 1024 });
    expect(result.status).toBe(2);
    const expected = `ERROR: invalid tested input: ${invalid}\n`;
    expect(Buffer.byteLength(result.stderr)).toBe(Buffer.byteLength(expected));
    expect(createHash('sha256').update(result.stderr).digest('hex'))
      .toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it.each(['', '{bad', '{}', '[]', '[null]', '["../outside"]', '[""]'])
    ('refuses malformed or empty input files before exporting (%s)', async (body) => {
      const inputsFile = join(tmp, 'verifier-invalid-inputs.json');
      const dest = join(tmp, 'verifier-invalid-export');
      writeFileSync(inputsFile, body);
      await expect(prepareVerifierSource({ repo: fx.repo, ref: fx.commit, dest,
        inputs: [SHIPPED[0]], inputsFile })).rejects.toThrow();
      expect(existsSync(dest)).toBe(false);
    });

  it('refuses an absent input file rather than using only the mandatory inputs', async () => {
    const dest = join(tmp, 'verifier-absent-input-file-export');
    await expect(prepareVerifierSource({ repo: fx.repo, ref: fx.commit, dest,
      inputs: [SHIPPED[0]], inputsFile: join(tmp, 'does-not-exist.json') })).rejects.toThrow(/ENOENT/);
    expect(existsSync(dest)).toBe(false);
  });

  it.each([{ tail: [] }, { tail: ['--receipt', 'receipt.json'] }])
    ('refuses a missing --inputs-file value despite valid CSV inputs ($tail)', async ({ tail }) => {
    const dest = join(tmp, 'verifier-missing-input-argument-export');
    await expect(runCli(['verifier-prepare', '--repo', fx.repo, '--ref', fx.commit,
      '--out', dest, '--inputs', SHIPPED[0], '--inputs-file', ...tail]))
      .rejects.toThrow('missing value for --inputs-file');
    expect(existsSync(dest)).toBe(false);
  });

  it.each(['dirty', 'missing'])('refuses a %s file-listed input and removes the incomplete export', async (kind) => {
    const fixture = makeSuperproject(join(tmp, `verifier-file-${kind}-fixture`));
    const dest = join(tmp, `verifier-file-${kind}-export`);
    const inputsFile = join(tmp, `verifier-file-${kind}-inputs.json`);
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    if (kind === 'dirty') writeFileSync(join(fixture.repo, input), 'uncommitted acceptance change');
    writeFileSync(inputsFile, JSON.stringify([kind === 'dirty' ? input : 'apps/operator/missing.ts']));
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest,
      inputs: [SHIPPED.find((p) => p !== input)!], inputsFile }))
      .rejects.toThrow(kind === 'dirty' ? /dirty tested-input mismatch/ : /ENOENT/);
    expect(existsSync(dest)).toBe(false);
  });

  it('transports independent verifier provenance to a child and refuses stale or internal receipts', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-child-env-fixture'));
    const dest = join(tmp, 'verifier-child-env-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const receiptPath = join(tmp, 'verifier-child-env.receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const env = verifierSourceChildEnv({ root: dest, receiptPath, env: {
      PATH: process.env.PATH, VERIFY_TAURI_SOURCE_RECEIPT: '/stale/receipt', VERIFY_TAURI_SOURCE_REF: 'stale',
    } });
    expect(env.VERIFY_TAURI_SOURCE_RECEIPT).toBe(receiptPath);
    expect(env.VERIFY_TAURI_SOURCE_REF).toBe(receipt.sourceCommit);
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', env.VERIFY_TAURI_SOURCE_RECEIPT!);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', env.VERIFY_TAURI_SOURCE_REF!);
    try {
      expect(captureTestSourceSnapshot(dest)).toEqual({ commit: receipt.sourceCommit, porcelain: '' });
    } finally { vi.unstubAllEnvs(); }
    expect(() => verifierSourceChildEnv({ root: dest, receiptPath: join(dest, '.verifier-source.json') }))
      .toThrow('receipt must be outside the archive');
    writeFileSync(join(dest, input), 'changed after preflight');
    expect(() => verifierSourceChildEnv({ root: dest, receiptPath })).toThrow(`changed ${input}`);
  });

  it('measures pinned source and gitlinks before export, ignoring dirty and untracked bytes', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-size-fixture'));
    const before = measureVerifierSourceBytes({ repo: fixture.repo, ref: fixture.commit });
    const dest = join(tmp, 'verifier-size-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const exported = listFiles(dest).filter(p => p !== '.verifier-source.json')
      .reduce((bytes, p) => bytes + Math.ceil(statSync(join(dest, p)).size / 4096) * 4096, 0);
    expect(before).toBe(exported);
    expect(receipt.submodules).toHaveLength(1);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runCli(['verifier-measure', '--repo', fixture.repo, '--ref', fixture.commit])).toBe(0);
      expect(output).toHaveBeenCalledWith(before);
    } finally { output.mockRestore(); }
    write(fixture.repo, 'dirty-untracked.bin', 'x'.repeat(100_000));
    write(fixture.repo, input, 'dirty'.repeat(10_000));
    expect(measureVerifierSourceBytes({ repo: fixture.repo, ref: fixture.commit })).toBe(before);
    git(fixture.repo, ['update-index', '--cacheinfo', `160000,${'1'.repeat(40)},libs/papercusp`]);
    git(fixture.repo, ['commit', '-qm', 'unresolvable size fixture']);
    expect(() => measureVerifierSourceBytes({ repo: fixture.repo, ref: 'HEAD' })).toThrow(/unresolvable gitlink/);
  });

  it('round-trips the verifier CLI with an external caller receipt and refuses tampering', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-cli-fixture'));
    const dest = join(tmp, 'verifier-cli-export');
    const receipt = join(tmp, 'verifier-cli-receipt.json');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    expect(await runCli(['verifier-prepare', '--repo', fixture.repo, '--ref', fixture.commit,
      '--out', dest, '--inputs', input, '--receipt', receipt])).toBe(0);
    expect(statSync(receipt).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(receipt, 'utf8')).sourceCommit).toBe(fixture.commit);
    expect(await runCli(['verifier-verify', '--out', dest, '--receipt', receipt])).toBe(0);
    for (const artifact of NATIVE_RUNTIME_FILES) write(dest, artifact, 'native runtime output');
    await expect(runCli(['verifier-verify', '--out', dest, '--receipt', receipt]))
      .rejects.toThrow('tampered verification source archive');
    expect(await runCli(['verifier-verify', '--out', dest, '--receipt', receipt,
      '--runtime-artifacts'])).toBe(0);
    writeFileSync(join(dest, input), 'changed after preparation');
    await expect(runCli(['verifier-verify', '--out', dest, '--receipt', receipt, '--runtime-artifacts']))
      .rejects.toThrow('tampered verification source archive');
  });

  it('exports exact gitlinks despite unrelated dirty donor bytes and detects archive tampering', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-fixture'));
    const dest = join(tmp, 'verifier-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    write(fixture.repo, 'unrelated-untracked.ts', 'peer edit');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    expect(receipt.sourceCommit).toBe(fixture.commit);
    expect(receipt.submodules.length).toBeGreaterThan(0);
    expect(existsSync(join(dest, 'unrelated-untracked.ts'))).toBe(false);
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'tampered');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow(`tampered verification source archive: changed ${input}`);
  });

  it('prepares real Git parent and recursive index semantics without changing the exported source population', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-checkout-fixture'));
    git(fixture.repo, ['commit', '--allow-empty', '-m', 'second verifier revision']);
    const head = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const dest = join(tmp, 'verifier-checkout');
    const archive = await prepareVerifierSource({ repo: fixture.repo, ref: head,
      dest: join(tmp, 'verifier-checkout-archive'), inputs: [input] });
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: head, dest, inputs: [input], gitCheckout: true });
    expect(receipt.files).toEqual(archive.files);
    expect(receipt.testedInputs).toEqual(archive.testedInputs);
    expect(receipt.gitCheckout?.parentCommit).toBe(fixture.commit);
    expect(git(dest, ['rev-parse', 'HEAD^'])).toBe(fixture.commit);
    expect(git(dest, ['ls-files', '--recurse-submodules'])).toContain('libs/papercusp/package.json');
    expect(git(dest, ['remote'])).toBe('');
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
    expect(git(dest, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    writeFileSync(join(dest, 'unexpected-source.ts'), 'export const unexpected = true;\n');
    expect(git(dest, ['status', '--porcelain', '--untracked-files=all'])).toContain('?? unexpected-source.ts');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('added unexpected-source.ts');
    rmSync(join(dest, 'unexpected-source.ts'));
    writeFileSync(join(dest, '.verifier-source.json'), '{}');
    expect(git(dest, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source provenance');
    writeFileSync(join(dest, '.verifier-source.json'), JSON.stringify(receipt));
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);

    // Source-byte identity alone cannot detect a changed index.
    git(dest, ['rm', '--cached', '--', input]);
    expect(readFileSync(join(dest, input))).toEqual(readFileSync(join(fixture.repo, input)));
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification Git checkout');
  });

  it('keeps native preparation pinned when the canonical donor changes after admission, and refuses fixed-source drift', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-native-race-fixture'));
    for (const path of TAURI_VERIFIER_INPUTS) write(fixture.repo, path, `// ${path}\n`);
    git(fixture.repo, ['add', ...TAURI_VERIFIER_INPUTS]);
    git(fixture.repo, ['commit', '-qm', 'native invocation source']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const sourceRoot = join(tmp, 'verifier-native-race-invocation');
    const options = { ref, inputs: [input], tauriInputs: true };
    const receipt = await prepareVerifierSource({ ...options, repo: fixture.repo,
      dest: sourceRoot, gitCheckout: true });
    const externalReceipt = join(tmp, 'verifier-native-race-receipt.json');
    writeFileSync(externalReceipt, JSON.stringify(receipt));

    // This is the v4 ordering: admission succeeds, then a peer saves the wrapper
    // while external fixtures are being allocated, before native preparation.
    const wrapper = 'scripts/verify-tauri-headless.sh';
    writeFileSync(join(fixture.repo, wrapper), 'peer edit after admission');
    await expect(validateVerifierInputs({ ...options, repo: fixture.repo }))
      .rejects.toThrow(`dirty tested-input mismatch: ${wrapper}`);
    expect(await runCli(['verifier-verify', '--out', sourceRoot, '--receipt', externalReceipt])).toBe(0);
    const nativeReceipt = await prepareVerifierSource({ ...options, repo: sourceRoot,
      dest: join(tmp, 'verifier-native-race-runtime') });
    expect(nativeReceipt.sourceCommit).toBe(ref);
    expect(nativeReceipt.files).toEqual(receipt.files);
    expect(nativeReceipt.testedInputs).toEqual(receipt.testedInputs);
    expect(readFileSync(join(fixture.repo, wrapper), 'utf8')).toBe('peer edit after admission');

    // Independence is not permission to weaken the input fence.
    writeFileSync(join(sourceRoot, wrapper), 'tampered fixed invocation');
    await expect(runCli(['verifier-verify', '--out', sourceRoot, '--receipt', externalReceipt]))
      .rejects.toThrow(`tampered verification source archive: changed ${wrapper}`);
    const refused = join(tmp, 'verifier-native-race-refused');
    await expect(prepareVerifierSource({ ...options, repo: sourceRoot, dest: refused }))
      .rejects.toThrow(`dirty tested-input mismatch: ${wrapper}`);
    expect(existsSync(refused)).toBe(false);
  });

  it.each(['unchanged', 'content', 'added', 'removed', 'mode', 'new-tree', 'workspace-link', 'ephemeral',
    'absolute-link', 'escaping-link', 'indirect-escape', 'dangling-link', 'redirected-tree',
    'duplicate-tree', 'missing-population', 'invalid-path', 'nested-tree'] as const)
  ('measures materialized dependency bytes with the existing census (%s)', async defect => {
    const root = join(tmp, 'dependency-census-' + defect);
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(root, helper, '#!/bin/bash\nset -eu\ntest "$1" = trees\necho node_modules\nif [ -d "$2/app/node_modules" ]; then echo app/node_modules; fi\n');
    write(root, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    write(root, 'node_modules/example/index.mjs', 'export default 1;\n');
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
      testedInputs: [{ path: 'input.mjs', sha256: 'b'.repeat(64) }], files: [], submodules: [] };
    const before = captureVerifierDependencies({ dest: root, receipt });
    expect(before.trees.map(tree => tree.path)).toEqual(['node_modules']);
    const dependency = join(root, 'node_modules/example/index.mjs');
    if (defect === 'content') writeFileSync(dependency, 'export default 2;\n');
    if (defect === 'added') write(root, 'node_modules/example/extra.mjs', 'added');
    if (defect === 'removed') rmSync(dependency);
    if (defect === 'mode') await fsPromises.chmod(dependency, 0o755);
    if (defect === 'new-tree') write(root, 'app/node_modules/second/index.mjs', 'second');
    if (defect === 'ephemeral') for (const path of ['.cache/out', '.package-lock.json',
      '.papercusp-isolated-snapshot', 'example/.astro/out', 'example/.vite/out',
      'example/.vite-temp/out', 'example/.verdict-data/out']) write(root, 'node_modules/' + path, 'runtime output');
    if (defect === 'workspace-link') {
      write(root, 'app/index.mjs', 'workspace source');
      symlinkSync('../app', join(root, 'node_modules/workspace'));
    }
    if (defect === 'absolute-link') symlinkSync(join(root, 'app'), join(root, 'node_modules/redirect'));
    if (defect === 'escaping-link') symlinkSync('../../', join(root, 'node_modules/redirect'));
    if (defect === 'indirect-escape') {
      symlinkSync(tmp, join(root, 'app'));
      symlinkSync('../app', join(root, 'node_modules/redirect'));
    }
    if (defect === 'dangling-link') symlinkSync('../absent', join(root, 'node_modules/redirect'));
    if (defect === 'redirected-tree') {
      await fsPromises.rename(join(root, 'node_modules'), join(root, 'donor'));
      symlinkSync('donor', join(root, 'node_modules'));
    }
    const populations: Partial<Record<typeof defect, string>> = { 'duplicate-tree': 'node_modules\\nnode_modules',
      'missing-population': '', 'invalid-path': '../node_modules',
      'nested-tree': 'node_modules\\nnode_modules/example/node_modules' };
    const population = populations[defect];
    if (population !== undefined) write(root, helper,
      '#!/bin/bash\nprintf "' + population + '\\n"\n');
    if (['absolute-link', 'escaping-link', 'indirect-escape', 'dangling-link',
      'redirected-tree', 'duplicate-tree', 'missing-population', 'invalid-path', 'nested-tree'].includes(defect)) {
      expect(() => captureVerifierDependencies({ dest: root, receipt })).toThrow();
    } else {
      const after = captureVerifierDependencies({ dest: root, receipt });
      if (defect === 'unchanged' || defect === 'ephemeral') expect(after).toEqual(before);
      else expect(after).not.toEqual(before);
      if (defect === 'workspace-link') expect(after.trees[0]!.files).toContainEqual(expect.objectContaining({
        path: 'workspace', kind: 'symlink', sha256: createHash('sha256').update('../app').digest('hex'),
      }));
    }
  });

  it.each(['fresh', 'node_modules.pinned-deps-tmp', 'node_modules.pinned-deps-tmp.12345'])(
    'loads TypeScript directory imports with the invoked tree loader before native allocation and survives donor dependency removal (%s)', async staging => {
    const fixture = makeSuperproject(join(tmp, 'verifier-native-dependencies-' + staging));
    git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
    const script = 'scripts/source-preview.mjs';
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(fixture.repo, script, "import value from '@native-proof/runtime';\nimport { typed } from './schema';\nif (value !== typed) throw Error('wrong dependency');\nconsole.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
    write(fixture.repo, 'scripts/schema/index.ts', "export const typed: string = 'private-snapshot';\n");
    write(fixture.repo, 'scripts/schema/package.json', '{"type":"module"}\n');
    write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    // Substitute the expensive copy only; execute real Node resolution from the
    // independent source tree, with ambient loaders and NODE_PATH excluded.
    write(fixture.repo, helper, '#!/bin/bash\nset -eu\nif [ "$1" = trees ]; then echo node_modules; exit; fi\ntest "$1" = snapshot-locked\ntest "$4" = hardlink\nshopt -s nullglob\nstaging=("$3"/node_modules.pinned-deps-tmp*)\nif [ "${#staging[@]}" = 1 ]; then mv -- "${staging[0]}" "$3/node_modules"; else mkdir "$3/node_modules"; fi\ncp -al -- "$2/node_modules/." "$3/node_modules/"\n');
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', script, 'scripts/schema', helper, '.gitignore', DEPENDENCY_POLICY_PATH]);
    git(fixture.repo, ['commit', '-qm', 'native dependency preflight fixture']);
    const scratch = join(fixture.repo, '.papercusp', 'scratch');
    await fsPromises.mkdir(scratch, { recursive: true });
    const dest = join(scratch, 'invoked');
    const otherTemp = join(tmp, 'verifier-native-dependencies-other-temp-' + staging);
    await fsPromises.mkdir(otherTemp);
    vi.stubEnv('TMPDIR', otherTemp);
    let receipt: Awaited<ReturnType<typeof prepareVerifierSource>>;
    try {
      receipt = await prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD',
        dest, inputs: [script], gitCheckout: true });
    } finally { vi.unstubAllEnvs(); }
    const probe = (loader = false) => spawnSync(process.execPath, [...(loader ? ['--import', 'tsx'] : []), join(dest, script), 'verifier-measure'],
      { cwd: dest, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
    expect(probe().stderr).toContain('ERR_MODULE_NOT_FOUND');
    write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
      name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
    write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
    installVerifierTsx(fixture.repo);
    if (staging !== 'fresh') write(dest, staging + '/retained-proof', 'retained private fixture bytes');
    const dependencies = await prepareVerifierDependencies({ donor: fixture.repo, dest, receipt });
    if (staging !== 'fresh') {
      expect(existsSync(join(dest, staging))).toBe(false);
      expect(readFileSync(join(dest, 'node_modules/retained-proof'), 'utf8')).toBe('retained private fixture bytes');
    }
    expect(dependencies.trees[0]!.files.map(file => file.path)).toEqual(expect.arrayContaining([
      '@native-proof/runtime/index.mjs', '@native-proof/runtime/package.json', 'tsx/package.json',
    ]));
    expect(statSync(join(dest, 'node_modules/@native-proof/runtime/index.mjs')).ino)
      .toBe(statSync(join(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs')).ino);
    expect(probe().stderr).toContain('ERR_UNSUPPORTED_DIR_IMPORT');
    rmSync(join(fixture.repo, 'node_modules'), { recursive: true });
    expect(probe(true).status).toBe(0);
    expect(probe(true).stdout.trim()).toBe('4096');
    expect(captureVerifierDependencies({ dest, receipt })).toEqual(dependencies);
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    rmSync(join(dest, 'node_modules/tsx'), { recursive: true });
    const missingLoader = probe(true);
    expect(missingLoader.status).not.toBe(0);
    expect(missingLoader.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });

  it.each(['copy', 'copy-lock'])('lets advancing %s progress cross the initial watchdog deadline', async kind => {
    const progressLine = kind === 'copy'
      ? "'copy progress: fixture written=' + (++written) + 'MiB'"
      : "'copy lock progress: fixture advances=' + (++written)";
    const output = await runVerifierDependencyCommand(process.execPath, ['-e', `
      let written = 0;
      const timer = setInterval(() => console.log(${progressLine}), 100);
      setTimeout(() => { clearInterval(timer); console.log('copy-complete'); }, 1800);
    `], { cwd: tmp, env: childEnv(), timeoutMs: 1000, maxMs: 5000,
      stallWindowMs: 500, extensionMs: 500 });
    expect(output).toContain('copy-complete');
  });

  it('treats completed small-tree snapshots as progress after byte counters go quiet', async () => {
    const output = await runVerifierDependencyCommand(process.execPath, ['-e', `
      let completed = 0;
      const timer = setInterval(() => {
        console.log('snapshot progress: completed=' + (++completed));
        if (completed === 12) {
          clearInterval(timer);
          console.log('copy-complete');
        }
      }, 150);
    `], { cwd: tmp, env: childEnv(), timeoutMs: 1000, maxMs: 5000,
      stallWindowMs: 500, extensionMs: 500 });
    expect(output).toContain('copy-complete');
  });

  it.each(['copy', 'copy-lock', 'snapshot'])('rejects chattering stalled %s and joins a TERM-resistant descendant before cleanup', async kind => {
    const destination = join(tmp, 'dependency-copy-writer');
    const pidPath = join(tmp, 'dependency-copy-writer.pid');
    await fsPromises.mkdir(destination);
    const writer = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => fs.writeFileSync(process.argv[2] + '/progress', 'writing'), 10);
    `;
    await expect(runVerifierDependencyCommand(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(writer)}, ${JSON.stringify(pidPath)}, ${JSON.stringify(destination)}],
        { stdio: 'ignore' });
      setInterval(() => console.log(${JSON.stringify(kind === 'copy'
        ? 'copy progress: fixture written=1MiB' : kind === 'copy-lock'
          ? 'copy lock progress: fixture advances=1' : 'snapshot progress: completed=1 tree=fixture')}), 100);
    `], { cwd: tmp, env: childEnv(), timeoutMs: 1500, maxMs: 5000,
      stallWindowMs: 500, extensionMs: 500 })).rejects.toThrow('progress-stalled');
    expect(existsSync(pidPath)).toBe(true);
    // Remove the actual writer's directory only AFTER the awaited exit fence.
    // A surviving descendant would recreate it and invalidate the proof.
    await fsPromises.rm(destination, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(existsSync(destination)).toBe(false);
    const pid = readFileSync(pidPath, 'utf8');
    if (existsSync(`/proc/${pid}/stat`))
      expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0]).toMatch(/[ZX]/);
  });

  it.each(['absolute', 'task'])('keeps advancing snapshot progress inside the %s deadline', async boundary => {
    const env = childEnv();
    if (boundary === 'task') env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = String(Date.now() + 11_000);
    await expect(runVerifierDependencyCommand(process.execPath, ['-e', `
      let completed = 0;
      setInterval(() => console.log('snapshot progress: completed=' + (++completed)), 100);
    `], { cwd: tmp, env, timeoutMs: 500, maxMs: boundary === 'task' ? 5000 : 1000,
      stallWindowMs: 400, extensionMs: 300 })).rejects.toThrow('absolute-ceiling');
  });

  it.each([false, true])('freezes materialized committed source without cloning on root (root donor=%s)', async rootDonor => {
    const fixtureParent = rootDonor && process.platform === 'linux'
      ? mkdtempSync('/var/tmp/source-preview-root-donor-') : tmp;
    try {
    const fixture = makeSuperproject(join(fixtureParent, 'verifier-materialized-dependencies-' + rootDonor));
    const copiesDependencies = process.platform === 'linux' && statSync(fixture.repo).dev === statSync('/').dev;
    git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
    const script = 'scripts/source-preview.mjs';
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(fixture.repo, script, "import value from '@native-proof/runtime';\nif (value !== 'private-snapshot') throw Error('wrong dependency');\nconsole.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
    write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    // Keep the physical-donor precondition and real independent Node resolution;
    // substitute only the expensive production dependency census/copy.
    write(fixture.repo, helper, '#!/bin/bash\nset -eu\nif [ "$1" = trees ]; then echo node_modules; exit; fi\ntest "$1" = snapshot-locked\ntest "$4" = ' + (copiesDependencies ? 'copy' : 'hardlink') + '\ntest ! -L "$2/node_modules/.bin"\nif [ "$4" = copy ]; then cp -a -- "$2/node_modules" "$3/node_modules"; else cp -al -- "$2/node_modules" "$3/node_modules"; fi\n');
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/node_modules/\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', script, helper, '.gitignore', DEPENDENCY_POLICY_PATH]);
    git(fixture.repo, ['commit', '-qm', 'materialized dependency donor fixture']);
    const sha = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    write(fixture.repo, 'node_modules/.bin/probe', '#!/bin/sh\n');
    write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
      name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
    write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
    installVerifierTsx(fixture.repo);
    const materialized = join(tmp, 'materialized-dependency-source-' + rootDonor);
    git(fixture.repo, ['clone', '--local', '--shared', '--recurse-submodules', fixture.repo, materialized]);
    const shadow = await import(new URL('../../../scripts/lint-as-committed.mjs', import.meta.url).href);
    write(materialized, shadow.OWNER_MARKER, JSON.stringify({ sha, sourceRepoRoot: fixture.repo }));
    shadow.linkNodeModulesShadow(join(fixture.repo, 'node_modules'), join(materialized, 'node_modules'), fixture.repo, materialized);
    expect((await fsPromises.lstat(join(materialized, 'node_modules/.bin'))).isSymbolicLink()).toBe(true);
    const receiptPath = join(tmp, 'materialized-dependency-source-receipt-' + rootDonor + '.json');
    const options = { repo: materialized, ref: sha, inputs: [script], receiptPath,
      command: [process.execPath, script, 'verifier-measure'] };
    // The donor must pass the ignored-source-scratch guard, not accidentally
    // be admitted because both fixture repositories are beneath OS tmpdir.
    const restrictedTemp = join(tmp, 'materialized-source-only-temp-' + rootDonor);
    await fsPromises.mkdir(restrictedTemp);
    vi.stubEnv('TMPDIR', restrictedTemp);
    try {
      expect(await runVerifierCommand(options)).toBe(0);
    } finally { vi.unstubAllEnvs(); }
    expect(JSON.parse(readFileSync(receiptPath, 'utf8')).sourceCommit).toBe(sha);
    const dependencyReceipt = JSON.parse(readFileSync(`${receiptPath}.dependencies.json`, 'utf8'));
    if (copiesDependencies) {
      expect(dependencyReceipt.root).toMatch(/^\/mnt\/data\/tmp\/verifier-command-/);
      expect(statSync(fixture.repo).dev).not.toBe(statSync('/mnt/data/tmp').dev);
    } else expect(relative(fixture.repo, dependencyReceipt.root)).toMatch(/^\.papercusp\/scratch\/verifier-command-/);
    expect(dependencyReceipt.sourceCommit).toBe(sha);
    // The recorded donor must never make a mismatched source identity acceptable.
    write(materialized, shadow.OWNER_MARKER, JSON.stringify({ sha: '0'.repeat(40), sourceRepoRoot: fixture.repo }));
    await expect(runVerifierCommand({ ...options, receiptPath: join(tmp, 'refused-donor-receipt-' + rootDonor + '.json') }))
      .rejects.toThrow('retained source commit does not match');
    expect(existsSync(join(tmp, 'refused-donor-receipt-' + rootDonor + '.json'))).toBe(false);
    } finally {
      if (fixtureParent !== tmp) rmSync(fixtureParent, { recursive: true, force: true });
    }
  });

  it.each(['donor-change', 'child-failure', 'frozen-tamper', 'dependency-tamper', 'phase-io-failure', 'deadline-refusal', 'history-refusal'] as const)
    ('freezes the full command before provider allocation and cleans its owned tree (%s)', async mode => {
      const fixture = makeSuperproject(join(tmp, 'verifier-command-' + mode));
      git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
      const preflight = 'scripts/source-preview.mjs';
      const provider = 'scripts/provider-fixture.mjs';
      const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
      write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
      write(fixture.repo, preflight, "console.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
      write(fixture.repo, helper, '#!/bin/bash\nset -eu\nif [ "$1" = trees ]; then echo node_modules; exit; fi\ncp -al -- "$2/node_modules" "$3/node_modules"\n');
      write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
      write(fixture.repo, provider, [
        "import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import value from '@native-proof/runtime';",
        "const donor = process.argv[2], mode = process.argv[3];",
        "writeFileSync(join(donor, 'scripts/provider-fixture.mjs'), 'peer edit after allocation');",
        "rmSync(join(donor, 'node_modules'), { recursive: true, force: true });",
        "const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'utf8'));",
        "writeFileSync(process.argv[4], JSON.stringify({ root: process.cwd(), value, ref: receipt.sourceCommit,",
        "  receipt: process.env.VERIFY_TAURI_SOURCE_RECEIPT, repo: process.env.PAPERCUSP_REPO_DIR,",
        "  source: readFileSync('scripts/provider-fixture.mjs', 'utf8'),",
        "  options: process.env.NODE_OPTIONS, path: process.env.NODE_PATH, flag: process.argv[5] }));",
        "if (mode === 'frozen-tamper') writeFileSync('scripts/provider-fixture.mjs', 'tampered frozen source');",
        "if (mode === 'dependency-tamper') writeFileSync('node_modules/@native-proof/runtime/index.mjs', 'tampered installed bytes');",
        "if (mode === 'child-failure') process.exitCode = 37;",
        "if (mode === 'phase-io-failure') { const path = process.env.VERIFY_TAURI_SOURCE_RECEIPT + '.phases.jsonl'; rmSync(path); mkdirSync(path); }",
      ].join('\n'));
      git(fixture.repo, ['add', preflight, provider, helper, '.gitignore', DEPENDENCY_POLICY_PATH]);
      git(fixture.repo, ['commit', '-qm', 'full verifier command fixture']);
      const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
      const original = readFileSync(join(fixture.repo, provider), 'utf8');
      write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
        name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
      write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
      installVerifierTsx(fixture.repo);
      const receiptPath = join(tmp, 'verifier-command-' + mode + '.receipt.json');
      const proofPath = join(tmp, 'verifier-command-' + mode + '.proof.json');
      const command = [process.execPath, provider, fixture.repo, mode, proofPath, '--provider-flag=literal'];
      const budgetFrom = join(tmp, 'verifier-command-budget-' + mode + '.jsonl');
      if (mode === 'history-refusal') {
        let elapsedMs = 0;
        const rows = Object.entries(budgetPhases).flatMap(([phase, durationMs], index) => [
          { schemaVersion: 'verifier-phase-v1', sequence: index * 2 + 1, phase, event: 'started', elapsedMs },
          { schemaVersion: 'verifier-phase-v1', sequence: index * 2 + 2, phase, event: 'completed', durationMs, elapsedMs: elapsedMs += durationMs },
        ]);
        writeFileSync(budgetFrom, rows.map(row => JSON.stringify(row)).join('\n'));
      }
      const invocation = mode === 'donor-change'
        ? runCli(['verifier-run', '--repo', fixture.repo, '--ref', ref, '--inputs', provider,
          '--receipt', receiptPath, '--', ...command])
        : runVerifierCommand({ repo: fixture.repo, ref, inputs: [provider], receiptPath, command,
          ...(mode === 'history-refusal' ? { budgetFrom } : {}),
          childEstimateMs: mode === 'deadline-refusal' ? 600_000 : 0,
          env: { ...process.env, NODE_OPTIONS: '--import=/nonexistent/ambient-loader', NODE_PATH: '/ambient/dependencies',
            ...(['history-refusal', 'deadline-refusal'].includes(mode) ? {
              PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + (mode === 'deadline-refusal' ? 180_000 : 60_000)),
            } : {}) } });
      if (mode === 'deadline-refusal' || mode === 'history-refusal') {
        await expect(invocation).rejects.toThrow('TASK_DEADLINE_REFUSAL');
        expect(existsSync(proofPath)).toBe(false);
        expect(readdirSync(join(fixture.repo, '.papercusp/scratch'))).toEqual([]);
        const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(phases.some(row => row.phase === 'child.preflight' || row.phase === 'child.run')).toBe(false);
        expect(phases.filter(row => row.event === 'failed').map(row => row.phase))
          .toEqual([mode === 'history-refusal' ? 'source.admission' : 'child.admission']);
        expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
        expect(readFileSync(join(fixture.repo, provider), 'utf8')).toBe(original);
        if (mode === 'history-refusal') expect(existsSync(receiptPath)).toBe(false);
        else expect(existsSync(receiptPath + '.dependencies.json')).toBe(true);
        return;
      }
      if (mode === 'frozen-tamper') await expect(invocation).rejects.toThrow('tampered verification source archive');
      else if (mode === 'dependency-tamper') await expect(invocation).rejects.toThrow('Verifier materialized dependencies changed during command');
      else if (mode === 'phase-io-failure') await expect(invocation).rejects.toThrow('EISDIR');
      else await expect(invocation).resolves.toBe(mode === 'child-failure' ? 37 : 0);
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
      expect(proof).toMatchObject({ value: 'private-snapshot', ref, receipt: receiptPath,
        source: original, options: '', path: '', flag: '--provider-flag=literal' });
      expect(proof.root).toBe(proof.repo);
      expect(proof.root).not.toBe(fixture.repo);
      expect(existsSync(proof.root)).toBe(false);
      expect(readdirSync(join(fixture.repo, '.papercusp/scratch'))).toEqual([]);
      expect(readFileSync(join(fixture.repo, provider), 'utf8')).toBe('peer edit after allocation');
      expect(existsSync(join(fixture.repo, 'node_modules'))).toBe(false);
      expect(JSON.parse(readFileSync(receiptPath, 'utf8')).sourceCommit).toBe(ref);
      const phasePath = receiptPath + '.phases.jsonl';
      if (mode === 'phase-io-failure') {
        expect(statSync(phasePath).isDirectory()).toBe(true);
        return; // Owned-tree absence above proves telemetry failure still cleans.
      }
      const phases = readFileSync(phasePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(statSync(phasePath).mode & 0o777).toBe(0o600);
      expect(phases.map(row => row.sequence)).toEqual(phases.map((_, index) => index + 1));
      expect(phases.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)).toBe(true);
      expect(phases.filter(row => row.event === 'started').map(row => row.phase)).toEqual([
        'source.admission', 'source.freeze', 'receipt.write', 'deps.source.before', 'deps.snapshot',
        'deps.source.after-snapshot', 'deps.inputs', 'deps.measure', 'deps.source.after-preflight',
        'deps.census', 'deps.receipt.write', 'child.admission', 'child.preflight', 'child.run', 'deps.postverify',
        ...(mode === 'dependency-tamper' ? [] : ['source.postverify']), 'cleanup',
      ]);
      expect(phases.filter(row => row.event === 'failed').map(row => row.phase))
        .toEqual(mode === 'frozen-tamper' ? ['source.postverify'] : mode === 'dependency-tamper' ? ['deps.postverify'] : []);
      const beforeDependencies = JSON.parse(readFileSync(receiptPath + '.dependencies.json', 'utf8'));
      const afterDependencies = JSON.parse(readFileSync(receiptPath + '.dependencies.after.json', 'utf8'));
      expect(beforeDependencies.scope).toBe('materialized-dependency-files');
      expect(beforeDependencies.sourceCommit).toBe(ref);
      expect(beforeDependencies.sourceReceiptSha256).toBe(createHash('sha256')
        .update(JSON.stringify(JSON.parse(readFileSync(receiptPath, 'utf8')))).digest('hex'));
      if (mode === 'dependency-tamper') expect(afterDependencies).not.toEqual(beforeDependencies);
      else expect(afterDependencies).toEqual(beforeDependencies);
      expect(phases.find(row => row.phase === 'child.run' && row.event === 'completed'))
        .toMatchObject({ exitCode: mode === 'child-failure' ? 37 : 0 });
      expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
    });

  it.each(['hung', 'descendant', 'signal-race', 'unverified', 'completed', 'no-deadline'] as const)(
    'enforces the cleanup-reserve cutoff through the owned process group (%s)', async mode => {
      const fixture = makeSuperproject(join(tmp, 'verifier-cutoff-' + mode));
      git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
      const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
      const preflight = 'scripts/source-preview.mjs';
      const provider = 'scripts/cutoff-fixture.mjs';
      const ready = join(tmp, 'verifier-cutoff-ready-' + mode);
      write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
      write(fixture.repo, preflight, "console.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
      write(fixture.repo, helper, '#!/bin/bash\nset -eu\nif [ "$1" = trees ]; then echo node_modules; exit; fi\ncp -al -- "$2/node_modules" "$3/node_modules"\n');
      const successful = mode === 'completed' || mode === 'no-deadline';
      write(fixture.repo, provider, [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        successful ? `writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ root: process.cwd(), group: process.pid })); process.exitCode = 37;`
          : `spawn(process.execPath, ['-e', ${JSON.stringify([
            "const fs = require('node:fs'); process.on('SIGTERM', () => {});",
            `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ root: process.cwd(), group: process.ppid, descendant: process.pid }));`,
            "setInterval(() => {}, 1000);",
          ].join('\n'))}], { stdio: 'ignore' });`,
        ...(!successful && mode !== 'descendant' ? ['setInterval(() => {}, 1000);'] : []),
      ].join('\n'));
      write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
      git(fixture.repo, ['add', helper, preflight, provider, '.gitignore', DEPENDENCY_POLICY_PATH]);
      git(fixture.repo, ['commit', '-qm', 'owned verifier cutoff fixture']);
      const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
      write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
        name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
      write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
      installVerifierTsx(fixture.repo);
      const receiptPath = join(tmp, 'verifier-cutoff-' + mode + '.json');
      let now = 1_000_000;
      const deadline = now + 300_000;
      const pending = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>();
      const clock = { now: () => now,
        setTimeout: vi.fn(((callback: () => void, delay: number) => {
          const timer = {} as ReturnType<typeof setTimeout>;
          pending.set(timer, { callback, delay });
          return timer;
        })),
        clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => { pending.delete(timer); }),
      };
      const env = childEnv({ PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(deadline) });
      if (mode === 'no-deadline') delete env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS;
      const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const result = runVerifierCommand({ repo: fixture.repo, ref, receiptPath, inputs: [provider],
        command: [process.execPath, provider], env, clock })
        .then(code => ({ code, error: null }), error => ({ code: null, error }));
      let owned: string | undefined, peer: string | undefined, group: number | undefined;
      const kill = process.kill.bind(process);
      let killSpy: ReturnType<typeof vi.spyOn> | undefined;
      let signalShutdown: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 20_000, interval: 20 });
        const child = JSON.parse(readFileSync(ready, 'utf8'));
        owned = dirname(child.root); group = child.group;
        peer = mkdtempSync(join(dirname(owned!), 'verifier-command-'));
        writeFileSync(join(peer, 'peer-owned'), 'must survive');
        const initial = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
        expect(initial).toMatchObject({ cleanup: 'pending', ownedRoot: owned });
        if (!successful) {
          expect(pending.size).toBe(1);
          const fire = () => {
            const [timer, scheduled] = [...pending.entries()][0]!;
            pending.delete(timer); scheduled.callback();
          };
          expect([...pending.values()][0]!.delay).toBe(180_000);
          // An early callback must re-arm against the absolute clock.
          now = deadline - 120_000 - 1; fire();
          expect([...pending.values()][0]!.delay).toBe(1);
          expect(existsSync(owned!)).toBe(true);
          if (mode === 'unverified') {
            killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) =>
              pid === -group! && signal !== 0 ? true : kill(pid, signal));
          }
          now++; fire();
          if (mode === 'signal-race') {
            // The shared lifetime's process-shutdown handler also schedules a
            // final group sweep. Join that observed callback before this test
            // admits the next fixture, so a simulated host shutdown cannot kill it.
            let swept!: () => void;
            signalShutdown = new Promise<void>(resolve => { swept = resolve; });
            const schedule = globalThis.setTimeout;
            const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
              schedule(() => { callback(...args); if (delay === 2_000) swept(); }, delay)) as typeof setTimeout);
            try { process.emit('SIGTERM', 'SIGTERM'); }
            finally { timerSpy.mockRestore(); }
          }
        }
        const outcome = await result;
        const task = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
        expect(task.budget).toMatchObject({ deadlineEpochMs: mode === 'no-deadline' ? null : deadline,
          cleanupReserveMs: 120_000, childCutoffEpochMs: mode === 'no-deadline' ? null : deadline - 120_000 });
        if (successful) {
          expect(outcome).toEqual({ code: 37, error: null });
          expect(task.budget).toMatchObject({ cutoffTriggeredAtMs: null, childExitVerifiedAtMs: now });
          // A callback already queued at completion cannot cancel a finished run.
          const callback = clock.setTimeout.mock.calls[0]?.[0] as (() => void) | undefined;
          now = deadline; callback?.();
          expect(pending.size).toBe(0);
        } else {
          expect(outcome.error).toBeInstanceOf(Error);
          expect(outcome.error.message).toContain(mode === 'unverified' ? 'exit unverified'
            : mode === 'signal-race' ? 'canceled by SIGTERM' : 'VERIFIER_CHILD_DEADLINE_CUTOFF');
          expect(task.budget.cutoffTriggeredAtMs).toBe(deadline - 120_000);
          expect(task.budget.childExitVerifiedAtMs).toBe(mode === 'unverified' ? null : now);
          expect(outcome.error.exitCode).toBe(mode === 'unverified' ? undefined : mode === 'signal-race' ? 143 : 2);
          if (mode === 'signal-race') expect(task.cancellationSignal).toBe('SIGTERM');
          if (mode !== 'unverified' && existsSync(`/proc/${child.descendant}/stat`))
            expect(readFileSync(`/proc/${child.descendant}/stat`, 'utf8').split(') ')[1]![0]).toMatch(/[ZX]/);
        }
        expect(task.cleanup).toBe(mode === 'unverified' ? 'deferred' : 'completed');
        expect(existsSync(owned!)).toBe(mode === 'unverified');
        expect(readFileSync(join(peer, 'peer-owned'), 'utf8')).toBe('must survive');
        expect(pending.size).toBe(0);
        expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
        const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(phases.find(row => row.phase === 'child.admission' && row.event === 'completed').budget)
          .toMatchObject({ cleanupReserveMs: 120_000, childCutoffEpochMs: mode === 'no-deadline' ? null : deadline - 120_000 });
        if (!successful) expect(phases.some(row => row.phase === 'deps.postverify')).toBe(false);
        if (mode !== 'unverified') expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
      } finally {
        killSpy?.mockRestore();
        if (group) { try { kill(-group, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        } }
        await result;
        await signalShutdown;
        if (owned) rmSync(owned, { recursive: true, force: true });
        if (peer) rmSync(peer, { recursive: true, force: true });
      }
    });

  it.each(['snapshot', 'census', 'child', 'sigint', 'sigkill'] as const)(
    'retains plain CLI ownership and truthful cleanup on cancellation during %s', async phase => {
      const fixture = makeSuperproject(join(tmp, 'verifier-cli-cancel-' + phase));
      git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
      const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
      const preflight = 'scripts/source-preview.mjs';
      const provider = 'scripts/cancellation-fixture.mjs';
      write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
      write(fixture.repo, preflight, "console.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
      write(fixture.repo, helper, [
        '#!/bin/bash', 'set -eu',
        'if [ "$1" = trees ]; then',
        '  if [ "$VERIFIER_CANCEL_PHASE" = census ]; then printf "%s\\n" "$2" > "$VERIFIER_CANCEL_READY"; sleep 1; fi',
        '  echo node_modules; exit', 'fi',
        'if [ "$VERIFIER_CANCEL_PHASE" = snapshot ] || [ "$VERIFIER_CANCEL_PHASE" = sigkill ]; then',
        '  printf "%s\\n" "$3" > "$VERIFIER_CANCEL_READY"; exec sleep 60', 'fi',
        'cp -al -- "$2/node_modules" "$3/node_modules"',
      ].join('\n') + '\n');
      write(fixture.repo, provider, [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, ['-e', `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.env.VERIFIER_CANCEL_READY + '.pid', String(process.pid)); fs.writeFileSync(process.env.VERIFIER_CANCEL_READY, process.cwd()); setInterval(() => {}, 1000);`], { stdio: 'ignore' });",
        "setInterval(() => {}, 1000);",
      ].join('\n'));
      write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
      git(fixture.repo, ['add', helper, preflight, provider, '.gitignore', DEPENDENCY_POLICY_PATH]);
      git(fixture.repo, ['commit', '-qm', 'plain CLI cancellation fixture']);
      const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
      write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
        name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
      write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
      installVerifierTsx(fixture.repo);
      const ready = join(tmp, 'verifier-cli-cancel-ready-' + phase);
      const receiptPath = join(tmp, 'verifier-cli-cancel-source-' + phase + '.json');
      const options = { repo: fixture.repo, ref, receiptPath, inputs: [helper, preflight, provider],
        command: [process.execPath, provider] };
      const cli = new URL('../../../scripts/source-preview.mjs', import.meta.url).href;
      const env = childEnv({ VERIFIER_CANCEL_READY: ready, VERIFIER_CANCEL_PHASE: phase });
      delete env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { runVerifierCommand } from ${JSON.stringify(cli)}; try { process.exitCode = await runVerifierCommand(${JSON.stringify(options)}); } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }`],
      { cwd: fixture.repo, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', bytes => { output += bytes; });
      child.stderr.on('data', bytes => { output += bytes; });
      const closed = once(child, 'close');
      let owned: string | undefined;
      let peer: string | undefined;
      try {
        await vi.waitFor(() => expect(existsSync(ready), output).toBe(true), { timeout: 20_000, interval: 20 });
        owned = dirname(readFileSync(ready, 'utf8').trim());
        const receipt = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
        expect(receipt).toMatchObject({ schemaVersion: 'verifier-task-v1', taskId: null,
          pid: child.pid, repoRoot: fixture.repo, ownedRoot: owned, cleanup: 'pending' });
        expect(receipt.processIdentity).toBeTypeOf('string');
        expect(receipt.processIdentity.length).toBeGreaterThan(0);
        expect(statSync(receiptPath + '.task.json').mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(join(owned!, '.verifier-task.json'), 'utf8'))).toEqual(receipt);
        peer = mkdtempSync(join(dirname(owned!), 'verifier-command-'));
        writeFileSync(join(peer, 'peer-owned'), 'must survive');
        const signal = phase === 'sigkill' ? 'SIGKILL' : phase === 'sigint' ? 'SIGINT' : 'SIGTERM';
        process.kill(phase === 'sigkill' ? -child.pid! : child.pid!, signal);
        const result = await closed;
        const final = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
        if (phase === 'sigkill') {
          expect(result).toEqual([null, 'SIGKILL']);
          expect(final).toEqual(receipt); // A killed finally cannot manufacture cleanup evidence.
          expect(existsSync(owned!)).toBe(true);
        } else {
          expect(result, output).toEqual([phase === 'sigint' ? 130 : 143, null]);
          expect(final).toMatchObject({ ...receipt, cleanup: 'completed', cancellationSignal: signal });
          expect(existsSync(owned!)).toBe(false);
          const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
          expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
          if (phase !== 'child' && phase !== 'sigint') expect(phases.some(row => row.phase === 'child.run')).toBe(false);
          if (existsSync(ready + '.pid')) {
            const pid = readFileSync(ready + '.pid', 'utf8');
            if (existsSync(`/proc/${pid}/stat`))
              expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0]).toMatch(/[ZX]/);
          }
        }
        expect(readFileSync(join(peer, 'peer-owned'), 'utf8')).toBe('must survive');
      } finally {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await closed;
        if (owned) rmSync(owned, { recursive: true, force: true });
        if (peer) rmSync(peer, { recursive: true, force: true });
      }
    });

  it.each([
    ['spawned', 'repo'], ['pending', 'repo'], ['spawned', 'data'], ['pending', 'data'],
  ] as const)('terminal task close cleans a real SIGKILL with %s enrollment in %s scratch and preserves peers', async (enrollment, scratchLocation) => {
    const label = enrollment + '-' + scratchLocation;
    const fixture = makeSuperproject(join(tmp, 'verifier-command-killed-' + label));
    git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(fixture.repo, helper, '#!/bin/bash\nset -eu\nprintf "%s\\n" "$3" > "$VERIFIER_KILL_READY"\nexec sleep 60\n');
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', helper, '.gitignore']);
    git(fixture.repo, ['commit', '-qm', 'kill during verifier preparation']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
    const ready = join(tmp, 'verifier-kill-ready-' + label), taskId = 'verifierkillfixture';
    const cli = new URL('../../../scripts/source-preview.mjs', import.meta.url).href;
    const options = { repo: fixture.repo, ref, receiptPath: join(tmp, 'verifier-kill-source-' + label + '.json'),
      inputs: [helper], command: [process.execPath, '-e', 'process.exit(0)'] };
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { runVerifierCommand } from ${JSON.stringify(cli)}; process.exitCode = await runVerifierCommand(${JSON.stringify(options)});`],
    { cwd: fixture.repo, detached: true, env: childEnv({
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: taskId, VERIFIER_KILL_READY: ready,
    }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const closed = once(child, 'close');
    const cleanupPaths: string[] = [];
    try {
      await vi.waitFor(() => expect(existsSync(ready), output).toBe(true), { timeout: 15_000, interval: 20 });
      let owned = dirname(readFileSync(ready, 'utf8').trim());
      const receipt = JSON.parse(readFileSync(join(owned, '.verifier-task.json'), 'utf8'));
      expect(receipt).toMatchObject({ taskId, pid: child.pid, repoRoot: fixture.repo });
      expect(statSync(join(owned, '.verifier-task.json')).mode & 0o777).toBe(0o600);
      process.kill(-child.pid!, 'SIGKILL');
      expect(await closed).toEqual([null, 'SIGKILL']);
      expect(existsSync(owned)).toBe(true); // The killed process's finally never ran.
      const phases = readFileSync(options.receiptPath + '.phases.jsonl', 'utf8').trim()
        .split('\n').map(line => JSON.parse(line));
      expect(phases.at(-1)).toMatchObject({ phase: 'deps.snapshot', event: 'started', taskId });
      expect(phases.some(row => row.phase === 'child.run')).toBe(false);
      if (scratchLocation === 'data') {
        // The exporter uses this root for root-device donors. Exercise discovery
        // independently of the filesystem on which this synthetic repo lives.
        const relocated = mkdtempSync(join(await fsPromises.realpath('/mnt/data/tmp'), 'verifier-command-'));
        cleanupPaths.push(relocated);
        cpSync(owned, relocated, { recursive: true, verbatimSymlinks: true });
        rmSync(owned, { recursive: true, force: true });
        owned = relocated;
      }
      const scratch = dirname(owned);
      const peer = mkdtempSync(join(scratch, 'verifier-command-'));
      cleanupPaths.push(peer);
      writeFileSync(join(peer, '.verifier-task.json'), JSON.stringify({ ...receipt, taskId: 'peer-task' }));
      const live = mkdtempSync(join(scratch, 'verifier-command-'));
      cleanupPaths.push(live);
      writeVerifierTaskReceipt(live, fixture.repo, { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: taskId });
      const link = join(scratch, 'verifier-command-link-' + label);
      cleanupPaths.push(link);
      symlinkSync(peer, link, 'dir');
      const scopeUnit = 'pc-verifierkillfixture.service';
      const cgroupPath = '/papercusp.slice/papercusp-bash.slice/papercusp-bash-job.slice/' + scopeUnit;
      // Model the payload's kernel membership independently of the asynchronous
      // markSpawned write. The real killed process above supplies the death proof.
      const ownedReceipt = { ...receipt, cgroupPath };
      const row = { task_id: taskId, workspace_id: 'fixture-workspace', root_task_id: taskId,
        class: 'bash-job', cwd: fixture.repo, confined: enrollment === 'spawned',
        state: enrollment === 'spawned' ? 'running' : 'pending', scope_unit: scopeUnit,
        cgroup_path: enrollment === 'spawned' ? cgroupPath : null,
        argv: [], launched_by: 'fixture', ended_at: null };
      const cleanupRow = { taskId, class: 'bash-job', confined: true, cwd: fixture.repo,
        scopeUnit, cgroupPath } as TaskRow;
      for (const changed of [{ taskId: 'other-task' }, { confined: false },
        { scopeUnit: 'wrong-scope.service' }, { cgroupPath: null }]) {
        await cleanupEndedVerifierDirectories({ ...cleanupRow, ...changed });
        expect(existsSync(owned)).toBe(true);
      }
      const receiptPath = join(owned, '.verifier-task.json');
      const receiptCopy = join(tmp, 'verifier-kill-ownership.json');
      writeFileSync(receiptCopy, JSON.stringify(receipt));
      rmSync(receiptPath);
      symlinkSync(receiptCopy, receiptPath);
      await cleanupEndedVerifierDirectories(cleanupRow);
      expect(existsSync(owned)).toBe(true);
      rmSync(receiptPath);
      if (enrollment === 'pending') {
        const pending = { ...cleanupRow, confined: false, cgroupPath: null, state: 'pending' } as TaskRow;
        for (const kernelPath of [null, '/unconfined/' + scopeUnit,
          cgroupPath.replace(taskId, 'peertask'), cgroupPath + '/../../pc-peertask.service']) {
          writeFileSync(receiptPath, JSON.stringify({ ...ownedReceipt, cgroupPath: kernelPath }));
          await cleanupEndedVerifierDirectories(pending);
          expect(existsSync(owned)).toBe(true);
        }
      }
      writeFileSync(receiptPath, JSON.stringify(ownedReceipt));
      let updated = false;
      const sql = (async (strings: TemplateStringsArray) => {
        if (strings.join('').includes('UPDATE harness_shared.task_ledger')) {
          expect(existsSync(owned)).toBe(false); // Cleanup precedes terminal persistence.
          updated = true;
        }
        return [row];
      }) as unknown as Sql;
      await expect(closeTask(taskId, { state: 'killed', exitCode: 137 }, sql,
        { emitTerminal: vi.fn() })).resolves.toBe(true);
      expect(updated).toBe(true);
      expect(existsSync(peer)).toBe(true);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(link)).toBe(true);
      await cleanupEndedVerifierDirectories({ taskId, class: 'bash-job', confined: true,
        cwd: fixture.repo, scopeUnit: row.scope_unit, cgroupPath: row.cgroup_path } as TaskRow);
      expect(existsSync(peer)).toBe(true);
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await closed;
      for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
    }
  });

  it('refuses dirty inputs before running any provider command and rejects missing CLI commands', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-command-dirty'));
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', '.gitignore']); git(fixture.repo, ['commit', '-qm', 'ignored verifier scratch']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = 'apps/operator/src/index.ts';
    writeFileSync(join(fixture.repo, input), 'dirty before provider allocation');
    const marker = join(tmp, 'refused-provider-marker');
    const receiptPath = join(tmp, 'refused-provider-receipt.json');
    await expect(runVerifierCommand({ repo: fixture.repo, ref, inputs: [input], receiptPath,
      command: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "allocated")', marker] }))
      .rejects.toThrow('dirty tested-input mismatch: ' + input);
    expect(existsSync(marker)).toBe(false); expect(existsSync(receiptPath)).toBe(false);
    expect(readdirSync(join(fixture.repo, '.papercusp/scratch'))).toEqual([]);
    const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim()
      .split('\n').map(line => JSON.parse(line));
    expect(phases.find(row => row.event === 'failed')).toMatchObject({
      phase: 'source.freeze', error: expect.stringContaining('dirty tested-input mismatch'),
    });
    expect(phases.some(row => row.phase === 'deps.snapshot' || row.phase === 'child.run')).toBe(false);
    expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
    const retained = readFileSync(receiptPath + '.phases.jsonl', 'utf8');
    await expect(runVerifierCommand({ repo: fixture.repo, ref, inputs: [input], receiptPath,
      command: [process.execPath, '-e', 'process.exit(0)'] })).rejects.toThrow('EEXIST');
    expect(readFileSync(receiptPath + '.phases.jsonl', 'utf8')).toBe(retained);
    expect(readdirSync(join(fixture.repo, '.papercusp/scratch'))).toEqual([]);
    await expect(runCli(['verifier-run', '--repo', fixture.repo, '--ref', ref, '--receipt', receiptPath,
      '--inputs', input, '--'])).rejects.toThrow('and -- <command>');
  });

  it('preserves unlisted gitlinks and original named mappings in a real verifier checkout', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-unlisted-fixture'));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const unlisted = 'apps/unlisted';
    git(fixture.repo, ['clone', '--quiet', '--shared', '--', fixture.subSrc, unlisted]);
    git(fixture.repo, ['update-index', '--add', '--cacheinfo', `160000,${fixture.subCommit},${unlisted}`]);
    git(fixture.repo, ['commit', '-m', 'unlisted verifier gitlink']);
    const mappings = readFileSync(join(fixture.repo, '.gitmodules'));
    const head = git(fixture.repo, ['rev-parse', 'HEAD']);
    const archive = await prepareVerifierSource({ repo: fixture.repo, ref: head,
      dest: join(tmp, 'verifier-unlisted-archive'), inputs: [input] });
    const dest = join(tmp, 'verifier-unlisted-checkout');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: head,
      dest, inputs: [input], gitCheckout: true });
    expect(receipt.files).toEqual(archive.files);
    expect(receipt.submodules).toEqual(archive.submodules);
    expect(readFileSync(join(dest, '.gitmodules'))).toEqual(mappings);
    expect(git(join(dest, unlisted), ['rev-parse', 'HEAD'])).toBe(fixture.subCommit);
    expect(git(dest, ['ls-files', '--recurse-submodules'])).toContain('libs/papercusp/package.json');
    expect(git(dest, ['config', '--get-regexp', '^submodule\\..*\\.url$'])).not.toContain(unlisted);
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
    git(join(dest, unlisted), ['rm', '--cached', '--', 'package.json']);
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification Git checkout');
  });

  it('prepares a real verifier checkout from a relative repository path', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-relative-repo-fixture'));
    git(fixture.repo, ['commit', '--allow-empty', '-m', 'with parent']);
    const head = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const dest = join(tmp, 'verifier-relative-repo-checkout');
    const receipt = await prepareVerifierSource({
      repo: relative(process.cwd(), fixture.repo), ref: head, dest,
      inputs: [input], gitCheckout: true,
    });
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(dest, input))).toEqual(readFileSync(join(fixture.repo, input)));
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
  });

  it('refuses an unreadable parent or submodule checkout before verification runs', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-checkout-parent-fixture'));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const noParent = join(tmp, 'verifier-checkout-no-parent');
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest: noParent,
      inputs: [input], gitCheckout: true })).rejects.toThrow('HEAD^');
    expect(existsSync(noParent)).toBe(false);

    git(fixture.repo, ['commit', '--allow-empty', '-m', 'with parent']);
    const dest = join(tmp, 'verifier-checkout-submodule');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest, inputs: [input], gitCheckout: true });
    const submodule = receipt.submodules[0];
    writeFileSync(join(dest, submodule.path, '.git', 'HEAD'), 'invalid checkout identity\n');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('verification Git');
  });

  it('refuses an older committed tested input and cleans the incomplete export', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-dirty-fixture'));
    const dest = join(tmp, 'verifier-dirty-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    writeFileSync(join(fixture.repo, input), 'uncommitted acceptance change');
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] }))
      .rejects.toThrow('dirty tested-input mismatch');
    expect(existsSync(dest)).toBe(false);
  });

  it.each([false, true])('refuses dirty input before materialization (gitCheckout=%s)', async (gitCheckout) => {
    const fixture = makeSuperproject(join(tmp, `verifier-early-dirty-${gitCheckout}`));
    const dest = join(tmp, `verifier-early-dirty-export-${gitCheckout}`);
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    writeFileSync(join(fixture.repo, input), 'uncommitted acceptance change');
    // An archive/clone would encounter this unrelated broken checkout first.
    // The dirty-input diagnostic must win without creating the destination.
    rmSync(join(fixture.repo, 'libs/papercusp/.git'), { recursive: true, force: true });
    const mkdir = vi.spyOn(fsPromises, 'mkdir');
    try {
      await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit,
        dest, inputs: [input], gitCheckout })).rejects.toThrow('dirty tested-input mismatch');
      expect(mkdir.mock.calls.some(([path]) => path === dest)).toBe(false);
      expect(existsSync(dest)).toBe(false);
    } finally {
      mkdir.mockRestore();
    }
  });

  it('refuses missing, altered provenance and extra archive files', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-provenance-fixture'));
    const dest = join(tmp, 'verifier-provenance-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    await expect(verifyVerifierSource(dest, undefined as never)).rejects.toThrow('missing verification source provenance');
    writeFileSync(join(dest, '.verifier-source.json'), '{}');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source provenance');
    writeFileSync(join(dest, '.verifier-source.json'), JSON.stringify(receipt));
    writeFileSync(join(dest, 'extra.ts'), 'unexpected');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source archive: added extra.ts');
  });

  it('never excludes recorded files under runtime directories from the source verdict', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-runtime-recorded-fixture'));
    const dest = join(tmp, 'verifier-runtime-recorded-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const recorded = receipt.files.find(file => file.path.startsWith('node_modules/'))!;
    expect(recorded).toBeDefined();
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, recorded.path), 'changed recorded dependency source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('tampered verification source archive');
  });

  it('rebuilds committed verifier output separately while still rejecting source tampering', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-committed-bundle-fixture'));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const output = 'apps/operator/dist-verify/hono-host.mjs';
    write(fixture.repo, output, 'old generated host');
    git(fixture.repo, ['add', output]);
    git(fixture.repo, ['commit', '-qm', 'record generated host']);
    const dest = join(tmp, 'verifier-committed-bundle-export');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest, inputs: [input] });
    expect(receipt.files.some(file => file.path.startsWith('apps/operator/dist-verify/'))).toBe(false);
    expect(existsSync(join(dest, output))).toBe(false);
    write(dest, output, 'rebuilt private host');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'tampered source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest: join(tmp, 'refused-runtime-input'), inputs: [output] }))
      .rejects.toThrow('generated verifier runtime output cannot be a tested source input');
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest: join(tmp, 'refused-runtime-checkout'), inputs: [input], gitCheckout: true }))
      .rejects.toThrow('committed verifier runtime output requires archive export');
  });

  it('rejects a symlink posing as an independent runtime directory', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-runtime-link-fixture'));
    const dest = join(tmp, 'verifier-runtime-link-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    symlinkSync(join(dest, 'apps/operator/src'), join(dest, 'apps/operator/dist-verify'));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent directory');
  });

  it('allows an unrecorded generated router tree only for runtime source attestation', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-router-runtime-fixture'));
    const dest = join(tmp, 'verifier-router-runtime-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, 'apps/operator-vite/src/routeTree.gen.ts', 'generated from recorded routes');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('added apps/operator-vite/src/routeTree.gen.ts');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded route source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it('allows only the exact unrecorded Vitest result cache during runtime source attestation', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-vitest-cache-fixture'));
    const dest = join(tmp, 'verifier-vitest-cache-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, VITEST_RESULT_CACHE, '{"results":[]}');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow(`added ${VITEST_RESULT_CACHE}`);
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    const unexpected = VITEST_RESULT_CACHE.replace('results.json', 'extra.ts');
    write(dest, unexpected, 'export const unexpected = true;');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`added ${unexpected}`);
  });

  it('rejects result cache paths outside the Vitest hash namespace', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-vitest-cache-invalid-fixture'));
    const dest = join(tmp, 'verifier-vitest-cache-invalid-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const unexpected = 'packages/operator-core/.vitest-tmp/vitest/not-a-hash/results.json';
    write(dest, unexpected, '{"results":[]}');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`added ${unexpected}`);
  });

  it('allows SPA prebuild mirrors through the later host source census without hiding public source', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-spa-runtime-fixture'));
    const dest = join(tmp, 'verifier-spa-runtime-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    for (const artifact of SPA_RUNTIME_FILES) write(dest, artifact, 'generated SPA runtime asset');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source archive');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    for (const unexpected of [
      'apps/operator/public/unexpected.js',
      'apps/operator/public/ort-wasm-unexpected.ts',
      'apps/operator/public/silero_vad_unexpected.onnx',
      'apps/operator/public/excalidraw-extra/chunk.js',
    ]) {
      write(dest, unexpected, 'unexpected source');
      await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`added ${unexpected}`);
      rmSync(join(dest, unexpected));
    }
    writeFileSync(join(dest, input), 'changed recorded source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it.each(['apps/operator-vite/src/routeTree.gen.ts', '.papercusp-pinned-deps', 'libs/generic/sse/dist/index.js', 'packages/omp-plugin/dist/native-extension.mjs', VITEST_RESULT_CACHE, ...NATIVE_RUNTIME_FILES, ...SPA_RUNTIME_FILES])('never excludes recorded output from source attestation: %s', async input => {
    const suffix = input.replaceAll('/', '-');
    const fixture = makeSuperproject(join(tmp, `verifier-output-recorded-${suffix}`));
    write(fixture.repo, input, 'recorded route tree');
    git(fixture.repo, ['add', input]);
    git(fixture.repo, ['commit', '-qm', 'recorded route tree fixture']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const dest = join(tmp, `verifier-output-recorded-export-${suffix}`);
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref, dest, inputs: [input] });
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded route tree');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it('accepts unrecorded pinned dependency output while still detecting recorded source changes', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-pinned-output-fixture'));
    const input = 'libs/generic/sse/src/index.ts';
    write(fixture.repo, input, 'export const source = true;');
    git(fixture.repo, ['add', input]);
    git(fixture.repo, ['commit', '-qm', 'pinned runtime source fixture']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const dest = join(tmp, 'verifier-pinned-output-export');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref, dest, inputs: [input] });
    write(dest, '.papercusp-pinned-deps', 'immutable dependency receipt');
    write(dest, 'libs/generic/sse/dist/index.js', 'export const source = true;');
    write(dest, 'packages/omp-plugin/dist/native-extension.mjs', 'export const source = true;');
    for (const artifact of NATIVE_RUNTIME_FILES) write(dest, artifact, 'generated native build output');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('added .papercusp-pinned-deps');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it.each(['.papercusp-pinned-deps', 'libs/generic/sse/dist', 'packages/omp-plugin/dist', 'papercusp-desktop/src-tauri/gen/schemas', VITEST_RESULT_CACHE, ...NATIVE_RUNTIME_FILES.filter(path => path.endsWith('PLACEHOLDER-README.txt') || path.endsWith('sidecar.lock')), ...new Set(SPA_RUNTIME_FILES.map(path => path.split('/').slice(0, 4).join('/')))])('rejects a redirect posing as runtime output: %s', async artifact => {
    const fixture = makeSuperproject(join(tmp, `verifier-output-link-${artifact.replaceAll('/', '-')}`));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const dest = join(tmp, `verifier-output-link-export-${artifact.replaceAll('/', '-')}`);
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, artifact, 'placeholder');
    rmSync(join(dest, artifact));
    symlinkSync(join(dest, input), join(dest, artifact));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent');
  });

  it('rejects a symlink posing as an unrecorded generated router tree', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-router-link-fixture'));
    const dest = join(tmp, 'verifier-router-link-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, 'apps/operator-vite/src/routeTree.gen.ts', 'placeholder');
    rmSync(join(dest, 'apps/operator-vite/src/routeTree.gen.ts'));
    symlinkSync(join(dest, input), join(dest, 'apps/operator-vite/src/routeTree.gen.ts'));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent file');
  });

  it('refuses incomplete icon ESM content before verifier input admission and accepts restored content', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-incomplete-icon-content'));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    write(fixture.repo, 'package-lock.json', JSON.stringify({
      packages: { 'node_modules/react-icons': { version: '5.6.0' } },
    }));
    write(fixture.repo, 'node_modules/react-icons/package.json', JSON.stringify({
      name: 'react-icons', exports: { './ai': './ai/index.mjs' },
    }));
    write(fixture.repo, 'node_modules/react-icons/ai/index.mjs', "export { IconBase } from '../lib/index.mjs';");
    const args = ['verifier-inputs-check', '--repo', fixture.repo, '--ref', fixture.commit, '--inputs', input];
    await expect(runCli(args)).rejects.toThrow(/RUNTIME_DEPS_UNUSABLE[\s\S]*react-icons\/ai/);
    write(fixture.repo, 'node_modules/react-icons/lib/index.mjs', 'export const IconBase = {};');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(await runCli(args)).toBe(0); }
    finally { output.mockRestore(); }
  });

  it('checks committed inputs without allocating a snapshot and rejects later source edits', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-input-check-fixture'));
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const before = readdirSync(tmp).sort();
    const result = await validateVerifierInputs({ repo: fixture.repo, ref: fixture.commit, inputs: [input] });
    expect(result.sha).toBe(fixture.commit);
    expect(result.paths).toEqual([input]);
    expect(readdirSync(tmp).sort()).toEqual(before);
    writeFileSync(join(fixture.repo, input), 'changed after commit');
    await expect(validateVerifierInputs({ repo: fixture.repo, ref: fixture.commit, inputs: [input] }))
      .rejects.toThrow(`dirty tested-input mismatch: ${input}`);
    expect(readdirSync(tmp).sort()).toEqual(before);
  });

  it('shares native tooling validation with preparation and refuses drift before allocating', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-tauri-inputs-fixture'));
    for (const path of TAURI_VERIFIER_INPUTS) write(fixture.repo, path, `// ${path}\n`);
    git(fixture.repo, ['add', ...TAURI_VERIFIER_INPUTS]);
    git(fixture.repo, ['commit', '-qm', 'native tooling inputs']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const inputsFile = join(tmp, 'verifier-tauri-inputs.json');
    writeFileSync(inputsFile, JSON.stringify([input]));
    const options = { repo: fixture.repo, ref, inputsFile, tauriInputs: true };
    const checked = await validateVerifierInputs(options);
    expect(checked.paths).toEqual([...new Set([input, ...TAURI_VERIFIER_INPUTS])].sort());
    const dest = join(tmp, 'verifier-tauri-inputs-export');
    const receipt = await prepareVerifierSource({ ...options, dest });
    expect(receipt.testedInputs.map(row => row.path)).toEqual(checked.paths);

    for (const [index, helper] of [
      'apps/operator/bin/release/dependency-generation.sh',
      'packages/operator-core/lib/testing-native-runtime.ts',
      'packages/operator-core/lib/testing-playwright-reporter.ts',
      'scripts/lib/run-in-isolated-netns.sh',
    ].entries()) {
      writeFileSync(join(fixture.repo, helper), 'changed native tooling after commit');
      const refused = join(tmp, `verifier-tauri-inputs-refused-${index}`);
      await expect(validateVerifierInputs(options)).rejects.toThrow(`dirty tested-input mismatch: ${helper}`);
      await expect(prepareVerifierSource({ ...options, dest: refused }))
        .rejects.toThrow(`dirty tested-input mismatch: ${helper}`);
      expect(existsSync(refused)).toBe(false);
      writeFileSync(join(fixture.repo, helper), `// ${helper}\n`);
    }
    await expect(validateVerifierInputs({ repo: fixture.repo, ref, tauriInputs: true }))
      .rejects.toThrow('verification export needs explicit tested inputs');
  });

  it('refuses tracked source symlinks that read outside the immutable export', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-link-fixture'));
    symlinkSync('/tmp/live-peer-source.ts', join(fixture.repo, 'outside-source'));
    git(fixture.repo, ['add', 'outside-source']);
    git(fixture.repo, ['commit', '-qm', 'outside source fixture']);
    const dest = join(tmp, 'verifier-link-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest, inputs: [input] }))
      .rejects.toThrow('archive symlink escapes source root');
    expect(existsSync(dest)).toBe(false);
  });
});

describe('D044 independent operator-api input handoff', () => {
  let fixture: Superproject;
  const input = 'apps/operator/src/index.ts';
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

  beforeAll(() => {
    fixture = makeSuperproject(join(tmp, 'd044-fixture'));
    // These fixture dependencies are normally tracked. The independent donor
    // must materialize its own dependencies after capturing source membership.
    git(fixture.repo, ['rm', '-r', 'node_modules', 'apps/operator/node_modules']);
    git(fixture.repo, ['commit', '-qm', 'independent materialization fixture']);
    fixture.commit = git(fixture.repo, ['rev-parse', 'HEAD']);
  });

  async function handoff() {
    const evidence = mkdtempSync(join(tmp, 'd044-case-'));
    const root = join(evidence, 'donor');
    const source = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit,
      dest: root, inputs: [input] });
    const sourceReceiptPath = join(evidence, 'source.json');
    writeFileSync(sourceReceiptPath, JSON.stringify(source));
    write(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    symlinkSync('pkg/index.js', join(root, 'node_modules/relative.js'));
    const planned = {
      phase: 'planned', sourceCommit: source.sourceCommit, testPaths: [input],
      helperPaths: ['packages/core/index.ts'], configPaths: ['package-lock.json'],
      executedImports: [input], copiedSources: ['packages/core/index.ts'],
      copiedArtifacts: [{ path: 'copied-helper.ts', sourcePath: 'packages/core/index.ts' }],
      dependencyFiles: verifierSourceFiles(join(root, 'node_modules')),
      externalResolutions: { pkg: 'node_modules/pkg/index.js' },
      schema: { private: 'synthetic-applied-schema' }, environment: { MODE: digest('synthetic') },
      omitted: [] as string[], opaque: [] as string[],
    };
    const operatorApi = { root, sourceReceiptPath, sourceReceiptSha256: digest(readFileSync(sourceReceiptPath)),
      inputReceiptPath: join(evidence, 'planned.json'), inputReceiptSha256: '',
      outputPath: join(evidence, 'operator-api-preflight.json') };
    const repin = () => {
      writeFileSync(operatorApi.inputReceiptPath, JSON.stringify(planned));
      operatorApi.inputReceiptSha256 = digest(readFileSync(operatorApi.inputReceiptPath));
    };
    repin();
    const dest = join(evidence, 'export');
    return { planned, operatorApi, source, sourceReceiptPath, repin, dest,
      prepare: () => prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit,
        dest, inputs: [input], operatorApi }) };
  }

  it('copies pinned dependencies and relative symlinks and hands off the exact independent bytes', async () => {
    const c = await handoff();
    const receipt = await c.prepare();
    expect(receipt.operatorApiInputs).toEqual({ path: c.operatorApi.outputPath,
      sha256: c.operatorApi.inputReceiptSha256 });
    expect(readFileSync(c.operatorApi.outputPath)).toEqual(readFileSync(c.operatorApi.inputReceiptPath));
    expect(verifierSourceFiles(join(c.dest, 'node_modules'))).toEqual(c.planned.dependencyFiles);
    expect(await verifyVerifierSource(c.dest, receipt)).toEqual(receipt);
    const receiptPath = join(c.dest, '..', 'export-source.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(verifierSourceChildEnv({ root: c.dest, receiptPath }).VERIFY_TAURI_SOURCE_RECEIPT).toBe(receiptPath);
    writeFileSync(c.operatorApi.outputPath, '{}');
    expect(() => verifierSourceChildEnv({ root: c.dest, receiptPath })).toThrow('Pinned operator-api receipt changed');
  });

  it.each(['executedImports', 'schema', 'environment'] as const)(
    'refuses an absent independent %s observation before allocating the export', async key => {
      const c = await handoff();
      Object.assign(c.planned, { [key]: key === 'executedImports' ? [] : {} });
      c.repin();
      await expect(c.prepare()).rejects.toThrow('required observation missing');
      expect(existsSync(c.dest)).toBe(false);
      expect(existsSync(c.operatorApi.outputPath)).toBe(false);
    });

  it.each(['omitted', 'opaque'] as const)('refuses a required %s dimension before effects', async key => {
    const c = await handoff();
    c.planned[key].push('loaded-host');
    c.repin();
    await expect(c.prepare()).rejects.toThrow(`required dimensions ${key}`);
    expect(existsSync(c.dest)).toBe(false);
  });

  it('requires observed imports separately from static copied source membership', async () => {
    const c = await handoff();
    c.planned.executedImports = ['absent-observed-import.ts'];
    c.repin();
    await expect(c.prepare()).rejects.toThrow('source outside selected archive');
    expect(existsSync(c.dest)).toBe(false);
  });

  it.each(['source', 'dependency', 'receipt'] as const)('refuses %s byte drift before effects', async kind => {
    const c = await handoff();
    if (kind === 'source') writeFileSync(join(c.operatorApi.root, input), 'source drift');
    if (kind === 'dependency') writeFileSync(join(c.operatorApi.root, 'node_modules/pkg/index.js'), 'dependency drift');
    if (kind === 'receipt') writeFileSync(c.operatorApi.inputReceiptPath, '{}');
    await expect(c.prepare()).rejects.toThrow(/changed|census differs/);
    expect(existsSync(c.dest)).toBe(false);
    expect(existsSync(c.operatorApi.outputPath)).toBe(false);
  });

  it('refuses a selected tested-input pin that differs from the archived file', async () => {
    const c = await handoff();
    c.source.testedInputs[0].sha256 = '0'.repeat(64);
    writeFileSync(c.sourceReceiptPath, JSON.stringify(c.source));
    c.operatorApi.sourceReceiptSha256 = digest(readFileSync(c.sourceReceiptPath));
    await expect(c.prepare()).rejects.toThrow('tampered verification source provenance');
    expect(existsSync(c.dest)).toBe(false);
  });

  it('refuses absolute donor dependency links before allocation rather than rebasing their identity', async () => {
    const c = await handoff();
    const target = join(c.operatorApi.root, 'node_modules/pkg/index.js');
    symlinkSync(target, join(c.operatorApi.root, 'node_modules/absolute.js'));
    // Pin the supplied malformed identity without asking the maintained census
    // to validate it before the exporter gets a chance to refuse it.
    c.planned.dependencyFiles.push({ path: 'absolute.js', kind: 'symlink', executable: true, sha256: digest(target) });
    c.repin();
    const copy = vi.spyOn(fsPromises, 'cp');
    try {
      await expect(c.prepare()).rejects.toThrow('archive symlink escapes source root: absolute.js');
      expect(copy).not.toHaveBeenCalled();
      expect(existsSync(c.dest)).toBe(false);
      expect(existsSync(c.operatorApi.outputPath)).toBe(false);
    } finally { copy.mockRestore(); }
  });

  it('refuses a dependency link into an ambient tree before effects', async () => {
    const c = await handoff();
    symlinkSync('../../source.json', join(c.operatorApi.root, 'node_modules/ambient.js'));
    c.planned.dependencyFiles.push({ path: 'ambient.js', kind: 'symlink', executable: true,
      sha256: digest('../../source.json') });
    c.repin();
    await expect(c.prepare()).rejects.toThrow('archive symlink escapes source root: ambient.js');
    expect(existsSync(c.dest)).toBe(false);
  });

  it('refuses an internal handoff path even when reached through a symlinked parent', async () => {
    const c = await handoff();
    symlinkSync(c.dest, join(c.dest, '..', 'export-alias'));
    c.operatorApi.outputPath = join(c.dest, '..', 'export-alias', 'operator-api-preflight.json');
    await expect(c.prepare()).rejects.toThrow('receipt must be outside the archive');
    expect(existsSync(c.dest)).toBe(false);
  });

  it.each(['donor-source', 'export-source', 'planned-receipt'] as const)(
    'removes the new export when %s drifts during dependency copy', async kind => {
      const c = await handoff();
      const original = fsPromises.cp;
      const copy = vi.spyOn(fsPromises, 'cp').mockImplementation(async (...args) => {
        await original(...args);
        if (kind === 'donor-source') writeFileSync(join(c.operatorApi.root, input), 'racing source');
        if (kind === 'export-source') writeFileSync(join(c.dest, input), 'racing source');
        if (kind === 'planned-receipt') writeFileSync(c.operatorApi.inputReceiptPath, '{}');
      });
      try {
        await expect(c.prepare()).rejects.toThrow(/changed/);
        expect(existsSync(c.dest)).toBe(false);
        expect(existsSync(c.operatorApi.outputPath)).toBe(false);
      } finally { copy.mockRestore(); }
    });

  it.each(['partial-write', 'post-write-source-drift'] as const)(
    'removes only its newly created handoff after %s', async kind => {
      const c = await handoff();
      const original = fsPromises.open;
      const open = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args);
        if (args[0] === c.operatorApi.outputPath) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...writeArgs) => {
            await write(...writeArgs);
            if (kind === 'partial-write') throw new Error('synthetic partial handoff write');
            writeFileSync(join(c.dest, input), 'post-write source drift');
          };
        }
        return handle;
      });
      try {
        await expect(c.prepare()).rejects.toThrow(/synthetic partial handoff write|changed/);
        expect(existsSync(c.dest)).toBe(false);
        expect(existsSync(c.operatorApi.outputPath)).toBe(false);
      } finally { open.mockRestore(); }
    });

  it('preserves a preexisting handoff that wins the exclusive-create race', async () => {
    const c = await handoff();
    const original = fsPromises.cp;
    const copy = vi.spyOn(fsPromises, 'cp').mockImplementation(async (...args) => {
      await original(...args);
      writeFileSync(c.operatorApi.outputPath, 'independent existing handoff');
    });
    try {
      await expect(c.prepare()).rejects.toThrow(/EEXIST/);
      expect(existsSync(c.dest)).toBe(false);
      expect(readFileSync(c.operatorApi.outputPath, 'utf8')).toBe('independent existing handoff');
    } finally { copy.mockRestore(); }
  });

  it('preserves complete source-only export without an operator-api handoff', async () => {
    const dest = join(tmp, 'd044-source-only');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    expect(receipt.operatorApiInputs).toBeUndefined();
    expect(await verifyVerifierSource(dest, receipt)).toEqual(receipt);
    expect(verifierSourceFiles(dest).filter(file => file.path !== '.verifier-source.json')).toEqual(receipt.files);
  });
});

describe('source-preview export — R-3 pinned, history-free snapshot', () => {
  it('records the superproject commit and every exported submodule gitlink in MANIFEST.json', () => {
    const onDisk = JSON.parse(readFileSync(join(out, 'MANIFEST.json'), 'utf8'));
    expect(onDisk).toEqual(manifest);
    expect(manifest.source.commit).toBe(fx.commit);
    expect(manifest.submodules).toEqual([{ path: 'libs/papercusp', sha: fx.subCommit }]);
    expect(manifest.fileCount).toBe(listFiles(out).length - ADDED_FILES.length);
  });

  it('refuses an unresolvable gitlink and leaves no export behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-ghost-'));
    try {
      const ghost = makeSuperproject(root);
      git(ghost.repo, ['update-index', '--cacheinfo', `160000,${'1'.repeat(40)},libs/papercusp`]);
      git(ghost.repo, ['commit', '-q', '-m', 'point the gitlink at a commit that does not exist']);
      const target = join(root, 'export');
      await expect(exportSnapshot({ repoRoot: ghost.repo, ref: 'main', out: target, env: childEnv() }))
        .rejects.toThrow(/unresolvable gitlink libs\/papercusp/);
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(root).filter((n) => n.startsWith('export.partial'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('is deterministic: exporting the same commit twice yields identical bytes', async () => {
    const again = join(tmp, 'export-again');
    await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: again, env: childEnv() });
    const a = listFiles(out);
    expect(listFiles(again)).toEqual(a);
    for (const f of a) expect(readFileSync(join(again, f)), f).toEqual(readFileSync(join(out, f)));
  }, 120_000);

  it('exports only committed content, never uncommitted working-tree edits', async () => {
    write(fx.repo, 'apps/operator/src/index.ts', 'export const x = "uncommitted";\n');
    try {
      const snap = join(tmp, 'export-dirty');
      await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: snap, env: childEnv() });
      expect(readFileSync(join(snap, 'apps/operator/src/index.ts'), 'utf8')).toBe('export const x = 1;\n');
    } finally {
      git(fx.repo, ['checkout', '--', 'apps/operator/src/index.ts']);
    }
  }, 120_000);

  it('uses the pinned dependency graph and leaves dirty source, index and branch unchanged (D-007)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-pin-'));
    try {
      const pinned = makeSuperproject(root);
      const pinnedLock = JSON.stringify({ lockfileVersion: 3, packages: {
        'node_modules/pinned-dependency': { version: '1.0.0', license: 'MIT' },
      } });
      write(pinned.repo, 'package-lock.json', pinnedLock);
      git(pinned.repo, ['add', 'package-lock.json']);
      git(pinned.repo, ['commit', '-q', '-m', 'pin dependency graph']);
      const ref = git(pinned.repo, ['rev-parse', 'HEAD']);
      // The installed/working tree deliberately disagrees with the pinned graph.
      write(pinned.repo, 'package-lock.json', '{"packages":{"node_modules/integration-only":{"version":"2"}}}\n');
      write(pinned.repo, 'node_modules/integration-only/index.js', 'module.exports = "integration-only";\n');
      write(pinned.repo, 'apps/operator/src/index.ts', 'export const staged = true;\n');
      git(pinned.repo, ['add', 'apps/operator/src/index.ts']);
      const state = () => ({
        head: git(pinned.repo, ['rev-parse', 'HEAD']),
        branch: git(pinned.repo, ['symbolic-ref', 'HEAD']),
        index: git(pinned.repo, ['diff', '--cached', '--binary']),
        worktree: git(pinned.repo, ['diff', '--binary']),
      });
      const before = state();
      expect(before.index).toContain('staged = true');
      expect(before.worktree).toContain('integration-only');
      const target = join(root, 'export');
      const { manifest: receipt } = await exportSnapshot({ repoRoot: pinned.repo, ref, out: target, env: childEnv() });
      expect(receipt.source.commit).toBe(ref);
      expect(receipt.submodules).toEqual([{ path: 'libs/papercusp', sha: pinned.subCommit }]);
      expect(readFileSync(join(target, 'package-lock.json'), 'utf8')).toBe(pinnedLock);
      expect(readFileSync(join(target, 'apps/operator/src/index.ts'), 'utf8')).toBe('export const x = 1;\n');
      expect(existsSync(join(target, 'node_modules'))).toBe(false);
      expect(readFileSync(join(pinned.repo, 'node_modules/integration-only/index.js'), 'utf8'))
        .toBe('module.exports = "integration-only";\n');
      expect(state()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('source-preview export — R-4 evaluation notice', () => {
  it('writes a NOTICE restricting use to evaluation and forbidding redistribution', () => {
    const notice = readFileSync(join(out, 'NOTICE'), 'utf8');
    expect(notice).toMatch(/EVALUATION ONLY/);
    expect(notice).toMatch(/may not redistribute/);
    expect(notice).toContain(fx.commit);
  });

  it('dates the copyright from real history, not a fixed-date repair-queue admission commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-year-'));
    try {
      const repo = makeSuperproject(root).repo;
      const real = Number(git(repo, ['show', '-s', '--format=%cd', '--date=format:%Y', 'HEAD']));
      const fixed = '2000-01-01T00:00:00Z';
      const r = spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'admit 1 path(s) onto frozen lineage'], {
        encoding: 'utf8',
        env: childEnv({
          GIT_AUTHOR_NAME: 'gate', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_AUTHOR_DATE: fixed,
          GIT_COMMITTER_NAME: 'gate', GIT_COMMITTER_EMAIL: 'gate@example.invalid', GIT_COMMITTER_DATE: fixed,
        }),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(git(repo, ['show', '-s', '--format=%cd', '--date=format:%Y', 'HEAD'])).toBe('2000');
      expect(sourceYear(repo, git(repo, ['rev-parse', 'HEAD']))).toBe(real);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes README.md naming the snapshot and the workspaces it contains', () => {
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain(fx.commit);
    expect(readme).toContain('`apps/operator`');
    expect(readme).toContain('the operator host');
  });

  it('links the releases page and explains how and why the release carries this source', () => {
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('[Papercusp releases page](https://releases.example.invalid/fixture/index.html)');
    expect(readme).toMatch(/## How this source ships inside every release[\s\S]*`sidecar\/source\.tar\.zst`/);
    expect(readme).toMatch(/## Why the release carries its own source/);
  });

  it('refuses to export without a release host rather than publish a README with no download link', async () => {
    const target = join(tmp, 'export-no-release-host');
    await expect(exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: target, env: childEnv({ PAPERCUSP_UPDATE_BASE_URL: '' }) }))
      .rejects.toThrow(/PAPERCUSP_UPDATE_BASE_URL is unset/);
    expect(existsSync(target)).toBe(false);
  });
});

describe('source-preview export — release host resolution', () => {
  it('fills the base URL from the release-host file only when the environment is silent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-preview-release-host-'));
    try {
      const file = join(dir, 'release-host.env');
      writeFileSync(file, '# comment\nPAPERCUSP_RELEASE_HOST=https://file.example.invalid/x\nPAPERCUSP_UPDATE_BASE_URL=https://file.example.invalid/x\n');
      const silent: NodeJS.ProcessEnv = {};
      loadReleaseHost(silent, file);
      expect(silent).toEqual({ PAPERCUSP_UPDATE_BASE_URL: 'https://file.example.invalid/x' });
      const exported: NodeJS.ProcessEnv = { PAPERCUSP_UPDATE_BASE_URL: 'https://env.example.invalid/y' };
      loadReleaseHost(exported, file);
      expect(releasesPageUrl(exported)).toBe('https://env.example.invalid/y/index.html');
      const none: NodeJS.ProcessEnv = {};
      loadReleaseHost(none, join(dir, 'missing.env'));
      expect(() => releasesPageUrl(none)).toThrow(/unset/);
      expect(() => releasesPageUrl({ PAPERCUSP_UPDATE_BASE_URL: 'http://plain.example.invalid' })).toThrow(/not an https URL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
