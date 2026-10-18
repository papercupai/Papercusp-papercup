/**
 * Egress for an in-container agent CLI (plan benchmark-coverage-frontierswe-v2-2026-10-10 P-006; D-030 as amended
 * by D-031). A FrontierSWE arm that runs Codex INSIDE the task container (D-026) needs exactly two things off-box:
 * the assignment gateway and the spawn-host MCP. Upstream (Harbor `merge_extra_allowlists`) gives the agent its
 * model host and nothing else on EVERY v2 task, no-network ones included. This module builds that path:
 *
 *   agent container ──(task network, --internal: no default route, no DNS)──▶ sidecar `papercusp-egress:<port>`
 *   sidecar (nginx:alpine, `stream` proxy) ──▶ unix:/relay/<name>.sock  (a bind-mounted per-run socket dir)
 *   host relay (in-process `net` server on that socket) ──▶ 127.0.0.1:<targetPort>  (gateway / MCP)
 *
 * Why a unix-socket relay: the gateway, :3070 and :3170 bind 127.0.0.1 only, and a TCP listener on the internal
 * bridge's host IP is NOT reachable from a container on an `--internal` network (measured, D-030 step 2). A socket
 * mounted into the sidecar is.
 *
 * Per RUN ({@link startBenchEgress}): the relay servers, one sidecar, and a base internal network the sidecar starts
 * on. Per TASK ({@link BenchEgress.openTaskNetwork}): a fresh `--internal` network the sidecar is connected to under
 * the shared alias. Each agent joins only its own task network, so concurrent tasks cannot reach each other (D-031).
 *
 * Relay targets must be loopback: the relay is a door to fixed local services, never a general egress. Teardown is
 * never-throw and reports every failure. Subprocess is INJECTED ({@link ProcExec}) so the docker half is
 * unit-testable with a fake; the relay half is real sockets in both suites.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcExec } from './grader/swe-bench-pro';
import { liveProcExec } from './grader/index';

/** The DNS alias every task network resolves to the sidecar. Codex config points at `http://<alias>:<port>`. */
export const BENCH_EGRESS_ALIAS = 'papercusp-egress';
/** Sidecar image (already local on the bench host; measured with it in D-030). */
export const BENCH_EGRESS_SIDECAR_IMAGE = 'nginx:alpine';
/** Docker label on every network and container this module creates — the handle for a later leak sweep. */
export const BENCH_EGRESS_LABEL = 'papercusp.bench-egress';
/** Where the per-run relay socket dir is mounted inside the sidecar. */
const SIDECAR_RELAY_DIR = '/relay';
/** `sun_path` is 108 bytes including the NUL. */
const MAX_SOCKET_PATH = 107;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const ENDPOINT_NAME = /^[a-z][a-z0-9-]{0,30}$/;

export interface BenchEgressEndpoint {
  /** `[a-z][a-z0-9-]*`, unique per run. Names the relay socket and the {@link BenchEgress.originFor} lookup. */
  name: string;
  /** The port the sidecar listens on — what the agent dials as `papercusp-egress:<listenPort>`. */
  listenPort: number;
  /** The loopback port the host relay pipes to (e.g. the gateway's 8788). Omitted for a `perTask` endpoint. */
  targetPort?: number;
  /**
   * D-033: the target is bound per task network with {@link BenchEgress.bindTaskEndpoint} (a per-assignment metered
   * gateway whose port is known only after the task container exists). The relay refuses connections while it is
   * unbound, and an egress with any perTask endpoint admits one open task network at a time, so a bound target is
   * reachable from exactly one task container.
   */
  perTask?: boolean;
  /** Must be loopback. Default `127.0.0.1`. */
  targetHost?: string;
  /** HTTP preserves the fixed upstream's loopback Host for MCP authentication.
   * Bearers and forwarding/ingress headers pass through unchanged. Default TCP. */
  transport?: 'tcp' | 'http';
}

