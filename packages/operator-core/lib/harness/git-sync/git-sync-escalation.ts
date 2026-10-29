/**
 * Pure decision core for git-sync's failure escalation (EI-18).
 *
 * Background: git-sync escalated merge CONFLICTS (→ merge-resolver) but push
 * ERRORS only ever landed in routine metadata — on 2026-06-05 the push failed
 * silently every tick for ~20h (10.4GB of accumulated Rust target/ artifacts,
 * GitHub HTTP 500) with zero fleet-visible signal. This module decides, from one
 * tick's outcome + the previous tick's counters, whether to:
 *   - write/refresh a `git-sync-error` escalation row (repeated push failures
 *     and/or oversized-file exclusions — both need a human/agent),
 *   - clear it (a genuinely clean pass),
 *   - broadcast a coord message (TRANSITION-only, so a persistent condition
 *     doesn't spam every 10-min tick).
 *
 * Deliberately PG-free: `git-sync-action.ts` reads the previous counters from
 * the routine metadata, calls this, and applies the side effects.
 */
import {
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_MAX_COMMIT_TOTAL_BYTES,
  type AttributionTally,
  type RepoError,
  type ScopedOversized,
} from './run-git-sync';
import { isLocalDiskFullError } from './git-fetch-headroom-refusal';

/**
 * True when agents had dirty work in this repo and none of it got an attributed commit
 * (WI-6554700010018198). Lives here, beside its only consumer, so the detector does not
 * take a runtime dependency on run-git-sync (whose module tests replace wholesale).
 */
export function isZeroAttribution(t: Pick<AttributionTally, 'agentGroupCount' | 'agentCommitCount'>): boolean {
  return t.agentGroupCount > 0 && t.agentCommitCount === 0;
}

/** Consecutive error ticks before the failure escalates (3 ticks ≈ 30 min).
 *  NOTE the name is historical: this counts ANY failing leg, not just pushes
 *  (EI-19275994927087666). */
/** Historical export name; this threshold counts consecutive git-sync error ticks, not only pushes. */
export const PUSH_FAILURE_ESCALATION_TICKS = 3;

/**
 * EI-21906459740652039 — the CHRONIC cumulative-limit cadence.
 *
 * The oversized broadcast below is EDGE-TRIGGERED on newly-peeled keys, which is
 * right for a one-off stray blob and structurally blind to the condition that
 * actually happened: the SAME set peeled every tick for 13h, silent after the first,
 * because nothing about it was ever "new" again. So the absence of repeated peel
 * broadcasts is not evidence the peel stopped — it is what the edge trigger does by
 * design, and that is precisely why nobody noticed.
 *
 * A persisting peel therefore re-broadcasts on a bounded cadence: loud enough to be
 * noticed, rare enough not to be the per-tick spam the edge trigger exists to
 * prevent. First alarm at 3 consecutive ticks (past a transient bulk import that
 * clears itself), then every 18 ticks (~3h at the 10-min default).
 */
export const CHRONIC_CUMULATIVE_PEEL_TICKS = 3;
export const CHRONIC_CUMULATIVE_REBROADCAST_TICKS = 18;

/**
 * WI-6554700010018198: from 2026-10-16T17:32Z to 2026-10-20T06:48Z the superproject
 * produced no attributed commit at all while dozens of agents edited it. Every tick
 * reported success, the only evidence was console.log, and journald rotated it away
 * within 12h. Alarm after 6 consecutive zero-attribution ticks (~1h at the 10-min
 * default), then re-broadcast every 18 (~3h) while it persists.
 */
export const ZERO_ATTRIBUTION_ESCALATION_TICKS = 6;
export const ZERO_ATTRIBUTION_REBROADCAST_TICKS = 18;

/**
 * The persisted counter's next value. A tick where some repo had agent work and none of
 * it was attributed counts; a tick with an attributed commit and no zero repo resets.
 * A tick that measured nothing (no phase ran, or no agent had dirty work) HOLDS the
 * count: it is not evidence either way, and resetting on it would let an idle tick hide
 * an outage that resumes on the next busy one.
 */
export function nextZeroAttributionTicks(prev: number, attribution: readonly AttributionTally[] | undefined): number {
  if (!attribution || attribution.length === 0) return prev;
  if (attribution.some(isZeroAttribution)) return prev + 1;
  if (attribution.some((t) => t.agentCommitCount > 0)) return 0;
  return prev;
}

