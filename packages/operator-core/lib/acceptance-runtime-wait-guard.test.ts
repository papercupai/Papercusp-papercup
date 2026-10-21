/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-003/P-006 — a deploy wait is challenged
 * when the caller's held live acceptance bars are measured on another runtime.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  acceptancePlaneAdvisoryForWait,
  buildAcceptancePlaneAdvisory,
  deployWaitPipeline,
  goalNamesDeployWait,
  isDeployWaitEvent,
  isDeployWaitEventForHarness,
  loadHeldLiveBars,
  mainWaitAdvisoryForWait,
  mainWaitPlanReviewForWait,
  planSlugsNamedIn,
  reviewMainWaitPlan,
  workItemIdsNamedIn,
  type MainWaitPlanSnapshot,
  type WaitGuardDeps,
} from './acceptance-runtime-wait-guard';

const BG_PATH = 'packages/operator-core/lib/harness/routines/psu-pty-host-events-ingest.ts';

it('routes an external acceptance runtime to the existing vintage registry, never an operator test route', async () => {
  const runtime = 'runtime-vintage:papercusp-workspace/portal-web@builder' as const;
  const bars = await loadHeldLiveBars('su-x', deps([{ key: 'r-1', evidencePlane: 'live', evidenceRuntime: runtime }]));
  expect(bars[0]?.resolution.runtime).toBe(runtime);
  const advisory = buildAcceptancePlaneAdvisory(bars);
  expect(advisory).toContain(runtime);
  expect(advisory).toContain('deploys:vintage');
  expect(advisory).toContain('if absent or unmeasured, keep acceptance unknown');
  expect(advisory).not.toContain('http://127.0.0.1:3170');
  expect(advisory).not.toContain('Current-build test route(s)');
});

const deps = (criteria: Awaited<ReturnType<WaitGuardDeps['acceptanceCriteria']>>): WaitGuardDeps & { reads: number } => {
  const d = {
    reads: 0,
    heldPlanSlugs: async () => ['psu-pty-plan'],
    acceptanceCriteria: async () => {
      d.reads += 1;
      return criteria;
    },
  };
  return d;
};

describe('deploy-wait detection', () => {
  it('matches release-deploy event keys only', () => {
    expect(isDeployWaitEvent('release:deployed')).toBe(true);
    expect(isDeployWaitEvent('release:deployed:papercusp')).toBe(true);
    expect(isDeployWaitEvent('release:deploy-failed')).toBe(true);
    expect(isDeployWaitEvent('deploy:await')).toBe(true);
    expect(isDeployWaitEvent('release:green:papercusp')).toBe(true);
    expect(isDeployWaitEvent('green-checkpoint:red:papercusp')).toBe(true);
    expect(isDeployWaitEvent('green-checkpoint:held:papercusp')).toBe(true);
    expect(isDeployWaitEvent('work-item:done:WI-1')).toBe(false);
    expect(isDeployWaitEvent('release:green')).toBe(true);
    expect(isDeployWaitEvent(null)).toBe(false);
  });

  it('matches loop goals waiting on main/:3070/a deploy, not ordinary uses of "main"', () => {
    expect(goalNamesDeployWait('Wait for the fix to reach green main, then grade R-3')).toBe(true);
    expect(goalNamesDeployWait('re-check :3070 serves the fix')).toBe(true);
    expect(goalNamesDeployWait('waiting on the deploy before acceptance')).toBe(true);
    expect(goalNamesDeployWait('wait for the green-checkpoint verdict before continuing')).toBe(true);
    expect(goalNamesDeployWait('finish once it lands on main')).toBe(true);
    expect(goalNamesDeployWait('the main risk is the parser; fix it')).toBe(false);
    expect(goalNamesDeployWait('Carry plan X to shipped')).toBe(false);
  });

  it('keeps a different pot gate out of the Papercusp main-wait guard', () => {
    expect(deployWaitPipeline('release:green:slack-asana-bug-drill')).toBe('slack-asana-bug-drill');
    expect(deployWaitPipeline('green-checkpoint:red:papercusp')).toBe('papercusp');
    expect(deployWaitPipeline('release:deployed:abc123')).toBeNull();
    expect(isDeployWaitEventForHarness('release:green:papercusp', 'papercusp')).toBe(true);
    expect(isDeployWaitEventForHarness('release:green:slack-asana-bug-drill', 'papercusp')).toBe(false);
    expect(isDeployWaitEventForHarness('release:green', 'papercusp')).toBe(true);
  });

  it('allows checkpoint development goals that name the system without waiting for a live verdict', () => {
    expect(goalNamesDeployWait('Continue green-main-cycle-time work; implement P-014 replay canary on the current build')).toBe(false);
    expect(goalNamesDeployWait('Implement green-checkpoint replay canary and run its focused tests')).toBe(false);
    expect(goalNamesDeployWait('Fix the green main watchdog sources and verify locally')).toBe(false);
    expect(goalNamesDeployWait('Monitor green-checkpoint until the verdict is green')).toBe(true);
    expect(goalNamesDeployWait('Finish after green main receives the fix')).toBe(true);
  });
});

