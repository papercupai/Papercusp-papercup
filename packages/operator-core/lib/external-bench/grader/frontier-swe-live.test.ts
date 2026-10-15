import { describe, it, expect } from 'vitest';
import type { BenchTask } from '../types';
import type { ProcExec } from './swe-bench-pro';
import {
  resolveFrontierSweConfigFromEnv,
  liveBuildVerifierCommand,
  liveReadReward,
  livePrepareSeparateVerifier,
  verifierGpuCountOf,
  copyFrontierSweArtifact,
  preflightFrontierSwe,
  describeFrontierSweRun,
} from './frontier-swe-live';
import { makeFrontierSweGrader } from './frontier-swe';

const task = (overrides: Record<string, unknown> = {}): BenchTask => ({
  benchmark: 'frontier-swe',
  instanceId: 'cranelift-codegen-opt',
  problemStatement: 'x',
  graderMeta: { verifierCmd: 'bash /tests/test.sh', rewardPath: '/logs/verifier/reward.txt', rewardJsonPath: '/logs/verifier/reward.json', ...overrides },
});

const V2_IMAGE = `us-docker.pkg.dev/proximal-evals-public/astronomy-toolkit@sha256:${'2'.repeat(64)}`;
const v2Task = (overrides: Record<string, unknown> = {}): BenchTask =>
  task({
    corpusVersion: 'v2',
    upstreamCommit: 'da83f84f8fbcec3cbf0f2b17c98ebc811355c2df',
    verifierEnvironmentMode: 'separate',
    verifierDockerImage: V2_IMAGE,
    verifierEnv: { ASTROMETRY_NUM_THREADS: '16' },
    artifacts: [{ source: '/app/', exclude: ['**/.git/**', '**/*.tmp'] }],
    ...overrides,
  });

/**
 * A fake docker with two containers: the arm (`arm`) and whatever `docker run` starts (`v`). `files` maps
 * `<container>:<path>` → content; a path with children counts as a directory. Records every call.
 */
function fakeDocker(files: Record<string, string>, opts: { failOn?: (args: string[]) => boolean } = {}) {
  const calls: string[][] = [];
  const has = (ref: string, p: string) => `${ref}:${p}` in files;
  const isDir = (ref: string, p: string) => Object.keys(files).some((k) => k.startsWith(`${ref}:${p.replace(/\/+$/, '')}/`));
  const exec: ProcExec = async (_cmd, args) => {
    calls.push(args);
    if (opts.failOn?.(args)) return { stdout: '', stderr: 'injected failure', code: 125 };
    if (args[0] === 'run') return { stdout: 'started\n', stderr: '', code: 0 };
    if (args[0] === 'exec') {
      const i = args.findIndex((a, idx) => idx > 0 && !a.startsWith('-') && !args[idx - 1]?.startsWith('-'));
      const ref = args[i];
      const rest = args.slice(i + 1);
      if (rest[0] === 'test') return { stdout: '', stderr: '', code: (rest[1] === '-d' ? isDir(ref, rest[2]) : has(ref, rest[2]) || isDir(ref, rest[2])) ? 0 : 1 };
      if (rest[0] === 'cat') return has(ref, rest[1]) ? { stdout: files[`${ref}:${rest[1]}`], stderr: '', code: 0 } : { stdout: '', stderr: 'no file', code: 1 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls };
}

describe('resolveFrontierSweConfigFromEnv', () => {
  it('needs NO v1 pin to build (v2 tasks pin themselves); the pin is carried when present', () => {
    const bare = resolveFrontierSweConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(bare.version).toBeUndefined();
    expect(typeof bare.prepareVerifierEnv).toBe('function');
    const cfg = resolveFrontierSweConfigFromEnv({ PAPERCUSP_FRONTIER_SWE_VERSION: 'fs@sha' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.version).toBe('fs@sha');
    expect(typeof cfg.buildVerifierCommand).toBe('function');
    expect(typeof cfg.readReward).toBe('function');
  });
});

describe('liveBuildVerifierCommand', () => {
  it('v1: docker-execs the task verifier in the arm container; oracle mode sets HARBOR_ORACLE_MODE', () => {
    const normal = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'cid', verifierRef: 'cid', task: task() });
    expect(normal.cmd).toBe('docker');
    expect(normal.args).toEqual(['exec', 'cid', 'bash', '-lc', 'bash /tests/test.sh']);
    const oracle = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'cid', verifierRef: 'cid', task: task(), oracle: true });
    expect(oracle.args).toContain('HARBOR_ORACLE_MODE=1');
  });

  it('falls back to the default verifier cmd when the task carries none', () => {
    const r = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'cid', verifierRef: 'cid' });
    expect(r.args).toContain('bash /tests/test.sh');
  });

  it('v2: runs in the VERIFIER container as root with [verifier.env], creating /logs/verifier first', () => {
    const r = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'arm', verifierRef: 'v', task: v2Task() });
    expect(r.args).toEqual([
      'exec', '--user', 'root', '-e', 'ASTROMETRY_NUM_THREADS=16', 'v', 'bash', '-lc', 'mkdir -p /logs/verifier && bash /tests/test.sh',
    ]);
  });

  it('v2 oracle: passes the per-run HARBOR_ORACLE_FLAG to the verifier (the v2 verifier checks the /app marker against it)', () => {
    const r = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'arm', verifierRef: 'v', task: v2Task(), oracle: true, oracleFlag: 'f00d' });
    expect(r.args).toContain('HARBOR_ORACLE_FLAG=f00d');
    expect(r.args).toContain('HARBOR_ORACLE_MODE=1');
    // the env flags precede the container ref (docker exec option order)
    expect(r.args.indexOf('HARBOR_ORACLE_FLAG=f00d')).toBeLessThan(r.args.indexOf('v'));
  });

  it('v2 oracle without a flag is REFUSED (it would be scored as an ordinary candidate); non-oracle never carries one', () => {
    expect(() => liveBuildVerifierCommand({ instanceId: 'i', envRef: 'arm', verifierRef: 'v', task: v2Task(), oracle: true })).toThrow(/oracleFlag/);
    const normal = liveBuildVerifierCommand({ instanceId: 'i', envRef: 'arm', verifierRef: 'v', task: v2Task(), oracleFlag: 'f00d' });
    expect(normal.args.join(' ')).not.toContain('HARBOR_ORACLE');
  });

  it('v2: refuses to verify inside the arm container, and refuses an unresolvable ${…} env template', () => {
    expect(() => liveBuildVerifierCommand({ instanceId: 'i', envRef: 'arm', verifierRef: 'arm', task: v2Task() })).toThrow(/inside the arm/);
    expect(() =>
      liveBuildVerifierCommand({ instanceId: 'i', envRef: 'arm', verifierRef: 'v', task: v2Task({ verifierEnv: { KEY: '${OPENAI_API_KEY}' } }) }),
    ).toThrow(/host-env template/);
  });
});

