import { describe, expect, it, vi } from 'vitest';

import type { RouteContext } from '../../define-route';
import { routeRegistrationOrder } from '../../register';
import { WorkspaceHostAgentCredentialMaterialError } from '../../../workspace-host/agent-credential-material-producer';
import { WorkspaceHostAgentCredentialSourceError } from '../../../workspace-host/agent-credential-source-selector';
import {
  createWorkspaceHostAgentCredentialsRoute,
  type WorkspaceHostAgentCredentialsRouteDependencies,
} from './agent-credentials';

const HOST_ID = 'owner-wait-20260916';
const REF = `pc-agent-forward://${HOST_ID}/default`;

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: { hostId: HOST_ID },
  log: () => {},
  signal: new AbortController().signal,
};

const SOURCES = {
  claude: { kind: 'operator-home-file' },
  codex: { kind: 'operator-home-file' },
  omp: { kind: 'absent' },
};

function harness(overrides: Partial<WorkspaceHostAgentCredentialsRouteDependencies> = {}) {
  const writeKey = vi.fn(async () => {});
  const deps: WorkspaceHostAgentCredentialsRouteDependencies = {
    resolveSources: vi.fn(async () => ({
      files: {
        claude: Buffer.from('{"claude":1}', 'utf8'),
        codex: Buffer.from('{"codex":1}', 'utf8'),
        omp: null,
      },
      resolved: {
        claude: { source: 'operator-home-file:/home/x/.claude/.credentials.json', bytes: 12 },
        codex: { source: 'operator-home-file:/home/x/.codex/auth.json', bytes: 11 },
        omp: { source: 'absent', bytes: 0 },
      },
      notices: ['stub-notice: pass-through only, not the real notice text'],
    })) as unknown as WorkspaceHostAgentCredentialsRouteDependencies['resolveSources'],
    storeMaterial: vi.fn(async (input) => ({
      key: `derived-key:${input.generation}`,
      generation: input.generation,
      materialBytes: 42,
    })) as unknown as WorkspaceHostAgentCredentialsRouteDependencies['storeMaterial'],
    buildMaterial: vi.fn(() => 'encoded-material'),
    deriveKey: vi.fn((_ref: string, generation: number) => `derived-key:${generation}`),
    writeKey,
    findCustomerWorkspaceForHost: vi.fn(async () => null),
    ...overrides,
  };
  return { deps, writeKey, route: createWorkspaceHostAgentCredentialsRoute(deps) };
}

