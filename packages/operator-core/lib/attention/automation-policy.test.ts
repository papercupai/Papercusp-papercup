import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  readOperatorState: vi.fn(),
  writeOperatorState: vi.fn(),
}));
vi.mock('../operator-state-pg', () => storage);
import {
  DEFAULT_STANDING_BULK_AUTOMATION_POLICY,
  normalizeStandingBulkAutomationPolicy,
} from './bulk-dispositions';
import {
  readStandingBulkAutomationPolicy,
  standingAutomationEligibility,
  writeStandingBulkAutomationPolicy,
} from './automation-policy';

beforeEach(() => {
  vi.clearAllMocks();
  storage.readOperatorState.mockResolvedValue(null);
});

describe('persisted autonomy policy read failures', () => {
  it('keeps unattended execution conservative when storage is unavailable', async () => {
    storage.readOperatorState.mockRejectedValue(new Error('policy storage unavailable'));
    await expect(readStandingBulkAutomationPolicy('test-workspace')).resolves.toEqual(
      DEFAULT_STANDING_BULK_AUTOMATION_POLICY,
    );
  });

  it('refuses to present an unavailable policy as saved defaults', async () => {
    storage.readOperatorState.mockRejectedValue(new Error('policy storage unavailable'));
    await expect(readStandingBulkAutomationPolicy('test-workspace', { strict: true }))
      .rejects.toThrow('policy storage unavailable');
  });

  it('preserves the missing-policy default when storage was successfully read', async () => {
    await expect(readStandingBulkAutomationPolicy('test-workspace', { strict: true }))
      .resolves.toEqual(DEFAULT_STANDING_BULK_AUTOMATION_POLICY);
  });

  it('does not overwrite saved axes after a failed read during a partial update', async () => {
    storage.readOperatorState.mockRejectedValue(new Error('policy storage unavailable'));
    await expect(writeStandingBulkAutomationPolicy({ minConfidence: 'medium' }, 'test-workspace'))
      .rejects.toThrow('policy storage unavailable');
    expect(storage.writeOperatorState).not.toHaveBeenCalled();
  });
});

describe('P-006 standing automation policy', () => {
  it('lets an owner grant every risk without disabling confidence or unknown-kind checks', () => {
    const policy = { level: 'L0' as const, minConfidence: 'high' as const,
      riskLevels: { low: 'automatic' as const, medium: 'automatic' as const, high: 'automatic' as const } };
    for (const kind of ['coord-message', 'work-item-needs-human', 'smoke-fail']) {
      expect(standingAutomationEligibility(policy, kind, 'high')).toEqual({ allowed: true, reason: null });
      expect(standingAutomationEligibility(policy, kind, 'low').allowed).toBe(false);
    }
    expect(standingAutomationEligibility(policy, 'unknown-kind', 'high').allowed).toBe(false);
  });

  it('independently revokes one risk while keeping the other grants', () => {
    const policy = { level: 'L2' as const, minConfidence: 'high' as const,
      riskLevels: { low: 'review' as const, medium: 'automatic' as const, high: 'review' as const } };
    expect(standingAutomationEligibility(policy, 'coord-message', 'high').allowed).toBe(false);
    expect(standingAutomationEligibility(policy, 'work-item-needs-human', 'high').allowed).toBe(true);
    expect(standingAutomationEligibility(policy, 'smoke-fail', 'high').allowed).toBe(false);
  });
  it('ships L0 review-all with an independent high confidence floor', () => {
    expect(DEFAULT_STANDING_BULK_AUTOMATION_POLICY).toEqual({ level: 'L0', minConfidence: 'high' });
    expect(normalizeStandingBulkAutomationPolicy({ level: 'L2', minConfidence: 'low' })).toEqual({
      level: 'L2',
      minConfidence: 'low',
    });
  });

  it('requires BOTH authority and confidence axes for a delegable kind', () => {
    expect(
      standingAutomationEligibility({ level: 'L1', minConfidence: 'high' }, 'coord-message', 'medium'),
    ).toEqual({ allowed: false, reason: 'confidence-below-floor' });
    expect(
      standingAutomationEligibility({ level: 'L1', minConfidence: 'medium' }, 'coord-message', 'high'),
    ).toEqual({ allowed: true, reason: null });
  });

  it('falsifiability control: above-floor owner-by-right still refuses at L1', () => {
    expect(
      standingAutomationEligibility({ level: 'L1', minConfidence: 'high' }, 'work-item-needs-human', 'high'),
    ).toEqual({ allowed: false, reason: 'owner-by-right' });
  });

  it('granting L2 authority does not bypass the confidence floor', () => {
    expect(
      standingAutomationEligibility({ level: 'L2', minConfidence: 'high' }, 'work-item-needs-human', 'medium'),
    ).toEqual({ allowed: false, reason: 'confidence-below-floor' });
  });

  it('never-auto remains a permanent floor at every level and confidence', () => {
    expect(
      standingAutomationEligibility({ level: 'L2', minConfidence: 'low' }, 'smoke-fail', 'high'),
    ).toEqual({ allowed: false, reason: 'never-auto' });
  });
});
