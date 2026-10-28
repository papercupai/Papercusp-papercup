import {
  EVENT_CATALOG,
  familyAdmitsKey,
  familyKeyPrefix,
  keyMatchesCatalog,
  subjectScopeOf,
  type EventCatalogEntry,
} from './events/await/catalog';
import { findRootAnchor, loadNode } from './events/await/compose-store';
import { inspectEventKey } from './events/await/store';
import type { PredicateWatchRow } from './events/await/predicate-watch';

export type ExternalConditionReachabilityVerdict = 'reachable' | 'impossible' | 'unknown';
export type ExternalConditionReachabilityBasis =
  | 'fired'
  | 'live-resolver'
  | 'cancelled-registration'
  | 'expired-registration'
  | 'missing-registration'
  | 'unmeasured';

export interface ExternalConditionReachability {
  verdict: ExternalConditionReachabilityVerdict;
  basis: ExternalConditionReachabilityBasis;
  authoritative: boolean;
  evidence: string;
  checkedAt: string;
  /** basis 'fired' only: the fire time as the ledger rendered it, so a caller can order it
   * against its own reference point (a durable park must not credit a pre-park fire). */
  firedAt?: string;
  /** Set only when `requireSpecificCondition` refused the key: why no fire of it can prove a
   * condition. Absent on an ordinary 'unmeasured' result (e.g. the resolver failed), so a
   * write-time admission can tell "unprovable" from "could not measure" (P-006). */
  uncertifiedReason?: UncertifiedConditionReason;
}

/**
 * Why a key cannot certify a condition (event-wait-settlement-2026-10-20 P-006):
 *  - 'uncatalogued': no catalogue family admits it and no producer declared it (free text,
 *    a placeholder, or a key nothing emits);
 *  - 'broad': a catalogued key that names no subject (a global, owner or fleet wake such as
 *    `coord:inbox-wake:<owner>` or `git-sync:committed`) — it fires for unrelated reasons;
 *  - 'change-notification': names a subject, but a fire says only that it changed.
 */
export type UncertifiedConditionReason = 'uncatalogued' | 'broad' | 'change-notification';

export interface ExternalConditionReachabilityInput {
  firedAt?: string | null;
  /** A catalogued emitter, active announcement, or owning condition object. */
  liveResolver?: boolean;
  /** Only producer announcements count. Cancelling a consumer await says nothing about the producer. */
  registration?: 'live' | 'cancelled' | 'expired' | 'missing' | 'unmeasured';
}

type ComposedRootLoader = typeof loadNode;
type ComposedRootAnchorLoader = typeof findRootAnchor;

