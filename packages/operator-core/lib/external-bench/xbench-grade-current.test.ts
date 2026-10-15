/** Exercise the maintained Python entry point without Docker or inference. */
import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './reproducibility/canonical-json';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const script = fileURLToPath(new URL('./_xbench_grade.py', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'current-grade-test-')); roots.push(root);
  const evalDir = join(root, 'official'), out = join(root, 'run'), csv = join(root, 'canonical.csv');
  mkdirSync(evalDir); mkdirSync(out); mkdirSync(join(out, 'diffs-baseline'));
  const official = `import argparse,json,os
def get_dockerhub_image_uri(uid,*args,**kwargs): return 'mutable:tag'
def main():
 p=argparse.ArgumentParser()
 for name in ['raw_sample_path','patch_path','output_dir','scripts_dir','num_workers','dockerhub_username']: p.add_argument('--'+name)
 p.add_argument('--use_local_docker',action='store_true');p.add_argument('--redo',action='store_true')
 args=p.parse_args()
 with open(args.patch_path) as f: predictions=json.load(f)
 images={p['instance_id']:('mutable:tag' if os.environ.get('FIXTURE_IGNORE_IMAGES') else get_dockerhub_image_uri(p['instance_id'])) for p in predictions}
 os.makedirs(args.output_dir,exist_ok=True)
 with open(os.path.join(args.output_dir,'used-images.json'),'w') as f: json.dump({'images':images,'csv':args.raw_sample_path,'redo':args.redo},f)
 with open(os.path.join(args.output_dir,'eval_results.json'),'w') as f: json.dump({key:not bool(os.environ.get('FIXTURE_EMPTY_TESTS')) for key in images},f)
 if not os.environ.get('FIXTURE_MISSING_OUTPUT'):
  for prediction in predictions:
   path=os.path.join(args.output_dir,prediction['instance_id']);os.makedirs(path,exist_ok=True)
   with open(os.path.join(path,prediction['prefix']+'_output.json'),'w') as f: json.dump({'tests':[] if os.environ.get('FIXTURE_EMPTY_TESTS') else [{'name':'official-test','status':'PASSED'}]},f)
   if os.environ.get('FIXTURE_SUITE_LOG'):
    with open(os.path.join(path,prediction['prefix']+'_stdout.log'),'w') as f: f.write(os.environ['FIXTURE_SUITE_LOG'])
 if os.environ.get('FIXTURE_GRADE_FAIL'): raise RuntimeError('Official scorer failed after partial output')
if __name__=='__main__': main()
`;
  writeFileSync(join(evalDir, 'swe_bench_pro_eval.py'), official);
  // Fixture repository only, independent of the shared staging tree.
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: evalDir });
  execFileSync('git', ['fast-import', '--quiet'], { cwd: evalDir,
    input: `blob\nmark :1\ndata ${Buffer.byteLength(official)}\n${official}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 swe_bench_pro_eval.py\n\ndone\n` });
  // fast-import writes refs/objects, but does not populate the checkout index.
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: evalDir });
  const version = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: evalDir, encoding: 'utf8' }).trim();
  writeFileSync(csv, `instance_id,repo,selected_test_files_to_run,fail_to_pass\nt1,fixture/repo,"['test/components/Example.test.ts']","['test/components/Example.test.ts | renders']"\n`);
  writeFileSync(join(out, 'baseline.json'), JSON.stringify({ perTask: [{ instanceId: 't1', stopReason: 'done' }] }));
  writeFileSync(join(out, 'diffs-baseline', 't1.diff'), 'diff --git a/a b/a\n+changed\n');
  const images = { t1: `docker.io/jefzda/sweap-images@sha256:${'a'.repeat(64)}` };
  const grader = { family: 'swe-bench-pro', version, images, imageDigest: sha(canonicalJson(images)),
    datasetSha256: sha(readFileSync(csv, 'utf8')) };
  const run = (extra: Record<string, string> = {}) => spawnSync('python3', [script, 'baseline'], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env,
      PAPERCUSP_SWEBENCH_EVAL_DIR: evalDir, PAPERCUSP_SWEBENCH_CSV: csv,
      PAPERCUSP_SWEBENCH_PYTHON: 'python3', XBENCH_OUT_DIR: out, XBENCH_SAMPLE: join(out, 'tasks.jsonl'),
      XBENCH_FROZEN_GRADER: JSON.stringify(grader), FIXTURE_GRADE_FAIL: '', FIXTURE_MISSING_OUTPUT: '', FIXTURE_IGNORE_IMAGES: '',
      FIXTURE_EMPTY_TESTS: '', FIXTURE_SUITE_LOG: '', ...extra },
  });
  return { out, evalDir, csv, grader, run };
}

it('invokes the pinned official scorer with immutable image URIs and the exact CSV, and writes a matching receipt', () => {
  const f = fixture(), result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.out, 'grade-baseline/out/used-images.json'), 'utf8')))
    .toEqual({ images: f.grader.images, csv: f.csv, redo: true });
  expect(JSON.parse(readFileSync(join(f.out, 'grade-baseline/grader-receipt.json'), 'utf8')))
    .toMatchObject({ sourceCommit: f.grader.version, datasetSha256: f.grader.datasetSha256,
      imageDigest: f.grader.imageDigest, images: f.grader.images,
      taskOutputSha256: { t1: expect.stringMatching(/^[a-f0-9]{64}$/) } });
});

