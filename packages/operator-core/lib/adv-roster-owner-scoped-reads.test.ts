/**
 * WI-10005228: the roster's per-owner joins must read only the owners being
 * rendered, never every row ever written.
 *
 * `harness_shared.session_briefs` keeps one row per owner EVER seen (14,160 on
 * 2026-10-02 against ~100 live agents), and the roster is rebuilt ~15-19 times a
 * minute. The harnessSlug fallback used to read the whole table on every build
 * (`WHERE harness_slug IS NOT NULL`) although mergeRosterEntries only looks it up
 * by a presence owner. These tests pin the owner-scoped shape: the fake below
 * returns EVERY stored row for any query that is not an `owner_id = ANY(...)`
 * probe, so a regression to an unscoped read shows up as entries for owners the
 * caller never asked about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));

import { getOrgPg } from '@papercusp/db-org';
import { mockOrgPgSql } from './testing/mock-org-pg';
import { sessionBriefHarnessByOwner } from './adv-roster';

type BriefRow = { owner_id: string; harness_slug: string | null };

function fakeBriefs(rows: BriefRow[]) {
  const sql = vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join('?');
    if (/owner_id\s*=\s*ANY\(/.test(q)) {
      const ids = new Set(vals[0] as string[]);
      return Promise.resolve(rows.filter((r) => ids.has(r.owner_id) && r.harness_slug !== null));
    }
    return Promise.resolve(rows.filter((r) => r.harness_slug !== null));
  });
  return sql;
}

let sql: ReturnType<typeof fakeBriefs>;
beforeEach(() => {
  sql = fakeBriefs([
    { owner_id: 'su-live-1', harness_slug: 'papercusp' },
    { owner_id: 'su-live-2', harness_slug: null },
    ...Array.from({ length: 40 }, (_, i) => ({ owner_id: `su-ended-${i}`, harness_slug: 'papercusp' })),
  ]);
  mockOrgPgSql(vi.mocked(getOrgPg), sql);
});
afterEach(() => vi.clearAllMocks());

describe('sessionBriefHarnessByOwner — owner-scoped (WI-10005228)', () => {
  it('returns the harness for exactly the requested owners that have one', async () => {
    const out = await sessionBriefHarnessByOwner(['su-live-1', 'su-live-2', 'su-unknown']);
    expect([...out.entries()]).toEqual([['su-live-1', 'papercusp']]);
  });

  it('issues ONE owner_id = ANY probe with the de-duplicated ids', async () => {
    await sessionBriefHarnessByOwner(['su-live-1', 'su-live-1', '', 'su-live-2']);
    expect(sql).toHaveBeenCalledTimes(1);
    const [strings, ...vals] = sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/owner_id\s*=\s*ANY\(/);
    expect(vals[0]).toEqual(['su-live-1', 'su-live-2']);
  });

  it('calibration: the fake answers the OLD unscoped read with every brief ever written', async () => {
    // Keeps the first test from passing vacuously: the pre-WI-10005228 query shape
    // through this same fake returns all 41 non-null rows, ended owners included.
    const rows = (await sql`SELECT owner_id, harness_slug FROM harness_shared.session_briefs
       WHERE harness_slug IS NOT NULL`) as BriefRow[];
    expect(rows).toHaveLength(41);
  });

  it('an empty roster costs no query at all', async () => {
    expect(await sessionBriefHarnessByOwner([])).toEqual(new Map());
    expect(sql).not.toHaveBeenCalled();
  });

  it('a read error degrades to an empty map (null harnessSlug), never a thrown roster build', async () => {
    sql.mockImplementationOnce(() => Promise.reject(new Error('pg down')));
    expect(await sessionBriefHarnessByOwner(['su-live-1'])).toEqual(new Map());
  });
});
