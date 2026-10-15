import { describe, expect, it, vi } from 'vitest';
import {
  GCLOUD_ACTIVE_USER_AUTH_TTL_MS,
  GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF,
  GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS,
  acquireGcpGcloudActiveUserAuth,
  createGcloudActiveUserAuthMemo,
  createGcpWorkspaceHostAcquireAuth,
  fetchGcpApiJson,
  inspectGcpLocalCredentialOnboarding,
  runGcpWorkspaceHostPreflight,
  type GcpPreflightDeps,
} from './gcp-preflight';
import { isTransientNetworkError } from '../loopback-fetch';

const SECRET = 'ya29.this-access-token-must-never-escape';
const PROJECT = 'active-alcove-504205-q3';
const DEFAULT_COMPUTE_SERVICE_ACCOUNT = '243118361453-compute@developer.gserviceaccount.com';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function successFetch(
  overrides: Record<string, Response | ((init?: RequestInit) => Response)> = {},
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    for (const [needle, response] of Object.entries(overrides)) {
      if (url.includes(needle)) return typeof response === 'function' ? response(init) : response.clone();
    }
    if (url.includes('cloudresourcemanager.googleapis.com/v3/projects/')) return json({ state: 'ACTIVE' });
    if (url.includes('cloudbilling.googleapis.com')) return json({ billingEnabled: true });
    if (url.includes('serviceusage.googleapis.com')) return json({ state: 'ENABLED' });
    if (url.includes(':testIamPermissions')) {
      const requested = JSON.parse(String(init?.body ?? '{}')) as { permissions?: string[] };
      return json({ permissions: requested.permissions ?? [] });
    }
    if (url.includes('?fields=quotas')) return json({ quotas: [{ metric: 'CPUS_ALL_REGIONS', limit: 24, usage: 2 }] });
    if (url.includes('/regions?')) return json({ items: [{ name: 'us-central1', status: 'UP' }] });
    if (url.includes('/aggregated/machineTypes')) {
      return json({ items: { 'zones/us-central1-a': { machineTypes: [{ name: 'e2-standard-4' }] } } });
    }
    if (url.includes('/global/images/family/')) return json({ name: 'ubuntu-2404-noble-amd64-v20260801' });
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
}

function deps(overrides: Partial<GcpPreflightDeps> = {}): GcpPreflightDeps {
  return {
    exec: vi.fn(async (file, args) => {
      if (file === 'gcloud' && args[0] === 'version') return { stdout: '{"Google Cloud SDK":"999.0.0"}' };
      if (file === 'gcloud' && args[0] === 'config') return { stdout: `${PROJECT}\n` };
      throw new Error(`unexpected exec ${file} ${args.join(' ')}`);
    }),
    readFile: vi.fn(async () => JSON.stringify({ type: 'authorized_user', refresh_token: 'must-not-escape' })),
    acquireAuth: vi.fn(async () => ({ accessToken: SECRET, projectId: PROJECT, identity: 'developer@example.com' })),
    fetch: successFetch(),
    env: {},
    homedir: () => '/home/tester',
    now: () => '2026-08-22T06:00:00.000Z',
    ...overrides,
  };
}

describe('GCP local credential onboarding', () => {
  it('returns the official authorized-user command when gcloud and ADC are absent', async () => {
    const report = await inspectGcpLocalCredentialOnboarding(
      {},
      deps({
        exec: vi.fn(async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }),
        readFile: vi.fn(async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }),
      }),
    );

    expect(report).toMatchObject({ gcloudInstalled: false, adcPresent: false, credentialType: 'missing' });
    expect(report.commands[0]?.argv).toEqual(['gcloud', 'auth', 'application-default', 'login']);
    expect(JSON.stringify(report)).not.toMatch(/keys create|private_key|refresh_token/);
  });

  it('renders an argv-safe impersonation flow and never suggests a downloaded key', async () => {
    const report = await inspectGcpLocalCredentialOnboarding(
      { impersonateServiceAccount: 'workspace-provisioner@example-project.iam.gserviceaccount.com' },
      deps({
        readFile: vi.fn(async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }),
      }),
    );

    expect(report.commands[0]?.argv).toEqual([
      'gcloud',
      'auth',
      'application-default',
      'login',
      '--impersonate-service-account=workspace-provisioner@example-project.iam.gserviceaccount.com',
    ]);
    expect(JSON.stringify(report)).not.toContain('service-accounts keys create');
  });
});

