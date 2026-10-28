import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  deriveCrossAgentBreakages, importClosures, readCrossAgentBreakages, resolveTestFiles, subjectsOf,
  type GateRedTransition, type ImportWalkDeps, type LedgerEdit,
} from './cross-agent-breakages';
import { scoreShadowWindow, shadowEdgeKey, type ShadowRow } from './coupling-shadow-window';
import { resolveRelative, runtimeSpecifiers } from '../search/import-graph';

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 10, 1);
const R = '/repo';
const TEST = 'lib/a.test.ts';
const TEST_ABS = `${R}/${TEST}`;
const DEP = `${R}/lib/dep.ts`;
const OTHER = `${R}/lib/other.ts`;

// Green started at T0, red started 2h later, red finished 3h later.
const red: GateRedTransition = { filePath: TEST, greenStartedAt: T0, redStartedAt: T0 + 2 * H, redFinishedAt: T0 + 3 * H };
const closures = new Map([[TEST_ABS, new Set([`${R}/lib/a.ts`, DEP])]]);
const testAbs = new Map([[TEST, TEST_ABS]]);
const derive = (edits: LedgerEdit[], reds = [red]) => deriveCrossAgentBreakages({ reds, edits, testAbs, closures });
const holderEdit: LedgerEdit = { file: `${R}/lib/a.ts`, agentId: 'holder', ts: T0 - H };

describe('deriveCrossAgentBreakages (R-12 recall, D-037)', () => {
  it('catches an editor of a reached file breaking a test whose subject another agent holds', () => {
    const out = derive([holderEdit, { file: DEP, agentId: 'editor', ts: T0 + H }]);
    expect(out).toEqual([{ ts: red.redFinishedAt, editorOwnerId: 'editor', holderOwnerId: 'holder', testFile: TEST, editedFiles: [DEP] }]);
  });

  it('counts a holder by an edit to the test file itself', () => {
    const out = derive([{ file: TEST_ABS, agentId: 'holder', ts: T0 - H }, { file: DEP, agentId: 'editor', ts: T0 + H }]);
    expect(out.map(b => [b.editorOwnerId, b.holderOwnerId])).toEqual([['editor', 'holder']]);
  });

  it('ignores an edit to a file the test does not reach', () => {
    expect(derive([holderEdit, { file: OTHER, agentId: 'editor', ts: T0 + H }])).toEqual([]);
  });

  it('ignores the same agent as editor and holder', () => {
    expect(derive([{ ...holderEdit, agentId: 'one' }, { file: DEP, agentId: 'one', ts: T0 + H }])).toEqual([]);
  });

  it('ignores an editor edit at or before the green start, or after the red start', () => {
    expect(derive([holderEdit, { file: DEP, agentId: 'editor', ts: T0 }])).toEqual([]);
    expect(derive([holderEdit, { file: DEP, agentId: 'editor', ts: T0 + 2 * H + 1 }])).toEqual([]);
  });

  it('ignores edits more than 24h before the red finished (editor and holder)', () => {
    const old: GateRedTransition = { filePath: TEST, greenStartedAt: T0 - 3 * DAY, redStartedAt: T0, redFinishedAt: T0 + H };
    expect(derive([{ ...holderEdit, ts: T0 - 2 * DAY }, { file: DEP, agentId: 'editor', ts: T0 - 1 }], [old])).toEqual([]);
    expect(derive([{ ...holderEdit, ts: T0 - 1 }, { file: DEP, agentId: 'editor', ts: T0 - 2 * DAY }], [old])).toEqual([]);
  });

  it('never counts an edit to the test or its subject as the cause', () => {
    expect(derive([holderEdit, { file: `${R}/lib/a.ts`, agentId: 'editor', ts: T0 + H }])
      .filter(b => b.editorOwnerId === 'editor')).toEqual([]);
  });

  it('skips a red whose file did not resolve', () => {
    expect(deriveCrossAgentBreakages({ reds: [red], edits: [holderEdit, { file: DEP, agentId: 'editor', ts: T0 + H }],
      testAbs: new Map(), closures })).toEqual([]);
  });

  it('feeds the shadow window: recall becomes measured, caught only by a prior editor-holder edge', () => {
    const breakages = derive([holderEdit, { file: DEP, agentId: 'editor', ts: T0 + H }]);
    const edge = (a: string, b: string): ShadowRow => ({ ts: T0, kind: 'edge', mode: 'shadow', a, b, symbol: 's', path: 'lib/dep.ts', reason: 'r' });
    const base = {
      now: T0 + 8 * DAY, epochs: [{ fingerprint: 'fp', firstTs: T0 }], unstampedRows: 0, judgments: [], breakages,
      interfaceLeg: null, lineageOf: new Map<string, string>(), implementerOwners: new Set<string>(), implementerLineages: new Set<string>(),
    };
    const caught = scoreShadowWindow({ ...base, windowRows: [edge('holder', 'editor')] });
    expect([caught.recallState, caught.recall, caught.breakages]).toEqual(['measured', 1, 1]);
    const missed = scoreShadowWindow({ ...base, windowRows: [edge('holder', 'someone-else')] });
    expect([missed.recallState, missed.recall]).toEqual(['measured', 0]);
    expect(shadowEdgeKey('holder', 'editor', 'p', 's')).toBe(shadowEdgeKey('editor', 'holder', 'p', 's'));
  });
});

