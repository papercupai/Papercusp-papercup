/** PTY-host failures from the existing JSONL → Postgres event path, projected into
 * Blender's corpus. The host's event kinds are the source of truth; stderr is a
 * human diagnostic and cannot be counted after a terminal repaint. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KINDS_READ = 200;

export interface PtyHostEventAggregate {
  kind: string;
  count: number;
  owners: number;
  latestId: string;
  lastAt: string;
}

export type PtyHostEventClass = 'failure' | 'recovered' | 'routine' | 'unclassified';

/** A successful turn with resubmits is recovery evidence, not a failed wake.
 * Expected dedup/stale-fire decisions are also routine. Unknown new kinds are
 * surfaced as unclassified so the taxonomy cannot silently lose a new error. */
export function classifyPtyHostEvent(kind: string): PtyHostEventClass {
  if (
    kind === 'turn-delivered-after-retry' ||
    kind === 'discovery-reasserted' ||
    kind === 'owner-composer-wedge-cleared' ||
    kind === 'launch-kickoff-turn-start-retry' ||
    // WI-10004943: a fresh Codex child stuck at Starting was replaced and the
    // kickoff re-delivered. The replacement's outcome is a separate event
    // (launch-kickoff-fresh-child-failed counts as failure via the suffix rule).
    kind === 'launch-kickoff-fresh-child-retry' ||
    // EI-24818010361425604: a same-host respawn replaced the child mid-kickoff
    // and the kickoff is re-delivered to the successor. Like the fresh-child
    // retry above, the redelivery itself is recovery evidence.
    kind === 'launch-kickoff-respawn-redelivery' ||
    kind === 'launch-kickoff-model-turn-retry-result' ||
    kind === 'submit-verify-human-input-retry' ||
    // The guarded verifier emitted one safe CR after confirming the prior
    // submit did not start a turn; payload carries the resubmit counters.
    kind === 'submit-verify-recovery-resubmit' ||
    kind === 'respawn-carry-fresh-epoch-retry' ||
    kind === 'respawn-carry-turn-start-retry' ||
    // WI-10005472: a headless Claude child whose composer paint was never seen
    // fell back to the ordinary busy gate instead of dropping its carry/kickoff.
    kind === 'headless-claude-composer-unseen-ordinary-gate' ||
    kind === 'operator-pin-healed' ||
    // The same heal, resolved by routing through the staging proxy instead.
    kind === 'operator-pin-routed' ||
    kind === 'owner-composer-cleared-on-respawn' ||
    kind === 'inject-mutex-force-released' ||
    kind === 'mcp-reconnect-completed' ||
    // WI-10003875: a claude quota latch the native transcript proved was the
    // model's own prose, dismissed so wakes resume — a detector false positive
    // that self-healed, worth counting but not a final failure.
    kind === 'quota-block-dismissed-transcript-echo' ||
    // WI-6554700010008412: a codex quota latch released at the provider's
    // stated reset so the next deferred wake can run.
    kind === 'quota-block-expired-at-reset' ||
    kind === 'quota-recovery-resumed'
  ) return 'recovered';

  if (
    // D-014: a latched codex quota wall let one deferred wake through as a probe;
    // routine whether or not the wall is still up (it re-latches if so).
    kind === 'quota-block-probe-released' ||
    kind === 'stale-fire-dropped' ||
    kind === 'respawn-rearm-superseded' ||
    // A carry-respawn replaced the child while a delivery's native turn-start
    // proof was still pending. That proof can never be certified against the
    // successor, so the host tombstones the delivery ID to refuse a second paste
    // (dedup, not a fault). The unproven start was already recorded by the
    // delivery path's own failure event (native-turn-start-unverified or
    // submit-verify-unconfirmed), so counting this retirement would double-count.
    kind === 'native-turn-start-superseded' ||
    kind === 'wake-turn-deferred-for-pending-respawn' ||
    kind === 'pty-spawned' ||
    kind === 'turn-deferred-for-owner-input' ||
    kind === 'duplicate-delivery-id' ||
    // An explicit cancellation fences the pending delivery before PTY write;
    // duplicates remain suppressed rather than resurrecting a cancelled turn.
    kind === 'delivery-cancellation-requested' ||
    kind === 'delivery-cancelled-before-write' ||
    kind === 'duplicate-cancelled-delivery-id' ||
    // Idle parking, successful resume, and retained delivery waits are lifecycle
    // state. Their failed/refused outcomes are separate events below.
    kind === 'child-parked' ||
    kind === 'child-park-deferred' ||
    kind === 'child-unparked' ||
    kind === 'parked-delivery-held' ||
    // Completion records exit/force-kill diagnostics; the separate force-kill
    // event carries escalation, so this event does not assert successful stop.
    kind === 'respawn-predecessor-stop-finished' ||
    // The first model turn began while its retry was queued; suppressing that
    // second kickoff is successful duplicate prevention, not a host failure.
    kind === 'launch-kickoff-model-turn-retry-skipped' ||
    kind === 'queued-turn-folded' ||
    kind === 'headless-codex-model-choice-kept-existing' ||
    kind === 'headless-codex-model-choice-select-existing' ||
    // Sending Escape is a startup control action, not proof the dialog closed.
    // Skipping a stale/shutdown child is intentional; write failure is separate.
    kind === 'codex-startup-update-dialog-escape-sent' ||
    kind === 'codex-startup-update-dialog-escape-skipped' ||
    kind === 'headless-claude-onboarding-advanced' ||
    // A requested hooks observation records its structured result separately;
    // the result itself is diagnostic data, not a PTY-host failure verdict.
    kind === 'hooks-observation-result' ||
    // Waiting while the backend explicitly shows Starting is an in-deadline
    // hold; the terminal timeout/drop has its own failure event.
    kind === 'kickoff-waiting-for-codex-startup' ||
    kind === 'claude-resume-compaction-summary-selected' ||
    kind === 'shutdown-accepted' ||
    // The host accepted the carry request for processing; terminal delivery
    // success or failure is recorded by a later event.
    kind === 'respawn-carry-accepted' ||
    kind === 'host-teardown' ||
    // A slow Codex composer paste still inside the kickoff delivery deadline.
    // Its terminal outcome is recorded separately as `-confirmed` (routine) or
    // `-unconfirmed` (failure), so counting this as a failure double-counts.
    kind === 'launch-kickoff-marker-echo-pending' ||
    // The hold and its diagnostic snapshot have separate terminal drop events.
    // Hold-ended includes successful and interrupted outcomes, so it is not a
    // failure verdict by itself.
    kind === 'kickoff-held-for-codex-frame' ||
    kind === 'kickoff-codex-frame-hold-ended' ||
    kind === 'codex-starting-stuck-snapshot' ||
    // An explicitly Starting Codex footer extends the early frame wait only
    // within the kickoff deadline; the terminal timeout is recorded separately.
    kind === 'launch-kickoff-backend-frame-wait-extended' ||
    // Host-control bookkeeping and owner/child lifecycle facts. A child exit is
    // neutral evidence: failures are recorded by their own failure kinds.
    kind === 'control-carry-origin-stamped' ||
    kind === 'owner-stop-requested' ||
    kind === 'pty-child-exited' ||
    // An in-place context reset re-anchored its rotated native id, or had nothing to
    // re-anchor (no carry marker, superseded child, unsupported agent). A re-anchor that
    // did not land is `reset-reanchor-failed` and classifies as a failure below.
    kind === 'reset-reanchor-reported' ||
    kind === 'reset-reanchor-skipped' ||
    // A carry fence was accepted; a refused fence is `pending-carry-fence-refused`.
    kind === 'pending-carry-fenced'
  ) return 'routine';

  if (
    kind === 'host-code-stale' ||
    kind === 'orphan-teardown' ||
    kind === 'control-payload-unaddressed' ||
    kind === 'control-payload-rejected' ||
    kind === 'wake-provenance-rejected' ||
    // The continuation-identity check refused the launch kickoff; it was never delivered.
    kind === 'launch-kickoff-rejected' ||
    // Resume was abandoned after repeated exits; no live child was restored.
    kind === 'child-unpark-abandoned' ||
    // The predecessor did not exit within the graceful stop deadline.
    kind === 'respawn-predecessor-force-kill' ||
    // The kickoff was refused and publishing its refusal receipt failed; the
    // headless host terminates with an error rather than hiding the refusal.
    kind === 'kickoff-refusal-unreported-terminating' ||
    kind === 'persona-refresh-skipped' ||
    kind === 'turn-verifier-unsupported' ||
    kind === 'wake-rearm-unsupported' ||
    kind === 'quota-block-detected' ||
    // P-004: the codex login is dead; the child cannot take a turn until recovery.
    kind === 'auth-block-detected' ||
    kind === 'model-capacity-detected' ||
    kind === 'turn-deferred-quota-blocked' ||
    kind === 'launch-kickoff-model-turn-absent' ||
    // The provider capacity gate can reject the initial kickoff before a turn
    // starts; keep that terminal outcome classified alongside quota rejection.
    kind === 'launch-kickoff-model-capacity-rejected' ||
    kind === 'launch-role-mcp-unavailable' ||
    // The submitted kickoff was rejected by a provider quota wall.
    kind === 'launch-kickoff-quota-rejected' ||
    // The predecessor remains alive/unconfirmed after the force-kill request;
    // the recycle fence correctly stays held until exit is observed.
    kind === 'respawn-predecessor-stop-pending' ||
    // Native seed persistence was verified, but the operator receipt remains
    // unconfirmed and must not be reported as delivered.
    kind === 'session-port-delivery-ack-pending' ||
    // The carry-respawn sibling of launch-role-mcp-unavailable (computed kind in
    // psu-pty-host.mjs: result.ok ? 'respawn-carry-mcp-ready' : '...-unavailable').
    kind === 'respawn-carry-mcp-unavailable' ||
    // A dropped carry is waiting on exact-child native-binding recovery; it is not delivered yet.
    kind === 'respawn-carry-binding-recovery-pending' ||
    kind === 'busy-gate-expired' ||
    // EI-27244198558252718: an unbounded production re-arm still pending past its
    // stall interval. While a carry is pending every wake is deferred behind it, so
    // this row is the only signal of a host that has gone mute (one sat 3h, silent).
    kind === 'respawn-rearm-still-pending' ||
    kind === 'wake-rearm-still-pending' ||
    kind === 'codex-starting-stuck-early-drop' ||
    // A respawn whose compaction was never reported to the operator.
    kind === 'respawn-compaction-unannounced' ||
    // An identity-assume preparation threw; the caller stays fenced for reconciliation.
    kind === 'identity-assume-boundary-unavailable' ||
    // A kickoff refused by provider quota terminates the child.
    kind === 'kickoff-provider-quota-rejected-terminating' ||
    /(?:^|-)(?:failed|error|expired|timeout|timed-out|unconfirmed|unverified|exhausted|truncated|dropped|refused|stuck|starvation|suspected|partial)$/.test(kind)
  ) return 'failure';

  if (
    // The original carry drop is already failure-classified; this is the
    // terminal cancellation of its optional binding-recovery retry.
    kind === 'respawn-carry-binding-recovery-cancelled' ||
    /(?:^|-)(?:delivered|written|observed|queued|scheduled|started|ready|cleared|confirmed|adopting|respawned|folded)$/.test(kind)
  ) return 'routine';
  return 'unclassified';
}

