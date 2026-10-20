import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  resolveOperationBoundaryProfile,
  type BoundaryProfileDeps,
} from './boundary-profile';
import type { SessionToolConfinement } from '../../capability-envelope/session-confinement';
import { capabilityExecSandboxPolicy } from './exec-sandbox';

const none: BoundaryProfileDeps = {
  declaredConfinement: async () => null,
};

const declared: SessionToolConfinement = {
  denyTools: ['work_items:complete'],
  reason: 'directed implementation',
  imposedBy: 'pair-director su-director',
};

describe('resolveOperationBoundaryProfile', () => {
  it('keeps an ordinary authenticated superuser operation trusted', async () => {
    await expect(
      resolveOperationBoundaryProfile({ isSuperuser: true, role: 'operator' }, none),
    ).resolves.toEqual({ kind: 'trusted', reason: 'superuser' });
  });

  it('keeps the legacy direct-handler su context trusted without admitting a signed-spawn role', async () => {
    await expect(
      resolveOperationBoundaryProfile({ role: 'su' as never }, none),
    ).resolves.toEqual({ kind: 'trusted', reason: 'legacy-su-context' });
  });

  it('keeps the in-process system operator trusted', async () => {
    await expect(
      resolveOperationBoundaryProfile(
        {
          principal: {
            kind: 'system',
            slug: 'system:operator',
            workspaceId: 'workspace-a',
          },
          role: 'operator',
        },
        none,
      ),
    ).resolves.toEqual({ kind: 'trusted', reason: 'system-operator' });
  });

  it('treats a signed autonomous caller as confined', async () => {
    const result = await resolveOperationBoundaryProfile(
      { role: 'worker', sigVerifiedSpawn: true, uiClientId: 's-worker' },
      none,
    );
    expect(result).toEqual({ kind: 'confined', reason: 'autonomous-caller' });
  });

  it('turns an autonomous caller into a required exec sandbox without consulting the rollout flag', async () => {
    await expect(
      capabilityExecSandboxPolicy({ role: 'worker' }),
    ).resolves.toEqual({
      enabled: true,
      required: true,
      profile: { kind: 'confined', reason: 'autonomous-caller' },
    });
  });

  it('lets launch-declared confinement override superuser privilege', async () => {
    const result = await resolveOperationBoundaryProfile(
      { isSuperuser: true, role: 'operator', uiClientId: 'su-directed' },
      { declaredConfinement: async () => declared },
    );
    expect(result).toEqual({
      kind: 'confined',
      reason: 'session-confinement',
      confinement: declared,
    });
  });

  // EI-26515377589991990: an acceptance judge launched through the SU-bearer spawn door
  // (orchestrator spawn-mcp.ts sets superuser=1 plus role=judge) carries isSuperuser:true.
  // That flag must not lift the judge's raw network/exec operations to the trusted tier.
  it('confines a judge even when the SU-bearer door marks it superuser or power-user', async () => {
    await expect(
      resolveOperationBoundaryProfile(
        { isSuperuser: true, role: 'judge' as never, uiClientId: 'spawn-judge' },
        none,
      ),
    ).resolves.toEqual({ kind: 'confined', reason: 'evidence-role' });
    await expect(
      resolveOperationBoundaryProfile(
        { isSuperuser: true, isPowerUser: true, role: 'judge' as never },
        none,
      ),
    ).resolves.toEqual({ kind: 'confined', reason: 'evidence-role' });
  });

  it('confines a signed role-scoped judge spawn', async () => {
    await expect(
      resolveOperationBoundaryProfile(
        { role: 'judge' as never, sigVerifiedSpawn: true, uiClientId: 's-judge' },
        none,
      ),
    ).resolves.toEqual({ kind: 'confined', reason: 'evidence-role' });
  });

  it('gives a superuser-flagged judge the required exec sandbox', async () => {
    await expect(
      capabilityExecSandboxPolicy({ isSuperuser: true, role: 'judge' as never }),
    ).resolves.toEqual({
      enabled: true,
      required: true,
      profile: { kind: 'confined', reason: 'evidence-role' },
    });
  });

  it('still lets a launch-declared confinement win over the judge rule', async () => {
    await expect(
      resolveOperationBoundaryProfile(
        { isSuperuser: true, role: 'judge' as never, uiClientId: 'spawn-judge' },
        { declaredConfinement: async () => declared },
      ),
    ).resolves.toEqual({ kind: 'confined', reason: 'session-confinement', confinement: declared });
  });

  it('fails a resolver fault and an unattributed context toward confinement', async () => {
    await expect(
      resolveOperationBoundaryProfile(
        {},
        { declaredConfinement: async () => { throw new Error('store unavailable'); } },
      ),
    ).resolves.toEqual({ kind: 'confined', reason: 'unattributed-caller' });
    await expect(resolveOperationBoundaryProfile({}, none)).resolves.toEqual({
      kind: 'confined',
      reason: 'unattributed-caller',
    });
  });
});

describe('operation-boundary handler wiring — resource parity', () => {
  const source = (file: string): string =>
    readFileSync(new URL(file, import.meta.url), 'utf8');

  it.each([
    // bash now has one durable startBackground seam for both response modes;
    // git and inspect still have two distinct subprocess seams.
    ['bash.ts', 1],
    ['git.ts', 2],
    ['inspect.ts', 2],
  ] as const)('%s resolves the server profile and passes required confinement to every spawn', (file, requiredUses) => {
    const text = source(file);
    expect(text).toContain('await capabilityExecSandboxPolicy(ctx)');
    expect(text.match(/sandboxPolicy\.required/g)).toHaveLength(requiredUses);
  });

  it('fetch.ts resolves the same server profile and carries it through policy plus bounded streaming', () => {
    const text = source('fetch.ts');
    expect(text).toContain('await resolveOperationBoundaryProfile(ctx)');
    expect(text).toContain('await fetchWithCapabilityPolicy({');
    expect(text).toMatch(/fetchWithCapabilityPolicy\(\{[\s\S]*?profile,[\s\S]*?maxRedirects:/);
    expect(text).toMatch(/readResponseBody\(res, maxBytes, ctx\.stateDir, maxDownloadBytes\)/);
  });
});
