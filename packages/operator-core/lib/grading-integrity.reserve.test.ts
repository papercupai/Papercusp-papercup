import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ boundedOrgTxn: vi.fn() }));

vi.mock('./pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));

import {
  confirmPendingGradingAuditReservation,
  releasePendingGradingAudit,
  reservePendingGradingAudit,
} from './grading-integrity';
import type { ScorecardGradingAuditCurrentness } from './scorecards';

type QueryResult = Record<string, unknown>[];

function transactionHarness(options: {
  claim: boolean;
  currentState?: string;
  hasReservation?: boolean;
  retracted?: boolean;
  backoff?: unknown;
  confirmReservation?: boolean;
  /** WI-10005273: the row's state + lease as read by the claim's leading row lock. */
  priorState?: string | null;
  priorReservation?: unknown;
  priorLastReservation?: unknown;
}) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult> => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('AS prior_reservation')) {
      return [
        {
          feature_id: 'EI-prior',
          prior_state: options.priorState === undefined ? 'pending' : options.priorState,
          prior_reservation: options.priorReservation ?? null,
          prior_last_reservation: options.priorLastReservation ?? null,
        },
      ];
    }
    if (text.includes('RETURNING feature_id')) {
      return options.claim ? [{ feature_id: 'EI-legacy-settled' }] : [];
    }
    if (text.includes('SELECT scorecard.feature_id') && text.includes("dispatchReservation'->>'key'")) {
      return options.confirmReservation ? [{ feature_id: 'EI-reserved' }] : [];
    }
    if (text.includes("payload #- '{observation,gradingAudit,dispatchReservation}'")) return [];
    if (text.includes("jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}'")) return [];
    if (text.includes("'{observation,gradingAudit}'")) return [];
    if (text.includes("SELECT payload->'observation'->'gradingAudit'->>'state'")) {
      return [
        {
          state: options.currentState ?? 'failed',
          has_reservation: options.hasReservation ?? false,
          backoff: options.backoff ?? null,
          retracted: options.retracted ?? false,
        },
      ];
    }
    if (
      text.trim() === 'FALSE' ||
      text.includes("gradingAudit'->>'state' IN ('passed', 'failed')") ||
      text.includes("payload->'observation'->'retracted' IS NULL")
    ) return [];
    throw new Error(`unexpected query: ${text}`);
  }) as never;
  h.boundedOrgTxn.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  return { statements };
}

beforeEach(() => {
  h.boundedOrgTxn.mockReset();
});

