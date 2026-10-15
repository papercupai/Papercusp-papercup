/**
 * P-015 — the two OWNER-REPORTED queries, pinned as a relevance regression
 * (plan semantic-search-fingerprint-coverage-2026-08-03, decision D-031).
 *
 * ┌ WHY THIS IS AN EVAL AND NOT A UNIT TEST ──────────────────────────────────┐
 * │ A unit test proves the code runs. Both owner reports were about search    │
 * │ being WRONG while running perfectly, so only a graded measurement can     │
 * │ catch a regression in either.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ── Report 1: "theory" missed the theory-of-mind sessions ─────────── RECALL ─
 * ⚠ Measured with `recallAtK`, which lives in the harness rather than in
 * `metrics.ts` for a load-bearing reason: EVERY shipped metric scores only the
 * list handed to it. `ndcg` normalises against the ideal ordering OF THOSE SAME
 * GRADES, so a correctly-ordered page scores **1.0 whether it holds all the
 * relevant sessions or one of them**. Pinning this report with nDCG would
 * produce a guard that stays green through exactly the bug it exists to catch.
 *
 * ── Report 2: "knowledge pack" returned unrelated turns ─────────── PRECISION ─
 * The reported shape was exact and is therefore DERIVABLE, needing no human
 * grading: 8 of 16 cards came from the semantic leg alone and contained NEITHER
 * query word. `matchedBy === 'semantic'` + zero term overlap reproduces that
 * judgement mechanically.
 *
 * ── GROUND TRUTH IS DERIVED, AND PINNED BEHIND A CUTOFF ─────────────────────
 * Relevant sessions are computed from the corpus each run (a phrase scan), not
 * hand-authored, so they cannot rot as the corpus grows.
 *
 * ⚠ But the derivation has a self-reference hazard that MUST stay fixed: agent
 * sessions *discussing this eval* are themselves ingested into `session_turns`,
 * so the ground-truth set grows as a side effect of measuring it. It went 8 → 9
 * sessions during the work that produced this file, and one of the 9 WAS the
 * measuring session. Unbounded, that drifts the denominator upward and depresses
 * recall for reasons that have nothing to do with ranking. Hence GROUND_TRUTH_
 * CUTOFF: the relevant set is the sessions that existed when the owner reported
 * the bug, and it does not move.
 *
 * ── WHY IT SKIPS INSTEAD OF FAILING WHEN THERE IS NO CORPUS ─────────────────
 * This reads the LIVE operator store on purpose — the owner's bug lives in the
 * real corpus, and a seeded fixture would only reproduce the failure its author
 * already believed in. Ordinary integration tests here run against a FRESH,
 * EMPTY database (`createFreshPgDb`), where this eval has nothing to measure. A
 * vacuous run must never read as a pass, so it SKIPS LOUDLY with the reason
 * named. `assertRelevance` independently refuses a vacuous evaluation, so a
 * silent green is unreachable from either direction.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assertRelevance,
  evaluateRelevance,
  type RelevanceEvalResult,
} from '@papercusp/search-core';
// The ENGINE's own hit type, deliberately not a local mirror of it: a
// hand-rolled shape drifts silently, and `hitProvenance` reads fields
// (`rankers`/`rankerScores`) a partial mirror makes optional — which is exactly
// how a provenance check degrades to always-false and reports zero pollution.
import type { SearchHit } from '@papercusp/search';

/**
 * Sessions that existed when the bug was reported. Pinned — see the
 * self-reference hazard above. Do NOT advance this to "pick up newer data":
 * newer data is precisely what must not enter the relevant set.
 */
const GROUND_TRUTH_CUTOFF = '2026-08-08T00:00:00Z';

/** The route's real page size (the desktop agents-pill sends limit=30). */
const HIT_LIMIT = 30;

