/**
 * Falsifiability probes for the SQL-read census (P-008).
 *
 * ── WHY EVERY ALARM HAS A CONTROL ────────────────────────────────────────────
 * A detector that has never fired is a detector nobody has tested. A CLEAN RUN
 * PROVES NOTHING: a threshold that can never fire and a threshold with nothing to
 * report emit byte-identical output, so only a synthetic crossing separates them
 * (the WI-38272 lesson, recorded as D-008 §3).
 *
 * These are TIER-1 probes: in-memory arrays against the exported pure functions.
 * Deliberately not a mutation probe against the shared tree — a probe that mutates
 * tracked source can be COMMITTED by the git-sync sweep even when nothing goes
 * wrong and no handler fails.
 */
import { describe, expect, it } from 'vitest';
import {
  BARE_QUALIFIER_SCHEMAS,
  ESCALATION_TOP_K,
  buildCensusEscalation,
  censusRelationKey,
  censusRelationKeyOfDeclared,
  computeSqlCensus,
  evaluateDeliberateNoPairDrift,
  evaluateNoFallAfterShip,
  evaluateSqlRepairOutcome,
  type SqlRepairMeasurement,
  evaluateUncoveredDemand,
  evaluateVerdictDrift,
  type CensusCluster,
  type DeliberateNoPairDrift,
  type PriorCensusRow,
} from './sql-census';
import { SQL_READ_PAIRS } from './pairs';
import type { DeliberateNoPairDecision, SampledCommand, SqlSubstitutionPair } from './types';

const atom = (sid: string, sql: string): SampledCommand => ({ sid, ts: '2026-08-12T00:00:00Z', atom: sql });

describe('normalized repair feedback', () => {
  const measurement = (): SqlRepairMeasurement => ({
    baseline: { scopeRef: 'ws/h', shapesRef: 'fixed-shapes-v1', since: '2026-10-01T00:00:00Z',
      until: '2026-10-08T00:00:00Z', rawAgents: 8, activeAgents: 10, toolAgents: 0, complete: true },
    observation: { scopeRef: 'ws/h', shapesRef: 'fixed-shapes-v1', since: '2026-10-10T00:00:00Z',
      until: '2026-10-17T00:00:00Z', rawAgents: 2, activeAgents: 10, toolAgents: 7, complete: true },
    exposure: { build: 'a'.repeat(40), observedAt: '2026-10-09T00:00:00Z', evidenceRef: 'release:observed-fixture' },
    coverage: 'pass',
  });
  it('healthy adoption requires normalized fall and observed tool use R7-CONTRACT OUTCOME-P-007', () => {
    expect(evaluateSqlRepairOutcome(measurement())).toMatchObject({ status: 'healthy', disposition: 'adopted',
      baselineRate: .8, observedRate: .2, adoptionRate: .7 });
  });
  it('lower fleet activity alone is a failed repair R7-CONTRACT OUTCOME-P-007', () => {
    const m = measurement(); m.observation = { ...m.observation, rawAgents: 4, activeAgents: 5, toolAgents: 1 };
    expect(evaluateSqlRepairOutcome(m)).toMatchObject({ status: 'failed', disposition: 'no-fall', normalizedFall: 0 });
  });
  it('raw demand falling without tool adoption is no-fall R7-CONTRACT', () => {
    const m = measurement(); m.observation.toolAgents = 0;
    expect(evaluateSqlRepairOutcome(m)).toMatchObject({ status: 'failed', disposition: 'no-fall' });
  });
  it('failed coverage has an explicit disposition R7-CONTRACT', () => {
    expect(evaluateSqlRepairOutcome({ ...measurement(), coverage: 'fail' }))
      .toMatchObject({ status: 'failed', disposition: 'coverage-failed' });
  });
  it.each(['denominator', 'window', 'cohort', 'scope', 'coverage', 'low-demand', 'exposure', 'partial', 'overlap', 'unequal', 'build', 'receipt', 'future', 'invalid-clock'])(
    '%s evidence remains unknown R7-CONTRACT OUTCOME-P-007', defect => {
      const m = measurement();
      if (defect === 'denominator') m.observation.activeAgents = 0;
      if (defect === 'window') m.observation.since = '';
      if (defect === 'cohort') m.observation.shapesRef = 'other-shapes';
      if (defect === 'scope') m.observation.scopeRef = 'other-workspace';
      if (defect === 'coverage') m.coverage = 'unknown';
      if (defect === 'low-demand') m.baseline.rawAgents = 1;
      if (defect === 'exposure') m.exposure = null;
      if (defect === 'partial') m.observation.complete = false;
      if (defect === 'overlap') m.observation.since = '2026-10-07T00:00:00Z';
      if (defect === 'unequal') m.observation.until = '2026-10-18T00:00:00Z';
      if (defect === 'build') m.exposure!.build = 'not-a-build';
      if (defect === 'receipt') m.exposure!.evidenceRef = ' ';
      const measuredAt = defect === 'invalid-clock' ? NaN
        : Date.parse(defect === 'future' ? '2026-10-15T00:00:00Z' : '2026-10-25T00:00:00Z');
      expect(evaluateSqlRepairOutcome(m, measuredAt)).toMatchObject({ status: 'unknown', disposition: 'insufficient-evidence', normalizedFall: null });
    });
});

