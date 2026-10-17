/**
 * Unit tests for the PURE surface of condition-bridge.ts (P-003 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * The write paths need Postgres and belong to P-008's integration suite. What is
 * testable here without a database is the part most likely to rot: the opt-in
 * catalog and the terminal-status derivation.
 */
import { describe, it, expect } from 'vitest';
import {
  isActionableConditionKey,
  isTerminalStatus,
  resolveConditionHarness,
  ACTIONABLE_CONDITION_PREFIXES,
  ACTIONABLE_CONDITIONS,
} from './condition-bridge';
import { gateRedStreakConditionKey, gateStallConditionKey } from './gate-ownership';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

describe('isActionableConditionKey', () => {
  it('admits the real condition keys emitted by the live watchdogs', () => {
    // Every one of these was read off a `conditionKey:` template in the source,
    // not invented: green-stall-watchdog.ts and single-primary-check.ts.
    for (const key of [
      'green-stall:papercusp',
      'main-behind-staging:papercusp',
      'release-trigger-freeze:papercusp',
      'release-trigger-fire-stale:papercusp',
      'single-primary:no-primary',
      'single-primary:split-brain-primary',
      'single-primary:no-dedicated-primary',
      // P-005: emitted by trackGateStall (harness/routines/release-actions.ts).
      'gate-red-streak:papercusp',
      'github-bridge-agent-actionable:papercusp',
      'frozen-repair-convergence:papercusp',
      'frozen-repair-leg:papercusp:lint:tsc',
    ]) {
      expect(isActionableConditionKey(key)).toBe(true);
    }
  });

  it('⭐ P-005: the key the PRODUCER emits is the key the catalog admits', () => {
    // The whole value of the opt-in is that a red gate mints an owning work-item, and
    // that depends on two strings in two modules agreeing. Asserting the literal
    // 'gate-red-streak:papercusp' above cannot catch a rename of the producer's key
    // function — it would keep passing while the live gate silently stopped minting
    // anything, which is indistinguishable from the pre-P-005 behaviour this item
    // exists to fix. So test the composed key, not a copy of it.
    const key = gateRedStreakConditionKey('papercusp');
    expect(isActionableConditionKey(key)).toBe(true);
    // ...and the harness must be recoverable from it, or the bridge files the item
    // under a harness nobody queries (the failure mode `harnessFrom` documents).
    expect(resolveConditionHarness(key, 'some-other-ambient')).toBe('papercusp');
  });

  it('P-005: the red-streak condition is NOT the stall condition', () => {
    // They describe opposite gate states (producing reds vs. producing nothing) and
    // are deliberately separate keys — a re-point would violate D-012/D-013 and
    // silently move the ownership block on gate.greenCheckpoint.verdict.
    expect(gateRedStreakConditionKey('papercusp')).not.toBe(gateStallConditionKey('papercusp'));
  });

  it('rejects keys that are not opted in, so a transient condition mints nothing', () => {
    // A condition that flaps within a tick would otherwise mint and immediately
    // close an item on every flap — strictly worse than the duplicate filing
    // this plan exists to fix.
    for (const key of [
      'scorecard-emission-wedge',
      'embed-space-desync',
      'kettle-invalid-model-config',
      // Broad attention alarms are not an admission identity. They may still
      // broadcast through the condition rail, but only explicit durable
      // condition families can mint owning scheduler work.
      'alarm:resource-health:papercusp',
      'alarm:loop-dead-man:rt_papercusp_loop_fixture',
      'alarm:release-gate-no-verdict:papercusp',
    ]) {
      expect(isActionableConditionKey(key)).toBe(false);
    }
  });

  it('rejects empty / whitespace keys rather than matching a bare prefix', () => {
    expect(isActionableConditionKey('')).toBe(false);
    expect(isActionableConditionKey('   ')).toBe(false);
  });

  it('matches on prefix, so a new harness slug needs no catalog edit', () => {
    expect(isActionableConditionKey('green-stall:some-brand-new-harness')).toBe(true);
  });

  it('does not match a prefix appearing mid-key', () => {
    // Guards against a sloppy `includes()` — a key merely MENTIONING a condition
    // is not that condition.
    expect(isActionableConditionKey('mirror-of-green-stall:papercusp')).toBe(false);
  });

  it('every catalog entry is a namespaced prefix, not a bare key', () => {
    // conditionKeys are `<family>:<subject>`; a prefix without the colon would
    // match far more than intended.
    for (const p of ACTIONABLE_CONDITION_PREFIXES) expect(p.endsWith(':')).toBe(true);
  });
});

