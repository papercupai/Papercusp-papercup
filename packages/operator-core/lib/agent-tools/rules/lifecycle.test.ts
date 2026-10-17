import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/db-org', async original => ({ ...await original<object>(), withWorkspace: vi.fn(async (_ws, fn) => fn({})) }));
vi.mock('../coordination/identity', async original => ({ ...await original<object>(), resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'ws', ownerId: 'author' })) }));
vi.mock('../../memory/hive-scope', async original => ({ ...await original<object>(), resolvePotSlugsForHarnesses: vi.fn(async () => ['pot']) }));
vi.mock('../../events/class-fire-target', async original => ({ ...await original<object>(), validateClassFireTarget: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../events/registry', async original => ({ ...await original<object>(), listReactionRules: vi.fn(() => [
  { id: 'built', source: 'builtin', on: 'demo:done', fire: 'event:done' },
  { id: 'plugin', source: 'plugin:demo', on: 'demo:done', fire: 'demo:send' },
  { id: 'standalone:local:other-tenant', source: 'standalone:local:other-tenant', on: 'secret', fire: 'secret' },
]) }));
vi.mock('../../cupboard/self-describing-store', async original => ({ ...await original<object>(), enumerateSelfDescribingDirs: vi.fn(() => [{ id: 'package', ref: 'demo/package', delivery: 'sync' }]) }));
vi.mock('../../cupboard/rule-store', async importOriginal => ({ ...await importOriginal<object>(), ruleRoots: vi.fn(() => []) }));
vi.mock('../../events/local-rule-store', async importOriginal => ({
  ...await importOriginal<object>(), getLocalRule: vi.fn(), listLocalRules: vi.fn(async () => []),
  putLocalRule: vi.fn(async input => ({ ...input, enabled: false, revision: 1 })),
  setLocalRuleEnabled: vi.fn(), deleteLocalRule: vi.fn(async () => true), recordLocalRuleTest: vi.fn(),
}));
vi.mock('../../events/authored-rule-test', () => ({ readRuleReplaySamples: vi.fn(), replayRule: vi.fn() }));
import * as lifecycle from './lifecycle';
import { putLocalRule, getLocalRule, listLocalRules, setLocalRuleEnabled, recordLocalRuleTest, type LocalAuthoredRule } from '../../events/local-rule-store';
import { readRuleReplaySamples, replayRule } from '../../events/authored-rule-test';
import { validateClassFireTarget } from '../../events/class-fire-target';
const definition: LocalAuthoredRule['definition'] = { id: 'demo', title: 'Demo', description: 'Fixture', version: '1.0.0',
  delivery: 'async', on: 'demo:done', fire: 'class:demo.notify@1.0.0#send' };
