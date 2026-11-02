/** P-002: trial-owned containers over the maintained bounded ProcExec lifecycle.
 * The game and trusted bot share a network namespace with no external interface.
 * Participant JS runs in a third network-none container with only a gameplay RPC
 * socket. Server files, operator credentials and Docker are never mounted there.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { liveProcExec } from './grader/index';
import type { ProcExec } from './grader/swe-bench-pro';
import { assertMinecraftTrialIdentity, minecraftRuntimeMeasurementSchema,
  type FrozenMinecraftTrial } from './minecraft-protocol';

export const MINECRAFT_RUNTIME_LABEL = 'papercusp.minecraft-runtime';
const imagePin = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const safePath = (path: string) => isAbsolute(path) && !/[\r\n,]/.test(path);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export interface MinecraftRuntimeConfig {
  trial: FrozenMinecraftTrial;
  serverJar: string;
  /** Exact locally built bot image digest, including its npm lockfile/assets. */
  botImage: string;
  acceptEula: boolean;
  workRoot?: string;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
  exec?: ProcExec;
}
export interface MinecraftStopReport {
  removed: boolean;
  errors: string[];
  /** Host-only world, config and server evidence; never returned to a program. */
  evidenceDir: string;
}
export interface MinecraftRuntime {
  runtimeId: string;
  trial: FrozenMinecraftTrial;
  measurement: ReturnType<typeof minecraftRuntimeMeasurementSchema.parse>;
  execute(participant: string, source: string): Promise<{ ok: boolean; value?: unknown; error?: string }>;
  stop(): Promise<MinecraftStopReport>;
  dispose(): Promise<MinecraftStopReport>;
}

export interface MinecraftRuntimeSnapshot {
  runtimeId: string;
  trial: FrozenMinecraftTrial;
  startedAtMs: number;
  stoppedAtMs: number;
  files: Record<string, string | null>;
  provenance: {
    source: 'host-collected-server-files';
    deterministicReplay: false;
    nondeterministicInputs: string[];
  };
}
const ownedRuntimes = new WeakMap<MinecraftRuntime, () => Promise<MinecraftRuntimeSnapshot>>();
/** Host-only: a caller-supplied object or path can never stand in for a runtime. */
export async function readMinecraftRuntimeSnapshot(runtime: MinecraftRuntime): Promise<MinecraftRuntimeSnapshot> {
  const read = ownedRuntimes.get(runtime);
  if (!read) throw Error('Minecraft evidence requires an owned runtime');
  return read();
}
export function minecraftOfflinePlayerUuid(name: string): string { return offlineUuid(name); }

function offlineUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  bytes[6] = (bytes[6]! & 15) | 48; bytes[8] = (bytes[8]! & 63) | 128;
  const text = bytes.toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export async function startMinecraftRuntime(config: MinecraftRuntimeConfig): Promise<MinecraftRuntime> {
  const trial = assertMinecraftTrialIdentity(config.trial.trialId, config.trial.protocol);
  if (!config.acceptEula) throw Error('Minecraft server EULA acceptance is required');
  if (!safePath(config.serverJar) || config.workRoot && !safePath(config.workRoot)) throw Error('Invalid Minecraft asset path');
  if (!imagePin.test(trial.protocol.pins.serverImage) || !imageId.test(config.botImage)) throw Error('Immutable Minecraft image pins required');
  if (trial.protocol.participants.some(name => !/^[a-zA-Z0-9_]{1,16}$/.test(name))) throw Error('Invalid Minecraft player name');
  if (config.signal?.aborted) throw Error('Minecraft trial cancelled before startup');
  if (digest(await readFile(config.serverJar)) !== trial.protocol.pins.serverJarSha256) throw Error('Minecraft server jar pin mismatch');
  const readyMs = config.readyTimeoutMs ?? 180_000;
  if (!Number.isSafeInteger(readyMs) || readyMs <= 0 || readyMs > 600_000) throw Error('Invalid Minecraft startup budget');
  const exec = config.exec ?? liveProcExec;
  const runtimeId = `mc-${trial.trialId.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const server = `${runtimeId}-server`, bot = `${runtimeId}-bot`;
  const root = await mkdtemp(join(config.workRoot ?? tmpdir(), 'papercusp-minecraft-'));
  const world = join(root, 'world'), bridge = join(root, 'bridge'), protocolFile = join(root, 'protocol.json');
  const resources = new Set<string>([server, bot]);
  const startedAt = Date.now(), deadline = startedAt + trial.protocol.limits.maxWallClockMs;
  let stopping: Promise<MinecraftStopReport> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let starting = true;
  const startupLogTails: Record<string, string> = {};
  let stoppedAtMs = 0;
  let replayBytes = 0;
  let programDrained: Promise<void> = Promise.resolve();
  const replayFile = join(root, 'programs.jsonl');
  const recordProgram = async (event: Record<string, unknown>) => {
    const line = JSON.stringify({ atMs: Date.now(), ...event }) + '\n';
    replayBytes += Buffer.byteLength(line);
    if (replayBytes > 16 * 1024 * 1024) throw Error('Minecraft replay evidence limit');
    await appendFile(replayFile, line, { mode: 0o600 });
  };
  const pending = new Set<ReturnType<ProcExec>>();
  const run: ProcExec = async (cmd, args, opts) => {
    const operation = exec(cmd, args, opts); pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); }
  };
  const command = async (args: string[], timeoutMs: number, signal?: AbortSignal) => {
    const result = await run('docker', args, { timeoutMs, signal });
    if (result.code !== 0) throw Error(`Minecraft docker ${args[0]} failed (${result.code}): ${result.stderr.slice(-2000)}`);
    return result.stdout.trim();
  };
  const stop = (): Promise<MinecraftStopReport> => {
    if (stopping) return stopping;
    stopped = true; clearTimeout(timer); config.signal?.removeEventListener('abort', onAbort);
    stopping = (async () => {
      const errors: string[] = [];
      // A timed-out/lost docker-run receipt may still have created the named
      // resource. Drain admitted commands before removing by allocated name.
      await Promise.allSettled([...pending]);
      const captureLog = async (name: string, file: string) => {
        try {
          const result = await exec('docker', ['logs', ...(starting ? ['--tail', '30'] : []), '--timestamps', name], { timeoutMs: 15_000 });
          if (starting) startupLogTails[file] = (result.stdout + result.stderr).slice(-2000);
          if (result.code !== 0) errors.push(`Minecraft log capture failed: ${name}`);
          await writeFile(join(root, file), result.stdout + result.stderr);
        } catch (error) {
          const detail = String(error).slice(0, 1000);
          if (starting) startupLogTails[file] = `Log capture unavailable: ${detail}`;
          errors.push(`Minecraft log capture failed: ${detail}`);
        }
      };
      await captureLog(bot, 'bot.log');
      // Stop all participants first, then let Java save the trusted world.
      for (const name of [...resources].filter(name => name !== server)) {
        const result = await exec('docker', ['rm', '-f', name], { timeoutMs: 15_000 });
        if (result.code !== 0 && !/No such container/.test(result.stderr)) errors.push(result.stderr.slice(-1000));
      }
      const graceful = await exec('docker', ['stop', '--time', '10', server], { timeoutMs: 20_000 });
      if (graceful.code !== 0 && !/No such container/.test(graceful.stderr)) errors.push(graceful.stderr.slice(-1000));
      await captureLog(server, 'server.log');
      const removed = await exec('docker', ['rm', '-f', server], { timeoutMs: 15_000 });
      if (removed.code !== 0 && !/No such container/.test(removed.stderr)) errors.push(removed.stderr.slice(-1000));
      const remaining = await exec('docker', ['ps', '-aq', '--filter', `label=${MINECRAFT_RUNTIME_LABEL}=${runtimeId}`], { timeoutMs: 15_000 });
      if (remaining.code !== 0 || remaining.stdout.trim()) errors.push(`Owned Minecraft containers remain or could not be verified: ${remaining.stderr || remaining.stdout}`);
      stoppedAtMs = Date.now();
      return { removed: remaining.code === 0 && !remaining.stdout.trim(), errors, evidenceDir: world };
    })();
    return stopping;
  };
  const onAbort = () => { void stop(); };
  const budget = () => {
    const now = Date.now();
    if (stopped || config.signal?.aborted || now >= deadline) throw Error('Minecraft trial cancelled or deadline reached');
    const remaining = startedAt + readyMs - now;
    if (remaining <= 0) throw Error('Minecraft startup readiness deadline reached');
    return Math.min(deadline - now, remaining);
  };
  const startupCommand = async (args: string[]) => {
    const output = await command(args, budget(), config.signal);
    // A successful subprocess receipt cannot admit work after its deadline.
    budget();
    return output;
  };
  const labels = ['--label', `${MINECRAFT_RUNTIME_LABEL}=${runtimeId}`, '--label', `papercusp.minecraft-trial=${trial.trialId}`];
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const secure = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--cpus', '2', '--memory', '2g', '--user', user, '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m'];
  try {
    await mkdir(world); await mkdir(bridge); await chmod(bridge, 0o777);
    await writeFile(replayFile, '', { mode: 0o600 });
    await writeFile(protocolFile, JSON.stringify(trial.protocol), { mode: 0o444 });
    await writeFile(join(world, 'eula.txt'), 'eula=true\n');
    await writeFile(join(world, 'ops.json'), '[]');
    await writeFile(join(world, 'whitelist.json'), JSON.stringify(trial.protocol.participants.map(name => ({ name, uuid: offlineUuid(name) }))));
    await writeFile(join(world, 'server.properties'), [
      'server-ip=127.0.0.1', 'server-port=25565', 'online-mode=false', 'white-list=true', 'enforce-whitelist=true',
      'enforce-secure-profile=false', 'enable-rcon=false', 'enable-query=false', 'enable-command-block=false',
      'op-permission-level=0', 'function-permission-level=0', 'gamemode=survival', 'force-gamemode=true',
      'difficulty=easy', 'hardcore=false', 'pvp=false', 'spawn-protection=0', 'view-distance=3', 'simulation-distance=3',
      'allow-nether=true', 'max-players=4', `level-seed=${trial.protocol.worldSeed}`, 'level-name=world',
    ].join('\n') + '\n');
    // Measure the actual prepared dependency image before any game/process admission.
    const probe = `${runtimeId}-dependencies`; resources.add(probe);
    const versions = JSON.parse(await startupCommand(['run', '--rm', '--name', probe, ...labels, '--network', 'none', ...secure,
      '--entrypoint', 'node', config.botImage, '-p',
      'JSON.stringify([require("mineflayer/package.json").version,require("mineflayer-pathfinder/package.json").version])']));
    if (versions[0] !== trial.protocol.pins.mineflayerVersion || versions[1] !== trial.protocol.pins.pathfinderVersion) throw Error('Minecraft bot dependency pin mismatch');
    resources.delete(probe);
    config.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(onAbort, Math.max(1, deadline - Date.now())); timer.unref();
    await startupCommand(['run', '-d', '--name', server, ...labels, ...secure, '--network', 'none',
      '--mount', `type=bind,source=${world},target=/data`, '--mount', `type=bind,source=${config.serverJar},target=/opt/server.jar,readonly`,
      '--workdir', '/data', '--entrypoint', 'java', trial.protocol.pins.serverImage,
      '-Xms256M', '-Xmx1G', '-jar', '/opt/server.jar', 'nogui']);
    const javaVersion = await run('docker', ['exec', server, 'java', '-version'], { timeoutMs: budget(), signal: config.signal });
    budget();
    if (javaVersion.code !== 0 || !/version "17[.\"]/.test(javaVersion.stderr + javaVersion.stdout)) throw Error('Minecraft requires measured Java 17');
    while (true) {
      const logs = await startupCommand(['logs', '--tail', '30', server]);
      if (/Done \([\d.]+s\)!/.test(logs)) break;
      const running = await startupCommand(['inspect', '--format', '{{.State.Running}}', server]);
      if (running !== 'true') throw Error(`Minecraft server exited before ready: ${logs.slice(-2000)}`);
      if (Date.now() >= startedAt + readyMs) throw Error('Minecraft server readiness deadline');
      await new Promise(resolve => setTimeout(resolve, 250)); budget();
    }
    await startupCommand(['run', '-d', '--name', bot, ...labels, ...secure, '--network', `container:${server}`,
      '--mount', `type=bind,source=${bridge},target=/bridge`, '--mount', `type=bind,source=${protocolFile},target=/config/protocol.json,readonly`,
      '--entrypoint', 'node', config.botImage, '/app/bot.cjs']);
    while (true) {
      const logs = await startupCommand(['logs', '--tail', '30', bot]);
      if (logs.split('\n').some(line => { try { const value = JSON.parse(line); return value.ready === true
        && JSON.stringify(value.participants.sort()) === JSON.stringify([...trial.protocol.participants].sort()); } catch { return false; } })) break;
      if (await startupCommand(['inspect', '--format', '{{.State.Running}}', bot]) !== 'true') throw Error(`Minecraft bot exited before ready: ${logs.slice(-2000)}`);
      if (Date.now() >= startedAt + readyMs) throw Error('Minecraft bot readiness deadline');
      await new Promise(resolve => setTimeout(resolve, 250)); budget();
    }
    const measurement = minecraftRuntimeMeasurementSchema.parse({ serverInstanceId: server, serverReady: true,
      javaMajor: 17, trialId: trial.trialId, worldSeed: trial.protocol.worldSeed, rules: trial.protocol.rules, pins: trial.protocol.pins });
    let programActive = false;
    const runtime: MinecraftRuntime = { runtimeId, trial, measurement, stop,
      async execute(participant, source) {
        if (stopped || config.signal?.aborted || Date.now() >= deadline) throw Error('Minecraft trial is closed');
        if (!trial.protocol.participants.includes(participant)) throw Error('Unknown Minecraft participant');
        if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 16384) throw Error('Invalid Minecraft program');
        if (programActive) throw Error('Minecraft program already executing');
        programActive = true;
        let finishProgram!: () => void;
        programDrained = new Promise(resolve => { finishProgram = resolve; });
        const name = `${runtimeId}-program-${randomUUID().slice(0, 8)}`; resources.add(name);
        const timeoutMs = Math.max(1, Math.min(trial.protocol.limits.maxProgramMs, deadline - Date.now()));
        try {
          await recordProgram({ event: 'program-start', participant, source, timeoutMs });
          const request = Buffer.from(JSON.stringify({ participant, source, timeoutMs })).toString('base64');
          const result = await run('docker', ['run', '--rm', '--name', name, ...labels, ...secure, '--network', 'none',
            '--mount', `type=bind,source=${bridge},target=/bridge,readonly`, '--entrypoint', 'node', config.botImage, '/app/program.cjs', request],
          { timeoutMs, signal: config.signal });
          if (result.code === 124 || config.signal?.aborted || stopped) { await stop(); throw Error('Minecraft program cancelled or timed out'); }
          if (Buffer.byteLength(result.stdout) > 131072) { await stop(); throw Error('Minecraft program output limit'); }
          let output: { ok: boolean; value?: unknown; error?: string };
          try { output = JSON.parse(result.stdout); } catch { throw Error(`Minecraft program failed: ${result.stderr.slice(-1000)}`); }
          if (typeof output.ok !== 'boolean' || result.code !== 0 && output.ok) throw Error('Invalid Minecraft program result');
          await recordProgram({ event: 'program-end', participant, result: output });
          return output;
        } catch (error) {
          await recordProgram({ event: 'program-error', participant, error: String(error).slice(0, 2000) });
          throw error;
        } finally {
          try {
            const removed = await exec('docker', ['rm', '-f', name], { timeoutMs: 15_000 });
            if (removed.code === 0 || /No such container/.test(removed.stderr)) resources.delete(name);
          } finally { programActive = false; finishProgram(); }
        }
      },
      async dispose() { const report = await stop(); if (report.removed) await rm(root, { recursive: true, force: true }); return report; },
    };
    ownedRuntimes.set(runtime, async () => {
      const report = await stop();
      await programDrained;
      if (!report.removed || report.errors.length) throw Error('Minecraft evidence requires verified runtime cleanup');
      const files: Record<string, string | null> = {};
      const paths = ['programs.jsonl', 'server.log', 'bot.log', ...trial.protocol.participants.flatMap(name => {
        const uuid = offlineUuid(name);
        return [`world/world/advancements/${uuid}.json`, `world/world/stats/${uuid}.json`];
      })];
      let bytes = 0;
      for (const path of paths) {
        let file;
        try {
          file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await file.stat();
          bytes += stat.size;
          if (!stat.isFile() || bytes > 32 * 1024 * 1024) throw Error('Minecraft evidence file limit');
          files[path] = await file.readFile('utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          files[path] = null;
        } finally { await file?.close(); }
      }
      return { runtimeId, trial, startedAtMs: startedAt, stoppedAtMs, files,
        provenance: { source: 'host-collected-server-files', deterministicReplay: false,
          nondeterministicInputs: ['server-tick-and-process-scheduling', 'entity-behaviour-and-game-randomness',
            'bot-network-and-action-timing'] } };
    });
    starting = false;
    return runtime;
  } catch (error) {
    const report = await stop();
    if (report.removed) await rm(root, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}; runtime=${runtimeId}; startupLogs=${JSON.stringify(startupLogTails)}; cleanup=${JSON.stringify(report)}`);
  }
}
