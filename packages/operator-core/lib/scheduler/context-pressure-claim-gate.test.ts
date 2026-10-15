/**
 * WI-5940 — the context-pressure claim gate.
 *
 * The properties under test are asymmetric on purpose: refusing when we should serve (a false
 * 'critical') is the WORSE failure, because it manufactures a false drain — an agent idling while
 * believing its lane is empty. So the fail-open cases are asserted at least as hard as the
 * refusal itself.
 */
import { describe, it, expect } from 'vitest';
import {
  decideContextPressureGate,
  contextCriticalRefusalResult,
  CONTEXT_CRITICAL_REFUSAL_CODE,
} from './context-pressure-claim-gate';

describe('decideContextPressureGate', () => {
  it('REFUSES at critical, with a typed code and no lane claim', () => {
    const reading = { bucket: 'critical' as const, estimatedAt: '2026-10-11T15:00:00.000Z', ageSec: 90 };
    const d = decideContextPressureGate({ bucket: 'critical', reading });
    expect(d.refuse).toBe(true);
    if (!d.refuse) throw new Error('unreachable');
    expect(d.code).toBe(CONTEXT_CRITICAL_REFUSAL_CODE);
    expect(d.diagnosis.contextPressureBlocked).toBe(true);
    expect(d.diagnosis.contextEstimate).toEqual({ estimatedAt: reading.estimatedAt, ageSec: reading.ageSec });
    // The filing's point 2: a VERDICT, not silence — and explicitly not a drain claim.
    expect(d.diagnosis.laneEvaluated).toBe(false);
    expect(d.error).toMatch(/NOT evaluated/i);
    expect(d.error).toMatch(/compact/i);
  });

  // ── fail-open axis: each of these SERVING is the point of the whole design ──
  it("serves at 'ok' and 'high' unchanged (acceptance: only critical is gated)", () => {
    expect(decideContextPressureGate({ bucket: 'ok' })).toMatchObject({
      refuse: false,
      reason: 'pressure-ok',
    });
    expect(decideContextPressureGate({ bucket: 'high' })).toMatchObject({
      refuse: false,
      reason: 'pressure-high',
    });
  });

  it('serves on an UNKNOWN bucket — null is never coerced to critical', () => {
    // null is what deriveContextPressure returns for an untracked owner AND for an estimate
    // older than CONTEXT_ESTIMATE_STALE_MS. Both must serve.
    for (const bucket of [null, undefined]) {
      const d = decideContextPressureGate({ bucket });
      expect(d.refuse).toBe(false);
      expect(d).toMatchObject({ reason: 'pressure-unknown' });
    }
  });

  it('honors the caller override at critical — the live gauge beats the cached bucket', () => {
    const d = decideContextPressureGate({ bucket: 'critical', override: true });
    expect(d.refuse).toBe(false);
    expect(d).toMatchObject({ reason: 'caller-override', bucket: 'critical' });
  });

  it('honors the kill-switch at critical', () => {
    const d = decideContextPressureGate({ bucket: 'critical', enabled: false });
    expect(d.refuse).toBe(false);
    expect(d).toMatchObject({ reason: 'gate-disabled' });
  });

  it('names the real override argument in the remedy text', () => {
    const d = decideContextPressureGate({ bucket: 'critical', overrideArg: 'ignoreContextPressure' });
    if (!d.refuse) throw new Error('expected refusal');
    expect(d.error).toContain('ignoreContextPressure');
    expect(d.diagnosis.overrideArg).toBe('ignoreContextPressure');
  });

  it('names the verified COLD loop instead of prescribing unavailable self-compaction', () => {
    const d = decideContextPressureGate({
      bucket: 'critical',
      recovery: {
        path: 'cold-loop',
        selfCompactionAvailable: false,
        carryNoteVerified: true,
        reason: 'active-cold-loop',
      },
    });
    if (!d.refuse) throw new Error('expected refusal');
    expect(d.error).toContain('armed COLD loop');
    expect(d.error).not.toContain('session:request-compaction');
    expect(d.diagnosis).toMatchObject({
      remedy: 'cold-loop settle',
      recoveryPath: 'cold-loop',
    });
  });

  it('preserves the warm loop when no host exists and request-compaction cannot retune it', () => {
    const d = decideContextPressureGate({
      bucket: 'critical',
      recovery: {
        path: 'warm-loop',
        selfCompactionAvailable: false,
        carryNoteVerified: null,
        reason: 'active-warm-loop',
      },
    });
    if (!d.refuse) throw new Error('expected refusal');
    expect(d.error).toContain('keep the active WARM loop');
    expect(d.error).toContain('returns no_live_pty_host with retuned:false');
    expect(d.error).toContain('does not retune WARM to COLD');
    expect(d.error).toContain('session:request-compaction');
    expect(d.diagnosis).toMatchObject({
      remedy: 'checkpoint, preserve the warm loop, and use a managed host',
      recoveryPath: 'warm-loop',
    });
  });

  it('does not claim self-compaction is available when no recovery path is known', () => {
    const d = decideContextPressureGate({
      bucket: 'critical',
      recovery: {
        path: 'no-path',
        selfCompactionAvailable: false,
        carryNoteVerified: null,
        reason: 'no-live-pty-or-loop',
      },
    });
    if (!d.refuse) throw new Error('expected refusal');
    expect(d.error).toContain('self-compaction is unavailable');
    expect(d.error).toContain('arm a COLD loop');
    expect(d.error).not.toContain('self-compact (session:request-compaction');
    expect(d.diagnosis).toMatchObject({
      remedy: 'checkpoint, arm a fresh-context wake',
      recoveryPath: 'no-path',
    });
  });

  it('kill-switch and override are consulted BEFORE the bucket, so a stale reading cannot defeat them', () => {
    // Both must win over the strongest possible bucket value.
    expect(decideContextPressureGate({ bucket: 'critical', enabled: false }).refuse).toBe(false);
    expect(decideContextPressureGate({ bucket: 'critical', override: true }).refuse).toBe(false);
  });

  it('CALIBRATION (non-vacuity): the refusal branch is genuinely reachable', () => {
    // Guards the fail-open assertions above: if the gate were wired to never refuse, every
    // "serves" test would still pass and the suite would be worthless. Exactly one input in
    // this set may refuse.
    const inputs = [
      { bucket: 'ok' as const },
      { bucket: 'high' as const },
      { bucket: null },
      { bucket: 'critical' as const },
    ];
    const refusals = inputs.filter((i) => decideContextPressureGate(i).refuse);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.bucket).toBe('critical');
  });
});

describe('contextCriticalRefusalResult', () => {
  it('renders ok:false with the typed code so a caller can branch on it', () => {
    const d = decideContextPressureGate({ bucket: 'critical' });
    if (!d.refuse) throw new Error('expected refusal');
    const wire = contextCriticalRefusalResult(d);
    expect(wire.ok).toBe(false);
    expect(wire.code).toBe(CONTEXT_CRITICAL_REFUSAL_CODE);
    expect(wire.error).toBe(d.error);
  });
});
