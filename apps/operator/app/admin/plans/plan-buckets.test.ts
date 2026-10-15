/**
 * Unit coverage for the lifecycle bucketing + shared filter predicate
 * that back the Plans-tab status tabs.
 *
 *  - `bucketOf` (plans-api): total function — every plan maps to exactly
 *    one of draft / ready / running / shipped / rejected, with terminal
 *    statuses winning over the operational started-state.
 *  - `applyPlanFilters` (plan-filtering): the search/filter predicate the
 *    rail and the tab count-badges share; it must NOT filter by bucket.
 */
import { describe, expect, it } from 'vitest';
import { bucketOf, type PlanListRow, type PlanStartStatus } from './plans-api';
import { applyPlanFilters, type PlanFilterState } from './plan-filtering';

function row(overrides: Partial<PlanListRow> = {}): PlanListRow {
  return {
    slug: 'demo-plan',
    title: 'Demo Plan',
    status: 'draft',
    updated: '2026-05-20',
    created: undefined,
    owner: undefined,
    archived: false,
    isLegacy: false,
    itemCounts: undefined,
    nextAction: undefined,
    harness: 'papercup',
    startStatus: undefined,
    priority: undefined,
    maxImportance: undefined,
    ...overrides,
  };
}

const NO_FILTERS: PlanFilterState = {
  date: null,
  owner: null,
  view: 'all',
  viewerEmail: null,
  initiative: null,
  archived: false,
  legacy: false,
  inbox: false,
  actionable: false,
  scout: false,
  scheduled: false,
  trigger: 'all',
};

describe('bucketOf', () => {
  it('maps the forward lifecycle', () => {
    expect(bucketOf(row({ status: 'draft' }))).toBe('draft');
    expect(bucketOf(row({ status: 'ready' }))).toBe('ready');
    expect(bucketOf(row({ status: 'ready', startStatus: 'started' }))).toBe('running');
    expect(bucketOf(row({ status: 'shipped' }))).toBe('shipped');
    expect(bucketOf(row({ status: 'superseded' }))).toBe('rejected');
  });

  it('treats legacy `active` as approved (ready, or running once started)', () => {
    expect(bucketOf(row({ status: 'active' }))).toBe('ready');
    expect(bucketOf(row({ status: 'active', startStatus: 'started' }))).toBe('running');
  });

  it('blocked / unhandled statuses fold into draft', () => {
    expect(bucketOf(row({ status: 'blocked' }))).toBe('draft');
  });

  it('terminal status wins over the started-state (precedence)', () => {
    // A shipped or rejected plan that still carries startStatus:'started'
    // must bucket as shipped/rejected, never running.
    expect(bucketOf(row({ status: 'shipped', startStatus: 'started' }))).toBe('shipped');
    expect(bucketOf(row({ status: 'superseded', startStatus: 'started' }))).toBe('rejected');
  });

  it('paused (not started) approved plan is ready, not running', () => {
    expect(bucketOf(row({ status: 'ready', startStatus: 'paused' }))).toBe('ready');
  });

  // derived-status-not-hand-written-2026-10-12 P-007: a plan whose items are all
  // terminal is awaiting acceptance whatever its stored status still claims —
  // including a stale `startStatus: 'started'`, which would otherwise read Running.
  it('a derived all-terminal verdict buckets as awaiting, above the started-state', () => {
    const derived = (verdict: NonNullable<PlanListRow['derivedLifecycle']>['verdict']) => ({
      verdict,
      disposition: 'agreed',
    });
    expect(
      bucketOf(row({ status: 'ready', startStatus: 'started', derivedLifecycle: derived('implementation-complete') })),
    ).toBe('awaiting');
    expect(bucketOf(row({ status: 'active', derivedLifecycle: derived('awaiting-acceptance') }))).toBe('awaiting');
    // A live (or stalled) plan keeps its operational bucket.
    expect(bucketOf(row({ status: 'ready', startStatus: 'started', derivedLifecycle: derived('active') }))).toBe(
      'running',
    );
    expect(bucketOf(row({ status: 'ready', derivedLifecycle: derived('stalled') }))).toBe('ready');
    // Terminal stored statuses still win: the derived verdict never un-ships a plan.
    expect(bucketOf(row({ status: 'shipped', derivedLifecycle: derived('implementation-complete') }))).toBe('shipped');
    expect(bucketOf(row({ status: 'superseded', derivedLifecycle: derived('awaiting-acceptance') }))).toBe('rejected');
  });
});

