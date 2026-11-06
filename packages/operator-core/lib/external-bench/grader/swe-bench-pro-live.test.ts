/**
 * Live-binding smoke for the SWE-bench Pro grader (P-009) — pure, no Docker / no image pulls. Verifies the
 * env→config resolve, the readiness preflight (mocked docker/fs), and the run-command description.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SWE_BENCH_PRO_V1_PIN } from '../swe-bench-pro-pin';
import { estimateBenchLaunch } from '../estimate';
import { knownTaskSets } from '../task-sets';
import { describeSweBenchProRun, preflightSweBenchPro, resolveSweBenchProConfigFromEnv, sha256OfFile } from './swe-bench-pro-live';
import type { ProcExec } from './swe-bench-pro';

describe('resolveSweBenchProConfigFromEnv', () => {
  it('builds the config from env (dockerhub defaults to jefzda)', () => {
    const cfg = resolveSweBenchProConfigFromEnv({
      PAPERCUSP_SWEBENCH_EVAL_DIR: '/eval',
      PAPERCUSP_SWEBENCH_CSV: '/data.jsonl',
      PAPERCUSP_SWEBENCH_VERSION: 'sweap@2026-05',
      PAPERCUSP_SWEBENCH_NUM_WORKERS: '4',
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ evalRepoDir: '/eval', rawSamplePath: '/data.jsonl', version: 'sweap@2026-05', dockerhubUsername: 'jefzda', numWorkers: 4 });
  });
  it('throws listing the missing required vars', () => {
    expect(() => resolveSweBenchProConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(/PAPERCUSP_SWEBENCH_EVAL_DIR/);
  });
});

describe('preflightSweBenchPro', () => {
  const cfg = { evalRepoDir: '/eval', rawSamplePath: '/data.csv', version: 'v1' };

  const dockerUp: ProcExec = async () => ({ stdout: '29.4.0\n', stderr: '', code: 0 });
  const pinnedSha = async () => SWE_BENCH_PRO_V1_PIN.csvSha256;

  it('ready when Docker is up + the checkout + the pinned CSV are present', async () => {
    const pre = await preflightSweBenchPro(cfg, { exec: dockerUp, pathExists: async () => true, fileSha256: pinnedSha });
    expect(pre.ready).toBe(true);
    expect(pre.issues).toEqual([]);
    expect(pre.docker.available).toBe(true);
    expect(pre.runScripts).toEqual({ present: true, path: '/eval/run_scripts' });
    expect(pre.rawSampleCsv).toMatchObject({ present: true, sha256: SWE_BENCH_PRO_V1_PIN.csvSha256, matchesPin: true });
  });

  it('not ready + actionable issues when Docker is down and the checkout is missing', async () => {
    const exec: ProcExec = async () => ({ stdout: '', stderr: 'cannot connect to daemon', code: 1 });
    const pre = await preflightSweBenchPro(cfg, { exec, pathExists: async (p) => p.endsWith('.csv'), fileSha256: pinnedSha });
    expect(pre.ready).toBe(false);
    expect(pre.evalScript.present).toBe(false);
    expect(pre.rawSampleCsv.present).toBe(true);
    expect(pre.issues.length).toBeGreaterThanOrEqual(2); // docker + eval-harness gaps
    expect(pre.issues.some((i) => /Docker/.test(i))).toBe(true);
    expect(pre.issues.some((i) => /SWE-bench_Pro-os/.test(i))).toBe(true);
  });

  it('refuses a checkout missing run_scripts even when Docker, evaluator and pinned CSV are ready', async () => {
    const paths: string[] = [];
    const pre = await preflightSweBenchPro(cfg, {
      exec: dockerUp,
      pathExists: async path => { paths.push(path); return path !== '/eval/run_scripts'; },
      fileSha256: pinnedSha,
    });
    expect(paths).toContain('/eval/run_scripts');
    expect(pre.ready).toBe(false);
    expect(pre.issues).toEqual([expect.stringMatching(/run_scripts.*missing/)]);
  });

  it('reads real checkout dependencies and becomes ready only after run_scripts is restored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-pro-deps-'));
    try {
      const csv = join(dir, 'population.csv');
      writeFileSync(csv, 'repo,instance_id\na/b,task\n');
      writeFileSync(join(dir, 'swe_bench_pro_eval.py'), '# official evaluator fixture\n');
      const pin = { ...SWE_BENCH_PRO_V1_PIN, csvSha256: await sha256OfFile(csv) } as unknown as typeof SWE_BENCH_PRO_V1_PIN;
      const fileCfg = { evalRepoDir: dir, rawSamplePath: csv, version: 'fixture-pinned' };
      const missing = await preflightSweBenchPro(fileCfg, { exec: dockerUp, pin });
      expect(missing.ready).toBe(false);
      expect(missing.evalScript.present).toBe(true);
      expect(missing.rawSampleCsv.matchesPin).toBe(true);
      expect(missing.runScripts.present).toBe(false);
      expect(missing.issues).toEqual([expect.stringMatching(/run_scripts.*missing/)]);
      mkdirSync(join(dir, 'run_scripts'));
      const restored = await preflightSweBenchPro(fileCfg, { exec: dockerUp, pin });
      expect(restored.ready).toBe(true);
      expect(restored.runScripts.present).toBe(true);
      expect(restored.issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WI-6554700010008394: the HF default config is now the 642-task v2 set, so a re-exported CSV is a
  // different population. Everything else ready, a non-pinned CSV must still refuse.
  it('not ready when the CSV is present but is not the pinned population (a v2 re-export)', async () => {
    const v2Export = 'a'.repeat(64);
    const pre = await preflightSweBenchPro(cfg, { exec: dockerUp, pathExists: async () => true, fileSha256: async () => v2Export });
    expect(pre.ready).toBe(false);
    expect(pre.rawSampleCsv).toMatchObject({ present: true, sha256: v2Export, matchesPin: false });
    expect(pre.rawSampleCsv.pin).toEqual({
      population: 'v1',
      taskCount: 731,
      csvSha256: SWE_BENCH_PRO_V1_PIN.csvSha256,
    });
    expect(pre.issues).toHaveLength(1);
    expect(pre.issues[0]).toMatch(/not the pinned v1 population/);
    expect(pre.issues[0]).toMatch(/642-task v2/);
    expect(pre.issues[0]).toMatch(/config 'v1'/);
  });

  it('not ready when the CSV exists but cannot be hashed (the pin is unverified, not assumed)', async () => {
    const pre = await preflightSweBenchPro(cfg, {
      exec: dockerUp,
      pathExists: async () => true,
      fileSha256: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(pre.ready).toBe(false);
    expect(pre.rawSampleCsv).toMatchObject({ present: true, sha256: null, matchesPin: false });
    expect(pre.issues).toEqual([expect.stringMatching(/could not be read to verify its pin: .*EACCES/)]);
  });

  it('hashes the real file by default (streaming sha256 equals a one-shot digest of the same bytes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-pro-pin-'));
    try {
      const csv = join(dir, 'swe_bench_pro_full.csv');
      const bytes = 'repo,instance_id\n"a/b","instance_x"\n'.repeat(5000);
      writeFileSync(csv, bytes);
      const expected = createHash('sha256').update(bytes).digest('hex');
      expect(await sha256OfFile(csv)).toBe(expected);

      const fileCfg = { evalRepoDir: '/eval', rawSamplePath: csv, version: 'v1' };
      const matching = await preflightSweBenchPro(fileCfg, {
        exec: dockerUp,
        pathExists: async () => true,
        pin: { ...SWE_BENCH_PRO_V1_PIN, csvSha256: expected } as unknown as typeof SWE_BENCH_PRO_V1_PIN,
      });
      expect(matching.rawSampleCsv).toMatchObject({ sha256: expected, matchesPin: true });
      expect(matching.ready).toBe(true);

      const defaultPin = await preflightSweBenchPro(fileCfg, { exec: dockerUp, pathExists: async () => true });
      expect(defaultPin.rawSampleCsv).toMatchObject({ sha256: expected, matchesPin: false });
      expect(defaultPin.ready).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SWE_BENCH_PRO_V1_PIN is the single source for the full-set count', () => {
  it('the catalog entry and the launch estimate both read the pinned 731', () => {
    expect(SWE_BENCH_PRO_V1_PIN.taskCount).toBe(731);
    const full = knownTaskSets().find((s) => s.id === 'swe-bench-pro-full');
    expect(full?.count).toBe(SWE_BENCH_PRO_V1_PIN.taskCount);
    expect(full?.label).toBe('Full SWE-bench Pro v1 (731)');
    expect(estimateBenchLaunch({ taskSetId: 'swe-bench-pro-full' }).taskCount).toBe(SWE_BENCH_PRO_V1_PIN.taskCount);
  });
});

describe('describeSweBenchProRun', () => {
  it('emits the confirmed command (local Docker + eval_results.json verdict)', () => {
    const s = describeSweBenchProRun({ evalRepoDir: '/eval', rawSamplePath: '/data.csv', version: 'v1' }, 'preds.json', 'out');
    expect(s).toContain('swe_bench_pro_eval.py');
    expect(s).toContain('--raw_sample_path=/data.csv');
    expect(s).toContain('--use_local_docker');
    expect(s).toContain('eval_results.json');
  });
});
