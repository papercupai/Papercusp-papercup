/**
 * green-main-ratchet-convergence-2026-10-17 P-004 / R-3 — the promotion rule.
 *
 * Every failing test blocks main unless an ACTIVE downgrade covers exactly its file and case.
 * Each case pins one clause: S1 (every failure downgraded → promote), one uncovered failure →
 * hold, S5 (a critical-area downgrade without its risk acknowledgement does not count), and the
 * fail-closed paths (unresolved repo path, a workspace with no per-file list, a case-only
 * downgrade against a file-level failure, a revoked row, no failures at all).
 */
import { describe, expect, it } from 'vitest';
import { classifyCriticalArea } from './critical-area-registry';
import {
  cleanPromotionRatchetHealth,
  decidePromotionRatchet,
  failingFileCovered,
  makeDowngradeCoverage,
  parsePromotionRatchetHealth,
  promotionRatchetHealth,
  unmeasuredPromotionRatchetHealth,
  usableDowngrades,
  type RatchetDowngrade,
  type RatchetFailingFile,
} from './promotion-ratchet';

// Fixture calibration: one ordinary product test, one critical-area (gate) test.
const PLAIN_WS = 'ui';
const PLAIN_DIR = 'packages/ui';
const PLAIN_FILE = 'src/button.test.tsx';
const PLAIN_REPO = `${PLAIN_DIR}/${PLAIN_FILE}`;
const OTHER_FILE = 'src/menu.test.tsx';
const OTHER_REPO = `${PLAIN_DIR}/${OTHER_FILE}`;
const GATE_WS = 'operator-core';
const GATE_DIR = 'packages/operator-core';
const GATE_FILE = 'lib/release/green-checkpoint-health.test.ts';
const GATE_REPO = `${GATE_DIR}/${GATE_FILE}`;

const DIRS: Record<string, string> = { [PLAIN_WS]: PLAIN_DIR, [GATE_WS]: GATE_DIR };
const repoPathOf = (f: RatchetFailingFile) => (DIRS[f.workspace] ? `${DIRS[f.workspace]}/${f.file}` : null);

const down = (testFile: string, extra: Partial<RatchetDowngrade> = {}): RatchetDowngrade => ({
  testFile,
  testCase: '',
  revokedAt: null,
  criticalArea: null,
  riskAcknowledgement: null,
  ...extra,
});

describe('promotion ratchet fixtures', () => {
  it('uses one non-critical and one critical-area test path', () => {
    expect(classifyCriticalArea(PLAIN_REPO)).toBeNull();
    expect(classifyCriticalArea(OTHER_REPO)).toBeNull();
    expect(classifyCriticalArea(GATE_REPO)?.id).toBe('gate');
  });
});

