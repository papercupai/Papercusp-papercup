/** Live acceptance route for WOE-P006-SHIPMENT. Run with
 * PAPERCUSP_WOE_SERVED_AUDIT=1 and PAPERCUSP_WOE_REPOSITORY set to the
 * canonical staging repository. Reads only; never changes audit or runtime.
 * Ordinary isolated CI has no live operator dependency and skips this cohort.
 */
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { realGitProbe } from './judged-sha-containment';

const enabled = process.env.PAPERCUSP_WOE_SERVED_AUDIT === '1';
const root = process.env.PAPERCUSP_WOE_REPOSITORY;
const plan = 'work-on-everything-stewardship-remediation-2026-08-30';
type Citation = { itemId: string; path: string; blobSha: string };
let served: string;
let release: string;
let audit: { audit_seq: number; audited_sha: string; citations: Citation[] };
const negative = 'd740fc3802877d1c8c3b1068768681ee32ef0025';
function contained(ref: string) {
  return audit.citations.length > 0 && audit.citations.every(c =>
    realGitProbe.blobAt(root!, ref, c.path) === c.blobSha);
}
describe.runIf(enabled)('WOE served staging build against canonical completion audit', () => {
  beforeAll(async () => {
    expect(root, 'Explicit canonical repository is required').toBeTruthy();
    const health = async (port: number) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(10000) });
      expect(response.ok).toBe(true);
      const body = await response.json() as { sha: string };
      const sha = realGitProbe.revParse(root!, `${body.sha}^{commit}`);
      expect(sha, 'Health SHA must resolve to an actual commit').toBeTruthy();
      return sha!;
    };
    [served, release] = await Promise.all([health(3170), health(3070)]);
    // Same registered completion-audit table and latest-completion selection
    // as getLatestPlanAudit. psql avoids the integration fixture's test DSN:
    // this cohort must read the audit belonging to the actual serving host.
    const query = `SELECT json_build_object('audit_seq',a.audit_seq,'audited_sha',a.audited_sha,
      'citations',(SELECT json_agg(json_build_object('itemId',i->>'itemId','path',c->>'path','blobSha',c->>'blobSha'))
       FROM jsonb_array_elements(a.items) i, jsonb_array_elements(i->'citations') c
       WHERE c->>'path' IS NOT NULL AND c->>'blobSha' IS NOT NULL))
      FROM harness_shared.plan_audits a WHERE workspace_id='papercusp-workspace'
      AND plan_slug='${plan}' AND audit_kind='completion' ORDER BY audit_seq DESC LIMIT 1`;
    audit = JSON.parse(execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-At', '-c', query],
      { encoding: 'utf8', timeout: 15000 }));
    expect(audit.citations?.length).toBeGreaterThan(0);
    for (const itemId of ['P-001', 'P-002', 'P-003', 'P-004', 'P-005']) {
      expect(audit.citations.some(c => c.itemId === itemId), `${itemId} must have audited blobs`).toBe(true);
    }
  }, 40000);
  it('served-build-contains-audited-repaired', () => {
    expect(contained(served), JSON.stringify(audit)).toBe(true);
  });
  it('served-build-contains-audited-negative', () => {
    expect(contained(negative)).toBe(false);
  });
  it('served-descends-audited-fixes-repaired', () => {
    expect(realGitProbe.isAncestor(root!, 'da36b814', served)).toBe(true);
    expect(realGitProbe.isAncestor(root!, audit.audited_sha, served)).toBe(true);
  });
  it('served-descends-audited-fixes-negative', () => {
    expect(realGitProbe.isAncestor(root!, 'da36b814', negative)).toBe(false);
  });
  it('runtime-identity-repaired', async () => {
    expect(served).toBe(audit.audited_sha);
    const again = await fetch('http://127.0.0.1:3170/api/health', { signal: AbortSignal.timeout(10000) });
    const body = await again.json() as { sha: string };
    expect(realGitProbe.revParse(root!, `${body.sha}^{commit}`), 'Runtime must stay stable throughout measurement').toBe(served);
  });
  it('runtime-identity-negative', () => {
    expect(release).not.toBe(audit.audited_sha);
  });
});
