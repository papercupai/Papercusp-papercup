import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createEmbedSidecarServer, EMBED_SIDECAR_RUNTIME } from '../embed-sidecar-server';
import { collectSidecarRobustness, parseRobustnessInput, summarizeRobustnessReport, type RobustnessIdentity } from './sidecar-robustness';

/** A deterministic stand-in for the embed worker thread: per-text latency, a
 * pending map the crash seam rejects (exactly as local-embedder-worker's
 * terminate path does), and a respawn on the next call. It ignores
 * AbortSignal like the real worker, so started work keeps its queue slot.
 * Collector qualification only — real-weight runs qualify a model. */
function syntheticWorker(opts: { baseMs: number; msPerChar: number; driftAfterCrash?: boolean; hangOnCrash?: boolean;
  /** Resolve crash() only after this long, like shutdownLocalEmbedder awaiting the old worker's retire drain. */
  retireDelayMs?: number }) {
  let alive = false, crashes = 0, nextId = 0;
  const pending = new Map<number, { reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const vectorFor = (text: string) => {
    const digest = crypto.createHash('sha256').update(text).digest();
    const raw = Array.from({ length: 16 }, (_, i) => digest[i] - 127.5 + (opts.driftAfterCrash && crashes > 0 ? 40 : 0));
    const norm = Math.hypot(...raw);
    return raw.map((x) => x / norm);
  };
  return {
    embed: (text: string) => new Promise<number[]>((resolve, reject) => {
      alive = true;
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); resolve(vectorFor(text)); }, opts.baseMs + text.length * opts.msPerChar);
      pending.set(id, { reject, timer });
    }),
    crash: async () => {
      crashes++;
      alive = false;
      if (opts.hangOnCrash) return;
      const error = new Error(`embedder worker was shut down while ${pending.size} request(s) were in flight`);
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(error); }
      pending.clear();
      if (opts.retireDelayMs) await new Promise<void>((resolve) => { setTimeout(resolve, opts.retireDelayMs); });
    },
    state: () => ({ alive, disabled: false, pendingCount: pending.size, keepAlive: false }),
  };
}

const input = parseRobustnessInput({
  formatVersion: 1, seed: 'synthetic-robustness', serverConcurrency: 2, requestTimeoutMs: 10000,
  requests: {
    query: [{ id: 'q0', text: 'which migration added the memory decay column' }, { id: 'q1', text: 'sidecar worker restart' }],
    document: [{ id: 'd0', text: 'The embed worker respawns on the next call.' }, { id: 'd1', text: 'Coalesced texts share one inference.' }],
    long: { id: 'long', text: 'x'.repeat(600) },
  },
  concurrency: { clients: 4, rounds: 2 },
  saturation: { inFlight: 12, deadlineMs: 10000, drainWithinMs: 3000 },
  coalescing: { duplicates: 4 },
  timeout: { clientDeadlineMs: 150, recoveryWithinMs: 3000 },
  cancellation: { requests: 3, abortAfterMs: 100, releaseWithinMs: 2000, drainWithinMs: 3000 },
  crash: { cycles: 2, inFlight: 3, startWithinMs: 2000, settleWithinMs: 1000, recoveryWithinMs: 3000 },
  soak: { durationMs: 1200, clients: 2, windowFraction: 0.3 },
  sampling: { healthzIntervalMs: 40, healthzTimeoutMs: 2000 },
  gates: { cosineMin: 0.99999, maxAbs: 0.00003 },
  thresholds: { healthzP99Ms: 500, eventLoopDelayP99Ms: 250, soakLateP95Ratio: 3, rssGrowthMiB: 256, timeoutSlackMs: 120 },
});
const expected: RobustnessIdentity = { model: 'mdenseon', modelRev: 'synthetic-rev', runtime: EMBED_SIDECAR_RUNTIME, dims: 16 };

async function run(worker: ReturnType<typeof syntheticWorker>, overrides: Partial<typeof input> = {}) {
  const sidecar = createEmbedSidecarServer({ port: 0, warmAtBoot: false, concurrency: input.serverConcurrency,
    builders: { mdenseon: async () => worker.embed }, modelRevisions: { mdenseon: expected.modelRev },
    workerStates: { embedder: worker.state, reranker: () => ({ alive: false, disabled: false, pendingCount: 0, keepAlive: false }) },
    log: () => {} });
  const url = `http://127.0.0.1:${await sidecar.listening}`;
  const phases: string[] = [];
  const runInput = { ...input, ...overrides };
  try {
    const report = await collectSidecarRobustness(url, expected, runInput, {
      crashWorker: worker.crash, workerState: worker.state, activity: sidecar.activity,
      onPhase: (phase, edge) => phases.push(`${phase}:${edge}`) });
    return { report, phases, input: runInput };
  } finally { await sidecar.close(); }
}

