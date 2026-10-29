/** Regression tests for the shared OS-level port availability probe. */
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portAvailable, portAvailableSync } from './port-availability';

const openServers: ReturnType<typeof createServer>[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function closeAll(): Promise<void> {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeAll();
});

describe('portAvailable', () => {
  it.each([
    { stage: 'preload', phase: 'not-started' },
    { stage: 'net-import', phase: 'started' },
  ])('retains the last measured phase when the child stalls during $stage', async ({ stage, phase }) => {
    const port = await freePort();
    const directory = mkdtempSync(join(tmpdir(), 'port-probe-stall-'));
    const preload = join(directory, 'stall.cjs');
    const stall = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);';
    writeFileSync(preload, stage === 'preload' ? stall : [
      "const Module=require('node:module');const load=Module._load;",
      "Module._load=function(request,...args){if(request==='node:net'){",
      stall,
      '}return load.call(this,request,...args);};',
    ].join(''));
    vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`);
    try {
      expect(() => portAvailableSync(port, '127.0.0.1')).toThrow(
        new RegExp(`code=ETIMEDOUT .*phase=${phase}\\b`),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports a failed probe subprocess instead of claiming a free port is occupied', async () => {
    const port = await freePort();
    vi.stubEnv('NODE_OPTIONS', '--require=/papercusp-missing-port-probe-preload.cjs');
    expect(() => portAvailableSync(port, '127.0.0.1')).toThrow(/port availability probe failed/i);
  });

  it('returns true for a free port and false for a held port', async () => {
    const port = await freePort();
    expect(await portAvailable(port, '127.0.0.1')).toBe(true);
    expect(portAvailableSync(port, '127.0.0.1')).toBe(true);

    const holder = createServer();
    openServers.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(port, '127.0.0.1', () => resolve());
    });
    expect(await portAvailable(port, '127.0.0.1')).toBe(false);
    expect(portAvailableSync(port, '127.0.0.1')).toBe(false);
  });

  it('returns false for an invalid numeric port', async () => {
    await expect(portAvailable(-1, '127.0.0.1')).resolves.toBe(false);
    await expect(portAvailable(65536, '127.0.0.1')).resolves.toBe(false);
    await expect(portAvailable(Number.NaN, '127.0.0.1')).resolves.toBe(false);
    expect(portAvailableSync(-1, '127.0.0.1')).toBe(false);
    expect(portAvailableSync(65536, '127.0.0.1')).toBe(false);
    expect(portAvailableSync(Number.NaN, '127.0.0.1')).toBe(false);
  });
});
