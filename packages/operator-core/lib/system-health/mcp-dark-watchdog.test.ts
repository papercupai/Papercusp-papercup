/**
 * Unit coverage for evaluateMcpDark — the pure "is this bee working MCP-dark?" verdict. The five
 * gates (grace · predates-restart · alive · generating · no-MCP-since-restart) each get a positive
 * and a negative case; the DB wiring (checkMcpDark) is integration-covered. Clock + restartAt are
 * injected so no real time is involved.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateMcpDark,
  evaluateInteractiveMcpDark,
  planInteractiveHeal,
  interactiveHealJitterMs,
  markHealSent,
  healedWakeText,
  taggedHealedWakeText,
  headlessMcpRecoveryWakeText,
  taggedHeadlessMcpRecoveryWakeText,
  interactiveDarkRecoveryInstructions,
  checkInteractiveMcpDark,
  type McpDarkSnapshot,
  type InteractiveDarkSnapshot,
} from './mcp-dark-watchdog';
import { parseEnvelope } from '../turn-provenance/turn-provenance';

// checkInteractiveMcpDark lazily `await import()`s this module — mock it so the
// recovery-sweep tests below never touch the real FS/pty layer.
type MockLiveHost = {
  ownerId: string;
  startedAt: number;
  lastActivityAt?: number | null;
  bridgeTty?: boolean | null;
  caps?: string[] | null;
  sock?: string;
};
const listLiveHostsMock = vi.fn<() => MockLiveHost[]>(() => []);
const mcpReconnectViaPtyMock = vi.fn(async () => 'sent' as const);
const injectIntoHostMock = vi.fn(async (_sock: string, _message: { mode: string; data: string; ownerId: string }) => true);
vi.mock('../events/await/psu-pty-discovery', () => ({
  listLiveHosts: (...args: unknown[]) => listLiveHostsMock(...(args as [])),
  listLiveHostsAsync: async (...args: unknown[]) => listLiveHostsMock(...(args as [])),
  mcpReconnectViaPty: (...args: unknown[]) => mcpReconnectViaPtyMock(...(args as [])),
  sessionClassForHost: (host: MockLiveHost | null | undefined) =>
    host?.bridgeTty === false ? 'claude-headless' : 'claude-interactive',
  hostSupports: (host: MockLiveHost | null | undefined, cap: string) =>
    Array.isArray(host?.caps) && host.caps.includes(cap),
  findLiveHost: () => null,
  injectIntoHost: (...args: unknown[]) =>
    injectIntoHostMock(...(args as [string, { mode: string; data: string; ownerId: string }])),
}));

// The interactive heal step repairs the session's CLAUDE_CONFIG_DIR first
// (EI-13020). The real repair writes under ~/.papercusp/session-claude/<sid>, so
// unmocked it (a) wrote real config dirs for these test sids into the owner's
// HOME on every run, and (b) let real async fs I/O run inside the fake-timer
// jitter test, where each await on real I/O lets virtual time drift past the
// asserted send offsets (WI-10005327: [101,450,487] vs [89,427,446]). Keep the
// heal path in-memory: the repair resolves immediately and reports no repair.
const ensureInteractiveClaudeConfigMock = vi.fn(async () => ({ repaired: false }));
vi.mock('../interactive-claude-config', () => ({
  ensureInteractiveClaudeConfig: (...args: unknown[]) => ensureInteractiveClaudeConfigMock(...(args as [])),
}));

const RESTART = 1_000_000_000_000; // fixed operator-boot epoch ms
const M = 60_000;
const NOW = RESTART + 30 * M; // 30 min after the restart — well past the 5-min grace

/** A snapshot that IS dark: started before restart, alive, generating, no MCP since restart. */
function darkSnapshot(over: Partial<McpDarkSnapshot> = {}): McpDarkSnapshot {
  return {
    ownerId: 'role-abc123',
    startedMs: RESTART - 20 * M, // existed before the restart
    supervisorHeartbeatMs: NOW - 1 * M, // supervisor beat 1 min ago ⇒ alive
    lastOutputMs: NOW - 1 * M, // generating output 1 min ago
    presenceHeartbeatMs: RESTART - 5 * M, // last MCP call was BEFORE the restart
    ...over,
  };
}

