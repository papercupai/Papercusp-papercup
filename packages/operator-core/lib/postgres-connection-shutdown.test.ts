import postgres from 'postgres';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the installed driver, including the maintained patch, rather than a
// copied scheduler. No server is needed: the socket factory records each open.
const driverEntry = process.env.PAPERCUSP_POSTGRES_SHUTDOWN_TEST_ENTRY ?? import.meta.resolve('postgres');
const drivers = await Promise.all([
  ['esm', './connection.js'],
  ['commonjs', '../cjs/src/connection.js'],
  ['cloudflare', '../cf/src/connection.js'],
].map(async ([name, path]) => [name, (await import(
  /* @vite-ignore */ new URL(path, driverEntry).href
)).default] as const));

afterEach(() => vi.useRealTimers());

describe.each(drivers)('%s postgres shutdown before its deferred connect', (_name, Connection) => {
function fixture() {
  const open = vi.fn(() => { throw new Error('test socket factory'); });
  const sql = postgres('postgres://test:test@127.0.0.1:1/test', { socket: open });
  const connection = Connection(sql.options);
  const query = { reserve: true, reject: vi.fn() };
  return { connection, open, query };
}

  it('does not open a socket after terminating a scheduled connection', async () => {
    vi.useFakeTimers();
    const { connection, open, query } = fixture();
    connection.connect(query);
    connection.terminate();
    expect(query.reject).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('still opens a socket for an admitted connection', async () => {
    vi.useFakeTimers();
    const { connection, open, query } = fixture();
    connection.connect(query);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledOnce();
    connection.terminate();
  });

  it('allows an explicit pool reuse after terminating the earlier attempt', async () => {
    vi.useFakeTimers();
    const { connection, open, query } = fixture();
    connection.connect(query);
    connection.terminate();
    connection.connect({ reserve: true, reject: vi.fn() });
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledOnce();
    connection.terminate();
  });

  it('discards a socket factory result that completes after termination', async () => {
    vi.useFakeTimers();
    let resolveSocket!: (socket: net.Socket) => void;
    const open = vi.fn(() => new Promise<net.Socket>(resolve => { resolveSocket = resolve; }));
    const sql = postgres('postgres://test:test@127.0.0.1:1/test', { socket: open });
    const connection = Connection(sql.options);
    connection.connect({ reserve: true, reject: vi.fn() });
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledOnce();
    connection.terminate();
    const socket = new net.Socket();
    resolveSocket(socket);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// The Cloudflare build uses its own Workers socket polyfill, rather than Node's
// net.Socket. The deferred/custom-socket cases above cover that build too.
describe.each(drivers.filter(([name]) => name !== 'cloudflare'))('%s postgres shutdown during TCP connect', (_name, Connection) => {
  it('closes a default TCP socket terminated before its connect event', async () => {
    const accepted = new Set<net.Socket>();
    const server = net.createServer(socket => {
      accepted.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => accepted.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const sql = postgres(`postgres://test:test@127.0.0.1:${port}/test`);
    const connection = Connection(sql.options);
    let resolveConnecting!: (socket: net.Socket) => void;
    const connecting = new Promise<net.Socket>(resolve => { resolveConnecting = resolve; });
    const originalConnect = net.Socket.prototype.connect;
    const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function(this: net.Socket, ...args) {
      const result = Reflect.apply(originalConnect, this, args);
      if (Number(args[0]) === port) resolveConnecting(this);
      return result;
    });
    let socket: net.Socket | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      connection.connect({ reserve: true, reject: vi.fn() });
      socket = await connecting;
      expect(socket.connecting).toBe(true);
      const closed = new Promise<boolean>(resolve => socket!.once('close', () => resolve(true)));
      connection.terminate();
      const closedAfterTermination = await Promise.race([closed,
        new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 250); })]);
      expect(closedAfterTermination, 'terminate must close a socket still opening, before any PostgreSQL startup').toBe(true);
    } finally {
      clearTimeout(deadline);
      connect.mockRestore();
      connection.terminate();
      socket?.destroy();
      for (const client of accepted) client.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
