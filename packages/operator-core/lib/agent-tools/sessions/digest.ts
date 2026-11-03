/**
 * sessions:digest — "what WAS this session?", as a first-class answer.
 *
 * EI-10888. This is the single most common operator question about the session
 * store and it had no verb. Answering it for ~30 agents during the 2026-07-13 audit
 * meant: sessions:list → then, per session, a sessions:read of the TAIL → then hope
 * the last assistant turn happened to be a wind-down summary → then hand-batch the
 * whole thing through code:run. Six-plus calls and a heuristic standing in for a
 * query.
 *
 * And the heuristic is wrong exactly where it matters. It returns nothing for any
 * session that crashed, stalled, hit an auth wall, or is still running — i.e. every
 * session you actually need to know about. The one session that mattered most in
 * that audit (a lane parked 5h on an owner decision) came back BLANK, and was
 * written up as "no closing summary recorded" — which was true, and useless.
 *
 * The digest reads BOTH ends instead of guessing from one:
 *   - the HEAD (turn 0…) — the kickoff prompt / launch context / loop goal. This is
 *     what the session was FOR, and it exists even when the session died young.
 *     (It was itself unreachable until EI-10887 added sessions:read { order:'asc' }.)
 *   - the TAIL — where it actually got to, plus the provider-error signature that
 *     says whether it FINISHED or was KILLED (EI-10889, classifySessionEnd).
 *
 * A session that never wrote a summary still yields a real answer: what it was
 * launched to do, and why it stopped.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { restrictedTurnSql } from '../../personal-vault/transcript-exclusion';
import {
  parseSessionSelector,
  sessionSearchEnabled,
  disabledResult,
  SESSION_SOURCE_KINDS,
  normalizeWindowBound,
} from './_shared';
import { classifySessionEnd, type SessionEndReason } from '../../search/session-end-reason';
import { classifyHistoricalSessionStop, HISTORICAL_STOP_KINDS, HISTORICAL_STOP_OPENING } from '../../search/session-end-reason';
import { classifyRecordedTurn } from '../../turn-provenance/turn-ref';
import { decodeSessionCursor, encodeSessionCursor, sessionCursorBoundsMatch, sessionCursorQueryFingerprint } from './cursor';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

/** Kickoff/closing excerpts are for ORIENTATION, not reading — keep them bounded so a
 *  100-session digest stays one affordable call rather than a transcript dump. */
const EXCERPT_MAX = 400;

/**
 * The caller's ownerId for the D-006 reader rule. A caller with no resolvable
 * identity is nobody: every restricted turn stays withheld (fail closed), and
 * the digest is still served rather than refused.
 */
function readerOwnerOf(ctx: PapercuspUnifiedToolContext): string | null {
  try {
    return resolveAgentIdentity(ctx).ownerId ?? null;
  } catch {
    return null;
  }
}

/**
 * The row shape the digest query returns.
 *
 * EI-10968: `ctx.tx<Array<{…}>>` used to be DECORATIVE here — this handler is
 * role-gated (`requirePrincipal: false`), so its `ctx` was inferred as bare
 * `UnifiedToolContext`, whose `tx?: any` has no generic to bind at all
 * (TypeScript silently discarded the `<…>` type argument and handed back
 * `any`). The handler below is now typed `ctx: PapercuspUnifiedToolContext`
 * (`_tool-context.ts`), which gives `tx` a real `Sql` type — `ctx.tx<DigestRow[]>`
 * genuinely binds `DigestRow[]` now, so this interface (and the `rows` const's
 * own annotation, kept for readability) is checked against the query, not just
 * decorative.
 */
interface DigestRow {
  source_kind: string;
  session_id: string;
  turns: number;
  prompt_count: number;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  first_ts: string | null;
  last_ts: string | null;
  last_ts_ms: string | null;
  tool_call_count: number | null;
  kickoff_text: string | null;
  closing_text: string | null;
  task_candidates: Array<{ turn_idx: number; text: string }> | null;
  closing_turn_idx: number | null;
  host_events: Array<{ id: string; kind: string; ts: string }> | null;
  stop_text: string | null;
  stop_turn_idx: number | null;
  stop_ts: string | null;
  total_matching: number;
}

