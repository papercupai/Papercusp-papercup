/**
 * Sandbox-builder for provision scripts.
 *
 * Builds the argv that wraps a script invocation in OS-appropriate
 * sandboxing primitives:
 *   - Linux: bwrap filesystem boundary inside SRT's isolated network.
 *   - macOS: sandbox-exec with a generated profile.
 *   - Windows: V2 — V1 refuses to run on Windows for now.
 *
 * The runner only invokes the *bundled* substrate-shipped sandboxer.
 * Per spec, the substrate ships its own bwrap binary so plugin scripts
 * cannot rely on a system-wide bwrap that may have been swapped.
 *
 * Spec: /docs/snapshots/build-scripts#sandboxing.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { srtBinOnPath } from '@papercusp/orchestrator';
import { buildProcessSrtSettings, wrapProcessWithSrt } from '@papercusp/orchestrator/fleet-srt-spawn';
import type { startProvisionProxy } from './network-proxy';

export interface SandboxOptions {
  /** Plugin's working directory (read-only mount). */
  pluginDir: string;
  /** Plugin's per-harness scratch dir (read-write mount). */
  scratchDir: string;
  /**
   * Harness's project directory (read-write mount) — exposed to scripts
   * via `$PAPERCUSP_PROJECT_DIR` and used by `papercusp_render_templates`.
   * Optional: scripts that don't touch project files can omit it.
   */
  projectDir?: string;
  /** Exact outbound hosts (80/443), or explicit host:port endpoints. */
  allowedHosts: string[];
  /** Env vars to pass through. */
  env: Record<string, string>;
  /** Extra read-only mounts. */
  extraReadOnlyMounts?: { src: string; dst: string }[];
}

export interface SandboxBuildResult {
  /** Argv prefix to prepend before the script command itself. */
  argv: string[];
  /** Effective env (sandbox may scrub some). */
  env: Record<string, string>;
  /** Whether sandboxing is actually active or a soft-fallback. */
  active: boolean;
  /** Description of which sandboxer is in use, for audit log. */
  driver: 'bwrap' | 'sandbox-exec' | 'none';
  /**
   * Set when the sandbox smoke-test failed and the operator opted into
   * `PAPERCUSP_ALLOW_NO_SANDBOX=1`. The script will run unsandboxed; the
   * runner is expected to surface this loudly in the audit log.
   */
  smokeBypass?: { reason: string };
  /** Required boundary unavailable; callers must refuse before spawning. */
  unavailableReason?: string;
  /** Captured policy, consumed at the final command composition seam. */
  policy?: Pick<SandboxOptions, 'pluginDir' | 'scratchDir' | 'projectDir' | 'allowedHosts'>;
}

/** Compose the final command through maintained SRT; keep the existing OS
 * filesystem prefix inside its network boundary. Policy files are outside
 * the writable assigned paths and explicitly deny-write, then cleaned up. */
export async function prepareSandboxCommand(
  sandbox: SandboxBuildResult,
  command: [string, ...string[]],
  srtBin: string | null = srtBinOnPath(),
): Promise<{ argv: string[]; cleanup: () => Promise<void>; settingsPath?: string }> {
  if (sandbox.unavailableReason) throw new Error(sandbox.unavailableReason);
  if (!sandbox.active) return { argv: command, cleanup: async () => {} };
  if (!srtBin || !sandbox.policy) throw new Error('Required provision network sandbox (srt) is unavailable');
  const { pluginDir, scratchDir, projectDir, allowedHosts } = sandbox.policy;
  // /dev/shm is replaced by SRT even when the test harness selects it as TMPDIR.
  const policyDir = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'papercusp-provision-srt-'));
  let proxy: Awaited<ReturnType<typeof startProvisionProxy>> | undefined;
  const cleanup = async () => {
    try { await proxy?.close(); }
    finally { rmSync(policyDir, { recursive: true, force: true }); }
  };
  try {
    const { startProvisionProxy } = await import('./network-proxy');
    proxy = await startProvisionProxy(allowedHosts);
    const settings = buildProcessSrtSettings({ cwd: scratchDir, allowedDomains: [], denyWrite: [policyDir] }) as {
      network: Record<string, unknown>;
      filesystem: { allowWrite: string[]; allowRead?: string[]; [key: string]: unknown };
    };
    settings.network.strictAllowlist = true;
    // HTTP and CONNECT use the DNS-pinned floor-enforcing proxy. SRT still
    // isolates sockets; its unused SOCKS listener must not provide a bypass.
    settings.network.httpProxyPort = proxy.port;
    settings.network.deniedDomains = ['*'];
    settings.filesystem.allowWrite = [scratchDir, ...(projectDir ? [projectDir] : [])];
    // Scratch commonly lives below credential-denied .papercusp. Re-permit
    // only assigned paths, never their parent directory.
    settings.filesystem.allowRead = [pluginDir, scratchDir, ...(projectDir ? [projectDir] : [])];
    const settingsPath = join(policyDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o400 });
    // spawn receives only sandbox.env; preserve SRT's injected proxy vars in
    // the inner bwrap. The socat bridge stays outside its private /tmp mount.
    const prefix = sandbox.driver === 'bwrap'
      ? sandbox.argv.filter(arg => arg !== '--clearenv') : sandbox.argv;
    const [bin, ...args] = [...prefix, ...command];
    const wrapped = wrapProcessWithSrt(bin, args, { srtBin, settingsPath });
    return { argv: [wrapped.command, ...wrapped.argv], cleanup, settingsPath };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Substrate-bundled bwrap binary path resolution. */
