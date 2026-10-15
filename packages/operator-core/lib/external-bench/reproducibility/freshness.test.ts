/**
 * BM-P-006-drift-freshness (current-benchmark-modernization-2026-10-09 P-006): meaningful protocol drift
 * invalidates a result's freshness. Each protocol identity input is changed independently; a stored result
 * must stop being comparable current evidence and name the drifted input.
 */
import { describe, expect, it } from 'vitest';
import { currentProtocolFixture } from './_protocol-test-fixture';
import { classifyPreregisteredFreshness, classifyProtocolFreshness } from './freshness';
import { currentProtocolFromConfig, type CurrentBenchmarkProtocol } from './schema';

const stored = () => currentProtocolFixture('stored-run');
const study = () => currentProtocolFixture('current-study');
const arm = (p: CurrentBenchmarkProtocol, id: string) => p.arms.find((a) => a.id === id)!;

describe('frozen protocol evidence freshness', () => {
  it('keeps a result frozen under the same protocol (another run id, reordered keys) as comparable current evidence', () => {
    const reordered = Object.fromEntries(Object.entries(study()).reverse()) as unknown as CurrentBenchmarkProtocol;
    reordered.arms = [...reordered.arms].reverse().map((a) => Object.fromEntries(Object.entries(a).reverse()) as typeof a);
    expect(classifyProtocolFreshness(stored(), study())).toEqual({ status: 'current', comparable: true, driftFields: [] });
    expect(classifyProtocolFreshness(stored(), reordered)).toEqual({ status: 'current', comparable: true, driftFields: [] });
  });

  it.each<[string, (p: CurrentBenchmarkProtocol) => void, string]>([
    ['model', (p) => { arm(p, 'papercusp').model = 'another-model'; }, 'arms[papercusp].model'],
    ['effort', (p) => { arm(p, 'baseline').effort = 'low'; }, 'arms[baseline].effort'],
    ['prompt', (p) => { arm(p, 'papercusp').runtime.promptHash = 'e'.repeat(64); }, 'arms[papercusp].runtime.promptHash'],
    ['tools', (p) => { arm(p, 'papercusp').runtime.toolsHash = 'f'.repeat(64); }, 'arms[papercusp].runtime.toolsHash'],
    ['runtime revision', (p) => { arm(p, 'baseline').runtime.runtimeRevision = 'fixture-runtime-2'; }, 'arms[baseline].runtime.runtimeRevision'],
    ['grader', (p) => { p.grader = { ...p.grader, version: 'grader-v2' }; }, 'grader'],
    ['task set', (p) => { p.taskIds = ['t1', 't2']; }, 'taskIds'],
    ['seeds', (p) => { p.seeds = [1, 2]; }, 'seeds'],
    ['initial context', (p) => { p.context = { ...p.context, memoryHash: '9'.repeat(64) }; }, 'context'],
    ['exclusions', (p) => { p.exclusions = ['t1']; }, 'exclusions'],
    ['stopping rule', (p) => { p.stopping = { ...p.stopping, maxAttemptsPerAssignment: 2 }; }, 'stopping'],
    ['arm roster', (p) => { p.arms = [...p.arms, { ...arm(p, 'baseline'), id: 'third' }]; }, 'arms.roster'],
  ])('classifies a changed %s as stale, not comparable current evidence', (_label, change, field) => {
    const current = study();
    change(current);
    const verdict = classifyProtocolFreshness(stored(), current);
    expect(verdict.status).toBe('stale');
    expect(verdict.comparable).toBe(false);
    expect(verdict.driftFields).toEqual([field]);
  });

  it('reports every drifted input together, sorted', () => {
    const current = study();
    arm(current, 'papercusp').model = 'another-model';
    current.grader = { ...current.grader, version: 'grader-v2' };
    current.taskIds = ['t2'];
    expect(classifyProtocolFreshness(stored(), current).driftFields).toEqual(['arms[papercusp].model', 'grader', 'taskIds']);
  });

  it('never treats a result without a current frozen protocol as comparable', () => {
    const frozen = JSON.parse(JSON.stringify(study())) as Record<string, unknown>;
    expect(currentProtocolFromConfig(frozen)).not.toBeNull();
    expect(classifyPreregisteredFreshness(JSON.parse(JSON.stringify(stored())), frozen)).toMatchObject({ status: 'current', comparable: true });
    for (const legacy of [{ tasks: ['t1'], seeds: [1], grader: 'pinned-v1' }, null, 'config']) {
      expect(classifyPreregisteredFreshness(legacy, frozen)).toMatchObject({ status: 'unknown', comparable: false });
      expect(classifyPreregisteredFreshness(frozen, legacy)).toMatchObject({ status: 'unknown', comparable: false });
    }
  });
});
