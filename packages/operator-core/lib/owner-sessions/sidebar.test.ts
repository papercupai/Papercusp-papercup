import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HudRosterEntry } from '../../../../apps/operator/app/adv/hud/hud-board-model';
import { deriveFleetPeers } from '../../../../apps/operator/app/_components/chat/fleet-peers';
import { deriveSessionTurns } from '../../../../apps/operator/app/_components/chat/session-turn-index';
import { sessionTimelineToChatMessages } from '../../../../apps/operator/app/_components/chat/session-transcript-mapping';

const H = vi.hoisted(() => ({ history: vi.fn(), roster: vi.fn(), detail: vi.fn() }));
vi.mock('./transcript', () => ({ readOwnerHistoryPage: H.history }));
vi.mock('./roster', () => ({ readSessionRosterSnapshot: H.roster }));
vi.mock('../adv-agent-detail', () => ({ getAgentDetail: H.detail }));
import { readAgentSidebar } from './sidebar';
import { resolveNamedQueryV2 } from '../sync-resolver/index';

const entries = [
  { kind: 'prompt' as const, text: 'First question', ts: '2026-11-06T01:00:00Z' },
  { kind: 'tool_use' as const, toolName: 'read', toolInput: {} },
  { kind: 'tool_result' as const, text: 'private tool noise' },
  { kind: 'text' as const, text: 'Final answer', ts: '2026-11-06T01:00:01Z' },
  { kind: 'prompt' as const, text: 'Unanswered question' },
];

beforeEach(() => {
  vi.restoreAllMocks();
  H.history.mockReset().mockResolvedValue({ ok: true, entries, hasMore: true, cursor: 'older-cursor' });
  H.roster.mockReset().mockResolvedValue({ active: [] });
  H.detail.mockReset().mockResolvedValue({ ownerId: 'su-exact', locks: { held: [] } });
});

