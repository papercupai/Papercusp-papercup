import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { execFile, spawn } from 'node:child_process';
import {
  ensureBootstrap, getTxPool, registerResource, readResourceCoordinationDomainKinds,
  stampResourceCoordinationDomainKind, tryAcquireResource, tryReleaseResource,
  readResourceQueue, _resetForTests,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { hostGlobalLockDomain, resourceLockDomain } from '../coordination-domain';
import {
  __resetResourceDomainKindsForTest, declaredResourceDomainKind, ensureResourceDomainKindsFresh,
} from '../resource-domain-kinds';
import registerTool from '../register_resource';
import { guardResource } from '../resource-lock-guard';
import { _resetListenersForTests } from '../workspace-listener';
import type { AgentIdentity } from '../../coordination/identity';
import restartTool, { configurePeerInFlightEditsReaderForTests } from '../../dev/restart';
import { probeSystemdDaemonReloadNeed } from '../../dev/systemd-service-probe';
import cacheStatsTool from '../../dev/cache_stats';

// Keep the actual handler, domain resolver, cooldown transaction, guard and PG
// store. Only external preflights and process execution are replaced; an
// exclusion regression must fail without signaling a real user service.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn(() => { throw new Error('Unexpected external command in restart exclusion test'); }),
  spawn: vi.fn(() => { throw new Error('Unexpected restart body in exclusion test'); }),
}));
vi.mock('../../dev/restart-preflight', () => ({
  preflightRestartTarget: vi.fn(async () => ({
    ok: true, checked: true, target: 'staging', unit: 'papercusp-staging-api.service',
    requestedRoot: process.env.HOME, lockRoot: process.env.HOME, missing: [], extraneous: [],
    note: 'Private handler fixture',
  })),
  prepareStagingSchemaForRestart: vi.fn(async () => ({
    ok: true, integrationRoot: process.env.HOME, applied: 0, failed: [], note: 'Private fixture',
  })),
}));
vi.mock('../../../release/gate-collision-guard', async importOriginal => ({
  ...await importOriginal<typeof import('../../../release/gate-collision-guard')>(),
  checkGateCollision: vi.fn(async () => ({ blocked: false, kind: 'clear', detail: {} })),
  checkGitSyncCollision: vi.fn(async () => ({ blocked: false, kind: 'clear', detail: {} })),
  checkStagingSyncCollision: vi.fn(async () => ({ blocked: false, kind: 'clear', detail: {} })),
  acquireGitSyncRestartBarrier: vi.fn(() => { throw new Error('Staging must not enter the git-sync barrier'); }),
}));
vi.mock('../../dev/systemd-service-probe', () => ({
  probeServiceStart: vi.fn(() => { throw new Error('Restart body must not probe the service'); }),
  probeSystemdDaemonReloadNeed: vi.fn(async () => 'not-needed'),
}));

// These names identify real host resources. Only the maintained disposable
// runtime may exercise their registry publication; a private lock domain alone
// does not isolate them from cross-domain discovery in the production DB.
// The hermetic test setup deliberately removes the runtime workspace pin.
// Keep its maintained private HOME boundary and verify the actual server below.
const isolated = Boolean(process.env.HOME?.includes('papercusp-test-runtime-') &&
  process.env.HARNESS_ADMIN_DATABASE_URL);
const owner = 'registration-domain-test';