describe('plan frontier before a main wait', () => {
  const item = (
    id: string,
    effectiveStatus: string,
    blockedBy: string[] = [],
    extra: Partial<MainWaitPlanSnapshot['items'][number]> = {},
  ): MainWaitPlanSnapshot['items'][number] => ({
    id,
    text: `Implement ${id} on staging`,
    effectiveStatus,
    blockedBy,
    linkedBlocked: false,
    liveHeld: false,
    heldByCaller: false,
    ...extra,
  });
  const reason = 'deployed-only rollback target; staging cannot exercise the released artifact because its live pin differs';

  it('keeps independent B and C visible even when A has a genuine deployed-only reason', () => {
    const snapshot: MainWaitPlanSnapshot = {
      slug: 'plan-a',
      items: [
        item('P-001', 'blocked', [], { heldByCaller: true, text: 'Verify released artifact on main' }),
        item('P-002', 'todo'),
        item('P-003', 'blocked', ['P-002']),
      ],
    };
    const review = reviewMainWaitPlan(snapshot, reason);
    expect(review).toMatchObject({ allowWait: false, readyItems: ['P-002'], downstreamItems: [] });
    expect(review?.message).toContain('Continue or hand off');
  });

  it('surfaces the full A -> B -> C chain for semantic dependency review', () => {
    const snapshot: MainWaitPlanSnapshot = {
      slug: 'plan-a',
      items: [
        item('P-001', 'blocked', [], { heldByCaller: true, text: 'Verify released artifact on main' }),
        item('P-002', 'blocked', ['P-001']),
        item('P-003', 'blocked', ['P-002']),
      ],
    };
    const review = reviewMainWaitPlan(snapshot, reason);
    expect(review?.allowWait).toBe(false);
    expect(review?.downstreamItems).toEqual([
      { item: 'P-002', path: ['P-001', 'P-002'] },
      { item: 'P-003', path: ['P-001', 'P-002', 'P-003'] },
    ]);
    expect(review?.message).toContain('plans:set-item-blocked-by');
    expect(reviewMainWaitPlan(snapshot, `${reason}; P-002 and P-003 need the released artifact`)).toMatchObject({ allowWait: true });
  });

  it('allows a narrowly justified final release wait when no other work remains', () => {
    const snapshot: MainWaitPlanSnapshot = {
      slug: 'plan-a',
      items: [item('P-001', 'blocked', [], { heldByCaller: true, text: 'Verify released artifact on main' })],
    };
    expect(reviewMainWaitPlan(snapshot, reason)).toMatchObject({ allowWait: true, readyItems: [] });
    expect(reviewMainWaitPlan(snapshot, 'wait for main')).toMatchObject({ allowWait: false, reasonAccepted: false });
    expect(reviewMainWaitPlan({ ...snapshot, items: [item('P-001', 'todo', [], { text: 'Verify released artifact on main' })] }, reason))
      .toMatchObject({ allowWait: true, readyItems: [] });
  });

  it('names the missing predicate when a deployed wait reason is refused', () => {
    const snapshot: MainWaitPlanSnapshot = {
      slug: 'plan-a',
      items: [item('P-001', 'blocked', [], { heldByCaller: true, text: 'Verify released artifact on main' })],
    };
    const review = reviewMainWaitPlan(
      snapshot,
      'deployed-only R-4 serving provenance; staging cannot exercise the released artifact',
    );
    expect(review).toMatchObject({ allowWait: false, reasonAccepted: false });
    expect(review?.message).toContain("'deployed-only' token: present");
    expect(review?.message).toContain('staging limitation: present');
    expect(review?.message).toContain('concrete reason: MISSING');
    expect(reviewMainWaitPlan(snapshot, `${reason}; because its live pin differs`))
      .toMatchObject({ allowWait: true, reasonAccepted: true });
  });

  it('does not offer an item held back by the plan spec gate as staging-ready', () => {
    const snapshot: MainWaitPlanSnapshot = {
      slug: 'plan-a',
      specTriadGated: true,
      items: [item('P-001', 'todo')],
    };
    expect(reviewMainWaitPlan(snapshot, reason)).toMatchObject({ readyItems: [], allowWait: false });
  });

  it('finds A before downstream IDs mentioned in a leader explanation', () => {
    const snapshot: MainWaitPlanSnapshot = {
      slug: 'plan-a',
      items: [
        item('P-001', 'blocked', [], { text: 'Wait for release on main' }),
        item('P-002', 'blocked', ['P-001']),
        item('P-003', 'blocked', ['P-002']),
      ],
    };
    expect(reviewMainWaitPlan(snapshot, `${reason}; P-002 and P-003 need the released artifact`))
      .toMatchObject({ waitRoots: ['P-001'], allowWait: true });
  });

  it('does not turn gate repair into an implementation wait refusal', () => {
    const snapshot: MainWaitPlanSnapshot = {
      slug: 'restore-main-green',
      items: [item('P-001', 'blocked', [], { heldByCaller: true, text: 'Repair the green-checkpoint gate-red verdict' })],
    };
    expect(reviewMainWaitPlan(snapshot, 'wait for main green')).toBeNull();
    expect(reviewMainWaitPlan({
      ...snapshot,
      items: [item('P-001', 'blocked', [], { heldByCaller: true, text: 'Wait for green-checkpoint before verifying a feature' })],
    }, 'wait for main green')).toMatchObject({ allowWait: false });
  });

  it('does not read the plan for unrelated awaits', async () => {
    let reads = 0;
    const d: WaitGuardDeps = {
      ...deps([]),
      planSnapshot: async () => {
        reads += 1;
        return { slug: 'plan-a', items: [item('P-001', 'todo')] };
      },
    };
    expect(await mainWaitPlanReviewForWait({ ownerId: 'su-x', event: 'work-item:done:WI-1' }, d)).toBeNull();
    expect(reads).toBe(0);
    expect(await mainWaitPlanReviewForWait({ ownerId: 'su-x', event: 'release:green' }, d)).toMatchObject({ allowWait: false });
    expect(reads).toBe(1);
  });

  it('does not read the plan for a gate belonging to another pipeline', async () => {
    let reads = 0;
    const d: WaitGuardDeps = {
      ...deps([]),
      planSnapshot: async () => {
        reads += 1;
        return { slug: 'plan-a', items: [item('P-001', 'todo')] };
      },
    };
    expect(
      await mainWaitPlanReviewForWait(
        { ownerId: 'su-x', event: 'release:green:slack-asana-bug-drill', harnessSlug: 'papercusp' },
        d,
      ),
    ).toBeNull();
    expect(reads).toBe(0);
    expect(
      await mainWaitPlanReviewForWait(
        { ownerId: 'su-x', event: 'release:green:papercusp', harnessSlug: 'papercusp' },
        d,
      ),
    ).toMatchObject({ allowWait: false });
    expect(reads).toBe(1);
  });
});

