/**
 * learning-loop-health tests (relight-self-learning-edges-2026-06-14 P-030).
 */
import { describe, it, expect } from 'vitest';
import {
  computeLearningLoopHealth,
  computeActivityLaneHealth,
  summarizeLearningLoopHealth,
  singletonRoutineName,
  DEFAULT_BG_HOST_START_FIRE_GRACE_MS,
  DEFAULT_RESUME_FIRE_GRACE_MS,
  type LearningLoopSpec,
  type LearningRoutineRow,
} from './learning-loop-health';

const NOW = Date.parse('2026-06-14T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// calibration = frontier (dark-by-design when inactive); scout = always-on.
const LOOPS: LearningLoopSpec[] = [
  { blueprintId: 'calibration', legacyRoutine: 'calibration-resolve' },
  { blueprintId: 'scout', legacyRoutine: 'scout-cycle' },
];

const sRow = (blueprintId: string, p: Partial<LearningRoutineRow> = {}): LearningRoutineRow => ({
  installSlug: '@singleton',
  name: singletonRoutineName(blueprintId),
  active: true,
  lastFiredAt: daysAgo(0),
  ...p,
});

describe('computeLearningLoopHealth — per-loop routine verdict', () => {
  it('an active loop that fired recently is "firing"', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [sRow('calibration', { lastFiredAt: daysAgo(0) })], { nowMs: NOW });
    expect(cal.status).toBe('firing');
    expect(cal.active).toBe(true);
    expect(cal.daysSinceFire).toBe(0);
    expect(cal.activityLastAt).toBeNull();
  });

  it('an active loop that has not fired within the stale window is "stale" (a wedge)', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [sRow('calibration', { lastFiredAt: daysAgo(5) })], {
      nowMs: NOW,
      staleAfterDays: 3,
    });
    expect(cal.status).toBe('stale');
    expect(cal.daysSinceFire).toBe(5);
  });

  it('keeps an overdue loop pending during bg-host startup grace when it has not fired since process start', () => {
    const processStartedAtMs = NOW - 5 * 60_000;
    const row = sRow('calibration', {
      lastFiredAt: new Date(processStartedAtMs - 5 * 86_400_000).toISOString(),
      nextFireAt: new Date(processStartedAtMs - 60_000).toISOString(),
    });
    const [duringGrace] = computeLearningLoopHealth([LOOPS[0]], [row], {
      nowMs: NOW,
      processStartedAtMs,
    });

    expect(duringGrace.status).toBe('pending');
    expect(summarizeLearningLoopHealth([duringGrace]).needsAttention).toEqual([]);
  });

  it('restores stale classification after the 15-minute bg-host startup grace expires', () => {
    const processStartedAtMs = NOW - DEFAULT_BG_HOST_START_FIRE_GRACE_MS - 1;
    const row = sRow('calibration', {
      lastFiredAt: new Date(processStartedAtMs - 5 * 86_400_000).toISOString(),
      nextFireAt: new Date(processStartedAtMs - 60_000).toISOString(),
    });
    const [afterGrace] = computeLearningLoopHealth([LOOPS[0]], [row], {
      nowMs: NOW,
      processStartedAtMs,
    });

    expect(afterGrace.status).toBe('stale');
  });

  it('does not mask a post-start fire whose activity remains unproven', () => {
    const processStartedAtMs = NOW - 5 * 60_000;
    const firedAtMs = processStartedAtMs + 60_000;
    const row = sRow('calibration', {
      lastFiredAt: new Date(firedAtMs).toISOString(),
      nextFireAt: new Date(processStartedAtMs - 60_000).toISOString(),
    });
    const [health] = computeLearningLoopHealth([LOOPS[0]], [row], {
      nowMs: NOW,
      processStartedAtMs,
      activityByBlueprintId: {
        calibration: {
          lastActivityAt: new Date(firedAtMs - 60_000).toISOString(),
          source: 'test-ledger',
          mode: 'since-fire',
          graceMs: 60_000,
        },
      },
    });

    expect(health.status).toBe('stale');
  });

  it('keeps a due loop pending briefly after a recorded resume, then restores the stale verdict', () => {
    const resumedAtMs = NOW - 30_000;
    const row = sRow('calibration', {
      lastFiredAt: daysAgo(65),
      nextFireAt: daysAgo(65),
      lastPauseResumedAtMs: resumedAtMs,
    });
    const [duringGrace] = computeLearningLoopHealth([LOOPS[0]], [row], { nowMs: NOW, staleAfterDays: 3 });

    expect(duringGrace.status).toBe('pending');
    expect(summarizeLearningLoopHealth([duringGrace]).needsAttention).toEqual([]);

    const [afterGrace] = computeLearningLoopHealth([LOOPS[0]], [row], {
      nowMs: resumedAtMs + DEFAULT_RESUME_FIRE_GRACE_MS + 1,
      staleAfterDays: 3,
    });
    expect(afterGrace.status).toBe('stale');
  });

  it('does not let pre-pause domain activity override a recent resume grace', () => {
    const resumedAtMs = NOW - 30_000;
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: daysAgo(65), nextFireAt: daysAgo(65), lastPauseResumedAtMs: resumedAtMs })],
      {
        nowMs: NOW,
        staleAfterDays: 3,
        activityByBlueprintId: { scout: { lastActivityAt: daysAgo(65), source: 'scout_ticks' } },
      },
    );

    expect(scout.status).toBe('pending');
  });

  it('keeps a long-cadence loop healthy while its next scheduled fire is still ahead', () => {
    const [cal] = computeLearningLoopHealth(
      [LOOPS[0]],
      [sRow('calibration', { lastFiredAt: daysAgo(12), nextFireAt: daysAgo(-18) })],
      { nowMs: NOW, staleAfterDays: 3 },
    );

    expect(cal.status).toBe('firing');
    expect(cal.daysSinceFire).toBe(12);
  });

  it('marks a long-cadence loop stale once its promised next fire is overdue', () => {
    const [cal] = computeLearningLoopHealth(
      [LOOPS[0]],
      [sRow('calibration', { lastFiredAt: daysAgo(40), nextFireAt: daysAgo(1) })],
      { nowMs: NOW, staleAfterDays: 3 },
    );

    expect(cal.status).toBe('stale');
    expect(cal.daysSinceFire).toBe(40);
  });

  it('marks Scout stale when its routine fired but scout_ticks activity is stale', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: daysAgo(0) })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: daysAgo(2), source: 'scout_ticks' },
        },
      },
    );

    expect(scout.status).toBe('stale');
    expect(scout.daysSinceFire).toBe(0);
    expect(scout.daysSinceActivity).toBe(2);
    expect(scout.activitySource).toBe('scout_ticks');
  });

  it('lets a fresh Scout fire finish when the previous tick is older than the activity grace', () => {
    const firedAt = NOW - 30_000;
    const lastActivityAt = firedAt - 31.4 * 60_000;
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: new Date(firedAt).toISOString() })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: new Date(lastActivityAt).toISOString(), source: 'scout_ticks' },
        },
        activityLagGraceMs: 30 * 60_000,
      },
    );

    expect(scout.status).toBe('firing');
    expect(scout.daysSinceFire).toBe(0);
    expect(scout.daysSinceActivity).toBe(0);
  });

  it('marks Scout stale when a fire remains without activity past the grace', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: new Date(NOW - 20 * 60_000).toISOString() })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: new Date(NOW - 40 * 60_000).toISOString(), source: 'scout_ticks' },
        },
        activityLagGraceMs: 5 * 60_000,
      },
    );

    expect(scout.status).toBe('stale');
    expect(scout.daysSinceFire).toBe(0);
    expect(scout.daysSinceActivity).toBe(0);
  });

  it('keeps Scout firing when routine fire and scout_ticks activity are within the grace window', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: new Date(NOW).toISOString() })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: new Date(NOW - 2 * 60_000).toISOString(), source: 'scout_ticks' },
        },
        activityLagGraceMs: 5 * 60_000,
      },
    );

    expect(scout.status).toBe('firing');
  });

  it('keeps Scout firing when its scout_ticks activity is fresh', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: daysAgo(0) })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: daysAgo(0), source: 'scout_ticks' },
        },
      },
    );

    expect(scout.status).toBe('firing');
    expect(scout.daysSinceActivity).toBe(0);
  });

  describe("activity mode 'since-fire' (a weekly loop; WI-10004117)", () => {
    const WEEKLY: LearningLoopSpec = { blueprintId: 'memory-precision', legacyRoutine: 'memory-precision-bench' };
    const HOUR = 3_600_000;
    const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    const judge = (
      fire: Partial<LearningRoutineRow>,
      lastActivityAt: string | null,
      mode?: 'lag' | 'since-fire',
    ) =>
      computeLearningLoopHealth([WEEKLY], [sRow('memory-precision', fire)], {
        nowMs: NOW,
        staleAfterDays: 3,
        activityByBlueprintId: {
          'memory-precision': { lastActivityAt, source: 'memory_precision_bench', mode, graceMs: HOUR },
        },
      })[0]!;

    it('stays firing between weekly runs, where lag mode would page it', () => {
      // Fired 6 days ago, recorded its row 20 minutes later, next fire tomorrow.
      const fire = { lastFiredAt: daysAgo(6), nextFireAt: daysAgo(-1) };
      const activity = at(6 * 86_400_000 - 20 * 60_000);
      expect(judge(fire, activity, 'since-fire').status).toBe('firing');
      // Control: the default lag test misfires on exactly this healthy shape.
      expect(judge(fire, activity).status).toBe('stale');
    });

    it('pages a fire that recorded nothing once the grace has passed (the 09-29 shape)', () => {
      const h = judge({ lastFiredAt: at(2 * HOUR), nextFireAt: daysAgo(-6) }, daysAgo(58), 'since-fire');
      expect(h.status).toBe('stale');
      expect(h.activitySource).toBe('memory_precision_bench');
    });

    it('does not page a fire still inside its grace (a run in flight)', () => {
      expect(judge({ lastFiredAt: at(10 * 60_000), nextFireAt: daysAgo(-7) }, daysAgo(7), 'since-fire').status).toBe(
        'firing',
      );
    });

    it('pages a fired loop that has never recorded any activity', () => {
      expect(judge({ lastFiredAt: at(2 * HOUR), nextFireAt: daysAgo(-6) }, null, 'since-fire').status).toBe('stale');
    });

    it('leaves a never-fired loop to the routine verdict (pending, not stale)', () => {
      expect(judge({ lastFiredAt: null, nextFireAt: daysAgo(-1) }, null, 'since-fire').status).toBe('pending');
    });
  });

  it('an active loop NEVER fired but with its first fire still ahead is "pending" (just armed, not a wedge)', () => {
    const [cal] = computeLearningLoopHealth(
      [LOOPS[0]],
      [sRow('calibration', { lastFiredAt: null, nextFireAt: daysAgo(-1) })], // next fire 1d in the FUTURE
      { nowMs: NOW },
    );
    expect(cal.status).toBe('pending');
    expect(cal.daysSinceFire).toBeNull();
  });

  it('an active loop NEVER fired whose first fire is already overdue is "stale" (a stuck fire path)', () => {
    const [cal] = computeLearningLoopHealth(
      [LOOPS[0]],
      [sRow('calibration', { lastFiredAt: null, nextFireAt: daysAgo(1) })], // next fire 1d in the PAST
      { nowMs: NOW },
    );
    expect(cal.status).toBe('stale');
  });

  it('an active loop NEVER fired with no next-fire time is "stale" (cannot vouch for it)', () => {
    const [cal] = computeLearningLoopHealth(
      [LOOPS[0]],
      [sRow('calibration', { lastFiredAt: null, nextFireAt: null })],
      { nowMs: NOW },
    );
    expect(cal.status).toBe('stale');
  });

  it('an inactive FRONTIER loop is "dark-by-design"', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [sRow('calibration', { active: false, lastFiredAt: null })], { nowMs: NOW });
    expect(cal.status).toBe('dark-by-design');
    expect(cal.alwaysOn).toBe(false);
  });

  it('an inactive ALWAYS-ON loop is "should-be-on-but-dark" (a real gap)', () => {
    const [scout] = computeLearningLoopHealth([LOOPS[1]], [sRow('scout', { active: false })], { nowMs: NOW });
    expect(scout.status).toBe('should-be-on-but-dark');
    expect(scout.alwaysOn).toBe(true);
    expect(scout.pauseAcknowledged).toBe(false);
  });

  // EI-19370236916382521 — a re-affirmed pause (routines:set { active:false, reviewBy })
  // stays `should-be-on-but-dark` (the state is still true — the loop IS dark) but is
  // marked acknowledged so an escalation sweep can skip it without needing a new status.
  it('an inactive ALWAYS-ON loop with a FUTURE pauseReviewBy is pauseAcknowledged (re-affirmed, not a silent gap)', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { active: false, pauseReviewBy: daysAgo(-30) })], // 30 days in the future
      { nowMs: NOW },
    );
    expect(scout.status).toBe('should-be-on-but-dark');
    expect(scout.pauseAcknowledged).toBe(true);
  });

  it('an inactive ALWAYS-ON loop with a PAST pauseReviewBy is NOT acknowledged (the review window lapsed)', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { active: false, pauseReviewBy: daysAgo(1) })], // 1 day in the past
      { nowMs: NOW },
    );
    expect(scout.status).toBe('should-be-on-but-dark');
    expect(scout.pauseAcknowledged).toBe(false);
  });

  it('pauseReviewBy on an ACTIVE (firing) row never marks it acknowledged — only should-be-on-but-dark can be', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { active: true, lastFiredAt: daysAgo(0), pauseReviewBy: daysAgo(-30) })],
      { nowMs: NOW },
    );
    expect(scout.status).toBe('firing');
    expect(scout.pauseAcknowledged).toBe(false);
  });

  it('a loop with no routine row at all is "absent"', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [], { nowMs: NOW });
    expect(cal.status).toBe('absent');
    expect(cal.active).toBe(false);
    expect(cal.daysSinceFire).toBeNull();
  });

  it('matches the legacy per-home row when no @singleton row exists', () => {
    const legacy: LearningRoutineRow = { installSlug: 'acme-home', name: 'calibration-resolve', active: true, lastFiredAt: daysAgo(0) };
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [legacy], { nowMs: NOW, homeSlug: 'acme-home' });
    expect(cal.status).toBe('firing');
    expect(cal.legacyRow).not.toBeNull();
    expect(cal.singletonRow).toBeNull();
  });

  it('flags the @singleton↔legacy double-state as a collision (prefers the @singleton row)', () => {
    const both: LearningRoutineRow[] = [
      sRow('calibration', { active: false }),
      { installSlug: 'acme-home', name: 'calibration-resolve', active: true, lastFiredAt: daysAgo(0) },
    ];
    const [cal] = computeLearningLoopHealth([LOOPS[0]], both, { nowMs: NOW, homeSlug: 'acme-home' });
    expect(cal.collision).toBe(true);
    expect(cal.active).toBe(false); // the @singleton row wins
  });
});

