/**
 * wedged-identity-activation-watchdog (WI-10002060) — the DETECTOR half of the
 * self-sealing-identity-failure work. EI-23745120264597384 built the
 * PREVENTION half (a break-glass contract enforced at the identity-grants
 * kernel gate by a source-level test); this is the half that finds a session
 * ALREADY wedged, or wedged by a path that never reaches that gate.
 *
 * THE CLASS. A session's authority is decided by comparing the acknowledged
 * activation receipt in `session_briefs.control_state->activation->applied`
 * against the launch record in `adv_sessions.launch_spec`. When those cannot be
 * reconciled the kernel answers `stale-artifact` and refuses EVERY tool — and
 * the refusal is SELF-SEALING: the wedged session cannot file its own bug,
 * because filing one is itself a tool call. So the finding has to be raised by
 * something OUTSIDE the failure domain. That is this sweep.
 *
 * ── DESIGN DECISION 1: ask the gate, never paraphrase it ──────────────────
 * The obvious implementation is a jsonb predicate. It has been tried twice and
 * was wrong BOTH TIMES, in BOTH DIRECTIONS — measured against the live
 * population on 2026-09-20:
 *
 *   `control_state->'activation'->>'status' IS DISTINCT FROM 'applied'`
 *     · selected 11 of 73 live sessions, ALL HEALTHY. `prepared:null` +
 *       `status:'applied'` is what SUCCESS looks like (acknowledgeControl-
 *       Transition sets both in one jsonb_set chain), so a predicate keying on
 *       the status label reports healthy sessions as wedged.
 *     · and it MISSED the one genuinely wedged session, whose status reads
 *       'applied'. A detector with a 100% false-positive AND a 100%
 *       false-negative rate is worse than none: it trains its reader to ignore
 *       it while the real thing sits undetected.
 *
 * The root cause of both errors is the same: `status` is a hand-maintained
 * second copy of a truth the gate derives elsewhere, and the gate's real
 * question is not a revision comparison at all — `appliedIdentityArtifact`
 * searches the record AND its `identityHistory` for a receipt matching both
 * revisions, with a fallback admitting a case no jsonb predicate expresses.
 *
 * So this sweep does not re-declare the decision. It loads the same two inputs
 * the kernel loads and calls the kernel's own `resolveIdentityArtifact`. There
 * is exactly one other caller of that function — the gate itself — which is
 * what makes a divergence between detector and decision impossible rather than
 * merely unlikely.
 *
 * ── DESIGN DECISION 2: select the launch record the way the KERNEL selects it
 * `adv_sessions` fans out: one owner can hold several rows (a relaunch or a
 * carry-respawn adds one without closing the old). The measured instance had
 * TWO open rows — an earlier one whose launch_spec matched `applied`, and a
 * later one carrying no specificationRevision at all. A plain JOIN yields BOTH,
 * so the same owner appears once healthy and once wedged and the sweep's answer
 * depends on which row it happens to read.
 *
 * The kernel is not ambiguous: projected-tool-deps.ts picks ONE row with
 * LAUNCH_RECORD_SELECTION_ORDER below. This sweep uses the identical ordering,
 * and `wedged-identity-activation-selection.pin.test.ts` fails if the two ever
 * drift apart. (Pinned rather than shared as a constant on purpose: threading
 * one through postgres.js tagged SQL needs `sql.unsafe` in the identity hot
 * path, which is a worse trade than a test that cannot be ignored.)
 *
 * ── DESIGN DECISION 3: fail closed ────────────────────────────────────────
 * "measured nothing" and "found nothing" must never render identically. A
 * failed read, and a scan that saw zero candidate rows when the table should
 * never be empty, both escalate as `not-measured` rather than returning clean.
 * The previous generation of a sibling guard was silently inert for ~6 weeks
 * for exactly this reason (WI-10002031).
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';

import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { resolveIdentityArtifact } from '../capability-envelope/identity-grants-port';
import { cooperativeYield } from '../event-loop-lag-monitor';
import { narrowedLaunchSpecToAppliedPairSql } from '../capability-envelope/identity-receipt-narrowing';
import { normalizeSessionActivation } from '../session-activation';
import { activeWorkspaceId } from '../workspace-registry';
import { broadcastSevereEvent } from '../severe-event-broadcast';
import { resolveAlarm, type AlarmAttentionDeps } from '../alarm-attention';

type IdentityConditionKind = 'wedged' | 'unapplied' | 'wedged-coverage' | 'unapplied-coverage';
interface IdentityConditionDeps {
  workspaceId?: string;
  rail?: Partial<AlarmAttentionDeps>;
  readOpenConditions?: () => Promise<string[]>;
}

export function identityActivationConditionKey(kind: IdentityConditionKind, workspaceId: string, ownerId = ''): string {
  return `alarm:identity-activation:${kind}:` + encodeURIComponent(JSON.stringify([workspaceId, ownerId]));
}

async function readOpenIdentityConditions(): Promise<string[]> {
  const { computeConditionStates, readConditionEnvelopes } = await import('../agent-tools/coordination/tools/conditions');
  return computeConditionStates(await readConditionEnvelopes())
    .filter(condition => condition.open && condition.condition_key.startsWith('alarm:identity-activation:'))
    .map(condition => condition.condition_key);
}

async function identityEpisodes(deps: IdentityConditionDeps): Promise<Set<string>> {
  try { return new Set(await (deps.readOpenConditions ?? readOpenIdentityConditions)()); }
  catch { return new Set(); } // An unreadable episode ledger authorizes no recovery.
}

function episodeOwners(episodes: Set<string>, kind: IdentityConditionKind, workspaceId: string): string[] {
  const prefix = `alarm:identity-activation:${kind}:`;
  const owners: string[] = [];
  for (const key of episodes) {
    if (!key.startsWith(prefix)) continue;
    try {
      const identity: unknown = JSON.parse(decodeURIComponent(key.slice(prefix.length)));
      if (Array.isArray(identity) && identity.length === 2 && identity[0] === workspaceId &&
          typeof identity[1] === 'string' && identity[1] &&
          key === identityActivationConditionKey(kind, workspaceId, identity[1])) owners.push(identity[1]);
    } catch { /* Malformed durable identities remain open. */ }
  }
  return owners;
}

