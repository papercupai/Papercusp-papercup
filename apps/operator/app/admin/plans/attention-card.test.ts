// @vitest-environment node
/**
 * attention-card tests — the AttentionItem → card-spec mapper (P-010) and the
 * durable dispatch parity (P-013). The dispatch must reproduce the behavior
 * of the (retired) OtherDetail / InboxItemActions handlers exactly: same
 * backend helper, same args, and the resume-on-resolve / no-resume-on-drop
 * distinction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./plans-api', () => ({
  resolveEscalation: vi.fn(async () => ({ ok: true })),
  ackCoordMessage: vi.fn(async () => ({ ok: true })),
  setItemStatus: vi.fn(async () => ({ ok: true, oldStatus: 'needs-human', newStatus: 'done', itemId: 'P-7' })),
  addPlanDecision: vi.fn(async () => ({ ok: true, decisionId: 'D-1', slug: 'p' })),
  triageAttentionItem: vi.fn(async () => ({ ok: true })),
  decideStandingApproval: vi.fn(async () => ({ ok: true })),
  resolveConversationAnswer: vi.fn(async () => ({ ok: true, state: 'resolved' })),
  dismissImprovement: vi.fn(async () => ({ ok: true, closed: true })),
  deliverInboxReply: vi.fn(async () => ({ ok: true, live: true, delivered: true, woken: 1 })),
  clearWorkItemOwnerGate: vi.fn(async () => ({ ok: true })),
  closeWorkItem: vi.fn(async () => ({ ok: true })),
  clearSessionGate: vi.fn(async () => ({ ok: true })),
  retractStandingFact: vi.fn(async () => ({ ok: true })),
}));

import {
  attentionItemToCardSpec,
  isNavigateAction,
  resolveAttentionAction,
  answerAttentionItem,
  replyToAttentionItem,
} from './attention-card';
import {
  resolveEscalation,
  ackCoordMessage,
  setItemStatus,
  addPlanDecision,
  triageAttentionItem,
  decideStandingApproval,
  resolveConversationAnswer,
  dismissImprovement,
  deliverInboxReply,
  retractStandingFact,
} from './plans-api';
import type { AttentionItem } from './plans-api';
import { coordEscalationToAttention, conversationToAttention } from '../../../../../packages/operator-core/lib/attention/adapters';
import { dropDuplicateQuestionConversations } from '../../../../../packages/operator-core/lib/attention/sources';

/** The resume-on-resolve nudge is now a floor-debounced Queen wake through the
 *  palette bridge (the legacy /harness/:slug/launch run-loop kick is retired). */
const expectQueenWake = () =>
  expect(fetch).toHaveBeenCalledWith(
    '/api/agent-mcp/run-tool',
    expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"pot:wake"'),
    }),
  );

function item(overrides: Partial<AttentionItem>): AttentionItem {
  return {
    id: 'x',
    kind: 'plan-item',
    source: 'plan',
    harnessSlug: 'h',
    planSlug: 'p',
    itemRef: 'P-7',
    title: 'Title',
    body: 'Body text',
    status: 'needs-human',
    importance: 'normal',
    tier: 'decision',
    needsHuman: true,
    ownerAgentId: null,
    ownerLabel: null,
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [],
    ref: { kind: 'plan-item' },
    ...overrides,
  } as AttentionItem;
}