/**
 * P-003 (gate-systems-as-designed-2026-10-27): the attributed-file share alarm.
 *
 * The zero-attribution alarm above counts groups, so it stayed silent through the failure
 * P-001 measured: one sweep merged 8 attribution groups into 2 and committed 36 files
 * anonymously while other agents' commits still published. A healthy sweep commits nearly
 * every ledger-attributed file under its agent's trailer, so the floor is absolute rather
 * than learned. A tick with fewer than ATTRIBUTION_SHARE_MIN_FILES attributable files is not
 * evidence either way. Alarm after 3 consecutive low ticks, then every 18 while it persists.
 */
export const ATTRIBUTION_SHARE_FLOOR = 0.75;
export const ATTRIBUTION_SHARE_MIN_FILES = 4;
export const ATTRIBUTION_SHARE_ESCALATION_TICKS = 3;
export const ATTRIBUTION_SHARE_REBROADCAST_TICKS = 18;

/** One tick's attributed-file share summed over every repo that measured one, or null. */
export function tickAttributedFileShare(
  attribution: readonly AttributionTally[] | undefined,
): { attributable: number; attributed: number } | null {
  let measured = false;
  let attributable = 0;
  let attributed = 0;
  for (const t of attribution ?? []) {
    if (typeof t.attributableFileCount !== 'number' || typeof t.attributedFileCount !== 'number') continue;
    measured = true;
    attributable += t.attributableFileCount;
    attributed += t.attributedFileCount;
  }
  return measured ? { attributable, attributed } : null;
}

/** Whether this tick measured enough attributable files and fell below the floor; null when it measured too few. */
export function isLowAttributionShare(attribution: readonly AttributionTally[] | undefined): boolean | null {
  const share = tickAttributedFileShare(attribution);
  if (!share || share.attributable < ATTRIBUTION_SHARE_MIN_FILES) return null;
  return share.attributed / share.attributable < ATTRIBUTION_SHARE_FLOOR;
}

/**
 * The persisted `consecutive_attribution_share_drop_ticks` counter's next value. Like the
 * zero-attribution counter, a tick that measured too few files HOLDS it.
 */
export function nextAttributionShareDropTicks(
  prev: number,
  attribution: readonly AttributionTally[] | undefined,
): number {
  const low = isLowAttributionShare(attribution);
  if (low === null) return prev;
  return low ? prev + 1 : 0;
}

/** Which LEG of a git-sync tick failed (EI-19275994927087666). `disk-headroom` (WI-10004397)
 *  is not a git leg at all: the local disk is full, so no leg can run. */
export type GitSyncFailingLeg = 'commit' | 'push' | 'serving' | 'bridge' | 'conflict' | 'config-lock' | 'disk-headroom' | 'unknown';

/**
 * PURE: classify which leg actually failed, from the error text git-sync recorded.
 *
 * EI-19275994927087666: both the escalation broadcast and the /admin/git deploy
 * panel used to call EVERY git-sync failure a PUSH failure, and say "commits are
 * NOT reaching origin". That sentence sends a responder at origin / credentials /
 * the pooler. For 32h it was pointing at a corrupt git object in one abandoned
 * scratch pot's tree — a COMMIT-leg fault that never touched the network, while
 * origin/staging was byte-identical to local HEAD.
 *
 * `pushMode` is only a fallback inference: a `commit-only:*` member never pushes,
 * so its failure cannot be a push failure. It is checked LAST on purpose — the
 * real offender's push_mode was `push`, so push_mode alone would not have caught
 * it. The recorded error text is the load-bearing signal.
 */
