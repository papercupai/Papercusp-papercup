/**
 * Retraction cascade — when a fact is RETRACTED or SUPERSEDED, flag every closed
 * work item whose recorded completion assumptions cited it, and tell the item's
 * terminal owner (plan carry-recheck-and-governed-memory-2026-10-14, P-003 / R-3).
 *
 * ── THE GAP ────────────────────────────────────────────────────────────────
 * A terminal close may declare the facts it rested on (`work_items:complete
 * { assumptions }`); `coord-lifecycle/records.ts` stamps them, resolved and
 * version-pinned, under `payload._assumptions.declared`. Until now nothing
 * reacted when one of those facts later stopped being true. The basis-movement
 * sweep (`agent-plane-measurement-sweep.ts`) MEASURES how many closes rest on
 * moved ground, but it is an aggregate: no close was ever marked, and the agent
 * who closed it was never told. A completion resting on a retracted premise
 * looked exactly like one resting on a live premise.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 *   1. finds terminal work items whose declared assumptions cite the fact
 *      (retraction: by identity scope/scopeRef/key; supersession: by the exact
 *      superseded version id the close pinned);
 *   2. appends ONE flag per (item, event) to `payload._assumptionFlags`, naming
 *      the fact and the reason — idempotent, keyed by `dedupeKey`;
 *   3. sends one coord message per terminal owner (fallback: the claim holder),
 *      listing that owner's flagged items.
 *
 * ── FLAG, NEVER REOPEN ─────────────────────────────────────────────────────
 * The UPDATE touches `payload` only. It never writes `status`, `updated_ts`,
 * `taken_by` or any terminal column (clause CRGM-P-003-flag-not-reopen). Whether
 * a close survives the loss of its premise is a judgment for the owner; a silent
 * automatic reopen would turn every routine fact correction into churn.
 *
 * ── A REFRESH IS NOT A SUPERSESSION ────────────────────────────────────────
 * `assertFact` writes a new version on EVERY re-assert, including a routine
 * re-assert of an unchanged body (TTL refresh). Flagging those would bury the
 * real signal under noise, so a supersession flags only when the body actually
 * changed (`supersessionChangedBody`). Retraction always flags.
 *
 * ── NEVER THROWS ───────────────────────────────────────────────────────────
 * Called from `retractFact` / `assertFact` AFTER their write succeeded.
 * A cascade failure is logged and reported in the result, never raised, so it
 * cannot turn a successful fact write into an error (same contract as
 * `notify-evicted.ts`). The message carries NO `category` for the reason given
 * in that module's header: a categorised message is default-excluded from
 * `coord:inbox`.
 */
import type { Sql } from 'postgres';
import type { FactScope } from './store';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

/** Payload key holding the flags. Read by `work_items:get` (`assumptionFlags`). */
export const ASSUMPTION_FLAGS_KEY = '_assumptionFlags';

/** Hard bound on the items one event may flag; the result says when it was hit. */
export const CASCADE_ITEM_LIMIT = 500;

export type FactChangeKind = 'retracted' | 'superseded';

/** One retraction or supersession, as the fact store observed it. */
export interface FactChangeEvent {
  kind: FactChangeKind;
  workspaceId: string;
  scope: FactScope;
  /** null/'' for `workspace` scope. */
  scopeRef: string | null;
  key: string;
  /**
   * The version that stopped being current. Retraction: the retracted row id
   * (null when the store could not name it). Supersession: the superseded row id.
   */
  versionId: number | null;
  /** Supersession only: the new version id. */
  supersededBy?: number | null;
  /** Human-readable reason; required in the rendered flag. */
  reason: string | null;
  /** Who retracted / re-asserted. */
  by: string | null;
}

/** The minimal citation shape read from `payload._assumptions.declared[]`. */
export interface CitedAssumption {
  declared?: string;
  ref?: string | null;
  key?: string;
  scope?: string | null;
  scopeRef?: string | null;
  versionId?: number | null;
}

/** One flag as stored on a work item. */
export interface AssumptionFlag {
  /** Idempotency key: one flag per (item, fact change). */
  dedupeKey: string;
  condition: FactChangeKind;
  /** Absolute fact ref, e.g. `harness:papercusp:release-window@1234`. */
  factRef: string;
  scope: FactScope;
  scopeRef: string | null;
  key: string;
  /** The version the close cited (when it pinned one). */
  citedVersionId: number | null;
  /** The version that stopped being current. */
  versionId: number | null;
  supersededBy: number | null;
  reason: string;
  by: string | null;
  /** ISO timestamp of the flag. */
  at: string;
}

const norm = (v: string | null | undefined): string => (v ?? '').trim();

