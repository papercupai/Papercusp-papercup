import { describe, expect, it, vi } from 'vitest';
import {
  advanceUndispatchableGradingCascade,
  acceptanceGraderLabelPrefix,
  answeringOwnerAtCursor,
  buildAssignedAcceptanceGraderBrief,
  carriedAcceptanceReviewBrief,
  carriedStaleGradingCardIds,
  classifyAcceptanceGraderStartupStall,
  classifyAcceptanceGraderNoFirstTurnStall,
  isAcceptanceGraderNoFirstTurnLivenessCandidate,
  classifyAcceptanceGraderParkedWithoutEmit,
  classifyAcceptanceGraderTerminalFailure,
  detectAcceptanceGraderTerminalFailure,
  readOpenGradingAnswererTerminalFailure,
  hasAcceptanceGraderNativeApiError,
  launchAcceptanceGrader,
  compactSnapshot,
  boundedSnapshotJson,
  ACCEPTANCE_SNAPSHOT_CAP_CHARS,
  isAcceptanceGradingRequestForPlan,
  isInFlightAcceptanceGradingRequest,
  ineligibleGradingHolders,
  ACCEPTANCE_GRADING_REQUEST_UNHELD_GRACE_MS,
  resolveAcceptanceGraderDiscoveryExtraExclusions,
  resolveAcceptanceGrader,
  resolveShipperId,
  appendIndependentVerificationBriefToRequest,
  ACCEPTANCE_GRADER_RECRUITER_ACTOR,
  selectableGraderLiveness,
  spentGradingCascadeAnswer,
  gradingCascadeWalkedToExhaustion,
  ACCEPTANCE_GRADING_SWEEP_ACTOR,
  CONSULT_EXPIRY_REVIEW_AUTHOR,
  GRADING_CASCADE_ANSWER_GRACE_MS,
} from './acceptance-grader';
import { ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE } from './consult/grading-cascade';
import { ACCEPTANCE_JUDGE_STACK } from './judge-identity-stack';
import { mockResolvedTyped } from './testing/typed-mock';

describe('pre-publication review brief', () => {
  it('carries the exact unknown-only selection alongside independent verification', () => {
    const brief = carriedAcceptanceReviewBrief({ acceptancePendingDeliveryBarKeys: ['R-15'],
      acceptanceIndependentVerificationBrief: 'Re-observe the installed candidate independently.' });
    expect(brief).toContain('Re-observe the installed candidate independently.');
    expect(brief).toContain('pendingDeliveryBarKeys:["R-15"]');
    expect(brief).toContain('must rate unknown');
    expect(brief).toContain('BOTH scorecards:evaluate and scorecards:emit');
    expect(brief).toContain('Do not claim delivery');
    expect(carriedAcceptanceReviewBrief({})).toBe('');
  });
});

describe('native terminal API-error provenance', () => {
  const sessionId = 'native-fixture-session';
  const record = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    type: 'assistant', sessionId, isSidechain: false, isApiErrorMessage: true, apiErrorStatus: 429,
    message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API error' }] },
    ...overrides,
  });

  it('recognizes the exact native failed assistant turn even after a partial JSONL tail', () => {
    expect(hasAcceptanceGraderNativeApiError('partial record\n' + record() + '\n', sessionId)).toBe(true);
  });

  it.each([
    { type: 'user' },
    { isApiErrorMessage: false },
    { apiErrorStatus: 200 },
    { isSidechain: true },
    { sessionId: 'another-native-session' },
    { message: { role: 'assistant', stop_reason: null } },
  ])('refuses quoted, incomplete, foreign or non-error records: %j', (override) => {
    expect(hasAcceptanceGraderNativeApiError(record(override), sessionId)).toBe(false);
  });

  it('does not retire a session whose user started another turn after the API error', () => {
    expect(hasAcceptanceGraderNativeApiError(record() + '\n' + record({ type: 'user' }), sessionId)).toBe(false);
  });

  it('fails closed if a subsequent native turn is only partially written', () => {
    expect(hasAcceptanceGraderNativeApiError(record() + '\n{"type":"user"', sessionId)).toBe(false);
  });

  it.each([
    [400, "API Error: 400 role 'system' is not supported on this model"],
    [429, 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s'],
  ])('enables the existing bounded classifier only for native completed API %s', async (status, error) => {
    const log = `●${error}\n✻ Worked for 1m 9s · done 9:30 PM\n❯`;
    const native = record({ apiErrorStatus: status });
    const readLogTail = vi.fn((path: string) => path === 'native.jsonl' ? native : log);
    const options = { readLogTail, nativeTranscriptPath: 'native.jsonl', nativeSessionId: sessionId,
      maxRechecks: 0, detectStartupStall: false };
    await expect(detectAcceptanceGraderTerminalFailure('judge.log', options))
      .resolves.toMatchObject({ code: 'inference_gateway_error' });
    await expect(detectAcceptanceGraderTerminalFailure('judge.log', {
      ...options, readLogTail: (path: string) => path === 'native.jsonl' ? record({ type: 'user' }) : log,
    })).resolves.toBeNull();
  });

  it('classifies a final native HTTP 5xx when the PTY only has generic mid-response text', async () => {
    const log = '●API Error: Server error mid-response. The response above may be incomplete.\n❯';
    const native = record({ apiErrorStatus: 500 });
    await expect(detectAcceptanceGraderTerminalFailure('judge.log', {
      readLogTail: (path) => path === 'native.jsonl' ? native : log,
      nativeTranscriptPath: 'native.jsonl', nativeSessionId: sessionId,
      maxRechecks: 0, detectStartupStall: false,
    })).resolves.toMatchObject({
      code: 'inference_gateway_error', evidence: expect.stringContaining('500'),
    });
  });

  it('does not classify generic mid-response text from native 4xx metadata alone', async () => {
    const log = '●API Error: Server error mid-response. The response above may be incomplete.\n❯';
    const native = record({ apiErrorStatus: 429 });
    await expect(detectAcceptanceGraderTerminalFailure('judge.log', {
      readLogTail: (path) => path === 'native.jsonl' ? native : log,
      nativeTranscriptPath: 'native.jsonl', nativeSessionId: sessionId,
      maxRechecks: 0, detectStartupStall: false,
    })).resolves.toBeNull();
  });

  it('keeps recovery unconfirmed when the native transcript cannot be read', async () => {
    const log = "●API Error: 400 role 'system' is not supported on this model\n✻ Worked for 1m 9s · done\n❯";
    await expect(detectAcceptanceGraderTerminalFailure('judge.log', {
      readLogTail: (path) => { if (path === 'native.jsonl') throw new Error('unreadable'); return log; },
      nativeTranscriptPath: 'native.jsonl', nativeSessionId: sessionId, maxRechecks: 0, detectStartupStall: false,
    })).resolves.toBeNull();
  });

  it.each([
    [400, "API Error: 400 role 'system' is not supported on this model"],
    [429, 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s'],
  ])('uses native completed API %s proof when the PTY omits its footer', async (status, error) => {
    const log = `●${error}\n❯`;
    const options = { nativeTranscriptPath: 'native.jsonl', nativeSessionId: sessionId,
      maxRechecks: 0, detectStartupStall: false };
    await expect(detectAcceptanceGraderTerminalFailure('judge.log', {
      ...options, readLogTail: (path) => path === 'native.jsonl' ? record({ apiErrorStatus: status }) : log,
    })).resolves.toMatchObject({ code: 'inference_gateway_error' });
    await expect(detectAcceptanceGraderTerminalFailure('judge.log', {
      ...options, readLogTail: (path) => path === 'native.jsonl' ? record({ type: 'user' }) : log,
    })).resolves.toBeNull();
  });
});

describe('readOpenGradingAnswererTerminalFailure (EI-25855370514874242)', () => {
  const input = { workspaceId: 'grader-ws', conversationId: 'grader-conv', answeringOwnerId: 'su-answerer' };
  const target = {
    ok: true,
    ownerId: input.answeringOwnerId,
    agent: 'claude',
    sessionId: 'native-answerer',
    ompThreadId: null,
    resumeId: 'native-answerer',
    workspaceId: input.workspaceId,
    harnessSlug: 'papercusp',
    role: null,
    feature: null,
    cwd: null,
    model: null,
    modelSource: null,
    account: null,
    endedAt: null,
    endedBy: null,
    live: false,
    advSessionId: 72,
    binding: null,
  } as const;
  const native = JSON.stringify({ type: 'assistant', sessionId: target.sessionId,
    isApiErrorMessage: true, apiErrorStatus: 429, message: { role: 'assistant', stop_reason: 'end_turn' } });
  const log = '●API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s\n❯';
  function dependencies() {
    const task = { taskId: 'exact-task', sessionId: target.sessionId, logPath: 'answerer.log', endedAt: null };
    return {
      resolveTarget: vi.fn(async () => target as Awaited<ReturnType<typeof import('./agent-launch-core').resolveResumeTarget>>),
      findTranscript: vi.fn(async () => 'answerer.jsonl'),
      listTasks: vi.fn(async () => [task] as Awaited<ReturnType<typeof import('./task-manager/store').listTasks>>),
      killTask: vi.fn(async () => ({ ok: true }) as Awaited<ReturnType<typeof import('./task-manager/control').killTask>>),
      readLogTail: vi.fn((path: string) => path === 'answerer.jsonl' ? native : log),
    };
  }

  it('binds the native failure to the current answerer task and retires only that task', async () => {
    const deps = dependencies();
    const failure = await readOpenGradingAnswererTerminalFailure(input, deps);
    expect(failure).toMatchObject({ code: 'inference_gateway_error' });
    expect(deps.findTranscript).toHaveBeenCalledWith(target.sessionId, { owner: input.answeringOwnerId });
    expect(deps.listTasks).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: input.workspaceId, coordOwnerId: input.answeringOwnerId, classes: ['agent-session'], limit: 1,
    }));
    expect(await failure?.retire?.()).toBe(true);
    expect(deps.killTask).toHaveBeenCalledWith('exact-task', { includeSubtree: true, escalateAfterMs: 5_000 });
  });

  it('keeps a task from another native incarnation untouched', async () => {
    const deps = dependencies();
    deps.listTasks.mockResolvedValue([{ taskId: 'new-task', sessionId: 'new-native', logPath: 'new.log' }] as Awaited<ReturnType<typeof import('./task-manager/store').listTasks>>);
    expect(await readOpenGradingAnswererTerminalFailure(input, deps)).toBeNull();
    expect(deps.killTask).not.toHaveBeenCalled();
  });

  it('recovers the current Codex answerer from owner-bound native capacity evidence', async () => {
    const d = dependencies();
    mockResolvedTyped(d.resolveTarget, { ...target, agent: 'codex', advSessionId: 73 });
    d.readLogTail.mockImplementation(path => path === 'answerer.jsonl'
      ? JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete',
          error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity.' } } })
      : 'Working · GPT-6.1-Sol high');
    const findCodexTranscript = vi.fn(async () => 'answerer.jsonl');
    const failure = await readOpenGradingAnswererTerminalFailure(input, { ...d, findCodexTranscript } as never);
    expect(failure).toMatchObject({ code: 'inference_gateway_error' });
    expect(findCodexTranscript).toHaveBeenCalledWith(target.sessionId, { homeOverride: expect.stringContaining('session-73') });
    expect(await failure?.retire?.()).toBe(true);
    expect(d.killTask).toHaveBeenCalledWith('exact-task', { includeSubtree: true, escalateAfterMs: 5_000 });
  });

  it.each([
    ['already_gone', true],
    ['command_failed', false],
  ] as const)('treats exact native answerer retirement %s as settled=%s', async (error, settled) => {
    const deps = dependencies();
    deps.killTask.mockResolvedValue({ ok: false, taskId: 'exact-task', action: 'kill', error });
    const failure = await readOpenGradingAnswererTerminalFailure(input, deps);
    expect(failure).toMatchObject({ code: 'inference_gateway_error' });
    expect(await failure?.retire?.()).toBe(settled);
    expect(deps.killTask).toHaveBeenCalledWith('exact-task', { includeSubtree: true, escalateAfterMs: 5_000 });
  });

  it('awaits asynchronous native readers before inspecting and revalidating the turn', async () => {
    const deps = dependencies();
    const failure = await readOpenGradingAnswererTerminalFailure(input, {
      ...deps, readLogTail: async (path) => path === 'answerer.jsonl' ? native : log,
    });
    expect(failure).toMatchObject({ code: 'inference_gateway_error' });
    expect(await failure?.retire?.()).toBe(true);
    expect(deps.killTask).toHaveBeenCalledTimes(1);
  });

  it.each(['task', 'native-turn', 'native-binding'])('refuses retirement after a concurrent %s change', async (change) => {
    const deps = dependencies();
    const failure = await readOpenGradingAnswererTerminalFailure(input, deps);
    expect(failure).not.toBeNull();
    if (change === 'task') {
      deps.listTasks.mockResolvedValue([{ taskId: 'new-task', sessionId: target.sessionId, logPath: 'new.log' }] as Awaited<ReturnType<typeof import('./task-manager/store').listTasks>>);
    } else if (change === 'native-turn') {
      deps.readLogTail.mockImplementation((path) => path === 'answerer.jsonl' ? native + '\n' + JSON.stringify({ type: 'user', sessionId: target.sessionId }) : log);
    } else {
      const resolved = await deps.resolveTarget();
      if (!resolved.ok) throw new Error('Expected the current answerer fixture to resolve');
      deps.resolveTarget.mockResolvedValue({ ...resolved, sessionId: 'new-native' });
    }
    expect(await failure?.retire?.()).toBe(false);
    expect(deps.killTask).not.toHaveBeenCalled();
  });
});

describe('answeringOwnerAtCursor (WI-10003786)', () => {
  const routing = {
    selection: {
      selected: [
        { ownerId: 'su-source-a', answeringOwnerId: 'su-fork-a' },
        { ownerId: 'su-source-b' },
      ],
    },
  };

  it('reads the answering fork stamped at the current cursor, not the menu source', () => {
    expect(answeringOwnerAtCursor(routing, 0)).toBe('su-fork-a');
  });

  it('is null when the current rank has no answering session (refused or not yet stamped)', () => {
    expect(answeringOwnerAtCursor(routing, 1)).toBeNull();
    expect(answeringOwnerAtCursor(routing, 2)).toBeNull();
  });

  it('accepts the jsonb column as a JSON string', () => {
    expect(answeringOwnerAtCursor(JSON.stringify(routing), 0)).toBe('su-fork-a');
  });

  it('is null for malformed routing or cursor, never a throw', () => {
    expect(answeringOwnerAtCursor('{not json', 0)).toBeNull();
    expect(answeringOwnerAtCursor(null, 0)).toBeNull();
    expect(answeringOwnerAtCursor({ selection: { selected: 'x' } }, 0)).toBeNull();
    expect(answeringOwnerAtCursor(routing, null)).toBeNull();
    expect(answeringOwnerAtCursor(routing, -1)).toBeNull();
    expect(answeringOwnerAtCursor({ selection: { selected: [{ answeringOwnerId: '' }] } }, 0)).toBeNull();
  });
});

describe('spentGradingCascadeAnswer (WI-10003451)', () => {
  const NOW = Date.parse('2026-09-27T09:25:00.000Z');
  // The exact digest shape measured on conv-mujhh8sa (identities-v1, 2026-09-27):
  // a failed dispatch, a decline, then the answer whose card later went cohort-stale.
  const answered = [
    { at: '2026-09-27T07:48:29.626Z', kind: 'dispatch_failed', ownerId: 'su-bb07b887', excerpt: 'implicit decline' },
    { at: '2026-09-27T07:52:15.918Z', kind: 'decline', ownerId: 'su-07f4a0cb', excerpt: 'capacity' },
    { at: '2026-09-27T08:11:44.559Z', kind: 'answer', ownerId: 'su-cbdfc50b', excerpt: 'scorecard EI-24401435844141024' },
  ];

  it('reports an answered cascade past the grace window as SPENT, naming the answer', () => {
    expect(spentGradingCascadeAnswer(answered, NOW)).toEqual({
      ownerId: 'su-cbdfc50b',
      at: '2026-09-27T08:11:44.559Z',
    });
  });

  it('accepts the digest as a JSON string (a text-typed driver read)', () => {
    expect(spentGradingCascadeAnswer(JSON.stringify(answered), NOW)?.ownerId).toBe('su-cbdfc50b');
  });

  it('keeps a cascade with no answer LIVE — declines and failed dispatches are the cascade still working', () => {
    expect(spentGradingCascadeAnswer(answered.slice(0, 2), NOW)).toBeNull();
    expect(spentGradingCascadeAnswer([], NOW)).toBeNull();
    expect(spentGradingCascadeAnswer(null, NOW)).toBeNull();
  });

  it('keeps a JUST-answered cascade live inside the grace window, and spends it the moment the window closes', () => {
    const answerMs = Date.parse('2026-09-27T08:11:44.559Z');
    expect(spentGradingCascadeAnswer(answered, answerMs + GRADING_CASCADE_ANSWER_GRACE_MS - 1)).toBeNull();
    expect(spentGradingCascadeAnswer(answered, answerMs + GRADING_CASCADE_ANSWER_GRACE_MS)).not.toBeNull();
  });

  it('judges by the LATEST answer: a fresh second answer holds the cascade live even when an older one is past grace', () => {
    const reAnswered = [...answered, { at: '2026-09-27T09:20:00.000Z', kind: 'answer', ownerId: 'su-second' }];
    expect(spentGradingCascadeAnswer(reAnswered, NOW)).toBeNull();
    expect(spentGradingCascadeAnswer(reAnswered, Date.parse('2026-09-27T09:31:00.000Z'))?.ownerId).toBe('su-second');
  });

  it('never spends on a malformed digest or an answer with an unparseable timestamp (fail toward the live dispatch)', () => {
    expect(spentGradingCascadeAnswer('{not json', NOW)).toBeNull();
    expect(spentGradingCascadeAnswer({ kind: 'answer' }, NOW)).toBeNull();
    expect(spentGradingCascadeAnswer([{ kind: 'answer', ownerId: 'su-x', at: 'yesterday' }], NOW)).toBeNull();
    expect(spentGradingCascadeAnswer([{ kind: 'answer', at: '2026-09-27T08:00:00.000Z' }], NOW)).toBeNull();
  });
});

