/**
 * LIVE population census for goal-agent-behavior-feedback-2026-09-06 AUTO-BAR-R-3
 * (P-004 / P-002 / P-014, evidence plane `live`, ruling D-023 rule 1):
 * "Each criterion without an observed opportunity is reported as unknown or idle."
 * Falsifier: "An unexercised or unobserved opportunity receives a passing/failing conduct rating."
 *
 * Population (fixed before counting, D-018): every behavior-grading card in the live operator
 * database, i.e. observation-lane `harness_shared.work_items` rows in workspace
 * `papercusp-workspace` whose `payload.observation.rubricRef` is `goal-mode-e2e`, created at or
 * after CUTOFF (after P-002/P-014 closed; the pre-closure cards predate structured
 * `unknownReason`). Each rating in `payload.observation.ratings` is one criterion.
 *
 * Property asserted over the whole population. N and the cutoff are reported; N is never
 * hard-coded:
 *   1. every `unknown` / `idle` rating discloses WHY: a non-empty `unknownReason` on a card
 *      created at or after STRUCTURED_REASON_CONTRACT (the commit that made scorecards:emit
 *      and scorecards:evaluate refuse one without it); before that, when nothing at emit
 *      required the field, non-empty `evidence` prose also discloses it (D-062). The census
 *      line reports how many ratings took the prose path, so the exemption is never silent; and
 *   2. no `pass` / `partial` / `fail` rating's evidence says the opportunity never arose.
 * The in-file controls prove the checker rejects both falsifier shapes, so a green run is not
 * a vacuous one.
 *
 * GUARDED: this asserts over LIVE behavior, so it must never enter the green-checkpoint gate
 * (a new card could freeze main fleet-wide). It runs ONLY when PAPERCUSP_R3_CENSUS_LIVE=1 AND
 * the operator database answers; otherwise the census suite skips. The controls always run.
 *
 *   PAPERCUSP_R3_CENSUS_LIVE=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp \
 *     npm run test:file -- packages/operator-core/lib/behavior-grading-r3-no-opportunity.live.test.ts
 */
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { allowRealPgForLiveSuite } from './testing/live-suite-real-pg';

const WORKSPACE = 'papercusp-workspace';
const RUBRIC_REF = 'goal-mode-e2e';
const CUTOFF = '2026-09-21T05:25:00Z';
/** f9748d00a3: validateGoalBehaviorUnknownDisclosure wired into scorecards:emit and :evaluate. */
const STRUCTURED_REASON_CONTRACT = '2026-10-02T14:34:31Z';
const NO_OPPORTUNITY =
  /(no (observed |real )?opportunit|unexercised|not exercised|never (arose|came up|exercised)|nothing (to|was) (grade|rate|observe))/i;
const NON_OBSERVED = new Set(['unknown', 'idle']);
const CONDUCT = new Set(['pass', 'partial', 'fail']);

export interface CensusRating {
  card: string;
  criterion: string;
  rating: string;
  unknownReason: string | null;
  evidence: string | null;
  /** Created before STRUCTURED_REASON_CONTRACT, so prose evidence may carry the reason. */
  preContract: boolean;
}

/** Pre-contract unknown/idle ratings whose only disclosure is evidence prose (reported, not hidden). */
export function r3ProseReasonRatings(ratings: CensusRating[]): number {
  return ratings.filter(
    (r) =>
      NON_OBSERVED.has(r.rating) &&
      !(r.unknownReason ?? '').trim() &&
      r.preContract &&
      (r.evidence ?? '').trim(),
  ).length;
}

export function r3Violations(ratings: CensusRating[]): string[] {
  const out: string[] = [];
  for (const r of ratings) {
    const where = `${r.card}#${r.criterion}`;
    const disclosed =
      Boolean((r.unknownReason ?? '').trim()) || (r.preContract && Boolean((r.evidence ?? '').trim()));
    if (NON_OBSERVED.has(r.rating) && !disclosed) {
      out.push(`undisclosed-${r.rating}:${where}`);
    }
    if (CONDUCT.has(r.rating) && NO_OPPORTUNITY.test(r.evidence ?? '')) {
      out.push(`conduct-rating-without-opportunity:${r.rating}:${where}`);
    }
  }
  return out;
}