describe('GCP workspace-host credential references', () => {
  it('pins one active human gcloud account and returns only its short-lived token', async () => {
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === 'auth' && args[1] === 'list') return { stdout: 'developer@example.com\n' };
      if (args[0] === 'auth' && args[1] === 'print-access-token') return { stdout: `${SECRET}\n` };
      if (args[0] === 'config') return { stdout: `${PROJECT}\n` };
      throw new Error(`unexpected gcloud argv ${args.join(' ')}`);
    });

    await expect(acquireGcpGcloudActiveUserAuth({ exec })).resolves.toEqual({
      accessToken: SECRET,
      identity: 'developer@example.com',
      projectId: PROJECT,
    });
    expect(exec).toHaveBeenCalledWith('gcloud', [
      'auth',
      'print-access-token',
      '--account=developer@example.com',
      '--quiet',
    ]);
  });

  it.each(['canary@example.iam.gserviceaccount.com', DEFAULT_COMPUTE_SERVICE_ACCOUNT])(
    'refuses service-account identity %s imported into gcloud before requesting a token',
    async (identity) => {
      const exec = vi.fn(async () => ({ stdout: `${identity}\n` }));

      await expect(acquireGcpGcloudActiveUserAuth({ exec })).rejects.toThrow(
        'gcp_gcloud_active_user_service_account_forbidden',
      );
      expect(exec).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed on a service-account ADC file before the ADC token supplier runs', async () => {
    const acquireAdcAuth = vi.fn(async () => ({ accessToken: SECRET }));
    const acquire = createGcpWorkspaceHostAcquireAuth('adc://authorized_user', {
      env: { GOOGLE_APPLICATION_CREDENTIALS: '/secrets/key.json' },
      readFile: vi.fn(async () => JSON.stringify({ type: 'service_account', private_key: SECRET })),
      acquireAdcAuth,
    });

    await expect(acquire()).rejects.toThrow('gcp_workspace_host_service_account_key_forbidden');
    expect(acquireAdcAuth).not.toHaveBeenCalled();
  });

  it('routes the explicit active-user reference and rejects unknown credential schemes', async () => {
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === 'auth' && args[1] === 'list') return { stdout: 'developer@example.com\n' };
      if (args[0] === 'auth' && args[1] === 'print-access-token') return { stdout: `${SECRET}\n` };
      if (args[0] === 'config') return { stdout: `${PROJECT}\n` };
      throw new Error('unexpected command');
    });
    const acquire = createGcpWorkspaceHostAcquireAuth(GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF, { exec });

    await expect(acquire()).resolves.toMatchObject({ identity: 'developer@example.com', projectId: PROJECT });
    expect(() => createGcpWorkspaceHostAcquireAuth('env:GOOGLE_APPLICATION_CREDENTIALS')).toThrow(
      'gcp_workspace_host_cloud_credential_ref_unsupported',
    );
  });

  // WI-10005446: each active-user resolution forks three gcloud CLIs (~0.7 CPU-s each) from
  // bg-host, in bursts during GCP operations. The memo reuses one resolution for a window
  // shorter than gcloud's own 300 s refresh margin.
  describe('gcloud active-user memo', () => {
    const auth = (n: number) => ({ accessToken: `${SECRET}-${n}`, identity: 'developer@example.com', projectId: PROJECT });

    it('keeps the reuse window inside gcloud refresh margin (300 s) with at least 60 s to spare', () => {
      expect(GCLOUD_ACTIVE_USER_AUTH_TTL_MS).toBeGreaterThan(0);
      expect(GCLOUD_ACTIVE_USER_AUTH_TTL_MS).toBeLessThanOrEqual(240_000);
    });

    it('reuses a resolution until the window closes, timed from when it started', async () => {
      let clock = 1_000;
      const memo = createGcloudActiveUserAuthMemo({ ttlMs: 180_000, now: () => clock });
      let calls = 0;
      const resolve = vi.fn(async () => {
        calls += 1;
        clock += 2_000; // the resolution itself takes time; the window must not start after it
        return auth(calls);
      });

      await expect(memo.get(resolve)).resolves.toMatchObject({ accessToken: `${SECRET}-1` });
      clock = 1_000 + 179_999;
      await expect(memo.get(resolve)).resolves.toMatchObject({ accessToken: `${SECRET}-1` });
      expect(resolve).toHaveBeenCalledTimes(1);

      clock = 1_000 + 180_000;
      await expect(memo.get(resolve)).resolves.toMatchObject({ accessToken: `${SECRET}-2` });
      expect(resolve).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight resolution between concurrent callers', async () => {
      const memo = createGcloudActiveUserAuthMemo({ now: () => 0 });
      let release!: (value: ReturnType<typeof auth>) => void;
      const resolve = vi.fn(() => new Promise<ReturnType<typeof auth>>((r) => (release = r)));

      const first = memo.get(resolve);
      const second = memo.get(resolve);
      release(auth(1));

      await expect(Promise.all([first, second])).resolves.toEqual([auth(1), auth(1)]);
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it('never stores a failure', async () => {
      const memo = createGcloudActiveUserAuthMemo({ now: () => 0 });
      const resolve = vi
        .fn<() => Promise<ReturnType<typeof auth>>>()
        .mockRejectedValueOnce(new Error('gcp_gcloud_active_user_token_unavailable'))
        .mockResolvedValueOnce(auth(2));

      await expect(memo.get(resolve)).rejects.toThrow('gcp_gcloud_active_user_token_unavailable');
      await expect(memo.get(resolve)).resolves.toMatchObject({ accessToken: `${SECRET}-2` });
      expect(resolve).toHaveBeenCalledTimes(2);
    });

    it('hands each caller its own copy', async () => {
      const memo = createGcloudActiveUserAuthMemo({ now: () => 0 });
      const resolve = vi.fn(async () => auth(1));

      const first = await memo.get(resolve);
      first.accessToken = 'mutated';
      await expect(memo.get(resolve)).resolves.toMatchObject({ accessToken: `${SECRET}-1` });
    });

    function gcloudExec() {
      return vi.fn(async (_file: string, args: readonly string[]) => {
        if (args[0] === 'auth' && args[1] === 'list') return { stdout: 'developer@example.com\n' };
        if (args[0] === 'auth' && args[1] === 'print-access-token') return { stdout: `${SECRET}\n` };
        if (args[0] === 'config') return { stdout: `${PROJECT}\n` };
        throw new Error('unexpected command');
      });
    }

    it('routes the active-user acquirer through a supplied memo: two acquires fork gcloud three times, not six', async () => {
      const exec = gcloudExec();
      const acquire = createGcpWorkspaceHostAcquireAuth(GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF, {
        exec,
        activeUserAuthMemo: createGcloudActiveUserAuthMemo({ now: () => 0 }),
      });

      await acquire();
      await expect(acquire()).resolves.toMatchObject({ identity: 'developer@example.com', projectId: PROJECT });
      expect(exec).toHaveBeenCalledTimes(3);
    });

    it('keeps an injected exec out of the process-wide memo', async () => {
      const exec = gcloudExec();
      const acquire = createGcpWorkspaceHostAcquireAuth(GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF, { exec });

      await acquire();
      await acquire();
      expect(exec).toHaveBeenCalledTimes(6);
    });
  });

  // EI-22191286944372582: a momentary exec failure (observed cause: concurrent gcloud
  // processes contending for the shared config/credential DB) used to collapse straight to
  // the terminal error with no retry and no cause, aborting an expensive live-cloud run.
  describe('a momentary gcloud exec failure around the token/project pair (EI-22191286944372582)', () => {
    const noopSleep = async () => {};

    it('recovers on a bounded retry — invisible to the caller, no terminal error', async () => {
      let tokenAttempts = 0;
      const exec = vi.fn(async (_file: string, args: readonly string[]) => {
        if (args[0] === 'auth' && args[1] === 'list') return { stdout: 'developer@example.com\n' };
        if (args[0] === 'auth' && args[1] === 'print-access-token') {
          tokenAttempts += 1;
          if (tokenAttempts === 1) {
            throw Object.assign(new Error('Command failed: gcloud auth print-access-token'), {
              code: 1,
              stderr: 'ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens',
            });
          }
          return { stdout: `${SECRET}\n` };
        }
        if (args[0] === 'config') return { stdout: `${PROJECT}\n` };
        throw new Error(`unexpected exec ${args.join(' ')}`);
      });

      await expect(acquireGcpGcloudActiveUserAuth({ exec, sleep: noopSleep })).resolves.toEqual({
        accessToken: SECRET,
        identity: 'developer@example.com',
        projectId: PROJECT,
      });
      // 1 (auth list) + 2 (failed attempt) + 2 (succeeding attempt) = 5.
      expect(exec).toHaveBeenCalledTimes(5);
    });

    it('exhausts its bounded retries, still throws the exact taxonomy message, but attaches the cause the old collapsed catch erased', async () => {
      const exec = vi.fn(async (_file: string, args: readonly string[]) => {
        if (args[0] === 'auth' && args[1] === 'list') return { stdout: 'developer@example.com\n' };
        throw Object.assign(new Error('Command failed: gcloud config get-value project'), {
          code: 2,
          stderr: 'ERROR: gcloud crashed (OSError): [Errno 26] Text file busy',
        });
      });

      const sleep = vi.fn(noopSleep);
      let caught: unknown;
      try {
        await acquireGcpGcloudActiveUserAuth({ exec, sleep });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      // The exact string every downstream caller matches on (gcp-api-client.ts's
      // SAFE_CONNECTION_VALIDATION_PROBLEMS table) must survive unchanged.
      expect((caught as Error).message).toBe('gcp_gcloud_active_user_token_unavailable');
      expect((caught as Error).cause).toBeInstanceOf(Error);
      expect(((caught as Error).cause as Error).message).toContain('exit 2');
      expect(((caught as Error).cause as Error).message).toContain('Text file busy');
      // Bounded: the default backoff schedule has 2 entries, so 3 total attempts, 2 sleeps.
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('bounds an oversized stderr excerpt rather than embedding it whole', async () => {
      const hugeStderr = 'x'.repeat(2_000);
      const exec = vi.fn(async (_file: string, args: readonly string[]) => {
        if (args[0] === 'auth' && args[1] === 'list') return { stdout: 'developer@example.com\n' };
        throw Object.assign(new Error('boom'), { code: 1, stderr: hugeStderr });
      });

      let caught: unknown;
      try {
        await acquireGcpGcloudActiveUserAuth({ exec, sleep: noopSleep });
      } catch (error) {
        caught = error;
      }

      const causeMessage = ((caught as Error).cause as Error).message;
      expect(causeMessage.length).toBeLessThan(hugeStderr.length);
      expect(causeMessage).toContain('…');
    });
  });

  // Measured 2026-09-24: p318-r39-destroy-20260924-1 deleted every resource, then failed its
  // terminal evidence on ONE `count_invalid` from discovery, which had no retry at all.
  describe('a momentary miss in active-account discovery', () => {
    const tokenAndProject = (args: readonly string[]) => {
      if (args[0] === 'auth' && args[1] === 'print-access-token') return { stdout: `${SECRET}\n` };
      if (args[0] === 'config') return { stdout: `${PROJECT}\n` };
      throw new Error(`unexpected exec ${args.join(' ')}`);
    };

    it('recovers when the account list is briefly empty', async () => {
      let listed = 0;
      const exec = vi.fn(async (_file: string, args: readonly string[]) => {
        if (args[0] === 'auth' && args[1] === 'list') {
          listed += 1;
          return { stdout: listed === 1 ? '' : 'developer@example.com\n' };
        }
        return tokenAndProject(args);
      });
      const sleep = vi.fn(async () => {});

      await expect(acquireGcpGcloudActiveUserAuth({ exec, sleep })).resolves.toMatchObject({
        identity: 'developer@example.com',
      });
      expect(listed).toBe(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('keeps the taxonomy message when the count never settles, and says what it saw', async () => {
      const exec = vi.fn(async (_file: string, args: readonly string[]) => {
        if (args[0] === 'auth' && args[1] === 'list') return { stdout: 'a@example.com\nb@example.com\n' };
        return tokenAndProject(args);
      });
      const sleep = vi.fn(async () => {});

      const caught = await acquireGcpGcloudActiveUserAuth({ exec, sleep }).catch((error: unknown) => error);
      expect((caught as Error).message).toBe('gcp_gcloud_active_user_count_invalid');
      expect(((caught as Error).cause as Error).message).toContain('2 active account(s)');
      expect(((caught as Error).cause as Error).message).toContain('a@example.com, b@example.com');
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(exec).toHaveBeenCalledTimes(3);
    });

    it('keeps the taxonomy message when discovery itself keeps failing, with the exit code', async () => {
      const exec = vi.fn(async () => {
        throw Object.assign(new Error('Command failed: gcloud auth list'), { code: 1, stderr: 'ERROR: config busy' });
      });
      const sleep = vi.fn(async () => {});

      const caught = await acquireGcpGcloudActiveUserAuth({ exec, sleep }).catch((error: unknown) => error);
      expect((caught as Error).message).toBe('gcp_gcloud_active_user_unavailable');
      expect(((caught as Error).cause as Error).message).toContain('exit 1');
      expect(((caught as Error).cause as Error).message).toContain('config busy');
      expect(sleep).toHaveBeenCalledTimes(2);
    });
  });
});

describe('GCP workspace-host preflight', () => {
  it('preflights the guest-attribute permission required for authenticated host-key enrollment', () => {
    expect(GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS).toContain('compute.instances.getGuestAttributes');
  });

  it('verifies project, billing, APIs, IAM, quota, catalogs, and image access without leaking credentials', async () => {
    const fetchImpl = successFetch();
    const report = await runGcpWorkspaceHostPreflight({}, deps({ fetch: fetchImpl }));

    expect(report.ok).toBe(true);
    expect(report.projectId).toBe(PROJECT);
    expect(report.credential.credentialRef).toEqual({ kind: 'cloud', ref: 'adc://authorized_user' });
    expect(report.checks.map((check) => check.id)).toEqual([
      'credential',
      'project',
      'billing',
      'services',
      'iam.project',
      'quotas',
      'regions',
      'machineTypes',
      'image',
    ]);
    expect(report.enabledServices).toEqual(['compute.googleapis.com', 'iap.googleapis.com', 'oslogin.googleapis.com']);
    expect(report.regions).toEqual(['us-central1']);
    expect(report.machineTypeCount).toBe(1);
    expect(report.selectedImage?.name).toBe('ubuntu-2404-noble-amd64-v20260801');
    expect(JSON.stringify(report)).not.toMatch(/ya29\.|refresh_token|private_key|client_secret/);

    const quotaCall = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).includes('/compute/v1/projects/'));
    expect(String(quotaCall?.[0])).toContain('?fields=quotas');
    expect(String(quotaCall?.[0])).not.toContain('quotas(');

    const iamCall = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).includes(':testIamPermissions'));
    expect(JSON.parse(String(iamCall?.[1]?.body))).toEqual({
      permissions: [...GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS],
    });
  });

  it('fails closed on a service-account key before acquiring a token or calling Google APIs', async () => {
    const acquireAuth = vi.fn();
    const fetchImpl = vi.fn();
    const report = await runGcpWorkspaceHostPreflight(
      {},
      deps({
        env: { GOOGLE_APPLICATION_CREDENTIALS: '/secrets/service-account.json' },
        readFile: vi.fn(async () => JSON.stringify({ type: 'service_account', private_key: 'must-not-escape' })),
        acquireAuth,
        fetch: fetchImpl as typeof fetch,
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: 'credential', status: 'fail' });
    expect(report.checks[0]?.remediation?.code).toBe('remove-service-account-key');
    expect(acquireAuth).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('must-not-escape');
  });

  it('returns exact least-privilege remediation for disabled services, missing IAM, and exhausted quota', async () => {
    const fetchImpl = successFetch({
      'services/iap.googleapis.com': json({ state: 'DISABLED' }),
      ':testIamPermissions': () => json({ permissions: ['resourcemanager.projects.get'] }),
      '?fields=quotas': json({ quotas: [{ metric: 'CPUS_ALL_REGIONS', limit: 8, usage: 8 }] }),
    });
    const report = await runGcpWorkspaceHostPreflight({}, deps({ fetch: fetchImpl }));

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'services')?.remediation).toMatchObject({
      code: 'enable-services',
      commands: [['gcloud', 'services', 'enable', 'iap.googleapis.com', `--project=${PROJECT}`]],
    });
    const iam = report.checks.find((check) => check.id === 'iam.project');
    expect(iam?.remediation?.code).toBe('grant-project-permissions');
    expect(iam?.remediation?.missingPermissions).toContain('iap.tunnelInstances.accessViaIAP');
    expect(iam?.remediation?.missingPermissions).toContain('compute.routers.update');
    expect(iam?.remediation?.suggestedRoles).toContain('roles/iap.tunnelResourceAccessor');
    expect(iam?.remediation?.suggestedRoles).toContain('roles/compute.networkAdmin');
    expect(report.checks.find((check) => check.id === 'quotas')?.remediation?.code).toBe('increase-quota');
  });

  it.each([
    { label: 'empty', quotas: [] },
    { label: 'unparseable', quotas: [{ metric: 'CPUS_ALL_REGIONS' }] },
  ])('fails closed when the Compute quota response is $label', async ({ quotas }) => {
    const report = await runGcpWorkspaceHostPreflight(
      {},
      deps({ fetch: successFetch({ '?fields=quotas': json({ quotas }) }) }),
    );

    expect(report.ok).toBe(false);
    expect(report.quotas).toEqual([]);
    expect(report.checks.find((check) => check.id === 'quotas')).toMatchObject({
      status: 'fail',
      summary: 'Compute quota verification returned no parseable quota metrics.',
    });
  });

  it('requires the image permissions the workspace-host release path actually calls', () => {
    // gcp-image-family-adapter POSTs /global/images for the candidate build AND the family
    // promote; the offline image scan creates its candidate disk from an image. A preflight that
    // omits these passes and then the first image operation fails.
    for (const permission of [
      'compute.images.create',
      'compute.images.delete',
      'compute.images.get',
      'compute.images.list',
      'compute.images.setLabels',
      'compute.images.useReadOnly',
    ]) {
      expect(GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS).toContain(permission);
    }
  });

  it('suggests a remediation role for every compute resource family it requires', async () => {
    // The defect this closes is structural, not specific to images: a permission listed as
    // REQUIRED but absent from suggestedRoles() is reported as missing with no way to fix it.
    // Asserting the invariant over the whole list also catches the next family added without a
    // role, which is what makes this a guard rather than a regression test for one bug.
    const families = [
      ...new Set(
        GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS.filter((permission) => permission.startsWith('compute.')).map(
          (permission) => permission.split('.').slice(0, 2).join('.'),
        ),
      ),
    ];
    expect(families).toContain('compute.images');

    const unremediated: string[] = [];
    for (const family of families) {
      // Grant everything EXCEPT this one family, so the resulting suggestedRoles is attributable
      // to it alone rather than to some other missing permission.
      const report = await runGcpWorkspaceHostPreflight(
        {},
        deps({
          fetch: successFetch({
            ':testIamPermissions': (init) => {
              const requested =
                (JSON.parse(String(init?.body ?? '{}')) as { permissions?: string[] }).permissions ?? [];
              return json({ permissions: requested.filter((p) => !p.startsWith(`${family}.`)) });
            },
          }),
        }),
      );

      const iam = report.checks.find((check) => check.id === 'iam.project');
      expect(iam?.remediation?.missingPermissions?.some((p) => p.startsWith(`${family}.`))).toBe(true);
      if (!iam?.remediation?.suggestedRoles?.length) unremediated.push(family);
    }

    expect(unremediated).toEqual([]);
  });

  it('points a missing image permission at roles/compute.storageAdmin', async () => {
    const report = await runGcpWorkspaceHostPreflight(
      {},
      deps({
        fetch: successFetch({
          ':testIamPermissions': (init) => {
            const requested = (JSON.parse(String(init?.body ?? '{}')) as { permissions?: string[] }).permissions ?? [];
            return json({ permissions: requested.filter((p) => !p.startsWith('compute.images.')) });
          },
        }),
      }),
    );

    const iam = report.checks.find((check) => check.id === 'iam.project');
    expect(iam?.remediation?.missingPermissions).toContain('compute.images.create');
    expect(iam?.remediation?.suggestedRoles).toContain('roles/compute.storageAdmin');
  });

  it('checks iam.serviceAccounts.actAs on the selected runtime identity only', async () => {
    const fetchImpl = successFetch({
      'iam.googleapis.com': () => json({ permissions: [] }),
    });
    const report = await runGcpWorkspaceHostPreflight(
      { runtimeServiceAccount: 'workspace-runtime@example-project.iam.gserviceaccount.com' },
      deps({ fetch: fetchImpl }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'iam.serviceAccount')?.remediation).toMatchObject({
      code: 'grant-service-account-user',
      suggestedRoles: ['roles/iam.serviceAccountUser'],
      missingPermissions: ['iam.serviceAccounts.actAs'],
    });
    expect(
      vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).includes('workspace-runtime%40example-project')),
    ).toBe(true);
  });

  it('accepts the canonical default Compute Engine service account and checks actAs on that exact identity', async () => {
    const fetchImpl = successFetch();
    const report = await runGcpWorkspaceHostPreflight(
      { runtimeServiceAccount: DEFAULT_COMPUTE_SERVICE_ACCOUNT },
      deps({ fetch: fetchImpl }),
    );

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === 'iam.serviceAccount')).toMatchObject({ status: 'pass' });
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([url]) => String(url).includes(encodeURIComponent(DEFAULT_COMPUTE_SERVICE_ACCOUNT))),
    ).toBe(true);
  });

  it.each([
    'workspace-runtime@developer.gserviceaccount.com',
    '243118361453-worker@developer.gserviceaccount.com',
    '243118361453-compute@developer.gserviceaccount.com.example.org',
  ])('rejects non-canonical default-service-account lookalike %s', async (runtimeServiceAccount) => {
    await expect(runGcpWorkspaceHostPreflight({ runtimeServiceAccount }, deps())).rejects.toThrow(
      'gcp_preflight_invalid_runtime_service_account',
    );
  });
});