/** A pair with no `sqlShape`, so it claims every plain read of its relation. */
const WIDGET_PAIR: SqlSubstitutionPair = {
  id: 'test.widgets',
  intentLabel: 'widget-lookup',
  toolName: 'widgets:list',
  advisoryText: 'Use widgets:list instead of a hand-written SELECT over widgets.',
  routing: { want: 'a widget', use: 'widgets:list', insteadOf: 'SELECT … FROM widgets' },
  expectedVerdict: 'equivalent',
  corpus: 'sql',
  relation: 'widgets',
  // The census NEVER calls cover() — it counts and clusters, and whether a verb
  // could serve a query is the equivalence harness's job, not the census's. The
  // envelope is required by the type, so this fixture supplies the trivial one and
  // says so, rather than a stub that would look like a coverage claim.
  cover: (atom: string) => ({ covered: true, expression: `widgets:list // ${atom.slice(0, 20)}` }),
};

const cluster = (over: Partial<CensusCluster> & Pick<CensusCluster, 'relation'>): CensusCluster => ({
  intentLabel: null,
  relationHasPairs: false,
  deliberatelyUnpaired: false,
  deliberateNoPairDecision: null,
  coveringTool: null,
  equivalenceVerdict: null,
  distinctAgents: 1,
  calls: 1,
  relationDistinctAgents: over.relationDistinctAgents ?? over.distinctAgents ?? 1,
  relationCalls: 1,
  sampleAtom: null,
  ...over,
});

const priorRow = (over: Partial<PriorCensusRow> & Pick<PriorCensusRow, 'ranOn' | 'relation'>): PriorCensusRow => ({
  intentLabel: null,
  coveringTool: null,
  equivalenceVerdict: null,
  distinctAgents: 1,
  relationDistinctAgents: over.relationDistinctAgents ?? over.distinctAgents ?? 1,
  ...over,
});

