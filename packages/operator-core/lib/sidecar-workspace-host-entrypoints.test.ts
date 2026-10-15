/**
 * EI-21546829012278002 / D-105: the generated root bootstrap executes eleven
 * fixed release paths. A Server sidecar with only Node + the remote initializer
 * therefore cannot install, migrate, start, attest, or launch an agent even if
 * every pre-publication trust gate is green.
 *
 * These tests execute the maintained overlay against a scratch sidecar and
 * cover both its build integration and its fail-closed wrapper behavior. The
 * real Server is never started; the fixture models serve.mjs's side-effect-free
 * help branch and records every non-help invocation.
 */
import { DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS } from '@papercusp/deployment-driver';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const LIB_DIR = import.meta.dirname ?? __dirname;
const REPO_ROOT = join(LIB_DIR, '..', '..', '..');
const INSTALLER = join(
  REPO_ROOT,
  'papercusp-desktop/bin/install-workspace-host-entrypoints.sh',
);
const BUILDER = join(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh');
const VERIFIER = join(REPO_ROOT, 'papercusp-desktop/bin/verify-sidecar-bundle.sh');
const VM_RELEASE_CONFIG = join(
  REPO_ROOT,
  'papercusp-desktop/src-tauri/tauri.vm-release.conf.json',
);
const PUI_MANIFEST_WRITER = join(REPO_ROOT, 'apps/tui/scripts/write-install-manifest.py');
const CONTENT_BOOTSTRAP = 'papercusp-content-bootstrap';
const scratchRoots: string[] = [];

/**
 * DERIVED from the bootstrap contract, never restated.
 *
 * A hand-written copy of this list is how the set silently stopped matching: `bin/papercusp-deliver-material`
 * became a required bootstrap entrypoint and a required release material (D-215), and every check
 * in this file kept passing against the twelve it already knew. Reading the contract means a
 * fourteenth entrypoint fails here the moment it is declared, instead of surfacing as a VM that
 * aborts during install.
 */
const ENTRYPOINTS = Object.values(DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS).map((path) => {
  if (!path.startsWith('bin/')) {
    throw new Error(`bootstrap entrypoint '${path}' is not under bin/; this test's mapping is stale`);
  }
  return path.slice('bin/'.length);
});
const PG_TOOLS = ['pg_dump', 'psql', 'pg_dumpall', 'pg_restore'] as const;

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-workspace-host-entrypoints-'));
  scratchRoots.push(root);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'db-sql'), { recursive: true });
  const pgNative = join(
    root,
    'node_modules/@papercusp/embedded-postgres-server/node_modules/@embedded-postgres/linux-x64/native/bin',
  );
  mkdirSync(pgNative, { recursive: true });
  symlinkSync(process.execPath, join(root, 'bin/node'));
  for (const tool of PG_TOOLS) {
    writeFileSync(join(pgNative, tool), `#!/usr/bin/env bash\nprintf '${tool} 18.6\\n'\n`);
    chmodSync(join(pgNative, tool), 0o755);
    symlinkSync(
      `/tmp/deleted-sidecar.tmp.238817/node_modules/@papercusp/embedded-postgres-server/node_modules/@embedded-postgres/linux-x64/native/bin/${tool}`,
      join(root, 'bin', tool),
    );
  }
  writeFileSync(
    join(root, 'serve.mjs'),
    `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
      `const argv = process.argv.slice(2);\n` +
      `if (argv[0] === '--content-bootstrap') {\n` +
      `  if (argv.some((arg) => arg === '--help' || arg === '-h')) {\n` +
      `    process.stdout.write('Usage: papercusp-content-bootstrap --state-root <absolute-directory>\\n');\n` +
      `  } else {\n` +
      `    const stateRoot = argv[argv.indexOf('--state-root') + 1];\n` +
      `    for (const dir of ['blueprints/base/prompts', 'templates', 'rubrics']) mkdirSync(stateRoot + '/.papercusp/' + dir, { recursive: true });\n` +
      `    writeFileSync(stateRoot + '/content-bootstrap-invoked.json', JSON.stringify({ argv }));\n` +
      `  }\n` +
      `} else if (argv.some((arg) => arg === '--help' || arg === '-h')) {\n` +
      `  process.stdout.write('Usage: papercusp serve [--ensure] [--ui]\\n');\n` +
      `} else {\n` +
      `  writeFileSync(process.env.PC_ENTRYPOINT_OUTPUT, JSON.stringify({ argv, env: process.env }));\n` +
      `}\n`,
  );
  writeFileSync(
    join(root, 'scripts/psu.mjs'),
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(process.env.PC_ENTRYPOINT_OUTPUT, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`,
  );
  writeFileSync(join(root, 'bin/pui'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(root, 'bin/pui'), 0o755);
  writeFileSync(join(root, 'pui-companion.wasm'), 'fixture-wasm');
  const puiManifest = run('python3', [
    PUI_MANIFEST_WRITER,
    'write',
    '--manifest', join(root, 'pui-install.json'),
    '--source-sha', 'a'.repeat(40),
    '--source-dirty', '0',
    '--built-at-epoch', '123',
    '--binary', join(root, 'bin/pui'),
    '--companion', join(root, 'pui-companion.wasm'),
    '--relative-paths',
  ]);
  if (puiManifest.status !== 0) throw new Error(puiManifest.stderr);
  writeFileSync(join(root, 'db-sql/000-baseline.sql'), 'select 1;\n');
  writeFileSync(join(root, 'bin/papercusp-remote-initializer'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(root, 'bin/papercusp-remote-initializer'), 0o755);
  writeFileSync(join(root, 'bin/papercusp-deliver-material'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(root, 'bin/papercusp-deliver-material'), 0o755);
  writeFileSync(
    join(root, 'build-provenance.json'),
    `${JSON.stringify({ version: '2026.8.26-1', buildSha: 'a'.repeat(40), artifacts: [] })}\n`,
  );
  return root;
}

function run(path: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(path, [...args], { encoding: 'utf8', env, timeout: 120_000, killSignal: 'SIGKILL' });
}

function install(root: string) {
  const result = run('bash', [INSTALLER, '--release-root', root]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace-host sidecar entrypoint producer', () => {
  it('fails closed when a real delegate is absent', () => {
    const root = makeFixture();
    rmSync(join(root, 'scripts/psu.mjs'));
    const result = run('bash', [INSTALLER, '--release-root', root]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('scripts/psu.mjs');
    expect(existsSync(join(root, 'bin/papercusp-server'))).toBe(false);
  });

  it.each(['pui-companion.wasm', 'pui-install.json'])(
    'fails closed when the matched PUI generation omits %s',
    (asset) => {
      const root = makeFixture();
      rmSync(join(root, asset));
      const result = run('bash', [INSTALLER, '--release-root', root]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(asset);
    },
  );

  it.each(['papercusp-remote-initializer', 'papercusp-deliver-material'])(
    'fails closed when the builder did not produce bin/%s',
    (program) => {
      const root = makeFixture();
      rmSync(join(root, 'bin', program));
      const result = run('bash', [INSTALLER, '--release-root', root]);
      // These two are esbuild bundles the BUILDER emits, not wrappers this overlay writes — so
      // the only thing that can catch their absence here is a refusal. Emitting the nine wrappers
      // anyway would produce a bundle that installs and then fails on the host.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(program === 'papercusp-deliver-material' ? 'delivery' : 'initializer');
      expect(existsSync(join(root, 'bin/papercusp-server'))).toBe(false);
    },
  );

  it('emits every declared bootstrap path without replacing Node, PUI, or the two host programs', () => {
    const root = makeFixture();
    const nodeTarget = readlinkSync(join(root, 'bin/node'));
    const initializer = readFileSync(join(root, 'bin/papercusp-remote-initializer'), 'utf8');
    const delivery = readFileSync(join(root, 'bin/papercusp-deliver-material'), 'utf8');
    const pui = readFileSync(join(root, 'bin/pui'), 'utf8');
    install(root);
    for (const name of ENTRYPOINTS) {
      expect(run('test', ['-x', join(root, 'bin', name)]).status, name).toBe(0);
    }
    expect(run('test', ['-x', join(root, 'bin', CONTENT_BOOTSTRAP)]).status).toBe(0);
    expect(readlinkSync(join(root, 'bin/node'))).toBe(nodeTarget);
    expect(readFileSync(join(root, 'bin/papercusp-remote-initializer'), 'utf8')).toBe(initializer);
    // The overlay emits WRAPPERS; the two controller-spawned programs are esbuild bundles the
    // builder produced, and overwriting either with a shim would pass every existence check here
    // while breaking the protocol on a real host.
    expect(readFileSync(join(root, 'bin/papercusp-deliver-material'), 'utf8')).toBe(delivery);
    expect(readFileSync(join(root, 'bin/pui'), 'utf8')).toBe(pui);
    for (const tool of PG_TOOLS) {
      const target = readlinkSync(join(root, 'bin', tool));
      expect(target.startsWith('/'), tool).toBe(false);
      expect(target).toContain(`/native/bin/${tool}`);
      expect(run(join(root, 'bin', tool), ['--version']).status, tool).toBe(0);
    }
  });

  it('is invoked for future vm-release builds before prune and finished-bundle verification', () => {
    const builder = readFileSync(BUILDER, 'utf8');
    const emit = builder.indexOf('bash "$HERE/install-workspace-host-entrypoints.sh"');
    const prune = builder.indexOf('--prune-vm-release', emit);
    // The builder invokes the verifier through its own bin dir, `"$HERE/verify-sidecar-bundle.sh"`
    // (with PAPERCUSP_DESKTOP_TARGET_ROOT="$ROOT"); older builders spelled it `"$ROOT/bin/…"`.
    // Both name the same script — the ordering after prune is the property under test.
    const verifyCall = /"\$(?:HERE|ROOT\/bin)\/verify-sidecar-bundle\.sh" "\$SIDECAR_DIR"/g;
    verifyCall.lastIndex = Math.max(prune, 0);
    const verify = prune < 0 ? -1 : (verifyCall.exec(builder)?.index ?? -1);
    expect(emit).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(emit);
    expect(verify).toBeGreaterThan(prune);
    expect(builder.slice(emit - 400, emit)).toContain('DISTRIBUTION_PROFILE');
    expect(builder).toContain('ln -sfn "../$_pg_rel_src"');
    expect(builder).toContain('re-verifying atomically published sidecar at its final path');
    // The two controller-spawned programs are BUNDLED by the builder, before the overlay runs and
    // demands them. Nothing on the build host invokes either, so a builder that quietly stopped
    // producing one would be invisible until a real remote operation failed.
    const bundle = builder.indexOf('for _wh_entrypoint in papercusp-remote-initializer papercusp-deliver-material');
    expect(bundle).toBeGreaterThan(0);
    expect(bundle).toBeLessThan(emit);
  });

  it('carries the complete PUI generation through the vm-release resource allowlist', () => {
    const config = JSON.parse(readFileSync(VM_RELEASE_CONFIG, 'utf8')) as {
      bundle?: { resources?: string[] };
    };
    const resources = config.bundle?.resources ?? [];
    expect(resources).toContain('sidecar/bin/**/*');
    expect(resources).toContain('sidecar/pui-companion.wasm');
    expect(resources).toContain('sidecar/pui-install.json');
  });

  it('makes the finished-bundle verifier require and allowlist every generated wrapper', () => {
    const verifier = readFileSync(VERIFIER, 'utf8');
    for (const name of ENTRYPOINTS.filter((entry) => entry !== 'node')) {
      expect(verifier, name).toContain(name);
    }
    expect(verifier).toContain('install-workspace-host-entrypoints.sh');
    expect(verifier).toContain('pui-companion.wasm');
    expect(verifier).toContain('pui-install.json');
    expect(verifier).toContain('write-install-manifest.py');
    expect(verifier).toContain(CONTENT_BOOTSTRAP);
  });
});

describe('workspace-host entrypoint behavior', () => {
  it('validates install, rollback, and migration contracts without inventing a second runner', () => {
    const root = makeFixture();
    install(root);
    const state = join(root, 'state');
    const previous = join(root, 'previous');
    mkdirSync(state);
    mkdirSync(join(previous, 'bin'), { recursive: true });
    writeFileSync(join(previous, 'bin/papercusp-server'), '#!/usr/bin/env bash\n');
    chmodSync(join(previous, 'bin/papercusp-server'), 0o755);

    expect(
      run(join(root, 'bin/papercusp-install'), [
        '--action', 'install', '--release-root', root, '--state-root', state,
      ]).status,
    ).toBe(0);
    expect(
      JSON.parse(readFileSync(join(state, 'content-bootstrap-invoked.json'), 'utf8')),
    ).toEqual({ argv: ['--content-bootstrap', '--state-root', state] });
    expect(
      run(join(root, 'bin/papercusp-install'), [
        '--action', 'unknown', '--release-root', root, '--state-root', state,
      ]).status,
    ).not.toBe(0);
    expect(
      run(join(root, 'bin/papercusp-rollback'), [
        '--from', previous, '--to', root, '--state-root', state,
      ]).status,
    ).toBe(0);
    expect(
      run(join(root, 'bin/papercusp-migrate'), [
        '--database-root', state, '--migration-id', 'migration-2026.08.26',
      ]).status,
    ).toBe(0);
    expect(
      run(join(root, 'bin/papercusp-migrate'), [
        '--database-root', state, '--migration-id', '../unsafe',
      ]).status,
    ).not.toBe(0);
  });

  it('fails closed when the installed Cupboard prompt inventory is missing', () => {
    const root = makeFixture();
    install(root);
    const prompts = join(root, '.papercusp', 'blueprints', 'base', 'prompts');
    rmSync(prompts, { recursive: true, force: true });
    const pgRoot = join(root, 'pgdata');
    mkdirSync(pgRoot);

    const result = run(join(root, 'bin/papercusp-server'), [], {
      ...process.env,
      PAPERCUSP_PORT: '4107',
      PAPERCUSP_EMBEDDED_PG_ROOT: pgRoot,
      PAPERCUSP_HOME: join(root, '.papercusp'),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`installed Cupboard content is missing: ${prompts}`);
  });

  it('maps bootstrap env names, pins immutable runtime policy, and delegates side-effect-free help', () => {
    const root = makeFixture();
    install(root);
    const output = join(root, 'server-output.json');
    const pgRoot = join(root, 'pgdata');
    mkdirSync(pgRoot);
    expect(
      run(join(root, 'bin', CONTENT_BOOTSTRAP), ['--state-root', root]).status,
    ).toBe(0);
    const env = {
      ...process.env,
      PC_ENTRYPOINT_OUTPUT: output,
      PAPERCUSP_PORT: '4107',
      PAPERCUSP_EMBEDDED_PG_ROOT: pgRoot,
      PAPERCUSP_HOME: join(root, '.papercusp'),
    };
    const result = run(join(root, 'bin/papercusp-server'), [], env);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(readFileSync(output, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(observed.argv).toEqual([]);
    expect(observed.env.PAPERCUSP_HONO_PORT).toBe('4107');
    expect(observed.env.PAPERCUSP_PG_DATA_DIR).toBe(pgRoot);
    expect(observed.env.PAPERCUSP_PG_SQL_DIR).toBe(join(root, 'db-sql'));
    expect(observed.env.PAPERCUSP_SIDECAR_BIN).toBe(join(root, 'bin'));
    expect(observed.env.PUI_COMPANION_WASM).toBe(join(root, 'pui-companion.wasm'));
    expect(observed.env.PUI_INSTALL_MANIFEST).toBe(join(root, 'pui-install.json'));
    expect(observed.env.PAPERCUSP_BUILD_VERSION).toBe('2026.8.26-1');
    expect(observed.env.PAPERCUSP_BUILD_SHA).toBe('a'.repeat(40));
    expect(observed.env.PAPERCUSP_DISTRIBUTION_PROFILE).toBe('vm-release');
    expect(observed.env.PAPERCUSP_PROVISION_ENV_OPERATORS).toBe('0');
    expect(observed.env.PAPERCUSP_HOME).toBe(join(root, '.papercusp'));
    expect(observed.env.PAPERCUSP_PROMPTS_DIR).toBe(
      join(root, '.papercusp', 'blueprints', 'base', 'prompts'),
    );
    expect(observed.env.PAPERCUSP_TEMPLATES_DIR).toBe(join(root, '.papercusp', 'templates'));
    expect(observed.env.PAPERCUSP_RUBRICS_DIR).toBe(join(root, '.papercusp', 'rubrics'));

    rmSync(output);
    const help = run(join(root, 'bin/papercusp-server'), ['--help'], env);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage: papercusp serve [--ensure] [--ui]');
    expect(existsSync(output)).toBe(false);
  });

  it('delegates psu and agent wrappers through the shipped launcher with a pinned backend', () => {
    const root = makeFixture();
    install(root);
    const output = join(root, 'psu-output.json');
    const env = { ...process.env, PC_ENTRYPOINT_OUTPUT: output };

    expect(run(join(root, 'bin/psu'), ['--help'], env).status).toBe(0);
    let observed = JSON.parse(readFileSync(output, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(observed.argv).toEqual(['--help']);
    expect(observed.env.PAPERCUSP_SIDECAR_BIN).toBe(join(root, 'bin'));

    expect(run(join(root, 'bin/claude'), ['--no-picker'], env).status).toBe(0);
    observed = JSON.parse(readFileSync(output, 'utf8'));
    expect(observed.argv).toEqual(['--agent=claude', '--no-picker']);
    expect(run(join(root, 'bin/claude'), ['--agent=codex'], env).status).not.toBe(0);
  });

  it('retries the bounded loopback health probe and rejects non-loopback targets', () => {
    const root = makeFixture();
    install(root);
    const fakeBin = join(root, 'fake-bin');
    const countFile = join(root, 'curl-count');
    const argsFile = join(root, 'curl-args');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'curl'),
      '#!/usr/bin/env bash\n' +
        'n=0; [[ ! -f "$PC_CURL_COUNT_FILE" ]] || n="$(cat "$PC_CURL_COUNT_FILE")"\n' +
        'n=$((n + 1)); printf "%s" "$n" > "$PC_CURL_COUNT_FILE"\n' +
        'printf "%s\\n" "$*" > "$PC_CURL_ARGS_FILE"\n' +
        '[[ "$n" -ge 2 ]]\n',
    );
    chmodSync(join(fakeBin, 'curl'), 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PC_CURL_COUNT_FILE: countFile,
      PC_CURL_ARGS_FILE: argsFile,
      PAPERCUSP_HEALTH_TIMEOUT_SEC: '4',
    };
    const health = run(
      join(root, 'bin/papercusp-health'),
      ['--host', '127.0.0.1', '--port', '4107'],
      env,
    );
    expect(health.status, health.stderr).toBe(0);
    expect(readFileSync(countFile, 'utf8')).toBe('2');
    expect(readFileSync(argsFile, 'utf8')).toContain('http://127.0.0.1:4107/api/health');
    expect(
      run(join(root, 'bin/papercusp-health'), ['--host', '0.0.0.0', '--port', '4107'], env)
        .status,
    ).not.toBe(0);
  });
});
