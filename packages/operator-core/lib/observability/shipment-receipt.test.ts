import { describe, expect, it } from 'vitest';
import { verifyObservabilityShipmentReceipt, type ObservabilityShipmentReceipt } from './shipment-receipt';

const now = 1_800_000_000_000;
function measuredReceipt(): ObservabilityShipmentReceipt {
  const blob = 'a'.repeat(40), promoted = 'b'.repeat(40), digest = 'c'.repeat(64);
  const journeys = (['ok', 'error'] as const).map((outcome, i) => {
    const ids = { callId: 'call-' + i, traceId: String(i + 1).repeat(32),
      spanId: String(i + 3).repeat(16), parentSpanId: String(i + 5).repeat(16) };
    return { ...ids, outcome, event: outcome === 'ok' ? '$ai_generation' as const : '$exception' as const,
      eventUuid: 'event-' + i, startedAt: now - 2_000,
      invocation: { ...ids, spanId: outcome === 'ok' ? ids.parentSpanId : ids.spanId,
        evidenceRef: 'tool_invocations.id=' + (i + 1) } };
  });
  return {
    accepted: { sourceSha: 'd'.repeat(40), blobs: { 'observability.ts': blob } },
    artifact: { sourceSha: promoted, digest, containment: [{ path: 'observability.ts',
      containedInJudgedSha: true, stagingBlob: blob, judgedBlob: blob }] },
    green: { verdict: 'green', sourceSha: promoted, digest, evidenceRef: 'green-verdict:1' },
    runtime: { plane: 'release-operator', sourceSha: promoted, digest, providerRegistered: true,
      loadedBlobs: { 'observability.ts': blob }, evidenceRef: 'release-runtime:1' },
    project: { id: 'project-1', queryOk: true, queriedAt: now - 1_000, evidenceRef: 'project-query:1',
      events: journeys.map(j => ({ callId: j.callId, traceId: j.traceId, spanId: j.spanId,
        parentSpanId: j.parentSpanId, projectId: 'project-1', uuid: j.eventUuid,
        event: j.event, timestamp: now - 1_500 })) },
    journeys,
  };
}

describe('observability shipment receipt', () => {
  it('accepts same-artifact green release and fresh project readback with preserved source and correlation', () => {
    const receipt = measuredReceipt();
    receipt.project.events.push({ ...receipt.project.events[0]! }); // stable transport retry
    expect(verifyObservabilityShipmentReceipt(receipt, now)).toEqual({ verdict: 'healthy', failures: [] });
  });
  it('preserves a measured root span without inventing a parent', () => {
    const receipt = measuredReceipt();
    receipt.journeys[1]!.parentSpanId = null;
    receipt.project.events[1]!.parentSpanId = null;
    expect(verifyObservabilityShipmentReceipt(receipt, now).verdict).toBe('healthy');
  });
  it('connects a model through an HTTP parent to its persisted tool span', () => {
    const receipt = measuredReceipt();
    const journey = receipt.journeys[0]!;
    journey.invocation.spanId = '7'.repeat(16);
    journey.ancestry = [{ traceId: journey.traceId, spanId: journey.parentSpanId!,
      parentSpanId: journey.invocation.spanId, evidenceRef: 'project-query:http-span' }];
    expect(verifyObservabilityShipmentReceipt(receipt, now).verdict).toBe('healthy');
    journey.ancestry[0]!.parentSpanId = '8'.repeat(16);
    expect(verifyObservabilityShipmentReceipt(receipt, now).verdict).toBe('broken');
  });
  it.each<[string, (receipt: ObservabilityShipmentReceipt) => void]>([
    ['artifact source', r => { r.artifact.containment[0]!.judgedBlob = 'e'.repeat(40); }],
    ['loaded source', r => { r.runtime.loadedBlobs['observability.ts'] = 'e'.repeat(40); }],
    ['green commit', r => { r.green.sourceSha = 'e'.repeat(40); }],
    ['green digest', r => { r.green.digest = 'e'.repeat(64); }],
    ['red verdict', r => { r.green.verdict = 'red'; }],
    ['serving digest', r => { r.runtime.digest = 'e'.repeat(64); }],
    ['staging runtime', r => { r.runtime.plane = 'staging-operator'; }],
    ['unregistered provider', r => { r.runtime.providerRegistered = false; }],
    ['wrong project', r => { r.project.events[0]!.projectId = 'another-project'; }],
    ['wrong parent', r => { r.project.events[0]!.parentSpanId = 'e'.repeat(16); }],
    ['exchanged invocations', r => { r.journeys[0]!.invocation = r.journeys[1]!.invocation; }],
    ['model aliases tool span', r => { r.journeys[0]!.invocation.spanId = r.journeys[0]!.spanId; }],
    ['old journey', r => { r.journeys[0]!.startedAt -= 120_001; }],
    ['stale query', r => { r.project.queriedAt -= 120_001; }],
    ['old event', r => { r.project.events[0]!.timestamp -= 120_001; }],
    ['missing fresh event after deadline', r => {
      r.project.events = []; r.project.queriedAt = now;
      for (const journey of r.journeys) journey.startedAt = now - 120_000;
    }],
    ['missing error journey', r => { r.journeys.pop(); }],
    ['empty source', r => { r.accepted.blobs = {}; }],
    ['duplicate source row', r => { r.artifact.containment.push({ ...r.artifact.containment[0]! }); }],
  ])('rejects a receipt with %s while the positive control succeeds', (_name, change) => {
    const receipt = measuredReceipt();
    expect(verifyObservabilityShipmentReceipt(receipt, now).verdict).toBe('healthy');
    change(receipt);
    expect(verifyObservabilityShipmentReceipt(receipt, now).verdict).toBe('broken');
  });
  it('keeps query denial and missing source receipts unknown, without inventing shipment', () => {
    const receipt = measuredReceipt();
    receipt.project.queryOk = false;
    receipt.project.events = [];
    expect(verifyObservabilityShipmentReceipt(receipt, now).verdict).toBe('unknown');
    receipt.project.queryOk = true; // query succeeded, but the ingestion deadline has not elapsed
    expect(verifyObservabilityShipmentReceipt(receipt, now).verdict).toBe('unknown');
    expect(verifyObservabilityShipmentReceipt({} as ObservabilityShipmentReceipt, now).verdict).toBe('unknown');
  });
});