export function classifyGitSyncFailingLeg(
  lastError: string | null,
  pushMode: string | null,
): GitSyncFailingLeg {
  // WI-10004397: checked FIRST. A disk-full refusal is wrapped in git-sync's generic fetch
  // prefix, and its "HEAD has unpushed commits" form contains "push", so any later arm
  // would misname it: that form read as "push failing — commits NOT reaching origin".
  if (isLocalDiskFullError(lastError)) return 'disk-headroom';
  const e = (lastError ?? '').toLowerCase();
  // P034: beforePush refuses publication when the authenticated serving owner
  // has not booted. Its wrapper may say "push failed", but no push was attempted.
  if (e.includes('git-sync publication refused: serving unavailable') ||
      e.includes('git-sync publication refused: serving capability has no usable device actor')) return 'serving';
  if (e.includes('conflict')) return 'conflict';
  if (e.includes('could not lock config file') && e.includes('config')) return 'config-lock';
  if (e.includes('commit failed') || e.includes('commit error')) return 'commit';
  // Require positive evidence that a push attempt failed. A bare substring match
  // misclassified phrases such as "Origin was never force-pushed" as push failures.
  if (/\bpush (?:failed|fails|was rejected|is rejected)\b|\b(?:failed|unable|could not|cannot) to push\b/.test(e)) {
    return 'push';
  }
  // EI-27252830186130949: the bridge may require an owner to reconcile an
  // ingress history rewrite while local commits and origin egress still work.
  // Its explicit verdict is stronger evidence than the commit-only fallback.
  if (e.includes('github-bridge divergence:')) return 'bridge';
  // No usable error text: a commit-only member still cannot have push-failed.
  if (pushMode?.startsWith('commit-only')) return 'commit';
  return 'unknown';
}

/** The human sentence for a failing leg. Only the 'push' arm may claim anything
 *  about origin — that claim was the whole misdirection. */
export function gitSyncLegPhrase(leg: GitSyncFailingLeg | null): string {
  switch (leg) {
    case 'push':
      return 'push failing — commits NOT reaching origin';
    case 'serving':
      return 'serving owner unavailable — authenticated publication refused before push; repair substrate startup';
    case 'bridge':
      return 'GitHub bridge divergence — inspect github_bridge; verify local commits and origin egress separately';
    case 'commit':
      return 'COMMIT failing — nothing has reached the push stage; origin is unaffected';
    case 'conflict':
      return 'merge conflict — needs a resolver';
    case 'config-lock':
      return 'submodule config-lock contention — canonical URL sync blocked locally; origin is unaffected';
    case 'disk-headroom':
      return (
        'DISK SPACE / HEADROOM — a Git operation was refused for insufficient space or fetch headroom; ' +
        'this does not establish a local commit failure'
      );
    default:
      return "cause unclassified — read that routine's last_error";
  }
}

export interface EscalationInput {
  /** The harness/install slug whose git-sync tick produced this decision.
   * Broadcasts are fleet-global, so omitting this makes a sibling harness's
   * repo-relative paths and failure streak look like the caller's own. */
  installSlug: string;
  /** `skipped-locked` is intentionally neither a failure escalation nor a clean
   * pass: a live peer lock deferred work, so preserve any existing escalation
   * until a later measured sync/nothing outcome can clear it. */
  status: 'nothing' | 'synced' | 'conflict' | 'error' | 'skipped-locked';
  /** This tick's consecutive-error count (already bumped/reset for this tick). */
  consecutiveErrorTicks: number;
  errors: RepoError[];
  /** EI-19275994927087666: this member's push mode (`push` | `commit-only:*`), used
   *  only as a fallback when the error text alone cannot classify the failing leg.
   *  OPTIONAL on purpose — an omitted value just degrades to the error-text
   *  classification, so no existing caller or fixture has to change. */
  pushMode?: string | null;
  oversized: ScopedOversized[];
  /** Effective per-file dirty-byte limit used by this git-sync tick. */
  maxBlobBytes: number;
  /** Effective cumulative dirty-set limit used by this git-sync tick. */
  maxCommitTotalBytes: number;
  /** `scope:path` keys reported oversized on the PREVIOUS tick (from metadata). */
  prevOversizedKeys: string[];
  /** EI-21906459740652039: consecutive ticks — INCLUDING this one — on which the
   *  cumulative-limit guard peeled at least one file (routine metadata
   *  `consecutive_cumulative_peel_ticks`, computed by the caller exactly like
   *  `consecutive_content_error_ticks`). 0/omitted ⇒ no chronic condition, so no
   *  existing caller or fixture has to change. */
  chronicCumulativeTicks?: number;
  /** EI-21230011589307899: the PREVIOUS tick's own-head-publish refusal, read from
   *  routine metadata (`own_head_publish.refused` / `.blockedAtCommit`).
   *
   *  WHY PREVIOUS: the own-head-publish leg runs AFTER this decision inside a tick
   *  (git-sync-action.ts — record/escalate at the `git-sync:record` step, publish at
   *  `git-sync:own-head-publish`), so THIS tick's refusal is not knowable here. A
   *  one-tick lag is the right trade: it surfaces a frozen device in ~2 ticks instead
   *  of the 51 minutes it took a human to notice on 2026-08-26, when a secret-shaped
   *  test fixture froze all egress and NOTHING raised an alarm — the same silent
   *  metadata-only failure mode EI-18 fixed for the push and oversized legs but not
   *  for this one.
   *
   *  OPTIONAL on purpose — an omitted value simply never raises `publish-refused`, so
   *  no existing caller or fixture has to change. */
  publishRefusal?: { refused: string; blockedAtCommit: string | null } | null;
  /** The refusal's `blockedAtCommit` one tick further back, so a PERSISTING freeze
   *  refreshes the escalation row without re-broadcasting every tick (mirrors
   *  `prevOversizedKeys`). */
  prevPublishBlockedAtCommit?: string | null;
  /** WI-6554700010018198: `consecutive_zero_attribution_ticks` INCLUDING this tick, from
   *  nextZeroAttributionTicks. OPTIONAL: an omitted value never raises the condition. */
  zeroAttributionTicks?: number;
  /** P-003: `consecutive_attribution_share_drop_ticks` INCLUDING this tick, from
   *  nextAttributionShareDropTicks. OPTIONAL: an omitted value never raises the condition. */
  attributionShareDropTicks?: number;
  /** This tick's per-repo attributed-phase tallies, used to name the failing repos. */
  attribution?: readonly AttributionTally[];
}

