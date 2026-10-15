/**
 * Doc-claim pin: the VENDORED gitnexus 1.6.9 carries the papercusp embedding-upsert backport
 * (vendor-patches/gitnexus-vendor+1.6.9-embedding-upsert.patch, applied by
 * scripts/vendor-gitnexus-patch.mjs).
 *
 * WHY. The hourly `gitnexus-reindex` tick spawns `analyze --force --embeddings 0`
 * (gitnexus-reindex-action.ts, D-002 of plan gitnexus-embeddings-enablement-2026-09-05). On an
 * index that already carries embeddings, stock 1.6.9 restores them from its cache and then
 * aborts the whole analyze on the FIRST changed node with "Found duplicated primary key value"
 * (measured 2026-09-05, /tmp/wi39394/run3-embed-run.log) — so every post-bootstrap tick would
 * fail and the vector leg would freeze at bootstrap time while every count read healthy. The
 * backport makes batchInsertEmbeddings DELETE by embedding id before CREATE (gitnexus 1.6.11's
 * own fix). The vendor dir lives outside the repo, so nothing else notices a re-provision
 * dropping it — this test does, on the box that runs the routine.
 *
 * Skips (never fails) where the vendored install is absent: the claim is about THIS box's
 * install, not about the repo.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCliPath } from '../harness/routines/gitnexus-reindex-action';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PATCH_FILE = join(REPO_ROOT, 'vendor-patches/gitnexus-vendor+1.6.9-embedding-upsert.patch');
const APPLY_SCRIPT = join(REPO_ROOT, 'scripts/vendor-gitnexus-patch.mjs');
const MARKER = 'papercusp-patch:gitnexus-1.6.9-embedding-upsert';

/** The same install the routine spawns: analyzeCliPath() is <pkg>/dist/cli/index.js. */
function vendoredPackageRoot(): string {
  return resolve(dirname(analyzeCliPath()), '../..');
}

describe('gitnexus vendor embedding-upsert patch (WI-39394)', () => {
  it('the repo carries the patch and the apply script, and both name the same marker', () => {
    expect(existsSync(PATCH_FILE)).toBe(true);
    expect(existsSync(APPLY_SCRIPT)).toBe(true);
    const patch = readFileSync(PATCH_FILE, 'utf8');
    expect(patch).toContain(MARKER);
    // The patch is the DELETE-by-id-before-CREATE upsert, nothing else.
    expect(patch).toContain('MATCH (e:${EMBEDDING_TABLE_NAME} {id: $id}) DELETE e');
    expect(readFileSync(APPLY_SCRIPT, 'utf8')).toContain(MARKER);
  });

  it('the vendored 1.6.9 the routine spawns carries the marker (skips when no vendor install)', () => {
    const root = vendoredPackageRoot();
    const pkgJson = join(root, 'package.json');
    if (!existsSync(pkgJson)) {
      // Not this box's concern — the routine cannot run here either.
      return;
    }
    const version = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string }).version;
    const target = join(root, 'dist/core/embeddings/embedding-pipeline.js');
    expect(existsSync(target)).toBe(true);
    const src = readFileSync(target, 'utf8');
    if (version === '1.6.9') {
      // Drift signal: a re-provision dropped the patch. Repair: node scripts/vendor-gitnexus-patch.mjs
      expect(src, `vendored gitnexus 1.6.9 at ${root} lacks ${MARKER}; run: node scripts/vendor-gitnexus-patch.mjs`).toContain(MARKER);
    } else {
      // A newer pin must carry the upstream fix itself (1.6.11+ ships the same DELETE-then-CREATE).
      expect(src, `vendored gitnexus ${version} batchInsertEmbeddings must delete by id before CREATE`).toContain(
        'DELETE e`, paramsList.map(({ id }) => ({ id }))',
      );
    }
  });
});