describe('liveReadReward', () => {
  it('reads reward.txt as the bare scalar (v1 pair) and the raw files', async () => {
    const { exec } = fakeDocker({ 'cid:/logs/verifier/reward.txt': '0.4200\n' });
    const r = await liveReadReward({ instanceId: 'i', envRef: 'cid', verifierRef: 'cid', task: task(), readFile: async () => '', exec });
    expect(r.rewardScalar).toBe(0.42);
    expect(r.files).toEqual({ json: null, txt: '0.4200\n' });
  });

  it('parses reward.json when present', async () => {
    const { exec } = fakeDocker({
      'cid:/logs/verifier/reward.txt': '0.5',
      'cid:/logs/verifier/reward.json': '{"reward":0.5,"breakdown":{"speedup":1.4}}',
    });
    const r = await liveReadReward({ instanceId: 'i', envRef: 'cid', verifierRef: 'cid', task: task(), readFile: async () => '', exec });
    expect(r.rewardScalar).toBe(0.5);
    expect((r.rewardJson as { reward: number }).reward).toBe(0.5);
  });

  it('distinguishes an ABSENT file (null) from an EMPTY one ("") — Harbor precedence needs both', async () => {
    const { exec } = fakeDocker({ 'v:/logs/verifier/reward.json': '' });
    const r = await liveReadReward({ instanceId: 'i', envRef: 'arm', verifierRef: 'v', task: v2Task(), readFile: async () => '', exec });
    expect(r.files).toEqual({ json: '', txt: null });
    expect(r.rewardScalar).toBeNull();
  });

  it('reads from verifierRef, never from the arm container', async () => {
    const { exec, calls } = fakeDocker({ 'v:/logs/verifier/reward.json': '{"reward":0.3}', 'arm:/logs/verifier/reward.json': '{"reward":1}' });
    const r = await liveReadReward({ instanceId: 'i', envRef: 'arm', verifierRef: 'v', task: v2Task(), readFile: async () => '', exec });
    expect(r.files?.json).toBe('{"reward":0.3}');
    expect(calls.every((c) => !c.includes('arm'))).toBe(true);
  });

  it('a Docker failure (exit other than 0/1) throws instead of reading as "absent"', async () => {
    const { exec } = fakeDocker({}, { failOn: (a) => a.includes('test') });
    await expect(
      liveReadReward({ instanceId: 'i', envRef: 'arm', verifierRef: 'v', task: v2Task(), readFile: async () => '', exec }),
    ).rejects.toThrow(/exit 125/);
  });
});

