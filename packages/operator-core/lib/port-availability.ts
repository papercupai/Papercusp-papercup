/**
 * Probe whether a TCP port can be bound on a host without retaining the
 * listener. This is shared by the headless `serve` entrypoint and the Hono
 * host's pre-bootstrap guard so they use the same OS-level availability check.
 */
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';

/**
 * Return true when the operating system accepts a temporary bind for `port`.
 *
 * Port 0 is intentionally allowed: Node uses it to request an ephemeral port,
 * and callers that support that mode should retain the existing behavior.
 * Invalid numeric ports resolve false instead of leaving a probe promise
 * unresolved after a synchronous `listen()` validation error.
 */
export function portAvailable(port: number, host: string): Promise<boolean> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.resolve(false);
  }

  return new Promise((resolve, reject) => {
    const probe = createServer();
    let settled = false;

    const finish = (available: boolean, failure?: Error): void => {
      if (settled) return;
      settled = true;
      probe.removeListener('error', onError);
      const complete = (closeError?: Error): void => {
        const error = failure ?? closeError;
        if (error) reject(error);
        else resolve(available);
      };
      if (probe.listening) {
        probe.close(complete);
      } else {
        complete();
      }
    };

    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') finish(false);
      else finish(false, error);
    };

    probe.once('error', onError);
    try {
      probe.listen(port, host, () => finish(true));
    } catch (error) {
      const probeError = error instanceof Error ? error : new Error(String(error));
      onError(probeError as NodeJS.ErrnoException);
    }
  });
}

/**
 * Synchronous companion for entrypoints that must probe before importing a
 * large startup graph. The child owns the asynchronous bind/close lifecycle;
 * the caller blocks only for that tiny probe and receives the same OS-level
 * answer without a top-level await (which `tsx` compiles to CommonJS).
 * A child startup/transport failure is not evidence that a port is occupied.
 * Throw for an unmeasured result so callers cannot mislabel it EADDRINUSE.
 */
export function portAvailableSync(port: number, host: string): boolean {
  if (!Number.isInteger(port) || port < 0 || port > 65535) return false;

  const probe = [
    'const started=Date.now();',
    "const report=fields=>process.stdout.write(JSON.stringify({...fields,elapsedMs:Date.now()-started})+'\\n');",
    "report({phase:'started'});",
    "const net=require('node:net');",
    'const server=net.createServer();',
    "server.once('error',error=>{report({phase:'bind-error',errorCode:error.code??'UNKNOWN'});process.exitCode=1;});",
    "report({phase:'binding'});",
    `server.listen(${port}, ${JSON.stringify(host)}, () => {report({phase:'listening'});server.close(() => report({phase:'closed'}));});`,
  ].join('');
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  let phase = 'not-started';
  let childElapsedMs: number | undefined;
  let errorCode: string | undefined;
  try {
    for (const line of (result.stdout ?? '').trim().split('\n').filter(Boolean)) {
      const report: unknown = JSON.parse(line);
      if (!report || typeof report !== 'object' || !('phase' in report) || typeof report.phase !== 'string') {
        throw new Error('Invalid port probe phase report');
      }
      phase = report.phase;
      if ('elapsedMs' in report && typeof report.elapsedMs === 'number') childElapsedMs = report.elapsedMs;
      if ('errorCode' in report && typeof report.errorCode === 'string') errorCode = report.errorCode;
    }
  } catch {
    // Corrupt/foreign output cannot certify a successful availability check.
    phase = 'invalid-report';
  }
  if (!result.error && result.status === 0 && phase === 'closed') return true;
  if (!result.error && result.status === 1 && phase === 'bind-error' && errorCode === 'EADDRINUSE') return false;
  const spawnCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  throw new Error(
    `Port availability probe failed for ${host}:${port}: ` +
      `code=${spawnCode ?? errorCode ?? 'unmeasured'} exit=${result.status} signal=${result.signal} ` +
      `phase=${phase} elapsedMs=${Date.now() - started} childElapsedMs=${childElapsedMs ?? 'unmeasured'} ` +
      `stderrPresent=${Boolean(result.stderr)}`,
  );
}