function post(body: unknown): Request {
  return new Request(`http://127.0.0.1/api/workspace-hosts/${HOST_ID}/agent-credentials`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /workspace-hosts/:hostId/agent-credentials', () => {
  it('is registered and loopback-only — it can reach a credential store', () => {
    // Registration is the half a new route silently fails: the file can be perfect and the route
    // simply never mounted, which reads at the far end as "the endpoint does not exist".
    const registered = routeRegistrationOrder().find(
      (entry) => entry.path === '/workspace-hosts/:hostId/agent-credentials',
    );
    expect(registered, 'route must be registered in routes/index.ts').toBeDefined();
    expect(registered?.method).toBe('POST');
    // A route that writes credential material must never be reachable off-box.
    expect(harness().route.auth).toBe('loopback');
  });

  it('stores a generation and returns a receipt carrying no credential content', async () => {
    const { route, writeKey, deps } = harness();
    const res = await route.handler(post({ credentialRef: REF, generation: 3, sources: SOURCES }), CTX);
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.stored).toBe(true);
    expect(json.key).toBe('derived-key:3');
    expect(json.materialBytes).toBe(42);
    expect(json.notices).toEqual(['stub-notice: pass-through only, not the real notice text']);

    // The producer is reached with the RESOLVED bytes and the route's own writer seam.
    expect(deps.storeMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ credentialRef: REF, generation: 3 }),
      writeKey,
    );
    // Nothing decoded from the resolved files may appear in the response.
    expect(JSON.stringify(json)).not.toContain('"claude":1');
  });

  it('never accepts credential bytes in the body — a value-shaped source is refused by the resolver', async () => {
    // The whole point of a selector: an endpoint body is logged, so bytes must not be expressible.
    // The route forwards `sources` verbatim, so this asserts the resolver is the one authority and
    // the route adds no bypass of its own.
    const resolveSources = vi.fn(async () => {
      throw new WorkspaceHostAgentCredentialSourceError('claude', 'named an unrecognized kind.');
    });
    const { route, deps } = harness({
      resolveSources: resolveSources as unknown as WorkspaceHostAgentCredentialsRouteDependencies['resolveSources'],
    });
    const res = await route.handler(
      post({
        credentialRef: REF,
        generation: 1,
        sources: { ...SOURCES, claude: { kind: 'value', value: 'sk-live-secret' } },
      }),
      CTX,
    );
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    // The refusal is returned verbatim because the error class is authored to name the slot
    // without echoing what it read — and the smuggled value must not survive anywhere in it.
    expect(body).toMatch(/agent credential source for 'claude'/);
    expect(body).not.toContain('sk-live-secret');
    expect(deps.storeMaterial).not.toHaveBeenCalled();
  });

  it('refuses a credentialRef whose host does not match the request path', async () => {
    const { route, deps } = harness();
    const res = await route.handler(
      post({
        credentialRef: 'pc-agent-forward://some-other-host/default',
        generation: 1,
        sources: SOURCES,
      }),
      CTX,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/names host 'some-other-host'/);
    // Refused BEFORE anything is read or written — a mismatch must not touch a credential.
    expect(deps.resolveSources).not.toHaveBeenCalled();
    expect(deps.storeMaterial).not.toHaveBeenCalled();
  });

  it('refuses a non-agent credential reference rather than keying it into the agent namespace', async () => {
    const { route, deps } = harness();
    const res = await route.handler(
      post({
        credentialRef: `pc-cloud-workload://gcp/project/${HOST_ID}`,
        generation: 1,
        sources: SOURCES,
      }),
      CTX,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a valid agent reference/);
    expect(deps.storeMaterial).not.toHaveBeenCalled();
  });

  it('refuses a non-positive or non-integer generation', async () => {
    const { route } = harness();
    for (const generation of [0, -1, 1.5, '2']) {
      const res = await route.handler(post({ credentialRef: REF, generation, sources: SOURCES }), CTX);
      expect(res.status, `generation=${String(generation)}`).toBe(400);
    }
  });

  it('refuses a request with no sources object, naming the three slots', async () => {
    const { route } = harness();
    const res = await route.handler(post({ credentialRef: REF, generation: 1 }), CTX);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/claude, codex, omp/);
  });

  it('dry run encodes through the admission gate but writes nothing', async () => {
    const { route, writeKey, deps } = harness();
    const res = await route.handler(
      post({ credentialRef: REF, generation: 7, sources: SOURCES, dryRun: true }),
      CTX,
    );
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.ok).toBe(true);
    expect(json.stored).toBe(false);
    expect(json.key).toBe('derived-key:7');
    // The encode step IS the admission gate; a dry run that skipped it would report success for
    // material the real call would refuse.
    expect(deps.buildMaterial).toHaveBeenCalledTimes(1);
    expect(deps.storeMaterial).not.toHaveBeenCalled();
    expect(writeKey).not.toHaveBeenCalled();
  });

  it('surfaces an admission-gate refusal as a 400 naming the failure, not a 500', async () => {
    const buildMaterial = vi.fn(() => {
      throw new WorkspaceHostAgentCredentialMaterialError(
        'agent-home material would be refused by the admission gate at bind time: bad contract version',
      );
    });
    const { route } = harness({ buildMaterial });
    const res = await route.handler(
      post({ credentialRef: REF, generation: 1, sources: SOURCES, dryRun: true }),
      CTX,
    );
    // A caller-fixable refusal must not be reported as an operator fault: the dry run exists to
    // hand back exactly this, before a real credential is pointed at a real host.
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toMatch(/admission gate/);
    expect(json.errorKind).toBe('WorkspaceHostAgentCredentialMaterialError');
  });

  describe('R-24: never delivers service-held credentials into a customer workspace', () => {
    const BINDING = { customerWorkspaceId: 'ws-customer-1', organizationId: 'org-1', deleted: false };

    it.each([false, true])(
      'refuses a customer-bound host with 409 before reading any source (dryRun=%s)',
      async (dryRun) => {
        const findCustomerWorkspaceForHost = vi.fn(async () => BINDING);
        const { route, deps, writeKey } = harness({ findCustomerWorkspaceForHost });
        const res = await route.handler(
          post({ credentialRef: REF, generation: 1, sources: SOURCES, dryRun }),
          CTX,
        );
        expect(res.status).toBe(409);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.errorKind).toBe('customer_workspace_service_credential_refused');
        expect(json.customerWorkspaceId).toBe('ws-customer-1');
        expect(json.slots).toEqual(['claude', 'codex']);
        expect(findCustomerWorkspaceForHost).toHaveBeenCalledWith(HOST_ID);
        // Refused BEFORE the operator's own credential bytes are read, not merely before storage.
        expect(deps.resolveSources).not.toHaveBeenCalled();
        expect(deps.storeMaterial).not.toHaveBeenCalled();
        expect(writeKey).not.toHaveBeenCalled();
      },
    );

    it('refuses an integration-key source and a deleted customer binding alike', async () => {
      const { route, deps } = harness({
        findCustomerWorkspaceForHost: vi.fn(async () => ({ ...BINDING, deleted: true })),
      });
      const res = await route.handler(
        post({
          credentialRef: REF,
          generation: 1,
          sources: { claude: { kind: 'integration-key', name: 'ANTHROPIC_API_KEY' }, omp: { kind: 'absent' } },
        }),
        CTX,
      );
      expect(res.status).toBe(409);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.slots).toEqual(['claude']);
      expect(json.error).toMatch(/\(deleted\)/);
      expect(deps.resolveSources).not.toHaveBeenCalled();
    });

    it('treats an unknown source kind as service-held rather than waving it through', async () => {
      const { route, deps } = harness({ findCustomerWorkspaceForHost: vi.fn(async () => BINDING) });
      const res = await route.handler(
        post({ credentialRef: REF, generation: 1, sources: { claude: { kind: 'customer-supplied' } } }),
        CTX,
      );
      expect(res.status).toBe(409);
      expect(deps.resolveSources).not.toHaveBeenCalled();
    });

    it('fails closed with 503 when the customer binding cannot be read', async () => {
      const { route, deps, writeKey } = harness({
        findCustomerWorkspaceForHost: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      });
      const res = await route.handler(
        post({ credentialRef: REF, generation: 1, sources: SOURCES }),
        CTX,
      );
      expect(res.status).toBe(503);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.errorKind).toBe('customer_binding_unverified');
      expect(deps.resolveSources).not.toHaveBeenCalled();
      expect(writeKey).not.toHaveBeenCalled();
    });

    it('does not consult the binding when every slot is absent (nothing service-held is read)', async () => {
      const findCustomerWorkspaceForHost = vi.fn(async () => BINDING);
      const { route } = harness({ findCustomerWorkspaceForHost });
      await route.handler(
        post({ credentialRef: REF, generation: 1, sources: { omp: { kind: 'absent' } }, dryRun: true }),
        CTX,
      );
      expect(findCustomerWorkspaceForHost).not.toHaveBeenCalled();
    });

    it('still stores for an operator host that serves no customer workspace', async () => {
      const findCustomerWorkspaceForHost = vi.fn(async () => null);
      const { route, deps } = harness({ findCustomerWorkspaceForHost });
      const res = await route.handler(
        post({ credentialRef: REF, generation: 1, sources: SOURCES }),
        CTX,
      );
      expect(res.status).toBe(200);
      expect(findCustomerWorkspaceForHost).toHaveBeenCalledWith(HOST_ID);
      expect(((await res.json()) as Record<string, unknown>).stored).toBe(true);
      expect(deps.storeMaterial).toHaveBeenCalledTimes(1);
    });
  });
});
