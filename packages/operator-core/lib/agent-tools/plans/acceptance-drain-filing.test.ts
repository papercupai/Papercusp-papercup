import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  sql: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: M.sql }) };
});
vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: M.upsert,
}));

import {
  ACCEPTANCE_DRAIN_ESCALATE_AFTER_MS,
  ACCEPTANCE_DRAIN_AGE_WARN_AFTER_MS,
  acceptanceDrainObservationSignals,
  ensureAcceptanceDrainFiling,
} from './acceptance-drain-filing';

const input = {
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
  planSlug: 'drained-plan',
  code: 'acceptance_unaudited',
  message: 'run plans:audit',
};

describe('ensureAcceptanceDrainFiling — P-023 characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    M.sql.mockResolvedValue([{ feature_id: 'WI-ACCEPTANCE', harness_slug: 'papercusp' }]);
  });

  it('refreshes an existing keyed filing with the current gate observation', async () => {
    const result = await ensureAcceptanceDrainFiling(input);

    expect(result).toEqual({
      outcome: 'already-open',
      id: 'WI-ACCEPTANCE',
      ref: 'papercusp-workspace/papercusp/drained-plan',
    });
    expect(M.upsert).not.toHaveBeenCalled();
    expect(M.sql).toHaveBeenCalledTimes(2);
  });

  it('replaces a pending handoff observation in-place without minting or reassigning', async () => {
    M.sql.mockResolvedValueOnce([{
      feature_id: 'WI-ACCEPTANCE', harness_slug: 'papercusp', gate_observation: 'pending',
    }]);
    const result = await ensureAcceptanceDrainFiling(input);
    expect(result).toMatchObject({ outcome: 'already-open', id: 'WI-ACCEPTANCE' });
    expect(M.upsert).not.toHaveBeenCalled();
    const [parts, ...values] = M.sql.mock.calls[1]!;
    const statement = (parts as TemplateStringsArray).join('?');
    expect(statement).toContain('UPDATE harness_shared.work_items');
    expect(statement).toContain('payload = COALESCE(payload');
    expect(statement).toContain('workspace_id =');
    expect(statement).toContain('harness_slug =');
    expect(statement).not.toContain('taken_by =');
    expect(values.some((value) => String(value).includes('acceptance_unaudited'))).toBe(true);
  });
});

describe('acceptanceDrainObservationSignals — P-027 durable age contract', () => {
  const at = new Date('2026-09-21T00:00:00.000Z');
  it('ages an unchanged source generation and marks escalation after 12 hours', () => {
    const first = new Date(at.getTime() - ACCEPTANCE_DRAIN_ESCALATE_AFTER_MS - 1).toISOString();
    const prior = acceptanceDrainObservationSignals(
      { satisfied: false, code: 'acceptance_unaudited' },
      null,
      new Date(first),
      'plan',
    );
    expect(acceptanceDrainObservationSignals(
      { satisfied: false, code: 'acceptance_unaudited' },
      { sourceGeneration: prior.sourceGeneration, firstObservedAt: first },
      at,
      'plan',
    )).toMatchObject({ ageBand: 'overdue', escalation: 'due', firstObservedAt: first });
  });

  it('resets age when the canonical gate generation changes', () => {
    const first = new Date(at.getTime() - ACCEPTANCE_DRAIN_AGE_WARN_AFTER_MS * 2).toISOString();
    const signals = acceptanceDrainObservationSignals(
      { satisfied: false, code: 'acceptance_unaudited' },
      { sourceGeneration: 'old', firstObservedAt: first },
      at,
      'plan',
    );
    expect(signals.firstObservedAt).toBe(at.toISOString());
    expect(signals.ageMs).toBe(0);
    expect(signals.escalation).toBe('none');
  });

  it('keeps an unchanged blocker overdue when only the serving build changes', () => {
    const first = new Date(at.getTime() - ACCEPTANCE_DRAIN_ESCALATE_AFTER_MS - 1).toISOString();
    const prior = acceptanceDrainObservationSignals(
      { satisfied: false, code: 'acceptance_unaudited', buildProvenance: { sha: 'old-build' } },
      null, new Date(first), 'plan',
    );
    const next = acceptanceDrainObservationSignals(
      { satisfied: false, code: 'acceptance_unaudited', buildProvenance: { sha: 'new-build' } },
      { ...prior }, at, 'plan',
    );
    expect(next.sourceGeneration).not.toBe(prior.sourceGeneration);
    expect(next).toMatchObject({ firstObservedAt: first, ageBand: 'overdue', escalation: 'due' });
  });

  it('starts a new blocker episode when the previous repair is cleared', () => {
    const prior = acceptanceDrainObservationSignals(
      { satisfied: false, code: 'acceptance_unaudited' },
      null, new Date(at.getTime() - ACCEPTANCE_DRAIN_ESCALATE_AFTER_MS - 1), 'plan',
    );
    const next = acceptanceDrainObservationSignals(
      { satisfied: false, code: 'acceptance_ungraded' }, { ...prior }, at, 'plan',
    );
    expect(next).toMatchObject({ firstObservedAt: at.toISOString(), ageMs: 0, escalation: 'none' });
  });

  it('does not create a fabricated blocker for an unknown/read failure', async () => {
    M.sql.mockResolvedValueOnce([]);
    await expect(ensureAcceptanceDrainFiling({
      ...input,
      code: null,
      message: 'gate unavailable',
      observation: { satisfied: false, message: 'gate unavailable' },
    })).resolves.toMatchObject({ outcome: 'unknown', id: null });
    expect(M.upsert).not.toHaveBeenCalled();
  });
});
