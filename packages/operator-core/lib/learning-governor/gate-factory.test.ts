import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { GovernorVerdict } from './core';
import type { GovernorGlueDeps } from './registrants';
import { transferGovernorGate, transferRegistrationInput } from '../transfer/governor';
import { promptAblationGovernorGate, promptAblationRegistrationInput } from '../ablation/governor';
import { negativeSpaceGovernorGate, negativeSpaceRegistrationInput } from '../negative-space/governor';
import { neologismGovernorGate, neologismRegistrationInput } from '../neologism/governor';
import { redQueenGovernorGate, redQueenRegistrationInput } from '../red-queen/governor';
import { calibrationGovernorGate, calibrationRegistrationInput } from '../calibration/governor';
import { deferralInterestGovernorGate, deferralInterestRegistrationInput } from '../deferral-interest/governor';
import { fleetEkgGovernorGate, fleetEkgRegistrationInput } from '../fleet-ekg/governor';
import { graduationGovernorGate, graduationRegistrationInput } from '../graduation/governor';
import { regretGovernorGate, regretRegistrationInput } from '../replay/regret/governor';

const families = [
  {
    name: 'transfer', gate: transferGovernorGate, registrationInput: transferRegistrationInput,
    loopId: 'frontier:transfer-harness', displayName: 'Transfer harness (lesson distillation + student-transfer tests)',
    budgetKind: 'lifetime', logPrefix: 'transfer-distill',
    budgetLabel: 'budget',
  },
  {
    name: 'ablation', gate: promptAblationGovernorGate, registrationInput: promptAblationRegistrationInput,
    loopId: 'prompt-ablation', displayName: 'Prompt sedimentology (weekly shadow ablation)',
    budgetKind: 'per-cycle', logPrefix: 'prompt-ablation',
    budgetLabel: 'per-cycle budget',
  },
  {
    name: 'negative-space', gate: negativeSpaceGovernorGate, registrationInput: negativeSpaceRegistrationInput,
    loopId: 'negative-space-miner', displayName: 'Negative-space miner (zero-hit search demand)',
    budgetKind: 'per-cycle', logPrefix: 'negative-space-mine',
    budgetLabel: 'budget',
  },
  {
    name: 'neologism', gate: neologismGovernorGate, registrationInput: neologismRegistrationInput,
    loopId: 'neologism-miner', displayName: 'Neologism miner (emergent fleet vocabulary)',
    budgetKind: 'per-cycle', logPrefix: 'neologism-mine',
    budgetLabel: 'budget',
  },
  {
    name: 'red-queen', gate: redQueenGovernorGate, registrationInput: redQueenRegistrationInput,
    loopId: 'red-queen', displayName: 'Red Queen (vaccination drills + MTTSH)',
    budgetKind: 'per-cycle', logPrefix: 'red-queen-drill',
    budgetLabel: 'budget',
  },
  {
    name: 'calibration', gate: calibrationGovernorGate, registrationInput: calibrationRegistrationInput,
    loopId: 'calibration-markets', displayName: 'Calibration markets (bet resolution sweep)',
    budgetKind: 'per-cycle', logPrefix: 'calibration-resolve',
    budgetLabel: 'budget',
  },
  {
    name: 'deferral-interest', gate: deferralInterestGovernorGate, registrationInput: deferralInterestRegistrationInput,
    loopId: 'deferral-interest-refit', displayName: 'Deferral-interest refit (learned deferral pricing)',
    budgetKind: 'per-cycle', logPrefix: 'deferral-interest-refit',
    budgetLabel: 'budget',
  },
  {
    name: 'fleet-ekg', gate: fleetEkgGovernorGate, registrationInput: fleetEkgRegistrationInput,
    loopId: 'fleet-ekg', displayName: 'Fleet EKG (behavioral drift monitor)',
    budgetKind: 'per-cycle', logPrefix: 'fleet-ekg-scan',
    budgetLabel: 'budget',
  },
  {
    name: 'graduation', gate: graduationGovernorGate, registrationInput: graduationRegistrationInput,
    loopId: 'graduation-tracker', displayName: 'Graduation evidence tracker (per-class clean-pass counters)',
    budgetKind: 'per-cycle', logPrefix: 'graduation-scan',
    budgetLabel: 'budget',
  },
  {
    name: 'replay/regret', gate: regretGovernorGate, registrationInput: regretRegistrationInput,
    loopId: 'regret-mining', displayName: 'Regret mining (bad-session counterfactual replay)',
    budgetKind: 'per-cycle', logPrefix: 'regret-mine',
    budgetLabel: 'budget',
  },
] as const;

