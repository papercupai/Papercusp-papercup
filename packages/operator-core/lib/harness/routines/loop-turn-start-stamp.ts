/**
 * loop-turn-start-stamp.ts — the real-time "this loop fire became a turn" signal
 * (EI-24791346664119438).
 *
 * `reconcile-loop-routines` decides whether a delivered loop wake produced a
 * loop turn from `session_turns`, which is INGESTED from transcripts after the
 * turn. Measured 2026-10-02 over 24h: 64 of 334 'delivered-wake-no-loop-turn'
 * settles were real loop turns (loop-fire prompt ~70s after the fire, mean turn
 * 329s) whose rows were ingested 500-600s after the reconciler had already
 * scored the fire an error. Presence could not rescue them: 1 of 64 had any
 * activity in the 60s before the settle (a long silent Bash or text generation
 * is quiet), and the Stop-hook journal only lands at turn END.
 *
 * The turn-start endpoint receives every UserPromptSubmit in real time,
 * including the prompt head that carries the `⟦turn-origin:loop-fire …⟧`
 * envelope. When it does, this module appends one `kind:'lifecycle'` activity
 * row with LOOP_TURN_START_MARKER, which the reconciler reads as
 * `loop_turn_started_at`. Reuses the existing agent_activity store and its
 * TelemetryStore seam: no new table, no migration.
 *
 * Fail-silent by contract: it runs inside the turn-start hook request, whose
 * whole rule is that it must never cost the agent's turn.
 */
import type { ActivityRecord, TelemetryStore } from '@papercusp/activity-bridge';
import type { Sql } from 'postgres';
import { isAbsolute } from 'node:path';
import { activeWorkspaceId } from '../../workspace-registry';
import { LOOP_TURN_START_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { classify, parseEnvelope, readLedgerRows, type LedgerRow } from '../../turn-provenance/turn-provenance';

export interface LoopFireIdentity {
  routineId: string;
  wakeCount: number;
}

/** True when the prompt OPENS with a loop-fire turn-origin envelope. Uses the one
 *  shared envelope grammar (`parseEnvelope`), so an envelope quoted mid-text, or
 *  any other origin, never stamps. */
export function isLoopFirePrompt(prompt: string): boolean {
  return parseEnvelope(prompt ?? '')?.origin === 'loop-fire';
}

export interface LoopTurnStartInput {
  owner: string;
  prompt: string;
  workspaceId: string;
  cwd?: string | null;
  client?: string | null;
  /** Opaque hook request id for joining this marker to its turn-start receipt. */
  turnStartRequestId?: string | null;
  /** Resolved identity; the async recorder binds production lookups to the launch ledger. */
  loopFire?: LoopFireIdentity | null;
}

/** Resolve the typed loop identity enrolled alongside the prompt's provenance nonce.
 *  A missing/expired/malformed row is deliberately unknown: reconciliation keeps its
 *  bounded legacy retry path instead of guessing from wake text or timestamps. */
export function resolveLoopFireIdentity(
  owner: string, prompt: string, dir: string, nowMs = Date.now(),
): LoopFireIdentity | null {
  const envelope = parseEnvelope(prompt ?? '');
  if (!envelope || !['loop-fire', 'self-compaction'].includes(envelope.origin)) return null;
  const row = readLedgerRows(owner, { includeExpired: false, dir, nowMs })
    .find((candidate) => candidate.nonce === envelope.nonce);
  if (!row || row.sid !== owner || row.origin !== envelope.origin || !Number.isFinite(row.ts) || row.ts > nowMs ||
      typeof row.loopFire?.routineId !== 'string' || !row.loopFire.routineId.trim() ||
      !Number.isInteger(row.loopFire.wakeCount) || row.loopFire.wakeCount <= 0) return null;
  return {
    routineId: row.loopFire.routineId,
    wakeCount: row.loopFire.wakeCount,
  };
}

function isValidLoopFireIdentity(value: unknown): value is LoopFireIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LoopFireIdentity>;
  return typeof candidate.routineId === 'string' && candidate.routineId.trim().length > 0 &&
    typeof candidate.wakeCount === 'number' && Number.isInteger(candidate.wakeCount) && candidate.wakeCount > 0;
}

