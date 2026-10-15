/**
 * fleet:assignments scope-disclosure preservation (EI-18763132241176410).
 *
 * THE BUG: `shapeFleetAssignments` rebuilds its result from an explicit key list
 * (ok / self / summary / orphaned / stalled / coverage* / dag* / agents). `scope` —
 * the block naming WHICH POPULATION the query asked about, `{ agent, plan, fleet,
 * harness, selfScoped, filtered }` — was not in that list, so every trimmed/standard
 * payload silently dropped it while keeping `summary` verbatim. The counts survived;
 * the caveat that scopes them did not.
 *
 * Measured live 2026-08-24, harness papercusp, same minute:
 *   coord:orient (nested `me`, trimmed) .... agents: 1,  claims: 0,  stalled: 0
 *   fleet:assignments { harness } .......... agents: 39, claims: 51, stalled: 3
 * and `me.scope` was ABSENT at trimmed tier but PRESENT at payloadTier:'full' —
 * which is what localised the defect to this shaper rather than to coord:orient.
 *
 * Why `summary.population` does not already cover it: that block reports which
 * RESOLVED ROWS were kept ("a row is in scope if this query resolved it"), never
 * which population was asked about — so a self-scoped read is self-consistently
 * `candidates:1, counted:1`. Only `scope.selfScoped` distinguishes an unmeasured
 * zero from a measured-empty one.
 *
 * This matters most at TRIMMED tier, i.e. under budget pressure, which is exactly
 * when a fleetless Mug or a leader reading a nested `me` is steering placement.
 * Cousin defects: WI-6762 / EI-19282566865609166 / WI-6740, where two agents
 * misread this same roster as "the whole fleet" on 2026-08-01.
 */
import { describe, expect, it } from 'vitest';
import { shapeFleetAssignments } from './assignments-shape';

/** A self-scoped assignments payload, shaped like the real tool's output. */
const selfScopedPayload = () => ({
  ok: true,
  self: { ownerId: 'su-e40dceb1' },
  scope: {
    agent: 'su-e40dceb1',
    plan: null,
    fleet: null,
    harness: 'papercusp',
    selfScoped: true,
    filtered: true,
  },
  summary: { agents: 1, alive: 1, claims: 0, orphaned_claims: 0, stalled_claims: 0 },
  orphaned: [],
  stalled: [],
  agents: [{ agentId: 'su-e40dceb1', isSelf: true, alive: true, claims: 0 }],
});

describe('shapeFleetAssignments preserves the scope disclosure', () => {
  it('preserves snapshot detail and unknown metrics through both payload tiers', () => {
    const payload = {
      ...selfScopedPayload(),
      detail: 'snapshot',
      unmeasuredMetrics: ['orphaned_claims', 'member.verdict'],
      summary: {
        agents: 1,
        alive: 1,
        claims: 1,
        scheduler_claim_state_status: 'unknown',
        scheduler_active_work_item_claims: null,
        orphaned_claims: null,
        stalled_claims: null,
        reclaimable_claims: null,
      },
      agents: [
        {
          agentId: 'su-e40dceb1',
          isSelf: true,
          alive: true,
          claims: [{ id: 'WI-123', planSlug: 'plan-a' }],
        },
      ],
    };

    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeFleetAssignments(payload, tier) as Record<string, unknown>;

      expect(out.detail).toBe('snapshot');
      expect(out.unmeasuredMetrics).toEqual(['orphaned_claims', 'member.verdict']);
      expect(out.summary).toMatchObject({
        claims: 1,
        scheduler_claim_state_status: 'unknown',
        scheduler_active_work_item_claims: null,
        orphaned_claims: null,
        stalled_claims: null,
        reclaimable_claims: null,
      });
      expect(out.agents).toMatchObject([{ agentId: 'su-e40dceb1', claims: 1 }]);
    }
  });

  for (const tier of ['trimmed', 'standard'] as const) {
    it(`keeps scope.selfScoped at ${tier} tier — the unmeasured-zero marker`, () => {
      const out = shapeFleetAssignments(selfScopedPayload(), tier) as Record<string, unknown>;

      // The counts contract is kept verbatim...
      expect((out.summary as Record<string, unknown>).agents).toBe(1);
      // ...and so is the block that says those counts speak only for the caller.
      expect(out.scope).toBeDefined();
      expect(out.scope).toMatchObject({ selfScoped: true, filtered: true, harness: 'papercusp' });
    });
  }

  it('keeps a fleet-scoped disclosure too, so the marker is uniform across scopes', () => {
    const payload = {
      ...selfScopedPayload(),
      scope: {
        agent: null,
        plan: null,
        fleet: 'drain-squad',
        harness: 'papercusp',
        selfScoped: false,
        filtered: true,
      },
    };
    const out = shapeFleetAssignments(payload, 'trimmed') as Record<string, unknown>;
    expect(out.scope).toMatchObject({ fleet: 'drain-squad', selfScoped: false });
  });

  it('preserves opt-in bounded-read timings through both payload tiers', () => {
    const readTimings = [
      { phase: 'assignments', startOffsetMs: 4, elapsedMs: 137, outcome: 'ok' },
      { phase: 'coverage', startOffsetMs: 5, elapsedMs: 8000, outcome: 'timeout' },
    ];
    const payload = { ...selfScopedPayload(), readTimings, handlerElapsedMs: 8042 };

    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeFleetAssignments(payload, tier) as Record<string, unknown>;
      expect(out.readTimings).toEqual(readTimings);
      expect(out.handlerElapsedMs).toBe(8042);
    }
  });

  it('omits scope rather than fabricating one when the source had none', () => {
    // Absence must stay absence: inventing `selfScoped:false` here would assert
    // peer coverage that was never measured — the same error, inverted.
    const { scope: _dropped, ...noScope } = selfScopedPayload();
    const out = shapeFleetAssignments(noScope, 'trimmed') as Record<string, unknown>;
    expect('scope' in out).toBe(false);
  });

  it('CONTROL: this guard actually fails against the pre-fix reconstruction', () => {
    // Falsifiability control, kept permanently (the repo's mutation discipline for an
    // imported module: never mutate the shared tree to prove a guard can fail). This
    // is the exact pre-fix shape — an explicit rebuild with no `scope` key. If the
    // assertions above ever pass for BOTH shapers, they have stopped measuring.
    const preFixShape = (data: Record<string, unknown>) => ({
      ok: data.ok ?? true,
      self: data.self,
      summary: data.summary ?? null,
      orphaned: [],
      stalled: [],
      agents: data.agents,
    });

    const real = shapeFleetAssignments(selfScopedPayload(), 'trimmed') as Record<string, unknown>;
    const broken = preFixShape(selfScopedPayload()) as Record<string, unknown>;

    expect(real.scope).toBeDefined();
    expect(broken.scope).toBeUndefined();

    // Both keep the counts — which is precisely why the counts alone never revealed
    // the bug, and why the disclosure is the thing worth pinning.
    expect((real.summary as Record<string, unknown>).agents).toBe(1);
    expect((broken.summary as Record<string, unknown>).agents).toBe(1);
  });
});
