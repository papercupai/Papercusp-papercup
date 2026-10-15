/**
 * P-006 (plan mdenseon-adoption-measurements-2026-10-01) integration proof.
 *
 * Drives the REAL `mdenseon-vectors.py` CLI end to end, as a process:
 *   1. `--freeze-boundaries` freezes a fresh boundary request from the pinned,
 *      qualified ONNX export (so the request always pins THIS checkout's script);
 *   2. `--boundary-request … --boundary-device cpu --boundary-cell single-short-query`
 *      runs the actual graph through onnxruntime against an independently loaded
 *      PyTorch reference at the fixed gates (cosine >= 0.99999, max-abs <= 3e-5),
 *      with the executed provider proved by ORT kernel profiling, not registry.
 * Two controls prove the gate is not vacuous: a relaxed threshold and a drifted
 * asset pin are each refused BEFORE any weights load.
 *
 * One declared diagnostic cell is measured here (seconds, low RSS); the
 * full-population CPU/CUDA matrices are committed operational evidence under
 * docs/evidence/mdenseon-boundary-*. The test needs the pinned local assets
 * (HF snapshot, qualified export, pinned Python venv) and SKIPS — naming what is
 * absent — on hosts without them.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bench = fileURLToPath(new URL('.', import.meta.url));
const home = os.homedir();
const validation = path.join(home, '.cache/papercusp/model-validation');
const python = process.env.MDENSEON_BOUNDARY_PYTHON
  ?? path.join(validation, 'venvs/mdenseon-boundary-py312-v1/bin/python');
const exportDir = process.env.MDENSEON_BOUNDARY_EXPORT
  ?? path.join(validation, 'mdenseon-a5fdb000-rope-EI24726559745089713');
const snapshot = path.join(home,
  '.cache/huggingface/hub/models--lightonai--mDenseOn/snapshots/a5fdb000f7a21da96c3bddde3a782ef777316df3');
const COSINE_FLOOR = 0.99999;
const MAX_ABS_ERROR = 3e-5;

const missing = ([
  [python, 'pinned Python venv'],
  [path.join(exportDir, 'onnx/model.onnx'), 'qualified ONNX export'],
  [path.join(snapshot, 'model.safetensors'), 'pinned HF snapshot'],
] as const).filter(([file]) => !fs.existsSync(file)).map(([, label]) => label);
if (missing.length) {
  console.warn(`[mdenseon-boundary] SKIPPED — absent on this host: ${missing.join(', ')}`);
}

function cli(args: string[], timeout = 240_000) {
  return spawnSync(python, ['mdenseon-vectors.py', ...args], {
    cwd: bench, encoding: 'utf8', timeout,
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
}
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe.skipIf(missing.length > 0)('mdenseon-vectors.py boundary CLI (real pinned weights, CPU)', () => {
  let tmp = '';
  let request = '';
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdenseon-boundary-'));
    request = path.join(tmp, 'request.json');
    const frozen = cli(['--freeze-boundaries', exportDir, '--out', request], 180_000);
    expect(frozen.error).toBeUndefined();
    expect(frozen.status, frozen.stderr).toBe(0);
    expect(frozen.stdout).toContain('boundary request frozen');
  }, 200_000);
  afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  function variant(name: string, edit: (r: Record<string, any>) => void) {
    const r = JSON.parse(fs.readFileSync(request, 'utf8'));
    edit(r);
    const file = path.join(tmp, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(r));
    return file;
  }

  it('refuses a relaxed fixed vector gate before loading weights', () => {
    const relaxed = variant('relaxed', (r) => { r.thresholds.minimumCosine = 0.999; });
    const out = path.join(tmp, 'relaxed-out');
    const res = cli(['--boundary-request', relaxed, '--boundary-device', 'cpu',
      '--boundary-cell', 'single-short-query', '--out', out]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('boundary identity or fixed gate drift');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('refuses a drifted asset pin before loading weights', () => {
    const drifted = variant('drifted', (r) => {
      const pin: string = r.assets[0].sha256;
      r.assets[0].sha256 = (pin[0] === '0' ? '1' : '0') + pin.slice(1);
    });
    const out = path.join(tmp, 'drifted-out');
    const res = cli(['--boundary-request', drifted, '--boundary-device', 'cpu',
      '--boundary-cell', 'single-short-query', '--out', out]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('boundary source/reference/export fingerprint drift');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('measures a declared CPU cell at the fixed gates with the executed provider proved by profiling', () => {
    const out = path.join(tmp, 'cpu-out');
    const res = cli(['--boundary-request', request, '--boundary-device', 'cpu',
      '--boundary-cell', 'single-short-query', '--out', out]);
    expect(res.error).toBeUndefined();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/boundary cell single-short-query \[\d+\] fixed gates True/);

    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    expect(summary.requestSha256).toBe(sha256(request));
    expect(summary.deviceRecipe).toBe('python-ort-cpu-fp32-tf32-default');
    expect(summary.actualProviderVerifiedByProfile).toBe(true);
    expect(summary.providersWithExecutedKernels).toContain('CPUExecutionProvider');
    expect(summary.passedFixedVectorGates).toBe(true);
    expect(summary.diagnosticOnly).toBe(true);
    expect(summary.fullPopulationCompatible).toBe(false);

    const cell = JSON.parse(fs.readFileSync(path.join(out, 'single-short-query.json'), 'utf8'));
    expect(cell.sessionProviders[0]).toBe('CPUExecutionProvider');
    expect(cell.tokenIdsEqual).toBe(true);
    expect(cell.passedFixedVectorGates).toBe(true);
    expect(cell.referenceParity.minimumCosine).toBeGreaterThanOrEqual(COSINE_FLOOR);
    expect(cell.referenceParity.maximumAbsoluteError).toBeLessThanOrEqual(MAX_ABS_ERROR);
  }, 300_000);
});
