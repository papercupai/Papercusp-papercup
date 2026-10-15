/**
 * token-efficiency-prompts-cache-and-behavior-2026-10-11 P-001 — the startup-cache instrument over
 * REAL gateway journal lines. Clauses: SPEC-P-001, SPEC-P-001-UNKNOWN and AUTO-BAR-R-1-P-001.
 *
 * FIXTURE CALIBRATION. __fixtures__/startup-cache-evidence.journal.txt holds 150 lines copied
 * verbatim from the output of the command `measure:startup-cache` itself runs
 * (`journalctl --user -u papercup-inference-gateway.service -o cat --grep startup-cache-evidence/v1`),
 * captured on 2026-10-12 over the trailing 24 hours. They are the first 120 lines of that window,
 * plus the next 30 lines whose usage counters were missing. They are real requests: claude and
 * codex, ok, cancelled and upstream-error outcomes, and rows with and without a recorded layout.
 * The calibration test checks that:
 *   - every line has the gateway's own `[inference-gateway:info] startup-cache-evidence/v1 {json}`
 *     form with the v1 fields;
 *   - each request appears once;
 *   - the states the clauses are about are present: missing counters, and startup rows in
 *     several layout groups.
 * The real journal held no repeated line (4,141 lines, none repeated), so the dedupe cases repeat
 * real lines the way an overlapping re-read or a concatenated export does.
 * Expected values are computed in this file from the parsed JSON, with a separate plain
 * implementation. Only the startup classification uses the gateway's own predicate, because that
 * predicate is what defines a startup request.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStartupRequestLayout } from '../inference-gateway/request-stage-telemetry';
import { summarizeStartupCacheEvidence } from './launch-cost-metrics';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./__fixtures__/startup-cache-evidence.journal.txt', import.meta.url));
const LINES = readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line !== '');
const PREFIX = '[inference-gateway:info] startup-cache-evidence/v1 ';

interface RawRow {
  schema: string;
  requestId: number;
  ownerId: string;
  model: string | null;
  transport: string;
  startedAt: number;
  layout: null | {
    system: { blockCount: number };
    markers?: Array<{ section: string; index: number; ttl: string }>;
  };
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}
const ROWS: RawRow[] = LINES.map((line) => JSON.parse(line.slice(PREFIX.length)) as RawRow);

// ── a separate, plain oracle ───────────────────────────────────────────────────────────────
const isMeasured = (r: RawRow) => r.inputTokens !== null && r.cacheReadTokens !== null && r.cacheWriteTokens !== null;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function plainMedian(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function plainTotals(rows: RawRow[]) {
  const m = rows.filter(isMeasured);
  return {
    measured: m.length,
    unknownUsage: rows.length - m.length,
    cacheReadTokens: sum(m.map((r) => r.cacheReadTokens!)),
    cacheWriteTokens: sum(m.map((r) => r.cacheWriteTokens!)),
    uncachedInputTokens: sum(m.map((r) => r.inputTokens!)),
    medianCacheReadTokens: plainMedian(m.map((r) => r.cacheReadTokens!)),
    medianCacheWriteTokens: plainMedian(m.map((r) => r.cacheWriteTokens!)),
    medianUncachedInputTokens: plainMedian(m.map((r) => r.inputTokens!)),
  };
}
const groupKey = (r: RawRow) =>
  [
    r.model ?? 'unknown-model',
    r.transport,
    `sys${r.layout!.system.blockCount}`,
    `mk=${(r.layout!.markers ?? []).map((m) => `${m.section[0]}${m.index}:${m.ttl}`).join(',')}`,
  ].join(' | ');
const STARTUP = ROWS.filter((r) => isStartupRequestLayout(r.layout as never));

/** Run the real `measure:startup-cache` command on journal lines and return its --json output. */
function runCommand(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'startup-cache-real-'));
  try {
    const input = join(dir, 'journal.txt');
    writeFileSync(input, `${lines.join('\n')}\n`);
    const run = spawnSync('npx', ['tsx', 'scripts/measure-startup-cache.ts', '--input', input, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as ReturnType<typeof summarizeStartupCacheEvidence>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('startup-cache-evidence/v1 real journal fixture — calibration', () => {
  it('every line is the gateway journal form with the v1 fields, and each request appears once', () => {
    expect(LINES).toHaveLength(150);
    for (const line of LINES) expect(line.startsWith(PREFIX)).toBe(true);
    for (const row of ROWS) {
      expect(row.schema).toBe('startup-cache-evidence/v1');
      for (const field of ['requestId', 'ownerId', 'startedAt', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'layout'])
        expect(row, field).toHaveProperty(field);
    }
    expect(new Set(ROWS.map((r) => JSON.stringify([r.ownerId, r.requestId, r.startedAt]))).size).toBe(150);
  });

  it('contains the states the clauses are about: missing usage counters and startup rows in several layout groups', () => {
    expect(ROWS.filter((r) => !isMeasured(r))).toHaveLength(30);
    expect(STARTUP.length).toBeGreaterThan(5);
    expect(STARTUP.some((r) => !isMeasured(r))).toBe(true);
    expect(new Set(STARTUP.map(groupKey)).size).toBeGreaterThan(2);
  });
});

describe('summarizeStartupCacheEvidence over the real journal (P-001)', () => {
  const summary = summarizeStartupCacheEvidence(LINES);

  it('SPEC-P-001: a re-read real line with the same owner and request id is counted as one first request', () => {
    const reread = [...LINES, ...LINES.slice(0, 40)];
    const deduped = summarizeStartupCacheEvidence(reread);
    expect(deduped.evidenceLines).toBe(190);
    expect(deduped.duplicates).toBe(40);
    expect(deduped.requests).toBe(150);
    const { evidenceLines: _e, duplicates: _d, ...rest } = deduped;
    const { evidenceLines: _e2, duplicates: _d2, ...base } = summary;
    expect(rest).toEqual(base);
  });

  it('SPEC-P-001: the measure:startup-cache command counts a re-read real line once', () => {
    const out = runCommand([...LINES, ...LINES.slice(0, 40)]);
    expect(out.duplicates).toBe(40);
    expect(out.requests).toBe(150);
    expect(out.all.cacheWriteTokens).toBe(plainTotals(ROWS).cacheWriteTokens);
  }, 120_000);

  it('SPEC-P-001-UNKNOWN: rows with missing usage counters stay out of every total and median', () => {
    const { requests: _r, ...all } = summary.all;
    expect(all).toEqual(plainTotals(ROWS));
    expect(summary.all.unknownUsage).toBe(30);
    const { requests: _sr, owners: _so, ...startup } = summary.startup;
    expect(startup).toEqual(plainTotals(STARTUP));
    // On this real sample, counting a missing counter as zero moves at least one median, so the
    // equality above really distinguishes "excluded" from "counted as zero".
    const zeroFilled = [
      plainMedian(ROWS.map((r) => r.cacheReadTokens ?? 0)),
      plainMedian(ROWS.map((r) => r.cacheWriteTokens ?? 0)),
      plainMedian(ROWS.map((r) => r.inputTokens ?? 0)),
    ];
    const reported = [summary.all.medianCacheReadTokens, summary.all.medianCacheWriteTokens, summary.all.medianUncachedInputTokens];
    expect(zeroFilled.some((value, i) => value !== reported[i])).toBe(true);
  });

  it('AUTO-BAR-R-1-P-001: per-group write/read medians and totals, unknown usage kept, each request counted once', () => {
    const byKey = new Map<string, RawRow[]>();
    for (const r of STARTUP) (byKey.get(groupKey(r)) ?? byKey.set(groupKey(r), []).get(groupKey(r))!).push(r);
    expect(summary.groups.map((g) => g.key).sort()).toEqual([...byKey.keys()].sort());
    for (const g of summary.groups) {
      const rows = byKey.get(g.key)!;
      expect(g.requests).toBe(rows.length);
      expect(g.owners).toBe(new Set(rows.map((r) => r.ownerId)).size);
      const { measured, unknownUsage, cacheReadTokens, cacheWriteTokens, medianCacheReadTokens, medianCacheWriteTokens } = plainTotals(rows);
      expect(g).toMatchObject({ measured, unknownUsage, cacheReadTokens, cacheWriteTokens, medianCacheReadTokens, medianCacheWriteTokens });
    }
    expect(summary.groups.some((g) => g.unknownUsage > 0)).toBe(true);
    expect(summary.startup.requests).toBe(STARTUP.length);
  });

  it('AUTO-BAR-R-1-P-001: the measure:startup-cache command reports the same per-group figures for the real journal', () => {
    const out = runCommand(LINES);
    expect(out.groups).toEqual(JSON.parse(JSON.stringify(summary.groups)));
    expect(out.all.unknownUsage).toBe(30);
    expect(out.requests).toBe(150);
  }, 120_000);
});
