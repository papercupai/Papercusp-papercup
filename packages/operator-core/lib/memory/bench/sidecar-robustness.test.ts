import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashJson } from './measurement-manifest';
import { describeFetchError, loadRobustnessRun, parseRobustnessInput, summarizeRobustnessReport, ROBUSTNESS_PHASES, type RobustnessIdentity,
  type RobustnessInput, type RobustnessReport, type RobustnessSample } from './sidecar-robustness';

const raw = {
  formatVersion: 1, seed: 'unit', serverConcurrency: 1, requestTimeoutMs: 5000,
  requests: { query: [{ id: 'q0', text: 'a' }, { id: 'q1', text: 'b' }], document: [{ id: 'd0', text: 'c' }, { id: 'd1', text: 'd' }],
    long: { id: 'long', text: 'long text' } },
  concurrency: { clients: 2, rounds: 1 }, saturation: { inFlight: 2, deadlineMs: 1000, drainWithinMs: 1000 },
  coalescing: { duplicates: 2 }, timeout: { clientDeadlineMs: 100, recoveryWithinMs: 1000 },
  cancellation: { requests: 1, abortAfterMs: 50, releaseWithinMs: 1000, drainWithinMs: 1000 },
  crash: { cycles: 1, inFlight: 1, startWithinMs: 1000, settleWithinMs: 500, recoveryWithinMs: 1000 },
  soak: { durationMs: 1000, clients: 1, windowFraction: 0.25 }, sampling: { healthzIntervalMs: 50, healthzTimeoutMs: 500 },
  gates: { cosineMin: 0.99999, maxAbs: 0.00003 },
  thresholds: { healthzP99Ms: 100, eventLoopDelayP99Ms: 50, soakLateP95Ratio: 1.5, rssGrowthMiB: 32, timeoutSlackMs: 20 },
};
const expected: RobustnessIdentity = { model: 'mdenseon', modelRev: 'rev', runtime: 'node-onnx-worker', dims: 768 };

