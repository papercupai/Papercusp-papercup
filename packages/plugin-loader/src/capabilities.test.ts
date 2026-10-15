/**
 * Tests for capability proxy + fetch/secrets gates. Run with:
 *   cd packages/papercusp-plugin-loader && npx tsx --test src/capabilities.test.ts
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  hasCapability,
  requireCapability,
  wrapServiceWithCaps,
  makeFetchProxy,
  makeSecretsProxy,
  MissingCapabilityError,
  UnknownMethodError,
} from './capabilities.ts';
import type { ServiceDef } from '@papercusp/plugin-sdk';

// Inline service def — equivalent to `defineService({...})` from @papercusp/plugin-sdk (a type-only
// import, so no runtime cross-package resolution). Typed as the SDK's ServiceDef so the fixture is
// checked against the real Capability union.
function defineService(def: ServiceDef): ServiceDef {
  return def;
}

describe('hasCapability / requireCapability', () => {
  it('returns true for declared cap', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    assert.equal(hasCapability(ctx, 'tasks:read'), true);
  });

  it('returns false for undeclared cap', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    assert.equal(hasCapability(ctx, 'tasks:write'), false);
  });

  it('requireCapability throws MissingCapabilityError for undeclared cap', () => {
    const ctx = { pluginName: 'p', capabilities: [] as any };
    assert.throws(
      () => requireCapability(ctx, 'tasks:write'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });

  it('subdomain wildcard `http:fetch:*.foo.com` matches `http:fetch:api.foo.com`', () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:*.foo.com'] as any };
    assert.equal(hasCapability(ctx, 'http:fetch:api.foo.com'), true);
    assert.equal(hasCapability(ctx, 'http:fetch:deep.api.foo.com'), true);
  });

  it('subdomain wildcard does NOT match the bare suffix `foo.com`', () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:*.foo.com'] as any };
    assert.equal(hasCapability(ctx, 'http:fetch:foo.com'), false);
    assert.equal(hasCapability(ctx, 'http:fetch:.foo.com'), false);
  });

  it('subdomain wildcard does NOT cross prefixes', () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:*.foo.com'] as any };
    assert.equal(hasCapability(ctx, 'secrets:read:api.foo.com'), false);
  });

  it('prefix wildcard `secrets:read:YT_*` matches `secrets:read:YT_API_KEY`', () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:YT_*'] as any };
    assert.equal(hasCapability(ctx, 'secrets:read:YT_API_KEY'), true);
    assert.equal(hasCapability(ctx, 'secrets:read:YT_'), false); // empty tail rejected
    assert.equal(hasCapability(ctx, 'secrets:read:OTHER'), false);
  });

  it('degenerate `secrets:read:*` (empty head) is rejected', () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:*'] as any };
    assert.equal(hasCapability(ctx, 'secrets:read:ANY'), false);
  });

  describe('two-tier (Batch B)', () => {
    it('manifest-declared cap with no granted set is allowed (legacy path)', () => {
      const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
      assert.equal(hasCapability(ctx, 'tasks:read'), true);
    });

    it('manifest-declared cap NOT in granted set is denied', () => {
      const ctx = {
        pluginName: 'p',
        capabilities: ['tasks:read'] as any,
        granted: [] as any,
      };
      assert.equal(hasCapability(ctx, 'tasks:read'), false);
    });

    it('manifest + granted both declare the cap → allowed', () => {
      const ctx = {
        pluginName: 'p',
        capabilities: ['tasks:read'] as any,
        granted: ['tasks:read'] as any,
      };
      assert.equal(hasCapability(ctx, 'tasks:read'), true);
    });

    it('granted set with the cap but manifest does NOT → denied (Tier 1 still required)', () => {
      const ctx = {
        pluginName: 'p',
        capabilities: [] as any,
        granted: ['tasks:read'] as any,
      };
      assert.equal(hasCapability(ctx, 'tasks:read'), false);
    });

    it('granted wildcard authorizes anything in its match set the manifest also declared', () => {
      const ctx = {
        pluginName: 'p',
        capabilities: ['http:fetch:api.foo.com', 'http:fetch:cdn.foo.com'] as any,
        granted: ['http:fetch:*.foo.com'] as any,
      };
      assert.equal(hasCapability(ctx, 'http:fetch:api.foo.com'), true);
      assert.equal(hasCapability(ctx, 'http:fetch:cdn.foo.com'), true);
      assert.equal(hasCapability(ctx, 'http:fetch:other.bar.com'), false);
    });
  });
});

describe('wrapServiceWithCaps', () => {
  const TasksDef = defineService({
    name: 'tasks',
    methods: {
      list:   { capability: 'tasks:read' },
      get:    { capability: 'tasks:read' },
      create: { capability: 'tasks:write' },
    },
  });

  const realService = {
    list: () => ['a', 'b'],
    get: (id: string) => ({ id }),
    create: (input: any) => ({ created: input }),
  };

  it('passes through method calls when cap is held', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    const proxied = wrapServiceWithCaps(ctx, realService as any, TasksDef);
    assert.deepEqual(proxied.list(), ['a', 'b']);
  });

  it('throws MissingCapabilityError when cap is missing', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    const proxied = wrapServiceWithCaps(ctx, realService as any, TasksDef);
    assert.throws(
      () => proxied.create({ title: 'x' }),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });

  it('throws UnknownMethodError for non-existent method', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    const proxied = wrapServiceWithCaps(ctx, realService as any, TasksDef);
    assert.throws(
      () => (proxied as any).bogusMethod(),
      (e: Error) => e instanceof UnknownMethodError,
    );
  });
});

describe('makeFetchProxy', () => {
  it('allows a hostname when http:fetch:<host> is declared', async () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:youtube.com'] as any };
    const calls: string[] = [];
    const fakeFetch = (async (input: any) => {
      calls.push(typeof input === 'string' ? input : input.toString());
      return new Response('ok');
    }) as typeof fetch;
    const proxy = makeFetchProxy(ctx, fakeFetch);
    const r = await proxy('https://youtube.com/api/videos');
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ['https://youtube.com/api/videos']);
  });

  it('blocks a hostname not in the allowlist', async () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:youtube.com'] as any };
    const proxy = makeFetchProxy(ctx);
    await assert.rejects(
      () => proxy('https://api.openai.com/v1/chat'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });
});

describe('makeSecretsProxy', () => {
  it('reads when secrets:read:<NAME> is declared', async () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:YOUTUBE_API_KEY'] as any };
    const proxy = makeSecretsProxy(ctx, async () => 'abc123');
    assert.equal(await proxy.read('YOUTUBE_API_KEY'), 'abc123');
  });

  it('throws on unscoped secret read', async () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:YOUTUBE_API_KEY'] as any };
    const proxy = makeSecretsProxy(ctx, async () => 'abc123');
    await assert.rejects(
      () => proxy.read('OPENAI_API_KEY'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });
});
