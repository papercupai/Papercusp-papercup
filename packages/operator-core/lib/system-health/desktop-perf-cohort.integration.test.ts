import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

// This is the authoring source copied into the stored rubric, not a second
// implementation of its cohort rules. Exercise PostgreSQL's actual aggregates.
const template = readFileSync(new URL('./__fixtures__/performance-native-cohort.sql', import.meta.url), 'utf8');
const BUILD = '606d876460347c14831d2d9dc7dd200a7a5478e4';
const METRIC = 'web-vital:LCP';
const runIds = Array.from({ length: 5 }, (_, i) => `native-${i}`);
let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); }, 180_000);
afterAll(async () => { await db?.cleanup(); });

function freshRows() {
  return runIds.map((run_id, i) => ({
    id: `row-${i}`, created_ts: Date.now() - 10_000 + i,
    status: 'pass', build_sha: BUILD, run_id,
    workspace_id: 'papercusp-workspace', source: 'wdio',
    measures: [{ key: METRIC, value: 1000, unit: 'ms', budget: 4000, ok: true }],
  }));
}

async function measure(rows: ReturnType<typeof freshRows>, verified = runIds) {
  const sql = template.replaceAll('__CANDIDATE_BUILD__', BUILD)
    .replaceAll('__VERIFIED_RUN_IDS__', verified.map(id => `'${id}'`).join(','))
    .replaceAll('__METRIC_KEY__', METRIC).replaceAll('__BUDGET_MS__', '4000');
  const query = sql.replace('WITH pin AS (', `WITH fixture AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text,created_ts bigint,
      status text,build_sha text,run_id text,workspace_id text,source text,measures jsonb)
  ), pin AS (`).replace('harness_shared.desktop_perf_runs r', 'fixture r');
  const result = await db.adminSql.unsafe(query, [JSON.stringify(rows)]);
  return result[0] as { budget_pct: number | null; attempt_n: number; distinct_run_n: number };
}

describe('native performance rubric cohort SQL (EI-27708341940284820)', () => {
  it('measures five distinct, fresh, explicitly verified runs of the pinned build', async () => {
    expect(await measure(freshRows())).toMatchObject({ budget_pct: 25, attempt_n: 5, distinct_run_n: 5 });
  });

  it('does not count five posts of one native run as five samples', async () => {
    const rows = freshRows().map(row => ({ ...row, run_id: runIds[0] }));
    expect(await measure(rows)).toMatchObject({ budget_pct: null, distinct_run_n: 1 });
  });

  it('rejects reused run identities even if their older post is outside the sample window', async () => {
    const rows = freshRows();
    rows.push({ ...rows[0], id: 'old-duplicate', created_ts: Date.now() - 23 * 3600_000 });
    expect((await measure(rows)).budget_pct).toBeNull();
  });

  it('does not let one fresh sample revive four stale samples', async () => {
    const rows = freshRows();
    for (const row of rows.slice(0, 4)) row.created_ts = Date.now() - 23 * 3600_000;
    expect(await measure(rows)).toMatchObject({ budget_pct: null, attempt_n: 1 });
  });

  it('does not substitute a different measured build', async () => {
    const rows = freshRows().map(row => ({ ...row, build_sha: 'old-build' }));
    expect(await measure(rows)).toMatchObject({ budget_pct: null, attempt_n: 0 });
  });

  it('requires the verified-run pin even when recent matching measurements exist', async () => {
    expect((await measure(freshRows(), [])).budget_pct).toBeNull();
  });

  it.each(['missing', 'duplicate', 'wrong-unit', 'negative', 'infinite'])('rejects a %s latest measurement', async kind => {
    const rows = freshRows();
    const last = rows[4];
    if (kind === 'missing') last.measures = [];
    if (kind === 'duplicate') last.measures.push({ ...last.measures[0] });
    if (kind === 'wrong-unit') last.measures[0].unit = 'count';
    if (kind === 'negative') last.measures[0].value = -1;
    // The ingest route rejects non-finite values; also fail closed for legacy
    // rows containing the PostgreSQL-readable JSON string.
    if (kind === 'infinite') (last.measures[0] as unknown as { value: string }).value = 'Infinity';
    expect((await measure(rows)).budget_pct).toBeNull();
  });

  it('does not fall back around a future latest attempt', async () => {
    const rows = freshRows();
    rows[4].created_ts = Date.now() + 3600_000;
    expect((await measure(rows)).budget_pct).toBeNull();
  });

  it('does not turn a failed native run with a fast timing into a pass', async () => {
    const rows = freshRows();
    rows[4].status = 'fail';
    expect((await measure(rows)).budget_pct).toBeNull();
  });

  it.each([5000, 8000])('retains a measured breach of %ims from failed native runs', async value => {
    const rows = freshRows();
    for (const row of rows) { row.status = 'fail'; row.measures[0].value = value; row.measures[0].ok = false; }
    expect((await measure(rows)).budget_pct).toBe(value / 4000 * 100);
  });
});
