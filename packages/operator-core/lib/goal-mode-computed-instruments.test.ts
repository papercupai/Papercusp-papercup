import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHILD_PROOF_WINDOW_MS,
  CHILD_VERIFY_TOOLS,
  CREATE_TOOLS,
  DEDUP_LOOKBACK_MS,
  DEDUP_SEARCH_TOOLS,
  GOAL_MODE_COMPUTED_CRITERIA,
  GOAL_MODE_INSTRUMENT_KEYS,
  GOAL_MODE_INSTRUMENTED_CRITERIA,
  GOAL_MODE_TRIGGER_CENSUS,
  GOAL_RECORD_FOLDS,
  GOAL_RECORD_READS,
  GOAL_WRITE_TOOLS,
  LAUNCH_TOOLS,
  LOOSE_ITEMS_NEED_PLAN,
  PORTFOLIO_ACTION_TOOLS,
  goalModeCriterionForInstrument,
  rateGoalModeComputed,
  triggerMatches,
  type GoalModeComputedMetrics,
  type HolderCall,
} from './goal-mode-computed-instruments';

const START = Date.parse('2026-10-08T10:00:00.000Z');
const END = Date.parse('2026-10-08T12:00:00.000Z');
const MIN = 60_000;
const at = (minutes: number) => START + minutes * MIN;
const call = (tool: string, minutes: number, extra: Partial<HolderCall> = {}): HolderCall => ({
  tool,
  at: at(minutes),
  ok: true,
  ...extra,
});

function metrics(overrides: Partial<GoalModeComputedMetrics> = {}): GoalModeComputedMetrics {
  return {
    version: 1,
    window: {
      workspaceId: 'ws',
      goalId: 'goal-1',
      holderOwnerId: 'su-holder',
      windowStart: new Date(START).toISOString(),
      windowEnd: new Date(END).toISOString(),
    },
    measuredAtMs: END + 2 * CHILD_PROOF_WINDOW_MS,
    holderCalls: [call('coord:orient', 1)],
    holderCallsTruncated: false,
    edits: [],
    coldWakes: [],
    descendantCompletions: [],
    peakWidth: { agents: 1, at: at(1) },
    maxAgents: 12,
    createdItems: { placed: 0, loose: 0, looseSample: [] },
    plansWritten: 0,
    startedPlans: [],
    demandAtStart: 0,
    closedInWindow: 0,
    ...overrides,
  };
}

