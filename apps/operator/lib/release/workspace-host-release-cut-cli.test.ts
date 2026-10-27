import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectByocReleaseMilestones } from '@papercusp/operator-core/lib/byoc-release-carry';
import { readProcessIdentity } from '@papercusp/operator-core/lib/process-identity';
import { inspectRetentionTrees } from '@papercusp/operator-core/lib/storage/disk-consumer-census';
import type { TaskReleaseJournal } from '@papercusp/operator-core/lib/task-manager/store';
import {
  OPERATION_ID,
  TASK_ID,
  memoryReleaseLedger,
} from '@papercusp/operator-core/lib/workspace-host/release-journal-test-support';
import {
  resolveWorkspaceHostReleaseBinding,
  WORKSPACE_HOST_RELEASE_CHANNEL,
} from '@papercusp/operator-core/lib/workspace-host/release-stage-receipt';

import { assertReleaseTaskIdentity, type ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import { pinProtection, withRetentionPinProtection } from '../../../../scripts/lib/retention-pins.mjs';
import { WORKSPACE_HOST_EVIDENCE_FILES, WORKSPACE_HOST_PUBLISHED_SIGNING_KEY_NAME } from './workspace-host-publication-manifest-cli';
import {
  acquireWorkDirLock,
  DISK_PREFLIGHT_REFUSAL_EXIT_CODE,
  describeStepExit,
  WORKSPACE_HOST_BUILD_STAGE,
  WORKSPACE_HOST_DOC_VECTOR_SEED_DIR,
  WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE,
  cutDocVectorSeed,
  WorkspaceHostCutStepError,
  buildWorkspaceHostPublicationInput,
  readWorkspaceHostSourceRepository,
  buildWorkspaceHostReleaseJournalSeed,
  buildWorkspaceHostBundle,
  cupboardBaseOverride,
  packDeterministically,
  parseWorkspaceHostReleaseCutArgs,
  planWorkspaceHostCutIntermediates,
  pruneWorkspaceHostCutIntermediates,
  reclaimWorkspaceHostCutIntermediatesWithProtection,
  removeReleaseSourceWorktree,
  runWorkspaceHostReleaseCut,
  runWorkspaceHostReleaseCutCli,
  sha256OfFile,
  workspaceHostCutStageContext,
  workspaceHostModelCache,
  type WorkspaceHostBuildResult,
  type WorkspaceHostReleaseCutDeps,
} from './workspace-host-release-cut-cli';

const SHA = '1'.repeat(40);
const DESKTOP_PIN = '2'.repeat(40);
const GITLINKS = { 'papercusp-desktop': DESKTOP_PIN, 'libs/papercusp': '3'.repeat(40) };
const VERSION = '0.0.21-p318r40';
const BUNDLE = '4'.repeat(64);

describe('workspace host model source preflight', () => {
  it('honors an explicit maintained pack outside the repository cache', () => {
    const cache = join(workDir, 'models');
    for (const model of ['harrier-oss-v1-0.6b-ONNX', 'embeddinggemma-300m-ONNX']) {
      const dir = join(cache, 'onnx-community', model, 'onnx');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'model.onnx'), 'fixture');
    }
    expect(workspaceHostModelCache(workDir, { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: cache })).toBe(cache);
    expect(() => workspaceHostModelCache(workDir, {})).toThrow('set PAPERCUSP_TRANSFORMERS_MODEL_CACHE');
  });

  it('refuses an incomplete explicitly configured pack', () => {
    expect(() => workspaceHostModelCache(workDir, { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: workDir }))
      .toThrow('model source');
  });

  it('refuses missing models before materializing or stamping source ready', async () => {
    vi.stubEnv('PAPERCUSP_TRANSFORMERS_MODEL_CACHE', join(workDir, 'missing-models'));
    try {
      const plan = { workDir, repoRoot: workDir, identity: { sourceSha: SHA }, desktopVersion: VERSION } as Parameters<typeof buildWorkspaceHostBundle>[0];
      await expect(buildWorkspaceHostBundle(plan)).rejects.toMatchObject({ step: 'model-preflight' });
      expect(existsSync(join(workDir, 'source'))).toBe(false);
      expect(existsSync(join(workDir, 'source.ready.json'))).toBe(false);
      expect(existsSync(join(workDir, 'logs/materialize.log'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('checks model-pack authenticity before materializing a source checkout', async () => {
    const cache = join(workDir, 'corrupt-models');
    for (const model of ['harrier-oss-v1-0.6b-ONNX', 'embeddinggemma-300m-ONNX']) {
      const dir = join(cache, 'onnx-community', model, 'onnx');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'model.onnx'), 'plausible path, invalid bytes');
    }
    vi.stubEnv('PAPERCUSP_TRANSFORMERS_MODEL_CACHE', cache);
    try {
      const plan = { workDir, repoRoot: join(__dirname, '../../../..'), identity: { sourceSha: SHA }, desktopVersion: VERSION } as Parameters<typeof buildWorkspaceHostBundle>[0];
      await expect(buildWorkspaceHostBundle(plan)).rejects.toMatchObject({ step: 'model-preflight' });
      expect(readFileSync(join(workDir, 'logs/model-preflight.log'), 'utf8')).toMatch(/FATAL|missing|mismatch/i);
      expect(existsSync(join(workDir, 'source'))).toBe(false);
      expect(existsSync(join(workDir, 'source.ready.json'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('workspace host source dependency preparation', () => {
  function fixture(failPreparation: boolean, selection: 'valid' | 'wrong-input' | 'failed' = 'valid') {
    const repoRoot = join(workDir, 'producer');
    const source = join(workDir, 'source');
    const cache = join(workDir, 'models');
    for (const model of ['harrier-oss-v1-0.6b-ONNX', 'embeddinggemma-300m-ONNX']) {
      const dir = join(cache, 'onnx-community', model, 'onnx');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'model.onnx'), 'model fixture');
    }
    vi.stubEnv('PAPERCUSP_TRANSFORMERS_MODEL_CACHE', cache);
    const modelVerifier = join(repoRoot, 'papercusp-desktop/bin/lib');
    mkdirSync(modelVerifier, { recursive: true });
    writeFileSync(join(modelVerifier, 'transformers-models.sh'), 'exit 0\n');
    const setup = join(repoRoot, 'apps/operator/bin/release');
    mkdirSync(setup, { recursive: true });
    const input = 'a'.repeat(64);
    const generation = `v1-${'b'.repeat(64)}`;
    writeFileSync(join(setup, 'dependency-generation.sh'), [
      'set -eu',
      'test "$1" = --integration; shift 2',
      'case "$1" in',
      ` --fingerprint-ref) test "$2" = "${SHA}"; echo 'DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${SHA} input=${input}' ;;`,
      ` --ensure-ref) test "$2" = "${SHA}"; printf exact > "$0.prewarmed" ;;`,
      ' --select-inputs-from)',
      '  test -f "$0.prewarmed"; test "$3" = --lease-owner-pid; test "$4" -gt 0',
      selection === 'failed' ? '  exit 74' :
        `  echo 'DEPENDENCY_GENERATION_RESULT schema=1 identity=${generation} input=${selection === 'wrong-input' ? 'c'.repeat(64) : input} token=selected-token reused=true'`,
      '  ;;',
      ' *) exit 24 ;;',
      'esac',
      '',
    ].join('\n'));
    // Preserve the real producer's reader-mutex entrypoint/argument contract.
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/npm-install-safe.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      "const args = process.argv.slice(2);",
      "if (args[0] !== '--repo-root' || args[2] !== '--exec-under-lock' || args[3] !== '--') process.exit(25);",
      "const r = spawnSync(args[4], args.slice(5), { stdio: 'inherit' });",
      "process.exit(r.status ?? 26);",
    ].join('\n'));
    writeFileSync(join(setup, 'setup-release-checkout.sh'), [
      'set -eu',
      'release=; mode=; copy=; generation=; token=',
      'while [ "$#" -gt 0 ]; do',
      ' case "$1" in',
      '  --release) release="$2"; shift 2 ;;',
      '  --prepare-existing) mode=prepare; shift ;;',
      '  --node-modules-copy) copy="$2"; shift 2 ;;',
      '  --node-modules-generation-id) generation="$2"; shift 2 ;;',
      '  --node-modules-generation-token) token="$2"; shift 2 ;;',
      '  --ref|--integration|--source-integrity) shift 2 ;;',
      '  *) exit 21 ;;',
      ' esac',
      'done',
      'test "$mode" = prepare && test "$copy" = copy || exit 22',
      `test "$generation" = '${generation}' && test "$token" = selected-token || exit 27`,
      failPreparation ? 'exit 23' : 'printf prepared > "$release/dependencies-prepared"',
      '',
    ].join('\n'));
    mkdirSync(join(source, 'papercusp-desktop/bin'), { recursive: true });
    writeFileSync(join(source, 'unchanged-source'), 'pinned source');
    writeFileSync(join(workDir, 'source.ready.json'), JSON.stringify({ sourceSha: SHA }));
    writeFileSync(join(source, 'papercusp-desktop/bin/build-desktop-sidecar.sh'), [
      'test -f "$REPO_ROOT/dependencies-prepared" || exit 42',
      'echo SIDECAR_SAW_PREPARED_DEPENDENCIES',
      'exit 41',
      '',
    ].join('\n'));
    const envFile = join(workDir, 'identity.env');
    writeFileSync(envFile, '');
    return { source, plan: { workDir, repoRoot, identity: { sourceSha: SHA },
      desktopVersion: VERSION, releaseIdentityEnvFile: envFile } as Parameters<typeof buildWorkspaceHostBundle>[0] };
  }

  afterEach(() => vi.unstubAllEnvs());

  it('prepares copied dependencies before a sidecar can start, retaining the pinned source', async () => {
    const { source, plan } = fixture(false);
    // Stop at the deliberately incomplete sidecar: this test measures producer ordering.
    await expect(buildWorkspaceHostBundle(plan)).rejects.toMatchObject({ step: 'sidecar-build' });
    expect(readFileSync(join(source, 'dependencies-prepared'), 'utf8')).toBe('prepared');
    expect(readFileSync(join(workDir, 'logs/sidecar-build.log'), 'utf8')).toContain('SIDECAR_SAW_PREPARED_DEPENDENCIES');
    expect(readFileSync(join(source, 'unchanged-source'), 'utf8')).toBe('pinned source');
  });

  it('refuses the build before invoking the sidecar when dependency preparation fails', async () => {
    const { source, plan } = fixture(true);
    await expect(buildWorkspaceHostBundle(plan)).rejects.toMatchObject({ step: 'dependency-prepare', gating: false });
    expect(existsSync(join(workDir, 'logs/sidecar-build.log'))).toBe(false);
    expect(existsSync(join(workDir, 'sidecar.ready.json'))).toBe(false);
    expect(readFileSync(join(source, 'unchanged-source'), 'utf8')).toBe('pinned source');
  });

  it('uses the exact source selection even when the caller inherited a different live generation', async () => {
    vi.stubEnv('NODE_MODULES_GENERATION_ID', `v1-${'d'.repeat(64)}`);
    vi.stubEnv('NODE_MODULES_GENERATION_TOKEN', 'live-token');
    const { plan } = fixture(false);
    await expect(buildWorkspaceHostBundle(plan)).rejects.toMatchObject({ step: 'sidecar-build' });
    expect(readFileSync(join(workDir, 'logs/sidecar-build.log'), 'utf8')).toContain('SIDECAR_SAW_PREPARED_DEPENDENCIES');
  });

  it.each(['wrong-input', 'failed'] as const)('stops before preparation and sidecar on a %s exact selection', async (selection) => {
    const { source, plan } = fixture(false, selection);
    await expect(buildWorkspaceHostBundle(plan)).rejects.toMatchObject({ step: 'dependency-select', gating: false });
    expect(existsSync(join(source, 'dependencies-prepared'))).toBe(false);
    expect(existsSync(join(workDir, 'logs/sidecar-build.log'))).toBe(false);
    expect(existsSync(join(workDir, 'sidecar.ready.json'))).toBe(false);
  });
});

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'wh-cut-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function buildResult(requestIdentity: string, bundle = BUNDLE): WorkspaceHostBuildResult {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    requestIdentity,
    sourceSha: SHA,
    version: VERSION,
    desktopVersion: '0.0.21',
    sourceEpochSeconds: 1_790_000_000,
    bundle: { sha256: bundle, bytes: 2_000_000_000 },
    signature: { sha256: '5'.repeat(64), bytes: 295 },
    signingKeySha256: '6'.repeat(64),
    evidence: {
      sbomSha256: '7'.repeat(64),
      vulnerabilitiesSha256: '8'.repeat(64),
      summarySha256: '9'.repeat(64),
      secretScanSha256: 'a'.repeat(64),
    },
  };
}

/**
 * The real journal writer behind an in-memory ledger that only exists once the cut registers its
 * task — exactly as in production, where the seed is the first write the operation makes.
 */
function harness(overrides: Partial<WorkspaceHostReleaseCutDeps> = {}) {
  let inner: ReturnType<typeof memoryReleaseLedger> | null = null;
  const ledger: ReleaseTaskLedger = {
    getTask: async (taskId) => (inner ? inner.getTask(taskId) : null),
    taskReleaseJournalFromDetail: (detail) => (inner ? inner.taskReleaseJournalFromDetail(detail) : null),
    appendTaskReleaseReceipt: async (taskId, cursor, input) => {
      if (!inner) throw new Error('no task registered');
      return inner.appendTaskReleaseReceipt(taskId, cursor, input);
    },
  };
  const calls = {
    builds: 0,
    manifests: 0,
    verifies: 0,
    publishes: [] as Array<{ taskId: string; operationId: string; args: readonly string[] }>,
    prunes: [] as Array<{ repoRoot: string; workDir: string }>,
    rollbackResolves: [] as string[],
    manifestRollbackVersions: [] as Array<string | null>,
  };
  let stored: WorkspaceHostBuildResult | null = null;
  const deps: WorkspaceHostReleaseCutDeps = {
    ledger,
    registerTask: async (spec) => {
      const seed = (spec.detail as { release: TaskReleaseJournal }).release;
      inner = memoryReleaseLedger(structuredClone(seed));
    },
    newTaskId: () => TASK_ID,
    newOperationId: () => OPERATION_ID,
    readGitlinks: () => ({ ...GITLINKS }),
    readDesktopVersion: () => '0.0.21',
    sourceEpochSeconds: () => 1_790_000_000,
    build: async (plan) => {
      calls.builds += 1;
      stored = buildResult(plan.requestIdentity);
      return stored;
    },
    verifyBuild: async () => {
      calls.verifies += 1;
    },
    readBuildResult: async () => stored,
    resolveRollbackRelease: async (taskId) => {
      calls.rollbackResolves.push(taskId);
      return null;
    },
    emitManifest: async ({ workDir: dir, rollbackVersion }) => {
      calls.manifests += 1;
      calls.manifestRollbackVersions.push(rollbackVersion);
      mkdirSync(join(dir, 'publication'), { recursive: true });
      writeFileSync(join(dir, 'publication', 'manifest.json'), '{}');
      return { trusted: true };
    },
    publish: async ({ taskId, operationId, args }) => {
      calls.publishes.push({ taskId, operationId, args });
    },
    pruneIntermediates: async (input) => {
      calls.prunes.push(input);
      return [join(input.workDir, 'source'), join(input.workDir, 'sidecar')];
    },
    log: () => {},
    ...overrides,
  };
  return {
    deps,
    calls,
    journal: () => inner!.journal,
    setStored: (value: WorkspaceHostBuildResult | null) => {
      stored = value;
    },
  };
}

const options = () => ({
  repoRoot: '/repo',
  workDir,
  sourceSha: SHA,
  version: VERSION,
  publish: true,
  publisherArgs: ['--plan-only'],
});

describe('managed workspace-host cut journal (D-394)', () => {
  it('seeds a label identity that the maintained writer accepts, and that a digest-bound caller refuses', () => {
    const identity = { sourceSha: SHA, gitlinks: GITLINKS, version: VERSION };
    const seed = buildWorkspaceHostReleaseJournalSeed(OPERATION_ID, identity) as unknown as TaskReleaseJournal;
    const ctx = workspaceHostCutStageContext(TASK_ID, OPERATION_ID, identity, memoryReleaseLedger(seed));
    expect(() => assertReleaseTaskIdentity(seed, ctx.identity)).not.toThrow();
    expect(seed.artifactIdentity).toMatchObject({ channel: WORKSPACE_HOST_RELEASE_CHANNEL, platform: 'linux-x86_64' });
    expect(() => assertReleaseTaskIdentity(seed, { ...ctx.identity, bundleSha256: BUNDLE })).toThrow(/digest/);
  });

  it('opens one task, commits the build with its digest, and the build milestone reads verified', async () => {
    const h = harness();
    const result = await runWorkspaceHostReleaseCut(options(), h.deps);

    expect(result).toMatchObject({ taskId: TASK_ID, operationId: OPERATION_ID, bundleSha256: BUNDLE, build: 'built', published: true });
    const build = h.journal().receipts.filter((entry) => entry.stage === WORKSPACE_HOST_BUILD_STAGE);
    expect(build.map((entry) => entry.state)).toEqual(['intent', 'committed']);
    expect(build[1]!.evidenceRefs).toContain(`bundle:sha256:${BUNDLE}`);

    const projection = projectByocReleaseMilestones(h.journal());
    expect(projection.milestones.find((entry) => entry.key === 'build')?.status).toBe('verified');
    // Every later stage binds to this task through the digest the build receipt names.
    const binding = await resolveWorkspaceHostReleaseBinding({
      releaseTaskId: TASK_ID,
      stage: 'acceptance.soak-24h',
      hostRuntimeRelease: { bundleSha256: BUNDLE },
      ledger: h.deps.ledger,
    });
    expect(binding).toMatchObject({ bundleSha256: BUNDLE, version: VERSION, artifactLabel: { channel: WORKSPACE_HOST_RELEASE_CHANNEL } });
    // Publication rides the SAME task and operation.
    expect(h.calls.publishes).toEqual([{ taskId: TASK_ID, operationId: OPERATION_ID, args: ['--plan-only'] }]);
  });

  it('resumes from the work directory without rebuilding or re-emitting the manifest', async () => {
    const h = harness();
    await runWorkspaceHostReleaseCut(options(), h.deps);
    const again = await runWorkspaceHostReleaseCut(options(), h.deps);

    expect(again.build).toBe('reused');
    expect(h.calls.builds).toBe(1);
    expect(h.calls.manifests).toBe(1);
    expect(h.journal().receipts.filter((entry) => entry.stage === WORKSPACE_HOST_BUILD_STAGE)).toHaveLength(2);
    // The rollback edge is decided once, with the manifest; a resume does not re-resolve it.
    expect(h.calls.rollbackResolves).toEqual([TASK_ID]);
  });

  // WI-10003878 / D-437: the manifest names the last green-shipped release as its rollback edge.
  it('resolves the rollback edge from this cut task and hands its version to the manifest', async () => {
    const shipped = harness({
      resolveRollbackRelease: async (taskId) => {
        shipped.calls.rollbackResolves.push(taskId);
        return { taskId: 'prior-green-task', version: '0.0.21-p318r60' };
      },
    });
    await runWorkspaceHostReleaseCut(options(), shipped.deps);
    expect(shipped.calls.rollbackResolves).toEqual([TASK_ID]);
    expect(shipped.calls.manifestRollbackVersions).toEqual(['0.0.21-p318r60']);
  });

  // Positive control for the test above, in its own test: the work directory is per-test, and a
  // second cut in the same directory resumes the first cut's task instead of opening its own.
  it('hands the manifest no rollback edge when nothing in scope has shipped green (first shipment)', async () => {
    const first = harness();
    await runWorkspaceHostReleaseCut(options(), first.deps);
    expect(first.calls.rollbackResolves).toEqual([TASK_ID]);
    expect(first.calls.manifestRollbackVersions).toEqual([null]);
  });

  it('refuses to reuse a committed build whose bytes are gone', async () => {
    const h = harness();
    await runWorkspaceHostReleaseCut(options(), h.deps);
    h.setStored(null);
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/cannot be re-produced/);
  });

  it('commits an interrupted build from its finished result instead of building again', async () => {
    let crash = true;
    const h = harness({
      build: async (plan) => {
        h.calls.builds += 1;
        h.setStored(buildResult(plan.requestIdentity));
        if (crash) throw new Error('process died after the result was written');
        return buildResult(plan.requestIdentity);
      },
    });
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/process died/);
    expect(h.journal().receipts.at(-1)?.state).toBe('intent');

    crash = false;
    const resumed = await runWorkspaceHostReleaseCut(options(), h.deps);
    expect(resumed.build).toBe('reconciled');
    expect(h.calls.builds).toBe(1);
    expect(h.journal().receipts.map((entry) => entry.state)).toEqual(['intent', 'committed']);
  });

  it('confirms an interrupted build absent when it left no result, then builds on a fresh request', async () => {
    let crash = true;
    const h = harness({
      build: async (plan) => {
        h.calls.builds += 1;
        if (crash) throw new Error('killed mid-sidecar');
        const result = buildResult(plan.requestIdentity);
        h.setStored(result);
        return result;
      },
    });
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/killed/);
    crash = false;
    const resumed = await runWorkspaceHostReleaseCut(options(), h.deps);

    expect(resumed.build).toBe('built');
    const states = h.journal().receipts.map((entry) => [entry.state, entry.evidenceRefs.includes('reconcile:confirmed-absent')]);
    expect(states).toEqual([['intent', false], ['refused', true], ['intent', false], ['committed', false]]);
    const identities = new Set(h.journal().receipts.map((entry) => entry.requestIdentity));
    expect(identities.size).toBe(2);
  });

  it('a leg that could not run is retryable; a refused verdict is final for this input', async () => {
    let failure: WorkspaceHostCutStepError | null = new WorkspaceHostCutStepError('sidecar-build', false, 'exited 1');
    const h = harness({
      build: async (plan) => {
        if (failure) throw failure;
        return buildResult(plan.requestIdentity);
      },
    });
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/sidecar-build/);
    failure = null;
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).resolves.toMatchObject({ build: 'built' });

    const gated = harness({
      build: async () => {
        throw new WorkspaceHostCutStepError('vulnerability-audit', true, 'High match');
      },
    });
    const other = mkdtempSync(join(tmpdir(), 'wh-cut-'));
    try {
      const opts = { ...options(), workDir: other };
      await expect(runWorkspaceHostReleaseCut(opts, gated.deps)).rejects.toThrow(/vulnerability-audit/);
      expect(gated.journal().receipts.at(-1)?.evidenceRefs).toEqual(['build:gated:vulnerability-audit']);
      await expect(runWorkspaceHostReleaseCut(opts, gated.deps)).rejects.toThrow(/refused for this input/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses to reuse a work directory for a different source or version', async () => {
    const h = harness();
    await runWorkspaceHostReleaseCut(options(), h.deps);
    await expect(runWorkspaceHostReleaseCut({ ...options(), version: '0.0.21-p318r41' }, h.deps)).rejects.toThrow(/new --work-dir/);
  });

  it('refuses a manifest whose trust report is not trusted, and never publishes it', async () => {
    const h = harness({ emitManifest: async () => ({ trusted: false }) });
    await expect(runWorkspaceHostReleaseCut(options(), h.deps)).rejects.toThrow(/not trusted/);
    expect(h.calls.publishes).toEqual([]);
  });
});

// WI-10003700: every cut kept ~18 GB of rebuildable intermediates forever; nine cuts in three days
// kept ~150 GB on the root disk.
describe('post-publish intermediate prune (WI-10003700)', () => {
  const realPublish = () => ({ ...options(), publisherArgs: [] as string[] });

  it('prunes after a real publish, re-measuring the kept bytes first', async () => {
    const h = harness();
    const result = await runWorkspaceHostReleaseCut(realPublish(), h.deps);

    expect(h.calls.publishes).toHaveLength(1);
    expect(h.calls.verifies).toBe(1);
    expect(h.calls.prunes).toEqual([{ repoRoot: '/repo', workDir }]);
    expect(result.pruned).toEqual([join(workDir, 'source'), join(workDir, 'sidecar')]);
  });

  it.each([
    ['a plan-only publish', () => options()],
    ['--keep-intermediates', () => ({ ...realPublish(), keepIntermediates: true })],
    ['a retained build-only cut', () => ({ ...realPublish(), publish: false, keepIntermediates: true })],
  ])('keeps everything for %s', async (_label, opts) => {
    const h = harness();
    const result = await runWorkspaceHostReleaseCut(opts(), h.deps);
    expect(h.calls.prunes).toEqual([]);
    expect(result.pruned).toEqual([]);
  });

  it('parses --keep-intermediates, defaulting to prune', () => {
    const base = ['--source-sha', SHA, '--version', VERSION, '--work-dir', '/tmp/x'];
    expect(parseWorkspaceHostReleaseCutArgs(base, {}).keepIntermediates).toBe(false);
    expect(parseWorkspaceHostReleaseCutArgs([...base, '--keep-intermediates'], {}).keepIntermediates).toBe(true);
  });

  it('prunes a verified build-only cut and resumes from its retained publication', async () => {
    const h = harness();
    const buildOnly = { ...realPublish(), publish: false };
    const first = await runWorkspaceHostReleaseCut(buildOnly, h.deps);
    expect(first.published).toBe(false);
    expect(first.pruned).toEqual([join(workDir, 'source'), join(workDir, 'sidecar')]);
    expect(h.calls.publishes).toHaveLength(0);
    const again = await runWorkspaceHostReleaseCut(buildOnly, h.deps);
    expect(again.build).toBe('reused');
    expect(h.calls.prunes).toHaveLength(2);
  });

  it('keeps build-only intermediates when the retained publication fails verification', async () => {
    const h = harness({ verifyBuild: async () => { throw new Error('bundle digest mismatch'); } });
    await expect(runWorkspaceHostReleaseCut({ ...realPublish(), publish: false }, h.deps))
      .rejects.toThrow('bundle digest mismatch');
    expect(h.calls.prunes).toEqual([]);
  });

  it('deletes nothing when the publication directory no longer matches the committed build', async () => {
    const h = harness({
      verifyBuild: async () => {
        throw new Error('recorded build does not match the publication directory: server.tgz: missing');
      },
    });
    await expect(runWorkspaceHostReleaseCut(realPublish(), h.deps)).rejects.toThrow(/does not match/);
    expect(h.calls.prunes).toEqual([]);
  });

  it('a resumed, already-published cut publishes and prunes again idempotently', async () => {
    const h = harness();
    await runWorkspaceHostReleaseCut(realPublish(), h.deps);
    const again = await runWorkspaceHostReleaseCut(realPublish(), h.deps);
    expect(again.build).toBe('reused');
    expect(h.calls.prunes).toHaveLength(2);
  });
});

describe('workspace-host cut ownership admission', () => {
  beforeEach(() => vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(workDir, 'cut-mutex')));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('admits exactly one concurrent writer and permits an idempotent release', async () => {
    const lock = join(workDir, 'release-cut.lock');
    const attempts = await Promise.allSettled([acquireWorkDirLock(lock), acquireWorkDirLock(lock)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const winner = attempts.find(result => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('missing admitted writer');
    await winner.value(); await winner.value();
    expect(existsSync(lock)).toBe(false);
  });

  it('keeps permission-denied ownership evidence intact', async () => {
    const lock = join(workDir, 'release-cut.lock');
    writeFileSync(lock, '123456\n');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    await expect(acquireWorkDirLock(lock)).rejects.toThrow('denied');
    kill.mockRestore();
    expect(readFileSync(lock, 'utf8')).toBe('123456\n');
  });

  it('admits one replacement after positively confirming a dead owner', async () => {
    const lock = join(workDir, 'release-cut.lock');
    writeFileSync(lock, '123456\n');
    const actualKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 123456) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
      return actualKill(pid, signal);
    });
    const attempts = await Promise.allSettled([acquireWorkDirLock(lock), acquireWorkDirLock(lock)]);
    kill.mockRestore();
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n${readProcessIdentity(process.pid)}\n`);
    for (const result of attempts) if (result.status === 'fulfilled') await result.value();
  });

  it('uses the same ownership lock through a directory alias', async () => {
    const dir = join(workDir, 'cut'); mkdirSync(dir);
    const alias = join(workDir, 'cut-alias'); symlinkSync(dir, alias);
    const release = await acquireWorkDirLock(join(dir, 'release-cut.lock'));
    await expect(acquireWorkDirLock(join(alias, 'release-cut.lock'))).rejects.toThrow('another cut');
    await release();
    expect(existsSync(join(alias, 'release-cut.lock'))).toBe(false);
  });

  it.each(['linux:aaaa:2', 'linux:bbbb:1'])('replaces a reused PID or prior-boot identity %s without killing its unrelated process', async current => {
    const lock = join(workDir, 'release-cut.lock');
    writeFileSync(lock, '123456\nlinux:aaaa:1\n');
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const release = await acquireWorkDirLock(lock, pid => pid === process.pid ? 'linux:cccc:3' : current);
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\nlinux:cccc:3\n`);
    expect(kill).toHaveBeenCalledWith(123456, 0);
    expect(kill.mock.calls.filter(([pid]) => pid === 123456)).toEqual([[123456, 0]]);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    await release();
  });

  it.each(['linux:aaaa:1', null])('keeps a matching or unreadable live kernel identity %s', async current => {
    const lock = join(workDir, 'release-cut.lock');
    const owner = '123456\nlinux:aaaa:1\n';
    writeFileSync(lock, owner);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(acquireWorkDirLock(lock, pid => pid === process.pid ? 'linux:cccc:3' : current))
      .rejects.toThrow(current ? 'another cut' : 'unverifiable cut process identity');
    expect(readFileSync(lock, 'utf8')).toBe(owner);
  });

  it('refuses to publish an unmeasured process identity', async () => {
    const lock = join(workDir, 'release-cut.lock');
    await expect(acquireWorkDirLock(lock, () => null)).rejects.toThrow('unverifiable cut process identity');
    expect(existsSync(lock)).toBe(false);
  });

  it('does not let a repeated release remove a later admission in the same process', async () => {
    const lock = join(workDir, 'release-cut.lock');
    const first = await acquireWorkDirLock(lock);
    await first();
    const second = await acquireWorkDirLock(lock);
    await first();
    expect(existsSync(lock)).toBe(true);
    await second();
  });

  it.each(['', '123456junk\n', '0\n', '-1\n'])('retains malformed owner %j', async text => {
    const lock = join(workDir, 'release-cut.lock');
    writeFileSync(lock, text);
    await expect(acquireWorkDirLock(lock)).rejects.toThrow('unverifiable cut lock');
    expect(readFileSync(lock, 'utf8')).toBe(text);
  });

  it('never overwrites a symlinked lock or releases a changed owner', async () => {
    const lock = join(workDir, 'release-cut.lock');
    const other = join(workDir, 'other-owner');
    writeFileSync(other, '123456\n'); symlinkSync(other, lock);
    await expect(acquireWorkDirLock(lock)).rejects.toThrow('unverifiable cut lock');
    expect(readFileSync(other, 'utf8')).toBe('123456\n');
    rmSync(lock);
    const release = await acquireWorkDirLock(lock);
    writeFileSync(lock, '654321\n');
    await expect(release()).rejects.toThrow('owner changed');
    expect(readFileSync(lock, 'utf8')).toBe('654321\n');
  });
});