function authoredRule(overrides: Partial<LocalAuthoredRule> = {}): LocalAuthoredRule {
  return { workspaceId: 'ws', potSlug: 'pot', id: 'demo', authorId: 'author', revision: 7,
    enabled: false, testedRevision: null, testReceipt: null, definition, ...overrides };
}
const ctx = { workspaceId: 'ws', harnessSlug: 'harness' };
async function call(tool: { handler: Function }, args: Record<string, unknown>) {
  const out = await tool.handler(args, ctx);
  return out.data ?? JSON.parse(out.content[0].text);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateClassFireTarget).mockResolvedValue({ ok: true,
    target: { classRef: 'demo.notify@1.0.0', classId: 'demo.notify', classVersion: '1.0.0', verb: 'send' }, capability: 'demo.notify' });
  vi.mocked(getLocalRule).mockResolvedValue(authoredRule());
  vi.mocked(readRuleReplaySamples).mockResolvedValue([{ id: 'tool:1', tool: 'demo:done', args: {}, ok: true, source: 'tool-ledger' }]);
  vi.mocked(replayRule).mockReturnValue([{ id: 'tool:1', tool: 'demo:done', matched: true, action: 'fire' }]);
});
describe('agent rule lifecycle', () => {
  it('rejects proof from fixtures that did not reach the rule trigger', async () => {
    vi.mocked(readRuleReplaySamples).mockResolvedValueOnce([]);
    vi.mocked(replayRule).mockReturnValueOnce([{ id: 'fixture:0', tool: 'other', eligible: false, matched: false, action: 'none' }]);
    const out = await call(lifecycle.testRuleTool, { scope: 'workspace', id: 'demo', limit: 2, fixtures: [{ tool: 'other', ok: true }] });
    expect(out.passed).toBe(false);
    expect(recordLocalRuleTest).toHaveBeenCalledWith(expect.anything(), 'demo', 7, expect.objectContaining({ passed: false }), expect.anything());
  });

  it('validates before create and binds authorship and resolved pot scope', async () => {
    await call(lifecycle.createRuleTool, { definition, scope: 'pot', expectedRevision: 6 });
    expect(putLocalRule).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws', potSlug: 'pot', authorId: 'author', expectedRevision: 6 }), expect.anything());
    expect(vi.mocked(validateClassFireTarget).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(putLocalRule).mock.invocationCallOrder[0]);
  });
  it('refuses invalid grammar, nonexistent classes and recovery-blocking guards before storage', async () => {
    await expect(call(lifecycle.createRuleTool, { scope: 'workspace', definition: { ...definition, fire: 'capability:bash' } })).rejects.toThrow('invalid_rule');
    await expect(call(lifecycle.createRuleTool, { scope: 'workspace', definition: { id: 'g', title: 'Guard', description: 'Guard', version: '1',
      delivery: 'sync', sink: 'pre-tool', guard: { deny: {} } } })).rejects.toThrow('rule_lockout');
    vi.mocked(validateClassFireTarget).mockResolvedValueOnce({ ok: false, error: 'class_missing' });
    await expect(call(lifecycle.createRuleTool, { scope: 'workspace', definition })).rejects.toThrow('class_missing');
    expect(putLocalRule).not.toHaveBeenCalled();
  });
  it('lists the four sources and excludes local registrations from other tenant rows', async () => {
    vi.mocked(listLocalRules).mockResolvedValueOnce([authoredRule({ id: 'mine' })]);
    const out = await call(lifecycle.listRulesTool, { scope: 'workspace', limit: 20 });
    expect(out.rules.map((r: { source: string }) => r.source).sort()).toEqual(['builtin', 'cupboard', 'local', 'plugin']);
    expect(JSON.stringify(out)).not.toContain('other-tenant');
  });
  it('preserves untested-enable refusal and always allows disable without replay', async () => {
    vi.mocked(setLocalRuleEnabled).mockRejectedValueOnce(new Error('rule_missing_or_untested_revision'));
    await expect(call(lifecycle.enableRuleTool, { scope: 'pot', id: 'demo' })).rejects.toThrow('untested');
    vi.mocked(setLocalRuleEnabled).mockResolvedValueOnce(authoredRule({ enabled: false }));
    await call(lifecycle.disableRuleTool, { scope: 'pot', id: 'demo' });
    expect(setLocalRuleEnabled).toHaveBeenLastCalledWith({ workspaceId: 'ws', potSlug: 'pot' }, 'demo', false, expect.anything());
  });
  it('records passing evidence only for the revision actually replayed', async () => {
    await call(lifecycle.testRuleTool, { scope: 'pot', id: 'demo', limit: 9 });
    expect(recordLocalRuleTest).toHaveBeenCalledWith({ workspaceId: 'ws', potSlug: 'pot' }, 'demo', 7,
      expect.objectContaining({ passed: true, samples: 1, sampleRefs: ['tool:1'] }), expect.anything());
  });
  it('empty or incomplete history cannot produce passing enablement proof', async () => {
    vi.mocked(readRuleReplaySamples).mockResolvedValueOnce([]);
    vi.mocked(replayRule).mockReturnValueOnce([]);
    expect((await call(lifecycle.testRuleTool, { scope: 'workspace', id: 'demo', limit: 2 })).passed).toBe(false);
    expect(recordLocalRuleTest).not.toHaveBeenCalled();
    vi.mocked(replayRule).mockReturnValueOnce([{ id: 'tool:1', tool: 'demo:done', matched: false, action: 'unknown' }]);
    expect((await call(lifecycle.testRuleTool, { scope: 'workspace', id: 'demo', limit: 2 })).passed).toBe(false);
    expect(recordLocalRuleTest).toHaveBeenCalledWith(expect.anything(), 'demo', 7, expect.objectContaining({ passed: false }), expect.anything());
  });
  it('draft tests write no proof and rejects ambiguous or oversized replay requests', async () => {
    await call(lifecycle.testRuleTool, { scope: 'workspace', definition, limit: 2 });
    expect(recordLocalRuleTest).not.toHaveBeenCalled();
    expect(lifecycle.testRuleTool.args.safeParse({ id: 'demo', definition }).success).toBe(false);
    expect(lifecycle.testRuleTool.args.safeParse({ id: 'demo', limit: 201 }).success).toBe(false);
    expect(lifecycle.createRuleTool.guidance?.chaining).toContain('rules:test');
  });
});