describe('instrument registry', () => {
  it('binds one goal-mode.<criterion> key per instrumented criterion and round-trips it', () => {
    expect(new Set(Object.values(GOAL_MODE_INSTRUMENT_KEYS)).size).toBe(GOAL_MODE_INSTRUMENTED_CRITERIA.length);
    for (const criterion of GOAL_MODE_INSTRUMENTED_CRITERIA) {
      expect(goalModeCriterionForInstrument(GOAL_MODE_INSTRUMENT_KEYS[criterion]!)).toBe(criterion);
    }
    expect(goalModeCriterionForInstrument('goal-mode.not-a-criterion')).toBeNull();
    expect(goalModeCriterionForInstrument('woe.ideation-yield')).toBeNull();
  });

  it('rates every instrumented criterion on every window', () => {
    expect(Object.keys(rateGoalModeComputed(metrics())).sort()).toEqual([...GOAL_MODE_INSTRUMENTED_CRITERIA].sort());
  });

  it('every instrumented criterion is a goal-mode-e2e rubric criterion (doc-claims coverage list)', () => {
    const coverage = JSON.parse(
      readFileSync(join(__dirname, 'doc-claims', 'goal-contract-rubric-coverage.json'), 'utf8'),
    ) as unknown;
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.rubricKeys)) record.rubricKeys.forEach((key) => typeof key === 'string' && keys.add(key));
        Object.values(record).forEach(walk);
      }
    };
    walk(coverage);
    expect(keys.size).toBeGreaterThan(30);
    expect(GOAL_MODE_INSTRUMENTED_CRITERIA.filter((criterion) => !keys.has(criterion))).toEqual([]);
  });

  it('every trigger and vocabulary tool name is a registered tool', () => {
    const roots = [join(__dirname, 'agent-tools'), join(__dirname, '..', '..', 'agent-mcp', 'src')];
    const source: string[] = [];
    const visit = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) visit(path);
        else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) source.push(readFileSync(path, 'utf8'));
      }
    };
    roots.forEach(visit);
    const corpus = source.join('\n');
    // Positive control: a name certainly registered, so a broken scan cannot pass vacuously.
    expect(corpus).toMatch(/name:\s*['"]plans:new['"]/);
    const names = new Set<string>([
      ...CREATE_TOOLS,
      ...LAUNCH_TOOLS,
      ...GOAL_RECORD_READS,
      ...GOAL_RECORD_FOLDS,
      ...Object.values(GOAL_MODE_TRIGGER_CENSUS).flatMap((specs) => specs.filter((spec) => !spec.prefix).map((spec) => spec.tool)),
    ]);
    const missing = [...names].filter((name) => !new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(corpus));
    expect(missing).toEqual([]);
    // The read vocabularies must at least be well-formed group:verb names.
    for (const name of [...DEDUP_SEARCH_TOOLS, ...CHILD_VERIFY_TOOLS, ...GOAL_WRITE_TOOLS, ...PORTFOLIO_ACTION_TOOLS]) {
      expect(name).toMatch(/^[a-z_-]+:[a-z_-]+$/);
    }
  });
});

describe('idle window', () => {
  it('marks every criterion unknown/idle when the holder made no call', () => {
    const ratings = rateGoalModeComputed(metrics({ holderCalls: [] }));
    for (const criterion of GOAL_MODE_INSTRUMENTED_CRITERIA) {
      expect(ratings[criterion]).toMatchObject({ verdict: 'unknown', unknownReason: 'idle' });
    }
  });

  it('a call outside the window does not make the window active', () => {
    const ratings = rateGoalModeComputed(metrics({ holderCalls: [call('plans:list', -10)] }));
    expect(ratings['never-implements']).toMatchObject({ unknownReason: 'idle' });
  });
});

describe('never-implements', () => {
  it('fails on an edit-hook attribution', () => {
    const r = rateGoalModeComputed(metrics({ edits: [{ file: 'src/a.ts', at: at(5), via: 'PostToolUse:codex:apply_patch' }] }));
    expect(r['never-implements']).toMatchObject({ verdict: 'fail' });
    expect(r['never-implements']!.reason).toContain('src/a.ts');
  });
  it('fails on capability:edit and on a completion reporting changed files', () => {
    expect(rateGoalModeComputed(metrics({ holderCalls: [call('capability:edit', 3)] }))['never-implements']!.verdict).toBe('fail');
    expect(
      rateGoalModeComputed(metrics({ holderCalls: [call('work_items:complete', 3, { args: { filesChanged: 2 } })] }))['never-implements']!.verdict,
    ).toBe('fail');
  });
  it('passes when the holder only managed (positive control)', () => {
    const r = rateGoalModeComputed(
      metrics({ holderCalls: [call('plans:list', 2), call('work_items:complete', 3, { args: { filesChanged: 0 } })] }),
    );
    expect(r['never-implements']).toMatchObject({ verdict: 'pass' });
  });
});

