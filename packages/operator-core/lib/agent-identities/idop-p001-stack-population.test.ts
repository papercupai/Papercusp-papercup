import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODES } from '../modes/registry';
import { defaultCensusRoot } from './identity-surface-census';
import { enumerateIdopP001Stacks, readIdopP001StackSources, type CensusMode } from './idop-p001-stack-population';

const root = defaultCensusRoot();
const originalCommit = JSON.parse(readFileSync(join(root, 'docs/evidence/idop-p001-baseline-2026-10-22.json'), 'utf8')).base.commit as string;
const original = readIdopP001StackSources(root, originalCommit);
const fleetExclusion = [{ mode: 'goal', postures: ['leader', 'member'] as const,
  source: 'packages/operator-core/lib/agent-tools/fleet_registry/join.ts#goalHolderSubject' }];
const population = enumerateIdopP001Stacks(original.modes, fleetExclusion);
const find = (modes: string[], posture = 'none') => population.find(row =>
  row.fleetPosture === posture && row.modes.join(',') === [...modes].sort().join(','))!;

describe('P001 independent original mode/fleet population', () => {
  it('resolves the original submodule pin rather than substituting the current catalog bytes', () => {
    expect(original.superprojectCommit).toBe(originalCommit);
    expect(original.submoduleCommit).toBe('ae1c7af87b62f2e08eaa599f689c52035b25c379');
    expect(original.sources).toHaveLength(6);
    expect(original.sources.find(source => source.path.endsWith('mode-catalog.generated.ts'))?.sha256)
      .toBe('67c6e567ccadd4b8d6a17556bdd1dfea6d0e77dac8294f80bbbce1e503e59364');
    expect(original.modes.map(mode => mode.id).sort())
      .toEqual(['audit', 'auto', 'cold-auto', 'drain', 'goal', 'grade', 'ideate', 'test']);
  });

  it('retains every axis candidate across all three fleet positions, including unresolved cases', () => {
    expect(population).toHaveLength(576);
    expect(new Set(population.map(row => row.key)).size).toBe(576);
    for (const posture of ['none', 'leader', 'member']) {
      expect(population.filter(row => row.fleetPosture === posture)).toHaveLength(192);
    }
    expect(population.every(row => row.observation === 'UNOBSERVED')).toBe(true);
    expect(find(['audit', 'auto', 'ideate', 'test'], 'member')).toBeDefined();
    expect(find(['cold-auto', 'drain', 'grade'], 'leader')).toBeDefined();
    expect(population.some(row => row.modes.includes('auto') && row.modes.includes('cold-auto'))).toBe(false);
  });

  it('keeps implied-axis debt visible and lets COLD AUTO occupy the autonomy axis', () => {
    expect(find(['drain']).missingImplications).toEqual(['auto']);
    expect(find(['auto', 'goal']).missingImplications).toEqual(['ideate']);
    expect(find(['cold-auto', 'goal', 'ideate']).missingImplications).toEqual([]);
    expect(find(['auto', 'goal', 'ideate']).missingImplications).toEqual([]);
    expect(find(['cold-auto']).layers).toEqual(find(['auto']).layers);
    expect(find(['cold-auto']).key).not.toBe(find(['auto']).key);
  });

  it('retains source-backed execution-fleet refusals and GOAL subject requirements', () => {
    const validGoal = ['auto', 'goal', 'ideate'];
    expect(find(validGoal).refusedBy).toEqual([]);
    expect(find(validGoal).requiredSubjects).toEqual(['goal']);
    expect(find(validGoal, 'leader').refusedBy).toEqual([fleetExclusion[0].source]);
    expect(find(validGoal, 'member').refusedBy).toEqual([fleetExclusion[0].source]);
    expect(find(['auto'], 'member').refusedBy).toEqual([]);
  });

  it('discovers a newly registered orthogonal mode instead of freezing the favorable six samples', () => {
    const extra: CensusMode = { id: 'future-mode', axis: 'overlay', slot: 'future-axis',
      identity: 'su.mode-future', implies: [], requiresSubject: false };
    const expanded = enumerateIdopP001Stacks([...original.modes, extra], fleetExclusion);
    expect(expanded).toHaveLength(1152);
    expect(expanded.filter(row => row.modes.includes('future-mode'))).toHaveLength(576);
    expect(expanded.every(row => row.observation === 'UNOBSERVED')).toBe(true);
  });

  it('fails coverage when the current independent mode registry gains an unaccounted declaration', () => {
    const metadata = (modes: ReadonlyArray<{ id: string; axis: string; implies?: readonly string[]; requiresSubject?: boolean }>) =>
      modes.map(mode => ({ id: mode.id, axis: mode.axis, implies: [...(mode.implies ?? [])],
        requiresSubject: mode.requiresSubject === true })).sort((a, b) => a.id.localeCompare(b.id));
    expect(metadata(MODES)).toEqual(metadata(original.modes));
  });

  it('replays every published state and its restrictions without promoting an unobserved candidate', () => {
    const published = JSON.parse(readFileSync(join(root,
      'docs/evidence/idop-p001-independent-mode-fleet-population-2026-10-25.json'), 'utf8'));
    const expanded = published.modeStates.flatMap((state: {
      key: string; missingImplications: string[]; requiredSubjects: string[];
      postures: Array<{ posture: string; refusedBy: string[] }>;
    }) => state.postures.map(posture => ({
      key: `${state.key}|${posture.posture}`, missingImplications: state.missingImplications,
      requiredSubjects: state.requiredSubjects, refusedBy: posture.refusedBy,
    })));
    expect(expanded).toEqual(population.map(({ key, missingImplications, requiredSubjects, refusedBy }) =>
      ({ key, missingImplications, requiredSubjects, refusedBy })));
    expect(published.controls.fullRowsSha256).toBe(createHash('sha256').update(JSON.stringify(population)).digest('hex'));
    expect(published.source.sources.map(({ path, commit, sha256 }: { path: string; commit: string; sha256: string }) =>
      ({ path, commit, sha256 }))).toEqual(original.sources.map(({ path, commit, sha256 }) => ({ path, commit, sha256 })));
    expect(published.observationDefault).toBe('UNOBSERVED');
    expect(published.controls.authenticatedLaunchObservations).toBe(0);
    expect(published.acceptance).toBe('OPEN');
    expect(published.canonicalAcceptance).toBe(false);
  });

  it('refuses missing implication sources, colliding slots and duplicate population entries', () => {
    expect(() => enumerateIdopP001Stacks([...original.modes, original.modes[0]], fleetExclusion)).toThrow('unique');
    expect(() => enumerateIdopP001Stacks(original.modes.filter(mode => mode.id !== 'ideate'), fleetExclusion)).toThrow('unknown implication');
    expect(() => enumerateIdopP001Stacks(original.modes.map(mode => mode.id === 'test' ? { ...mode, slot: 'audit' } : mode), fleetExclusion)).toThrow('exclusive axes');
    expect(() => enumerateIdopP001Stacks(original.modes, [{ ...fleetExclusion[0], mode: 'unknown' }])).toThrow('exclusion');
    expect(() => readIdopP001StackSources(root, 'HEAD')).toThrow('exact original commit');
  });
});