describe.skipIf(!isolated)('maintained host-resource domain publication in isolated PG', () => {
  beforeAll(async () => {
    const pin = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
    expect(['localhost', '127.0.0.1']).toContain(pin.hostname);
    expect(Number(pin.port)).toBeGreaterThan(0);
    expect(Number(pin.port)).not.toBe(5432);
    const privateServer = postgres(process.env.HARNESS_ADMIN_DATABASE_URL!, { max: 1 });
    try {
      const [actual] = await privateServer`SHOW data_directory`;
      expect(actual.data_directory).toMatch(/\/papercusp-test-pg-[^/]+$/);
    } finally {
      await privateServer.end();
    }
    await ensureBootstrap();
    const [actual] = await getTxPool()`SELECT inet_server_port() AS port`;
    expect(Number(actual.port)).toBe(Number(pin.port));
  });

  afterAll(async () => {
    configurePeerInFlightEditsReaderForTests();
    __resetResourceDomainKindsForTest();
    await _resetListenersForTests();
    await _resetForTests();
  });

  it.each(['staging-server', 'staging-server-cooldown'])(
    'delivers the real registry declaration for %s without warming its diagnostic cache', async resource => {
      const registered = await registerTool.handler({ resource }, {
        isSuperuser: true, uiClientId: owner,
      } as never);
      if (!('content' in registered) || registered.content[0].type !== 'text') {
        throw new Error('Registration did not return text evidence');
      }
      expect(JSON.parse(registered.content[0].text).ok).toBe(true);
      expect((await readResourceCoordinationDomainKinds(getTxPool())).get(resource)).toBe('host-global');

      // Use the production registry loader, not the unit suite's injected map.
      // A passive read must leave a genuinely cold cache cold even when the
      // declaration already exists in this isolated database.
      __resetResourceDomainKindsForTest();
      const read = async () => {
        const result = await cacheStatsTool.handler({ resource }, {} as never);
        if (!('data' in result)) throw new Error('Cache diagnostic did not return data');
        return result.data as Record<string, unknown>;
      };
      const cold = await read();
      expect(cold.pid).toBe(process.pid);
      expect(cold.resourceDomainKinds).toMatchObject({
        source: 'current-process', loaded: false, loadedAtMs: null, lastError: null,
        declaration: { resource, kind: null },
      });
      expect(declaredResourceDomainKind(resource)).toBeNull();

      await ensureResourceDomainKindsFresh();
      const loaded = await read();
      expect(loaded.pid).toBe(cold.pid);
      expect(loaded.resourceDomainKinds).toMatchObject({
        source: 'current-process', loaded: true, lastError: null,
        declaration: { resource, kind: 'host-global' },
      });
      expect(loaded.resourceDomainKinds).toMatchObject({ loadedAtMs: expect.any(Number) });
      expect(resourceLockDomain(resource)).toBe(hostGlobalLockDomain());
      expect((await read()).resourceDomainKinds).toEqual(loaded.resourceDomainKinds);
      expect(execFile).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each(['staging-server', 'staging-server-cooldown'])(
    'publishes %s for an existing row and refreshes a reader without overwriting policy', async resource => {
      const original = await inWorkspaceTxn(hostGlobalLockDomain(), owner, async tx => {
        const registered = await registerResource(tx, { resource, description: 'Private retained policy',
          rule_text: 'Private existing policy', enforcement: 'enforced', max_holders: 3 });
        // Emulate an older install whose registry row is still undeclared.
        await stampResourceCoordinationDomainKind(tx, resource, 'tree');
        return registered.resource;
      });
      __resetResourceDomainKindsForTest();
      await ensureResourceDomainKindsFresh();
      expect(declaredResourceDomainKind(resource)).toBeNull();

      const result = await registerTool.handler({ resource }, {
        isSuperuser: true, uiClientId: owner,
      } as never);
      if (!('content' in result)) throw new Error('Registration did not return its measured result');
      const content = result.content[0];
      if (content.type !== 'text') throw new Error('Registration did not return text evidence');
      const body = JSON.parse(content.text);
      expect(body).toMatchObject({ ok: true, created: false, resource: original });
      expect((await readResourceCoordinationDomainKinds(getTxPool())).get(resource)).toBe('host-global');

      // The legacy reader consumes the registry declaration, independently of
      // the newer hardcoded host-resource set.
      __resetResourceDomainKindsForTest();
      await ensureResourceDomainKindsFresh();
      expect(declaredResourceDomainKind(resource)).toBe('host-global');
    });

  it.each([
    ['staging-server', 0], ['staging-server-cooldown', 0],
    ['staging-server', 0.02], ['staging-server-cooldown', 0.02],
  ] as const)(
    'a refreshed legacy declaration reader excludes a distinct-owner %s body with drain budget %s',
    async (resource, maxDrainSec) => {
      await inWorkspaceTxn(hostGlobalLockDomain(), owner, async tx => {
        await registerResource(tx, { resource });
        await stampResourceCoordinationDomainKind(tx, resource, 'tree');
      });
      __resetResourceDomainKindsForTest();
      await ensureResourceDomainKindsFresh();
      // Exercise the declaration-only branch used by an older reader whose
      // hardcoded host-resource set does not contain these two names. This
      // does not execute or attest the live older background-host process.
      const legacyDomain = () => declaredResourceDomainKind(resource) === 'host-global'
        ? hostGlobalLockDomain() : '/private/legacy-checkout';
      expect(legacyDomain()).toBe('/private/legacy-checkout');

      const published = await registerTool.handler({ resource }, {
        isSuperuser: true, uiClientId: owner,
      } as never);
      if (!('content' in published) || published.content[0].type !== 'text') {
        throw new Error('Registration did not return text evidence');
      }
      expect(JSON.parse(published.content[0].text)).toMatchObject({ ok: true, created: false });
      __resetResourceDomainKindsForTest();
      await ensureResourceDomainKindsFresh();
      const domain = legacyDomain();
      expect(domain).toBe(hostGlobalLockDomain());

      const probeOwner = `declaration-probe-${resource}-${maxDrainSec}`;
      const restartOwner = `declaration-restart-${resource}-${maxDrainSec}`;
      const held = await inWorkspaceTxn(domain, probeOwner, tx => tryAcquireResource(tx, {
        coordinationDomain: domain, resource, mode: 'shared', owner: probeOwner,
        ownerLabel: 'private probe', reason: 'declaration-reader regression', ttlSec: 30,
      }));
      const identity: AgentIdentity = {
        ownerId: restartOwner, ownerLabel: 'private restart', source: 'static-client',
        workspaceId: null, userId: null,
      };
      try {
        expect(held.ok).toBe(true);
        let bodyRuns = 0;
        const refused = await guardResource({ coordinationDomain: domain,
          ownerId: restartOwner, ownerLabel: identity.ownerLabel, coordIdentity: identity,
          resource, mode: 'exclusive', maxDrainSec,
        }, async () => { bodyRuns += 1; });
        expect(refused.acquired).toBe(false);
        expect(bodyRuns).toBe(0);
        const queue = await readResourceQueue(getTxPool(), { coordinationDomain: domain, resource });
        expect(queue.holders.some(holder => holder.owner === restartOwner)).toBe(false);
        expect(queue.holders.some(holder => holder.owner === probeOwner && holder.status === 'held')).toBe(true);
      } finally {
        await inWorkspaceTxn(domain, restartOwner, tx => tryReleaseResource(tx, {
          coordinationDomain: domain, resource, owner: restartOwner,
        }));
        await inWorkspaceTxn(domain, probeOwner, tx => tryReleaseResource(tx, {
          coordinationDomain: domain, resource, owner: probeOwner,
        }));
      }
      const after = await readResourceQueue(getTxPool(), { coordinationDomain: domain, resource });
      expect(after.holders.some(holder => [probeOwner, restartOwner].includes(holder.owner))).toBe(false);
    },
  );

  it.each([0, 0.02])(
    'the staging restart handler refuses a distinct-owner shared lease with drain budget %s',
    async maxDrainSec => {
      const domain = resourceLockDomain('staging-server', '/private/staging-generation');
      expect(domain).toBe(resourceLockDomain('staging-server', '/private/probe-checkout'));
      const probeOwner = `handler-probe-${maxDrainSec}`;
      const restartOwner = `handler-restart-${maxDrainSec}`;
      configurePeerInFlightEditsReaderForTests(async workingDirectory => ({
        checked: true, tree: workingDirectory, total: 0, files: [],
      }));
      vi.mocked(execFile).mockClear();
      vi.mocked(spawn).mockClear();
      let observedCooldown = false;
      vi.mocked(probeSystemdDaemonReloadNeed).mockImplementationOnce(async () => {
        const queue = await readResourceQueue(getTxPool(), {
          coordinationDomain: domain, resource: 'staging-server-cooldown',
        });
        observedCooldown = queue.holders.some(holder => holder.owner === restartOwner &&
          holder.mode === 'exclusive' && holder.status === 'held');
        return 'not-needed';
      });
      const held = await inWorkspaceTxn(domain, probeOwner, tx => tryAcquireResource(tx, {
        coordinationDomain: domain, resource: 'staging-server', mode: 'shared', owner: probeOwner,
        ownerLabel: 'private handler probe', reason: 'actual restart handler regression', ttlSec: 30,
      }));
      try {
        expect(held.ok).toBe(true);
        const result = await restartTool.handler({
          target: 'staging', confirm: true, authorize: true, max_drain_sec: maxDrainSec,
          reason: 'Private PG handler exclusion test',
        }, { isSuperuser: true, uiClientId: restartOwner } as never);
        if (!('content' in result) || result.content[0].type !== 'text') {
          throw new Error('Restart handler did not return text evidence');
        }
        const body = JSON.parse(result.content[0].text);
        expect(body).toMatchObject({ ok: false, target: 'staging', resource: 'staging-server' });
        expect(body.reason).toMatch(/^resource_/);
        expect(body.holders.some((holder: { owner: string }) => holder.owner === probeOwner)).toBe(true);
        expect(observedCooldown).toBe(true);
        expect(execFile).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
        for (const resource of ['staging-server', 'staging-server-cooldown']) {
          const queue = await readResourceQueue(getTxPool(), { coordinationDomain: domain, resource });
          expect(queue.holders.some(holder => holder.owner === restartOwner)).toBe(false);
          if (resource === 'staging-server') {
            expect(queue.holders.some(holder => holder.owner === probeOwner && holder.status === 'held')).toBe(true);
          }
        }
      } finally {
        for (const resource of ['staging-server', 'staging-server-cooldown']) {
          await inWorkspaceTxn(domain, restartOwner, tx => tryReleaseResource(tx, {
            coordinationDomain: domain, resource, owner: restartOwner,
          }));
        }
        await inWorkspaceTxn(domain, probeOwner, tx => tryReleaseResource(tx, {
          coordinationDomain: domain, resource: 'staging-server', owner: probeOwner,
        }));
      }
      const after = await readResourceQueue(getTxPool(), { coordinationDomain: domain, resource: 'staging-server' });
      expect(after.holders.some(holder => [probeOwner, restartOwner].includes(holder.owner))).toBe(false);
    },
  );
});
