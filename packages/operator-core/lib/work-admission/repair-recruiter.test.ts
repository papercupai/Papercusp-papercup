import { describe, expect, it } from 'vitest';
import {
  ADMISSION_RECRUIT_MAX_ATTEMPTS,
  ADMISSION_RECRUIT_REPAIR_SLO_MS,
  ADMISSION_RECRUIT_REVIEW_SLO_MS,
  ADMISSION_RECRUIT_STALE_MS,
  ADMISSION_STRANDED_SLO_MS,
  admissionStrandedConditionKey,
  parseRecruitLabel,
  planAdmissionRecruitment,
  recruitExhaustedConditionKey,
  recruitLabel,
  recruitLegFor,
  runAdmissionRecruiter,
  type AdmissionRecruitEscalation,
  type AdmissionRecruitLaunchInput,
  type AdmissionRecruiterDeps,
  type RecruitCandidate,
  type RecruitLaunchRecord,
} from './repair-recruiter';
import { DEFAULT_ADMISSION_LIFECYCLE, parseAdmissionLifecycle, resolveAdmissionLifecycle } from './lifecycle-config';

const NOW = Date.parse('2026-10-21T08:00:00.000Z');
const MIN = 60_000;

function pendingReview(round: number, enteredAgoMs: number) {
  return {
    agentReview: {
      status: 'pending',
      round,
      submittedBy: 'system:work-admission',
      ledgerIdeaId: 'idea-1',
      timing: { round, enteredAt: new Date(NOW - enteredAgoMs).toISOString() },
    },
  };
}

function approvedReview(round: number, decidedAgoMs: number) {
  return {
    agentReview: {
      status: 'approved',
      round,
      submittedBy: 'system:work-admission',
      ledgerIdeaId: 'idea-1',
      timing: { round, enteredAt: new Date(NOW - decidedAgoMs - MIN).toISOString(), decidedAt: new Date(NOW - decidedAgoMs).toISOString() },
    },
    implementationReadiness: { status: 'ready' },
  };
}

function candidate(over: Partial<RecruitCandidate> = {}): RecruitCandidate {
  return {
    workItemId: 'EI-1',
    harnessSlug: 'slack-asana-bug-drill',
    kind: 'bug',
    status: 'open',
    assignee: null,
    payload: pendingReview(1, 30 * MIN),
    title: 'quotes list is mis-ordered',
    admission: 'admitted',
    createdAtMs: NOW - 60 * MIN,
    recruit: true,
    ...over,
  };
}

describe('recruitLegFor', () => {
  it('a pending review round is the review leg, timed from the round entry', () => {
    const leg = recruitLegFor(candidate({ payload: pendingReview(2, 15 * MIN) }));
    expect(leg).toEqual({ leg: 'review', epoch: 'r2', sinceMs: NOW - 15 * MIN });
  });

  it('a pending round with no current timing falls back to the item creation time', () => {
    const payload = { agentReview: { status: 'pending', round: 3, timing: { round: 2, enteredAt: new Date(NOW).toISOString() } } };
    expect(recruitLegFor(candidate({ payload }))).toEqual({ leg: 'review', epoch: 'r3', sinceMs: NOW - 60 * MIN });
  });

  it('an approved, open, unheld bug is the repair leg, timed from the approval', () => {
    const leg = recruitLegFor(candidate({ payload: approvedReview(1, 20 * MIN) }));
    expect(leg).toEqual({ leg: 'repair', epoch: 'a1', sinceMs: NOW - 20 * MIN });
  });

  it('a pending review is recruitable while admission is still pending (the promoter holds admission on the review)', () => {
    // WI-6554700010018302 / BD016 EI-26578049744916274: the admission promoter keeps an
    // admission-rule bug at admission='pending' until its agent review clears. Skipping
    // pending admission before the review check deadlocked the item: no reviewer, no admission.
    const leg = recruitLegFor(candidate({ admission: 'pending', payload: pendingReview(1, 12 * MIN) }));
    expect(leg).toEqual({ leg: 'review', epoch: 'r1', sinceMs: NOW - 12 * MIN });
  });

  it.each([
    ['terminal', { status: 'done' }],
    ['awaiting-admission-dedup', { admission: 'pending', payload: approvedReview(1, 20 * MIN) }],
    ['awaiting-admission-dedup', { admission: 'pending', payload: {} }],
    ['held', { payload: approvedReview(1, 20 * MIN), assignee: 'su-abc' }],
    ['not-a-bug', { payload: approvedReview(1, 20 * MIN), kind: 'change' }],
    ['state-wip', { payload: approvedReview(1, 20 * MIN), status: 'wip' }],
    ['revision-requested', { payload: { agentReview: { status: 'revision-requested', round: 1 } } }],
    ['implementation-not-ready', { payload: { ...approvedReview(1, 20 * MIN), implementationReadiness: { status: 'not-ready' } } }],
  ] as const)('owes nothing recruitable when %s', (reason, over) => {
    expect(recruitLegFor(candidate(over as Partial<RecruitCandidate>))).toEqual({ leg: null, reason });
  });
});