describe('computeActivityLaneHealth — routine-less activity-only lane (su-ideate P-013)', () => {
  const lane = (lastActivityAt: string | null) => ({
    blueprintId: 'su-ideation',
    lastActivityAt,
    source: 'su-ideate-ticks+ungraded-watchdog',
  });

  it('never any activity → dark-by-design (built, not yet turning — no routine to be "absent")', () => {
    const h = computeActivityLaneHealth(lane(null), { nowMs: NOW });
    expect(h.status).toBe('dark-by-design');
    expect(h.active).toBe(false);
    expect(h.singletonRow).toBeNull();
    expect(h.legacyRow).toBeNull();
    expect(h.collision).toBe(false);
    expect(h.alwaysOn).toBe(false);
    expect(h.lastFiredAt).toBeNull();
    expect(h.activityLastAt).toBeNull();
    expect(h.activitySource).toBe('su-ideate-ticks+ungraded-watchdog');
  });

  it('fresh activity within the stale window → firing', () => {
    const h = computeActivityLaneHealth(lane(daysAgo(0)), { nowMs: NOW, staleAfterDays: 3 });
    expect(h.status).toBe('firing');
    expect(h.active).toBe(true);
    expect(h.daysSinceActivity).toBe(0);
  });

  it('activity older than the stale window → stale (the "a dead loop shows" signal)', () => {
    const h = computeActivityLaneHealth(lane(daysAgo(5)), { nowMs: NOW, staleAfterDays: 3 });
    expect(h.status).toBe('stale');
    expect(h.active).toBe(true);
    expect(h.daysSinceActivity).toBe(5);
  });

  it('a stale activity-only lane is surfaced by summarize needs-attention', () => {
    const stale = computeActivityLaneHealth(lane(daysAgo(10)), { nowMs: NOW, staleAfterDays: 3 });
    const s = summarizeLearningLoopHealth([stale]);
    expect(s.total).toBe(1);
    expect(s.stale).toBe(1);
    expect(s.needsAttention).toEqual(['su-ideation']);
  });

  it('a dark-by-design activity-only lane is NOT flagged (silence on a judgment-driven lane is not a wedge)', () => {
    const dark = computeActivityLaneHealth(lane(null), { nowMs: NOW });
    const s = summarizeLearningLoopHealth([dark]);
    expect(s.darkByDesign).toBe(1);
    expect(s.needsAttention).toEqual([]);
  });
});

