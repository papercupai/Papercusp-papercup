import { beforeEach, describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getMessageById: vi.fn(),
  getConversationStatesByIds: vi.fn(),
  readImprovementItems: vi.fn(),
  buildDigest: vi.fn(),
  readOwnerFullAutonomyGrant: vi.fn(),
  applyHumanQueueRanking: vi.fn(),
  readNeedsHumanWorkItems: vi.fn(),
  notifyAttentionOnce: vi.fn(),
  notifyAttention: vi.fn(),
}));

vi.mock('../../agent-tools/coordination/messages', () => ({
  sendMessage: h.sendMessage,
  getMessageById: h.getMessageById,
}));
vi.mock('../../agent-tools/coordination/conversations', () => ({
  getConversationStatesByIds: h.getConversationStatesByIds,
}));
vi.mock('../improvements/read-items', () => ({ readImprovementItems: h.readImprovementItems }));
vi.mock('../improvements/digest', () => ({ buildDigest: h.buildDigest }));
vi.mock('../improvements/full-autonomy-grant', () => ({
  readOwnerFullAutonomyGrant: h.readOwnerFullAutonomyGrant,
}));
vi.mock('../../queue-ranker/human-queue', () => ({ applyHumanQueueRanking: h.applyHumanQueueRanking }));
vi.mock('../../attention/needs-human-work-items-source', () => ({
  NEEDS_HUMAN_LIMIT: 300,
  readNeedsHumanWorkItems: h.readNeedsHumanWorkItems,
}));
vi.mock('../../attention-notify', () => ({
  notifyAttentionOnce: h.notifyAttentionOnce,
  notifyAttention: h.notifyAttention,
}));

import { getSystemAction } from './system-actions';
import {
  composeHumanQueueDigest,
  composeStaleNeedsHumanReminder,
  filterResolvedConversationAsks,
  staleNeedsHumanDeliveryKey,
} from './human-queue-digest-action';
import type { ImpactRankedItem } from '../improvements/blocking-impact';
import type { NeedsHumanWorkItemRow } from '../../attention/needs-human-work-items-source';

const ctx = {
  installSlug: 'papercusp',
  workspaceId: 'ws-test',
  triggerConfig: {},
  payloadTemplate: null,
};

function needsHumanRow(over: Partial<NeedsHumanWorkItemRow> = {}): NeedsHumanWorkItemRow {
  return {
    feature_id: 'EI-13766',
    title: 'Owner action is still needed',
    summary: 'Fallback question',
    harness_slug: 'papercusp',
    item_kind: 'change',
    taken_by: 'su-fallback',
    payload: {
      externalBlockers: [
        {
          kind: 'human',
          capability: 'credential',
          capabilitySource: 'explicit',
          ref: 'credential:production',
          summary: 'Provide the production credential.',
          status: 'active',
          createdAt: '2026-07-01T00:00:00.000Z',
          createdBy: 'su-asker',
          updatedAt: '2026-07-01T00:00:00.000Z',
          nextVerb: 'setup:save_key',
        },
      ],
    },
    updated_ts: '2026-08-20T00:00:00.000Z',
    state_changed_at: '2026-07-01T00:00:00.000Z',
    status: 'needs-human',
    ...over,
  };
}

function conversationOwnerAsk(id: string, question: string): Record<string, unknown> {
  return {
    kind: 'human',
    capability: 'product-decision',
    capabilitySource: 'explicit',
    ref: 'conversation:answered:' + id,
    summary: question,
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    createdBy: 'su-asker',
    updatedAt: '2026-07-01T00:00:00.000Z',
    nextVerb: 'continue-investigation',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readImprovementItems.mockResolvedValue([]);
  h.readOwnerFullAutonomyGrant.mockResolvedValue(false);
  h.buildDigest.mockReturnValue({ humanQueue: [] });
  h.applyHumanQueueRanking.mockResolvedValue({ humanQueue: [] });
  h.readNeedsHumanWorkItems.mockResolvedValue([]);
  h.getMessageById.mockResolvedValue(null);
  h.getConversationStatesByIds.mockResolvedValue([]);
  h.sendMessage.mockResolvedValue({ msg_id: 'm' });
  h.notifyAttentionOnce.mockResolvedValue({ recordId: 1, deduped: false });
  h.notifyAttention.mockResolvedValue(undefined);
});

function ranked(p: Partial<ImpactRankedItem> & { id: string }): ImpactRankedItem {
  return {
    kind: 'change',
    title: `a thing about ${p.id}`,
    scope: 'operator',
    tier: 'human',
    score: 10,
    ageDays: 3,
    tierReason: 'test',
    severity: 'minor',
    impact: { score: 12, blocksOut: 0, inboundRefs: 0, openRecurrence: 0, resolvedRecurrence: 0, dupPeers: 0, watchdogActive: false, staleness: 1.6, reasons: [] },
    ...p,
  };
}