/** Absolute ref for a fact identity (+ version). Mirrors parseAssumptionRef's grammar. */
export function factRefOf(
  scope: FactScope,
  scopeRef: string | null,
  key: string,
  versionId: number | null,
): string {
  const base = scope === 'workspace' ? `workspace:${key}` : `${scope}:${norm(scopeRef)}:${key}`;
  return versionId != null ? `${base}@${versionId}` : base;
}

export function dedupeKeyOf(event: Pick<FactChangeEvent, 'kind' | 'scope' | 'scopeRef' | 'key' | 'versionId'>): string {
  return `${event.kind}:${factRefOf(event.scope, event.scopeRef, event.key, null)}@${event.versionId ?? 'identity'}`;
}

const sameIdentity = (a: CitedAssumption, e: FactChangeEvent): boolean =>
  a.scope === e.scope &&
  norm(a.key) === norm(e.key) &&
  (e.scope === 'workspace' || norm(a.scopeRef) === norm(e.scopeRef));

/**
 * Does this citation rest on the changed fact?
 *  - retraction: the whole identity is gone, so ANY version of it matches;
 *  - supersession: only a close that pinned exactly the superseded version
 *    (a close pinned to an older version was flagged when THAT version moved;
 *    a close with no pin cannot be tied to a version and is left to retraction).
 */
export function citesChangedFact(a: CitedAssumption, e: FactChangeEvent): boolean {
  if (!a || typeof a !== 'object') return false;
  if (!sameIdentity(a, e)) return false;
  if (e.kind === 'retracted') return true;
  return e.versionId != null && a.versionId != null && Number(a.versionId) === Number(e.versionId);
}

/** The citations in a stored declaration that rest on the changed fact. */
export function matchingCitations(declared: unknown, e: FactChangeEvent): CitedAssumption[] {
  if (!Array.isArray(declared)) return [];
  return (declared as CitedAssumption[]).filter((a) => citesChangedFact(a, e));
}

/** Build the flag for an item whose citation matched. */
export function buildFlag(e: FactChangeEvent, citation: CitedAssumption, atIso: string): AssumptionFlag {
  const reason =
    norm(e.reason) ||
    (e.kind === 'superseded'
      ? `superseded by version ${e.supersededBy ?? '?'}`
      : 'retracted (no reason given)');
  return {
    dedupeKey: dedupeKeyOf(e),
    condition: e.kind,
    factRef: factRefOf(e.scope, e.scopeRef, e.key, e.versionId),
    scope: e.scope,
    scopeRef: e.scope === 'workspace' ? null : norm(e.scopeRef) || null,
    key: e.key,
    citedVersionId: citation.versionId != null ? Number(citation.versionId) : null,
    versionId: e.versionId,
    supersededBy: e.kind === 'superseded' ? (e.supersededBy ?? null) : null,
    reason,
    by: e.by,
    at: atIso,
  };
}

/** Read flags off a work-item payload; tolerant of absent/garbage input. */
export function readAssumptionFlags(payload: unknown): AssumptionFlag[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  let v = (payload as Record<string, unknown>)[ASSUMPTION_FLAGS_KEY];
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.filter(
    (f): f is AssumptionFlag =>
      !!f && typeof f === 'object' && typeof (f as AssumptionFlag).dedupeKey === 'string' &&
      typeof (f as AssumptionFlag).factRef === 'string',
  );
}

/** Append incoming flags, skipping any whose dedupeKey is already present. */
export function mergeFlags(
  existing: readonly AssumptionFlag[],
  incoming: readonly AssumptionFlag[],
): { flags: AssumptionFlag[]; added: AssumptionFlag[] } {
  const seen = new Set(existing.map((f) => f.dedupeKey));
  const added: AssumptionFlag[] = [];
  for (const f of incoming) {
    if (seen.has(f.dedupeKey)) continue;
    seen.add(f.dedupeKey);
    added.push(f);
  }
  return { flags: [...existing, ...added], added };
}

/** One line per flag, for read surfaces (`work_items:get`). */
export function renderFlagLine(f: AssumptionFlag): string {
  const verb = f.condition === 'retracted' ? 'RETRACTED' : 'SUPERSEDED';
  const by = f.by ? ` by ${f.by}` : '';
  return `⚠ cited fact ${f.factRef} ${verb}${by} at ${f.at}: ${f.reason}`;
}

export interface FlaggedItem {
  id: string;
  harness: string | null;
  title: string | null;
  status: string;
  recipient: string | null;
}

