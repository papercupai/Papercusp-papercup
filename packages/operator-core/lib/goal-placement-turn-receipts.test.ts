import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgentObligation, formatAgentObligationLine } from './agent-obligations';
import type { AgentObligationBrief, AgentObligationAgendaRead } from './agent-obligation-reader';
import { readVerbatimTail, type TranscriptTailTurn } from './turn-journal';
import {
  confirmGoalPlacementDelivery, deliveredGoalPlacementRows, prepareGoalPlacementDelivery,
  type GoalPlacementTurnReceiptDeps,
  recordGoalPlacementTurnEnd, type GoalPlacementTurnEndDeps, GOAL_PLACEMENT_TURN_END_SETTLE_POLLS,
  recordGoalPlacementTurnEndOutcome, recordGoalPlacementDeliveryOutcome, boundedRecordGoalPlacementTurnEnd,
  boundedRecordGoalPlacementTurnEndOutcome,
  observeGoalPlacementAdmission, qualifyGoalPlacementTurn, type GoalPlacementAdmissionDeps,
  type GoalPlacementAdmissionObservation, noProgressAge, placementSelection,
} from './goal-placement-turn-receipts';
import type { GovernorStateSnapshot } from './resource-governor/state-snapshot';
import { drainDetached } from './detached-imports';

const at = (n: number) => new Date(Date.UTC(2026, 8, 23, 0, n));
const row = defineAgentObligation({ ruleId: 'placement', ruleRevision: 'v1', family: 'plan-placement',
  scope: { ownerId: 'holder', workspaceId: 'workspace', goalId: 'goal', planSlug: 'plan' },
  responsibleOwnerId: 'holder', title: 'Place the plan', status: 'due', reason: 'Eligible plan has no member.',
  authority: { kind: 'policy', sourceRef: 'fixture:policy', revision: 'v1' },
  priority: 'high', causalRank: 1, evidence: [],
  sourceGeneration: 'generation-1', episode: 'fixture-episode', applicableDemand: 1,
  clearsWhen: { id: 'claimed', summary: 'A verified member claim exists.', evidenceKind: 'state', sourceRef: 'fixture:claims' },
  action: { kind: 'delegate', summary: 'Staff the eligible plan.', targetRef: 'plan:harness/plan', tool: 'fleet:launch-on-plan' },
});

describe('goal placement delivery drop outcomes (WI-10005636)', () => {
  it('persists the drop stage and reason under a key separate from goalPlacementTurn receipts', async () => {
    const append = vi.fn(async () => ({ id: 'diagnostic' }));
    const persisted = await recordGoalPlacementDeliveryOutcome({
      ownerId: 'holder', workspaceId: 'workspace', stage: 'confirm', reason: 'native-window-incomplete',
      candidate: { version: 1, token: 'tok-1', nativeSessionId: 'native-1', sourceKind: 'claude',
        rows: [{ planSlug: 'plan-a' }, { planSlug: 'plan-b' }] },
    }, { append, now: () => at(5).getTime() });

    expect(persisted).toBe(true);
    expect(append).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'workspace', owner: 'holder', agent: 'claude', sessionId: 'native-1', scope: 'plan-a',
      kind: 'lifecycle', toolName: null, phase: null,
      toolUseId: `goal-placement-delivery-outcome:confirm:tok-1:${at(5).toISOString()}`,
      summary: 'Goal placement delivery produced no receipt', status: null, cwd: null,
      detail: { goalPlacementDeliveryOutcome: {
        version: 1, stage: 'confirm', recorded: false, reason: 'native-window-incomplete',
        observedAt: at(5).toISOString(), token: 'tok-1', unavailable: false, candidateReason: null,
        planSlugs: ['plan-a', 'plan-b'],
      } },
    });
  });

  it('keeps the staged fallback reason of an unavailable candidate and tolerates a malformed one', async () => {
    const append = vi.fn(async (_record: { detail: unknown }) => ({ id: 'diagnostic' }));
    const deps = { append, now: () => at(6).getTime() };
    await recordGoalPlacementDeliveryOutcome({ ownerId: 'holder', workspaceId: 'workspace', stage: 'late-upgrade',
      reason: 'late-prepare-timeout', candidate: { version: 1, unavailable: true, token: 'tok-2', reason: 'timeout',
        rows: [{ planSlug: 'plan-a' }] } }, deps);
    await recordGoalPlacementDeliveryOutcome({ ownerId: 'holder', workspaceId: 'workspace', stage: 'confirm',
      reason: 'no-exact-proof-candidate', candidate: 'not-an-object' }, deps);

    const details = append.mock.calls.map(([record]) => record.detail);
    expect(details).toEqual([
      { goalPlacementDeliveryOutcome: expect.objectContaining({ stage: 'late-upgrade', unavailable: true,
        candidateReason: 'timeout', token: 'tok-2', planSlugs: ['plan-a'] }) },
      { goalPlacementDeliveryOutcome: expect.objectContaining({ stage: 'confirm', unavailable: false,
        candidateReason: null, token: null, planSlugs: [] }) },
    ]);
  });

  it('reports a failed append instead of throwing into the detached turn-start path', async () => {
    const append = vi.fn(async () => { throw new Error('pg down'); });
    await expect(recordGoalPlacementDeliveryOutcome({ ownerId: 'holder', workspaceId: 'workspace',
      stage: 'confirm', reason: 'x', candidate: null }, { append, now: () => at(7).getTime() })).resolves.toBe(false);
  });
});

