import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  withWorkspace: vi.fn(),
  notify: vi.fn(),
  rows: new Map<string, unknown[]>(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: H.withWorkspace,
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: H.notify }));

import {
  WORKSPACE_HOST_CONTROL_QUERY,
  appendWorkspaceHostLogs,
  exportWorkspaceHostAudit,
  readWorkspaceHostConnection,
  readWorkspaceHostControl,
  readWorkspaceHostReliability,
  readWorkspaceHostDestroyTarget,
  readWorkspaceHostResourceCheckpoints,
  recordWorkspaceHostOperationTerminalFailure,
  redactWorkspaceHostValue,
  storedWorkspaceHostConnectionScope,
  upsertWorkspaceHostConnection,
} from './observability-store';

function fakeTx(strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
  const sql = strings.join(' ').replace(/\s+/g, ' ').trim();
  const match = [...H.rows]
    .filter(([needle]) => sql.includes(needle))
    .sort(([left], [right]) => right.length - left.length)[0];
  return Promise.resolve(match?.[1] ?? []);
}

Object.assign(fakeTx, { json: (value: unknown) => value });

beforeEach(() => {
  H.rows.clear();
  H.notify.mockReset().mockResolvedValue(undefined);
  H.withWorkspace.mockReset().mockImplementation(async (_workspaceId, run) => run(fakeTx));
});

