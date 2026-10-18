/**
 * installInjectionHooks — install-time provenance + the all-or-nothing property.
 *
 * ── WHY THIS FILE EXISTS (EI-20006285243973245) ──
 * Until now this installer had NO coverage at all and recorded NOTHING when it
 * ran. The CC hooks beside it have carried a `.installed-from` stamp since
 * WI-37405; the injection pair had none, so "when were these installed, and
 * from which build?" had no answer anywhere. That is what left a real omp
 * injection outage (2026-08-09 18:15Z) permanently cause-UNDETERMINED: the one
 * hypothesis left standing — that the dispatcher was absent or mid-install —
 * was untestable after the fact, because file mtimes are rewritten by this
 * function on EVERY psu launch and nothing else recorded a thing.
 *
 * ⚠ The negative cases below assert "no stamp was written", which is also what a
 * writeInstallStamp call that was deleted would produce. The CALIBRATION test
 * asserts a stamp IS written; if it fails, treat the negatives as vacuous.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CC_HOOK_FILES,
  installClaudeHooks,
  installInjectionHooks,
  installOmpHookBundle,
  installPapercuspFiles,
} from './papercusp-files';
import { INSTALLED_FROM_BASENAME, readInstallStamp } from './install-provenance';

const run = promisify(execFile);

let root: string;
let home: string;
let srcRoot: string;
let injectSrc: string;

/** Build the source layout the installer expects: `<srcRoot>/inject/**` beside
 *  `<srcRoot>/omp/inject-hook.ts`. */
async function makeSources(opts: { dispatcher?: boolean; ompArtifact?: boolean } = {}) {
  const { dispatcher = true, ompArtifact = true } = opts;
  await fs.mkdir(path.join(injectSrc, 'adapters'), { recursive: true });
  if (dispatcher) {
    await fs.writeFile(path.join(injectSrc, 'index.mjs'), '// dispatcher\n');
    await fs.writeFile(path.join(injectSrc, 'adapters', 'omp.mjs'), '// adapter\n');
  }
  if (ompArtifact) {
    await fs.mkdir(path.join(srcRoot, 'omp'), { recursive: true });
    await fs.writeFile(path.join(srcRoot, 'omp', 'inject-hook.ts'), '// artifact\n');
  }
}

/**
 * Make the exact shared hook layout from a real git checkout. The installer
 * orders competing canonical checkouts by the commit date git reports, so a
 * mocked provenance value would not guard the source-resolution seam that
 * regressed live in EI-20333884491932817.
 */
async function makeGitHookSource(
  repo: string,
  marker: string,
  committedAt: string,
): Promise<{ injectDir: string; coordHook: string }> {
  const hooksDir = path.join(repo, 'scripts', 'hooks');
  const injectDir = path.join(hooksDir, 'inject');
  const ompDir = path.join(hooksDir, 'omp');
  await fs.mkdir(path.join(injectDir, 'adapters'), { recursive: true });
  await fs.mkdir(ompDir, { recursive: true });
  await fs.writeFile(path.join(injectDir, 'index.mjs'), `// dispatcher ${marker}\n`);
  await fs.writeFile(path.join(injectDir, 'adapters', 'omp.mjs'), `// adapter ${marker}\n`);
  await fs.writeFile(path.join(ompDir, 'inject-hook.ts'), `// inject hook ${marker}\n`);
  await fs.writeFile(path.join(ompDir, 'coord-hook.ts'), `// coord hook ${marker}\n`);

  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Papercusp Test'], { cwd: repo });
  await run('git', ['config', 'user.email', 'test@papercusp.local'], { cwd: repo });
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-qm', marker], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: committedAt,
      GIT_COMMITTER_DATE: committedAt,
    },
  });
  return { injectDir, coordHook: path.join(ompDir, 'coord-hook.ts') };
}

