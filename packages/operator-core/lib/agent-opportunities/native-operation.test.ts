/** Native source fixture identity: native-provider-wire-v1. */
import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { recordActivity } from '@papercusp/activity-bridge';
import { boundedStage } from './pipeline';
import { observeNativeOperation, groupNativeOperations, readableNativeChains, nativeTranscriptSources, type NativeProvider } from './native-operation';
import type { SearchSource } from './search-reformulation';
const scope = { workspaceId: 'native-test', sourceBoundary: 'authorized', epoch: 'v1', key: new Uint8Array(32).fill(91) };
export const source = (id: string, over: Partial<SearchSource> = {}): SearchSource => ({
  workspaceId: scope.workspaceId, harnessSlug: 'native', authorizationScope: scope.sourceBoundary,
  provider: 'codex', namespace: 'session-1', actor: 'su-native', verifiedAgent: true, origin: 'agent',
  at: '2026-10-24T12:00:00Z', copyRef: `transcript:${id}`, tool: 'exec_command', args: { cmd: 'rg -n private ./src | head -5' },
  callId: id, identityAuthority: 'provider', sourceComplete: true,
  result: { provider: 'codex', namespace: 'session-1', callId: id, complete: true, status: 'ok', body: { exit_code: 0 } }, ...over,
});
const observe = (s: SearchSource, scoped = scope) => observeNativeOperation(s, scoped)!;

it('native UNKNOWN observations retain exact output availability for current-source revision checks', () => {
  const call = source('unknown-result');
  const available = observe({ ...call, result: { ...call.result!, body: { unrecognized: true } } });
  const missing = observe({ ...call, result: null });
  expect(available.outcome).toBe('UNKNOWN');
  expect(missing.outcome).toBe('UNKNOWN');
  const { resultAvailable: before, ...retained } = available;
  const { resultAvailable: after, ...lost } = missing;
  expect(before).toBe(true); expect(after).toBe(false);
  expect(retained).toEqual(lost);
});

it('R12-CONTRACT', () => {
  const shell = [source('one'), source('two')].map(s => observe(s));
  const browser = [source('click1', { tool: 'browser_click', args: { selector: '#save' } }),
    source('click2', { tool: 'browser_click', args: { selector: '#save' } })].map(s => observe(s));
  expect(groupNativeOperations([...shell, ...browser]).chains.map(c => [c.kind, c.logicalDemand])).toEqual([['shell', 2], ['browser', 2]]);
  for (const args of [{ cmd: 'rg -i private ./src | head -5' }, { cmd: 'rg -n private ./src && head -5' }, { cmd: 'rg -n private ./other | head -5' }])
    expect(observe(source('different', { args })).fingerprint).not.toBe(shell[0]!.fingerprint);
  for (const args of [{ selector: '#cancel' }, { selector: '#save', text: 'different' }])
    expect(observe(source('different', { tool: 'browser_click', args })).fingerprint).not.toBe(browser[0]!.fingerprint);
  expect(observe(source('a', { tool: 'browser', args: { action: 'fill', selector: '#password', text: 'first-secret' } })).fingerprint)
    .toBe(observe(source('b', { tool: 'browser', args: { text: 'second-secret', action: 'fill', selector: '#password' } })).fingerprint);
  expect(observe(source('unsupported', { tool: 'invented-browser' })).evidenceGaps).toContain('unsupported-operation');
  expect(observeNativeOperation(source('system', { origin: 'system' }), scope)).toBeNull();
  expect(observeNativeOperation(source('human', { verifiedAgent: false }), scope)).toBeNull();
});

it('OUTCOME-P-012', async () => {
  // Credentials are removed before JSON escaping and before fingerprinting,
  // including nested browser values and short explicitly known credentials.
  for (const pair of [['first"secret', 'second"secret'], ['first\\secret', 'second\\secret'], ['first\nsecret', 'second\nsecret'], ['x', 'y']]) {
    const scoped = { ...scope, knownSecrets: pair };
    const shell = pair.map(value => observe(source('known', { args: { cmd: `echo ${value}` } }), scoped));
    const browser = pair.map(value => observe(source('known', { tool: 'browser', args: { action: 'evaluate', payload: { nested: [value] } } }), scoped));
    expect(shell[0]!.fingerprint).toBe(shell[1]!.fingerprint);
    expect(browser[0]!.fingerprint).toBe(browser[1]!.fingerprint);
  }
  for (const pair of [
    [{ cmd: 'curl --password tiny --token=first-opaque-value' }, { cmd: 'curl --password other --token=second-opaque-value' }],
    [{ cmd: 'TOKEN=first-opaque-value curl private' }, { cmd: 'TOKEN=second-opaque-value curl private' }],
    [{ cmd: 'echo known-first-secret-value' }, { cmd: 'echo known-second-secret-value' }],
  ]) {
    const scoped = { ...scope, knownSecrets: ['known-first-secret-value', 'known-second-secret-value'] };
    expect(observe(source('a', { args: pair[0] }), scoped).fingerprint).toBe(observe(source('b', { args: pair[1] }), scoped).fingerprint);
  }
  for (const pair of [
    [{ action: 'fill', selector: '#password', text: 'first-secret' }, { action: 'fill', selector: '#password', text: 'second-secret' }],
    [{ action: 'navigate', url: 'https://alice:secret@private.example/?token=tiny' }, { action: 'navigate', url: 'https://bob:other@private.example/?token=other' }],
    [{ action: 'click', selector: '#save', password: 'first-secret' }, { action: 'click', selector: '#save', password: 'second-secret' }],
  ]) {
    const rows = pair.map((args, i) => observe(source(String(i), { tool: 'browser', args })));
    expect(rows[0]!.fingerprint).toBe(rows[1]!.fingerprint);
    const chains = await readableNativeChains(rows, async () => true);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.summary).toBe('Recurring native browser operation');
    expect(JSON.stringify({ rows, chains })).not.toMatch(/first-secret|second-secret|private\.example|alice|bob/);
  }
  const a = observe(source('same'));
  expect(observe(source('same', { authorizationScope: 'other' }), { ...scope, sourceBoundary: 'other' }).fingerprint).not.toBe(a.fingerprint);
  expect(observe(source('same'), { ...scope, epoch: 'v2' }).actorToken).not.toBe(a.actorToken);
});

