/**
 * Ideation backlog adjudication — every ideation-origin work-item carries a recorded
 * disposition: keep, merge or drop (plan scout-su-ideate-pipeline-gaps-2026-10-08 P-005 / R-9;
 * EI-19480163059215610).
 *
 * WHY THIS EXISTS. Scout and su-ideate route ideas into the work-item queue, and nothing ever
 * adjudicated them: on 2026-10-08 the papercusp workspace held 1,358 ideation-class items
 * (477 non-terminal) and none carried a disposition, while EI-19480163059215610 measured the open
 * backlog as 29-44% self-redundant. A claimer could not tell a kept idea from a redundant one.
 *
 * REUSE. Similarity is NOT recomputed here. `harness_shared.dedup_edges` already carries cosine
 * edges in the migration-548 embedding space (written by the create-time prescreen and the
 * admission census, work-queue-admission-and-bulk-dedup-2026-08-24), and 0.90 is that census's
 * own duplicate-pair floor. Ideation membership is {@link ITEM_CLASS_SQL_TEXT}, the one
 * definition behind the claim-spec `item_class` field (R-10/R-11). The terminal close goes
 * through {@link setWorkItemState}, the canonical writer behind `work_items:set_state`, and
 * uses the admission promoter's `duplicate of <id>` reason convention.
 *
 * THE RULES (deterministic, oldest first, so an older idea is always the canonical one):
 *  - terminal `done` / `resolved`                  -> keep  (the idea was taken up)
 *  - terminal `closed` with completion evidence    -> keep
 *  - terminal `dropped` whose reason is `duplicate of X` -> merge into X
 *  - any other terminal close                      -> drop
 *  - non-terminal with an older kept near-duplicate (cos >= 0.90) -> merge into the closest one
 *  - non-terminal whose only older near-duplicates were dropped     -> drop (already rejected)
 *  - otherwise                                     -> keep (it becomes a canonical idea)
 * An item that already carries a disposition keeps it: the pass is incremental and stable, so a
 * kept idea never flips because a newer near-duplicate arrived.
 */
import { getOrgPg } from '@papercusp/db-org';
import { ITEM_CLASS_SQL_TEXT } from './ideation-origin';

export const IDEA_DISPOSITION_PAYLOAD_KEY = 'ideaDisposition' as const;
export const IDEA_DISPOSITIONS = ['keep', 'merge', 'drop'] as const;
export type IdeaDispositionKind = (typeof IDEA_DISPOSITIONS)[number];

/** The admission census's duplicate-pair floor (dedup_edges.cos, migration-548 space). */
export const ADJUDICATION_MERGE_COS = 0.9;
export const ADJUDICATION_VERSION = 1;
export const ADJUDICATION_ACTOR = 'system:scout-ideation-adjudication' as const;
/** Upper bound on terminal closes per sweep, so one run cannot sweep the queue unbounded. */
export const ADJUDICATION_CLOSE_BATCH = 100;

const TERMINAL_STATES = new Set(['done', 'resolved', 'closed', 'dropped']);
const DUPLICATE_REASON = /^duplicate of ([A-Za-z]+-\d+)/;

export type DispositionBasis =
  | 'terminal-kept'
  | 'terminal-duplicate'
  | 'terminal-dropped'
  | 'unique'
  | 'near-duplicate-of-kept'
  | 'near-duplicate-of-dropped';

export interface IdeaDisposition {
  disposition: IdeaDispositionKind;
  basis: DispositionBasis;
  /** merge target (merge), or the rejected near-duplicate a drop rests on. */
  relatedTo?: string;
  cos?: number;
  version: number;
  adjudicatedAtMs: number;
  by: string;
}

export interface IdeationItem {
  id: string;
  harness: string;
  status: string;
  createdTs: number;
  terminalReason: string | null;
  hasCompletionEvidence: boolean;
  existing: IdeaDisposition | null;
}

export interface SimilarityEdge {
  a: string;
  b: string;
  cos: number;
}

export interface AdjudicationDecision {
  id: string;
  harness: string;
  status: string;
  disposition: IdeaDisposition;
  /** true when the item has no recorded disposition yet and this pass must write one. */
  needsWrite: boolean;
}

export function isTerminalIdeaStatus(status: string): boolean {
  return TERMINAL_STATES.has(status);
}

function isDisposition(value: unknown): value is IdeaDisposition {
  if (value === null || typeof value !== 'object') return false;
  const d = (value as Record<string, unknown>).disposition;
  return typeof d === 'string' && (IDEA_DISPOSITIONS as readonly string[]).includes(d);
}

function terminalDisposition(item: IdeationItem): Pick<IdeaDisposition, 'disposition' | 'basis' | 'relatedTo'> {
  if (item.status === 'done' || item.status === 'resolved') return { disposition: 'keep', basis: 'terminal-kept' };
  if (item.status === 'closed' && item.hasCompletionEvidence) return { disposition: 'keep', basis: 'terminal-kept' };
  const dup = item.status === 'dropped' ? DUPLICATE_REASON.exec(item.terminalReason ?? '') : null;
  if (dup) return { disposition: 'merge', basis: 'terminal-duplicate', relatedTo: dup[1] };
  return { disposition: 'drop', basis: 'terminal-dropped' };
}