/** Read the authenticated loop identity for the exact latest prompt in a live
 *  session. This is used only before managed self-compaction: carrying an
 *  identity requires both the persisted prompt origin and its matching
 *  UserPromptSubmit start marker. Presence, active-loop state, and prompt prose
 *  alone never grant continuation lineage. */
export async function readLoopFireIdentityForCurrentTurn(
  input: { owner: string; sessionId: string; sourceKind: string },
  opts: { sql: Sql },
): Promise<LoopFireIdentity | null> {
  const owner = input.owner?.trim();
  if (!owner || !input.sessionId?.trim() || !input.sourceKind?.trim()) return null;
  try {
    const turns = await opts.sql<Array<{
      turn_idx: number;
      text: string;
      turn_origin: string | null;
      turn_origin_verdict: string | null;
    }>>`
      SELECT turn_idx, text, turn_origin, turn_origin_verdict
        FROM harness_shared.session_turns
       WHERE owner = ${owner}
         AND source_kind = ${input.sourceKind}
         AND session_id = ${input.sessionId}
         AND speaker = 'user'
       ORDER BY turn_idx DESC
       LIMIT 1`;
    const turn = turns[0];
    if (!turn || turn.turn_origin_verdict !== 'agent-injected') return null;
    const envelope = parseEnvelope(turn.text ?? '');
    if (!envelope || !['loop-fire', 'self-compaction'].includes(envelope.origin) ||
        turn.turn_origin !== envelope.origin) return null;

    const markers = await opts.sql<Array<{ detail: unknown }>>`
      SELECT detail
        FROM harness_shared.agent_activity
       WHERE owner_id = ${owner}
         AND kind = 'lifecycle'
         AND summary = ${LOOP_TURN_START_MARKER}
         AND detail->>'nonce' = ${envelope.nonce}
         AND detail->>'origin' = ${envelope.origin}
         AND detail->>'source' IN ('turn-start', 'session-ingest')
       ORDER BY created_at DESC
       LIMIT 5`;
    for (const marker of markers) {
      const detail = marker.detail && typeof marker.detail === 'object'
        ? marker.detail as Record<string, unknown>
        : null;
      if (!detail || detail.nonce !== envelope.nonce || detail.origin !== envelope.origin) continue;
      if (detail.source === 'session-ingest') {
        const indexedTurn = detail.indexedTurn && typeof detail.indexedTurn === 'object'
          ? detail.indexedTurn as Record<string, unknown>
          : null;
        if (indexedTurn?.sourceKind !== input.sourceKind ||
            indexedTurn.sessionId !== input.sessionId ||
            indexedTurn.turnIdx !== turn.turn_idx) continue;
      }
      if (isValidLoopFireIdentity(detail.loopFire)) return detail.loopFire;
    }
  } catch {
    // A missing or unreadable proof keeps the existing fail-closed behavior.
  }
  return null;
}

/** Build the activity row for a loop-fire turn start, or null when the prompt is
 *  not a loop-fire turn. Pure: the route test and the reconciler both rely on the
 *  summary being EXACTLY LOOP_TURN_START_MARKER. */
export function loopTurnStartRecord(input: LoopTurnStartInput): ActivityRecord | null {
  const owner = (input.owner ?? '').trim();
  const envelope = parseEnvelope(input.prompt);
  const loopFire = input.loopFire;
  const directLoopFire = envelope?.origin === 'loop-fire';
  const verifiedCompactionContinuation = envelope?.origin === 'self-compaction' &&
    isValidLoopFireIdentity(loopFire);
  if (!owner || (!directLoopFire && !verifiedCompactionContinuation)) return null;
  return {
    owner,
    agent: input.client || null,
    sessionId: null,
    scope: null,
    kind: 'lifecycle',
    toolName: null,
    phase: null,
    toolUseId: null,
    summary: LOOP_TURN_START_MARKER,
    status: null,
    detail: envelope
      ? {
          origin: envelope.origin,
          nonce: envelope.nonce,
          source: 'turn-start',
          ...(typeof input.turnStartRequestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(input.turnStartRequestId)
            ? { turnStartRequestId: input.turnStartRequestId }
            : {}),
          ...(loopFire ? { loopFire } : {}),
        }
      : null,
    cwd: input.cwd ?? null,
    workspaceId: input.workspaceId,
  };
}