it('R22-DEDUP', () => {
  const first = observe(source('same')), second = observe(source('second'));
  const copies = groupNativeOperations([first, { ...first, sourceToken: 'activity-copy', at: '2026-10-24T12:00:01Z', outcome: 'UNKNOWN' }, second]);
  expect(copies).toMatchObject({ copiesCollapsed: 1, collisions: 0 });
  expect(copies.chains[0]).toMatchObject({ logicalDemand: 2, successCount: 2 });
  expect(copies.chains[0]!.sourceRefs).toContain('activity-copy');
  expect(groupNativeOperations([first, observe(source('same', { args: { cmd: 'rm private' } })), second])).toMatchObject({ collisions: 1, chains: [] });
  expect(groupNativeOperations([first, { ...first, outcome: 'error' }, second])).toMatchObject({ collisions: 1, chains: [] });
  expect(groupNativeOperations([first, observe(source('same', { namespace: 'other-session' }))]).operations).toHaveLength(2);
  expect(groupNativeOperations([observe(source('missing', { callId: null })), second]).chains).toEqual([]);
});

it('R21-SHARED-ID-COLLISION R21-NAMESPACE-PROVIDER-MISMATCH R21-INTERLEAVED-SAME-ACTOR R21-EXACT-ID-CONTROL', () => {
  const positive = source('exact');
  expect(observe(positive).outcome).toBe('success');
  for (const result of [{ ...positive.result!, callId: 'other' }, { ...positive.result!, namespace: 'other' }, { ...positive.result!, provider: 'omp' as const }])
    expect(observe({ ...positive, result }).outcome).toBe('UNKNOWN');
  expect(observe(source('yielded', { result: { ...source('yielded').result!, body: { session_id: 12 } } })).outcome).toBe('UNKNOWN');
  expect(observe(source('bounded', { result: { ...source('bounded').result!, body: { exit_code: 0, truncated: true } } })).outcome).toBe('UNKNOWN');
});

const wire = (provider: NativeProvider, id: string, command = 'rg private') => {
  const timestamp = '2026-10-24T12:00:00Z';
  if (provider === 'codex') return [
    { timestamp, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec_command', call_id: id, input: JSON.stringify({ cmd: command }) } },
    { timestamp, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: '{"exit_code":0}' }] } },
  ];
  if (provider === 'claude') return [
    { timestamp, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } },
    { timestamp, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: '{"exit_code":0}' }] } },
  ];
  return [
    { timestamp, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'shell', id, arguments: { command } }] } },
    { timestamp, type: 'message', message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: '{"exit_code":0}' }] } },
  ];
};

it('R26-PROVIDERS', () => {
  for (const provider of ['codex', 'claude', 'omp'] as const) {
    const context = { workspaceId: scope.workspaceId, harnessSlug: 'native', authorizationScope: scope.sourceBoundary,
      actor: 'su-native', verifiedAgent: true, origin: 'agent' as const, provider, sessionId: 'session-1', complete: true };
    const lines = [...wire(provider, 'one'), ...wire(provider, 'two')].map(v => JSON.stringify(v));
    const sources = nativeTranscriptSources(lines, context);
    expect(groupNativeOperations(sources.map(s => observe(s))).chains[0]).toMatchObject({ kind: 'shell', logicalDemand: 2, successCount: 2 });
    expect(nativeTranscriptSources([], context)).toEqual([]);
    expect(nativeTranscriptSources(lines, { ...context, complete: false }).map(s => observe(s)).every(s => s.fingerprint === null && s.outcome === 'UNKNOWN')).toBe(true);
  }
});