describe('censusRelationKey', () => {
  it('folds a style-only qualifier to the bare name so both spellings are ONE cluster', () => {
    expect(censusRelationKey({ relation: 'work_items', asWritten: 'harness_shared.work_items' })).toBe('work_items');
    expect(censusRelationKey({ relation: 'work_items', asWritten: 'work_items' })).toBe('work_items');
  });

  it('KEEPS a load-bearing qualifier — information_schema.columns must not become `columns`', () => {
    expect(censusRelationKey({ relation: 'columns', asWritten: 'information_schema.columns' })).toBe(
      'information_schema.columns',
    );
    // The control that makes the above meaningful: a user table of the same bare
    // name is a DIFFERENT cluster, which is the whole reason the qualifier is kept.
    expect(censusRelationKey({ relation: 'columns', asWritten: 'harness_shared.columns' })).toBe('columns');
  });

  it('keys a pair DECLARATION the same way, so pair-relation and read-relation meet', () => {
    for (const schema of BARE_QUALIFIER_SCHEMAS) {
      expect(censusRelationKeyOfDeclared(`${schema}.thing`)).toBe('thing');
    }
    expect(censusRelationKeyOfDeclared('information_schema.tables')).toBe('information_schema.tables');
    expect(censusRelationKeyOfDeclared('schema_migrations')).toBe('schema_migrations');
  });
});

describe('computeSqlCensus', () => {
  it('clusters by (relation, claiming intent) and counts DISTINCT agents, not calls', () => {
    const out = computeSqlCensus(
      [
        atom('su-a', "SELECT * FROM widgets WHERE id = '1'"),
        atom('su-a', "SELECT * FROM widgets WHERE id = '2'"),
        atom('su-b', "SELECT * FROM widgets WHERE id = '3'"),
      ],
      [WIDGET_PAIR],
    );
    expect(out).toHaveLength(1);
    expect(out[0].intentLabel).toBe('widget-lookup');
    expect(out[0].coveringTool).toBe('widgets:list');
    expect(out[0].distinctAgents).toBe(2);
    expect(out[0].calls).toBe(3);
  });

  it('DROPS analytic queries rather than counting them as unmet demand', () => {
    // A group-by is dev:pg_query working as intended. Counting it would manufacture
    // a routing gap for every legitimate analytic read on the box.
    const out = computeSqlCensus(
      [
        atom('su-a', 'SELECT state, count(*) FROM widgets GROUP BY state'),
        atom('su-b', 'SELECT w.* FROM widgets w JOIN gadgets g ON g.id = w.gadget_id'),
      ],
      [WIDGET_PAIR],
    );
    expect(out).toHaveLength(0);
  });

  it('distinguishes the two NULL intents: no verb at all vs. this SHAPE not covered', () => {
    const narrowed: SqlSubstitutionPair = { ...WIDGET_PAIR, sqlShape: /order_id\s*=/i };
    const out = computeSqlCensus(
      [
        atom('su-a', "SELECT * FROM widgets WHERE colour = 'red'"), // relation served, shape not
        atom('su-b', "SELECT * FROM sprockets WHERE id = '1'"), // nothing serves this relation
      ],
      [narrowed],
    );
    const widgets = out.find((c) => c.relation === 'widgets');
    const sprockets = out.find((c) => c.relation === 'sprockets');
    expect(widgets?.intentLabel).toBeNull();
    expect(widgets?.relationHasPairs).toBe(true);
    expect(sprockets?.intentLabel).toBeNull();
    expect(sprockets?.relationHasPairs).toBe(false);
  });

  it('de-duplicates agents at the RELATION level across clusters (the no-fall denominator)', () => {
    const narrowed: SqlSubstitutionPair = { ...WIDGET_PAIR, sqlShape: /colour\s*=/i };
    const out = computeSqlCensus(
      [
        atom('su-a', "SELECT * FROM widgets WHERE colour = 'red'"), // claimed
        atom('su-a', "SELECT * FROM widgets WHERE size = '2'"), // unclaimed shape, SAME agent
      ],
      [narrowed],
    );
    expect(out).toHaveLength(2);
    // Summing the two clusters' distinctAgents would say 2 agents; there is ONE.
    expect(out.reduce((n, c) => n + c.distinctAgents, 0)).toBe(2);
    for (const c of out) expect(c.relationDistinctAgents).toBe(1);
  });

  it('ANCHOR: every shipped SQL pair keys to a relation the census can cluster', () => {
    // Permanent membership anchor. A new pair whose declared relation the key rule
    // cannot resolve — or a change to the key rule — fails HERE rather than showing
    // up as a silently uncovered cluster in an escalation months later.
    expect(SQL_READ_PAIRS.length).toBeGreaterThan(0);
    for (const pair of SQL_READ_PAIRS) {
      const key = censusRelationKeyOfDeclared(pair.relation);
      expect(key.length).toBeGreaterThan(0);
      expect(key).toBe(key.toLowerCase());
    }
  });

  it('ANCHOR: a real corpus-shaped migration lookup lands under its shipped pair', () => {
    const out = computeSqlCensus(
      [atom('su-a', "SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE '795%'")],
      SQL_READ_PAIRS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].relation).toBe('schema_migrations');
    expect(out[0].coveringTool).toBe('db:migrations');
    expect(out[0].intentLabel).toBe('applied-migration-lookup');
  });

  it('classifies a registry-backed no-pair relation as deliberate, not uncovered', () => {
    const decision: DeliberateNoPairDecision = {
      relation: 'pg_stat_activity',
      decisionRef: 'plan#D-007',
      rationale: 'The available verb cannot faithfully serve this population.',
      baseline: { windowDays: 14, calls: 956, atoms: 235, distinctAgents: 72 },
      reRaiseAtDistinctAgents: 100,
    };
    const [out] = computeSqlCensus(
      [atom('su-a', "SELECT pid, query FROM pg_stat_activity WHERE query ILIKE '%issues%'")],
      [],
      [decision],
    );
    expect(out).toMatchObject({
      relation: 'pg_stat_activity',
      intentLabel: null,
      relationHasPairs: false,
      deliberatelyUnpaired: true,
      deliberateNoPairDecision: decision,
    });
    expect(evaluateUncoveredDemand([out], 1)).toEqual([]);
  });

  it('does not let a relation-level no-pair decision mask an unserved shape on a paired relation', () => {
    const decision: DeliberateNoPairDecision = {
      relation: 'widgets',
      decisionRef: 'plan#D-007',
      rationale: 'Only the unpaired shape is deliberate.',
      baseline: { windowDays: 14, calls: 10, atoms: 4, distinctAgents: 3 },
    };
    const narrowed: SqlSubstitutionPair = { ...WIDGET_PAIR, sqlShape: /order_id\s*=/i };
    const [out] = computeSqlCensus(
      [atom('su-a', "SELECT * FROM widgets WHERE colour = 'red'")],
      [narrowed],
      [decision],
    );
    expect(out.deliberatelyUnpaired).toBe(false);
    expect(evaluateUncoveredDemand([out], 1)).toHaveLength(1);
  });
});

