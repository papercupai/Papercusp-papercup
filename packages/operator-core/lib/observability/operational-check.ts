/** Live evidence acquisition for rubric checks; fixture validators remain tree controls. */
import { getOrgPg } from '@papercusp/db-org';
import { getServingHostIdentity } from '../serving-host-identity';
import { gitPipelinePosition } from '../git-pipeline-position';
import { runtimeObservabilityHealth, runtimeTraceDeliveryConfig } from './runtime';
import { readConfiguredTraceProject, type ObservedProjectEvent } from './project-readback';
import { OBSERVABILITY_INSTRUMENT_KEYS } from './instrument-keys';
import { verifyObservabilityShipmentReceipt, type ObservabilityShipmentReceipt } from './shipment-receipt';
import { isModelRequestId, MAX_EXPECTED_MODEL_REQUESTS } from './tracing';
const COMPOSITION_PATHS = [
  'packages/operator-core/lib/observability/runtime.ts',
  'packages/operator-core/lib/observability/tracing.ts',
  'packages/operator-core/lib/observability/posthog-exporter.ts',
  'packages/operator-core/lib/projected-tool-deps.ts',
  'packages/operator-core/lib/inference-gateway/gateway.ts',
  'apps/operator/bin/host-bootstrap.ts',
];
interface InvocationObservation {
  id: string; callId: string; traceId: string; spanId: string;
  status: string; startedAt: number; endedAt: number; expectedModel: boolean;
  expectedModelRequestIds?: unknown; modelExpectationsIncomplete?: boolean;
}
function expectedEvents(row: InvocationObservation): Array<{ event: '$ai_generation' | '$exception'; requestId?: string }> {
  // A successful model response and the enclosing tool's final error are
  // independent writer observations. A later tool error cannot erase delivery
  // obligations for the model response it already consumed.
  const events: Array<{ event: '$ai_generation' | '$exception'; requestId?: string }> = [];
  if (row.expectedModel) for (const requestId of row.expectedModelRequestIds as string[]) events.push({ event: '$ai_generation', requestId });
  if (row.status !== 'ok') events.push({ event: '$exception' });
  return events;
}
type Verdict = { verdict: 'pass' | 'fail' | 'unknown'; detail: string };

/** The input scopes a query; it cannot supply observations, identities or a pass.
 * Run on the named operator plane. Release evidence additionally joins its
 * boot-measured bytes to the build writer and exact green candidate. No consent
 * changes or synthetic capture happen in this read. */
