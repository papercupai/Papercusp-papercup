/** Typed review evidence on the existing consult outcome; no separate review store. */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

const text = (max: number) => z.string().trim().min(1).max(max);
export const reviewAnswerSchema = z.object({
  subjectRef: text(1000).describe('Exact subject/revision reviewed, for example plan:<slug>@<contentHash>.'),
  coverage: z.enum(['complete', 'incomplete']),
  findings: z.array(z.object({
    key: text(80).regex(/^[A-Za-z0-9_-]+$/),
    severity: z.enum(['blocker', 'major', 'minor', 'nit']),
    text: text(4000),
    evidenceRefs: z.array(text(1000)).max(16),
  }).strict()).max(40),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.findings.map(f => f.key)).size !== value.findings.length)
    ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Finding keys must be unique within this answer.' });
});
export const reviewDispositionsSchema = z.array(z.object({
  findingId: text(200),
  status: z.enum(['fixed', 'rejected', 'accepted-risk', 'planned']),
  reason: text(4000),
  reference: text(1000).describe('Evidence for the disposition, or the Decision/item carrying accepted risk or planned work.'),
}).strict()).max(100);
export type ReviewAnswer = z.infer<typeof reviewAnswerSchema>;
export type ReviewDispositionInput = z.infer<typeof reviewDispositionsSchema>[number];
export interface StoredReviewAnswer {
  postId: number; reviewerId: string; subjectRef: string; coverage: ReviewAnswer['coverage']; at: string;
}
export type StoredReviewFinding = ReviewAnswer['findings'][number] & {
  id: string; postId: number; reviewerId: string; subjectRef: string;
};
export interface StoredReviewDisposition extends ReviewDispositionInput {
  postId: number; authorId: string; at: string;
}
export interface ConsultReviewState {
  version: 1;
  answers: StoredReviewAnswer[];
  findings: StoredReviewFinding[];
  dispositions: StoredReviewDisposition[];
}

const provenance = { postId: z.number().int().nonnegative(), reviewerId: text(300), subjectRef: text(1000) };
const persistedReviewSchema = z.object({
  version: z.literal(1),
  answers: z.array(z.object({ ...provenance, coverage: reviewAnswerSchema.shape.coverage, at: text(100) })).max(100),
  findings: z.array(z.object({ ...reviewAnswerSchema.shape.findings.element.shape,
    ...provenance, id: text(200) })).max(400),
  dispositions: z.array(reviewDispositionsSchema.element.extend({ postId: provenance.postId, authorId: text(300), at: text(100) })).max(1000),
});

export function readConsultReview(outcome: unknown): ConsultReviewState | undefined {
  const parsed = typeof outcome === 'string' ? JSON.parse(outcome) : outcome;
  const review = (parsed as { review?: ConsultReviewState } | null)?.review;
  if (review === undefined) return undefined;
  const result = persistedReviewSchema.safeParse(review);
  if (!result.success) throw new Error('Invalid persisted consult review state');
  return result.data;
}

/** The original finding is immutable; later decisions append to its history. */
export function appendConsultReview(input: {
  current?: ConsultReviewState; answer?: ReviewAnswer; dispositions?: ReviewDispositionInput[];
  postId: number; authorId: string; requesterId: string; at: string;
}): ConsultReviewState {
  const state: ConsultReviewState = input.current
    ? structuredClone(input.current) : { version: 1, answers: [], findings: [], dispositions: [] };
  if (input.answer) {
    const answer = reviewAnswerSchema.parse(input.answer);
    const assessment = { postId: input.postId, reviewerId: input.authorId, subjectRef: answer.subjectRef,
      coverage: answer.coverage, at: input.at };
    const findings = answer.findings.map(finding => ({ ...finding,
      id: `post:${input.postId}#${finding.key}`, postId: input.postId,
      reviewerId: input.authorId, subjectRef: answer.subjectRef }));
    const previous = state.answers.find(a => a.postId === input.postId);
    if (previous) {
      if (!isDeepStrictEqual(previous, assessment) ||
          !isDeepStrictEqual(state.findings.filter(f => f.postId === input.postId), findings))
        throw new Error('Conflicting replay of review answer');
    } else {
      state.answers.push(assessment);
      state.findings.push(...findings);
    }
  }
  if (input.dispositions !== undefined) {
    if (input.authorId !== input.requesterId) throw new Error('Only the requester may disposition review findings');
    const dispositions = reviewDispositionsSchema.parse(input.dispositions);
    const seen = new Set<string>();
    const events: StoredReviewDisposition[] = [];
    for (const disposition of dispositions) {
      if (seen.has(disposition.findingId)) throw new Error('Duplicate finding disposition');
      seen.add(disposition.findingId);
      if (!state.findings.some(finding => finding.id === disposition.findingId))
        throw new Error(`Unknown review finding: ${disposition.findingId}`);
      events.push({ ...disposition, postId: input.postId, authorId: input.authorId, at: input.at });
    }
    const previous = state.dispositions.filter(d => d.postId === input.postId);
    if (previous.length) {
      if (!isDeepStrictEqual(previous, events)) throw new Error('Conflicting replay of review dispositions');
    } else state.dispositions.push(...events);
  }
  // Refuse overflow rather than silently lose findings or disposition history.
  if (state.answers.length > 100 || state.findings.length > 400 || state.dispositions.length > 1000)
    throw new Error('Consult review history limit reached; graduate this consult with its existing evidence');
  return state;
}
