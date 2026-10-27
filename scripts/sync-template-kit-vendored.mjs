#!/usr/bin/env node
// sync-template-kit-vendored — derive the per-template vendored template-kit
// copies from their single canonical source (libs/generic/template-kit).
//
// WHY (plan papercusp-agentic-webapp-template-2026-08-23; prior drift filed as
// EI-20496357290097303): every app-root template whose checks import
// `@papercusp/template-kit` must VENDOR the kit inside its own template dir —
// only `<ref>/` is overlaid into a materialized app
// (template-bundle-integrity.test.ts invariant 1), and each vendored copy must
// stay byte-identical to canonical in both directions (invariant 2,
// findVendorDrift). Until this script existed the copies were refreshed by
// hand, and every canonical edit was a fresh chance to strand six copies —
// the drift class this derives away (derived-truth ladder rung 1: DERIVE).
//
// WHAT IT DOES, deterministically:
//   for each templates/<ref>/ whose checks/*.ts imports @papercusp/template-kit
//   (the same trigger condition template-bundle-integrity enforces):
//     - ensure templates/<ref>/template-kit/ exists
//     - write package.json as vendoredManifestOf(canonical): the canonical
//       manifest minus its dev-harness-only devDependencies (a private
//       workspace package a materialized app cannot resolve)
//     - copy libs/generic/template-kit/tsconfig.json
//     - copy libs/generic/template-kit/src/** minus the dev harness
//       (*.test.ts, vitest.config.ts, README.md — the isVendorDevOnly set)
//     - delete vendored files whose canonical counterpart is gone
//
// Usage:
//   node scripts/sync-template-kit-vendored.mjs           # apply
//   node scripts/sync-template-kit-vendored.mjs --check   # report drift, exit 1 if any
//   node scripts/sync-template-kit-vendored.mjs --target=apps/example --check
// Explicit targets derive a materialized app's kit too; omitted targets are untouched.
//
// The byte-equality GUARD stays template-bundle-integrity.test.ts (operator-core);
// this script is the matching WRITER. Both import isVendorDevOnly and
// vendoredManifestOf from scripts/lib/vendored-manifest.mjs, so the guard
// verifies exactly what this derives (no lockstep copies to keep in sync).

import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVendorDevOnly, vendoredManifestOf } from './lib/vendored-manifest.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CANONICAL = join(ROOT, 'libs', 'generic', 'template-kit');
const TEMPLATES = join(ROOT, 'templates');
const KIT_PKG = '@papercusp/template-kit';
const CHECK_MODE = process.argv.includes('--check');
const EXTRA_TARGETS = process.argv.slice(2).filter(arg => arg.startsWith('--target=')).map(arg => arg.slice('--target='.length));

const exists = (p) => fs.stat(p).then(() => true, () => false);

// isVendorDevOnly (the dev harness a vendored copy omits) is imported above.

/** dir-relative file list (posix slashes), skipping node_modules + dot-dirs. */
async function filesUnder(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(full, base)));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

/**
 * Does any checks/*.ts in this template IMPORT the kit? Same four entry shapes
 * as template-bundle-integrity's externalImportsOf — a bare `includes()` is
 * wrong here because most aspect checks MENTION the kit in comments/prose
 * without importing it, and matching those would vendor the kit into eight
 * aspect templates that never carried it (caught on this script's first run).
 */
const IMPORT_SHAPES = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];
function importsKit(source) {
  for (const re of IMPORT_SHAPES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (spec === KIT_PKG || spec.startsWith(`${KIT_PKG}/`)) return true;
    }
  }
  return false;
}
async function templateNeedsKit(templateDir) {
  const checksDir = join(templateDir, 'checks');
  if (!(await exists(checksDir))) return false;
  for (const f of await fs.readdir(checksDir)) {
    if (!f.endsWith('.ts')) continue;
    if (importsKit(await fs.readFile(join(checksDir, f), 'utf8'))) return true;
  }
  return false;
}

async function hasPayloadSymlink(directory) {
  const entry = await fs.lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return false;
  if (entry.isSymbolicLink()) return true;
  if (!entry.isDirectory()) return false;
  for (const child of await fs.readdir(directory)) {
    if (child === 'node_modules' || child.startsWith('.')) continue;
    if (await hasPayloadSymlink(join(directory, child))) return true;
  }
  return false;
}