const admission = (minute: number, overrides: Partial<GoalPlacementAdmissionObservation> = {}): GoalPlacementAdmissionObservation => ({
  version: 1, planRef: 'plan:harness/plan', observedAt: at(minute).toISOString(), planReason: 'ready',
  launch: { fleetSlug: 'plan-fleet', requestedSeats: 1 },
  governor: 'open', attempts: 'none', evidenceRefs: ['fixture:preflight', 'fixture:governor'], ...overrides,
});

describe('typed placement admission observations', () => {
  function fixture() {
    const snapshot = { observedAtMs: at(1).getTime(), validUntilMs: at(3).getTime(), evidenceRef: 'governor:1',
      admission: { state: 'open', constrainedClasses: [] } } as unknown as GovernorStateSnapshot;
    const deps: GoalPlacementAdmissionDeps = { preflight: vi.fn(async () => ({ ready: true, reason: 'ready' as const, plan: 'plan' })),
      governor: vi.fn(async () => snapshot), agentGovernorBinding: vi.fn(async () => 'binding' as const),
      attempts: vi.fn(async () => []), now: () => at(2).getTime() };
    const input = { ownerId: 'holder', workspaceId: 'workspace', row: { goalId: 'goal', planSlug: 'plan',
      planRef: 'plan:harness/plan', obligationId: row.id, sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision,
      launch: { fleetSlug: 'plan-fleet', requestedSeats: 1 } } };
    return { snapshot, deps, input };
  }
  it('requires measured plan readiness and a fresh unrestricted agent governor', async () => {
    const f = fixture();
    expect(await observeGoalPlacementAdmission(f.input, f.deps)).toMatchObject({ planReason: 'ready', governor: 'open', attempts: 'none' });
    f.deps.preflight = async () => { throw new Error('read failed'); };
    f.deps.attempts = async () => { throw new Error('ledger unavailable'); };
    expect(await observeGoalPlacementAdmission(f.input, f.deps)).toMatchObject({ planReason: 'unknown', attempts: 'unknown' });
  });
  it.each(['plan-not-found', 'no-actionable-plan-items', 'promotion-lag', 'duplicate-coverage', 'lane-unknown',
    'floor-diagnostics-unavailable', 'floor-gated', 'family-disagreement', 'insufficient-executable-width'] as const)(
    'preserves exact preflight reason %s', async (reason) => {
      const f = fixture(); f.deps.preflight = async () => ({ ready: false, reason, plan: 'plan' });
      expect((await observeGoalPlacementAdmission(f.input, f.deps)).planReason).toBe(reason);
    });
  it('rejects stale/future snapshots and preserves class-specific restrictions and actual receipts', async () => {
    const f = fixture();
    f.deps.governor = async () => ({ ...f.snapshot, validUntilMs: at(1).getTime() });
    expect((await observeGoalPlacementAdmission(f.input, f.deps)).governor).toBe('unknown');
    f.deps.governor = async () => ({ ...f.snapshot, observedAtMs: at(3).getTime() });
    expect((await observeGoalPlacementAdmission(f.input, f.deps)).governor).toBe('unknown');
    f.deps.governor = async () => ({ ...f.snapshot, admission: { ...f.snapshot.admission, state: 'constrained', constrainedClasses: ['embedding'] } });
    expect((await observeGoalPlacementAdmission(f.input, f.deps)).governor).toBe('open');
    f.deps.governor = async () => ({ ...f.snapshot, admission: { ...f.snapshot.admission, state: 'constrained', constrainedClasses: ['agent'] } });
    f.deps.attempts = async () => ['RG-exact'];
    expect(await observeGoalPlacementAdmission(f.input, f.deps)).toMatchObject({ governor: 'restricted', attempts: 'present',
      evidenceRefs: expect.arrayContaining(['RG-exact']) });
  });
  it('reads an unpublished agent decision as open only while the agent door is observe-only (D-031)', async () => {
    const f = fixture();
    const unpublished = { ...f.snapshot, evidenceRef: null, admission: { ...f.snapshot.admission, state: null } };
    f.deps.governor = async () => unpublished as unknown as GovernorStateSnapshot;
    expect((await observeGoalPlacementAdmission(f.input, f.deps)).governor).toBe('unknown');
    f.deps.agentGovernorBinding = async () => 'observe-only';
    expect(await observeGoalPlacementAdmission(f.input, f.deps)).toMatchObject({ governor: 'open',
      evidenceRefs: expect.arrayContaining(['governor:agent:observe-only']) });
    f.deps.governor = async () => null;
    expect((await observeGoalPlacementAdmission(f.input, f.deps)).governor).toBe('open');
    // A published decision still wins: observe-only never upgrades a restriction to open.
    f.deps.governor = async () => ({ ...f.snapshot, admission: { ...f.snapshot.admission, state: 'paused', constrainedClasses: [] } });
    expect((await observeGoalPlacementAdmission(f.input, f.deps)).governor).toBe('restricted');
    // An unreadable declaration stays unmeasured rather than open.
    f.deps.governor = async () => null;
    f.deps.agentGovernorBinding = async () => { throw new Error('module load failed'); };
    expect((await observeGoalPlacementAdmission(f.input, f.deps)).governor).toBe('unknown');
  });
});

