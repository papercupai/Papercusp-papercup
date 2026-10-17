/** Portable provider side of the existing JSON-RPC protocol. The caller owns framing;
 * host.fetch remains the sole network authority. Bundle this into installed daemons.
 */
import { PROVIDER_DAEMON_METHODS, providerSyncErrorOf, type ProviderAdapter, type ProviderHost, type ProviderSyncRequest, type ProviderInvokeRequest } from './provider';

export interface ProviderDaemonMessage {
  jsonrpc: '2.0';
  id: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Each call has a separate lifetime; concurrent accounts never share a fetch binding. */
export function createProviderDaemon(adapter: ProviderAdapter, send: (message: ProviderDaemonMessage) => void, options: { fetchTimeoutMs?: number } = {}) {
  let closed = false;
  let sequence = 0;
  const pending = new Map<string, { reject: (error: Error) => void; resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout>; scope: object }>();
  const failScope = (scope: object, error: Error) => {
    for (const [id, waiter] of pending) {
      if (waiter.scope !== scope) continue;
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const replyError = (id: string | number, error: unknown) => {
    const e = error as { code?: unknown; data?: unknown; message?: unknown } | null;
    const classified = providerSyncErrorOf(error);
    // Classification narrows the retry signal, while data also holds a
    // provider's operation receipt (e.g. an unconfirmed publish container).
    // Keep that receipt across the process boundary; normalized fields win.
    const data = classified
      ? { ...(e?.data && typeof e.data === 'object' && !Array.isArray(e.data) ? e.data : {}), ...classified }
      : e?.data;
    if (!closed) send({ jsonrpc: '2.0', id, error: {
      code: typeof e?.code === 'number' ? e.code : -32000,
      message: String(e?.message ?? error),
      ...(data === undefined ? {} : { data }),
    } });
  };
  const handle = async (method: string, params: unknown) => {
    if (method === 'papercup.ping') return 'pong';
    if (method === PROVIDER_DAEMON_METHODS.describe) return adapter.describe();
    if (method !== PROVIDER_DAEMON_METHODS.syncPage && method !== PROVIDER_DAEMON_METHODS.invoke) {
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
    const p = params as { request?: ProviderSyncRequest | ProviderInvokeRequest; callToken?: string } | null;
    if (!p?.request || typeof p.request.source !== 'string' || !p.request.source || typeof p.callToken !== 'string' || !p.callToken) {
      throw Object.assign(new Error('provider call requires request.source and callToken'), { code: -32602 });
    }
    const { request, callToken } = p;
    const scope = {};
    let active = true;
    const host: ProviderHost = {
      fetch: ({ source, request: fetchRequest }) => {
        if (closed || !active) return Promise.reject(new Error('provider call closed'));
        const id = `fetch:${++sequence}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('host.fetch timed out')); }, options.fetchTimeoutMs ?? 30_000);
          pending.set(id, { scope, timer, reject, resolve: (value) => resolve(value as Awaited<ReturnType<ProviderHost['fetch']>>) });
          try { send({ jsonrpc: '2.0', id, method: PROVIDER_DAEMON_METHODS.hostFetch, params: { callToken, source, request: fetchRequest } }); }
          catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
      },
    };
    try {
      return await (method === PROVIDER_DAEMON_METHODS.syncPage ? adapter.syncPage(request as ProviderSyncRequest, host) : adapter.invoke(request as ProviderInvokeRequest, host));
    } finally { active = false; failScope(scope, new Error('provider call finished')); }
  };
  return {
    receive(message: unknown): void {
      if (closed || !message || typeof message !== 'object') return;
      const m = message as ProviderDaemonMessage;
      if (m.jsonrpc !== '2.0' || (typeof m.id !== 'number' && typeof m.id !== 'string')) return;
      if (m.method === undefined) {
        const waiter = pending.get(String(m.id));
        if (!waiter) return;
        pending.delete(String(m.id));
        clearTimeout(waiter.timer);
        if (m.error) waiter.reject(Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data }));
        else waiter.resolve(m.result);
        return;
      }
      if (typeof m.method !== 'string') return;
      void handle(m.method, m.params).then(
        (result) => { if (!closed) send({ jsonrpc: '2.0', id: m.id, result: result ?? null }); },
        (error) => replyError(m.id, error),
      );
    },
    pendingFetches: () => pending.size,
    close(): void {
      closed = true;
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('provider transport closed')); }
      pending.clear();
    },
  };
}
