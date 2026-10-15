import { describe, expect, it } from 'vitest';

import {
  GOAL_OWNER_REPORT_DIAGNOSIS_RANK,
  GOAL_OWNER_REPORT_FIELD,
  GOAL_OWNER_REPORT_FIELDS,
  GOAL_OWNER_REPORT_HEADING_LIST,
  GOAL_OWNER_REPORT_HEADINGS,
  GOAL_OWNER_REPORT_SCHEMA_VERSION,
  GOAL_REPORT_COST_TOLERANCE,
  buildGoalOwnerReportDraft,
  checkGoalOwnerReportTruth,
  citedRefStatesFor,
  costCitesMeasuredSpend,
  costLineIsUnmeasured,
  describeGoalOwnerReportTruthViolations,
  diagnoseGoalOwnerReportEnvelope,
  envelopeHasCompleteGoalOwnerReport,
  isGoalOwnerReportStamp,
  moneyAmountsInCents,
  parseGoalOwnerReport,
  stampGoalOwnerReport,
  walledEntries,
  workItemRefsIn,
  type GoalOwnerReportEnvelopeDiagnosis,
  type GoalOwnerReportTruthInputs,
} from './goal-owner-report';

const GOAL = 'work-on-everything-070565';

describe('P-021 evidence-backed owner report draft', () => {
  const base = {
    goalId: GOAL,
    observedAt: '2026-09-25T20:00:00.000Z',
    previousReportAt: '2026-09-25T19:00:00.000Z',
    movements: [{ ref: 'plan:papercusp/alpha', state: 'shipped', updatedAt: '2026-09-25T19:30:00.000Z',
      artifact: { ref: 'scorecard:alpha', updatedAt: '2026-09-25T19:25:00.000Z' } }],
    cost: { spentCents: 340, budgetCents: 1000, source: 'goal-lineage-rollup',
      coverage: 'measured', measuredAt: '2026-09-25T19:55:00.000Z', unmeasuredPricedSpend: false },
    ownerWalls: [{ ref: 'WI-1', action: 'choose a domain' }],
    killed: [{ ref: 'fleet:old', criterion: 'cost exceeded 1000c', at: '2026-09-25T19:40:00.000Z' }],
    artifactReads: [] as Array<{ ref: string; readAt: string }>,
  };

  it('marks a terminal label unverified until an exact fresh artifact read exists', () => {
    const unread = buildGoalOwnerReportDraft(base);
    expect(unread.unreadArtifacts).toEqual(['scorecard:alpha']);
    expect(unread.fields.moved).toContain('completion unverified (artifact unread)');
    expect(unread.fields.cost).toContain('coverage=measured; source=goal-lineage-rollup');
    expect(unread.fields.cost).toContain('measured at=2026-09-25T19:55:00.000Z');
    expect(unread.fields.cost).toContain('read at=2026-09-25T20:00:00.000Z');
    expect(unread.fields.cost).not.toContain('unmeasured');
    expect(unread.fields.ownerWalled).toContain('WI-1: choose a domain');
    expect(unread.fields.killed).toContain('fleet:old');
    expect(parseGoalOwnerReport(unread.text).complete).toBe(true);
    const stale = buildGoalOwnerReportDraft({ ...base, artifactReads: [
      { ref: 'scorecard:alpha', readAt: '2026-09-25T19:20:00.000Z' },
    ] });
    expect(stale.unreadArtifacts).toEqual(['scorecard:alpha']);
    const read = buildGoalOwnerReportDraft({ ...base, artifactReads: [
      { ref: 'scorecard:alpha', readAt: '2026-09-25T19:50:00.000Z' },
    ] });
    expect(read.unreadArtifacts).toEqual([]);
    expect(read.fields.moved).toContain('artifact scorecard:alpha read 2026-09-25T19:50:00.000Z');
  });

  it('never turns a first snapshot or missing reads into false movement, cost, walls or kills', () => {
    const draft = buildGoalOwnerReportDraft({ ...base, previousReportAt: null,
      cost: { spentCents: null, budgetCents: 1000, source: null,
        coverage: 'unverified', measuredAt: null, unmeasuredPricedSpend: true }, ownerWalls: null, killed: null });
    expect(draft.fields.moved).toContain('no previous report watermark');
    expect(draft.fields.cost).toContain('unknown; coverage=unverified');
    expect(draft.fields.cost).toContain('measured at=unknown');
    expect(draft.fields.cost).toContain('read at=2026-09-25T20:00:00.000Z');
    expect(draft.fields.ownerWalled).toContain('unknown');
    expect(draft.fields.killed).toContain('unknown');
    expect(parseGoalOwnerReport(draft.text).complete).toBe(true);
  });

  it('describes a changed record without dating an unobserved state transition', () => {
    const draft = buildGoalOwnerReportDraft({ ...base, movements: [
      { ref: 'work-item:WI-2', state: 'wip', updatedAt: '2026-09-25T19:30:00.000Z' },
    ] });
    expect(draft.fields.moved).toContain('record updated 2026-09-25T19:30:00.000Z');
    expect(draft.fields.moved).toContain('current state=wip (state transition unverified)');
  });

  it('marks capped evidence lists as partial inside the four report fields', () => {
    const draft = buildGoalOwnerReportDraft({ ...base, movementTruncated: true, killedTruncated: true });
    expect(draft.fields.moved).toContain('partial coverage');
    expect(draft.fields.killed).toContain('partial coverage');
  });
});

