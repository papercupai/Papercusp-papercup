/**
 * GET /api/harness/:slug/assertion/:valId
 *
 * RETIRED (verification-system-improvements-2026-10-10 P-003, SPEC-P-003-VAL-READERS).
 * This route used to resolve an inline VAL-* assertion by id from
 * harness_shared.harness_plan_assertions. Inline VAL-* assertions are retired in
 * favour of the requirement contract, so the route now answers every request with
 * the typed `val-read-retired` refusal (HTTP 410) and reads nothing. A validator
 * reads the requirement contract instead: plans:get returns the spec clauses and
 * their bound evidence.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { valRetirementRefusal } from '../../../agent-tools/plans/val-retirement';

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/assertion/:valId',
  auth: 'public',
  // Retired reader: kept as a route so an old validator gets a typed 410 naming
  // the successor, instead of a bare 404 it would read as "assertion missing".
  // (HTTP-route defineTools carry no `guidance` block — that's MCP-tool only.)
  async handler(_req, ctx) {
    const valId = typeof ctx.params.valId === 'string' ? ctx.params.valId : undefined;
    const refusal = valRetirementRefusal(
      'val-read-retired',
      valId ? `requested ${valId}` : undefined,
    );
    return Response.json(refusal, { status: refusal.httpStatus });
  },
});
