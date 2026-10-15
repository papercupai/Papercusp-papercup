// @vitest-environment node
/**
 * wake-resume-isolation.test.ts — C5 identity-across-resume + C1 cross-agent
 * WAKE isolation: the EI-153 regression (coordination-test-suite-2026-06-08 P-005).
 *
 * ## What EI-153 was (D-001/D-004)
 * A wake for agent A reached a DIFFERENT agent B's session, because claude
 * sessions on the shared dev box can share one conversation store and the
 * existing tests never asserted "A's wake / conversation can never reach B."
 * The wake-executor's defenses against this are:
 *   1. NEVER `--continue` (most-recent-in-cwd) — always `--resume <A's native id>`
 *      so a shared cwd can't resume a peer's conversation.
 *   2. Per-OWNER `CLAUDE_CONFIG_DIR` (and per-session `CODEX_HOME`) on resume, so
 *      A's transcript/plugins live in A's dir, never B's.
 *   3. `PAPERCUSP_SID` preserved across resume = the resumer's own coord identity.
 *   4. Discovery keyed by ownerId — `findLiveHost(A)` never returns B's socket.
 *
 * This suite asserts all four ADVERSARIALLY: for two sessions A and B that share
 * a cwd (the EI-153 trap), A's resume command + env reference ONLY A's session id
 * / config dir / owner — never B's — and a wake for A injects into A's socket
 * only. It captures the REAL resume invocation by injecting `spawnDetached` (the
 * one OS seam), so the env/args built by the real `executeWake` are asserted
 * verbatim. Red-on-pre-fix: drop the per-owner config-dir or swap to `--continue`
 * and these go red.
 *
 * See also: the launch-side per-spawn config isolation is asserted in
 * `@papercusp/orchestrator`'s spawn-config-isolation.test.ts; the accepted gap for
 * interactive-SU launch isolation is EI-155 (coordination-coverage-matrix.mdx).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeWake, type ExecuteWakeDeps } from './wake-executor';
import {
  MultiSessionTestbed,
  makeDelivery,
  advSessionHandle,
  type TestSession,
} from '../../../test/_multi-session-testbed';

interface CapturedSpawn {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

describe('wake resume — C5 identity + C1 cross-agent isolation (EI-153)', () => {
  let tb: MultiSessionTestbed;
  let captured: CapturedSpawn[];
  const savedClaudeDir = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
  const savedCodexDir = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;

  beforeEach(() => {
    tb = MultiSessionTestbed.create();
    captured = [];
  });
  afterEach(async () => {
    if (savedClaudeDir === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = savedClaudeDir;
    if (savedCodexDir === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = savedCodexDir;
    await tb.destroy();
  });

  /** Point the per-owner config-dir resolver at the testbed's session-claude root
   *  (the parent of every session's `configDir`), so the REAL executeWake resolves
   *  each owner's existing isolated dir. */
  function pointConfigRootAt(s: TestSession): void {
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = dirname(s.configDir);
  }
  function pointCodexRootAt(s: TestSession): void {
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = dirname(s.codexHome);
  }

  /** Deps that capture the resume spawn and feed an EXITED claude session row. */
  function resumeDeps(s: TestSession, over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps {
    const deps = resumeDepsRaw(s, over);
    // Hermetic owner election (WI-10008189): stamp the fixture row with its id and model
    // "no successor", so the exited handle never reaches the real PG election read.
    return { ...deps, ...tb.ownerElectionDeps(deps) };
  }

  function resumeDepsRaw(s: TestSession, over: Partial<ExecuteWakeDeps>): ExecuteWakeDeps {
    return {
      findPsuHost: tb.findPsuHostDep(),
      // no live socket → falls to the resume rung
      getSession: async () =>
        ({
          pid: null,
          endedAt: new Date().toISOString(), // exited → resume path
          agent: 'claude',
          sessionId: `native-${s.ownerId}`,
          ompThreadId: null,
          coordOwnerId: s.ownerId,
          cwd: s.cwd,
      }) as never,
      alive: () => false,
      // EI-212246: Channel 2 now claims the ended adv-session atomically before
      // spawning. Keep this multi-session fixture hermetic and model a winning
      // claim; the production claim path has its own focused coverage.
      claimResume: async () => true,
      // WI-10002854: the real accountant writes the ledger row and adv pid to PG.
      accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: () => {} }),
      spawnDetached: (bin, args, opts) => {
        captured.push({ bin, args, cwd: opts.cwd, env: opts.env });
        return 4242;
      },
      ...over,
    };
  }

  it('C5: a claude resume preserves PAPERCUSP_SID and points CLAUDE_CONFIG_DIR at the OWNER\'s dir', async () => {
    const a = tb.session('A');
    pointConfigRootAt(a);
    const d = makeDelivery({ subscriberId: a.ownerId, wakeHandle: advSessionHandle(a) });

    const out = await executeWake(d, resumeDeps(a));

    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(captured).toHaveLength(1);
    const c = captured[0];
    // Identity survives the resume.
    expect(c.env.PAPERCUSP_SID).toBe(a.ownerId);
    // Per-owner config-dir isolation (the EI-153 fix on the resume leg).
    expect(c.env.CLAUDE_CONFIG_DIR).toBe(a.configDir);
    // Exact-session resume — NEVER --continue on the shared tree.
    expect(c.args).toContain('--resume');
    expect(c.args).toContain(`native-${a.ownerId}`);
    expect(c.args).not.toContain('--continue');
  });

  it('WI-41266: a wake resume reconstructs the persisted default account route', async () => {
    const prior = Object.fromEntries(
      ['ANTHROPIC_BASE_URL', 'PAPERCUSP_ANTHROPIC_URL', 'ANTHROPIC_AUTH_TOKEN'].map((key) => [key, process.env[key]]),
    );
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8788';
    process.env.PAPERCUSP_ANTHROPIC_URL = 'http://127.0.0.1:8788';
    process.env.ANTHROPIC_AUTH_TOKEN = 'papercusp-gateway';
    try {
      const a = tb.session('A');
      pointConfigRootAt(a);
      const d = makeDelivery({ subscriberId: a.ownerId, wakeHandle: advSessionHandle(a) });
      const out = await executeWake(
        d,
        resumeDeps(a, {
          getSession: async () =>
            ({
              pid: null,
              endedAt: new Date().toISOString(),
              agent: 'claude',
              sessionId: `native-${a.ownerId}`,
              ompThreadId: null,
              coordOwnerId: a.ownerId,
              cwd: a.cwd,
              launchArgv: ['psu', '--account=default'],
            }) as never,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const c = captured[0];
      expect(c.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('default');
      expect(c.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
      expect(c.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
      const settingsIndex = c.args.indexOf('--settings');
      expect(settingsIndex).toBeGreaterThan(-1);
      const settings = JSON.parse(c.args[settingsIndex + 1]);
      expect(settings.apiKeyHelper).toBe('');
      expect(settings.env.ANTHROPIC_BASE_URL).toBe('');
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe('');
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('EI-153: two same-cwd claude sessions — A\'s resume references ONLY A, B\'s ONLY B', async () => {
    const a = tb.session('A');
    const b = tb.session('B');
    // The EI-153 trap: identical cwd.
    expect(a.cwd).toBe(b.cwd);
    // …but distinct identities + distinct isolated config dirs.
    expect(a.ownerId).not.toBe(b.ownerId);
    expect(a.configDir).not.toBe(b.configDir);

    pointConfigRootAt(a); // shared root (both dirs live under it)

    await executeWake(makeDelivery({ subscriberId: a.ownerId, wakeHandle: advSessionHandle(a) }), resumeDeps(a));
    await executeWake(makeDelivery({ subscriberId: b.ownerId, wakeHandle: advSessionHandle(b) }), resumeDeps(b));

    expect(captured).toHaveLength(2);
    const [ca, cb] = captured;

    // A's resume targets A's conversation + A's dir, and NEVER mentions B.
    expect(ca.env.PAPERCUSP_SID).toBe(a.ownerId);
    expect(ca.env.CLAUDE_CONFIG_DIR).toBe(a.configDir);
    expect(ca.args).toContain(`native-${a.ownerId}`);
    expect(ca.args).not.toContain(`native-${b.ownerId}`);
    expect(ca.env.CLAUDE_CONFIG_DIR).not.toBe(b.configDir);
    expect(JSON.stringify(ca)).not.toContain(b.ownerId);

    // …and symmetrically for B.
    expect(cb.env.PAPERCUSP_SID).toBe(b.ownerId);
    expect(cb.env.CLAUDE_CONFIG_DIR).toBe(b.configDir);
    expect(cb.args).toContain(`native-${b.ownerId}`);
    expect(cb.args).not.toContain(`native-${a.ownerId}`);
    expect(JSON.stringify(cb)).not.toContain(a.ownerId);
  });

  it('EI-153 codex leg: per-session CODEX_HOME isolation across resume', async () => {
    const a = tb.session('A');
    const b = tb.session('B');
    pointCodexRootAt(a);

    // codex carries no native id on the row — executeWake recovers the conversation
    // uuid from the per-session CODEX_HOME's rollout. Drop a fake rollout in each.
    for (const s of [a, b]) {
      const sessionsDir = join(s.codexHome, 'sessions', '2026', '06');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, `rollout-2026-06-08-${randomUUID()}.jsonl`), '{}\n');
    }

    // Owner election made hermetic the same way as resumeDeps (WI-10008189).
    const codexDeps = (s: TestSession): ExecuteWakeDeps => {
      const deps = codexDepsRaw(s);
      return { ...deps, ...tb.ownerElectionDeps(deps) };
    };
    const codexDepsRaw = (s: TestSession): ExecuteWakeDeps => ({
      findPsuHost: tb.findPsuHostDep(),
      getSession: async () =>
        ({
          pid: null,
          endedAt: new Date().toISOString(),
          agent: 'codex',
          sessionId: null, // codex has no native id — recovered from the rollout
          ompThreadId: null,
          coordOwnerId: s.ownerId,
          cwd: s.cwd,
        }) as never,
      alive: () => false,
      // The production claim is intentionally outside this isolation fixture;
      // make the resume writer a winner so the test reaches the spawn seam.
      claimResume: async () => true,
      // WI-10002854: the real accountant writes the ledger row and adv pid to PG.
      accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: () => {} }),
      // Keep this filesystem-isolation test independent of the launch-spec PG
      // reader used by the production Codex-home repair helper.
      ensureCodexHomeForWake: async () => ({ ok: true, repaired: false }),
      spawnDetached: (bin, args, opts) => {
        captured.push({ bin, args, cwd: opts.cwd, env: opts.env });
        return 99;
      },
    });

    await executeWake(makeDelivery({ subscriberId: a.ownerId, wakeHandle: advSessionHandle(a, { agent: 'codex', sessionId: null }) }), codexDeps(a));
    await executeWake(makeDelivery({ subscriberId: b.ownerId, wakeHandle: advSessionHandle(b, { agent: 'codex', sessionId: null }) }), codexDeps(b));

    expect(captured).toHaveLength(2);
    const [ca, cb] = captured;
    expect(ca.bin).toBe('codex');
    // Each codex resume runs in its OWN per-session home — never the peer's.
    expect(ca.env.CODEX_HOME).toBe(a.codexHome);
    expect(cb.env.CODEX_HOME).toBe(b.codexHome);
    expect(ca.env.CODEX_HOME).not.toBe(cb.env.CODEX_HOME);
    expect(ca.env.PAPERCUSP_SID).toBe(a.ownerId);
    expect(cb.env.PAPERCUSP_SID).toBe(b.ownerId);
  });

  it('C1 discovery isolation: findLiveHost(A) never returns B\'s socket; a wake for A injects into A only', async () => {
    const a = tb.session('A');
    const b = tb.session('B');
    const hostA = await tb.spawnSocketHost(a.ownerId);
    const hostB = await tb.spawnSocketHost(b.ownerId);

    // Discovery is owner-keyed — A's socket is never B's.
    expect(tb.findHost(a.ownerId)!.sock).toBe(hostA.sock);
    expect(tb.findHost(b.ownerId)!.sock).toBe(hostB.sock);
    expect(tb.findHost(a.ownerId)!.sock).not.toBe(tb.findHost(b.ownerId)!.sock);

    // A handle-less wake for A injects into A's live socket — through the REAL
    // findLiveHost + injectIntoHost — and B's socket receives NOTHING.
    const out = await executeWake(
      makeDelivery({ subscriberId: a.ownerId, wakeHandle: null }),
      { findPsuHost: tb.findPsuHostDep(), presence: async () => null },
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(hostA.received).toHaveLength(1);
    expect(hostB.received).toHaveLength(0); // A's wake never reached B
  });

  it('C1: a wake for an owner with NO socket never falls onto a peer\'s live socket', async () => {
    const a = tb.session('A');
    const b = tb.session('B');
    // Only B has a live socket. A's wake must NOT be injected into B.
    const hostB = await tb.spawnSocketHost(b.ownerId);
    const sendCoordMessage = async () => ({}) as never;

    const out = await executeWake(
      makeDelivery({ subscriberId: a.ownerId, wakeHandle: null }),
      { findPsuHost: tb.findPsuHostDep(), presence: async () => null, sendCoordMessage },
    );
    // No socket for A, no presence → degrades to a coord inbox notification
    // for A (P-001), NEVER onto B's socket.
    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(hostB.received).toHaveLength(0);
  });
});