describe('parseGoalOwnerReport', () => {
  it('parses and normalizes the four structured coord sections, including explicit none/unknown', () => {
    const parsed = parseGoalOwnerReport([
      { text: 'MOVED:  P-006 advanced\nwith focused tests' },
      { text: '**COST:** unknown (goal-pots rollup unavailable)' },
      { text: '## OWNER-WALLED — none' },
      { text: '- KILLED: none' },
      { text: 'NEXT WAKE: loop fire in ~8 min' },
    ]);

    expect(parsed).toEqual({
      attempted: true,
      complete: true,
      fields: {
        moved: 'P-006 advanced\nwith focused tests',
        cost: 'unknown (goal-pots rollup unavailable)',
        ownerWalled: 'none',
        killed: 'none',
        nextWake: 'loop fire in ~8 min',
      },
      missing: [],
      empty: [],
      duplicate: [],
    });
  });

  it('accepts a legacy flat body whose heading values are on following lines', () => {
    const parsed = parseGoalOwnerReport(
      `Goal ${GOAL}\n\nMOVED\nP-001 landed\n\nCOST\n12c measured\n\nOWNER_WALLED\nnone\n\nKILLED\nold experiment\n\nNEXT_WAKE\nowner reply`,
    );
    expect(parsed.complete).toBe(true);
    expect(parsed.fields.ownerWalled).toBe('none');
    expect(parsed.fields.nextWake).toBe('owner reply');
  });

  // WI-10005205 recurrence guard: holders omitted the next-wake reason because
  // the gate accepted a four-heading report as complete. A report without
  // NEXT WAKE must stay incomplete, so the send/escalate gates refuse it.
  it('refuses a four-heading report that omits NEXT WAKE', () => {
    const parsed = parseGoalOwnerReport('MOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: none');
    expect(parsed).toMatchObject({ attempted: true, complete: false, missing: ['nextWake'], empty: [], duplicate: [] });
    expect(() => stampGoalOwnerReport(GOAL, parsed)).toThrow(/incomplete/);
  });

  it('reports missing, empty, and duplicate fields instead of choosing silently', () => {
    const parsed = parseGoalOwnerReport(['MOVED: first', 'MOVED: second', 'COST:', 'KILLED: none']);
    expect(parsed).toMatchObject({
      attempted: true,
      complete: false,
      missing: ['ownerWalled', 'nextWake'],
      empty: ['cost'],
      duplicate: ['moved'],
    });
  });

  it('does not classify ordinary prose or the slash-separated contract reminder as a report attempt', () => {
    expect(parseGoalOwnerReport('We moved the build and reduced cost.').attempted).toBe(false);
    expect(parseGoalOwnerReport('MOVED / COST / OWNER-WALLED / KILLED').attempted).toBe(false);
  });

  it('WI-10005610 permits an immediate plain-prose correction without resetting the periodic report cadence', () => {
    const body = [{
      text: 'Correction to the 14:12 goal report: hud-orders fleet. Previously reported it was kept; ' +
        'measured state is dissolved (hud-orders#D-004).',
    }];
    // A partial MOVED report would be refused by coord:send. Ordinary correction
    // prose uses its existing kind:none path, without a goal-report stamp.
    expect(parseGoalOwnerReport(body).attempted).toBe(false);
    expect(diagnoseGoalOwnerReportEnvelope({ body }, GOAL)).toEqual({ kind: 'not-attempted' });
    expect(envelopeHasCompleteGoalOwnerReport({ body }, GOAL)).toBe(false);
    expect(parseGoalOwnerReport([{ text: `MOVED: ${body[0].text}` }])).toMatchObject({
      attempted: true,
      complete: false,
      missing: ['cost', 'ownerWalled', 'killed', 'nextWake'],
    });
  });
});

