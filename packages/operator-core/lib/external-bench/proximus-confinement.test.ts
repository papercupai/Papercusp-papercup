import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as unixServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createProximusTaskBroker, prepareProximusSandbox } from './proximus-confinement';

const binding = { containerId: 'a'.repeat(64), image: 'task@sha256:' + 'b'.repeat(64),
  network: 'none', networkMode: 'no-network' as const };
const command = (text = 'printf "$literal; `x`"') => ['exec', '--workdir', '/app', '--env', 'OPENAI_API_KEY=',
  binding.containerId, 'timeout', '--signal=TERM', '--kill-after=1s', '60s', 'bash', '-lc', text];
function fixture() {
  const row = { Id: binding.containerId, State: { Running: true }, Config: { Image: binding.image, Env: ['PRIVATE=secret'] },
    HostConfig: { NetworkMode: 'none', Privileged: false, PidMode: '', IpcMode: 'private' },
    NetworkSettings: { Networks: { none: {} } }, Mounts: [] as unknown[], HostSecret: 'hidden' };
  const execute = vi.fn(async (args: string[], _timeout: number, _signal: AbortSignal) => ({ return_code: 0,
    stdout: args[0] === 'inspect' ? JSON.stringify([row]) : 'task output', stderr: '' }));
  return { row, execute };
}

describe('Proximus trusted task command boundary', () => {
  it('binds raw shell text only inside the assigned container, clamps deadlines and hides inspect secrets', async () => {
    const f = fixture(), broker = await createProximusTaskBroker(binding, 1000, f.execute);
    try {
      const inspected = await broker.command(['inspect', binding.containerId], 10);
      expect(inspected.stdout).not.toContain('secret');
      expect(inspected.stdout).not.toContain('HostSecret');
      expect(await broker.command(command(), 30)).toMatchObject({ stdout: 'task output' });
      const [args, ms] = f.execute.mock.calls.at(-1)!;
      expect(args.slice(-3)).toEqual(['bash', '-lc', 'printf "$literal; `x`"']);
      expect(Number(args.at(-4)!.slice(0, -1))).toBeLessThanOrEqual(1);
      expect(ms).toBeLessThanOrEqual(1000);
      expect(args).toContain(binding.containerId);
    } finally { await broker.stop(); }
    await expect(broker.command(command(), 10)).rejects.toThrow(/closed/);
  });

  it.each([
    ['run', '--privileged', 'image'], ['rm', '-f', binding.containerId], ['inspect', 'c'.repeat(64)],
    ['exec', '--privileged', binding.containerId, 'bash'], ['exec', '--env-file', '/host/secret', binding.containerId, 'bash'],
    ['exec', binding.containerId, 'bash', '-lc', 'unbounded'], command().map(s => s === binding.containerId ? 'c'.repeat(64) : s),
    command().map(s => s === '60s' ? 'Infinitys' : s),
  ])('refuses worker authority expansion: %j', async (...args) => {
    const f = fixture(), broker = await createProximusTaskBroker(binding, 10_000, f.execute);
    try {
      await expect(broker.command(args, 10)).rejects.toThrow();
      expect(f.execute.mock.calls.every(([a]) => a[0] === 'inspect')).toBe(true);
    } finally { await broker.stop(); }
  });

  it.each(['mount', 'privileged', 'pid', 'image', 'network'] as const)('detects %s drift independently of Python', async change => {
    const f = fixture(), broker = await createProximusTaskBroker(binding, 10_000, f.execute);
    if (change === 'mount') f.row.Mounts = [{ Type: 'bind', Source: '/host', Destination: '/host' }];
    if (change === 'privileged') f.row.HostConfig.Privileged = true;
    if (change === 'pid') f.row.HostConfig.PidMode = 'host';
    if (change === 'image') f.row.Config.Image = 'other';
    if (change === 'network') f.row.HostConfig.NetworkMode = 'host';
    try { await expect(broker.command(command(), 10)).rejects.toThrow(/isolation/); }
    finally { await broker.stop(); }
  });

  it('rejects concurrent work and waits for in-flight cancellation before stopping', async () => {
    const f = fixture(), broker = await createProximusTaskBroker(binding, 10_000, f.execute);
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    f.execute.mockImplementation(async (_args, _timeout, signal) => {
      release();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('reaped')), { once: true }));
    });
    const pending = broker.command(command(), 10);
    const rejected = expect(pending).rejects.toThrow('reaped');
    await started;
    await expect(broker.command(command(), 10)).rejects.toThrow(/serialized/);
    await broker.stop(); await rejected;
  });
});

