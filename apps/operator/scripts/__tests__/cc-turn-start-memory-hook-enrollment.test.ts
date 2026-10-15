/**
 * WI-4394 — unit gates for the pure launch-time CC turn-start-memory-hook
 * enrollment verdict (psu-launcher.mjs), generalized alongside
 * cc-coord-hook-enrollment.test.ts's coord-inbox verdict from the same
 * `ccHookEnrollment` core (coord-delivery-residual-gaps-2026-07-11 P-002).
 * The I/O half (read settings.json → repair via the operator install route →
 * loud banner) is exercised live at psu launch; the verdict logic is pinned
 * here.
 */
import { describe, it, expect } from 'vitest';
import { ccTurnStartMemoryHookEnrollment, ccHookEnrollment } from '../psu-launcher.mjs';

const HOOK = '/home/user/.papercusp/hooks/cc/userpromptsubmit-memory.sh';

const settingsWith = (command: string) =>
  JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command }] },
        { hooks: [{ type: 'command', command: '/x/userpromptsubmit-provenance.sh' }] },
      ],
    },
  });

describe('ccTurnStartMemoryHookEnrollment (WI-4394 launch guard verdict)', () => {
  it('enrolled: UserPromptSubmit entry runs the turn-start-memory script and it exists on disk', () => {
    const v = ccTurnStartMemoryHookEnrollment(settingsWith(HOOK), { scriptExists: (p: string) => p === HOOK });
    expect(v.enrolled).toBe(true);
    expect(v.misses).toEqual([]);
  });

  it('enrolled even when the command carries env prefixes/args (extracts the script token)', () => {
    const v = ccTurnStartMemoryHookEnrollment(settingsWith(`PAPERCUSP_X=1 ${HOOK} --flag`), {
      scriptExists: (p: string) => p === HOOK,
    });
    expect(v.enrolled).toBe(true);
  });

  it('missing entry → unenrolled with the specific miss (the WI-4394 live shape: settings.json has\n     only userpromptsubmit-provenance.sh wired, predating the memory hook)', () => {
    const v = ccTurnStartMemoryHookEnrollment(
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ command: '/x/userpromptsubmit-provenance.sh' }] }] },
      }),
      { scriptExists: () => true },
    );
    expect(v.enrolled).toBe(false);
    expect(v.misses[0]).toMatch(/no UserPromptSubmit entry runs userpromptsubmit-memory\.sh/);
  });

  it('entry present but the script is gone from disk → unenrolled, names the path', () => {
    const v = ccTurnStartMemoryHookEnrollment(settingsWith(HOOK), { scriptExists: () => false });
    expect(v.enrolled).toBe(false);
    expect(v.misses[0]).toContain(HOOK);
  });

  it('empty / unparseable / absent settings → unenrolled, never a throw', () => {
    for (const text of ['', 'not-json', undefined, null] as const) {
      const v = ccTurnStartMemoryHookEnrollment(text as unknown as string, { scriptExists: () => true });
      expect(v.enrolled).toBe(false);
      expect(v.misses[0]).toMatch(/missing or unparseable/);
    }
  });

  it('hooks block absent entirely → unenrolled (fresh machine / no UserPromptSubmit key shape)', () => {
    const v = ccTurnStartMemoryHookEnrollment(JSON.stringify({ model: 'x' }), { scriptExists: () => true });
    expect(v.enrolled).toBe(false);
  });

  it('no scriptExists probe supplied → entry presence alone decides (I/O-free callers)', () => {
    const v = ccTurnStartMemoryHookEnrollment(settingsWith(HOOK));
    expect(v.enrolled).toBe(true);
  });
});

describe('ccHookEnrollment (generalized core both coord-inbox and turn-start-memory verdicts share)', () => {
  it('is event- and hook-name-parameterized — an entry under the WRONG event does not count', () => {
    const v = ccHookEnrollment(
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: HOOK }] }] } }),
      { event: 'UserPromptSubmit', hookName: 'userpromptsubmit-memory.sh', scriptExists: () => true },
    );
    expect(v.enrolled).toBe(false);
    expect(v.misses[0]).toMatch(/no UserPromptSubmit entry/);
  });
});
