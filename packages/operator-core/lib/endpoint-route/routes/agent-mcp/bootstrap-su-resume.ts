/** Existing managed resume routes, independent of launch/persona assembly. */
import { defineTool } from '@papercusp/agent-mcp';
import { requirePrincipal } from '../../../auth/require-principal';
import {
  acquireAdvSessionResume,
  claimAdvSessionResume,
  finalizeAdvSessionResume,
  getAdvSession,
  isAdvSessionLocalLivenessEvidence,
  releaseAdvSessionResume,
} from '../../../adv-sessions';
import { CORS_HEADERS, gatePrincipal, jsonRes } from './bootstrap-su-shared';

/**
 * POST /api/agent-mcp/console/bootstrap-su/session-resumed
 *   { advSessionId, resumeClaimKey? }
 *
 * The psu launcher's atomic RESUME acquisition. A keyed caller receives an
 * explicit short-lived reservation; acquisition preserves terminal evidence and
 * therefore does not assert that a child exists. The caller must finalize that
 * reservation from concrete spawn evidence, or release it on setup failure.
 * Legacy no-key callers retain the historical one-step claim during rollout.
 *
 * The keyed response is typed (`acquired` + `status` and lease metadata) and also
 * keeps the historical `reactivated` field for compatibility. In either shape,
 * false means "the right to resume was not acquired — do not spawn".
 */
const sessionResumed = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resumed',
  auth: 'loopback',
  async handler(req) {
    // notify-classification: {"classification":"durable","reason":"Resume admission reaches notification wrappers whose mandatory consequences must survive the request ending.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let advSessionId: number | null = null;
    let resumeClaimKey: string | null = null;
    let localLivenessEvidence: unknown = undefined;
    let allowRetired = false;
    try {
      const body = (await req.json()) as {
        advSessionId?: unknown;
        resumeClaimKey?: unknown;
        localLivenessEvidence?: unknown;
        allowRetired?: unknown;
        assumeHost?: { request?: unknown; afterExit?: unknown; action?: unknown; startup?: unknown };
      };
      if (body.assumeHost !== undefined) {
        // Extend the existing managed resume control plane; never let a normal
        // authenticated app principal inspect administrative custody receipts.
        // notify-classification: {"classification":"durable","reason":"Administrative custody admission must retain any notification consequences reached through its principal wrapper.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
        const principal = await requirePrincipal(req.headers, { kind: ['system'], trust: ['trusted'] });
        if (principal.slug !== 'system:superuser' || principal.authMethod !== 'bearer-token' ||
            typeof body.assumeHost?.afterExit !== 'boolean') return jsonRes({ ok: false }, 403);
        if (body.assumeHost.action !== undefined && (typeof body.assumeHost.action !== 'string' ||
            !['freeze', 'queue', 'thaw', 'observe', 'complete-return', 'begin-startup', 'startup-started'].includes(body.assumeHost.action))) return jsonRes({ ok: false }, 400);
        try {
          const { inspectManagedAssumeRequest } = await import('../../../session-assume-runtime');
          // notify-classification: {"classification":"durable","reason":"Managed assume transitions restore caller responsibilities and their mandatory audit consequences across request loss.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
          return jsonRes(await inspectManagedAssumeRequest(body.assumeHost.request, body.assumeHost.afterExit,
            body.assumeHost.action as string | undefined, body.assumeHost.startup));
        } catch { return jsonRes({ ok: false, reason: 'assume-custody-unverified' }, 409); }
      }
      if (body.allowRetired !== undefined && typeof body.allowRetired !== 'boolean') {
        return jsonRes({ error: 'allowRetired must be boolean' }, 400);
      }
      allowRetired = body.allowRetired === true;
      if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
        advSessionId = body.advSessionId;
      }
      if (body.resumeClaimKey != null) {
        if (typeof body.resumeClaimKey !== 'string') {
          return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
        }
        resumeClaimKey = body.resumeClaimKey.trim();
        if (!resumeClaimKey || resumeClaimKey.length > 200) {
          return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'localLivenessEvidence')) {
        if (!isAdvSessionLocalLivenessEvidence(body.localLivenessEvidence)) {
          return jsonRes({
            error:
              "localLivenessEvidence must be { version: 1, kind: 'no-live-codex-writer' | 'no-live-claude-process' | 'no-live-omp-process' }",
          }, 400);
        }
        localLivenessEvidence = body.localLivenessEvidence;
      }
    } catch {
      /* fall through to the 400 */
    }
    if (advSessionId == null || advSessionId <= 0) {
      return jsonRes({ error: 'advSessionId required' }, 400);
    }
    try {
      if (resumeClaimKey) {
        const reservation = localLivenessEvidence === undefined && !allowRetired
          ? await acquireAdvSessionResume(advSessionId, resumeClaimKey)
          : await acquireAdvSessionResume(
            advSessionId,
            resumeClaimKey,
            undefined,
            undefined,
            localLivenessEvidence,
            allowRetired,
          );
        return jsonRes({ ok: true, ...reservation, reactivated: reservation.acquired });
      }
      const claimed = await claimAdvSessionResume(advSessionId, null);
      return jsonRes({ ok: true, reactivated: claimed === true,
        ...(claimed === 'retired' ? { status: 'retired' } : {}) });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

async function parseResumeTransitionBody(
  req: Request,
): Promise<{ advSessionId: number; resumeClaimKey: string; launchArgv?: string[]; allowRetired?: boolean } | Response> {
  let advSessionId: number | null = null;
  let resumeClaimKey: string | null = null;
  let launchArgv: string[] | undefined;
  let allowRetired: boolean | undefined;
  try {
    const body = (await req.json()) as {
      advSessionId?: unknown;
      resumeClaimKey?: unknown;
      launchArgv?: unknown;
      allowRetired?: unknown;
    };
    if (body.allowRetired !== undefined && typeof body.allowRetired !== 'boolean') {
      return jsonRes({ error: 'allowRetired must be boolean' }, 400);
    }
    if (body.allowRetired === true) allowRetired = true;
    if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
      advSessionId = body.advSessionId;
    }
    if (typeof body.resumeClaimKey === 'string') {
      const candidate = body.resumeClaimKey.trim();
      if (candidate && candidate.length <= 200) resumeClaimKey = candidate;
    }
    if (body.launchArgv !== undefined) {
      if (
        !Array.isArray(body.launchArgv) ||
        body.launchArgv.length === 0 ||
        body.launchArgv.length > 256 ||
        !body.launchArgv.every(
          (arg): arg is string =>
            typeof arg === 'string' && arg.length > 0 && arg.length <= 4096,
        )
      ) {
        return jsonRes(
          {
            error:
              'launchArgv must be a non-empty array of strings (at most 256 entries, each at most 4096 characters)',
          },
          400,
        );
      }
      launchArgv = body.launchArgv;
    }
  } catch {
    /* return the shared validation response below */
  }
  if (advSessionId == null || advSessionId <= 0) {
    return jsonRes({ error: 'advSessionId required' }, 400);
  }
  if (!resumeClaimKey) {
    return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
  }
  return { advSessionId, resumeClaimKey, ...(launchArgv ? { launchArgv } : {}),
    ...(allowRetired ? { allowRetired } : {}) };
}