describe('(a) uncovered demand', () => {
  const clusters = [
    cluster({ relation: 'routines', distinctAgents: 12 }),
    cluster({ relation: 'goals', distinctAgents: 9 }),
    cluster({ relation: 'widgets', distinctAgents: 40, intentLabel: 'widget-lookup', coveringTool: 'widgets:list' }),
  ];

  it('FIRES on an uncovered cluster at or above the threshold', () => {
    const hits = evaluateUncoveredDemand(clusters, 10);
    expect(hits.map((h) => h.relation)).toEqual(['routines']);
  });

  it('CONTROL: does not fire below the threshold', () => {
    expect(evaluateUncoveredDemand([cluster({ relation: 'goals', distinctAgents: 9 })], 10)).toEqual([]);
  });

  it('CONTROL: never fires on a COVERED cluster, however busy', () => {
    const covered = [
      cluster({ relation: 'widgets', distinctAgents: 500, intentLabel: 'widget-lookup', coveringTool: 'widgets:list' }),
    ];
    expect(evaluateUncoveredDemand(covered, 10)).toEqual([]);
  });

  it('KILL SWITCH: threshold <= 0 disables the leg entirely', () => {
    expect(evaluateUncoveredDemand(clusters, 0)).toEqual([]);
    expect(evaluateUncoveredDemand(clusters, -1)).toEqual([]);
  });

  it('excludes a stable deliberate no-pair decision from the uncovered alarm', () => {
    expect(
      evaluateUncoveredDemand(
        [
          cluster({
            relation: 'pg_stat_activity',
            distinctAgents: 25,
            relationDistinctAgents: 25,
            deliberatelyUnpaired: true,
            deliberateNoPairDecision: {
              relation: 'pg_stat_activity',
              decisionRef: 'plan#D-007',
              rationale: 'No faithful tool form.',
              baseline: { windowDays: 14, calls: 956, atoms: 235, distinctAgents: 72 },
              reRaiseAtDistinctAgents: 100,
            },
          }),
        ],
        10,
      ),
    ).toEqual([]);
  });
});

