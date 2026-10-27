import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cloneBriefProvider } from './clone-brief-provider';
import { authoringReuse } from './reuse-authoring';
import type { ReuseIssuedRecord } from './reuse-brief-ledger';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { cloneAdvisoryFixture } from './__fixtures__/clone-advisory-fixture';
import * as pushSnapshots from './push-snapshot';
import { briefCodePoints, composeReuseBrief, registerReuseBriefProvider,
  type ReuseBriefProvider, type ReuseContribution, type ReuseProviderContext, type ReuseProviderId } from './reuse-brief-providers';

const context: ReuseProviderContext = { surface: 'claim', workspaceId: 'fixture-workspace', owner: 'su-fixture',
  invocation: 'actual-claim-dispatch', workItem: 'WI-target', paths: ['target.ts'], sourceVersion: 'blob-v1' };
interface Brief { mandatory: string; impact?: ReuseContribution[]; coChange?: ReuseContribution[];
  whatChangedSincePlanning?: ReuseContribution[]; tests?: ReuseContribution[] }
const append = (base: Brief, value: ReuseContribution): Brief => ({ ...base, [value.section]: [...(base[value.section] ?? []), value] });
const provider = (id: ReuseProviderId, lines = [`${id}: target.ts:2; source scope is partial`]): ReuseBriefProvider => ({ id,
  read: async () => ({ status: 'measured', lines, sourceVersion: 'blob-v1', indexVersion: 'index-v2', citedPaths: ['target.ts'] }) });
const compose = (base: Brief, providers: ReuseBriefProvider[], now = Date.now, deadline = now() + 6_000) =>
  composeReuseBrief({ base, providers, context, append, now, deadline });

