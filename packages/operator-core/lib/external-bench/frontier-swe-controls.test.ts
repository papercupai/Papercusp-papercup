import { describe, it, expect } from 'vitest';
import type { BenchTask } from './types';
import type { ProcExec } from './grader/swe-bench-pro';
import { parseFrontierSweSolutionSpec, runFrontierSweControl } from './frontier-swe-controls';

const ID = 'spice-circuit-simulator-in-rust';
const REPO = '/mnt/bench/work/frontier-swe-v2';

function v2Task(over: Record<string, unknown> = {}): BenchTask {
  return {
    benchmark: 'frontier-swe',
    instanceId: ID,
    problemStatement: 'x',
    graderMeta: {
      corpusVersion: 'v2',
      networkMode: 'allowlist',
      upstreamCommit: 'da83f84f8fbcec3cbf0f2b17c98ebc811355c2df',
      dockerImage: `us-west1-docker.pkg.dev/p/spice@sha256:${'1'.repeat(64)}`,
      verifierDockerImage: `us-west1-docker.pkg.dev/p/spice@sha256:${'2'.repeat(64)}`,
      verifierEnvironmentMode: 'separate',
      verifierEnv: {},
      verifierCmd: 'bash /tests/test.sh',
      rewardPath: '/logs/verifier/reward.txt',
      rewardJsonPath: '/logs/verifier/reward.json',
      solutionCmd: 'bash /solution/solve.sh',
      agentTimeoutSec: 72000,
      gpus: 0,
      ...over,
    },
  };
}

const TASK_TOML = `
[agent]
timeout_sec = 72000.0
user = "agent"

[solution.env]
OMP_NUM_THREADS = "4"
`;

/**
 * Fake docker: `run` → the arm container; `diff` → `diffLines`; `test`/`cat` read `files` (the verifier's reward);
 * the solve exec → `solveCode`; everything else → 0. Records every invocation.
 */
function fakeDocker(opts: { files?: Record<string, string>; diffLines?: string[]; solveCode?: number; runCode?: number;
  networkMode?: string; inspectionCode?: number } = {}) {
  const files = opts.files ?? { '/logs/verifier/reward.txt': '0.97\n' };
  const calls: string[][] = [];
  const exec: ProcExec = async (_cmd, args) => {
    calls.push(args);
    const ok = (stdout = '') => ({ stdout, stderr: '', code: 0 });
    if (args[0] === 'run') return opts.runCode ? { stdout: '', stderr: 'boom', code: opts.runCode } : ok('armcid\n');
    if (args[0] === 'inspect') return opts.inspectionCode
      ? { stdout: '', stderr: 'inspection failed', code: opts.inspectionCode } : ok(`${opts.networkMode ?? 'none'}\n`);
    if (args[0] === 'diff') return ok((opts.diffLines ?? []).join('\n'));
    if (args[0] !== 'exec') return ok();
    const last = args[args.length - 1];
    if (last.includes('/solution/solve.sh >')) return { stdout: '', stderr: '', code: opts.solveCode ?? 0 };
    if (args.includes('tail')) return ok('oracle: marker written\n');
    if (args.includes('test')) {
      const present = last in files;
      return { stdout: '', stderr: '', code: present ? 0 : 1 };
    }
    if (args.includes('cat')) return last in files ? ok(files[last]) : { stdout: '', stderr: 'no file', code: 1 };
    return ok();
  };
  return { exec, calls };
}

function verifierEnv(events: string[]) {
  return async () => ({ verifierRef: 'vcid', release: async () => void events.push('release') });
}

const ORACLE_DIFF = ['A /solution', 'A /solution/solve.sh', 'A /logs/agent', 'C /app', 'A /app/.harbor_oracle_marker'];

describe('parseFrontierSweSolutionSpec', () => {
  it('reads [agent].user and [solution.env]', () => {
    expect(parseFrontierSweSolutionSpec(TASK_TOML)).toEqual({ user: 'agent', env: { OMP_NUM_THREADS: '4' } });
  });

  it('defaults to the image user and no env when the sections are absent or empty', () => {
    expect(parseFrontierSweSolutionSpec('[task]\nname = "x"\n[solution.env]\n')).toEqual({ user: null, env: {} });
  });

  it('refuses a host-env ${…} template in [solution.env]', () => {
    expect(() => parseFrontierSweSolutionSpec('[solution.env]\nKEY = "${OPENAI_API_KEY}"\n')).toThrow(/host-env template/);
  });
});