describe('exact completed-opportunity proof join', () => {
  function proof() {
    const receipt = { version: 1, goalId: 'goal', planSlug: 'plan', planRef: 'plan:harness/plan', obligationId: row.id,
      sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision, deliveryToken: 'token',
      offeredAt: at(2).toISOString(), completedAt: at(3).toISOString(), confirmedAt: at(5).toISOString(),
      completedTurnRef: 'codex:native-1:request', launch: { fleetSlug: 'plan-fleet', requestedSeats: 1 }, admission: admission(2) };
    const end = { version: 1, goalId: 'goal', completedTurnRef: receipt.completedTurnRef, completedAt: receipt.completedAt,
      observedAt: at(4).toISOString(), deliveryToken: 'token', rows: [{ planSlug: 'plan', planRef: receipt.planRef,
        status: 'due', applicableDemand: 1, actionKind: 'delegate', obligationId: row.id,
        sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision }],
      admissions: [{ planRef: receipt.planRef, admission: admission(4) }] };
    return { receipt, end, qualify: () => qualifyGoalPlacementTurn({ receipt, turnEnd: end, nativeSessionId: 'native-1' }) };
  }
  it('joins the exact token and native final with the timely policy, ignoring later confirmation prose', () => {
    const f = proof();
    expect(f.qualify()).toMatchObject({ deliveryToken: 'token', completedTurnRef: 'codex:native-1:request',
      eligibleAtOffer: true, eligibleAtCompletion: true });
    expect(qualifyGoalPlacementTurn({ receipt: { ...f.receipt, atConfirmation: { status: 'satisfied' } },
      turnEnd: f.end, nativeSessionId: 'native-1' })).toEqual(f.qualify());
  });
  it.each(['token', 'goal', 'native', 'plan', 'revision', 'late', 'admission'])(
    'cannot count missing, stale or mismatched %s proof', (change) => {
      const f = proof();
      if (change === 'token') f.end.deliveryToken = 'wrong';
      if (change === 'goal') f.end.goalId = 'other';
      if (change === 'native') f.end.completedTurnRef = 'codex:other:request';
      if (change === 'plan') f.end.rows[0]!.planRef = 'plan:harness/other';
      if (change === 'revision') f.end.rows[0]!.ruleRevision = 'new-rule';
      if (change === 'late') f.end.admissions[0]!.admission.observedAt = at(5).toISOString();
      if (change === 'admission') f.end.admissions = [];
      expect(f.qualify()).toBeNull();
    });
  it('qualifies the same plan demand after an unrelated portfolio change moved the source digest', () => {
    // Live receipt 6400376: offer obl:…d6b91a89/91cbb1db, completion obl:…63c85e0e/cd2b8393 for
    // the same plan two minutes later. Requiring digest equality left every opportunity unmeasured.
    const f = proof();
    f.end.rows[0]!.sourceGeneration = 'new-generation';
    f.end.rows[0]!.obligationId = 'obl:goal-plan-placement:new-episode';
    expect(f.qualify()).toMatchObject({ eligibleAtOffer: true, eligibleAtCompletion: true });
  });
  it.each(['blocked', 'in-progress', 'not-applicable', 'satisfied'])('consumes a %s interval as excluded', (status) => {
    const f = proof(); f.end.rows[0]!.status = status;
    expect(f.qualify()).toMatchObject({ eligibleAtOffer: true, eligibleAtCompletion: false });
  });
  it.each(['offer-fleet', 'offer-seats', 'completion-fleet', 'completion-seats'])('rejects a mismatched %s admission binding', (change) => {
    const f = proof();
    const measured = change.startsWith('offer') ? f.receipt.admission : f.end.admissions[0]!.admission;
    if (change.endsWith('fleet')) measured.launch!.fleetSlug = 'another-fleet';
    else measured.launch!.requestedSeats = 2;
    expect(f.qualify()).toBeNull();
  });
  it('keeps an older receipt without a launch binding unmeasured', () => {
    const f = proof();
    const { launch: _launch, ...legacy } = f.receipt;
    expect(qualifyGoalPlacementTurn({ receipt: legacy, turnEnd: f.end, nativeSessionId: 'native-1' })).toBeNull();
  });
  it('qualifies a completed repair only with the same exact admission evidence as delegation', () => {
    const f = proof(); f.end.rows[0]!.actionKind = 'repair';
    expect(f.qualify()).toMatchObject({ eligibleAtOffer: true, eligibleAtCompletion: true });
    f.end.admissions[0]!.admission.governor = 'restricted';
    expect(f.qualify()?.eligibleAtCompletion).toBe(false);
    f.end.admissions[0]!.admission.governor = 'unknown';
    expect(f.qualify()).toBeNull();
  });
  it('excludes actual admission activity and keeps unknown measurement unknown', () => {
    const f = proof(); f.end.admissions[0]!.admission.attempts = 'present';
    expect(f.qualify()?.eligibleAtCompletion).toBe(false);
    f.end.admissions[0]!.admission.attempts = 'unknown';
    expect(f.qualify()).toBeNull();
    f.end.admissions[0]!.admission.attempts = 'none';
    f.end.admissions[0]!.admission.governor = 'unknown';
    expect(f.qualify()).toBeNull();
  });
});

