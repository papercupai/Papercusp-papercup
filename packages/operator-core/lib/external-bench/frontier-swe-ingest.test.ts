import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FrontierSweIngestError,
  gitTaskHistory,
  type FrontierSweTaskHistory,
  frontierSweArtifactsOf,
  frontierSweExternalNeeds,
  parseFrontierSweReadmeCategories,
  earliestExposure,
  imageDigestOf,
  ingestFrontierSweCorpus,
  labelV1History,
  networkAllowsInternet,
  parseFrontierSweJsonl,
  readCheckoutHead,
  type FrontierSweIngestFs,
} from './frontier-swe-ingest';
import type { FrontierSweTaskRow } from './task-sets';

const COMMIT = 'da83f84f8fbcec3cbf0f2b17c98ebc811355c2df';
const AGENT_DIGEST = 'sha256:' + 'a'.repeat(64);
const VERIFIER_DIGEST = 'sha256:' + 'b'.repeat(64);
const REGISTRY = 'us-west1-docker.pkg.dev/proximal-core-0/proximal-evals-public';

/** A v2 (Harbor schema 1.3) task.toml in the shape observed upstream at the pinned commit (plan D-002). */
function v2TaskToml(
  name: string,
  opts: { agentImage?: string; verifierImage?: string; verifierNetworkMode?: string } = {},
): string {
  return [
    'schema_version = "1.3"',
    '[task]',
    `name = "proximal-evals/${name}"`,
    'keywords = ["astrometry", "wcs"]',
    '[metadata]',
    'difficulty = "frontier"',
    'category = "scientific-software-engineering"',
    '[agent]',
    'timeout_sec = 72000.0',
    '[verifier]',
    'timeout_sec = 10800.0',
    'environment_mode = "separate"',
    '[verifier.environment]',
    `docker_image = "${opts.verifierImage ?? `${REGISTRY}/${name}@${VERIFIER_DIGEST}`}"`,
    ...(opts.verifierNetworkMode ? [`network_mode = "${opts.verifierNetworkMode}"`] : []),
    'cpus = 16',
    '[environment]',
    `docker_image = "${opts.agentImage ?? `${REGISTRY}/${name}@${AGENT_DIGEST}`}"`,
    'network_mode = "allowlist"',
    'cpus = 16',
    'memory_mb = 131072',
    'storage_mb = 524288',
    'gpus = 0',
  ].join('\n');
}

/** In-memory checkout: path → file contents. Directories are implied by file paths. */
function memFs(files: Record<string, string>): FrontierSweIngestFs {
  const children = (dir: string, wantDirs: boolean) => {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    const out = new Set<string>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length).split('/');
      if (wantDirs && rest.length > 1) out.add(rest[0]!);
      if (!wantDirs && rest.length === 1) out.add(rest[0]!);
    }
    return [...out];
  };
  return {
    listDirs: async (dir) => children(dir, true),
    listFiles: async (dir) => children(dir, false),
    readText: async (path) => files[path] ?? null,
    exists: async (path) => path in files || Object.keys(files).some((p) => p.startsWith(path + '/')),
  };
}

const ROOT = '/vendor/frontier-swe-v2';
const t = (task: string, file: string) => join(ROOT, 'tasks', task, file);