describe('improvement-human-digest registration', () => {
  it('registers the system action', () => {
    expect(getSystemAction('improvement-human-digest')).toBeTypeOf('function');
  });
});

describe('composeHumanQueueDigest', () => {
  it('returns null for an empty queue (no notification spam)', () => {
    expect(composeHumanQueueDigest([])).toBeNull();
  });

  it('leads with the top-N in queue order, with id, severity, age, impact and reasons', () => {
    const queue = [
      ranked({
        id: 'EI-1',
        severity: 'major',
        ageDays: 12,
        impact: { score: 44.3, blocksOut: 3, inboundRefs: 0, openRecurrence: 2, resolvedRecurrence: 0, dupPeers: 0, watchdogActive: false, staleness: 2.1, reasons: ['blocks 3 downstream item(s)', '2 open re-capture(s) of the same friction'] },
      }),
      ranked({ id: 'EI-2', impact: { score: 9, blocksOut: 0, inboundRefs: 1, openRecurrence: 0, resolvedRecurrence: 0, dupPeers: 0, watchdogActive: false, staleness: 1, reasons: ['1 inbound reference(s)'] } }),
      ranked({ id: 'EI-3' }),
    ];
    const composed = composeHumanQueueDigest(queue, { topN: 2 });
    expect(composed).not.toBeNull();
    const { summary, body } = composed!;
    expect(summary).toContain('3 item(s)');
    expect(summary).toContain('EI-1');
    expect(summary).toContain('impact 44.3');
    expect(summary).toContain('blocks 3 downstream item(s)');
    expect(body).toContain('1. **EI-1**');
    expect(body).toContain('[major · 12d · impact 44.3]');
    expect(body).toContain('why: blocks 3 downstream item(s); 2 open re-capture(s) of the same friction');
    expect(body).toContain('2. **EI-2**');
    expect(body).not.toContain('EI-3'); // beyond topN
    expect(body).toContain('…plus 1 more');
  });

  it('omits the overflow line and reason suffix when the whole queue fits and is reason-free', () => {
    const composed = composeHumanQueueDigest([ranked({ id: 'EI-9' })]);
    const { summary, body } = composed!;
    expect(body).not.toContain('…plus');
    expect(body).not.toContain('why:');
    expect(summary).toContain('top blocker: EI-9 (impact 12)');
  });

  it('truncates very long titles', () => {
    const composed = composeHumanQueueDigest([ranked({ id: 'EI-8', title: 'x'.repeat(300) })]);
    expect(composed!.body).toContain('…');
    expect(composed!.body).not.toContain('x'.repeat(150));
  });
});