describe('goal owner report evidence', () => {
  const complete = parseGoalOwnerReport(
    'MOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: stale plan\nNEXT WAKE: loop fire ~14:40Z',
  );

  it('stamps the server-resolved goal and validates every normalized field', () => {
    const stamp = stampGoalOwnerReport(GOAL, complete);
    expect(stamp).toEqual({
      schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION,
      goalId: GOAL,
      moved: 'P-006',
      cost: '3c',
      ownerWalled: 'none',
      killed: 'stale plan',
      nextWake: 'loop fire ~14:40Z',
    });
    expect(isGoalOwnerReportStamp(stamp, GOAL)).toBe(true);
    expect(isGoalOwnerReportStamp(stamp, 'wrong-goal')).toBe(false);
  });

  it('still counts a stamp written before NEXT WAKE existed (evidence contract is the core four)', () => {
    const { nextWake: _omitted, ...preChange } = stampGoalOwnerReport(GOAL, complete);
    expect(isGoalOwnerReportStamp(preChange, GOAL)).toBe(true);
    expect(envelopeHasCompleteGoalOwnerReport({ [GOAL_OWNER_REPORT_FIELD]: preChange }, GOAL)).toBe(true);
  });

  it('accepts a current stamp or a complete goal-naming legacy body, never an arbitrary human ping', () => {
    const stamp = stampGoalOwnerReport(GOAL, complete);
    expect(envelopeHasCompleteGoalOwnerReport({ [GOAL_OWNER_REPORT_FIELD]: stamp }, GOAL)).toBe(true);
    expect(
      envelopeHasCompleteGoalOwnerReport(
        { body: `Goal ${GOAL}\nMOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: none` },
        GOAL,
      ),
    ).toBe(true);
    expect(envelopeHasCompleteGoalOwnerReport({ body: `Status for ${GOAL}: still working.` }, GOAL)).toBe(false);
    expect(
      envelopeHasCompleteGoalOwnerReport({ body: `Goal ${GOAL}\nMOVED: P-006\nCOST: 3c\nOWNER-WALLED: none` }, GOAL),
    ).toBe(false);
    expect(
      envelopeHasCompleteGoalOwnerReport({ [GOAL_OWNER_REPORT_FIELD]: { ...stamp, goalId: 'wrong-goal' } }, GOAL),
    ).toBe(false);
  });
});

/**
 * EI-23742424491420721 — a bare "no owner report" verdict is indistinguishable
 * from "four were delivered and all four parsed as non-attempts". The reader
 * must return WHY, and the boolean face must be derived from that same pass so
 * the two can never disagree.
 */
