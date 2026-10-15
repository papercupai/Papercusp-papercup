import { describe, it, expect } from 'vitest';
import {
  computeIntentStale,
  computeIntentDivergent,
  computeLastActiveSecAgo,
  deriveUnifiedClaimCount,
  deriveLastActive,
  formatIdleAge,
  INTENT_STALE_SEC,
  INTENT_DIVERGENCE_SEC,
  mergeTier1,
  stripDerivationInputs,
  TURN_PART_FRESHNESS_WINDOW_SEC,
  type PresenceTier1Joins,
} from './presence-tier1';

const NOW = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('deriveUnifiedClaimCount', () => {
  it.each([
    ['plan-item-only', ['P-001', 'P-002'], [], 2],
    ['work-item-only', [], ['WI-001', 'EI-002', 'WI-003'], 3],
    ['both independent claim lanes', ['P-001'], ['WI-001', 'EI-002'], 3],
  ])('%s contributes occupancy from both claim domains', (_label, plan, work, expected) => {
    expect(deriveUnifiedClaimCount(plan, work)).toBe(expected);
  });

  it('treats absent claim arrays as empty without fabricating occupancy', () => {
    expect(deriveUnifiedClaimCount(undefined, undefined)).toBe(0);
    expect(deriveUnifiedClaimCount(null, ['WI-001'])).toBe(1);
    expect(deriveUnifiedClaimCount(['P-001'], null)).toBe(1);
  });
});

describe('computeLastActiveSecAgo', () => {
  it('null when lastActiveAt is null or unparseable', () => {
    expect(computeLastActiveSecAgo(null, NOW)).toBeNull();
    expect(computeLastActiveSecAgo('not-a-date', NOW)).toBeNull();
  });

  it('seconds since lastActiveAt', () => {
    expect(computeLastActiveSecAgo(iso(NOW - 30_000), NOW)).toBe(30);
    expect(computeLastActiveSecAgo(iso(NOW - 1_000), NOW)).toBe(1);
  });

  it('clamps a future stamp to 0 (clock skew never goes negative)', () => {
    expect(computeLastActiveSecAgo(iso(NOW + 5_000), NOW)).toBe(0);
  });
});

