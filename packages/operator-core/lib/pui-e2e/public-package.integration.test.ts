/**
 * Public PUI package E2E (pui-first-party-public-release P-011 / D-016).
 *
 *   two committed generations -> apps/tui/scripts/package-release.sh -> real .tar.gz
 *   -> ./install.sh in an ISOLATED HOME whose PATH holds no cargo, python or git
 *   -> the installed `pui self update|rollback|uninstall` and `pui doctor`
 *
 * Nothing is a fixture: both archives are real release builds, every assertion
 * reads the installed product, and each oracle is computed independently of the
 * code under test (git rev-parse, node's sha256, readelf/objdump).
 *
 * To verify an existing accepted generation with a newer committed test harness,
 * set PUI_PUBLIC_PACKAGE_ARCHIVE, PUI_PUBLIC_PACKAGE_SOURCE_SHA (full commit),
 * and PUI_PUBLIC_PACKAGE_ARCHIVE_SHA256. The archive becomes B after preflight;
 * A still builds its predecessor, and reproducibility still cold-builds B.
 *
 * "No operator" is modelled by pointing the default-port selector at a port
 * nothing listens on, so the dev box's own operator on :3070 cannot answer and
 * no working endpoint is injected. zellij gets a private socket dir so the
 * owner's live sessions are invisible to the sandboxed doctor.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawn as ptySpawn } from '@lydell/node-pty';
import { WebSocketServer } from 'ws';
import { VtScreen } from './vt-screen';
import { hostedForwardInput } from '../../../../apps/operator/scripts/psu-connection-front-controller.mjs';
import { assertPackageBuildDependencies, loadPinnedPackageCandidate, readPackageBuildLock, type PackageResult } from './public-package-candidate';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACKAGER = path.join(REPO_ROOT, 'apps/tui/scripts/package-release.sh');
const TARGET = 'linux-x86_64';
const BUILD_TIMEOUT_MS = 40 * 60_000;
const RELEASE_TOOLING = [
  'apps/tui/src/self_install.rs',
  'apps/tui/release/install.sh',
  'apps/tui/scripts/package-release.sh',
  'apps/tui/scripts/license-inventory.py',
  // D-031 / P-018: psu on a private Node is part of every generation the packager builds.
  'apps/tui/scripts/bundle-psu.mjs',
  'apps/tui/release/psu',
];
/** The only tools the sandboxed PATH offers: what install.sh and an archive update need. */
// `readlink` lets the shipped psu wrapper follow the ~/.local/bin/psu link to its unit.
const SANDBOX_TOOLS = ['sh', 'dirname', 'readlink', 'sha256sum', 'tar', 'gzip'];
/** Seeded into the PACKAGER's own environment: none may reach any byte of an archive. */
const PACKAGING_SECRETS = {
  PAPERCUSP_API_TOKEN: 'P011-PACKAGING-API-TOKEN',
  PUI_OPERATOR_TOKEN: 'P011-PACKAGING-OPERATOR-TOKEN',
  PUI_SETUP_DRAFT: 'P011-PACKAGING-PRIVATE-DRAFT',
};

interface Provenance {
  version: string;
  target: string;
  source: { commit: string; trees: Record<string, string> };
  runtime: { glibcFloor: string | null; sharedLibraries: string[] };
}

const git = (...args: string[]) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const output = (run: SpawnSyncReturns<string>) => `status=${run.status}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;

function packageAt(sha: string, out: string, targetDir?: string): PackageResult {
  const run = spawnSync(PACKAGER, ['--target', TARGET, '--sha', sha, '--out', out], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...PACKAGING_SECRETS, ...(targetDir ? { PUI_PACKAGE_TARGET_DIR: targetDir } : {}) },
  });
  const line = run.stdout?.split('\n').find((candidate) => candidate.startsWith('PUI_PACKAGE_RESULT '));
  if (run.status !== 0 || !line) {
    throw new Error(`package-release.sh --sha ${sha} failed:\n${output(run).slice(-8_000)}`);
  }
  return JSON.parse(line.slice('PUI_PACKAGE_RESULT '.length)) as PackageResult;
}

/** The newest commit before `head` that already carries the release tooling: a second committed generation. */
function previousGeneration(head: string): string {
  for (const sha of git('rev-list', '--max-count=400', `${head}~1`).split('\n')) {
    const complete = RELEASE_TOOLING.every(
      (file) => spawnSync('git', ['-C', REPO_ROOT, 'cat-file', '-e', `${sha}:${file}`]).status === 0,
    );
    if (complete) return sha;
  }
  throw new Error(`no commit before ${head} carries the release tooling; two committed generations are required`);
}

/**
 * Mutation-probe seam (WI-10003500). The packager reads only committed git, so a
 * copy-out mutant can reach an archive only as a commit. With
 * PUI_PUBLIC_PACKAGE_SUBJECT (a file, `{}` in scripts/mutation-probe.sh) and
 * PUI_PUBLIC_PACKAGE_SUBJECT_PATH (the repo-relative path it stands in for), the
 * suite packages a SIBLING of `head`: same parents, same dates, same tree except
 * that one blob. It is written through a private index as a dangling commit, so
 * no ref, the shared index and the worktree are all untouched. Unset, `head` is
 * returned unchanged.
 */
function subjectGeneration(head: string, work: string): string {
  const subject = process.env.PUI_PUBLIC_PACKAGE_SUBJECT;
  if (!subject) return head;
  const subjectPath = process.env.PUI_PUBLIC_PACKAGE_SUBJECT_PATH;
  if (!subjectPath) {
    throw new Error('PUI_PUBLIC_PACKAGE_SUBJECT needs PUI_PUBLIC_PACKAGE_SUBJECT_PATH (the repo-relative path it replaces)');
  }
  const mode = git('ls-tree', head, '--', subjectPath).split(/\s/)[0];
  if (!/^100(644|755)$/.test(mode ?? '')) throw new Error(`${subjectPath} is not a regular file in ${head}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: path.join(work, 'subject-generation.index'),
    GIT_AUTHOR_NAME: 'pui mutation probe', GIT_AUTHOR_EMAIL: 'probe@papercusp.invalid',
    GIT_COMMITTER_NAME: 'pui mutation probe', GIT_COMMITTER_EMAIL: 'probe@papercusp.invalid',
    GIT_AUTHOR_DATE: git('show', '-s', '--format=%aI', head),
    GIT_COMMITTER_DATE: git('show', '-s', '--format=%cI', head),
  };
  const scoped = (...args: string[]) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', env }).trim();
  scoped('read-tree', head);
  const blob = scoped('hash-object', '-w', path.resolve(subject));
  scoped('update-index', '--cacheinfo', `${mode},${blob},${subjectPath}`);
  const parents = git('rev-parse', `${head}^@`).split('\n').filter(Boolean).flatMap((parent) => ['-p', parent]);
  return scoped('commit-tree', scoped('write-tree'), ...parents, '-m', `pui mutation-probe subject ${subjectPath}`);
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('could not reserve a port');
  return address.port;
}

