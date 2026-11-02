import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  closeSync,
  writeSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  planEnvOperatorLaunch,
  launchEnvOperators,
  isTransientSkip,
  defaultDetectSourceArchivePending,
  PROVISIONABLE_ENV_OPERATORS,
  type EnvOperatorPlanEntry,
  type EnvOperatorSpec,
  type LaunchEnvOperatorsDeps,
  defaultDetectSourceRoot,
  defaultDetectSourceRootAsync,
  sourceChildEnv,
  openEnvOperatorLog,
  viteChildArgv,
  viteChildEnv,
  formatEnvOperatorPass2Result,
  readBundledSidecarIdentity,
  requestOnlyIdentityGuardMarker,
  inspectRequestOnlyBundleAdmission,
  resolveRunningPrimaryBundlePath,
} from './env-operator-launcher';

function sha256(text: string): string {
  // Keep this test dependency-free: the production helper uses node:crypto,
  // and the expected digest is only used to build a fixture provenance record.
  return createHash('sha256').update(text).digest('hex');
}

describe('formatEnvOperatorPass2Result', () => {
  it('emits stable fields for a completed source pass instead of prose', () => {
    expect(
      formatEnvOperatorPass2Result({ status: 'ran', spawned: 2, skipped: 1 }),
    ).toBe('[env-operators] PASS2_RESULT status=ran spawned=2 skipped=1');
  });

  it('records terminal skip and failure outcomes explicitly', () => {
    expect(
      formatEnvOperatorPass2Result({
        status: 'skipped',
        reason: 'no-source-tree',
        skipped: 2,
      }),
    ).toBe('[env-operators] PASS2_RESULT status=skipped skipped=2 reason=no-source-tree');
    expect(
      formatEnvOperatorPass2Result({ status: 'failed', reason: 'provisioning-error' }),
    ).toBe('[env-operators] PASS2_RESULT status=failed reason=provisioning-error');
  });

  it('does not depend on the legacy "source pass" wording', () => {
    expect(formatEnvOperatorPass2Result({ status: 'ran' })).not.toContain('source pass');
  });
});

const SPECS: readonly EnvOperatorSpec[] = [
  { id: 'dev', port: 3270, branch: 'staging' },
  { id: 'prod', port: 3070, branch: 'main' },
  { id: 'staging', port: 3170, branch: 'staging' },
];