describe('livePrepareSeparateVerifier (v2, D-003 §1-2)', () => {
  it('starts the digest-pinned verifier image as root and copies /app/ over with its exclude globs', async () => {
    const { exec, calls } = fakeDocker({ 'arm:/app/main.py': 'print(1)' });
    const env = await livePrepareSeparateVerifier({ instanceId: 'astronomy-toolkit', envRef: 'arm', task: v2Task(), exec });
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toEqual(expect.arrayContaining(['-d', '--user', 'root', '--entrypoint', 'sleep', V2_IMAGE, 'infinity']));
    expect(run).not.toContain('--network');
    const v = env.verifierRef;
    expect(v).toMatch(/^pc-fswe-verify-astronomy-toolkit-[0-9a-f]{8}$/);
    const flat = calls.map((c) => c.join(' '));
    const i = (s: string) => flat.findIndex((f) => f.includes(s));
    expect(flat).toContain(`exec arm tar -C /app --exclude=**/.git/** --exclude=**/*.tmp -cf /tmp/pc-fswe-artifact-0.tar .`);
    // The verifier's own /app is EMPTIED before the arm's copy lands (never graded against a baked-in copy).
    expect(i(`exec -w / ${v} rm -rf -- /app`)).toBeGreaterThan(-1);
    expect(i(`exec -w / ${v} rm -rf -- /app`)).toBeLessThan(i(`exec -w / ${v} tar -C /app -xf`));
    await env.release();
    expect(calls.at(-1)).toEqual(['rm', '-f', v]);
  });

  it('no-network verifiers run with --network none', async () => {
    const { exec, calls } = fakeDocker({ 'arm:/app/x': '1' });
    await livePrepareSeparateVerifier({ instanceId: 't', envRef: 'arm', task: v2Task({ verifierNetworkMode: 'no-network' }), exec });
    expect(calls.find((c) => c[0] === 'run')).toEqual(expect.arrayContaining(['--network', 'none']));
  });

  it("GPU verifiers get --gpus <the VERIFIER's count>, not the agent's (multi-gpu-efficient-finetuning: 2×T4 vs 4×H100)", async () => {
    const { exec, calls } = fakeDocker({ 'arm:/app/x': '1' });
    const task = v2Task({ gpus: 2, gpuTypes: ['T4'], verifierGpus: 4, verifierGpuTypes: ['H100'] });
    await livePrepareSeparateVerifier({ instanceId: 'multi-gpu-efficient-finetuning', envRef: 'arm', task, exec });
    const run = calls.find((c) => c[0] === 'run')!;
    const at = run.indexOf('--gpus');
    expect(run[at + 1]).toBe('4');
    expect(run.filter((a) => a === '--gpus')).toHaveLength(1);
    expect(at).toBeLessThan(run.indexOf('--entrypoint'));
  });

  it('a CPU verifier gets no --gpus, even when the agent had GPUs', async () => {
    const { exec, calls } = fakeDocker({ 'arm:/app/x': '1' });
    await livePrepareSeparateVerifier({ instanceId: 't', envRef: 'arm', task: v2Task({ gpus: 1, verifierGpus: 0 }), exec });
    expect(calls.find((c) => c[0] === 'run')).not.toContain('--gpus');
  });

  it('refuses a GPU task whose corpus row predates verifier GPU ingest, before starting any container', async () => {
    const { exec, calls } = fakeDocker({ 'arm:/app/x': '1' });
    await expect(
      livePrepareSeparateVerifier({ instanceId: 'optimizer-design', envRef: 'arm', task: v2Task({ gpus: 1 }), exec }),
    ).rejects.toThrow(/re-run the FrontierSWE v2 ingest/);
    expect(calls.some((c) => c[0] === 'run')).toBe(false);
  });

  it('a GPU-free row with no recorded verifier count still runs (without --gpus)', async () => {
    const { exec, calls } = fakeDocker({ 'arm:/app/x': '1' });
    await livePrepareSeparateVerifier({ instanceId: 't', envRef: 'arm', task: v2Task({ gpus: 0 }), exec });
    expect(calls.find((c) => c[0] === 'run')).not.toContain('--gpus');
    expect(verifierGpuCountOf('t', { verifierGpus: 3 })).toBe(3);
    expect(() => verifierGpuCountOf('t', { verifierGpus: -1 })).toThrow(/invalid verifierGpus/);
  });

  it('refuses a verifier image that is not digest-pinned', async () => {
    const { exec } = fakeDocker({});
    await expect(
      livePrepareSeparateVerifier({ instanceId: 't', envRef: 'arm', task: v2Task({ verifierDockerImage: 'img:latest' }), exec }),
    ).rejects.toThrow(/digest-pinned/);
  });

  it('a failed artifact copy tears the half-built verifier container down before throwing', async () => {
    const { exec, calls } = fakeDocker({ 'arm:/app/x': '1' }, { failOn: (a) => a[0] === 'cp' });
    await expect(livePrepareSeparateVerifier({ instanceId: 't', envRef: 'arm', task: v2Task(), exec })).rejects.toThrow(/copy \/app out of the arm/);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-f']);
  });
});