describe('dedup-before-creating', () => {
  it('is not-exercised without a creation', () => {
    expect(rateGoalModeComputed(metrics())['dedup-before-creating']).toMatchObject({ unknownReason: 'not-exercised' });
  });
  it('fails a creation with no prior search, including a search that came after it', () => {
    const r = rateGoalModeComputed(metrics({ holderCalls: [call('work_items:create', 10), call('work_items:list', 11)] }));
    expect(r['dedup-before-creating']).toMatchObject({ verdict: 'fail' });
  });
  it('fails a search older than the lookback', () => {
    const r = rateGoalModeComputed(
      metrics({ holderCalls: [call('work_items:list', 0), call('work_items:create', DEDUP_LOOKBACK_MS / MIN + 5)] }),
    );
    expect(r['dedup-before-creating']!.verdict).toBe('fail');
  });
  it('passes when every creation follows a search, including one before the window start (positive control)', () => {
    const r = rateGoalModeComputed(
      metrics({ holderCalls: [call('plans:list', -5), call('plans:new', 2), call('search:semantic', 40), call('work_items:create', 45)] }),
    );
    expect(r['dedup-before-creating']).toMatchObject({ verdict: 'pass' });
  });
});

describe('work-placed-into-started-plans', () => {
  it('fails loose items over the threshold with no plan written', () => {
    const r = rateGoalModeComputed(
      metrics({ createdItems: { placed: 0, loose: LOOSE_ITEMS_NEED_PLAN, looseSample: ['EI-1', 'EI-2', 'EI-3'] } }),
    );
    expect(r['work-placed-into-started-plans']).toMatchObject({ verdict: 'fail' });
  });
  it('defers to the grader for a few loose items', () => {
    const r = rateGoalModeComputed(metrics({ createdItems: { placed: 2, loose: 1, looseSample: ['EI-9'] } }));
    expect(r['work-placed-into-started-plans']).toMatchObject({ verdict: 'unknown', unknownReason: 'needs-judgment' });
  });
  it('passes when every filed item carries a plan (positive control)', () => {
    const r = rateGoalModeComputed(metrics({ createdItems: { placed: 4, loose: 0, looseSample: [] }, plansWritten: 1 }));
    expect(r['work-placed-into-started-plans']).toMatchObject({ verdict: 'pass' });
  });
  it('is not-exercised when nothing was filed', () => {
    expect(rateGoalModeComputed(metrics())['work-placed-into-started-plans']).toMatchObject({ unknownReason: 'not-exercised' });
  });
});

describe('started-plans-staffed-and-claimed', () => {
  it('fails a started plan with open items and no claim in the window', () => {
    const r = rateGoalModeComputed(
      metrics({
        startedPlans: [{ slug: 'p1', openItems: 4, blockedItems: 0, claimedInWindow: 0, fleetLaunched: false }],
      }),
    );
    expect(r['started-plans-staffed-and-claimed']).toMatchObject({ verdict: 'fail' });
    expect(r['started-plans-staffed-and-claimed']!.reason).toContain('no fleet ever launched');
  });
  it('passes when each owed plan was claimed (positive control), ignoring finished plans', () => {
    const r = rateGoalModeComputed(
      metrics({
        startedPlans: [
          { slug: 'p1', openItems: 4, blockedItems: 0, claimedInWindow: 2, fleetLaunched: true },
          { slug: 'done', openItems: 0, blockedItems: 0, claimedInWindow: 0, fleetLaunched: false },
        ],
      }),
    );
    expect(r['started-plans-staffed-and-claimed']).toMatchObject({ verdict: 'pass' });
  });
  it('does not owe a fleet to a plan parked behind blocked items (live false positive, goal 60d3a8)', () => {
    const r = rateGoalModeComputed(
      metrics({
        startedPlans: [
          { slug: 'parked', openItems: 0, blockedItems: 3, claimedInWindow: 0, fleetLaunched: false },
          { slug: 'parked-2', openItems: 0, blockedItems: 1, claimedInWindow: 0, fleetLaunched: true },
        ],
      }),
    );
    const rating = r['started-plans-staffed-and-claimed']!;
    expect(rating).toMatchObject({ verdict: 'unknown', unknownReason: 'not-exercised' });
    expect(rating.reason).toContain('2 plan(s) held only blocked or needs-human items');
  });
  it('still fails the one claimable plan beside blocked-only plans (control: the filter cannot hide real debt)', () => {
    const r = rateGoalModeComputed(
      metrics({
        startedPlans: [
          { slug: 'parked', openItems: 0, blockedItems: 3, claimedInWindow: 0, fleetLaunched: false },
          { slug: 'owed', openItems: 2, blockedItems: 2, claimedInWindow: 0, fleetLaunched: true },
        ],
      }),
    );
    expect(r['started-plans-staffed-and-claimed']).toMatchObject({ verdict: 'fail' });
    expect(r['started-plans-staffed-and-claimed']!.reason).toContain('1 of 1 started plan(s)');
  });
});

