/**
 * Unit tests for the agent-mcp `?tools=` allowlist (voice-persona P-009).
 *
 * The load-bearing property: an explicit `?tools=` request narrows the
 * operator's surface to its working set, while EVERY other spawn (worker /
 * scoper / validator / a bare probe — no `?tools=`) keeps its full role
 * surface untouched. These tests pin both halves so a future edit to the
 * filter can't silently shrink a non-operator surface.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { compactInputSchema, compactWireBytes, summaryGuidanceDescription } from '@papercusp/tooldef';
import {
  parseToolsAllowlist,
  filterListingsByAllowlist,
  getSessionSurface,
  activateSessionTools,
  applyCompactTier,
  rememberSessionToolRegistryRevision,
  sessionToolRegistryRevisionState,
  sessionToolRegistryRevisionChanged,
  __resetSessionSurfaces,
} from './tool-allowlist';

// A stand-in for the agent-mcp `tools/list` projections: the real
// listMcpProjections() returns `{ name, description, inputSchema, ... }`;
// the filter only reads `.name`, so a `{ name }` shape exercises it faithfully
// without booting the full projection registry (DB clients, side-effect loads).
const SURFACE = [
  { name: 'harness:status' },
  { name: 'harness:list' },
  { name: 'work_items:list' },
  { name: 'chat:ask_choice' },
  { name: 'plans:get' },
  { name: 'features:get' }, // not in the operator set — a cross-role tool
  { name: 'work_items:set_state' }, // not in the operator set
];

describe('parseToolsAllowlist', () => {
  it('returns null when the param is absent (no filtering)', () => {
    expect(parseToolsAllowlist(null)).toBeNull();
    expect(parseToolsAllowlist(undefined)).toBeNull();
  });

  it('returns null for an empty / whitespace-only param', () => {
    expect(parseToolsAllowlist('')).toBeNull();
    expect(parseToolsAllowlist('   ')).toBeNull();
    expect(parseToolsAllowlist(' , , ')).toBeNull();
  });

  it('parses comma-separated colon names, trimming whitespace and blanks', () => {
    const set = parseToolsAllowlist('harness:status, harness:list ,,chat:ask_choice');
    expect(set).toEqual(new Set(['harness:status', 'harness:list', 'chat:ask_choice']));
  });
});

describe('filterListingsByAllowlist', () => {
  it('returns the FULL surface untouched when the allowlist is null (worker/scoper/probe)', () => {
    const out = filterListingsByAllowlist(SURFACE, null);
    expect(out).toEqual(SURFACE);
    expect(out).toHaveLength(SURFACE.length);
  });

  it('narrows to exactly the named tools when an allowlist is given (operator)', () => {
    const allow = parseToolsAllowlist('harness:status,harness:list,work_items:list,chat:ask_choice,plans:get');
    const out = filterListingsByAllowlist(SURFACE, allow);
    expect(out.map((t) => t.name)).toEqual([
      'harness:status',
      'harness:list',
      'work_items:list',
      'chat:ask_choice',
      'plans:get',
    ]);
    // The cross-role tools NOT named are excluded — that's the deferral fix.
    expect(out.map((t) => t.name)).not.toContain('features:get');
    expect(out.map((t) => t.name)).not.toContain('work_items:set_state');
  });

  it('ignores unknown names in the allowlist (a stale name never hides the rest)', () => {
    const allow = parseToolsAllowlist('harness:status,does:not_exist');
    const out = filterListingsByAllowlist(SURFACE, allow);
    expect(out.map((t) => t.name)).toEqual(['harness:status']);
  });

  it('resolves a legacy Claude MCP reference to its unique current listing', () => {
    const listings = [{ name: 'plans:audit' }, { name: 'plans:get' }];
    const allow = parseToolsAllowlist('mcp__papercusp-su__plans_audit');
    expect(filterListingsByAllowlist(listings, allow)).toEqual([{ name: 'plans:audit' }]);
  });

  it('does not expose ambiguous normalized aliases', () => {
    const listings = [{ name: 'plans:foo-bar' }, { name: 'plans:foo_bar' }];
    const allow = parseToolsAllowlist('mcp__papercusp-su__plans_foo_bar');
    expect(filterListingsByAllowlist(listings, allow)).toEqual([]);
  });

  it('does not mutate the input listing array', () => {
    const frozen = Object.freeze([...SURFACE]);
    expect(() => filterListingsByAllowlist(frozen, parseToolsAllowlist('harness:list'))).not.toThrow();
    expect(() => filterListingsByAllowlist(frozen, null)).not.toThrow();
  });
});

describe('session serving-generation baseline', () => {
  beforeEach(() => __resetSessionSurfaces());

  it('treats a missing baseline as stale and leaves it unseeded until tools/list records it', () => {
    expect(sessionToolRegistryRevisionChanged('session-a', 'generation-1')).toBe(true);
    expect(sessionToolRegistryRevisionChanged('session-a', 'generation-1')).toBe(true);

    rememberSessionToolRegistryRevision('session-a', 'generation-1');
    expect(sessionToolRegistryRevisionChanged('session-a', 'generation-1')).toBe(false);
  });

  it('keeps changed generations stale until a later tools/list records the new revision', () => {
    rememberSessionToolRegistryRevision('session-a', 'generation-1');
    expect(sessionToolRegistryRevisionChanged('session-a', 'generation-2')).toBe(true);
    expect(sessionToolRegistryRevisionChanged('session-a', 'generation-2')).toBe(true);

    rememberSessionToolRegistryRevision('session-a', 'generation-2');
    expect(sessionToolRegistryRevisionChanged('session-a', 'generation-2')).toBe(false);
  });

  it('distinguishes a new transport session from a stale baseline on the old session', () => {
    rememberSessionToolRegistryRevision('mcp-transport-a', 'generation-1', 1_000);

    expect(sessionToolRegistryRevisionState('mcp-transport-a', 'generation-1', 1_001))
      .toEqual({ status: 'current', revision: 'generation-1' });
    expect(sessionToolRegistryRevisionState('mcp-transport-a', 'generation-2', 1_002))
      .toEqual({ status: 'stale', revision: 'generation-1' });
    expect(sessionToolRegistryRevisionState('mcp-transport-b', 'generation-1', 1_003))
      .toEqual({ status: 'missing' });
    expect(sessionToolRegistryRevisionState(null, 'generation-1', 1_004))
      .toEqual({ status: 'unavailable' });
  });
});

/**
 * The mutable per-session surface (dynamic-tool-surface-2026-07-01): the SEED
 * (`?tools=`) is a floor, not a cap — a seeded session grows on demand via
 * activateSessionTools, and getSessionSurface returns the live grown set on
 * every re-fetch. The load-bearing properties pinned here:
 *   1. no seed ⇒ null (full catalog, no surface tracked — the Claude path);
 *   2. a seeded session's growth is visible to a later tools/list;
 *   3. sessions are isolated (A's growth never leaks into B);
 *   4. activation only grows an already-seeded session and reports whether it
 *      added anything new (so the caller fires list_changed only when needed).
 */
