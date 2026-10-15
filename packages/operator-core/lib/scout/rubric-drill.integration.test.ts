/**
 * rubric-drill.integration.test.ts — the LIVE rubric-seeding DRILL as a repeatable
 * health check (blender-self-learning-2026-07-12 P-013).
 *
 * The blender learning loop's most load-bearing arc is: a MEASURED rubric regression
 * (a scorecard criterion graded `broken`) must deterministically SEED a grounded,
 * routed idea (P-004: buildRubricFocus → the first ideator slot is REQUIRED to cite a
 * worst-measured rubric ref → the idea routes → the per-lane grounding histogram counts
 * the `rubric-rating` lane, P-006). The WI-4250 audit found this arc silently DEAD
 * (0/116 routed ideas ever cited a rubric pattern), so it needs a standing, repeatable
 * probe — not a one-time verification.
 *
 * This drill IS that probe: it files a VACCINATION-planted `origin:drill` scorecard with
 * a distinctive broken criterion, forces ONE real `runScoutCycle` over the production
 * composition, and asserts the whole arc lands in real storage. Every seam is real
 * (real PG, real digest synthesis, real router/dispatch, real routed-ledger) EXCEPT the
 * LLM (the shared `makeFakeScoutLlm`, scripted to ground the seeded slot on the drill
 * ref) — the established "real-rails" pattern (cycle-real-rails.integration.test.ts).
 *
 * The `origin:drill` tag is the crux of "repeatable": a drill signal must be able to
 * exercise the loop WITHOUT contaminating organic learning. So the drill scorecard is
 * excluded from the DEFAULT (ORGANIC_ONLY) readers — asserted here as a standing
 * invariant — and surfaced only by a drill-mode reader
 * (`buildStateOfHiveReaders({ observationOrigins: [...ORGANIC_ONLY, 'drill'] })`), which
 * widens ONLY the dedicated rubricRatings lane; the free-text friction learner stays
 * organic-only, so a drill can never leak into it.
 *
 * Wiring: the real `@papercusp/db-org` path is ENV-ROUTED at a throwaway migrated DB
 * (HARNESS_DATABASE_URL / HARNESS_ADMIN_DATABASE_URL + cache resets), identical to
 * cycle-real-rails — so createIssue (the drill scorecard), the digest readers, the
 * cycle dispatch, and the routed-ledger all resolve the SAME real schema, no module
 * mocks beyond the host-only SSE bus.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// capture-core lazily imports lib/sync-sse to fire a sync invalidate after a create;
// the real module wires a PG LISTEN bus (host-only). Stub the notify.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

// Pin the Scout OVERLAY rails OFF (same as cycle-real-rails): the experiment rail spends
// an extra untagged LLM call per TESTABLE proposal and the rubric-GAP rail authors drafts
// off rubricGaps — neither is under test here, and both would issue LLM calls our three
// scripted responders don't answer. The P-004 rubric SEEDING (buildRubricFocus → slot 0)
// is NOT flag-gated, so it is unaffected by pinning these off.
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return {
    ...actual,
    getFlag: async (
      flag: Parameters<typeof actual.getFlag>[0],
      distinct: Parameters<typeof actual.getFlag>[1],
    ) =>
      flag === 'papercusp-scout-experiment-rail' || flag === 'papercusp-scout-rubric-rail'
        ? false
        : actual.getFlag(flag, distinct),
  };
});

import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes (same as cycle-real-rails)
import { _resetUrlCacheForTests } from '../../../../libs/papercusp/libs/db/src/connection';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { registerHarnessProject } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { createIssue } from '../issues-engineer';
import { OBSERVATION_LANE, OBSERVATION_TOPIC } from '../harness/improvements/read-items';
import { ORGANIC_ONLY } from '../harness/improvements/provenance';
import { runScoutCycle, type ScoutCycleResult } from './cycle';
import { buildScoutCycleDeps } from './cycle-deps';
import { buildStateOfHiveReaders } from './corpus-digest-deps';
import { synthesizeStateOfHive } from './corpus-digest';
import { createScoutPlanDraft } from './scout-plan-draft';
import { buildScoutArchivePort, type ScoutArchivePort } from './scout-archive-port';
import { readRoutedIdeas, recordRoutedIdea } from './routed-ledger';
import { groundingLaneHistogram } from './scheduler';
import { makeFakeScoutLlm, type ScoutLlmResponder } from './test-support';

const WS = 'ws-rubric-drill';
const HARNESS = 'rubric-drill-it';
const CYCLE_ID = 'rubric-drill-cycle-1';
const NOW_MS = Date.parse('2026-07-13T00:00:00.000Z');

// The drill's distinctive, planted broken criterion. Its digest ref (buildRubricRatings:
// `rubric:<rubricRef>#<criterion>@<sourceHive>`) is the one the seeded ideator must cite.
const RUBRIC_REF = 'blender-drill-probe';
const CRITERION = 'seeded-broken-criterion';
const HIVE = 'papercusp';
const DRILL_PATTERN_REF = `rubric:${RUBRIC_REF}#${CRITERION}@${HIVE}`;

/* ── Fake-LLM script — one seeded, grounded idea → one proposal → the improvement rail.
 * maxIdeators:1 clamps the roster to the first slot, which (P-004) carries the rubric
 * focus, so the single ideate/critique/recombine trio is all we script. The idea grounds
 * on DRILL_PATTERN_REF (a valid digest ref once the drill scorecard surfaces), satisfying
 * both the forced rubric-focus and the downstream "grounds in nothing ⇒ rejected" gate. ── */