async function raiseIdentityCondition(kind: IdentityConditionKind, workspaceId: string, ownerId: string,
  message: string, deps: IdentityConditionDeps): Promise<void> {
  const event = { kind: 'identity-activation-watchdog', summary: message, oneShot: true,
    conditionKey: identityActivationConditionKey(kind, workspaceId, ownerId) };
  try {
    if (deps.rail?.broadcast) await deps.rail.broadcast(event);
    else await broadcastSevereEvent(event);
  } catch { /* Preserve the original escalation even when keyed delivery is unavailable. */ }
}

async function recoverIdentityCondition(kind: IdentityConditionKind, workspaceId: string, ownerId: string,
  episodes: Set<string>, deps: IdentityConditionDeps): Promise<void> {
  const key = identityActivationConditionKey(kind, workspaceId, ownerId);
  if (!episodes.has(key)) return;
  try { await resolveAlarm(key, 'identity-activation-watchdog', deps.rail); }
  catch { /* Failed keyed recovery preserves the durable episode. */ }
}

function acknowledgedActivation(value: unknown): boolean {
  try { return !!normalizeSessionActivation(value)?.applied; }
  catch { return false; }
}

/**
 * The kernel's launch-record selection, verbatim. MUST stay byte-identical to
 * the ORDER BY in projected-tool-deps.ts — see DESIGN DECISION 2 and the pin
 * test. Selects the newest immutable registration. A resume bumps started_at
 * and can reopen a predecessor; neither may displace its successor's identity.
 */
export const LAUNCH_RECORD_SELECTION_ORDER =
  's.id DESC';

/**
 * Hourly. A wedge is permanent once it starts — nothing self-heals it — so a
 * tighter cadence buys nothing, while a looser one leaves a session burning
 * wake budget against a total denial for most of a day.
 */
export const WEDGED_IDENTITY_SWEEP_INTERVAL_MS = 60 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'wedged-identity-activation-watchdog',
  ownerLabel: 'system · wedged identity activation',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** A session's liveness as far as this sweep could establish it. */
export type WedgedLiveness = SessionState | 'unknown';

/** Only confirmed-dead sessions are terminal; `recorded` means a live open adv_sessions row. */
const TERMINAL_STATES: ReadonlySet<WedgedLiveness> = new Set(['ended']);

export interface CandidateRow {
  ownerId: string;
  /** `adv_sessions.launch_spec`, or null when the owner has NO launch record. */
  launchSpec: unknown;
  /** Null when the LATERAL found no adv_sessions row at all. */
  advSessionId: string | null;
  /** Raw `control_state->'activation'`, normalized by the kernel's normalizer. */
  activation: unknown;
  /**
   * WI-10005391: identity of everything `classifyCandidate` reads for this
   * row — the selected launch row's id and row version (xmin) plus a digest of
   * the activation envelope. Null when there is no launch row.
   */
  verdictKey?: string | null;
  /**
   * True when the loader did NOT ship `launchSpec` because the sweep already
   * holds a verdict for `verdictKey`. Such a row is never classified; its prior
   * verdict is reused.
   */
  launchSpecOmitted?: boolean;
  /**
   * WI-10008237: true when every launch record this owner has was closed more
   * than {@link WEDGED_SWEEP_RETIRED_AFTER_MS} ago. Such a row is counted but
   * never classified or carried, and its launch record is not shipped.
   */
  retired?: boolean;
}

/**
 * WI-10008237 — how long after an owner's LAST launch record closed the sweep
 * stops classifying it.
 *
 * The sweep already discards an ended session's finding (TERMINAL_STATES:
 * "a wedged session that has already ended harms nobody"), but it discovered
 * that only AFTER replaying the artifact. On 2026-10-10 that was 4,282 of
 * 5,078 candidates (84%), with zero presence heartbeat in 6 h and zero activity
 * in 24 h among them. Every bg-host restart empties the verdict cache, so the
 * next aligned fire replayed all of them on the main thread (the sweep was 44%
 * of a 20 s main-thread profile, 7+ minutes into one fire).
 *
 * Owner-wide, not per-row: a resume can reopen a PREDECESSOR row while the
 * newest row stays closed, so an owner is retired only when NO row is open or
 * recently closed. An owner with no launch record is never retired, so the
 * no-launch-record finding is unchanged. 24 h, not the 1 h cadence, so a
 * session that a reaper closed while it was still running stays swept.
 */
export const WEDGED_SWEEP_RETIRED_AFTER_MS = 24 * 60 * 60_000;

export type CandidateVerdict = { wedged: false } | { wedged: true; reason: string };

/**
 * WI-10005391 — verdicts carried from one sweep to the next.
 *
 * Every sweep used to stream the narrowed launch record of EVERY session that
 * ever carried an activation (2,094 rows, 1.28 GB stored, on 2026-10-02, and
 * growing with history) and replay each artifact twice. A main-thread CPU
 * profile of one fire put 24.8% of a 30 s window into that replay. Most of
 * those rows never change again (548 of 2,094 briefs moved in 24 h).
 *
 * A verdict is a pure function of the launch row and the activation, so it is
 * keyed on exactly those: launch row id + xmin (a new tuple version on ANY
 * update) + md5 of the activation jsonb. The SQL returns no launch record for a
 * known key, so an unchanged row is neither detoasted, shipped, parsed nor
 * replayed. A changed row gets a new key and is classified by the kernel's own
 * resolver, exactly as before (DESIGN DECISION 1 is untouched). The map is
 * replaced only after a COMPLETE scan, so it never outlives the rows it
 * describes; a code change restarts the process, which empties it.
 */
export interface WedgedVerdictCache {
  verdicts: Map<string, CandidateVerdict>;
  /** Rows the last complete sweep reused rather than classified (observability). */
  lastReused: number;
  lastScanned: number;
  /** Rows the last complete sweep skipped as retired (WI-10008237). */
  lastRetired: number;
}

const sweepVerdictCache = pinModuleState<WedgedVerdictCache>(
  '@papercusp/operator-core.wedged-identity-verdict-cache',
  () => ({ verdicts: new Map(), lastReused: 0, lastScanned: 0, lastRetired: 0 }),
);

export function wedgedIdentityVerdictCacheStats(): {
  size: number;
  lastReused: number;
  lastScanned: number;
  lastRetired: number;
} {
  return {
    size: sweepVerdictCache.verdicts.size,
    lastReused: sweepVerdictCache.lastReused,
    lastScanned: sweepVerdictCache.lastScanned,
    lastRetired: sweepVerdictCache.lastRetired,
  };
}

export interface WedgedSession {
  ownerId: string;
  reason: string;
  liveness: WedgedLiveness;
}

