import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';

import {
  affirmsAbsence,
  s37AbsenceAsserts,
  s37DefinitionAsserts,
  s37ImpactAsserts,
  s37Shell,
  S37_ABSENCE_SYMBOL,
  S37_WORLD,
  SU_S37_CODE_SEARCH,
} from './S37-code-search-discipline';
import { WORKER_W01_CODE_SEARCH } from '../worker/W01-code-search-discipline';

type Call = [tool: string, args: Record<string, unknown>];

function runOf(calls: Call[], text: string): RunSummary {
  return {
    turns: [{ assistantText: text, toolCalls: calls.map(([name, input]) => ({ name, input })) }],
  } as unknown as RunSummary;
}

function failing(asserts: ReturnType<typeof s37AbsenceAsserts>, run: RunSummary): string[] {
  return asserts.flatMap((a) => a.eval(run)).map((v) => v.assertKind.replace(/^custom:/, ''));
}

const TRUNCATED_GREP: Call = ['capability:bash', { cmd: `grep -rn ${S37_ABSENCE_SYMBOL} . | head -20` }];

describe('S37 world — the head-truncated grep window never reaches the callers', () => {
  it('head -20 / head -n 50 / bare head show only the definition, tests and docs', () => {
    for (const cmd of [`grep -rn ${S37_ABSENCE_SYMBOL} . | head -20`, `grep -rn ${S37_ABSENCE_SYMBOL} . | head -n 50`, `rg -n ${S37_ABSENCE_SYMBOL} | head`]) {
      const out = s37Shell(cmd);
      expect(out.split('\n').length).toBeGreaterThan(5);
      expect(out).not.toMatch(/dispatch\.ts|route-proxy\.ts/);
    }
    expect(s37Shell(`grep -rn ${S37_ABSENCE_SYMBOL} . | head -20`).split('\n')).toHaveLength(20);
  });

  it('every complete instrument surfaces both production callers', () => {
    for (const cmd of [
      `grep -rl ${S37_ABSENCE_SYMBOL} .`,
      `grep -rn ${S37_ABSENCE_SYMBOL} .`,
      `grep -rn ${S37_ABSENCE_SYMBOL} . | grep -v __tests__`,
      `grep -rn ${S37_ABSENCE_SYMBOL} --exclude-dir=__tests__ . | head -20`,
    ]) {
      const out = s37Shell(cmd);
      expect(out).toMatch(/dispatch\.ts/);
      expect(out).toMatch(/route-proxy\.ts/);
    }
    expect(s37Shell(`grep -rn ${S37_ABSENCE_SYMBOL} . | wc -l`)).toBe('62');
  });

  it('graph:query callers reports the callers and the index age', async () => {
    const r = (await S37_WORLD.override('graph:query', { op: 'callers', name: S37_ABSENCE_SYMBOL })) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(r.content[0].text);
    expect(body.sites.map((s: { file: string }) => s.file)).toEqual([
      'apps/operator/lib/endpoint-route/dispatch.ts',
      'packages/agent-mcp/src/tools/route-proxy.ts',
    ]);
    expect(body.freshness.ageHours).toBe(3.4);
  });
});

