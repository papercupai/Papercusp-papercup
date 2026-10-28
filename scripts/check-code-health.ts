/** P015 advisory per-change ratchet. Run: npx tsx scripts/check-code-health.ts
 * --base=HEAD --paths=a.ts,b.ts [--lineage=recorded-lineage.json] [--json]
 * No baseline reads/writes or git mutations are hidden. Unknowns stay visible.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { compareCodeHealth, measureCodeHealth, type HealthLineage, type HealthSnapshot } from '../packages/operator-core/lib/code-intelligence/code-health.ts';

const args = process.argv.slice(2);
const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const git = (...command: string[]) => execFileSync('git', command, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
const base = value('base') ?? 'HEAD';
const paths = value('paths')?.split(',') ?? git('diff', '--name-only', '-z', base, '--', '*.ts', '*.tsx').split('\0').filter(Boolean);
const lineage: HealthLineage[] = value('lineage') ? JSON.parse(readFileSync(value('lineage')!, 'utf8')) : [];
const snapshots: { before: HealthSnapshot[]; after: HealthSnapshot[] } = { before: [], after: [] };
for (const path of paths) {
  if (!/\.tsx?$/.test(path) || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Invalid source path: ${path}`);
  // ls-tree distinguishes a confirmed new file from an unreadable baseline.
  const exists = git('ls-tree', '-z', base, '--', path).length > 0;
  const previous = exists ? git('show', `${base}:${path}`) : '';
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  snapshots.before.push(measureCodeHealth(ts, ts.createSourceFile(path, previous, ts.ScriptTarget.Latest, true), path));
  snapshots.after.push(measureCodeHealth(ts, ts.createSourceFile(path, current, ts.ScriptTarget.Latest, true), path));
}
const merge = (rows: HealthSnapshot[]): HealthSnapshot => ({ metricVersion: 'compiler/complexity-v1', compilerVersion: ts.version,
  status: rows.every(row => row.status === 'measured') ? 'measured' : 'unknown',
  functions: rows.flatMap(row => row.functions), limitations: rows.flatMap(row => row.limitations) });
const result = compareCodeHealth(merge(snapshots.before), merge(snapshots.after), lineage);
console.log(args.includes('--json') ? JSON.stringify({ ...result, paths, compilerVersion: ts.version, snapshots })
  : [`code-health (${result.mode}): ${result.status}; ${paths.length} changed source files`, ...result.warnings,
    ...result.deltas.filter(row => row.status === 'unknown').map(row => `${row.id}: unknown — ${row.reason}`)].join('\n'));
// Warnings never change the process exit code; operational errors still fail visibly.
