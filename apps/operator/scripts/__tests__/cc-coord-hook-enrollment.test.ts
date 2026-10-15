/**
 * coord-delivery-residual-gaps-2026-07-11 P-002 — unit gates for the pure
 * launch-time CC coord-hook enrollment verdict (psu-launcher.mjs). The I/O
 * half (read settings.json → repair via the operator install route → loud
 * banner) is exercised live at psu launch; the verdict logic is pinned here.
 *
 * EI-11405 (coordination-hook-rpc-fanout-collapse-2026-07-16): the standalone
 * posttooluse-coord-inbox.sh hook this used to probe for is RETIRED — mid-turn
 * coord:inbox delivery is now folded into posttooluse-activity-report.sh's own
 * round trip, so THAT script is what `ccCoordHookEnrollment` now checks.
 */
import { describe, it, expect } from 'vitest';
import { ccCoordHookEnrollment } from '../psu-launcher.mjs';

const HOOK = '/home/user/.papercusp/hooks/cc/posttooluse-activity-report.sh';

const settingsWith = (command: string) =>
  JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command }] },
        { matcher: '*', hooks: [{ type: 'command', command: '/x/workitem-verify-nudge.sh' }] },
      ],
    },
  });

describe('ccCoordHookEnrollment (P-002 launch guard verdict)', () => {
  it('enrolled: PostToolUse entry runs the activity-report (coord-folding) script and it exists on disk', () => {
    const v = ccCoordHookEnrollment(settingsWith(HOOK), { scriptExists: (p: string) => p === HOOK });
    expect(v.enrolled).toBe(true);
    expect(v.misses).toEqual([]);
  });

  it('enrolled even when the command carries env prefixes/args (extracts the script token)', () => {
    const v = ccCoordHookEnrollment(settingsWith(`PAPERCUSP_X=1 ${HOOK} --flag`), {
      scriptExists: (p: string) => p === HOOK,
    });
    expect(v.enrolled).toBe(true);
  });

  it('missing entry → unenrolled with the specific miss', () => {
    const v = ccCoordHookEnrollment(
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: '*', hooks: [{ command: '/x/other.sh' }] }] } }),
      { scriptExists: () => true },
    );
    expect(v.enrolled).toBe(false);
    expect(v.misses[0]).toMatch(/no PostToolUse entry/);
  });

  it('entry present but the script is gone from disk → unenrolled, names the path', () => {
    const v = ccCoordHookEnrollment(settingsWith(HOOK), { scriptExists: () => false });
    expect(v.enrolled).toBe(false);
    expect(v.misses[0]).toContain(HOOK);
  });

  it('empty / unparseable / absent settings → unenrolled, never a throw', () => {
    for (const text of ['', 'not-json', undefined, null] as const) {
      const v = ccCoordHookEnrollment(text as unknown as string, { scriptExists: () => true });
      expect(v.enrolled).toBe(false);
      expect(v.misses[0]).toMatch(/missing or unparseable/);
    }
  });

  it('hooks block absent entirely → unenrolled (fresh machine shape)', () => {
    const v = ccCoordHookEnrollment(JSON.stringify({ model: 'x' }), { scriptExists: () => true });
    expect(v.enrolled).toBe(false);
  });

  it('no scriptExists probe supplied → entry presence alone decides (I/O-free callers)', () => {
    const v = ccCoordHookEnrollment(settingsWith(HOOK));
    expect(v.enrolled).toBe(true);
  });
});