/**
 * MEASURED FLOORS — SHRINK-ONLY, i.e. ratchet UP as ranking improves; never down
 * to make a red go away.
 *
 * ── REPORT 1'S FLOOR IS A SESSION COUNT, NOT A RATIO ────────────────────────
 * At least `THEORY_RECALL_MIN_SESSIONS` of the pinned ground-truth sessions must
 * appear in the top `HIT_LIMIT`. It is a COUNT because the denominator is
 * DERIVED LIVE (`tomSessions`) and can only shrink: GROUND_TRUTH_CUTOFF pins the
 * set's UPPER bound so no new session can enter, but nothing pins the LOWER
 * bound — a pruned session silently leaves it. The set has already drifted 9 → 8.
 *
 * A fixed RATIO against a shrinking denominator is a guard that silently
 * WEAKENS: 2/9 demands two sessions at denominator 9, 8 and 6, but only ONE at
 * 4. That is the same false-green class as the vacuous-run hazard in the header,
 * arriving through the denominator instead of through an empty corpus. Raising
 * the ratio does NOT fix it — 2/8 weakens at exactly the same denominator — so
 * only a count does. See `theoryRecallFloor` and the control beside it.
 *
 * ── WHERE REPORT 1 ACTUALLY STANDS (2026-08-09, D-045) ──────────────────────
 * recall@30 = 2/8, up from 0/8, once D-045 removed an RRF rank-scale mismatch
 * that let the 48h fresh-window leg outrank the relevance ranking it continues.
 * Two gaps remain, in priority order — and NEITHER is a lexical-tuning job:
 *
 *   1. The recency DECAY still costs one ground-truth session (production 2/8
 *      against 3/8 with recency off). That is a DEFAULT_WEIGHT product question,
 *      not a bug: recency exists because WI-5097 reported staleness AS the bug.
 *      Do not retune it on the evidence of this one query.
 *   2. The other 5 are a LEXICAL CEILING (D-041, measured): of 968 turns
 *      matching `theory`, 859 — 89% — tie at exactly `ts_rank_cd` 0.1000,
 *      because a passing mention and a real discussion are the same document to
 *      a keyword ranker. No term-frequency-derived signal can separate them, so
 *      the only route is the SEMANTIC leg.
 *
 * ⚠ FOUR FIXES THIS COMMENT HAS NAMED OVER TIME ARE ALL DEAD. Do not re-open one
 * by citing the decision that first raised it — each was killed by a LATER
 * measurement:
 *   • P-014 (length normalisation) — D-032: every `ts_rank_cd` call site omits
 *     the normalisation argument, so there is no length term to tune.
 *   • P-011 (phrase-awareness) — D-040, proven rather than measured: the query
 *     is the SINGLE WORD `theory`, and `phraseto_tsquery('english','theory')` is
 *     byte-identical to `plainto_tsquery('english','theory')` — both emit
 *     `'theori'`. Identical tsquery ⇒ identical candidates, scores and fusion.
 *   • P-035 (BM25 via a PG extension) — D-041 SUPERSEDES the framing this very
 *     comment used to carry ("the one live route"). On a ONE-WORD query every
 *     BM25 ingredient is inert: IDF is a per-TERM scalar that multiplies every
 *     document identically and so cannot reorder anything at |Q|=1; TF
 *     saturation has nothing to saturate at tf 0–1; length normalisation is
 *     D-032 again. BM25 remains right for MULTI-word queries — it is not a fix
 *     for THIS one.
 *   • Session-level dedup/rollup — D-044: measured at EXACTLY ZERO recall change
 *     in both regimes on the real engine. (Its "2→4" was measured on the LEXICAL
 *     LEG ALONE, where the recency re-rank and fresh-window leg do not exist.)
 */
const THEORY_RECALL_MIN_SESSIONS = 2;

/**
 * The ratio `assertRelevance` takes, DERIVED from the live denominator so that
 * the demanded session COUNT stays constant however far the corpus is pruned.
 *
 * A zero denominator yields Infinity — an unclearable floor — which is the safe
 * direction. `skipReason` below refuses that corpus before this is ever reached.
 */
function theoryRecallFloor(groundTruthSize: number): number {
  return THEORY_RECALL_MIN_SESSIONS / groundTruthSize;
}
/** Report 2's exact owner-reported pollution shape is at ZERO and must stay there. */
const KNOWLEDGE_PACK_SEMANTIC_ONLY_POLLUTION_CEILING = 0;

