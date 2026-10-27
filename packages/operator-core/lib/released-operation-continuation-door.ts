import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { classifyCallOrigin } from './telemetry-call-origin';

/**
 * The one hook-owned escape hatch from an accepted-operation identity.
 *
 * This name is deliberately not part of an operation receipt's requiredTools.
 * The dispatch kernel admits it only for a first-party hook-declared request;
 * the handler then re-establishes every mutable premise from durable state
 * before it may launch anything.
 */
export const RELEASED_OPERATION_CONTINUATION_TOOL = 'sessions:continue-released-operation';

export function isHookReleasedOperationContinuationCall(input: {
  toolName: string;
  ctx: Pick<UnifiedToolContext, 'requestOrigin'>;
}): boolean {
  if (input.toolName.trim() !== RELEASED_OPERATION_CONTINUATION_TOOL) return false;
  const origin = classifyCallOrigin({ requestOrigin: input.ctx.requestOrigin });
  return origin.origin === 'hook' && origin.source === 'declared';
}