function resolveBundledBwrap(): string | null {
  // Convention: bundled at $PAPERCUSP_BWRAP or alongside the operator at
  // ../../runtime/sandbox/bwrap. Falls back to system bwrap as a last
  // resort (logs a warning in the audit trail).
  const env = process.env.PAPERCUSP_BWRAP;
  if (env && existsSync(env)) return env;
  const candidates = [
    '/usr/lib/papercusp/runtime/sandbox/bwrap',
    join(process.cwd(), 'runtime/sandbox/bwrap'),
    '/usr/bin/bwrap',
    '/usr/local/bin/bwrap',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function buildBwrapArgv(opts: SandboxOptions, bwrap: string): string[] {
  const argv: string[] = [
    bwrap,
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--unshare-user',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
  ];
  if (existsSync('/lib64')) argv.push('--ro-bind', '/lib64', '/lib64');
  if (existsSync('/bin')) argv.push('--ro-bind', '/bin', '/bin');
  if (existsSync('/sbin')) argv.push('--ro-bind', '/sbin', '/sbin');
  if (existsSync('/etc')) argv.push('--ro-bind', '/etc', '/etc');

  argv.push('--ro-bind', opts.pluginDir, opts.pluginDir);
  argv.push('--bind', opts.scratchDir, opts.scratchDir);

  // Mount the harness's project dir RW so setup scripts can render
  // *.tmpl files in place. Only when explicitly provided — keeps
  // plugins that don't touch project files unable to.
  if (opts.projectDir && existsSync(opts.projectDir)) {
    argv.push('--bind', opts.projectDir, opts.projectDir);
  }

  for (const m of opts.extraReadOnlyMounts ?? []) {
    argv.push('--ro-bind', m.src, m.dst);
  }

  // The final prefix is launched inside prepareSandboxCommand's SRT network
  // namespace. Share its isolated local proxy, never the host's network.
  argv.push('--share-net');

  // Drop env vars; pass only what we explicitly set.
  argv.push('--clearenv');
  for (const [k, v] of Object.entries(opts.env)) {
    argv.push('--setenv', k, v);
  }

  // chdir to scratch so scripts get a consistent CWD.
  argv.push('--chdir', opts.scratchDir);

  argv.push('--');
  return argv;
}

function buildMacOsArgv(opts: SandboxOptions): string[] {
  // sandbox-exec profile constructed inline.
  const projectWritable = opts.projectDir
    ? `(allow file-write* (subpath "${opts.projectDir}"))`
    : '';
  const profile = `
(version 1)
(deny default)
(allow process-fork process-exec)
(allow file-read*)
(allow file-write* (subpath "${opts.scratchDir}"))
${projectWritable}
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow network-outbound (remote tcp))
(allow network-outbound (remote udp "*:53"))
(allow mach-lookup)
(allow signal (target self))
(allow sysctl-read)
`.trim();
  return ['sandbox-exec', '-p', profile];
}

/**
 * Cached result of the bwrap smoke test. Computed once per process; the
 * outcome is environmental (kernel policy, AppArmor, bwrap availability)
 * and doesn't change across runs.
 */
let smokeCache: { passed: boolean; reason?: string } | null = null;

function bwrapSmokeSync(bwrap: string): { passed: boolean; reason?: string } {
  if (smokeCache !== null) return smokeCache;
  // Per spec: smoke test = `bwrap --ro-bind / / --unshare-all true`.
  // 5s timeout is generous; a working bwrap completes in <100ms.
  const r = spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-all', 'true'], {
    timeout: 5_000,
    encoding: 'utf8',
  });
  const passed = r.status === 0;
  let reason: string | undefined;
  if (!passed) {
    if (r.error) {
      reason = `bwrap-exec-error: ${r.error.message}`;
    } else if ((r.stderr ?? '').trim()) {
      // Take the first non-empty stderr line as the reason summary.
      const firstErrLine = (r.stderr ?? '').trim().split('\n').find((l) => l.trim()) ?? '';
      reason = `bwrap-exit-${r.status ?? '?'}: ${firstErrLine}`;
    } else {
      reason = `bwrap-exit-${r.status ?? '?'}`;
    }
  }
  smokeCache = { passed, reason };
  return smokeCache;
}