/**
 * CONTROL for the floor derivation — deliberately OUTSIDE the live-corpus
 * `describe` below, so it still runs on the fresh/empty database where the eval
 * itself skips. A guard that has never failed is a guard nobody has tested.
 *
 * This floor REPLACED a rule that was wrong in one specific direction, so the
 * control's job is to FAIL against that retired rule rather than merely agree
 * with the new one — an agreeing-only control passes just as happily when the
 * property it claims to police is broken.
 *
 * Both predicates below mirror the REAL comparison (`recallAtK >= floor`, i.e.
 * two divisions by the same denominator) instead of reconstructing it as
 * `ceil(floor * denominator)`. That is not stylistic: `Math.ceil((2 / 9) * 9)`
 * is at the mercy of whether the product rounds to 1.999… or 2.000…4, which
 * would make this control's verdict a floating-point coin toss.
 */
describe('P-015 — Report 1\'s recall floor is denominator-independent', () => {
  /** The smallest number of ground-truth sessions that clears a given rule. */
  const demandOf = (floor: (denominator: number) => number) => (denominator: number) => {
    for (let hits = 0; hits <= denominator; hits += 1) {
      if (hits / denominator >= floor(denominator)) return hits;
    }
    return Infinity;
  };
  const demanded = demandOf(theoryRecallFloor);
  /** The rule this replaced: a fixed absolute ratio, measured at denominator 9. */
  const retired = demandOf(() => 2 / 9);

  it('demands the same session count at every denominator', () => {
    for (const denominator of [9, 8, 6, 4, 2]) {
      expect(demanded(denominator), `denominator ${denominator}`).toBe(THEORY_RECALL_MIN_SESSIONS);
    }
  });

  it('FAILS against the retired fixed-ratio rule, which weakened as the corpus shrank', () => {
    // Calibration first: at the denominator the retired rule was authored for,
    // the two agree. Without this, the divergence below could just as well mean
    // the control is comparing two unrelated things.
    expect(retired(9)).toBe(demanded(9));
    // The divergence that motivated the change: one pruned-corpus denominator at
    // which the retired rule silently accepted HALF the evidence.
    expect(retired(4)).toBe(1);
    expect(demanded(4)).toBe(2);
  });
});

/** Everything this eval needs from the live store + engine, or a skip reason. */
async function setup() {
  const [{ runHybridSearch, hitProvenance }, { SEARCH_SOURCES }, { buildQueryEmbedder }, { parseTurnRef }, { activeWorkspaceId }, { getOrgPg }] =
    await Promise.all([
      import('@papercusp/search'),
      import('../agent-tools/search/sources'),
      import('../agent-tools/search/embedder'),
      import('../agent-tools/sessions/_shared'),
      import('../workspace-registry'),
      import('@papercusp/db-org'),
    ]);
  const { rerankPageHead } = await import('../agent-tools/search/rerank');

  const { sql } = getOrgPg();
  const truth = await sql<Array<{ session_id: string }>>`
    SELECT DISTINCT session_id
      FROM harness_shared.session_turns
     WHERE text ILIKE '%theory of mind%'
       AND ts < ${GROUND_TRUTH_CUTOFF}::timestamptz`;
  const tomSessions = truth.map((r) => r.session_id);

  const sources = SEARCH_SOURCES.filter((s) => s.name === 'session_turn');
  // `null`, not undefined: hybrid mode takes `embedder: Embedder | null`, and an
  // OMITTED embedder is a type hole rather than a documented degrade. A null one
  // degrades the engine to BM25-only, which `skipIfDegraded` then refuses to
  // certify a hybrid-measured floor against.
  const embedder = await buildQueryEmbedder({ acquireBudgetMs: 30_000 }).catch(() => null);

  // The route's defaults (adv-session-search.ts), stated ONCE. A diagnostic
  // below varies a single knob against this; re-declaring the whole shape per
  // variant is how a "control" silently stops being the control.
  const PROD_RECENCY = {
    halfLifeMs: 24 * 7 * 3_600_000,
    weight: 0.5,
    freshWindowMs: 48 * 3_600_000,
  } as const;

  const sessionOf = (h: SearchHit) => parseTurnRef(h.source_id)?.sessionId ?? h.source_id;

  const search = async (
    query: string,
    override: {
      recency?: { halfLifeMs: number; weight: number; freshWindowMs: number } | false;
      groupBy?: ((hit: SearchHit) => string | null) | false;
      // 'embeddings' runs ONLY the vector ranker (hybrid.ts:277-284). Read the
      // caveat on the semantic-only variant below before adding a row that uses
      // it: it is not a one-knob change.
      mode?: 'embeddings' | 'hybrid';
    } = {},
  ) => {
    const { results, legs, totalGroups } = await runHybridSearch(sources, {
      sql,
      query,
      workspaceId: activeWorkspaceId(),
      scopeFilter: null,
      limit: HIT_LIMIT,
      mode: override.mode ?? 'hybrid',
      embedder,
      embedTimeoutMs: 30_000,
      // Measure what the owner actually experiences, not a cleaner
      // configuration than production. `'recency' in override` (not `??`)
      // because `false` is a MEANINGFUL value here — it means "force
      // pure-relevance", which `??` would silently discard back to the default.
      recency: 'recency' in override ? override.recency : PROD_RECENCY,
      // The owner-facing route renders SESSION CARDS. Make that shape part of
      // the production control before the top-N cut; a post-cut fold cannot
      // backfill duplicate-turn slots. `false` exists only for the diagnostic
      // row that measures the old row-level behavior.
      ...(override.groupBy === false ? {} : { groupBy: override.groupBy ?? sessionOf }),
      signal: new AbortController().signal,
      deferHighlight: true,
    });
    return { results: results as SearchHit[], legs, totalGroups };
  };

  return { search, rerankPageHead, sessionOf, hitProvenance, tomSessions, PROD_RECENCY };
}

