/**
 * Pure node construction for the dependency-graph census (`reconcileDependencyGraphPolicy`).
 *
 * Kept free of any database import so the equivalence guard
 * (dependency-graph-candidates.test.ts) can drive the exact identity rules the census
 * uses without a Postgres handle.
 *
 * Identity (D-003, matching the writer and claim floors): issue-family rows resolve by the
 * BARE feature id, feature-family rows by the harness-qualified `harness#feature_id`. Each
 * row also carries the other spelling as an alias, so an endpoint that uses it resolves
 * as `mismatched` rather than `missing`.
 */
import type { DependencyGraphNodeInput } from './dependency-graph-analysis';

import { ISSUE_FAMILY_ROUTE_KINDS } from '../work-nature/agent-work-predicate';
export const ISSUE_ENDPOINT_KIND = 'issue';
export const FEATURE_ENDPOINT_KIND = 'feature';

const ISSUE_ITEM_KINDS = new Set<string>(ISSUE_FAMILY_ROUTE_KINDS);
const ISSUE_TERMINAL = new Set(['resolved', 'closed', 'done', 'dropped']);
const FEATURE_TERMINAL = new Set(['passed', 'deprecated', 'done', 'dropped']);

export interface CensusWorkItemRow {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string;
  status: string | null;
}

export function censusNodeFromWorkItemRow(row: CensusWorkItemRow): DependencyGraphNodeInput {
  const issue = ISSUE_ITEM_KINDS.has(row.item_kind);
  const qualified = `${row.harness_slug}#${row.feature_id}`;
  return {
    id: issue ? { kind: ISSUE_ENDPOINT_KIND, ref: row.feature_id } : { kind: FEATURE_ENDPOINT_KIND, ref: qualified },
    aliases: issue
      ? [
          { kind: FEATURE_ENDPOINT_KIND, ref: qualified },
          { kind: ISSUE_ENDPOINT_KIND, ref: qualified },
        ]
      : [
          { kind: ISSUE_ENDPOINT_KIND, ref: row.feature_id },
          { kind: FEATURE_ENDPOINT_KIND, ref: row.feature_id },
        ],
    terminal: (issue ? ISSUE_TERMINAL : FEATURE_TERMINAL).has(row.status ?? ''),
    scope: `${row.workspace_id}/${row.harness_slug}`,
  };
}

/**
 * Every `work_items.feature_id` that could resolve one of these endpoint refs.
 *
 * Every canonical key and alias a row produces (see `censusNodeFromWorkItemRow`) has a ref
 * equal to either `feature_id` or `harness#feature_id`. So a row can match ref R only if
 * its `feature_id` is R itself or the part of R after a `#`. Both the first-`#` and
 * last-`#` suffixes are included so an unexpected `#` inside a harness slug or feature id
 * can only ADD candidates (harmless: they are filtered by exact key matching
 * downstream), never drop one.
 */
export function dependencyEndpointCandidateFeatureIds(refs: Iterable<string>): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    if (!ref) continue;
    ids.add(ref);
    const first = ref.indexOf('#');
    if (first >= 0) {
      ids.add(ref.slice(first + 1));
      ids.add(ref.slice(ref.lastIndexOf('#') + 1));
    }
  }
  ids.delete('');
  return [...ids].sort();
}
