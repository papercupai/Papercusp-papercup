/**
 * P-040 (review-system-rework-reduction-2026-09-23) — the pure half of
 * plans:evidence-measuring-paths: which live repo-files proof measured an edited path,
 * grouped by clause, with the holder to tell and the one re-measure call, packed under
 * the tool-result budget. The SQL half (unshipped plan, current revision, un-retracted)
 * is exercised live; this file pins the contract the PostToolUse hook consumes.
 */
import { describe, expect, it } from 'vitest';
import {
  INLINE_MEASUREMENT_MAX_CHARS,
  filterBindingsToCheckout,
  normalizeRepoRelativePath,
  packMeasuringClauses,
  type MeasuringBindingRow,
} from './evidence-measuring-paths';

const EDITED = 'packages/operator-core/lib/agent-tools/plans/acceptance-drain-filing.ts';

function row(over: Partial<MeasuringBindingRow> = {}): MeasuringBindingRow {
  return {
    id: 100,
    work_item_id: 'WI-1',
    plan_slug: 'plan-a',
    spec_id: 'RSR-P-016-A',
    spec_revision: 2,
    evidence_kind: 'test',
    evidence_ref: 'test-run:19138721',
    created_by: 'su-binder',
    source_paths: [EDITED],
    test_paths: ['packages/operator-core/lib/agent-tools/plans/acceptance-drain-backlog-class.test.ts'],
    work_item_status: 'wip',
    work_item_taken_by: 'su-holder',
    ...over,
  };
}

const pack = (rows: MeasuringBindingRow[], over: Partial<Parameters<typeof packMeasuringClauses>[1]> = {}) =>
  packMeasuringClauses(rows, { paths: [EDITED], harnessSlug: 'papercusp', limit: 12, ...over });

