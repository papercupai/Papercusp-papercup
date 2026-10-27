/**
 * The cancel_reason each SYSTEM cancel path stamps on harness_shared.event_awaits
 * (WI-10005938 class fix).
 *
 * A NULL reason reads as unexplained churn wherever delivery is measured:
 * goal-holder-behavior-metrics counts `cancel_reason IS NULL` as unexplained,
 * so a cancel that names no reason makes a reminder plane look broken. In one
 * measured 2h window, 18 agent-obligation watches were cancelled through these
 * generic paths with no reason at all, beside 22 more retired by re-registration.
 *
 * Rule: every UPDATE that sets event_awaits.cancelled_at also sets a non-null
 * cancel_reason. cancel-reason-coverage.test.ts scans the tree and fails on a
 * new path that does not.
 *
 * 'operator' is deliberately absent: it is the user-cancel marker that
 * suppresses a later auto-arm (index event_awaits_operator_cancelled_key) and
 * is set only through cancelAwaitDetailed's `source:'operator'`.
 *
 * Leaf module (no imports) so store.ts, compose-store.ts, the idle-session
 * reaper and rebind-identity can all import it without a cycle.
 */
/**
 * WI-6554700010030084: the last_error phrase a cancelled await's delivery keeps when the psu host
 * had ALREADY accepted it (parked "delivery accepted before turn-start proof"). A cold loop's
 * context reset ends the session it was delivered to, and SessionEnd hygiene then cancels that
 * session's standing inbox wake and drops the reset's own row. Dropping is correct (a retry could
 * re-inject the reset into the successor), but the row is not an undelivered fire, and
 * lastLoopFireParked (agent-tools/loop/next-wake.ts) must be able to tell.
 */
export const HOST_ACCEPTED_CANCELLED_DELIVERY_MARKER = 'after the psu host had accepted this delivery';

export const AWAIT_CANCEL_REASONS = {
  /** retireLifecycleBoundWatches: the claim / lane / obligation the watch was bound to ended. */
  lifecycleBindingRetired: 'lifecycle-binding-retired',
  /** retireWatchesForReapedOwners: the subscriber was reaped as confirmed dead. */
  ownerReaped: 'owner-reaped',
  /** cancelInboxWakeAwaits: SessionEnd hygiene for the standing inbox wake. */
  inboxWakeSessionEnded: 'inbox-wake-session-ended',
  /** cancelClaimableAwaits: the subscriber claimed work, so its idle wait is stale. */
  claimableWorkClaimed: 'claimable-work-claimed',
  /** cancelClaimableAwaits { includeStanding }: the subscriber's fleet is paused. */
  claimableFleetPaused: 'claimable-fleet-paused',
  /** cancelAwaitsForSubscribersOnKeys default: a sibling outcome fired, or a re-arm superseded the key. */
  siblingOrSupersededKey: 'sibling-or-superseded-key',
  /** cancelAwaitsByIds default: the caller identified exactly these dead registrations. */
  exactIdCleanup: 'exact-id-cleanup',
  /** cancelAwaitDetailed without source or reason: an internal cleanup caller. */
  internalCleanup: 'internal-cleanup',
  /** voidTreeDescendants: a composed root fired, so its pending leaves are void. */
  composedTreeVoided: 'composed-tree-voided',
  /** cancelComposedTree without source:'operator': an internal caller cancelled the tree. */
  composedTreeCancelled: 'composed-tree-cancelled',
  /** reconcileComposedRoot: the root settled, so its remaining leaves are void. */
  composedRootSettled: 'composed-root-settled',
  /** rebind-identity: the moved await duplicated one the new identity already holds. */
  identityRebound: 'identity-rebound',
  /** Channel 2 withheld a grading-auditor resume because its exact target lease settled or changed. */
  gradingAuditNoLongerCurrent: 'grading-audit-no-longer-current',
  /** reclaimDanglingInboxWakeAwaits: the idle reaper found the owner dead. */
  danglingInboxWakeReclaimed: 'dangling-inbox-wake-reclaimed',
} as const;

export type AwaitSystemCancelReason = (typeof AWAIT_CANCEL_REASONS)[keyof typeof AWAIT_CANCEL_REASONS];
