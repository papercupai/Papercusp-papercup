/**
 * Declared-gate recovery contract — plan declared-gate-recovery-contract-2026-09-21.
 *
 * One test per taxonomy branch (R-001), per next-verb (R-003), per race/terminal
 * generation, per unavailable probe (fail-open), plus the action bridge's
 * idempotence (R-004), its generation CAS, and its evidence record (R-005). The
 * no-timeout-success invariant (R-002) is asserted both per branch and as a
 * totality sweep over the whole input grid.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ACTIONABLE_CLASSIFICATIONS,
  DECLARED_GATE_CLASSIFICATIONS,
  applyDeclaredGateRecovery,
  declaredGateRecoveryKey,
  declaredGateRecoverySummary,
  evaluateDeclaredGateGeneration,
  type DeclaredGateAnnouncement,
  type DeclaredGateClassifiedResult,
  type DeclaredGateEvidenceInput,
  type DeclaredGateRecoveryDeps,
  type DeclaredGateRecoveryResult,
} from './declared-gate-recovery';
import type { ProducerHealthCertificate, ProducerHealthObservation } from './verified-wait';

const NOW = 1_800_000_000_000;

function announcement(over: Partial<DeclaredGateAnnouncement> = {}): DeclaredGateAnnouncement {
  return {
    id: 42,
    eventKey: 'gate:release:candidate-abc',
    generation: 3,
    state: 'declared',
    declaredBy: 'su-declarer',
    firedAt: null,
    firedReason: null,
    expectedCondition: null,
    expectedVerdict: 'not-declared',
    ...over,
  };
}

function certificate(over: Partial<ProducerHealthCertificate> = {}): ProducerHealthCertificate {
  return {
    version: 1,
    producer: { kind: 'green-checkpoint', id: 'run-7' },
    owner: { ownerId: 'su-declarer', workItemId: 'WI-900' },
    issuedAtMs: NOW - 60 * 60_000,
    lastProgressAtMs: NOW - 60 * 60_000,
    lastFireAtMs: null,
    expectedCadenceMs: 10 * 60_000,
    verificationDeadlineMs: NOW - 60_000,
    ...over,
  };
}

function observation(over: Partial<ProducerHealthObservation> = {}): ProducerHealthObservation {
  return {
    checkedAtMs: NOW,
    producerPresent: true,
    lastProgressAtMs: NOW - 60 * 60_000,
    lastFireAtMs: null,
    completedAtMs: null,
    ...over,
  };
}

type Over = Partial<Omit<DeclaredGateEvidenceInput, 'announcement'>> & { announcement?: Partial<DeclaredGateAnnouncement> };

function input(over: Over = {}): DeclaredGateEvidenceInput {
  const { announcement: a, ...rest } = over;
  return {
    announcement: announcement(a),
    currentGeneration: 3,
    catalog: { status: 'measured', value: { member: false, nearMiss: [] } },
    fireHistory: {
      status: 'measured',
      value: { exactFired: false, familyFires: 0, priorGenerationFired: false, lastFiredAt: null },
    },
    ownership: { status: 'measured', value: { declaredByLiveness: 'ended', liveSuccessorIds: [] } },
    producer: null,
    checkedAtMs: NOW,
    ...rest,
  };
}

const liveDeclarer = { status: 'measured', value: { declaredByLiveness: 'live', liveSuccessorIds: [] } } as const;

function classified(result: DeclaredGateRecoveryResult): DeclaredGateClassifiedResult {
  expect(result.status).toBe('classified');
  return result as DeclaredGateClassifiedResult;
}

describe('evaluateDeclaredGateGeneration — taxonomy (R-001) and exact next verbs (R-003)', () => {
  it('never-fireable: no catalog family, no exact/sibling fire, no live emitter duty → cancel this generation, then emit', () => {
    const r = classified(evaluateDeclaredGateGeneration(input()));
    expect(r.classification).toBe('never-fireable');
    // R-005: no live owner → the durable advisory condition item is the explicit
    // escalation target (never null for an acting class).
    expect(r.escalationTarget).toEqual({ kind: 'steward-work-item', ref: 'declared-gate-recovery:42:3:never-fireable' });
    expect(r.escalationTarget?.ref).toBe(r.idempotenceKey);
    expect(r.nextVerb).toEqual({
      verb: 'events:cancel',
      args: { announcement_id: 42, expected_generation: 3 },
      target: { kind: 'declarer', ref: 'su-declarer' },
      then: [
        { verb: 'events:emit', args: { event: 'gate:release:candidate-abc', announce: true }, target: { kind: 'declarer', ref: 'su-declarer' } },
      ],
    });
  });

  it('never-fireable with a catalog near-miss re-awaits the CORRECTED exact key after the cancel', () => {
    const r = classified(
      evaluateDeclaredGateGeneration(
        input({ catalog: { status: 'measured', value: { member: false, nearMiss: ['release:green:papercusp'] } } }),
      ),
    );
    expect(r.classification).toBe('never-fireable');
    expect(r.nextVerb.verb).toBe('events:cancel');
    expect(r.nextVerb.then).toEqual([
      { verb: 'events:await', args: { event: 'release:green:papercusp', on_timeout: 'wake' }, target: { kind: 'waiter', ref: null } },
    ]);
  });

  it.each([
    ['catalog membership', { catalog: { status: 'measured', value: { member: true, nearMiss: [] } } }],
    ['the exact fire latch', { fireHistory: { status: 'measured', value: { exactFired: true, familyFires: 1, priorGenerationFired: false, lastFiredAt: 'x' } } }],
    ['a sibling family fire', { fireHistory: { status: 'measured', value: { exactFired: false, familyFires: 4, priorGenerationFired: false, lastFiredAt: 'x' } } }],
    ['an earlier fired generation', { fireHistory: { status: 'measured', value: { exactFired: false, familyFires: 0, priorGenerationFired: true, lastFiredAt: null } } }],
  ] as const)('missed-emitter when the key is fireable by %s but its owner is gone', (_why, over) => {
    const r = classified(evaluateDeclaredGateGeneration(input(over as Over)));
    expect(r.classification).toBe('missed-emitter');
    // No live owner, no repair item: the steward condition item IS the escalation.
    expect(r.escalationTarget).toEqual({ kind: 'steward-work-item', ref: 'declared-gate-recovery:42:3:missed-emitter' });
    expect(r.nextVerb).toEqual({ verb: 'scheduler:get_next', args: {}, target: r.escalationTarget });
  });

  it('missed-emitter with an existing producer repair item messages its audience, then claims it', () => {
    const r = classified(
      evaluateDeclaredGateGeneration(
        input({
          catalog: { status: 'measured', value: { member: true, nearMiss: [] } },
          producer: { status: 'measured', value: { certificate: certificate(), observation: observation() } },
        }),
      ),
    );
    expect(r.classification).toBe('missed-emitter');
    expect(r.escalationTarget).toEqual({ kind: 'producer-work-item', ref: 'WI-900' });
    expect(r.nextVerb.verb).toBe('coord:send');
    expect(r.nextVerb.args.to).toEqual(['@object:work-item:WI-900']);
    expect(r.nextVerb.then).toEqual([{ verb: 'work_items:claim', args: { id: 'WI-900' }, target: r.escalationTarget }]);
  });

  it('stalled-producer: live declarer + stale producer → one required wake to the declarer, then the existing takeover claim', () => {
    const r = classified(
      evaluateDeclaredGateGeneration(
        input({ ownership: liveDeclarer, producer: { status: 'measured', value: { certificate: certificate(), observation: observation() } } }),
      ),
    );
    expect(r.classification).toBe('stalled-producer');
    expect(r.escalationTarget).toEqual({ kind: 'live-declarer', ref: 'su-declarer' });
    expect(r.nextVerb.verb).toBe('coord:send');
    expect(r.nextVerb.args).toMatchObject({ to: ['su-declarer'], wake: 'required', expects: 'action' });
    expect(r.nextVerb.then).toEqual([
      { verb: 'work_items:claim', args: { id: 'WI-900' }, target: { kind: 'producer-work-item', ref: 'WI-900' } },
    ]);
  });

  it('stalled-producer also covers an ABSENT producer record', () => {
    const r = classified(
      evaluateDeclaredGateGeneration(
        input({
          ownership: liveDeclarer,
          producer: { status: 'measured', value: { certificate: certificate(), observation: observation({ producerPresent: false }) } },
        }),
      ),
    );
    expect(r.classification).toBe('stalled-producer');
  });

  it('stale-owner successor resolution: an ended declarer with a live durable successor escalates to the SUCCESSOR, never the dead id', () => {
    const r = classified(
      evaluateDeclaredGateGeneration(
        input({
          ownership: { status: 'measured', value: { declaredByLiveness: 'ended', liveSuccessorIds: ['su-successor'] } },
          producer: { status: 'measured', value: { certificate: certificate(), observation: observation() } },
        }),
      ),
    );
    expect(r.classification).toBe('stalled-producer');
    expect(r.escalationTarget).toEqual({ kind: 'live-successor', ref: 'su-successor' });
    expect(r.nextVerb.args.to).toEqual(['su-successor']);
  });

  it('a live successor is never classified missed-emitter or never-fireable even for an uncatalogued, never-fired key', () => {
    const r = classified(
      evaluateDeclaredGateGeneration(
        input({ ownership: { status: 'measured', value: { declaredByLiveness: 'ended', liveSuccessorIds: ['su-successor'] } } }),
      ),
    );
    expect(r.classification).toBe('unknown');
  });

  it.each([
    ['progressing', observation({ lastProgressAtMs: NOW - 60_000 })],
    ['expected-idle', observation({ state: 'paused' })],
    ['unknown', observation({ state: 'unknown' })],
  ] as const)('%s → the waiter re-awaits the exact returned key pinned to its generation', (expected, obs) => {
    const r = classified(
      evaluateDeclaredGateGeneration(
        input({ ownership: liveDeclarer, producer: { status: 'measured', value: { certificate: certificate(), observation: obs } } }),
      ),
    );
    expect(r.classification).toBe(expected);
    expect(r.escalationTarget).toBeNull();
    expect(r.nextVerb).toEqual({
      verb: 'events:await',
      args: { event: 'gate:release:candidate-abc', after_generation: 3, on_timeout: 'wake' },
      target: { kind: 'waiter', ref: null },
    });
  });

  it('already-complete ONLY from the exact generation’s own event fire → resume from events:status', () => {
    const r = classified(
      evaluateDeclaredGateGeneration(input({ announcement: { state: 'fired', firedReason: 'event', firedAt: 't', expectedVerdict: 'matched' } })),
    );
    expect(r.classification).toBe('already-complete');
    expect(r.nextVerb).toEqual({
      verb: 'events:status',
      args: { event: 'gate:release:candidate-abc', after_generation: 3 },
      target: { kind: 'waiter', ref: null },
    });
  });
});

describe('no timeout-to-success conversion (R-002)', () => {
  it('a producer that REPORTS completion without the exact key firing is unknown, not already-complete', () => {
    const r = classified(
      evaluateDeclaredGateGeneration(
        input({
          ownership: liveDeclarer,
          producer: { status: 'measured', value: { certificate: certificate(), observation: observation({ completedAtMs: NOW - 1000 }) } },
        }),
      ),
    );
    expect(r.classification).toBe('unknown');
    expect(r.nextVerb.verb).toBe('events:await');
    expect(r.evidence.reasons.join(' ')).toMatch(/not success/);
  });

  it.each(['mismatched', 'invalid'] as const)('an exact fire whose expected condition is %s is inactive, never success', (verdict) => {
    const r = evaluateDeclaredGateGeneration(
      input({ announcement: { state: 'fired', firedReason: 'event', firedAt: 't', expectedCondition: { kind: 'sha', sha: 'abc' }, expectedVerdict: verdict } }),
    );
    expect(r.status).toBe('inactive');
    expect(r.status === 'inactive' && r.reason).toBe('fired-expected-mismatch');
  });

  it('a generation closed by a non-event reason (expiry sweep) is inactive, never success', () => {
    const r = evaluateDeclaredGateGeneration(input({ announcement: { state: 'fired', firedReason: 'timeout', firedAt: 't' } }));
    expect(r.status).toBe('inactive');
  });

  it('TOTALITY: across the whole input grid, already-complete appears only with an exact event fire and matching expectation', () => {
    const states = ['declared', 'fired', 'cancelled', 'expired', 'superseded'] as const;
    const reasons = [null, 'event', 'timeout', 'expired'] as const;
    const verdicts = ['not-declared', 'pending', 'matched', 'mismatched', 'invalid'] as const;
    const owners = [
      { status: 'unavailable', reason: 'x' },
      { status: 'measured', value: { declaredByLiveness: null, liveSuccessorIds: [] } },
      { status: 'measured', value: { declaredByLiveness: 'ended', liveSuccessorIds: [] } },
      { status: 'measured', value: { declaredByLiveness: 'live', liveSuccessorIds: [] } },
      { status: 'measured', value: { declaredByLiveness: 'ended', liveSuccessorIds: ['su-s'] } },
    ] as const;
    const producers = [
      null,
      { status: 'unavailable', reason: 'x' },
      { status: 'measured', value: { certificate: certificate(), observation: observation({ completedAtMs: NOW, lastFireAtMs: NOW }) } },
      { status: 'measured', value: { certificate: certificate(), observation: observation() } },
    ] as const;
    const catalogs = [
      { status: 'unavailable', reason: 'x' },
      { status: 'measured', value: { member: true, nearMiss: [] } },
      { status: 'measured', value: { member: false, nearMiss: [] } },
    ] as const;
    let checked = 0;
    for (const state of states)
      for (const firedReason of reasons)
        for (const expectedVerdict of verdicts)
          for (const ownership of owners)
            for (const producer of producers)
              for (const catalog of catalogs)
                for (const currentGeneration of [3, 4, null]) {
                  const r = evaluateDeclaredGateGeneration(
                    input({
                      announcement: { state, firedReason, expectedVerdict, firedAt: state === 'fired' ? 't' : null },
                      ownership: ownership as DeclaredGateEvidenceInput['ownership'],
                      producer: producer as DeclaredGateEvidenceInput['producer'],
                      catalog: catalog as DeclaredGateEvidenceInput['catalog'],
                      currentGeneration,
                    }),
                  );
                  checked++;
                  if (r.status === 'classified') {
                    expect(DECLARED_GATE_CLASSIFICATIONS).toContain(r.classification);
                    expect(r.idempotenceKey).toBe(declaredGateRecoveryKey(42, 3, r.classification));
                    if (r.classification === 'already-complete') {
                      expect(state).toBe('fired');
                      expect(firedReason).toBe('event');
                      expect(['matched', 'not-declared', 'pending']).toContain(expectedVerdict);
                    }
                    // Takeover/escalation never arises from an unmeasured owner.
                    if (ACTIONABLE_CLASSIFICATIONS.has(r.classification)) expect(ownership.status).toBe('measured');
                  } else {
                    expect(r.nextVerb.verb).toBe('events:status');
                  }
                }
    expect(checked).toBe(5 * 4 * 5 * 5 * 4 * 3 * 3);
  });
});

describe('terminal generations and generation races', () => {
  it.each([
    ['cancelled', { state: 'cancelled' }],
    ['expired', { state: 'expired' }],
    ['superseded', { state: 'superseded' }],
  ] as const)('%s generations are inactive and only resync', (reason, a) => {
    const r = evaluateDeclaredGateGeneration(input({ announcement: a }));
    expect(r).toMatchObject({ status: 'inactive', reason, nextVerb: { verb: 'events:status' } });
  });

  it('a newer declaration generation racing the evaluation makes this one stale — resync to the authoritative generation', () => {
    const r = evaluateDeclaredGateGeneration(input({ currentGeneration: 4 }));
    expect(r).toMatchObject({
      status: 'inactive',
      reason: 'stale-generation',
      nextVerb: { verb: 'events:status', args: { event: 'gate:release:candidate-abc', after_generation: 4 } },
    });
  });
});

describe('unavailable probes fail open to unknown (R-001)', () => {
  it.each([
    ['owner liveness unavailable', { ownership: { status: 'unavailable', reason: 'oracle timeout' } }],
    ['no liveness verdict and no successor', { ownership: { status: 'measured', value: { declaredByLiveness: null, liveSuccessorIds: [] } } }],
    ['catalog unavailable for an ended owner', { catalog: { status: 'unavailable', reason: 'timeout' } }],
    ['fire history unavailable for an ended owner', { fireHistory: { status: 'unavailable', reason: 'timeout' } }],
    ['producer probe unavailable for a live owner', { ownership: liveDeclarer, producer: { status: 'unavailable', reason: 'no verifier' } }],
    [
      'producer checked before its verification deadline',
      { ownership: liveDeclarer, producer: { status: 'measured', value: { certificate: certificate({ verificationDeadlineMs: NOW + 60_000 }), observation: observation() } } },
    ],
    [
      'producer verifier rejects the certificate',
      { ownership: liveDeclarer, producer: { status: 'measured', value: { certificate: certificate({ expectedCadenceMs: 0 }), observation: observation() } } },
    ],
  ] as const)('%s → unknown + re-await, never takeover', (_why, over) => {
    const r = classified(evaluateDeclaredGateGeneration(input(over as Over)));
    expect(r.classification).toBe('unknown');
    expect(r.escalationTarget).toBeNull();
    expect(r.nextVerb.verb).toBe('events:await');
  });
});

// ── Action bridge ──────────────────────────────────────────────────────────

/** An in-memory condition singleton with the same adopt-or-mint contract as condition-upsert. */
function fakeDeps(opts: { current?: { generation: number | null; state: 'declared' | 'fired' | 'cancelled' | 'expired' | 'superseded' } | null } = {}) {
  const conditions = new Map<string, string>();
  let seq = 0;
  const deps = {
    readCurrentDeclaration: vi.fn(async () => (opts.current === undefined ? { generation: 3, state: 'declared' as const } : opts.current)),
    upsertCondition: vi.fn(async (key: string) => {
      const existing = conditions.get(key);
      if (existing) return { id: existing, created: false };
      const id = `WI-${++seq}`;
      conditions.set(key, id);
      return { id, created: true };
    }),
    wakeOwner: vi.fn(async () => ({ queued: 1 })),
  } satisfies DeclaredGateRecoveryDeps;
  return { deps, conditions };
}

