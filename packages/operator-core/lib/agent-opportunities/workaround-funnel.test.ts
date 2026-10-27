import { expect, it } from 'vitest';
import { groupWorkarounds, observeWorkaround, rankWorkarounds } from './workaround-funnel';
import type { RecoverySource } from './result-recovery';

const scope = { workspaceId: 'workaround-unit', sourceBoundary: 'authorized', epoch: 'v1',
  key: new Uint8Array(32).fill(87), knownSecrets: ['fixture-secret'] };
const source = (id: string, over: Partial<RecoverySource> = {}): RecoverySource => ({
  workspaceId: scope.workspaceId, harnessSlug: 'funnel', authorizationScope: scope.sourceBoundary,
  provider: 'ledger', namespace: 'operator-dispatch', actor: 'su-funnel', verifiedAgent: true, origin: 'agent',
  at: '2026-10-24T12:00:00Z', copyRef: `copy:${id}`, tool: 'plans:get', args: { slug: 'private-target', old: true },
  callId: id, identityAuthority: 'ledger', sourceComplete: true, metadata: {}, durationMs: 12,
  result: { callId: id, provider: 'ledger', namespace: 'operator-dispatch', status: 'ok', complete: true, body: { ok: true } }, ...over,
});
const error = (id: string, message: string, at = '2026-10-24T12:00:00Z') => source(id, { at,
  result: { ...source(id).result!, status: 'error', body: { ok: false, error: message, servingBuild: 'abcdef123' } } });
const success = (id: string, at = '2026-10-24T12:00:02Z') => source(id, { at, args: { slug: 'private-target', corrected: true },
  result: { ...source(id).result!, body: { ok: true, servingBuild: 'fedcba456' } } });
const observe = (s: RecoverySource) => observeWorkaround(s, scope)!;

it('R11-CONTRACT', () => {
  for (const [message, repair] of [['invalid_args: Unrecognized key old', 'parameter'], ['column x does not exist', 'schema'],
    ['stale_tool_contract', 'build'], ['tool_not_found', 'availability']] as const) {
    const rows = [error('a', message), success('b'), error('c', message, '2026-10-24T12:10:00Z'), success('d', '2026-10-24T12:10:03Z')].map(observe);
    const ranked = rankWorkarounds(rows).rankings[0]!;
    expect(ranked).toMatchObject({ repair, successfulEpisodes: 2, extraCalls: 2, elapsedMs: 5000, confidence: 'observed-sequence' });
    expect(ranked.finalOutcomeRefs).toEqual([rows[1]!.operationToken, rows[3]!.operationToken]);
    expect(ranked.episodes[0]).toMatchObject({ callTimeMs: 24, changes: { parameters: true, build: true } });
    expect(ranked.recommendation).toContain(repair === 'build' ? 'serving-build' : repair === 'availability' ? 'availability' : repair === 'schema' ? 'schema' : 'parameter');
    expect(ranked.causalClaim).toContain('unproven');
    const lookup = source('lookup', { tool: 'docs:search', args: { query: 'private-target schema' }, at: '2026-10-24T12:00:01Z' });
    const manual = source('manual', { tool: 'capability:bash', args: { command: 'rg private-target source.ts' }, at: '2026-10-24T12:00:02Z',
      result: { ...source('manual').result!, body: { exit_code: 0, output: 'found' } } });
    const sequence = groupWorkarounds([observe(error('start', message)), observe(lookup), observe(manual)]).episodes[0]!;
    expect(sequence).toMatchObject({ extraCalls: 2, evidence: 'observed-sequence',
      changes: { schemaLookup: true, manualReconstruction: true } });
    expect(sequence.finalOutcomeRef).toBe(observe(manual).operationToken);
  }
  expect(rankWorkarounds([source('explore1'), success('explore2')].map(observe)).rankings).toEqual([]);
  expect(rankWorkarounds([error('failed', 'invalid_args')].map(observe)).rankings).toEqual([]);
});