describe('request-only bundled sidecar admission (P-008)', () => {
  function writeBundle(
    dir: string,
    text: string,
    provenance?: Record<string, unknown>,
  ): string {
    mkdirSync(dir, { recursive: true });
    const bundle = join(dir, 'serve.mjs');
    writeFileSync(bundle, text);
    if (provenance) {
      writeFileSync(join(dir, 'build-provenance.json'), JSON.stringify(provenance));
    }
    return bundle;
  }

  it('reads the bundle own identity and verifies its exact bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-env-bundle-'));
    try {
      const body = `/* ${requestOnlyIdentityGuardMarker()} */\nexport {};\n`;
      const bundle = writeBundle(root, body, {
        version: '1.2.3',
        buildSha: '',
        gitHead: 'source-head',
        gitHeadAtEmit: 'later-checkout-head',
        artifacts: [{ name: 'serve.mjs', sha256: sha256(body) }],
      });

      expect(readBundledSidecarIdentity(bundle)).toMatchObject({
        bundleSha256: sha256(body),
        buildSha: 'later-checkout-head',
        version: '1.2.3',
        source: 'build-provenance',
        bytesVerified: true,
        requestOnlyIdentityGuard: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('understands both shipped .sidecar-build-stamp JSON and composed BUILD-STAMP.txt', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-env-stamps-'));
    try {
      const body = `/* ${requestOnlyIdentityGuardMarker()} */\n`;
      const jsonDir = join(root, 'json');
      const jsonBundle = writeBundle(jsonDir, body);
      writeFileSync(
        join(jsonDir, '.sidecar-build-stamp'),
        JSON.stringify({ gitHead: 'source-only', serveSha256: sha256(body) }),
      );
      expect(readBundledSidecarIdentity(jsonBundle)).toMatchObject({
        buildSha: 'source-only',
        source: 'build-stamp',
        bytesVerified: true,
      });

      const textDir = join(root, 'text');
      const textBundle = writeBundle(textDir, body);
      writeFileSync(
        join(textDir, 'BUILD-STAMP.txt'),
        `sha=composed123 dirty=0 composedAt=2026-08-31T23:00:00Z\nserveSha256=${sha256(body)}\n`,
      );
      expect(readBundledSidecarIdentity(textBundle)).toMatchObject({
        buildSha: 'composed123',
        source: 'build-stamp',
        bytesVerified: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('admits only marker-bearing bytes identical to the running primary', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-env-admission-'));
    try {
      const guarded = `/* ${requestOnlyIdentityGuardMarker()} */\nexport {};\n`;
      const primary = writeBundle(join(root, 'primary'), guarded);
      const identical = writeBundle(join(root, 'identical'), guarded);
      const staleGuarded = writeBundle(
        join(root, 'stale'),
        `/* ${requestOnlyIdentityGuardMarker()} */\nexport const stale = true;\n`,
      );
      const unguarded = writeBundle(join(root, 'unguarded'), 'export {};\n');

      expect(inspectRequestOnlyBundleAdmission(identical, primary).reason).toBe(
        'byte-identical-primary',
      );
      expect(inspectRequestOnlyBundleAdmission(staleGuarded, primary).reason).toBe(
        'bundle-differs-from-primary',
      );
      expect(inspectRequestOnlyBundleAdmission(unguarded, primary).reason).toBe(
        'identity-guard-absent',
      );
      expect(inspectRequestOnlyBundleAdmission(identical, unguarded).reason).toBe(
        'identity-guard-absent',
      );
      expect(inspectRequestOnlyBundleAdmission(identical, null).reason).toBe(
        'primary-bundle-unavailable',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the packaged primary from PAPERCUSP_SIDECAR_BIN before argv fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-env-primary-'));
    try {
      const primary = writeBundle(join(root, 'sidecar'), 'primary');
      const argvBundle = writeBundle(join(root, 'argv'), 'argv');
      mkdirSync(join(root, 'sidecar', 'bin'));
      expect(
        resolveRunningPrimaryBundlePath(
          { PAPERCUSP_SIDECAR_BIN: join(root, 'sidecar', 'bin') },
          ['node', argvBundle],
        ),
      ).toBe(primary);
      expect(resolveRunningPrimaryBundlePath({}, ['node', argvBundle])).toBe(argvBundle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wires the fail-closed admission into the production bundled spawn path', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, 'env-operator-launcher.ts'),
      'utf8',
    );
    const bundledBranch = source.slice(
      source.indexOf("if (entry.spawnMode === 'bundled' && entry.bundlePath)"),
      source.indexOf("if (entry.run === 'vite')"),
    );
    expect(bundledBranch).toContain('inspectRequestOnlyBundleAdmission(');
    expect(bundledBranch).toContain('resolveRunningPrimaryBundlePath()');
    expect(bundledBranch).toContain('if (!admission.ok)');
    expect(bundledBranch.indexOf('if (!admission.ok)')).toBeLessThan(
      bundledBranch.indexOf('spawn(process.execPath'),
    );
  });
});

/** Index a plan by env id for terse assertions. */
function byId(plan: EnvOperatorPlanEntry[]): Record<string, EnvOperatorPlanEntry> {
  return Object.fromEntries(plan.map((e) => [e.id, e]));
}

describe('planEnvOperatorLaunch (pure)', () => {
  const base = { specs: SPECS, hasSourceTree: true, hasToolchain: true } as const;

  it('spawns every candidate when nothing blocks it', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base }));
    expect(plan.dev.action).toBe('spawn');
    expect(plan.prod.action).toBe('spawn');
    expect(plan.staging.action).toBe('spawn');
    // origin is rendered from the host + port
    expect(plan.staging.origin).toBe('http://127.0.0.1:3170');
  });

  it('honours a custom bind host in the rendered origin', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, host: '0.0.0.0' }));
    expect(plan.dev.origin).toBe('http://0.0.0.0:3270');
  });

  it('skips a disabled env regardless of everything else', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, disabledIds: ['staging'] }));
    expect(plan.staging.action).toBe('skip');
    expect(plan.staging.skipReason).toBe('disabled');
    expect(plan.dev.action).toBe('spawn');
  });

  it('disabled wins over already-reachable / self / missing toolchain (most-specific reason)', () => {
    const plan = byId(
      planEnvOperatorLaunch({
        ...base,
        hasToolchain: false,
        hasSourceTree: false,
        disabledIds: ['prod'],
        reachablePorts: [3070],
        selfPort: 3070,
      }),
    );
    expect(plan.prod.skipReason).toBe('disabled');
  });

  it('never re-spawns the operator serving its own port (is-self)', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, selfPort: 3270 }));
    expect(plan.dev.action).toBe('skip');
    expect(plan.dev.skipReason).toBe('is-self');
  });

  it('is idempotent — skips a port already served by a live operator', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, reachablePorts: [3170] }));
    expect(plan.staging.action).toBe('skip');
    expect(plan.staging.skipReason).toBe('already-reachable');
    expect(plan.dev.action).toBe('spawn');
  });

  it('is-self takes precedence over already-reachable (self is trivially reachable)', () => {
    const plan = byId(
      planEnvOperatorLaunch({ ...base, selfPort: 3170, reachablePorts: [3170] }),
    );
    expect(plan.staging.skipReason).toBe('is-self');
  });

  it('skips all spawnable envs when the cloned source tree is absent', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, hasSourceTree: false }));
    for (const id of ['dev', 'prod', 'staging']) {
      expect(plan[id].action).toBe('skip');
      expect(plan[id].skipReason).toBe('no-source-tree');
    }
  });

  // EI-19442842364710969 — a first boot skips dev/local because the shipped source
  // archive has not finished extracting (measured ~30min for a 5.3G tree at ~2.9MB/s).
  // That skip used to be reported with the SAME string as a build that shipped no source
  // at all, so a machine reader could not tell "not yet" from "never" — which produced a
  // false FAIL in the WI-3307 mac acceptance gate.
  it('reports a PENDING source extract distinctly from a permanently absent tree', () => {
    const pending = byId(
      planEnvOperatorLaunch({ ...base, hasSourceTree: false, sourceArchivePending: true }),
    );
    const absent = byId(planEnvOperatorLaunch({ ...base, hasSourceTree: false }));
    for (const id of ['dev', 'prod', 'staging']) {
      expect(pending[id].action).toBe('skip');
      expect(pending[id].skipReason).toBe('source-tree-pending');
      // ...and the terminal case is untouched — the two must never collapse together.
      expect(absent[id].skipReason).toBe('no-source-tree');
      expect(pending[id].skipReason).not.toBe(absent[id].skipReason);
    }
  });

  it('classifies pending as transient and every other skip as terminal', () => {
    expect(isTransientSkip('source-tree-pending')).toBe(true);
    // The whole point: a gate branching on this must NOT treat these as "come back later".
    for (const terminal of [
      'no-source-tree',
      'no-toolchain',
      'disabled',
      'is-self',
      'already-reachable',
    ]) {
      expect(isTransientSkip(terminal)).toBe(false);
    }
    expect(isTransientSkip(undefined)).toBe(false);
  });

  it('does not let a pending extract mask a more specific skip reason', () => {
    const plan = byId(
      planEnvOperatorLaunch({
        ...base,
        hasSourceTree: false,
        sourceArchivePending: true,
        disabledIds: ['dev'],
        selfPort: 3070,
        reachablePorts: [3170],
      }),
    );
    // Precedence is unchanged — pending only ever refines the source-less branch.
    expect(plan.dev.skipReason).toBe('disabled');
    expect(plan.prod.skipReason).toBe('is-self');
    expect(plan.staging.skipReason).toBe('already-reachable');
  });

  it('skips all spawnable envs when the toolchain is missing', () => {
    const plan = byId(planEnvOperatorLaunch({ ...base, hasToolchain: false }));
    for (const id of ['dev', 'prod', 'staging']) {
      expect(plan[id].skipReason).toBe('no-toolchain');
    }
  });

  it('already-reachable beats the source/toolchain gates (an up operator is not "no-toolchain")', () => {
    const plan = byId(
      planEnvOperatorLaunch({
        ...base,
        hasSourceTree: false,
        hasToolchain: false,
        reachablePorts: [3070],
      }),
    );
    expect(plan.prod.skipReason).toBe('already-reachable');
    // the others, with no tree, fall to no-source-tree
    expect(plan.dev.skipReason).toBe('no-source-tree');
  });

  it('defaults to the PROVISIONABLE set (dev/prod/staging/local — never release)', () => {
    const plan = planEnvOperatorLaunch({ hasSourceTree: true, hasToolchain: true });
    const ids = plan.map((e) => e.id).sort();
    expect(ids).toEqual(['dev', 'local', 'prod', 'staging']);
    // local (:3055, the Vite SPA over the working tree) is provisionable since WI-3285;
    // release is the immutable bundled sidecar and is never spawned from source.
    const local = PROVISIONABLE_ENV_OPERATORS.find((s) => s.id === 'local');
    expect(local?.run).toBe('vite');
    expect(local?.port).toBe(3055);
    expect(PROVISIONABLE_ENV_OPERATORS.some((s) => s.id === 'release')).toBe(false);
  });
});

