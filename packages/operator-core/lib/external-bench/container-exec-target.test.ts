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
        '-c', `projects.${JSON.stringify(workdir)}.trust_level="trusted"`, '--version',
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
