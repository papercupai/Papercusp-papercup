import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assignMinecraftTask, freezeMinecraftManifest, freezeMinecraftSelection, freezeMinecraftTrial } from './minecraft-protocol';
import { freezeMinecraftWorldBaseline, readMinecraftInitialWorld, startMinecraftParticipantBridge, startMinecraftRuntime } from './minecraft-runtime';
import type { ProcExec } from './grader/swe-bench-pro';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(runId = 'run') {
  const root = await mkdtemp(join(tmpdir(), 'mc-runtime-test-')); roots.push(root);
  const serverJar = join(root, 'server.jar'); await writeFile(serverJar, 'jar-fixture');
  const sha = 'a'.repeat(64);
  const material = (taskId: string, n: number, worldSeed = String(n)) => ({ taskId, worldSeed, objective: 'iron-tools',
    referenceSha256: String(n).repeat(64), scoringFixtureSha256: String(n + 3).repeat(64), exampleSha256: [] });
  const manifest = freezeMinecraftManifest({ schemaVersion: 1, revision: 1, train: [material('train', 1)],
    dev: [material('dev', 2)], heldOut: [material('iron', 3, '9223372036854775807')] });
  const selection = freezeMinecraftSelection(manifest, { runId, armId: 'stock', modelId: 'model',
    promptSha256: sha, configurationSha256: sha, sources: [] });
  const trial = freezeMinecraftTrial({ schemaVersion: 1, runId, armId: 'stock', taskId: 'iron',
    manifestHash: manifest.manifestHash, selectionHash: selection.selectionHash, worldSeed: '9223372036854775807', objective: 'iron-tools',
    rules: { version: '1.20.4', difficulty: 'easy', gameMode: 'survival', cheats: false },
    pins: { serverImage: `minecraft/server@sha256:${sha}`, serverJarSha256: createHash('sha256').update('jar-fixture').digest('hex'),
      mineflayerVersion: '4.32.0', pathfinderVersion: '2.4.5' },
    participants: ['alice'], observations: ['position', 'inventory'], actions: ['move'],
    limits: { maxWallClockMs: 60_000, maxProgramMs: 1000, maxUsd: 2 } });
  const commands: string[][] = [];
  const exec: ProcExec = vi.fn(async (_cmd, args) => {
    commands.push(args);
    let stdout = '';
    if (args[0] === 'run' && args.includes('-p')) stdout = '["4.32.0","2.4.5"]';
    else if (args[0] === 'run' && args.includes('/app/program.cjs')) stdout = '{"ok":true,"value":{"x":1}}';
    else if (args[0] === 'logs') stdout = args.at(-1)?.endsWith('-bot')
      ? '{"ready":true,"participants":["alice"]}' : 'Done (1.0s)!';
    else if (args[0] === 'inspect') stdout = 'true';
    return { code: 0, stdout, stderr: args[0] === 'exec' ? 'openjdk version "17.0.1"' : '' };
  });
  const assignment = assignMinecraftTask(manifest, trial, 'alice', selection);
  return { trial, assignment, serverJar, workRoot: root, botImage: `sha256:${sha}`, acceptEula: true, exec, commands };
}
describe('Minecraft owned runtime lifecycle', () => {
  async function preparedWorld() {
    const f = await fixture();
    const runtime = await startMinecraftRuntime(f);
    const report = await runtime.stop();
    const world = join(report.evidenceDir, 'world');
    await mkdir(join(world, 'region'), { recursive: true });
    await writeFile(join(world, 'level.dat'), 'frozen-level');
    await writeFile(join(world, 'region', 'r.0.0.mca'), 'frozen-chunks');
    return { f, runtime, world };
  }
  it('restores identical physical world bytes after earlier gameplay changes a trial copy', async () => {
    const { f, runtime } = await preparedWorld();
    const baseline = await freezeMinecraftWorldBaseline(runtime);
    const first = await startMinecraftRuntime({ ...f, worldBaseline: baseline });
    const firstWorld = readMinecraftInitialWorld(first);
    const firstReport = await first.stop();
    await writeFile(join(firstReport.evidenceDir, 'world', 'level.dat'), 'earlier-trial-progress');
    await writeFile(join(firstReport.evidenceDir, 'world', 'region', 'r.0.0.mca'), 'earlier-chunks');
    const second = await startMinecraftRuntime({ ...f, worldBaseline: baseline });
    try {
      expect(readMinecraftInitialWorld(second)).toEqual(firstWorld);
      expect(firstWorld.worldSha256).toBe(baseline.worldSha256);
      const secondReport = await second.stop();
      expect(secondReport.evidenceDir).not.toBe(firstReport.evidenceDir);
      expect(await readFile(join(secondReport.evidenceDir, 'world', 'level.dat'), 'utf8')).toBe('frozen-level');
      expect(await readFile(join(secondReport.evidenceDir, 'world', 'region', 'r.0.0.mca'), 'utf8')).toBe('frozen-chunks');
      await expect(startMinecraftRuntime({ ...f, worldBaseline: { ...baseline } })).rejects.toThrow(/Foreign/);
    } finally { await first.dispose(); await second.dispose(); await runtime.dispose(); await baseline.dispose(); }
  });
  it('refuses a changed baseline or foreign world identity before Docker admission', async () => {
    const { f, runtime } = await preparedWorld();
    const baseline = await freezeMinecraftWorldBaseline(runtime);
    try {
      const commands = f.commands.length;
      const foreign = freezeMinecraftTrial({ ...f.trial.protocol, worldSeed: '4' });
      await expect(startMinecraftRuntime({ ...f, trial: foreign, worldBaseline: baseline })).rejects.toThrow(/Foreign/);
      // Failed restore may perform cleanup but must not admit a container.
      expect(f.commands.slice(commands).some(args => args[0] === 'run')).toBe(false);
      const directory = (await readdir(f.workRoot)).find(name => name.startsWith('papercusp-minecraft-baseline-'))!;
      await writeFile(join(f.workRoot, directory, 'level.dat'), 'tampered');
      const before = f.commands.length;
      await expect(startMinecraftRuntime({ ...f, worldBaseline: baseline })).rejects.toThrow(/baseline changed/);
      expect(f.commands.slice(before).some(args => args[0] === 'run')).toBe(false);
    } finally { await runtime.dispose(); await baseline.dispose(); }
  });
  it('refuses links in a baseline and never follows their outside content', async () => {
    const { f, runtime, world } = await preparedWorld();
    await symlink(f.serverJar, join(world, 'outside'));
    try {
      await expect(freezeMinecraftWorldBaseline(runtime)).rejects.toThrow(/world entry/);
      expect((await readdir(f.workRoot)).some(name => name.startsWith('papercusp-minecraft-baseline-'))).toBe(false);
      expect(await readFile(f.serverJar, 'utf8')).toBe('jar-fixture');
    } finally { await runtime.dispose(); }
  });
  it('refuses baseline capture after gameplay or native admission and rejects forged runtime measurements', async () => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    const bridge = await startMinecraftParticipantBridge(runtime, f.assignment);
    await expect(freezeMinecraftWorldBaseline(runtime)).rejects.toThrow(/native admission/);
    await bridge.stop();
    await expect(freezeMinecraftWorldBaseline(runtime)).rejects.toThrow(/native admission/);
    await runtime.execute('alice', 'return 1');
    await expect(freezeMinecraftWorldBaseline(runtime)).rejects.toThrow(/precede gameplay/);
    await expect(freezeMinecraftWorldBaseline({ ...runtime })).rejects.toThrow(/owned/);
    expect(() => readMinecraftInitialWorld(runtime)).toThrow(/no measured/);
    await runtime.dispose();
  });
  it('retires the baseline explicitly and refuses later restore without admitting a server', async () => {
    const { f, runtime } = await preparedWorld();
    const baseline = await freezeMinecraftWorldBaseline(runtime);
    await baseline.dispose(); await baseline.dispose();
    const before = f.commands.length;
    await expect(startMinecraftRuntime({ ...f, worldBaseline: baseline })).rejects.toThrow(/closed/);
    expect(f.commands.slice(before).some(args => args[0] === 'run')).toBe(false);
    await runtime.dispose();
  });
  it('binds the native gameplay connection to its issued player and reuses isolated program execution', async () => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    const bridge = await startMinecraftParticipantBridge(runtime, f.assignment);
    try {
      const response = await fetch(bridge.endpoint, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ source: 'return await bot.position()' }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, value: { x: 1 } });
      const program = f.commands.find(args => args.includes('/app/program.cjs'))!;
      expect(JSON.parse(Buffer.from(program.at(-1)!, 'base64').toString())).toMatchObject({ participant: 'alice' });
      expect(bridge.participantId).toBe('alice');
      expect(bridge.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    } finally { await bridge.stop(); await runtime.dispose(); }
  });
  it('refuses copied and foreign assignment handles before opening a gameplay connection', async () => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    try {
      await expect(startMinecraftParticipantBridge(runtime, { ...f.assignment })).rejects.toThrow(/issued/);
      const other = await fixture('other-run');
      await expect(startMinecraftParticipantBridge(runtime, other.assignment)).rejects.toThrow(/issued/);
      await expect(startMinecraftParticipantBridge({ ...runtime }, f.assignment)).rejects.toThrow(/owned/);
    } finally { await runtime.dispose(); }
  });
  it.each([
    { name: 'missing credential', status: 401, authorization: '', body: { source: 'return 1' } },
    { name: 'wrong credential', status: 401, authorization: 'Bearer wrong', body: { source: 'return 1' } },
    { name: 'participant override', status: 400, body: { source: 'return 1', participant: 'bob' } },
    { name: 'empty program', status: 400, body: { source: '' } },
    { name: 'oversized program', status: 400, body: { source: 'x'.repeat(16385) } },
    { name: 'oversized body', status: 413, body: { source: 'x'.repeat(100_001) } },
  ])('refuses $name before dispatching a program', async test => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    const bridge = await startMinecraftParticipantBridge(runtime, f.assignment);
    try {
      const response = await fetch(bridge.endpoint, { method: 'POST',
        headers: { authorization: test.authorization ?? `Bearer ${bridge.token}` }, body: JSON.stringify(test.body) });
      expect(response.status).toBe(test.status); await response.text();
      expect(f.commands.some(args => args.includes('/app/program.cjs'))).toBe(false);
    } finally { await bridge.stop(); await runtime.dispose(); }
  });
  it('revokes native gameplay connections on runtime stop and refuses reopening a closed trial', async () => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    const bridge = await startMinecraftParticipantBridge(runtime, f.assignment);
    await runtime.stop();
    expect(bridge.signal.aborted).toBe(true);
    await expect(fetch(bridge.endpoint, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ source: 'return 1' }) })).rejects.toThrow();
    await expect(startMinecraftParticipantBridge(runtime, f.assignment)).rejects.toThrow(/active/);
    await bridge.stop(); await runtime.dispose();
  });
  it('refuses incompatible pins, EULA and player identities before allocating a container', async () => {
    const f = await fixture();
    await expect(startMinecraftRuntime({ ...f, acceptEula: false })).rejects.toThrow(/EULA/);
    await expect(startMinecraftRuntime({ ...f, botImage: 'node:latest' })).rejects.toThrow(/pins/);
    await writeFile(f.serverJar, 'changed');
    await expect(startMinecraftRuntime(f)).rejects.toThrow(/jar pin/);
    expect(f.exec).not.toHaveBeenCalled();
  });
  it('separates world, trusted bot and network-none program mounts and retains exact seed', async () => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    try {
      expect(runtime.measurement.trialId).toBe(f.trial.trialId);
      expect(await readFile(join((await runtime.stop()).evidenceDir, 'server.properties'), 'utf8')).toContain('level-seed=9223372036854775807');
      const server = f.commands.find(args => args.includes('/opt/server.jar') && args[0] === 'run')!;
      const bot = f.commands.find(args => args.includes('/app/bot.cjs'))!;
      expect(server[server.indexOf('--network') + 1]).toBe('none');
      expect(bot[bot.indexOf('--network') + 1]).toContain('container:');
      expect(bot.join(' ')).not.toContain('target=/data');
      expect(server).toContain('no-new-privileges');
      expect((await runtime.stop()).removed).toBe(true);
    } finally { await runtime.dispose(); }
  });
  it('executes bounded programs only for enrolled participants and stops idempotently', async () => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    try {
      await expect(runtime.execute('intruder', 'return 1')).rejects.toThrow(/participant/);
      await expect(runtime.execute('alice', 'x'.repeat(16385))).rejects.toThrow(/program/);
      expect(await runtime.execute('alice', 'return await bot.position()')).toEqual({ ok: true, value: { x: 1 } });
      const program = f.commands.find(args => args.includes('/app/program.cjs'))!;
      expect(program[program.indexOf('--network') + 1]).toBe('none');
      expect(program.join(' ')).not.toMatch(/target=\/data|docker.sock|protocol.json|server.jar/);
      const result = await runtime.stop(); expect(result).toMatchObject({ removed: true, errors: [] });
      expect(await runtime.stop()).toBe(result);
      await expect(runtime.execute('alice', 'return 1')).rejects.toThrow(/closed/);
    } finally { await runtime.dispose(); }
  });
  it('cleans names even when Docker created a server but its response was lost', async () => {
    const f = await fixture(); const base = f.exec;
    f.exec = vi.fn(async (cmd, args, opts) => args[0] === 'run' && args.includes('/opt/server.jar')
      ? { code: 124, stdout: '', stderr: 'lost run response' } : base(cmd, args, opts));
    await expect(startMinecraftRuntime(f)).rejects.toThrow(/cleanup=/);
    expect(f.commands.some(args => args[0] === 'rm' && args.at(-1)?.endsWith('-server'))).toBe(true);
    expect(f.commands.some(args => args[0] === 'ps' && args.includes('--filter'))).toBe(true);
  });
  it.each(['dependencies', 'server', 'java', 'server-ready', 'bot', 'bot-ready'])(
    'refuses a successful %s receipt at the startup deadline before admitting more work', async phase => {
      const f = await fixture(); const base = f.exec;
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const admitted: { args: string[]; at: number; timeoutMs: number }[] = [];
      f.exec = vi.fn(async (cmd, args, opts) => {
        admitted.push({ args, at: now, timeoutMs: opts.timeoutMs });
        const result = await base(cmd, args, opts);
        const match = phase === 'dependencies' ? args[0] === 'run' && args.includes('-p')
          : phase === 'server' ? args[0] === 'run' && args.includes('/opt/server.jar')
          : phase === 'java' ? args[0] === 'exec'
          : phase === 'server-ready' ? args[0] === 'logs' && !args.includes('--timestamps') && args.at(-1)?.endsWith('-server')
          : phase === 'bot' ? args[0] === 'run' && args.includes('/app/bot.cjs')
          : args[0] === 'logs' && !args.includes('--timestamps') && args.at(-1)?.endsWith('-bot');
        if (match) now = 1010;
        return result;
      });
      await expect(startMinecraftRuntime({ ...f, readyTimeoutMs: 10 })).rejects.toThrow(/startup readiness deadline/);
      const startup = admitted.filter(({ args }) => ['run', 'exec', 'inspect'].includes(args[0]!)
        || args[0] === 'logs' && !args.includes('--timestamps'));
      expect(startup.every(({ at, timeoutMs }) => at < 1010 && timeoutMs <= 1010 - at)).toBe(true);
      if (phase === 'dependencies') expect(f.commands.some(args => args[0] === 'run' && args.includes('-d'))).toBe(false);
      expect(f.commands.some(args => args[0] === 'ps')).toBe(true);
    });
  it('retains bounded server and bot startup diagnostics after verified cleanup removes their files', async () => {
    const f = await fixture(); const base = f.exec;
    f.exec = vi.fn(async (cmd, args, opts) => {
      if (args[0] === 'logs' && !args.includes('--timestamps')) return { code: 124, stdout: '', stderr: 'readiness probe timed out' };
      const result = await base(cmd, args, opts);
      if (args[0] === 'logs') return { ...result, stdout: 'x'.repeat(5000) + (args.at(-1)?.endsWith('-bot') ? 'BOT-TAIL' : 'SERVER-TAIL') };
      return result;
    });
    const error = await startMinecraftRuntime(f).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('readiness probe timed out');
    expect(message).toContain('SERVER-TAIL'); expect(message).toContain('BOT-TAIL');
    expect(message.length).toBeLessThan(5000);
    expect(message).toContain('"removed":true');
    expect(f.commands.filter(args => args[0] === 'logs' && args.includes('--timestamps'))
      .every(args => args.includes('--tail') && args.includes('30'))).toBe(true);
    const report = JSON.parse(message.split('; cleanup=')[1]!);
    await expect(readFile(join(report.evidenceDir, 'server.properties'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('drains a cancelled active program before verifying container cleanup', async () => {
    const f = await fixture(); const controller = new AbortController(); const base = f.exec;
    f.exec = vi.fn(async (cmd, args, opts) => {
      if (args.includes('/app/program.cjs')) {
        controller.abort(); return { code: 124, stdout: '', stderr: 'cancelled' };
      }
      return base(cmd, args, opts);
    });
    const runtime = await startMinecraftRuntime({ ...f, signal: controller.signal });
    await expect(runtime.execute('alice', 'while (true) {}')).rejects.toThrow(/cancelled/);
    expect(await runtime.dispose()).toMatchObject({ removed: true, errors: [] });
  });
});
