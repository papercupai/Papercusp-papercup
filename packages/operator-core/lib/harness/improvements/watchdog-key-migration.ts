/**
 * watchdog-key-migration.ts — a reusable, dry-run-default backfill that
 * recomputes the `payload.watchdogKey` of OPEN improvement EIs when the dedup
 * key SHAPE changes (watchdog-and-exposed-systems-improvement-2026-06-18 P-012).
 *
 * WHY this exists. The watchdog dedups a signal across ticks by an indexed
 * `payload.watchdogKey` (`<source>:<key>`). When the key shape changes — e.g.
 * P-012 adding a `:<fingerprint>` segment to `caller`/`transient` tool-error
 * keys so distinct same-class modes stop colliding — every OPEN EI still carries
 * the OLD shape. The next tick emits the NEW shape, which no longer matches, so
 * the open EI is ORPHANED (never dedups / ages / auto-closes against the live
 * signal) AND a fresh duplicate is filed → re-file churn. This is the lesson
 * behind the P-003 "must-be-post-deploy backfill". Running this routine ONCE
 * after the new collector deploys migrates the open EIs to the new shape so they
 * keep matching what the live collector now emits.
 *
 * GENERIC by design: `recomputeWatchdogKeys(deriveKey, deps, opts)` takes a pure
 * `deriveKey(candidate) → newKey | null`, so any FUTURE key-shape change is just
 * a new deriver + one call — future dedup-key changes are safe.
 * `deriveToolErrorWatchdogKey` recomputes the fingerprint from each open
 * tool-error EI's STORED SAMPLE (its body) and appends it. It also upgrades the
 * former first-six-token fingerprint shape to the full-message digest.
 *
 * PURE (no PG): the IO seam is `RecomputeDeps`. The live-PG deps + the
 * post-deploy CLI live in `apps/operator/scripts/recompute-watchdog-keys.ts`.
 */

import {
  toolErrorKeyParts,
  toolErrorSignalKey,
  TOOL_KEYED_TOOL_ERROR_CLASSES,
  type ToolErrorClass,
} from './tool-error-classifier';
import type { ImprovementCandidate } from './policy';

/** The watchdog source prefix for tool-error keys (`watchdogKeyOf` = source:key). */
export const REPEATED_TOOL_ERROR_PREFIX = 'repeated-tool-error:';

const TOOL_ERROR_CLASSES: readonly ToolErrorClass[] = ['structural', 'transient', 'caller', 'rate-limit'];

/**
 * A parsed repeated-tool-error key. Current shape
 * (bug-inflow-one-problem-one-row-2026-10-18 D-004):
 *   `<tool>:<class>` (transient / rate-limit / caller — caller per D-010) or
 *   `<tool>:<class>:<errorCode>:<fieldPath>` (structural). A caller row minted
 *   before D-010 still carries the 4-part shape until the migration re-keys it.
 * LEGACY open rows still carry `<tool>:<class>:<fingerprint>` (one remainder
 * segment) until the key migration re-keys them; those parse with `fingerprint`
 * set and `errorCode`/`fieldPath` null.
 */
export interface ParsedToolErrorKey {
  tool: string;
  klass: ToolErrorClass;
  errorCode: string | null;
  fieldPath: string | null;
  fingerprint: string | null;
}

// Non-greedy tool group: the FIRST whole class segment splits tool from the rest,
// so a tool name containing `:` (e.g. `plans:list`) never confuses the split.
const TOOL_ERROR_KEY_RE = new RegExp(
  `^repeated-tool-error:(.+?):(${TOOL_ERROR_CLASSES.join('|')})(?::(.+))?$`,
);

/** Pure: parse a repeated-tool-error watchdogKey into its parts; null for any other key. */
export function parseRepeatedToolErrorKey(key: string): ParsedToolErrorKey | null {
  const m = TOOL_ERROR_KEY_RE.exec(key);
  if (!m) return null;
  const rest = m[3] ?? null;
  const sep = rest ? rest.indexOf(':') : -1;
  return sep > 0
    ? { tool: m[1], klass: m[2] as ToolErrorClass, errorCode: rest!.slice(0, sep), fieldPath: rest!.slice(sep + 1), fingerprint: null }
    : { tool: m[1], klass: m[2] as ToolErrorClass, errorCode: null, fieldPath: null, fingerprint: rest };
}

