/**
 * container-exec-target.ts — run a benchmark arm's agent CLI INSIDE a task container
 * (benchmark-coverage-frontierswe-v2-2026-10-10 D-026, P-006).
 *
 * The maintained launch adapter (capability:launch-agent → headless psu) stays on the
 * host: prompt, MCP surface, gateway accounting and carry-respawn are unchanged. Only
 * the agent CLI process moves. psu resolves the CLI through resolveBackendLaunch, which
 * honours a per-launch override env (backendBinOverrideEnvKey, e.g.
 * PAPERCUSP_BACKEND_BIN_CODEX). This module writes the executable that override points
 * at: a host-side node script named after the agent that `docker exec`s the
 * container's copy of the CLI in the task's working directory, so the CLI's tools and
 * apply_patch act on the container filesystem the task verifier scores.
 *
 * Properties the wrapper guarantees (pinned by container-exec-target.test.ts):
 *   - argv carries env NAMES only (`-e NAME`); docker reads each value from the
 *     wrapper's own environment, so secrets never appear in a process listing.
 *   - only names matching the forward patterns cross into the container, and the
 *     never-forward set (PATH, HOME, the override keys themselves) never does.
 *   - `-t` is requested only when stdin AND stdout are TTYs (psu-pty vs a pipe).
 *   - the CLI's exit code (or terminating signal) is the wrapper's.
 *   - with `originRewrites`, the agent never starts on a config.toml that still names a
 *     loopback origin: mapped origins are rewritten, anything left refuses (exit 126).
 *   - the file is named after the agent (`codex`), so psu's codexManagedDaemonArgs
 *     still adds `--no-daemon` and the CLI runs in-process inside the container.
 *
 * Killing the docker client does not kill the process inside the container; the bench
 * seam's teardown (`docker rm -f`) owns that.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { NativeContainerExecBinding } from '@papercusp/orchestrator/fleet-srt-spawn';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { backendBinOverrideEnvKey, resolveBackendLaunch } from '../backend-bin-resolve.mjs';
import { CONTAINER_HOOK_SHIM_PATH, HOOK_SESSION_NAME } from './codex-hook-bridge';

export interface DockerExecTarget {
  kind: 'docker-exec';
  /** Container id or name, as `docker run -d` returned it. */
  containerId: string;
  /** Working directory inside the container (FrontierSWE tasks: /app). */
  workdir: string;
  /** Absolute path of the agent CLI inside the container. */
  binPath: string;
  /**
   * Session-dir relocation (benchmark-coverage-frontierswe-v2 D-026 step 3). The operator writes
   * a Codex session home under SHARED host roots (every session's home and tokens live there), so
   * the container must not mount those roots. Instead the seam bind-mounts one per-task dir over
   * each root at the same absolute path. Before every exec the wrapper moves this session's dir
   * out of the shared root into the per-task dir and leaves a host symlink behind. Host readers
   * follow the symlink, and inside the container the same path resolves through the mount.
   */
  sessionRelocation?: SessionRelocation;
  /**
   * Codex hook bridge (benchmark-coverage-frontierswe-v2 D-032). Requires `sessionRelocation`: the hooks file lives in
   * the session dir. Before relocating, the wrapper captures `<session dir>/hooks.json` while the dir is still
   * host-only, writes the trusted record into `recordDir`, and rewrites every hook command to the in-container shim.
   * After relocating it pings the bridge FROM INSIDE the container and refuses to start the agent if that fails.
   */
  hookBridge?: HookBridgeTarget;
  /**
   * Host-origin rewrites for the session's config.toml (benchmark-coverage-frontierswe-v2 D-033 step 2). Requires
   * `sessionRelocation`: config.toml lives in the session dir. The operator writes host origins there (the scoped
   * gateway `base_url`/`model_catalog_url`, the MCP `url`), and inside the container 127.0.0.1 is the container's own
   * loopback. Before every exec the wrapper replaces each exact `from` origin with its `to` (egress) origin in one pass.
   * It then refuses to start the agent (exit 126) if any loopback origin remains outside a whole-line comment, so an
   * unmapped host port fails closed instead of dialing the container itself. An empty list runs only that check.
   */
  originRewrites?: readonly OriginRewrite[];
}

