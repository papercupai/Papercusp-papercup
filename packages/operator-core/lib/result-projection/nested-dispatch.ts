import { unwrapToolResult, type ToolResult, type UnifiedToolContext } from '@papercusp/tooldef';
import { applyResultProjection, projectionMaterializationFormat, type ApplyProjectionOpts } from './apply';
import { describeSourceMaterialization } from './materialization-audit';
import { parseProjection } from './parse';
import { PROJECTION_ARG, type ProjectionSpec } from './types';

export interface PreparedNestedProjection {
  /** The target-schema-visible arguments. */
  args: unknown;
  /** The validated dispatch-level projection, or null when absent. */
  spec: ProjectionSpec | null;
  /** Present when the caller supplied a malformed projection. */
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Strip and validate the host-owned projection before a nested target schema sees it. */
export function prepareNestedProjection(input: unknown): PreparedNestedProjection {
  if (!isRecord(input) || !(PROJECTION_ARG in input)) return { args: input, spec: null };

  const parsed = parseProjection(input[PROJECTION_ARG]);
  if (!parsed.ok) return { args: input, spec: null, error: parsed.error };

  const { [PROJECTION_ARG]: _projection, ...args } = input;
  return { args, spec: parsed.spec };
}

/** Keep the invalid-spec wording consistent for nested callers and the transport door. */
export function nestedProjectionInvalidMessage(error: string): string {
  return (
    `projection_invalid: ${error}\n` +
    'The `projection` argument reduces ANY tool result: ' +
    `{ pick?: ["results[].id"], pipe?: [{ op:"grep", pattern:"..." }, { op:"head", n:20 }] }. ` +
    'A single `pick` list accepts at most 32 paths; split larger selections across calls. ' +
    'An ARRAY-root body (a bare list result) is selected with "[].field", not "field". ' +
    'Operators: grep (fixed/ignoreCase/invert/before/after/context), head, tail, sort, uniq, cut, count.'
  );
}

/**
 * Apply a dispatch-level projection to the plain value delivered to a script.
 * Nested orchestration already unwraps MCP results, so briefly materialize the
 * value as JSON/text, use the canonical projection implementation, then unwrap
 * it again. This preserves the direct transport's fail-open and pick semantics.
 */
export function applyNestedProjection<T>(
  value: T,
  spec: ProjectionSpec | null,
  opts?: ApplyProjectionOpts,
): T {
  if (!spec) return value;

  let text: string;
  try {
    if (typeof value === 'string') text = value;
    else {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) return value;
      text = encoded;
    }
  } catch {
    return value;
  }

  const projected = applyResultProjection(
    { content: [{ type: 'text', text }] },
    spec,
    opts,
  );
  const projectedResult = projected as unknown as ToolResult;
  const bodyContentIndex = (
    projectedResult._meta?.resultProjection as { bodyContentIndex?: unknown } | undefined
  )?.bodyContentIndex;
  if (typeof bodyContentIndex === 'number' && Number.isInteger(bodyContentIndex)) {
    const bodyItem = projectedResult.content?.[bodyContentIndex];
    if (bodyItem?.type === 'text' && typeof bodyItem.text === 'string') {
      // applyResultProjection leads with degrading diagnostics so transport
      // truncation cannot hide them. A code-mode caller needs the projected
      // body as its typed root; unwrap that explicit body item while retaining
      // resultProjection in _meta for object results.
      return unwrapToolResult({
        ...projectedResult,
        content: [bodyItem],
        structuredContent: undefined,
      }) as T;
    }
  }
  return unwrapToolResult(projectedResult) as T;
}

/**
 * Promote the nested target only as far as the projection requires. A caller's
 * explicit payloadTier remains authoritative; structured picks still force JSON
 * materialization and source-aware handlers receive the same parsed projection
 * metadata as the direct MCP path.
 */
export function nestedProjectionContext(
  ctx: UnifiedToolContext,
  args: unknown,
  spec: ProjectionSpec | null,
): UnifiedToolContext {
  if (!spec) return ctx;

  const hasExplicitPayloadTier = isRecord(args) && 'payloadTier' in args;
  const needsFullSource = !hasExplicitPayloadTier;
  const needsStructuredSource = spec.pick !== undefined;
  // Audit-only (WI-6554700010010307): lets the invocation ledger count which
  // projections promoted their source, which args_json cannot show.
  const sourceMaterialization = describeSourceMaterialization({
    sourceProjection: spec,
    needsFullSource,
    needsStructuredSource,
  });
  if (!needsFullSource && !needsStructuredSource) {
    return sourceMaterialization ? { ...ctx, sourceMaterialization } : ctx;
  }

  return {
    ...ctx,
    ...(sourceMaterialization ? { sourceMaterialization } : {}),
    ...(needsFullSource
      ? {
          contextTier: 'full' as const,
          payloadTierOverride: 'full' as const,
          transportCapExempt: true,
        }
      : {}),
    sourceProjection: spec,
    requestedFormat: projectionMaterializationFormat(
      ctx.requestedFormat,
      needsStructuredSource,
    ),
  };
}
