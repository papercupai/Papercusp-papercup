import { describe, expect, it, vi } from 'vitest';

import {
  PLAN_RUN_RECRUIT_MAX_ATTEMPTS,
  PLAN_RUN_RECRUIT_SLO_MS,
  buildPlanRunExecutorBrief,
  parsePlanRunRecruitLabel,
  planPlanRunExecutorRecruitment,
  planRunRecruitLabel,
  runPlanRunExecutorRecruiter,
  type PlanRunRecruitCandidate,
  type PlanRunRecruiterDeps,
} from './plan-run-executor-recruiter';

const NOW = Date.parse('2026-10-21T12:00:00Z');

function candidate(over: Partial<PlanRunRecruitCandidate> = {}): PlanRunRecruitCandidate {
  return {
    workspaceId: 'ws',
    runId: '1355',
    instanceSlug: 'bug-triage@run-1',
    harnessSlug: 'papercusp',
    agentName: 'bug-triage',
    workItemIds: ['WI-1'],
    mintedAtMs: NOW - PLAN_RUN_RECRUIT_SLO_MS - 1,
    adopterLive: false,
    ...over,
  };
}

function deps(over: Partial<PlanRunRecruiterDeps> = {}): PlanRunRecruiterDeps & {
  launch: ReturnType<typeof vi.fn>;
  escalate: ReturnType<typeof vi.fn>;
} {
  return {
    listCandidates: vi.fn(async () => [candidate()]),
    listLaunches: vi.fn(async () => []),
    launch: vi.fn(async () => ({ ok: true })),
    escalate: vi.fn(async () => ({ id: 'WI-esc', created: true })),
    ...over,
  } as never;
}