it.each([
  ['source', 'Official grader source differs'],
  ['dirty-source', 'executable sources differ'],
  ['untracked-code', 'untracked executable inputs'],
  ['csv', 'CSV differs'],
  ['manifest', 'manifest hash differs'],
  ['mutable-image', 'immutable task image digests'],
  ['missing-image', 'submitted task has no frozen'],
  ['missing-csv', 'canonical PAPERCUSP_SWEBENCH_CSV'],
])(
  'refuses %s drift before the official scorer runs', (changed, reason) => {
    const f = fixture();
    if (changed === 'source') f.grader.version = 'b'.repeat(40);
    if (changed === 'dirty-source') writeFileSync(join(f.evalDir, 'swe_bench_pro_eval.py'), 'raise RuntimeError("WRONG SOURCE RAN")');
    if (changed === 'untracked-code') { mkdirSync(join(f.evalDir, 'helper_code')); writeFileSync(join(f.evalDir, 'helper_code', 'unexpected.py'), 'pass'); }
    if (changed === 'csv') writeFileSync(f.csv, 'different official test data');
    if (changed === 'manifest') f.grader.imageDigest = 'b'.repeat(64);
    if (changed === 'mutable-image') f.grader.images.t1 = 'docker.io/jefzda/sweap-images:latest';
    if (changed === 'missing-image') { f.grader.images = { t2: f.grader.images.t1 } as unknown as typeof f.grader.images;
      f.grader.imageDigest = sha(canonicalJson(f.grader.images)); }
    const result = f.run(changed === 'missing-csv' ? { PAPERCUSP_SWEBENCH_CSV: '' } : {});
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain(reason);
    expect(() => readFileSync(join(f.out, 'grade-baseline/out/used-images.json'))).toThrow();
  },
);

it('does not accept partial or stale verdicts when the official scorer exits unsuccessfully', () => {
  const f = fixture();
  const result = f.run({ FIXTURE_GRADE_FAIL: '1' });
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(() => readFileSync(join(f.out, 'grade-baseline/grader-receipt.json'))).toThrow();
});

it('refuses an aggregate verdict when a grader outage produced no per-task test measurement', () => {
  const f = fixture(), result = f.run({ FIXTURE_MISSING_OUTPUT: '1' });
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stderr).toContain('no measured test output');
  expect(() => readFileSync(join(f.out, 'grade-baseline/grader-receipt.json'))).toThrow();
});

const suiteFailure = `FAIL test/components/Example.test.ts
  ● Test suite failed to run

    Cannot find module '../../src/Example' from 'test/components/Example.test.ts'

Tests:       0 total
`;

it('retains the official false outcome for a canonical suite failing to import submitted app source', () => {
  const f = fixture(), result = f.run({ FIXTURE_EMPTY_TESTS: '1', FIXTURE_SUITE_LOG: suiteFailure });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.out, 'resolved-baseline.json'), 'utf8')).perInstance).toEqual({ t1: false });
  expect(JSON.parse(readFileSync(join(f.out, 'grade-baseline/grader-receipt.json'), 'utf8')).taskMeasurements)
    .toEqual({ t1: { kind: 'submission-import-failure', testFile: 'test/components/Example.test.ts',
      sourcePath: 'src/Example', stdoutSha256: sha(suiteFailure) } });
});

it.each([
  ['unexplained empty output', ''],
  ['missing dependency', suiteFailure.replace('../../src/Example', 'missing-dependency')],
  ['noncanonical test', suiteFailure.replaceAll('test/components/Example.test.ts', 'test/Other.test.ts')],
  ['missing test summary', suiteFailure.replace('Tests:       0 total', '')],
  ['source outside app', suiteFailure.replace('../../src/Example', '../../../src/Example')],
])('keeps %s unmeasured rather than manufacture an official failure', (_reason, log) => {
  const f = fixture(), result = f.run({ FIXTURE_EMPTY_TESTS: '1', FIXTURE_SUITE_LOG: log });
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stderr).toContain('no measured test output');
  expect(() => readFileSync(join(f.out, 'grade-baseline/grader-receipt.json'))).toThrow();
  expect(readFileSync(join(f.out, 'grade-baseline/official-stdout.log'), 'utf8')).toBeDefined();
});

it('refuses a scorer that ignores the immutable image resolver', () => {
  const f = fixture(), result = f.run({ FIXTURE_IGNORE_IMAGES: '1' });
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stderr).toContain('did not use every frozen task image resolver');
  expect(() => readFileSync(join(f.out, 'grade-baseline/grader-receipt.json'))).toThrow();
});

it('records an empty conditional grade without invoking the scorer when no submission exists', () => {
  const f = fixture(); writeFileSync(join(f.out, 'diffs-baseline/t1.diff'), '');
  const result = f.run(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.out, 'grade-baseline/out/eval_results.json'), 'utf8'))).toEqual({});
  expect(result.stdout).toContain('CONDITIONAL RESOLVED 0/0 = unmeasured');
  expect(() => readFileSync(join(f.out, 'grade-baseline/out/used-images.json'))).toThrow();
});
