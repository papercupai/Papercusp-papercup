/**
 * Unit tests for the code-intelligence resource CONTRACT — specifically the
 * index-disk budget grader added by WI-2142942.
 *
 * These need no language server, no backend and no disk. What they guard is
 * that `indexDiskMbMax` can now actually FAIL, and — the half that matters
 * more — that it cannot fabricate a PASS. The defect being fixed was a budget
 * declared, valued, and compared in zero places: it could not fail, so it read
 * as a standing guarantee while the selected backend sat at 3.2x it.
 *
 * A grader that merely exists would recreate that defect one level up, so the
 * suite includes a falsifiability CONTROL: an injected budget must flip the
 * verdict. If that control ever passes trivially, the guard is measuring
 * nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOURCE_BUDGET,
  GITNEXUS_START_LINE_BASE_BY_VERSION,
  KNOWN_INDEX_DISK_EXCEEDANCES,
  LINE_INDEX_BASE,
  classifyIndexDisk,
  gitnexusStartLineBase,
  toOneIndexed,
  versionedSymbolIdentity,
  sourceIdentityContinuity,
  unmeasuredSourceEvidence,
  type KnownIndexDiskExceedance,
} from './contracts';

const ALLOWANCE: readonly KnownIndexDiskExceedance[] = [
  { backend: 'testbed', observedMb: 3_000, observedCeilingMb: 4_000, why: 'fixture' },
];

describe('source-version identity', () => {
  const site = { path: 'src/caller.ts', line1: 7, kind: 'function', name: 'caller' };
  const source = { path: site.path, contentHash: 'a'.repeat(64), language: 'typescript', representation: 'full-source' as const };
  it('preserves exact content/repository identity and requires resolution after edits, moves or scope changes', () => {
    const original = versionedSymbolIdentity('repo-a', site, source);
    expect(JSON.parse(original!)).toEqual(['symbol-site-v1', 'repo-a', 'src/caller.ts', 'a'.repeat(64), 7, 'caller', 'function']);
    expect(sourceIdentityContinuity(original, versionedSymbolIdentity('repo-a', site, source))).toBe('unchanged');
    for (const changed of [versionedSymbolIdentity('repo-b', site, source),
      versionedSymbolIdentity('repo-a', { ...site, line1: 8 }, source),
      versionedSymbolIdentity('repo-a', site, { ...source, contentHash: 'b'.repeat(64) })])
      expect(sourceIdentityContinuity(original, changed)).toBe('needs-resolution');
  });
  it('refuses missing hashes, stub evidence and unsafe/unlocated sites instead of inventing identity', () => {
    expect(versionedSymbolIdentity(null, site, source)).toBeNull();
    expect(versionedSymbolIdentity('repo-a', site, undefined)).toBeNull();
    expect(versionedSymbolIdentity('repo-a', site, { ...source, contentHash: '' })).toBeNull();
    expect(versionedSymbolIdentity('repo-a', site, { ...source, representation: 'reexport-stub' })).toBeNull();
    expect(versionedSymbolIdentity('repo-a', { ...site, path: '../caller.ts' }, { ...source, path: '../caller.ts' })).toBeNull();
    expect(versionedSymbolIdentity('repo-a', { ...site, line1: null }, source)).toBeNull();
    expect(sourceIdentityContinuity(null, null)).toBe('needs-resolution');
  });
  it('keeps unknown indexed source versions explicit for populated and empty answers', () => {
    for (const sites of [[site], []]) {
      const evidence = unmeasuredSourceEvidence({ intent: 'references', sites }, {
        repositoryId: 'repo-a', identityKind: 'registry', paths: ['src'], basis: 'indexed-code',
      }, ['Index has no measured per-file snapshot.']);
      expect(evidence.sourceScope).toEqual({ repositoryId: 'repo-a', identityKind: 'registry',
        paths: ['src'], sourceFingerprint: null, supportingFiles: [] });
      expect(evidence.siteIdentities).toEqual(sites.map((_site, siteIndex) => ({ siteIndex,
        sourcePath: site.path, versionedSymbolId: null, contentHash: null })));
      expect(evidence.relationships.every(edge => edge.knowledge === 'unknown' && edge.runtimeExecution === 'unknown')).toBe(true);
      expect(evidence.graphScope.sourceCompleteness).toBe('unverified');
    }
  });
});

describe('classifyIndexDisk', () => {
  it('grades a footprint inside the budget as within-budget', () => {
    const v = classifyIndexDisk('testbed', 100, { budgetMb: 2_048, exceedances: [] });
    expect(v.status).toBe('within-budget');
  });

  it('grades a breach with no recorded allowance as over-ceiling', () => {
    const v = classifyIndexDisk('testbed', 5_000, { budgetMb: 2_048, exceedances: [] });
    expect(v.status).toBe('over-ceiling');
    expect(v).toMatchObject({ measuredMb: 5_000, acceptedCeilingMb: null });
  });

  it('accepts a MEASURED breach that is inside its bounded allowance', () => {
    const v = classifyIndexDisk('testbed', 3_500, { budgetMb: 2_048, exceedances: ALLOWANCE });
    expect(v.status).toBe('accepted-exceedance');
    expect(v).toMatchObject({ acceptedCeilingMb: 4_000 });
  });

  it('still FAILS once the accepted exceedance grows past its ceiling', () => {
    // The whole point of a bounded exceedance: accepting today's footprint is
    // not accepting unbounded growth.
    const v = classifyIndexDisk('testbed', 4_001, { budgetMb: 2_048, exceedances: ALLOWANCE });
    expect(v.status).toBe('over-ceiling');
  });

  it("does not apply one backend's allowance to another backend", () => {
    const v = classifyIndexDisk('other', 3_500, { budgetMb: 2_048, exceedances: ALLOWANCE });
    expect(v.status).toBe('over-ceiling');
    expect(v).toMatchObject({ acceptedCeilingMb: null });
  });

  describe('refuses to fabricate a pass', () => {
    it('grades an unmeasured backend not-measured, NOT within-budget', () => {
      // An in-memory-index backend (the LSP adapter) has no subject here.
      // Reporting "0MB, within budget" would be a false guarantee with
      // evidence attached — strictly worse than the dead field this replaced.
      const v = classifyIndexDisk('lsp', null, { budgetMb: 2_048 });
      expect(v.status).toBe('not-measured');
      expect(v.status).not.toBe('within-budget');
      expect(v).toMatchObject({ reason: expect.stringContaining('lsp') });
    });

    it('grades a TRUNCATED walk not-measured even when the partial total looks fine', () => {
      // `dirSizeBytes` returns a partial total when it hits maxEntries or its
      // wall-clock deadline. A partial can only UNDER-count, so a truncated
      // walk that "fits" the budget is exactly how a real breach would read as
      // clean. This is the case a naive grader gets wrong.
      const v = classifyIndexDisk('gitnexus', 10, { truncated: true, budgetMb: 2_048 });
      expect(v.status).toBe('not-measured');
      expect(v).toMatchObject({ reason: expect.stringContaining('partial') });
    });

    it('does not let a truncated walk mask a breach either', () => {
      const v = classifyIndexDisk('gitnexus', 99_999, { truncated: true, budgetMb: 2_048 });
      expect(v.status).toBe('not-measured');
    });
  });

  it('CONTROL: the guard can fail — an injected budget flips the verdict', () => {
    // Falsifiability. Same measurement, two budgets, opposite verdicts. If
    // these ever agree, the grader is not reading the budget at all.
    const measuredMb = 1_000;
    const lenient = classifyIndexDisk('testbed', measuredMb, {
      budgetMb: 2_048,
      exceedances: [],
    });
    const strict = classifyIndexDisk('testbed', measuredMb, { budgetMb: 500, exceedances: [] });
    expect(lenient.status).toBe('within-budget');
    expect(strict.status).toBe('over-ceiling');
    expect(lenient.status).not.toBe(strict.status);
  });
});

describe('KNOWN_INDEX_DISK_EXCEEDANCES', () => {
  it('bounds every recorded exceedance above what was observed', () => {
    // A ceiling at or below the observation would be red on day one — the
    // permanently-failing gauge everyone learns to ignore, which is how the
    // budget got ignored the first time.
    for (const e of KNOWN_INDEX_DISK_EXCEEDANCES) {
      expect(e.observedCeilingMb).toBeGreaterThan(e.observedMb);
      expect(e.why.length).toBeGreaterThan(40);
    }
  });

  it('only records exceedances that actually exceed the budget', () => {
    // A record for a backend already inside the budget would be an allowance
    // for a breach that does not exist — decorative, and it would silently
    // widen the budget if the footprint later grew into it.
    for (const e of KNOWN_INDEX_DISK_EXCEEDANCES) {
      expect(e.observedMb).toBeGreaterThan(DEFAULT_RESOURCE_BUDGET.indexDiskMbMax);
    }
  });

  it('grades the recorded gitnexus footprint as an accepted, bounded exceedance', () => {
    const gitnexus = KNOWN_INDEX_DISK_EXCEEDANCES.find((e) => e.backend === 'gitnexus');
    expect(gitnexus).toBeDefined();
    const v = classifyIndexDisk('gitnexus', (gitnexus as KnownIndexDiskExceedance).observedMb);
    expect(v.status).toBe('accepted-exceedance');
  });
});

/**
 * WI-10005091 (residue of gitnexus-selective-hardening-and-comparison D-002): GitNexus 1.6.9
 * reports a 0-based `startLine`, 1.6.12 a 1-based one, and the production facade's
 * `toOneIndexed('gitnexus', …)` adds +1 unconditionally. These guard that a GitNexus upgrade
 * cannot ship without the line base being re-measured.
 */