describe('summarizeLearningLoopHealth — rollup + needs-attention partition', () => {
  it('counts by status and surfaces only the loops that warrant a look', () => {
    const rows = computeLearningLoopHealth(
      LOOPS,
      [
        sRow('calibration', { active: false, lastFiredAt: null }), // dark-by-design (frontier)
        sRow('scout', { active: false }), // should-be-on-but-dark (always-on)
      ],
      { nowMs: NOW },
    );
    const s = summarizeLearningLoopHealth(rows);
    expect(s.total).toBe(2);
    expect(s.darkByDesign).toBe(1);
    expect(s.shouldBeOnButDark).toBe(1);
    expect(s.needsAttention).toEqual(['scout']); // dark-by-design is NOT flagged; the always-on gap IS
  });

  // EI-19370236916382521
  it('a RE-AFFIRMED should-be-on-but-dark loop still counts in shouldBeOnButDark but drops out of needsAttention', () => {
    const rows = computeLearningLoopHealth(
      LOOPS,
      [
        sRow('calibration', { active: false, lastFiredAt: null }), // dark-by-design (frontier)
        sRow('scout', { active: false, pauseReviewBy: daysAgo(-30) }), // re-affirmed, 30d out
      ],
      { nowMs: NOW },
    );
    const s = summarizeLearningLoopHealth(rows);
    expect(s.shouldBeOnButDark).toBe(1); // the state is still real — status is unchanged
    expect(s.needsAttention).toEqual([]); // but it no longer needs a fresh look
  });
});