describe('native transcript parser to goal delivery receipt', () => {
  // These are native-format transcripts, not preclassified delivered turns.
  // Only session discovery and the final activity sink are substituted here.
  function lines(kind: 'claude' | 'codex' | 'omp', id: string, minute: number, final: boolean) {
    const timestamp = at(minute).toISOString();
    if (kind === 'claude') return [
      { type: 'user', uuid: id, parentUuid: null, timestamp,
        message: { role: 'user', content: 'Work on the plan' } },
      { type: 'assistant', uuid: `${id}-answer`, parentUuid: id, timestamp,
        message: { role: 'assistant', stop_reason: final ? 'end_turn' : 'tool_use',
          content: [{ type: 'text', text: 'Native response' }] } },
    ];
    if (kind === 'omp') return [
      { type: 'message', id, parentId: null, timestamp,
        message: { role: 'user', content: [{ type: 'text', text: 'Work on the plan' }] } },
      { type: 'message', id: `${id}-answer`, parentId: id, timestamp,
        message: { role: 'assistant', stopReason: final ? 'stop' : 'toolUse',
          content: [{ type: 'text', text: 'Native response' }] } },
    ];
    return [
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'user',
        internal_chat_message_metadata_passthrough: { turn_id: id }, content: [{ type: 'input_text', text: 'Work on the plan' }] } },
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'commentary',
        internal_chat_message_metadata_passthrough: { turn_id: id }, content: [{ type: 'output_text', text: 'Native response' }] } },
      ...(final ? [{ type: 'event_msg', timestamp,
        payload: { type: 'task_complete', turn_id: id, error: null, last_agent_message: 'Native response' } }] : []),
    ];
  }

  it.each(['claude', 'codex', 'omp'] as const)('%s progress cannot count; its native terminal boundary can', async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-receipt-native-'));
    try {
      const native = { sessionId: 'native-parser', sourceKind: kind, filePath: join(directory, 'session.jsonl') };
      const prior = lines(kind, 'prior', 1, true);
      const write = async (rows: unknown[]) => writeFile(native.filePath, rows.map((line) => JSON.stringify(line)).join('\n') + '\n');
      await write(prior);
      const f = fixture();
      f.deps.current = async () => native;
      f.deps.lookup = async () => native;
      f.deps.tail = (source) => readVerbatimTail(source.filePath, source.sourceKind, 50);
      const candidate = await prepareGoalPlacementDelivery(input, f.deps);
      expect(candidate?.baselineTurnRef).toBe(`${kind}:native-parser:prior`);
      f.setNow(4);
      await write([...prior, ...lines(kind, 'next', 3, false)]);
      expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps)).recorded).toBe(0);
      expect(f.deps.append).not.toHaveBeenCalled();
      await write([...prior, ...lines(kind, 'next', 3, true)]);
      expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps)).recorded).toBe(1);
      expect(f.deps.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: {
        goalPlacementTurn: expect.objectContaining({ completedTurnRef: `${kind}:native-parser:next`, completedAt: at(3).toISOString() }),
      } }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
const block = formatAgentObligationLine(row, 'action');
const brief = { evaluations: [row], projection: { entries: [row] } } as AgentObligationBrief;
const input = { ownerId: 'holder', workspaceId: 'workspace', token: 'delivery-1', brief, block };
const session = { sessionId: 'native-1', sourceKind: 'codex' as const, filePath: '/fixture/transcript' };
const turn = (id: string, minute: number, disposition: TranscriptTailTurn['responseDisposition'] = 'delivered'): TranscriptTailTurn => ({
  speaker: 'assistant', text: 'A native response, not an execution receipt.', ts: at(minute), requestId: id,
  responseDisposition: disposition,
});

function fixture() {
  let turns: TranscriptTailTurn[] = [turn('old', 1)];
  let now = at(2).getTime();
  const deps: GoalPlacementTurnReceiptDeps = {
    current: vi.fn(async () => session), lookup: vi.fn(async () => session),
    tail: vi.fn(async () => turns), append: vi.fn(async () => ({ id: 'record' })), now: () => now,
  };
  return { deps, setTail: (value: TranscriptTailTurn[]) => { turns = value; },
    setNow: (minute: number) => { now = at(minute).getTime(); } };
}

