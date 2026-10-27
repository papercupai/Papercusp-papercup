import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
// The parser is a host-provisioned tool; test state/DB HOME remains workspace isolated.
vi.mock('@papercusp/host-platform/home', async original => {
  const actual = await original<typeof import('@papercusp/host-platform/home')>();
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  return { ...actual, papercuspPath: (...parts: string[]) => join(homedir(), '.papercusp', ...parts) };
});
import { AGENT_ANTIPATTERN_RULES, agentAntipatterns, antipatternHash } from './agent-antipatterns';
import { codeIntelPushText, formatPushFact, snapshotAntipatternLeg, type PushFact, type PushInput } from './push-channel';
import { parsePushSnapshot } from './push-snapshot';
import structuralTool from '../agent-tools/lsp/astgrep';
import { collectAntipatternEdits } from '../../../../apps/operator/scripts/hooks/inject/core.mjs';

// Maintained syntax population: one positive and negative for every declared R8 id.
const fixtures = [
  ['error-empty-catch', 'try { work(); } catch (e) {}', 'try { work(); } catch (e) { throw e; }'],
  ['error-log-only-catch', 'try { work(); } catch (e) { console.error(e); }', 'try { work(); } catch (e) { console.error(e); throw e; }'],
  ['db-read-fallback', 'const count = db.readCount() ?? 0;', 'const count = configuredCount ?? 0;'],
  ['unsafe-as-any', 'const value = input as any;', 'const value = input as unknown;'],
  ['newly-skipped-test', 'test.skip("case", () => {});', 'test("case", () => {});'],
  ['widened-test-timeout', 'test.setTimeout(2000);', 'test.setTimeout(500);'],
  ['sync-io-in-async', 'async function serve() { fs.readFileSync("data"); }', 'function bootstrap() { fs.readFileSync("data"); }'],
  ['await-in-serial-loop', 'async function load() { for (const f of files) { await fs.readFile(f); } }', 'async function load() { await fs.readFile(file); }'],
  ['unbounded-promise-all', 'await Promise.all(items.map(load));', 'await limiter.map(items, load);'],
  ['full-table-read-filter', 'const rows = (await db.selectFrom("users").selectAll().execute()).filter(active);', 'const rows = await db.selectFrom("users").selectAll().where("active", "=", true).execute();'],
] as const;

describe('R8 maintained ast-grep rule population', () => {
  it('keeps every named rule represented by a positive and negative fixture', () => {
    expect(fixtures.map(([id]) => id)).toEqual(AGENT_ANTIPATTERN_RULES.map(rule => rule.id));
  });
  it.each(fixtures)('%s matches its positive and rejects its negative', async (id, positive, negative) => {
    const before = id === 'widened-test-timeout' ? 'test.setTimeout(1000);' : '';
    const yes = await agentAntipatterns(before, positive);
    const no = await agentAntipatterns(before, negative);
    expect(yes.status, yes.error).toBe('measured');
    expect(no.status, no.error).toBe('measured');
    expect(yes.hits.some(hit => hit.ruleId === id)).toBe(true);
    expect(no.hits.some(hit => hit.ruleId === id)).toBe(false);
  });
  it('does not warn for unchanged historical findings or whitespace-only changes', async () => {
    for (const [, positive] of fixtures) {
      const result = await agentAntipatterns(positive, '\n' + positive);
      expect(result.status, result.error).toBe('measured');
      expect(result.hits).toEqual([]);
    }
  });
  it('requires before evidence for skipped tests and increased timeout', async () => {
    for (const after of ['test.skip("case", () => {});', 'test.setTimeout(2000);']) {
      expect((await agentAntipatterns(null, after)).hits).toEqual([]);
    }
    expect((await agentAntipatterns('test("case", () => {});', 'test.skip("case", () => {});')).hits[0].ruleId).toBe('newly-skipped-test');
  });
  it('ignores comments and strings, accepts TSX, and records exact source hashes', async () => {
    const after = '// input as any\nconst text = "test.skip(\"x\")";\nconst el = <div />;';
    const result = await agentAntipatterns('', after, 'tsx');
    expect(result.status, result.error).toBe('measured');
    expect(result.hits).toEqual([]);
    expect(result.sha256).toBe(antipatternHash(after));
    expect(result.beforeSha256).toBe(antipatternHash(''));
  });
  it('reports unknown for oversized source instead of claiming a clean scan', async () => {
    expect(await agentAntipatterns('', 'x'.repeat(100_001))).toMatchObject({ status: 'unknown', hits: [] });
  });
  it('is reachable through code:structural without a new tool', async () => {
    const result = await structuralTool.handler({ op: 'agent_antipatterns', language: 'ts', before: '', source: 'input as any', rootPath: '/unused' }, {} as never);
    expect(result).toMatchObject({ data: { status: 'measured', hits: [{ ruleId: 'unsafe-as-any' }] } });
  });
});

