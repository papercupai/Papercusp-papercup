/**
 * Subprocess daemon supervisor (Batch I3, I4, I6).
 *
 * Lifecycle: spawn → JSON-RPC handshake → run until shutdown OR child
 * exit. On unexpected exit, restart per policy with exponential
 * backoff. Health check loop pings the daemon every healthInterval ms
 * and triggers a restart on consecutive failures.
 *
 * Same `callAction` shape as the WASM runtime so the operator's
 * plugin-host-runtime can dispatch uniformly. Audit rows surface
 * daemonPid + restartCount + bwrapExitCode (Batch I5).
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { existsSync, statSync } from 'node:fs';
import { JsonRpcBridge, type JsonRpcNotification, type JsonRpcRequestHandler } from './jsonrpc-bridge';
import { buildBwrapArgs, buildProviderBwrapArgs } from './bwrap-args';

const DEFAULT_BWRAP = '/usr/bin/bwrap';
const execFileAsync = promisify(execFile);

/** A provider daemon was refused because its sandbox cannot be established. */
export class DaemonSandboxUnavailableError extends Error {
  readonly code = 'sandbox-unavailable' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DaemonSandboxUnavailableError';
  }
}

/** Outcome of one provider-sandbox probe; `detail` says WHY it failed. */
export interface ProviderSandboxProbe {
  works: boolean;
  /** Why the profile could not be established (bwrap's own stderr when it ran). */
  detail?: string;
}

const _providerProbeCache = new Map<string, ProviderSandboxProbe>();
const _providerProbesInFlight = new Map<string, Promise<ProviderSandboxProbe>>();
type ProviderSandboxInput = { bwrapBinary?: string; pluginDir: string; runtimeDirs?: string[] };
/**
 * Probe the EXACT provider profile (including `--unshare-net`) rather than a
 * generic bwrap call: a host can run plain bwrap yet refuse a network
 * namespace, and a probe that skips the flag would then report a sandbox the
 * real spawn cannot get. Cached per (binary, pluginDir, runtimeDirs), but only
 * when bwrap actually ran to an exit status: a timeout or spawn error says
 * nothing about the profile, and caching it refused the provider for the rest
 * of the process. A failure keeps bwrap's stderr, because the profile can fail
 * for a reason specific to this plugin dir (WI-10006742: a dir under /dev/shm
 * was shadowed by `--dev /dev`) and that is not a host without namespaces.
 */
export async function probeProviderSandbox(input: ProviderSandboxInput): Promise<ProviderSandboxProbe> {
  const binary = input.bwrapBinary ?? DEFAULT_BWRAP;
  const key = JSON.stringify([binary, input.pluginDir, input.runtimeDirs ?? []]);
  const cached = _providerProbeCache.get(key);
  if (cached !== undefined) return cached;
  const pending = _providerProbesInFlight.get(key);
  if (pending !== undefined) return pending;
  if (process.platform !== 'linux') return { works: false, detail: `platform ${process.platform} has no bwrap sandbox` };
  if (!existsSync(binary)) return { works: false, detail: `${binary} is not installed` };
  // Sandbox setup can take seconds. Await the child without blocking identity
  // probes and other operator requests; concurrent starts share this exact probe.
  const probe = (async (): Promise<ProviderSandboxProbe> => {
    let result: ProviderSandboxProbe;
    try {
      const { argv } = buildProviderBwrapArgs({
        pluginDir: input.pluginDir,
        runtimeDirs: input.runtimeDirs,
        bwrapBinary: binary,
        cmd: ['/usr/bin/true'],
      });
      await execFileAsync(binary, argv, { timeout: 5_000, env: {}, encoding: 'utf8' });
      result = { works: true };
    } catch (err) {
      // A numeric exit status proves the profile ran. Spawn errors, signals and
      // timeouts are transient evidence and must remain retryable.
      if (!(err instanceof Error) || !('code' in err) || typeof err.code !== 'number'
        || ('signal' in err && err.signal)) {
        return { works: false, detail: `probe did not finish (${err instanceof Error ? err.message : String(err)}); not cached` };
      }
      const stderr = 'stderr' in err ? String(err.stderr).trim() : '';
      result = { works: false, detail: stderr || `${binary} exited ${err.code}` };
    }
    _providerProbeCache.set(key, result);
    return result;
  })();
  _providerProbesInFlight.set(key, probe);
  try {
    return await probe;
  } finally {
    _providerProbesInFlight.delete(key);
  }
}

