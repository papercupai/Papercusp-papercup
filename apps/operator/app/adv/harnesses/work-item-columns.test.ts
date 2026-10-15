import { describe, expect, it } from 'vitest';
import {
  buildWorkItemColumns,
  workItemFilterColumns,
  WORK_ITEM_FILTER_NS,
} from './work-item-columns';
import { deriveItemWorkEvidence } from '@papercusp/operator-core/lib/item-activity';

/**
 * Guards for the SHARED work-item column/filter definition
 * (dependency-health-pane-2026-08-02 P-010, owner requirement D-003 req 4:
 * "all the filters from the work item list pane should also be brought over").
 *
 * The lift only buys parity if parity is ASSERTED. Without these, the two panes
 * can silently diverge in exactly the way hand-copying would have — the graph
 * pane keeps rendering, the list pane keeps rendering, and only a user notices a
 * filter that exists on one and not the other.
 */
describe('shared work-item column definitions', () => {
  const full = buildWorkItemColumns({ isTrusted: () => false });
  const forFilters = workItemFilterColumns();

  it('distinguishes acceptance from spine and lifecycle; copy includes the decision reason', () => {
    const column = full.find(c => c.key === 'acceptance')!;
    const row = { presentation: { stage: 'candidate', reason: 'acceptance-revision-stale' }, spineRole: 'worker', state: 'wip' };
    expect(column.toCopyText?.(row as never)).toContain('Reproduction or review candidates');
    expect(column.toCopyText?.(row as never)).toContain('acceptance-revision-stale');
  });

  it('never presents an assigned or parked row as positive execution evidence', () => {
    const acceptance = full.find(c => c.key === 'acceptance')!;
    const work = full.find(c => c.key === 'workEvidence')!;
    const evidence = deriveItemWorkEvidence({ takenBy: 'su-worker', takenAt: 1000, lastProgressAt: null }, { now: 2000 });
    const row = { state: 'wip', assignee: 'su-worker', presentation: {
      stage: 'accepted-active', reason: 'accepted-work-reserved', workEvidence: evidence,
    } };
    expect(acceptance.toCopyText?.(row as never)).toContain('Reserved accepted work');
    expect(work.toCopyText?.(row as never)).toContain('Work attestation unknown');
    expect(work.toCopyText?.({ ...row, presentation: undefined } as never)).toBe('Work evidence unknown');
  });

  it('exposes the SAME filterable columns to both panes, in the same order', () => {
    const filterable = (cols: typeof full) =>
      cols.filter((c) => c.filter != null).map((c) => c.key);

    // The graph pane's view must not quietly drop (or add) a filter.
    expect(filterable(forFilters)).toEqual(filterable(full));
    // Sanity: the parity assertion above is worthless if BOTH are empty.
    expect(filterable(full).length).toBeGreaterThan(0);
  });

  it('carries identical filter TYPES across both views', () => {
    const types = (cols: typeof full) =>
      Object.fromEntries(cols.filter((c) => c.filter).map((c) => [c.key, c.filter?.type]));

    // A column re-typed enum→text on one side only would change which rows match
    // for the same persisted `wif` value — a silent, data-dependent divergence.
    expect(types(forFilters)).toEqual(types(full));
  });

  it('preserves the every-column set, so the graph derives from the real definition', () => {
    // workItemFilterColumns() must MAP the canonical list, never re-declare a
    // subset of it — a hand-written second list is the drift this module prevents.
    expect(forFilters.map((c) => c.key)).toEqual(full.map((c) => c.key));
  });

  it('pins the filter namespace to `wi` — it is a wire format, not a preference', () => {
    // This string is (a) the nuqs param every existing deep link / saved layout
    // already carries and (b) the ONLY thing coupling the list and graph panes.
    // Changing it silently decouples them AND orphans links; both panes keep
    // working alone, so nothing else in the suite would catch it.
    expect(WORK_ITEM_FILTER_NS).toBe('wi');
  });

  it('keeps every filter accessor total — no throw on a fully-null row', () => {
    // The graph pane feeds the same rows through these accessors as the grid, but
    // reaches them on a different code path (no cell render). An accessor that
    // assumed a non-null field would surface as a blank graph, not a clear error.
    const nullRow = Object.fromEntries(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.keys({} as any).concat([
        'id',
        'kind',
        'family',
        'title',
        'summary',
        'state',
        'assignee',
        'assignedBy',
        'severity',
        'priority',
        'rank',
        'planSlug',
        'spineRole',
        'spineStatus',
        'updatedAt',
        'origin',
        'auditVerdict',
        'verifiedAuthorGithubUserId',
      ]).map((k) => [k, null]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;

    for (const col of full) {
      if (!col.filter) continue;
      expect(() => col.filter?.accessor(nullRow)).not.toThrow();
    }
  });
});
