import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import {
  admissionIdentity,
  createHostedWorkspaceAdmission,
  HostedWorkspaceAdmissionError,
  type HostedWorkspaceAdmissionDependencies,
  type HostedWorkspaceBinding,
} from './workspace-admission';

const CONTROL_PLANE = 'papercusp-workspace';
const ORG = 'e91577da-655b-4b24-b122-ab57b4f9d211';
const OTHER_ORG = '0b27bff1-70e8-4bbe-bef1-2fde87f5f156';
const USER = '75d665e8-ed7b-4dbd-af19-a4de83289bde';

/**
 * The admission module treats the desired spec as an opaque value it forwards — it never
 * inspects a field — so a cast keeps these tests exercising the ADMISSION contract rather
 * than re-asserting the provider spec schema, which has its own tests.
 */
const SPEC = { hostId: 'host-x', target: 'gcp', region: 'us-central1' } as unknown as WorkspaceHostDesiredSpec;

interface Harness {
  port: ReturnType<typeof createHostedWorkspaceAdmission>;
  calls: string[];
  bindings: Map<string, HostedWorkspaceBinding>;
  provisioned: Array<{ operationId: string; hostId: string }>;
}

function harness(
  overrides: Partial<HostedWorkspaceAdmissionDependencies> & {
    seedBindings?: HostedWorkspaceBinding[];
  } = {},
): Harness {
  const calls: string[] = [];
  const bindings = new Map<string, HostedWorkspaceBinding>();
  for (const seed of overrides.seedBindings ?? []) bindings.set(seed.workspaceId, seed);
  const provisioned: Array<{ operationId: string; hostId: string }> = [];

  const deps: HostedWorkspaceAdmissionDependencies = {
    controlPlaneWorkspaceId: () => CONTROL_PLANE,
    readConnection: async (_ws, connectionId) => {
      calls.push('readConnection');
      return { id: connectionId };
    },
    readBinding: async (_ws, workspaceId) => {
      calls.push('readBinding');
      return bindings.get(workspaceId) ?? null;
    },
    resolveDesiredSpec: async ({ hostId }) => {
      calls.push('resolveDesiredSpec');
      // A CONFORMING resolver returns a spec for the host it was asked about. Returning a
      // fixed id here would make this double weaker than the real contract, which refuses
      // a divergent spec outright (see the 'spec_host_mismatch' case below).
      return { ...SPEC, hostId };
    },
    upsertHost: async () => {
      calls.push('upsertHost');
    },
    bindWorkspace: async (input) => {
      calls.push('bindWorkspace');
      if (bindings.has(input.workspaceId)) return { created: false };
      bindings.set(input.workspaceId, {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        workspaceHostId: input.workspaceHostId,
        state: 'provisioning',
      });
      return { created: true };
    },
    startProvisioning: (input) => {
      calls.push('startProvisioning');
      provisioned.push({ operationId: input.operationId, hostId: input.hostId });
    },
    ...overrides,
  };

  return { port: createHostedWorkspaceAdmission(deps), calls, bindings, provisioned };
}

const request = {
  organizationId: ORG,
  userId: USER,
  provider: 'gcp' as const,
  connectionId: 'gcp:byoc-canary-gcp',
  displayName: 'My first workspace',
  operationKey: 'attempt-1:workspace',
};

