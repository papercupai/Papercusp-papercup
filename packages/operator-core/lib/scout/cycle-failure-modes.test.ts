/**
 * Scout loop — `runScoutCycle` FAILURE-MODE suite (scout-loop-test-plan-2026-06-11, P-003).
 *
 * Pins the cycle's behavior when things go wrong, using the shared `./test-support`
 * fakes (no network, $0, deterministic). Where the failure mode lives in a step's
 * parse contract (malformed LLM JSON), the REAL step implementations (`runIdeators`
 * / `critiqueIdeas` / `recombineProposals` / `routeProposals`) are wired as the
 * cycle's ports — exactly the cycle-deps.ts production wiring — so the suite pins
 * the *actual* end-to-end contract, not a fake's.
 *
 * Contracts discovered + pinned here (the documented behavior, not aspiration):
 *  - Malformed/truncated JSON never rejects the cycle. Per stage:
 *      ideate    → parseIdeasPayload yields no ideas → stop 'no-ideas' (per-ideator
 *                  isolation: one garbled ideator never kills the batch);
 *      critique  → runCritic's fail-safe (novelty ceiling intact, feasibility 0):
 *                  an unparseable critic can NEVER smuggle an idea to 'keep', but a
 *                  corpus-novel idea survives as a capped MOONSHOT — the cycle continues;
 *      recombine → parseProposal null → the D-006 gate drops the group → all groups
 *                  dropped ⇒ stop 'no-proposals', route never runs.
 *    Spend on a malformed call is still recorded (it counts toward the budget).
 *  - Empty-digest guard (EI-303): a fresh-hive (zero-pattern) digest early-exits
 *    'empty-digest' BEFORE the ideator roster — zero LLM calls, zero spend. A
 *    near-empty digest (≥1 pattern in any lane) still runs the full cycle; refs
 *    the model invents are stripped (ungrounded) and the cycle proceeds.
 *  - Zero survivors → stop 'no-survivors' with zero recombine/route spend.
 *  - Budget (D-010, softened by EI-10779): `maxCostUsd` is a SOFT cap. A zero/negative
 *    cap refuses to spend at all (halts before the first costed step); but once
 *    generation is PAID FOR, an overrun never discards it — the cycle completes
 *    routing what it generated and flags `overBudget` (killing the pipeline after
 *    generation but before the ~$0 route stage was pure sunk-cost destruction).
 *  - Routing rail failure: `routeProposals` isolates per sink — a rejecting rail
 *    fails only its own decision (error recorded on the RoutingDecision, no
 *    routedRef → no provenance), siblings dispatch, the cycle still 'completed'.
 *    The CYCLE does not catch a rejecting route port — that isolation is the
 *    router's contract (cycle-deps wires route through routeProposals).
 *  - Moonshot-only survivor sets proceed to recombine + routing (D-005).
 *
 * Run: `cd packages/operator-core && npx vitest run lib/scout/cycle-failure-modes`.
 */
import { describe, it, expect } from 'vitest';
import {
  makeFakeScoutLlm,
  fixtureCorpusDigest,
  fixtureIdeasAllLenses,
  fixtureProposal,
  fixtureScoredIdea,
  type ScoutLlmCallOpts,
  type ScoutLlmResponder,
} from './test-support';
import type { CorpusDigest, Proposal, ScoredIdea } from './types';
import type { CorpusEntry } from './critique-core';
import { runIdeators } from './ideators';
import { critiqueIdeas } from './critics';
import { recombineProposals } from './recombine';
import {
  routeProposals,
  type CaptureRequest,
  type PlanDraftRequest,
  type RouterPorts,
  type RoutingDecision,
} from './router';
import type { ScoutIdeaView } from './gym-bridge';
import { runScoutCycle, selectSurvivors, type ScoutCycleDeps, type ScoutCycleLimits } from './cycle';

/* ────────────────────────────────────────────────────────────────────────
 * Stage discrimination — each real step's system prompt carries a stable marker.
 * ──────────────────────────────────────────────────────────────────────── */

