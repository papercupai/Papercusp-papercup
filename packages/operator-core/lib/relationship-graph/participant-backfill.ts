/**
 * Participant backfill (crm-agent-sales-onboarding-apps-2026-10-06 P-003, D-017 point 2): projects
 * the participants of interactions ALREADY stored in an owner's Personal Vault into the
 * relationship graph, through the same participant chain live delivery uses.
 *
 * Live delivery only sees interactions as they arrive, so a source that gained its
 * `person -> record` grant after its mail was imported would otherwise never contribute those
 * people. App contact tables (Email's sender-derived contacts) are re-derived this way instead
 * of being copied: they were a projection of the same senders.
 *
 * Reads go through D-014's metadata path (readTeamInteractions): participant addresses only, never
 * subjects or bodies. Each source's grant is re-checked by createParticipantChain; a source without
 * it is reported as ungranted and contributes nothing.
 */
import type { Sql } from 'postgres';
import { isCodingAgentRole } from '../personal-vault/coding-roles';
import { readTeamInteractions } from '../personal-vault/team-disclosure';
import type { PersonalToolContext } from '../personal-vault/types';
import type { CanonicalExternalEvent } from '../external-triggers/ingestion';
import type { ExternalTriggerSink } from '../external-triggers/ingestion';
import { createDatatypeDestinationSinks } from '../data-sources/datatype-destination-sink';
import { createRelationshipGraphSink } from './graph-sink';
import { participantOf, type IdentityKey, type InteractionParticipant } from './identity-keys';
import { createParticipantChain, INTERACTION_DATATYPES, isInteractionDatatype, type ParticipantSinkDeps } from './participants';

/**
 * Where a backfill stopped: the last stored document processed, in (kind, id) order within one
 * source. Persisted as data_sources.participant_backfill_cursor (migration 1415, WI-10006999).
 */
export interface ParticipantBackfillCursor {
  kind: string;
  afterId: string;
}

export interface ParticipantBackfillInput {
  /** Aggregate durations only: never document content or participant identities. */
  timings?: Record<string, { calls: number; ms: number }>;
  workspaceId: string;
  /** The Vault owner whose stored interactions are read. */
  userId: string;
  /** The reader context; coding/review roles are refused by readTeamInteractions. */
  ctx: PersonalToolContext;
  /** Restrict to these data sources; default every source holding interactions. */
  sourceIds?: readonly string[];
  batchSize?: number;
  /**
   * Continue after this document instead of from the beginning. Meaningful for a single-source run
   * (runPendingParticipantBackfills); applied to every source otherwise.
   */
  resumeFrom?: ParticipantBackfillCursor | null;
  /**
   * Stop once this epoch-ms time has passed, after the document in hand. The run then returns
   * `complete: false` with the cursor to resume from. Unbounded when omitted.
   */
  deadlineMs?: number;
  /** Called with the new cursor after every page, so progress survives a crash or restart. */
  onProgress?: (sourceId: string, cursor: ParticipantBackfillCursor) => Promise<void>;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface ParticipantBackfillSourceResult {
  sourceId: string;
  datatype: string;
  granted: boolean;
  documents: number;
  participants: number;
}

export type ParticipantBackfillResult =
  | {
      ok: true;
      sources: ParticipantBackfillSourceResult[];
      documents: number;
      participants: number;
      /** False when the deadline stopped the run; `cursor` is then where to resume. */
      complete: boolean;
      cursor: (ParticipantBackfillCursor & { sourceId: string }) | null;
    }
  | { ok: false; reason: 'coding_agent_denied' | 'vault_disabled'; sources: ParticipantBackfillSourceResult[] };

/** A persisted cursor, or null when the stored value is absent or not cursor-shaped. */
export function parseParticipantBackfillCursor(value: unknown): ParticipantBackfillCursor | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, afterId } = value as Record<string, unknown>;
  return typeof kind === 'string' && typeof afterId === 'string' && kind && afterId ? { kind, afterId } : null;
}

