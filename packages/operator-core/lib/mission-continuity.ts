/**
 * Deterministic mission continuity. Current activity remains the responsibility
 * of resolveAgentGoal; this contract retains the authorized assignment it serves.
 * No clock, database, model call or delivery happens in the reducer.
 * deterministic-mission-continuity-2026-11-05, D-002/D-004/D-006/D-007.
 */
import { createHash } from 'node:crypto';

export const MISSION_POLICY = Object.freeze({
  directedMs: 10 * 60_000,
  repairMs: 30 * 60_000,
  maxFrames: 8,
  rememberedEvents: 32,
});

export interface MissionBinding {
  assignmentRef: string;
  ownerDirectiveRef: string | null;
  objectiveRefs: string[];
  completionCriteriaRefs: string[];
  accountableOwner: string;
  custodyGeneration: number;
  assignmentRevision: number;
  authorityRef: string;
}

export type MissionDisposition = 'ready' | 'blocked' | 'complete' | 'cancelled' | 'transferred' | 'unknown';

/** A fresh authoritative read, never a carried status or the latest child's state. */
export interface MissionParent extends MissionBinding {
  disposition: MissionDisposition;
  blockerRef: string | null;
  nextActionRef: string | null;
}

export interface MissionFrame {
  id: string;
  parentRef: string;
  displacedContinuationRef: string;
  childOrMessageRef: string;
  acceptedOperationRef: string;
  reasonCode: 'directed-obligation' | 'blocking-repair';
  policyRef: 'mission-directed-v1' | 'mission-repair-v1';
  openedByEvent: string;
  openedAt: number;
  policyBudgetMs: number;
  absoluteDeadline: number;
  returnResolverRef: string;
  settled: boolean;
}

export interface MissionState {
  schemaVersion: 1;
  binding: MissionBinding | null;
  stateAvailability: 'available' | 'unknown';
  currentWorkRef: string | null;
  frames: MissionFrame[];
  selectionRevision: number;
  disposition: MissionDisposition;
  blockerRef: string | null;
  nextActionRef: string | null;
  processedEvents: string[];
  unknownReason: string | null;
}

export interface AcceptedMissionActivity {
  selectedRef: string;
  /** A durable acceptance receipt. Arrival/claim/intent alone cannot supply it. */
  acceptedOperationRef: string | null;
  accepted: boolean;
  changesFocus: boolean;
  displacedContinuationRef: string | null;
  relationship: 'same-assignment' | 'blocking-repair' | 'directed-obligation' | 'unknown';
  selectionRevision: number;
}

export type MissionEvent = { id: string } & (
  | { kind: 'assignment-accepted'; binding: MissionBinding; currentWorkRef: string | null; replace?: boolean }
  | { kind: 'activity-accepted'; activity: AcceptedMissionActivity }
  | { kind: 'child-ended'; childRef: string; terminal: boolean }
  | { kind: 'turn-ended' | 'recovered' | 'budget-expired' | 'authority-changed' }
);

export interface MissionConsequence {
  id: string;
  kind: 'resume-parent' | 'budget-exhausted';
  assignmentRef: string;
  ownerId: string;
  custodyGeneration: number;
  assignmentRevision: number;
  triggerEvent: string;
  /** Deadlines are part of persisted intent; replay must not reset them. */
  absoluteDeadline: number | null;
  continuationRef: string;
}

export interface MissionTransition {
  state: MissionState;
  consequences: MissionConsequence[];
  classification: 'binding' | 'progress' | 'detour' | 'signal-only' | 'unknown' | 'reconcile' | 'stale' | 'duplicate';
}

export function emptyMissionState(reason = 'no-authoritative-binding'): MissionState {
  return {
    schemaVersion: 1, binding: null, stateAvailability: 'unknown', currentWorkRef: null,
    frames: [], selectionRevision: 0, disposition: 'unknown', blockerRef: null,
    nextActionRef: null, processedEvents: [], unknownReason: reason,
  };
}

export function classifyMissionActivity(activity: AcceptedMissionActivity): 'progress' | 'detour' | 'signal-only' | 'unknown' {
  if (!activity.accepted || !activity.acceptedOperationRef || !activity.changesFocus) return 'signal-only';
  if (activity.relationship === 'same-assignment') return 'progress';
  if (activity.relationship === 'unknown' || !activity.displacedContinuationRef) return 'unknown';
  return 'detour';
}

