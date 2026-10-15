/**
 * reporter-provenance.test.ts — who filed a work item
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-010, SPEC-P-010, D-001).
 *
 * The pure half of the contract: every filing derives exactly one reporter
 * kind, says WHY (basis), and the corroboration tally only ever grows. The
 * capture wiring is capture-core-reporter-provenance.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  REPORTER_KINDS,
  deriveReporterProvenance,
  effectiveReporter,
  isReporterKind,
  mergeReporterKinds,
  storedReporter,
} from './provenance';

const AT = '2026-10-06T16:00:00.000Z';

describe('deriveReporterProvenance — one kind per filing, with its basis', () => {
  it('an explicit kind from the filing door wins over every inferred signal', () => {
    expect(deriveReporterProvenance({ explicitKind: 'end-user', createdBy: 'system:improvement-watchdog', at: AT }))
      .toEqual({ kind: 'end-user', id: 'system:improvement-watchdog', basis: 'explicit', at: AT });
  });

  it('a system: identity is a watchdog', () => {
    expect(deriveReporterProvenance({ createdBy: 'system:improvement-watchdog', at: AT }))
      .toMatchObject({ kind: 'watchdog', basis: 'system-identity', id: 'system:improvement-watchdog' });
  });

  it("a caller-declared sourceRole 'system' is a watchdog even with a session id", () => {
    expect(deriveReporterProvenance({ createdBy: 'su-1234', sourceRole: 'system', at: AT }))
      .toMatchObject({ kind: 'watchdog', basis: 'system-identity' });
  });

  it('no filing identity at all reads as a watchdog and says it was inferred', () => {
    expect(deriveReporterProvenance({ createdBy: null, at: AT })).toEqual({
      kind: 'watchdog',
      id: null,
      basis: 'no-session',
      at: AT,
    });
    expect(deriveReporterProvenance({ createdBy: '   ', at: AT })).toMatchObject({ basis: 'no-session' });
  });

  it('a session identity is an agent', () => {
    expect(deriveReporterProvenance({ createdBy: 'su-4a152da3', at: AT }))
      .toEqual({ kind: 'agent', id: 'su-4a152da3', basis: 'agent-session', at: AT });
  });

  it("sourceRole 'human' is NOT an end-user signal (capture defaults every agent filing to it)", () => {
    expect(deriveReporterProvenance({ createdBy: 'su-1', sourceRole: 'human', at: AT }).kind).toBe('agent');
  });

  it('a junk explicit kind is ignored, not trusted', () => {
    expect(deriveReporterProvenance({ explicitKind: 'robot', createdBy: 'su-1', at: AT }))
      .toMatchObject({ kind: 'agent', basis: 'agent-session' });
    expect(isReporterKind('robot')).toBe(false);
    expect(REPORTER_KINDS.every(isReporterKind)).toBe(true);
  });
});

describe('storedReporter / effectiveReporter — reading the stamp back', () => {
  it('reads a stored stamp and rejects a malformed one', () => {
    expect(storedReporter({ reporter: { kind: 'end-user', id: null, basis: 'explicit', at: AT } }))
      .toEqual({ kind: 'end-user', id: null, basis: 'explicit', at: AT });
    expect(storedReporter({ reporter: { kind: 'nope' } })).toBeNull();
    expect(storedReporter({})).toBeNull();
    expect(storedReporter(null)).toBeNull();
  });

  it('a legacy row with no stamp gets the derivation its writer would have applied', () => {
    expect(effectiveReporter({ payload: { sourceRole: 'system' }, createdBy: 'su-9', createdAt: AT }))
      .toMatchObject({ kind: 'watchdog', basis: 'system-identity' });
    expect(effectiveReporter({ payload: null, createdBy: 'su-9', createdAt: AT })).toMatchObject({ kind: 'agent' });
  });

  it('a stored stamp beats the derivation', () => {
    expect(
      effectiveReporter({
        payload: { reporter: { kind: 'end-user', id: 'install-7', basis: 'explicit', at: AT } },
        createdBy: 'system:relay',
      }).kind,
    ).toBe('end-user');
  });
});

describe('mergeReporterKinds — the corroboration tally only grows', () => {
  it('seeds from the prior stamp when the row predates the tally', () => {
    expect(mergeReporterKinds({ reporter: { kind: 'watchdog', basis: 'system-identity' } }, 'agent'))
      .toEqual(['agent', 'watchdog']);
  });

  it('adds a new kind, keeps canonical order, and never duplicates', () => {
    expect(mergeReporterKinds({ reporterKinds: ['end-user'] }, 'agent')).toEqual(['agent', 'end-user']);
    expect(mergeReporterKinds({ reporterKinds: ['agent', 'watchdog'] }, 'agent')).toEqual(['agent', 'watchdog']);
  });

  it('drops junk entries and tolerates a missing payload', () => {
    expect(mergeReporterKinds({ reporterKinds: ['agent', 42, 'bogus'] }, 'watchdog')).toEqual(['agent', 'watchdog']);
    expect(mergeReporterKinds(null, 'end-user')).toEqual(['end-user']);
  });
});
