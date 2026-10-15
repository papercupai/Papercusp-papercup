/**
 * CI guard for the gym↔report-set firewall (P-012 / D-005).
 *
 * The load-bearing assertion is "optimize-on and report-on are strictly disjoint": if this
 * suite goes red, the gym is about to tune on a benchmark we publish scores on. Pure tests
 * (no PG, no network).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_ON_SUITES,
  PORTFOLIO_DISPOSITIONS,
  PORTFOLIO_REVIEW_FLOOR,
  assertPortfolioReviewed,
  type ReportOnSuite,
  GYM_OPTIMIZE_ON_SETS,
  BENCH_SET_REGISTRY,
  ReportSetFirewallError,
  assertReportSetFirewall,
  assertGymMayOptimizeOn,
  assertGymTaskNotContaminated,
  assertGymCorpusDisjoint,
  reportSetTaskIntersection,
  taskFingerprint,
  isReportOnSet,
  isOptimizeOnSet,
  reportOnSetIds,
  optimizeOnSetIds,
  type BenchSet,
} from './report-set-firewall';

describe('gym↔report-set firewall — set-level disjointness (P-012)', () => {
  it('the live registry passes the static firewall', () => {
    expect(() => assertReportSetFirewall()).not.toThrow();
  });

  it('FAILS if a report-on suite is also declared a gym optimize-on source (the core guard)', () => {
    const doctored: BenchSet[] = [
      ...BENCH_SET_REGISTRY,
      // someone "adds SWE-bench Pro to the gym's training corpus" — the exact regression we fence
      {
        id: 'swe-bench-pro',
        usage: 'optimize-on',
        title: 'SWE-bench Pro as gym training data',
        rationale: 'illegal — reported on',
      },
    ];
    expect(() => assertReportSetFirewall(doctored)).toThrow(ReportSetFirewallError);
    expect(() => assertReportSetFirewall(doctored)).toThrow(/swe-bench-pro/);
  });

  it('the optimize-on and report-on id collections do not intersect', () => {
    const reportOn = reportOnSetIds();
    const optimizeOn = optimizeOnSetIds();
    const overlap = [...optimizeOn].filter((id) => reportOn.has(id));
    expect(overlap).toEqual([]);
  });

  it('every REPORT_ON_SUITES entry is usage=report-on and every GYM_OPTIMIZE_ON_SETS entry is usage=optimize-on', () => {
    expect(REPORT_ON_SUITES.every((s) => s.usage === 'report-on')).toBe(true);
    expect(GYM_OPTIMIZE_ON_SETS.every((s) => s.usage === 'optimize-on')).toBe(true);
  });

  it('flags duplicate (id, usage) registry entries', () => {
    const dup: BenchSet[] = [...BENCH_SET_REGISTRY, { ...REPORT_ON_SUITES[0] }];
    expect(() => assertReportSetFirewall(dup)).toThrow(/duplicate/);
  });

  it('REPORT_ON_SUITES IS the run_result.suite vocabulary — changing it is a deliberate, test-visible act (P-010/P-011 lock-step)', () => {
    // If you add/remove a published benchmark, update this expectation in the SAME change so
    // the firewall and the results schema can never silently drift apart.
    expect([...reportOnSetIds()].sort()).toEqual(
      [
        'agentsnet',
        'frontier-swe',
        'harness-bench',
        'metr-hcast',
        'roadmapbench',
        'swe-bench-live',
        'swe-bench-pro',
        'swe-evo',
        'swarmbench',
        'swe-lancer',
        'swe-rebench',
        'terminal-bench',
      ].sort(),
    );
  });
});

describe('classifiers', () => {
  it('isReportOnSet / isOptimizeOnSet', () => {
    expect(isReportOnSet('swe-bench-pro')).toBe(true);
    expect(isReportOnSet('gym-synthetic')).toBe(false);
    expect(isOptimizeOnSet('gym-synthetic')).toBe(true);
    expect(isOptimizeOnSet('swe-bench-pro')).toBe(false);
    expect(isReportOnSet('totally-unknown')).toBe(false);
    expect(isOptimizeOnSet('totally-unknown')).toBe(false);
  });
});

describe('assertGymMayOptimizeOn — fail-closed source gate', () => {
  it('accepts declared gym optimize-on sources', () => {
    expect(() => assertGymMayOptimizeOn('gym-synthetic')).not.toThrow();
    expect(() => assertGymMayOptimizeOn('gym-real-anchor')).not.toThrow();
  });

  it('throws on a report-on set', () => {
    expect(() => assertGymMayOptimizeOn('swe-bench-pro')).toThrow(/REPORT-ON/);
    expect(() => assertGymMayOptimizeOn('terminal-bench')).toThrow(ReportSetFirewallError);
  });

  it('throws fail-closed on an undeclared source', () => {
    expect(() => assertGymMayOptimizeOn('mystery-corpus')).toThrow(/undeclared/);
  });
});

describe('assertGymTaskNotContaminated — the ingestion choke-point guard', () => {
  it('admits a clean synthetic task (no source tag, substrate repo, model generatedBy)', () => {
    expect(() =>
      assertGymTaskNotContaminated({
        taskId: 'synthetic-001',
        repoUrl: 'file:///home/x/papercup',
        repoCommit: 'abc123',
        generatedBy: 'claude-opus-4-8',
      }),
    ).not.toThrow();
  });

  it('admits a real-feature-replay task', () => {
    expect(() =>
      assertGymTaskNotContaminated({
        taskId: 'real-papercup-F-301',
        repoUrl: 'file:///home/x/papercup',
        repoCommit: 'deadbeef',
        generatedBy: 'real-feature-replay',
        sourceSet: 'gym-real-anchor',
      }),
    ).not.toThrow();
  });

  it('REFUSES a task whose declared sourceSet is a report-on suite', () => {
    expect(() =>
      assertGymTaskNotContaminated({ taskId: 't1', sourceSet: 'swe-bench-pro' }),
    ).toThrow(ReportSetFirewallError);
  });

  it('REFUSES a task with an undeclared sourceSet (fail-closed)', () => {
    expect(() =>
      assertGymTaskNotContaminated({ taskId: 't2', sourceSet: 'some-new-source' }),
    ).toThrow(/undeclared/);
  });

  it('REFUSES a task whose generatedBy names a report-on suite (the wired external-bench→gym vector)', () => {
    expect(() =>
      assertGymTaskNotContaminated({
        taskId: 't3',
        repoUrl: 'https://github.com/astropy/astropy',
        repoCommit: 'cafe01',
        generatedBy: 'swe-bench-pro',
      }),
    ).toThrow(/report-on/);
  });

  it('REFUSES a task whose repo@commit is in a supplied report-on manifest; admits one that is not', () => {
    const manifest = new Set([
      taskFingerprint('https://github.com/astropy/astropy', 'CAFE01'),
      taskFingerprint('git@github.com:django/django.git', 'beef02'),
    ]);
    expect(() =>
      assertGymTaskNotContaminated(
        { taskId: 't4', repoUrl: 'https://github.com/astropy/astropy', repoCommit: 'cafe01' },
        { reportOnFingerprints: manifest },
      ),
    ).toThrow(/report-on benchmark set/);
    expect(() =>
      assertGymTaskNotContaminated(
        { taskId: 't5', repoUrl: 'file:///home/x/papercup', repoCommit: 'abc123' },
        { reportOnFingerprints: manifest },
      ),
    ).not.toThrow();
  });
});

describe('taskFingerprint — normalization', () => {
  it('collapses https / scp-ssh / .git / trailing-slash variants of the same repo+commit', () => {
    const a = taskFingerprint('https://github.com/astropy/astropy', 'ABC123');
    const b = taskFingerprint('git@github.com:astropy/astropy.git', 'abc123');
    const c = taskFingerprint('ssh://github.com/astropy/astropy/', 'abc123');
    const d = taskFingerprint('git+https://github.com/astropy/astropy', 'abc123');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
  });

  it('distinguishes different commits and different repos', () => {
    const base = taskFingerprint('https://github.com/astropy/astropy', 'abc123');
    expect(taskFingerprint('https://github.com/astropy/astropy', 'def456')).not.toEqual(base);
    expect(taskFingerprint('https://github.com/django/django', 'abc123')).not.toEqual(base);
  });
});

describe('task-level disjointness (Layer 2)', () => {
  it('reportSetTaskIntersection returns the shared fingerprints', () => {
    const optimizeOn = ['host/x@1', 'host/y@2', 'host/z@3'];
    const reportOn = ['host/y@2', 'host/q@9'];
    expect(reportSetTaskIntersection(optimizeOn, reportOn).sort()).toEqual(['host/y@2']);
  });

  it('assertGymCorpusDisjoint throws on overlap, passes when clean', () => {
    expect(() => assertGymCorpusDisjoint(['host/a@1'], ['host/b@2'])).not.toThrow();
    expect(() => assertGymCorpusDisjoint(['host/a@1', 'host/b@2'], ['host/b@2'])).toThrow(
      ReportSetFirewallError,
    );
  });

  it('the frontier-swe rationale restates NO task / bucket counts — they are derived from the corpus (plan benchmark-coverage-frontierswe-v2-2026-10-10 D-003 §5)', () => {
    // A hand-written "17 tasks (5/9/3)" drifted from the corpus (v1 is 7/7/3; v2 is 34 tasks, 19/8/7). The counts
    // live in the ingested corpus and the report derives them; prose that restates them is a second, stale copy.
    const fs = REPORT_ON_SUITES.find((s) => s.id === 'frontier-swe')!;
    const countClaim =
      /\b\d+\s*(?:ultra-long-horizon\s+)?tasks?\b|\b\d+\s+(?:implementation|performance|perf|research|ML-research)\b|\b\d+\s*\/\s*\d+\s*\/\s*\d+\b/i;
    // The detector must still recognise the exact shape it replaced, or this guard passes vacuously.
    expect('17 ultra-long-horizon tasks (5 implementation / 9 performance / 3 ML-research)').toMatch(countClaim);
    expect(fs.rationale).not.toMatch(countClaim);
    expect(fs.title).not.toMatch(countClaim);
  });
});

describe('portfolio review on every report-on suite (plan benchmark-coverage-frontierswe-v2-2026-10-10 R-7 / P-008)', () => {
  // The clause: each REPORT_ON_SUITES entry records a portfolio disposition with a review date on or
  // after 2026-10-01. The literal is restated here on purpose, so bumping PORTFOLIO_REVIEW_FLOOR backwards
  // cannot quietly weaken this test.
  const CLAUSE_FLOOR = '2026-10-01';
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

  const wellFormed = (id: string, over: Partial<ReportOnSuite['portfolio']> = {}): ReportOnSuite => ({
    id,
    usage: 'report-on',
    title: `${id} fixture`,
    rationale: 'fixture',
    portfolio: {
      disposition: 'build-adapter',
      reviewedAt: '2026-10-11',
      note: 'fixture note',
      evidence: 'apps/operator/docs/benchmark-suite-portfolio-2026-10-11.md',
      ...over,
    },
  });

  it('every live entry has a disposition from the closed set, reviewed on or after 2026-10-01', () => {
    expect(REPORT_ON_SUITES.length).toBeGreaterThan(0);
    expect(PORTFOLIO_REVIEW_FLOOR >= CLAUSE_FLOOR).toBe(true);
    for (const s of REPORT_ON_SUITES) {
      expect(PORTFOLIO_DISPOSITIONS, s.id).toContain(s.portfolio.disposition);
      expect(s.portfolio.reviewedAt, s.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.portfolio.reviewedAt >= CLAUSE_FLOOR, `${s.id} reviewedAt ${s.portfolio.reviewedAt}`).toBe(true);
      expect(s.portfolio.note.trim(), s.id).not.toBe('');
    }
    expect(() => assertPortfolioReviewed()).not.toThrow();
  });

  it('every evidence path exists, and its disposition table agrees with the registry row for row', () => {
    const rowRe = /^\| `([a-z0-9-]+)` \| `([a-z-]+)` \|$/;
    for (const evidence of new Set(REPORT_ON_SUITES.map((s) => s.portfolio.evidence))) {
      const abs = resolve(repoRoot, evidence);
      expect(existsSync(abs), evidence).toBe(true);
      const table = new Map<string, string>();
      for (const line of readFileSync(abs, 'utf8').split('\n')) {
        const m = rowRe.exec(line.trim());
        if (m) table.set(m[1]!, m[2]!);
      }
      const cited = REPORT_ON_SUITES.filter((s) => s.portfolio.evidence === evidence);
      expect(Object.fromEntries(table)).toEqual(
        Object.fromEntries(cited.map((s) => [s.id, s.portfolio.disposition])),
      );
    }
  });

  // Calibration: the guard must accept a correct registry, or every refusal below proves nothing.
  it('accepts a well-formed doctored registry (calibration)', () => {
    expect(() => assertPortfolioReviewed([wellFormed('a'), wellFormed('b', { disposition: 'blocked' })])).not.toThrow();
    expect(() => assertPortfolioReviewed([wellFormed('a', { reviewedAt: CLAUSE_FLOOR })])).not.toThrow();
  });

  it('refuses an entry with no portfolio review at all', () => {
    const bare: BenchSet = { id: 'bare', usage: 'report-on', title: 'bare', rationale: 'no review' };
    expect(() => assertPortfolioReviewed([wellFormed('ok'), bare])).toThrow(/bare: no portfolio review/);
  });

  it('refuses a disposition outside the closed set', () => {
    const odd = wellFormed('odd', { disposition: 'keep-forever' as never });
    expect(() => assertPortfolioReviewed([odd])).toThrow(/odd: unknown disposition 'keep-forever'/);
  });

  it('refuses a review dated before 2026-10-01, and a date that is not a real calendar day', () => {
    expect(() => assertPortfolioReviewed([wellFormed('stale', { reviewedAt: '2026-09-30' })])).toThrow(
      /stale: reviewed 2026-09-30, before the 2026-10-01 floor/,
    );
    for (const bad of ['2026-02-30', '2026-13-01', '11/10/2026', '']) {
      expect(() => assertPortfolioReviewed([wellFormed('bad', { reviewedAt: bad })]), bad).toThrow(
        /is not a YYYY-MM-DD date/,
      );
    }
  });

  it('refuses an empty note or evidence path', () => {
    expect(() => assertPortfolioReviewed([wellFormed('n', { note: '  ' })])).toThrow(/n: empty note/);
    expect(() => assertPortfolioReviewed([wellFormed('e', { evidence: '' })])).toThrow(/e: empty evidence path/);
  });

  it('names every offender in one error, and refuses a list with no report-on suite instead of passing vacuously', () => {
    let message = '';
    try {
      assertPortfolioReviewed([wellFormed('x', { reviewedAt: '2025-01-01' }), wellFormed('y', { note: '' })]);
    } catch (e) {
      expect(e).toBeInstanceOf(ReportSetFirewallError);
      message = (e as Error).message;
    }
    expect(message).toMatch(/x: reviewed 2025-01-01/);
    expect(message).toMatch(/y: empty note/);
    expect(() => assertPortfolioReviewed(GYM_OPTIMIZE_ON_SETS)).toThrow(/no report-on suite/);
    expect(() => assertPortfolioReviewed([wellFormed('a')], '2026-1-1')).toThrow(/floor '2026-1-1'/);
  });
});
