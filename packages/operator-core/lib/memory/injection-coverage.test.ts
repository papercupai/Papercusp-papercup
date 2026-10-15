/**
 * P-004 (context-injection-retrieval-reach-and-visibility-2026-08-03) — the
 * injection-scoped retrieval-reach alarm.
 *
 * Two of these are CONTROLS rather than feature tests, and they are the point of the
 * file: the module's whole job is to not repeat a specific misreading (that
 * `work_items.embedding` says something about injection's reach) and to not cry wolf on
 * the normal case (chunks trailing the parent leg). A suite that only asserted the happy
 * path would pass just as well against a module that got both wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  RECENT_COVERAGE_FLOOR,
  TOTAL_COVERAGE_FLOOR,
  type CoverageBreach,
  type SurfaceCoverage,
} from '../search/embed-coverage';
import { SEARCH_SOURCE_SURFACES } from '../search/coverage-gate';
import { CORPUS_SOURCE_NAMES } from './corpus-recall-io';
import {
  INJECTION_SOURCE_NAMES,
  assessInjectionReach,
  formatInjectionReachToast,
} from './injection-coverage';

const PARENT = 'harness_shared.session_turns.text_embedding';
const CHUNKS = 'harness_shared.session_turn_chunks.embedding';
const WORK_ITEM_VEC = 'harness_shared.work_items.embedding';

function surface(name: string, over: Partial<SurfaceCoverage> = {}): SurfaceCoverage {
  return {
    surface: name,
    table: name.split('.').slice(0, 2).join('.'),
    embedCol: name.split('.')[2] ?? 'embedding',
    totalRows: 1000,
    eligibleRows: 1000,
    embeddedRows: 1000,
    ineligibleRows: 0,
    backlog: 0,
    eligibleCoverage: 1,
    recentWindowHours: 24,
    recentEligible: 100,
    recentEmbedded: 100,
    recentCoverage: 1,
    settledEligible: 100,
    settledEmbedded: 100,
    settledCoverage: 1,
    ...over,
  };
}

function breach(name: string, kind: CoverageBreach['kind']): CoverageBreach {
  return { surface: name, kind, observed: 0.5, floor: 0.95, detail: 'upstream verdict' };
}

/** A pass in which everything injection reads is healthy. */
const HEALTHY: SurfaceCoverage[] = [surface(PARENT), surface(CHUNKS), surface(WORK_ITEM_VEC),
  surface('harness_shared.harness_plans.embedding'), surface('harness_shared.doc_sections.embedding'),
  surface('harness_shared.text_chunks.embedding:plans'), surface('harness_shared.text_chunks.embedding:report')];

describe('injection source list stays pinned to the real corpus leg', () => {
  it('matches CORPUS_SOURCE_NAMES exactly', () => {
    // The copy exists to keep the retrieval stack out of the alarm process; this is the
    // assertion that makes the copy safe rather than a latent divergence.
    expect([...INJECTION_SOURCE_NAMES]).toEqual([...CORPUS_SOURCE_NAMES]);
  });

  it('every injection source is mapped in SEARCH_SOURCE_SURFACES', () => {
    for (const s of INJECTION_SOURCE_NAMES) {
      expect(SEARCH_SOURCE_SURFACES[s], `source '${s}' is unmapped`).toBeDefined();
    }
  });
});

describe('healthy pass', () => {
  it('raises no breach and reports BOTH corpus sources as semantic', () => {
    const r = assessInjectionReach(HEALTHY, []);
    expect(r.breaches).toEqual([]);
    expect(r.degraded).toBe(false);
    expect(r.semanticSourceCount).toBe(5);
    // The single-point-of-failure note is for the ONE-source case, which this no
    // longer is — see the two-sources-now block below for why that changed.
    expect(r.warning).toBeNull();
  });

  it('classifies work_item as healthy — it has an embedding leg since P-005', () => {
    const r = assessInjectionReach(HEALTHY, []);
    const wi = r.perSource.find((s) => s.source === 'work_item');
    expect(wi?.verdict).toBe('healthy');
    expect(wi?.coverage).not.toBeNull();
  });
});

/**
 * THIS BLOCK IS AN INVERSION, AND THE INVERSION IS THE POINT.
 *
 * It used to read `CONTROL: work_items.embedding is not injection coverage`, and
 * asserted that a breach there raised NOTHING here — because `work_item` exposed no
 * `embedding()` and that surface fed only the work-item dupe guard. D-078 recorded
 * that as the load-bearing fact.
 *
 * P-005 wired the leg (migration 776 exposes `embedding` on the `engineer_issues`
 * view the source reads), so the surface IS injection coverage now and a breach on it
 * MUST reach these breaches. Two things are worth carrying from how that landed:
 *
 *   • The old controls did not quietly keep passing — they failed loudly the moment
 *     the registry entry changed, which is exactly what a control is for. Had they
 *     been written as comments, the alarm would have gone on silently ignoring a
 *     surface it now depends on.
 *   • Nothing in `injection-coverage.ts` had to change for the behaviour to follow.
 *     It reads `SEARCH_SOURCE_SURFACES`, so widening the registry widened the alarm.
 */