describe('stale needs-human reminders (EI-13766)', () => {
  it('removes only the resolved conversation ask and keeps a separate active ask and gate', () => {
    const resolvedAsk = conversationOwnerAsk('conv-resolved', 'Already answered scope question');
    const unfinishedAsk = {
      ...conversationOwnerAsk('unrelated', 'Provide the production credential'),
      capability: 'credential',
      ref: 'credential:production',
      nextVerb: 'setup:save_key',
    };
    const row = needsHumanRow({ payload: { externalBlockers: [resolvedAsk, unfinishedAsk] } });

    const filtered = filterResolvedConversationAsks([row], new Set(['conv-resolved']));

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.status).toBe('needs-human');
    expect((filtered[0]?.payload as { externalBlockers: Array<Record<string, unknown>> }).externalBlockers.map((b) => b.status))
      .toEqual(['cleared', 'active']);
    expect(composeStaleNeedsHumanReminder(filtered[0]!).body).toContain(
      'Question: Provide the production credential',
    );
    expect(composeStaleNeedsHumanReminder(filtered[0]!).body).not.toContain('Already answered scope question');
    expect((row.payload as { externalBlockers: Array<Record<string, unknown>> }).externalBlockers.map((b) => b.status))
      .toEqual(['active', 'active']);
  });

  it('suppresses an answered conversation ask while retaining an unanswered one', () => {
    const answered = needsHumanRow({
      feature_id: 'EI-answered',
      payload: { externalBlockers: [conversationOwnerAsk('conv-resolved', 'Answered question')] },
    });
    const unanswered = needsHumanRow({
      feature_id: 'EI-unanswered',
      payload: { externalBlockers: [conversationOwnerAsk('conv-open', 'Open question')] },
    });

    const filtered = filterResolvedConversationAsks([answered, unanswered], new Set(['conv-resolved']));

    expect(filtered.map((row) => row.feature_id)).toEqual(['EI-unanswered']);
    expect(filtered[0]).toBe(unanswered);
  });

  it('keys one delivery to the work-item state episode and renders the structured asker', () => {
    const row = needsHumanRow();
    expect(staleNeedsHumanDeliveryKey(row)).toBe(
      'needs-human-stale:EI-13766:2026-07-01T00:00:00.000Z',
    );
    const reminder = composeStaleNeedsHumanReminder(row, Date.parse('2026-07-10T00:00:00.000Z'));
    expect(reminder.summary).toContain('waited 9d');
    expect(reminder.body).toContain('Question: Provide the production credential.');
    expect(reminder.body).toContain('Asked by: su-asker');
    expect(reminder.body).toContain('Unblocked by: setup:save_key');
  });

  it('discloses what happens if the reminder is ignored (owner-attention ledger)', () => {
    const base = needsHumanRow();
    const blockers = (base.payload as { externalBlockers: Array<Record<string, unknown>> }).externalBlockers;
    const declared = composeStaleNeedsHumanReminder(
      needsHumanRow({
        payload: {
          externalBlockers: [
            { ...blockers[0], defaultIfUnanswered: 'stays parked; re-surfaced weekly', decideBy: '2026-10-15T00:00:00Z' },
          ],
        },
      }),
      Date.parse('2026-07-10T00:00:00.000Z'),
    );
    expect(declared.body).toContain('Default if unanswered: stays parked; re-surfaced weekly (decide by 2026-10-15T00:00:00Z)');

    const legacy = composeStaleNeedsHumanReminder(base, Date.parse('2026-07-10T00:00:00.000Z'));
    expect(legacy.body).toContain('No default declared — the item stays parked until you answer.');
  });

  it('falls back to taken_by when a legacy row lacks a structured ask', () => {
    const reminder = composeStaleNeedsHumanReminder(needsHumanRow({ payload: {} }));
    expect(reminder.askedBy).toBe('su-fallback');
    expect(reminder.body).toContain('Question: Fallback question');
  });

  it('runs even when the improvement queue is empty and uses both replay-safe delivery rails', async () => {
    const row = needsHumanRow();
    h.readNeedsHumanWorkItems.mockResolvedValue([row]);
    const run = getSystemAction('improvement-human-digest')!;

    await run(ctx);

    expect(h.readNeedsHumanWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-test', oldestFirst: true, stateChangedBefore: expect.any(Date) }),
    );
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: ['human'],
        msgId: expect.stringMatching(/^ntfy-0-[a-f0-9]{32}$/),
        body: expect.stringContaining('Asked by: su-asker'),
      }),
    );
    expect(h.notifyAttentionOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'needs-human-stale:EI-13766:2026-07-01T00:00:00.000Z',
        data: expect.objectContaining({ askedBy: 'su-asker' }),
      }),
    );
  });

  it('batch-checks conversation lifecycle in the reminder workspace before delivery', async () => {
    const answered = needsHumanRow({
      feature_id: 'EI-answered',
      payload: { externalBlockers: [conversationOwnerAsk('conv-resolved', 'Already answered scope question')] },
    });
    const unanswered = needsHumanRow({
      feature_id: 'EI-unanswered',
      payload: { externalBlockers: [conversationOwnerAsk('conv-open', 'Still needs an answer')] },
    });
    h.readNeedsHumanWorkItems.mockResolvedValue([answered, unanswered]);
    h.getConversationStatesByIds.mockResolvedValue([
      { id: 'conv-resolved', state: 'resolved' },
      { id: 'conv-open', state: 'open' },
    ]);

    await getSystemAction('improvement-human-digest')!(ctx);

    expect(h.getConversationStatesByIds).toHaveBeenCalledWith(
      ['conv-resolved', 'conv-open'],
      'ws-test',
    );
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]?.[1].body).toContain('Question: Still needs an answer');
    expect(h.sendMessage.mock.calls[0]?.[1].body).not.toContain('Already answered scope question');
    expect(h.notifyAttentionOnce).toHaveBeenCalledTimes(1);
    expect(answered.status).toBe('needs-human');
  });

  it('reuses the same episode keys on replay and skips an already-present inbox message', async () => {
    const row = needsHumanRow();
    h.readNeedsHumanWorkItems.mockResolvedValue([row]);
    h.getMessageById.mockResolvedValueOnce(null).mockResolvedValue({ msg_id: 'existing' });
    const run = getSystemAction('improvement-human-digest')!;

    await run(ctx);
    await run(ctx);

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const attentionKeys = h.notifyAttentionOnce.mock.calls.map((call) => call[0].dedupeKey);
    expect(attentionKeys).toEqual([
      'needs-human-stale:EI-13766:2026-07-01T00:00:00.000Z',
      'needs-human-stale:EI-13766:2026-07-01T00:00:00.000Z',
    ]);
  });

  it('keeps the attention rail alive when one inbox delivery fails', async () => {
    h.readNeedsHumanWorkItems.mockResolvedValue([needsHumanRow()]);
    h.sendMessage.mockRejectedValueOnce(new Error('coord unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await getSystemAction('improvement-human-digest')!(ctx);

    expect(h.notifyAttentionOnce).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('EI-13766 stale-needs-human inbox send failed'),
      'coord unavailable',
    );
    warn.mockRestore();
  });
});