describe('native turn-end policy observation', () => {
  function endFixture() {
    const f = fixture();
    f.setTail([turn('prior', 1), turn('current', 3)]); f.setNow(4);
    const read = { goalId: 'goal', portfolio: null, observedAt: at(4).toISOString(),
      agenda: { evaluations: [row] } } as AgentObligationAgendaRead;
    const deps: GoalPlacementTurnEndDeps = { ...f.deps, goalSubject: vi.fn(async () => 'goal'), goalHarness: vi.fn(async () => 'home-harness'), agenda: vi.fn(async () => read),
      sleep: vi.fn(async () => {}) };
    const endInput = { ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: session.sessionId, sourceKind: session.sourceKind };
    return { ...f, read, deps, endInput };
  }
  it('records scoped policy against the exact native final with an explicit observation time', async () => {
    const f = endFixture();
    expect(await recordGoalPlacementTurnEnd(f.endInput, f.deps)).toMatchObject({ recorded: true });
    expect(f.deps.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: { goalPlacementTurnEnd: {
      version: 1, goalId: 'goal', completedTurnRef: 'codex:native-1:current', completedAt: at(3).toISOString(),
      observedAt: at(4).toISOString(), rows: [{ planSlug: 'plan', planRef: 'plan:harness/plan', status: 'due', applicableDemand: 1,
        actionKind: 'delegate', obligationId: row.id, sourceGeneration: 'generation-1', ruleRevision: 'v1' }],
    } } }));
  });
  it('persists completed and active stage timings when the bounded writer times out', async () => {
    const f = endFixture();
    await Promise.all([import('./bounded-timeout'), import('./detached-imports')]);
    let resumeCurrent: ((value: typeof session | null) => void) | undefined;
    f.deps.current = vi.fn(() => new Promise<typeof session | null>((resolve) => { resumeCurrent = resolve; }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const pending = boundedRecordGoalPlacementTurnEnd(f.endInput, f.deps);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.deps.goalSubject).toHaveBeenCalledOnce();
      expect(f.deps.current).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_500);
      const result = await pending;
      expect(result).toMatchObject({ recorded: false, reason: 'turn-end-read-unavailable', diagnostics: {
        boundary: 'timeout', activeStage: 'current-session', stages: [
          expect.objectContaining({ stage: 'bounded-support-import', state: 'completed' }),
          expect.objectContaining({ stage: 'goal-subject', state: 'completed' }),
          expect.objectContaining({ stage: 'current-session', state: 'active', elapsedMs: 3_500 }),
        ],
      } });

      const append = vi.fn(async () => ({ id: 'diagnostic' }));
      expect(await recordGoalPlacementTurnEndOutcome(f.endInput, result, { append, now: () => at(5).getTime() })).toBe(true);
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ detail: { goalPlacementTurnEndOutcome:
        expect.objectContaining({ reason: 'turn-end-read-unavailable', diagnostics: expect.objectContaining({
          boundary: 'timeout', activeStage: 'current-session',
        }) }) } }));
    } finally {
      resumeCurrent?.(null);
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
  it('keeps thrown errors distinct from timeouts in the persisted outcome', async () => {
    const f = endFixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.deps.current = vi.fn(async () => { throw new Error('session lookup failed'); });
    try {
      const result = await boundedRecordGoalPlacementTurnEnd(f.endInput, f.deps);
      expect(result).toMatchObject({ recorded: false, reason: 'turn-end-read-unavailable', diagnostics: {
        boundary: 'error', activeStage: null, error: { name: 'Error', message: 'session lookup failed' }, stages: [
          expect.objectContaining({ stage: 'bounded-support-import', state: 'completed' }),
          expect.objectContaining({ stage: 'goal-subject', state: 'completed' }),
          expect.objectContaining({ stage: 'current-session', state: 'error', errorName: 'Error',
            errorMessage: 'session lookup failed' }),
        ],
      } });
      const append = vi.fn(async () => ({ id: 'diagnostic' }));
      expect(await recordGoalPlacementTurnEndOutcome(f.endInput, result, { append, now: () => at(5).getTime() })).toBe(true);
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ detail: { goalPlacementTurnEndOutcome:
        expect.objectContaining({ diagnostics: expect.objectContaining({ boundary: 'error', error: {
          name: 'Error', message: 'session lookup failed',
        } }) }) } }));
    } finally {
      warn.mockRestore();
    }
  });
  it.each(['failed', 'empty', 'other-harness'] as const)(
    'WI-10004818: uses the goal filing harness when the portfolio is %s', async (state) => {
      const f = endFixture();
      f.read.portfolio = state === 'failed' ? null : {
        worklist: state === 'empty' ? [] : [{ harness: 'other-harness' }],
      } as NonNullable<AgentObligationAgendaRead['portfolio']>;
      f.read.agenda.evaluations = [{ ...row, scope: { ...row.scope, planSlug: undefined }, status: 'unknown', action: undefined,
        measurementFailure: { code: 'canonical-plan-placement-read-failed',
          detail: 'goal portfolio timeout after 900ms', retry: 'retry' } }];
      expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).recorded).toBe(true);
      expect(f.deps.goalHarness).toHaveBeenCalledExactlyOnceWith('goal', 'workspace');
      expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'workspace', scope: 'home-harness',
        detail: { goalPlacementTurnEnd: expect.objectContaining({ rows: [expect.objectContaining({
          measurementFailure: expect.objectContaining({ code: 'canonical-plan-placement-read-failed' }),
        })] }) },
      }));
    });
  it('records why an unknown placement row could not be measured', async () => {
    const f = endFixture();
    const unknown = { ...row, status: 'unknown' as const, action: { kind: 'inspect' as const, summary: 'retry', targetRef: 'plan:harness/plan' },
      measurementFailure: { code: 'exact-plan-admission-unavailable', detail: 'the exact-plan preflight was not measured', retry: 'retry' } };
    f.deps.agenda = vi.fn(async () => ({ goalId: 'goal', portfolio: null, observedAt: at(4).toISOString(),
      agenda: { evaluations: [unknown] } }) as AgentObligationAgendaRead);
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).recorded).toBe(true);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ detail: { goalPlacementTurnEnd: expect.objectContaining({
      rows: [expect.objectContaining({ status: 'unknown', actionKind: 'inspect',
        measurementFailure: { code: 'exact-plan-admission-unavailable', detail: 'the exact-plan preflight was not measured' } })] }) } }));
  });
  it('projects the derived no-progress age and its anchor, and leaves an unmeasured age absent', async () => {
    const f = endFixture();
    const aged = { ...row, ageMs: 90_000 };
    f.deps.agenda = vi.fn(async () => ({ goalId: 'goal', portfolio: null, observedAt: at(4).toISOString(),
      agenda: { evaluations: [aged] } }) as AgentObligationAgendaRead);
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).recorded).toBe(true);
    const rows = (f.deps.append as ReturnType<typeof vi.fn>).mock.calls[0][0].detail.goalPlacementTurnEnd.rows;
    expect(rows[0]).toMatchObject({ noProgressAgeMs: 90_000, noProgressSince: new Date(at(4).getTime() - 90_000).toISOString() });
    expect(noProgressAge(undefined, at(4).toISOString())).toEqual({});
    expect(noProgressAge(-1, at(4).toISOString())).toEqual({});
    expect(noProgressAge(5, 'not-a-time')).toEqual({});
  });
  it('records the selected admission and the alternatives the selector weighed, in worklist order', async () => {
    const f = endFixture();
    const plan = (slug: string, state: string, consistent = false) =>
      ({ slug, ref: `plan:harness/${slug}`, placement: { state, reconciliation: { consistent } } });
    const portfolio = { worklist: [plan('blocked-first', 'unplaced'), plan('done', 'terminal'), plan('plan', 'unplaced'),
      plan('led', 'placed', true), plan('unread-later', 'unplaced')] } as unknown as AgentObligationAgendaRead['portfolio'];
    const placementAdmissions = { 'plan:harness/blocked-first': { reason: 'floor-gated' },
      'plan:harness/plan': { reason: 'ready' } } as unknown as AgentObligationAgendaRead['placementAdmissions'];
    f.deps.agenda = vi.fn(async () => ({ goalId: 'goal', portfolio, placementAdmissions, observedAt: at(4).toISOString(),
      agenda: { evaluations: [row] } }) as AgentObligationAgendaRead);
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).recorded).toBe(true);
    const rows = (f.deps.append as ReturnType<typeof vi.fn>).mock.calls[0][0].detail.goalPlacementTurnEnd.rows;
    expect(rows[0]).toMatchObject({ planSlug: 'plan', selectedAdmission: 'ready', alternatives: [
      { planSlug: 'blocked-first', planRef: 'plan:harness/blocked-first', placementState: 'unplaced', admission: 'floor-gated' },
      { planSlug: 'unread-later', planRef: 'plan:harness/unread-later', placementState: 'unplaced', admission: 'unread' },
    ] });
    expect(placementSelection({ portfolio, placementAdmissions }, null)).toEqual({});
    expect(placementSelection({ portfolio: null, placementAdmissions }, 'plan')).toEqual({});
  });
  it('binds admission evidence to the pending token without claiming it was delivered', async () => {
    const f = endFixture();
    const candidate = { version: 1, ownerId: 'holder', workspaceId: 'workspace', token: 'pending-token',
      offeredAt: at(2).toISOString(), nativeSessionId: 'native-1', sourceKind: 'codex', baselineTurnRef: 'codex:native-1:prior',
      rows: [{ goalId: 'goal', planSlug: 'plan', planRef: 'plan:harness/plan', obligationId: row.id,
        sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision,
        launch: { fleetSlug: 'plan-fleet', requestedSeats: 1 }, admission: admission(2) }] };
    f.deps.pending = async () => candidate;
    f.deps.admission = vi.fn(async () => admission(4));
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).recorded).toBe(true);
    expect(f.deps.admission).toHaveBeenCalledWith(expect.objectContaining({ window: {
      offeredAt: at(2).toISOString(), completedAt: at(3).toISOString() } }));
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ detail: { goalPlacementTurnEnd:
      expect.objectContaining({ deliveryToken: 'pending-token', admissions: [{ planRef: 'plan:harness/plan', admission: admission(4) }] }) } }));
  });
  it('does no native or policy IO for a non-GOAL caller, and refuses a mid-read goal change', async () => {
    const f = endFixture(); f.deps.goalSubject = async () => null;
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).reason).toBe('no-canonical-goal');
    expect(f.deps.current).not.toHaveBeenCalled();
    expect(f.deps.tail).not.toHaveBeenCalled();
    expect(f.deps.agenda).not.toHaveBeenCalled();
    f.deps.goalSubject = async () => 'previous-goal';
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).reason).toBe('goal-scope-changed-during-observation');
    expect(f.deps.append).not.toHaveBeenCalled();
  });
  it.each(['blocked', 'unknown', 'not-applicable', 'in-progress', 'satisfied'] as const)('preserves %s instead of asserting eligibility', async (status) => {
    const f = endFixture(); f.read.agenda.evaluations = [{ ...row, status }];
    await recordGoalPlacementTurnEnd(f.endInput, f.deps);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ detail: { goalPlacementTurnEnd:
      expect.objectContaining({ rows: [expect.objectContaining({ status })] }) } }));
  });
  it('refuses late replay, future timestamps, or a stale/foreign native session', async () => {
    const f = endFixture(); f.setNow(5);
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).reason).toBe('turn-end-observation-stale');
    f.setNow(2);
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).recorded).toBe(false);
    expect((await recordGoalPlacementTurnEnd({ ...f.endInput, nativeSessionId: 'old-session' }, f.deps)).reason).toBe('native-session-mismatch');
    expect(f.deps.agenda).not.toHaveBeenCalled();
    expect(f.deps.append).not.toHaveBeenCalled();
  });
  it.each(['progress', 'interrupted', null] as const)('refuses a %s latest response even with a prior completed one', async (disposition) => {
    const f = endFixture(); f.setTail([turn('prior', 1), turn('current', 3, disposition)]);
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).reason).toBe('native-decision-not-complete');
    expect(f.deps.agenda).not.toHaveBeenCalled();
    // Only a progress tail can be a flush race; the others are real non-completions and are never polled.
    expect(f.deps.sleep).toHaveBeenCalledTimes(disposition === 'progress' ? GOAL_PLACEMENT_TURN_END_SETTLE_POLLS : 0);
  });
  it('waits out the Stop-hook flush race: a progress tail that settles to the delivered response is recorded', async () => {
    const f = endFixture();
    const progress = [turn('prior', 1), turn('current', 3, 'progress')];
    const settled = [turn('prior', 1), turn('current', 3, 'progress'), turn('current', 3)];
    f.setTail(progress);
    let polls = 0;
    f.deps.sleep = vi.fn(async () => { polls += 1; if (polls === 2) f.setTail(settled); });
    const result = await recordGoalPlacementTurnEnd(f.endInput, f.deps);
    expect(result).toMatchObject({ recorded: true });
    expect(f.deps.sleep).toHaveBeenCalledTimes(2);
    expect(f.deps.append).toHaveBeenCalledOnce();
  });
  it('waits out the flush race when a tool-only turn leaves the user request last in the tail', async () => {
    const f = endFixture();
    const request = { ...turn('current', 2), speaker: 'user' as const, responseDisposition: null };
    f.setTail([turn('prior', 1), request]);
    let polls = 0;
    f.deps.sleep = vi.fn(async () => { polls += 1; if (polls === 3) f.setTail([turn('prior', 1), request, turn('current', 3)]); });
    expect(await recordGoalPlacementTurnEnd(f.endInput, f.deps)).toMatchObject({ recorded: true });
    expect(f.deps.sleep).toHaveBeenCalledTimes(3);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ detail: { goalPlacementTurnEnd:
      expect.objectContaining({ completedTurnRef: 'codex:native-1:current' }) } }));
  });
  it('polls a trailing user request only within the settle bound, then refuses', async () => {
    const f = endFixture();
    f.setTail([turn('prior', 1), { ...turn('current', 2), speaker: 'user', responseDisposition: null }]);
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).reason).toBe('native-decision-not-complete');
    expect(f.deps.sleep).toHaveBeenCalledTimes(GOAL_PLACEMENT_TURN_END_SETTLE_POLLS);
    expect(f.deps.agenda).not.toHaveBeenCalled();
  });
  it('refuses a newer user request or an unattributed tail, including a request starting during the policy read', async () => {
    const f = endFixture();
    for (const last of [{ ...turn('next', 4), speaker: 'user' as const }, { ...turn('next', 4), requestId: null }]) {
      f.setTail([turn('current', 3), last]);
      expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).recorded).toBe(false);
    }
    f.setTail([turn('current', 3)]);
    f.deps.agenda = async () => { f.setTail([turn('current', 3), { ...turn('next', 4), speaker: 'user' }]); return f.read; };
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).reason).toBe('native-decision-advanced-during-observation');
    expect(f.deps.append).not.toHaveBeenCalled();
  });
  it('refuses stale policy reads, wrong owner scope and absent canonical goals', async () => {
    const f = endFixture();
    f.read.observedAt = at(1).toISOString();
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).recorded).toBe(false);
    f.read.observedAt = at(4).toISOString();
    f.read.agenda.evaluations = [{ ...row, scope: { ...row.scope, ownerId: 'other' } }];
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).reason).toBe('placement-policy-unmeasured');
    f.read.goalId = null;
    expect((await recordGoalPlacementTurnEnd(f.endInput, f.deps)).reason).toBe('no-canonical-goal');
    expect(f.deps.append).not.toHaveBeenCalled();
  });
});

