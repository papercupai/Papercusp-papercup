/**
 * WI-6554700010017295 — work_items:complete conformance-checks a close against its linked
 * plan. When the item carries a finish stamp (`payload.plan_item`), that linked plan is the
 * stamped (plan_slug, harness_slug) pair: the same plan the finish saga reflects into.
 *
 * A plan-run execution item records `source_plan_slug` = the TEMPLATE, while its stamp names
 * the run INSTANCE stored in the app harness (`execution.appHarnessSlug`). With a separate app
 * harness the template does not exist there, so the old pairing (template slug + item harness)
 * refused every such close with `conformance_mapping_unavailable: Cannot read linked plan
 * <template>.`
 *
 * The end-to-end proof is plan-run-action.integration.test.ts ('drives template instance →
 * canonical promotion → …'); this file pins the resolution rule itself.
 */
import { describe, expect, it } from 'vitest';

import { conformanceClosurePlanLink } from './complete';

describe('conformanceClosurePlanLink', () => {
  it('checks a cross-harness plan-run item against the stamped run instance, not the template', () => {
    const link = conformanceClosurePlanLink(
      { harness: 'email-plan-run-it-fixture', sourcePlanSlug: 'monitor-x', sourcePlanItemIds: null },
      { plan_slug: 'monitor-x@run-42', item_id: 'P-001', harness_slug: 'email-plan-run-it-fixture' },
    );
    expect(link).toEqual({
      planSlug: 'monitor-x@run-42',
      planItemIds: ['P-001'],
      harnessSlug: 'email-plan-run-it-fixture',
    });
  });

  it('checks a same-harness plan-run item against its stamped instance (measured live shape)', () => {
    // Measured 2026-10-18 over papercusp-workspace plan-run items: source_plan_slug is the
    // template, the stamp names the run instance, item harness == stamp harness.
    const link = conformanceClosurePlanLink(
      { harness: 'papercusp', sourcePlanSlug: 'bug-triage', sourcePlanItemIds: [] },
      { plan_slug: 'bug-triage@run-319822044763123994', item_id: 'P-002', harness_slug: 'papercusp' },
    );
    expect(link).toEqual({
      planSlug: 'bug-triage@run-319822044763123994',
      planItemIds: ['P-002'],
      harnessSlug: 'papercusp',
    });
  });

  it('keeps every declared item id when the source plan is the stamped plan', () => {
    const link = conformanceClosurePlanLink(
      { harness: 'papercusp', sourcePlanSlug: 'some-plan', sourcePlanItemIds: ['P-003', 'P-004'] },
      { plan_slug: 'some-plan', item_id: 'P-003', harness_slug: 'papercusp' },
    );
    expect(link).toEqual({ planSlug: 'some-plan', planItemIds: ['P-003', 'P-004'], harnessSlug: 'papercusp' });
  });

  it('does not carry the source plan’s item ids onto a different stamped plan', () => {
    const link = conformanceClosurePlanLink(
      { harness: 'papercusp', sourcePlanSlug: 'template-plan', sourcePlanItemIds: ['P-009'] },
      { plan_slug: 'template-plan@run-7', item_id: 'P-001', harness_slug: 'papercusp' },
    );
    expect(link.planItemIds).toEqual(['P-001']);
  });

  it('uses the stamp pair when the item records no source plan', () => {
    const link = conformanceClosurePlanLink(
      { harness: 'app-harness', sourcePlanSlug: null, sourcePlanItemIds: null },
      { plan_slug: 'stamped-plan', item_id: 'P-007', harness_slug: 'plan-harness' },
    );
    expect(link).toEqual({ planSlug: 'stamped-plan', planItemIds: ['P-007'], harnessSlug: 'plan-harness' });
  });

  it('falls back to the item’s own source plan and harness for an unstamped item', () => {
    const link = conformanceClosurePlanLink(
      { harness: 'papercusp', sourcePlanSlug: 'own-plan', sourcePlanItemIds: ['P-001'] },
      null,
    );
    expect(link).toEqual({ planSlug: 'own-plan', planItemIds: ['P-001'], harnessSlug: 'papercusp' });
  });

  it('reports no linked plan when neither the item nor a stamp names one', () => {
    const link = conformanceClosurePlanLink({ harness: 'papercusp' }, null);
    expect(link).toEqual({ planSlug: undefined, planItemIds: [], harnessSlug: 'papercusp' });
  });
});