/**
 * Pure adjudication over the whole ideation population. Returns one decision per item, in
 * oldest-first order; `needsWrite` marks the items that have no recorded disposition yet.
 */
export function adjudicateIdeationBacklog(
  items: readonly IdeationItem[],
  edges: readonly SimilarityEdge[],
  opts: { nowMs: number; mergeCos?: number; by?: string },
): AdjudicationDecision[] {
  const mergeCos = opts.mergeCos ?? ADJUDICATION_MERGE_COS;
  const by = opts.by ?? ADJUDICATION_ACTOR;
  const known = new Set(items.map((i) => i.id));
  const neighbours = new Map<string, Array<{ id: string; cos: number }>>();
  for (const e of edges) {
    if (!(e.cos >= mergeCos) || e.a === e.b || !known.has(e.a) || !known.has(e.b)) continue;
    (neighbours.get(e.a) ?? neighbours.set(e.a, []).get(e.a)!).push({ id: e.b, cos: e.cos });
    (neighbours.get(e.b) ?? neighbours.set(e.b, []).get(e.b)!).push({ id: e.a, cos: e.cos });
  }
  const ordered = [...items].sort((x, y) => x.createdTs - y.createdTs || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  // Representatives: items a newer near-duplicate resolves against.
  const reps = new Map<string, 'kept' | 'dropped'>();
  const out: AdjudicationDecision[] = [];
  for (const item of ordered) {
    let disposition: IdeaDisposition;
    if (isDisposition(item.existing)) {
      disposition = item.existing;
    } else if (isTerminalIdeaStatus(item.status)) {
      disposition = { ...terminalDisposition(item), version: ADJUDICATION_VERSION, adjudicatedAtMs: opts.nowMs, by };
    } else {
      let kept: { id: string; cos: number } | null = null;
      let dropped: { id: string; cos: number } | null = null;
      for (const n of neighbours.get(item.id) ?? []) {
        const rep = reps.get(n.id);
        if (rep === 'kept' && (!kept || n.cos > kept.cos)) kept = n;
        if (rep === 'dropped' && (!dropped || n.cos > dropped.cos)) dropped = n;
      }
      const base = { version: ADJUDICATION_VERSION, adjudicatedAtMs: opts.nowMs, by };
      if (kept) disposition = { disposition: 'merge', basis: 'near-duplicate-of-kept', relatedTo: kept.id, cos: kept.cos, ...base };
      else if (dropped) disposition = { disposition: 'drop', basis: 'near-duplicate-of-dropped', relatedTo: dropped.id, cos: dropped.cos, ...base };
      else disposition = { disposition: 'keep', basis: 'unique', ...base };
    }
    if (disposition.disposition === 'keep') reps.set(item.id, 'kept');
    else if (disposition.disposition === 'drop') reps.set(item.id, 'dropped');
    out.push({ id: item.id, harness: item.harness, status: item.status, disposition, needsWrite: !isDisposition(item.existing) });
  }
  return out;
}

/** The terminal-close reason for an open item a disposition retires. */
export function closeReasonFor(d: IdeaDisposition): string {
  const cos = d.cos === undefined ? '' : `, cos ${d.cos.toFixed(3)}`;
  if (d.disposition === 'merge') return `duplicate of ${d.relatedTo} (${ADJUDICATION_ACTOR}${cos})`;
  return `ideation backlog adjudication: near-duplicate of previously rejected ${d.relatedTo} (${ADJUDICATION_ACTOR}${cos})`;
}

export async function readIdeationItems(workspaceId: string): Promise<IdeationItem[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{ feature_id: string; harness_slug: string; status: string | null; created_ts: string | number | null; terminal_reason: string | null; has_evidence: boolean; existing: unknown }>
  >`
    SELECT feature_id, harness_slug, status, created_ts, terminal_reason,
           (payload ? '_completionEvidence') AS has_evidence,
           payload->${IDEA_DISPOSITION_PAYLOAD_KEY} AS existing
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND lane IS DISTINCT FROM 'observation'
       AND jsonb_typeof(payload) = 'object'
       AND (${sql.unsafe(ITEM_CLASS_SQL_TEXT)}) = 'ideation'`;
  return rows.map((r) => ({
    id: r.feature_id,
    harness: r.harness_slug,
    status: r.status ?? 'open',
    createdTs: Number(r.created_ts ?? 0),
    terminalReason: r.terminal_reason,
    hasCompletionEvidence: r.has_evidence === true,
    existing: isDisposition(r.existing) ? r.existing : null,
  }));
}

export async function readIdeationEdges(workspaceId: string, ids: readonly string[], mergeCos = ADJUDICATION_MERGE_COS): Promise<SimilarityEdge[]> {
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ a: string; b: string; cos: number }>>`
    SELECT a, b, cos FROM harness_shared.dedup_edges
     WHERE workspace_id = ${workspaceId} AND cos >= ${mergeCos}
       AND a = ANY(${ids as string[]}::text[]) AND b = ANY(${ids as string[]}::text[])`;
  return rows.map((r) => ({ a: r.a, b: r.b, cos: Number(r.cos) }));
}

