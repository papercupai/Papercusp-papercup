/**
 * R-23 (spec-driven-tooling-integration-2026-10-05 P-031): conformance runs continuously —
 * an enabled recurring `spec-conformance-sweep` routine exists, and the sweep runs a plan on
 * commit (footprint), on work-item transitions and on a schedule.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getSystemActionEntry } from '../harness/routines/system-actions';
import { BESPOKE_ACTIVE_SEEDS } from '../harness/routines/bespoke-active-seeds-check';
import type { ConformanceRunOutcome } from './conformance-run';
import {
  SPEC_CONFORMANCE_SWEEP_ACTION,
  SPEC_CONFORMANCE_SWEEP_INTERVAL_SEC,
  SPEC_CONFORMANCE_SWEEP_TARGET_ROLE,
  runSpecConformanceSweep,
  runSpecConformanceSweepAction,
  selectSweepRuns,
  specConformanceSweepRoutineRow,
  sweepTriggersFor,
  type SpecConformanceSweepDeps,
  type SweepPlan,
  type SweepWatermark,
} from './sweep-action';

const ROUTINES_DIR = join(__dirname, '..', 'harness', 'routines');
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const HOUR = 3600_000;
const iso = (t: number) => new Date(t).toISOString();
const wm = (over: Partial<SweepWatermark> = {}): SweepWatermark => ({
  lastRunAt: iso(NOW - HOUR),
  footprintHeadSha: 'sha-old',
  lastTransitionAt: iso(NOW - 2 * HOUR),
  ...over,
});

describe('trigger selection (R-23)', () => {
  const interval = 6 * 3600;

  it('never-run when there is no watermark', () => {
    expect(sweepTriggersFor({ key: 'h/p', watermark: null, footprintChanged: false, lastTransitionAt: null }, NOW, interval)).toEqual(['never-run']);
  });

  it('footprint-changed on a commit inside the footprint (the on-commit leg)', () => {
    expect(sweepTriggersFor({ key: 'h/p', watermark: wm(), footprintChanged: true, lastTransitionAt: iso(NOW - 2 * HOUR) }, NOW, interval)).toEqual([
      'footprint-changed',
    ]);
  });

  it('work-item-transitioned only when a transition is NEWER than the watermark', () => {
    const base = { key: 'h/p', watermark: wm(), footprintChanged: false };
    expect(sweepTriggersFor({ ...base, lastTransitionAt: iso(NOW - 30 * 60_000) }, NOW, interval)).toEqual(['work-item-transitioned']);
    expect(sweepTriggersFor({ ...base, lastTransitionAt: iso(NOW - 2 * HOUR) }, NOW, interval)).toEqual([]);
  });

  it('rechecks a plan whose prior conformance result still reported drift', () => {
    const candidate = {
      key: 'h/p',
      watermark: wm({ lastOutcome: { drifting: ['R-8'] } }),
      footprintChanged: false,
      lastTransitionAt: iso(NOW - 2 * HOUR),
    };
    expect(sweepTriggersFor(candidate, NOW, interval)).toEqual(['previously-drifting']);
  });

  it('retries a plan whose prior sweep failed before recording conformance', () => {
    const candidate = {
      key: 'h/p',
      watermark: wm({ lastOutcome: { error: 'work-item hold prevented reconciliation' } }),
      footprintChanged: false,
      lastTransitionAt: iso(NOW - 2 * HOUR),
    };
    expect(sweepTriggersFor(candidate, NOW, interval)).toEqual(['previous-run-failed']);
  });

  it('does not treat a clean prior result as a drift trigger', () => {
    const candidate = {
      key: 'h/p',
      watermark: wm({ lastOutcome: { drifting: [] } }),
      footprintChanged: false,
      lastTransitionAt: iso(NOW - 2 * HOUR),
    };
    expect(sweepTriggersFor(candidate, NOW, interval)).toEqual([]);
  });

  it('interval-elapsed once the per-plan interval passes, and idle before it', () => {
    const stale = { key: 'h/p', watermark: wm({ lastRunAt: iso(NOW - 7 * HOUR) }), footprintChanged: false, lastTransitionAt: null };
    expect(sweepTriggersFor(stale, NOW, interval)).toEqual(['interval-elapsed']);
    expect(sweepTriggersFor({ ...stale, watermark: wm() }, NOW, interval)).toEqual([]);
  });

  it('caps runs per tick, never-run first, then event triggers, then interval-only; defers the rest', () => {
    const selection = selectSweepRuns(
      [
        { key: 'h/interval', watermark: wm({ lastRunAt: iso(NOW - 9 * HOUR) }), footprintChanged: false, lastTransitionAt: null },
        { key: 'h/commit', watermark: wm(), footprintChanged: true, lastTransitionAt: null },
        { key: 'h/new', watermark: null, footprintChanged: false, lastTransitionAt: null },
        { key: 'h/quiet', watermark: wm(), footprintChanged: false, lastTransitionAt: null },
      ],
      { nowMs: NOW, planIntervalSec: interval, maxRunsPerTick: 2 },
    );
    expect(selection.selected.map((s) => s.key)).toEqual(['h/new', 'h/commit']);
    expect(selection.deferred).toEqual([{ key: 'h/interval', triggers: ['interval-elapsed'] }]);
    expect(selection.idle).toEqual(['h/quiet']);
  });

  it('retry triggers wait out the retry backoff since the last run (WI-6554700010019378)', () => {
    const recent = (lastOutcome: SweepWatermark['lastOutcome'], ago: number) => ({
      key: 'h/p',
      watermark: wm({ lastRunAt: iso(NOW - ago), lastOutcome }),
      footprintChanged: false,
      lastTransitionAt: iso(NOW - 2 * HOUR),
    });
    const failed = { error: 'column "slug" does not exist' };
    const drifting = { drifting: ['R-8'] };
    // Ran one tick ago: neither retry trigger fires yet.
    expect(sweepTriggersFor(recent(failed, 15 * 60_000), NOW, interval, 3600)).toEqual([]);
    expect(sweepTriggersFor(recent(drifting, 15 * 60_000), NOW, interval, 3600)).toEqual([]);
    // Backoff elapsed: both fire.
    expect(sweepTriggersFor(recent(failed, HOUR), NOW, interval, 3600)).toEqual(['previous-run-failed']);
    expect(sweepTriggersFor(recent(drifting, HOUR), NOW, interval, 3600)).toEqual(['previously-drifting']);
    // A transition still fires immediately, backoff or not.
    expect(
      sweepTriggersFor({ ...recent(failed, 15 * 60_000), lastTransitionAt: iso(NOW - 5 * 60_000) }, NOW, interval, 3600),
    ).toEqual(['work-item-transitioned']);
  });

  it('persistently failing plans cannot starve the interval tier (measured 2026-10-21 regression)', () => {
    // 8 plans that fail deterministically, last run one backoff ago, plus ~overdue interval plans.
    const failing = Array.from({ length: 8 }, (_, i) => ({
      key: `h/failing-${i}`,
      watermark: wm({ lastRunAt: iso(NOW - HOUR - i * 60_000), lastOutcome: { error: 'column "slug" does not exist' } }),
      footprintChanged: false,
      lastTransitionAt: iso(NOW - 2 * HOUR),
    }));
    const starvedOld = { key: 'h/starved-old', watermark: wm({ lastRunAt: iso(NOW - 72 * HOUR) }), footprintChanged: false, lastTransitionAt: null };
    const starvedNew = { key: 'h/starved-new', watermark: wm({ lastRunAt: iso(NOW - 13 * HOUR) }), footprintChanged: false, lastTransitionAt: null };
    const dueNotStarved = { key: 'h/due', watermark: wm({ lastRunAt: iso(NOW - 7 * HOUR) }), footprintChanged: false, lastTransitionAt: null };
    const selection = selectSweepRuns([...failing, starvedNew, dueNotStarved, starvedOld], {
      nowMs: NOW,
      planIntervalSec: interval,
      maxRunsPerTick: 4,
      retryBackoffSec: 3600,
    });
    const keys = selection.selected.map((s) => s.key);
    expect(keys).toHaveLength(4);
    // The floor slot goes to the OLDEST starved interval-only plan.
    expect(keys[3]).toBe('h/starved-old');
    expect(keys.slice(0, 3).every((k) => k.startsWith('h/failing-'))).toBe(true);
    // The bumped retry plan leads the deferred queue; nothing is dropped.
    expect(selection.deferred[0].key.startsWith('h/failing-')).toBe(true);
    expect(selection.selected.length + selection.deferred.length).toBe(11);

    // One tick later the plans that just ran are inside the backoff and drop out entirely.
    const ranAt = NOW + 15 * 60_000;
    const after = [
      ...failing.map((c) => (keys.includes(c.key) ? { ...c, watermark: wm({ ...c.watermark, lastRunAt: iso(NOW) }) } : c)),
      { ...starvedOld, watermark: wm({ lastRunAt: iso(NOW) }) },
      starvedNew,
      dueNotStarved,
    ];
    const next = selectSweepRuns(after, { nowMs: ranAt, planIntervalSec: interval, maxRunsPerTick: 4, retryBackoffSec: 3600 });
    const nextKeys = next.selected.map((s) => s.key);
    expect(nextKeys.filter((k) => keys.includes(k))).toEqual([]);
    expect(nextKeys).toContain('h/starved-new');
  });

  it('reserves no floor slot when the cap is 1 or no interval-only plan is starved', () => {
    const event = { key: 'h/event', watermark: wm(), footprintChanged: true, lastTransitionAt: null };
    const starved = { key: 'h/starved', watermark: wm({ lastRunAt: iso(NOW - 72 * HOUR) }), footprintChanged: false, lastTransitionAt: null };
    const one = selectSweepRuns([event, starved], { nowMs: NOW, planIntervalSec: interval, maxRunsPerTick: 1 });
    expect(one.selected.map((s) => s.key)).toEqual(['h/event']);
    const notStarved = { ...starved, watermark: wm({ lastRunAt: iso(NOW - 7 * HOUR) }) };
    const events = [event, { ...event, key: 'h/event-2' }];
    const two = selectSweepRuns([...events, notStarved], { nowMs: NOW, planIntervalSec: interval, maxRunsPerTick: 2 });
    expect(two.selected.map((s) => s.key)).toEqual(['h/event', 'h/event-2']);
    expect(two.deferred.map((s) => s.key)).toEqual(['h/starved']);
  });
});

const REQ = (key: string) =>
  `**${key} — Req.**\n\`\`\`requirement\n${JSON.stringify({
    intent: { request: 'r', sourceRefs: ['owner directive #1'] },
    acceptance: { condition: 'c', falsifier: 'f', requiredTestLayers: ['unit'], passRatings: ['healthy'] },
    verification: { method: 'm', check: { kind: 'tests', files: ['x.test.ts'] } },
  })}\n\`\`\``;
const planContent = (footprint?: string[]) =>
  `## Requirements\n\n${REQ('R-1')}\n\n` +
  (footprint ? `## Conformance\n\n\`\`\`conformance\n${JSON.stringify({ footprint: { paths: footprint } })}\n\`\`\`\n\n` : '') +
  `## Phase 1\n\n- **P-001** \`todo\` x.\n\n## Decisions\n`;

const runOutcome = (planSlug: string): ConformanceRunOutcome => ({
  planSlug,
  harnessSlug: 'h',
  ledgerRef: 'l',
  applicable: true,
  contractProblems: [],
  executed: 1,
  testRunIds: [1],
  requirements: [],
  unbound: [],
  unevaluable: [],
  alarmsOpened: [],
  alarmsClosed: [],
});

function fakeDeps(over: Partial<SpecConformanceSweepDeps> & { plans: SweepPlan[]; watermarks?: Map<string, SweepWatermark> }) {
  const writes: Array<Record<string, unknown>> = [];
  let transitionReads = 0;
  const deps: SpecConformanceSweepDeps = {
    listPlans: async () => over.plans,
    readWatermarks: async () => over.watermarks ?? new Map(),
    lastTransitions: async () => {
      transitionReads += 1;
      return new Map([['h/with-footprint', iso(NOW - (transitionReads > 1 ? 1 : 2) * 60_000)]]);
    },
    footprintWindow: vi.fn(async () => ({ headSha: 'sha-new', commits: [{ sha: 'c1', paths: ['src/feature/a.ts'] }] })),
    runConformance: vi.fn(async (plan: SweepPlan) => runOutcome(plan.planSlug)),
    reconcileFootprint: vi.fn(async () => ({
      ok: true as const,
      declared: true,
      globs: ['src/feature/**'],
      sinceSha: 'sha-old',
      headSha: 'sha-new',
      commitsScanned: 1,
      covered: [],
      uncovered: [],
      finding: { action: 'none' as const, id: null },
    })),
    writeWatermark: async (row) => {
      writes.push(row as unknown as Record<string, unknown>);
    },
    now: () => NOW,
    ...over,
  };
  return { deps, writes };
}

describe('sweep orchestration (R-23)', () => {
  it('runs only the requested harness/plan even when idle and the tick cap is zero', async () => {
    const target = { planSlug: 'requested', harnessSlug: 'h', content: planContent(['src/feature/**']) };
    const others = [
      { planSlug: 'other', harnessSlug: 'h', content: planContent(['src/feature/**']) },
      { planSlug: 'requested', harnessSlug: 'another-harness', content: planContent(['src/feature/**']) },
    ];
    const watermarks = new Map([
      ['h/requested', wm()], ['h/other', wm()], ['another-harness/requested', wm()],
    ]);
    const before = new Map(watermarks);
    const lastTransitions = vi.fn(async (_plans: ReadonlyArray<SweepPlan>) => new Map<string, string | null>());
    const { deps, writes } = fakeDeps({
      plans: [...others, target], watermarks, lastTransitions,
      footprintWindow: vi.fn(async () => ({ headSha: 'sha-new', commits: [] })),
      writeWatermark: async (row) => {
        writes.push(row as unknown as Record<string, unknown>);
        watermarks.set(`${row.harnessSlug}/${row.planSlug}`, row);
      },
    });
    const out = await runSpecConformanceSweep({ target, maxRunsPerTick: 0 }, deps);
    expect(out.ran).toEqual([expect.objectContaining({ key: 'h/requested', triggers: ['requested'], ok: true })]);
    expect(out.scanned).toBe(1);
    expect(out.deferred).toEqual([]);
    expect(deps.runConformance).toHaveBeenCalledExactlyOnceWith(target);
    expect(deps.reconcileFootprint).toHaveBeenCalledExactlyOnceWith(target, 'sha-old', { headSha: 'sha-new', commits: [] });
    expect(deps.footprintWindow).toHaveBeenCalledExactlyOnceWith(target, 'sha-old');
    expect(lastTransitions.mock.calls.every(([plans]) => plans.length === 1 && plans[0] === target)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(watermarks.get('h/other')).toEqual(before.get('h/other'));
    expect(watermarks.get('another-harness/requested')).toEqual(before.get('another-harness/requested'));
    expect(watermarks.get('h/requested')?.lastRunAt).toBe(iso(NOW));
  });

  it('reports a missing target without running or watermarking another plan', async () => {
    const { deps, writes } = fakeDeps({ plans: [{ planSlug: 'other', harnessSlug: 'h', content: planContent() }] });
    const out = await runSpecConformanceSweep({ target: { harnessSlug: 'h', planSlug: 'missing' } }, deps);
    expect(out.skipped).toEqual([{ key: 'h/missing', reason: 'plan-not-found' }]);
    expect(out.ran).toEqual([]);
    expect(deps.runConformance).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('runs a plan whose footprint changed, reconciles the footprint, and advances the watermark', async () => {
    const { deps, writes } = fakeDeps({
      plans: [
        { planSlug: 'with-footprint', harnessSlug: 'h', content: planContent(['src/feature/**']) },
        { planSlug: 'bare', harnessSlug: 'h', content: '## Phase 1\n\n- **P-001** `todo` x.\n' },
      ],
      watermarks: new Map([['h/with-footprint', wm({ lastTransitionAt: iso(NOW - 2 * 60_000) })]]),
    });
    const out = await runSpecConformanceSweep({}, deps);
    expect(out.skipped).toEqual([{ key: 'h/bare', reason: 'no-requirements' }]);
    expect(out.ran.map((r) => [r.key, r.triggers, r.ok])).toEqual([['h/with-footprint', ['footprint-changed'], true]]);
    expect(deps.reconcileFootprint).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    // Head advances to the scanned window; the transition watermark is the POST-run reading.
    expect(writes[0]).toMatchObject({ footprintHeadSha: 'sha-new', lastTransitionAt: iso(NOW - 60_000), triggers: ['footprint-changed'] });
  });

  it('does not run an untriggered plan, and records a failing run without throwing', async () => {
    const quiet = fakeDeps({
      plans: [{ planSlug: 'with-footprint', harnessSlug: 'h', content: planContent() }],
      watermarks: new Map([['h/with-footprint', wm({ lastTransitionAt: iso(NOW - 60_000) })]]),
      lastTransitions: async () => new Map([['h/with-footprint', iso(NOW - 60_000)]]),
    });
    const idle = await runSpecConformanceSweep({}, quiet.deps);
    expect(idle.ran).toEqual([]);
    expect(idle.idle).toBe(1);

    const broken = fakeDeps({
      plans: [{ planSlug: 'p', harnessSlug: 'h', content: planContent() }],
      runConformance: async () => {
        throw new Error('boom');
      },
    });
    const out = await runSpecConformanceSweep({}, broken.deps);
    expect(out.ran).toEqual([{ key: 'h/p', triggers: ['never-run'], ok: false, summary: { error: 'boom' } }]);
    expect(broken.writes).toHaveLength(1);
  });

  it('the action reads tunables from the payload template and reports diagnostics', async () => {
    const { deps } = fakeDeps({
      plans: [
        { planSlug: 'a', harnessSlug: 'h', content: planContent() },
        { planSlug: 'b', harnessSlug: 'h', content: planContent() },
      ],
    });
    const result = await runSpecConformanceSweepAction(
      { installSlug: 'home', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: { maxRunsPerTick: 1 } },
      deps,
    );
    expect(result.diagnostics).toMatchObject({ specConformanceSweep: { scanned: 2, candidates: 2, deferred: 1, failed: 0 } });
  });
});

describe('registration + seed routine (R-23)', () => {
  it('registers as a standing system action (a routine row is expected to exist)', () => {
    expect(getSystemActionEntry(SPEC_CONFORMANCE_SWEEP_ACTION)?.scheduling).toBe('standing');
    expect(SPEC_CONFORMANCE_SWEEP_TARGET_ROLE).toBe(`system:${SPEC_CONFORMANCE_SWEEP_ACTION}`);
  });

  it('the seed row is an ENABLED recurring ephemeral routine targeting the registered role', () => {
    const row = specConformanceSweepRoutineRow({ installSlug: 'operator-home', workspaceId: 'ws', active: true });
    expect(row).toMatchObject({
      name: 'spec-conformance-sweep',
      target_role: 'system:spec-conformance-sweep',
      active: true,
      tier: 'ephemeral',
      trigger_config: { interval_sec: SPEC_CONFORMANCE_SWEEP_INTERVAL_SEC },
    });
    expect(SPEC_CONFORMANCE_SWEEP_INTERVAL_SEC).toBeGreaterThan(0);
  });

  it('is wired: imported by register-system-actions, seeded by its script, listed as a bespoke active seed', () => {
    const register = readFileSync(join(ROUTINES_DIR, 'register-system-actions.ts'), 'utf8');
    expect(register).toContain(`import '../../spec-conformance/sweep-action';`);
    const seed = join(ROUTINES_DIR, 'seed-spec-conformance-sweep-routine.ts');
    expect(existsSync(seed)).toBe(true);
    expect(readFileSync(seed, 'utf8')).toContain('specConformanceSweepRoutineRow');
    const entry = BESPOKE_ACTIVE_SEEDS.find((s) => s.name === SPEC_CONFORMANCE_SWEEP_ACTION);
    expect(entry?.seedScript).toBe('seed-spec-conformance-sweep-routine.ts');
  });
});
