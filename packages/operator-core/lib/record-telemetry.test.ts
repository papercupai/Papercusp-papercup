import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for operator-state PG (same pattern as
// the old operator-idle-snapshot tests): the helper's only side effect is the
// telemetry_reports ring buffer, so we capture it without touching PG.
const store = new Map<string, unknown>();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async (table: string) => store.get(table) ?? null,
  writeOperatorState: async (table: string, payload: unknown) => {
    store.set(table, payload);
  },
}));

import { recordTelemetryReport, MAX_TELEMETRY_REPORTS, prepareCloudTelemetryDelivery, deliverCloudTelemetry, safeCloudError, cloudProvisioningObservation, cloudProductTutorialReviewEvents, type CloudTelemetryContext } from './record-telemetry';
import type { AccountTutorialProgressRecord } from './onboarding/cloud-tutorial-progress';
import { createHostedPrincipal } from './auth/hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT, type CloudTelemetryConsent } from './telemetry-kinds';

beforeEach(() => store.clear());

describe('control-plane provisioning witness', () => {
  const row = { kind: 'workspace', id: 'private-host', target: 'gcp', name: 'private-name', observedState: 'running',
    operation: { id: '00000000-0000-4000-8000-000000000001', action: 'provision', status: 'succeeded',
      startedAt: '2026-10-14T08:00:00Z', finishedAt: '2026-10-14T08:01:00Z', request: { prompt: 'secret' }, error: { message: 'secret' } } };
  it('requires persisted active bring-up and terminal provision success; exports only bounded metadata', () => {
    const observation = cloudProvisioningObservation(row, 'active');
    expect(observation).toMatchObject({ observedAt: row.operation.finishedAt, event: { event: 'cloud_workspace_provisioning',
      operation_id: row.operation.id, properties: { phase: 'ready', provider: 'gcp', hosting_mode: 'unknown', duration_ms: 60_000 } } });
    expect(JSON.stringify(observation)).not.toMatch(/private|secret|prompt|request|message/);
    for (const state of ['provisioning', 'failed', null]) expect(cloudProvisioningObservation(row, state)).toBeNull();
    expect(cloudProvisioningObservation({ ...row, observedState: 'degraded' }, 'active')).toBeNull();
    expect(cloudProvisioningObservation({ ...row, operation: { ...row.operation, action: 'restart' } }, 'active')).toBeNull();
    expect(cloudProvisioningObservation({ ...row, operation: { ...row.operation, id: 'unverified-id' } }, 'active')).toBeNull();
  });
  it('records persisted attempts and terminal failures without fabricating readiness or free-form failure content', () => {
    expect(cloudProvisioningObservation({ ...row, operation: { ...row.operation, status: 'queued', finishedAt: undefined } }, 'provisioning'))
      .toMatchObject({ observedAt: row.operation.startedAt, event: { properties: { phase: 'requested' } } });
    expect(cloudProvisioningObservation({ ...row, operation: { ...row.operation, status: 'failed' } }, 'failed'))
      .toMatchObject({ event: { properties: { phase: 'failed' } } });
    expect(cloudProvisioningObservation({ ...row, operation: { ...row.operation, status: 'failed' } }, 'failed')?.event.properties)
      .not.toHaveProperty('failure_code');
    expect(cloudProvisioningObservation({ ...row, operation: { ...row.operation, finishedAt: undefined } }, 'active')).toBeNull();
  });
});

describe('recordTelemetryReport', () => {
  it('enqueues a report newest-first into the telemetry_reports ring and returns it', async () => {
    const a = await recordTelemetryReport({ kind: 'test', payload: { n: 1 }, receivedAt: '2026-01-01T00:00:00Z' });
    const b = await recordTelemetryReport({
      kind: 'substrate_admission_rejected',
      payload: { harness_slug: 'h', reason: 'bad_sig' },
      receivedAt: '2026-01-01T00:00:01Z',
    });

    expect(a.kind).toBe('test');
    expect(b).toMatchObject({ kind: 'substrate_admission_rejected', received_at: '2026-01-01T00:00:01Z' });

    const state = store.get('telemetry_reports') as { reports: Array<{ kind: string }> };
    // Newest first.
    expect(state.reports.map((r) => r.kind)).toEqual(['substrate_admission_rejected', 'test']);
  });

  it('caps the ring at MAX_TELEMETRY_REPORTS (drops the oldest)', async () => {
    const seeded = Array.from({ length: MAX_TELEMETRY_REPORTS }, (_, i) => ({
      received_at: `t${i}`,
      kind: 'test',
      payload: { i },
    }));
    store.set('telemetry_reports', { reports: seeded });

    await recordTelemetryReport({ kind: 'crash', payload: {}, receivedAt: 'newest' });

    const state = store.get('telemetry_reports') as { reports: Array<{ kind: string; received_at: string }> };
    expect(state.reports).toHaveLength(MAX_TELEMETRY_REPORTS);
    expect(state.reports[0]).toMatchObject({ kind: 'crash', received_at: 'newest' }); // newest kept at head
    expect(state.reports.some((r) => r.received_at === `t${MAX_TELEMETRY_REPORTS - 1}`)).toBe(false); // oldest dropped
  });

  it('defaults missing payload to null', async () => {
    const r = await recordTelemetryReport({ kind: 'test', payload: undefined });
    expect(r.payload).toBeNull();
  });
});

