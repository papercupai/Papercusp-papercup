// WI-6554700010018147: a daemon deadline elapse is a cold/slow language server,
// not an unavailable daemon. The old answer said "LSP daemon unavailable" with
// health 'unhealthy' for both, so an agent hitting a cold start (measured ~150s
// for packages/operator-core) was told the backend was down instead of to retry.
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket.ts';
import { LSP_DAEMON_DEADLINE_MESSAGE, describeLspDaemonFailure, queryLspDaemon } from './lsp-daemon-client.ts';

describe('describeLspDaemonFailure', () => {
  it('reports a deadline elapse as degraded and tells the caller to retry', () => {
    const out = describeLspDaemonFailure(new Error(LSP_DAEMON_DEADLINE_MESSAGE), 90_001);
    expect(out.health).toBe('degraded');
    expect(out.error).toContain('did not answer within 90s');
    expect(out.error).toContain('retry');
    expect(out.error).not.toContain('unavailable');
  });

  it('keeps a genuine transport failure unhealthy and labelled unavailable', () => {
    const out = describeLspDaemonFailure(new Error('connect ENOENT /tmp/x.sock'), 12);
    expect(out).toEqual({ health: 'unhealthy', error: 'LSP daemon unavailable: connect ENOENT /tmp/x.sock' });
    expect(describeLspDaemonFailure('boom', 1).error).toBe('LSP daemon unavailable: boom');
  });
});

describe('queryLspDaemon against a daemon that never answers', () => {
  let server: Server | null = null;
  let dir: string | null = null;
  const held: Socket[] = [];
  const prior = process.env[LSP_DAEMON_SOCKET_ENV];

  afterEach(async () => {
    // server.close() resolves only once every connection has ended, so the
    // never-answering connections must be destroyed first or teardown hangs.
    for (const socket of held.splice(0)) socket.destroy();
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (prior === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
    else process.env[LSP_DAEMON_SOCKET_ENV] = prior;
  });

  it('returns a degraded retry answer at the deadline, not "daemon unavailable"', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lsp-daemon-client-'));
    const socketPath = join(dir, 'daemon.sock');
    // Accepts every connection (so the liveness probe passes) and never replies,
    // which is exactly what a daemon still loading a cold project looks like.
    server = createServer((socket) => { held.push(socket); socket.on('error', () => {}); });
    await new Promise<void>((done) => server!.listen(socketPath, () => done()));
    process.env[LSP_DAEMON_SOCKET_ENV] = socketPath;

    const answer = await queryLspDaemon({
      op: 'workspace_symbols',
      args: { name: 'readGateOwnership', rootPath: dir, language: 'typescript' },
      deadlineAtMs: Date.now() + 300,
    });

    expect(answer.sites).toEqual([]);
    expect(answer.freshness.health).toBe('degraded');
    expect(answer.error).toMatch(/did not answer within \d+s/);
    expect(answer.error).not.toContain('unavailable');
    expect(answer.latencyMs).toBeGreaterThanOrEqual(250);
  });
});