describe('agentDetail native Turns/Fleet views (Workbench P-001)', () => {
  it('keeps the ordinary Activity read lazy and unchanged', async () => {
    expect(await resolveNamedQueryV2('agentDetail.byOwner', { ownerId: 'su-exact' }))
      .toEqual([{ ownerId: 'su-exact', locks: { held: [] } }]);
    expect(H.history).not.toHaveBeenCalled();
    expect(H.roster).not.toHaveBeenCalled();
  });

  it('uses the exact GUI turn boundaries and jumps after collapsed tool noise', async () => {
    const [row] = await resolveNamedQueryV2('agentDetail.byOwner', {
      ownerId: 'su-exact', view: 'turns', historyCursor: 'previous-page',
    }) as Awaited<ReturnType<typeof readAgentSidebar>>[];
    expect(H.history).toHaveBeenCalledWith('su-exact', { cursorRaw: 'previous-page' });
    expect(H.detail).not.toHaveBeenCalled();
    expect(H.roster).not.toHaveBeenCalled();
    const messages = sessionTimelineToChatMessages(entries);
    expect(row).toEqual({
      ownerId: 'su-exact', hasMore: true, historyCursor: 'older-cursor',
      turns: deriveSessionTurns(messages).map((turn) => ({
        ...turn, answer: turn.answerIndex == null ? null : messages[turn.answerIndex].content,
      })),
    });
    expect(row).toMatchObject({ turns: [
      { question: 'First question', jumpIndex: 1, answer: 'Final answer', toolCount: 1 },
      { question: 'Unanswered question', answerIndex: null, answer: null, durationMs: null },
    ] });
    expect(JSON.stringify(row)).not.toContain('private tool noise');
  });

  it('does not turn failed history into a known empty conversation', async () => {
    H.history.mockResolvedValue({ ok: false, status: 503, error: 'history unavailable' });
    await expect(readAgentSidebar('su-exact', 'turns')).rejects.toThrow('history unavailable');
  });

  it('distinguishes a valid empty history from an unavailable one', async () => {
    H.history.mockResolvedValue({ ok: true, entries: [], hasMore: false, cursor: null });
    expect(await readAgentSidebar('su-exact', 'turns'))
      .toEqual({ ownerId: 'su-exact', turns: [], hasMore: false, historyCursor: null });
  });

  it('hides machine prompt bodies using the same GUI provenance mapper', async () => {
    H.history.mockResolvedValue({ ok: true, entries: [
      { kind: 'prompt', text: '⟦turn-origin:wake-pump nonce:abc123ef⟧\nINTERNAL WAKE BODY' },
      { kind: 'text', text: 'Visible response' },
    ], hasMore: false, cursor: null });
    const row = await readAgentSidebar('su-exact', 'turns');
    expect(row).toMatchObject({ turns: [{ question: 'Automatic continuation.', answer: 'Visible response' }] });
    expect(JSON.stringify(row)).not.toContain('INTERNAL WAKE BODY');
  });

  it('keeps an unknown owner distinct from a known solo session', async () => {
    expect(await readAgentSidebar('su-exact', 'fleet'))
      .toEqual({ ownerId: 'su-exact', unknownSession: true, fleet: null });
    H.roster.mockResolvedValue({ active: [{ ownerId: 'su-exact', fleetSlug: null }] });
    expect(await readAgentSidebar('su-exact', 'fleet'))
      .toEqual({ ownerId: 'su-exact', unknownSession: false, fleet: null });
  });

  it('borrows fleet ordering, warnings, state and null context from the GUI', async () => {
    const now = Date.parse('2026-11-06T01:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const member = (ownerId: string, fleetSlug: string): HudRosterEntry => ({
      ownerId, label: ownerId, source: 'omp-hook-session', intent: 'working',
      currentFiles: [], liveness: 'live', sessionState: 'live', stale: false,
      lastActiveAt: new Date(now - 1000).toISOString(), intentDeclaredAt: null,
      loopArmed: false, modes: [], pidAlive: true, claims: [], declaredUnclaimed: false,
      currentPlanSlug: null, harnessSlug: null, agentPaneKind: 'su', role: 'su',
      agent: 'codex', advSessionId: 1, windowId: null, wakeMode: 'auto', pendingWakes: 0,
      fleetSlug, fleetColor: null, fleetRole: 'member', contextTokens: null,
      compactionLimit: null, openAwait: null, thinking: false,
    });
    const active = [member('su-exact', 'our-fleet'), member('su-peer', 'our-fleet'), member('su-foreign', 'other-fleet')];
    H.roster.mockResolvedValue({ active });
    const [row] = await resolveNamedQueryV2('agentDetail.byOwner', {
      ownerId: 'su-exact', view: 'fleet', workspaceId: 'ws-exact',
    }) as Awaited<ReturnType<typeof readAgentSidebar>>[];
    expect(H.roster).toHaveBeenCalledWith({ workspaceId: 'ws-exact' });
    expect(row).toEqual({ ownerId: 'su-exact', unknownSession: false,
      fleet: deriveFleetPeers(active, 'su-exact', { nowMs: now }) });
    expect(row).toMatchObject({ fleet: { total: 2, leader: null, warning: 'no leader',
      members: [{ contextPct: null }, { contextPct: null }] } });
    expect(JSON.stringify(row)).not.toContain('su-foreign');
    expect(H.history).not.toHaveBeenCalled();
  });

  it('propagates roster failure instead of reporting solo', async () => {
    H.roster.mockRejectedValue(new Error('roster unavailable'));
    await expect(readAgentSidebar('su-exact', 'fleet')).rejects.toThrow('roster unavailable');
  });

  it('rejects unknown views before reading any store', async () => {
    await expect(resolveNamedQueryV2('agentDetail.byOwner', { ownerId: 'su-exact', view: 'invented' })).rejects.toThrow();
    expect(H.detail).not.toHaveBeenCalled();
    expect(H.history).not.toHaveBeenCalled();
    expect(H.roster).not.toHaveBeenCalled();
  });
});
