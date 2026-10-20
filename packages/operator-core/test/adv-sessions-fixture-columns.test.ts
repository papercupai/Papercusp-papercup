/**
 * Recurrence guard for WI-6554700010018179.
 *
 * `ADV_SESSIONS_CLAIM_MIN_DDL` (test/_work-items-schema.ts) is a HAND-ROLLED copy of
 * `harness_shared.adv_sessions` that every claim-path integration fixture builds. When a
 * migration adds a column and a production reader starts selecting it, the fixture
 * silently lags: the reader fails with `column "<x>" does not exist`,
 * adv-sessions.ts logs a console.warn, and vitest-fail-on-console fails whichever
 * claim-path test happened to trigger the read. Migration 1492 (retired_at /
 * retired_by / retired_reason) did exactly this to
 * claim-next-miss-diagnosis.integration.test.ts, and WI-10005130 was the same class
 * one migration earlier.
 *
 * This test needs no database. It extracts every plain column the adv_sessions
 * readers on the claim path SELECT and requires each to exist in the fixture DDL,
 * so the next reader-side column addition fails here, naming the column,
 * instead of as a console.warn in an unrelated integration file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADV_SESSIONS_CLAIM_MIN_DDL } from './_work-items-schema';

/** Readers the claim doors reach (latestAdvSessionByCoordOwner, the lapse/takeover
 *  listers, readActiveOperationWorkerClaimBinding). */
const READER_FILES = ['../lib/adv-sessions.ts', '../lib/blueprint/operation-worker-binding.ts'];

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Collapse `${…}` interpolations and parenthesised groups (function calls, subqueries,
 *  DISTINCT ON lists) to a `§` marker, so a comma split yields one entry per select-list
 *  item and an expression item is recognisable by the marker. */
function stripNested(text: string): string {
  let out = text.replace(/\$\{[^{}]*\}/g, '§');
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/\([^()]*\)/g, '§');
  }
  return out;
}

/** Every plain column named in a `SELECT … FROM harness_shared.adv_sessions [alias]` list.
 *  Expressions and `*` are skipped and `col AS x` reduces to `col`. A qualified `q.col` counts
 *  only when `q` is the adv_sessions alias: `candidate.receipt` from a lateral subquery is not
 *  an adv_sessions column. */
export function selectedAdvSessionColumns(source: string): { columns: Set<string>; selects: number } {
  const columns = new Set<string>();
  let selects = 0;
  const re =
    /\bSELECT\s+((?:(?!\bSELECT\b|\bFROM\b)[\s\S])*?)\s+FROM\s+harness_shared\.adv_sessions\b(?:\s+(?:AS\s+)?(?!(?:where|join|cross|left|inner|order|group|limit|for|on|union|returning|natural|full|right|window|having|offset)\b)([a-z_]\w*))?/gi;
  for (const match of source.matchAll(re)) {
    selects += 1;
    const alias = match[2]?.toLowerCase() ?? null;
    const list = stripNested(match[1]).replace(/^\s*DISTINCT(\s+ON\s*§)?/i, ' ');
    for (const raw of list.split(',')) {
      const item = raw.trim().replace(/\s+AS\s+\w+$/i, '').trim();
      if (item.includes('§')) continue; // an expression, not a plain column
      const qualified = /^(\w+)\.(\w+)$/.exec(item);
      if (qualified && qualified[1].toLowerCase() !== alias) continue; // another relation's column
      const column = qualified ? qualified[2] : item;
      if (IDENT.test(column)) columns.add(column);
    }
  }
  return { columns, selects };
}

/** Columns the fixture DDL defines: the CREATE TABLE body plus every ADD COLUMN. */
export function fixtureColumns(ddl: string): Set<string> {
  const columns = new Set<string>();
  const create = /CREATE TABLE IF NOT EXISTS harness_shared\.adv_sessions\s*\(([\s\S]*?)\n\s*\);/i.exec(ddl);
  for (const line of (create?.[1] ?? '').split('\n')) {
    const name = /^\s*([a-z_][a-z0-9_]*)\s+\w/i.exec(line)?.[1];
    if (name) columns.add(name);
  }
  for (const m of ddl.matchAll(/ADD COLUMN IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)) columns.add(m[1]);
  return columns;
}

describe('ADV_SESSIONS_CLAIM_MIN_DDL covers every column the claim-path adv_sessions readers select', () => {
  const fixture = fixtureColumns(ADV_SESSIONS_CLAIM_MIN_DDL);

  it('the extractors read real data (positive control, so an empty parse cannot pass vacuously)', () => {
    const { columns, selects } = selectedAdvSessionColumns(
      readFileSync(resolve(__dirname, READER_FILES[0]), 'utf8'),
    );
    expect(selects).toBeGreaterThan(5);
    for (const known of ['coord_owner_id', 'started_at', 'retired_at']) expect(columns).toContain(known);
    for (const known of ['id', 'workspace_id', 'coord_owner_id', 'ended_signal']) expect(fixture).toContain(known);
  });

  it.each(READER_FILES)('%s selects no column the fixture lacks', (file) => {
    const { columns } = selectedAdvSessionColumns(readFileSync(resolve(__dirname, file), 'utf8'));
    const missing = [...columns].filter((c) => !fixture.has(c)).sort();
    expect(
      missing,
      `add [${missing.join(', ')}] to ADV_SESSIONS_CLAIM_MIN_DDL (test/_work-items-schema.ts) with the live column types`,
    ).toEqual([]);
  });
});