describe('advisory construction', () => {
  it('names the non-release runtime of each held live bar', async () => {
    const bars = await loadHeldLiveBars(
      'su-x',
      deps([
        { key: 'r-1', barKey: 'R-1', evidencePlane: 'live', evidenceRuntime: 'bg-host' },
        { key: 'r-3', barKey: 'R-3', evidencePlane: 'live', method: `census rows from ${BG_PATH}` },
        { key: 'r-2', barKey: 'R-2', evidencePlane: 'tree' },
      ]),
    );
    expect(bars.map((b) => b.barKey)).toEqual(['R-1', 'R-3']);
    const advisory = buildAcceptancePlaneAdvisory(bars);
    expect(advisory).toMatch(/bg-host: psu-pty-plan#R-1/);
    expect(advisory).toMatch(/psu-pty-plan#R-3: runtime unknown/);
    expect(advisory).toMatch(/read the BAR method/);
    expect(advisory).not.toMatch(/bg-host: psu-pty-plan#R-1, psu-pty-plan#R-3/);
    expect(advisory).not.toContain('None of your held bars needs the release operator');
    expect(advisory).toMatch(/background-federation: node scripts\/with-test-pg\.mjs --isolated-runtime/);
    expect(advisory).toMatch(/Disposable migrated DB, HOME\/device keychain/);
    expect(advisory).toMatch(/Registered anyway/);
  });

  it('is silent when every held live bar really is measured on the release operator', async () => {
    const bars = await loadHeldLiveBars(
      'su-x',
      deps([{ key: 'r-1', barKey: 'R-1', evidencePlane: 'deployed', evidenceRuntime: 'release-operator' }]),
    );
    expect(buildAcceptancePlaneAdvisory(bars)).toBeNull();
  });

  it('is silent with no held live bars, or only unresolved ones', async () => {
    expect(buildAcceptancePlaneAdvisory([])).toBeNull();
    const bars = await loadHeldLiveBars('su-x', deps([{ key: 'r-1', evidencePlane: 'live', method: 'eyeball it' }]));
    expect(buildAcceptancePlaneAdvisory(bars)).toBeNull();
  });

  it('names the release-operator bars that DO need main alongside the ones that do not', async () => {
    const bars = await loadHeldLiveBars(
      'su-x',
      deps([
        { key: 'r-1', barKey: 'R-1', evidencePlane: 'live', evidenceRuntime: 'staging-operator' },
        { key: 'r-9', barKey: 'R-9', evidencePlane: 'deployed', evidenceRuntime: 'release-operator' },
      ]),
    );
    expect(buildAcceptancePlaneAdvisory(bars)).toMatch(/Only psu-pty-plan#R-9 genuinely need the release operator/);
    expect(buildAcceptancePlaneAdvisory(bars)).toMatch(/operator-api: http:\/\/127\.0\.0\.1:3170/);
  });

  it('respects a BAR method that explicitly requires :3070 while treating path-only inference as unknown', async () => {
    const bars = await loadHeldLiveBars(
      'su-x',
      deps([
        {
          key: 'r-1', barKey: 'R-1', evidencePlane: 'deployed',
          method: `Compare bytes in the deployed :3070 release checkout for packages/operator-core/lib/agent-tools/plans/get.ts`,
        },
        {
          key: 'r-2', barKey: 'R-2', evidencePlane: 'live',
          method: 'Call the tool implemented in packages/operator-core/lib/agent-tools/plans/get.ts',
        },
        { key: 'r-3', barKey: 'R-3', evidencePlane: 'live', evidenceRuntime: 'bg-host' },
      ]),
    );
    expect(bars[0]?.resolution.runtime).toBe('release-operator');
    const advisory = buildAcceptancePlaneAdvisory(bars);
    expect(advisory).toMatch(/psu-pty-plan#R-2: runtime unknown/);
    expect(advisory).toMatch(/Only psu-pty-plan#R-1 genuinely need the release operator/);
    expect(advisory).not.toContain('staging-operator: psu-pty-plan#R-2');
  });
});

describe('mainWaitAdvisoryForWait — every main wait gets the reminder (WI-6554700010014960)', () => {
  const open = (id: string, text = `Implement ${id} on staging`): MainWaitPlanSnapshot['items'][number] => ({
    id,
    text,
    effectiveStatus: 'todo',
    blockedBy: [],
    linkedBlocked: false,
    liveHeld: false,
    heldByCaller: false,
  });
  const plansDeps = (
    related: string[],
    snapshots: Record<string, MainWaitPlanSnapshot>,
  ): WaitGuardDeps & { relatedCalls: string[] } => {
    const d = {
      ...deps([]),
      relatedCalls: [] as string[],
      planSnapshot: async () => null,
      relatedPlanSlugs: async (_ownerId: string, text: string) => {
        d.relatedCalls.push(text);
        return related;
      },
      planSnapshotForSlug: async (_ownerId: string, slug: string) => snapshots[slug] ?? null,
    };
    return d;
  };

  it('extracts dated plan slugs and work-item ids from a wait note', () => {
    const note = 'On fire: gate-test-reuse-yield-2026-10-01 P-008 (WI-10004719) and EI-25911343611632456; not main-ish-word.';
    expect(planSlugsNamedIn(note)).toEqual(['gate-test-reuse-yield-2026-10-01']);
    expect(workItemIdsNamedIn(note)).toEqual(['WI-10004719', 'EI-25911343611632456']);
  });

  it('gives an agent with no plan anywhere the generic reminder instead of silence', async () => {
    const advisory = await mainWaitAdvisoryForWait({ ownerId: 'su-x', event: 'release:green:papercusp', harnessSlug: 'papercusp' }, plansDeps([], {}));
    expect(advisory).toMatch(/MAIN-WAIT ADVISORY/);
    expect(advisory).toContain('No plan was found');
    expect(advisory).toContain('do it now');
    expect(advisory).toContain('advice, not a refusal');
  });

  it('names staging-ready items of plans found outside presence (held work-items, the note)', async () => {
    const d = plansDeps(['plan-a-2026-10-01', 'plan-b-2026-10-02', 'missing-2026-10-03'], {
      'plan-a-2026-10-01': { slug: 'plan-a-2026-10-01', items: [open('P-006'), open('P-008')] },
      'plan-b-2026-10-02': { slug: 'plan-b-2026-10-02', items: [{ ...open('P-005'), liveHeld: true }] },
    });
    const note = 'carry plans; WI-10007221 needs the deployed check';
    const advisory = await mainWaitAdvisoryForWait({ ownerId: 'su-x', event: 'release:green:papercusp', harnessSlug: 'papercusp', note }, d);
    expect(d.relatedCalls).toEqual([note]);
    expect(advisory).toContain('plan-a-2026-10-01 (2 open; staging-ready: P-006, P-008)');
    expect(advisory).not.toContain('plan-b-2026-10-02 (1 open; staging-ready');
    expect(advisory).not.toContain('missing-2026-10-03');
  });

  it('stays silent for a non-main wait and for the fixer operating the gate', async () => {
    const d = plansDeps(['plan-a-2026-10-01'], { 'plan-a-2026-10-01': { slug: 'plan-a-2026-10-01', items: [open('P-001')] } });
    expect(await mainWaitAdvisoryForWait({ ownerId: 'su-x', event: 'work-item:done:WI-1', harnessSlug: 'papercusp' }, d)).toBeNull();
    expect(
      await mainWaitAdvisoryForWait(
        { ownerId: 'su-x', event: 'release:green:papercusp', harnessSlug: 'papercusp', note: 'repair the green-checkpoint gate red and rerun' },
        d,
      ),
    ).toBeNull();
    expect(d.relatedCalls).toEqual([]);
  });

  it('degrades to the generic reminder when plan discovery fails', async () => {
    const broken: WaitGuardDeps = {
      ...deps([]),
      relatedPlanSlugs: async () => {
        throw new Error('pool exhausted');
      },
      planSnapshotForSlug: async () => null,
    };
    // withBoundedTimeout reports the swallowed read failure; that warning is the expected trace.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(mainWaitAdvisoryForWait({ ownerId: 'su-x', event: 'release:green', harnessSlug: 'papercusp' }, broken)).resolves.toContain(
        'No plan was found',
      );
      expect(warn.mock.calls.some((call) => String(call[0]).includes('main-wait-advisory'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('acceptancePlaneAdvisoryForWait — the call events:await and loop:arm make', () => {
  const live = [{ key: 'r-1', barKey: 'R-1', evidencePlane: 'live' as const, evidenceRuntime: 'bg-host' as const }];

  it('advises on a release:deployed await and on a deploy-shaped loop goal', async () => {
    expect(await acceptancePlaneAdvisoryForWait({ ownerId: 'su-x', event: 'release:deployed', harnessSlug: 'papercusp' }, deps(live))).toMatch(
      /ACCEPTANCE-PLANE ADVISORY/,
    );
    expect(
      await acceptancePlaneAdvisoryForWait({ ownerId: 'su-x', goal: 'wait for green main then grade', harnessSlug: 'papercusp' }, deps(live)),
    ).toMatch(/bg-host/);
  });

  it('does no I/O at all for a wait that is not deploy-shaped', async () => {
    const d = deps(live);
    expect(await acceptancePlaneAdvisoryForWait({ ownerId: 'su-x', event: 'work-item:done:WI-1', harnessSlug: 'papercusp' }, d)).toBeNull();
    expect(d.reads).toBe(0);
  });

  it('never throws — a failing read degrades to no advisory, never a refused wait', async () => {
    const broken: WaitGuardDeps = {
      heldPlanSlugs: async () => {
        throw new Error('presence down');
      },
      acceptanceCriteria: async () => null,
    };
    await expect(acceptancePlaneAdvisoryForWait({ ownerId: 'su-x', event: 'release:deployed', harnessSlug: 'papercusp' }, broken)).resolves.toBeNull();
    await expect(acceptancePlaneAdvisoryForWait({ ownerId: null, event: 'release:deployed', harnessSlug: 'papercusp' }, deps(live))).resolves.toBeNull();
  });
});