describe('work_items.embedding IS injection coverage since P-005', () => {
  it('a total-coverage breach on work_items.embedding NOW raises an injection breach', () => {
    const r = assessInjectionReach(HEALTHY, [breach(WORK_ITEM_VEC, 'total-coverage')]);
    expect(r.breaches.map((b) => b.source)).toContain('work_item');
    expect(r.degraded).toBe(true);
  });

  it('a recurrence breach on work_items.embedding NOW raises an injection breach', () => {
    const r = assessInjectionReach(HEALTHY, [breach(WORK_ITEM_VEC, 'recent-coverage')]);
    expect(r.breaches.map((b) => b.source)).toContain('work_item');
  });

  it('CONTROL — a breach on a surface injection does NOT read still raises nothing', () => {
    // The inversion above must not be mistaken for "every breach reaches injection".
    // Attributing an unrelated surface here is the original misreading with a new
    // face, so it keeps a failing control of its own.
    const r = assessInjectionReach(HEALTHY, [
      breach('harness_shared.harness_decisions.body_embedding', 'total-coverage'),
    ]);
    expect(r.breaches).toEqual([]);
    expect(r.degraded).toBe(false);
  });
});

describe('CONTROL: union semantics across the P-034 parent+chunk legs', () => {
  it('one breached leg does NOT degrade reach while the other carries it', () => {
    // Every turn has a parent vector; chunks exist only for long turns. Parent at 100%
    // means every turn is still findable, so alarming here would be crying wolf on the
    // ordinary case of chunks trailing.
    const r = assessInjectionReach(HEALTHY, [breach(CHUNKS, 'total-coverage')]);
    expect(r.breaches).toEqual([]);
    expect(r.perSource.find((s) => s.source === 'session_turn')?.verdict).toBe('healthy');
  });

  it('ALL legs breached degrades reach and reports the best leg', () => {
    const surfaces = [
      surface(PARENT, { eligibleCoverage: 0.4 }),
      surface(CHUNKS, { eligibleCoverage: 0.6 }),
      surface(WORK_ITEM_VEC),
    ];
    const r = assessInjectionReach(surfaces, [
      breach(PARENT, 'total-coverage'),
      breach(CHUNKS, 'total-coverage'),
    ]);
    expect(r.breaches).toHaveLength(1);
    expect(r.breaches[0].kind).toBe('injection-total-coverage');
    expect(r.breaches[0].source).toBe('session_turn');
    // Best (max) of the two legs, mirroring assessSourceCoverage's union semantics.
    expect(r.breaches[0].observed).toBeCloseTo(0.6);
    expect(r.breaches[0].floor).toBe(TOTAL_COVERAGE_FLOOR);
    expect(r.degraded).toBe(true);
  });
});

describe('the recurrence signal', () => {
  it('raises injection-recent-coverage when every leg is failing new writes', () => {
    const surfaces = [
      surface(PARENT, { settledCoverage: 0.2 }),
      surface(CHUNKS, { settledCoverage: 0.1 }),
      surface(WORK_ITEM_VEC),
    ];
    const r = assessInjectionReach(surfaces, [
      breach(PARENT, 'recent-coverage'),
      breach(CHUNKS, 'recent-coverage'),
    ]);
    const b = r.breaches.find((x) => x.kind === 'injection-recent-coverage');
    expect(b).toBeDefined();
    expect(b?.observed).toBeCloseTo(0.2);
    expect(b?.floor).toBe(RECENT_COVERAGE_FLOOR);
    expect(b?.detail).toContain('recurrence signal');
  });
});

describe('absence of evidence is not health', () => {
  it('an unmeasured source reads unknown, never healthy', () => {
    const r = assessInjectionReach([surface(WORK_ITEM_VEC)], []);
    const st = r.perSource.find((s) => s.source === 'session_turn');
    expect(st?.verdict).toBe('unknown');
    expect(st?.coverage).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.warning).toContain('unknown is not health');
  });

  it('a partially measured union still reports the missing leg', () => {
    const r = assessInjectionReach([surface(PARENT), surface(WORK_ITEM_VEC)], []);
    const st = r.perSource.find((s) => s.source === 'session_turn');
    expect(st?.verdict).toBe('healthy');
    expect(st?.unknownSurfaces).toEqual([CHUNKS]);
  });

  it('a source injection reads but nothing maps reads unmapped, not healthy', () => {
    const r = assessInjectionReach(HEALTHY, [], ['session_turn', 'a_source_with_no_mapping']);
    const un = r.perSource.find((s) => s.source === 'a_source_with_no_mapping');
    expect(un?.verdict).toBe('unmapped');
    expect(r.degraded).toBe(true);
  });
});

describe('structural: losing every semantic leg', () => {
  it('raises no-semantic-path when nothing injection reads can be reached by meaning', () => {
    // Since P-005 this takes losing BOTH corpus legs, not one — so the hypothetical
    // is built from `coord_message`, which is genuinely BM25-only (120k+ envelope
    // rows deliberately unembedded). `work_item` used to serve this role and can no
    // longer: it has an embedding leg now.
    const r = assessInjectionReach(HEALTHY, [], ['coord_message']);
    const b = r.breaches.find((x) => x.kind === 'no-semantic-path');
    expect(b).toBeDefined();
    expect(b?.source).toBeNull();
    expect(r.semanticSourceCount).toBe(0);
    expect(formatInjectionReachToast(r).level).toBe('error');
  });

  it('does NOT raise it while a semantic source remains', () => {
    const r = assessInjectionReach(HEALTHY, []);
    expect(r.breaches.some((x) => x.kind === 'no-semantic-path')).toBe(false);
  });
});

describe('toast rendering', () => {
  it('is a warning, and names the affected leg, for a coverage breach', () => {
    const r = assessInjectionReach(
      [surface(PARENT, { eligibleCoverage: 0.4 }), surface(CHUNKS, { eligibleCoverage: 0.4 })],
      [breach(PARENT, 'total-coverage'), breach(CHUNKS, 'total-coverage')],
    );
    const t = formatInjectionReachToast(r);
    expect(t.level).toBe('warning');
    expect(t.description).toContain('session_turn');
  });
});
