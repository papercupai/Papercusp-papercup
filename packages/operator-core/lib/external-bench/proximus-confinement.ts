/** Host boundary for the official Python loop. Reuses the fleet's maintained
 * SRT policy/launcher and the existing process pipes; no daemon socket or new
 * listening service crosses into the worker. Container lifecycle stays in the
 * FrontierSWE seam. */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { buildProcessSrtSettings, rootReadDenyPaths, scopedSandboxReadPaths, wrapProcessWithSrt } from '@papercusp/orchestrator/fleet-srt-spawn';

export interface ProximusTaskBinding {
  containerId: string; image: string; network: string;
  networkMode: 'no-network' | 'public' | 'allowlist';
}

export function prepareProximusSandbox(input: {
  pythonBin: string; trialDir?: string; gatewayBaseURL?: string;
}) {
  if (process.platform !== 'linux') throw new Error('Proximus requires its verified Linux host boundary.');
  const binary = (name: string) => (process.env.PATH ?? '').split(':').filter(Boolean)
    .map(dir => join(dir, name)).find(existsSync);
  const srt = binary('srt'), bwrap = binary('bwrap');
  if (!srt || !bwrap) throw new Error('Proximus requires SRT and bubblewrap; refusing unconfined execution.');
  if (!isAbsolute(input.pythonBin)) throw new Error('Proximus requires an absolute interpreter.');
  const interpreter = realpathSync(input.pythonBin);
  const runtimeRoots = [...new Set([dirname(dirname(input.pythonBin)), dirname(dirname(interpreter))])];
  const here = dirname(fileURLToPath(import.meta.url)), source = join(here, '../../vendor/proximus');
  if (runtimeRoots.includes('/') || runtimeRoots.some(path => ['/home', '/tmp', homedir()].includes(path)))
    throw new Error('Proximus requires an isolated installed Python runtime.');
  const trial = input.trialDir;
  if (trial && (!isAbsolute(trial) || realpathSync(trial) !== trial || trial === '/' ||
      [...runtimeRoots, here, source].some(path => {
        const overlaps = (a: string, b: string) => {
          const rel = relative(a, b);
          return !rel || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
        };
        return overlaps(trial, path) || overlaps(path, trial);
      }))) throw new Error('Proximus trial cannot grant write access to its runtime or host source.');
  const allowedDomains: string[] = [];
  if (input.gatewayBaseURL) {
    const url = new URL(input.gatewayBaseURL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
        input.gatewayBaseURL !== `http://127.0.0.1:${url.port}`)
      throw new Error('Proximus requires its exact loopback gateway.');
    allowedDomains.push(`127.0.0.1:${url.port}`);
  }
  const scratch = mkdtempSync('/tmp/px-host-');
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  try {
    const home = join(scratch, 'home');
    mkdirSync(home, { mode: 0o700 });
    const policy = buildProcessSrtSettings({ cwd: trial ?? scratch, allowedDomains }) as {
      network: Record<string, unknown>; filesystem: Record<string, unknown>;
    };
    Object.assign(policy.network, { strictAllowlist: true, allowAllUnixSockets: false, allowLocalBinding: false });
    Object.assign(policy.filesystem, {
      denyRead: rootReadDenyPaths(readdirSync('/', { withFileTypes: true })),
      allowRead: [scratch, ...(trial ? [trial] : []), ...runtimeRoots, ...scopedSandboxReadPaths(srt),
        join(here, 'proximus-host.py'), join(here, 'proximus-environment.py'), source,
        '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/ld.so.cache',
        '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/nsswitch.conf', '/etc/hosts',
        '/etc/resolv.conf', '/etc/passwd', '/etc/group', '/etc/localtime'],
      allowWrite: [scratch, ...(trial ? [trial] : [])],
      denyWrite: [...runtimeRoots, here, source],
    });
    const settingsPath = join(scratch, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(policy), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: scratch,
      CLAUDE_CODE_TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
      LITELLM_LOCAL_MODEL_COST_MAP: 'True' };
    // SRT starts outside its inner filesystem namespace. Its Node shim may
    // depend on PATH; the inner Python runtime inherits no host credentials.
    env.PATH = process.env.PATH ?? env.PATH;
    return { cleanup, env, cwd: trial ?? scratch,
      wrap(argv: string[]) {
        const wrapped = wrapProcessWithSrt(input.pythonBin, argv, { srtBin: srt, settingsPath });
        const mounts = ['--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--bind', scratch, '/tmp/claude'];
        if (existsSync('/private/tmp/claude')) mounts.push('--bind', scratch, '/private/tmp/claude');
        return { command: bwrap, argv: [...mounts, '--', wrapped.command, ...wrapped.argv] };
      } };
  } catch (error) { cleanup(); throw error; }
}

type CommandResult = { return_code: number; stdout: string; stderr: string };
type DockerExec = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<CommandResult>;
const dockerExec: DockerExec = (args, timeout, signal) => new Promise((resolve, reject) => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  let receipt: CommandResult | undefined, failure: unknown;
  const child = execFile('docker', args, { env, timeout, signal, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error && (error.killed || signal.aborted || typeof error.code !== 'number')) failure = error;
      else receipt = { return_code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr };
    });
  // Abort callbacks can run before process exit. Authority is not handed back
  // until the Docker client has actually closed its streams and been reaped.
  child.once('close', () => failure || !receipt ? reject(new Error('Bound task command did not complete.')) : resolve(receipt));
});