describe('child-execution-proven', () => {
  it('fails a launch-and-forget', () => {
    const r = rateGoalModeComputed(metrics({ holderCalls: [call('fleet:launch-on-plan', 5)] }));
    expect(r['child-execution-proven']).toMatchObject({ verdict: 'fail' });
  });
  it('passes when a descendant closed an item and the holder checked liveness (positive control)', () => {
    const r = rateGoalModeComputed(
      metrics({ holderCalls: [call('fleet:launch-on-plan', 5), call('fleet:assignments', 20)], descendantCompletions: [at(40)] }),
    );
    expect(r['child-execution-proven']).toMatchObject({ verdict: 'pass' });
  });
  it('a completion after the proof window does not count', () => {
    const r = rateGoalModeComputed(
      metrics({
        holderCalls: [call('capability:launch-agent', 5)],
        descendantCompletions: [at(5 + CHILD_PROOF_WINDOW_MS / MIN + 1)],
      }),
    );
    expect(r['child-execution-proven']!.verdict).toBe('fail');
  });
  it('defers while the proof window is still open', () => {
    const r = rateGoalModeComputed(
      metrics({ holderCalls: [call('fleet:launch-on-plan', 110)], measuredAtMs: at(115) }),
    );
    expect(r['child-execution-proven']).toMatchObject({ unknownReason: 'needs-judgment' });
  });
});

describe('parallelism-width-and-ceilings', () => {
  it('fails over the goal ceiling', () => {
    const r = rateGoalModeComputed(
      metrics({ holderCalls: [call('fleet:launch-on-plan', 5)], peakWidth: { agents: 14, at: at(30) }, maxAgents: 12 }),
    );
    expect(r['parallelism-width-and-ceilings']).toMatchObject({ verdict: 'fail' });
  });
  it('defers within the ceiling and treats unlimited as no ceiling (positive control)', () => {
    const within = rateGoalModeComputed(metrics({ holderCalls: [call('fleet:launch-on-plan', 5)], peakWidth: { agents: 6, at: at(30) } }));
    expect(within['parallelism-width-and-ceilings']).toMatchObject({ unknownReason: 'needs-judgment' });
    const unlimited = rateGoalModeComputed(metrics({ peakWidth: { agents: 40, at: at(30) }, maxAgents: null }));
    expect(unlimited['parallelism-width-and-ceilings']!.verdict).toBe('unknown');
  });
});

describe('portfolio-activity-floor', () => {
  it('fails open demand with no placement and no closure over an hour', () => {
    const r = rateGoalModeComputed(metrics({ demandAtStart: 7, holderCalls: [call('coord:orient', 1)] }));
    expect(r['portfolio-activity-floor']).toMatchObject({ verdict: 'fail' });
  });
  it('passes on placement or closure (positive control)', () => {
    expect(rateGoalModeComputed(metrics({ demandAtStart: 7, closedInWindow: 1 }))['portfolio-activity-floor']!.verdict).toBe('pass');
    expect(
      rateGoalModeComputed(metrics({ demandAtStart: 7, holderCalls: [call('coord:dispatch', 3)] }))['portfolio-activity-floor']!.verdict,
    ).toBe('pass');
  });
  it('is not-exercised without demand', () => {
    expect(rateGoalModeComputed(metrics())['portfolio-activity-floor']).toMatchObject({ unknownReason: 'not-exercised' });
  });
});