describe('sidecar robustness collector through a real HTTP sidecar', () => {
  it('drives every phase and re-derives a passing verdict from the raw population', async () => {
    const worker = syntheticWorker({ baseMs: 15, msPerChar: 1 });
    const { report, phases } = await run(worker);
    const summary = summarizeRobustnessReport(input, expected, report);
    expect(summary.failures).toEqual([]);
    expect(summary.verdict).toBe('pass');
    expect(phases.filter((p) => p.endsWith(':start'))).toEqual(['reference', 'concurrency', 'saturation', 'coalescing',
      'bypass', 'timeout', 'cancellation', 'crash', 'soak'].map((p) => `${p}:start`));
    // The crash really interrupted started inference and the next call respawned.
    for (const c of report.phases.crash) {
      expect(c.startedBeforeCrash?.pending).toBeGreaterThan(0);
      expect(c.workerAfterRecovery.alive).toBe(true);
    }
    expect(summary.crash.every((c) => c.interrupted > 0)).toBe(true);
    // Cancellation: queued work was cancelled while started work kept its slot.
    expect(report.phases.cancellation.atAbort).toEqual({ depth: 1, active: 2 });
    expect(summary.soak.requests).toBeGreaterThan(10);
    expect(report.health.length).toBeGreaterThan(20);
  }, 60000);

  it('times recovery from the replacement worker, not the old worker\'s retire drain (D-010)', async () => {
    // The drain (2.5s) is under the 3s bound, but a probe that waited for it would
    // report >= 2.5s of "recovery" for a service that answered at once.
    const { report } = await run(syntheticWorker({ baseMs: 15, msPerChar: 1, retireDelayMs: 2500 }));
    const summary = summarizeRobustnessReport(input, expected, report);
    expect(summary.failures).toEqual([]);
    expect(['pass', 'invalid']).toContain(summary.verdict);
    for (const c of summary.crash) {
      expect(c.recoveredMs).toBeLessThan(1000);
      expect(c.retiredMs).toBeGreaterThanOrEqual(2400);
    }
    expect(report.stallDetector.source).toMatch(/^(schedstat|thread-cpu)$/);
  }, 60000);

  it('fails the verdict when a restarted worker answers from a different vector space', async () => {
    const { report } = await run(syntheticWorker({ baseMs: 15, msPerChar: 1, driftAfterCrash: true }));
    const summary = summarizeRobustnessReport(input, expected, report);
    expect(summary.verdict).toBe('fail');
    expect(summary.failures.some((f) => f.startsWith('vector drift in crash'))).toBe(true);
  }, 60000);

  it('fails the verdict when a crash interrupts nothing (a vacuous crash is not recovery evidence)', async () => {
    const { report, input: runInput } = await run(syntheticWorker({ baseMs: 15, msPerChar: 1, hangOnCrash: true }));
    const summary = summarizeRobustnessReport(runInput, expected, report);
    expect(summary.verdict).toBe('fail');
    expect(summary.failures).toContain('crash cycle 0 did not tear down the worker and release its in-flight work (vacuous)');
  }, 60000);

  it('refuses structurally incomplete or rebound reports instead of grading them', async () => {
    const { report } = await run(syntheticWorker({ baseMs: 10, msPerChar: 1 }), { soak: { ...input.soak, durationMs: 1000 } });
    const soakInput = { ...input, soak: { ...input.soak, durationMs: 1000 } };
    expect(summarizeRobustnessReport(soakInput, expected, report).verdict).toBe('pass');
    expect(() => summarizeRobustnessReport(input, expected, report)).toThrow(/binding mismatch/);
    expect(() => summarizeRobustnessReport(soakInput, { ...expected, modelRev: 'other' }, report)).toThrow(/binding mismatch/);
    // Losing a fixed-count request leaves a hole in the issue sequence.
    const lost = report.samples.filter((s) => !(s.phase === 'timeout' && s.role === 'load'));
    expect(() => summarizeRobustnessReport(soakInput, expected, { ...report, samples: lost })).toThrow(/complete issue sequence/);
    const { crash: _crash, ...withoutCrash } = report.eventLoop;
    expect(() => summarizeRobustnessReport(soakInput, expected, { ...report, eventLoop: withoutCrash })).toThrow(/missing robustness phase crash/);
    const drifted = report.samples.map((s) => s.phase === 'soak' && s.sequence === report.samples.length - 1 ? { ...s, modelRev: 'drifted' } : s);
    expect(summarizeRobustnessReport(soakInput, expected, { ...report, samples: drifted }).failures.some((f) => f.startsWith('identity drift in soak'))).toBe(true);
  }, 60000);
});
