import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const corpus = () => read('packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md');
const rows = (text: string) => text.split('\n').filter(line => line.startsWith('| '))
  .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));

// Resolve the documented public calls in their defining modules, and retain
// existing hand-built examples rather than hypothetical reasons for a new system.
const systems = [
  ['Compare facts (rules)', 'evaluateOperatorTest', 'libs/generic/rules/src/compile.ts', 'switch (op)'],
  ['React on the server (declarative events)', 'registerReactionRule', 'packages/operator-core/lib/events/registry.ts', 'EventEmitter'],
  ['Show changing UI data (sync)', 'useSyncQuery', 'libs/generic/sync/src/SyncContext.ts', 'fetch timer'],
  ['Fuse ranked results', 'rrfCombine', 'libs/generic/rrf/src/index.ts', 'reciprocal-rank'],
  ['Cache reads', 'createCache', 'libs/generic/cache/src/index.ts', 'Map plus expiry'],
  ['Order dependent work', 'orderByDependencies', 'libs/generic/dependency-order/src/index.ts', 'topological sort'],
  ['Judge session liveness', 'resolveSessionStates', 'packages/operator-core/lib/agent-tools/coordination/liveness-oracle.ts', 'dead/alive guess'],
] as const;

describe('shared systems guide contract', () => {
  it('rules events reuse R-63 verifies every shared-system guide row against an existing call and real example', () => {
    const table = rows(corpus());
    for (const [job, call, source, avoid] of systems) {
      const matches = table.filter(row => row[0] === job);
      expect(matches, job).toHaveLength(1);
      expect(matches[0][1], job).toContain(call);
      expect(matches[0][2], job).toContain(avoid);
      expect(read(source), source).toMatch(new RegExp('export\\s+(?:async\\s+)?(?:function|class)\\s+' + call + '\\b'));
    }
    // This surviving boundary example is outside the admission/watch migrations.
    expect(read('packages/operator-core/lib/endpoint-route/routes/dev/table-rows.ts')).toContain('switch');
    expect(read('packages/operator-core/lib/sync/hyperbee/schema-version.ts')).toContain('new EventEmitter()');
    expect(read('docs/evidence/rules-events-reuse-2026-10-28-ui-candidates-before.json')).toContain('setInterval');
    const memoryFusion = read('libs/generic/memory/src/hybrid-fusion.ts');
    expect(memoryFusion).toContain('export function fuse(');
    expect(memoryFusion).toContain('k +');
    expect(read('libs/generic/memory/src/backend.ts')).toContain('"rrf"');
    const ttlMap = read('packages/operator-core/lib/authority/remote-peers-cache.ts');
    expect(ttlMap).toContain('new Map');
    expect(ttlMap).toContain('cached.expiresAt > now');
    expect(ttlMap).toContain('_cache.set(');
    expect(read('packages/operator-core/lib/agent-tools/coordination/recipient-liveness.ts')).toContain('sessionState');
  });

  it('rules events reuse R-64 distinguishes declarative server reactions from UI sync subscriptions', () => {
    const text = corpus();
    const table = rows(text);
    const server = table.find(row => row[0] === systems[1][0])!;
    const ui = table.find(row => row[0] === systems[2][0])!;
    expect(server[1]).toContain('emitSystemEvent');
    expect(server[1]).toContain('registerReactionRule');
    expect(server[1]).not.toContain('useSyncQuery');
    expect(ui[1]).toContain('useSyncQuery');
    expect(ui[1]).toContain('notifySyncInvalidate');
    expect(ui[1]).not.toContain('registerReactionRule');
    expect(text).toContain('Server work triggered by a change uses declarative events; changing UI reads use sync.');
    expect(text).toContain('its invalidation does not execute server work');
    expect(read('packages/operator-core/lib/events/engine.ts')).toMatch(/export (?:async )?function emitSystemEvent/);
    expect(read('packages/operator-core/lib/sync-sse.ts')).toContain('export const notifySyncInvalidate');
  });
});