describe('subjectsOf / resolveTestFiles', () => {
  it('maps test suffixes to the covered source', () => {
    expect(subjectsOf('/r/x.integration.test.ts')).toEqual(['/r/x.ts', '/r/x.tsx']);
    expect(subjectsOf('/r/x.test.tsx')).toEqual(['/r/x.ts', '/r/x.tsx']);
    expect(subjectsOf('/r/x.ts')).toEqual([]);
  });

  it('keeps a red only when exactly one root has its file', () => {
    const reds = [red, { ...red, filePath: 'src/b.test.ts' }, { ...red, filePath: 'gone.test.ts' }];
    const exists = (p: string) => ['/r1/lib/a.test.ts', '/r1/src/b.test.ts', '/r2/src/b.test.ts'].includes(p);
    expect([...resolveTestFiles(reds, ['/r1', '/r2'], exists)]).toEqual([[TEST, '/r1/lib/a.test.ts']]);
  });
});

describe('importClosures', () => {
  const graph: Record<string, string[]> = { '/a': ['./b', './c', '@pkg/x'], '/b': ['./c'], '/c': [], '/d': ['./b'] };
  const reads: string[] = [];
  const deps: ImportWalkDeps = {
    specifiers: (f) => { reads.push(f); if (f === '/c' && graph[f] === undefined) throw new Error('gone'); return graph[f] ?? []; },
    resolve: (_from, s) => `/${s.slice(2)}`,
  };

  it('returns transitive relative closures, memoizing each file across entries', async () => {
    reads.length = 0;
    const r = await importClosures(['/a', '/d'], deps, { yieldEvery: 1 });
    expect(r.closures && [...r.closures].map(([k, v]) => [k, [...v].sort()])).toEqual([['/a', ['/b', '/c']], ['/d', ['/b', '/c']]]);
    expect(reads.filter(f => f === '/b')).toHaveLength(1);
  });

  it('fails closed to null when the file cap would cut a closure', async () => {
    const r = await importClosures(['/a'], deps, { maxFiles: 2 });
    expect(r.closures).toBeNull();
  });

  it('positive control: the real walker finds coupling-shadow-window.ts from its test', async () => {
    const entry = fileURLToPath(new URL('./coupling-shadow-window.test.ts', import.meta.url));
    const target = fileURLToPath(new URL('./coupling-shadow-window.ts', import.meta.url));
    const r = await importClosures([entry], { specifiers: runtimeSpecifiers, resolve: resolveRelative });
    expect(r.closures?.get(entry)?.has(target)).toBe(true);
  });
});

describe('readCrossAgentBreakages (fail-closed reader)', () => {
  const fakeSql = (responses: unknown[][]): Sql => {
    const queue = [...responses];
    return ((..._args: unknown[]) => Promise.resolve(queue.shift() ?? [])) as unknown as Sql;
  };
  const redRow = { file_path: TEST, green_started: String(T0), red_started: String(T0 + 2 * H), red_finished: String(T0 + 3 * H) };
  const walk: ImportWalkDeps = { specifiers: (f) => (f === TEST_ABS ? ['./dep'] : []), resolve: () => DEP };

  it('joins reds, ledger edits and the import walk into breakages', async () => {
    const sql = fakeSql([[redRow], [
      { repo_root: R, file: 'lib/a.ts', agent_id: 'holder', ts: String(T0 - H) },
      { repo_root: R, file: 'lib/dep.ts', agent_id: 'editor', ts: String(T0 + H) },
    ]]);
    const r = await readCrossAgentBreakages(sql, 'ws', T0, T0 + DAY, { walk, exists: p => p === TEST_ABS });
    expect(r.breakages?.map(b => [b.editorOwnerId, b.holderOwnerId, b.testFile])).toEqual([['editor', 'holder', TEST]]);
    expect([r.reds, r.unresolvedReds]).toEqual([1, 0]);
  });

  it('measures an empty window as zero breakages, not unmeasured', async () => {
    const r = await readCrossAgentBreakages(fakeSql([[]]), 'ws', T0, T0 + DAY, { walk });
    expect(r.breakages).toEqual([]);
  });

  it('fails closed on a read error and when a cap would cut the population', async () => {
    const throwing = (() => Promise.reject(new Error('boom'))) as unknown as Sql;
    expect((await readCrossAgentBreakages(throwing, 'ws', T0, T0 + DAY)).breakages).toBeNull();
    const capped = await readCrossAgentBreakages(fakeSql([[redRow]]), 'ws', T0, T0 + DAY, { walk, limits: { maxReds: 1 } });
    expect([capped.breakages, capped.reason]).toEqual([null, 'red transitions reached the 1 cap']);
  });
});