/** Validate in the trusted parent, independently of Python's attachment checks.
 * Only exact inspect and bounded exec forms can reach this assignment's Docker
 * container. Caller text is never interpreted by a host shell. */
export async function createProximusTaskBroker(binding: ProximusTaskBinding, maxWallClockMs: number,
  execute: DockerExec = dockerExec) {
  binding = structuredClone(binding);
  if (!/^[a-f0-9]{64}$/.test(binding.containerId) || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(binding.image) ||
      !/^[a-zA-Z0-9_.-]+$/.test(binding.network) || ['host', 'container'].includes(binding.network) ||
      !['no-network', 'public', 'allowlist'].includes(binding.networkMode) ||
      !Number.isSafeInteger(maxWallClockMs) || maxWallClockMs <= 0)
    throw new Error('Invalid Proximus task broker binding.');
  const abort = new AbortController(), deadline = performance.now() + maxWallClockMs;
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (abort.signal.aborted || ms <= 0) throw new Error('Proximus task broker is closed or expired.');
    return ms;
  };
  let active: Promise<unknown> | undefined;
  const inspect = async () => {
    const result = await execute(['inspect', binding.containerId], Math.min(10_000, remaining()), abort.signal);
    const rows = JSON.parse(result.stdout);
    const row = rows?.[0];
    if (result.return_code !== 0 || !Array.isArray(rows) || rows.length !== 1 ||
        row?.Id !== binding.containerId || row.State?.Running !== true || row.Config?.Image !== binding.image ||
        row.HostConfig?.Privileged !== false || ['host'].includes(row.HostConfig?.PidMode) ||
        ['host'].includes(row.HostConfig?.IpcMode) || !Array.isArray(row.Mounts) || row.Mounts.length ||
        ![binding.network, ...(binding.network === 'bridge' ? ['default'] : [])].includes(row.HostConfig?.NetworkMode) ||
        Object.keys(row.NetworkSettings?.Networks ?? {}).join(',') !== binding.network)
      throw new Error('Proximus task container escaped its frozen isolation binding.');
    if (binding.networkMode !== 'public' && binding.network !== 'none') {
      const network = await execute(['network', 'inspect', binding.network], Math.min(10_000, remaining()), abort.signal);
      const networks = JSON.parse(network.stdout);
      if (network.return_code !== 0 || !Array.isArray(networks) || networks.length !== 1 || networks[0].Internal !== true)
        throw new Error('Proximus task network no longer enforces its frozen policy.');
    }
    return { Id: row.Id, State: { Running: true }, Config: { Image: row.Config.Image },
      HostConfig: { NetworkMode: row.HostConfig.NetworkMode }, NetworkSettings: { Networks: row.NetworkSettings.Networks } };
  };
  await inspect();
  return {
    async command(value: unknown, timeout: unknown): Promise<CommandResult> {
      if (active) throw new Error('Proximus task commands must be serialized.');
      remaining();
      if (!Array.isArray(value) || value.length > 256 || value.some(v => typeof v !== 'string' || v.includes('\0')) ||
          JSON.stringify(value).length > 1024 * 1024 || typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
        throw new Error('Invalid Proximus task command.');
      const args = value as string[];
      active = (async () => {
        if (args.length === 2 && args[0] === 'inspect' && args[1] === binding.containerId)
          return { return_code: 0, stdout: JSON.stringify([await inspect()]), stderr: '' };
        if (args.join('\0') === ['network', 'inspect', binding.network].join('\0')) {
          await inspect();
          return { return_code: 0, stdout: JSON.stringify([{ Internal: binding.networkMode !== 'public' }]), stderr: '' };
        }
        if (args[0] !== 'exec') throw new Error('Proximus task lifecycle is not worker authority.');
        let offset = 1;
        const flags = new Set<string>();
        while (['--user', '--workdir', '--env'].includes(args[offset])) {
          const flag = args[offset++], val = args[offset++];
          if (!val || flag !== '--env' && flags.has(flag) ||
              flag === '--env' && !/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(val) ||
              flag === '--workdir' && !val.startsWith('/') || flag === '--user' && !/^[a-zA-Z0-9_.:-]+$/.test(val))
            throw new Error('Invalid Proximus task exec overlay.');
          flags.add(flag);
        }
        await inspect();
        // The adapter's initial availability probe is also fixed-container.
        if (args.slice(offset).join('\0') === [binding.containerId, 'bash', '-lc', 'command -v timeout >/dev/null'].join('\0'))
          return execute(args, Math.min(10_000, remaining()), abort.signal);
        const tail = args.slice(offset);
        if (tail.length !== 8 || tail[0] !== binding.containerId || tail[1] !== 'timeout' ||
            tail[2] !== '--signal=TERM' || tail[3] !== '--kill-after=1s' || tail[5] !== 'bash' || tail[6] !== '-lc' ||
            !/^(\d+(\.\d+)?|\.\d+)s$/.test(tail[4])) throw new Error('Proximus exec must target its bound task with a hard deadline.');
        const seconds = Math.min(Number(tail[4].slice(0, -1)), timeout, remaining() / 1000);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Proximus task deadline expired.');
        tail[4] = `${seconds}s`;
        return execute([...args.slice(0, offset), ...tail], Math.min(Math.ceil(seconds * 1000 + 2000), remaining()), abort.signal);
      })();
      try { return await active as CommandResult; } finally { active = undefined; }
    },
    async stop() { abort.abort(); await active?.catch(() => {}); },
  };
}
