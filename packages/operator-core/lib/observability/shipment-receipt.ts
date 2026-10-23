import type { PathContainment } from '../release/judged-sha-containment';

interface Correlation {
  callId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

/** Sanitized measurements from the release, invocation ledger and configured project. */
export interface ObservabilityShipmentReceipt {
  accepted: { sourceSha: string; blobs: Record<string, string> };
  artifact: { sourceSha: string; digest: string; containment: PathContainment[] };
  green: { verdict: string; sourceSha: string; digest: string; evidenceRef: string };
  runtime: {
    plane: string; sourceSha: string; digest: string; providerRegistered: boolean;
    loadedBlobs: Record<string, string>; evidenceRef: string;
  };
  project: {
    id: string; queryOk: boolean; queriedAt: number; evidenceRef: string;
    events: Array<Correlation & { projectId: string; uuid: string; event: string; timestamp: number }>;
  };
  journeys: Array<Correlation & {
    outcome: 'ok' | 'error'; event: '$ai_generation' | '$exception'; eventUuid: string;
    startedAt: number;
    invocation: Pick<Correlation, 'callId' | 'traceId' | 'spanId'> & { evidenceRef: string };
    ancestry?: Array<Pick<Correlation, 'traceId' | 'spanId' | 'parentSpanId'> & { evidenceRef: string }>;
  }>;
}

/** Checks measured receipts; this does not collect evidence or turn fixture data into shipment. */
export function verifyObservabilityShipmentReceipt(
  receipt: ObservabilityShipmentReceipt,
  now = Date.now(),
): { verdict: 'healthy' | 'broken' | 'unknown'; failures: string[] } {
  const failures: string[] = [];
  let missing = false;
  const check = (condition: boolean, reason: string) => { if (!condition) failures.push(reason); };
  const sha = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const ref = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!receipt?.accepted || !receipt.artifact || !receipt.green || !receipt.runtime
    || !receipt.project || !Array.isArray(receipt.journeys)
    || !receipt.accepted.blobs || !Array.isArray(receipt.artifact.containment)
    || !receipt.runtime.loadedBlobs || !Array.isArray(receipt.project.events)) {
    return { verdict: 'unknown', failures: ['incomplete-receipt'] };
  }
  check(sha(receipt.accepted.sourceSha), 'invalid-accepted-source');
  check(sha(receipt.artifact.sourceSha), 'invalid-artifact-source');
  check(digest(receipt.artifact.digest), 'invalid-artifact-digest');
  // The promoted commit may contain additional work; per-path containment proves acceptance.
  check(Object.keys(receipt.accepted.blobs).length > 0, 'empty-accepted-source');
  for (const [path, blob] of Object.entries(receipt.accepted.blobs)) {
    const matches = receipt.artifact.containment.filter(row => row.path === path);
    check(sha(blob) && matches.length === 1 && matches[0]!.containedInJudgedSha
      && matches[0]!.stagingBlob === blob && matches[0]!.judgedBlob === blob,
    'artifact-source-mismatch:' + path);
    check(receipt.runtime.loadedBlobs[path] === blob, 'loaded-source-mismatch:' + path);
  }
  check(receipt.green.verdict === 'green', 'artifact-not-green');
  check(receipt.green.sourceSha === receipt.artifact.sourceSha
    && receipt.green.digest === receipt.artifact.digest, 'green-artifact-mismatch');
  check(receipt.runtime.plane === 'release-operator', 'wrong-runtime-plane');
  check(receipt.runtime.sourceSha === receipt.artifact.sourceSha
    && receipt.runtime.digest === receipt.artifact.digest, 'serving-artifact-mismatch');
  check(receipt.runtime.providerRegistered === true, 'provider-not-registered');
  for (const value of [receipt.green.evidenceRef, receipt.runtime.evidenceRef, receipt.project.evidenceRef]) {
    if (!ref(value)) missing = true;
  }
  if (receipt.project.queryOk !== true) missing = true;
  check(ref(receipt.project.id), 'missing-project-identity');
  check(Number.isFinite(now) && Number.isFinite(receipt.project.queriedAt)
    && now >= receipt.project.queriedAt && now - receipt.project.queriedAt <= 120_000,
  'stale-project-query');
  check(['ok', 'error'].every(outcome => receipt.journeys.some(j => j.outcome === outcome)),
    'missing-success-or-error-journey');
  const calls = new Set<string>();
  const uuids = new Set<string>();
  for (const journey of receipt.journeys) {
    check(ref(journey.callId) && !calls.has(journey.callId), 'duplicate-or-empty-call-id');
    check(ref(journey.eventUuid) && !uuids.has(journey.eventUuid), 'duplicate-or-empty-event-uuid');
    calls.add(journey.callId); uuids.add(journey.eventUuid);
    const validSpan = (id: string) => /^[a-f0-9]{16}$/.test(id) && !/^0+$/.test(id);
    check(/^[a-f0-9]{32}$/.test(journey.traceId) && !/^0+$/.test(journey.traceId)
      && validSpan(journey.spanId) && (journey.parentSpanId === null || validSpan(journey.parentSpanId)),
    'invalid-correlation');
    check(journey.event === (journey.outcome === 'ok' ? '$ai_generation' : '$exception'), 'wrong-event-kind');
    check(Number.isFinite(journey.startedAt) && receipt.project.queriedAt >= journey.startedAt
      && receipt.project.queriedAt - journey.startedAt <= 120_000, 'stale-journey');
    if (!journey.invocation || !ref(journey.invocation.evidenceRef)) missing = true;
    for (const key of ['callId', 'traceId'] as const) {
      check(journey.invocation?.[key] === journey[key], 'invocation-correlation-mismatch:' + key);
    }
    check(journey.event !== '$ai_generation' || journey.spanId !== journey.invocation?.spanId,
      'model-span-aliases-tool-span');
    // Invocation metadata records the tool span. A model span is its descendant,
    // often through an HTTP span, so equal model/tool span IDs would be incorrect.
    let linked = journey.spanId === journey.invocation?.spanId;
    let parent = journey.parentSpanId;
    const seen = new Set([journey.spanId]);
    while (!linked && parent !== null && !seen.has(parent)) {
      if (parent === journey.invocation?.spanId) { linked = true; break; }
      seen.add(parent);
      const edges = (journey.ancestry ?? []).filter(edge => edge.spanId === parent);
      if (edges.length !== 1) break;
      const edge = edges[0]!;
      check(edge.traceId === journey.traceId, 'ancestry-trace-mismatch');
      if (!ref(edge.evidenceRef)) missing = true;
      parent = edge.parentSpanId;
    }
    check(linked, 'invocation-ancestry-mismatch');
    if (receipt.project.queryOk !== true) continue;
    const events = receipt.project.events.filter(event => event.uuid === journey.eventUuid);
    if (events.length === 0) {
      if (receipt.project.queriedAt - journey.startedAt >= 120_000) failures.push('fresh-event-absent');
      else missing = true;
      continue;
    }
    // Retries can yield repeated rows; each must preserve the same event identity and correlation.
    for (const event of events) {
      check(event.event === journey.event && event.projectId === receipt.project.id, 'project-event-mismatch');
      for (const key of ['callId', 'traceId', 'spanId', 'parentSpanId'] as const) {
        check(event[key] === journey[key], 'event-correlation-mismatch:' + key);
      }
      check(Number.isFinite(event.timestamp) && event.timestamp >= journey.startedAt
        && event.timestamp <= receipt.project.queriedAt, 'event-outside-journey');
    }
  }
  return { verdict: failures.length ? 'broken' : missing ? 'unknown' : 'healthy',
    failures: missing ? [...failures, 'inaccessible-or-unreferenced-evidence'] : failures };
}
