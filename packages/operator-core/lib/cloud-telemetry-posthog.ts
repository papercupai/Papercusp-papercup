/** Cloud capture and views reuse configured PostHog without local archive imports. */
import { createHash } from 'node:crypto';
import { getPosthogConfigWithSource } from './posthog-config';
import { POSTHOG_PUBLIC_DEFAULTS } from './posthog-public-defaults';
import { cloudTelemetryIdentity, cloudTelemetrySubjectIdentity, deliverCloudTelemetry, type CloudTelemetryContext } from './cloud-telemetry';
import { cloudTelemetryConsentSchema } from './telemetry-kinds';

/** Existing capture ingress is separate from the flag/admin API. A healthy
 * project listing cannot prove that events can enter the ingestion pipeline. */
export async function readCloudCaptureHealth(): Promise<{ healthy: boolean; status: number | null }> {
  const config = getPosthogConfigWithSource().config ?? POSTHOG_PUBLIC_DEFAULTS;
  try {
    const response = await fetch(`${config.host.replace(/\/+$/, '')}/batch/`, { signal: AbortSignal.timeout(2_000) });
    // The maintained capture server rejects a missing payload with 400.
    return { healthy: response.status === 400, status: response.status };
  } catch { return { healthy: false, status: null }; }
}

/** Strict cloud delivery shares the maintained PostHog configuration and batch
 * transport. Unlike local crash archives it never has an internal-build bypass
 * or a backlog: every delivery rechecks the customer's current scoped choice. */