const IDEA = {
  title: 'Auto-quarantine a criterion the moment it grades broken twice',
  body: 'A broken rubric criterion should trip a scoped guard rather than wait for a human to notice the regression.',
  mechanism: 'On the second consecutive broken grade, open a scoped work-item and gate the affected surface behind a health flag.',
} as const;

const PROPOSAL = {
  framing: 'A measured-broken criterion should self-escalate',
  mechanism: 'On a repeat broken grade, auto-file a scoped guard item and flag the surface.',
  whyNew: 'Today a broken criterion only ideates if the lane wins salience; escalation is untried.',
  bet: 'Broken criteria stop silently persisting across cycles.',
} as const;

const ideatorResponder: ScoutLlmResponder = (opts) => {
  if (!(opts.system ?? '').includes('You are a SCOUT')) return undefined;
  const json = {
    ideas: [
      {
        title: IDEA.title,
        body: IDEA.body,
        mechanism: IDEA.mechanism,
        addressesPatternRefs: [DRILL_PATTERN_REF],
      },
    ],
  };
  return { json, text: JSON.stringify(json) };
};

const criticResponder: ScoutLlmResponder = (opts) => {
  if (!(opts.system ?? '').includes('TWO adversarial critics')) return undefined;
  const json = { conceptualNovelty: 0.85, feasibility: 0.8, rationale: 'scripted keep verdict for the rubric drill' };
  return { json, text: JSON.stringify(json) };
};

const recombineResponder: ScoutLlmResponder = (opts) => {
  if (!(opts.system ?? '').includes('Scout proposer')) return undefined;
  const json = {
    framing: PROPOSAL.framing,
    mechanism: PROPOSAL.mechanism,
    whyNew: PROPOSAL.whyNew,
    bet: PROPOSAL.bet,
    experiment: {
      hypothesis: `If we ship this, the bet holds: ${PROPOSAL.bet}`,
      method: 'Run the cheapest instrumented probe over one week of normal Hive traffic.',
      falsifiableSignal: 'The instrumented arm shows no measurable improvement over baseline.',
    },
    route: 'improvement',
  };
  return { json, text: JSON.stringify(json) };
};