describe('recruit labels', () => {
  it('round-trips the leg, item, epoch and attempt', () => {
    const label = recruitLabel('repair', 'EI-26554629962517531', 'a1', 2);
    expect(label).toBe('admission-recruit:repair:EI-26554629962517531:a1:2');
    expect(parseRecruitLabel(label)).toEqual({ leg: 'repair', workItemId: 'EI-26554629962517531', epoch: 'a1', attempt: 2 });
    expect(parseRecruitLabel('su-ideate-pass:papercusp:never:1')).toBeNull();
  });
});

describe('planAdmissionRecruitment', () => {
  it('recruit ON: waits inside the SLO, launches attempt 1 past it', () => {
    const inside = planAdmissionRecruitment([candidate({ payload: pendingReview(1, ADMISSION_RECRUIT_REVIEW_SLO_MS - MIN) })], [], NOW);
    expect(inside[0]).toMatchObject({ action: 'wait', reason: 'within-slo', leg: 'review' });
    const past = planAdmissionRecruitment([candidate({ payload: pendingReview(1, ADMISSION_RECRUIT_REVIEW_SLO_MS + MIN) })], [], NOW);
    expect(past[0]).toMatchObject({ action: 'launch', leg: 'review', key: 'admission-recruit:review:EI-1:r1:1', attempts: 0 });
  });

  it('a live recruited agent for the same leg and epoch blocks a second launch', () => {
    const live: RecruitLaunchRecord = { label: recruitLabel('review', 'EI-1', 'r1', 1), startedAtMs: NOW - 5 * MIN, live: true };
    const d = planAdmissionRecruitment([candidate()], [live], NOW);
    expect(d[0]).toMatchObject({ action: 'in-flight', attempts: 1 });
  });

  it('a new review round is a new epoch: the earlier round’s launches do not count', () => {
    const old: RecruitLaunchRecord = { label: recruitLabel('review', 'EI-1', 'r1', 1), startedAtMs: NOW - 5 * MIN, live: true };
    const d = planAdmissionRecruitment([candidate({ payload: pendingReview(2, 30 * MIN) })], [old], NOW);
    expect(d[0]).toMatchObject({ action: 'launch', key: 'admission-recruit:review:EI-1:r2:1' });
  });

  it('a stale or ended launch lets the next attempt go, until attempts are exhausted', () => {
    const stale: RecruitLaunchRecord = { label: recruitLabel('repair', 'EI-1', 'a1', 1), startedAtMs: NOW - ADMISSION_RECRUIT_STALE_MS - MIN, live: true };
    const payload = approvedReview(1, ADMISSION_RECRUIT_REPAIR_SLO_MS + MIN);
    const second = planAdmissionRecruitment([candidate({ payload })], [stale], NOW);
    expect(second[0]).toMatchObject({ action: 'launch', key: 'admission-recruit:repair:EI-1:a1:2' });
    const ended = Array.from({ length: ADMISSION_RECRUIT_MAX_ATTEMPTS }, (_, i): RecruitLaunchRecord => ({
      label: recruitLabel('repair', 'EI-1', 'a1', i + 1),
      startedAtMs: NOW - 60 * MIN,
      live: false,
    }));
    const exhausted = planAdmissionRecruitment([candidate({ payload })], ended, NOW);
    expect(exhausted[0]).toMatchObject({
      action: 'escalate',
      reason: 'attempts-exhausted',
      key: recruitExhaustedConditionKey('EI-1', 'repair', 'a1'),
    });
  });

  it('recruit OFF never launches; it raises a stranded owner only after the stranded SLO', () => {
    const fresh = planAdmissionRecruitment([candidate({ recruit: false, payload: pendingReview(1, 30 * MIN) })], [], NOW);
    expect(fresh[0]).toMatchObject({ action: 'wait', reason: 'recruit-off' });
    const stranded = planAdmissionRecruitment(
      [candidate({ recruit: false, payload: pendingReview(1, ADMISSION_STRANDED_SLO_MS + MIN) })],
      [],
      NOW,
    );
    expect(stranded[0]).toMatchObject({
      action: 'escalate',
      reason: 'stranded-recruit-off',
      key: admissionStrandedConditionKey('EI-1', 'review', 'r1'),
    });
  });

  it('caps launches per pass, keeping the longest-waiting items', () => {
    const items = [
      candidate({ workItemId: 'EI-a', payload: pendingReview(1, 20 * MIN) }),
      candidate({ workItemId: 'EI-b', payload: pendingReview(1, 90 * MIN) }),
      candidate({ workItemId: 'EI-c', payload: pendingReview(1, 50 * MIN) }),
    ];
    const d = planAdmissionRecruitment(items, [], NOW, { maxLaunches: 2 });
    const byId = Object.fromEntries(d.map((x) => [x.workItemId, x]));
    expect(byId['EI-b'].action).toBe('launch');
    expect(byId['EI-c'].action).toBe('launch');
    expect(byId['EI-a']).toMatchObject({ action: 'wait', reason: 'launch-cap' });
  });
});