describe('decidePromotionRatchet (P-004, R-3)', () => {
  it('S1: promotes when every failing file is covered by an active downgrade', () => {
    const v = decidePromotionRatchet({
      failingTests: [PLAIN_WS],
      failingFiles: [
        { workspace: PLAIN_WS, file: PLAIN_FILE },
        { workspace: PLAIN_WS, file: OTHER_FILE },
      ],
      downgrades: [down(PLAIN_REPO), down(OTHER_REPO)],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(true);
    expect(v.blockingFailingTests).toEqual([]);
    expect(v.blocking).toEqual([]);
    expect(v.downgraded).toEqual([PLAIN_REPO, OTHER_REPO]); // sorted: button < menu
  });

  it('holds main when one failing file has no downgrade, and names it', () => {
    const v = decidePromotionRatchet({
      failingTests: [PLAIN_WS],
      failingFiles: [
        { workspace: PLAIN_WS, file: PLAIN_FILE },
        { workspace: PLAIN_WS, file: OTHER_FILE },
      ],
      downgrades: [down(PLAIN_REPO)],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blockingFailingTests).toEqual([PLAIN_WS]);
    expect(v.blocking).toEqual([OTHER_REPO]);
    expect(v.downgraded).toEqual([PLAIN_REPO]);
  });

  it('S5: ignores a critical-area downgrade with no risk acknowledgement', () => {
    const v = decidePromotionRatchet({
      failingTests: [GATE_FILE],
      failingFiles: [{ workspace: GATE_WS, file: GATE_FILE }],
      downgrades: [down(GATE_REPO, { criticalArea: 'gate', riskAcknowledgement: '   ' })],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blocking).toEqual([GATE_REPO]);
    expect(v.ignoredDowngrades).toEqual([GATE_REPO]);
  });

  it('S5: an acknowledged critical-area downgrade covers its failure', () => {
    const v = decidePromotionRatchet({
      failingTests: [GATE_FILE],
      failingFiles: [{ workspace: GATE_WS, file: GATE_FILE }],
      downgrades: [
        down(GATE_REPO, {
          criticalArea: 'gate',
          riskAcknowledgement: 'gate: the checkpoint could promote a red candidate; accepted until WI-1 lands',
        }),
      ],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(true);
    expect(v.ignoredDowngrades).toEqual([]);
  });

  it('re-derives the critical area from the path, so a row that omits criticalArea is still checked', () => {
    const { usable, ignored } = usableDowngrades([down(GATE_REPO, { criticalArea: null })]);
    expect(usable).toEqual([]);
    expect(ignored).toEqual([GATE_REPO]);
  });

  it('ignores a revoked downgrade', () => {
    const v = decidePromotionRatchet({
      failingTests: [PLAIN_FILE],
      failingFiles: [{ workspace: PLAIN_WS, file: PLAIN_FILE }],
      downgrades: [down(PLAIN_REPO, { revokedAt: '2026-10-17T00:00:00.000Z' })],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blocking).toEqual([PLAIN_REPO]);
  });

  it('fails closed when the failing file repo path cannot be resolved', () => {
    const v = decidePromotionRatchet({
      failingTests: ['mystery'],
      failingFiles: [{ workspace: 'mystery', file: PLAIN_FILE }],
      downgrades: [down(PLAIN_REPO), down(PLAIN_FILE)],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blocking).toEqual([`mystery::${PLAIN_FILE}`]);
    expect(v.blockingFailingTests).toEqual(['mystery']);
  });

  it('fails closed on a workspace failure with no per-file list (collection crash)', () => {
    const v = decidePromotionRatchet({
      failingTests: [PLAIN_WS],
      failingFiles: [],
      downgrades: [down(PLAIN_REPO), down(OTHER_REPO)],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blockingFailingTests).toEqual([PLAIN_WS]);
    expect(v.blocking).toEqual([PLAIN_WS]);
  });

  it('a case-specific downgrade does not cover a file-level failure', () => {
    const v = decidePromotionRatchet({
      failingTests: [PLAIN_FILE],
      failingFiles: [{ workspace: PLAIN_WS, file: PLAIN_FILE }],
      downgrades: [down(PLAIN_REPO, { testCase: 'renders the label' })],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blocking).toEqual([PLAIN_REPO]);
  });

  it('a gate leg (lint:tsc) is covered only by a downgrade naming exactly that leg', () => {
    const blocked = decidePromotionRatchet({
      failingTests: ['lint:tsc'],
      failingFiles: [],
      downgrades: [down('lint:tsc:operator')],
      repoPathOf,
    });
    expect(blocked.allFailuresDowngraded).toBe(false);
    expect(blocked.blocking).toEqual(['lint:tsc']);

    const covered = decidePromotionRatchet({
      failingTests: ['lint:tsc'],
      failingFiles: [],
      downgrades: [down('lint:tsc', { riskAcknowledgement: 'typecheck-build: accepted for the bounded window' })],
      repoPathOf,
    });
    expect(covered.allFailuresDowngraded).toBe(true);
    expect(covered.downgraded).toEqual(['lint:tsc']);
  });

  it('a gate leg failing beside covered files still holds main', () => {
    const v = decidePromotionRatchet({
      failingTests: [PLAIN_WS, 'lint:tsc'],
      failingFiles: [{ workspace: PLAIN_WS, file: PLAIN_FILE }],
      downgrades: [down(PLAIN_REPO)],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blockingFailingTests).toEqual(['lint:tsc']);
    expect(v.downgraded).toEqual([PLAIN_REPO]);
  });

  it('matches every spelling the runner uses for a failing file entry', () => {
    for (const entry of [PLAIN_FILE, `${PLAIN_WS}::${PLAIN_FILE}`, PLAIN_REPO]) {
      const v = decidePromotionRatchet({
        failingTests: [entry],
        failingFiles: [{ workspace: PLAIN_WS, file: PLAIN_FILE }],
        downgrades: [down(PLAIN_REPO)],
        repoPathOf,
      });
      expect(v.allFailuresDowngraded, entry).toBe(true);
    }
  });

  it('a bare file name shared by two workspaces stays blocking if either copy is uncovered', () => {
    const v = decidePromotionRatchet({
      failingTests: [GATE_FILE],
      failingFiles: [
        { workspace: GATE_WS, file: GATE_FILE },
        { workspace: PLAIN_WS, file: GATE_FILE },
      ],
      // Only the ui copy is downgraded; the operator-core copy of the same bare name is not.
      downgrades: [down(`${PLAIN_DIR}/${GATE_FILE}`)],
      repoPathOf,
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blockingFailingTests).toEqual([GATE_FILE]);
  });

  it('never promotes when there is nothing failing (that is an ordinary green)', () => {
    const v = decidePromotionRatchet({ failingTests: [], failingFiles: [], downgrades: [down(PLAIN_REPO)], repoPathOf });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blocking).toEqual([]);
  });

  // P-017 (D-005): downgrades are keyed by file + case.
  const plainFailure = { failingTests: [`${PLAIN_WS}::${PLAIN_FILE}`], failingFiles: [{ workspace: PLAIN_WS, file: PLAIN_FILE }], repoPathOf };

  it('promotes when every known failing case of a file has its own case-level downgrade', () => {
    const v = decidePromotionRatchet({
      ...plainFailure,
      downgrades: [down(PLAIN_REPO, { testCase: 'renders > disabled' }), down(PLAIN_REPO, { testCase: 'renders > focus ring' })],
      failingCasesOf: () => ['renders > disabled', 'renders > focus ring'],
    });
    expect(v.allFailuresDowngraded).toBe(true);
    expect(v.downgraded).toEqual([PLAIN_REPO]);
  });

  it('holds when one known failing case has no downgrade, even if its sibling case has one', () => {
    const v = decidePromotionRatchet({
      ...plainFailure,
      downgrades: [down(PLAIN_REPO, { testCase: 'renders > disabled' })],
      failingCasesOf: () => ['renders > disabled', 'renders > focus ring'],
    });
    expect(v.allFailuresDowngraded).toBe(false);
    expect(v.blocking).toEqual([PLAIN_REPO]);
  });

  it('holds when the failing cases are unknown and only case-level downgrades exist', () => {
    for (const cases of [null, [], ['  ']]) {
      const v = decidePromotionRatchet({ ...plainFailure, downgrades: [down(PLAIN_REPO, { testCase: 'renders > disabled' })], failingCasesOf: () => cases });
      expect(v.allFailuresDowngraded).toBe(false);
    }
  });

  it('lets a file-level downgrade cover every failing case', () => {
    const v = decidePromotionRatchet({ ...plainFailure, downgrades: [down(PLAIN_REPO)], failingCasesOf: () => ['renders > disabled'] });
    expect(v.allFailuresDowngraded).toBe(true);
  });
});

describe('failingFileCovered / makeDowngradeCoverage (P-017 case keys)', () => {
  it('applies the same case rule at the repair head', () => {
    const covered = makeDowngradeCoverage({ downgrades: [down(PLAIN_REPO, { testCase: 'a' })], dirByWorkspace: DIRS });
    const file = { workspace: PLAIN_WS, file: PLAIN_FILE };
    expect(covered(file, ['a'])).toBe(true);
    expect(covered(file, ['a', 'b'])).toBe(false);
    expect(covered(file)).toBe(false);
    expect(failingFileCovered([down(PLAIN_REPO)], PLAIN_REPO, null)).toBe(true);
  });
});

describe('promotion ratchet health (R-3 exposure)', () => {
  it('reports the blocking and downgraded counts', () => {
    const v = decidePromotionRatchet({
      failingTests: [PLAIN_WS],
      failingFiles: [
        { workspace: PLAIN_WS, file: PLAIN_FILE },
        { workspace: PLAIN_WS, file: OTHER_FILE },
      ],
      downgrades: [down(PLAIN_REPO)],
      repoPathOf,
    });
    const h = promotionRatchetHealth(v);
    expect(h).toMatchObject({
      measured: true,
      blockingFailureCount: 1,
      downgradedFailingCount: 1,
      blocking: [OTHER_REPO],
      downgraded: [PLAIN_REPO],
      promotedBecauseAllDowngraded: false,
    });
    expect(parsePromotionRatchetHealth(JSON.parse(JSON.stringify(h)))).toEqual(h);
  });

  it('an unmeasured read keeps the red verdict and says so', () => {
    const h = unmeasuredPromotionRatchetHealth('connection refused', ['a', 'b']);
    expect(h).toMatchObject({ measured: false, blockingFailureCount: 2, promotedBecauseAllDowngraded: false });
    expect(parsePromotionRatchetHealth(h)).toEqual(h);
  });

  it('a clean run reports zero of each', () => {
    expect(cleanPromotionRatchetHealth()).toMatchObject({ blockingFailureCount: 0, downgradedFailingCount: 0 });
  });

  it('rejects a malformed persisted record', () => {
    expect(parsePromotionRatchetHealth(null)).toBeNull();
    expect(parsePromotionRatchetHealth({ measured: 'yes', blockingFailureCount: 1, downgradedFailingCount: 0 })).toBeNull();
    expect(parsePromotionRatchetHealth({ measured: true, blockingFailureCount: -1, downgradedFailingCount: 0 })).toBeNull();
  });
});
