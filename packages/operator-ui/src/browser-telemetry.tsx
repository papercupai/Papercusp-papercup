'use client';

// Shared implementation of the operator's existing browser consent boundary.
// An unavailable host endpoint drops events; it never implies consent.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { pinModuleState } from '@papercusp/module-singleton';
import { useOperatorWorkspaceLocation, type OperatorWorkspaceLocation } from './seam';
import { cloudErrorFingerprintInput, cloudTelemetryEventSchema, cloudTelemetryConsentSchema, CLOUD_MONITORING_DISCLOSURE_VERSION, type CloudErrorCode, type CloudTelemetryConsent, type CloudTelemetryEvent } from '@papercusp/operator-core/lib/telemetry-kinds';

export type CloudFeature = Extract<CloudTelemetryEvent, { event: 'cloud_feature_adoption' }>['properties']['feature'];

interface TelemetryConfig {
  enabled: boolean;
  host?: string;
  project_key?: string;
  distinct_id?: string;
  workspace_id?: string;
}
type Client = typeof import('posthog-js').default;
const state = pinModuleState('@papercusp/operator-ui.browser-telemetry', () => ({
  client: null as Client | null,
  initializing: null as Promise<Client> | null,
}));

async function consentedClient(cancelled: () => boolean = () => false) {
  const response = await fetch('/api/desktop/telemetry-config', { cache: 'no-store' });
  if (!response.ok) return null;
  const config = await response.json() as TelemetryConfig;
  if (cancelled() || config.enabled !== true || !config.host || !config.project_key) return null;
  if (state.client) return state.client;
  state.initializing ??= import('posthog-js').then(module => {
    const client = module.default;
    client.init(config.project_key!, {
      api_host: config.host, person_profiles: 'identified_only',
      capture_pageview: false, capture_pageleave: false, autocapture: false,
      disable_session_recording: true,
      loaded: value => value.identify(config.distinct_id ?? config.workspace_id ?? 'default'),
    });
    state.client = client;
    return client;
  }).finally(() => { state.initializing = null; });
  return state.initializing;
}

/** Recheck consent for every explicit event. No queue, opt-in or replay change. */
export async function captureBrowserTelemetry(event: string, properties: Record<string, string | number | boolean>, location: OperatorWorkspaceLocation = 'local'): Promise<void> {
  if (location === 'cloud') {
    // Hosted capture is an explicit authenticated request. It never loads the
    // vendor SDK, accepts arbitrary properties, or infers desktop consent.
    if (event === 'cloud_tutorial' && (properties.action === 'complete' ||
      ['agent', 'task', 'result', 'revision', 'practice'].includes(String(properties.step)))) return;
    if (event === 'product_tutorial' && properties.action === 'explanation_reviewed') return;
    const parsed = cloudTelemetryEventSchema.safeParse({ event, operation_id: crypto.randomUUID(), properties });
    if (!parsed.success || ['cloud_workspace_provisioning', 'cloud_diagnostic_aggregate'].includes(parsed.data.event)) return;
    try {
      await fetch('/api/hosted/browser/monitoring/event', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed.data), keepalive: true });
    } catch { /* Optional analytics cannot interrupt the product. */ }
    return;
  }
  try {
    const client = await consentedClient();
    client?.capture(event, properties);
  } catch { /* Optional diagnostics cannot interrupt the product. */ }
}

/** One return observation per mount of a hosted shell. The server witnesses
 * sign-in; a visit that reuses an existing session is only visible here. */
function useCloudPortalVisit(location: OperatorWorkspaceLocation) {
  const recorded = useRef(false);
  useEffect(() => {
    if (location !== 'cloud' || recorded.current) return;
    recorded.current = true;
    void captureBrowserTelemetry('cloud_portal_session', { action: 'returned' }, 'cloud');
  }, [location]);
}

/** Mount once, outside any keyed remount, in a host shell that does not use
 * PostHogProvider (the portal). Without a location prop it reads the seam. */
export function CloudPortalVisit({ location }: { location?: OperatorWorkspaceLocation }) {
  const contextLocation = useOperatorWorkspaceLocation();
  useCloudPortalVisit(location ?? contextLocation);
  return null;
}

/** Records that a hosted user opened one disclosed feature, once per mount.
 * Local mounts and inactive surfaces send nothing. */