describe('workspace-host observability store', () => {
  it('projects scoped control-plane counts without exporting underlying private fields', async () => {
    H.rows.set('FROM harness_shared.workspace_host_operations operation', [{
      succeeded: '3', failed: '1', queued: '2', running: '1', success_p95_ms: 1250,
      request: { token: 'private' }, error: 'private diagnostic',
    }]);
    H.rows.set('FROM harness_shared.workspace_hosts host', [{
      expected_running: '4', unhealthy: '1', unobserved: '1', platform_owned_running: '2',
      cost_signals: { customerBill: 999 }, health_checks: ['private guest output'],
    }]);
    H.rows.set('FROM harness_shared.workspace_host_connections connection', [{ connected: '1', degraded: '1' }]);
    H.rows.set('FROM harness_shared.route_invocations', [{ samples: '5', errors: '1', p95_ms: 25 }]);
    H.rows.set('FROM papercusp_auth.hosted_workspace_connectors connector', [{ active: '2', lost: '1' }]);
    // Match the cost projection, not its nested lifecycle FROM clause. fakeTx
    // selects the longest matching SQL fragment so independent slices stay distinct.
    H.rows.set("SELECT sum(estimated_cost_cents) FILTER (WHERE cost_currency = 'USD') AS estimated_usd_cents", [
      { estimated_usd_cents: 2400, estimates: '3', unpriced: '1', breached_budgets: '1' },
    ]);
    const snapshot = await readWorkspaceHostReliability('ws-A', 3_600_000);
    expect(H.withWorkspace).toHaveBeenCalledWith('ws-A', expect.any(Function), {
      bypassRlsForAdmin: true, statementTimeoutMs: 2_000, lockTimeoutMs: 500,
    });
    expect(snapshot).toEqual({
      observedAt: 3_600_000, windowMs: 3_600_000,
      lifecycle: { succeeded: 3, failed: 1, queued: 2, running: 1, successP95Ms: 1250 },
      hosts: { expectedRunning: 4, unhealthy: 1, unobserved: 1, platformOwnedRunning: 2 },
      providerConnections: { connected: 1, degraded: 1 },
      api: { samples: 5, errors: 1, p95Ms: 25 },
      reverseConnectors: { active: 2, lost: 1 },
      ownedCost: { estimatedUsdCents: 2400, estimates: 3, unpriced: 1, breachedBudgets: 1 },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|customerBill|token|request|health_checks/);
  });

  it('keeps an unreadable slice unknown while preserving independently observed slices', async () => {
    const throwing = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(' ').includes('FROM harness_shared.workspace_hosts host')) throw new Error('read unavailable');
      return fakeTx(strings, ...values);
    }, { json: (v: unknown) => v });
    H.withWorkspace.mockImplementation(async (_ws, run) => run(throwing));
    H.rows.set('FROM harness_shared.route_invocations', [{ samples: '0', errors: '0', p95_ms: null }]);
    const snapshot = await readWorkspaceHostReliability('ws-A', 3_600_000);
    expect(snapshot.hosts).toBeNull();
    expect(snapshot.lifecycle).toBeNull();
    expect(snapshot.api).toEqual({ samples: 0, errors: 0, p95Ms: null });
  });

  it('redacts secret-shaped fields and secret-bearing text recursively', () => {
    expect(
      redactWorkspaceHostValue({
        authorization: 'Bearer abc.def.ghi',
        credentialRef: 'env:GCP_APPLICATION_CREDENTIALS',
        nested: { url: 'https://alice:password@example.test/?token=secret' },
        accessKey: 'AKIA1234567890ABCDEF',
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      credentialRef: 'env:GCP_APPLICATION_CREDENTIALS',
      nested: { url: 'https://alice:[REDACTED]@example.test/?token=[REDACTED]' },
      accessKey: '[REDACTED]',
    });
  });

  it('preserves a thrown Error as a readable diagnostic instead of collapsing it to {}', () => {
    // Regression guard. An Error's name/message/stack/cause are non-enumerable, so a generic
    // Object.entries() walk yields {} and destroys the only reason a failed workspace-host
    // operation records — the exact blackout behind canary r2's unexplained "failed after 0/6
    // steps" (its persisted error column was literally '{}').
    const cause = new Error('guest attributes fetch rejected');
    const error = Object.assign(new TypeError('initialization step planning failed'), {
      code: 'ERR_INIT_PLAN',
    });
    error.cause = cause;

    const redacted = redactWorkspaceHostValue(error) as Record<string, unknown>;

    expect(redacted).not.toEqual({});
    expect(redacted.name).toBe('TypeError');
    expect(redacted.message).toBe('initialization step planning failed');
    expect(redacted.code).toBe('ERR_INIT_PLAN');
    expect(typeof redacted.stack).toBe('string');
    expect(redacted.cause).toMatchObject({ name: 'Error', message: 'guest attributes fetch rejected' });
  });

  it('still redacts secrets carried inside an Error message and cause', () => {
    const error = new Error('refresh failed for Bearer abc.def.ghi', {
      cause: { authorization: 'Bearer zzz.yyy.xxx' },
    });

    const redacted = redactWorkspaceHostValue(error) as Record<string, unknown>;

    expect(redacted.message).toBe('refresh failed for Bearer [REDACTED]');
    expect(redacted.cause).toEqual({ authorization: '[REDACTED]' });
  });

  it('does not infinitely recurse on an Error whose cause chain is circular', () => {
    const error = new Error('outer');
    error.cause = error;

    expect(() => redactWorkspaceHostValue(error)).not.toThrow();
    expect((redactWorkspaceHostValue(error) as Record<string, unknown>).cause).toBe('[CIRCULAR]');
  });

  it('reads one stored connection as a typed non-secret provider reference', async () => {
    H.rows.set('FROM harness_shared.workspace_host_connections WHERE', [
      {
        id: 'connection-1',
        label: 'Production GCP',
        target: 'gcp',
        credential_ref: 'adc://controller',
        provider_config: { projectId: 'project-1', credentialSource: 'hosted-delegation' },
        status: 'connected',
        status_detail: null,
      },
    ]);

    await expect(readWorkspaceHostConnection('ws-1', 'connection-1')).resolves.toEqual({
      id: 'connection-1',
      label: 'Production GCP',
      target: 'gcp',
      status: 'connected',
      connection: {
        target: 'gcp',
        cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
        scope: { kind: 'project', id: 'project-1' },
        provider: { projectId: 'project-1', credentialSource: 'hosted-delegation' },
      },
    });
  });

  // WI-10006709: the row has no scope column, so a stored AWS connection read back with no scope and
  // `update` refused it as "invalid AWS accountId". The account survives only in `scopes`.
  it('reads a stored AWS connection back with its account scope from the persisted scopes', async () => {
    H.rows.set('FROM harness_shared.workspace_host_connections WHERE', [
      {
        id: 'aws:canary',
        label: 'canary',
        target: 'aws',
        credential_ref: 'aws-profile://papercusp-automation',
        provider_config: { region: 'us-east-1', subnetId: 'subnet-1' },
        status: 'connected',
        status_detail: null,
        scopes: [{ id: '413781344298', label: 'AWS account 413781344298' }],
      },
    ]);

    const stored = await readWorkspaceHostConnection('ws-1', 'aws:canary');
    expect(stored?.connection.scope).toEqual({ kind: 'account', id: '413781344298' });
  });

  it('derives no scope from ambiguous or absent persisted input rather than guessing one', () => {
    expect(storedWorkspaceHostConnectionScope('aws', [], {})).toBeUndefined();
    expect(storedWorkspaceHostConnectionScope('aws', null, {})).toBeUndefined();
    expect(storedWorkspaceHostConnectionScope('aws', [{ id: '111111111111' }, { id: '222222222222' }], {})).toBeUndefined();
    expect(storedWorkspaceHostConnectionScope('aws', [{ id: ' 413781344298 ' }], {})).toEqual({ kind: 'account', id: '413781344298' });
    expect(storedWorkspaceHostConnectionScope('gcp', [{ id: 'other' }], {})).toBeUndefined();
    expect(storedWorkspaceHostConnectionScope('gcp', [], { projectId: 'p-1' })).toEqual({ kind: 'project', id: 'p-1' });
    expect(storedWorkspaceHostConnectionScope('azure', [{ id: 'x' }], { projectId: 'p-1' })).toBeUndefined();
  });

  it('rejects secret-shaped hosted provider metadata before persistence', async () => {
    await expect(
      upsertWorkspaceHostConnection({
        workspaceId: 'ws-1',
        id: 'connection-1',
        target: 'azure',
        label: 'Hosted Azure',
        credentialRef: 'resolver://workspace-1/azure/generation-1',
        provider: { tenantId: 'tenant-1', clientSecret: 'never-persist-me' },
        status: 'connected',
      }),
    ).rejects.toThrow(/Secret-shaped field/);
    expect(H.withWorkspace).not.toHaveBeenCalled();
  });

  it('hydrates operation-scoped resource checkpoints for replay', async () => {
    H.rows.set('FROM harness_shared.workspace_host_resources WHERE workspace_id', [
      {
        logical_key: 'create-instance',
        state: 'retry-wait',
        attempts: 1,
        retry_class: 'ambiguous',
        retry_after_ms: 2_000,
        target: 'gcp',
        kind: 'vm',
        provider_id: 'pc-host-vm',
        incarnation_id: 'allocation-123',
        parent_provider_id: 'project-1',
        region: 'us-central1',
        zone: 'us-central1-a',
        provider_request_id: 'operation-1',
        deletion_confirmation: null,
        error: { message: 'provider outcome unknown' },
      },
    ]);

    await expect(readWorkspaceHostResourceCheckpoints('ws-1', 'host-1', 'op-1')).resolves.toEqual([
      {
        logicalKey: 'create-instance',
        state: 'retry-wait',
        attempts: 1,
        retryClass: 'ambiguous',
        retryAfterMs: 2_000,
        providerResource: {
          target: 'gcp',
          kind: 'vm',
          providerId: 'pc-host-vm',
          incarnationId: 'allocation-123',
          parentProviderId: 'project-1',
          region: 'us-central1',
          zone: 'us-central1-a',
        },
        providerRequestId: 'operation-1',
        error: 'provider outcome unknown',
      },
    ]);
  });

  it('recovers and deduplicates the persisted provider graph for a later destroy', async () => {
    H.rows.set('FROM harness_shared.workspace_hosts WHERE workspace_id', [
      {
        id: 'host-1',
        name: 'Canary host',
        connection_id: 'connection-1',
        target: 'gcp',
        observed_state: 'running',
        hosted_customer_workspace_ids: ['customer-1'],
        desired_spec: { hostId: 'host-1', target: 'gcp', region: 'us-central1' },
      },
    ]);
    H.rows.set("state IN ('applied', 'unchanged', 'absent')", [
      {
        target: 'gcp',
        kind: 'vm',
        provider_id: 'pc-host-vm',
        incarnation_id: 'allocation-current',
        parent_provider_id: 'project-1',
        region: 'us-central1',
        zone: 'us-central1-a',
        updated_at: '2026-08-25T00:01:00Z',
      },
      {
        target: 'gcp',
        kind: 'vm',
        provider_id: 'pc-host-vm',
        parent_provider_id: 'project-1',
        region: 'us-central1',
        zone: 'us-central1-a',
        updated_at: '2026-08-25T00:00:00Z',
      },
    ]);

    await expect(readWorkspaceHostDestroyTarget('ws-1', 'host-1')).resolves.toMatchObject({
      id: 'host-1',
      connectionId: 'connection-1',
      hostedCustomerWorkspaceId: 'customer-1',
      resources: [
        {
          resource: {
            target: 'gcp',
            kind: 'vm',
            providerId: 'pc-host-vm',
            incarnationId: 'allocation-current',
            parentProviderId: 'project-1',
          },
          registeredAt: '2026-08-25T00:01:00.000Z',
        },
      ],
    });
  });

  it('refuses multiple canonical customer bindings instead of choosing a tenant for the data disk', async () => {
    H.rows.set('FROM harness_shared.workspace_hosts WHERE workspace_id', [{ id: 'host-1',
      desired_spec: { hostId: 'host-1' }, hosted_customer_workspace_ids: ['customer-1', 'customer-2'] }]);
    await expect(readWorkspaceHostDestroyTarget('ws-1', 'host-1')).rejects.toThrow('ambiguous hosted customer bindings');
  });

  it('retains an unknown original pool allocation for fail-closed launch while keeping teardown readable', async () => {
    H.rows.set('FROM harness_shared.workspace_hosts WHERE workspace_id', [{ id: 'host-1',
      desired_spec: { hostId: 'host-1', data: { allocation: { dbGiB: 999, workspaceGiB: 999 } } },
      hosted_customer_workspace_ids: ['customer-1'] }]);
    H.rows.set('FROM harness_shared.workspace_host_operations origin', [{ id: 'original-pool-operation',
      customer_workspace_id: 'customer-1', allocation: null }]);
    await expect(readWorkspaceHostDestroyTarget('ws-1', 'host-1')).resolves.toMatchObject({
      durableStorageAdmission: { operationId: 'original-pool-operation', customerWorkspaceId: 'customer-1', allocation: null },
    });
  });

  it('un-registers a resource whose LATEST row confirms it absent, even when an older row registered it', async () => {
    // WI-10005971: an AWS upgrade terminates the original instance on its own step row; the
    // provision row that registered it stays `applied`. The newest row per identity decides.
    H.rows.set('FROM harness_shared.workspace_hosts WHERE workspace_id', [
      {
        id: 'host-1',
        name: 'Canary host',
        connection_id: 'connection-1',
        target: 'aws',
        observed_state: 'running',
        desired_spec: { hostId: 'host-1', target: 'aws', region: 'us-east-1' },
      },
    ]);
    const row = (providerId: string, kind: string, state: string, updatedAt: string) => ({
      target: 'aws',
      kind,
      provider_id: providerId,
      parent_provider_id: null,
      region: 'us-east-1',
      zone: null,
      state,
      updated_at: updatedAt,
    });
    // ORDER BY updated_at DESC, as the query returns them.
    H.rows.set("state IN ('applied', 'unchanged', 'absent')", [
      row('i-original', 'vm', 'absent', '2026-10-03T00:06:00Z'),
      row('i-replacement', 'vm', 'applied', '2026-10-03T00:05:00Z'),
      row('i-original', 'vm', 'applied', '2026-10-03T00:01:00Z'),
      row('vol-data', 'disk', 'applied', '2026-10-01T00:00:00Z'),
      row('i-original', 'vm', 'applied', '2026-10-01T00:00:00Z'),
    ]);

    const target = await readWorkspaceHostDestroyTarget('ws-1', 'host-1');
    expect(target?.resources.map((entry) => entry.resource.providerId)).toEqual(['i-replacement', 'vol-data']);
  });

  it('projects the latest operation, resource ids, health, signals, logs, and timeline', async () => {
    H.rows.set('FROM harness_shared.workspace_host_connections', [
      {
        id: 'connection-1',
        target: 'gcp',
        label: 'Production',
        credential_ref: 'env:GCP',
        provider_config: { projectId: 'project-1' },
        status: 'connected',
        status_detail: null,
        last_validated_at: '2026-08-22T00:00:00Z',
        scopes: [],
        regions: [],
        sizes: [],
        images: [],
        networks: [],
        disk_price_per_gib_month: '0.12',
      },
    ]);
    H.rows.set('FROM harness_shared.workspace_hosts', [
      {
        id: 'host-1',
        name: 'research',
        connection_id: 'connection-1',
        target: 'gcp',
        scope_label: 'project-1',
        region: 'us-central1',
        size: 'e2-standard-4',
        image: 'ubuntu',
        disk_gib: 100,
        network: 'default',
        estimated_monthly_usd: '72.9',
        desired_state: 'running',
        observed_state: 'running',
        observed_at: '2026-08-22T00:03:00Z',
        /* Deliberately two days before `observed_at`: `created_at` survives the
           host upsert's ON CONFLICT UPDATE set, so it is the only column that
           still means "when this host was provisioned" after a reconcile has
           moved `observed_at`. */
        created_at: '2026-08-20T00:00:00Z',
        endpoint: 'ssh://host-1',
        recoverability_kind: 'snapshot',
        recoverability_label: 'snap-1',
        recoverability_updated_at: null,
        health_status: 'healthy',
        health_attested_at: '2026-08-22T00:02:00Z',
        health_checks: [{ name: 'agent', ok: true }],
        bootstrap_version: '1.4.0',
        version_drift: [{ component: 'agent', desired: '1.4.0', observed: '1.3.0' }],
        tunnel_status: { connected: true },
        cost_signals: [{ monthlyUsd: 72.9 }],
        quota_signals: [{ name: 'cpu', remaining: 8 }],
      },
    ]);
    H.rows.set('FROM harness_shared.workspace_host_operations', [
      {
        id: 'op-1',
        host_id: 'host-1',
        action: 'provision',
        status: 'succeeded',
        percent: 100,
        message: 'attested',
        request: { image: 'ubuntu' },
        error: null,
        created_at: '2026-08-22T00:00:00Z',
        started_at: '2026-08-22T00:00:10Z',
        finished_at: '2026-08-22T00:03:00Z',
        updated_at: '2026-08-22T00:03:00Z',
      },
    ]);
    H.rows.set('FROM harness_shared.workspace_host_resources', [
      {
        host_id: 'host-1',
        logical_key: 'vm',
        operation_id: 'op-1',
        state: 'applied',
        attempts: 1,
        retry_class: null,
        target: 'gcp',
        kind: 'vm',
        provider_id: 'projects/p/zones/z/instances/research',
        parent_provider_id: null,
        region: 'us-central1',
        zone: 'us-central1-a',
        provider_request_id: 'request-1',
        deletion_confirmation: {
          hostId: 'host-1',
          providerResourceId: 'projects/p/zones/z/instances/research',
          confirmedAbsentAt: '2026-08-25T00:03:00Z',
          source: 'provider-read',
        },
        error: null,
        updated_at: '2026-08-22T00:01:00Z',
      },
    ]);
    H.rows.set('FROM harness_shared.workspace_host_events e JOIN (', [
      {
        id: 'event-1',
        host_id: 'host-1',
        operation_id: 'op-1',
        occurred_at: '2026-08-22T00:02:00Z',
        phase: 'attest',
        status: 'succeeded',
        level: 'info',
        source: 'controller',
        message: 'healthy',
        details: null,
      },
    ]);
    H.rows.set('FROM ( SELECT l.*', [
      {
        id: 'log-1',
        host_id: 'host-1',
        operation_id: 'op-1',
        observed_at: '2026-08-22T00:02:30Z',
        stream: 'systemd',
        unit: 'papercusp-agent',
        level: 'info',
        message: 'ready',
        metadata: null,
      },
    ]);

    const rows = await readWorkspaceHostControl('ws-1');
    expect(H.withWorkspace).toHaveBeenCalledWith('ws-1', expect.any(Function));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: 'connection',
      credentialRef: 'env://[configured]',
      provider: { projectId: 'project-1' },
    });
    expect(JSON.stringify(rows[0])).not.toContain('env:GCP_APPLICATION_CREDENTIALS');
    expect(rows[1]).toMatchObject({
      kind: 'workspace',
      id: 'host-1',
      /* Distinct from observedAt, and it has to be: the rail's Configure step
         reports how long ago the fleet was PROVISIONED, which no observation
         stamp can answer once a lifecycle action has refreshed it. */
      provisionedAt: '2026-08-20T00:00:00.000Z',
      observedAt: '2026-08-22T00:03:00.000Z',
      providerResourceId: 'projects/p/zones/z/instances/research',
      health: { status: 'healthy', bootstrapVersion: '1.4.0' },
      tunnel: { connected: true },
      operation: {
        id: 'op-1',
        request: { image: 'ubuntu' },
        events: [{ id: 'event-1', source: 'controller', level: 'info' }],
      },
      resources: [
        {
          logicalKey: 'vm',
          providerRequestId: 'request-1',
          deletionConfirmation: { source: 'provider-read' },
        },
      ],
      logs: [{ id: 'log-1', stream: 'systemd', unit: 'papercusp-agent' }],
    });
  });

  it.each(['gcp', 'aws'])('offers %s restore only when an applied snapshot has a provider identity', async (target) => {
    H.rows.set('FROM harness_shared.workspace_hosts', [{ id: 'host-1', name: 'research', target, observed_state: 'running',
      desired_state: 'running', created_at: '2026-08-20T00:00:00Z' }]);
    const resource = { host_id: 'host-1', logical_key: 'snapshot', kind: 'snapshot', target, state: 'applied', provider_id: 'snapshot-1', attempts: 1 };
    for (const [resources, enabled] of [
      [[], false], [[{ ...resource, state: 'running' }], false], [[{ ...resource, provider_id: null }], false], [[resource], true],
    ] as const) {
      H.rows.set('FROM harness_shared.workspace_host_resources', [...resources]);
      const rows = await readWorkspaceHostControl('ws-1');
      expect(rows[0]).toMatchObject({ capabilities: { restore: enabled } });
    }
  });

  it('does not project stale operation progress for an absent host tombstone', async () => {
    H.rows.set('FROM harness_shared.workspace_hosts', [
      {
        id: 'host-tombstone',
        name: 'removed host',
        connection_id: 'connection-1',
        target: 'gcp',
        scope_label: 'project-1',
        region: 'us-central1',
        size: 'e2-standard-4',
        image: 'ubuntu',
        disk_gib: 100,
        network: 'default',
        estimated_monthly_usd: '72.9',
        desired_state: 'absent',
        observed_state: 'absent',
        observed_at: '2026-08-31T11:49:15Z',
        created_at: '2026-08-31T11:22:43Z',
        endpoint: null,
        recoverability_kind: 'none',
        recoverability_label: 'Not recoverable',
        recoverability_updated_at: null,
        health_status: null,
        health_attested_at: null,
        health_checks: [],
        bootstrap_version: null,
        version_drift: [],
        tunnel_status: {},
        cost_signals: [],
        quota_signals: [],
        host_generation: 1,
        desired_revision: 1,
        observed_revision: 1,
        runtime_release: null,
        controller_id: null,
        controller_fence: 0,
      },
    ]);
    H.rows.set('FROM harness_shared.workspace_host_operations', [
      {
        id: 'stale-running-operation',
        host_id: 'host-tombstone',
        action: 'destroy',
        status: 'running',
        percent: 85,
        message: 'destroying',
        request: null,
        error: null,
        created_at: '2026-08-31T11:22:43Z',
        started_at: '2026-08-31T11:22:43Z',
        finished_at: null,
        updated_at: '2026-09-06T21:48:55Z',
        desired_revision: 1,
        controller_id: null,
        controller_fence: null,
      },
    ]);

    const rows = await readWorkspaceHostControl('ws-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'workspace',
      id: 'host-tombstone',
      desiredState: 'absent',
      observedState: 'absent',
    });
    expect((rows[0] as { operation?: unknown }).operation).toBeUndefined();
  });

  it('pushes exactly once after a committed diagnostics batch', async () => {
    const ids = await appendWorkspaceHostLogs('ws-1', 'host-1', [
      { id: 'log-1', stream: 'cloud-init', message: 'booting' },
      { id: 'log-2', stream: 'systemd', unit: 'papercusp-agent', message: 'ready' },
    ]);
    expect(ids).toEqual(['log-1', 'log-2']);
    expect(H.notify).toHaveBeenCalledTimes(1);
    expect(H.notify).toHaveBeenCalledWith(WORKSPACE_HOST_CONTROL_QUERY);
  });

  it('re-redacts a complete audit bundle before export', async () => {
    H.rows.set('FROM harness_shared.workspace_hosts WHERE', [
      { id: 'host-1', endpoint: 'https://alice:pw@example.test' },
    ]);
    H.rows.set('FROM harness_shared.workspace_host_operations WHERE', [{ id: 'op-1', request: { token: 'secret' } }]);
    H.rows.set('FROM harness_shared.workspace_host_resources WHERE', []);
    H.rows.set('FROM harness_shared.workspace_host_events WHERE', []);
    H.rows.set('FROM harness_shared.workspace_host_logs WHERE', [{ message: 'Authorization: Bearer abc.def.ghi' }]);

    const audit = await exportWorkspaceHostAudit('ws-1', 'host-1');
    expect(audit).toMatchObject({
      schemaVersion: 'papercusp-workspace-host-audit-v1',
      host: { endpoint: 'https://alice:[REDACTED]@example.test' },
      operations: [{ request: { token: '[REDACTED]' } }],
      logs: [{ message: 'Authorization: Bearer [REDACTED]' }],
    });
  });

  /**
   * WI-10001739 link 2. A DBOS step that exhausts its retries throws out of the provisioning
   * workflow and nothing marked the operation, so the row looked ALIVE until the hosted-lifecycle
   * reconciler reaped it ~20min later under a SYNTHESIZED hosted_lifecycle_recovery_exhausted.
   * Measured 2026-09-17: a destroy died 73s in and was reported 20.2min later under that code,
   * with the real cause (fence x2, then a provider network error) surviving only in the journal.
   */
  describe('terminal-failure recording', () => {
    function capturingTx(): {
      tx: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
      sql: string[];
      values: unknown[][];
      returns: unknown[];
    } {
      const sql: string[] = [];
      const values: unknown[][] = [];
      const returns: unknown[] = [{ id: 'op-1' }];
      const tx = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
        sql.push(strings.join(' ').replace(/\s+/g, ' ').trim());
        values.push(vals);
        return Promise.resolve(returns);
      };
      Object.assign(tx, { json: (value: unknown) => value });
      return { tx, sql, values, returns };
    }

    it('writes the cause without an authority check, without touching percent, and only while non-terminal', async () => {
      const cap = capturingTx();
      H.withWorkspace.mockImplementation(async (_workspaceId: string, run: (q: unknown) => unknown) =>
        run(cap.tx),
      );

      const wrote = await recordWorkspaceHostOperationTerminalFailure({
        workspaceId: 'ws-1',
        operationId: 'op-1',
        message: 'Workspace-host workflow failed',
        error: new Error('boom'),
      });

      expect(wrote).toBe(true);
      expect(cap.sql).toHaveLength(1);
      const [sql] = cap.sql;

      // 1. No controller-authority gate. Recording that a workflow DIED must not itself be
      //    fenced out, or the failure that matters most is the one that goes unrecorded.
      expect(sql).not.toMatch(/controller_fence|controller_id/);
      // 2. percent is never written: a destroy that reached 99% must keep that evidence, which is
      //    the only surviving signal of how far teardown actually got.
      expect(sql).not.toMatch(/\bpercent\b/);
      // 3. A late throw must not flip an already-finished operation to failed.
      expect(sql).toContain("status NOT IN ('succeeded', 'failed')");
    });

    it('preserves the nested cause chain rather than collapsing the error to {}', async () => {
      const cap = capturingTx();
      H.withWorkspace.mockImplementation(async (_workspaceId: string, run: (q: unknown) => unknown) =>
        run(cap.tx),
      );

      // The shape that actually reaches this writer: the provider error is NESTED inside the DBOS
      // retry wrapper, so a hand-rolled {name, message} projection would drop the only part that
      // identifies the real failure.
      const wrapped = new Error('Step workspace-host-destroy-1 has exceeded its maximum of 3 retries', {
        cause: new Error('workspace-host provider connection could not be reached'),
      });

      await recordWorkspaceHostOperationTerminalFailure({
        workspaceId: 'ws-1',
        operationId: 'op-1',
        message: 'Workspace-host workflow failed',
        error: wrapped,
      });

      const payload = cap.values[0]?.[1] as { code?: string; cause?: { message?: string; cause?: { message?: string } } };
      expect(payload.code).toBe('workflow_terminal_failure');
      expect(payload.cause?.message).toContain('exceeded its maximum of 3 retries');
      expect(payload.cause?.cause?.message).toContain('provider connection could not be reached');
    });

    it('redacts a secret carried in the error and reports when the row was already terminal', async () => {
      const cap = capturingTx();
      cap.returns.length = 0; // the UPDATE matched nothing: the row is already succeeded/failed
      H.withWorkspace.mockImplementation(async (_workspaceId: string, run: (q: unknown) => unknown) =>
        run(cap.tx),
      );

      const wrote = await recordWorkspaceHostOperationTerminalFailure({
        workspaceId: 'ws-1',
        operationId: 'op-1',
        message: 'Workspace-host workflow failed',
        error: new Error('refused for Authorization: Bearer abc.def.ghi'),
      });

      expect(wrote).toBe(false);
      const payload = cap.values[0]?.[1] as { cause?: { message?: string } };
      expect(payload.cause?.message).toContain('[REDACTED]');
      expect(payload.cause?.message).not.toContain('abc.def.ghi');
    });
  });
});
