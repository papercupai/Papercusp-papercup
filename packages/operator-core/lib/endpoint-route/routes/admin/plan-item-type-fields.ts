/**
 * POST /admin/plan-item-type-fields — the Plans pane completion form's submit
 * (plan-item-types-registry-cupboard-2026-10-20 P-007, R-20, D-009).
 *
 * Body `{ slug, harness?, itemId, typeFields }`. The fields are checked by `checkTypeFields`
 * against the item's pinned item-type contract, the same validation `work_items:complete`
 * applies to `completion.typeFields`, so the form can only accept what the close will accept.
 * Answers `{ ok: true }` or `{ ok: false, code, errors }` with status 200; 404 for an unknown
 * plan or item, 400 for a malformed request.
 */
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { checkPlanItemTypeFields } from '../../../plan-types/item-type-view';

interface FieldsRequest {
  slug: string;
  harness?: string;
  itemId: string;
  typeFields: Record<string, unknown>;
}

function parseRequest(body: unknown): FieldsRequest | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request body must be an object';
  const { slug, harness, itemId, typeFields } = body as Record<string, unknown>;
  if (typeof slug !== 'string' || slug === '') return 'slug is required';
  if (typeof itemId !== 'string' || !/^P-\d{3,}$/.test(itemId)) return 'itemId must be a plan item id (P-NNN)';
  if (harness !== undefined && typeof harness !== 'string') return 'harness must be a string';
  if (!typeFields || typeof typeFields !== 'object' || Array.isArray(typeFields)) return 'typeFields must be an object';
  return { slug, itemId, typeFields: typeFields as Record<string, unknown>, ...(harness ? { harness } : {}) };
}

export async function planItemTypeFieldsHandler(req: Request, _ctx: RouteContext): Promise<Response> {
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid request JSON' }, { status: 400 });
  }
  const parsed = parseRequest(body);
  if (typeof parsed === 'string') return Response.json({ ok: false, error: parsed }, { status: 400 });
  try {
    const result = await checkPlanItemTypeFields({
      planSlug: parsed.slug,
      itemId: parsed.itemId,
      typeFields: parsed.typeFields,
      ...(parsed.harness ? { harnessSlug: parsed.harness } : {}),
    });
    const notFound = !result.ok && (result.code === 'plan_not_found' || result.code === 'plan_item_not_found');
    return Response.json(result, { status: notFound ? 404 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export default [
  defineTool({
    method: 'POST',
    path: '/admin/plan-item-type-fields',
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    handler: planItemTypeFieldsHandler,
  }),
];