describe('reservePendingGradingAudit', () => {
  it('confirms only an owned pending reservation while holding the scorecard row lock', async () => {
    const { statements } = transactionHarness({ claim: false, confirmReservation: true });

    const result = await confirmPendingGradingAuditReservation('EI-reserved', 'grading-audit:reserved', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });

    expect(result).toBe(true);
    const confirmation = statements.find(
      (statement) =>
        statement.text.includes('SELECT scorecard.feature_id') && statement.text.includes("dispatchReservation'->>'key'"),
    );
    expect(confirmation).toBeDefined();
    expect(confirmation?.values).toEqual([
      'ws-test',
      'EI-reserved',
      'grading-audit:reserved',
      '2026-09-08T00:00:00.000Z',
      '2026-09-08T00:00:00.000Z',
      false,
      null,
      null,
      null,
    ]);
    expect(confirmation?.text).toContain("gradingAudit'->>'state' = 'pending'");
    expect(confirmation?.text).toContain("gradingAudit'->'dispatchReservation'->>'key' = ?");
    expect(confirmation?.text).toContain("gradingAudit'->'dispatchReservation'->>'reservedAt' = ?");
    expect(confirmation?.text).toContain("scorecard.payload->'observation'->'retracted' IS NULL");
    expect(confirmation?.text).toContain('NOT EXISTS');
    expect(confirmation?.text).toContain("superseder.payload->'observation'->>'supersedes' = scorecard.feature_id");
    expect(confirmation?.text).toContain(
      "superseder.payload->'observation'->>'rubricRef' = scorecard.payload->'observation'->>'rubricRef'",
    );
    expect(confirmation?.text).toContain(
      "superseder.payload->'observation'->>'sourceHive' IS NOT DISTINCT FROM scorecard.payload->'observation'->>'sourceHive'",
    );
    expect(confirmation?.text).toContain('FOR UPDATE');
  });

  it('releases only the reservation from its own epoch', async () => {
    const { statements } = transactionHarness({ claim: false });

    const result = await releasePendingGradingAudit('EI-reserved', 'grading-audit:reserved', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });

    expect(result).toBe(false);
    const release = statements.find((statement) => statement.text.includes('UPDATE harness_shared.work_items'));
    expect(release?.text).toContain("gradingAudit'->'dispatchReservation'->>'key' = ?");
    expect(release?.text).toContain("gradingAudit'->'dispatchReservation'->>'reservedAt' = ?");
    expect(release?.values).toContain('2026-09-08T00:00:00.000Z');
  });

  describe('WI-10005273: an expired lease held by a live auditor is restored, never deleted', () => {
    const expiredLease = { key: 'grading-audit:EI-long-audit', reservedAt: '2026-10-02T03:20:18.000Z' };

    it('returns the expired pending lease this claim replaced, read under the row lock', async () => {
      const { statements } = transactionHarness({ claim: true, priorReservation: expiredLease });

      const result = await reservePendingGradingAudit('EI-long-audit', 'grading-audit:EI-long-audit', {
        workspaceId: 'ws-test',
        now: new Date('2026-10-02T03:40:00.000Z'),
      });

      expect(result).toEqual({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-long-audit', reservedAt: '2026-10-02T03:40:00.000Z' },
        prior: expiredLease,
      });
      const lockIndex = statements.findIndex((statement) => statement.text.includes('AS prior_reservation'));
      const claimIndex = statements.findIndex((statement) => statement.text.includes('RETURNING feature_id'));
      expect(lockIndex).toBeGreaterThanOrEqual(0);
      // The lease is read under the same row lock, BEFORE the claim overwrites it.
      expect(lockIndex).toBeLessThan(claimIndex);
      expect(statements[lockIndex]?.text).toContain('FOR UPDATE');
    });

    it('preserves the last lease when an earlier sweep already cleared the active reservation', async () => {
      const { statements } = transactionHarness({
        claim: true,
        priorReservation: null,
        priorLastReservation: expiredLease,
      });

      const result = await reservePendingGradingAudit('EI-long-audit', 'grading-audit:EI-long-audit', {
        workspaceId: 'ws-test',
        now: new Date('2026-10-02T03:40:00.000Z'),
      });

      expect(result).toEqual({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-long-audit', reservedAt: '2026-10-02T03:40:00.000Z' },
        prior: expiredLease,
      });
      const lock = statements.find((statement) => statement.text.includes('AS prior_reservation'));
      expect(lock?.text).toContain("'lastDispatchReservation' AS prior_last_reservation");
      expect(lock?.text).toContain('FOR UPDATE');
    });

    it('reports no prior for a fresh claim or for a settled card being reopened', async () => {
      transactionHarness({ claim: true, priorReservation: null });
      const fresh = await reservePendingGradingAudit('EI-fresh', 'grading-audit:EI-fresh', { workspaceId: 'ws-test' });
      expect(fresh.prior).toBeUndefined();

      // A settled card's leftover lease belongs to no live auditor of the reopened audit.
      transactionHarness({
        claim: true,
        priorState: 'failed',
        priorReservation: expiredLease,
        priorLastReservation: expiredLease,
      });
      const reopened = await reservePendingGradingAudit('EI-settled', 'grading-audit:EI-settled', {
        workspaceId: 'ws-test',
      });
      expect(reopened.prior).toBeUndefined();

      // A malformed lease is never echoed back as a restorable one.
      transactionHarness({ claim: true, priorReservation: { key: 'grading-audit:EI-bad' } });
      const malformed = await reservePendingGradingAudit('EI-bad', 'grading-audit:EI-bad', { workspaceId: 'ws-test' });
      expect(malformed.prior).toBeUndefined();

      // A malformed active reservation is not permission to resurrect an older epoch.
      transactionHarness({
        claim: true,
        priorReservation: { key: 'grading-audit:EI-bad' },
        priorLastReservation: expiredLease,
      });
      const malformedActive = await reservePendingGradingAudit('EI-bad', 'grading-audit:EI-bad', { workspaceId: 'ws-test' });
      expect(malformedActive.prior).toBeUndefined();
    });

    it('restores the supplied lease in the same compare-and-set release instead of deleting it', async () => {
      const { statements } = transactionHarness({ claim: false });

      await releasePendingGradingAudit('EI-long-audit', 'grading-audit:EI-long-audit', {
        workspaceId: 'ws-test',
        reservedAt: '2026-10-02T03:40:00.000Z',
        restore: expiredLease,
      });

      const release = statements.find((statement) => statement.text.includes('UPDATE harness_shared.work_items'));
      const restoreWrite = statements.find((statement) =>
        statement.text.includes("jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}'"),
      );
      // The restored lease is written back verbatim, and the reservation is never deleted.
      expect(restoreWrite?.values).toEqual([JSON.stringify(expiredLease), JSON.stringify(expiredLease)]);
      expect(
        statements.some((statement) =>
          statement.text.includes("payload #- '{observation,gradingAudit,dispatchReservation}'"),
        ),
      ).toBe(false);
      // Still a compare-and-set on THIS dispatcher's own epoch: a newer owner is never clobbered.
      expect(release?.text).toContain("gradingAudit'->'dispatchReservation'->>'key' = ?");
      expect(release?.text).toContain("gradingAudit'->'dispatchReservation'->>'reservedAt' = ?");
      expect(release?.values).toContain('2026-10-02T03:40:00.000Z');
    });

    it('restores the prior lease and records retry backoff in the same compare-and-set release', async () => {
      const { statements } = transactionHarness({ claim: false });
      const backoff = {
        until: '2026-10-12T02:02:10.272Z',
        source: 'retry-window' as const,
        code: 'generation_incompatible',
        recordedAt: '2026-10-12T01:47:09.741Z',
        reason: 'dispatcher build is older than the graded build',
      };

      const result = await releasePendingGradingAudit('EI-long-audit', 'grading-audit:EI-long-audit', {
        workspaceId: 'ws-test',
        reservedAt: '2026-10-12T01:47:09.741Z',
        restore: expiredLease,
        backoff,
      });

      expect(result).toBe(false);
      const payloadWrite = statements.find((statement) =>
        statement.text.includes("'{observation,gradingAudit,dispatchReservation}'") &&
        statement.text.includes("'{observation,gradingAudit,dispatchBackoff}'"),
      );
      const release = statements.find((statement) => statement.text.includes('UPDATE harness_shared.work_items'));
      expect(payloadWrite?.text).toContain("'{observation,gradingAudit,lastDispatchReservation}'");
      expect(payloadWrite?.text).not.toContain("payload #- '{observation,gradingAudit,dispatchReservation}'");
      expect(payloadWrite?.values).toEqual([
        JSON.stringify(expiredLease),
        JSON.stringify(expiredLease),
        JSON.stringify(backoff),
      ]);
      expect(release?.text).toContain("gradingAudit'->'dispatchReservation'->>'reservedAt' = ?");
      expect(release?.values).toContain('2026-10-12T01:47:09.741Z');
    });
  });

  it('does not report a live reservation for a retracted card from a stale candidate snapshot', async () => {
    const { statements } = transactionHarness({
      claim: false,
      currentState: 'pending',
      hasReservation: true,
      retracted: true,
    });

    const result = await reservePendingGradingAudit('EI-retracted', 'grading-audit:retracted', {
      workspaceId: 'ws-test',
    });

    expect(result).toEqual({ status: 'not-pending' });
    const claim = statements.find((statement) => statement.text.includes('RETURNING feature_id'));
    expect(claim?.text).toContain("payload->'observation'->'retracted' IS NULL");
    const current = statements.find((statement) => statement.text.includes('SELECT payload->'));
    expect(current?.text).toContain("payload->'observation'->'retracted' IS NOT NULL AS retracted");
  });

  it('executes the legacy identity reopen writer with the current rubric identity', async () => {
    const now = new Date('2026-09-09T15:00:00.000Z');
    const currentness: ScorecardGradingAuditCurrentness = {
      state: 'unknown',
      reason: 'recorded-identity-missing',
      recordedRevision: null,
      currentRevision: 6,
      recordedCriteriaHash: null,
      currentCriteriaHash: 'hash-current',
    };
    const { statements } = transactionHarness({ claim: true });

    const result = await reservePendingGradingAudit('EI-legacy-settled', 'grading-audit:legacy', {
      workspaceId: 'ws-test',
      now,
      currentness,
    });

    expect(result).toEqual({
      status: 'claimed',
      reservation: { key: 'grading-audit:legacy', reservedAt: now.toISOString() },
    });
    const reopen = statements.find((statement) => statement.text.includes("'{observation,gradingAudit}'"));
    const reopenedStamp = JSON.parse(
      String(reopen?.values.find((value) => typeof value === 'string' && value.includes('"state":"pending"'))),
    );
    expect(reopenedStamp).toEqual({
      state: 'pending',
      metaRubricRef: 'grading-integrity',
      rubricRevision: 6,
      criteriaHash: 'hash-current',
      stampedAt: now.toISOString(),
      dispatchReservation: { key: 'grading-audit:legacy', reservedAt: now.toISOString() },
      lastDispatchReservation: { key: 'grading-audit:legacy', reservedAt: now.toISOString() },
    });
  });

  it('does not enter the reopen writer when the live rubric identity is missing', async () => {
    const currentness: ScorecardGradingAuditCurrentness = {
      state: 'unknown',
      reason: 'live-identity-missing',
      recordedRevision: 5,
      currentRevision: null,
      recordedCriteriaHash: 'hash-recorded',
      currentCriteriaHash: null,
    };
    const { statements } = transactionHarness({ claim: false, currentState: 'failed' });

    const result = await reservePendingGradingAudit('EI-unreopenable', 'grading-audit:unreopenable', {
      workspaceId: 'ws-test',
      currentness,
    });

    expect(result).toEqual({ status: 'not-pending' });
    expect(statements.some((statement) => statement.text.includes("'{observation,gradingAudit}'"))).toBe(false);
  });

  // EI-22978598482930667: the reset-aware quota suppression lives on the card, so
  // the reservation gate is where it has to be enforced and retired.
  describe('reset-aware quota backoff', () => {
    const now = new Date('2026-09-11T16:00:00.000Z');
    const liveBackoff = {
      until: '2026-09-11T17:00:00.000Z',
      source: 'launcher-horizon' as const,
      code: 'model_quota_exhausted',
      recordedAt: '2026-09-11T16:00:00.000Z',
      reason: 'terminal model_quota_exhausted; suppressing re-dispatch until the launcher-horizon reset',
    };

    it('refuses the claim with quota-backoff, reported AHEAD of an existing reservation', async () => {
      // has_reservation is deliberately true: a caller told 'already-reserved'
      // would wait on a dispatcher that is not in fact running, so the live
      // quota wall must win the report.
      transactionHarness({
        claim: false,
        currentState: 'pending',
        hasReservation: true,
        backoff: liveBackoff,
      });

      const result = await reservePendingGradingAudit('EI-walled', 'grading-audit:walled', {
        workspaceId: 'ws-test',
        now,
        allowGenerationIncompatibleBackoff: true,
      });

      expect(result).toEqual({ status: 'quota-backoff', backoff: liveBackoff });
    });

    it('reports a live non-quota failure window as dispatch-backoff', async () => {
      const dispatchBackoff = {
        ...liveBackoff,
        source: 'retry-window' as const,
        code: 'dispatch_exception',
        reason: 'lineage unavailable',
      };
      transactionHarness({
        claim: false,
        currentState: 'pending',
        hasReservation: false,
        backoff: dispatchBackoff,
      });

      const result = await reservePendingGradingAudit('EI-route-failed', 'grading-audit:route-failed', {
        workspaceId: 'ws-test',
        now,
        allowGenerationIncompatibleBackoff: true,
      });

      expect(result).toEqual({ status: 'dispatch-backoff', backoff: dispatchBackoff });
    });

    it('lets a proven compatible dispatcher clear a live legacy generation-incompatible backoff', async () => {
      const generationBackoff = {
        ...liveBackoff,
        source: 'retry-window' as const,
        code: 'generation_incompatible',
        reason: 'an older dispatcher build failed ancestry validation',
      };
      const { statements } = transactionHarness({
        claim: true,
        currentState: 'pending',
        backoff: generationBackoff,
      });

      const result = await reservePendingGradingAudit('EI-recovered-generation', 'grading-audit:recovered-generation', {
        workspaceId: 'ws-test',
        now,
        allowGenerationIncompatibleBackoff: true,
      });

      expect(result).toMatchObject({ status: 'claimed' });
      const claim = statements.find((statement) => statement.text.includes('RETURNING feature_id'));
      expect(claim?.text).toContain("payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'code' = 'generation_incompatible'");
      expect(claim?.values).toContain(true);
      expect(claim?.text).toContain("#- '{observation,gradingAudit,dispatchBackoff}'");
    });

    it('does not refuse on a SPENT backoff — an elapsed stamp falls through to the ordinary verdict', async () => {
      transactionHarness({
        claim: false,
        currentState: 'pending',
        hasReservation: true,
        backoff: { ...liveBackoff, until: '2026-09-11T15:30:00.000Z' },
      });

      const result = await reservePendingGradingAudit('EI-recovered', 'grading-audit:recovered', {
        workspaceId: 'ws-test',
        now,
      });

      expect(result).toEqual({ status: 'already-reserved' });
    });

    it('gates the claim on the stamp and CLEARS it in the same winning UPDATE', async () => {
      const { statements } = transactionHarness({ claim: true });

      const result = await reservePendingGradingAudit('EI-legacy-settled', 'grading-audit:claim', {
        workspaceId: 'ws-test',
        now,
      });

      expect(result).toMatchObject({ status: 'claimed' });
      const claim = statements.find((statement) => statement.text.includes('RETURNING feature_id'));
      expect(claim).toBeDefined();
      // A claim only succeeds once the backoff has expired, so the winning
      // UPDATE is the right place to retire the spent stamp — leaving it would
      // make the next release's freshly-written backoff ambiguous.
      expect(claim?.text).toContain("#- '{observation,gradingAudit,dispatchBackoff}'");
      expect(claim?.text).toContain("payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'until' IS NULL");
      // Fail OPEN on an unparseable stamp, exactly like the reservation
      // predicate: a malformed value must never strand a card permanently.
      expect(claim?.text).toContain('ELSE TRUE');
    });
  });
});
