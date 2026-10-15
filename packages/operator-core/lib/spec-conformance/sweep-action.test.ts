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