describe('(a2) deliberate no-pair demand drift', () => {
  const decision: DeliberateNoPairDecision = {
    relation: 'pg_stat_activity',
    decisionRef: 'plan#D-007',
    rationale: 'No faithful tool form.',
    baseline: { windowDays: 14, calls: 956, atoms: 235, distinctAgents: 72 },
    reRaiseAtDistinctAgents: 100,
  };

  it('re-raises only when independent-agent demand reaches the explicit threshold', () => {
    const hits = evaluateDeliberateNoPairDrift([
      cluster({
        relation: 'pg_stat_activity',
        calls: 20_000,
        relationCalls: 20_000,
        relationDistinctAgents: 100,
        distinctAgents: 100,
        deliberatelyUnpaired: true,
        deliberateNoPairDecision: decision,
      }),
    ]);
    expect(hits).toEqual<DeliberateNoPairDrift[]>([
      {
        relation: 'pg_stat_activity',
        decisionRef: 'plan#D-007',
        baselineDistinctAgents: 72,
        currentDistinctAgents: 100,
        thresholdDistinctAgents: 100,
        sampleAtom: null,
      },
    ]);
  });

  it('does not re-raise on call growth from the same small agent population', () => {
    expect(
      evaluateDeliberateNoPairDrift([
        cluster({
          relation: 'pg_stat_activity',
          calls: 100_000,
          relationCalls: 100_000,
          relationDistinctAgents: 72,
          distinctAgents: 1,
          deliberatelyUnpaired: true,
          deliberateNoPairDecision: decision,
        }),
      ]),
    ).toEqual([]);
  });

  it('does not re-raise below the material independent-agent threshold', () => {
    expect(
      evaluateDeliberateNoPairDrift([
        cluster({
          relation: 'pg_stat_activity',
          relationDistinctAgents: 99,
          deliberatelyUnpaired: true,
          deliberateNoPairDecision: decision,
        }),
      ]),
    ).toEqual([]);
  });
});

describe('(b) verdict drift', () => {
  const tonight = [
    cluster({
      relation: 'widgets',
      distinctAgents: 5,
      intentLabel: 'widget-lookup',
      coveringTool: 'widgets:list',
      equivalenceVerdict: 'needs-widening',
    }),
  ];

  it('FIRES when a pair that WAS equivalent no longer is', () => {
    const prior = [
      priorRow({
        ranOn: '2026-08-11',
        relation: 'widgets',
        intentLabel: 'widget-lookup',
        equivalenceVerdict: 'equivalent',
      }),
    ];
    const hits = evaluateVerdictDrift(tonight, prior);
    expect(hits).toHaveLength(1);
    expect(hits[0].previousVerdict).toBe('equivalent');
    expect(hits[0].currentVerdict).toBe('needs-widening');
  });

  it('CONTROL: a pair recorded non-equivalent from the START is a finding, not a drift', () => {
    const prior = [
      priorRow({
        ranOn: '2026-08-11',
        relation: 'widgets',
        intentLabel: 'widget-lookup',
        equivalenceVerdict: 'needs-widening',
      }),
    ];
    expect(evaluateVerdictDrift(tonight, prior)).toEqual([]);
  });

  it('CONTROL: no prior night means no BEFORE, so nothing can have drifted', () => {
    expect(evaluateVerdictDrift(tonight, [])).toEqual([]);
  });

  it('CONTROL: a stable equivalent verdict is silent', () => {
    const stable = [{ ...tonight[0], equivalenceVerdict: 'equivalent' as const }];
    const prior = [
      priorRow({
        ranOn: '2026-08-11',
        relation: 'widgets',
        intentLabel: 'widget-lookup',
        equivalenceVerdict: 'equivalent',
      }),
    ];
    expect(evaluateVerdictDrift(stable, prior)).toEqual([]);
  });

  it('reads the MOST RECENT prior night, not whichever row came first', () => {
    const prior = [
      priorRow({
        ranOn: '2026-08-01',
        relation: 'widgets',
        intentLabel: 'widget-lookup',
        equivalenceVerdict: 'needs-widening',
      }),
      priorRow({
        ranOn: '2026-08-11',
        relation: 'widgets',
        intentLabel: 'widget-lookup',
        equivalenceVerdict: 'equivalent',
      }),
    ];
    expect(evaluateVerdictDrift(tonight, prior)).toHaveLength(1);
  });
});

