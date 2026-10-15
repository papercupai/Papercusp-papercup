import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moduleRepoRoot } from './module-repo-root';
import { BM25_LATENCY_ARTIFACT_PATH, BM25_LATENCY_INSTRUMENT_KEY, parseBm25LatencyArtifact } from './rubric-instrument-registry';
import { evaluateScorecardInstrumentContract, resolveScorecardInstrumentSnapshots } from './scorecards';
import type { Rubric } from './rubrics';

const key = BM25_LATENCY_INSTRUMENT_KEY;
const bytes = readFileSync(join(moduleRepoRoot(import.meta.url), BM25_LATENCY_ARTIFACT_PATH), 'utf8');
const original = () => JSON.parse(bytes);
const rubric = { releaseGating: false, criteria: ['r-2', 'r-3'].map(key => ({ key,
  check: { kind: 'instrument', instrumentKey: BM25_LATENCY_INSTRUMENT_KEY } })) } as unknown as Rubric;
const rate = (r2: string, r3: string) => ({ 'r-2': { rating: r2, evidence: 'original artifact' },
  'r-3': { rating: r3, evidence: 'original artifact' } });

describe('BM25 operational artifact outcomes', () => {
  it('cannot upgrade an unknown artifact with claimed per-criterion passes', () => {
    const snapshot = { verdict: 'unknown' as const, measuredAt: original().generatedAt,
      value: { criteria: { 'r-2': { verdict: 'pass' }, 'r-3': { verdict: 'pass' } } } };
    expect(evaluateScorecardInstrumentContract({ rubric, ratings: rate('PASS', 'PASS'),
      instrumentSnapshots: { [key]: snapshot } }).valid).toBe(false);
  });
  it('reads the original bytes without requiring a goal window or upgrading provenance', async () => {
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric,
      supplied: { [key]: { verdict: 'fail', measuredAt: 'invalid', provenance: 'platform-computed' } } });
    expect(snapshots?.[key]).toMatchObject({ verdict: 'pass', provenance: 'self-reported',
      measuredAt: original().generatedAt, value: { criteria: {
        'r-2': { verdict: 'pass', valueMs: 9.62915, limitMs: 50 },
        'r-3': { verdict: 'pass', valueMs: 3.7649999999999997, limitMs: 10 },
      }, corpus: { rows: 76856, source: 'operator-db-copy' } } });
    expect(evaluateScorecardInstrumentContract({ rubric, ratings: rate('PASS', 'PASS'),
      instrumentSnapshots: snapshots }).valid).toBe(true);
  });

  it('keeps unreadable, altered and invalid bytes unknown despite a supplied pass', async () => {
    for (const readArtifact of [async () => { throw new Error('missing'); }, async () => '{}',
      async () => bytes.replace('c20d6c21', '00000000')]) {
      const snapshots = await resolveScorecardInstrumentSnapshots({ rubric,
        supplied: { [key]: { verdict: 'pass', measuredAt: original().generatedAt } } }, { readArtifact });
      expect(snapshots?.[key]).toMatchObject({ verdict: 'unknown', provenance: 'self-reported' });
      expect(evaluateScorecardInstrumentContract({ rubric, ratings: rate('PASS', 'PASS'),
        instrumentSnapshots: snapshots }).valid).toBe(false);
    }
  });

  it.each([
    ['r-2', 'p95Ms', 50, 50.001, 'r-3'], ['r-3', 'p50Ms', 10, 10.001, 'r-2'],
  ])('judges %s independently, includes both forms and keeps the exact boundary', (criterion, field, limit, breach, other) => {
    const artifact = original();
    // A fast baseline and an empty top-level queries array cannot rescue a slow pgts form.
    artifact.queries = [];
    const row = artifact.summaries.find((r: { method: string; variant: string }) => r.method === 'pgts' && r.variant === 'short');
    row[field] = limit;
    if (field === 'p50Ms') row.p95Ms = 20;
    expect(parseBm25LatencyArtifact(artifact).criteria?.[criterion as 'r-2' | 'r-3'].verdict).toBe('pass');
    row[field] = breach;
    const measured = parseBm25LatencyArtifact(artifact);
    expect(measured.criteria?.[criterion as 'r-2' | 'r-3'].verdict).toBe('fail');
    expect(measured.criteria?.[other as 'r-2' | 'r-3'].verdict).toBe('pass');
    const snapshots = { [key]: { verdict: measured.verdict, measuredAt: artifact.generatedAt, value: measured } };
    const ratings = criterion === 'r-2' ? rate('FAIL', 'PASS') : rate('PASS', 'FAIL');
    expect(evaluateScorecardInstrumentContract({ rubric, ratings, instrumentSnapshots: snapshots }).valid).toBe(true);
    expect(evaluateScorecardInstrumentContract({ rubric, ratings: rate('PASS', 'PASS'), instrumentSnapshots: snapshots }).valid).toBe(false);
  });

  it.each([
    (a: ReturnType<typeof original>) => { a.summaries[0].n = 999; },
    (a: ReturnType<typeof original>) => { a.summaries = a.summaries.filter((r: { method: string; variant: string }) => r.method !== 'pgts' || r.variant !== 'title'); },
    (a: ReturnType<typeof original>) => { a.summaries.push(a.summaries[0]); },
    (a: ReturnType<typeof original>) => { a.summaries[0].p95Ms = '4'; },
    (a: ReturnType<typeof original>) => { a.corpus.source = 'fixture'; },
    (a: ReturnType<typeof original>) => { delete a.corpus.rows; },
    (a: ReturnType<typeof original>) => { a.generatedAt = '2026-10-12T00:00:00Z'; },
    (a: ReturnType<typeof original>) => { a.commit = 'different'; },
    (a: ReturnType<typeof original>) => { delete a.versions.bake_pgts; },
    (a: ReturnType<typeof original>) => { delete a.loadavg.end; },
  ])('rejects incomplete, wrong-run, baseline-only or malformed evidence', mutate => {
    const artifact = original(); mutate(artifact);
    expect(parseBm25LatencyArtifact(artifact).verdict).toBe('unknown');
  });
});
