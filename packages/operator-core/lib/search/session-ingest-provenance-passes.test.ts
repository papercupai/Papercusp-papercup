/**
 * Bounds on the turn-provenance re-derivation tick (WI-10006752).
 *
 * Every session_turns update is non-HOT, so one rewritten row costs an insert
 * into all 12 indexes. At the old 5,000 rows per statement a statement averaged
 * 124.7 s (max 711 s) and held its row locks that long, and a 4-pass tick ran
 * past the next 5-minute fire. These tests hold the three bounds that fix it:
 * a small batch (lock-hold time), a per-tick wall-clock budget below the tick
 * interval, and a per-tick volume cap no larger than before.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_BACKFILL_BATCH,
  PROVENANCE_BACKFILL_PASSES_PER_TICK,
  PROVENANCE_BACKFILL_TICK_BUDGET_MS,
  PROMPT_ORIGIN_RECORRELATE_BATCH,
  runProvenancePasses,
  type ProvenanceBackfillResult,
} from './session-ingest';

const HERE = dirname(fileURLToPath(import.meta.url));

function passes(results: ProvenanceBackfillResult[], onPass?: () => void) {
  let i = 0;
  return async () => {
    onPass?.();
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    return r;
  };
}

const FULL: ProvenanceBackfillResult = { scanned: 100, updated: 100, more: true };
const LAST: ProvenanceBackfillResult = { scanned: 7, updated: 7, more: false };

describe('runProvenancePasses', () => {
  it('stops at the first pass that drains the backlog', async () => {
    const r = await runProvenancePasses(passes([FULL, FULL, LAST]), { maxPasses: 50, budgetMs: 1e9 });
    expect(r).toEqual({ scanned: 207, updated: 207, more: false, passes: 3 });
  });

  it('stops at maxPasses with more pending', async () => {
    const r = await runProvenancePasses(passes([FULL]), { maxPasses: 4, budgetMs: 1e9 });
    expect(r).toEqual({ scanned: 400, updated: 400, more: true, passes: 4 });
  });

  it('stops once the wall-clock budget has elapsed, checked between passes', async () => {
    let clock = 0;
    const r = await runProvenancePasses(passes([FULL], () => { clock += 50_000; }), {
      maxPasses: 1_000,
      budgetMs: 120_000,
      now: () => clock,
    });
    // 50 s, 100 s, 150 s: the third pass crosses the budget, so it is the last.
    expect(r.passes).toBe(3);
    expect(r.more).toBe(true);
  });
});

describe('provenance tick bounds', () => {
  it('keeps each statement small enough that its row locks are short', () => {
    expect(PROVENANCE_BACKFILL_BATCH).toBeLessThanOrEqual(250);
    expect(PROMPT_ORIGIN_RECORRELATE_BATCH).toBeLessThanOrEqual(1_000);
  });

  it('caps a tick at no more rows than before the fix', () => {
    expect(PROVENANCE_BACKFILL_BATCH * PROVENANCE_BACKFILL_PASSES_PER_TICK).toBeLessThanOrEqual(20_000);
  });

  it('ends a tick well inside the tick interval, so ticks do not overlap', () => {
    const src = readFileSync(join(HERE, '../dbos/periodic-workflows.ts'), 'utf8');
    const block = src.match(/registerScheduled\(turnProvenanceBackfillWorkflow,\s*\{[^}]*crontab:\s*'([^']+)'/);
    expect(block, 'turnProvenanceBackfill schedule not found').toBeTruthy();
    // Six-field crontab (seconds first); the minute field is */N.
    const minuteField = block![1].trim().split(/\s+/)[1];
    const everyMin = Number(minuteField.match(/^\*\/(\d+)$/)?.[1]);
    expect(everyMin, `unexpected minute field ${minuteField}`).toBeGreaterThan(0);
    expect(PROVENANCE_BACKFILL_TICK_BUDGET_MS).toBeLessThanOrEqual((everyMin * 60_000) / 2);
  });
});