const isCritique = (o: ScoutLlmCallOpts): boolean => o.system?.includes('TWO adversarial critics') ?? false;
const isRecombine = (o: ScoutLlmCallOpts): boolean => o.system?.includes('Scout proposer') ?? false;
const isIdeate = (o: ScoutLlmCallOpts): boolean => !isCritique(o) && !isRecombine(o);

/** Respond with parsed JSON when `match` hits (mirrors test-support's jsonResponder, stage-scoped). */
const jsonAt = (match: (o: ScoutLlmCallOpts) => boolean, payload: unknown): ScoutLlmResponder =>
  (opts) => (match(opts) ? { json: payload, text: JSON.stringify(payload) } : undefined);

/** Respond with RAW TEXT ONLY (no structured json) — the malformed-output path. */
const textAt = (match: (o: ScoutLlmCallOpts) => boolean, text: string): ScoutLlmResponder =>
  (opts) => (match(opts) ? { text } : undefined);

/* ── canonical per-stage payloads ─────────────────────────────────────── */

/** Grounded ideator output — cites a ref that exists in the fixture digest. */
const VALID_IDEAS = {
  ideas: [
    {
      title: 'yield on lock-block instead of retrying',
      body: 'treat a blocked edit as a signal to re-queue, not a failure to attack',
      mechanism: 'register events:await on lock grant and yield the turn',
      addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
    },
  ],
};

const KEEP_CRITIC = { conceptualNovelty: 0.9, feasibility: 0.8, rationale: 'novel and buildable' };
const REJECT_CRITIC = { conceptualNovelty: 0.05, feasibility: 0.9, rationale: 'the obvious move' };
const MOONSHOT_CRITIC = { conceptualNovelty: 0.95, feasibility: 0.2, rationale: 'a wild but real leap' };

const VALID_PROPOSAL = {
  framing: 'lock contention reframed as a yield signal',
  mechanism: 'on lock-block, await the grant and yield',
  whyNew: 'prior lock work retried; nobody tried yielding',
  bet: 'eliminates the retry-storm friction class',
  experiment: { hypothesis: 'h', method: 'm', falsifiableSignal: 'f' },
  route: 'improvement',
};

/** Truncated mid-stream — no closing bracket anywhere, so every parser fallback fails. */
const TRUNCATED_IDEAS_TEXT = '{"ideas": [ {"title": "borrowed tolera';
const REFUSAL_PROSE = 'Sorry — I could not produce structured output for this idea.';
const TRUNCATED_FENCED_PROPOSAL = '```json\n{"framing": "half a propo';

/* ────────────────────────────────────────────────────────────────────────
 * Deps builders
 * ──────────────────────────────────────────────────────────────────────── */

const EMPTY_DIGEST: CorpusDigest = {
  recurringFriction: [],
  timeTokenSinks: [],
  chronicDeferrals: [],
  capabilityGaps: [],
};

/** One lone pattern — enough substrate that the EI-303 guard must NOT trip. */
const NEAR_EMPTY_DIGEST: CorpusDigest = {
  recurringFriction: [{ summary: 'one lone friction pattern', ref: 'wi:F-001' }],
  timeTokenSinks: [],
  chronicDeferrals: [],
  capabilityGaps: [],
};

/**
 * The four FREE-TEXT lanes are empty but a MEASURED rubric criterion is present
 * (blender-self-learning-2026-07-12 P-013 drift fix). Before the fix `digestIsEmpty`
 * hardcoded only the four free-text lanes, so this read as "empty" and the cycle
 * short-circuited BEFORE the P-004 rubric-seeded slot could run — defeating the exact
 * rail rubric-seeding exists for (and any origin:drill health check). A digest that
 * grounds an idea (any lane in flattenDigest) is substrate; the guard must NOT trip.
 */
const RUBRIC_ONLY_DIGEST: CorpusDigest = {
  recurringFriction: [],
  timeTokenSinks: [],
  chronicDeferrals: [],
  capabilityGaps: [],
  rubricRatings: [
    {
      category: 'rubric-rating',
      summary: 'pot-coordination-health · end-to-end-flow: broken',
      ref: 'rubric:pot-coordination-health#end-to-end-flow',
    },
  ],
};

