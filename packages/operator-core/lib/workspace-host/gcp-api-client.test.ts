import type {
  WorkspaceHostDesiredSpec,
  WorkspaceHostProviderConnection,
  WorkspaceHostProviderContext,
} from '@papercusp/deployment-driver';
import { describe, expect, it, vi } from 'vitest';
import {
  GCP_BILLING_EXPORT_MAX_BYTES_BILLED,
  GoogleBigQueryBillingExportReader,
  GoogleComputeWorkspaceHostApiClient,
  recreateInput as gcpRecreateInput,
  parseGcpBillingExportDescriptor,
} from './gcp-api-client';
import {
  createAdcGcpWorkspaceHostProvider,
  type GcpDiskInsertInput,
  type GcpInstanceInsertInput,
  type GcpNatInsertInput,
  type GcpOperationRef,
  type GcpRouterInsertInput,
} from './gcp-provider';
import { censusGcpWorkspaceHostResources } from './gcp-safety';

const PROJECT = 'active-alcove-504205-q3';
const ZONE = 'us-central1-a';
const REGION = 'us-central1';
const TOKEN = 'ya29.must-never-escape';
const NOW = '2026-08-22T07:30:00.000Z';
const REQUEST_ID = '5c4b3b5e-80f8-55f2-9499-8b52e1efce24';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function connection(): WorkspaceHostProviderConnection {
  return {
    target: 'gcp',
    cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' },
    scope: { kind: 'project', id: PROJECT },
    provider: { projectId: PROJECT, credentialSource: 'adc' },
  };
}

function makeClient(fetchImpl: typeof fetch): GoogleComputeWorkspaceHostApiClient {
  return new GoogleComputeWorkspaceHostApiClient({
    acquireAuth: vi.fn(async () => ({ accessToken: TOKEN, projectId: PROJECT, identity: 'operator@example.com' })),
    fetch: fetchImpl,
    now: () => NOW,
  });
}

const BILLING_EXPORT = {
  schemaVersion: 'gcp-billing-export-v1',
  projectId: PROJECT,
  datasetId: 'cloud_billing_export',
  tableId: 'gcp_billing_export_v1_01A2B3_C4D5E6_789ABC',
  location: 'US',
  labelKey: 'papercusp_run_id',
  maximumBytesBilled: '1000000000',
} as const;

function makeBillingReader(fetchImpl: typeof fetch): GoogleBigQueryBillingExportReader {
  return new GoogleBigQueryBillingExportReader({
    acquireAuth: vi.fn(async () => ({ accessToken: TOKEN, projectId: PROJECT, identity: 'operator@example.com' })),
    fetch: fetchImpl,
    now: () => NOW,
  });
}