/** The smallest structurally complete report for `raw`; each knob breaks one bar. */
function report(input: RobustnessInput, knobs: { longMs?: number; soakLateMs?: number; rssLateMiB?: number; healthRttMs?: number; drop?: boolean;
  retiredAfterMs?: number | null; stalls?: RobustnessReport['harnessStalls'] } = {}): RobustnessReport {
  const samples: RobustnessSample[] = [];
  let t = 0;
  const add = (phase: RobustnessSample['phase'], role: RobustnessSample['role'], over: Partial<RobustnessSample> = {}) => {
    const latencyMs = over.latencyMs ?? 10, startedAtMs = over.startedAtMs ?? t;
    samples.push({ phase, role, sequence: samples.length, kind: 'query', requestId: 'q0', bypassCache: true, timeoutMs: 5000,
      startedAtMs, settledAtMs: startedAtMs + latencyMs, latencyMs, outcome: 'ok', cache: { hits: 0, coalesced: 0, inferred: 1 },
      modelRev: expected.modelRev, runtime: expected.runtime, dims: expected.dims,
      ...(role === 'reference' ? {} : { cosine: 1, maxAbs: 0 }), vectorSha256: 'a'.repeat(64), ...over });
    t = startedAtMs + latencyMs;
  };
  for (let i = 0; i < 6; i++) add('reference', 'reference', i === 4 ? { latencyMs: knobs.longMs ?? 400 } : {});
  add('concurrency', 'load'); add('concurrency', 'load');
  add('saturation', 'load'); add('saturation', 'load'); add('saturation', 'probe');
  add('coalescing', 'load'); add('coalescing', 'load', { cache: { hits: 0, coalesced: 1, inferred: 0 } });
  add('bypass', 'load'); add('bypass', 'load');
  add('timeout', 'load', { outcome: 'timeout', latencyMs: 105 }); add('timeout', 'probe');
  add('cancellation', 'load', { outcome: 'aborted' }); add('cancellation', 'probe');
  const crashAtMs = t + 5;
  add('crash', 'load', { cycle: 0, outcome: 'http-error', status: 500, startedAtMs: t, latencyMs: 20 });
  add('crash', 'probe', { cycle: 0 });
  const soakStart = t;
  for (let i = 0; i < 20; i++) add('soak', 'load', { startedAtMs: soakStart + i * 50, latencyMs: i >= 15 ? knobs.soakLateMs ?? 10 : 10 });
  const soakEnd = soakStart + 1000;
  const health = Array.from({ length: 21 }, (_, i) => ({ phase: 'soak' as const, atMs: soakStart + i * 50, rttMs: knobs.healthRttMs ?? 5,
    ok: true, status: 200, queue: { depth: 0, active: 0 }, rssBytes: (i >= 16 ? 100 + (knobs.rssLateMiB ?? 0) : 100) * 1024 * 1024 }));
  if (knobs.drop) {
    // A report that lost one fixed-count request but was renumbered to look contiguous.
    samples.splice(samples.findIndex((s) => s.phase === 'bypass'), 1);
    samples.forEach((s, i) => { s.sequence = i; });
  }
  const drained = { drained: true, afterMs: 1 };
  const retiredAfterMs = knobs.retiredAfterMs === undefined ? 30 : knobs.retiredAfterMs;
  return { formatVersion: 2, pid: 1, expected, inputSha256: hashJson(input), startedAt: 'x', finishedAt: 'y', samples, health,
    eventLoop: Object.fromEntries(ROBUSTNESS_PHASES.map((p) => [p, { p50Ms: 1, p99Ms: 2, maxMs: 3 }])),
    stallDetector: { source: 'schedstat', config: { tickMs: 100, stallMs: 1000, scheduledFractionMin: 0.1 } },
    harnessStalls: knobs.stalls ?? [],
    phases: { saturation: { burstWallMs: 20, drain: drained }, timeout: { referenceLongLatencyMs: knobs.longMs ?? 400, recovery: drained },
      cancellation: { atAbort: { depth: 0, active: 1 }, abortedAtMs: 1, releaseMs: 3, drain: drained,
        workerAfter: { alive: true, disabled: false, pendingCount: 0 } },
      crash: [{ cycle: 0, crashAtMs, startedBeforeCrash: { active: 1, pending: 1 }, workerAfterCrash: { alive: false, disabled: false, pendingCount: 0 },
        recoveryProbeSequence: samples.findIndex((s) => s.phase === 'crash' && s.role === 'probe'),
        workerAfterRecovery: { alive: true, disabled: false, pendingCount: 0 },
        retiredAtMs: retiredAfterMs === null ? null : crashAtMs + retiredAfterMs }],
      soak: { startedAtMs: soakStart, endedAtMs: soakEnd } } };
}

describe('describeFetchError keeps the cause a bare "fetch failed" hides', () => {
  it('records the cause chain with its codes', async () => {
    // A real undici rejection: connection refused on a port nothing listens on.
    const net = await import('node:net');
    const server = net.createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number }; await new Promise((resolve) => server.close(resolve));
    const refused = await fetch(`http://127.0.0.1:${port}/healthz`).catch((error: unknown) => error);
    const described = describeFetchError(refused);
    expect(described).toMatch(/^TypeError: fetch failed <- /);
    expect(described).toMatch(/ECONNREFUSED/);
  });
  it('handles non-Error values and bounds its output', () => {
    expect(describeFetchError('plain')).toBe('plain');
    const deep = new Error('a'.repeat(400), { cause: Object.assign(new Error('b'), { code: 'X_CODE' }) });
    expect(describeFetchError(deep).length).toBeLessThanOrEqual(300);
    expect(describeFetchError(new Error('top', { cause: Object.assign(new Error('inner'), { code: 'UND_ERR_SOCKET' }) })))
      .toBe('Error: top <- Error UND_ERR_SOCKET: inner');
  });
});

describe('robustness input contract', () => {
  it('accepts the declared shape and refuses ambiguous or vacuous designs before any request', () => {
    expect(parseRobustnessInput(raw).serverConcurrency).toBe(1);
    expect(() => parseRobustnessInput({ ...raw, requests: { ...raw.requests, long: { id: 'q0', text: 'x' } } })).toThrow(/duplicate robustness request id/);
    expect(() => parseRobustnessInput({ ...raw, timeout: { ...raw.timeout, clientDeadlineMs: 5000 } })).toThrow(/timeout phase deadline/);
    expect(() => parseRobustnessInput({ ...raw, cancellation: { ...raw.cancellation, abortAfterMs: 6000 } })).toThrow(/cancellation must abort/);
    expect(() => parseRobustnessInput({ ...raw, extra: true })).toThrow();
  });
});