/** Aggregate rows are event counts, not unique incidents: a failed startup may
 * record both a generic drop and a phase-specific failure. Keep each source
 * kind separate and cite its latest persisted row for drill-back. */
export function buildPtyHostHealthPatterns(
  aggregates: readonly PtyHostEventAggregate[],
  opts: { limit?: number; totalKinds?: number } = {},
): MetaPattern[] {
  const limit = Math.max(1, opts.limit ?? 20);
  const rank = { failure: 3, recovered: 2, unclassified: 1, routine: 0 };
  const ranked = aggregates
    .map((row) => ({ row, eventClass: classifyPtyHostEvent(row.kind) }))
    .filter(({ eventClass }) => eventClass !== 'routine')
    .sort((a, b) => {
      return rank[b.eventClass] - rank[a.eventClass] || b.row.count - a.row.count || a.row.kind.localeCompare(b.row.kind);
    });
  // A noisy failure class must not crowd recovered delivery or a new,
  // unclassified kind entirely out of Blender's bounded view.
  const representatives = ranked
    .filter((candidate, index) => ranked.findIndex((entry) => entry.eventClass === candidate.eventClass) === index)
    .slice(0, limit);
  const selected = new Set(representatives);
  const shown = [
    ...representatives,
    ...ranked.filter((entry) => !selected.has(entry)).slice(0, limit - representatives.length),
  ].sort((a, b) => rank[b.eventClass] - rank[a.eventClass] || b.row.count - a.row.count || a.row.kind.localeCompare(b.row.kind));
  const patterns = shown.map(({ row, eventClass }): MetaPattern => ({
    category: 'pty-host-health',
    ref: `pty-host:kind:${encodeURIComponent(row.kind)}`,
    summary: `${row.kind}: ${row.count} PTY-host event(s) across ${row.owners} session(s) in 24h`,
    detail: `${eventClass === 'recovered' ? 'Recovered or retried, not a final failure' : eventClass === 'unclassified' ? 'Unclassified event kind; inspect before treating as a failure' : 'Failure signal'}; latest persisted event psu_pty_host_events.id=${row.latestId} at ${row.lastAt}. Counts are event rows, not unique incidents.`,
    weight: Math.min(1, (eventClass === 'failure' ? 0.7 : eventClass === 'recovered' ? 0.45 : 0.3) + row.count / 100),
  }));
  const unseen = Math.max(0, ranked.length - shown.length);
  const unread = Math.max(0, (opts.totalKinds ?? aggregates.length) - aggregates.length);
  if (unseen || unread) {
    patterns.push({
      category: 'pty-host-health',
      ref: 'pty-host:coverage-residue',
      summary: `${unseen + unread} PTY-host event kind(s) outside this corpus view`,
      detail: `${unseen} classified kinds below the pattern cap; ${unread} kinds outside the ${MAX_KINDS_READ}-kind database read cap. Query psu_pty_host_events to inspect them.`,
      weight: 0.5,
    });
  }
  return patterns;
}

