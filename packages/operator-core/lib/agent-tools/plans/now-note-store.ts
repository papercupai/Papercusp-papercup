/**
 * now-note-store.ts — derived-status-not-hand-written-2026-10-12 P-004
 * (decisions D-007 and D-008).
 *
 * A plan's Now note is stored as structured fields in
 * `harness_shared.harness_plans.now_note`, not as a `## Now` markdown section
 * rewritten into `content`:
 *
 *   { state, next, author, writtenAt, eventId, source }
 *
 * - `writtenAt` is the note's own clock. A newer `writtenAt` wins when a peer's
 *   note is applied (ties broken by `eventId`), so the note never depends on the
 *   row's federation clock.
 * - `eventId` is the msg_id of the plan's `now_updated` plan event: the note's
 *   position in the plan-event log.
 * - `now_state` / `now_next` remain the projection of the resolved note, so the
 *   list and index readers that already select them stay correct.
 *
 * Reading: the note wins. A plan whose `now_note` is NULL (never written through
 * plans:set-now since migration 1480) is read from its content `## Now` section,
 * so an existing Now is never lost; it migrates on read until the first set-now.
 */

import type { ParsedPlan, PlanNowBlock } from '@papercusp/plan-parser';

/**
 * Who wrote the note: 'set-now' = plans:set-now (or a server-side Now update);
 * 'content' = a content write that migrated (or deliberately edited) the
 * content `## Now` section into the note (`noteFromContentWrite`).
 */
export type PlanNowNoteSource = 'set-now' | 'content';

export interface PlanNowNote {
  state: string;
  next: string;
  /** The writer's owner id; null when it could not be resolved. */
  author: string | null;
  /** ISO-8601 time the note was written — the note's own last-writer-wins clock. */
  writtenAt: string;
  /**
   * msg_id of the `now_updated` plan event recorded with this note. plans:set-now
   * mints it before the locked write and emits the event with it after the
   * commit; that emit is best-effort, so in the rare case it fails the id names
   * no event. null only for a note written without an event.
   */
  eventId: string | null;
  /** The writer's optional why (plans:set-now `rationale`); null when none was given. */
  rationale: string | null;
  source: PlanNowNoteSource;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/**
 * Defensive decode of a stored or wire `now_note` value. Anything that is not a
 * well-formed note (missing fields, an unparseable `writtenAt`) decodes to null,
 * so a malformed peer value can never displace a real note or crash a reader.
 */
export function parseNowNote(raw: unknown): PlanNowNote | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.state !== 'string' || typeof r.next !== 'string') return null;
  if (typeof r.writtenAt !== 'string' || !Number.isFinite(Date.parse(r.writtenAt))) return null;
  if (!isStringOrNull(r.author ?? null) || !isStringOrNull(r.eventId ?? null)) return null;
  if (r.source !== 'set-now' && r.source !== 'content') return null;
  return {
    state: r.state,
    next: r.next,
    author: (r.author as string | null | undefined) ?? null,
    writtenAt: new Date(Date.parse(r.writtenAt)).toISOString(),
    eventId: (r.eventId as string | null | undefined) ?? null,
    // Optional on the wire: a note from a peer that predates the field reads as none.
    rationale: typeof r.rationale === 'string' ? r.rationale : null,
    source: r.source as PlanNowNoteSource,
  };
}

/**
 * Last-writer-wins for notes: true iff `incoming` should replace `existing`.
 * A later `writtenAt` wins; an equal one is broken by `eventId` (lexically), so
 * every peer converges on the same note whatever order the ops arrive in. An
 * equal note (same clock, same event) is not "newer", which keeps a replay or
 * an echo from rewriting the row.
 */
export function isNewerNowNote(incoming: PlanNowNote, existing: PlanNowNote | null): boolean {
  if (!existing) return true;
  const a = Date.parse(incoming.writtenAt);
  const b = Date.parse(existing.writtenAt);
  if (a !== b) return a > b;
  return (incoming.eventId ?? '') > (existing.eventId ?? '');
}

/** Render a note as the markdown body a content Now section would have held. */
export function renderNowNoteRaw(note: Pick<PlanNowNote, 'state' | 'next'>): string {
  return `**State:** ${note.state.trim()}\n\n**Next:** ${note.next.trim()}`;
}

/**
 * The plan's Now as readers see it: the stored note when there is one, else the
 * content `## Now` section (the pre-migration note, migrating on read).
 * `lineNumber` keeps the content section's line when one exists (0 otherwise);
 * it locates the frozen section, not the note.
 */
export function resolvePlanNow(
  note: PlanNowNote | null,
  contentNow: PlanNowBlock | null,
): PlanNowBlock | null {
  if (!note) return contentNow;
  return {
    state: note.state,
    next: note.next,
    raw: renderNowNoteRaw(note),
    lineNumber: contentNow?.lineNumber ?? 0,
  };
}

/**
 * Return `parsed` with `now` replaced by the resolved note. A copy, never an
 * in-place mutation, because parsed plans can be shared through caches.
 */
export function applyNowNoteToParsed<P extends Pick<ParsedPlan, 'now'>>(
  parsed: P,
  note: PlanNowNote | null,
): P {
  if (!note) return parsed;
  return { ...parsed, now: resolvePlanNow(note, parsed.now) };
}

/** Build the note plans:set-now writes. */
export function buildSetNowNote(input: {
  state: string;
  next: string;
  author: string | null;
  eventId: string | null;
  rationale?: string | null;
  writtenAt?: Date;
}): PlanNowNote {
  return {
    state: input.state.trim(),
    next: input.next.trim(),
    author: input.author,
    writtenAt: (input.writtenAt ?? new Date()).toISOString(),
    eventId: input.eventId,
    rationale: input.rationale?.trim() || null,
    source: 'set-now',
  };
}