export interface WedgedIdentitySweepDeps extends IdentityConditionDeps {
  /**
   * One array, or a stream of pages (the default streams; WI-10004803).
   * `knownVerdictKeys` (WI-10005391) are the keys the sweep already holds a
   * verdict for; the loader MAY omit the launch record of such a row and must
   * then set `launchSpecOmitted`. A loader that ignores the argument stays correct.
   */
  loadCandidates: (knownVerdictKeys: readonly string[]) => Promise<CandidateRow[]> | AsyncIterable<CandidateRow[]>;
  verdictCache: WedgedVerdictCache;
  /**
   * Called after each row the sweep CLASSIFIES (never after a reused one) with
   * the running count, returning the next count. The default yields one
   * macrotask per classified row. Measured 2026-10-02 against the live table
   * (2,104 rows): a cold sweep spends 54.9 s of CPU, about 26 ms per row, and a
   * 25-row page classified without yielding blocks the bg-host main thread for
   * about 650 ms, about 84 times in a row. bg-host restarts so often that 19 of
   * 23 hourly ticks in one day were cold (WI-10005444).
   */
  yieldAfterClassified: (classifiedSoFar: number) => Promise<number>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, WedgedLiveness>>;
  escalateWedged: (wedged: WedgedSession[]) => Promise<void>;
  escalateNotMeasured: (info: { reason: string }) => Promise<void>;
  /** WI-6554700010029612 ATTEST rung — see {@link loadDenialAttestationsFromLedger}. */
  loadDenialAttestations: (workspaceId: string) => Promise<DenialAttestation[]>;
}

/**
 * WI-6554700010029612 — the ATTEST rung. Every candidate signal above (the activation record,
 * this process's own kernel resolver) describes the identity as THIS build sees it. A serving
 * build that disagrees refuses every call `stale-artifact` while the record reads healthy, and
 * the sweep then RECOVERED that owner's condition each hour. Measured 2026-10-26 23:21Z: two
 * owners with activation=applied had 326 and 207 stale-artifact denials in 24h, all on
 * port-3070@d740fc3802, with no alarm. The denials themselves are the ground truth, so an owner
 * with at least {@link ATTESTED_DENIAL_THRESHOLD} of them in the last
 * {@link ATTESTED_DENIAL_WINDOW_MS} is confirmed wedged regardless of what the record says.
 */
export type DenialAttestation = { ownerId: string; denials: number; servedBy: string[] };
export const ATTESTED_DENIAL_WINDOW_MS = 60 * 60_000;
export const ATTESTED_DENIAL_THRESHOLD = 3;

export function attestedWedgeReason(a: DenialAttestation): string {
  return `the kernel refused ${a.denials} tool call(s) stale-artifact in the last hour ` +
    `(served by ${a.servedBy.length > 0 ? a.servedBy.join(', ') : 'an unrecorded build'}), ` +
    'whatever the activation record says — the serving build disagrees with it';
}

export async function loadDenialAttestationsFromLedger(workspaceId: string): Promise<DenialAttestation[]> {
  const { sql } = getOrgPg();
  const since = new Date(Date.now() - ATTESTED_DENIAL_WINDOW_MS);
  const rows = await sql<Array<{ owner: string; denials: number; served_by: string[] | null }>>`
    SELECT coord_owner_id AS owner, count(*)::int AS denials,
           array_agg(DISTINCT COALESCE(serving_host, '?') || '@' || left(COALESCE(serving_build_sha, '?'), 10))
             AS served_by
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${workspaceId}
       AND invoked_at > ${since}
       AND coord_owner_id IS NOT NULL
       AND error_message LIKE '%stale-artifact%'
     GROUP BY coord_owner_id
    HAVING count(*) >= ${ATTESTED_DENIAL_THRESHOLD}`;
  return rows.map((r) => ({ ownerId: r.owner, denials: Number(r.denials), servedBy: r.served_by ?? [] }));
}

/**
 * Classify ONE candidate. Pure, and deliberately thin: every judgement about
 * whether the identity reconciles is delegated to the kernel's own resolver.
 */
export function classifyCandidate(row: CandidateRow): { wedged: false } | { wedged: true; reason: string } {
  let applied: { specificationRevision: string; stateRevision: string } | null = null;
  if (row.activation != null) {
    try {
      applied = normalizeSessionActivation(row.activation)?.applied ?? null;
    } catch {
      // The kernel treats a malformed activation as "no activation" rather than
      // as an applied receipt, so a parse failure is NOT by itself a wedge.
      applied = null;
    }
  }

  // No acknowledged receipt ⇒ the legacy, non-opted-in path. The gate returns
  // null (no identity governance), so there is nothing to be wedged about.
  if (!applied) return { wedged: false };

  // An acknowledged identity with NO launch row at all is the `no-launch-record`
  // cause. coord:orient is break-glass for it, so the session is recoverable —
  // but only if it ever takes a turn, and it is still denied every other tool.
  if (row.advSessionId == null) {
    return { wedged: true, reason: 'no-launch-record' };
  }

  const record = row.launchSpec;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { wedged: true, reason: 'launch-record-malformed' };
  }

  const resolution = resolveIdentityArtifact(record as Record<string, unknown>, applied);
  return resolution.kind === 'stale-artifact'
    ? { wedged: true, reason: resolution.reason }
    : { wedged: false };
}

const CANDIDATE_SQL_ORDER = LAUNCH_RECORD_SELECTION_ORDER;

/** Rows per cursor page. A page is the most launch-record JSON this sweep holds
 * at once; most records are one ~0.6 MB artifact, the largest ~2 MB narrowed. */
export const CANDIDATE_PAGE_ROWS = 25;

/**
 * WI-10004803: STREAMED and NARROWED. Reading every candidate at once parsed
 * ~1.5 GB of launch-record JSON (1,724 rows, measured 2026-10-01) in one
 * result on the bg-host. Now a cursor holds one page at a time, and each
 * record's identityHistory is narrowed in PostgreSQL to the receipt for that
 * row's own applied pair, the only receipt `resolveIdentityArtifact` reads
 * (the gate narrows its own body read the same way). The rows selected, their
 * order, and the classification are unchanged.
 */