describe('provider failure reasons on the shared Google API transport', () => {
  async function failWith(body: unknown, status = 400): Promise<Error> {
    const fetchImpl = vi.fn(async () => json(body, status)) as unknown as typeof fetch;
    return await fetchGcpApiJson(fetchImpl, SECRET, 'https://compute.googleapis.com/compute/v1/x').then(
      () => {
        throw new Error('expected the transport to reject');
      },
      (error: Error) => error,
    );
  }

  // Without this the operator saw only `gcp_preflight_http_400` and could not learn WHAT was
  // rejected: diagnosing one provisioning failure needed a hand-replay against the live API.
  it('carries the field-level provider reason on the thrown error', async () => {
    const error = await failWith({
      error: {
        code: 400,
        message: "Invalid value for field 'resource.disks[0].initializeParams.diskSizeGb': '30'.",
        errors: [{ message: 'Requested disk size cannot be smaller than the image size (32 GB)' }],
      },
    });

    expect(error.message).toContain('gcp_preflight_http_400');
    expect(error.message).toContain('Requested disk size cannot be smaller than the image size (32 GB)');
    expect((error as { reason?: string }).reason).toContain('diskSizeGb');
  });

  it('never lets a token-shaped value out of the provider body', async () => {
    const error = await failWith({ error: { message: `denied for Bearer ${SECRET}`, errors: [{ message: SECRET }] } });

    expect(error.message).not.toContain(SECRET);
    expect((error as { reason?: string }).reason).not.toContain(SECRET);
    expect((error as { reason?: string }).reason).toContain('[redacted]');
  });

  it('still reports the status when the body carries no usable reason', async () => {
    const error = await failWith({ nothing: 'useful' }, 403);

    expect(error.message).toBe('gcp_preflight_http_403');
    expect((error as { status?: number }).status).toBe(403);
  });

  // WI-1818869. Google answers Compute rate limiting with 403, so a status-only retry classifier
  // calls it `terminal` -> `halt` and a durable provisioning workflow stops permanently on a fault
  // a backoff clears. The reason code is the only thing that separates it from a real refusal.
  it.each(['rateLimitExceeded', 'userRateLimitExceeded', 'rateLimitExceededByUser'])(
    'marks a 403 carrying %s as a throttle',
    async (reason) => {
      const error = await failWith(
        { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason, message: 'Rate Limit Exceeded' }] } },
        403,
      );

      expect((error as { status?: number }).status).toBe(403);
      expect((error as { throttled?: boolean }).throttled).toBe(true);
    },
  );

  // P-318 r62b (2026-10-01): a subnetwork insert against a network Google is still creating
  // answers 400 resourceNotReady. Without the throttle mark the 4xx rule halts the provision.
  it('marks a 400 resourceNotReady (parent still being created) as retryable', async () => {
    const error = await failWith(
      {
        error: {
          code: 400,
          message: "The resource 'projects/p/global/networks/n' is not ready",
          errors: [{ reason: 'resourceNotReady', message: "The resource 'projects/p/global/networks/n' is not ready" }],
        },
      },
      400,
    );

    expect((error as { status?: number }).status).toBe(400);
    expect((error as { throttled?: boolean }).throttled).toBe(true);
  });

  // The other half of the contract, and the reason this keys on reason codes rather than on the
  // canonical `RESOURCE_EXHAUSTED` status: a spent quota does not refill on a backoff, so retrying
  // it burns the schedule against a wall instead of surfacing a condition that needs an operator.
  it('does NOT treat a spent quota as a throttle', async () => {
    const error = await failWith(
      {
        error: {
          code: 403,
          message: 'Quota exceeded',
          status: 'RESOURCE_EXHAUSTED',
          errors: [{ reason: 'quotaExceeded', message: 'Quota exceeded' }],
        },
      },
      403,
    );

    expect((error as { status?: number }).status).toBe(403);
    expect((error as { throttled?: boolean }).throttled).toBeUndefined();
  });

  it('does NOT treat a genuine permission denial as a throttle', async () => {
    const error = await failWith(
      {
        error: {
          code: 403,
          message: 'Required permission compute.instances.create',
          errors: [{ reason: 'forbidden', message: 'Required permission compute.instances.create' }],
        },
      },
      403,
    );

    expect((error as { throttled?: boolean }).throttled).toBeUndefined();
  });
});