let WORK = '';
let TOOLS = '';
let NO_OPERATOR_PORT = 0;
let A: PackageResult;
let B: PackageResult;
let HEAD = '';

function freshHome(label: string): string {
  const home = path.join(WORK, 'homes', label);
  mkdirSync(path.join(home, 'tmp'), { recursive: true });
  return home;
}

function sandboxEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: `${path.join(home, '.local', 'bin')}:${TOOLS}`,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: path.join(home, 'tmp'),
    PAPERCUSP_HONO_PORT: String(NO_OPERATOR_PORT),
    ZELLIJ_SOCKET_DIR: path.join(home, 'tmp', 'zellij'),
    ...extra,
  };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, input = ''): SpawnSyncReturns<string> {
  // `input` makes stdin a pipe, never a TTY: a confirmation cannot be implied.
  return spawnSync(command, args, { env, cwd, input, encoding: 'utf8', timeout: 180_000 });
}

function unpack(archive: string, label: string): string {
  const dir = path.join(WORK, 'unpacked', label);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  const [unit] = readdirSync(dir);
  return path.join(dir, unit);
}

function stamp(launcher: string, env: NodeJS.ProcessEnv, cwd: string): { sourceSha: string; version: string } {
  const result = run(launcher, ['self', 'stamp'], env, cwd);
  expect(result.status, output(result)).toBe(0);
  return JSON.parse(result.stdout) as { sourceSha: string; version: string };
}

function statusJson(launcher: string, env: NodeJS.ProcessEnv, cwd: string) {
  const result = run(launcher, ['self', 'status', '--json'], env, cwd);
  expect(result.status, output(result)).toBe(0);
  return JSON.parse(result.stdout) as {
    current: { id: string; problem: string | null } | null;
    previous: { id: string } | null;
  };
}

const releaseId = (pkg: PackageResult) => `${pkg.version}-${pkg.sourceSha.slice(0, 12)}`;

const CLOUD_USER_CODE = 'BCDF-GHJK';
const CLOUD_TOKEN = `pct_${'c'.repeat(43)}`;
const CLOUD_TICKET = `ht_${'f'.repeat(43)}`;
const CLOUD_WORKSPACE = 'ws-first-run';
const REMOTE_MARKER = 'FIRST-RUN REMOTE PUI';

/**
 * A stand-in for the Papercusp cloud portal and its connector relay (D-031):
 * RFC 8628 device sign-in, the CLI workspace API, and one workspace terminal
 * that answers the program psu starts there with a marker and exit 0. It
 * records what it was asked so the test can prove the sign-in and hand-off.
 */