describe('R16 actual composition admission', () => {
  it('withholds a fixed eligible provider arm across retries, retaining its own selector and source pins', async () => {
    const read = vi.fn(provider('coverage').read);
    for (const invocation of ['first', 'retry']) {
      const base: Brief = { mandatory: 'preserved' };
      const result = await composeReuseBrief({ base, context: { ...context, invocation, workItem: 'WI-12' }, append,
        providers: [{ id: 'coverage', read }, provider('clones')], enabled: async () => true, deadline: Date.now() + 6000 });
      expect(result.brief.mandatory).toBe('preserved');
      expect(result.brief.tests).toBeUndefined();
      expect(result.brief.impact?.[0]?.provider).toBe('clones');
      expect(result.observations.find(row => row.provider === 'coverage')).toMatchObject({
        status: 'held-out', reason: 'holdout', cohort: 'holdout', chars: 0,
        citedPaths: ['target.ts'], sourceVersion: 'blob-v1', indexVersion: 'index-v2' });
    }
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(['clones', 'cochange', 'provenance', 'sql', 'coverage', 'semantic'] as const)(
    'withdraws and restores %s independently through its maintained flag', async id => {
      const { REUSE_PROVIDER_FLAGS } = await import('./reuse-brief-providers');
      const { setFlagOverridesForTest } = await import('@papercusp/flags/test');
      const read = vi.fn(provider(id).read);
      const run = () => composeReuseBrief({ base: { mandatory: 'base' }, context, append,
        providers: [{ id, read }], deadline: Date.now() + 6000 });
      try {
        setFlagOverridesForTest({ [REUSE_PROVIDER_FLAGS[id]]: false });
        const disabled = await run();
        expect(disabled.brief).toEqual({ mandatory: 'base' });
        expect(disabled.observations[0]).toMatchObject({ status: 'disabled', reason: 'disabled', chars: 0 });
        expect(read).not.toHaveBeenCalled();
        setFlagOverridesForTest({ [REUSE_PROVIDER_FLAGS[id]]: true });
        expect((await run()).observations[0]).toMatchObject({ status: 'issued', cohort: 'treatment' });
      } finally { setFlagOverridesForTest(null); }
    });
  it('does not make authoring without a work item an experimental arm', async () => {
    const result = await composeReuseBrief({ base: { mandatory: 'base' }, context: { ...context, workItem: undefined },
      append, providers: [provider('coverage')], enabled: async () => true, deadline: Date.now() + 6000 });
    expect(result.observations[0]).toMatchObject({ status: 'issued' });
    expect(result.observations[0]?.cohort).toBeUndefined();
  });
});

// The shared producer fixture lowers minMass for its own focused cases. Delivery
// re-parses at the production floor; use substantial bodies rather than weaken it.
const deliveryFixture = () => {
  const fixture = cloneAdvisoryFixture();
  for (const path of ['a.ts', 'b.ts'] as const) fixture.sources[path] = fixture.sources[path]
    .replace('return total;', `${'total += values.length; '.repeat(20)}return total;`);
  return fixture;
};

describe('P010 source-checked clone delivery', () => {
  it('issues unchanged sibling locations on each surface, preserving base, cap and independent identities', async () => {
    const fixture = deliveryFixture(), root = await mkdtemp(join(tmpdir(), 'clone-provider-'));
    try {
      for (const [path, source] of Object.entries(fixture.sources)) await writeFile(join(root, path), source);
      const sha256 = createHash('sha256').update(fixture.sources['b.ts']).digest('hex');
      const sourceFiles = [{ path: 'b.ts', sha256 }];
      const sourceVersion = createHash('sha256').update(JSON.stringify(sourceFiles.map(f => [f.path, f.sha256]))).digest('hex');
      for (const surface of ['claim', 'authoring', 'completion'] as const) {
        const result = await composeReuseBrief({ base: { mandatory: 'unchanged' }, append,
          context: { ...context, surface, paths: ['b.ts'], sourceFiles, sourceVersion,
            repository: { workspaceId: context.workspaceId, rootPath: root } },
          deadline: Date.now() + 6000, providers: [cloneBriefProvider({ snapshot: () => fixture.snapshot })] });
        expect(result.brief.mandatory).toBe('unchanged');
        expect(result.brief.impact?.[0]?.text).toContain(surface === 'completion' ? 'Untouched sibling a.ts:1 original' : 'Copy family a.ts:1 original');
        expect(result.observations[0]).toMatchObject({ provider: 'clones', status: 'issued', sourceVersion });
        expect(result.observations[0]!.chars).toBeLessThanOrEqual(600);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('detects a new copy against actual historical bytes, and a nonmatch emits no warning', async () => {
    const fixture = deliveryFixture(), root = await mkdtemp(join(tmpdir(), 'clone-provider-history-'));
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', root, ...args])).stdout.trim();
    try {
      for (const [path, source] of Object.entries(fixture.sources)) await writeFile(join(root, path), source);
      await git('init', '-q'); await git('config', 'user.name', 'fixture'); await git('config', 'user.email', 'fixture@example.invalid');
      await git('add', '.'); await git('commit', '-qm', 'baseline');
      const baseline = await git('rev-parse', 'HEAD');
      const planted = `${fixture.sources['b.ts']}\n${fixture.sources['b.ts'].replace('copy', 'planted')}`;
      await writeFile(join(root, 'b.ts'), planted);
      const sourceFiles = [{ path: 'b.ts', sha256: createHash('sha256').update(planted).digest('hex') }];
      const sourceVersion = createHash('sha256').update(JSON.stringify(sourceFiles.map(f => [f.path, f.sha256]))).digest('hex');
      const ctx = { ...context, surface: 'completion' as const, paths: ['b.ts'], sourceFiles, sourceVersion,
        repository: { workspaceId: context.workspaceId, rootPath: root } };
      const provider = cloneBriefProvider({ snapshot: () => ({ ...fixture.snapshot, commit: baseline }) });
      const result = await provider.read(ctx, new AbortController().signal);
      expect(result.lines).toContainEqual(expect.stringContaining('New copy b.ts:2 planted since'));
      expect(result.lines).toContainEqual(expect.stringContaining('Untouched sibling a.ts:1 original'));
      // A registered disposable repository has no prepared inventory yet. Its
      // own captured files + real HEAD must still establish a new scoped copy.
      const scopedFiles = [...sourceFiles, { path: 'a.ts', sha256: createHash('sha256').update(fixture.sources['a.ts']).digest('hex') }];
      const scoped = await cloneBriefProvider({ snapshot: () => null }).read({ ...ctx, commit: baseline,
        sourceFiles: scopedFiles, sourceVersion: createHash('sha256').update(JSON.stringify(scopedFiles.map(f => [f.path, f.sha256]))).digest('hex'),
        repository: { ...ctx.repository, harness: 'disposable-fixture' } }, new AbortController().signal);
      expect(scoped.lines).toContainEqual(expect.stringContaining('New copy b.ts:2 planted since'));
      expect(scoped.lines).toContainEqual(expect.stringContaining('Untouched sibling a.ts:1 original'));
      const noneFiles = [{ path: 'none.ts', sha256: createHash('sha256').update(fixture.sources['none.ts']).digest('hex') }];
      const none = await provider.read({ ...ctx, paths: ['none.ts'], sourceFiles: noneFiles,
        sourceVersion: createHash('sha256').update(JSON.stringify(noneFiles.map(f => [f.path, f.sha256]))).digest('hex') }, new AbortController().signal);
      expect(none.lines).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not issue source-mismatched or escaping citations', async () => {
    const fixture = cloneAdvisoryFixture(), root = await mkdtemp(join(tmpdir(), 'clone-provider-stale-'));
    try {
      for (const [path, source] of Object.entries(fixture.sources)) await writeFile(join(root, path), source);
      const sourceFiles = [{ path: 'b.ts', sha256: '0'.repeat(64) }];
      const sourceVersion = createHash('sha256').update(JSON.stringify(sourceFiles.map(f => [f.path, f.sha256]))).digest('hex');
      const result = await cloneBriefProvider({ snapshot: () => fixture.snapshot }).read({ ...context,
        paths: ['b.ts'], sourceFiles, sourceVersion, repository: { workspaceId: context.workspaceId, rootPath: root } }, new AbortController().signal);
      expect(result).toMatchObject({ status: 'unknown', lines: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('P010 optional plan-authoring delivery', () => {
  const ctx = (invocation: string) => ({ workspaceId: context.workspaceId, isSuperuser: true,
    uiClientId: 'su-fixture', dispatchCallId: invocation, metadata: vi.fn() }) as unknown as UnifiedToolContext;
  const input = { workspaceId: context.workspaceId, harness: 'fixture-harness', plan: 'fixture-plan', text: 'aggregate positive values' };

  it('queries anchorless intent through the existing provider seam and records real authoring identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'authoring-intent-'));
    const record = vi.fn(async (_input: ReuseIssuedRecord) => true), read = vi.fn(async (c: ReuseProviderContext) => ({
      status: 'measured' as const, sourceVersion: c.sourceVersion, indexVersion: 'semantic-index',
      lines: ['Suggested anchor, semantic candidate: target.ts:1 target; verify before reuse'], citedPaths: ['target.ts'] }));
    try {
      const result = await authoringReuse(ctx('plans-new-dispatch'), input, { root: async () => root,
        snapshot: () => null, providers: [{ id: 'semantic', read }], recordIssued: record });
      expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0]![0]).toMatchObject({ surface: 'authoring', paths: [], itemText: input.text });
      expect(result?.hints[0]?.text).toContain('Suggested anchor');
      if (!result || !('observations' in result)) throw new Error('Expected composed authoring advice');
      expect(result.ledger).toBe('recorded');
      expect(record.mock.calls[0]?.[0]).toMatchObject({ context: { invocation: 'plans-new-dispatch', plan: 'fixture-plan' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('issues anchored copy hints for add-item, preserves nonmatches, and isolates provider failures', async () => {
    const fixture = deliveryFixture(), root = await mkdtemp(join(tmpdir(), 'authoring-copy-'));
    try {
      for (const [path, source] of Object.entries(fixture.sources)) await writeFile(join(root, path), source);
      const deps = { root: async () => root, snapshot: () => fixture.snapshot, recordIssued: async () => true,
        providers: [cloneBriefProvider({ snapshot: () => fixture.snapshot }),
          { id: 'semantic' as const, read: async () => { throw new Error('semantic unavailable'); } }] };
      const result = await authoringReuse(ctx('plans-add-item-dispatch'), { ...input, item: 'P-010', text: 'change b.ts', paths: ['b.ts'] }, deps);
      expect(result?.hints[0]?.text).toContain('Copy family a.ts:1 original');
      if (!result || !('observations' in result)) throw new Error('Expected composed copy advice');
      expect(result.observations).toContainEqual(expect.objectContaining({ provider: 'semantic', status: 'unknown' }));
      const none = await authoringReuse(ctx('plans-add-none'), { ...input, text: 'change none.ts', paths: ['none.ts'] }, deps);
      expect(none?.hints).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps missing attribution or failed source lookup optional after a successful canonical write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const missing = { dispatchCallId: 'unattributed' } as UnifiedToolContext;
      await expect(authoringReuse(missing, input)).resolves.toBeUndefined();
      await expect(authoringReuse(ctx('missing-registry'), input, { root: async () => { throw new Error('registry unavailable'); } })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]?.join(' ')).toContain('registry unavailable');
    } finally { warn.mockRestore(); }
  });

  it.each(['text', 'anchor'] as const)('keeps explicit %s paths scoped when prose matches unrelated symbols', async kind => {
    const fixture = deliveryFixture(), root = await mkdtemp(join(tmpdir(), 'authoring-explicit-'));
    const snapshot = { ...fixture.snapshot, symbols: new Map([['copy', Array.from({ length: 20 }, (_, i) => ({
      id: `copy-${i}`, name: 'copy', path: `unrelated-${i}.ts`, line: 1, column: 1,
      sha256: 'a'.repeat(64), signature: 'copy()', aliases: [], callers: [],
    }))]]) };
    try {
      for (const [path, source] of Object.entries(fixture.sources)) await writeFile(join(root, path), source);
      const result = await authoringReuse(ctx(`explicit-${kind}`), { ...input,
        text: kind === 'text' ? 'Improve copy aggregation in b.ts' : 'Improve copy aggregation',
        ...(kind === 'anchor' ? { paths: ['b.ts'] } : {}),
      }, { root: async () => root, snapshot: () => snapshot,
        providers: [cloneBriefProvider({ snapshot: () => snapshot })], recordIssued: async () => true });
      expect(result?.hints[0]?.text).toContain('Copy family a.ts:1 original');
      if (!result || !('observations' in result)) throw new Error('Expected scoped authoring advice');
      expect(result.observations[0]?.status).toBe('issued');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('discovers symbol source paths from the registered harness for anchorless authoring', async () => {
    const fixture = deliveryFixture(), root = await mkdtemp(join(tmpdir(), 'authoring-harness-'));
    const snapshot = { ...fixture.snapshot, symbols: new Map([['copy', [{ id: 'copy-id', name: 'copy',
      path: 'b.ts', line: 1, column: 1, sha256: createHash('sha256').update(fixture.sources['b.ts']).digest('hex'),
      signature: 'copy(values: number[])', aliases: [], callers: [] }]]]) };
    const peek = vi.spyOn(pushSnapshots, 'peekPushSnapshot').mockImplementation(harness => harness === input.harness ? snapshot : null);
    try {
      for (const [path, source] of Object.entries(fixture.sources)) await writeFile(join(root, path), source);
      const result = await authoringReuse(ctx('plans-new-symbol'), { ...input, text: 'Improve copy aggregation' }, {
        root: async () => root, providers: [cloneBriefProvider()], recordIssued: async () => true,
      });
      expect(result?.hints[0]?.text).toContain('Copy family a.ts:1 original');
      expect(peek.mock.calls.every(([harness]) => harness === input.harness)).toBe(true);
    } finally { peek.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});

describe('P009 shared claim provider composition', () => {
  it('preserves mandatory data and orders independently completed providers by declared priority in their destinations', async () => {
    const base = { mandatory: 'Existing source and anchor evidence must remain byte-identical.' };
    const result = await compose(base, ['coverage', 'sql', 'provenance', 'cochange', 'clones'].map(id => provider(id as ReuseProviderId)));
    expect(base).toEqual({ mandatory: 'Existing source and anchor evidence must remain byte-identical.' });
    expect(result.brief.mandatory).toBe(base.mandatory);
    expect(result.brief.impact?.map(value => value.provider)).toEqual(['clones', 'sql']);
    expect(result.brief.coChange?.[0]?.provider).toBe('cochange');
    expect(result.brief.whatChangedSincePlanning?.[0]?.provider).toBe('provenance');
    expect(result.brief.tests?.[0]?.provider).toBe('coverage');
    expect(result.observations.map(row => [row.provider, row.status])).toEqual([
      ['clones', 'issued'], ['cochange', 'issued'], ['provenance', 'issued'], ['sql', 'issued'], ['coverage', 'issued'],
    ]);
    expect(result.observations.every(row => row.sourceVersion === 'blob-v1' && row.indexVersion === 'index-v2')).toBe(true);
  });

  it.each([['clones', 600], ['cochange', 250], ['provenance', 400], ['sql', 450], ['coverage', 400]] as const)(
    'charges the %s envelope to its %i cap, truncating at whole lines', async (id, cap) => {
      const line = 'Located evidence target.ts:42 qualified as partial 😀';
      const result = await compose({ mandatory: 'base' }, [provider(id, Array.from({ length: 40 }, () => line))]);
      const row = result.observations[0]!;
      expect(row).toMatchObject({ status: 'issued', reason: 'truncated' });
      expect(row.chars).toBeLessThanOrEqual(cap);
      const section = Object.values(result.brief).find(Array.isArray) as ReuseContribution[];
      expect(section[0]!.text.split('\n').every(part => part === line)).toBe(true);
      const enlarged = { ...section[0]!, text: `${section[0]!.text}\n${line}` };
      const delta = briefCodePoints(JSON.stringify(append({ mandatory: 'base' }, enlarged)))
        - briefCodePoints(JSON.stringify({ mandatory: 'base' }));
      expect(Math.max(briefCodePoints(JSON.stringify(enlarged)), delta)).toBeGreaterThan(cap);
    });

  it('uses the global serialized Unicode limit, includes section envelopes, and preserves base even when nothing fits', async () => {
    const providers = ['clones', 'cochange', 'provenance', 'sql', 'coverage'].map(id => provider(id as ReuseProviderId, ['😀'.repeat(50)]));
    const base = { mandatory: '😀'.repeat(2_700) };
    const result = await compose(base, providers);
    expect(result.brief.mandatory).toBe(base.mandatory);
    expect(briefCodePoints(JSON.stringify(result.brief))).toBeLessThanOrEqual(3_000);
    expect(JSON.stringify(result.brief).length).toBeGreaterThan(3_000); // UTF-16 is not this contract's unit.
    expect(result.observations[0]?.status).toBe('issued');
    expect(result.observations.slice(1).some(row => row.status === 'budget')).toBe(true);
    const full = { mandatory: 'x'.repeat(3_000) };
    let calls = 0;
    const blocked = await compose(full, [{ id: 'clones', read: async () => { calls++; return provider('clones').read(context, new AbortController().signal); } }]);
    expect(blocked.brief).toBe(full); expect(calls).toBe(0);
    expect(blocked.observations[0]).toMatchObject({ status: 'budget' });
  });

  it('does not emit no-match or unversioned guesses, and a failed provider leaves base and other providers intact', async () => {
    const result = await compose({ mandatory: 'source base' }, [provider('clones', []),
      { id: 'cochange', read: async () => { throw new Error('unavailable index'); } },
      { id: 'provenance', read: async () => ({ status: 'measured', lines: ['unverified claim'], sourceVersion: null, indexVersion: null }) },
      provider('sql')]);
    expect(result.brief).toEqual({ mandatory: 'source base', impact: [{ provider: 'sql', section: 'impact',
      text: 'sql: target.ts:2; source scope is partial', sourceVersion: 'blob-v1', indexVersion: 'index-v2' }] });
    expect(result.observations.slice(0, 3).map(row => [row.status, row.reason])).toEqual([
      ['no-match', 'complete'], ['unknown', 'failure'], ['unknown', 'unversioned'],
    ]);
  });

  it('cancels a hung provider at its soft deadline while retaining an independently completed source', async () => {
    let aborted = false;
    const result = await compose({ mandatory: 'base' }, [{ id: 'clones', read: async (_context, signal) => {
      signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {});
    } }, provider('coverage')]);
    expect(aborted).toBe(true);
    expect(result.observations[0]).toMatchObject({ status: 'unknown', reason: 'timeout' });
    expect(result.brief.tests?.[0]?.provider).toBe('coverage');
  });

  it('shares the original hard deadline with mandatory assembly and serialization', async () => {
    let clock = 6_000;
    let called = false;
    const expired = await compose({ mandatory: 'base' }, [{ id: 'clones', read: async () => { called = true; throw new Error(); } }], () => clock, 6_000);
    expect(expired.brief).toEqual({ mandatory: 'base' }); expect(called).toBe(false);
    clock = 5_999;
    const result = await composeReuseBrief({ base: { mandatory: 'base' }, context, deadline: 6_000, now: () => clock,
      providers: [provider('clones')], append, serialize: brief => {
        if (brief.impact?.length) clock = 6_000;
        return JSON.stringify(brief);
      } });
    expect(result.brief).toEqual({ mandatory: 'base' });
    expect(result.observations[0]?.status).not.toBe('issued');
  });

  it('makes registration explicit, rejects duplicate identity, and removes only its own registration', async () => {
    const source = provider('clones'); const remove = registerReuseBriefProvider(source);
    try {
      expect(() => registerReuseBriefProvider(source)).toThrow('already registered');
      const result = await composeReuseBrief({ base: { mandatory: 'base' }, context, append, deadline: Date.now() + 6_000 });
      expect(result.brief.impact?.[0]?.provider).toBe('clones');
    } finally { remove(); }
  });

  it.each(['claim', 'authoring', 'completion'] as const)('%s keeps independent match, no-match, overflow, failure and timeout outcomes', async surface => {
    vi.useFakeTimers();
    try {
      const pending = composeReuseBrief({ base: { mandatory: 'base' }, context: { ...context, surface }, append,
        deadline: Date.now() + 6000, providers: [provider('clones'), provider('cochange', []),
          provider('provenance', ['x'.repeat(500)]), { id: 'sql', read: async () => { throw new Error('index unavailable'); } },
          { id: 'coverage', read: async () => new Promise(() => {}) }] });
      await vi.advanceTimersByTimeAsync(750);
      const result = await pending;
      expect(result.brief.impact?.[0]?.provider).toBe('clones');
      expect(result.observations.map(row => [row.status, row.reason])).toEqual([
        ['issued', 'complete'], ['no-match', 'complete'], ['budget', 'truncated'], ['unknown', 'failure'], ['unknown', 'timeout'],
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a stale source version even when the provider labels the result measured', async () => {
    const result = await composeReuseBrief({ base: { mandatory: 'base' }, context: { ...context, sourceVersion: 'new-blob' },
      append, deadline: Date.now() + 6000, providers: [provider('clones')] });
    expect(result.brief).toEqual({ mandatory: 'base' });
    expect(result.observations[0]).toMatchObject({ status: 'unknown', reason: 'source-mismatch', chars: 0 });
  });
  it('keeps another provider from changing the coverage question or static reach', async () => {
    const scope = { ...context, changedLines: { 'target.ts': [2, 3] }, staticTests: ['target.test.ts'] };
    const result = await composeReuseBrief({ base: { mandatory: 'base' }, context: scope, append, deadline: Date.now() + 6000,
      providers: [{ id: 'clones', read: async c => {
        Reflect.set(c.changedLines!['target.ts']!, 0, 99);
        Reflect.set(c.staticTests!, 0, 'forged.test.ts');
        return provider('clones').read(c, new AbortController().signal);
      } }, { id: 'coverage', read: async c => ({ status: 'measured', sourceVersion: c.sourceVersion, indexVersion: 'scope-v1',
        lines: [`lines ${c.changedLines!['target.ts']!.join(',')}; static ${c.staticTests!.join(',')}`] }) }] });
    expect(result.brief.tests?.[0]?.text).toBe('lines 2,3; static target.test.ts');
    expect(scope.changedLines).toEqual({ 'target.ts': [2, 3] });
    expect(scope.staticTests).toEqual(['target.test.ts']);
  });
});