function excerpt(text: string | null | undefined, max = EXCERPT_MAX): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * A wake-pump / loop-fire prompt states the loop's GOAL in its envelope — which is
 * the truest one-line answer to "what is this agent doing" for any looping session,
 * and far better than its first-ever prompt. Pull it out when present.
 */
function loopGoalOf(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ');
  const m = /(?:continuing your OWN warm session,?\s*(?:toward|MONITORING)[::]?\s*)(.+?)(?:\.\s|STATE:|Each wake|$)/i.exec(t);
  return m?.[1] ? excerpt(m[1], 240) : null;
}

/** Candidate selection does not assert that an unenrolled user turn was owner-authored. */
export function actionableTaskOf(candidates: Array<{ turn_idx: number; text: string }> | null | undefined) {
  return candidates?.find((turn) => {
    if (loopGoalOf(turn.text)) return true;
    const recorded = classifyRecordedTurn(turn.text);
    // A launch can carry real work; event wakes, carry notes and peer injections
    // are control traffic, even when their signed envelope is not in the
    // unenrolled-machine catalogue. This selects a candidate, not owner provenance.
    return recorded.verdict === 'owner-typed' || recorded.verdict === 'owner-dialog'
      || (recorded.verdict === 'agent-injected' && recorded.origin === 'fleet-kickoff');
  }) ?? null;
}