/** Writes dispositions only where none is recorded yet (never overwrites an earlier verdict). */
export async function writeDispositions(workspaceId: string, decisions: readonly AdjudicationDecision[]): Promise<number> {
  const pending = decisions.filter((d) => d.needsWrite);
  if (pending.length === 0) return 0;
  const { sql } = getOrgPg();
  let written = 0;
  for (let i = 0; i < pending.length; i += 500) {
    const chunk = pending.slice(i, i + 500);
    const res = await sql`
      UPDATE harness_shared.work_items w
         SET payload = w.payload || jsonb_build_object(${IDEA_DISPOSITION_PAYLOAD_KEY}::text, v.disp)
        FROM (SELECT unnest(${chunk.map((d) => d.id)}::text[]) AS id,
                     unnest(${chunk.map((d) => JSON.stringify(d.disposition))}::jsonb[]) AS disp) v
       WHERE w.workspace_id = ${workspaceId}
         AND w.feature_id = v.id
         AND jsonb_typeof(w.payload) = 'object'
         AND NOT (w.payload ? ${IDEA_DISPOSITION_PAYLOAD_KEY})`;
    written += res.count;
  }
  return written;
}

export interface AdjudicationSweepResult {
  workspaceId: string;
  outcome: 'ran' | 'disabled' | 'error';
  population: number;
  written: number;
  byDisposition: Record<IdeaDispositionKind, number>;
  undisposed: number;
  /** Non-terminal items whose disposition is merge/drop — the backlog this pass retires. */
  openToRetire: number;
  closed: number;
  closeFailures: number;
  reason?: string;
}

export interface AdjudicationSweepDeps {
  readItems(workspaceId: string): Promise<IdeationItem[]>;
  readEdges(workspaceId: string, ids: readonly string[]): Promise<SimilarityEdge[]>;
  write(workspaceId: string, decisions: readonly AdjudicationDecision[]): Promise<number>;
  close(decision: AdjudicationDecision): Promise<void>;
}

const defaultDeps: AdjudicationSweepDeps = {
  readItems: readIdeationItems,
  readEdges: (ws, ids) => readIdeationEdges(ws, ids),
  write: writeDispositions,
  async close(decision) {
    const { setWorkItemState } = await import('../work-items');
    await setWorkItemState(decision.id, 'dropped', {
      harness: decision.harness,
      by: ADJUDICATION_ACTOR,
      completionRef: closeReasonFor(decision.disposition),
    });
  },
};

export function adjudicationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_SCOUT_IDEATION_ADJUDICATION !== '0';
}

/**
 * Record a disposition for every ideation item lacking one, then retire (close) up to
 * `closeBatch` non-terminal items whose disposition is merge or drop. `closeBatch: 0` records
 * dispositions only. Fail-soft: an error is returned in the result, never thrown.
 */
export async function ideationBacklogAdjudicationSweep(
  opts: { workspaceId?: string; now?: number; closeBatch?: number; deps?: Partial<AdjudicationSweepDeps> } = {},
): Promise<AdjudicationSweepResult> {
  const deps = { ...defaultDeps, ...opts.deps };
  const nowMs = opts.now ?? Date.now();
  const closeBatch = opts.closeBatch ?? ADJUDICATION_CLOSE_BATCH;
  const empty = { keep: 0, merge: 0, drop: 0 };
  let workspaceId = opts.workspaceId ?? '';
  const base = { population: 0, written: 0, byDisposition: { ...empty }, undisposed: 0, openToRetire: 0, closed: 0, closeFailures: 0 };
  try {
    if (!workspaceId) workspaceId = (await import('../workspace-registry')).activeWorkspaceId();
    if (!adjudicationEnabled()) return { workspaceId, outcome: 'disabled', ...base, reason: 'PAPERCUSP_SCOUT_IDEATION_ADJUDICATION=0' };
    const items = await deps.readItems(workspaceId);
    const edges = await deps.readEdges(workspaceId, items.map((i) => i.id));
    const decisions = adjudicateIdeationBacklog(items, edges, { nowMs });
    const written = await deps.write(workspaceId, decisions);
    const byDisposition = { ...empty };
    for (const d of decisions) byDisposition[d.disposition.disposition] += 1;
    const retire = decisions.filter((d) => !isTerminalIdeaStatus(d.status) && d.disposition.disposition !== 'keep');
    let closed = 0;
    let closeFailures = 0;
    for (const d of retire.slice(0, Math.max(0, closeBatch))) {
      try {
        await deps.close(d);
        closed += 1;
      } catch {
        closeFailures += 1;
      }
    }
    const undisposed = decisions.filter((d) => d.needsWrite).length - written;
    return { workspaceId, outcome: 'ran', population: items.length, written, byDisposition, undisposed, openToRetire: retire.length, closed, closeFailures };
  } catch (err) {
    return { workspaceId, outcome: 'error', ...base, reason: err instanceof Error ? err.message : String(err) };
  }
}