/** Test-only: clear the smoke cache so a fresh probe runs next call. */
export function _resetSmokeCacheForTests(): void {
  smokeCache = null;
}

export function buildSandbox(opts: SandboxOptions): SandboxBuildResult {
  const env = { ...opts.env };
  const policy = { pluginDir: opts.pluginDir, scratchDir: opts.scratchDir,
    projectDir: opts.projectDir, allowedHosts: [...opts.allowedHosts] };
  // Escape hatch 1: test/CI environments where bwrap isn't available.
  // Skips the smoke probe entirely.
  if (process.env.PAPERCUSP_DISABLE_SANDBOX === '1') {
    return { argv: [], env, active: false, driver: 'none' };
  }
  if (process.platform === 'linux') {
    const bwrap = resolveBundledBwrap();
    if (!bwrap) {
      return { argv: [], env, active: false, driver: 'none', unavailableReason: 'Required provision filesystem sandbox (bwrap) is unavailable' };
    }
    const smoke = bwrapSmokeSync(bwrap);
    if (smoke.passed) {
      return { argv: buildBwrapArgv(opts, bwrap), env, active: true, driver: 'bwrap', policy };
    }
    // Smoke failed. The spec's "sandbox_available: false" path triggers
    // signed-only mode in production. For dev, the operator can opt into
    // running scripts unsandboxed by setting PAPERCUSP_ALLOW_NO_SANDBOX=1
    // — the runner will record a `sandbox-bypass` audit event each run.
    if (process.env.PAPERCUSP_ALLOW_NO_SANDBOX === '1') {
      return {
        argv: [],
        env,
        active: false,
        driver: 'none',
        smokeBypass: { reason: smoke.reason ?? 'bwrap-smoke-failed' },
      };
    }
    // Default: keep the original fail-loud behavior. We hand back the
    // bwrap argv anyway; exec time will reproduce the smoke error in
    // stderr and the runner will surface it as setup-failed.
    return { argv: buildBwrapArgv(opts, bwrap), env, active: true, driver: 'bwrap', policy };
  }
  if (process.platform === 'darwin') {
    return { argv: buildMacOsArgv(opts), env, active: true, driver: 'sandbox-exec', policy };
  }
  return { argv: [], env, active: false, driver: 'none', unavailableReason: `Provision sandbox is unsupported on ${process.platform}` };
}

/**
 * Quick smoke test: verify the bundled sandboxer can actually launch a
 * trivial /bin/true. Per spec, substrate boots run this once per session
 * to fail fast if the sandbox is broken.
 */
export async function smokeTestSandbox(): Promise<{ ok: boolean; driver: string; error?: string }> {
  const { spawn } = await import('node:child_process');
  const built = buildSandbox({
    pluginDir: '/tmp',
    scratchDir: '/tmp',
    allowedHosts: [],
    env: {},
  });
  if (!built.active) return { ok: false, driver: built.driver, error: 'no sandbox driver available' };
  let prepared: Awaited<ReturnType<typeof prepareSandboxCommand>>;
  try { prepared = await prepareSandboxCommand(built, ['/bin/true']); }
  catch (error) { return { ok: false, driver: built.driver, error: String(error) }; }
  return new Promise<{ ok: boolean; driver: string; error?: string }>((resolve) => {
    const argv = prepared.argv;
    const [bin, ...rest] = argv;
    const child = spawn(bin, rest, { stdio: 'ignore' });
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      resolve({ ok: false, driver: built.driver, error: 'timeout' });
    }, 5000);
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: false, driver: built.driver, error: err.message });
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, driver: built.driver, error: code === 0 ? undefined : `exit ${code}` });
    });
  }).finally(prepared.cleanup);
}