describe('deriveLastActive (P-011: transcript-freshness leg)', () => {
  const tenMinAgo = iso(NOW - 10 * 60 * 1000);
  const oneMinAgo = iso(NOW - 60 * 1000);

  it('presence-only (no turn part): reading + provenance come from the record', () => {
    expect(deriveLastActive(tenMinAgo, null, NOW)).toEqual({
      lastActiveSecAgo: 600,
      lastActiveSource: 'presence',
    });
    expect(deriveLastActive(tenMinAgo, undefined, NOW)).toEqual({
      lastActiveSecAgo: 600,
      lastActiveSource: 'presence',
    });
  });

  it('turn-parts fresher: the transcript leg wins and says so — the ~4min lag P-011 fixes', () => {
    expect(deriveLastActive(tenMinAgo, oneMinAgo, NOW)).toEqual({
      lastActiveSecAgo: 60,
      lastActiveSource: 'turn-parts',
    });
  });

  // CONTROL (falsifiability): the pre-P-011 derivation — presence only, transcript leg
  // ignored — kept here permanently so this suite provably FAILS on a regression to it.
  // If this control ever passes the turn-parts-fresher expectation, the property being
  // tested is broken, not the subject.
  it('control: the pre-P-011 presence-only derivation reports the stale reading on the same inputs', () => {
    const preP011 = (rec: string | null, _tp: string | null, nowMs: number) =>
      computeLastActiveSecAgo(rec, nowMs);
    expect(preP011(tenMinAgo, oneMinAgo, NOW)).toBe(600); // the lag the fix removes
    expect(deriveLastActive(tenMinAgo, oneMinAgo, NOW).lastActiveSecAgo).toBe(60);
  });

  it('presence fresher (a tool dispatch after the last transcript part): presence wins', () => {
    expect(deriveLastActive(oneMinAgo, tenMinAgo, NOW)).toEqual({
      lastActiveSecAgo: 60,
      lastActiveSource: 'presence',
    });
  });

  it('tie goes to presence — the transcript leg only claims a reading it strictly improves', () => {
    expect(deriveLastActive(oneMinAgo, oneMinAgo, NOW).lastActiveSource).toBe('presence');
  });

  it('turn-parts-only (a session whose activity path never fired): reading is still produced', () => {
    expect(deriveLastActive(null, oneMinAgo, NOW)).toEqual({
      lastActiveSecAgo: 60,
      lastActiveSource: 'turn-parts',
    });
  });

  it('both missing/unparseable: null reading, null provenance — never a fabricated zero', () => {
    expect(deriveLastActive(null, null, NOW)).toEqual({
      lastActiveSecAgo: null,
      lastActiveSource: null,
    });
    expect(deriveLastActive('not-a-date', 'also-not-a-date', NOW)).toEqual({
      lastActiveSecAgo: null,
      lastActiveSource: null,
    });
  });

  it('an unparseable side degrades to the other side, never to null', () => {
    expect(deriveLastActive('not-a-date', oneMinAgo, NOW).lastActiveSource).toBe('turn-parts');
    expect(deriveLastActive(oneMinAgo, 'not-a-date', NOW).lastActiveSource).toBe('presence');
  });

  it('clamps a future stamp to 0 on either source (clock skew never goes negative)', () => {
    expect(deriveLastActive(iso(NOW + 5_000), null, NOW).lastActiveSecAgo).toBe(0);
    expect(deriveLastActive(null, iso(NOW + 5_000), NOW).lastActiveSecAgo).toBe(0);
  });

  it('the query window is bounded and covers the staleness threshold with margin', () => {
    // 2× the intentStale threshold, floored at 1h: a part older than the window cannot
    // flip an intentStale verdict, so bounding there loses no verdict correctness.
    expect(TURN_PART_FRESHNESS_WINDOW_SEC).toBeGreaterThanOrEqual(INTENT_STALE_SEC * 2);
    expect(TURN_PART_FRESHNESS_WINDOW_SEC).toBeGreaterThanOrEqual(3600);
  });
});

describe('stripDerivationInputs (P-011 turnPartLastAt, P-010 heldWorkIntent)', () => {
  it('drops ONLY the derivation inputs, preserving every join field', () => {
    const join: PresenceTier1Joins = {
      claimedItems: ['P-001'],
      model: 'opus',
      awaitingEvent: false,
      awaitingEventKey: null,
      awaitingNote: null,
      wakeMode: 'auto',
      turnPartLastAt: iso(NOW - 1000),
      heldWorkIntent: { workItemId: 'WI-1', title: 'Fix the thing' },
    };
    const rest = stripDerivationInputs(join);
    expect(rest).not.toHaveProperty('turnPartLastAt');
    expect(rest).not.toHaveProperty('heldWorkIntent');
    expect(rest).toMatchObject({ claimedItems: ['P-001'], model: 'opus', wakeMode: 'auto' });
  });

  it('an absent join yields an empty spreadable object, not a throw', () => {
    expect(stripDerivationInputs(undefined)).toEqual({});
  });
});

describe('computeIntentStale', () => {
  it('null when activity is unknown (cannot judge a federated/never-active peer)', () => {
    expect(computeIntentStale(null)).toBeNull();
  });

  it('false while genuine activity is within the threshold', () => {
    expect(computeIntentStale(0)).toBe(false);
    expect(computeIntentStale(INTENT_STALE_SEC - 1)).toBe(false);
    expect(computeIntentStale(INTENT_STALE_SEC)).toBe(false); // boundary: exactly at threshold is NOT yet stale
  });

  it('true once genuine activity is past the threshold — the idle-but-heartbeating case', () => {
    expect(computeIntentStale(INTENT_STALE_SEC + 1)).toBe(true);
    // an su host idle 3h43m but still beating every 60s → its declared intent is stale
    expect(computeIntentStale(3 * 60 * 60 + 43 * 60)).toBe(true);
  });

  it('honors an explicit threshold override', () => {
    expect(computeIntentStale(100, 60)).toBe(true);
    expect(computeIntentStale(50, 60)).toBe(false);
  });
});