export type EscalationReason =
  | 'push-failure'
  | 'sync-failure'
  | 'oversized-blobs'
  | 'publish-refused'
  | 'attribution-failed'
  | 'attribution-share-dropped';

export interface EscalationDecision {
  /** Write/refresh the `git-sync-error` escalation row this tick. */
  escalate: boolean;
  reasons: EscalationReason[];
  /** Clear the `git-sync-error` escalation row (clean pass, nothing wrong). */
  clear: boolean;
  /** Coord broadcast summary — non-null only on a TRANSITION (threshold reached /
   *  new oversized file appeared), never on a persisting condition. */
  broadcast: string | null;
}

const formatMegabytes = (bytes: number): string =>
  Number.isFinite(bytes) ? `${(bytes / 1048576).toFixed(1)}MB` : 'an unknown byte limit';

export const oversizedKey = (f: ScopedOversized): string => `${f.scope}:${f.path}`;

/**
 * WI-6554700010010939: the own-head-publish refusal this tick escalates on, or null when a
 * secrets path exemption was added AFTER that refusal was recorded.
 *
 * The refusal comes from the PREVIOUS tick's publish leg (see `publishRefusal`), and on
 * papercusp a tick can take ~35 min. On 2026-10-13 the publish was refused at 19:42:25Z,
 * the exemption that cleared it landed at 19:45Z, and the next tick still broadcast
 * "egress is FROZEN" at 20:16:22Z, 50 s before that same tick's publish leg retried and
 * published. An exemption newer than the refusal means the remedy has already been
 * applied and the retry is pending, so this tick treats the publish as not refused.
 *
 * This also keeps `last_publish_blocked_at` at null (the caller records the effective
 * value), so if the retry is refused again at the same commit, the next tick still
 * broadcasts: its refusal record is then newer than the exemption.
 *
 * Only `secrets` refusals are affected (an exemption cannot clear any other code). A
 * missing or non-numeric timestamp on either side keeps the refusal (fail loud).
 */
export function effectivePublishRefusal(
  refusal: { refused: string; blockedAtCommit: string | null; atMs: number | null } | null | undefined,
  latestExemptionAtMs: number | null | undefined,
): { refused: string; blockedAtCommit: string | null } | null {
  if (!refusal?.refused) return null;
  const kept = { refused: refusal.refused, blockedAtCommit: refusal.blockedAtCommit };
  if (refusal.refused !== 'secrets') return kept;
  const at = refusal.atMs;
  const ex = latestExemptionAtMs;
  if (typeof at !== 'number' || !Number.isFinite(at)) return kept;
  if (typeof ex !== 'number' || !Number.isFinite(ex)) return kept;
  return ex > at ? null : kept;
}

