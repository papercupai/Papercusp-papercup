/**
 * Shared payload reader for `abortCompletionReceipt` resolvers (WI-10005670).
 *
 * A mutating tool whose handler returns AFTER the dispatch deadline would otherwise
 * be reported as a bare `timeout` although its write committed (the commit-unknown
 * window). A tool opts out of that by declaring an `abortCompletionReceipt` resolver
 * that reads its OWN completed result and names the effect it recorded. Every such
 * resolver starts by locating the JSON payload in the returned ToolResult; this is
 * that one parser, so the receipts cannot drift in how they read a result envelope.
 */
import { unwrapToolResult, type ToolResult } from '@papercusp/tooldef';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The structured payload of a completed tool result. Reuse the framework's
 * decoder so structuredContent, compact MCP TOON and HTTP JSON carry the same
 * evidence (including JSON hint trailers). Unwrap a `{ data }` envelope when
 * present. Receipt resolvers still validate their own effect fields and fail
 * closed when decoding does not produce an object that proves the write.
 */
export function completedResultPayload(result: ToolResult): Record<string, unknown> | null {
  const root = asRecord(unwrapToolResult(result));
  return asRecord(root?.data) ?? root;
}