/** Build launch deps wired to in-memory fakes (no fs / no network / no real spawn). */
function fakeLaunchDeps(over: Partial<LaunchEnvOperatorsDeps> = {}): {
  deps: LaunchEnvOperatorsDeps;
  spawnedCalls: { entry: EnvOperatorPlanEntry; treePath: string }[];
  staggerWaits: number[];
} {
  const spawnedCalls: { entry: EnvOperatorPlanEntry; treePath: string }[] = [];
  const staggerWaits: number[] = [];
  const deps: LaunchEnvOperatorsDeps = {
    specs: SPECS,
    readPrefs: () => ({ disabled: [] }),
    probe: async () => false, // nothing already up
    detectSourceRoot: () => '/src/papercup',
    // Hermetic: the real default reads PAPERCUSP_SOURCE_ARCHIVE from the ambient env, so
    // without this a developer machine with that var set would flip every source-less skip
    // to 'source-tree-pending' and break unrelated assertions.
    detectSourceArchivePending: () => false,
    hasToolchain: async () => true,
    // Never let a unit test fall through to the REAL default (fs probe of the package).
    detectBundledSidecar: () => null,
    selfPort: null,
    // Passthrough tree-prepare by default — the real git-worktree prepare is exercised
    // in env-tree-prepare.test.ts; these tests focus on launcher orchestration.
    prepareTree: async (_entry, root) => root,
    sleep: async (ms) => {
      staggerWaits.push(ms);
    },
    log: () => {},
    spawnOperator: (entry, treePath) => {
      spawnedCalls.push({ entry, treePath });
      return { id: entry.id, port: entry.port, pid: 1000 + entry.port };
    },
    ...over,
  };
  return { deps, spawnedCalls, staggerWaits };
}