/**
 * Pure: pull the representative error sample out of a watchdog tool-error EI
 * body. The collector writes "… Sample error: <msg>" (structural) or
 * "… Sample: <msg>" (transient/caller/rate-limit) as the LAST line; the
 * fingerprint is derived from that sample. Returns null when
 * no sample line is present.
 */
export function extractSampleFromBody(body: string | null | undefined): string | null {
  const m = /Sample(?: error)?:\s*([\s\S]+)$/.exec(body ?? '');
  return m ? m[1].trim() || null : null;
}

/**
 * For an OPEN tool-error EI still keyed in a LEGACY shape (a message fingerprint
 * segment, or a structural/caller key with no code/field), recompute the current
 * structural key (bug-inflow-one-problem-one-row-2026-10-18 D-004) so it keeps
 * matching what the live collector emits:
 *   - transient / rate-limit / caller → `<tool>:<class>` (no sample needed; a
 *     pre-D-010 caller key `<tool>:caller:<code>:<field>` re-keys here too, so
 *     several caller rows of one tool fold onto one key via watchdog-key-fold);
 *   - structural → `<tool>:<class>:<errorCode>:<fieldPath>` derived from
 *     the stored sample plus the failure's `error_code` column, which the body
 *     does not carry: `errorCodeOf` supplies it (the CLI looks it up in the
 *     invocation ledger). Without it only a code carried IN the message is used.
 * Returns null (no migration) for non-tool-error keys, keys already in the
 * current shape, and structural/caller EIs with no stored sample.
 */
export function deriveToolErrorWatchdogKey(
  candidate: ImprovementCandidate,
  errorCodeOf?: (candidate: ImprovementCandidate, tool: string, sample: string) => string | null,
): string | null {
  const key = candidate.watchdogKey;
  if (typeof key !== 'string' || !key.startsWith(REPEATED_TOOL_ERROR_PREFIX)) return null;
  const parsed = parseRepeatedToolErrorKey(key);
  if (!parsed) return null;
  let newKey: string;
  if (TOOL_KEYED_TOOL_ERROR_CLASSES.has(parsed.klass)) {
    newKey = `${REPEATED_TOOL_ERROR_PREFIX}${toolErrorSignalKey(parsed.tool, parsed.klass, null, null)}`;
  } else {
    if (parsed.errorCode !== null) return null; // already structural
    const sample = extractSampleFromBody(candidate.body);
    if (!sample) return null;
    const parts = toolErrorKeyParts(errorCodeOf?.(candidate, parsed.tool, sample) ?? null, sample);
    newKey = `${REPEATED_TOOL_ERROR_PREFIX}${toolErrorSignalKey(parsed.tool, parsed.klass, parts.errorCode, parts.fieldPath)}`;
  }
  return newKey === key ? null : newKey;
}

export interface WatchdogKeyChange {
  id: string;
  oldKey: string;
  newKey: string;
}

export interface WatchdogKeyCollision extends WatchdogKeyChange {
  /** The OPEN EI that already holds `newKey` (so migrating would create a duplicate key). */
  heldBy: string;
}

export interface RecomputeResult {
  /** Open EIs carrying a watchdogKey that were considered. */
  scanned: number;
  /** EIs whose key was (or, in dry-run, would be) migrated. */
  changed: WatchdogKeyChange[];
  /** EIs SKIPPED because their new key already belongs to another open EI. */
  collisions: WatchdogKeyCollision[];
  /** EIs the deriver left alone (newKey null or unchanged). */
  unchanged: number;
  /** Whether this was a dry run (no writes). */
  dryRun: boolean;
}

/**
 * A candidate as the recompute sees it. `workspaceId` scopes key ownership: the
 * watchdog dedups per workspace, so a key held in one workspace never makes a row
 * in another a collision. Absent → every candidate shares one unnamed scope.
 */
export type KeyedCandidate = ImprovementCandidate & { workspaceId?: string };