describe('copyFrontierSweArtifact', () => {
  it('copies a single-FILE artifact as-is (excludes apply to directories only)', async () => {
    const { exec, calls } = fakeDocker({ 'arm:/app/prepare.py': 'x' });
    const kind = await copyFrontierSweArtifact(exec, 'arm', 'v', { source: '/app/prepare.py', exclude: ['**/*.py'] }, '/tmp/h', 0);
    expect(kind).toBe('file');
    expect(calls.map((c) => c.join(' '))).toContain('cp /tmp/h/artifact-0.file v:/app/prepare.py');
    expect(calls.some((c) => c.includes('tar'))).toBe(false);
  });

  it('an artifact absent in the arm leaves the verifier path emptied', async () => {
    const { exec, calls } = fakeDocker({});
    expect(await copyFrontierSweArtifact(exec, 'arm', 'v', { source: '/app/out/', exclude: [] }, '/tmp/h', 1)).toBe('absent');
    expect(calls.map((c) => c.join(' '))).toEqual(expect.arrayContaining(['exec -w / v rm -rf -- /app/out', 'exec -w / v mkdir -p /app/out']));
  });

  it('survives emptying the verifier image WORKDIR: every exec into the verifier runs from / (P-007 regression)', async () => {
    // Model the real failure: once /app (the v2 image WORKDIR) is deleted, a docker exec that does not override
    // its cwd dies before running anything — `chdir to cwd ("/app")`, exit 127.
    const calls: string[][] = [];
    let workdirGone = false;
    const exec: ProcExec = async (_cmd, args) => {
      calls.push(args);
      const ok = { stdout: '', stderr: '', code: 0 };
      if (args[0] !== 'exec') return ok;
      const target = args[args[1] === '-w' ? 3 : 1];
      if (target === 'arm') return args.includes('test') ? { ...ok, code: args.includes('-d') ? 0 : 1 } : ok;
      if (args[1] !== '-w' && workdirGone) {
        return { stdout: 'OCI runtime exec failed: chdir to cwd ("/app") set in config.json failed', stderr: '', code: 127 };
      }
      if (args.includes('rm') && args.includes('/app')) workdirGone = true;
      if (args.includes('mkdir') && args.includes('/app')) workdirGone = false;
      return ok;
    };
    await expect(copyFrontierSweArtifact(exec, 'arm', 'v', { source: '/app/', exclude: [] }, '/tmp/h', 0)).resolves.toBe('directory');
    const verifierExecs = calls.filter((c) => c[0] === 'exec' && c.includes('v'));
    expect(verifierExecs.length).toBeGreaterThan(0);
    for (const c of verifierExecs) expect(c.slice(0, 3)).toEqual(['exec', '-w', '/']);
  });

  it('refuses a root, relative or ..-bearing source (it is rm -rf’d in the verifier)', async () => {
    const { exec } = fakeDocker({});
    for (const source of ['/', 'app', '/app/../etc']) {
      await expect(copyFrontierSweArtifact(exec, 'arm', 'v', { source, exclude: [] }, '/tmp/h', 0)).rejects.toThrow(/unsafe/);
    }
  });
});