/** One exact origin mapping: `scheme://host:port`, no path. `to` must not be a loopback origin. */
export interface OriginRewrite {
  from: string;
  to: string;
}

/**
 * Regex source matching a loopback origin (any 127/8 address, localhost, [::1] or 0.0.0.0, optional port), used
 * case-insensitively. Exported so the launch adapter can pre-check a config with the wrapper's exact rule.
 */
export const LOOPBACK_ORIGIN_SOURCE =
  String.raw`(?:https?|wss?)://(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?(?![A-Za-z0-9.-])`;

const ORIGIN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface HookBridgeTarget {
  /** The bridge as the container reaches it: `http://papercusp-egress:<port>` (bench-egress originFor('hooks')). */
  url: string;
  /** Host-only dir for trusted records. Must never be mounted into a container (disjoint from every relocation dir). */
  recordDir: string;
  /** Shim path inside the container. Default {@link CONTAINER_HOOK_SHIM_PATH}. */
  shimPath?: string;
  /** Budget for the in-container ping. Default 180s (docker exec can stall on the bench host, EI-25661823593517912). */
  pingTimeoutMs?: number;
}

export interface SessionRelocation {
  /** Env var holding this session's dir, a direct child of `roots[0].hostRoot` (Codex: CODEX_HOME). */
  sessionEnv: string;
  /** Shared host roots and the per-task dir mounted over each. The session dir's basename is
   *  relocated under every root. Keep each `perTaskDir` on the same filesystem as its root. */
  roots: readonly { hostRoot: string; perTaskDir: string }[];
}

/** Where the bench seam mounts the static musl Codex CLI inside a task container (D-026 step 1). */
export const CONTAINER_CODEX_BIN_PATH = '/opt/papercusp/codex';

const MUSL_TARGETS: Record<string, { pkg: string; triple: string }> = {
  x64: { pkg: 'codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  arm64: { pkg: 'codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
};

/**
 * The static musl Codex binary that ships inside the SAME `@openai/codex` install the
 * host psu resolves (D-026: "the same version the host psu resolves"). The musl build
 * is self-contained, so it runs in any Linux task image. Throws naming every searched
 * path when the install has no musl build for this arch.
 */
export function resolveContainerCodexBinary(
  opts: { env?: NodeJS.ProcessEnv; arch?: string } = {},
): string {
  const env = { ...(opts.env ?? process.env) };
  delete env[backendBinOverrideEnvKey('codex')];
  const target = MUSL_TARGETS[opts.arch ?? process.arch];
  if (!target) throw new Error(`container codex: no musl Codex build is published for arch ${opts.arch ?? process.arch}`);
  const launch = resolveBackendLaunch('codex', { env });
  if (!launch) throw new Error('container codex: no host codex install found (resolveBackendLaunch returned null)');
  let dir = dirname(realpathSync(launch.bin));
  let pkgRoot: string | null = null;
  for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name === '@openai/codex') {
          pkgRoot = dir;
          break;
        }
      } catch {
        /* not the package we want */
      }
    }
  }
  if (!pkgRoot) throw new Error(`container codex: ${launch.bin} is not inside an @openai/codex npm install`);
  const rel = join('vendor', target.triple, 'bin', 'codex');
  const candidates = [
    join(pkgRoot, 'node_modules', '@openai', target.pkg, rel),
    join(dirname(pkgRoot), target.pkg, rel),
    join(pkgRoot, rel),
  ];
  for (const c of candidates) {
    try {
      const st = statSync(c);
      if (st.isFile() && (st.mode & 0o111) !== 0) return c;
    } catch {
      /* try the next layout */
    }
  }
  throw new Error(`container codex: no executable musl build found; searched ${candidates.join(', ')}`);
}

/** Env names (regex sources) the wrapper forwards into the container. */
export const DEFAULT_FORWARD_ENV_PATTERNS: readonly string[] = [
  '^CODEX_',
  '^OPENAI_',
  '^PAPERCUSP_',
  '^RUST_LOG$',
  '^NO_COLOR$',
  '^TERM$',
  '^COLORTERM$',
  '^LANG$',
  '^LC_',
];

