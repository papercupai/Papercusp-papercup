/** P-012: actual safe packer + compiler, refreshed by the canonical resume reader. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
import { buildTaskBrief } from './task-brief';
import { DEFAULT_PACKER_EFFECTS, packerFacade, resolveRepomixBin } from './packer-facade';
import { firstPartyCallersOffthread, FIRST_PARTY_CALLERS_BUDGET_MS } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { readWorkItemResume } from '../agent-tools/work_items/resume';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
// Positive source/incident oracles use real, freshly captured producer results.
// Cold compiler/packer bootstrap is fixture setup; the unit suite separately
// checks the interactive brief's six-second deadline and unknown-result path.
async function captureForBrief(root: string, paths: string[], filePath: string) {
  const startedAtMs = Date.now();
  const [packed, graph] = await Promise.all([
    packerFacade('pack', { rootPath: root, include: paths, format: 'xml', compress: false }, DEFAULT_PACKER_EFFECTS),
    firstPartyCallersOffthread({ root, name: 'target', filePath, paths, op: 'callers', limit: 8,
      vendorDir: LSP_VENDOR_DIR }, { budgetMs: FIRST_PARTY_CALLERS_BUDGET_MS }),
  ]);
  expect(packed.answer.error, JSON.stringify(packed.answer)).toBeNull();
  expect(graph.error, JSON.stringify(graph)).toBeNull();
  expect(graph.evidence?.sourceScope.supportingFiles.length).toBeGreaterThan(0);
  return { packed, graph, startedAtMs, elapsedMs: Date.now() - startedAtMs };
}
describe('native P012 current scoped brief integration', () => {
  it('P018: carries recorded error references and real compiler hypotheses through canonical resume without asserting causation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-incident-brief-')); dirs.push(root);
    writeFileSync(join(root, 'a-target.ts'), 'export function target() { return "source"; }\n');
    writeFileSync(join(root, 'b-consumer.ts'), 'import { target } from "./a-target";\nexport function consumer() { return target(); }\n');
    writeFileSync(join(root, 'reference.test.ts'), 'import { target } from "./a-target";\nexport const observed = target();\n');
    const item = { id: 'WI-incident-fixture', harness: 'incident-fixture', state: 'open',
      payload: { paths: ['a-target.ts', 'b-consumer.ts', 'reference.test.ts'] } };
    const failure = { testRunId: 42, path: 'reference.test.ts', status: 'fail' as const,
      commit: 'a'.repeat(40), logSha256: 'b'.repeat(64) };
    const failures = vi.fn(async () => [failure]);
    const source = async () => {
      const captured = await captureForBrief(root, item.payload.paths, 'a-target.ts');
      return { taskBrief: await buildTaskBrief({ workspaceId: 'incident-workspace', workItem: item }, {
      root: async () => root, effects: DEFAULT_PACKER_EFFECTS, failures,
      pack: async () => captured.packed,
      graph: async () => captured.graph,
    }) };
    };
    const resumed = await readWorkItemResume(item, { checkpoint: async () => ({ checkpoint: null, updatedAtMs: null }),
      freshness: async () => undefined, evidence: async () => [], taskBrief: source });
    expect(resumed.taskBrief?.status, JSON.stringify(resumed.taskBrief)).toBe('current');
    if (!resumed.taskBrief || resumed.taskBrief.status === 'omitted') throw new Error('Expected the current source brief, not an omitted inline response.');
    expect(failures).toHaveBeenCalledWith({ workspaceId: 'incident-workspace', harness: 'incident-fixture', root,
      paths: ['reference.test.ts'] });
    expect(resumed.taskBrief.incident).toMatchObject({ status: 'measured', cause: 'unknown', runtimeExecution: 'unmeasured',
      failures: [failure], workRecord: item.id, candidates: expect.arrayContaining([
        { path: 'reference.test.ts', basis: 'failed-test', causation: 'unverified' },
        { path: 'b-consumer.ts', basis: 'static-relationship', causation: 'unverified' },
      ]) });
    expect(item.state).toBe('open');
  }, 60_000);
  it('packs only task files, reports the compiler consumer, and replaces stale excerpts on resume', async () => {
    expect(resolveRepomixBin(), 'the admitted safe packer must be provisioned').not.toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'task-brief-int-')); dirs.push(root);
    writeFileSync(join(root, 'target.ts'), 'export function target() { return "BEFORE_EDIT"; }\n');
    writeFileSync(join(root, 'consumer.ts'), 'import { target } from "./target";\nexport const result = target();\n');
    writeFileSync(join(root, 'target.test.ts'), 'import { target } from "./target";\nexport const testResult = target();\n');
    writeFileSync(join(root, 'guide.md'), 'Source-linked target.ts usage guide.\n');
    writeFileSync(join(root, 'unrelated.ts'), 'UNRELATED_SOURCE_MUST_NOT_APPEAR');
    writeFileSync(join(root, '.env'), 'TASK_PRIVATE_SECRET_MUST_NOT_APPEAR');
    const item = { id: 'WI-task-fixture', harness: 'brief-fixture', state: 'open',
      payload: { paths: ['target.ts', 'consumer.ts', 'target.test.ts', 'guide.md'] } };
    const compilerAttempts: { budgetMs: number; startedAtMs: number; elapsedMs?: number; error?: string | null }[] = [];
    const source = async () => {
      const captured = await captureForBrief(root, item.payload.paths, 'target.ts');
      compilerAttempts.push({ budgetMs: FIRST_PARTY_CALLERS_BUDGET_MS, startedAtMs: captured.startedAtMs,
        elapsedMs: captured.elapsedMs, error: captured.graph.error });
      return { taskBrief: await buildTaskBrief({ workspaceId: 'fixture-workspace', workItem: item }, {
      root: async (workspaceId, harness) => workspaceId === 'fixture-workspace' && harness === 'brief-fixture' ? root : null,
      effects: DEFAULT_PACKER_EFFECTS, pack: async () => captured.packed,
      graph: async () => captured.graph,
    }) };
    };
    const deps = { checkpoint: async () => ({ checkpoint: null, updatedAtMs: null }),
      freshness: async () => undefined, evidence: async () => [], taskBrief: source };
    const first = await readWorkItemResume(item, deps);
    expect(first.taskBrief?.status, JSON.stringify(first.taskBrief)).toBe('current');
    const measurement = () => JSON.stringify({ brief: first.taskBrief, compilerAttempts,
      elapsedSinceStartMs: compilerAttempts.map(attempt => Date.now() - attempt.startedAtMs) });
    expect(first.taskBrief, measurement()).toHaveProperty('graph.status', 'measured');
    expect(first.taskBrief, measurement()).toHaveProperty('graph.consumers', expect.arrayContaining(['consumer.ts:2']));
    expect(first.taskBrief).toHaveProperty('files', expect.arrayContaining([
      expect.objectContaining({ path: 'guide.md', kind: 'doc' }), expect.objectContaining({ path: 'target.test.ts', kind: 'test' }),
    ]));
    expect(JSON.stringify(first.taskBrief)).toContain('BEFORE_EDIT');
    expect(JSON.stringify(first)).not.toMatch(/UNRELATED_SOURCE|TASK_PRIVATE_SECRET/);
    writeFileSync(join(root, 'target.ts'), 'export function target() { return "AFTER_EDIT"; }\n');
    const resumed = await readWorkItemResume(item, deps);
    expect(resumed.taskBrief?.status, JSON.stringify(resumed.taskBrief)).toBe('current');
    expect(resumed.taskBrief).not.toHaveProperty('sourceFingerprint', (first.taskBrief as any).sourceFingerprint);
    expect(JSON.stringify(resumed.taskBrief)).toContain('AFTER_EDIT');
    expect(JSON.stringify(resumed.taskBrief)).not.toContain('BEFORE_EDIT');
  }, 60_000);
});