describe('getSessionSurface / activateSessionTools (per-session mutable surface)', () => {
  beforeEach(() => __resetSessionSurfaces());

  it('returns null when there is no seed (full catalog — nothing tracked)', () => {
    expect(getSessionSurface('sess-A', null)).toBeNull();
    // …and with no seed, activation can never grow it.
    expect(activateSessionTools('sess-A', ['flags:set'])).toBe(false);
  });

  it('returns the raw seed (static) when there is no stable session key', () => {
    const seed = new Set(['coord:orient']);
    expect(getSessionSurface(null, seed)).toBe(seed);
    expect(getSessionSurface(undefined, seed)).toBe(seed);
  });

  it('seeds on first access and returns the SAME live set on re-access', () => {
    const first = getSessionSurface('sess-A', new Set(['coord:orient', 'tools:find']));
    expect(first).toEqual(new Set(['coord:orient', 'tools:find']));
    const second = getSessionSurface('sess-A', new Set(['coord:orient', 'tools:find']));
    expect(second).toBe(first); // same live Set instance, not a fresh copy
  });

  it('grows a seeded session and the growth is visible to a later tools/list', () => {
    const seed = new Set(['coord:orient']);
    getSessionSurface('sess-A', seed); // first tools/list seeds it
    const grew = activateSessionTools('sess-A', ['flags:set', 'harness:status']);
    expect(grew).toBe(true);
    // A re-fetch (with the same seed) sees seed ∪ activated.
    expect(getSessionSurface('sess-A', seed)).toEqual(
      new Set(['coord:orient', 'flags:set', 'harness:status']),
    );
  });

  it('reports false when activation adds nothing new (idempotent — no list_changed)', () => {
    getSessionSurface('sess-A', new Set(['coord:orient']));
    expect(activateSessionTools('sess-A', ['flags:set'])).toBe(true);
    expect(activateSessionTools('sess-A', ['flags:set'])).toBe(false); // already present
    expect(activateSessionTools('sess-A', [])).toBe(false); // nothing to add
  });

  it('only grows an ALREADY-SEEDED session (un-seeded ⇒ no-op)', () => {
    // No getSessionSurface() call for sess-Z → no entry → activation no-ops.
    expect(activateSessionTools('sess-Z', ['flags:set'])).toBe(false);
    // And a later seed does NOT retroactively include the dropped activation.
    expect(getSessionSurface('sess-Z', new Set(['coord:orient']))).toEqual(new Set(['coord:orient']));
  });

  it('isolates sessions — one session\'s growth never leaks into another', () => {
    const seed = new Set(['coord:orient']);
    getSessionSurface('sess-A', seed);
    getSessionSurface('sess-B', seed);
    activateSessionTools('sess-A', ['flags:set']);
    expect(getSessionSurface('sess-A', seed)).toEqual(new Set(['coord:orient', 'flags:set']));
    expect(getSessionSurface('sess-B', seed)).toEqual(new Set(['coord:orient'])); // untouched
  });

  it('re-seeds defensively — the seed is an invariant floor across re-fetches', () => {
    getSessionSurface('sess-A', new Set(['coord:orient']));
    activateSessionTools('sess-A', ['flags:set']);
    // A later tools/list arrives with a BROADER seed (e.g. a config change):
    // the floor widens, growth is preserved.
    expect(getSessionSurface('sess-A', new Set(['coord:orient', 'plans:get']))).toEqual(
      new Set(['coord:orient', 'plans:get', 'flags:set']),
    );
  });

  it('evicts entries idle past the TTL (lazy sweep on access)', () => {
    const seed = new Set(['coord:orient']);
    const t0 = 1_000_000;
    getSessionSurface('sess-old', seed, t0);
    activateSessionTools('sess-old', ['flags:set'], t0);
    // A fresh access 7h later triggers the sweep; the idle entry is gone, so a
    // re-seed starts clean (activation floor only, no stale growth).
    const t1 = t0 + 7 * 60 * 60 * 1000;
    expect(getSessionSurface('sess-old', seed, t1)).toEqual(new Set(['coord:orient']));
  });
});

