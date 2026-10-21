/** Real PG restore → shared matching → wearer-authorized execution (P-002). */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async (_ws: string, fn: (tx: unknown) => unknown) => fn(h.sql),
}));
vi.mock('../memory/hive-scope', () => ({ resolvePotSlugsForHarnesses: async (_ws: string, harnesses: string[]) => [harnesses[0] === 'demo' ? 'demo' : 'other'] }));
import { defineCapabilityClass } from '../capability-class-registry-store';
import { putLocalRule, recordLocalRuleTest, setLocalRuleEnabled, localRuleSource } from './local-rule-store';
import { matchLocalRules, localReactionPayload, localRuleRegistrationId } from './local-rule-runtime';
import { executeIdentityReaction } from './identity-reaction';
import { buildWearerToolContext } from '../agent-identities/wearer-authority';
import { listReactionRules } from './registry';
import type { ToolInvocationEvent } from './types';

let db: OrgTestDb;
const workspaceId = 'ws-local-runtime';
const scope = { workspaceId, potSlug: 'demo' };
const definition = (id: string) => ({ schemaVersion: 1, id, title: id, description: 'Runtime fixture',
  version: '1.0.0', delivery: 'async', on: 'event:demo:*', fire: 'class:demo.tasks@1.0.0#create',
  when: { 'payload.kind': { equals: 'bug' } }, args: { title: 'restored' } });
const event = (key = 'event:demo:done', ws = workspaceId, harness = 'demo'): ToolInvocationEvent => ({
  tool: key, args: { key: key.slice(6), payload: { kind: 'bug' } }, result: { ok: true, data: { kind: 'bug' } },
  ctx: buildWearerToolContext({ workspaceId: ws, ownerId: 'emitter', role: 'su', harnessSlug: harness, capabilities: [], spawnId: 'test' }),
});
beforeAll(async () => {
  db = await createOrgTestDb(); h.sql = db.adminSql;
  await db.adminSql.unsafe(await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1521-locally-authored-rules.sql', import.meta.url), 'utf8'));
  await defineCapabilityClass(db.adminSql, { workspaceId, id: 'demo.tasks', version: '1.0.0', title: 'Tasks',
    description: 'Runtime test class', interfaceVerbs: { create: { capability: 'tasks:create', inputSchema: {}, outputSchema: {} } } });
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

describe('enabled local runtime', () => {
  it('restores enabled rows after a fresh module load and executes as the live author', async () => {
    const row = await putLocalRule({ ...scope, authorId: 'author', definition: definition('restore') }, db.adminSql);
    expect(await matchLocalRules(event())).toEqual([]);
    await recordLocalRuleTest(scope, row.id, 1, { passed: true, samples: 1 }, db.adminSql);
    const enabled = await setLocalRuleEnabled(scope, row.id, true, db.adminSql);
    vi.resetModules();
    const restarted = await import('./local-rule-runtime');
    const ev = event();
    const actions = await restarted.matchLocalRules(ev);
    expect(actions.map(a => a.rule.id)).toEqual([localRuleRegistrationId(enabled)]);
    const cause = { depth: 1, chain: [actions[0]!.rule.id], ruleId: actions[0]!.rule.id, rootRunId: ev.ctx.runId };
    const payload = localReactionPayload(ev, cause);
    const target = { classId: 'demo.tasks', classVersion: '1.0.0', classRef: 'demo.tasks@1.0.0', verb: 'create' };
    const dispatch = vi.fn(async () => ({ ok: true }));
    const result = await executeIdentityReaction(payload, { sql: db.adminSql,
      readWearer: async () => ({ ownerId: 'author', workspaceId, role: 'su', harnessSlug: 'demo', revisionTag: 'live',
        rules: { applied: { specificationRevision: 'live', stateRevision: 'live' }, packagePins: [], pins: { rules: [], unreadable: [] }, sync: { rules: [], unreadable: [] }, declaredClassNeeds: null, recall: null } }),
      resolvePot: async () => 'demo', readCeiling: async () => ({ potSlug: 'demo', ceilings: [], protectedAdditions: [] }),
      resolveFire: async () => ({ status: 'resolved', target, tool: 'tasks:create', providerPackage: 'demo', providerVersion: '1.0.0', providerKind: 'tool' }),
      isRegisteredTool: () => true, dispatch });
    expect(result).toMatchObject({ status: 'fired' });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'author', capabilities: ['tasks:create'], args: { title: 'restored' } }));
    const [receipt] = await db.adminSql`SELECT status, contributor FROM harness_shared.event_reactions WHERE dedup_id=${payload.receiptId}`;
    expect(receipt).toMatchObject({ status: 'fired', contributor: localRuleSource(enabled) });
    await setLocalRuleEnabled(scope, row.id, false, db.adminSql);
    expect(await restarted.matchLocalRules(event())).toEqual([]);
    expect(listReactionRules().some(r => r.id === localRuleRegistrationId(enabled))).toBe(false);
  });
  it('matches event patterns and payloads while isolating workspaces and pots', async () => {
    const d = definition('scoped-runtime');
    await putLocalRule({ ...scope, authorId: 'author', definition: d }, db.adminSql);
    await recordLocalRuleTest(scope, d.id, 1, { passed: true, samples: 1 }, db.adminSql);
    await setLocalRuleEnabled(scope, d.id, true, db.adminSql);
    expect(await matchLocalRules(event('event:other:done'))).toEqual([]);
    expect(await matchLocalRules(event('event:demo:done', 'elsewhere'))).toEqual([]);
    expect(await matchLocalRules(event('event:demo:done', workspaceId, 'elsewhere'))).toEqual([]);
    const miss = event(); miss.args = { payload: { kind: 'task' } };
    expect(await matchLocalRules(miss)).toEqual([]);
    expect(await matchLocalRules(event())).toHaveLength(1);
  });
});
