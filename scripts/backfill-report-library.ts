/** One-shot, retry-safe import of the two owner-authorized historical reports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeReportBackfill } from '../packages/operator-core/lib/report-backfill';

async function main() {
const workspaceId = process.env.PAPERCUSP_WORKSPACE;
const ownerId = process.env.PAPERCUSP_SID;
assert.ok(workspaceId && workspaceId !== '*' && ownerId, 'Run in the attributed, concrete workspace');
const sources = [
  { directory: 'docs/reports/owner-project-architecture-audit-2026-09-14', ref: 'work-item:WI-10001433' },
  { directory: 'docs/reports/owner-project-transformer-audit-2026-09-14', ref: 'work-item:WI-10001436' },
];
const reports = sources.map(source => makeReportBackfill({ workspaceId,
  sourcePath: `${source.directory}/README.md`, sourceRef: source.ref,
  bodyMd: readFileSync(join(source.directory, 'README.md'), 'utf8'),
  diagramMd: readFileSync(join(source.directory, 'architecture.mmd'), 'utf8'),
}));
if (!process.argv.includes('--confirm')) {
  console.log(JSON.stringify({ dryRun: true, reports: reports.map(report => ({ title: report.title,
    source: report.source, requestKey: report.requestKey, bodyBytes: Buffer.byteLength(report.bodyMd!, 'utf8') })) }, null, 2));
} else {
  const [{ default: postgres }, { resolveScriptPgUrl }, { publishReportWithEffects }, { getReport }] = await Promise.all([
    import('postgres'), import('./lib/pg-url.mjs'),
    import('../packages/operator-core/lib/report-publication'), import('../packages/operator-core/lib/report-library'),
  ]);
  const sql = postgres(resolveScriptPgUrl().url, { max: 2 });
  try {
    for (const input of reports) {
      const { report } = await publishReportWithEffects(sql, input, { authorOwnerId: ownerId,
        harnessSlug: 'papercusp', authorSessionRef: `backfill:${input.subject!.ref}` }, message => console.warn(message));
      const saved = await getReport(sql, workspaceId, report.reportId, { ownerId });
      assert.equal(saved?.bodyMd, input.bodyMd, 'Backfill readback changed the original source');
      console.log(JSON.stringify({ report_id: report.reportId, path: `/reports?sel=${encodeURIComponent(report.reportId)}`,
        title: report.title, source: report.source, body_sha256: report.bodySha256, verified: true }));
    }
  } finally { await sql.end(); }
}
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