/** Append the stamp when the prompt is a loop-fire turn. Never throws; returns
 *  whether a row was appended (for tests and diagnostics). */
export async function recordLoopTurnStart(
  input: LoopTurnStartInput,
  store?: Pick<TelemetryStore, 'append'>,
): Promise<boolean> {
  const owner = input.owner?.trim();
  const envelope = parseEnvelope(input.prompt);
  if (!owner || !envelope || !['loop-fire', 'self-compaction'].includes(envelope.origin)) return false;
  const submittedAt = Date.now();
  try {
    let loopFire = input.loopFire;
    // A continuation must always resolve from its own server-written ledger row;
    // a caller-supplied identity cannot upgrade a self-compaction prompt.
    if (loopFire === undefined || envelope.origin === 'self-compaction') {
      loopFire = null;
      try {
        const { readAdvSessionLaunchRecordByOwner } = await import('../../adv-sessions');
        const launch = await readAdvSessionLaunchRecordByOwner(owner, input.workspaceId);
        const spec = launch?.launchSpec && typeof launch.launchSpec === 'object'
          ? launch.launchSpec as Record<string, unknown> : null;
        // The hook and ingest host can serve several namespaces. Only a persisted
        // launch pin may select the live ledger; cwd and host env are not authority.
        if (launch?.workspaceId === input.workspaceId && spec?.workspaceId === input.workspaceId &&
            (!input.client || launch.agent === input.client) &&
            typeof spec.turnProvenanceDir === 'string' && isAbsolute(spec.turnProvenanceDir)) {
          loopFire = resolveLoopFireIdentity(owner, input.prompt, spec.turnProvenanceDir, submittedAt);
        }
      } catch {
        // An unavailable or legacy launch stays unknown, retaining only the generic stamp.
      }
    }
    const record = loopTurnStartRecord({ ...input, owner, loopFire });
    if (!record) return false;
    const target = store ?? (await import('../../activity-pg-store')).createPgTelemetryStore();
    await target.append(record);
    return true;
  } catch {
    return false;
  }
}

/** Only rows returned by the normal transcript INSERT may enter this producer. */
export interface IndexedNativeLoopTurn {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  turn_idx: number;
  ts: string | Date | null;
  owner: string | null;
  speaker: string;
  text: string;
  turn_origin?: string | null;
  harness_slug?: string | null;
  cwd?: string | null;
}

/** Validate enrollment at submission, rather than at this later ingest. The nonce
 * is authoritative; a transit-mangled payload is still admitted. Missing ledger
 * history stays unknown and never upgrades native owner-authentication evidence. */
export function indexedLoopTurnStartRecord(
  turn: IndexedNativeLoopTurn,
  ledgerRows?: LedgerRow[],
  target?: { dir: string; workspaceId: string },
): ActivityRecord | null {
  const owner = turn.owner?.trim();
  const submittedAt = turn.ts === null ? NaN : new Date(turn.ts).getTime();
  const envelope = parseEnvelope(turn.text);
  const supportedOrigin = (turn.turn_origin === 'loop-fire' && envelope?.origin === 'loop-fire') ||
    (turn.turn_origin === 'self-compaction' && envelope?.origin === 'self-compaction');
  if (!owner || turn.speaker !== 'user' || !supportedOrigin ||
      !['claude', 'codex', 'omp'].includes(turn.source_kind) ||
      !turn.workspace_id || !turn.session_id || !Number.isInteger(turn.turn_idx) || turn.turn_idx < 0 ||
      !Number.isFinite(submittedAt)) return null;
  // Native transcript rows use the corpus namespace 'default'; it is not the
  // target workspace. Explicit non-corpus namespaces must match the launch.
  if (target && turn.workspace_id !== 'default' && turn.workspace_id !== target.workspaceId) return null;
  const rows = ledgerRows ?? readLedgerRows(owner, { nowMs: submittedAt, dir: target?.dir });
  const enrollment = rows.find(row => row.nonce === envelope.nonce);
  if (!enrollment || enrollment.sid !== owner || enrollment.origin !== envelope.origin ||
      !Number.isFinite(enrollment.ts) || enrollment.ts > submittedAt ||
      typeof enrollment.loopFire?.routineId !== 'string' || !enrollment.loopFire.routineId.trim() ||
      !Number.isInteger(enrollment.loopFire.wakeCount) || enrollment.loopFire.wakeCount <= 0 ||
      classify(turn.text, [enrollment], { nowMs: submittedAt }).verdict !== 'verified-agent') return null;
  const record = loopTurnStartRecord({
    owner, workspaceId: turn.workspace_id, prompt: turn.text,
    client: turn.source_kind, cwd: turn.cwd, loopFire: enrollment.loopFire,
  });
  if (!record) return null;
  return {
    ...record,
    sessionId: turn.session_id,
    scope: turn.harness_slug ?? null,
    detail: {
      ...record.detail,
      source: 'session-ingest',
      ...(target ? { provenanceWorkspaceId: target.workspaceId } : {}),
      indexedTurn: {
        workspaceId: turn.workspace_id,
        sourceKind: turn.source_kind,
        sessionId: turn.session_id,
        turnIdx: turn.turn_idx,
      },
    },
  };
}