/**
 * P-010: the COMPACT tier's MEASUREMENT and its DELIVERY must stay in lockstep.
 *
 * This is the single most consequential invariant in the delivery policy, and
 * it fails SILENTLY: if `applyCompactTier` ships prose that `compactWireBytes`
 * priced at zero, every `spentBytes` figure in the generated artifact — and
 * therefore the 100,000 B budget itself — becomes a fiction, while every test
 * that only checks "compact is smaller than full" still passes. Nothing else
 * in the suite compares the two sides against each other.
 */
describe('applyCompactTier — measured bytes equal delivered bytes', () => {
  const TOOL = {
    name: 'example:verb',
    description:
      'Claim the next eligible item under global floors. ⛔ NEVER run this against a live tree. ' +
      'It then applies the stored claim-spec filter and ranks by affinity before returning.',
    inputSchema: {
      type: 'object',
      description: 'prose that compaction removes',
      properties: { id: { type: 'string', description: 'the id', minLength: 1 } },
      required: ['id'],
    },
  };

  it('delivers exactly what compactWireBytes priced', () => {
    const [delivered] = applyCompactTier(
      [TOOL],
      new Set([TOOL.name]),
      compactInputSchema,
      summaryGuidanceDescription,
    );
    const measured = compactWireBytes(TOOL.name, TOOL);
    const deliveredBytes = new TextEncoder().encode(
      JSON.stringify({
        name: delivered.name,
        description: delivered.description,
        inputSchema: delivered.inputSchema,
      }),
    ).byteLength;
    expect(deliveredBytes).toBe(measured.compact);
  });

  it('ships a SUMMARY, not silence — and keeps the hard rail', () => {
    const [delivered] = applyCompactTier(
      [TOOL],
      new Set([TOOL.name]),
      compactInputSchema,
      summaryGuidanceDescription,
    );
    expect(delivered.description).not.toBe('');
    expect(delivered.description).toContain('NEVER run this against a live tree');
    expect((delivered.description ?? '').length).toBeLessThan(TOOL.description.length);
  });

  it('FALSIFIABILITY CONTROL — the old empty-description behaviour would fail the lockstep', () => {
    // The deliberately-wrong projection kept permanently as a control: this is
    // exactly what the seam did before P-010. It must NOT reconcile.
    const [wrong] = applyCompactTier([TOOL], new Set([TOOL.name]), compactInputSchema, () => '');
    const measured = compactWireBytes(TOOL.name, TOOL);
    const wrongBytes = new TextEncoder().encode(
      JSON.stringify({
        name: wrong.name,
        description: wrong.description,
        inputSchema: wrong.inputSchema,
      }),
    ).byteLength;
    expect(wrongBytes).not.toBe(measured.compact);
  });

  it('leaves a tool that is not in the compact set untouched', () => {
    const [untouched] = applyCompactTier(
      [TOOL],
      new Set(['someone:else']),
      compactInputSchema,
      summaryGuidanceDescription,
    );
    expect(untouched).toEqual(TOOL);
  });
});
