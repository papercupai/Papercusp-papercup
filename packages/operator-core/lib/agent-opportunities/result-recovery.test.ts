import { expect, it } from 'vitest';
import { groupResultRecovery, observeResultRecovery, rankResultRecovery } from './result-recovery';
import type { SearchSource } from './search-reformulation';

const scope = { workspaceId: 'recovery-test', sourceBoundary: 'authorized', epoch: 'test-1', key: new Uint8Array(32).fill(81) };
type Source = SearchSource & { metadata: unknown };
const source = (id: string, over: Partial<Source> = {}): Source => ({
  workspaceId: scope.workspaceId, harnessSlug: 'recovery', authorizationScope: scope.sourceBoundary,
  provider: 'ledger', namespace: 'operator-dispatch', actor: 'su-recovery', verifiedAgent: true, origin: 'agent',
  at: '2026-10-24T12:00:00Z', copyRef: `copy:${id}`, tool: 'plans:get', args: { slug: 'private-query' },
  callId: id, identityAuthority: 'ledger', sourceComplete: true, metadata: {},
  result: { callId: id, provider: 'ledger', namespace: 'operator-dispatch', status: 'ok', complete: true, body: { ok: true } }, ...over,
});
const observe = (s: Source) => observeResultRecovery(s, scope)!;
const root = (id = 'root', uri = 'papercusp://scratch/private', at = '2026-10-24T12:00:00Z') => source(id, {
  at, metadata: { spillUri: uri, spillPath: '/private/scratch.md', returnedContextBytes: 6000, spilledBytes: 90000 },
});
const read = (id: string, over: Partial<Source> = {}) => source(id, {
  tool: 'capability:read', at: '2026-10-24T12:00:01Z', args: { uri: 'papercusp://scratch/private', byte_offset: 0 },
  metadata: { returnedContextBytes: 100 }, ...over,
});

it('R23-DERIVED-ACL distinguishes deleted output from a readable bounded UNKNOWN result', () => {
  const readable = observe(root());
  const missing = observe({ ...root(), result: null });
  expect(readable).toMatchObject({ outcome: 'UNKNOWN', bounded: true, resultAvailable: true });
  expect(missing).toMatchObject({ outcome: 'UNKNOWN', bounded: true, resultAvailable: false });
  const { resultAvailable: _available, ...before } = readable;
  const { resultAvailable: _missing, ...after } = missing;
  expect(before).toEqual(after);
});

it('R10-CONTRACT OUTCOME-P-010: repeated reads and copy replay are one episode, with actual extra calls and final outcome reference', () => {
  const rows = [root(), read('read1'), read('read2', { at: '2026-10-24T12:00:02Z' })].map(observe);
  const grouped = groupResultRecovery([...rows, { ...rows[1]!, sourceToken: 'different-storage-copy' }]);
  expect(grouped).toMatchObject({ copiesCollapsed: 1, collisions: 0 });
  expect(grouped.episodes).toHaveLength(1);
  expect(grouped.episodes[0]).toMatchObject({ extraCalls: 2, recoveryCalls: { 'spill-read': 2 }, returnedBytes: 6200,
    finalOutcome: 'success', finalOutcomeRef: rows[2]!.operationToken, linkage: 'exact-spill' });
  expect(grouped.episodes[0]!.sourceRefs).toHaveLength(3);
  expect(rankResultRecovery(rows).rankings).toEqual([]); // repetition of reads is not recurring independent opportunity
  const independent = [root('other', 'papercusp://scratch/other', '2026-10-24T12:10:00Z'), read('other-read', {
    at: '2026-10-24T12:10:01Z', args: { uri: 'papercusp://scratch/other' },
  }), source('small', { at: '2026-10-24T12:20:00Z' })].map(observe);
  const ranked = rankResultRecovery([...rows, ...independent]).rankings[0]!;
  expect(ranked).toMatchObject({ exposure: 3, recoveryEpisodes: 2, extraCalls: 3, successEpisodes: 2, burdenPerExposure: 1 });
  expect(ranked.finalOutcomeRefs).toHaveLength(2);
});