describe('native turn-end non-recording diagnostics', () => {
  const input = { ownerId: 'holder', workspaceId: 'workspace', nativeSessionId: 'old-session', sourceKind: 'codex' as const };

  it('stores a compact lifecycle outcome under a key separate from eligibility receipts', async () => {
    const append = vi.fn(async () => ({ id: 'diagnostic' }));
    const persisted = await recordGoalPlacementTurnEndOutcome(input,
      { recorded: false, reason: 'native-session-mismatch' }, { append, now: () => at(5).getTime() });

    expect(persisted).toBe(true);
    expect(append).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'workspace', owner: 'holder', agent: 'codex', sessionId: 'old-session', scope: null,
      kind: 'lifecycle', toolName: null, phase: null,
      toolUseId: `goal-placement-turn-end-outcome:codex:old-session:${at(5).toISOString()}`,
      summary: 'Goal placement policy turn-end observation was not recorded', status: null, cwd: null,
      detail: { goalPlacementTurnEndOutcome: {
        version: 1, recorded: false, reason: 'native-session-mismatch', observedAt: at(5).toISOString(),
      } },
    });
  });

  it('leaves successful observations and no-canonical-goal outcomes out of the diagnostic stream', async () => {
    const append = vi.fn(async () => ({ id: 'diagnostic' }));
    const deps = { append, now: () => at(5).getTime() };

    expect(await recordGoalPlacementTurnEndOutcome(input,
      { recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded' }, deps)).toBe(false);
    expect(await recordGoalPlacementTurnEndOutcome(input,
      { recorded: false, reason: 'no-canonical-goal' }, deps)).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it('records the actual completion time when the bounded outcome append finishes after its deadline', async () => {
    let finishOutcomeAppend: ((value: { id: string }) => void) | undefined;
    const append = vi.fn(async (record: any) => {
      if ('goalPlacementTurnEndOutcome' in record.detail) {
        return await new Promise<{ id: string }>((resolve) => { finishOutcomeAppend = resolve; });
      }
      return { id: 'timing' };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const pending = boundedRecordGoalPlacementTurnEndOutcome(input,
        { recorded: false, reason: 'turn-end-read-unavailable' }, { append, now: () => at(5).getTime() });
      await vi.advanceTimersByTimeAsync(0);
      expect(append).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toMatchObject({ status: 'timeout', recorded: false, elapsedMs: 500 });
      await vi.advanceTimersByTimeAsync(275);
      finishOutcomeAppend?.({ id: 'outcome' });
      await drainDetached();

      const timingReceipt = append.mock.calls.find(([record]) =>
        'goalPlacementTurnEndOutcomeAppendTiming' in record.detail)?.[0];
      expect(timingReceipt?.detail.goalPlacementTurnEndOutcomeAppendTiming).toMatchObject({
        version: 1, state: 'completed', elapsedMs: 775,
        outcomeToolUseId: `goal-placement-turn-end-outcome:codex:old-session:${at(5).toISOString()}`,
      });
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

describe('exact delivery plus native-final receipts', () => {
  it('captures a baseline but writes nothing until exact emission and a newer native final are proven', async () => {
    const f = fixture();
    const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    expect(candidate).toMatchObject({ token: 'delivery-1', baselineTurnRef: 'codex:native-1:old',
      rows: [{ obligationId: row.id, sourceGeneration: row.sourceGeneration }] });
    expect(f.deps.append).not.toHaveBeenCalled();
    f.setTail([turn('old', 1), turn('current', 3)]); f.setNow(4);
    const result = await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps);
    expect(result.recorded).toBe(1);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace', owner: 'holder',
      sessionId: 'native-1', scope: 'harness', detail: { goalPlacementTurn: expect.objectContaining({
        completedTurnRef: 'codex:native-1:current', offeredAt: at(2).toISOString(), completedAt: at(3).toISOString(),
        confirmedAt: at(4).toISOString(), atConfirmation: { status: 'due', obligationId: row.id,
          sourceGeneration: 'generation-1', ruleRevision: 'v1' },
      }) } }));
  });
  it.each(['blocked', 'in-progress', 'satisfied', 'unknown', 'not-applicable'] as const)(
    'does not offer an excluded %s row', (status) => {
      const changed = { ...row, status };
      expect(deliveredGoalPlacementRows({ ...input, brief: { ...brief, projection: { ...brief.projection, entries: [changed] } },
        block: formatAgentObligationLine(changed, 'action') })).toEqual([]);
    },
  );
  it('does not offer an omitted, clipped or foreign row', async () => {
    const f = fixture();
    for (const change of [{ block: '' }, { block: block.slice(0, -1) }, { ownerId: 'other' }, { workspaceId: 'other' }]) {
      expect(await prepareGoalPlacementDelivery({ ...input, ...change }, f.deps)).toBeNull();
    }
    expect(f.deps.current).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'another-token'])('does not treat %s confirmation as proof', async (confirmedToken) => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([turn('old', 1), turn('new', 3)]); f.setNow(4);
    expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken }, f.deps)).recorded).toBe(0);
    expect(f.deps.append).not.toHaveBeenCalled();
  });
  it.each(['progress', 'interrupted', null] as const)('does not count a native %s response', async (disposition) => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([turn('old', 1), turn('new', 3, disposition)]); f.setNow(4);
    expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps)).recorded).toBe(0);
  });
  it('refuses a missing native baseline instead of interpreting the retained tail as complete', async () => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([{ ...turn('new', 3), requestHistoryStatus: 'truncated' }]); f.setNow(4);
    expect(await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps))
      .toEqual({ recorded: 0, reason: 'native-window-incomplete' });
  });
  it('uses the first completed request after the offer, so replay cannot attach the token to a later turn', async () => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([turn('old', 1), turn('first', 3), turn('second', 4)]); f.setNow(5);
    await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ detail: {
      goalPlacementTurn: expect.objectContaining({ completedTurnRef: 'codex:native-1:first' }),
    } }));
  });
  it('preserves a later blocked observation without asserting eligibility at completion', async () => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([turn('old', 1), turn('new', 3)]); f.setNow(4);
    await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1',
      brief: { ...brief, evaluations: [{ ...row, status: 'blocked' }] } }, f.deps);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ detail: { goalPlacementTurn:
      expect.objectContaining({ atConfirmation: expect.objectContaining({ status: 'blocked' }) }) } }));
  });
  it('refuses a resolver result from another native session', async () => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.deps.lookup = async () => ({ ...session, sessionId: 'other-native' });
    expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps)).recorded).toBe(0);
    expect(f.deps.append).not.toHaveBeenCalled();
  });
});
