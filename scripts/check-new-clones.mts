#!/usr/bin/env -S tsx
/** Explicit ESM keeps the CLI on the committed-source loader's ESM path.
 * Advisory only. Baseline writes are explicit; ordinary lint never edits it.
 * --seed creates the first CURRENT-tree baseline; --shrink can only remove debt.
 * --base binds both change reconstruction and shrink-only validation to git.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloneIndex, CLONE_NORMALIZATION_VERSION, classifyClonePath } from '../packages/operator-core/lib/code-intelligence/clone-index';
import { assertBaselineShrinks, familyCounts, findNewClones, parseCloneBaseline, ratchetFamilies,
  seedCloneBaseline, shrinkCloneBaseline } from '../packages/operator-core/lib/code-intelligence/clone-ratchet';
import { declaredSubmodules, listFilesIncludingUntracked } from './lib/tracked-files.mjs';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eligible = (path: string) => /\.tsx?$/.test(path) && !Object.values(classifyClonePath(path)).some(Boolean);
const jsonFile = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

export function runCloneLint(args: string[]) {
  args = args.flatMap(arg => {
    const equals = arg.indexOf('=');
    if (equals < 0 || !arg.startsWith('--')) return [arg];
    const flag = arg.slice(0, equals), value = arg.slice(equals + 1);
    return flag === '--files' || flag === '--changed-paths' ? [flag, ...value.split(',').filter(Boolean)] : [flag, value];
  });
  let root = scriptRoot, baselinePath = 'scripts/new-clones-baseline.json', base = 'HEAD';
  let seed = false, shrink = false;
  const changed: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seed') seed = true;
    else if (arg === '--shrink') shrink = true;
    else if (['--root', '--baseline', '--base', '--files-from'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--root') root = resolve(value);
      if (arg === '--baseline') baselinePath = value;
      if (arg === '--base') base = value;
      if (arg === '--files-from') {
        const text = readFileSync(value, 'utf8');
        const paths: unknown = text.trimStart().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean);
        if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error('Changed-path response must contain strings');
        changed.push(...paths);
      }
    } else if (arg === '--changed-paths' || arg === '--files') {
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) changed.push(args[++i]);
    } else if (arg !== '--json') throw new Error(`Unknown clone lint argument: ${arg}`);
  }
  if (seed && shrink) throw new Error('Choose either --seed or --shrink');
  const baselineFile = resolve(root, baselinePath);
  const git = (cwd: string, ...argv: string[]) => execFileSync('git', argv,
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  const coverage = listFilesIncludingUntracked(root);
  if (coverage.unscanned.length) throw new Error(`Clone corpus incomplete: ${coverage.unscanned.join(', ')}`);
  const index = new CloneIndex(), digest = createHash('sha256');
  for (const path of [...new Set<string>(coverage.files)].filter(eligible).sort()) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    const source = readFileSync(absolute, 'utf8');
    const file = index.update({ path, source }).file;
    digest.update(path).update('\0').update(file.sha256!).update('\0');
  }
  const families = ratchetFamilies(index);
  const filesScanned = index.size;
  const incomplete = index.getFiles().filter(file => file.status === 'syntax-error' || file.status === 'unavailable').map(file => file.path);
  if (seed) {
    if (existsSync(baselineFile)) throw new Error('Clone baseline already exists; reseeding is refused');
    if (incomplete.length) throw new Error(`Cannot seed incomplete clone corpus: ${incomplete.join(', ')}`);
    const baseline = seedCloneBaseline(index, { ref: git(root, 'rev-parse', 'HEAD').trim(),
      sourceDigest: digest.digest('hex'), files: index.size });
    writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
    return { mode: 'warn-only', status: 'seeded', normalizationVersion: CLONE_NORMALIZATION_VERSION,
      families: families.length, files: index.size, warnings: [], incomplete };
  }
  const baseline = parseCloneBaseline(jsonFile(baselineFile), index.minMass);
  const baselineRelative = relative(root, baselineFile).split('\\').join('/');
  const baselineAt = (ref: string) => parseCloneBaseline(JSON.parse(git(root, 'show', `${ref}:${baselineRelative}`)), index.minMass);
  const baseHasBaseline = !!git(root, 'ls-tree', '-z', base, '--', baselineRelative);
  let previousBaseline = baseHasBaseline ? baselineAt(base) : undefined;
  // Validate each intervening revision: comparing only the endpoints could
  // accept debt removed and then re-added while the affected base lagged behind.
  const revisions = git(root, 'rev-list', '--reverse', baseHasBaseline ? `${base}..HEAD` : 'HEAD', '--', baselineRelative)
    .split('\n').filter(Boolean);
  for (const ref of revisions) {
    const next = baselineAt(ref);
    if (previousBaseline) assertBaselineShrinks(previousBaseline, next);
    previousBaseline = next;
  }
  if (!previousBaseline) throw new Error('Clone baseline must be committed before advisory comparison');
  assertBaselineShrinks(previousBaseline, baseline);
  // Reconstruct the base using the same index: only diff paths are reparsed.
  // Deleted/renamed paths come from git, not only the caller's changed-path list.
  const scopes = [{ prefix: '', cwd: root, ref: base }, ...declaredSubmodules(root).map((prefix: string) => ({
    prefix: `${prefix}/`, cwd: resolve(root, prefix), ref: git(root, 'rev-parse', `${base}:${prefix}`).trim(),
  }))];
  const delta = new Set(changed);
  for (const scope of scopes) {
    const paths = new Set([...git(scope.cwd, 'diff', '--name-only', '--no-renames', '-z', scope.ref, '--').split('\0'),
      ...git(scope.cwd, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean));
    for (const path of changed) if (path.startsWith(scope.prefix)) paths.add(path.slice(scope.prefix.length));
    for (const localPath of paths) {
      const path = `${scope.prefix}${localPath}`;
      if (!eligible(path)) continue;
      delta.add(path);
      const listed = git(scope.cwd, 'ls-tree', '-z', scope.ref, '--', localPath);
      if (!listed) { index.remove(path); continue; }
      index.update({ path, source: git(scope.cwd, 'show', `${scope.ref}:${localPath}`) });
    }
  }
  const warnings = findNewClones(families, baseline, changed.length ? changed : [...delta], familyCounts(ratchetFamilies(index)));
  if (shrink) {
    if (incomplete.length) throw new Error('Cannot shrink an incomplete clone corpus');
    writeFileSync(baselineFile, `${JSON.stringify(shrinkCloneBaseline(baseline, families), null, 2)}\n`);
  }
  return { mode: 'warn-only', status: 'checked', files: filesScanned, warnings, incomplete };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = runCloneLint(process.argv.slice(2));
    if (process.argv.includes('--json')) console.log(JSON.stringify(report));
    else {
      for (const warning of report.warnings) console.warn(`[new-clones] WARNING ${warning.kind}: ${warning.members.map(m => `${m.path}:${m.line} ${m.name}`).join(' | ')}`);
      console.log(`[new-clones] warn-only: ${report.status}; ${report.warnings.length} new families; ${report.incomplete.length} unchecked syntax/unavailable files`);
    }
  } catch (error) {
    console.warn(`[new-clones] NOT CHECKED (warn-only): ${error instanceof Error ? error.message : String(error)}`);
  }
  // An advisory, including unavailable evidence, must never hold promotion.
  process.exitCode = 0;
}