/** The owner notice: one message per recipient, listing every flagged item. */
export function renderCascadeNotice(e: FactChangeEvent, items: readonly FlaggedItem[]): { summary: string; body: string } {
  const ref = factRefOf(e.scope, e.scopeRef, e.key, e.versionId);
  const verb = e.kind === 'retracted' ? 'retracted' : 'superseded';
  const reason = norm(e.reason) || (e.kind === 'superseded' ? `superseded by version ${e.supersededBy ?? '?'}` : 'no reason given');
  const n = items.length;
  const summary = `Fact ${ref} was ${verb} — ${n} of your closed work item${n === 1 ? '' : 's'} cited it as a completion assumption`;
  const lines = [
    `The fact ${ref} was ${verb}${e.by ? ` by ${e.by}` : ''}. Reason: ${reason}.`,
    '',
    `These closed items declared it in their completion assumptions. Each now carries an assumption flag (work_items:get → assumptionFlags). They were NOT reopened: decide whether each close still holds without that premise, and reopen only the ones that do not.`,
    '',
    ...items.map((i) => `- ${i.id}${i.harness ? ` [${i.harness}]` : ''} (${i.status})${i.title ? ` — ${i.title.slice(0, 120)}` : ''}`),
  ];
  return { summary, body: lines.join('\n') };
}

export interface CascadeResult {
  ok: boolean;
  kind: FactChangeKind;
  factRef: string;
  /** Terminal items whose declaration cites the fact. */
  matched: number;
  /** Items that received a NEW flag this call (0 on an idempotent replay). */
  flagged: FlaggedItem[];
  notified: string[];
  failedRecipients: string[];
  /** Items whose owner could not be resolved (no terminal owner, no holder). */
  unnotifiable: string[];
  truncated: boolean;
  /** Present when the cascade deliberately did nothing. */
  skipped?: 'body-unchanged' | 'no-version';
  error?: string;
}

interface CandidateRow {
  feature_id: string;
  harness_slug: string | null;
  title: string | null;
  status: string;
  terminal_owner: string | null;
  taken_by: string | null;
  declared: unknown;
}

/**
 * Supersession filter: true when the superseded version's body differs from the
 * new one. A failed read answers true (flag rather than miss a real change).
 */
export async function supersessionChangedBody(sql: Sql, oldId: number, newBody: string | null): Promise<boolean> {
  try {
    const rows = await sql<{ body: string | null }[]>`
      SELECT body FROM harness_shared.agent_facts WHERE id = ${oldId}`;
    if (!rows[0]) return true;
    return norm(rows[0].body) !== norm(newBody);
  } catch {
    return true;
  }
}

/**
 * Flag + notify. Never throws. `sql` must be the connection the fact write used,
 * so a caller inside a transaction sees its own write.
 */
