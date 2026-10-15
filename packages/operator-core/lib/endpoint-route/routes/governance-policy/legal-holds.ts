/**
 * POST /api/governance-policy/legal-holds/list    { organizationId, workspaceId?, includeReleased? }
 * POST /api/governance-policy/legal-holds/place   { organizationId, workspaceId?, dataSourceId, channelId?, reason }
 * POST /api/governance-policy/legal-holds/release { organizationId, workspaceId?, holdId, reason }
 *
 * The legal-hold administration doors (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-017,
 * child P-017b WI-6554700010012480). Each door runs the matching data-governance/legal-holds.ts
 * operation, which writes through the single hold writers and appends an organization audit event.
 *
 * Why HTTP and not an agent MCP verb (D-019, as for the SIEM export doors): placing or releasing a
 * hold decides whether an organization's data may be deleted, so it is a human administrator's act.
 * This door stamps `admin:<slug>` from the authenticated principal and requires that human to hold
 * governance `approve` over the organization's root policy layer: the same rule as audit export
 * (siem-export-org-audit.ts `assertOrgAuditExportAuthorized`). An agent session is a service identity
 * and is refused.
 *
 * `workspaceId` defaults to the request-scoped workspace and is the organization's declared scope for
 * the operation. A refusal answers ok:false with a stable `code` and status.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { activeWorkspaceId } from '../../../workspace-registry';
import { SiemExportAccessError } from '../../../data-governance/siem-export';
import { assertOrgAuditExportAuthorized } from '../../../data-governance/siem-export-org-audit';
import type { RefusalContract } from '../../../capability-envelope/refusal-contract-types';
import {
  LegalHoldError,
  listOrganizationLegalHolds,
  placeOrganizationLegalHold,
  releaseOrganizationLegalHold,
  type LegalHoldErrorCode,
} from '../../../data-governance/legal-holds';
import type { OrganizationDataScope, ReceiptActor } from '../../../data-governance/organization-data-receipts';
import { governancePolicyActor } from './policy';

export const LEGAL_HOLD_STATUS: Record<LegalHoldErrorCode, number> = {
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  already_released: 409,
};

const LEGAL_HOLD_AUTHORIZATION_REFUSAL: RefusalContract = {
  observed: { organizationApproval: 'not satisfied', requiredCapability: 'approve' },
  liftsWhen:
    'a human administrator has a valid organization root policy and holds governance approve over it; if the authorization check is unavailable, restore it and retry',
  whoCanMakeItTrue: ['owner', 'host'],
};

const base = {
  organizationId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
};

export const legalHoldListSchema = z.object({ ...base, includeReleased: z.boolean().optional() });
export const legalHoldPlaceSchema = z.object({
  ...base,
  dataSourceId: z.string().min(1),
  channelId: z.string().min(1).optional(),
  reason: z.string().min(1),
});
export const legalHoldReleaseSchema = z.object({ ...base, holdId: z.string().min(1), reason: z.string().min(1) });

/** Test seam: the pool the doors run against (production: the shared org pool). */
let poolForTests: Sql | null = null;
export function setLegalHoldDoorSqlForTests(sql: Sql | null): void {
  poolForTests = sql;
}
function pool(): Sql {
  return poolForTests ?? getOrgPg().sql;
}

/** Authorize the human admin over the organization, then run `op` as that admin. */
async function respond(
  op: string,
  ctx: { principal?: { slug?: string } | null },
  input: { organizationId: string; workspaceId?: string },
  run: (sql: Sql, scope: OrganizationDataScope, actor: ReceiptActor) => Promise<object>,
): Promise<Response> {
  const principal = governancePolicyActor(ctx);
  const sql = pool();
  try {
    await assertOrgAuditExportAuthorized(principal, input.organizationId, { sql });
    const scope: OrganizationDataScope = {
      organizationId: input.organizationId,
      workspaceIds: [input.workspaceId ?? activeWorkspaceId()],
    };
    return Response.json({ ok: true, op, ...(await run(sql, scope, { kind: 'staff_admin', id: principal })) });
  } catch (error) {
    if (error instanceof SiemExportAccessError) {
      return Response.json({
        ok: false, op, code: 'forbidden', error: error.message, refusal: LEGAL_HOLD_AUTHORIZATION_REFUSAL,
      }, { status: 403 });
    }
    if (error instanceof LegalHoldError) {
      return Response.json({ ok: false, op, code: error.code, error: error.message }, { status: LEGAL_HOLD_STATUS[error.code] });
    }
    throw error;
  }
}

const list = defineTool({
  method: 'POST',
  path: '/governance-policy/legal-holds/list',
  auth: 'loopback',
  input: legalHoldListSchema,
  async handler(_req, ctx) {
    const { includeReleased } = ctx.input;
    return respond('list', ctx, ctx.input, async (sql, scope, actor) => ({
      holds: await listOrganizationLegalHolds(sql, { scope, actor, includeReleased }),
    }));
  },
});

const place = defineTool({
  method: 'POST',
  path: '/governance-policy/legal-holds/place',
  auth: 'loopback',
  input: legalHoldPlaceSchema,
  async handler(_req, ctx) {
    const { dataSourceId, channelId, reason } = ctx.input;
    return respond('place', ctx, ctx.input, (sql, scope, actor) =>
      placeOrganizationLegalHold(sql, { scope, actor, workspaceId: scope.workspaceIds[0]!, dataSourceId, channelId, reason }),
    );
  },
});

const release = defineTool({
  method: 'POST',
  path: '/governance-policy/legal-holds/release',
  auth: 'loopback',
  input: legalHoldReleaseSchema,
  async handler(_req, ctx) {
    const { holdId, reason } = ctx.input;
    return respond('release', ctx, ctx.input, (sql, scope, actor) =>
      releaseOrganizationLegalHold(sql, { scope, actor, holdId, reason }),
    );
  },
});

export default [list, place, release];
