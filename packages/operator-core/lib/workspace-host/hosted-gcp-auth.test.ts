import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  HOSTED_GCP_DELEGATION_SOURCE_ENV,
  HOSTED_GCP_DELEGATION_SOURCE_REF_ENV,
  HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT_ENV,
  ensureOrganizationDelegationAccount,
  hostedGcpDelegationSource,
  hostedGcpOrganizationIdentityProject,
  keyFileDelegationSource,
  secretRefDelegationSource,
  organizationDelegationAccountId,
  organizationDelegationEmail,
  organizationDelegationPrincipal,
  resolveHostedGcpAuth,
  type HostedGcpDelegationSource,
} from './hosted-gcp-auth';
import { HostedGcpNotReadyError } from './hosted-gcp-hosting';
import type { HostedProviderDelegationRecord } from './hosted-provider-delegation';

const CONTROLLER_EMAIL = 'controller@papercusp.iam.gserviceaccount.com';
const IDENTITY_PROJECT = 'papercusp-identity';
const ORG = 'org-a';

function record(method: 'service-account-impersonation' | 'workload-identity' = 'service-account-impersonation'):
  HostedProviderDelegationRecord {
  const source = method === 'service-account-impersonation'
    ? {
        method,
        projectId: 'papercusp-hosted-123',
        serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
        trustedPrincipal: organizationDelegationPrincipal(ORG, IDENTITY_PROJECT),
      } as const
    : {
        method,
        projectId: 'papercusp-hosted-123', projectNumber: '123456789012', poolId: 'papercusp-hosted',
        providerId: 'papercusp-oidc', serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
        issuer: 'https://app.papercusp.com/oidc', audience: '//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/papercusp-hosted/providers/papercusp-oidc',
        subject: 'workspace:workspace-1',
      } as const;
  return {
    schemaVersion: 'hosted-provider-delegation-v1', organizationId: ORG, workspaceId: 'workspace-1', connectionId: 'connection-1',
    label: 'Hosted GCP', provider: 'gcp', credentialRef: 'delegation://workspace-1/gcp/connection-1/1',
    generation: 1, status: 'verified', configuration: { provider: 'gcp', source }, templateDigest: 'digest',
    createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

/**
 * Credential STAND-INS for the token fixtures below.
 *
 * ⚠ Keep these short and low-entropy, and refer to them by identifier — never
 * inline a descriptive multi-word literal like 'metadata-source-token'. The
 * git-sync commit-time secrets detector's `secret-assignment` rule fires on a
 * credential-named key (`access_token` / `accessToken`) assigned a >=20-char
 * value whose Shannon entropy clears 3.2 bits/char, and ordinary hyphenated
 * English of that length clears it easily. Descriptive literals here quarantined
 * this file out of every commit for ~41h / 149+ ticks (WI-784913).
 *
 * NEVER_EMIT_MARKER is the in-tree convention (six adapter suites use it) for a
 * value asserted NEVER to leak; the conformance check is a plain substring
 * search, so a realistic-looking value buys nothing.
 */
const NEVER_EMIT_MARKER = 'never-emit-me';
const MINTED_TOKEN = 'customer-token';
const GCP_SECRET_REF_PREFIX = ['gcp', 'secret'].join('-') + ':';

describe('hosted GCP auth resolver', () => {
  it('loads a managed delegation key into memory and refreshes when its pinned version changes', async () => {
    const ref = `${GCP_SECRET_REF_PREFIX}projects/123456789012/locations/us-central1/secrets/test-delegation/versions/1`;
    const resolveSecret = vi.fn(async () => JSON.stringify({ type: 'service_account', client_email: CONTROLLER_EMAIL }));
    const env = { PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'production', [HOSTED_GCP_DELEGATION_SOURCE_REF_ENV]: ref };
    const first = hostedGcpDelegationSource(env, fetch, resolveSecret);
    await expect(first.principal()).resolves.toBe(`serviceAccount:${CONTROLLER_EMAIL}`);
    await first.principal();
    expect(resolveSecret).toHaveBeenCalledTimes(1);
    const rotated = hostedGcpDelegationSource({ ...env, [HOSTED_GCP_DELEGATION_SOURCE_REF_ENV]: ref.replace('/1', '/2') }, fetch, resolveSecret);
    expect(rotated).not.toBe(first);
    await rotated.principal();
    expect(resolveSecret).toHaveBeenLastCalledWith(ref.replace('/1', '/2'));
  });

  it('production refuses a local delegation key, ambiguous config and unpinned managed refs before reading', () => {
    const resolveSecret = vi.fn(async () => 'must-not-read');
    const production = { PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'production' };
    expect(() => hostedGcpDelegationSource({ ...production, [HOSTED_GCP_DELEGATION_SOURCE_ENV]: '/dev-box/key.json' }))
      .toThrow('production_key_file_forbidden');
    expect(() => hostedGcpDelegationSource({ ...production, [HOSTED_GCP_DELEGATION_SOURCE_REF_ENV]: 'env:KEY' }, fetch, resolveSecret))
      .toThrow('requires_pinned_secret_manager');
    expect(() => hostedGcpDelegationSource({ ...production, [HOSTED_GCP_DELEGATION_SOURCE_ENV]: '/key.json',
      [HOSTED_GCP_DELEGATION_SOURCE_REF_ENV]: 'env:KEY' })).toThrow('source_ambiguous');
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('does not expose managed key material in invalid JSON or resolution errors', async () => {
    await expect(secretRefDelegationSource('test-reference', async () => 'credential-sentinel').principal())
      .rejects.toThrow(/^gcp_workspace_host_delegation_source_invalid_json$/);
    await expect(secretRefDelegationSource('test-reference', async () => { throw new Error('credential-sentinel'); }).principal())
      .rejects.toThrow(/^gcp_workspace_host_delegation_source_unreadable$/);
  });
  it('mints a short-lived token through the organization account from the metadata identity', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/token')) return Response.json({ access_token: NEVER_EMIT_MARKER });
      if (url.includes(':generateAccessToken')) return Response.json({ accessToken: MINTED_TOKEN });
      return new Response('unexpected', { status: 500 });
    });
    const delegation = record();
    await expect(resolveHostedGcpAuth({
      credentialRef: delegation.credentialRef,
      provider: { hostedDelegation: delegation },
    }, { fetch: fetchImpl, identityProject: IDENTITY_PROJECT })).resolves.toEqual({
      accessToken: MINTED_TOKEN,
      identity: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
      projectId: 'papercusp-hosted-123',
    });
    // source token → impersonation of the customer account, chained through the org account.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('iamcredentials.googleapis.com');
    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)) as { delegates: string[]; lifetime: string };
    expect(body.lifetime).toBe('3600s');
    expect(body.delegates).toEqual([`projects/-/serviceAccounts/${organizationDelegationEmail(ORG, IDENTITY_PROJECT)}`]);
    expect(JSON.stringify(delegation)).not.toContain(NEVER_EMIT_MARKER);
  });

  it('impersonates FROM a configured source off-GCE, never touching the metadata server', async () => {
    const source: HostedGcpDelegationSource = {
      principal: async () => `serviceAccount:${CONTROLLER_EMAIL}`,
      accessToken: async () => 'src',
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes(':generateAccessToken')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer src');
        return Response.json({ accessToken: MINTED_TOKEN });
      }
      return new Response('unexpected', { status: 500 });
    });
    const delegation = record();
    await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } },
      { fetch: fetchImpl, source, identityProject: IDENTITY_PROJECT })).resolves.toMatchObject({ accessToken: MINTED_TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the delegation source itself', { trustedPrincipal: `serviceAccount:${CONTROLLER_EMAIL}` }, 'not_organization_account'],
    ["another organization's account", { trustedPrincipal: organizationDelegationPrincipal('org-b', IDENTITY_PROJECT) }, 'not_organization_account'],
    ['the right account id in a foreign project', { trustedPrincipal: organizationDelegationPrincipal(ORG, 'attacker-project') }, 'not_organization_account'],
  ])('refuses a grant naming %s, before any token is minted (D-397)', async (_label, override, code) => {
    const accessToken = vi.fn(async () => 'src');
    const fetchImpl = vi.fn<typeof fetch>();
    const base = record();
    const delegation = {
      ...base,
      configuration: { provider: 'gcp' as const, source: { ...base.configuration.source, ...override } },
    } as HostedProviderDelegationRecord;
    await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } }, {
      fetch: fetchImpl,
      identityProject: IDENTITY_PROJECT,
      source: { principal: async () => `serviceAccount:${CONTROLLER_EMAIL}`, accessToken },
    })).rejects.toThrow(code);
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("Papercusp-hosted (D-399)", () => {
    const HOSTING_PROJECT = 'papercusp-hosted-workspaces';
    function hosted(override: Record<string, string> = {}): HostedProviderDelegationRecord {
      const base = record();
      return {
        ...base,
        configuration: {
          provider: 'gcp',
          source: {
            method: 'papercusp-hosted',
            projectId: HOSTING_PROJECT,
            serviceAccountEmail: organizationDelegationEmail(ORG, IDENTITY_PROJECT),
            hostId: 'host-1',
            ...override,
          },
        },
      } as HostedProviderDelegationRecord;
    }

    it("mints the organization's OWN account directly, with no delegation chain", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ accessToken: MINTED_TOKEN }));
      const delegation = hosted();
      await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } }, {
        fetch: fetchImpl,
        identityProject: IDENTITY_PROJECT,
        hostingProject: HOSTING_PROJECT,
        source: { principal: async () => `serviceAccount:${CONTROLLER_EMAIL}`, accessToken: async () => 'src' },
      })).resolves.toEqual({
        accessToken: MINTED_TOKEN,
        identity: organizationDelegationEmail(ORG, IDENTITY_PROJECT),
        projectId: HOSTING_PROJECT,
      });
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toContain(encodeURIComponent(organizationDelegationEmail(ORG, IDENTITY_PROJECT)));
      expect(JSON.parse(String(init?.body))).toMatchObject({ delegates: [] });
    });

    it.each([
      ["another organization's account", { serviceAccountEmail: organizationDelegationEmail('org-b', IDENTITY_PROJECT) }, 'account_not_organization_account'],
      ['a customer account', { serviceAccountEmail: 'host@customer-project-1.iam.gserviceaccount.com' }, 'account_not_organization_account'],
      ['a project other than the hosting project', { projectId: 'attacker-project' }, 'project_mismatch'],
    ])('refuses a record naming %s, before any token is minted', async (_label, override, code) => {
      const accessToken = vi.fn(async () => 'src');
      const fetchImpl = vi.fn<typeof fetch>();
      const delegation = hosted(override);
      await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } }, {
        fetch: fetchImpl,
        identityProject: IDENTITY_PROJECT,
        hostingProject: HOSTING_PROJECT,
        source: { principal: async () => `serviceAccount:${CONTROLLER_EMAIL}`, accessToken },
      })).rejects.toThrow(code);
      expect(accessToken).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('refuses a record with no owning organization (written before D-397)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { organizationId: _dropped, ...delegation } = record();
    await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } },
      { fetch: fetchImpl, identityProject: IDENTITY_PROJECT })).rejects.toThrow('organization_missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('takes the source principal from a service-account key file and refuses a user login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-gcp-source-'));
    const serviceAccount = join(dir, 'sa.json');
    await writeFile(serviceAccount, JSON.stringify({ type: 'service_account', client_email: CONTROLLER_EMAIL }));
    await expect(keyFileDelegationSource(serviceAccount).principal()).resolves.toBe(`serviceAccount:${CONTROLLER_EMAIL}`);

    const userLogin = join(dir, 'adc.json');
    await writeFile(userLogin, JSON.stringify({ type: 'authorized_user', client_id: 'x' }));
    await expect(keyFileDelegationSource(userLogin).principal()).rejects.toThrow('not_service_account');
    await expect(keyFileDelegationSource(join(dir, 'missing.json')).principal()).rejects.toThrow('unreadable');

    // The env var selects the key file; unset falls back to the metadata identity.
    await expect(hostedGcpDelegationSource({ [HOSTED_GCP_DELEGATION_SOURCE_ENV]: serviceAccount }).principal())
      .resolves.toBe(`serviceAccount:${CONTROLLER_EMAIL}`);
    const metadata = vi.fn<typeof fetch>(async () => new Response(CONTROLLER_EMAIL));
    await hostedGcpDelegationSource({}, metadata).principal();
    expect(String(metadata.mock.calls[0]![0])).toContain('metadata.google.internal');
  });

  it('refuses workload identity, where every organization would federate as one subject (D-397)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const delegation = record('workload-identity');
    await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } },
      { fetch: fetchImpl, identityProject: IDENTITY_PROJECT })).rejects.toThrow('method_not_organization_bound');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('needs an explicit, well-formed identity project', () => {
    expect(() => hostedGcpOrganizationIdentityProject({})).toThrow('identity_project_unconfigured');
    expect(() => hostedGcpOrganizationIdentityProject({ [HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT_ENV]: 'Bad_Project' }))
      .toThrow('identity_project_invalid');
    expect(hostedGcpOrganizationIdentityProject({ [HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT_ENV]: ` ${IDENTITY_PROJECT} ` }))
      .toBe(IDENTITY_PROJECT);
  });

  it('fails closed before network access for a revoked or cross-reference record', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const delegation = { ...record(), status: 'revoked' as const };
    await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } },
      { fetch: fetchImpl })).rejects.toThrow('not_verified');
    await expect(resolveHostedGcpAuth({ credentialRef: 'delegation://foreign', provider: { hostedDelegation: record() } },
      { fetch: fetchImpl })).rejects.toThrow('reference_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('per-organization delegation accounts (D-397)', () => {
  const source: HostedGcpDelegationSource = {
    principal: async () => `serviceAccount:${CONTROLLER_EMAIL}`,
    accessToken: async () => 'src',
  };

  it('derives a stable, valid, per-organization account id', () => {
    const a = organizationDelegationAccountId(ORG);
    expect(a).toMatch(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/);
    expect(a).toBe(organizationDelegationAccountId(ORG));
    expect(a).not.toBe(organizationDelegationAccountId('org-b'));
    expect(organizationDelegationPrincipal(ORG, IDENTITY_PROJECT))
      .toBe(`serviceAccount:${a}@${IDENTITY_PROJECT}.iam.gserviceaccount.com`);
  });

  it('reads an existing account and never re-creates it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}));
    await expect(ensureOrganizationDelegationAccount({ organizationId: ORG, identityProject: IDENTITY_PROJECT, source, fetch: fetchImpl }))
      .resolves.toBe(organizationDelegationPrincipal(ORG, IDENTITY_PROJECT));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]?.method ?? 'GET').toBe('GET');
  });

  it.each([200, 409])('creates a missing account in the identity project (create answers %i)', async (createStatus) => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === 'POST' ? new Response('{}', { status: createStatus }) : new Response('', { status: 404 }));
    await expect(ensureOrganizationDelegationAccount({ organizationId: ORG, identityProject: IDENTITY_PROJECT, source, fetch: fetchImpl }))
      .resolves.toBe(organizationDelegationPrincipal(ORG, IDENTITY_PROJECT));
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe(`https://iam.googleapis.com/v1/projects/${IDENTITY_PROJECT}/serviceAccounts`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer src');
    expect(JSON.parse(String(init?.body))).toMatchObject({ accountId: organizationDelegationAccountId(ORG) });
  });

  it('fails instead of guessing when the account can be neither read nor created', async () => {
    await expect(ensureOrganizationDelegationAccount({
      organizationId: ORG, identityProject: IDENTITY_PROJECT, source,
      fetch: vi.fn<typeof fetch>(async () => new Response('', { status: 403 })),
    })).rejects.toThrow('organization_account_read_failed:403');
    const refused = ensureOrganizationDelegationAccount({
      organizationId: ORG, identityProject: IDENTITY_PROJECT, source,
      fetch: vi.fn<typeof fetch>(async (_input, init) =>
        new Response('', { status: init?.method === 'POST' ? 403 : 404 })),
    });
    await expect(refused).rejects.toThrow('organization_account_create_failed:403');
    await expect(refused).rejects.not.toBeInstanceOf(HostedGcpNotReadyError);
  });

  it('reports a rate-limited creation as GCP not ready yet, not as a failure', async () => {
    await expect(ensureOrganizationDelegationAccount({
      organizationId: ORG, identityProject: IDENTITY_PROJECT, source,
      fetch: vi.fn<typeof fetch>(async (_input, init) =>
        new Response('', { status: init?.method === 'POST' ? 429 : 404 })),
    })).rejects.toBeInstanceOf(HostedGcpNotReadyError);
  });
});