async function makeGitCcHookSource(
  repo: string,
  marker: string,
  committedAt: string,
): Promise<{ ccDir: string }> {
  const ccDir = path.join(repo, 'scripts', 'hooks', 'cc');
  await fs.mkdir(ccDir, { recursive: true });
  for (const name of CC_HOOK_FILES) {
    // EI-21974793277035753: the body must be VALID for the extension, because
    // installClaudeHooks now parse-checks each hook and refuses one that does not compile.
    // A single bash-shaped body for every file made `.mjs` hooks unparseable (`#` is not a
    // JS comment), so the installer correctly refused all 24 of them and these tests failed
    // on the resulting console.error. Matches how makeGitInjectSource above already writes
    // its `.mjs` fixtures.
    const body = /\.m[jt]s$/.test(name)
      ? `// ${marker}: ${name}\n`
      : `#!/bin/bash\n# ${marker}: ${name}\n`;
    await fs.writeFile(path.join(ccDir, name), body);
  }

  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Papercusp Test'], { cwd: repo });
  await run('git', ['config', 'user.email', 'test@papercusp.local'], { cwd: repo });
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-qm', marker], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: committedAt,
      GIT_COMMITTER_DATE: committedAt,
    },
  });
  return { ccDir };
}

const injectDest = () => path.join(home, '.papercusp', 'hooks', 'inject');
const ompDest = () => path.join(home, '.papercusp', 'hooks', 'omp');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'inject-hooks-prov-'));
  home = path.join(root, 'home');
  srcRoot = path.join(root, 'src', 'hooks');
  injectSrc = path.join(srcRoot, 'inject');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('installInjectionHooks — install provenance', () => {
  it('delivers one merged consequence from installed modules across fresh hook processes', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const hookSources = path.join(repoRoot, 'apps/operator/scripts/hooks');
    const ccSource = path.join(srcRoot, 'cc');
    const ccDest = path.join(home, '.papercusp/hooks/cc');
    const detectorNames = ['posttooluse-required-field-strand-nudge.mjs', 'posttooluse-behavioural-strand-nudge.mjs'];
    const installedNames = [...detectorNames, 'posttoolbatch-midturn-context.sh', 'pretooluse-locks-acquire.sh'];
    await fs.mkdir(ccSource, { recursive: true });
    for (const name of installedNames) await fs.copyFile(path.join(hookSources, 'cc', name), path.join(ccSource, name));
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    const foreign = { matcher: 'Edit', hooks: [{ type: 'command', command: '/foreign/check' }] };
    await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [foreign,
      ...detectorNames.map(name => ({ matcher: 'Edit', hooks: [{ type: 'command', command: path.join(ccDest, name) }] })),
    ] } }));

    const cc = await installClaudeHooks(home, ccSource);
    expect(cc.settingsMerged).toBe(true);
    expect(cc.installed).toEqual(expect.arrayContaining(installedNames));
    const injection = await installInjectionHooks(home, path.join(hookSources, 'inject'));
    expect(injection).toEqual(expect.arrayContaining(['inject/core.mjs', 'inject/delivery-ledger.mjs']));
    for (const name of detectorNames) expect(await fs.readFile(path.join(ccDest, name)))
      .toEqual(await fs.readFile(path.join(ccSource, name)));
    for (const name of ['core.mjs', 'delivery-ledger.mjs']) expect(await fs.readFile(path.join(injectDest(), name)))
      .toEqual(await fs.readFile(path.join(hookSources, 'inject', name)));
    const settings = JSON.parse(await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.PostToolUse).toEqual([foreign]);
    expect(JSON.stringify(settings.hooks.PostToolBatch)).toContain('posttoolbatch-midturn-context.sh');

    const base = 'a'.repeat(40);
    const checks = [
      `node scripts/check-required-field-strands.mjs --typecheck --base ${base} --files=src/api.ts`,
      `node scripts/check-behavioural-strands.mjs --base ${base} --files=src/api.ts`,
    ];
    const request = { owner: 'installed-consequence-test', cwd: root, toolCalls: [{ tool: 'Edit',
      interfaceEdits: [{ path: 'src/api.ts', base, changes: ['signature api', 'behavioural strand risk'], checks }],
    }] };
    // Clear the parent loader: the child must execute the installed byte copies.
    // Empty remote context exercises the production local fallback without network writes.
    const child = `import { pathToFileURL } from 'node:url';
      const { postInjection } = await import(pathToFileURL(process.argv[1]).href);
      const result = await postInjection('mid-turn', JSON.parse(process.argv[2]), {
        env: process.env, fetchImpl: async () => new Response(JSON.stringify({ ok: true, text: '' })) });
      console.log(JSON.stringify(result));`;
    const fire = () => run(process.execPath, ['--input-type=module', '-e', child,
      path.join(injectDest(), 'core.mjs'), JSON.stringify(request)], {
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_HOME: path.join(home, '.papercusp'), PAPERCUSP_MID_TURN_CONTEXT: 'on' },
    });
    const first = await fire();
    expect(first.stderr).toBe('');
    const result = JSON.parse(first.stdout);
    expect(result.text.match(/## Code intelligence/g)).toHaveLength(1);
    for (const check of checks) expect(result.text).toContain(check);
    expect(result.text).toContain('consumer and test reach unknown');
    expect(result.text.length).toBeLessThanOrEqual(1500);
    const duplicate = await fire();
    expect(duplicate.stderr).toBe('');
    expect(JSON.parse(duplicate.stdout)).toBeNull();
  }, 30_000);

  it('CALIBRATION (must pass or every negative below is vacuous): a good install stamps BOTH dest dirs', async () => {
    await makeSources();
    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toContain(path.join('inject', 'index.mjs'));
    expect(installed).toContain(path.join('omp', 'inject-hook.ts'));
    expect(await readInstallStamp(injectDest())).not.toBeNull();
    expect(await readInstallStamp(ompDest())).not.toBeNull();
  });

  it('the dispatcher stamp DATES the install and names the source + files', async () => {
    // Dating the install is the whole point: mtimes cannot do it because this
    // function rewrites them on every psu launch.
    await makeSources();
    const before = Date.now();
    await installInjectionHooks(home, injectSrc);
    const stamp = await readInstallStamp(injectDest());

    expect(stamp!.sourceDir).toBe(injectSrc);
    expect(stamp!.files).toEqual(expect.arrayContaining(['index.mjs', path.join('adapters', 'omp.mjs')]));
    expect(stamp!.pid).toBe(process.pid);
    expect(Date.parse(stamp!.installedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('the omp artifact gets its OWN stamp, pointing at the omp source dir', async () => {
    // Separate dirs, separate stamps — the artifact is installed best-effort in
    // its own try, so it can legitimately be present/absent independently.
    await makeSources();
    await installInjectionHooks(home, injectSrc);
    const stamp = await readInstallStamp(ompDest());

    expect(stamp!.sourceDir).toBe(path.join(srcRoot, 'omp'));
    expect(stamp!.files).toEqual(['inject-hook.ts']);
  });

  it('installs relative OMP companions beside the injection importer and clears the load check', async () => {
    await makeSources();
    const ompSource = path.join(srcRoot, 'omp');
    await fs.writeFile(
      path.join(ompSource, 'inject-hook.ts'),
      "import { stashAdvisory } from './non-preempting-delivery';\nexport { stashAdvisory };\n",
    );
    await fs.writeFile(path.join(ompSource, 'non-preempting-delivery.ts'), 'export const stashAdvisory = () => {};\n');

    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toContain(path.join('omp', 'inject-hook.ts'));
    expect(installed).toContain(path.join('omp', 'non-preempting-delivery.ts'));
    expect(await fs.readFile(path.join(ompDest(), 'non-preempting-delivery.ts'), 'utf8')).toContain('stashAdvisory');
    expect((await readInstallStamp(ompDest()))!.files).toEqual(
      expect.arrayContaining(['inject-hook.ts', 'non-preempting-delivery.ts']),
    );
  });

  it('reports an unresolved relative OMP import through the installer-side detector', async () => {
    const ompSource = path.join(srcRoot, 'omp');
    const destination = path.join(home, 'omp-dest');
    await fs.mkdir(ompSource, { recursive: true });
    await fs.writeFile(
      path.join(ompSource, 'coord-hook.ts'),
      "import './missing-companion';\nexport default {};\n",
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await installOmpHookBundle({
      sourceDir: ompSource,
      entryFile: 'coord-hook.ts',
      destinationDir: destination,
      destinationEntry: 'papercusp-coord.ts',
    });

    expect(result.installed).toEqual(['papercusp-coord.ts']);
    expect(result.unresolved).toEqual(['papercusp-coord.ts -> ./missing-companion']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('OMP hook bundle load check FAILED'));
  });

  it.each(['desktop', 'standalone'])('loads the real installed coordination hook through %s outside the workspace and links its native UUID', async installer => {
    const destination = path.join(home, '.papercusp');
    const scriptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/operator/scripts');
    const sourceDir = path.join(scriptDir, 'hooks', 'omp');
    if (installer === 'desktop') {
      const result = await installOmpHookBundle({ sourceDir, entryFile: 'coord-hook.ts',
        destinationDir: destination, destinationEntry: 'papercusp-coord.ts' });
      expect(result.unresolved).toEqual([]);
    } else {
      const source = await fs.readFile(path.join(scriptDir, 'install-standalone-mcp.sh'), 'utf8');
      const start = source.indexOf('install_omp_hook_bundle() {');
      const end = source.indexOf('\nCOORD_EXT_SRC=', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      await run('bash', ['-c', `${source.slice(start, end)}\nSCRIPT_DIR="$1"\ninstall_omp_hook_bundle "$2" "$3" coord-hook.ts papercusp-coord.ts`,
        'omp-install-test', scriptDir, sourceDir, destination]);
    }

    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url';
      const hook = await import(pathToFileURL(process.argv[1]).href);
      const calls = [];
      globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        calls.push(request.params);
        return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, result: 'linked' }) }] } }) };
      };
      const linked = await hook.linkAdvSessionFromContext({ cwd: process.cwd(),
        sessionManager: { getSessionId: () => 'native-omp-installed-hook' } });
      console.log(JSON.stringify({ linked, calls }));
    `, path.join(destination, 'papercusp-coord.ts')], {
      cwd: home,
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_HOME: destination,
        PAPERCUSP_ADV_SESSION_ID: '424242', PAPERCUSP_BUNDLE_URL: 'http://operator.test' },
    });
    expect(JSON.parse(stdout)).toEqual({ linked: true, calls: [{ name: 'omp:sessions',
      arguments: { op: 'link', advSessionId: 424242, sessionId: 'native-omp-installed-hook', cwd: home } }] });
  });

  it('refuses an unresolved package import before replacing a healthy coordination hook', async () => {
    const ompSource = path.join(srcRoot, 'omp');
    const destination = path.join(home, 'omp-package-dest');
    await fs.mkdir(ompSource, { recursive: true });
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'papercusp-coord.ts'), '// healthy installed hook\n');
    await fs.writeFile(path.join(ompSource, 'coord-hook.ts'),
      "import '@papercusp/missing-hook-dependency';\nexport default {};\n");
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(installOmpHookBundle({ sourceDir: ompSource, entryFile: 'coord-hook.ts',
      destinationDir: destination, destinationEntry: 'papercusp-coord.ts' })).rejects.toThrow();
    expect(await fs.readFile(path.join(destination, 'papercusp-coord.ts'), 'utf8')).toBe('// healthy installed hook\n');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('OMP hook bundle load check FAILED'), expect.anything());
  });

  it('installs one self-contained vm-release .mjs bundle under the established .ts destination', async () => {
    const ompSource = path.join(srcRoot, 'omp');
    const destination = path.join(home, 'omp-release-dest');
    await fs.mkdir(ompSource, { recursive: true });
    await fs.writeFile(path.join(ompSource, 'coord-hook.mjs'), '// bundled coord release\nexport default {};\n');
    await fs.writeFile(path.join(ompSource, 'inject-hook.mjs'), '// unrelated sibling bundle\n');

    const result = await installOmpHookBundle({
      sourceDir: ompSource,
      entryFile: 'coord-hook.mjs',
      destinationDir: destination,
      destinationEntry: 'papercusp-coord.ts',
    });

    expect(result).toEqual({ installed: ['papercusp-coord.ts'], unresolved: [] });
    expect(await fs.readFile(path.join(destination, 'papercusp-coord.ts'), 'utf8')).toContain(
      'bundled coord release',
    );
    expect(await fs.readdir(destination)).toEqual(['papercusp-coord.ts']);
  });

  it('falls back to the bundled vm-release injection hook while preserving its install path and stamp', async () => {
    await makeSources({ ompArtifact: false });
    const ompSource = path.join(srcRoot, 'omp');
    await fs.mkdir(ompSource, { recursive: true });
    await fs.writeFile(path.join(ompSource, 'inject-hook.mjs'), '// bundled inject release\nexport {};\n');
    await fs.writeFile(path.join(ompSource, 'coord-hook.mjs'), '// unrelated sibling bundle\n');

    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toContain(path.join('omp', 'inject-hook.ts'));
    expect(installed).not.toContain(path.join('omp', 'coord-hook.mjs'));
    expect(await fs.readFile(path.join(ompDest(), 'inject-hook.ts'), 'utf8')).toContain(
      'bundled inject release',
    );
    expect((await readInstallStamp(ompDest()))!).toMatchObject({
      sourceDir: ompSource,
      files: ['inject-hook.ts'],
    });
  });

  it('auto-discovers the bundled vm-release coordination hook when TypeScript source is absent', async () => {
    const operatorRoot = path.join(root, 'vm-release-operator');
    const ompSource = path.join(operatorRoot, 'scripts', 'hooks', 'omp');
    await fs.mkdir(ompSource, { recursive: true });
    await fs.writeFile(path.join(ompSource, 'coord-hook.mjs'), '// bundled coord discovery\nexport {};\n');

    const result = await installPapercuspFiles({
      home,
      operatorAppRoot: operatorRoot,
      playbookSource: path.join(operatorRoot, 'missing-playbook.md'),
    });

    expect(result.extensionWritten).toBe(true);
    expect(result.extensionSource).toBe(path.join(ompSource, 'coord-hook.mjs'));
    expect(await fs.readFile(path.join(home, '.papercusp', 'papercusp-coord.ts'), 'utf8')).toContain(
      'bundled coord discovery',
    );
  });

  it('logs one greppable line naming hooks/inject and inject-hook', async () => {
    // The exact probe the failed investigation ran was
    //   journalctl -u papercup-dev-api.service | grep -icE 'injectionHooks|hooks/inject|inject-hook'
    // which returned 0 for the whole window. Keep those substrings present.
    await makeSources();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await installInjectionHooks(home, injectSrc);

    const line = log.mock.calls.map(c => String(c[0])).join('\n');
    expect(line).toMatch(/hooks\/inject/);
    expect(line).toMatch(/inject-hook/);
  });

  it('ALL-OR-NOTHING: a missing dispatcher source installs nothing and stamps nothing', async () => {
    // A half-install (omp hook present, dispatcher absent) is the invisible
    // failure this installer exists to prevent — it yields a session that loads
    // the hook, finds nothing, and fail-silently injects nothing on every turn.
    await makeSources({ dispatcher: false });
    // Silenced because this path now (correctly) warns — asserted in the next case.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toEqual([]);
    expect(await readInstallStamp(injectDest())).toBeNull();
    expect(await readInstallStamp(ompDest())).toBeNull();
  });

  it('ALL-OR-NOTHING: the inactive case WARNS instead of being left to inference', async () => {
    // `[]` is documented as "omp injection inactive on this box", which every
    // downstream turn then presents as the indistinguishable "no memories were
    // relevant". Say it once, loudly.
    await makeSources({ dispatcher: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await installInjectionHooks(home, injectSrc);

    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/INACTIVE/);
  });

  it('a missing omp artifact still installs + stamps the dispatcher (claude/codex are unaffected)', async () => {
    // Regression guard: gating the dispatcher on the omp file would silently
    // disable injection for CLAUDE — ~100% of real traffic — over an unrelated
    // omp artifact.
    await makeSources({ ompArtifact: false });
    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toContain(path.join('inject', 'index.mjs'));
    expect(installed).not.toContain(path.join('omp', 'inject-hook.ts'));
    expect(await readInstallStamp(injectDest())).not.toBeNull();
    expect(await readInstallStamp(ompDest())).toBeNull();
  });

  it('the stamp does not become a file the dispatcher copy loop picks up', async () => {
    // `.installed-from` lands in the DEST dir; the copy loops read the SOURCE.
    // A re-install must not start propagating it.
    await makeSources();
    await installInjectionHooks(home, injectSrc);
    const second = await installInjectionHooks(home, injectSrc);

    expect(second).not.toContain(path.join('inject', INSTALLED_FROM_BASENAME));
    expect(second.filter(f => f.includes(INSTALLED_FROM_BASENAME))).toEqual([]);
  });

  it('refuses a minutes-old real-git source across the shared dispatcher, OMP hook, and root coordination bundle', async () => {
    const newerRepo = path.join(root, 'newer-checkout');
    const staleRepo = path.join(root, 'stale-release-checkout');
    await fs.mkdir(newerRepo, { recursive: true });
    await fs.mkdir(staleRepo, { recursive: true });
    const newer = await makeGitHookSource(newerRepo, 'newer', '2026-08-13T12:05:00Z');
    const stale = await makeGitHookSource(staleRepo, 'stale', '2026-08-13T12:00:00Z');

    await installInjectionHooks(home, newer.injectDir);
    const newerRootInstall = await installPapercuspFiles({
      home,
      operatorAppRoot: newerRepo,
      playbookSource: path.join(newerRepo, 'missing-playbook.md'),
      extensionSource: newer.coordHook,
    });
    expect(newerRootInstall.extensionWritten).toBe(true);

    const before = {
      dispatcher: await fs.readFile(path.join(injectDest(), 'index.mjs'), 'utf8'),
      ompHook: await fs.readFile(path.join(ompDest(), 'inject-hook.ts'), 'utf8'),
      coordHook: await fs.readFile(path.join(home, '.papercusp', 'papercusp-coord.ts'), 'utf8'),
      injectStamp: await fs.readFile(path.join(injectDest(), INSTALLED_FROM_BASENAME), 'utf8'),
      ompStamp: await fs.readFile(path.join(ompDest(), INSTALLED_FROM_BASENAME), 'utf8'),
    };

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await installInjectionHooks(home, stale.injectDir)).toEqual([]);
    const staleRootInstall = await installPapercuspFiles({
      home,
      operatorAppRoot: staleRepo,
      playbookSource: path.join(staleRepo, 'missing-playbook.md'),
      extensionSource: stale.coordHook,
    });

    expect(staleRootInstall.extensionWritten).toBe(false);
    expect(await fs.readFile(path.join(injectDest(), 'index.mjs'), 'utf8')).toBe(before.dispatcher);
    expect(await fs.readFile(path.join(ompDest(), 'inject-hook.ts'), 'utf8')).toBe(before.ompHook);
    expect(await fs.readFile(path.join(home, '.papercusp', 'papercusp-coord.ts'), 'utf8')).toBe(before.coordHook);
    expect(await fs.readFile(path.join(injectDest(), INSTALLED_FROM_BASENAME), 'utf8')).toBe(before.injectStamp);
    expect(await fs.readFile(path.join(ompDest(), INSTALLED_FROM_BASENAME), 'utf8')).toBe(before.ompStamp);
    expect(error.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/REFUSING downgrade/);
  });

  it('logs and stamps the CC source unit + path-specific sha on a successful install', async () => {
    const repo = path.join(root, 'cc-checkout');
    await fs.mkdir(repo, { recursive: true });
    const source = await makeGitCcHookSource(repo, 'cc-success', '2026-08-13T12:05:00Z');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await installPapercuspFiles({
      home,
      operatorAppRoot: repo,
      playbookSource: path.join(repo, 'missing-playbook.md'),
      extensionSource: path.join(repo, 'missing-extension.ts'),
    });

    expect(result.claudeHooksInstalled).toContain('pretooluse-locks-acquire.sh');
    const stamp = await readInstallStamp(path.join(home, '.papercusp', 'hooks', 'cc'));
    expect(stamp?.sourceDir).toBe(source.ccDir);
    expect(stamp?.sourceCommittedAt).toBe('2026-08-13T12:05:00.000Z');
    expect(stamp?.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp?.unit).toMatch(/^hono-host:/);
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      new RegExp(`hooks/cc <- ${source.ccDir.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')} \\(unit=[^,]+, sha=[0-9a-f]{40}\\)`),
    );
  });

  /**
   * EI-21974793277035753 — the unchanged-bytes fast path must not become a hole.
   *
   * Skipping the rewrite for byte-identical hooks is what keeps a steady-state launch at
   * zero cost, but the code it skips used to chmod on EVERY launch. Mode drift is real
   * (a 775 hook was observed in the live dir), and a hook that loses its +x does not
   * error — it silently stops running, which for the fail-open bash gate is silent
   * ungating: the very failure this work exists to close.
   */
  describe('unchanged hooks', () => {
    const ccDest = () => path.join(home, '.papercusp', 'hooks', 'cc');
    const target = CC_HOOK_FILES.find((n) => n.endsWith('.sh')) as string;

    it('repairs drifted permissions even when the bytes are identical', async () => {
      const repo = path.join(root, 'cc-mode-drift');
      await fs.mkdir(repo, { recursive: true });
      await makeGitCcHookSource(repo, 'cc-mode', '2026-08-13T12:05:00Z');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const opts = {
        home,
        operatorAppRoot: repo,
        playbookSource: path.join(repo, 'missing-playbook.md'),
        extensionSource: path.join(repo, 'missing-extension.ts'),
      };
      await installPapercuspFiles(opts);

      const dst = path.join(ccDest(), target);
      const before = await fs.readFile(dst);
      await fs.chmod(dst, 0o644); // strip +x, leaving the bytes untouched
      expect((await fs.stat(dst)).mode & 0o777).toBe(0o644);

      await installPapercuspFiles(opts);

      expect((await fs.stat(dst)).mode & 0o777).toBe(0o755);
      // And the fast path still held: the bytes were never rewritten to get there.
      expect(await fs.readFile(dst)).toEqual(before);
    });
  });

  /**
   * EI-21974793277035753 T3 — an UNCOMMITTED hook reaches every agent on this box on the
   * next launch, with no commit, no green-checkpoint verdict and no deploy. Measured
   * 2026-08-31: a PreToolUse gate edit was live fleet-wide ~4.5h before it was committed.
   */
  describe('uncommitted CC hooks', () => {
    const ccDest = () => path.join(home, '.papercusp', 'hooks', 'cc');
    // Resolved from the list rather than hardcoded, so renaming a hook cannot silently
    // turn these into no-ops. Not the locks hook: refusing THAT one also skips the
    // settings merge, which would confound what these tests are measuring.
    const target = CC_HOOK_FILES.find(
      (n) => n.endsWith('.sh') && n !== 'pretooluse-locks-acquire.sh',
    ) as string;

    let priorEnv: string | undefined;
    beforeEach(() => {
      priorEnv = process.env.PAPERCUSP_ALLOW_DIRTY_HOOKS;
      delete process.env.PAPERCUSP_ALLOW_DIRTY_HOOKS;
    });
    afterEach(() => {
      if (priorEnv === undefined) delete process.env.PAPERCUSP_ALLOW_DIRTY_HOOKS;
      else process.env.PAPERCUSP_ALLOW_DIRTY_HOOKS = priorEnv;
    });

    const install = (repo: string) =>
      installPapercuspFiles({
        home,
        operatorAppRoot: repo,
        playbookSource: path.join(repo, 'missing-playbook.md'),
        extensionSource: path.join(repo, 'missing-extension.ts'),
      });

    it('refuses to publish one over an already-installed copy, and keeps that copy', async () => {
      const repo = path.join(root, 'cc-dirty-refuse');
      await fs.mkdir(repo, { recursive: true });
      const src = await makeGitCcHookSource(repo, 'cc-clean', '2026-08-13T12:05:00Z');
      await install(repo);
      const committedBody = await fs.readFile(path.join(ccDest(), target), 'utf8');

      // Edit the source WITHOUT committing — exactly the 2026-08-31 shape.
      await fs.writeFile(path.join(src.ccDir, target), '#!/bin/bash\n# UNCOMMITTED EDIT\n');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await install(repo);

      expect(await fs.readFile(path.join(ccDest(), target), 'utf8')).toBe(committedBody);
      const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toMatch(/refused as UNCOMMITTED/);
      // The remedy must be IN the message: a refusal nobody can act on is its own defect.
      expect(logged).toMatch(/PAPERCUSP_ALLOW_DIRTY_HOOKS=1/);
    });

    it('publishes it anyway under the explicit opt-in', async () => {
      const repo = path.join(root, 'cc-dirty-optin');
      await fs.mkdir(repo, { recursive: true });
      const src = await makeGitCcHookSource(repo, 'cc-optin', '2026-08-13T12:05:00Z');
      await install(repo);

      const edited = '#!/bin/bash\n# DELIBERATE UNCOMMITTED EDIT\n';
      await fs.writeFile(path.join(src.ccDir, target), edited);
      process.env.PAPERCUSP_ALLOW_DIRTY_HOOKS = '1';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await install(repo);

      expect(await fs.readFile(path.join(ccDest(), target), 'utf8')).toBe(edited);
      // Still announced: opting in makes it deliberate, not invisible.
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/UNCOMMITTED/);
    });

    it('publishes it on a FIRST install, because absent is worse than ungated', async () => {
      // The safety condition. With no previously installed copy there is no known-good to
      // fall back to, so refusing would leave the hook MISSING — and for a guard hook,
      // missing and ungated are the same outcome. Refusing here would cause the exact
      // failure the refusal exists to prevent.
      const repo = path.join(root, 'cc-dirty-first');
      await fs.mkdir(repo, { recursive: true });
      const src = await makeGitCcHookSource(repo, 'cc-first', '2026-08-13T12:05:00Z');
      const edited = '#!/bin/bash\n# UNCOMMITTED ON A FRESH BOX\n';
      await fs.writeFile(path.join(src.ccDir, target), edited);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await install(repo);

      expect(result.claudeHooksInstalled).toContain(target);
      expect(await fs.readFile(path.join(ccDest(), target), 'utf8')).toBe(edited);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/UNCOMMITTED/);
    });

    it('records the uncommitted set on the stamp, so the sha is never read as describing them', async () => {
      const repo = path.join(root, 'cc-dirty-stamp');
      await fs.mkdir(repo, { recursive: true });
      const src = await makeGitCcHookSource(repo, 'cc-stamp', '2026-08-13T12:05:00Z');
      await fs.writeFile(path.join(src.ccDir, target), '#!/bin/bash\n# UNCOMMITTED\n');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await install(repo);

      const stamp = await readInstallStamp(ccDest());
      expect(stamp?.uncommittedFiles).toEqual([target]);
      expect(stamp?.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('records [] — not undefined — when everything matches its commit', async () => {
      // The positive control for the case above: a stamp that always reported "dirty"
      // would pass that test, and one that never populated the field would pass a laxer
      // version of this one. Both directions have to be pinned.
      const repo = path.join(root, 'cc-clean-stamp');
      await fs.mkdir(repo, { recursive: true });
      await makeGitCcHookSource(repo, 'cc-clean-stamp', '2026-08-13T12:05:00Z');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await install(repo);

      expect((await readInstallStamp(ccDest()))?.uncommittedFiles).toEqual([]);
    });
  });

  it('refuses a newer-installed CC hook bundle even when the stale source is only minutes older', async () => {
    const newerRepo = path.join(root, 'cc-newer-checkout');
    const staleRepo = path.join(root, 'cc-stale-checkout');
    await fs.mkdir(newerRepo, { recursive: true });
    await fs.mkdir(staleRepo, { recursive: true });
    const newer = await makeGitCcHookSource(newerRepo, 'cc-newer', '2026-08-13T12:05:00Z');
    const stale = await makeGitCcHookSource(staleRepo, 'cc-stale', '2026-08-13T12:00:00Z');

    await installPapercuspFiles({
      home,
      operatorAppRoot: newerRepo,
      playbookSource: path.join(newerRepo, 'missing-playbook.md'),
      extensionSource: path.join(newerRepo, 'missing-extension.ts'),
    });
    const installedPath = path.join(home, '.papercusp', 'hooks', 'cc', 'userpromptsubmit-provenance.sh');
    const before = await fs.readFile(installedPath, 'utf8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const staleResult = await installPapercuspFiles({
      home,
      operatorAppRoot: staleRepo,
      playbookSource: path.join(staleRepo, 'missing-playbook.md'),
      extensionSource: path.join(staleRepo, 'missing-extension.ts'),
    });

    expect(staleResult.claudeHooksInstalled).toEqual([]);
    expect(await fs.readFile(installedPath, 'utf8')).toBe(before);
    expect((await readInstallStamp(path.join(home, '.papercusp', 'hooks', 'cc')))?.sourceDir).toBe(newer.ccDir);
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      /cc hooks: REFUSING downgrade.*300000ms older/,
    );
  });
});