async function main() {
  if (!(await exists(CANONICAL))) {
    console.error(`canonical kit not found at ${CANONICAL}`);
    process.exit(2);
  }
  // The canonical payload a vendored copy must carry: manifest + tsconfig + runtime src.
  const canonicalFiles = ['package.json', 'tsconfig.json'];
  for (const rel of await filesUnder(join(CANONICAL, 'src'))) {
    if (!isVendorDevOnly(rel)) canonicalFiles.push(`src/${rel}`);
  }

  const drift = [];
  let synced = 0;
  const targets = (await fs.readdir(TEMPLATES, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort().map(ref => ({ directory: join(TEMPLATES, ref), label: `templates/${ref}`, explicit: false }));
  // Resolve and validate every explicit target before any writer runs. Symlinks
  // cannot turn a repo-relative target into a write outside this source tree.
  for (const target of EXTRA_TARGETS) {
    if (!target || isAbsolute(target) || target.includes('\\') || target.split('/').some(part => !part || part === '.' || part === '..')) {
      console.error(`invalid template-kit target: ${target}`);
      process.exit(2);
    }
    const directory = await fs.realpath(resolve(ROOT, target));
    const rel = relative(await fs.realpath(ROOT), directory);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await fs.stat(directory)).isDirectory()) {
      console.error(`template-kit target is outside the source tree: ${target}`);
      process.exit(2);
    }
    const existing = targets.find(row => row.directory === directory);
    if (existing) existing.explicit = true;
    else targets.push({ directory, label: target, explicit: true });
  }
  for (const { directory, label } of targets) {
    if (await hasPayloadSymlink(join(directory, 'template-kit'))) {
      console.error(`template-kit payload contains a symlink: ${label}/template-kit`);
      process.exit(2);
    }
  }
  for (const { directory: templateDir, label, explicit } of targets) {
    const vendored = join(templateDir, 'template-kit');
    const hasVendored = await exists(vendored);
    const needsKit = explicit || await templateNeedsKit(templateDir);
    if (!hasVendored && !needsKit) continue;
    // A vendored copy in a template whose checks do not import the kit is
    // itself drift (dead weight in every materialized app) — remove it whole.
    if (hasVendored && !needsKit) {
      drift.push(`${label}/template-kit exists but no check imports ${KIT_PKG}`);
      if (!CHECK_MODE) {
        await fs.rm(vendored, { recursive: true });
        synced++;
      }
      continue;
    }

    // 1) copy/refresh every canonical file.
    for (const rel of canonicalFiles) {
      const srcPath = join(CANONICAL, rel);
      const dstPath = join(vendored, rel);
      // package.json is DERIVED (dev-harness-only devDependencies dropped), never byte-copied.
      const want =
        rel === 'package.json'
          ? Buffer.from(vendoredManifestOf(await fs.readFile(srcPath, 'utf8')), 'utf8')
          : await fs.readFile(srcPath);
      const have = (await exists(dstPath)) ? await fs.readFile(dstPath) : null;
      if (have === null || !want.equals(have)) {
        drift.push(`${label}/template-kit/${rel} ${have === null ? 'missing' : 'differs'}`);
        if (!CHECK_MODE) {
          await fs.mkdir(dirname(dstPath), { recursive: true });
          await fs.writeFile(dstPath, want);
          synced++;
        }
      }
    }
    // 2) remove vendored files with no canonical counterpart (direction-1 drift).
    if (hasVendored) {
      const keep = new Set(canonicalFiles);
      for (const rel of await filesUnder(vendored)) {
        if (keep.has(rel)) continue;
        drift.push(`${label}/template-kit/${rel} has no canonical counterpart`);
        if (!CHECK_MODE) {
          await fs.rm(join(vendored, rel));
          synced++;
        }
      }
    }
  }

  if (CHECK_MODE) {
    if (drift.length) {
      console.error(`vendored template-kit drift (${drift.length}):\n  ${drift.join('\n  ')}`);
      process.exit(1);
    }
    console.log('vendored template-kit copies are in sync');
    return;
  }
  console.log(drift.length ? `synced ${synced} file(s):\n  ${drift.join('\n  ')}` : 'nothing to sync');
}

await main();
