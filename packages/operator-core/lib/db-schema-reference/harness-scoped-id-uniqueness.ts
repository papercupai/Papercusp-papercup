/**
 * harness-scoped-id-uniqueness.ts — detects a harness_shared table whose id is
 * unique only together with `harness_slug` (scope-unique-identifiers-2026-07-26
 * P-007, ruling #D-014).
 *
 * The hazard: an id that appears in prose, coord messages or a by-id tool must name
 * one row per workspace. A UNIQUE index on (harness_slug, <id>) admits the same id
 * once per harness, which is how work_items grew same-workspace twins that by-id
 * reads then resolved arbitrarily (P-008..P-013 of that plan).
 *
 * Detection reads the materialized fresh-install index census
 * (`./index-manifest.ts`), not migration text: the manifest is what a database
 * with every migration applied actually has, and
 * apps/operator/test/schema-object-drift.integration.test.ts keeps it honest.
 *
 * A finding is a harness_shared UNIQUE index that
 *   1. includes the plain column `harness_slug`, and
 *   2. includes at least one id-shaped column (`id` or `*_id`, but not `*user_id`,
 *      which is an external principal key rather than a row identity), and
 *   3. has no NON-partial unique index on the same table that omits
 *      `harness_slug` and covers those id-shaped columns (`workspace_id` allowed).
 *
 * Tables named `bak_*` are migration-owned snapshots and are skipped.
 */
import type { IndexCensusEntry } from '../schema-object-drift';

export interface HarnessScopedIdUniqueness {
  /** `<table>.<index>` — the stable key the baseline and allowlist use. */
  readonly key: string;
  readonly table: string;
  readonly index: string;
  readonly columns: readonly string[];
  readonly idColumns: readonly string[];
  readonly partial: boolean;
}

interface ParsedIndex {
  readonly columns: readonly string[];
  readonly where: string | null;
}

/** Split `CREATE UNIQUE INDEX … USING btree (a, (expr, x), b) WHERE …` into its column list. */
export function parseIndexColumns(definition: string): ParsedIndex | null {
  const using = definition.match(/ USING \w+ \(/);
  if (!using || using.index === undefined) return null;
  const start = using.index + using[0].length;
  let depth = 1;
  let cur = '';
  const columns: string[] = [];
  let i = start;
  for (; i < definition.length; i++) {
    const ch = definition[i];
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) break;
    }
    if (ch === ',' && depth === 1) {
      columns.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (depth !== 0) return null;
  if (cur.trim()) columns.push(cur.trim());
  const rest = definition.slice(i + 1);
  const where = rest.match(/^\s*WHERE (.*)$/s);
  return { columns, where: where ? where[1] : null };
}

const ID_SHAPED = /^(id|[a-z0-9_]*_id)$/;

function isIdShaped(column: string): boolean {
  return ID_SHAPED.test(column) && !column.endsWith('user_id');
}

export function findHarnessScopedIdUniqueness(
  indexes: readonly IndexCensusEntry[],
): HarnessScopedIdUniqueness[] {
  const unique = indexes.filter(
    (entry) => entry.schema === 'harness_shared' && /^CREATE UNIQUE INDEX /.test(entry.definition),
  );
  const byTable = new Map<string, { entry: IndexCensusEntry; parsed: ParsedIndex }[]>();
  for (const entry of unique) {
    const parsed = parseIndexColumns(entry.definition);
    if (!parsed) continue;
    const list = byTable.get(entry.table) ?? [];
    list.push({ entry, parsed });
    byTable.set(entry.table, list);
  }
  const findings: HarnessScopedIdUniqueness[] = [];
  for (const [table, list] of byTable) {
    if (table.startsWith('bak_')) continue;
    for (const { entry, parsed } of list) {
      if (!parsed.columns.includes('harness_slug')) continue;
      const rest = parsed.columns.filter((c) => c !== 'harness_slug' && c !== 'workspace_id');
      const idColumns = rest.filter(isIdShaped);
      if (idColumns.length === 0) continue;
      const covered = list.some(
        ({ parsed: other }) =>
          other.where === null &&
          !other.columns.includes('harness_slug') &&
          other.columns.some((c) => c !== 'workspace_id') &&
          other.columns.every((c) => c === 'workspace_id' || rest.includes(c)),
      );
      if (covered) continue;
      findings.push({
        key: `${table}.${entry.name}`,
        table,
        index: entry.name,
        columns: parsed.columns,
        idColumns,
        partial: parsed.where !== null,
      });
    }
  }
  return findings.sort((a, b) => a.key.localeCompare(b.key));
}