export interface BenchEgressConfig {
  /** Names the docker resources (sanitized) and labels them. */
  runId: string;
  endpoints: BenchEgressEndpoint[];
  /** Inject a fake docker in tests; production uses `liveProcExec` (execFile, no host shell). */
  exec?: ProcExec;
  /** Default {@link BENCH_EGRESS_SIDECAR_IMAGE}. */
  sidecarImage?: string;
  /** Parent of the per-run work dir (relay sockets + nginx.conf). Default `os.tmpdir()`. */
  workRoot?: string;
  /** How long to wait for the sidecar to listen on every endpoint port. Default 15s. */
  readyTimeoutMs?: number;
  /** Poll interval for that wait. Default 200ms. */
  readyPollMs?: number;
}

export interface EndpointStats {
  /** Connections the relay accepted (i.e. agent requests that reached the host side). */
  connections: number;
  /** Relay-side socket errors (a refused target counts here). */
  errors: number;
}

export interface TaskNetworkLease {
  /** The `--internal` network to put the task's agent container on (`docker run --network <network>`). */
  network: string;
  /**
   * Disconnect the sidecar and remove the network. Call AFTER the agent container is gone (docker refuses to remove
   * a network with live endpoints). Idempotent, never-throw; returns the failures.
   */
  release(): Promise<string[]>;
}

export interface EgressStopReport {
  /** Non-fatal failures; stop() never throws. */
  errors: string[];
}

export interface BenchEgress {
  readonly runId: string;
  readonly alias: string;
  readonly sidecarId: string;
  readonly baseNetwork: string;
  /** `http://papercusp-egress:<listenPort>` for an endpoint name. Throws on an unknown name. */
  originFor(name: string): string;
  /** A fresh per-task internal network the sidecar is reachable on (D-031). */
  openTaskNetwork(tag: string): Promise<TaskNetworkLease>;
  /**
   * D-033: bind a perTask endpoint to `targetPort` for the open task network `network`. Throws on an unknown or
   * shared endpoint, a network that is not open, a bad port, or an endpoint that is already bound. Returns an
   * idempotent unbind; releasing the network unbinds too.
   */
  bindTaskEndpoint(network: string, name: string, targetPort: number): () => void;
  /** Per-endpoint relay counters (evidence that the agent's traffic went through the relay). */
  stats(): Record<string, EndpointStats>;
  /** Release open task networks, remove the sidecar and base network, close the relay. Idempotent, never-throw. */
  stop(): Promise<EgressStopReport>;
}

interface ResolvedEndpoint {
  name: string;
  listenPort: number;
  /** null for a perTask endpoint: the live target is its {@link EndpointBinding}. */
  targetPort: number | null;
  targetHost: string;
  perTask: boolean;
  transport: 'tcp' | 'http';
}

/** D-033: the live target of one perTask endpoint. */
interface EndpointBinding {
  network: string | null;
  port: number | null;
}

function isPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Validate the endpoint set (exported for tests). Fail closed: anything ambiguous refuses the whole run. */
export function resolveEgressEndpoints(endpoints: readonly BenchEgressEndpoint[]): ResolvedEndpoint[] {
  if (!endpoints.length) throw new Error('bench-egress: at least one endpoint is required');
  const names = new Set<string>();
  const ports = new Set<number>();
  return endpoints.map((e) => {
    if (!ENDPOINT_NAME.test(e.name)) throw new Error(`bench-egress: endpoint name ${JSON.stringify(e.name)} must match ${ENDPOINT_NAME}`);
    if (names.has(e.name)) throw new Error(`bench-egress: duplicate endpoint name '${e.name}'`);
    if (!isPort(e.listenPort)) throw new Error(`bench-egress: endpoint '${e.name}' listenPort ${e.listenPort} is not a port`);
    if (ports.has(e.listenPort)) throw new Error(`bench-egress: duplicate listenPort ${e.listenPort}`);
    const perTask = e.perTask === true;
    if (perTask && e.targetPort !== undefined) {
      throw new Error(`bench-egress: perTask endpoint '${e.name}' takes no targetPort; bind one with bindTaskEndpoint`);
    }
    if (!perTask && !isPort(e.targetPort)) throw new Error(`bench-egress: endpoint '${e.name}' targetPort ${e.targetPort} is not a port`);
    const targetHost = e.targetHost ?? '127.0.0.1';
    const transport = e.transport ?? 'tcp';
    if (transport !== 'tcp' && transport !== 'http') throw new Error(`bench-egress: invalid transport ${transport}`);
    if (!LOOPBACK_HOSTS.has(targetHost)) {
      throw new Error(`bench-egress: endpoint '${e.name}' target ${targetHost} is not loopback — the relay only fronts fixed local services`);
    }
    names.add(e.name);
    ports.add(e.listenPort);
    return { name: e.name, listenPort: e.listenPort, targetPort: perTask ? null : e.targetPort!, targetHost, perTask, transport };
  });
}

