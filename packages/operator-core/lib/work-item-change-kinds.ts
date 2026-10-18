/**
 * Storage for agent-declared change kinds (plan change-kind-declared-proof-2026-10-15, P-001 / R-1).
 *
 * Every declaration is a new row in harness_shared.work_item_change_kind_declarations
 * (migration 1518). Nothing is updated in place: the newest row per item is the current
 * declaration and the older rows are its history, so a narrowed or late declaration is never
 * lost.
 *
 * The work_items entry points (create with assign_to, claim, checkpoint, complete) call
 * `declareChangeKinds` after their own write lands. It never throws: a storage failure comes
 * back as `{ recorded: false, error }` so the caller can surface it beside its own result
 * instead of failing a write that already happened.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  normalizeChangeKinds,
  type ChangeKind,
  type ChangeKindStep,
} from './change-kind-catalog';

export interface ChangeKindDeclaration {
  kinds: ChangeKind[];
  step: ChangeKindStep;
  declaredBy: string;
  declaredAt: string;
  reason: string | null;
}

export interface ChangeKindsView {
  /** Kinds of the newest declaration, or null when nothing was ever declared. */
  current: ChangeKind[] | null;
  /** Every declaration, oldest first. */
  history: ChangeKindDeclaration[];
}

export interface DeclareChangeKindsInput {
  workspaceId: string;
  featureId: string;
  kinds: readonly string[];
  step: ChangeKindStep;
  declaredBy: string;
  reason?: string | null;
}

export type DeclareChangeKindsResult =
  | { recorded: true; current: ChangeKind[]; step: ChangeKindStep; previous: ChangeKind[] | null }
  | { recorded: false; error: string };

interface DeclarationRow {
  feature_id: string;
  kinds: string[];
  step: string;
  declared_by: string;
  declared_at: Date | string;
  reason: string | null;
}

function toDeclaration(row: DeclarationRow): ChangeKindDeclaration {
  const at = row.declared_at instanceof Date ? row.declared_at.toISOString() : new Date(row.declared_at).toISOString();
  return {
    // Rows were validated on write; re-normalizing keeps a hand-inserted row from leaking an
    // unknown kind into `current`.
    kinds: (() => {
      const n = normalizeChangeKinds(row.kinds);
      return n.ok ? n.kinds : [];
    })(),
    step: row.step as ChangeKindStep,
    declaredBy: row.declared_by,
    declaredAt: at,
    reason: row.reason,
  };
}

function sqlOf(sql?: Sql): Sql {
  return sql ?? (getOrgPg().sql as unknown as Sql);
}

/**
 * Read current kinds + history for a set of items. Items with no declaration map to
 * `{ current: null, history: [] }`. One query regardless of how many ids are asked for.
 */
export async function readChangeKinds(
  workspaceId: string,
  featureIds: readonly string[],
  sql?: Sql,
): Promise<Map<string, ChangeKindsView>> {
  const out = new Map<string, ChangeKindsView>();
  const ids = [...new Set(featureIds.filter((id) => typeof id === 'string' && id.length > 0))];
  for (const id of ids) out.set(id, { current: null, history: [] });
  if (ids.length === 0) return out;
  const rows = await sqlOf(sql)<DeclarationRow[]>`
    SELECT feature_id, kinds, step, declared_by, declared_at, reason
      FROM harness_shared.work_item_change_kind_declarations
     WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids})
     ORDER BY feature_id, declared_at ASC, id ASC`;
  for (const row of rows) {
    const view = out.get(row.feature_id);
    if (!view) continue;
    const decl = toDeclaration(row);
    view.history.push(decl);
    view.current = decl.kinds.length > 0 ? decl.kinds : view.current;
  }
  return out;
}

/**
 * Validate and store one declaration. Unknown kinds and empty sets are refused here as well as
 * at the tool schema, so a caller that bypasses zod cannot store a kind outside the catalog.
 */