export function decideGitSyncEscalation(i: EscalationInput): EscalationDecision {
  const reasons: EscalationReason[] = [];
  const errorLeg = classifyGitSyncFailingLeg(i.errors.map((e) => e.message).join('; ') || null, i.pushMode ?? null);
  if (i.consecutiveErrorTicks >= PUSH_FAILURE_ESCALATION_TICKS) {
    reasons.push(errorLeg === 'push' ? 'push-failure' : 'sync-failure');
  }
  if (i.oversized.length > 0) reasons.push('oversized-blobs');
  // EI-21230011589307899: a refused own-head publish freezes this device's egress
  // outright and CANNOT self-clear (the offending blob is already in history), so it
  // escalates on sight — no consecutive-tick threshold like `sync-failure`, which
  // exists to absorb transient network flakes this condition never has.
  const publishRefused = i.publishRefusal?.refused ? i.publishRefusal : null;
  if (publishRefused) reasons.push('publish-refused');
  const zeroAttributionTicks = i.zeroAttributionTicks ?? 0;
  if (zeroAttributionTicks >= ZERO_ATTRIBUTION_ESCALATION_TICKS) reasons.push('attribution-failed');
  const shareDropTicks = i.attributionShareDropTicks ?? 0;
  if (shareDropTicks >= ATTRIBUTION_SHARE_ESCALATION_TICKS) reasons.push('attribution-share-dropped');
  const escalate = reasons.length > 0;

  const parts: string[] = [];
  if (i.consecutiveErrorTicks === PUSH_FAILURE_ESCALATION_TICKS) {
    const detail = i.errors.map((e) => `${e.scope}: ${e.message.split('\n')[0]}`).join('; ').slice(0, 300);
    // EI-19275994927087666: say WHICH leg failed. This used to hardcode "push has
    // FAILED … local commits are NOT reaching origin" for every failure, including
    // commit-leg faults that never reached the network.
    parts.push(
      `⚠ git-sync on ${i.installSlug} has FAILED ${i.consecutiveErrorTicks} consecutive ticks — ${gitSyncLegPhrase(errorLeg)}${detail ? ` (${detail})` : ''}`,
    );
  }
  const newOversized = i.oversized.filter((f) => !i.prevOversizedKeys.includes(oversizedKey(f)));
  if (newOversized.length > 0) {
    const list = newOversized
      .map((f) => `${f.scope === 'superproject' ? '' : `${f.scope}/`}${f.path} (${(f.sizeBytes / 1048576).toFixed(1)}MB)`)
      .join(', ')
      .slice(0, 400);
    const perFile = newOversized.filter((f) => f.exclusionReason !== 'cumulative-limit');
    const cumulative = newOversized.filter((f) => f.exclusionReason === 'cumulative-limit');
    const guards: string[] = [];
    if (perFile.length > 0) {
      guards.push(
        `${perFile.length} file(s) exceeded the configured per-file limit of ${formatMegabytes(i.maxBlobBytes)} ` +
          `(GitHub's individual-blob ceiling is 100MB)`,
      );
    }
    if (cumulative.length > 0) {
      guards.push(
        `the dirty set exceeded the configured cumulative limit of ${formatMegabytes(i.maxCommitTotalBytes)} ` +
          `(${cumulative.length} file(s) peeled; GitHub's 100MB ceiling applies to individual blobs, not this guard)`,
      );
    }
    parts.push(
      `⚠ git-sync on ${i.installSlug} EXCLUDED file(s) from the auto-commit — ${guards.join('; ')}; ` +
        `gitignore or remove them: ${list}`,
    );
  }

  // EI-21906459740652039: the `newOversized` edge trigger above cannot see a
  // CHRONIC peel — the same paths, every tick, never "new" after the first. Say so
  // explicitly on a bounded cadence, and say the thing an operator needs to know:
  // these paths have not been committed for the whole window, so anything derived
  // from them (a regenerated docs mirror, a projected catalog) is stale on disk while
  // git-sync keeps reporting success.
  const chronicTicks = i.chronicCumulativeTicks ?? 0;
  const cumulativeNow = i.oversized.filter((f) => f.exclusionReason === 'cumulative-limit');
  const sinceFirstAlarm = chronicTicks - CHRONIC_CUMULATIVE_PEEL_TICKS;
  if (
    cumulativeNow.length > 0 &&
    sinceFirstAlarm >= 0 &&
    sinceFirstAlarm % CHRONIC_CUMULATIVE_REBROADCAST_TICKS === 0
  ) {
    const list = cumulativeNow
      .slice(0, 6)
      .map((f) => `${f.scope === 'superproject' ? '' : `${f.scope}/`}${f.path}`)
      .join(', ')
      .slice(0, 300);
    parts.push(
      `⚠ git-sync on ${i.installSlug}: the cumulative-limit guard has peeled file(s) for ` +
        `${chronicTicks} CONSECUTIVE ticks — ${cumulativeNow.length} file(s) this tick, and they have NOT ` +
        `been committed for that whole window even though every tick reported success. If any is a ` +
        `generated projection (the internal-docs mirror, a catalog artifact), what is SERVED is stale ` +
        `relative to disk. Raise the cumulative limit, gitignore the offenders, or remove them: ${list}`,
    );
  }

  // Broadcast only when the freeze POINT moves (or first appears) — a persisting
  // refusal still refreshes the escalation row above, but must not re-broadcast every
  // tick for however long it takes someone to clear it.
  if (publishRefused && (publishRefused.blockedAtCommit ?? null) !== (i.prevPublishBlockedAtCommit ?? null)) {
    const at = publishRefused.blockedAtCommit ? publishRefused.blockedAtCommit.slice(0, 12) : 'an unrecorded commit';
    parts.push(
      `⚠ git-sync on ${i.installSlug}: own-head publish REFUSED (${publishRefused.refused}) at ${at} — ` +
        `this device's egress is FROZEN and every later commit queues behind it. Note a bridged install never ` +
        `pushes to origin itself, so a stale origin ref is the SYMPTOM, not the cause; read ` +
        `metadata->'own_head_publish' (healthy = refused:null AND publishedSha==sha). Fixing the offending file ` +
        `forward does NOT clear this — the blob is already in history. Clear a confirmed false positive with ` +
        `pot_git:secrets_exemptions { action:'add', path:'<exact repo-relative path>', reason:'<why>' }.`,
    );
  }

  // A held counter (a tick that measured nothing) keeps its value, so the cadence check
  // alone would re-broadcast on every idle tick that sits on a broadcast tick. Broadcast
  // only on a tick that itself showed the condition.
  const zeroAttributionFailing = (i.attribution ?? []).filter(isZeroAttribution);
  const sinceZeroAttributionAlarm = zeroAttributionTicks - ZERO_ATTRIBUTION_ESCALATION_TICKS;
  if (
    zeroAttributionFailing.length > 0 &&
    sinceZeroAttributionAlarm >= 0 &&
    sinceZeroAttributionAlarm % ZERO_ATTRIBUTION_REBROADCAST_TICKS === 0
  ) {
    const failing = zeroAttributionFailing;
    const detail = failing
      .map((t) => `${t.scope}: ${t.agentGroupCount} agent group(s), ${t.failedGroups} failed${t.error ? ` (${t.error.split('\n')[0]})` : ''}`)
      .join('; ')
      .slice(0, 400);
    parts.push(
      `⚠ git-sync on ${i.installSlug}: agents' edits have produced NO attributed commit for ` +
        `${zeroAttributionTicks} CONSECUTIVE ticks. Their work is landing only in the anonymous catch-all, so ` +
        `commits carry no Papercusp-Agent trailer and work-item completions cannot settle against them. ` +
        `Read routines:list { name:'git-sync' } health.last_attribution for the per-repo failure` +
        `${detail ? `. This tick: ${detail}` : ''}.`,
    );
  }

  const sinceShareAlarm = shareDropTicks - ATTRIBUTION_SHARE_ESCALATION_TICKS;
  if (
    isLowAttributionShare(i.attribution) === true &&
    sinceShareAlarm >= 0 &&
    sinceShareAlarm % ATTRIBUTION_SHARE_REBROADCAST_TICKS === 0
  ) {
    const share = tickAttributedFileShare(i.attribution);
    const pct = share && share.attributable > 0 ? Math.round((share.attributed / share.attributable) * 100) : 0;
    const detail = (i.attribution ?? [])
      .filter((t) => (t.attributableFileCount ?? 0) > 0)
      .map((t) => `${t.scope}: ${t.attributedFileCount ?? 0}/${t.attributableFileCount} attributed`)
      .join('; ')
      .slice(0, 400);
    parts.push(
      `⚠ git-sync on ${i.installSlug}: only ${pct}% of the ledger-attributed files it committed carried an ` +
        `agent trailer, below ${Math.round(ATTRIBUTION_SHARE_FLOOR * 100)}% for ${shareDropTicks} CONSECUTIVE ` +
        `measured ticks. The rest went into anonymous commits, so delta-check failures in them cannot be routed ` +
        `to their authors. Read routines:list { name:'git-sync' } health.last_attribution ` +
        `(attributableFileCount / attributedFileCount per repo) and the journal's "merged import-linked ` +
        `attribution groups" lines${detail ? `. This tick: ${detail}` : ''}.`,
    );
  }

  // A pass is only "clean" when nothing moved wrong AND no oversized files linger —
  // 'nothing' with oversized still has the unpushable file sitting in the tree.
  const clear = !escalate && (i.status === 'synced' || i.status === 'nothing');

  return { escalate, reasons, clear, broadcast: parts.length > 0 ? parts.join('\n') : null };
}