describe('packMeasuringClauses', () => {
  it('names the clause whose live proof measured the edited source path', () => {
    const packed = pack([row()]);
    expect(packed.totalClauses).toBe(1);
    expect(packed.clauses[0]).toMatchObject({
      plan: 'plan-a',
      clause: 'RSR-P-016-A@2',
      bar: false,
      workItemId: 'WI-1',
      holder: 'su-holder',
      holderSource: 'assignee',
      matched: [EDITED],
      bindingIds: [100],
    });
  });

  it('an unbound path yields no clause', () => {
    const packed = pack([row()], { paths: ['packages/operator-core/lib/unrelated.ts'] });
    expect(packed).toMatchObject({ clauses: [], totalClauses: 0, truncatedByLimit: false });
  });

  it('matches a measured TEST path too, and normalizes ./ and backslashes', () => {
    const test = 'packages/operator-core/lib/agent-tools/plans/acceptance-drain-backlog-class.test.ts';
    expect(pack([row()], { paths: [`./${test}`] }).clauses[0].matched).toEqual([test]);
    expect(normalizeRepoRelativePath('a\\b//c.ts')).toBe('a/b/c.ts');
  });

  it('groups several bindings of one clause, newest first, and lists BAR clauses first', () => {
    const packed = pack([
      row({ id: 300, spec_id: 'RSR-P-016-B', spec_revision: 1 }),
      row({ id: 200, evidence_kind: 'mutation' }),
      row({ id: 100 }),
      row({ id: 50, spec_id: 'AUTO-BAR-R-5-P-016', spec_revision: 1 }),
    ]);
    expect(packed.clauses.map((c) => c.clause)).toEqual(['AUTO-BAR-R-5-P-016@1', 'RSR-P-016-B@1', 'RSR-P-016-A@2']);
    const a = packed.clauses.find((c) => c.clause === 'RSR-P-016-A@2')!;
    expect(a).toMatchObject({ bindingIds: [200, 100], bindingCount: 2, kinds: ['mutation', 'test'] });
    expect(a.remeasure.bindingId).toBe(200);
    expect(packed.clauses[0].bar).toBe(true);
  });

  it('holder is the live assignee, else whoever bound the proof once the item is terminal', () => {
    expect(pack([row({ work_item_status: 'done' })]).clauses[0]).toMatchObject({ holder: 'su-binder', holderSource: 'bound-by' });
    expect(pack([row({ work_item_taken_by: null })]).clauses[0]).toMatchObject({ holder: 'su-binder', holderSource: 'bound-by' });
  });

  it('filters path collisions to the registered checkout that supplied the proof', () => {
    const canonical = row({ id: 100 });
    const sibling = row({ id: 101, root_harness_slug: 'sibling' });
    const registeredRoots = new Map([
      ['papercusp', '/tmp/papercusp-canonical'],
      ['sibling', '/tmp/papercusp-sibling'],
    ]);

    expect(filterBindingsToCheckout([canonical, sibling], {
      harnessSlug: 'papercusp',
      checkoutRoot: '/tmp/papercusp-canonical',
      registeredRoots,
    }).map((r) => r.id)).toEqual([100]);
    expect(filterBindingsToCheckout([canonical, sibling], {
      harnessSlug: 'papercusp',
      checkoutRoot: '/tmp/papercusp-sibling',
      registeredRoots,
    }).map((r) => r.id)).toEqual([101]);
    expect(filterBindingsToCheckout([canonical, sibling], {
      harnessSlug: 'papercusp',
      checkoutRoot: '/tmp/papercusp-unregistered-clone',
      registeredRoots,
    })).toEqual([]);
  });

  it('the re-measure call is complete and supersedes; an execution proof must be re-RUN, not re-bound', () => {
    const exec = pack([row()]).clauses[0].remeasure;
    expect(exec.rerunFirst).toBe(true);
    expect(exec.call?.args).toMatchObject({
      harness: 'papercusp',
      slug: 'plan-a',
      supersedeAtRevision: true,
      binding: {
        workItemId: 'WI-1',
        specId: 'RSR-P-016-A',
        specRevision: 2,
        evidenceKind: 'test',
        evidenceRef: '<the NEW run of this proof>',
        measurement: { kind: 'repo-files', sourcePaths: [EDITED] },
      },
    });
    const check = pack([row({ evidence_kind: 'check', evidence_ref: 'check:lint' })]).clauses[0].remeasure;
    expect(check.rerunFirst).toBe(false);
    expect((check.call?.args.binding as { evidenceRef: string }).evidenceRef).toBe('check:lint');
  });

  it('stays inside the budget: an oversized measurement points at the read instead of inlining it', () => {
    const many = Array.from({ length: 40 }, (_, i) => `packages/operator-core/lib/some/deep/module-${i}.ts`);
    expect(JSON.stringify(many).length).toBeGreaterThan(INLINE_MEASUREMENT_MAX_CHARS);
    const packed = pack([row({ source_paths: [EDITED, ...many] })]);
    expect(packed.callsElided).toBe(1);
    expect(packed.clauses[0].remeasure.call).toBeUndefined();
    // The read is narrowed to the one binding: a specIds-only full read returns every
    // binding of the clause (oversized-tool-results-reduction-2026-10-12 P-006).
    expect(packed.clauses[0].remeasure.measurementFrom).toEqual({
      tool: 'plans:get-spec-evidence',
      args: {
        harness: 'papercusp',
        slug: 'plan-a',
        specIds: ['RSR-P-016-A'],
        bindingIds: [packed.clauses[0].remeasure.bindingId],
        detail: 'full',
      },
    });
    expect(packed.clauses[0].remeasure.measurementFrom?.args.bindingIds).toEqual(packed.clauses[0].bindingIds.slice(0, 1));
  });

  it('a hot file measured by many clauses fits the result cap, and the limit is reported', () => {
    // Shaped like the live worst case: apps/tui/src/main.rs is measured by 34 clauses.
    const holdersOf = ['su-aaaaaaaa', 'su-bbbbbbbb', 'su-cccccccc'];
    const rows = Array.from({ length: 34 }, (_, i) =>
      row({
        id: 1000 + i,
        spec_id: i < 10 ? `AUTO-BAR-R-${i}-P-009` : `RSR-P-${100 + i}-A`,
        work_item_taken_by: holdersOf[i % 3],
        source_paths: [EDITED, ...Array.from({ length: 6 }, (_, j) => `apps/tui/src/module_${i}_${j}.rs`)],
      }),
    );
    const packed = pack(rows);
    expect(packed.totalClauses).toBe(34);
    // Identity first: inlining calls first listed only 4 of 34 on the live hot file.
    expect(packed.clauses.length).toBeGreaterThan(4);
    expect(packed.clauses.length).toBeLessThanOrEqual(12);
    // The holders summary covers ALL 34 matched clauses, whatever the clause list kept.
    expect(packed.holders.map((h) => h.holder).sort()).toEqual(holdersOf);
    expect(packed.holders.reduce((n, h) => n + h.clauses, 0)).toBe(34);
    expect(packed.holders.reduce((n, h) => n + h.bars, 0)).toBe(10);
    expect(packed.holdersTruncated).toBe(false);
    expect(packed.truncatedByLimit).toBe(true);
    // Whichever bound stopped the list is named, so a short list is never read as "that's all".
    expect(packed.truncatedByBudget || packed.clauses.length === 12).toBe(true);
    // Every returned clause keeps its identity even after calls start being elided.
    expect(packed.clauses.every((c) => c.clause && c.holder && c.workItemId)).toBe(true);
    expect(JSON.stringify(packed).length).toBeLessThan(6000);
  });
});
