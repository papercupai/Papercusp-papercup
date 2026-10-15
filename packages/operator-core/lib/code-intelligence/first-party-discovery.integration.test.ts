import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
import graphQuery from '../agent-tools/gitnexus/query';
import type { CodeIntelAnswer } from './contracts';
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'native-discovery-handler-'));
  writeFileSync(join(root, 'main.ts'), 'export function invoicePayment() { return "invoice payment"; }\nexport function checkout() { return invoicePayment(); }\nexport function other() { return "garden watering"; }\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function run(op: string, name?: string) {
  return (await graphQuery.handler(graphQuery.args.parse({ op, name, paths: ['main.ts'] }),
    { projectDir: root } as never) as { data: CodeIntelAnswer }).data;
}
describe('P020 admitted graph interface and actual compiler worker', () => {
  it('keeps positive retrieval and nonsense absence source-bound across the worker/handler boundary', async () => {
    const result = await run('concept-search', 'invoice payment');
    expect(result.error).toBeNull(); expect(result.backend).toBe('typescript-service');
    expect(result.discovery!.knowledge).toBe('inferred');
    expect(result.discovery!.matches[0]).toMatchObject({ evidence: 'retrieval', symbol: { site: { name: 'invoicePayment' } } });
    expect(result.discovery!.matches[0]!.symbol.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const absent = await run('concept-search', 'zyxquantum unicornflux');
    expect(absent.error).toBeNull(); expect(absent.discovery!.outcome).toBe('not-found-in-scope'); expect(absent.sites).toEqual([]);
  }, 90_000);
  it('exposes groups and per-hop flows through the same query and refuses stale selector assumptions', async () => {
    const groups = await run('communities'); expect(groups.error).toBeNull();
    expect(groups.discovery!.groups.map(group => group.members.map(member => member.site.name).sort()))
      .toEqual(expect.arrayContaining([['checkout', 'invoicePayment'], ['other']]));
    const flows = await run('flows'); expect(flows.error).toBeNull();
    expect(flows.discovery!.flows.map(flow => flow.nodes.map(node => node.site.name)))
      .toContainEqual(['checkout', 'invoicePayment']);
    const refused = (await graphQuery.handler(graphQuery.args.parse({ op: 'communities', paths: ['main.ts'], repo: 'stale-index' }),
      { projectDir: root } as never) as { data: CodeIntelAnswer }).data;
    expect(refused.error).toContain('unsupported'); expect(refused.discovery).toBeUndefined();
  }, 90_000);

  it.each([
    ['public entry', 'module[name]()'],
    ['reflection', 'Reflect.get(module, name)()'],
    ['plugin registry', 'new Map([[name, module[name]]]).get(name)()'],
    ['generated consumer', 'Function("module", "name", "return module[name]()")(module, name)'],
  ])('preserves uncertainty for a zero-incoming export used by a %s', async (_kind, invocation) => {
    const project = mkdtempSync(join(tmpdir(), 'native-dynamic-entry-'));
    try {
      const entry = join(project, 'entry.mjs');
      writeFileSync(entry, 'export function publicEntry() { return "DYNAMIC_ENTRY_USED"; }\n');
      // The consumer deliberately sits outside the requested source scope.
      // Static absence in entry.mjs cannot establish whole-program dead code.
      const consumer = join(project, 'consumer.mjs');
      writeFileSync(consumer, `const module = await import(${JSON.stringify(pathToFileURL(entry).href)});\n`
        + `const name = "public" + "Entry";\nconsole.log(${invocation});\n`);
      const executed = spawnSync(process.execPath, [consumer], { encoding: 'utf8', timeout: 10_000 });
      expect(executed.status, executed.stderr).toBe(0);
      expect(executed.stdout.trim()).toBe('DYNAMIC_ENTRY_USED');

      const answer = (await graphQuery.handler(graphQuery.args.parse({ op: 'flows', paths: ['entry.mjs'] }),
        { projectDir: project } as never) as { data: CodeIntelAnswer }).data;
      expect(answer.error).toBeNull();
      expect(answer.discovery!.knowledge).toBe('inferred');
      expect(answer.discovery!.flows).toContainEqual(expect.objectContaining({
        entry: expect.objectContaining({ site: expect.objectContaining({ name: 'publicEntry' }) }),
        runtimeExecution: 'unknown',
      }));
      expect(answer.evidence!.graphScope.sourceCompleteness).toBe('unverified');
      expect(answer.evidence!.graphScope.limitations.join(' ')).toMatch(/external, dynamic and callback bindings.*unmeasured/);
      expect(answer.evidence!.sourceScope.supportingFiles.some(file => file.path === 'consumer.mjs')).toBe(false);
      expect(JSON.stringify(answer)).not.toMatch(/safelyRemovable|safe-to-remove/);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 90_000);
});
