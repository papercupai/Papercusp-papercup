/** Production adapter for the shared interruption classifier. Uses the existing
 * host-event WAL/ingest, session lifecycle JSON, and governed exact-resume door. */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { pgDateOrNull } from '../../connected-apps/pg-dates';
import { findLiveHostAsync } from '../../events/await/psu-pty-discovery';
import { readWorkItemAwaitTargets, isWakeSource,
  readHeldWorkItems } from '../../events/await/wake-source-predicate';
import { hasPendingDeliberateWakeDelivery } from '../../events/await/store';
import { listPendingGates } from '../../attention/gate-store';
import { readAssumeCallerPause } from '../../session-assume-pause';
import { getLoopStatuses } from './loop';
import { ingestPsuPtyHostEvents } from './psu-pty-host-events-ingest';
import { recoverInterruptedSessions, sessionRecoveryKey, SESSION_RECOVERY_LEASE_MS,
  SESSION_RECOVERY_MAX_ATTEMPTS, classifySessionInterruption,
  type SessionInterruption, type SessionRecoveryEvidence, type SessionRecoveryDeps, type SessionRecoveryDecision } from './session-interruption-recovery';
import type { SystemActionCtx } from './system-actions';

export type RecoveryOutcome = { verified: boolean; reason: string; terminal?: boolean };
export interface SessionInterruptionRuntime extends SessionRecoveryDeps {
  read(ownerId: string): Promise<SessionRecoveryEvidence | null>;
  verify(candidate: SessionRecoveryEvidence): Promise<RecoveryOutcome>;
  markDispatch(candidate: SessionRecoveryEvidence): Promise<boolean>;
  finish(candidate: SessionRecoveryEvidence, key: string, result: RecoveryOutcome): Promise<boolean>;
  protectedOwnerIds: Set<string>;
}

interface SourceRow {
  owner_id: string; session_id: string; retired_at: unknown; pid: number | null;
  launch_spec: Record<string, unknown> | null; payload: Record<string, unknown>; ts: Date | string;
  receipt: (SessionInterruption & { key: string }) | null;
}