describe('runFrontierSweControl — gold', () => {
  it('stages /solution, runs solve.sh as [agent].user with ONE flag shared by solve.sh and the verifier, then grades', async () => {
    const { exec, calls } = fakeDocker({ diffLines: ORACLE_DIFF });
    const events: string[] = [];
    const r = await runFrontierSweControl({
      task: v2Task(),
      mode: 'gold',
      repoDir: REPO,
      exec,
      readText: async () => TASK_TOML,
      prepareVerifierEnv: verifierEnv(events),
      oracleFlag: 'f00dfeed',
    });
    expect(r.graderStatus).toBe('failed'); // 0.97 < 1: a real score, not resolved
    expect(r.score).toBe(0.97);
    expect(r.error).toBeUndefined();
    expect(r.networkPolicy).toEqual({ declaredMode: 'allowlist', agentNetworkMode: 'none' });

    // contents-copy (`/.`): the entrypoint's oracle stage has already created /solution, and a plain dir copy
    // onto an existing directory would nest it as /solution/solution
    expect(calls).toContainEqual(['cp', `${REPO}/tasks/${ID}/solution/.`, 'armcid:/solution']);
    // the SAME flag is in the arm container's env from `docker run`, so the image entrypoint's oracle stage
    // (create /solution, stage reference material) runs at container init, as px-eval does
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain('HARBOR_ORACLE_FLAG=f00dfeed');
    expect(run.indexOf('HARBOR_ORACLE_FLAG=f00dfeed')).toBeLessThan(run.indexOf('sleep'));
    const solve = calls.find((c) => c[c.length - 1].includes('/solution/solve.sh >'))!;
    expect(solve.slice(0, 3)).toEqual(['exec', '--user', 'agent']);
    expect(solve).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(solve).toContain('OMP_NUM_THREADS=4');
    expect(solve).toContain('HARBOR_ORACLE_FLAG=f00dfeed');
    expect(solve[solve.length - 1]).toContain('timeout --kill-after=30 72000 bash /solution/solve.sh > /logs/agent/oracle.txt 2>&1');

    const verify = calls.find((c) => c.includes('vcid') && c[c.length - 1].includes('/tests/test.sh'))!;
    expect(verify).toContain('HARBOR_ORACLE_FLAG=f00dfeed');

    // the reference run happens BEFORE grading, and the arm container is torn down last
    expect(calls.indexOf(solve)).toBeLessThan(calls.indexOf(verify));
    expect(calls.findIndex((c) => c[0] === 'inspect')).toBeLessThan(calls.indexOf(solve));
    expect(calls[calls.length - 1]).toEqual(['rm', '-f', 'armcid']);
    expect(events).toEqual(['release']);
    expect(r.oracle).toMatchObject({ user: 'agent', exitCode: 0, timedOut: false, timeoutSec: 72000, logTail: 'oracle: marker written\n' });
  });

  it('a production gold run mints a fresh 32-hex flag per run', async () => {
    const flags: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { exec, calls } = fakeDocker({ diffLines: ORACLE_DIFF });
      await runFrontierSweControl({ task: v2Task(), mode: 'gold', repoDir: REPO, exec, readText: async () => TASK_TOML, prepareVerifierEnv: verifierEnv([]) });
      const solve = calls.find((c) => c[c.length - 1].includes('/solution/solve.sh >'))!;
      flags.push(solve.find((a) => a.startsWith('HARBOR_ORACLE_FLAG='))!.slice('HARBOR_ORACLE_FLAG='.length));
    }
    expect(flags[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(flags[0]).not.toBe(flags[1]);
  });

  it('a timed-out or failing solve.sh is recorded and grading STILL runs (Harbor semantics)', async () => {
    const { exec, calls } = fakeDocker({ diffLines: ORACLE_DIFF, solveCode: 124 });
    const r = await runFrontierSweControl({
      task: v2Task(),
      mode: 'gold',
      repoDir: REPO,
      exec,
      readText: async () => TASK_TOML,
      prepareVerifierEnv: verifierEnv([]),
      oracleFlag: 'f',
      solveTimeoutSec: 60,
    });
    expect(r.oracle).toMatchObject({ exitCode: 124, timedOut: true, timeoutSec: 60 });
    expect(r.score).toBe(0.97);
    expect(calls.some((c) => c.includes('vcid'))).toBe(true);
  });

  it('refuses a task with no reference solution, without starting a container', async () => {
    const { exec, calls } = fakeDocker();
    const r = await runFrontierSweControl({ task: v2Task({ solutionCmd: null }), mode: 'gold', repoDir: REPO, exec, readText: async () => TASK_TOML });
    expect(r.graderStatus).toBe('error');
    expect(r.error).toMatch(/no reference solution/);
    expect(calls).toEqual([]);
  });
});

describe('runFrontierSweControl — empty', () => {
  it('grades the untouched scaffold: no /solution, no solve.sh, no oracle flag', async () => {
    const { exec, calls } = fakeDocker({ files: { '/logs/verifier/reward.txt': '0\n' } });
    const events: string[] = [];
    const r = await runFrontierSweControl({ task: v2Task(), mode: 'empty', repoDir: REPO, exec, prepareVerifierEnv: verifierEnv(events) });
    expect(r.score).toBe(0);
    expect(r.graderStatus).toBe('failed');
    expect(r.oracle).toBeUndefined();
    expect(calls.find((c) => c[0] === 'cp')).toBeUndefined();
    expect(calls.flat().join(' ')).not.toContain('HARBOR_ORACLE');
    expect(calls[calls.length - 1]).toEqual(['rm', '-f', 'armcid']);
    expect(events).toEqual(['release']);
  });

  it('an empty run whose container shows the oracle writes is TAMPERED, not scored', async () => {
    const { exec } = fakeDocker({ diffLines: ORACLE_DIFF });
    const r = await runFrontierSweControl({ task: v2Task(), mode: 'empty', repoDir: REPO, exec, prepareVerifierEnv: verifierEnv([]) });
    expect(r.graderStatus).toBe('invalid');
    expect(r.score).toBeNull();
  });
});

describe('runFrontierSweControl — refusals and infra failures', () => {
  it.each(['bridge', 'host', ''])('refuses measured network %j before running the oracle or verifier', async (networkMode) => {
    const { exec, calls } = fakeDocker({ networkMode });
    const r = await runFrontierSweControl({ task: v2Task(), mode: 'gold', repoDir: REPO,
      exec, readText: async () => TASK_TOML });
    expect(r.graderStatus).toBe('error');
    expect(r.score).toBeNull();
    expect(r.networkPolicy).toEqual({ declaredMode: 'allowlist', agentNetworkMode: networkMode });
    expect(calls.some((c) => c[0] === 'cp' || c.includes('vcid'))).toBe(false);
    expect(calls[calls.length - 1]).toEqual(['rm', '-f', 'armcid']);
  });

  it('cannot claim network fidelity when Docker inspection fails', async () => {
    const { exec, calls } = fakeDocker({ inspectionCode: 1 });
    const r = await runFrontierSweControl({ task: v2Task(), mode: 'empty', repoDir: REPO, exec });
    expect(r.error).toMatch(/inspect agent network/);
    expect(r.score).toBeNull();
    expect(r.networkPolicy).toBeUndefined();
    expect(calls[calls.length - 1]).toEqual(['rm', '-f', 'armcid']);
  });

  it('refuses missing or unknown declared network modes before cloning', async () => {
    for (const networkMode of [undefined, 'open']) {
      const { exec, calls } = fakeDocker();
      const r = await runFrontierSweControl({ task: v2Task({ networkMode }), mode: 'empty', repoDir: REPO, exec });
      expect(r.error).toMatch(/no enforceable declared network mode/);
      expect(calls).toEqual([]);
    }
  });

  it('refuses a v1 (shared-verifier) task', async () => {
    const { exec, calls } = fakeDocker();
    const r = await runFrontierSweControl({ task: v2Task({ verifierEnvironmentMode: undefined }), mode: 'empty', repoDir: REPO, exec });
    expect(r.error).toMatch(/v2 controls only/);
    expect(calls).toEqual([]);
  });

  it('a failed clone is an infra error, never a score, and nothing is torn down', async () => {
    const { exec, calls } = fakeDocker({ runCode: 1 });
    const r = await runFrontierSweControl({ task: v2Task(), mode: 'empty', repoDir: REPO, exec });
    expect(r.graderStatus).toBe('error');
    expect(r.score).toBeNull();
    expect(r.error).toMatch(/^clone:/);
    expect(calls.find((c) => c[0] === 'rm')).toBeUndefined();
  });

  it('a failed /solution stage is an infra error and the container is still torn down', async () => {
    const base = fakeDocker({ diffLines: ORACLE_DIFF });
    const exec: ProcExec = async (cmd, args, o) => (args[0] === 'cp' ? { stdout: '', stderr: 'no such dir', code: 1 } : base.exec(cmd, args, o));
    const r = await runFrontierSweControl({ task: v2Task(), mode: 'gold', repoDir: REPO, exec, readText: async () => TASK_TOML, oracleFlag: 'f' });
    expect(r.error).toMatch(/stage \/solution/);
    expect(base.calls[base.calls.length - 1]).toEqual(['rm', '-f', 'armcid']);
  });
});