export default defineTool({
  name: 'sessions:digest',
  needsWorkspaceTx: true,
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'What a session WAS — kickoff intent (its opening turn / loop goal), where it got to (closing turn), and WHY it stopped ' +
    '(endedReason: settled | active | awaiting_owner | auth_wall | usage_limit | model_error | context_limit), with evidence. ' +
    'Recover what agents were working on before account limits: pass since/until and stopKinds for distinct quota, authentication, billing and temporary rate-limit incidents with as-of task/checkpoint refs. ' +
    'Pass `session` for one, or `since`/`owner` to digest a whole window at once. Replaces the sessions:list → per-session ' +
    'sessions:read(tail) → "hope the last turn was a summary" pattern, which returns NOTHING for exactly the sessions that ' +
    'matter (crashed, wedged, still running).',
  guidance: {
    when:
      '"What were all these agents doing?", "what was session X?", triaging a window of sessions, or finding WEDGED sessions ' +
      '(endedReason auth_wall/model_error/context_limit ⇒ wedged:true — the agent is not going to recover on its own).',
    notWhen:
      'Reading actual transcript content — sessions:read. Searching for a phrase across sessions — sessions:search. ' +
      'Just enumerating sessions + counts — sessions:list.',
    chaining: 'sessions:digest { since } → pick the wedged/interesting ones → sessions:read { session } for the full turns.',
    returns:
      '{ ok, count, total, hasMore, wedged (how many are STUCK), digests: [{ source_kind, session_id, owner, harness_slug, cwd, ' +
      'first_ts, last_ts, turns, prompt_count, tool_call_count, kickoff (opening turn excerpt), loopGoal (if a looping session), ' +
      'closing (last assistant turn excerpt), endedReason, endedEvidence, wedged }] }. Timestamps are ISO-8601 with an offset.',
    seeAlso: ['sessions:list', 'sessions:read', 'sessions:search', 'coord:walls'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: z.object({
    session: z.string().max(200).optional().describe("One session id, '<source-kind>:<session-id>', or 'self'. Omit to digest a window (see since/owner)."),
    owner: z.string().max(120).optional().describe("Filter to one agent ownerId ('self' = the caller)."),
    source_kind: z.enum(SESSION_SOURCE_KINDS).optional(),
    cwd_contains: z.string().max(200).optional().describe('Substring match on the session cwd.'),
    since: z
      .string()
      .max(40)
      .optional()
      .describe('Only sessions active after this timestamp. Accepts ISO-8601 OR a relative window measured back from now, like "45m", "12h", "7d".'),
    until: z.string().max(40).optional().describe('Inclusive historical cutoff. All task/closing evidence is read as of this instant; defaults to a frozen now across pages.'),
    cursor: z.string().min(1).max(512).optional().describe('nextCursor from this digest with the same filters. At most 500 candidates per bounded census; narrow the time window for more.'),
    taskMode: z.enum(['kickoff', 'as-of']).optional().describe('as-of selects the latest actionable task before until, plus the last transcript checkpoint. Never reads the current mutable agent brief.'),
    endedReasons: z.array(z.enum(['auth_wall', 'usage_limit', 'model_error', 'context_limit', 'active', 'awaiting_owner', 'settled', 'unknown'])).max(8).optional().describe('Filter each scanned page by the observed closing classification. total counts candidate sessions, not matching stops.'),
    includeHostEvents: z.boolean().optional().describe('Include up to 3 directly recorded quota/capacity host events for each transcript owner within the frozen window; missing host evidence remains unknown.'),
    stopKinds: z.array(z.enum(HISTORICAL_STOP_KINDS)).min(1).max(7).optional().describe('Historical recovery: page provider-shaped incidents, selecting task/checkpoint BEFORE each stop. Distinguishes quota, authentication, billing, rate_limit, capacity, model_error and context_limit. Filters scanned pages; continue nextCursor even on empty pages.'),
    wedgedOnly: z.boolean().optional().describe('Only sessions that are STUCK (auth_wall / model_error / context_limit).'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
  }),
  result: z
    .object({
      ok: z.boolean().optional(),
      count: z.number().int().nonnegative().optional(),
      total: z.number().int().nonnegative().optional(),
      hasMore: z.boolean().optional(),
      wedged: z.number().int().nonnegative().optional(),
      alert: z.string().optional(),
      note: z.string().optional(),
      digests: z.array(z.unknown()).optional(),
    })
    .passthrough(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    // EI-22763677566038732: relative windows are documented for sessions:*;
    // resolve them before PostgreSQL sees the ::timestamptz bind. Invalid input
    // gets a useful contract error instead of a raw handler_error from PG.
    const sinceNorm = normalizeWindowBound(args.since, 'since');
    if (sinceNorm.error) {
      return { data: { ok: false, error: sinceNorm.error } };
    }
    args.since = sinceNorm.iso;
    const untilNorm = normalizeWindowBound(args.until, 'until');
    if (untilNorm.error) return { data: { ok: false, error: untilNorm.error } };
    // Non-null: `tx` is optional on PapercuspUnifiedToolContext (must match the
    // framework's own optional `ctx.tx` for defineTool's overload resolution to
    // accept this handler — see _tool-context.ts) but is always bound for an
    // authenticated tool call. Destructured once so ctx.tx<T> below is actually
    // typed instead of a decorative type argument on `any` (EI-10968).
    const tx = ctx.tx!;
    const workspaceId = ctx.workspaceId ?? '';
    const limit = args.limit ?? 30;

    let sessionFilter: string | null = args.session ?? null;
    let sourceKind = args.source_kind;
    if (sessionFilter && sessionFilter !== 'self') {
      const selector = parseSessionSelector(sessionFilter, sourceKind);
      sessionFilter = selector.sessionId;
      sourceKind = selector.sourceKind;
    }
    if (args.session === 'self') {
      const { resolveSelfSession } = await import('../../search/self-session');
      const self = await resolveSelfSession(resolveAgentIdentity(ctx).ownerId ?? '');
      sessionFilter = self?.sessionId ?? null;
    }
    const owner = args.owner === 'self' ? (resolveAgentIdentity(ctx).ownerId ?? '') : (args.owner ?? null);
    const fingerprint = sessionCursorQueryFingerprint({ ...args, session: sessionFilter, owner }, {
      workspaceId, selfOwnerId: readerOwnerOf(ctx) ?? undefined,
    });
    const cursor = decodeSessionCursor(args.cursor, 'sessions:digest', fingerprint);
    if (!cursor.ok) return { data: cursor };
    if (args.cursor && !sessionCursorBoundsMatch({ since: sinceNorm.iso, until: untilNorm.iso }, cursor.bounds)) {
      return { data: { ok: false, error: 'invalid_cursor', message: 'Window differs from the cursor snapshot.' } };
    }
    const since = cursor.bounds.since ?? sinceNorm.iso;
    // Keep the database clock's microseconds. Bind timestamp strings through
    // text below: postgres.js serializes a timestamptz parameter through Date,
    // truncating it to milliseconds and hiding rows ingested within that ms.
    const snapshotAt = cursor.bounds.snapshotAt ?? (await tx<{ snapshot_at: string }[]>`
      SELECT to_json(clock_timestamp()) #>> '{}' AS snapshot_at`)[0]!.snapshot_at;
    const until = cursor.bounds.until ?? untilNorm.iso ?? snapshotAt;
    if (since && Date.parse(since) > Date.parse(until)) return { data: { ok: false, error: 'invalid_window' } };
    if (cursor.offset >= 500) return { data: { ok: false, error: 'census_limit', message: 'Narrow since/until to continue beyond 500 candidates.' } };
    const pageLimit = Math.min(limit, 500 - cursor.offset);

    // One pass: per-session aggregates + the FIRST user turn (the kickoff — what the
    // session was for) + the LAST assistant turn (where it got to / how it died).
    //
    // `session_turns.text` is wide/TOASTed. Keep the shared CTE narrow so its three
    // consumers do not materialize every matching transcript body. The endpoint
    // selectors run only for the result window, retain the table's full primary
    // key, then fetch `text` only for those winning kickoff/closing rows. DISTINCT
    // ON still gives both ends without a second round-trip per session, which is
    // the whole point: the old pattern cost one read PER SESSION.
    const rows: DigestRow[] = await tx<DigestRow[]>`
      WITH scoped AS (
        SELECT workspace_id, source_kind, session_id, turn_idx, speaker,
               ts, ingested_at, owner, harness_slug, cwd
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
           AND (${sessionFilter}::text IS NULL OR session_id = ${sessionFilter})
           AND (${owner}::text IS NULL OR owner = ${owner})
           AND (${sourceKind ?? null}::text IS NULL OR source_kind = ${sourceKind ?? null})
           AND (${args.cwd_contains ?? null}::text IS NULL OR cwd ILIKE '%' || ${args.cwd_contains ?? null} || '%')
           AND (${since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${since ?? null}::timestamptz)
           AND COALESCE(ts, ingested_at) <= ${until}::text::timestamptz
           AND ingested_at <= ${snapshotAt}::text::timestamptz
           -- D-006 reader rule (WI-10005570): another agent's disclosure-window turns never reach a digest.
           AND NOT ${restrictedTurnSql(tx as unknown as Parameters<typeof restrictedTurnSql>[0], 'session_turns', [readerOwnerOf(ctx)]) as never}
      ),
      agg AS (
        SELECT source_kind, session_id, count(*)::int AS turns,
               count(*) FILTER (WHERE speaker = 'user')::int AS prompt_count,
               max(owner) AS owner, max(harness_slug) AS harness_slug, max(cwd) AS cwd,
               min(ts) AS first_ts_raw, max(ts) AS last_ts_raw
          FROM scoped
         GROUP BY source_kind, session_id
      ),
      candidates AS (
        SELECT a.*, t.workspace_id AS stop_workspace, t.turn_idx AS stop_turn_idx,
               COALESCE(t.ts, t.ingested_at) AS stop_ts
          FROM agg a JOIN scoped key USING (source_kind, session_id)
          JOIN harness_shared.session_turns t
            ON t.workspace_id = key.workspace_id AND t.source_kind = key.source_kind
           AND t.session_id = key.session_id AND t.turn_idx = key.turn_idx
         WHERE ${!!args.stopKinds?.length} AND key.speaker = 'assistant'
           AND left(t.text, 700) ~* ${HISTORICAL_STOP_OPENING.source}
        UNION ALL
        SELECT a.*, NULL::text AS stop_workspace, NULL::integer AS stop_turn_idx,
               NULL::timestamptz AS stop_ts FROM agg a WHERE ${!args.stopKinds?.length}
      ),
      selected AS (
        SELECT candidates.*, count(*) OVER ()::int AS total_matching
          FROM candidates
         ORDER BY COALESCE(stop_ts, last_ts_raw) DESC NULLS LAST, source_kind, session_id, stop_turn_idx DESC NULLS LAST
         LIMIT ${pageLimit} OFFSET ${cursor.offset}
      ),
      incidents AS (
        SELECT a.*, incident.text AS stop_text
          FROM selected a
          LEFT JOIN harness_shared.session_turns incident
            ON incident.workspace_id = a.stop_workspace AND incident.source_kind = a.source_kind
           AND incident.session_id = a.session_id AND incident.turn_idx = a.stop_turn_idx
      ),
      kickoff_key AS (
        SELECT DISTINCT ON (t.source_kind, t.session_id)
               t.workspace_id, t.source_kind, t.session_id, t.turn_idx
          FROM scoped t
          JOIN incidents a
            ON a.source_kind = t.source_kind
           AND a.session_id = t.session_id
         WHERE t.speaker = 'user'
         ORDER BY t.source_kind, t.session_id, t.turn_idx ASC
      ),
      closing_key AS (
        SELECT DISTINCT ON (t.source_kind, t.session_id, a.stop_turn_idx)
               t.workspace_id, t.source_kind, t.session_id, t.turn_idx, a.stop_turn_idx AS incident_turn_idx
          FROM scoped t
          JOIN incidents a
            ON a.source_kind = t.source_kind
           AND a.session_id = t.session_id
         WHERE t.speaker = 'assistant'
           AND (a.stop_turn_idx IS NULL OR t.turn_idx < a.stop_turn_idx)
         ORDER BY t.source_kind, t.session_id, a.stop_turn_idx DESC NULLS LAST, t.turn_idx DESC
      ),
      state_agg AS (
        SELECT source_kind, session_id, sum(tool_call_count)::int AS tool_call_count
          FROM harness_shared.session_ingest_state
         WHERE session_id IS NOT NULL
         GROUP BY source_kind, session_id
      )
      SELECT a.source_kind, a.session_id, a.turns, a.prompt_count,
             a.owner, a.harness_slug, a.cwd,
             to_json(a.first_ts_raw) #>> '{}' AS first_ts,
             to_json(a.last_ts_raw)  #>> '{}' AS last_ts,
             (extract(epoch from a.last_ts_raw) * 1000)::bigint::text AS last_ts_ms,
             s.tool_call_count,
             kt.text AS kickoff_text,
             ct.text AS closing_text,
             c.turn_idx AS closing_turn_idx,
             tasks.candidates AS task_candidates,
             hosts.events AS host_events,
             a.stop_text, a.stop_turn_idx, to_json(a.stop_ts) #>> '{}' AS stop_ts,
             a.total_matching
        FROM incidents a
        LEFT JOIN kickoff_key k
          ON k.source_kind = a.source_kind
         AND k.session_id = a.session_id
        LEFT JOIN closing_key c
          ON c.source_kind = a.source_kind
         AND c.session_id = a.session_id
         AND c.incident_turn_idx IS NOT DISTINCT FROM a.stop_turn_idx
        LEFT JOIN harness_shared.session_turns kt
          ON kt.workspace_id = k.workspace_id
         AND kt.source_kind = k.source_kind
         AND kt.session_id = k.session_id
         AND kt.turn_idx = k.turn_idx
         AND (kt.workspace_id = ${workspaceId} OR kt.workspace_id = 'default')
        LEFT JOIN harness_shared.session_turns ct
          ON ct.workspace_id = c.workspace_id
         AND ct.source_kind = c.source_kind
         AND ct.session_id = c.session_id
         AND ct.turn_idx = c.turn_idx
         AND (ct.workspace_id = ${workspaceId} OR ct.workspace_id = 'default')
        LEFT JOIN state_agg s
          ON s.source_kind = a.source_kind
         AND s.session_id = a.session_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('turn_idx', candidate.turn_idx, 'text', candidate.text)
                           ORDER BY candidate.turn_idx) AS candidates
            FROM (
              SELECT t.turn_idx, left(t.text, 4000) AS text
                FROM harness_shared.session_turns t
               WHERE t.source_kind = a.source_kind AND t.session_id = a.session_id
                 AND (t.workspace_id = ${workspaceId} OR t.workspace_id = 'default')
                 AND t.speaker = 'user'
                 AND COALESCE(t.ts, t.ingested_at) <= ${until}::text::timestamptz
                 AND t.ingested_at <= ${snapshotAt}::text::timestamptz
                 AND (a.stop_turn_idx IS NULL OR t.turn_idx < a.stop_turn_idx)
                 AND NOT ${restrictedTurnSql(tx as unknown as Parameters<typeof restrictedTurnSql>[0], 't', [readerOwnerOf(ctx)]) as never}
               ORDER BY CASE WHEN ${args.taskMode === 'as-of' || !!args.stopKinds?.length} THEN -t.turn_idx ELSE t.turn_idx END
               LIMIT 16
            ) candidate
        ) tasks ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('id', event.id::text, 'kind', event.kind, 'ts', event.ts)
                           ORDER BY event.ts DESC, event.id DESC) AS events
            FROM (
              SELECT id, kind, ts FROM harness_shared.psu_pty_host_events
               WHERE ${args.includeHostEvents === true} AND workspace_id = ${workspaceId} AND owner_id = a.owner
                 AND ts <= COALESCE(a.stop_ts, ${until}::text::timestamptz)
                 AND (${since ?? null}::timestamptz IS NULL OR ts >= ${since ?? null}::timestamptz)
                 AND kind IN ('launch-kickoff-quota-rejected', 'launch-kickoff-model-capacity-rejected',
                              'turn-deferred-quota-blocked', 'quota-block-starvation')
               ORDER BY ts DESC, id DESC LIMIT 3
            ) event
        ) hosts ON true
       ORDER BY COALESCE(a.stop_ts, a.last_ts_raw) DESC NULLS LAST, a.source_kind, a.session_id, a.stop_turn_idx DESC NULLS LAST
    `;

    const total = rows[0]?.total_matching ?? 0;

    let digests = rows.map((r) => {
      const historical = args.taskMode === 'as-of' || !!args.stopKinds?.length;
      const candidates = historical ? [...(r.task_candidates ?? [])].reverse() : r.task_candidates;
      const task = actionableTaskOf(candidates);
      const lastMs = r.last_ts_ms ? Number(r.last_ts_ms) : null;
      const cls = classifySessionEnd({
        lastAssistantText: r.closing_text,
        lastTsMs: lastMs,
        nowMs: Date.parse(until),
      });
      return {
        source_kind: r.source_kind,
        session_id: r.session_id,
        owner: r.owner,
        harness_slug: r.harness_slug,
        cwd: r.cwd,
        first_ts: r.first_ts,
        last_ts: r.last_ts,
        turns: r.turns,
        prompt_count: r.prompt_count,
        tool_call_count: r.tool_call_count,
        toolCallCountCoverage: 'current-ingest-total; not an as-of counter',
        // What it was FOR. A looping session states its goal in the wake envelope —
        // strictly better than its first-ever prompt — so prefer that when present.
        kickoff: task ? excerpt(loopGoalOf(task.text) ?? task.text) : null,
        kickoffRef: task ? `session_turn:${r.source_kind}:${r.session_id}:${task.turn_idx}` : null,
        kickoffProvenance: task ? (loopGoalOf(task.text) ? 'autonomous-goal' : 'transcript-candidate') : 'unknown',
        bootstrap: excerpt(r.kickoff_text),
        taskCoverage: { candidateLimit: 16, status: task ? 'found' : 'unknown' },
        taskMode: historical ? 'as-of' : 'kickoff',
        asOf: r.stop_ts ?? until,
        stopKind: classifyHistoricalSessionStop(r.stop_text),
        stopEvidence: excerpt(r.stop_text),
        stopRef: r.stop_turn_idx == null ? null : `session_turn:${r.source_kind}:${r.session_id}:${r.stop_turn_idx}`,
        stopProvenance: r.stop_turn_idx == null ? 'unknown' : 'provider-shaped-transcript; verify source',
        checkpoint: excerpt(r.closing_text),
        checkpointRef: r.closing_turn_idx == null ? null : `session_turn:${r.source_kind}:${r.session_id}:${r.closing_turn_idx}`,
        checkpointProvenance: r.closing_turn_idx == null ? 'unknown' : 'transcript-assistant',
        hostEvidence: (r.host_events ?? []).map(event => ({ ...event, ref: `psu_pty_host_event:${event.id}` })),
        hostCoverage: args.includeHostEvents ? 'bounded-owner-events; native-session correlation unproven' : 'not-requested',
        loopGoal: loopGoalOf(task?.text ?? r.kickoff_text),
        // Where it got to. May legitimately be null (crashed before speaking) —
        // which is WHY kickoff/endedReason carry the answer instead.
        closing: excerpt(r.closing_text),
        endedReason: cls.reason as SessionEndReason,
        endedEvidence: cls.evidence,
        wedged: cls.wedged,
      };
    });

    if (args.wedgedOnly) digests = digests.filter((d) => d.wedged);
    if (args.endedReasons?.length) digests = digests.filter(d => args.endedReasons!.includes(d.endedReason));
    if (args.stopKinds?.length) digests = digests.filter(d => d.stopKind != null && args.stopKinds!.includes(d.stopKind));
    const wedged = digests.filter((d) => d.wedged).length;
    const scannedThrough = cursor.offset + rows.length;
    const hasMore = total > scannedThrough;
    const nextCursor = hasMore && scannedThrough < 500
      ? encodeSessionCursor('sessions:digest', scannedThrough, fingerprint, { since, until, snapshotAt }) : null;

    // { data } envelope (NOT hand-rolled inline JSON): the framework compact-encodes
    // the digests array for the agent transport, and the tool-data-shape ratchet holds.
    return {
      data: {
        ok: true,
        count: digests.length,
        total,
        hasMore,
        nextCursor,
        coverage: { candidateSessions: args.stopKinds?.length ? null : total,
          candidateIncidents: args.stopKinds?.length ? total : null, pageScanned: rows.length, scannedThrough, censusLimit: 500,
          status: hasMore ? (nextCursor ? 'more-pages' : 'window-limit; narrow since/until') : 'complete-for-indexed-transcript-window',
          hostOnlyOwners: 'not-covered', since: since ?? null, until, snapshotAt },
        wedged,
        ...(wedged > 0
          ? {
              alert:
                `${wedged} session(s) are WEDGED (auth_wall / model_error / context_limit) — they are not doing anything ` +
                'and will not recover on their own. See endedReason + endedEvidence on each.',
            }
          : {}),
        note:
          'kickoff = the first actionable task among up to 16 user turns, excluding maintained machine/bootstrap surfaces; ' +
          'kickoffRef links its source and kickoffProvenance does not claim proven owner authorship. bootstrap preserves the original opening turn. ' +
          'stopKinds pages provider-shaped incidents, selects the task/checkpoint before each and returns distinct stopKind/stopRef evidence. ' +
          'Continue nextCursor even when a filtered page is empty. Census is bounded to 500 candidates; narrow since/until beyond that. ' +
          'Host evidence is owner-correlated, not proof of a native-session match; host-only owners are outside this transcript census. ' +
          'Without stopKinds, closing = the last assistant turn as of until; endedReason is the legacy closing classifier. No mutable present-day brief is used.',
        digests,
      },
    };
  },
});
