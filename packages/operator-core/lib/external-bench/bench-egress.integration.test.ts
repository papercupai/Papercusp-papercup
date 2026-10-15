/**
 * bench-egress against real docker (P-006; D-030 as amended by D-031).
 *
 * The unit suite pins the docker argv and the relay with a fake docker. This suite runs the whole path for real:
 * an internal per-task network, the nginx:alpine stream sidecar, and the in-process unix-socket relay to a loopback
 * "gateway". It asserts what the arm's isolation depends on:
 *
 *   - from a task network, `papercusp-egress:<port>` reaches the host relay (and the relay counts it);
 *   - the internet (an IP, a DNS name), any other sidecar port, and the sidecar's own egress are unreachable;
 *   - a container on ANOTHER task network is unreachable (D-031), while a container on the SAME task network is
 *     reachable — the positive control that shows the isolation check measures something;
 *   - teardown leaves no labelled network or container behind.
 *
 * Requires docker and the local `alpine` and `nginx:alpine` images (same convention as the other bench
 * integration suites).
 *
 * Every docker call here is ASYNC on purpose: the relay runs in THIS process, so a synchronous exec would block the
 * event loop that has to serve the very request the probe is waiting for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server, type Socket } from 'node:net';
import { BENCH_EGRESS_LABEL, startBenchEgress, sweepBenchEgress, type BenchEgress } from './bench-egress';

const RUN_ID = 'egress-int';
const LABEL = `${BENCH_EGRESS_LABEL}=${RUN_ID}`;
const execFileP = promisify(execFile);

let gateway: Server;
let gatewayPort: number;
const gatewaySockets = new Set<Socket>();
let egress: BenchEgress | undefined;
const containers: string[] = [];

/** `docker <args>` → stdout; rejects on a non-zero exit. */
async function docker(args: string[], timeout = 60_000): Promise<string> {
  return (await execFileP('docker', args, { encoding: 'utf8', timeout })).stdout;
}

/** `docker <args>` → exit status (never rejects). */
async function dockerStatus(args: string[], timeout = 30_000): Promise<number> {
  try {
    await execFileP('docker', args, { timeout });
    return 0;
  } catch (e) {
    return typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : 1;
  }
}

beforeAll(async () => {
  for (const image of ['alpine', 'nginx:alpine']) await docker(['image', 'inspect', image]);
  // A loopback-only stand-in for the assignment gateway (the real one binds 127.0.0.1 too).
  gateway = createServer((s) => {
    gatewaySockets.add(s);
    s.on('close', () => gatewaySockets.delete(s));
    s.on('error', () => undefined);
    s.end('HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\npong');
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()));
  gatewayPort = (gateway.address() as { port: number }).port;
});

afterAll(async () => {
  for (const id of containers) await dockerStatus(['rm', '-f', id]);
  const report = await egress?.stop();
  if (report?.errors.length) console.warn(`[bench-egress.integration] stop errors: ${report.errors.join('; ')}`);
  // A start that timed out mid-`docker run` returns no handle to stop(); the label sweep removes what it left.
  const swept = await sweepBenchEgress(RUN_ID);
  if (swept.errors.length) console.warn(`[bench-egress.integration] sweep errors: ${swept.errors.join('; ')}`);
  for (const s of gatewaySockets) s.destroy();
  await new Promise<void>((r) => gateway.close(() => r()));
}, 300_000);

/** Run a probe script in a throwaway alpine container on `network`; returns its `key=value` lines. */
async function probe(network: string, script: string): Promise<Record<string, string>> {
  const out = await docker(['run', '--rm', '--label', LABEL, '--network', network, 'alpine', 'sh', '-c', script], 90_000);
  return Object.fromEntries(
    out
      .split('\n')
      .map((l) => l.trim().match(/^([a-z_]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
}

/** `rc=0` once `url` answers (up to 5 tries), else `rc=1`. */
const fetchRc = (key: string, url: string, tries = 5) =>
  `rc=1; i=0; while [ $i -lt ${tries} ]; do if wget -qO- -T 2 ${url} >/dev/null 2>&1; then rc=0; break; fi; i=$((i+1)); sleep 1; done; echo ${key}=$rc`;

async function labelled(kind: 'network' | 'container'): Promise<string[]> {
  const args = kind === 'network' ? ['network', 'ls', '-q', '--filter', `label=${LABEL}`] : ['ps', '-aq', '--filter', `label=${LABEL}`];
  return (await docker(args)).split('\n').filter(Boolean);
}

describe('bench-egress (real docker)', () => {
  it('reaches only the relay from a task network, and task networks cannot reach each other', async () => {
    egress = await startBenchEgress({ runId: RUN_ID, endpoints: [{ name: 'gw', listenPort: 8788, targetPort: gatewayPort }] });
    const a = await egress.openTaskNetwork('task-a');
    const b = await egress.openTaskNetwork('task-b');

    // A peer "agent" with a listening service on task network A.
    const peer = (await docker(['run', '-d', '--label', LABEL, '--network', a.network, 'nginx:alpine'])).trim();
    containers.push(peer);
    const peerIp = (await docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${a.network}").IPAddress}}`, peer])).trim();
    expect(peerIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    const fromA = await probe(
      a.network,
      [
        'echo via_sidecar=$(wget -qO- -T 5 http://papercusp-egress:8788/)',
        fetchRc('same_net_peer', `http://${peerIp}/`),
        fetchRc('ext_ip', 'http://1.1.1.1/', 1),
        fetchRc('ext_dns', 'http://google.com/', 1),
        fetchRc('sidecar_other_port', 'http://papercusp-egress:80/', 1),
      ].join('; '),
    );
    expect(fromA).toEqual({ via_sidecar: 'pong', same_net_peer: '0', ext_ip: '1', ext_dns: '1', sidecar_other_port: '1' });

    // The peer is confirmed up (same_net_peer=0), so a failure from B is isolation, not a slow start.
    const fromB = await probe(
      b.network,
      ['echo via_sidecar=$(wget -qO- -T 5 http://papercusp-egress:8788/)', fetchRc('cross_net_peer', `http://${peerIp}/`, 2), fetchRc('ext_ip', 'http://1.1.1.1/', 1)].join(
        '; ',
      ),
    );
    expect(fromB).toEqual({ via_sidecar: 'pong', cross_net_peer: '1', ext_ip: '1' });

    // The sidecar itself has no route out either.
    expect(await dockerStatus(['exec', egress.sidecarId, 'wget', '-qO-', '-T', '3', 'http://1.1.1.1/'])).not.toBe(0);

    expect(egress.stats().gw!.connections).toBeGreaterThanOrEqual(2);
    expect(egress.stats().gw!.errors).toBe(0);

    // Teardown in D-031 order: agent containers, then task networks, then the run.
    await docker(['rm', '-f', peer]);
    containers.length = 0;
    expect(await a.release()).toEqual([]);
    expect(await b.release()).toEqual([]);
    expect(await egress.stop()).toEqual({ errors: [] });
    egress = undefined;
    expect(await labelled('network')).toEqual([]);
    expect(await labelled('container')).toEqual([]);
  }, 240_000);
});
