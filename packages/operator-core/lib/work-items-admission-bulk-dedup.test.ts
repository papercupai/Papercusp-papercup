import { LlmCallError } from '@papercusp/testing-shell/llm';
import { describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({ fetchGatewayHeadroom: vi.fn() }));
vi.mock('./inference-gateway/observability', () => gateway);
import { classifyHttpError } from './agent-chat-stream';
import { isTransientNetworkError } from './harness/routines/hetzner-orphan-frame-reaper';
import {
  assertAdmissionCensusRatchet,
  buildBulkDedupPrompt,
  bulkJudgeMaxTokens,
  type BulkDedupItem,
  BulkAdmissionBlockedError,
  classifyBulkModelFailure,
  defaultBulkDedupPreflight,
  guardBulkRecurrenceIdentity,
  isRetryableModelCallError,
  maxPairsForOutputBudget,
  runBulkJudgeCallWithDeadline,
  BulkJudgeCallTimeoutError,
  BULK_JUDGE_MAX_OUTPUT_TOKENS,
  BULK_JUDGE_TOKENS_PER_PAIR,
} from './work-items-admission-bulk-dedup';
import { admissionPairKey, parsePromoterJudgements, planPromoterDispositions } from './work-items-admission-promoter';
import type { PromoterItem, PromoterPair } from './work-items-admission-promoter';

function item(id: string, title = id): PromoterItem {
  return {
    id,
    title,
    summary: `${title} summary`,
    state: 'open',
    kind: 'change',
    admission: 'admitted',
    conditionKey: null,
    createdAtMs: 1,
  };
}