async function* defaultLoadCandidates(knownVerdictKeys: readonly string[]): AsyncGenerator<CandidateRow[]> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const retiredBefore = new Date(Date.now() - WEDGED_SWEEP_RETIRED_AFTER_MS);
  // WI-10005391: `n.known` short-circuits the CASE, so a row whose verdict the
  // sweep already holds is never detoasted — the launch record stays a TOAST
  // pointer through the LIMIT 1 subquery and is simply not returned.
  // WI-10008237: `r.retired` short-circuits it the same way. An open row
  // (NULL ended_at) sorts as 'infinity', so it keeps the owner unretired; an
  // owner with no launch row aggregates to NULL and is never retired.
  const query = sql<Array<{
    owner_id: string;
    launch_spec: unknown;
    adv_session_id: string | number | null;
    activation: unknown;
    verdict_key: string | null;
    launch_spec_omitted: boolean | null;
    retired: boolean | null;
  }>>`
    SELECT b.owner_id,
           a.launch_spec,
           a.id AS adv_session_id,
           b.control_state->'activation' AS activation,
           a.verdict_key,
           a.launch_spec_omitted,
           r.retired
      FROM harness_shared.session_briefs b
      CROSS JOIN LATERAL (
        SELECT COALESCE(max(COALESCE(e.ended_at, 'infinity'::timestamptz)) < ${retiredBefore}, false) AS retired
          FROM harness_shared.adv_sessions e
         WHERE e.coord_owner_id = b.owner_id
           AND e.workspace_id = b.workspace_id
      ) AS r
      LEFT JOIN LATERAL (
        SELECT n.id,
               n.verdict_key,
               n.known AS launch_spec_omitted,
               CASE WHEN n.known OR r.retired THEN NULL ELSE ${narrowedLaunchSpecToAppliedPairSql(sql)} END AS launch_spec
          FROM (
            SELECT k.id, k.launch_spec, k.applied_pair, k.verdict_key,
                   k.verdict_key = ANY(${[...knownVerdictKeys]}::text[]) AS known
              FROM (
                SELECT s.id, s.launch_spec, b.control_state->'activation'->'applied' AS applied_pair,
                       s.id::text || ':' || s.xmin::text || ':' || md5((b.control_state->'activation')::text) AS verdict_key
                  FROM harness_shared.adv_sessions s
                 WHERE s.coord_owner_id = b.owner_id
                   AND s.workspace_id = b.workspace_id
                 ORDER BY ${sql.unsafe(CANDIDATE_SQL_ORDER)}
                 LIMIT 1
              ) AS k
          ) AS n
      ) a ON true
     WHERE b.workspace_id = ${workspaceId}
       AND b.control_state->'activation' IS NOT NULL
  `;
  for await (const rows of query.cursor(CANDIDATE_PAGE_ROWS)) {
    yield rows.map((r) => ({
      ownerId: r.owner_id,
      launchSpec: r.launch_spec,
      advSessionId: r.adv_session_id == null ? null : String(r.adv_session_id),
      activation: r.activation,
      verdictKey: r.verdict_key,
      launchSpecOmitted: r.launch_spec_omitted === true,
      retired: r.retired === true,
    }));
  }
}

/** One iteration shape for both loader forms: a page stream, or one array. */
async function* candidatePages(
  load: () => Promise<CandidateRow[]> | AsyncIterable<CandidateRow[]>,
): AsyncGenerator<CandidateRow[]> {
  const source = load();
  if (Symbol.asyncIterator in Object(source)) {
    yield* source as AsyncIterable<CandidateRow[]>;
  } else {
    yield await (source as Promise<CandidateRow[]>);
  }
}

async function defaultResolveLiveness(ownerIds: string[]): Promise<Map<string, WedgedLiveness>> {
  const out = new Map<string, WedgedLiveness>();
  if (ownerIds.length === 0) return out;
  // Resolved only for CONFIRMED-wedged owners, never the whole roster: that is
  // what keeps `hydratePerId` (one point-read each) an honest cost.
  const verdicts = await resolveSessionStates(
    ownerIds.map((ownerId) => ({ ownerId })),
    { hydratePerId: true, psuHostAuthority: true },
  );
  for (const ownerId of ownerIds) {
    const verdict = verdicts.get(ownerId);
    // A null sessionState is an IN-BAND unknown, never an absence. Reporting it
    // as 'unknown' keeps it visible instead of silently dropping a session the
    // sweep could not classify.
    out.set(ownerId, verdict?.sessionState ?? 'unknown');
  }
  return out;
}

async function defaultEscalateWedged(wedged: WedgedSession[]): Promise<void> {
  const n = wedged.length;
  const lines = wedged
    .map((w) => `  · ${w.ownerId} — ${w.reason} (liveness: ${w.liveness})`)
    .sort();
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${n} session${n === 1 ? ' is' : 's are'} wedged in an unreconcilable identity ` +
      `activation and cannot file this themselves`,
    body:
      `The identity-grants kernel would answer stale-artifact for ${n === 1 ? 'this session' : 'these sessions'}, ` +
      `which denies EVERY tool call.\n\n${lines.join('\n')}\n\n` +
      `WHY THIS ESCALATION EXISTS: the denial is SELF-SEALING. A wedged session ` +
      `cannot report its own condition, because reporting is a tool call and the ` +
      `denial is total. Nobody was ever going to file this from the inside — so ` +
      `if this escalation is ignored, the session stays bricked until a human ` +
      `happens to notice it went quiet.\n\n` +
      `RECOVERY: coord:orient is break-glass for the identity causes and is exempt ` +
      `from the kernel preflight, so a session that still takes turns can converge ` +
      `itself by calling it. A session that no longer takes turns (liveness ended/` +
      `parked) cannot, and needs its activation converged out of band — see the ` +
      `stale-artifact recovery note in the project guide.\n\n` +
      `NOT A REVISION MISMATCH YOU CAN EYEBALL: these were classified by calling ` +
      `the kernel's own resolveIdentityArtifact, not by comparing revision strings. ` +
      `A hand-written jsonb comparison disagrees with the gate in both directions ` +
      `(WI-10002060) — re-check with the resolver, not with SQL.`,
    meta: {
      dedupKind: 'wedged-identity-activation',
      // Keyed on WHICH sessions are wedged, not the count: a persistent wedge
      // dedups instead of re-alarming hourly, while a newly-wedged session
      // opens a fresh escalation rather than hiding behind the existing one.
      subjectSignature: wedged.map((w) => `${w.ownerId}:${w.reason}`).sort().join(','),
      wedgedCount: n,
      wedged: wedged.map((w) => ({ ownerId: w.ownerId, reason: w.reason, liveness: w.liveness })),
    },
  });
}

