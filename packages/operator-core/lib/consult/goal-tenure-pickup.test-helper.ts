/** Native evidence oracle; shared by the live observer and negative controls. */
import assert from 'node:assert/strict';
import { goalTenureGradingMetaFromRouting, goalTenureGradingWakeCopy } from './grading-cascade';

export interface NativePickupBrief {
  ownerId: string;
  nativeSession: string;
  sha256: string;
  text: string;
  hasResponse: boolean;
}

export function assertGoalTenurePickup(input: {
  workspaceId: string; goalId: string; conversationId: string;
  routing: unknown; cursor: number; native: NativePickupBrief; partyKeys: Map<string, string>;
}) {
  const meta = goalTenureGradingMetaFromRouting(input.routing);
  assert(meta, 'persisted residual-grading request required');
  assert.equal(meta.workspaceId, input.workspaceId, 'request workspace mismatch');
  assert.equal(meta.goalId, input.goalId, 'request goal mismatch');
  const routing = (typeof input.routing === 'string' ? JSON.parse(input.routing) : input.routing) as {
    selection?: { selected?: Array<{ ownerId?: string; answeringOwnerId?: string }> };
  };
  assert(Number.isInteger(input.cursor) && input.cursor >= 0, 'persisted cascade cursor required');
  const selected = routing.selection?.selected?.[input.cursor];
  assert(selected?.ownerId && selected.answeringOwnerId, 'persisted answering identity required');
  assert.equal(input.native.ownerId, selected.answeringOwnerId, 'native answering identity mismatch');
  assert(input.native.nativeSession.trim() && /^[a-f\d]{64}$/i.test(input.native.sha256),
    'native session and snapshot hash required');
  assert(input.native.hasResponse, 'native responding turn required; queued delivery is insufficient');
  assert(input.native.text.includes(goalTenureGradingWakeCopy(meta, input.conversationId).body),
    'native first user turn must contain the exact residual-grading assignment');
  const parties = [selected.ownerId, selected.answeringOwnerId, ...meta.holderOwnerIds];
  assert(parties.every(id => input.partyKeys.get(id)), 'complete holder and grader lineage required');
  const holderParties = new Set(meta.holderOwnerIds.map(id => input.partyKeys.get(id)));
  assert(!holderParties.has(input.partyKeys.get(selected.ownerId)), 'source expert shares holder lineage');
  assert(!holderParties.has(input.partyKeys.get(selected.answeringOwnerId)), 'answering grader shares holder lineage');
  return { conversationId: input.conversationId, goalId: meta.goalId,
    sourceOwner: selected.ownerId, answeringOwner: selected.answeringOwnerId,
    nativeSession: input.native.nativeSession, nativeSnapshotSha256: input.native.sha256,
    scope: 'actual-residual-grader-pickup-only' as const };
}