/**
 * Refuse to certify a relevance floor measured on a DEGRADED engine.
 *
 * Both floors below were measured with both legs live. If the query embedder is
 * unavailable in this process the engine silently degrades to BM25-only — which
 * is correct behaviour for a search, and fatal for an eval: it would compare a
 * keyword-only ranking against a hybrid floor and report the verdict as if the
 * systems were the same. That is the identical trap D-031 caught on the other
 * side, where a precision of 1.0 could have meant "well-floored semantic leg" or
 * "semantic leg returned nothing" — the leg report is what separates them.
 *
 * A degraded run is therefore neither a pass nor a fail: it measured a different
 * system, so it SKIPS and says so.
 */
function skipIfDegraded(legs: { degraded?: boolean; warning?: string | null } | undefined, t: { skip: (note?: string) => void }): boolean {
  if (!legs?.degraded) return false;
  const why = `engine DEGRADED (${legs.warning ?? 'a ranker leg did not run'}) — floors were measured with both legs live, so this run measured a different system`;
  console.warn(`[P-015] ${why}`);
  t.skip(why);
  return true;
}

type Setup = Awaited<ReturnType<typeof setup>>;
let ctx: Setup | null = null;
let skipReason: string | null = null;
try {
  ctx = await setup();
  if (ctx.tomSessions.length === 0) {
    skipReason =
      `no ground truth: zero sessions before ${GROUND_TRUTH_CUTOFF} contain the phrase — ` +
      'this is a FRESH/EMPTY corpus (the createFreshPgDb path), not a relevance result';
  }
} catch (err) {
  skipReason = `live operator store unreachable: ${(err as Error).message}`;
}

/**
 * Report the GRADED metrics `evaluateRelevance` already computes and this file
 * threw away.
 *
 * Both evals below pass a real graded `grade()` (0..3), so every call has always
 * returned `ndcgAtK` / `precisionAtK` / `accessoryAtK` alongside the recall this
 * file asserts — and until 2026-08-10 every one of those numbers was discarded at
 * the call site. That matters because recall is a SET metric: it can only see a
 * relevant session crossing into the top k, never a change in WHERE the ones
 * already there rank. nDCG can see exactly that, and it was being computed and
 * dropped on every run.
 *
 * ⚠ REPORTED, DELIBERATELY NOT ASSERTED. A floor set before its baseline is known
 * would red the shared gate on a number nobody has measured yet. Read these logs
 * over a few runs first, then ratchet a `minNdcgAtK` into the `assertRelevance`
 * calls below — that is the intended next step, not an oversight.
 *
 * ⚠ And nDCG is NOT a retro-explanation for the null results already on record.
 * D-061 measured Report 1 at recall 0.000 with ALL 8 pinned sessions missed: every
 * top-k grade was 0, so nDCG@k was 0 too and could have discriminated nothing.
 * Since D-069 moved Report 1 to 2/8 the page finally holds relevant rows, which is
 * what makes ordering measurable from here ON — not retroactively.
 *
 * Context: plan semantic-search-fingerprint-coverage-2026-08-03, D-072 (which
 * retracted D-071's claim that this repo had no graded metric — it always did).
 */