it('the real Linux namespace hides host files/sockets, preserves runtime reads and permits only its exact gateway', async () => {
  const root = mkdtempSync('/tmp/px-boundary-test-');
  const runtime = join(root, 'runtime'), trial = join(root, 'trial'), secret = join(root, 'host-secret');
  mkdirSync(join(runtime, 'bin'), { recursive: true }); mkdirSync(trial);
  const python = join(runtime, 'bin/python'); symlinkSync('/usr/bin/python3', python);
  const sentinel = join(runtime, 'read-only-sentinel');
  writeFileSync(sentinel, 'installed runtime'); writeFileSync(secret, 'private host data');
  let approvedCalls = 0, refusedCalls = 0;
  const approved = createServer((_req, res) => { approvedCalls++; res.end('approved'); });
  const refused = createServer((_req, res) => { refusedCalls++; res.end('unscoped'); });
  const unix = unixServer(socket => socket.end('host daemon'));
  let sandbox: ReturnType<typeof prepareProximusSandbox> | undefined;
  try {
    await Promise.all([new Promise<void>(r => approved.listen(0, '127.0.0.1', r)),
      new Promise<void>(r => refused.listen(0, '127.0.0.1', r)), new Promise<void>(r => unix.listen(join(root, 'daemon.sock'), r))]);
    const port = (server: typeof approved) => (server.address() as { port: number }).port;
    sandbox = prepareProximusSandbox({ pythonBin: python, trialDir: trial,
      gatewayBaseURL: `http://127.0.0.1:${port(approved)}` });
    const program = [
      'import json,os,socket,urllib.request', 'result={}',
      'def probe(key, action):', ' try: action();result[key]=True', ' except Exception: result[key]=False',
      `probe('hostRead',lambda:open(${JSON.stringify(secret)}).read())`,
      `probe('runtimeWrite',lambda:open(${JSON.stringify(sentinel)},'a').write('corrupt'))`,
      `probe('unix',lambda:socket.socket(socket.AF_UNIX).connect(${JSON.stringify(join(root, 'daemon.sock'))}))`,
      `probe('direct',lambda:socket.create_connection(('127.0.0.1',${port(approved)}),timeout=1))`,
      `probe('otherPort',lambda:urllib.request.urlopen('http://127.0.0.1:${port(refused)}',timeout=2).read())`,
      `result['approved']=urllib.request.urlopen('http://127.0.0.1:${port(approved)}',timeout=5).read().decode()`,
      `result['runtimeRead']=open(${JSON.stringify(sentinel)}).read()`,
      `open(${JSON.stringify(join(trial, 'trajectory'))},'w').write('retained')`,
      `result['credential']=os.environ.get('PROXIMUS_TEST_PRIVATE_KEY')`, 'print(json.dumps(result))',
    ].join('\n');
    vi.stubEnv('PROXIMUS_TEST_PRIVATE_KEY', 'must-never-reach-worker');
    const wrapped = sandbox.wrap(['-I', '-B', '-c', program]);
    const result = await promisify(execFile)(wrapped.command, wrapped.argv, { env: sandbox.env, cwd: sandbox.cwd,
      timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(result.stdout)).toEqual({ hostRead: false, runtimeWrite: false, unix: false,
      direct: false, otherPort: false, approved: 'approved', runtimeRead: 'installed runtime', credential: null });
    expect(approvedCalls).toBe(1); expect(refusedCalls).toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('installed runtime');
    expect(readFileSync(join(trial, 'trajectory'), 'utf8')).toBe('retained');
  } finally {
    vi.unstubAllEnvs(); sandbox?.cleanup();
    await Promise.all([approved, refused, unix].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
