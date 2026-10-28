/**
 * The guard that keeps TARGET_ROLE_SPEND honest
 * (agents-system-pane-split-2026-07-26 P-002).
 *
 * D-002 chose a STATIC table over reading a `spends` field off the live registry,
 * because the left rail needs these as browser-safe values and a request-only host
 * may not have the background registry loaded at all. The cost of a static table is
 * that it can drift; this test is what pays it.
 *
 * It imports the registry for its side effects (every `registerSystemAction(...)`
 * call runs at module load), enumerates it, and fails in BOTH directions:
 *
 *   • a NEW system action with no classification — the pane would render it
 *     `unknown`, which is at least honest, but the person adding the action is the
 *     one who knows whether it spawns a model, so make them say so here;
 *   • a classification for an action that no longer exists — dead rows in the table
 *     are how a map like this rots into fiction.
 *
 * The failure message names the exact keys to add or remove, because a bare set
 * difference in a diff of 50 entries is not actionable.
 */
import { describe, expect, it } from 'vitest';
import { getSystemActionEntry, listStandingSystemActions, listSystemActions } from '../harness/routines/system-actions';
import { SENTINEL_TARGET_ROLES, TARGET_ROLE_SPEND } from './routine-classification';

// Side-effect import: populates the registry. Must come after the imports above so
// the registry is loaded by the time the assertions run.
import '../harness/routines/register-system-actions';

/** `system:<action>` for every handler the routines engine can dispatch inline. */
function registeredTargetRoles(): string[] {
  return listSystemActions().map((name) => (name.startsWith('system:') ? name : `system:${name}`));
}

describe('TARGET_ROLE_SPEND vs the live system-action registry', () => {
  it('keeps conditional/manual actions on-demand and required seed actions standing', () => {
    const onDemand = [
      'foreign-git-sync',
      'gate-canary-sweep',
      'oddsmith-error-triage-autofix',
      'oddsmith-error-triage-ingest',
      'oddsmith-paper-cycle',
      'unshipped-plans-audit',
    ];
    const standing = [
      'improvement-correction-decay',
      'intake-triage-drain',
      'plan-anchor-freshness',
      'resolver-whole-corpus',
      'sweep-orphaned-foreign-harnesses',
    ];
    const liveStanding = new Set(listStandingSystemActions());
    for (const name of onDemand) {
      expect(getSystemActionEntry(name)?.scheduling, name).toBe('on-demand');
      expect(liveStanding.has(name), name).toBe(false);
    }
    for (const name of standing) {
      expect(getSystemActionEntry(name)?.scheduling, name).toBe('standing');
      expect(liveStanding.has(name), name).toBe(true);
    }
  });
  it('loads the registry (guards against a silent no-op import)', () => {
    // If the side-effect import ever stops registering — a moved file, a tree-shaken
    // import — every other assertion here would trivially pass against an empty set.
    expect(listSystemActions().length).toBeGreaterThan(20);
  });

  it('classifies every registered system action', () => {
    const unclassified = registeredTargetRoles().filter((role) => !(role in TARGET_ROLE_SPEND));
    expect(
      unclassified,
      `These system actions have no spend classification. Add each to TARGET_ROLE_SPEND in ` +
        `lib/automation/routine-classification.ts with { spend: 'llm' | 'none', why }. ` +
        `Rule: 'llm' means a fire can DIRECTLY bill model turns — it spawns an agent, ` +
        `launches or wakes a session, or dispatches queued work to the pipeline.\n  ` +
        unclassified.join('\n  '),
    ).toEqual([]);
  });

  it('carries no classification for an action that no longer exists', () => {
    const live = new Set([...registeredTargetRoles(), ...SENTINEL_TARGET_ROLES]);
    const stale = Object.keys(TARGET_ROLE_SPEND).filter((role) => !live.has(role));
    expect(
      stale,
      `These TARGET_ROLE_SPEND entries match no registered system action and no sentinel. ` +
        `Remove them, or add the sentinel to SENTINEL_TARGET_ROLES if it is a target_role ` +
        `with no inline handler (like system:loop-wake).\n  ` + stale.join('\n  '),
    ).toEqual([]);
  });
});
