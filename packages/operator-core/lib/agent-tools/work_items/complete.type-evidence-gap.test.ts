/**
 * EI-19454554361062529 — `typeEvidenceGapInCompletion`: nudge a close that rests on
 * a TEST RUN and changed TypeScript but cites no typecheck.
 *
 * ── WHY THIS GUARD EXISTS ──────────────────────────────────────────────────
 * Vitest transforms via esbuild and never typechecks, so a green suite is not
 * weak evidence about types — it is SILENT about them. Measured 2026-08-03: a
 * peer correctly fixed a runtime bug and closed it citing "8 passed / 0 failed"
 * while the same file carried 11 COMMITTED TS2345 errors that lint:tsc called
 * "a standing red that WILL red the fleet". The evidence was honest and the fix
 * was right; the instrument simply could not see types.
 *
 * ── HOW THIS FILE PROVES ITSELF ────────────────────────────────────────────
 * Falsifiability is structural here rather than needing a separate control: the
 * suite asserts BOTH directions, so a degenerate implementation cannot pass it.
 * One that always returned `undefined` fails every "fires" case; one that always
 * fired fails every "stays silent" case. Both halves are load-bearing — deleting
 * either would leave a guard that a trivial stub satisfies.
 */
import { describe, it, expect } from 'vitest';

import { typeEvidenceGapInCompletion } from '../type-evidence-gap';
import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

const ev = (e: Partial<CompletionVerificationEvidence>): CompletionVerificationEvidence =>
  e as CompletionVerificationEvidence;

describe('typeEvidenceGapInCompletion — FIRES on a type-blind close', () => {
  it('flags a unit-verified close that changed TypeScript and cites no typecheck', () => {
    const gap = typeEvidenceGapInCompletion(
      ev({
        verifiedHow: 'unit',
        filesChanged: ['packages/operator-core/lib/agent-tools/dev/cache_stats.ts'],
        testsRun: 'testing:run cache_stats.test.ts',
        testResult: '8 passed / 0 failed',
      }),
    );
    // The exact shape of the real 2026-08-03 miss.
    expect(gap).toBeDefined();
    expect(gap?.tsFiles).toEqual(['packages/operator-core/lib/agent-tools/dev/cache_stats.ts']);
  });

  it.each(['unit', 'integration', 'already-passing'] as const)(
    'fires for verifiedHow:%s — each one is a claim grounded in a test run',
    (verifiedHow) => {
      expect(typeEvidenceGapInCompletion(ev({ verifiedHow, filesChanged: ['a.ts'] }))).toBeDefined();
    },
  );

  it.each(['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'DEEP/Path/E.TS'])(
    'recognises %s as a typechecked source',
    (file) => {
      expect(typeEvidenceGapInCompletion(ev({ verifiedHow: 'unit', filesChanged: [file] }))).toBeDefined();
    },
  );

  it('reports ONLY the TypeScript files, so the suggested command is runnable as printed', () => {
    const gap = typeEvidenceGapInCompletion(
      ev({
        verifiedHow: 'unit',
        filesChanged: ['docs/notes.md', 'lib/a.ts', 'sql/007-x.sql', 'lib/b.tsx', 'scripts/tool.mjs'],
      }),
    );
    expect(gap?.tsFiles).toEqual(['lib/a.ts', 'lib/b.tsx']);
  });
});

describe('typeEvidenceGapInCompletion — STAYS SILENT when there is nothing to say', () => {
  it.each([
    ['lint:tsc named in testsRun', { testsRun: 'npm run lint:tsc -- --files=lib/a.ts' }],
    ['tsc named in testResult', { testResult: 'tsc clean, 42 passed' }],
    ['the word typecheck', { testsRun: 'typecheck + suite' }],
    ['build:typecheck', { testsRun: 'build:typecheck project=operator-core' }],
    ['canonical tool followed by scope count', { testsRun: 'Scoped build:typecheck10 requested/44file graph and final4 requested/11file graph' }],
    ['compact compiler result', { testResult: 'tsc0 errors, 42 passed' }],
    ['case-insensitively', { testResult: 'TSC: 0 errors' }],
  ])('the caller already looked — %s', (_label, prose) => {
    // Their own words settle it: they checked, so a nudge would be pure noise.
    expect(
      typeEvidenceGapInCompletion(ev({ verifiedHow: 'unit', filesChanged: ['lib/a.ts'], ...prose })),
    ).toBeUndefined();
  });

  it.each(['manual', 'live-drove-ui'] as const)(
    'verifiedHow:%s makes no test-run claim, so there is no type-blind instrument to warn about',
    (verifiedHow) => {
      expect(typeEvidenceGapInCompletion(ev({ verifiedHow, filesChanged: ['lib/a.ts'] }))).toBeUndefined();
    },
  );

  it('no TypeScript changed — a docs/SQL/mjs close is type-irrelevant', () => {
    expect(
      typeEvidenceGapInCompletion(
        ev({ verifiedHow: 'unit', filesChanged: ['README.md', 'sql/007-x.sql', 'scripts/x.mjs'] }),
      ),
    ).toBeUndefined();
  });

  it('does not fire on a filename that merely CONTAINS ts — the extension must match', () => {
    // `assets.tsv` and `charts.png` are not TypeScript; matching them would train
    // agents to ignore the warning, which costs more than staying quiet.
    expect(
      typeEvidenceGapInCompletion(ev({ verifiedHow: 'unit', filesChanged: ['data/assets.tsv', 'x.tsbuildinfo'] })),
    ).toBeUndefined();
  });

  it('no filesChanged, and no evidence at all, are both silent rather than a guess', () => {
    expect(typeEvidenceGapInCompletion(ev({ verifiedHow: 'unit' }))).toBeUndefined();
    expect(typeEvidenceGapInCompletion(ev({ verifiedHow: 'unit', filesChanged: [] }))).toBeUndefined();
    expect(typeEvidenceGapInCompletion(undefined)).toBeUndefined();
  });

  it('evidence with no verifiedHow at all cannot be judged, so it says nothing', () => {
    expect(typeEvidenceGapInCompletion(ev({ filesChanged: ['lib/a.ts'] }))).toBeUndefined();
  });
});

describe('typeEvidenceGapInCompletion — does not mistake other words for a typecheck', () => {
  it.each(['typechecker helper tested', 'tsconfig updated', 'notypecheck was run', 'types0'])('%s still needs type evidence', (testsRun) => {
    expect(typeEvidenceGapInCompletion(ev({
      verifiedHow: 'unit', filesChanged: ['lib/a.ts'], testsRun,
    }))).toEqual({ tsFiles: ['lib/a.ts'] });
  });
});
