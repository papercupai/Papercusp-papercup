/**
 * Regression coverage for setup-release-checkout.sh `need_node_modules()` — the
 * deploy-pipeline staleness heuristic that decides whether the release /
 * green-checkpoint tree must re-hardlink-copy node_modules from the integration
 * tree (it "never npm installs" by design — apps/operator/bin/release/setup-release-checkout.sh).
 *
 * EI-935 (F-FIX-035): a new TOP-LEVEL, NON-scoped dependency (e.g. `rrule`) was
 * invisible to the original per-`@scope` diff, so a stale node_modules never
 * gained it — `Cannot find package 'rrule'` crashed the green-checkpoint AND would
 * crash the deployed operator at import time, blocking EVERY deploy until someone
 * hand-copied the dep. The fix diffs the FULL top-level listing (scoped + non-scoped)
 * and falls back to a lockfile compare. This locks that behaviour so the class can't
 * silently regress and re-wedge the pipeline.
 *
 * Both the deploy (deploy-deps.realDeps.runSetup) and the green-checkpoint
 * (green-checkpoint.realCheckpointDeps.setupTree) shell THIS script with
 * `--node-modules auto`, so this one function gates both paths.
 *
 * The function reads its inputs from the script-level globals INTEGRATION_ROOT /
 * RELEASE_ROOT / NODE_MODULES_MODE. We extract just the function from the real
 * script (so the test tracks the shipped logic, never a copy) and invoke it under
 * controlled temp trees — the same isolation pattern as verify-release-paths.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  statSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  openSync,
  closeSync,
  utimesSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// apps/operator/lib/release → apps/operator/bin/release/setup-release-checkout.sh
/**
 * The shipped script, unless a mutation probe points us at a COPY. That override
 * is what makes tier-2 falsifiability proof available here (CLAUDE.md, "Proving a
 * guard is falsifiable"): scripts/mutation-probe.sh can mutate an out-of-tree copy
 * and re-run these tests against it, instead of editing the shared checkout — where
 * git-sync's whole-tree sweep can commit the mutant even when nothing goes wrong.
 */
const SCRIPT_PATH =
  process.env.PROBE_SCRIPT ?? join(__dirname, '../../bin/release/setup-release-checkout.sh');
const DEPENDENCY_GENERATION_SCRIPT = join(
  __dirname,
  '../../bin/release/dependency-generation.sh',
);
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Run the real `need_node_modules()` against the given trees. Returns true when the
 * function decided a re-copy is NEEDED (exit 0) and false when node_modules is
 * up-to-date (exit 1) — the script's own `return 0`/`return 1` contract.
 */