describe('ingestFrontierSweCorpus (P-002 / FSWE-P002-MANIFEST)', () => {
  it('records the pinned commit and both image digests on every task entry and row', async () => {
    const fs = memFs({
      [join(ROOT, 'README.md')]: '# v2',
      [t('astronomy-toolkit', 'task.toml')]: v2TaskToml('astronomy-toolkit'),
      [t('astronomy-toolkit', 'instruction.md')]: 'Build an astrometry toolkit.',
      [t('astronomy-toolkit', 'solution/solve.sh')]: '#!/bin/bash',
      [t('git-to-zig', 'task.toml')]: v2TaskToml('git-to-zig', { verifierNetworkMode: 'no-network' }),
      [t('git-to-zig', 'instruction.md')]: 'Port git to Zig.',
      // The job.yaml runtime profile shape observed upstream (reconnaissance-blind-chess-recovery, D-002 §5).
      [t('git-to-zig', 'job.yaml')]: [
        'environment:',
        '  type: modal',
        '  kwargs:',
        '    modal_vm_runtime: true',
        '    registry_secret: px-evals-gcr-secret',
      ].join('\n'),
    });
    const { rows, manifest } = await ingestFrontierSweCorpus(
      { root: ROOT, commitSha: COMMIT, now: new Date('2026-10-10T00:00:00Z') },
      fs,
    );

    expect(manifest.commitSha).toBe(COMMIT);
    expect(manifest.upstreamRepo).toBe('Proximal-Labs/frontier-swe-v2');
    expect(manifest.taskCount).toBe(2);
    expect(manifest.tasks.map((x) => x.instanceId)).toEqual(['astronomy-toolkit', 'git-to-zig']);
    for (const task of manifest.tasks) {
      expect(task.commitSha).toBe(COMMIT);
      expect(task.agentImageDigest).toBe(AGENT_DIGEST);
      expect(task.verifierImageDigest).toBe(VERIFIER_DIGEST);
    }
    expect(manifest.licenseStatus).toBe('none');
    for (const row of rows) {
      expect(row.corpusVersion).toBe('v2');
      expect(row.upstreamCommit).toBe(COMMIT);
      expect(row.retiredInV2).toBe(false);
    }

    const zig = rows.find((r) => r.instanceId === 'git-to-zig')!;
    expect(zig.verifierNetworkMode).toBe('no-network');
    expect(zig.externalNeeds).toEqual(['runtime:modal', 'modal-vm-runtime', 'registry-secret:px-evals-gcr-secret']);
    expect(rows.find((r) => r.instanceId === 'astronomy-toolkit')!.externalNeeds).toEqual([]);

    const astro = rows.find((r) => r.instanceId === 'astronomy-toolkit')!;
    expect(astro.prompt).toBe('Build an astrometry toolkit.');
    expect(astro.dockerImage).toBe(`${REGISTRY}/astronomy-toolkit@${AGENT_DIGEST}`);
    expect(astro.verifierDockerImage).toBe(`${REGISTRY}/astronomy-toolkit@${VERIFIER_DIGEST}`);
    expect(astro.agentTimeoutSec).toBe(72000);
    expect(astro.verifierTimeoutSec).toBe(10800);
    expect(astro.networkMode).toBe('allowlist');
    expect(astro.allowInternet).toBe(true);
    expect(astro.tags).toEqual(['astrometry', 'wcs']);
    expect(astro.solutionCmd).toBe('bash /solution/solve.sh');
    expect(rows.find((r) => r.instanceId === 'git-to-zig')!.solutionCmd).toBeNull();
  });

  it('refuses the corpus when a task image can float, naming every offending task', async () => {
    const fs = memFs({
      [t('floating-agent', 'task.toml')]: v2TaskToml('floating-agent', { agentImage: `${REGISTRY}/floating-agent:v2` }),
      [t('floating-verifier', 'task.toml')]: v2TaskToml('floating-verifier', {
        verifierImage: `${REGISTRY}/floating-verifier:latest`,
      }),
      [t('pinned', 'task.toml')]: v2TaskToml('pinned'),
    });
    const err = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrontierSweIngestError);
    const problems = (err as FrontierSweIngestError).problems;
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^floating-agent: agent image is not digest-pinned/);
    expect(problems[1]).toMatch(/^floating-verifier: verifier image is not digest-pinned/);
  });

  it('refuses a commit that is not a full 40-hex SHA', async () => {
    const fs = memFs({ [t('pinned', 'task.toml')]: v2TaskToml('pinned') });
    await expect(ingestFrontierSweCorpus({ root: ROOT, commitSha: 'main' }, fs)).rejects.toThrow(
      FrontierSweIngestError,
    );
  });

  it('refuses an empty checkout rather than writing an empty corpus', async () => {
    await expect(ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, memFs({}))).rejects.toThrow(
      /problem/,
    );
  });

  it('refuses a task whose job.yaml runtime profile does not parse', async () => {
    const fs = memFs({
      [t('pinned', 'task.toml')]: v2TaskToml('pinned'),
      [t('pinned', 'job.yaml')]: 'environment:\n  kwargs: [unclosed',
    });
    const err = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs).catch((e: unknown) => e);
    expect((err as FrontierSweIngestError).problems).toEqual([expect.stringMatching(/^pinned: job\.yaml does not parse/)]);
  });

  it('reports a LICENSE file at the checkout root', async () => {
    const fs = memFs({ [join(ROOT, 'LICENSE')]: 'MIT', [t('pinned', 'task.toml')]: v2TaskToml('pinned') });
    const { manifest } = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs);
    expect(manifest.licenseStatus).toBe('present');
    expect(manifest.licenseFile).toBe('LICENSE');
  });

  // D-007 / WI-6554700010008413: the contamination policy needs each task's creation date.
  it("records each task's history-derived creation date, and none without a history seam", async () => {
    const fs = memFs({ [t('dated', 'task.toml')]: v2TaskToml('dated'), [t('undated', 'task.toml')]: v2TaskToml('undated') });
    const asked: Array<[string, string]> = [];
    const history: FrontierSweTaskHistory = {
      async firstAddedAt(relPath, commitSha) {
        asked.push([relPath, commitSha]);
        return relPath === 'tasks/dated/task.toml' ? '2026-09-03T12:00:00+00:00' : null;
      },
    };
    const withHistory = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT, history }, fs);
    expect(asked).toEqual([['tasks/dated/task.toml', COMMIT], ['tasks/undated/task.toml', COMMIT]]);
    expect(Object.fromEntries(withHistory.rows.map((r) => [r.instanceId, r.taskCreatedAt]))).toEqual({
      dated: '2026-09-03T12:00:00+00:00', undated: undefined,
    });
    const without = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs);
    expect(without.rows.every((r) => !('taskCreatedAt' in r))).toBe(true);
  });

  it('dates a task carried over from v1 by its v1 first-add, and leaves it undated when v1 cannot say (WI-6554700010008471)', async () => {
    // v2 added every task in one later commit; that date must never stand in for a carried-over task's exposure.
    const V2_SCAFFOLD = '2026-09-02T17:59:58+00:00';
    const V1_COMMIT = 'b'.repeat(40);
    const fs = memFs({
      [t('carried', 'task.toml')]: v2TaskToml('carried'),
      [t('carried-v1-undated', 'task.toml')]: v2TaskToml('carried-v1-undated'),
      [t('v2-only', 'task.toml')]: v2TaskToml('v2-only'),
    });
    const v2History: FrontierSweTaskHistory = { firstAddedAt: async () => V2_SCAFFOLD };
    const askedV1: Array<[string, string]> = [];
    const v1History: FrontierSweTaskHistory = {
      async firstAddedAt(relPath, commitSha) {
        askedV1.push([relPath, commitSha]);
        return relPath === 'tasks/carried/task.toml' ? '2026-05-20T09:00:00+00:00' : null;
      },
    };
    const instanceIds = ['carried', 'carried-v1-undated', 'retired-in-v2'];
    const dates = async (priorVersion: Parameters<typeof ingestFrontierSweCorpus>[0]['priorVersion']) =>
      Object.fromEntries((await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT, history: v2History, priorVersion }, fs))
        .rows.map((r) => [r.instanceId, r.taskCreatedAt]));

    expect(await dates({ instanceIds, history: v1History, commitSha: V1_COMMIT })).toEqual({
      carried: '2026-05-20T09:00:00+00:00', 'carried-v1-undated': undefined, 'v2-only': V2_SCAFFOLD,
    });
    expect(askedV1).toEqual([['tasks/carried/task.toml', V1_COMMIT], ['tasks/carried-v1-undated/task.toml', V1_COMMIT]]);
    // Knowing WHICH ids v1 published but not WHEN is still enough to withhold the misleading v2 date.
    expect(await dates({ instanceIds })).toEqual({ carried: undefined, 'carried-v1-undated': undefined, 'v2-only': V2_SCAFFOLD });
    // Control: without the prior version every row keeps its own (v2) date, which is the defect this input exists for.
    expect(await dates(undefined)).toEqual({ carried: V2_SCAFFOLD, 'carried-v1-undated': V2_SCAFFOLD, 'v2-only': V2_SCAFFOLD });
  });

  it('refuses a priorVersion commit that is not a full 40-hex SHA', async () => {
    const fs = memFs({ [t('carried', 'task.toml')]: v2TaskToml('carried') });
    const err = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT, priorVersion: { instanceIds: ['carried'], commitSha: 'main' } }, fs)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FrontierSweIngestError);
    expect((err as FrontierSweIngestError).problems).toEqual(["priorVersion.commitSha must be a full 40-hex commit, got 'main'"]);
  });
});