describe('gradingCascadeWalkedToExhaustion (WI-10006700)', () => {
  const failed = (ownerId: string) => ({ at: '2026-10-06T14:10:47.959Z', kind: 'dispatch_failed', ownerId });
  const underFilled = { at: '2026-10-06T14:10:47.959Z', min: 1, answers: 0, reason: 'refill-spent' };

  it('recognises the measured conv-muwrapka shape: underFilled + a failed final dispatch', () => {
    const routing = { selection: { min: 1, underFilled } };
    const digest = [failed('su-g1'), failed('su-g2'), failed('su-refill')];
    expect(gradingCascadeWalkedToExhaustion(routing, digest)).toBe(true);
    expect(gradingCascadeWalkedToExhaustion(JSON.stringify(routing), JSON.stringify(digest))).toBe(true);
  });

  it('keeps a mid-walk cascade (no underFilled yet) live', () => {
    expect(gradingCascadeWalkedToExhaustion({ selection: { min: 1 } }, [failed('su-g1')])).toBe(false);
  });

  it('keeps a cascade whose final event is not a failed dispatch live', () => {
    const routing = { selection: { underFilled } };
    expect(
      gradingCascadeWalkedToExhaustion(routing, [failed('su-g1'), { at: underFilled.at, kind: 'answer', ownerId: 'su-g2' }]),
    ).toBe(false);
    expect(gradingCascadeWalkedToExhaustion(routing, [])).toBe(false);
  });

  it('is false on malformed input rather than finishing a row it cannot read', () => {
    expect(gradingCascadeWalkedToExhaustion('{not json', [failed('su-g1')])).toBe(false);
    expect(gradingCascadeWalkedToExhaustion({ selection: { underFilled } }, '{not json')).toBe(false);
    expect(gradingCascadeWalkedToExhaustion(null, null)).toBe(false);
  });
});

describe('advanceUndispatchableGradingCascade (EI-23939542953304626)', () => {
  const graders = ['su-a', 'su-b', 'su-c'].map((ownerId) => ({ ownerId }));

  it('advances through undispatchable transcripts until one answering session is queued', async () => {
    const advance = vi
      .fn()
      .mockResolvedValueOnce({ advanced: true, raced: false, nextOwnerId: 'su-b', queued: 0 })
      .mockResolvedValueOnce({ advanced: true, raced: false, nextOwnerId: 'su-c', queued: 1 });
    const markExhausted = vi.fn(async () => true);

    const result = await advanceUndispatchableGradingCascade({
      graders,
      initialQueued: 0,
      nowIso: () => '2026-09-26T19:00:00.000Z',
      advance,
      markExhausted,
    });

    expect(result).toEqual({ status: 'active', woke: 1 });
    expect(advance).toHaveBeenCalledTimes(2);
    expect(advance.mock.calls.map(([call]) => call.event.ownerId)).toEqual(['su-a', 'su-b']);
    expect(markExhausted).not.toHaveBeenCalled();
  });

  it('reports exhaustion only after the terminal CAS records every failed grader', async () => {
    const advance = vi.fn().mockResolvedValueOnce({
      advanced: true,
      raced: false,
      nextOwnerId: 'su-b',
      queued: 0,
    });
    const markExhausted = vi.fn(async () => true);

    const result = await advanceUndispatchableGradingCascade({
      graders: graders.slice(0, 2),
      initialQueued: 0,
      nowIso: () => '2026-09-26T19:00:00.000Z',
      advance,
      markExhausted,
    });

    expect(result).toEqual({ status: 'exhausted', woke: 0 });
    expect(markExhausted).toHaveBeenCalledWith({
      cursor: 1,
      digest: [
        expect.objectContaining({ ownerId: 'su-a', kind: 'dispatch_failed' }),
        expect.objectContaining({ ownerId: 'su-b', kind: 'dispatch_failed' }),
      ],
    });
  });

  // WI-10006700 — MEASURED 2026-10-06 on consult conv-muwrapka (plan
  // open-source-release-2026-09-29): grader 1's dispatch failed, the advance
  // dispatched grader 2 (failed), cascade-core's skipUndispatched walked into
  // the min-answers refill (su-5f9596a9, cursor 2, also failed) and recorded
  // `underFilled: refill-spent` — then returned exhausted with
  // exhaustedAfterDispatch at cursor 2. The loop read `!advanced` as a race, so
  // the row sat `awaiting_responder` for the full 4h TTL and the fresh-judge
  // fallback never fired.
  const walkedSlot = {
    cascadeCursor: 2,
    state: 'awaiting_responder',
    expiresAt: '2026-10-06T18:10:00.000Z',
  };

  it('WI-10006700: terminates at the slot an exhausting advance walked to, not as a race', async () => {
    const advance = vi.fn().mockResolvedValueOnce({
      advanced: false,
      raced: false,
      nextOwnerId: null,
      queued: 0,
      exhausted: true,
      terminalSlot: walkedSlot,
    });
    const markExhausted = vi.fn(async () => true);

    const result = await advanceUndispatchableGradingCascade({
      graders: graders.slice(0, 2),
      initialQueued: 0,
      nowIso: () => '2026-10-06T14:10:00.000Z',
      advance,
      markExhausted,
    });

    expect(result).toEqual({ status: 'exhausted', woke: 0 });
    expect(advance).toHaveBeenCalledTimes(1);
    // digest:null — the walk already recorded the full digest (incl. the refill
    // pick's failure); the terminal write must not overwrite it with this
    // loop's shorter local copy.
    expect(markExhausted).toHaveBeenCalledWith({
      cursor: 2,
      digest: null,
      at: '2026-10-06T14:10:00.000Z',
      expectedState: 'awaiting_responder',
      expectedExpiresAt: '2026-10-06T18:10:00.000Z',
    });
  });

  it('WI-10006700: an advance that exhausted at its own cursor terminates there', async () => {
    const advance = vi.fn().mockResolvedValueOnce({
      advanced: false,
      raced: false,
      nextOwnerId: null,
      queued: 0,
      exhausted: true,
      terminalSlot: null,
    });
    const markExhausted = vi.fn(async () => true);

    const result = await advanceUndispatchableGradingCascade({
      graders,
      initialQueued: 0,
      nowIso: () => '2026-10-06T14:10:00.000Z',
      advance,
      markExhausted,
    });

    expect(result).toEqual({ status: 'exhausted', woke: 0 });
    expect(markExhausted).toHaveBeenCalledWith({
      cursor: 0,
      digest: null,
      at: '2026-10-06T14:10:00.000Z',
    });
  });

  it('WI-10006700: a lost terminal CAS after an exhausting walk stays conservative (raced)', async () => {
    const advance = vi.fn().mockResolvedValueOnce({
      advanced: false,
      raced: false,
      nextOwnerId: null,
      queued: 0,
      exhausted: true,
      terminalSlot: walkedSlot,
    });
    const markExhausted = vi.fn(async () => false);

    const result = await advanceUndispatchableGradingCascade({
      graders: graders.slice(0, 2),
      initialQueued: 0,
      advance,
      markExhausted,
    });

    // Never report exhausted without a CAS-confirmed terminal write: a concurrent
    // reply/expiry owns the row, and a fresh judge must not launch over it.
    expect(result).toEqual({ status: 'raced', woke: 0 });
  });

  it('WI-10006700: a genuine race from the advance never reaches the terminal write', async () => {
    const advance = vi.fn().mockResolvedValueOnce({
      advanced: false,
      raced: true,
      nextOwnerId: null,
      queued: 0,
      exhausted: false,
    });
    const markExhausted = vi.fn(async () => true);

    const result = await advanceUndispatchableGradingCascade({
      graders,
      initialQueued: 0,
      advance,
      markExhausted,
    });

    expect(result).toEqual({ status: 'raced', woke: 0 });
    expect(markExhausted).not.toHaveBeenCalled();
  });
});

describe('WI-10002156: a reaped session must not be selectable as a grader', () => {
  // MEASURED 2026-09-21 on su-ce0b634c-004b-438e-ab1d-cd677fd5c604: NO
  // coord_presence row, an adv_sessions row still open (an unclean death never
  // writes ended_at, so the recorded-live leg counts it as positive evidence)
  // and an orphan inbox-wake watch row that outlived the process (so
  // wakeability still read true). The oracle therefore landed `parked`, which
  // DEAD_RESPONDER_STATES = {ended, recorded} does not cover — and the cascade
  // assigned grading to a session that could never take a turn.
  it('demotes a parked verdict that no fresh heartbeat backs to ended', () => {
    expect(selectableGraderLiveness({ sessionState: 'parked', heartbeatFresh: false })).toBe(
      'ended',
    );
  });

  // THE CONTROL that keeps the fix from being over-broad. A genuinely parked
  // grader is legitimate BY DESIGN — it reads the grading request on its next
  // turn — and measured, most candidates here are parked-but-heartbeating. If
  // this ever flips to 'ended', the recruiter has started collapsing every menu
  // to a fresh mint, which is the failure mode that rejected `psuHostAuthority`
  // and the `selfWake === 'none'` gate for this seam.
  it('leaves a genuinely parked, still-heartbeating grader selectable', () => {
    expect(selectableGraderLiveness({ sessionState: 'parked', heartbeatFresh: true })).toBe(
      'parked',
    );
  });

  // FALSIFIABILITY CONTROL — CLAUDE.md § "Proving a guard is falsifiable" puts a
  // module you IMPORT on the tier that keeps a deliberately-wrong implementation
  // permanently in the test file, rather than mutating the shared tree (the
  // in-tree probe is the last resort, and mutation-probe.sh refuses it from a
  // foreground call precisely because a kill can strand the mutant).
  //
  // `preFix` is the PRE-FIX behaviour: pass the oracle's label straight through.
  // It is what shipped while the cascade was assigning grading to a reaped
  // session. If the demotion above is ever removed or neutered, the first
  // assertion below starts failing instead of the guard silently going vacuous.
  it('discriminates against the pre-fix pass-through implementation', () => {
    const preFix = (v: { sessionState: string | null; heartbeatFresh?: boolean }) => v.sessionState;
    const reaped = { sessionState: 'parked', heartbeatFresh: false } as const;

    // THE DISCRIMINATION: the shipped guard and the pre-fix one must disagree
    // on exactly the reaped case — this is what makes the test above non-vacuous.
    expect(preFix(reaped)).toBe('parked');
    expect(selectableGraderLiveness(reaped)).toBe('ended');
    expect(selectableGraderLiveness(reaped)).not.toBe(preFix(reaped));

    // CALIBRATION: a control that differed EVERYWHERE would prove nothing (it
    // would just be a different function). They must still AGREE wherever the
    // fix is not supposed to change behaviour, or this control is not modelling
    // the pre-fix implementation at all.
    for (const agreed of [
      { sessionState: 'parked', heartbeatFresh: true },
      { sessionState: 'live', heartbeatFresh: true },
      { sessionState: 'recorded', heartbeatFresh: false },
    ] as const) {
      expect(selectableGraderLiveness(agreed)).toBe(preFix(agreed));
    }
  });

  it('passes every non-parked verdict through untouched, heartbeat regardless', () => {
    for (const heartbeatFresh of [true, false]) {
      for (const sessionState of ['live', 'ended', 'recorded', 'draining', 'suspect'] as const) {
        expect(selectableGraderLiveness({ sessionState, heartbeatFresh })).toBe(sessionState);
      }
      // `null` is the oracle's IN-BAND unknown and must never be collapsed into
      // a definite state — not measured is not the same as not alive.
      expect(selectableGraderLiveness({ sessionState: null, heartbeatFresh })).toBeNull();
    }
  });
});

describe("WI-10002152: the grader never launches on a no-failover account route", () => {
  it('pins every account in acceptance-grader.ts to the gateway route, not the single system credential', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./acceptance-grader.ts', import.meta.url), 'utf8');
    // Strip comment lines ONLY — never string literals: the token this detector
    // looks for legitimately LIVES inside a string, so blanking strings would
    // turn a true positive into a silent false negative.
    const code = src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

    // Positive control: proves the detector is reading the real module. Without
    // it, a moved/renamed file would make the assertion below pass vacuously.
    expect(code).toMatch(/account: 'auto'/);

    // `default` is the system's own single credential with the inference
    // gateway SKIPPED, so it cannot fail over. One usage-walled credential then
    // drops every headless grader kickoff at an interactive rate-limit picker
    // no headless session can answer, even while other pool accounts serve.
    expect(code).not.toMatch(/account: 'default'/);
  });
});

const plan = {
  row: {
    planSlug: 'ship-the-thing',
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    version: 7,
    contentHash: 'content-hash-7',
    items: [{ id: 'P-001', status: 'done', text: 'Implement the thing' }],
    decisions: [{ id: 'D-006', title: 'Independent grading', body: 'Use a frozen dedicated judge.' }],
  },
} as never;

/** A plan whose build item is still open — recruitment must refuse before reading the rubric. */
const planWithOpenBuildItems = {
  row: {
    items: [
      { id: 'P-001', text: 'Implement the thing', status: 'blocked' },
      { id: 'P-002', text: 'Independent acceptance grading', status: 'todo' },
    ],
  },
} as never;

const rubric = {
  rubricId: 'acceptance-ship-the-thing',
  revision: 3,
  title: 'Ship acceptance',
  proposedBy: 'su-implementer',
  criteria: [{ key: 'outcome', title: 'Outcome works', description: 'The shipped outcome is verified.' }],
} as never;

const audit = {
  planSlug: 'ship-the-thing',
  harnessSlug: 'papercusp',
  auditSeq: 3,
  createdBy: 'su-implementer',
  createdAt: '2026-08-14T00:00:00.000Z',
  auditedSha: 'abc123',
  summary: 'Focused verification passed.',
  findings: [],
  items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'test', path: 'lib/thing.test.ts' }] }],
} as never;

const workItems = [
  {
    id: 'WI-1',
    state: 'done',
    title: 'Implement the thing',
    terminalOwner: 'su-implementer',
    terminalCompletionRef: 'test:thing',
    terminalCompletionEvidence: { command: 'vitest', exitCode: 0 },
  },
] as never;

const baseCtx = {
  workspaceId: 'ws-test',
  harnessSlug: 'papercusp',
  role: 'su',
  isSuperuser: true,
  uiClientId: 'su-grader',
};
const ctx = baseCtx as never;
const callerCtx = (ownerId: string) => ({ ...baseCtx, uiClientId: ownerId }) as never;

describe('compactSnapshot rubric criteria', () => {
  it('preserves structured seeded BAR fields and falls back to intent.request for description', () => {
    const snapshot = compactSnapshot({
      plan,
      rubric: {
        rubricId: 'acceptance-structured',
        title: 'Structured acceptance',
        criteria: [{
          key: 'r-1',
          title: 'A structured BAR',
          intent: { request: 'The resolver must preserve every declared profile.' },
          model: 'Every declared profile is resolved deterministically.',
          method: 'Run the resolver parity test.',
          check: { kind: 'tests', files: ['packages/operator-core/lib/profile.test.ts'] },
          evidencePlane: 'tree',
          requiredScope: ['resolver', 'profiles'],
        }],
      },
      audit,
      workItems,
    } as never);

    expect(snapshot.rubric.criteria[0]).toMatchObject({
      key: 'r-1',
      description: 'The resolver must preserve every declared profile.',
      intent: { request: 'The resolver must preserve every declared profile.' },
      model: 'Every declared profile is resolved deterministically.',
      method: 'Run the resolver parity test.',
      check: { kind: 'tests', files: ['packages/operator-core/lib/profile.test.ts'] },
      evidencePlane: 'tree',
      requiredScope: ['resolver', 'profiles'],
    });
  });

  it('keeps structured BAR context inside the frozen package cap after progressive trimming', () => {
    const snapshot = compactSnapshot({
      plan,
      rubric: {
        rubricId: 'acceptance-structured-large',
        title: 'Structured acceptance',
        criteria: Array.from({ length: 20 }, (_, index) => ({
          key: `r-${index + 1}`,
          title: `Criterion ${index + 1}`,
          intent: { request: `The resolver must preserve declared profile ${index + 1}.`.repeat(4) },
          model: `Every declared profile ${index + 1} is resolved deterministically.`.repeat(4),
          method: `Run the resolver parity test for profile ${index + 1}.`.repeat(4),
          check: { kind: 'tests', files: [`packages/operator-core/lib/profile-${index + 1}.test.ts`] },
          evidencePlane: 'tree',
          requiredScope: ['resolver', `profile-${index + 1}`],
        })),
      },
      audit,
      workItems,
    } as never);

    const rendered = boundedSnapshotJson(snapshot);
    expect(rendered.length).toBeLessThanOrEqual(ACCEPTANCE_SNAPSHOT_CAP_CHARS);
    const parsed = JSON.parse(rendered);
    expect(parsed.rubric.criteria[0]).toMatchObject({
      intent: { request: expect.stringContaining('resolver must preserve') },
      method: expect.stringContaining('resolver parity test'),
      check: { kind: 'tests', files: ['packages/operator-core/lib/profile-1.test.ts'] },
      evidencePlane: 'tree',
      requiredScope: ['resolver', 'profile-1'],
    });
  });
});