describe('GitNexus startLine base is version-aware', () => {
  // Measured on one source tree: getLongLivedAdminPool is declared on 1-based line 145.
  const TRUE_LINE1 = 145;

  it('maps the two measured versions to their measured raw base, and refuses anything else', () => {
    expect(gitnexusStartLineBase('1.6.9')).toBe(0);
    expect(gitnexusStartLineBase('1.6.12')).toBe(1);
    // A banner line (`gitnexus analyze` prints one) parses; the first x.y.z wins.
    expect(gitnexusStartLineBase('GitNexus Analyzer (1.6.12)')).toBe(1);
    // UNMEASURED / unparseable is null — never a default that would silently be off by one.
    expect(gitnexusStartLineBase('1.6.10')).toBeNull();
    expect(gitnexusStartLineBase('2.0.0')).toBeNull();
    expect(gitnexusStartLineBase('unknown (exit 1)')).toBeNull();
    expect(gitnexusStartLineBase(undefined)).toBeNull();
    expect(gitnexusStartLineBase(null)).toBeNull();
  });

  it('the measured raw lines normalise to the SAME grep -n line only through their own base', () => {
    // 1.6.9 raw 144 (0-based) and 1.6.12 raw 145 (1-based) are the same declaration.
    // The facade's +1 is right for the first and one late for the second — the failure this pins.
    expect(toOneIndexed('gitnexus', 144)).toBe(TRUE_LINE1);
    expect(toOneIndexed('gitnexus', 145)).toBe(TRUE_LINE1 + 1);
    expect((145 + 1) - (gitnexusStartLineBase('1.6.12') as number)).toBe(TRUE_LINE1);
  });

  it('LINE_INDEX_BASE.gitnexus equals the measured base of the PINNED GitNexus version', () => {
    // The pin lives in a submodule operator-core does not import, so read the literal. A pin bump
    // (e.g. 1.6.9 -> 1.6.12) must either find the version already measured AND update
    // LINE_INDEX_BASE.gitnexus (making toOneIndexed version-aware for the new pin), or fail here.
    const bridge = fileURLToPath(
      new URL('../../../../libs/papercusp/plugins/gitnexus-bridge/index.ts', import.meta.url),
    );
    const m = /PINNED_GITNEXUS_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(readFileSync(bridge, 'utf8'));
    expect(m, 'PINNED_GITNEXUS_VERSION literal not found in gitnexus-bridge/index.ts').not.toBeNull();
    const pinned = m![1]!;
    const measured = gitnexusStartLineBase(pinned);
    expect(
      measured,
      `PINNED_GITNEXUS_VERSION ${pinned} has no entry in GITNEXUS_START_LINE_BASE_BY_VERSION — ` +
        'measure its raw startLine on getLongLivedAdminPool (declared on 1-based line 145) first',
    ).not.toBeNull();
    expect(LINE_INDEX_BASE.gitnexus).toBe(measured);
  });

  it('the table is frozen so a caller cannot mutate a measurement', () => {
    expect(Object.isFrozen(GITNEXUS_START_LINE_BASE_BY_VERSION)).toBe(true);
  });
});
