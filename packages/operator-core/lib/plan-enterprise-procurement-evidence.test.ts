import { describe, expect, it } from 'vitest';
import { inspectInternalRecovery, unsupportedEnterpriseClaims } from './doc-claims/enterprise-evidence';
describe('R10 external claims (no legal/commercial authority conferred)', () => {
  it.each(['We are SOC 2 certified.', 'We are ISO 27001 compliant.', 'We offer a signed DPA.',
    'We guarantee 99.9% uptime.', 'Support costs $100/month.'])('refuses unsupported claim %s', (claim) => {
    expect(unsupportedEnterpriseClaims(claim)).toHaveLength(1);
  });
  it.each(['No SOC 2 certified service is offered.', 'No signed DPA exists.',
    'There is no guaranteed SLA.', 'Unsigned DPA working terms.',
    'External assurance, signed DPA/subprocessor sign-off, priced support/SLA and real MDM enrollment are missing/excluded.'])('permits truthful limitation %s', (claim) => {
    expect(unsupportedEnterpriseClaims(claim)).toEqual([]);
  });
  it('does not let an unrelated disclaimer or semicolon launder a positive claim', () => {
    expect(unsupportedEnterpriseClaims('No certification is offered; we are SOC 2 certified.')).toHaveLength(1);
    expect(unsupportedEnterpriseClaims('No SLA is offered. We guarantee uptime.')).toHaveLength(1);
  });
  it.each([
    'No signed DPA exists, but we are SOC 2 certified.',
    'We are not SOC 2 certified and we guarantee uptime.',
    'No problem, we are SOC 2 certified.',
    'We are not only SOC 2 certified.',
  ])('keeps negation local to its claim: %s', (claim) => {
    expect(unsupportedEnterpriseClaims(claim)).toHaveLength(1);
  });
  it('checks each affirmative claim and permits separate truthful limitations', () => {
    expect(unsupportedEnterpriseClaims('We are SOC 2 certified and offer a signed DPA.')).toHaveLength(2);
    expect(unsupportedEnterpriseClaims('No signed DPA exists and we are not SOC 2 certified.')).toEqual([]);
  });
});
const recovery = { owner: 'internal-operator', reviewer: 'distinct-internal-reviewer',
  responseMs: 60_000, recoveryMs: 300_000, responseTargetMs: 60_000, recoveryTargetMs: 300_000, recovered: true };
describe('R10 internal recovery measurement judgment (synthetic controls)', () => {
  it('accepts the boundary measurement without creating a customer SLA', () => {
    expect(inspectInternalRecovery(recovery)).toEqual([]);
  });
  it.each([
    { responseMs: 60_001 }, { recoveryMs: 300_001 }, { recovered: false },
    { responseMs: NaN }, { recoveryMs: -1 }, { responseTargetMs: Infinity },
    { recoveryTargetMs: 0 }, { owner: '' }, { reviewer: 'internal-operator' },
  ])('refuses missing, invalid, failed or late recovery observation %j', (change) => {
    expect(inspectInternalRecovery({ ...recovery, ...change })).toEqual([{ code: 'internal-recovery-failed', subject: 'P-021' }]);
  });
});