function reportGradedMetrics(report: string, out: RelevanceEvalResult): void {
  // ⚠ MIXED SCALES, deliberately rendered differently. nDCG/precision/recall are
  // RATES (0..1); `accessoryAtK` is a COUNT of polluting rows — `metrics.ts:45`
  // filters and returns `.length` with no division, and its docstring says so
  // ("acc@5 … ≥ 2 flags a polluted query"). The first draft of this line printed
  // it as `accessory 27.0000` beside three rates, which reads as a rate of 27 —
  // i.e. as a broken metric. It is not: 27 of the top 30 rows scored ≤ 1.
  //
  // The ambiguity is invisible at the only place the repo currently asserts it,
  // because KNOWLEDGE_PACK_ACCESSORY_CEILING is 0 and zero is zero on either
  // scale. Anyone ratcheting a NONZERO accessory ceiling must read it as a count,
  // or be wrong by a factor of k.
  const graded = Math.min(out.k, out.grades.length);
  // console.LOG, not warn — see the note on the stage-isolation report below.
  console.log(
    `[P-015] ${report} — graded metrics @${out.k}: ` +
      `nDCG ${out.ndcgAtK.toFixed(4)} · precision ${out.precisionAtK.toFixed(4)}` +
      (out.recallAtK === null ? '' : ` · recall ${out.recallAtK.toFixed(4)}`) +
      ` · accessory ${out.accessoryAtK}/${graded} rows (COUNT, not a rate)` +
      `\n         grades in rank order: [${out.grades.join(',')}]`,
  );
}