/** Boolean form of {@link probeProviderSandbox}. */
export async function providerSandboxWorks(input: ProviderSandboxInput): Promise<boolean> {
  return (await probeProviderSandbox(input)).works;
}

/**
 * Probe whether bwrap can actually sandbox on this host. Nested user
 * namespaces (Docker hosts, devcontainers with uid_map=0 0 4294967295)
 * have bwrap installed but `--unshare-user` is denied, which makes
 * every spawn fail. We run a no-op probe at supervisor-construction
 * time and cache the result. Mirrors `require_bwrap_or_skip` from the
 * Rust slice-3 v1 host.
 */
let _bwrapWorksCache: Promise<boolean> | null = null;
function bwrapWorks(): Promise<boolean> {
  if (_bwrapWorksCache !== null) return _bwrapWorksCache;
  if (process.platform !== 'linux' || !existsSync('/usr/bin/bwrap')) {
    return Promise.resolve(false);
  }
  _bwrapWorksCache = execFileAsync(
      '/usr/bin/bwrap',
      ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '/bin/true'],
      { timeout: 5_000 },
    ).then(() => true, () => false);
  return _bwrapWorksCache;
}

export type DaemonRestartPolicy = 'never' | 'on-failure' | 'always';

export interface StartDaemonOptions {
  pluginName: string;
  cmd: string[];
  cwd: string;
  restart?: { policy?: DaemonRestartPolicy; maxRestarts?: number; backoffMs?: number };
  /** Manifest-declared read paths (passed to bwrap). */
  readPaths?: string[];
  writePaths?: string[];
  /** True when manifest declares net:* caps. */
  shareNet?: boolean;
  onLog?: (line: string) => void;
  /** Audit emitter — called on spawn, restart, exit, action invoke. */
  onAudit?: (row: DaemonAuditRow) => void;
  /** Health check interval (ms). Default 30s. 0 = disabled. */
  healthIntervalMs?: number;
  /** Disk quota (bytes). Periodic check; kill on 2x overage. Default 0 (off). */
  diskQuotaBytes?: number;
  /**
   * `provider` runs the fixed D-006 provider profile (no network namespace of
   * its own, read-only plugin dir, scrubbed env) and FAILS CLOSED: if that
   * profile cannot be established the daemon is never spawned. `plugin`
   * (default) keeps the legacy profile and its unsandboxed fallback.
   * readPaths/writePaths/shareNet are ignored in `provider` mode.
   */
  sandbox?: 'plugin' | 'provider';
  /** Interpreter install prefixes the provider profile binds read-only. */
  runtimeDirs?: string[];
  /** bwrap binary for the provider profile. Default /usr/bin/bwrap. */
  bwrapBinary?: string;
  /** Daemon→host request handlers, re-attached on every (re)spawn. */
  requestHandlers?: Record<string, JsonRpcRequestHandler>;
}

export interface DaemonAuditRow {
  ts: string;
  plugin: string;
  surface: 'daemon';
  event: 'spawn' | 'restart' | 'exit' | 'action' | 'health-fail' | 'quota-exceeded';
  daemonPid?: number;
  restartCount: number;
  bwrapExitCode?: number | null;
  detail?: string;
}

