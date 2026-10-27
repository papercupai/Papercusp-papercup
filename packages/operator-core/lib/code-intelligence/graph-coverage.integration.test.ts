import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import graphQuery from '../agent-tools/gitnexus/query';
import * as contracts from './contracts';
import type { CodeIntelAnswer } from './contracts';
import { gitnexusFacade } from './gitnexus-facade';

function response(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}
const health = response({ repositories: [{
  name: 'papercusp', indexedAt: '2026-09-14T13:00:00.000Z',
  lastCommit: 'e4400622e1721fb0b72514bcf4479dc2f1726231',
  staleness: { commitsBehind: 0 },
}] });
const dispatch = async (name: string) =>
  name.endsWith('list_repos') ? health : response({ status: 'not_found' });

function assertMiss(answer: CodeIntelAnswer) {
  expect(answer.sites).toEqual([]);
  expect(answer.freshness.health).toBe('healthy');
  expect(answer.coverage?.sourceCompleteness).toBe('unverified');
  expect(answer.error).toContain('source existence is unverified');
}

// graph:query answers symbol/callers/callees/impact from the native first-party
// backend (gitnexus-deterministic-integration D-065), so those ops no longer reach
// the GitNexus plane through the registered handler. The facade is still the seam
// selective-assist, engine comparison and dream capability packets query, so its
// evidence-scope contract is asserted at the facade itself; the handler keeps one
// facade-routed op (`health`) whose per-call dispatcher wiring is asserted below.
describe('GitNexus facade preserves evidence scope', () => {
  it('propagates a fresh-index miss without turning it into source absence', async () => {
    assertMiss(await gitnexusFacade('symbol', { name: 'claimNextIssueWorkItem', repo: 'papercusp' }, dispatch));
  });

  it('reports ambiguity and backend failure distinctly', async () => {
    for (const body of [{ status: 'ambiguous' }, { error: 'database unavailable' }]) {
      const answer = await gitnexusFacade(
        'symbol',
        { name: 'helper', repo: 'papercusp' },
        async (name: string) => name.endsWith('list_repos') ? health : response(body),
      );
      expect(answer.coverage?.sourceCompleteness).toBe('unverified');
      expect(answer.error).toContain('status' in body ? 'ambiguous' : 'database unavailable');
    }
  });

  it('the registered handler reaches the facade only through its per-call, namespaced dispatcher', async () => {
    const calls: string[] = [];
    const result = await graphQuery.handler(
      { op: 'health', repo: 'papercusp' } as never,
      { dispatchTool: async (name: string) => { calls.push(name); return health; } } as never,
    ) as { data: CodeIntelAnswer };
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((name) => name.startsWith('gitnexus.'))).toBe(true);
    expect(result.data.freshness.health).toBe('healthy');
  });

  it('the same absence oracle kills a completeness mutation in an isolated module', async () => {
    const source = readFileSync(new URL('./gitnexus-facade.ts', import.meta.url), 'utf8');
    const target = "sourceCompleteness: 'unverified'";
    expect(source.split(target)).toHaveLength(2);
    const module = { exports: {} as any };
    const transformed = transformSync(source.replace(target, "sourceCompleteness: 'complete'"), {
      loader: 'ts', format: 'cjs',
    }).code;
    runInNewContext(transformed, {
      module, exports: module.exports,
      // The facade's only dependencies: the shared contracts, and the home-harness
      // slug it defaults `repo` to. Anything else would break the isolation this
      // mutation relies on, so an unknown import still fails loudly.
      require: (name: string) => {
        if (name === './contracts') return contracts;
        if (name === '../harness/operator-home-harness') return { operatorHomeHarnessSlug: () => 'papercusp' };
        throw new Error(`unexpected dependency ${name}`);
      },
    });
    const answer = await module.exports.gitnexusFacade('symbol', { name: 'claimNextIssueWorkItem' }, dispatch);
    expect(() => assertMiss(answer)).toThrow();
  });
});
