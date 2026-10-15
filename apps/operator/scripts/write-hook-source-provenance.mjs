#!/usr/bin/env node
/**
 * Build-time provenance manifest for a PACKAGED hook directory (WI-6554700010010534).
 *
 *   node write-hook-source-provenance.mjs <source hook dir in git> <packaged copy dir>
 *
 * Writes `<packaged copy dir>/.source-provenance.json`: for every regular file in the
 * packaged copy, the last commit touching the same-named file in the source directory,
 * plus the last commit touching the source directory as a whole.
 *
 * Why: the desktop installer's downgrade guard (install-provenance.ts, WI-37405) orders
 * installs by git committer date. A packaged app ships no repository, so it had no date,
 * the guard failed open, and on 2026-10-13 a 2026-10-07 desktop build overwrote the
 * newer ~/.papercusp/hooks/cc a canonical tree had installed (RTK and lock hooks reverted
 * for every agent on the box). install-provenance.ts readSourceProvenanceManifest reads
 * this file when git has no answer. Keep the shape in sync with SourceProvenanceManifest.
 *
 * Files git has never seen (a bundle with a different name, a generated file) are left
 * out; the directory entry still dates the copy as a whole. Exits non-zero without
 * writing when git cannot date the source directory: a manifest that cannot order
 * anything must not be shipped looking like one that can.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SOURCE_PROVENANCE_BASENAME = '.source-provenance.json';

/**
 * The last commit touching `rel` (relative to `srcDir`), or null when git has none.
 * @param {string} srcDir
 * @param {string} rel
 * @returns {{ sha: string, committedAt: string } | null}
 */
export function lastCommitTouching(srcDir, rel) {
  try {
    const out = execFileSync('git', ['-C', srcDir, 'log', '-1', '--format=%H%n%cI', '--', rel], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim();
    const [sha, committedAt] = out.split('\n');
    const ms = committedAt ? Date.parse(committedAt) : NaN;
    return sha && Number.isFinite(ms) ? { sha, committedAt: new Date(ms).toISOString() } : null;
  } catch {
    return null;
  }
}

/**
 * The manifest for a packaged copy of `srcDir`.
 * @param {string} srcDir
 * @param {string} dstDir
 */
export function buildSourceProvenanceManifest(srcDir, dstDir) {
  /** @type {Record<string, { sha: string, committedAt: string }>} */
  const files = {};
  for (const name of readdirSync(dstDir).sort()) {
    if (name === SOURCE_PROVENANCE_BASENAME) continue;
    if (!statSync(path.join(dstDir, name)).isFile()) continue;
    const commit = lastCommitTouching(srcDir, name);
    if (commit) files[name] = commit;
  }
  const directory = lastCommitTouching(srcDir, '.');
  return { schemaVersion: 1, ...(directory ? { directory } : {}), files };
}

/**
 * Write the manifest into `dstDir`. Throws when the source directory cannot be dated.
 * @param {string} srcDir
 * @param {string} dstDir
 */
export function writeSourceProvenanceManifest(srcDir, dstDir) {
  const manifest = buildSourceProvenanceManifest(srcDir, dstDir);
  if (!manifest.directory) {
    throw new Error(`git has no commit touching ${srcDir}; refusing to write an undated provenance manifest`);
  }
  const dst = path.join(dstDir, SOURCE_PROVENANCE_BASENAME);
  const tmp = `${dst}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, dst);
  return manifest;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('write-hook-source-provenance.mjs');
if (invokedDirectly) {
  const [srcDir, dstDir] = process.argv.slice(2);
  if (!srcDir || !dstDir) {
    console.error('usage: write-hook-source-provenance.mjs <source hook dir> <packaged copy dir>');
    process.exit(2);
  }
  try {
    const m = writeSourceProvenanceManifest(srcDir, dstDir);
    console.log(
      `→ ${path.join(dstDir, SOURCE_PROVENANCE_BASENAME)}: ${Object.keys(m.files).length} file(s), ` +
        `directory ${m.directory?.sha.slice(0, 10)} @ ${m.directory?.committedAt}`,
    );
  } catch (err) {
    console.error(`write-hook-source-provenance: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
