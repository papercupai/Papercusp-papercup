import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

type Candidate = {
  feature_id: string;
  request: unknown;
  attemptedAtMs: number | null;
  receiptId: string | null;
};

const mocks = vi.hoisted(() => ({
  getPresence: vi.fn(),
  readSnapshots: vi.fn(),
  authorizeReplay: vi.fn(),
  runPromoter: vi.fn(),
}));

vi.mock('./operator-secret-key', () => ({
  decodeOperatorSecretKey: () => Buffer.from('unit-review-key'),
}));
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: mocks.getPresence }));
vi.mock('./work-item-admission-authority', async importOriginal => ({
  ...(await importOriginal<typeof import('./work-item-admission-authority')>()),
  authorizeAdmissionReviewReplay: mocks.authorizeReplay,
}));
vi.mock('./work-items-admission-promoter', () => ({
  WORK_ITEM_ADMISSION_PROMOTER: 'work-item-admission-promoter',
  admissionReviewSubjectEligible: vi.fn(() => true),
  readAdmissionMergeSnapshots: mocks.readSnapshots,
  runWorkItemAdmissionPromoter: mocks.runPromoter,
}));

import { runAdmissionReviews } from './work-item-admission-review';

type ReviewPromoterInput = {
  sql: Sql;
  reviewOnly: {
    itemId: string;
    beforeWrite: (tx: Sql) => Promise<void>;
    afterWrite: (tx: Sql) => Promise<void>;
  };
};

const canonical = (value: unknown): string => JSON.stringify(value, (_key, part) =>
  part && typeof part === 'object' && !Array.isArray(part)
    ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);

const makeValidRequest = (sequence: number, featureId: string) => {
  const unsigned = {
    version: 1,
    requestId: '00000000-0000-4000-8000-' + String(sequence).padStart(12, '0'),
    caller: 'su-reviewer',
    purpose: 'admission-review',
    routineId: 'rt-test-reviewer',
    authority: {
      kind: 'superuser',
      credentialSha256: 'a'.repeat(64),
      role: 'operator',
      context: {
        workspaceId: 'ws-test',
        harnessSlug: 'papercusp',
        profile: 'engineer',
        runId: 'run-review-test',
        spawnId: 'spawn-review-test',
        parentSpawnId: null,
        chunkId: null,
        featureId: null,
        planRunSessionId: null,
        transport: 'mcp',
      },
    },
    requestedAt: '2026-11-03T00:00:00.000Z',
  };
  const scope = { workspaceId: 'ws-test', harnessSlug: 'papercusp', workItemId: featureId };
  const signature = createHmac('sha256', 'unit-review-key')
    .update(canonical(['admission-review-v1', scope, unsigned])).digest('hex');
  return { ...unsigned, signature };
};