function needsCopy(integrationRoot: string, releaseRoot: string, mode = 'auto'): boolean {
  // Source ONLY the function out of the live script, then call it — the same
  // extraction the function's globals expect, so we exercise shipped logic.
  const wrapper = [
    'set -uo pipefail',
    'source <(sed -n "/^need_node_modules()/,/^}/p" "$SETUP_SCRIPT")',
    'need_node_modules',
  ].join('\n');
  const r = spawnSync('bash', ['-c', wrapper], {
    env: {
      ...process.env,
      SETUP_SCRIPT: SCRIPT_PATH,
      INTEGRATION_ROOT: integrationRoot,
      RELEASE_ROOT: releaseRoot,
      NODE_MODULES_MODE: mode,
    },
    encoding: 'utf8',
  });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`need_node_modules exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function recordCopyMetadata(
  integrationRoot: string,
  releaseRoot: string,
  generationId: string,
  sourceFingerprint: string,
): { status: number | null; stdout: string; stderr: string } {
  const wrapper = [
    'set -euo pipefail',
    'log() { printf "[setup-release] %s\\n" "$*"; }',
    'source <(sed -n "/^record_node_modules_copy_metadata()/,/^}/p" "$SETUP_SCRIPT")',
    'record_node_modules_copy_metadata',
  ].join('\n');
  const r = spawnSync('bash', ['-c', wrapper], {
    env: {
      ...process.env,
      SETUP_SCRIPT: SCRIPT_PATH,
      INTEGRATION_ROOT: integrationRoot,
      RELEASE_ROOT: releaseRoot,
      PINNED_DEPENDENCY_GENERATION_ID: generationId,
      DEPENDENCY_GENERATION_SOURCE_FINGERPRINT: sourceFingerprint,
    },
    encoding: 'utf8',
  });
  return {
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
}

/** Create a node_modules package dir (with a package.json) under `root`. */
function addPkg(root: string, name: string): void {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
}

let int: string;
let rel: string;

beforeEach(() => {
  int = mkdtempSync(join(tmpdir(), 'nm-int-'));
  rel = mkdtempSync(join(tmpdir(), 'nm-rel-'));
  // Baseline both trees: the scoped workspace roots present + identical, no
  // non-scoped deps, no lockfiles → the function's "nothing changed" state.
  for (const root of [int, rel]) {
    mkdirSync(join(root, 'node_modules/@papercusp'), { recursive: true });
    mkdirSync(join(root, 'node_modules/@papercup'), { recursive: true });
  }
});

afterEach(() => {
  rmSync(int, { recursive: true, force: true });
  rmSync(rel, { recursive: true, force: true });
});

describe('setup-release-checkout.sh need_node_modules() — deploy staleness heuristic', () => {
  it('copies when the release tree has no node_modules at all', () => {
    rmSync(join(rel, 'node_modules'), { recursive: true, force: true });
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('does NOT copy when the dep state is identical (no lockfiles, same package set)', () => {
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('copies when a new SCOPED workspace package appears in the integration tree', () => {
    addPkg(int, '@papercusp/new-package');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('EI-935: copies when a new NON-scoped top-level dep (rrule) appears in the integration tree', () => {
    // The exact regression: a non-scoped dep the per-@scope diff could not see.
    addPkg(int, 'rrule');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('does NOT over-copy when the same non-scoped dep is present in BOTH trees', () => {
    addPkg(int, 'rrule');
    addPkg(rel, 'rrule');
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('copies when the integration lock differs from the ignored dependency-copy stamp', () => {
    writeFileSync(join(int, 'package-lock.json'), '{"lockfileVersion":3,"a":1}');
    writeFileSync(join(rel, 'node_modules/.papercusp-source-package-lock.json'), '{"lockfileVersion":3,"a":2}');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('copies (fail-safe) when the integration tree has a lockfile but no dependency-copy stamp', () => {
    writeFileSync(join(int, 'package-lock.json'), '{"lockfileVersion":3}');
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('does NOT copy when the dependency-copy stamp is current and the package set matches', () => {
    const lock = '{"lockfileVersion":3,"packages":{}}';
    writeFileSync(join(int, 'package-lock.json'), lock);
    writeFileSync(join(rel, 'node_modules/.papercusp-source-package-lock.json'), lock);
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('never treats the pinned tracked package-lock.json as the dependency-copy stamp', () => {
    const lock = '{"lockfileVersion":3,"packages":{}}';
    writeFileSync(join(int, 'package-lock.json'), lock);
    writeFileSync(join(rel, 'package-lock.json'), lock);
    expect(needsCopy(int, rel)).toBe(true);
  });

  it('ignores a difference confined to dot-prefixed entries (.bin/.package-lock.json) — not a real dep change', () => {
    // The non-scoped diff filters `^\.` entries; a difference only there must NOT
    // trip a copy on its own (it falls through to the lockfile compare → no lockfiles → no copy).
    mkdirSync(join(int, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(int, 'node_modules/.package-lock.json'), '{}');
    expect(needsCopy(int, rel)).toBe(false);
  });

  it('mode=skip never copies, even when node_modules is missing in the release tree', () => {
    rmSync(join(rel, 'node_modules'), { recursive: true, force: true });
    expect(needsCopy(int, rel, 'skip')).toBe(false);
  });

  it('mode=force always copies, even when the dep state is identical', () => {
    expect(needsCopy(int, rel, 'force')).toBe(true);
  });

  it('records an empty dependency generation when no root node_modules was copied', () => {
    rmSync(join(rel, 'node_modules'), { recursive: true, force: true });
    const generationId = `v1-${'e'.repeat(64)}`;
    const sourceFingerprint = 'e'.repeat(64);

    const result = recordCopyMetadata(
      int,
      rel,
      generationId,
      sourceFingerprint,
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `DEPENDENCY_GENERATION_PIN identity=${generationId}`,
    );
    expect(
      readFileSync(
        join(rel, 'node_modules/.papercusp-dependency-generation'),
        'utf8',
      ),
    ).toBe(`identity=${generationId}\nsource=${sourceFingerprint}\n`);
  });

  it('WI-10004928 part 7: overwrites both markers when a reused generation left them read-only (0444)', () => {
    const generationId = `v1-${'f'.repeat(64)}`;
    const sourceFingerprint = 'f'.repeat(64);
    const lock = '{"lockfileVersion":3,"fresh":true}';
    writeFileSync(join(int, 'package-lock.json'), lock);
    const lockMarker = join(rel, 'node_modules/.papercusp-source-package-lock.json');
    const genMarker = join(rel, 'node_modules/.papercusp-dependency-generation');
    writeFileSync(lockMarker, '{"stale":true}');
    writeFileSync(genMarker, 'identity=stale\nsource=stale\n');
    chmodSync(lockMarker, 0o444);
    chmodSync(genMarker, 0o444);

    const result = recordCopyMetadata(int, rel, generationId, sourceFingerprint);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(lockMarker, 'utf8')).toBe(lock);
    expect(readFileSync(genMarker, 'utf8')).toBe(
      `identity=${generationId}\nsource=${sourceFingerprint}\n`,
    );
  });

  it('WI-10004928 part 7: never writes through a read-only marker hard-linked into a generation', () => {
    const generationId = `v1-${'a'.repeat(64)}`;
    writeFileSync(join(int, 'package-lock.json'), '{"lockfileVersion":3}');
    const store = mkdtempSync(join(tmpdir(), 'nm-gen-'));
    try {
      const storeMarker = join(store, '.papercusp-dependency-generation');
      writeFileSync(storeMarker, 'identity=immutable\nsource=immutable\n');
      chmodSync(storeMarker, 0o444);
      const genMarker = join(rel, 'node_modules/.papercusp-dependency-generation');
      spawnSync('ln', [storeMarker, genMarker]);
      expect(statSync(genMarker).nlink).toBe(2);

      const result = recordCopyMetadata(int, rel, generationId, 'a'.repeat(64));

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(storeMarker, 'utf8')).toBe('identity=immutable\nsource=immutable\n');
      expect(statSync(storeMarker).mode & 0o777).toBe(0o444);
      expect(readFileSync(genMarker, 'utf8')).toContain(`identity=${generationId}`);
    } finally {
      chmodSync(join(store, '.papercusp-dependency-generation'), 0o644);
      rmSync(store, { recursive: true, force: true });
    }
  });
});

describe('setup-release-checkout.sh dependency-generation retention wiring', () => {
  it('leases exact identity before selection and promotes the checkout pin before release', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const exactLease = source.indexOf(
      'dependency_generation_acquire_selector_lease "$DEPENDENCY_GENERATION_ROOT" "$NODE_MODULES_GENERATION_ID"',
    );
    const exactSelect = source.indexOf(
      'dependency_generation_select "$DEPENDENCY_GENERATION_ROOT" "$NODE_MODULES_GENERATION_ID"',
    );
    expect(exactLease).toBeGreaterThan(-1);
    expect(exactLease).toBeLessThan(exactSelect);

    const register = source.indexOf('dependency_generation_register_pin \\');
    const release = source.indexOf(
      'dependency_generation_release_selector_lease',
      register,
    );
    expect(register).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(register);
  });

  it('WI-41491: uses the immutable-token selector and transports the chosen workspace closure', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const configure = source.indexOf(
      '    configure_release_dependency_workspace_dirs\n',
    );
    const tokenSelect = source.indexOf(
      'dependency_generation_select_prevalidated \\',
    );
    const enumerate = source.indexOf(
      'done < <(enumerate_node_modules "$NODE_MODULES_SOURCE_ROOT")',
    );

    expect(configure).toBeGreaterThan(-1);
    expect(tokenSelect).toBeGreaterThan(configure);
    expect(enumerate).toBeGreaterThan(tokenSelect);
    expect(source).toContain(
      '--node-modules-workspace-dir) NODE_MODULES_WORKSPACE_DIRS+=("$2")',
    );
  });
});

describe('setup-release-checkout.sh pinned_dependency_generation_reuse_safe() — cache-ready fast path', () => {
  const sourceFingerprint = 'a'.repeat(64);
  const generationId = `v1-${sourceFingerprint}`;
  let work: string;
  let sourceRoot: string;
  let releaseRoot: string;

  function writeCheckoutMarker(
    identity = generationId,
    source = sourceFingerprint,
    extra = '',
  ): void {
    writeFileSync(
      join(releaseRoot, 'node_modules/.papercusp-dependency-generation'),
      `identity=${identity}\nsource=${source}\n${extra}`,
    );
  }

  function addDependencyTree(rel: string, stampedGeneration = generationId): void {
    mkdirSync(join(sourceRoot, rel), { recursive: true });
    mkdirSync(join(releaseRoot, rel), { recursive: true });
    writeFileSync(
      join(releaseRoot, rel, '.papercusp-isolated-snapshot'),
      `generation=${stampedGeneration}\n`,
    );
  }

  function reuseSafe(overrides: Record<string, string> = {}): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const wrapper = [
      'set -uo pipefail',
      'source "$GENERATION_SCRIPT"',
      'source <(sed -n "/^enumerate_node_modules()/,/^}/p; /^pinned_generation_tree_current()/,/^}/p; /^pinned_dependency_generation_reuse_safe()/,/^}/p" "$SETUP_SCRIPT")',
      'if pinned_dependency_generation_reuse_safe; then',
      '  printf "safe trees=%s\\n" "$PINNED_DEPENDENCY_REUSE_TREE_COUNT"',
      '  exit 0',
      'fi',
      'printf "unsafe\\n"',
      'exit 1',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        GENERATION_SCRIPT: DEPENDENCY_GENERATION_SCRIPT,
        NODE_MODULES_SOURCE_ROOT: sourceRoot,
        DEPENDENCY_GENERATION_TREE: sourceRoot,
        RELEASE_ROOT: releaseRoot,
        PINNED_DEPENDENCY_GENERATION_ID: generationId,
        DEPENDENCY_GENERATION_SOURCE_FINGERPRINT: sourceFingerprint,
        ...overrides,
      },
      encoding: 'utf8',
    });
    return {
      status: r.status,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
    };
  }

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nm-generation-reuse-'));
    sourceRoot = join(work, 'generation-tree');
    releaseRoot = join(work, 'checkpoint');
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(releaseRoot, { recursive: true });
    addDependencyTree('node_modules');
    addDependencyTree('packages/example/node_modules');
    writeCheckoutMarker();
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('reuses only when the checkout marker and every enumerated tree carry the selected generation', () => {
    const result = reuseSafe();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('safe trees=2\n');
  });

  it('fails closed when the checkout identity or source fingerprint differs', () => {
    writeCheckoutMarker(`v1-${'b'.repeat(64)}`, sourceFingerprint);
    expect(reuseSafe().status).toBe(1);

    writeCheckoutMarker(generationId, 'b'.repeat(64));
    expect(reuseSafe().status).toBe(1);
  });

  it('fails closed when the checkout marker or root tree marker is absent', () => {
    rmSync(
      join(releaseRoot, 'node_modules/.papercusp-dependency-generation'),
      { force: true },
    );
    expect(reuseSafe().status).toBe(1);

    writeCheckoutMarker();
    rmSync(
      join(releaseRoot, 'node_modules/.papercusp-isolated-snapshot'),
      { force: true },
    );
    expect(reuseSafe().status).toBe(1);
  });

  it('fails closed when an enumerated destination tree is missing', () => {
    rmSync(join(releaseRoot, 'packages/example/node_modules'), {
      recursive: true,
      force: true,
    });
    expect(reuseSafe().status).toBe(1);
  });

  it('fails closed when any tree marker is absent, duplicated, or names another generation', () => {
    const marker = join(
      releaseRoot,
      'packages/example/node_modules/.papercusp-isolated-snapshot',
    );
    rmSync(marker);
    expect(reuseSafe().status).toBe(1);

    writeFileSync(marker, `generation=${generationId}\ngeneration=${generationId}\n`);
    expect(reuseSafe().status).toBe(1);

    writeFileSync(marker, `generation=v1-${'b'.repeat(64)}\n`);
    expect(reuseSafe().status).toBe(1);
  });

  it('rejects a dependency-tree symlink even when its target carries a matching marker', () => {
    const rel = 'packages/example/node_modules';
    const outside = join(work, 'outside-node-modules');
    rmSync(join(releaseRoot, rel), { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, '.papercusp-isolated-snapshot'),
      `generation=${generationId}\n`,
    );
    symlinkSync(outside, join(releaseRoot, rel));

    expect(reuseSafe().status).toBe(1);
  });

  it('rejects a mutable-tree source in place of the selected generation tree', () => {
    expect(
      reuseSafe({ DEPENDENCY_GENERATION_TREE: join(work, 'another-generation') })
        .status,
    ).toBe(1);
  });

  it('does not walk or overwrite expected copy-up mutations inside a structurally marked tree', () => {
    const sourceAddon = join(sourceRoot, 'node_modules/native-addon/build.node');
    const releaseAddon = join(releaseRoot, 'node_modules/native-addon/build.node');
    mkdirSync(dirname(sourceAddon), { recursive: true });
    mkdirSync(dirname(releaseAddon), { recursive: true });
    writeFileSync(sourceAddon, 'immutable-generation-binary');
    writeFileSync(releaseAddon, 'checkpoint-copy-up-for-runtime-abi');

    const result = reuseSafe();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(releaseAddon, 'utf8')).toBe(
      'checkpoint-copy-up-for-runtime-abi',
    );
  });

  it('gates the existing atomic materialization loop and emits explicit hit/miss evidence', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const branch = source.indexOf(
      'if pinned_dependency_generation_reuse_safe; then',
    );
    const hit = source.indexOf(
      'DEPENDENCY_GENERATION_CHECKOUT_REUSE status=hit',
      branch,
    );
    const miss = source.indexOf(
      'DEPENDENCY_GENERATION_CHECKOUT_REUSE status=miss',
      branch,
    );
    const atomicMaterialization = source.indexOf(
      'sync_one_node_modules "$nm" "$RELEASE_ROOT/$rel"',
      branch,
    );

    expect(branch).toBeGreaterThan(-1);
    expect(hit).toBeGreaterThan(branch);
    expect(miss).toBeGreaterThan(hit);
    expect(atomicMaterialization).toBeGreaterThan(miss);
  });
});

describe('setup-release-checkout.sh assert_hardlink_compatible_roots() — cross-device guard', () => {
  function assertCompatible(
    releaseRoot: string,
    copyMode = 'hardlink',
    devices?: { integration: number; release: number },
  ): { status: number | null; stdout: string; stderr: string } {
    const wrapper = [
      'set -uo pipefail',
      'source <(sed -n "/^filesystem_device()/,/^}/p; /^assert_hardlink_compatible_roots()/,/^}/p" "$SETUP_SCRIPT")',
      // The committed-source harness puts both roots under tmpdir. Control the
      // device lookup for negative cases instead of relying on the host mounts;
      // assert_hardlink_compatible_roots remains the shipped implementation.
      ...(devices ? [
        'filesystem_device() {',
        '  if [ "$1" = "$INTEGRATION_ROOT" ]; then',
        '    printf "%s\\n" "$TEST_INTEGRATION_DEVICE"',
        '  else',
        '    printf "%s\\n" "$TEST_RELEASE_DEVICE"',
        '  fi',
        '}',
      ] : []),
      'assert_hardlink_compatible_roots',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: REPO_ROOT,
        RELEASE_ROOT: releaseRoot,
        NODE_MODULES_COPY_MODE: copyMode,
        TEST_INTEGRATION_DEVICE: String(devices?.integration ?? ''),
        TEST_RELEASE_DEVICE: String(devices?.release ?? ''),
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('passes when the release root is on the same filesystem', () => {
    const releaseRoot = mkdtempSync(join(dirname(REPO_ROOT), 'release-root-same-device-'));
    try {
      expect(assertCompatible(releaseRoot).status).toBe(0);
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('fails once with an actionable message before cross-device hardlink copy', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'release-root-cross-device-'));
    try {
      const result = assertCompatible(releaseRoot, 'hardlink', { integration: 101, release: 202 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('same filesystem');
      expect(result.stderr).toContain('--node-modules-copy copy');
      expect(result.stderr).toContain('device=101');
      expect(result.stderr).toContain('device=202');
      // Change only the measured destination device: the same predicate must
      // accept it, so the negative case cannot pass due to a broken shell seam.
      expect(assertCompatible(releaseRoot, 'hardlink', { integration: 101, release: 101 }).status).toBe(0);
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('allows explicit copy mode across filesystems', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'release-root-copy-mode-'));
    try {
      expect(assertCompatible(releaseRoot, 'copy', { integration: 101, release: 202 }).status).toBe(0);
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });
});

describe('setup-release-checkout.sh destination capacity before source preparation', () => {
  const GIB = 1024 ** 3;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    if (r.status !== 0) throw new Error(`fixture git failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  function fixtureSha() {
    git(int, 'init', '-q');
    writeFileSync(join(int, 'tracked.txt'), 'pinned source\n');
    git(int, 'add', 'tracked.txt');
    git(int, 'commit', '-qm', 'capacity fixture');
    return git(int, 'rev-parse', 'HEAD');
  }

  function runSetup(target: string, sha: string, extra: string[] = []) {
    return spawnSync('bash', [SCRIPT_PATH, '--integration', int, '--release', target,
      '--ref', sha, '--node-modules', 'auto', '--node-modules-copy', 'copy', ...extra], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env,
        DEPENDENCY_GENERATION_HEADROOM_SAME_FS: '0',
        DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: String(1000 * GIB),
        DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: String(6 * GIB),
        DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '2',
        DEPENDENCY_GENERATION_HEADROOM_OTHER_FS_RESERVE_CAP_BYTES: String(20 * GIB),
        DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: String(10 * GIB),
      },
    });
  }

  it('returns infrastructure exit 77 without creating a fresh destination or its parents', () => {
    const sha = fixtureSha();
    const target = join(rel, 'missing-parent', 'checkout');
    const before = git(int, 'worktree', 'list', '--porcelain');
    const r = runSetup(target, sha);
    expect(r.status, r.stderr).toBe(77);
    expect(r.stderr).toContain('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
    expect(r.stderr).toContain(`required=${30 * GIB} size=unknown`);
    expect(existsSync(dirname(target))).toBe(false);
    expect(git(int, 'worktree', 'list', '--porcelain')).toBe(before);
  });

  it('keeps an existing checkout and untracked evidence intact on capacity refusal', () => {
    const sha = fixtureSha();
    const target = join(rel, 'checkout');
    git(int, 'worktree', 'add', '--quiet', '--detach', target, sha);
    writeFileSync(join(target, 'tracked.txt'), 'dirty source stays\n');
    writeFileSync(join(target, 'evidence.txt'), 'evidence stays\n');
    const r = runSetup(target, sha);
    expect(r.status, r.stderr).toBe(77);
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('dirty source stays\n');
    expect(readFileSync(join(target, 'evidence.txt'), 'utf8')).toBe('evidence stays\n');
    expect(git(target, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('lets source-only setup finish without imposing the dependency-copy reserve', () => {
    const sha = fixtureSha();
    const target = join(rel, 'source-only');
    const r = runSetup(target, sha, ['--source-only']);
    expect(r.status, r.stderr).toBe(0);
    expect(git(target, 'rev-parse', 'HEAD')).toBe(sha);
    expect(r.stderr).not.toContain('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
  });
});

describe('clone_submodule_repo — filesystem-aware local object transport', () => {
  function makeFixture(): {
    work: string;
    integrationRoot: string;
    releaseRoot: string;
    sha: string;
    sourceObject: string;
  } {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'release-submodule-clone-')));
    const integrationRoot = join(work, 'integration');
    const releaseRoot = join(work, 'release');
    const source = join(integrationRoot, 'libs', 'sub');
    mkdirSync(source, { recursive: true });
    mkdirSync(releaseRoot, { recursive: true });
    const git = (...args: string[]) => spawnSync(
      'git',
      ['-C', source, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    expect(git('init', '-q').status).toBe(0);
    writeFileSync(join(source, 'tracked.txt'), 'pinned source\n');
    expect(git('add', 'tracked.txt').status).toBe(0);
    expect(git('commit', '-qm', 'fixture').status).toBe(0);
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    const sourceObject = join(source, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
    expect(existsSync(sourceObject)).toBe(true);
    return { work, integrationRoot, releaseRoot, sha, sourceObject };
  }

  function runClone(
    fixture: ReturnType<typeof makeFixture>,
    simulatedSameDevice: boolean,
  ): ReturnType<typeof spawnSync> {
    const wrapper = [
      'set -uo pipefail',
      'source <(sed -n "/^filesystem_device()/,/^}/p; /^clone_submodule_repo()/,/^}/p" "$SETUP_SCRIPT")',
      simulatedSameDevice
        ? 'filesystem_device() { echo source-device; }'
        : 'filesystem_device() { case "$1" in "$INTEGRATION_ROOT"/*) echo source-device ;; *) echo destination-device ;; esac; }',
      'clone_submodule_repo "libs/sub" "$SHA"',
    ].join('\n');
    return spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: fixture.integrationRoot,
        RELEASE_ROOT: fixture.releaseRoot,
        SHA: fixture.sha,
      },
    });
  }

  it('keeps local-object hardlinks on the same filesystem', () => {
    const fixture = makeFixture();
    try {
      const result = runClone(fixture, true);
      expect(result.status).toBe(0);
      const clonedObject = join(
        fixture.releaseRoot,
        'libs',
        'sub',
        '.git',
        'objects',
        fixture.sha.slice(0, 2),
        fixture.sha.slice(2),
      );
      expect(statSync(clonedObject).ino).toBe(statSync(fixture.sourceObject).ino);
    } finally {
      rmSync(fixture.work, { recursive: true, force: true });
    }
  });

  it('copies local objects when source and destination devices differ', () => {
    const fixture = makeFixture();
    try {
      const result = runClone(fixture, false);
      expect(result.status).toBe(0);
      const cloned = join(fixture.releaseRoot, 'libs', 'sub');
      const clonedObject = join(
        cloned,
        '.git',
        'objects',
        fixture.sha.slice(0, 2),
        fixture.sha.slice(2),
      );
      expect(statSync(clonedObject).ino).not.toBe(statSync(fixture.sourceObject).ino);
      expect(spawnSync('git', ['-C', cloned, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()).toBe(fixture.sha);
      expect(spawnSync('git', ['-C', cloned, 'status', '--porcelain', '-uno'], { encoding: 'utf8' }).stdout).toBe('');
    } finally {
      rmSync(fixture.work, { recursive: true, force: true });
    }
  });
});

/**
 * EI-24341465306631575 fix (b). Both submodule materializers start with `rm -rf` of the
 * submodule path, which deleted the pinned node_modules trees a previous pass materialized
 * there, so every checkpoint pass re-copied them (~3.7 GiB). Trees stamped with a
 * `generation=` marker are now moved aside across the re-clone and put back; everything
 * else is removed exactly as before.
 */
describe('setup-release-checkout.sh pinned submodule node_modules survive the re-clone (EI-24341465306631575)', () => {
  const generationMarker = `generation=v1-${'e'.repeat(64)}\n`;
  let work: string;
  let releaseRoot: string;
  let stash: string;

  function run(fn: 'stash' | 'restore', subPath: string): { status: number | null; stdout: string; stderr: string } {
    const wrapper = [
      'set -euo pipefail',
      'source "$GENERATION_SCRIPT"',
      'source <(sed -n "/^stash_pinned_submodule_node_modules()/,/^}/p; /^restore_pinned_submodule_node_modules()/,/^}/p" "$SETUP_SCRIPT")',
      `${fn}_pinned_submodule_node_modules "$SUB" "$STASH"`,
      'printf "kept=%s\\n" "${SUBMODULE_NODE_MODULES_KEPT:-0}"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        GENERATION_SCRIPT: DEPENDENCY_GENERATION_SCRIPT,
        RELEASE_ROOT: releaseRoot,
        SUB: subPath,
        STASH: stash,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  }

  function addTree(rel: string, marker: string | null): void {
    mkdirSync(join(releaseRoot, rel, 'dep'), { recursive: true });
    writeFileSync(join(releaseRoot, rel, 'dep/index.js'), `CONTENT:${rel}`);
    if (marker !== null) writeFileSync(join(releaseRoot, rel, '.papercusp-isolated-snapshot'), marker);
  }

  /** What clone_submodule_repo / extract_submodule_source do to the path. */
  function reclone(subPath: string, dirs: string[]): void {
    rmSync(join(releaseRoot, subPath), { recursive: true, force: true });
    for (const d of dirs) mkdirSync(join(releaseRoot, subPath, d), { recursive: true });
  }

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'sub-nm-keep-'));
    releaseRoot = join(work, 'checkpoint');
    stash = join(work, '.checkpoint.submodule-node-modules');
    mkdirSync(stash, { recursive: true });
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('carries generation-stamped trees across the re-clone and drops the rest', () => {
    addTree('libs/sub/node_modules', generationMarker);
    addTree('libs/sub/packages/a/node_modules', generationMarker);
    addTree('libs/sub/packages/b/node_modules', 'source=abc\nsnapshot=def\n');
    addTree('libs/sub/packages/c/node_modules', null);
    const keptInode = statSync(join(releaseRoot, 'libs/sub/node_modules/dep/index.js')).ino;

    expect(run('stash', 'libs/sub').status).toBe(0);
    reclone('libs/sub', ['packages/a', 'packages/b', 'packages/c']);
    const restored = run('restore', 'libs/sub');

    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toBe('kept=2\n');
    expect(statSync(join(releaseRoot, 'libs/sub/node_modules/dep/index.js')).ino).toBe(keptInode);
    expect(readFileSync(join(releaseRoot, 'libs/sub/packages/a/node_modules/dep/index.js'), 'utf8')).toBe(
      'CONTENT:libs/sub/packages/a/node_modules',
    );
    expect(existsSync(join(releaseRoot, 'libs/sub/packages/b/node_modules'))).toBe(false);
    expect(existsSync(join(releaseRoot, 'libs/sub/packages/c/node_modules'))).toBe(false);
    expect(existsSync(join(stash, 'libs/sub'))).toBe(false);
  });

  it('drops a kept tree whose package the new pin removed, and never overwrites clone output', () => {
    addTree('libs/sub/packages/gone/node_modules', generationMarker);
    addTree('libs/sub/packages/tracked/node_modules', generationMarker);

    run('stash', 'libs/sub');
    reclone('libs/sub', ['packages/tracked/node_modules']);
    writeFileSync(join(releaseRoot, 'libs/sub/packages/tracked/node_modules/from-clone.txt'), 'CLONE');
    const restored = run('restore', 'libs/sub');

    expect(restored.stdout).toBe('kept=0\n');
    expect(existsSync(join(releaseRoot, 'libs/sub/packages/gone'))).toBe(false);
    expect(readdirSync(join(releaseRoot, 'libs/sub/packages/tracked/node_modules'))).toEqual(['from-clone.txt']);
    expect(existsSync(join(stash, 'libs/sub'))).toBe(false);
  });

  it('ignores a symlinked marker and a missing submodule path', () => {
    addTree('libs/sub/node_modules', null);
    const outsideMarker = join(work, 'outside-marker');
    writeFileSync(outsideMarker, generationMarker);
    symlinkSync(outsideMarker, join(releaseRoot, 'libs/sub/node_modules/.papercusp-isolated-snapshot'));

    run('stash', 'libs/sub');
    expect(existsSync(join(releaseRoot, 'libs/sub/node_modules/dep/index.js'))).toBe(true);
    expect(run('stash', 'libs/absent').status).toBe(0);
    expect(run('restore', 'libs/absent').stdout).toBe('kept=0\n');
  });

  it('wraps every submodule materialization in the stash/restore pair', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const loop = source.indexOf('while IFS= read -r P; do');
    const stashCall = source.indexOf('stash_pinned_submodule_node_modules "$P" "$_nm_stash"', loop);
    const clone = source.indexOf('if clone_submodule_repo "$P" "$S"; then', loop);
    const extract = source.indexOf('extract_submodule_source "$P" "$S"', loop);
    const restoreCall = source.indexOf('restore_pinned_submodule_node_modules "$P" "$_nm_stash"', loop);
    const loopEnd = source.indexOf('done < <(git -C "$INTEGRATION_ROOT" config --blob', loop);

    expect(loop).toBeGreaterThan(-1);
    expect(stashCall).toBeGreaterThan(loop);
    expect(clone).toBeGreaterThan(stashCall);
    expect(extract).toBeGreaterThan(clone);
    expect(restoreCall).toBeGreaterThan(extract);
    expect(loopEnd).toBeGreaterThan(restoreCall);
  });
});

describe('setup-release-checkout.sh generation package copy-up', () => {
  it('preserves frozen donor modes and snapshot while retiring hardlinked patch targets', () => {
    const work = mkdtempSync(join(tmpdir(), 'generation-copy-up-'));
    const donor = join(work, 'generation/node_modules/example');
    const target = join(work, 'checkout/node_modules/example');
    mkdirSync(join(donor, 'bin'), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(join(donor, 'index.js'), 'original dependency\n');
    writeFileSync(join(donor, 'bin/tool'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(donor, 'index.js'), 0o444);
    chmodSync(join(donor, 'bin/tool'), 0o555);
    chmodSync(join(donor, 'bin'), 0o555);
    chmodSync(donor, 0o555);
    try {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', [
        'source "$GENERATION_SCRIPT"',
        'source <(sed -n "/^copy_up_generation_dependency_path()/,/^}/p" "$SETUP_SCRIPT")',
        'dependency_generation_tree_fingerprint "$DONOR" > "$WORK/before"',
        'cp -al "$DONOR" "$TARGET"',
        'copy_up_generation_dependency_path "$TARGET"',
        'dependency_generation_tree_fingerprint "$DONOR" > "$WORK/after"',
      ].join('\n')], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          GENERATION_SCRIPT: DEPENDENCY_GENERATION_SCRIPT,
          SETUP_SCRIPT: SCRIPT_PATH,
          PINNED_DEPENDENCY_GENERATION_ID: 'fixture-generation',
          DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(work, 'copy.lock'),
          DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '0',
          DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '0',
          WORK: work,
          DONOR: donor,
          TARGET: target,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(statSync(join(donor, 'index.js')).mode & 0o777).toBe(0o444);
      expect(statSync(join(donor, 'bin/tool')).mode & 0o777).toBe(0o555);
      expect(readFileSync(join(work, 'after'), 'utf8')).toBe(readFileSync(join(work, 'before'), 'utf8'));
      for (const path of ['index.js', 'bin/tool']) {
        expect(statSync(join(target, path)).ino).not.toBe(statSync(join(donor, path)).ino);
        expect(statSync(join(target, path)).mode & 0o200).toBe(0o200);
      }
      writeFileSync(join(target, 'index.js'), 'patched dependency\n');
      expect(readFileSync(join(donor, 'index.js'), 'utf8')).toBe('original dependency\n');
      expect(readdirSync(dirname(target))).toEqual(['example']);
    } finally {
      // Only directories need write permission to unlink their children.
      chmodSync(donor, 0o755);
      chmodSync(join(donor, 'bin'), 0o755);
      rmSync(work, { recursive: true, force: true });
    }
  });
});

/**
 * sync_one_node_modules() — the ATOMIC node_modules refresh (2026-06-25 all-pages
 * connection-refused outage). The old in-place `rm -rf "$dest"; cp -al` left the LIVE
 * operator looking at a deleted/half-populated node_modules for the ~minute the root
 * copy took → 32 cluster workers respawned mid-copy, crash-looped on MODULE_NOT_FOUND,
 * and refused every page. The function builds into a sibling temp then swaps with two
 * fast renames, so the live tree is only ever COMPLETE (the swap window is the µs
 * between two rename(2) calls). These pin the functional contract: correct content,
 * wholesale replacement, relative-symlink preservation (the workspace isolation
 * invariant), and temp cleanup.
 */
describe('setup-release-checkout.sh sync_one_node_modules() — atomic node_modules swap', () => {
  interface SyncOneOptions {
    stubIndependentFailure?: boolean;
    /** Sets PINNED_DEPENDENCY_GENERATION_ID → the pinned sub-branch of `copy` mode. */
    generationId?: string;
    /** Replace the materializer with a no-op, so it "succeeds" leaving no tree. */
    stubMaterializeToNoop?: boolean;
    /** Extra script globals, e.g. RELEASE_ROOT / DEPENDENCY_GENERATION_TREE. */
    env?: Record<string, string>;
  }

  function runSyncOne(
    src: string,
    dest: string,
    copyMode = 'hardlink',
    opts: SyncOneOptions = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const wrapper = [
      'set -euo pipefail',
      'log() { :; }',
      'source "$GENERATION_SCRIPT"',
      'source <(sed -n "/^pinned_generation_tree_current()/,/^}/p; /^node_modules_tree_fingerprint()/,/^}/p; /^sync_one_node_modules()/,/^}/p" "$SETUP_SCRIPT")',
      ...(opts.stubMaterializeToNoop ? ['dependency_generation_materialize_tree() { return 0; }'] : []),
      ...(opts.stubIndependentFailure ? ['dependency_generation_copy_independent() { mkdir -p "$2"; touch "$2/partial"; return 1; }'] : []),
      'sync_one_node_modules "$SRC" "$DEST"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        GENERATION_SCRIPT: DEPENDENCY_GENERATION_SCRIPT,
        SRC: src,
        DEST: dest,
        NODE_MODULES_COPY_MODE: copyMode,
        ...(opts.generationId ? { PINNED_DEPENDENCY_GENERATION_ID: opts.generationId } : {}),
        ...(opts.env ?? {}),
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  }

  function syncOne(src: string, dest: string, copyMode = 'hardlink', opts: SyncOneOptions = {}): number {
    const r = runSyncOne(src, dest, copyMode, opts);
    if (r.status !== 0) throw new Error(`sync_one_node_modules failed (${r.status}): ${r.stderr || r.stdout}`);
    return r.status ?? -1;
  }

  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nm-swap-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('refuses an independent snapshot before copying when capacity is insufficient', () => {
    const src = join(work, 'src');
    const dest = join(work, 'dest');
    mkdirSync(src);
    mkdirSync(dest);
    writeFileSync(join(src, 'new'), 'new');
    writeFileSync(join(dest, 'old'), 'old');
    const result = runSyncOne(src, dest, 'copy', { env: {
      DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '999999999999999',
    } });
    expect(result.status, result.stderr).toBe(77);
    expect(readFileSync(join(dest, 'old'), 'utf8')).toBe('old');
    expect(readdirSync(work).filter((name) => name.includes('deploy-tmp'))).toEqual([]);
  });

  it('removes a failed independent snapshot without replacing the existing destination', () => {
    const src = join(work, 'src');
    const dest = join(work, 'dest');
    mkdirSync(src);
    mkdirSync(dest);
    writeFileSync(join(src, 'new'), 'new');
    writeFileSync(join(dest, 'old'), 'old');
    expect(runSyncOne(src, dest, 'copy', { stubIndependentFailure: true }).status).toBe(1);
    expect(readFileSync(join(dest, 'old'), 'utf8')).toBe('old');
    expect(readdirSync(work).filter((name) => name.includes('deploy-tmp'))).toEqual([]);
  });

  it('first-time (no dest): creates dest as a hardlink copy of src', () => {
    const src = join(work, 'src');
    mkdirSync(join(src, 'pkg'), { recursive: true });
    writeFileSync(join(src, 'pkg/index.js'), 'OK');
    const dest = join(work, 'dest');
    syncOne(src, dest);
    expect(readFileSync(join(dest, 'pkg/index.js'), 'utf8')).toBe('OK');
  });

  it('copy mode isolates checkpoint files from later integration-tree mutation', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'BEFORE-INSTALL');
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy');
    writeFileSync(join(src, 'marker.txt'), 'AFTER-INSTALL');

    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('BEFORE-INSTALL');
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(statSync(join(src, 'marker.txt')).ino);
  });

  it('copy mode reuses an unchanged prior isolated snapshot without copying file payloads again', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'large.bin'), Buffer.alloc(1024 * 1024, 7));
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy');
    const sourceInode = statSync(join(src, 'large.bin')).ino;
    const firstSnapshotInode = statSync(join(dest, 'large.bin')).ino;
    syncOne(src, dest, 'copy');

    expect(statSync(join(dest, 'large.bin')).ino).toBe(firstSnapshotInode);
    expect(statSync(join(dest, 'large.bin')).ino).not.toBe(sourceInode);
    expect(readFileSync(join(dest, '.papercusp-isolated-snapshot'), 'utf8')).toMatch(
      /^source=[0-9a-f]{64}\nsnapshot=[0-9a-f]{64}\n$/,
    );
  });

  it('copy mode rejects a drifted prior snapshot and restores it from integration', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'CANONICAL');
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy');
    const firstSnapshotInode = statSync(join(dest, 'marker.txt')).ino;
    writeFileSync(join(dest, 'marker.txt'), 'MUTATED-BY-TEST');
    syncOne(src, dest, 'copy');

    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('CANONICAL');
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(firstSnapshotInode);
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(statSync(join(src, 'marker.txt')).ino);
  });

  it('existing dest: swaps to the NEW content wholesale (stale entries gone, dest never absent)', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'NEW');
    const dest = join(work, 'dest');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'marker.txt'), 'OLD');
    writeFileSync(join(dest, 'stale.txt'), 'STALE'); // not in src → must be gone after swap
    syncOne(src, dest);
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('NEW');
    expect(existsSync(join(dest, 'stale.txt'))).toBe(false);
  });

  it('preserves relative workspace symlinks verbatim (../../packages/X isolation invariant)', () => {
    const src = join(work, 'src');
    mkdirSync(join(src, '@papercusp'), { recursive: true });
    symlinkSync('../../packages/flags', join(src, '@papercusp/flags')); // relative; dangling is fine
    const dest = join(work, 'dest');
    syncOne(src, dest);
    expect(lstatSync(join(dest, '@papercusp/flags')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, '@papercusp/flags'))).toBe('../../packages/flags');
  });

  it('leaves no .deploy-tmp / .deploy-old sibling dirs behind after a swap', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a'), '1');
    const dest = join(work, 'dest');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'a'), '0');
    syncOne(src, dest);
    const leftovers = readdirSync(work).filter((n) => n.includes('deploy-tmp') || n.includes('deploy-old'));
    expect(leftovers).toEqual([]);
  });

  it('skips a source that vanished after enumeration instead of crashing the gate', () => {
    const vanished = join(work, 'sidecar.old.2029466/node_modules');
    const dest = join(work, 'release-sidecar/node_modules');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'marker.txt'), 'STABLE');

    expect(syncOne(vanished, dest)).toBe(0);
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('STABLE');
  });

  /**
   * WI-474827. The pinned sub-branch of `copy` mode used to run two full
   * node_modules_tree_fingerprint walks per tree — 188 walks across 94 trees on a
   * real checkpoint, which dominated launch-to-first-test. Neither value was ever
   * read back on that path: both went into the marker, whose only readers are the
   * non-pinned reuse test in the same function. These pin the replacement contract:
   * the marker carries the immutable generation id alone, a later non-pinned run
   * degrades to a full independent copy rather than trusting an absent fingerprint,
   * and a materialization that yields no tree still fails closed before the swap.
   */
  it('pinned copy mode writes a generation-only marker (no full-content fingerprint walks)', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'PINNED');
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy', { generationId: 'gen-abc123' });

    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('PINNED');
    expect(readFileSync(join(dest, '.papercusp-isolated-snapshot'), 'utf8')).toBe('generation=gen-abc123\n');
    // Pinned materialization defaults to an independent copy even on the same
    // device. Hardlinks are an explicit opt-in for callers that have separately
    // proved their source tree is immutable and never patched.
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(statSync(join(src, 'marker.txt')).ino);
  });

  it('replaces a read-only provenance marker carried by an older immutable generation', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'PINNED');
    const staleMarker = join(src, '.papercusp-isolated-snapshot');
    writeFileSync(staleMarker, 'generation=stale-checkpoint\n');
    chmodSync(staleMarker, 0o444);
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy', { generationId: 'gen-current' });

    expect(readFileSync(join(dest, '.papercusp-isolated-snapshot'), 'utf8')).toBe(
      'generation=gen-current\n',
    );
    expect(readFileSync(staleMarker, 'utf8')).toBe(
      'generation=stale-checkpoint\n',
    );
    expect(statSync(join(dest, '.papercusp-isolated-snapshot')).ino).not.toBe(
      statSync(staleMarker).ino,
    );
    expect(statSync(staleMarker).mode & 0o777).toBe(0o444);
  });

  it('a later non-pinned run over a pinned marker falls back to a full independent copy', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'CANONICAL');
    const dest = join(work, 'dest');

    syncOne(src, dest, 'copy', { generationId: 'gen-abc123' });
    const pinnedInode = statSync(join(dest, 'marker.txt')).ino;

    // No source=/snapshot= line → marked_src reads empty → the reuse test cannot
    // match → the original full independent copy. Slower, never a mixed snapshot.
    syncOne(src, dest, 'copy');

    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('CANONICAL');
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(pinnedInode);
    expect(statSync(join(dest, 'marker.txt')).ino).not.toBe(statSync(join(src, 'marker.txt')).ino);
    expect(readFileSync(join(dest, '.papercusp-isolated-snapshot'), 'utf8')).toMatch(
      /^source=[0-9a-f]{64}\nsnapshot=[0-9a-f]{64}\n$/,
    );
  });

  it('pinned materialization that produces no tree fails closed before the swap', () => {
    const src = join(work, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'marker.txt'), 'NEW');
    const dest = join(work, 'dest');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'marker.txt'), 'PREVIOUS-CHECKPOINT');

    const r = runSyncOne(src, dest, 'copy', { generationId: 'gen-abc123', stubMaterializeToNoop: true });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FATAL: pinned dependency generation materialization produced no tree/);
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('PREVIOUS-CHECKPOINT');
    expect(readdirSync(work).filter((n) => n.includes('deploy-tmp') || n.includes('deploy-old'))).toEqual([]);
  });

  /**
   * EI-24341465306631575. The whole-checkout reuse predicate is all-or-nothing, and the
   * checkpoint's --source-only pass re-clones every submodule (deleting the node_modules
   * inside it), so the predicate missed on every gate run and the loop re-copied all ~95
   * trees (18.5 GiB) to restore the ~38 that were gone. The pinned branch now skips a tree
   * this checkout already materialized from the same generation, using the same per-tree
   * marker checks as the predicate.
   */
  describe('pinned per-tree reuse (EI-24341465306631575)', () => {
    const generationId = `v1-${'c'.repeat(64)}`;
    const rel = 'packages/kept/node_modules';
    let generationTree: string;
    let releaseRoot: string;
    let roots: Record<string, string>;

    beforeEach(() => {
      generationTree = join(work, 'generation-tree');
      releaseRoot = join(work, 'checkpoint');
      mkdirSync(join(generationTree, rel, 'dep'), { recursive: true });
      writeFileSync(join(generationTree, rel, 'dep/index.js'), 'GENERATION');
      mkdirSync(releaseRoot, { recursive: true });
      roots = { DEPENDENCY_GENERATION_TREE: generationTree, RELEASE_ROOT: releaseRoot };
    });

    function syncPinned(srcRel: string, destRel: string, env: Record<string, string> = roots): void {
      syncOne(join(generationTree, srcRel), join(releaseRoot, destRel), 'copy', { generationId, env });
    }

    it('materializes a missing tree, then skips it while it is current (keeping copy-up edits)', () => {
      const file = join(releaseRoot, rel, 'dep/index.js');
      syncPinned(rel, rel);
      expect(readFileSync(file, 'utf8')).toBe('GENERATION');
      expect(readFileSync(join(releaseRoot, rel, '.papercusp-isolated-snapshot'), 'utf8')).toBe(
        `generation=${generationId}\n`,
      );

      // A later setup phase copies up and patches a package inside the tree.
      writeFileSync(file, 'PATCHED-BY-COPY-UP');
      const inode = statSync(file).ino;
      syncPinned(rel, rel);

      expect(readFileSync(file, 'utf8')).toBe('PATCHED-BY-COPY-UP');
      expect(statSync(file).ino).toBe(inode);
      expect(readFileSync(join(generationTree, rel, 'dep/index.js'), 'utf8')).toBe('GENERATION');
    });

    it('re-materializes a tree whose marker names another generation or is duplicated', () => {
      const dest = join(releaseRoot, rel);
      const marker = join(dest, '.papercusp-isolated-snapshot');
      for (const stale of [
        `generation=v1-${'d'.repeat(64)}\n`,
        `generation=${generationId}\ngeneration=${generationId}\n`,
      ]) {
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(join(dest, 'dep'), { recursive: true });
        writeFileSync(join(dest, 'dep/index.js'), 'OLD');
        writeFileSync(marker, stale);

        syncPinned(rel, rel);

        expect(readFileSync(join(dest, 'dep/index.js'), 'utf8')).toBe('GENERATION');
        expect(readFileSync(marker, 'utf8')).toBe(`generation=${generationId}\n`);
      }
    });

    it('does not reuse a current tree for a source that names a different tree', () => {
      const otherRel = 'packages/other/node_modules';
      mkdirSync(join(generationTree, otherRel, 'dep'), { recursive: true });
      writeFileSync(join(generationTree, otherRel, 'dep/index.js'), 'OTHER');
      syncPinned(rel, rel);

      syncPinned(otherRel, rel);

      expect(readFileSync(join(releaseRoot, rel, 'dep/index.js'), 'utf8')).toBe('OTHER');
    });

    it('fails closed to materialization without the release and generation roots', () => {
      const file = join(releaseRoot, rel, 'dep/index.js');
      syncPinned(rel, rel);
      writeFileSync(file, 'PATCHED-BY-COPY-UP');

      syncPinned(rel, rel, {});

      expect(readFileSync(file, 'utf8')).toBe('GENERATION');
    });

    it('rejects a destination tree reached through a symlinked ancestor', () => {
      const outside = join(work, 'outside');
      syncPinned(rel, rel);
      renameSync(join(releaseRoot, 'packages'), outside);
      symlinkSync(outside, join(releaseRoot, 'packages'));
      writeFileSync(join(outside, 'kept/node_modules/dep/index.js'), 'ESCAPED');

      syncPinned(rel, rel);

      expect(readFileSync(join(releaseRoot, rel, 'dep/index.js'), 'utf8')).toBe('GENERATION');
    });
  });
});