describe('diagnoseGoalOwnerReportEnvelope', () => {
  const stamp = {
    schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION,
    goalId: GOAL,
    moved: 'P-006 advanced',
    cost: 'unknown (rollup unavailable)',
    ownerWalled: 'none',
    killed: 'none',
  };

  it('separates a delivered non-attempt from a genuinely absent report', () => {
    // The exact shape that cost ~90 minutes: an owner-facing ping naming the
    // goal id verbatim. It is DELIVERED, and it is not a report attempt.
    expect(diagnoseGoalOwnerReportEnvelope({ body: `Status for ${GOAL}: still working.` }, GOAL)).toEqual({
      kind: 'not-attempted',
    });
    // Modern sends persist an array of sections, not a flat string.
    expect(
      diagnoseGoalOwnerReportEnvelope({ body: [{ text: `Progress on ${GOAL}: three items advanced.` }] }, GOAL),
    ).toEqual({ kind: 'not-attempted' });
  });

  it('names the specific unmet fields when the report was attempted', () => {
    expect(
      diagnoseGoalOwnerReportEnvelope({ body: `Goal ${GOAL}\nMOVED: P-006\nCOST: 3c\nOWNER-WALLED: none` }, GOAL),
    ).toEqual({ kind: 'incomplete', missing: ['killed'], empty: [], duplicate: [] });

    expect(
      diagnoseGoalOwnerReportEnvelope(
        { body: [{ text: 'MOVED: P-006' }, { text: 'MOVED: again' }, { text: 'COST:' }] },
        GOAL,
      ),
    ).toEqual({
      // A duplicated heading still reports its first value, so `moved` is
      // duplicate-but-not-empty; the bare `COST:` heading is the empty one.
      kind: 'incomplete',
      missing: ['ownerWalled', 'killed'],
      empty: ['cost'],
      duplicate: ['moved'],
    });
  });

  it('distinguishes a complete report aimed at another subject from a malformed one', () => {
    expect(diagnoseGoalOwnerReportEnvelope({ [GOAL_OWNER_REPORT_FIELD]: { ...stamp, goalId: 'other-goal' } }, GOAL))
      .toEqual({ kind: 'wrong-goal', stampedGoalId: 'other-goal' });

    // Legacy flat body: complete four labels, but never names this goal.
    expect(
      diagnoseGoalOwnerReportEnvelope(
        { body: 'MOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: none' },
        GOAL,
      ),
    ).toEqual({ kind: 'wrong-goal', stampedGoalId: null });
  });

  it('flags a complete structured report that carries no server stamp', () => {
    // coord:send could not resolve the GOAL subject, so nothing vouches for it.
    expect(
      diagnoseGoalOwnerReportEnvelope(
        {
          body: [
            { text: 'MOVED: P-006 advanced' },
            { text: 'COST: 3c' },
            { text: 'OWNER-WALLED: none' },
            { text: 'KILLED: none' },
          ],
        },
        GOAL,
      ),
    ).toEqual({ kind: 'unstamped-complete' });
  });

  it('accepts the two shapes that really do register, and rejects a non-envelope', () => {
    expect(diagnoseGoalOwnerReportEnvelope({ [GOAL_OWNER_REPORT_FIELD]: stamp }, GOAL)).toEqual({ kind: 'complete' });
    expect(
      diagnoseGoalOwnerReportEnvelope(
        { body: `Goal ${GOAL}\nMOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: none` },
        GOAL,
      ),
    ).toEqual({ kind: 'complete' });
    expect(diagnoseGoalOwnerReportEnvelope(null, GOAL)).toEqual({ kind: 'unreadable-envelope' });
    expect(diagnoseGoalOwnerReportEnvelope(['not', 'an', 'envelope'], GOAL)).toEqual({ kind: 'unreadable-envelope' });
  });

  it('keeps the boolean predicate exactly equal to a complete diagnosis', () => {
    const envelopes: unknown[] = [
      { [GOAL_OWNER_REPORT_FIELD]: stamp },
      { [GOAL_OWNER_REPORT_FIELD]: { ...stamp, goalId: 'other-goal' } },
      { body: `Goal ${GOAL}\nMOVED: a\nCOST: b\nOWNER-WALLED: c\nKILLED: d` },
      { body: 'MOVED: a\nCOST: b\nOWNER-WALLED: c\nKILLED: d' },
      { body: `Status for ${GOAL}: still working.` },
      { body: [{ text: 'MOVED: a' }, { text: 'COST: b' }, { text: 'OWNER-WALLED: c' }, { text: 'KILLED: d' }] },
      { body: null },
      null,
      [],
    ];
    for (const envelope of envelopes) {
      expect(envelopeHasCompleteGoalOwnerReport(envelope, GOAL)).toBe(
        diagnoseGoalOwnerReportEnvelope(envelope, GOAL).kind === 'complete',
      );
    }
  });

  it('ranks every diagnosis kind so the closest candidate can be chosen', () => {
    const kinds: GoalOwnerReportEnvelopeDiagnosis['kind'][] = [
      'complete',
      'unstamped-complete',
      'wrong-goal',
      'incomplete',
      'not-attempted',
      'unreadable-envelope',
    ];
    for (const kind of kinds) {
      expect(typeof GOAL_OWNER_REPORT_DIAGNOSIS_RANK[kind]).toBe('number');
    }
    // A complete report must outrank every partial one, or the gate would
    // explain a worse candidate than the one it actually evaluated.
    expect(GOAL_OWNER_REPORT_DIAGNOSIS_RANK.complete).toBeGreaterThan(
      Math.max(...kinds.filter((k) => k !== 'complete').map((k) => GOAL_OWNER_REPORT_DIAGNOSIS_RANK[k])),
    );
    expect(GOAL_OWNER_REPORT_DIAGNOSIS_RANK['not-attempted']).toBeGreaterThan(
      GOAL_OWNER_REPORT_DIAGNOSIS_RANK['unreadable-envelope'],
    );
  });
});