describe('buildBulkDedupPrompt', () => {
  it('reuses the promoter charter, emits each endpoint once, and labels ghost context read-only', () => {
    const a = item('a', 'Same failure');
    const b = item('b', 'Same failure again');
    const pair: PromoterPair = {
      pairKey: 'a::b',
      a,
      b,
      pendingIds: ['a', 'b'],
      signals: ['cosine'],
      cosine: 0.97,
    };
    const prompt = buildBulkDedupPrompt([pair], [item('g', 'Nearby context')]);

    expect(prompt.system).toContain('DUPLICATION ONLY');
    expect(prompt.system).toContain('r-finding-merge');
    expect(prompt.user.match(/## item a /g)).toHaveLength(1);
    expect(prompt.user.match(/## item b /g)).toHaveLength(1);
    expect(prompt.user).toContain('a::b | signals=cosine | cosine=0.9700');
    expect(prompt.user).toContain('READ-ONLY GHOST CONTEXT');
    expect(prompt.user).toContain('g | <title>Nearby context</title>');
  });
});

describe('guardBulkRecurrenceIdentity', () => {
  const duplicatePlan = (a: PromoterItem, b: PromoterItem) => {
    const pair: PromoterPair = {
      pairKey: admissionPairKey(a.id, b.id),
      a: a.id < b.id ? a : b,
      b: a.id < b.id ? b : a,
      pendingIds: [a.id, b.id],
      signals: ['title-key'],
      cosine: null,
    };
    return planPromoterDispositions(
      [a, b],
      [pair],
      [{ pairKey: pair.pairKey, verdict: 'r-finding-merge', reason: 'same producer finding' }],
    );
  };

  it('reselects a newer keyed successor over the older unkeyed canonical', () => {
    const historical = { ...item('EI-20630508400046931', 'Gym champion promoted'), createdAtMs: 1, watchdogKey: null };
    const keyed = {
      ...item('EI-22377526107135174', 'Gym champion promoted'),
      createdAtMs: 2,
      watchdogKey: 'gym-champion:h1:validator@beta',
    };
    const unguarded = duplicatePlan(historical, keyed);
    expect(unguarded.dispositions).toContainEqual({
      itemId: keyed.id,
      action: 'merge',
      canonicalId: historical.id,
    });

    const guarded = guardBulkRecurrenceIdentity(
      unguarded,
      new Map<string, BulkDedupItem>([
        [historical.id, historical],
        [keyed.id, keyed],
      ]),
    );
    // The reselected replacement carries admission 'admitted' (see the item() fixture),
    // so it is ALREADY claimable and gets no `promote` disposition: the promotion writer
    // only updates pending/unreviewed rows, and emitting one here would be a zero-row
    // conditional write inside the same transaction. Only a pending/unreviewed
    // replacement is promoted — asserted directly below so that contract stays pinned.
    expect(guarded.dispositions).toEqual([{ itemId: historical.id, action: 'merge', canonicalId: keyed.id }]);
    expect(guarded.dispositions).not.toContainEqual({ itemId: keyed.id, action: 'promote' });
    expect(guarded.adjudications[0]?.canonical).toBe(keyed.id);
  });

  it('DOES promote the reselected successor when it is still pending — the admitted case above is the only exemption', () => {
    const historical = { ...item('EI-20630508400046931', 'Gym champion promoted'), createdAtMs: 1, watchdogKey: null };
    const keyed = {
      ...item('EI-22377526107135174', 'Gym champion promoted'),
      admission: 'pending' as const,
      createdAtMs: 2,
      watchdogKey: 'gym-champion:h1:validator@beta',
    };
    const guarded = guardBulkRecurrenceIdentity(
      duplicatePlan(historical, keyed),
      new Map<string, BulkDedupItem>([
        [historical.id, historical],
        [keyed.id, keyed],
      ]),
    );
    // A pending replacement is NOT yet claimable, so the promotion writer has a row to
    // update and the disposition must be emitted. This is the control that keeps the
    // admitted-case exemption above honest: if promote were dropped unconditionally,
    // that assertion would still pass while this one fails.
    expect(guarded.dispositions).toContainEqual({ itemId: keyed.id, action: 'promote' });
    expect(guarded.adjudications[0]?.canonical).toBe(keyed.id);
  });

  it('fails closed when one duplicate component carries conflicting producer identities', () => {
    const validator = {
      ...item('EI-validator', 'Gym champion promoted'),
      watchdogKey: 'gym-champion:h1:validator@beta',
    };
    const reviewer = {
      ...item('EI-reviewer', 'Gym champion promoted'),
      watchdogKey: 'gym-champion:h1:reviewer@tx',
    };
    const plan = duplicatePlan(validator, reviewer);
    expect(() =>
      guardBulkRecurrenceIdentity(
        plan,
        new Map<string, BulkDedupItem>([
          [validator.id, validator],
          [reviewer.id, reviewer],
        ]),
      ),
    ).toThrow('conflicting stable producer identities');
  });
});

/**
 * The batch size and the output-token budget must be derived FROM EACH OTHER.
 * They were not: the batch defaulted to 150 pairs while the budget asked for
 * min(8000, 500 + 150*180) = min(8000, 27500) = 8000, so every full batch was
 * truncated mid-JSON. Parsing then failed identically on all 3 retries — the
 * failure is deterministic in batch size, so retrying could never help.
 * Measured on wi882767-opus5-20260829-stage-1: 12 model calls, 36 retries
 * (= every batch exhausted), 10 of 12 batches dead, 0 pairs merged, tokens_out
 * averaging 7,974 flush against the 8,000 ceiling.
 *
 * These cases pin the relationship rather than the constants, so the ceiling or
 * the per-pair estimate can be retuned without silently re-opening the bug.
 */
describe('bulk judge output-token budget', () => {
  it('never asks for a batch whose own judgements cannot fit the ceiling', () => {
    const pairs = maxPairsForOutputBudget();
    expect(bulkJudgeMaxTokens(pairs)).toBeLessThanOrEqual(BULK_JUDGE_MAX_OUTPUT_TOKENS);
    // and it is the LARGEST such batch — one more pair overflows, so the
    // derivation is tight rather than trivially conservative
    expect(bulkJudgeMaxTokens(pairs + 1)).toBeGreaterThan(BULK_JUDGE_MAX_OUTPUT_TOKENS);
  });

  it('holds the invariant across any ceiling, not just the configured one', () => {
    for (const ceiling of [1_000, 4_000, 8_000, 16_000, 64_000]) {
      const pairs = maxPairsForOutputBudget(ceiling);
      expect(pairs).toBeGreaterThanOrEqual(1);
      expect(bulkJudgeMaxTokens(pairs)).toBeLessThanOrEqual(ceiling);
    }
  });

  it('degrades to a single pair rather than zero when the ceiling is absurdly small', () => {
    // a zero-size batch would stall the run outright, which is worse than a
    // batch that overruns its budget and merely fails
    expect(maxPairsForOutputBudget(1)).toBe(1);
    expect(maxPairsForOutputBudget(BULK_JUDGE_TOKENS_PER_PAIR)).toBe(1);
  });

  it('CONTROL: the pre-fix 150-pair batch could never have fit — this is the bug it replaced', () => {
    // the literal 150 is the historical default, deliberately not the constant:
    // retuning the default must not silence this record of why the clamp exists
    expect(bulkJudgeMaxTokens(150)).toBeGreaterThan(BULK_JUDGE_MAX_OUTPUT_TOKENS);
    expect(150).toBeGreaterThan(maxPairsForOutputBudget());
  });
});

/**
 * A batch retry must be decided by the classifier that ALREADY RAN, not by
 * re-parsing the error message.
 *
 * Measured on wi882767-bulkfix-d035-2 (2026-08-30): model call #33 of ~37 threw
 * `anthropic-direct error: terminated` — undici's wording when a socket dies
 * mid-response. No message heuristic in the tree matches the bare word
 * `terminated`, so the batch was not retried, `judgeShard` rethrew, and a 2h34m
 * stage died at ~90% having persisted nothing. `LlmCallError.turn` had said
 * `transient_io` / `retryable: true` the whole time.
 *
 * These cases pin the SOURCE of the verdict (the turn) rather than any regex, so
 * the provider can reword its transport errors without re-opening the bug.
 */
describe('isRetryableModelCallError', () => {
  const asThrown = (message: string, status?: number) =>
    new LlmCallError(classifyHttpError({ status, message }, 'anthropic'));

  it('retries the transport termination that killed the d035-2 run', () => {
    const error = asThrown('anthropic-direct error: terminated');
    // the turn is the authority, and it classified this as a retryable blip
    expect(error.turn.class).toBe('transient_io');
    expect(isRetryableModelCallError(error)).toBe(true);
  });

  it('CONTROL: no message heuristic matches it — this is why the regex path could not retry', () => {
    // Falsifiability: if this ever starts passing, the message path became
    // capable on its own and the assertions above stop proving the fix.
    // Deliberately the raw message, not an LlmCallError — that is the input the
    // pre-fix predicate actually received.
    expect(isTransientNetworkError(new Error('anthropic-direct error: terminated'))).toBe(false);
  });

  it('still FAILS FAST on a walled account or bad token — retrying those is futile', () => {
    const auth = asThrown('invalid x-api-key', 401);
    expect(auth.turn.retryable).toBe(false);
    expect(isRetryableModelCallError(auth)).toBe(false);

    const permanent = asThrown('malformed request', 400);
    expect(isRetryableModelCallError(permanent)).toBe(false);
  });

  it('retries a rate limit / overload, which are transient by class', () => {
    expect(isRetryableModelCallError(asThrown('slow down', 429))).toBe(true);
    expect(isRetryableModelCallError(asThrown('overloaded_error', 529))).toBe(true);
  });

  it('falls back to the network heuristic when there is no turn to consult', () => {
    // a raw socket failure from some non-LlmCallError call path
    expect(isRetryableModelCallError(new Error('connect ECONNRESET 1.2.3.4:443'))).toBe(true);
    expect(isRetryableModelCallError(new Error('JSON parse error'))).toBe(false);
  });
});

describe('runBulkJudgeCallWithDeadline (WI-10006427)', () => {
  // A call that never settles on its own, like the hung codex request measured
  // 2026-10-06; it only reacts to its AbortSignal.
  const hungCall = () => {
    const seen: { signal?: AbortSignal } = {};
    const call = (signal: AbortSignal) => {
      seen.signal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('transport: terminated')));
      });
    };
    return { call, seen };
  };

  it('renews the lease while a call is in flight, then aborts it at the deadline as a retryable timeout', async () => {
    vi.useFakeTimers();
    try {
      const { call, seen } = hungCall();
      const heartbeat = vi.fn(async () => undefined);
      const pending = runBulkJudgeCallWithDeadline(call, { timeoutMs: 1_000, heartbeatMs: 300, heartbeat });
      const outcome = pending.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(950);
      expect(heartbeat).toHaveBeenCalledTimes(3);
      expect(seen.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      const error = await outcome;
      expect(error).toBeInstanceOf(BulkJudgeCallTimeoutError);
      expect(seen.signal?.aborted).toBe(true);
      // The deadline must reach the transport ladder, not fail the stage outright.
      expect(isRetryableModelCallError(error)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a call that settles before the deadline, without heartbeats', async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi.fn(async () => undefined);
      const pending = runBulkJudgeCallWithDeadline(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('judged'), 100)),
        { timeoutMs: 1_000, heartbeatMs: 300, heartbeat },
      );
      await vi.advanceTimersByTimeAsync(150);
      await expect(pending).resolves.toBe('judged');
      expect(heartbeat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a non-timeout call failure through unchanged', async () => {
    const failure = new Error('400 model refused');
    await expect(
      runBulkJudgeCallWithDeadline(() => Promise.reject(failure), {
        timeoutMs: 1_000,
        heartbeatMs: 300,
        heartbeat: async () => undefined,
      }),
    ).rejects.toBe(failure);
  });

  it('aborts the in-flight call when a heartbeat throws (a sibling shard failed the stage)', async () => {
    vi.useFakeTimers();
    try {
      const { call, seen } = hungCall();
      const stop = new Error('bulk stage stopped: a sibling shard already failed the stage');
      const pending = runBulkJudgeCallWithDeadline(call, {
        timeoutMs: 10_000,
        heartbeatMs: 300,
        heartbeat: async () => {
          throw stop;
        },
      });
      const outcome = pending.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(350);
      expect(await outcome).toBe(stop);
      expect(seen.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assertAdmissionCensusRatchet', () => {
  it('accepts a flat or falling census', () => {
    expect(() => assertAdmissionCensusRatchet(3, 3)).not.toThrow();
    expect(() => assertAdmissionCensusRatchet(3, 0)).not.toThrow();
  });

  it('fails loudly on an injected rise', () => {
    expect(() => assertAdmissionCensusRatchet(2, 4)).toThrow('admission census ratchet violated: 2 -> 4 (+2)');
  });
});

describe('P-003 preflight and structured failure evidence', () => {
  it('preserves the already-classified LLM transport verdict', () => {
    const error = new LlmCallError({
      class: 'rate_limited',
      message: 'gateway rate limited',
      retryable: true,
    });
    expect(classifyBulkModelFailure(error)).toEqual({
      kind: 'transport',
      class: 'rate_limited',
      retryable: true,
      message: 'gateway rate limited',
    });
  });

  it('classifies a capacity block separately from a failed transport', () => {
    const error = new BulkAdmissionBlockedError('no healthy account', {
      kind: 'capacity',
      class: 'preflight_capacity_unavailable',
      retryable: true,
      message: 'no healthy account',
    });
    expect(classifyBulkModelFailure(error)).toMatchObject({
      kind: 'capacity',
      class: 'preflight_capacity_unavailable',
      retryable: true,
    });
  });

  it('treats a reachable gateway without provider capacity as unknown, not ready', async () => {
    gateway.fetchGatewayHeadroom.mockResolvedValueOnce({ reachable: true, queueDepth: 2 });
    await expect(
      defaultBulkDedupPreflight({ workspaceId: 'ws', harnessSlug: 'h1', model: 'claude-sonnet-5' }),
    ).resolves.toMatchObject({ status: 'unknown', provider: 'claude', evidence: { reachable: true } });
  });

  it('blocks zero-capacity and accepts positive provider headroom', async () => {
    gateway.fetchGatewayHeadroom.mockResolvedValueOnce({ reachable: true, healthyAccounts: 0, queueDepth: 9 });
    await expect(
      defaultBulkDedupPreflight({ workspaceId: 'ws', harnessSlug: 'h1', model: 'claude-sonnet-5' }),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'gateway reports zero healthy accounts' });

    gateway.fetchGatewayHeadroom.mockResolvedValueOnce({
      reachable: true,
      healthyAccounts: 2,
      queueDepth: 1,
      accountId: 'acct-a',
    });
    await expect(
      defaultBulkDedupPreflight({ workspaceId: 'ws', harnessSlug: 'h1', model: 'gpt-5.5:xhigh' }),
    ).resolves.toMatchObject({
      status: 'ready',
      provider: 'codex',
      evidence: { healthyAccounts: 2, accountId: 'acct-a' },
    });
  });
});

/**
 * IS `r-finding-merge` REACHABLE AT ALL ON THE LIVE PATH?
 *
 * The d035-4 stage judged 1500 pairs and merged ZERO (verdicts={'r-related':1500}).
 * That number is only a MEASUREMENT if the merge verdict is reachable in situ; if the
 * real prompt/model/parse chain can never produce one, it is an unreachable branch
 * wearing a measurement's clothes, and the bulk-ratchet criterion must not be rated on
 * it. Two of the three legs were already proven — the code branch deterministically
 * (promoter.test.ts: r-finding-merge judgements => action==='merge') and pair SELECTION
 * empirically (it surfaced those 1500 pairs). The unproven leg was prompt -> model ->
 * parse, and it was measured live rather than assumed.
 *
 * LIVE RESULT (2026-08-30, production LEARNING_MODEL_SPEC gpt-5.6-sol:xhigh, via the
 * real buildBulkDedupPrompt): a same-finding/same-remedy pair came back `r-finding-merge`
 * and a same-subsystem/different-finding pair came back `r-related`/`distinct` across two
 * runs. So the verdict is reachable AND the model discriminates rather than rubber-stamping.
 * 0-of-1500 is a real measurement about that corpus.
 *
 * What is pinned HERE is the deterministic half: the exact payload that live run returned
 * must keep surviving the parser into a merge verdict. A schema/vocabulary change that
 * silently stopped accepting `r-finding-merge` would restore the dead-branch condition
 * while every count still read as a healthy zero — which is precisely the failure mode
 * this plan exists to eliminate. The live half is deliberately NOT in the suite: it costs
 * a model call and is nondeterministic.
 */
describe('r-finding-merge reachability (recorded live payload)', () => {
  // Verbatim from the live control run — not hand-authored.
  const RECORDED_LIVE_PAYLOAD = {
    judgements: [
      {
        pairKey: 'WI-CTRL-A::WI-CTRL-B',
        verdict: 'r-finding-merge',
        reason:
          'Same finding: unbounded 503 retry loop in the sync worker; same remedy of bounding attempts and surfacing the exhausted error.',
      },
      {
        pairKey: 'WI-CTRL-A::WI-CTRL-C',
        verdict: 'r-related',
        reason: 'Different findings and remedies, but both concern upstream handling in the sync worker.',
      },
    ],
  };

  it('the parser still accepts the merge verdict the live model actually returned', () => {
    const parsed = parsePromoterJudgements(RECORDED_LIVE_PAYLOAD);
    expect(parsed.map((judgement) => judgement.verdict)).toEqual(['r-finding-merge', 'r-related']);
  });

  it('CONTROL: the parser is strict, so the case above is not green-by-permissiveness', () => {
    // If the parser accepted anything, the assertion above would prove nothing about the
    // merge code specifically. An invented verdict must be REJECTED.
    expect(() =>
      parsePromoterJudgements({
        judgements: [{ pairKey: 'WI-CTRL-A::WI-CTRL-B', verdict: 'r-finding-merged', reason: 'typo' }],
      }),
    ).toThrow();
  });

  it('the prompt actually teaches the merge code, or the model could never emit it', () => {
    const pair: PromoterPair = {
      pairKey: 'WI-1::WI-2',
      a: item('WI-1'),
      b: item('WI-2'),
      pendingIds: ['WI-1', 'WI-2'],
      signals: ['cosine'],
      cosine: 0.94,
    };
    const prompt = buildBulkDedupPrompt([pair], []);
    expect(prompt.system).toContain('r-finding-merge');
    expect(prompt.system).toContain('the only merge-safe code');
  });
});