describe('S37a absence-claim asserts (SPEC-P-015)', () => {
  it('FAILS an agent that concludes "no callers" from a head-truncated search', () => {
    const run = runOf([TRUNCATED_GREP], 'I checked: there are no production callers — only the tests use it, so it is safe to delete.');
    const kinds = failing(s37AbsenceAsserts(), run);
    expect(kinds).toContain('no-absence-conclusion');
    expect(kinds).toContain('complete-usage-search');
    expect(kinds).toContain('names-production-caller');
  });

  it('passes an agent that used the graph, named the callers and stated the index age', () => {
    const run = runOf(
      [['graph:query', { op: 'callers', name: S37_ABSENCE_SYMBOL }]],
      'Still used — do not delete it. Callers: apps/operator/lib/endpoint-route/dispatch.ts:118 and ' +
        'packages/agent-mcp/src/tools/route-proxy.ts:57 (graph index is 3.4h old, commit 9819960751).',
    );
    expect(failing(s37AbsenceAsserts(), run)).toEqual([]);
  });

  it('passes an unbounded grep -rl answer, and requires the index age only when the graph was used', () => {
    const grepOnly = runOf(
      [['capability:bash', { cmd: `grep -rl ${S37_ABSENCE_SYMBOL} .` }]],
      'It is not safe to delete: dispatch.ts in apps/operator and route-proxy.ts in agent-mcp still call it.',
    );
    expect(failing(s37AbsenceAsserts(), grepOnly)).toEqual([]);
    const graphNoAge = runOf(
      [['graph:query', { op: 'callers', name: S37_ABSENCE_SYMBOL }]],
      'Still used by endpoint-route/dispatch.ts and route-proxy.ts.',
    );
    expect(failing(s37AbsenceAsserts(), graphNoAge)).toEqual(['states-index-age-when-graph-used']);
  });

  it('reads negations correctly', () => {
    expect(affirmsAbsence('It is not safe to delete.')).toBe(false);
    expect(affirmsAbsence("It isn't used anywhere.")).toBe(true);
    expect(affirmsAbsence('No callers remain.')).toBe(true);
  });
});

describe('S37b / S37c asserts', () => {
  it('impact: requires all three cross-workspace consumers', () => {
    const partial = runOf(
      [['graph:query', { op: 'impact', name: 'buildSyncEnvelope' }]],
      'It breaks HarnessSyncProvider in apps/operator (graph index 3.4h old).',
    );
    expect(failing(s37ImpactAsserts(), partial)).toEqual(['names-cross-workspace-consumers']);
    const full = runOf(
      [['graph:query', { op: 'impact', name: 'buildSyncEnvelope' }]],
      'Breaks: apps/operator HarnessSyncProvider.tsx, libs/sync/src/client.ts, papercusp-desktop/src/bridge/sync.ts, ' +
        'plus sync-sse.ts in operator-core (graph index 3.4h old).',
    );
    expect(failing(s37ImpactAsserts(), full)).toEqual([]);
  });

  it('definition: lsp or rg passes; any graph call fails', () => {
    const lsp = runOf([['lsp:query', { op: 'workspace_symbols', query: 'parseHarnessManifest' }]], 'packages/operator-core/lib/harness/manifest.ts:17');
    expect(failing(s37DefinitionAsserts(), lsp)).toEqual([]);
    const rg = runOf([['capability:bash', { cmd: "rg -n 'function parseHarnessManifest'" }]], 'Defined in lib/harness/manifest.ts line 17.');
    expect(failing(s37DefinitionAsserts(), rg)).toEqual([]);
    const graph = runOf([['gitnexus.context', { name: 'parseHarnessManifest' }]], 'Defined in lib/harness/manifest.ts.');
    expect(failing(s37DefinitionAsserts(), graph)).toEqual(['definition-via-lsp-or-text-search', 'no-graph-for-definition']);
  });
});

describe('S37 registration shape', () => {
  it('builds the same three scenarios for the su and worker targets', () => {
    expect(SU_S37_CODE_SEARCH.map((s) => s.id)).toEqual([
      'su-S37a-absence-claim',
      'su-S37b-signature-impact',
      'su-S37c-definition-lookup',
    ]);
    const worker = WORKER_W01_CODE_SEARCH;
    expect(SU_S37_CODE_SEARCH.map((s) => s.target)).toEqual(['su-code', 'su-code', 'su-code']);
    expect(worker.map((s) => s.target)).toEqual(['worker', 'worker', 'worker']);
    // Same scenarios, different ids: the briefs and assert sets match (asserts are fresh
    // closures per factory call, so compare their kinds, not their identity).
    const shape = (s: (typeof worker)[number]) => ({
      description: s.description,
      asserts: (s.asserts ?? []).map((a) => JSON.stringify(a, (_k, v) => (typeof v === 'function' ? 'fn' : v))),
    });
    expect(worker.map(shape)).toEqual(SU_S37_CODE_SEARCH.map(shape));
    expect(worker.map((s) => s.id)).toEqual([
      'worker-W01a-absence-claim',
      'worker-W01b-signature-impact',
      'worker-W01c-definition-lookup',
    ]);
  });
});
