import { describe, expect, it } from 'vitest';
import {
  gateRedCompletionClaimVerdict,
  gateRedCompletionClaimWarning,
  looksLikeGateRedFixClaim,
} from './gate-red-completion-claim';
import type { FrozenRepairEditMarker } from './frozen-repair-edit-marker';
import type { PathContainment } from './judged-sha-containment';
import { renderAdmitCommand } from './repair-manifest';

const marker: FrozenRepairEditMarker = {
  candidate: 'c'.repeat(40),
  repairHead: 'r'.repeat(40),
  phase: 'repair-in-progress',
  failingPaths: ['a/failing.test.ts', 'b/failing.test.ts'],
  updatedAtMs: 1,
  admittedPaths: [],
  legs: [],
};

/** Containment stub: every path in `contained` is carried by the judged sha. */
const containment =
  (contained: string[]) =>
  (paths: string[]): PathContainment[] =>
    paths.map((path) => ({
      path,
      containedInJudgedSha: contained.includes(path),
      judgedBlob: contained.includes(path) ? 'same' : 'old',
      stagingBlob: 'same',
    }));

describe('looksLikeGateRedFixClaim', () => {
  it('recognises the phrasings agents actually use', () => {
    for (const summary of [
      'Fixed 7 gate reds',
      'fixed the gate-red on the checkpoint',
      'greened the gate',
      'the gate is green now',
      'cleared a green-checkpoint red',
      'fixed 3 of 10 gate reds',
    ]) {
      expect(looksLikeGateRedFixClaim({ summary }), summary).toBe(true);
    }
  });

  it('does NOT fire on ordinary closes — a nagging check gets ignored', () => {
    for (const summary of [
      'Fixed a flaky test in the sync resolver',
      'Added a red border to the settings panel',
      'Refactored the gateway client',
      'Updated the README',
    ]) {
      expect(looksLikeGateRedFixClaim({ summary }), summary).toBe(false);
    }
  });

  it('does NOT fire on red-state observations, identifiers, or quoted explanations', () => {
    for (const summary of [
      'P-005 still blocked: positions.deployed FALSE; Gate red 94.',
      'The gate is red, not green, and remains blocked.',
      'gate-reds-mostly-unowned',
      'The check id `gate-reds-mostly-unowned` is data, not a gate claim.',
      'The detector says "Gate red 94" matches like "greened the gate".',
    ]) {
      expect(looksLikeGateRedFixClaim({ summary }), summary).toBe(false);
    }
  });

  it('reads every evidence field, not just the summary', () => {
    expect(looksLikeGateRedFixClaim({ testResult: 'gate red cleared' })).toBe(true);
    expect(looksLikeGateRedFixClaim({ verifiedHow: 'greened the gate' })).toBe(true);
    expect(looksLikeGateRedFixClaim(undefined)).toBe(false);
  });
});

describe('gateRedCompletionClaimWarning (P-006)', () => {
  it('flags a gate-red claim whose fixes the judged sha does NOT carry', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts', 'b/failing.test.ts'] },
      { marker, containment: containment([]) },
    );
    expect(w).toBeDefined();
    expect(w?.uncontainedPaths).toEqual(['a/failing.test.ts', 'b/failing.test.ts']);
    expect(w?.judgedSha).toBe(marker.repairHead);
    expect(w?.detail).toContain('GATE CANNOT SEE');
    expect(w?.detail).toContain("op:'admit'");
  });

  it('is SILENT when the judged sha carries every named failing path', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts', 'b/failing.test.ts'] },
      { marker, containment: containment(['a/failing.test.ts', 'b/failing.test.ts']) },
    );
    expect(w).toBeUndefined();
  });

  it('flags a PARTIAL claim — the mixed case is the one that reads as success', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts', 'b/failing.test.ts'] },
      { marker, containment: containment(['a/failing.test.ts']) },
    );
    expect(w?.uncontainedPaths).toEqual(['b/failing.test.ts']);
    expect(w?.containedPaths).toEqual(['a/failing.test.ts']);
  });

  it('is silent when nothing is frozen — an ordinary commit IS the judged lineage', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts'] },
      { marker: null, containment: containment([]) },
    );
    expect(w).toBeUndefined();
  });

  it('is silent for a close that makes no gate claim, even with uncontained paths', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Refactored the resolver', filesChanged: ['a/failing.test.ts'] },
      { marker, containment: containment([]) },
    );
    expect(w).toBeUndefined();
  });

  it('judges ONLY paths in the failing set — unrelated files are not this bug', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['unrelated/file.ts'] },
      { marker, containment: containment([]) },
    );
    expect(w).toBeUndefined();
  });

  it('normalizes declared paths before matching the failing set', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed a gate red', filesChanged: ['./a/failing.test.ts'] },
      { marker, containment: containment([]) },
    );
    expect(w?.uncontainedPaths).toEqual(['a/failing.test.ts']);
  });

  it('is silent when no paths were declared — it cannot judge, so it does not guess', () => {
    expect(
      gateRedCompletionClaimWarning({ summary: 'Fixed 2 gate reds' }, { marker }),
    ).toBeUndefined();
  });

  it('fails OPEN when the containment probe throws — never blocks a close', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed a gate red', filesChanged: ['a/failing.test.ts'] },
      {
        marker,
        containment: () => {
          throw new Error('git exploded');
        },
      },
    );
    expect(w).toBeUndefined();
  });
});

