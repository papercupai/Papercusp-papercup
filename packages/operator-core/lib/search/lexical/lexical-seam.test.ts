/**
 * The BM25_LEXICAL_RANKING kill-switch on the lexical seam (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-10, P-007).
 *
 * With the flag off, `lexicalLeg` must hand back the caller's legacy ts_rank fragments
 * unchanged and order by them, whatever BM25 indexes the database has. With it on, BM25
 * ranks only a corpus whose index is present. The SQL handle is a recording fake, so this
 * runs without a database; the BM25 orderings themselves are pinned against a real
 * pg_textsearch server in bm25-ranking.integration.test.ts.
 */
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flag = vi.hoisted(() => ({ value: true as boolean | Error, reads: 0 }));

vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual,
    getFlag: async () => {
      flag.reads += 1;
      if (flag.value instanceof Error) throw flag.value;
      return flag.value;
    },
  };
});

import { DARK_FLAGS, FLAG_DEFAULTS, FLAGS } from '@papercusp/flags';
import { lexicalEngine, lexicalLeg, resetBm25Availability } from './rank';

interface Fragment { text: string; values: unknown[] }

/**
 * A stand-in for a postgres.js handle. Tagged-template calls return a fragment that records
 * its text; awaiting one runs it, and only the BM25 catalog read returns rows.
 */
function fakeSql(indexes: string[]): { sql: Sql; catalogReads: () => number } {
  let catalogReads = 0;
  const render = (strings: TemplateStringsArray, values: unknown[]): string =>
    strings.reduce((acc, s, i) => {
      const v = values[i];
      const piece = i < values.length
        ? (v && typeof v === 'object' && 'text' in (v as object) ? (v as Fragment).text : `$${i + 1}`)
        : '';
      return acc + s + piece;
    }, '');
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = render(strings, values);
    const fragment: Fragment & PromiseLike<unknown[]> = {
      text,
      values,
      then(onOk, onErr) {
        if (/pg_index/.test(text)) {
          catalogReads += 1;
          return Promise.resolve(indexes.map(name => ({ name }))).then(onOk, onErr);
        }
        return Promise.reject(new Error(`unexpected query in a unit test: ${text}`)).then(onOk, onErr);
      },
    };
    return fragment;
  };
  (tag as unknown as { unsafe: (s: string) => Fragment }).unsafe = (s: string) => ({ text: s, values: [] });
  return { sql: tag as unknown as Sql, catalogReads: () => catalogReads };
}

function legacyFor(sql: Sql) {
  return {
    score: sql`ts_rank_cd(w._search, plainto_tsquery('english', ${'quokka'}))`,
    match: sql`w._search @@ plainto_tsquery('english', ${'quokka'})`,
  };
}

const text = (f: unknown) => (f as Fragment).text;

describe('lexical seam kill-switch (R-10)', () => {
  beforeEach(() => {
    flag.value = true;
    flag.reads = 0;
    resetBm25Availability();
  });

  it('with the flag off, returns the legacy ts_rank_cd fragments verbatim and orders by them', async () => {
    flag.value = false;
    const { sql, catalogReads } = fakeSql(['work_items_bm25']);
    const legacy = legacyFor(sql);
    const leg = await lexicalLeg(sql, { table: 'work_items', query: 'quokka', alias: 'w', legacy });
    expect(leg.engine).toBe('legacy');
    expect(leg.score).toBe(legacy.score);
    expect(leg.match).toBe(legacy.match);
    expect(text(leg.order)).toBe(`${text(legacy.score)} DESC`);
    expect(text(leg.order)).toContain('ts_rank_cd');
    // The kill-switch wins before any catalog read: a present index does not matter.
    expect(catalogReads()).toBe(0);
  });

  it('with the flag on and the corpus index present, ranks with BM25 instead', async () => {
    const { sql } = fakeSql(['work_items_bm25']);
    const legacy = legacyFor(sql);
    const leg = await lexicalLeg(sql, { table: 'work_items', query: 'quokka', alias: 'w', legacy });
    expect(leg.engine).toBe('bm25');
    expect(leg.score).not.toBe(legacy.score);
    expect(text(leg.order)).toContain("to_bm25query");
    expect(text(leg.order)).toContain("'harness_shared.work_items_bm25'");
    expect(text(leg.order)).not.toContain('ts_rank');
  });

  it('flipping the flag back off restores the legacy ordering on the same handle', async () => {
    const { sql } = fakeSql(['work_items_bm25']);
    expect(await lexicalEngine(sql, 'work_items')).toBe('bm25');
    flag.value = false;
    expect(await lexicalEngine(sql, 'work_items')).toBe('legacy');
    flag.value = true;
    expect(await lexicalEngine(sql, 'work_items')).toBe('bm25');
  });

  it('with the flag on but the corpus index missing, falls back to the legacy fragments', async () => {
    const { sql } = fakeSql(['code_recipes_bm25']);
    const legacy = legacyFor(sql);
    const leg = await lexicalLeg(sql, { table: 'work_items', query: 'quokka', alias: 'w', legacy });
    expect(leg.engine).toBe('legacy');
    expect(leg.score).toBe(legacy.score);
  });

  it('reads the flag on every call, so a flip takes effect without a restart', async () => {
    const { sql } = fakeSql(['work_items_bm25']);
    for (let i = 0; i < 3; i++) await lexicalEngine(sql, 'work_items');
    expect(flag.reads).toBe(3);
  });

  it('treats an unreadable flag as on (the flag store being down must not silently revert ranking)', async () => {
    flag.value = new Error('flag store unavailable');
    const { sql } = fakeSql(['work_items_bm25']);
    expect(await lexicalEngine(sql, 'work_items')).toBe('bm25');
  });
});

/**
 * SPEC-P-009 (P-009): with the BM25 flag at its DEFAULT value, the seam ranks with BM25.
 *
 * The flag resolves to its compiled default when no env override, test override, stored
 * override or PostHog answer exists (`getFlagAttestation` in @papercusp/flags/server, source
 * `compiled-default`). This block feeds the seam that real compiled default rather than a
 * hard-coded `true`, so moving the flag into DARK_FLAGS (which derives a default of OFF)
 * fails here instead of silently shipping ts_rank_cd as the default ordering.
 */
describe('lexical seam at the flag default (SPEC-P-009)', () => {
  const compiledDefault = FLAG_DEFAULTS[FLAGS.BM25_LEXICAL_RANKING];

  beforeEach(() => {
    flag.value = compiledDefault;
    flag.reads = 0;
    resetBm25Availability();
  });

  it('the BM25 flag defaults ON and is not parked in DARK_FLAGS', () => {
    expect(compiledDefault).toBe(true);
    expect(DARK_FLAGS.has(FLAGS.BM25_LEXICAL_RANKING)).toBe(false);
  });

  it('at the default, a corpus with its BM25 index ranks with BM25, never ts_rank_cd', async () => {
    const { sql } = fakeSql(['work_items_bm25']);
    const legacy = legacyFor(sql);
    const leg = await lexicalLeg(sql, { table: 'work_items', query: 'quokka', alias: 'w', legacy });
    expect(flag.reads).toBeGreaterThan(0);
    expect(leg.engine).toBe('bm25');
    expect(text(leg.order)).toContain("to_bm25query");
    expect(text(leg.order)).not.toContain('ts_rank');
  });
});
