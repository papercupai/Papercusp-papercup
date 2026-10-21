/**
 * Code familiarity for the consult relevance router
 * (plan code-intel-relevance-routing-2026-10-21, R-2 / P-002).
 *
 * Measures what each candidate actually DID with the files a question is about:
 *
 *   - edits — `edit_attribution_ledger` rows naming the file (strong signal);
 *   - reads — MCP code reads and code queries in `tool_invocations` whose
 *     arguments name the file (weak "familiarity" signal; the tool set is the
 *     one the code working set already uses, `WORKING_SET_TOOLS`).
 *
 * Counts are ALL-TIME (relevance-router D-007) and carry no time term (D-001
 * structural rule): an edit made months ago counts exactly like one made today.
 * One bounded query per source. The read leg runs under a statement timeout; on
 * timeout it is reported `unmeasured` and nobody gets read credit (plan D-002),
 * so a slow ledger can never be mistaken for "nobody read it".
 */
import type { Sql } from 'postgres';
import { WORKING_SET_TOOLS } from '../code-intelligence/working-set';

export interface CodeFamiliarity { edits: number; reads: number }

export interface CodeFamiliarityMeasurement {
  byOwner: Map<string, CodeFamiliarity>;
  edits: 'measured' | 'unmeasured';
  reads: 'measured' | 'unmeasured';
}

export const CODE_FAMILIARITY_READ_TIMEOUT_MS = 1_500;
export const CODE_FAMILIARITY_EDIT_TIMEOUT_MS = 2_000;
/** Edits saturate authorship at 2, reads at 8: one edit outweighs four reads. */
export const CODE_AUTHORSHIP_EDIT_SATURATION = 2;
export const CODE_AUTHORSHIP_READ_SATURATION = 8;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A question can name a partial path (`consult/relevance-router.ts`); the
 * ledgers record repo-relative ones. Match exact, or as a `/`-bounded suffix. */
export function familiarityFilePatterns(files: readonly string[]): { exact: string[]; suffix: string[] } {
  const clean = [...new Set(files.map((f) => f.replace(/^\.{0,2}\/+/, '').replace(/\/+$/, '')).filter((f) => f.length >= 3))];
  return { exact: clean, suffix: clean.map((f) => `%/${escapeLike(f)}`) };
}

/** Authorship contribution of code familiarity, in [0,1]. */
export function codeAuthorshipScore(f: CodeFamiliarity | undefined): number {
  if (!f) return 0;
  const score = f.edits / CODE_AUTHORSHIP_EDIT_SATURATION + f.reads / CODE_AUTHORSHIP_READ_SATURATION;
  return Math.max(0, Math.min(1, score));
}

async function withStatementTimeout<T>(sql: Sql, ms: number, work: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('statement_timeout', ${`${Math.max(10, Math.floor(ms))}ms`}, true)`;
    return work(tx as unknown as Sql);
  }) as Promise<T>;
}

export async function measureCodeFamiliarity(
  sql: Sql,
  input: {
    workspaceId: string;
    owners: readonly string[];
    files: readonly string[];
    readTimeoutMs?: number;
    editTimeoutMs?: number;
    /** Count only ledger rows strictly before this instant. The live router
     * omits it (everything known now counts); the offline replay passes each
     * routing's own timestamp so it never credits an edit made afterwards. */
    before?: string | null;
  },
): Promise<CodeFamiliarityMeasurement> {
  const before = input.before ?? null;
  const byOwner = new Map<string, CodeFamiliarity>();
  const owners = [...new Set(input.owners)];
  const { exact, suffix } = familiarityFilePatterns(input.files);
  if (owners.length === 0 || exact.length === 0) return { byOwner, edits: 'measured', reads: 'measured' };
  const entry = (owner: string) => {
    let row = byOwner.get(owner);
    if (!row) byOwner.set(owner, (row = { edits: 0, reads: 0 }));
    return row;
  };

  let edits: CodeFamiliarityMeasurement['edits'] = 'measured';
  try {
    const rows = await withStatementTimeout(sql, input.editTimeoutMs ?? CODE_FAMILIARITY_EDIT_TIMEOUT_MS, (tx) => tx`
      SELECT agent_id AS owner, count(*)::int AS c
        FROM harness_shared.edit_attribution_ledger
       WHERE workspace_id = ${input.workspaceId}
         AND agent_id = ANY(${owners}::text[])
         AND (file = ANY(${exact}::text[]) OR file LIKE ANY(${suffix}::text[]))
         AND (${before}::timestamptz IS NULL OR ts < ${before}::timestamptz)
    GROUP BY agent_id`) as unknown as Array<{ owner: string; c: number }>;
    for (const r of rows) entry(r.owner).edits = Number(r.c);
  } catch {
    edits = 'unmeasured';
  }

  let reads: CodeFamiliarityMeasurement['reads'] = 'measured';
  try {
    const argPatterns = exact.map((f) => `%${escapeLike(f)}%`);
    const rows = await withStatementTimeout(sql, input.readTimeoutMs ?? CODE_FAMILIARITY_READ_TIMEOUT_MS, (tx) => tx`
      SELECT coord_owner_id AS owner, count(*)::int AS c
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ANY(${owners}::text[])
         AND workspace_id = ${input.workspaceId}
         AND tool_name = ANY(${[...WORKING_SET_TOOLS]}::text[])
         AND args_json::text LIKE ANY(${argPatterns}::text[])
         AND (${before}::timestamptz IS NULL OR invoked_at < ${before}::timestamptz)
    GROUP BY coord_owner_id`) as unknown as Array<{ owner: string; c: number }>;
    for (const r of rows) entry(r.owner).reads = Number(r.c);
  } catch {
    reads = 'unmeasured';
    for (const row of byOwner.values()) row.reads = 0;
  }
  return { byOwner, edits, reads };
}
