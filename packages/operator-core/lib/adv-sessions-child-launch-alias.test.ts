/**
 * WI-6554700010030031 — an in-place context reset (`/clear`) rotates a Claude
 * child's native id, and psu-pty-host re-anchors adv_sessions.session_id to it.
 * The SAME child keeps presenting the id it was launched with (its papercusp-su
 * MCP header and every inherited shell carry PAPERCUSP_NATIVE_SESSION_ID), so the
 * verifier must accept that launch id as an alias of the ACTIVE row — or every
 * native MCP call is refused `superuser_foreign_native_session` until the next
 * respawn (measured 2026-10-27 on su-7eaf5682, three times in one night).
 */
import { describe, expect, it } from 'vitest';
import { classifyOwnerNativeSessionRows, type OwnerNativeSessionRow } from './adv-sessions';

const LAUNCH = '6e4a2d87-3500-44ff-bcae-49d97851d3d3';
const ROTATED = 'e5917e1e-5d22-4ad7-be91-d5302881928f';
const STRANGER = '11111111-2222-4333-8444-555555555555';

const resetRow = (overrides: Partial<OwnerNativeSessionRow> = {}): OwnerNativeSessionRow => ({
  id: 53117,
  session_id: ROTATED,
  child_launch_session_id: LAUNCH,
  active: true,
  ...overrides,
});

describe('classifyOwnerNativeSessionRows — same-process launch-id alias (WI-6554700010030031)', () => {
  it('accepts the child launch id after a context reset rotated session_id', () => {
    expect(classifyOwnerNativeSessionRows([resetRow()], LAUNCH)).toEqual({
      binding: 'bound',
      boundSessionId: LAUNCH,
      advSessionId: 53117,
    });
  });

  it('still accepts the rotated id itself (hooks, transcript-keyed consumers)', () => {
    expect(classifyOwnerNativeSessionRows([resetRow()], ROTATED).binding).toBe('bound');
  });

  it('refuses an unrelated id even when an alias is present', () => {
    expect(classifyOwnerNativeSessionRows([resetRow()], STRANGER)).toEqual({
      binding: 'foreign',
      boundSessionId: ROTATED,
      advSessionId: 53117,
    });
  });

  it('never honours the alias of an ENDED row — its child process is gone', () => {
    expect(classifyOwnerNativeSessionRows([resetRow({ active: false })], LAUNCH).binding).toBe('foreign');
  });

  it('without an alias the launch id is foreign (the pre-fix behaviour a new-process respawn keeps)', () => {
    expect(
      classifyOwnerNativeSessionRows([resetRow({ child_launch_session_id: null })], LAUNCH).binding,
    ).toBe('foreign');
  });
});