describe('resolveAcceptanceGraderDiscoveryExtraExclusions', () => {
  const SCOPE = { workspaceId: 'papercusp-workspace', planSlug: 'ship-the-thing' };
  const noDecliners = async () => [] as string[];
  const noImplementers = async () => [] as string[];

  it('adds current-revision work-item vetting critics to the discovery exclusion set', async () => {
    const readVettingCritics = vi.fn(async () => ({
      critics: ['su-work-item-critic', 'su-second-critic', 'su-work-item-critic'],
      cardsConsidered: 2,
    }));

    const result = await resolveAcceptanceGraderDiscoveryExtraExclusions(
      {
        rubricId: 'acceptance-ship-the-thing',
        revision: 2,
        proposedBy: 'su-author',
        createdBy: 'su-author',
      },
      'su-shipper',
      SCOPE,
      readVettingCritics,
      noDecliners,
      noImplementers,
    );

    expect(readVettingCritics).toHaveBeenCalledWith('acceptance-ship-the-thing', 2, null, null);
    expect(result).toEqual(['su-author', 'su-shipper', 'su-work-item-critic', 'su-second-critic']);
  });

  /**
   * EI-24402913315950329. `resolveAggregatedVettingCritics` classifies a vetting
   * card as current from (revision, criteriaHash, meaningRevision); the emit-side
   * sole-critic guard passes all three. The recruiter passed only the revision, so
   * on declared-gate-recovery-contract-2026-09-21 it read ZERO critics (measured:
   * cardsConsidered 0 vs the guard's 1) and routed the sole critic's fork, which
   * scorecards:emit then refuses. Forwarding all three is the parity contract.
   */
  it('forwards criteriaHash and meaningRevision to the critic read, exactly as the emit guard does', async () => {
    const readVettingCritics = vi.fn(async () => ({ critics: ['su-sole-critic'], cardsConsidered: 1 }));

    const result = await resolveAcceptanceGraderDiscoveryExtraExclusions(
      {
        rubricId: 'acceptance-ship-the-thing',
        revision: 15,
        criteriaHash: 'a9c28408',
        barContract: { meaningRevision: 15 },
      },
      null,
      SCOPE,
      readVettingCritics,
      noDecliners,
      noImplementers,
    );

    expect(readVettingCritics).toHaveBeenCalledWith('acceptance-ship-the-thing', 15, 'a9c28408', 15);
    expect(result).toEqual(['su-sole-critic']);
  });

  /**
   * EI-24402913315950329. The emit guard refuses every principal implementer
   * (`resolvePlanImplementerIdentities`: claimant history + completion/activation
   * auditors), but the recruiter never read that population — so an implementer
   * whose work-item was not sourced from the plan was routed as an "independent"
   * grader and forked. The recruiter must exclude the SAME population.
   */
  it('excludes the principal-implementer population the emit guard refuses', async () => {
    const readPlanImplementers = vi.fn(async () => ['su-completion-auditor', 'su-handed-off-claimant']);

    const result = await resolveAcceptanceGraderDiscoveryExtraExclusions(
      { rubricId: 'acceptance-ship-the-thing', revision: 1, createdBy: 'su-author' },
      null,
      SCOPE,
      async () => ({ critics: [], cardsConsidered: 0 }),
      noDecliners,
      readPlanImplementers,
    );

    expect(readPlanImplementers).toHaveBeenCalledWith('ship-the-thing', { workspaceId: 'papercusp-workspace' });
    expect(result).toEqual(['su-author', 'su-completion-auditor', 'su-handed-off-claimant']);
  });

  /** CONTROL — same fail-closed stance as the decline read below. */
  it('propagates an implementer-read fault instead of degrading to "no implementers"', async () => {
    await expect(
      resolveAcceptanceGraderDiscoveryExtraExclusions(
        { rubricId: 'acceptance-ship-the-thing', revision: 1 },
        null,
        SCOPE,
        async () => ({ critics: [], cardsConsidered: 0 }),
        noDecliners,
        async () => {
          throw new Error('acceptance_lineage_unreadable');
        },
      ),
    ).rejects.toThrow('acceptance_lineage_unreadable');
  });

  /**
   * WI-10002369. The router already honours `excludeOwners` (D-007(7): "a
   * decliner is excluded on the requester's re-call"); the acceptance path just
   * never populated it, so every `plans:set-plan-status` opened a virgin
   * cascade and re-offered the same agent.
   */
  it('adds agents who already DECLINED a grading cascade for this plan+rubric', async () => {
    const readPriorDecliners = vi.fn(async () => ['su-declined-once', 'su-declined-twice']);

    const result = await resolveAcceptanceGraderDiscoveryExtraExclusions(
      { rubricId: 'acceptance-ship-the-thing', revision: 3, proposedBy: 'su-author' },
      'su-shipper',
      SCOPE,
      async () => ({ critics: [], cardsConsidered: 0 }),
      readPriorDecliners,
      noImplementers,
    );

    expect(readPriorDecliners).toHaveBeenCalledWith(SCOPE, 'acceptance-ship-the-thing');
    expect(result).toContain('su-declined-once');
    expect(result).toContain('su-declined-twice');
  });

  it('collapses an agent who is both a vetting critic and a prior decliner to one entry', async () => {
    const result = await resolveAcceptanceGraderDiscoveryExtraExclusions(
      { rubricId: 'acceptance-ship-the-thing', revision: 1 },
      null,
      SCOPE,
      async () => ({ critics: ['su-both'], cardsConsidered: 1 }),
      async () => ['su-both'],
      noImplementers,
    );

    expect(result).toEqual(['su-both']);
  });

  /**
   * CONTROL. A swallowed decline read would silently stop excluding decliners —
   * indistinguishable from the bug itself — so the fault must propagate. The
   * caller's own degrade path mints a FRESH judge, which is the safe outcome.
   */
  it('propagates a decline-read fault instead of degrading to "nobody declined"', async () => {
    await expect(
      resolveAcceptanceGraderDiscoveryExtraExclusions(
        { rubricId: 'acceptance-ship-the-thing', revision: 1 },
        null,
        SCOPE,
        async () => ({ critics: [], cardsConsidered: 0 }),
        async () => {
          throw new Error('consult_post_meta unreachable');
        },
        noImplementers,
      ),
    ).rejects.toThrow('consult_post_meta unreachable');
  });
});

describe('resolveShipperId (EI-24402913315950329)', () => {
  /**
   * The ship gate re-launches recruitment under the SYSTEM actor (for launch
   * lineage). Without the carried caller, the shipper D-009 excludes resolved to
   * that system actor and the real shipper — the implementer — stayed routable.
   */
  it('prefers the carried real shipper over the system-actor identity of the rewritten ctx', async () => {
    const systemCtx = {
      workspaceId: 'papercusp-workspace',
      uiClientId: null,
      isSuperuser: false,
      isPowerUser: false,
      principal: { kind: 'system', slug: ACCEPTANCE_GRADING_SWEEP_ACTOR, workspaceId: 'papercusp-workspace' },
      ownerId: ACCEPTANCE_GRADING_SWEEP_ACTOR,
      acceptanceShipperOwnerId: 'su-implementer-shipper',
    };
    await expect(resolveShipperId(systemCtx as never)).resolves.toBe('su-implementer-shipper');
  });

  it('falls back to the ctx identity when nothing is carried', async () => {
    const callerCtxNoCarry = { workspaceId: 'papercusp-workspace', isSuperuser: true, uiClientId: 'su-direct-caller' };
    await expect(resolveShipperId(callerCtxNoCarry as never)).resolves.toBe('su-direct-caller');
  });
});

describe('isAcceptanceGradingRequestForPlan', () => {
  /**
   * WI-10003450 (measured 2026-09-27 on declared-gate-recovery-contract-2026-09-21):
   * an unassigned consult-expiry rubric-vetting review suppressed grader recruitment
   * because its instructions quote `scorecards:emit` and it names the plan.
   */
  const VETTING_REVIEW = {
    title:
      'Review needed (rubric-vetting) — Vet acceptance rubric `acceptance-ship-the-thing` rev 8 (criteriaHash a6a269f3…)',
    summary:
      'PULLABLE REVIEW (review-system-rework-reduction-2026-09-23 P-014). … The rubric author then records vetting ' +
      "with scorecards:emit { vettingWorkItem: '<this id>' }.\n\nOriginal request:\nVet acceptance rubric for " +
      'subject plan: ship-the-thing',
    createdBy: CONSULT_EXPIRY_REVIEW_AUTHOR,
  };

  it('does NOT treat a consult-expiry rubric-vetting review as a grading request', () => {
    expect(isAcceptanceGradingRequestForPlan(VETTING_REVIEW, 'ship-the-thing')).toBe(false);
  });

  /** CONTROL: the same prose authored by anyone else still matches, so the exclusion is
   * authorship-scoped rather than a weakened marker set. */
  it('still matches the same prose when it is not consult-expiry-authored', () => {
    expect(
      isAcceptanceGradingRequestForPlan({ ...VETTING_REVIEW, createdBy: 'su-delegator' }, 'ship-the-thing'),
    ).toBe(true);
  });

  it('still treats a consult-expiry ACCEPTANCE-GRADING review as a grading request', () => {
    expect(
      isAcceptanceGradingRequestForPlan(
        {
          title: 'Acceptance review-target reservation — ship-the-thing (acceptance-ship-the-thing)',
          summary: 'PULLABLE REVIEW … (acceptance-grading) …',
          createdBy: CONSULT_EXPIRY_REVIEW_AUTHOR,
        },
        'ship-the-thing',
      ),
    ).toBe(true);
    expect(
      isAcceptanceGradingRequestForPlan(
        {
          title: 'Review needed (acceptance-grading) — Grade plan ship-the-thing',
          summary: 'PULLABLE REVIEW …',
          createdBy: CONSULT_EXPIRY_REVIEW_AUTHOR,
        },
        'ship-the-thing',
      ),
    ).toBe(true);
  });

  it('pins the local consult-expiry author to the filer’s exported constant', async () => {
    const { CONSULT_EXPIRY_SWEEP_OWNER_ID } = await import('./consult/consult-expiry-adapters');
    expect(CONSULT_EXPIRY_REVIEW_AUTHOR).toBe(CONSULT_EXPIRY_SWEEP_OWNER_ID);
  });

  it('matches a non-lineage acceptance grade when the plan slug is in the title', () => {
    expect(
      isAcceptanceGradingRequestForPlan(
        {
          title: 'Independent acceptance grade (non-lineage): plan ship-the-thing',
          summary: 'Run scorecards:emit for the plan.',
          createdBy: 'su-delegator',
        },
        'ship-the-thing',
      ),
    ).toBe(true);
  });

  it('matches an acceptance-grading request when the plan slug is in the summary', () => {
    expect(
      isAcceptanceGradingRequestForPlan(
        {
          title: 'Please take this delegated task',
          summary: 'Acceptance-grading request for plan ship-the-thing; use scorecards:emit.',
          createdBy: 'su-delegator',
        },
        'ship-the-thing',
      ),
    ).toBe(true);
  });

  it('does not match an unrelated task that mentions the plan', () => {
    expect(
      isAcceptanceGradingRequestForPlan(
        { title: 'Implement ship-the-thing follow-up', summary: 'Fix the remaining plan item.', createdBy: 'su-delegator' },
        'ship-the-thing',
      ),
    ).toBe(false);
  });

  it('does not match a grading request for another plan', () => {
    expect(
      isAcceptanceGradingRequestForPlan(
        { title: 'Independent acceptance grade for another-plan', summary: 'Use scorecards:emit.', createdBy: 'su-delegator' },
        'ship-the-thing',
      ),
    ).toBe(false);
  });

  it('does not treat a review-target reservation as an in-flight grading request', () => {
    expect(
      isAcceptanceGradingRequestForPlan(
        {
          title: 'Acceptance review-target reservation — ship-the-thing (acceptance-ship-the-thing)',
          summary: 'Canonical reviewer assignment for acceptance target ship-the-thing at rubric revision 3.',
          createdBy: 'su-delegator',
        },
        'ship-the-thing',
      ),
    ).toBe(false);
  });

  it('never treats an acceptance-drain carry filing as a grading request, though it quotes the remedy (WI-10002453)', () => {
    expect(
      isAcceptanceGradingRequestForPlan(
        {
          title: "Unstick plan 'ship-the-thing' from awaiting-acceptance — blocked on acceptance_ungraded",
          summary:
            "Plan `ship-the-thing` is sitting in `awaiting-acceptance`. Gate refusal: independent grading has not " +
            "happened — a non-implementer must run scorecards:emit { rubricRef:'acceptance-ship-the-thing' }.",
          createdBy: 'system:acceptance-drain',
        },
        'ship-the-thing',
      ),
    ).toBe(false);
  });
});

/** Fixed clock for the in-flight grace window; fixtures date themselves against it. */
const NOW = Date.parse('2026-09-22T18:00:00.000Z');

function deps(launch: ReturnType<typeof vi.fn>) {
  const reviewReservation = {
    conditionKey: 'acceptance-review-target:v1:test-key',
    id: 'WI-review-target',
  };
  return {
    readPlan: vi.fn(async () => plan),
    getRubric: vi.fn(async () => rubric),
    getAudit: vi.fn(async () => audit),
    listWork: vi.fn(async () => workItems),
    launch: launch as never,
    listTasks: vi.fn(async () => []),
    killTask: vi.fn(async () => ({ ok: true })) as never,
    // WI-1699998: resolveAcceptanceGrader now reads settlement before discovery.
    // Default the shared harness to NOT-settled so every pre-existing case keeps
    // exercising the dispatch path deterministically, without reaching a database.
    readSettlement: vi.fn(async () => ({ settled: false, reason: 'no_author_acceptance' as const, rubricRevision: 7 })),
    lineageRelated: vi.fn(async () => false),
    reserveReviewTarget: vi.fn(async () => ({ ...reviewReservation, created: true })),
    // WI-10002459: a held grading request consults holder eligibility. Default to
    // "every holder may grade" so pre-existing held-request cases keep deduping,
    // and so no case reaches the org PG.
    readIneligibleHolders: vi.fn(async () => new Set<string>()),
    nowMs: () => NOW,
  };
}