/**
 * P-009 (review-system-rework-reduction-2026-09-23; EI-24015486799447670): a content
 * quarantine must never be SILENT. On 2026-09-23 a secret-shaped test sentinel held 29
 * files out of the auto-commit for 18 ticks (~1h). Its author's session had already
 * ended, the single needs-human message at the fixer-budget tick went to that dead
 * inbox, and nothing re-alarmed. The only signal left was routine metadata. Three
 * notices close that gap:
 *  - `editor-first-tick`: the FIRST quarantined tick tells the file's last editor,
 *    while they are most likely still live and can fix it with one edit.
 *  - `alarm`: the tick the content-fixer budget runs out (the pre-existing
 *    needs-human transition).
 *  - `realarm`: every `realarmEveryTicks` ticks while the quarantine persists after
 *    that, so a quarantine that outlives its first alarm is re-surfaced.
 */
export const CONTENT_QUARANTINE_REALARM_TICKS = 12;

export type ContentQuarantineNotice = 'editor-first-tick' | 'alarm' | 'realarm';

export function decideContentQuarantineNotice(i: {
  /** Consecutive quarantined ticks INCLUDING this one. */
  contentTicks: number;
  /** The count one tick earlier (0 = this is the first quarantined tick). */
  prevContentTicks: number;
  /** The tick on which the content-fixer budget is exhausted. */
  alarmTicks: number;
  realarmEveryTicks?: number;
}): ContentQuarantineNotice | null {
  if (i.contentTicks <= 0) return null;
  const every = Math.max(1, i.realarmEveryTicks ?? CONTENT_QUARANTINE_REALARM_TICKS);
  if (i.contentTicks >= i.alarmTicks) {
    if (i.prevContentTicks < i.alarmTicks) return 'alarm';
    const since = i.contentTicks - i.alarmTicks;
    return since > 0 && since % every === 0 ? 'realarm' : null;
  }
  return i.prevContentTicks === 0 ? 'editor-first-tick' : null;
}