/** Workspace-scoped production reader. A fault in this source drops only this
 * optional lane, preserving the rest of the Blender digest. */
export async function buildPtyHostHealthLane(
  opts: { workspaceId?: string; nowMs?: number; limit?: number } = {},
): Promise<MetaPattern[]> {
  try {
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const nowMs = opts.nowMs ?? Date.now();
    const since = new Date(nowMs - WINDOW_MS).toISOString();
    const until = new Date(nowMs).toISOString();
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
      kind: string; count: number | string; owners: number | string;
      latest_id: string; last_at: string; total_kinds: number | string;
    }>>`
      WITH scoped AS (
        SELECT id, owner_id, ts,
               CASE WHEN kind = 'turn-delivered'
                         AND (payload->>'resubmits') ~ '^[1-9][0-9]*$'
                    THEN 'turn-delivered-after-retry'
                    ELSE kind END AS kind
          FROM harness_shared.psu_pty_host_events
         WHERE workspace_id = ${ws}
           -- ownerFromFilename ingests carry-drills.events.jsonl as a pseudo-owner.
           -- It mirrors per-session host events and also contains operator-side drills.
           AND owner_id <> 'carry-drills'
           AND ts >= ${since}::timestamptz
           AND ts <= ${until}::timestamptz
      )
      SELECT kind, count(*)::int AS count,
             count(DISTINCT owner_id)::int AS owners,
             ((array_agg(id ORDER BY ts DESC, id DESC))[1])::text AS latest_id,
             max(ts)::text AS last_at,
             count(*) OVER()::int AS total_kinds
        FROM scoped
       GROUP BY kind
       ORDER BY count(*) DESC
       LIMIT ${MAX_KINDS_READ}`;
    return buildPtyHostHealthPatterns(
      rows.map((r) => ({
        kind: r.kind,
        count: Number(r.count),
        owners: Number(r.owners),
        latestId: r.latest_id,
        lastAt: r.last_at,
      })),
      { limit: opts.limit, totalKinds: Number(rows[0]?.total_kinds ?? 0) },
    );
  } catch {
    return [];
  }
}
