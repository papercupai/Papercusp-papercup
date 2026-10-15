/**
 * membership-report.test.ts — the portal→machine `membership.report` frame (WI-10004257).
 * The SQL halves (portal read, machine replace, sweep read) are in alert-sweep.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_REPORT_FRAME_TYPE,
  MEMBERSHIP_REPORT_MAX_EMAILS,
  membershipReportFrame,
  parseMembershipReport,
} from './membership-report';

describe('membership report frames', () => {
  it('normalizes addresses: lower-cased, trimmed, de-duplicated, sorted', () => {
    expect(membershipReportFrame('org-1', [' Zed@Example.test', 'amy@example.test', 'zed@example.test'])).toEqual({
      type: MEMBERSHIP_REPORT_FRAME_TYPE,
      organizationId: 'org-1',
      removedEmails: ['amy@example.test', 'zed@example.test'],
    });
    expect(membershipReportFrame('org-1', [])).toEqual({ type: 'membership.report', organizationId: 'org-1', removedEmails: [] });
  });

  it('refuses a set over the cap rather than truncating it', () => {
    const emails = Array.from({ length: MEMBERSHIP_REPORT_MAX_EMAILS + 1 }, (_, i) => `m${i}@example.test`);
    expect(membershipReportFrame('org-1', emails)).toBeNull();
    expect(membershipReportFrame('org-1', emails.slice(1))?.removedEmails).toHaveLength(MEMBERSHIP_REPORT_MAX_EMAILS);
  });

  it('parses a well-formed frame and refuses a malformed one whole', () => {
    const good = { type: 'membership.report', organizationId: 'org-1', removedEmails: ['A@example.test'] };
    expect(parseMembershipReport(good)?.removedEmails).toEqual(['a@example.test']);
    for (const bad of [
      null,
      'membership.report',
      [],
      { ...good, type: 'relay' },
      { ...good, organizationId: '' },
      { ...good, organizationId: 7 },
      { ...good, organizationId: 'o'.repeat(129) },
      { ...good, removedEmails: 'a@example.test' },
      { ...good, removedEmails: ['a@example.test', 42] },
      { ...good, removedEmails: ['a@example.test', 'not-an-address'] },
      { ...good, removedEmails: ['a@example.test', ''] },
    ]) {
      expect(parseMembershipReport(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