describe.skipIf(skipReason !== null)('P-015 — owner-reported query relevance (live corpus)', () => {
  it(
    'Report 1: "theory" surfaces the theory-of-mind sessions (RECALL — shrink-only floor)',
    async (t) => {
      const { search, sessionOf, tomSessions } = ctx!;
      const { results: ranked, legs } = await search('theory');
      if (skipIfDegraded(legs, t)) return;
      const out = evaluateRelevance({
        ranked,
        grade: (h) => (tomSessions.includes(sessionOf(h)) ? 3 : 0),
        k: HIT_LIMIT,
        groundTruth: { ids: tomSessions, idOf: sessionOf },
      });

      // A vacuous run is a failure, never a pass — see the header.
      expect(out.coverage).toBe('complete');

      reportGradedMetrics('Report 1 "theory"', out);

      const verdict = assertRelevance(out, { minRecallAtK: theoryRecallFloor(tomSessions.length) });
      expect(
        verdict.ok,
        `recall@${HIT_LIMIT}=${out.recallAtK?.toFixed(3)} — fewer than ` +
          `${THEORY_RECALL_MIN_SESSIONS} of the ${tomSessions.length} pinned sessions reached the ` +
          `top ${HIT_LIMIT}. ${verdict.failures.join(' | ')}\n` +
          'This floor is SHRINK-ONLY, and it is a COUNT rather than a ratio: it demands the same ' +
          `${THEORY_RECALL_MIN_SESSIONS} sessions however far the corpus is pruned, so a red here ` +
          'is a RANKING regression and never a smaller denominator.\n' +
          'SUSPECT THE FUSION STAGE FIRST. D-045 found an RRF rank-scale mismatch that drove this ' +
          'exact metric to 0/8: each leg was scored by its rank WITHIN ITS OWN list, so the 48h ' +
          'fresh-window leg — carrying exactly the rows that had LOST the relevance cut — was ' +
          're-indexed from 0 in an uncontested pool and collected what the corpus best hit gets. ' +
          'Run the DIAGNOSTIC below before theorising; it isolates the stage that moved.\n' +
          'D-031 measured these sessions as RETRIEVED (8 of 9 by depth 300) but ranked 65-170. If ' +
          'that still holds the fix must REORDER what is already admitted and more reranking ' +
          'depth cannot help — but re-measure rather than assume: that figure PRE-DATES D-045.\n' +
          'Do NOT reach for P-014, P-011, P-035 or session dedup. All four are dead ends, and all ' +
          'four were once named in this very message as the way forward — see the floor comment ' +
          'above for the measurement that killed each. In particular P-035 (BM25) is NOT the live ' +
          'route: D-041 superseded that framing, because every BM25 ingredient is inert on a ' +
          'one-word query.',
      ).toBe(true);
    },
    120_000,
  );

  /**
   * WHERE IN THE PIPELINE IS REPORT 1 LOST? (P-036)
   *
   * Report 1's floor is a single number, so a red says the ranking got worse
   * without saying WHICH STAGE made it worse — and the plan then spends its
   * effort on whichever stage the last agent happened to suspect. Every dead
   * direction on this plan (D-032/D-036/D-040/D-041) was killed by a
   * measurement someone eventually ran; this runs the ones that are cheap to
   * run EVERY time, so the next red arrives already triaged.
   *
   * It varies ONE knob at a time against the production control and REPORTS.
   * Deliberately not a second floor: two assertions over one measurement would
   * red twice for one cause, and the pinned floor above is the guard.
   */
  it(
    'DIAGNOSTIC: which ranking stage loses the theory-of-mind sessions (reports, does not gate)',
    async (t) => {
      const { search, sessionOf, tomSessions, PROD_RECENCY } = ctx!;
      const bySession = (h: SearchHit) => sessionOf(h);
      // The IDENTITIES, not merely the count. Two variants can both score 2/8
      // on DIFFERENT sessions — in which case each leg is contributing ground
      // truth the other misses and FUSION is discarding it, which is the
      // opposite conclusion from "that leg contributes nothing". A count cannot
      // separate those two, and D-052 was first recorded off counts alone.
      const foundIds = (ranked: SearchHit[]) =>
        [...new Set(ranked.map(sessionOf).filter((s) => tomSessions.includes(s)))].sort();

      const variants: Array<[string, Parameters<typeof search>[1]]> = [
        ['production (control)', {}],
        // Isolates the 48h fresh-window LEG from the recency re-rank: same
        // decay, but no extra RRF input. A session with no turn in the window
        // cannot earn that leg's vote at all, so it is the one knob that can
        // deny a candidate points rather than merely reweight it.
        ['no fresh-window leg', { recency: { ...PROD_RECENCY, freshWindowMs: 0 } }],
        // SEMANTIC LEG ALONE — does the vector ranker retrieve these sessions at
        // all? That is the question that separates a FUSION failure (the legs
        // find them; the fusion buries them) from a RETRIEVAL failure (nothing
        // finds them), and the two have opposite fixes: EI-20004037141980473's
        // fresh-leg double-vote versus P-035's BM25 extension.
        //
        // ⚠ mode:'embeddings' drops the BM25 legs, but it ALSO drops the
        // fresh-window leg — hybrid.ts:392 gates that on mode === 'hybrid'. So
        // against the production control it is TWO knobs, and one-knob-per-row
        // is this diagnostic's whole discipline. Pairing it with freshWindowMs:0
        // makes it a clean ONE-knob delta against the row ABOVE instead, and
        // that delta is exactly the lexical leg's contribution.
        //
        // The floor is NOT a third knob: mode reaches the host minScore policy
        // (hybrid.ts:294), but that policy branches only on mode === 'fulltext'
        // (configure-search-defaults.ts:51-58), so 'hybrid' and 'embeddings'
        // resolve an identical floor. Verified by reading the policy.
        [
          'semantic alone (vs row above)',
          { mode: 'embeddings', recency: { ...PROD_RECENCY, freshWindowMs: 0 } },
        ],
        ['no recency at all', { recency: false }],
        ['row-level (no session rollup)', { groupBy: false }],
        ['no recency, row-level', { recency: false, groupBy: false }],
      ];

      const rows: string[] = [];
      const controlLabel = variants[0][0];
      for (const [label, override] of variants) {
        const { results, legs, totalGroups } = await search('theory', override);
        // A degraded CONTROL is uncertifiable: it is the baseline every other
        // row is read against, so the whole report goes — that is the D-031
        // discipline skipIfDegraded exists for. A degraded VARIANT costs only
        // its own row.
        //
        // This loop previously returned on ANY degrade, while the rows are
        // console.logged only AFTER it — so one flaky embed silently discarded
        // every measurement already taken. The embed runs on a budget that does
        // time out on this corpus, and the semantic-only row above depends on
        // it entirely, which is what makes that pre-existing edge likely rather
        // than theoretical.
        if (legs?.degraded) {
          if (label === controlLabel) {
            skipIfDegraded(legs, t);
            return;
          }
          rows.push(
            `  ${label.padEnd(29)} SKIPPED — ${legs.warning ?? 'a ranker leg did not run'}`,
          );
          continue;
        }
        const distinct = new Set(results.map(sessionOf)).size;
        const hits = foundIds(results);
        rows.push(
          `  ${label.padEnd(29)} recall ${hits.length}/${tomSessions.length}` +
            `  page ${results.length} rows / ${distinct} distinct sessions` +
            (totalGroups === undefined ? '' : ` (pool held ${totalGroups})`) +
            (hits.length ? `\n${' '.repeat(33)}↳ ${hits.join(' ')}` : ''),
        );
      }
      // console.LOG, not warn: `vitest-fail-on-console` fails a test on an
      // unexpected warn/error, and the escape hatch for that is an
      // infrastructure-NOISE allowlist ("keep this list short and exact —
      // broadening it weakens the guard for every test in the monorepo").
      // A deliberate report is not noise, so it belongs at a level the guard
      // does not police rather than in that list.
      console.log(`[P-015] Report-1 stage isolation (k=${HIT_LIMIT}):\n${rows.join('\n')}`);

      // The one PROPERTY worth asserting here, because it is what the rollup
      // claims to do and it cannot be true by accident: with a session groupBy,
      // every row on the page is a distinct session.
      const { results: deduped } = await search('theory', { groupBy: bySession });
      expect(new Set(deduped.map(sessionOf)).size).toBe(deduped.length);
    },
    180_000,
  );

  it(
    'Report 2: "knowledge pack" returns no semantic-only hit lacking both query terms (PRECISION)',
    async (t) => {
      const { search, hitProvenance } = ctx!;
      const { results: ranked, legs } = await search('knowledge pack');
      if (skipIfDegraded(legs, t)) return;
      const hasTerm = (h: SearchHit) => {
        const t = `${h.excerpt ?? ''} ${h.highlight ?? ''}`.toLowerCase();
        return t.includes('knowledge') || t.includes('pack');
      };
      // The reported pollution shape, reproduced mechanically: matched by the
      // vector leg ALONE and containing neither query word.
      const isPollution = (h: SearchHit) => hitProvenance(h).matchedBy === 'semantic' && !hasTerm(h);

      const out = evaluateRelevance({
        ranked,
        grade: (h) => (isPollution(h) ? 0 : hasTerm(h) ? 3 : 1),
        k: HIT_LIMIT,
      });
      expect(out.coverage).toBe('complete');

      reportGradedMetrics('Report 2 "knowledge pack"', out);

      // `accessoryAtK` is intentionally broader: it counts EVERY grade <= 1.
      // The owner's reported defect is the exact `isPollution` predicate above,
      // so gate that population directly. D-090 records the correction after a
      // live run had accessory=4 while true semantic-only pollution remained 0.
      const pollutionCount = ranked.filter(isPollution).length;
      expect(
        pollutionCount <= KNOWLEDGE_PACK_SEMANTIC_ONLY_POLLUTION_CEILING,
        `${pollutionCount} semantic-only, zero-term polluting card(s) of ${ranked.length}. ` +
          `The broader accessory diagnostic is ${out.accessoryAtK}/${Math.min(out.k, out.grades.length)}.\n` +
          'The owner saw 8 of 16. D-031 measured 0 — a regression here means the ' +
          'P-017 similarity floor stopped holding on this corpus.',
      ).toBe(true);
    },
    120_000,
  );
});

// A skip must be VISIBLE, never silent — the whole failure mode this guards.
describe.runIf(skipReason !== null)('P-015 — owner-query relevance SKIPPED', () => {
  it('reports why it could not measure (this is not a pass)', () => {
    const warning = `[P-015] owner-query relevance eval SKIPPED — ${skipReason}`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    console.warn(warning);
    expect(warn).toHaveBeenCalledWith(warning);
    expect(skipReason).toBeTruthy();
  });
});