describe('launchEnvOperators (effectful, fully faked)', () => {
  it('waits for async source detection before passing the root to child preparation', async () => {
    let release!: (root: string | null) => void;
    const pending = new Promise<string | null>((resolve) => { release = resolve; });
    const { deps, spawnedCalls } = fakeLaunchDeps({ detectSourceRoot: () => pending });
    const result = launchEnvOperators(deps);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawnedCalls).toHaveLength(0);
    release('/src/ready');
    await result;
    expect(spawnedCalls).toHaveLength(3);
    expect(spawnedCalls.every((call) => call.treePath === '/src/ready')).toBe(true);
  });

  it('spawns every enabled env when none are up and a toolchain + tree exist', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps();
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'prod', 'staging']);
    expect(spawnedCalls).toHaveLength(3);
    // the conservative default prepareTree runs each env from the detected root
    expect(spawnedCalls.every((c) => c.treePath === '/src/papercup')).toBe(true);
  });

  it('staggers between spawns but not before the first', async () => {
    const { deps, staggerWaits } = fakeLaunchDeps({ staggerMs: 4000 });
    await launchEnvOperators(deps);
    // 3 spawns ⇒ 2 inter-spawn waits
    expect(staggerWaits).toEqual([4000, 4000]);
  });

  it('skips an already-reachable port (idempotent) and does not spawn it', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      probe: async (origin) => origin.endsWith(':3070'), // prod already up
    });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'staging']);
    expect(res.skipped).toContainEqual({ id: 'prod', reason: 'already-reachable' });
    expect(spawnedCalls.some((c) => c.entry.id === 'prod')).toBe(false);
  });

  it('skips disabled envs from the prefs store', async () => {
    const { deps } = fakeLaunchDeps({ readPrefs: () => ({ disabled: ['staging'] }) });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'prod']);
    expect(res.skipped).toContainEqual({ id: 'staging', reason: 'disabled' });
  });

  it('skips everything (no spawn) when the source tree is absent', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({ detectSourceRoot: () => null });
    const res = await launchEnvOperators(deps);
    expect(res.spawned).toHaveLength(0);
    expect(spawnedCalls).toHaveLength(0);
    expect(res.skipped.every((s) => s.reason === 'no-source-tree')).toBe(true);
  });

  // EI-19442842364710969 — the same no-tree state, but with an extract in flight.
  it('reports source-tree-pending (not no-source-tree) while the shipped archive unpacks', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      detectSourceRoot: () => null,
      detectSourceArchivePending: () => true,
    });
    const res = await launchEnvOperators(deps);
    expect(spawnedCalls).toHaveLength(0);
    expect(res.skipped.every((s) => s.reason === 'source-tree-pending')).toBe(true);
    // Every one of them is a "come back later", so the caller can run a second pass.
    expect(res.skipped.every((s) => isTransientSkip(s.reason))).toBe(true);
  });

  it('never consults the pending check once a real source tree exists', async () => {
    let consulted = 0;
    const { deps } = fakeLaunchDeps({
      detectSourceRoot: () => '/src/papercup',
      detectSourceArchivePending: () => {
        consulted += 1;
        return true;
      },
    });
    const res = await launchEnvOperators(deps);
    expect(consulted).toBe(0);
    expect(res.skipped.some((s) => s.reason === 'source-tree-pending')).toBe(false);
  });

  it('defaultDetectSourceArchivePending is false without a shipped archive', () => {
    const prev = process.env.PAPERCUSP_SOURCE_ARCHIVE;
    try {
      delete process.env.PAPERCUSP_SOURCE_ARCHIVE;
      expect(defaultDetectSourceArchivePending()).toBe(false);
      // A build that points at an archive which is not on disk is terminal, not pending.
      process.env.PAPERCUSP_SOURCE_ARCHIVE = join(tmpdir(), 'no-such-archive-xyz.tar.zst');
      expect(defaultDetectSourceArchivePending()).toBe(false);
      process.env.PAPERCUSP_SOURCE_ARCHIVE = '   ';
      expect(defaultDetectSourceArchivePending()).toBe(false);
      // ...but a build that DID ship one, on disk, is genuinely pending.
      const dir = mkdtempSync(join(tmpdir(), 'src-archive-'));
      const archive = join(dir, 'source.tar.zst');
      writeFileSync(archive, 'x');
      try {
        process.env.PAPERCUSP_SOURCE_ARCHIVE = archive;
        expect(defaultDetectSourceArchivePending()).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SOURCE_ARCHIVE;
      else process.env.PAPERCUSP_SOURCE_ARCHIVE = prev;
    }
  });

  it('skips everything when the toolchain is missing and cannot be installed', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({ hasToolchain: async () => false });
    const res = await launchEnvOperators(deps);
    expect(res.spawned).toHaveLength(0);
    expect(spawnedCalls).toHaveLength(0);
    expect(res.skipped.every((s) => s.reason === 'no-toolchain')).toBe(true);
  });

  it('a bundled env sidecar spawns with NO source tree and NO toolchain (packaged install)', async () => {
    // The pinned V1 packaged layout: env-sidecars/staging/ shipped, prod falling back
    // to the primary's own serve.mjs (the resolver's prod special case — here faked).
    const { deps, spawnedCalls } = fakeLaunchDeps({
      detectSourceRoot: () => null,
      hasToolchain: async () => false,
      detectBundledSidecar: (envId) =>
        envId === 'staging'
          ? '/opt/pkg/sidecar/env-sidecars/staging/serve.mjs'
          : envId === 'prod'
            ? '/opt/pkg/sidecar/serve.mjs'
            : null,
    });
    const res = await launchEnvOperators(deps);
    // staging runs its bundle; prod runs the primary's own bundle on :3070; dev has
    // neither a bundle nor a source tree → honest skip.
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['prod', 'staging']);
    expect(res.skipped).toContainEqual({ id: 'dev', reason: 'no-source-tree' });
    const staging = spawnedCalls.find((c) => c.entry.id === 'staging');
    expect(staging?.entry.spawnMode).toBe('bundled');
    expect(staging?.entry.bundlePath).toBe('/opt/pkg/sidecar/env-sidecars/staging/serve.mjs');
    // bundled spawns run from the bundle dir — prepareTree is bypassed
    expect(staging?.treePath).toBe('/opt/pkg/sidecar/env-sidecars/staging');
    const prod = spawnedCalls.find((c) => c.entry.id === 'prod');
    expect(prod?.entry.bundlePath).toBe('/opt/pkg/sidecar/serve.mjs');
  });

  it('a bundled sidecar wins over the source path even when a tree+toolchain exist', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      detectBundledSidecar: (envId) =>
        envId === 'prod' ? `/opt/pkg/env-sidecars/prod/serve.mjs` : null,
    });
    await launchEnvOperators(deps);
    const prod = spawnedCalls.find((c) => c.entry.id === 'prod');
    expect(prod?.entry.spawnMode).toBe('bundled');
    const dev = spawnedCalls.find((c) => c.entry.id === 'dev');
    expect(dev?.entry.spawnMode).toBe('source');
  });

  it('a vite env never uses a bundle — source-only (SPA dev server transforms the tree)', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      specs: [{ id: 'local', port: 3055, branch: 'staging', run: 'vite' }],
      detectSourceRoot: () => null,
      hasToolchain: async () => false,
      detectBundledSidecar: () => '/opt/pkg/env-sidecars/staging/serve.mjs',
    });
    const res = await launchEnvOperators(deps);
    expect(res.spawned).toHaveLength(0);
    expect(spawnedCalls).toHaveLength(0);
    expect(res.skipped).toContainEqual({ id: 'local', reason: 'no-source-tree' });
  });

  it('spawns the local vite env alongside the source operators (WI-3285)', async () => {
    const { deps, spawnedCalls } = fakeLaunchDeps({
      specs: [...SPECS, { id: 'local', port: 3055, branch: 'staging', run: 'vite' }],
    });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'local', 'prod', 'staging']);
    const localCall = spawnedCalls.find((c) => c.entry.id === 'local');
    expect(localCall?.entry.run).toBe('vite');
    expect(localCall?.entry.port).toBe(3055);
  });

  it('records a tree-prepare failure as a skip and continues with the rest', async () => {
    const { deps } = fakeLaunchDeps({
      prepareTree: async (entry, root) => (entry.id === 'prod' ? null : root),
    });
    const res = await launchEnvOperators(deps);
    expect(res.skipped).toContainEqual({ id: 'prod', reason: 'tree-prepare-failed' });
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'staging']);
  });

  it('records a spawn failure as a skip and never throws', async () => {
    const { deps } = fakeLaunchDeps({
      spawnOperator: (entry) => (entry.id === 'staging' ? null : { id: entry.id, port: entry.port }),
    });
    const res = await launchEnvOperators(deps);
    expect(res.skipped).toContainEqual({ id: 'staging', reason: 'spawn-failed' });
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'prod']);
  });

  it('never re-spawns the operator that is itself one of the env ports', async () => {
    const { deps } = fakeLaunchDeps({ selfPort: 3270 });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['prod', 'staging']);
    expect(res.skipped).toContainEqual({ id: 'dev', reason: 'is-self' });
  });

  it('a tree-prepare failure on the first env does not eat the next env stagger', async () => {
    // prod (first) fails to prepare → no spawn; dev + staging still spawn, staggered once.
    const { deps, staggerWaits } = fakeLaunchDeps({
      specs: [
        { id: 'prod', port: 3070, branch: 'main' },
        { id: 'dev', port: 3270, branch: 'staging' },
        { id: 'staging', port: 3170, branch: 'staging' },
      ],
      prepareTree: async (entry, root) => (entry.id === 'prod' ? null : root),
      staggerMs: 100,
    });
    const res = await launchEnvOperators(deps);
    expect(res.spawned.map((s) => s.id).sort()).toEqual(['dev', 'staging']);
    // first spawn-action attempt is prod (prepare-fail, no stagger consumed before it);
    // dev is the first *successful* spawn (no stagger), staging staggers once.
    expect(staggerWaits).toEqual([100]);
  });
});