describe('(c) no fall after ship — the alarm that reports a FAILED REPAIR', () => {
  /** 20 agents before the row shipped on 2026-07-20; still covered every night since. */
  const shippedHistory = (agentsAfter: number): PriorCensusRow[] => [
    priorRow({ ranOn: '2026-07-19', relation: 'widgets', relationDistinctAgents: 20 }),
    priorRow({
      ranOn: '2026-07-20',
      relation: 'widgets',
      intentLabel: 'widget-lookup',
      coveringTool: 'widgets:list',
      equivalenceVerdict: 'equivalent',
      relationDistinctAgents: agentsAfter,
    }),
  ];

  const tonight = (agents: number) => [
    cluster({
      relation: 'widgets',
      distinctAgents: agents,
      relationDistinctAgents: agents,
      intentLabel: 'widget-lookup',
      coveringTool: 'widgets:list',
      equivalenceVerdict: 'equivalent',
    }),
  ];

  it('FIRES when the grace period passed and traffic did not fall enough', () => {
    const hits = evaluateNoFallAfterShip(tonight(18), shippedHistory(19), { today: '2026-08-12' });
    expect(hits).toHaveLength(1);
    expect(hits[0].shippedOn).toBe('2026-07-20');
    expect(hits[0].preShipAgents).toBe(20);
    expect(hits[0].currentAgents).toBe(18);
  });

  it('FIRES, with a NEGATIVE fall, when traffic GREW after the row shipped', () => {
    const hits = evaluateNoFallAfterShip(tonight(26), shippedHistory(21), { today: '2026-08-12' });
    expect(hits).toHaveLength(1);
    expect(hits[0].fallPct).toBeLessThan(0);
  });

  it('CONTROL: silent when traffic fell by the required fraction', () => {
    expect(evaluateNoFallAfterShip(tonight(5), shippedHistory(12), { today: '2026-08-12' })).toEqual([]);
  });

  it('CONTROL: silent inside the grace period — a fix needs time to reach the fleet', () => {
    expect(evaluateNoFallAfterShip(tonight(20), shippedHistory(20), { today: '2026-07-25' })).toEqual([]);
  });

  it('CONTROL: a relation covered on the FIRST night is UNKNOWN, never a pass', () => {
    // No absent->present transition was ever observed, so there is no pre-ship
    // baseline. Skipped deliberately: an unknown rendered as a pass is how a fix
    // that never took gets a clean bill of health.
    const alwaysCovered = [
      priorRow({ ranOn: '2026-07-19', relation: 'widgets', intentLabel: 'widget-lookup', coveringTool: 'widgets:list', relationDistinctAgents: 20 }),
      priorRow({ ranOn: '2026-07-20', relation: 'widgets', intentLabel: 'widget-lookup', coveringTool: 'widgets:list', relationDistinctAgents: 20 }),
    ];
    expect(evaluateNoFallAfterShip(tonight(20), alwaysCovered, { today: '2026-08-12' })).toEqual([]);
  });

  it('CONTROL: a relation with no traffic at all tonight is the best possible fall', () => {
    expect(evaluateNoFallAfterShip([], shippedHistory(20), { today: '2026-08-12' })).toEqual([]);
  });

  it('KILL SWITCH: requiredFallPct <= 0 disables the leg', () => {
    expect(
      evaluateNoFallAfterShip(tonight(20), shippedHistory(20), { today: '2026-08-12', requiredFallPct: 0 }),
    ).toEqual([]);
  });
});

