import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import { runWorkbenchCommand } from './workbench-command';

describe('PUI workbench control commands', () => {
  test('serves an operator request while its control child waits for that response', async () => {
    const server = createServer((_request, response) => response.end('operator responsive'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const result = await runWorkbenchCommand(process.execPath, ['-e',
        'require("node:http").get(process.argv[1], r => r.pipe(process.stdout))',
        `http://127.0.0.1:${port}`,
      ], { timeoutMs: 3_000 });
      expect(result).toMatchObject({ status: 0, stdout: 'operator responsive', stderr: '' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('retains a failed control command status and both output streams', async () => {
    const result = await runWorkbenchCommand(process.execPath, ['-e',
      'process.stdout.write("partial list"); process.stderr.write("control failed"); process.exit(7)',
    ]);
    expect(result).toMatchObject({ status: 7, stdout: 'partial list', stderr: 'control failed' });
  });

  test('reports a timed-out command as failed, never as a successful empty session list', async () => {
    const result = await runWorkbenchCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 100 });
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });
});
