import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ExternalRuntimeProducerBinding, ExternalRuntimeStoredOutcome } from './operation-worker-binding';

const exportSchema = z.object({
  ok: z.literal(true),
  content: z.object({
    format: z.literal('papercusp-phone-call-v1'),
    call: z.object({ id: z.string().min(1), roomName: z.string().min(1) }),
    segments: z.array(z.object({ seq: z.number().int().nonnegative(), speaker: z.string(), text: z.string() })),
  }),
  reviewSource: z.object({
    status: z.literal('available'),
    callId: z.string().min(1), callKey: z.string().min(1),
    sessionStartedAt: z.string().min(1), sessionEndedAt: z.string().min(1),
    endReason: z.enum(['completed', 'worker-lost']),
    voiceRuntime: z.object({ runId: z.string().min(1), jobId: z.string().min(1), configFingerprint: z.string().min(1) }),
    transcriptRef: z.object({ segmentCount: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  }),
});

/** The callbacks belong to the authenticated host adapter, never tool arguments.
 * Registration and deletion are re-read from owner-scoped retained call units;
 * the export is fetched as that owner through Phone's existing export route. */
export interface PhoneRetainedOutcomeHost {
  readRegistration(ownerId: string, callKey: string): Promise<{
    binding: ExternalRuntimeProducerBinding;
    roomName: string;
    contentDeleted: boolean;
  }>;
  readExport(ownerId: string, roomName: string): Promise<unknown>;
}

/** Make the callback consumed by the canonical external-runtime verifier.
 * Captures the attempted binding before I/O. Never treats the export's supplied
 * review transcript as proof: recompute Phone's sorted JSON tuple prefix digest.
 * Appended post-end segments are outside that recorded prefix, as in Phone's
 * maintained wrapUpTranscript contract. Rewrites/deletion/short reads fail closed.
 */
export function phoneRetainedOutcomeReader(host: PhoneRetainedOutcomeHost,
  attemptedBinding: ExternalRuntimeProducerBinding): () => Promise<ExternalRuntimeStoredOutcome> {
  const expected = Object.freeze({ ...attemptedBinding });
  return async () => {
    const registration = await host.readRegistration(expected.ownerId, expected.callKey);
    const binding = { ...registration.binding };
    if (!isDeepStrictEqual(binding, expected) || !registration.roomName ||
        typeof registration.contentDeleted !== 'boolean' || registration.contentDeleted) {
      throw new Error('phone_retained_registration_changed_or_deleted');
    }
    const roomName = registration.roomName;
    const exported = exportSchema.parse(await host.readExport(expected.ownerId, roomName));
    const source = exported.reviewSource;
    // Phone's configFingerprint is configured vendor/model text, not a SHA and
    // not provider-observed identity. Canonical registration stores its SHA256.
    const configurationSha256 = createHash('sha256').update(source.voiceRuntime.configFingerprint, 'utf8').digest('hex');
    if (exported.content.call.id !== binding.callId || exported.content.call.roomName !== roomName ||
        source.callId !== binding.callId || source.callKey !== binding.callKey ||
        source.voiceRuntime.runId !== binding.runId || source.voiceRuntime.jobId !== binding.jobId ||
        configurationSha256 !== binding.configurationSha256 ||
        source.sessionStartedAt !== binding.registeredAt ||
        !Number.isFinite(Date.parse(source.sessionStartedAt)) ||
        !Number.isFinite(Date.parse(source.sessionEndedAt)) ||
        Date.parse(source.sessionEndedAt) < Date.parse(source.sessionStartedAt)) {
      throw new Error('phone_retained_call_runtime_mismatch');
    }
    const segments = [...exported.content.segments].sort((a, b) => a.seq - b.seq);
    if (segments.some((segment, index) => index > 0 && segment.seq === segments[index - 1].seq) ||
        segments.length < source.transcriptRef.segmentCount) {
      throw new Error('phone_retained_transcript_invalid');
    }
    const tuples = segments.slice(0, source.transcriptRef.segmentCount).map(({ seq, speaker, text }) => [seq, speaker, text]);
    const retainedSha256 = createHash('sha256').update(JSON.stringify(tuples), 'utf8').digest('hex');
    if (retainedSha256 !== source.transcriptRef.sha256) throw new Error('phone_retained_transcript_digest_mismatch');
    // Export I/O may overlap deletion or re-registration, including an empty
    // transcript whose hash would not expose deletion. Recheck the host record.
    const after = await host.readRegistration(expected.ownerId, expected.callKey);
    if (!isDeepStrictEqual(after.binding, binding) || after.roomName !== roomName || after.contentDeleted !== false) {
      throw new Error('phone_retained_registration_changed_or_deleted');
    }
    return { binding, endReason: source.endReason, endedAt: source.sessionEndedAt,
      transcriptSegmentCount: source.transcriptRef.segmentCount, transcriptSha256: source.transcriptRef.sha256,
      retainedSegmentCount: tuples.length, retainedSha256, contentDeleted: false };
  };
}
