/** Native views of the existing agentDetail query. Keep the GUI's derivations
 * authoritative; Rust only renders their DTOs. No private turn/state classifier. */
import { sessionTimelineToChatMessages } from '../../../../apps/operator/app/_components/chat/session-transcript-mapping';
import { deriveSessionTurns } from '../../../../apps/operator/app/_components/chat/session-turn-index';
import { deriveFleetPeers, isUnknownSession } from '../../../../apps/operator/app/_components/chat/fleet-peers';
import type { HudRosterEntry } from '../../../../apps/operator/app/adv/hud/hud-board-model';
import { readOwnerHistoryPage } from './transcript';
import { readSessionRosterSnapshot } from './roster';

export async function readAgentSidebar(
  ownerId: string,
  view: 'turns' | 'fleet',
  opts: { workspaceId?: string; historyCursor?: string } = {},
) {
  if (view === 'turns') {
    const page = await readOwnerHistoryPage(ownerId, { cursorRaw: opts.historyCursor });
    if (!page.ok) throw new Error(page.error);
    const messages = sessionTimelineToChatMessages(page.entries);
    return {
      ownerId,
      turns: deriveSessionTurns(messages).map((turn) => ({
        ...turn,
        // Jump into THIS projection, after the GUI mapper's collapsed tool chips.
        answer: turn.answerIndex == null ? null : messages[turn.answerIndex].content,
      })),
      hasMore: page.hasMore,
      historyCursor: page.cursor,
    };
  }
  const roster = await readSessionRosterSnapshot({ workspaceId: opts.workspaceId });
  const entries = roster.active as unknown as HudRosterEntry[];
  return {
    ownerId,
    unknownSession: isUnknownSession(entries, ownerId),
    fleet: deriveFleetPeers(entries, ownerId, { nowMs: Date.now() }),
  };
}