/** Verdicts under which nobody will read the message. */
const CONTENT_NOTICE_UNREACHABLE = new Set(['ended', 'recorded']);
/** Verdicts that prove somebody will read it. */
const CONTENT_NOTICE_REACHABLE = new Set(['live', 'parked', 'draining', 'suspect']);

/**
 * Who receives a content-quarantine notice. `editors` is the attribution result
 * (`['*']` = unattributable) and `stateOf` is the liveness oracle's `sessionState`.
 *
 * A first-tick notice goes only to attributed editors who are not known to be gone,
 * and is never a broadcast. A 1-tick quarantine is usually an agent mid-edit, so
 * waking the fleet for it would be noise. An alarm needs a PROVEN-reachable
 * editor. Otherwise it falls back to the broadcast, because an alarm addressed only
 * to an ended session is the silent failure this exists to prevent.
 */
export function selectContentNoticeRecipients(
  notice: ContentQuarantineNotice,
  editors: readonly string[],
  stateOf: (ownerId: string) => string | null | undefined,
): string[] {
  const attributed = [...new Set(editors.filter((e) => e && e !== '*'))];
  if (notice === 'editor-first-tick') {
    return attributed.filter((e) => !CONTENT_NOTICE_UNREACHABLE.has(stateOf(e) ?? ''));
  }
  const reachable = attributed.filter((e) => CONTENT_NOTICE_REACHABLE.has(stateOf(e) ?? ''));
  return reachable.length > 0 ? reachable : ['*'];
}