describe('GCP Cloud Billing export reader', () => {
  it('uses bounded public BigQuery REST and preserves exact gross, credit, net, and conservative cents', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        useLegacySql: false,
        parameterMode: 'NAMED',
        maximumBytesBilled: '1000000000',
        maxResults: '2',
        timeoutMs: 10_000,
        location: 'US',
      });
      expect(String(body.query)).toContain(
        `FROM \`${PROJECT}.cloud_billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_789ABC\``,
      );
      expect(String(body.query)).toContain('UNNEST(labels)');
      expect(String(body.query)).not.toContain('BillingData');
      expect(body.queryParameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'label_key', parameterValue: { value: 'papercusp_run_id' } }),
          expect.objectContaining({ name: 'run_id', parameterValue: { value: 'r4' } }),
        ]),
      );
      return json({
        jobComplete: true,
        jobReference: { projectId: PROJECT, jobId: 'billing-query-r4', location: 'US' },
        totalBytesProcessed: '123456',
        cacheHit: false,
        schema: {
          fields: [
            { name: 'currency', type: 'STRING' },
            { name: 'gross_micros', type: 'INTEGER' },
            { name: 'credit_micros', type: 'INTEGER' },
            { name: 'net_micros', type: 'INTEGER' },
          ],
        },
        rows: [{ f: [{ v: 'USD' }, { v: '8651' }, { v: '-8651' }, { v: '0' }] }],
      });
    }) as typeof fetch;

    await expect(
      makeBillingReader(fetchImpl).read({
        descriptor: BILLING_EXPORT,
        runId: 'r4',
        usageStartAt: '2026-09-07T00:00:00.000Z',
        usageEndAt: '2026-09-08T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      status: 'observed',
      retryable: false,
      observation: {
        currency: 'USD',
        grossMicros: '8651',
        creditMicros: '-8651',
        netMicros: '0',
        budgetCents: 1,
        observedAt: NOW,
        providerEvidenceRef: `gcp://bigquery/projects/${PROJECT}/jobs/billing-query-r4`,
      },
      jobReference: { projectId: PROJECT, jobId: 'billing-query-r4', location: 'US' },
      totalBytesProcessed: '123456',
      cacheHit: false,
    });
  });

  it('returns typed retryable outcomes for missing config, empty data, and incomplete jobs', async () => {
    const unusedFetch = vi.fn() as unknown as typeof fetch;
    await expect(
      makeBillingReader(unusedFetch).read({
        runId: 'r4',
        usageStartAt: '2026-09-07T00:00:00Z',
        usageEndAt: '2026-09-08T00:00:00Z',
      }),
    ).resolves.toEqual({ status: 'retryable', retryable: true, reason: 'missing-config' });
    expect(unusedFetch).not.toHaveBeenCalled();

    const emptyFetch = vi.fn(async () =>
      json({
        jobComplete: true,
        jobReference: { projectId: PROJECT, jobId: 'empty' },
        schema: { fields: [] },
        rows: [],
      }),
    ) as typeof fetch;
    await expect(
      makeBillingReader(emptyFetch).read({
        descriptor: BILLING_EXPORT,
        runId: 'r4',
        usageStartAt: '2026-09-07T00:00:00Z',
        usageEndAt: '2026-09-08T00:00:00Z',
      }),
    ).resolves.toEqual({
      status: 'retryable',
      retryable: true,
      reason: 'no-data',
      jobReference: { projectId: PROJECT, jobId: 'empty' },
    });

    const pendingFetch = vi.fn(async () =>
      json({ jobComplete: false, jobReference: { projectId: PROJECT, jobId: 'pending', location: 'US' } }),
    ) as typeof fetch;
    await expect(
      makeBillingReader(pendingFetch).read({
        descriptor: BILLING_EXPORT,
        runId: 'r4',
        usageStartAt: '2026-09-07T00:00:00Z',
        usageEndAt: '2026-09-08T00:00:00Z',
      }),
    ).resolves.toEqual({
      status: 'retryable',
      retryable: true,
      reason: 'query-pending',
      jobReference: { projectId: PROJECT, jobId: 'pending', location: 'US' },
    });
  });

  it('classifies permissions and malformed or mixed-currency responses without reporting zero spend', async () => {
    const permissionFetch = vi.fn(async () => json({ error: { message: 'forbidden' } }, 403)) as typeof fetch;
    await expect(
      makeBillingReader(permissionFetch).read({
        descriptor: BILLING_EXPORT,
        runId: 'r4',
        usageStartAt: '2026-09-07T00:00:00Z',
        usageEndAt: '2026-09-08T00:00:00Z',
      }),
    ).resolves.toEqual({ status: 'retryable', retryable: true, reason: 'permission' });

    const mixedFetch = vi.fn(async () =>
      json({
        jobComplete: true,
        jobReference: { projectId: PROJECT, jobId: 'mixed' },
        schema: { fields: [] },
        rows: [{ f: [] }, { f: [] }],
      }),
    ) as typeof fetch;
    await expect(
      makeBillingReader(mixedFetch).read({
        descriptor: BILLING_EXPORT,
        runId: 'r4',
        usageStartAt: '2026-09-07T00:00:00Z',
        usageEndAt: '2026-09-08T00:00:00Z',
      }),
    ).resolves.toEqual({ status: 'retryable', retryable: true, reason: 'multiple-currencies' });

    const malformedFetch = vi.fn(async () =>
      json({
        jobComplete: true,
        jobReference: { projectId: PROJECT, jobId: 'malformed' },
        schema: {
          fields: [
            { name: 'currency', type: 'STRING' },
            { name: 'gross_micros', type: 'INTEGER' },
            { name: 'credit_micros', type: 'INTEGER' },
            { name: 'net_micros', type: 'INTEGER' },
          ],
        },
        rows: [{ f: [{ v: 'USD' }, { v: '1.5' }, { v: '0' }, { v: '1.5' }] }],
      }),
    ) as typeof fetch;
    await expect(
      makeBillingReader(malformedFetch).read({
        descriptor: BILLING_EXPORT,
        runId: 'r4',
        usageStartAt: '2026-09-07T00:00:00Z',
        usageEndAt: '2026-09-08T00:00:00Z',
      }),
    ).resolves.toEqual({ status: 'retryable', retryable: true, reason: 'malformed-result' });
  });

  it('validates interpolated identifiers and enforces the absolute query-cost ceiling before fetching', async () => {
    expect(() => parseGcpBillingExportDescriptor({ ...BILLING_EXPORT, tableId: 'billing`; DROP TABLE x' })).toThrow(
      'gcp_billing_export_tableId_invalid',
    );
    expect(() =>
      parseGcpBillingExportDescriptor({
        ...BILLING_EXPORT,
        maximumBytesBilled: (GCP_BILLING_EXPORT_MAX_BYTES_BILLED + 1n).toString(),
      }),
    ).toThrow('gcp_billing_export_maximumBytesBilled_out_of_range');

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      makeBillingReader(fetchImpl).read({
        descriptor: { ...BILLING_EXPORT, datasetId: 'bad.dataset' },
        runId: 'r4',
        usageStartAt: '2026-09-07T00:00:00Z',
        usageEndAt: '2026-09-08T00:00:00Z',
      }),
    ).resolves.toEqual({ status: 'retryable', retryable: true, reason: 'invalid-config' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function desired(): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-gcp-live-client',
    target: 'gcp',
    scope: { kind: 'project', id: PROJECT },
    region: REGION,
    zone: ZONE,
    size: 'n2-standard-2',
    image: { id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-test' },
    data: { volumeGiB: 120, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' } },
  };
}

describe('ADC-backed GCP workspace-host API client', () => {
  it('reads every machine-type page for the requested region and merges availability across zones', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('fields')).toContain('nextPageToken');
      expect(url.searchParams.get('filter')).toBe('zone eq .*us-central1-.*');
      if (!url.searchParams.has('pageToken')) {
        return json({
          items: {
            [`zones/${ZONE}`]: {
              machineTypes: [
                { name: 'n2-standard-2', guestCpus: 2, memoryMb: 8192, deprecated: { state: 'DEPRECATED' } },
              ],
            },
          },
          nextPageToken: 'next+page/=2',
        });
      }
      expect(url.searchParams.get('pageToken')).toBe('next+page/=2');
      return json({
        items: {
          'zones/us-central1-b': {
            machineTypes: [
              { name: 'n2-standard-2', guestCpus: 2, memoryMb: 8192 },
              { name: 'e2-standard-4', guestCpus: 4, memoryMb: 16384 },
            ],
          },
          'zones/europe-west1-b': { machineTypes: [{ name: 'outside-region', guestCpus: 1, memoryMb: 1024 }] },
        },
      });
    }) as typeof fetch;

    const sizes = await makeClient(fetchImpl).listSizes(
      { scope: { kind: 'project', id: PROJECT }, region: REGION },
      connection(),
    );
    expect(sizes).toEqual([
      { id: 'e2-standard-4', label: 'e2-standard-4', cpuCount: 4, memoryMiB: 16384, available: true },
      { id: 'n2-standard-2', label: 'n2-standard-2', cpuCount: 2, memoryMiB: 8192, available: true },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not treat an empty first machine-type page as an empty catalog', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.has('filter')).toBe(false);
      return json(
        url.searchParams.has('pageToken')
          ? {
              items: {
                [`zones/${ZONE}`]: { machineTypes: [{ name: 'e2-standard-4', guestCpus: 4, memoryMb: 16384 }] },
              },
            }
          : { items: {}, nextPageToken: 'next' },
      );
    }) as typeof fetch;
    await expect(
      makeClient(fetchImpl).listSizes({ scope: { kind: 'project', id: PROJECT } }, connection()),
    ).resolves.toMatchObject([{ id: 'e2-standard-4' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a repeated machine-type page token instead of looping or returning a partial catalog', async () => {
    const fetchImpl = vi.fn(async () => json({ items: {}, nextPageToken: 'same-token' })) as typeof fetch;
    await expect(
      makeClient(fetchImpl).listSizes({ scope: { kind: 'project', id: PROJECT } }, connection()),
    ).rejects.toThrow('gcp_machine_type_pagination_cycle');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses region expressions that could widen the GCP catalog filter', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      makeClient(fetchImpl).listSizes(
        {
          scope: { kind: 'project', id: PROJECT },
          region: 'us-central1|.*',
        },
        connection(),
      ),
    ).rejects.toThrow('invalid_region');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates an ADC connection and maps bounded project catalogs without returning credential material', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/projects/${PROJECT}?fields=name`)) return json({ name: PROJECT });
      if (url.includes('/regions?')) return json({ items: [{ name: REGION, status: 'UP' }] });
      if (url.includes('/zones?')) {
        return json({ items: [{ name: ZONE, status: 'UP', region: `projects/${PROJECT}/regions/${REGION}` }] });
      }
      if (url.includes('/aggregated/machineTypes?')) {
        return json({
          items: {
            [`zones/${ZONE}`]: {
              machineTypes: [{ name: 'n2-standard-2', guestCpus: 2, memoryMb: 8192 }],
            },
            'zones/europe-west1-b': {
              machineTypes: [{ name: 'n2-standard-2', guestCpus: 2, memoryMb: 8192 }],
            },
          },
        });
      }
      if (url.includes('/global/images/family/ubuntu-2404-lts-amd64')) {
        return json({
          name: 'ubuntu-2404-noble-amd64-v20260801',
          selfLink: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260801',
          architecture: 'X86_64',
          creationTimestamp: '2026-08-01T00:00:00.000Z',
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);

    const validation = await client.validateConnection(connection());
    const scopes = await client.listScopes(connection());
    const regions = await client.listRegions({ scope: { kind: 'project', id: PROJECT } }, connection());
    const sizes = await client.listSizes({ scope: { kind: 'project', id: PROJECT }, region: REGION }, connection());
    const images = await client.listImages(
      { scope: { kind: 'project', id: PROJECT }, architecture: 'x86_64' },
      connection(),
    );
    const estimate = await client.estimatePrice(desired(), connection());

    expect(validation).toMatchObject({ ok: true, identity: 'operator@example.com' });
    expect(scopes).toEqual([{ kind: 'project', id: PROJECT, label: PROJECT }]);
    expect(regions).toEqual([{ id: REGION, label: REGION, available: true, zones: [ZONE] }]);
    expect(sizes).toEqual([
      { id: 'n2-standard-2', label: 'n2-standard-2', cpuCount: 2, memoryMiB: 8192, available: true },
    ]);
    expect(images[0]).toMatchObject({
      id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260801',
      version: 'ubuntu-2404-noble-amd64-v20260801',
      architecture: 'x86_64',
      signed: true,
    });
    expect(images[0]?.id).not.toContain('/images/family/');
    expect(estimate).toMatchObject({ currency: 'USD', hourlyAmount: 0, confidence: 'unknown' });
    expect(JSON.stringify({ validation, scopes, regions, sizes, images, estimate })).not.toContain(TOKEN);
    for (const [, init] of vi.mocked(fetchImpl).mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('admits the explicit gcloud active-user chain and rejects arbitrary credential schemes', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/projects/${PROJECT}?fields=name`)) return json({ name: PROJECT });
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);

    await expect(
      client.validateConnection({
        ...connection(),
        cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.validateConnection({
        ...connection(),
        cloudCredentialRef: { kind: 'cloud', ref: 'env:GOOGLE_APPLICATION_CREDENTIALS' },
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('classifies local metadata and active-user resolver failures without exposing arbitrary errors', async () => {
    const acquireAuth = vi.fn(async () => ({ accessToken: TOKEN, projectId: PROJECT }));
    const fetchImpl = vi.fn(async () => json({ name: PROJECT })) as typeof fetch;
    const client = new GoogleComputeWorkspaceHostApiClient({ acquireAuth, fetch: fetchImpl, now: () => NOW });
    const missingProject: WorkspaceHostProviderConnection = {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
      provider: {},
    };

    await expect(client.validateConnection(missingProject)).resolves.toMatchObject({
      ok: false,
      errors: ['GCP connection project is missing; reconnect with an explicit project.'],
    });
    expect(acquireAuth).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const tokenFailure = new GoogleComputeWorkspaceHostApiClient({
      acquireAuth: async () => {
        throw new Error('gcp_gcloud_active_user_token_unavailable');
      },
      fetch: fetchImpl,
      now: () => NOW,
    });
    await expect(tokenFailure.validateConnection(connection())).resolves.toMatchObject({
      ok: false,
      errors: ['GCP active-user credential resolution failed: an access token is unavailable.'],
    });

    const unknownFailure = new GoogleComputeWorkspaceHostApiClient({
      acquireAuth: async () => {
        throw new Error(`resolver stderr contained ${TOKEN}`);
      },
      fetch: fetchImpl,
      now: () => NOW,
    });
    const validation = await unknownFailure.validateConnection(connection());
    expect(validation).toMatchObject({
      ok: false,
      errors: [
        'GCP Compute API was unreachable or returned an unreadable response; the connection itself was not disproved.',
      ],
      // WI-1743793: an unclassified failure is transport-class, so it must stay retryable rather
      // than terminally failing the lifecycle action.
      retryable: true,
    });
    // Every credential-class failure this client raises carries a mapped code, so an unmapped error
    // must NEVER be reported as a credential fault — that sent an operator to audit a credential
    // that had driven three other operations to success minutes earlier.
    expect(validation.errors.join(' ')).not.toMatch(/credential/i);
    expect(JSON.stringify(validation)).not.toContain(TOKEN);
  });

  it('admits a hosted delegation only when the injected auth supplier is bound to its exact reference', async () => {
    const hostedRef = 'resolver://workspace-1/gcp/generation-2';
    const hostedConnection: WorkspaceHostProviderConnection = {
      ...connection(),
      cloudCredentialRef: { kind: 'cloud', ref: hostedRef },
      provider: { projectId: PROJECT, credentialSource: 'hosted-delegation', generation: 2 },
    };
    const fetchImpl = vi.fn(async () => json({ name: PROJECT })) as typeof fetch;
    const acquireAuth = vi.fn(async () => ({ accessToken: TOKEN, projectId: PROJECT, identity: 'delegated' }));

    await expect(
      new GoogleComputeWorkspaceHostApiClient({ acquireAuth, fetch: fetchImpl, now: () => NOW }).validateConnection(
        hostedConnection,
      ),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      new GoogleComputeWorkspaceHostApiClient({
        acquireAuth,
        credentialRef: hostedRef,
        fetch: fetchImpl,
        now: () => NOW,
      }).validateConnection(hostedConnection),
    ).resolves.toMatchObject({ ok: true, identity: 'delegated' });
    expect(acquireAuth).toHaveBeenCalledTimes(1);
  });

  it('shares auth only within one explicitly scoped inspection client', async () => {
    const acquireAuth = vi.fn(async () => ({
      accessToken: TOKEN,
      projectId: PROJECT,
      identity: 'operator@example.com',
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      json(String(input).includes('/regions?') ? { items: [] } : { name: PROJECT }),
    ) as typeof fetch;
    const options = { acquireAuth, fetch: fetchImpl, now: () => NOW, reuseAuthWithinInstance: true };

    const first = new GoogleComputeWorkspaceHostApiClient(options);
    await expect(first.validateConnection(connection())).resolves.toMatchObject({ ok: true });
    await expect(first.listRegions({ scope: { kind: 'project', id: PROJECT } }, connection())).resolves.toEqual([]);
    expect(acquireAuth).toHaveBeenCalledTimes(1);

    const second = new GoogleComputeWorkspaceHostApiClient(options);
    await expect(second.validateConnection(connection())).resolves.toMatchObject({ ok: true });
    expect(acquireAuth).toHaveBeenCalledTimes(2);
  });

  it('resolves a configured Papercusp family but exposes only its immutable member to consumers', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain(`/projects/${PROJECT}/global/images/family/papercusp-workspace-host`);
      return json({
        name: 'papercusp-workspace-host-2026-8-23-1',
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${PROJECT}/global/images/` +
          'papercusp-workspace-host-2026-8-23-1',
        architecture: 'X86_64',
        creationTimestamp: '2026-08-23T01:00:00.000Z',
      });
    }) as typeof fetch;
    const client = new GoogleComputeWorkspaceHostApiClient({
      acquireAuth: vi.fn(async () => ({
        accessToken: TOKEN,
        projectId: PROJECT,
        identity: 'operator@example.com',
      })),
      fetch: fetchImpl,
      now: () => NOW,
      imageFamily: { project: PROJECT, family: 'papercusp-workspace-host', label: 'Papercusp workspace host' },
    });

    await expect(
      client.listImages({ scope: { kind: 'project', id: PROJECT }, architecture: 'x86_64' }, connection()),
    ).resolves.toEqual([
      {
        id: `projects/${PROJECT}/global/images/papercusp-workspace-host-2026-8-23-1`,
        version: 'papercusp-workspace-host-2026-8-23-1',
        label: 'Papercusp workspace host',
        architecture: 'x86_64',
        signed: true,
        publishedAt: '2026-08-23T01:00:00.000Z',
      },
    ]);
  });

  it('maps resource observations, rebuilds a secret-free recreate input, and treats only HTTP 404 as absence', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/global/networks/missing')) return json({ error: { message: TOKEN } }, 404);
      if (url.endsWith(`/zones/${ZONE}/instances/pc-host-vm`)) {
        return json({
          name: 'pc-host-vm',
          selfLink: `projects/${PROJECT}/zones/${ZONE}/instances/pc-host-vm`,
          status: 'RUNNING',
          machineType: `zones/${ZONE}/machineTypes/n2-standard-2`,
          labels: { 'papercusp-managed': 'true', 'papercusp-host-id': 'host-gcp-live-client' },
          tags: { items: ['pc-host'] },
          networkInterfaces: [
            {
              network: 'global/networks/pc-host-net',
              subnetwork: `regions/${REGION}/subnetworks/pc-host-subnet`,
              stackType: 'IPV4_ONLY',
              networkIP: '10.132.12.2',
              accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT', natIP: '203.0.113.42' }],
            },
          ],
          disks: [
            { boot: true, autoDelete: true, source: `zones/${ZONE}/disks/pc-host-boot` },
            {
              boot: false,
              autoDelete: false,
              source: `zones/${ZONE}/disks/pc-host-data`,
              deviceName: 'papercusp-data',
              mode: 'READ_WRITE',
            },
          ],
          serviceAccounts: [
            {
              email: `workspace-host@${PROJECT}.iam.gserviceaccount.com`,
              scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            },
          ],
          metadata: {
            fingerprint: 'metadata-fingerprint-1',
            items: [{ key: 'enable-oslogin', value: 'TRUE' }],
          },
        });
      }
      if (url.endsWith(`/zones/${ZONE}/disks/pc-host-boot`)) {
        return json({
          name: 'pc-host-boot',
          status: 'READY',
          sizeGb: '40',
          type: `zones/${ZONE}/diskTypes/pd-balanced`,
          sourceImage: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-test',
          diskEncryptionKey: {
            kmsKeyName: `projects/${PROJECT}/locations/${REGION}/keyRings/workspaces/cryptoKeys/disk`,
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);

    await expect(client.getNetwork(PROJECT, 'missing')).resolves.toBeUndefined();
    const instance = await client.getInstance(PROJECT, ZONE, 'pc-host-vm');

    expect(instance).toMatchObject({
      name: 'pc-host-vm',
      status: 'RUNNING',
      attachedDiskNames: ['pc-host-boot', 'pc-host-data'],
      internalIp: '10.132.12.2',
      externalIp: '203.0.113.42',
      sourceImage: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-test',
      metadataFingerprint: 'metadata-fingerprint-1',
      recreateInput: {
        machineType: `zones/${ZONE}/machineTypes/n2-standard-2`,
        disks: [
          {
            initializeParams: {
              diskSizeGb: 40,
              diskType: `zones/${ZONE}/diskTypes/pd-balanced`,
            },
          },
          { source: `zones/${ZONE}/disks/pc-host-data`, deviceName: 'papercusp-data' },
        ],
      },
    });
    expect(instance).not.toHaveProperty('agentOnline');
    expect(JSON.stringify(instance)).not.toContain(TOKEN);
  });

  it('reads the hostkeys guest-attribute namespace through the authenticated Compute endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(
        `/compute/v1/projects/${PROJECT}/zones/${ZONE}/instances/pc-host-vm/getGuestAttributes`,
      );
      expect(url.searchParams.get('queryPath')).toBe('hostkeys/');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      return json({
        queryPath: 'hostkeys/',
        queryValue: {
          items: [
            { namespace: 'hostkeys', key: 'ecdsa-sha2-nistp256', value: 'AAAA' },
            { namespace: 'hostkeys', key: 'ssh-ed25519', value: 'AAAA' },
          ],
        },
      });
    }) as typeof fetch;

    await expect(
      makeClient(fetchImpl).getInstanceGuestAttributes(PROJECT, ZONE, 'pc-host-vm', 'hostkeys/'),
    ).resolves.toEqual([
      { namespace: 'hostkeys', key: 'ecdsa-sha2-nistp256', value: 'AAAA' },
      { namespace: 'hostkeys', key: 'ssh-ed25519', value: 'AAAA' },
    ]);
  });

  it('fails closed when Compute returns a malformed guest-attribute item', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ queryValue: { items: [{ namespace: 'hostkeys', key: 'ssh-ed25519' }] } }),
    ) as typeof fetch;

    await expect(
      makeClient(fetchImpl).getInstanceGuestAttributes(PROJECT, ZONE, 'pc-host-vm', 'hostkeys/'),
    ).rejects.toThrow(/guest attribute value/);
  });

  it('uses scoped Compute endpoints, normalizes resource references, and retains durable operation coordinates', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/wait')) {
        return json({
          name: 'operation-1',
          status: 'DONE',
          zone: `projects/${PROJECT}/zones/${ZONE}`,
          error: { errors: [{ code: 'QUOTA_EXCEEDED', message: `provider detail ${TOKEN}` }] },
        });
      }
      const zone = url.includes(`/zones/${ZONE}/`) ? `projects/${PROJECT}/zones/${ZONE}` : undefined;
      const region = url.includes(`/regions/${REGION}/`) ? `projects/${PROJECT}/regions/${REGION}` : undefined;
      return json({ name: `operation-${calls.length}`, status: 'PENDING', zone, region });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const disk: GcpDiskInsertInput = {
      name: 'pc-host-data',
      zone: ZONE,
      sizeGb: 120,
      type: 'pd-ssd',
      labels: { 'papercusp-managed': 'true' },
      sourceSnapshot: `projects/${PROJECT}/global/snapshots/pc-host-source-q3`,
      sourceSnapshotEncryptionKey: {
        kmsKeyName: `projects/${PROJECT}/locations/${REGION}/keyRings/workspaces/cryptoKeys/snapshot-source`,
      },
    };
    const instance: GcpInstanceInsertInput = {
      name: 'pc-host-vm',
      zone: ZONE,
      machineType: 'n2-standard-2',
      labels: { 'papercusp-managed': 'true' },
      tags: { items: ['pc-host'] },
      networkInterfaces: [
        {
          network: 'pc-host-net',
          subnetwork: 'pc-host-subnet',
          stackType: 'IPV4_ONLY',
        },
      ],
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-test',
            diskSizeGb: 40,
            diskType: 'pd-balanced',
          },
        },
        {
          boot: false,
          autoDelete: false,
          source: 'pc-host-data',
          deviceName: 'papercusp-data',
          mode: 'READ_WRITE',
        },
      ],
      serviceAccounts: [
        {
          email: `workspace-host@${PROJECT}.iam.gserviceaccount.com`,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      ],
      metadata: { items: [{ key: 'enable-oslogin', value: 'TRUE' }] },
    };

    const diskOperation = await client.insertDisk(PROJECT, ZONE, disk, REQUEST_ID);
    await client.insertSubnetwork(
      PROJECT,
      REGION,
      {
        name: 'pc-host-subnet',
        network: 'pc-host-net',
        ipCidrRange: '10.132.12.0/24',
        region: REGION,
        privateIpGoogleAccess: true,
        stackType: 'IPV4_ONLY',
      },
      REQUEST_ID,
    );
    await client.insertInstance(PROJECT, ZONE, instance, REQUEST_ID);
    await client.setInstanceMetadata(
      PROJECT,
      ZONE,
      'pc-host-vm',
      { fingerprint: 'metadata-fingerprint-1', items: [{ key: 'startup-script', value: '#!/bin/bash\necho current' }] },
      REQUEST_ID,
    );
    await client.createSnapshot(
      PROJECT,
      ZONE,
      { name: 'pc-host-snapshot', sourceDisk: 'pc-host-data', labels: { 'papercusp-host-id': 'host-1' } },
      REQUEST_ID,
    );
    const observed = await client.waitForOperation(
      { name: 'operation-1', projectId: PROJECT, scope: 'zone', location: ZONE, requestId: REQUEST_ID },
      undefined,
    );

    expect(diskOperation).toMatchObject({ projectId: PROJECT, scope: 'zone', location: ZONE, requestId: REQUEST_ID });
    const diskCall = calls.find(({ url }) => url.includes(`/zones/${ZONE}/disks?`))!;
    expect(JSON.parse(String(diskCall.init?.body))).toMatchObject({
      type: `zones/${ZONE}/diskTypes/pd-ssd`,
      sourceSnapshot: `projects/${PROJECT}/global/snapshots/pc-host-source-q3`,
      sourceSnapshotEncryptionKey: {
        kmsKeyName: `projects/${PROJECT}/locations/${REGION}/keyRings/workspaces/cryptoKeys/snapshot-source`,
      },
    });
    expect(JSON.parse(String(diskCall.init?.body))).not.toHaveProperty('zone');
    const subnetCall = calls.find(({ url }) => url.includes('/subnetworks?'))!;
    expect(JSON.parse(String(subnetCall.init?.body))).toMatchObject({ network: 'global/networks/pc-host-net' });
    expect(JSON.parse(String(subnetCall.init?.body))).not.toHaveProperty('region');
    const instanceCall = calls.find(({ url }) => url.includes(`/instances?`))!;
    expect(JSON.parse(String(instanceCall.init?.body))).toMatchObject({
      machineType: `zones/${ZONE}/machineTypes/n2-standard-2`,
      networkInterfaces: [
        {
          network: 'global/networks/pc-host-net',
          subnetwork: `regions/${REGION}/subnetworks/pc-host-subnet`,
        },
      ],
      disks: [
        { initializeParams: { diskType: `zones/${ZONE}/diskTypes/pd-balanced` } },
        { source: `zones/${ZONE}/disks/pc-host-data` },
      ],
    });
    const snapshotCall = calls.find(({ url }) => url.includes('/createSnapshot?'))!;
    expect(snapshotCall.url).toContain(`/zones/${ZONE}/disks/pc-host-data/createSnapshot`);
    expect(JSON.parse(String(snapshotCall.init?.body))).toEqual({
      name: 'pc-host-snapshot',
      labels: { 'papercusp-host-id': 'host-1' },
    });
    const metadataCall = calls.find(({ url }) => url.includes('/setMetadata?'))!;
    expect(JSON.parse(String(metadataCall.init?.body))).toEqual({
      fingerprint: 'metadata-fingerprint-1',
      items: [{ key: 'startup-script', value: '#!/bin/bash\necho current' }],
    });
    expect(observed).toMatchObject({
      projectId: PROJECT,
      scope: 'zone',
      location: ZONE,
      status: 'DONE',
      error: { code: 'QUOTA_EXCEEDED', message: 'GCP operation failed (QUOTA_EXCEEDED)' },
    });
    expect(JSON.stringify(observed)).not.toContain(TOKEN);
    // No httpErrorStatusCode on the wire: nothing is invented, and QUOTA_EXCEEDED is never a throttle.
    expect(observed.error).not.toHaveProperty('status');
    expect(observed.error).not.toHaveProperty('throttled');
  });

  it('a failed operation carries its own HTTP status and marks rate-limit codes as throttled (WI-10005323)', async () => {
    const answer = (codes: string[], httpErrorStatusCode: number) =>
      makeClient(
        vi.fn(async () =>
          json({
            name: 'operation-1',
            status: 'DONE',
            zone: `projects/${PROJECT}/zones/${ZONE}`,
            httpErrorStatusCode,
            httpErrorMessage: 'FORBIDDEN',
            error: { errors: codes.map((code) => ({ code, message: `provider detail ${TOKEN}` })) },
          }),
        ) as typeof fetch,
      ).waitForOperation({ name: 'operation-1', projectId: PROJECT, scope: 'zone', location: ZONE, requestId: REQUEST_ID });

    const denied = await answer(['SERVICE_ACCOUNT_ACCESS_DENIED'], 403);
    expect(denied.error).toEqual({
      code: 'SERVICE_ACCOUNT_ACCESS_DENIED',
      message: 'GCP operation failed (SERVICE_ACCOUNT_ACCESS_DENIED)',
      status: 403,
    });
    expect(JSON.stringify(denied)).not.toContain(TOKEN);
    expect((await answer(['RESOURCE_OPERATION_RATE_EXCEEDED'], 403)).error).toMatchObject({ status: 403, throttled: true });
    expect((await answer(['RESOURCE_NOT_READY'], 400)).error).toMatchObject({ status: 400, throttled: true });
    expect((await answer(['QUOTA_EXCEEDED'], 403)).error).not.toHaveProperty('throttled');
  });

  it('creates, reads, and deletes a dedicated regional Router/NAT with provider-read absence', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let router:
      | {
          name: string;
          network: string;
          region: string;
          fingerprint: string;
          nats: unknown[];
        }
      | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(`/regions/${REGION}/routers/pc-host-router`)) {
        return router ? json(router) : json({ error: { message: 'not found' } }, 404);
      }
      if (url.includes(`/regions/${REGION}/routers?`)) {
        const body = JSON.parse(String(init?.body)) as typeof router;
        router = { ...body!, fingerprint: 'fp-1', nats: [] };
        return json({ name: 'insert-router-op', status: 'PENDING', region: `projects/${PROJECT}/regions/${REGION}` });
      }
      if (url.includes(`/regions/${REGION}/routers/pc-host-router?`) && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as NonNullable<typeof router>;
        router = { ...body, fingerprint: 'fp-2' };
        return json({ name: 'patch-router-op', status: 'PENDING', region: `projects/${PROJECT}/regions/${REGION}` });
      }
      if (url.includes(`/regions/${REGION}/routers/pc-host-router?`) && init?.method === 'DELETE') {
        router = undefined;
        return json({ name: 'delete-router-op', status: 'PENDING', region: `projects/${PROJECT}/regions/${REGION}` });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const routerInput: GcpRouterInsertInput = {
      name: 'pc-host-router',
      network: 'pc-host-net',
      region: REGION,
    };
    const natInput: GcpNatInsertInput = {
      name: 'pc-host-nat',
      routerName: 'pc-host-router',
      network: 'pc-host-net',
      subnetwork: 'pc-host-subnet',
      region: REGION,
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
      minPortsPerVm: 64,
      enableEndpointIndependentMapping: false,
    };

    await client.insertRouter(PROJECT, REGION, routerInput, REQUEST_ID);
    await expect(client.getRouter(PROJECT, REGION, routerInput.name)).resolves.toMatchObject({
      name: routerInput.name,
      network: 'pc-host-net',
      region: REGION,
      natNames: [],
    });
    await client.insertNat(PROJECT, REGION, natInput, REQUEST_ID);
    await expect(client.getNat(PROJECT, REGION, routerInput.name, natInput.name)).resolves.toMatchObject({
      name: natInput.name,
      routerName: routerInput.name,
      subnetwork: 'pc-host-subnet',
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
    });
    await client.deleteNat(PROJECT, REGION, routerInput.name, natInput.name, REQUEST_ID);
    await expect(client.getNat(PROJECT, REGION, routerInput.name, natInput.name)).resolves.toBeUndefined();
    await client.deleteRouter(PROJECT, REGION, routerInput.name, REQUEST_ID);
    await expect(client.getRouter(PROJECT, REGION, routerInput.name)).resolves.toBeUndefined();

    const natPatch = calls.find(
      ({ url, init }) => url.includes('/routers/pc-host-router?') && init?.method === 'PATCH',
    )!;
    expect(JSON.parse(String(natPatch.init?.body))).toMatchObject({
      network: 'global/networks/pc-host-net',
      nats: [
        {
          name: 'pc-host-nat',
          natIpAllocateOption: 'AUTO_ONLY',
          sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
          minPortsPerVm: 64,
          enableEndpointIndependentMapping: false,
          subnetworks: [
            {
              name: `regions/${REGION}/subnetworks/pc-host-subnet`,
              sourceIpRangesToNat: ['ALL_IP_RANGES'],
            },
          ],
        },
      ],
    });
    expect(
      calls.filter(({ url, init }) => url.includes('/routers/pc-host-router?') && init?.method === 'PATCH'),
    ).toHaveLength(2);
  });

  it('collects non-vacuous all-kind inventory evidence for the orphan census', async () => {
    const managedLabels = {
      'papercusp-managed': 'true',
      'papercusp-host-id': 'host-gcp-live-client',
      'papercusp-workspace-id': 'workspace-1',
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (/\/(?:aggregated\/(?:instances|disks)|global\/snapshots)\?/.test(url)) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get('fields')).toContain('nextPageToken');
        if (!parsed.searchParams.has('pageToken')) return json({ nextPageToken: 'remaining-resources' });
        expect(parsed.searchParams.get('pageToken')).toBe('remaining-resources');
      }
      if (url.includes('/aggregated/instances?')) {
        return json({ items: { [`zones/${ZONE}`]: { instances: [{ name: 'pc-host-vm', labels: managedLabels }] } } });
      }
      if (url.includes('/aggregated/disks?')) {
        return json({ items: { [`zones/${ZONE}`]: { disks: [{ name: 'pc-host-data', labels: managedLabels }] } } });
      }
      if (url.includes('/global/snapshots?'))
        return json({ items: [{ name: 'pc-host-snapshot', labels: managedLabels }] });
      if (url.endsWith('/global/networks/pc-host-net')) return json({ name: 'pc-host-net' });
      if (url.endsWith(`/regions/${REGION}/subnetworks/pc-host-subnet`)) return json({ name: 'pc-host-subnet' });
      if (url.endsWith('/global/firewalls/pc-host-iap')) {
        return json({
          name: 'pc-host-iap',
          direction: 'INGRESS',
          sourceRanges: ['35.235.240.0/20'],
          targetTags: ['pc-host'],
          allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
        });
      }
      if (url.endsWith(`/regions/${REGION}/routers/pc-host-router`)) {
        return json({
          name: 'pc-host-router',
          network: 'global/networks/pc-host-net',
          region: `regions/${REGION}`,
          nats: [
            {
              name: 'pc-host-nat',
              natIpAllocateOption: 'AUTO_ONLY',
              sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
              minPortsPerVm: 64,
              enableEndpointIndependentMapping: false,
              subnetworks: [
                { name: `regions/${REGION}/subnetworks/pc-host-subnet`, sourceIpRangesToNat: ['ALL_IP_RANGES'] },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const inventory = await client.inventoryManagedResources({
      projectId: PROJECT,
      region: REGION,
      workspaceId: 'workspace-1',
      deterministicNames: {
        networks: ['pc-host-net'],
        subnetworks: ['pc-host-subnet'],
        firewalls: ['pc-host-iap'],
        routers: ['pc-host-router'],
        nats: [{ routerName: 'pc-host-router', name: 'pc-host-nat' }],
      },
    });

    expect(inventory.complete).toBe(true);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.filter(([input]) =>
          /\/(?:aggregated\/(?:instances|disks)|global\/snapshots)\?/.test(String(input)),
        ),
    ).toHaveLength(6);
    expect(inventory.inventoryEvidence.map(({ kind }) => kind)).toEqual([
      'vm',
      'disk',
      'firewall',
      'subnetwork',
      'network',
      'snapshot',
      'router',
      'nat',
    ]);
    expect(inventory.observed.map(({ resource }) => resource.kind).sort()).toEqual(
      ['vm', 'disk', 'snapshot', 'network', 'subnetwork', 'firewall', 'router', 'nat'].sort(),
    );
    expect(
      censusGcpWorkspaceHostResources({
        hostId: 'host-gcp-live-client',
        workspaceId: 'workspace-1',
        expected: inventory.observed.map(({ resource }) => resource),
        observed: inventory.observed,
        inventoryEvidence: inventory.inventoryEvidence,
        evaluatedAt: NOW,
        orphanGraceMs: 60_000,
      }),
    ).toMatchObject({ inventoryComplete: true, clean: true, untracked: [], missing: [], labelMismatches: [] });
  });

  it.each(['instances', 'disks', 'snapshots'])(
    'rejects a repeated inventory cursor for %s rather than claiming completeness',
    async (collection) => {
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/${collection}`)) return json({ nextPageToken: 'cycle' });
        if (url.pathname.includes('/aggregated/') || url.pathname.endsWith('/snapshots')) return json({});
        return json({ error: { code: 404 } }, 404);
      }) as typeof fetch;
      await expect(
        makeClient(fetchImpl).inventoryManagedResources({
          projectId: PROJECT,
          region: REGION,
          workspaceId: 'workspace-1',
          deterministicNames: {
            networks: ['pc-host-net'],
            subnetworks: ['pc-host-subnet'],
            firewalls: ['pc-host-iap'],
            routers: ['pc-host-router'],
            nats: [{ routerName: 'pc-host-router', name: 'pc-host-nat' }],
          },
        }),
      ).rejects.toThrow('gcp_inventory_pagination_cycle');
    },
  );

  it('wires the explicit ADC production composition without changing injected-client fail-closed construction', async () => {
    const fetchImpl = vi.fn(async () => json({ name: PROJECT })) as typeof fetch;
    const provider = createAdcGcpWorkspaceHostProvider({
      acquireAuth: async () => ({ accessToken: TOKEN, projectId: PROJECT, identity: 'operator@example.com' }),
      fetch: fetchImpl,
      now: () => NOW,
    });
    const context: WorkspaceHostProviderContext = {
      workspaceId: 'workspace-1',
      requestId: 'request-1',
      connection: connection(),
    };

    await expect(provider.validateConnection(context)).resolves.toMatchObject({ ok: true });
    expect(JSON.stringify(await provider.validateConnection(context))).not.toContain(TOKEN);
  });
});

describe('boot disk sizing against the source image', () => {
  function bootInstance(diskSizeGb: number): GcpInstanceInsertInput {
    return {
      name: 'pc-host-vm',
      zone: ZONE,
      machineType: 'n2-standard-2',
      labels: { 'papercusp-managed': 'true' },
      tags: { items: ['pc-host'] },
      networkInterfaces: [{ network: 'pc-host-net', subnetwork: 'pc-host-subnet', stackType: 'IPV4_ONLY' }],
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18-r18`,
            diskSizeGb,
            diskType: 'pd-balanced',
          },
        },
        { boot: false, autoDelete: false, source: 'pc-host-data', deviceName: 'papercusp-data', mode: 'READ_WRITE' },
      ],
      serviceAccounts: [{ email: `workspace-host@${PROJECT}.iam.gserviceaccount.com`, scopes: [] }],
      metadata: { items: [] },
    };
  }

  /** Records the POSTed instance body while answering the image lookup with `imageDiskSizeGb`. */
  function harness(imageDiskSizeGb: string | undefined) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/global/images/')) {
        return imageDiskSizeGb === undefined
          ? json({ error: { message: 'not found' } }, 404)
          : json({ name: 'papercusp-workspace-host-0-0-18-r18', diskSizeGb: imageDiskSizeGb });
      }
      return json({ name: 'operation-1', status: 'PENDING', zone: `projects/${PROJECT}/zones/${ZONE}` });
    }) as typeof fetch;
    const body = () => JSON.parse(String(calls.find(({ url }) => url.includes('/instances?'))!.init?.body));
    return { client: makeClient(fetchImpl), body };
  }

  it('exposes the image floor for admission planning and fails closed when it cannot be read', async () => {
    const imageId = `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18-r18`;
    const readable = harness('32').client;
    await expect(readable.getImageDiskSizeGb(imageId)).resolves.toBe(32);

    const unreadable = harness(undefined).client;
    await expect(unreadable.getImageDiskSizeGb(imageId)).rejects.toThrow('gcp_preflight_http_404');
  });

  // The failure this exists to prevent: bootDiskGiB defaults to 30 while the shipped
  // workspace-host image is 32 GB, so GCP rejected every default-config provision with
  // "Requested disk size cannot be smaller than the image size (32 GB)".
  it('raises a boot disk that is smaller than its source image up to the image size', async () => {
    const { client, body } = harness('32');

    await client.insertInstance(PROJECT, ZONE, bootInstance(30), REQUEST_ID);

    expect(body().disks[0].initializeParams.diskSizeGb).toBe(32);
  });

  it('never shrinks a boot disk the caller deliberately sized larger than the image', async () => {
    const { client, body } = harness('32');

    await client.insertInstance(PROJECT, ZONE, bootInstance(100), REQUEST_ID);

    expect(body().disks[0].initializeParams.diskSizeGb).toBe(100);
  });

  it('falls back to the requested size when the image cannot be read', async () => {
    const { client, body } = harness(undefined);

    await client.insertInstance(PROJECT, ZONE, bootInstance(30), REQUEST_ID);

    expect(body().disks[0].initializeParams.diskSizeGb).toBe(30);
  });
});

