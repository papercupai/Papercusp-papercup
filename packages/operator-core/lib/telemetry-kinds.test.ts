import { describe, it, expect } from 'vitest';
import { TELEMETRY_KINDS, isTelemetryKind, cloudTelemetryEventSchema, cloudDiagnosticAggregateSchema } from './telemetry-kinds';

describe('telemetry-kinds', () => {
  it('exposes every kind via TELEMETRY_KINDS', () => {
    expect(Object.keys(TELEMETRY_KINDS).length).toBeGreaterThanOrEqual(8);
    expect(TELEMETRY_KINDS.crash).toBe('crash');
    expect(TELEMETRY_KINDS.startup_failed).toBe('startup_failed');
    expect(TELEMETRY_KINDS.setup_step).toBe('setup_step');
  });

  it('isTelemetryKind narrows to known values', () => {
    expect(isTelemetryKind('crash')).toBe(true);
    expect(isTelemetryKind('migration_failed')).toBe(true);
    expect(isTelemetryKind('unknown_kind')).toBe(false);
    expect(isTelemetryKind('')).toBe(false);
  });

  it('values match their keys (one-to-one)', () => {
    for (const [k, v] of Object.entries(TELEMETRY_KINDS)) {
      expect(v).toBe(k);
    }
  });

  it('includes the substrate admission-rejection kind (P-004)', () => {
    expect(TELEMETRY_KINDS.substrate_admission_rejected).toBe('substrate_admission_rejected');
    expect(isTelemetryKind('substrate_admission_rejected')).toBe(true);
  });
});

describe('closed cloud telemetry contract', () => {
  const event = { event: 'cloud_portal_session', operation_id: '00000000-0000-4000-8000-000000000001', properties: { action: 'signed_in' } };
  it('accepts the disclosed portal metadata', () => {
    expect(cloudTelemetryEventSchema.safeParse(event).success).toBe(true);
  });
  it('allows only fixed public product-guide metadata, without task-success claims', () => {
    const guide = { ...event, event: 'product_tutorial', properties: {
      lesson_id: 'product-guide', lesson_version: 3, action: 'lesson_displayed', lesson: 'welcome' } };
    expect(cloudTelemetryEventSchema.safeParse(guide).success).toBe(true);
    for (const properties of [{ ...guide.properties, lesson: 'private-task-title' },
      { ...guide.properties, action: 'task_succeeded' }, { ...guide.properties, prompt: 'secret' }]) {
      expect(cloudTelemetryEventSchema.safeParse({ ...guide, properties }).success).toBe(false);
    }
  });
  it.each(['prompt', 'code', 'terminal', 'input_tokens', 'accountId', 'rlResetAt', 'stack', 'url', 'organization_id', 'userId', 'environment', 'release', '__proto__'])('rejects the undisclosed property %s', key => {
    const properties = JSON.parse(JSON.stringify({ action: 'signed_in', [key]: 'private-value' }));
    expect(cloudTelemetryEventSchema.safeParse({ ...event, properties }).success).toBe(false);
  });
  it('rejects identity injection, nested content, arbitrary events and malformed operation ids', () => {
    for (const hostile of [{ ...event, userId: 'other-tenant' }, { ...event, properties: { action: { prompt: 'private' } } },
      { ...event, event: '$autocapture' }, { ...event, operation_id: 'private prompt' }]) {
      expect(cloudTelemetryEventSchema.safeParse(hostile).success).toBe(false);
    }
  });
  it('accepts exactly the aggregate fields and rejects per-call/provider-account data', () => {
    const aggregate = { period_start: '2026-10-13T12:00:00Z', period_end: '2026-10-13T13:00:00Z', calls: 1,
      input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0,
      provider_cost_usd: null, estimated_cost_usd: 0.01, unpriced_calls: 0 };
    expect(cloudDiagnosticAggregateSchema.safeParse(aggregate).success).toBe(true);
    for (const key of ['account_id', 'run_id', 'rl_requests_limit', 'rlResetAt', 'anthropic-ratelimit-tokens-remaining', 'prompt']) {
      expect(cloudDiagnosticAggregateSchema.safeParse({ ...aggregate, [key]: 'private' }).success).toBe(false);
    }
    expect(cloudDiagnosticAggregateSchema.safeParse({ ...aggregate, period_end: '2026-10-13T11:00:00Z' }).success).toBe(false);
    expect(cloudDiagnosticAggregateSchema.safeParse({ ...aggregate, input_tokens: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});
