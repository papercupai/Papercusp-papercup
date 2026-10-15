/**
 * WI-10006650 — fixture-driven Playwright specs must be SELECTED when a file they render changes.
 *
 * The incident: kasmvnc-rfb.ts (2026-09-23) began refusing an RFB class without `_sendMouse`.
 * apps/operator/e2e/desktop-render-matrix.spec.ts renders HostedDesktopViewer through that
 * module (via `__fixtures__/desktop-render-matrix.tsx`) and went red, but nothing ran it for
 * 13 days. Playwright owns the spec, so unit related-selection drops it, and the fixture
 * entry is a STRING LITERAL passed to Vite, so the spec's import graph never reaches the
 * component. These tests pin both halves of the fix: the closure walker (literal roots +
 * `@/` alias edges) and the affected-tests guard wiring that runs the selected specs.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverFixtureSpecs,
  fixtureSpecClosures,
  selectFixtureSpecs,
} from '../../../../scripts/lib/e2e-fixture-specs.mjs';
import { staticImportClosure } from '../../../../scripts/lib/related-tests.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const KASMVNC = 'apps/operator/app/cloud-workspaces/kasmvnc-rfb.ts';
const MATRIX = 'apps/operator/e2e/desktop-render-matrix.spec.ts';

describe('staticImportClosure alias edges', () => {
  const files: Record<string, string> = {
    '/r/app/entry.ts': "import { b } from '@/lib/b';\nimport x from './x';",
    '/r/app/x.ts': 'export default 1;',
    '/r/app/lib/b.ts': "export const b = 2; import '@unknown/thing';",
  };
  const fs = {
    read: (f: string) => files[f] ?? null,
    exists: (f: string) => f in files,
    list: () => Object.keys(files),
  };

  it('follows a configured alias prefix to the aliased file', () => {
    const r = staticImportClosure({
      rootDir: '/r',
      entryFiles: ['/r/app/entry.ts'],
      aliases: [{ prefix: '@/', target: '/r/app/', wildcard: true }],
      fs,
    });
    expect(r.files).toContain('/r/app/lib/b.ts');
    expect(r.files).toContain('/r/app/x.ts');
  });

  it('keeps an alias with no matching prefix UNRESOLVED (fail-closed, ok:false)', () => {
    const r = staticImportClosure({ rootDir: '/r', entryFiles: ['/r/app/entry.ts'], fs });
    expect(r.ok).toBe(false);
    expect(r.unresolved).toContain('/r/app/entry.ts:@/lib/b');
    expect(r.files).not.toContain('/r/app/lib/b.ts');
  });
});

describe('fixture spec discovery and selection (real tree)', () => {
  const closures = fixtureSpecClosures({ rootDir: REPO_ROOT });

  it('discovers the desktop-render-matrix spec with its fixture entry AND its Vite-alias stand-in', () => {
    const matrix = discoverFixtureSpecs({ rootDir: REPO_ROOT }).find((s) => s.spec === MATRIX);
    expect(matrix?.fixtures).toEqual(
      expect.arrayContaining([
        'apps/operator/e2e/__fixtures__/desktop-render-matrix.tsx',
        'apps/operator/e2e/__fixtures__/desktop-render-rfb.ts',
      ]),
    );
  });

  it('resolves every `@/` edge in each fixture closure (a partial closure would under-select)', () => {
    for (const c of closures) expect({ spec: c.spec, unresolved: c.unresolved }).toEqual({ spec: c.spec, unresolved: [] });
  });

  it('REGRESSION: a kasmvnc-rfb.ts change selects desktop-render-matrix.spec.ts', () => {
    const { selected, reasons } = selectFixtureSpecs({ closures, changedPaths: [KASMVNC] });
    expect(selected).toContain(MATRIX);
    expect(reasons[MATRIX]).toEqual([KASMVNC]);
  });

  it('a change to the RFB stand-in fixture selects the spec that aliases it', () => {
    expect(selectFixtureSpecs({ closures, changedPaths: ['apps/operator/e2e/__fixtures__/desktop-render-rfb.ts'] }).selected)
      .toContain(MATRIX);
  });

  it('selects nothing for a path outside every fixture closure', () => {
    expect(selectFixtureSpecs({ closures, changedPaths: ['packages/operator-core/lib/coord/gate-ownership.ts'] }).selected)
      .toEqual([]);
  });
});

describe('affected-tests wiring', () => {
  it('declares the guard script on the host workspace, so attachment cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps/operator/package.json'), 'utf8'));
    expect(pkg.name).toBe('@papercusp/web');
    expect(pkg.scripts['test:e2e:fixture-affected']).toBe('node ../../scripts/e2e-fixture-affected.mjs');
  });

  it('the runner selects from forwarded paths without launching a browser under --print', () => {
    const res = spawnSync(process.execPath, ['scripts/e2e-fixture-affected.mjs', '--print', `--files=${KASMVNC}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/E2E_FIXTURE_SELECTION selected=[1-9]\d* /);
    expect(res.stdout).toContain(MATRIX);
  });
});
