import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- mirror the production postgres-js JSON binder
import { restoreRawJsonbSerializer } from '../../../../libs/papercusp/libs/db/src/raw-serializers';

const fixture = vi.hoisted(() => ({ sql: null as postgres.Sql | null, consentSince: 0 }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fixture.sql! }) }));
vi.mock('../serving-host-identity', () => ({ getServingHostIdentity: () => ({
  host: 'port-3070', processId: 'release-test-process', buildSha: 'a'.repeat(40),
}) }));
const paths = [
  'packages/operator-core/lib/observability/runtime.ts',
  'packages/operator-core/lib/observability/tracing.ts',
  'packages/operator-core/lib/observability/posthog-exporter.ts',
  'packages/operator-core/lib/projected-tool-deps.ts',
  'packages/operator-core/lib/inference-gateway/gateway.ts',
  'apps/operator/bin/host-bootstrap.ts',
];
vi.mock('./runtime', () => ({ runtimeTraceDeliveryConfig: async () => ({ allowed: true, consentSince: fixture.consentSince }),
  runtimeObservabilityHealth: () => ({
  initialized: true, globalProviderRegistered: true,
  artifact: { status: 'measured', sourceSha: 'a'.repeat(40), bundleSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64), sourceBlobs: Object.fromEntries(paths.map(path => [path, 'd'.repeat(40)])) },
}) }));
vi.mock('../git-pipeline-position', () => ({ gitPipelinePosition: async () => ({
  servingRuntimes: [{ runtime: 'release-operator', containsChange: true, buildSha: 'a'.repeat(40) }],
}) }));
vi.mock('./project-readback', () => ({ readConfiguredTraceProject: vi.fn() }));
import { measureOperationalObservability } from './operational-check';
import { readConfiguredTraceProject, type ObservedProjectEvent } from './project-readback';