const POPULATION_SQL = `
  SELECT w.feature_id AS card, e.key AS criterion, e.value->>'rating' AS rating,
         e.value->>'unknownReason' AS "unknownReason", e.value->>'evidence' AS evidence,
         w.created_ts < (extract(epoch FROM $4::timestamptz) * 1000)::bigint AS "preContract"
    FROM harness_shared.work_items w,
         LATERAL jsonb_each(w.payload->'observation'->'ratings') e
   WHERE w.workspace_id = $1
     AND w.lane = 'observation'
     AND w.payload->'observation'->>'rubricRef' = $2
     AND w.created_ts >= (extract(epoch FROM $3::timestamptz) * 1000)::bigint
   ORDER BY w.feature_id, e.key`;

async function openLive(): Promise<Client | null> {
  if (process.env.PAPERCUSP_R3_CENSUS_LIVE !== '1') return null;
  const client = new Client({ connectionString: getHarnessAdminUrl(), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return client;
  } catch {
    await client.end().catch(() => undefined);
    return null;
  }
}

const LIVE = await openLive();
allowRealPgForLiveSuite(Boolean(LIVE));

describe('R-3 census checker controls (always run)', () => {
  const base = { card: 'EI-x', criterion: 'c', evidence: null, unknownReason: null, preContract: false };
  it('rejects an unknown rating that does not say why', () => {
    expect(r3Violations([{ ...base, rating: 'unknown', unknownReason: '  ' }])).toEqual([
      'undisclosed-unknown:EI-x#c',
    ]);
  });
  it('rejects a post-contract unknown whose reason is only prose', () => {
    expect(
      r3Violations([{ ...base, rating: 'unknown', evidence: 'Not exercised in this window.' }]),
    ).toEqual(['undisclosed-unknown:EI-x#c']);
  });
  it('accepts a pre-contract prose reason, counts it, and still rejects a pre-contract silent one', () => {
    const prose = { ...base, rating: 'idle', preContract: true, evidence: 'Not exercised in this window.' };
    const silent = { ...base, card: 'EI-y', rating: 'unknown', preContract: true, evidence: '  ' };
    expect(r3Violations([prose, silent])).toEqual(['undisclosed-unknown:EI-y#c']);
    expect(r3ProseReasonRatings([prose, silent])).toBe(1);
  });
  it('rejects a conduct rating on an opportunity that never arose', () => {
    expect(
      r3Violations([{ ...base, rating: 'pass', evidence: 'No opportunity arose in this window.' }]),
    ).toEqual(['conduct-rating-without-opportunity:pass:EI-x#c']);
  });
  it('accepts a disclosed unknown and an evidenced conduct rating', () => {
    expect(
      r3Violations([
        { ...base, rating: 'unknown', unknownReason: 'no-opportunity' },
        { ...base, rating: 'fail', evidence: 'Agent skipped the checkpoint at turn 12.' },
      ]),
    ).toEqual([]);
  });
});

describe.skipIf(!LIVE)('LIVE: R-3 no-opportunity census (AUTO-BAR-R-3)', () => {
  it('reports every unobserved criterion as unknown/idle with a reason, never pass/fail', async () => {
    const { rows } = await LIVE!.query<CensusRating>(POPULATION_SQL, [
      WORKSPACE,
      RUBRIC_REF,
      CUTOFF,
      STRUCTURED_REASON_CONTRACT,
    ]);
    await LIVE!.end();
    const cards = new Set(rows.map((r) => r.card)).size;
    const split: Record<string, number> = {};
    for (const r of rows) split[r.rating] = (split[r.rating] ?? 0) + 1;
    console.info(
      `R3_CENSUS cutoff=${CUTOFF} contract=${STRUCTURED_REASON_CONTRACT} rubric=${RUBRIC_REF} cards=${cards} ` +
        `ratings=${rows.length} split=${JSON.stringify(split)} preContractProseReasons=${r3ProseReasonRatings(rows)}`,
    );
    // Non-vacuous: an empty population proves nothing about the property.
    expect(rows.length).toBeGreaterThan(0);
    expect(r3Violations(rows)).toEqual([]);
  });
});
