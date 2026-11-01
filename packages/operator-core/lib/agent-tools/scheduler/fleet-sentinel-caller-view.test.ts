/**
 * EI-20304090779240149 — a fleet-sentinel read must say whether it is the CALLER's spec.
 *
 * The live incident these tests pin: `scheduler:get_claim_spec { fleet:'nonp2p-bug-drain-
 * headless-0812' }` returned fleet rev7 to a session with NO membership row, which then
 * self-pulled out-of-lane WI-5988 under DEFAULT_CLAIM_SPEC ten seconds later. Both reads
 * were right about their own subject; the sentinel read simply never said whose spec it was.
 *
 * `naiveCallerView` below is a PERMANENTLY-WRONG control — the pre-fix behaviour, which
 * reported agreement whenever the sentinel row existed. Every mismatch case asserts the real
 * helper disagrees with it, so a regression that reverts to "the row exists, so it's yours"
 * fails here instead of passing quietly. The calibration case (a genuine member) asserts both
 * agree, which is what stops the controls from passing when the property itself is broken.
 */
import { describe, it, expect } from 'vitest';
import {
  fleetSentinelCallerView,
  type CallerSpecResolution,
} from './fleet-sentinel-caller-view';

const FLEET = 'nonp2p-bug-drain-headless-0812';
const CALLER = 'su-48bb5561-df80-42fc-8081-efc386412dae';

/** The pre-fix reading: a sentinel row answered, so assume it governs the caller. */
const naiveCallerView = () => ({ appliesToCaller: true, warning: undefined as string | undefined });

const view = (callerRecord: CallerSpecResolution | null, callerFleetRole: string | null = null) =>
  fleetSentinelCallerView({ fleetSlug: FLEET, callerId: CALLER, callerRecord, callerFleetRole });

describe('fleetSentinelCallerView', () => {
  it('CALIBRATION: a genuine member of THIS fleet gets agreement and no warning', () => {
    const v = view({ source: 'fleet', revision: 7, fleetSlug: FLEET }, 'member');
    expect(v.appliesToCaller).toBe(true);
    expect(v.warning).toBeUndefined();
    expect(v.callerEffective).toMatchObject({ resolved: true, source: 'fleet', revision: 7, fleetRole: 'member' });
    // The control is RIGHT here — which is what proves the cases below are not vacuous.
    expect(v.appliesToCaller).toBe(naiveCallerView().appliesToCaller);
  });

  it("a leader's inherited sentinel is not reported as the member self-pull lane", () => {
    const v = view({ source: 'fleet', revision: 41, fleetSlug: FLEET }, 'leader');
    expect(v.appliesToCaller).toBe(false);
    expect(v.callerEffective).toMatchObject({ source: 'fleet', revision: 41, fleetRole: 'leader' });
    expect(v.warning).toContain('you are the fleet leader');
    expect(v.warning).toContain('scheduler:get_next does not consume the leader\'s member lane');
  });

  it('an unreadable membership role never produces a false applicability verdict', () => {
    const v = view({ source: 'fleet', revision: 41, fleetSlug: FLEET });
    expect(v.appliesToCaller).toBe(false);
    expect(v.warning).toContain('could not be confirmed as \'member\'');
  });

  it('THE LIVE INCIDENT: no membership + no per-bee spec ⇒ does NOT apply, names fleet:join', () => {
    const v = view({ source: 'default', revision: null });
    expect(v.appliesToCaller).toBe(false);
    expect(v.appliesToCaller).not.toBe(naiveCallerView().appliesToCaller);
    expect(v.warning).toContain('NOT your effective claim spec');
    expect(v.warning).toContain('DEFAULT_CLAIM_SPEC');
    // The remedy must be a callable shape, not "re-steer the spec".
    expect(v.warning).toContain(`fleet:join { fleet: '${FLEET}', as: 'member' }`);
  });

  it('a per-bee override WINS over the fleet spec, and the warning says so', () => {
    const v = view({ source: 'cup', revision: 3 });
    expect(v.appliesToCaller).toBe(false);
    expect(v.warning).toMatch(/per-bee spec, which always WINS/);
    expect(v.warning).toContain(`scheduler:set_claim_spec { cupId: '${CALLER}' }`);
    expect(v.warning).toContain('rev 3');
  });

  it('membership in a DIFFERENT fleet does not silently read as this lane', () => {
    const v = view({ source: 'fleet', revision: 2, fleetSlug: 'some-other-fleet' });
    expect(v.appliesToCaller).toBe(false);
    expect(v.warning).toContain("'some-other-fleet'");
    expect(v.callerEffective.fleetSlug).toBe('some-other-fleet');
  });

  it('a mid-transition marker (membership names a fleet, no valid sentinel) is reported as fail-closed', () => {
    const v = view({ source: 'default', revision: null, fleetSlug: 'half-rebound-fleet' });
    expect(v.appliesToCaller).toBe(false);
    expect(v.warning).toMatch(/mid-transition/);
    expect(v.warning).toContain("scheduler:set_claim_spec { fleet: 'half-rebound-fleet' }");
  });

  it('an UNREADABLE caller resolution reports UNKNOWN — never agreement', () => {
    const v = view(null);
    expect(v.appliesToCaller).toBe(false);
    expect(v.callerEffective.resolved).toBe(false);
    expect(v.callerEffective.source).toBeNull();
    expect(v.warning).toContain('UNKNOWN');
    expect(v.warning).toContain(`scheduler:get_claim_spec { cupId: '${CALLER}' }`);
  });

  it('every non-applying case carries an actionable warning (no silent mismatch)', () => {
    const mismatches: (CallerSpecResolution | null)[] = [
      { source: 'default', revision: null },
      { source: 'cup', revision: 3 },
      { source: 'fleet', revision: 2, fleetSlug: 'other' },
      { source: 'default', revision: null, fleetSlug: 'half-rebound-fleet' },
      null,
    ];
    for (const m of mismatches) {
      const v = view(m);
      expect(v.appliesToCaller, `unexpectedly applied for ${JSON.stringify(m)}`).toBe(false);
      expect(v.warning, `no warning for ${JSON.stringify(m)}`).toBeTruthy();
    }
  });
});
