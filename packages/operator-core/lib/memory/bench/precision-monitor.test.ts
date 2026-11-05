/**
 * precision-monitor — the memory-precision bench orchestration (relight P-033).
 * Dep-injected so no embedder/PG is needed: flag gate, the happy path
 * (bench → record → invalidate), the non-fatal failure paths, and (EI-10047)
 * the recall-drop baseline read + escalation wiring on top of it.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, it, expect, vi } from 'vitest';
import type { QueryOutcome } from '@papercusp/memory/bench';
import { toDecisionLedgerEntry, type DecisionCallRecord } from '@papercusp/decision-model';
import { JEV_MEMORY_ADMIT_THRESHOLD, type JevMemoryGateInput } from '../jev-memory-gate';
import { createPrecisionBenchJevGate } from './precision-bench-core';
import {
  gateReplayWithJev,
  jevGatedShape,
  parsePrecisionBenchWorkerOutput,
  parsePrecisionBenchWorkerLedgerEntries,
  persistPrecisionBenchWorkerLedgerEntries,
  PRECISION_BENCH_JEV_API_KEY_ENV,
  PRECISION_BENCH_JEV_CONSUMER,
  PRECISION_BENCH_JEV_GATE_ENV,
  PRECISION_BENCH_JEV_LEDGER_MARKER,
  PRECISION_BENCH_PROGRESS_MARKER,
  PRECISION_BENCH_EMBEDDER_MODE_ENV,
  PRECISION_BENCH_RESULT_MARKER,
  PRECISION_BENCH_WORKSPACE_ID_ENV,
  precisionBenchWorkerInvocation,
  parsePrecisionBenchWorkerProgress,
  resolvePrecisionBenchWorkerTarget,
  runBenchInWorker,
  runMemoryPrecisionMonitor,
  type MemoryPrecisionBenchDeps,
  type PrecisionBenchRunOptions,
} from './precision-monitor';
import { parseJevGateShape, type MemoryPrecisionMetrics } from './precision-read';
import type { RecallDropEvaluation } from './precision-alert';

const METRICS: MemoryPrecisionMetrics = {
  backend: 'hybrid',
  corpusVersion: 'v1',
  goldVersion: 'v1',
  corpusN: 114,
  goldN: 150,
  floorCosine: 0.45,
  floorLex: 0.4,
  fpAt5: 0.17,
  rAt10: 0.82,
  pAt5: 0.9,
  mrr: 0.7,
  medianTopScore: 0.6,
  latencyP50Ms: 12,
  byClass: {},
  costUsd: null,
  notes: null,
};

const silent = () => {};
// EI-10047: `history`/`escalateRecall` default to hitting real PG via getOrgPg()
// when not overridden (mirrors `record`'s own default) — every test below that
// doesn't specifically exercise the recall-canary wiring stays fully dep-injected
// (no embedder/PG) by supplying no-op stand-ins.
const noHistory = async () => [];
const noEscalate = async () => {};
// `invalidate` defaults to defaultInvalidate(), which `await import(...)`s the SSE module. Its own
// comment says the lazy import exists "so the read/test graph never pulls the SSE module" — but a
// test that does not INJECT the dep pulls it anyway: a lazy import DEFERS the cost, it cannot avoid
// it. That dragged the whole sync-sse graph into this suite (~7s on the first test to reach it) and
// made it flake against the 5s timeout under host load. Inject it, like every other dep here.
const noInvalidate = () => {};
// P-008: the default reads the workspace's Jev setting from PG. Inject it for the
// same reason as `invalidate` above; the Jev-specific cases pass their own.
const jevOff = async () => 'off' as const;

describe('runMemoryPrecisionMonitor', () => {
  it('uses the isolated worker route by default while keeping the direct bench seam explicit', async () => {
    let workerRuns = 0;
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-worker', installSlug: 'op' },
      {
        flag: async () => true,
        runBenchWorker: async () => {
          workerRuns += 1;
          return METRICS;
        },
        record: async () => 11,
        history: noHistory,
        escalateRecall: noEscalate,
        invalidate: noInvalidate,
        log: silent,
        jevEffective: jevOff,
      },
    );
    expect(out).toMatchObject({ ran: true, rowId: 11 });
    expect(workerRuns).toBe(1);
  });

  it('skips with flag-off and never benches when the flag is OFF', async () => {
    let benched = 0;
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-1', installSlug: 'op' },
      {
        flag: async () => false,
        runBench: async () => {
          benched += 1;
          return METRICS;
        },
        record: async () => 1,
        history: noHistory,
        escalateRecall: noEscalate,
        log: silent,
        jevEffective: jevOff,
      },
    );
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(benched).toBe(0);
  });

  it('runs the bench, records the row, fires invalidation', async () => {
    let recordedWs = '';
    let invalidated = 0;
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-9', installSlug: 'op' },
      {
        flag: async () => true,
        runBench: async () => METRICS,
        record: async (ws) => {
          recordedWs = ws;
          return 7;
        },
        invalidate: () => {
          invalidated += 1;
        },
        history: noHistory,
        escalateRecall: noEscalate,
        log: silent,
        jevEffective: jevOff,
      },
    );
    expect(out.ran).toBe(true);
    if (out.ran) {
      expect(out.rowId).toBe(7);
      expect(out.metrics.fpAt5).toBe(0.17);
    }
    expect(recordedWs).toBe('ws-9');
    expect(invalidated).toBe(1);
  });

  it('returns a non-fatal failed outcome when the bench throws (never wedges the tick)', async () => {
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-1', installSlug: 'op' },
      {
        flag: async () => true,
        runBench: async () => {
          throw new Error('no embedder');
        },
        record: async () => 1,
        history: noHistory,
        escalateRecall: noEscalate,
        log: silent,
        jevEffective: jevOff,
      },
    );
    expect(out.ran).toBe(false);
    if (!out.ran) {
      expect(out.skipReason).toBe('failed');
      expect('error' in out && out.error).toContain('no embedder');
    }
  });

  it('returns a non-fatal failed outcome when the record write throws', async () => {
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-1', installSlug: 'op' },
      {
        flag: async () => true,
        runBench: async () => METRICS,
        record: async () => {
          throw new Error('pg down');
        },
        history: noHistory,
        escalateRecall: noEscalate,
        log: silent,
        jevEffective: jevOff,
      },
    );
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.skipReason).toBe('failed');
  });

  describe('EI-10047: recall-drop baseline + escalation', () => {
    it('a healthy baseline + a healthy run: evaluates ok, escalated as a non-alert (resolve path)', async () => {
      let seen: { workspaceId: string; backend: string; rowId: number; evaluation: RecallDropEvaluation } | null = null;
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => METRICS, // rAt10 = 0.82
          record: async () => 5,
          // WI-7215: priors carry the admission shape they were measured under.
          // METRICS/crashed both have notes:null, so these priors are tagged
          // null to stay COMPARABLE — that is what keeps this case a real
          // baseline-drop test rather than an insufficient-history one.
          history: async () => [0.8, 0.81, 0.83, 0.82, 0.8].map((rAt10) => ({ rAt10, shape: null })),
          escalateRecall: async (workspaceId, backend, rowId, evaluation) => {
            seen = { workspaceId, backend, rowId, evaluation };
          },
          invalidate: noInvalidate,
          log: silent,
          jevEffective: jevOff,
        },
      );
      expect(out.ran).toBe(true);
      expect(seen).not.toBeNull();
      expect(seen!.evaluation.alert).toBe(false);
      expect(seen!.evaluation.reason).toBe('ok');
      expect(seen!.rowId).toBe(5);
      expect(seen!.workspaceId).toBe('ws-1');
    });

    it('a healthy baseline + a collapsed run (the motivating age A/B schema-drift incident): alerts', async () => {
      let seen: RecallDropEvaluation | null = null;
      const crashed: MemoryPrecisionMetrics = { ...METRICS, rAt10: 0 }; // degrade-never-throw → r@10 collapses to 0, not a thrown error
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => crashed,
          record: async () => 6,
          // WI-7215: priors carry the admission shape they were measured under.
          // METRICS/crashed both have notes:null, so these priors are tagged
          // null to stay COMPARABLE — that is what keeps this case a real
          // baseline-drop test rather than an insufficient-history one.
          history: async () => [0.8, 0.81, 0.83, 0.82, 0.8].map((rAt10) => ({ rAt10, shape: null })),
          escalateRecall: async (_ws, _b, _row, evaluation) => {
            seen = evaluation;
          },
          invalidate: noInvalidate,
          log: silent,
          jevEffective: jevOff,
        },
      );
      expect(out.ran).toBe(true); // the bench+record path succeeds — a bad METRIC is not a tool failure
      expect(seen).not.toBeNull();
      expect(seen!.alert).toBe(true);
      expect(seen!.reason).toBe('baseline-drop');
    });

    it('no history yet: never alerts on baseline-drop even with a mediocre run', async () => {
      let seen: RecallDropEvaluation | null = null;
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => ({ ...METRICS, rAt10: 0.6 }),
          record: async () => 1,
          history: async () => [],
          escalateRecall: async (_ws, _b, _row, evaluation) => {
            seen = evaluation;
          },
          invalidate: noInvalidate,
          log: silent,
          jevEffective: jevOff,
        },
      );
      expect(out.ran).toBe(true);
      expect(seen!.reason).toBe('insufficient-history');
      expect(seen!.alert).toBe(false);
    });

    it('a history-read failure degrades to no-baseline (never wedges the run, never fails it)', async () => {
      let seen: RecallDropEvaluation | null = null;
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => METRICS,
          record: async () => 2,
          history: async () => {
            throw new Error('pg down');
          },
          escalateRecall: async (_ws, _b, _row, evaluation) => {
            seen = evaluation;
          },
          invalidate: noInvalidate,
          log: silent,
          jevEffective: jevOff,
        },
      );
      expect(out.ran).toBe(true);
      expect(seen!.reason).toBe('insufficient-history');
    });

    it('an escalation failure never turns a good bench run into a failed outcome', async () => {
      const out = await runMemoryPrecisionMonitor(
        { workspaceId: 'ws-1', installSlug: 'op' },
        {
          flag: async () => true,
          runBench: async () => METRICS,
          record: async () => 3,
          history: noHistory,
          escalateRecall: async () => {
            throw new Error('EI create failed');
          },
          invalidate: noInvalidate,
          log: silent,
          jevEffective: jevOff,
        },
      );
      expect(out.ran).toBe(true);
      if (out.ran) expect(out.rowId).toBe(3);
    });

    // Note: `history`/`escalateRecall`, left unset, fall back to real
    // getOrgPg()-backed defaults (mirroring `record`'s own existing default,
    // which is likewise never exercised without an override in this suite —
    // this file stays fully dep-injected/PG-free by convention).
  });
});

describe('precision bench worker protocol', () => {
  const ledgerRecord = {
    provider: 'typesafe',
    requestedModel: 'jev-1.13.0',
    request: {
      state: 'private memory text that must stay in the worker',
      questions: { m1: { type: 'yesNo', instructions: 'Is this relevant?' } },
    },
    outcome: { kind: 'inconclusive', reason: 'unauthorized', status: 401, latencyMs: 12, attempts: 1 },
    startedAt: new Date('2026-10-06T10:00:00Z'),
    consumer: 'memory-bench',
    surface: null,
    subjectIds: ['memory-1'],
    hostLoad: null,
    transportLatencyMs: null,
  } as unknown as DecisionCallRecord;
  const ledgerEntry = toDecisionLedgerEntry(ledgerRecord);

  it('resolves the bundled sibling from the relocated host entry and runs it with plain Node', () => {
    const moduleUrl = new URL('../../../../../apps/operator/dist-host/hono-host.mjs', import.meta.url).href;
    const target = resolvePrecisionBenchWorkerTarget(moduleUrl, (path) => path.endsWith('precision-bench-worker.mjs'));

    expect(target).toMatchObject({ path: expect.stringContaining('precision-bench-worker.mjs'), runtime: 'node' });
    expect(
      precisionBenchWorkerInvocation(target, '/runtime/node', '/runtime/tsx'),
    ).toEqual({ command: '/runtime/node', args: [target.path] });
  });

  it('keeps source-mode development on the TypeScript worker through tsx', () => {
    const moduleUrl = new URL('./precision-monitor.ts', import.meta.url).href;
    const target = resolvePrecisionBenchWorkerTarget(moduleUrl, () => false);

    expect(target).toMatchObject({ path: expect.stringContaining('precision-bench-worker.ts'), runtime: 'tsx' });
    expect(
      precisionBenchWorkerInvocation(target, '/runtime/node', '/runtime/tsx'),
    ).toEqual({ command: '/runtime/node', args: ['/runtime/tsx', target.path] });
  });

  it('parses the marked result while ignoring unrelated child logs', () => {
    const parsed = parsePrecisionBenchWorkerOutput(
      `startup log\n${PRECISION_BENCH_RESULT_MARKER}${JSON.stringify(METRICS)}\n`,
    );
    expect(parsed).toEqual(METRICS);
  });

  it('reports the last worker phase and bounded, redacted output when the worker times out', async () => {
    const childEmitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const secret = 'openai-secret-for-timeout-test';
    const kill = vi.fn((_signal?: NodeJS.Signals) => {
      setImmediate(() => {
        stdout.end();
        stderr.end();
        childEmitter.emit('close', null, 'SIGTERM');
      });
      return true;
    });
    const child = Object.assign(childEmitter, { stdout, stderr, kill });
    const spawnProcess = (() => {
      process.nextTick(() => {
        stdout.write(`${PRECISION_BENCH_PROGRESS_MARKER}${JSON.stringify({
          phase: 'seed-corpus',
          status: 'started',
          at: '2026-11-05T19:00:00.000Z',
          expectedRows: 114,
        })}\n`);
        stdout.write(`${'x'.repeat(1_600)}STDOUT_TAIL`);
        stderr.write(`${'y'.repeat(1_600)}STDERR_TAIL ${secret}`);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    let failure: unknown;
    try {
      await runBenchInWorker({
        spawnProcess,
        timeoutMs: 20,
        embedderMode: 'local',
        resolveWorkerCredentials: async () => ({ openai_api_key: secret }),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('precision bench worker timed out after 20ms');
    expect(message).toContain('last phase: seed-corpus/started');
    expect(message).toContain('expectedRows=114');
    expect(message).toContain('stdout tail:');
    expect(message).toContain('STDOUT_TAIL');
    expect(message).toContain('stderr tail:');
    expect(message).toContain('STDERR_TAIL');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('x'.repeat(1_300));
    expect(message.length).toBeLessThan(3_000);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(parsePrecisionBenchWorkerProgress(
      `${PRECISION_BENCH_PROGRESS_MARKER}{"phase":"seed-corpus","status":"started","at":"2026-11-05T19:00:00.000Z","expectedRows":114}`,
    )).toMatchObject({ phase: 'seed-corpus', status: 'started', expectedRows: 114 });
  });

  it('fails loudly when the child exits without a result marker', () => {
    expect(() => parsePrecisionBenchWorkerOutput('seed failed\n')).toThrow(/no result marker/);
  });

  it('parses only sanitized ledger entries from the child marker protocol', () => {
    const parsed = parsePrecisionBenchWorkerLedgerEntries(
      `startup log\n${PRECISION_BENCH_JEV_LEDGER_MARKER}${JSON.stringify(ledgerEntry)}\n`,
    );
    expect(parsed).toEqual([ledgerEntry]);
    expect(JSON.stringify(parsed)).not.toContain('private memory text');
    expect(parsed[0]).not.toHaveProperty('request');
  });

  it('writes parsed worker ledger entries and evaluates refusal alerts on the host', async () => {
    const recorded: unknown[] = [];
    const alerted: unknown[] = [];
    await persistPrecisionBenchWorkerLedgerEntries([ledgerEntry], 'ws-worker', {
      record: async (entry, options) => { recorded.push({ entry, options }); return true; },
      alert: async (entry, deps) => { alerted.push({ entry, workspaceId: deps?.workspaceId?.() }); return true; },
      log: () => {},
    });
    expect(recorded).toEqual([{ entry: ledgerEntry, options: { workspaceId: 'ws-worker' } }]);
    expect(alerted).toEqual([{ entry: ledgerEntry, workspaceId: 'ws-worker' }]);
  });

  it('tells the worker explicitly whether to gate, so an inherited value can never gate a floor-only run', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    let keyReads = 0;
    const spawnProcess = ((_cmd: string, _args: string[], o: { env: NodeJS.ProcessEnv }) => {
      seen.push({
        jevGate: o.env[PRECISION_BENCH_JEV_GATE_ENV],
        mode: o.env[PRECISION_BENCH_EMBEDDER_MODE_ENV],
        openai: o.env.OPENAI_API_KEY,
        anthropic: o.env.ANTHROPIC_API_KEY,
        jevApiKey: o.env[PRECISION_BENCH_JEV_API_KEY_ENV],
        workspaceId: o.env[PRECISION_BENCH_WORKSPACE_ID_ENV],
        rawJevApiKey: o.env.TYPESAFE_API_KEY,
      });
      throw new Error('stop before spawning');
    }) as unknown as typeof import('node:child_process').spawn;
    const prior = process.env[PRECISION_BENCH_JEV_GATE_ENV];
    const priorApiKey = process.env[PRECISION_BENCH_JEV_API_KEY_ENV];
    const priorWorkspaceId = process.env[PRECISION_BENCH_WORKSPACE_ID_ENV];
    const priorTypesafeKey = process.env.TYPESAFE_API_KEY;
    process.env[PRECISION_BENCH_JEV_GATE_ENV] = '1';
    process.env[PRECISION_BENCH_JEV_API_KEY_ENV] = 'inherited-worker-key';
    process.env[PRECISION_BENCH_WORKSPACE_ID_ENV] = 'inherited-workspace';
    process.env.TYPESAFE_API_KEY = 'raw-host-key';
    try {
      const run = (jevGate = false) => runBenchInWorker({
        spawnProcess,
        jevGate,
        workspaceId: 'ws-worker',
        embedderMode: 'local',
        resolveWorkerCredentials: async () => ({
          openai_api_key: 'stored-openai-key',
          anthropic_api_key: 'stored-anthropic-key',
        }),
        resolveWorkerJevApiKey: async () => { keyReads += 1; return 'stored-typesafe-key'; },
      });
      await expect(run()).rejects.toThrow(/stop before spawning/);
      await expect(run(true)).rejects.toThrow(/stop before spawning/);
    } finally {
      if (prior === undefined) delete process.env[PRECISION_BENCH_JEV_GATE_ENV];
      else process.env[PRECISION_BENCH_JEV_GATE_ENV] = prior;
      if (priorApiKey === undefined) delete process.env[PRECISION_BENCH_JEV_API_KEY_ENV];
      else process.env[PRECISION_BENCH_JEV_API_KEY_ENV] = priorApiKey;
      if (priorWorkspaceId === undefined) delete process.env[PRECISION_BENCH_WORKSPACE_ID_ENV];
      else process.env[PRECISION_BENCH_WORKSPACE_ID_ENV] = priorWorkspaceId;
      if (priorTypesafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = priorTypesafeKey;
    }
    expect(seen).toEqual([
      { jevGate: '0', mode: 'local', openai: 'stored-openai-key', anthropic: 'stored-anthropic-key', jevApiKey: undefined, workspaceId: undefined, rawJevApiKey: undefined },
      { jevGate: '1', mode: 'local', openai: 'stored-openai-key', anthropic: 'stored-anthropic-key', jevApiKey: 'stored-typesafe-key', workspaceId: 'ws-worker', rawJevApiKey: undefined },
    ]);
    expect(keyReads).toBe(1);
  });
});

// ─── P-008: the monitor measures the Jev-GATED push path when the switch is On ───

describe('runMemoryPrecisionMonitor — which path it measures (P-008)', () => {
  const runWith = async (jevEffective: () => Promise<'off' | 'shadow' | 'on'>) => {
    const asked: PrecisionBenchRunOptions[] = [];
    await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-jev', installSlug: 'op' },
      {
        flag: async () => true,
        jevEffective,
        runBench: async (o) => {
          asked.push(o);
          return METRICS;
        },
        record: async () => 1,
        history: noHistory,
        escalateRecall: noEscalate,
        invalidate: noInvalidate,
        log: silent,
      },
    );
    return asked;
  };

  it('gates only when the EFFECTIVE mode is On (mode on AND a key stored)', async () => {
    expect(await runWith(async () => 'on')).toEqual([{ jevGate: true }]);
  });

  it('measures the floor alone in Log only and Off, because that is what the injector admits there', async () => {
    expect(await runWith(async () => 'shadow')).toEqual([{ jevGate: false }]);
    expect(await runWith(async () => 'off')).toEqual([{ jevGate: false }]);
  });

  it('an unreadable Jev setting measures the floor alone and still records', async () => {
    expect(
      await runWith(async () => {
        throw new Error('pg down');
      }),
    ).toEqual([{ jevGate: false }]);
  });
});

function outcome(queryId: string, ids: string[], expected: string[] = []): QueryOutcome {
  const candidates = ids.map((id) => ({ id, key: `k-${id}`, text: `memory ${id}`, score: 0.6 }));
  return {
    queryId,
    class: expected.length === 0 ? 'hard-negative' : 'paraphrase',
    expected,
    rankedKeys: candidates.map((c) => c.key),
    rawHits: candidates.length,
    candidates,
    ms: 3,
  } as QueryOutcome;
}

describe('gateReplayWithJev (P-008)', () => {
  const texts = new Map([
    ['q1', 'where does deploy run'],
    ['q2', 'an off-topic question'],
    ['q3', 'nothing came back'],
  ]);

  it('keeps exactly the candidates the gate keeps, in retrieval order, and labels its calls memory-bench', async () => {
    const calls: JevMemoryGateInput[] = [];
    const gate = async (input: JevMemoryGateInput) => {
      calls.push(input);
      return { effective: 'on', outcome: 'answered', model: 'jev-1.13.0', scores: [0.9, 0.1, 0.8], keep: [true, false, true] } as const;
    };
    const r = await gateReplayWithJev([outcome('q1', ['a', 'b', 'c'], ['k-a'])], texts, gate);
    expect(r.outcomes[0].candidates?.map((c) => c.id)).toEqual(['a', 'c']);
    expect(r.outcomes[0].rankedKeys).toEqual(['k-a', 'k-c']);
    expect(r.outcomes[0].rawHits).toBe(2);
    expect(calls).toEqual([
      { message: 'where does deploy run', consumer: PRECISION_BENCH_JEV_CONSUMER, candidates: ['a', 'b', 'c'].map((id) => ({ id, text: `memory ${id}` })) },
    ]);
    expect(r.stats).toMatchObject({ model: 'jev-1.13.0', judged: 1, answered: 1, inconclusive: 0, dropped: 1 });
  });

  it('fails OPEN on an inconclusive verdict (keeps today\'s set) and counts the reason', async () => {
    const gate = async () => ({ effective: 'on', outcome: 'inconclusive', reason: 'timeout' }) as const;
    const input = outcome('q2', ['x', 'y']);
    const r = await gateReplayWithJev([input], texts, gate);
    expect(r.outcomes[0]).toBe(input);
    expect(r.stats).toMatchObject({ model: null, judged: 1, answered: 0, inconclusive: 1, reasons: { timeout: 1 }, dropped: 0 });
  });

  it('makes no call for a query the floor admitted nothing for', async () => {
    let called = 0;
    const gate = async () => {
      called += 1;
      return { effective: 'off' } as const;
    };
    const r = await gateReplayWithJev([outcome('q3', [])], texts, gate);
    expect(called).toBe(0);
    expect(r.stats.judged).toBe(0);
  });

  it('refuses a verdict whose keep list does not line up with the candidates', async () => {
    const gate = async () => ({ effective: 'on', outcome: 'answered', model: 'jev-1.13.0', scores: [0.9], keep: [true] }) as const;
    await expect(gateReplayWithJev([outcome('q1', ['a', 'b'], ['k-a'])], texts, gate)).rejects.toThrow(/1 verdicts for 2 candidates/);
  });

  it('names every model that answered, so a served-model change inside one run is visible', async () => {
    let n = 0;
    const gate = async () => {
      n += 1;
      return { effective: 'on', outcome: 'answered', model: n === 1 ? 'jev-1.14.0' : 'jev-1.13.0', scores: [0.9], keep: [true] } as const;
    };
    const r = await gateReplayWithJev([outcome('q1', ['a'], ['k-a']), outcome('q2', ['b'])], texts, gate, 1);
    expect(r.stats.model).toBe('jev-1.13.0+jev-1.14.0');
  });
});

describe('precision worker Jev gate', () => {
  it('uses the injected key and emits only the sanitized decision ledger projection', async () => {
    const emitted: unknown[] = [];
    const gate = createPrecisionBenchJevGate({
      workspaceId: 'ws-worker',
      apiKey: 'worker-typesafe-key',
      fetch: async (_url, init) => {
        const request = JSON.parse(init.body) as { questions: Record<string, unknown> };
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: 0.9 }]));
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ model: 'jev-1.13.0', answers }),
        };
      },
      onLedgerEntry: (entry) => { emitted.push(entry); },
    });

    const result = await gate({
      message: 'private user prompt',
      candidates: [{ id: 'memory-a', text: 'private candidate memory text' }],
      consumer: PRECISION_BENCH_JEV_CONSUMER,
    });

    expect(result).toMatchObject({ effective: 'on', outcome: 'answered', keep: [true], model: 'jev-1.13.0' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ consumer: 'memory-bench', subjectIds: ['memory-a'], outcome: 'answered' });
    expect(emitted[0]).not.toHaveProperty('request');
    expect(JSON.stringify(emitted)).not.toContain('private user prompt');
    expect(JSON.stringify(emitted)).not.toContain('private candidate memory text');
  });
});

describe('the gated shape tag (P-008)', () => {
  it('round-trips through parseJevGateShape, which the Learning tab reads', () => {
    // The threshold is production's operating point (D-004 moved it 0.3 -> 0.35), so
    // the tag follows the constant; the format around it is what this pins.
    const notes = jevGatedShape('cosine-gated', 'jev-1.13.0');
    expect(notes).toBe(`fusionMode:cosine-gated;jev:jev-1.13.0/instructions@${JEV_MEMORY_ADMIT_THRESHOLD}`);
    expect(parseJevGateShape(notes)).toEqual({ model: 'jev-1.13.0', encoding: 'instructions', threshold: JEV_MEMORY_ADMIT_THRESHOLD });
  });

  it('reads every floor-only and pre-P-008 tag as not gated', () => {
    expect(parseJevGateShape('fusionMode:cosine-gated')).toBeNull();
    expect(parseJevGateShape(null)).toBeNull();
    expect(parseJevGateShape('')).toBeNull();
  });
});

describe('runMemoryPrecisionMonitor attempt ledger (WI-10004133)', () => {
  const base = { invalidate: () => {}, history: async () => [], escalateRecall: async () => {}, jevEffective: async () => 'off' as const, log: () => {} };
  const capture = (into: unknown[]) => async (ws: string, attempt: unknown) => { into.push({ ws, attempt }); };

  it('records exactly one attempt per fire, naming the outcome and, on failure, the stage and error', async () => {
    const cases: Array<{ deps: MemoryPrecisionBenchDeps; expected: unknown; outcome: Record<string, unknown> }> = [
      { deps: { flag: async () => false }, expected: { outcome: 'flag-off' }, outcome: { ran: false, skipReason: 'flag-off' } },
      {
        deps: { flag: async () => true, runBench: async () => { throw new Error('worker timed out'); }, record: async () => 1 },
        expected: { outcome: 'failed', stage: 'bench', error: 'worker timed out', jevGate: false },
        outcome: { ran: false, skipReason: 'failed', stage: 'bench', error: 'worker timed out' },
      },
      {
        deps: { flag: async () => true, runBench: async () => METRICS, record: async () => { throw new Error('pg down'); } },
        expected: { outcome: 'failed', stage: 'record', error: 'pg down', jevGate: false },
        outcome: { ran: false, skipReason: 'failed', stage: 'record', error: 'pg down' },
      },
      {
        deps: { flag: async () => true, runBench: async () => METRICS, record: async () => 42 },
        expected: { outcome: 'recorded', rowId: 42, jevGate: false },
        outcome: { ran: true, rowId: 42 },
      },
    ];
    for (const c of cases) {
      const captured: unknown[] = [];
      const out = await runMemoryPrecisionMonitor({ workspaceId: 'ws-a', installSlug: 'op' }, { ...base, ...c.deps, recordAttempt: capture(captured) });
      expect(out).toMatchObject(c.outcome);
      expect(captured).toEqual([{ ws: 'ws-a', attempt: c.expected }]);
    }
  });

  it('marks the attempt Jev-gated when the workspace switch is effectively On', async () => {
    const captured: unknown[] = [];
    await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-a', installSlug: 'op' },
      { ...base, jevEffective: async () => 'on', flag: async () => true, runBench: async () => { throw new Error('x'); }, record: async () => 1, recordAttempt: capture(captured) },
    );
    expect(captured).toEqual([{ ws: 'ws-a', attempt: { outcome: 'failed', stage: 'bench', error: 'x', jevGate: true } }]);
  });

  it('a failing attempt write never changes the outcome or throws into the routine tick', async () => {
    const logs: string[] = [];
    const out = await runMemoryPrecisionMonitor(
      { workspaceId: 'ws-a', installSlug: 'op' },
      { ...base, log: (m) => logs.push(m), flag: async () => true, runBench: async () => METRICS, record: async () => 7,
        recordAttempt: async () => { throw new Error('relation does not exist'); } },
    );
    expect(out).toMatchObject({ ran: true, rowId: 7 });
    expect(logs.some((l) => l.includes('attempt record failed') && l.includes('relation does not exist'))).toBe(true);
  });
});
