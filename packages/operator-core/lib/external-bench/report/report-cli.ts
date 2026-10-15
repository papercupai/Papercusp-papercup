/**
 * CLI: emit a portable `report-<runId>.html` for ANY recorded benchmark run (plan
 * benchmark-report-portable-trace-2026-06-17, P-001). The auto-emit hook in
 * `recordRunCompletion` covers runs that finish through the L2 bench-run path; this gives an
 * on-demand path for any run that has `benchmark_run_result` rows (e.g. a suite runner that only
 * writes L1 results). Builds from the live store via {@link emitReport} — no run re-execution.
 *
 *   npx tsx packages/operator-core/lib/external-bench/report/report-cli.ts <runId> \
 *     [--out <dir>] [--workspace <slug>] [--attribution] [--control <arm>]
 *
 * With no <runId>, lists the most-recent run ids in the result table so you can pick one.
 *
 * `--attribution` ALSO writes a `attribution-<runId>.md` — the per-capability "which capability lifted
 * which suite/task, at what cost" headline (plan P-011; vanilla-vs-+memory/+coord/ours over the stored
 * rows). `--control <arm>` overrides the default `vanilla` control. Suites without the control arm are
 * listed as skipped, not silently dropped.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from '../../util/cli-entry';
import { emitReport } from './report-builder-pg';
import { buildRunCapabilityAttribution, formatRunAttributionMarkdown } from './capability-attribution-report';
import { resolveDb } from '../reproducibility/db';

interface ReportArgs {
  runId?: string;
  workspace?: string;
  outDir?: string;
  control?: string;
  attribution: boolean;
}

/** Consume option values before looking for the single positional run ID. */
export function parseReportArgs(argv: string[]): ReportArgs {
  const result: ReportArgs = { attribution: false };
  const seen = new Set<string>();
  const valueOptions = { workspace: 'workspace', out: 'outDir', control: 'control' } as const;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      if (result.runId) throw new Error('Pass exactly one benchmark run ID');
      result.runId = token;
      continue;
    }
    const equals = token.indexOf('=');
    const name = token.slice(2, equals < 0 ? undefined : equals);
    if (seen.has(name)) throw new Error(`Duplicate option --${name}`);
    seen.add(name);
    if (name === 'attribution' && equals < 0) {
      result.attribution = true;
      continue;
    }
    if (!Object.hasOwn(valueOptions, name)) throw new Error(`Unknown option ${token}`);
    const value = equals < 0 ? argv[++i] : token.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    result[valueOptions[name as keyof typeof valueOptions]] = value;
  }
  return result;
}

export async function listRecentRuns(workspace?: string) {
  const { sql, ws } = resolveDb(workspace ? { workspaceId: workspace } : {});
  return (await sql`
    SELECT run_id, suite, count(*)::int n, max(created_at) last
    FROM harness_shared.benchmark_run_result
    WHERE workspace_id = ${ws}
    GROUP BY run_id, suite ORDER BY max(created_at) DESC LIMIT 20`) as Array<{
    run_id: string;
    suite: string;
    n: number;
    last: Date | string;
  }>;
}

export async function runReportCli(argv: string[]): Promise<number> {
  const { runId, workspace, outDir, attribution, control } = parseReportArgs(argv);
  if (!runId) {
    const rows = await listRecentRuns(workspace);
    if (!rows.length) console.error('no runs found in harness_shared.benchmark_run_result');
    else {
      console.error('recent runs (pass one as <runId>):');
      for (const r of rows) {
        const last = (r.last as Date)?.toISOString?.() ?? String(r.last);
        console.error(`  ${r.run_id}  suite=${r.suite}  rows=${r.n}  last=${last}`);
      }
    }
    return 1;
  }

  const path = await emitReport(runId, { workspace, outDir });
  if (path) console.log(`wrote ${path}`);
  else {
    console.error(`no benchmark_run_result rows for run "${runId}" — nothing to report`);
    return 2;
  }

  if (attribution) {
    const run = await buildRunCapabilityAttribution(runId, {
      workspace,
      ...(control ? { attribution: { control } } : {}),
    });
    if (!run) {
      console.error(`no rows for run "${runId}" — no attribution`);
      return 2;
    }
    const dir = outDir ?? join(homedir(), '.papercusp', 'bench-results', 'reports');
    mkdirSync(dir, { recursive: true });
    const mdPath = join(dir, `attribution-${runId}.md`);
    writeFileSync(mdPath, formatRunAttributionMarkdown(run), 'utf8');
    console.log(`wrote ${mdPath}`);
  }
  return 0;
}

if (isCliEntry(import.meta.url)) {
  try { process.exit(await runReportCli(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }
}
