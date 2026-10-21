/**
 * WI-10004321: a setup-*-runtime.sh run must change ONLY the tree that ran it.
 *
 * Release trees used to receive the gitignored runtime assets under
 * apps/operator/public as HARD LINKS of the integration tree's files
 * (setup-release-checkout.sh step 3b, `cp -al`). These postinstall scripts then
 * rewrote them with plain `cp` / `cp -f`, which opens an existing destination with
 * O_TRUNC and rewrites the SAME inode. So a canonical `npm install` silently
 * rewrote the published and in-flight release trees' assets, and a release tree's
 * own postinstall rewrote canonical's. Measured 2026-09-30: silero_vad_v5.onnx was
 * one inode with 11 links across canonical and relcut-0024/0025/0026, and a
 * canonical rewrite at 16:42:55Z changed its mtime in all of them.
 *
 * Step 3b now makes real copies. These tests pin the other half: every write these
 * scripts make gives the destination a fresh inode, so even a still-linked tree is
 * left untouched. Each test pre-seeds a destination as a hard link of a "sibling
 * release tree" file, runs the REAL script in a hermetic fixture, and asserts the
 * sibling's bytes and inode survived.
 *
 * The first test is a permanent calibration: it runs the OLD in-place write on the
 * same fixture shape and shows the sibling DOES change, so a green run cannot come
 * from a fixture in which nothing was ever actually shared.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = resolve(__dirname, '..');
const OLD = 'old bytes, owned by the sibling release tree\n';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  app: string;
  sibling: string;
}

function put(file: string, body = `${file}\n`): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/**
 * The fixture app lives at <root>/x/app. The vad script probes
 * `$(pwd)/../../node_modules` FIRST, which from there is <root>/node_modules, so
 * every candidate path resolves inside the fixture wherever tmpdir() points.
 */
