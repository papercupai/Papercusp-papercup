/**
 * P-007 suite-readiness boundary: real Docker, official provisioned checkout and
 * pinned population bytes. These probes never launch a task, pull an image or
 * call a model. Missing-dependency controls only modify private fixture paths.
 * Uses the same provisioned bench-harnesses directory as the live benchmark host;
 * the live binding's environment variables can select another provisioned host.
 */
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ingestFrontierSweCorpus, nodeIngestFs, readCheckoutHead, writeFrontierSweCorpus } from '../frontier-swe-ingest';
import { SWE_BENCH_PRO_V1_PIN } from '../swe-bench-pro-pin';
import { preflightFrontierSwe } from './frontier-swe-live';
import { preflightSweBenchPro } from './swe-bench-pro-live';

const harnesses = join(homedir(), '.papercusp', 'bench-harnesses');

it('SWE-bench Pro readiness checks real Docker and official pinned bytes, and refuses removed grading dependencies', async () => {
  const official = process.env.PAPERCUSP_SWEBENCH_EVAL_DIR ?? join(harnesses, 'SWE-bench_Pro-os');
  const csv = process.env.PAPERCUSP_SWEBENCH_CSV ?? join(official, SWE_BENCH_PRO_V1_PIN.csvFile);
  const cfg = { evalRepoDir: official, rawSamplePath: csv, version: 'readiness-only' };
  const provisioned = await preflightSweBenchPro(cfg);
  expect(provisioned).toMatchObject({ ready: true, docker: { available: true },
    evalScript: { present: true }, runScripts: { present: true },
    rawSampleCsv: { present: true, matchesPin: true, sha256: SWE_BENCH_PRO_V1_PIN.csvSha256 }, issues: [] });

  const directory = await mkdtemp(join(tmpdir(), 'swe-readiness-integration-'));
  try {
    const evaluator = join(directory, 'swe_bench_pro_eval.py');
    const scripts = join(directory, 'run_scripts');
    const population = join(directory, SWE_BENCH_PRO_V1_PIN.csvFile);
    await symlink(join(official, 'swe_bench_pro_eval.py'), evaluator);
    await symlink(join(official, 'run_scripts'), scripts);
    await symlink(csv, population);
    const isolated = { ...cfg, evalRepoDir: directory, rawSamplePath: population };
    expect((await preflightSweBenchPro(isolated)).ready).toBe(true);

    await unlink(scripts);
    const missingScripts = await preflightSweBenchPro(isolated);
    expect(missingScripts).toMatchObject({ ready: false, docker: { available: true },
      evalScript: { present: true }, rawSampleCsv: { matchesPin: true }, runScripts: { present: false } });
    expect(missingScripts.issues).toEqual([expect.stringMatching(/run_scripts.*missing/)]);
    await symlink(join(official, 'run_scripts'), scripts);

    await unlink(evaluator);
    const missingEvaluator = await preflightSweBenchPro(isolated);
    expect(missingEvaluator).toMatchObject({ ready: false, evalScript: { present: false }, runScripts: { present: true } });
    expect(missingEvaluator.issues).toEqual([expect.stringMatching(/eval harness missing/)]);
    await symlink(join(official, 'swe_bench_pro_eval.py'), evaluator);

    await unlink(population);
    expect(await preflightSweBenchPro(isolated)).toMatchObject({ ready: false, rawSampleCsv: { present: false, matchesPin: false } });
    await writeFile(population, 'repo,instance_id\nfixture/task,unofficial-population\n');
    expect(await preflightSweBenchPro(isolated)).toMatchObject({ ready: false, rawSampleCsv: { present: true, matchesPin: false } });
    await unlink(population);
    await symlink(csv, population);
    expect(await preflightSweBenchPro(isolated)).toMatchObject({ ready: true, issues: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it('FrontierSWE readiness checks the provisioned checkout and corpus with real Docker, and refuses either missing dependency', async () => {
  const official = process.env.PAPERCUSP_FRONTIER_SWE_V2_DIR ?? join(harnesses, 'frontier-swe-v2');
  const directory = await mkdtemp(join(tmpdir(), 'frontier-readiness-integration-'));
  try {
    const fs = nodeIngestFs();
    const commitSha = await readCheckoutHead(official, fs);
    if (!commitSha) throw new Error(`Provision an official FrontierSWE v2 checkout at ${official}`);
    const result = await ingestFrontierSweCorpus({ root: official, commitSha }, fs);
    expect(result.rows.length).toBeGreaterThan(0);
    const ingested = join(directory, 'ingested');
    await writeFrontierSweCorpus(ingested, result);
    const corpus = join(ingested, 'tasks.jsonl');
    const provisioned = await preflightFrontierSwe({ repoDir: official, corpusPath: corpus, corpusVersion: 'v2' });
    expect(provisioned).toMatchObject({ ready: true, corpusVersion: 'v2', docker: { available: true },
      repo: { present: true }, corpus: { present: true }, issues: [] });

    const tasks = join(directory, 'tasks');
    const population = join(directory, 'corpus.jsonl');
    await symlink(join(official, 'tasks'), tasks);
    await symlink(corpus, population);
    const isolated = { repoDir: directory, corpusPath: population, corpusVersion: 'v2' as const };
    expect((await preflightFrontierSwe(isolated)).ready).toBe(true);

    await unlink(tasks);
    const missingTasks = await preflightFrontierSwe(isolated);
    expect(missingTasks).toMatchObject({ ready: false, docker: { available: true }, repo: { present: false }, corpus: { present: true } });
    expect(missingTasks.issues).toEqual([expect.stringMatching(/missing its tasks/)]);
    await symlink(join(official, 'tasks'), tasks);

    await unlink(population);
    const missingCorpus = await preflightFrontierSwe(isolated);
    expect(missingCorpus).toMatchObject({ ready: false, repo: { present: true }, corpus: { present: false } });
    expect(missingCorpus.issues).toEqual([expect.stringMatching(/corpus JSONL missing/)]);
    await symlink(corpus, population);
    expect(await preflightFrontierSwe(isolated)).toMatchObject({ ready: true, issues: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