/**
 * REAL-step deps: runIdeators / critiqueIdeas / recombineProposals / routeProposals
 * wired as the cycle's ports (the cycle-deps.ts shape) over the fake LLM + fake
 * dispatch ports. The novelty corpus defaults EMPTY so search-first novelty is a
 * deterministic 1 (verdicts depend only on the scripted critic scores).
 */
function makeRealStepDeps(opts: {
  responders?: ScoutLlmResponder[];
  digest?: CorpusDigest;
  noveltyCorpus?: CorpusEntry[];
  costUsd?: number;
  limits?: ScoutCycleLimits;
  routerPorts?: RouterPorts;
} = {}) {
  const fake = makeFakeScoutLlm({ responders: opts.responders, costUsd: opts.costUsd ?? 0.01 });
  const recorded = {
    routeBatches: [] as Proposal[][],
    planDrafts: [] as PlanDraftRequest[],
    gymBatches: [] as ScoutIdeaView[][],
    captured: [] as CaptureRequest[],
  };
  const ports: RouterPorts = opts.routerPorts ?? {
    plansNew: async (req) => {
      recorded.planDrafts.push(req);
      return { slug: `${req.slugStem}-2026-06-10` };
    },
    gymDispatch: async (views) => {
      recorded.gymBatches.push(views);
      return {
        seeded: views.map((v) => ({ ideaId: v.id, nicheKey: 'module|x|low', admitted: true, distance: 1 })),
        newNiches: [],
        skipped: [],
      };
    },
    capture: async (req) => {
      recorded.captured.push(req);
      return { id: `EI-${recorded.captured.length}`, created: true };
    },
  };

  const deps: ScoutCycleDeps = {
    llmCall: fake.call,
    limits: opts.limits,
    readCorpus: async () => opts.digest ?? fixtureCorpusDigest(),
    readNoveltyCorpus: async () => opts.noveltyCorpus ?? [],
    ideate: async (digest, ctx) => (await runIdeators(digest, { llmCall: ctx.llmCall })).ideas,
    critique: async (ideas, ctx) => (await critiqueIdeas(ideas, ctx.corpus, { llmCall: ctx.llmCall })).critiques,
    recombine: async (scored, ctx) => (await recombineProposals(scored, { llmCall: ctx.llmCall })).proposals,
    route: async (proposals) => {
      // runScoutCycle performs a cost-free D-010 continuation probe with []
      // before every early-exit path. It is not a proposal-routing batch.
      if (proposals.length > 0) recorded.routeBatches.push([...proposals]);
      return (await routeProposals(proposals, ports)).decisions;
    },
  };
  return { deps, fake, recorded };
}

/**
 * SIMPLE fake-port deps (the cycle.test.ts style: one recorded LLM call per
 * step) — used where the assertion is about the cycle's own checkpoints (budget)
 * rather than a step's parse contract.
 */
function makeSimpleDeps(opts: {
  costUsd?: number;
  limits?: ScoutCycleLimits;
  verdicts?: ScoredIdea['verdict'][];
  route?: (proposals: Proposal[]) => Promise<RoutingDecision[]>;
} = {}) {
  const fake = makeFakeScoutLlm({ costUsd: opts.costUsd ?? 0.01 });
  const ideas = fixtureIdeasAllLenses();
  const routeBatches: Proposal[][] = [];

  const deps: ScoutCycleDeps = {
    llmCall: fake.call,
    limits: opts.limits,
    readCorpus: async () => fixtureCorpusDigest(),
    readNoveltyCorpus: async () => [],
    ideate: async (_digest, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'ideate' }], responseFormat: 'json' });
      return ideas;
    },
    critique: async (ins, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'critique' }], responseFormat: 'json' });
      return ins.map((idea, i) => fixtureScoredIdea({ idea, verdict: opts.verdicts?.[i] ?? 'keep' }));
    },
    recombine: async (scored, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'recombine' }], responseFormat: 'json' });
      const survivors = selectSurvivors(scored);
      return survivors.length
        ? [fixtureProposal({ id: 'P-1', sourceIdeaIds: survivors.map((s) => s.idea.id) })]
        : [];
    },
    route: async (proposals) => {
      // The initial D-010 continuation drain routes [] by design; only count
      // actual proposal batches in these routing assertions.
      if (proposals.length > 0) routeBatches.push([...proposals]);
      if (opts.route) return opts.route(proposals);
      return proposals.map((p) => ({
        proposalId: p.id,
        sourceIdeaIds: [...p.sourceIdeaIds],
        rail: 'plan' as const,
        reason: 'fake route',
        followedHint: false,
        routedRef: `plan:${p.id}`,
      }));
    },
  };
  return { deps, fake, routeBatches };
}