/** Env names (regex sources) that never cross, even when a forward pattern matches. */
export const NEVER_FORWARD_ENV_PATTERNS: readonly string[] = ['^PATH$', '^HOME$', '^PAPERCUSP_BACKEND_BIN_'];

const CONTAINER_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Throws on a target the wrapper could not execute safely. */
export function validateDockerExecTarget(target: DockerExecTarget): void {
  if (target.kind !== 'docker-exec') throw new Error(`container exec target: unsupported kind ${JSON.stringify(target.kind)}`);
  if (!CONTAINER_REF.test(target.containerId)) {
    throw new Error(`container exec target: containerId ${JSON.stringify(target.containerId)} is not a docker container id or name`);
  }
  if (!isAbsolute(target.workdir)) throw new Error(`container exec target: workdir must be absolute, got ${JSON.stringify(target.workdir)}`);
  if (!isAbsolute(target.binPath)) throw new Error(`container exec target: binPath must be absolute, got ${JSON.stringify(target.binPath)}`);
  const relocation = target.sessionRelocation;
  if (relocation) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(relocation.sessionEnv)) {
      throw new Error(`container exec target: sessionRelocation.sessionEnv ${JSON.stringify(relocation.sessionEnv)} is not an env name`);
    }
    if (relocation.roots.length === 0) throw new Error('container exec target: sessionRelocation needs at least one root');
    for (const { hostRoot, perTaskDir } of relocation.roots) {
      if (!isAbsolute(hostRoot) || !isAbsolute(perTaskDir)) {
        throw new Error(`container exec target: sessionRelocation paths must be absolute (${hostRoot}, ${perTaskDir})`);
      }
      const root = resolve(hostRoot), dir = resolve(perTaskDir);
      if (root === dir || dir.startsWith(root + sep) || root.startsWith(dir + sep)) {
        throw new Error(`container exec target: perTaskDir ${dir} must be disjoint from its shared root ${root}`);
      }
    }
  }
  const bridge = target.hookBridge;
  if (bridge) {
    if (!relocation) throw new Error('container exec target: hookBridge requires sessionRelocation (hooks.json lives in the session dir)');
    if (!/^http:\/\/[A-Za-z0-9.-]+:\d{1,5}$/.test(bridge.url)) {
      throw new Error(`container exec target: hookBridge.url ${JSON.stringify(bridge.url)} is not http://<host>:<port>`);
    }
    if (!isAbsolute(bridge.recordDir)) throw new Error(`container exec target: hookBridge.recordDir must be absolute, got ${JSON.stringify(bridge.recordDir)}`);
    const shim = bridge.shimPath ?? CONTAINER_HOOK_SHIM_PATH;
    if (!isAbsolute(shim) || /\s/.test(shim)) throw new Error(`container exec target: hookBridge.shimPath ${JSON.stringify(shim)} must be absolute with no whitespace`);
    const rec = resolve(bridge.recordDir);
    for (const { hostRoot, perTaskDir } of relocation.roots) {
      for (const d of [resolve(hostRoot), resolve(perTaskDir)]) {
        if (rec === d || rec.startsWith(d + sep) || d.startsWith(rec + sep)) {
          throw new Error(`container exec target: hookBridge.recordDir ${rec} must be disjoint from ${d} — the records must never be container-visible`);
        }
      }
    }
  }
  const rewrites = target.originRewrites;
  if (rewrites) {
    if (!relocation) throw new Error('container exec target: originRewrites requires sessionRelocation (config.toml lives in the session dir)');
    const loopback = new RegExp(`^${LOOPBACK_ORIGIN_SOURCE}$`, 'i');
    const seen = new Set<string>();
    for (const { from, to } of rewrites) {
      for (const [field, v] of [['from', from], ['to', to]] as const) {
        if (!ORIGIN.test(v)) throw new Error(`container exec target: originRewrites ${field} ${JSON.stringify(v)} is not scheme://host:port`);
      }
      if (loopback.test(to)) {
        throw new Error(`container exec target: originRewrites to ${to} is a loopback origin; inside the container it would dial the container itself`);
      }
      if (seen.has(from)) throw new Error(`container exec target: originRewrites maps ${from} twice`);
      seen.add(from);
    }
  }
}

