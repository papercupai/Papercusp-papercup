import { describe, expect, it } from 'vitest';
import {
  assertDurableParkReleaseContract,
  buildDurableParkReleaseContract,
  firedTriggerCannotCertify,
  parseEventInstantMs,
} from './durable-park-release-contract';
import {
  buildDurableParkEvidenceMatrix,
  buildDurableParkAuditReport,
  classifyAuditAge,
  classifyDurableParkReleaseLiveness,
  classifyUnparkCondition,
  durableParkFingerprint,
  planDurableParkClear,
  runWorkItemDurableParkAudit,
  type DurableParkAuditSourceRow,
} from './work-items-durable-park-audit';

const NOW_MS = Date.parse('2026-08-27T00:00:00.000Z');

function row(
  id: string,
  payload: Record<string, unknown>,
  overrides: Partial<DurableParkAuditSourceRow> = {},
): DurableParkAuditSourceRow {
  return {
    id,
    title: `title ${id}`,
    state: 'open',
    takenBy: null,
    takenAt: null,
    updatedAtMs: NOW_MS,
    payload,
    reviewRoutedAtMs: null,
    ...overrides,
  };
}

describe('durable park audit classification', () => {
  it('keeps the queue-control axes independent and leaves its source rows untouched', () => {
    const rows = [
      row(
        'WI-B',
        {
          _claimHold: true,
          claim_hold_by: 'su-parker',
          claim_hold_reason: 'UNPARK when dependency WI-1 is done',
          claim_hold_at: '2026-08-26T12:00:00.000Z',
          held_open_by: 'su-lease',
          held_open_reason: 'validation in progress',
          held_open_at: 'not-a-date',
          agentReview: {
            status: 'pending',
            submittedBy: 'su-reviewer',
            ledgerIdeaId: 'WI-B',
            round: 2,
            timing: { round: 2, enteredAt: new Date(NOW_MS - 25 * 60 * 60 * 1_000).toISOString() },
          },
        },
        {
          takenBy: 'su-active',
          takenAt: '2026-08-26T23:00:00.000Z',
          reviewRoutedAtMs: NOW_MS - 25 * 60 * 60 * 1_000,
        },
      ),
      row('WI-A', { _claimHold: true }),
      row('WI-C', {
        agentReview: {
          status: 'revision-requested',
          submittedBy: 'su-author',
          ledgerIdeaId: 'WI-C',
          round: 1,
        },
      }),
      row('WI-D', {
        _claimHold: true,
        claim_hold_by: 'su-parker-2',
      }),
    ];
    const before = structuredClone(rows);

    const report = buildDurableParkAuditReport({
      rows,
      runId: 'audit-run-1',
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      nowMs: NOW_MS,
      reviewOverdueHours: 24,
    });

    expect(rows).toEqual(before);
    expect(report).toMatchObject({
      schemaVersion: 'durable-park-audit-v2',
      reportOnly: true,
      modelCalled: false,
      population: {
        nonTerminal: 4,
        axes: {
          activeClaims: 1,
          rawClaimHolds: 3,
          holdOpenLeases: 1,
          durableParks: 2,
          pendingAgentReview: 1,
          revisionRequestedAgentReview: 1,
        },
      },
      parkAgeBuckets: {
        'under-1d': 1,
        '1-7d': 0,
        '7-30d': 0,
        '30d-plus': 0,
        unknown: 1,
      },
      unparkConditions: { stated: 1, missing: 1, unresolved: 0 },
      releaseConditionHealth: {
        statusCounts: {
          tracked: 0,
          unverified: 2,
          unreachable: 0,
          'satisfied-still-parked': 0,
        },
        findingCounts: {
          'condition-missing': 1,
          'condition-ambiguous': 0,
          'owner-missing': 2,
          'trigger-missing': 2,
          'reachability-unverified': 2,
          'evidence-missing': 2,
          'condition-unreachable': 0,
          'condition-satisfied-still-parked': 0,
        },
        flagged: 2,
      },
      missingMetadata: {
        unattributedClaimHolds: 1,
        parkReason: 1,
        parkTimestamp: 1,
        invalidParkTimestamp: 0,
        pendingReviewTimestamp: 0,
      },
    });
    expect(report.durableParks.map(({ id }) => id)).toEqual(['WI-B', 'WI-D']);
    expect(report.durableParks[0]?.releaseLiveness).toMatchObject({
      status: 'unverified',
      condition: 'UNPARK when dependency WI-1 is done',
      owner: null,
      trigger: null,
    });
    expect(report.holdOpenLeases).toEqual([
      expect.objectContaining({ id: 'WI-B', age: { status: 'invalid', ageMs: null, bucket: 'unknown' } }),
    ]);
    expect(report.reasons).toEqual([{ reason: 'UNPARK when dependency WI-1 is done', count: 1 }]);
    expect(report.overdueReviews.rows).toEqual([expect.objectContaining({ id: 'WI-B', ageMs: 25 * 60 * 60 * 1_000 })]);
  });

  it('uses only a matching current-round start for overdue review and leaves ambiguous legacy ages unknown', () => {
    const review = { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'WI-X', round: 2 };
    const rows = [
      row('WI-reset', { agentReview: { ...review, timing: { round: 2, enteredAt: new Date(NOW_MS - 1_000).toISOString() } } },
        { reviewRoutedAtMs: NOW_MS - 30 * 24 * 60 * 60 * 1_000 }),
      row('WI-legacy', { agentReview: review }, { reviewRoutedAtMs: NOW_MS - 30 * 24 * 60 * 60 * 1_000 }),
      row('WI-mismatch', { agentReview: { ...review, timing: { round: 1, enteredAt: '2026-07-01T00:00:00Z' } } }),
      row('WI-invalid', { agentReview: { ...review, timing: { round: 2, enteredAt: 'invalid' } } }),
      row('WI-overdue', { agentReview: { ...review, timing: { round: 2, enteredAt: '2026-08-25T00:00:00Z' } } }),
    ];
    const report = buildDurableParkAuditReport({ rows, runId: 'round-reset', workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', nowMs: NOW_MS });
    expect(report.overdueReviews.timestampBasis).toBe('agentReview.timing.enteredAt (matching round)');
    expect(report.overdueReviews.rows.map(x => x.id)).toEqual(['WI-overdue']);
    expect(report.missingMetadata.pendingReviewTimestamp).toBe(3);
    expect(report.population.axes.pendingAgentReview).toBe(5);
  });

  it('classifies age and condition text without treating vague prose as a release condition', () => {
    expect(classifyAuditAge('2026-07-20T00:00:00.000Z', NOW_MS)).toEqual({
      status: 'known',
      ageMs: 38 * 24 * 60 * 60 * 1_000,
      bucket: '30d-plus',
    });
    expect(classifyAuditAge('invalid', NOW_MS)).toEqual({
      status: 'invalid',
      ageMs: null,
      bucket: 'unknown',
    });
    expect(classifyUnparkCondition('waiting on a decision')).toEqual({
      status: 'unresolved',
      text: 'waiting on a decision',
    });
    expect(classifyUnparkCondition('Release after WI-1 is done')).toEqual({
      status: 'stated',
      text: 'Release after WI-1 is done',
    });
  });

  it('keeps an unmeasured or unregistered condition actionable even when metadata is complete', () => {
    const liveness = classifyDurableParkReleaseLiveness({ claim_hold_release: {
      condition: 'producer finishes', owner: 'park-owner', trigger: 'ubp:unregistered-condition',
      reachability: 'blocked', evidence: 'no producer registration or catalogued resolver was found',
    } }, 'resume when producer finishes');
    expect(liveness.status).toBe('unverified');
    expect(liveness.findings).toContain('reachability-unverified');
  });

  it('preserves unknown reachability as unverified and retains resolver diagnostics', () => {
    const evidence = 'event ledger resolver timed out';
    const liveness = classifyDurableParkReleaseLiveness({ claim_hold_release: {
      condition: 'dependency WI-1 reaches a terminal state', owner: 'plan:queue-cleanup',
      trigger: 'work-item:done:WI-1', reachability: 'unknown', evidence,
    } }, 'UNPARK when WI-1 is done');

    expect(liveness).toEqual({
      status: 'unverified',
      contractPresent: true,
      condition: 'dependency WI-1 reaches a terminal state',
      owner: 'plan:queue-cleanup',
      trigger: 'work-item:done:WI-1',
      reachability: 'unknown',
      evidence,
      findings: ['reachability-unverified'],
    });
  });

  it('accepts unknown reachability as a complete durable-park contract', () => {
    expect(() => assertDurableParkReleaseContract({
      condition: 'dependency WI-1 reaches a terminal state',
      owner: 'plan:queue-cleanup',
      trigger: 'work-item:done:WI-1',
      reachability: 'unknown',
      evidence: 'event ledger resolver timed out',
    })).not.toThrow();
  });

  it('reports a completed pause task as unverified resume authority even with a fired latch', async () => {
    const legacy = {
      condition: 'WI-10003058 reaches terminal done, ending this system-wide pause.',
      owner: 'pause-driver', trigger: 'work-item:done:WI-10003058',
      reachability: 'satisfied', evidence: 'the pause task is DONE/committed',
    };
    expect(classifyDurableParkReleaseLiveness({ claim_hold_release: legacy }, 'owner pause')).toMatchObject({
      status: 'unverified', reachability: 'blocked', findings: ['condition-ambiguous', 'reachability-unverified'],
      evidence: expect.stringContaining('explicit owner resume'),
    });
    expect(await buildDurableParkReleaseContract(legacy, 'parker')).toMatchObject({
      condition: legacy.condition, owner: 'pause-driver', trigger: legacy.trigger,
      reachability: 'blocked', evidence: expect.stringContaining('explicit owner resume'),
    });
  });

  it('requires reachable typed ownership and re-evaluation evidence for a healthy retained park', () => {
    expect(
      classifyDurableParkReleaseLiveness(
        {
          claim_hold_release: {
            condition: 'dependency WI-1 reaches a terminal state',
            owner: 'plan:queue-cleanup',
            trigger: 'work-item:done:WI-1',
            reachability: 'reachable',
            evidence: 'WI-1 is open, owned, and its completion event is registered',
          },
        },
        'UNPARK when WI-1 is done',
      ),
    ).toEqual({
      status: 'tracked',
      contractPresent: true,
      condition: 'dependency WI-1 reaches a terminal state',
      owner: 'plan:queue-cleanup',
      trigger: 'work-item:done:WI-1',
      reachability: 'reachable',
      evidence: 'WI-1 is open, owned, and its completion event is registered',
      findings: [],
    });

    expect(
      classifyDurableParkReleaseLiveness(
        {
          claim_hold_release: {
            condition: 'retired external service returns',
            owner: 'system:queue-audit',
            trigger: 'daily durable-park audit',
            reachability: 'unreachable',
            evidence: 'the service was permanently retired',
          },
        },
        'Release when the service returns',
      ),
    ).toMatchObject({
      status: 'unreachable',
      findings: ['condition-unreachable'],
    });

    expect(
      classifyDurableParkReleaseLiveness(
        {
          claim_hold_release: {
            condition: 'dependency WI-1 reaches a terminal state',
            owner: 'plan:queue-cleanup',
            trigger: 'work-item:done:WI-1',
            reachability: 'satisfied',
            evidence: 'WI-1 is done',
          },
        },
        'UNPARK when WI-1 is done',
      ),
    ).toMatchObject({
      status: 'satisfied-still-parked',
      findings: ['condition-satisfied-still-parked'],
    });
  });

  // SPEC-BQL-P-004-WAKE: a generic wake is never condition proof. Pre-guard parkers stamped
  // 'satisfied' from any fired latch (measured 2026-10-10: 37 coord:inbox-wake parks), and the
  // stamp is never refreshed, so the audit must not turn it into a "reconcile now" finding.
  it.each([
    'coord:inbox-wake:su-parker',
    'work-item:claimable',
    'release:deployed',
    'release:green:papercusp',
    'plan:acceptance:some-plan-2026-10-01',
  ])('downgrades a stored satisfied stamp from broad trigger %s to unverified', (trigger) => {
    const liveness = classifyDurableParkReleaseLiveness({ claim_hold_release: {
      condition: 'the fleet leader routes this item back with new evidence',
      owner: 'su-parker', trigger, reachability: 'satisfied',
      evidence: 'event fired at 2026-10-08 17:32:01-04',
    } }, 'parked pending leader route');
    expect(liveness).toMatchObject({ status: 'unverified', reachability: 'blocked' });
    expect(liveness.findings).toContain('reachability-unverified');
    expect(liveness.findings).not.toContain('condition-satisfied-still-parked');
    expect(liveness.evidence).toContain('broad trigger');
  });

  // event-wait-settlement-2026-10-20 P-001: a change notification about ANOTHER subject names
  // that subject, so it passed the old subject-only guard; its fire still proves nothing.
  it.each(['work-item:status:WI-dep', 'work-item:claimed:WI-dep', 'work-item:unblocked:WI-dep', 'claim:released:WI-dep'])(
    'downgrades a stored satisfied stamp from change-notification trigger %s to unverified',
    (trigger) => {
      const liveness = classifyDurableParkReleaseLiveness({ claim_hold_release: {
        condition: 'WI-dep reaches a terminal state', owner: 'su-parker', trigger,
        reachability: 'satisfied', evidence: 'fired',
      } }, 'parked pending WI-dep');
      expect(liveness).toMatchObject({ status: 'unverified', reachability: 'blocked' });
      expect(liveness.findings).not.toContain('condition-satisfied-still-parked');
      expect(liveness.evidence).toContain('change-notification trigger');
    },
  );

  it('keeps a stored satisfied stamp on a subject-bound trigger or a non-catalogue declared gate', () => {
    for (const trigger of ['work-item:done:WI-1', 'my-declared-gate:abc']) {
      expect(classifyDurableParkReleaseLiveness({ claim_hold_release: {
        condition: 'dependency reaches a terminal state', owner: 'plan:queue-cleanup',
        trigger, reachability: 'satisfied', evidence: 'fired',
      } }, 'UNPARK when done')).toMatchObject({ status: 'satisfied-still-parked' });
    }
  });

  // EI-25664119449929994: measured 2026-10-11 on :3170 — all 9 live satisfied-still-parked
  // stamps cited a latch that fired BEFORE the park (e.g. EI-24937591709395249: fired
  // 2026-10-10 13:12:21-04, parked 2026-10-11T06:18:49Z), and 5 were work-item:status:<own id>.
  const storedFire = (trigger: string, firedAt: string, parkedAt: string) => ({
    claim_hold_at: parkedAt,
    claim_hold_release: {
      condition: 'a new failure receipt is recorded and the item transitions to failing',
      owner: 'su-parker', trigger, reachability: 'satisfied', evidence: `event fired at ${firedAt}`,
    },
  });

  it('downgrades a stored satisfied stamp whose cited fire predates the park', () => {
    const liveness = classifyDurableParkReleaseLiveness(
      storedFire('work-item:done:EI-dep', '2026-10-10 13:12:21.494399-04', '2026-10-11T06:18:49.823Z'),
      'parked until EI-dep is done', 'EI-parked',
    );
    expect(liveness).toMatchObject({ status: 'unverified', reachability: 'blocked' });
    expect(liveness.findings).toContain('reachability-unverified');
    expect(liveness.findings).not.toContain('condition-satisfied-still-parked');
    expect(liveness.evidence).toContain('before this park');
  });

  it('keeps a stored satisfied stamp whose cited fire postdates the park', () => {
    expect(classifyDurableParkReleaseLiveness(
      storedFire('work-item:done:EI-dep', '2026-10-11 07:00:00.5+00', '2026-10-11T06:18:49.823Z'),
      'parked until EI-dep is done', 'EI-parked',
    )).toMatchObject({ status: 'satisfied-still-parked', reachability: 'satisfied' });
  });

  // event-wait-settlement-2026-10-20 P-001 supersedes the "but not another item's" half this
  // case used to pin: work-item:status is a change notification for EVERY subject, so a fire
  // after the park proves nothing about the parked item or about another one.
  it.each(['work-item:status:EI-parked', 'work-item:status:EI-other'])(
    'downgrades a generic status event %s even when it fired after the park',
    (trigger) => {
      const liveness = classifyDurableParkReleaseLiveness(
        storedFire(trigger, '2026-10-11 07:00:00+00', '2026-10-11T06:18:49.823Z'),
        'parked pending a new failure', 'EI-parked',
      );
      expect(liveness).toMatchObject({ status: 'unverified', reachability: 'blocked' });
      expect(liveness.evidence).toContain('change-notification trigger');
    },
  );

  it('orders ledger fire times by their explicit offset and never guesses a zone', () => {
    expect(parseEventInstantMs('2026-10-10 13:12:21.494399-04')).toBe(Date.parse('2026-10-10T17:12:21.494Z'));
    expect(parseEventInstantMs('2026-10-10 22:42:21+05:30')).toBe(Date.parse('2026-10-10T17:12:21Z'));
    expect(parseEventInstantMs('2026-10-10T17:12:21.494Z')).toBe(Date.parse('2026-10-10T17:12:21.494Z'));
    expect(parseEventInstantMs('2026-10-10 13:12:21')).toBeNull();
    // Legacy evidence from a postgres.js Date rendered via Date.toString() (measured in the
    // real-PG claim-hold suite, 2026-10-11).
    expect(parseEventInstantMs('Sun Oct 11 2026 07:22:44 GMT-0400 (Eastern Daylight Time)'))
      .toBe(Date.parse('2026-10-11T11:22:44Z'));
    expect(firedTriggerCannotCertify({
      trigger: 'work-item:done:EI-dep', firedAt: 'yesterday', parkedAtMs: Date.parse('2026-10-11T06:18:49Z'),
    })).toContain('unreadable time');
    expect(firedTriggerCannotCertify({
      trigger: 'work-item:done:EI-dep', firedAt: '2026-10-10 13:12:21-04', parkedAtMs: null,
    })).toBeNull();
  });

  // SPEC-BQL-P-004-CLEARER: a park released only by its OWN work-item:done can never release
  // (measured 2026-10-10: four live parks, every one stamped 'reachable' by the catalogue).
  const selfReleaseContract = (reachability: string) => ({ claim_hold_release: {
    condition: 'the reserved owner completes this item', owner: 'su-owner',
    trigger: 'work-item:done:EI-self', reachability, evidence: 'catalogue live resolver',
  } });

  it('flags a self-release trigger as unverified even when stamped reachable, only on the park that carries it', () => {
    const self = classifyDurableParkReleaseLiveness(selfReleaseContract('reachable'), 'reserved for su-owner', 'EI-self');
    expect(self).toMatchObject({ status: 'unverified', reachability: 'blocked' });
    expect(self.findings).toContain('reachability-unverified');
    expect(self.evidence).toContain("parked item's own terminal event");
    // The same key on a DIFFERENT park is an ordinary dependency; the legacy two-argument call is unchanged.
    expect(classifyDurableParkReleaseLiveness(selfReleaseContract('reachable'), 'waits on EI-self', 'EI-other'))
      .toMatchObject({ status: 'tracked', reachability: 'reachable' });
    expect(classifyDurableParkReleaseLiveness(selfReleaseContract('reachable'), 'waits on EI-self'))
      .toMatchObject({ status: 'tracked' });
  });

  it('the audit report flags a self-release park through its row id', () => {
    const report = buildDurableParkAuditReport({
      rows: ['EI-self', 'EI-other'].map((id) => ({
        id, title: id, state: 'open', takenBy: null, takenAt: null, updatedAtMs: null, reviewRoutedAtMs: null,
        payload: { _claimHold: true, claim_hold_by: 'su-parker', claim_hold_reason: 'reserved for su-owner',
          claim_hold_at: '2026-10-01T00:00:00.000Z', ...selfReleaseContract('reachable') },
      })),
      runId: 'self-release', workspaceId: 'ws', harnessSlug: 'h', nowMs: Date.parse('2026-10-10T00:00:00.000Z'),
    });
    const byId = new Map(report.durableParks.map((park) => [park.id, park.releaseLiveness.status]));
    expect(byId.get('EI-self')).toBe('unverified');
    expect(byId.get('EI-other')).toBe('tracked');
  });

  it('the shared contract writer stamps a self-release trigger blocked before any event read', async () => {
    const input = { condition: 'the reserved owner completes this item', trigger: 'work-item:done:EI-self' };
    const stamped = await buildDurableParkReleaseContract({ ...input, parkId: 'EI-self' }, 'parker');
    expect(stamped).toMatchObject({ trigger: 'work-item:done:EI-self', owner: 'parker', reachability: 'blocked' });
    expect(stamped.evidence).toContain("parked item's own terminal event");
  });
});

describe('durable park evidence matrix and reconciliation CAS', () => {
  const parkedPayload = {
    _claimHold: true,
    claim_hold_by: 'su-parker',
    claim_hold_reason: 'UNPARK when WI-1 is done',
    claim_hold_at: '2026-08-26T12:00:00.000Z',
    keepMe: { nested: true },
  };

  it('persists every raw hold on independent axes with a deterministic control fingerprint', () => {
    const source = [
      row('WI-park', parkedPayload),
      row('WI-lease', {
        _claimHold: true,
        held_open_by: 'su-holder',
        held_open_reason: 'live validation',
        held_open_at: '2026-08-26T13:00:00.000Z',
      }),
      row(
        'WI-both',
        {
          ...parkedPayload,
          held_open_by: 'su-holder',
          held_open_reason: 'live validation',
          held_open_at: '2026-08-26T13:00:00.000Z',
        },
        { takenBy: 'su-worker' },
      ),
      row('WI-visible', {}),
    ];
    const matrix = buildDurableParkEvidenceMatrix({
      rows: source,
      runId: 'matrix-1',
      workspaceId: 'ws',
      harnessSlug: 'h',
      nowMs: NOW_MS,
    });

    expect(matrix.population).toEqual({
      rawClaimHolds: 3,
      durableParks: 2,
      holdOpenLeases: 2,
      leaseAndPark: 1,
      assigned: 1,
    });
    expect(matrix.rows.map(({ id }) => id)).toEqual(['WI-both', 'WI-lease', 'WI-park']);
    expect(matrix.rows.every((entry) => /^[0-9a-f]{64}$/.test(entry.parkFingerprint))).toBe(true);
    expect(matrix.rows.find((entry) => entry.id === 'WI-park')?.sourcePayload).toEqual(parkedPayload);
  });

  it('clears only durable-park provenance and preserves a coexisting lease plus unrelated payload', () => {
    const payload = {
      ...parkedPayload,
      held_open_by: 'su-holder',
      held_open_reason: 'live validation',
      held_open_at: '2026-08-26T13:00:00.000Z',
    };
    const expectedParkFingerprint = durableParkFingerprint({ state: 'open', takenBy: null, payload });
    const plan = planDurableParkClear(
      { id: 'WI-both', state: 'open', takenBy: null, payload },
      {
        id: 'WI-both',
        expectedParkFingerprint,
        reasonCode: 'condition-satisfied',
        evidence: 'WI-1 is terminal',
      },
    );

    expect(plan).toMatchObject({ outcome: 'cleared', preservedLease: true, takenBy: null });
    expect(plan.nextPayload).toEqual({
      _claimHold: true,
      held_open_by: 'su-holder',
      held_open_reason: 'live validation',
      held_open_at: '2026-08-26T13:00:00.000Z',
      keepMe: { nested: true },
    });
  });

  it('removes the raw hold without a lease and refuses assigned, stale, or replayed rows', () => {
    const expectedParkFingerprint = durableParkFingerprint({
      state: 'open',
      takenBy: null,
      payload: parkedPayload,
    });
    const decision = {
      id: 'WI-park',
      expectedParkFingerprint,
      reasonCode: 'operator-directed' as const,
      evidence: 'explicit audited operator disposition',
    };
    expect(
      planDurableParkClear({ id: 'WI-park', state: 'open', takenBy: null, payload: parkedPayload }, decision),
    ).toMatchObject({ outcome: 'cleared', nextPayload: { keepMe: { nested: true } } });
    expect(
      planDurableParkClear({ id: 'WI-park', state: 'open', takenBy: 'su-worker', payload: parkedPayload }, decision)
        .outcome,
    ).toBe('assigned');
    expect(
      planDurableParkClear({ id: 'WI-park', state: 'blocked', takenBy: null, payload: parkedPayload }, decision)
        .outcome,
    ).toBe('stale-fingerprint');
    expect(
      planDurableParkClear({ id: 'WI-park', state: 'open', takenBy: null, payload: { keepMe: true } }, decision)
        .outcome,
    ).toBe('already-cleared');
  });

  it('retains a pause on its task-completion evidence but permits an explicit audited owner disposition', () => {
    const payload = { ...parkedPayload, claim_hold_release: {
      condition: 'WI-10003058 reaches terminal done, ending this system-wide pause.',
      owner: 'pause-driver', trigger: 'work-item:done:WI-10003058',
      reachability: 'satisfied', evidence: 'the pause task completed',
    } };
    const current = { id: 'WI-pause', state: 'open', takenBy: null, payload };
    const decision = { id: current.id, expectedParkFingerprint: durableParkFingerprint(current),
      reasonCode: 'condition-satisfied' as const, evidence: 'the pause task completed' };
    expect(planDurableParkClear(current, decision)).toMatchObject({ outcome: 'unverified-condition', nextPayload: null });
    expect(current.payload).toEqual(payload);
    expect(planDurableParkClear(current, { ...decision, reasonCode: 'operator-directed',
      evidence: 'verified owner resume for this exact pause, recorded separately' })).toMatchObject({
      outcome: 'cleared', nextPayload: { keepMe: { nested: true } },
    });
  });

  it.each(['condition', 'owner', 'trigger'])('refuses stale clearing after the release contract %s changes', (field) => {
    const release = { condition: 'WI-1 completes', owner: 'condition-owner',
      trigger: 'work-item:done:WI-1', reachability: 'reachable', evidence: 'specific resolver' };
    const payload = { ...parkedPayload, claim_hold_release: release };
    const expectedParkFingerprint = durableParkFingerprint({ state: 'open', takenBy: null, payload });
    const changed = { ...payload, claim_hold_release: { ...release, [field]: 'new unsatisfied condition' } };
    const plan = planDurableParkClear({ id: 'WI-park', state: 'open', takenBy: null, payload: changed }, {
      id: 'WI-park', expectedParkFingerprint, reasonCode: 'condition-satisfied', evidence: 'WI-1 completed',
    });
    expect(plan.outcome).toBe('stale-fingerprint');
    expect(plan.nextPayload).toBeNull();
  });

  it('keeps live condition observations out of the semantic control fingerprint', () => {
    const release = { condition: 'WI-1 completes', owner: 'condition-owner',
      trigger: 'work-item:done:WI-1', reachability: 'reachable', evidence: 'specific resolver' };
    const payload = { ...parkedPayload, claim_hold_release: release };
    const refreshed = { ...payload, claim_hold_release: { ...release,
      reachability: 'satisfied', evidence: 'specific event fired now' } };
    expect(durableParkFingerprint({ state: 'open', takenBy: null, payload })).toBe(
      durableParkFingerprint({ state: 'open', takenBy: null, payload: refreshed }),
    );
  });

  it('does not invalidate a park fingerprint for unrelated payload churn', () => {
    expect(durableParkFingerprint({ state: 'open', takenBy: null, payload: parkedPayload })).toBe(
      durableParkFingerprint({ state: 'open', takenBy: null, payload: { ...parkedPayload, checkpointMirror: 'new' } }),
    );
  });
});

/**
 * P-022 names "replay idempotency" as a completion requirement for putting this audit on a
 * recurring cadence. It matters more once scheduled than it did on-demand: a routine whose
 * tick is retried (catchup, a redelivered workflow, a manual re-fire of the same runId) must
 * hand back the run it already recorded rather than re-scanning the corpus and overwriting
 * the ledger row a reader may already be citing.
 *
 * The mock counts SQL round-trips rather than inspecting the returned report, because the
 * property under test is that the replay costs ONE lookup and stops — a version that
 * re-scanned and happened to produce an equal report would satisfy an equality assertion
 * while failing the actual requirement.
 */
function scriptedSql(responses: unknown[][]) {
  const calls: string[] = [];
  const values: unknown[][] = [];
  let i = 0;
  const sql = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(strings.join('?').replace(/\s+/g, ' ').trim().slice(0, 40));
    values.push(vals);
    return Promise.resolve(responses[i++] ?? []);
  };
  return { sql: sql as never, calls, values };
}

function cachedDetail(schemaVersion: string) {
  return {
    status: 'complete',
    mode: 'durable-park-audit',
    reportOnly: true,
    report: { schemaVersion, population: { axes: { durableParks: 7 } }, marker: 'cached-report' },
  };
}

describe('runWorkItemDurableParkAudit — replay idempotency (P-022 scheduled cadence)', () => {
  it('returns the recorded run on replay after exactly one lookup, re-scanning nothing', async () => {
    const { sql, calls } = scriptedSql([[{ detail: cachedDetail('durable-park-audit-v2') }]]);

    const report = await runWorkItemDurableParkAudit({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      runId: 'replayed-run',
      sql,
      artifactPath: false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('SELECT detail');
    expect((report as unknown as { marker?: string }).marker).toBe('cached-report');
  });

  it('CONTROL: a stale-schema recorded run is NOT replayed — it re-runs and rewrites', async () => {
    // Calibration for the assertion above. Without this, an early return that fired for ANY
    // recorded detail would pass the replay test while silently serving a v1 report whose
    // shape the current readers no longer understand. The schemaVersion check must be
    // load-bearing, so the v1 case has to take the full insert/scan/update path.
    const { sql, calls, values } = scriptedSql([[{ detail: cachedDetail('durable-park-audit-v1') }], [], [], []]);

    const report = await runWorkItemDurableParkAudit({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      runId: 'stale-run',
      sql,
      artifactPath: false,
    });

    expect(calls.length).toBeGreaterThan(1);
    expect((report as unknown as { marker?: string }).marker).toBeUndefined();
    expect(report.schemaVersion).toBe('durable-park-audit-v2');
    const writtenDetail = values
      .flat()
      .filter((value): value is string => typeof value === 'string' && value.includes('"mode":"durable-park-audit"'))
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((detail) => detail.status === 'complete');
    expect(writtenDetail?.outcome).toMatchObject({
      unit: 'snapshots',
      attempted: 1,
      successful: 1,
      uniqueRowsChanged: 0,
    });
  });
});