describe('robustness verdict re-derived from raw samples', () => {
  const input = parseRobustnessInput(raw);
  it('passes a complete in-bound report', () => {
    const summary = summarizeRobustnessReport(input, expected, report(input));
    expect(summary.failures).toEqual([]);
    expect(summary.verdict).toBe('pass');
    expect(summary.crash).toEqual([{ cycle: 0, startedBeforeCrash: { active: 1, pending: 1 }, interrupted: 1, rescued: 0,
      workerAfterCrash: { alive: false, disabled: false, pendingCount: 0 }, recoveredMs: expect.any(Number), retiredMs: 30 }]);
    expect(summary.invalidReasons).toEqual([]);
  });
  it('fails when the old worker is not retired within the recovery bound, or never', () => {
    for (const retiredAfterMs of [1001, null]) {
      const summary = summarizeRobustnessReport(input, expected, report(input, { retiredAfterMs }));
      expect(summary.verdict).toBe('fail');
      expect(summary.failures).toContain('crash cycle 0: old worker not retired within 1000ms');
    }
  });
  it('grades a run whose main thread was not scheduled as invalid — never pass, never fail (D-010)', () => {
    const frozen = { labelAtStart: 'soak' as const, label: 'soak' as const, atMs: 400, gapMs: 21423, runMs: 2, waitMs: 1, kind: 'not-scheduled' as const };
    const clean = summarizeRobustnessReport(input, expected, report(input, { stalls: [frozen] }));
    expect(clean.verdict).toBe('invalid');
    expect(clean.invalidReasons).toEqual(['main thread not scheduled for 21423ms in soak at 400ms']);
    // A run that ALSO failed a bar is still invalid, with its failures kept for diagnosis.
    const failing = summarizeRobustnessReport(input, expected, report(input, { stalls: [frozen], soakLateMs: 40 }));
    expect(failing.verdict).toBe('invalid');
    expect(failing.failures.some((f) => /soak late\/early p95 ratio/.test(f))).toBe(true);
    // A BUSY stall is the code under test blocking its own loop: it never excuses anything.
    const busy = summarizeRobustnessReport(input, expected, report(input, { stalls: [{ ...frozen, runMs: 21000, kind: 'busy' }] }));
    expect(busy.verdict).toBe('pass');
    expect(busy.harnessStalls).toHaveLength(1);
  });
  it('refuses a formatVersion 1 report, which timed the retire drain as recovery and recorded no stalls', () => {
    expect(() => summarizeRobustnessReport(input, expected, { ...report(input), formatVersion: 1 } as unknown as RobustnessReport))
      .toThrow(/binding mismatch/);
  });
  it.each([
    ['a timeout phase whose long request beats the deadline', { longMs: 50 }, /timeout phase is vacuous/],
    ['late-soak latency growth', { soakLateMs: 40 }, /soak late\/early p95 ratio/],
    ['late-soak RSS growth', { rssLateMiB: 64 }, /soak RSS grew/],
    ['an unresponsive /healthz', { healthRttMs: 500 }, /\/healthz p99/],
  ] as const)('fails on %s', (_name, knobs, failure) => {
    const summary = summarizeRobustnessReport(input, expected, report(input, knobs));
    expect(summary.verdict).toBe('fail');
    expect(summary.failures.some((f) => failure.test(f))).toBe(true);
  });
  it('throws on a structurally incomplete population instead of grading it', () => {
    expect(() => summarizeRobustnessReport(input, expected, report(input, { drop: true }))).toThrow(/bypass\/load has 1 samples, expected 2/);
  });
});

