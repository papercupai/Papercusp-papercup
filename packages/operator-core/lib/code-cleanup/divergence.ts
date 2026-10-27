/**
 * Diverged-copy bug filing (code-cleanup-campaigns-2026-10-26 P-010, R-5).
 *
 * Triage (P-005, `triage.ts`) never batches a DIVERGED clone family — one copy carries a
 * statement, typically a guard, that the other lacks — until a bug naming both locations is
 * terminal. This module is the other half of that contract:
 *
 *  - `fileDivergedCopyBugs` files one `bug` per diverged pair triage reported, keyed by the
 *    pair's order-independent condition key (`divergedCopyConditionKey`). The filing goes
 *    through `upsertConditionWorkItem`, so a re-run refreshes the open bug instead of filing
 *    a second one, and concurrent filers settle on one row.
 *  - `divergenceBugLookup` is the `DivergenceBugLookup` triage reads: an open bug holds the
 *    family, a terminal bug releases it for batching, no bug means "file one first".
 *
 * The ordering is the point: the bug is filed BEFORE any merge, because merging the two copies
 * first would silently drop the guard (or duplicate the bug into the shared extraction).
 */
import type { DivergedHold, DivergenceBug, DivergenceBugLookup, TriageLocation } from './triage';

/** Actor recorded as the creator of every diverged-copy bug. */
export const DIVERGED_COPY_FILER = 'system:code-cleanup-triage';
/** Payload key carrying the structured pair on the filed bug. */
export const DIVERGED_COPY_PAYLOAD_KEY = 'divergedCopy';

const MAX_LISTED_STATEMENTS = 10;
const MAX_STATEMENT_CHARS = 200;

const at = (l: TriageLocation) => `${l.path}:${l.line} ${l.symbol}`;
const clip = (s: string) => (s.length > MAX_STATEMENT_CHARS ? `${s.slice(0, MAX_STATEMENT_CHARS - 1)}…` : s);

/** Title and summary of the bug for one diverged pair. Both locations are always named. */
export function divergedCopyBugText(hold: DivergedHold): { title: string; summary: string } {
  const [richer, poorer] = hold.locations;
  const what = hold.guard ? 'a guard' : `${hold.extra.length} statement${hold.extra.length === 1 ? '' : 's'}`;
  const title = `Diverged copy: ${poorer.symbol} (${poorer.path}) lacks ${what} its copy ${richer.symbol} (${richer.path}) has`;
  const listed = hold.extra.slice(0, MAX_LISTED_STATEMENTS).map(s => `  - ${clip(s)}`);
  const more = hold.extra.length > MAX_LISTED_STATEMENTS ? [`  - … ${hold.extra.length - MAX_LISTED_STATEMENTS} more`] : [];
  const summary = [
    `Clone family ${hold.familyId} diverged: one copy carries ${what} the other lacks, so the copy without it is a likely live bug.`,
    '',
    `- has it: ${at(richer)}`,
    `- lacks it: ${at(poorer)}`,
    '',
    `Statements only in ${richer.symbol}:`,
    ...listed, ...more,
    '',
    'No cleanup batch merges this family until this bug is terminal. Fix it by adding the missing statement(s) to the copy that lacks them, '
      + 'or close it with the reason the difference is intended.',
  ].join('\n');
  return { title, summary };
}

export interface DivergedBugInput {
  kind: 'bug';
  title: string;
  summary: string;
  harness: string;
  workspaceId: string;
  severity: 'major' | 'minor';
  createdBy: string;
  payload: Record<string, unknown>;
}
export type DivergedBugUpsert = (conditionKey: string, input: DivergedBugInput) =>
  Promise<{ id: string | null; created: boolean; duplicateLeftOpen?: string }>;

export interface DivergedFilingRow {
  familyId: string;
  conditionKey: string;
  bugId: string;
  disposition: 'created' | 'reused';
}

/**
 * File (or refresh) the bug for every diverged pair triage held. Idempotent: the condition key
 * is order-independent, so the same pair always resolves to the same bug.
 */
