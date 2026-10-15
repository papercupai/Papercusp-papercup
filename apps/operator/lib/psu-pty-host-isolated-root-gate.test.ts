/**
 * psu-pty-turn-boundary-generalization-2026-09-22 D-002 — a turn-boundary classifier may
 * read only a PER-SESSION ISOLATED native root, never a shared one.
 *
 * WHY THIS IS THE DANGEROUS ONE. Turn-boundary verification decides whether a wake may be
 * injected now. It answers that by reading the agent's own native transcript. A shared
 * root (`~/.claude`, `~/.codex`) holds EVERY session's transcripts on this box, so a
 * classifier that fell back to one would certify a boundary from a STRANGER's activity:
 * another agent finishing a turn would release this session's inject mid-turn. The
 * failure is silent, plausible-looking, and would present as "wakes sometimes land at the
 * wrong moment" — the hardest possible thing to trace back to a root-resolution fallback.
 *
 * WHY THIS FILE EXISTS. D-002 ruled the constraint and the code implements it
 * (`nativeTurnVerifierSupport` returns 'no-isolated-root' unless the backend's
 * per-session env var is set, and `nativeTurnCompletedInTranscript` refuses on that),
 * but at the acceptance pass NO test asserted it — the ruling had no guard. A constraint
 * enforced only by the current shape of the code is one refactor away from being gone,
 * and this one fails quietly when it goes.
 *
 * REGISTRY-DRIVEN ON PURPOSE. The negative assertions ENUMERATE `TURN_ROW_CLASSIFIERS`
 * rather than naming the two backends that exist today, so a third backend registered
 * later is held to D-002 automatically instead of inheriting an exemption nobody chose.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TURN_ROW_CLASSIFIERS,
  nativeTurnCompletedInTranscript,
  nativeTurnVerifierSupport,
} from '../scripts/psu-pty-host.mjs';

const REGISTERED_AGENTS = Object.keys(TURN_ROW_CLASSIFIERS);

describe('D-002 — native turn verification is gated on a per-session isolated root', () => {
  it('positive control: the gate can say YES, so the refusals below are not vacuous', () => {
    // A guard whose subject always returns false would pass every assertion in this file
    // while enforcing nothing. Prove the function discriminates before trusting it.
    expect(REGISTERED_AGENTS.length).toBeGreaterThanOrEqual(2);
    expect(nativeTurnVerifierSupport('claude', { CLAUDE_CONFIG_DIR: '/tmp/isolated-claude-root' })).toEqual({
      supported: true,
      reason: null,
    });
  });

  it.each(REGISTERED_AGENTS)(
    'refuses %s with no isolated root — it must NOT fall back to the shared native root',
    (agent) => {
      expect(nativeTurnVerifierSupport(agent, {})).toEqual({
        supported: false,
        reason: 'no-isolated-root',
      });
    },
  );

  it.each(REGISTERED_AGENTS)(
    'verification of %s FAILS SOFT when no isolated root is configured, whatever transcript it is pointed at',
    (agent) => {
      // The refusal must happen at the support gate, BEFORE any path resolution — so a
      // caller handing it a transcript path cannot route it into a shared root.
      expect(
        nativeTurnCompletedInTranscript({
          agent,
          env: {},
          transcriptPath: '/tmp/some-other-sessions-transcript.jsonl',
          receivedAtMs: 0,
          nowMs: 1,
        }),
      ).toBe(false);
    },
  );

  it('control: the assertion shape CATCHES a gate that falls back to the shared root', () => {
    // The subject here is an imported module, so falsifiability cannot be shown by
    // mutating the source file (and mutating this swept shared tree is forbidden
    // outright). The sanctioned substitute is a deliberately-wrong implementation kept
    // permanently beside the real one: if this control ever stops failing the assertion,
    // the assertion has stopped being able to detect the regression it exists for.
    // Derived, never hardcoded: a literal home path is wrong on every machine but one
    // and reds the identity-lint gate leg for the whole fleet.
    const shared = join(homedir(), '.claude');
    const naiveSupportThatFallsBack = (agent: string, env: Record<string, string>) => {
      const root = env.CLAUDE_CONFIG_DIR ?? shared; // ⛔ the exact bug D-002 forbids
      const registry = TURN_ROW_CLASSIFIERS as Record<string, unknown>;
      return registry[agent] && root
        ? { supported: true, reason: null }
        : { supported: false, reason: 'no-classifier' };
    };

    for (const agent of REGISTERED_AGENTS) {
      // The real gate refuses; the naive fallback would have said yes for claude.
      expect(nativeTurnVerifierSupport(agent, {})).toEqual({ supported: false, reason: 'no-isolated-root' });
    }
    expect(naiveSupportThatFallsBack('claude', {})).toEqual({ supported: true, reason: null });
    expect(naiveSupportThatFallsBack('claude', {})).not.toEqual(nativeTurnVerifierSupport('claude', {}));
  });

  it('keeps the two negative reasons distinct — a misconfigured session must not hide among legitimately-unsupported ones', () => {
    // 'no-classifier' is a permanent capability gap; 'no-isolated-root' is a fixable
    // misconfiguration. OMP has a classifier, so missing PI_CONFIG_DIR is a root miss.
    expect(nativeTurnVerifierSupport('omp', {})).toEqual({ supported: false, reason: 'no-isolated-root' });
    expect(nativeTurnVerifierSupport(undefined, {})).toEqual({ supported: false, reason: 'no-classifier' });
    // OMP requires its own PI_CONFIG_DIR root; roots for other backends do not satisfy it.
    expect(nativeTurnVerifierSupport('omp', { CODEX_HOME: '/tmp/x', CLAUDE_CONFIG_DIR: '/tmp/y' })).toEqual({
      supported: false,
      reason: 'no-isolated-root',
    });
    expect(nativeTurnVerifierSupport('omp', { PI_CONFIG_DIR: '/tmp/isolated-omp' })).toEqual({
      supported: true,
      reason: null,
    });
    // Even every known root cannot manufacture a classifier for an unknown backend.
    expect(nativeTurnVerifierSupport(undefined, {
      CODEX_HOME: '/tmp/x', CLAUDE_CONFIG_DIR: '/tmp/y', PI_CONFIG_DIR: '/tmp/z',
    })).toEqual({ supported: false, reason: 'no-classifier' });
  });
});