describe('formatIdleAge', () => {
  it('renders each scale in the form a reader thinks in (EI-9696: never raw seconds)', () => {
    expect(formatIdleAge(0)).toBe('0s');
    expect(formatIdleAge(42)).toBe('42s');
    expect(formatIdleAge(59)).toBe('59s');
    expect(formatIdleAge(60)).toBe('1m');
    expect(formatIdleAge(9 * 60 + 30)).toBe('9m'); // sub-minute remainder dropped
    expect(formatIdleAge(3599)).toBe('59m');
    expect(formatIdleAge(3600)).toBe('1h');
    expect(formatIdleAge(2 * 3600 + 41 * 60)).toBe('2h41m');
    // the misread fixture: 9641s looked like noise, 2h40m does not
    expect(formatIdleAge(9641)).toBe('2h40m');
    expect(formatIdleAge(86400)).toBe('1d');
    expect(formatIdleAge(3 * 86400 + 2 * 3600 + 5 * 60)).toBe('3d2h'); // two units max
  });

  it('clamps negatives and truncates fractions', () => {
    expect(formatIdleAge(-5)).toBe('0s');
    expect(formatIdleAge(61.9)).toBe('1m');
  });
});

describe('computeIntentDivergent', () => {
  it('null when either side is unknown', () => {
    expect(computeIntentDivergent(null, 10)).toBeNull();
    expect(computeIntentDivergent(10, null)).toBeNull();
    expect(computeIntentDivergent(null, null)).toBeNull();
  });

  it('false when the intent text is at least as fresh as the activity gap allows', () => {
    expect(computeIntentDivergent(0, 0)).toBe(false);
    expect(computeIntentDivergent(100, 100)).toBe(false); // same age, no gap
    expect(computeIntentDivergent(INTENT_DIVERGENCE_SEC, 0)).toBe(false); // boundary
  });

  it('true once intentAgeSec runs past lastActiveSecAgo by more than the threshold — the EI-8988 drift case', () => {
    // su-6073d: fresh activity (root-causing WI-3646) but a 25-min-stale intent string.
    expect(computeIntentDivergent(INTENT_DIVERGENCE_SEC + 1, 0)).toBe(true);
    expect(computeIntentDivergent(25 * 60, 30)).toBe(true);
  });

  it('honors an explicit threshold override', () => {
    expect(computeIntentDivergent(100, 0, 60)).toBe(true);
    expect(computeIntentDivergent(50, 0, 60)).toBe(false);
  });
});

