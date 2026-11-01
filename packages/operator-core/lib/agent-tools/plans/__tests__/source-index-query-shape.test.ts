/**
 * Regression coverage for EI-19447621925540921: optional index-list filters
 * must not mint a new PostgreSQL statement shape for every combination.
 *
 * This uses a tiny postgres.js-compatible tag seam so the test can inspect the
 * final flattened SQL and bind list without needing a live database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fragment = {
  __fragment: true;
  strings: readonly string[];
  values: unknown[];
};

type Flattened = { text: string; values: unknown[] };

const H = vi.hoisted(() => {
  const statements: Flattened[] = [];
  const rows: unknown[][] = [];

  const isFragment = (value: unknown): value is Fragment =>
    !!value && typeof value === 'object' && (value as { __fragment?: unknown }).__fragment === true;

  const flatten = (fragment: Fragment): Flattened => {
    let text = '';
    const values: unknown[] = [];
    for (let i = 0; i < fragment.strings.length; i += 1) {
      text += fragment.strings[i] ?? '';
      if (i >= fragment.values.length) continue;
      const value = fragment.values[i];
      if (isFragment(value)) {
        const nested = flatten(value);
        text += nested.text;
        values.push(...nested.values);
      } else {
        values.push(value);
        text += `$${values.length}`;
      }
    }
    return { text, values };
  };

  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment: Fragment = { __fragment: true, strings: [...strings], values };
    return Object.assign(fragment, {
      then: (resolve: (value: unknown[]) => unknown) => {
        statements.push(flatten(fragment));
        return Promise.resolve(rows.shift() ?? []).then(resolve);
      },
    });
  };

  const withWorkspace = async (_workspaceId: string, run: (sql: typeof tx) => unknown) => {
    return await run(tx);
  };

  return { statements, rows, withWorkspace };
});

vi.mock('@papercusp/db-org', async (original) => {
  const actual = await original<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: H.withWorkspace };
});

vi.mock('../../../hive-federation', async (original) => {
  const actual = await original<typeof import('../../../hive-federation')>();
  return {
    ...actual,
    potHomeSlugForHarness: vi.fn(async (_workspaceId: string, harnessSlug: string) => harnessSlug),
  };
});

import { getPlanItemRow, listPlanIndexRows, listPlanIndexRowsForWorkspace, planItemsForRow } from '../source';

beforeEach(() => {
  H.statements.length = 0;
  H.rows.length = 0;
});

function queryWithoutPlaceholderNumbers(sql: string): string {
  return sql.replace(/\$\d+/g, '$N');
}

describe('harness_plans index-list query shape', () => {
  it('reads graph plan items without selecting their markdown body or legacy item index', async () => {
    H.rows.push([{
      plan_slug: 'plan-a',
      archived: false,
      is_legacy: false,
      items: [],
      content: '',
    }]);
    H.rows.push([{
      feature_id: 'WI-1', item_kind: 'feature', plan_slug: 'plan-a', plan_line_id: 'P-001',
      plan_line_text: 'Stored item', status: 'open', plan_importance: 'normal',
      plan_phase: 'Phase 1', plan_decision_refs: [], plan_deliverable: null,
      plan_owner_gate_marker: null, blocked_by: [],
    }]);

    const row = await getPlanItemRow('plan-a', { harnessSlug: 'shape-harness', workspaceId: 'shape-workspace' });
    expect(row).toMatchObject({ planSlug: 'plan-a', archived: false, isLegacy: false, content: '' });
    expect(planItemsForRow(row!)).toMatchObject([{ id: 'P-001', text: 'Stored item', storedStatus: 'todo' }]);
    expect(H.statements).toHaveLength(2);
    expect(H.statements[0]!.text).toContain("SELECT plan_slug, archived, is_legacy, '[]'::jsonb AS items, '' AS content");
    expect(H.statements[1]!.text).toContain('FROM harness_shared.work_items n');
    expect(H.statements[1]!.text).toContain('FROM harness_shared.work_item_deps d');
    expect(H.statements[1]!.text).not.toContain('plan_items');
    expect(H.statements[0]!.text).not.toMatch(/SELECT\s+workspace_id[\s\S]*content_hash/);
  });

  it('an empty graph stays empty even if stale markdown declares an item', async () => {
    const content = `
# Demo

## Now
The plan is under test.

## Phase 1
- **P-001** \`todo\` First item
`;
    H.rows.push([{
      plan_slug: 'plan-a',
      archived: false,
      is_legacy: false,
      items: [],
      content: '',
    }]);
    H.rows.push([]);

    const row = await getPlanItemRow('plan-a', { harnessSlug: 'shape-harness', workspaceId: 'shape-workspace' });
    expect(row?.content).toBe('');
    expect(planItemsForRow({ ...row!, content })).toEqual([]);
  });

  it('keeps the per-harness statement shape stable across optional filters', async () => {
    const scope = { harnessSlug: 'shape-harness', workspaceId: 'shape-workspace' };
    await listPlanIndexRows({ ...scope, order: 'updated', includeItems: false, heavyFields: true });
    await listPlanIndexRows({
      ...scope,
      includeArchived: true,
      status: 'active',
      includeInstances: true,
      template: 'rubric',
      templateSlug: 'rubric-root',
      createdSince: '2026-08-01T00:00:00.000Z',
      updatedSince: '2026-08-02T00:00:00.000Z',
      order: 'updated',
      limit: 5,
      includeItems: false,
      heavyFields: true,
    });

    expect(H.statements).toHaveLength(2);
    expect(queryWithoutPlaceholderNumbers(H.statements[1]!.text)).toBe(
      queryWithoutPlaceholderNumbers(H.statements[0]!.text),
    );
    expect(H.statements[1]!.values).toHaveLength(H.statements[0]!.values.length);
    expect(H.statements[0]!.text).toContain('LIMIT $');
    expect(H.statements[0]!.text).toContain('status = $');
    expect(H.statements[0]!.text).toContain('created_at >= $');
    expect(H.statements[0]!.text).toContain('forced_past');
    expect(H.statements[0]!.text).toContain('input_schema IS NOT NULL AS has_input_schema');
    expect(H.statements[0]!.text).toContain('FROM harness_shared.trigger_bindings');
    expect(H.statements[0]!.text).toContain("tb.action->>'type' = 'launch-plan'");
    expect(H.statements[0]!.text).toContain('tb.detached_at IS NULL');
  });

  it('keeps the workspace-wide statement shape stable across optional filters', async () => {
    await listPlanIndexRowsForWorkspace({
      workspaceId: 'shape-workspace',
      order: 'created',
      includeItems: false,
      heavyFields: true,
    });
    await listPlanIndexRowsForWorkspace({
      workspaceId: 'shape-workspace',
      includeArchived: true,
      status: 'active',
      includeInstances: true,
      template: 'rubric',
      templateSlug: 'rubric-root',
      createdSince: '2026-08-01T00:00:00.000Z',
      updatedSince: '2026-08-02T00:00:00.000Z',
      order: 'created',
      limit: 5,
      includeItems: false,
      heavyFields: true,
    });

    expect(H.statements).toHaveLength(2);
    expect(queryWithoutPlaceholderNumbers(H.statements[1]!.text)).toBe(
      queryWithoutPlaceholderNumbers(H.statements[0]!.text),
    );
    expect(H.statements[1]!.values).toHaveLength(H.statements[0]!.values.length);
    expect(H.statements[0]!.text).toContain('forced_past');
    expect(H.statements[0]!.text).toContain('input_schema IS NOT NULL AS has_input_schema');
    expect(H.statements[0]!.text).toContain('FROM harness_shared.trigger_bindings');
    expect(H.statements[0]!.text).toContain('tb.detached_at IS NULL');
  });
});
