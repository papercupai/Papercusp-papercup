/**
 * plans:verification-health — verification-system-improvements-2026-10-10 P-002.
 *
 * The READ-ONLY resolver behind the `verification.health` state cell
 * (cell-registrations.ts VERIFICATION_HEALTH_CELL). It wires the pure aggregation in
 * `verification-health.ts` to Postgres and to lane 2's two injected measures (plan
 * Decision D-018): `measureContractTriage` (P-004) and `measureStaleAcceptance` (P-005).
 * Neither measure's SQL is re-derived here.
 *
 * SCOPE: the whole workspace unless `harness` is passed. The session's own harness is
 * deliberately NOT inherited, so the cell (callerRelativity: global) reads the same value
 * for every reader in the workspace.
 */
import { z } from 'zod';
import { withWorkspace } from '@papercusp/db-org';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessScopedCtx, isAllHarnessSentinel } from '../_harness-scope';
import { resolvePlanWriteScope } from './_write-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import { measureContractTriage } from './contract-triage';
import { measureStaleAcceptance } from './acceptance-drain-disposition';
import {
  runVerificationHealth,
  type VerificationHealthMeasures,
  type VerificationHealthSql,
} from '../../verification-health';

/** A transaction handle that is both a tagged-template `sql` (lane 2) and has `unsafe` (this module). */
export type VerificationHealthTx = VerificationHealthSql & Parameters<typeof measureContractTriage>[0];

/** Lane 2's measures, adapted to the injected-measure contract (D-018). */
export const VERIFICATION_HEALTH_MEASURES: VerificationHealthMeasures<VerificationHealthTx> = {
  measureContractTriage: (sql, args) => measureContractTriage(sql, args),
  measureStaleAcceptance: (sql, args) =>
    measureStaleAcceptance(sql as unknown as Parameters<typeof measureStaleAcceptance>[0], args),
};

export interface VerificationHealthScope {
  workspaceId: string;
  harnessSlug: string | null;
}

/**
 * An explicit concrete `harness` narrows the read (resolved through the plan-scope seam,
 * so a Hive-home slug collapses exactly as plans:* does). Omitted, or the all-sentinel,
 * means the whole workspace.
 */
export async function resolveVerificationHealthScope(
  harness: string | undefined,
  ctx: unknown,
): Promise<VerificationHealthScope> {
  if (harness && !isAllHarnessSentinel(harness)) {
    const scope = await resolvePlanWriteScope(harnessScopedCtx(harness, (ctx ?? {}) as { harnessSlug?: string | null }));
    return { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug };
  }
  const ctxWorkspace = (ctx as { workspaceId?: unknown } | null | undefined)?.workspaceId;
  const workspaceId = typeof ctxWorkspace === 'string' && ctxWorkspace ? ctxWorkspace : activeWorkspaceId();
  return { workspaceId, harnessSlug: null };
}

export default defineTool({
  name: 'plans:verification-health',
  description:
    'Read verification-system health from Postgres: contract coverage by cohort, evidence-bound clause share, uncovered active plans, awaiting-acceptance age histogram, forced ships, VAL-* block usage, and threshold breaches.',
  guidance: {
    when: 'As the resolver behind state:read { cell:"verification.health" }, or to see where the verification system is unused or failing without hand-written SQL.',
    notWhen: 'To repair a plan: use plans:migrate-acceptance-bars or plans:acceptance-disposition.',
    chaining: 'state:read { cell:"verification.health" } is the ordinary entry point; a null probe reading names its cause in health.measurementErrors.',
  },
  // @cell-lens verification.health
  // The registered resolver behind VERIFICATION_HEALTH_CELL. Read-only by contract.
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    harness: z
      .string()
      .min(1)
      .optional()
      .describe('Narrow to one harness. Omit for the whole workspace (what the cell reads).'),
  }),
  async handler(args, ctx) {
    const { workspaceId, harnessSlug } = await resolveVerificationHealthScope(args.harness, ctx);
    const report = await withWorkspace(workspaceId, (tx) =>
      runVerificationHealth(tx as unknown as VerificationHealthTx, { workspaceId, harnessSlug }, VERIFICATION_HEALTH_MEASURES),
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(report) }] };
  },
});
