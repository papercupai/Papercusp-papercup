import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  R3_LOOKUPS,
  R3_MAX_MS,
  explainTop,
  judgeLookup,
  judgeR3,
} from './settlement-lookup-explain-live-oracle.mjs';

// AUTO-BAR-R-3-P-002@3 (event-wait-settlement-2026-10-20): the live probe's oracle, and the pins that keep
// its index names equal to migration 1539 and the probe wired to this oracle.
const MIGRATION = resolve(__dirname, '../../libs/papercusp/libs/db/sql/1539-work-items-wait-ref-indexes.sql');
const PROBE = resolve(__dirname, '../../docs/evidence/ews-p002-r3-settlement-lookup-live-2026-10-20.mts');

const EXT = 'work_items_external_blockers_gin_idx';
const PARK = 'work_items_claim_hold_release_trigger_idx';

// The shapes measured live on 2026-10-21 (408,598 rows): LockRows > Bitmap Heap Scan > Bitmap Index Scan.
const bitmap = (index: string, ms: number) => ({
  Plan: {
    'Node Type': 'LockRows',
    'Shared Hit Blocks': 241,
    'Shared Read Blocks': 0,
    Plans: [
      {
        'Node Type': 'Bitmap Heap Scan',
        'Relation Name': 'work_items',
        Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': index }],
      },
    ],
  },
  'Execution Time': ms,
});
const seqScan = (ms: number) => ({
  Plan: { 'Node Type': 'LockRows', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'work_items' }] },
  'Execution Time': ms,
});
const failing = (top: ReturnType<typeof bitmap>, index = EXT) =>
  judgeLookup(top, { index })
    .assertions.filter((a) => !a.passed)
    .map((a) => a.id);

describe('R-3 settlement-lookup EXPLAIN live oracle (event-wait-settlement-2026-10-20 AUTO-BAR-R-3-P-002)', () => {
  it('passes an index-backed lookup under the threshold', () => {
    const v = judgeLookup(bitmap(EXT, 1.591), { index: EXT });
    expect(v.passed).toBe(true);
    expect(v.indexes).toEqual([EXT]);
    expect(v.nodes).toEqual(['LockRows', 'Bitmap Heap Scan[work_items]', `Bitmap Index Scan(${EXT})`]);
  });

  it('fails a sequential scan of work_items (the clause falsifier)', () => {
    expect(failing(seqScan(1) as never)).toEqual(['no-seq-scan-on-work-items', 'reads-wait-ref-index']);
  });

  it('fails a lookup slower than the threshold even when it uses the index', () => {
    expect(failing(bitmap(EXT, R3_MAX_MS + 0.001))).toEqual(['within-threshold']);
    expect(failing(bitmap(EXT, 98))).toEqual(['within-threshold']);
  });

  it('fails a lookup that reads some other index instead of the wait-ref index', () => {
    expect(failing(bitmap('work_items_pkey', 0.5))).toEqual(['reads-wait-ref-index']);
    expect(failing(bitmap(PARK, 0.5), EXT)).toEqual(['reads-wait-ref-index']);
  });

  it('judges the whole reading and fails when either lookup fails or is missing', () => {
    expect(judgeR3({ externalBlockers: bitmap(EXT, 1.6), durableParks: bitmap(PARK, 0.03) }).passed).toBe(true);
    expect(judgeR3({ externalBlockers: bitmap(EXT, 1.6), durableParks: seqScan(0.2) as never }).passed).toBe(false);
    expect(() => judgeR3({ externalBlockers: bitmap(EXT, 1.6) })).toThrow(/durableParks/);
  });

  it('refuses a result that is not an EXPLAIN ANALYZE plan instead of judging it', () => {
    expect(() => explainTop([])).toThrow(/QUERY PLAN/);
    expect(() => explainTop([{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan' } }] }])).toThrow(/ANALYZE/);
    expect(explainTop([{ 'QUERY PLAN': [bitmap(EXT, 1)] }])['Execution Time']).toBe(1);
  });

  it('pins each expected index to a CREATE INDEX in migration 1539', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    for (const { index } of R3_LOOKUPS) {
      expect(sql).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`));
    }
    expect(R3_LOOKUPS.map((l) => l.name)).toEqual(['externalBlockers', 'durableParks']);
  });

  it('pins the live probe to this oracle, so the committed receipt is judged here', () => {
    const probe = readFileSync(PROBE, 'utf8');
    expect(probe).toMatch(/settlement-lookup-explain-live-oracle\.mjs/);
    expect(probe).toMatch(/judgeR3\(/);
    expect(probe).not.toMatch(/'Execution Time'\] <= /);
  });
});