describe('plan-run executor recruiter (WI-6554700010019116)', () => {
  it('round-trips its ledger label', () => {
    const label = planRunRecruitLabel('bug-triage', '1355', 2);
    expect(label).toBe('plan-run-recruit:bug-triage:1355:2');
    expect(parsePlanRunRecruitLabel(label)).toEqual({ agentName: 'bug-triage', runId: '1355', attempt: 2 });
    expect(parsePlanRunRecruitLabel('admission-recruit:review:EI-1:r1:1')).toBeNull();
    expect(parsePlanRunRecruitLabel('plan-run-recruit:x')).toBeNull();
  });

  it('launches exactly one executor for a stranded run with no adopter, past the SLO', async () => {
    const d = deps();
    const r = await runPlanRunExecutorRecruiter({ nowMs: NOW }, d);
    expect(d.launch).toHaveBeenCalledTimes(1);
    const arg = d.launch.mock.calls[0][0];
    expect(arg.key).toBe('plan-run-recruit:bug-triage:1355:1');
    expect(arg.harnessSlug).toBe('papercusp');
    expect(arg.brief).toContain("plan_items:adopt_name { name: 'bug-triage' }");
    expect(arg.brief).toContain('WI-1');
    expect(r.launched).toEqual([{ runId: '1355', agentName: 'bug-triage', key: arg.key, deduped: false }]);
  });

  it('does nothing while a live session has adopted the name', () => {
    const [d] = planPlanRunExecutorRecruitment([candidate({ adopterLive: true })], [], NOW);
    expect(d.action).toBe('none');
    expect(d.reason).toBe('adopter-live');
  });

  it('waits inside the SLO, and when the mint time is unknown', () => {
    const [inside] = planPlanRunExecutorRecruitment([candidate({ mintedAtMs: NOW - 1000 })], [], NOW);
    expect(inside).toMatchObject({ action: 'wait', reason: 'within-slo' });
    const [unknown] = planPlanRunExecutorRecruitment([candidate({ mintedAtMs: null })], [], NOW);
    expect(unknown).toMatchObject({ action: 'wait', reason: 'wait-start-unknown' });
  });

  it('is idempotent: a live recruited agent for the run means in-flight, not a second launch', async () => {
    const d = deps({
      listLaunches: vi.fn(async () => [
        { label: planRunRecruitLabel('bug-triage', '1355', 1), startedAtMs: NOW - 60_000, live: true },
      ]),
    });
    const r = await runPlanRunExecutorRecruiter({ nowMs: NOW }, d);
    expect(d.launch).not.toHaveBeenCalled();
    expect(r.decisions[0]).toMatchObject({ action: 'in-flight', attempts: 1 });
  });

  it('retries once after an ended attempt, then escalates instead of spawning more', async () => {
    const ended = (n: number) => ({ label: planRunRecruitLabel('bug-triage', '1355', n), startedAtMs: NOW - 3_600_000, live: false });
    const [retry] = planPlanRunExecutorRecruitment([candidate()], [ended(1)], NOW);
    expect(retry).toMatchObject({ action: 'launch', key: 'plan-run-recruit:bug-triage:1355:2' });

    const launches = Array.from({ length: PLAN_RUN_RECRUIT_MAX_ATTEMPTS }, (_, i) => ended(i + 1));
    const d = deps({ listLaunches: vi.fn(async () => launches) });
    const r = await runPlanRunExecutorRecruiter({ nowMs: NOW }, d);
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.escalate).toHaveBeenCalledTimes(1);
    expect(d.escalate.mock.calls[0][0].key).toBe('plan-run-recruit-exhausted:1355:bug-triage');
    expect(r.escalated).toHaveLength(1);
  });

  it('does not count another run or another name against this run', () => {
    const other = [
      { label: planRunRecruitLabel('bug-triage', '9999', 1), startedAtMs: NOW, live: true },
      { label: planRunRecruitLabel('other-role', '1355', 1), startedAtMs: NOW, live: true },
    ];
    const [d] = planPlanRunExecutorRecruitment([candidate()], other, NOW);
    expect(d).toMatchObject({ action: 'launch', attempts: 0 });
  });

  it('caps launches per pass, longest-waiting first', () => {
    const cs = [
      candidate({ runId: 'a', mintedAtMs: NOW - PLAN_RUN_RECRUIT_SLO_MS - 10 }),
      candidate({ runId: 'b', mintedAtMs: NOW - PLAN_RUN_RECRUIT_SLO_MS - 30 }),
      candidate({ runId: 'c', mintedAtMs: NOW - PLAN_RUN_RECRUIT_SLO_MS - 20 }),
    ];
    const out = planPlanRunExecutorRecruitment(cs, [], NOW, { maxLaunches: 2 });
    expect(out.find((d) => d.runId === 'a')).toMatchObject({ action: 'wait', reason: 'launch-cap' });
    expect(out.filter((d) => d.action === 'launch').map((d) => d.runId).sort()).toEqual(['b', 'c']);
  });

  it('records a refused launch and never throws', async () => {
    const d = deps({ launch: vi.fn(async () => ({ ok: false, error: 'no routable provider' })) });
    const r = await runPlanRunExecutorRecruiter({ nowMs: NOW }, d);
    expect(r.failed).toEqual([{ runId: '1355', agentName: 'bug-triage', stage: 'launch', error: 'no routable provider' }]);
    expect(r.launched).toEqual([]);
  });

  it('skips launches for a workspace whose ledger cannot be read (idempotency unprovable)', async () => {
    const d = deps({ listLaunches: vi.fn(async () => { throw new Error('pg down'); }) });
    const r = await runPlanRunExecutorRecruiter({ nowMs: NOW }, d);
    expect(d.launch).not.toHaveBeenCalled();
    expect(r.failed[0]).toMatchObject({ stage: 'list', error: 'pg down' });
  });

  it('skips the ledger read entirely when no candidate could launch', async () => {
    const d = deps({ listCandidates: vi.fn(async () => [candidate({ adopterLive: true })]) });
    await runPlanRunExecutorRecruiter({ nowMs: NOW }, d);
    expect(d.listLaunches).not.toHaveBeenCalled();
  });

  it('briefs the executor to adopt the name, work only this run, and leave a blocker when stuck', () => {
    const brief = buildPlanRunExecutorBrief({
      agentName: 'bug-triage',
      runId: '1355',
      instanceSlug: 'bug-triage@run-1',
      harnessSlug: 'papercusp',
      workItemIds: ['WI-1', 'WI-2'],
    });
    expect(brief).toContain("plan_items:adopt_name { name: 'bug-triage' }");
    expect(brief).toContain('WI-1, WI-2');
    expect(brief).toContain('work_items:set_blocker');
    expect(brief).toContain('Do only this run');
  });
});
