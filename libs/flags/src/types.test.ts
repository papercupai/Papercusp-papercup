/**
 * types.test.ts — the flag registry invariants + `resolveWithDefaults`, the
 * single helper every read path (client + server) funnels through so a partial
 * payload never drops a flag. Pure unit, no env/network.
 *
 * Why this matters: a flag string typo or a missing FLAG_DEFAULTS entry would
 * desync PostHog (keyed by the exact string) from the bundled fallback, and the
 * gate would silently read the wrong default. These assertions pin the drift.
 */
import { describe, expect, it } from 'vitest';
import {
  FLAGS,
  FLAG_DEFAULTS,
  DARK_FLAGS,
  ALL_FLAG_KEYS,
  resolveWithDefaults,
  type FlagKey,
} from './types';

describe('flag registry invariants', () => {
  it('ALL_FLAG_KEYS is exactly the FLAGS string values (no drift)', () => {
    expect([...ALL_FLAG_KEYS].sort()).toEqual([...Object.values(FLAGS)].sort());
  });

  it('every flag string value is unique', () => {
    const vals = Object.values(FLAGS);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('every flag key uses the canonical `papercusp-` prefix', () => {
    for (const key of ALL_FLAG_KEYS) {
      expect(key.startsWith('papercusp-')).toBe(true);
    }
  });

  it('FLAG_DEFAULTS has a boolean for exactly the FLAGS keys', () => {
    expect(Object.keys(FLAG_DEFAULTS).sort()).toEqual([...ALL_FLAG_KEYS].sort());
    for (const key of ALL_FLAG_KEYS) {
      expect(typeof FLAG_DEFAULTS[key]).toBe('boolean');
    }
  });

  it('cut-for-V1 flags stay OFF by default (alpha policy: flags for shipped features default ON — CLAUDE.md "Feature flags")', () => {
    // The old invariant ("every flag defaults false") encoded the pre-alpha
    // dark-launch policy and was retired 2026-06-09 by owner directive: a flag
    // created alongside a finished feature now defaults true. Only the
    // cut-for-V1 surfaces are pinned off here.
    const cutForV1: FlagKey[] = [
      FLAGS.CLOUDFLARE_PUBLISH,
      FLAGS.HARNESS_PHASES,
      FLAGS.DESIGN,
      FLAGS.TESTING,
    ];
    for (const key of cutForV1) {
      expect(FLAG_DEFAULTS[key]).toBe(false);
    }
  });

  it('security flags stay OFF by default (deliberate exceptions to the alpha default-ON policy)', () => {
    // Open signup is internet-reachable attack surface (the cloudflared
    // tunnel) — the signup route's zero-users bootstrap path covers fresh
    // installs, so default-OFF costs nothing.
    expect(FLAG_DEFAULTS[FLAGS.OPEN_SIGNUP]).toBe(false);
    expect(FLAG_DEFAULTS[FLAGS.TUTORIAL_VOICE_ISSUANCE]).toBe(false);
    expect(DARK_FLAGS.get(FLAGS.TUTORIAL_VOICE_ISSUANCE)?.case).toBe('owner-authority');
    expect(FLAG_DEFAULTS[FLAGS.PLUGIN_INVOCATION_POLICY]).toBe(false);
    expect(DARK_FLAGS.get(FLAGS.PLUGIN_INVOCATION_POLICY)?.case).toBe('owner-authority');
    expect(DARK_FLAGS.get(FLAGS.PLUGIN_INVOCATION_POLICY)?.reason).toContain('P-019');
  });

  it('endpoint authorization tiers stay ON by default', () => {
    // EI-100: route-stack tests deliberately exercise the emergency OFF lever,
    // but production must enforce every declared RouteAuth tier unless an
    // operator explicitly flips that kill switch.
    expect(FLAG_DEFAULTS[FLAGS.ENDPOINT_AUTH_TIERS]).toBe(true);
  });

  it('the acceptance-rubric completion gate is default-ON and not dark', () => {
    expect(FLAG_DEFAULTS[FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE]).toBe(true);
    expect(DARK_FLAGS.has(FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE)).toBe(false);
  });

  it('deterministic maintenance carry defaults ON with an explicit false kill-switch', () => {
    expect(FLAG_DEFAULTS[FLAGS.GATEWAY_MAINTENANCE_CARRY]).toBe(true);
    expect(resolveWithDefaults({ [FLAGS.GATEWAY_MAINTENANCE_CARRY]: false })[
      FLAGS.GATEWAY_MAINTENANCE_CARRY
    ]).toBe(false);
  });

  it('fleet-leader profile auto-arm defaults ON with an explicit false kill-switch', () => {
    expect(FLAG_DEFAULTS[FLAGS.FLEET_LEADER_PROFILE_AUTO_ARM]).toBe(true);
    expect(resolveWithDefaults({ [FLAGS.FLEET_LEADER_PROFILE_AUTO_ARM]: false })[
      FLAGS.FLEET_LEADER_PROFILE_AUTO_ARM
    ]).toBe(false);
  });

  it("plan clean-up ships ON and still honours the explicit kill switch", () => {
    expect(FLAG_DEFAULTS[FLAGS.PLAN_CLEANUP]).toBe(true);
    expect(
      resolveWithDefaults({ [FLAGS.PLAN_CLEANUP]: false })[FLAGS.PLAN_CLEANUP],
    ).toBe(false);
  });
});

describe('resolveWithDefaults', () => {
  it('with an empty partial, returns a full copy of FLAG_DEFAULTS', () => {
    const out = resolveWithDefaults({});
    expect(out).toEqual(FLAG_DEFAULTS);
    // a fresh object, not the shared const
    expect(out).not.toBe(FLAG_DEFAULTS);
  });

  it('applies supplied boolean overrides over the defaults', () => {
    const out = resolveWithDefaults({ [FLAGS.TESTING]: true });
    expect(out[FLAGS.TESTING]).toBe(true);
    expect(out[FLAGS.DESIGN]).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]);
  });

  it('honours an explicit false override (not treated as "unset")', () => {
    // An explicit `false` must be applied (the guard keys off `typeof === boolean`,
    // not truthiness) — distinct from an absent key, which keeps the default.
    const out = resolveWithDefaults({ [FLAGS.TESTING]: false });
    expect(out[FLAGS.TESTING]).toBe(false);
  });

  it('ignores non-boolean values (undefined / null / string) and keeps the default', () => {
    const partial = {
      [FLAGS.CLOUDFLARE_PUBLISH]: undefined,
      [FLAGS.DESIGN]: null as unknown as boolean,
      [FLAGS.TESTING]: 'yes' as unknown as boolean,
    };
    const out = resolveWithDefaults(partial);
    expect(out[FLAGS.CLOUDFLARE_PUBLISH]).toBe(FLAG_DEFAULTS[FLAGS.CLOUDFLARE_PUBLISH]);
    expect(out[FLAGS.DESIGN]).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]);
    expect(out[FLAGS.TESTING]).toBe(FLAG_DEFAULTS[FLAGS.TESTING]);
  });

  it('ignores unknown keys not in ALL_FLAG_KEYS', () => {
    const out = resolveWithDefaults({
      'papercusp-not-a-real-flag': true,
    } as Partial<Record<FlagKey, boolean>>);
    expect(out).toEqual(FLAG_DEFAULTS);
    expect((out as Record<string, boolean>)['papercusp-not-a-real-flag']).toBeUndefined();
  });

  it('does not mutate FLAG_DEFAULTS', () => {
    const before = { ...FLAG_DEFAULTS };
    resolveWithDefaults({ [FLAGS.TESTING]: true, [FLAGS.DESIGN]: false });
    expect(FLAG_DEFAULTS).toEqual(before);
  });

  it('always resolves to the full key set, whatever the partial', () => {
    const out = resolveWithDefaults({ [FLAGS.TESTING]: true });
    expect(Object.keys(out).sort()).toEqual([...ALL_FLAG_KEYS].sort());
  });
});
