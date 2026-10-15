import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { phoneRetainedOutcomeReader } from './phone-retained-outcome';
import type { ExternalRuntimeProducerBinding } from './operation-worker-binding';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function fixture() {
  const binding: ExternalRuntimeProducerBinding = { kind: 'external-runtime-producer', workspaceId: 'workspace',
    harnessSlug: 'phone-app', storageHarnessSlug: 'home', workItemId: 'WI-voice', executionOwnerId: 'voice-run',
    ownerId: 'owner-a', callKey: 'inbound:room-a', callId: 'call-a', runId: 'run-a', jobId: 'job-a',
    configurationSha256: hash('stt=google/model;llm=google/model'), registeredAt: '2026-10-07T13:00:00Z' };
  const registration = { binding: { ...binding }, roomName: 'room-a', contentDeleted: false };
  const exported = { ok: true, content: { format: 'papercusp-phone-call-v1', call: { id: 'call-a', roomName: 'room-a' },
    segments: [{ seq: 2, speaker: 'agent', text: 'Hello' }, { seq: 1, speaker: 'caller', text: 'Hi' }] },
    reviewSource: { status: 'available', callId: 'call-a', callKey: binding.callKey,
      sessionStartedAt: binding.registeredAt, sessionEndedAt: '2026-10-07T13:01:00Z', endReason: 'completed',
      voiceRuntime: { runId: 'run-a', jobId: 'job-a', configFingerprint: 'stt=google/model;llm=google/model' },
      transcriptRef: { segmentCount: 2, sha256: hash(JSON.stringify([[1, 'caller', 'Hi'], [2, 'agent', 'Hello']])) },
      transcript: [[999, 'agent', 'UNTRUSTED']] } };
  const host = { readRegistration: vi.fn(async () => registration), readExport: vi.fn(async () => exported) };
  return { binding, registration, exported, host, read: phoneRetainedOutcomeReader(host, binding) };
}
describe('Phone retained completion read', () => {
  it('reads as the registered owner and recomputes stored tuples instead of review text', async () => {
    const f = fixture();
    const outcome = await f.read();
    expect(f.host.readRegistration).toHaveBeenCalledWith('owner-a', 'inbound:room-a');
    expect(f.host.readExport).toHaveBeenCalledWith('owner-a', 'room-a');
    expect(outcome.retainedSha256).toBe(f.exported.reviewSource.transcriptRef.sha256);
    expect(outcome.binding).toEqual(f.binding);
  });
  it('excludes segments appended after the recorded end', async () => {
    const f = fixture();
    f.exported.content.segments.push({ seq: 3, speaker: 'agent', text: 'late' });
    expect((await f.read()).retainedSegmentCount).toBe(2);
  });
  it('rejects a replaced session start even when call, runtime and transcript match', async () => {
    const f = fixture();
    f.exported.reviewSource.sessionStartedAt = '2026-10-07T13:00:30Z';
    await expect(f.read()).rejects.toThrow('runtime_mismatch');
  });
  it.each(['runId', 'ownerId', 'callKey', 'workItemId'] as const)('rejects rebound registration %s before export', async (field) => {
    const f = fixture(); f.registration.binding[field] = 'foreign';
    await expect(f.read()).rejects.toThrow('registration_changed');
    expect(f.host.readExport).not.toHaveBeenCalled();
  });
  it('captures the attempt before caller mutation', async () => {
    const f = fixture(); f.binding.ownerId = 'foreign';
    await f.read();
    expect(f.host.readExport).toHaveBeenCalledWith('owner-a', 'room-a');
  });
  it.each(['runId', 'jobId', 'configFingerprint'] as const)('rejects different retained runtime %s', async (field) => {
    const f = fixture(); f.exported.reviewSource.voiceRuntime[field] = 'foreign';
    await expect(f.read()).rejects.toThrow('runtime_mismatch');
  });
  it.each(['call', 'room', 'key'] as const)('rejects a different %s export', async (field) => {
    const f = fixture();
    if (field === 'call') f.exported.content.call.id = 'foreign';
    if (field === 'room') f.exported.content.call.roomName = 'foreign';
    if (field === 'key') f.exported.reviewSource.callKey = 'foreign';
    await expect(f.read()).rejects.toThrow('runtime_mismatch');
  });
  it('rejects deletion even when an empty digest would still match', async () => {
    const f = fixture(); f.registration.contentDeleted = true;
    await expect(f.read()).rejects.toThrow('deleted');
  });
  it.each(['delete', 'rebind', 'room'] as const)('rejects %s racing the export read', async (kind) => {
    const f = fixture();
    f.host.readExport.mockImplementation(async () => {
      if (kind === 'delete') f.registration.contentDeleted = true;
      if (kind === 'rebind') f.registration.binding.jobId = 'replacement';
      if (kind === 'room') f.registration.roomName = 'foreign';
      return f.exported;
    });
    await expect(f.read()).rejects.toThrow('registration_changed');
  });
  it.each(['rewrite', 'short', 'duplicate'] as const)('rejects %s stored content', async (kind) => {
    const f = fixture();
    if (kind === 'rewrite') f.exported.content.segments[0].text = 'rewritten';
    if (kind === 'short') f.exported.content.segments.pop();
    if (kind === 'duplicate') f.exported.content.segments[0].seq = 1;
    await expect(f.read()).rejects.toThrow(/transcript_(invalid|digest_mismatch)/);
  });
  it('preserves worker-lost instead of converting it to completed', async () => {
    const f = fixture(); f.exported.reviewSource.endReason = 'worker-lost';
    expect((await f.read()).endReason).toBe('worker-lost');
  });
  it('refuses legacy runtime and unavailable source', async () => {
    const f = fixture(); f.exported.reviewSource.status = 'unavailable';
    await expect(f.read()).rejects.toThrow();
  });
});