describe('evaluateMcpDark', () => {
  it('flags a bee that is alive + generating but has made no MCP call since the restart', () => {
    const v = evaluateMcpDark(darkSnapshot(), RESTART, NOW);
    expect(v.dark).toBe(true);
    expect(v.reason).toContain('working tool-less (dark)');
  });

  it('treats a NULL presence row (never handshook MCP) as dark', () => {
    const v = evaluateMcpDark(darkSnapshot({ presenceHeartbeatMs: null }), RESTART, NOW);
    expect(v.dark).toBe(true);
    expect(v.reason).toContain('never');
  });

  it('does NOT flag within the grace window (client may still be reconnecting)', () => {
    const soon = RESTART + 2 * M; // 2 min in — under the 5-min grace
    expect(evaluateMcpDark(darkSnapshot(), RESTART, soon).dark).toBe(false);
  });

  it('does NOT flag a bee spawned AFTER the restart (just booting, not a failed reconnect)', () => {
    expect(evaluateMcpDark(darkSnapshot({ startedMs: RESTART + 1 * M }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag a bee with no started_at recorded', () => {
    expect(evaluateMcpDark(darkSnapshot({ startedMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag when the supervisor beat is stale (process likely gone, not dark)', () => {
    expect(evaluateMcpDark(darkSnapshot({ supervisorHeartbeatMs: NOW - 10 * M }), RESTART, NOW).dark).toBe(false);
    expect(evaluateMcpDark(darkSnapshot({ supervisorHeartbeatMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag an idle bee (no recent output — not a live turn needing tools)', () => {
    expect(evaluateMcpDark(darkSnapshot({ lastOutputMs: NOW - 10 * M }), RESTART, NOW).dark).toBe(false);
    expect(evaluateMcpDark(darkSnapshot({ lastOutputMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag a bee that HAS reconnected (presence heartbeat advanced past the restart)', () => {
    expect(evaluateMcpDark(darkSnapshot({ presenceHeartbeatMs: RESTART + 3 * M }), RESTART, NOW).dark).toBe(false);
  });

  it('respects custom thresholds (tighter grace flips a borderline case to dark)', () => {
    const soon = RESTART + 2 * M;
    // default 5-min grace ⇒ not dark; a 1-min grace ⇒ dark (all other gates hold).
    expect(evaluateMcpDark(darkSnapshot(), RESTART, soon, { graceMs: 1 * M }).dark).toBe(true);
  });
});

// ═══ Interactive-session sweep (mcp-transport-resilience P-005, 2026-07-13) ═══

const INOW = 2_000_000_000_000;

/** A snapshot that IS dark under the armed-loop clause: host old, loop armed
 *  (600s), presence beat 45 min stale (> max(3×600s, 20m) = 30m). Mirrors the
 *  su-39f07 incident shape. */
function interactiveDark(over: Partial<InteractiveDarkSnapshot> = {}): InteractiveDarkSnapshot {
  return {
    ownerId: 'su-39f07',
    hostStartedMs: INOW - 6 * 60 * M,
    hostLastActivityMs: INOW - 1 * M,
    presenceHeartbeatMs: INOW - 45 * M,
    loopActive: true,
    loopIntervalSec: 600,
    ...over,
  };
}

describe('evaluateInteractiveMcpDark (P-005 — NOT pinned to operator restart)', () => {
  it('detects the su-39f07 shape: armed loop + presence beat past 3× interval', () => {
    const v = evaluateInteractiveMcpDark(interactiveDark(), INOW);
    expect(v.dark).toBe(true);
    expect(v.reason).toContain('ARMED loop');
  });

  it('grace: a young host is never dark (session may not have tool-called yet)', () => {
    const v = evaluateInteractiveMcpDark(interactiveDark({ hostStartedMs: INOW - 5 * M }), INOW);
    expect(v.dark).toBe(false);
  });

  it('armed loop within cadence is healthy (beat 10m stale, threshold 30m)', () => {
    const v = evaluateInteractiveMcpDark(interactiveDark({ presenceHeartbeatMs: INOW - 10 * M }), INOW);
    expect(v.dark).toBe(false);
  });

  it('a LONG loop interval raises the threshold (3× interval beats the floor)', () => {
    // interval 30 min ⇒ threshold 90 min; a 45-min-stale beat is fine.
    const v = evaluateInteractiveMcpDark(
      interactiveDark({ loopIntervalSec: 1800, presenceHeartbeatMs: INOW - 45 * M }),
      INOW,
    );
    expect(v.dark).toBe(false);
  });

  it('no loop: dark only when the pty is IN USE and the beat is very stale', () => {
    const base = interactiveDark({ loopActive: false, loopIntervalSec: null });
    // in use (pty 1m ago) + beat 45m stale > 30m ⇒ dark
    expect(evaluateInteractiveMcpDark(base, INOW).dark).toBe(true);
    // idle session (pty 20m ago) ⇒ never dark, however stale the beat
    expect(evaluateInteractiveMcpDark({ ...base, hostLastActivityMs: INOW - 20 * M }, INOW).dark).toBe(false);
    // in use but beat only 20m stale ⇒ not dark
    expect(evaluateInteractiveMcpDark({ ...base, presenceHeartbeatMs: INOW - 20 * M }, INOW).dark).toBe(false);
  });

  it('presence NEVER seen ⇒ NOT dark — no evidence it is a papercusp agent (false-positive fix 2026-07-20)', () => {
    // A session that never registered a single coord_presence beat has never
    // made a papercusp MCP call. It is either not a papercusp-tool session at all
    // (a manual/debug session run through the psu-pty wrapper — live case
    // su-3fa86771) or dark-from-birth (unhealable by /mcp, recovered on relaunch).
    // Either way it must NOT enter the heal ladder, or /mcp is re-injected every
    // window forever. Holds even when the pty is IN USE and the host is old.
    const inUseOldNullBeat = interactiveDark({
      loopActive: false,
      loopIntervalSec: null,
      hostLastActivityMs: INOW - 1 * M, // actively in use
      hostStartedMs: INOW - 6 * 60 * M, // well past grace
      presenceHeartbeatMs: null, // NEVER registered
    });
    expect(evaluateInteractiveMcpDark(inUseOldNullBeat, INOW).dark).toBe(false);
    // Same guard for the armed-loop branch (defensive — an armed loop implies a
    // prior loop:arm MCP call, so a real one always has a beat).
    expect(evaluateInteractiveMcpDark(interactiveDark({ presenceHeartbeatMs: null }), INOW).dark).toBe(false);
  });

  it('null presence does not prove a dark transport', () => {
    const v = evaluateInteractiveMcpDark(
      interactiveDark({
        loopActive: false,
        loopIntervalSec: null,
        presenceHeartbeatMs: null,
      }),
      INOW,
    );
    expect(v.dark).toBe(false);
  });
});

describe('planInteractiveHeal (the cross-pass heal ladder — tri-state verdicts, 2026-07-14 false-heal fix)', () => {
  it('dark → heal, heal, then notify ONCE, then none', () => {
    const state = new Map();
    const dark = [{ ownerId: 'su-x', dark: true }];
    expect(planInteractiveHeal(state, dark, INOW)).toEqual([{ ownerId: 'su-x', action: 'heal' }]);
    expect(planInteractiveHeal(state, dark, INOW + 5 * M)).toEqual([{ ownerId: 'su-x', action: 'heal' }]);
    expect(planInteractiveHeal(state, dark, INOW + 10 * M)).toEqual([{ ownerId: 'su-x', action: 'notify' }]);
    expect(planInteractiveHeal(state, dark, INOW + 15 * M)).toEqual([{ ownerId: 'su-x', action: 'none' }]);
  });

  it('RECOVERED (fresh beat) after a SENT attempt → announce-healed exactly once, state cleared', () => {
    const state = new Map();
    planInteractiveHeal(state, [{ ownerId: 'su-x', dark: true }], INOW);
    markHealSent(state, 'su-x'); // the executor confirmed the envelope landed
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: false, recovered: true }], INOW + 5 * M)).toEqual([
      { ownerId: 'su-x', action: 'announce-healed' },
    ]);
    // next pass: nothing on record ⇒ none
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: false, recovered: true }], INOW + 10 * M)).toEqual([
      { ownerId: 'su-x', action: 'none' },
    ]);
  });

  it('LIVE REGRESSION su-39f07 2026-07-14: ¬dark alone is INDETERMINATE — never an announce, state held', () => {
    // The deployed first cut announced "healed" when the dark verdict merely
    // flipped (session went idle / presence row absent). recovered:false must
    // hold everything.
    const state = new Map();
    planInteractiveHeal(state, [{ ownerId: 'su-x', dark: true }], INOW);
    markHealSent(state, 'su-x');
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: false, recovered: false }], INOW + 5 * M)).toEqual([
      { ownerId: 'su-x', action: 'none' },
    ]);
    expect(state.has('su-x')).toBe(true); // state HELD, not cleared
    // …and when it goes dark again (su-5651d flip-flop shape), the ladder resumes
    // where it left off instead of announcing.
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: true }], INOW + 10 * M)).toEqual([
      { ownerId: 'su-x', action: 'heal' },
    ]);
  });

  it('LIVE REGRESSION no-cap heals 2026-07-14: recovery with NO sent envelope clears silently — no announce', () => {
    // Both live hosts predated the macro (no-cap): nothing was ever injected, so
    // a later genuine recovery (owner ran /mcp) must NOT claim "the macro healed you".
    const state = new Map();
    planInteractiveHeal(state, [{ ownerId: 'su-x', dark: true }], INOW); // attempt recorded, but never sent
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: false, recovered: true }], INOW + 5 * M)).toEqual([
      { ownerId: 'su-x', action: 'none' },
    ]);
    expect(state.has('su-x')).toBe(false); // cleared — a fresh incident starts a fresh ladder
  });

  it('never-dark owners never act (no announce without a recorded attempt)', () => {
    const state = new Map();
    expect(planInteractiveHeal(state, [{ ownerId: 'su-y', dark: false }], INOW)).toEqual([
      { ownerId: 'su-y', action: 'none' },
    ]);
    expect(planInteractiveHeal(state, [{ ownerId: 'su-y', dark: false, recovered: true }], INOW)).toEqual([
      { ownerId: 'su-y', action: 'none' },
    ]);
  });

  it('the attempt window rolls: old attempts age out and healing resumes', () => {
    const state = new Map();
    const dark = [{ ownerId: 'su-x', dark: true }];
    planInteractiveHeal(state, dark, INOW);
    planInteractiveHeal(state, dark, INOW + 1 * M);
    // 2h later: both attempts aged out of the 1h window ⇒ heal again
    expect(planInteractiveHeal(state, dark, INOW + 120 * M)).toEqual([{ ownerId: 'su-x', action: 'heal' }]);
  });

  it("shared rolling budget caps a correlated burst without consuming deferred owners' attempts", () => {
    const state = new Map();
    const budget = { attemptsMs: [] as number[], maxAttempts: 2, windowMs: 10 * M };
    const burst = ['su-a', 'su-b', 'su-c'].map((ownerId) => ({ ownerId, dark: true }));
    expect(planInteractiveHeal(state, burst, INOW, 2, budget)).toEqual([
      { ownerId: 'su-a', action: 'heal' },
      { ownerId: 'su-b', action: 'heal' },
      { ownerId: 'su-c', action: 'defer-budget' },
    ]);
    expect(state.get('su-c')?.attemptsMs).toEqual([]);

    // Same rolling-window recovery property as cluster-fork: capacity returns
    // after the window drains; the deferred owner gets its FIRST real attempt.
    expect(planInteractiveHeal(state, [{ ownerId: 'su-c', dark: true }], INOW + 11 * M, 2, budget)).toEqual([
      { ownerId: 'su-c', action: 'heal' },
    ]);
    expect(state.get('su-c')?.attemptsMs).toHaveLength(1);
  });

  it('shared budget admits never-tried owners BEFORE retries, so a drained window cannot starve a fresh owner (P-014)', () => {
    const state = new Map();
    const budget = { attemptsMs: [] as number[], maxAttempts: 2, windowMs: 10 * M };
    const all = ['su-a', 'su-b', 'su-c'].map((ownerId) => ({ ownerId, dark: true }));
    planInteractiveHeal(state, all, INOW, 2, budget); // a,b healed; c deferred

    // Window drained; a and b are STILL dark with one attempt each, c has none.
    // c must win a slot over a's retry; output order still follows the input order.
    const steps = planInteractiveHeal(state, all, INOW + 11 * M, 2, budget);
    expect(steps).toEqual([
      { ownerId: 'su-a', action: 'heal' },
      { ownerId: 'su-b', action: 'defer-budget' },
      { ownerId: 'su-c', action: 'heal' },
    ]);
    // The deferred retry did not burn b's per-owner attempt.
    expect(state.get('su-b')?.attemptsMs).toHaveLength(1);
    expect(state.get('su-c')?.attemptsMs).toHaveLength(1);
  });

  it('reconnect jitter is stable per owner/window, bounded, and disableable for tests', () => {
    const a = interactiveHealJitterMs('su-a', INOW, 2_000);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(2_000);
    expect(interactiveHealJitterMs('su-a', INOW, 2_000)).toBe(a);
    expect(interactiveHealJitterMs('su-a', INOW, 0)).toBe(0);
  });
});