/**
 * The note a content write stores (SPEC-P-004). A content write is where an
 * existing `## Now` section migrates into a stored note: migration 1480 does no
 * backfill, so every plan migrates the next time its content is written (that
 * UPDATE already recomputes the row, so the migration costs nothing extra).
 *
 * Returns the note to store, or null to leave `now_note` alone:
 * - null when the new content has no Now section, or one with neither a State
 *   nor a Next (a free-form section keeps the content fallback, raw text and all);
 * - the section as a note when the plan has no stored note yet (the migration);
 * - the section as a note when a note exists but the writer CHANGED the
 *   section's text, so a deliberate edit of `## Now` in content is adopted
 *   instead of being silently hidden behind the older note;
 * - null when the section is unchanged (a round-tripped content write carries the
 *   frozen legacy section back as it was) or already equals the stored note.
 *
 * State and Next are copied verbatim (trimmed, as plans:set-now trims), so the
 * stored note has the same text as the section it replaces.
 */
export function noteFromContentWrite(input: {
  existing: PlanNowNote | null;
  /** The section in the content before this write; null for a new plan. */
  priorSection: PlanNowBlock | null;
  /** The section in the content this write stores. */
  nextSection: PlanNowBlock | null;
  author: string | null;
  writtenAt?: Date;
}): PlanNowNote | null {
  const section = input.nextSection;
  if (!section) return null;
  const state = section.state.trim();
  const next = section.next.trim();
  if (!state && !next) return null;
  if (input.existing) {
    const prior = input.priorSection;
    if (prior && prior.state.trim() === state && prior.next.trim() === next) return null;
    if (input.existing.state === state && input.existing.next === next) return null;
  }
  return {
    state,
    next,
    author: input.author,
    writtenAt: (input.writtenAt ?? new Date()).toISOString(),
    eventId: null,
    rationale: null,
    source: 'content',
  };
}

/** The minimal tagged-template surface the write needs (postgres.js `sql` / `tx`). */
export type NowNoteSql = <T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

export interface PlanNowNoteScope {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

/**
 * Write a note for one plan: `now_note` plus its `now_state` / `now_next`
 * projection. `content`, `content_hash` and `version` are not touched, so no
 * plan revision is recorded and the markdown stays byte-identical. `origin` is
 * reset to 'local' so the capture trigger federates the write (a row last
 * written by a projection carries origin 'remote', which the capture skips).
 * The row clock is stamped explicitly: since migration 1481 (D-009) the stamp
 * trigger treats the note columns as bookkeeping, so it no longer stamps a
 * note-only write itself, and the federated op must still carry a fresh clock.
 * Returns false when the plan row does not exist.
 */
export async function writePlanNowNote(
  sql: NowNoteSql,
  scope: PlanNowNoteScope,
  note: PlanNowNote,
): Promise<boolean> {
  const rows = await sql<Array<{ plan_slug: string }>>`
    UPDATE harness_shared.harness_plans
       SET now_note   = ${JSON.stringify(note)}::text::jsonb,
           now_state  = ${note.state},
           now_next   = ${note.next},
           updated_at = now(),
           fed_ts     = (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
           fed_hlc    = harness_shared.hlc_now(),
           origin     = 'local'
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
    RETURNING plan_slug
  `;
  return rows.length > 0;
}

/** The provenance a federated note apply carries: the op's origin. */
export interface FederatedNowNoteOrigin {
  origin: string;
}

/**
 * Apply a peer's Now note (D-008 §2) to an EXISTING plan row, under the note's
 * own last-writer-wins (`isNewerNowNote`): an older, equal or malformed note is
 * ignored. Runs inside the projection's admission transaction, which already
 * holds this plan's advisory lock, so the read-compare-write cannot race a
 * local plans:set-now (same lock key).
 *
 * On apply it writes `now_note` and its `now_state` / `now_next` projection and
 * sets `origin` to the op's origin, so the capture trigger does not re-emit a
 * remote note. It never touches the row clock (D-009): the note is ordered by
 * its own `writtenAt`, and migration 1481 makes the stamp trigger treat the
 * note columns as bookkeeping, so the row keeps its clock and is not
 * re-stamped as a local write. Returns true when the note was applied.
 */
export async function applyFederatedNowNote(
  sql: NowNoteSql,
  scope: PlanNowNoteScope,
  raw: unknown,
  provenance: FederatedNowNoteOrigin,
): Promise<boolean> {
  const incoming = parseNowNote(raw);
  if (!incoming) return false;
  const rows = await sql<Array<{ now_note: unknown }>>`
    SELECT now_note
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
     FOR UPDATE
  `;
  if (!rows[0]) return false;
  if (!isNewerNowNote(incoming, parseNowNote(rows[0].now_note))) return false;
  await sql`
    UPDATE harness_shared.harness_plans
       SET now_note  = ${JSON.stringify(incoming)}::text::jsonb,
           now_state = ${incoming.state},
           now_next  = ${incoming.next},
           origin    = ${provenance.origin}
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
  `;
  return true;
}

/** Read one plan's stored note (null when absent or malformed). */
export async function readPlanNowNote(
  sql: NowNoteSql,
  scope: PlanNowNoteScope,
): Promise<PlanNowNote | null> {
  const rows = await sql<Array<{ now_note: unknown }>>`
    SELECT now_note
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
  `;
  return rows[0] ? parseNowNote(rows[0].now_note) : null;
}
