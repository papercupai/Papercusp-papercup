/**
 * Tests for capability proxy + fetch/secrets gates. Run with:
 *   npm test --workspace=@papercusp/plugin-loader -- src/capabilities.test.ts
 */
import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasCapability,
  requireCapability,
  wrapServiceWithCaps,
  makeFetchProxy,
  makeSecretsProxy,
  MissingCapabilityError,
  UnknownMethodError,
  createInvocationCapabilityContext,
  runWithInvocationCapabilities,
  type InvocationCapabilityInput,
  type CapabilityCheckContext,
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

describe('host-owned invocation capability intersection', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function input(overrides: Partial<InvocationCapabilityInput> = {}): InvocationCapabilityInput {
    return {
      pluginName: 'fixture',
      capabilities: ['tasks:read', 'tasks:write'],
      granted: ['tasks:read', 'tasks:write'],
      principal: {
        kind: 'system', slug: 'fixture-caller', workspaceId: 'fixture-workspace',
        authMethod: 'bearer-token', trust: 'verified',
        capabilities: new Set(['tasks:read', 'tasks:write']),
        allowedTools: new Set(['fixture:parent', 'fixture:child']),
      },
      invocationId: 'fixture-invocation',
      declaration: { name: 'fixture:parent', capabilities: ['tasks:read', 'tasks:write'] },
      approvals: ['tasks:read', 'tasks:write'],
      expiresAt: Date.now() + 60_000, isActive: () => true,
      ...overrides,
    };
  }

  function markerService(ctx: CapabilityCheckContext, cap: 'tasks:read' | 'tasks:write' = 'tasks:write') {
    const dir = mkdtempSync(join(tmpdir(), 'invocation-capabilities-'));
    dirs.push(dir);
    const path = join(dir, 'effect');
    const service = wrapServiceWithCaps(ctx, {
      perform: (_untrusted?: unknown) => { writeFileSync(path, 'authorized effect'); return path; },
    }, { name: 'fixture', methods: { perform: { capability: cap } } });
    return { path, service };
  }

  it('permits an actual effect when all independent authority axes agree', () => {
    const { path, service } = markerService(createInvocationCapabilityContext(input()));
    assert.equal(service.perform(), path);
    assert.equal(readFileSync(path, 'utf8'), 'authorized effect');
  });

  for (const axis of ['manifest', 'declaration', 'installation', 'caller', 'tool', 'approval'] as const) {
    it(`denies before a filesystem effect when the ${axis} grant is missing`, () => {
      const denied = input();
      if (axis === 'manifest') denied.capabilities = [];
      if (axis === 'declaration') denied.declaration = { ...denied.declaration, capabilities: [] };
      if (axis === 'installation') denied.granted = [];
      if (axis === 'caller') denied.principal = { ...denied.principal, capabilities: new Set() };
      if (axis === 'tool') denied.principal = { ...denied.principal, allowedTools: new Set() };
      if (axis === 'approval') denied.approvals = [];
      const { path, service } = markerService(createInvocationCapabilityContext(denied));
      assert.throws(() => service.perform({
        principal: input().principal, granted: ['tasks:write'],
        approvals: ['tasks:write'], bypass: true, force: true,
      }), MissingCapabilityError);
      assert.equal(existsSync(path), false);
    });
  }

  it('requires an exact tool allowlist, including when it is absent', () => {
    for (const allowedTools of [undefined, new Set(['fixture:*']), new Set(['fixture:child'])]) {
      const hostInput = input();
      hostInput.principal = { ...hostInput.principal, allowedTools };
      const { path, service } = markerService(createInvocationCapabilityContext(hostInput));
      assert.throws(() => service.perform(), MissingCapabilityError);
      assert.equal(existsSync(path), false);
    }
  });

  it('denies missing installation and approval axes even for untyped host input', () => {
    for (const axis of ['granted', 'approvals', 'declaration'] as const) {
      const hostInput = input();
      delete (hostInput as any)[axis];
      const { path, service } = markerService(createInvocationCapabilityContext(hostInput));
      assert.throws(() => service.perform(), MissingCapabilityError);
      assert.equal(existsSync(path), false);
    }
  });

  it('does not turn serialized or copied invocation identity into authority', () => {
    const ctx = createInvocationCapabilityContext(input());
    for (const forged of [{ ...ctx }, JSON.parse(JSON.stringify(ctx))]) {
      const { path, service } = markerService(forged);
      assert.throws(() => service.perform(), MissingCapabilityError);
      assert.throws(() => runWithInvocationCapabilities(forged, () => writeFileSync(path, 'forged')), MissingCapabilityError);
      assert.equal(existsSync(path), false);
    }
  });

  it('uses the registered MCP exposure name for the exact allowlist', () => {
    const hostInput = input();
    hostInput.declaration = { ...hostInput.declaration, name: 'fixture.implementation', expose: { mcp: { name: 'fixture:parent' } } };
    const { path, service } = markerService(createInvocationCapabilityContext(hostInput));
    service.perform();
    assert.equal(existsSync(path), true);
    hostInput.principal = { ...hostInput.principal, allowedTools: new Set(['fixture.implementation']) };
    const denied = markerService(createInvocationCapabilityContext(hostInput));
    assert.throws(() => denied.service.perform(), MissingCapabilityError);
    assert.equal(existsSync(denied.path), false);
  });

  it('snapshots grants so mutating the source principal cannot widen a saved wrapper', () => {
    const hostInput = input({ approvals: ['tasks:read'] });
    const ctx = createInvocationCapabilityContext(hostInput);
    (hostInput.approvals as string[]).push('tasks:write');
    (hostInput.principal.allowedTools as Set<string>).add('fixture:other');
    const { path, service } = markerService(ctx);
    assert.throws(() => service.perform(), MissingCapabilityError);
    assert.equal(existsSync(path), false);
    assert.throws(() => (ctx.capabilities as string[]).push('secrets:read:PRIVATE'), TypeError);
  });

  it('revalidates revoked and expired contexts even for a previously saved method', () => {
    let active = true;
    const ctx = createInvocationCapabilityContext(input({ isActive: () => active }));
    const { path, service } = markerService(ctx);
    const saved = service.perform;
    active = false;
    assert.throws(() => saved(), MissingCapabilityError);
    assert.equal(existsSync(path), false);
    for (const extra of [
      { expiresAt: Date.now() - 1 }, { expiresAt: Number.NaN },
      { isActive: () => { throw new Error('revocation lookup unavailable'); } },
      { principal: { ...input().principal, trust: 'unverified-loopback' as const } },
    ]) {
      const denied = markerService(createInvocationCapabilityContext(input(extra)));
      assert.throws(() => denied.service.perform(), MissingCapabilityError);
      assert.equal(existsSync(denied.path), false);
    }
  });

  it('keeps resource approvals independent of broader declarations and caller grants', async () => {
    const caps = ['secrets:read:FIXTURE_*'] as const;
    const hostInput = input({ capabilities: caps, granted: caps, approvals: ['secrets:read:FIXTURE_PUBLIC'] });
    hostInput.declaration = { ...hostInput.declaration, capabilities: [...caps] };
    hostInput.principal = { ...hostInput.principal, capabilities: new Set(caps) };
    const reads: string[] = [];
    const secrets = makeSecretsProxy(createInvocationCapabilityContext(hostInput), async name => {
      reads.push(name); return 'authorized secret';
    });
    assert.equal(await secrets.read('FIXTURE_PUBLIC'), 'authorized secret');
    await assert.rejects(() => secrets.read('FIXTURE_PRIVATE'), MissingCapabilityError);
    assert.deepEqual(reads, ['FIXTURE_PUBLIC']);
  });

  it('attenuates explicit children and rechecks parent revocation', () => {
    let active = true;
    const parent = createInvocationCapabilityContext(input({ approvals: ['tasks:read'], isActive: () => active }));
    const child = createInvocationCapabilityContext(input({
      parent, declaration: { ...input().declaration, name: 'fixture:child' }, invocationId: 'child',
    }));
    const allowed = markerService(child, 'tasks:read');
    allowed.service.perform();
    assert.equal(existsSync(allowed.path), true);
    const denied = markerService(child);
    assert.throws(() => denied.service.perform(), MissingCapabilityError);
    assert.equal(existsSync(denied.path), false);
    active = false;
    assert.equal(hasCapability(child, 'tasks:read'), false);
    let entered = false;
    assert.throws(() => runWithInvocationCapabilities(child, () => { entered = true; }), MissingCapabilityError);
    assert.equal(entered, false);
  });

  it('refuses a child that changes principal or workspace or supplies a forged parent', () => {
    const parent = createInvocationCapabilityContext(input());
    for (const override of [
      { principal: { ...input().principal, slug: 'other-caller' } },
      { principal: { ...input().principal, workspaceId: 'other-workspace' } },
      { parent: { ...parent } },
    ]) {
      const { path, service } = markerService(createInvocationCapabilityContext(input({ parent, ...override })));
      assert.throws(() => service.perform(), MissingCapabilityError);
      assert.equal(existsSync(path), false);
    }
  });

  it('cannot omit its ambient parent, including after an await and after returning the child', async () => {
    const parent = createInvocationCapabilityContext(input({ approvals: ['tasks:read'] }));
    const child = await runWithInvocationCapabilities(parent, async () => {
      await Promise.resolve();
      return createInvocationCapabilityContext(input({ declaration: { ...input().declaration, name: 'fixture:child' } }));
    });
    const { path, service } = markerService(child);
    assert.throws(() => service.perform(), MissingCapabilityError);
    assert.equal(existsSync(path), false);
  });

  it('limits prebuilt and legacy child services inside asynchronous checked service calls', async () => {
    const parent = createInvocationCapabilityContext(input({ approvals: ['tasks:read'] }));
    const children = [createInvocationCapabilityContext(input()), {
      pluginName: 'legacy', capabilities: ['tasks:read', 'tasks:write'] as const,
    }];
    for (const ctx of children) {
      const child = markerService(ctx);
      const outer = wrapServiceWithCaps(parent, {
        async read() { await Promise.resolve(); return child.service.perform(); },
      }, { name: 'outer', methods: { read: { capability: 'tasks:read' } } });
      await assert.rejects(() => outer.read(), MissingCapabilityError);
      assert.equal(existsSync(child.path), false);
    }
  });

  it('intersects the parent exact tool allowlist and isolates concurrent invocations', async () => {
    const hostInput = input();
    hostInput.principal = { ...hostInput.principal, allowedTools: new Set(['fixture:parent']) };
    const narrow = createInvocationCapabilityContext(hostInput);
    const wide = createInvocationCapabilityContext(input());
    const child = createInvocationCapabilityContext(input({ declaration: { ...input().declaration, name: 'fixture:child' } }));
    const denied = markerService(child);
    const allowed = markerService(child);
    await Promise.all([
      runWithInvocationCapabilities(narrow, async () => {
        await Promise.resolve();
        assert.throws(() => denied.service.perform(), MissingCapabilityError);
      }),
      runWithInvocationCapabilities(wide, async () => {
        await Promise.resolve(); allowed.service.perform();
      }),
    ]);
    assert.equal(existsSync(denied.path), false);
    assert.equal(readFileSync(allowed.path, 'utf8'), 'authorized effect');
  });

  it('imports in a browser without native async context and refuses strict execution', async () => {
    vi.resetModules();
    vi.doMock('node:async_hooks', () => ({ AsyncLocalStorage: undefined }));
    try {
      const browser = await import('./capabilities.ts');
      assert.equal(browser.hasCapability({ pluginName: 'legacy', capabilities: ['tasks:read'] }, 'tasks:read'), true);
      const strict = browser.createInvocationCapabilityContext(input());
      assert.equal(browser.hasCapability(strict, 'tasks:write'), false);
      const dir = mkdtempSync(join(tmpdir(), 'invocation-browser-'));
      dirs.push(dir);
      const path = join(dir, 'forbidden');
      assert.throws(() => browser.runWithInvocationCapabilities(strict, () => writeFileSync(path, 'bad')), browser.MissingCapabilityError);
      assert.equal(existsSync(path), false);
    } finally {
      vi.doUnmock('node:async_hooks');
      vi.resetModules();
    }
  });
});
