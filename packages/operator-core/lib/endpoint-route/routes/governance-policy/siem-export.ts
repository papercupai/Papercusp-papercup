/**
 * POST /api/governance-policy/siem-export/status { stream, deliveries? }
 * POST /api/governance-policy/siem-export/next   { stream, limit?, acknowledgeKeyRotation? }
 * POST /api/governance-policy/siem-export/ack    { stream, idempotencyKey, cursorTo, acknowledgeKeyRotation? }
 *
 *   stream = { kind: 'tool-invocations', workspaceId? } | { kind: 'org-audit', organizationId }
 *
 * The SIEM export delivery doors (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * D-018 items 7-8, D-019; WI-6554700010012184). Every door runs the matching
 * data-governance/siem-export-delivery.ts operation.
 *
 * Why HTTP and not an agent MCP verb (D-019): export is human-only (D-018 item 6), and principal
 * kind comes from the authenticated door (governance-policy/authority.ts, D-015). This door stamps
 * `admin:<slug>`, a human administrator, the same way decide and delegate do. An agent session is a
 * service identity, so an MCP projection would refuse every caller it could have.
 *
 * A refusal answers ok:false with a stable `code` and a status, so a forwarder branches on the
 * code and never mistakes a refusal for an empty batch.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { SiemExportAccessError } from '../../../data-governance/siem-export';
import {
  SiemExportError,
  siemExportAck,
  siemExportNext,
  siemExportStatus,
  type SiemExportErrorCode,
  type SiemStreamRef,
} from '../../../data-governance/siem-export-delivery';
import { governancePolicyActor } from './policy';

/** 503 = the server's key configuration; 409 = the stream's state refuses it (call next again). */
export const SIEM_EXPORT_STATUS: Record<SiemExportErrorCode | 'forbidden', number> = {
  forbidden: 403,
  key_unconfigured: 503,
  key_too_short: 503,
  bad_request: 400,
  key_rotated: 409,
  nothing_to_ack: 409,
  cursor_not_rebuildable: 409,
  idempotency_mismatch: 409,
  cursor_moved: 409,
};

const streamSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool-invocations'), workspaceId: z.string().min(1).optional() }),
  z.object({ kind: z.literal('org-audit'), organizationId: z.string().min(1) }),
]);

export const siemExportStatusSchema = z.object({
  stream: streamSchema,
  deliveries: z.number().int().min(0).max(100).optional(),
});

export const siemExportNextSchema = z.object({
  stream: streamSchema,
  limit: z.number().int().positive().optional(),
  acknowledgeKeyRotation: z.boolean().optional(),
});

export const siemExportAckSchema = z.object({
  stream: streamSchema,
  idempotencyKey: z.string().min(1),
  cursorTo: z.string().min(1),
  acknowledgeKeyRotation: z.boolean().optional(),
});

type StreamInput = z.infer<typeof streamSchema>;

/** A tool-invocations stream with no workspaceId exports the request-scoped workspace. */
function streamRef(input: StreamInput): SiemStreamRef {
  return input.kind === 'org-audit'
    ? { kind: 'org-audit', organizationId: input.organizationId }
    : { kind: 'tool-invocations', workspaceId: input.workspaceId ?? activeWorkspaceId() };
}

/** Run one operation; map a SIEM refusal to its code and status, rethrow anything else. */
async function respond(op: string, run: () => Promise<object>): Promise<Response> {
  try {
    return Response.json({ ok: true, op, ...(await run()) });
  } catch (error) {
    if (error instanceof SiemExportError || error instanceof SiemExportAccessError) {
      return Response.json({ ok: false, op, code: error.code, error: error.message }, { status: SIEM_EXPORT_STATUS[error.code] });
    }
    throw error;
  }
}

const status = defineTool({
  method: 'POST',
  path: '/governance-policy/siem-export/status',
  auth: 'loopback',
  input: siemExportStatusSchema,
  async handler(_req, ctx) {
    const { stream, deliveries } = ctx.input;
    return respond('status', () =>
      siemExportStatus({ principal: governancePolicyActor(ctx), stream: streamRef(stream), deliveries }),
    );
  },
});

const next = defineTool({
  method: 'POST',
  path: '/governance-policy/siem-export/next',
  auth: 'loopback',
  input: siemExportNextSchema,
  async handler(_req, ctx) {
    const { stream, limit, acknowledgeKeyRotation } = ctx.input;
    return respond('next', () =>
      siemExportNext({ principal: governancePolicyActor(ctx), stream: streamRef(stream), limit, acknowledgeKeyRotation }),
    );
  },
});

const ack = defineTool({
  method: 'POST',
  path: '/governance-policy/siem-export/ack',
  auth: 'loopback',
  input: siemExportAckSchema,
  async handler(_req, ctx) {
    const { stream, idempotencyKey, cursorTo, acknowledgeKeyRotation } = ctx.input;
    return respond('ack', () =>
      siemExportAck({
        principal: governancePolicyActor(ctx),
        stream: streamRef(stream),
        idempotencyKey,
        cursorTo,
        acknowledgeKeyRotation,
      }),
    );
  },
});

export default [status, next, ack];