export async function measureOperationalObservability(
  mode: keyof typeof OBSERVABILITY_INSTRUMENT_KEYS,
  scope: { workspaceId: string; harnessSlug?: string },
): Promise<Verdict> {
  const unknown = (reason: string): Verdict => ({ verdict: 'unknown', detail: reason });
  const fail = (reason: string): Verdict => ({ verdict: 'fail', detail: reason });
  if (!scope.workspaceId || !scope.harnessSlug) return unknown('Concrete workspace and harness required.');
  try {
    const host = getServingHostIdentity();
    const release = mode === 'release';
    const runtimeId = release ? 'release-operator' : 'staging-operator';
    // Git's supported short/full identities, never arbitrary text prefixes.
    const validSha = (sha: string) => /^(?:[a-f0-9]{7,40}|[a-f0-9]{64})$/.test(sha);
    if (host.host !== (release ? 'port-3070' : 'port-3170') || !host.processId || !host.buildSha || !validSha(host.buildSha)) {
      return unknown('Required ' + runtimeId + ' process identity unavailable.');
    }
    const health = runtimeObservabilityHealth();
    if (!health.initialized || !health.globalProviderRegistered) return fail('Required operator process lacks the registered tracing provider.');
    // Inspect source/runtime containment, without acting on or grading the gate.
    for (const path of COMPOSITION_PATHS) {
      const position = await gitPipelinePosition({ path });
      const runtime = position.servingRuntimes.find(row => row.runtime === runtimeId);
      if (!runtime || runtime.containsChange === null || !runtime.buildSha || !validSha(runtime.buildSha)) return unknown('Source/runtime containment unreadable: ' + path);
      if (runtime.containsChange !== true || !(runtime.buildSha.startsWith(host.buildSha) || host.buildSha.startsWith(runtime.buildSha))) {
        return fail('Serving source/build mismatch: ' + path);
      }
    }
    const { sql } = getOrgPg();
    let releaseEvidence: Record<string, unknown> | undefined;
    let releaseReceipt: Pick<ObservabilityShipmentReceipt, 'accepted' | 'artifact' | 'green' | 'runtime'> | undefined;
    if (release) {
      const artifact = health.artifact;
      if (artifact?.status !== 'measured') return unknown('Boot-measured release artifact unavailable.');
      if (!artifact.sourceSha.startsWith(host.buildSha) || !/^[a-f0-9]{64}$/.test(artifact.bundleSha256) ||
        !/^[a-f0-9]{64}$/.test(artifact.manifestSha256) ||
        COMPOSITION_PATHS.some(path => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(artifact.sourceBlobs[path] ?? ''))) {
        return fail('Release artifact source identity or composition population differs.');
      }
      // Aggregate the full matching writer population, not a truncated page.
      // Equal repeated build receipts are harmless; conflicting identities fail.
      const writers = await sql<{ count: number; manifests: number; matches: boolean; ref: string }[]>`
        SELECT count(*)::int AS count,
          count(DISTINCT details->>'manifestSha256')::int AS manifests,
          bool_and(COALESCE(details->>'sourceSha' = ${artifact.sourceSha} AND
            details->'sourceBlobs' = ${JSON.stringify(artifact.sourceBlobs)}::jsonb, false)) AS matches,
          min(id) AS ref
        FROM harness_shared.audit_log
        WHERE workspace_id = ${scope.workspaceId} AND action = 'release.artifact.built'
          AND details->>'bundleSha256' = ${artifact.bundleSha256}`;
      const writer = writers[0];
      if (!writer || !writer.count) return unknown('Release artifact writer receipt unavailable.');
      // Count distinct hashes AND match the boot hash. A different immutable
      // manifest must not be blessed because it happens to describe one bundle.
      const hashes = await sql<{ matched: boolean }[]>`
        SELECT bool_and(COALESCE(details->>'manifestSha256' = ${artifact.manifestSha256}, false)) AS matched
        FROM harness_shared.audit_log
        WHERE workspace_id = ${scope.workspaceId} AND action = 'release.artifact.built'
          AND details->>'bundleSha256' = ${artifact.bundleSha256}`;
      if (writer.manifests !== 1 || writer.matches !== true || hashes[0]?.matched !== true || !writer.ref) {
        return fail('Release artifact writer and boot measurements differ.');
      }
      // detail.green is written by the verdict writer. Status labels such as
      // advanced-prefix cannot stand in for this exact candidate's outcome.
      const greens = await sql<{ id: string; detail: { candidate?: string; green?: boolean; runId?: string } }[]>`
        SELECT id::text AS id, detail FROM harness_shared.pipeline_events
        WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.harnessSlug}
          AND kind = 'green_checkpoint' AND detail->>'candidate' = ${artifact.sourceSha}
        ORDER BY created_at DESC, id DESC LIMIT 1`;
      const green = greens[0];
      if (!green || !green.detail.runId) return unknown('Exact release source green-verdict receipt unavailable.');
      if (green.detail.candidate !== artifact.sourceSha || green.detail.green !== true) {
        return fail('Exact release artifact source is not green.');
      }
      releaseEvidence = { sourceSha: artifact.sourceSha, bundleSha256: artifact.bundleSha256,
        manifestSha256: artifact.manifestSha256, writer: 'audit_log:' + writer.ref,
        green: 'pipeline_events:' + green.id, greenRunId: green.detail.runId };
      // The preceding per-path runtime probes bind these boot-measured blobs to
      // current source. The independent writer and green joins bind the bundle.
      const blobs = Object.fromEntries(COMPOSITION_PATHS.map(path => [path, artifact.sourceBlobs[path]!]));
      releaseReceipt = {
        accepted: { sourceSha: artifact.sourceSha, blobs },
        artifact: { sourceSha: artifact.sourceSha, digest: artifact.bundleSha256,
          containment: Object.entries(blobs).map(([path, blob]) => ({ path,
            containedInJudgedSha: true, stagingBlob: blob, judgedBlob: blob })) },
        green: { verdict: 'green', sourceSha: artifact.sourceSha, digest: artifact.bundleSha256,
          evidenceRef: 'pipeline_events:' + green.id },
        runtime: { plane: runtimeId, sourceSha: artifact.sourceSha, digest: artifact.bundleSha256,
          providerRegistered: health.globalProviderRegistered, loadedBlobs: blobs,
          evidenceRef: 'release-process:' + host.processId + ' audit_log:' + writer.ref },
      };
    }
    const capture = await runtimeTraceDeliveryConfig();
    if (!capture.allowed) return unknown('project-query-not-authorized');
    const consentSince = capture.consentSince ?? 0;
    if (!Number.isFinite(consentSince) || consentSince < 0) return unknown('Consent epoch unavailable.');
    // Select only identity/timing fields, never args, output, prompts or errors.
    const rows = await sql<InvocationObservation[]>`
      SELECT id::text AS id, metadata_json->'otel'->>'callId' AS "callId",
        metadata_json->'otel'->>'traceId' AS "traceId", metadata_json->'otel'->>'spanId' AS "spanId", status,
        metadata_json->'otel'->'expectedModel' = 'true'::jsonb AS "expectedModel",
        metadata_json->'otel'->'expectedModelRequestIds' AS "expectedModelRequestIds",
        metadata_json->'otel'->'modelExpectationsIncomplete' = 'true'::jsonb AS "modelExpectationsIncomplete",
        (extract(epoch FROM invoked_at) * 1000 - duration_ms)::float8 AS "startedAt",
        (extract(epoch FROM invoked_at) * 1000)::float8 AS "endedAt"
      FROM harness_shared.tool_invocations
      WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
        AND serving_process_id = ${host.processId} AND serving_build_sha = ${host.buildSha}
        AND metadata_json->'otel' IS NOT NULL
        AND (status <> 'ok' OR metadata_json->'otel'->'expectedModel' = 'true'::jsonb)
        AND (extract(epoch FROM invoked_at) * 1000 - duration_ms) > ${consentSince}
      ORDER BY id ASC LIMIT 257`;
    // The population comes from the invocation writer, before project readback.
    // Never evict an expired expectation to make room for a healthy new sample.
    // Bound work explicitly; overflow cannot produce a passing measurement.
    const overflow = rows.length > 256;
    const population = rows.slice(0, 256).filter(row => row.status !== 'ok' || row.expectedModel === true);
    const valid = population.filter(row => typeof row.callId === 'string' && row.callId.length > 0 &&
      /^[a-f0-9]{32}$/.test(row.traceId) && !/^0+$/.test(row.traceId) &&
      /^[a-f0-9]{16}$/.test(row.spanId) && !/^0+$/.test(row.spanId) &&
      Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt) && row.endedAt >= row.startedAt);
    if (!valid.length) return unknown('No fresh invocation identity with persisted call/trace/span metadata.');
    if (valid.length !== population.length) return unknown('Expected invocation identity is incomplete.');
    for (const row of valid) {
      const ids = row.expectedModelRequestIds;
      if (row.modelExpectationsIncomplete || row.expectedModel && (!Array.isArray(ids) || !ids.length ||
        ids.length > MAX_EXPECTED_MODEL_REQUESTS || ids.some(id => !isModelRequestId(id)) || new Set(ids).size !== ids.length)) {
        return unknown('Expected model request identities are incomplete or exceed the bound; invocation=' + row.id);
      }
    }
    const traceIds = [...new Set(valid.map(row => row.traceId))];
    let project: Awaited<ReturnType<typeof readConfiguredTraceProject>> | undefined;
    for (let offset = 0; offset < traceIds.length; offset += 16) {
      const page = await readConfiguredTraceProject(traceIds.slice(offset, offset + 16));
      if (page.status !== 'available') return { verdict: page.status === 'broken' ? 'fail' : 'unknown', detail: page.reason };
      if (!project) project = { ...page, events: [...page.events] };
      else if (project.status === 'available' && project.projectId === page.projectId) {
        project.events.push(...page.events);
        project.queriedAt = Math.min(project.queriedAt, page.queriedAt);
        project.evidenceRef += '\n' + page.evidenceRef;
      } else return unknown('Configured project changed during exact-ID readback.');
    }
    if (!project) return unknown('Expected invocation population unavailable.');
    if (project.status !== 'available') return { verdict: project.status === 'broken' ? 'fail' : 'unknown', detail: project.reason };
    // A stable event UUID identifies a retry, not another span or model call.
    // Compare every field acquired by the reader before collapsing observations;
    // a conflicting copy must not disappear in a trace/ancestry filter. Keep the
    // raw project rows below as evidence, and use this canonical graph for joins.
    const canonicalEvents = new Map<string, ObservedProjectEvent>();
    const signatures = new Map<string, string>();
    for (const event of project.events) {
      const signature = JSON.stringify([event.event, event.timestamp, event.traceId, event.spanId,
        event.parentSpanId, event.callId, event.isError, event.httpClient, event.spanName, event.requestId ?? null]);
      const prior = signatures.get(event.uuid);
      if (prior !== undefined && prior !== signature) return fail('Conflicting project event UUID observations.');
      signatures.set(event.uuid, signature);
      canonicalEvents.set(event.uuid, event);
    }
    const canonical = [...canonicalEvents.values()];
    const now = project.queriedAt;
    let pending = false;
    const measured: Array<{ row: InvocationObservation; generation: boolean; error: boolean }> = [];
    for (const row of valid) {
      const events = canonical.filter(event => event.traceId === row.traceId);
      const tools = events.filter(event => event.spanId === row.spanId && event.spanName === 'papercusp.tool' &&
        ['$ai_trace', '$ai_span'].includes(event.event));
      if (!tools.length) {
        if (now - row.endedAt >= 120_000) return fail('Fresh tool event absent after ingestion bound; invocation=' + row.id);
        pending = true;
        continue;
      }
      if (tools.some(event => event.callId !== row.callId)) return fail('Persisted invocation and project call identity differ; invocation=' + row.id);
      const anchors = new Set(tools.map(event => JSON.stringify([event.uuid, event.event, event.parentSpanId, event.timestamp])));
      if (anchors.size !== 1) return fail('Ambiguous canonical tool anchor; invocation=' + row.id);
      const httpParentOf = (event: ObservedProjectEvent): ObservedProjectEvent | null => {
        const parents = events.filter(parent => parent.spanId === event.parentSpanId && parent.event !== '$exception');
        const parent = parents.length === 1 ? parents[0]! : null;
        return parent?.event === '$ai_span' && parent.httpClient && parent.spanName === 'papercusp.http' &&
          parent.callId === row.callId ? parent : null;
      };
      const reachable = (event: ObservedProjectEvent): boolean => {
        if (event.callId !== null && event.callId !== row.callId) return false;
        // Cross-process model spans carry standard W3C ancestry, not caller
        // authority. A missing leaf callId is admitted only through its exact,
        // instrumented HTTP parent bearing this persisted callId. Direct null
        // leaves and foreign leaf IDs never satisfy the join.
        const origin = event.callId === null ? httpParentOf(event) : event;
        if (!origin) return false;
        const seen = new Set<string>();
        let parent = origin.parentSpanId;
        while (parent && !seen.has(parent)) {
          if (parent === row.spanId) return true;
          seen.add(parent);
          const edges = events.filter(edge => edge.spanId === parent && edge.event !== '$exception');
          if (edges.length !== 1 || !['$ai_trace', '$ai_span'].includes(edges[0]!.event) ||
            edges[0]!.callId !== row.callId) return false;
          parent = edges[0]!.parentSpanId;
        }
        return false;
      };
      const generations = events.filter(event => event.event === '$ai_generation' && event.spanName === 'papercusp.model');
      if (generations.some(event => event.spanId === row.spanId || !reachable(event))) return fail('Model ancestry differs from persisted tool span; invocation=' + row.id);
      if (mode !== 'project' && generations.some(event => !httpParentOf(event))) {
        return fail('Current-build model journey lacks its instrumented HTTP client parent; invocation=' + row.id);
      }
      const exceptions = events.filter(event => event.event === '$exception');
      if (exceptions.some(event => event.spanId === row.spanId ? event.callId !== row.callId : !reachable(event))) return fail('Exception ancestry differs from persisted tool span; invocation=' + row.id);
      const obligations = expectedEvents(row);
      if (obligations.some(obligation => obligation.requestId && generations.filter(generation =>
        !generation.isError && generation.requestId === obligation.requestId).length > 1)) {
        return fail('Ambiguous expected model request identity; invocation=' + row.id);
      }
      const missing = obligations.find(obligation => obligation.event === '$ai_generation'
        ? !generations.some(generation => !generation.isError && generation.requestId === obligation.requestId)
        : !exceptions.some(exception => exception.isError));
      if (missing) {
        if (now - row.endedAt >= 120_000) return fail('Expected ' + missing.event + ' absent after ingestion bound; invocation=' + row.id);
        pending = true;
        continue;
      }
      if (now - row.startedAt > 120_000 || row.startedAt > now || row.endedAt > now) continue;
      if (events.some(event => event.timestamp < row.startedAt || event.timestamp > now)) return fail('Project event lies outside the measured journey; invocation=' + row.id);
      measured.push({ row, generation: row.status === 'ok' && generations.some(event => !event.isError),
        error: row.status !== 'ok' && exceptions.some(event => event.isError) });
    }
    if (overflow) return unknown('Expected invocation population exceeds the bounded measurement; no identities were replaced.');
    if (pending) return unknown('Expected event delivery is still within its ingestion bound.');
    let selected: typeof measured;
    if (mode !== 'staging') {
      const success = measured.find(item => item.generation);
      const error = measured.find(item => item.error && item.row.callId !== success?.row.callId && item.row.traceId !== success?.row.traceId);
      if (!success || !error) return unknown('Functioning project query; fresh success-model and error observations are not both established.');
      selected = [success, error];
    } else {
      const models = measured.filter(item => item.generation);
      const left = models.find((a, i) => models.slice(i + 1).some(b => a.row.callId !== b.row.callId &&
        a.row.traceId !== b.row.traceId && a.row.spanId !== b.row.spanId && a.row.startedAt < b.row.endedAt && b.row.startedAt < a.row.endedAt));
      const right = left && models.find(b => b !== left && left.row.callId !== b.row.callId && left.row.traceId !== b.row.traceId &&
        left.row.spanId !== b.row.spanId && left.row.startedAt < b.row.endedAt && b.row.startedAt < left.row.endedAt);
      if (!left || !right) return unknown('Two fresh concurrent, disjoint tool/model journeys are not established.');
      selected = [left, right];
    }
    let shipment: { receipt: ObservabilityShipmentReceipt; validation: ReturnType<typeof verifyObservabilityShipmentReceipt>;
      observedEvents: ObservedProjectEvent[] } | undefined;
    if (releaseReceipt) {
      const observedEvents = project.events.filter(event => selected.some(({ row }) => row.traceId === event.traceId));
      const receipt: ObservabilityShipmentReceipt = { ...releaseReceipt,
        project: { id: project.projectId, queryOk: true, queriedAt: now, evidenceRef: project.evidenceRef,
          // A model process receives W3C ancestry. Its call identity is inherited
          // only after the exact HTTP-parent/ledger joins above. Preserve the raw
          // nullable observations beside the receipt so this derivation is visible.
          events: observedEvents.map(event => ({ ...event, projectId: project.projectId,
            callId: event.callId ?? selected.find(({ row }) => row.traceId === event.traceId)!.row.callId })) },
        journeys: selected.map(({ row, generation }) => {
          const event = observedEvents.find(event => event.traceId === row.traceId &&
            (generation ? event.event === '$ai_generation' && !event.isError : event.event === '$exception' && event.isError))!;
          return { callId: row.callId, traceId: row.traceId, spanId: event.spanId,
            parentSpanId: event.parentSpanId, outcome: generation ? 'ok' : 'error',
            event: generation ? '$ai_generation' : '$exception', eventUuid: event.uuid, startedAt: row.startedAt,
            invocation: { callId: row.callId, traceId: row.traceId, spanId: row.spanId,
              evidenceRef: 'tool_invocations:' + row.id },
            ancestry: canonical.filter(edge => edge.traceId === row.traceId && edge.event !== '$exception')
              .map(edge => ({ traceId: edge.traceId, spanId: edge.spanId, parentSpanId: edge.parentSpanId,
                evidenceRef: project.evidenceRef + ' uuid=' + edge.uuid })),
          };
        }),
      };
      const validation = verifyObservabilityShipmentReceipt(receipt, now);
      if (validation.verdict !== 'healthy') return {
        verdict: validation.verdict === 'broken' ? 'fail' : 'unknown',
        detail: JSON.stringify({ receipt, validation, observedEvents }),
      };
      shipment = { receipt, validation, observedEvents };
    }
    return { verdict: 'pass', detail: JSON.stringify({ detector: OBSERVABILITY_INSTRUMENT_KEYS[mode], version: 1,
      observedAt: now, host, projectId: project.projectId, projectQuery: project.evidenceRef, release: releaseEvidence,
      shipment,
      expected: valid.flatMap(row => expectedEvents(row).map(obligation => ({ id: row.id, callId: row.callId,
        traceId: row.traceId, spanId: row.spanId, ...obligation, startedAt: row.startedAt,
        endedAt: row.endedAt, deadline: row.endedAt + 120_000 }))),
      observedEvents: project.events,
      invocations: selected.map(({ row }) => ({ id: row.id, callId: row.callId, traceId: row.traceId, spanId: row.spanId,
        startedAt: row.startedAt, endedAt: row.endedAt })),
      replay: 'Run the rubric checks via the registered rubric-rescore system action; scorecards:emit fromLedger:true on the same qualified runtime and subject.' }) };
  } catch {
    return unknown('Runtime, source or invocation authority unavailable; no acceptance inferred.');
  }
}
