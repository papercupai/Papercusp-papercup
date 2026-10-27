import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHostedPrincipal } from './auth/hosted-principal';
import { readCloudProductUsage } from './cloud-telemetry-posthog';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from './telemetry-kinds';
import { getPosthogConfigWithSource } from './posthog-config';

/** Read-only compatibility check against the configured capture project. The
 * fresh fixture identity has no customer or captured events. Nothing is sent
 * to capture and no dashboard/insight is created. This proves the real query
 * contract, not a live lead binding, consent grant or usage measurement. */
describe.runIf(process.env.PAPERCUSP_TEST_POSTHOG_LIVE === 'true')('P019 configured PostHog usage query', () => {
  it('executes the maintained opaque-identity query and preserves an empty result as unknown', async () => {
    const configured = getPosthogConfigWithSource();
    expect(configured.config?.personalApiKey, `configured PostHog credential required (source=${configured.source})`).toBeTruthy();
    const end = Date.now();
    const principal = createHostedPrincipal({ workspaceId: 'read-only-usage-query-fixture',
      userId: randomUUID(), activeOrganizationId: randomUUID(), sessionId: randomUUID(), sessionVersion: 1, permissions: [] });
    const consent = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT,
      analytics: { enabled: true, since: new Date(end - 2 * 60 * 60_000).toISOString() } };
    const result = await readCloudProductUsage({ context: { principal, environment: 'staging' },
      windowStart: new Date(end - 60 * 60_000).toISOString(), windowEnd: new Date(end).toISOString(),
      readConsent: async () => consent,
      onUnavailable: failure => console.info('CLOUD_PRODUCT_USAGE_UNAVAILABLE', JSON.stringify(failure)) });
    expect(result).toEqual({ status: 'unknown', reason: 'no_observations' });
  }, 60_000);
});