/** The interaction datatype a source delivers: the interaction key of its destination policy. */
export function interactionDatatypeOfPolicy(policy: Record<string, unknown> | null | undefined): string | null {
  return Object.keys(policy ?? {}).sort().find((datatype) => isInteractionDatatype(datatype)) ?? null;
}

/** Participants of one stored interaction from its team metadata (addresses only), keyed and deduped. */
export function participantsFromAddresses(addresses: readonly string[]): InteractionParticipant[] {
  const byKey = new Map<IdentityKey, InteractionParticipant>();
  for (const address of addresses) {
    const participant = participantOf(address);
    if (participant && !byKey.has(participant.key)) byKey.set(participant.key, participant);
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function backfillInteractionParticipants(
  sql: Sql,
  input: ParticipantBackfillInput,
  deps: ParticipantSinkDeps = {},
): Promise<ParticipantBackfillResult> {
  // D-001 fence up front: the refusal must not depend on whether a granted source has documents.
  if (isCodingAgentRole(input.ctx.role)) return { ok: false, reason: 'coding_agent_denied', sources: [] };
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 500, 2000));
  const now = input.now ?? Date.now;
  const resume = input.resumeFrom ?? null;
  const measure = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await operation(); }
    finally {
      if (input.timings) {
        const timing = input.timings[stage] ??= { calls: 0, ms: 0 };
        timing.calls += 1;
        timing.ms += performance.now() - start;
      }
    }
  };
  const measuredSink = (sink: ExternalTriggerSink): ExternalTriggerSink => ({
    ...sink,
    deliver: (...args) => measure(sink.kind, () => sink.deliver(...args)),
  });
  const measuredDeps: ParticipantSinkDeps = input.timings ? {
    ...deps,
    resolver: { ...deps.resolver, timings: input.timings },
    createPersonSinks: async (...args) => (await (deps.createPersonSinks ?? createDatatypeDestinationSinks)(...args)).map(measuredSink),
    createGraphSink: (...args) => measuredSink((deps.createGraphSink ?? createRelationshipGraphSink)(...args)),
  } : deps;
  const groupsStart = performance.now();
  const groups = await sql<Array<{ source_id: string; kind: string; source: string; policy: Record<string, unknown> | null }>>`
    SELECT d.source_id::text AS source_id, d.kind, min(d.source) AS source, s.destination_policy AS policy
      FROM harness_shared.personal_documents d
      JOIN harness_shared.data_sources s ON s.id::text = d.source_id::text
     WHERE d.workspace_id = ${input.workspaceId} AND d.user_id = ${input.userId}::uuid
       ${input.sourceIds?.length ? sql`AND d.source_id::text = ANY(${sql.array([...input.sourceIds])}::text[])` : sql``}
     GROUP BY d.source_id, d.kind, s.destination_policy
     ORDER BY d.source_id, d.kind COLLATE "C"`;
  if (input.timings) input.timings['source-groups'] = { calls: 1, ms: performance.now() - groupsStart };
  const sources: ParticipantBackfillSourceResult[] = [];
  const bySource = new Map<string, ParticipantBackfillSourceResult>();
  let documents = 0;
  let participants = 0;
  const stoppedAt = (sourceId: string, kind: string, afterId: string) => ({
    ok: true as const,
    sources,
    documents,
    participants,
    complete: false,
    cursor: { sourceId, kind, afterId },
  });
  for (const group of groups) {
    const datatype = interactionDatatypeOfPolicy(group.policy);
    if (!datatype) continue;
    // A source holding several kinds is one result row; its kinds are walked in (kind, id) order.
    let result = bySource.get(group.source_id);
    if (!result) {
      result = { sourceId: group.source_id, datatype, granted: false, documents: 0, participants: 0 };
      bySource.set(group.source_id, result);
      sources.push(result);
    }
    const chain = await measure('chain-build', () => createParticipantChain(sql, { workspaceId: input.workspaceId, sourceId: group.source_id, datatype }, measuredDeps));
    if (!chain) continue;
    result.granted = true;
    // Kinds finished before the cursor's kind are skipped; the cursor's kind resumes after afterId.
    // JS `<` is code-unit order, which is why the group query sorts kind COLLATE "C".
    if (resume && group.kind < resume.kind) continue;
    let afterId = resume && group.kind === resume.kind ? resume.afterId : '00000000-0000-0000-0000-000000000000';
    for (;;) {
      if (input.deadlineMs !== undefined && now() >= input.deadlineMs) return stoppedAt(group.source_id, group.kind, afterId);
      const page = await measure('document-page', () => sql<Array<{ id: string; external_id: string | null }>>`
        SELECT id::text AS id, external_id FROM harness_shared.personal_documents
         WHERE workspace_id = ${input.workspaceId} AND user_id = ${input.userId}::uuid
           AND source_id::text = ${group.source_id} AND kind = ${group.kind} AND id > ${afterId}::uuid
         ORDER BY personal_documents.id LIMIT ${batchSize}`);
      if (!page.length) break;
      const read = await measure('team-metadata', () => readTeamInteractions(sql, {
        ctx: input.ctx,
        workspaceId: input.workspaceId,
        userId: input.userId,
        documentIds: page.map((row) => row.id),
        agentOwnerId: null,
      }));
      if (!read.allowed) return { ok: false, reason: read.reason, sources };
      const views = new Map(read.interactions.map((view) => [view.metadata.documentId, view]));
      // Walk the page in id order so the cursor is exact: everything at or before it is done.
      for (const row of page) {
        const view = views.get(row.id);
        if (view) {
          const metadata = view.metadata;
          const found = participantsFromAddresses(metadata.participants);
          const externalId = row.external_id ?? row.id;
          const event: CanonicalExternalEvent = {
            key: `backfill:${group.source_id}:${externalId}`,
            workspaceId: input.workspaceId,
            sourceId: group.source_id,
            source: metadata.source ?? group.source,
            event: 'interaction-backfill',
            datatypeId: datatype,
            externalId,
            dedupeKey: `${group.source_id}:${datatype}:${externalId}`,
            occurredAt: metadata.occurredAt,
            payload: {},
          };
          await chain.deliverParticipants(event, found);
          result.documents += 1;
          result.participants += found.length;
          documents += 1;
          participants += found.length;
        }
        afterId = row.id;
        if (input.deadlineMs !== undefined && now() >= input.deadlineMs) {
          await input.onProgress?.(group.source_id, { kind: group.kind, afterId });
          return stoppedAt(group.source_id, group.kind, afterId);
        }
      }
      await input.onProgress?.(group.source_id, { kind: group.kind, afterId });
    }
  }
  return { ok: true, sources, documents, participants, complete: true, cursor: null };
}

