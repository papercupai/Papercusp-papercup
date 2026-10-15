/**
 * Codex hook bridge against real docker (benchmark-coverage-frontierswe-v2-2026-10-10 D-032, P-006).
 *
 * The unit suite pins the runner and the wrapper's capture/rewrite/ping logic. This suite runs the in-container half
 * for real: the shim (shebang = the mounted host static busybox) inside a task container on its own `--internal`
 * egress network, through the nginx sidecar and the unix-socket relay, to a host hook process. It proves the host
 * hook's stdout, stderr and exit code come back byte-exact, a ping works, a wrong token is refused, and an unreachable
 * bridge makes the shim exit 2 (which is what lets the wrapper's launch-time ping fail closed).
 *
 * Requires docker, the local `alpine` and `nginx:alpine` images, and a static host busybox.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { startBenchEgress, sweepBenchEgress, type BenchEgress, type TaskNetworkLease } from './bench-egress';
import {
  CONTAINER_BUSYBOX_PATH,
  CONTAINER_HOOK_SHIM_PATH,
  HOOK_BRIDGE_ENDPOINT,
  materializeHookShim,
  resolveStaticBusybox,
  startCodexHookBridge,
  type CodexHookBridge,
} from './codex-hook-bridge';

const RUN_ID = 'hookbridge-int';
const TOKEN = 'c'.repeat(32);
const execFileP = promisify(execFile);

let base: string;
let bridge: CodexHookBridge | undefined;
let egress: BenchEgress | undefined;
let lease: TaskNetworkLease | undefined;
let shim: string;
let busybox: string;

beforeAll(async () => {
  for (const image of ['alpine', 'nginx:alpine']) await execFileP('docker', ['image', 'inspect', image], { timeout: 60_000 });
  busybox = resolveStaticBusybox();
  base = mkdtempSync(join(tmpdir(), 'hookbridge-int-'));
  shim = materializeHookShim(join(base, 'shim'));
  const recordDir = join(base, 'records');
  bridge = await startCodexHookBridge({ recordDir, env: { PATH: '/usr/bin:/bin' } });
  writeFileSync(
    join(recordDir, 'session-5.json'),
    JSON.stringify({ session: 'session-5', token: TOKEN, commands: [{ event: 'PreToolUse', command: 'cat; printf "host-stderr" >&2; exit 3' }] }),
  );
  egress = await startBenchEgress({ runId: RUN_ID, endpoints: [{ name: HOOK_BRIDGE_ENDPOINT, listenPort: 7790, targetPort: bridge.port }] });
  lease = await egress.openTaskNetwork('hb');
}, 300_000);

afterAll(async () => {
  await lease?.release();
  await egress?.stop();
  // A start that timed out mid-`docker run` returns no handle; the label sweep removes what it left.
  await sweepBenchEgress(RUN_ID);
  await bridge?.stop();
  rmSync(base, { recursive: true, force: true });
}, 300_000);

/** Run `script` with alpine's sh in a throwaway container on the task network, shim + busybox mounted read-only. */
function inTaskContainer(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'run', '--rm', '--label', `papercusp.bench-egress=${RUN_ID}`, '--network', lease!.network,
      '--mount', `type=bind,source=${busybox},target=${CONTAINER_BUSYBOX_PATH},readonly`,
      '--mount', `type=bind,source=${shim},target=${CONTAINER_HOOK_SHIM_PATH},readonly`,
      'alpine', 'sh', '-c', script,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('codex hook bridge (real docker)', () => {
  it('runs a host hook from inside a task container with exact stdout, stderr and exit code; ping, refusal and unreachable behave', async () => {
    const url = egress!.originFor(HOOK_BRIDGE_ENDPOINT);
    expect(url).toBe('http://papercusp-egress:7790');
    const S = CONTAINER_HOOK_SHIM_PATH;
    const r = await inTaskContainer(
      [
        `printf '{"tool_name":"Bash"}' | ${S} ${url} session-5 ${TOKEN} 0 >/tmp/o 2>/tmp/e; echo "rc=$?"`,
        `echo "out=$(cat /tmp/o)"`,
        `echo "err=$(cat /tmp/e)"`,
        `${S} ${url} session-5 ${TOKEN} ping </dev/null; echo "ping=$?"`,
        `${S} ${url} session-5 ${'d'.repeat(32)} 0 </dev/null 2>/dev/null; echo "badtoken=$?"`,
        `${S} http://papercusp-egress:1 session-5 ${TOKEN} 0 </dev/null 2>/tmp/u; echo "unreach=$?"`,
        // The shim writes "papercusp hook bridge unreachable at <url>: <wget error>"; keep the deterministic part.
        `echo "unreach_err=$(head -n 1 /tmp/u | sed 's/: .*//')"`,
      ].join('\n'),
    );
    const kv = Object.fromEntries(
      r.stdout
        .split('\n')
        .map((l) => l.match(/^([a-z_]+)=(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => [m[1]!, m[2]!]),
    );
    expect({ kv, code: r.code, stderr: r.stderr }).toEqual({
      kv: {
        rc: '3',
        out: '{"tool_name":"Bash"}',
        err: 'host-stderr',
        ping: '0',
        badtoken: '2',
        unreach: '2',
        unreach_err: 'papercusp hook bridge unreachable at http://papercusp-egress:1',
      },
      code: 0,
      stderr: '',
    });
    expect(bridge!.stats()).toMatchObject({ calls: 1, pings: 1, refused: 1 });
  }, 300_000);
});
