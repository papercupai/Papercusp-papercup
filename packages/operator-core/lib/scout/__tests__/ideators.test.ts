/**
 * Ideator fan-out tests (P-004, D-004). Roster construction is pure; execution
 * runs against a FAKE injected llmCall (no network) — the gym:judge test pattern.
 * Pins: forced-diversity floor + weighted extras, grounding (refs intersected
 * with the digest), failure isolation, malformed-output rejection.
 */
import { describe, it, expect } from 'vitest';
import type { CorpusDigest, ScoutLlmCall } from '../types';
import { CREATIVE_LENSES } from '../types';
import {
  allocateExtraIdeators,
  buildIdeatorRoster,
  IDEATOR_OUTPUT_HEADROOM_TOKENS,
  parseIdeasPayload,
  runIdeators,
} from '../ideators';

const digest: CorpusDigest = {
  headline: 'coordination overhead',
  recurringFriction: [{ summary: 'lock contention', ref: 'wi:F-1' }],
  timeTokenSinks: [{ summary: 're-exploration', ref: 'wi:F-2' }],
  chronicDeferrals: [{ summary: 'mem0 deferred', ref: 'plan:mem' }],
  capabilityGaps: [{ summary: 'no cross-Hive search', ref: 'wi:F-3' }],
};

/** A fake llmCall that records its calls and returns a scripted payload. */
function fakeLlm(
  reply: (opts: Parameters<ScoutLlmCall>[0], callIndex: number) => { text?: string; json?: unknown; cost?: number },
): { call: ScoutLlmCall; calls: Array<Parameters<ScoutLlmCall>[0]> } {
  const calls: Array<Parameters<ScoutLlmCall>[0]> = [];
  const call: ScoutLlmCall = async (opts) => {
    const idx = calls.length;
    calls.push(opts);
    const r = reply(opts, idx);
    return { text: r.text ?? '', json: r.json, costUsd: r.cost ?? 0, inputTokens: 10, outputTokens: 20 };
  };
  return { call, calls };
}

describe('buildIdeatorRoster — forced-diversity floor (D-004)', () => {
  it('defaults to one ideator per lens, in lens order', () => {
    const roster = buildIdeatorRoster();
    expect(roster).toHaveLength(4);
    expect(roster.map((s) => s.lens)).toEqual([...CREATIVE_LENSES]);
    expect(roster.every((s, i) => s.globalIndex === i)).toBe(true);
  });

  it('only the analogical slot is primed with a distant domain', () => {
    const roster = buildIdeatorRoster();
    expect(roster.find((s) => s.lens === 'analogical')?.seedDomain).toBeDefined();
    expect(roster.find((s) => s.lens === 'reframing')?.seedDomain).toBeUndefined();
  });

  it('perLens > 1 rotates analogical through distinct distant domains', () => {
    const roster = buildIdeatorRoster({ perLens: 3 });
    expect(roster).toHaveLength(12);
    const analog = roster.filter((s) => s.lens === 'analogical');
    expect(analog).toHaveLength(3);
    const domains = analog.map((s) => s.seedDomain?.key);
    expect(new Set(domains).size).toBe(3); // intra-lens diversity
  });

  it('lensWeights ADD extras but never drop a lens below the floor', () => {
    const roster = buildIdeatorRoster({
      perLens: 1,
      lensWeights: { 'scout.lens-analogical': 3, 'scout.lens-reframing': 1 },
      extraIdeatorBudget: 4,
    });
    const counts = Object.fromEntries(CREATIVE_LENSES.map((l) => [l, 0]));
    for (const s of roster) counts[s.lens]++;
    // base 1 each + extras 3:1 over budget 4 → analogical 1+3, reframing 1+1, others floor 1
    expect(counts['analogical']).toBe(4);
    expect(counts['reframing']).toBe(2);
    expect(counts['first-principles']).toBe(1);
    expect(counts['constraint-removal']).toBe(1);
  });

  it('ignores weights when no extra budget is given', () => {
    const roster = buildIdeatorRoster({ lensWeights: { 'scout.lens-analogical': 10 } });
    expect(roster).toHaveLength(4); // pure floor, weights inert
  });
});

