/** Real official-scoring controls; opt in with pinned inputs, never model inference. */
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './reproducibility/canonical-json';
import type { CurrentBenchmarkProtocol } from './reproducibility/schema';

interface Preparation {
  taskIds: string[];
  sourceCommit: string;
  datasetSha256: string;
  imageDigest: string;
  images: Record<string, string>;
}

const preparationPath = process.env.PAPERCUSP_CURRENT_BENCH_GRADER_RECEIPT;
const preparation: Preparation | null = preparationPath ? JSON.parse(readFileSync(preparationPath, 'utf8')) : null;
const script = fileURLToPath(new URL('./_xbench_grade.py', import.meta.url));
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// The full dataset and reference solutions stay in the grader runtime. Only the
// selected task's control patch is written into its separate grading directory.
const prepareControl = `import hashlib,json,pathlib,sys,pandas as pd
csv,uid,out,control=sys.argv[1:]
row=pd.read_csv(csv).set_index('instance_id').loc[uid]
assert control in ('reference','unfixed')
patch=row['patch'] if control=='reference' else '''diff --git a/BENCHMARK_CONTROL_NO_FIX b/BENCHMARK_CONTROL_NO_FIX
new file mode 100644
--- /dev/null
+++ b/BENCHMARK_CONTROL_NO_FIX
@@ -0,0 +1 @@
+This control leaves the issue unfixed.
'''
assert isinstance(patch,str) and patch.strip()
root=pathlib.Path(out)
(root/'diffs-baseline').mkdir()
(root/'diffs-baseline'/str(uid+'.diff')).write_text(patch)
(root/'baseline.json').write_text(json.dumps({'perTask':[{'instanceId':uid,'stopReason':'done'}]}))
(root/'control-input.json').write_text(json.dumps({'taskId':uid,'control':control,'patchSha256':hashlib.sha256(patch.encode()).hexdigest()}))
`;

describe.skipIf(!preparation)('current official SWE-bench Pro pinned live controls', () => {
  let evalDir: string, csv: string, python: string, outputRoot: string;
  let frozen: CurrentBenchmarkProtocol['grader'];
  beforeAll(() => {
    evalDir = process.env.PAPERCUSP_SWEBENCH_EVAL_DIR!;
    csv = process.env.PAPERCUSP_SWEBENCH_CSV!;
    python = process.env.PAPERCUSP_SWEBENCH_PYTHON!;
    expect(evalDir && csv && python, 'Explicit official runtime paths are required.').toBeTruthy();
    expect(preparation!.taskIds.length).toBeGreaterThan(0);
    expect(new Set(preparation!.taskIds).size).toBe(preparation!.taskIds.length);
    expect(sha(readFileSync(csv))).toBe(preparation!.datasetSha256);
    expect(sha(canonicalJson(preparation!.images))).toBe(preparation!.imageDigest);
    const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: evalDir, encoding: 'utf8', timeout: 10_000 });
    expect(source.status, source.stderr).toBe(0);
    expect(source.stdout.trim()).toBe(preparation!.sourceCommit);
    const daemon = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 });
    expect(daemon.status, `${daemon.error?.message ?? ''} ${daemon.stderr}`).toBe(0);
    expect(daemon.stdout.trim()).not.toBe('');
    for (const id of preparation!.taskIds) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(preparation!.images[id]).toMatch(/@sha256:[a-f0-9]{64}$/);
      // The official scorer pulls each immutable URI itself. A cache entry may
      // expire between provisioning and grading; its absence is not an outage.
      // Actual image use and measured output are required below by the wrapper.
    }
    frozen = { family: 'swe-bench-pro', version: preparation!.sourceCommit,
      datasetSha256: preparation!.datasetSha256, imageDigest: preparation!.imageDigest, images: preparation!.images };
    outputRoot = process.env.PAPERCUSP_CURRENT_BENCH_GRADER_CONTROL_OUTPUT_DIR ?? tmpdir();
    mkdirSync(outputRoot, { recursive: true });
  }, 90_000);

  const cases = (preparation?.taskIds ?? ['unconfigured']).flatMap(id =>
    ['reference', 'unfixed'].map(control => ({ id, control })));
  it.each(cases)('$id / $control yields measured official tests and the expected verdict', ({ id, control }) => {
    const out = mkdtempSync(join(outputRoot, `official-${control}-`));
    const prepared = spawnSync(python, ['-c', prepareControl, csv, id, out, control], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(prepared.status, prepared.stderr).toBe(0);
    const result = spawnSync('python3', [script, 'baseline'], {
      encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PAPERCUSP_SWEBENCH_EVAL_DIR: evalDir, PAPERCUSP_SWEBENCH_CSV: csv,
        PAPERCUSP_SWEBENCH_PYTHON: python, PAPERCUSP_SWEBENCH_NUM_WORKERS: '1',
        XBENCH_OUT_DIR: out, XBENCH_SAMPLE: csv, XBENCH_FROZEN_GRADER: JSON.stringify(frozen) },
    });
    writeFileSync(join(out, 'wrapper-stdout.log'), result.stdout ?? '');
    writeFileSync(join(out, 'wrapper-stderr.log'), result.stderr ?? '');
    writeFileSync(join(out, 'process-result.json'), JSON.stringify({ status: result.status,
      signal: result.signal, error: result.error?.message }));
    console.info(JSON.stringify({ taskId: id, control, outputDir: out, exitCode: result.status }));
    expect(result.status, `${out}: ${result.stderr?.slice(-2000)} ${result.stdout?.slice(-2000)}`).toBe(0);
    const measured = JSON.parse(readFileSync(join(out, 'grade-baseline/grader-receipt.json'), 'utf8'));
    expect(measured).toMatchObject({ sourceCommit: frozen.version, datasetSha256: frozen.datasetSha256,
      imageDigest: frozen.imageDigest, images: frozen.images });
    expect(Object.keys(measured.taskOutputSha256)).toEqual([id]);
    expect(measured.taskMeasurements[id].kind).toMatch(/^(parsed-tests|submission-import-failure)$/);
    if (control === 'reference') expect(measured.taskMeasurements[id].kind).toBe('parsed-tests');
    const outputPath = join(out, 'grade-baseline/out', id, 'arm-baseline_output.json');
    expect(sha(readFileSync(outputPath))).toBe(measured.taskOutputSha256[id]);
    const map = JSON.parse(readFileSync(join(out, 'grade-baseline/out/eval_results.json'), 'utf8'));
    expect(Object.keys(map)).toEqual([id]);
    expect(map[id]).toBe(control === 'reference');
  }, 220_000);
});
