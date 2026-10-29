/**
 * get_next.shadowed-fleet-spec.test.ts — regression guards for EI-22143638502920491 and
 * EI-26979401860651629.
 *
 * The bug: `getClaimSpecRecord` returns the moment it finds a per-bee row
 * (`source:'cup'`) — it never looks at whether the caller ALSO belongs to a
 * fleet whose OWN sentinel spec would otherwise apply. A `plans:start`-installed
 * per-bee spec that outlives its plan's claimable items therefore shadows the
 * fleet spec PERMANENTLY and SILENTLY: `scheduler:get_next` misses forever,
 * `diagnoseClaimNextMiss`'s pool/floor aggregate reads healthy (it is filter-
 * agnostic), and nothing said "a DIFFERENT spec you're not using would match".
 * Measured live: a DRAIN fleet leader idled beside 2,493 claimable items its
 * own fleet spec matched (EI-22143638502920491).
 *
 * `shadowedFleetSpecNote` and the fleet-only filter difference are pure halves
 * of the fix — unit-tested here without a DB. The DB-side half (buildMissDiagnosis:
 * look up the caller's fleet membership when source==='cup', fetch that fleet's sentinel
 * spec, and count only ready rows admitted by the fleet filter but excluded by the
 * effective per-bee filter) calls this function and threads the result into the returned `error` string ahead of
 * `namedSummary`, plus `diagnosis.shadowedFleetSpec`) is asserted here as a
 * source-text wiring guard, the established pattern for this file's sibling
 * *.test.ts files (see get_next.family-scope-diagnosis.test.ts) where a live
 * DB claim isn't needed to pin the logic.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FilterNode } from '../../scheduler/claim-spec';
import { shadowedFleetOnlyFilter, shadowedFleetSpecNote } from './get_next';

describe('EI-22143638502920491 — shadowedFleetSpecNote', () => {
  it('names the fleet, its revision, newly admitted ready rows, and both remedy tool calls', () => {
    const note = shadowedFleetSpecNote({
      ownerId: 'su-abc123',
      fleetSlug: 'my-drain-fleet',
      revision: 3,
      newlyAdmittedReady: 2493,
    });
    expect(note).toContain("your effective spec is a PER-BEE OVERRIDE (source:'cup')");
    expect(note).toContain("fleet 'my-drain-fleet' (rev 3)");
    expect(note).toContain('admit 2493 additional ready issue-family row(s)');
    expect(note).toContain('under the same claimability floors');
    expect(note).toContain("scheduler:set_claim_spec { cupId: 'su-abc123', clear:true }");
    expect(note).toContain("scheduler:get_claim_spec { fleet: 'my-drain-fleet' }");
  });

  it('omits the parenthetical revision when the fleet spec has none (null revision)', () => {
    const note = shadowedFleetSpecNote({
      ownerId: 'su-abc123',
      fleetSlug: 'my-drain-fleet',
      revision: null,
      newlyAdmittedReady: 5,
    });
    expect(note).toContain("fleet 'my-drain-fleet' has its own sentinel spec");
    expect(note).not.toMatch(/fleet 'my-drain-fleet' \(rev/);
  });

  it('suppresses the note when the fleet-only difference has no ready rows', () => {
    expect(
      shadowedFleetSpecNote({
        ownerId: 'su-abc123',
        fleetSlug: 'my-drain-fleet',
        revision: 3,
        newlyAdmittedReady: 0,
      }),
    ).toBe('');
  });
});

describe('EI-26979401860651629 — shadowedFleetOnlyFilter', () => {
  it('short-circuits structurally identical effective and fleet filters', () => {
    const filter: FilterNode = {
      all: [
        { field: 'kind', op: 'in', value: ['bug', 'change'] },
        { field: 'severity', op: '>=', value: 'major' },
      ],
    };
    expect(shadowedFleetOnlyFilter({ fleetFilter: filter, effectiveFilter: filter })).toBeUndefined();
  });

  it('ignores different maxConcurrentClaims values when both specs have the same filter', () => {
    const filter: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change'] };
    const fleetSpec = { view: { filter }, limits: { maxConcurrentClaims: 2 } };
    const perBeeSpec = { view: { filter }, limits: { maxConcurrentClaims: 3 } };
    expect(
      shadowedFleetOnlyFilter({
        fleetFilter: fleetSpec.view.filter,
        effectiveFilter: perBeeSpec.view.filter,
      }),
    ).toBeUndefined();
  });

  it('builds the fleet-only difference when the fleet filter is broader', () => {
    const fleetFilter: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change'] };
    const effectiveFilter: FilterNode = { field: 'kind', op: '=', value: 'bug' };
    expect(shadowedFleetOnlyFilter({ fleetFilter, effectiveFilter })).toEqual({
      all: [fleetFilter, { not: effectiveFilter }],
    });
  });

  it('does not claim a fleet advantage when the effective per-bee filter is unrestricted', () => {
    const fleetFilter: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change'] };
    expect(shadowedFleetOnlyFilter({ fleetFilter, effectiveFilter: undefined })).toBeUndefined();
  });
});

describe('EI-22143638502920491 — buildMissDiagnosis threads the shadowed-fleet-spec note (wiring guard)', () => {
  const SRC = readFileSync(resolve(__dirname, './get_next.ts'), 'utf8');

  it('only computes it for a per-bee override, and skips a genuinely drained pool', () => {
    expect(SRC).toContain("if (rec?.source === 'cup' && !diag.drained) {");
  });

  it('resolves the caller\'s own fleet membership rather than trusting rec.fleetSlug (absent for source:\'cup\')', () => {
    expect(SRC).toContain("await import('../../fleet-membership-store')");
    expect(SRC).toContain('latestFleetMembership(resolvedWorkspace ?? DEFAULT_COORD_WORKSPACE, args.ownerId)');
  });

  it('fetches the FLEET sentinel record via fleetSpecBeeKey and requires source==="fleet" back', () => {
    expect(SRC).toContain('cupId: fleetSpecBeeKey(membership.fleetSlug)');
    expect(SRC).toContain("fleetRec && fleetRec.source === 'fleet'");
  });

  it('uses the fleet-only filter difference and gates on rows that pass claimability floors', () => {
    expect(SRC).toContain('shadowedFleetOnlyFilter({ fleetFilter, effectiveFilter })');
    expect(SRC).toContain('agg.value && agg.value.claimable > 0');
    expect(SRC).toContain('newlyAdmittedReady: agg.value.claimable');
  });

  it('is appended to the returned error ahead of namedSummary, and surfaced structurally in diagnosis', () => {
    expect(SRC).toMatch(
      /error:\s*`\$\{STATIC\}\. Diagnosis: \$\{aggregate\}\.\$\{shadowedFleetNote\}\$\{namedSummary\}\$\{breakdownSummary\}\$\{flagReadErrorNote\}\$\{familyScopeNote\}`/,
    );
    expect(SRC).toContain('...(shadowedFleetSpec ? { shadowedFleetSpec } : {}),');
  });

  it('is best-effort: a failure anywhere in the lookup falls through without breaking the miss diagnosis', () => {
    expect(SRC).toContain('/* best-effort enrichment only — never let this break the miss diagnosis */');
  });
});
