import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_ABLATIONS, capabilityAblationReadiness, requireRunnableAblation, type AblatedCapability,
} from './capability-ablations';
import { BENCHMARK_CAPABILITIES, currentBenchmarkProtocolSchema, requireCurrentBenchmarkAssignment } from './reproducibility/schema';
import { allCapabilities, controlledProtocolFixture } from './reproducibility/_protocol-test-fixture';

const D018_CAPABILITIES = ['memory-recall', 'carry-respawn', 'fleet-leader', 'locks', 'consult-router', 'work-item-ledger'];

/** The fixture's coordinated ablation arm, re-pointed at one treatment. */
function ablationOf(treatment: (typeof BENCHMARK_CAPABILITIES)[number]) {
  const protocol = controlledProtocolFixture();
  const control = protocol.arms.find(arm => arm.id === 'coordinated-no-locks')!.control!;
  control.capabilities = { ...allCapabilities('on'), [treatment]: 'off' };
  control.ablation = { of: 'coordinated', treatment };
  return protocol;
}

const launchAblation = (protocol: ReturnType<typeof controlledProtocolFixture>) => requireCurrentBenchmarkAssignment(protocol, {
  runId: 'run-1', armId: 'coordinated-no-locks', taskId: 't1', seed: 1, agent: 'codex', model: 'configured-alias',
  effort: 'high', account: 'auto', budget: { maxUsd: 3, maxWallClockMs: 100 }, topology: 'coordinated',
});

