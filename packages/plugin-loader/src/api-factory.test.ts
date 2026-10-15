/**
 * Tests for the DI container factory.  Run with:
 *   cd packages/papercusp-plugin-loader && npx tsx --test src/api-factory.test.ts
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createPapercuspApi, type RealServices } from './api-factory.ts';
import { MissingCapabilityError, UnknownMethodError } from './capabilities.ts';
import type {
  TasksService,
  GoalsService,
  PendingEventsService,
  RoutinesService,
  CommentsService,
  SecretsService,
  PluginStorage,
  PluginDb,
} from '@papercusp/plugin-sdk';

const stubTasks = (): TasksService => ({
  list: async () => [],
  get: async () => null,
  lineage: async () => [],
  create: async () => ({ id: 'T-1', title: 't', status: 'todo', parentId: null, goalId: null, attempts: 0, takenBy: null, expiresAt: null }),
  setStatus: async () => ({ id: 'T-1', title: 't', status: 'done', parentId: null, goalId: null, attempts: 0, takenBy: null, expiresAt: null }),
});

const stubGoals = (): GoalsService => ({
  list: async () => [],
  get: async () => null,
  create: async (g: any) => ({ id: g.id, installSlug: 'test', title: g.title, body: null, parentId: null, status: 'open', budgetCents: null }),
});

const stubPendingEvents = (): PendingEventsService => ({
  listUnconsumed: async () => [],
});

const stubRoutines = (): RoutinesService => ({
  list: async () => [],
  upsert: async () => ({ id: 'R-1' }),
  delete: async () => undefined,
  trigger: async () => ({ eventId: 'E-1' }),
});

const stubComments = (): CommentsService => ({
  list: async () => [],
  create: async () => ({ id: 'C-1' }),
});

const stubSecrets = (resolver: (name: string) => Promise<string> = async () => 'secret-value'): SecretsService => ({
  read: resolver,
});

const stubStorage = (): PluginStorage => ({
  read: async () => null,
  write: async () => undefined,
  delete: async () => undefined,
  list: async () => [],
});

const stubDb = (): PluginDb => ({
  query: async () => [] as any,
  exec: async () => undefined,
});

const buildServices = (overrides?: Partial<RealServices>): RealServices => ({
  tasks: stubTasks(),
  goals: stubGoals(),
  pendingEvents: stubPendingEvents(),
  routines: stubRoutines(),
  comments: stubComments(),
  secrets: stubSecrets(),
  storage: stubStorage(),
  db: stubDb(),
  fetch: async () => new Response('ok'),
  ...overrides,
});

const buildApi = (capabilities: string[]) => {
  const ctx = { pluginName: 'test-plugin', capabilities: capabilities as any };
  const services = buildServices();
  return createPapercuspApi({ ctx, services });
};

describe('createPapercuspApi — capability gating', () => {
  it('allows tasks.list when tasks:read is present', async () => {
    const api = buildApi(['tasks:read']);
    const tasks = await api.tasks.list();
    assert.deepStrictEqual(tasks, []);
  });

  it('blocks tasks.list when tasks:read is missing', () => {
    const api = buildApi([]);
    // wrapServiceWithCaps throws synchronously before returning the inner promise.
    assert.throws(() => api.tasks.list(), MissingCapabilityError);
  });

  it('blocks tasks.create when tasks:write is missing (read alone is not enough)', () => {
    const api = buildApi(['tasks:read']);
    assert.throws(() => api.tasks.create({ title: 't' }), MissingCapabilityError);
  });

  it('allows tasks.create when tasks:write is present', async () => {
    const api = buildApi(['tasks:write']);
    const created = await api.tasks.create({ title: 't' });
    assert.equal(created.id, 'T-1');
  });

  it('blocks unknown method access on a wrapped service', async () => {
    const api = buildApi(['tasks:read']);
    assert.throws(() => (api.tasks as any).somethingBogus(), UnknownMethodError);
  });
});

describe('createPapercuspApi — secrets per-name capability', () => {
  it('allows secrets.read for the specifically-named secret', async () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:YT_API_KEY' as any] };
    const services = buildServices({ secrets: stubSecrets(async () => 'YT_VAL') });
    const api = createPapercuspApi({
      ctx,
      services,
    });
    const v = await api.secrets.read('YT_API_KEY');
    assert.equal(v, 'YT_VAL');
  });

  it('blocks secrets.read for an undeclared secret name', async () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:YT_API_KEY' as any] };
    const services = buildServices();
    const api = createPapercuspApi({
      ctx,
      services,
    });
    // secrets.read is `async`, so sync throws inside become rejected promises.
    await assert.rejects(() => api.secrets.read('OTHER_KEY'), MissingCapabilityError);
  });
});

describe('createPapercuspApi — fetch domain allowlist', () => {
  it('allows fetch to a declared host', async () => {
    const calls: string[] = [];
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:weather.gov' as any] };
    const services = buildServices({
      fetch: (async (input: any) => {
        calls.push(String(input));
        return new Response('weather');
      }) as any,
    });
    const api = createPapercuspApi({
      ctx,
      services,
    });
    const r = await api.fetch('https://weather.gov/forecast');
    assert.equal(await r.text(), 'weather');
    assert.equal(calls.length, 1);
  });

  it('blocks fetch to an undeclared host', async () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:weather.gov' as any] };
    const services = buildServices({ fetch: (async () => new Response('x')) as any });
    const api = createPapercuspApi({
      ctx,
      services,
    });
    await assert.rejects(() => api.fetch('https://attacker.example/'), MissingCapabilityError);
  });
});

describe('createPapercuspApi — service breadth', () => {
  it('exposes all 9 service slots', () => {
    const api = buildApi([]);
    for (const slot of ['tasks', 'goals', 'pendingEvents', 'routines', 'comments', 'secrets', 'fetch', 'storage', 'db']) {
      assert.ok((api as any)[slot] !== undefined, `slot ${slot} missing`);
    }
  });

  it('capabilities() returns the plugin\'s declared list', () => {
    const api = buildApi(['tasks:read', 'goals:read']);
    assert.deepStrictEqual(api.capabilities().sort(), ['goals:read', 'tasks:read']);
  });
});