async function defaultEscalateNotMeasured(info: { reason: string }): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Wedged-identity sweep NOT MEASURED: ${info.reason}`,
    body:
      `The wedged-identity-activation sweep could not complete, so this is a FAILED ` +
      `MEASUREMENT — not a clean machine. Reason: ${info.reason}.\n\n` +
      `A quiet sweep must mean "measured and clean" or it means nothing at all. This ` +
      `escalation exists so that a broken detector can never be mistaken for a healthy ` +
      `fleet — the failure mode that left a sibling guard silently inert for ~6 weeks.`,
    meta: {
      dedupKind: 'wedged-identity-activation-not-measured',
      subjectSignature: info.reason,
    },
  });
}

function sweepDeps(overrides: Partial<WedgedIdentitySweepDeps>): WedgedIdentitySweepDeps {
  return {
    loadCandidates: defaultLoadCandidates,
    verdictCache: sweepVerdictCache,
    yieldAfterClassified: (classifiedSoFar) => cooperativeYield(classifiedSoFar, 1),
    resolveLiveness: defaultResolveLiveness,
    escalateWedged: defaultEscalateWedged,
    escalateNotMeasured: defaultEscalateNotMeasured,
    loadDenialAttestations: loadDenialAttestationsFromLedger,
    ...overrides,
  };
}

export type WedgedIdentitySweepOutcome =
  | { verdict: 'clean'; scanned: number; escalated: 0 }
  | { verdict: 'wedged'; scanned: number; wedged: WedgedSession[]; escalated: 1 }
  | { verdict: 'not-measured'; reason: string; escalated: 1 };

export async function runWedgedIdentitySweepOnce(
  overrides: Partial<WedgedIdentitySweepDeps> = {},
): Promise<WedgedIdentitySweepOutcome> {
  const deps = sweepDeps(overrides);
  const workspaceId = deps.workspaceId ?? activeWorkspaceId();
  const episodes = await identityEpisodes(deps);

  // Pages are classified and dropped as they arrive (WI-10004803). A read that
  // fails on ANY page fails the whole sweep closed, exactly as a failed
  // single read did: a partial scan must never report clean. Only the read is
  // guarded, so a classification error still propagates as before.
  let scanned = 0;
  let reused = 0;
  let retired = 0;
  let classified = 0;
  const confirmed: Array<{ ownerId: string; reason: string }> = [];
  const healthy = new Set<string>();
  // WI-10005391: an immutable snapshot of the carried verdicts. A row the loader
  // omitted is looked up HERE, never in a map this sweep is still building.
  const prior = new Map(deps.verdictCache.verdicts);
  const next = new Map<string, CandidateVerdict>();
  const pages = candidatePages(() => deps.loadCandidates([...prior.keys()]))[Symbol.asyncIterator]();
  for (;;) {
    let page: IteratorResult<CandidateRow[]>;
    try {
      page = await pages.next();
    } catch (e) {
      const reason = `candidate read failed: ${e instanceof Error ? e.message : String(e)}`;
      await raiseIdentityCondition('wedged-coverage', workspaceId, '', reason, deps);
      await deps.escalateNotMeasured({ reason });
      return { verdict: 'not-measured', reason, escalated: 1 };
    }
    if (page.done) break;
    scanned += page.value.length;
    for (const row of page.value) {
      // WI-10008237: checked BEFORE the omitted-record branch — a retired row's
      // launch record is withheld whether or not a verdict is carried for it.
      if (row.retired) {
        retired += 1;
        continue;
      }
      let verdict: CandidateVerdict;
      if (row.launchSpecOmitted) {
        const carried = row.verdictKey ? prior.get(row.verdictKey) : undefined;
        if (!carried) {
          // The loader withheld a launch record the sweep holds no verdict for.
          // Classifying the row without it would be a guess, so fail closed.
          const reason =
            `candidate read omitted the launch record for ${row.ownerId} ` +
            `(verdict key ${row.verdictKey ?? 'null'}) that the sweep holds no verdict for`;
          await raiseIdentityCondition('wedged-coverage', workspaceId, '', reason, deps);
          await deps.escalateNotMeasured({ reason });
          return { verdict: 'not-measured', reason, escalated: 1 };
        }
        verdict = carried;
        reused += 1;
      } else {
        verdict = classifyCandidate(row);
        classified = await deps.yieldAfterClassified(classified);
      }
      if (row.verdictKey) next.set(row.verdictKey, verdict);
      if (verdict.wedged) confirmed.push({ ownerId: row.ownerId, reason: verdict.reason });
      else if (row.advSessionId != null && acknowledgedActivation(row.activation)) healthy.add(row.ownerId);
    }
  }

  // A built-in positive control. Every operator has session_briefs rows carrying
  // an activation; zero means the query matched nothing it should have matched
  // (wrong workspace, renamed column, a migration not applied) — which returns
  // an empty `wedged` list that is indistinguishable from a clean fleet.
  if (scanned === 0) {
    const reason = 'no session_briefs rows carried an activation — the sweep cannot have measured anything';
    await raiseIdentityCondition('wedged-coverage', workspaceId, '', reason, deps);
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  // A COMPLETE scan: carry exactly the verdicts of the rows it saw, so a deleted
  // or re-selected launch row drops out instead of accumulating.
  deps.verdictCache.verdicts = next;
  deps.verdictCache.lastReused = reused;
  deps.verdictCache.lastScanned = scanned;
  deps.verdictCache.lastRetired = retired;

  // Recovery follows only a complete scan and an exact acknowledged, reconciled
  // owner row. Retirement, removal and loss of an activation are not recovery.
  // ATTEST rung (WI-6554700010029612): observed denials outrank a healthy-looking record, and
  // must veto the healthy-recovery below. An unreadable ledger fails closed like a failed
  // candidate read: unknown, never "clean".
  let attested: DenialAttestation[];
  try {
    attested = await deps.loadDenialAttestations(workspaceId);
  } catch (e) {
    const reason = `denial attestation read failed: ${e instanceof Error ? e.message : String(e)}`;
    await raiseIdentityCondition('wedged-coverage', workspaceId, '', reason, deps);
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }
  const confirmedOwners = new Set(confirmed.map((c) => c.ownerId));
  for (const attestation of attested) {
    if (confirmedOwners.has(attestation.ownerId)) continue;
    confirmedOwners.add(attestation.ownerId);
    confirmed.push({ ownerId: attestation.ownerId, reason: attestedWedgeReason(attestation) });
  }

  const stillWedged = new Set(confirmed.map(candidate => candidate.ownerId));
  for (const ownerId of healthy) {
    if (!stillWedged.has(ownerId)) await recoverIdentityCondition('wedged', workspaceId, ownerId, episodes, deps);
  }
  await recoverIdentityCondition('wedged-coverage', workspaceId, '', episodes, deps);

  if (confirmed.length === 0) return { verdict: 'clean', scanned, escalated: 0 };

  let liveness: Map<string, WedgedLiveness>;
  try {
    liveness = await deps.resolveLiveness(confirmed.map((c) => c.ownerId));
  } catch {
    // A failed liveness read must not suppress a CONFIRMED wedge. Report it with
    // liveness unknown rather than dropping the finding.
    liveness = new Map();
  }

  const wedged: WedgedSession[] = confirmed
    .map((c) => ({ ...c, liveness: liveness.get(c.ownerId) ?? 'unknown' }))
    .filter((w) => !TERMINAL_STATES.has(w.liveness));

  for (const candidate of confirmed) {
    if (TERMINAL_STATES.has(liveness.get(candidate.ownerId) ?? 'unknown'))
      await recoverIdentityCondition('wedged', workspaceId, candidate.ownerId, episodes, deps);
  }

  if (wedged.length === 0) return { verdict: 'clean', scanned, escalated: 0 };

  for (const candidate of wedged) await raiseIdentityCondition('wedged', workspaceId, candidate.ownerId,
    `Identity activation is wedged for ${candidate.ownerId}: ${candidate.reason}`, deps);
  await deps.escalateWedged(wedged);
  return { verdict: 'wedged', scanned, wedged, escalated: 1 };
}

// ── UNAPPLIED-ACTIVATION CENSUS (WI-10004999) ─────────────────────────────
//
// A SECOND class, measured on the same tick. The sweep above finds sessions
// the gate would REFUSE. This census finds sessions the gate lets through but
// whose identity activation was never ACKNOWLEDGED: `status` stays at
// 'desired' or 'prepared' while the session keeps taking turns. Nothing is
// denied, so nobody notices — but no `applied` activation event is written, so
// no activation span opens and the session's inference cost reads as
// unattributed (WI-10004663: fresh launches applied only on turn 2, and a
// one-turn launch never; Sep 29-30 shadow-statement drop).
//
// WHY THE STATUS LABEL IS THE RIGHT INPUT HERE, when DESIGN DECISION 1 above
// rejects it: that decision is about the gate's stale-artifact question, which
// the label does not answer. This census asks a different question — "was the
// latest desired transition acknowledged?" — and the label is exactly that
// answer: session-activation.ts sets 'applied' ONLY in the apply transition.
// The label alone still over-reports, so two more conditions gate a finding:
//
//   · TURNS, not time. An activation legitimately sits at desired/prepared
//     until the next turn-start hook applies it (turn 1 on the fixed build,
//     turn 2 on the pre-WI-10004663 build). A session is flagged only after it
//     has COMPLETED `UNAPPLIED_ACTIVATION_TURN_THRESHOLD` journaled turns since
//     its activation last entered desired/prepared — past every legitimate
//     path. A session that has not taken a turn yet is never flagged.
//   · A REAL identity change. desired === applied (same spec AND state
//     revision) is a re-desire of the identity already applied; the span is
//     already open, so it is not a finding.
//
// KNOWN LIMIT: turns are counted from `session_turn_journal`, which is written
// by the Claude turn-end hook only (measured 2026-10-01: every row
// source_kind='claude'). A non-Claude session reads 0 turns and is never
// flagged — a false NEGATIVE, never a false positive.

/** Completed turns, since the activation went unapplied, before it is a finding. */
export const UNAPPLIED_ACTIVATION_TURN_THRESHOLD = 2;

/** The per-row journal count stops here; the census needs ≥ threshold, not a total. */
export const UNAPPLIED_TURN_COUNT_CAP = 10;

export interface UnappliedCandidateRow {
  ownerId: string;
  /** Raw `control_state->'activation'`. */
  activation: unknown;
  /** When the activation last entered desired/prepared; null when no event records it. */
  unappliedSince: string | null;
  /** Journaled turns completed after `unappliedSince` (capped). */
  turnsSince: number;
}

export interface UnappliedSession {
  ownerId: string;
  status: 'desired' | 'prepared';
  turnsSince: number;
  unappliedSince: string;
  liveness: WedgedLiveness;
}

export type UnappliedClassification =
  | { unapplied: false }
  | { unapplied: 'unmeasured' }
  | { unapplied: true; status: 'desired' | 'prepared'; turnsSince: number; unappliedSince: string };

/** The census's instrument check — see `runUnappliedActivationCensusOnce`. */
export interface TurnJournalPositiveControl {
  /** session_briefs rows touched in the last 24h (was the fleet active at all?). */
  recentBriefs: number;
  /** session_turn_journal rows written in the last 24h. */
  recentJournalTurns: number;
}

export interface UnappliedActivationCensusDeps extends IdentityConditionDeps {
  loadUnapplied: (openEpisodeOwners: readonly string[]) => Promise<UnappliedCandidateRow[]>;
  loadPositiveControl: () => Promise<TurnJournalPositiveControl>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, WedgedLiveness>>;
  escalateUnapplied: (unapplied: UnappliedSession[]) => Promise<void>;
  escalateNotMeasured: (info: { reason: string }) => Promise<void>;
}

function sameActivationPair(
  a: { specificationRevision: string; stateRevision: string } | null | undefined,
  b: { specificationRevision: string; stateRevision: string } | null | undefined,
): boolean {
  return !!a && !!b && a.specificationRevision === b.specificationRevision && a.stateRevision === b.stateRevision;
}

/** Classify ONE census row. Pure. */
export function classifyUnapplied(
  row: UnappliedCandidateRow,
  threshold: number = UNAPPLIED_ACTIVATION_TURN_THRESHOLD,
): UnappliedClassification {
  let parsed: ReturnType<typeof normalizeSessionActivation>;
  try {
    parsed = normalizeSessionActivation(row.activation);
  } catch {
    // Malformed is ungoverned for the kernel, so it is not this census's finding.
    return { unapplied: false };
  }
  if (!parsed || (parsed.status !== 'desired' && parsed.status !== 'prepared')) return { unapplied: false };
  if (sameActivationPair(parsed.desired, parsed.applied)) return { unapplied: false };
  if (!Number.isSafeInteger(row.turnsSince) || row.turnsSince < 0 ||
      (row.unappliedSince != null && !Number.isFinite(Date.parse(row.unappliedSince))))
    return { unapplied: 'unmeasured' };
  // Unapplied, but no event says since WHEN, so its turns cannot be counted.
  // Reported as a count, never guessed into a finding.
  if (row.unappliedSince == null) return { unapplied: 'unmeasured' };
  if (row.turnsSince < threshold) return { unapplied: false };
  return {
    unapplied: true,
    status: parsed.status,
    turnsSince: row.turnsSince,
    unappliedSince: row.unappliedSince,
  };
}

async function defaultLoadUnapplied(openEpisodeOwners: readonly string[] = []): Promise<UnappliedCandidateRow[]> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  // Index-backed per row: events by (workspace_id, owner_id, recorded_at, id);
  // journal by (owner_id, created_at DESC), capped so a long-lived session
  // costs at most UNAPPLIED_TURN_COUNT_CAP index entries.
  const rows = await sql<Array<{
    owner_id: string;
    activation: unknown;
    unapplied_since: Date | string | null;
    turns_since: string | number | null;
  }>>`
    SELECT b.owner_id,
           b.control_state->'activation' AS activation,
           u.recorded_at AS unapplied_since,
           CASE WHEN u.recorded_at IS NULL THEN 0 ELSE (
             SELECT count(*) FROM (
               SELECT 1
                 FROM harness_shared.session_turn_journal j
                WHERE j.owner_id = b.owner_id
                  AND j.workspace_id = b.workspace_id
                  AND j.created_at > u.recorded_at
                LIMIT ${UNAPPLIED_TURN_COUNT_CAP}
             ) AS capped
           ) END AS turns_since
      FROM harness_shared.session_briefs b
      LEFT JOIN LATERAL (
        SELECT ev.recorded_at
          FROM harness_shared.session_identity_activation_events ev
         WHERE ev.workspace_id = b.workspace_id
           AND ev.owner_id = b.owner_id
           AND ev.phase IN ('desired', 'prepared')
         ORDER BY ev.recorded_at DESC, ev.id DESC
         LIMIT 1
      ) u ON true
     WHERE b.workspace_id = ${workspaceId}
       AND (b.control_state->'activation'->>'status' IN ('desired', 'prepared')
            OR b.owner_id = ANY(${[...openEpisodeOwners]}::text[]))
  `;
  return rows.map((r) => ({
    ownerId: r.owner_id,
    activation: r.activation,
    unappliedSince: r.unapplied_since == null ? null : toIsoUtc(r.unapplied_since),
    turnsSince: Number(r.turns_since ?? 0),
  }));
}

/** postgres.js returns timestamptz as a LOCAL-offset string here (measured
 * 2026-10-01: "2026-10-01 13:47:34.454261-04"); render UTC ISO like every
 * other Papercusp timestamp, keeping the raw value if it does not parse. */
function toIsoUtc(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

async function defaultLoadPositiveControl(): Promise<TurnJournalPositiveControl> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const [row] = await sql<Array<{ recent_briefs: string | number; recent_journal_turns: string | number }>>`
    SELECT
      (SELECT count(*) FROM harness_shared.session_briefs
        WHERE workspace_id = ${workspaceId} AND updated_at > now() - interval '24 hours') AS recent_briefs,
      (SELECT count(*) FROM harness_shared.session_turn_journal
        WHERE workspace_id = ${workspaceId} AND created_at > now() - interval '24 hours') AS recent_journal_turns
  `;
  return {
    recentBriefs: Number(row?.recent_briefs ?? 0),
    recentJournalTurns: Number(row?.recent_journal_turns ?? 0),
  };
}

async function defaultEscalateUnapplied(unapplied: UnappliedSession[]): Promise<void> {
  const n = unapplied.length;
  const lines = unapplied
    .map(
      (u) =>
        `  · ${u.ownerId} — ${u.status} since ${u.unappliedSince}, ${u.turnsSince}` +
        `${u.turnsSince >= UNAPPLIED_TURN_COUNT_CAP ? '+' : ''} turns (liveness: ${u.liveness})`,
    )
    .sort();
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${n} live session${n === 1 ? '' : 's'} kept taking turns with an identity activation ` +
      `that was never applied — inference cost is unattributed`,
    body:
      `Each session below has completed at least ${UNAPPLIED_ACTIVATION_TURN_THRESHOLD} turns since its ` +
      `identity activation last entered desired/prepared, and it is still not applied:\n\n` +
      `${lines.join('\n')}\n\n` +
      `CONSEQUENCE: no 'applied' activation event is written, so no activation span opens and ` +
      `every turn this session spends reads as unattributed inference cost. Nothing is denied, ` +
      `so the session itself will not notice.\n\n` +
      `WHAT IT IS NOT: a wedge. The kernel is not refusing these sessions — that class is the ` +
      `wedged-identity-activation escalation. And it is not a session merely between turns: an ` +
      `activation applies at the next turn start, which every session below has already passed.\n\n` +
      `TO DIAGNOSE: read the owner's session_identity_activation_events trail (which door ` +
      `desired it — launch/restart/control — and whether a prepared ever followed) against ` +
      `adv_sessions.launch_spec. Prior instance and fix: WI-10004663 (a fresh 'launch' never ` +
      `applied at turn 1). Census: WI-10004999.`,
    meta: {
      dedupKind: 'unapplied-identity-activation',
      // Keyed on WHICH sessions, like the wedge escalation: a persistent finding
      // dedups instead of re-alarming hourly; a new session opens a fresh one.
      subjectSignature: unapplied.map((u) => `${u.ownerId}:${u.status}`).sort().join(','),
      unappliedCount: n,
      unapplied: unapplied.map((u) => ({
        ownerId: u.ownerId,
        status: u.status,
        turnsSince: u.turnsSince,
        unappliedSince: u.unappliedSince,
        liveness: u.liveness,
      })),
    },
  });
}

