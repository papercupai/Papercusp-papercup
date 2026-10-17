import { describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/db-org', async original => ({ ...await original<object>(), withWorkspace: vi.fn(async (_ws, fn) => fn({ unsafe: vi.fn() })) }));
import { replayRule, readRuleReplaySamples, type RuleReplaySample } from './authored-rule-test';
import { withWorkspace } from '@papercusp/db-org';
import type { LocalRuleDefinition } from './local-rule-store';

const base = { id: 'demo', title: 'Demo', description: 'A replay fixture', version: '1.0.0' };
const asyncRule = { ...base, delivery: 'async', on: 'demo:*', fire: 'class:demo.notify@1.0.0#send',
  when: { 'args.ready': { equals: true } }, args: { message: 'would send' } } as LocalRuleDefinition;
const sample = (overrides: Partial<RuleReplaySample> = {}): RuleReplaySample => ({
  id: 'tool:1', tool: 'demo:done', args: { ready: true }, ok: true, source: 'tool-ledger', inputComplete: true, ...overrides,
});
describe('pure rule replay', () => {
  it('recognizes the ledger writer truncation marker rather than its short JSON size', async () => {
    const unsafe = vi.fn(async (_query: string, _params: unknown[]) => [{ id: '10', tool_name: 'demo:done', args_json: { _truncated: true, _size: 90000 }, status: 'ok' }]);
    vi.mocked(withWorkspace).mockImplementationOnce(async (_ws, fn) => fn({ unsafe } as never));
    const samples = await readRuleReplaySamples({ workspaceId: 'ws' }, asyncRule, 3);
    expect(samples[0].inputComplete).toBe(false);
    expect(replayRule(asyncRule, samples)[0].action).toBe('unknown');
  });
  it('evaluates explicit context fixtures only at the declared hook sink', () => {
    const rule = { ...base, delivery: 'sync', sink: 'turn-start',
      context: { ref: 'demo.context@1', verb: 'read', tokenBudget: 100, priority: 0, overBudget: 'omit' } } as LocalRuleDefinition;
    expect(replayRule(rule, [sample({ source: 'fixture', sink: 'turn-start' }), sample({ sink: 'post-tool' })])
      .map(o => o.action)).toEqual(['context', 'none']);
  });
  it('treats an unrecorded native client as unknown for client-sensitive guards', () => {
    const rule = { ...base, delivery: 'sync', sink: 'pre-tool', tools: ['demo:*'],
      guard: { deny: { client: { equals: 'codex' } } } } as LocalRuleDefinition;
    expect(replayRule(rule, [sample()])[0].action).toBe('unknown');
    expect(replayRule(rule, [sample({ source: 'fixture', client: 'codex' })])[0].action).toBe('deny');
  });

  it('reports proposed actions, matching predicates and success filters without a dispatcher', () => {
    expect(replayRule(asyncRule, [sample(), sample({ args: { ready: false } }), sample({ ok: false }), sample({ tool: 'other:done' })])
      .map(o => o.action)).toEqual(['fire', 'none', 'none', 'none']);
    expect(replayRule(asyncRule, [sample()])[0].proposed).toEqual({ fire: asyncRule.delivery === 'async' && asyncRule.fire, args: { message: 'would send' } });
  });
  it('uses the same pre-tool guard evaluator and keeps tool management reachable', () => {
    const rule = { ...base, delivery: 'sync', sink: 'pre-tool', tools: ['capability:bash'],
      guard: { deny: { 'input.command': { equals: 'git push' } }, reason: 'no push' } } as LocalRuleDefinition;
    expect(replayRule(rule, [sample({ tool: 'capability:bash', args: { command: 'git push' } }), sample({ tool: 'rules:disable' })])
      .map(o => o.action)).toEqual(['deny', 'none']);
  });
  it('does not invent unavailable result bodies or truncated arguments', () => {
    expect(replayRule({ ...asyncRule, when: { 'result.data.ok': { equals: true } } } as LocalRuleDefinition, [sample()])[0].action).toBe('unknown');
    expect(replayRule(asyncRule, [sample({ inputComplete: false })])[0].action).toBe('unknown');
  });
  it('replays event keys and payloads using the production condition language', () => {
    const rule = { ...asyncRule, on: 'event:demo:*', when: { 'payload.ready': { equals: true } } } as LocalRuleDefinition;
    expect(replayRule(rule, [sample({ source: 'event-latch', tool: 'event:demo:ready', payload: { ready: true } })])[0].action).toBe('fire');
  });
  it('bounds history in SQL and passes workspace/harness scope without wildcard SQL interpolation', async () => {
    const unsafe = vi.fn(async (_query: string, _params: unknown[]) => [{ id: '9', tool_name: 'demo:done', args_json: {}, status: 'success' }]);
    vi.mocked(withWorkspace).mockImplementationOnce(async (_ws, fn) => fn({ unsafe } as never));
    const rows = await readRuleReplaySamples({ workspaceId: 'ws', potSlug: 'pot' }, asyncRule, 900, 'harness');
    expect(unsafe.mock.calls[0][1]).toEqual(['ws', 'harness', [], ['demo:'], 200]);
    expect(rows[0]).toMatchObject({ id: 'tool:9', ok: true });
  });
  it('reads code-emitted event latch snapshots without firing them', async () => {
    const unsafe = vi.fn(async (_query: string, _params: unknown[]) => [{ event_key: 'demo:ready', last_payload: { ready: true }, last_fired_at: '2026-01-01Z' }]);
    vi.mocked(withWorkspace).mockImplementationOnce(async (_ws, fn) => fn({ unsafe } as never));
    expect(await readRuleReplaySamples({ workspaceId: 'ws' }, { ...asyncRule, on: 'event:demo:*' } as LocalRuleDefinition, 3))
      .toMatchObject([{ source: 'event-latch', payload: { ready: true } }]);
    expect(unsafe.mock.calls[0][1]).toEqual(['ws', true, 'demo:', 3]);
  });
});
