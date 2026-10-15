import { describe, expect, it } from 'vitest';
import {
  PG_DEATH_LOG_WINDOW,
  startPostgresWithDiagnostics,
} from '../../../libs/papercusp/packages/embedded-postgres-server/src/pg-supervisor.js';

describe('startPostgresWithDiagnostics', () => {
  it('turns a bare start rejection into an actionable bounded diagnostic', async () => {
    const recentLines = [
      ...Array.from({ length: PG_DEATH_LOG_WINDOW + 1 }, (_, index) => `postgres line ${index + 1}`),
      'FATAL: could not create any TCP/IP sockets',
    ];
    const failure = await startPostgresWithDiagnostics({
      start: () => Promise.reject(undefined),
      port: 55432,
      dataDir: '/tmp/papercusp-embedded-pg',
      recentLines: () => recentLines,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('localhost:55432');
    expect(message).toContain('"/tmp/papercusp-embedded-pg"');
    expect(message).toContain('rejected without an error value');
    expect(message).toContain(
      `Recent PostgreSQL startup output (last ${PG_DEATH_LOG_WINDOW} lines):`,
    );
    expect(message.split('\n')).not.toContain('postgres line 1');
    expect(message).toContain(`postgres line ${PG_DEATH_LOG_WINDOW + 1}`);
    expect(message).toContain('FATAL: could not create any TCP/IP sockets');
  });

  it('preserves a descriptive library Error as the cause', async () => {
    const cause = new Error('postmaster exited before ready');
    const failure = await startPostgresWithDiagnostics({
      start: () => Promise.reject(cause),
      port: 5532,
      dataDir: '/tmp/embedded-pg',
      recentLines: () => [],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { cause?: unknown }).cause).toBe(cause);
    expect((failure as Error).message).toContain('Error: postmaster exited before ready');
    expect((failure as Error).message).toContain('No PostgreSQL startup output was captured.');
  });
});
