import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  summarizeInterfaceEligibility,
  SHADOW_WINDOW_BOUNDS, derivationFingerprint, fingerprintEpochs, recordAndReport, scoreShadowWindow, shadowEdgeKey,
  type ShadowRow, type ShadowWindowInput,
} from './coupling-shadow-window';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);

const SRC = `
/** helper */
function cleanId(x: string) { return x.trim(); }
const CAP = 5;
function unrelated() { return 1; }
export function deriveCouplingsFromX(rows: string[]) { return rows.map(cleanId).slice(0, CAP); }
export function notDerivation() { return unrelated(); }
`;

describe('derivationFingerprint (R-12 D-013/D-020)', () => {
  const fp = (src: string) => derivationFingerprint(ts, src);

  it('covers the derive* roots and the same-file helpers they reach, nothing else', () => {
    const r = fp(SRC);
    expect(r.roots).toEqual(['deriveCouplingsFromX']);
    expect(r.covered).toEqual(['CAP', 'cleanId', 'deriveCouplingsFromX']);
  });

  it('changes when one private helper alone changes (restarts the window)', () => {
    expect(fp(SRC.replace('x.trim()', 'x.trim().toLowerCase()')).fingerprint).not.toBe(fp(SRC).fingerprint);
  });

  it('does not change on a comment- or whitespace-only edit', () => {
    const edited = SRC.replace('/** helper */', '// renamed helper doc')
      .replace('{ return x.trim(); }', '{\n    // trim it\n    return   x.trim();\n}');
    expect(fp(edited).fingerprint).toBe(fp(SRC).fingerprint);
  });

  it('does not change when an unreached function changes', () => {
    expect(fp(SRC.replace('return 1;', 'return 2;')).fingerprint).toBe(fp(SRC).fingerprint);
  });

  it('on the real coupling-derivation.ts covers the D-013 helper list', () => {
    const path = fileURLToPath(new URL('../coord/coupling-derivation.ts', import.meta.url));
    const r = fp(readFileSync(path, 'utf8'));
    expect(r.roots).toContain('deriveCouplingsFromCodeDependency');
    for (const helper of ['cleanId', 'fileSet', 'itemList', 'planItemsHeldOn', 'splitPlanItemRef', 'sharedLocksPhrase', 'obligationLiveness']) {
      expect(r.covered).toContain(helper);
    }
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

const agents = ['ag-1', 'ag-2', 'ag-3', 'ag-4'];
function edgeRows(n: number, opts: { reason?: string; mode?: string; start?: number } = {}): ShadowRow[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: (opts.start ?? T0) + i * 1000, kind: 'edge', mode: opts.mode ?? 'shadow',
    a: agents[i % 4] as string, b: agents[(i + 1) % 4] as string, editorOwnerId: agents[i % 4] as string,
    symbol: `sym${i}`, path: `src/f${i}.ts`, reason: opts.reason ?? 'signature of sym changed in src/f.ts; caller x is held by the other agent',
  }));
}
function input(over: Partial<ShadowWindowInput> = {}): ShadowWindowInput {
  return {
    now: T0 + 8 * DAY,
    epochs: [{ fingerprint: 'fp-a', firstTs: T0 }],
    windowRows: edgeRows(30),
    unstampedRows: 0,
    judgments: [],
    breakages: [],
    interfaceLeg: { eligible: 40, eligibleLineages: 4 },
    lineageOf: new Map(agents.map(a => [a, `lin-${a}`])),
    implementerOwners: new Set(['impl-1']),
    implementerLineages: new Set(['lin-impl-1']),
    ...over,
  };
}
const judgeAll = (rows: ShadowRow[], relevant: boolean, judge = 'sampler-x') =>
  rows.map(r => ({ ts: r.ts + 1, edgeKey: shadowEdgeKey(r.a as string, r.b as string, r.path, r.symbol), relevant, judgeOwnerId: judge }));

describe('scoreShadowWindow (R-12)', () => {
  it('is not-open with no stamped rows', () => {
    const s = scoreShadowWindow(input({ epochs: [], windowRows: [], unstampedRows: 12 }));
    expect([s.status, s.verdict, s.unstampedRows]).toEqual(['not-open', 'unknown', 12]);
  });

  it('stays open before 7 days', () => {
    const s = scoreShadowWindow(input({ now: T0 + 3 * DAY }));
    expect([s.status, s.disposition, s.verdict]).toEqual(['open', null, 'unknown']);
  });

  it('stays open past 7 days until 30 edges, up to 28 days', () => {
    expect(scoreShadowWindow(input({ windowRows: edgeRows(10) })).status).toBe('open');
  });

  it('enables only when every bound is met, recall measured from breakages with a prior edge', () => {
    const rows = edgeRows(30);
    const breakages = [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }];
    const s = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, true), breakages }));
    expect([s.status, s.disposition, s.grade, s.verdict]).toEqual(['closed', 'enable', 'healthy', 'pass']);
    expect([s.precision, s.recall, s.sample, s.lineages]).toEqual([1, 1, 30, 4]);
  });

  it('keeps shadow with measured values and a review-by date when precision misses', () => {
    const rows = edgeRows(30);
    const s = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, false),
      breakages: [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }] }));
    expect([s.disposition, s.precision, s.verdict]).toEqual(['keep-shadow', 0, 'pass']);
    expect(s.reviewBy).toBe(T0 + 8 * DAY + SHADOW_WINDOW_BOUNDS.reviewByDays * DAY);
  });

  it('refuses enable and does not pass when recall is unmeasured or has zero breakages', () => {
    const rows = edgeRows(30);
    const none = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, true), breakages: null }));
    expect([none.disposition, none.recallState, none.grade, none.verdict])
      .toEqual(['keep-shadow', 'reader-unavailable', 'unknown', 'unknown']);
    const zero = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, true), breakages: [] }));
    expect([zero.disposition, zero.recallState, zero.grade, zero.verdict])
      .toEqual(['keep-shadow', 'insufficient-data', 'unknown', 'unknown']);
  });

  it('does not pass a keep-shadow close with zero outside-lineage judgments, even with recall measured', () => {
    const s = scoreShadowWindow(input({ windowRows: edgeRows(30), judgments: [],
      breakages: [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }] }));
    expect([s.disposition, s.recallState, s.judged, s.grade, s.verdict])
      .toEqual(['keep-shadow', 'measured', 0, 'unknown', 'unknown']);
    expect(s.reasons.join(' ')).toContain('zero outside-lineage edge judgments');
  });

  it('ignores judgments from the implementer lineage, so they cannot make a close pass', () => {
    const rows = edgeRows(30);
    const s = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, true, 'impl-1'),
      breakages: [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }] }));
    expect([s.judged, s.precision, s.verdict]).toEqual([0, 0, 'unknown']);
  });

  it('keeps shadow when the mean note exceeds 500 characters', () => {
    const rows = edgeRows(30, { reason: 'x'.repeat(501) });
    const s = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, true),
      breakages: [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }] }));
    expect(s.disposition).toBe('keep-shadow');
  });

  it('closes keep-shadow as unknown on the fourth restart', () => {
    const epochs = ['a', 'b', 'c', 'd', 'e'].map((f, i) => ({ fingerprint: f, firstTs: T0 + i }));
    const s = scoreShadowWindow(input({ epochs }));
    expect([s.status, s.disposition, s.grade, s.verdict, s.restarts]).toEqual(['closed', 'keep-shadow', 'unknown', 'unknown', 4]);
    expect(s.fingerprints).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Three restarts is under the cap: a fully measured window still grades on its measures.
    const rows = edgeRows(30);
    const three = scoreShadowWindow(input({ epochs: epochs.slice(0, 4), windowRows: rows, judgments: judgeAll(rows, true),
      breakages: [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }] }));
    expect([three.restarts, three.reasons.some(r => r.includes(`cap ${SHADOW_WINDOW_BOUNDS.restartCap}`))]).toEqual([3, false]);
    expect(three.grade).not.toBe('unknown');
  });

  it('grades broken when the derivation is dead (zero edges over 30 eligible edits)', () => {
    const s = scoreShadowWindow(input({ windowRows: [] }));
    expect([s.grade, s.verdict]).toEqual(['broken', 'fail']);
  });

  it('grades broken when unknown outcomes exceed half the eligible edits', () => {
    const unknown = Array.from({ length: 21 }, (_, i) => ({ ts: T0 + i, kind: 'unknown', mode: 'shadow', editorOwnerId: 'ag-1', symbol: `u${i}`, path: 'src/u.ts' }));
    const s = scoreShadowWindow(input({ windowRows: [...edgeRows(30), ...unknown] }));
    expect([s.grade, s.verdict, s.unknownOutcomes]).toEqual(['broken', 'fail', 21]);
  });

  it('at 28 days with too few edges closes keep-shadow but never passes (insufficient-data only while the derivation is shown alive)', () => {
    const alive = scoreShadowWindow(input({ now: T0 + 29 * DAY, windowRows: edgeRows(10) }));
    expect([alive.disposition, alive.grade, alive.verdict]).toEqual(['keep-shadow', 'insufficient-data', 'unknown']);
    const unshown = scoreShadowWindow(input({ now: T0 + 29 * DAY, windowRows: edgeRows(10), interfaceLeg: null }));
    expect([unshown.grade, unshown.verdict]).toEqual(['unknown', 'unknown']);
  });

  // Reviewer objection thread-post:1208764 (1): the shared liveness reader's shape carries no
  // eligibleLineages, so the D-020 rule was never evaluable live and a closed window passed.
  it('grades a closed window unknown, never enable or a passing keep-shadow, when the interface leg lacks eligibleLineages (live reader shape)', () => {
    const rows = edgeRows(30);
    const breakages = [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }];
    const liveShape = { eligible: 40, eligibleMutations: 40, allTrackedMutations: 90, outputs: 0, outsideLineageOutputs: 0 };
    const wouldEnable = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, true), breakages, interfaceLeg: liveShape }));
    expect([wouldEnable.status, wouldEnable.disposition, wouldEnable.grade, wouldEnable.verdict]).toEqual(['closed', 'keep-shadow', 'unknown', 'unknown']);
    expect(wouldEnable.reasons.join(' ')).toMatch(/D-020 rule not evaluable/);
    const wouldKeep = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, false), breakages, interfaceLeg: liveShape }));
    expect([wouldKeep.grade, wouldKeep.verdict]).toEqual(['unknown', 'unknown']);
    // Over half the eligible edits unknown, with no lineage count: never a pass.
    const unknown = Array.from({ length: 21 }, (_, i) => ({ ts: T0 + i, kind: 'unknown', mode: 'shadow', editorOwnerId: 'ag-1', symbol: `u${i}`, path: 'src/u.ts' }));
    const deadish = scoreShadowWindow(input({ windowRows: [...rows, ...unknown], judgments: judgeAll(rows, false), breakages, interfaceLeg: liveShape }));
    expect(deadish.verdict).not.toBe('pass');
  });

  // Reviewer objection thread-post:1208764 (2): the D-006 real-fleet floors were only
  // enable-refusal reasons, so a keep-shadow close passed without a real-fleet window.
  it('grades a keep-shadow close unknown when the window spans < 3 live agents or < 3 outside lineages', () => {
    const breakages = [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }];
    const twoAgents = edgeRows(30).map(r => ({ ...r, a: 'ag-1', b: 'ag-2', editorOwnerId: 'ag-1' }));
    const s = scoreShadowWindow(input({ windowRows: twoAgents, judgments: judgeAll(twoAgents, true), breakages }));
    expect(s.liveAgents).toBeLessThan(SHADOW_WINDOW_BOUNDS.minLiveAgents);
    expect([s.status, s.disposition, s.grade, s.verdict]).toEqual(['closed', 'keep-shadow', 'unknown', 'unknown']);
    expect(s.reasons.join(' ')).toMatch(/window spans \d live agent/);
    // Four agents but one lineage: the lineage floor alone keeps the close unknown.
    const rows = edgeRows(30);
    const oneLineage = scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, false), breakages,
      lineageOf: new Map(agents.map(a => [a, 'lin-shared'])) }));
    expect(oneLineage.lineages).toBeLessThan(SHADOW_WINDOW_BOUNDS.minLineages);
    expect([oneLineage.grade, oneLineage.verdict]).toEqual(['unknown', 'unknown']);
  });

  it('fails when an edge leaves shadow mode with no enable disposition', () => {
    const s = scoreShadowWindow(input({ windowRows: edgeRows(30, { mode: 'live' }) }));
    expect([s.grade, s.verdict]).toEqual(['broken', 'fail']);
  });

  it('builds fingerprint epochs from the ts-ordered change sequence and skips unstamped rows', () => {
    expect(fingerprintEpochs([{ ts: 5, fingerprint: 'b' }, { ts: 1, fingerprint: 'a' }, { ts: 3, fingerprint: null }, { ts: 2, fingerprint: 'a' }, { ts: 9, fingerprint: 'a' }]))
      .toEqual([{ fingerprint: 'a', firstTs: 1 }, { fingerprint: 'b', firstTs: 5 }, { fingerprint: 'a', firstTs: 9 }]);
  });

  it('restarts the window when the fingerprint changes back to an earlier value (A→B→A), and counts it toward the cap', () => {
    const epochs = fingerprintEpochs([
      { ts: T0, fingerprint: 'a' }, { ts: T0 + DAY, fingerprint: 'b' },
      { ts: T0 + 5 * DAY, fingerprint: 'a' }, { ts: T0 + 6 * DAY, fingerprint: 'a' },
    ]);
    const s = scoreShadowWindow(input({ epochs, now: T0 + 8 * DAY }));
    expect([s.restarts, s.fingerprint, s.windowStart, s.status, s.fingerprints]).toEqual([2, 'a', T0 + 5 * DAY, 'open', ['a', 'b', 'a']]);
    expect(s.days).toBeCloseTo(3);
    // A↔B oscillation is four restarts: the window closes keep-shadow as unknown.
    const flip = fingerprintEpochs(['a', 'b', 'a', 'b', 'a'].map((fingerprint, i) => ({ ts: T0 + i, fingerprint })));
    const capped = scoreShadowWindow(input({ epochs: flip }));
    expect([capped.restarts, capped.status, capped.disposition, capped.grade, capped.verdict]).toEqual([4, 'closed', 'keep-shadow', 'unknown', 'unknown']);
  });

  it('counts unknown outcomes per edit, so repeated unknowns on one symbol push the share over half and grade broken', () => {
    const repeated = Array.from({ length: 21 }, (_, i) => ({ ts: T0 + i, kind: 'unknown', mode: 'shadow', editorOwnerId: 'ag-2', symbol: 'u0', path: 'src/u.ts' }));
    const s = scoreShadowWindow(input({ windowRows: [...edgeRows(30), ...repeated] }));
    expect([s.grade, s.verdict, s.unknownOutcomes]).toEqual(['broken', 'fail', 21]);
  });

  it('counts unknown outcomes only for editors outside the implementer lineages, the same population as the eligible count', () => {
    const lineageOf = new Map([...agents.map(a => [a, `lin-${a}`] as [string, string]), ['impl-2', 'lin-impl-1']]);
    const mk = (editorOwnerId: string | undefined, n: number): ShadowRow[] => Array.from({ length: n }, (_, i) =>
      ({ ts: T0 + i, kind: 'unknown', mode: 'shadow', ...(editorOwnerId ? { editorOwnerId } : {}), symbol: `u${i}`, path: 'src/u.ts' }));
    const s = scoreShadowWindow(input({ lineageOf, windowRows: [...edgeRows(30), ...mk('impl-1', 30), ...mk('impl-2', 30), ...mk(undefined, 30)] }));
    expect(s.unknownOutcomes).toBe(0);
    expect(s.grade).not.toBe('broken');
    // The same 21 unknowns from an outside editor do cross the 0.5 share.
    const outside = scoreShadowWindow(input({ lineageOf, windowRows: [...edgeRows(30), ...mk('impl-1', 30), ...mk('ag-3', 21)] }));
    expect([outside.unknownOutcomes, outside.grade, outside.verdict]).toEqual([21, 'broken', 'fail']);
  });
});