export interface RenderWrapperOptions {
  /** docker CLI the wrapper execs. Default 'docker' (resolved on the wrapper's PATH). */
  dockerBin?: string;
  /** Selected host daemon, kept outside the task environment. Materialization snapshots DOCKER_HOST by default. */
  dockerHost?: string;
  /** Interpreter for the wrapper's shebang. Default: this process's node when its path has no whitespace. */
  nodeBin?: string;
  forwardEnvPatterns?: readonly string[];
  neverForwardEnvPatterns?: readonly string[];
}

function shebangFor(nodeBin: string | undefined): string {
  const candidate = nodeBin ?? process.execPath;
  return /\s/.test(candidate) || !isAbsolute(candidate) ? '#!/usr/bin/env node' : `#!${candidate}`;
}

/** The wrapper's source text. Pure: same inputs, same bytes. */
export function renderDockerExecWrapper(target: DockerExecTarget, opts: RenderWrapperOptions = {}): string {
  validateDockerExecTarget(target);
  const cfg = {
    dockerBin: opts.dockerBin ?? 'docker',
    dockerArgs: opts.dockerHost ? ['--host', opts.dockerHost] : [],
    containerId: target.containerId,
    workdir: target.workdir,
    binPath: target.binPath,
    // Bootstrap seeds the observer checkout's project trust. The maintained
    // Codex mount runs in a different directory inside the task container, so
    // carry that same launch grant to its exact cwd, on fresh start and resume.
    // Pass the path as a TOML map key in the override VALUE: Codex splits the
    // override KEY on dots without interpreting quoted path components. The
    // apparent projects."/app".trust_level key does not trust a Git checkout.
    // A CLI override leaves the private config bytes/mode untouched; generic
    // shell probes keep their own argv.
    codexWorkdirArgs: target.binPath === CONTAINER_CODEX_BIN_PATH && target.sessionRelocation?.sessionEnv === 'CODEX_HOME'
      ? ['-c', `projects={${JSON.stringify(target.workdir)}={trust_level="trusted"}}`]
      : [],
    forward: [...(opts.forwardEnvPatterns ?? DEFAULT_FORWARD_ENV_PATTERNS)],
    never: [...(opts.neverForwardEnvPatterns ?? NEVER_FORWARD_ENV_PATTERNS)],
    relocation: target.sessionRelocation
      ? { sessionEnv: target.sessionRelocation.sessionEnv,
          roots: target.sessionRelocation.roots.map(r => ({ hostRoot: resolve(r.hostRoot), perTaskDir: resolve(r.perTaskDir) })) }
      : null,
    hookBridge: target.hookBridge
      ? { url: target.hookBridge.url, recordDir: resolve(target.hookBridge.recordDir),
          shimPath: target.hookBridge.shimPath ?? CONTAINER_HOOK_SHIM_PATH,
          pingTimeoutMs: target.hookBridge.pingTimeoutMs ?? 180_000,
          sessionName: HOOK_SESSION_NAME.source }
      : null,
    // One alternation, longest first, so a single pass can never chain one rewrite into another. The digit lookahead
    // keeps http://127.0.0.1:3210 from matching inside http://127.0.0.1:32101.
    originRewrite: target.originRewrites
      ? { pattern: target.originRewrites.length
            ? `(?:${[...target.originRewrites].map(r => r.from).sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![0-9])`
            : null,
          map: Object.fromEntries(target.originRewrites.map(r => [r.from, r.to])),
          loopback: LOOPBACK_ORIGIN_SOURCE }
      : null,
  };
  return `${shebangFor(opts.nodeBin)}
// Generated by papercusp external-bench/container-exec-target.ts (benchmark-coverage-frontierswe-v2 D-026).
// Runs the agent CLI inside a task container. Do not edit; regenerate.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cfg = ${JSON.stringify(cfg)};
function refuse(msg) {
  process.stderr.write('papercusp container-exec: ' + msg + '\\n');
  process.exit(126);
}
// Host-private, generation-specific identity. Docker exec processes belong to
// the daemon's tree, not this wrapper's Linux descendants. The daemon's exec
// record remains authoritative after the shell execs the native CLI.
function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid wrapper pid');
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
const tracksNative = cfg.codexWorkdirArgs.length > 0;
const identityPath = pid => __filename + '.native-' + pid + '.json';
function dockerJson(args) {
  const result = spawnSync(cfg.dockerBin, [...cfg.dockerArgs, ...args],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Docker identity read failed');
  return JSON.parse(result.stdout);
}
function inspectExec(id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid exec id');
  // Reuse Docker's own selected-daemon transport, including unix/TLS/SSH
  // routing. HTTP/1.0 requests a non-chunked, connection-closed response.
  const result = spawnSync(cfg.dockerBin, [...cfg.dockerArgs, 'system', 'dial-stdio'], {
    input: 'GET /exec/' + id + '/json HTTP/1.0\\r\\nHost: docker\\r\\nConnection: close\\r\\n\\r\\n',
    encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
  });
  const boundary = (result.stdout || '').indexOf('\\r\\n\\r\\n');
  if (result.error || result.status !== 0 || boundary < 0 || !result.stdout.startsWith('HTTP/1.0 200 ') && !result.stdout.startsWith('HTTP/1.1 200 '))
    throw new Error('Docker exec inspection failed');
  return JSON.parse(result.stdout.slice(boundary + 4));
}
if (process.argv[2] === '--papercusp-native-process') {
  try {
    if (!tracksNative || process.argv.length !== 4) throw new Error('unsupported native identity request');
    const pid = Number(process.argv[3]), file = identityPath(pid);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0)
      throw new Error('untrusted wrapper identity');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.pid !== pid || record.start !== processStart(pid) || !/^[a-f0-9]{64}$/.test(record.marker))
      throw new Error('stale wrapper identity');
    const container = dockerJson(['inspect', '--format', '{"id":{{json .Id}},"execIds":{{json .ExecIDs}}}', cfg.containerId]);
    if (!/^[a-f0-9]{64}$/.test(container.id)) throw new Error('invalid container identity');
    const ids = container.execIds || [];
    if (!Array.isArray(ids) || ids.length > 16) throw new Error('ambiguous Docker exec population');
    const matches = [];
    for (const id of ids) {
      const info = inspectExec(id), pc = info.ProcessConfig;
      if (info.ID === id && info.ContainerID === container.id && info.Running === true &&
          pc?.entrypoint === '/bin/sh' && pc.arguments?.[0] === '-c' &&
          pc.arguments?.[1] === 'exec "$@"' && pc.arguments?.[2] === record.marker &&
          pc.arguments?.[3] === cfg.binPath && Number.isSafeInteger(info.Pid) && info.Pid > 0)
        matches.push(info.Pid);
    }
    if (matches.length !== 1 || processStart(pid) !== record.start) throw new Error('native exec is not uniquely live');
    // The task's root user can create a private lock directory that the host
    // cannot enumerate. Read only file identities in this exact session home;
    // the host still proves the lock's owner through its kernel-wide PID view.
    const home = process.env[cfg.relocation.sessionEnv];
    if (!home || path.resolve(path.dirname(home)) !== cfg.relocation.roots[0].hostRoot)
      throw new Error('native identity home changed');
    const stat = spawnSync(cfg.dockerBin, [...cfg.dockerArgs, 'exec', '-u', '0', cfg.containerId,
      '/bin/sh', '-c', 'for f in "$1"/thread-writer-locks/*.lock; do [ -f "$f" ] && [ ! -L "$f" ] && stat -Lc "%d %i %n" "$f"; done',
      'native-locks', home], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    if (stat.error || stat.status !== 0) throw new Error('native lock identities unavailable');
    const locks = [];
    for (const line of stat.stdout.trim().split('\\n')) {
      const match = /^(\\d+) (\\d+) (.+)$/.exec(line);
      if (!match) continue;
      const name = path.basename(match[3]);
      if (match[3] !== path.join(home, 'thread-writer-locks', name) ||
          !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.lock$/i.test(name)) continue;
      const dev = Number(match[1]), ino = Number(match[2]);
      if (Number.isSafeInteger(dev) && Number.isSafeInteger(ino)) locks.push({ name, dev, ino });
    }
    if (locks.length > 256 || processStart(pid) !== record.start) throw new Error('native lock population changed');
    process.stdout.write(JSON.stringify({ ptyPid: pid, pid: matches[0], locks }));
    process.exit(0);
  } catch { refuse('exact native process is unavailable'); }
}
// Move this session's dir from each shared host root into the per-task dir mounted over that
// root, leaving a host symlink. Idempotent: a resume finds the symlink and skips.
function relocate(r) {
  const home = process.env[r.sessionEnv];
  if (!home) refuse(r.sessionEnv + ' is unset; cannot place the session inside the container');
  const name = path.basename(home);
  if (path.resolve(path.dirname(home)) !== r.roots[0].hostRoot) {
    refuse(r.sessionEnv + '=' + home + ' is not directly under ' + r.roots[0].hostRoot);
  }
  for (const root of r.roots) {
    const src = path.join(root.hostRoot, name);
    const dst = path.join(root.perTaskDir, name);
    let st = null;
    try { st = fs.lstatSync(src); } catch (e) { if (e.code !== 'ENOENT') refuse('cannot stat ' + src + ': ' + e.message); }
    if (st && st.isSymbolicLink()) {
      if (path.resolve(path.dirname(src), fs.readlinkSync(src)) === dst) continue;
      refuse(src + ' is a symlink to somewhere other than ' + dst);
    }
    if (st && !st.isDirectory()) refuse(src + ' is not a directory');
    if (fs.existsSync(dst)) refuse(dst + ' already exists; refusing to merge two session dirs');
    fs.mkdirSync(root.perTaskDir, { recursive: true });
    if (st) {
      try { fs.renameSync(src, dst); } catch (e) { refuse('cannot move ' + src + ' to ' + dst + ': ' + e.message); }
    } else {
      // Not created yet (e.g. the SQLite home): pre-create it so the host sees what the container writes.
      fs.mkdirSync(root.hostRoot, { recursive: true });
      fs.mkdirSync(dst);
    }
    fs.symlinkSync(dst, src);
  }
}
// Hook bridge (D-032): keep this session's Codex hooks on the HOST. Runs BEFORE relocate(): on a first launch the
// session dir is still a real dir in the shared root that no container can see, so its hooks.json is trusted. On a
// resume the dir is already container-writable, so only commands already in the host-only record are accepted.
function bridgeHooks(b, sessionEnv) {
  const home = process.env[sessionEnv];
  if (!home) refuse(sessionEnv + ' is unset; cannot bridge its hooks');
  const name = path.basename(home);
  if (!new RegExp(b.sessionName).test(name)) refuse('session dir name ' + JSON.stringify(name) + ' cannot key a hook record');
  let st = null;
  try { st = fs.lstatSync(home); } catch (e) { if (e.code !== 'ENOENT') refuse('cannot stat ' + home + ': ' + e.message); }
  const trusted = !(st && st.isSymbolicLink());
  const hooksPath = path.join(home, 'hooks.json');
  const recPath = path.join(b.recordDir, name + '.json');
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(recPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') refuse('cannot read hook record ' + recPath + ': ' + e.message); }
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(hooksPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') refuse('cannot read ' + hooksPath + ': ' + e.message); }
  if (!doc && !rec) return null; // this session registers no hooks: nothing to keep on the host
  if (!rec) {
    if (!trusted) refuse(hooksPath + ' is already inside the container and no trusted hook record exists for ' + name);
    rec = { session: name, token: crypto.randomBytes(16).toString('hex'), commands: [] };
  }
  const shimCmd = (i) => [b.shimPath, b.url, name, rec.token, String(i)].join(' ');
  const seen = new Set();
  const events = doc && doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
  for (const event of Object.keys(events)) {
    for (const group of Array.isArray(events[event]) ? events[event] : []) {
      for (const h of group && Array.isArray(group.hooks) ? group.hooks : []) {
        if (!h || typeof h.command !== 'string') continue;
        let idx;
        if (h.command.startsWith(b.shimPath + ' ')) {
          idx = rec.commands.findIndex((c, i) => c.event === event && shimCmd(i) === h.command);
          if (idx < 0) refuse('hooks.json carries a hook-shim command that is not in the trusted record');
        } else {
          idx = rec.commands.findIndex((c) => c.event === event && c.command === h.command);
          if (idx < 0) {
            if (!trusted) refuse('hooks.json is container-writable and carries a hook command missing from the trusted record');
            rec.commands.push({ event, command: h.command, timeoutSec: typeof h.timeout === 'number' ? h.timeout : undefined });
            idx = rec.commands.length - 1;
          }
        }
        seen.add(idx);
        h.command = shimCmd(idx);
      }
    }
  }
  // Fail closed on a resume: a container-side edit cannot drop a trusted hook.
  if (!trusted) {
    for (let i = 0; i < rec.commands.length; i++) {
      if (!seen.has(i)) refuse('hooks.json no longer registers trusted hook #' + i + ' (' + rec.commands[i].event + ')');
    }
  }
  fs.mkdirSync(b.recordDir, { recursive: true, mode: 0o700 });
  const tmpRec = recPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpRec, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmpRec, recPath);
  if (doc) {
    const tmpDoc = hooksPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmpDoc, JSON.stringify(doc, null, 2) + '\\n');
    fs.renameSync(tmpDoc, hooksPath);
  }
  return { name, token: rec.token };
}
// Fail closed (D-032): if the shim cannot reach the bridge from inside the container, no hook would run.
function pingBridge(b, s) {
  const r = spawnSync(cfg.dockerBin, [...cfg.dockerArgs, 'exec', cfg.containerId, b.shimPath, b.url, s.name, s.token, 'ping'],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: b.pingTimeoutMs });
  if (r.error) refuse('cannot ping the hook bridge: ' + r.error.message);
  if (r.status !== 0) {
    refuse('the hook bridge is unreachable from inside the container (exit ' + r.status + '): ' +
      String(r.stderr || '').trim().slice(0, 300) + '; refusing to run the agent without its hooks');
  }
}
// Origin rewrite (D-033 step 2): inside the container 127.0.0.1 is the container's own loopback. Map each host origin
// config.toml names to its egress origin, then fail closed on any loopback origin left. Runs after relocate(), on the
// file the agent will read, and refuses BEFORE writing, so a refusal leaves the file as the operator wrote it.
function rewriteOrigins(o, sessionEnv) {
  const home = process.env[sessionEnv];
  if (!home) refuse(sessionEnv + ' is unset; cannot rewrite its config origins');
  const file = path.join(home, 'config.toml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { refuse('cannot read ' + file + ' to rewrite its origins: ' + e.message); }
  const next = o.pattern ? text.replace(new RegExp(o.pattern, 'g'), (m) => o.map[m]) : text;
  const left = new Set();
  for (const line of next.split('\\n')) {
    if (/^\\s*#/.test(line)) continue;
    for (const m of line.match(new RegExp(o.loopback, 'gi')) || []) left.add(m);
  }
  if (left.size) {
    refuse(file + ' still names loopback origin(s) ' + [...left].join(', ') +
      ' with no egress mapping; inside the container they would dial the container itself');
  }
  if (next !== text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, next, { mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(tmp, file);
  }
}
// Host-only lifecycle control, invoked through the SHA-bound native executable
// before home repair. Preserve native bytes/inodes/private modes; return only
// this relocated session, never a shared root or a sibling session.
if (process.argv.length === 3 && process.argv[2] === '--papercusp-return-session-ownership') {
  const r = cfg.relocation;
  const home = r && process.env[r.sessionEnv];
  if (!home || path.resolve(path.dirname(home)) !== r.roots[0].hostRoot)
    refuse('ownership return requires the exact session home');
  const uid = process.getuid && process.getuid(), gid = process.getgid && process.getgid();
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) refuse('ownership return requires host credentials');
  const name = path.basename(home), paths = [];
  for (const root of r.roots) {
    const src = path.join(root.hostRoot, name), dst = path.join(root.perTaskDir, name);
    let st;
    try { st = fs.lstatSync(src); } catch (e) {
      if (e.code === 'ENOENT') continue;
      refuse('cannot inspect ownership return binding');
    }
    if (st.isDirectory()) continue; // fresh, not yet container-writable
    if (!st.isSymbolicLink() || path.resolve(path.dirname(src), fs.readlinkSync(src)) !== dst)
      refuse('ownership return binding changed');
    paths.push(src);
  }
  if (paths.length) {
    const returned = spawnSync(cfg.dockerBin, [...cfg.dockerArgs, 'exec', '-u', '0', cfg.containerId,
      'chown', '-hR', uid + ':' + gid, ...paths], { stdio: 'ignore', timeout: 10000 });
    if (returned.error || returned.status !== 0) refuse('session ownership return failed');
  }
  process.exit(0);
}
const bridged = cfg.hookBridge ? bridgeHooks(cfg.hookBridge, cfg.relocation.sessionEnv) : null;
if (cfg.relocation) relocate(cfg.relocation);
if (cfg.originRewrite) rewriteOrigins(cfg.originRewrite, cfg.relocation.sessionEnv);
if (bridged) pingBridge(cfg.hookBridge, bridged);
const forward = cfg.forward.map((s) => new RegExp(s));
const never = cfg.never.map((s) => new RegExp(s));
const names = Object.keys(process.env)
  .filter((k) => forward.some((r) => r.test(k)) && !never.some((r) => r.test(k)))
  .sort();
const argv = [...cfg.dockerArgs, 'exec', '-i'];
if (process.stdin.isTTY && process.stdout.isTTY) argv.push('-t');
argv.push('-w', cfg.workdir);
for (const n of names) argv.push('-e', n);
let identity;
if (tracksNative) {
  identity = { pid: process.pid, start: processStart(process.pid), marker: crypto.randomBytes(32).toString('hex') };
  // This directory is host-only (never one of the session relocation mounts).
  if ((fs.statSync(path.dirname(__filename)).mode & 0o077) !== 0) refuse('native identity directory must be private');
  fs.writeFileSync(identityPath(process.pid), JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  process.on('exit', () => { try { fs.unlinkSync(identityPath(process.pid)); } catch {} });
}
argv.push(cfg.containerId, ...(identity ? ['/bin/sh', '-c', 'exec "$@"', identity.marker] : []),
  cfg.binPath, ...cfg.codexWorkdirArgs, ...process.argv.slice(2));
const child = spawn(cfg.dockerBin, argv, { stdio: 'inherit' });
const relay = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const sig of relay) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on('error', (e) => {
  process.stderr.write('papercusp container-exec: cannot run ' + cfg.dockerBin + ': ' + e.message + '\\n');
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (signal) {
    for (const sig of relay) process.removeAllListeners(sig);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 1 : code);
});
`;
}

