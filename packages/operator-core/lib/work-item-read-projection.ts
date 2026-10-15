/**
 * Read-side column projection shared by the two physical work-item families.
 *
 * The result `projection` argument is normally a post-handler reduction, but
 * callers that select only a small work-item field should not make Postgres
 * return and postgres-js parse the entire JSONB payload first. Keep the
 * storage policy here so issue and feature readers cannot drift.
 */

import type { ItemField } from './scheduler/claim-spec';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';

export type WorkItemPayloadProjection = 'full' | 'none' | 'completionEvidence' | 'fleetMetrics' | 'fleetMetricsCensus';

// Terminal rows feed stock/flow, the claim matcher and presentation stages, but
// never the remaining queue's park/review clocks. Enumerate the matcher's payload
// inputs by vocabulary: a new field must declare its projection dependency.
const terminalMatcherKeys = {
  id: [], title: [], summary: [], kind: [], priority: [], age: [],
  assignee: [], goal: [], blocked: [], cursed: [],
  tags: ['tags'], paths: ['paths', 'filePath'],
  plan: ['plan_run', 'plan_item', 'planItem', 'source_plan_slug'],
  plan_item: ['plan_item', 'planItem', 'source_plan_item_ids'],
  fleet: ['fleet_slug'], triage_gate: ['ideaLifecycle'],
  item_class: ['sourceRole', 'ideaOrigin'], risk_tier: ['risk_tier'],
  redundancy: ['redundancy'], est_cost: ['est_cost', 'expected_cost_cents'],
  severity: ['_ei', 'severity'],
} satisfies Record<ItemField, readonly string[]>;

export const FLEET_METRIC_TERMINAL_PAYLOAD_KEYS = [...new Set([
  ...Object.values(terminalMatcherKeys).flat(),
  '_ei', 'lane', 'implementationReadiness', 'verification',
])];

/**
 * Fleet metrics read authority from the row, not the structured close receipt.
 * Keep every control/matcher key (including future keys) and omit only these
 * archival envelopes. This projection must never feed a completion/cohort audit.
 */
export const FLEET_METRIC_ARCHIVE_KEYS = [
  '_completionEvidence', 'toolFailureProbation', 'freshnessEnvelope',
  'admissionIdentity', '_claimSubjectBaseline',
  '_assumptions', 'toolFailureSignature',
] as const;

export interface WorkItemReadOptions {
  /**
   * Issue-family body projection. Feature-family summaries are kept because
   * they are part of that table's canonical row shape.
   */
  includeBody?: boolean;
  /**
   * `none` returns a typed NULL payload; `completionEvidence` returns only the
   * `_completionEvidence` member, wrapped under the original payload key so
   * existing mappers preserve terminal-evidence semantics.
   */
  payloadProjection?: WorkItemPayloadProjection;
}

const PAYLOAD_COLUMN = /(^|,\s*)payload(\s*,)/;

/**
 * Project returned columns in a canonical column allowlist.
 * WHERE predicates may still read the physical payload; this helper changes
 * the SELECT projection and keeps the original row arity/key.
 */
export function projectWorkItemColumns(
  columns: string,
  projection: WorkItemPayloadProjection = 'full',
  terminalStateColumn: 'state' | 'status' = 'status',
): string {
  if (projection === 'full') return columns;
  if (projection === 'fleetMetrics' || projection === 'fleetMetricsCensus') {
    const keys = FLEET_METRIC_ARCHIVE_KEYS.map(key => `'${key}'`).join(', ');
    // These issue-only metadata fields are not mapped into WorkItem. Reading
    // them would repeatedly detoast the original payload for no metric input.
    // Full/detail readers retain them; this policy is for the metric source only.
    for (const key of ['source', 'signal_origin', 'found_during', 'linked_feature_id']) {
      columns = columns.replace(new RegExp(`(^|,\\s*)${key}(\\s*,)`), `$1NULL::text AS ${key}$2`);
    }
    // Scalar/array/JSON-null payloads retain their exact legacy shape. Subtracting
    // object keys from a scalar can throw, and silently normalizing it hides bugs.
    const terminalKeys = FLEET_METRIC_TERMINAL_PAYLOAD_KEYS.map(key => `'${key}'`).join(', ');
    const terminalStates = ANY_FAMILY_TERMINAL_STATES.map(state => `'${state}'`).join(', ');
    const objectPayload = projection === 'fleetMetricsCensus'
      ? `CASE WHEN ${terminalStateColumn} = ANY(ARRAY[${terminalStates}]::text[]) THEN
          (SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
             FROM jsonb_each(payload) WHERE key = ANY(ARRAY[${terminalKeys}]::text[]))
          ELSE payload - ARRAY[${keys}]::text[] END`
      : `payload - ARRAY[${keys}]::text[]`;
    return columns.replace(PAYLOAD_COLUMN,
      `$1(CASE WHEN jsonb_typeof(payload) = 'object' THEN ${objectPayload} ELSE payload END) AS payload$2`);
  }
  const replacement =
    projection === 'none'
      ? 'NULL::jsonb AS payload'
      : "jsonb_build_object('_completionEvidence', payload -> '_completionEvidence') AS payload";
  return columns.replace(PAYLOAD_COLUMN, `$1${replacement}$2`);
}