describe('allocateExtraIdeators', () => {
  it('distributes exactly `total` by largest-remainder', () => {
    const out = allocateExtraIdeators(
      [...CREATIVE_LENSES],
      { 'scout.lens-analogical': 1, 'scout.lens-reframing': 1, 'scout.lens-first-principles': 1 },
      4,
    );
    const sum = Object.values(out).reduce((a, b) => a + b, 0);
    expect(sum).toBe(4);
    expect(out['constraint-removal']).toBe(0); // zero weight → no extras
  });

  it('R-8: weights are keyed by lens identity id — a bare lens-name key never matches a lens', () => {
    const bare = { analogical: 5 } as unknown as Parameters<typeof allocateExtraIdeators>[1];
    const out = allocateExtraIdeators([...CREATIVE_LENSES], bare, 4);
    expect(Object.values(out).every((v) => v === 0)).toBe(true);
  });

  it('gives nothing when there is no weight signal', () => {
    const out = allocateExtraIdeators([...CREATIVE_LENSES], {}, 5);
    expect(Object.values(out).every((v) => v === 0)).toBe(true);
  });

  it('returns zeros for non-positive totals', () => {
    const out = allocateExtraIdeators([...CREATIVE_LENSES], { 'scout.lens-analogical': 1 }, 0);
    expect(Object.values(out).every((v) => v === 0)).toBe(true);
  });
});

describe('parseIdeasPayload', () => {
  it('reads an {ideas:[...]} object from json', () => {
    expect(parseIdeasPayload({ ideas: [{ title: 't' }] }, '')).toHaveLength(1);
  });
  it('reads a bare array', () => {
    expect(parseIdeasPayload([{ title: 't' }], '')).toHaveLength(1);
  });
  it('falls back to fenced JSON text', () => {
    const text = '```json\n{"ideas":[{"title":"t"}]}\n```';
    expect(parseIdeasPayload(undefined, text)).toHaveLength(1);
  });
  it('extracts an embedded object from prose', () => {
    const text = 'Here you go: {"ideas":[{"title":"t"}]} hope that helps';
    expect(parseIdeasPayload(undefined, text)).toHaveLength(1);
  });
  it('returns [] on garbage', () => {
    expect(parseIdeasPayload(undefined, 'no json here')).toEqual([]);
  });
});