export interface IndexedLoopLaunchBinding {
  owner: string;
  workspace_id: string;
  agent: string;
  session_id: string | null;
  omp_thread_id: string | null;
  spec_workspace: string | null;
  provenance_dir: string | null;
}

/** An ADV launch receipt, never transcript cwd or the ingest host's environment,
 * selects the ledger. Missing/ambiguous legacy receipts remain unknown. */
export function indexedLoopLaunchBinding(
  turn: IndexedNativeLoopTurn,
  launches: IndexedLoopLaunchBinding[],
  workspaceId: string,
): { dir: string; workspaceId: string } | null {
  const matches = launches.filter(row => row.owner === turn.owner &&
    row.workspace_id === workspaceId && row.spec_workspace === workspaceId &&
    row.agent === turn.source_kind &&
    (row.agent === 'omp' ? row.omp_thread_id : row.session_id) === turn.session_id &&
    typeof row.provenance_dir === 'string' && isAbsolute(row.provenance_dir));
  if (matches.length !== 1) return null;
  return { dir: matches[0]!.provenance_dir!, workspaceId };
}

export async function recordIndexedLoopTurnStarts(sql: Sql, turns: IndexedNativeLoopTurn[]): Promise<void> {
  const candidates = turns.filter(turn => turn.owner && turn.speaker === 'user' &&
    ['loop-fire', 'self-compaction'].includes(turn.turn_origin ?? '') &&
    ['claude', 'codex', 'omp'].includes(turn.source_kind));
  if (!candidates.length) return;
  const workspaceId = activeWorkspaceId();
  const owners = [...new Set(candidates.map(turn => turn.owner!))];
  const sessions = [...new Set(candidates.map(turn => turn.session_id))];
  const launches = await sql<IndexedLoopLaunchBinding[]>`
    SELECT coord_owner_id AS owner, workspace_id, agent, session_id, omp_thread_id,
           launch_spec->>'workspaceId' AS spec_workspace,
           launch_spec->>'turnProvenanceDir' AS provenance_dir
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND coord_owner_id = ANY(${sql.array(owners)}::text[])
       AND (session_id = ANY(${sql.array(sessions)}::text[])
         OR omp_thread_id = ANY(${sql.array(sessions)}::text[]))
  `;
  const records = candidates.flatMap(turn => {
    const target = indexedLoopLaunchBinding(turn, launches, workspaceId);
    const record = target ? indexedLoopTurnStartRecord(turn, undefined, target) : null;
    return record ? [record] : [];
  });
  if (!records.length) return;
  const { createPgTelemetryStore } = await import('../../activity-pg-store');
  // Reuse the ingest client and its statement-timeout budget. In particular, do
  // not use the hook adapter's default global connection or backdate created_at.
  const store = createPgTelemetryStore(sql);
  for (const record of records) await store.append(record);
}
