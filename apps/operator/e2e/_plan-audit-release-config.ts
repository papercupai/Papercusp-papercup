import { homedir } from 'node:os';
import { join } from 'node:path';

/** Final R-5 proof has a separate profile; the ordinary fixture journey stays
 * current-build evidence. A missing receipt is never a skipped green check. */
export function readPlanAuditReleaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const expectedSha = env.PAPERCUSP_PLAN_AUDIT_RELEASE_SHA?.trim() ?? '';
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error('PAPERCUSP_PLAN_AUDIT_RELEASE_SHA must be the full promoted green artifact SHA.');
  }
  const receiptRef = env.PAPERCUSP_PLAN_AUDIT_RELEASE_RECEIPT?.trim();
  if (!receiptRef) throw new Error('PAPERCUSP_PLAN_AUDIT_RELEASE_RECEIPT must name the authoritative promotion/deploy receipt.');
  const workspace = env.PAPERCUSP_WORKSPACE?.trim();
  const clientId = env.PAPERCUSP_SID?.trim();
  if (!workspace || !clientId) throw new Error('Release audit requires PAPERCUSP_WORKSPACE and the current PAPERCUSP_SID for scope and attribution.');
  const origin = new URL(env.OPERATOR_E2E_BASE_URL || 'http://127.0.0.1:3070');
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.port !== '3070' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Final plan-audit evidence must use the release operator origin on loopback port3070.');
  }
  const home = env.PAPERCUSP_HOME || join(homedir(), '.papercusp');
  return {
    origin: origin.origin, expectedSha, receiptRef, home, workspace, clientId,
    evidenceDir: join(home, 'verification', 'plan-audit-release', expectedSha, `${Date.now()}-${process.pid}`),
  };
}

export function assertPlanAuditReleaseHealth(health: unknown, expectedSha: string): string {
  const body = health as { ok?: boolean; service?: string; sha?: string; bundleStale?: unknown } | null;
  const sha = body?.sha;
  // getBuildInfo may publish a baked abbreviated SHA. The complete identity
  // comes from the independent promotion receipt and serving-runtime read.
  if (!body?.ok || body.service !== 'papercusp-operator' || body.bundleStale ||
      typeof sha !== 'string' || !/^[a-f0-9]{10,64}$/.test(sha) || !expectedSha.startsWith(sha)) {
    throw new Error('Release operator health does not match the promoted artifact, or its bundle is stale.');
  }
  return sha;
}