async function defaultEscalateCensusNotMeasured(info: { reason: string }): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Unapplied-activation census NOT MEASURED: ${info.reason}`,
    body:
      `The unapplied-identity-activation census could not complete, so this is a FAILED ` +
      `MEASUREMENT — not a clean fleet. Reason: ${info.reason}.\n\n` +
      `The census counts turns from session_turn_journal. If that journal is not being written, ` +
      `every session reads 0 turns and the census would report clean forever.`,
    meta: {
      dedupKind: 'unapplied-identity-activation-not-measured',
      subjectSignature: info.reason,
    },
  });
}

function censusDeps(overrides: Partial<UnappliedActivationCensusDeps>): UnappliedActivationCensusDeps {
  return {
    loadUnapplied: defaultLoadUnapplied,
    loadPositiveControl: defaultLoadPositiveControl,
    resolveLiveness: defaultResolveLiveness,
    escalateUnapplied: defaultEscalateUnapplied,
    escalateNotMeasured: defaultEscalateCensusNotMeasured,
    ...overrides,
  };
}

export type UnappliedActivationCensusOutcome =
  | { verdict: 'clean'; scanned: number; ended: number; unmeasured: number; escalated: 0 }
  | {
      verdict: 'unapplied';
      scanned: number;
      unapplied: UnappliedSession[];
      ended: number;
      unmeasured: number;
      escalated: 1;
    }
  | { verdict: 'not-measured'; reason: string; escalated: 1 };

export async function runUnappliedActivationCensusOnce(
  overrides: Partial<UnappliedActivationCensusDeps> = {},
): Promise<UnappliedActivationCensusOutcome> {
  const deps = censusDeps(overrides);
  const workspaceId = deps.workspaceId ?? activeWorkspaceId();
  const episodes = await identityEpisodes(deps);

  let rows: UnappliedCandidateRow[];
  let control: TurnJournalPositiveControl;
  try {
    [rows, control] = await Promise.all([
      deps.loadUnapplied(episodeOwners(episodes, 'unapplied', workspaceId)), deps.loadPositiveControl(),
    ]);
  } catch (e) {
    const reason = `census read failed: ${e instanceof Error ? e.message : String(e)}`;
    await raiseIdentityCondition('unapplied-coverage', workspaceId, '', reason, deps);
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  // The positive control. Zero unapplied rows is a legitimate clean fleet, so
  // the row count cannot be the control (unlike the wedge sweep). The
  // instrument that CAN silently break is the turn counter: a journal that
  // stopped being written makes every session read 0 turns, which is
  // indistinguishable from "nobody is stuck". An active fleet (briefs touched
  // in 24h) with zero journaled turns is that broken instrument.
  if (!Number.isSafeInteger(control.recentBriefs) || control.recentBriefs < 0 ||
      !Number.isSafeInteger(control.recentJournalTurns) || control.recentJournalTurns < 0 ||
      (control.recentBriefs > 0 && control.recentJournalTurns === 0)) {
    const reason =
      `${control.recentBriefs} session brief(s) were active in the last 24h but session_turn_journal ` +
      `recorded 0 turns — the census cannot count turns`;
    await raiseIdentityCondition('unapplied-coverage', workspaceId, '', reason, deps);
    await deps.escalateNotMeasured({ reason });
    return { verdict: 'not-measured', reason, escalated: 1 };
  }

  let unmeasured = 0;
  const confirmed: Array<Omit<UnappliedSession, 'liveness'>> = [];
  const recovered = new Set<string>();
  for (const row of rows) {
    // A smaller turn count, malformed activation or missing row does not show
    // that an already-open unapplied episode has converged.
    try {
      const parsed = normalizeSessionActivation(row.activation);
      if (parsed?.applied && sameActivationPair(parsed.desired, parsed.applied)) recovered.add(row.ownerId);
    } catch { /* Unknown activation preserves existing episodes. */ }
    const verdict = classifyUnapplied(row);
    if (verdict.unapplied === 'unmeasured') unmeasured += 1;
    else if (verdict.unapplied === true) {
      confirmed.push({
        ownerId: row.ownerId,
        status: verdict.status,
        turnsSince: verdict.turnsSince,
        unappliedSince: verdict.unappliedSince,
      });
    }
  }

  const scanned = rows.length;
  const stillUnapplied = new Set(confirmed.map(candidate => candidate.ownerId));
  for (const ownerId of recovered) {
    if (!stillUnapplied.has(ownerId)) await recoverIdentityCondition('unapplied', workspaceId, ownerId, episodes, deps);
  }
  if (unmeasured === 0) await recoverIdentityCondition('unapplied-coverage', workspaceId, '', episodes, deps);
  else await raiseIdentityCondition('unapplied-coverage', workspaceId, '',
    `${unmeasured} activation row(s) have no valid measured turn history`, deps);
  if (confirmed.length === 0) return { verdict: 'clean', scanned, ended: 0, unmeasured, escalated: 0 };

  let liveness: Map<string, WedgedLiveness>;
  try {
    liveness = await deps.resolveLiveness(confirmed.map((c) => c.ownerId));
  } catch {
    // A failed liveness read must not suppress a confirmed finding.
    liveness = new Map();
  }

  const withLiveness = confirmed.map((c) => ({ ...c, liveness: liveness.get(c.ownerId) ?? 'unknown' }));
  // An ended session cannot be converged; its finding is history, not an alarm.
  const unapplied = withLiveness.filter((u) => !TERMINAL_STATES.has(u.liveness));
  const ended = withLiveness.length - unapplied.length;
  for (const candidate of withLiveness) {
    if (TERMINAL_STATES.has(candidate.liveness))
      await recoverIdentityCondition('unapplied', workspaceId, candidate.ownerId, episodes, deps);
  }

  if (unapplied.length === 0) return { verdict: 'clean', scanned, ended, unmeasured, escalated: 0 };

  for (const candidate of unapplied) await raiseIdentityCondition('unapplied', workspaceId, candidate.ownerId,
    `Identity activation is unapplied for ${candidate.ownerId} after ${candidate.turnsSince} turns`, deps);
  await deps.escalateUnapplied(unapplied);
  return { verdict: 'unapplied', scanned, unapplied, ended, unmeasured, escalated: 1 };
}

let watchdogTimer: ManagedHandle | null = null;

export function startWedgedIdentityActivationWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? WEDGED_IDENTITY_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'wedged-identity-activation-watchdog',
    intervalMs,
    () => {
      if (sweeping) return;
      sweeping = true;
      const warn = (what: string) => (e: unknown) => {
        console.warn(
          `[wedged-identity-activation-watchdog] ${what} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      };
      // Sequential, not parallel: each holds a PG connection, and the wedge
      // sweep's cursor is the expensive one (WI-10004803). A failure in either
      // never skips the other.
      void runWedgedIdentitySweepOnce()
        .catch(warn('sweep'))
        .then(() => runUnappliedActivationCensusOnce())
        .catch(warn('unapplied-activation census'))
        .finally(() => {
          sweeping = false;
        });
    },
    // 'must-sample': a wedge is a RELATIONSHIP between two rows written by
    // different writers at different times. Neither writer knows it created one,
    // so there is no event to subscribe to — it has to be read.
    { category: 'watchdog', classification: 'must-sample' },
  );
}

export function stopWedgedIdentityActivationWatchdog(): void {
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = null;
}