const SQL = {} as Sql;
afterEach(() => vi.restoreAllMocks());

// Exercise the public gates together: metadata differences must survive sharing
// the control flow, and registration must never arm or allow an unbudgeted loop.
describe.each(families)('$name shared first-contact governor gate', (family) => {
  function fixture(verdict: GovernorVerdict = { allow: false, reason: 'unregistered', remainingUsd: null }) {
    const getSql = vi.fn(async () => SQL);
    const register = vi.fn(async () => {});
    const check = vi.fn(async () => verdict);
    const log = vi.fn();
    const deps: GovernorGlueDeps = { enabled: async () => true, getSql, register, check, log };
    return { deps, getSql, register, check, log, verdict };
  }

  it('preserves registration identity without supplying owner-controlled settings', async () => {
    const f = fixture();
    expect(family.registrationInput('workspace-a')).toEqual({
      workspaceId: 'workspace-a', loopId: family.loopId, displayName: family.displayName,
      budgetKind: family.budgetKind, enforcement: 'governor',
    });
    expect(await family.gate('workspace-a', f.deps)).toBe(f.verdict);
    expect(f.check).toHaveBeenCalledWith(SQL, { workspaceId: 'workspace-a', loopId: family.loopId });
    expect(f.register).toHaveBeenCalledExactlyOnceWith(SQL, family.registrationInput('workspace-a'));
    expect(f.log).toHaveBeenCalledExactlyOnceWith(
      `self-registered loop ${family.loopId} UNBUDGETED on the learning governor ` +
        `(D-004 watch list) — refusing until the owner sets a ${family.budgetLabel} (P-001 arming act)`,
    );
  });

  it('does not resolve PG, check or register while dark', async () => {
    const f = fixture();
    f.deps.enabled = async () => false;
    await expect(family.gate('workspace-a', f.deps)).resolves.toEqual({
      allow: false, reason: 'governor-dark', remainingUsd: null,
    });
    expect(f.getSql).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  });

  it('preserves budgeted and refusing verdicts without rewriting registration', async () => {
    const verdicts: GovernorVerdict[] = [
      { allow: true, remainingUsd: 0 },
      { allow: true, remainingUsd: 4.5 },
      { allow: false, reason: 'unbudgeted', remainingUsd: null },
      { allow: false, reason: 'disabled', remainingUsd: null },
      { allow: false, reason: 'exhausted', remainingUsd: 0 },
    ];
    for (const verdict of verdicts) {
      const f = fixture(verdict);
      expect(await family.gate('workspace-a', f.deps)).toBe(verdict);
      expect(f.register).not.toHaveBeenCalled();
    }
  });

  it('refuses after a failed registration and retries on the next first-contact tick', async () => {
    const f = fixture();
    f.register.mockRejectedValueOnce(new Error('registry unavailable'));
    expect(await family.gate('workspace-a', f.deps)).toBe(f.verdict);
    expect(f.log).toHaveBeenCalledWith(
      'governor self-registration failed (next tick retries): registry unavailable',
    );
    expect(await family.gate('workspace-b', f.deps)).toBe(f.verdict);
    expect(f.register).toHaveBeenLastCalledWith(SQL, family.registrationInput('workspace-b'));
    expect(f.register).toHaveBeenCalledTimes(2);
  });

  it('fails closed on preflight IO errors without attempting registration', async () => {
    const f = fixture();
    f.check.mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(family.gate('workspace-a', f.deps)).resolves.toEqual({
      allow: false, reason: 'governor-error', remainingUsd: null,
    });
    expect(f.register).not.toHaveBeenCalled();
  });

  it('keeps its default log prefix', async () => {
    const f = fixture();
    delete f.deps.log;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await family.gate('workspace-a', f.deps);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[${family.logPrefix}] self-registered loop ${family.loopId} UNBUDGETED on the learning governor ` +
        `(D-004 watch list) — refusing until the owner sets a ${family.budgetLabel} (P-001 arming act)`,
    );
  });
});