describe('runIdeators', () => {
  const oneIdeaPerCall = (refs: string[]) => ({
    json: {
      ideas: [
        { title: 'idea', body: 'a body long enough', mechanism: 'the mechanism', addressesPatternRefs: refs },
      ],
    },
    cost: 0.01,
  });

  it('runs one ideator per lens, tags lens from the slot, assigns unique ids', async () => {
    const { call, calls } = fakeLlm(() => oneIdeaPerCall(['wi:F-1']));
    const res = await runIdeators(digest, { llmCall: call });
    expect(calls).toHaveLength(4);
    expect(res.ideas).toHaveLength(4);
    expect(res.ideas.map((i) => i.lens).sort()).toEqual([...CREATIVE_LENSES].sort());
    expect(new Set(res.ideas.map((i) => i.id)).size).toBe(4); // unique ids
    expect(res.costUsd).toBeCloseTo(0.04, 5);
    expect(res.perLensCounts['analogical']).toBe(1);
  });

  it('uses four DISTINCT system prompts (forced diversity at execution)', async () => {
    const { call, calls } = fakeLlm(() => oneIdeaPerCall(['wi:F-1']));
    await runIdeators(digest, { llmCall: call });
    const systems = calls.map((c) => c.system);
    expect(new Set(systems).size).toBe(4);
  });

  it('grounds ideas: keeps only refs that exist in the digest', async () => {
    const { call } = fakeLlm(() => oneIdeaPerCall(['wi:F-1', 'bogus-ref', 'wi:F-2']));
    const res = await runIdeators(digest, { llmCall: call });
    for (const idea of res.ideas) {
      expect(idea.addressesPatternRefs).toEqual(['wi:F-1', 'wi:F-2']); // 'bogus-ref' filtered
    }
  });

  it('stamps the analogical idea with the slot-assigned seed domain', async () => {
    const { call } = fakeLlm(() => oneIdeaPerCall(['wi:F-1']));
    const res = await runIdeators(digest, { llmCall: call });
    const analog = res.ideas.find((i) => i.lens === 'analogical');
    expect(analog?.seedDomain).toBeTruthy();
  });

  it('drops malformed ideas (missing required fields)', async () => {
    const { call } = fakeLlm(() => ({
      json: { ideas: [{ title: 'only title' }, { title: 't', body: 'b', mechanism: 'm', addressesPatternRefs: [] }] },
    }));
    const res = await runIdeators(digest, { llmCall: call });
    // each ideator returns 2 raw, 1 valid → 4 ideators × 1 = 4 kept
    expect(res.ideas).toHaveLength(4);
    expect(res.ideators.every((info) => info.raw === 2 && info.produced === 1)).toBe(true);
  });

  it('isolates a failed ideator without sinking the batch', async () => {
    const { call } = fakeLlm((_opts, idx) => {
      if (idx === 1) throw new Error('model exploded');
      return oneIdeaPerCall(['wi:F-1']);
    });
    const res = await runIdeators(digest, { llmCall: call });
    expect(res.ideas).toHaveLength(3); // 4 ideators, 1 failed
    const failed = res.ideators.filter((i) => !i.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('model exploded');
  });

  it('times out one stuck ideator without waiting for the whole Scout cycle timeout', async () => {
    let idx = 0;
    const call: ScoutLlmCall = async () => {
      const current = idx++;
      if (current === 1) return new Promise<never>(() => undefined);
      const r = oneIdeaPerCall(['wi:F-1']);
      return { text: '', json: r.json, costUsd: r.cost, inputTokens: 10, outputTokens: 20 };
    };
    const started = Date.now();
    const res = await runIdeators(digest, { llmCall: call, ideatorTimeoutMs: 10 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.ideas).toHaveLength(3);
    const failed = res.ideators.filter((i) => !i.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('timed out after 10ms');
  });

  it('honors parent Scout aborts while waiting on ideator calls', async () => {
    const ctrl = new AbortController();
    const call: ScoutLlmCall = async () => new Promise<never>(() => undefined);
    setTimeout(() => ctrl.abort(), 10).unref?.();
    const started = Date.now();
    const res = await runIdeators(digest, { llmCall: call, signal: ctrl.signal, ideatorTimeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.ideas).toHaveLength(0);
    expect(res.ideators.every((i) => !i.ok && i.error?.includes('aborted'))).toBe(true);
  });

  // maxTokens = the requested thinking budget PLUS the response headroom — the
  // headroom is asserted via the exported constant, never a re-typed literal:
  // this test previously pinned its own `4096` and redded the release gate when
  // ideators.ts raised the headroom to fix the EI-13119 truncation outage.
  it('passes a thinking budget through to the llmCall when set', async () => {
    const { call, calls } = fakeLlm(() => oneIdeaPerCall(['wi:F-1']));
    await runIdeators(digest, { llmCall: call, thinkingBudgetTokens: 2000 });
    expect(calls[0].thinkingBudgetTokens).toBe(2000);
    expect(calls[0].maxTokens).toBe(2000 + IDEATOR_OUTPUT_HEADROOM_TOKENS);
  });

  // The no-thinking path must ALSO carry the headroom: server-side thinking bills
  // against maxTokens even when no budget is requested (the actual EI-13119 shape).
  it('sends the response headroom as maxTokens when no thinking budget is set', async () => {
    const { call, calls } = fakeLlm(() => oneIdeaPerCall(['wi:F-1']));
    await runIdeators(digest, { llmCall: call });
    expect(calls[0].thinkingBudgetTokens).toBeUndefined();
    expect(calls[0].maxTokens).toBe(IDEATOR_OUTPUT_HEADROOM_TOKENS);
  });

  it('threads stepping-stone priming into every ideator user prompt (P-012)', async () => {
    const { call, calls } = fakeLlm(() => oneIdeaPerCall(['wi:F-1']));
    const priming = '## Prior gym elites\n- pheromone-style stale-claim decay (ref: gym:var-9)';
    await runIdeators(digest, { llmCall: call, priming });
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.messages[0].content).toContain('pheromone-style stale-claim decay');
    }
  });

  it('omits priming from prompts when none is given', async () => {
    const { call, calls } = fakeLlm(() => oneIdeaPerCall(['wi:F-1']));
    await runIdeators(digest, { llmCall: call });
    for (const c of calls) expect(c.messages[0].content).not.toContain('Prior gym elites');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * WI-4475 — RECURRENCE GUARD: the timeout hierarchy must never invert again.
 *
 * The bug: ONE wall-clock timer was started at CALL time and raced against llmCall. But
 * llmCall blocks in the shared rate-limit governor waiting for a permit BEFORE it issues the
 * request — so that timer charged QUEUE-WAIT and GENERATION to the same budget. Any governor
 * pause longer than the cap turned a correctly-paced, survivable capacity wait into a hard
 * failure reported as transport death ("timed out after 180000ms", $0 spent, 0 ideas).
 * Measured: opus emits ~62 tok/s ⇒ a full 4096-token response is ~66s, so the 180s cap has
 * ~2.7x headroom and the call CANNOT time out by generating. Live governor pauses: 15s/120s/453s.
 *
 * The invariant these tests pin: ADMISSION time is NOT charged against the GENERATION cap.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('runIdeators — admission vs generation budgets (WI-4475)', () => {
  /** A fake llmCall that queues in a "governor" for `admissionMs` before it "sends". */
  function governedLlm(opts: {
    admissionMs: number;
    gatewayAdmissionMs?: number;
    generationMs?: number;
    admit?: boolean;
  }): { call: ScoutLlmCall; seen: Array<Parameters<ScoutLlmCall>[0]> } {
    const seen: Array<Parameters<ScoutLlmCall>[0]> = [];
    const call: ScoutLlmCall = async (o) => {
      seen.push(o);
      // Phase 1 — ADMISSION: queued behind the shared rate-limit pause. Nothing sent yet.
      await new Promise((r) => setTimeout(r, opts.admissionMs));
      if (o.signal?.aborted) throw new Error('aborted during admission');
      if (opts.admit === false) {
        // Never admitted: hang until the caller's backstop/abort fires.
        await new Promise((_r, reject) => {
          o.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      // Phase 2 — LOCAL admission: the HTTP request is issued, but may still queue in
      // the inference gateway before any upstream response begins.
      o.onAdmitted?.();
      await new Promise((r) => setTimeout(r, opts.gatewayAdmissionMs ?? 0));
      if (o.signal?.aborted) throw new Error('aborted during gateway admission');
      // Phase 3 — response start: the request cleared every admission layer.
      o.onResponseStart?.();
      await new Promise((r) => setTimeout(r, opts.generationMs ?? 0));
      if (o.signal?.aborted) throw new Error('aborted during generation');
      return {
        text: '',
        json: {
          ideas: [
            { title: 'idea', body: 'a body long enough', mechanism: 'the mechanism', addressesPatternRefs: ['wi:F-1'] },
          ],
        },
        costUsd: 0,
        inputTokens: 10,
        outputTokens: 20,
      };
    };
    return { call, seen };
  }

  it('THE BUG: an ADMISSION wait LONGER than the generation cap still succeeds (queue-wait is not charged to generation)', async () => {
    // Admission 60ms >> generation cap 25ms. Pre-WI-4475 this raced a 25ms wall-clock timer
    // against the whole call and died as "timed out" with 0 ideas. It must now succeed:
    // the model only ever generated for ~0ms.
    const { call } = governedLlm({ admissionMs: 60, generationMs: 0 });
    const res = await runIdeators(digest, {
      llmCall: call,
      perLens: 1,
      lenses: ['analogical'],
      ideatorTimeoutMs: 25,
      cycleDeadlineMs: Date.now() + 10_000,
    });
    expect(res.ideas.length).toBeGreaterThan(0);
    expect(res.ideators.every((i) => i.ok)).toBe(true);
  });

  it('EI-11417: gateway admission after the local permit is NOT charged to generation', async () => {
    // The local governor admits immediately, then the inference gateway queues longer than
    // the 25ms generation cap. The old onAdmitted boundary killed this as "GENERATION" even
    // though upstream had not sent response headers. It must succeed once response starts.
    const { call } = governedLlm({ admissionMs: 0, gatewayAdmissionMs: 60, generationMs: 0 });
    const res = await runIdeators(digest, {
      llmCall: call,
      perLens: 1,
      lenses: ['analogical'],
      ideatorTimeoutMs: 25,
      cycleDeadlineMs: Date.now() + 10_000,
    });
    expect(res.ideas).toHaveLength(1);
    expect(res.ideators[0]?.ok).toBe(true);
  });

  it('the GENERATION cap still bites once admitted — and says so (a real wedged stream is still caught)', async () => {
    // Admitted immediately, then the stream wedges well past the cap.
    const { call } = governedLlm({ admissionMs: 0, generationMs: 200 });
    const res = await runIdeators(digest, {
      llmCall: call,
      perLens: 1,
      lenses: ['analogical'],
      ideatorTimeoutMs: 25,
      cycleDeadlineMs: Date.now() + 10_000,
    });
    expect(res.ideas).toHaveLength(0);
    const err = res.ideators[0]?.error ?? '';
    expect(err).toMatch(/GENERATION/);
    // It must NOT be blamed on capacity — this one really was the model.
    expect(err).toMatch(/upstream response started/);
    expect(err).not.toMatch(/no capacity|queued\/stalled/);
  });

  it('missing admission telemetry remains unknown, not a proven capacity wall', async () => {
    const { call } = governedLlm({ admissionMs: 0, admit: false });
    const res = await runIdeators(digest, {
      llmCall: call,
      perLens: 1,
      lenses: ['analogical'],
      ideatorTimeoutMs: 40, // generation cap; admission is what fails here
      cycleDeadlineMs: Date.now() + 10, // ~nothing left ⇒ admission budget ~0
      admissionBackstopGraceMs: 20, // keep the unit test fast (prod default is 5s)
    });
    expect(res.ideas).toHaveLength(0);
    const err = res.ideators[0]?.error ?? '';
    // A callback-silent buffered transport is indistinguishable from this fake
    // unadmitted call. Neither absence proves a capacity wall or rules out generation.
    expect(err).toContain('queueing versus generation unknown');
    expect(err).not.toMatch(/never admitted|no capacity|not generation|ms of GENERATION/);
  });

  it('bounds the ADMISSION wait by the cycle deadline, reserving room for generation', async () => {
    const { call, seen } = governedLlm({ admissionMs: 0, generationMs: 0 });
    const generationCap = 1_000;
    const remaining = 5_000;
    await runIdeators(digest, {
      llmCall: call,
      perLens: 1,
      lenses: ['analogical'],
      ideatorTimeoutMs: generationCap,
      cycleDeadlineMs: Date.now() + remaining,
    });
    const budget = seen[0]?.governorMaxWaitMs;
    expect(budget).toBeDefined();
    // INVARIANT — the inner admission budget can never exceed its outer budget, and must hold
    // back room for generation. An inner wait >= the caller's patience is the whole defect.
    expect(budget!).toBeLessThanOrEqual(remaining - generationCap);
    expect(budget!).toBeGreaterThan(0);
  });

  it('WI-5784: the backstop fires STRICTLY INSIDE the cycle deadline, so the cycle timer never guillotines the honest error', async () => {
    // THE BUG: admissionBudget is `remaining - generationCap`, so the old ceiling
    // `admissionBudget + generationCap + grace` collapsed to `remaining + grace` —
    // armed AFTER the owning cycle's own timer, hence unreachable. Every such call
    // was recorded as the opaque "Scout cycle timed out after 600000ms during phase
    // ideate" (42 of 55 scout error ticks in the 7d window that broke the <5% bar)
    // instead of the capacity-classifiable message this call is written to produce.
    const { call } = governedLlm({ admissionMs: 0, admit: false }); // never returns
    const remaining = 5_200; // margin is 5_000 ⇒ the ceiling lands ~200ms out
    const started = Date.now();
    const res = await runIdeators(digest, {
      llmCall: call,
      perLens: 1,
      lenses: ['analogical'],
      ideatorTimeoutMs: 1_000,
      cycleDeadlineMs: started + remaining,
    });
    const elapsed = Date.now() - started;
    expect(res.ideas).toHaveLength(0);
    // THE INVARIANT: we gave up with time still on the cycle clock, so the phase can
    // still conclude and the tick can record WHY. Pre-fix this took `remaining + grace`.
    expect(elapsed).toBeLessThan(remaining);
    expect(res.ideators[0]?.error ?? '').toMatch(/never admitted|no capacity|before the cycle deadline/i);
  });

  it('no cycle deadline ⇒ no admission bound imposed (pre-WI-4475 callers/tests unchanged)', async () => {
    const { call, seen } = governedLlm({ admissionMs: 0, generationMs: 0 });
    await runIdeators(digest, { llmCall: call, perLens: 1, lenses: ['analogical'] });
    expect(seen[0]?.governorMaxWaitMs).toBeUndefined();
  });
});