describe('launchAcceptanceGrader', () => {
  it.each([launchAcceptanceGrader, resolveAcceptanceGrader])('refuses recruitment before reading the rubric or launching while build work is open', async recruit => {
    const launch = vi.fn();
    const d = deps(launch);
    d.readPlan.mockResolvedValue(planWithOpenBuildItems);
    const result = await recruit('ship-the-thing', {} as never, d);
    expect(result).toMatchObject({ state: 'failed', openBuildItems: ['P-001'] });
    expect(result.error).toContain('build_items_open');
    expect(d.getRubric).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('pins routine-scoped fresh and retry launches to the requested gateway model', async () => {
    const launch = vi.fn().mockResolvedValueOnce({
      data: { launch: { tasks: [{ taskId: 'pinned-quota', logPath: '/tmp/pinned-quota.log' }] } },
    }).mockResolvedValue({
      data: { launch: { tasks: [{ taskId: 'pinned-retry', logPath: '/tmp/pinned-retry.log' }] } },
    });
    const profile = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' };
    const discover = vi.fn();
    const openCascade = vi.fn();
    const result = await resolveAcceptanceGrader('ship-the-thing', { ...baseCtx, gradingLaunch: profile } as never, {
      ...deps(launch),
      discover,
      openCascade,
      readLogTail: (path) => path.includes('pinned-quota') ? "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model." : '',
    });
    expect(result).toMatchObject({ state: 'launched', reviewReservation: { id: 'WI-review-target' } });
    expect(discover).not.toHaveBeenCalled();
    expect(openCascade).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(2);
    for (const [args] of launch.mock.calls) {
      expect(args).toMatchObject({ ...profile, independent: true, members: [{ role: 'judge', stack: [...ACCEPTANCE_JUDGE_STACK], ...profile }] });
    }
  });

  it('launches exactly one fresh headless judge with stable identity and a parseable frozen snapshot', async () => {
    const launch = vi.fn(async (_args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: 'launched' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-1', logPath: '/tmp/judge.log' }] } },
    }));

    const first = await launchAcceptanceGrader('ship-the-thing', ctx, deps(launch));
    const second = await launchAcceptanceGrader('ship-the-thing', ctx, deps(launch));

    expect(launch).toHaveBeenCalledTimes(2);
    expect(first.state).toBe('launched');
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.label).toBe(second.label);
    expect(first.label).toMatch(/^acceptance-grader:acceptance-ship-the-thing:/);

    const args = launch.mock.calls[0][0];
    expect(args).toMatchObject({
      harness: 'papercusp',
      headless: true,
      account: 'auto',
      agent: 'claude',
      count: 1,
      independent: true,
      members: [{ role: 'judge', stack: [...ACCEPTANCE_JUDGE_STACK] }],
      label: first.label,
      idempotencyKey: first.idempotencyKey,
    });
    const brief = String(args.brief);
    expect(brief).toContain('subject:{ kind:"plan", ref:"ship-the-thing" }');
    const snapshot = JSON.parse(brief.split('FROZEN_ACCEPTANCE_CONTEXT=')[1]);
    expect(snapshot.plan).toMatchObject({ slug: 'ship-the-thing', version: 7, contentHash: 'content-hash-7' });
    expect(snapshot.rubric.rubricId).toBe('acceptance-ship-the-thing');
    expect(snapshot.audit.auditSeq).toBe(3);
    expect(snapshot.terminalWork[0]).toMatchObject({ id: 'WI-1', state: 'done' });
    expect(brief).toContain('first resolve the subject harness checkout');
    expect(brief).toContain('capability:read');
    expect(brief).toContain('git rev-parse <superproject-ref>:<nested-path>');
    expect(brief).toContain('not evidence of a fabricated citation');
    expect(brief).toContain('follow its recovery recipe with read-only Papercusp tools BEFORE returning NOT GRADED');
    expect(brief).toContain(ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE);
    expect(brief).toContain('frozenIdentity.planVersion/planContentHash');
    expect(brief.length).toBeLessThan(8_000);
  });

  it('refuses a fresh judge launch when the caller is in the rubric author lineage', async () => {
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'must not launch' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-forbidden' }] } },
    }));
    const lineageRelated = vi.fn(async () => true);

    const result = await launchAcceptanceGrader('ship-the-thing', callerCtx('su-implementer'), {
      ...deps(launch),
      lineageRelated,
    });

    expect(result).toMatchObject({ state: 'failed', idempotencyKey: '', label: '' });
    expect(result.error).toMatch(/launch refused.*su-implementer.*su-implementer/i);
    expect(lineageRelated).toHaveBeenCalledWith('su-implementer', 'su-implementer', { workspaceId: 'ws-test' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches an unrelated judge on the recruiting host with its restricted role intact', async () => {
    const launch = vi.fn(async (_args: unknown) => ({
      content: [{ type: 'text', text: 'launched' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-independent' }] } },
    }));
    const lineageRelated = vi.fn(async () => false);

    const result = await launchAcceptanceGrader('ship-the-thing', callerCtx('su-independent'), {
      ...deps(launch),
      lineageRelated,
    });

    expect(result.state).toBe('launched');
    expect(lineageRelated).toHaveBeenCalledWith('su-implementer', 'su-independent', { workspaceId: 'ws-test' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      mcpTarget: 'spawn-host', account: 'auto', independent: true, members: [{ role: 'judge', stack: [...ACCEPTANCE_JUDGE_STACK] }],
    });
  });

  it('uses createdBy when a legacy rubric has no proposedBy author', async () => {
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'must not launch' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-forbidden-legacy' }] } },
    }));
    const lineageRelated = vi.fn(async () => true);
    const legacyRubric = {
      rubricId: 'acceptance-ship-the-thing',
      title: 'Ship acceptance',
      proposedBy: null,
      createdBy: 'su-legacy-author',
      criteria: [{ key: 'outcome', title: 'Outcome works', description: 'The shipped outcome is verified.' }],
    } as never;

    const result = await launchAcceptanceGrader('ship-the-thing', callerCtx('su-legacy-author'), {
      ...deps(launch),
      getRubric: vi.fn(async () => legacyRubric),
      lineageRelated,
    });

    expect(result.state).toBe('failed');
    expect(lineageRelated).toHaveBeenCalledWith('su-legacy-author', 'su-legacy-author', { workspaceId: 'ws-test' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('WI-10002155: a dropped kickoff is TERMINAL from the launcher receipt alone — never reported as launched', async () => {
    const kill = vi.fn(async () => ({ ok: true }));
    const readLogTail = vi.fn(() => '');
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: {
        deduped: false,
        launch: {
          tasks: [
            {
              taskId: 'task-kickoff-dropped',
              logPath: '/tmp/judge.log',
              kickoffProof: {
                persisted: false,
                nativeRef: null,
                reason: 'kickoff-not-submitted:submit-verification-aborted-quota-blocked',
              },
            },
          ],
        },
      },
    }));

    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      readLogTail,
    });

    // The whole defect was reporting this as a live judge. It must never read 'launched'.
    expect(result.state).not.toBe('launched');
    expect(result.state).toBe('failed');
    expect(result.terminalRecovery?.codes).toContain('launch_kickoff_not_persisted');
    expect(result.terminalRecovery?.retiredTaskIds).toContain('task-kickoff-dropped');
    expect(kill).toHaveBeenCalledWith('task-kickoff-dropped', { includeSubtree: true, escalateAfterMs: 5_000 });
    // The structured receipt is authoritative, so the opt-OUT log scrape is not consulted.
    expect(readLogTail).not.toHaveBeenCalled();
  });

  it.each([
    ['an observed real turn', true],
    ['an unconfirmed start', null],
  ])('does not retire a task on kickoff-proof timeout with %s', async (_label, agentStarted) => {
    const kill = vi.fn(async () => ({ ok: true }));
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: {
        deduped: false,
        launch: {
          agentStarted,
          tasks: [
            {
              taskId: 'task-late-kickoff-proof',
              logPath: '/tmp/judge.log',
              kickoffProof: { persisted: false, nativeRef: null, reason: 'kickoff-proof-timeout' },
            },
          ],
        },
      },
    }));

    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      readLogTail: () => '',
    });

    expect(result.state).toBe('launched');
    expect(result.agentStarted).toBe(agentStarted);
    expect(result).not.toHaveProperty('terminalRecovery');
    expect(kill).not.toHaveBeenCalled();
  });

  it('WI-10002155: POSITIVE CONTROL — a persisted kickoff, and an ABSENT receipt, stay non-terminal', async () => {
    const kill = vi.fn(async () => ({ ok: true }));

    const healthyLaunch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: {
        deduped: false,
        launch: {
          tasks: [
            {
              taskId: 'task-healthy',
              logPath: '/tmp/judge.log',
              kickoffProof: { persisted: true, nativeRef: '/native/judge.jsonl', reason: null },
            },
          ],
        },
      },
    }));
    const healthy = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(healthyLaunch),
      killTask: kill as never,
      readLogTail: () => '',
    });
    expect(healthy.state).toBe('launched');

    // Absent receipt = no process was spawned (discovery 'assigned' launch). Not a failure.
    const noProofLaunch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-no-proof', logPath: '/tmp/judge.log' }] } },
    }));
    const noProof = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(noProofLaunch),
      killTask: kill as never,
      readLogTail: () => '',
    });
    expect(noProof.state).toBe('launched');

    expect(kill).not.toHaveBeenCalled();
  });

  it('WI-10002155: a dedupe onto a still-"running" zombie inside the 2h stale window is retired, not returned as deduped', async () => {
    // The measured failure: the judge parked on an unanswerable interactive
    // rate-limit picker, so it never exited. state stays 'running' => live=true,
    // and at 40min it is far inside ACCEPTANCE_GRADER_STALE_AFTER_MS (2h) =>
    // overAge=false. Before this fix that combination returned 'deduped'
    // forever and no plan could ever be graded.
    const kill = vi.fn(async () => ({ ok: true }));
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'already launched' }],
      data: {
        deduped: true,
        launch: {
          agentStarted: false,
          tasks: [
            {
              taskId: 'task-zombie',
              logPath: '/tmp/judge.log',
              kickoffProof: { persisted: false, nativeRef: null, reason: 'kickoff-proof-timeout' },
            },
          ],
        },
      },
    }));

    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      listTasks: vi.fn(async () => [
        {
          taskId: 'task-zombie',
          state: 'running',
          startedAt: '2026-08-25T00:00:00.000Z',
          endedAt: null,
        },
      ]) as never,
      killTask: kill as never,
      readLogTail: () => '',
      nowMs: () => Date.parse('2026-08-25T00:40:00.000Z'),
    });

    expect(result.state).not.toBe('deduped');
    expect(kill).toHaveBeenCalledWith('task-zombie', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(result.terminalRecovery?.codes).toContain('launch_kickoff_not_persisted');
  });

  it("EI-21923986145923904: passes through launch-agent's agentStarted verdict on a fresh launch, including the honest null case", async () => {
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: {
        deduped: false,
        launch: { agentStarted: null, tasks: [{ taskId: 'task-unconfirmed', logPath: '/tmp/judge.log' }] },
      },
    }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, deps(launch));
    expect(result.state).toBe('launched');
    // Must be present with the LITERAL value null (an honest "unconfirmed"),
    // not merely absent — `'agentStarted' in result` is the whole point of
    // this test: silently dropping this field is the regression.
    expect(result).toHaveProperty('agentStarted', null);
  });

  it('EI-21923986145923904: does not fabricate agentStarted when launch-agent never reported it', async () => {
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-1', logPath: '/tmp/judge.log' }] } },
    }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, deps(launch));
    expect(result.state).toBe('launched');
    expect(result).not.toHaveProperty('agentStarted');
  });

  it('surfaces launch-ledger dedupe as a deduped lifecycle with the original task identity', async () => {
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'already launched' }],
      data: { deduped: true, launch: { deduped: true, tasks: [{ taskId: 'task-1', logPath: '/tmp/judge.log' }] } },
    }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, deps(launch));
    expect(result).toMatchObject({ state: 'deduped', launch: { tasks: [{ taskId: 'task-1' }] } });
  });

  it.each([null, 'already_gone'] as const)('retires an over-age deduped judge (%s) and launches a deterministic fresh retry', async (error) => {
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      String(args.idempotencyKey).includes(':retry:')
        ? {
            content: [{ type: 'text', text: 'launched retry' }],
            data: { deduped: false, launch: { tasks: [{ taskId: 'task-fresh' }] } },
          }
        : {
            content: [{ type: 'text', text: 'already launched' }],
            data: { deduped: true, launch: { tasks: [{ taskId: 'task-stale' }] } },
          },
    );
    const kill = vi.fn(async () => error ? { ok: false, error } : { ok: true });
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      listTasks: vi.fn(async () => [
        {
          taskId: 'task-stale',
          state: 'running',
          startedAt: '2026-08-24T00:00:00.000Z',
          endedAt: null,
        },
      ]) as never,
      killTask: kill as never,
      nowMs: () => Date.parse('2026-08-25T00:00:00.000Z'),
    });

    expect(kill).toHaveBeenCalledWith('task-stale', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][0]).toMatchObject({
      idempotencyKey: expect.stringMatching(/:retry:[a-f0-9]{16}$/),
    });
    expect(result).toMatchObject({
      state: 'launched',
      launch: { tasks: [{ taskId: 'task-fresh' }] },
      staleRecovery: { retiredTaskIds: ['task-stale'], attempts: 2 },
    });
  });

  it.each([null, 'already_gone'] as const)('retires a quota-blocked Claude judge (%s) and performs one deterministic Codex fallback', async (error) => {
    const quotaLog = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      args.agent === 'codex'
        ? {
            content: [{ type: 'text', text: 'launched fallback' }],
            data: {
              deduped: false,
              launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/fallback.log' }] },
            },
          }
        : {
            isError: true,
            content: [{ type: 'text', text: 'launched primary' }],
            data: {
              deduped: false,
              launch: { tasks: [{ taskId: 'task-quota', logPath: '/tmp/quota.log' }] },
            },
          },
    );
    const kill = vi.fn(async () => error ? { ok: false, error } : { ok: true });
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      readLogTail: (path) => (path === '/tmp/quota.log' ? quotaLog : ''),
    });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('task-quota', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[0][0]).toMatchObject({
      mcpTarget: 'spawn-host', agent: 'claude', independent: true, members: [{ role: 'judge' }],
    });
    expect(launch.mock.calls[1][0]).toMatchObject({
      mcpTarget: 'spawn-host',
      account: 'auto',
      agent: 'codex',
      members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }],
      idempotencyKey: expect.stringMatching(/:recovery:[a-f0-9]{16}$/),
    });
    expect(result).toMatchObject({
      state: 'launched',
      launch: { tasks: [{ taskId: 'task-fallback' }] },
      terminalRecovery: {
        retiredTaskIds: ['task-quota'],
        attempts: 2,
        codes: ['model_quota_exhausted'],
        fallback: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' },
      },
    });
  });

  it('recovers a general grader from its native API-error turn while rejecting quoted error evidence', async () => {
    const error = '●API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s\n' +
      '✻ Worked for 1m 9s · done 9:30 PM\n❯';
    const nativeRecord = (apiError: boolean) => JSON.stringify({
      type: 'assistant', sessionId: 'native-primary', isApiErrorMessage: apiError, apiErrorStatus: 429,
      message: { role: 'assistant', stop_reason: 'stop_sequence' },
    });
    const makeLaunch = () => vi.fn(async (args: Record<string, unknown>) => ({
      data: { deduped: false, launch: { tasks: [args.agent === 'codex'
        ? { taskId: 'task-fallback' }
        : { taskId: 'task-native-error', logPath: '/tmp/native-error.log',
            kickoffProof: { persisted: true, nativeRef: '/tmp/native-primary.jsonl' },
            nativeSession: { backend: 'claude', sessionId: 'native-primary' } }] } },
    }));
    const launch = makeLaunch(), kill = vi.fn(async () => ({ ok: true }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch), killTask: kill as never, terminalLogMaxRechecks: 0,
      readLogTail: (path) => path.endsWith('.jsonl') ? nativeRecord(true) : error,
    });
    expect(result.terminalRecovery?.codes).toEqual(['inference_gateway_error']);
    expect(kill).toHaveBeenCalledWith('task-native-error', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][0]).toMatchObject({ agent: 'codex', account: 'auto' });

    const quoted = makeLaunch(), quotedKill = vi.fn(async () => ({ ok: true }));
    await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(quoted), killTask: quotedKill as never, terminalLogMaxRechecks: 0,
      readLogTail: (path) => path.endsWith('.jsonl') ? nativeRecord(false) : error,
    });
    expect(quoted).toHaveBeenCalledTimes(1);
    expect(quotedKill).not.toHaveBeenCalled();
  });

  it.each(['handle', 'legacy-receipt'] as const)('recovers a Codex capacity failure through the %s launch receipt', async (shape) => {
    const ownerId = 'su-capacity-judge';
    const sessionId = 'native-capacity-judge';
    const launch = vi.fn().mockResolvedValueOnce({ data: { deduped: true, launch: {
      agentStarted: true,
      freshVerdict: { sessions: [{ ownerId, sessionId }] },
      tasks: [{ taskId: 'task-capacity', ownerId, logPath: '/tmp/capacity.log',
        kickoffProof: { persisted: true, nativeRef: '/tmp/capacity.jsonl' },
        nativeSession: shape === 'handle' ? { backend: 'codex', ownerId, rolloutId: sessionId } : null }],
    } } }).mockResolvedValue({ data: { launch: { tasks: [{ taskId: 'task-recovered' }] } } });
    const kill = vi.fn(async () => ({ ok: true }));
    const native = [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete',
        error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity.' } } }),
    ].join('\n');
    const result = await launchAcceptanceGrader('ship-the-thing', {
      ...baseCtx, gradingLaunch: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' },
    } as never, { ...deps(launch), killTask: kill as never, terminalLogMaxRechecks: 0,
      readLogTail: path => path.endsWith('.jsonl') ? native : 'Working · GPT-6.1-Sol high' });
    expect(kill).toHaveBeenCalledWith('task-capacity', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ state: 'launched', terminalRecovery: {
      retiredTaskIds: ['task-capacity'], codes: ['inference_gateway_error'],
    } });
  });

  it.each(['resumed', 'successful', 'foreign-session'] as const)('keeps a Codex launch alive after %s native evidence', async (state) => {
    const ownerId = 'su-current-codex';
    const sessionId = 'current-rollout';
    const launch = vi.fn().mockResolvedValue({ data: { launch: {
      tasks: [{ taskId: 'keep-this-task', ownerId, logPath: 'current.log',
        kickoffProof: { nativeRef: 'current.jsonl' }, nativeSession: { backend: 'codex', ownerId, rolloutId: sessionId } }],
    } } });
    const native = [
      JSON.stringify({ type: 'session_meta', payload: { id: state === 'foreign-session' ? 'foreign' : sessionId } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', error: { codex_error_info: 'server_overloaded' } } }),
      ...(state === 'resumed' ? [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })] : []),
      ...(state === 'successful' ? [JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })] : []),
    ].join('\n');
    const kill = vi.fn();
    await launchAcceptanceGrader('ship-the-thing', ctx, { ...deps(launch), killTask: kill as never,
      terminalLogMaxRechecks: 0, readLogTail: path => path.endsWith('.jsonl') ? native : 'Working · GPT-6.1-Sol high' });
    expect(kill).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('refuses a terminal fallback when exact task retirement fails', async () => {
    const launch = vi.fn(async () => ({
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-refused', logPath: '/tmp/refused.log' }] } },
    }));
    const kill = vi.fn(async () => ({ ok: false, error: 'command_failed' }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch), killTask: kill as never, terminalLogMaxRechecks: 0,
      readLogTail: () => "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
    });
    expect(result).toMatchObject({ state: 'failed', error: expect.stringContaining('could not be retired: command_failed') });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('task-refused', { includeSubtree: true, escalateAfterMs: 5_000 });
  });

  it('rechecks the headless log after launch returns before deciding quota fallback', async () => {
    const quotaLog = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
    let primaryReads = 0;
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      args.agent === 'codex'
        ? {
            content: [{ type: 'text', text: 'launched fallback' }],
            data: { deduped: false, launch: { tasks: [{ taskId: 'task-fallback' }] } },
          }
        : {
            content: [{ type: 'text', text: 'launched primary' }],
            data: {
              deduped: false,
              launch: { tasks: [{ taskId: 'task-delayed-quota', logPath: '/tmp/delayed-quota.log' }] },
            },
          },
    );
    const kill = vi.fn(async () => ({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      sleep,
      terminalLogRecheckDelayMs: 0,
      readLogTail: (path) => {
        if (path !== '/tmp/delayed-quota.log') return '';
        primaryReads += 1;
        return primaryReads === 1 ? '' : quotaLog;
      },
    });

    expect(primaryReads).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('task-delayed-quota', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-delayed-quota'],
        codes: ['model_quota_exhausted'],
      },
    });
  });

  it('recovers a deduped judge from the current Claude session-limit screen', async () => {
    const sessionLimitLog =
      "\u001b[38;5;211mYou've hit your session limit · resets 5pm (America/New_York)\r\n" +
      '\u001b[38;5;246m/usage-credits to finish what you’re working on.\r\n' +
      '\u001b[38;5;231m⚠ /limit-reset to reset your session limit now · uses weekly limit · 1/week\u001b[0m';
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      args.agent === 'codex'
        ? {
            content: [{ type: 'text', text: 'launched fallback' }],
            data: { deduped: false, launch: { tasks: [{ taskId: 'task-fallback' }] } },
          }
        : {
            content: [{ type: 'text', text: 'deduped failed primary' }],
            data: {
              deduped: true,
              launch: { tasks: [{ taskId: 'task-session-limit', logPath: '/tmp/session-limit.log' }] },
            },
          },
    );
    const kill = vi.fn(async () => ({ ok: true }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      readLogTail: (path) => (path === '/tmp/session-limit.log' ? sessionLimitLog : ''),
    });

    expect(kill).toHaveBeenCalledWith('task-session-limit', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][0]).toMatchObject({
      account: 'auto',
      agent: 'codex',
      members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }],
      idempotencyKey: expect.stringMatching(/:recovery:[a-f0-9]{16}$/),
    });
    expect(result).toMatchObject({
      state: 'launched',
      launch: { tasks: [{ taskId: 'task-fallback' }] },
      terminalRecovery: {
        retiredTaskIds: ['task-session-limit'],
        codes: ['model_quota_exhausted'],
      },
    });
  });

  it('retires a Claude judge stuck on the connection screen and performs one deterministic Codex fallback', async () => {
    const connectingLog =
      'psu: cwd /tmp/papercusp — role-scoped MCP (judge); resume from here\n' +
      '/rc connecting…\n' +
      'psu: the MCP proxy is overloaded; retrying in 1s (attempt 2/5)…';
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      args.agent === 'codex'
        ? {
            content: [{ type: 'text', text: 'launched fallback' }],
            data: { deduped: false, launch: { tasks: [{ taskId: 'task-fallback' }] } },
          }
        : {
            content: [{ type: 'text', text: 'launched primary' }],
            data: {
              deduped: false,
              launch: { tasks: [{ taskId: 'task-connecting', logPath: '/tmp/connecting.log' }] },
            },
          },
    );
    const kill = vi.fn(async () => ({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      sleep,
      terminalLogMaxRechecks: 0,
      startupStallLogRecheckDelayMs: 0,
      startupStallLogMaxRechecks: 1,
      readLogTail: (path) => (path === '/tmp/connecting.log' ? connectingLog : ''),
    });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('task-connecting', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][0]).toMatchObject({
      account: 'auto',
      agent: 'codex',
      members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }],
      idempotencyKey: expect.stringMatching(/:recovery:[a-f0-9]{16}$/),
    });
    expect(result).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-connecting'],
        attempts: 2,
        codes: ['startup_connection_stalled'],
      },
    });
  });

  it('stops after the single terminal fallback when its model is quota-blocked too', async () => {
    const quotaLog = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
    const launch = vi.fn(async (args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: 'launched' }],
      data: {
        deduped: false,
        launch: {
          tasks: [
            {
              taskId: args.agent === 'codex' ? 'task-fallback-quota' : 'task-primary-quota',
              logPath: args.agent === 'codex' ? '/tmp/fallback-quota.log' : '/tmp/primary-quota.log',
            },
          ],
        },
      },
    }));
    const kill = vi.fn(async () => ({ ok: true }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      readLogTail: () => quotaLog,
    });

    expect(launch).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(result.state).toBe('failed');
    expect(result.error).toContain('one-retry ceiling');
    expect(result.terminalRecovery?.retiredTaskIds).toEqual(['task-primary-quota', 'task-fallback-quota']);
  });

  it('uses the same label prefix algebra that cleanup matches', () => {
    expect(acceptanceGraderLabelPrefix('Acceptance / Weird Name')).toBe('acceptance-grader:acceptance-weird-name:');
  });
});