describe('recreateInput keeps a spot host on spot (WI-10005210)', () => {
  const raw = (scheduling?: Record<string, unknown>) =>
    ({
      name: 'pc-host-vm',
      machineType: `zones/${ZONE}/machineTypes/e2-custom-16-32768`,
      networkInterfaces: [{ network: 'global/networks/n', subnetwork: `regions/${REGION}/subnetworks/s` }],
      disks: [
        { boot: true, autoDelete: true, source: `zones/${ZONE}/disks/pc-host-boot` },
        { boot: false, autoDelete: false, source: `zones/${ZONE}/disks/pc-host-data`, deviceName: 'papercusp-data' },
      ],
      ...(scheduling ? { scheduling } : {}),
    }) as Parameters<typeof gcpRecreateInput>[0];
  const boot = { sourceImage: 'projects/p/global/images/i', sizeGb: '30', type: 'pd-balanced' } as Parameters<
    typeof gcpRecreateInput
  >[1];

  it('re-creates a SPOT instance with STOP-on-reclaim scheduling and an on-demand one without any', () => {
    // GCP reports the defaults it filled in for spot; the re-create pins them.
    const spot = gcpRecreateInput(
      raw({ provisioningModel: 'SPOT', instanceTerminationAction: 'STOP', automaticRestart: false, onHostMaintenance: 'TERMINATE' }),
      boot,
      ZONE,
    );
    expect(spot?.scheduling).toEqual({
      provisioningModel: 'SPOT',
      instanceTerminationAction: 'STOP',
      automaticRestart: false,
      onHostMaintenance: 'TERMINATE',
    });
    // An on-demand instance reports STANDARD (or nothing); its re-create carries no scheduling block.
    expect(gcpRecreateInput(raw({ provisioningModel: 'STANDARD', automaticRestart: true }), boot, ZONE)).not.toHaveProperty(
      'scheduling',
    );
    expect(gcpRecreateInput(raw(), boot, ZONE)).not.toHaveProperty('scheduling');
  });
});
