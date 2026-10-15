/**
 * FSWE-P018-SAMEMODEL (benchmark-coverage-frontierswe-v2-2026-10-10#P-018): harness lift is only
 * attributable when the native-CLI reference arm and the Papercusp arm run the SAME model. A study
 * that freezes a reference on a different model id is refused by the protocol schema, which both
 * preregistration and the launcher parse before any trial starts.
 */
import { describe, expect, it } from 'vitest';
import { currentBenchmarkProtocolSchema, isNativeCliReferenceArm, type CurrentBenchmarkProtocol } from './schema';
import { allCapabilities, controlledProtocolFixture, currentProtocolFixture } from './_protocol-test-fixture';

const issuesOf = (protocol: unknown) => {
  const parsed = currentBenchmarkProtocolSchema.safeParse(protocol);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.message);
};
const SAME_MODEL = /native-CLI reference|same model/i;
const withRate = (protocol: CurrentBenchmarkProtocol, model: string) => {
  protocol.priceSchedule.rates.push({ model, inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2 });
  return protocol;
};
const armOf = (protocol: CurrentBenchmarkProtocol, id: string) => protocol.arms.find(arm => arm.id === id)!;
/** A controlled arm on its own solver group, so the solver-group rule cannot be what refuses it. */
const ownGroupArm = (protocol: CurrentBenchmarkProtocol, id: string, overrides: { agent: 'codex' | 'claude'; model: string },
  topology: 'stock-native-reference' | 'solo') => ({
  ...structuredClone(protocol.arms[0]), id, ...overrides,
  control: { topology, solverGroup: `${id}-solver`, solverToolsHash: 'f'.repeat(64),
    capabilities: allCapabilities(topology === 'stock-native-reference' ? 'off' : 'on') },
});

describe('native-CLI reference arms run the Papercusp arm model', () => {
  it('identifies the reference by its declared topology, or by the launcher\'s stock arm id when uncontrolled', () => {
    const uncontrolled = currentProtocolFixture();
    expect(uncontrolled.arms.map(isNativeCliReferenceArm)).toEqual([false, true]);
    const controlled = controlledProtocolFixture();
    expect(controlled.arms.filter(isNativeCliReferenceArm).map(arm => arm.id)).toEqual(['stock']);
    // A controlled arm named 'baseline' is whatever topology it declares, not a reference by name.
    armOf(controlled, 'solo').id = 'baseline';
    expect(isNativeCliReferenceArm(armOf(controlled, 'baseline'))).toBe(false);
  });

  it('accepts the matched fixtures (positive controls)', () => {
    expect(issuesOf(currentProtocolFixture())).toEqual([]);
    expect(issuesOf(controlledProtocolFixture())).toEqual([]);
  });

  it('refuses an uncontrolled stock baseline on a different model from the Papercusp arm', () => {
    const protocol = withRate(currentProtocolFixture(), 'other-model');
    armOf(protocol, 'baseline').model = 'other-model';
    const issues = issuesOf(protocol);
    expect(issues).toContainEqual(expect.stringMatching(/Native-CLI reference arm baseline runs other-model/));
    expect(issues).toContainEqual(expect.stringMatching(/Papercusp arm papercusp runs configured-alias with no native-CLI reference on the same model/));
  });

  it('refuses a controlled stock-native reference on its own solver group with a different model', () => {
    const protocol = withRate(controlledProtocolFixture(), 'other-model');
    protocol.arms = protocol.arms.filter(arm => arm.id !== 'stock');
    protocol.arms.push(ownGroupArm(protocol, 'stock', { agent: 'codex', model: 'other-model' }, 'stock-native-reference'));
    const issues = issuesOf(protocol);
    // The solver-group rule is satisfied (own group), so only the same-model rule can refuse it.
    expect(issues.some(message => /solver group/.test(message))).toBe(false);
    expect(issues).toContainEqual(expect.stringMatching(/Native-CLI reference arm stock runs other-model/));

    const matched = controlledProtocolFixture();
    matched.arms = matched.arms.filter(arm => arm.id !== 'stock');
    matched.arms.push(ownGroupArm(matched, 'stock', { agent: 'codex', model: 'configured-alias' }, 'stock-native-reference'));
    expect(issuesOf(matched)).toEqual([]);
  });

  it('refuses a Claude Code reference until a Papercusp arm runs the same Claude model', () => {
    const protocol = withRate(controlledProtocolFixture(), 'claude-model');
    protocol.arms.push(ownGroupArm(protocol, 'claude-code', { agent: 'claude', model: 'claude-model' }, 'stock-native-reference'));
    expect(issuesOf(protocol)).toContainEqual(expect.stringMatching(/Native-CLI reference arm claude-code runs claude-model/));

    protocol.arms.push(ownGroupArm(protocol, 'papercusp-claude', { agent: 'claude', model: 'claude-model' }, 'solo'));
    expect(issuesOf(protocol)).toEqual([]);
  });

  it('refuses a mixed-backbone treatment that has no native-CLI reference on its model', () => {
    const protocol = withRate(controlledProtocolFixture(), 'claude-model');
    protocol.arms.push(ownGroupArm(protocol, 'papercusp-claude', { agent: 'claude', model: 'claude-model' }, 'solo'));
    expect(issuesOf(protocol)).toContainEqual(
      expect.stringMatching(/Papercusp arm papercusp-claude runs claude-model with no native-CLI reference on the same model/));
  });

  it('does not constrain a Papercusp-only study with no native-CLI reference', () => {
    const protocol = withRate(currentProtocolFixture(), 'other-model');
    armOf(protocol, 'baseline').id = 'papercusp-other';
    armOf(protocol, 'papercusp-other').model = 'other-model';
    expect(issuesOf(protocol).filter(message => SAME_MODEL.test(message))).toEqual([]);
  });
});