describe('the escalation', () => {
  it('is NULL when nothing crossed — a quiet night wakes nobody', () => {
    expect(buildCensusEscalation({ uncovered: [], drift: [], noFall: [] }, 7)).toBeNull();
  });

  it('is ONE escalation naming every class that crossed', () => {
    const esc = buildCensusEscalation(
      {
        uncovered: [{ relation: 'routines', distinctAgents: 112, calls: 566, relationHasPairs: false, sampleAtom: null }],
        drift: [
          {
            relation: 'widgets',
            intentLabel: 'widget-lookup',
            coveringTool: 'widgets:list',
            previousVerdict: 'equivalent',
            currentVerdict: 'needs-widening',
          },
        ],
        noFall: [
          {
            relation: 'test_runs',
            shippedOn: '2026-07-20',
            coveringTool: 'testing:runs',
            preShipAgents: 25,
            currentAgents: 24,
            fallPct: 0.04,
            requiredFallPct: 0.3,
            graceDays: 14,
          },
        ],
      },
      7,
    );
    expect(esc).not.toBeNull();
    expect(esc!.scopeKeys).toEqual(['no-fall', 'verdict-drift', 'uncovered']);
    expect(esc!.body).toContain('test_runs');
    expect(esc!.body).toContain('routines');
    expect(esc!.body).toContain('D-006');
    expect(esc!.body).toContain('D-007');
  });

  it('names deliberate no-pair drift as its own alarm class', () => {
    const esc = buildCensusEscalation(
      {
        uncovered: [],
        drift: [],
        noFall: [],
        deliberateNoPairDrift: [
          {
            relation: 'pg_stat_activity',
            decisionRef: 'plan#D-007',
            baselineDistinctAgents: 72,
            currentDistinctAgents: 100,
            thresholdDistinctAgents: 100,
            sampleAtom: null,
          },
        ],
      },
      7,
    );
    expect(esc).not.toBeNull();
    expect(esc!.scopeKeys).toEqual(['deliberate-no-pair-drift']);
    expect(esc!.body).toContain('plan#D-007');
    expect(esc!.body).toContain('100 independent agents');
  });

  it('CAPS the uncovered list rather than pasting fifteen clusters into one page', () => {
    const many = Array.from({ length: ESCALATION_TOP_K + 7 }, (_, i) => ({
      relation: `rel_${String(i).padStart(2, '0')}`,
      distinctAgents: 100 - i,
      calls: 10,
      relationHasPairs: false,
      sampleAtom: null,
    }));
    const esc = buildCensusEscalation({ uncovered: many, drift: [], noFall: [] }, 7);
    expect(esc!.body).toContain('rel_00');
    expect(esc!.body).not.toContain(`rel_${String(ESCALATION_TOP_K).padStart(2, '0')}`);
    expect(esc!.body).toContain('and 7 more above the threshold');
  });

  it('tells the responder when a relation is served but the SHAPE is not', () => {
    const esc = buildCensusEscalation(
      {
        uncovered: [{ relation: 'test_runs', distinctAgents: 25, calls: 102, relationHasPairs: true, sampleAtom: null }],
        drift: [],
        noFall: [],
      },
      7,
    );
    expect(esc!.body).toContain('widen the existing pair');
  });
});