export async function fileDivergedCopyBugs(
  holds: readonly DivergedHold[],
  scope: { workspaceId: string; harness: string },
  deps: { upsert?: DivergedBugUpsert } = {},
): Promise<DivergedFilingRow[]> {
  if (!scope.workspaceId.trim() || !scope.harness.trim()) throw new Error('Diverged-copy filing scope required');
  const upsert = deps.upsert ?? await defaultUpsert(scope.workspaceId);
  const rows: DivergedFilingRow[] = [];
  for (const hold of holds) {
    if (!hold.conditionKey.trim()) throw new Error(`Diverged family ${hold.familyId} has no condition key`);
    const { title, summary } = divergedCopyBugText(hold);
    const [richer, poorer] = hold.locations;
    const result = await upsert(hold.conditionKey, {
      kind: 'bug', title, summary, harness: scope.harness, workspaceId: scope.workspaceId,
      severity: hold.guard ? 'major' : 'minor', createdBy: DIVERGED_COPY_FILER,
      payload: {
        [DIVERGED_COPY_PAYLOAD_KEY]: { familyId: hold.familyId, has: richer, lacks: poorer, extra: hold.extra, guard: hold.guard },
        tags: ['clone-diverged'],
      },
    });
    if (result.duplicateLeftOpen) throw new Error(`Diverged-copy bug duplicate remains open: ${result.duplicateLeftOpen}`);
    if (!result.id) throw new Error(`Diverged-copy filing returned no identity: ${hold.conditionKey}`);
    rows.push({ familyId: hold.familyId, conditionKey: hold.conditionKey, bugId: result.id, disposition: result.created ? 'created' : 'reused' });
  }
  return rows;
}

/** One stored bug for a condition key, with terminality decided by the reader. */
export interface DivergenceBugRow { id: string; terminal: boolean }
export type DivergenceBugRows = (conditionKey: string) => Promise<readonly DivergenceBugRow[]>;

/** Decide triage's view of a pair from its stored bugs: any open bug holds; otherwise a terminal one releases. */
export function divergenceBugFromRows(rows: readonly DivergenceBugRow[]): DivergenceBug {
  const open = rows.find(r => !r.terminal);
  if (open) return { status: 'open', id: open.id };
  const terminal = rows.find(r => r.terminal);
  return terminal ? { status: 'terminal', id: terminal.id } : { status: 'missing' };
}

/** The `DivergenceBugLookup` triage reads, backed by the work-item store (or an injected reader). */
export function divergenceBugLookup(scope: { workspaceId: string }, deps: { rows?: DivergenceBugRows } = {}): DivergenceBugLookup {
  if (!scope.workspaceId.trim()) throw new Error('Divergence lookup needs a workspace');
  const read = deps.rows ?? ((key: string) => readDivergenceBugRows(scope.workspaceId, key));
  return async (conditionKey: string) => divergenceBugFromRows(await read(conditionKey));
}

/**
 * Stored bugs filed for a condition key. The key column is cleared when a bug closes, so the
 * filing marker is read too. A row the condition upsert itself dropped (a lost filing race) is a
 * duplicate, not a disposition, and is ignored.
 */
async function readDivergenceBugRows(workspaceId: string, conditionKey: string): Promise<DivergenceBugRow[]> {
  const [{ getOrgPg }, { ANY_FAMILY_TERMINAL_STATES }, { CONDITION_UPSERT_MARKER, CONDITION_UPSERT_ACTOR }] = await Promise.all([
    import('@papercusp/db-org'), import('../work-item-dispatch-states'), import('../coord/condition-upsert')]);
  const rows = await getOrgPg().sql<{ feature_id: string; terminal: boolean }[]>`
    SELECT feature_id, (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])) AS terminal
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND COALESCE(item_kind, kind) = 'bug'
       AND (condition_key = ${conditionKey} OR payload -> ${CONDITION_UPSERT_MARKER}::text ->> 'conditionKey' = ${conditionKey})
       AND COALESCE(terminal_owner, '') <> ${CONDITION_UPSERT_ACTOR}
     ORDER BY created_ts, feature_id`;
  return rows.map(r => ({ id: r.feature_id, terminal: r.terminal }));
}

async function defaultUpsert(workspaceId: string): Promise<DivergedBugUpsert> {
  const [{ activeWorkspaceId }, { upsertConditionWorkItem }] = await Promise.all([
    import('../workspace-registry'), import('../coord/condition-upsert')]);
  // Issue-family creates use the ambient workspace; refuse a misbound caller before minting a row.
  if (activeWorkspaceId() !== workspaceId) throw new Error('Diverged-copy filing ambient workspace mismatch');
  return (conditionKey, input) => upsertConditionWorkItem(conditionKey, input);
}