function composedRootId(eventKey: string): number | null {
  const match = /^composed-root:([1-9][0-9]*)$/.exec(eventKey);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The `composed-root:<id>` key is a delivery-shim key, not an event-catalog family.
 * Its producer is the live root node, and the anchor is the delivery path that makes
 * a root trip wakeable. Keep this exact-key check narrow so arbitrary synthetic keys
 * do not become a false reachability proof.
 */
async function hasActiveComposedRootAnchor(
  eventKey: string,
  loadRoot: ComposedRootLoader,
  loadAnchor: ComposedRootAnchorLoader,
): Promise<boolean> {
  const rootId = composedRootId(eventKey);
  if (rootId == null) return false;
  const root = await loadRoot(rootId);
  if (
    !root ||
    root.id !== rootId ||
    root.rootId !== rootId ||
    root.parentId !== null ||
    root.firedAt !== null ||
    root.cancelledAt !== null
  ) {
    return false;
  }
  return (await loadAnchor(rootId)) !== null;
}

type PredicateWatchLoader = (id: string) => Promise<Pick<PredicateWatchRow, 'eventKey' | 'active'> | null>;

const PREDICATE_KEY_PREFIX = 'predicate:';

/**
 * Lazy on purpose: predicate-watch.ts pulls in the projected-tool dispatch graph,
 * which reaches this module through loop:arm. engine.ts loads it the same way.
 */
async function loadPredicateWatchRow(id: string): Promise<PredicateWatchRow | null> {
  const { getPredicateWatch } = await import('./events/await/predicate-watch');
  return getPredicateWatch(id);
}

/**
 * A `predicate:<id>` key is minted at runtime by watch:create / state:subscribe, so no
 * catalog family can know it. Its producer is the durable predicate_watches row: while
 * that exact row is active, the poller can still fire the key. This is the same emitter
 * contract events:await applies (EI-25832685839560534). An inactive row proves nothing
 * on its own; a fire it already made is read from the fire latch instead.
 */
async function hasActivePredicateWatch(eventKey: string, load: PredicateWatchLoader): Promise<boolean> {
  if (!eventKey.startsWith(PREDICATE_KEY_PREFIX)) return false;
  const id = eventKey.slice(PREDICATE_KEY_PREFIX.length);
  if (!id) return false;
  const row = await load(id);
  return Boolean(row && row.active && row.eventKey === eventKey);
}

/**
 * Pure tri-state classifier. Time is used only to stamp evidence; age is never a
 * reachability input. In particular, an old unregistered condition remains
 * unknown rather than silently becoming impossible.
 */
export function classifyExternalConditionReachability(
  input: ExternalConditionReachabilityInput,
  now = new Date().toISOString(),
): ExternalConditionReachability {
  if (input.firedAt) {
    // The latch path hands back a postgres.js Date despite the declared string type; String()
    // of that renders the host-local Date.toString() form, so normalise it to ISO.
    const raw: unknown = input.firedAt;
    const firedAt = raw instanceof Date ? raw.toISOString() : String(raw);
    return {
      verdict: 'reachable',
      basis: 'fired',
      authoritative: true,
      evidence: `event fired at ${firedAt}`,
      checkedAt: now,
      firedAt,
    };
  }
  if (input.liveResolver || input.registration === 'live') {
    return {
      verdict: 'reachable',
      basis: 'live-resolver',
      authoritative: true,
      evidence: 'a live resolver or producer registration can still satisfy the condition',
      checkedAt: now,
    };
  }
  if (input.registration === 'cancelled') {
    return {
      verdict: 'impossible',
      basis: 'cancelled-registration',
      authoritative: true,
      evidence: 'the latest authoritative producer registration was cancelled',
      checkedAt: now,
    };
  }
  if (input.registration === 'expired') {
    return {
      verdict: 'impossible',
      basis: 'expired-registration',
      authoritative: true,
      evidence: 'the latest authoritative producer registration expired',
      checkedAt: now,
    };
  }
  if (input.registration === 'missing') {
    return {
      verdict: 'unknown',
      basis: 'missing-registration',
      authoritative: false,
      evidence: 'no producer registration or catalogued resolver was found',
      checkedAt: now,
    };
  }
  return {
    verdict: 'unknown',
    basis: 'unmeasured',
    authoritative: false,
    evidence: 'reachability could not be measured',
    checkedAt: now,
  };
}

function latestAnnouncementState(
  announcements: Awaited<ReturnType<typeof inspectEventKey>>['announcements'],
  nowMs: number,
): ExternalConditionReachabilityInput['registration'] {
  const latest = announcements.find((row) => !row.supersededAt);
  if (!latest) return 'missing';
  if (latest.cancelledAt) return 'cancelled';
  if (latest.expiresTs) {
    const expires = Date.parse(latest.expiresTs);
    if (Number.isFinite(expires) && expires <= nowMs) return 'expired';
  }
  return 'live';
}

/**
 * A wake's reachability is not evidence for an arbitrary named release condition.
 * Reuse the catalogue's subject contract: only a concrete required subject key,
 * or an explicitly declared non-catalogue gate, binds a condition. Declaring a
 * global/owner/fleet notification cannot turn that broad wake into subject proof.
 * Optional parameters remain unverified because the family does not require a subject.
 */
export function eventHasSpecificCondition(eventKey: string, producerDeclared = false): boolean {
  const key = concreteEventKey(eventKey);
  if (!key) return false;
  const families = EVENT_CATALOG.filter((entry) => familyAdmitsKey(entry, key));
  if (families.length === 0) return producerDeclared;
  return families.some((entry) => bindsConcreteSubject(entry, key));
}

/**
 * event-wait-settlement-2026-10-20 P-001 — may ONE fire of `eventKey` release work that
 * waits on it? This is the predicate every releasing path uses: the blocker re-check
 * sweep and durable-park settlement/stamping, via
 * `readEventConditionReachability({ requireSpecificCondition })`, and the durable-park
 * audit directly.
 *
 * Stricter than {@link eventHasSpecificCondition}, which only asks whether the key
 * names a concrete subject. `work-item:status:WI-1` names one, yet its fire says only
 * that WI-1 changed — the state a waiter wanted may already have reversed. So a
 * catalogued key certifies its condition only when EVERY family admitting it binds a
 * concrete subject AND is classified a completion family (`fireProves: 'condition'`,
 * events/await/catalog.ts). Unclassified is never proof. A key no family admits is
 * proof only when its producer declared it (an announcement or a live predicate watch
 * binds exactly one condition) — unchanged from the subject check.
 */
export function fireCertifiesCondition(eventKey: string, producerDeclared = false): boolean {
  const key = concreteEventKey(eventKey);
  if (!key) return false;
  const families = EVENT_CATALOG.filter((entry) => familyAdmitsKey(entry, key));
  if (families.length === 0) return producerDeclared;
  // One change-notification reading of the same key is enough doubt to keep work parked.
  return families.every((entry) => bindsConcreteSubject(entry, key) && entry.fireProves === 'condition');
}

/** Why {@link fireCertifiesCondition} refuses `eventKey`, or null when it certifies. */
export function uncertifiedConditionReason(
  eventKey: string,
  producerDeclared = false,
): UncertifiedConditionReason | null {
  if (fireCertifiesCondition(eventKey, producerDeclared)) return null;
  const key = concreteEventKey(eventKey);
  if (!key) return 'uncatalogued';
  const families = EVENT_CATALOG.filter((entry) => familyAdmitsKey(entry, key));
  if (families.length === 0) return 'uncatalogued';
  return families.some((entry) => bindsConcreteSubject(entry, key)) ? 'change-notification' : 'broad';
}

function concreteEventKey(eventKey: string): string | null {
  const key = eventKey.trim();
  return !key || /[*<>]/.test(key) ? null : key;
}

/**
 * Optional parameters stay unverified: the bare prefix of an id family binds nothing.
 * Neither does an empty segment — familyAdmitsKey admits `work-item:done:` (one tail
 * segment, as its arity bound requires), but that segment names no subject.
 */
function bindsConcreteSubject(entry: EventCatalogEntry, key: string): boolean {
  const prefix = familyKeyPrefix(entry);
  if (key === prefix || subjectScopeOf(entry) !== 'id') return false;
  return key.slice(prefix.length + 1).split(':').every((segment) => segment.trim() !== '');
}

/** Why `requireSpecificCondition` refused a key — the evidence a holder acts on. */
function uncertifiedTriggerEvidence(eventKey: string, producerDeclared: boolean): string {
  if (eventHasSpecificCondition(eventKey, producerDeclared)) {
    return `trigger "${eventKey}" is a change notification: a fire says its subject changed, not that it reached ` +
      'the specific release condition; park on a completion key for the same subject (e.g. work-item:done:<id>)';
  }
  return `trigger "${eventKey}" may wake a consumer but cannot establish the specific release condition; ` +
    'subject-bound evidence is required';
}

/** Resolve one event/gate key from the existing event ledger and emitter catalog. */
export async function readEventConditionReachability(
  eventKey: string,
  opts: {
    inspect?: typeof inspectEventKey;
    now?: Date;
    loadComposedRoot?: ComposedRootLoader;
    loadComposedRootAnchor?: ComposedRootAnchorLoader;
    loadPredicateWatch?: PredicateWatchLoader;
    /**
     * A release needs condition evidence, not merely an emitter that can wake it: the key
     * must pass {@link fireCertifiesCondition}, so a change notification is never proof.
     */
    requireSpecificCondition?: boolean;
  } = {},
): Promise<ExternalConditionReachability> {
  const now = opts.now ?? new Date();
  const inspect = opts.inspect ?? inspectEventKey;
  const loadComposedRoot = opts.loadComposedRoot ?? loadNode;
  const loadComposedRootAnchor = opts.loadComposedRootAnchor ?? findRootAnchor;
  const loadPredicateWatch = opts.loadPredicateWatch ?? loadPredicateWatchRow;
  if (opts.requireSpecificCondition) {
    // Broad wakes and change notifications can never certify a specific condition,
    // even when announced. Refuse them before touching the event ledger: that read
    // cannot change the result, and an unavailable admin pool must not turn this
    // deterministic refusal into a misleading `unmeasured` resolver failure.
    const deterministicRefusal = uncertifiedConditionReason(eventKey);
    if (deterministicRefusal === 'broad' || deterministicRefusal === 'change-notification') {
      return {
        ...classifyExternalConditionReachability({ registration: 'unmeasured' }, now.toISOString()),
        evidence: uncertifiedTriggerEvidence(eventKey, false),
        uncertifiedReason: deterministicRefusal,
      };
    }
  }
  try {
    const snapshot = await inspect(eventKey);
    // An announcement is a causal generation boundary. The per-key fire latch
    // intentionally retains history across generations, so it may only be used
    // when there is no current declaration. Otherwise a fire from generation N
    // would incorrectly satisfy a newly declared generation N+1.
    const currentAnnouncement = snapshot.announcements.find((row) => !row.supersededAt);
    // An active predicate watch is a declared producer of one specific condition
    // (tool, path, op, operand), so it binds the condition the way an announcement does.
    const predicateWatchLive = await hasActivePredicateWatch(eventKey, loadPredicateWatch);
    const producerDeclared = Boolean(currentAnnouncement) || predicateWatchLive;
    const uncertified = opts.requireSpecificCondition
      ? uncertifiedConditionReason(eventKey, producerDeclared)
      : null;
    if (uncertified) {
      return {
        ...classifyExternalConditionReachability({ registration: 'unmeasured' }, now.toISOString()),
        evidence: uncertifiedTriggerEvidence(eventKey, producerDeclared),
        uncertifiedReason: uncertified,
      };
    }
    // Expiry stamps firedAt too, but it is not a successful condition fire.
    // Only the event emitter's explicit reason is authoritative here.
    const firedAt = currentAnnouncement
      ? currentAnnouncement.firedReason === 'event'
        ? currentAnnouncement.firedAt
        : null
      : snapshot.fireLatch?.lastFiredAt ?? null;
    const composedRootReachable = await hasActiveComposedRootAnchor(
      eventKey,
      loadComposedRoot,
      loadComposedRootAnchor,
    );
    return classifyExternalConditionReachability(
      {
        firedAt,
        liveResolver: keyMatchesCatalog(eventKey, EVENT_CATALOG) || composedRootReachable || predicateWatchLive,
        registration: latestAnnouncementState(snapshot.announcements, now.getTime()),
      },
      now.toISOString(),
    );
  } catch (error) {
    return {
      ...classifyExternalConditionReachability({ registration: 'unmeasured' }, now.toISOString()),
      evidence: `reachability resolver failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