describe('defaultDetectSourceRoot (WI-3306/WI-3308 extraction contract)', () => {
  const saved = process.env.PAPERCUSP_DEV_SOURCE_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCUSP_DEV_SOURCE_ROOT;
    else process.env.PAPERCUSP_DEV_SOURCE_ROOT = saved;
  });

  it('prefers a PAPERCUSP_DEV_SOURCE_ROOT that carries both repo markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-devsrc-'));
    mkdirSync(join(root, 'apps', 'operator'), { recursive: true });
    mkdirSync(join(root, 'libs', 'papercusp'), { recursive: true });
    writeFileSync(join(root, 'apps', 'operator', 'package.json'), '{}');
    writeFileSync(join(root, 'libs', 'papercusp', 'package.json'), '{}');
    process.env.PAPERCUSP_DEV_SOURCE_ROOT = root;
    expect(defaultDetectSourceRoot()).toBe(resolve(root));
    rmSync(root, { recursive: true, force: true });
  });

  it('a marker-less PAPERCUSP_DEV_SOURCE_ROOT (half-extracted tree) is ignored, not walked up', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-devsrc-empty-'));
    process.env.PAPERCUSP_DEV_SOURCE_ROOT = root;
    // Falls back to the dev-box walk — whatever it returns, it is NOT the empty dir.
    expect(defaultDetectSourceRoot()).not.toBe(resolve(root));
    rmSync(root, { recursive: true, force: true });
  });

  it('async runtime detection rechecks extracted markers after replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-devsrc-async-'));
    try {
      mkdirSync(join(root, 'apps', 'operator'), { recursive: true });
      mkdirSync(join(root, 'libs', 'papercusp'), { recursive: true });
      writeFileSync(join(root, 'apps', 'operator', 'package.json'), '{}');
      writeFileSync(join(root, 'libs', 'papercusp', 'package.json'), '{}');
      process.env.PAPERCUSP_DEV_SOURCE_ROOT = root;
      expect(await defaultDetectSourceRootAsync()).toBe(resolve(root));
      rmSync(join(root, 'libs', 'papercusp', 'package.json'));
      expect(await defaultDetectSourceRootAsync()).not.toBe(resolve(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sourceChildEnv (WI-3306 source-child contract)', () => {
  const saved = process.env.PAPERCUSP_SIDECAR_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCUSP_SIDECAR_BIN;
    else process.env.PAPERCUSP_SIDECAR_BIN = saved;
  });

  it('always pins the child PAPERCUSP_INTEGRATION_ROOT to its own tree', () => {
    delete process.env.PAPERCUSP_SIDECAR_BIN;
    expect(sourceChildEnv('/some/tree')).toEqual({
      PAPERCUSP_INTEGRATION_ROOT: '/some/tree',
    });
  });

  it('prepends the sidecar dir (and its bin/) to PATH when PAPERCUSP_SIDECAR_BIN is set', () => {
    const sidecarDir = mkdtempSync(join(tmpdir(), 'pc-sidecar-'));
    mkdirSync(join(sidecarDir, 'bin'), { recursive: true });
    process.env.PAPERCUSP_SIDECAR_BIN = join(sidecarDir, 'serve.mjs');
    const env = sourceChildEnv('/tree');
    expect(env.PAPERCUSP_INTEGRATION_ROOT).toBe('/tree');
    const parts = (env.PATH ?? '').split(delimiter);
    expect(parts[0]).toBe(sidecarDir);
    expect(parts[1]).toBe(join(sidecarDir, 'bin'));
    // The inherited PATH tail is preserved.
    expect(env.PATH?.endsWith(process.env.PATH ?? '')).toBe(true);
    rmSync(sidecarDir, { recursive: true, force: true });
  });
});