/** Finalize a keyed resume reservation from concrete child/host spawn evidence. */
const sessionResumeFinalized = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resume-finalized',
  auth: 'loopback',
  async handler(req) {
    // notify-classification: {"classification":"durable","reason":"Resume finalization admission must retain mandatory notification consequences reached through its gate wrapper.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    const parsed = await parseResumeTransitionBody(req);
    if (parsed instanceof Response) return parsed;
    try {
      const finalized = await finalizeAdvSessionResume(
        parsed.advSessionId,
        parsed.resumeClaimKey,
        parsed.launchArgv,
        parsed.allowRetired,
      );
      if (finalized) {
        try {
          const session = await getAdvSession(parsed.advSessionId);
          if (session?.coordOwnerId) {
            const { armInboxWake } = await import('../../../events/await/inbox-wake-arm');
            await armInboxWake({ ownerId: session.coordOwnerId });
          } else {
            process.stderr.write(
              `[bootstrap-su] resumed inbox-wake arm skipped: no coord owner for adv session ${parsed.advSessionId}\n`,
            );
          }
        } catch (err) {
          process.stderr.write(
            `[bootstrap-su] resumed inbox-wake arm failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      return jsonRes({ ok: true, finalized, resumeClaimKey: parsed.resumeClaimKey });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionResumeFinalized = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resume-finalized',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/** Release a keyed reservation after setup/pre-spawn failure without asserting liveness. */
const sessionResumeReleased = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resume-released',
  auth: 'loopback',
  async handler(req) {
    // notify-classification: {"classification":"durable","reason":"Resume release admission must retain mandatory notification consequences reached through its gate wrapper.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    const parsed = await parseResumeTransitionBody(req);
    if (parsed instanceof Response) return parsed;
    try {
      const released = await releaseAdvSessionResume(parsed.advSessionId, parsed.resumeClaimKey);
      return jsonRes({ ok: true, released, resumeClaimKey: parsed.resumeClaimKey });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionResumeReleased = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resume-released',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const optionsForSessionResumed = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resumed',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

export default [
  sessionResumed,
  optionsForSessionResumed,
  sessionResumeFinalized,
  optionsForSessionResumeFinalized,
  sessionResumeReleased,
  optionsForSessionResumeReleased,
];
