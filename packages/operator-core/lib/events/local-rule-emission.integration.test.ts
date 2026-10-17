/** Production emit sources → local matcher → contributor budget (D-003/D-006). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-local-emission', recentFires: 0,
  count: vi.fn(async (_input: unknown): Promise<number> => 0) }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async (_ws: string, fn: (tx: unknown) => unknown) => fn(h.sql),
}));
vi.mock('../workspace-registry', async original => ({
  ...await original<typeof import('../workspace-registry')>(),
  activeWorkspaceId: () => h.ws, backgroundWorkspaceIds: () => [h.ws],
}));
vi.mock('../memory/hive-scope', () => ({ resolvePotSlugsForHarnesses: async () => ['demo'] }));
vi.mock('../agent-tools/coordination/identity', async original => ({
  ...await original<typeof import('../agent-tools/coordination/identity')>(),
  resolveAgentIdentity: () => ({ workspaceId: h.ws, ownerId: 'emitter', ownerLabel: 'Emitter', userId: null, source: 'static-client' }),
}));
vi.mock('./reaction-dedup', async original => ({
  ...await original<typeof import('./reaction-dedup')>(), countRecentContributorFires: h.count,
}));
vi.mock('./reaction-failure-surface', () => ({ surfaceReactionFailure: vi.fn() }));

import emit from '../agent-tools/events/emit';
import { emitAwaitedEvent, setAutoPumpEnabledForTests } from './await/engine';
import { defineCapabilityClass } from '../capability-class-registry-store';
import { putLocalRule, recordLocalRuleTest, setLocalRuleEnabled, localRuleSource } from './local-rule-store';
import { matchLocalRules } from './local-rule-runtime';
import { setLocalRuleMatcher } from './engine';
import { _resetReactionsForTests } from './registry';
import { DEFAULT_CONTRIBUTOR_FIRE_BUDGET } from './reaction-fire-budget';
import { surfaceReactionFailure } from './reaction-failure-surface';
import type { ReactionCause, ToolInvocationEvent } from './types';

let db: OrgTestDb;
let previousPump: boolean;
const fire = vi.fn(async (_event: ToolInvocationEvent, _cause: ReactionCause) => ({ ok: true }));
const matcher = vi.fn(matchLocalRules);
const scope = { workspaceId: h.ws, potSlug: 'demo' };
const ctx = { workspaceId: h.ws, harnessSlug: 'demo', role: 'operator' } as never;

beforeAll(async () => {
  db = await createOrgTestDb(); h.sql = db.adminSql;
  await db.adminSql.unsafe(await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1521-locally-authored-rules.sql', import.meta.url), 'utf8'));
  await defineCapabilityClass(db.adminSql, { workspaceId: h.ws, id: 'demo.tasks', version: '1.0.0', title: 'Tasks',
    description: 'Emission test class', interfaceVerbs: { create: { capability: 'tasks:create', inputSchema: {}, outputSchema: {} } } });
  await putLocalRule({ ...scope, authorId: 'author', definition: { schemaVersion: 1, id: 'emission', title: 'Emission',
    description: 'Bridge fixture', version: '1.0.0', delivery: 'async', on: 'event:demo:*',
    when: { 'payload.kind': { equals: 'bug' } }, fire: 'class:demo.tasks@1.0.0#create' } }, db.adminSql);
  await recordLocalRuleTest(scope, 'emission', 1, { passed: true, samples: 1 }, db.adminSql);
  await setLocalRuleEnabled(scope, 'emission', true, db.adminSql);
  previousPump = setAutoPumpEnabledForTests(false);
  setLocalRuleMatcher(matcher, fire);
}, 180_000);
beforeEach(() => {
  fire.mockClear(); matcher.mockClear(); vi.mocked(surfaceReactionFailure).mockClear();
  h.recentFires = 0; h.count.mockReset().mockImplementation(async () => h.recentFires);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  setLocalRuleMatcher(null, null); _resetReactionsForTests();
  setAutoPumpEnabledForTests(previousPump); await db?.cleanup();
});

describe('local rules on the real emission path', () => {
  it('fires once for agent emit and once for code emit, while declarations and nonmatching payloads stay inert', async () => {
    await emit.handler({ event: 'demo:ready', announce: true, announceScope: 'global' } as never, ctx);
    expect(matcher).not.toHaveBeenCalled(); expect(fire).not.toHaveBeenCalled();
    await emit.handler({ event: 'demo:ready', payload: { kind: 'bug', source: 'agent' } } as never, ctx);
    await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(1));
    expect(fire.mock.calls[0]![0]).toMatchObject({ tool: 'event:demo:ready', args: { payload: { source: 'agent' } }, ctx: { workspaceId: h.ws, harnessSlug: 'demo' } });
    await emitAwaitedEvent({ key: 'demo:ready', workspaceId: h.ws, harnessSlug: 'demo', source: 'code', payload: { kind: 'bug', source: 'code' } });
    await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(2));
    expect(fire.mock.calls[1]![0]).toMatchObject({ tool: 'event:demo:ready', args: { payload: { source: 'code' } } });
    await emitAwaitedEvent({ key: 'other:ready', workspaceId: h.ws, payload: { kind: 'bug' } });
    await emitAwaitedEvent({ key: 'demo:ready', workspaceId: h.ws, payload: { kind: 'task' } });
    await Promise.all(matcher.mock.results.map(result => result.value));
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('charges local authored rules to their stable contributor and refuses an exhausted fire budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contributor = localRuleSource({ ...scope, id: 'emission' });
    h.recentFires = DEFAULT_CONTRIBUTOR_FIRE_BUDGET - 1;
    await emitAwaitedEvent({ key: 'demo:budget', workspaceId: h.ws, payload: { kind: 'bug' } });
    await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(1));
    expect(h.count).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: h.ws, contributor }));
    h.recentFires = DEFAULT_CONTRIBUTOR_FIRE_BUDGET;
    await emitAwaitedEvent({ key: 'demo:budget', workspaceId: h.ws, payload: { kind: 'bug' } });
    await vi.waitFor(() => expect(surfaceReactionFailure).toHaveBeenCalledWith(expect.objectContaining({ stage: 'budget', rule: expect.objectContaining({ source: contributor }) })));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused (over budget)'));
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
