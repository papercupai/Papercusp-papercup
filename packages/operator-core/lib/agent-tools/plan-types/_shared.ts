/**
 * Shared plumbing for the plan-types:* tools (plan-item-types-registry-cupboard-2026-10-20 P-005).
 * The registry is workspace-wide; `harness` only selects the workspace (and, for plan-types:pin,
 * the plan's harness).
 */
import { z } from 'zod';
import { withWorkspace } from '@papercusp/db-org';
import type postgres from 'postgres';
import { harnessScopedCtx } from '../_harness-scope';
import { resolvePlanWriteScope, type PlanWriteScope } from '../plans/_write-scope';
import { resolveAgentIdentity } from '../coordination/identity';

export const typeKindArg = z
  .enum(['item-type', 'plan-type'])
  .describe("'item-type' (what a plan item is) or 'plan-type' (what a plan is).");

export const typeIdArg = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/)
  .describe('Namespaced type id, e.g. acme/clause.');

export async function typeScope(harness: string | undefined, ctx: unknown): Promise<PlanWriteScope> {
  return resolvePlanWriteScope(harnessScopedCtx(harness, ctx as never));
}

/**
 * Who to record as the author of a registry write. Attribution is a record, not a gate: the
 * capability check already admitted the caller, so a context with no resolvable identity (an
 * in-process dispatch) is recorded as 'unattributed' instead of failing the write.
 */
export function callerId(ctx: unknown): string {
  try {
    return resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId ?? 'unattributed';
  } catch {
    return 'unattributed';
  }
}

export function inWorkspace<T>(workspaceId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, (tx) => fn(tx as unknown as postgres.TransactionSql));
}

/** A refusal is returned as data with isError, like every plans:* write. */
export function asToolResult<T extends { ok: boolean }>(result: T): { data: T & { error?: string }; isError?: true } {
  if (result.ok) return { data: result };
  const code = (result as { code?: string }).code;
  return { data: { ...result, ...(code ? { error: code } : {}) }, isError: true as const };
}
