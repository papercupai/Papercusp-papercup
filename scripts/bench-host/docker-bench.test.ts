import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, 'docker-bench.sh');

// The MAIN daemon's well-known state. The bench daemon must share none of it (P-007, D-013 item 1).
const MAIN = {
  dataRoot: '/var/lib/docker',
  socket: '/var/run/docker.sock',
  runSocket: '/run/docker.sock',
  execRoot: '/var/run/docker',
  containerdNamespace: 'moby',
  bridge: 'docker0',
};

const dirs: string[] = [];
function render(env: Record<string, string> = {}) {
  const out = mkdtempSync(join(tmpdir(), 'docker-bench-render-'));
  dirs.push(out);
  execFileSync('bash', [SCRIPT, 'render', out], { env: { PATH: process.env.PATH ?? '', ...env } });
  return {
    daemon: JSON.parse(readFileSync(join(out, 'daemon.json'), 'utf8')) as Record<string, unknown>,
    unit: readFileSync(join(out, 'docker-bench.service'), 'utf8'),
    net: readFileSync(join(out, 'docker-bench-net'), 'utf8'),
    netPath: join(out, 'docker-bench-net'),
  };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('docker-bench daemon config', () => {
  it('keeps every piece of daemon state off the main daemon', () => {
    const { daemon } = render();
    expect(daemon['data-root']).toBe('/mnt/bench/docker');
    expect(daemon['data-root']).not.toBe(MAIN.dataRoot);
    expect(daemon['hosts']).toEqual(['unix:///run/docker-bench.sock']);
    expect(daemon['hosts']).not.toContain(`unix://${MAIN.socket}`);
    expect(daemon['hosts']).not.toContain(`unix://${MAIN.runSocket}`);
    expect(daemon['exec-root']).toBe('/run/docker-bench');
    expect(daemon['exec-root']).not.toBe(MAIN.execRoot);
    expect(daemon['pidfile']).toBe('/run/docker-bench.pid');
    expect(daemon['containerd-namespace']).toBe('bench');
    expect(daemon['containerd-namespace']).not.toBe(MAIN.containerdNamespace);
    expect(daemon['containerd-plugins-namespace']).toBe('bench-plugins');
    expect(daemon['bridge']).toBe('docker-bench0');
    expect(daemon['bridge']).not.toBe(MAIN.bridge);
  });

  it('stores image layers in the data-root, not in the shared containerd snapshotter', () => {
    const { daemon } = render();
    // With the containerd image store, layers would land in /var/lib/containerd on the root disk.
    expect(daemon['storage-driver']).toBe('overlay2');
    expect(daemon['features']).toEqual({ 'containerd-snapshotter': false });
  });

  it('never manages the fleet-shared iptables chains', () => {
    const { daemon } = render();
    expect(daemon['iptables']).toBe(false);
    expect(daemon['ip6tables']).toBe(false);
    expect(daemon['ip-masq']).toBe(false);
    expect(daemon['default-address-pools']).toEqual([{ base: '10.232.0.0/16', size: 24 }]);
  });

  it('orders the unit after the bench mount and starts dockerd from the rendered config', () => {
    const { unit } = render();
    expect(unit).toContain('RequiresMountsFor=/mnt/bench');
    expect(unit).toContain('ExecStart=/usr/bin/dockerd --config-file /etc/docker-bench/daemon.json');
    expect(unit).toContain('ExecStartPre=/usr/local/sbin/docker-bench-net up');
    expect(unit).toContain('ExecStopPost=/usr/local/sbin/docker-bench-net down');
  });

  it('derives the MASQUERADE source subnet from the bridge CIDR', () => {
    expect(render().net).toContain('SUBNET=10.231.0.0/24');
    expect(render({ BENCH_BRIDGE_CIDR: '10.240.5.9/20' }).net).toContain('SUBNET=10.240.0.0/20');
  });

  it('renders a syntactically valid net helper', () => {
    const { netPath } = render();
    expect(() => execFileSync('bash', ['-n', netPath])).not.toThrow();
  });

  it('installs and removes only its scoped bridge forwarding rule idempotently', () => {
    const { netPath } = render({ BENCH_POOL_BASE: '10.240.0.0/16' });
    const dir = mkdtempSync(join(tmpdir(), 'docker-bench-firewall-'));
    dirs.push(dir);
    const state = join(dir, 'rules.json'), calls = join(dir, 'calls.jsonl');
    const peer = ['FORWARD', '-i', 'peer0', '-j', 'ACCEPT'];
    writeFileSync(state, JSON.stringify([peer]));
    writeFileSync(join(dir, 'ip'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'iptables'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), path = ${JSON.stringify(state)};
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === '-t') process.exit(args[2] === '-C' ? 1 : 0);
const rules = JSON.parse(fs.readFileSync(path, 'utf8'));
const operation = args[0], rule = operation === '-I' ? [args[1], ...args.slice(3)] : args.slice(1);
const index = rules.findIndex(value => JSON.stringify(value) === JSON.stringify(rule));
if (operation === '-C') process.exit(index < 0 ? 1 : 0);
if (operation === '-I') rules.unshift(rule);
else if (operation === '-D' && index >= 0) rules.splice(index, 1);
else process.exit(9);
fs.writeFileSync(path, JSON.stringify(rules));
`, { mode: 0o755 });
    const run = (action: string) => execFileSync('bash', [netPath, action], {
      env: { PATH: dir + ':' + (process.env.PATH ?? '') },
    });
    run('up'); run('up');
    const rule = ['FORWARD', '-s', '10.240.0.0/16', '-d', '10.240.0.0/16',
      '-m', 'physdev', '--physdev-is-bridged', '-j', 'ACCEPT'];
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual([rule, peer]);
    run('down'); run('down');
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual([peer]);
    const commands: string[][] = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(command => command[0] === '-I')).toHaveLength(1);
    expect(commands.filter(command => command[0] === '-D')).toHaveLength(1);
    expect(commands.every(command => !command.includes('-F') && !command.includes('-P') &&
      !command.some(value => value.startsWith('DOCKER')))).toBe(true);
  });

  it('follows a relocated bench mount', () => {
    const { daemon, unit } = render({ BENCH_MOUNT: '/srv/bench2' });
    expect(daemon['data-root']).toBe('/srv/bench2/docker');
    expect(unit).toContain('RequiresMountsFor=/srv/bench2');
  });
});

describe('docker-bench local fixture preparation', () => {
  const source = 'unix:///var/run/docker.sock', target = 'unix:///run/docker-bench.sock';
  const alpine = `sha256:${'a'.repeat(64)}`, nginx = `sha256:${'b'.repeat(64)}`;
  function fixture(options: { missingSource?: boolean; conflictingTarget?: boolean; sameDaemon?: boolean; wrongLoad?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'docker-bench-fixtures-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json'), log = join(dir, 'calls.jsonl');
    writeFileSync(statePath, JSON.stringify({ source: { alpine, 'nginx:alpine': options.missingSource ? null : nginx },
      target: options.conflictingTarget ? { alpine: nginx } : {}, options }));
    writeFileSync(join(dir, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), statePath = ${JSON.stringify(statePath)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (args[0] !== '--host') process.exit(9);
const source = args[1] === ${JSON.stringify(source)}, cmd = args.slice(2);
if (cmd[0] === 'info') console.log(state.options.sameDaemon ? 'same' : source ? 'main' : 'bench');
else if (cmd[1] === 'inspect') {
  const id = (source ? state.source : state.target)[cmd.at(-1)];
  if (!id) process.exit(1);
  console.log(id);
} else if (cmd[1] === 'save' && source) console.log(JSON.stringify({ image: cmd[2], id: state.source[cmd[2]] }));
else if (cmd[1] === 'load' && !source) {
  const saved = JSON.parse(fs.readFileSync(0, 'utf8'));
  state.target[saved.image] = state.options.wrongLoad ? 'sha256:' + 'c'.repeat(64) : saved.id;
  fs.writeFileSync(statePath, JSON.stringify(state));
} else process.exit(8);
`, { mode: 0o755 });
    return {
      run: () => spawnSync('bash', [SCRIPT, 'fixtures'], { encoding: 'utf8',
        env: { PATH: `${dir}:${process.env.PATH ?? ''}` } }),
      calls: (): string[][] => readFileSync(log, 'utf8').trimEnd().split('\n').map(row => JSON.parse(row)),
    };
  }

  it('copies exact local image IDs to the distinct benchmark daemon and is idempotent', () => {
    const f = fixture(), first = f.run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`image=alpine id=${alpine} status=loaded`);
    expect(first.stdout).toContain(`image=nginx:alpine id=${nginx} status=loaded`);
    const second = f.run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout.match(/status=present/g)).toHaveLength(2);
    const calls = f.calls();
    expect(calls.filter(args => args[3] === 'save')).toEqual([
      ['--host', source, 'image', 'save', 'alpine'], ['--host', source, 'image', 'save', 'nginx:alpine'],
    ]);
    expect(calls.filter(args => args[3] === 'load')).toEqual(Array(2).fill(['--host', target, 'image', 'load']));
    expect(calls.flat()).not.toContain('pull');
  });

  it.each([
    [{ missingSource: true }, ''],
    [{ conflictingTarget: true }, 'different image'],
    [{ sameDaemon: true }, 'distinct live daemons'],
  ])('refuses unsafe or incomplete prerequisites before any write: %j', (options, diagnostic) => {
    const f = fixture(options), result = f.run();
    expect(result.status).not.toBe(0);
    if (diagnostic) expect(result.stderr).toContain(diagnostic);
    expect(f.calls().filter(args => ['save', 'load'].includes(args[3]))).toEqual([]);
  });

  it('rejects a transfer whose loaded image differs from the preflight ID', () => {
    const f = fixture({ wrongLoad: true }), result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('loaded fixture ID differs');
  });
});
