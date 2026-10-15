import { describe, expect, it, vi } from 'vitest';
import { attachDerivedShipGates, projectDerivedShipGate, shipGateApplies } from './derived-ship-gate';
import { shipGatePreflightResult } from './set-plan-status';

// derived-status-not-hand-written-2026-10-12 P-002: the ship-gate step of derivedStatus.

const UNGRADED = {
  planSlug: 'plan-a',
  satisfied: false,
  skipped: null,
  code: 'acceptance_ungraded',
  message: 'The acceptance rubric has no independent grade.',
  unavailableReason: null,
  repairAction: {
    kind: 'independent-grading' as const,
    nextVerb: { name: 'plans:set-plan-status', args: { slug: 'plan-a', status: 'shipped' } },
    instruction: 'Route the rubric to an independent grader.',
  },
};

function planResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    slug: 'plan-a',
    harness: 'papercusp',
    status: 'ready',
    derivedStatus: { counts: { total: 2, terminal: 2, nonTerminal: 0 }, text: '0 actionable' },
    ...over,
  };
}

function shipGateOf(result: Record<string, unknown>) {
  return (result.derivedStatus as { shipGate?: ReturnType<typeof projectDerivedShipGate> }).shipGate;
}

describe('derivedStatus.shipGate — names the refusal of an all-terminal plan', () => {
  it('an all-terminal plan with an ungraded rubric names acceptance_ungraded, the same code the dryRun preflight returns', async () => {
    const resolve = vi.fn(async () => [UNGRADED]);
    const result = planResult();
    await attachDerivedShipGates([result], { resolve });
    const gate = shipGateOf(result)!;
    expect(gate.code).toBe('acceptance_ungraded');
    expect(gate.satisfied).toBe(false);
    // Code parity with plans:set-plan-status { status:'shipped', dryRun:true }: the preflight
    // reports the acceptance gate's code as its `error` when the gate refuses.
    const preflight = shipGatePreflightResult('plan-a', UNGRADED as never);
    expect(gate.code).toBe('error' in preflight ? preflight.error : undefined);
    expect(gate.nextRepair).toEqual({
      kind: 'independent-grading',
      verb: 'plans:set-plan-status',
      nextVerb: UNGRADED.repairAction.nextVerb,
      instruction: 'Route the rubric to an independent grader.',
    });
    expect(gate.text).toBe('ship gate: acceptance_ungraded');
    expect(resolve).toHaveBeenCalledWith({ workspaceId: 'default', planSlug: 'plan-a', harnessSlug: 'papercusp' });
  });

  it('CONTROL: a plan with a live item gets no shipGate and never evaluates the gate', async () => {
    const resolve = vi.fn(async () => [UNGRADED]);
    const result = planResult({ derivedStatus: { counts: { total: 2, terminal: 1, nonTerminal: 1 }, text: '1 actionable' } });
    await attachDerivedShipGates([result], { resolve });
    expect(shipGateOf(result)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('an empty plan is not "all terminal": no shipGate', async () => {
    const resolve = vi.fn(async () => [UNGRADED]);
    const result = planResult({ derivedStatus: { counts: { total: 0, terminal: 0, nonTerminal: 0 }, text: '' } });
    await attachDerivedShipGates([result], { resolve });
    expect(shipGateOf(result)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a shipped plan is never re-evaluated', async () => {
    const resolve = vi.fn(async () => [UNGRADED]);
    const result = planResult({ status: 'shipped' });
    await attachDerivedShipGates([result], { resolve });
    expect(shipGateOf(result)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(shipGateApplies(result.derivedStatus, 'superseded')).toBe(false);
  });

  it('reuses a requested shipReadiness verdict instead of evaluating the gate twice', async () => {
    const resolve = vi.fn(async () => [{ ...UNGRADED, code: 'acceptance_rubric_unvetted' }]);
    const result = planResult({ shipReadiness: UNGRADED });
    await attachDerivedShipGates([result], { resolve });
    expect(resolve).not.toHaveBeenCalled();
    expect(shipGateOf(result)!.code).toBe('acceptance_ungraded');
    expect(shipGateOf(result)!.reusedShipReadiness).toBe(true);
  });

  it('a resolver that cannot run is reported as unavailable, never as a pass or an absent field', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('pool exhausted');
    });
    const result = planResult();
    await attachDerivedShipGates([result], { resolve });
    const gate = shipGateOf(result)!;
    expect(gate.satisfied).toBe(false);
    expect(gate.code).toBeNull();
    expect(gate.unavailableReason).toBe('resolver-unavailable');
    expect(gate.text).toBe('ship gate: not evaluated');
  });

  it('a satisfied gate names no code and says which dryRun guards it did not check', () => {
    const gate = projectDerivedShipGate(
      { ...UNGRADED, satisfied: true, code: null },
      { slug: 'plan-a', harness: 'papercusp', reusedShipReadiness: false },
    );
    expect(gate.code).toBeNull();
    expect(gate.nextRepair).toBeNull();
    expect(gate.guardsNotChecked).toEqual(['plan-admission', 'frontmatter-cas']);
    expect(gate.confirmWith).toEqual({
      name: 'plans:set-plan-status',
      args: { slug: 'plan-a', harness: 'papercusp', status: 'shipped', dryRun: true },
    });
  });

  it('is idempotent on a shared (cached) result: a second read neither mutates the summary nor grows its text', async () => {
    const resolve = vi.fn(async () => [UNGRADED]);
    const summary = { counts: { total: 2, terminal: 2, nonTerminal: 0 }, text: '0 actionable' };
    const result = planResult({ derivedStatus: summary });
    await attachDerivedShipGates([result], { resolve });
    const first = JSON.stringify(result.derivedStatus);
    await attachDerivedShipGates([result], { resolve });
    expect(JSON.stringify(result.derivedStatus)).toBe(first);
    expect(summary).toEqual({ counts: { total: 2, terminal: 2, nonTerminal: 0 }, text: '0 actionable' });
    expect((result.derivedStatus as { text: string }).text).toBe('0 actionable');
  });
});