it.each(['claude', 'codex', 'omp'] as const)('recognizes replacement MCP shell calls in the %s provider transcript', provider => {
  const context = { workspaceId: scope.workspaceId, harnessSlug: 'native', authorizationScope: scope.sourceBoundary,
    actor: 'su-native', verifiedAgent: true, origin: 'agent' as const, provider, sessionId: 'session-1', complete: true };
  const lines = ['one', 'two'].flatMap(id => {
    const records: unknown[] = wire(provider, id);
    if (provider === 'codex') {
      records[0] = { timestamp: '2026-10-24T12:00:00Z', type: 'response_item', payload: {
        type: 'function_call', namespace: 'functions', name: 'mcp__papercusp_su__capability_bash',
        call_id: id, arguments: JSON.stringify({ command: 'rg private' }),
      } };
      records[1] = { timestamp: '2026-10-24T12:00:00Z', type: 'response_item', payload: {
        type: 'function_call_output', call_id: id, output: '{"exit_code":0}',
      } };
    } else if (provider === 'claude') {
      const block = (records[0] as { message: { content: { name: string }[] } }).message.content[0]!;
      block.name = 'mcp__papercusp-su__capability_bash';
    } else {
      const block = (records[0] as { message: { content: { name: string }[] } }).message.content[0]!;
      block.name = 'mcp__papercusp_su__capability_bash';
    }
    return records.map(record => JSON.stringify(record));
  });
  const calls = nativeTranscriptSources(lines, context);
  expect(calls).toHaveLength(2);
  expect(groupNativeOperations(calls.map(call => observe(call))).chains).toMatchObject([
    { kind: 'shell', logicalDemand: 2, successCount: 2 },
  ]);
  expect(nativeTranscriptSources(lines, { ...context, complete: false }).map(call => observe(call)))
    .toEqual([expect.objectContaining({ fingerprint: null, outcome: 'UNKNOWN' }),
      expect.objectContaining({ fingerprint: null, outcome: 'UNKNOWN' })]);
});

it('keeps replacement names distinct from foreign servers, wrapper fanout and missing results', () => {
  const original = source('replacement', { tool: 'capability:bash', args: { command: 'rg private' } });
  const expected = observe(original);
  for (const tool of ['capability_bash', 'capability.bash', 'mcp__papercusp__capability_bash',
    'mcp__papercusp-su__capability_bash', 'functions.mcp__papercusp_su__capability_bash']) {
    const call = { ...original, tool };
    expect(observe(call)).toMatchObject({ kind: 'shell', fingerprint: expected.fingerprint, outcome: 'success' });
    expect(observe({ ...call, result: null }).outcome).toBe('UNKNOWN');
    expect(observe({ ...call, result: { ...call.result!, callId: 'other' } }).outcome).toBe('UNKNOWN');
    expect(observe({ ...call, args: { command: 'rg private --hidden' } }).fingerprint).not.toBe(expected.fingerprint);
  }
  for (const tool of ['mcp__foreign__capability_bash', 'functions.mcp__foreign__capability_bash',
    'mcp__papercusp-foreign__capability_bash', 'tools:invoke', 'functions.exec', 'capability:read']) {
    expect(observe({ ...original, tool })).toMatchObject({ kind: null, fingerprint: null, outcome: 'UNKNOWN' });
  }
  expect(observe({ ...original, tool: 'mcp__papercusp_su__capability_terminal',
    result: { ...original.result!, body: { opened: 1 } } })).toMatchObject({ kind: 'shell', outcome: 'UNKNOWN' });
});

it('R15-CURRENT-ACL R23-DERIVED-ACL', async () => {
  const rows = [source('one'), source('two')].map(s => observe(s));
  let allowed = true;
  const authorize = vi.fn(async () => allowed);
  expect(await readableNativeChains(rows, authorize)).toHaveLength(1);
  allowed = false;
  expect(await readableNativeChains(rows, authorize)).toEqual([]);
  expect(await readableNativeChains(rows, async id => id !== rows[1]!.sourceToken)).toEqual([]);
  expect(await readableNativeChains(rows, async () => { throw new Error('deleted'); })).toEqual([]);
  allowed = true;
  expect(await readableNativeChains(rows, authorize)).toHaveLength(1);
});

it('R25-PASSIVE', () => {
  const path = `/tmp/native-unit-sentinel-${process.pid}-${Date.now()}`;
  const command = `touch ${path}`;
  const rows = [source('one', { args: { cmd: command } }), source('two', { tool: 'browser', args: { action: 'evaluate', script: 'globalThis.__nativeSentinel = true' } })];
  rows.forEach(s => observe(s));
  expect(existsSync(path)).toBe(false);
  expect((globalThis as { __nativeSentinel?: boolean }).__nativeSentinel).toBeUndefined();
});

it('R20-ISOLATION', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const mining = boundedStage(async () => { await held; throw new Error('mining failed'); }, 1000).catch(() => null);
  const append = vi.fn(async () => ({ id: 'canonical-record' }));
  const receipt = await recordActivity({ append }, { owner: 'su-native', agent: 'codex', toolName: 'exec_command', toolInput: { cmd: 'echo safe' } });
  expect(receipt.id).toBe('canonical-record'); expect(append).toHaveBeenCalledOnce();
  release(); await mining;
  expect((await recordActivity({ append }, { owner: 'su-native', toolName: 'exec_command', toolInput: { cmd: 'echo safe' } })).id).toBe('canonical-record');
});
