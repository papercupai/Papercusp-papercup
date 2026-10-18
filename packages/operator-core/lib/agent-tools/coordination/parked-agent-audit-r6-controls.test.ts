/**
 * Synthetic R-6 detector controls belong to the unit layer. Vitest records a
 * layer per file/run, so colocating these pure oracles with the live e2e test
 * lets them be misread as lifecycle evidence.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, inject, it } from 'vitest';
import { originalUnconfirmedPairs, pickupDispositionViolations, type FollowupState, type PickupDisposition } from './parked-agent-audit-oracles';

const liveE2eSource = readFileSync(new URL('./parked-agent-audit.e2e.test.ts', import.meta.url), 'utf8');

describe('R-6 live evidence boundary', () => {
  it('runs synthetic detector controls only in the unit layer', () => {
    expect(inject('papercuspTestLayer')).toBe('unit');
  });

  it('keeps controls out of e2e and preserves the live R-6 acceptance gates', () => {
    expect(liveE2eSource).not.toContain("describe('R-6 finite pickup disposition detector controls'");
    expect(liveE2eSource).toContain("const AUDIT_LIVE_PROFILE = 'packages/operator-core/test/parked-agent-audit.live-profile.json';");
    expect(liveE2eSource).toContain("process.env.PAPERCUSP_PARKED_SEARCH_LIVE === '1'");
    expect(liveE2eSource).toContain("expect(SEARCH_LIVE_REQUESTED, 'R-6 requires an actual live measurement').toBe(true);");
    expect(liveE2eSource).toContain("expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(AUDIT_LIVE_PROFILE);");
    expect(liveE2eSource).toContain("'code:run', '--port', '3170', '--client'");
    expect(liveE2eSource).toContain('PARKED_AUDIT_R6 ${JSON.stringify');
  });

  const expected = Array.from({ length: 10 }, (_, i) => ({ ownerId: `owner-${i}`, request: `request-${i}` }));
  const cases = (): PickupDisposition[] => expected.map(row => ({ ...row, outcome: 'pickup-unconfirmed', reply: null }));
  const items = (): FollowupState[] => ['WI-6554700010017003', 'WI-6554700010017004']
    .map(id => ({ id, state: 'wip', assignee: 'running-owner', hasCompletionEvidence: false }));

  it('accepts evidence-based unknown dispositions without crediting pickup', () => {
    expect(pickupDispositionViolations(expected, cases(), items(), 'running-owner')).toEqual([]);
  });
  it('uses corrected evidence rather than a legacy activity-only pickup label', () => {
    const rows = expected.map(row => ({ ...row, verification: 'pickup-not-confirmed', pickup: 'unconfirmed' }));
    rows[0].pickup = 'activity-observed';
    expect(originalUnconfirmedPairs(rows)).toEqual(expected);
    rows[0].verification = 'explicit-recipient-reply';
    expect(originalUnconfirmedPairs(rows)).toHaveLength(9);
  });
  it('rejects missing, duplicate and foreign pairs even when counts look complete', () => {
    const missing = cases(); missing.pop();
    expect(pickupDispositionViolations(expected, missing, items(), 'running-owner')).toContain('disposition-population');
    const duplicate = cases(); duplicate[9] = duplicate[0];
    expect(pickupDispositionViolations(expected, duplicate, items(), 'running-owner')).toContain('disposition-population');
    const foreign = cases(); foreign[9].request = 'foreign';
    expect(pickupDispositionViolations(expected, foreign, items(), 'running-owner')).toContain('disposition-population');
  });
  it('rejects unsupported pickup and an open unowned item', () => {
    const unsupported = cases(); unsupported[0].outcome = 'recipient-replied';
    expect(pickupDispositionViolations(expected, unsupported, items(), 'running-owner')).toContain('unsupported-pickup:owner-0:request-0');
    const unowned = items(); unowned[0].assignee = null;
    expect(pickupDispositionViolations(expected, cases(), unowned, 'running-owner')).toContain('unowned-or-unverified:WI-6554700010017003');
    const unevidencedClose = items(); unevidencedClose[0].state = 'done';
    expect(pickupDispositionViolations(expected, cases(), unevidencedClose, 'running-owner')).toContain('unowned-or-unverified:WI-6554700010017003');
  });
});