describe('applyPlanFilters', () => {
  it('does NOT filter by bucket/status — every status survives a no-op filter', () => {
    const plans = [
      row({ slug: 'a', status: 'draft' }),
      row({ slug: 'b', status: 'ready' }),
      row({ slug: 'c', status: 'shipped' }),
      row({ slug: 'd', status: 'superseded' }),
    ];
    expect(applyPlanFilters(plans, NO_FILTERS, '').map((p) => p.slug)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('hides archived plans by default, shows only archived when toggled', () => {
    const plans = [row({ slug: 'live', archived: false }), row({ slug: 'old', archived: true })];
    expect(applyPlanFilters(plans, NO_FILTERS, '').map((p) => p.slug)).toEqual(['live']);
    expect(
      applyPlanFilters(plans, { ...NO_FILTERS, archived: true }, '').map((p) => p.slug),
    ).toEqual(['old']);
  });

  it('search matches title, slug, or a server-side body hit', () => {
    const plans = [
      row({ slug: 'auth-rework', title: 'Auth rework' }),
      row({ slug: 'billing', title: 'Billing' }),
      row({ slug: 'mem0-recall', title: 'Memory recall' }),
    ];
    expect(applyPlanFilters(plans, NO_FILTERS, 'auth').map((p) => p.slug)).toEqual(['auth-rework']);
    expect(applyPlanFilters(plans, NO_FILTERS, 'billing').map((p) => p.slug)).toEqual(['billing']);
    // body-only hit surfaced via searchHitSlugs
    expect(
      applyPlanFilters(plans, NO_FILTERS, 'engram', new Set(['mem0-recall'])).map((p) => p.slug),
    ).toEqual(['mem0-recall']);
  });

  it('inbox/actionable filter on item counts; owner filters exactly', () => {
    const plans = [
      row({ slug: 'has-human', itemCounts: { 'needs-human': 2 }, owner: 'a@x.com' }),
      row({ slug: 'has-todo', itemCounts: { todo: 1 }, owner: 'b@x.com' }),
      row({ slug: 'empty', itemCounts: {}, owner: 'a@x.com' }),
    ];
    expect(applyPlanFilters(plans, { ...NO_FILTERS, inbox: true }, '').map((p) => p.slug)).toEqual(['has-human']);
    expect(applyPlanFilters(plans, { ...NO_FILTERS, actionable: true }, '').map((p) => p.slug)).toEqual(['has-todo']);
    expect(applyPlanFilters(plans, { ...NO_FILTERS, owner: 'a@x.com' }, '').map((p) => p.slug)).toEqual([
      'has-human',
      'empty',
    ]);
  });

  it('scheduled filter keeps only plans flagged scheduled (P-021)', () => {
    const plans = [
      row({ slug: 'recurring', scheduled: true, scheduleKind: 'recurring', scheduleActive: true }),
      row({ slug: 'one-shot', scheduled: true, scheduleKind: 'one-shot', scheduleActive: false }),
      row({ slug: 'plain', scheduled: false }),
      row({ slug: 'undefined-sched' }),
    ];
    expect(applyPlanFilters(plans, { ...NO_FILTERS, scheduled: true }, '').map((p) => p.slug)).toEqual([
      'recurring',
      'one-shot',
    ]);
    // No filter ⇒ all four pass through.
    expect(applyPlanFilters(plans, NO_FILTERS, '').map((p) => p.slug)).toEqual([
      'recurring',
      'one-shot',
      'plain',
      'undefined-sched',
    ]);
  });

  it('one-time / triggered facet uses the server-derived classification and composes with other filters', () => {
    const plans = [
      row({ slug: 'plain', triggered: false, owner: 'a@x.com' }),
      row({ slug: 'event', triggered: true, triggerSources: ['external'], owner: 'a@x.com' }),
      row({ slug: 'manual-other', triggered: true, triggerSources: ['manual'], owner: 'b@x.com' }),
      row({ slug: 'legacy-server-shape', owner: 'a@x.com' }),
    ];
    expect(
      applyPlanFilters(plans, { ...NO_FILTERS, trigger: 'triggered' }, '').map((p) => p.slug),
    ).toEqual(['event', 'manual-other']);
    expect(
      applyPlanFilters(plans, { ...NO_FILTERS, trigger: 'one-time' }, '').map((p) => p.slug),
    ).toEqual(['plain', 'legacy-server-shape']);
    expect(
      applyPlanFilters(
        plans,
        { ...NO_FILTERS, trigger: 'triggered', owner: 'a@x.com' },
        '',
      ).map((p) => p.slug),
    ).toEqual(['event']);
  });

  it('owner saved-view: mine / others keyed on the viewer email (P-002), case-insensitive', () => {
    const plans = [
      row({ slug: 'mine-1', owner: 'me@x.com' }),
      row({ slug: 'mine-2', owner: 'ME@X.COM' }), // case-insensitive match
      row({ slug: 'theirs', owner: 'you@x.com' }),
      row({ slug: 'ownerless', owner: undefined }),
    ];
    const me = 'me@x.com';
    expect(applyPlanFilters(plans, { ...NO_FILTERS, view: 'mine', viewerEmail: me }, '').map((p) => p.slug)).toEqual([
      'mine-1',
      'mine-2',
    ]);
    // 'others' excludes mine AND ownerless plans (only plans owned by someone else)
    expect(applyPlanFilters(plans, { ...NO_FILTERS, view: 'others', viewerEmail: me }, '').map((p) => p.slug)).toEqual([
      'theirs',
    ]);
    // 'all' is a no-op
    expect(applyPlanFilters(plans, { ...NO_FILTERS, view: 'all', viewerEmail: me }, '').map((p) => p.slug)).toEqual([
      'mine-1',
      'mine-2',
      'theirs',
      'ownerless',
    ]);
  });

  it('owner saved-view degrades to no-op when the viewer email is unknown', () => {
    const plans = [row({ slug: 'a', owner: 'me@x.com' }), row({ slug: 'b', owner: 'you@x.com' })];
    // viewerEmail null ⇒ mine/others must NOT blindly hide everything.
    expect(applyPlanFilters(plans, { ...NO_FILTERS, view: 'mine', viewerEmail: null }, '').map((p) => p.slug)).toEqual([
      'a',
      'b',
    ]);
  });

  it('initiative facet (P-015): matches the exact label, case-insensitive; null label never matches', () => {
    const plans = [
      row({ slug: 'a', initiative: 'shared-hive' }),
      row({ slug: 'b', initiative: 'Shared-Hive' }), // case-insensitive match
      row({ slug: 'c', initiative: 'release-gate' }),
      row({ slug: 'd', initiative: undefined }),
      row({ slug: 'e' }), // no initiative field at all (undefined)
    ];
    expect(
      applyPlanFilters(plans, { ...NO_FILTERS, initiative: 'shared-hive' }, '').map((p) => p.slug),
    ).toEqual(['a', 'b']);
    expect(
      applyPlanFilters(plans, { ...NO_FILTERS, initiative: 'release-gate' }, '').map((p) => p.slug),
    ).toEqual(['c']);
    // null facet ⇒ no-op (every plan passes).
    expect(applyPlanFilters(plans, { ...NO_FILTERS, initiative: null }, '').map((p) => p.slug)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    // a non-matching label hides everything (no plan carries it).
    expect(applyPlanFilters(plans, { ...NO_FILTERS, initiative: 'nope' }, '')).toEqual([]);
  });

  it('initiative composes with the owner saved-view (both predicates AND together)', () => {
    const plans = [
      row({ slug: 'mine-hive', owner: 'me@x.com', initiative: 'hive' }),
      row({ slug: 'mine-other', owner: 'me@x.com', initiative: 'other' }),
      row({ slug: 'theirs-hive', owner: 'you@x.com', initiative: 'hive' }),
    ];
    expect(
      applyPlanFilters(
        plans,
        { ...NO_FILTERS, view: 'mine', viewerEmail: 'me@x.com', initiative: 'hive' },
        '',
      ).map((p) => p.slug),
    ).toEqual(['mine-hive']);
  });
});