/**
 * The principal the platform backfill reads under (D-018 point 1). A platform step, not an agent
 * identity, and deliberately NOT a coding role: readTeamInteractions' D-001 fence still applies to
 * every agent session, which is why an agent never runs this by hand.
 */
export const PARTICIPANT_BACKFILL_ROLE = 'relationship-graph';

export interface PendingParticipantBackfill {
  sourceId: string;
  /** `partial`: the tick's time budget ran out; the source stays pending and resumes next tick. */
  outcome: 'backfilled' | 'partial' | 'vault_disabled' | 'failed';
  /** Documents processed by THIS call (a resumed source counts only its new documents). */
  documents: number;
  participants: number;
  error?: string;
}

/**
 * Default wall-clock budget for one sweep. The sweep runs inside the system:connector-sync tick
 * (every minute, concurrency `skip`), so whatever it spends delays the next sync pass. 20 s keeps
 * the next pass on schedule; a large mailbox simply finishes over several ticks (WI-10006999).
 */
export const PARTICIPANT_BACKFILL_TICK_BUDGET_MS = 20_000;

/**
 * D-018: backfill every granted source of this workspace whose participant_backfill_at marker is
 * NULL (migration 1394 clears it when a source newly grants person -> record), then stamp it. Run by
 * the system:connector-sync routine each tick; independent of whether the source's own sync
 * succeeds, because the stored interactions it reads are already in the owner's Vault.
 *
 * Bounded per call by `budgetMs` (default PARTICIPANT_BACKFILL_TICK_BUDGET_MS) and `maxSources`.
 * Progress is saved in participant_backfill_cursor (migration 1415) after every page, so a source
 * cut off by the budget, a failure or a restart resumes where it stopped instead of starting over.
 * A source whose owner has the Vault disabled stays pending and is retried on a later tick; a
 * failure is reported and also stays pending.
 */
