/**
 * tool-delivery-floors.test.ts — the falsifier for P-004's spec clause.
 * (deterministic-tool-definition-delivery-2026-09-21; AUTO-BAR-R-4-P-004.)
 *
 * The clause is falsified if (a) a floor entry can exist with no reason string,
 * or (b) the routing-table mandate set is re-listed by hand instead of read from
 * the existing derivation. Both are checked behaviourally below — the second one
 * by feeding the derivation a DIFFERENT registry and requiring the output to
 * follow it, which a hardcoded array cannot do.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_PAIRS } from '@papercusp/operator-core/lib/bash-substitution/pairs/index';
import type { SubstitutionPair } from '@papercusp/operator-core/lib/bash-substitution/types';
import { describe, expect, it } from 'vitest';

import { MANDATE_SEED_EXEMPT, promotedMandateToolNames } from './seed-mandate-coverage';
import {
  DECLARED_FLOORS,
  type FloorEntry,
  assertFloorsAreReasoned,
  deliveryFloorNames,
  resolveDeliveryFloors,
  routingTableFloors,
} from './tool-delivery-floors';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A registry row carrying only the fields the derivation actually reads. */
const pair = (toolName: string): SubstitutionPair =>
  ({ toolName, expectedVerdict: 'equivalent' }) as unknown as SubstitutionPair;

describe('every floor carries a machine-readable reason', () => {
  it('accepts the real floor set', () => {
    expect(() => resolveDeliveryFloors()).not.toThrow();
    for (const entry of resolveDeliveryFloors()) {
      expect(entry.reason.trim().length, `${entry.name} has an empty reason`).toBeGreaterThan(0);
      // A reason must say something; a one-word placeholder satisfies "non-empty"
      // while carrying no more information than an omission would.
      expect(entry.reason.trim().split(/\s+/).length, `${entry.name}'s reason is not a statement`).toBeGreaterThan(4);
    }
  });

  it('REJECTS a reasonless floor — the control that proves the guard can fail', () => {
    // Deliberately-bad entries kept permanently in the test rather than mutated
    // into the shared tree: the sweep commits a mid-probe tree, so an in-tree
    // mutation probe can be committed even when nothing goes wrong.
    const missing = { name: 'bad:one', tier: 'prose-mandate', reason: '' } as FloorEntry;
    const whitespace = { name: 'bad:two', tier: 'prose-mandate', reason: '   ' } as FloorEntry;
    const absent = { name: 'bad:three', tier: 'prose-mandate' } as unknown as FloorEntry;

    for (const bad of [missing, whitespace, absent]) {
      expect(() => assertFloorsAreReasoned([...DECLARED_FLOORS, bad]), `${bad.name} slipped through`).toThrow(
        /declared with no reason/,
      );
    }
    // And the message must NAME the offender, or the build failure is unactionable.
    expect(() => assertFloorsAreReasoned([missing])).toThrow(/bad:one/);
  });
});

describe('tier 2 is DERIVED from the routing table, not re-listed', () => {
  it('follows a synthetic registry instead of a fixed set of names', () => {
    // THE falsifier. A hardcoded array would return the real mandate names here.
    const synthetic = [pair('zzz:invented'), pair('yyy:alsoinvented')];
    const names = routingTableFloors(synthetic).map((e) => e.name);
    expect(names).toEqual(['yyy:alsoinvented', 'zzz:invented']);

    // ...and specifically does NOT carry the real promoted names through.
    const real = promotedMandateToolNames(ALL_PAIRS);
    expect(real.length).toBeGreaterThan(5); // positive control: the real set is non-trivial
    for (const realName of real) expect(names).not.toContain(realName);
  });

  it('covers every promoted mandate that is not evidence-exempt', () => {
    const floors = new Set(deliveryFloorNames());
    const promoted = promotedMandateToolNames(ALL_PAIRS);
    expect(promoted.length).toBeGreaterThan(5);
    for (const name of promoted) {
      if (MANDATE_SEED_EXEMPT.has(name)) continue;
      expect(floors.has(name), `promoted mandate ${name} is not a floor`).toBe(true);
    }
  });

  it('does NOT float an evidence-exempt mandate to a floor', () => {
    // An exemption is a recorded decision that the tool is better reached on
    // demand. Promoting it to a floor would silently overturn that decision.
    const exempt = [...MANDATE_SEED_EXEMPT.keys()];
    expect(exempt.length).toBeGreaterThan(0); // positive control
    const derived = new Set(routingTableFloors().map((e) => e.name));
    for (const name of exempt) expect(derived.has(name), `${name} is exempt but derived as a floor`).toBe(false);
  });

  it('holds no literal array of the promoted mandate names in its source', () => {
    const source = readFileSync(resolve(HERE, 'tool-delivery-floors.ts'), 'utf8');
    expect(source).toContain('export function routingTableFloors'); // positive control
    expect(source).toContain('promotedMandateToolNames');

    // A tier-2 name may legitimately appear in source only if it ALSO has a
    // declared tier-1/3/4 entry; anything else is a re-listing.
    const declared = new Set(DECLARED_FLOORS.map((e) => e.name));
    for (const name of promotedMandateToolNames(ALL_PAIRS)) {
      if (declared.has(name)) continue;
      expect(source, `promoted mandate ${name} is spelled out in the floor source`).not.toContain(`'${name}'`);
    }
  });
});

describe('the resolved floor set', () => {
  it('is sorted, deduplicated, and stable under registry reordering', () => {
    const forward = resolveDeliveryFloors();
    const reversed = resolveDeliveryFloors([...ALL_PAIRS].reverse());
    expect(reversed).toEqual(forward);

    const names = forward.map((e) => e.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('prefers the DECLARED entry when a name is reachable through two tiers', () => {
    // The hand-written reason says what specifically breaks; the derived one can
    // only say the routing table promotes it. Losing the former is a real loss.
    const overlap = DECLARED_FLOORS.filter((d) =>
      routingTableFloors().some((r) => r.name === d.name),
    );
    const resolved = new Map(resolveDeliveryFloors().map((e) => [e.name, e]));
    for (const entry of overlap) expect(resolved.get(entry.name)?.reason).toBe(entry.reason);
  });

  it('contains the two reachability tools, without which the deferred catalog is unreachable', () => {
    const names = new Set(deliveryFloorNames());
    expect(names.has('tools:find')).toBe(true);
    expect(names.has('tools:invoke')).toBe(true);
  });

  it('keeps events:status on the floor so wake liveness cannot be mistaken for a missing tool', () => {
    const names = new Set(deliveryFloorNames());
    expect(names.has('events:status')).toBe(true);
  });
});