describe('live v2 grade end-to-end (fake docker) — FSWE-P003-REWARD at the binding', () => {
  it('scores the reward.json value written in the separate verifier, and always releases it', async () => {
    const files: Record<string, string> = { 'arm:/app/main.py': 'x' };
    const { exec, calls } = fakeDocker(files);
    const grader = makeFrontierSweGrader(
      {
        prepareVerifierEnv: async (ctx) => {
          const env = await livePrepareSeparateVerifier(ctx);
          // The verifier "ran" and wrote both files; reward.json must win over reward.txt (Harbor precedence).
          files[`${env.verifierRef}:/logs/verifier/reward.json`] = '{"reward":0.37,"latency":0.9}';
          files[`${env.verifierRef}:/logs/verifier/reward.txt`] = '0.99';
          return env;
        },
        buildVerifierCommand: liveBuildVerifierCommand,
        readReward: liveReadReward,
      },
      { exec, fs: { mkdtemp: async () => '', writeFile: async () => undefined, readFile: async () => '', rm: async () => undefined } },
    );
    const [g] = await grader.grade([{ modality: 'in-container', instanceId: 'astronomy-toolkit', envRef: 'arm', prefix: 's' }], [
      { ...v2Task(), instanceId: 'astronomy-toolkit' },
    ]);
    expect(g.graderError).toBeUndefined();
    expect(g.score).toBe(0.37);
    expect(g.graderVersion).toBe(`frontier-swe@v2+da83f84f8fbc verifier=${V2_IMAGE}`);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-f']);
  });
});

describe('preflightFrontierSwe (no spend)', () => {
  const okDocker: ProcExec = async () => ({ stdout: '27.0.1', stderr: '', code: 0 });
  const noDocker: ProcExec = async () => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 });

  it('ready when docker + repo + corpus all present (defaults to the v2 corpus)', async () => {
    const pf = await preflightFrontierSwe(
      { repoDir: '/vendor/frontier-swe-v2', corpusPath: '/corpus/tasks.jsonl' },
      { exec: okDocker, pathExists: async () => true },
    );
    expect(pf.corpusVersion).toBe('v2');
    expect(pf.ready).toBe(true);
    expect(pf.issues).toEqual([]);
  });

  it('surfaces every gap without spending — v2 names the v2 checkout + ingest', async () => {
    const prev = process.env.PAPERCUSP_FRONTIER_SWE_V2_DIR;
    delete process.env.PAPERCUSP_FRONTIER_SWE_V2_DIR;
    try {
      const pf = await preflightFrontierSwe({ corpusPath: '/corpus/tasks.jsonl' }, { exec: noDocker, pathExists: async () => false });
      expect(pf.ready).toBe(false);
      expect(pf.issues.join(' ')).toMatch(/Docker daemon not reachable/);
      expect(pf.issues.join(' ')).toMatch(/PAPERCUSP_FRONTIER_SWE_V2_DIR unset.*frontier-swe-v2/);
      expect(pf.issues.join(' ')).toMatch(/corpus JSONL missing.*v2 \(P-002\) ingest/);
    } finally {
      if (prev !== undefined) process.env.PAPERCUSP_FRONTIER_SWE_V2_DIR = prev;
    }
  });

  it('v1 preflight checks the v1 checkout', async () => {
    const prev = process.env.PAPERCUSP_FRONTIER_SWE_DIR;
    delete process.env.PAPERCUSP_FRONTIER_SWE_DIR;
    try {
      const pf = await preflightFrontierSwe({ corpusVersion: 'v1', corpusPath: '/c.jsonl' }, { exec: okDocker, pathExists: async () => false });
      expect(pf.corpusVersion).toBe('v1');
      expect(pf.issues.join(' ')).toMatch(/PAPERCUSP_FRONTIER_SWE_DIR unset/);
    } finally {
      if (prev !== undefined) process.env.PAPERCUSP_FRONTIER_SWE_DIR = prev;
    }
  });
});

describe('describeFrontierSweRun', () => {
  it('v1 documents the exact docker exec verifier + reward read', () => {
    const s = describeFrontierSweRun('mycid', undefined, 'v1');
    expect(s).toContain('docker exec mycid');
    expect(s).toContain('/logs/verifier/reward.txt');
    expect(s).toContain('HARBOR_ORACLE_MODE=1');
  });

  it('v2 (default) documents the separate verifier and Harbor reward precedence', () => {
    const s = describeFrontierSweRun('arm');
    expect(s).toMatch(/verifier image/);
    expect(s).toMatch(/reward\.json.*PRIMARY/);
    expect(s).toContain('docker rm -f');
  });
});
