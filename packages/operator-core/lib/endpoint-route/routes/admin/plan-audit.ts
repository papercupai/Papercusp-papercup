import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { getPlanAuditRun, listPlanAuditRuns, readAuditArtifact, startPlanAudit } from '../../../plan-audit-runs';

export async function planAuditHandler(req: Request, _ctx: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (req.method === 'POST') {
      const csrf = requireAllowedOriginOr403(req);if (csrf) return csrf;
      let body: unknown;
      try { body = await req.json(); } catch { return Response.json({ error: 'Invalid audit request JSON' }, { status: 400 }); }
      const run = await startPlanAudit(body);
      return Response.json({ ok: true, run }, { status: 202 });
    }
    const id = url.searchParams.get('runId');
    if (!id) return Response.json({ ok: true, runs: await listPlanAuditRuns() }, { headers: { 'Cache-Control': 'no-store' } });
    const run = await getPlanAuditRun(id);
    if (!run) return Response.json({ error: 'Audit report not found in this workspace' }, { status: 404 });
    const format = url.searchParams.get('format');
    if (format === 'html' || format === 'json') {
      if (run.status !== 'complete') return Response.json({ error: run.error ?? 'Audit is not complete', run }, { status: 409 });
      const artifact = await readAuditArtifact(id, format === 'html' ? 'report.html' : 'audit.json');
      if (!artifact) return Response.json({ error: 'Audit evidence artifact is unavailable' }, { status: 404 });
      return new Response(artifact, { headers: {
        'Content-Type': format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(format === 'html' ? {
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; sandbox allow-scripts allow-downloads",
          // The app uses COEP; opaque sandbox frames must return an explicitly
          // compatible document. CORP is NOT CORS or an auth bypass: the route
          // remains authenticated, and the sandbox never grants same-origin.
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        } : {}),
      } });
    }
    return Response.json({ ok: true, run }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

// PlanAuditPane uses native fetch for starts, history, and the sandboxed report.
// Like the other owner-desktop admin surfaces, it must remain reachable during
// the cookie-less webview HTTP fallback (EI-338). POST is protected both by the
// route-stack browser policy and the handler's requireAllowedOriginOr403 guard.
// Remote access still passes the host's verified, workspace-bound cookie gate.
export default [defineTool({ method: 'POST', path: '/admin/plan-audit', auth: { trust: ['verified', 'trusted', 'unverified-loopback'] }, handler: planAuditHandler }), defineTool({ method: 'GET', path: '/admin/plan-audit', auth: { trust: ['verified', 'trusted', 'unverified-loopback'] }, handler: planAuditHandler })];