async function startCloudStub() {
  const calls: Array<{ method: string; path: string; authorization?: string }> = [];
  const remoteInput: string[] = [];
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://cloud.test');
    calls.push({ method: req.method ?? 'GET', path: url.pathname, authorization: req.headers.authorization });
    const json = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    if (url.pathname === '/api/hosted/cli/device/code' && req.method === 'POST') {
      return json(200, {
        ok: true, deviceCode: `pdc_${'d'.repeat(43)}`, userCode: CLOUD_USER_CODE,
        verificationUri: `${origin}/api/hosted/cli/device`,
        verificationUriComplete: `${origin}/api/hosted/cli/device?user_code=${CLOUD_USER_CODE}`,
        expiresIn: 600, interval: 1,
      });
    }
    if (url.pathname === '/api/hosted/cli/device/token' && req.method === 'POST') {
      return json(200, {
        ok: true, accessToken: CLOUD_TOKEN, tokenId: 'hct_first-run', organizationId: 'org-first-run',
        userId: 'user_first_run', expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    if (req.headers.authorization !== `Bearer ${CLOUD_TOKEN}`) return json(401, { ok: false, error: { code: 'cli_token_invalid' } });
    if (url.pathname === '/api/hosted/cli/workspaces') {
      return json(200, { ok: true, workspaces: [{ id: CLOUD_WORKSPACE, displayName: 'first-run', state: 'active', reachable: true }] });
    }
    if (url.pathname === `/api/hosted/cli/workspaces/${CLOUD_WORKSPACE}/terminal` && req.method === 'POST') {
      return json(200, { ok: true, session: 'first-run-session', socketUrl: `wss://portal.invalid/api/hosted/connectors/socket?ticket=${CLOUD_TICKET}` });
    }
    return json(404, { ok: false, error: { code: 'not_found' } });
  });
  const relay = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://cloud.test');
    if (url.pathname !== '/api/hosted/connectors/socket' || url.searchParams.get('ticket') !== CLOUD_TICKET) {
      socket.destroy();
      return;
    }
    relay.handleUpgrade(req, socket, head, (ws) => {
      const send = (message: object) => ws.send(JSON.stringify(message));
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; data?: string };
        if (message.type !== 'pty.input' || !message.data) return;
        remoteInput.push(Buffer.from(message.data, 'base64').toString('utf8'));
        if (!remoteInput.join('').includes('\r')) return;
        send({ type: 'pty.output', data: Buffer.from(`${REMOTE_MARKER}\r\n`).toString('base64') });
        send({ type: 'pty.exit', code: 0, signal: 0 });
        setTimeout(() => ws.close(), 200);
      });
      send({ type: 'session.bound', role: 'controller' });
      send({ type: 'pty.ready', role: 'controller', resumed: false });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    calls,
    remoteInput,
    close: () => new Promise<void>((resolve) => {
      relay.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** An installed PUI under a real PTY: the screen as a user sees it, and its exit. */
function ptyRun(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const cols = 100;
  const rows = 30;
  let raw = '';
  const term = ptySpawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: env as Record<string, string> });
  const exited = new Promise<{ exitCode: number }>((resolve) => term.onExit(resolve));
  term.onData((chunk) => {
    raw += chunk;
    // Answer PUI's device-attributes probe as a real terminal would.
    if (/\u001b\[0?c/.test(chunk)) term.write('\u001b[?62;22c');
  });
  const screen = () => {
    const vt = new VtScreen(rows, cols);
    vt.feed(raw);
    return vt.text();
  };
  return {
    write: (data: string) => term.write(data),
    screen,
    raw: () => raw,
    exited,
    kill: () => {
      try { term.kill(); } catch { /* already exited */ }
    },
    /** Wait until the screen shows `needle` — or, with `sinceRaw`, until the
     * output after that offset carried it (text a later screen may scroll away). */
    async waitFor(needle: string, { sinceRaw, timeoutMs = 60_000 }: { sinceRaw?: number; timeoutMs?: number } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (!screen().includes(needle) && !(sinceRaw !== undefined && raw.slice(sinceRaw).includes(needle))) {
        if (Date.now() > deadline) throw new Error(`waited ${timeoutMs} ms for ${JSON.stringify(needle)}; screen:\n${screen()}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

beforeAll(async () => {
  WORK = mkdtempSync(path.join(tmpdir(), 'pui-public-package-'));
  // A repaired committed harness can prove an already accepted product without
  // replacing it with that harness's HEAD. Pins fail before either costly build.
  const pinned = loadPinnedPackageCandidate(process.env, path.join(WORK, 'dist-b'), TARGET);
  HEAD = pinned?.sourceSha ?? subjectGeneration(git('rev-parse', 'HEAD'), WORK);
  if (pinned) {
    expect(git('rev-parse', '--verify', `${HEAD}^{commit}`)).toBe(HEAD);
    expect(/^version = "([^"]+)"$/m.exec(git('show', `${HEAD}:apps/tui/Cargo.toml`))?.[1]).toBe(pinned.version);
    console.log(`PUI_PUBLIC_PACKAGE_CANDIDATE ${JSON.stringify({ harnessSha: git('rev-parse', 'HEAD'), ...pinned })}`);
  }
  TOOLS = path.join(WORK, 'tools');
  mkdirSync(TOOLS);
  for (const tool of SANDBOX_TOOLS) {
    symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(TOOLS, tool));
  }
  NO_OPERATOR_PORT = await closedPort();
  const previous = previousGeneration(HEAD);
  for (const sha of [previous, HEAD]) {
    assertPackageBuildDependencies(REPO_ROOT, readPackageBuildLock(REPO_ROOT, sha));
  }
  A = packageAt(previous, path.join(WORK, 'dist-a'));
  B = pinned ?? packageAt(HEAD, path.join(WORK, 'dist-b'));
}, 2 * BUILD_TIMEOUT_MS);

afterAll(() => {
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

describe.sequential('public PUI package (committed source, isolated HOME, no cargo/python/git)', () => {
  test('AUTO-BAR-R-08-P-011: a clean HOME installs and runs PUI with no checkout, cargo, python, git, dotfiles or operator', { timeout: 300_000 }, () => {
    const home = freshHome('clean');
    const env = sandboxEnv(home);
    // Positive control first: the sandbox really lacks the developer toolchain
    // and really has the shell the installer needs.
    for (const absent of ['cargo', 'python3', 'python', 'git', 'zellij']) {
      expect(run('sh', ['-c', `command -v ${absent}`], env, home).status, absent).not.toBe(0);
    }
    expect(run('sh', ['-c', 'command -v sha256sum'], env, home).status).toBe(0);
    expect(readdirSync(home)).toEqual(['tmp']);

    const unit = unpack(B.archive, 'clean');
    const installed = run(path.join(unit, 'install.sh'), ['--yes'], env, home);

    expect(installed.status, output(installed)).toBe(0);
    const text = `${installed.stdout}\n${installed.stderr}`;
    expect(text).toContain('PUI local install: OK');
    // The missing backend is explained and checked in-product, naming the
    // endpoint it tried, instead of a silent or developer-only failure.
    expect(text).toContain(`127.0.0.1:${NO_OPERATOR_PORT}`);
    expect(text).toMatch(/repair:/);
    expect(text).not.toContain('install-update.sh');
    expect(text).not.toContain('apps/tui/');

    const launcher = path.join(home, '.local', 'bin', 'pui');
    expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
    expect(readlinkSync(launcher)).toBe(path.join(home, '.local', 'share', 'pui', 'current', 'bin', 'pui'));
    const version = run(launcher, ['--version'], env, home);
    expect(version.status, output(version)).toBe(0);
    // The packaged CLI identifies its committed source as well as its version.
    expect(version.stdout.trim()).toBe(`pui ${B.version} (${B.sourceSha.slice(0, 10)})`);
    expect(stamp(launcher, env, home).sourceSha).toBe(HEAD);
    expect(statusJson(launcher, env, home).current).toMatchObject({ id: releaseId(B), problem: null });
  });

  test('AUTO-BAR-R-08-P-018: the archive ships psu on its own pinned Node — it runs in a HOME with no node, npm or checkout', { timeout: 300_000 }, () => {
    const home = freshHome('psu');
    const env = sandboxEnv(home);
    // Positive control: the sandbox really has no Node toolchain of its own.
    for (const absent of ['node', 'npm', 'npx']) {
      expect(run('sh', ['-c', `command -v ${absent}`], env, home).status, absent).not.toBe(0);
    }
    const unit = unpack(B.archive, 'psu');
    const provenance = JSON.parse(readFileSync(path.join(unit, 'PROVENANCE.json'), 'utf8')) as {
      bundled: {
        node: { version: string; sha256: string };
        psu: { sourcePins: Record<string, string>; outputs: Record<string, string>; npmPackages: string[] };
      };
    };
    const psu = path.join(unit, 'bin', 'psu');
    const help = run(psu, ['--help'], env, home);
    expect(help.status, output(help)).toBe(0);
    expect(help.stdout).toContain('--connect-login');
    const hosts = run(psu, ['--connect-list'], env, home);
    expect(hosts.status, output(hosts)).toBe(0);
    expect(hosts.stdout).toContain('local');

    // Independent oracles: the private Node reports the pinned version, the bundle
    // and native artifacts hash to what PROVENANCE names, and psu was built from HEAD.
    const node = path.join(unit, 'lib', 'node', 'node');
    const version = run(node, ['--version'], env, home);
    expect(version.stdout.trim(), output(version)).toBe(provenance.bundled.node.version);
    for (const [name, digest] of Object.entries(provenance.bundled.psu.outputs)) {
      expect(sha256(path.join(unit, 'lib', 'psu', name)), name).toBe(digest);
    }
    expect(provenance.bundled.psu.sourcePins['.']).toBe(HEAD);
    // node-pty — psu's only external, loaded on the pty-host path — resolves beside the bundle.
    const pty = run(node, ['-e', "console.log(typeof require('module').createRequire(process.argv[1])('@lydell/node-pty').spawn)",
      path.join(unit, 'lib', 'psu', 'psu.mjs')], env, home);
    expect(pty.stdout.trim(), output(pty)).toBe('function');

    const licenses = readFileSync(path.join(unit, 'THIRD_PARTY_LICENSES.md'), 'utf8');
    expect(licenses).toContain(`| node | ${provenance.bundled.node.version} | MIT |`);
    expect(provenance.bundled.psu.npmPackages.some((pkg) => pkg.startsWith('@lydell/node-pty-linux-x64@'))).toBe(true);
    for (const pkg of provenance.bundled.psu.npmPackages) {
      const at = pkg.lastIndexOf('@');
      expect(licenses, pkg).toContain(`| ${pkg.slice(0, at)} (npm) | ${pkg.slice(at + 1)} |`);
    }
  });

  test('AUTO-BAR-R-08-P-019: install links psu beside pui, never over a psu it does not own, pui runs its own psu first, and uninstall leaves no psu residue', { timeout: 300_000 }, () => {
    const unit = unpack(B.archive, 'psu-link');
    const psuTarget = (home: string) => path.join(home, '.local', 'share', 'pui', 'current', 'bin', 'psu');

    // A clean HOME: install.sh links psu, and it runs through that link from PATH.
    const home = freshHome('psu-link');
    const env = sandboxEnv(home);
    const bin = path.join(home, '.local', 'bin');
    const installed = run(path.join(unit, 'install.sh'), ['--yes'], env, home);
    expect(installed.status, output(installed)).toBe(0);
    expect(installed.stdout).toContain(`psu:      ${path.join(bin, 'psu')}`);
    expect(readlinkSync(path.join(bin, 'psu'))).toBe(psuTarget(home));
    const viaLink = run('psu', ['--connect-list'], env, home);
    expect(viaLink.status, output(viaLink)).toBe(0);
    expect(viaLink.stdout).toContain('this computer');
    // Sibling-first: with NO psu on PATH at all, the installed pui still hands
    // `--connect` to the psu shipped beside it.
    const noPsu = { ...env, PATH: TOOLS };
    expect(run('sh', ['-c', 'command -v psu'], noPsu, home).status).not.toBe(0);
    const handOff = run(path.join(bin, 'pui'), ['--connect-list'], noPsu, home);
    expect(handOff.status, output(handOff)).toBe(0);
    expect(handOff.stdout).toContain('this computer');

    const uninstall = run(path.join(bin, 'pui'), ['self', 'uninstall', '--yes'], env, home);
    expect(uninstall.status, output(uninstall)).toBe(0);
    expect(uninstall.stdout).toContain(`remove psu link: ${path.join(bin, 'psu')}`);
    expect(readdirSync(bin)).toEqual([]);
    expect(run('sh', ['-c', 'command -v psu'], env, home).status).not.toBe(0);

    // A psu PUI did not create (the desktop app's shim) is first on PATH: install
    // still succeeds, says so, never replaces it — and pui's own hand-off still
    // runs the bundled psu, not the shim.
    const shimHome = freshHome('psu-foreign');
    const shimEnv = sandboxEnv(shimHome);
    const shimBin = path.join(shimHome, '.local', 'bin');
    mkdirSync(shimBin, { recursive: true });
    const shim = '#!/bin/sh\necho desktop shim\n';
    writeFileSync(path.join(shimBin, 'psu'), shim, { mode: 0o755 });
    const kept = run(path.join(unit, 'install.sh'), ['--yes'], shimEnv, shimHome);
    expect(kept.status, output(kept)).toBe(0);
    expect(kept.stdout).toContain("not PUI's; left untouched");
    expect(readFileSync(path.join(shimBin, 'psu'), 'utf8')).toBe(shim);
    expect(lstatSync(path.join(shimBin, 'psu')).isSymbolicLink()).toBe(false);
    const own = run(path.join(shimBin, 'pui'), ['--connect-list'], shimEnv, shimHome);
    expect(own.status, output(own)).toBe(0);
    expect(own.stdout).toContain('this computer');
    expect(own.stdout).not.toContain('desktop shim');
    const removed = run(path.join(shimBin, 'pui'), ['self', 'uninstall', '--yes'], shimEnv, shimHome);
    expect(removed.status, output(removed)).toBe(0);
    expect(removed.stdout).not.toContain('remove psu link');
    expect(readdirSync(shimBin)).toEqual(['psu']);
    expect(readFileSync(path.join(shimBin, 'psu'), 'utf8')).toBe(shim);
  });

  test('AUTO-BAR-R-08-P-020: with no operator, installed PUI setup signs in to Papercusp cloud through its bundled psu and runs PUI on the cloud workspace', { timeout: 300_000 }, async () => {
    const unit = unpack(B.archive, 'cloud-first-run');
    const home = freshHome('cloud-first-run');
    const env = sandboxEnv(home);
    const installed = run(path.join(unit, 'install.sh'), ['--yes'], env, home);
    expect(installed.status, output(installed)).toBe(0);
    // Positive control: nothing but the installed product can sign in here.
    for (const absent of ['node', 'zellij', 'xdg-open']) {
      expect(run('sh', ['-c', `command -v ${absent}`], env, home).status, absent).not.toBe(0);
    }

    const cloud = await startCloudStub();
    const pane = ptyRun(path.join(home, '.local', 'bin', 'pui'), ['workbench'],
      { ...env, TERM: 'xterm-256color', PAPERCUSP_CLOUD_ORIGIN: cloud.origin }, home);
    try {
      await pane.waitFor('Connection: Unavailable');
      const setup = pane.screen();
      expect(setup).toContain('No operator here? Run PUI on a remote host instead:');
      expect(setup).toContain('l Sign in to Papercusp cloud · h Connect to a remote host');
      // The address form names no internal deployment ports.
      pane.write('e');
      await pane.waitFor('Operator connection');
      expect(pane.screen()).toContain('A full http(s) URL, such as https://host:9443');
      expect(pane.screen()).not.toMatch(/staging|release/);
      pane.write('\u001b');
      await pane.waitFor('l Sign in to Papercusp cloud');
      expect(pane.screen()).not.toContain('Operator connection');

      const handOff = pane.raw().length;
      pane.write('l');
      // psu's device sign-in prints the code to check in the browser...
      await pane.waitFor(CLOUD_USER_CODE, { sinceRaw: handOff });
      // ...then opens PUI on the one connected workspace and returns its status.
      await pane.waitFor(REMOTE_MARKER, { sinceRaw: handOff });
      const { exitCode } = await Promise.race([
        pane.exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`pui did not exit:\n${pane.screen()}`)), 60_000)),
      ]);
      expect(exitCode, pane.screen()).toBe(0);
    } finally {
      pane.kill();
      await cloud.close();
    }

    expect(cloud.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/hosted/cli/device/code',
      'POST /api/hosted/cli/device/token',
      'GET /api/hosted/cli/workspaces',
      `POST /api/hosted/cli/workspaces/${CLOUD_WORKSPACE}/terminal`,
    ]);
    // The token the sign-in just issued, and nothing else, opened the workspace.
    for (const call of cloud.calls.slice(2)) expect(call.authorization).toBe(`Bearer ${CLOUD_TOKEN}`);
    // This fake cloud predates D-002's program request, so the bundled psu types its interim shell line.
    expect(cloud.remoteInput.join('')).toBe(hostedForwardInput('pui', []));
    // The sign-in is kept, privately, for the next `pui --connect`.
    const storePath = path.join(home, '.papercusp', 'psu-connections.json');
    expect(lstatSync(storePath).mode & 0o077).toBe(0);
    const store = JSON.parse(readFileSync(storePath, 'utf8')) as { profiles: Array<{ kind: string; origin: string }> };
    expect(store.profiles).toMatchObject([{ kind: 'papercusp-hosted', origin: cloud.origin }]);
  });

  test('AUTO-BAR-R-11-P-011: archives are reproducible, name their committed generation, and refuse tampering', { timeout: 2 * BUILD_TIMEOUT_MS }, () => {
    // A second build of the same commit in an EMPTY target dir: nothing is
    // reused from the first, so byte-identical output is compile determinism,
    // not a cache hit.
    const again = packageAt(HEAD, path.join(WORK, 'dist-b-again'), path.join(WORK, 'cold-target'));
    expect(again.sha256).toBe(B.sha256);
    expect(sha256(B.archive)).toBe(B.sha256);
    const sums = readFileSync(path.join(path.dirname(B.archive), 'SHA256SUMS'), 'utf8');
    expect(sums).toContain(`${B.sha256}  ${path.basename(B.archive)}`);

    const unit = unpack(B.archive, 'provenance');
    const provenance = JSON.parse(readFileSync(path.join(unit, 'PROVENANCE.json'), 'utf8')) as Provenance;
    expect(provenance.source.commit).toBe(HEAD);
    for (const [dir, tree] of Object.entries(provenance.source.trees)) {
      expect(tree, dir).toBe(git('rev-parse', `${HEAD}:${dir}`));
    }
    // CONTENTS.sha256 pins every file, checked with an independent hasher.
    const listed = new Map(readFileSync(path.join(unit, 'CONTENTS.sha256'), 'utf8').trim().split('\n')
      .map((line) => [line.slice(66), line.slice(0, 64)] as const));
    const files = execFileSync('sh', ['-c', 'find . -type f ! -name CONTENTS.sha256 | sed "s|^\\./||" | LC_ALL=C sort'], { cwd: unit, encoding: 'utf8' })
      .trim().split('\n');
    expect([...listed.keys()].sort()).toEqual(files);
    for (const file of files) expect(listed.get(file), file).toBe(sha256(path.join(unit, file)));

    // A modified file is refused by the in-binary check AND by install.sh.
    const home = freshHome('tamper');
    const env = sandboxEnv(home);
    const tampered = path.join(WORK, 'tampered', path.basename(unit));
    cpSync(unit, tampered, { recursive: true });
    writeFileSync(path.join(tampered, 'README.md'), 'substituted\n');
    const direct = run(path.join(unit, 'bin', 'pui'), ['self', 'install', '--from', tampered, '--yes'], env, home);
    expect(direct.status, output(direct)).not.toBe(0);
    expect(direct.stderr).toContain('README.md hashes to');
    const viaScript = run(path.join(tampered, 'install.sh'), ['--yes'], env, home);
    expect(viaScript.status, output(viaScript)).not.toBe(0);
    expect(viaScript.stderr).toContain('does not match CONTENTS.sha256');
    // An archive whose published digest disagrees is refused before unpacking.
    const substituted = path.join(WORK, 'substituted');
    mkdirSync(substituted);
    cpSync(B.archive, path.join(substituted, path.basename(B.archive)));
    writeFileSync(path.join(substituted, 'SHA256SUMS'), `${'0'.repeat(64)}  ${path.basename(B.archive)}\n`);
    const wrongDigest = run(path.join(unit, 'bin', 'pui'), ['self', 'install', '--from', path.join(substituted, path.basename(B.archive)), '--yes'], env, home);
    expect(wrongDigest.status, output(wrongDigest)).not.toBe(0);
    expect(wrongDigest.stderr).toContain('published digest');
    expect(existsSync(path.join(home, '.local', 'share', 'pui', 'current'))).toBe(false);
    expect(existsSync(path.join(home, '.local', 'bin', 'pui'))).toBe(false);
  });

  test('AUTO-BAR-R-11-P-011: install, update, roll back and uninstall across two generations preserve user data', { timeout: 600_000 }, () => {
    expect(A.sourceSha).not.toBe(B.sourceSha);
    const home = freshHome('lifecycle');
    const env = sandboxEnv(home);
    const launcher = path.join(home, '.local', 'bin', 'pui');
    const data = path.join(home, '.papercusp');
    const state = path.join(data, 'pui-state.json');
    const operator = path.join(data, 'operator.json');

    const first = run(path.join(unpack(A.archive, 'gen-a'), 'install.sh'), ['--yes'], env, home);
    expect(first.status, output(first)).toBe(0);
    expect(stamp(launcher, env, home).sourceSha).toBe(A.sourceSha);
    mkdirSync(data, { recursive: true });
    const before = '{"tutorialSeen":true}';
    const operatorConfig = '{"httpUrl":"http://127.0.0.1:1"}';
    writeFileSync(state, before);
    writeFileSync(operator, operatorConfig);

    // Update from the archive: its SHA256SUMS sits beside it and is checked.
    const update = run(launcher, ['self', 'update', '--from', B.archive, '--yes'], env, home);
    expect(update.status, output(update)).toBe(0);
    expect(update.stdout).toContain(`sha256 ${B.sha256} matches its published digest`);
    expect(stamp(launcher, env, home).sourceSha).toBe(B.sourceSha);
    expect(statusJson(launcher, env, home)).toMatchObject({ current: { id: releaseId(B) }, previous: { id: releaseId(A) } });
    expect(readFileSync(state, 'utf8')).toBe(before);
    expect(readFileSync(operator, 'utf8')).toBe(operatorConfig);

    // The newer release migrates PUI's own state; rolling back with
    // --restore-data returns it to the snapshot taken at the update.
    writeFileSync(state, '{"tutorialSeen":true,"schema":2}');
    const restore = run(launcher, ['self', 'rollback', '--restore-data', '--yes'], env, home);
    expect(restore.status, output(restore)).toBe(0);
    expect(stamp(launcher, env, home).sourceSha).toBe(A.sourceSha);
    expect(readFileSync(state, 'utf8')).toBe(before);
    expect(readFileSync(operator, 'utf8')).toBe(operatorConfig);

    // A plain rollback (here: forward again) never touches user data.
    writeFileSync(state, '{"tutorialSeen":false}');
    const forward = run(launcher, ['self', 'rollback', '--yes'], env, home);
    expect(forward.status, output(forward)).toBe(0);
    expect(stamp(launcher, env, home).sourceSha).toBe(B.sourceSha);
    expect(readFileSync(state, 'utf8')).toBe('{"tutorialSeen":false}');

    // Uninstall keeps user data; the launcher and release store are gone.
    const uninstall = run(launcher, ['self', 'uninstall', '--yes'], env, home);
    expect(uninstall.status, output(uninstall)).toBe(0);
    expect(existsSync(launcher)).toBe(false);
    expect(existsSync(path.join(home, '.local', 'share', 'pui'))).toBe(false);
    expect(run('sh', ['-c', 'command -v pui'], env, home).status).not.toBe(0);
    expect(readFileSync(state, 'utf8')).toBe('{"tutorialSeen":false}');
    expect(readFileSync(operator, 'utf8')).toBe(operatorConfig);

    // --purge removes PUI's own state only; operator.json is shared and stays.
    const again = run(path.join(unpack(B.archive, 'gen-b-again'), 'install.sh'), ['--yes'], env, home);
    expect(again.status, output(again)).toBe(0);
    const purge = run(launcher, ['self', 'uninstall', '--purge', '--yes'], env, home);
    expect(purge.status, output(purge)).toBe(0);
    expect(existsSync(state)).toBe(false);
    expect(readFileSync(operator, 'utf8')).toBe(operatorConfig);
  });

  test('AUTO-BAR-R-09-P-011: installing needs explicit consent, and neither the package nor the support export carries a seeded credential or private text', { timeout: 300_000 }, () => {
    const home = freshHome('consent');
    const env = sandboxEnv(home);
    const unit = unpack(B.archive, 'consent');
    const store = path.join(home, '.local', 'share', 'pui');

    // Nothing seeded into the packager's environment reached any file of the
    // unit, binaries included (a positive control proves the scan reads bytes).
    const unitFiles = readdirSync(unit, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
    expect(unitFiles.some((file) => readFileSync(file).includes(B.sourceSha))).toBe(true);
    for (const file of unitFiles) {
      const bytes = readFileSync(file);
      for (const marker of Object.values(PACKAGING_SECRETS)) {
        expect(bytes.includes(marker), `${marker} in ${path.relative(unit, file)}`).toBe(false);
      }
    }

    // No TTY and no --yes: refused, nothing installed.
    for (const [command, args] of [
      [path.join(unit, 'install.sh'), []],
      [path.join(unit, 'bin', 'pui'), ['self', 'install', '--from', unit]],
    ] as const) {
      const refused = run(command, [...args], env, home, 'y\n');
      expect(refused.status, output(refused)).not.toBe(0);
      expect(refused.stderr).toContain('without confirmation');
      expect(existsSync(store)).toBe(false);
    }
    // --dry-run previews the exact release and paths and changes nothing.
    const dry = run(path.join(unit, 'bin', 'pui'), ['self', 'install', '--from', unit, '--dry-run'], env, home);
    expect(dry.status, output(dry)).toBe(0);
    expect(dry.stdout).toContain(`install: ${releaseId(B)}`);
    expect(dry.stdout).toContain(path.join(store, 'releases', releaseId(B)));
    expect(existsSync(store)).toBe(false);

    // A new install carries no state of its own into ~/.papercusp (so it
    // cannot inherit development AUTO/bypass settings).
    const install = run(path.join(unit, 'bin', 'pui'), ['self', 'install', '--from', unit, '--yes'], env, home);
    expect(install.status, output(install)).toBe(0);
    expect(existsSync(path.join(home, '.papercusp'))).toBe(false);

    // Private conversation text seeded wherever this PUI can hold it: the unsent
    // draft a reconnect carries in PUI_SETUP_DRAFT, a variable no build knows,
    // and PUI's own state on disk.
    const privateText = 'P011-PRIVATE-CONVERSATION';
    const secrets = {
      PAPERCUSP_API_TOKEN: 'P011-API-TOKEN-SECRET',
      PUI_OPERATOR: 'https://owner:hunter2@op.example:9443/api?key=P011-QUERY-SECRET',
      PUI_FLEET: 'visible-fleet',
      PUI_SETUP_DRAFT: `${privateText}: the draft I had not sent`,
      PUI_NOT_YET_INVENTED: `${privateText}: a carrier nobody thought to deny`,
    };
    mkdirSync(path.join(home, '.papercusp'));
    writeFileSync(path.join(home, '.papercusp', 'pui-state.json'), JSON.stringify({ tutorialSeen: true, note: privateText }));
    const launcher = path.join(home, '.local', 'bin', 'pui');
    const report = run(launcher, ['self', 'diagnostics'], sandboxEnv(home, secrets), home);
    expect(report.status, output(report)).toBe(0);
    for (const leaked of ['P011-API-TOKEN-SECRET', 'hunter2', 'P011-QUERY-SECRET', privateText]) {
      expect(`${report.stdout}\n${report.stderr}`, leaked).not.toContain(leaked);
    }
    expect(report.stdout).toContain('env PAPERCUSP_API_TOKEN=[redacted]');
    expect(report.stdout).toContain('env PUI_FLEET=visible-fleet');
    expect(report.stdout).toContain('https://[redacted]@op.example:9443/api?[redacted]');
    expect(report.stdout).toContain('env PUI_SETUP_DRAFT=[set, value withheld]');
    expect(report.stdout).toContain('env PUI_NOT_YET_INVENTED=[set, value withheld]');
  });

  test('AUTO-BAR-R-10-P-011: runtime requirements are measured from the artifact, nothing is advertised without this candidate’s evidence, and a committed verified claim is refused', { timeout: 420_000 }, () => {
    const unit = unpack(B.archive, 'compat');
    const provenance = JSON.parse(readFileSync(path.join(unit, 'PROVENANCE.json'), 'utf8')) as Provenance;
    const binary = path.join(unit, 'bin', 'pui');
    const needed = execFileSync('readelf', ['-d', binary], { encoding: 'utf8' })
      .split('\n').map((line) => /Shared library: \[(.+)\]/.exec(line)?.[1]).filter((lib): lib is string => Boolean(lib)).sort();
    expect(provenance.runtime.sharedLibraries).toEqual(needed);
    const glibc = execFileSync('objdump', ['-T', binary], { encoding: 'utf8' }).match(/GLIBC_[0-9.]+/g) ?? [];
    const floor = [...new Set(glibc.map((v) => v.slice('GLIBC_'.length)))]
      .sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).at(-1);
    expect(provenance.runtime.glibcFloor).toBe(floor);
    expect(B.glibcFloor).toBe(floor);

    const compat = JSON.parse(git('show', `${HEAD}:apps/tui/release/compatibility.json`)) as {
      targets: Record<string, { status: string; platforms: string[] }>;
    };
    const table = readFileSync(path.join(unit, 'COMPATIBILITY.md'), 'utf8');
    for (const [name, target] of Object.entries(compat.targets)) {
      expect(table, name).toContain(`| ${name} | ${target.platforms.join(', ')} | ${target.status} |`);
    }
    expect(compat.targets[TARGET].status).not.toBe('verified');
    expect(table).toContain('build-time compatibility');
    expect(table).toContain('Build-time status');
    expect(table).toContain('Not advertised by this build-time record');
    expect(table).toContain(`pui-${provenance.version}-${TARGET}.tar.gz.acceptance.json`);
    expect(table).toContain('candidate.archiveSha256');
    expect(table).toContain('matches the SHA-256 of the archive you downloaded');

    // compatibility.json is committed before the candidate it ships in exists,
    // so a 'verified' target there can only be another generation's evidence:
    // a candidate claiming one is refused before anything is built. The claim
    // is committed into a throwaway object store that borrows this repo's
    // objects, so the shared checkout is never written; B above is the control
    // (same packager, same tree, no claim).
    const claimed = path.join(WORK, 'claims-verified.git');
    execFileSync('git', ['init', '--bare', '--quiet', claimed]);
    writeFileSync(path.join(claimed, 'objects', 'info', 'alternates'), `${path.resolve(REPO_ROOT, git('rev-parse', '--git-path', 'objects'))}\n`);
    const scratchGit = (args: string[], input?: string) => execFileSync('git', ['--git-dir', claimed, ...args], {
      encoding: 'utf8', input,
      env: {
        ...process.env, GIT_INDEX_FILE: path.join(claimed, 'scratch-index'),
        GIT_AUTHOR_NAME: 'p011', GIT_AUTHOR_EMAIL: 'p011@invalid', GIT_COMMITTER_NAME: 'p011', GIT_COMMITTER_EMAIL: 'p011@invalid',
      },
    }).trim();
    const claim = { ...compat, targets: { ...compat.targets, [TARGET]: { ...compat.targets[TARGET], status: 'verified', evidence: 'an earlier generation’s installed journey' } } };
    scratchGit(['read-tree', HEAD]);
    const claimBlob = scratchGit(['hash-object', '-w', '--stdin'], `${JSON.stringify(claim, null, 2)}\n`);
    scratchGit(['update-index', '--cacheinfo', `100644,${claimBlob},apps/tui/release/compatibility.json`]);
    const claimCommit = scratchGit(['commit-tree', scratchGit(['write-tree']), '-p', HEAD, '-m', 'claims verified']);
    const refusedOut = path.join(WORK, 'dist-claims-verified');
    const refused = spawnSync(PACKAGER, ['--target', TARGET, '--sha', claimCommit, '--out', refusedOut], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000, env: { ...process.env, GIT_DIR: claimed },
    });
    expect(refused.status, output(refused)).not.toBe(0);
    expect(refused.stderr).toContain(`marks ${TARGET} verified`);
    expect(existsSync(refusedOut)).toBe(false);
    for (const lib of needed) expect(table).toContain(lib);
    if (floor) expect(table).toContain(`Requires glibc ${floor} or newer`);

    const licenses = readFileSync(path.join(unit, 'THIRD_PARTY_LICENSES.md'), 'utf8');
    for (const component of ['| zellij | 0.44.3 | MIT |', '| ratatui |', '| tokio |', '| serde |']) {
      expect(licenses).toContain(component);
    }
    const firstPartyLicense = readFileSync(path.join(unit, 'LICENSE'), 'utf8');
    expect(firstPartyLicense).toContain('Apache License');
    expect(firstPartyLicense).toContain('Version 2.0, January 2004');
    expect(firstPartyLicense).toContain('Copyright 2026 Papercusp');
    // This archive's own target is the machine running the test: it executes.
    const runs = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    expect(runs.status, output(runs)).toBe(0);
  });
});