/** The sidecar's whole nginx.conf (exported for tests): one `stream` server per endpoint, nothing else. */
export function renderEgressNginxConf(endpoints: readonly { name: string; listenPort: number }[]): string {
  const servers = endpoints.map((e) => `  server { listen ${e.listenPort}; proxy_pass unix:${SIDECAR_RELAY_DIR}/${e.name}.sock; }`);
  return ['events {}', 'stream {', ...servers, '}', ''].join('\n');
}

/**
 * The TCP ports in LISTEN state in a `/proc/net/tcp` (+ `tcp6`) dump (exported for tests). Column 2 is
 * `local_address` as `HEXIP:HEXPORT`; column 4 is the state, `0A` = LISTEN.
 */
export function listeningPortsFromProcNet(text: string): Set<number> {
  const out = new Set<number>();
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== '0A') continue;
    const port = Number.parseInt(cols[1]?.split(':').pop() ?? '', 16);
    if (isPort(port)) out.add(port);
  }
  return out;
}

/** A docker object name from free text: `[a-z0-9_.-]`, bounded, never empty. */
function dockerSafe(s: string, max: number): string {
  const t = s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, max);
  return t || 'x';
}

interface Relay {
  server: Server;
  sockets: Set<Socket>;
}

/**
 * One relay: a unix-socket server that pipes every connection to a loopback target — fixed, or (perTask, D-033) read
 * from the endpoint's binding at connect time. A connection to an unbound perTask endpoint is counted and refused.
 */
