/**
 * Unit tests for Baseline B — the native-harness runner (P-007 / BRIEF 5). Driven entirely through
 * a FAKE `claude` event stream + fake clone/diff ports (hive-eval live-ports pattern), so the arm's
 * accounting + fairness invariants are verified without a real `claude` spawn / git / Docker:
 *   - the shared ArmAttempt shape (arm 'baseline-b-native') + the {modality:'diff'} submission
 *   - token / cost / turns / cache accounting off the result event (reported AND estimated cost)
 *   - the METR retry-on-infra path (transient → retry on a fresh checkout; permanent → not retried)
 *   - infra-exclusion (clone fail / diff-extract fail → stopReason 'error', empty diff)
 *   - the iso-budget `capped` post-check via the SHARED budgetExceeded
 *   - the M2/Harbor scaffold (native arm via Harbor's built-in claude-code agent) + result parser
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatEvent, RunAgentChatOptions, TurnError } from '../agent-chat-stream';
import { BASELINE_B_ARM, NATIVE_BLUEPRINT_ID, buildNativeHarnessPrompt } from './native-harness-config';
import { runNativeHarnessAttempt, type NativeHarnessPorts } from './native-harness-runner';
import {
  HARBOR_BLUEPRINT_ID,
  parseHarborResult,
  runNativeHarnessTerminalBench,
  TERMINAL_BENCH_DATASET_ID,
  type HarborResult,
  type HarborRunSpec,
} from './native-harness-terminal-bench';
import { liveNativeHarnessPorts } from './native-harness-live';
import { cloneTaskRepo, extractDiff } from './clone';
import { diffSubmission, type BenchTask, type GenerationBudget } from './types';
import { benchDefaultModelId } from './model-registry-snapshot';

const PATCH = 'diff --git a/src/f.py b/src/f.py\n@@ -1 +1 @@\n-bug\n+fix\n';

function task(over: Partial<BenchTask> = {}): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: 'instance_demo__demo-1',
    problemStatement: 'The widget crashes on empty input — make it return [] instead.',
    repo: 'demo/demo',
    baseCommit: 'abc1234',
    graderMeta: { dockerhub_tag: 'demo-1', FAIL_TO_PASS: ['t1'], testFiles: ['tests/test_widget.py'] },
    ...over,
  };
}

/** An async stream of scripted ChatEvents — stands in for `runAgentChat({backend:'claude-code'})`. */
async function* streamOf(events: ChatEvent[]): AsyncGenerator<ChatEvent> {
  for (const ev of events) yield ev;
}

/** A spawn port that returns a fresh scripted stream per call (later calls reuse the last batch). */
function makeSpawn(...batches: ChatEvent[][]) {
  const calls: RunAgentChatOptions[] = [];
  let i = 0;
  const fn: NativeHarnessPorts['spawnAgent'] = (opts) => {
    calls.push(opts);
    const batch = batches[Math.min(i, batches.length - 1)] ?? [];
    i += 1;
    return streamOf(batch);
  };
  return Object.assign(fn, { calls });
}

const resultEv = (over: Partial<Extract<ChatEvent, { type: 'result' }>> = {}): ChatEvent => ({
  type: 'result',
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  finalText: 'done',
  ...over,
});
const toolEv = (name = 'Edit'): ChatEvent => ({ type: 'tool_call', name, input: {} });
const transientTurn = (retryAfterMs?: number): TurnError =>
  ({ class: 'rate_limited', message: 'rate limited', provider: 'anthropic', retryable: true, surfaceToUser: false, ...(retryAfterMs ? { retryAfterMs } : {}) } as TurnError);
const permanentTurn = (): TurnError =>
  ({ class: 'permanent', message: 'bad request', provider: 'anthropic', retryable: false, surfaceToUser: true } as TurnError);

/** Fake ports with sensible defaults; override per test. Tracks clone/cleanup/sleep calls. */
function makePorts(over: Partial<NativeHarnessPorts> = {}) {
  const cleanup = vi.fn(async () => {});
  const clone = vi.fn(async (t: BenchTask) => ({
    dir: '/tmp/extbench-fake',
    repo: t.repo ?? 'demo/demo',
    baseCommit: t.baseCommit ?? 'abc1234',
    cleanup,
  }));
  const extractDiff = vi.fn(async () => PATCH);
  const harnessVersion = vi.fn(async () => 'claude-code/2.1.3 (Claude Code)');
  const persistTrajectory = vi.fn(async () => 'traj-ref-1');
  const sleep = vi.fn(async () => {});
  let clock = 1000;
  const now = () => (clock += 10);
  const ports: NativeHarnessPorts = {
    clone,
    extractDiff,
    spawnAgent: makeSpawn([toolEv(), toolEv(), resultEv({ tokensIn: 1200, tokensOut: 3400, costUsd: 0.42, numTurns: 7, cacheReadTokens: 50000, cacheCreationTokens: 8000 })]),
    harnessVersion,
    persistTrajectory,
    sleep,
    now,
    ...over,
  };
  return { ports, clone, cleanup, extractDiff, sleep, persistTrajectory };
}