describe('loadRobustnessRun binds a real-weight run to a frozen arm', () => {
  const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'robustness-arm-'));
  const repoRoot = path.join(root, 'repo'), candidateDir = path.join(root, 'mdenseon');
  const rel = 'node_modules/@huggingface/transformers/.cache/onnx-community/gemma/onnx';
  const files = { graph: 'model.onnx', tokenizer: 'tokenizer.json', config: 'config.json', weights: 'model.onnx_data' } as const;
  const write = (dir: string, name: string, body: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), body); };
  for (const [role, name] of Object.entries(files)) { write(path.join(repoRoot, rel), name, `gemma-${role}`); write(candidateDir, name, `mdenseon-${role}`); }
  const pinOf = (p: string, body: string) => ({ path: p, sha256: sha(body), bytes: Buffer.byteLength(body) });
  const armFor = (id: 'gemma' | 'mdenseon', at: (name: string) => string, wire = 'node-onnx-worker') => ({
    id, model: id, modelRev: `${id}-frozen-rev`, runtime: { name: 'transformers-js-worker', wire }, profile: { targetDims: 768 },
    artifacts: { graph: pinOf(at(files.graph), `${id}-graph`), tokenizer: pinOf(at(files.tokenizer), `${id}-tokenizer`),
      config: pinOf(at(files.config), `${id}-config`), weightLayout: 'external', weights: [pinOf(at(files.weights), `${id}-weights`)] } });
  const frozenTree = path.join(root, 'frozen/runtime-source-v1/tree', rel);
  const manifestBody = (wire?: string) => JSON.stringify({ arms: [armFor('gemma', (n) => path.join(frozenTree, n), wire),
    armFor('mdenseon', (n) => path.join(fs.realpathSync(candidateDir), n))] });
  const manifestPath = path.join(root, 'frozen.json'), inputPath = path.join(root, 'input.json');
  fs.writeFileSync(manifestPath, manifestBody()); fs.writeFileSync(inputPath, JSON.stringify(raw));
  const base = () => ({ inputPath, inputSha256: sha(fs.readFileSync(inputPath)), armManifestPath: manifestPath,
    armManifestSha256: sha(fs.readFileSync(manifestPath)), repoRoot, runtime: 'node-onnx-worker' });

  it('takes the expected identity from the frozen arm and relocates incumbent weights onto the running tree', async () => {
    const run = await loadRobustnessRun({ ...base(), model: 'gemma' });
    expect(run.expected).toEqual({ model: 'gemma', modelRev: 'gemma-frozen-rev', runtime: 'node-onnx-worker', dims: 768 });
    expect(run.armPin.artifacts.map((a) => a.loadedPath)).toEqual(
      ['model.onnx', 'tokenizer.json', 'config.json', 'model.onnx_data'].map((n) => path.join(repoRoot, rel, n)));
    expect(run.input.seed).toBe('unit');
    const candidate = await loadRobustnessRun({ ...base(), model: 'mdenseon', mdenseonModelDir: candidateDir });
    expect(candidate.expected.modelRev).toBe('mdenseon-frozen-rev');
  });
  it('refuses a loaded weight that differs by one byte from its frozen pin', async () => {
    fs.writeFileSync(path.join(repoRoot, rel, files.weights), 'gemma-weightz');
    try {
      await expect(loadRobustnessRun({ ...base(), model: 'gemma' })).rejects.toThrow(/weights\[0\].*differs from its frozen pin/);
    } finally { fs.writeFileSync(path.join(repoRoot, rel, files.weights), 'gemma-weights'); }
  });
  it('refuses an unpinned input, an unpinned manifest, a foreign candidate directory and a different wire runtime', async () => {
    await expect(loadRobustnessRun({ ...base(), inputSha256: '0'.repeat(64), model: 'gemma' })).rejects.toThrow(/input fingerprint/);
    await expect(loadRobustnessRun({ ...base(), armManifestSha256: '0'.repeat(64), model: 'gemma' })).rejects.toThrow(/manifest fingerprint/);
    await expect(loadRobustnessRun({ ...base(), model: 'mdenseon', mdenseonModelDir: path.join(repoRoot, rel) })).rejects.toThrow(/outside/);
    await expect(loadRobustnessRun({ ...base(), model: 'mdenseon' })).rejects.toThrow(/candidate model directory/);
    fs.writeFileSync(manifestPath, manifestBody('worker-in-process'));
    try {
      await expect(loadRobustnessRun({ ...base(), model: 'gemma' })).rejects.toThrow(/is not the server runtime/);
    } finally { fs.writeFileSync(manifestPath, manifestBody()); }
  });
});