describe('release writer population with real PostgreSQL null semantics', () => {
  let db: FreshPgDb;
  const scope = { workspaceId: 'release-writer-test', harnessSlug: 'release-test' };
  const valid = () => ({ sourceSha: 'a'.repeat(40), bundleSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64), sourceBlobs: Object.fromEntries(paths.map(path => [path, 'd'.repeat(40)])) });
  beforeAll(async () => {
    db = await createFreshPgDb('otel-writer-population');
    restoreRawJsonbSerializer(db.sql);
    fixture.sql = db.sql;
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.audit_log (id text PRIMARY KEY, workspace_id text, action text, details jsonb);
      CREATE TABLE harness_shared.pipeline_events (id bigserial PRIMARY KEY, workspace_id text,
        install_slug text, kind text, detail jsonb, created_at timestamptz DEFAULT now());
      CREATE TABLE harness_shared.tool_invocations (id bigserial, metadata_json jsonb, status text,
        invoked_at timestamptz, duration_ms integer, workspace_id text, harness_slug text,
        serving_process_id text, serving_build_sha text);
    `);
    await db.sql`INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, detail)
      VALUES (${scope.workspaceId}, ${scope.harnessSlug}, 'green_checkpoint',
        ${JSON.stringify({ candidate: 'a'.repeat(40), green: true, runId: 'green-test-run' })}::jsonb)`;
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    fixture.consentSince = 0;
    await db.sql`DELETE FROM harness_shared.audit_log`;
    await db.sql`DELETE FROM harness_shared.tool_invocations`;
    await db.sql`INSERT INTO harness_shared.audit_log VALUES
      ('valid', ${scope.workspaceId}, 'release.artifact.built', ${JSON.stringify(valid())}::jsonb)`;
  });

  it.each([
    { kind: '$ai_generation', oldStatus: 'ok', oldExpectedModel: true },
    { kind: '$exception', oldStatus: 'error', oldExpectedModel: false },
    { kind: '$ai_generation', oldStatus: 'error', oldExpectedModel: true },
  ] as const)('retains expired $kind expectations for $oldStatus tools in actual SQL ahead of healthy new rows', async ({ kind, oldStatus, oldExpectedModel }) => {
    const now = Date.now();
    const events: ObservedProjectEvent[] = [];
    for (const [digit, age, status, expectedModel] of [
      ['1', 300_000, oldStatus, oldExpectedModel],
      ['2', 100, 'ok', true], ['3', 100, 'error', false], ['4', 300_000, 'ok', false],
    ] as const) {
      const startedAt = now - age - 1000;
      await db.sql`INSERT INTO harness_shared.tool_invocations
        (metadata_json, status, invoked_at, duration_ms, workspace_id, harness_slug, serving_process_id, serving_build_sha)
        VALUES (${JSON.stringify({ otel: { callId: 'call-' + digit, traceId: digit.repeat(32),
          spanId: digit.repeat(16), expectedModel,
          expectedModelRequestIds: expectedModel ? ['11111111-1111-4111-8111-111111111111:' + digit] : [] } })}::jsonb, ${status}, ${new Date(now - age)}, 1000,
          ${scope.workspaceId}, ${scope.harnessSlug}, 'release-test-process', ${'a'.repeat(40)})`;
      const common = { traceId: digit.repeat(32), timestamp: startedAt, isError: false, httpClient: false };
      const http = String(Number(digit) + 3).repeat(16);
      events.push({ ...common, uuid: 'tool-' + digit, event: '$ai_trace', spanId: digit.repeat(16),
        parentSpanId: null, callId: 'call-' + digit, spanName: 'papercusp.tool' },
      { ...common, uuid: 'http-' + digit, event: '$ai_span', spanId: http,
        parentSpanId: digit.repeat(16), callId: 'call-' + digit, httpClient: true, spanName: 'papercusp.http' });
      if (digit === '2' || digit === '3') events.push({ ...common, uuid: 'leaf-' + digit,
        event: status === 'ok' ? '$ai_generation' : '$exception', isError: status !== 'ok',
        spanId: String(Number(digit) + 6).repeat(16), parentSpanId: http, callId: null, spanName: 'papercusp.model',
        requestId: '11111111-1111-4111-8111-111111111111:' + digit });
    }
    const mixed = oldStatus === 'error' && oldExpectedModel;
    if (mixed) events.push({ uuid: 'tool-error-1', event: '$exception', traceId: '1'.repeat(32),
      spanId: '1'.repeat(16), parentSpanId: null, callId: 'call-1', timestamp: now - 300_000,
      isError: true, httpClient: false, spanName: 'papercusp.tool' });
    vi.mocked(readConfiguredTraceProject).mockResolvedValue({ status: 'available', queriedAt: now,
      projectId: '7', evidenceRef: 'authenticated-exact-id-query', events });
    expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'fail',
      detail: expect.stringContaining('Expected ' + kind + ' absent after ingestion bound') });
    // The SQL exposes bigint IDs as text; crossing a decimal-width boundary
    // may change query order. Prove the exact population without ordering it.
    const queriedTraceIds = vi.mocked(readConfiguredTraceProject).mock.lastCall?.[0];
    expect(queriedTraceIds).toHaveLength(3);
    expect(queriedTraceIds).toEqual(expect.arrayContaining(['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]));
    if (mixed) {
      events.push({ uuid: 'restored-generation-1', event: '$ai_generation', traceId: '1'.repeat(32),
        spanId: '7'.repeat(16), parentSpanId: '4'.repeat(16), callId: null, timestamp: now - 300_500,
        isError: false, httpClient: false, spanName: 'papercusp.model', requestId: '11111111-1111-4111-8111-111111111111:1' });
      expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'pass' });
      vi.mocked(readConfiguredTraceProject).mockResolvedValueOnce({ status: 'available', queriedAt: now,
        projectId: '7', evidenceRef: 'authenticated-exact-id-query',
        events: events.filter(event => event.uuid !== 'tool-error-1') });
      expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'fail',
        detail: expect.stringContaining('Expected $exception absent after ingestion bound') });
    }
    // Revocation/regrant excludes pre-consent expectations exactly as the
    // exporter excludes spans whose start predates the current consent epoch.
    fixture.consentSince = now - 2000;
    expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'pass' });
    expect(readConfiguredTraceProject).toHaveBeenLastCalledWith(['2'.repeat(32), '3'.repeat(32)]);
    fixture.consentSince = 0;
    await db.sql`DELETE FROM harness_shared.tool_invocations WHERE metadata_json->'otel'->>'callId' = 'call-1'`;
    expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'pass' });
    if (mixed) {
      const firstId = '11111111-1111-4111-8111-111111111111:2';
      const secondId = '11111111-1111-4111-8111-111111111111:5';
      await db.sql`UPDATE harness_shared.tool_invocations SET metadata_json = jsonb_set(metadata_json,
        '{otel,expectedModelRequestIds}', ${JSON.stringify([firstId, secondId])}::jsonb)
        WHERE metadata_json->'otel'->>'callId' = 'call-2'`;
      const secondHttp: ObservedProjectEvent = { uuid: 'second-http-2', event: '$ai_span', traceId: '2'.repeat(32),
        spanId: 'a'.repeat(16), parentSpanId: '2'.repeat(16), callId: 'call-2', timestamp: now - 500,
        isError: false, httpClient: true, spanName: 'papercusp.http' };
      const secondModel: ObservedProjectEvent = { ...secondHttp, uuid: 'second-model-2', event: '$ai_generation',
        spanId: 'b'.repeat(16), parentSpanId: secondHttp.spanId, callId: null, httpClient: false,
        spanName: 'papercusp.model', requestId: secondId };
      events.push(secondHttp, secondModel);
      for (const missingId of [firstId, secondId]) {
        const incomplete = events.filter(event => event.event !== '$ai_generation' || event.requestId !== missingId);
        vi.mocked(readConfiguredTraceProject).mockResolvedValue({ status: 'available', queriedAt: now,
          projectId: '7', evidenceRef: 'authenticated-exact-id-query', events: incomplete });
        expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'unknown' });
        vi.mocked(readConfiguredTraceProject).mockResolvedValueOnce({ status: 'available', queriedAt: now + 120_000,
          projectId: '7', evidenceRef: 'authenticated-exact-id-query', events: incomplete });
        expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'fail',
          detail: expect.stringContaining('Expected $ai_generation absent after ingestion bound') });
      }
      vi.mocked(readConfiguredTraceProject).mockResolvedValue({ status: 'available', queriedAt: now,
        projectId: '7', evidenceRef: 'authenticated-exact-id-query', events });
      expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'pass' });
    }
  });

  const assertWriterAccepted = async () => {
    // No invocation is fabricated: reaching this next unknown proves only that
    // writer and green joins passed, never operational shipment.
    expect(await measureOperationalObservability('release', scope)).toEqual({
      verdict: 'unknown', detail: 'No fresh invocation identity with persisted call/trace/span metadata.',
    });
  };
  it('accepts identical repeated writer identities without claiming shipment', async () => {
    await db.sql`INSERT INTO harness_shared.audit_log VALUES
      ('repeat', ${scope.workspaceId}, 'release.artifact.built', ${JSON.stringify(valid())}::jsonb)`;
    await assertWriterAccepted();
  });
  it.each(['sourceSha', 'sourceBlobs', 'manifestSha256'] as const)(
    'rejects an incomplete %s receipt even beside a valid receipt', async field => {
      await assertWriterAccepted();
      const incomplete: Record<string, unknown> = valid();
      delete incomplete[field];
      await db.sql`INSERT INTO harness_shared.audit_log VALUES
        ('incomplete', ${scope.workspaceId}, 'release.artifact.built', ${JSON.stringify(incomplete)}::jsonb)`;
      expect(await measureOperationalObservability('release', scope)).toEqual({
        verdict: 'fail', detail: 'Release artifact writer and boot measurements differ.',
      });
      await db.sql`DELETE FROM harness_shared.audit_log WHERE id = 'incomplete'`;
      await assertWriterAccepted();
    },
  );
});