/**
 * EI-10625 — A LOOP THAT DOES NOT EXIST MUST NOT BE QUIETER THAN A LOOP THAT IS LATE.
 *
 * The memory recall canary (EI-10047) was never materialized: no routine row, 0 runs, for
 * its entire life. `computeLearningLoopHealth` classified it `absent` CORRECTLY on every
 * call — and `summarizeLearningLoopHealth` then dropped it from `needsAttention`, because
 * that filter admitted an absent loop only when `alwaysOn`. The canary is a frontier loop,
 * so it was excused. The classification was never the problem; the action on it was.
 *
 * These tests pin the rule: an absent loop that was EXPECTED to exist always needs
 * attention — and construct the failure that should make it fire before trusting it.
 */
describe('summarizeLearningLoopHealth — a never-materialized loop is LOUD (EI-10625)', () => {
  // The canary's exact live shape: a declared, non-always-on loop with NO routine row.
  const CANARY: LearningLoopSpec = {
    blueprintId: 'memory-live-recall-canary',
    legacyRoutine: 'memory-live-recall-canary',
  };

  it('FIRES: a declared frontier loop with NO routine row is never-materialized, not dark', () => {
    const rows = computeLearningLoopHealth([CANARY], [], { nowMs: NOW });
    expect(rows[0].status).toBe('absent');
    expect(rows[0].alwaysOn).toBe(false); // the very property that used to excuse it
    expect(rows[0].expectedMaterialized).toBe(true);

    const s = summarizeLearningLoopHealth(rows);
    expect(s.absent).toBe(1);
    expect(s.neverMaterialized).toBe(1);
    expect(s.needsAttention).toEqual(['memory-live-recall-canary']); // was [] — the bug
  });

  it('an absent loop is flagged ALONGSIDE stale ones, not instead of them', () => {
    const rows = computeLearningLoopHealth(
      [CANARY, ...LOOPS],
      [
        sRow('scout', { lastFiredAt: daysAgo(9) }), // stale
        sRow('calibration', { active: false, lastFiredAt: null }), // dark-by-design — has a row
      ],
      { nowMs: NOW },
    );
    const s = summarizeLearningLoopHealth(rows);
    expect(s.needsAttention).toContain('memory-live-recall-canary');
    expect(s.needsAttention).toContain('scout');
    expect(s.needsAttention).not.toContain('calibration'); // a DARK loop still has a row
    expect(s.neverMaterialized).toBe(1);
  });

  it('does NOT fire on a loop that is absent BY DESIGN (Class-C, platform mode OFF)', () => {
    // The one legitimate absence (P-070): a public release with PLATFORM_IMPROVEMENT_LOOPS
    // off never materializes Class-C loops. Absent is expected there, and 13 false alarms
    // on every release would be its own cry-wolf failure.
    const rows = computeLearningLoopHealth([CANARY], [], {
      nowMs: NOW,
      expectedMaterialized: () => false,
    });
    expect(rows[0].status).toBe('absent');
    expect(rows[0].expectedMaterialized).toBe(false);

    const s = summarizeLearningLoopHealth(rows);
    expect(s.absent).toBe(1); // still counted...
    expect(s.neverMaterialized).toBe(0); // ...but it is not a registration failure
    expect(s.needsAttention).toEqual([]);
  });

  it('the routine-less su-ideation lane is never a registration failure (it has no row by design)', () => {
    const lane = computeActivityLaneHealth(
      { blueprintId: 'su-ideation', lastActivityAt: daysAgo(0), source: 'su-ideate-ticks' },
      { nowMs: NOW },
    );
    expect(lane.expectedMaterialized).toBe(false);
    expect(summarizeLearningLoopHealth([lane]).neverMaterialized).toBe(0);
  });
});
