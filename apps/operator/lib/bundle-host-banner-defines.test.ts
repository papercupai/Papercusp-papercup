/**
 * Recurrence guard for WI-10005299: the shared esbuild host banner must never re-declare
 * `__dirname` / `__filename`, and every esbuild call that injects it must also pass
 * HOST_BANNER_DEFINES.
 *
 * Why this cannot be caught by the bundler alone: esbuild never parses `--banner:js` text, so
 * its renamer cannot see a binding the banner declares. A module-level `const __dirname` in
 * the bundled graph keeps its name unless some OTHER module reserves the name with a free
 * reference, so whether a bare banner declaration collides depends on the whole module graph.
 * The same source built cleanly into one bundle and crash-looped the embed sidecar in another
 * ("Identifier '__dirname' has already been declared"). The fix binds the banner's helpers under
 * banner-private names and rewrites FREE references with `--define`, which is graph-independent.
 *
 * This file lives under apps/operator/lib, outside every scanned root below, so the fixture
 * strings in it can never be picked up by the scan itself (asserted in the first test).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { verifierSourceFiles } from '../../../packages/operator-core/lib/verifier-source';

const TEST_FILE = fileURLToPath(import.meta.url);
// Resolve from this module, not process.cwd(): root-level and package-scoped Vitest runs differ.
const REPO_ROOT = resolve(dirname(TEST_FILE), '../../..');
const COMMON_SCRIPT = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');

/** Roots whose shell scripts invoke esbuild with the shared banner. */
const SCAN_ROOTS = ['apps/operator/bin', 'scripts', 'papercusp-desktop/bin'] as const;
/** papercusp-desktop is a submodule; its scripts are only scanned when it is checked out. */
const DESKTOP_ROOT = 'papercusp-desktop/bin';

/** Files known to inject the banner today — the positive control that keeps the scan honest. */
const KNOWN_SUPERPROJECT_CONSUMERS = [
  'apps/operator/bin/bundle-host-common.sh',
  'apps/operator/bin/bundle-host.sh',
  'scripts/build-p2p-witness.sh',
];
const KNOWN_DESKTOP_CONSUMERS = [
  'papercusp-desktop/bin/build-desktop-sidecar.sh',
  'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh',
];

const BARE_PATH_BINDING = /\b(?:const|let|var|function)\s+(?:__dirname|__filename)\b/;

interface SharedBanner {
  banner: string;
  defines: Record<string, string>;
}

