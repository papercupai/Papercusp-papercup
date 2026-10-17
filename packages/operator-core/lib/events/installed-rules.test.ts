/** Install → production package resolver → worn rule execution (P-001). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: vi.fn(async () => []) }),
}));

import { installRuleFromCupboardCore } from '../cupboard/install-rule-core';
import { resolveLocalBlueprintPackage } from '../blueprint/compile-packages';
import { _resetPapercuspRootForTests } from '../papercusp-root';
import { evaluatePreToolGuards, evaluateHookContextSink, memoryHookTurnStore, readAppliedWornRules, wornRulePins, wornSyncRules } from '../agent-identities/sync-hook-rules';
import { identityRuleSubscriberId, readIdentityWearer, type IdentityWearer } from '../agent-identities/identity-async-rules';
import { executeIdentityReaction, planIdentityReactions, type IdentityReactionDeps } from './identity-reaction';
import { listReactionRules } from './registry';

let root: string;
let priorHome: string | undefined;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'installed-rule-execution-'));
  priorHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = root;
  _resetPapercuspRootForTests();
});
afterEach(async () => {
  if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = priorHome;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
});

async function install(id: string, definition: Record<string, unknown>) {
  const registeredBefore = listReactionRules().map(rule => rule.id).sort();
  const repo = join(root, 'mirror');
  const dir = join(repo, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'rule.json'), JSON.stringify({ schemaVersion: 1, id, title: id,
    description: 'Execution regression fixture', version: '1.0.0', ...definition }));
  await fs.writeFile(join(dir, 'listing.json'), JSON.stringify({ kind: 'rule', version: '1.0.0' }));
  await installRuleFromCupboardCore({ githubUrl: 'https://github.com/demo/rules', listingRef: id }, {
    cloneRepo: async (_url, dest) => fs.cp(repo, dest, { recursive: true }),
    fetchAtSha: async () => { throw new Error('unpinned fixture'); },
    listTreeBlobs: async () => { throw new Error('unpinned fixture'); }, tmpDir: () => root,
  }, async () => null);
  // Read the production runtime after installation, before selecting any pin.
  // These must fail if installing starts activating packages globally.
  expect(await readAppliedWornRules('unselected-' + id, 'ws')).toBeNull();
  expect(await readIdentityWearer('unselected-' + id, 'ws')).toBeNull();
  expect(listReactionRules().map(rule => rule.id).sort()).toEqual(registeredBefore);
  const pin = await resolveLocalBlueprintPackage({ kind: 'rule', ref: id });
  expect(pin).not.toBeNull();
  return { inputs: [pin!] };
}

describe('installed rules are inert until selected by a wearer', () => {
  it('runs the installed sync guard at pre-tool and preserves its tool filter', async () => {
    const artifact = await install('guard', { delivery: 'sync', sink: 'pre-tool', tools: ['capability:bash'],
      guard: { deny: { 'input.command': { equals: 'git push' } }, reason: 'no push' } });
    const worn = wornSyncRules(artifact);
    expect(evaluatePreToolGuards(worn, { tool: 'capability:bash', input: { command: 'git push' }, client: 'codex' })).toMatchObject({ decision: 'deny', ruleId: 'guard', reason: 'no push' });
    expect(evaluatePreToolGuards(worn, { tool: 'coord:send', input: { command: 'git push' }, client: 'codex' })).toEqual({ decision: 'none' });
  });

  it('runs the installed context provider through the budgeted hook sink', async () => {
    const artifact = await install('context', { delivery: 'sync', sink: 'stop', context: {
      ref: 'demo.context@1', verb: 'read', tokenBudget: 100, priority: 0, overBudget: 'truncate',
    } });
    const produceContext = vi.fn(async () => 'Remember the current task.');
    const result = await evaluateHookContextSink({ ownerId: 'wearer', workspaceId: 'ws', sink: 'stop', deps: {
      readWearer: async () => ({ potSlug: 'pot', attachmentRevision: 'rev' } as never),
      readWornRules: async () => wornSyncRules(artifact), produceContext, turns: memoryHookTurnStore(),
    } });
    expect(result.text).toContain('Remember the current task.');
    expect(produceContext).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'wearer', potSlug: 'pot' }));
  });

  it('fires an installed async rule as its wearer and refuses it after detach', async () => {
    const artifact = await install('reaction', { delivery: 'async', on: 'demo:done',
      fire: 'class:demo.tasks@1.0.0#create', args: { title: 'From installed rule' } });
    const pins = wornRulePins(artifact);
    const wearer: IdentityWearer = { ownerId: 'wearer', workspaceId: 'ws', role: 'operator', harnessSlug: 'demo', revisionTag: 'a'.repeat(16),
      rules: { applied: { specificationRevision: 'a'.repeat(64), stateRevision: 'state' }, packagePins: artifact.inputs,
        pins, sync: wornSyncRules(artifact), declaredClassNeeds: null } };
    const target = { classId: 'demo.tasks', classVersion: '1.0.0', classRef: 'demo.tasks@1.0.0', verb: 'create' };
    const dispatch = vi.fn(async () => ({ ok: true }));
    const sql = vi.fn(async (parts: TemplateStringsArray) => parts.join('?').includes('WITH ins AS')
      ? [{ status: 'authorizing' }] : [{ dedup_id: 'receipt' }]) as unknown as IdentityReactionDeps['sql'];
    const deps: Partial<IdentityReactionDeps> = { sql, readWearer: async () => wearer, resolvePot: async () => 'pot',
      validateFire: async () => ({ ok: true, target, capability: 'tasks:create' }),
      resolveFire: async () => ({ status: 'resolved', target, tool: 'tasks:create', providerPackage: 'demo', providerVersion: '1.0.0', providerKind: 'tool' }),
      readCeiling: async () => ({ potSlug: 'pot', ceilings: [], protectedAdditions: [] }), isRegisteredTool: () => true,
      readOperationSubmit: async () => null, dispatch };
    const { payloads } = planIdentityReactions({ workspaceId: 'ws', eventKey: 'demo:done', fireId: 'fire-1', payload: {}, rows: [{
      subscriber_id: identityRuleSubscriberId('wearer', wearer.revisionTag, 'reaction'), delivery_mode: 'muted',
      derived_from_kind: 'identity-rule', derived_from_ref: 'wearer',
    }] });
    expect(await executeIdentityReaction(payloads[0]!, deps)).toMatchObject({ status: 'fired' });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'wearer', workspaceId: 'ws',
      capabilities: ['tasks:create'], args: { title: 'From installed rule' } }));
    dispatch.mockClear();
    expect(await executeIdentityReaction({ ...payloads[0]!, receiptId: 'detached' }, { ...deps, readWearer: async () => null })).toMatchObject({ status: 'refused', code: 'detached' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