describe('runNativeHarnessAttempt — M1 (diff-batch) native arm', () => {
  it('produces the shared ArmAttempt + diff submission with reported cost/turns/cache', async () => {
    const { ports, cleanup, persistTrajectory } = makePorts();
    const res = await runNativeHarnessAttempt(task(), '0', {}, ports);

    expect(res.attempt.arm).toBe(BASELINE_B_ARM);
    expect(res.attempt.arm).toBe('baseline-b-native');
    expect(res.attempt.blueprintId).toBe(NATIVE_BLUEPRINT_ID);
    expect(res.attempt.instanceId).toBe('instance_demo__demo-1');
    expect(res.attempt.seed).toBe('0');
    expect(res.attempt.diff).toBe(PATCH);
    expect(res.attempt.stopReason).toBe('done');
    expect(res.attempt.tokensIn).toBe(1200);
    expect(res.attempt.tokensOut).toBe(3400);
    expect(res.attempt.costUsd).toBe(0.42); // Claude's reported total_cost_usd wins
    expect(res.attempt.turns).toBe(7); // from num_turns, not the 2 tool_calls
    expect(res.attempt.trajectoryRef).toBe('traj-ref-1');
    expect(res.attempt.generationError).toBeUndefined();

    // R-9: the default model is the registry-resolved benchmark default, never a literal.
    expect(res.model).toBe(benchDefaultModelId());
    expect(res.harnessVersion).toBe('claude-code/2.1.3 (Claude Code)');
    expect(res.capped).toBe(false);
    expect(res.armMeta).toMatchObject({
      backend: 'claude-code',
      harness: 'native',
      costSource: 'reported',
      toolCalls: 2,
      retriesUsed: 0,
      tokensCacheRead: 50000,
      tokensCacheWrite: 8000,
    });

    // The grader sees the identical {modality:'diff'} record every arm emits.
    expect(diffSubmission(res.attempt)).toEqual({ modality: 'diff', instanceId: 'instance_demo__demo-1', patch: PATCH, prefix: '0' });
    expect(persistTrajectory).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('spawns vanilla Claude Code in the checkout — bypass perms, isolated config, native sampling', async () => {
    const spawn = makeSpawn([resultEv({ tokensIn: 1, tokensOut: 1, costUsd: 0.01, numTurns: 1 })]);
    const { ports } = makePorts({ spawnAgent: spawn });
    await runNativeHarnessAttempt(task(), '0', {}, ports, { model: 'claude-opus-4-8' });
    const opts = spawn.calls[0];
    expect(opts.backend).toBe('claude-code');
    expect(opts.cwd).toBe('/tmp/extbench-fake');
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.isolateConfig).toBe(true);
    expect(opts.model).toBe('claude-opus-4-8');
    // Native sampling: we must NOT pin temperature/maxTokens (the headline-baseline fairness point).
    expect(opts.temperature).toBeUndefined();
    expect(opts.maxTokens).toBeUndefined();
    // The prompt carries the issue but never the hidden-test grader metadata.
    expect(opts.promptText).toContain('widget crashes on empty input');
    expect(opts.promptText).not.toContain('FAIL_TO_PASS');
  });

  it('falls back to tool-call count for turns, and to list-price cost when none is reported', async () => {
    const { ports } = makePorts({
      spawnAgent: makeSpawn([toolEv(), toolEv(), toolEv(), resultEv({ tokensIn: 1_000_000, tokensOut: 1_000_000, costUsd: 0 })]),
    });
    // Pin a concrete model so the list-price arithmetic below is independent of the moving registry default.
    const res = await runNativeHarnessAttempt(task(), '1', {}, ports, { model: 'claude-opus-4-8' });
    expect(res.attempt.turns).toBe(3); // no num_turns → proxy off the 3 tool_calls
    // claude-opus-4-8 = $5/MTok in + $25/MTok out → 1M+1M tokens = $5 + $25 = $30.
    expect(res.attempt.costUsd).toBeCloseTo(30, 5);
    expect(res.armMeta.costSource).toBe('estimated');
  });

  it('retries a TRANSIENT infra failure on a fresh checkout (METR), honoring retryAfterMs', async () => {
    const { ports, clone, sleep } = makePorts({
      spawnAgent: makeSpawn(
        [{ type: 'error', message: 'rate limited', turn: transientTurn(500) }],
        [toolEv(), resultEv({ tokensIn: 10, tokensOut: 20, costUsd: 0.5, numTurns: 2 })],
      ),
    });
    const res = await runNativeHarnessAttempt(task(), '0', {}, ports, { maxRetries: 2, retryBackoffMs: 9999, maxRetryWaitMs: 60000 });
    expect(res.attempt.stopReason).toBe('done');
    expect(res.attempt.diff).toBe(PATCH);
    expect(res.attempt.tokensIn).toBe(10);
    expect(res.armMeta.retriesUsed).toBe(1);
    expect(clone).toHaveBeenCalledTimes(2); // fresh checkout per attempt
    expect(sleep).toHaveBeenCalledExactlyOnceWith(500); // honored retryAfterMs, not the 9999 backoff
  });

  it('does NOT retry a permanent failure and excludes it from accuracy (empty diff, stopReason error)', async () => {
    const { ports, clone, sleep } = makePorts({
      spawnAgent: makeSpawn([{ type: 'error', message: 'bad request', turn: permanentTurn() }]),
    });
    const res = await runNativeHarnessAttempt(task(), '0', {}, ports, { maxRetries: 2 });
    expect(res.attempt.stopReason).toBe('error');
    expect(res.attempt.diff).toBe('');
    expect(res.attempt.generationError).toContain('bad request');
    expect(res.armMeta.retriesUsed).toBe(0);
    expect(clone).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats a clone failure as infra error (excluded), not a task failure', async () => {
    const { ports } = makePorts({
      clone: vi.fn(async () => {
        throw new Error('network unreachable');
      }) as unknown as NativeHarnessPorts['clone'],
    });
    const res = await runNativeHarnessAttempt(task(), '0', {}, ports);
    expect(res.attempt.stopReason).toBe('error');
    expect(res.attempt.diff).toBe('');
    expect(res.attempt.tokensIn).toBe(0);
    expect(res.attempt.generationError).toContain('clone failed');
  });

  it('treats a diff-extraction failure as infra error (real cost telemetry preserved on the row)', async () => {
    const { ports } = makePorts({
      extractDiff: vi.fn(async () => {
        throw new Error('git diff exploded');
      }) as unknown as NativeHarnessPorts['extractDiff'],
    });
    const res = await runNativeHarnessAttempt(task(), '0', {}, ports);
    expect(res.attempt.stopReason).toBe('error');
    expect(res.attempt.diff).toBe('');
    expect(res.attempt.generationError).toContain('diff extraction failed');
  });

  it('flags capped=true via the shared budgetExceeded when the run overran the token cap', async () => {
    const budget: GenerationBudget = { maxTokens: 100, maxWallClockMs: 5000 };
    const { ports } = makePorts(); // default stream spends 1200+3400 tokens >> 100
    const res = await runNativeHarnessAttempt(task(), '0', budget, ports);
    expect(res.capped).toBe(true);
    expect(res.attempt.stopReason).toBe('done'); // a capped run that produced a diff is still graded
    expect(res.armMeta.budgetMaxWallClockMs).toBe(5000);
  });
});

describe('runNativeHarnessTerminalBench — M2 (Harbor built-in claude-code) scaffold', () => {
  const tbTask = () => task({ benchmark: 'terminal-bench', instanceId: 'tb__build-1', repo: undefined, baseCommit: undefined });

  it('runs Harbor and folds its in-sandbox grade into the run-result', async () => {
    const runHarbor = vi.fn(
      async (): Promise<HarborResult> => ({ resolved: true, tokensIn: 500, tokensOut: 900, costUsd: 0.1, turns: 4, wallClockMs: 1234, trajectoryRef: 'harbor/traj/1', harborVersion: 'terminal-bench@2.0+harbor1.3', raw: { passed: true } }),
    );
    const res = await runNativeHarnessTerminalBench(tbTask(), '0', { maxWallClockMs: 60000 }, { runHarbor });
    expect(res.attempt.arm).toBe('baseline-b-native');
    expect(res.attempt.blueprintId).toBe(HARBOR_BLUEPRINT_ID);
    expect(res.attempt.diff).toBe(''); // in-container — no diff
    expect(res.attempt.stopReason).toBe('done');
    expect(res.attempt.tokensIn).toBe(500);
    expect(res.submission).toEqual({ modality: 'in-container', instanceId: 'tb__build-1', envRef: 'harbor:tb__build-1:0', prefix: '0' });
    expect(res.grade.resolved).toBe(true);
    expect(res.grade.graderFamily).toBe('terminal-bench');
    expect(res.grade.graderError).toBeUndefined();
    expect(runHarbor).toHaveBeenCalledOnce();
  });

  it('surfaces a Harbor crash as infra error (excluded from accuracy, never thrown)', async () => {
    const runHarbor = vi.fn(async () => {
      throw new Error('docker daemon down');
    });
    const res = await runNativeHarnessTerminalBench(tbTask(), '0', {}, { runHarbor });
    expect(res.attempt.stopReason).toBe('error');
    expect(res.attempt.generationError).toContain('docker daemon down');
    expect(res.grade.graderError).toContain('docker daemon down');
    expect(res.grade.resolved).toBe(false);
  });

  const fakeHarbor = () =>
    vi.fn(async (spec: HarborRunSpec): Promise<HarborResult> => ({ resolved: true, harborVersion: `${spec.datasetId}+harbor1.3`, raw: {} }));

  it('runs the one pinned dataset by default and records exactly that pin', async () => {
    expect(TERMINAL_BENCH_DATASET_ID).toBe('terminal-bench@2.0');
    const runHarbor = fakeHarbor();
    const res = await runNativeHarnessTerminalBench(tbTask(), '0', {}, { runHarbor });
    expect(runHarbor.mock.calls[0]?.[0].datasetId).toBe(TERMINAL_BENCH_DATASET_ID);
    expect(res.grade.graderVersion).toBe(TERMINAL_BENCH_DATASET_ID);
    expect(res.harnessVersion).toBe(TERMINAL_BENCH_DATASET_ID);
  });

  it('records the dataset a task actually ran, not the default, when the task names its own', async () => {
    const runHarbor = fakeHarbor();
    const own = task({ ...tbTask(), graderMeta: { datasetId: 'terminal-bench-pro@1.0' } });
    const res = await runNativeHarnessTerminalBench(own, '0', {}, { runHarbor });
    expect(runHarbor.mock.calls[0]?.[0].datasetId).toBe('terminal-bench-pro@1.0');
    expect(res.grade.graderVersion).toBe('terminal-bench-pro@1.0');
    // A caller-supplied fuller version string still wins.
    const pinned = await runNativeHarnessTerminalBench(own, '0', {}, { runHarbor, harborVersion: 'terminal-bench-pro@1.0+harbor1.3' });
    expect(pinned.grade.graderVersion).toBe('terminal-bench-pro@1.0+harbor1.3');
  });
});

describe('parseHarborResult', () => {
  it('maps the documented fields + aliases', () => {
    expect(parseHarborResult({ resolved: true, usage: { input_tokens: 10, output_tokens: 20 }, total_cost_usd: 0.3, num_turns: 5, duration_ms: 900, trajectory_path: '/t' }, 'tb@2.0')).toEqual({
      resolved: true,
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.3,
      turns: 5,
      wallClockMs: 900,
      trajectoryRef: '/t',
      harborVersion: 'tb@2.0',
      raw: { resolved: true, usage: { input_tokens: 10, output_tokens: 20 }, total_cost_usd: 0.3, num_turns: 5, duration_ms: 900, trajectory_path: '/t' },
    });
  });

  it('is tolerant of missing fields and surfaces an infra error string', () => {
    const r = parseHarborResult({ passed: false, error: 'image build failed' }, 'tb@2.0');
    expect(r.resolved).toBe(false);
    expect(r.graderError).toBe('image build failed');
    expect(r.tokensIn).toBeUndefined();
  });
});

describe('buildNativeHarnessPrompt', () => {
  it('includes the issue and never leaks grader metadata', () => {
    const p = buildNativeHarnessPrompt(task());
    expect(p).toContain('widget crashes on empty input');
    expect(p).not.toContain('FAIL_TO_PASS');
    expect(p).not.toContain('dockerhub_tag');
  });
});

describe('liveNativeHarnessPorts', () => {
  it('binds the shared clone/diff ports and prefixes the probed claude version', async () => {
    const ports = liveNativeHarnessPorts({ versionProbe: async () => '2.1.3 (Claude Code)' });
    expect(ports.clone).toBe(cloneTaskRepo);
    expect(ports.extractDiff).toBe(extractDiff);
    expect(await ports.harnessVersion()).toBe('claude-code/2.1.3 (Claude Code)');
  });

  it('degrades to claude-code/unknown when the version probe throws (never aborts the run)', async () => {
    const ports = liveNativeHarnessPorts({
      versionProbe: async () => {
        throw new Error('claude not on PATH');
      },
    });
    expect(await ports.harnessVersion()).toBe('claude-code/unknown');
  });
});