describe('isTerminalStatus derives from the shared SSOT', () => {
  it('treats every canonical terminal status as settled', () => {
    for (const s of ANY_FAMILY_TERMINAL_STATES) expect(isTerminalStatus(s)).toBe(true);
  });

  it('does not treat live states as settled', () => {
    for (const s of ['open', 'todo', 'wip', 'blocked', 'needs-human']) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  it('treats null/undefined as NOT settled — unknown means possibly still live', () => {
    // Conservative on purpose: reporting an unknown row as a live owner costs a
    // duplicate at worst, while treating it as settled would release a key out
    // from under a real owner.
    expect(isTerminalStatus(null)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  it('does not re-list the terminal words (drift guard)', async () => {
    // EI-18653071581558556: hand-copied terminal unions drift. A stale copy
    // missing done/dropped scored 15 of 17 finished units as stranded (~88%
    // phantoms). This module must import the set, never spell it.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./condition-bridge.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/ANY_FAMILY_TERMINAL_STATES/);
    // The literal terminal words must not appear as a quoted list in code.
    expect(code).not.toMatch(/'passed'\s*,\s*'deprecated'/);
    expect(code).not.toMatch(/'resolved'\s*,\s*'closed'/);
    // ...and openness must never be re-derived from closed_ts (D-010).
    expect(code).not.toMatch(/closed_ts/);
  });

  // REGRESSION GUARD for the work-item leak. `releaseConditionOwner` defaults
  // settle:false so a caller can keep an item open for a post-mortem. For the
  // RECONCILER those are not separable: release-without-settle leaves one
  // permanently-open work-item per condition EPISODE, which is the duplicate
  // filing this plan exists to eliminate, reintroduced through the exit path.
  // Measured flapper in the actionable set: main-behind-staging:papercusp
  // resolved 15:45Z and re-opened 18:30Z on 2026-08-02 alone.
  it('reconcileConditions SETTLES the owning item on resolve, not just releases the key', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./condition-bridge.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function reconcileConditions'));
    const release = body.slice(body.indexOf('releaseConditionOwner('));
    expect(release.slice(0, 400)).toMatch(/settle:\s*true/);
  });

  /**
   * REGRESSION GUARD for the OPPOSITE failure of the one above (EI-19395923444306887).
   *
   * The reconciler must ALWAYS settle on resolve (previous test) and must NEVER
   * auto-close a hand-filed root-cause bug that merely holds the same condition_key.
   * Both are true only because the settle is gated on the bridge-mint marker: a
   * condition clearing is not the same event as the bug being fixed, so an ungated
   * settle would destroy a documented finding on the reconciler's 5-minute cadence.
   *
   * Source-text rather than behavioral because the settle path needs a live store;
   * what is worth pinning is that the GATE still surrounds the close, since the
   * tempting future edit is to "simplify" it away while adopting a hand-filed item.
   */
  it('gates the settle on the bridge-mint marker — never auto-closes a hand-filed item', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./condition-bridge.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function releaseConditionOwner'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);

    // The close must be REACHED THROUGH the marker check, not merely near it.
    const gate = fn.indexOf('isBridgeMinted');
    const close = fn.indexOf("'done'");
    expect(gate, 'releaseConditionOwner must consult isBridgeMinted').toBeGreaterThan(-1);
    expect(close, 'releaseConditionOwner must still be able to settle').toBeGreaterThan(-1);
    expect(gate, 'the marker check must precede the close').toBeLessThan(close);

    // ...and the un-stamped branch must release the key WITHOUT closing.
    expect(fn).toMatch(/settleSkipped\s*=\s*'not-bridge-minted'/);
  });

  it('stamps every bridge-minted item, or the gate above can never open', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./condition-bridge.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function acquireConditionOwner'));
    const mint = body.slice(body.indexOf('createWorkItem('));
    const callEnd = mint.indexOf('} as Parameters<typeof createWorkItem>[0]);');
    expect(callEnd, 'the bridge mint must keep one inspectable createWorkItem call').toBeGreaterThan(-1);
    expect(mint.slice(0, callEnd)).toMatch(/payload:\s*\{\s*\[BRIDGE_MINT_MARKER\]/);
  });

  it('fails SAFE — isBridgeMinted returns false rather than throwing on a store error', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./condition-bridge.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function isBridgeMinted'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    // An unreadable payload must read as NOT-minted: the worst outcome is then a
    // stale-open incident item, never a destroyed bug report.
    expect(fn).toMatch(/catch\s*\{[\s\S]*return false/);
  });
});

describe('resolveConditionHarness', () => {
  it('reads the harness from the suffix for slug-suffixed families', () => {
    expect(resolveConditionHarness('green-stall:oddsmith', 'papercusp')).toBe('oddsmith');
    expect(resolveConditionHarness('main-behind-staging:papercusp', 'x')).toBe('papercusp');
  });

  // REGRESSION GUARD: `single-primary:${verdict.key}` is a VERDICT suffix.
  // Parsing it as a slug files the item into harness 'no-primary', which
  // createWorkItem accepts without validation and nothing ever surfaces.
  it('does NOT treat a verdict suffix as a harness', () => {
    expect(resolveConditionHarness('single-primary:no-primary', 'papercusp')).toBe('papercusp');
  });

  it('fails CLOSED — null when no harness can be established', () => {
    expect(resolveConditionHarness('single-primary:no-primary', null)).toBeNull();
    expect(resolveConditionHarness('single-primary:no-primary', '  ')).toBeNull();
  });

  it('returns null for a key that is not opted in at all', () => {
    expect(resolveConditionHarness('infra-liveness:panel:bees', 'papercusp')).toBeNull();
  });

  it('every catalog entry declares how its harness is derived', () => {
    for (const c of ACTIONABLE_CONDITIONS) {
      expect(c.prefix.endsWith(':')).toBe(true);
      expect(['suffix', 'ambient', 'leading-segment']).toContain(c.harnessFrom);
    }
  });

  // P-013 (green-main-cycle-time-2026-10-08): a leg key is `<pipeline>:<leg>` and the
  // leg may itself contain ':' — only the FIRST segment names the harness.
  it('reads a leading-segment harness even when the detail contains colons', () => {
    expect(resolveConditionHarness('frozen-repair-leg:papercusp:lint:tsc', 'x')).toBe('papercusp');
    expect(
      resolveConditionHarness('frozen-repair-leg:papercusp:packages/a/b.test.ts', null),
    ).toBe('papercusp');
  });

  it('fails CLOSED on a leading-segment key with no harness or no detail', () => {
    expect(resolveConditionHarness('frozen-repair-leg:papercusp', 'papercusp')).toBeNull();
    expect(resolveConditionHarness('frozen-repair-leg::lint:tsc', 'papercusp')).toBeNull();
    expect(resolveConditionHarness('frozen-repair-leg:papercusp:', 'papercusp')).toBeNull();
  });
});