export async function cascadeFactChange(
  sql: Sql,
  e: FactChangeEvent,
  opts: { now?: () => Date; notify?: boolean } = {},
): Promise<CascadeResult> {
  const factRef = factRefOf(e.scope, e.scopeRef, e.key, e.versionId);
  const base: CascadeResult = {
    ok: true,
    kind: e.kind,
    factRef,
    matched: 0,
    flagged: [],
    notified: [],
    failedRecipients: [],
    unnotifiable: [],
    truncated: false,
  };
  if (e.kind === 'superseded' && e.versionId == null) return { ...base, skipped: 'no-version' };
  try {
    // Inside a caller's transaction a failed statement would abort the WHOLE
    // transaction, fact write included. A savepoint confines the failure to the
    // cascade, so "never throws" also means "never poisons the caller's tx".
    // Concrete (non-generic) signature: `.call` on a generic `<T>` signature cannot
    // infer T and would type the outcome as `unknown`.
    const savepoint = (sql as unknown as { savepoint?: (fn: (s: Sql) => Promise<FlagOutcome>) => Promise<FlagOutcome> })
      .savepoint;
    const { matched, flagged, truncated }: FlagOutcome =
      typeof savepoint === 'function'
        ? await savepoint.call(sql, (s: Sql) => flagMatchingItems(s, e, opts))
        : await flagMatchingItems(sql, e, opts);
    const result: CascadeResult = { ...base, matched, flagged, truncated };
    if (opts.notify !== false && flagged.length > 0) await notifyRecipients(e, flagged, result);
    console.log(
      `[retraction-cascade] ${e.kind} ${factRef}: matched=${matched} flagged=${flagged.length}` +
        ` notified=[${result.notified.join(', ')}]` +
        (result.failedRecipients.length ? ` FAILED=[${result.failedRecipients.join(', ')}]` : '') +
        (result.unnotifiable.length ? ` unnotifiable=[${result.unnotifiable.join(', ')}]` : '') +
        (truncated ? ` TRUNCATED at ${CASCADE_ITEM_LIMIT}` : ''),
    );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[retraction-cascade] ${e.kind} ${factRef} failed: ${msg}`);
    return { ...base, ok: false, error: msg };
  }
}

interface FlagOutcome {
  matched: number;
  flagged: FlaggedItem[];
  truncated: boolean;
}

async function flagMatchingItems(sql: Sql, e: FactChangeEvent, opts: { now?: () => Date }): Promise<FlagOutcome> {
  {
    // Containment narrows on the indexed population (migration 1506's predicate is
    // repeated verbatim so the partial index applies); the JS matcher then applies
    // the exact rule, including the null-vs-'' scopeRef equivalence SQL cannot.
    const probe = e.kind === 'retracted' ? [{ scope: e.scope, key: e.key }] : [{ versionId: e.versionId }];
    const rows = await sql<CandidateRow[]>`
      SELECT feature_id, harness_slug, title, status, terminal_owner, taken_by,
             payload -> '_assumptions' -> 'declared' AS declared
        FROM harness_shared.work_items
       WHERE workspace_id = ${e.workspaceId}
         AND jsonb_typeof((payload -> '_assumptions') -> 'declared') = 'array'
         AND (payload -> '_assumptions' -> 'declared') @> ${JSON.stringify(probe)}::jsonb
         AND status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])
       ORDER BY feature_id
       LIMIT ${CASCADE_ITEM_LIMIT + 1}`;
    const truncated = rows.length > CASCADE_ITEM_LIMIT;
    const candidates = rows.slice(0, CASCADE_ITEM_LIMIT);
    const at = (opts.now ?? (() => new Date()))().toISOString();
    const flagged: FlaggedItem[] = [];
    let matched = 0;
    for (const row of candidates) {
      const hits = matchingCitations(row.declared, e);
      if (hits.length === 0) continue;
      matched++;
      const flag = buildFlag(e, hits[0], at);
      // Atomic, idempotent append: the containment guard makes a replay (or a
      // concurrent cascade of the same event) a no-op. `payload` ONLY.
      const updated = await sql<{ feature_id: string }[]>`
        UPDATE harness_shared.work_items
           SET payload = jsonb_set(
                 COALESCE(payload, '{}'::jsonb),
                 '{_assumptionFlags}',
                 COALESCE(payload -> '_assumptionFlags', '[]'::jsonb) || ${JSON.stringify([flag])}::jsonb,
                 true)
         WHERE workspace_id = ${e.workspaceId}
           AND feature_id = ${row.feature_id}
           AND harness_slug IS NOT DISTINCT FROM ${row.harness_slug}
           AND NOT (COALESCE(payload -> '_assumptionFlags', '[]'::jsonb) @> ${JSON.stringify([{ dedupeKey: flag.dedupeKey }])}::jsonb)
        RETURNING feature_id`;
      if (updated.length === 0) continue;
      flagged.push({
        id: row.feature_id,
        harness: row.harness_slug,
        title: row.title,
        status: row.status,
        recipient: norm(row.terminal_owner) || norm(row.taken_by) || null,
      });
    }
    return { matched, flagged, truncated };
  }
}

async function notifyRecipients(e: FactChangeEvent, flagged: FlaggedItem[], result: CascadeResult): Promise<void> {
  const byRecipient = new Map<string, FlaggedItem[]>();
  for (const item of flagged) {
    if (!item.recipient) {
      result.unnotifiable.push(item.id);
      continue;
    }
    const list = byRecipient.get(item.recipient) ?? [];
    list.push(item);
    byRecipient.set(item.recipient, list);
  }
  if (byRecipient.size === 0) return;
  // Lazy import: keeps the coordination module graph out of every fact write.
  const { sendMessage } = await import('../agent-tools/coordination/messages');
  const sender = norm(e.by) || 'system:retraction-cascade';
  for (const [recipient, items] of byRecipient) {
    const { summary, body } = renderCascadeNotice(e, items);
    try {
      await sendMessage(
        {
          ownerId: sender,
          ownerLabel: sender,
          source: 'static-client',
          workspaceId: null,
          userId: null,
        } as Parameters<typeof sendMessage>[0],
        {
          to: [recipient],
          summary,
          body,
          // NO `category` — see the module header.
          extra: {
            auto: true,
            factChangeCascade: { kind: e.kind, factRef: factRefOf(e.scope, e.scopeRef, e.key, e.versionId), items: items.map((i) => i.id) },
          },
        },
      );
      result.notified.push(recipient);
    } catch (err) {
      result.failedRecipients.push(recipient);
      console.warn(
        `[retraction-cascade] failed to notify ${recipient}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