export function useCloudFeatureAdoption(feature: CloudFeature, options: { location?: OperatorWorkspaceLocation; active?: boolean } = {}) {
  const contextLocation = useOperatorWorkspaceLocation();
  const location = options.location ?? contextLocation;
  const active = options.active ?? true;
  const recorded = useRef(false);
  useEffect(() => {
    if (location !== 'cloud' || !active || recorded.current) return;
    recorded.current = true;
    void captureBrowserTelemetry('cloud_feature_adoption', { feature }, 'cloud');
  }, [location, active, feature]);
}

/** Hosted error observation: only the reviewed code and a fingerprint of the
 * code/type pair leave the browser, never the message, stack or component. */
export async function reportCloudError(code: CloudErrorCode, error: unknown, location: OperatorWorkspaceLocation): Promise<void> {
  if (location !== 'cloud') return;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cloudErrorFingerprintInput(code, error)));
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    await captureBrowserTelemetry('cloud_error', { code, fingerprint }, 'cloud');
  } catch { /* Optional analytics cannot interrupt the product. */ }
}

export function PostHogProvider({ children }: { children: ReactNode }) {
  const workspaceLocation = useOperatorWorkspaceLocation();
  useCloudPortalVisit(workspaceLocation);
  useEffect(() => {
    if (workspaceLocation === 'cloud' || state.client) return;
    let cancelled = false;
    void consentedClient(() => cancelled).catch(() => {});
    return () => { cancelled = true; };
  }, [workspaceLocation]);
  return <>{children}</>;
}

/** Uses the canonical Settings page and authenticated hosted preference route.
 * Unavailable preferences remain unknown; never turn a failed read into opt-in. */
export function CloudMonitoringPreferences() {
  const location = useOperatorWorkspaceLocation();
  return location === 'cloud' ? <HostedMonitoringPreferences /> : null;
}

function HostedMonitoringPreferences() {
  const id = useId();
  const [consent, setConsent] = useState<CloudTelemetryConsent | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/hosted/browser/monitoring', { credentials: 'include', cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('unavailable');
        const data = await response.json();
        const parsed = cloudTelemetryConsentSchema.parse(data.consent);
        if (!cancelled) {
          setConsent(parsed);
          void captureBrowserTelemetry('cloud_feature_adoption', { feature: 'monitoring' }, 'cloud');
        }
      }).catch(() => { if (!cancelled) setError('Monitoring choices are unavailable. No choice has been changed.'); });
    return () => { cancelled = true; };
  }, []);
  const update = async (category: 'analytics' | 'diagnostics', enabled: boolean) => {
    setSaving(true); setError(null);
    try {
      const response = await fetch('/api/hosted/browser/monitoring', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disclosure_version: CLOUD_MONITORING_DISCLOSURE_VERSION, [category]: enabled }) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 403 && data.error === 'diagnostic_export_admin_required') {
          setError('An organization owner or administrator must enable diagnostic export. Your last saved choice still applies.');
          return;
        }
        throw new Error('unavailable');
      }
      setConsent(cloudTelemetryConsentSchema.parse(data.consent));
    } catch { setError('The choice could not be saved. Your last saved choice still applies.'); }
    finally { setSaving(false); }
  };
  return <section aria-labelledby={id}>
    <h2 id={id}>Cloud monitoring and privacy</h2>
    <p>Both choices start off. Papercusp collects only the metadata described here when you enable them.</p>
    <label><input type="checkbox" checked={consent?.analytics.enabled ?? false} disabled={!consent || saving}
      onChange={event => { void update('analytics', event.target.checked); }} /> Share portal analytics</label>
    <p>Sign-in and return visits, setup and public guide steps, saved explanation reviews, feature choices, confirmed provisioning status, and safe error codes.
      Identity is pseudonymous and separated by organization and environment.</p>
    <label><input type="checkbox" checked={consent?.diagnostics.enabled ?? false} disabled={!consent || saving}
      onChange={event => { void update('diagnostics', event.target.checked); }} /> Allow aggregate diagnostic export</label>
    <p>Only counts of calls, input/output/cache tokens, and reported or estimated model cost for a selected time window.
      An organization owner or administrator must enable this choice. You can turn off your own choice.
      Customer prompts, code, documents, terminal output, private tasks and logs, provider account details, host metrics and cloud bills stay local.</p>
    <p>Destination: Papercusp’s PostHog at flags.papercuspai.com, for product reliability and adoption.
      Its current project has no enforced event-deletion limit. Turning a choice off stops future delivery; it does not delete previously delivered events.
      Re-enabling starts a new consent window and does not backfill older activity.</p>
    {!consent && !error && <p role="status">Loading monitoring choices…</p>}
    {saving && <p role="status">Saving choice…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
