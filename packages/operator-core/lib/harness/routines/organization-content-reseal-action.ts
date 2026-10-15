/**
 * `system:organization-content-reseal` — the DEK-rotation re-seal sweep for sealed organization
 * documents (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b follow-up,
 * WI-6554700010012443 U5). Seeded by `seed-organization-content-reseal-routine.ts`.
 *
 * Thin registration seam: all logic, and the reasons for it, live in
 * `data-governance/organization-document-reseal.ts` (`resealStaleOrganizationDocuments`).
 * Safe to re-run from the top: every write-back is a compare-and-swap, and a row already at its
 * organization's active DEK version is never selected.
 *
 * Config (routine `trigger_config`, optional):
 *   - `batchSize` — rows examined per tick (default 200, clamped to 1..5000).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { resealStaleOrganizationDocuments } from '../../data-governance/organization-document-reseal';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

registerSystemAction('organization-content-reseal', async (ctx: SystemActionCtx): Promise<SystemActionResult> => {
  const batchSize = Number((ctx.triggerConfig ?? {}).batchSize);
  const { sql } = getOrgPg();
  const result = await resealStaleOrganizationDocuments(sql as unknown as Sql, Number.isFinite(batchSize) && batchSize > 0 ? { batchSize } : {});
  const diagnostics = {
    examined: result.examined,
    resealed: result.resealed,
    raced: result.raced,
    deferred: result.deferred,
    failures: result.failures.slice(0, 20),
    failureCount: result.failures.length,
    more: result.more,
  };
  // Quiet on the steady state (nothing stale). Anything examined gets one line.
  if (result.examined > 0) {
    console.log(
      `[organization-content-reseal] ${ctx.installSlug}: examined ${result.examined}, resealed ${result.resealed}, ` +
        `raced ${result.raced}, deferred ${result.deferred}, failures ${result.failures.length}${result.more ? ', more remain' : ''}`,
    );
  }
  if (result.failures.length > 0) {
    return {
      diagnostics,
      softError: `organization-content-reseal: ${result.failures.length} failure(s); first: ` +
        `${result.failures[0]!.organizationId}/${result.failures[0]!.documentId ?? result.failures[0]!.workspaceId} ${result.failures[0]!.code}`,
    };
  }
  return { diagnostics };
});