/**
 * WI-39301: a co-hosted pnpm app's copied root package symlinks point through
 * node_modules/.pnpm. The old unconditional "debris" cleanup removed that source-backed
 * virtual store after the atomic copy, leaving present-by-name but dangling packages and
 * failing the checkpoint before tests (TypeScript MODULE_NOT_FOUND). Exercise the shipped
 * cleanup function directly so npm-only debris is still pruned without breaking pnpm apps.
 */
describe('setup-release-checkout.sh prune_stale_pnpm_store() — package-manager-aware cleanup', () => {
  function prunePnpmStore(integrationRoot: string, releaseRoot: string): void {
    const wrapper = [
      'set -euo pipefail',
      'log() { :; }',
      'source <(sed -n "/^prune_stale_pnpm_store()/,/^}/p" "$SETUP_SCRIPT")',
      'prune_stale_pnpm_store',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`prune_stale_pnpm_store failed (${r.status}): ${r.stderr || r.stdout}`);
    }
  }

  it('preserves a copied .pnpm store when the integration source is pnpm-backed', () => {
    const sourceTsc = join(int, 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc');
    const releaseTsc = join(rel, 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc');
    mkdirSync(join(sourceTsc, '..'), { recursive: true });
    mkdirSync(join(releaseTsc, '..'), { recursive: true });
    writeFileSync(sourceTsc, 'source');
    writeFileSync(releaseTsc, 'release');

    prunePnpmStore(int, rel);

    expect(readFileSync(releaseTsc, 'utf8')).toBe('release');
  });

  it('removes a release-only .pnpm store when the integration source has none', () => {
    const staleStore = join(rel, 'node_modules/.pnpm/orphan');
    mkdirSync(staleStore, { recursive: true });

    prunePnpmStore(int, rel);

    expect(existsSync(join(rel, 'node_modules/.pnpm'))).toBe(false);
  });
});

/**
 * rebuild_stale_native_addons() — native-addon ABI guard (infra-fail-fast P-003 / WI-349).
 *
 * The 2026-06-19 :3070 outage: papercup-release's better-sqlite3 was built for
 * Node 22 (ABI 127) while the service ran Node 25 (ABI 141). The hardlink-copy
 * (step 3) carries whatever ABI the INTEGRATION tree built under — if the
 * runtime Node differs, the binary fails to load. This function test-loads each
 * critical addon and `npm rebuild`s it in the release checkout on a mismatch,
 * so the release tree self-heals before the deploy-gate preflight can block it.
 *
 * Tested here via the same sed-extraction pattern as need_node_modules /
 * sync_one_node_modules: extract ONLY the named function from the live script
 * and drive it with controlled temp trees + fake `node`/`npm` stubs on PATH.
 */
describe('setup-release-checkout.sh rebuild_stale_native_addons() — native-addon ABI guard', () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'abi-guard-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /**
   * Run rebuild_stale_native_addons() with fake node/npm stubs that let us
   * control whether the native load probe and npm rebuild succeed or fail.
   *
   * `nodeLoads`: exit codes for the full native load probe (0=ok, 1=fail).
   *   The wrapper-only require path succeeds by default, modeling lazy binding
   *   failures. Arrays configure sequential probes; the last value is reused.
   * `npmRebuildExit`: what `npm rebuild $addon` returns (0=ok, 1=fail).
   */
  function runGuard(opts: {
    releaseRoot: string;
    addonName?: string;
    /** Per-call exit codes for the native load probe. Single number = constant. */
    nodeLoads?: number | number[];
    /** Exit code for `npm rebuild`. */
    npmRebuildExit?: number;
  }): { status: number | null; stdout: string; stderr: string } {
    const binDir = join(work, 'fake-bin');
    mkdirSync(binDir, { recursive: true });

    // Write a stateful node stub. Uses a call-counter file so each invocation
    // can return a different exit code for sequential test scenarios.
    const callCountFile = join(work, 'node-call-count');
    const exitsArg = Array.isArray(opts.nodeLoads)
      ? opts.nodeLoads.join(' ')
      : String(opts.nodeLoads ?? 0);
    const nodeStub = [
      '#!/usr/bin/env bash',
      // Intercept the DB/query probe; a wrapper-only require succeeds by design.
      'if [[ "$*" == *"prepare"* && "$*" == *"SELECT 1"* ]]; then',
      `  exits=(${exitsArg})`,
      `  count_file=${JSON.stringify(callCountFile)}`,
      '  count=0; [ -f "$count_file" ] && count="$(cat "$count_file")"',
      '  idx=$(( count < ${#exits[@]} ? count : ${#exits[@]} - 1 ))',
      '  echo $(( count + 1 )) > "$count_file"',
      '  exit "${exits[$idx]}"',
      'fi',
      'if [[ "$*" == *"require("* ]]; then',
      '  exit 0',
      'fi',
      // For non-require calls (e.g. `node -p ...`), forward to the real node.
      `exec ${process.execPath} "$@"`,
    ].join('\n');
    writeFileSync(join(binDir, 'node'), nodeStub, { mode: 0o755 });

    // npm stub: always returns the requested exit code.
    const npmExit = opts.npmRebuildExit ?? 0;
    const npmStub = `#!/usr/bin/env bash\nexit ${npmExit}\n`;
    writeFileSync(join(binDir, 'npm'), npmStub, { mode: 0o755 });

    const addon = opts.addonName ?? 'better-sqlite3';
    const wrapper = [
      'set -uo pipefail',
      // Extract rebuild_stale_native_addons from the script, plus the log helper it calls.
      'log() { echo "[setup-release] $*"; }',
      "source <(sed -n -e '/^native_addon_load_check()/,/^rebuild_stale_native_addons()/ { /^rebuild_stale_native_addons()/!p; }' -e '/^rebuild_stale_native_addons()/,/^}/p' \"$SETUP_SCRIPT\")",
      'rebuild_stale_native_addons',
    ].join('\n');

    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        SETUP_SCRIPT: SCRIPT_PATH,
        RELEASE_ROOT: opts.releaseRoot,
        PAPERCUSP_PREFLIGHT_ADDONS: addon,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('skips an addon whose node_modules dir is absent (not installed on this path)', () => {
    // releaseRoot has no node_modules/better-sqlite3 → skip silently
    mkdirSync(join(work, 'release'), { recursive: true });
    const r = runGuard({ releaseRoot: join(work, 'release'), nodeLoads: 1 });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/WARN|ERROR|rebuild/i);
  });

  it('skips an addon whose native binding opens and queries cleanly', () => {
    const rel = join(work, 'release');
    mkdirSync(join(rel, 'node_modules', 'better-sqlite3'), { recursive: true });
    const r = runGuard({ releaseRoot: rel, nodeLoads: 0 }); // native binding probe → OK
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/WARN|ERROR|rebuild/i);
  });

  it('rebuilds when require succeeds but the lazy native binding cannot open a database', () => {
    // The JS wrapper require succeeds; the binding/query probe fails first,
    // then passes after npm rebuild.
    const rel = join(work, 'release');
    mkdirSync(join(rel, 'node_modules', 'better-sqlite3'), { recursive: true });
    const r = runGuard({ releaseRoot: rel, nodeLoads: [1, 0], npmRebuildExit: 0 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARN.*will not load/);
    expect(r.stdout).toMatch(/rebuilt OK/);
    expect(r.stdout).not.toMatch(/STILL will not load/);
  });

  it('logs ERROR and returns non-zero when addon still will not load after rebuild', () => {
    const rel = join(work, 'release');
    mkdirSync(join(rel, 'node_modules', 'better-sqlite3'), { recursive: true });
    // The wrapper require succeeds; the native binding probe fails both times.
    const r = runGuard({ releaseRoot: rel, nodeLoads: 1, npmRebuildExit: 0 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/WARN.*will not load/);
    expect(r.stdout).toMatch(/STILL will not load/);
  });

  it('logs ERROR and returns non-zero when npm rebuild itself fails', () => {
    const rel = join(work, 'release');
    mkdirSync(join(rel, 'node_modules', 'better-sqlite3'), { recursive: true });
    const r = runGuard({ releaseRoot: rel, nodeLoads: 1, npmRebuildExit: 1 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/WARN.*will not load/);
    expect(r.stdout).toMatch(/STILL will not load/);
  });

  it('respects PAPERCUSP_PREFLIGHT_ADDONS: skips when the named addon dir is absent', () => {
    const rel = join(work, 'release');
    mkdirSync(rel, { recursive: true });
    // sodium-native is not installed in this temp tree → guard skips it silently
    const r = runGuard({ releaseRoot: rel, addonName: 'sodium-native', nodeLoads: 1 });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/WARN|ERROR/);
  });

  it('integration: real better-sqlite3 loads cleanly under the current Node ABI (no rebuild needed)', () => {
    // Run the guard against the REAL integration tree's release checkout to confirm
    // the 2026-06-19 outage class is not currently manifesting.
    const releaseRoot = '/home/dev/papercupai-workspace/papercup-release';
    if (!existsSync(join(releaseRoot, 'node_modules', 'better-sqlite3'))) {
      // Release checkout not set up — skip (CI / fresh clone); not a test failure.
      return;
    }
    const wrapper = [
      'set -uo pipefail',
      'log() { echo "[setup-release] $*"; }',
      "source <(sed -n -e '/^native_addon_load_check()/,/^rebuild_stale_native_addons()/ { /^rebuild_stale_native_addons()/!p; }' -e '/^rebuild_stale_native_addons()/,/^}/p' \"$SETUP_SCRIPT\")",
      'rebuild_stale_native_addons',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        RELEASE_ROOT: releaseRoot,
        PAPERCUSP_PREFLIGHT_ADDONS: 'better-sqlite3',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    // No rebuild should be needed when the binary is already built for ABI 141.
    expect((r.stdout ?? '') + (r.stderr ?? '')).not.toMatch(/WARN|ERROR|rebuild/i);
  });
});

/**
 * Symlink-safe root resolution (EI-5307) — the node_modules copy enumeration must
 * survive a SYMLINKED INTEGRATION_ROOT.
 *
 * papercupai-workspace/papercup is a symlink -> papercusp (since 2026-06-25), and
 * deploy-cli passed that symlink as `--integration`. Step 3's copy loop enumerates
 * package-local node_modules with `find "$INTEGRATION_ROOT" -name node_modules -type d
 * -prune`, and `find` (default -P) does NOT descend a symlinked START path — so the
 * loop enumerated ZERO dirs and copied NOTHING while still logging "node_modules sync
 * complete". The release tree's node_modules stayed stale until the EI-2118
 * workspace-resolution gate aborted every deploy ("@papercusp/scheduled-registry
 * unresolved"), leaving live :3070 ~166 commits behind.
 *
 * The fix realpath-normalizes INTEGRATION_ROOT/RELEASE_ROOT right after arg-parse so
 * find/cp operate on the real tree regardless of how the caller named the root. The
 * existing deps tests only sed-extract need_node_modules/sync_one_node_modules — none
 * exercised root resolution, so this class could silently return. These lock it by
 * sourcing the SHIPPED normalization block (never a copy) and running the exact copy-loop
 * enumeration: the bug is real (symlink → nothing) and the fix cures it (symlink →
 * every dir, dereferenced to the real tree).
 */
describe('setup-release-checkout.sh — symlinked INTEGRATION_ROOT node_modules enumeration (EI-5307)', () => {
  let work: string;
  let realTree: string;
  let linkToTree: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'symlink-root-'));
    realTree = join(work, 'real');
    // A real integration tree: root node_modules + a package-local node_modules (both
    // must be enumerated), plus a .git so it reads as the integration repo.
    mkdirSync(join(realTree, 'node_modules/@papercusp'), { recursive: true });
    mkdirSync(join(realTree, 'packages/scheduled-registry/node_modules'), { recursive: true });
    mkdirSync(join(realTree, '.git'), { recursive: true });
    // Coordination state can contain complete repair worktrees with their own dependency
    // graphs. Those are runtime infrastructure, not product packages, and must never ride
    // into the checkpoint snapshot. Git metadata is excluded for the same reason.
    mkdirSync(join(realTree, '.papercusp/worktrees/repair/node_modules'), { recursive: true });
    mkdirSync(join(realTree, '.git/internal/node_modules'), { recursive: true });
    // The symlink deploy-cli passed as --integration (papercup -> papercusp).
    linkToTree = join(work, 'papercup-link');
    symlinkSync(realTree, linkToTree);
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /**
   * Run the copy-loop enumeration for INTEGRATION_ROOT=`root`. When `normalize` is set,
   * first source the SHIPPED realpath-normalization block out of the live script (so we
   * exercise the deployed fix, never a copy). Returns the enumerated node_modules dirs.
   */
  function enumerate(root: string, normalize: boolean): string[] {
    const lines = ['set -uo pipefail', `INTEGRATION_ROOT=${JSON.stringify(root)}`];
    lines.push(
      'source "$GENERATION_SCRIPT"',
      `source <(sed -n '/^enumerate_node_modules()/,/^}/p' "$SETUP_SCRIPT")`,
    );
    if (normalize) {
      lines.push(
        'RELEASE_ROOT="$INTEGRATION_ROOT"', // the shipped block normalizes both; unused here
        `source <(sed -n '/^# Symlink-safe roots/,/^RELEASE_ROOT="\\$(realpath -m/p' "$SETUP_SCRIPT")`,
      );
    }
    lines.push('enumerate_node_modules');
    const r = spawnSync('bash', ['-c', lines.join('\n')], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        GENERATION_SCRIPT: DEPENDENCY_GENERATION_SCRIPT,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`enumeration failed (${r.status}): ${r.stderr || r.stdout}`);
    return (r.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  it('the bug: find over a SYMLINKED root enumerates ZERO node_modules (silent no-op)', () => {
    // Passing the symlink verbatim (no normalization) — `find -P` won't descend it.
    expect(enumerate(linkToTree, /* normalize */ false)).toEqual([]);
  });

  it('a REAL root enumerates every package-local node_modules (sanity: the tree has them)', () => {
    const dirs = enumerate(realTree, /* normalize */ false);
    expect(dirs.length).toBe(2);
    expect(dirs.every((d) => d.endsWith('/node_modules'))).toBe(true);
  });

  it('prunes .papercusp repair worktrees and .git metadata before dependency matching', () => {
    // `find` does not promise directory-entry order; this contract is the exact
    // membership of the census and its pruning boundaries, not traversal order.
    const dirs = enumerate(realTree, /* normalize */ false).sort();
    expect(dirs).toEqual([
      join(realTree, 'node_modules'),
      join(realTree, 'packages/scheduled-registry/node_modules'),
    ].sort());
    expect(dirs.every((d) => !d.includes('/.papercusp/') && !d.includes('/.git/'))).toBe(true);
  });

  it('the fix: the shipped realpath normalization makes a SYMLINKED root enumerate them all', () => {
    const dirs = enumerate(linkToTree, /* normalize */ true);
    const realBase = realpathSync(realTree); // canonical (tmpdir itself may be symlinked)
    // Same set as the real tree — the copy loop now sees the node_modules dirs.
    expect(dirs.length).toBe(2);
    // …dereferenced under the REAL tree, never left on the symlink path.
    expect(dirs.every((d) => d.startsWith(realBase))).toBe(true);
    expect(dirs.some((d) => d.startsWith(linkToTree))).toBe(false);
  });
});

/**
 * EI-13127: `prune_post_pin_workspace_pkgs()` — the pin-aware companion to the
 * EI-2118 workspace-resolution fatal gate. A release symlink can dangle for two
 * reasons with opposite correct handling: (a) the package's source IS in the
 * target ref but extraction failed → real crash-loop risk, must stay for the
 * fatal gate; (b) the package was added to staging AFTER the pin (integration
 * node_modules reflects staging tip, release source reflects the pin) → pinned
 * code cannot import it, and fataling on it froze EVERY deploy (target and
 * rollback refs alike) until the next green pin — the 2026-07-16
 * @papercusp/release-profile deploy freeze. These tests pin the discriminator:
 * absent-from-TARGET_SHA ⇒ pruned; present-in-TARGET_SHA ⇒ left for the gate.
 */
describe('prune_post_pin_workspace_pkgs (EI-13127)', () => {
  let integrationRoot: string;
  let releaseRoot: string;
  let targetSha: string;

  function runPrune(): string {
    const wrapper = [
      'set -uo pipefail',
      'log() { echo "[log] $*"; }',
      'source <(sed -n "/^prune_post_pin_workspace_pkgs()/,/^}/p" "$SETUP_SCRIPT")',
      'prune_post_pin_workspace_pkgs',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        TARGET_SHA: targetSha,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`prune_post_pin_workspace_pkgs exited ${r.status}: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  const git = (...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-C', integrationRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  /** Source dir + package.json under <root>/libs/generic/<pkg>. */
  function addSource(root: string, pkg: string): void {
    const dir = join(root, 'libs', 'generic', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@papercusp/${pkg}` }));
  }

  /** Relative workspace symlink node_modules/@papercusp/<pkg> -> ../../libs/generic/<pkg>. */
  function linkPkg(root: string, pkg: string): void {
    const scopeDir = join(root, 'node_modules', '@papercusp');
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(join('..', '..', 'libs', 'generic', pkg), join(scopeDir, pkg));
  }

  beforeEach(() => {
    integrationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'prune-int-')));
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'prune-rel-')));
    // Pin contains ONLY in-pin-pkg…
    git('init', '-q');
    addSource(integrationRoot, 'in-pin-pkg');
    git('add', '-A');
    git('commit', '-q', '-m', 'pin');
    targetSha = git('rev-parse', 'HEAD');
    // …then post-pin-pkg lands on the working tree (staging tip) after the pin.
    addSource(integrationRoot, 'post-pin-pkg');
    linkPkg(integrationRoot, 'in-pin-pkg');
    linkPkg(integrationRoot, 'post-pin-pkg');
    // Release tree: node_modules copied from integration (both symlinks) but
    // source extracted at the PIN — only in-pin-pkg's source exists, and we
    // model the extraction failure by omitting BOTH sources so both dangle.
    linkPkg(releaseRoot, 'in-pin-pkg');
    linkPkg(releaseRoot, 'post-pin-pkg');
  });

  afterEach(() => {
    rmSync(integrationRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  it('prunes a dangling symlink for a package ABSENT from the target ref (post-pin) and logs it', () => {
    const out = runPrune();
    expect(existsSync(join(releaseRoot, 'node_modules', '@papercusp', 'post-pin-pkg'))).toBe(false);
    expect(lstatSync(join(releaseRoot, 'node_modules', '@papercusp', 'post-pin-pkg'), { throwIfNoEntry: false })).toBeUndefined();
    expect(out).toContain('pruned post-pin workspace package @papercusp/post-pin-pkg');
  });

  it('LEAVES a dangling symlink for a package PRESENT in the target ref (real extraction break → fatal gate)', () => {
    runPrune();
    // Symlink still there (dangling), so unresolved_workspace_pkgs still fatals on it.
    expect(lstatSync(join(releaseRoot, 'node_modules', '@papercusp', 'in-pin-pkg'), { throwIfNoEntry: false })).toBeDefined();
  });

  it('never touches a RESOLVABLE release package', () => {
    // Give the release tree the in-pin source so it resolves.
    addSource(releaseRoot, 'in-pin-pkg');
    const out = runPrune();
    expect(existsSync(join(releaseRoot, 'node_modules', '@papercusp', 'in-pin-pkg', 'package.json'))).toBe(true);
    expect(out).not.toContain('in-pin-pkg');
  });
});

/**
 * EI-13127 part 2: the prune alone was insufficient — unresolved_workspace_pkgs()
 * reports MISSING packages as unresolved too (by design, for in-pin packages),
 * so pruning a post-pin dangling symlink just converted "dangling" to "missing"
 * and the gate still fataled (observed live on deploy #3, 2026-07-16 23:17Z).
 * The gate itself now applies the same pin discriminator: a package whose
 * source is absent from TARGET_SHA is skipped; absent TARGET_SHA keeps the
 * original strict behavior.
 */
describe('unresolved_workspace_pkgs pin-awareness (EI-13127)', () => {
  let integrationRoot: string;
  let releaseRoot: string;
  let targetSha: string;

  function runGate(env: Record<string, string> = {}): string {
    const wrapper = [
      'set -uo pipefail',
      'source <(sed -n "/^unresolved_workspace_pkgs()/,/^}/p" "$SETUP_SCRIPT")',
      'unresolved_workspace_pkgs',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        ...env,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`unresolved_workspace_pkgs exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim();
  }

  const git2 = (...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-C', integrationRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  function addSrc(root: string, pkg: string): void {
    const dir = join(root, 'libs', 'generic', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@papercusp/${pkg}` }));
  }
  function link2(root: string, pkg: string): void {
    const scopeDir = join(root, 'node_modules', '@papercusp');
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(join('..', '..', 'libs', 'generic', pkg), join(scopeDir, pkg));
  }

  beforeEach(() => {
    integrationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gate-int-')));
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gate-rel-')));
    git2('init', '-q');
    addSrc(integrationRoot, 'in-pin-pkg');
    git2('add', '-A');
    git2('commit', '-q', '-m', 'pin');
    targetSha = git2('rev-parse', 'HEAD');
    addSrc(integrationRoot, 'post-pin-pkg');
    link2(integrationRoot, 'in-pin-pkg');
    link2(integrationRoot, 'post-pin-pkg');
    // Release tree: neither package resolves (both missing entirely — the
    // post-prune state for post-pin-pkg, an extraction break for in-pin-pkg).
  });

  afterEach(() => {
    rmSync(integrationRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  it('with TARGET_SHA: reports the in-pin break, SKIPS the post-pin package', () => {
    const out = runGate({ TARGET_SHA: targetSha });
    expect(out).toContain('@papercusp/in-pin-pkg');
    expect(out).not.toContain('post-pin-pkg');
  });

  it('without TARGET_SHA: original strict behavior — both reported', () => {
    const out = runGate();
    expect(out).toContain('@papercusp/in-pin-pkg');
    expect(out).toContain('@papercusp/post-pin-pkg');
  });
});

/**
 * WI-212675: a THIRD class the EI-13127 discriminator missed. That one asks
 * "does the package's SOURCE exist at TARGET_SHA?" — but a package whose
 * DIRECTORY landed before the pin while its root-`workspaces` entry landed
 * AFTER it answers "yes", and so was misreported as a genuine extraction break.
 * npm at TARGET_SHA creates no node_modules/<scope>/<pkg> link for such a
 * package, so no pinned code can import it: it is post-pin in every sense that
 * matters, exactly like a source that post-dates the pin.
 *
 * Measured live 2026-08-31: `@papercusp/agent-roster` — directory present at
 * FROZEN candidate 6da5cd4d, `workspaces` entry committed afterwards — crashed
 * green-checkpoint inside setup-release BEFORE a single test ran. Because the
 * candidate was frozen (freeze-and-converge), every subsequent run crashed
 * identically and the repair queue could never reach green.
 *
 * The discriminator is the PINNED LOCKFILE: authoritative for what the pinned
 * install actually contains, and a plain grep, which keeps this function pure
 * shell ("no Node — keeps this script standalone by design"). It applies ONLY
 * when that lockfile is readable; an unreadable/absent one keeps the original
 * strict behavior, so an undeterminable package is still REPORTED rather than
 * silently swallowed.
 */
describe('unresolved_workspace_pkgs lockfile membership (WI-212675)', () => {
  let integrationRoot: string;
  let releaseRoot: string;
  let targetSha: string;

  function runGate(env: Record<string, string> = {}): string {
    const wrapper = [
      'set -uo pipefail',
      'source <(sed -n "/^unresolved_workspace_pkgs()/,/^}/p" "$SETUP_SCRIPT")',
      'unresolved_workspace_pkgs',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        ...env,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`unresolved_workspace_pkgs exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim();
  }

  function runPrune(env: Record<string, string> = {}): void {
    const wrapper = [
      'set -uo pipefail',
      'log() { :; }',
      'source <(sed -n "/^prune_post_pin_workspace_pkgs()/,/^}/p" "$SETUP_SCRIPT")',
      'prune_post_pin_workspace_pkgs',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        ...env,
      },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`prune_post_pin_workspace_pkgs exited ${r.status}: ${r.stderr || r.stdout}`);
    }
  }

  const git3 = (...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-C', integrationRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  function addSrc3(pkg: string): void {
    const dir = join(integrationRoot, 'libs', 'generic', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@papercusp/${pkg}` }));
  }
  function link3(pkg: string): void {
    const scopeDir = join(integrationRoot, 'node_modules', '@papercusp');
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(join('..', '..', 'libs', 'generic', pkg), join(scopeDir, pkg));
  }
  /** A lockfile that links ONLY the named packages, npm lockfileVersion-3 shaped. */
  function writeLock(linked: string[]): void {
    const packages: Record<string, unknown> = { '': { name: 'root' } };
    for (const p of linked) {
      packages[`libs/generic/${p}`] = { name: `@papercusp/${p}` };
      packages[`node_modules/@papercusp/${p}`] = { resolved: `libs/generic/${p}`, link: true };
    }
    writeFileSync(
      join(integrationRoot, 'package-lock.json'),
      JSON.stringify({ name: 'root', lockfileVersion: 3, packages }, null, 2),
    );
  }

  beforeEach(() => {
    integrationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lockws-int-')));
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lockws-rel-')));
    git3('init', '-q');
    // BOTH sources exist at the pin. Only `linked-pkg` is a workspace there.
    addSrc3('linked-pkg');
    addSrc3('unlinked-pkg');
  });

  afterEach(() => {
    rmSync(integrationRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  it('skips a package whose source is in the pin but which the pinned lockfile never links', () => {
    writeLock(['linked-pkg']);
    git3('add', '-A');
    git3('commit', '-q', '-m', 'pin');
    targetSha = git3('rev-parse', 'HEAD');
    link3('linked-pkg');
    link3('unlinked-pkg');

    const out = runGate({ TARGET_SHA: targetSha });
    // The genuine in-pin extraction break is still fatal…
    expect(out).toContain('@papercusp/linked-pkg');
    // …but the one the pin never linked is not this deploy's problem.
    expect(out).not.toContain('unlinked-pkg');
  });

  it('keeps strict behavior when the pinned ref carries NO lockfile (undeterminable ⇒ reported)', () => {
    git3('add', '-A');
    git3('commit', '-q', '-m', 'pin-without-lockfile');
    targetSha = git3('rev-parse', 'HEAD');
    link3('linked-pkg');
    link3('unlinked-pkg');

    const out = runGate({ TARGET_SHA: targetSha });
    expect(out).toContain('@papercusp/linked-pkg');
    expect(out).toContain('@papercusp/unlinked-pkg');
  });

  it('prune removes the dangling release entry for a lockfile-unlinked package, and spares the linked one', () => {
    writeLock(['linked-pkg']);
    git3('add', '-A');
    git3('commit', '-q', '-m', 'pin');
    targetSha = git3('rev-parse', 'HEAD');
    link3('linked-pkg');
    link3('unlinked-pkg');

    // Release tree carries DANGLING symlinks for both (sources never extracted).
    const relScope = join(releaseRoot, 'node_modules', '@papercusp');
    mkdirSync(relScope, { recursive: true });
    symlinkSync(join('..', '..', 'libs', 'generic', 'linked-pkg'), join(relScope, 'linked-pkg'));
    symlinkSync(join('..', '..', 'libs', 'generic', 'unlinked-pkg'), join(relScope, 'unlinked-pkg'));

    runPrune({ TARGET_SHA: targetSha });

    // The lockfile-unlinked one is pruned; the in-pin one is left for the fatal gate.
    expect(existsSync(join(relScope, 'unlinked-pkg'))).toBe(false);
    expect(lstatSync(join(relScope, 'linked-pkg')).isSymbolicLink()).toBe(true);
  });
});

/**
 * WI-5110: green-checkpoint's stale-candidate re-triage twice reported a false
 * "failures REPRODUCE at tip <sha>" verdict (2026-07-17) — tests that demonstrably
 * PASSED when re-run by hand at the named tip. The re-triage trusts a zero exit
 * from this script as proof its throwaway tree is actually at the requested ref;
 * assert_checkout_landed() is the fix — a fatal, script-level guarantee that a
 * zero exit really does mean HEAD == TARGET_SHA, for every caller (candidate
 * judgment, tip re-run, prefix salvage), not just the tip-retriage path.
 */
describe('assert_checkout_landed (WI-5110)', () => {
  let releaseRoot: string;
  let targetSha: string;

  function runAssert(env: Record<string, string> = {}): { status: number | null; stderr: string } {
    const wrapper = [
      'set -uo pipefail',
      'source <(sed -n "/^assert_checkout_landed()/,/^}/p" "$SETUP_SCRIPT")',
      'assert_checkout_landed',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        RELEASE_ROOT: releaseRoot,
        TARGET_SHA: targetSha,
        REF: 'main',
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stderr: r.stderr };
  }

  const git3 = (...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-C', releaseRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(() => {
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'assert-checkout-')));
    git3('init', '-q');
    writeFileSync(join(releaseRoot, 'f.txt'), 'v1');
    git3('add', '-A');
    git3('commit', '-q', '-m', 'c1');
    targetSha = git3('rev-parse', 'HEAD');
  });

  afterEach(() => {
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  it('HEAD matches TARGET_SHA: exits 0, no FATAL', () => {
    const r = runAssert();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('FATAL');
  });

  it('HEAD is a DIFFERENT commit than TARGET_SHA: exits 1 with a FATAL naming both shas', () => {
    writeFileSync(join(releaseRoot, 'f.txt'), 'v2');
    git3('add', '-A');
    git3('commit', '-q', '-m', 'c2');
    const staleTargetSha = targetSha; // the tree moved on; TARGET_SHA still names the OLD commit
    const r = runAssert({ TARGET_SHA: staleTargetSha });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL');
    expect(r.stderr).toContain(staleTargetSha);
  });

  it('RELEASE_ROOT is not a git repo at all (git rev-parse fails): exits 1, reports "unknown" rather than crashing', () => {
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), 'not-a-repo-')));
    try {
      const r = runAssert({ RELEASE_ROOT: notARepo });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('FATAL');
      expect(r.stderr).toContain('unknown');
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

/**
 * EI-21181583819839124: a dead Git process left the checkpoint linked
 * worktree's index.lock behind. The gate's run-lock was idle and healthy, but
 * checkout setup failed before a test could run. The setup script may recover
 * only when the exact Git-resolved lock is old AND unowned; otherwise it must
 * leave the lock untouched and fail closed.
 */
describe('refresh_release_worktree — stale Git index.lock recovery (EI-21181583819839124)', () => {
  let releaseRoot: string;
  let quarantineRoot: string;
  let firstSha: string;
  let targetSha: string;

  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', releaseRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  // The holder probe's deadline is PER TEST. Only the stall test needs a short
  // one; a fake `fuser` that answers immediately still has to exec bash, and
  // under gate load that exec alone exceeded 0.1s (red at repair head
  // c5865549, 2026-09-27): the probe timed out, reported "unavailable", and the
  // live-holder / unowned verdicts under test were never reached.
  function runRefresh(fuserScript?: string, probeTimeoutSec = '30', integrationRoot?: string): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    let path = process.env.PATH ?? '';
    if (fuserScript != null) {
      const fakeBin = join(quarantineRoot, 'fake-bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'fuser'), `#!/usr/bin/env bash\n${fuserScript}`, { mode: 0o755 });
      path = `${fakeBin}:${path}`;
    }
    const wrapper = [
      'set -euo pipefail',
      'log() { printf "[test] %s\\n" "$*"; }',
      'source <(sed -n "/^index_lock_has_live_holder()/,/^}/p" "$SETUP_SCRIPT")',
      'source <(sed -n "/^quarantine_stale_worktree_index_lock()/,/^}/p" "$SETUP_SCRIPT")',
      'source <(sed -n "/^refresh_release_worktree()/,/^}/p" "$SETUP_SCRIPT")',
      'refresh_release_worktree',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot ?? join(quarantineRoot, 'no-integration-runtime'),
        RELEASE_ROOT: releaseRoot,
        TARGET_SHA: targetSha,
        TMPDIR: quarantineRoot,
        PATH: path,
        INDEX_LOCK_HOLDER_PROBE_TIMEOUT_SEC: probeTimeoutSec,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function createIndexLock(ageMs: number): string {
    const lockPath = join(releaseRoot, '.git/index.lock');
    writeFileSync(lockPath, 'stale-test-lock');
    const timestamp = new Date(Date.now() - ageMs);
    utimesSync(lockPath, timestamp, timestamp);
    return lockPath;
  }

  beforeEach(() => {
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'stale-index-lock-release-')));
    quarantineRoot = realpathSync(mkdtempSync(join(tmpdir(), 'stale-index-lock-quarantine-')));
    git('init', '-q');
    writeFileSync(join(releaseRoot, 'f.txt'), 'v1');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    firstSha = git('rev-parse', 'HEAD');
    writeFileSync(join(releaseRoot, 'f.txt'), 'v2');
    git('add', '-A');
    git('commit', '-q', '-m', 'c2');
    targetSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', firstSha);
  });

  afterEach(() => {
    rmSync(releaseRoot, { recursive: true, force: true });
    rmSync(quarantineRoot, { recursive: true, force: true });
  });

  it('moves an old unowned lock to recoverable quarantine, retries once, and lands TARGET_SHA', () => {
    const lockPath = createIndexLock(10 * 60_000);
    const result = runRefresh('exit 1\n');

    expect(result.status).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(git('rev-parse', 'HEAD')).toBe(targetSha);
    const quarantineDir = join(quarantineRoot, 'papercusp-stale-git-locks');
    expect(readdirSync(quarantineDir)).toHaveLength(1);
    expect(result.stdout).toContain('quarantined stale unowned Git index lock');
  });

  it('refuses a fresh lock and leaves both the lock and checkout untouched', () => {
    const lockPath = createIndexLock(1_000);
    const result = runRefresh();

    expect(result.status).not.toBe(0);
    expect(existsSync(lockPath)).toBe(true);
    expect(git('rev-parse', 'HEAD')).toBe(firstSha);
    expect(result.stdout).toContain('refusing to reclaim fresh Git index lock');
  });

  it('refuses an old lock while a live process still holds it open', () => {
    const lockPath = createIndexLock(10 * 60_000);
    const fd = openSync(lockPath, 'r');
    try {
      const result = runRefresh('exit 0\n');
      expect(result.status).not.toBe(0);
      expect(existsSync(lockPath)).toBe(true);
      expect(git('rev-parse', 'HEAD')).toBe(firstSha);
      expect(result.stdout).toContain('held by a live process');
    } finally {
      closeSync(fd);
    }
  });

  it('fails closed promptly when the live-holder probe stalls', () => {
    const lockPath = createIndexLock(10 * 60_000);
    const startedAt = Date.now();
    const result = runRefresh('sleep 60\n', '0.1');

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.status).not.toBe(0);
    expect(existsSync(lockPath)).toBe(true);
    expect(git('rev-parse', 'HEAD')).toBe(firstSha);
    expect(result.stdout).toContain('live-holder probe was unavailable');
  });

  it('reuses the parallel git-sync scanner when fuser would give an unusable verdict', () => {
    const lockPath = createIndexLock(10 * 60_000);
    // A false "held" fallback must not override the complete primary scan.
    const result = runRefresh('exit 0\n', '30', REPO_ROOT);

    expect(result.status).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(git('rev-parse', 'HEAD')).toBe(targetSha);
    expect(result.stdout).toContain('quarantined stale unowned Git index lock');
  }, 120_000);

  it('the parallel scanner preserves a real live holder even if fuser would miss it', () => {
    const lockPath = createIndexLock(10 * 60_000);
    const fd = openSync(lockPath, 'r');
    try {
      const result = runRefresh('exit 1\n', '30', REPO_ROOT);
      expect(result.status).not.toBe(0);
      expect(existsSync(lockPath)).toBe(true);
      expect(git('rev-parse', 'HEAD')).toBe(firstSha);
      expect(result.stdout).toContain('held by a live process');
    } finally {
      closeSync(fd);
    }
  }, 120_000);

  it('keeps an old lock when neither the maintained scanner nor fuser can answer', () => {
    const lockPath = createIndexLock(10 * 60_000);
    const result = runRefresh('exit 2\n');
    expect(result.status).not.toBe(0);
    expect(existsSync(lockPath)).toBe(true);
    expect(git('rev-parse', 'HEAD')).toBe(firstSha);
    expect(result.stdout).toContain('live-holder probe was unavailable');
  });

  it('preserves a replacement lock created while the holder probe is running', () => {
    const lockPath = createIndexLock(10 * 60_000);
    const result = runRefresh('rm -- "$1"\nprintf "new writer" > "$1"\nexit 1\n');
    expect(result.status).not.toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe('new writer');
    expect(git('rev-parse', 'HEAD')).toBe(firstSha);
    expect(result.stdout).toContain('changed during its holder probe');
  });
});

