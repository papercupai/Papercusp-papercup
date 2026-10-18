/** Independent P023 preimplementation tests for change-kind P004 / R4. */
import { describe, expect, it } from 'vitest';
import {
  evaluateChangeKindGate,
  type ChangeKindGateInput,
  type ChangeKindGateResult,
} from './change-kind-proof';
import type { ChangeKind, ChangeKindEvidence } from './change-kind-catalog';
import type { ChangeKindsView } from './work-item-change-kinds';

const AT = '2026-10-19T00:00:00.000Z';
const CLAIM = {
  kinds: ['ui', 'logic'] as ChangeKind[],
  step: 'claim' as const,
  declaredBy: 'su-independent-fixture',
  declaredAt: AT,
  reason: null,
};

function close(overrides: Partial<ChangeKindGateInput> = {}): ChangeKindGateInput {
  return {
    itemId: 'WI-r4-fixture',
    successfulClose: true,
    claimStartedAt: AT,
    stored: { current: CLAIM.kinds, history: [CLAIM] },
    declaredAtClose: ['logic'],
    root: { testsRun: 'npx vitest run ranking.test.ts', testResult: '2 passed' },
    ...overrides,
  };
}

function expectReasonRefusal(result: ChangeKindGateResult): void {
  expect(result.applicable).toBe(true);
  if (!result.applicable || result.outcome !== 'refuse') {
    expect.fail(`A reasonless removal must keep the item open: ${JSON.stringify(result)}`);
  }
  expect(result.error).toMatch(/changeKindReason/);
  // No missing test proof can stand in for the declaration-reason requirement.
  expect(result.missing).toEqual([]);
}

describe('R4 reasons for narrowed change-kind declarations', () => {
  it.each([undefined, '', '   '])('refuses removing ui with reason %j despite valid logic proof', async (reason) => {
    expectReasonRefusal(await evaluateChangeKindGate(close({ declaredReason: reason })));
  });

  it('accepts removing ui when the declaration carries an explicit reason', async () => {
    const result = await evaluateChangeKindGate(close({
      declaredReason: 'The UI work moved to WI-ui-follow-up; this item changes ranking logic only.',
    }));
    expect(result).toMatchObject({ applicable: true, outcome: 'pass', kinds: ['logic'] });
  });

  it('does not launder a reasonless narrowing through a previous close attempt', async () => {
    const stored: ChangeKindsView = {
      current: ['logic'],
      history: [CLAIM, { ...CLAIM, kinds: ['logic'], step: 'complete' }],
    };
    expectReasonRefusal(await evaluateChangeKindGate(close({ stored, declaredAtClose: undefined })));
  });

  it('accepts a retry when the earlier narrowing already recorded its reason', async () => {
    const stored: ChangeKindsView = {
      current: ['logic'],
      history: [CLAIM, {
        ...CLAIM,
        kinds: ['logic'],
        step: 'complete',
        reason: 'The UI work moved to WI-ui-follow-up.',
      }],
    };
    expect(await evaluateChangeKindGate(close({ stored, declaredAtClose: undefined })))
      .toMatchObject({ applicable: true, outcome: 'pass', kinds: ['logic'] });
  });

  it('does not require a narrowing reason for a reordered or expanded set', async () => {
    const proof: ChangeKindEvidence[] = [
      { kind: 'logic', testsRun: 'npx vitest run ranking.test.ts', testResult: '2 passed' },
      { kind: 'docs', readBack: 'Read back the updated ranking guide.' },
    ];
    for (const kinds of [['logic', 'docs'], ['logic']] as ChangeKind[][]) {
      const stored: ChangeKindsView = {
        current: kinds,
        history: [{ ...CLAIM, kinds }],
      };
      expect(await evaluateChangeKindGate(close({
        stored,
        declaredAtClose: ['docs', 'logic'],
        kindEvidence: proof,
      }))).toMatchObject({ applicable: true, outcome: 'pass' });
    }
  });

  it('leaves non-successful terminal dispositions outside the reason gate', async () => {
    expect(await evaluateChangeKindGate(close({ successfulClose: false }))).toEqual({ applicable: false });
  });
});