export async function declareChangeKinds(input: DeclareChangeKindsInput, sql?: Sql): Promise<DeclareChangeKindsResult> {
  const norm = normalizeChangeKinds(input.kinds);
  if (!norm.ok) {
    return {
      recorded: false,
      error:
        norm.reason === 'empty'
          ? 'changeKinds must name at least one kind'
          : `unknown change kind(s): ${norm.unknown.join(', ')}`,
    };
  }
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  try {
    const db = sqlOf(sql);
    const prev = await db<{ kinds: string[] }[]>`
      SELECT kinds FROM harness_shared.work_item_change_kind_declarations
       WHERE workspace_id = ${input.workspaceId} AND feature_id = ${input.featureId}
       ORDER BY declared_at DESC, id DESC
       LIMIT 1`;
    await db`
      INSERT INTO harness_shared.work_item_change_kind_declarations
        (workspace_id, feature_id, kinds, step, declared_by, reason)
      VALUES (${input.workspaceId}, ${input.featureId}, ${norm.kinds}, ${input.step}, ${input.declaredBy}, ${reason})`;
    const prevNorm = prev[0] ? normalizeChangeKinds(prev[0].kinds) : null;
    return {
      recorded: true,
      current: norm.kinds,
      step: input.step,
      previous: prevNorm && prevNorm.ok ? prevNorm.kinds : null,
    };
  } catch (err) {
    return { recorded: false, error: `change-kind declaration not stored: ${(err as Error).message}` };
  }
}

/** Kinds a caller declared for one requested item id (an item's own, else the call's default). */
export interface DeclaredChangeKinds {
  kinds: readonly string[];
  reason?: string | null;
}

/** Build the per-id declaration map, dropping entries that declared nothing. */
export function declaredChangeKindsById(
  items: readonly { id: string; changeKinds?: readonly string[] | null; changeKindReason?: string | null }[],
): Map<string, DeclaredChangeKinds> {
  const out = new Map<string, DeclaredChangeKinds>();
  for (const it of items) {
    if (it.changeKinds?.length) out.set(it.id, { kinds: it.changeKinds, reason: it.changeKindReason ?? null });
  }
  return out;
}

/** The fields of a bulk tool result this helper reads. */
export interface ChangeKindResultLike {
  ok: boolean;
  id?: unknown;
  workItem?: unknown;
  [k: string]: unknown;
}

/**
 * Per-result verdict: `true` records the declaration, a string attaches
 * `{ recorded:false, error }` naming why it was not recorded, and `false` leaves the result
 * untouched (for example a validate-only preview, which writes nothing).
 */
export type ChangeKindEligibility<R> = (result: R) => true | false | string;

/** claim and checkpoint: record only when the write itself succeeded. */
export function writeSucceededEligibility(what: string): ChangeKindEligibility<ChangeKindResultLike> {
  return (r) => (r.ok ? true : `the ${what} did not succeed`);
}

/**
 * work_items:complete: record whenever the call wrote a completion record, even when the
 * terminal transition was then refused (`ok:false` with `completion` present). The proof gate
 * (P-002) reads the declaration, so a refused close must not make the agent declare again. A
 * validate-only preview writes nothing, and a result without a completion record (not found,
 * not held, refused before persistence) stores nothing.
 */
export const completeChangeKindEligibility: ChangeKindEligibility<ChangeKindResultLike> = (r) => {
  if (r.validationOnly === true) return false;
  return r.completion ? true : 'this call wrote no completion record';
};

/**
 * Record the declared kinds for each result of a bulk work_items write and attach the outcome
 * as `changeKinds` on that result. Results are matched to declarations by the requested id
 * runBulk echoes; the row is stored under the canonical `workItem.id` when the result carries
 * one. Never throws: a storage failure is reported on the result by `declareChangeKinds`.
 */
export async function attachChangeKindDeclarations<R extends ChangeKindResultLike>(
  input: {
    declared: ReadonlyMap<string, DeclaredChangeKinds>;
    results: readonly R[];
    step: ChangeKindStep;
    declaredBy: string;
    workspaceId: string;
    eligible: ChangeKindEligibility<R>;
  },
  sql?: Sql,
): Promise<R[]> {
  if (input.declared.size === 0) return [...input.results];
  return Promise.all(
    input.results.map(async (r) => {
      const declared = typeof r.id === 'string' ? input.declared.get(r.id) : undefined;
      if (!declared) return r;
      const verdict = input.eligible(r);
      if (verdict === false) return r;
      if (verdict !== true) {
        return { ...r, changeKinds: { recorded: false as const, error: `changeKinds were not recorded: ${verdict}.` } };
      }
      const canonical = (r.workItem as { id?: unknown } | undefined)?.id;
      const featureId = typeof canonical === 'string' && canonical ? canonical : (r.id as string);
      const changeKinds = await declareChangeKinds(
        {
          workspaceId: input.workspaceId,
          featureId,
          kinds: declared.kinds,
          step: input.step,
          declaredBy: input.declaredBy,
          reason: declared.reason ?? null,
        },
        sql,
      );
      return { ...r, changeKinds };
    }),
  );
}