// WI-10001862: Google's frontend evicts idle pooled keep-alive sockets, and undici only notices
// when it reaches for one — so it hands a dead socket to the next request. A single un-retried
// fetch turned that routine eviction into a hard BYOC provisioning failure (~40% of connection
// validations), which is what these cover.
describe('transport replay on a closed pooled socket', () => {
  const NEVER_SLEEP = { sleep: async () => {} };

  function socketClose(): Error {
    const error = new TypeError('fetch failed');
    (error as { cause?: unknown }).cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    return error;
  }

  it('replays a GET past a socket close and returns the eventual response', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(socketClose())
      .mockResolvedValueOnce(json({ ok: true })) as unknown as typeof fetch;

    await expect(
      fetchGcpApiJson(fetchImpl, SECRET, 'https://compute.googleapis.com/compute/v1/x', {}, NEVER_SLEEP),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after a bounded number of replays rather than retrying forever', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(socketClose()) as unknown as typeof fetch;

    await expect(
      fetchGcpApiJson(fetchImpl, SECRET, 'https://compute.googleapis.com/compute/v1/x', {}, NEVER_SLEEP),
    ).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  // The control that keeps the retry from becoming a silent duplicate-resource bug: a socket close
  // cannot distinguish a request that was dropped from one that was applied with its reply lost.
  it('never replays an unannotated mutation', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(socketClose()) as unknown as typeof fetch;

    await expect(
      fetchGcpApiJson(
        fetchImpl,
        SECRET,
        'https://compute.googleapis.com/compute/v1/networks',
        { method: 'POST', body: '{}' },
        NEVER_SLEEP,
      ),
    ).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // ...but a Compute mutation carrying Google's own idempotency token IS deduplicated
  // provider-side, which is exactly the guarantee a replay needs.
  it('replays a mutation that carries a requestId idempotency token', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(socketClose())
      .mockResolvedValueOnce(json({ name: 'operation-1' })) as unknown as typeof fetch;

    await expect(
      fetchGcpApiJson(
        fetchImpl,
        SECRET,
        'https://compute.googleapis.com/compute/v1/networks?requestId=abc-123',
        { method: 'POST', body: '{}' },
        NEVER_SLEEP,
      ),
    ).resolves.toEqual({ name: 'operation-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not replay a non-transport failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('certificate has expired')) as unknown as typeof fetch;

    await expect(
      fetchGcpApiJson(fetchImpl, SECRET, 'https://compute.googleapis.com/compute/v1/x', {}, NEVER_SLEEP),
    ).rejects.toThrow('certificate has expired');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not replay an aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn().mockRejectedValue(socketClose()) as unknown as typeof fetch;

    await expect(
      fetchGcpApiJson(
        fetchImpl,
        SECRET,
        'https://compute.googleapis.com/compute/v1/x',
        { signal: controller.signal },
        NEVER_SLEEP,
      ),
    ).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // An HTTP error means a response ARRIVED; the retry must stay out of that path entirely.
  it('leaves HTTP-level failures to the existing error mapping', async () => {
    const fetchImpl = vi.fn(async () => json({ error: { code: 500 } }, 500)) as unknown as typeof fetch;

    await expect(
      fetchGcpApiJson(fetchImpl, SECRET, 'https://compute.googleapis.com/compute/v1/x', {}, NEVER_SLEEP),
    ).rejects.toThrow('gcp_preflight_http_500');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// WI-10003516: a bg-host main-thread stall of 500ms or more lets Node's happy-eyeballs attempt
// timer abort an IPv4 connect that had already succeeded; the IPv6 fallback has no route, so the
// socket fails with an AggregateError (code ETIMEDOUT, empty message) whose attempts are all
// `syscall: 'connect'`. Four teardown census reads died on it as a bare "fetch failed (ETIMEDOUT)".
// Shape measured on Node v25.9 (.papercusp/scratch/probe-he-attempt-stall.mts, 5/5).
describe('connect-phase transport failures (WI-10003516)', () => {
  const NEVER_SLEEP = { sleep: async () => {} };
  const CENSUS_URL =
    'https://compute.googleapis.com/compute/v1/projects/p/aggregated/instances?filter=labels.secretish%3Dvalue&maxResults=500';

  function happyEyeballsTimeout(): Error {
    const v4 = Object.assign(new Error('connect ETIMEDOUT 142.251.211.170:443'), {
      code: 'ETIMEDOUT',
      syscall: 'connect',
    });
    const v6 = Object.assign(new Error('connect ENETUNREACH 2607:f8b0:4006:804::200a:443 - Local (:::0)'), {
      code: 'ENETUNREACH',
      syscall: 'connect',
    });
    return new TypeError('fetch failed', { cause: Object.assign(new AggregateError([v4, v6], ''), { code: 'ETIMEDOUT' }) });
  }

  it('replays a GET past a happy-eyeballs connect timeout — no request byte was sent', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(happyEyeballsTimeout())
      .mockResolvedValueOnce(json({ items: {} })) as unknown as typeof fetch;

    await expect(fetchGcpApiJson(fetchImpl, SECRET, CENSUS_URL, {}, NEVER_SLEEP)).resolves.toEqual({ items: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('replays an undici connect timeout', async () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(json({ ok: true })) as unknown as typeof fetch;

    await expect(fetchGcpApiJson(fetchImpl, SECRET, CENSUS_URL, {}, NEVER_SLEEP)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // The control: a timeout AFTER the connection was established may follow a request Google
  // already applied, so it is not a connect-phase failure and must not be replayed here.
  it('does not replay a mid-request read timeout', async () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'read' }),
    });
    const fetchImpl = vi.fn().mockRejectedValue(error) as unknown as typeof fetch;

    await expect(fetchGcpApiJson(fetchImpl, SECRET, CENSUS_URL, {}, NEVER_SLEEP)).rejects.toThrow('ETIMEDOUT');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('names the method, host and path — never the query or token — once replays are exhausted', async () => {
    const original = happyEyeballsTimeout();
    const fetchImpl = vi.fn().mockRejectedValue(original) as unknown as typeof fetch;

    const failure = await fetchGcpApiJson(fetchImpl, SECRET, CENSUS_URL, {}, NEVER_SLEEP).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(failure?.message).toBe(
      'gcp_transport_failed GET compute.googleapis.com/compute/v1/projects/p/aggregated/instances: ' +
        'fetch failed (ETIMEDOUT: connect ETIMEDOUT 142.251.211.170:443; ' +
        'connect ENETUNREACH 2607:f8b0:4006:804::200a:443 - Local (:::0))',
    );
    expect(failure?.message).not.toContain('secretish');
    expect(failure?.message).not.toContain(SECRET);
    expect(failure?.cause).toBe(original);
    // The provisioning runner retries a census read only when this classifies transient.
    expect(isTransientNetworkError(failure)).toBe(true);
  });
});