function fixture(script: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-runtime-hardlink-'));
  roots.push(root);
  const app = join(root, 'x', 'app');
  mkdirSync(join(app, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(SCRIPTS, script), join(app, 'scripts', script));
  copyFileSync(join(SCRIPTS, 'lib', 'mirror-tree.sh'), join(app, 'scripts', 'lib', 'mirror-tree.sh'));
  return { root, app, sibling: join(root, 'sibling-release-tree') };
}

/**
 * Seed app/<rel> as a hard link of the sibling tree's copy: the shape step 3b's
 * `cp -al` created. Returns the sibling path and its inode.
 */
function linkFromSibling(f: Fixture, rel: string): { shared: string; ino: number } {
  const shared = join(f.sibling, rel);
  put(shared, OLD);
  mkdirSync(dirname(join(f.app, rel)), { recursive: true });
  linkSync(shared, join(f.app, rel));
  expect(statSync(shared).nlink, `fixture did not share ${rel}`).toBe(2);
  return { shared, ino: statSync(shared).ino };
}

function run(f: Fixture, script: string): void {
  // Model BSD cp: macOS rejects GNU's --remove-destination option. The real
  // script must both preserve the linked sibling and work with this cp.
  const bin = join(f.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const cp = join(bin, 'cp');
  writeFileSync(cp, '#!/bin/sh\nfor arg in "$@"; do\n  [ "$arg" = "--remove-destination" ] && exit 64\ndone\nexec /bin/cp "$@"\n', { mode: 0o755 });
  // Model BSD sed's bare -i behavior: `-e` is consumed as the backup suffix,
  // leaving the following expression to be opened as a file. -i.bak is portable.
  const sed = join(bin, 'sed');
  writeFileSync(sed, '#!/bin/sh\nfor arg in "$@"; do\n  [ "$arg" = "-i" ] && { echo "sed: -e: No such file or directory" >&2; exit 64; }\ndone\nexec /bin/sed "$@"\n', { mode: 0o755 });
  const r = spawnSync('bash', [join(f.app, 'scripts', script)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  expect(r.status, `${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0);
}

function runWithFailedMirrorCopy(f: Fixture, script: string, destinationName: string): ReturnType<typeof spawnSync> {
  const bin = join(f.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const cp = join(bin, 'cp');
  writeFileSync(
    cp,
    // mirror_copy_unlinked stages at the package root (`.mirror-tree.tmp.*`), so the
    // copy's DESTINATION never names the asset — fail on its SOURCE (penultimate arg).
    `#!/bin/sh\nprev=\nlast=\nfor arg do prev="$last"; last="$arg"; done\ncase "$prev" in *${destinationName}) exit 42;; esac\nexec /bin/cp "$@"\n`,
    { mode: 0o755 },
  );
  return spawnSync('bash', [join(f.app, 'scripts', script)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
}

/** The sibling kept its bytes and inode; the app got the new bytes on its own inode. */
function expectIsolated(f: Fixture, rel: string, seeded: { shared: string; ino: number }, fresh: string): void {
  expect(readFileSync(seeded.shared, 'utf8'), `${rel}: the run rewrote the sibling tree's file`).toBe(OLD);
  expect(statSync(seeded.shared).ino).toBe(seeded.ino);
  expect(statSync(seeded.shared).nlink).toBe(1);
  const own = join(f.app, rel);
  expect(readFileSync(own, 'utf8')).toBe(fresh);
  expect(statSync(own).ino).not.toBe(seeded.ino);
}

/** Every file under app/public has exactly one link: nothing is shared any more. */
function expectNoSharedInodes(dir: string): void {
  const shared: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (statSync(full).nlink > 1) shared.push(full);
    }
  };
  walk(dir);
  expect(shared).toEqual([]);
}

describe('setup-*-runtime.sh never writes through a hard-linked destination (WI-10004321)', () => {
  it('calibration: the old in-place `cp -f` DOES rewrite the linked sibling', () => {
    const f = fixture('setup-vad-runtime.sh');
    const rel = 'public/silero_vad_v5.onnx';
    const seeded = linkFromSibling(f, rel);
    const src = join(f.root, 'new.onnx');
    put(src, 'new\n');
    const r = spawnSync('bash', ['-c', 'cp -f "$1" "$2"', '_', src, join(f.app, rel)], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(seeded.shared, 'utf8')).toBe('new\n');
  });

  it('setup-vad-runtime.sh: models, worklet and both ORT copies', () => {
    const f = fixture('setup-vad-runtime.sh');
    const vad = join(f.app, 'node_modules/@ricky0123/vad-web/dist');
    for (const name of ['silero_vad_v5.onnx', 'silero_vad_legacy.onnx', 'vad.worklet.bundle.min.js']) {
      put(join(vad, name), `new ${name}\n`);
    }
    const ort = join(f.root, 'node_modules/onnxruntime-web/dist');
    put(join(ort, 'ort-wasm-simd-threaded.wasm'), 'new wasm\n');
    put(join(ort, 'ort-wasm-simd-threaded.jsep.mjs'), 'new jsep\n');

    const cases: Array<[string, string]> = [
      ['public/silero_vad_v5.onnx', 'new silero_vad_v5.onnx\n'],
      ['public/vad.worklet.bundle.min.js', 'new vad.worklet.bundle.min.js\n'],
      ['public/ort-wasm-simd-threaded.wasm', 'new wasm\n'],
      ['public/vad-runtime/ort-wasm-simd-threaded.wasm', 'new wasm\n'],
      ['public/vad-runtime/ort-wasm-simd-threaded.jsep.mjs', 'new jsep\n'],
    ];
    const seeded = cases.map(([rel]) => linkFromSibling(f, rel));
    run(f, 'setup-vad-runtime.sh');
    cases.forEach(([rel, fresh], i) => expectIsolated(f, rel, seeded[i], fresh));
    expectNoSharedInodes(join(f.app, 'public'));
  });

  it('setup-wake-runtime.sh: wasm, bundle and threaded loaders', () => {
    const f = fixture('setup-wake-runtime.sh');
    const ort = join(f.app, 'node_modules/onnxruntime-web/dist');
    put(join(ort, 'ort-wasm-simd-threaded.wasm'), 'new wasm\n');
    put(join(ort, 'ort.bundle.min.mjs'), 'new bundle\n');
    put(join(ort, 'ort-wasm-simd-threaded.jsep.mjs'), 'new jsep\n');

    const cases: Array<[string, string]> = [
      ['public/wake-runtime/ort-wasm-simd-threaded.wasm', 'new wasm\n'],
      ['public/wake-runtime/ort.bundle.min.mjs', 'new bundle\n'],
      ['public/wake-runtime/ort-wasm-simd-threaded.jsep.mjs', 'new jsep\n'],
    ];
    const seeded = cases.map(([rel]) => linkFromSibling(f, rel));
    run(f, 'setup-wake-runtime.sh');
    cases.forEach(([rel, fresh], i) => expectIsolated(f, rel, seeded[i], fresh));
    expectNoSharedInodes(join(f.app, 'public'));
  });

  it('setup-wake-runtime.sh leaves the current asset intact when a replacement copy fails', () => {
    const f = fixture('setup-wake-runtime.sh');
    const rel = 'public/wake-runtime/ort-wasm-simd-threaded.wasm';
    const destination = join(f.app, rel);
    put(destination, OLD);
    const ort = join(f.root, 'node_modules/onnxruntime-web/dist');
    put(join(ort, 'ort-wasm-simd-threaded.wasm'), 'new wasm\n');

    const result = runWithFailedMirrorCopy(f, 'setup-wake-runtime.sh', 'ort-wasm-simd-threaded.wasm');
    expect(result.status).not.toBe(0);
    expect(readFileSync(destination, 'utf8')).toBe(OLD);
    expect(readdirSync(dirname(destination)).filter((name) => name.includes('.tmp.'))).toEqual([]);
    expect(readdirSync(f.app).filter((name) => name.startsWith('.mirror-tree.tmp.'))).toEqual([]);
  });

  it('setup-monaco-runtime.sh: the version stamp outside the re-copied mirror', () => {
    const f = fixture('setup-monaco-runtime.sh');
    put(join(f.app, 'node_modules/monaco-editor/package.json'), JSON.stringify({ version: '9.9.9' }));
    for (const rel of ['loader.js', 'editor/editor.main.css']) put(join(f.app, 'node_modules/monaco-editor/min/vs', rel));
    const seeded = linkFromSibling(f, 'public/monaco/.version');
    run(f, 'setup-monaco-runtime.sh');
    expectIsolated(f, 'public/monaco/.version', seeded, '9.9.9\n');
    expectNoSharedInodes(join(f.app, 'public'));
  });

  it('setup-vditor-runtime.sh: the version stamp outside the re-copied mirror', () => {
    const f = fixture('setup-vditor-runtime.sh');
    const nm = join(f.app, 'node_modules');
    put(join(nm, 'vditor/package.json'), JSON.stringify({ version: '3.11.2' }));
    put(join(nm, 'vditor/dist/js/lute/lute.min.js'));
    put(join(nm, 'vditor/dist/js/markmap/markmap.min.js'), 'load("https://cdn.jsdelivr.net/npm/d3@6.7.0");\n');
    put(join(nm, 'd3/package.json'), JSON.stringify({ version: '6.7.0' }));
    put(join(nm, 'd3/dist/d3.min.js'));
    put(join(nm, 'markmap-view/package.json'), JSON.stringify({ version: '0.14.3' }));
    put(join(nm, 'markmap-view/dist/index.min.js'));
    put(join(nm, 'webfontloader/package.json'), JSON.stringify({ version: '1.6.28' }));
    put(join(nm, 'webfontloader/webfontloader.js'));
    const seeded = linkFromSibling(f, 'public/vditor/.version');
    run(f, 'setup-vditor-runtime.sh');
    expectIsolated(f, 'public/vditor/.version', seeded, '3.11.2\n');
    expectNoSharedInodes(join(f.app, 'public'));
  });
});