export async function runPendingParticipantBackfills(
  sql: Sql,
  input: { workspaceId: string; maxSources?: number; batchSize?: number; budgetMs?: number; now?: () => number },
  deps: ParticipantSinkDeps = {},
): Promise<PendingParticipantBackfill[]> {
  const now = input.now ?? Date.now;
  const deadlineMs = now() + Math.max(0, input.budgetMs ?? PARTICIPANT_BACKFILL_TICK_BUDGET_MS);
  const pending = await sql<Array<{ id: string; owner_user_id: string; cursor: unknown }>>`
    SELECT id::text AS id, owner_user_id::text AS owner_user_id, participant_backfill_cursor AS cursor
      FROM harness_shared.data_sources
     WHERE workspace_id = ${input.workspaceId}
       AND owner_user_id IS NOT NULL
       AND participant_backfill_at IS NULL
       AND coalesce(destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb
       AND destination_policy ?| ${sql.array([...INTERACTION_DATATYPES])}::text[]
     ORDER BY created_at, data_sources.id
     LIMIT ${Math.max(1, Math.min(input.maxSources ?? 4, 50))}`;
  const out: PendingParticipantBackfill[] = [];
  // Progress is written only while the source is still pending under a held grant, the same guard
  // as the completion stamp below.
  const saveCursor = async (sourceId: string, cursor: ParticipantBackfillCursor) => {
    await sql`
      UPDATE harness_shared.data_sources
         SET participant_backfill_cursor = ${sql.json({ kind: cursor.kind, afterId: cursor.afterId })}
       WHERE id = ${sourceId}::uuid
         AND participant_backfill_at IS NULL
         AND coalesce(destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb`;
  };
  for (const source of pending) {
    // The budget is per sweep, not per source: once spent, the rest wait for the next tick.
    if (now() >= deadlineMs) break;
    const timings: Record<string, { calls: number; ms: number }> = {};
    const start = performance.now();
    try {
      const result = await backfillInteractionParticipants(
        sql,
        {
          workspaceId: input.workspaceId,
          userId: source.owner_user_id,
          ctx: { workspaceId: input.workspaceId, role: PARTICIPANT_BACKFILL_ROLE },
          sourceIds: [source.id],
          batchSize: input.batchSize,
          resumeFrom: parseParticipantBackfillCursor(source.cursor),
          deadlineMs,
          now,
          onProgress: saveCursor,
          timings,
        },
        deps,
      );
      if (!result.ok) {
        // coding_agent_denied cannot happen under PARTICIPANT_BACKFILL_ROLE; vault_disabled is the
        // owner's choice and is re-checked on a later tick.
        out.push({ sourceId: source.id, outcome: result.reason === 'vault_disabled' ? 'vault_disabled' : 'failed', documents: 0, participants: 0, ...(result.reason === 'vault_disabled' ? {} : { error: result.reason }) });
        continue;
      }
      if (!result.complete) {
        if (result.cursor) await saveCursor(source.id, result.cursor);
        out.push({ sourceId: source.id, outcome: 'partial', documents: result.documents, participants: result.participants });
        continue;
      }
      // Stamp only while the grant still holds: a revocation during the run leaves it pending.
      await sql`
        UPDATE harness_shared.data_sources
           SET participant_backfill_at = now(), participant_backfill_cursor = NULL
         WHERE id = ${source.id}::uuid
           AND participant_backfill_at IS NULL
           AND coalesce(destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb`;
      out.push({ sourceId: source.id, outcome: 'backfilled', documents: result.documents, participants: result.participants });
    } catch (cause) {
      out.push({ sourceId: source.id, outcome: 'failed', documents: 0, participants: 0, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      console.info('PARTICIPANT_BACKFILL_STAGE_TIMINGS', JSON.stringify({ sourceId: source.id, totalMs: performance.now() - start, stages: timings }));
    }
  }
  return out;
}