describe('classifyAcceptanceGraderTerminalFailure', () => {
  it('does not treat a transient Codex capacity screen as a terminal audit failure', async () => {
    const raw = '\u001b[31m⚠ Selected model is at capacity. Please try a different model.\u001b[0m\r\n';
    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    await expect(detectAcceptanceGraderTerminalFailure('codex.log', {
      readLogTail: () => raw,
      allowInferenceGatewayError: true,
      allowGatewayErrorWithoutFooter: true,
      maxRechecks: 0,
      detectStartupStall: false,
    })).resolves.toBeNull();
  });

  it('does not retire a judge discussing or working after an old capacity screen', () => {
    const options = { allowInferenceGatewayError: true, allowGatewayErrorWithoutFooter: true };
    expect(classifyAcceptanceGraderTerminalFailure(
      'The report says Selected model is at capacity. Please try a different model.', options,
    )).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(
      '⚠ Selected model is at capacity. Please try a different model.\n• Called scorecards:get', options,
    )).toBeNull();
  });

  it('matches the exact terminal model-limit response through terminal control bytes', () => {
    const raw =
      "\u001b[31mYou've reached your Fable 5 limit.\u001b[0m\r\n" +
      'Run /usage-credits to continue or switch models with /model.';
    expect(classifyAcceptanceGraderTerminalFailure(raw)).toEqual({
      code: 'model_quota_exhausted',
      evidence: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
    });
  });

  it('matches the current Claude session-limit screen through terminal control bytes', () => {
    const raw =
      "\u001b[38;5;211mYou've hit your session limit · resets 5pm (America/New_York)\r\n" +
      '\u001b[38;5;246m/usage-credits to finish what you’re working on.\r\n' +
      '\u001b[38;5;231m⚠ /limit-reset to reset your session limit now · uses weekly limit · 1/week\u001b[0m';
    expect(classifyAcceptanceGraderTerminalFailure(raw)).toEqual({
      code: 'model_quota_exhausted',
      evidence:
        "You've hit your session limit · resets 5pm (America/New_York) /usage-credits to finish what you’re working on.",
    });
  });

  it('matches the standalone Claude weekly-limit headline only for a controlled caller', () => {
    const raw = "\u001b[38;5;211mYou've hit your weekly limit · resets Sep 10, 7am (America/New_York)\u001b[0m";

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowStandaloneWeeklyLimit: true })).toEqual({
      code: 'model_quota_exhausted',
      evidence: "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)",
    });
  });

  it.each([
    '✻Sautéed for 1m 48s · done 5:15 AM',
    '✻ Worked for 1m 57s · one 5:15 AM',
    '✻ Cogitated for 1m 19s ·dne 5:15 AM',
  ])('matches a completed credit balance refusal only for a controlled caller: %s', (footer) => {
    const screen = '\u001b[31m  ⎿ \u00a0Credit balance too low · Add funds: \u001b[0m\r\n';
    const raw = screen + `\r\n${footer}\r\n────────────────\r\n❯\u00a0`;

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toMatchObject({
      code: 'inference_gateway_error',
      evidence: expect.stringContaining('Credit balance too low · Add funds:'),
    });
    // An error still inside a turn, or one superseded by resumed work, is not
    // proof that the current mission stopped.
    expect(classifyAcceptanceGraderTerminalFailure(screen, { allowInferenceGatewayError: true })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw + '\n● I resumed and emitted the audit.', {
      allowInferenceGatewayError: true,
    })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw + '\n• Called scorecards:get', {
      allowInferenceGatewayError: true,
    })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure('The report quotes Credit balance too low · Add funds:', {
      allowInferenceGatewayError: true,
    })).toBeNull();
  });

  it.each([
    '⇢aviynw2-pi · ⟳ off · ▶auto · 8 peers ·mcp__pap…',
    '◇ su-966e6 · ⟳ off · ▶ auto · 11 peers · plans:get',
    '🔭 review · ◇ su-966e6 · ⟳ off · ▶ auto · 8 peers · rubrics:get',
  ])('ignores statusline tool names after a completed credit refusal: %s', (statusline) => {
    const raw = '\u001b[31m  ⎿ \u00a0Credit balance too low · Add funds: \u001b[0m\r\n'
      + '\r\n✻Sautéed for 1m 13s · done 7:19 AM\r\n────────────────\r\n❯\u00a0'
      + `\n${statusline}\n[psu] native-turn-failed agent=claude code=native_error retryable=false`;
    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toMatchObject({
      code: 'inference_gateway_error',
      evidence: expect.stringContaining('Credit balance too low · Add funds:'),
    });
    expect(classifyAcceptanceGraderTerminalFailure(raw + '\n• Called mcp__papercusp_su__scorecards_get', {
      allowInferenceGatewayError: true,
    })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw + '\n● I resumed the audit.', {
      allowInferenceGatewayError: true,
    })).toBeNull();
  });

  it('matches a completed inference-gateway 5xx turn only for a controlled caller', () => {
    const raw =
      '\u001b[38;5;220m●\u001b[3GAPI Error: 500 inference-gateway internal error. This is a server-side\r\n' +
      'issue, usually temporary — try again in a moment. If it persists, check your inference gateway ' +
      '(127.0.0.1:8788).\r\n' +
      '\u001b[38;5;246m✻ Cooked for 12m 56s · done 11:27 AM\u001b[0m\r\n❯';

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toEqual({
      code: 'inference_gateway_error',
      evidence:
        'API Error: 500 inference-gateway internal error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:8788). ✻ Cooked for 12m 56s · done',
    });
  });

  it('matches the completed invalidated Codex OAuth refresh 502 only for a controlled caller', () => {
    const raw =
      'API Error: unexpected status 502 Bad Gateway: ' +
      'inference-gateway: codex OAuth token refresh failed: codex-oauth-proxy: token refresh failed 401 ' +
      '(refresh_token_invalidated). Your session has ended. Please log in again.\r\n' +
      '✻ Cooked for 1m 2s · done 11:47 AM\r\n❯';

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toMatchObject({
      code: 'inference_gateway_error',
      evidence: expect.stringContaining('refresh_token_invalidated'),
    });

    const transientRefreshFailure = raw.replace('refresh_token_invalidated', 'refresh_timeout');
    expect(
      classifyAcceptanceGraderTerminalFailure(transientRefreshFailure, { allowInferenceGatewayError: true }),
    ).toBeNull();
  });

  it('matches a completed unsupported system-role turn only for a controlled caller', () => {
    const raw =
      "\u001b[38;5;220m●\u001b[3GAPI Error: 400 role 'system' is not supported on this model\u001b[0m\r\n" +
      '\u001b[38;5;246m✻ Cooked for 7m 59s · done 3:17 AM\u001b[0m\r\n❯';

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toEqual({
      code: 'inference_gateway_error',
      evidence: "API Error: 400 role 'system' is not supported on this model ✻ Cooked for 7m 59s · done",
    });
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace(' · done', ' · retrying'), {
        allowInferenceGatewayError: true,
      }),
    ).toBeNull();
  });

  it('matches the completed gateway pool-exhaustion screen only for a controlled caller', () => {
    const error =
      '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429) · inference-gateway: all accounts \r\n' +
      'throttled; retry after 60s\u001b[0m';
    const raw = error + '\r\n\r\n✻ Worked for 13m 45s · done 9:09 AM\r\n❯';

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(error, { allowInferenceGatewayError: true })).toBeNull();
    expect(
      classifyAcceptanceGraderTerminalFailure(error, {
        allowInferenceGatewayError: true,
        allowGatewayErrorWithoutFooter: true,
      }),
    ).toEqual({
      code: 'inference_gateway_error',
      evidence: 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s',
    });
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toEqual({
      code: 'inference_gateway_error',
      evidence:
        'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s ✻ Worked for 13m 45s · done',
    });
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace('Worked', 'Brewed'), {
        allowInferenceGatewayError: true,
      }),
    ).toEqual({
      code: 'inference_gateway_error',
      evidence:
        'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s ✻ Brewed for 13m 45s · done',
    });
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace('Worked', 'Crunched'), {
        allowInferenceGatewayError: true,
      }),
    ).toEqual({
      code: 'inference_gateway_error',
      evidence:
        'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s ✻ Crunched for 13m 45s · done',
    });
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace('Worked', 'Sautéed'), {
        allowInferenceGatewayError: true,
      }),
    ).toEqual({
      code: 'inference_gateway_error',
      evidence:
        'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s ✻ Sautéed for 13m 45s · done',
    });
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace(' · done', ' · retrying'), {
        allowInferenceGatewayError: true,
      }),
    ).toBeNull();
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace('inference-gateway: all accounts', 'another upstream'), {
        allowInferenceGatewayError: true,
      }),
    ).toBeNull();
  });

  it('matches the completed account-scoped gateway 429 screen only for a controlled caller', () => {
    const error =
      '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429)\r\n' +
      "This request would exceed your account's rate limit. Please try again later.\u001b[0m";
    const raw = error + '\r\n\r\n\u001b[38;5;246m✻ Baked for 8m 0s · done 9:01 AM\u001b[0m\r\n❯';

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(error, { allowInferenceGatewayError: true })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toEqual({
      code: 'inference_gateway_error',
      evidence:
        "API Error: Request rejected (429) This request would exceed your account's rate limit. Please try again later. ✻ Baked for 8m 0s · done",
    });
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace(' · done', ' · retrying'), {
        allowInferenceGatewayError: true,
      }),
    ).toBeNull();
  });

  it('matches Claude’s Churned terminal footer after an account-scoped gateway 429', () => {
    const raw =
      '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429)\r\n' +
      "This request would exceed your account's rate limit. Please try again later.\u001b[0m\r\n\r\n" +
      '\u001b[38;5;246m✻ Churned for 1m 2s · done 12:02 PM\u001b[0m\r\n❯';

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toEqual({
      code: 'inference_gateway_error',
      evidence:
        "API Error: Request rejected (429) This request would exceed your account's rate limit. Please try again later. ✻ Churned for 1m 2s · done",
    });
  });

  it('matches the completed account-paced gateway 429 screen only for a controlled caller', () => {
    const error =
      "\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429) · inference-gateway: account 'aviynw4' " +
      'paced/paused; retry after 60s\u001b[0m';
    const raw = error + '\r\n\r\n\u001b[38;5;246m✻ Cooked for 13m 41s · done 9:33 AM\u001b[0m\r\n❯';

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(error, { allowInferenceGatewayError: true })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowInferenceGatewayError: true })).toEqual({
      code: 'inference_gateway_error',
      evidence:
        "API Error: Request rejected (429) · inference-gateway: account 'aviynw4' paced/paused; retry after 60s ✻ Cooked for 13m 41s · done",
    });
  });

  it('matches the exact launcher-owned kickoff quota drop only for a controlled caller', () => {
    const receipt =
      'psu-pty-host: launch kickoff DROPPED for role-7a40cbec-960b-4db9-9bca-26020817a009 ' +
      '(submit verification aborted (quota-blocked) within 600000ms over 1 attempt(s))';
    const raw = `100% left · staging\u001b[22;3H\u001b[?2026l${receipt}\n`;

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowLauncherQuotaDrop: true })).toEqual({
      code: 'model_quota_exhausted',
      evidence: receipt,
    });
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace('launch kickoff', 'turn inject'), {
        allowLauncherQuotaDrop: true,
      }),
    ).toBeNull();
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace('quota-blocked', 'human-input'), {
        allowLauncherQuotaDrop: true,
      }),
    ).toBeNull();
  });

  // WI-10002903 (second leg): the host's NON-quota kickoff drop. Observed on
  // EI-24118203560334206 at 07:39Z: the drop landed after the launch receipt,
  // the PTY stayed live, and the live-task guard deduped to a judge that never
  // received its brief.
  it('matches the launcher-owned non-quota kickoff drop only for a controlled caller with no first-turn progress', () => {
    const receipt =
      'psu-pty-host: launch kickoff DROPPED for role-d5284217-0000-4000-8000-000000000000 ' +
      '(the child never settled to its prompt within 20000ms over 3 attempt(s))';
    const raw = `100% left · staging\u001b[22;3H\u001b[?2026l${receipt}\n`;

    expect(classifyAcceptanceGraderTerminalFailure(raw)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(raw, { allowLauncherKickoffDrop: true })).toEqual({
      code: 'launch_kickoff_dropped',
      evidence: receipt,
    });
    // Another host drop kind (a turn inject, not the launch kickoff) is not this signal.
    expect(
      classifyAcceptanceGraderTerminalFailure(raw.replace('launch kickoff', 'turn inject'), {
        allowLauncherKickoffDrop: true,
      }),
    ).toBeNull();
    // A judge that visibly entered its first turn is never retired on the receipt alone.
    expect(
      classifyAcceptanceGraderTerminalFailure(`• Called scorecards:get\n${raw}`, { allowLauncherKickoffDrop: true }),
    ).toBeNull();
    // The quota variant keeps its own opt-in, code and backoff.
    const quota = raw.replace('the child never settled to its prompt', 'submit verification aborted (quota-blocked)');
    expect(classifyAcceptanceGraderTerminalFailure(quota, { allowLauncherKickoffDrop: true })).toBeNull();
    expect(
      classifyAcceptanceGraderTerminalFailure(quota, { allowLauncherKickoffDrop: true, allowLauncherQuotaDrop: true }),
    ).toMatchObject({ code: 'model_quota_exhausted' });
  });

  it('does not treat broad error/limit prose in frozen evidence as a terminal mission failure', () => {
    expect(
      classifyAcceptanceGraderTerminalFailure('The plan documents a request limit and an error budget.'),
    ).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure("You've reached your test limit.")).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure("You've hit your session limit · resets 5pm")).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure('/limit-reset to reset your session limit now')).toBeNull();
    expect(
      classifyAcceptanceGraderTerminalFailure(
        'The incident report quotes API Error: 500 inference-gateway internal error without a terminal footer.',
        { allowInferenceGatewayError: true },
      ),
    ).toBeNull();
    expect(
      classifyAcceptanceGraderTerminalFailure(
        'The report quotes API Error: Request rejected (429) · inference-gateway: all accounts throttled; ' +
          'retry after 60s and says Sautéed for 10m 4s · done.',
        { allowInferenceGatewayError: true },
      ),
    ).toBeNull();
  });

  it('recognizes a completed grading-audit tool-surface refusal only for controlled briefs', () => {
    const refusal =
      "●I didn't grade scorecard EI-24161221398746479 and didn't emit a\n" +
      'grading-integrity audit, because this session has no way to reach the\nplatform.\n' +
      "The platform tools aren't loaded. This session has no Bash tool.\n" +
      '✻Worked for 25s · done 12:33 PM\n❯';
    expect(classifyAcceptanceGraderTerminalFailure(refusal)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(refusal.replace('✻Worked for 25s · done', 'still working'), {
      allowToolSurfaceRefusal: true,
    })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(refusal, { allowToolSurfaceRefusal: true }))
      .toMatchObject({ code: 'tool_surface_unavailable' });
    const observedRefusal =
      "● I haven't graded or emitted anything for scorecard EI-24234352612789401. " +
      "I couldn't read it, check the lease, or emit the audit.\n" +
      '- No platform tools loaded. I ran three tool searches and none found any ' +
      'mcp__papercusp__* tool.\n' +
      '✻ Cooked for 24s · done 7:57 AM\n❯';
    expect(classifyAcceptanceGraderTerminalFailure(observedRefusal)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(observedRefusal.replace('· done', '· working'), {
      allowToolSurfaceRefusal: true,
    })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(observedRefusal, { allowToolSurfaceRefusal: true }))
      .toMatchObject({ code: 'tool_surface_unavailable' });
  });

  it('recognizes the observed compacted auditor refusal without relying on an intact duration footer', () => {
    // WI-10003331: PTY redraws dropped spaces and the "r" in "for" while the
    // auditor explicitly declined its checks; its process remained alive.
    const refusal =
      "● I haven't audited scorecard EI-24349788243040613 and emitted no scorecard. My\n" +
      "sessiondoesn'thavethetoolstoreadthescorecardortoemitone.\n" +
      '- Tool search found nothing.\n' +
      '✻Crunched fo 12s ·done2:29 PM\n❯';
    expect(classifyAcceptanceGraderTerminalFailure(refusal)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(refusal, { allowToolSurfaceRefusal: true }))
      .toMatchObject({ code: 'tool_surface_unavailable' });
    expect(classifyAcceptanceGraderTerminalFailure(refusal.replace('·done2:29 PM', '·thinking'), {
      allowToolSurfaceRefusal: true,
    })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(refusal.replace(
      "sessiondoesn'thavethetoolstoreadthescorecardortoemitone.\n- Tool search found nothing.",
      'The tools are available; I am still examining the evidence.',
    ), { allowToolSurfaceRefusal: true })).toBeNull();
  });

  it('does not retire an auditor for a historical refusal followed by a new assistant answer', () => {
    const recovered =
      "● I haven't graded or emitted anything for scorecard EI-24234352612789401.\n" +
      'No platform tools loaded.\n✻ Cooked for 24s · done\n❯\n' +
      '● The tools are now available; I am reading the evidence for the audit.';
    expect(classifyAcceptanceGraderTerminalFailure(recovered, { allowToolSurfaceRefusal: true })).toBeNull();
  });
});

