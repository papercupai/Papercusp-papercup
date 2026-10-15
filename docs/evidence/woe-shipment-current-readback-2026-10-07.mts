/** Current staging containment proof; the native recorder owns runtime witnesses. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeOperationalRun } from '../../packages/operator-core/lib/agent-tools/testing/record-run';
import { getLatestPlanAudit } from '../../packages/operator-core/lib/plan-audits';

const exec = promisify(execFile);
const workspaceId = 'papercusp-workspace';
const harnessSlug = 'papercusp';
const plan = 'work-on-everything-stewardship-remediation-2026-08-30';
async function git(...args: string[]) {
  return (await exec('git', args, { timeout: 15_000 })).stdout.trim();
}
async function health(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!response.ok) throw new Error(`health ${port}: ${response.status}`);
  return (await response.json()).sha as string;
}
async function ancestor(parent: string, child: string) {
  try { await git('merge-base', '--is-ancestor', parent, child); return true; }
  catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}
const result = await executeOperationalRun({
  filePath: 'docs/evidence/woe-shipment-current-readback-2026-10-07.mts',
  name: 'WOE current staging containment against canonical completion audit',
  command: ['npx', 'tsx', 'docs/evidence/woe-shipment-current-readback-2026-10-07.mts'],
  framework: 'operational', runtimeUnits: ['hono-host:3170'],
  run: async () => {
    const audit = await getLatestPlanAudit(plan, { workspaceId, harnessSlug });
    if (!audit?.auditedSha) throw new Error('completion audit missing');
    const auditedSha = await git('rev-parse', `${audit.auditedSha}^{commit}`);
    const served = await git('rev-parse', `${await health(3170)}^{commit}`);
    const negative = await git('rev-parse', `${await health(3070)}^{commit}`);
    const citations = audit.items.flatMap(item => item.citations)
      .filter(citation => citation.path && citation.blobSha);
    if (citations.length !== 40) throw new Error(`citation population changed: ${citations.length}`);
    async function compare(ref: string) {
      const mismatches: string[] = [];
      for (const citation of citations) {
        let blob = '';
        try { blob = await git('rev-parse', `${ref}:${citation.path}`); }
        catch { /* Missing paths fail the same containment comparison. */ }
        if (blob !== citation.blobSha) mismatches.push(citation.path!);
      }
      return mismatches;
    }
    const positiveDrift = await compare(served);
    const negativeDrift = await compare(negative);
    const assertions = [
      { id: 'served-build-contains-audited-repaired', passed: positiveDrift.length === 0,
        evidence: JSON.stringify({ served, auditSeq: audit.auditSeq, population: citations.length, mismatches: positiveDrift }) },
      { id: 'served-build-contains-audited-negative', passed: negativeDrift.length > 0,
        evidence: JSON.stringify({ negative, mismatchCount: negativeDrift.length,
          population: citations.length, mismatchSample: negativeDrift.slice(0, 3) }) },
      { id: 'served-descends-audited-fixes-repaired',
        passed: await ancestor('da36b814', served) && await ancestor(auditedSha, served),
        evidence: JSON.stringify({ served, auditedSha, fix: 'da36b814' }) },
      { id: 'served-descends-audited-fixes-negative', passed: !await ancestor('da36b814', negative),
        evidence: JSON.stringify({ negative, fix: 'da36b814' }) },
      { id: 'runtime-identity-repaired', passed: served === auditedSha,
        evidence: JSON.stringify({ served, auditedSha }) },
      { id: 'runtime-identity-negative', passed: negative !== auditedSha,
        evidence: JSON.stringify({ negative, auditedSha }) },
    ];
    return { exitCode: assertions.every(assertion => assertion.passed) ? 0 : 1,
      summary: 'Current staging containment, lineage and identity with release negative controls; release shipment remains a separate follow-up.',
      assertions };
  },
}, { workspaceId, harnessSlug, projectDir: process.cwd() });
process.stdout.write(`${JSON.stringify(result)}\n`, () =>
  process.exit(result.ok && result.status === 'pass' && result.runtimeEnvironmentMeasured ? 0 : 1));