describe('openEnvOperatorLog (EI-19423766332560955)', () => {
  const priorHome = process.env.PAPERCUSP_HOME;
  afterEach(() => {
    if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
    else process.env.PAPERCUSP_HOME = priorHome;
  });

  it('routes stdout+stderr to a per-env log instead of discarding them', () => {
    const home = mkdtempSync(join(tmpdir(), 'pc-envlog-'));
    process.env.PAPERCUSP_HOME = join(home, '.papercusp');

    const log = openEnvOperatorLog('dev');

    // The whole point of the fix: NOT 'ignore'. stdin stays ignored; stdout and
    // stderr both get a real fd, so a child that dies or hangs leaves a trace.
    expect(Array.isArray(log.stdio)).toBe(true);
    const triple = log.stdio as unknown[];
    expect(triple[0]).toBe('ignore');
    expect(typeof triple[1]).toBe('number');
    expect(triple[1]).toBe(triple[2]);
    expect(log.logPath).toBe(join(home, '.papercusp', 'logs', 'env-operator-dev.log'));
    expect(existsSync(log.logPath as string)).toBe(true);

    closeSync(log.fd as number);
    rmSync(home, { recursive: true, force: true });
  });

  it('opens APPEND-mode so a restart never truncates the previous boot', () => {
    const home = mkdtempSync(join(tmpdir(), 'pc-envlog-'));
    process.env.PAPERCUSP_HOME = join(home, '.papercusp');

    const first = openEnvOperatorLog('local');
    writeSync(first.fd as number, 'FIRST BOOT\n');
    closeSync(first.fd as number);

    const second = openEnvOperatorLog('local');
    writeSync(second.fd as number, 'SECOND BOOT\n');
    closeSync(second.fd as number);

    const body = readFileSync(second.logPath as string, 'utf8');
    expect(body).toContain('FIRST BOOT');
    expect(body).toContain('SECOND BOOT');

    rmSync(home, { recursive: true, force: true });
  });

  it('fails OPEN — an unusable log dir degrades to ignore rather than losing the operator', () => {
    // A FILE where the home dir should be: mkdirSync('<file>/.papercusp/logs') → ENOTDIR.
    const dir = mkdtempSync(join(tmpdir(), 'pc-envlog-'));
    const notADir = join(dir, 'i-am-a-file');
    writeFileSync(notADir, 'x');
    process.env.PAPERCUSP_HOME = join(notADir, '.papercusp');

    const log = openEnvOperatorLog('dev');

    expect(log.stdio).toBe('ignore');
    expect(log.fd).toBeNull();
    expect(log.logPath).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  it('RECURRENCE GUARD: no spawn site discards stdio', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, 'env-operator-launcher.ts'),
      'utf8',
    );

    // Scan CODE only — the doc comments legitimately quote the old `stdio: 'ignore'`
    // to explain why it was removed, and counting those defeats the guard.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // All three spawn modes (bundled / vite / source) must route through the log.
    const routed = code.match(/stdio: log\.stdio/g) ?? [];
    expect(routed.length).toBe(3);

    // Exactly ONE `stdio: 'ignore'` literal may survive: the fail-open fallback
    // inside openEnvOperatorLog. Any other is a spawn site going dark again.
    const discarded = code.match(/stdio: 'ignore'/g) ?? [];
    expect(discarded.length).toBe(1);
  });
});

