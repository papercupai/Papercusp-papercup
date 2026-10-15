/** Actual current-source HTTP MCP client, private operator identity and PostgreSQL. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createWriteStream } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('managed capability acceptance over the production HTTP route', () => {
  it('retains kernel/browser state across fresh clients and refuses PTY without a private session bus', async () => {
    const root = resolve(__dirname, '../../../../..');
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
        resolve(__dirname, '__fixtures__/managed-api-client.mts')], {
        cwd: root, env: { ...process.env, TMPDIR: '/dev/shm' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const log = process.env.PC_EXECUTED_SOURCE_MAP_OUT
        ? createWriteStream(process.env.PC_EXECUTED_SOURCE_MAP_OUT + '.client.log') : null;
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
        output = (output + data).slice(-30_000); log?.write(data);
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); log?.end(); resolveResult({ code, output }); });
    });
    expect(result.code, result.output).toBe(0);
    const cleanup = result.output.split('\n').find(row => row.startsWith('MANAGED_API_CLEANUP='));
    expect(cleanup, result.output).toBeDefined();
    expect(JSON.parse(cleanup!.slice('MANAGED_API_CLEANUP='.length))).toMatchObject({
      rows: 1, processes: 'gone', browserRoots: 'gone', terminalRecorded: true,
    });
    const line = result.output.split('\n').find(row => row.startsWith('MANAGED_API_PROOF='));
    expect(line, result.output).toBeDefined();
    expect(JSON.parse(line!.slice('MANAGED_API_PROOF='.length))).toMatchObject({
      transport: 'http', kernel: 'retained-across-clients', browser: 'retained-across-clients',
      pty: 'refused-without-private-session-bus', foreignHandles: 'refused',
    });
  }, 200_000);
});