async function startRelay(socketPath: string, ep: ResolvedEndpoint, stat: EndpointStats, binding?: EndpointBinding): Promise<Relay> {
  const sockets = new Set<Socket>();
  if (ep.transport === 'http') {
    const server = createHttpServer((req, res) => {
      const port = ep.perTask ? binding?.port ?? null : ep.targetPort;
      if (port === null) {
        stat.errors++;
        res.writeHead(503); res.end();
        return;
      }
      // This is a fixed-target reverse proxy, never a URL supplied by the task.
      // Preserve external-ingress/forwarding evidence: rewriting Host must not
      // turn an external request into a trusted local request at the MCP host.
      const host = ep.targetHost.includes(':') ? `[${ep.targetHost}]` : ep.targetHost;
      const upstream = httpRequest({ hostname: ep.targetHost, port, method: req.method,
        path: req.url, headers: { ...req.headers, host: `${host}:${port}`, connection: 'close' }, agent: false }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('socket', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      upstream.on('error', () => {
        stat.errors++;
        if (!res.headersSent) { res.writeHead(502); res.end(); }
        else res.destroy();
      });
      req.on('aborted', () => upstream.destroy());
      req.on('error', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });
    server.on('connection', socket => {
      stat.connections++;
      sockets.add(socket);
      socket.on('error', () => { stat.errors++; });
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    server.on('error', () => { stat.errors++; });
    chmodSync(socketPath, 0o666);
    return { server, sockets };
  }
  // allowHalfOpen: a client that half-closes after its request must still get the response back.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    stat.connections++;
    const port = ep.perTask ? binding?.port ?? null : ep.targetPort;
    if (port === null) {
      stat.errors++;
      client.destroy();
      return;
    }
    const upstream = connect({ host: ep.targetHost, port });
    sockets.add(client);
    sockets.add(upstream);
    const fail = () => {
      stat.errors++;
      client.destroy();
      upstream.destroy();
    };
    client.on('error', fail);
    upstream.on('error', fail);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    // pipe() propagates each side's end; no destroy on 'close', which could drop bytes still buffered for the peer.
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // A later server error must be counted, never left unhandled (an unhandled 'error' event would throw).
  server.on('error', () => {
    stat.errors++;
  });
  // The sidecar's nginx workers run as an unprivileged user; connect() needs write permission on the socket.
  chmodSync(socketPath, 0o666);
  return { server, sockets };
}

async function closeRelay(r: Relay): Promise<void> {
  for (const s of r.sockets) s.destroy();
  await new Promise<void>((resolve) => r.server.close(() => resolve()));
}

async function docker(exec: ProcExec, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await exec('docker', args);
    return { ok: r.code === 0, out: r.stdout, err: `exit ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
  } catch (e) {
    return { ok: false, out: '', err: (e as Error).message };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Remove every container, then every network, that carries `runId`'s egress label. This is the cleanup for a run
 * whose BenchEgress handle was lost: a start abandoned mid-`docker run`, or a caller that crashed before stop().
 * Containers go first because a network with an attached container cannot be removed. Never throws.
 */
export async function sweepBenchEgress(runId: string, exec: ProcExec = liveProcExec): Promise<EgressStopReport> {
  if (!runId?.trim()) throw new Error('bench-egress: runId is required');
  const label = `label=${BENCH_EGRESS_LABEL}=${dockerSafe(runId, 60)}`;
  const errors: string[] = [];
  const list = async (args: string[]): Promise<string[]> => {
    const r = await docker(exec, args);
    if (!r.ok) {
      errors.push(`list ${args.slice(0, 2).join(' ')}: ${r.err}`);
      return [];
    }
    return r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  };
  const containers = await list(['ps', '-aq', '--filter', label]);
  if (containers.length) {
    const r = await docker(exec, ['rm', '-f', ...containers]);
    if (!r.ok) errors.push(`rm containers ${containers.join(' ')}: ${r.err}`);
  }
  for (const network of await list(['network', 'ls', '-q', '--filter', label])) {
    const r = await docker(exec, ['network', 'rm', network]);
    if (!r.ok) errors.push(`rm network ${network}: ${r.err}`);
  }
  return { errors };
}

/**
 * Start the per-run egress: relay servers, base network, sidecar; waits until the sidecar listens on every endpoint
 * port. On any failure everything already created is torn down before the error is rethrown.
 */
export async function startBenchEgress(cfg: BenchEgressConfig): Promise<BenchEgress> {
  if (!cfg.runId?.trim()) throw new Error('bench-egress: runId is required');
  const endpoints = resolveEgressEndpoints(cfg.endpoints);
  const exec = cfg.exec ?? liveProcExec;
  const image = cfg.sidecarImage ?? BENCH_EGRESS_SIDECAR_IMAGE;
  if (!image || /\s/.test(image)) throw new Error(`bench-egress: bad sidecar image ${JSON.stringify(image)}`);
  const readyTimeoutMs = cfg.readyTimeoutMs ?? 15_000;
  const readyPollMs = cfg.readyPollMs ?? 200;

  // A random suffix keeps two runs with the same runId from colliding on docker names.
  const prefix = `pc-egress-${dockerSafe(cfg.runId, 24)}-${randomBytes(3).toString('hex')}`;
  const label = `${BENCH_EGRESS_LABEL}=${dockerSafe(cfg.runId, 60)}`;
  const baseNetwork = `${prefix}-base`;
  const sidecarName = `${prefix}-sidecar`;

  const workDir = mkdtempSync(join(cfg.workRoot ?? tmpdir(), 'pc-egress-'));
  const relayDir = join(workDir, 'relay');
  const relays: Relay[] = [];
  const stats: Record<string, EndpointStats> = {};
  const leases = new Map<string, TaskNetworkLease>();
  // D-033: one binding per perTask endpoint; with any perTask endpoint, at most one task network is opening or open.
  const bindings = new Map<string, EndpointBinding>(
    endpoints.filter((e) => e.perTask).map((e) => [e.name, { network: null, port: null }]),
  );
  let networksInUse = 0;
  let sidecarId = '';
  let sidecarAttempted = false;
  let baseCreated = false;
  let stopped = false;
  let seq = 0;

  const stop = async (): Promise<EgressStopReport> => {
    if (stopped) return { errors: [] };
    stopped = true;
    const errors: string[] = [];
    for (const lease of [...leases.values()]) errors.push(...(await lease.release()));
    if (sidecarId || sidecarAttempted) {
      // By NAME when the id never came back: the daemon can create the container even when the client's
      // `docker run -d` fails or is abandoned (a stalled run left `<prefix>-sidecar` behind in Created state).
      const r = await docker(exec, ['rm', '-f', sidecarId || sidecarName]);
      const neverCreated = !sidecarId && /no such container/i.test(r.err);
      if (!r.ok && !neverCreated) errors.push(`rm sidecar ${sidecarName}: ${r.err}`);
    }
    if (baseCreated) {
      const r = await docker(exec, ['network', 'rm', baseNetwork]);
      if (!r.ok) errors.push(`rm network ${baseNetwork}: ${r.err}`);
    }
    for (const relay of relays) {
      try {
        await closeRelay(relay);
      } catch (e) {
        errors.push(`close relay: ${(e as Error).message}`);
      }
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      errors.push(`remove ${workDir}: ${(e as Error).message}`);
    }
    return { errors };
  };

  try {
    mkdirSync(relayDir, { mode: 0o755 });
    chmodSync(relayDir, 0o755); // mkdir's mode is masked by the umask; the sidecar's worker must traverse the dir
    for (const ep of endpoints) {
      const socketPath = join(relayDir, `${ep.name}.sock`);
      if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
        throw new Error(`bench-egress: socket path too long for a unix socket (${socketPath}) — use a shorter workRoot`);
      }
      stats[ep.name] = { connections: 0, errors: 0 };
      relays.push(await startRelay(socketPath, ep, stats[ep.name]!, bindings.get(ep.name)));
    }
    const confPath = join(workDir, 'nginx.conf');
    writeFileSync(confPath, renderEgressNginxConf(endpoints), { mode: 0o644 });

    const net = await docker(exec, ['network', 'create', '--internal', '--label', label, baseNetwork]);
    if (!net.ok) throw new Error(`bench-egress: network create ${baseNetwork} failed — ${net.err}`);
    baseCreated = true;

    sidecarAttempted = true;
    const run = await docker(exec, [
      'run', '-d', '--name', sidecarName, '--label', label,
      '--network', baseNetwork, '--network-alias', BENCH_EGRESS_ALIAS,
      '-v', `${relayDir}:${SIDECAR_RELAY_DIR}`,
      '-v', `${confPath}:/etc/nginx/nginx.conf:ro`,
      image,
    ]);
    const id = run.out.trim().split('\n').pop() ?? '';
    if (!run.ok || !id) throw new Error(`bench-egress: sidecar start failed — ${run.err}`);
    sidecarId = id;

    // Ready = every endpoint port in LISTEN inside the sidecar. Read from /proc, so readiness sends no request
    // through to the gateway or MCP.
    const want = endpoints.map((e) => e.listenPort);
    const deadline = Date.now() + readyTimeoutMs;
    let seen = new Set<number>();
    for (;;) {
      const r = await docker(exec, ['exec', sidecarId, 'cat', '/proc/net/tcp', '/proc/net/tcp6']);
      if (r.ok) seen = listeningPortsFromProcNet(r.out);
      if (want.every((p) => seen.has(p))) break;
      if (Date.now() >= deadline) {
        const logs = await docker(exec, ['logs', '--tail', '20', sidecarId]);
        throw new Error(
          `bench-egress: sidecar not listening on [${want.filter((p) => !seen.has(p)).join(', ')}] after ${readyTimeoutMs}ms` +
            ` — logs: ${(logs.out + logs.err).trim().slice(0, 500)}`,
        );
      }
      await sleep(readyPollMs);
    }
  } catch (e) {
    const report = await stop();
    const err = e instanceof Error ? e : new Error(String(e));
    if (report.errors.length) err.message += ` (cleanup: ${report.errors.join('; ')})`;
    throw err;
  }

  const origins = new Map(endpoints.map((e) => [e.name, `http://${BENCH_EGRESS_ALIAS}:${e.listenPort}`]));

  return {
    runId: cfg.runId,
    alias: BENCH_EGRESS_ALIAS,
    sidecarId,
    baseNetwork,
    originFor(name: string): string {
      const o = origins.get(name);
      if (!o) throw new Error(`bench-egress: no endpoint named '${name}'`);
      return o;
    },
    async openTaskNetwork(tag: string): Promise<TaskNetworkLease> {
      if (stopped) throw new Error('bench-egress: stopped');
      // Counted synchronously, before any await, so two concurrent opens cannot both pass the check.
      if (bindings.size > 0 && networksInUse > 0) {
        throw new Error('bench-egress: an egress with per-task endpoints admits one open task network at a time (D-033)');
      }
      networksInUse++;
      const network = `${prefix}-t${++seq}-${dockerSafe(tag, 20)}`;
      const created = await docker(exec, ['network', 'create', '--internal', '--label', label, network]);
      if (!created.ok) {
        networksInUse--;
        throw new Error(`bench-egress: network create ${network} failed — ${created.err}`);
      }
      const joined = await docker(exec, ['network', 'connect', '--alias', BENCH_EGRESS_ALIAS, network, sidecarId]);
      if (!joined.ok) {
        await docker(exec, ['network', 'rm', network]);
        networksInUse--;
        throw new Error(`bench-egress: sidecar could not join ${network} — ${joined.err}`);
      }
      let released = false;
      const lease: TaskNetworkLease = {
        network,
        async release(): Promise<string[]> {
          if (released) return [];
          released = true;
          leases.delete(network);
          networksInUse--;
          for (const b of bindings.values()) {
            if (b.network === network) {
              b.network = null;
              b.port = null;
            }
          }
          const errors: string[] = [];
          const d = await docker(exec, ['network', 'disconnect', '-f', network, sidecarId]);
          if (!d.ok) errors.push(`disconnect sidecar from ${network}: ${d.err}`);
          const r = await docker(exec, ['network', 'rm', network]);
          if (!r.ok) errors.push(`rm network ${network}: ${r.err}`);
          return errors;
        },
      };
      leases.set(network, lease);
      return lease;
    },
    bindTaskEndpoint(network: string, name: string, targetPort: number): () => void {
      if (stopped) throw new Error('bench-egress: stopped');
      if (!origins.has(name)) throw new Error(`bench-egress: no endpoint named '${name}'`);
      const b = bindings.get(name);
      if (!b) throw new Error(`bench-egress: endpoint '${name}' is shared, not perTask`);
      if (!leases.has(network)) throw new Error(`bench-egress: task network ${network} is not open`);
      if (!isPort(targetPort)) throw new Error(`bench-egress: endpoint '${name}' targetPort ${targetPort} is not a port`);
      if (b.network !== null) throw new Error(`bench-egress: endpoint '${name}' is already bound to ${b.network}`);
      b.network = network;
      b.port = targetPort;
      return () => {
        if (b.network === network) {
          b.network = null;
          b.port = null;
        }
      };
    },
    stats(): Record<string, EndpointStats> {
      return Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v }]));
    },
    stop,
  };
}