describe('WI-10007604 — frozen host source identity', () => {
  const source = readFileSync(join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh'), 'utf8');
  const block = source.slice(source.indexOf('if [[ -f "$REPO_ROOT/.verifier-source.json" ]]'), source.indexOf('# EI-9413:'));
  const select = (root: string, receipt = '') => spawnSync('bash', ['-c', 'set -euo pipefail; REPO_ROOT="$1"; COMMITTED_NODE=(node);\n' + block + '\nprintf "%s" "$SOURCE_SHA"', '_', root],
    { encoding: 'utf8', env: { ...process.env, VERIFY_TAURI_SOURCE_RECEIPT: receipt } });
  function snapshotRoot() {
    // Match the maintained verifier's ignored scratch boundary. An unignored
    // fixture is rightly refused by the committed-source loader before receipt
    // verification, masking both the positive and tampered-archive controls.
    const parent = join(REPO_ROOT, '.papercusp/tmp');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'host-source-identity-'));
    expect(spawnSync('git', ['check-ignore', root], { cwd: REPO_ROOT }).status).toBe(0);
    return root;
  }
  function snapshot() {
    // Nested under a real checkout: Git demonstrably discovers the wrong parent.
    const root = snapshotRoot();
    const helper = 'packages/operator-core/lib/verifier-source.ts';
    mkdirSync(dirname(join(root, helper)), { recursive: true });
    writeFileSync(join(root, helper), readFileSync(join(REPO_ROOT, helper)));
    writeFileSync(join(root, 'entry.ts'), 'console.log(__PAPERCUSP_BUNDLED_SOURCE_SHA__);\n');
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
      testedInputs: [{ path: 'entry.ts', sha256: 'fixture' }], files: verifierSourceFiles(root) };
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    return root;
  }
  it('bakes the validated archive commit instead of the enclosing checkout HEAD', () => {
    const root = snapshot();
    try {
      expect(spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()).toBe(REPO_ROOT);
      const selected = select(root);
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toBe('a'.repeat(12));
      const outfile = join(root, 'bundle.mjs');
      const compile = spawnSync(join(REPO_ROOT, 'node_modules/esbuild/bin/esbuild'), [join(root, 'entry.ts'), '--outfile=' + outfile,
        '--define:__PAPERCUSP_BUNDLED_SOURCE_SHA__=' + JSON.stringify(selected.stdout)], { encoding: 'utf8' });
      expect(compile.status, compile.stderr).toBe(0);
      expect(spawnSync(process.execPath, [outfile], { encoding: 'utf8' }).stdout.trim()).toBe('a'.repeat(12));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses changed source bytes before stamping an archive commit', () => {
    const root = snapshot();
    try {
      writeFileSync(join(root, 'entry.ts'), 'changed source');
      const selected = select(root);
      expect(selected.status).not.toBe(0);
      expect(selected.stderr).toContain('tampered verification source archive');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses malformed archive provenance', () => {
    const root = snapshot();
    try {
      writeFileSync(join(root, '.verifier-source.json'), '{}');
      expect(select(root).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses an external receipt that disagrees with the archived identity', () => {
    const root = snapshot(), external = root + '.receipt.json';
    try {
      const receipt = JSON.parse(readFileSync(join(root, '.verifier-source.json'), 'utf8'));
      writeFileSync(external, JSON.stringify({ ...receipt, sourceCommit: 'b'.repeat(40) }));
      const selected = select(root, external);
      expect(selected.status).not.toBe(0);
      expect(selected.stderr).toContain('tampered verification source provenance');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(external, { force: true }); }
  });
  it('refuses a pinned receipt without its archive marker before Git fallback', () => {
    const root = snapshotRoot();
    try {
      const selected = select(root, join(root, 'missing-receipt.json'));
      expect(selected.status).toBe(78);
      expect(selected.stderr).toContain('pinned source receipt requires its archive marker');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('leaves an unrecorded gitless export unknown instead of borrowing its parent', () => {
    const root = snapshotRoot();
    try {
      const selected = select(root);
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('retains the ordinary checkout source identity', () => {
    const selected = select(REPO_ROOT);
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout).toBe(spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim());
  });
  it('bakes a generation-alias checkout identity into the actual build-info resolver', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-source-alias-'));
    try {
      const root = join(dir, 'generation'), alias = join(dir, 'staging.current');
      mkdirSync(join(root, 'apps/operator'), { recursive: true });
      symlinkSync(root, alias, 'dir');
      expect(spawnSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root }).status).toBe(0);
      const imported = spawnSync('git', ['fast-import', '--quiet'], { cwd: root, encoding: 'utf8',
        input: 'blob\nmark :1\ndata 6\nfrozen\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 source.txt\n\ndone\n' });
      expect(imported.status, imported.stderr).toBe(0);
      const expected = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
      const rootBlock = source.slice(source.indexOf('REPO_ROOT="$(cd'), source.indexOf('# Node helpers run'));
      const selected = spawnSync('bash', ['-c', 'set -euo pipefail; OPERATOR_DIR="$1/apps/operator"; COMMITTED_NODE=(node);\n' +
        rootBlock + '\n' + block + '\nprintf "%s" "$SOURCE_SHA"', '_', alias],
      { encoding: 'utf8', env: { ...process.env, VERIFY_TAURI_SOURCE_RECEIPT: '' } });
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toBe(expected);
      const entry = join(dir, 'entry.ts'), outfile = join(dir, 'bundle.mjs');
      writeFileSync(entry, `import { resolveBuildInfo } from ${JSON.stringify(join(REPO_ROOT, 'packages/operator-core/lib/build-info.ts'))};\nconsole.log(resolveBuildInfo().sha);\n`);
      const compile = spawnSync(join(REPO_ROOT, 'node_modules/esbuild/bin/esbuild'), [entry, '--bundle', '--platform=node',
        '--format=esm', '--outfile=' + outfile, '--define:__PAPERCUSP_BUNDLED_SIDECAR__=true',
        '--define:__PAPERCUSP_BUNDLED_SOURCE_SHA__=' + JSON.stringify(selected.stdout)], { encoding: 'utf8' });
      expect(compile.status, compile.stderr).toBe(0);
      expect(spawnSync(process.execPath, [outfile], { encoding: 'utf8' }).stdout.trim()).toBe(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('EI-25446866026477971 — host build paths across the package-cache reader', () => {
  it.each([
    { label: 'documented defaults', args: [], entry: 'bin/hono-host.ts', outfile: 'dist-host/hono-host.mjs' },
    { label: 'relative paths with spaces', args: ['bin/other host.ts', 'dist-other/host output.mjs'], entry: 'bin/other host.ts', outfile: 'dist-other/host output.mjs' },
  ])('bundles $label from the repo-root reader into the operator output', ({ args, entry, outfile }) => {
    const dir = mkdtempSync(join(tmpdir(), 'host-reader-paths-'));
    try {
      const operatorDir = join(dir, 'apps/operator');
      const source = readFileSync(join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh'), 'utf8');
      // Execute the production path-selection boundary, then exercise its paths
      // through the real reader and compiler from a different working directory.
      const block = source.slice(source.indexOf('ENTRY="${1:-'), source.indexOf('STALE_MARKER='));
      expect(block).toContain('OUTFILE=');
      const entryPath = join(operatorDir, entry), outputPath = join(operatorDir, outfile);
      mkdirSync(dirname(entryPath), { recursive: true });
      writeFileSync(entryPath, 'console.log("reader-relative-entry");\n');
      const selection = spawnSync('bash', ['-c', 'OPERATOR_DIR="$1"; shift;\n' + block + '\nprintf "%s\\0%s" "$ENTRY" "$OUTFILE"', '_', operatorDir, ...args], { encoding: 'utf8' });
      expect(selection.status, selection.stderr).toBe(0);
      const [selectedEntry, selectedOutput] = selection.stdout.split('\0');
      const reader = [join(REPO_ROOT, 'scripts/npm-install-safe.mjs'), '--repo-root', dir,
        '--exec-under-cache-lock', '--', join(REPO_ROOT, 'node_modules/esbuild/bin/esbuild')];
      const wrongBase = spawnSync(process.execPath, [...reader, entry, '--bundle', '--platform=node', '--format=esm', '--outfile=' + outfile], { cwd: operatorDir, encoding: 'utf8' });
      expect(wrongBase.status).not.toBe(0);
      expect(wrongBase.stderr).toContain('Could not resolve');
      expect(existsSync(outputPath)).toBe(false);
      const compile = spawnSync(process.execPath, [...reader,
        selectedEntry, '--bundle', '--platform=node', '--format=esm', '--outfile=' + selectedOutput], { cwd: operatorDir, encoding: 'utf8' });
      expect(compile.status, compile.stderr).toBe(0);
      expect(readFileSync(outputPath, 'utf8')).toContain('reader-relative-entry');
      expect(existsSync(join(dir, outfile))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Read the banner and its defines exactly as bash sees them, by sourcing the real script. */
function loadSharedBanner(): SharedBanner {
  const result = spawnSync(
    'bash',
    ['-c', 'source "$1" && printf "%s" "$HOST_BANNER" && printf "\\0" && printf "%s\\n" "${HOST_BANNER_DEFINES[@]}"', '_', COMMON_SCRIPT],
    { encoding: 'utf8', env: { ...process.env, PAPERCUSP_BUNDLE_HOST_COMMON_LOADED: '' } },
  );
  expect(result.status, result.stderr).toBe(0);
  const [banner, defineLines] = result.stdout.split('\0');
  const defines: Record<string, string> = {};
  for (const line of defineLines.split('\n').filter(Boolean)) {
    const match = /^--define:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)$/.exec(line);
    expect(match, `unexpected HOST_BANNER_DEFINES entry: ${line}`).not.toBeNull();
    defines[match![1]] = match![2];
  }
  return { banner, defines };
}

interface BannerCall {
  line: number;
  bannerVar: string;
  hasDefines: boolean;
  command: string;
}

describe('WI-10007376 — helper-only host bundles avoid eager PTY script hashing', () => {
  it('runs launcher helpers without reading the generated bundle as a PTY script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-helper-digest-'));
    try {
      const { banner, defines } = loadSharedBanner();
      const entry = join(dir, 'entry.mjs');
      const out = join(dir, 'host.mjs');
      writeFileSync(entry, [
        `import { operatorPinEvidence } from ${JSON.stringify(join(REPO_ROOT, 'apps/operator/scripts/psu-pty-host.mjs'))};`,
        `import { normalizeModelSpecForAgent } from ${JSON.stringify(join(REPO_ROOT, 'apps/operator/scripts/psu-launcher.mjs'))};`,
        `console.log(operatorPinEvidence({ PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170' }));`,
        `console.log(normalizeModelSpecForAgent('codex', 'gpt-5.5:high'));`,
      ].join('\n'));
      await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node',
        format: 'esm', target: 'node22', banner: { js: banner },
        define: { ...defines, __PAPERCUSP_BUNDLED_SIDECAR__: 'true' },
        treeShaking: true, logLevel: 'silent' });
      // Allow Node's own loader reads, but fail if a bundled PTY initializer
      // performs the extra filesystem read observed in the frozen-host profile.
      const preload = [
        "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';",
        'const read = fs.readFileSync;',
        "fs.readFileSync = function(...args) { if (new Error().stack.includes('hashHostScript')) process.stderr.write('EAGER_PTY_DIGEST_ATTEMPT\\n'); return read.apply(this, args); };",
        'syncBuiltinESMExports();',
      ].join('\n');
      const run = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, out], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('direct-3170\ngpt-5.5:high');
      // hashHostScript deliberately degrades read errors to null, so detect
      // attempted reads independently of its return value or process status.
      expect(run.stderr).not.toContain('EAGER_PTY_DIGEST_ATTEMPT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Find every esbuild `--banner:js=` argument that injects HOST_BANNER (directly or through a
 * variable built from it, such as STAMP_BANNER), and report whether the same logical shell
 * command — the run of lines joined by trailing backslashes — also passes HOST_BANNER_DEFINES.
 */
function findBannerCalls(source: string): BannerCall[] {
  // Blank comment lines while keeping line numbers, so prose that mentions the flag never counts.
  const lines = source.split('\n').map((text) => (/^\s*#/.test(text) ? '' : text));
  const bannerVars = new Set(['HOST_BANNER']);
  for (const text of lines) {
    const derived = /^\s*(?:local\s+|export\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=.*\$\{?HOST_BANNER\b/.exec(text);
    if (derived) bannerVars.add(derived[1]);
  }
  const continues = (index: number) => index >= 0 && index < lines.length && lines[index].trimEnd().endsWith('\\');
  const calls: BannerCall[] = [];
  lines.forEach((text, index) => {
    const arg = /--banner:js=["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
    if (!arg || !bannerVars.has(arg[1])) return;
    let start = index;
    while (continues(start - 1)) start -= 1;
    let end = index;
    while (continues(end)) end += 1;
    const command = lines.slice(start, end + 1).join('\n');
    calls.push({ line: index + 1, bannerVar: arg[1], hasDefines: command.includes('HOST_BANNER_DEFINES[@]'), command });
  });
  return calls;
}

function listShellFiles(root: string): string[] {
  const absolute = join(REPO_ROOT, root);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (entry.endsWith('.sh')) out.push(path);
    }
  };
  walk(absolute);
  return out;
}

describe('findBannerCalls (scanner controls)', () => {
  it('cannot self-match: this test file is outside every scanned root', () => {
    const own = relative(REPO_ROOT, TEST_FILE);
    for (const root of SCAN_ROOTS) expect(own.startsWith(`${root}/`)).toBe(false);
  });

  it('flags a banner call that omits the defines, including through a derived banner variable', () => {
    const fixture = [
      'STAMP="${HOST_BANNER}console.log(1);"',
      'npx esbuild a.ts \\',
      '  --bundle \\',
      '  --banner:js="$HOST_BANNER" \\',
      '  --outfile=a.mjs',
      'npx esbuild b.ts --banner:js="$STAMP" --outfile=b.mjs',
    ].join('\n');
    const calls = findBannerCalls(fixture);
    expect(calls.map((call) => [call.line, call.bannerVar, call.hasDefines])).toEqual([
      [4, 'HOST_BANNER', false],
      [6, 'STAMP', false],
    ]);
  });

  it('accepts the defines anywhere in the same continued command, in either expansion form', () => {
    const fixture = [
      '(cd web && npx esbuild a.ts \\',
      '  --banner:js="$HOST_BANNER" \\',
      '  ${HOST_BANNER_DEFINES[@]+"${HOST_BANNER_DEFINES[@]}"})',
      'npx esbuild b.ts --banner:js="$HOST_BANNER" "${HOST_BANNER_DEFINES[@]}" --outfile=b.mjs',
    ].join('\n');
    expect(findBannerCalls(fixture).map((call) => call.hasDefines)).toEqual([true, true]);
  });

  it('does not borrow defines from a different command, and ignores comments and unrelated banners', () => {
    const fixture = [
      'npx esbuild a.ts "${HOST_BANNER_DEFINES[@]}" --outfile=a.mjs',
      'npx esbuild b.ts \\',
      '  --banner:js="$HOST_BANNER" \\',
      '  --outfile=b.mjs',
      '# npx esbuild c.ts --banner:js="$HOST_BANNER"',
      'npx esbuild d.ts --banner:js="$OTHER_BANNER" --outfile=d.mjs',
    ].join('\n');
    expect(findBannerCalls(fixture).map((call) => [call.line, call.hasDefines])).toEqual([[3, false]]);
  });
});

describe('shared esbuild host banner (WI-10005299)', () => {
  it('binds its path helpers under banner-private names that HOST_BANNER_DEFINES targets', () => {
    const { banner, defines } = loadSharedBanner();
    expect(banner).not.toMatch(BARE_PATH_BINDING);
    expect(Object.keys(defines).sort()).toEqual(['__dirname', '__filename']);
    for (const target of Object.values(defines)) {
      expect(target).not.toMatch(/^__(?:dirname|filename)$/);
      expect(banner).toMatch(new RegExp(`\\bconst ${target}=`));
    }
  });

  it('every esbuild call that injects the banner also passes HOST_BANNER_DEFINES', () => {
    const consumers = new Set<string>();
    const missing: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of listShellFiles(root)) {
        const rel = relative(REPO_ROOT, file);
        for (const call of findBannerCalls(readFileSync(file, 'utf8'))) {
          consumers.add(rel);
          if (!call.hasDefines) missing.push(`${rel}:${call.line} (--banner:js="$${call.bannerVar}")`);
        }
      }
    }
    expect(missing).toEqual([]);
    // Positive control: the scan must still see every known consumer, or a zero above is vacuous.
    for (const known of KNOWN_SUPERPROJECT_CONSUMERS) expect([...consumers]).toContain(known);
    if (existsSync(join(REPO_ROOT, DESKTOP_ROOT))) {
      for (const known of KNOWN_DESKTOP_CONSUMERS) expect([...consumers]).toContain(known);
    }
  });

  describe('bundling with the real banner', () => {
    // Exercise the maintained desktop policy before applying it to another producer.
    // The development host still needs its emitted source-comment diagnostics.
    function desktopCompaction() {
      const desktop = readFileSync(join(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh'), 'utf8');
      const block = desktop.split('# >>> desktop release compaction\n')[1]?.split('# <<< desktop release compaction')[0];
      expect(block, 'desktop compaction policy must remain discoverable').toBeTruthy();
      const selected = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1";\n' + block +
        '\nprintf "%s\\n" "${MINIFY_ARGS[@]}"', '_', COMMON_SCRIPT], {
        encoding: 'utf8', env: { ...process.env, PAPERCUSP_BUNDLE_HOST_COMMON_LOADED: '' },
      });
      expect(selected.status, selected.stderr).toBe(0);
      const flags = selected.stdout.trim().split(/\s+/);
      expect(flags.sort()).toEqual(['--minify-syntax', '--minify-whitespace']);
      return { minifyWhitespace: flags.includes('--minify-whitespace'), minifySyntax: flags.includes('--minify-syntax') };
    }

    it('selects release compaction explicitly and rejects unknown or unbound freshness profiles', () => {
      const host = readFileSync(join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh'), 'utf8');
      const block = host.split('# >>> host bundle profile\n')[1]?.split('# <<< host bundle profile')[0];
      expect(block).toBeTruthy();
      const select = (profile: string, reuse = '0') => spawnSync('bash', ['-c',
        'set -euo pipefail; SCRIPT_DIR="$1"; shift;\n' + block +
        '\nprintf "%s\\n" "${HOST_MINIFY_ARGS[@]}"', '_', dirname(COMMON_SCRIPT), 'entry', 'output', profile], {
        encoding: 'utf8', env: { ...process.env, PAPERCUSP_BUNDLE_HOST_COMMON_LOADED: '', PAPERCUSP_BUNDLE_REUSE_FRESH: reuse },
      });
      expect(select('development').stdout.trim()).toBe('');
      const release = select('release');
      expect(release.status, release.stderr).toBe(0);
      expect(release.stdout.trim().split('\n')).toEqual(['--minify-whitespace', '--minify-syntax']);
      expect(select('unknown').status).toBe(78);
      expect(select('release', '1').status).toBe(78);
      expect(select('release', '1').stderr).toContain('do not use development freshness reuse');
    });

    it('retains desktop compaction for an exact-source target predating the shared policy', () => {
      const desktop = readFileSync(join(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh'), 'utf8');
      const block = desktop.split('# >>> desktop release compaction\n')[1].split('# <<< desktop release compaction')[0];
      const selected = spawnSync('bash', ['-c', 'set -euo pipefail;\n' + block +
        '\nprintf "%s\\n" "${MINIFY_ARGS[@]}"'], { encoding: 'utf8' });
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout.trim().split('\n')).toEqual(['--minify-whitespace', '--minify-syntax']);
    });

    async function bundleAndRun(entrySource: string, opts: {
      banner: string;
      define?: Record<string, string>;
      compact?: boolean;
      minifyIdentifiers?: boolean;
      env?: NodeJS.ProcessEnv;
      modules?: Record<string, string>;
    }) {
      // realpath: macOS tmpdir is a symlink, and the bundle reports its resolved location.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bundle-host-banner-')));
      try {
        const entry = join(dir, 'entry.mjs');
        writeFileSync(entry, entrySource);
        for (const [name, source] of Object.entries(opts.modules ?? {})) writeFileSync(join(dir, name), source);
        const result = await build({
          entryPoints: [entry],
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node22',
          banner: { js: opts.banner },
          define: opts.define,
          ...(opts.compact ? desktopCompaction() : {}),
          minifyIdentifiers: opts.minifyIdentifiers ?? false,
          metafile: true,
          write: false,
          logLevel: 'silent',
        });
        const out = join(dir, 'out.mjs');
        writeFileSync(out, result.outputFiles[0].text);
        const check = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
        const run = check.status === 0 ? spawnSync(process.execPath, [out], {
          encoding: 'utf8', env: { ...process.env, ...opts.env },
        }) : null;
        return { dir, check, stdout: run?.stdout.trim() ?? '', stderr: run?.stderr ?? '',
          runStatus: run?.status ?? null, code: result.outputFiles[0].text, metafile: result.metafile };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // The crash shape: a module declares its OWN top-level __dirname and nothing in the graph
    // makes a free reference that would push esbuild to rename it.
    const OWN_DECLARATION = [
      "import { dirname } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const __dirname = dirname(fileURLToPath(import.meta.url));',
      'console.log(__dirname);',
    ].join('\n');
    // CJS-style code that relies on the banner to supply the value.
    const FREE_REFERENCE = 'console.log(__dirname + "|" + __filename);';

    it('control: the pre-fix banner (bare const __dirname) reproduces the duplicate-declaration crash', async () => {
      const { banner } = loadSharedBanner();
      const preFix = banner.replace(/__pc_dirname/g, '__dirname').replace(/__pc_filename/g, '__filename');
      expect(preFix).toMatch(BARE_PATH_BINDING);
      const result = await bundleAndRun(OWN_DECLARATION, { banner: preFix });
      expect(result.check.status).not.toBe(0);
      expect(result.check.stderr).toMatch(/Identifier '__dirname' has already been declared/);
    });

    it('bundles and runs a module that declares its own __dirname', async () => {
      const { banner, defines } = loadSharedBanner();
      const result = await bundleAndRun(OWN_DECLARATION, { banner, define: defines });
      expect(result.check.status, result.check.stderr).toBe(0);
      expect(result.runStatus).toBe(0);
      expect(result.stdout).toBe(result.dir);
    });

    it('still resolves free __dirname/__filename references through the defines', async () => {
      const { banner, defines } = loadSharedBanner();
      const result = await bundleAndRun(FREE_REFERENCE, { banner, define: defines });
      expect(result.check.status, result.check.stderr).toBe(0);
      expect(result.runStatus).toBe(0);
      expect(result.stdout).toBe(`${result.dir}|${join(result.dir, 'out.mjs')}`);
    });

    const DBOS_NAME_FIXTURE = [
      'const { DBOS } = require(process.env.P058_DBOS_SDK);',
      'const { getRegisteredFunctionName } = require(process.env.P058_DBOS_DECORATORS);',
      'async function portableWorkflow() { return 42; }',
      'function portableStep() { return 42; }',
      'class PortableTask { run() { return 42; } }',
      'const workflow = DBOS.registerWorkflow(portableWorkflow);',
      'const step = DBOS.registerStep(portableStep);',
      'console.log(JSON.stringify({ workflow: getRegisteredFunctionName(workflow),',
      '  step: getRegisteredFunctionName(step), task: PortableTask.name, value: new PortableTask().run() }));',
    ].join('\n');
    const DBOS_ENV = {
      P058_DBOS_SDK: join(REPO_ROOT, 'node_modules/@dbos-inc/dbos-sdk'),
      P058_DBOS_DECORATORS: join(REPO_ROOT, 'node_modules/@dbos-inc/dbos-sdk/dist/src/decorators.js'),
    };

    it('desktop compaction preserves actual DBOS workflow/step registration and class names', async () => {
      const { banner, defines } = loadSharedBanner();
      const result = await bundleAndRun(DBOS_NAME_FIXTURE, { banner, define: defines, compact: true, env: DBOS_ENV });
      expect(result.check.status, result.check.stderr).toBe(0);
      expect(result.runStatus, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ workflow: 'portableWorkflow', step: 'portableStep', task: 'PortableTask', value: 42 });
    });

    it('control: identifier mangling changes the names DBOS actually registers', async () => {
      const { banner, defines } = loadSharedBanner();
      const result = await bundleAndRun(DBOS_NAME_FIXTURE, {
        banner, define: defines, compact: true, minifyIdentifiers: true, env: DBOS_ENV,
      });
      expect(result.runStatus, result.stderr).toBe(0);
      const registered = JSON.parse(result.stdout);
      expect(registered.workflow).not.toBe('portableWorkflow');
      expect(registered.step).not.toBe('portableStep');
      expect(registered.task).not.toBe('PortableTask');
      expect(registered.value).toBe(42);
    });

    it('desktop compaction retains the generated banner, path bindings and CJS CLI protection', async () => {
      const { banner, defines } = loadSharedBanner();
      const entry = [
        'if (require.main === module) throw new Error("bundled library CLI ran");',
        'console.log(__dirname + "|" + __filename + "|" + __PAPERCUSP_BUNDLED_SOURCE_SHA__);',
      ].join('\n');
      const result = await bundleAndRun(entry, {
        banner, define: { ...defines, __PAPERCUSP_BUNDLED_SOURCE_SHA__: '"source-fixture"' }, compact: true,
      });
      expect(result.code.startsWith(banner)).toBe(true);
      expect(result.check.status, result.check.stderr).toBe(0);
      expect(result.runStatus, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${result.dir}|${join(result.dir, 'out.mjs')}|source-fixture`);
    });

    it('development output retains source markers; compact output retains the same input graph in its metafile', async () => {
      const { banner, defines } = loadSharedBanner();
      const entry = 'import { value } from "./diagnostic-leaf.mjs"; console.log(value);';
      const modules = { 'diagnostic-leaf.mjs': 'export const value = 42;' };
      const development = await bundleAndRun(entry, { banner, define: defines, modules });
      const compact = await bundleAndRun(entry, { banner, define: defines, modules, compact: true });
      for (const result of [development, compact]) {
        expect(result.runStatus, result.stderr).toBe(0);
        expect(result.stdout).toBe('42');
        expect(Object.keys(result.metafile!.inputs).some((path) => path.endsWith('/diagnostic-leaf.mjs'))).toBe(true);
        expect(Object.keys(result.metafile!.inputs).some((path) => path.endsWith('/entry.mjs'))).toBe(true);
      }
      expect(development.code).toMatch(/\/\/[^\n]*diagnostic-leaf\.mjs/);
      expect(compact.code).not.toMatch(/\/\/[^\n]*diagnostic-leaf\.mjs/);
    });
  });
});
