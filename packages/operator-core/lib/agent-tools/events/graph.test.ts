/**
 * graph.test.ts — events:graph projection (GAP 7).
 *
 * Deps mocked (listReactionRules / reactionGraph / getOrgPg). Asserts
 * describeCondition's three kinds (none / predicate / data) and the rule→edge
 * projection: argsKind (function / none / static) + the default fills
 * (mode → 'durable', onlyOnSuccess → true, source → 'unknown').
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: vi.fn() })) }));
vi.mock('../../events', () => ({
  listReactionRules: vi.fn(),
  reactionGraph: vi.fn(() => []),
}));

import graph from './graph';
import { listReactionRules, reactionGraph } from '../../events';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof graph.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await graph.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reactionGraph).mockReturnValue([]);
});

describe('events:graph projection', () => {
  it('a function `when` → condition.kind=predicate (no leaked predicate), function args → argsKind=function', async () => {
    vi.mocked(listReactionRules).mockReturnValue([
      { id: 'r-fn', on: 'coord:handoff', fire: 'x:do', when: () => true, args: () => ({}), mode: 'sync', onlyOnSuccess: false, source: 'plugin', capability: 'coord:write' },
    ] as never);
    const out = await call({});
    expect(out.rules[0].condition).toEqual({ kind: 'predicate' });
    expect(out.rules[0].condition.data).toBeUndefined();
    expect(out.rules[0].argsKind).toBe('function');
    // explicit values pass through (not the defaults)
    expect(out.rules[0]).toMatchObject({ mode: 'sync', onlyOnSuccess: false, source: 'plugin' });
  });

  it('a data `when` → condition.kind=data carrying the predicate object; static args → argsKind=static', async () => {
    vi.mocked(listReactionRules).mockReturnValue([
      { id: 'r-data', on: 'lock:grant', fire: 'y:go', when: { 'result.ok': true }, args: { foo: 1 }, capability: 'events:read' },
    ] as never);
    const out = await call({});
    expect(out.rules[0].condition).toEqual({ kind: 'data', data: { 'result.ok': true } });
    expect(out.rules[0].argsKind).toBe('static');
  });

  it('undefined `when` + undefined args → condition.kind=none, argsKind=none, and the default fills apply', async () => {
    vi.mocked(listReactionRules).mockReturnValue([
      { id: 'r-bare', on: 'a:b', fire: 'c:d', capability: 'coord:write' },
    ] as never);
    const out = await call({});
    expect(out.rules[0].condition).toEqual({ kind: 'none' });
    expect(out.rules[0].argsKind).toBe('none');
    // defaults: mode→'durable', onlyOnSuccess→true, source→'unknown'
    expect(out.rules[0]).toMatchObject({ mode: 'durable', onlyOnSuccess: true, source: 'unknown' });
    expect(out.ruleCount).toBe(1);
  });

  it('`on` filter narrows rules to the matching trigger (handles a string[] `on`)', async () => {
    vi.mocked(listReactionRules).mockReturnValue([
      { id: 'r1', on: 'coord:handoff', fire: 'f1', capability: 'c' },
      { id: 'r2', on: ['lock:grant', 'coord:handoff'], fire: 'f2', capability: 'c' },
      { id: 'r3', on: 'other:tool', fire: 'f3', capability: 'c' },
    ] as never);
    const out = await call({ on: 'coord:handoff' });
    expect(out.rules.map((r: { id: string }) => r.id)).toEqual(['r1', 'r2']);
    expect(out.ruleCount).toBe(2);
  });

  // WI-6554700010017990: the guidance said "there is no runtime add-a-rule tool" for days after
  // rules:create/test/enable landed (agent-tools/rules/lifecycle.ts), steering agents away from the
  // real authoring path. Pin the guidance to the tool's existence so the two cannot drift apart again.
  it('notWhen names rules:create while that tool is defined, and never denies runtime rule authoring', () => {
    const lifecycle = readFileSync(fileURLToPath(new URL('../rules/lifecycle.ts', import.meta.url)), 'utf8');
    const notWhen = (graph as unknown as { guidance: { notWhen: string } }).guidance.notWhen;
    expect(lifecycle).toMatch(/name: 'rules:create'/);
    expect(notWhen).toContain('rules:create');
    expect(notWhen).not.toMatch(/no runtime "add a rule" tool/);
  });
});