describe('workspace-host writer intermediate retention planning', () => {
  const hour = 3_600_000;
  const nowMs = 100 * hour;
  type CensusEntry = Parameters<typeof planWorkspaceHostCutIntermediates>[0]['census']['entries'][number];
  const entry = (name: string, bytes: number, ageHours: number): CensusEntry => ({
    path: join(workDir, name), bytes, newestWriteMs: nowMs - ageHours * hour, dev: 1, ino: name.length,
  });
  const plan = (entries: ReturnType<typeof entry>[], maxBytes = 100, extra: Record<string, unknown> = {}) =>
    planWorkspaceHostCutIntermediates({ workDir, nowMs, maxBytes, pins: [],
      census: { entries, retained: [], inspectedNodes: entries.length, retainedRecentTrees: 0 }, ...extra });

  it('evicts oldest eligible writer groups under the finite cap while retaining release evidence', () => {
    const result = plan([entry('source', 60, 2), entry('sidecar', 60, 1), entry('publication', 10, 99)]);
    expect(result.intermediates).toEqual(['source']);
    expect(result.caps[0]).toMatchObject({ maxBytes: 100, beforeBytes: 130, overByBytes: 30 });
    expect(result.retainedPaths).toEqual([join(workDir, 'publication')]);
  });

  it('uses the newest write across a tree and ready marker when ordering atomic groups', () => {
    const result = plan([entry('source', 60, 2), entry('source.ready.json', 1, 0), entry('sidecar', 60, 1)]);
    expect(result.intermediates).toEqual(['sidecar']);
  });

  it('protects a ready-marker pin across its complete group during cap selection', () => {
    const result = plan([entry('source', 60, 2), entry('source.ready.json', 1, 2), entry('sidecar', 60, 1)], 100,
      { pins: [{ paths: [join(workDir, 'source.ready.json')], expiresAt: new Date(nowMs + hour).toISOString() }] });
    expect(result.intermediates).toEqual(['sidecar']);
    expect(result.caps[0]).toMatchObject({ pinnedBytes: 61 });
  });

  it('expires old intermediates without selecting old logs, publication or unqualified children', () => {
    const result = plan([entry('source', 10, 80), entry('source.ready.json', 1, 80), entry('sidecar', 10, 1),
      entry('logs', 10, 99), entry('publication', 10, 99), entry('unknown', 10, 99)]);
    expect(result.intermediates).toEqual(['source']);
    expect(result.retainedPaths).toHaveLength(3);
  });

  it('uses the shared allocation union instead of double-counting hardlinks against the cap', () => {
    const link = { dev: 1, ino: 99, bytes: 80, paths: [join(workDir, 'source/shared'), join(workDir, 'publication/shared')] };
    const result = plan([{ ...entry('source', 90, 1), hardlinks: [link] }, { ...entry('publication', 90, 1), hardlinks: [link] }]);
    expect(result.intermediates).toEqual([]);
    expect(result.caps[0]).toMatchObject({ beforeBytes: 100, overByBytes: 0 });
  });

  it('unions repeated allocations within an atomic group and across retained evidence', () => {
    const link = { dev: 1, ino: 99, bytes: 20, paths: [join(workDir, 'source/shared'), join(workDir, 'source.ready.json'), join(workDir, 'publication/shared')] };
    const result = plan(['source', 'source.ready.json', 'publication'].map(name => ({ ...entry(name, 20, 1), hardlinks: [link] })), 25);
    expect(result.intermediates).toEqual([]);
    expect(result.caps[0]).toMatchObject({ beforeBytes: 20, overByBytes: 0 });
  });

  it.each(['source', 'source.ready.json'])('counts a complete retained boundary on %s and protects its whole atomic group', name => {
    const result = plan([], 100, { census: { entries: [entry(name === 'source' ? 'source.ready.json' : 'source', 1, 90),
      entry('sidecar', 30, 80), entry('publication', 10, 90)],
    retained: [{ path: join(workDir, name), reason: 'symlink boundary', entry: entry(name, 90, 90) }],
    retainedRecentTrees: 0, inspectedNodes: 10 } });
    expect(result.intermediates).toEqual(['sidecar']);
    expect(result.retainedPaths).toContain(join(workDir, 'source'));
    expect(result.caps[0]).toMatchObject({ beforeBytes: 131, pinnedBytes: 0, pinnedOverageBytes: 0 });
  });

  it.each(['foreign ownership boundary', 'protected policy root', 'unknown boundary'])('refuses unmeasured descendant allocation despite a boundary entry (%s)', reason => {
    expect(() => plan([], 100, { census: { entries: [entry('sidecar', 30, 80)],
      retained: [{ path: join(workDir, 'source'), reason, entry: entry('source', 1, 90) }],
      retainedRecentTrees: 0, inspectedNodes: 10 } })).toThrow('complete, unfiltered census');
  });

  it('reports retained over-cap bytes without evicting the publication to make the cap appear satisfied', () => {
    const result = plan([entry('publication', 200, 90), entry('source', 20, 1)]);
    expect(result.intermediates).toEqual(['source']);
    expect(result.caps[0]).toMatchObject({ beforeBytes: 220, overByBytes: 120 });
    expect(result.retainedPaths).toEqual([join(workDir, 'publication')]);
  });

  it.each([{ error: 'permission denied' }, { retainedRecentTrees: 1 }, { retained: [{ path: 'unreadable', reason: 'unknown allocation' }] }])
    ('refuses incomplete census input %j', incomplete => {
      expect(() => plan([], 100, { census: { entries: [], retained: [], inspectedNodes: 0, retainedRecentTrees: 0, ...incomplete } }))
        .toThrow('complete, unfiltered census');
    });

  it('refuses duplicate and outside-root census entries', () => {
    expect(() => plan([entry('source', 1, 1), entry('source', 1, 1)])).toThrow('invalid or duplicate');
    expect(() => plan([entry('../source', 1, 1)])).toThrow('invalid or duplicate');
  });

  it.each([0, Infinity, 20 * 1024 ** 3 + 1])('refuses a non-finite or widened cap %s', maxBytes => {
    expect(() => plan([], maxBytes)).toThrow('finite cap');
  });

  it.each([{ expiresAt: 'unknown', paths: ['/kept'] }, { expiresAt: new Date(nowMs + hour).toISOString(), paths: ['relative'] }])
    ('rejects an unverifiable pin snapshot %j', pin => {
      expect(() => plan([entry('source', 110, 80)], 100, { pins: [pin] })).toThrow('pin snapshot');
    });
});