/**
 * EI-20336479620858625: Route A can finish a regular pinned clone and its
 * submodules before dependency preparation is retried. `--prepare-existing`
 * must validate that pin and refresh dependencies without resetting, cleaning,
 * or replacing the already-verified source checkout.
 */
describe('setup-release-checkout.sh --prepare-existing (EI-20336479620858625)', () => {
  let integrationRoot: string;
  let releaseRoot: string;
  let targetSha: string;
  // Small fixtures exercise allocation boundaries explicitly, independent of
  // the host's current free space and its production reserve.
  const sourceCloneEnv = () => ({
    ...process.env,
    DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '0',
    DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '0',
    DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(dirname(releaseRoot), 'copy.lock'),
  });

  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync(
      'git',
      ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(() => {
    integrationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'prepare-int-')));
    git(integrationRoot, 'init', '-q');
    writeFileSync(join(integrationRoot, '.gitignore'), 'ignored-cache/\n');
    writeFileSync(join(integrationRoot, 'tracked.txt'), 'pinned source\n');
    git(integrationRoot, 'add', '-A');
    git(integrationRoot, 'commit', '-q', '-m', 'pinned');
    targetSha = git(integrationRoot, 'rev-parse', 'HEAD');

    const releaseParent = realpathSync(mkdtempSync(join(tmpdir(), 'prepare-rel-')));
    releaseRoot = join(releaseParent, 'clone');
    const clone = spawnSync('git', ['clone', '-q', integrationRoot, releaseRoot], { encoding: 'utf8' });
    if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr}`);
    writeFileSync(join(releaseRoot, 'untracked-sentinel.txt'), 'keep me\n');
    mkdirSync(join(releaseRoot, 'ignored-cache'), { recursive: true });
    writeFileSync(join(releaseRoot, 'ignored-cache', 'stale.txt'), 'keep me too\n');
  });

  afterEach(() => {
    rmSync(integrationRoot, { recursive: true, force: true });
    rmSync(join(releaseRoot, '..'), { recursive: true, force: true });
  });

  function runPrepare(args: string[] = []) {
    return spawnSync(
      'bash',
      [SCRIPT_PATH, '--prepare-existing', '--integration', integrationRoot, '--release', releaseRoot, '--node-modules', 'skip', ...args],
      { encoding: 'utf8' },
    );
  }

  it.each(['missing store', 'missing generation'])('EI-252238 refuses %s before changing the source checkout', (missing) => {
    writeFileSync(join(integrationRoot, 'new-tip.txt'), 'new tip\n');
    git(integrationRoot, 'add', '-A');
    git(integrationRoot, 'commit', '-q', '-m', 'new tip');
    const generationRoot = join(integrationRoot, 'missing-generations');
    if (missing === 'missing generation') mkdirSync(generationRoot);
    const result = spawnSync('bash', [SCRIPT_PATH,
      '--integration', integrationRoot, '--release', releaseRoot, '--ref', 'HEAD',
      '--node-modules', 'force', '--node-modules-copy', 'copy',
      '--node-modules-generation', 'required', '--node-modules-generation-id', `v1-${'a'.repeat(64)}`,
      '--dependency-generation-root', generationRoot,
    ], { encoding: 'utf8', timeout: 10_000 });

    expect(result.status, result.stderr).toBe(74);
    expect(result.stderr).toContain('disappeared before it could be leased');
    expect(git(releaseRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
    expect(readFileSync(join(releaseRoot, 'untracked-sentinel.txt'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(join(releaseRoot, 'ignored-cache', 'stale.txt'), 'utf8')).toBe('keep me too\n');
  });

  it('EI-252238 holds one explicit-generation lease during source checkout and releases it after pinning', () => {
    const generationRoot = join(dirname(releaseRoot), 'fixture-generations');
    mkdirSync(join(integrationRoot, 'node_modules/lease-fixture'), { recursive: true });
    writeFileSync(join(integrationRoot, 'node_modules/lease-fixture/package.json'), '{}');
    const published = spawnSync('bash', ['-c',
      'set -euo pipefail; source "$1"; dependency_generation_ensure "$2" "$3"; printf "FIXTURE_ID=%s\\n" "$DEPENDENCY_GENERATION_ID"',
      'fixture', DEPENDENCY_GENERATION_SCRIPT, integrationRoot, generationRoot,
    ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env,
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(generationRoot, 'fixture-copy.lock') } });
    expect(published.status, published.stderr).toBe(0);
    const identity = /^FIXTURE_ID=(v1-[0-9a-f]{64})$/m.exec(published.stdout)?.[1];
    expect(identity).toBeDefined();

    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const bin = join(integrationRoot, 'git-probe');
    const observed = join(integrationRoot, 'checkout-leases');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
case " $* " in
  *" checkout --detach "*)
    grep -l -F "identity=$REGRESSION_GENERATION_ID" "$REGRESSION_GENERATION_ROOT"/.leases/selector-* > "$REGRESSION_LEASE_OBSERVED" 2>/dev/null || true
    ;;
esac
exec "$REGRESSION_REAL_GIT" "$@"
`, { mode: 0o755 });
    const result = spawnSync('bash', [SCRIPT_PATH,
      '--integration', integrationRoot, '--release', releaseRoot, '--ref', targetSha,
      '--node-modules', 'force', '--node-modules-copy', 'copy',
      '--node-modules-generation', 'required', '--node-modules-generation-id', identity!,
      '--dependency-generation-root', generationRoot,
    ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(generationRoot, 'fixture-copy.lock'),
      REGRESSION_REAL_GIT: realGit, REGRESSION_GENERATION_ROOT: generationRoot,
      REGRESSION_GENERATION_ID: identity, REGRESSION_LEASE_OBSERVED: observed } });

    expect(result.status, result.stderr).toBe(0);
    const observedLeases = readFileSync(observed, 'utf8').trim();
    expect(observedLeases).toContain('/.leases/selector-');
    expect(observedLeases.split('\n')).toHaveLength(1);
    const leaseDir = join(generationRoot, '.leases');
    expect(existsSync(leaseDir)
      ? readdirSync(leaseDir).filter(name => name.startsWith('selector-')) : []).toEqual([]);
    expect(existsSync(join(releaseRoot, 'node_modules/lease-fixture/package.json'))).toBe(true);
  });

  it('preserves an existing pinned clone while running dependency-only preparation', () => {
    mkdirSync(join(integrationRoot, 'node_modules', 'dependency-only-fixture'), { recursive: true });
    writeFileSync(join(integrationRoot, 'node_modules', 'dependency-only-fixture', 'package.json'), '{}');
    const r = runPrepare(['--node-modules', 'force']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dependency-only');
    expect(git(releaseRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
    expect(existsSync(join(releaseRoot, 'node_modules', 'dependency-only-fixture', 'package.json'))).toBe(true);
    expect(readFileSync(join(releaseRoot, 'untracked-sentinel.txt'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(join(releaseRoot, 'ignored-cache', 'stale.txt'), 'utf8')).toBe('keep me too\n');
  });

  it('fails closed when an explicit ref does not match the existing clone HEAD', () => {
    writeFileSync(join(integrationRoot, 'new-tip.txt'), 'new tip\n');
    git(integrationRoot, 'add', '-A');
    git(integrationRoot, 'commit', '-q', '-m', 'new tip');

    const r = runPrepare(['--ref', 'HEAD']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not match requested ref');
    expect(git(releaseRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
  });

  it.each([
    { dependenciesOnly: true, fault: 'none' },
    { dependenciesOnly: false, fault: 'none' },
    { dependenciesOnly: true, fault: 'input-mismatch' },
    { dependenciesOnly: true, fault: 'native-missing' },
    { dependenciesOnly: true, fault: 'native-probe-drift' },
  ])('dependencies-only=$dependenciesOnly fault=$fault preserves frozen input readiness', ({ dependenciesOnly, fault }) => {
    const workspace = 'libs/generic/sse';
    const asset = 'apps/operator/public/runtime/asset.js';
    const rootfs = 'papercusp-desktop/src-tauri/resources/papercup-runtime.tar.gz';
    const nativeProbe = join(dirname(releaseRoot), 'native-probed');
    writeFileSync(join(integrationRoot, '.gitignore'),
      'node_modules/\n**/dist/\napps/operator/public/runtime/\n' + rootfs + '\n');
    writeFileSync(join(integrationRoot, 'package.json'), JSON.stringify({
      name: 'preparation-fixture', private: true, workspaces: [workspace],
    }));
    mkdirSync(join(integrationRoot, workspace), { recursive: true });
    writeFileSync(join(integrationRoot, workspace, 'package.json'), JSON.stringify({
      name: '@papercusp/sse', version: '1.0.0', scripts: { build: 'node build.cjs' },
    }));
    writeFileSync(join(integrationRoot, workspace, 'build.cjs'),
      "require('node:fs').mkdirSync('dist', {recursive:true}); require('node:fs').writeFileSync('dist/index.js', 'built');");
    mkdirSync(dirname(join(integrationRoot, rootfs)), { recursive: true });
    writeFileSync(join(integrationRoot, rootfs), '');
    writeFileSync(join(integrationRoot, dirname(rootfs), '.rootfs-build-stamp'), JSON.stringify({
      rootfsSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    }));
    mkdirSync(dirname(join(integrationRoot, asset)), { recursive: true });
    writeFileSync(join(integrationRoot, asset), 'donor asset');
    mkdirSync(join(integrationRoot, 'node_modules/@papercusp'), { recursive: true });
    symlinkSync('../../' + workspace, join(integrationRoot, 'node_modules/@papercusp/sse'));
    addPkg(integrationRoot, 'better-sqlite3');
    writeFileSync(join(integrationRoot, 'node_modules/better-sqlite3/index.js'),
      fault === 'native-missing' ? "throw new Error('missing native binding');" :
        "module.exports = class { constructor() { require('node:fs').writeFileSync(process.env.PREPARATION_NATIVE_PROBE, 'checked'); " +
        (fault === 'native-probe-drift' ? "require('node:fs').writeFileSync(__dirname + '/probe-generated.node', 'changed'); " : '') +
        "} prepare() { return { get() { return { result:1 }; } }; } close() {} };");
    git(integrationRoot, 'add', '-A');
    git(integrationRoot, 'commit', '-q', '-m', 'preparation fixture');
    targetSha = git(integrationRoot, 'rev-parse', 'HEAD');
    git(releaseRoot, 'fetch', '-q', 'origin');
    git(releaseRoot, 'checkout', '-q', '--detach', targetSha);
    rmSync(join(releaseRoot, 'ignored-cache'), { recursive: true });
    rmSync(join(releaseRoot, 'untracked-sentinel.txt'));

    const generationRoot = join(dirname(releaseRoot), 'generations');
    const env = { ...sourceCloneEnv(), PREPARATION_NATIVE_PROBE: nativeProbe };
    const published = spawnSync('bash', ['-c',
      'set -euo pipefail; source "$1"; dependency_generation_ensure "$2" "$3"; ' +
        'dependency_generation_publish_input_selector "$3" "$(dependency_generation_input_fingerprint_ref "$2" HEAD)"; ' +
        'printf "FIXTURE_ID=%s\\n" "$DEPENDENCY_GENERATION_ID"',
      'fixture', DEPENDENCY_GENERATION_SCRIPT, integrationRoot, generationRoot,
    ], { encoding: 'utf8', timeout: 30_000, env });
    expect(published.status, published.stdout + published.stderr).toBe(0);
    const identity = /^FIXTURE_ID=(v1-[0-9a-f]{64})$/m.exec(published.stdout)?.[1];
    expect(identity).toBeDefined();
    if (fault === 'input-mismatch') {
      writeFileSync(join(integrationRoot, 'package-lock.json'), JSON.stringify({
        lockfileVersion: 3, packages: { '': { name: 'different-inputs' } },
      }));
      git(integrationRoot, 'add', 'package-lock.json');
      git(integrationRoot, 'commit', '-q', '-m', 'different target dependency inputs');
      targetSha = git(integrationRoot, 'rev-parse', 'HEAD');
      git(releaseRoot, 'fetch', '-q', 'origin');
      git(releaseRoot, 'checkout', '-q', '--detach', targetSha);
    }
    const result = spawnSync('bash', [SCRIPT_PATH, '--prepare-existing',
      ...(dependenciesOnly ? ['--dependencies-only'] : []),
      '--integration', integrationRoot, '--release', releaseRoot, '--ref', targetSha,
      '--node-modules', 'force', '--node-modules-copy', 'copy',
      '--node-modules-generation-id', identity!, '--dependency-generation-root', generationRoot,
    ], { encoding: 'utf8', timeout: 30_000, env });

    if (fault !== 'none') {
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout).not.toContain('SETUP_RELEASE_DEPENDENCIES_ONLY');
      expect(result.stdout).toContain(fault === 'input-mismatch' ? 'committed input/generation mismatch' :
        fault === 'native-missing' ? 'publish a native-complete generation' : 'materialized dependency tree drift');
      expect(result.stdout).not.toContain('rebuilding in the release checkout');
      if (fault === 'input-mismatch') {
        expect(existsSync(join(releaseRoot, 'node_modules'))).toBe(false);
      }
      return;
    }
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(nativeProbe, 'utf8')).toBe('checked');
    expect(readFileSync(join(releaseRoot, 'node_modules/.papercusp-dependency-generation'), 'utf8'))
      .toContain(`identity=${identity}\n`);
    expect(git(releaseRoot, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    for (const path of [asset, rootfs, workspace + '/dist/index.js']) {
      expect(existsSync(join(releaseRoot, path)), path).toBe(!dependenciesOnly);
    }
    if (dependenciesOnly) {
      expect(result.stdout).toContain('SETUP_RELEASE_DEPENDENCIES_ONLY');
      const ignored = git(releaseRoot, 'ls-files', '--others', '--ignored', '--exclude-standard').split('\n').filter(Boolean);
      expect(ignored.length).toBeGreaterThan(0);
      expect(ignored.filter(path => !path.startsWith('node_modules/'))).toEqual([]);
    }
  });

  it.each([
    ['--dependencies-only'],
    ['--prepare-existing', '--dependencies-only', '--build-spa'],
    ['--prepare-existing', '--dependencies-only', '--spa-only'],
    ['--prepare-existing', '--dependencies-only', '--source-only'],
  ])('refuses incompatible dependencies-only arguments %j before checkout mutation', (...args) => {
    const result = spawnSync('bash', [SCRIPT_PATH, ...args,
      '--integration', integrationRoot, '--release', releaseRoot], { encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(readFileSync(join(releaseRoot, 'untracked-sentinel.txt'), 'utf8')).toBe('keep me\n');
    expect(git(releaseRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
  });

  it('P-007: source-only prepares the exact checkout and stops before dependency materialization', () => {
    const sourceOnlyRoot = join(dirname(releaseRoot), 'source-only');
    mkdirSync(join(integrationRoot, 'node_modules/source-only-sentinel'), {
      recursive: true,
    });
    writeFileSync(
      join(
        integrationRoot,
        'node_modules/source-only-sentinel/package.json',
      ),
      '{}',
    );

    const r = spawnSync(
      'bash',
      [
        SCRIPT_PATH,
        '--source-only',
        '--ref',
        targetSha,
        '--integration',
        integrationRoot,
        '--release',
        sourceOnlyRoot,
        '--node-modules',
        'force',
      ],
      { encoding: 'utf8' },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `[setup-release] SETUP_RELEASE_SOURCE_ONLY ref=${targetSha} sha=${targetSha} status=ready`,
    );
    expect(git(sourceOnlyRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
    expect(
      existsSync(
        join(sourceOnlyRoot, 'node_modules/source-only-sentinel/package.json'),
      ),
    ).toBe(false);
  });

  it('P-007: rejects conflicting source-only and dependency-only modes', () => {
    const r = runPrepare(['--source-only']);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      '--source-only and --prepare-existing are mutually exclusive',
    );
  });

  it('source-only clone produces independent exact source without registering a worktree', () => {
    const destination = join(dirname(releaseRoot), 'source-clone');
    const before = git(integrationRoot, 'worktree', 'list', '--porcelain');
    writeFileSync(join(integrationRoot, 'tracked.txt'), 'uncommitted tracked donor content\n');
    writeFileSync(join(integrationRoot, 'donor-dirty.txt'), 'uncommitted donor content\n');
    const args = [SCRIPT_PATH, '--source-only', '--source-root-mode', 'clone',
      '--source-integrity', 'object-sourced', '--ref', targetSha,
      '--integration', integrationRoot, '--release', destination];
    const result = spawnSync('bash', args, { encoding: 'utf8', env: sourceCloneEnv() });
    expect(result.status, result.stderr).toBe(0);
    expect(git(destination, 'rev-parse', 'HEAD')).toBe(targetSha);
    expect(git(destination, 'rev-parse', '--git-common-dir')).toBe('.git');
    expect(git(destination, 'status', '--porcelain', '-uno')).toBe('');
    expect(git(integrationRoot, 'worktree', 'list', '--porcelain')).toBe(before);
    expect(existsSync(join(destination, 'node_modules'))).toBe(false);
    expect(readFileSync(join(destination, 'tracked.txt'), 'utf8')).toBe('pinned source\n');
    expect(existsSync(join(destination, 'donor-dirty.txt'))).toBe(false);
    const objects = git(integrationRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
    const objectId = git(integrationRoot, 'rev-parse', `${targetSha}^{tree}`);
    const objectPath = join(objectId.slice(0, 2), objectId.slice(2));
    expect(statSync(join(destination, '.git/objects', objectPath)).ino)
      .toBe(statSync(join(objects, objectPath)).ino);
    expect(existsSync(join(destination, '.git/objects/info/alternates'))).toBe(false);
    expect(statSync(join(destination, 'tracked.txt')).ino)
      .not.toBe(statSync(join(integrationRoot, 'tracked.txt')).ino);
    git(destination, 'update-ref', 'refs/heads/clone-only', targetSha);
    expect(git(integrationRoot, 'for-each-ref', '--format=%(refname)', 'refs/heads/clone-only')).toBe('');
    expect(result.stdout).toContain('SOURCE_CLONE_CAPACITY required_kib=');
    writeFileSync(join(destination, 'preserved.txt'), 'existing build inputs\n');
    const again = spawnSync('bash', args, { encoding: 'utf8' });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('clone source destination already exists');
    expect(readFileSync(join(destination, 'preserved.txt'), 'utf8')).toBe('existing build inputs\n');
  });

  it('source-only clone refuses insufficient capacity before creating the destination', () => {
    const destination = join(dirname(releaseRoot), 'capacity-refused');
    const bin = join(dirname(releaseRoot), 'capacity-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'df'), '#!/usr/bin/env bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 10 9 1 90%% /\\n"\n', { mode: 0o755 });
    const result = spawnSync('bash', [SCRIPT_PATH, '--source-only', '--source-root-mode', 'clone',
      '--ref', targetSha, '--integration', integrationRoot, '--release', destination], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('insufficient source-clone capacity');
    expect(existsSync(destination)).toBe(false);
  });

  it('refuses a source clone that fits but would consume the shared write reserve', () => {
    const destination = join(dirname(releaseRoot), 'reserve-refused');
    const result = spawnSync('bash', [SCRIPT_PATH, '--source-only', '--source-root-mode', 'clone',
      '--ref', targetSha, '--integration', integrationRoot, '--release', destination], {
      encoding: 'utf8', env: {
        ...sourceCloneEnv(),
        DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '2',
        DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: String(100 * 1024 ** 3),
        DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: String(64 * 1024 ** 2),
      },
    });
    expect(result.status).toBe(77);
    expect(result.stderr).toContain('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(integrationRoot, 'tracked.txt'), 'utf8')).toBe('pinned source\n');
  });

  it.each([false, true])('refuses a nested source clone before auto-commit can capture it (symlink=%s)', (viaSymlink) => {
    const inside = join(integrationRoot, 'private-proof');
    const alias = join(dirname(releaseRoot), 'integration-alias');
    if (viaSymlink) symlinkSync(integrationRoot, alias);
    const destination = viaSymlink ? join(alias, 'private-proof') : inside;
    const result = spawnSync('bash', [SCRIPT_PATH, '--source-only', '--source-root-mode', 'clone',
      '--ref', targetSha, '--integration', integrationRoot, '--release', destination], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source clone destination must be outside integration tree');
    expect(existsSync(inside)).toBe(false);
    expect(git(integrationRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
  });

  it('refuses an unnamed gitlink before allocating the root clone and names the supported verifier route', () => {
    git(integrationRoot, 'update-index', '--add', '--cacheinfo', `160000,${targetSha},libs/unnamed`);
    git(integrationRoot, 'commit', '-q', '-m', 'unnamed gitlink');
    const pin = git(integrationRoot, 'rev-parse', 'HEAD');
    const destination = join(dirname(releaseRoot), 'unnamed-refused');
    const result = spawnSync('bash', [SCRIPT_PATH, '--source-only', '--source-root-mode', 'clone',
      '--ref', pin, '--integration', integrationRoot, '--release', destination], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain('contains gitlinks without .gitmodules');
    expect(result.stderr).toContain('use verifier-prepare');
    expect(existsSync(destination)).toBe(false);
  });

  it('source-only clone copies objects when the object store is on another device', () => {
    const destination = join(dirname(releaseRoot), 'cross-device-clone');
    const bin = join(dirname(releaseRoot), 'device-bin');
    mkdirSync(bin);
    const realStat = spawnSync('bash', ['-c', 'command -v stat'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bin, 'stat'), [
      '#!/usr/bin/env bash',
      'if [ "$1" = "-c" ] && [ "$2" = "%d" ]; then',
      '  case "$3" in */.git/objects) echo 111 ;; *) echo 222 ;; esac',
      'else exec "$REAL_STAT" "$@"; fi',
    ].join('\n'), { mode: 0o755 });
    const result = spawnSync('bash', [SCRIPT_PATH, '--source-only', '--source-root-mode', 'clone',
      '--ref', targetSha, '--integration', integrationRoot, '--release', destination], {
      encoding: 'utf8', env: { ...sourceCloneEnv(), PATH: `${bin}:${process.env.PATH}`, REAL_STAT: realStat },
    });
    expect(result.status, result.stderr).toBe(0);
    const objectId = git(integrationRoot, 'rev-parse', `${targetSha}^{tree}`);
    const objectPath = join(objectId.slice(0, 2), objectId.slice(2));
    expect(statSync(join(destination, '.git/objects', objectPath)).ino)
      .not.toBe(statSync(join(integrationRoot, '.git/objects', objectPath)).ino);
    expect(git(destination, 'rev-parse', 'HEAD')).toBe(targetSha);
    expect(readFileSync(join(destination, 'tracked.txt'), 'utf8')).toBe('pinned source\n');
  });

  it('source-only clone recursively materializes the exact gitlink from local objects', () => {
    const child = join(dirname(releaseRoot), 'child-donor');
    mkdirSync(child);
    git(child, 'init', '-q');
    writeFileSync(join(child, 'child.txt'), 'pinned child\n');
    git(child, 'add', '-A');
    git(child, 'commit', '-q', '-m', 'child');
    const childSha = git(child, 'rev-parse', 'HEAD');
    git(integrationRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'libs/child');
    git(integrationRoot, 'commit', '-q', '-m', 'child gitlink');
    const sourceSha = git(integrationRoot, 'rev-parse', 'HEAD');
    writeFileSync(join(integrationRoot, 'libs/child/child.txt'), 'dirty child\n');
    const destination = join(dirname(releaseRoot), 'source-clone-gitlink');
    const result = spawnSync('bash', [SCRIPT_PATH, '--source-only', '--source-root-mode', 'clone',
      '--source-integrity', 'object-sourced', '--ref', sourceSha,
      '--integration', integrationRoot, '--release', destination], { encoding: 'utf8', env: sourceCloneEnv() });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(git(join(destination, 'libs/child'), 'rev-parse', 'HEAD')).toBe(childSha);
    expect(readFileSync(join(destination, 'libs/child/child.txt'), 'utf8')).toBe('pinned child\n');
    expect(git(destination, 'ls-files', '--recurse-submodules')).toContain('libs/child/child.txt');
    expect(git(destination, 'status', '--porcelain', '-uno')).toBe('');
  });

  it('clone source mode refuses dependency preparation and invalid mode values', () => {
    for (const mode of ['clone', 'invalid']) {
      const result = runPrepare(['--source-root-mode', mode]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(mode === 'clone' ? 'requires --source-only' : 'bad --source-root-mode');
    }
  });

  it.each([0, 19])('SPA-only reuses pinned source and dependencies, preserves build status %i', (status) => {
    const bin = join(integrationRoot, 'spa-bin');
    const calls = join(integrationRoot, 'spa-calls');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$SPA_CALLS"\necho SPA_FIXTURE_DIAGNOSTIC\nexit "$SPA_STATUS"\n', { mode: 0o755 });
    mkdirSync(join(releaseRoot, 'node_modules/spa-sentinel'), { recursive: true });
    writeFileSync(join(releaseRoot, 'node_modules/spa-sentinel/package.json'), 'existing dependency\n');
    writeFileSync(join(releaseRoot, 'spa-source-sentinel'), 'existing source\n');
    const result = spawnSync('bash', [SCRIPT_PATH, '--spa-only', '--integration', integrationRoot,
      '--release', releaseRoot, '--ref', targetSha, '--node-modules', 'force'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        SPA_CALLS: calls, SPA_STATUS: String(status) },
    });
    expect(result.status, result.stderr).toBe(status === 0 ? 0 : 1);
    expect(readFileSync(calls, 'utf8')).toBe('--workspace @papercusp/operator-vite run build\n');
    expect(git(releaseRoot, 'rev-parse', 'HEAD')).toBe(targetSha);
    expect(readFileSync(join(releaseRoot, 'spa-source-sentinel'), 'utf8')).toBe('existing source\n');
    expect(readFileSync(join(releaseRoot, 'node_modules/spa-sentinel/package.json'), 'utf8')).toBe('existing dependency\n');
    expect(result.stdout).not.toContain('preserving existing checkout and submodules');
    if (status !== 0) expect(result.stderr).toContain('SPA_FIXTURE_DIAGNOSTIC');
  });
});

/**
 * WI-5366: the worktree-refresh clean step only ever ran plain `git clean -fdq
 * -e node_modules` — which does NOT remove gitignored files (that requires `-x`).
 * Verified live in the running papercusp-checkpoint tree: package-local
 * `.vitest-tmp/` and `.papercusp-tmp/node-compile-cache/` dirs dated 17+ days
 * and untold checkouts stale, because they are ignored (not merely untracked)
 * and `-x` was never passed. A throwaway, correctness-critical tree (this
 * script's own header) must never let a stale gitignored artifact from a PRIOR
 * checkout at a DIFFERENT commit survive into the next one — the same class of
 * risk `--node-modules force` (over `auto`) already exists to close for
 * node_modules specifically. This locks `-x` in so the class can't regress,
 * while confirming node_modules itself is still spared (the one directory this
 * tree deliberately preserves + refreshes via its own hardlink-copy step).
 */
describe('worktree clean step removes gitignored debris without deleting live runtime assets (WI-5366, EI-20509311930433301)', () => {
  it('`-x` removes stale caches while preserving node_modules and the running operator dist-host tree', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clean-x-')));
    try {
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
          encoding: 'utf8',
        });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
        return r.stdout.trim();
      };
      git('init', '-q');
      writeFileSync(join(dir, '.gitignore'), '.vitest-tmp/\napps/operator/dist-host/\n');
      writeFileSync(join(dir, 'f.txt'), 'v1');
      git('add', '-A');
      git('commit', '-q', '-m', 'c1');

      // Simulate what a prior checkpoint run leaves behind: a gitignored cache
      // dir, plus node_modules (which the real script preserves + refreshes
      // itself — clean must never touch it).
      mkdirSync(join(dir, '.vitest-tmp'), { recursive: true });
      writeFileSync(join(dir, '.vitest-tmp', 'stale-cache-entry'), 'stale');
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'marker'), 'keep-me');
      mkdirSync(join(dir, 'apps/operator/dist-host/sql'), { recursive: true });
      writeFileSync(join(dir, 'apps/operator/dist-host/hono-host.mjs'), 'running-bundle');
      writeFileSync(join(dir, 'apps/operator/dist-host/sql/001-bootstrap.sql'), 'running-lock-ddl');

      // Old behavior (no -x): the gitignored dir survives.
      spawnSync('git', ['-C', dir, 'clean', '-fdq', '-e', 'node_modules']);
      expect(existsSync(join(dir, '.vitest-tmp', 'stale-cache-entry'))).toBe(true);

      // Shipped behavior (-x): stale caches are gone, while the two runtime
      // asset sets needed before restart remain coherent and available.
      spawnSync('git', [
        '-C', dir, 'clean', '-fdqx',
        '-e', 'node_modules',
        '-e', '/apps/operator/dist-host/',
      ]);
      expect(existsSync(join(dir, '.vitest-tmp'))).toBe(false);
      expect(existsSync(join(dir, 'node_modules', 'marker'))).toBe(true);
      expect(existsSync(join(dir, 'apps/operator/dist-host/hono-host.mjs'))).toBe(true);
      expect(existsSync(join(dir, 'apps/operator/dist-host/sql/001-bootstrap.sql'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the shipped script invokes `git clean` with `-x` and both runtime exclusions', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toMatch(
      /git\s+-C\s+"\$RELEASE_ROOT"\s+clean\s+-fdqx\s+-e\s+node_modules\s+-e\s+\/apps\/operator\/dist-host\//,
    );
  });
});

/**
 * EI-18749180047527506: `extract_submodule_source()` — the submodule SOURCE
 * extraction step (`git archive` at the pinned sha, local objects) must not
 * trust a zero exit from `tar -x` as proof the extraction is COMPLETE. A
 * truncated/interrupted archive stream can exit 0 having written fewer files
 * than its own manifest promised, silently leaving a submodule tree partial —
 * indistinguishable, downstream, from a genuine content regression (the
 * >150-file scan-sanity floor in prompt-blueprint-verb-catalog.test.ts, which
 * scans this exact submodule tree and reds the WHOLE fleet's green pin on a
 * false alarm). These pin the completeness check: a full extraction is
 * trusted as-is; a partial one is detected and repaired via the existing
 * full-tree rsync fallback (already used for an outright `tar -x` failure).
 */
describe('extract_submodule_source (EI-18749180047527506) — submodule archive completeness', () => {
  let work: string;
  let integrationRoot: string;
  let releaseRoot: string;
  let sha: string;

  /** A tiny real git repo at `<integrationRoot>/libs/sub` with two committed files —
   *  stands in for a submodule's LOCAL object store (git archive reads it directly,
   *  never the network — the whole reason this extraction strategy exists). */
  function makeSubmoduleSource(): void {
    const subDir = join(integrationRoot, 'libs', 'sub');
    mkdirSync(subDir, { recursive: true });
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', subDir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q');
    writeFileSync(join(subDir, 'a.txt'), 'a');
    writeFileSync(join(subDir, 'b.txt'), 'b');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    sha = git('rev-parse', 'HEAD');
  }

  /** Runs the real `extract_submodule_source()` (sed-extracted from the shipped
   *  script) for `libs/sub` at the fixture's pinned sha. `extraPath` prepends a
   *  fake `tar` stub onto PATH for the truncation-simulation tests. */
  function runExtract(extraPath?: string): { status: number | null; stdout: string; stderr: string } {
    const wrapper = [
      'set -uo pipefail',
      'log() { echo "[log] $*"; }',
      'source <(sed -n "/^extract_submodule_source()/,/^}/p" "$SETUP_SCRIPT")',
      'extract_submodule_source "libs/sub" "$SHA"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        PATH: extraPath ? `${extraPath}:${process.env.PATH ?? '/usr/bin:/bin'}` : process.env.PATH,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        SHA: sha,
      },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  beforeEach(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'extract-submodule-')));
    integrationRoot = join(work, 'int');
    releaseRoot = join(work, 'rel');
    mkdirSync(integrationRoot, { recursive: true });
    mkdirSync(releaseRoot, { recursive: true });
    makeSubmoduleSource();
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('a complete extraction lands every file and does NOT fall back to rsync', () => {
    const r = runExtract();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('WARN');
    expect(readdirSync(join(releaseRoot, 'libs', 'sub')).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('a re-run wipes stale content first (rm -rf before extraction, not an accumulating merge)', () => {
    mkdirSync(join(releaseRoot, 'libs', 'sub'), { recursive: true });
    writeFileSync(join(releaseRoot, 'libs', 'sub', 'stale-from-a-prior-pin.txt'), 'stale');
    runExtract();
    expect(existsSync(join(releaseRoot, 'libs', 'sub', 'stale-from-a-prior-pin.txt'))).toBe(false);
  });

  it('a PARTIAL extraction (tar -x exits 0 but drops a file) is detected and repaired via the rsync fallback', () => {
    // A fake `tar` that extracts only ONE of the two archived files on `-x` (an
    // interrupted/truncated stream that still exits 0) but is a transparent
    // passthrough for every other invocation (notably `-tf`, which must report
    // the TRUE manifest for the completeness check to have something to compare against).
    const fakeBinDir = join(work, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
    const realTar = spawnSync('bash', ['-c', 'command -v tar']).stdout.toString().trim();
    const stub = [
      '#!/usr/bin/env bash',
      `real_tar=${JSON.stringify(realTar)}`,
      'if [[ "$*" == *"-x"* ]]; then',
      '  args=("$@"); outdir=""; tarfile=""',
      '  for i in "${!args[@]}"; do',
      '    [[ "${args[$i]}" == "-C" ]] && outdir="${args[$((i+1))]}"',
      '    [[ "${args[$i]}" == "-f" ]] && tarfile="${args[$((i+1))]}"',
      '  done',
      '  mkdir -p "$outdir"',
      '  "$real_tar" -x -C "$outdir" -f "$tarfile" a.txt', // drop b.txt on purpose
      '  exit 0',
      'fi',
      'exec "$real_tar" "$@"',
    ].join('\n');
    writeFileSync(join(fakeBinDir, 'tar'), stub, { mode: 0o755 });

    const r = runExtract(fakeBinDir);
    expect(r.status).toBe(0); // the function self-heals — never fails the caller
    expect(r.stdout).toContain('WARN');
    expect(r.stdout).toMatch(/landed only 1\/2 file\(s\)/);
    expect(r.stdout).toContain("rsync'ing integration HEAD");
    // The rsync fallback recovered the FULL content despite the truncated tar.
    expect(readdirSync(join(releaseRoot, 'libs', 'sub')).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('an outright `git archive` failure (bad sha) falls back to rsync exactly as before (pre-existing path, unchanged)', () => {
    sha = '0'.repeat(40); // a well-formed but nonexistent sha
    const r = runExtract();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARN');
    expect(r.stdout).toContain("rsync'ing integration HEAD");
    expect(readdirSync(join(releaseRoot, 'libs', 'sub')).sort()).toEqual(['a.txt', 'b.txt']);
  });
});

/**
 * P-008 (plan green-main-fast-2026-08-25) — `--source-integrity object-sourced`.
 *
 * ## The hole this closes
 * Every other leg of candidate materialization is sourced from immutable git
 * OBJECTS: the superproject is a worktree detached at the frozen sha, submodules
 * are `git clone --local` of the pinned gitlink, and node_modules is an
 * independent copy pinned to a verified dependency-generation id. The single
 * exception is `extract_submodule_source`'s last resort, which rsyncs the
 * integration tree's live WORKING DIRECTORY — on this shared checkout, every peer
 * agent's uncommitted and possibly mid-write edits.
 *
 * The resulting tree corresponds to NO COMMIT, and the two outcomes are not
 * symmetric. A RED from it is unreproducible: the tree that produced it is
 * already gone. A GREEN is worse — it fast-forwards `main` to a sha whose tested
 * content was never that sha, i.e. the gate certifies a commit it did not test.
 * The path announces itself with one WARN line and is otherwise silent.
 *
 * ## What is locked here
 * `firstTest` below is the FALSIFIER, and it is deliberately first: it proves the
 * live-tree splice is real by observing an uncommitted file — one no commit
 * contains — land in the materialized tree under the historical default. Without
 * it, the refusal test could pass against a hole that never existed. The rest
 * pin that `object-sourced` refuses that path (exit 2, nothing copied) while
 * leaving the object-sourced happy path and the deploy's historical self-heal
 * untouched.
 */
describe('extract_submodule_source (P-008) — object-sourced candidate integrity', () => {
  let work: string;
  let integrationRoot: string;
  let releaseRoot: string;
  let sha: string;

  /** The name of a file that exists ONLY in the integration working tree and is in
   *  no commit — i.e. exactly what a peer agent's in-flight edit looks like. */
  const UNCOMMITTED = 'peer-in-flight-uncommitted.txt';

  function makeSubmoduleSource(): void {
    const subDir = join(integrationRoot, 'libs', 'sub');
    mkdirSync(subDir, { recursive: true });
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', subDir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q');
    writeFileSync(join(subDir, 'a.txt'), 'a');
    writeFileSync(join(subDir, 'b.txt'), 'b');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    sha = git('rev-parse', 'HEAD');
    // Written AFTER the commit and never staged: no tree object contains it.
    writeFileSync(join(subDir, UNCOMMITTED), 'a peer was mid-edit when the gate fired');
  }

  /** Runs the real sed-extracted `extract_submodule_source()`, echoing the drift
   *  flag the caller reads so the out-of-band signal is observable here too. */
  function runExtract(mode?: string): { status: number | null; stdout: string } {
    const wrapper = [
      'set -uo pipefail',
      'log() { echo "[log] $*"; }',
      'source <(sed -n "/^extract_submodule_source()/,/^}/p" "$SETUP_SCRIPT")',
      '_LAST_EXTRACT_USED_LIVE_TREE=0',
      'extract_submodule_source "libs/sub" "$SHA"; rc=$?',
      'echo "DRIFT_FLAG=$_LAST_EXTRACT_USED_LIVE_TREE"',
      'exit $rc',
    ].join('\n');
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SETUP_SCRIPT: SCRIPT_PATH,
      INTEGRATION_ROOT: integrationRoot,
      RELEASE_ROOT: releaseRoot,
      SHA: sha,
    };
    // Unset rather than empty when no mode is given: the point of the default case
    // is that the variable is genuinely ABSENT, which is what `set -u` would trip on.
    if (mode === undefined) delete env.SOURCE_INTEGRITY_MODE;
    else env.SOURCE_INTEGRITY_MODE = mode;
    const r = spawnSync('bash', ['-c', wrapper], { env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '' };
  }

  beforeEach(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'p008-source-integrity-')));
    integrationRoot = join(work, 'int');
    releaseRoot = join(work, 'rel');
    mkdirSync(integrationRoot, { recursive: true });
    mkdirSync(releaseRoot, { recursive: true });
    makeSubmoduleSource();
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('THE HOLE IS REAL: under the historical default, an unreadable pin splices UNCOMMITTED live-tree content into the candidate', () => {
    sha = '0'.repeat(40); // pinned objects unreadable → last resort engages
    const r = runExtract(undefined);

    expect(r.status).toBe(0); // silent self-heal, exactly as before
    expect(r.stdout).toContain("rsync'ing integration HEAD");
    // The candidate now contains a file that is in NO commit. This is the defect:
    // a verdict rendered here describes a tree that never existed in history.
    expect(readdirSync(join(releaseRoot, 'libs', 'sub')).sort()).toContain(UNCOMMITTED);
    expect(r.stdout).toContain('DRIFT_FLAG=1');
  });

  it('object-sourced REFUSES that path: exit 2, and no live-tree content is copied', () => {
    sha = '0'.repeat(40);
    const r = runExtract('object-sourced');

    expect(r.status).toBe(2);
    expect(r.stdout).toContain('FATAL');
    expect(r.stdout).toContain('forbids the live-tree rsync fallback');
    expect(r.stdout).not.toContain("rsync'ing integration HEAD");
    // Nothing at all was materialized — emphatically not the uncommitted file.
    expect(readdirSync(join(releaseRoot, 'libs', 'sub'))).toEqual([]);
  });

  it('object-sourced leaves the pin-exact happy path untouched (a readable pin still extracts cleanly)', () => {
    const r = runExtract('object-sourced');

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FATAL');
    expect(r.stdout).not.toContain('WARN');
    expect(r.stdout).toContain('DRIFT_FLAG=0');
    // The committed files, and ONLY those — the uncommitted peer edit is absent
    // because `git archive` reads the pinned tree object, not the working dir.
    expect(readdirSync(join(releaseRoot, 'libs', 'sub')).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('allow-live-tree is explicitly equivalent to the historical default (the deploy keeps its self-heal)', () => {
    sha = '0'.repeat(40);
    const explicit = runExtract('allow-live-tree');

    expect(explicit.status).toBe(0);
    expect(explicit.stdout).toContain("rsync'ing integration HEAD");
    expect(explicit.stdout).toContain('DRIFT_FLAG=1');
  });

  it('an unknown SOURCE_INTEGRITY_MODE is treated as permissive by the function, never as a silent refusal', () => {
    // Mode VALIDATION is the script's job (it exits 2 on a bad --source-integrity
    // before any work). The extracted function must not invent a second, silent
    // policy for a value it does not recognise: only the exact string
    // "object-sourced" may block the fallback, so a typo can never quietly
    // convert a healthy deploy into a hard failure.
    sha = '0'.repeat(40);
    const r = runExtract('objectsourced');

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("rsync'ing integration HEAD");
  });
});