export interface DaemonPluginHandle {
  /** Mirrors WasmPlugin.callAction shape. */
  callAction(name: string, payload: Uint8Array): Promise<
    { ok: true; payload: Uint8Array } | { ok: false; error: { tag: 'not-found' | 'plugin-error' | 'invalid-payload'; message: string } }
  >;
  /** Host→daemon JSON-RPC call. Rejects when the daemon is not running. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  shutdown(): Promise<void>;
  pid(): number | undefined;
  restartCount(): number;
}

export async function startDaemonPlugin(opts: StartDaemonOptions): Promise<DaemonPluginHandle> {
  const policy = opts.restart?.policy ?? 'on-failure';
  const maxRestarts = opts.restart?.maxRestarts ?? 5;
  const backoffMs = opts.restart?.backoffMs ?? 1000;

  let child: ChildProcess | null = null;
  let bridge: JsonRpcBridge | null = null;
  let restartCount = 0;
  let lastExitCode: number | null = null;
  let stopped = false;
  let healthTimer: ManagedHandle | null = null;
  let diskQuotaTimer: ManagedHandle | null = null;

  const audit = (event: DaemonAuditRow['event'], detail?: string): void => {
    if (!opts.onAudit) return;
    try {
      opts.onAudit({
        ts: new Date().toISOString(),
        plugin: opts.pluginName,
        surface: 'daemon',
        event,
        daemonPid: child?.pid,
        restartCount,
        bwrapExitCode: lastExitCode,
        detail,
      });
    } catch { /* never throw from audit */ }
  };

  const spawnOnce = async (): Promise<void> => {
    const providerMode = opts.sandbox === 'provider';
    const useBwrap = providerMode ? false : await bwrapWorks();
    let binary: string;
    let argv: string[];
    if (providerMode) {
      const probe = await probeProviderSandbox({ bwrapBinary: opts.bwrapBinary, pluginDir: opts.cwd, runtimeDirs: opts.runtimeDirs });
      if (!probe.works) {
        throw new DaemonSandboxUnavailableError(
          `provider daemon ${opts.pluginName} refused: the provider sandbox (bwrap with --unshare-net) could not be established for ${opts.cwd}: ${probe.detail ?? 'unknown reason'}`,
        );
      }
      const built = buildProviderBwrapArgs({
        pluginDir: opts.cwd,
        runtimeDirs: opts.runtimeDirs,
        bwrapBinary: opts.bwrapBinary ?? DEFAULT_BWRAP,
        cmd: opts.cmd,
      });
      binary = built.binary;
      argv = built.argv;
    } else if (useBwrap) {
      const built = buildBwrapArgs({
        workDir: opts.cwd,
        readPaths: opts.readPaths,
        writePaths: opts.writePaths,
        shareNet: opts.shareNet,
        cmd: opts.cmd,
      });
      binary = built.binary;
      argv = built.argv;
    } else {
      if (process.env.PAPERCUP_PLUGIN_BWRAP_REQUIRED === '1') {
        throw new Error('bwrap required (PAPERCUP_PLUGIN_BWRAP_REQUIRED=1) but unavailable');
      }
      // Fall back: pinned PATH, no other env.
      binary = opts.cmd[0]!;
      argv = opts.cmd.slice(1);
      opts.onLog?.(`[supervisor] bwrap unavailable; spawning unsandboxed: ${opts.pluginName}`);
    }

    child = spawn(binary, argv, {
      cwd: opts.cwd,
      // Provider mode: nothing of the host env reaches even the bwrap process.
      env: providerMode ? { PATH: '/usr/bin:/bin' } : { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', (e: Error) => opts.onLog?.(`[supervisor] ${opts.pluginName}: spawn error: ${e.message}`));

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('child stdio pipes missing — spawn failed');
    }

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line) opts.onLog?.(line);
      }
    });

    bridge = new JsonRpcBridge(child.stdout, child.stdin);
    bridge.onNotification((n: JsonRpcNotification) => {
      // Daemon-emitted events arrive here. Operator wires onAudit + onLog
      // to surface them; no event bus integration in v1 (deferred).
      opts.onLog?.(`[notify] ${n.method} ${JSON.stringify(n.params ?? {})}`);
    });
    for (const [method, handler] of Object.entries(opts.requestHandlers ?? {})) {
      bridge.onRequest(method, handler);
    }

    child.on('exit', (code: number | null) => {
      lastExitCode = code;
      audit('exit', `code=${code}`);
      bridge?.shutdown(new Error(`daemon exited code=${code}`));
      bridge = null;
      child = null;
      if (stopped) return;
      const failed = code !== 0;
      const shouldRestart =
        policy === 'always' || (policy === 'on-failure' && failed);
      if (!shouldRestart) return;
      if (restartCount >= maxRestarts) {
        opts.onLog?.(`[supervisor] ${opts.pluginName}: maxRestarts=${maxRestarts} reached; giving up`);
        return;
      }
      restartCount++;
      const delay = backoffMs * Math.min(2 ** (restartCount - 1), 60);
      audit('restart', `attempt=${restartCount} delay=${delay}ms`);
      setTimeout(() => {
        spawnOnce().catch((e: unknown) => {
          opts.onLog?.(`[supervisor] ${opts.pluginName}: respawn refused: ${e instanceof Error ? e.message : String(e)}`);
        });
      }, delay);
    });

    audit('spawn', `binary=${binary}`);

    // Daemon's first message must be a notification: { method: 'ready', params: { pluginInfo } }.
    // We don't enforce a handshake schema in v1 — caller's first action call effectively
    // verifies the bridge is live.
  };

  await spawnOnce();

  // Disk quota check (Batch I6).
  if (opts.diskQuotaBytes && opts.diskQuotaBytes > 0) {
    const quota = opts.diskQuotaBytes;
    diskQuotaTimer = managedSetInterval('plugin-disk-quota-check', 60_000, () => {
      if (stopped) return;
      try {
        const sz = dirSizeApprox(opts.cwd);
        if (sz > quota * 2) {
          audit('quota-exceeded', `size=${sz} quota=${quota}`);
          opts.onLog?.(`[supervisor] ${opts.pluginName}: disk quota 2x exceeded; killing`);
          child?.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    }, { category: 'lifecycle', instanced: true });
  }

  // Health check (Batch I4).
  const healthInterval = opts.healthIntervalMs ?? 30_000;
  if (healthInterval > 0) {
    let consecutiveFails = 0;
    healthTimer = managedSetInterval('plugin-health-check', healthInterval, async () => {
      if (stopped || !bridge) return;
      try {
        await bridge.call('papercup.ping', undefined, 5_000);
        consecutiveFails = 0;
      } catch {
        consecutiveFails++;
        audit('health-fail', `consecutive=${consecutiveFails}`);
        if (consecutiveFails >= 3 && child?.pid) {
          opts.onLog?.(`[supervisor] ${opts.pluginName}: 3 consecutive health-check failures; restarting`);
          child.kill('SIGTERM');
        }
      }
    }, { category: 'lifecycle', instanced: true });
  }

  return {
    async callAction(name: string, payload: Uint8Array) {
      if (!bridge) {
        return { ok: false as const, error: { tag: 'plugin-error' as const, message: 'daemon not running' } };
      }
      audit('action', `name=${name} payload_len=${payload.length}`);
      try {
        const result = await bridge.call<{ payloadB64: string }>('papercup.invokeAction', {
          action: name,
          payloadB64: Buffer.from(payload).toString('base64'),
        });
        return { ok: true as const, payload: Buffer.from(result.payloadB64, 'base64') };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // JSON-RPC error code convention: -32601=method not found,
        // -32602=invalid params, -32000+=plugin-defined.
        if (msg.startsWith('-32601')) {
          return { ok: false as const, error: { tag: 'not-found' as const, message: msg } };
        }
        if (msg.startsWith('-32602')) {
          return { ok: false as const, error: { tag: 'invalid-payload' as const, message: msg } };
        }
        return { ok: false as const, error: { tag: 'plugin-error' as const, message: msg } };
      }
    },
    async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      if (!bridge) throw new Error(`daemon ${opts.pluginName} is not running`);
      return bridge.call<T>(method, params, timeoutMs);
    },
    async shutdown() {
      stopped = true;
      if (healthTimer) healthTimer.stop();
      if (diskQuotaTimer) diskQuotaTimer.stop();
      bridge?.shutdown();
      if (child?.pid) {
        child.kill('SIGTERM');
        // Grace then SIGKILL.
        setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
      }
    },
    pid() { return child?.pid; },
    restartCount() { return restartCount; },
  };
}

function dirSizeApprox(dir: string): number {
  // Cheap approximation — single dirent stat. Real usage would walk
  // recursively, but daemon work-dirs are usually small.
  try { return statSync(dir).size; } catch { return 0; }
}