describe('cloud final-delivery privacy boundary', () => {
  const event = { event: 'cloud_portal_session', operation_id: '00000000-0000-4000-8000-000000000001', properties: { action: 'signed_in' } };
  const principal = createHostedPrincipal({ workspaceId: 'control', userId: 'user-a', activeOrganizationId: 'tenant-a',
    selectedWorkspaceId: 'customer-a', sessionId: 'session-a', sessionVersion: 1, permissions: ['workspace:view', 'members:manage'] });
  const context: CloudTelemetryContext = { principal, environment: 'staging', release: 'abcdef1234567', origin: 'portal', hostingMode: 'byoc', observedAt: '2026-10-13T13:00:00Z' };
  const consent = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT, analytics: { enabled: true, since: '2026-10-13T12:00:00Z' } };
  const aggregate = { event: 'cloud_diagnostic_aggregate', operation_id: event.operation_id,
    properties: { period_start: '2026-10-13T12:00:00Z', period_end: '2026-10-13T13:00:00Z', calls: 1,
      input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0,
      provider_cost_usd: null, estimated_cost_usd: 0.01, unpriced_calls: 0 } };

  it('refuses diagnostic aggregates from a non-administrator even with a previously enabled consent', () => {
    const current = { ...consent, diagnostics: { enabled: true, since: '2026-10-13T12:00:00Z' } };
    const member = createHostedPrincipal({ ...principal, permissions: ['workspace:view', 'workspace:operate'] });
    expect(prepareCloudTelemetryDelivery(aggregate, { ...context, origin: 'customer-runtime' }, current).ok).toBe(true);
    expect(prepareCloudTelemetryDelivery(aggregate, { ...context, origin: 'customer-runtime', principal: member }, current))
      .toEqual({ ok: false, code: 'unverified_principal' });
  });

  it('witnesses only newly committed public explanation reviews and never backfills or exports tutorial scope', () => {
    const previous: AccountTutorialProgressRecord = { scope: { tenantId: 'tenant-a', userId: 'user-a' }, version: 3,
      revision: 4, mutationId: 'old', disposition: 'active', currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] };
    const next = { ...previous, revision: 5, mutationId: 'private-mutation', reviewedLessonIds: ['welcome', 'navigation', 'workspace'] };
    const reviews = cloudProductTutorialReviewEvents(previous, next);
    expect(reviews.map(review => review.properties)).toEqual(['navigation', 'workspace'].map(lesson => ({
      lesson_id: 'product-guide', lesson_version: 3, action: 'explanation_reviewed', lesson })));
    expect(cloudProductTutorialReviewEvents(previous, next)).toEqual(reviews);
    expect(cloudProductTutorialReviewEvents(next, next)).toEqual([]);
    expect(cloudProductTutorialReviewEvents(null, next)).toEqual([]);
    expect(cloudProductTutorialReviewEvents(previous, { ...next, scope: { ...next.scope, tenantId: 'other' } })).toEqual([]);
    expect(JSON.stringify(reviews)).not.toMatch(/tenant-a|user-a|private-mutation|task_succeeded/);
    expect(prepareCloudTelemetryDelivery(reviews[0], context, consent)).toEqual({ ok: false, code: 'unwitnessed_outcome' });
    expect(prepareCloudTelemetryDelivery(reviews[0], { ...context, origin: 'control-plane' }, consent).ok).toBe(true);
  });

  it('derives stable opaque user/tenant identities across sessions and separates tenants/environments', () => {
    const a = prepareCloudTelemetryDelivery(event, context, consent);
    const replay = prepareCloudTelemetryDelivery(event, { ...context, principal: { ...principal, sessionId: 'session-b' } }, consent);
    const b = prepareCloudTelemetryDelivery(event, { ...context, principal: { ...principal, activeOrganizationId: 'tenant-b' } }, consent);
    const prod = prepareCloudTelemetryDelivery(event, { ...context, environment: 'production' }, consent);
    expect(a.ok && replay.ok && b.ok && prod.ok).toBe(true);
    if (!a.ok || !replay.ok || !b.ok || !prod.ok) throw new Error('positive control failed');
    expect(a.envelope.distinct_id).toBe(replay.envelope.distinct_id);
    expect(a.envelope.distinct_id).not.toBe(b.envelope.distinct_id);
    expect(a.envelope.distinct_id).not.toBe(prod.envelope.distinct_id);
    expect(JSON.stringify(a.envelope)).not.toMatch(/user-a|tenant-a|session-a|customer-a/);
    expect(a.envelope.properties.operation_id).not.toBe(event.operation_id);
    expect(a.envelope.properties.operation_id).toBe(replay.envelope.properties.operation_id);
    expect(a.envelope.properties.operation_id).not.toBe(b.envelope.properties.operation_id);
    expect(a.envelope.properties).toMatchObject({ release: context.release, environment: 'staging', synthetic: false });
  });

  it('rejects spoofed identity and hostile payloads with zero delivery calls beside a working positive control', async () => {
    const send = vi.fn(async () => {});
    const readConsent = async () => consent;
    expect(await deliverCloudTelemetry(event, context, { readConsent, send })).toEqual({ delivered: true });
    send.mockClear();
    for (const input of [{ ...event, organization_id: 'tenant-b' }, { ...event, properties: { ...event.properties, prompt: 'secret' } },
      { ...event, properties: { ...event.properties, stack: 'secret', url: 'https://private' } }]) {
      expect(await deliverCloudTelemetry(input, context, { readConsent, send })).toMatchObject({ delivered: false, code: 'invalid_cloud_event' });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps customer-runtime data local by default, including with portal analytics consent', async () => {
    const send = vi.fn(async () => {});
    const local = { ...context, origin: 'customer-runtime' as const };
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent: async () => consent, send })).toMatchObject({ delivered: false, code: 'consent_disabled' });
    expect(await deliverCloudTelemetry(event, local, { readConsent: async () => consent, send })).toMatchObject({ delivered: false, code: 'customer_data_local' });
    expect(send).not.toHaveBeenCalled();
  });

  it('checks current consent for a queued export and never catches up across consent epochs', async () => {
    const send = vi.fn(async () => {});
    const local = { ...context, origin: 'customer-runtime' as const };
    let current: CloudTelemetryConsent = { ...consent, diagnostics: { enabled: true, since: '2026-10-13T12:00:00Z' } };
    const readConsent = vi.fn(async () => current);
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toEqual({ delivered: true });
    current = { ...current, diagnostics: { enabled: false, since: null } };
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toMatchObject({ delivered: false, code: 'consent_disabled' });
    current = { ...current, diagnostics: { enabled: true, since: '2026-10-13T12:30:00Z' } };
    expect(await deliverCloudTelemetry(aggregate, local, { readConsent, send })).toMatchObject({ delivered: false, code: 'outside_consent_epoch' });
    expect(readConsent).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not count browser intent as confirmed readiness or export BYOC task progress', () => {
    expect(prepareCloudTelemetryDelivery({ event: 'cloud_workspace_provisioning', operation_id: event.operation_id,
      properties: { phase: 'ready', provider: 'gcp', hosting_mode: 'byoc' } }, context, consent)).toMatchObject({ ok: false, code: 'unwitnessed_outcome' });
    expect(prepareCloudTelemetryDelivery({ event: 'cloud_tutorial', operation_id: event.operation_id,
      properties: { lesson_id: 'first-cloud-agent', lesson_version: 1, action: 'step_confirmed', step: 'task' } }, context, consent)).toMatchObject({ ok: false, code: 'customer_data_local' });
  });

  it('drops unavailable consent and sink errors without rejecting product work', async () => {
    const send = vi.fn(async () => { throw new Error('sink down'); });
    expect(await deliverCloudTelemetry(event, context, { readConsent: async () => null, send })).toMatchObject({ delivered: false, code: 'consent_unavailable' });
    expect(send).not.toHaveBeenCalled();
    expect(await deliverCloudTelemetry(event, context, { readConsent: async () => consent, send })).toMatchObject({ delivered: false, code: 'delivery_unavailable' });
  });

  it('rejects an unverified local principal before any cloud send', async () => {
    const send = vi.fn(async () => {});
    const forged = { ...principal, profile: 'local' } as unknown as CloudTelemetryContext['principal'];
    expect(await deliverCloudTelemetry(event, { ...context, principal: forged }, { readConsent: async () => consent, send }))
      .toMatchObject({ delivered: false, code: 'unverified_principal' });
    expect(send).not.toHaveBeenCalled();
  });

  it('reduces errors to reviewed code/type fingerprints, excluding content', () => {
    const error = new TypeError('secret prompt at https://private');
    error.stack = 'secret source code';
    const safe = safeCloudError('render_failure', error);
    expect(safe).toEqual(safeCloudError('render_failure', new TypeError('different private content')));
    expect(JSON.stringify(safe)).not.toMatch(/secret|private|https|source code/);
    expect(Object.keys(safe).sort()).toEqual(['code', 'fingerprint']);
  });
});