describe('summarizeInterfaceEligibility (R-12 D-020 inputs outside the implementer)', () => {
  const lineageOf = new Map([['ag-1', 'lin-a'], ['ag-2', 'lin-a'], ['ag-3', 'lin-b'], ['impl-1', 'lin-impl'], ['impl-child', 'lin-impl']]);
  const impl = new Set(['impl-1']);
  const implLin = new Set(['lin-impl']);

  it('excludes implementer owners and their lineage, and counts distinct outside lineages', () => {
    const r = summarizeInterfaceEligibility([
      { owner: 'ag-1', eligible: 10, observed: 12 }, { owner: 'ag-2', eligible: 5, observed: 5 },
      { owner: 'ag-3', eligible: 7, observed: 9 }, { owner: 'impl-1', eligible: 50, observed: 50 },
      { owner: 'impl-child', eligible: 40, observed: 40 }, { owner: null, eligible: 30, observed: 30 },
      { owner: 'ag-4', eligible: 0, observed: 3 },
    ], lineageOf, impl, implLin);
    expect(r).toEqual({ eligible: 22, eligibleLineages: 2 });
  });

  it('is unmeasured (null, never zero) when the detector observed no interface row', () => {
    expect(summarizeInterfaceEligibility([], lineageOf, impl, implLin)).toEqual({ eligible: null, eligibleLineages: null });
    expect(summarizeInterfaceEligibility([{ owner: 'ag-1', eligible: 0, observed: 0 }], lineageOf, impl, implLin))
      .toEqual({ eligible: null, eligibleLineages: null });
  });

  it('feeds a dead-derivation verdict only when outside lineages reach the floor', () => {
    const rows = [{ owner: 'ag-1', eligible: 20, observed: 20 }, { owner: 'ag-3', eligible: 20, observed: 20 }, { owner: 'ag-9', eligible: 5, observed: 5 }];
    const leg = summarizeInterfaceEligibility(rows, lineageOf, impl, implLin);
    expect(leg).toEqual({ eligible: 45, eligibleLineages: 3 });
    expect(scoreShadowWindow(input({ windowRows: [], interfaceLeg: leg })).grade).toBe('broken');
  });
});

describe('recordAndReport (R-12 disposition write)', () => {
  const rows = edgeRows(30);
  const enabled = () => scoreShadowWindow(input({ windowRows: rows, judgments: judgeAll(rows, true),
    breakages: [{ ts: T0 + DAY, editorOwnerId: 'ag-1', holderOwnerId: 'ag-2' }] }));

  it('reports the scored verdict once the disposition row is written', async () => {
    const score = enabled();
    let writes = 0;
    const r = await recordAndReport(score, async () => { writes += 1; });
    expect([writes, score.verdict, r.verdict, r.value]).toEqual([1, 'pass', 'pass', 30]);
  });

  it('returns unknown, not the scored pass, when the disposition write fails', async () => {
    const r = await recordAndReport(enabled(), async () => { throw new Error('audit_log insert refused'); });
    expect(r.verdict).toBe('unknown');
    expect(r.detail).toContain('disposition write failed (audit_log insert refused)');
  });
});
