/**
 * Live binding + preflight for the SWE-bench Pro grader (P-009 pilot prep). Makes the M1 grader
 * ONE-COMMAND-READY: resolve the config from env, build the live grader (shell-free execFile + real fs),
 * and a preflight that reports readiness WITHOUT spending — it never pulls the GB-scale `jefzda/sweap-images`
 * (those + the full run are owner-gated: disk + budget). The actual bounded smoke is the owner-armed step;
 * this module is what makes it a single command.
 *
 * Config comes from env so the pilot host (a dedicated grading volume, per the feasibility doc) owns the
 * paths without a code change:
 *   PAPERCUSP_SWEBENCH_EVAL_DIR   — the scaleapi/SWE-bench_Pro-os checkout (has swe_bench_pro_eval.py + run_scripts)
 *   PAPERCUSP_SWEBENCH_CSV        — the raw sample CSV (swe_bench_pro_full.csv)
 *   PAPERCUSP_SWEBENCH_VERSION    — the grader version pin for pre-registration (image-set tag / repo commit)
 *   PAPERCUSP_SWEBENCH_DOCKERHUB_USER (default jefzda) · PAPERCUSP_SWEBENCH_NUM_WORKERS
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { SWE_BENCH_PRO_V1_PIN, type SweBenchProPopulationPin } from '../swe-bench-pro-pin';
import type { OfficialGrader } from '../types';
import type { ProcExec, SweBenchProGraderConfig } from './swe-bench-pro';
import { getOfficialGrader, liveGraderFs, liveProcExec } from './index';

/** Resolve the live SWE-bench Pro grader config from env. Throws a clear error listing missing required vars. */
export function resolveSweBenchProConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SweBenchProGraderConfig {
  const evalRepoDir = env.PAPERCUSP_SWEBENCH_EVAL_DIR;
  const rawSamplePath = env.PAPERCUSP_SWEBENCH_CSV;
  const version = env.PAPERCUSP_SWEBENCH_VERSION;
  if (!evalRepoDir || !rawSamplePath || !version) {
    const missing = [
      !evalRepoDir && 'PAPERCUSP_SWEBENCH_EVAL_DIR',
      !rawSamplePath && 'PAPERCUSP_SWEBENCH_CSV',
      !version && 'PAPERCUSP_SWEBENCH_VERSION',
    ].filter(Boolean);
    throw new Error(`SWE-bench Pro grader not configured — set: ${missing.join(', ')}`);
  }
  const workers = env.PAPERCUSP_SWEBENCH_NUM_WORKERS ? Number(env.PAPERCUSP_SWEBENCH_NUM_WORKERS) : undefined;
  return {
    evalRepoDir,
    rawSamplePath,
    version,
    dockerhubUsername: env.PAPERCUSP_SWEBENCH_DOCKERHUB_USER ?? 'jefzda',
    numWorkers: workers && Number.isFinite(workers) ? workers : undefined,
  };
}

/** Build the live SWE-bench Pro grader (real Docker exec + fs). cfg defaults to the env-resolved config. */
export function buildLiveSweBenchProGrader(cfg: SweBenchProGraderConfig = resolveSweBenchProConfigFromEnv()): OfficialGrader {
  return getOfficialGrader('swe-bench-pro', { sweBenchPro: cfg }, { exec: liveProcExec, fs: liveGraderFs });
}

export interface SweBenchProPreflight {
  /**
   * True iff Docker is reachable AND the eval checkout is present AND the raw CSV is present and is
   * byte-identical to the pinned population — safe to run the grader.
   */
  ready: boolean;
  docker: { available: boolean; detail: string };
  evalScript: { present: boolean; path: string };
  rawSampleCsv: {
    present: boolean;
    path: string;
    /** sha256 of the CSV bytes, or null when the file is absent or could not be read. */
    sha256: string | null;
    /** True iff sha256 equals the pinned population's csvSha256. */
    matchesPin: boolean;
    /** The population the CSV is checked against (WI-6554700010008394). */
    pin: { population: string; taskCount: number; csvSha256: string };
  };
  /** Human-actionable gaps (provisioning steps the owner runs before the bounded smoke). */
  issues: string[];
}

export interface PreflightDeps {
  exec?: ProcExec;
  pathExists?: (p: string) => Promise<boolean>;
  /** sha256 hex of a file's bytes. Defaults to a streaming hash of the real file. */
  fileSha256?: (p: string) => Promise<string>;
  /** Population the CSV must match. Defaults to SWE_BENCH_PRO_V1_PIN. */
  pin?: SweBenchProPopulationPin;
}