describe('the `local` (vite) child port contract (EI-19424980348813193)', () => {
  /** The port expression `apps/operator-vite/vite.config.ts` actually evaluates
   *  (line 248). Duplicated here on purpose: this suite's whole job is to police the
   *  COUPLING between the launcher's child env and that expression, so the expression
   *  has to be visible at the assertion. If it changes there, this should fail here. */
  function viteConfigResolvesPort(env: NodeJS.ProcessEnv): number {
    return Number(env.OPERATOR_E2E_PORT ?? env.PORT) || 3055;
  }

  it('passes the port explicitly AND strictly', () => {
    const argv = viteChildArgv('/tree/node_modules/vite/bin/vite.js', 3055);

    expect(argv[0]).toBe('/tree/node_modules/vite/bin/vite.js');
    expect(argv).toContain('--port');
    expect(argv[argv.indexOf('--port') + 1]).toBe('3055');
    // Without --strictPort a collision makes vite WALK to the next free port and serve
    // there silently, which is the failure mode that made this look like a hang.
    expect(argv).toContain('--strictPort');
  });

  it('THE BUG: an inherited PORT no longer retargets the SPA', () => {
    // The primary operator sets PORT to its OWN Hono port; the child inherited it.
    const base = { PORT: '3070', PAPERCUSP_HONO_PORT: '3070' };

    // Before the fix this was the live behaviour — the config saw the operator's port:
    expect(viteConfigResolvesPort(base)).toBe(3070);

    // After the scrub the config falls through to its own 3055 default, and the
    // explicit --port pins it regardless.
    const env = viteChildEnv(base, '/tree', 3070);
    expect(env.PORT).toBeUndefined();
    expect(viteConfigResolvesPort(env)).toBe(3055);
  });

  it('also scrubs OPERATOR_E2E_PORT, which outranks PORT in the config', () => {
    const env = viteChildEnv({ OPERATOR_E2E_PORT: '4123', PORT: '3070' }, '/tree', 3070);

    expect(env.OPERATOR_E2E_PORT).toBeUndefined();
    expect(viteConfigResolvesPort(env)).toBe(3055);
  });

  it('keeps the rest of the source-child contract intact', () => {
    const env = viteChildEnv({ PORT: '3070', HOME: '/home/x' }, '/tree', 3070);

    expect(env.PAPERCUSP_INTEGRATION_ROOT).toBe('/tree');
    expect(env.PAPERCUSP_API_TARGET).toBe('http://127.0.0.1:3070');
    expect(env.PAPERCUSP_PROVISION_ENV_OPERATORS).toBe('0');
    expect(env.HOME).toBe('/home/x'); // unrelated inherited vars survive
  });

  it('omits PAPERCUSP_API_TARGET when the primary port is unknown', () => {
    const env = viteChildEnv({ PORT: '3070' }, '/tree', null);

    expect(env.PAPERCUSP_API_TARGET).toBeUndefined();
    expect(env.PORT).toBeUndefined(); // the scrub is unconditional
  });

  it('RECURRENCE GUARD: the vite spawn site routes through both helpers', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, 'env-operator-launcher.ts'),
      'utf8',
    );
    // Scan CODE only — the doc comments quote the old bare-argv spawn to explain it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // A bare `spawn(process.execPath, [viteCli]` is exactly the regression: no port,
    // no strictPort, and an env free to carry an ambient PORT.
    expect(code).not.toMatch(/spawn\(\s*process\.execPath\s*,\s*\[\s*viteCli\s*\]/);
    expect(code).toMatch(/viteChildArgv\(viteCli, entry\.port\)/);
    expect(code).toMatch(/env: viteChildEnv\(/);
  });
});
