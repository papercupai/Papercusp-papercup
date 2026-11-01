import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_CONTEXT_PROJECTION_VERSION,
  foreignTaskSnapshot,
  foreignToolFrames,
  loopMessageFrames,
  projectConversationContext,
  projectLiveLoopEvent,
  readConversationContextProjection,
  type ForeignProjectionToolRow,
} from './conversation-context-projection';

const BASE = {
  sourceKind: 'agent_chat',
  sessionId: 'chat-1',
  harness: 'papercusp',
  role: 'su',
  linkedWorkItemId: 'WI-1',
  tasks: [],
  approvals: [],
};

describe('conversation context projection', () => {
  it('falls back honestly to transcript-only when the loop ledger is absent', () => {
    const projected = projectConversationContext({
      ...BASE,
      transcript: [{ role: 'user', content: 'hello', ts: '2026-08-26T00:00:00Z' }],
      loopSession: null,
    });
    expect(projected.schemaVersion).toBe(CONVERSATION_CONTEXT_PROJECTION_VERSION);
    expect(projected.session.capabilityTier).toBe('transcript-only');
    expect(projected.capabilities).toEqual({
      liveFrames: false,
      taskWrite: false,
      approvalWrite: false,
    });
    expect(projected.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', text: 'hello' }),
      expect.objectContaining({ kind: 'context', section: 'identity' }),
      expect.objectContaining({ kind: 'context', section: 'intent' }),
    ]));
    expect(projected.frames.some((frame) => frame.kind === 'reasoning')).toBe(false);
  });

  it('lets the owner write an SU-session conversation task list without an owned-loop ledger (D-019)', () => {
    const transcript = [{ role: 'user' as const, content: 'hello', ts: '2026-08-26T00:00:00Z' }];
    const su = projectConversationContext({ ...BASE, transcript, loopSession: null, suSessionChat: true });
    // Only the task list is conversation-keyed; live frames and approvals stay loop-owned.
    expect(su.session.capabilityTier).toBe('transcript-only');
    expect(su.capabilities).toEqual({ liveFrames: false, taskWrite: true, approvalWrite: false });

    // A producer session that merely claims the flag stays read-only.
    const foreign = projectConversationContext({
      ...BASE, sourceKind: 'claude', transcript, loopSession: null, suSessionChat: true,
    });
    expect(foreign.capabilities.taskWrite).toBe(false);
  });

  it('normalizes the newest foreign whole-list task snapshot and native tool wrapper', () => {
    const rows: ForeignProjectionToolRow[] = [
      {
        id: 12,
        tool_name: 'activity:report',
        args_json: {
          tool_name: 'update_plan',
          tool_use_id: 'call-plan',
          todos: [
            { content: 'Inspect', activeForm: 'Inspect', status: 'completed' },
            { content: 'Implement', activeForm: 'Implement', status: 'in_progress' },
          ],
        },
        status: 'ok',
        error_message: null,
        invoked_at: '2026-08-26T00:00:02Z',
        coord_owner_id: 'su-foreign',
        goal_ref: 'WI-9',
      },
      {
        id: 11,
        tool_name: 'activity:report',
        args_json: {
          tool_name: 'TodoWrite',
          tool_use_id: 'call-old',
          todos: [{ content: 'Old snapshot', activeForm: 'Old', status: 'pending' }],
        },
        status: 'ok',
        error_message: null,
        invoked_at: '2026-08-26T00:00:01Z',
        coord_owner_id: 'su-foreign',
        goal_ref: 'WI-9',
      },
    ];

    expect(foreignTaskSnapshot(rows)).toEqual([
      expect.objectContaining({ content: 'Inspect', status: 'completed', position: 0, links: [] }),
      expect.objectContaining({ content: 'Implement', status: 'in_progress', position: 1, links: [] }),
    ]);
    expect(foreignToolFrames(rows)).toEqual([
      expect.objectContaining({ callId: 'call-old', name: 'TodoWrite', state: 'succeeded' }),
      expect.objectContaining({ callId: 'call-plan', name: 'update_plan', state: 'succeeded' }),
    ]);
  });

  it('reads a bounded foreign session through the shared read-only projection', async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('FROM harness_shared.adv_sessions')) {
        return Promise.resolve([{
          coord_owner_id: 'su-foreign', role: 'su', feature: null,
          plan_slug: 'plan-a',
          started_at: '2026-08-26T00:00:00Z', ended_at: null,
        }]);
      }
      if (text.includes('FROM harness_shared.session_turns')) {
        return Promise.resolve([
          { turn_idx: 0, speaker: 'user', ts: '2026-08-26T00:00:00Z', text: 'Build it', owner: 'su-foreign', harness_slug: 'papercusp' },
          { turn_idx: 1, speaker: 'assistant', ts: '2026-08-26T00:00:01Z', text: 'Working', owner: 'su-foreign', harness_slug: 'papercusp' },
        ]);
      }
      if (text.includes('FROM harness_shared.tool_invocations')) {
        return Promise.resolve([{
          id: 22,
          tool_name: 'activity:report',
          args_json: {
            owner: 'su-foreign', session_id: 'session-1', tool_name: 'update_plan',
            tool_use_id: 'plan-call',
            todos: [{ content: 'Ship adapter', activeForm: 'Shipping adapter', status: 'in_progress' }],
          },
          status: 'ok', error_message: null, invoked_at: '2026-08-26T00:00:02Z',
          coord_owner_id: 'su-foreign', goal_ref: 'WI-9',
        }]);
      }
      if (text.includes('FROM harness_shared.coord_presence')) {
        return Promise.resolve([{
          owner_id: 'su-foreign', owner_label: 'Foreign SU', intent: 'Ship the adapter',
          current_plan_slug: 'plan-a', agent_role: 'su', fleet_slug: 'fleet-a', fleet_role: 'member',
        }]);
      }
      if (text.includes('FROM harness_shared.agent_modes')) {
        return Promise.resolve([{
          workspace_id: 'ws', owner_id: 'su-foreign', axis_key: 'autonomy', mode: 'auto',
          reason: 'Owner directed', set_by: 'su-foreign', owner_directed: true,
          set_at: '2026-08-26T00:00:00Z', subject: null,
        }]);
      }
      if (text.includes('FROM harness_shared.plan_item_claims')) {
        return Promise.resolve([{ plan_slug: 'plan-a', item_id: 'P-030' }]);
      }
      if (text.includes('FROM harness_shared.work_items')) {
        return Promise.resolve([{ feature_id: 'WI-9', title: 'Foreign projection', status: 'wip' }]);
      }
      throw new Error(`unexpected query: ${text}`);
    }) as unknown as Sql;

    const loadFleetContext = vi.fn(async () => ({
      id: 'context:fleet',
      kind: 'context' as const,
      section: 'fleet' as const,
      title: 'Fleet',
      entries: [{ label: 'Fleet', value: 'fleet-a' }],
    }));
    const projected = await readConversationContextProjection({
      workspaceId: 'ws',
      sourceKind: 'codex',
      sessionId: 'session-1',
      harness: 'papercusp',
    }, { sql, loadFleetContext });

    const advSessionQuery = queries.find((query) => query.includes('FROM harness_shared.adv_sessions'));
    expect(advSessionQuery).toBeDefined();
    expect(advSessionQuery).not.toContain('harness_slug');
    expect(projected?.session).toMatchObject({
      sourceKind: 'codex',
      sessionId: 'session-1',
      linkedWorkItemId: 'WI-9',
      capabilityTier: 'producer-readonly',
    });
    expect(projected?.capabilities).toEqual({
      liveFrames: false,
      taskWrite: false,
      approvalWrite: false,
    });
    expect(projected?.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', text: 'Build it' }),
      expect.objectContaining({ kind: 'tool', name: 'update_plan', callId: 'plan-call' }),
      expect.objectContaining({ kind: 'task', content: 'Ship adapter', status: 'in_progress' }),
      expect.objectContaining({ kind: 'context', section: 'mode' }),
      expect.objectContaining({ kind: 'context', section: 'intent' }),
      expect.objectContaining({ kind: 'context', section: 'fleet' }),
      expect.objectContaining({ kind: 'context', section: 'plan' }),
      expect.objectContaining({ kind: 'context', section: 'held' }),
    ]));
    expect(projected?.frames.some((frame) => frame.kind === 'reasoning' || frame.kind === 'approval')).toBe(false);
    expect(queries.filter((query) => query.includes('session_turns'))).toHaveLength(1);
    expect(queries.filter((query) => query.includes('tool_invocations'))).toHaveLength(1);
    expect(loadFleetContext).toHaveBeenCalledWith({
      workspaceId: 'ws',
      harness: 'papercusp',
      ownerId: 'su-foreign',
      fleetSlug: 'fleet-a',
      planSlug: 'plan-a',
    });
    const sections = projected?.frames.flatMap((frame) => frame.kind === 'context' ? [frame.section] : []);
    expect(sections?.indexOf('fleet')).toBeLessThan(sections?.indexOf('plan') ?? -1);
  });

  it('uses a fresh owned-loop ledger and correlates tool calls with results once', () => {
    const projected = projectConversationContext({
      ...BASE,
      transcript: [
        { role: 'user', content: 'read it', ts: '2026-08-26T00:00:00Z' },
        { role: 'assistant', content: 'done', ts: '2026-08-26T00:00:01Z' },
      ],
      loopSession: {
        workspaceId: 'ws',
        chatId: 'chat-1',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'read it' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'call-1', name: 'files:read', input: { path: 'a' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolCallId: 'call-1', content: { ok: true } }],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        ],
        summary: null,
        compactedCount: 0,
        transcriptTurns: 2,
        model: 'gpt-5.6-sol:xhigh',
        turnCount: 1,
        totals: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          unpricedTurns: 0,
        },
      },
      tasks: [{
        id: 'task-1',
        content: 'Implement projection',
        activeForm: 'Implementing projection',
        status: 'in_progress',
        blockerRef: null,
        explanation: null,
        position: 0,
        createdAt: '2026-08-26T00:00:00Z',
        updatedAt: '2026-08-26T00:00:00Z',
        links: [{ workItemId: 'WI-9', workItemHarness: 'papercusp', relation: 'for' }],
      }],
      approvals: [{
        chatId: 'chat-1',
        callId: 'call-2',
        workspaceId: 'ws',
        toolName: 'capability:edit',
        toolInput: { path: 'b' },
        stepIndex: 1,
        requestedAt: '2026-08-26T00:00:02Z',
      }],
    });
    expect(projected.session.capabilityTier).toBe('owned-loop');
    expect(projected.capabilities).toEqual({ liveFrames: true, taskWrite: true, approvalWrite: true });
    expect(projected.frames.filter((frame) => frame.kind === 'tool')).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        name: 'files:read',
        state: 'succeeded',
        result: { ok: true },
      }),
    ]);
    expect(projected.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'task',
        taskId: 'task-1',
        status: 'in_progress',
        links: [{ workItemId: 'WI-9', workItemHarness: 'papercusp', relation: 'for' }],
      }),
      expect.objectContaining({ kind: 'approval', callId: 'call-2', status: 'pending' }),
    ]));
  });

  it('does not trust a stale loop ledger whose transcript anchor diverged', () => {
    const projected = projectConversationContext({
      ...BASE,
      transcript: [{ role: 'user', content: 'authoritative', ts: '2026-08-26T00:00:00Z' }],
      loopSession: {
        workspaceId: 'ws', chatId: 'chat-1',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'stale' }] }],
        summary: null, compactedCount: 0, transcriptTurns: 9, model: null, turnCount: 1,
        totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, unpricedTurns: 0 },
      },
    });
    expect(projected.frames.some((frame) => frame.kind === 'message' && frame.text === 'stale')).toBe(false);
    expect(projected.frames.some((frame) => frame.kind === 'message' && frame.text === 'authoritative')).toBe(true);
  });

  it('normalizes live reasoning and tool events into the same frame union', () => {
    expect(projectLiveLoopEvent({ type: 'reasoning_delta', stepIndex: 2, text: 'thinking' }))
      .toMatchObject({ kind: 'reasoning', stepIndex: 2, text: 'thinking', transient: true });
    expect(projectLiveLoopEvent({
      type: 'tool_call',
      stepIndex: 2,
      call: { id: 'c', name: 'files:read', input: {} },
      needsApproval: true,
    })).toMatchObject({ kind: 'tool', callId: 'c', state: 'approval-required' });
    expect(loopMessageFrames([])).toEqual([]);
  });
});