/**
 * The headings a refusal quotes must be the headings the parser accepts — not
 * a second hand-maintained spelling that can drift out from under it.
 */
describe('GOAL_OWNER_REPORT_HEADINGS', () => {
  it('round-trips every advertised heading back through the parser', () => {
    for (const field of GOAL_OWNER_REPORT_FIELDS) {
      const heading = GOAL_OWNER_REPORT_HEADINGS[field];
      const parsed = parseGoalOwnerReport(`${heading}: a value`);
      expect(parsed.attempted).toBe(true);
      expect(parsed.fields[field]).toBe('a value');
    }
  });

  it('advertises exactly the four contract fields, in contract order', () => {
    expect(Object.keys(GOAL_OWNER_REPORT_HEADINGS)).toEqual([...GOAL_OWNER_REPORT_FIELDS]);
    expect(GOAL_OWNER_REPORT_HEADING_LIST).toBe('MOVED / COST / OWNER-WALLED / KILLED / NEXT WAKE');
  });
});

/**
 * P-005 (goal-holder-plans-ideation-truthful-reports-2026-10-03): the send-time
 * truth checks. The fixtures are the measured goal 60d3a8 falsities: (a) COST
 * "not measured per goal" while goals.metadata.spentCents=313180 (goal-lineage-rollup)
 * existed; (b) OWNER-WALLED listing bare ids; (c) a MOVED line later found false and
 * not corrected in the next report (WI-10005610).
 */