/** Streaming sha256 of a file (the raw CSV is ~24 MB; never buffer it whole). */
export function sha256OfFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(p)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Check readiness WITHOUT spending: Docker daemon reachable + the eval checkout + the raw CSV present and
 * matching the pinned population. Never pulls an image / runs the eval. `issues` lists exactly what to
 * provision (clone the checkout, fetch the CSV, or restore the pinned CSV).
 */
export async function preflightSweBenchPro(cfg: SweBenchProGraderConfig, deps: PreflightDeps = {}): Promise<SweBenchProPreflight> {
  const pin = deps.pin ?? SWE_BENCH_PRO_V1_PIN;
  const fileSha256 = deps.fileSha256 ?? sha256OfFile;
  const exec = deps.exec ?? liveProcExec;
  const pathExists =
    deps.pathExists ??
    (async (p: string) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    });

  const ver = await exec('docker', ['version', '--format', '{{.Server.Version}}']);
  const dockerAvailable = ver.code === 0 && ver.stdout.trim().length > 0;

  const evalScriptPath = `${cfg.evalRepoDir}/swe_bench_pro_eval.py`;
  const evalPresent = await pathExists(evalScriptPath);
  const csvPresent = await pathExists(cfg.rawSamplePath);

  const issues: string[] = [];
  let csvSha256: string | null = null;
  if (csvPresent) {
    try {
      csvSha256 = await fileSha256(cfg.rawSamplePath);
    } catch (err) {
      issues.push(`raw sample CSV at ${cfg.rawSamplePath} could not be read to verify its pin: ${String(err).slice(0, 200)}`);
    }
  }
  const matchesPin = csvSha256 === pin.csvSha256;

  if (!dockerAvailable) issues.push(`Docker daemon not reachable (docker version exit ${ver.code}: ${ver.stderr.slice(0, 200)})`);
  if (!evalPresent) issues.push(`eval harness missing — clone scaleapi/SWE-bench_Pro-os into ${cfg.evalRepoDir} (expects swe_bench_pro_eval.py + run_scripts/)`);
  if (!csvPresent) issues.push(`raw sample CSV missing at ${cfg.rawSamplePath} (the ${pin.csvFile} for the ${pin.taskCount}-task ${pin.hfDataset} config '${pin.hfConfig}' population)`);
  if (csvSha256 !== null && !matchesPin) {
    issues.push(
      `raw sample CSV at ${cfg.rawSamplePath} is not the pinned ${pin.population} population ` +
        `(sha256 ${csvSha256.slice(0, 16)}…, pinned ${pin.csvSha256.slice(0, 16)}…, ${pin.taskCount} tasks). ` +
        `The ${pin.hfDataset} HF default config is now the 642-task v2 set, so a fresh export changes the population; ` +
        `restore the pinned CSV (HF config '${pin.hfConfig}'), or migrate the adapter and this pin together.`,
    );
  }

  return {
    ready: dockerAvailable && evalPresent && csvPresent && matchesPin,
    docker: { available: dockerAvailable, detail: dockerAvailable ? `Server ${ver.stdout.trim()}` : ver.stderr.slice(0, 200) || `exit ${ver.code}` },
    evalScript: { present: evalPresent, path: evalScriptPath },
    rawSampleCsv: {
      present: csvPresent,
      path: cfg.rawSamplePath,
      sha256: csvSha256,
      matchesPin,
      pin: { population: pin.population, taskCount: pin.taskCount, csvSha256: pin.csvSha256 },
    },
    issues,
  };
}

/** The exact grading command (for the runbook / a dry-run preview) — matches what the live grader runs. */
export function describeSweBenchProRun(cfg: SweBenchProGraderConfig, predsPath = '<predictions>.json', outDir = '<out>'): string {
  const lines = [
    `cd ${cfg.evalRepoDir}`,
    `python swe_bench_pro_eval.py \\`,
    `  --raw_sample_path=${cfg.rawSamplePath} \\`,
    `  --patch_path=${predsPath} \\`,
    `  --output_dir=${outDir} \\`,
    `  --scripts_dir=run_scripts \\`,
    `  --num_workers=${cfg.numWorkers ?? 16} \\`,
    `  --dockerhub_username=${cfg.dockerhubUsername ?? 'jefzda'}`,
  ];
  if (cfg.useLocalDocker !== false) lines[lines.length - 1] += ' \\';
  if (cfg.useLocalDocker !== false) lines.push('  --use_local_docker');
  // verdict file the grader reads back
  lines.push(`# → ${outDir}/eval_results.json  ({ "<instance_id>": resolvedBool })   [one eval run per seed/prefix]`);
  return lines.join('\n');
}