describe('classifyAcceptanceGraderStartupStall', () => {
  it('matches only the exact connection screen when no first-turn progress exists', () => {
    expect(
      classifyAcceptanceGraderStartupStall(
        'psu: role-scoped MCP (judge)\n/rc connecting…\n' +
          'psu: the MCP proxy is overloaded; retrying in 1s (attempt 2/5)…',
      ),
    ).toEqual({
      code: 'startup_connection_stalled',
      evidence: '/rc connecting… · the MCP proxy is overloaded; retrying in 1s (attempt 2/5)…',
    });
  });

  it('rejects generic prose and any tail that has entered the first turn', () => {
    expect(classifyAcceptanceGraderStartupStall('The plan describes a client connecting to MCP.')).toBeNull();
    expect(
      classifyAcceptanceGraderStartupStall('/rc connecting…\nWorking (4s)\npapercusp.tools:invoke({})'),
    ).toBeNull();
  });
});

describe('classifyAcceptanceGraderNoFirstTurnStall', () => {
  const nowMs = Date.parse('2026-09-30T12:00:00.000Z');
  const staleAfterMs = 15 * 60_000;
  const startedAt = new Date(nowMs - staleAfterMs - 1).toISOString();
  const logMtimeMs = nowMs - staleAfterMs - 1;

  it('requires an old task, a quiet log, and no first-turn progress', () => {
    expect(
      classifyAcceptanceGraderNoFirstTurnStall('Claude TUI tool picker still visible', {
        startedAt,
        logMtimeMs,
        nowMs,
        staleAfterMs,
      }),
    ).toMatchObject({ code: 'startup_first_turn_stalled' });

    expect(
      classifyAcceptanceGraderNoFirstTurnStall('Claude TUI tool picker still visible', {
        startedAt: new Date(nowMs - staleAfterMs + 1).toISOString(),
        logMtimeMs,
        nowMs,
        staleAfterMs,
      }),
    ).toBeNull();
    expect(
      classifyAcceptanceGraderNoFirstTurnStall('Claude TUI tool picker still visible', {
        startedAt,
        logMtimeMs: nowMs - staleAfterMs + 1,
        nowMs,
        staleAfterMs,
      }),
    ).toBeNull();
  });

  it('preserves tasks with first-turn progress and treats unreadable evidence as unknown', () => {
    expect(
      classifyAcceptanceGraderNoFirstTurnStall('Working (18m)\npapercusp.tools:invoke({})', {
        startedAt,
        logMtimeMs,
        nowMs,
        staleAfterMs,
      }),
    ).toBeNull();
    expect(
      classifyAcceptanceGraderNoFirstTurnStall('', {
        startedAt,
        logMtimeMs,
        nowMs,
        staleAfterMs,
      }),
    ).toBeNull();
    expect(
      classifyAcceptanceGraderNoFirstTurnStall('Claude TUI tool picker still visible', {
        startedAt,
        logMtimeMs: null,
        nowMs,
        staleAfterMs,
      }),
    ).toBeNull();
  });

  it('uses definite ended liveness to corroborate title redraws without a first turn', () => {
    const recentMtime = nowMs - 30_000;
    const input = { startedAt, logMtimeMs: recentMtime, nowMs, staleAfterMs };
    const tail = '\u001b]0;grader startup title update\u0007Claude TUI tool picker still visible';

    expect(isAcceptanceGraderNoFirstTurnLivenessCandidate(tail, input)).toBe(true);
    expect(classifyAcceptanceGraderNoFirstTurnStall(tail, input, { sessionState: 'ended' })).toMatchObject({
      code: 'startup_first_turn_stalled',
      evidence: expect.stringContaining('owner session ended'),
    });
  });

  it.each([null, 'live', 'parked', 'recorded', 'suspect'] as const)(
    'keeps a recent-title-redraw candidate when owner liveness is %s',
    (sessionState) => {
      const input = { startedAt, logMtimeMs: nowMs - 30_000, nowMs, staleAfterMs };
      expect(
        classifyAcceptanceGraderNoFirstTurnStall('Claude TUI tool picker still visible', input,
          sessionState === null ? null : { sessionState }),
      ).toBeNull();
    },
  );

  it('does not request liveness for fresh tasks, active turns, empty logs, or invalid clocks', () => {
    expect(
      isAcceptanceGraderNoFirstTurnLivenessCandidate('Claude TUI tool picker still visible', {
        startedAt: new Date(nowMs - staleAfterMs + 1).toISOString(),
        logMtimeMs: nowMs - 30_000,
        nowMs,
        staleAfterMs,
      }),
    ).toBe(false);
    expect(
      isAcceptanceGraderNoFirstTurnLivenessCandidate('Working (18m)\npapercusp.tools:invoke({})', {
        startedAt,
        logMtimeMs: nowMs - 30_000,
        nowMs,
        staleAfterMs,
      }),
    ).toBe(false);
    expect(
      isAcceptanceGraderNoFirstTurnLivenessCandidate('', {
        startedAt,
        logMtimeMs: nowMs - 30_000,
        nowMs,
        staleAfterMs,
      }),
    ).toBe(false);
    expect(
      isAcceptanceGraderNoFirstTurnLivenessCandidate('Claude TUI tool picker still visible', {
        startedAt: 'invalid',
        logMtimeMs: nowMs - 30_000,
        nowMs,
        staleAfterMs,
      }),
    ).toBe(false);
  });
});

describe('classifyAcceptanceGraderParkedWithoutEmit (WI-10005295)', () => {
  const nowMs = Date.parse('2026-10-02T04:00:00.000Z');
  const staleAfterMs = 15 * 60_000;
  const stale = {
    startedAt: new Date(nowMs - 40 * 60_000).toISOString(),
    logMtimeMs: nowMs - staleAfterMs - 1,
    nowMs,
    staleAfterMs,
  };
  // Shape of task 0muqeanqadsbkcjglk2's log tail (Codex auditor, 2026-10-02 03:40Z):
  // the turn ended without an emit and the session sat at its prompt.
  const codexParked =
    '\u001b[1m• Audit not emitted.\u001b[0m Current target state:\r\n' +
    '  • gradingAudit.state: pending  › Ask Codex to do anything   Working · GPT-5.6-Sol high · Context 86% left\r\n' +
    '  The required lease no longer matches because its reservation is absent.\r\n' +
    '  Worked for 20m 18s • 11:40 PMReady ·GPT-5.6-Sol high ·Context 86% left ·sta';
  const claudeParked =
    '● papercusp.tools:invoke(scorecards:get)\n● I stopped: the target card did not match the brief.\n\n' +
    '✻ Crunched for 4m 12s · done\n\n❯ ';
  // WI-10007246: task 0muygjfo21yekog81lv ended on this screen without a Worked footer.
  const codexTransportError =
    '\u001b[31m■ unexpected status 502 Bad Gateway: inference-gateway: codex OAuth upstream\r\n' +
    'failed: fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted\r\n' +
    'address: chatgpt.com:443, timeout: 10000ms)), url:\r\n' +
    'http://127.0.0.1:8788/v1/responses\u001b[0m  › Ask Codex to do anything   Ready · GPT-5.6-Sol high';

  it('recognizes a quiet Codex transport-error ending without a Worked footer', () => {
    expect(classifyAcceptanceGraderParkedWithoutEmit(codexTransportError, stale)).toMatchObject({
      code: 'parked_without_emit',
      evidence: expect.stringContaining('■unexpectedstatus502BadGateway'),
    });
  });

  it('keeps quoted transport errors, reconnecting turns, resumed turns and recently active tasks', () => {
    const errorWithoutPrompt = codexTransportError.slice(0, codexTransportError.indexOf('  ›'));
    for (const log of [
      `• Evidence quotes: ${errorWithoutPrompt}`,
      `${errorWithoutPrompt}\n• Reconnecting... 3/5 (esc to interrupt)\nWorking · GPT-5.6-Sol high`,
      `${codexTransportError}\nWorking · GPT-5.6-Sol high`,
      `${errorWithoutPrompt}\nWorking · GPT-5.6-Sol high\nReady · GPT-5.6-Sol high`,
    ]) {
      expect(classifyAcceptanceGraderParkedWithoutEmit(log, stale)).toBeNull();
    }
    expect(classifyAcceptanceGraderParkedWithoutEmit(codexTransportError, {
      ...stale, logMtimeMs: nowMs - 60_000,
    })).toBeNull();
  });

  it('classifies a Codex or Claude judge parked at its prompt past the TTL', () => {
    expect(classifyAcceptanceGraderParkedWithoutEmit(codexParked, stale)).toMatchObject({
      code: 'parked_without_emit',
      evidence: expect.stringContaining('Workedfor20m18s'),
    });
    expect(classifyAcceptanceGraderParkedWithoutEmit(claudeParked, stale)).toMatchObject({
      code: 'parked_without_emit',
    });
  });

  it('survives PTY redraws that strip the footer spacing', () => {
    expect(
      classifyAcceptanceGraderParkedWithoutEmit('● done reading\n✻Crunched fo 12s ·done2:29 PM\n❯', stale),
    ).toMatchObject({ code: 'parked_without_emit' });
  });

  it('keeps a judge whose log is still moving or whose task is young', () => {
    expect(
      classifyAcceptanceGraderParkedWithoutEmit(codexParked, { ...stale, logMtimeMs: nowMs - 60_000 }),
    ).toBeNull();
    expect(
      classifyAcceptanceGraderParkedWithoutEmit(codexParked, {
        ...stale,
        startedAt: new Date(nowMs - 5 * 60_000).toISOString(),
        logMtimeMs: nowMs - 4 * 60_000,
      }),
    ).toBeNull();
    expect(classifyAcceptanceGraderParkedWithoutEmit(codexParked, { ...stale, logMtimeMs: null })).toBeNull();
  });

  it('keeps a judge that never completed a turn or resumed after its last one', () => {
    // Mid-turn, no completed-turn marker yet.
    expect(
      classifyAcceptanceGraderParkedWithoutEmit('Working (18m)\npapercusp.tools:invoke({})', stale),
    ).toBeNull();
    // A later turn started after the footer (woken by a coord message).
    expect(
      classifyAcceptanceGraderParkedWithoutEmit(`${claudeParked}\n● Resuming the audit\n✢ Thinking… (esc to interrupt)`, stale),
    ).toBeNull();
    expect(
      classifyAcceptanceGraderParkedWithoutEmit(`${codexParked}\n  Working · GPT-5.6-Sol high · Context 80% left`, stale),
    ).toBeNull();
  });
});

describe('detectAcceptanceGraderTerminalFailure', () => {
  it.each(['failed', 'resumed', 'successful', 'foreign-session', 'partial'])(
    'uses exact native Codex completion evidence, preserving %s ordering', async (state) => {
      const native = [
        JSON.stringify({ type: 'session_meta', payload: { id: state === 'foreign-session' ? 'other' : 'native-codex' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete',
          error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.' } } }),
        ...(state === 'resumed' ? [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })] : []),
        ...(state === 'successful' ? [JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })] : []),
        ...(state === 'partial' ? ['{"type":'] : []),
      ].join('\n');
      const result = await detectAcceptanceGraderTerminalFailure('judge.log', {
        readLogTail: (path) => path.endsWith('.jsonl') ? native : '• Called scorecards:get\nWorking · GPT-5.6-Sol high',
        nativeTranscriptPath: 'judge.jsonl', nativeSessionId: 'native-codex', nativeBackend: 'codex',
        maxRechecks: 0, detectStartupStall: false,
      });
      if (state === 'failed') expect(result).toMatchObject({ code: 'inference_gateway_error' });
      else expect(result).toBeNull();
    },
  );

  it('classifies a completed one-shot audit refusal only when explicitly enabled', async () => {
    const finalAnswer =
      "● I didn't emit an audit, so scorecard EI-24208147289140038 is still unsettled. " +
      'The server refused my audit because this session runs on an older build.\n' +
      '✻ Worked for 4m 57s · done';
    const options = { readLogTail: () => finalAnswer, maxRechecks: 0, detectStartupStall: false };
    await expect(detectAcceptanceGraderTerminalFailure('/tmp/judge.log', options)).resolves.toBeNull();
    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', { ...options, allowGradingAuditRefusal: true }),
    ).resolves.toMatchObject({ code: 'grading_audit_refused' });
    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        ...options,
        allowGradingAuditRefusal: true,
        readLogTail: () => finalAnswer.replace(' · done', ' · retrying'),
      }),
    ).resolves.toBeNull();
    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        ...options,
        allowGradingAuditRefusal: true,
        readLogTail: () =>
          finalAnswer + '\n● I retried on the correct build and emitted the audit.\n✻ Worked for 1m 2s · done',
      }),
    ).resolves.toBeNull();
  });

  it('stops after the bounded recheck window when no terminal response arrives', async () => {
    const readLogTail = vi.fn(() => 'still booting');
    const sleep = vi.fn(async () => undefined);

    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        readLogTail,
        sleep,
        delayMs: 0,
        maxRechecks: 2,
      }),
    ).resolves.toBeNull();

    expect(readLogTail).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('lets a synchronous caller disable the longer startup-stall classification', async () => {
    const readLogTail = vi.fn(() => '/rc connecting…');
    const sleep = vi.fn(async () => undefined);

    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        readLogTail,
        sleep,
        delayMs: 0,
        maxRechecks: 0,
        detectStartupStall: false,
      }),
    ).resolves.toBeNull();

    expect(readLogTail).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits for the bounded startup window before classifying a persistent connection stall', async () => {
    const readLogTail = vi.fn(() => '/rc connecting…');
    const sleep = vi.fn(async () => undefined);

    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        readLogTail,
        sleep,
        delayMs: 0,
        maxRechecks: 0,
        startupStallDelayMs: 0,
        startupStallMaxRechecks: 2,
      }),
    ).resolves.toEqual({
      code: 'startup_connection_stalled',
      evidence: '/rc connecting…; no first-turn progress after 0ms bounded recheck',
    });

    expect(readLogTail).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('returns healthy as soon as the connecting tail shows first-turn progress', async () => {
    const readLogTail = vi
      .fn()
      .mockReturnValueOnce('/rc connecting…')
      .mockReturnValueOnce('/rc connecting…\nWorking (4s)\npapercusp.tools:invoke({})');

    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        readLogTail,
        sleep: async () => undefined,
        delayMs: 0,
        maxRechecks: 0,
        startupStallDelayMs: 0,
        startupStallMaxRechecks: 2,
      }),
    ).resolves.toBeNull();

    expect(readLogTail).toHaveBeenCalledTimes(2);
  });
});

