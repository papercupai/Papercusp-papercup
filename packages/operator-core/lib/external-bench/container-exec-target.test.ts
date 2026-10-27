/**
 * container-exec-target.test.ts — benchmark-coverage-frontierswe-v2-2026-10-10 D-026 / P-006.
 *
 * Executes the GENERATED wrapper (not string assertions on its source) against a fake
 * `docker` that records the argv and environment it received, so these pin what the
 * wrapper actually does when psu runs it as `codex`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  CONTAINER_CODEX_BIN_PATH,
  resolveContainerClaudeBinary,
  materializeDockerExecWrapper,
  renderDockerExecWrapper,
  validateDockerExecTarget,
  type DockerExecTarget,
} from './container-exec-target';

const target: DockerExecTarget = {
  kind: 'docker-exec',
  containerId: '3f2a9c1b7d4e',
  workdir: '/app',
  binPath: CONTAINER_CODEX_BIN_PATH,
};

let root: string;
let fakeDocker: string;
let argvLog: string;
let envLog: string;

beforeAll(() => {
  root = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'cexec-test-'));
  argvLog = join(root, 'argv.log');
  envLog = join(root, 'env.log');
  fakeDocker = join(root, 'fake-docker');
  // One argv element per line, then the values docker would read for two forwarded names.
  writeFileSync(
    fakeDocker,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvLog}'\nprintf '%s\\n%s\\n' "$CODEX_HOME" "$PAPERCUSP_TOKEN" > '${envLog}'\nexit "\${FAKE_DOCKER_EXIT:-0}"\n`,
    { mode: 0o755 },
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('native Claude container binary', () => {
  function nativeBinary(dir: string, name = 'claude') {
    const header = Buffer.alloc(20);
    header.write('7f454c460201', 0, 'hex'); header.writeUInt16LE(62, 18);
    const binary = join(dir, name);
    writeFileSync(binary, header, { mode: 0o755 });
    return binary;
  }
  it('pins the versioned ELF target and ignores a host docker-wrapper override', () => {
    const dir = mkdtempSync(join(root, 'native-'));
    const binary = nativeBinary(dir, '2.1.293');
    symlinkSync(binary, join(dir, 'claude'));
    expect(resolveContainerClaudeBinary({ arch: 'x64', env: { PATH: dir, PAPERCUSP_BACKEND_BIN_CLAUDE: fakeDocker } })).toBe(binary);
  });
  it('refuses npm scripts, foreign architectures, directories, nonexecutables and ambiguous mounts', () => {
    const dir = mkdtempSync(join(root, 'native-refuse-'));
    const script = join(dir, 'script'); writeFileSync(script, '#!/usr/bin/env node\n', { mode: 0o755 });
    const data = join(dir, 'data'); writeFileSync(data, 'no', { mode: 0o600 });
    const binary = nativeBinary(dir);
    const comma = nativeBinary(dir, 'with,comma');
    for (const candidate of [script, data, dir, comma]) expect(() => resolveContainerClaudeBinary({ binary: candidate, arch: 'x64' })).toThrow();
    expect(() => resolveContainerClaudeBinary({ binary, arch: 'arm64' })).toThrow(/architecture/);
    expect(() => resolveContainerClaudeBinary({ binary, platform: 'darwin' })).toThrow(/Linux/);
  });
});

function runWrapper(args: string[], env: Record<string, string>) {
  const { wrapperPath } = materializeDockerExecWrapper(target, {
    dir: mkdtempSync(join(root, 'w-')),
    dockerBin: fakeDocker,
    // Baseline wrapper assertions must not inherit the benchmark daemon selected by the host.
    dockerHost: '',
  });
  const r = spawnSync(wrapperPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
  const argv = readFileSync(argvLog, 'utf8').split('\n').slice(0, -1);
  return { r, argv, wrapperPath };
}

describe('stock Claude image environment admission', () => {
  // Unlike the argv-only Docker double above, model inspection and execute
  // the command with Docker's image-default + explicit -e environment merge.
  function launch(imageEnv: Record<string, string>, guarded = true, inspection?: { id?: unknown; env?: unknown }) {
    const dir = mkdtempSync(join(root, 'image-env-'));
    const docker = join(dir, 'docker');
    const argvFile = join(dir, 'argv.json');
    writeFileSync(docker, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2), env = ${JSON.stringify(imageEnv)};
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
if (args[0] === 'inspect') {
  process.stdout.write(JSON.stringify(${JSON.stringify(inspection)} ?? { id: 'c'.repeat(64), env: Object.entries(env).map(([k, v]) => k + '=' + v) }));
  process.exit(0);
}
let i = 1;
while (args[i].startsWith('-')) {
  const flag = args[i++];
  if (flag === '-e') { const key = args[i++]; env[key] = process.env[key]; }
  else if (flag === '-w') i++;
}
i++;
const child = spawnSync(args[i], args.slice(i + 1), { env, stdio: 'inherit' });
process.exit(child.status ?? 127);
`, { mode: 0o755 });
    const wrapper = materializeDockerExecWrapper({ ...target, binPath: process.execPath }, {
      dir, dockerBin: docker, dockerHost: '', guardClaudeEnv: guarded,
      forwardEnvPatterns: ['^ANTHROPIC_AUTH_TOKEN$', '^CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS$'],
    });
    const result = spawnSync(wrapper.wrapperPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: { ANTHROPIC_AUTH_TOKEN: 'ASSIGNMENT_TOKEN_SENTINEL', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
      encoding: 'utf8', timeout: 10_000,
    });
    return { result, args: JSON.parse(readFileSync(argvFile, 'utf8')) as string[] };
  }

  it.each(['CLAUDE_CODE_EXTRA_BODY', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', 'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_ENVIRONMENT_KIND', 'ENABLE_TOOL_SEARCH', 'NODE_OPTIONS', 'HTTPS_PROXY',
    'MAX_THINKING_TOKENS', 'FORCE_PROMPT_CACHING_5M', 'USE_API_CONTEXT_MANAGEMENT'])
  ('rejects an undeclared image control before the CLI starts (%s)', key => {
    const { result, args } = launch({ PATH: '/usr/bin:/bin', [key]: 'IMAGE_SECRET_SENTINEL' });
    expect(result.status, result.stderr).toBe(126);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(key);
    expect(result.stderr).not.toContain('IMAGE_SECRET_SENTINEL');
    expect(args.join(' ')).not.toContain('ASSIGNMENT_TOKEN_SENTINEL');
    expect(args[0]).toBe('inspect');
  });

  it('overrides declared image controls while preserving task tool environment and argument boundaries', () => {
    const { result, args } = launch({ PATH: '/task/tools:/usr/bin:/bin', VIRTUAL_ENV: '/task/venv', NODE_VERSION: '22',
      ANTHROPIC_AUTH_TOKEN: 'IMAGE_SECRET_SENTINEL', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ PATH: '/task/tools:/usr/bin:/bin', VIRTUAL_ENV: '/task/venv', NODE_VERSION: '22',
      ANTHROPIC_AUTH_TOKEN: 'ASSIGNMENT_TOKEN_SENTINEL', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' });
    expect(args.join(' ')).not.toContain('ASSIGNMENT_TOKEN_SENTINEL');
    expect(args).toContain('c'.repeat(64));
    expect(args).not.toContain(target.containerId);
  });

  it.each([{}, { id: 'replaced-container', env: [] }, { id: 'c'.repeat(64), env: null },
    { id: 'c'.repeat(64), env: ['not-an-env-assignment'] }])
  ('fails closed on unverifiable Docker inspection (%j)', inspection => {
    const { result, args } = launch({}, true, inspection);
    expect(result.status, result.stderr).toBe(126);
    expect(result.stdout).toBe('');
    expect(args[0]).toBe('inspect');
  });

  it('leaves the existing unguarded Codex wrapper environment behavior intact', () => {
    const { result } = launch({ PATH: '/usr/bin:/bin', CLAUDE_CODE_EXTRA_BODY: 'image-default' }, false);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).CLAUDE_CODE_EXTRA_BODY).toBe('image-default');
  });
});

describe('validateDockerExecTarget', () => {
  it.each([
    ['a shell-metacharacter container id', { containerId: 'abc;rm -rf /' }],
    ['an empty container id', { containerId: '' }],
    ['a relative workdir', { workdir: 'app' }],
    ['a relative binPath', { binPath: 'codex' }],
  ])('refuses %s', (_label, patch) => {
    expect(() => validateDockerExecTarget({ ...target, ...patch })).toThrow(/container exec target/);
  });

  it('accepts a docker id or name with an absolute workdir and binPath', () => {
    expect(() => validateDockerExecTarget(target)).not.toThrow();
    expect(() => validateDockerExecTarget({ ...target, containerId: 'fswe-task_1.run-2' })).not.toThrow();
  });
});

describe('materializeDockerExecWrapper', () => {
  it.each([undefined, 'unix:///run/other-docker.sock'])(
    'retains the selected daemon when the native child receives DOCKER_HOST=%s', runtimeHost => {
      const previous = process.env.DOCKER_HOST;
      const selected = 'unix:///run/docker-bench.sock';
      let wrapperPath: string;
      try {
        process.env.DOCKER_HOST = selected;
        ({ wrapperPath } = materializeDockerExecWrapper(target,
          { dir: mkdtempSync(join(root, 'daemon-')), dockerBin: fakeDocker }));
      } finally {
        if (previous === undefined) delete process.env.DOCKER_HOST;
        else process.env.DOCKER_HOST = previous;
      }
      const r = spawnSync(wrapperPath, [], {
        env: { PATH: '/usr/bin:/bin', ...(runtimeHost ? { DOCKER_HOST: runtimeHost } : {}) }, encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      const argv = readFileSync(argvLog, 'utf8').trimEnd().split('\n');
      expect(argv.slice(0, 3)).toEqual(['--host', selected, 'exec']);
      expect(argv).not.toContain('DOCKER_HOST');
      expect(argv).not.toContain(runtimeHost);
    },
  );

  it.runIf(process.platform === 'linux')('rejects an explicit device-namespace directory and its symlink alias', () => {
    const alias = join(root, 'device-temp');
    symlinkSync('/dev/shm', alias);
    for (const dir of ['/dev/shm', alias])
      expect(() => materializeDockerExecWrapper(target, { dir })).toThrow('masked by the native device namespace');
  });

  it('writes an executable named after the agent, so psu still applies --no-daemon', () => {
    const { wrapperPath } = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(root, 'm-')) });
    expect(basename(wrapperPath)).toBe('codex');
    expect(statSync(wrapperPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(wrapperPath, 'utf8').startsWith('#!')).toBe(true);
  });

  it('renders deterministically for the same inputs', () => {
    expect(renderDockerExecWrapper(target, { nodeBin: '/usr/bin/node' })).toBe(
      renderDockerExecWrapper(target, { nodeBin: '/usr/bin/node' }),
    );
  });
});

describe('the generated wrapper, executed', () => {
  const env = {
    CODEX_HOME: '/home/u/.papercusp/codex-homes/s1',
    OPENAI_BASE_URL: 'http://gateway.invalid/v1',
    PAPERCUSP_TOKEN: 'secret-token-value',
    PAPERCUSP_BACKEND_BIN_CODEX: '/tmp/papercusp-cexec-x/codex',
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    UNRELATED_SECRET: 'do-not-forward',
  };

  it('execs the container CLI in the workdir, forwarding allowlisted env by NAME only', () => {
    const { r, argv } = runWrapper(['exec', '--json', 'two words'], env);
    expect(r.status).toBe(0);
    expect(argv).toEqual([
      'exec',
      '-i',
      '-w',
      '/app',
      '-e',
      'CODEX_HOME',
      '-e',
      'OPENAI_BASE_URL',
      '-e',
      'PAPERCUSP_TOKEN',
      target.containerId,
      CONTAINER_CODEX_BIN_PATH,
      'exec',
      '--json',
      'two words',
    ]);
    // Values never reach argv; docker reads them from the inherited environment.
    expect(argv).not.toContain('secret-token-value');
    expect(readFileSync(envLog, 'utf8').split('\n').slice(0, 2)).toEqual([env.CODEX_HOME, env.PAPERCUSP_TOKEN]);
  });

  it('never forwards PATH, HOME, the override key, or non-allowlisted names', () => {
    const { argv } = runWrapper([], env);
    for (const name of ['PATH', 'HOME', 'PAPERCUSP_BACKEND_BIN_CODEX', 'UNRELATED_SECRET']) {
      expect(argv).not.toContain(name);
    }
  });

  it('does not request a TTY when stdin is a pipe', () => {
    const { argv } = runWrapper([], env);
    expect(argv).not.toContain('-t');
  });

  it("exits with the container CLI's exit code", () => {
    const { r } = runWrapper(['exec'], { ...env, FAKE_DOCKER_EXIT: '7' });
    expect(r.status).toBe(7);
  });

  it('exits 127 with a diagnosis when docker cannot be run', () => {
    const { wrapperPath } = materializeDockerExecWrapper(target, {
      dir: mkdtempSync(join(root, 'nod-')),
      dockerBin: join(root, 'no-such-docker'),
    });
    const r = spawnSync(wrapperPath, [], { env, encoding: 'utf8' });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/papercusp container-exec: cannot run/);
  });
});

describe('session-dir relocation (D-026 step 3)', () => {
  function layout(workdir = target.workdir, binPath = target.binPath) {
    const base = mkdtempSync(join(root, 'reloc-'));
    const homes = join(base, 'su-codex-homes'), sqlite = join(base, 'codex-sqlite-homes');
    const perHomes = join(base, 'task-homes'), perSqlite = join(base, 'task-sqlite');
    mkdirSync(join(homes, 'session-7'), { recursive: true });
    writeFileSync(join(homes, 'session-7', 'config.toml'), 'model = "x"\n');
    mkdirSync(join(homes, 'session-8'), { recursive: true });
    const relocated: DockerExecTarget = { ...target, workdir, binPath, sessionRelocation: { sessionEnv: 'CODEX_HOME',
      roots: [{ hostRoot: homes, perTaskDir: perHomes }, { hostRoot: sqlite, perTaskDir: perSqlite }] } };
    const run = (home: string) => {
      const { wrapperPath } = materializeDockerExecWrapper(relocated, { dir: mkdtempSync(join(root, 'rw-')), dockerBin: fakeDocker });
      return spawnSync(wrapperPath, ['--version'], { env: { CODEX_HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    };
    return { homes, sqlite, perHomes, perSqlite, run };
  }

  it.each(['/app', '/task.dir/project "quoted"'])('trusts only the in-container workdir %s for relocated Codex', workdir => {
    const l = layout(workdir);
    const home = join(l.homes, 'session-7');
    const config = 'model = "x"\n[projects."/observer-checkout"]\ntrust_level = "trusted"\n';
    rmSync(join(home, 'config.toml'));
    writeFileSync(join(home, 'config.toml'), config, { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(l.run(home).status).toBe(0);
      const argv = readFileSync(argvLog, 'utf8').trimEnd().split('\n');
      expect(argv.slice(argv.indexOf(CONTAINER_CODEX_BIN_PATH) + 1)).toEqual([
        '-c', `projects={${JSON.stringify(workdir)}={trust_level="trusted"}}`, '--version',
      ]);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
      expect(statSync(join(home, 'config.toml')).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps generic container probe arguments unchanged during relocation', () => {
    const l = layout('/app', '/bin/sh');
    expect(l.run(join(l.homes, 'session-7')).status).toBe(0);
    const argv = readFileSync(argvLog, 'utf8').trimEnd().split('\n');
    expect(argv.slice(argv.indexOf('/bin/sh') + 1)).toEqual(['--version']);
  });
  it.each(['returned', 'fresh', 'daemon-refused', 'foreign-link', 'foreign-home'])(
    'returns only exact relocated session ownership and fails closed: %s', mode => {
    const l = layout(), home = join(l.homes, 'session-7');
    if (mode !== 'fresh') expect(l.run(home).status).toBe(0);
    rmSync(argvLog, { force: true });
    if (mode === 'foreign-link') {
      rmSync(home);
      symlinkSync(join(l.homes, 'session-8'), home);
    }
    const { wrapperPath } = materializeDockerExecWrapper({ ...target,
      sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [
        { hostRoot: l.homes, perTaskDir: l.perHomes }, { hostRoot: l.sqlite, perTaskDir: l.perSqlite },
      ] } }, { dir: mkdtempSync(join(root, 'ownership-')), dockerBin: fakeDocker });
    const result = spawnSync(wrapperPath, ['--papercusp-return-session-ownership'], {
      env: { PATH: '/usr/bin:/bin', CODEX_HOME: mode === 'foreign-home' ? join(l.homes, 'nested', 'session-7') : home,
        ...(mode === 'daemon-refused' ? { FAKE_DOCKER_EXIT: '7' } : {}) }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(mode === 'returned' || mode === 'fresh' ? 0 : 126);
    if (mode === 'returned' || mode === 'daemon-refused') {
      expect(readFileSync(argvLog, 'utf8').trimEnd().split('\n')).toEqual([
        'exec', '-u', '0', target.containerId, 'chown', '-hR', `${process.getuid!()}:${process.getgid!()}`,
        home, join(l.sqlite, 'session-7'),
      ]);
    } else expect(existsSync(argvLog)).toBe(false);
  });

  it('moves the session home into the per-task dir, leaves a host symlink, and pre-creates the SQLite home', () => {
    const l = layout();
    const r = l.run(join(l.homes, 'session-7'));
    expect(r.status).toBe(0);
    expect(lstatSync(join(l.homes, 'session-7')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(l.homes, 'session-7', 'config.toml'), 'utf8')).toBe('model = "x"\n');
    expect(readFileSync(join(l.perHomes, 'session-7', 'config.toml'), 'utf8')).toBe('model = "x"\n');
    expect(lstatSync(join(l.sqlite, 'session-7')).isSymbolicLink()).toBe(true);
    expect(statSync(join(l.perSqlite, 'session-7')).isDirectory()).toBe(true);
    // Other sessions under the shared root are never touched, so the container cannot see them.
    expect(lstatSync(join(l.homes, 'session-8')).isDirectory()).toBe(true);
    expect(existsSync(join(l.perHomes, 'session-8'))).toBe(false);
    // CODEX_HOME still crosses by name and still names the host path the mount stands in for.
    expect(readFileSync(envLog, 'utf8').split('\n')[0]).toBe(join(l.homes, 'session-7'));
  });

  it('is idempotent on resume: an existing symlink to the per-task dir is reused', () => {
    const l = layout();
    expect(l.run(join(l.homes, 'session-7')).status).toBe(0);
    const r = l.run(join(l.homes, 'session-7'));
    expect(r.status).toBe(0);
    expect(readFileSync(join(l.homes, 'session-7', 'config.toml'), 'utf8')).toBe('model = "x"\n');
  });

  it('fails closed (126) instead of running when the session dir cannot be placed', () => {
    const l = layout();
    const outside = l.run(join(root, 'elsewhere', 'session-7'));
    expect(outside.status).toBe(126);
    expect(outside.stderr).toMatch(/is not directly under/);
    // A foreign symlink at the session path is never followed or replaced.
    symlinkSync(join(root), join(l.homes, 'session-9'));
    const foreign = l.run(join(l.homes, 'session-9'));
    expect(foreign.status).toBe(126);
    expect(foreign.stderr).toMatch(/symlink to somewhere other than/);
    // An occupied per-task dir is never merged into.
    mkdirSync(join(l.perHomes, 'session-8'), { recursive: true });
    const occupied = l.run(join(l.homes, 'session-8'));
    expect(occupied.status).toBe(126);
    expect(occupied.stderr).toMatch(/already exists/);
    expect(lstatSync(join(l.homes, 'session-8')).isDirectory()).toBe(true);
  });

  it('refuses a relocation whose per-task dir overlaps its shared root', () => {
    expect(() => validateDockerExecTarget({ ...target, sessionRelocation: { sessionEnv: 'CODEX_HOME',
      roots: [{ hostRoot: '/h/roots', perTaskDir: '/h/roots/task-1' }] } })).toThrow(/disjoint/);
    expect(() => validateDockerExecTarget({ ...target, sessionRelocation: { sessionEnv: 'codex home', roots: [] } }))
      .toThrow(/not an env name/);
  });
});

describe('config origin rewrite (D-033 step 2)', () => {
  it.each([true, false])('rewrites only the isolated Claude gateway and refuses an unmapped origin (mapped=%s)', mapped => {
    const base = mkdtempSync(join(root, 'claude-origin-')), homes = join(base, 'homes');
    const home = join(homes, 'claude-session'); mkdirSync(home, { recursive: true });
    const log = join(base, 'docker.json'), docker = join(base, 'docker');
    writeFileSync(docker, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({args: process.argv.slice(2), env: process.env}));\n`, { mode: 0o755 });
    const { wrapperPath } = materializeDockerExecWrapper({ ...target, binPath: '/opt/claude',
      sessionRelocation: { sessionEnv: 'CLAUDE_CONFIG_DIR', roots: [{ hostRoot: homes, perTaskDir: join(base, 'task-homes') }] },
      originRewrites: mapped ? [{ from: 'http://127.0.0.1:32001', to: 'http://egress:8788' }] : [] },
      { dir: mkdtempSync(join(base, 'wrapper-')), dockerBin: docker, dockerHost: '',
        forwardEnvPatterns: ['^CLAUDE_CONFIG_DIR$', '^ANTHROPIC_(BASE_URL|AUTH_TOKEN)$'] });
    const result = spawnSync(wrapperPath, ['-p'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:32001', ANTHROPIC_AUTH_TOKEN: 'secret-test-token' } });
    expect(result.status, result.stderr).toBe(mapped ? 0 : 126);
    if (mapped) {
      const observed = JSON.parse(readFileSync(log, 'utf8'));
      expect(observed.env.ANTHROPIC_BASE_URL).toBe('http://egress:8788');
      expect(observed.env.ANTHROPIC_AUTH_TOKEN).toBe('secret-test-token');
      expect(observed.args).toContain('CLAUDE_CONFIG_DIR');
      expect(observed.args).not.toContain('secret-test-token');
    } else { expect(existsSync(log)).toBe(false); expect(result.stderr).toMatch(/loopback origin/); }
  });

  const GW = 'http://papercusp-egress:41001', MCP = 'http://papercusp-egress:41002';
  const config = [
    '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
    '# a commented http://127.0.0.1:1 is never dialed, so it never refuses',
    'model_provider = "papercusp-codex-gateway"',
    '[model_providers.papercusp-codex-gateway]',
    'base_url = "http://127.0.0.1:32101/v1"',
    'model_catalog_url = "http://127.0.0.1:32101/v1/models"',
    '[mcp_servers.papercusp-su]',
    'url = "http://127.0.0.1:9071/api/mcp?client=su-x&sig=abc"',
    '[mcp_servers.remote]',
    'url = "http://localhost.example.com:8080/mcp"',
    '',
  ].join('\n');
  const rewritten = config
    .replace('base_url = "http://127.0.0.1:32101/v1"', `base_url = "${GW}/v1"`)
    .replace('model_catalog_url = "http://127.0.0.1:32101/v1/models"', `model_catalog_url = "${GW}/v1/models"`)
    .replace('url = "http://127.0.0.1:9071/api/mcp', `url = "${MCP}/api/mcp`);
  const maps = [{ from: 'http://127.0.0.1:32101', to: GW }, { from: 'http://127.0.0.1:9071', to: MCP }];

  function setup(text: string | null, originRewrites: DockerExecTarget['originRewrites']) {
    const base = mkdtempSync(join(root, 'orig-'));
    const homes = join(base, 'homes'), perHomes = join(base, 'task-homes');
    const home = join(homes, 'session-5');
    mkdirSync(home, { recursive: true });
    const file = join(home, 'config.toml');
    if (text !== null) writeFileSync(file, text, { mode: 0o600 });
    const t: DockerExecTarget = { ...target, originRewrites,
      sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perHomes }] } };
    const run = () => {
      rmSync(argvLog, { force: true });
      const { wrapperPath } = materializeDockerExecWrapper(t, { dir: mkdtempSync(join(root, 'ow-')), dockerBin: fakeDocker });
      const r = spawnSync(wrapperPath, ['exec', 'go'], { env: { CODEX_HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      return { r, dockerRan: existsSync(argvLog) };
    };
    return { file, run };
  }

  it('maps every gateway and MCP origin to its egress origin, keeps the file mode, and then runs the agent', () => {
    const s = setup(config, maps);
    const { r, dockerRan } = s.run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(dockerRan).toBe(true);
    expect(readFileSync(s.file, 'utf8')).toBe(rewritten);
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
  });

  it('is idempotent on resume: an already-rewritten config runs unchanged', () => {
    const s = setup(config, maps);
    expect(s.run().r.status).toBe(0);
    const again = s.run();
    expect(again.r.status).toBe(0);
    expect(again.dockerRan).toBe(true);
    expect(readFileSync(s.file, 'utf8')).toBe(rewritten);
  });

  it('matches whole origins only: a shorter port never rewrites inside a longer one, and the leftover refuses', () => {
    const s = setup(config, [{ from: 'http://127.0.0.1:3210', to: GW }, { from: 'http://127.0.0.1:9071', to: MCP }]);
    const { r, dockerRan } = s.run();
    expect(r.status).toBe(126);
    expect(dockerRan).toBe(false);
    expect(r.stderr).toContain('http://127.0.0.1:32101');
    expect(r.stderr).not.toContain('sig=abc');
    // Refused before writing: the operator's file is exactly as it was.
    expect(readFileSync(s.file, 'utf8')).toBe(config);
  });

  it.each([
    ['an unmapped 127.0.0.1 port', 'url = "http://127.0.0.1:3070/api"'],
    ['localhost', 'url = "http://LOCALHOST:8788/v1"'],
    ['another 127/8 address', 'url = "http://127.0.0.2:80"'],
    ['IPv6 loopback', 'url = "http://[::1]:9071/x"'],
    ['https on loopback', 'url = "https://127.0.0.1:443"'],
    ['a portless loopback origin', 'url = "http://localhost/v1"'],
  ])('fails closed (126) on %s left in the config', (_label, line) => {
    const s = setup(`${line}\n`, maps);
    const { r, dockerRan } = s.run();
    expect(r.status).toBe(126);
    expect(dockerRan).toBe(false);
    expect(r.stderr).toMatch(/still names loopback origin/);
  });

  it('rewrites in one pass, so one mapping never chains into another', () => {
    const s = setup('a = "http://a.test:1/x"\nb = "http://b.test:2/y"\n',
      [{ from: 'http://a.test:1', to: 'http://b.test:2' }, { from: 'http://b.test:2', to: 'http://c.test:3' }]);
    expect(s.run().r.status).toBe(0);
    expect(readFileSync(s.file, 'utf8')).toBe('a = "http://b.test:2/x"\nb = "http://c.test:3/y"\n');
  });

  it('with an empty mapping list still runs the loopback check', () => {
    expect(setup(config, []).run().r.status).toBe(126);
    expect(setup('model = "x"\n', []).run().r.status).toBe(0);
  });

  it('fails closed (126) when the session has no config.toml to rewrite', () => {
    const { r, dockerRan } = setup(null, maps).run();
    expect(r.status).toBe(126);
    expect(dockerRan).toBe(false);
    expect(r.stderr).toMatch(/cannot read .*config\.toml/);
  });

  it('refuses targets it could not rewrite safely', () => {
    const reloc = { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: '/h/homes', perTaskDir: '/h/task' }] };
    expect(() => validateDockerExecTarget({ ...target, originRewrites: maps })).toThrow(/requires sessionRelocation/);
    expect(() => validateDockerExecTarget({ ...target, sessionRelocation: reloc,
      originRewrites: [{ from: 'http://127.0.0.1:9071', to: 'http://127.0.0.1:41002' }] })).toThrow(/loopback origin/);
    expect(() => validateDockerExecTarget({ ...target, sessionRelocation: reloc,
      originRewrites: [{ from: 'http://127.0.0.1:9071/api', to: MCP }] })).toThrow(/not scheme:\/\/host:port/);
    expect(() => validateDockerExecTarget({ ...target, sessionRelocation: reloc,
      originRewrites: [{ from: 'http://127.0.0.1:9071', to: MCP }, { from: 'http://127.0.0.1:9071', to: GW }] })).toThrow(/twice/);
    expect(() => validateDockerExecTarget({ ...target, sessionRelocation: reloc, originRewrites: maps })).not.toThrow();
  });
});
