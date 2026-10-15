import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeReportBackfill } from '../../../packages/operator-core/lib/report-backfill';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Reports backfill CLI', () => {
  it('runs its real dry-run entry without a database and previews both exact historical sources', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_WORKSPACE: 'backfill-cli-fixture', PAPERCUSP_SID: 'backfill-cli-author' };
    // A dry run must not construct a database client or execute publication effects.
    for (const key of ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL']) env[key] = 'invalid://dry-run';
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/backfill-report-library.ts'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    const preview = JSON.parse(output);
    expect(preview.dryRun).toBe(true);
    const sources = [
      { directory: 'docs/reports/owner-project-architecture-audit-2026-09-14', ref: 'work-item:WI-10001433' },
      { directory: 'docs/reports/owner-project-transformer-audit-2026-09-14', ref: 'work-item:WI-10001436' },
    ];
    expect(preview.reports).toEqual(sources.map(source => {
      const report = makeReportBackfill({ workspaceId: env.PAPERCUSP_WORKSPACE!,
        sourcePath: `${source.directory}/README.md`, sourceRef: source.ref,
        bodyMd: readFileSync(resolve(root, source.directory, 'README.md'), 'utf8'),
        diagramMd: readFileSync(resolve(root, source.directory, 'architecture.mmd'), 'utf8') });
      return { title: report.title, source: report.source, requestKey: report.requestKey,
        bodyBytes: Buffer.byteLength(report.bodyMd!, 'utf8') };
    }));
  });
});