it('R10-EXTRA-CALLS: measures projection, paging, spill reads and requery without bytes-only waste claims', () => {
  const partial = (id: string, args: unknown) => source(id, { args,
    at: id === 'projection' ? '2026-10-24T12:00:01Z' : '2026-10-24T12:00:02Z',
    result: { ...source(id).result!, body: { _partial: true } } });
  const rows = [root(), partial('projection', { slug: 'private-query', projection: { pick: ['id'] } }),
    partial('page', { slug: 'private-query', cursor: 'page2' }), read('read', { at: '2026-10-24T12:00:03Z' }),
    root('second', 'papercusp://scratch/second', '2026-10-24T12:10:00Z'),
    source('requery', { at: '2026-10-24T12:10:01Z' })].map(observe);
  const grouped = groupResultRecovery(rows);
  expect(grouped.episodes[0]!.recoveryCalls).toEqual({ projection: 1, paging: 1, 'spill-read': 1, requery: 0 });
  expect(grouped.episodes[1]!.recoveryCalls.requery).toBe(1);
  expect(grouped.evidenceGaps).toContain('request-family-linkage-is-heuristic');
  expect(rankResultRecovery([observe(root())]).rankings).toEqual([]);
  expect(JSON.stringify(grouped)).not.toContain('private-query');
  expect(JSON.stringify(grouped)).not.toContain('/private/');
});

it('R21-SHARED-ID-COLLISION R21-NAMESPACE-PROVIDER-MISMATCH: conflicting copies and wrong result identities cannot manufacture success', () => {
  const a = observe(root()), conflict = observe(root('root', 'papercusp://scratch/different'));
  expect(groupResultRecovery([a, conflict, observe(read('read'))])).toMatchObject({ collisions: 1, episodes: [] });
  for (const result of [{ ...read('read').result!, provider: 'codex' as const },
    { ...read('read').result!, namespace: 'other' }, { ...read('read').result!, callId: 'wrong' }]) {
    expect(groupResultRecovery([a, observe(read('read', { result }))]).episodes[0]!.finalOutcome).toBe('UNKNOWN');
  }
  const other = read('read', { provider: 'codex', result: { ...read('read').result!, provider: 'codex' } });
  expect(groupResultRecovery([a, observe(other)]).episodes[0]!.extraCalls).toBe(0);
});

it('R21-INTERLEAVED-SAME-ACTOR R21-EXACT-ID-CONTROL: exact spill links beat nearby unrelated operations; actor and authorization lanes stay isolated', () => {
  const roots = [observe(root()), observe(root('root2', 'papercusp://scratch/second'))];
  // Same-time requests share a request family; the exact address still names one parent.
  const grouped = groupResultRecovery([...roots, observe(read('read')), observe(source('nearby', { args: { slug: 'unrelated' } }))]);
  expect(grouped.episodes.find(e => e.rootOperation === roots[0]!.operationToken)!.extraCalls).toBe(1);
  expect(grouped.episodes.find(e => e.rootOperation === roots[1]!.operationToken)!.extraCalls).toBe(0);
  expect(groupResultRecovery([roots[0]!, observe(read('other-actor', { actor: 'su-other' }))]).episodes[0]!.extraCalls).toBe(0);
  const boundary = { ...scope, sourceBoundary: 'other-boundary' };
  const isolated = observeResultRecovery(read('read', { authorizationScope: boundary.sourceBoundary }), boundary)!;
  expect(groupResultRecovery([roots[0]!, isolated]).episodes).toHaveLength(1);
  expect(groupResultRecovery([roots[0]!, isolated]).episodes[0]!.extraCalls).toBe(0);
});

it('R10-GAPS: missing, partial, refused and failed output stays explicit; non-agent sources are excluded', () => {
  const start = observe(root());
  for (const over of [{ result: null }, { result: { ...read('r').result!, callId: 'r', complete: false } },
    { result: { ...read('r').result!, callId: 'r', body: { eof: false, next_cursor: { offset: 12 } } } }]) {
    const grouped = groupResultRecovery([start, observe(read('r', over))]);
    expect(grouped.episodes[0]).toMatchObject({ finalOutcome: 'UNKNOWN', finalOutcomeRef: null });
    expect(grouped.evidenceGaps).toContain('unmeasured-final-outcome');
  }
  for (const status of ['error', 'quota-exceeded']) {
    const row = observe(read('r', { result: { ...read('r').result!, status } }));
    expect(groupResultRecovery([start, row]).episodes[0]!.finalOutcome).toBe(status === 'error' ? 'error' : 'refused');
  }
  expect(observeResultRecovery(source('poll', { origin: 'polling' }), scope)).toBeNull();
  expect(observeResultRecovery(source('truncated', { sourceComplete: false }), scope)).toBeNull();
  expect(() => observeResultRecovery(source('wrong', { authorizationScope: 'wrong' }), scope)).toThrow('invalid_recovery_scope');
});