describe('mergeTier1', () => {
  const rec = (ownerId: string, lastActiveAt: string | null, intentDeclaredAt: string | null = null) => ({
    ownerId,
    lastActiveAt,
    intentDeclaredAt,
    ownerLabel: `lbl-${ownerId}`, // a base field that must survive the merge
  });

  it('attaches intentAgeSec + intentDivergent (EI-8988): fresh activity, stale intent text', () => {
    // Root-causing WI-3646 3s ago, but the declared intent string is 25 minutes old.
    const out = mergeTier1(
      [rec('su-6073d', iso(NOW - 3_000), iso(NOW - 25 * 60 * 1000))],
      new Map(),
      NOW,
    );
    expect(out[0].lastActiveSecAgo).toBe(3);
    expect(out[0].intentStale).toBe(false); // genuinely active — NOT idle
    expect(out[0].intentAgeSec).toBe(25 * 60);
    expect(out[0].intentDivergent).toBe(true); // but its declared text is drifted
  });

  it('intentDivergent is missing/omitted intentDeclaredAt on the base type — degrades to null, not a throw', () => {
    const out = mergeTier1([{ ownerId: 'a', lastActiveAt: iso(NOW - 10_000), ownerLabel: 'lbl-a' }], new Map(), NOW);
    expect(out[0].intentAgeSec).toBeNull();
    expect(out[0].intentDivergent).toBeNull();
  });

  it('attaches lastActiveSecAgo + the join fields, preserving base fields', () => {
    const joins = new Map<string, PresenceTier1Joins>([
      [
        'a',
        {
          claimedItems: ['P-001', 'P-002'],
          claimCount: 4,
          model: 'opus',
          awaitingEvent: true,
          awaitingEventKey: 'plan-run:finished:7',
          awaitingNote: 'waiting on the run',
          wakeMode: 'manual',
        },
      ],
    ]);
    const out = mergeTier1([rec('a', iso(NOW - 10_000))], joins, NOW);
    expect(out[0]).toMatchObject({
      ownerId: 'a',
      ownerLabel: 'lbl-a', // base field preserved
      lastActiveSecAgo: 10,
      intentStale: false, // active 10s ago → its intent is current
      claimedItems: ['P-001', 'P-002'],
      claimCount: 4,
      model: 'opus',
      awaitingEvent: true,
      awaitingEventKey: 'plan-run:finished:7',
      wakeMode: 'manual',
    });
  });

  it('flags intentStale TRUE for an idle-but-present agent (the heartbeat-alive-but-not-working case)', () => {
    // No join entry needed — intentStale is derived purely from last_active_at.
    const out = mergeTier1([rec('su-idle', iso(NOW - (INTENT_STALE_SEC + 60) * 1000))], new Map(), NOW);
    expect(out[0].lastActiveSecAgo).toBe(INTENT_STALE_SEC + 60);
    expect(out[0].intentStale).toBe(true);
  });

  it('a record with no join entry (e.g. a federated peer) gets lastActiveSecAgo + intentStale only', () => {
    const out = mergeTier1([rec('fed:1@boxA', null)], new Map(), NOW);
    expect(out[0].lastActiveSecAgo).toBeNull();
    expect(out[0].intentStale).toBeNull(); // activity unknown → cannot judge
    expect((out[0] as Partial<PresenceTier1Joins>).claimedItems).toBeUndefined();
    expect((out[0] as Partial<PresenceTier1Joins>).wakeMode).toBeUndefined();
  });

  it('P-011: a fresh turn part corrects lastActiveSecAgo AND the verdicts derived from it', () => {
    // The measured incident shape: last_active_at 31min stale (past INTENT_STALE_SEC),
    // but the session streamed an assistant part 30s ago — mid-turn on native tools.
    const staleRecordAt = iso(NOW - (INTENT_STALE_SEC + 60) * 1000);
    const joins = new Map<string, PresenceTier1Joins>([
      [
        'su-native',
        {
          claimedItems: [],
          claimCount: 0,
          model: null,
          awaitingEvent: false,
          awaitingEventKey: null,
          awaitingNote: null,
          wakeMode: 'auto',
          turnPartLastAt: iso(NOW - 30_000),
        },
      ],
    ]);
    const out = mergeTier1([rec('su-native', staleRecordAt)], joins, NOW);
    expect(out[0].lastActiveSecAgo).toBe(30);
    expect(out[0].lastActiveSource).toBe('turn-parts');
    // The verdict that nearly fired a terminal grading pass one wake early:
    expect(out[0].intentStale).toBe(false);
    // The raw derivation input never rides the merged row.
    expect(out[0]).not.toHaveProperty('turnPartLastAt');
  });

  it('P-011: provenance is presence when no turn part exists, null when nothing is known', () => {
    const withRecord = mergeTier1([rec('a', iso(NOW - 10_000))], new Map(), NOW);
    expect(withRecord[0].lastActiveSource).toBe('presence');
    const nothing = mergeTier1([rec('b', null)], new Map(), NOW);
    expect(nothing[0].lastActiveSource).toBeNull();
  });
});
