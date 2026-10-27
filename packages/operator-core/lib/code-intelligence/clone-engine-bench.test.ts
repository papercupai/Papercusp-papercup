import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { CLONE_ENGINE_IDS, clonePairCorpus, minhashTreeSimilarity, parseJscpd, parseSimilarityTs, rankCloneRuns, runCloneBench,
  type CloneBenchPair, type CloneEngine } from './clone-engine-bench';

const left = 'function alpha(xs: number[]) { let sum = 0; for (const x of xs) { sum += x; } return sum; }';
const right = 'function beta(ys: number[]) { let total = 0; for (const y of ys) { total += y; } return total; }';
const pairs: CloneBenchPair[] = [
  { id: 'renamed', left, right, positive: true, stratum: 'historical-renamed', evidence: 'test-only synthetic renamed control, not historical evidence' },
  { id: 'near', left, right: right.replace('let total', 'if (!ys) { throw new Error("missing"); } let total'), positive: true, stratum: 'authored-near-miss', evidence: 'one inserted guard' },
  { id: 'negative', left, right: 'function render() { return document.createElement("div"); }', positive: false, stratum: 'checked-negative', evidence: 'sum loop versus create DOM element' },
];
const engines = (): CloneEngine[] => CLONE_ENGINE_IDS.map(id => ({ id, version: 'test-1', dependencyCount: id === 'minhash-tree-edit' ? 0 : 1,
  dependencyEvidence: 'test fixture', unavailable: null, compare: async p => p.positive }));