export interface MaterializeWrapperOptions extends RenderWrapperOptions {
  /** Directory to write into. Linux device/proc namespaces cannot hold a native wrapper. */
  dir?: string;
  /** File name = the agent psu resolves. Default 'codex'. */
  agent?: string;
}

/** Write the wrapper as an executable `<dir>/<agent>` and return its absolute path. */
export function materializeDockerExecWrapper(
  target: DockerExecTarget,
  opts: MaterializeWrapperOptions = {},
): { dir: string; wrapperPath: string; nativeBoundary: NativeContainerExecBinding } {
  const agent = opts.agent ?? 'codex';
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) throw new Error(`container exec target: invalid agent name ${JSON.stringify(agent)}`);
  // Native launchers deliberately scrub the inherited host environment. Keep
  // the daemon that allocated this container in the immutable wrapper, so both
  // hook pings and agent execs still reach it after that scrub.
  const source = renderDockerExecWrapper(target, { ...opts, dockerHost: opts.dockerHost ?? process.env.DOCKER_HOST });
  // The metered native launcher replaces /dev before applying its executable
  // read grants. A valid host file under /dev/shm is therefore absent there.
  // Resolve aliases too, and keep the existing short /tmp native-root policy.
  const masked = (path: string) => process.platform === 'linux' && /^\/(dev|proc)(\/|$)/.test(path);
  let parent = realpathSync(opts.dir ?? tmpdir());
  if (masked(parent)) {
    if (opts.dir) throw new Error('container exec target: wrapper directory is masked by the native device namespace');
    parent = realpathSync('/tmp');
    if (masked(parent)) throw new Error('container exec target: native temporary root is masked by the device namespace');
  }
  const dir = opts.dir ? parent : mkdtempSync(join(parent, 'papercusp-cexec-'));
  const wrapperPath = join(dir, agent);
  writeFileSync(wrapperPath, source, { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);
  return { dir, wrapperPath, nativeBoundary: { kind: 'docker-exec', command: wrapperPath,
    sha256: createHash('sha256').update(source).digest('hex') } };
}