it('OUTCOME-P-011', () => {
  const root = observe(error('root', 'invalid_args'));
  const end = success('end');
  for (const result of [null, { ...end.result!, complete: false }, { ...end.result!, callId: 'different' },
    { ...end.result!, provider: 'codex' as const }, { ...end.result!, namespace: 'other' },
    { ...end.result!, body: { _partial: true } }, { ...end.result!, status: 'error', body: { ok: false } },
    { ...end.result!, body: { state: 'error', error: { code: 'invalid_input' } } },
    { ...end.result!, body: { isError: true, content: [{ type: 'text', text: '{"ok":true}' }] } }]) {
    const grouped = groupWorkarounds([root, observe({ ...end, result })]);
    expect(grouped.episodes[0]).toMatchObject({ evidence: 'incomplete', finalOutcomeRef: null, extraCalls: 1 });
    expect(grouped.evidenceGaps).toContain('incomplete-final-outcome');
    expect(rankWorkarounds([root, observe({ ...end, result })]).rankings).toEqual([]);
  }
  const lookup = source('lookup', { tool: 'tools:find', args: { query: 'private-target' }, at: end.at });
  expect(groupWorkarounds([root, observe(lookup)]).episodes[0]!.finalOutcomeRef).toBeNull();
  const noIdentity = observe({ ...end, identityAuthority: 'unknown' });
  expect(groupWorkarounds([root, noIdentity]).episodes[0]!.finalOutcomeRef).toBeNull();
  const incomplete = [{ _partial: true }, { truncated: true }, { _projection: { truncated: true } },
    { eof: false }, { next_cursor: 'remaining' }];
  for (const body of [{ ok: true }, { exit_code: 1 }, { exit_code: 0, running: true }, { exit_code: 0, yielded: true },
    ...incomplete.flatMap(flags => [{ exit_code: 0, ...flags }, { structuredContent: { exit_code: 0, ...flags } }])]) {
    const shell = observe(source('shell', { at: end.at, tool: 'capability:bash', args: { command: 'rg private-target source.ts' },
      result: { ...source('shell').result!, body } }));
    expect(groupWorkarounds([root, shell]).episodes[0]!.finalOutcomeRef).toBeNull();
  }
});

it('R21-SHARED-ID-COLLISION R21-NAMESPACE-PROVIDER-MISMATCH', () => {
  const root = observe(error('root', 'invalid_args')), end = observe(success('end'));
  expect(groupWorkarounds([root, end, { ...end, sourceToken: 'storage-copy' }])).toMatchObject({ copiesCollapsed: 1, collisions: 0 });
  expect(groupWorkarounds([root, { ...root, repair: 'build' }, end])).toMatchObject({ collisions: 1, episodes: [] });
  for (const over of [{ provider: 'codex' as const }, { namespace: 'other' }, { actor: 'su-other' }]) {
    expect(groupWorkarounds([root, observe({ ...success('end'), ...over })]).episodes[0]!.finalOutcomeRef).toBeNull();
  }
});

it('R21-INTERLEAVED-SAME-ACTOR R21-EXACT-ID-CONTROL', () => {
  const root = observe(error('root', 'invalid_args'));
  const unrelated = observe(source('other', { args: { slug: 'unrelated' }, at: '2026-10-24T12:00:01Z' }));
  expect(groupWorkarounds([root, unrelated, observe(success('end'))]).episodes[0]!.extraCalls).toBe(1);
  const other = observe({ ...error('second', 'invalid_args', '2026-10-24T12:00:01Z'), args: { slug: 'second-target' } });
  const ambiguous = observe(source('ambiguous', { args: { query: 'private-target second-target' }, tool: 'docs:search', at: '2026-10-24T12:00:02Z' }));
  expect(groupWorkarounds([root, other, ambiguous]).evidenceGaps).toContain('ambiguous-workaround-parent');
  expect(groupWorkarounds([root, observe(success('late', '2026-10-24T12:10:00Z'))]).episodes[0]!.extraCalls).toBe(0);
});

it('Workaround privacy and eligibility exclude secrets and non-agent sources', () => {
  const a = source('secret', { args: { slug: 'private-target', api_key: 'fixture-secret' } });
  const b = source('secret', { args: { slug: 'private-target', api_key: 'other-fixture' } });
  expect(observe(a).requestToken).toBe(observe(b).requestToken);
  expect(observe(a).contextTokens).toEqual(observe(b).contextTokens);
  expect(JSON.stringify(observe(a))).not.toContain('fixture-secret');
  expect(JSON.stringify(observe(a))).not.toContain('private-target');
  expect(observeWorkaround(source('poll', { origin: 'polling' }), scope)).toBeNull();
  expect(observeWorkaround(source('partial', { sourceComplete: false }), scope)).toBeNull();
  expect(() => observeWorkaround(source('wrong', { authorizationScope: 'other' }), scope)).toThrow('invalid_recovery_scope');
  expect(() => groupWorkarounds([], 0)).toThrow('invalid_workaround_gap');
});