function fakeDeps(over: { candidates: RecruitCandidate[]; launches?: RecruitLaunchRecord[]; launchFails?: boolean }) {
  const launched: AdmissionRecruitLaunchInput[] = [];
  const escalations: AdmissionRecruitEscalation[] = [];
  const ledger = [...(over.launches ?? [])];
  let ledgerReads = 0;
  const deps: AdmissionRecruiterDeps = {
    listCandidates: async () => over.candidates,
    listLaunches: async () => {
      ledgerReads += 1;
      return ledger;
    },
    launch: async (input) => {
      if (over.launchFails) throw new Error('quota');
      launched.push(input);
      ledger.push({ label: input.key, startedAtMs: NOW, live: true });
      return { ok: true };
    },
    escalate: async (input) => {
      escalations.push(input);
      return { id: 'EI-esc', created: escalations.filter((e) => e.key === input.key).length === 1 };
    },
  };
  return { deps, launched, escalations, ledgerReads: () => ledgerReads };
}

describe('runAdmissionRecruiter', () => {
  it('launches a reviewer with a directed one-job brief, and the next pass does not launch again', async () => {
    const f = fakeDeps({ candidates: [candidate()] });
    const first = await runAdmissionRecruiter({ workspaceId: 'ws', dataSourceId: 'ds', nowMs: NOW }, f.deps);
    expect(first.launched).toEqual([{ workItemId: 'EI-1', leg: 'review', key: 'admission-recruit:review:EI-1:r1:1', deduped: false }]);
    expect(f.launched[0].harnessSlug).toBe('slack-asana-bug-drill');
    expect(f.launched[0].brief).toContain("improvements:agent-review { mode:'claim', id:'EI-1', harness:'slack-asana-bug-drill' }");
    expect(f.launched[0].brief).toContain('blender:grade-idea');
    expect(f.launched[0].brief).toContain('Do NOT claim, implement, or close');
    const second = await runAdmissionRecruiter({ workspaceId: 'ws', dataSourceId: 'ds', nowMs: NOW + MIN }, f.deps);
    expect(second.launched).toEqual([]);
    expect(second.decisions[0]).toMatchObject({ action: 'in-flight' });
  });

  it('launches an implementer for a reviewed, unclaimed bug', async () => {
    const f = fakeDeps({ candidates: [candidate({ payload: approvedReview(1, 30 * MIN) })] });
    const res = await runAdmissionRecruiter({ workspaceId: 'ws', dataSourceId: 'ds', nowMs: NOW }, f.deps);
    expect(res.launched[0]).toMatchObject({ leg: 'repair', key: 'admission-recruit:repair:EI-1:a1:1' });
    expect(f.launched[0].brief).toContain("work_items:claim { id:'EI-1', harness:'slack-asana-bug-drill' }");
    expect(f.launched[0].brief).toContain('regression test');
    expect(f.launched[0].brief).toContain('Never git add');
  });

  it('records a launch failure instead of throwing, and does not read the ledger for recruit-off sources', async () => {
    const failing = fakeDeps({ candidates: [candidate()], launchFails: true });
    const res = await runAdmissionRecruiter({ workspaceId: 'ws', dataSourceId: 'ds', nowMs: NOW }, failing.deps);
    expect(res.failed).toEqual([{ workItemId: 'EI-1', stage: 'launch', error: 'quota' }]);
    const off = fakeDeps({ candidates: [candidate({ recruit: false })] });
    await runAdmissionRecruiter({ workspaceId: 'ws', dataSourceId: 'ds', nowMs: NOW }, off.deps);
    expect(off.ledgerReads()).toBe(0);
    expect(off.launched).toEqual([]);
  });

  it('raises one condition-keyed owner for stranded work and adopts it on the next pass', async () => {
    const f = fakeDeps({ candidates: [candidate({ recruit: false, payload: pendingReview(1, ADMISSION_STRANDED_SLO_MS + MIN) })] });
    const a = await runAdmissionRecruiter({ workspaceId: 'ws', dataSourceId: 'ds', nowMs: NOW }, f.deps);
    const b = await runAdmissionRecruiter({ workspaceId: 'ws', dataSourceId: 'ds', nowMs: NOW }, f.deps);
    expect(a.escalated[0]).toMatchObject({ key: 'admission-stranded:EI-1:review:r1', created: true });
    expect(b.escalated[0]).toMatchObject({ key: 'admission-stranded:EI-1:review:r1', created: false });
    expect(f.escalations[0].title).toContain('EI-1');
    expect(f.escalations[0].body).toContain('lifecycle.recruit off');
  });
});

describe('lifecycle.recruit switch', () => {
  it('is OFF by default and only a boolean turns it on', () => {
    expect(DEFAULT_ADMISSION_LIFECYCLE.recruit).toBe(false);
    expect(parseAdmissionLifecycle({}).recruit).toBe(false);
    expect(parseAdmissionLifecycle({ recruit: true }).recruit).toBe(true);
    expect(() => parseAdmissionLifecycle({ recruit: 'yes' })).toThrow(/lifecycle\.recruit must be a boolean/);
    expect(resolveAdmissionLifecycle({ recruit: 'yes' }).recruit).toBe(false);
  });
});