describe('resolveAcceptanceGrader (P-011 / D-009 discovery-first)', () => {
  const freshLaunch = () =>
    vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-x' }] } },
    }));

  it('ASSIGNS the discovered grader MENU, opens ONE cascade, and never launches a fresh judge', async () => {
    const launch = freshLaunch();
    const openCascade = vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 }));
    const graders = [
      { ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const },
      { ownerId: 'su-second', score: 0.62, liveness: 'parked', via: 'floor' as const },
    ];
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders,
        routing: { selection: { min: 1, max: 2, selected: [] } },
        excluded: ['su-implementer'],
      })),
      openCascade: openCascade as never,
    });
    expect(result.state).toBe('assigned');
    expect(result.graders?.map((g) => g.ownerId)).toEqual(['su-independent', 'su-second']);
    expect(result.conversationId).toBe('conv-1');
    expect(result.excluded).toEqual(['su-implementer']);
    // DELIVERY receipt, NOT pickup (P-003 R-3 / plan D-011): `woke` counts an
    // ENQUEUED wake, and `wakeInstant` is the baseline that a LATER pickup
    // observation requires the grader's own activity to post-date. Asserted as an
    // exhaustive KEY SET rather than relaxed to objectContaining, so this stays a
    // detector: a future field added to the receipt fails here instead of landing
    // unnoticed.
    expect(Object.keys(result.notified ?? {}).sort()).toEqual(['dispatch', 'wakeInstant', 'woke']);
    expect(result.notified?.woke).toBe(1);
    expect(result.notified?.dispatch).toBe('new');
    expect(Date.parse(result.notified?.wakeInstant ?? '')).not.toBeNaN();
    expect(launch).not.toHaveBeenCalled();
    // The WHOLE menu is handed to the cascade, but only ONE open call is made:
    // grader 2 is the cascade's to wake after grader 1 replies/declines/expires
    // (D-003), never a parallel second wake here.
    expect(openCascade).toHaveBeenCalledTimes(1);
    expect(openCascade).toHaveBeenCalledWith(
      expect.objectContaining({
        planSlug: 'ship-the-thing',
        harnessSlug: 'papercusp',
        rubricId: 'acceptance-ship-the-thing',
        graders,
        reservation: {
          conditionKey: 'acceptance-review-target:v1:test-key',
          id: 'WI-review-target',
        },
      }),
      ctx,
    );
    expect(result.reviewReservation).toEqual({
      conditionKey: 'acceptance-review-target:v1:test-key',
      id: 'WI-review-target',
    });
  });

  // WI-10003786: the grader is FORKED, never woken in place, and a re-call finds the
  // cascade an earlier call opened. The receipt must say so, name the fork to watch,
  // and NOT stamp a fresh wakeInstant — measured live, a re-call's re-stamped instant
  // read as a new unanswered wake and led the author to hand-wake the parked source.
  it('an idempotent re-call reports dispatch:existing + the answering fork, with no fresh wakeInstant', async () => {
    const launch = freshLaunch();
    const openCascade = vi.fn(async () => ({
      conversationId: 'conv-live',
      woke: 0,
      status: 'existing' as const,
      answeringOwnerId: 'su-fork-of-independent',
    }));
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.71, liveness: 'parked', via: 'floor' as const }],
        routing: { selection: { min: 1, max: 1, selected: [] } },
        excluded: [],
      })),
      openCascade: openCascade as never,
    });
    expect(result.state).toBe('assigned');
    expect(result.conversationId).toBe('conv-live');
    expect(result.notified).toEqual({
      woke: 0,
      dispatch: 'existing',
      answeringOwnerId: 'su-fork-of-independent',
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('a fresh dispatch names its answering fork alongside the wakeInstant baseline', async () => {
    const openCascade = vi.fn(async () => ({
      conversationId: 'conv-new',
      woke: 1,
      status: 'active' as const,
      answeringOwnerId: 'su-fork-1',
    }));
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(freshLaunch()),
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const }],
        routing: { selection: { min: 1, max: 1, selected: [] } },
        excluded: [],
      })),
      openCascade: openCascade as never,
    });
    expect(Object.keys(result.notified ?? {}).sort()).toEqual(['answeringOwnerId', 'dispatch', 'wakeInstant', 'woke']);
    expect(result.notified?.dispatch).toBe('new');
    expect(result.notified?.answeringOwnerId).toBe('su-fork-1');
  });

  it('falls through to a fresh judge when every selected transcript is undispatchable', async () => {
    const launch = freshLaunch();
    const openCascade = vi.fn(async () => ({
      conversationId: 'conv-exhausted',
      woke: 0,
      status: 'exhausted' as const,
    }));
    const graders = [
      { ownerId: 'su-ended', score: 0.71, liveness: 'ended', via: 'floor' as const },
      { ownerId: 'su-declined', score: 0.62, liveness: 'parked', via: 'floor' as const },
    ];

    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders,
        routing: { selection: { min: 1, max: 2, selected: [] } },
        excluded: ['su-implementer'],
      })),
      openCascade: openCascade as never,
    });

    expect(result.state).toBe('launched');
    expect(result.freshReason).toBe('all_eligible_unselectable');
    expect(result.excluded).toEqual(['su-implementer']);
    expect(openCascade).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('reserves the typed target once and carries it into a fresh-judge brief', async () => {
    const launch = freshLaunch();
    const reserveReviewTarget = vi.fn(async (target: Record<string, unknown>) => ({
      conditionKey: `acceptance-review-target:v1:${String(target.revision)}`,
      id: 'WI-review-target',
      created: true,
    }));

    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      reserveReviewTarget: reserveReviewTarget as never,
      discover: vi.fn(async () => ({
        verdict: 'fresh' as const,
        graders: [],
        excluded: [],
        freshReason: 'all_eligible_unselectable' as const,
      })),
    });

    expect(result.state).toBe('launched');
    expect(reserveReviewTarget).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-test',
        harnessSlug: 'papercusp',
        planSlug: 'ship-the-thing',
        rubricId: 'acceptance-ship-the-thing',
        revision: 3,
      },
      expect.objectContaining({ title: expect.stringContaining('review-target reservation') }),
    );
    const launchCalls = launch.mock.calls as unknown as Array<[{ brief?: unknown }]>;
    const launchArgs = launchCalls[0]?.[0];
    expect(String(launchArgs?.brief)).toContain('acceptance-review-target:v1:3');
    expect(String(launchArgs?.brief)).toContain('WI-review-target');
    expect(result.reviewReservation).toEqual({
      conditionKey: 'acceptance-review-target:v1:3',
      id: 'WI-review-target',
    });
  });

  // ── WI-1699998: an already-decided grading is never re-routed ──
  // These are the wiring tests for the settled-grading guard. Deleting the guard
  // from resolveAcceptanceGrader makes the first one fail on all four assertions —
  // which is the point: the predicate having its own unit tests in
  // acceptance-grading-authority.test.ts proves the RULE, and only these prove it
  // is actually CONSULTED. A guard nothing calls is the failure mode this whole
  // plan lineage exists to prevent.
  it('SETTLED grading → dispatches NOTHING: no discovery, no cascade, no fresh judge (WI-1699998)', async () => {
    const launch = freshLaunch();
    const discover = vi.fn();
    const openCascade = vi.fn(async () => ({ conversationId: 'conv-must-not-open', woke: 1 }));
    const settlement = {
      settled: true,
      reason: 'settled' as const,
      rubricRevision: 7,
      independentCardId: 'EI-independent',
      acceptanceCardId: 'EI-author-call',
    };

    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      readSettlement: vi.fn(async () => settlement),
      discover: discover as never,
      openCascade: openCascade as never,
    });

    expect(result.state).toBe('settled');
    expect(result.settlement).toEqual(settlement);
    // Each of these is a distinct cost a re-route would have paid. The middle two
    // are the expensive ones: opening the cascade WAKES a fresh independent grader,
    // and D-009 independence makes that pool non-replenishable.
    expect(discover).not.toHaveBeenCalled();
    expect(openCascade).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('an open acceptance-grading task suppresses duplicate dispatch (EI-22678191183363422)', async () => {
    const launch = freshLaunch();
    const discover = vi.fn();
    const openCascade = vi.fn(async () => ({ conversationId: 'conv-must-not-open', woke: 1 }));
    const listWork = vi.fn(async () => [
      {
        id: 'WI-grading-open',
        kind: 'task',
        state: 'open',
        title: 'Independent acceptance grade: plan ship-the-thing',
        summary: 'Use scorecards:emit as the non-lineage grader.',
        createdBy: 'su-delegator',
        assignee: null,
        createdAt: new Date(NOW - 5 * 60_000).toISOString(),
        lastProgressAt: null,
      },
    ]);

    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      listWork: listWork as never,
      discover: discover as never,
      openCascade: openCascade as never,
    });

    // EI-24032136322947460: the holder rides out with the dedupe, so a refusal can
    // name who must grade — here nobody, which is exactly what the shipper must see.
    expect(result).toMatchObject({
      state: 'deduped',
      existingWorkItemId: 'WI-grading-open',
      existingWorkItemAssignee: null,
    });
    expect(listWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task', notTerminal: true, q: 'ship-the-thing' }),
    );
    expect(discover).not.toHaveBeenCalled();
    expect(openCascade).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  describe('carrying the independent-verification section onto a deduped request (WI-6554700010008552)', () => {
    const BRIEF = 'INDEPENDENT VERIFICATION — do this BEFORE scorecards:emit. 1 live/deployed outcome bar(s)';
    const openRequest = () =>
      vi.fn(async () => [
        {
          id: 'WI-grading-open',
          kind: 'task',
          state: 'open',
          title: 'Independent acceptance grade: plan ship-the-thing',
          summary: 'Use scorecards:emit as the non-lineage grader.',
          createdBy: 'su-delegator',
          assignee: null,
          createdAt: new Date(NOW - 5 * 60_000).toISOString(),
          lastProgressAt: null,
        },
      ]);
    const briefCtx = { ...baseCtx, acceptanceIndependentVerificationBrief: `  ${BRIEF}\n` } as never;

    it('appends the carried section to the request it deduped onto, and still launches nothing', async () => {
      const launch = freshLaunch();
      const appendVerificationBrief = vi.fn(async () => 'appended' as const);
      const result = await resolveAcceptanceGrader('ship-the-thing', briefCtx, {
        ...deps(launch),
        listWork: openRequest() as never,
        discover: vi.fn() as never,
        appendVerificationBrief,
      });
      expect(result).toMatchObject({
        state: 'deduped',
        existingWorkItemId: 'WI-grading-open',
        verificationBriefOnRequest: 'appended',
      });
      // Trimmed exactly as a fresh launch's brief is, and scoped to the plan's row.
      expect(appendVerificationBrief).toHaveBeenCalledTimes(1);
      expect(appendVerificationBrief).toHaveBeenCalledWith('WI-grading-open', BRIEF, {
        harness: 'papercusp',
        workspaceId: 'ws-test',
      });
      expect(launch).not.toHaveBeenCalled();
    });

    it('touches nothing when the gate carried no section (a grading-code refusal)', async () => {
      const appendVerificationBrief = vi.fn(async () => 'appended' as const);
      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: openRequest() as never,
        discover: vi.fn() as never,
        appendVerificationBrief,
      });
      expect(result.state).toBe('deduped');
      expect(appendVerificationBrief).not.toHaveBeenCalled();
      expect('verificationBriefOnRequest' in result).toBe(false);
    });

    it('a failed append is reported, not thrown: the dedupe still stands', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const launch = freshLaunch();
      const result = await resolveAcceptanceGrader('ship-the-thing', briefCtx, {
        ...deps(launch),
        listWork: openRequest() as never,
        discover: vi.fn() as never,
        appendVerificationBrief: vi.fn(async () => {
          throw new Error('thread store down');
        }),
      });
      expect(result).toMatchObject({
        state: 'deduped',
        existingWorkItemId: 'WI-grading-open',
        verificationBriefOnRequest: 'failed',
      });
      expect(launch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('WI-grading-open'));
      warn.mockRestore();
    });

    describe('appendIndependentVerificationBriefToRequest', () => {
      const post = (body: string) => ({ id: 1, thread_id: 't', author_id: 'x', body, created_ts: '2026-10-11T00:00:00Z' });
      const window = (bodies: string[]) => ({ posts: bodies.map(post), total: bodies.length, topics: [], createdAt: '' });

      it('posts the section as the recruiter when the thread lacks it', async () => {
        const readThread = vi.fn(async () => window(['an unrelated comment']));
        const comment = vi.fn(async () => post(BRIEF));
        await expect(
          appendIndependentVerificationBriefToRequest(
            'WI-grading-open',
            BRIEF,
            { harness: 'papercusp', workspaceId: 'ws-test' },
            { readThread: readThread as never, comment: comment as never },
          ),
        ).resolves.toBe('appended');
        expect(readThread).toHaveBeenCalledWith('WI-grading-open', 50, 'papercusp');
        expect(comment).toHaveBeenCalledWith('WI-grading-open', BRIEF, ACCEPTANCE_GRADER_RECRUITER_ACTOR, {
          workspaceId: 'ws-test',
          harness: 'papercusp',
        });
      });

      it('does not post twice: an identical section already on the thread is left alone', async () => {
        const comment = vi.fn();
        await expect(
          appendIndependentVerificationBriefToRequest(
            'WI-grading-open',
            BRIEF,
            { harness: 'papercusp' },
            { readThread: vi.fn(async () => window([`prefix\n${BRIEF}`])) as never, comment: comment as never },
          ),
        ).resolves.toBe('already-present');
        expect(comment).not.toHaveBeenCalled();
      });

      it('a section whose gaps changed is posted again', async () => {
        const comment = vi.fn(async () => post(`${BRIEF}\n- bar 2`));
        await expect(
          appendIndependentVerificationBriefToRequest(
            'WI-grading-open',
            `${BRIEF}\n- bar 2`,
            {},
            { readThread: vi.fn(async () => window([BRIEF])) as never, comment: comment as never },
          ),
        ).resolves.toBe('appended');
        expect(comment).toHaveBeenCalledTimes(1);
      });

      it('throws when the request does not exist', async () => {
        await expect(
          appendIndependentVerificationBriefToRequest('WI-gone', BRIEF, {}, {
            readThread: vi.fn(async () => null) as never,
            comment: vi.fn() as never,
          }),
        ).rejects.toThrow('WI-gone');
      });
    });
  });

  it('a blocked acceptance-grading task suppresses duplicate dispatch while unrelated plan work does not', async () => {
    const launch = freshLaunch();
    const openCascade = vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 }));
    const discover = vi.fn(async () => ({
      verdict: 'assigned' as const,
      graders: [{ ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const }],
      routing: { selection: { min: 1, max: 2, selected: [] } },
      excluded: [],
    }));
    const listWork = vi.fn(async () => [
      {
        id: 'WI-unrelated',
        kind: 'task',
        state: 'blocked',
        title: 'Implement ship-the-thing follow-up',
        summary: 'The plan still needs a code change.',
      },
      {
        id: 'WI-grading-blocked',
        kind: 'task',
        state: 'blocked',
        title: 'Delegated task',
        summary: 'Acceptance-grading request for plan ship-the-thing; scorecards:emit is required.',
        createdBy: 'su-delegator',
        assignee: 'su-independent',
        createdAt: new Date(NOW - 30 * 86_400_000).toISOString(),
        lastProgressAt: null,
      },
    ]);

    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      listWork: listWork as never,
      discover: discover as never,
      openCascade: openCascade as never,
    });

    expect(result).toMatchObject({ state: 'deduped', existingWorkItemId: 'WI-grading-blocked' });
    expect(discover).not.toHaveBeenCalled();
    expect(openCascade).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  describe('only an IN-FLIGHT grading request suppresses recruitment (WI-10002453)', () => {
    const assigned = () =>
      vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const }],
        routing: { selection: { min: 1, max: 2, selected: [] } },
        excluded: [],
      }));

    it('recruits past an UNHELD request that has outlived the grace window', async () => {
      const discover = assigned();
      const listWork = vi.fn(async () => [
        {
          id: 'WI-grading-abandoned',
          kind: 'task',
          state: 'open',
          title: 'Independent acceptance grade: plan ship-the-thing',
          summary: 'Use scorecards:emit as the non-lineage grader.',
          createdBy: 'su-delegator',
          assignee: null,
          createdAt: new Date(NOW - ACCEPTANCE_GRADING_REQUEST_UNHELD_GRACE_MS - 60_000).toISOString(),
          lastProgressAt: null,
        },
      ]);

      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: listWork as never,
        discover: discover as never,
        openCascade: vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 })) as never,
      });

      expect(result.state).not.toBe('deduped');
      expect(discover).toHaveBeenCalled();
    });

    it('recruits past the acceptance-drain carry item HELD by the implementer', async () => {
      const discover = assigned();
      const listWork = vi.fn(async () => [
        {
          id: 'WI-drain-carry',
          kind: 'task',
          state: 'blocked',
          title: "Unstick plan 'ship-the-thing' from awaiting-acceptance — blocked on acceptance_ungraded",
          summary: "Gate refusal: a non-implementer must run scorecards:emit { rubricRef:'acceptance-ship-the-thing' }.",
          createdBy: 'system:acceptance-drain',
          assignee: 'su-implementer',
          createdAt: new Date(NOW - 60_000).toISOString(),
          lastProgressAt: new Date(NOW - 60_000).toISOString(),
        },
      ]);

      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: listWork as never,
        discover: discover as never,
        openCascade: vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 })) as never,
      });

      expect(result.state).not.toBe('deduped');
      expect(discover).toHaveBeenCalled();
    });
  });

  describe('an unheld request for a SUPERSEDED rubric revision does not suppress recruitment (WI-10006620)', () => {
    const assigned = () =>
      vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const }],
        routing: { selection: { min: 1, max: 2, selected: [] } },
        excluded: [],
      }));

    // The shape that stranded a real plan: a review-target reservation that the
    // consult-expiry path converted into a pullable review. Its summary quotes
    // scorecards:emit, so it matches the identity markers, and only its payload
    // records which rubric revision it targets. The rubric fixture is revision 3.
    const pullableReview = (targetRevision: number | null, assignee: string | null = null) => ({
      id: 'WI-pullable-review',
      kind: 'task',
      state: 'open',
      title: 'Acceptance review-target reservation — ship-the-thing (acceptance-ship-the-thing)',
      summary:
        'PULLABLE REVIEW. To review: claim this item and grade the rubric with scorecards:emit, ' +
        'with concrete evidence per criterion.',
      createdBy: null,
      assignee,
      createdAt: new Date(NOW - 60_000).toISOString(),
      lastProgressAt: null,
      payload: {
        acceptanceReviewTarget: {
          planSlug: 'ship-the-thing',
          rubricId: 'acceptance-ship-the-thing',
          revision: targetRevision,
          harnessSlug: 'papercusp',
          workspaceId: 'papercusp-workspace',
        },
      },
    });

    it('the fixture matches the identity markers and is fresh, so these cases exercise the revision rule', () => {
      expect(isAcceptanceGradingRequestForPlan(pullableReview(2) as never, 'ship-the-thing')).toBe(true);
      expect(isInFlightAcceptanceGradingRequest(pullableReview(3) as never, 'ship-the-thing', NOW, undefined, 3)).toBe(
        true,
      );
    });

    it('treats an unheld request filed for an older revision as not in flight', () => {
      expect(isInFlightAcceptanceGradingRequest(pullableReview(2) as never, 'ship-the-thing', NOW, undefined, 3)).toBe(
        false,
      );
    });

    it('keeps the previous behaviour when either revision is unknown', () => {
      expect(isInFlightAcceptanceGradingRequest(pullableReview(2) as never, 'ship-the-thing', NOW)).toBe(true);
      expect(isInFlightAcceptanceGradingRequest(pullableReview(2) as never, 'ship-the-thing', NOW, undefined, null)).toBe(
        true,
      );
      expect(
        isInFlightAcceptanceGradingRequest(pullableReview(null) as never, 'ship-the-thing', NOW, undefined, 3),
      ).toBe(true);
      expect(
        isInFlightAcceptanceGradingRequest(
          { ...pullableReview(2), payload: null } as never,
          'ship-the-thing',
          NOW,
          undefined,
          3,
        ),
      ).toBe(true);
    });

    it('still lets an eligible HOLDER of an older-revision request suppress (they can emit against the current one)', () => {
      expect(
        isInFlightAcceptanceGradingRequest(pullableReview(2, 'su-independent') as never, 'ship-the-thing', NOW, new Set(), 3),
      ).toBe(true);
    });

    it('recruits past an unheld request for an older revision', async () => {
      const discover = assigned();

      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: vi.fn(async () => [pullableReview(2)]) as never,
        discover: discover as never,
        openCascade: vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 })) as never,
      });

      expect(result.state).not.toBe('deduped');
      expect(discover).toHaveBeenCalled();
    });

    it('still dedupes onto an unheld request for the CURRENT revision (positive control)', async () => {
      const discover = assigned();

      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: vi.fn(async () => [pullableReview(3)]) as never,
        discover: discover as never,
        openCascade: vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 })) as never,
      });

      expect(result).toMatchObject({ state: 'deduped', existingWorkItemId: 'WI-pullable-review' });
      expect(discover).not.toHaveBeenCalled();
    });
  });

  describe('a HELD request suppresses only when its holder could grade it (WI-10002459)', () => {
    const assigned = () =>
      vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const }],
        routing: { selection: { min: 1, max: 2, selected: [] } },
        excluded: [],
      }));
    // The live instance's shape (WI-10002232): agent-filed, so rule 1 does not
    // fire; held, so the grace window is never consulted; and its prose matches
    // the identity markers because it tells its holder to REQUEST a grade.
    const carryItem = {
      id: 'WI-agent-carry',
      kind: 'task',
      state: 'blocked',
      title: 'Remediate degraded acceptance BAR evidence for the ship-the-thing plan',
      summary:
        'Produce fresh evidence for every degraded BAR of plan ship-the-thing, bind it to the current rubric ' +
        'revision, then request a new non-author acceptance grade.',
      createdBy: 'su-rubric-author',
      assignee: 'su-carrier',
      createdAt: new Date(NOW - 60_000).toISOString(),
      lastProgressAt: new Date(NOW - 60_000).toISOString(),
    };

    it('the fixture really is a matching identity, so these cases exercise the holder rule, not the markers', () => {
      expect(isAcceptanceGradingRequestForPlan(carryItem, 'ship-the-thing')).toBe(true);
      expect(isInFlightAcceptanceGradingRequest(carryItem, 'ship-the-thing', NOW)).toBe(true);
    });

    it('recruits past an agent-filed carry item whose holder is excluded from grading (the shipper)', async () => {
      const discover = assigned();
      const readIneligibleHolders = vi.fn(async () => new Set(['su-carrier']));

      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: vi.fn(async () => [carryItem]) as never,
        readIneligibleHolders: readIneligibleHolders as never,
        discover: discover as never,
        openCascade: vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 })) as never,
      });

      expect(result.state).not.toBe('deduped');
      expect(discover).toHaveBeenCalled();
      expect(readIneligibleHolders).toHaveBeenCalledWith(expect.anything(), expect.anything(), ctx, ['su-carrier']);
    });

    it('still dedupes when the holder is an ELIGIBLE grader (EI-22678191183363422 stays protected)', async () => {
      const discover = assigned();
      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: vi.fn(async () => [{ ...carryItem, id: 'WI-live-grading', assignee: 'su-independent' }]) as never,
        readIneligibleHolders: vi.fn(async () => new Set(['su-carrier'])) as never,
        discover: discover as never,
      });

      expect(result).toMatchObject({
        state: 'deduped',
        existingWorkItemId: 'WI-live-grading',
        existingWorkItemAssignee: 'su-independent',
      });
      expect(discover).not.toHaveBeenCalled();
    });

    it('fails OPEN when the eligibility read throws: recruits rather than suppressing behind an unverified holder', async () => {
      const discover = assigned();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: vi.fn(async () => [carryItem]) as never,
        readIneligibleHolders: vi.fn(async () => {
          throw new Error('org PG unreachable');
        }) as never,
        discover: discover as never,
        openCascade: vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 })) as never,
      });

      expect(result.state).not.toBe('deduped');
      expect(discover).toHaveBeenCalled();
      // The fault leaves a breadcrumb, so a dispatch the guard could not vet is
      // distinguishable from one it vetted.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('holder eligibility read failed'));
      warn.mockRestore();
    });

    it('does not read eligibility at all when no HELD request matched', async () => {
      const readIneligibleHolders = vi.fn(async () => new Set<string>());
      await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(freshLaunch()),
        listWork: vi.fn(async () => [{ ...carryItem, assignee: null }]) as never,
        readIneligibleHolders: readIneligibleHolders as never,
        discover: assigned() as never,
        openCascade: vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 })) as never,
      });

      expect(readIneligibleHolders).not.toHaveBeenCalled();
    });
  });

  describe('ineligibleGradingHolders', () => {
    it('marks a holder who is directly in the exclusion set', () => {
      expect([...ineligibleGradingHolders(['su-shipper', 'su-grader'], ['su-shipper'], new Map())]).toEqual(['su-shipper']);
    });

    it('marks a holder in the same D-008 party as an excluded identity, though the ids differ', () => {
      const partyKeys = new Map([
        ['su-author', 'party-a'],
        ['su-author-rebound', 'party-a'],
        ['su-grader', 'su-grader'],
      ]);
      expect([...ineligibleGradingHolders(['su-author-rebound', 'su-grader'], ['su-author'], partyKeys)]).toEqual([
        'su-author-rebound',
      ]);
    });

    it('leaves a holder of a distinct party eligible', () => {
      expect(ineligibleGradingHolders(['su-grader'], ['su-author'], new Map()).size).toBe(0);
    });
  });

  it('NOT-settled grading → dispatches exactly as before, and records the reading it acted on', async () => {
    const launch = freshLaunch();
    const openCascade = vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 }));
    const notSettled = { settled: false, reason: 'no_author_acceptance' as const, rubricRevision: 7 };

    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      readSettlement: vi.fn(async () => notSettled),
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const }],
        routing: { selection: { min: 1, max: 2, selected: [] } },
        excluded: [],
      })),
      openCascade: openCascade as never,
    });

    expect(result.state).toBe('assigned');
    expect(openCascade).toHaveBeenCalledTimes(1);
    // Recorded on the DISPATCH path too, so a read that failed open is visible
    // rather than looking identical to a genuine "nothing was graded yet".
    expect(result.settlement).toEqual(notSettled);
  });

  it('a settlement read that THROWS fails OPEN — the grading is dispatched, never suppressed', async () => {
    const launch = freshLaunch();
    const openCascade = vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 }));

    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      readSettlement: vi.fn(async () => {
        throw new Error('pg down');
      }) as never,
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const }],
        routing: { selection: { min: 1, max: 2, selected: [] } },
        excluded: [],
      })),
      openCascade: openCascade as never,
    });

    expect(result.state).toBe('assigned');
    expect(openCascade).toHaveBeenCalledTimes(1);
    // Failing open is not the same as failing SILENTLY: a dispatch that happened
    // because the guard could not run must be distinguishable from one that
    // happened because nothing was graded yet.
    expect(result.settlement).toEqual({ settled: false, reason: 'read_threw' });
  });

  // WI-10003286: the settlement read must exclude EVERY cohort-stale independent card the
  // ship gate carried — the named one AND the older ones it also excluded. Passing only
  // the named id let the read fall back to an older excluded card and report "settled".
  it('hands the settlement read the WHOLE carried cohort-stale set, de-duplicated', async () => {
    const launch = freshLaunch();
    const readSettlement = vi.fn(async () => ({
      settled: false,
      reason: 'stale_independent_card' as const,
      rubricRevision: 7,
    }));
    await resolveAcceptanceGrader(
      'ship-the-thing',
      {
        ...baseCtx,
        acceptanceStaleGradingScorecardId: 'EI-named-stale',
        acceptanceStaleGradingScorecardIds: ['EI-named-stale', ' EI-older-stale ', ''],
      } as never,
      {
        ...deps(launch),
        readSettlement: readSettlement as never,
        discover: vi.fn(async () => ({ verdict: 'fresh' as const, graders: [], excluded: [] })) as never,
      },
    );
    const opts = (readSettlement.mock.calls[0] as unknown as [string, unknown, { staleCardIds?: string[] }])[2];
    expect([...(opts.staleCardIds ?? [])].sort()).toEqual(['EI-named-stale', 'EI-older-stale']);
  });

  // WI-10003286 (measured 05:40Z on managed-agent-capability-contract-and-native-cutover):
  // with every cohort-stale id carried, the identity-free settlement read STILL answered
  // "settled" off a 09-22 'role-…' card the gate never counted as independent. A gate
  // refusal is the authority on admissibility, so on that path the read is not consulted.
  it('a ship-gate refusal (no admissible grading) is never overridden by the settlement read', async () => {
    const launch = freshLaunch();
    const readSettlement = vi.fn(async () => ({
      settled: true,
      reason: 'settled' as const,
      rubricRevision: 15,
      independentCardId: 'EI-role-card-the-gate-excluded',
      acceptanceCardId: 'EI-author-verdict',
    }));
    const result = await resolveAcceptanceGrader(
      'ship-the-thing',
      { ...baseCtx, acceptanceGateFoundNoAdmissibleGrading: true } as never,
      {
        ...deps(launch),
        readSettlement: readSettlement as never,
        discover: vi.fn(async () => ({ verdict: 'fresh' as const, graders: [], excluded: [] })) as never,
      },
    );
    expect(readSettlement).not.toHaveBeenCalled();
    expect(result.state).not.toBe('settled');
    expect(result.settlement).toEqual({ settled: false, reason: 'gate_found_no_admissible_grading' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  // CONTROL: without the gate's verdict (the periodic sweep path), a settled reading still
  // suppresses the dispatch — WI-1699998's pool-burning re-route stays closed.
  it('CONTROL: without the gate flag a settled reading still suppresses dispatch', async () => {
    const launch = freshLaunch();
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      readSettlement: vi.fn(async () => ({
        settled: true,
        reason: 'settled' as const,
        rubricRevision: 15,
        independentCardId: 'EI-independent',
        acceptanceCardId: 'EI-author-verdict',
      })) as never,
    });
    expect(result.state).toBe('settled');
    expect(launch).not.toHaveBeenCalled();
  });

  it('carriedStaleGradingCardIds: named id alone, array alone, union, and nothing', () => {
    expect(carriedStaleGradingCardIds({ acceptanceStaleGradingScorecardId: 'EI-a' })).toEqual(['EI-a']);
    expect(carriedStaleGradingCardIds({ acceptanceStaleGradingScorecardIds: ['EI-b'] })).toEqual(['EI-b']);
    expect(
      carriedStaleGradingCardIds({
        acceptanceStaleGradingScorecardId: 'EI-a',
        acceptanceStaleGradingScorecardIds: ['EI-a', 'EI-b'],
      }),
    ).toEqual(['EI-a', 'EI-b']);
    expect(carriedStaleGradingCardIds({})).toEqual([]);
    expect(carriedStaleGradingCardIds(undefined)).toEqual([]);
  });

  it('discovery says fresh → falls through to the frozen judge launch, carrying the reason', async () => {
    const launch = freshLaunch();
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'fresh' as const,
        graders: [],
        excluded: ['su-implementer'],
        freshReason: 'all_eligible_unselectable' as const,
      })),
    });
    expect(result.state).toBe('launched');
    expect(result.freshReason).toBe('all_eligible_unselectable');
    expect(result.excluded).toEqual(['su-implementer']);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('surfaces zero-eligible escalation while preserving the fresh-judge fallback', async () => {
    const launch = freshLaunch();
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'fresh' as const,
        graders: [],
        excluded: ['su-implementer'],
        eligibility: { eligibleCount: 0, qualifiedCount: 0, measured: true, reason: 'zero_eligible' as const },
        escalation: { code: 'zero_eligible' as const },
        freshReason: 'no_eligible_non_excluded' as const,
      })),
    });
    expect(result.state).toBe('launched');
    expect(result.freshReason).toBe('no_eligible_non_excluded');
    expect(result.eligibility).toEqual({
      eligibleCount: 0,
      qualifiedCount: 0,
      measured: true,
      reason: 'zero_eligible',
    });
    expect(result.escalation).toEqual({ code: 'zero_eligible' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('discovery FAULT → still launches (discovery is a service, never a new failure mode)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const launch = freshLaunch();
      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(launch),
        discover: vi.fn(async () => {
          throw new Error('router down');
        }),
      });
      expect(result.state).toBe('launched');
      expect(result.freshReason).toBe('discovery_error');
      expect(launch).toHaveBeenCalledTimes(1);
      // EI-21925808460100711: the fallback must stay silent-to-the-caller
      // (no new failure mode), but the failure itself must no longer be
      // discarded — it is surfaced on the lifecycle AND logged so it is
      // distinguishable from a genuinely empty eligible pool.
      expect(result.discoveryError).toContain('router down');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls[0]?.[0] as string;
      expect(logged).toContain('[acceptance-grader]');
      expect(logged).toContain('ship-the-thing');
      expect(logged).toContain('acceptance-ship-the-thing');
      expect(logged).toContain('router down');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('discovery FAULT before the rubric resolves → still logs, without a rubric id', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const launch = freshLaunch();
      const readPlan = vi.fn(async () => plan);
      readPlan.mockRejectedValueOnce(new Error('pg down'));
      const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
        ...deps(launch),
        readPlan,
      });
      expect(result.state).toBe('launched');
      expect(result.freshReason).toBe('discovery_error');
      expect(result.discoveryError).toContain('pg down');
      const logged = warnSpy.mock.calls[0]?.[0] as string;
      expect(logged).toContain('ship-the-thing');
      expect(logged).not.toContain('rubric');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a cascade-open failure does not demote the assignment, and reports no conversation', async () => {
    const launch = freshLaunch();
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.7, liveness: 'parked', via: 'floor' as const }],
        routing: {},
        excluded: [],
      })),
      openCascade: vi.fn(async () => {
        throw new Error('coord down');
      }) as never,
    });
    expect(result.state).toBe('assigned');
    expect(result.notified).toEqual({ woke: 0 });
    // No conversationId: a failed open must not read as a delivered assignment
    // with a thread that does not exist.
    expect(result.conversationId).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('buildAssignedAcceptanceGraderBrief (cross-hive reachability)', () => {
  it('pins both the plan read and deterministic scorecard checks to the subject harness', () => {
    const brief = buildAssignedAcceptanceGraderBrief('ship-the-thing', 'papercusp', 'acceptance-ship-the-thing');

    expect(brief).toContain('plans:get { slug:"ship-the-thing", harness:"papercusp" }');
    expect(brief).toContain(
      'scorecards:emit { rubricRef:"acceptance-ship-the-thing", targetHive:"papercusp", subject:{ kind:"plan", ref:"ship-the-thing" }, ratings:',
    );
    expect(brief).toContain("subject tree rather than the grader's checkout");
    expect(brief).toContain('gitlink');
    expect(brief).toContain('cwd` set to the nested submodule');
  });

  it('keeps the legacy operator-plan form when no concrete harness exists', () => {
    const brief = buildAssignedAcceptanceGraderBrief('operator-plan', null, 'operator-rubric');

    expect(brief).toContain('plans:get { slug:"operator-plan" }');
    expect(brief).toContain('subject:{ kind:"plan", ref:"operator-plan" }');
    expect(brief).not.toContain('targetHive:');
  });
});

