/**
 * EI-20093985382484201 — the READ side of the stale-bundle marker.
 *
 * The property that matters is asymmetric: reporting a healthy process as
 * stale is noise, but reporting a STALE process as healthy is the exact
 * failure this whole change exists to prevent (an agent verifies a fix against
 * pre-fix code and concludes it works). So the corrupt-marker case below
 * deliberately asserts staleness rather than a clean `null`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetBundleStalenessCacheForTests,
  getBundleStaleness,
} from './bundle-staleness';

let dir: string;
let marker: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bundle-stale-'));
  marker = join(dir, '.bundle-stale.json');
  process.env.PAPERCUSP_BUNDLE_STALE_MARKER = marker;
  __resetBundleStalenessCacheForTests();
});

afterEach(() => {
  delete process.env.PAPERCUSP_BUNDLE_STALE_MARKER;
  __resetBundleStalenessCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('getBundleStaleness', () => {
  it('reports healthy when no marker exists — the overwhelmingly common case', () => {
    expect(getBundleStaleness()).toBeNull();
  });

  it('surfaces the failing files and the serving bundle age when the marker is present', () => {
    writeFileSync(
      marker,
      JSON.stringify({
        schema: 'bundle-stale-v1',
        failedAt: '2026-08-10T18:58:47.000Z',
        entry: 'bin/hono-host.ts',
        outfile: '/x/dist-host/hono-host.mjs',
        servingBundleMtime: '2026-08-10T17:00:00.000Z',
        servingBundleAgeSecAtFailure: 6527,
        failingFiles: ['../../packages/operator-core/lib/agent-tools/templates/new-app.ts:333:688'],
        error: '✘ [ERROR] Expected "}" but found "s"',
      }),
    );

    const stale = getBundleStaleness();
    expect(stale).not.toBeNull();
    // The single most useful field: WHICH FILE to go fix, without reconstructing
    // it from the journal.
    expect(stale?.failingFiles).toEqual([
      '../../packages/operator-core/lib/agent-tools/templates/new-app.ts:333:688',
    ]);
    expect(stale?.servingBundleAgeSecAtFailure).toBe(6527);
    expect(stale?.entry).toBe('bin/hono-host.ts');
  });

  it('reports STALE — never healthy — when the marker is corrupt', () => {
    writeFileSync(marker, '{ this is not json');
    const stale = getBundleStaleness();
    // A parse failure means we cannot prove the process is serving current
    // code, and "cannot prove healthy" must not render as `null`.
    expect(stale).not.toBeNull();
    expect(stale?.error).toMatch(/STALE/i);
  });

  it('reports STALE when the marker parses but omits the fields we need', () => {
    // A marker written by a future or older writer must not silently degrade to
    // "healthy". The verdict rests on the file EXISTING — bundle-host.sh writes
    // it only on the fallback path and deletes it on every success — so an
    // unrecognised shape still means this process booted on an older bundle.
    writeFileSync(marker, JSON.stringify({ schema: 'bundle-stale-v1' }));
    const stale = getBundleStaleness();
    expect(stale).not.toBeNull();
    expect(stale?.error).toMatch(/STALE/i);
  });

  it('reports STALE when the marker is valid JSON but not an object', () => {
    writeFileSync(marker, '"just a string"');
    expect(getBundleStaleness()).not.toBeNull();
  });

  it('caches — the marker cannot change under a running process', () => {
    // ExecStartPre runs to completion BEFORE the process is exec'd, so clearing
    // the marker requires a rebuild, which requires a restart, which is a
    // different process. Caching is what keeps /api/health zero-dependency.
    expect(getBundleStaleness()).toBeNull();
    writeFileSync(marker, JSON.stringify({ schema: 'x', outfile: '/late/arrival.mjs' }));
    expect(getBundleStaleness()).toBeNull();
  });
});

describe('bundle-stale diagnostic attribution (WI-6554700010017040)', () => {
  function writeMarker(log: string) {
    const buildLog = join(dir, 'build.log');
    const outfile = join(dir, 'host.mjs');
    writeFileSync(buildLog, log);
    writeFileSync(outfile, 'export {};\n');
    execFileSync(process.execPath, [
      resolve(__dirname, '../../../apps/operator/bin/write-bundle-stale-marker.mjs'),
      marker, 'host.ts', outfile, buildLog,
    ], { timeout: 10_000 });
    return getBundleStaleness();
  }

  it('names the refusing free-reference guard sites instead of preceding compiler warnings', () => {
    const stale = writeMarker([
      '▲ [WARNING] Import will always be undefined [import-is-undefined]',
      '    apps/operator/bin/host-spa.ts:42:25:',
      '▲ [WARNING] Import will always be undefined [import-is-undefined]',
      '    apps/operator/bin/host-spa.ts:45:27:',
      '🚨 free reference `papercuspPath` at packages/operator-core/lib/fleet-logs-gc.ts:240:12 — no binding in scope and not a host global; the bundle would throw ReferenceError when this runs',
      '🚨 free reference `papercuspPath` at packages/operator-core/lib/fleet-logs-gc.ts:1272:54 — no binding in scope and not a host global; the bundle would throw ReferenceError when this runs',
      '🚨 free reference `papercuspPath` at packages/operator-core/lib/fleet-logs-gc.ts:240:12 — no binding in scope and not a host global; the bundle would throw ReferenceError when this runs',
      'BUNDLE_FREE_REFS_RESULT status=refused findings=3',
    ].join('\n'));
    expect(stale?.failingFiles).toEqual([
      'packages/operator-core/lib/fleet-logs-gc.ts:240:12',
      'packages/operator-core/lib/fleet-logs-gc.ts:1272:54',
    ]);
    expect(stale?.error).toContain('BUNDLE_FREE_REFS_RESULT status=refused');
  });

  it('keeps primary esbuild error sites and excludes warning and related-note locations', () => {
    const stale = writeMarker([
      '✘ [ERROR] Expected "}" but found "s"',
      '    packages/operator-core/lib/broken.ts:12:7:',
      '    packages/operator-core/lib/related.ts:4:2:',
      '▲ [WARNING] Unused import',
      '    packages/operator-core/lib/warning.ts:8:3:',
      '✘ [ERROR] Another parse error',
      '    packages/operator-core/lib/other.ts:20:9',
    ].join('\n'));
    expect(stale?.failingFiles).toEqual([
      'packages/operator-core/lib/broken.ts:12:7',
      'packages/operator-core/lib/other.ts:20:9',
    ]);
  });

  it('does not attribute an unlocated failure to warning-only locations', () => {
    const stale = writeMarker([
      '▲ [WARNING] Unused import',
      '    packages/operator-core/lib/warning.ts:8:3:',
      'build step failed without a source location',
    ].join('\n'));
    expect(stale?.failingFiles).toEqual([]);
    expect(stale?.error).toContain('build step failed without a source location');
  });
});