// P-022 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #3): the REFUSAL.
describe('gateRedCompletionClaimVerdict (P-022)', () => {
  const legs: FrozenRepairEditMarker['legs'] = [
    { legId: 'test-file:a/failing.test.ts', status: 'red', subjectPaths: ['a/failing.test.ts'] },
    { legId: 'test-file:b/failing.test.ts', status: 'red', subjectPaths: ['b/failing.test.ts'] },
    { legId: 'lint-leg:lint:tsc', status: 'red', subjectPaths: ['lib/x.ts'] },
  ];
  const withLedger = (admittedPaths: string[], legsOverride = legs): FrozenRepairEditMarker => ({
    ...marker,
    admittedPaths,
    legs: legsOverride,
  });
  const claim = (filesChanged?: string[]) => ({ summary: 'Fixed 2 gate reds', filesChanged });

  it('allows a completion that makes no gate claim, whatever the ledger says', () => {
    const v = gateRedCompletionClaimVerdict({ summary: 'renamed a helper', filesChanged: ['a/failing.test.ts'] }, { marker: withLedger([]) });
    expect(v).toEqual({ refuse: false, reason: 'no-claim' });
  });

  it('allows when nothing is frozen — an ordinary commit IS the judged lineage', () => {
    expect(gateRedCompletionClaimVerdict(claim(['a/failing.test.ts']), { marker: null })).toEqual({ refuse: false, reason: 'no-frozen-queue' });
  });

  it('REFUSES a gate-red claim whose red-radius paths are not in the admission ledger, naming the exact admit command', () => {
    const v = gateRedCompletionClaimVerdict(claim(['a/failing.test.ts', 'b/failing.test.ts']), { marker: withLedger([]) });
    expect(v.refuse).toBe(true);
    if (!v.refuse) throw new Error('unreachable');
    expect(v.reason).toBe('unadmitted-paths');
    expect(v.unadmittedPaths).toEqual(['a/failing.test.ts', 'b/failing.test.ts']);
    expect(v.judgedSha).toBe(marker.repairHead);
    // The SAME renderer the P-021 manifest uses, so the refusal and the manifest row agree byte-for-byte.
    expect(v.admitCommand).toBe(renderAdmitCommand(['a/failing.test.ts', 'b/failing.test.ts']));
    expect(v.admitCommand).toMatch(/release:repair-queue \{ op: ?'admit'/);
    expect(v.detail).toContain('REFUSED');
    expect(v.detail).toContain(v.admitCommand!);
    expect(v.detail).toContain('No completion record or state transition was written');
  });

  it('allows when every claimed red-radius path is admitted AND its leg no longer reads red', () => {
    const admittedLegs = legs.map((l) => (l.subjectPaths[0] === 'lib/x.ts' ? l : { ...l, status: 'admitted' as const }));
    const v = gateRedCompletionClaimVerdict(claim(['a/failing.test.ts', 'b/failing.test.ts']), {
      marker: withLedger(['a/failing.test.ts', 'b/failing.test.ts'], admittedLegs),
    });
    expect(v).toMatchObject({ refuse: false, reason: 'admitted', admittedPaths: ['a/failing.test.ts', 'b/failing.test.ts'] });
  });

  it('a path in the ledger whose leg STILL reads red is refused as not-yet-verified, not as unadmitted', () => {
    const v = gateRedCompletionClaimVerdict(claim(['a/failing.test.ts']), { marker: withLedger(['a/failing.test.ts']) });
    expect(v.refuse).toBe(true);
    if (!v.refuse) throw new Error('unreachable');
    expect(v.reason).toBe('unadmitted-paths');
    expect(v.detail).toMatch(/admitted but their leg still reads red/);
  });

  it('the PARTIAL claim — one admitted, one not — is refused for exactly the unadmitted path', () => {
    const half = legs.map((l) => (l.subjectPaths[0] === 'a/failing.test.ts' ? { ...l, status: 'admitted' as const } : l));
    const v = gateRedCompletionClaimVerdict(claim(['a/failing.test.ts', 'b/failing.test.ts']), {
      marker: withLedger(['a/failing.test.ts'], half),
    });
    expect(v.refuse).toBe(true);
    if (!v.refuse) throw new Error('unreachable');
    expect(v.unadmittedPaths).toEqual(['b/failing.test.ts']);
  });

  it('paths outside the red radius are not this bug — allowed with no-relevant-paths', () => {
    const v = gateRedCompletionClaimVerdict(claim(['docs/README.md']), { marker: withLedger([]) });
    expect(v).toMatchObject({ refuse: false, reason: 'no-relevant-paths' });
  });

  it('a prose claim with NO filesChanged while legs are red is refused: paths-required', () => {
    const v = gateRedCompletionClaimVerdict(claim(), { marker: withLedger([]) });
    expect(v.refuse).toBe(true);
    if (!v.refuse) throw new Error('unreachable');
    expect(v.reason).toBe('paths-required');
    expect(v.redLegs.map((l) => l.legId)).toEqual(legs.map((l) => l.legId));
  });

  it('a prose claim with no filesChanged is ALLOWED once no leg is red (pre-P-021 marker or all green)', () => {
    expect(gateRedCompletionClaimVerdict(claim(), { marker: withLedger([], []) })).toMatchObject({ refuse: false, reason: 'no-relevant-paths' });
    const green = legs.map((l) => ({ ...l, status: 'green' as const }));
    expect(gateRedCompletionClaimVerdict(claim(), { marker: withLedger([], green) })).toMatchObject({ refuse: false, reason: 'no-relevant-paths' });
  });

  it('the gate-red CONDITION item is refused while any manifest leg reads red, whatever the prose says', () => {
    const v = gateRedCompletionClaimVerdict({ summary: 'closing the streak item' }, { gateRedConditionItem: true, marker: withLedger([]) });
    expect(v.refuse).toBe(true);
    if (!v.refuse) throw new Error('unreachable');
    expect(v.reason).toBe('legs-still-red');
    expect(v.redLegs).toHaveLength(3);
    expect(v.detail).toContain('gate-red condition item');
  });

  it('allows an administrative duplicate/drop settlement of the condition item without asserting green', () => {
    const v = gateRedCompletionClaimVerdict(
      { summary: 'superseded by the canonical live owner' },
      { gateRedConditionItem: true, administrativeSettlement: true, marker: withLedger([]) },
    );
    expect(v).toMatchObject({
      refuse: false,
      reason: 'no-relevant-paths',
      candidate: marker.candidate,
      judgedSha: marker.repairHead,
    });
  });

  it('does not let an administrative settlement suppress an explicit gate-red progress claim', () => {
    const v = gateRedCompletionClaimVerdict(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts'] },
      { gateRedConditionItem: true, administrativeSettlement: true, marker: withLedger([]) },
    );
    expect(v.refuse).toBe(true);
    if (!v.refuse) throw new Error('unreachable');
    expect(v.reason).toBe('unadmitted-paths');
    expect(v.unadmittedPaths).toEqual(['a/failing.test.ts']);
  });

  // green-main-cycle-time-2026-10-08 P-013 / D-028 (owner-approved D-021 fix 2): every leg
  // admitted or green is NOT main green — the marker exists only while the frozen queue holds.
  it('the gate-red CONDITION item is refused while the frozen queue still holds, even with every leg admitted or green', () => {
    const done = legs.map((l, i) => ({ ...l, status: i === 0 ? ('green' as const) : ('admitted' as const) }));
    const v = gateRedCompletionClaimVerdict({ summary: 'closing the streak item' }, { gateRedConditionItem: true, marker: withLedger(['lib/x.ts'], done) });
    expect(v.refuse).toBe(true);
    if (!v.refuse) throw new Error('unreachable');
    expect(v.reason).toBe('main-still-red');
    expect(v.detail).toContain('main is still red');
    expect(v.admitCommand).toBeNull();
  });

  it('the gate-red CONDITION item closes once the frozen queue has cleared (main green: no marker)', () => {
    const v = gateRedCompletionClaimVerdict({ summary: 'closing the streak item' }, { gateRedConditionItem: true, marker: null });
    expect(v).toEqual({ refuse: false, reason: 'no-frozen-queue' });
  });

  it('an administrative settlement of the condition item is still allowed while the queue holds with every leg admitted', () => {
    const done = legs.map((l) => ({ ...l, status: 'admitted' as const }));
    const v = gateRedCompletionClaimVerdict({ summary: 'duplicate of the live streak item' }, { gateRedConditionItem: true, administrativeSettlement: true, marker: withLedger(['lib/x.ts'], done) });
    expect(v.refuse).toBe(false);
  });

  it('normalizes declared paths before matching the radius and the ledger', () => {
    const admittedLegs = legs.map((l) => ({ ...l, status: 'admitted' as const }));
    const v = gateRedCompletionClaimVerdict(claim(['./a/failing.test.ts']), { marker: withLedger(['a/failing.test.ts'], admittedLegs) });
    expect(v).toMatchObject({ refuse: false, reason: 'admitted' });
  });

  it('fails OPEN on a detector fault, and says so', () => {
    const broken = { ...withLedger([]), legs: null as unknown as FrozenRepairEditMarker['legs'] };
    expect(gateRedCompletionClaimVerdict(claim(['a/failing.test.ts']), { marker: broken })).toEqual({ refuse: false, reason: 'detector-fault' });
  });
});