describe('FSWE-P011-ONETOGGLE: one registered ablation per capability shipped since June', () => {
  it('registers exactly the six D-018 capabilities, each a declared protocol capability', () => {
    expect(Object.keys(CAPABILITY_ABLATIONS).sort()).toEqual([...D018_CAPABILITIES].sort());
    for (const capability of D018_CAPABILITIES) expect(BENCHMARK_CAPABILITIES).toContain(capability);
  });

  it.each(D018_CAPABILITIES as AblatedCapability[])('%s defines off, preserved, forbidden and evidence semantics', capability => {
    const definition = CAPABILITY_ABLATIONS[capability];
    expect(definition.capability).toBe(capability);
    expect(definition.variant).toBe(`${capability}-off`);
    expect(definition.off.trim()).not.toBe('');
    expect(definition.preserve.length).toBeGreaterThan(0);
    expect(definition.never.length).toBeGreaterThan(0);
    expect(definition.inadmissibleWhen.length).toBeGreaterThan(0);
    for (const field of ['availability', 'delivery', 'use'] as const) expect(definition.evidence[field].trim()).not.toBe('');
    const control = definition.nativeControl;
    expect(control.status === 'bound' ? control.ref : control.reason).toMatch(/\S/);
  });

  it.each(D018_CAPABILITIES as AblatedCapability[])('%s-off freezes as a valid single-toggle pair in the protocol', capability => {
    expect(currentBenchmarkProtocolSchema.safeParse(ablationOf(capability)).success).toBe(true);
  });

  it('returns no definition for an arm that is not an ablation, and refuses an unknown arm', () => {
    const protocol = controlledProtocolFixture();
    expect(requireRunnableAblation(protocol, 'coordinated')).toBeNull();
    expect(() => requireRunnableAblation(protocol, 'missing')).toThrow(/not in the frozen protocol/);
  });

  it('withholds fleet-leader-off readiness and launch until the maintained native control is bound', () => {
    const protocol = ablationOf('fleet-leader');
    // A valid frozen one-toggle pair does not establish a native enforcement path.
    // The old bespoke runner's offeredTools filter cannot attest the current su launcher.
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(true);
    expect(capabilityAblationReadiness().find(row => row.capability === 'fleet-leader'))
      .toMatchObject({ runnable: false });
    expect(() => requireRunnableAblation(protocol, 'coordinated-no-locks')).toThrow(/not runnable/);
    expect(() => launchAblation(protocol)).toThrow(/not runnable/);
  });
  it('binds ledger ablation only to the implemented solo topology', () => {
    const protocol = ablationOf('work-item-ledger');
    expect(() => launchAblation(protocol)).toThrow(/not runnable.*only solo/);
    const coordinated = protocol.arms.find(arm => arm.id === 'coordinated')!;
    coordinated.control!.topology = 'solo';
    coordinated.control!.capabilities = { ...allCapabilities('off'), 'work-item-ledger': 'on' };
    const ablated = protocol.arms.find(arm => arm.id === 'coordinated-no-locks')!;
    ablated.control!.topology = 'solo'; ablated.control!.capabilities = allCapabilities('off');
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(true);
    expect(requireRunnableAblation(protocol, ablated.id)).toBe(CAPABILITY_ABLATIONS['work-item-ledger']);
    expect(() => requireCurrentBenchmarkAssignment(protocol, { runId: 'run-1', armId: ablated.id,
      taskId: 't1', seed: 1, agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto',
      budget: { maxUsd: 3, maxWallClockMs: 100 }, topology: 'solo' })).not.toThrow();
  });

  it.each(D018_CAPABILITIES.filter(capability => CAPABILITY_ABLATIONS[capability as AblatedCapability].nativeControl.status === 'unavailable'))
    ('refuses to launch %s-off while its native control is unavailable', capability => {
      const protocol = ablationOf(capability as AblatedCapability);
      expect(() => requireRunnableAblation(protocol, 'coordinated-no-locks')).toThrow(/not runnable/);
      expect(() => launchAblation(protocol)).toThrow(/not runnable/);
    });

  it.each(['planning', 'review'] as const)('refuses an ablation of %s, which has no registered definition', capability => {
    const protocol = ablationOf(capability);
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(true);
    expect(() => launchAblation(protocol)).toThrow(/no registered ablation definition/);
  });

  it.each(D018_CAPABILITIES as AblatedCapability[])('%s-off differs from its full control in exactly that one toggle', capability => {
    const protocol = ablationOf(capability);
    const control = protocol.arms.find(arm => arm.id === 'coordinated')!.control!;
    const ablation = protocol.arms.find(arm => arm.id === 'coordinated-no-locks')!.control!;
    expect(BENCHMARK_CAPABILITIES.filter(key => control.capabilities[key] !== ablation.capabilities[key])).toEqual([capability]);
  });

  // Falsifiers: each way an "ablation" could stop being a one-toggle intervention is refused by the frozen schema.
  type Mutation = (protocol: ReturnType<typeof controlledProtocolFixture>) => void;
  const ablationArm = (p: ReturnType<typeof controlledProtocolFixture>) => p.arms.find(arm => arm.id === 'coordinated-no-locks')!;
  it.each([
    ['zero toggles', (p => { ablationArm(p).control!.capabilities['memory-recall'] = 'on'; }) as Mutation, /exactly memory-recall/],
    ['two toggles', (p => { ablationArm(p).control!.capabilities.locks = 'off'; }) as Mutation, /exactly memory-recall/],
    ['model drift', (p => { ablationArm(p).model = 'other-model'; }) as Mutation, /must freeze identical solver settings/],
    ['budget drift', (p => { (ablationArm(p).generationBudget as { maxUsd: number }).maxUsd = 30; }) as Mutation, /must freeze identical solver settings/],
  ])('refuses a memory-recall-off "ablation" with %s', (_name, mutate, message) => {
    const protocol = ablationOf('memory-recall'); mutate(protocol);
    const parsed = currentBenchmarkProtocolSchema.safeParse(protocol);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.map(issue => issue.message)).toContainEqual(expect.stringMatching(message));
  });

  it('reports per-capability readiness consistent with the registry', () => {
    const readiness = capabilityAblationReadiness();
    expect(readiness.map(entry => entry.capability).sort()).toEqual([...D018_CAPABILITIES].sort());
    for (const entry of readiness) {
      expect(entry.runnable).toBe(CAPABILITY_ABLATIONS[entry.capability].nativeControl.status === 'bound');
    }
  });
});