describe('healedWakeText', () => {
  it('tells the healed session to re-arm its loop and re-park state', () => {
    const text = healedWakeText('su-x', 45);
    expect(text).toContain('loop:status');
    expect(text).toContain('do NOT re-arm a deliberately ended loop');
    expect(text).toContain('re-park');
    expect(text).toContain('~45m');
  });

  it('writes watchdog provenance before returning the PTY turn so it cannot become an OWNER directive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-dark-watchdog-provenance-'));
    try {
      const tagged = await taggedHealedWakeText('su-x', 45, { dir, nowMs: INOW });
      const parsed = parseEnvelope(tagged);
      expect(parsed?.origin).toBe('watchdog');
      expect(parsed?.payload.trimStart()).toBe(healedWakeText('su-x', 45));

      const ledger = readFileSync(join(dir, 'su-x.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { sid: string; nonce: string; origin: string; ts: number });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        sid: 'su-x',
        nonce: parsed?.nonce,
        origin: 'watchdog',
        ts: INOW,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('headlessMcpRecoveryWakeText', () => {
  it('gives a resumed headless conversation its recovery context and avoids a second CLI', () => {
    const text = headlessMcpRecoveryWakeText('su-headless', 45);
    expect(text).toContain('P-005');
    expect(text).toContain('headless session su-headless');
    expect(text).toContain('~45m');
    expect(text).toContain('Re-read the active work-item and loop checkpoints');
    expect(text).toContain('Do not start a second CLI');
  });

  it('writes watchdog provenance before returning the carry text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-dark-watchdog-headless-provenance-'));
    try {
      const tagged = await taggedHeadlessMcpRecoveryWakeText('su-headless', 45, { dir, nowMs: INOW });
      const parsed = parseEnvelope(tagged);
      expect(parsed?.origin).toBe('watchdog');
      expect(parsed?.payload.trimStart()).toBe(headlessMcpRecoveryWakeText('su-headless', 45));

      const ledger = readFileSync(join(dir, 'su-headless.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { sid: string; nonce: string; origin: string; ts: number });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ sid: 'su-headless', nonce: parsed?.nonce, origin: 'watchdog', ts: INOW });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives headless owners psu-resume guidance and headed owners the in-place /mcp action', () => {
    const headless = interactiveDarkRecoveryInstructions('headless', 'no-cap');
    expect(headless).toContain('no interactive /mcp dialog');
    expect(headless).toContain('psu --resume <session-id>');
    expect(headless).toContain('Do not start a second CLI');

    const headed = interactiveDarkRecoveryInstructions('headed', 'no-cap');
    expect(headed).toContain('type /mcp in that session\'s terminal');
    expect(headed).not.toContain('carry-respawn');
  });
});

describe('checkInteractiveMcpDark — recovery sweep durability follow-up (EI-12059 / su-39f079d3)', () => {
  // EI-12059 root cause: the per-owner heal ladder only ever visits owners in
  // `hosts` (currently-live psu-pty sessions). Once an interactive session
  // ENDS — its discovery entry disappears — it drops out of `hosts` forever,
  // so `runInteractiveHealStep`'s own escalation-clear (fired only on
  // 'announce-healed') can never reach it again. An escalation raised while
  // that session was dark then stays open FOREVER. The fix: an unconditional
  // recovery sweep (mirroring the bee-variant's) that clears ANY standing
  // mcp-dark-int:% escalation whose owner is not in THIS pass's dark set —
  // including, critically, when there are ZERO live hosts at all.

  /** Fake postgres tag routing on query text: escalation read/write,
   *  coord_presence, armed loops, and recent agent-origin invocations.
   *  `openPhases` seeds the standing (still-open) escalation rows. */
  function fakeSql(opts: {
    openPhases: string[];
    presenceByOwner?: Record<string, number | null>;
    agentInvocationByOwner?: Record<string, boolean>;
  }) {
    const updatedPhases: string[] = [];
    type FakeSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
      unsafe: (identifier: string) => string;
      array: (values: readonly unknown[]) => unknown[];
    };
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join(' ');
      if (q.includes('SELECT phase FROM harness_shared.harness_escalations')) {
        return Promise.resolve(opts.openPhases.map((phase) => ({ phase })));
      }
      if (q.includes('UPDATE harness_shared.harness_escalations')) {
        // ANY(${toRecover}) is the sole interpolated array value on this query shape.
        const arr = values.find((v) => Array.isArray(v)) as string[] | undefined;
        if (arr) updatedPhases.push(...arr);
        return Promise.resolve([]);
      }
      if (q.includes('FROM harness_shared.tool_invocations t')) {
        return Promise.resolve(
          Object.entries(opts.agentInvocationByOwner ?? {})
            .filter(([, recent]) => recent)
            .map(([owner_id]) => ({ owner_id })),
        );
      }
      if (q.includes('coord_presence')) {
        const owners = values[0] as string[];
        return Promise.resolve(
          owners
            .filter((o) => (opts.presenceByOwner ?? {})[o] != null)
            .map((o) => ({ owner_id: o, presence_ms: (opts.presenceByOwner ?? {})[o] })),
        );
      }
      if (q.includes('harness_shared.routines')) {
        return Promise.resolve([]); // no armed loops in these tests
      }
      if (/\b(?:SELECT|UPDATE|INSERT|DELETE)\b/i.test(q)) {
        throw new Error(`fakeSql received an unhandled query: ${q.trim().slice(0, 160)}`);
      }
      return Promise.resolve([]);
    }) as FakeSqlTag;
    // readOrientationToolSurfaces builds its shared agent-call predicate with
    // these postgres.js fragment helpers before issuing the cadence query.
    tag.unsafe = (identifier) => identifier;
    tag.array = (values) => [...values];
    return { tag: tag as never, updatedPhases };
  }

  beforeEach(() => {
    listLiveHostsMock.mockReset().mockReturnValue([]);
    mcpReconnectViaPtyMock.mockReset().mockResolvedValue('sent');
    injectIntoHostMock.mockReset().mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('uses carry-respawn only for headless hosts and keeps headed sessions on /mcp', async () => {
    const headedOwner = 'su-headed-dark';
    const headlessOwner = 'su-headless-dark';
    const dir = mkdtempSync(join(tmpdir(), 'mcp-dark-watchdog-headless-dispatch-'));
    const previousProvenanceDir = process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
    process.env.PAPERCUSP_TURN_PROVENANCE_DIR = dir;
    const { tag } = fakeSql({
      openPhases: [],
      presenceByOwner: {
        [headedOwner]: INOW - 45 * M,
        [headlessOwner]: INOW - 45 * M,
      },
    });
    listLiveHostsMock.mockReturnValue([
      {
        ownerId: headedOwner,
        startedAt: INOW - 60 * M,
        lastActivityAt: INOW - 1 * M,
        bridgeTty: true,
        caps: ['mcp-reconnect', 'carry-respawn'],
        sock: '/tmp/headed-dark.sock',
      },
      {
        ownerId: headlessOwner,
        startedAt: INOW - 60 * M,
        lastActivityAt: INOW - 1 * M,
        bridgeTty: false,
        caps: ['carry-respawn'],
        sock: '/tmp/headless-dark.sock',
      },
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INOW);
    try {
      const out = await checkInteractiveMcpDark(tag, {
        jitterMaxMs: 0,
        sharedBudget: { attemptsMs: [], maxAttempts: 4, windowMs: 10 * M },
      });

      expect(out.healSent).toEqual(expect.arrayContaining([headedOwner, headlessOwner]));
      expect(mcpReconnectViaPtyMock).toHaveBeenCalledTimes(1);
      expect(mcpReconnectViaPtyMock).toHaveBeenCalledWith(headedOwner);
      expect(injectIntoHostMock).toHaveBeenCalledTimes(1);
      const [sock, message] = injectIntoHostMock.mock.calls[0];
      expect(sock).toBe('/tmp/headless-dark.sock');
      expect(message).toMatchObject({ mode: 'carry-respawn', ownerId: headlessOwner });
      const parsed = parseEnvelope(message.data);
      expect(parsed?.origin).toBe('watchdog');
      expect(parsed?.payload).toContain(`headless session ${headlessOwner}`);

      const ledger = readFileSync(join(dir, `${headlessOwner}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { sid: string; nonce: string; origin: string });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ sid: headlessOwner, nonce: parsed?.nonce, origin: 'watchdog' });
    } finally {
      vi.useRealTimers();
      if (previousProvenanceDir == null) delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
      else process.env.PAPERCUSP_TURN_PROVENANCE_DIR = previousProvenanceDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ZERO live hosts still clears a stale escalation for an ENDED session (the exact EI-12059 shape)', async () => {
    const phase = 'mcp-dark-int:su-39f079d3-4154-495e-af05-710c5a1148ea';
    const { tag, updatedPhases } = fakeSql({ openPhases: [phase] });
    listLiveHostsMock.mockReturnValue([]); // the session has fully ended — no pty host left

    const out = await checkInteractiveMcpDark(tag, {
      jitterMaxMs: 0,
      sharedBudget: { attemptsMs: [], maxAttempts: 4, windowMs: 10 * M },
    });

    expect(updatedPhases).toContain(phase);
    expect(out.recovered).toContain('su-39f079d3-4154-495e-af05-710c5a1148ea');
    expect(out.darkOwners).toEqual([]);
  });

  it('a live host that IS still dark keeps its OWN escalation open, while an unrelated ENDED session is swept', async () => {
    const darkOwner = 'su-live-dark';
    const endedOwner = 'su-ended';
    const { tag, updatedPhases } = fakeSql({
      openPhases: [`mcp-dark-int:${darkOwner}`, `mcp-dark-int:${endedOwner}`],
      presenceByOwner: { [darkOwner]: INOW - 45 * M }, // stale beat, in-use host below ⇒ dark (no-loop clause)
    });
    listLiveHostsMock.mockReturnValue([
      { ownerId: darkOwner, startedAt: INOW - 6 * 60 * M, lastActivityAt: INOW - 1 * M },
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INOW);

    const out = await checkInteractiveMcpDark(tag);

    expect(out.darkOwners).toContain(darkOwner);
    expect(updatedPhases).not.toContain(`mcp-dark-int:${darkOwner}`); // still dark — left open
    expect(updatedPhases).toContain(`mcp-dark-int:${endedOwner}`); // no longer live at all — swept
    vi.useRealTimers();
  });

  it('hook activity with zero agent calls does not trigger the /mcp heal ladder', async () => {
    const owner = 'su-dark-from-birth';
    const { tag } = fakeSql({
      openPhases: [],
      agentInvocationByOwner: { [owner]: false },
    });
    listLiveHostsMock.mockReturnValue([{ ownerId: owner, startedAt: INOW - 60 * M, lastActivityAt: INOW - 1 * M }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INOW);

    const out = await checkInteractiveMcpDark(tag, {
      jitterMaxMs: 0,
      sharedBudget: { attemptsMs: [], maxAttempts: 4, windowMs: 10 * M },
    });

    expect(out.darkOwners).not.toContain(owner);
    expect(out.healSent).not.toContain(owner);
    expect(mcpReconnectViaPtyMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fresh non-agent presence does not clear a live alert', async () => {
    const owner = 'su-dark-from-birth-hook-beat';
    const phase = 'mcp-dark-int:' + owner;
    const { tag, updatedPhases } = fakeSql({
      openPhases: [phase],
      // A hook, supervisor, or inbox writer may refresh this shared beat without
      // any recent agent-origin tool invocation.
      presenceByOwner: { [owner]: INOW - 1 * M },
      agentInvocationByOwner: { [owner]: false },
    });
    listLiveHostsMock.mockReturnValue([{ ownerId: owner, startedAt: INOW - 60 * M, lastActivityAt: INOW - 1 * M }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INOW);

    const out = await checkInteractiveMcpDark(tag, {
      jitterMaxMs: 0,
      sharedBudget: { attemptsMs: [], maxAttempts: 4, windowMs: 10 * M },
    });

    expect(out.darkOwners).not.toContain(owner);
    expect(out.healSent).not.toContain(owner);
    expect(out.recovered).not.toContain(owner);
    expect(updatedPhases).not.toContain(phase);
    expect(mcpReconnectViaPtyMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a recent agent-origin invocation clears a live alert even without a presence beat', async () => {
    const owner = 'su-agent-origin-recovered';
    const phase = 'mcp-dark-int:' + owner;
    const { tag, updatedPhases } = fakeSql({
      openPhases: [phase],
      agentInvocationByOwner: { [owner]: true },
    });
    listLiveHostsMock.mockReturnValue([{ ownerId: owner, startedAt: INOW - 60 * M, lastActivityAt: INOW - 1 * M }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INOW);

    const out = await checkInteractiveMcpDark(tag, { jitterMaxMs: 0 });

    expect(out.darkOwners).not.toContain(owner);
    expect(out.recovered).toContain(owner);
    expect(updatedPhases).toContain(phase);
    expect(mcpReconnectViaPtyMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a correlated stale-presence burst obeys the shared budget and reports every deferred owner', async () => {
    const owners = ['su-burst-a', 'su-burst-b', 'su-burst-c'];
    const { tag } = fakeSql({
      openPhases: [],
      presenceByOwner: Object.fromEntries(owners.map((owner) => [owner, INOW - 45 * M])),
    });
    listLiveHostsMock.mockReturnValue(
      owners.map((ownerId) => ({
        ownerId,
        startedAt: INOW - 60 * M,
        lastActivityAt: INOW - 1 * M,
      })),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INOW);

    const out = await checkInteractiveMcpDark(tag, {
      jitterMaxMs: 0,
      sharedBudget: { attemptsMs: [], maxAttempts: 2, windowMs: 10 * M },
    });

    expect(out.darkOwners).toEqual(owners);
    expect(out.healSent).toEqual(owners.slice(0, 2));
    expect(out.budgetDeferred).toEqual([owners[2]]);
    expect(mcpReconnectViaPtyMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a debug/manual zero-presence host WITHOUT call-origin proof stays inert (no heal, no darkness) (P-014)', async () => {
    const owner = 'su-manual-debug-session';
    // No presence row, and no tool-surface proof: hook calls below the actionable
    // floor / absent. A null beat alone must never trigger a reconnect (2026-07-20 guard).
    const { tag } = fakeSql({
      openPhases: [],
      agentInvocationByOwner: { [owner]: false },
    });
    listLiveHostsMock.mockReturnValue([{ ownerId: owner, startedAt: INOW - 60 * M, lastActivityAt: INOW - 1 * M }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INOW);
    try {
      const out = await checkInteractiveMcpDark(tag, {
        jitterMaxMs: 0,
        sharedBudget: { attemptsMs: [], maxAttempts: 4, windowMs: 10 * M },
      });
      expect(out.darkOwners).not.toContain(owner);
      expect(out.healSent).toEqual([]);
      expect(out.budgetDeferred).toEqual([]);
      expect(mcpReconnectViaPtyMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a budget-deferred owner is healed by a LATER pass once the rolling window drains, and only then (P-014)', async () => {
    const owners = ['su-win-a', 'su-win-b', 'su-win-c'];
    const budget = { attemptsMs: [] as number[], maxAttempts: 2, windowMs: 10 * M };
    const { tag } = fakeSql({
      openPhases: [],
      presenceByOwner: Object.fromEntries(owners.map((owner) => [owner, INOW - 45 * M])),
    });
    // Keep this session actively used on every pass, including the one after
    // the shared window drains; a fixed timestamp would age past the 10m PTY
    // freshness gate while virtual time advances.
    listLiveHostsMock.mockImplementation(() =>
      owners.map((ownerId) => ({ ownerId, startedAt: INOW - 60 * M, lastActivityAt: Date.now() - 1 * M })),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(INOW);
      const first = await checkInteractiveMcpDark(tag, { jitterMaxMs: 0, sharedBudget: budget });
      expect(first.healSent).toEqual(owners.slice(0, 2));
      expect(first.budgetDeferred).toEqual([owners[2]]);

      // Still inside the window: the burst stays capped, nobody new is admitted
      // beyond the shared budget (a/b are also inside their own cooldown ladder).
      vi.setSystemTime(INOW + 2 * M);
      mcpReconnectViaPtyMock.mockClear();
      const inside = await checkInteractiveMcpDark(tag, { jitterMaxMs: 0, sharedBudget: budget });
      expect(inside.healSent).not.toContain(owners[2]);
      expect(budget.attemptsMs.length).toBeLessThanOrEqual(2);

      // Window drained: capacity returns and the deferred owner finally gets a real attempt.
      vi.setSystemTime(INOW + 11 * M);
      mcpReconnectViaPtyMock.mockClear();
      const after = await checkInteractiveMcpDark(tag, { jitterMaxMs: 0, sharedBudget: budget });
      expect(after.healSent).toContain(owners[2]);
      expect(mcpReconnectViaPtyMock).toHaveBeenCalledWith(owners[2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('admitted reconnects are spread by bounded per-owner jitter instead of firing in lockstep (P-013)', async () => {
    const owners = ['su-jit-a', 'su-jit-b', 'su-jit-c'];
    const JITTER_MAX = 400;
    const { tag } = fakeSql({
      openPhases: [],
      presenceByOwner: Object.fromEntries(owners.map((owner) => [owner, INOW - 45 * M])),
    });
    listLiveHostsMock.mockReturnValue(
      owners.map((ownerId) => ({ ownerId, startedAt: INOW - 60 * M, lastActivityAt: INOW - 1 * M })),
    );
    mcpReconnectViaPtyMock.mockClear();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(INOW);
    try {
      const pass = checkInteractiveMcpDark(tag, {
        jitterMaxMs: JITTER_MAX,
        sharedBudget: { attemptsMs: [], maxAttempts: 4, windowMs: 10 * M },
      });
      // Virtual time only advances here, so the elapsed ms at which each reconnect
      // lands is exactly the sum of the sequential jitter sleeps.
      const callAtMs: number[] = [];
      for (let t = 1; t <= JITTER_MAX * owners.length + 5 && callAtMs.length < owners.length; t += 1) {
        await vi.advanceTimersByTimeAsync(1);
        while (callAtMs.length < mcpReconnectViaPtyMock.mock.calls.length) callAtMs.push(t);
      }
      const out = await pass;

      const jitters = owners.map((o) => interactiveHealJitterMs(o, INOW, JITTER_MAX));
      for (const j of jitters) {
        expect(j).toBeGreaterThanOrEqual(1);
        expect(j).toBeLessThanOrEqual(JITTER_MAX);
      }
      expect(out.healSent).toEqual(owners);
      // The config repair ran through the in-memory mock, not the real HOME writer:
      // if the module path drifts, vi.mock silently stops intercepting and this fails.
      for (const owner of owners) expect(ensureInteractiveClaudeConfigMock).toHaveBeenCalledWith({ sid: owner });
      // Nothing fired immediately, and the three sends are strictly staggered.
      expect(callAtMs).toEqual([jitters[0], jitters[0] + jitters[1], jitters[0] + jitters[1] + jitters[2]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when the escalations SELECT itself fails (fail-soft, per the function contract)', async () => {
    const throwingSql = (() => Promise.reject(new Error('pg connection reset'))) as never;
    await expect(checkInteractiveMcpDark(throwingSql)).resolves.toEqual({
      darkOwners: [],
      healed: [],
      healSent: [],
      notified: [],
      budgetDeferred: [],
      recovered: [],
      configRepaired: [],
    });
  });
});
