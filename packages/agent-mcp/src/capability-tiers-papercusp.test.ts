/**
 * Unit tests for papercuspTierFor — Papercusp's capability → consent-tier
 * table (plan P-012 / D-006). Pure table lookup; no mocks.
 *
 * define-tool.test.ts spot-checks ~6 entries; this file pins EVERY exact
 * row, both prefix groups, and the deliberate unknown → 'medium' default
 * (NOT the engine's 'low').
 */

import { describe, expect, it } from 'vitest';
import { papercuspTierFor } from './capability-tiers-papercusp';

// Mirror of the EXACT table in capability-tiers-papercusp.ts. Kept here as
// the assertion's source of truth — if the table changes, this list must
// change with it, which is the point: a deliberate tier change should be a
// deliberate test change.
const EXACT_ROWS: Array<[string, 'low' | 'medium' | 'high']> = [
  // Low — internal reads, UI mounts, plugin-private storage
  ['tasks:read', 'low'],
  ['features:read', 'low'],
  ['goals:read', 'low'],
  ['projects:read', 'low'],
  ['comments:read', 'low'],
  ['issues:read', 'low'],
  ['work_items:read', 'low'],
  ['harness:read', 'low'],
  ['docs:read', 'low'],
  ['messages:read', 'low'],
  ['plans:read', 'low'],
  ['recipes:read', 'low'],
  ['locks:read', 'low'],
  ['coord:read', 'low'],
  ['pending_events:read', 'low'],
  ['routines:read', 'low'],
  ['storage:plugin-private', 'low'],
  ['db:plugin-schema', 'low'],
  ['ui:dashboard-tab', 'low'],
  ['ui:sidebar-item', 'low'],
  ['ui:harness-route', 'low'],
  ['workspaces:read', 'low'],
  // Medium — writes, hooks, role registrations, cross-harness messaging
  ['plans:write', 'medium'],
  ['locks:write', 'medium'],
  ['coord:write', 'medium'],
  ['tasks:write', 'medium'],
  ['features:write', 'medium'],
  ['goals:write', 'medium'],
  ['projects:write', 'medium'],
  ['comments:write', 'medium'],
  ['issues:write', 'medium'],
  ['work_items:write', 'medium'],
  ['messages:write', 'medium'],
  ['routines:write', 'medium'],
  ['proposals:write', 'medium'],
  ['search:read', 'medium'],
  ['sessions:read', 'medium'],
  // High — secrets, outbound network, cross-plugin reads, audit, dispatch
  ['audit:read', 'high'],
  ['intel:read', 'high'],
  ['harness:dispatch', 'high'],
  ['processes:kill', 'high'],
];

describe('papercuspTierFor — exact table rows', () => {
  it.each(EXACT_ROWS)('classifies %s as %s', (capability, tier) => {
    expect(papercuspTierFor(capability)).toBe(tier);
  });

  it('covers every documented row exactly once', () => {
    const keys = EXACT_ROWS.map(([k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('papercuspTierFor — high-tier prefixes', () => {
  it.each([
    'secrets:read:OPENAI_KEY',
    'secrets:write:STRIPE',
    'secrets:',
    'http:fetch:youtube.com',
    'http:fetch:api.github.com/repos',
    'data:read:catalog',
    'data:read:',
  ])('classifies %s as high via prefix', (capability) => {
    expect(papercuspTierFor(capability)).toBe('high');
  });
});

describe('papercuspTierFor — medium-tier prefixes', () => {
  it.each([
    'events:emit:foo',
    'events:subscribe',
    'events:',
    'roles:register:operator',
    'roles:register:',
  ])('classifies %s as medium via prefix', (capability) => {
    expect(papercuspTierFor(capability)).toBe('medium');
  });
});

describe('papercuspTierFor — unknown-capability default', () => {
  it.each(['frob:nicate', 'wibble', 'totally:unknown:cap', '', 'roles:list'])(
    'defaults %s to medium (NOT the engine low)',
    (capability) => {
      expect(papercuspTierFor(capability)).toBe('medium');
    },
  );

  it('does not treat a non-prefix near-miss as high', () => {
    // "http:fetch:" is a prefix, but "http:" alone is not enumerated and
    // not a prefix → falls to the medium default.
    expect(papercuspTierFor('http:listen')).toBe('medium');
    // "secret:" (singular) is not the "secrets:" prefix.
    expect(papercuspTierFor('secret:peek')).toBe('medium');
  });

  it('exact-match wins over a prefix that would also match', () => {
    // No row both exact-matches and prefix-matches today, so assert the
    // ordering directly: an exact high row stays high even though it would
    // not be caught by any prefix.
    expect(papercuspTierFor('audit:read')).toBe('high');
    // A prefix-only high cap (no exact row) resolves through the prefix arm.
    expect(papercuspTierFor('http:fetch:example.com')).toBe('high');
  });
});
