/**
 * foldGoalPackageBoard unit coverage (work-on-everything-goal-2026-08-23 P-009).
 *
 * A pure fold, no DB — which is the whole reason it lives beside the goals
 * domain instead of inside the sync resolver. The rail's contract is decided
 * here: which entry offers one-click Start (no non-stub instance), which
 * instance owns the readout (`activeGoalId`), and what happens to rows whose
 * package was uninstalled from disk.
 */
import { describe, expect, it } from 'vitest';
import type { LocalGoalPackage } from '../cupboard/goal-package-store';
import {
  FEATURED_GOAL_PACKAGE_REF,
  foldGoalPackageBoard,
  type GoalPackageInstanceRow,
} from './package-board';

function pkg(over: Partial<LocalGoalPackage> & { ref: string }): LocalGoalPackage {
  return {
    title: over.ref,
    body: null,
    standing: false,
    killCriterion: null,
    tripwires: null,
    budgetCents: null,
    budgetWindowSec: null,
    launchSettings: null,
    inputSchema: null,
    outputSchema: null,
    propertySchema: null,
    description: '',
    requiresRubrics: [],
    version: '1.0.0',
    source: 'installed',
    dir: `/goal-packages/${over.ref}`,
    layer: 'user',
    ...over,
  };
}

const row = (
  id: string,
  status: string,
  metadata: Record<string, unknown> | null,
): GoalPackageInstanceRow => ({ id, status, metadata });

describe('foldGoalPackageBoard', () => {
  it('gives a catalog-only package an entry with no instances and no readout target', () => {
    const [entry] = foldGoalPackageBoard([pkg({ ref: 'solo' })], []);
    expect(entry?.ref).toBe('solo');
    expect(entry?.instances).toEqual([]);
    // Null target IS the one-click-start case the rail keys off.
    expect(entry?.activeGoalId).toBeNull();
  });

  it('marks the seeded install stub adoptable and does NOT offer it as the readout target', () => {
    const [entry] = foldGoalPackageBoard(
      [pkg({ ref: 'woe' })],
      [row('G-1', 'paused', { goalPackageRef: 'woe' })],
    );
    expect(entry?.instances).toEqual([{ goalId: 'G-1', status: 'paused', adoptableStub: true }]);
    // "Installed, never started" still shows Start — a stub owns no readout.
    expect(entry?.activeGoalId).toBeNull();
  });

  it('CONTROL: the same paused row WITH an agent identity is no stub (the discriminator is agentOwnerId, not status alone)', () => {
    const [entry] = foldGoalPackageBoard(
      [pkg({ ref: 'woe' })],
      [row('G-1', 'paused', { goalPackageRef: 'woe', agentOwnerId: 'su-1' })],
    );
    expect(entry?.instances[0]?.adoptableStub).toBe(false);
    // A paused LIVE instance still owns the pause readout.
    expect(entry?.activeGoalId).toBe('G-1');
  });

  it('prefers the ACTIVE non-stub as the readout target over an earlier paused one', () => {
    const [entry] = foldGoalPackageBoard(
      [pkg({ ref: 'woe' })],
      [
        row('G-1', 'paused', { goalPackageRef: 'woe', agentOwnerId: 'su-1' }),
        row('G-2', 'active', { goalPackageRef: 'woe', agentOwnerId: 'su-2' }),
        row('G-0', 'paused', { goalPackageRef: 'woe' }), // the stub rides along
      ],
    );
    expect(entry?.activeGoalId).toBe('G-2');
    // Stubs included: the rail distinguishes "installed, never started" from
    // "no instance at all" by SEEING them.
    expect(entry?.instances).toHaveLength(3);
  });

  it('drops rows whose ref resolves to no catalog entry (uninstalled package) without inventing an entry', () => {
    const entries = foldGoalPackageBoard(
      [pkg({ ref: 'kept' })],
      [
        row('G-9', 'active', { goalPackageRef: 'ghost', agentOwnerId: 'su-9' }),
        row('G-1', 'active', { goalPackageRef: 'kept', agentOwnerId: 'su-1' }),
      ],
    );
    expect(entries.map((e) => e.ref)).toEqual(['kept']);
    expect(entries[0]?.instances.map((i) => i.goalId)).toEqual(['G-1']);
  });

  it('prefers a paused held instance over earlier terminal history', () => {
    const [entry] = foldGoalPackageBoard([pkg({ ref: 'woe' })], [
      row('G-old', 'killed', { goalPackageRef: 'woe' }),
      row('G-new', 'paused', { goalPackageRef: 'woe', agentOwnerId: 'su-test' }),
    ]);
    expect(entry?.activeGoalId).toBe('G-new');
  });

  it('opens a paused unstarted replacement when the only other instances are terminal', () => {
    const [entry] = foldGoalPackageBoard([pkg({ ref: 'woe' })], [
      row('G-old', 'killed', { goalPackageRef: 'woe' }),
      row('G-done', 'achieved', { goalPackageRef: 'woe' }),
      row('G-new', 'paused', { goalPackageRef: 'woe' }),
    ]);
    expect(entry?.activeGoalId).toBe('G-new');
    expect(entry?.instances.find((i) => i.goalId === 'G-new')?.adoptableStub).toBe(true);
    expect(entry?.instances.map((i) => i.status)).toEqual(['killed', 'achieved', 'paused']);
  });

  it('keeps the active instance ahead of paused replacements and preserves terminal-only history', () => {
    const packages = [pkg({ ref: 'woe' })];
    const history = [row('G-old', 'killed', { goalPackageRef: 'woe' })];
    expect(foldGoalPackageBoard(packages, history)[0]?.activeGoalId).toBe('G-old');
    const [entry] = foldGoalPackageBoard(packages, [
      ...history, row('G-new', 'paused', { goalPackageRef: 'woe' }),
      row('G-active', 'active', { goalPackageRef: 'woe', agentOwnerId: 'su-test' }),
    ]);
    expect(entry?.activeGoalId).toBe('G-active');
  });

  it('ignores rows with no usable goalPackageRef stamp', () => {
    const [entry] = foldGoalPackageBoard(
      [pkg({ ref: 'woe' })],
      [row('G-1', 'active', null), row('G-2', 'active', { goalPackageRef: '   ' })],
    );
    expect(entry?.instances).toEqual([]);
  });

  it('sorts featured → bundled-before-user → title', () => {
    const entries = foldGoalPackageBoard(
      [
        pkg({ ref: 'zeta', title: 'Zeta', layer: 'user' }),
        pkg({ ref: 'alpha', title: 'Alpha', layer: 'user' }),
        pkg({ ref: 'beta', title: 'Beta', layer: 'bundled' }),
        pkg({ ref: FEATURED_GOAL_PACKAGE_REF, title: 'Work on everything', layer: 'bundled' }),
      ],
      [],
    );
    expect(entries.map((e) => e.ref)).toEqual([
      FEATURED_GOAL_PACKAGE_REF,
      'beta',
      'alpha',
      'zeta',
    ]);
    expect(entries[0]?.featured).toBe(true);
    expect(entries[1]?.featured).toBe(false);
  });

  it('carries the budget + its DECLARED window through untouched (the label denominator the rail must not swap)', () => {
    const [entry] = foldGoalPackageBoard(
      [pkg({ ref: 'woe', budgetCents: 10_000, budgetWindowSec: 604_800, standing: true })],
      [],
    );
    expect(entry?.budgetCents).toBe(10_000);
    expect(entry?.budgetWindowSec).toBe(604_800);
    expect(entry?.standing).toBe(true);
  });
});
