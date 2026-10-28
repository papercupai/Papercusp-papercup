import { getOrgPg } from '@papercusp/db-org';
import type { PlatformInstrument } from '../rubric-instrument-registry';
import { readPersonQualificationEvidence } from './people';

export const LEAD_SOURCE_OBSERVATIONS_INSTRUMENT_KEY = 'people:qualification-source-observations';

/** Measures source presence, never fit, consent or authenticated product usage. */
export function leadSourceObservationsRescore(
  read: typeof readPersonQualificationEvidence = readPersonQualificationEvidence,
): NonNullable<PlatformInstrument['rescore']> {
  return {
    scope: 'subject', windowMs: 30 * 24 * 60 * 60_000, unit: 'count',
    async resolve(input) {
      if (!input.workspaceId.trim() || input.workspaceId === '*' || input.subject?.kind !== 'person' ||
          !/^PER-[A-Za-z0-9-]+$/.test(input.subject.ref)) {
        return { verdict: 'unknown', detail: 'canonical_person_subject_required' };
      }
      const evidence = await read(getOrgPg().sql, input.workspaceId, input.subject.ref,
        { windowStart: input.windowStart, windowEnd: input.windowEnd });
      if (evidence.status === 'unknown') return { verdict: 'unknown', detail: evidence.reason };
      return {
        verdict: evidence.sources.length ? 'pass' : 'fail', value: evidence.sources.length,
        detail: `Source observation count for ${evidence.person.id}`,
        evidenceRefs: evidence.sources.map(source => source.evidenceRef),
      };
    },
  };
}