export function deliverCloudPosthog(input: unknown, context: CloudTelemetryContext, readConsent: () => Promise<unknown>) {
  return deliverCloudTelemetry(input, context, { readConsent, send: async envelope => {
    const configured = getPosthogConfigWithSource().config;
    const config = configured ?? POSTHOG_PUBLIC_DEFAULTS;
    // Retries of one phase share an identity; a requested phase must never
    // deduplicate the later server-confirmed ready outcome of that operation.
    const insertId = createHash('sha256').update(JSON.stringify([
      envelope.event, envelope.properties.operation_id,
      'phase' in envelope.properties ? envelope.properties.phase : null,
      'action' in envelope.properties ? envelope.properties.action : null,
      'lesson' in envelope.properties ? envelope.properties.lesson : null,
    ])).digest('hex');
    // The maintained SDK supplies uuid at the event envelope. A property
    // named $insert_id alone does not select the capture event's identity.
    // Storage may still expose repeated deliveries; business queries must
    // aggregate by the witnessed operation rather than assume exactly once.
    const uuid = `${insertId.slice(0, 8)}-${insertId.slice(8, 12)}-5${insertId.slice(13, 16)}-8${insertId.slice(17, 20)}-${insertId.slice(20, 32)}`;
    const response = await fetch(`${config.host.replace(/\/+$/, '')}/batch/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: config.projectKey, batch: [{ ...envelope, uuid,
        properties: { ...envelope.properties, $insert_id: insertId } }] }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error('cloud_telemetry_delivery_rejected');
  } });
}

/** Existing PostHog insights are the activation view; no second metrics store.
 * These are observations from consenting portal users. Synthetic acceptance
 * probes and customer-runtime diagnostics never contribute to business views. */
export function cloudMonitoringDashboardViews(environment: CloudTelemetryContext['environment']) {
  if (!['development', 'staging', 'production'].includes(environment)) throw new Error('invalid_monitoring_environment');
  const scope = `properties.environment = '${environment}' AND properties.synthetic = false AND properties.source IN ('portal', 'control-plane')`;
  const recent = `${scope} AND timestamp >= now() - INTERVAL 30 DAY`;
  return [
    { name: 'Portal activity', query: `SELECT toDate(timestamp) AS day, properties.action AS action, uniqExact(distinct_id) AS observed_users, uniqExact(properties.operation_id) AS observations FROM events WHERE event = 'cloud_portal_session' AND ${recent} GROUP BY day, action ORDER BY day DESC` },
    { name: 'Confirmed provisioning outcomes', query: `SELECT properties.provider AS provider, properties.hosting_mode AS hosting_mode, properties.phase AS phase, uniqExact(properties.operation_id) AS operations FROM events WHERE event = 'cloud_workspace_provisioning' AND properties.source = 'control-plane' AND ${recent} GROUP BY provider, hosting_mode, phase ORDER BY provider, phase` },
    { name: 'Confirmed ready duration', query: `SELECT provider, avg(observed_duration_ms) AS observed_mean_ms, count() AS observed_samples FROM (SELECT properties.provider AS provider, properties.operation_id AS operation, max(toFloat(properties.duration_ms)) AS observed_duration_ms FROM events WHERE event = 'cloud_workspace_provisioning' AND properties.source = 'control-plane' AND properties.phase = 'ready' AND properties.duration_ms IS NOT NULL AND ${recent} GROUP BY provider, operation) GROUP BY provider` },
    { name: 'Public explanations reviewed', query: `SELECT properties.lesson AS lesson, uniqExact(distinct_id) AS observed_users, uniqExact(properties.operation_id) AS saved_reviews FROM events WHERE event = 'product_tutorial' AND properties.action = 'explanation_reviewed' AND properties.source = 'control-plane' AND ${recent} GROUP BY lesson ORDER BY saved_reviews DESC` },
    { name: 'Portal feature adoption', query: `SELECT properties.feature AS feature, uniqExact(distinct_id) AS observed_users, uniqExact(properties.operation_id) AS observations FROM events WHERE event = 'cloud_feature_adoption' AND ${recent} GROUP BY feature ORDER BY observed_users DESC` },
    { name: 'Safe service error codes', query: `SELECT properties.code AS code, properties.release AS release, uniqExact(properties.operation_id) AS observations FROM events WHERE event = 'cloud_error' AND ${recent} GROUP BY code, release ORDER BY observations DESC` },
    { name: 'Observed seven-day portal return', query: `WITH activity AS (SELECT distinct_id, toDate(timestamp) AS day FROM events WHERE event = 'cloud_portal_session' AND ${scope} AND timestamp >= now() - INTERVAL 60 DAY GROUP BY distinct_id, day), cohorts AS (SELECT distinct_id, min(day) AS first_observed_day FROM activity GROUP BY distinct_id) SELECT cohorts.first_observed_day AS cohort_day, uniqExact(cohorts.distinct_id) AS observed_users, uniqExactIf(cohorts.distinct_id, dateDiff('day', cohorts.first_observed_day, activity.day) BETWEEN 1 AND 7) AS returned_within_seven_days FROM cohorts LEFT JOIN activity ON cohorts.distinct_id = activity.distinct_id WHERE cohorts.first_observed_day <= today() - INTERVAL 7 DAY GROUP BY cohort_day ORDER BY cohort_day DESC` },
  ];
}

const CLOUD_MONITORING_DASHBOARD_TAG = 'papercusp-cloud-monitoring-v1';
/** Materialize maintained definitions in the already configured project. Query
 * support is checked before any write. Only our tagged dashboard is updated;
 * a name collision, incomplete catalog or unavailable query fails explicitly. */
async function configuredPosthogProject() {
  const config = getPosthogConfigWithSource().config;
  if (!config?.personalApiKey) throw new Error('posthog_dashboard_credentials_unavailable');
  const origin = new URL(config.host).origin;
  const request = async (path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<Record<string, any>> => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error('posthog_dashboard_foreign_origin');
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${config.personalApiKey}`,
      'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`posthog_dashboard_api_status_${response.status}`);
    return response.json();
  };
  const catalog = async (path: string) => {
    const rows: Array<Record<string, any>> = [];
    let next: string | null = path;
    for (let page = 0; next && page < 10; page++) {
      const data = await request(next);
      if (!Array.isArray(data.results)) throw new Error('posthog_dashboard_catalog_unavailable');
      rows.push(...data.results); next = data.next ?? null;
    }
    if (next) throw new Error('posthog_dashboard_catalog_incomplete');
    return rows;
  };
  const projects = (await catalog('/api/projects/?limit=100')).filter(project => project.api_token === config.projectKey);
  if (projects.length !== 1 || !Number.isSafeInteger(projects[0]!.id)) throw new Error('posthog_dashboard_project_unverified');
  const projectId: number = projects[0]!.id;
  const root = `/api/projects/${projectId}`;
  return { projectId, root, origin, request, catalog };
}

export type CloudProductUsageObservation = { status: 'unknown'; reason: string } | {
  status: 'observed'; windowStart: string; windowEnd: string; evidenceRef: string;
  /** Deduplicated event/operation observations, not counts of users or workspaces. */
  observations: number; portalSessionObservations: number; readyProvisioningObservations: number; featureAdoptionObservations: number;
};

export interface CloudProductUsageFailure {
  stage: 'project-selection' | 'usage-query' | 'consent-recheck';
  category: 'configuration' | 'authentication' | 'timeout' | 'transport' | 'response' | 'unavailable';
}

/** Never retain arbitrary exception text: a vendor response or fetch error can
 * contain credentials, query selectors or customer data. */
function usageFailureCategory(error: unknown): CloudProductUsageFailure['category'] {
  if (error instanceof Error) {
    if (error.message === 'posthog_dashboard_credentials_unavailable') return 'configuration';
    if (/^posthog_dashboard_api_status_(401|403)$/.test(error.message)) return 'authentication';
    if (/^posthog_dashboard_(api_status_\d{3}|catalog_unavailable|catalog_incomplete|project_unverified|foreign_origin)$/.test(error.message) ||
        error instanceof SyntaxError) return 'response';
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    if (error instanceof TypeError) return 'transport';
  }
  return 'unavailable';
}

/** Read original consented portal metadata, never customer-runtime diagnostics.
 * This observes metadata for one verified hosted identity; PostHog source flags
 * alone do not attest canonical provisioning outcomes. It does not bind a CRM
 * lead or calculate fit/usage scores. The supplied consent reader must use that
 * principal's existing tenant-scoped preference transaction. */
export async function readCloudProductUsage(input: {
  context: Pick<CloudTelemetryContext, 'principal' | 'environment'>;
  windowStart: string; windowEnd: string;
  readConsent: () => Promise<unknown>;
  /** Trusted host diagnostics only. Fixed vocabulary; no exception messages,
   * URLs, query text, credentials or customer identifiers are passed. */
  onUnavailable?: (failure: CloudProductUsageFailure) => void;
}): Promise<CloudProductUsageObservation> {
  let identity: ReturnType<typeof cloudTelemetryIdentity>;
  try { identity = cloudTelemetryIdentity(input.context); }
  catch { return { status: 'unknown', reason: 'identity_unavailable' }; }
  return readCloudProductUsageIdentity({ ...input, environment: input.context.environment, identity });
}

/** Internal service seam. Only a current receipt-derived storage subject may
 * enter here; this function neither grants access nor fabricates a session. */
export async function readCloudProductUsageForSubject(input: {
  subject: { userId: string; organizationId: string };
  environment: CloudTelemetryContext['environment']; windowStart: string; windowEnd: string;
  readConsent: () => Promise<unknown>;
}): Promise<CloudProductUsageObservation> {
  let identity: ReturnType<typeof cloudTelemetrySubjectIdentity>;
  try { identity = cloudTelemetrySubjectIdentity(input.subject, input.environment); }
  catch { return { status: 'unknown', reason: 'identity_unavailable' }; }
  return readCloudProductUsageIdentity({ ...input, identity, recheckBeforeQuery: true });
}

async function readCloudProductUsageIdentity(input: {
  identity: ReturnType<typeof cloudTelemetryIdentity>; environment: CloudTelemetryContext['environment'];
  windowStart: string; windowEnd: string; readConsent: () => Promise<unknown>;
  onUnavailable?: (failure: CloudProductUsageFailure) => void;
  recheckBeforeQuery?: boolean;
}): Promise<CloudProductUsageObservation> {
  const identity = input.identity;
  const start = Date.parse(input.windowStart), end = Date.parse(input.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 30 * 86_400_000) {
    return { status: 'unknown', reason: 'invalid_window' };
  }
  let consent: ReturnType<typeof cloudTelemetryConsentSchema.parse>;
  try { consent = cloudTelemetryConsentSchema.parse(await input.readConsent()); }
  catch { return { status: 'unknown', reason: 'consent_unavailable' }; }
  if (!consent.analytics.enabled || !consent.analytics.since) return { status: 'unknown', reason: 'consent_disabled' };
  const effectiveStart = Math.max(start, Date.parse(consent.analytics.since));
  if (effectiveStart >= end) return { status: 'unknown', reason: 'outside_consent_epoch' };
  const windowStart = new Date(effectiveStart).toISOString(), windowEnd = new Date(end).toISOString();
  // Every interpolated selector is generated from a verified identity, an enum
  // or an ISO timestamp. No caller-authored SQL or attribution enters the query.
  const query = `SELECT uniqExact(concat(event, ':', properties.operation_id)) AS observations, ` +
    `uniqExactIf(properties.operation_id, event = 'cloud_portal_session') AS portalSessionObservations, ` +
    `uniqExactIf(properties.operation_id, event = 'cloud_workspace_provisioning' AND properties.phase = 'ready' AND properties.source = 'control-plane') AS readyProvisioningObservations, ` +
    `uniqExactIf(properties.operation_id, event = 'cloud_feature_adoption') AS featureAdoptionObservations ` +
    `FROM events WHERE distinct_id = '${identity.distinctId}' AND properties.organization_id = '${identity.organizationId}' ` +
    `AND properties.environment = '${input.environment}' AND properties.synthetic = false ` +
    `AND properties.source IN ('portal', 'control-plane') AND properties.operation_id IS NOT NULL AND properties.operation_id != '' ` +
    `AND (event IN ('cloud_portal_session', 'cloud_feature_adoption') OR (event = 'cloud_workspace_provisioning' AND properties.phase = 'ready' AND properties.source = 'control-plane')) ` +
    `AND timestamp >= toDateTime('${windowStart}') AND timestamp < toDateTime('${windowEnd}')`;
  let stage: CloudProductUsageFailure['stage'] = 'project-selection';
  try {
    const { projectId, root, request } = await configuredPosthogProject();
    if (input.recheckBeforeQuery) {
      // Project discovery is itself a network read. A service grant may have
      // changed while it ran; recheck before sending subject selectors.
      stage = 'consent-recheck';
      const current = cloudTelemetryConsentSchema.parse(await input.readConsent());
      if (!current.analytics.enabled || current.analytics.since !== consent.analytics.since) {
        return { status: 'unknown', reason: 'consent_changed' };
      }
    }
    stage = 'usage-query';
    const result = await request(`${root}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery', query } });
    const columns = ['observations', 'portalSessionObservations', 'readyProvisioningObservations', 'featureAdoptionObservations'];
    if (JSON.stringify(result.columns) !== JSON.stringify(columns) || !Array.isArray(result.results) || result.results.length !== 1 ||
        !Array.isArray(result.results[0]) || result.results[0].length !== 4 || result.hasMore === true || result.has_more === true ||
        result.results[0].some((n: unknown) => !Number.isSafeInteger(n) || (n as number) < 0)) {
      return { status: 'unknown', reason: 'usage_response_invalid' };
    }
    const [observations, portalSessionObservations, readyProvisioningObservations, featureAdoptionObservations] = result.results[0] as [number, number, number, number];
    if (observations !== portalSessionObservations + readyProvisioningObservations + featureAdoptionObservations) return { status: 'unknown', reason: 'usage_response_invalid' };
    // Recheck revocation/epoch after the network read, before returning data.
    stage = 'consent-recheck';
    const current = cloudTelemetryConsentSchema.parse(await input.readConsent());
    if (!current.analytics.enabled || current.analytics.since !== consent.analytics.since) return { status: 'unknown', reason: 'consent_changed' };
    if (observations === 0) return { status: 'unknown', reason: 'no_observations' };
    return { status: 'observed', windowStart, windowEnd, observations, portalSessionObservations, readyProvisioningObservations, featureAdoptionObservations,
      evidenceRef: `posthog:${projectId}:hogql:${createHash('sha256').update(query).digest('hex')}` };
  } catch (error) {
    // An observer cannot turn an unavailable measurement into a thrown task or
    // an invented reading, even if its own logging transport is unavailable.
    try { input.onUnavailable?.({ stage, category: usageFailureCategory(error) }); } catch {}
    return { status: 'unknown', reason: 'usage_query_unavailable' };
  }
}

export async function ensureCloudMonitoringDashboard(environment: CloudTelemetryContext['environment']) {
  const views = cloudMonitoringDashboardViews(environment);
  const { projectId, root, origin, request, catalog } = await configuredPosthogProject();
  for (const view of views) await request(`${root}/query/`, { refresh: 'force_blocking', query: { kind: 'HogQLQuery', query: view.query } });
  const name = `Papercusp cloud monitoring — ${environment}`;
  const matches = (await catalog(`${root}/dashboards/?limit=100`)).filter(dashboard => dashboard.name === name);
  if (matches.length > 1 || (matches[0] && !matches[0].tags?.includes(CLOUD_MONITORING_DASHBOARD_TAG))) throw new Error('posthog_dashboard_name_conflict');
  const dashboard = matches[0] ?? await request(`${root}/dashboards/`, { name,
    tags: [CLOUD_MONITORING_DASHBOARD_TAG, environment],
    description: 'Consented portal/control-plane metadata only. Synthetic probes excluded. Public explanation review is learning progress, not task success. Customer BYOC usage and provider/cloud bills remain local. Empty data is no observation; retention is based on first observed portal activity within 60 days.' });
  if (!Number.isSafeInteger(dashboard.id) || dashboard.id < 1) throw new Error('posthog_dashboard_identity_unavailable');
  // This deployment ignores the dashboard list filter. Verify membership
  // from each returned insight instead of letting another environment's
  // identically named insight be attached or overwritten.
  const insights = (await catalog(`${root}/insights/?limit=100`)).filter(insight =>
    Array.isArray(insight.dashboards) && insight.dashboards.includes(dashboard.id));
  const insightIds: number[] = [];
  for (const view of views) {
    const existing = insights.filter(insight => insight.name === view.name);
    const exclusive = existing.filter(insight => insight.dashboards.length === 1);
    if (exclusive.length > 1 || (exclusive[0] && !exclusive[0].tags?.includes(CLOUD_MONITORING_DASHBOARD_TAG))) throw new Error('posthog_insight_name_conflict');
    const body = { name: view.name, saved: true, dashboards: [dashboard.id], tags: [CLOUD_MONITORING_DASHBOARD_TAG, environment],
      query: { kind: 'DataTableNode', source: { kind: 'HogQLQuery', query: view.query } } };
    const insight = await request(exclusive[0] ? `${root}/insights/${exclusive[0].id}/` : `${root}/insights/`, body, exclusive[0] ? 'PATCH' : 'POST');
    if (!Number.isSafeInteger(insight.id) || insight.id < 1) throw new Error('posthog_insight_identity_unavailable');
    const stored = await request(`${root}/insights/${insight.id}/`);
    if (stored.query?.source?.query !== view.query || !Array.isArray(stored.dashboards) ||
        stored.dashboards.length !== 1 || stored.dashboards[0] !== dashboard.id) throw new Error('posthog_insight_readback_mismatch');
    insightIds.push(insight.id);
  }
  // Re-resolve the page's backing object before reporting a delivery link.
  const readback = await request(`${root}/dashboards/${dashboard.id}/`);
  if (readback.id !== dashboard.id || readback.name !== name) throw new Error('posthog_dashboard_readback_mismatch');
  return { projectId, dashboardId: dashboard.id as number, insightIds,
    url: `${origin}/project/${projectId}/dashboard/${dashboard.id}` };
}