describe('P-005 goal owner report truth checks', () => {
  const measuredSpend = {
    spentCents: 313180,
    measured: true,
    source: 'goal-lineage-rollup',
    measuredAt: '2026-10-03T02:00:00.000Z',
  };
  const walls = [
    { ref: 'WI-10004856', action: 'choose the hud P-003 route (solo / fleet / drop)' },
    { ref: 'WI-10004875', action: null },
    { ref: 'WI-10005042', action: 'paste the Stripe restricted key' },
  ];
  const inputs = (over: Partial<GoalOwnerReportTruthInputs> = {}): GoalOwnerReportTruthInputs => ({
    spend: measuredSpend,
    ownerWalls: walls,
    previousReport: null,
    currentRefStates: {},
    ...over,
  });
  const fields = (over: Partial<Record<(typeof GOAL_OWNER_REPORT_FIELDS)[number], string>> = {}) => ({
    moved: 'P-006 shipped (WI-10005778 done)',
    cost: 'goal lineage $3,131.80 (goal-lineage-rollup); pot-wide $4266/24h',
    ownerWalled:
      'WI-10004856: choose the hud P-003 route (solo/fleet/drop); WI-10004875: decide whether to keep the calendar sidecar; ' +
      'WI-10005042: paste the Stripe restricted key',
    killed: 'none',
    nextWake: 'loop fire in ~15 min',
    ...over,
  });

  describe('money and ref parsing', () => {
    it('reads every written money form in cents, and never a bare number', () => {
      expect(moneyAmountsInCents('$3,131.80')).toEqual([313180]);
      expect(moneyAmountsInCents('$3.1k')).toEqual([310000]);
      expect(moneyAmountsInCents('313180c')).toEqual([313180]);
      expect(moneyAmountsInCents('313180 cents')).toEqual([313180]);
      expect(moneyAmountsInCents('313180¢')).toEqual([313180]);
      expect(moneyAmountsInCents('3131.80 USD')).toEqual([313180]);
      expect(moneyAmountsInCents('pot-wide $4266/24h')).toEqual([426600]);
      expect(moneyAmountsInCents('24h window; 4 owner walls; P-003')).toEqual([]);
    });

    it('matches a cited amount within max(absolute floor, relative band) of the measured spend', () => {
      expect(GOAL_REPORT_COST_TOLERANCE).toEqual({ absCents: 1000, relative: 0.03 });
      expect(costCitesMeasuredSpend('goal $3,131.80', 313180)).toBe(true);
      expect(costCitesMeasuredSpend('goal ~$3.1k', 313180)).toBe(true); // 3180c off, band 9395c
      expect(costCitesMeasuredSpend('goal ~$3.0k', 313180)).toBe(false); // 13180c off
      expect(costCitesMeasuredSpend('not measured per goal; pot-wide $4266/24h', 313180)).toBe(false);
      expect(costCitesMeasuredSpend('$5', 340)).toBe(true); // absolute floor of 1000c for a small spend
      expect(costCitesMeasuredSpend('$20', 340)).toBe(false);
    });

    it('recognizes a COST line that admits it measured nothing', () => {
      expect(costLineIsUnmeasured('not measured per goal; pot-wide $4266/24h')).toBe(true);
      expect(costLineIsUnmeasured('unmeasured')).toBe(true);
      expect(costLineIsUnmeasured('')).toBe(true);
      expect(costLineIsUnmeasured('goal lineage $3,131.80')).toBe(false);
    });

    it('splits OWNER-WALLED entries and flags the ones that are only ids', () => {
      expect(walledEntries('WI-10004856, WI-10004875, WI-10005042')).toEqual([
        { entry: 'WI-10004856, WI-10004875, WI-10005042', bare: true },
      ]);
      expect(walledEntries('WI-10004856/4875/5042')).toEqual([{ entry: 'WI-10004856/4875/5042', bare: true }]);
      expect(walledEntries('WI-10004856: choose the hud P-003 route; none')).toEqual([
        { entry: 'WI-10004856: choose the hud P-003 route', bare: false },
      ]);
      expect(walledEntries('none')).toEqual([]);
      expect(workItemRefsIn('WI-1 then EI-22 then WI-1 and F-3')).toEqual(['WI-1', 'EI-22', 'F-3']);
    });

    it('records the state of each MOVED ref it could read, and nothing when the read failed', () => {
      expect(citedRefStatesFor('WI-1 done; WI-2 done; WI-9 unknown', { 'WI-1': 'done', 'WI-2': 'open' })).toEqual([
        { ref: 'WI-1', state: 'done' },
        { ref: 'WI-2', state: 'open' },
      ]);
      expect(citedRefStatesFor('WI-1 done', null)).toBeNull();
    });
  });

  describe('checkGoalOwnerReportTruth', () => {
    it('refuses the measured 60d3a8 report: unmeasured COST and bare-id OWNER-WALLED', () => {
      const { violations, summary } = checkGoalOwnerReportTruth(
        fields({
          cost: 'not measured per goal; pot-wide $4266/24h',
          ownerWalled: 'WI-10004856, WI-10004875, WI-10005042',
        }),
        inputs(),
      );
      expect(violations.map((v) => [v.check, v.kind, 'ref' in v ? v.ref : null])).toEqual([
        ['cost', 'measured-spend-not-cited', null],
        ['owner-walled', 'wall-without-action', 'WI-10004856'],
        ['owner-walled', 'wall-without-action', 'WI-10004875'],
        ['owner-walled', 'wall-without-action', 'WI-10005042'],
      ]);
      expect(violations[0]!.message).toContain('$3,131.80 (goal-lineage-rollup, measured 2026-10-03T02:00:00.000Z)');
      // The refusal names the recorded owner ask, or how to record one.
      expect(violations[1]!.message).toContain('choose the hud P-003 route');
      expect(violations[2]!.message).toContain('work_items:set_blocker');
      expect(summary).toEqual({ cost: 'unread', ownerWalls: 'unread', corrections: 'no-baseline' });
      const text = describeGoalOwnerReportTruthViolations(GOAL, violations);
      expect(text).toContain(`GOAL owner report for ${GOAL} contradicts measured goal state; nothing was sent.`);
      expect(text).toContain('4. OWNER-WALLED names WI-10005042 without a concrete owner action');
    });

    it('passes the truthful version of the same report and summarizes what it established', () => {
      const { violations, summary } = checkGoalOwnerReportTruth(fields(), inputs());
      expect(violations).toEqual([]);
      expect(summary).toEqual({ cost: 'cited-measured', ownerWalls: 'all-listed-with-action', corrections: 'no-baseline' });
    });

    it.each([
      'work-item:WI-10004856: UNKNOWN: exact action absent',
      'WI-10004856 [needs-human]: UNKNOWN: exact action absent',
      'work-item:WI-10004856: open this work item for the exact owner action',
      'work-item:WI-10004856: unknown',
      'work-item:WI-10004856',
    ])('does not certify an owner-action placeholder: %s', (ownerWalled) => {
      const { violations, summary } = checkGoalOwnerReportTruth(
        fields({ ownerWalled }),
        inputs({ ownerWalls: [walls[0]!] }),
      );
      expect(violations).toEqual([
        expect.objectContaining({ check: 'owner-walled', kind: 'wall-without-action',
          ref: 'WI-10004856', expected: walls[0]!.action }),
      ]);
      expect(summary.ownerWalls).not.toBe('all-listed-with-action');
    });

    it('keeps a concrete action that mentions an unknown value', () => {
      const { violations, summary } = checkGoalOwnerReportTruth(
        fields({ ownerWalled: 'work-item:WI-10004856: choose a domain or record that the domain is unknown' }),
        inputs({ ownerWalls: [walls[0]!] }),
      );
      expect(violations).toEqual([]);
      expect(summary.ownerWalls).toBe('all-listed-with-action');
    });

    it('refuses an open owner wall the report omits, quoting its recorded action', () => {
      const { violations } = checkGoalOwnerReportTruth(
        fields({ ownerWalled: 'none' }),
        inputs({ ownerWalls: [walls[0]!] }),
      );
      expect(violations).toEqual([
        expect.objectContaining({
          check: 'owner-walled',
          kind: 'wall-not-listed',
          ref: 'WI-10004856',
          expected: 'choose the hud P-003 route (solo / fleet / drop)',
        }),
      ]);
    });

    it('flags a bare-id entry even for an item the wall read did not return', () => {
      const { violations } = checkGoalOwnerReportTruth(fields({ ownerWalled: 'WI-77' }), inputs({ ownerWalls: [] }));
      expect(violations).toEqual([expect.objectContaining({ check: 'owner-walled', kind: 'wall-without-action', ref: 'WI-77', expected: null })]);
    });

    it('reports none-open when the goal has no open walls and the report says none', () => {
      const { violations, summary } = checkGoalOwnerReportTruth(fields({ ownerWalled: 'none' }), inputs({ ownerWalls: [] }));
      expect(violations).toEqual([]);
      expect(summary.ownerWalls).toBe('none-open');
    });

    it('never refuses on an unreadable or unmeasured spend', () => {
      const unmeasuredCost = fields({ cost: 'not measured per goal; pot-wide $4266/24h' });
      const unmeasured = checkGoalOwnerReportTruth(
        unmeasuredCost,
        inputs({ spend: { spentCents: 1200, measured: false, source: 'goal-pots', measuredAt: null } }),
      );
      expect(unmeasured.violations).toEqual([]);
      expect(unmeasured.summary.cost).toBe('goal-spend-unmeasured');
      const unread = checkGoalOwnerReportTruth(unmeasuredCost, inputs({ spend: null, ownerWalls: null }));
      expect(unread.violations).toEqual([]);
      expect(unread.summary).toMatchObject({ cost: 'unread', ownerWalls: 'unread' });
    });

    describe('corrections owed from the previous report (WI-10005610)', () => {
      const previousReport = {
        at: '2026-10-03T01:00:00.000Z',
        citedRefStates: [
          { ref: 'WI-10005610', state: 'done' },
          { ref: 'WI-10005725', state: 'wip' },
        ],
      };

      it('refuses a report that is silent about a ref the previous report called done and that has regressed', () => {
        const { violations, summary } = checkGoalOwnerReportTruth(
          fields(),
          inputs({ previousReport, currentRefStates: { 'WI-10005610': 'open', 'WI-10005725': 'open' } }),
        );
        // WI-10005725 was reported as wip, never as finished, so nothing is owed for it.
        expect(violations).toEqual([
          expect.objectContaining({
            check: 'correction',
            kind: 'correction-owed',
            ref: 'WI-10005610',
            reportedState: 'done',
            currentState: 'open',
            reportedAt: '2026-10-03T01:00:00.000Z',
          }),
        ]);
        expect(summary.corrections).toBe('unread');
      });

      it('accepts the report once it names the regressed ref, and records the correction as carried', () => {
        const { violations, summary } = checkGoalOwnerReportTruth(
          fields({ moved: 'CORRECTION: WI-10005610 is open again, not done as the 01:00Z report said. P-006 shipped.' }),
          inputs({ previousReport, currentRefStates: { 'WI-10005610': 'open' } }),
        );
        expect(violations).toEqual([]);
        expect(summary.corrections).toBe('carried');
      });

      it('owes nothing while every previously-done ref is still done, and judges nothing without a readable baseline', () => {
        expect(
          checkGoalOwnerReportTruth(fields(), inputs({ previousReport, currentRefStates: { 'WI-10005610': 'done' } })).summary
            .corrections,
        ).toBe('none-owed');
        expect(
          checkGoalOwnerReportTruth(fields(), inputs({ previousReport, currentRefStates: null })).summary.corrections,
        ).toBe('unread');
        expect(
          checkGoalOwnerReportTruth(fields(), inputs({ previousReport: { at: previousReport.at, citedRefStates: null } }))
            .summary.corrections,
        ).toBe('no-baseline');
      });
    });
  });

  it('stamps the cited ref states and truth summary, and the stamp still counts as a report', () => {
    const parsed = parseGoalOwnerReport(
      ['MOVED: WI-1 done', 'COST: $3,131.80', 'OWNER-WALLED: none', 'KILLED: none', 'NEXT WAKE: ~15 min'].join('\n'),
    );
    const summary = { cost: 'cited-measured', ownerWalls: 'none-open', corrections: 'none-owed' } as const;
    const stamp = stampGoalOwnerReport(GOAL, parsed, { citedRefStates: [{ ref: 'WI-1', state: 'done' }], summary });
    expect(stamp).toMatchObject({ citedRefStates: [{ ref: 'WI-1', state: 'done' }], truth: summary });
    expect(isGoalOwnerReportStamp(stamp, GOAL)).toBe(true);
    const bare = stampGoalOwnerReport(GOAL, parsed);
    expect('citedRefStates' in bare || 'truth' in bare).toBe(false);
  });
});
