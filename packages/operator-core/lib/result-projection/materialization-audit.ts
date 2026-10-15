/**
 * WI-6554700010010307 (plan oversized-tool-results-reduction-2026-10-12, D-004):
 * describe how a transport-level reduction materialized a call's source, so the
 * invocation ledger can count it.
 *
 * A caller `projection` or named view makes the MCP host re-dispatch the target
 * with a promoted context (full tier, transport-cap exempt) so the reduction can
 * search the complete result. That promotion is invisible in `args_json` — the
 * host strips `projection` before dispatch — so without this record a `pipe`
 * over a one-line JSON body, which reduces nothing and then hits the result door
 * at full size, cannot be told apart from an ordinary oversized call.
 *
 * The record rides on the tool context to the invocation recorder. Custom
 * result handlers also use promotedToFull to distinguish internal projection
 * materialization from an explicitly requested full payload (tools:find must
 * preserve its compact schema under a field pick).
 */
import type { ProjectionSpec } from './types';

export type SourceMaterializationAudit = {
  /**
   * `projection` when a caller projection spec drove the materialization;
   * `view` when only a named result view did (the host passes no spec then).
   */
  trigger: 'projection' | 'view';
  /** Number of `pick` paths, when the projection selects structured fields. */
  pickPaths?: number;
  /** The `pipe` operator names, in order, when the projection has line operators. */
  pipeOps?: string[];
  /** True when the inner dispatch was promoted to the full, cap-exempt tier. */
  promotedToFull: boolean;
  /** True when the source was materialized as JSON for a structured `pick`. */
  structuredSource: boolean;
};

export function describeSourceMaterialization(input: {
  sourceProjection?: ProjectionSpec | null;
  needsFullSource: boolean;
  needsStructuredSource: boolean;
}): SourceMaterializationAudit | null {
  const spec = input.sourceProjection ?? null;
  if (!spec && !input.needsFullSource && !input.needsStructuredSource) return null;
  return {
    trigger: spec ? 'projection' : 'view',
    ...(spec?.pick ? { pickPaths: spec.pick.length } : {}),
    ...(spec?.pipe ? { pipeOps: spec.pipe.map((stage) => stage.op) } : {}),
    promotedToFull: input.needsFullSource,
    structuredSource: input.needsStructuredSource,
  };
}