/* ────────────────────────────────────────────────────────────────────────
 * 1. Malformed / truncated LLM JSON at each spending stage
 * ──────────────────────────────────────────────────────────────────────── */

describe('failure: malformed LLM JSON per stage (real step implementations)', () => {
  it('ideate: truncated JSON from every ideator → graceful no-ideas stop, spend still recorded', async () => {
    const { deps, fake, recorded } = makeRealStepDeps({
      responders: [textAt(isIdeate, TRUNCATED_IDEAS_TEXT)],
    });

    const r = await runScoutCycle(deps); // resolves — never an unhandled rejection

    expect(r.stop).toBe('no-ideas');
    expect(r.ideas).toEqual([]);
    expect(r.scored).toEqual([]);
    expect(r.survivors).toEqual([]);
    expect(r.proposals).toEqual([]);
    expect(r.routed).toEqual([]);
    expect(r.provenance).toEqual([]);
    // The whole 4-lens roster ran (and was paid for) before the empty parse surfaced.
    expect(fake.count()).toBe(4);
    expect(r.calls.every((c) => c.step === 'ideate')).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.04, 5);
    // critique/recombine/route were never reached.
    expect(recorded.routeBatches).toHaveLength(0);
  });

  it('ideate: one garbled ideator never kills the batch — the cycle proceeds on the survivors', async () => {
    let ideateCalls = 0;
    const mixedIdeate: ScoutLlmResponder = (opts) => {
      if (!isIdeate(opts)) return undefined;
      ideateCalls += 1;
      // First ideator answers well; the other three are truncated garbage.
      return ideateCalls === 1
        ? { json: VALID_IDEAS, text: JSON.stringify(VALID_IDEAS) }
        : { text: TRUNCATED_IDEAS_TEXT };
    };
    const { deps } = makeRealStepDeps({
      responders: [mixedIdeate, jsonAt(isCritique, KEEP_CRITIC), jsonAt(isRecombine, VALID_PROPOSAL)],
    });

    const r = await runScoutCycle(deps);

    expect(r.ideas).toHaveLength(1); // only the parseable ideator contributed
    expect(r.stop).toBe('completed');
    expect(r.proposals.length).toBeGreaterThanOrEqual(1);
  });

  it("critique: unparseable critics fail safe — never 'keep', every idea rejected as critic-failure, cycle stops at no-survivors (WI-10007486)", async () => {
    const { deps } = makeRealStepDeps({
      responders: [
        jsonAt(isIdeate, VALID_IDEAS),
        textAt(isCritique, REFUSAL_PROSE), // every critic call returns prose, no JSON
        jsonAt(isRecombine, VALID_PROPOSAL),
      ],
    });

    const r = await runScoutCycle(deps);

    expect(r.scored).toHaveLength(4);
    // The fail-safe (critics.ts runCritic): an unparseable critic judged nothing, so it
    // can never smuggle an idea through to 'keep'.
    expect(r.scored.some((s) => s.verdict === 'keep')).toBe(false);
    // WI-10007486: the failed critic's placeholder scores (novelty 1, feasibility 0) are
    // not a judgment. Bucketing them used to promote un-critiqued, lexically novel ideas
    // to MOONSHOT, so critiqueIdea rejects them with the cause and critiqueIdeas keeps
    // them out of the moonshot bucket.
    expect(r.scored.every((s) => s.verdict === 'reject' && s.rejectCause === 'critic-failure')).toBe(true);
    expect(r.scored.every((s) => s.notes.includes('no parseable JSON'))).toBe(true);
    expect(r.survivors).toHaveLength(0);
    // No survivors: the cycle stops before recombine instead of spending on ideas no
    // critic has judged.
    expect(r.calls.some((c) => c.step === 'recombine')).toBe(false);
    expect(r.stop).toBe('no-survivors');
  });

  it('recombine: truncated fenced JSON → every group dropped by the D-006 gate → no-proposals stop, route never runs', async () => {
    const { deps, recorded } = makeRealStepDeps({
      responders: [
        jsonAt(isIdeate, VALID_IDEAS),
        jsonAt(isCritique, KEEP_CRITIC),
        textAt(isRecombine, TRUNCATED_FENCED_PROPOSAL),
      ],
    });

    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('no-proposals');
    expect(r.survivors).toHaveLength(4); // the pipeline got that far
    expect(r.proposals).toEqual([]);
    expect(r.routed).toEqual([]);
    expect(r.provenance).toEqual([]);
    expect(recorded.routeBatches).toHaveLength(0); // routing never invoked
    // The failed recombine calls still spent (4 ideate + 4 critique + 2 groups).
    expect(r.calls.filter((c) => c.step === 'recombine')).toHaveLength(2);
    expect(r.costUsd).toBeCloseTo(0.1, 5);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 2. Empty / fresh-hive corpus digest
 * ──────────────────────────────────────────────────────────────────────── */

describe('failure: empty (fresh-hive) corpus digest', () => {
  it('EI-303 guard: early-exits empty-digest BEFORE the ideator roster — zero calls, zero spend', async () => {
    const { deps, fake, recorded } = makeRealStepDeps({ digest: EMPTY_DIGEST });

    const r = await runScoutCycle(deps);

    // The roster never ran — an empty substrate grounds nothing, so there is
    // nothing to pay for (a fresh/quiet hive used to pay all 4 lenses here).
    expect(fake.count()).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.costUsd).toBe(0);
    // …and the result is a well-formed early exit.
    expect(r.stop).toBe('empty-digest');
    expect(r.digest).toEqual(EMPTY_DIGEST);
    expect(r.ideas).toEqual([]);
    expect(r.scored).toEqual([]);
    expect(r.survivors).toEqual([]);
    expect(r.proposals).toEqual([]);
    expect(r.routed).toEqual([]);
    expect(r.provenance).toEqual([]);
    expect(recorded.routeBatches).toHaveLength(0);
  });

  it('headline/generatedAt alone do not count as substrate — the guard still trips', async () => {
    const { deps, fake } = makeRealStepDeps({
      digest: { ...EMPTY_DIGEST, headline: 'a quiet hive', generatedAt: '2026-06-11T00:00:00Z' },
    });

    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('empty-digest');
    expect(fake.count()).toBe(0);
    expect(r.costUsd).toBe(0);
  });

  it('a NEAR-empty digest (one pattern) is not gated; invented refs are stripped (ungrounded) and the cycle proceeds', async () => {
    const { deps } = makeRealStepDeps({
      digest: NEAR_EMPTY_DIGEST,
      responders: [
        jsonAt(isIdeate, VALID_IDEAS), // cites a ref that does NOT exist in this digest
        jsonAt(isCritique, KEEP_CRITIC),
        jsonAt(isRecombine, VALID_PROPOSAL),
      ],
    });

    const r = await runScoutCycle(deps);

    expect(r.ideas).toHaveLength(4);
    // Grounding intersection with a ref set the citation is absent from: stripped, no crash.
    expect(r.ideas.every((i) => i.addressesPatternRefs.length === 0)).toBe(true);
    expect(r.proposals.every((p) => p.addressesPatternRefs.length === 0)).toBe(true);
    expect(r.stop).toBe('completed'); // one pattern is enough substrate — no early exit
  });

  it('P-013 drift fix: a rubric-ONLY digest (measured ratings, no free-text friction) is substrate — the guard must NOT trip', async () => {
    const { deps, fake } = makeRealStepDeps({
      digest: RUBRIC_ONLY_DIGEST,
      responders: [
        jsonAt(isIdeate, VALID_IDEAS),
        jsonAt(isCritique, KEEP_CRITIC),
        jsonAt(isRecombine, VALID_PROPOSAL),
      ],
    });

    const r = await runScoutCycle(deps);

    // Before the fix this early-exited 'empty-digest' with zero LLM calls — the seeded
    // rubric slot never ran. Now the roster runs: a rubric measurement IS substrate.
    expect(r.stop).not.toBe('empty-digest');
    expect(fake.count()).toBeGreaterThan(0);
    expect(r.ideas.length).toBeGreaterThanOrEqual(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 3. Zero survivors — critics reject everything
 * ──────────────────────────────────────────────────────────────────────── */

describe('failure: zero survivors (critics reject everything)', () => {
  it('stops at no-survivors with zero recombine/route spend', async () => {
    const { deps, recorded } = makeRealStepDeps({
      responders: [jsonAt(isIdeate, VALID_IDEAS), jsonAt(isCritique, REJECT_CRITIC)],
    });

    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('no-survivors');
    expect(r.scored).toHaveLength(4);
    expect(r.scored.every((s) => s.verdict === 'reject')).toBe(true);
    expect(r.survivors).toEqual([]);
    expect(r.proposals).toEqual([]);
    expect(r.routed).toEqual([]);
    // No recombine LLM spend, no routing dispatch.
    expect(r.calls.map((c) => c.step)).toEqual([
      'ideate', 'ideate', 'ideate', 'ideate',
      'critique', 'critique', 'critique', 'critique',
    ]);
    expect(recorded.routeBatches).toHaveLength(0);
    expect(r.costUsd).toBeCloseTo(0.08, 5); // ideate + critique only
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 4. Budget exhaustion mid-cycle (D-010)
 * ──────────────────────────────────────────────────────────────────────── */

describe('failure: budget exhaustion mid-cycle (limits.maxCostUsd)', () => {
  it('halts after ideate, BEFORE the critique spend, with a well-formed partial result', async () => {
    const { deps, routeBatches } = makeSimpleDeps({ costUsd: 0.01, limits: { maxCostUsd: 0.005 } });

    const r = await runScoutCycle(deps);

    // EI-10779: the cycle no longer discards paid-for generation on budget overrun.
    // It continues through to route (the cheapest stage, ~$0) and flags overBudget instead.
    expect(r.stop).toBe('completed');
    expect(r.overBudget).toBe(true);
    expect(r.calls.map((c) => c.step)).toEqual(['ideate', 'critique', 'recombine']); // all stages run
    expect(r.ideas).toHaveLength(4); // the full pipeline is carried in the result
    expect(r.scored).toHaveLength(4); // scored from critique
    expect(r.survivors).toHaveLength(4); // survivors from critique
    expect(r.proposals).toHaveLength(1); // one recombined proposal from all survivors
    expect(r.routed).toHaveLength(1); // one routing decision for that proposal
    expect(routeBatches).toHaveLength(1); // routing batch with the proposal
    // EI-10779: the cycle completes all stages, no longer discarding sunk cost (generation).
    // Cost is 3 steps × 0.01 each = 0.03 (exceeds the 0.005 cap, but overBudget flags it).
    expect(r.costUsd).toBeCloseTo(0.03, 5);
  });

  it('halts after critique, BEFORE the recombine spend; survivors are still surfaced', async () => {
    const { deps, routeBatches } = makeSimpleDeps({ costUsd: 0.01, limits: { maxCostUsd: 0.015 } });

    const r = await runScoutCycle(deps);

    // EI-10779: the cycle no longer discards paid-for generation on budget overrun.
    // It continues through to route (the cheapest stage, ~$0) and flags overBudget instead.
    expect(r.stop).toBe('completed');
    expect(r.overBudget).toBe(true);
    expect(r.calls.map((c) => c.step)).toEqual(['ideate', 'critique', 'recombine']); // all stages run
    expect(r.scored).toHaveLength(4);
    expect(r.survivors).toHaveLength(4); // computed before budget check, observability kept
    expect(r.proposals).toHaveLength(1); // one recombined proposal from all survivors
    expect(r.routed).toHaveLength(1); // routing still happens
    expect(routeBatches).toHaveLength(1); // routing (post-recombine) still reached
    // EI-10779: the cycle completes all stages. Cost is 3 steps × 0.01 each = 0.03.
    expect(r.costUsd).toBeCloseTo(0.03, 5);
  });

  it('spend exactly AT the cap does not halt (the check is strictly greater-than)', async () => {
    // After critique, spend is exactly 0.02 == cap → the cycle proceeds to recombine.
    const { deps } = makeSimpleDeps({ costUsd: 0.01, limits: { maxCostUsd: 0.02 } });

    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('completed');
    expect(r.calls.map((c) => c.step)).toEqual(['ideate', 'critique', 'recombine']);
  });

  it('a ZERO cap halts BEFORE the first costed step — no ideate spend at all (EI-305)', async () => {
    // The strict `spent > cap` between-steps gate would pass a 0-spent/0-cap
    // start, so the cycle has an explicit pre-ideate zero-cap guard.
    const { deps, routeBatches } = makeSimpleDeps({ costUsd: 0.01, limits: { maxCostUsd: 0 } });

    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('budget-exhausted');
    expect(r.calls).toEqual([]); // not a single LLM call
    expect(r.costUsd).toBe(0);
    expect(r.ideas).toEqual([]);
    expect(routeBatches).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 5. Routing rail failure (real routeProposals as the route port)
 * ──────────────────────────────────────────────────────────────────────── */

/** Three proposals hinted at three different rails, each sourced from a distinct idea. */
function railFixtures() {
  const ideas = fixtureIdeasAllLenses(); // idea-analogical-1, idea-first-principles-2, idea-reframing-3, …
  const proposals = [
    fixtureProposal({ id: 'P-plan', routeHint: 'plan', sourceIdeaIds: [ideas[0].id] }),
    fixtureProposal({ id: 'P-gym', routeHint: 'gym', sourceIdeaIds: [ideas[1].id] }),
    fixtureProposal({ id: 'P-imp', routeHint: 'improvement', sourceIdeaIds: [ideas[2].id] }),
  ];
  return { ideas, proposals };
}

/** Cycle deps with fake step ports (fixed ideas/proposals) + the REAL router over `ports`. */
function makeRailDeps(ports: RouterPorts) {
  const { ideas, proposals } = railFixtures();
  const fake = makeFakeScoutLlm({ costUsd: 0.01 });
  const deps: ScoutCycleDeps = {
    llmCall: fake.call,
    readCorpus: async () => fixtureCorpusDigest(),
    readNoveltyCorpus: async () => [],
    ideate: async (_digest, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'ideate' }], responseFormat: 'json' });
      return ideas;
    },
    critique: async (ins, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'critique' }], responseFormat: 'json' });
      return ins.map((idea) => fixtureScoredIdea({ idea, verdict: 'keep' }));
    },
    recombine: async (_scored, ctx) => {
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'recombine' }], responseFormat: 'json' });
      return proposals;
    },
    route: async (props) => (await routeProposals(props, ports)).decisions,
  };
  return { deps, ideas, proposals };
}

describe('failure: a routing rail throws (e.g. createPlanDraft rejects)', () => {
  it('fails only its own decision — siblings dispatch, the error is recorded on the decision, cycle completes', async () => {
    const gymBatches: ScoutIdeaView[][] = [];
    const captured: CaptureRequest[] = [];
    const ports: RouterPorts = {
      plansNew: async () => {
        throw new Error('plans:new down');
      },
      gymDispatch: async (views) => {
        gymBatches.push(views);
        return {
          seeded: views.map((v) => ({ ideaId: v.id, nicheKey: 'n', admitted: true, distance: 1 })),
          newNiches: [],
          skipped: [],
        };
      },
      capture: async (req) => {
        captured.push(req);
        return { id: 'EI-1', created: true };
      },
    };
    const { deps, ideas } = makeRailDeps(ports);

    const r = await runScoutCycle(deps);

    // The cycle still completes — a failed rail is not a failed cycle.
    expect(r.stop).toBe('completed');
    expect(r.routed).toHaveLength(3);

    const byId = new Map(r.routed.map((d) => [d.proposalId, d]));
    // The failed rail: error recorded verbatim, no routedRef — visible, never swallowed.
    expect(byId.get('P-plan')!.error).toBe('plans:new down');
    expect(byId.get('P-plan')!.routedRef).toBeUndefined();
    // Sibling proposals' routing completed.
    expect(byId.get('P-gym')!.routedRef).toBe('gym:P-gym');
    expect(byId.get('P-gym')!.error).toBeUndefined();
    expect(byId.get('P-imp')!.routedRef).toBe('wi:EI-1');
    expect(byId.get('P-imp')!.error).toBeUndefined();
    expect(gymBatches).toHaveLength(1);
    expect(captured).toHaveLength(1);

    // Provenance covers only the DISPATCHED proposals (nothing to attribute on a failed rail).
    const provIdeaIds = r.provenance.map((p) => p.ideaId);
    expect(provIdeaIds).toContain(ideas[1].id);
    expect(provIdeaIds).toContain(ideas[2].id);
    expect(provIdeaIds).not.toContain(ideas[0].id);
    // The failures remain identifiable from the cycle result alone.
    expect(r.routed.filter((d) => d.error).map((d) => d.proposalId)).toEqual(['P-plan']);
  });

  it('every rail failing still yields a completed, fully-recorded result (no routedRefs, no provenance)', async () => {
    const ports: RouterPorts = {
      plansNew: async () => {
        throw new Error('plans:new down');
      },
      gymDispatch: async () => {
        throw new Error('gym down');
      },
      capture: async () => {
        throw new Error('capture down');
      },
    };
    const { deps } = makeRailDeps(ports);

    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('completed');
    expect(r.routed).toHaveLength(3);
    expect(r.routed.every((d) => d.error != null && d.routedRef === undefined)).toBe(true);
    expect(r.provenance).toEqual([]); // nothing dispatched → nothing to attribute
  });

  it('the cycle does NOT catch a rejecting route PORT — per-rail isolation is routeProposals’ contract', async () => {
    // Production wiring (cycle-deps.ts) routes through routeProposals, which never
    // rejects on a rail failure. A port that rejects wholesale propagates — pinned
    // so nobody assumes the cycle adds a second safety net.
    const { deps } = makeSimpleDeps({
      route: async () => {
        throw new Error('route port down');
      },
    });
    await expect(runScoutCycle(deps)).rejects.toThrow('route port down');
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 6. Moonshot-only survivor set (D-005)
 * ──────────────────────────────────────────────────────────────────────── */

describe('moonshot-only survivors proceed (D-005)', () => {
  it('an all-moonshot survivor set reaches recombine and routes — leaps are not over-pruned', async () => {
    const GYM_PROPOSAL = { ...VALID_PROPOSAL, route: 'gym' };
    const { deps, recorded } = makeRealStepDeps({
      responders: [
        jsonAt(isIdeate, VALID_IDEAS),
        jsonAt(isCritique, MOONSHOT_CRITIC), // novel but not currently feasible — all moonshot
        jsonAt(isRecombine, GYM_PROPOSAL),
      ],
    });

    const r = await runScoutCycle(deps);

    // Survivors are EXCLUSIVELY moonshots (the cap keeps the 2 strongest leaps).
    expect(r.survivors.length).toBe(2);
    expect(r.survivors.every((s) => s.verdict === 'moonshot')).toBe(true);
    expect(r.scored.some((s) => s.verdict === 'keep')).toBe(false);

    // They proceeded: recombine spent LLM, fused them into a proposal…
    expect(r.calls.some((c) => c.step === 'recombine')).toBe(true);
    expect(r.proposals).toHaveLength(1);
    expect(new Set(r.proposals[0].sourceIdeaIds)).toEqual(new Set(r.survivors.map((s) => s.idea.id)));

    // …and the proposal routed (gym rail dispatched, provenance attributed).
    expect(r.stop).toBe('completed');
    expect(r.routed[0].routedRef).toBe(`gym:${r.proposals[0].id}`);
    expect(recorded.gymBatches).toHaveLength(1);
    expect(r.provenance.length).toBeGreaterThanOrEqual(2);
  });
});