describe('durability-across-cold-wake', () => {
  it('fails a write before any read of the goal after a cold wake', () => {
    const r = rateGoalModeComputed(
      metrics({ coldWakes: [at(30)], holderCalls: [call('loop:status', 31), call('plans:start', 32), call('goals:get', 33)] }),
    );
    expect(r['durability-across-cold-wake']).toMatchObject({ verdict: 'fail' });
  });
  it('defers to the grader when only coord:orient (the goal-portfolio fold) preceded the write (live 60d3a8 case)', () => {
    const r = rateGoalModeComputed(
      metrics({ coldWakes: [at(30)], holderCalls: [call('coord:orient', 31), call('work_items:complete', 32)] }),
    );
    expect(r['durability-across-cold-wake']).toMatchObject({ verdict: 'unknown', unknownReason: 'needs-judgment' });
    expect(r['durability-across-cold-wake']!.reason).toContain("coord:orient's goal-portfolio fold");
  });
  it('does not credit a failed coord:orient as a goal read', () => {
    const r = rateGoalModeComputed(
      metrics({ coldWakes: [at(30)], holderCalls: [call('coord:orient', 31, { ok: false }), call('plans:start', 32)] }),
    );
    expect(r['durability-across-cold-wake']).toMatchObject({ verdict: 'fail' });
  });
  it('passes when goals:get precedes the first write (positive control)', () => {
    const r = rateGoalModeComputed(
      metrics({ coldWakes: [at(30)], holderCalls: [call('goals:get', 31), call('plans:start', 32)] }),
    );
    expect(r['durability-across-cold-wake']).toMatchObject({ verdict: 'pass' });
  });
  it('judges each wake only up to the next wake', () => {
    const r = rateGoalModeComputed(
      metrics({
        coldWakes: [at(30), at(60)],
        holderCalls: [call('goals:get', 31), call('plans:start', 32), call('plans:start', 61), call('goals:get', 62)],
      }),
    );
    expect(r['durability-across-cold-wake']!.verdict).toBe('fail');
  });
  it('is not-exercised without a cold wake', () => {
    expect(rateGoalModeComputed(metrics())['durability-across-cold-wake']).toMatchObject({ unknownReason: 'not-exercised' });
  });
});

describe('trigger census', () => {
  it('is not-exercised without a trigger and needs-judgment with one (positive control per criterion)', () => {
    const quiet = rateGoalModeComputed(metrics());
    for (const [criterion, specs] of Object.entries(GOAL_MODE_TRIGGER_CENSUS)) {
      expect(quiet[criterion]).toMatchObject({ verdict: 'unknown', unknownReason: 'not-exercised' });
      const spec = specs[0]!;
      const trigger = call(spec.prefix ? `${spec.tool}route-idea` : spec.tool, 10, {
        args: spec.arg && spec.argIn ? { [spec.arg]: spec.argIn[0] } : {},
      });
      const fired = rateGoalModeComputed(metrics({ holderCalls: [trigger] }));
      expect(fired[criterion], criterion).toMatchObject({ verdict: 'unknown', unknownReason: 'needs-judgment' });
    }
  });
  it('an argument-gated trigger ignores the same tool with another argument, and failed calls never trigger', () => {
    const spec = GOAL_MODE_TRIGGER_CENSUS['shipped-not-green']!.find((s) => s.tool === 'plans:set-plan-status')!;
    expect(triggerMatches(spec, call('plans:set-plan-status', 1, { args: { status: 'shipped' } }))).toBe(true);
    expect(triggerMatches(spec, call('plans:set-plan-status', 1, { args: { status: 'active' } }))).toBe(false);
    expect(triggerMatches({ tool: 'rubrics:propose' }, call('rubrics:propose', 1, { ok: false }))).toBe(false);
  });
  it('census criteria and computed criteria do not overlap', () => {
    const computed = new Set<string>(GOAL_MODE_COMPUTED_CRITERIA);
    expect(Object.keys(GOAL_MODE_TRIGGER_CENSUS).filter((key) => computed.has(key))).toEqual([]);
  });
});