describe('admission review queue fairness', () => {
  it('reaches a later valid request after refused rows without issuing receipts for refusals', async () => {
    const validFeatureId = 'EI-review-34';
    const validRequest = makeValidRequest(34, validFeatureId);
    const candidates: Candidate[] = Array.from({ length: 39 }, (_, index) => ({
      feature_id: 'EI-review-' + String(index + 1).padStart(2, '0'),
      // Missing requestId is malformed and must stay fail-closed. It also models
      // an eligible row that remains outstanding after preflight refuses it.
      request: index === 33 ? validRequest : { version: 1, purpose: 'admission-review' },
      attemptedAtMs: null,
      receiptId: null,
    }));
    mocks.getPresence.mockImplementation(async (ownerId: string) => ({
      ownerId, revoked: false, workspaceId: 'ws-test',
    }));
    mocks.readSnapshots.mockImplementation(async (_sql: unknown, selection: { ids: string[] }) =>
      new Map(selection.ids.map(id => {
        const candidate = candidates.find(row => row.feature_id === id);
        const request = candidate?.request as { caller?: string } | undefined;
        return [id, {
          fingerprint: 'fingerprint:' + id,
          assignee: request?.caller,
          payload: { _admissionReviewRequest: candidate?.request },
        }];
      })));
    mocks.authorizeReplay.mockResolvedValue(7);
    mocks.runPromoter.mockImplementation(async (...args) => {
      const input = args[0] as ReviewPromoterInput;
      await input.reviewOnly.beforeWrite(input.sql);
      await input.reviewOnly.afterWrite(input.sql);
      return { reviewedItemId: input.reviewOnly.itemId };
    });
    let clock = 1_800_000_000_000;

    const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join('?').replace(/\s+/g, ' ').trim();
      if (query.startsWith("SELECT feature_id, payload->'_admissionReviewRequest' AS request")) {
        const orderBy = query.indexOf('ORDER BY');
        const markerOrder = query.indexOf("payload->>'_admissionReviewLastAttemptAtMs'");
        expect(orderBy).toBeGreaterThanOrEqual(0);
        expect(markerOrder).toBeGreaterThan(orderBy);
        expect(query).toContain('NULLS FIRST');
        expect(query).toContain('feature_id LIMIT 20');

        return candidates
          .filter(candidate => candidate.receiptId === null)
          .sort((a, b) => {
            if (a.attemptedAtMs === null && b.attemptedAtMs !== null) return -1;
            if (a.attemptedAtMs !== null && b.attemptedAtMs === null) return 1;
            return (a.attemptedAtMs ?? 0) - (b.attemptedAtMs ?? 0) ||
              a.feature_id.localeCompare(b.feature_id);
          })
          .slice(0, 20)
          .map(({ feature_id, request }) => ({ feature_id, request }));
      }

      if (query.startsWith('UPDATE harness_shared.work_items') &&
          query.includes('_admissionReviewLastAttemptAtMs')) {
        const candidate = candidates.find(row => values.includes(row.feature_id));
        expect(candidate).toBeDefined();
        expect(values).toContain(JSON.stringify(candidate!.request));
        candidate!.attemptedAtMs = clock++;
        return [{ feature_id: candidate!.feature_id }];
      }

      if (query.startsWith('SELECT value_b64 FROM harness_shared.operator_secrets')) {
        return [{ value_b64: 'dW5pdC1yZXZpZXcta2V5' }];
      }
      if (query.startsWith('SELECT id FROM harness_shared.routines')) return [{ id: 'rt-test-reviewer' }];

      if (query.startsWith('UPDATE harness_shared.work_items') &&
          query.includes('_admissionReviewReceipt')) {
        const candidate = candidates.find(row => values.includes(row.feature_id));
        const receiptText = values.find(value => typeof value === 'string' && value.includes('"requestId"'));
        expect(candidate).toBeDefined();
        expect(receiptText).toBeDefined();
        candidate!.receiptId = (JSON.parse(String(receiptText)) as { requestId: string }).requestId;
        return [{ feature_id: candidate!.feature_id }];
      }

      throw new Error('unexpected admission-review SQL: ' + query);
    }), {
      typed: vi.fn((value: string) => value),
    }) as unknown as Sql;

    const options = { workspaceId: 'ws-test', harnessSlug: 'papercusp', runId: 'review-rotation' };
    const llmCall = vi.fn() as never;
    const first = await runAdmissionReviews(options, sql, llmCall);
    const second = await runAdmissionReviews(options, sql, llmCall);
    const validCandidate = candidates.find(row => row.feature_id === validFeatureId)!;

    expect(first.result).toBeNull();
    expect(first.guardRefusals.map(row => row.itemId)).toEqual(
      candidates.slice(0, 20).map(row => row.feature_id),
    );
    expect(second.guardRefusals.map(row => row.itemId)).toEqual(
      candidates.slice(20, 33).map(row => row.feature_id),
    );
    expect(second.reviewedItemId).toBe(validFeatureId);
    expect(second.result).toEqual({ reviewedItemId: validFeatureId });
    expect(mocks.runPromoter).toHaveBeenCalledTimes(1);
    expect(validCandidate.attemptedAtMs).not.toBeNull();
    expect(validCandidate.receiptId).toBe(validRequest.requestId);
    expect(candidates.filter(row => row !== validCandidate).every(row => row.receiptId === null)).toBe(true);
  });
});