const stalled = () =>
  evaluateDeclaredGateGeneration(
    input({ ownership: liveDeclarer, producer: { status: 'measured', value: { certificate: certificate(), observation: observation() } } }),
  );

describe('applyDeclaredGateRecovery — idempotent actions (R-004) with durable evidence (R-005)', () => {
  it('stalled-producer: the first sweep files the condition and wakes the owner exactly once', async () => {
    const { deps } = fakeDeps();
    const action = await applyDeclaredGateRecovery(stalled(), deps);
    expect(action).toMatchObject({ action: 'owner-woken', conditionKey: 'declared-gate-recovery:42:3:stalled-producer', workItemId: 'WI-1' });
    expect(deps.wakeOwner).toHaveBeenCalledTimes(1);
    expect(deps.wakeOwner).toHaveBeenCalledWith('su-declarer', expect.objectContaining({ payload: expect.objectContaining({ workItemId: 'WI-1' }) }));
  });

  it('duplicate sweeps / duplicate timeout wakes collapse to one condition item and ONE wake; the repeat surfaces takeover', async () => {
    const { deps, conditions } = fakeDeps();
    const first = await applyDeclaredGateRecovery(stalled(), deps);
    const second = await applyDeclaredGateRecovery(stalled(), deps);
    const third = await applyDeclaredGateRecovery(stalled(), deps);
    expect(first.action).toBe('owner-woken');
    expect(second).toMatchObject({ action: 'deduplicated', workItemId: 'WI-1' });
    expect(second.surfacedTakeover).toEqual([
      { verb: 'work_items:claim', args: { id: 'WI-900' }, target: { kind: 'producer-work-item', ref: 'WI-900' } },
    ]);
    expect(third.action).toBe('deduplicated');
    expect(deps.wakeOwner).toHaveBeenCalledTimes(1);
    expect(conditions.size).toBe(1);
  });

  it('concurrent sweeps racing the same generation still produce one wake', async () => {
    const { deps } = fakeDeps();
    const actions = await Promise.all([1, 2, 3, 4].map(() => applyDeclaredGateRecovery(stalled(), deps)));
    expect(actions.filter((a) => a.action === 'owner-woken')).toHaveLength(1);
    expect(deps.wakeOwner).toHaveBeenCalledTimes(1);
  });

  it('a new generation is a new identity: its escalation is not suppressed by the old one', async () => {
    const { deps } = fakeDeps({ current: { generation: 4, state: 'declared' } });
    const gen4 = evaluateDeclaredGateGeneration(
      input({
        announcement: { generation: 4 },
        currentGeneration: 4,
        ownership: liveDeclarer,
        producer: { status: 'measured', value: { certificate: certificate(), observation: observation() } },
      }),
    );
    await applyDeclaredGateRecovery(gen4, deps);
    expect(deps.upsertCondition).toHaveBeenCalledWith('declared-gate-recovery:42:4:stalled-producer', expect.anything());
  });

  it.each([
    ['fired', { generation: 3, state: 'fired' as const }],
    ['cancelled', { generation: 3, state: 'cancelled' as const }],
    ['superseded by a newer generation', { generation: 4, state: 'declared' as const }],
    ['vanished', null],
  ])('generation CAS: a declaration %s before acting performs nothing', async (_why, current) => {
    const { deps } = fakeDeps({ current });
    const action = await applyDeclaredGateRecovery(stalled(), deps);
    expect(action.action).toBe('generation-moved');
    expect(deps.upsertCondition).not.toHaveBeenCalled();
    expect(deps.wakeOwner).not.toHaveBeenCalled();
  });

  it('missed-emitter files the steward item without waking anyone', async () => {
    const { deps } = fakeDeps();
    const r = evaluateDeclaredGateGeneration(input({ catalog: { status: 'measured', value: { member: true, nearMiss: [] } } }));
    const action = await applyDeclaredGateRecovery(r, deps);
    expect(action).toMatchObject({ action: 'steward-item-filed', conditionKey: 'declared-gate-recovery:42:3:missed-emitter' });
    expect(deps.wakeOwner).not.toHaveBeenCalled();
  });

  it('never-fireable records an advisory only — no wake and no takeover', async () => {
    const { deps } = fakeDeps();
    const action = await applyDeclaredGateRecovery(evaluateDeclaredGateGeneration(input()), deps);
    expect(action.action).toBe('advisory-recorded');
    expect(action.surfacedTakeover).toBeUndefined();
    expect(deps.wakeOwner).not.toHaveBeenCalled();
  });

  it.each(['progressing', 'expected-idle', 'unknown', 'already-complete'] as const)(
    '%s is waiter-owned: the bridge performs no read, write, or wake',
    async (cls) => {
      const { deps } = fakeDeps();
      const obs =
        cls === 'progressing'
          ? observation({ lastProgressAtMs: NOW - 1000 })
          : cls === 'expected-idle'
            ? observation({ state: 'idle' })
            : observation({ state: 'unknown' });
      const r =
        cls === 'already-complete'
          ? evaluateDeclaredGateGeneration(input({ announcement: { state: 'fired', firedReason: 'event', firedAt: 't' } }))
          : evaluateDeclaredGateGeneration(
              input({ ownership: liveDeclarer, producer: { status: 'measured', value: { certificate: certificate(), observation: obs } } }),
            );
      expect(classified(r).classification).toBe(cls);
      const action = await applyDeclaredGateRecovery(r, deps);
      expect(action.action).toBe('none');
      expect(deps.readCurrentDeclaration).not.toHaveBeenCalled();
      expect(deps.upsertCondition).not.toHaveBeenCalled();
      expect(deps.wakeOwner).not.toHaveBeenCalled();
    },
  );

  it('inactive generations never act', async () => {
    const { deps } = fakeDeps();
    const action = await applyDeclaredGateRecovery(evaluateDeclaredGateGeneration(input({ currentGeneration: 9 })), deps);
    expect(action.action).toBe('none');
    expect(deps.readCurrentDeclaration).not.toHaveBeenCalled();
  });

  it('R-005: the filed record carries catalog membership, fire history, owner liveness, producer health, expected condition, generation, and target', async () => {
    const { deps } = fakeDeps();
    const r = classified(stalled());
    await applyDeclaredGateRecovery(r, deps);
    const [, filed] = deps.upsertCondition.mock.calls[0] as unknown as [string, { summary: string; payload: { declaredGateRecovery: Record<string, unknown> } }];
    for (const label of ['generation: 3', 'catalog membership', 'fire latch/history', 'owner liveness', 'producer health', 'expected condition', 'escalation target: live-declarer:su-declarer', 'next verb: coord:send']) {
      expect(filed.summary).toContain(label);
    }
    expect(filed.summary).toMatch(/never marks the gate fired/);
    expect(filed.summary).toContain(`evidence checked at (UTC): ${new Date(r.evidence.checkedAtMs).toISOString()}`);
    expect(filed.payload.declaredGateRecovery).toMatchObject({
      classification: 'stalled-producer',
      escalationTarget: { kind: 'live-declarer', ref: 'su-declarer' },
      evidence: {
        generation: 3,
        ownerLiveness: liveDeclarer,
        producerHealth: { status: 'measured', verifiedClassification: 'stalled' },
      },
    });
    expect(declaredGateRecoverySummary(r)).toBe(filed.summary);
  });
});