const snapshot = () => {
  const result = parsePushSnapshot(JSON.stringify({ schema: 'graph-dependency-snapshot-v1', index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) }, generatedAt: new Date().toISOString(),
    edges: [{ importer: 'consumer.ts', imported: 'file.ts', importerSha256: 'c'.repeat(64) }] }));
  expect(result).not.toBeNull();
  return result!;
};
const edit = { path: 'file.ts', sha256: 'b'.repeat(64), status: 'measured', hits: AGENT_ANTIPATTERN_RULES.map(rule => ({ ruleId: rule.id, line1: 1 })) };
const input = (tool = 'Edit'): PushInput => ({ owner: 'agent', workspace: 'ws', calls: [{ tool, antipatternEdits: [edit, edit] }] });
describe('R8 bounded advisory delivery', () => {
  it.each(['Edit', 'Write', 'MultiEdit', 'apply_patch'])('%s aggregates/deduplicates prepared hits within three lines', tool => {
    const facts = snapshotAntipatternLeg(input(tool));
    expect(facts).toHaveLength(1);
    expect(formatPushFact(facts[0], snapshot()).split('\n')).toHaveLength(3);
    expect(facts[0].sourceHashes).toEqual(Array(3).fill({ path: 'file.ts', sha256: edit.sha256 }));
  });
  it('is silent for no hit, unknown, reads and malformed prepared findings', () => {
    expect(snapshotAntipatternLeg(input('Read'))).toEqual([]);
    for (const patch of [{ hits: [] }, { status: 'unknown' }, { sha256: 'invalid' }, { path: '../escape.ts' }]) {
      expect(snapshotAntipatternLeg({ ...input(), calls: [{ tool: 'Edit', antipatternEdits: [{ ...edit, ...patch }] }] })).toEqual([]);
    }
  });
  it('prepares native batch paths once and keeps scanner failure advisory', async () => {
    const prepare = vi.fn(async () => edit);
    const path = 'packages/operator-core/lib/code-intelligence/agent-antipatterns.ts';
    const body = { cwd: process.cwd(), toolCalls: ['Edit', 'Write', 'MultiEdit'].map(tool => ({ tool, editedPaths: [path] })) };
    await collectAntipatternEdits(body, prepare);
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(collectAntipatternEdits(body, async () => { throw new Error('parser unavailable'); })).resolves.toBeUndefined();
  });
  it('uses the existing push commit/issued boundary; no-match never commits', async () => {
    const commit = vi.fn(async (_input, _snapshot, facts) => facts.map((fact: PushFact) => fact.text).join('\n'));
    const deps = { snapshot: async () => snapshot(), enabled: async () => true,
      legs: () => new Map([['antipattern' as const, snapshotAntipatternLeg]]), commit };
    // Source corroboration deliberately fails for a missing root, withholding stale evidence.
    expect(await codeIntelPushText(input(), deps)).toBe('');
    expect(commit).not.toHaveBeenCalled();
    expect(await codeIntelPushText({ ...input(), calls: [{ tool: 'Edit', antipatternEdits: [] }] }, deps)).toBe('');
    expect(commit).not.toHaveBeenCalled();
  });
  it('corroborates a prepared blob and passes one bounded advisory to the issued ledger writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-antipatterns-'));
    const source = 'const x = input as any;';
    await writeFile(join(root, 'file.ts'), source);
    const commit = vi.fn(async (_input, _snapshot, facts) => facts.map((fact: PushFact) => formatPushFact(fact, _snapshot)).join('\n'));
    const deps = { snapshot: async () => snapshot(), enabled: async () => true,
      legs: () => new Map([['antipattern' as const, snapshotAntipatternLeg]]), commit };
    const measured = { ...input(), root, calls: [{ tool: 'Edit', antipatternEdits: [{ ...edit, sha256: antipatternHash(source) }] }] };
    try {
      const text = await codeIntelPushText(measured, deps);
      expect(text.split('\n')).toHaveLength(3);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0][2][0].leg).toBe('antipattern');
      await writeFile(join(root, 'file.ts'), 'changed by another edit');
      expect(await codeIntelPushText(measured, deps)).toBe('');
      expect(commit).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