// EI-22978598482930667: psu refuses a launch whose auto-route pool is provably
// walled (exit 78) instead of spawning a doomed agent. Nothing classified that
// refusal, so a fire-and-forget dispatcher receipted it as a LAUNCHED judge and
// held its reservation until the TTL — measured on 2526 launches over the whole
// grading-audit log population. It is also the only terminal receipt in the
// system that carries a machine-readable recovery instant.
describe('classifyAcceptanceGraderTerminalFailure — launcher walled-pool refusal', () => {
  // Verbatim shape from the real fleet logs.
  const REFUSAL =
    'psu: REFUSING TO LAUNCH — Codex auto-route pool is fully walled: 0 of 7 ChatGPT accounts ' +
    'serviceable; earliest known recovery 2026-09-15T01:25:13.000Z. Every model call would fail ' +
    'fast with 429, so this launch can only burn quota.';

  it('stays UNCLASSIFIED without the opt-in, so a general acceptance brief cannot self-trip on quoted evidence', () => {
    expect(classifyAcceptanceGraderTerminalFailure(REFUSAL)).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(REFUSAL, { allowLauncherQuotaDrop: true })).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure(REFUSAL, { allowStandaloneWeeklyLimit: true })).toBeNull();
  });

  it('classifies as a quota wall with the opt-in, and its evidence slice PRESERVES the recovery instant', () => {
    const failure = classifyAcceptanceGraderTerminalFailure(REFUSAL, {
      allowLauncherWalledPoolRefusal: true,
    });

    expect(failure).toMatchObject({ code: 'model_quota_exhausted' });
    // The load-bearing property: the dispatcher's reset-aware backoff reads the
    // instant back out of this string, so the 400-char slice must never drop it.
    expect(failure?.evidence).toContain('2026-09-15T01:25:13.000Z');
    expect((failure?.evidence ?? '').length).toBeLessThanOrEqual(400);
  });

  it('keeps the instant even when the refusal preamble runs to the bound of the match', () => {
    const padded =
      'psu: REFUSING TO LAUNCH — Codex auto-route pool is fully walled across every configured ' +
      'account tier and no serviceable credential remains for this route at all; ' +
      'earliest known recovery 2026-09-15T01:25:13.000Z. Every model call would fail fast.';
    const failure = classifyAcceptanceGraderTerminalFailure(padded, { allowLauncherWalledPoolRefusal: true });

    expect(failure?.evidence).toContain('2026-09-15T01:25:13.000Z');
    expect((failure?.evidence ?? '').length).toBeLessThanOrEqual(400);
  });

  it('still classifies the refusal variant that carries no recoverable instant', () => {
    const unknownHorizon =
      'psu: REFUSING TO LAUNCH — Codex auto-route pool is fully walled: 0 of 7 accounts ' +
      'serviceable; earliest recovery unknown. Every model call would fail fast with 429.';
    const failure = classifyAcceptanceGraderTerminalFailure(unknownHorizon, {
      allowLauncherWalledPoolRefusal: true,
    });

    // Terminal either way — the missing instant degrades the backoff to its
    // default window, it does not make the refusal survivable.
    expect(failure).toMatchObject({ code: 'model_quota_exhausted' });
    expect(failure?.evidence).toContain('earliest recovery unknown');
  });
});
