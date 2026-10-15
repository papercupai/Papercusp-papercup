/**
 * verify-tauri-headless-spa-require-built.test.ts — the recurrence guard for
 * WI-10004972.
 *
 * The bug: scripts/verify-tauri-headless.sh froze the shared SPA dist as soon as
 * it stopped changing. Nothing compared the dist with the source under test, so
 * a quiet dist built BEFORE an edit was frozen silently and the run reported a
 * confident FAIL on a correct fix (WI-10004955, 2026-10-01: fix written 17:44Z,
 * dist rebuilt 17:49Z from pre-fix source, the next build took 26 minutes).
 *
 * The fix: scripts/lib/spa-require-built.sh. With VERIFY_TAURI_REQUIRE_BUILT set
 * to the edited paths, the verifier waits (bounded) until the dist's build stamp
 * (dist/.vite-rebuild-source-stamp, dated to when the build STARTED) is newer
 * than every listed path, or refuses with SPA_STALE_VS_SOURCE and exit 3.
 *
 * These tests run the REAL helper in bash against temp fixtures whose mtimes are
 * set explicitly, so they exercise the actual `find -newer` comparison on this
 * box's find (bfs), not a description of it. The last block is a wiring guard on
 * the verifier itself, which boots a real Xvfb/Tauri stack and so cannot be run
 * end to end in a unit test.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const HELPER = resolve(__dirname, '../../../scripts/lib/spa-require-built.sh');
const REBUILD = resolve(__dirname, '../../../scripts/papercup-vite-rebuild.sh');

const BASE = Math.floor(Date.now() / 1000) - 3600;
const STAMP_AT = BASE + 100;

let root: string;
let repo: string;
let dist: string;
let stamp: string;

function put(rel: string, mtimeSec: number): string {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `// ${rel}\n`);
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function run(fn: string, args: string[], env: Record<string, string> = {}, prelude = '') {
  const r = spawnSync('bash', ['-c', `${prelude}. "${HELPER}" || exit 99; ${fn} "$@"`, 'srb', ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PAPERCUSP_SPA_REQUIRE_BUILT_WAIT_SEC: '0',
      PAPERCUSP_SPA_REQUIRE_BUILT_POLL_SEC: '1',
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const gate = (spec: string, env: Record<string, string> = {}, prelude = '') =>
  run('spa_require_built_gate', [dist, repo, spec], env, prelude);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spa-require-built-'));
  repo = join(root, 'repo');
  dist = join(repo, 'apps/operator-vite/dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html></html>\n');
  stamp = join(dist, '.vite-rebuild-source-stamp');
  writeFileSync(stamp, '');
  utimesSync(stamp, STAMP_AT, STAMP_AT);
  put('apps/operator-vite/src/a.ts', BASE);
  put('apps/operator-vite/src/sub/b.tsx', BASE);
  put('other/c.ts', BASE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('WI-10004972 — spa_require_built_gate', () => {
  it('passes when the build stamp is newer than the required file', () => {
    const r = gate('apps/operator-vite/src/a.ts');
    expect(r.out).toContain('SPA_REQUIRE_BUILT ok');
    expect(r.out).toContain('all 1 required path(s)');
    expect(r.status).toBe(0);
  });

  it('refuses, naming the path and both timestamps, when the file is newer than the stamp', () => {
    put('apps/operator-vite/src/a.ts', BASE + 200);
    const r = gate('apps/operator-vite/src/a.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      `SPA_STALE_VS_SOURCE reason=timeout path=apps/operator-vite/src/a.ts source_mtime=${iso(BASE + 200)} stamp=${iso(STAMP_AT)}`,
    );
    expect(r.out).not.toContain('SPA_REQUIRE_BUILT ok');
  });

  it('scans a directory, but ignores test files and node_modules exactly as the rebuild script does', () => {
    put('apps/operator-vite/src/sub/b.test.ts', BASE + 200);
    put('apps/operator-vite/src/sub/node_modules/x.ts', BASE + 200);
    expect(gate('apps/operator-vite/src/sub').status).toBe(0);

    put('apps/operator-vite/src/sub/deeper/d.tsx', BASE + 300);
    const r = gate('apps/operator-vite/src/sub');
    expect(r.status).toBe(1);
    expect(r.out).toContain('path=apps/operator-vite/src/sub/deeper/d.tsx');
  });

  it('accepts comma- and space-separated specs, ./ prefixes, trailing slashes and absolute in-repo paths', () => {
    const r = gate(`./apps/operator-vite/src/a.ts, apps/operator-vite/src/sub/ ${repo}/other/c.ts`);
    expect(r.status).toBe(0);
    expect(r.out).toContain('all 3 required path(s)');
  });

  it('refuses a missing path instead of treating it as built', () => {
    const r = gate('apps/operator-vite/src/gone.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('SPA_STALE_VS_SOURCE reason=path-missing path=apps/operator-vite/src/gone.ts');
  });

  it('does not glob-expand the spec (a bare * must not silently match every top-level entry)', () => {
    const r = gate('*');
    expect(r.status).toBe(1);
    expect(r.out).toContain('reason=path-missing path=*');
  });

  it('refuses when the stamp is missing: which sources the dist holds cannot be proven', () => {
    rmSync(stamp);
    const r = gate('apps/operator-vite/src/a.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('SPA_STALE_VS_SOURCE reason=stamp-missing');
  });

  it('ignores test files and refuses a spec that names nothing bundled', () => {
    put('apps/operator-vite/src/a.test.ts', BASE);
    const r = gate('apps/operator-vite/src/a.test.ts');
    expect(r.out).toContain('ignores apps/operator-vite/src/a.test.ts');
    expect(r.out).toContain('SPA_STALE_VS_SOURCE reason=no-paths');
    expect(r.status).toBe(1);
  });

  it('warns about a path outside the rebuild roots but still checks it', () => {
    const ok = gate('other/c.ts');
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('other/c.ts is outside the SPA rebuild roots');

    put('other/c.ts', BASE + 200);
    expect(gate('other/c.ts').status).toBe(1);
  });

  it('recognizes imported operator library source and still refuses an unbuilt theme edit', () => {
    put('apps/operator/lib/theme.ts', BASE);
    const built = gate('apps/operator/lib/theme.ts');
    expect(built.status).toBe(0);
    expect(built.out).not.toContain('outside the SPA rebuild roots');

    put('apps/operator/lib/theme.ts', BASE + 200);
    const stale = gate('apps/operator/lib/theme.ts');
    expect(stale.status).toBe(1);
    expect(stale.out).toContain('reason=timeout path=apps/operator/lib/theme.ts');
    expect(stale.out).not.toContain('outside the SPA rebuild roots');
  });

  it('waits for a rebuild and passes once the stamp moves past the edit', () => {
    put('apps/operator-vite/src/a.ts', BASE + 200);
    const r = gate(
      'apps/operator-vite/src/a.ts',
      { PAPERCUSP_SPA_REQUIRE_BUILT_WAIT_SEC: '30' },
      `( sleep 2; touch "${stamp}" ) & `,
    );
    expect(r.out).toContain('SPA_REQUIRE_BUILT ok');
    expect(r.out).toMatch(/waited [1-9]\d*s/);
    expect(r.status).toBe(0);
  });
});

// WI-10006797: the rebuild script's stamp is dated to when it DECIDED to build,
// which can precede the build reading source by a long lock wait (38 min on
// 2026-10-06). vite-build-singleflight writes .vite-build-source-read-at, dated
// after that wait; the gate must use whichever stamp is newer.
describe('WI-10006797 — the newer of the two build stamps wins', () => {
  const sfStamp = () => join(dist, '.vite-build-source-read-at');
  const putSf = (mtimeSec: number) => {
    writeFileSync(sfStamp(), '');
    utimesSync(sfStamp(), mtimeSec, mtimeSec);
  };

  it('passes on the singleflight stamp when the edit landed between the rebuild decision and the source read', () => {
    put('apps/operator-vite/src/a.ts', BASE + 200);
    putSf(BASE + 300);
    const r = gate('apps/operator-vite/src/a.ts');
    expect(r.out).toContain(`SPA_REQUIRE_BUILT ok: build stamp ${iso(BASE + 300)}`);
    expect(r.status).toBe(0);
  });

  it('still refuses when the edit is newer than BOTH stamps', () => {
    put('apps/operator-vite/src/a.ts', BASE + 400);
    putSf(BASE + 300);
    const r = gate('apps/operator-vite/src/a.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain(`source_mtime=${iso(BASE + 400)} stamp=${iso(BASE + 300)}`);
  });

  it('keeps the rebuild stamp when the singleflight stamp is the OLDER one', () => {
    put('apps/operator-vite/src/a.ts', BASE + 75);
    putSf(BASE + 50);
    const r = gate('apps/operator-vite/src/a.ts');
    expect(r.out).toContain(`build stamp ${iso(STAMP_AT)}`);
    expect(r.status).toBe(0);
  });

  it('accepts a dist that carries only the singleflight stamp', () => {
    rmSync(stamp);
    putSf(STAMP_AT);
    expect(gate('apps/operator-vite/src/a.ts').status).toBe(0);
  });

  it('re-resolves the stamp while waiting, so a singleflight stamp that appears mid-wait ends the wait', () => {
    put('apps/operator-vite/src/a.ts', BASE + 200);
    const r = gate(
      'apps/operator-vite/src/a.ts',
      { PAPERCUSP_SPA_REQUIRE_BUILT_WAIT_SEC: '30' },
      `( sleep 2; touch "${sfStamp()}" ) & `,
    );
    expect(r.out).toContain('SPA_REQUIRE_BUILT ok');
    expect(r.out).toMatch(/waited [1-9]\d*s/);
    expect(r.status).toBe(0);
  });

  it('the per-run note reports the newer stamp too', () => {
    put('apps/operator-vite/src/a.ts', BASE + 200);
    putSf(BASE + 300);
    const r = run('spa_require_built_note', [dist, repo]);
    expect(r.out).toContain(`SPA build stamp: ${iso(BASE + 300)}`);
    expect(r.out).toContain('0 frontend source file(s) are newer');
  });
});

describe('WI-10004972 — spa_require_built_newer fails closed', () => {
  it('returns 2 (unknown) rather than "nothing newer" when the stamp is gone', () => {
    rmSync(stamp);
    const r = run('spa_require_built_newer', [stamp, join(repo, 'apps/operator-vite/src/a.ts')]);
    expect(r.status).toBe(2);
    expect(r.out.trim()).toBe('');
  });
});

describe('WI-10004972 — spa_require_built_note (the hint every run gets)', () => {
  it('counts in-root frontend sources newer than the stamp, excluding tests and out-of-root files', () => {
    put('apps/operator-vite/src/a.ts', BASE + 200);
    put('packages/operator-core/lib/e.ts', BASE + 200);
    put('apps/operator-vite/src/a.test.ts', BASE + 200);
    put('other/c.ts', BASE + 200);
    const r = run('spa_require_built_note', [dist, repo]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`SPA build stamp: ${iso(STAMP_AT)}`);
    expect(r.out).toContain('2 frontend source file(s) are newer and NOT in this bundle');
    expect(r.out).toContain('VERIFY_TAURI_REQUIRE_BUILT');
  });

  it('says so when there is no stamp, and never fails the run', () => {
    rmSync(stamp);
    const r = run('spa_require_built_note', [dist, repo]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('SPA build stamp: none');
  });

  it('counts unbuilt library source while pruning library test and dist files', () => {
    put('apps/operator/lib/theme.ts', BASE + 200);
    put('apps/operator/lib/theme.test.ts', BASE + 200);
    put('apps/operator/lib/dist/theme.ts', BASE + 200);
    const r = run('spa_require_built_note', [dist, repo]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('1 frontend source file(s) are newer and NOT in this bundle');
  });
});

describe('EI-25443239493326581 — maintained SPA rebuild trigger', () => {
  function rebuild(buildExit = 0) {
    const script = join(repo, 'scripts/papercup-vite-rebuild.sh');
    mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
    writeFileSync(script, readFileSync(REBUILD));
    writeFileSync(join(repo, 'scripts/lib/spa-require-built.sh'), readFileSync(HELPER));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'npm'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '[[ "${PAPERCUSP_RETAIN_DIST_CHUNKS:-}" == 1 ]]',
      'printf "%s\\n" "$*" >> "$SPA_FIXTURE_CALLS"',
      '[[ "$SPA_FIXTURE_BUILD_EXIT" == 0 ]] || exit "$SPA_FIXTURE_BUILD_EXIT"',
      'touch "$PWD/dist/.vite-build-source-read-at"',
    ].join('\n') + '\n', { mode: 0o755 });
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SPA_FIXTURE_CALLS: join(root, 'npm-calls'),
        SPA_FIXTURE_BUILD_EXIT: String(buildExit),
      },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  const calls = () => existsSync(join(root, 'npm-calls'))
    ? readFileSync(join(root, 'npm-calls'), 'utf8')
    : '';

  it('builds for a theme-only library edit, retains chunks and skips the next unchanged tick', () => {
    put('apps/operator/lib/theme.ts', BASE + 200);
    const first = rebuild();
    expect(first.status).toBe(0);
    expect(first.out).toContain('change detected (apps/operator/lib/theme.ts)');
    expect(first.out).toContain('build done (chunk-retain on)');
    expect(calls()).toBe('run build\n');
    expect(gate('apps/operator/lib/theme.ts').status).toBe(0);

    const second = rebuild();
    expect(second.status).toBe(0);
    expect(second.out).toContain('no frontend source changes since last build');
    expect(calls()).toBe('run build\n');
  });

  it('ignores newer library tests, specs, dependencies, dist files and out-of-root edits', () => {
    put('apps/operator/lib/theme.ts', BASE);
    for (const rel of ['theme.test.ts', 'theme.spec.ts', 'node_modules/a.ts', 'dist/a.ts']) {
      put(`apps/operator/lib/${rel}`, BASE + 200);
    }
    put('other/c.ts', BASE + 200);
    const r = rebuild();
    expect(r.status).toBe(0);
    expect(r.out).toContain('no frontend source changes since last build');
    expect(calls()).toBe('');
  });

  it('does not rebuild for library source already older than the build stamp', () => {
    put('apps/operator/lib/theme.ts', BASE);
    expect(rebuild().status).toBe(0);
    expect(calls()).toBe('');
  });

  it('leaves an edited theme unbuilt when the build fails', () => {
    put('apps/operator/lib/theme.ts', BASE + 200);
    const r = rebuild(7);
    expect(r.status).toBe(7);
    expect(r.out).not.toContain('build done');
    expect(gate('apps/operator/lib/theme.ts').status).toBe(1);
  });

  it('refuses a fixture without source roots instead of silently skipping', () => {
    rmSync(join(repo, 'apps/operator-vite/src'), { recursive: true });
    const r = rebuild();
    expect(r.status).toBe(1);
    expect(r.out).toContain('SPA source roots are missing');
    expect(calls()).toBe('');
  });
});

describe('WI-10004972 — verify-tauri-headless.sh wiring', () => {
  const src = readFileSync(SCRIPT, 'utf8');

  it('ships the helper it sources', () => {
    expect(existsSync(HELPER)).toBe(true);
  });

  it('runs the gate and the note inside the freeze branch, BEFORE quiescence and the copy', () => {
    const branch = src.indexOf('if [ -f "$SHARED_SPA_DIST/index.html" ]; then');
    const source = src.indexOf('. "$REPO_DIR/scripts/lib/spa-require-built.sh"');
    const gateCall = src.indexOf('spa_require_built_gate "$SHARED_SPA_DIST" "$REPO_DIR" "$VERIFY_TAURI_REQUIRE_BUILT"');
    const note = src.indexOf('spa_require_built_note "$SHARED_SPA_DIST" "$REPO_DIR"');
    const quiesce = src.indexOf('QUIESCE_STABLE_SEC="${PAPERCUSP_SPA_QUIESCE_STABLE_SEC');
    const copy = src.indexOf('cp -a "$SHARED_SPA_DIST/."');
    for (const i of [branch, source, gateCall, note, quiesce, copy]) expect(i).toBeGreaterThan(-1);
    expect(source).toBeLessThan(src.indexOf('WORK="$(mktemp -d'));
    expect(source).toBeLessThan(branch);
    expect(source).toBeLessThan(gateCall);
    expect(gateCall).toBeLessThan(note);
    expect(note).toBeLessThan(quiesce);
    expect(quiesce).toBeLessThan(copy);
  });

  it('is opt-in and refuses with exit 3, the "cannot exercise your change" code', () => {
    expect(src).toMatch(
      /if \[ -n "\$\{VERIFY_TAURI_REQUIRE_BUILT:-\}" \] \\\n\s+&& ! spa_require_built_gate [^\n]+; then\n\s+exit 3\n/,
    );
  });

  it('refuses when the caller requires a build but there is no dist at all', () => {
    expect(src).toMatch(/reason=no-dist[^\n]*\n\s+exit 3\n/);
    // Teardown still needs this directory to write its owned stop scripts and
    // preserve the failure logs. It removes the bulk SPA snapshot itself.
    expect(src).not.toMatch(/^\s*rm -rf "\$WORK"\s*$/m);
  });
});
