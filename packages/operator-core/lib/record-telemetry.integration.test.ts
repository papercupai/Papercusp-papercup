/** Redacted browser crash reports must survive the real operator-state PG
 * write path before the hourly archive flush. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createHostedPrincipal } from './auth/hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from './telemetry-kinds';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { readOperatorState } = await import('./operator-state-pg');
const { recordTelemetryReport, readCloudTelemetryConsent, writeCloudTelemetryConsent, deliverCloudTelemetry, prepareCloudTelemetryDelivery, safeCloudError } = await import('./record-telemetry');
const { normalizeRenderCrashPayload } = await import('./endpoint-route/routes/desktop/telemetry-report');

const WS = 'ws-redacted-render-crash-persistence';

describe('redacted render crash persistence (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
  }, 120_000);

  afterAll(async () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    await db?.cleanup();
  });

  it('stores the server-normalized report in the existing workspace-scoped ring', async () => {
    const payload = normalizeRenderCrashPayload({
      source: 'render-boundary', boundary: 'adv-tab', errorType: 'TypeError',
      component: 'LearningTab', tab: 'learning', message: 'secret-token=abc',
      stack: 'private stack', url: 'https://example.invalid/?secret-token=abc',
    });
    expect(payload).toMatchObject({ fingerprint: 'adv-tab:TypeError:LearningTab:learning' });
    await recordTelemetryReport({
      kind: 'crash', payload,
      receivedAt: '2026-09-25T18:00:00Z',
    });
    const ring = await readOperatorState<{ reports: Array<{ kind: string; payload: unknown }> }>('telemetry_reports');
    expect(ring?.reports).toHaveLength(1);
    expect(ring?.reports[0]).toMatchObject({ kind: 'crash', payload });
    const rows = await db.adminSql<Array<{ payload: { reports: unknown[] } }>>`
      SELECT payload FROM harness_shared.telemetry_reports WHERE workspace_id = ${WS}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.reports).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('secret-token');
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('https://');
  });

  it('uses persisted current tenant consent and keeps hostile/default/revoked exports out of the sink', async () => {
    const organizationA = randomUUID(), organizationB = randomUUID(), userA = randomUUID(), userB = randomUUID();
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organizationA,
      userId: userA, selectedWorkspaceId: 'customer-a', sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view', 'members:manage'] });
    const scoped = async <T>(organization: string, user: string, fn: (tx: Sql) => Promise<T>) =>
      await db.adminSql.begin(async transaction => {
        const tx = transaction as unknown as Sql;
        await tx.unsafe('SET LOCAL ROLE hosted_app');
        await tx`SELECT set_config('app.organization_id', ${organization}, true), set_config('app.user_id', ${user}, true)`;
        return fn(tx);
      }) as T;
    const readConsent = () => scoped(organizationA, userA, tx => readCloudTelemetryConsent(tx, principal));
    const enabled = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT,
      analytics: { enabled: true, since: '2026-10-13T12:00:00Z' },
      diagnostics: { enabled: true, since: '2026-10-13T12:00:00Z' } };
    const save = (consent: unknown) => scoped(organizationA, userA, tx => tx`
      INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
      VALUES (${organizationA}::uuid, ${userA}::uuid, ${JSON.stringify({ cloudMonitoring: consent, displayName: 'keep-local' })}::jsonb)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET profile = EXCLUDED.profile`);
    const context = { principal, environment: 'staging' as const, release: 'abcdef1234567', origin: 'portal' as const,
      hostingMode: 'byoc' as const, observedAt: '2026-10-13T13:00:00Z' };
    const event = { event: 'cloud_portal_session', operation_id: randomUUID(), properties: { action: 'signed_in' } };
    const send = vi.fn(async () => {});
    expect(await deliverCloudTelemetry(event, context, { readConsent, send })).toMatchObject({ delivered: false });
    expect(send).not.toHaveBeenCalled();
    await save(enabled);
    expect(await deliverCloudTelemetry(event, context, { readConsent, send })).toEqual({ delivered: true });
    expect(send).toHaveBeenCalledTimes(1); // same-sink positive control
    await expect(scoped(organizationB, userB, tx => readCloudTelemetryConsent(tx, principal))).rejects.toThrow('cloud_telemetry_scope_mismatch');
    const hidden = await scoped(organizationB, userB, tx => tx`
      SELECT profile FROM papercusp_auth.hosted_user_preferences WHERE organization_id = ${organizationA}::uuid AND user_id = ${userA}::uuid`);
    expect(hidden).toHaveLength(0);
    const aggregate = { event: 'cloud_diagnostic_aggregate', operation_id: randomUUID(), properties: {
      period_start: '2026-10-13T12:00:00Z', period_end: '2026-10-13T13:00:00Z', calls: 1,
      input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0,
      provider_cost_usd: null, estimated_cost_usd: 0.01, unpriced_calls: 0 } };
    const local = { ...context, origin: 'customer-runtime' as const };
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toEqual({ delivered: true });
    expect(await deliverCloudTelemetry({ ...aggregate, properties: { ...aggregate.properties, account_id: 'secret', rlResetAt: 12 } }, local,
      { readConsent, send })).toMatchObject({ delivered: false, code: 'invalid_cloud_event' });
    await save({ ...enabled, diagnostics: { enabled: false, since: null } });
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toMatchObject({ delivered: false, code: 'consent_disabled' });
    await save({ ...enabled, diagnostics: { enabled: true, since: '2026-10-13T12:30:00Z' } });
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toMatchObject({ delivered: false, code: 'outside_consent_epoch' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/secret|keep-local/);
  });

  it('persists only authenticated consent choices, preserves preferences and rotates revoked epochs', async () => {
    const organization = randomUUID(), user = randomUUID();
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organization,
      userId: user, sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view', 'members:manage'] });
    const scoped = async <T>(fn: (tx: Sql) => Promise<T>, scope = organization) =>
      await db.adminSql.begin(async transaction => {
        const tx = transaction as unknown as Sql;
        await tx.unsafe('SET LOCAL ROLE hosted_app');
        await tx`SELECT set_config('app.organization_id', ${scope}, true), set_config('app.user_id', ${user}, true)`;
        return fn(tx);
      }) as T;
    await scoped(tx => tx`INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
      VALUES (${organization}::uuid, ${user}::uuid, '{"displayName":"private-profile"}'::jsonb)`);
    const disclosure_version = DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version;
    const granted = await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: true }));
    expect(granted.analytics.enabled).toBe(true);
    expect(Number.isFinite(Date.parse(granted.analytics.since!))).toBe(true);
    expect(granted.diagnostics.enabled).toBe(false);
    const unchanged = await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: true }));
    expect(unchanged.analytics.since).toBe(granted.analytics.since);
    await expect(scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, diagnostics: true }), randomUUID()))
      .rejects.toThrow('cloud_telemetry_scope_mismatch');
    await expect(scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: true, since: '2000-01-01T00:00:00Z' })))
      .rejects.toThrow();
    const revoked = await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: false }));
    expect(revoked.analytics).toEqual({ enabled: false, since: null });
    const renewed = await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version, analytics: true }));
    expect(Date.parse(renewed.analytics.since!)).toBeGreaterThan(Date.parse(granted.analytics.since!));
    const [row] = await scoped(tx => tx<{ profile: { displayName: string } }[]>`
      SELECT profile FROM papercusp_auth.hosted_user_preferences WHERE organization_id = ${organization}::uuid AND user_id = ${user}::uuid`);
    expect(row.profile.displayName).toBe('private-profile');
    const send = vi.fn(async () => {});
    const context = { principal, environment: 'staging' as const, release: 'abcdef1234567', origin: 'portal' as const, hostingMode: 'byoc' as const };
    const event = { event: 'cloud_error', operation_id: randomUUID(), properties: safeCloudError('render_failure', new TypeError('private-profile')) };
    expect(await deliverCloudTelemetry(event, context, { readConsent: () => scoped(tx => readCloudTelemetryConsent(tx, principal)), send }))
      .toEqual({ delivered: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain('private-profile');
    expect(await deliverCloudTelemetry({ ...event, properties: { ...event.properties, message: 'private-profile' } }, context,
      { readConsent: () => scoped(tx => readCloudTelemetryConsent(tx, principal)), send })).toMatchObject({ delivered: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.env.PAPERCUSP_TEST_POSTHOG_LIVE === 'true')('confirms synthetic opt-in ingestion and absent default/hostile/revoked exports in configured PostHog', async () => {
    const { getPosthogConfigWithSource } = await import('./posthog-config');
    const { deliverCloudPosthog, readCloudCaptureHealth } = await import('./telemetry-flush');
    const config = getPosthogConfigWithSource().config;
    expect(config).not.toBeNull();
    if (!config) throw new Error('configured PostHog required');
    expect(await readCloudCaptureHealth(), 'PostHog capture ingress must be available before measuring privacy').toEqual({ healthy: true, status: 400 });
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(config.host.replace(/\/+$/, '') + path, { headers: {
        authorization: `Bearer ${config.personalApiKey}`, 'content-type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      expect(response.status, `PostHog ${path} request: ${text.slice(0, 1_000)}`).toBe(200);
      return JSON.parse(text);
    };
    const projects = await request('/api/projects/');
    const project = projects.results.find((value: { api_token: string }) => value.api_token === config.projectKey);
    expect(project).toBeDefined();
    const probe = await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery', query: 'SELECT 1' } });
    expect(probe.results, 'query permission preflight').toEqual([[1]]);
    const organization = randomUUID(), user = randomUUID();
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organization,
      userId: user, selectedWorkspaceId: randomUUID(), sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view', 'members:manage'] });
    const scoped = async <T>(fn: (tx: Sql) => Promise<T>) => await db.adminSql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      await tx`SELECT set_config('app.organization_id', ${organization}, true), set_config('app.user_id', ${user}, true)`;
      return fn(tx);
    }) as T;
    const readConsent = () => scoped(tx => readCloudTelemetryConsent(tx, principal));
    const context = { principal, environment: 'staging' as const, release: process.env.PAPERCUSP_TEST_BUILD_SHA?.slice(0,40) ?? 'abcdef1234567',
      origin: 'customer-runtime' as const, hostingMode: 'byoc' as const, synthetic: true };
    const make = () => ({ event: 'cloud_diagnostic_aggregate', operation_id: randomUUID(), properties: {
      period_start: new Date().toISOString(), period_end: new Date().toISOString(), calls: 1,
      input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0,
      provider_cost_usd: null, estimated_cost_usd: 0.01, unpriced_calls: 0 } });
    const windowStart = new Date(Date.now() - 1_000).toISOString();
    const defaultEvent = make();
    expect(await deliverCloudPosthog(defaultEvent, context, readConsent)).toMatchObject({ delivered: false, code: 'consent_disabled' });
    const granted = await scoped(tx => writeCloudTelemetryConsent(tx, principal, {
      disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, diagnostics: true }));
    const positive = make(), secondSessionPositive = make(), hostile = make(), revoked = make();
    const identities = [defaultEvent, positive, secondSessionPositive, hostile, revoked].map(event => {
      const prepared = prepareCloudTelemetryDelivery(event, context, { ...granted, diagnostics: { enabled: true, since: '2000-01-01T00:00:00Z' } });
      if (!prepared.ok) throw new Error('synthetic identity preparation failed');
      return prepared.envelope.properties.operation_id;
    });
    expect(await deliverCloudPosthog(positive, context, readConsent)).toEqual({ delivered: true });
    const secondPrincipal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organization,
      userId: user, selectedWorkspaceId: principal.selectedWorkspaceId, sessionId: randomUUID(), sessionVersion: 2, permissions: ['workspace:view', 'members:manage'] });
    expect(await deliverCloudPosthog(secondSessionPositive, { ...context, principal: secondPrincipal }, readConsent)).toEqual({ delivered: true });
    expect(await deliverCloudPosthog({ ...hostile, properties: { ...hostile.properties, prompt: 'synthetic-forbidden-field' } }, context, readConsent))
      .toMatchObject({ delivered: false, code: 'invalid_cloud_event' });
    await scoped(tx => writeCloudTelemetryConsent(tx, principal, { disclosure_version: granted.disclosure_version, diagnostics: false }));
    expect(await deliverCloudPosthog(revoked, context, readConsent)).toMatchObject({ delivered: false, code: 'consent_disabled' });
    const windowEnd = new Date(Date.now() + 1_000).toISOString();
    const query = `SELECT properties.operation_id, distinct_id, properties.organization_id, properties.workspace_id, uuid FROM events WHERE event = 'cloud_diagnostic_aggregate' AND timestamp >= parseDateTimeBestEffort('${windowStart}') AND timestamp <= parseDateTimeBestEffort('${windowEnd}') AND properties.operation_id IN (${identities.map(id => `'${id}'`).join(',')}) ORDER BY properties.operation_id`;
    console.info('CLOUD_MONITORING_PRIVACY_QUERY', JSON.stringify({ projectId: project.id, windowStart, windowEnd, query }));
    let rows: string[][] = [], queryResult: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery', query } });
      expect(result.is_cached, 'privacy ingestion proof must use a fresh query').toBe(false);
      queryResult = result; rows = result.results;
      if (rows.some(([id]) => id === identities[1]) && rows.some(([id]) => id === identities[2])) break;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    expect(rows.map(row => row[0]).sort()).toEqual(identities.slice(1, 3).sort());
    for (const column of [1, 2, 3]) {
      expect(new Set(rows.map(row => row[column])).size).toBe(1);
      expect(rows[0]![column]).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const row of rows) expect(row[4]).toMatch(/^[a-f0-9-]{36}$/);
    for (const raw of [organization, user, principal.selectedWorkspaceId!, principal.sessionId, secondPrincipal.sessionId])
      expect(JSON.stringify(rows)).not.toContain(raw);
    console.info('CLOUD_MONITORING_PRIVACY_RECEIPT', JSON.stringify({ projectId: project.id,
      windowStart, windowEnd, approvedOperations: identities.slice(1, 3), excludedOperations: [identities[0], ...identities.slice(3)],
      query, result: queryResult }));
  }, 90_000);

  it.runIf(process.env.PAPERCUSP_TEST_POSTHOG_LIVE === 'true')('ingests distinct confirmed phases and saved reviews once, rejects forged browser reviews, and materializes isolated business views', async () => {
    const { getPosthogConfigWithSource } = await import('./posthog-config');
    const { deliverCloudPosthog, ensureCloudMonitoringDashboard, cloudMonitoringDashboardViews } = await import('./telemetry-flush');
    const config = getPosthogConfigWithSource().config;
    if (!config) throw new Error('configured PostHog required');
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(config.host.replace(/\/+$/, '') + path, { headers: {
        authorization: `Bearer ${config.personalApiKey}`, 'content-type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
      const text = await response.text();
      expect(response.status, `PostHog ${path}: ${text.slice(0, 1_000)}`).toBe(200); return JSON.parse(text);
    };
    const projects = await request('/api/projects/');
    const project = projects.results.find((value: { api_token: string }) => value.api_token === config.projectKey);
    expect(project).toBeDefined();
    const organization = randomUUID(), user = randomUUID();
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organization,
      userId: user, selectedWorkspaceId: randomUUID(), sessionId: randomUUID(), sessionVersion: 1, permissions: ['workspace:view', 'members:manage'] });
    const scoped = async <T>(fn: (tx: Sql) => Promise<T>) => await db.adminSql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      await tx`SELECT set_config('app.organization_id', ${organization}, true), set_config('app.user_id', ${user}, true)`;
      return fn(tx);
    }) as T;
    const readConsent = () => scoped(tx => readCloudTelemetryConsent(tx, principal));
    const consent = await scoped(tx => writeCloudTelemetryConsent(tx, principal, {
      disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, analytics: true }));
    const context = { principal, environment: 'staging' as const, release: process.env.PAPERCUSP_TEST_BUILD_SHA?.slice(0,40) ?? 'abcdef1234567',
      origin: 'control-plane' as const, hostingMode: 'byoc' as const, synthetic: true };
    const operation_id = randomUUID(), reviewOperation = randomUUID(), forgedOperation = randomUUID();
    const makePhase = (phase: 'requested' | 'ready') => ({ event: 'cloud_workspace_provisioning', operation_id,
      properties: { phase, provider: 'gcp', hosting_mode: 'unknown', ...(phase === 'ready' ? { duration_ms: 10 } : {}) } });
    const makeReview = (lesson: string, operation = reviewOperation) => ({ event: 'product_tutorial', operation_id: operation,
      properties: { lesson_id: 'product-guide', lesson_version: 3, action: 'explanation_reviewed', lesson } });
    const events = [makePhase('requested'), makePhase('ready'), makePhase('ready'), makeReview('welcome'), makeReview('navigation'), makeReview('navigation')];
    for (const event of events) expect(await deliverCloudPosthog(event, context, readConsent)).toEqual({ delivered: true });
    expect(await deliverCloudPosthog(makeReview('welcome', forgedOperation), { ...context, origin: 'portal' }, readConsent))
      .toEqual({ delivered: false, code: 'unwitnessed_outcome' });
    const opaqueOperations = [operation_id, reviewOperation, forgedOperation].map(id => {
      const prepared = prepareCloudTelemetryDelivery(makeReview('welcome', id), context, consent);
      if (!prepared.ok) throw new Error('synthetic identity preparation failed'); return prepared.envelope.properties.operation_id;
    });
    const query = `SELECT event, properties.phase, properties.lesson, uniqExact(uuid), count() FROM events WHERE properties.operation_id IN (${opaqueOperations.map(id => `'${id}'`).join(',')}) GROUP BY event, properties.phase, properties.lesson ORDER BY event, properties.phase, properties.lesson`;
    let rows: unknown[][] = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      const result = await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery', query } });
      expect(result.is_cached).toBe(false); rows = result.results;
      if (rows.length === 4) break;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    expect(rows.map(row => [row[0], row[1] || null, row[2] || null, row[3]])).toEqual([
      ['cloud_workspace_provisioning', 'ready', null, 1], ['cloud_workspace_provisioning', 'requested', null, 1],
      ['product_tutorial', null, 'navigation', 1], ['product_tutorial', null, 'welcome', 1],
    ]);
    // A stable vendor UUID does not promise physically unique storage. Verify
    // the actual business query counts a witnessed operation once even when
    // the sink retains retries, rather than relying on eventual vendor merges.
    console.info('CLOUD_MONITORING_DELIVERY_CARDINALITY', JSON.stringify(rows));
    const durationQuery = cloudMonitoringDashboardViews('staging').find(view => view.name === 'Confirmed ready duration')!.query
      .replace('properties.synthetic = false', 'properties.synthetic = true')
      .replace('AND timestamp >=', `AND properties.operation_id = '${opaqueOperations[0]}' AND timestamp >=`);
    const duration = await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking',
      query: { kind: 'HogQLQuery', query: durationQuery } });
    expect(duration.results).toEqual([['gcp', 10, 1]]);
    const environmentInsights = new Map<string, number[]>();
    for (const environment of ['staging', 'production'] as const) {
      const first = await ensureCloudMonitoringDashboard(environment), repeated = await ensureCloudMonitoringDashboard(environment);
      expect(repeated.dashboardId).toBe(first.dashboardId); expect(repeated.insightIds).toEqual(first.insightIds);
      const dashboard = await request(`/api/projects/${project.id}/dashboards/${first.dashboardId}/`);
      expect(dashboard.name).toBe(`Papercusp cloud monitoring — ${environment}`);
      expect(first.insightIds).toHaveLength(cloudMonitoringDashboardViews(environment).length);
      environmentInsights.set(environment, first.insightIds);
      for (const id of first.insightIds) {
        const insight = await request(`/api/projects/${project.id}/insights/${id}/`);
        expect(insight.dashboards).toEqual([first.dashboardId]);
        expect(insight.query.source.query).toContain(`properties.environment = '${environment}'`);
      }
      console.info('CLOUD_MONITORING_DASHBOARD_RECEIPT', JSON.stringify({ environment, ...first }));
      const excluded = await request(`/api/projects/${project.id}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery',
        query: `SELECT count() FROM events WHERE properties.synthetic = false AND properties.environment = '${environment}' AND properties.operation_id IN (${opaqueOperations.map(id => `'${id}'`).join(',')})` } });
      expect(excluded.results).toEqual([[0]]);
    }
    expect(environmentInsights.get('staging')!.filter(id => environmentInsights.get('production')!.includes(id))).toEqual([]);
  }, 180_000);
});
