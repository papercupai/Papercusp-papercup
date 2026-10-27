import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { createSubstrateSidecarHost } from './substrate-sidecar-host';
import { createSubstrateSidecarControlServer } from './substrate-sidecar-server';

const exec = promisify(execFile);
const interpreters = [{ executable: process.execPath, name: 'node' },
  ...(process.env.PAPERCUSP_RUNTIME_TEST_BUN
    ? [{ executable: process.env.PAPERCUSP_RUNTIME_TEST_BUN, name: 'bun' }] : [])];

describe('retained Node substrate control transport', () => {
  it.each(interpreters)('$name client writes and reopens real native storage across the process boundary', async ({ executable, name }) => {
    // This verifies the existing production client, dispatcher and native store.
    // It does not claim packaged-candidate, swarm, projection or platform acceptance.
    expect(process.versions.bun).toBeUndefined();
    const root = await mkdtemp(join(tmpdir(), 'pc-runtime-ipc-'));
    const socket = process.platform === 'win32'
      ? `\\\\.\\pipe\\pc-runtime-ipc-${process.pid}-${Date.now()}` : join(root, 'rpc.sock');
    const host = createSubstrateSidecarHost();
    const server = createSubstrateSidecarControlServer(host);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, resolve);
      });
      const clientSource = fileURLToPath(new URL('./substrate-ipc-client.ts', import.meta.url));
      const runner = join(root, 'client.mjs');
      buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { SubstrateIpcClient } from ${JSON.stringify(clientSource)};
const client = new SubstrateIpcClient(process.argv[2]);
const store = { workspaceId: 'runtime-boundary', harnessSlug: 'native-store', storagePath: process.argv[3] };
try {
  const health = await client.call('sidecar:healthz');
  const opened = await client.call('substrate:openStore', store);
  const appended = await client.call('substrate:appendOp', { storeId: opened.storeId, op: {
    type: 'put', table: 'feature_queue', hbKey: 'runtime-roundtrip',
    value: { text: 'Bun → Node: café 雪' }, ts: 123, schema_version: 1,
  } });
  await client.call('substrate:closeStore', { storeId: opened.storeId });
  const reopened = await client.call('substrate:openStore', store);
  const persisted = await client.call('substrate:getOwnLogOp', { storeId: reopened.storeId, index: 0 });
  let rejectedUnknownMethod = false;
  try { await client.call('runtime:unknown'); }
  catch (error) { rejectedUnknownMethod = error.message.includes('Method not found'); }
  await client.call('substrate:closeStore', { storeId: reopened.storeId });
  process.stdout.write(JSON.stringify({ runtime: { name: process.versions.bun ? 'bun' : 'node',
    executable: process.execPath, pid: process.pid }, health: health.status, appended: appended.ok,
    value: persisted.op.value, length: persisted.length, stamped: Boolean(persisted.op.hlc), rejectedUnknownMethod }));
} finally { client.close(); }
` }, outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const result = await exec(executable, [runner, socket, join(root, 'store')], {
        env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      expect(result.stderr).toBe('');
      const observed = JSON.parse(result.stdout);
      expect(observed).toMatchObject({ runtime: { name }, health: 'ready', appended: true,
        value: { text: 'Bun → Node: café 雪' }, length: 1, stamped: true, rejectedUnknownMethod: true });
      expect(observed.runtime.pid).not.toBe(process.pid);
      expect(await realpath(observed.runtime.executable)).toBe(await realpath(executable));
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await host.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