describe('clone engine comparison in the existing fair-comparison harness', () => {
  it('reproduces both retained native rankings and checks every external answer against its raw report', async () => {
    const evidence = JSON.parse(await readFile(new URL('./__fixtures__/clone-engine-bench-20261023.json', import.meta.url), 'utf8'));
    const arms = evidence.preregistration.dependencies.map((e: CloneEngine) => ({ ...e, unavailable: null }));
    expect(evidence.sample).toHaveLength(15);
    expect(evidence.first.registration.hash).toBe(evidence.repeat.registration.hash);
    for (const report of [evidence.first, evidence.repeat]) {
      const replay = rankCloneRuns(report.runs, evidence.sample, arms, report.registration);
      expect(replay).toEqual({ ranking: report.ranking, residue: [], selected: 'minhash-tree-edit' });
    }
    for (const run of evidence.first.runs.filter((r: { capabilities: { armId: string } }) => r.capabilities.armId !== 'minhash-tree-edit')) {
      for (const rep of run.reps) for (const answer of rep.answers) {
        const pair = evidence.sample.find((p: CloneBenchPair) => p.id === answer.caseId);
        const prefix = `${run.capabilities.armId}/${pair.id}/${rep.rep}/`;
        const actual = run.capabilities.armId === 'jscpd'
          ? parseJscpd(JSON.parse(evidence.rawFirstRun[prefix + 'jscpd-report.json']),
            [pair.left.split('\n').length, pair.right.split('\n').length])
          : parseSimilarityTs(evidence.rawFirstRun[prefix + 'stdout.txt']);
        expect(answer.status).toBe('answered');
        expect(answer.sites.length > 0).toBe(actual);
      }
    }
  });
  it('freezes the policy and source bytes before engines run and repeats a stable ranking', async () => {
    const order: string[] = [], arms = engines().map(e => ({ ...e, compare: async (p: CloneBenchPair) => { order.push('query'); return p.positive; } }));
    const first = await runCloneBench(pairs, arms, async r => { expect(r).toHaveProperty('policyHash'); order.push('freeze'); }, async () => {});
    const second = await runCloneBench(pairs, engines(), async () => {}, async () => {});
    expect(order[0]).toBe('freeze');
    expect(first.registration.hash).toBe(second.registration.hash);
    expect(first.ranking.map(r => r.id)).toEqual(second.ranking.map(r => r.id));
    expect(first.selected).toBe('minhash-tree-edit');
    expect(first.ranking.every(r => r.precision === 1 && r.recall === 1)).toBe(true);
    expect(first.residue).toEqual([]);
  });
  it('never selects when a required candidate is unavailable or throws', async () => {
    for (const failed of [{ unavailable: 'binary absent' }, { compare: async () => { throw new Error('broken parser'); } }]) {
      const arms = engines(); arms[0] = { ...arms[0]!, ...failed };
      const result = await runCloneBench(pairs, arms, async () => {}, async () => {});
      expect(result.selected).toBeNull(); expect(result.residue.length).toBeGreaterThan(0);
    }
  });
  it('a failed preregistration write prevents every engine from running', async () => {
    const compare = vi.fn(async () => true);
    await expect(runCloneBench(pairs, engines().map(e => ({ ...e, compare })), async () => { throw new Error('disk'); }, async () => {})).rejects.toThrow('disk');
    expect(compare).not.toHaveBeenCalled();
  });
  it('pins question semantics to source bytes and labels and adjudicates negative hits', () => {
    const a = clonePairCorpus(pairs), b = clonePairCorpus(pairs.map(p => ({ ...p, right: p.right + '\n' })));
    expect(a.cases[0]!.sourceFingerprint).not.toBe(b.cases[0]!.sourceFingerprint);
    expect(a.keys[2]!.rejected).toEqual(['pairs/negative/b.ts:1']);
    expect(() => clonePairCorpus([pairs[0]!, pairs[0]!])).toThrow('duplicate');
  });
  it('measures renamed bodies, inserted statements and unrelated structure deterministically', () => {
    expect(minhashTreeSimilarity(left, right)).toEqual({ candidate: true, similarity: 1 });
    expect(minhashTreeSimilarity(left, pairs[1]!.right)).toEqual(minhashTreeSimilarity(left, pairs[1]!.right));
    const unrelated = minhashTreeSimilarity(left, pairs[2]!.right);
    expect(unrelated.candidate && unrelated.similarity! >= 0.8).toBe(false);
    expect(() => minhashTreeSimilarity('function {', right)).toThrow('syntax');
  });
  it('parses native reports strictly; empty or malformed output is a crash, not no clones', () => {
    expect(parseSimilarityTs('No similar functions found!')).toBe(false);
    expect(parseSimilarityTs('No duplicate functions found!')).toBe(false);
    expect(parseSimilarityTs('Found 1 duplicate pairs:\nSimilarity: 98.32%, Score: 9.8 points\n  /tmp/source/a.ts:1-10 mulberry32\n  /tmp/source/b.ts:1-10 mulberry32')).toBe(true);
    expect(parseSimilarityTs('Found 1 duplicate pairs:\nSimilarity: 98.32%\n  /tmp/source/a.ts:2-10 nested\n  /tmp/source/b.ts:2-10 nested')).toBe(false);
    expect(parseSimilarityTs('Total similar pairs found: 1')).toBe(true);
    expect(() => parseSimilarityTs('')).toThrow('unrecognised');
    expect(parseJscpd({ duplicates: [{ firstFile: { name: '/x/a.ts' }, secondFile: { name: '/x/b.ts' } }] })).toBe(true);
    expect(parseJscpd({ duplicates: [] })).toBe(false);
    expect(parseJscpd({ duplicates: [{ firstFile: { name: 'a.ts' }, secondFile: { name: 'b.ts' } }] })).toBe(true);
    expect(parseJscpd({ duplicates: [{ firstFile: { name: 'a.ts', start: 1, end: 2 }, secondFile: { name: 'b.ts', start: 1, end: 2 } }] }, [20, 20])).toBe(false);
    expect(parseJscpd({ duplicates: [{ firstFile: { name: 'a.ts', start: 1, end: 18 }, secondFile: { name: 'b.ts', start: 1, end: 18 } }] }, [20, 20])).toBe(true);
    expect(() => parseJscpd({})).toThrow('unrecognised');
  });
});