const escWithOptions = item({
  kind: 'coord-escalation',
  status: 'open',
  actions: [{ id: 'resolve', label: 'Resolve', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'coord-escalation', msgId: 'm1', options: [{ id: 'retry', label: 'Retry' }, { id: 'pause', label: 'Pause' }] },
});
const escNoOptions = item({
  kind: 'coord-escalation',
  status: 'open',
  actions: [{ id: 'resolve', label: 'Resolve', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'coord-escalation', msgId: 'm9', options: [] },
});
// P-009 (owner-inbox-single-pane-2026-07-17) E2E finding: a coord-escalation
// asked BY a live agent (ownerAgentId set) — the AskChoiceCard/P-008 path a
// P-001 <ask> block mirror actually produces.
const escWithAsker = item({
  kind: 'coord-escalation',
  status: 'open',
  ownerAgentId: 'su-probe-1',
  actions: [{ id: 'resolve', label: 'Resolve', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'coord-escalation', msgId: 'm10', options: [{ id: 'ok', label: 'OK' }] },
});
const message = item({
  kind: 'coord-message',
  status: 'message',
  actions: [{ id: 'ack', label: 'Acknowledge', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'coord-message', msgId: 'm2' },
});
const needsHuman = item({
  actions: [
    { id: 'answer', label: 'Answer' },
    { id: 'mark-done', label: 'Resolve', primary: true },
    { id: 'drop', label: 'Drop' },
    { id: 'chat', label: 'Chat' },
  ],
  ref: { kind: 'plan-item', slug: 'p', itemId: 'P-7' },
});
const operatorReport = item({
  id: 'operator-report:turn-1',
  kind: 'operator-report',
  source: 'operator',
  harnessSlug: undefined,
  planSlug: undefined,
  title: 'Fleet status',
  body: 'plain-text fallback dump',
  status: 'report',
  tier: 'activity',
  needsHuman: false,
  ownerLabel: 'Operator',
  actions: [{ id: 'resolve', label: 'Resolve', primary: true }],
  ref: { kind: 'operator-report', turnId: 'turn-1', conversationId: 'c-1' },
  report: {
    title: 'Fleet status',
    plans: [{ title: 'Rate-limit v2', status: 'active', items: [{ text: 'pacing', status: 'wip' }] }],
  },
});
const smoke = item({
  kind: 'smoke-fail',
  status: 'fail',
  actions: [{ id: 'view-log', label: 'View log', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'smoke-fail', harnessSlug: 'h' },
});
// D-027 follow-on (1): inline-disposition fixtures.
const standingApproval = item({
  kind: 'standing-approval',
  status: 'pending-approval',
  tier: 'decision',
  needsHuman: true,
  actions: [{ id: 'grant', label: 'Grant', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
  ref: { kind: 'standing-approval', capability: 'harness:write', targetHarness: 'sheets' },
});
const conversation = item({
  kind: 'conversation',
  status: 'open',
  tier: 'alert',
  needsHuman: false,
  ownerAgentId: 'su-asker-1',
  actions: [{ id: 'answer', label: 'Answer', primary: true }, { id: 'message-owner', label: 'Message owner' }],
  ref: { kind: 'conversation', conversationId: 'CONV-7' },
});
const conversationNoAsker = item({
  kind: 'conversation',
  status: 'open',
  tier: 'alert',
  needsHuman: false,
  ownerAgentId: undefined,
  actions: [{ id: 'answer', label: 'Answer', primary: true }, { id: 'message-owner', label: 'Message owner' }],
  ref: { kind: 'conversation', conversationId: 'CONV-8' },
});
const workItemOwnerBlock = item({
  id: 'work-item-needs-human:WI-42',
  kind: 'work-item-needs-human',
  source: 'harness',
  ownerAgentId: 'su-worker-42',
  actions: [{ id: 'answer', label: 'Answer', primary: true }, { id: 'open', label: 'Open work item' }],
  ref: { kind: 'work-item-needs-human', workItemId: 'WI-42', itemKind: 'change' },
});
const liveOwnerWall = item({
  id: 'owner-wall:work-item:WI-43',
  kind: 'owner-wall',
  source: 'harness',
  ownerAgentId: 'su-worker-43',
  actions: [{ id: 'answer', label: 'Answer', primary: true }, { id: 'message-owner', label: 'Open agent session' }],
  ref: { kind: 'owner-wall', wallSource: 'work-item', wallOwnerId: 'su-worker-43', wallRef: 'WI-43' },
});
const improvement = item({
  kind: 'improvement',
  status: 'needs-triage',
  tier: 'decision',
  needsHuman: true,
  actions: [{ id: 'open', label: 'Triage', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
  ref: { kind: 'improvement', issueId: 'EI-42' },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)));
});
afterEach(() => vi.unstubAllGlobals());

const ids = (spec: { options: { id: string }[] }) => spec.options.map((o) => o.id);
const byId = (spec: { options: { id: string; style?: string; terminal?: boolean }[] }, id: string) =>
  spec.options.find((o) => o.id === id)!;

describe('attentionItemToCardSpec (P-010)', () => {
  it('escalation: expands the generic resolve into the named options (terminal) + chat (navigate)', () => {
    const spec = attentionItemToCardSpec(escWithOptions);
    expect(ids(spec)).toEqual(['retry', 'pause', 'chat']);
    expect(byId(spec, 'retry').terminal).toBeUndefined(); // terminal (commit)
    expect(byId(spec, 'retry').style).toBe('primary');
    expect(byId(spec, 'chat').terminal).toBe(false); // navigate
  });

  it('escalation with no named options: a single generic Resolve + chat', () => {
    const spec = attentionItemToCardSpec(escNoOptions);
    expect(ids(spec)).toEqual(['resolve', 'chat']);
    expect(byId(spec, 'resolve').terminal).toBeUndefined();
  });

  it('discuss is a NAVIGATE option (terminal:false) — a terminal dispatch here resolved a real escalation (EI-13037)', () => {
    const spec = attentionItemToCardSpec(
      item({
        kind: 'coord-escalation',
        status: 'open',
        actions: [{ id: 'resolve', label: 'Resolve', primary: true }, { id: 'discuss', label: 'Discuss' }],
        ref: { kind: 'coord-escalation', msgId: 'm1', options: [{ id: 'authorize', label: 'Authorize' }, { id: 'stop', label: 'Stop' }] },
      }),
    );
    expect(ids(spec)).toEqual(['authorize', 'stop', 'discuss']);
    expect(byId(spec, 'discuss').terminal).toBe(false);
  });

  it('needs-human plan item: Answer + Drop survive (the P-009/P-010 gap)', () => {
    const spec = attentionItemToCardSpec(needsHuman);
    expect(ids(spec)).toEqual(['answer', 'mark-done', 'drop', 'chat']);
    expect(byId(spec, 'answer').terminal).toBe(false); // reveals InputCard, doesn't commit
    expect(byId(spec, 'mark-done').style).toBe('primary');
    expect(byId(spec, 'drop').style).toBe('danger');
    expect(byId(spec, 'drop').terminal).toBeUndefined(); // terminal
    expect(byId(spec, 'chat').terminal).toBe(false);
  });

  it('smoke-fail: view-log + chat are both navigate (nothing to resolve)', () => {
    const spec = attentionItemToCardSpec(smoke);
    expect(ids(spec)).toEqual(['view-log', 'chat']);
    expect(byId(spec, 'view-log').terminal).toBe(false);
  });

  it('message-owner is a navigate option (opens the thread, never commits)', () => {
    const withMsgOwner = item({
      actions: [
        { id: 'mark-done', label: 'Resolve', primary: true },
        { id: 'chat', label: 'Chat' },
        { id: 'message-owner', label: 'Message owner' },
      ],
      ref: { kind: 'plan-item', slug: 'p', itemId: 'P-7' },
    });
    const spec = attentionItemToCardSpec(withMsgOwner);
    expect(ids(spec)).toContain('message-owner');
    expect(byId(spec, 'message-owner').terminal).toBe(false); // navigate — component handles it
  });

  it('question prefers body, falls back to title', () => {
    expect(attentionItemToCardSpec(needsHuman).question).toBe('Body text');
    expect(attentionItemToCardSpec(item({ body: '   ', title: 'Just a title' })).question).toBe('Just a title');
  });

  it('operator-report: carries the ReportBlock + uses the title as the question (not the body dump)', () => {
    const spec = attentionItemToCardSpec(operatorReport);
    expect(spec.report).toBeDefined();
    expect(spec.report?.plans[0]?.title).toBe('Rate-limit v2');
    // The structured block renders natively; the question is the short title,
    // NOT the plain-text body fallback (which would duplicate the block).
    expect(spec.question).toBe('Fleet status');
    expect(ids(spec)).toEqual(['resolve']);
  });

  it('standing-approval: Grant + Dismiss are both terminal (no navigate) — D-027 follow-on (1)', () => {
    const spec = attentionItemToCardSpec(standingApproval);
    expect(ids(spec)).toEqual(['grant', 'dismiss']);
    expect(byId(spec, 'grant').terminal).toBeUndefined(); // terminal (renderer default)
    expect(byId(spec, 'dismiss').terminal).toBeUndefined();
    expect(byId(spec, 'grant').style).toBe('primary');
  });

  it('conversation: Answer is navigate (reveals the InputCard), Message owner navigate — D-027 follow-on (1)', () => {
    const spec = attentionItemToCardSpec(conversation);
    expect(byId(spec, 'answer').terminal).toBe(false); // navigate — InputCard owns it
    expect(byId(spec, 'message-owner').terminal).toBe(false);
  });

  it('improvement: Triage is navigate (full surface), Dismiss is terminal (reject) — D-027 follow-on (1)', () => {
    const spec = attentionItemToCardSpec(improvement);
    expect(byId(spec, 'open').terminal).toBe(false); // navigate — Triage surface owns place/gate/gym
    expect(byId(spec, 'dismiss').terminal).toBeUndefined(); // terminal (renderer default)
  });
});

describe('resolveAttentionAction (P-011/P-012/P-013 parity)', () => {
  it('escalation named option → resolveEscalation({msg_id, choice}) with the picked id', async () => {
    const r = await resolveAttentionAction(escWithOptions, 'retry');
    expect(resolveEscalation).toHaveBeenCalledWith({ msg_id: 'm1', choice: 'retry' });
    expect(r.resolved).toBe(true);
  });

  it('escalation Discuss / unknown option ids NEVER resolve — no generic-"resolved" fallthrough (EI-13037)', async () => {
    // The incident: 'discuss' was missing from NAVIGATE_ACTION_IDS, dispatched
    // as a terminal submit, and the old fallthrough mapped ANY unknown id to
    // choice:'resolved' — silently closing a real owner-authority escalation.
    // Both layers are pinned: the dispatcher must refuse ids it doesn't know.
    for (const optionId of ['discuss', 'not-a-real-option']) {
      const r = await resolveAttentionAction(escWithOptions, optionId);
      expect(r.resolved).toBe(false);
    }
    expect(resolveEscalation).not.toHaveBeenCalled();
  });

  it('escalation with no options → choice "resolved"', async () => {
    await resolveAttentionAction(escNoOptions, 'resolve');
    expect(resolveEscalation).toHaveBeenCalledWith({ msg_id: 'm9', choice: 'resolved' });
  });

  // P-009 (owner-inbox-single-pane-2026-07-17) E2E finding: picking a named
  // escalation option resolved the escalation but never told the asker — a
  // silent close for exactly the AskChoiceCard flow P-008 built. Fixed to
  // mirror replyToAttentionItem's best-effort deliverInboxReply.
  it('escalation named option resolve ALSO delivers + wakes a LIVE asker (P-009 fix)', async () => {
    const r = await resolveAttentionAction(escWithAsker, 'ok');
    expect(resolveEscalation).toHaveBeenCalledWith({ msg_id: 'm10', choice: 'ok' });
    expect(deliverInboxReply).toHaveBeenCalledWith(
      expect.objectContaining({ askerId: 'su-probe-1', text: 'OK', planSlug: 'p' }),
    );
    expect(r.resolved).toBe(true);
    expect(r.live).toBe(true);
    expect(r.woken).toBe(1);
  });

  it('escalation resolve with no asker (ownerAgentId null) skips delivery — same as before', async () => {
    const r = await resolveAttentionAction(escWithOptions, 'retry');
    expect(deliverInboxReply).not.toHaveBeenCalled();
    expect(r.resolved).toBe(true);
    expect(r.live).toBeUndefined();
  });

  it('escalation reply-delivery fault never surfaces as a failed resolve', async () => {
    vi.mocked(deliverInboxReply).mockRejectedValueOnce(new Error('network blip'));
    const r = await resolveAttentionAction(escWithAsker, 'ok');
    expect(resolveEscalation).toHaveBeenCalledWith({ msg_id: 'm10', choice: 'ok' });
    expect(r.resolved).toBe(true);
  });

  it('message ack → ackCoordMessage({msg_id})', async () => {
    const r = await resolveAttentionAction(message, 'ack');
    expect(ackCoordMessage).toHaveBeenCalledWith({ msg_id: 'm2' });
    expect(r.resolved).toBe(true);
  });

  it('plan-item Resolve → setItemStatus done AND nudges the Queen awake', async () => {
    const r = await resolveAttentionAction(needsHuman, 'mark-done');
    expect(setItemStatus).toHaveBeenCalledWith({ slug: 'p', itemId: 'P-7', status: 'done' });
    expectQueenWake();
    expect(r.resolved).toBe(true);
  });

  it('plan-item Drop → setItemStatus dropped and does NOT resume', async () => {
    const r = await resolveAttentionAction(needsHuman, 'drop');
    expect(setItemStatus).toHaveBeenCalledWith({ slug: 'p', itemId: 'P-7', status: 'dropped' });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.resolved).toBe(true);
  });

  it('navigate ids (chat) are not dispatched here', async () => {
    const r = await resolveAttentionAction(needsHuman, 'chat');
    expect(r.resolved).toBe(false);
    expect(setItemStatus).not.toHaveBeenCalled();
    expect(resolveEscalation).not.toHaveBeenCalled();
  });

  it('message-owner is a navigate id — not dispatched here (the thread component owns it)', async () => {
    const r = await resolveAttentionAction(needsHuman, 'message-owner');
    expect(r.resolved).toBe(false);
    expect(setItemStatus).not.toHaveBeenCalled();
  });

  it('operator-report Resolve → inbox:triage resolve (the triage state machine), keyed by item id', async () => {
    const r = await resolveAttentionAction(operatorReport, 'resolve');
    expect(triageAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'operator-report:turn-1', action: 'resolve' }),
    );
    expect(r.resolved).toBe(true);
    // It does NOT touch the plan-item / escalation backends.
    expect(setItemStatus).not.toHaveBeenCalled();
    expect(resolveEscalation).not.toHaveBeenCalled();
  });

  it('standing-fact wall Resolve → facts:retract with exact ref coordinates', async () => {
    const factWall = item({
      id: 'owner-wall:standing-fact:wall:voice-credential',
      kind: 'owner-wall',
      source: 'harness',
      actions: [{ id: 'resolve', label: 'Clear wall', primary: true }],
      ref: {
        kind: 'owner-wall',
        wallSource: 'standing-fact',
        wallOwnerId: null,
        wallRef: 'wall:voice-credential',
        factScope: 'harness',
        factScopeRef: 'papercusp',
        factKey: 'wall:voice-credential',
      },
    });
    const result = await resolveAttentionAction(factWall, 'resolve');
    expect(result.resolved).toBe(true);
    expect(retractStandingFact).toHaveBeenCalledWith({
      scope: 'harness',
      scopeRef: 'papercusp',
      key: 'wall:voice-credential',
      reason: 'Owner cleared this wall from the inbox',
    });
    expect(triageAttentionItem).not.toHaveBeenCalled();
  });

  // D-027 follow-on (1): inline disposition for the folded kinds.
  it('standing-approval Grant → decideStandingApproval(approve) from the ref', async () => {
    const r = await resolveAttentionAction(standingApproval, 'grant');
    expect(decideStandingApproval).toHaveBeenCalledWith({ capability: 'harness:write', targetHarness: 'sheets', decision: 'approve' });
    expect(r.resolved).toBe(true);
  });

  it('standing-approval Dismiss → decideStandingApproval(dismiss)', async () => {
    const r = await resolveAttentionAction(standingApproval, 'dismiss');
    expect(decideStandingApproval).toHaveBeenCalledWith({ capability: 'harness:write', targetHarness: 'sheets', decision: 'dismiss' });
    expect(r.resolved).toBe(true);
  });

  it('conversation Answer is a navigate id — not dispatched here (the InputCard submit owns it)', async () => {
    const r = await resolveAttentionAction(conversation, 'answer');
    expect(r.resolved).toBe(false);
    expect(resolveConversationAnswer).not.toHaveBeenCalled();
  });

  it('improvement Dismiss → dismissImprovement(issueId) (triage reject); Triage stays navigate', async () => {
    const r = await resolveAttentionAction(improvement, 'dismiss');
    expect(dismissImprovement).toHaveBeenCalledWith('EI-42');
    expect(r.resolved).toBe(true);
    // The navigate `open` (Triage) is NOT dispatched here — the full surface owns it.
    const nav = await resolveAttentionAction(improvement, 'open');
    expect(nav.resolved).toBe(false);
  });
});

describe('answerAttentionItem (P-021 Answer flow parity)', () => {
  it('the deduplicated ask-owner card exposes Answer and resolves its exact linked conversation', async () => {
    const escalation = coordEscalationToAttention({
      msgId: 'ask-escalation', severity: 'question', summary: 'Which approach?',
      from: 'su-asker', conversationId: 'conv-linked',
    });
    const twin = conversationToAttention({ conversationId: 'conv-linked', title: 'Which approach?', askerId: 'su-asker' });
    const kept = dropDuplicateQuestionConversations([escalation, twin]);
    expect(kept).toHaveLength(1);
    const card = kept[0] as AttentionItem;
    const spec = attentionItemToCardSpec(card);
    expect(spec.options.find((option) => option.id === 'answer')).toMatchObject({ label: 'Answer', terminal: false });
    expect(spec.options.some((option) => option.id === 'resolve')).toBe(false);
    expect(await replyToAttentionItem(card, 'Use approach B')).toMatchObject({ resolved: true });
    expect(resolveConversationAnswer).toHaveBeenCalledWith({ conversation_id: 'conv-linked', accepted_answer: 'Use approach B' });
    expect(deliverInboxReply).toHaveBeenCalledWith(expect.objectContaining({ askerId: 'su-asker', text: 'Use approach B' }));
    expect(resolveEscalation).not.toHaveBeenCalled();
  });

  it('keeps named options on a linked escalation as terminal choices', () => {
    const card = coordEscalationToAttention({
      msgId: 'choice-escalation', severity: 'question', summary: 'Which approach?',
      from: 'su-asker', conversationId: 'conv-linked', options: [{ id: 'b', label: 'Use B' }],
    }) as AttentionItem;
    expect(attentionItemToCardSpec(card).options.map((option) => option.id)).toEqual(['b', 'discuss']);
  });

  it('records a decision, marks done, and nudges the Queen awake', async () => {
    const r = await answerAttentionItem(needsHuman, 'do the thing');
    expect(addPlanDecision).toHaveBeenCalledWith({ slug: 'p', title: 'Answer to P-7', body: 'do the thing', refs: ['P-7'] });
    expect(setItemStatus).toHaveBeenCalledWith({ slug: 'p', itemId: 'P-7', status: 'done' });
    expectQueenWake();
    expect(r.resolved).toBe(true);
  });

  it('empty answer is a no-op', async () => {
    const r = await answerAttentionItem(needsHuman, '   ');
    expect(addPlanDecision).not.toHaveBeenCalled();
    expect(r.resolved).toBe(false);
  });

  // D-027 follow-on (1): a conversation answers by RESOLVING with the owner's text
  // as the accepted answer (no plan decision / loop resume).
  it('conversation answer → resolveConversationAnswer({conversation_id, accepted_answer}), no plan-item writes', async () => {
    const r = await answerAttentionItem(conversation, 'use approach B');
    expect(resolveConversationAnswer).toHaveBeenCalledWith({ conversation_id: 'CONV-7', accepted_answer: 'use approach B' });
    expect(addPlanDecision).not.toHaveBeenCalled();
    expect(setItemStatus).not.toHaveBeenCalled();
    expect(r.resolved).toBe(true);
  });
});

// owner-inbox-single-pane-2026-07-17 P-006 (D-006/D-007): reply routing layered
// on top of the existing answer/resolve path.
describe('replyToAttentionItem (P-006 reply routing, D-006/D-007)', () => {
  it.each([workItemOwnerBlock, liveOwnerWall])(
    'delivers a live heterogeneous owner answer before clearing $kind',
    async (ownerBlock) => {
      const r = await replyToAttentionItem(ownerBlock, 'Use the safe migration path');
      expect(deliverInboxReply).toHaveBeenCalledWith(
        expect.objectContaining({ askerId: ownerBlock.ownerAgentId, text: 'Use the safe migration path' }),
      );
      expect(triageAttentionItem).toHaveBeenCalledWith({
        itemId: ownerBlock.id,
        action: 'resolve',
        note: 'Owner answer delivered from the Resolution Inbox',
      });
      expect(r).toMatchObject({ resolved: true, live: true, woken: 1 });
    },
  );

  it('keeps a heterogeneous owner block unresolved when delivery cannot reach the agent', async () => {
    vi.mocked(deliverInboxReply).mockResolvedValueOnce({ ok: true, live: false, delivered: false, woken: 0 });
    const r = await replyToAttentionItem(workItemOwnerBlock, 'Use the safe migration path');
    expect(triageAttentionItem).not.toHaveBeenCalled();
    expect(r).toEqual({ resolved: false, live: false, woken: 0 });
  });

  it('resolves the conversation AND pushes the reply to a LIVE asker (ownerAgentId set)', async () => {
    const r = await replyToAttentionItem(conversation, 'use approach B');
    expect(resolveConversationAnswer).toHaveBeenCalledWith({ conversation_id: 'CONV-7', accepted_answer: 'use approach B' });
    expect(deliverInboxReply).toHaveBeenCalledWith(
      expect.objectContaining({ askerId: 'su-asker-1', text: 'use approach B', planSlug: 'p' }),
    );
    expect(r.resolved).toBe(true);
    expect(r.live).toBe(true);
    expect(r.woken).toBe(1);
  });

  it('no asker (ownerAgentId null) still resolves — reply-routing is skipped, not an error', async () => {
    const r = await replyToAttentionItem(conversationNoAsker, 'use approach B');
    expect(resolveConversationAnswer).toHaveBeenCalledWith({ conversation_id: 'CONV-8', accepted_answer: 'use approach B' });
    expect(deliverInboxReply).not.toHaveBeenCalled();
    expect(r.resolved).toBe(true);
    expect(r.live).toBe(false);
    expect(r.woken).toBe(0);
  });

  it('a dead asker (deliverInboxReply reports live:false) still leaves the item resolved', async () => {
    vi.mocked(deliverInboxReply).mockResolvedValueOnce({ ok: true, live: false, delivered: false, woken: 0 });
    const r = await replyToAttentionItem(conversation, 'use approach B');
    expect(r.resolved).toBe(true);
    expect(r.live).toBe(false);
    expect(r.woken).toBe(0);
  });

  it('a delivery fault never surfaces as a failed answer — resolve already succeeded', async () => {
    vi.mocked(deliverInboxReply).mockRejectedValueOnce(new Error('network blip'));
    const r = await replyToAttentionItem(conversation, 'use approach B');
    expect(r.resolved).toBe(true);
    expect(r.live).toBe(false);
    expect(r.woken).toBe(0);
  });

  it('empty answer is a no-op, same as answerAttentionItem — no reply delivery attempted', async () => {
    const r = await replyToAttentionItem(conversation, '   ');
    expect(resolveConversationAnswer).not.toHaveBeenCalled();
    expect(deliverInboxReply).not.toHaveBeenCalled();
    expect(r.resolved).toBe(false);
  });
});

/* ── Button hints: does the button admit what the click DOES? ─────────────────
 * [owner 2026-08-09] "What do those buttons actually do its unclear."
 *
 * `AskChoiceOption.hint` is rendered as the button's tooltip by
 * QueueCardActions and as its sub-label by AskChoiceCard, in every host. Until
 * this pass nothing SET it, so every tooltip repeated the word already printed
 * on the button.
 *
 * The load-bearing case is the LIE, not the omission: `discuss` sits in
 * NAVIGATE_ACTION_IDS and touches no server state, and omitting it from that
 * set once made the Discuss button silently resolve real owner gates
 * (EI-13037). A hint claiming Discuss closes something would re-create that
 * exact confusion in prose while the dispatch stayed correct — and no other
 * test in this file would notice, because they all assert dispatch.
 */
describe('option hints state what the dispatch actually does', () => {
  const escalationWithOptions = item({
    kind: 'coord-escalation',
    ownerAgentId: 'su-abc',
    actions: [
      { id: 'resolve', label: 'Resolve', primary: true },
      { id: 'discuss', label: 'Discuss' },
    ],
    ref: { kind: 'coord-escalation', msgId: 'm1', options: [{ id: 'opt-a', label: 'Relaunch it' }] },
  } as Partial<AttentionItem>);

  const escalationNoOptions = item({
    kind: 'coord-escalation',
    ownerAgentId: 'su-abc',
    actions: [
      { id: 'resolve', label: 'Resolve', primary: true },
      { id: 'discuss', label: 'Discuss' },
    ],
    ref: { kind: 'coord-escalation', msgId: 'm2', options: [] },
  } as Partial<AttentionItem>);

  const hintOf = (host: AttentionItem, optionId: string) =>
    attentionItemToCardSpec(host).options.find((o) => o.id === optionId)?.hint ?? '';

  it('a named escalation option says it answers, wakes and closes — the three things it does', () => {
    // Mirrors resolveAttentionAction's coord-escalation branch: resolveEscalation
    // with the picked option id, then deliverInboxReply to item.ownerAgentId.
    const hint = hintOf(escalationWithOptions, 'opt-a');
    expect(hint).toMatch(/answers/i);
    expect(hint).toMatch(/wakes/i);
    expect(hint).toMatch(/closes/i);
  });

  it('generic Resolve on an escalation admits the reply carries no detail', () => {
    // With no named option the reply text is the literal string "Resolved" —
    // which a button reading only "Resolve" hides completely.
    expect(hintOf(escalationNoOptions, 'resolve')).toMatch(/no detail/i);
  });

  it('Discuss disclaims BOTH outcomes — it neither answers nor closes', () => {
    expect(hintOf(escalationWithOptions, 'discuss')).toMatch(/does not answer or close/i);
  });

  it('NO navigate option ever claims to close or answer (EI-13037’s confusion, in prose)', () => {
    // The drift guard. Every navigate id the adapters emit, across the item
    // kinds that carry them: a hint may describe opening a surface, never a
    // terminal effect. This fails if a hint is re-worded without reading the
    // dispatch, or if an id leaves NAVIGATE_ACTION_IDS.
    const hosts: AttentionItem[] = [
      escalationWithOptions,
      escalationNoOptions,
      item({
        kind: 'conversation',
        actions: [
          { id: 'answer', label: 'Answer', primary: true },
          { id: 'discuss', label: 'Discuss' },
        ],
        ref: { kind: 'conversation', conversationId: 'c1' },
      } as Partial<AttentionItem>),
      item({
        kind: 'smoke-fail',
        actions: [
          { id: 'view-log', label: 'View log' },
          { id: 'open', label: 'Open' },
        ],
        ref: { kind: 'smoke-fail' },
      } as Partial<AttentionItem>),
    ];
    let checked = 0;
    for (const host of hosts) {
      for (const opt of attentionItemToCardSpec(host).options) {
        if (!isNavigateAction(opt.id)) continue;
        checked += 1;
        expect(opt.hint, `navigate option "${opt.id}" must carry a hint`).toBeTruthy();
        // The property is about THE CLICK, so it is asserted on the FIRST
        // sentence only. A later sentence may legitimately describe a terminal
        // effect of the surface that opens — `answer`'s box, once SUBMITTED,
        // really does resolve the item, and hiding that would be its own lie.
        // (The first draft of this guard banned the words outright and failed
        // on exactly that honest hint — the blunt rule was wrong, not the text.)
        const click = String(opt.hint).split('.')[0];
        expect(click, `navigate hint for "${opt.id}" must lead with what the CLICK does`).toMatch(
          /^Opens\b/,
        );
        expect(
          click,
          `navigate option "${opt.id}" claims the CLICK has a terminal effect: ${click}`,
        ).not.toMatch(/\b(closes|resolves|wakes|answers)\b/i);
      }
    }
    // Guard the guard: a loop that silently checked nothing would pass forever.
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('every TERMINAL option carries a hint that is not just the label again', () => {
    const terminals = attentionItemToCardSpec(escalationWithOptions).options.filter(
      (o) => !isNavigateAction(o.id),
    );
    expect(terminals.length).toBeGreaterThan(0);
    for (const opt of terminals) {
      expect(opt.hint, `terminal option "${opt.id}" has no hint`).toBeTruthy();
      expect(opt.hint).not.toBe(opt.label);
    }
  });
});