function processState(pid: number | null): 'live' | 'dead' | 'unknown' {
  if (!pid || !Number.isInteger(pid)) return 'dead';
  try { process.kill(pid, 0); return 'live'; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

/** Reject malformed or foreign snapshots instead of turning absent execution into work. */
export function interruptionFromEvent(row: Pick<SourceRow, 'owner_id' | 'session_id' | 'payload' | 'ts'>): SessionInterruption | null {
  const p = row.payload;
  const x = p.execution as SessionInterruption['execution'] | undefined;
  if (!x || p.ownerId !== row.owner_id || p.nativeSessionId !== row.session_id ||
      x.ownerId !== row.owner_id || x.hostPid !== p.hostPid ||
      typeof p.hostPid !== 'number' || typeof p.hostStartedAt !== 'number') return null;
  return { v: 1, ownerId: row.owner_id, nativeSessionId: row.session_id,
    hostPid: p.hostPid, hostStartedAt: p.hostStartedAt, execution: x,
    capturedAt: new Date(row.ts).getTime(), attempts: 0, nextAttemptAt: 0, state: 'pending' };
}

export async function createSessionInterruptionRuntime(ctx: SystemActionCtx, dryRun = false,
  options: { fleetSlug?: string; initialize?: boolean; actionId?: string;
    /** Canonical process tests substitute only the final native creation. */
    nativeLaunch?: (args: { candidate: SessionRecoveryEvidence;
      decision: Exclude<SessionRecoveryDecision, { action: 'hold' }>; key: string;
      beforeNativeCreate: () => Promise<void> }) => Promise<RecoveryOutcome>;
  } = {}): Promise<SessionInterruptionRuntime> {
  const sql = getOrgPg().sql;
  const protectedOwnerIds = new Set<string>();
  // Make the host WAL durable before reading it; reuse its bounded, fair ingest.
  if (!dryRun && options.initialize !== false) {
    const ingested = await ingestPsuPtyHostEvents({ workspaceId: ctx.workspaceId });
    if (ingested.ingestErrors) throw new Error(`interruption witness ingest failed: ${ingested.firstIngestError}`);
    // A dead launcher may never publish its final result. Its uncertain attempt
    // is consumed, and exhaustion must become a durable, explicit disposition.
    await sql`UPDATE harness_shared.session_briefs SET control_state = jsonb_set(control_state,
      '{lifecycle,interruption}', (control_state #> '{lifecycle,interruption}') ||
        '{"state":"blocked","leaseKey":null,"reason":"expired-final-reservation-uncertain"}'::jsonb)
      WHERE workspace_id = ${ctx.workspaceId}
        AND control_state #>> '{lifecycle,interruption,state}' = 'recovering'
        AND (control_state #>> '{lifecycle,interruption,attempts}')::int >= ${SESSION_RECOVERY_MAX_ATTEMPTS}
        AND (control_state #>> '{lifecycle,interruption,nextAttemptAt}')::bigint <= ${Date.now()}`;
  }
  const readRows = async (owner?: string): Promise<SourceRow[]> => sql<SourceRow[]>`
    SELECT e.owner_id, COALESCE(a.session_id, a.omp_thread_id) AS session_id, a.retired_at, a.pid, a.launch_spec, e.payload, e.ts,
           b.control_state #> '{lifecycle,interruption}' AS receipt
      FROM (
        SELECT DISTINCT ON (owner_id) owner_id, payload, ts
          FROM harness_shared.psu_pty_host_events
         WHERE workspace_id = ${ctx.workspaceId} AND kind = 'session-execution-observed'
           AND payload->>'workspaceId' = ${ctx.workspaceId}
           AND ${owner ? sql`owner_id = ${owner}` : sql`true`}
         ORDER BY owner_id, ts DESC
      ) e
      JOIN harness_shared.adv_sessions a ON a.id::text = e.payload->>'advSessionId'
        AND a.workspace_id = ${ctx.workspaceId} AND a.coord_owner_id = e.owner_id
        AND COALESCE(a.session_id, a.omp_thread_id) = e.payload->>'nativeSessionId'
      LEFT JOIN harness_shared.session_briefs b ON b.owner_id = e.owner_id
        AND b.workspace_id = ${ctx.workspaceId}
     WHERE NOT EXISTS (SELECT 1 FROM harness_shared.adv_sessions newer
       WHERE newer.coord_owner_id = a.coord_owner_id AND newer.workspace_id = a.workspace_id
         AND newer.started_at > a.started_at)
       AND ${options.fleetSlug ? sql`COALESCE(
         (SELECT member.fleet_slug IS NOT DISTINCT FROM ${options.fleetSlug}
             AND member.fleet_role IS NOT DISTINCT FROM 'member'
            FROM harness_shared.fleet_membership_events member
           WHERE member.owner_id = a.coord_owner_id AND member.workspace_id = a.workspace_id
           ORDER BY member.id DESC LIMIT 1),
         (SELECT member.fleet_slug IS NOT DISTINCT FROM ${options.fleetSlug}
             AND member.fleet_role IS NOT DISTINCT FROM 'member'
            FROM harness_shared.coord_presence member
           WHERE member.owner_id = a.coord_owner_id AND member.workspace_id = a.workspace_id), false)` : sql`true`}
       AND (${Boolean(owner || options.fleetSlug)} OR NOT (COALESCE(b.control_state #>> '{lifecycle,interruption,state}', '') IN ('restored', 'blocked')
         AND b.control_state #>> '{lifecycle,interruption,hostPid}' = e.payload->>'hostPid'
         AND b.control_state #>> '{lifecycle,interruption,hostStartedAt}' = e.payload->>'hostStartedAt'
         AND b.control_state #>> '{lifecycle,interruption,nativeSessionId}' = e.payload->>'nativeSessionId'))
     ORDER BY e.ts ASC LIMIT 100`;
  const evidence = async (row: SourceRow): Promise<SessionRecoveryEvidence> => {
    const owner = row.owner_id;
    let interruption = interruptionFromEvent(row);
    if (interruption && row.receipt?.key === sessionRecoveryKey(interruption)) {
      // Reservation accounting is durable; execution observations keep moving.
      // In particular, a stop/completion recorded during launch must win.
      interruption = { ...row.receipt, execution: interruption.execution, capturedAt: interruption.capturedAt };
    }
    const host = await findLiveHostAsync(owner);
    const liveness = host ? 'live' : processState(row.pid);
    const [awaits, statuses, held, gates, pause, delivery] = await Promise.all([
      // policy=wake is load-bearing: notify-only interest must not suppress work.
      sql<Array<{ subscriber_id: string; event_key: string; expires_ts: Date | string | null;
        timeout_behavior: string | null; once: boolean }>>`
        SELECT subscriber_id, event_key, expires_ts, timeout_behavior, once
          FROM harness_shared.event_awaits WHERE subscriber_id = ${owner} AND policy = 'wake'
           AND fired_at IS NULL AND cancelled_at IS NULL AND (expires_ts IS NULL OR expires_ts > now())`,
      getLoopStatuses([owner], { sql }), readHeldWorkItems(owner, ctx.workspaceId, sql),
      listPendingGates({ workspaceId: ctx.workspaceId, sessionId: row.session_id, limit: 1 }),
      readAssumeCallerPause(owner), hasPendingDeliberateWakeDelivery(owner),
    ]);
    const shaped = awaits.map(a => ({ subscriberId: a.subscriber_id, eventKey: a.event_key,
      expiresTs: pgDateOrNull(a.expires_ts, 'event_awaits.expires_ts')?.toISOString() ?? null,
      timeoutBehavior: a.timeout_behavior, once: a.once }));
    const targets = await readWorkItemAwaitTargets(shaped, sql);
    const loop = statuses.get(owner);
    return { ownerId: owner, nativeSessionId: row.session_id, liveness,
      retired: row.retired_at != null, recoveryEnabled: true,
      deliberatelyPaused: pause != null || loop?.explicitlyEnded === true,
      launchRecipeAvailable: row.launch_spec != null,
      headless: typeof row.launch_spec?.headless === 'boolean' ? row.launch_spec.headless : null,
      interruption, humanDecisionPending: gates.length > 0,
      meaningfulWaits: shaped.filter(a => isWakeSource(a, targets, 'coord:inbox-wake:')).length + Number(delivery),
      actionableHeldWork: held.filter(h => h.eventBlockers.length === 0).length,
      loop: loop ? { active: loop.active, goal: loop.goal,
        nextFireAt: loop.nextFireAt ? Date.parse(loop.nextFireAt) : null } : null };
  };
  const deps: SessionInterruptionRuntime = {
    protectedOwnerIds,
    read: async owner => {
      const row = (await readRows(owner))[0];
      return row ? evidence(row) : null;
    },
    verify: async candidate => {
      const host = await findLiveHostAsync(candidate.ownerId);
      const original = candidate.interruption;
      const verified = !!host && !!original && host.ownerId === candidate.ownerId &&
        host.nativeSessionId === candidate.nativeSessionId && host.startedAt > original.hostStartedAt &&
        host.pid !== original.hostPid;
      return { verified, reason: verified ? 'exact-native-host-verified' : host ? 'native-host-identity-unconfirmed' : 'native-host-not-observed' };
    },
    markDispatch: async candidate => {
      const s = candidate.interruption;
      if (dryRun || !s?.leaseKey) return false;
      const rows = await sql`UPDATE harness_shared.session_briefs SET control_state = jsonb_set(control_state,
        '{lifecycle,interruption,dispatchStartedAt}', to_jsonb(${Date.now()}::bigint))
        WHERE owner_id = ${candidate.ownerId} AND workspace_id = ${ctx.workspaceId}
          AND control_state #>> '{lifecycle,interruption,key}' = ${sessionRecoveryKey(s)}
          AND control_state #>> '{lifecycle,interruption,leaseKey}' = ${s.leaseKey}
          AND control_state #>> '{lifecycle,interruption,state}' = 'recovering'
          AND (control_state #>> '{lifecycle,interruption,nextAttemptAt}')::bigint > ${Date.now()}
          AND control_state #>> '{lifecycle,interruption,dispatchStartedAt}' IS NULL
        RETURNING owner_id`;
      return rows.length === 1;
    },
    list: async () => {
      const candidates = await Promise.all((await readRows()).map(evidence));
      if (options.fleetSlug) for (const candidate of candidates) {
        const decision = classifySessionInterruption(candidate, Date.now());
        // The refill actor uses this SAME claim, including the losing writer's
        // current lease/backoff. A human wait is also an occupied original seat.
        // Restored/live only bridges the gap until the new host WAL is ingested;
        // its next incarnation no longer inherits the old restored receipt.
        if (decision.action !== 'hold' || decision.reason === 'backoff' ||
            decision.reason === 'human-decision-pending' ||
            (decision.reason === 'already-running' && candidate.interruption?.state === 'restored')) {
          protectedOwnerIds.add(candidate.ownerId);
        }
      }
      return candidates;
    },
    claim: async (candidate, key) => {
      if (dryRun || !candidate.interruption || candidate.interruption.dispatchStartedAt != null) return null;
      const s = candidate.interruption;
      const next = { ...s, key, dispatchStartedAt: null, leaseKey: `${key}:${randomUUID()}`, state: 'recovering', attempts: s.attempts + 1,
        ...(options.actionId ? { actionId: options.actionId } : {}),
        nextAttemptAt: Date.now() + SESSION_RECOVERY_LEASE_MS };
      const rows = await sql`
        INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state)
        VALUES (${s.ownerId}, ${ctx.workspaceId},
          jsonb_build_object('lifecycle', jsonb_build_object('interruption', ${JSON.stringify(next)}::jsonb)))
        ON CONFLICT (owner_id) DO UPDATE SET control_state =
          COALESCE(session_briefs.control_state, '{}'::jsonb) || jsonb_build_object('lifecycle',
            COALESCE(session_briefs.control_state->'lifecycle', '{}'::jsonb) ||
              jsonb_build_object('interruption', ${JSON.stringify(next)}::jsonb))
        WHERE session_briefs.workspace_id = ${ctx.workspaceId} AND (
          session_briefs.control_state #>> '{lifecycle,interruption,key}' IS DISTINCT FROM ${key}
          OR (session_briefs.control_state #>> '{lifecycle,interruption,state}' NOT IN ('restored', 'blocked')
            AND session_briefs.control_state #>> '{lifecycle,interruption,dispatchStartedAt}' IS NULL
            AND (session_briefs.control_state #>> '{lifecycle,interruption,attempts}')::int = ${s.attempts}
            AND (session_briefs.control_state #>> '{lifecycle,interruption,nextAttemptAt}')::bigint <= ${Date.now()}))
        RETURNING owner_id`;
      if (!rows.length) return null;
      const fresh = (await readRows(s.ownerId))[0];
      // A newer host/native session invalidates this lease instead of inheriting it.
      if (!fresh) return { ...candidate, retired: true };
      const e = await evidence(fresh);
      return e.interruption && sessionRecoveryKey(e.interruption) === key &&
        e.interruption.leaseKey === next.leaseKey ? e : { ...e, retired: true };
    },
    restore: async (candidate, decision, key) => {
      const beforeNativeCreate = async () => {
        const row = (await readRows(candidate.ownerId))[0];
        if (!row) throw new Error('interruption-source-changed');
        const current = await evidence(row);
        const s = current.interruption;
        if (!s || s.leaseKey !== candidate.interruption!.leaseKey ||
            s.state !== 'recovering' || s.nextAttemptAt <= Date.now()) {
          throw new Error('interruption-reservation-lost-or-expired');
        }
        const fresh = classifySessionInterruption(current, Date.now(), s.leaseKey);
        if (fresh.action === 'hold') throw new Error(`interruption-revalidation:${fresh.reason}`);
        if (fresh.action !== decision.action || fresh.headless !== decision.headless)
          throw new Error('interruption-wake-boundary-changed');
      };
      await beforeNativeCreate();
      if (options.nativeLaunch) return options.nativeLaunch({ candidate, decision, key, beforeNativeCreate });
      const { default: tool, INTERNAL_INTERRUPTION_RECOVERY } = await import('../../agent-tools/capability/launch-agent');
      const response = await tool.handler({ resume: { agentId: candidate.ownerId }, fork: false,
        headless: decision.headless,
        ...(decision.action === 'resume-work' ? { brief:
          'Your native session was interrupted. Continue only the unfinished request and registered work already in this conversation. Re-read current controls and checkpoints; honor stops and pending human decisions.' } : {}),
        idempotencyKey: `${key}:${candidate.interruption!.attempts}`,
        [INTERNAL_INTERRUPTION_RECOVERY]: { ownerId: candidate.ownerId,
          nativeSessionId: candidate.nativeSessionId!, wait: decision.action === 'restore-wait', beforeNativeCreate },
      } as never, { workspaceId: ctx.workspaceId, harnessSlug: ctx.installSlug, isSuperuser: true,
        uiClientId: `system:session-interruption:${ctx.routineId ?? 'default'}` } as never) as {
          data?: { launch?: { resumeVerified?: boolean | null } }; isError?: boolean };
      return { verified: response.data?.launch?.resumeVerified === true && !response.isError,
        reason: response.data?.launch?.resumeVerified === true ? 'exact-native-host-verified' : 'resume-unconfirmed' };
    },
    finish: async (candidate, key, result) => {
      const s = candidate.interruption!;
      const marker = { ...s, key, leaseKey: null, settledLeaseKey: s.leaseKey,
        state: result.verified ? 'restored' : result.terminal || s.attempts >= SESSION_RECOVERY_MAX_ATTEMPTS ? 'blocked' : 'pending',
        nextAttemptAt: Date.now() + Math.max(1, s.attempts) * SESSION_RECOVERY_LEASE_MS, reason: result.reason };
      const rows = await sql`UPDATE harness_shared.session_briefs SET control_state = jsonb_set(control_state,
        '{lifecycle,interruption}', ${JSON.stringify(marker)}::jsonb || jsonb_build_object(
          'dispatchStartedAt', control_state #> '{lifecycle,interruption,dispatchStartedAt}'))
        WHERE owner_id = ${candidate.ownerId} AND workspace_id = ${ctx.workspaceId}
          AND control_state #>> '{lifecycle,interruption,key}' = ${key}
          AND control_state #>> '{lifecycle,interruption,leaseKey}' = ${s.leaseKey!}
          AND (control_state #>> '{lifecycle,interruption,attempts}')::int = ${s.attempts}
          AND control_state #>> '{lifecycle,interruption,state}' = 'recovering'
        RETURNING owner_id`;
      if (rows.length) return true;
      // SQL can commit before DBOS checkpoints the settlement result. Reconcile
      // only this exact lease/outcome, without rewriting the absolute deadline.
      const settled = await sql`SELECT owner_id FROM harness_shared.session_briefs
        WHERE owner_id = ${candidate.ownerId} AND workspace_id = ${ctx.workspaceId}
          AND control_state #>> '{lifecycle,interruption,key}' = ${key}
          AND control_state #>> '{lifecycle,interruption,settledLeaseKey}' = ${s.leaseKey!}
          AND (control_state #>> '{lifecycle,interruption,attempts}')::int = ${s.attempts}
          AND control_state #>> '{lifecycle,interruption,state}' = ${marker.state}
          AND control_state #>> '{lifecycle,interruption,reason}' = ${result.reason}`;
      return settled.length === 1;
    },
  };
  return deps;
}

/** SQL/native-host adapter proof, independent of the DBOS controller. */
export async function runSessionInterruptionPass(ctx: SystemActionCtx, dryRun = false,
  options: { fleetSlug?: string } = {}) {
  const runtime = await createSessionInterruptionRuntime(ctx, dryRun, options);
  const result = await recoverInterruptedSessions(runtime);
  return { ...result, protectedOwnerIds: [...runtime.protectedOwnerIds] };
}

/** Re-derivable census. Empty or ineligible scans create no action workflows. */
export async function sweepSessionInterruptions(ctx: SystemActionCtx, dryRun = false,
  options: { fleetSlug?: string } = {}) {
  const runtime = await createSessionInterruptionRuntime(ctx, dryRun, options);
  const result = { checked: 0, attempted: [] as string[], restored: [] as string[], held: {} as Record<string, string> };
  for (const candidate of await runtime.list()) {
    result.checked += 1;
    const decision = classifySessionInterruption(candidate, Date.now());
    if (decision.action === 'hold') { result.held[candidate.ownerId] = decision.reason; continue; }
    if (dryRun || result.attempted.length >= 5) continue;
    const { enqueueSessionInterruption } = await import('../../dbos/session-interruption-workflow');
    await enqueueSessionInterruption({ workspaceId: ctx.workspaceId, installSlug: ctx.installSlug,
      ownerId: candidate.ownerId, key: sessionRecoveryKey(candidate.interruption!) });
    result.attempted.push(candidate.ownerId);
  }
  return { ...result, protectedOwnerIds: [...runtime.protectedOwnerIds] };
}