export interface RecomputeDeps {
  /**
   * NON-TERMINAL improvement candidates that carry a `payload.watchdogKey`, in
   * canonical order (the first row per workspace + key holds it). Listing wip /
   * blocked rows too means a duplicate of a blocked row still folds onto it.
   */
  listOpenKeyed: () => Promise<KeyedCandidate[]>;
  /** Persist a recomputed key onto one EI (e.g. `mergeIssuePayload(id, { watchdogKey })`). */
  setWatchdogKey: (id: string, newKey: string) => Promise<void>;
}

/**
 * Recompute open EIs' watchdogKeys via a pluggable `deriveKey`. Dry-run by
 * DEFAULT (reports what it would do, writes nothing). Collision-safe: if a
 * recomputed key already belongs to ANOTHER open EI (or to one migrated earlier
 * in this pass), the row is SKIPPED and reported as a collision rather than
 * minting a second open EI on the same key — a genuine duplicate the dedup /
 * auto-close path reconciles. Two open EIs that ALREADY share an exact key are
 * reported the same way (the later one is the collision).
 *
 * Canonical-row rule: per workspace, the FIRST candidate in `deps.listOpenKeyed()`
 * order holds a key, so the caller's ordering IS the canonical rule. The production
 * lister (listRepeatedToolErrorKeyHolders in watchdog-key-fold.ts) orders work-lane
 * rows before observation rows, claimed before unclaimed, then oldest first, then id.
 *
 * Ownership is per workspace (bug-inflow-one-problem-one-row-2026-10-18 R-7): with a
 * workspace-blind map, two duplicates in workspace B whose key was already held in
 * workspace A both collided with A's row, the fold skipped them as cross-workspace,
 * and they stayed duplicates of each other.
 */
export async function recomputeWatchdogKeys(
  deriveKey: (candidate: ImprovementCandidate) => string | null,
  deps: RecomputeDeps,
  opts: { dryRun?: boolean } = {},
): Promise<RecomputeResult> {
  const dryRun = opts.dryRun ?? true;
  const candidates = await deps.listOpenKeyed();
  const withKey = candidates.filter(
    (c): c is KeyedCandidate & { watchdogKey: string } =>
      typeof c.watchdogKey === 'string' && c.watchdogKey.length > 0,
  );

  // The live (workspace, key)→owner map, mutated as we migrate so a SECOND old key
  // mapping to the same new key collides too (consistent in dry-run + execute).
  const slot = (c: KeyedCandidate, key: string) => `${c.workspaceId ?? ''}\u0000${key}`;
  const ownerOfKey = new Map<string, string>();
  for (const c of withKey) {
    const s = slot(c, c.watchdogKey);
    if (!ownerOfKey.has(s)) ownerOfKey.set(s, c.id);
  }

  const changed: WatchdogKeyChange[] = [];
  const collisions: WatchdogKeyCollision[] = [];
  let unchanged = 0;

  for (const c of withKey) {
    const oldKey = c.watchdogKey;
    const newKey = deriveKey(c);
    if (!newKey || newKey === oldKey) {
      // bug-inflow-one-problem-one-row-2026-10-18 R-7: a row that keeps its key while an
      // EARLIER candidate already holds that exact key is a pre-existing duplicate, not an
      // unchanged row. Counting it `unchanged` hid every exact-key pair from the fold.
      const exactHolder = ownerOfKey.get(slot(c, oldKey));
      if (exactHolder !== undefined && exactHolder !== c.id) {
        collisions.push({ id: c.id, oldKey, newKey: oldKey, heldBy: exactHolder });
        continue;
      }
      unchanged += 1;
      continue;
    }
    const holder = ownerOfKey.get(slot(c, newKey));
    if (holder !== undefined && holder !== c.id) {
      collisions.push({ id: c.id, oldKey, newKey, heldBy: holder });
      continue;
    }
    if (!dryRun) await deps.setWatchdogKey(c.id, newKey);
    changed.push({ id: c.id, oldKey, newKey });
    // Reflect the move in the owner map for downstream collision checks.
    if (ownerOfKey.get(slot(c, oldKey)) === c.id) ownerOfKey.delete(slot(c, oldKey));
    ownerOfKey.set(slot(c, newKey), c.id);
  }

  return { scanned: withKey.length, changed, collisions, unchanged, dryRun };
}
