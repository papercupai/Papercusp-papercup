import net from 'node:net';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('self-contained embedding CLI startup', () => {
  it('loads the local benchmark without connecting to an unavailable Postgres server', async () => {
    let connections = 0;
    const sockets = new Set<net.Socket>();
    // A real TCP endpoint returning the same startup error as the failed P-005
    // child. No database or model weights are needed to check import isolation.
    const server = net.createServer((socket) => {
      connections++; sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => {
        const fields = Buffer.from('SFATAL\0C08P01\0Mdatabase system is shutting down (server_login_retry)\0\0');
        const length = Buffer.alloc(4); length.writeInt32BE(fields.length + 4);
        socket.end(Buffer.concat([Buffer.from('E'), length, fields]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const url = `postgres://probe:probe@127.0.0.1:${port}/probe`;
      const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_DATABASE_URL: url, HARNESS_ADMIN_DATABASE_URL: url, DATABASE_URL: url,
        PAPERCUSP_PGBOUNCER: '0', PAPERCUSP_SKIP_PG_DISCOVERY: '1', PAPERCUSP_FORBID_REAL_PG: '0' };
      delete env.VITEST;
      const script = `
        const exit = process.exit.bind(process);
        let requestedExit;
        process.exit = (code) => { requestedExit = code; };
        process.argv.push('--run-performance', 'unused');
        await import(${JSON.stringify(new URL('./embedder-eval-cli.ts', import.meta.url).href)});
        // Let any import-time database promises start. The intentional missing
        // arguments stop before preparation, artifact writes or inference.
        setTimeout(() => {
          console.log('startup-guard-exit', requestedExit);
          exit(requestedExit === 1 ? 0 : 2);
        }, 1000);
      `;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env });
        let stdout = '', stderr = '';
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI startup probe timed out')); }, 20_000);
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      });
      expect(result.stderr).toContain('--run-performance requires --mdenseon-model and --driver-out');
      expect(result.stdout).toContain('startup-guard-exit 1');
      expect(result.code, result.stderr).toBe(0);
      expect(connections, 'local CLI startup must not open operator database pools').toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