function copyBinding(binding: MissionBinding): MissionBinding {
  // Canonical parent reads carry live disposition fields too. Structural typing
  // permits passing that richer value; only the declared binding is retained.
  return {
    assignmentRef: binding.assignmentRef, ownerDirectiveRef: binding.ownerDirectiveRef,
    objectiveRefs: [...binding.objectiveRefs], completionCriteriaRefs: [...binding.completionCriteriaRefs],
    accountableOwner: binding.accountableOwner, custodyGeneration: binding.custodyGeneration,
    assignmentRevision: binding.assignmentRevision, authorityRef: binding.authorityRef,
  };
}

function sameCustody(a: MissionBinding, b: MissionBinding): boolean {
  return a.assignmentRef === b.assignmentRef && a.accountableOwner === b.accountableOwner &&
    a.custodyGeneration === b.custodyGeneration;
}

/** The row transaction persists both this state and these consequences together. */
export function reduceMissionContinuity(
  previous: MissionState | null,
  event: MissionEvent,
  parent: MissionParent | null,
  nowMs: number,
): MissionTransition {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('mission clock must be an absolute millisecond timestamp');
  const state: MissionState = previous ? {
    ...previous, binding: previous.binding && copyBinding(previous.binding),
    frames: previous.frames.map(frame => ({ ...frame })), processedEvents: [...previous.processedEvents],
  } : emptyMissionState();
  const result: MissionTransition = { state, consequences: [], classification: 'reconcile' };
  if (state.processedEvents.includes(event.id)) return { ...result, classification: 'duplicate' };

  if (event.kind === 'assignment-accepted') {
    const incoming = event.binding;
    if (state.binding && (
      (incoming.assignmentRef !== state.binding.assignmentRef && !event.replace) ||
      (incoming.assignmentRef === state.binding.assignmentRef && (
        incoming.custodyGeneration < state.binding.custodyGeneration ||
        (incoming.custodyGeneration === state.binding.custodyGeneration &&
          incoming.assignmentRevision < state.binding.assignmentRevision)
      ))
    )) return { ...result, classification: 'stale' };
    const changed = !state.binding || !sameCustody(state.binding, incoming) || event.replace;
    state.binding = copyBinding(incoming);
    if (changed) {
      state.frames = [];
      state.selectionRevision = 0;
      state.currentWorkRef = event.currentWorkRef;
    }
    result.classification = 'binding';
  }

  if (!state.binding || !parent || parent.assignmentRef !== state.binding.assignmentRef) {
    state.stateAvailability = 'unknown';
    state.disposition = 'unknown';
    state.unknownReason = !state.binding ? 'no-authoritative-binding' : 'parent-read-unavailable';
    state.nextActionRef = state.binding?.assignmentRef ?? null;
    return { ...result, classification: 'unknown' };
  }
  if (parent.custodyGeneration < state.binding.custodyGeneration ||
    parent.assignmentRevision < state.binding.assignmentRevision) return { ...result, classification: 'stale' };
  if (!sameCustody(state.binding, parent)) {
    // A stale worker must not adopt someone else's custody and wake them.
    state.frames = [];
    state.disposition = 'transferred';
    state.stateAvailability = 'available';
    state.nextActionRef = null;
    state.unknownReason = null;
    return result;
  }
  state.binding = copyBinding(parent);
  state.stateAvailability = parent.disposition === 'unknown' ? 'unknown' : 'available';
  state.disposition = parent.disposition;
  state.blockerRef = parent.blockerRef;
  state.nextActionRef = parent.nextActionRef;
  state.unknownReason = parent.disposition === 'unknown' ? 'parent-disposition-unavailable' : null;
  // Unavailable reads must not consume an event: the durable caller can retry
  // the same child-completion receipt once authority becomes readable again.
  if (parent.disposition !== 'unknown') {
    state.processedEvents = [...state.processedEvents, event.id].slice(-MISSION_POLICY.rememberedEvents);
  }
  if (['complete', 'cancelled', 'transferred'].includes(parent.disposition)) {
    state.frames = [];
    state.nextActionRef = null;
    return result;
  }
  if (parent.disposition === 'unknown') return result;

  if (event.kind === 'activity-accepted') {
    const activity = event.activity;
    result.classification = classifyMissionActivity(activity);
    if (result.classification === 'signal-only') return result;
    if (activity.selectionRevision <= state.selectionRevision) return { ...result, classification: 'stale' };
    if (activity.displacedContinuationRef !== state.currentWorkRef) {
      state.stateAvailability = 'unknown';
      state.unknownReason = 'displaced-continuation-mismatch';
      return { ...result, classification: 'unknown' };
    }
    if (result.classification === 'unknown') {
      state.stateAvailability = 'unknown';
      state.unknownReason = 'ambiguous-accepted-selection';
      return result;
    }
    if (result.classification === 'detour') {
      if (state.frames.length >= MISSION_POLICY.maxFrames) {
        state.stateAvailability = 'unknown';
        state.unknownReason = 'interruption-depth-exhausted';
        return { ...result, classification: 'unknown' };
      }
      const repair = activity.relationship === 'blocking-repair';
      const policyBudgetMs = repair ? MISSION_POLICY.repairMs : MISSION_POLICY.directedMs;
      state.frames.push({
        id: activity.acceptedOperationRef!, parentRef: parent.assignmentRef,
        displacedContinuationRef: activity.displacedContinuationRef!, childOrMessageRef: activity.selectedRef,
        acceptedOperationRef: activity.acceptedOperationRef!, reasonCode: repair ? 'blocking-repair' : 'directed-obligation',
        policyRef: repair ? 'mission-repair-v1' : 'mission-directed-v1', openedByEvent: event.id,
        openedAt: nowMs, policyBudgetMs,
        absoluteDeadline: Math.min(nowMs + policyBudgetMs, ...state.frames.map(frame => frame.absoluteDeadline)),
        returnResolverRef: parent.assignmentRef, settled: false,
      });
    }
    state.currentWorkRef = activity.selectedRef;
    state.selectionRevision = activity.selectionRevision;
    return result;
  }

  let returned: MissionFrame | undefined;
  let expired = false;
  if (event.kind === 'child-ended' && event.terminal) {
    for (const frame of state.frames) if (frame.childOrMessageRef === event.childRef) frame.settled = true;
  }
  if (event.kind === 'budget-expired') {
    for (const frame of state.frames) if (frame.absoluteDeadline <= nowMs) { frame.settled = true; expired = true; }
  }
  while (state.frames.at(-1)?.settled) {
    returned = state.frames.pop();
    state.currentWorkRef = returned!.displacedContinuationRef;
  }
  // Turn end/recovery refreshes a projection, without inventing an interruption
  // or turning every ordinary turn into a new wake.
  if (returned && parent.disposition === 'ready' && parent.nextActionRef) {
    const kind = expired ? 'budget-exhausted' : 'resume-parent';
    result.consequences.push({
      id: `mission:${createHash('sha256').update(JSON.stringify([
        parent.assignmentRef, parent.assignmentRevision, parent.custodyGeneration, returned.id, kind,
      ])).digest('hex')}`,
      kind, assignmentRef: parent.assignmentRef, ownerId: parent.accountableOwner,
      custodyGeneration: parent.custodyGeneration, assignmentRevision: parent.assignmentRevision,
      triggerEvent: event.id, absoluteDeadline: returned.absoluteDeadline,
      continuationRef: state.frames.length ? state.currentWorkRef! : parent.nextActionRef,
    });
  }
  return result;
}

/** One bounded projection for carry, orientation and status. Text stays canonical. */
export function projectMissionContinuity(state: MissionState, frameLimit = 4) {
  const limit = Math.max(0, Math.min(MISSION_POLICY.maxFrames, Math.trunc(frameLimit)));
  return {
    assignmentRef: state.binding?.assignmentRef ?? null,
    ownerDirectiveRef: state.binding?.ownerDirectiveRef ?? null,
    objectiveRefs: state.binding?.objectiveRefs ?? [], completionCriteriaRefs: state.binding?.completionCriteriaRefs ?? [],
    accountableOwner: state.binding?.accountableOwner ?? null,
    custodyGeneration: state.binding?.custodyGeneration ?? null, assignmentRevision: state.binding?.assignmentRevision ?? null,
    currentWorkRef: state.currentWorkRef, stateAvailability: state.stateAvailability,
    disposition: state.disposition, blockerRef: state.blockerRef, nextActionRef: state.nextActionRef,
    interruptionFrames: limit ? state.frames.slice(-limit) : [],
    omittedFrames: state.frames.slice(0, Math.max(0, state.frames.length - limit)).map(frame => frame.id),
    unknownReason: state.unknownReason,
  };
}