describe('rubric-seeding drill — a vaccination-planted broken criterion seeds a grounded routed idea (P-013)', () => {
  let db: OrgTestDb;
  let archive: ScoutArchivePort;
  let result: ScoutCycleResult;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    db = await createOrgTestDb();

    savedEnv.HARNESS_DATABASE_URL = process.env.HARNESS_DATABASE_URL;
    savedEnv.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();

    await registerHarnessProject(db.adminSql, WS, HARNESS);

    // ── Plant the drill scorecard: a rubric-graded observation, signal_origin='drill',
    //    with ONE distinctive broken criterion. Real filing path (createIssue → the
    //    canonical observation lane → the observations() reader → buildRubricRatings). ──
    await createIssue({
      title: 'rubric-seeding drill scorecard (vaccination)',
      topics: [OBSERVATION_TOPIC],
      createdBy: 'rubric-drill',
      signalOrigin: 'drill',
      payload: {
        lane: OBSERVATION_LANE,
        observation: {
          rubricRef: RUBRIC_REF,
          sourceHive: HIVE,
          ratings: {
            [CRITERION]: { rating: 'broken', evidence: 'drill: planted broken criterion for the P-013 health check' },
          },
        },
      },
    });

    // Real drill-mode + default readers built AFTER the env is routed.
    const drillReaders = buildStateOfHiveReaders({ observationOrigins: [...ORGANIC_ONLY, 'drill'] });
    const fakeLlm = makeFakeScoutLlm({
      responders: [ideatorResponder, criticResponder, recombineResponder],
    });
    archive = await buildScoutArchivePort({ workspaceId: WS, harnessSlug: HARNESS });

    const deps = buildScoutCycleDeps({
      harnessSlug: HARNESS,
      llmCall: fakeLlm.call,
      createPlanDraft: (args) =>
        createScoutPlanDraft({ ...args, harnessSlug: HARNESS, workspaceId: WS, date: '2026-07-13' }),
      archive,
      limits: { maxIdeators: 1, maxCostUsd: 0.05 },
      cycleId: CYCLE_ID,
      stateOfHiveReaders: drillReaders,
      digestOptions: { nowMs: NOW_MS },
      noveltyCorpus: async () => [],
    });

    result = await runScoutCycle(deps);
    await archive.flush();

    // Mirror the scheduler's persistRouted: one recordRoutedIdea per provenance row.
    for (const r of result.provenance) {
      await recordRoutedIdea({
        ideaId: r.ideaId,
        lens: r.lens,
        rail: r.rail,
        routedRef: r.routedRef,
        harnessSlug: HARNESS,
        cycleId: CYCLE_ID,
        title: r.title,
        addressesPatternRefs: r.addressesPatternRefs,
        workspaceId: WS,
      });
    }

    await new Promise((resolve) => setImmediate(resolve));
  }, 180_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetUrlCacheForTests();
    await _resetForTests();
    await db?.cleanup();
  });

  it('INVARIANT: the default (organic-only) readers do NOT surface the drill scorecard', async () => {
    // The drill signal must stay OUT of organic learning — the whole premise of a
    // repeatable drill. The default reader floor is ORGANIC_ONLY, so the drill row is
    // invisible to it and its rubricRatings lane never carries the drill ref.
    const organic = await synthesizeStateOfHive(buildStateOfHiveReaders(), { nowMs: NOW_MS });
    expect(organic.rubricRatings.some((p) => p.ref === DRILL_PATTERN_REF)).toBe(false);
    expect(organic.corpus.observations).toBe(0);
  });

  it('DRILL SURFACES: the drill-mode digest carries the planted broken criterion as a rubric measurement', () => {
    // result.digest was synthesized with the drill-mode readers.
    const pat = (result.digest.rubricRatings ?? []).find((p) => p.ref === DRILL_PATTERN_REF);
    expect(pat).toBeDefined();
    expect(pat!.category).toBe('rubric-rating');
    expect(pat!.summary).toContain('broken');
  });

  it.each([
    { label: 'topic-only', lane: undefined },
    { label: 'null-lane', lane: null },
  ])('INVARIANT: a $label scorecard is excluded even when drill origins are allowed', async ({ label, lane }) => {
    const rubricRef = `${RUBRIC_REF}-${label}`;
    await createIssue({
      title: `rubric-seeding ${label} negative control`,
      topics: [OBSERVATION_TOPIC],
      createdBy: 'rubric-drill',
      signalOrigin: 'drill',
      payload: {
        ...(lane === undefined ? {} : { lane }),
        observation: {
          rubricRef,
          sourceHive: HIVE,
          ratings: {
            [CRITERION]: { rating: 'broken', evidence: 'drill: non-observation lane negative control' },
          },
        },
      },
    });

    const digest = await synthesizeStateOfHive(
      buildStateOfHiveReaders({ observationOrigins: [...ORGANIC_ONLY, 'drill'] }),
      { nowMs: NOW_MS },
    );
    expect(digest.rubricRatings.some((p) => p.ref === DRILL_PATTERN_REF)).toBe(true);
    expect(digest.rubricRatings.some((p) => p.ref === `rubric:${rubricRef}#${CRITERION}@${HIVE}`)).toBe(false);
  });

  it('SEEDED + GROUNDED: the cycle routes an idea that grounds on the drill rubric ref', () => {
    expect(result.stop).toBe('completed');
    expect(result.routed.length).toBeGreaterThanOrEqual(1);
    // Every routed decision that came from the seeded idea cites the drill ref; at least
    // one exists (the forced rubric-focus guarantees the seeded slot grounds on it).
    const grounded = result.routed.filter((d) => (d.addressesPatternRefs ?? []).includes(DRILL_PATTERN_REF));
    expect(grounded.length).toBeGreaterThanOrEqual(1);
    for (const d of grounded) expect(d.error).toBeUndefined();
  });

  it('LANDS IN THE LEDGER: a routed_ideas row carries the drill ref through the production write path', async () => {
    const rows = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE_ID });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => (r.addressesPatternRefs ?? []).includes(DRILL_PATTERN_REF))).toBe(true);

    // Column-level: the ref lands populated on scout_routed_ideas (not dropped in deriveProvenance).
    const raw = await db.adminSql<{ idea_id: string; addresses_pattern_refs: string[] | null }[]>`
      SELECT idea_id, addresses_pattern_refs
        FROM harness_shared.scout_routed_ideas
       WHERE cycle_id = ${CYCLE_ID}`;
    expect(raw.some((r) => (r.addresses_pattern_refs ?? []).includes(DRILL_PATTERN_REF))).toBe(true);
  });

  it('GROUNDING METRIC: the per-lane histogram counts the rubric-rating lane (P-006)', () => {
    // The exact signal WI-4250 found pinned at zero — the drill proves it increments.
    const lanes = groundingLaneHistogram(result.provenance);
    expect(lanes['rubric-rating']).toBeGreaterThanOrEqual(1);
  });
});