describe('earliestExposure', () => {
  it('takes the earlier date, and refuses to date a task whose prior-version date is unknown or unparseable', () => {
    expect(earliestExposure('2026-05-20T09:00:00+00:00', '2026-09-02T17:59:58+00:00')).toBe('2026-05-20T09:00:00+00:00');
    expect(earliestExposure('2026-09-02T17:59:58+00:00', '2026-05-20T09:00:00+00:00')).toBe('2026-05-20T09:00:00+00:00');
    expect(earliestExposure('2026-05-20T09:00:00+00:00', null)).toBe('2026-05-20T09:00:00+00:00');
    expect(earliestExposure(null, '2026-09-02T17:59:58+00:00')).toBeNull();
    expect(earliestExposure('not-a-date', '2026-09-02T17:59:58+00:00')).toBeNull();
  });
});

describe('gitTaskHistory (real git)', () => {
  function repoWithTwoTasks(): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fswe-history-'));
    const g = (args: string[], date?: string) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 'test@example.invalid']);
    g(['config', 'user.name', 'test']);
    const add = (task: string, date: string) => {
      mkdirSync(join(dir, 'tasks', task), { recursive: true });
      writeFileSync(join(dir, 'tasks', task, 'task.toml'), `name = "${task}"\n`);
      g(['add', '-A']);
      g(['commit', '-q', '-m', `add ${task}`], date);
    };
    add('old-task', '2025-01-15T10:00:00+00:00');
    add('new-task', '2026-09-03T12:00:00+00:00');
    writeFileSync(join(dir, 'tasks', 'old-task', 'task.toml'), 'name = "old-task"\nedited = true\n');
    g(['commit', '-q', '-am', 'edit old-task'], '2026-09-19T08:00:00+00:00');
    return { dir, head: g(['rev-parse', 'HEAD']) };
  }

  it('dates each task by the commit that first added it, not by a later edit or the pin', async () => {
    const { dir, head } = repoWithTwoTasks();
    try {
      const h = gitTaskHistory(dir);
      expect(await h.firstAddedAt('tasks/old-task/task.toml', head)).toBe('2025-01-15T10:00:00+00:00');
      expect(await h.firstAddedAt('tasks/new-task/task.toml', head)).toBe('2026-09-03T12:00:00+00:00');
      expect(await h.firstAddedAt('tasks/never-added/task.toml', head)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a shallow clone instead of dating every task at the truncation point', async () => {
    const { dir, head } = repoWithTwoTasks();
    const shallow = mkdtempSync(join(tmpdir(), 'fswe-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      // Calibration: the shallow clone really does expose old-task with the pin's date, which is the trap.
      expect(execFileSync('git', ['-C', shallow, 'log', '--format=%cI', '--', 'tasks/old-task/task.toml'], { encoding: 'utf8' }).trim())
        .toBe('2026-09-19T08:00:00+00:00');
      expect(await gitTaskHistory(shallow).firstAddedAt('tasks/old-task/task.toml', head)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe('readCheckoutHead', () => {
  it('reads a detached HEAD, a loose ref, and a packed ref without a git subprocess', async () => {
    expect(await readCheckoutHead(ROOT, memFs({ [join(ROOT, '.git/HEAD')]: COMMIT + '\n' }))).toBe(COMMIT);
    const loose = memFs({
      [join(ROOT, '.git/HEAD')]: 'ref: refs/heads/main\n',
      [join(ROOT, '.git/refs/heads/main')]: COMMIT + '\n',
    });
    expect(await readCheckoutHead(ROOT, loose)).toBe(COMMIT);
    const packed = memFs({
      [join(ROOT, '.git/HEAD')]: 'ref: refs/heads/main\n',
      [join(ROOT, '.git/packed-refs')]: `# pack-refs with: peeled\n${COMMIT} refs/heads/main\n`,
    });
    expect(await readCheckoutHead(ROOT, packed)).toBe(COMMIT);
    expect(await readCheckoutHead(ROOT, memFs({}))).toBeNull();
  });
});

describe('networkAllowsInternet', () => {
  it("treats v2's 'no-network' and v1's 'none' as offline and 'allowlist' as online", () => {
    expect(networkAllowsInternet('no-network')).toBe(false);
    expect(networkAllowsInternet('none')).toBe(false);
    expect(networkAllowsInternet(undefined)).toBe(false);
    expect(networkAllowsInternet('allowlist')).toBe(true);
  });
});

describe('frontierSweExternalNeeds', () => {
  it('reads the Modal VM runtime flag alone (the cranelift-codegen-opt shape) and returns [] without a profile', () => {
    expect(frontierSweExternalNeeds('environment:\n  kwargs:\n    modal_vm_runtime: true\n')).toEqual(['modal-vm-runtime']);
    expect(frontierSweExternalNeeds(null)).toEqual([]);
  });
});

describe('labelV1History', () => {
  const row = (instanceId: string): FrontierSweTaskRow => ({
    instanceId,
    prompt: '',
    dockerImage: `ghcr.io/proximal-labs/frontier-swe/${instanceId}:v1`,
    verifierCmd: 'bash /tests/test.sh',
    rewardPath: '/logs/verifier/reward.txt',
  });

  it('labels every v1 row v1 and flags exact ids missing from v2 as retired, renames included', () => {
    const v1 = [row('git-to-zig'), row('dart-style-haskell')];
    const v2 = [row('git-to-zig'), row('dart-style-in-haskell')];
    const history = labelV1History(v1, v2);
    expect(history.map((r) => [r.instanceId, r.corpusVersion, r.retiredInV2])).toEqual([
      ['git-to-zig', 'v1', false],
      ['dart-style-haskell', 'v1', true],
    ]);
  });

  it('round-trips through the JSONL parser', () => {
    const text = [row('a'), row('b')].map((r) => JSON.stringify(r)).join('\n') + '\n\n';
    expect(parseFrontierSweJsonl(text).map((r) => r.instanceId)).toEqual(['a', 'b']);
  });
});

describe('imageDigestOf', () => {
  it('extracts a sha256 digest and rejects tag-only references', () => {
    expect(imageDigestOf(`${REGISTRY}/x@${AGENT_DIGEST}`)).toBe(AGENT_DIGEST);
    expect(imageDigestOf('ghcr.io/proximal-labs/frontier-swe/x:v1')).toBeNull();
    expect(imageDigestOf(undefined)).toBeNull();
  });
});

describe('v2 grading contract fields (plan D-003, P-003)', () => {
  /** A task.toml carrying the artifacts + [verifier.env] tables observed upstream (astronomy-toolkit). */
  const contractToml = (name: string) =>
    [
      'schema_version = "1.3"',
      'artifacts = [',
      '  { source = "/app/", exclude = ["**/__pycache__/**", "**/.venv/**"] },',
      ']',
      v2TaskToml(name).replace('schema_version = "1.3"\n', '').replace(
        '[verifier.environment]',
        '[verifier.env]\nASTROMETRY_NUM_THREADS = "16"\nSEED = 20260811\n[verifier.environment]',
      ),
    ].join('\n');
  const readme = (rows: string[]) =>
    ['# FrontierSWE v2', '', '| # | Task | Category |', '|---|---|---|', ...rows].join('\n');

  it('records separate-verifier mode, verifier env, artifacts and README suite categories', async () => {
    const fs = memFs({
      [join(ROOT, 'README.md')]: readme([
        '| 01 | [Astronomy Toolkit](tasks/astronomy-toolkit/) | Visual Reasoning, Implementation |',
        '| 02 | [Git to Zig](tasks/git-to-zig/) | Implementation |',
      ]),
      [t('astronomy-toolkit', 'task.toml')]: contractToml('astronomy-toolkit'),
      [t('git-to-zig', 'task.toml')]: v2TaskToml('git-to-zig'),
    });
    const { rows } = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs);
    const astro = rows.find((r) => r.instanceId === 'astronomy-toolkit')!;
    expect(astro.verifierEnvironmentMode).toBe('separate');
    expect(astro.verifierEnv).toEqual({ ASTROMETRY_NUM_THREADS: '16', SEED: '20260811' });
    expect(astro.artifacts).toEqual([{ source: '/app/', exclude: ['**/__pycache__/**', '**/.venv/**'] }]);
    expect(astro.suiteCategories).toEqual(['Visual Reasoning', 'Implementation']);
    const zig = rows.find((r) => r.instanceId === 'git-to-zig')!;
    expect(zig.artifacts).toEqual([]);
    expect(zig.suiteCategories).toEqual(['Implementation']);
  });

  it("records the separate verifier's OWN gpus/gpu_types from [verifier.environment], independent of the agent's", async () => {
    // The multi-gpu-efficient-finetuning shape at the pinned commit: agent 2×T4, verifier 4×H100.
    const multi = v2TaskToml('multi-gpu-efficient-finetuning')
      .replace('[verifier.environment]', '[verifier.environment]\ngpus = 4\ngpu_types = ["H100"]')
      .replace('gpus = 0', 'gpus = 2\ngpu_types = ["T4"]');
    const fs = memFs({
      [t('multi-gpu-efficient-finetuning', 'task.toml')]: multi,
      [t('git-to-zig', 'task.toml')]: v2TaskToml('git-to-zig'),
    });
    const { rows } = await ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs);
    const m = rows.find((r) => r.instanceId === 'multi-gpu-efficient-finetuning')!;
    expect({ gpus: m.gpus, gpuTypes: m.gpuTypes }).toEqual({ gpus: 2, gpuTypes: ['T4'] });
    expect({ verifierGpus: m.verifierGpus, verifierGpuTypes: m.verifierGpuTypes }).toEqual({ verifierGpus: 4, verifierGpuTypes: ['H100'] });
    const zig = rows.find((r) => r.instanceId === 'git-to-zig')!;
    expect({ verifierGpus: zig.verifierGpus, verifierGpuTypes: zig.verifierGpuTypes }).toEqual({ verifierGpus: 0, verifierGpuTypes: [] });
  });

  it('refuses a task missing from a README that has a task table', async () => {
    const fs = memFs({
      [join(ROOT, 'README.md')]: readme(['| 01 | [Git to Zig](tasks/git-to-zig/) | Implementation |']),
      [t('git-to-zig', 'task.toml')]: v2TaskToml('git-to-zig'),
      [t('orphan', 'task.toml')]: v2TaskToml('orphan'),
    });
    await expect(ingestFrontierSweCorpus({ root: ROOT, commitSha: COMMIT }, fs)).rejects.toMatchObject({
      problems: ['orphan: missing from the README task table (no suite category)'],
    });
  });

  it('parses README categories and refuses an unknown category', () => {
    expect(
      parseFrontierSweReadmeCategories(readme(['| 07 | [X](tasks/x/) | Scientific Computing, AI Research |'])),
    ).toEqual(new Map([['x', ['Scientific Computing', 'AI Research']]]));
    expect(parseFrontierSweReadmeCategories('# no table')).toEqual(new Map());
    expect(() => parseFrontierSweReadmeCategories(readme(['| 01 | [X](tasks/x/) | Robotics |']))).toThrow(
      /unknown suite category: Robotics/,
    );
  });

  it('normalizes string and table artifacts and rejects a sourceless entry', () => {
    expect(frontierSweArtifactsOf(['/out/', { source: '/app/', exclude: ['*.tmp'] }])).toEqual([
      { source: '/out/', exclude: [] },
      { source: '/app/', exclude: ['*.tmp'] },
    ]);
    expect(frontierSweArtifactsOf(undefined)).toEqual([]);
    expect(() => frontierSweArtifactsOf([{ exclude: [] }])).toThrow(/artifacts\[0\] has no string source/);
  });
});