describe('hosted workspace admission', () => {
  it('uses durable pool admission and retries it after a lost enqueue without rewriting the binding', async () => {
    const admitAndStart = vi.fn<NonNullable<HostedWorkspaceAdmissionDependencies['admitAndStart']>>()
      .mockRejectedValueOnce(new Error('executor unavailable')).mockResolvedValue(undefined);
    const h = harness({ admitAndStart });
    await expect(h.port.ensureProvisioned(request)).rejects.toThrow('executor unavailable');
    const writes = h.calls.filter(value => value === 'upsertHost' || value === 'bindWorkspace').length;
    await h.port.ensureProvisioned(request);
    expect(h.provisioned).toHaveLength(0);
    expect(admitAndStart).toHaveBeenCalledTimes(2);
    expect(admitAndStart.mock.calls[1]).toEqual(admitAndStart.mock.calls[0]);
    expect(h.calls.filter(value => value === 'upsertHost' || value === 'bindWorkspace')).toHaveLength(writes);
  });

  it('admits a first workspace and returns a stable identity pair', async () => {
    const h = harness();
    const result = await h.port.ensureProvisioned(request);

    const expected = admissionIdentity(ORG, request.operationKey);
    expect(result.workspaceId).toBe(expected.workspaceId);
    expect(result.provisionOperationId).toBe(expected.provisionOperationId);
    expect(h.bindings.get(result.workspaceId)?.organizationId).toBe(ORG);
    // A newly admitted workspace is NOT active yet — the VM is still coming up.
    expect(h.bindings.get(result.workspaceId)?.state).toBe('provisioning');
    expect(h.provisioned).toEqual([{ operationId: expected.provisionOperationId, hostId: expected.hostId }]);
  });

  it('creates the host BEFORE the binding, because workspace_host_id is NOT NULL and FKs workspace_hosts', async () => {
    const h = harness();
    await h.port.ensureProvisioned(request);
    expect(h.calls.indexOf('upsertHost')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('upsertHost')).toBeLessThan(h.calls.indexOf('bindWorkspace'));
  });

  it('enqueues provisioning only AFTER the binding is durable', async () => {
    const h = harness();
    await h.port.ensureProvisioned(request);
    expect(h.calls.indexOf('bindWorkspace')).toBeLessThan(h.calls.indexOf('startProvisioning'));
  });

  it('is idempotent on replay: same operationKey re-uses the workspace and does not provision twice', async () => {
    const h = harness();
    const first = await h.port.ensureProvisioned(request);
    const second = await h.port.ensureProvisioned(request);

    expect(second).toEqual(first);
    expect(h.bindings.size).toBe(1);
    expect(h.provisioned).toHaveLength(1);
    expect(h.calls.filter((c) => c === 'startProvisioning')).toHaveLength(1);
  });

  it('refuses to adopt a workspace bound to another organization', async () => {
    const identity = admissionIdentity(ORG, request.operationKey);
    const h = harness({
      seedBindings: [
        {
          workspaceId: identity.workspaceId,
          organizationId: OTHER_ORG,
          workspaceHostId: identity.hostId,
          state: 'active',
        },
      ],
    });

    await expect(h.port.ensureProvisioned(request)).rejects.toMatchObject({
      code: 'organization_mismatch',
    });
    // The refusal must be total: no host written, nothing provisioned for the wrong tenant.
    expect(h.calls).not.toContain('upsertHost');
    expect(h.provisioned).toHaveLength(0);
  });

  it('refuses a requestedWorkspaceId that belongs to another organization (no takeover)', async () => {
    const h = harness({
      seedBindings: [
        {
          workspaceId: 'someone-elses-workspace',
          organizationId: OTHER_ORG,
          workspaceHostId: 'their-host',
          state: 'active',
        },
      ],
    });

    await expect(
      h.port.ensureProvisioned({ ...request, requestedWorkspaceId: 'someone-elses-workspace' }),
    ).rejects.toBeInstanceOf(HostedWorkspaceAdmissionError);
    expect(h.provisioned).toHaveLength(0);
  });

  it('refuses an unknown connection before writing anything', async () => {
    const h = harness({ readConnection: async () => null });
    await expect(h.port.ensureProvisioned(request)).rejects.toMatchObject({
      code: 'connection_not_found',
    });
    expect(h.calls).not.toContain('upsertHost');
    expect(h.calls).not.toContain('bindWorkspace');
  });

  it('does not enqueue a second provision when it loses the binding race', async () => {
    // bindWorkspace reports created:false — another concurrent admission won the INSERT.
    const h = harness({ bindWorkspace: async () => ({ created: false }) });
    await h.port.ensureProvisioned(request);
    expect(h.provisioned).toHaveLength(0);
  });

  it('rejects missing required input', async () => {
    const h = harness();
    await expect(h.port.ensureProvisioned({ ...request, organizationId: '  ' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  describe('admissionIdentity', () => {
    it('is stable for the same organization and operationKey', () => {
      expect(admissionIdentity(ORG, 'k')).toEqual(admissionIdentity(ORG, 'k'));
    });

    it('never collides across organizations that share an operationKey', () => {
      expect(admissionIdentity(ORG, 'k').workspaceId).not.toBe(admissionIdentity(OTHER_ORG, 'k').workspaceId);
    });

    it('separates its fields so a shifted boundary cannot alias two identities', () => {
      // Without a separator, ('ab','c') and ('a','bc') would hash identically.
      expect(admissionIdentity('ab', 'c').workspaceId).not.toBe(admissionIdentity('a', 'bc').workspaceId);
    });
  });

  describe('resolveSelectable', () => {
    const binding = (organizationId: string, state: string): HostedWorkspaceBinding => ({
      workspaceId: 'ws-1',
      organizationId,
      workspaceHostId: 'host-1',
      state,
    });

    it('accepts a live workspace owned by the asking organization', async () => {
      const h = harness({ seedBindings: [binding(ORG, 'active')] });
      await expect(h.port.resolveSelectable({ organizationId: ORG, userId: USER, workspaceId: 'ws-1' })).resolves.toBe(
        true,
      );
    });

    it('still accepts one that is provisioning', async () => {
      const h = harness({ seedBindings: [binding(ORG, 'provisioning')] });
      await expect(h.port.resolveSelectable({ organizationId: ORG, userId: USER, workspaceId: 'ws-1' })).resolves.toBe(
        true,
      );
    });

    it('rejects another organization', async () => {
      const h = harness({ seedBindings: [binding(OTHER_ORG, 'active')] });
      await expect(h.port.resolveSelectable({ organizationId: ORG, userId: USER, workspaceId: 'ws-1' })).resolves.toBe(
        false,
      );
    });

    it('rejects a deleted workspace even for its owner', async () => {
      const h = harness({ seedBindings: [binding(ORG, 'deleted')] });
      await expect(h.port.resolveSelectable({ organizationId: ORG, userId: USER, workspaceId: 'ws-1' })).resolves.toBe(
        false,
      );
    });

    it('rejects a workspace that does not exist', async () => {
      const h = harness();
      await expect(
        h.port.resolveSelectable({ organizationId: ORG, userId: USER, workspaceId: 'nope' }),
      ).resolves.toBe(false);
    });
  });

  describe('spec/host identity', () => {
    it('refuses a resolved spec naming a different host, before any write', async () => {
      // The provisioning runner takes the host identity from the SPEC while the binding
      // references the DERIVED host. If those disagree, every call succeeds and the
      // workspace is silently bound to a host that is never built — so this must fail
      // loudly, and must fail BEFORE the host/binding writes rather than after them.
      const h = harness({
        resolveDesiredSpec: async () => ({ ...SPEC, hostId: 'some-other-host' }),
      });

      await expect(
        h.port.ensureProvisioned({
          organizationId: ORG,
          userId: USER,
          provider: 'gcp',
          connectionId: 'conn-1',
          displayName: 'Divergent',
          operationKey: 'key-divergent',
        }),
      ).rejects.toMatchObject({ code: 'spec_host_mismatch' });

      expect(h.calls).not.toContain('upsertHost');
      expect(h.calls).not.toContain('bindWorkspace');
      expect(h.provisioned).toHaveLength(0);
    });
  });
});