describe('scheduled workspace-host writer retention admission', () => {
  beforeEach(() => {
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(workDir, 'pins'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(workDir, 'mutex'));
  });
  afterEach(() => vi.unstubAllEnvs());

  function fixture() {
    const dir = join(workDir, '.papercusp/wh-release-complete');
    mkdirSync(join(dir, 'sidecar'), { recursive: true });
    mkdirSync(join(dir, 'extracted'));
    mkdirSync(join(dir, 'publication/evidence'), { recursive: true });
    writeFileSync(join(dir, 'sidecar/payload'), 'rebuildable');
    writeFileSync(join(dir, 'sidecar.ready.json'), '{}');
    writeFileSync(join(dir, 'extracted/payload'), 'rebuildable');
    const result = buildResult('request');
    const hash = (name: string) => {
      writeFileSync(join(dir, 'publication', name), name);
      return createHash('sha256').update(name).digest('hex');
    };
    result.bundle = { sha256: hash('server.tgz'), bytes: Buffer.byteLength('server.tgz') };
    result.signature = { sha256: hash('server.tgz.minisig'), bytes: Buffer.byteLength('server.tgz.minisig') };
    result.signingKeySha256 = hash(WORKSPACE_HOST_PUBLISHED_SIGNING_KEY_NAME);
    result.evidence = { sbomSha256: hash(WORKSPACE_HOST_EVIDENCE_FILES.sbom), vulnerabilitiesSha256: hash(WORKSPACE_HOST_EVIDENCE_FILES.vulnerabilities),
      summarySha256: hash('evidence/summary.json'), secretScanSha256: hash(WORKSPACE_HOST_EVIDENCE_FILES.secretScan) };
    writeFileSync(join(dir, 'release-cut.json'), JSON.stringify({ schemaVersion: 1, taskId: TASK_ID,
      operationId: OPERATION_ID, sourceSha: SHA, version: VERSION }));
    writeFileSync(join(dir, 'build-result.json'), JSON.stringify(result));
    const scanHolders = vi.fn(async () => ({ complete: true, byPath: new Map<string, string[]>() }));
    const inspectTrees = vi.fn(async () => ({
      entries: readdirSync(dir).map((name, index) => ({ path: join(dir, name), dev: 1, ino: index + 1,
        bytes: name === 'sidecar' || name === 'extracted' ? 60 : name === 'publication' ? 10 : 1,
        newestWriteMs: Date.now() - (name === 'extracted' ? 1 : 2) * 3_600_000 })),
      retained: [], inspectedNodes: 20, retainedRecentTrees: 0, pinnedBytes: 0,
    }));
    const input = { repoRoot: workDir, home: workDir, dryRun: false, notAfterMs: Date.now() + 60_000, pins: [], maxBytes: 100 };
    const run = (overrides: Partial<Parameters<typeof reclaimWorkspaceHostCutIntermediatesWithProtection>[2]> = {}) =>
      withRetentionPinProtection(protect => reclaimWorkspaceHostCutIntermediatesWithProtection(input, protect,
        { inspectTrees, scanHolders, ...overrides }));
    return { dir, input, run, inspectTrees, scanHolders };
  }

  it('reuses the held pin mutex, validates completed build bytes and measures the cap after native effects', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({ ok: true, cuts: [{ status: 'reclaimed', selected: ['sidecar'],
      removed: [join(f.dir, 'sidecar.ready.json'), join(f.dir, 'sidecar')],
      caps: [{ beforeBytes: 134, afterBytes: 73, overByBytes: 0 }] }] });
    expect(f.inspectTrees).toHaveBeenCalledTimes(2);
    expect(f.scanHolders).toHaveBeenCalledWith([f.dir]);
    for (const kept of ['extracted/payload', 'release-cut.json', 'build-result.json', 'publication/server.tgz']) {
      expect(existsSync(join(f.dir, kept)), kept).toBe(true);
    }
    expect(existsSync(join(f.dir, 'release-cut.lock'))).toBe(false);
  });

  it('refuses a completed-build marker whose publication bytes no longer match', async () => {
    const f = fixture();
    writeFileSync(join(f.dir, 'publication/server.tgz'), 'corrupted');
    expect(await f.run()).toMatchObject({ ok: false, cuts: [{ status: 'failed', reason: expect.stringContaining('does not match') }] });
    expect(f.scanHolders).not.toHaveBeenCalled();
    expect(existsSync(join(f.dir, 'sidecar.ready.json'))).toBe(true);
    expect(existsSync(join(f.dir, 'release-cut.lock'))).toBe(false);
  });

  it.each(['operationId', 'sourceSha', 'version'])('retains a work dir with mismatched writer %s', async key => {
    const f = fixture();
    const stateFile = join(f.dir, 'release-cut.json');
    writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), [key]: 'other' }));
    expect(await f.run()).toMatchObject({ ok: false, cuts: [{ reason: 'cut state does not identify this completed build' }] });
    expect(f.inspectTrees).not.toHaveBeenCalled();
    expect(existsSync(join(f.dir, 'sidecar'))).toBe(true);
  });

  it('does not take a live writer lock or release that writer admission', async () => {
    const f = fixture();
    const lock = join(f.dir, 'release-cut.lock');
    const release = await acquireWorkDirLock(lock);
    try {
      expect(await f.run()).toMatchObject({ ok: true, cuts: [{ status: 'retained', reason: 'live cut holds work directory' }] });
      expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n${readProcessIdentity(process.pid)}\n`);
      expect(f.inspectTrees).not.toHaveBeenCalled();
    } finally { await release(); }
  });

  it.each([false, true])('retains intermediates when holder evidence is incomplete or occupied (%s)', async occupied => {
    const f = fixture();
    const result = await f.run({ scanHolders: async () => ({ complete: occupied,
      byPath: new Map(occupied ? [[f.dir, ['123']]] : []) }) });
    expect(result.cuts[0]).toMatchObject(occupied ? { status: 'retained', reason: 'live workspace-host holders' }
      : { status: 'failed', reason: 'workspace-host holder scan incomplete' });
    expect(existsSync(join(f.dir, 'sidecar.ready.json'))).toBe(true);
  });

  it('refuses a partial census before build verification or effects', async () => {
    const f = fixture(); const verifyBuild = vi.fn();
    const census = await f.inspectTrees();
    expect(await f.run({ inspectTrees: async () => ({ ...census, error: 'partial' }), verifyBuild }))
      .toMatchObject({ ok: false, cuts: [{ reason: expect.stringContaining('complete, unfiltered census') }] });
    expect(verifyBuild).not.toHaveBeenCalled();
    expect(existsSync(join(f.dir, 'sidecar'))).toBe(true);
  });

  it('accepts a real complete native census with a retained symlink group and still plans its clean sibling', async () => {
    const f = fixture(); f.input.dryRun = true;
    symlinkSync(join(f.dir, 'extracted/payload'), join(f.dir, 'sidecar/tool-link'));
    const result = await f.run({ inspectTrees: inspectRetentionTrees });
    expect(result).toMatchObject({ ok: true, cuts: [{ status: 'planned' }] });
    expect(result.cuts[0]?.selected).toContain('extracted');
    expect(result.cuts[0]?.selected).not.toContain('sidecar');
    expect(result.cuts[0]?.retainedPaths).toContain(join(f.dir, 'sidecar'));
    expect(result.cuts[0]?.caps?.[0]?.beforeBytes).toBeGreaterThan(100);
    expect(existsSync(join(f.dir, 'sidecar/tool-link'))).toBe(true);
  });

  it('marks the cap unavailable for a real native foreign directory with allocated descendants before touching markers', async () => {
    const f = fixture();
    const physicalDir = realpathSync(f.dir);
    const payload = join(physicalDir, 'extracted/payload');
    writeFileSync(payload, Buffer.alloc(128 * 1024, 7));
    // A read-only namespace supplies a real foreign-owned directory on this
    // device without chown, sudo or persistent privileged fixture files. Its
    // allocated descendant is our own fixture payload, visible through the bind.
    let foreign = dirname(physicalDir);
    while (statSync(foreign).uid === process.getuid?.() || statSync(foreign).dev !== statSync(physicalDir).dev) {
      const parent = dirname(foreign);
      if (parent === foreign) throw new Error('native fixture needs a foreign-owned ancestor on its device');
      foreign = parent;
    }
    const namespace = ['--ro-bind', '/', '/', '--ro-bind', foreign, join(physicalDir, 'sidecar')];
    const boundPayload = join(physicalDir, 'sidecar', relative(foreign, payload));
    expect(Number(execFileSync('bwrap', [...namespace, 'stat', '-c', '%b', boundPayload], { encoding: 'utf8' }).trim())).toBeGreaterThan(0);
    const result = await f.run({ inspectTrees: (root, options) => inspectRetentionTrees(root, { ...options, timeoutMs: 10_000,
      spawn: (command, args) => spawn('bwrap', [...namespace, command, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) }) });
    expect(result).toMatchObject({ ok: false, cuts: [{ status: 'failed',
      reason: expect.stringContaining('foreign ownership boundary'), capsMeasurement: 'unavailable',
      retainedPaths: expect.arrayContaining([join(f.dir, 'sidecar')]) }] });
    expect(result.cuts[0]?.caps).toBeUndefined();
    expect(result.cuts[0]?.removed).toBeUndefined();
    expect(existsSync(join(f.dir, 'sidecar.ready.json'))).toBe(true);
    expect(existsSync(join(f.dir, 'sidecar/payload'))).toBe(true);
    expect(existsSync(join(f.dir, 'extracted/payload'))).toBe(true);
    expect(f.scanHolders).not.toHaveBeenCalled();
  });

  it('refuses a selected intermediate alias before deleting its ready marker', async () => {
    const f = fixture();
    rmSync(join(f.dir, 'sidecar'), { recursive: true });
    symlinkSync(join(f.dir, 'extracted'), join(f.dir, 'sidecar'));
    expect(await f.run()).toMatchObject({ ok: false, cuts: [{ reason: 'intermediate is an alias' }] });
    expect(existsSync(join(f.dir, 'sidecar.ready.json'))).toBe(true);
    expect(existsSync(join(f.dir, 'extracted/payload'))).toBe(true);
  });

  it('retains named-only and aliased directories without treating their names as writer proof', async () => {
    const f = fixture();
    mkdirSync(join(workDir, '.papercusp/wh-release-unknown'));
    symlinkSync(f.dir, join(workDir, '.papercusp/wh-release-alias'));
    const result = await f.run();
    expect(result.cuts.find(cut => cut.workDir.endsWith('unknown'))).toMatchObject({ status: 'retained', reason: 'no completed writer state' });
    expect(result.cuts.find(cut => cut.workDir.endsWith('alias'))).toMatchObject({ status: 'retained', reason: 'unqualified directory or alias' });
  });

  it('plans dry runs without deleting the selected marker or tree', async () => {
    const f = fixture(); f.input.dryRun = true;
    expect(await f.run()).toMatchObject({ ok: true, cuts: [{ status: 'planned', selected: ['sidecar'] }] });
    expect(existsSync(join(f.dir, 'sidecar.ready.json'))).toBe(true);
    expect(existsSync(join(f.dir, 'sidecar/payload'))).toBe(true);
    expect(f.inspectTrees).toHaveBeenCalledTimes(1);
  });

  it('keeps a protected atomic group while admitting its unpinned sibling', async () => {
    const f = fixture();
    const pins = [{ paths: [join(f.dir, 'sidecar.ready.json')], expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    const result = await withRetentionPinProtection(() => reclaimWorkspaceHostCutIntermediatesWithProtection(
      { ...f.input, pins }, pinProtection(pins), { inspectTrees: f.inspectTrees, scanHolders: f.scanHolders }));
    expect(result).toMatchObject({ ok: true, cuts: [{ selected: ['extracted'], removed: [join(f.dir, 'extracted')] }] });
    expect(existsSync(join(f.dir, 'sidecar.ready.json'))).toBe(true);
    expect(existsSync(join(f.dir, 'sidecar/payload'))).toBe(true);
  });

  it.each(['physical alias pin', 'legacy lease', 'pin expired after snapshot'])('uses the same planner/effect protection for %s', async kind => {
    const f = fixture();
    const nowMs = kind === 'pin expired after snapshot' ? Date.now() - 5_000 : Date.now();
    const alias = join(workDir, 'cut-alias'); symlinkSync(f.dir, alias);
    const pins = kind === 'legacy lease' ? [] : [{ paths: [join(kind === 'physical alias pin' ? alias : f.dir, 'sidecar')],
      expiresAt: new Date(nowMs + (kind === 'pin expired after snapshot' ? 1000 : 60_000)).toISOString() }];
    const agentProtection = pinProtection(pins, nowMs);
    const protection = kind === 'legacy lease' ? Object.assign((path: string) => path === join(f.dir, 'sidecar'),
      { coversPath: pinProtection([], nowMs).coversPath }) : agentProtection;
    const result = await withRetentionPinProtection(() => reclaimWorkspaceHostCutIntermediatesWithProtection(
      { ...f.input, pins, nowMs }, protection, { inspectTrees: f.inspectTrees, scanHolders: f.scanHolders }));
    expect(result).toMatchObject({ ok: true, cuts: [{ selected: ['extracted'], removed: [join(f.dir, 'extracted')],
      capsMeasurement: 'after-effects', caps: [{ pinnedOverageBytes: 0 }] }] });
    expect(existsSync(join(f.dir, 'sidecar.ready.json'))).toBe(true);
    expect(existsSync(join(f.dir, 'sidecar/payload'))).toBe(true);
  });

  it.each([false, true])('preserves partial effects and marks post-effect measurement availability (failure=%s)', async measurementFails => {
    const f = fixture(); f.input.maxBytes = 25;
    mkdirSync(join(f.dir, 'source'));
    writeFileSync(join(f.dir, 'source.ready.json'), '{}');
    let inspections = 0;
    const result = await f.run({ removeSource: () => { throw new Error('injected source removal failure'); },
      inspectTrees: async () => {
        if (++inspections > 1 && measurementFails) throw new Error('injected census failure');
        return f.inspectTrees();
      } });
    expect(result).toMatchObject({ ok: false, cuts: [{ status: 'failed', reason: expect.stringContaining('injected source removal failure'),
      removed: [join(f.dir, 'sidecar.ready.json'), join(f.dir, 'sidecar'), join(f.dir, 'source.ready.json')],
      capsMeasurement: measurementFails ? 'unavailable' : 'after-effects' }] });
    if (measurementFails) expect(result.cuts[0]?.caps).toBeUndefined();
    else expect(result.cuts[0]?.caps?.[0]).toMatchObject({ beforeBytes: 136, afterBytes: 74 });
    expect(existsSync(join(f.dir, 'source'))).toBe(true);
    expect(existsSync(join(f.dir, 'extracted'))).toBe(true);
  });

  it('reports retained unpinned overage after effects instead of claiming the cap was met', async () => {
    const f = fixture(); const census = f.inspectTrees;
    const result = await f.run({ inspectTrees: async () => {
      const value = await census();
      return { ...value, entries: value.entries.map(entry => entry.path.endsWith('/publication') ? { ...entry, bytes: 200 } : entry) };
    } });
    expect(result).toMatchObject({ ok: false, cuts: [{ status: 'failed',
      reason: 'workspace-host cap remains exceeded by retained unpinned bytes', caps: [{ afterBytes: 203, overByBytes: 103 }] }] });
    expect(existsSync(join(f.dir, 'publication/server.tgz'))).toBe(true);
  });

  it('does not start a census after the admission deadline', async () => {
    const f = fixture(); f.input.notAfterMs = Date.now() - 1;
    expect(await f.run()).toMatchObject({ ok: false, cuts: [{ reason: 'workspace-host retention deadline exceeded' }] });
    expect(f.inspectTrees).not.toHaveBeenCalled();
  });

  it('names candidates never examined when the delegate deadline interrupts the discovered population', async () => {
    const f = fixture(); f.input.notAfterMs = Date.now() - 1;
    const other = join(workDir, '.papercusp/wh-release-z-unreached'); mkdirSync(other);
    const result = await f.run();
    expect(result.ok).toBe(false);
    expect(result.notExamined).toEqual([other]);
    expect(result.cuts).toHaveLength(1);
    expect(f.inspectTrees).not.toHaveBeenCalled();
  });
});

describe('pruneWorkspaceHostCutIntermediates on a real worktree (WI-10003700)', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  const worktrees = (repo: string) =>
    git(repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));

  let repo: string;
  beforeEach(() => {
    repo = join(workDir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'seed');
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(workDir, 'retention-pins'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(workDir, 'retention-mutex'));
  });
  afterEach(() => vi.unstubAllEnvs());

  function pin(paths: string[], expiresAt = Date.now() + 3_600_000): void {
    const root = join(workDir, 'retention-pins');
    mkdirSync(root, { recursive: true });
    const id = randomUUID();
    const tag = 'agent-pin-' + Buffer.from(JSON.stringify({
      version: 1, id, owner: 'release-cut-test', reason: 'retained build proof', createdAt: new Date().toISOString(),
    })).toString('base64url');
    writeFileSync(join(root, `lease-agent-pin-${id}.tsv`),
      `schema=papercusp-release-retention/v1\ntag=${tag}\nexpires_ns=${BigInt(expiresAt) * 1_000_000n}\n`
      + paths.map(path => `path=${path}\n`).join(''));
  }

  function cutDir(): string {
    const dir = join(workDir, 'cut');
    git(repo, 'worktree', 'add', '-q', '--detach', join(dir, 'source'), 'HEAD');
    for (const sub of ['sidecar/node', 'extracted/app', 'publication/evidence', 'logs', 'sidecar-trust']) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    for (const file of [
      'source.ready.json', 'sidecar.ready.json', 'vite-build.lock', 'release-cut.json', 'build-result.json',
      'publication-input.json', 'server.tgz.tauri.sig', 'publication/server.tgz', 'publication/evidence/summary.json',
      'logs/sign.log', 'sidecar-trust/sbom.json', 'sidecar/node/bin', 'extracted/app/bin',
    ]) {
      writeFileSync(join(dir, file), 'x');
    }
    return dir;
  }

  it('removes source through git (no dangling registration) plus sidecar/extracted/markers, and keeps the audit trail', async () => {
    const dir = cutDir();
    expect(worktrees(repo)).toHaveLength(2);

    const removed = await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir });

    expect(removed.sort()).toEqual(
      ['source.ready.json', 'sidecar.ready.json', 'source', 'sidecar', 'extracted', 'vite-build.lock'].map((n) => join(dir, n)).sort(),
    );
    for (const gone of ['source', 'sidecar', 'extracted', 'source.ready.json', 'sidecar.ready.json', 'vite-build.lock']) {
      expect(existsSync(join(dir, gone)), gone).toBe(false);
    }
    for (const kept of [
      'release-cut.json', 'build-result.json', 'publication-input.json', 'server.tgz.tauri.sig',
      'publication/server.tgz', 'publication/evidence/summary.json', 'logs/sign.log', 'sidecar-trust/sbom.json',
    ]) {
      expect(existsSync(join(dir, kept)), kept).toBe(true);
    }
    expect(worktrees(repo)).toEqual([realpathSync(repo)]);
    // Idempotent: a second pass finds nothing left.
    expect(await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir })).toEqual([]);
  });

  it('prunes only writer groups selected by the retention planner, preserving newer intermediates and evidence', async () => {
    const dir = cutDir();
    const removed = await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir, intermediates: ['sidecar', 'sidecar'] });
    expect(removed).toEqual([join(dir, 'sidecar.ready.json'), join(dir, 'sidecar')]);
    expect(worktrees(repo)).toHaveLength(2);
    for (const kept of ['source', 'source.ready.json', 'extracted', 'vite-build.lock', 'publication/server.tgz', 'release-cut.json', 'logs/sign.log']) {
      expect(existsSync(join(dir, kept)), kept).toBe(true);
    }
  });

  it('honors pins on a selected group without broadening selection to another group', async () => {
    const dir = cutDir();
    pin([join(dir, 'sidecar.ready.json')]);
    expect(await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir, intermediates: ['sidecar'] })).toEqual([]);
    for (const kept of ['source', 'source.ready.json', 'sidecar', 'sidecar.ready.json', 'extracted', 'vite-build.lock']) {
      expect(existsSync(join(dir, kept)), kept).toBe(true);
    }
  });

  it('treats an empty selection as a no-op', async () => {
    const dir = cutDir();
    expect(await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir, intermediates: [] })).toEqual([]);
    expect(existsSync(join(dir, 'sidecar.ready.json'))).toBe(true);
    expect(worktrees(repo)).toHaveLength(2);
  });

  it('preserves the cap planner order across atomic groups', async () => {
    const dir = cutDir();
    expect(await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir, intermediates: ['extracted', 'sidecar'] }))
      .toEqual([join(dir, 'extracted'), join(dir, 'sidecar.ready.json'), join(dir, 'sidecar')]);
  });

  it.each(['publication', 'sidecar.ready.json', '../source', '/tmp/source'])('rejects unowned or non-atomic selection %s before any removal', async child => {
    const dir = cutDir();
    await expect(pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir,
      intermediates: ['source', child] as Parameters<typeof pruneWorkspaceHostCutIntermediates>[0]['intermediates'] }))
      .rejects.toThrow('unknown workspace-host intermediate');
    for (const kept of ['source', 'source.ready.json', 'sidecar', 'sidecar.ready.json', 'publication/server.tgz']) {
      expect(existsSync(join(dir, kept)), kept).toBe(true);
    }
    expect(worktrees(repo)).toHaveLength(2);
  });

  it('falls back when git does not recognise the path, dropping only THIS registration', async () => {
    const dir = cutDir();
    const other = join(workDir, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    // Asking the WRONG repository makes `git worktree remove` refuse, which forces the fallback.
    removeReleaseSourceWorktree(other, join(dir, 'source'));
    expect(existsSync(join(dir, 'source'))).toBe(false);
    expect(worktrees(repo)).toEqual([realpathSync(repo)]);
  });

  it.each([
    ['source', 'source.ready.json'],
    ['source.ready.json', 'source'],
    ['sidecar/node/bin', 'sidecar.ready.json'],
    ['sidecar.ready.json', 'sidecar/node/bin'],
    ['extracted/app/bin', 'extracted/app/bin'],
    ['vite-build.lock', 'vite-build.lock'],
  ])('keeps a live pin on %s and its paired state %s', async (pinned, paired) => {
    const dir = cutDir();
    pin([join(dir, pinned)]);

    const removed = await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir });

    expect(existsSync(join(dir, pinned))).toBe(true);
    expect(existsSync(join(dir, paired))).toBe(true);
    expect(removed).not.toContain(join(dir, paired));
    expect(existsSync(join(dir, 'publication/server.tgz'))).toBe(true);
    if (pinned.startsWith('source')) expect(worktrees(repo)).toHaveLength(2);
  });

  it('keeps the entire intermediate set for a containing work-dir pin through a physical alias', async () => {
    const dir = cutDir();
    const alias = join(workDir, 'cut-alias');
    symlinkSync(dir, alias);
    pin([alias]);

    expect(await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir })).toEqual([]);
    expect(worktrees(repo)).toHaveLength(2);
    for (const kept of ['source.ready.json', 'sidecar.ready.json', 'sidecar', 'extracted', 'vite-build.lock']) {
      expect(existsSync(join(dir, kept)), kept).toBe(true);
    }
  });

  it('allows expired pins and protects only the exact sibling scope', async () => {
    const dir = cutDir();
    pin([join(dir, 'source')], Date.now() - 60_000);
    pin([join(dir, 'sidecar-other')]);

    const removed = await pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir });

    expect(removed).toHaveLength(6);
    expect(worktrees(repo)).toEqual([realpathSync(repo)]);
    expect(existsSync(join(dir, 'publication/evidence/summary.json'))).toBe(true);
  });

  it.each(['malformed', 'unreadable'])('fails closed before removing markers when a pin is %s', async kind => {
    const dir = cutDir();
    const root = join(workDir, 'retention-pins');
    mkdirSync(root, { recursive: true });
    const file = join(root, 'lease-agent-pin-invalid.tsv');
    if (kind === 'malformed') writeFileSync(file, 'invalid pin');
    else mkdirSync(file);

    await expect(pruneWorkspaceHostCutIntermediates({ repoRoot: repo, workDir: dir }))
      .rejects.toThrow('retention pins unreadable');
    for (const kept of ['source', 'source.ready.json', 'sidecar', 'sidecar.ready.json', 'extracted', 'vite-build.lock']) {
      expect(existsSync(join(dir, kept)), kept).toBe(true);
    }
    expect(worktrees(repo)).toHaveLength(2);
  });

  it('never deletes a registration that points at a different checkout', async () => {
    const dir = cutDir();
    const admin = git(join(dir, 'source'), 'rev-parse', '--absolute-git-dir').trim();
    const impostor = join(workDir, 'impostor');
    mkdirSync(impostor);
    writeFileSync(join(impostor, '.git'), `gitdir: ${admin}\n`);

    removeReleaseSourceWorktree(join(workDir, 'repo-missing'), impostor);

    expect(existsSync(impostor)).toBe(false);
    expect(existsSync(admin)).toBe(true);
    expect(worktrees(repo)).toHaveLength(2);
  });
});

describe('deterministic pack', () => {
  function tree(root: string, mtime: number) {
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, 'apps/operator'), { recursive: true });
    writeFileSync(join(root, 'bin/node'), 'node');
    writeFileSync(join(root, 'apps/operator/serve.mjs'), 'serve');
    writeFileSync(join(root, 'zeta.json'), '{}');
    for (const path of ['bin/node', 'apps/operator/serve.mjs', 'zeta.json', 'bin', 'apps/operator', 'apps', '.']) {
      utimesSync(join(root, path), mtime, mtime);
    }
  }

  it('produces identical bytes for the same tree regardless of file times, with no build-box identity', async () => {
    const first = join(workDir, 'first');
    const second = join(workDir, 'second');
    tree(first, 1_700_000_000);
    tree(second, 1_750_000_000);
    await packDeterministically(first, 1_790_000_000, join(workDir, 'a.tgz'));
    await packDeterministically(second, 1_790_000_000, join(workDir, 'b.tgz'));

    const [a, b] = await Promise.all([sha256OfFile(join(workDir, 'a.tgz')), sha256OfFile(join(workDir, 'b.tgz'))]);
    expect(a.sha256).toBe(b.sha256);
    // Positive control: a different source time is a different pack, so equality above is not vacuous.
    await packDeterministically(first, 1_790_000_001, join(workDir, 'c.tgz'));
    expect((await sha256OfFile(join(workDir, 'c.tgz'))).sha256).not.toBe(a.sha256);

    const listing = execFileSync('tar', ['--list', '--verbose', '--numeric-owner', '--gzip', '--file', join(workDir, 'a.tgz')], {
      encoding: 'utf8',
    }).trim().split('\n');
    expect(listing.every((line) => line.split(/\s+/)[1] === '0/0')).toBe(true);
    const names = listing.map((line) => line.split(/\s+/).at(-1)!);
    expect(names).toEqual([...names].sort());
    // gzip -n: no embedded name and a zero header mtime (bytes 4..7).
    expect(readFileSync(join(workDir, 'a.tgz')).subarray(4, 8).readUInt32LE(0)).toBe(0);
  });
});

describe('publication input', () => {
  const facts = {
    version: VERSION,
    sourceSha: SHA,
    sourceRepository: 'https://github.com/Papercusp/papercup.git',
    desktopVersion: '0.0.21',
    desktopRevision: DESKTOP_PIN,
    sourceRoot: '/work/source',
    bundleRoot: '/work/extracted',
    rollbackVersion: null,
  };

  it('uses the measured repository instead of a template repository', () => {
    const template = JSON.parse(readFileSync(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8'));
    const input = buildWorkspaceHostPublicationInput(template, facts);
    expect(input.source.repository).toBe(facts.sourceRepository);
  });

  it.each([
    'https://github.com/Papercusp/papercup.git',
    'git@github.com:Papercusp/papercup.git',
  ])('measures the actual integration origin %s', (origin) => {
    const repo = join(workDir, 'origin-source');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
    expect(readWorkspaceHostSourceRepository(repo)).toBe(facts.sourceRepository);
  });

  it('refuses hardcoded template origins and missing or credential-bearing measured origins', () => {
    const template = JSON.parse(readFileSync(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8'));
    expect(() => buildWorkspaceHostPublicationInput({
      ...template, source: { repository: 'https://github.com/Papercusp/papercusp.git' },
    }, facts)).toThrow(/template must not pin source.repository/);
    for (const sourceRepository of [undefined, 'https://user:secret@github.com/Papercusp/papercup.git']) {
      expect(() => buildWorkspaceHostPublicationInput(template, { ...facts, sourceRepository } as typeof facts))
        .toThrow(/measured credential-free GitHub sourceRepository/);
    }
  });

  it('fills the tracked template from measured facts and passes the manifest CLI parser', () => {
    const template = JSON.parse(readFileSync(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8'));
    const input = buildWorkspaceHostPublicationInput(template, facts);
    expect(input.image.version).toBe(VERSION);
    expect(input.source.revision).toBe(SHA);
    expect(input.builder.version).toBe('0.0.21');
    expect(input.parameters).toContainEqual({ name: 'desktop_revision', value: DESKTOP_PIN });
    expect(input.materials).toContainEqual(
      expect.objectContaining({ path: 'bin/node', sourcePath: '/work/extracted/bin/node' }),
    );
    expect(input.materials).toContainEqual(
      expect.objectContaining({
        path: 'papercusp-desktop/bin/audit-release-bundle.py',
        sourcePath: '/work/source/papercusp-desktop/bin/audit-release-bundle.py',
      }),
    );
  });

  it('refuses a material with no origin, and a template that pins the measured desktop revision', () => {
    const template = JSON.parse(readFileSync(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8'));
    expect(() =>
      buildWorkspaceHostPublicationInput({ ...template, materials: [{ path: 'bin/node' }] }, facts),
    ).toThrow(/'source' or 'bundle'/);
    expect(() =>
      buildWorkspaceHostPublicationInput(
        { ...template, parameters: [...template.parameters, { name: 'desktop_revision', value: 'x' }] },
        facts,
      ),
    ).toThrow(/desktop_revision/);
  });

  // WI-10003878 / D-437: before this, no manifest ever carried lifecycle.rollbackTarget, so
  // release.shipment.green refused every r5x/r60 release.
  it('writes the last green-shipped release as lifecycle.rollbackTarget, and none for a first shipment', () => {
    const template = JSON.parse(readFileSync(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8'));
    const withEdge = buildWorkspaceHostPublicationInput(template, { ...facts, rollbackVersion: '0.0.21-p318r60' });
    expect(withEdge.lifecycle?.rollbackTarget).toEqual({ id: template.image.id, version: '0.0.21-p318r60' });
    expect(withEdge.lifecycle?.rollbackTarget?.id).toBe('papercusp-workspace-host');

    const first = buildWorkspaceHostPublicationInput(template, facts);
    expect(first.lifecycle?.rollbackTarget).toBeUndefined();
  });

  it('refuses a rollback edge to the release being cut, and a template that authors the edge', () => {
    const template = JSON.parse(readFileSync(WORKSPACE_HOST_PUBLICATION_INPUT_TEMPLATE, 'utf8'));
    expect(() => buildWorkspaceHostPublicationInput(template, { ...facts, rollbackVersion: VERSION })).toThrow(
      /cannot roll back to itself/,
    );
    expect(() =>
      buildWorkspaceHostPublicationInput(
        { ...template, lifecycle: { rollbackTarget: { id: 'papercusp-workspace-host', version: '0.0.1' } } },
        facts,
      ),
    ).toThrow(/must not pin lifecycle.rollbackTarget/);
  });
});

describe('CLI args', () => {
  it('passes publisher flags through and rejects unknown flags', () => {
    expect(
      parseWorkspaceHostReleaseCutArgs(['--source-sha', SHA, '--version', VERSION, '--work-dir', '/tmp/x', '--base', 'https://b', '--publish-plan-only'], {}),
    ).toMatchObject({ sourceSha: SHA, publish: true, planOnly: false, publisherArgs: ['--base', 'https://b', '--plan-only'] });
    expect(
      parseWorkspaceHostReleaseCutArgs(['--source-sha', SHA, '--version', VERSION, '--work-dir', '/tmp/x', '--plan-only'], {}),
    ).toMatchObject({ sourceSha: SHA, publish: true, planOnly: true, publisherArgs: [] });
    expect(() => parseWorkspaceHostReleaseCutArgs(['--source-sha', SHA, '--nope', 'x'], {})).toThrow(/unknown flag/);
    expect(() => parseWorkspaceHostReleaseCutArgs(['--version', VERSION, '--work-dir', '/tmp/x'], {})).toThrow(/--source-sha/);
    expect(() => parseWorkspaceHostReleaseCutArgs(['--source-sha', SHA, '--version', VERSION, '--work-dir', '/tmp/x', '--plan-only', '--publish-plan-only'], {}))
      .toThrow(/cannot be combined/);
  });

  it('prints a whole-cut preview without invoking the cut runner or creating its work directory', async () => {
    const plannedWorkDir = join(workDir, 'planned-cut');
    const lines: string[] = [];
    const result = await runWorkspaceHostReleaseCutCli(
      ['--source-sha', SHA, '--version', VERSION, '--work-dir', plannedWorkDir, '--plan-only'],
      {
        env: {},
        signingKeyPath: join(workDir, 'missing-signing-key'),
        newTaskId: () => TASK_ID,
        newOperationId: () => OPERATION_ID,
        log: (line) => lines.push(line),
        run: async () => {
          throw new Error('the cut runner must not run during --plan-only');
        },
      },
    );

    expect(result).toBe('planned');
    expect(existsSync(plannedWorkDir)).toBe(false);
    expect(lines.join('\n')).toContain(`source sha: ${SHA}`);
    expect(lines.join('\n')).toContain(`version: ${VERSION}`);
    expect(lines.join('\n')).toContain(`work directory: ${plannedWorkDir}`);
    expect(lines.join('\n')).toContain(`task id: ${TASK_ID} (planned)`);
    expect(lines.join('\n')).toContain(`operation id: ${OPERATION_ID} (planned)`);
    expect(lines.join('\n')).toContain('signing key present: no');
  });

  // WI-10003172: from a box that SNI-blackholes the branded Cupboard (EI-16742) the cut
  // died at publish.multipart.initiate because the sourced PAPERCUSP_CUPBOARD_URL override
  // was never forwarded to the publisher.
  describe('Cupboard base when --base is absent', () => {
    const REQUIRED = ['--source-sha', SHA, '--version', VERSION, '--work-dir', '/tmp/x'];

    it('forwards the PAPERCUSP_CUPBOARD_URL override, normalized like resolveCupboardBaseUrl', () => {
      expect(
        parseWorkspaceHostReleaseCutArgs(REQUIRED, { PAPERCUSP_CUPBOARD_URL: '  https://worker.example.dev//  ' }).publisherArgs,
      ).toEqual(['--base', 'https://worker.example.dev']);
    });

    it('lets an explicit --base win over the override', () => {
      expect(
        parseWorkspaceHostReleaseCutArgs([...REQUIRED, '--base', 'https://explicit'], { PAPERCUSP_CUPBOARD_URL: 'https://worker.example.dev' })
          .publisherArgs,
      ).toEqual(['--base', 'https://explicit']);
    });

    it('passes no --base when the override is unset or blank, so the publisher keeps its branded default', () => {
      expect(parseWorkspaceHostReleaseCutArgs(REQUIRED, {}).publisherArgs).toEqual([]);
      expect(parseWorkspaceHostReleaseCutArgs(REQUIRED, { PAPERCUSP_CUPBOARD_URL: '   ' }).publisherArgs).toEqual([]);
      expect(cupboardBaseOverride({ PAPERCUSP_CUPBOARD_URL: '/' })).toBeUndefined();
    });
  });
});

describe('step failure lines (EI-24283123732250788)', () => {
  it('names a disk-preflight refusal as a disk shortage and says how to resume', () => {
    const line = describeStepExit('bash', DISK_PREFLIGHT_REFUSAL_EXIT_CODE, '/w/logs/sidecar-build.log');
    expect(line).toContain('bash exited 28 (log: /w/logs/sidecar-build.log)');
    expect(line).toMatch(/disk preflight refused for lack of free space/);
    expect(line).toMatch(/same --work-dir to resume/);
  });

  it('leaves every other exit status as the bare exit line', () => {
    expect(describeStepExit('bash', 1, '/w/logs/x.log')).toBe('bash exited 1 (log: /w/logs/x.log)');
    expect(describeStepExit('node', null)).toBe('node exited by signal');
    expect(describeStepExit('bash', 2)).not.toMatch(/disk/);
  });

  it('matches the exit status the shared shell disk preflight actually returns on refusal', () => {
    const preflight = readFileSync(
      new URL('../../../../papercusp-desktop/bin/lib/disk-preflight.sh', import.meta.url),
      'utf8',
    );
    const refusals = [...preflight.matchAll(/^\s*return (\d+)\b.*$/gm)]
      .map((match) => Number(match[1]))
      .filter((code) => code !== 0 && code !== 1);
    expect(refusals.length).toBeGreaterThan(0);
    expect(new Set(refusals)).toEqual(new Set([DISK_PREFLIGHT_REFUSAL_EXIT_CODE]));
  });
});

describe('doc-vector seed in the hosted bundle (WI-10004899)', () => {
  let sidecar: string;
  beforeEach(() => {
    sidecar = mkdtempSync(join(tmpdir(), 'wh-seed-'));
  });
  afterEach(() => {
    rmSync(sidecar, { recursive: true, force: true });
  });
  const seedDir = () => join(sidecar, WORKSPACE_HOST_DOC_VECTOR_SEED_DIR);
  const writeSeed = (dir: string, marker: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ marker }));
  };
  const outOf = (args: readonly string[]) => args[args.indexOf('--out') + 1] as string;

  it('exports into <sidecar>/doc-vector-seed, the dir the hosted unit points PAPERCUSP_DOC_VECTOR_SEED_DIR at', async () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const outcome = await cutDocVectorSeed({
      sidecarDir: sidecar,
      repoRoot: '/repo',
      logFile: join(sidecar, 'seed.log'),
      exporter: async (args, { cwd }) => {
        calls.push({ args, cwd });
        writeSeed(outOf(args), 'new');
      },
    });
    expect(outcome).toBe('exported');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/repo');
    expect(calls[0]!.args.slice(0, 2)).toEqual(['tsx', 'scripts/export-doc-vector-seed.mts']);
    expect(calls[0]!.args).toContain('--allow-uncovered');
    expect(calls[0]!.args).not.toContain('--previous');
    expect(JSON.parse(readFileSync(join(seedDir(), 'manifest.json'), 'utf8'))).toEqual({ marker: 'new' });
    expect(existsSync(`${seedDir()}.new`)).toBe(false);
  });

  it('applies the previous seed first and replaces it only once the new one is written', async () => {
    writeSeed(seedDir(), 'old');
    let previousAtExport: string | null = null;
    const outcome = await cutDocVectorSeed({
      sidecarDir: sidecar,
      repoRoot: '/repo',
      logFile: join(sidecar, 'seed.log'),
      exporter: async (args) => {
        const previous = args[args.indexOf('--previous') + 1] as string;
        previousAtExport = JSON.parse(readFileSync(join(previous, 'manifest.json'), 'utf8')).marker;
        writeSeed(outOf(args), 'new');
      },
    });
    expect(outcome).toBe('exported');
    expect(previousAtExport).toBe('old');
    expect(JSON.parse(readFileSync(join(seedDir(), 'manifest.json'), 'utf8'))).toEqual({ marker: 'new' });
  });

  it('never fails the cut: a failed export keeps the previous seed and warns', async () => {
    writeSeed(seedDir(), 'old');
    const warnings: string[] = [];
    const outcome = await cutDocVectorSeed({
      sidecarDir: sidecar,
      repoRoot: '/repo',
      logFile: join(sidecar, 'seed.log'),
      warn: (message) => warnings.push(message),
      exporter: async (args) => {
        writeSeed(outOf(args), 'partial');
        throw new Error('npx exited 1');
      },
    });
    expect(outcome).toBe('kept-previous');
    expect(JSON.parse(readFileSync(join(seedDir(), 'manifest.json'), 'utf8'))).toEqual({ marker: 'old' });
    expect(existsSync(`${seedDir()}.new`)).toBe(false);
    expect(warnings.join('\n')).toMatch(/doc-vector-seed export failed .*previous cut's doc-vector seed/);
  });

  it('ships no seed when the exporter exits 0 without a manifest, and when skipped', async () => {
    const empty = await cutDocVectorSeed({
      sidecarDir: sidecar,
      repoRoot: '/repo',
      logFile: join(sidecar, 'seed.log'),
      warn: () => {},
      exporter: async (args) => {
        mkdirSync(outOf(args), { recursive: true });
      },
    });
    expect(empty).toBe('none');
    expect(existsSync(seedDir())).toBe(false);
    let ran = false;
    const skipped = await cutDocVectorSeed({
      sidecarDir: sidecar,
      repoRoot: '/repo',
      logFile: join(sidecar, 'seed.log'),
      skip: true,
      exporter: async () => {
        ran = true;
      },
    });
    expect(skipped).toBe('skipped');
    expect(ran).toBe(false);
  });
});
