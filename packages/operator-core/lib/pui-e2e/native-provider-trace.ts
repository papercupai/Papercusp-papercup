/** Keep the fixture's real upstream across starts of the same native home. */
export function nativeProviderTraceOrigin(
  configuredOrigin: string,
  traceOrigin: string,
  previousOrigin?: string,
): string {
  const trace = new URL(traceOrigin);
  const tracePath = trace.pathname.replace(/\/$/, '');
  const isSelf = (value: string) => {
    const url = new URL(value);
    return url.origin === trace.origin
      && (url.pathname === tracePath || url.pathname.startsWith(`${tracePath}/`));
  };
  const origin = isSelf(configuredOrigin) ? previousOrigin : configuredOrigin;
  if (!origin || isSelf(origin)) throw new Error('Provider trace has no non-recursive upstream');
  return origin;
}

/** Hono's incoming-close reasons must retain the adapter's stream-cancel code
 * when forwarded through fetch; unrelated failures keep their original cause. */
export function nativeProviderRequestSignal(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    const reason: unknown = signal.reason;
    const clientClosed = reason === 'Client connection prematurely closed.' || reason === 'Error: aborted'
      || reason instanceof Error && reason.message === 'aborted'
        && (reason as NodeJS.ErrnoException).code === 'ECONNRESET';
    controller.abort(clientClosed
      ? Object.assign(new Error('Provider trace client disconnected', { cause: reason }), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
      : reason);
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export interface NativeRpcReceiptMetadata {
  peerId?: string;
  clockId?: string;
  atMs?: number;
  sequence?: number;
  phase: string;
  frame: Record<string, unknown>;
}

export interface NativeRpcReceiptState {
  peerId?: string;
  clockId?: string;
  emitted?: number;
  enabled?: boolean;
  sinkFailed?: boolean;
  exited?: boolean;
  pendingWrites?: number;
}

/** Summarize parent-process RPC receipts without retaining prompts or secrets. */
export function nativeRpcReceiptSummary(
  receipts: readonly NativeRpcReceiptMetadata[],
  receiptState?: NativeRpcReceiptState,
  options: { max?: number; totalObserved?: number } = {},
): Record<string, unknown> {
  const max = Math.max(1, Math.floor(options.max ?? 50));
  const totalObserved = Math.max(receipts.length, options.totalObserved ?? receipts.length);
  const retained = receipts.slice(-max).map((receipt) => ({
    peerId: receipt.peerId,
    clockId: receipt.clockId,
    atMs: receipt.atMs,
    sequence: receipt.sequence,
    phase: receipt.phase,
    frame: {
      id: typeof receipt.frame.id === 'string' || typeof receipt.frame.id === 'number' ? receipt.frame.id : undefined,
      type: typeof receipt.frame.type === 'string' ? receipt.frame.type : undefined,
      method: typeof receipt.frame.method === 'string' ? receipt.frame.method : undefined,
      command: typeof receipt.frame.command === 'string' ? receipt.frame.command : undefined,
      keys: Object.keys(receipt.frame).slice(0, 16),
    },
  }));
  const phases = receipts.reduce<Record<string, number>>((counts, receipt) => {
    counts[receipt.phase] = (counts[receipt.phase] ?? 0) + 1;
    return counts;
  }, {});
  return {
    total: totalObserved,
    retained: retained.length,
    omitted: Math.max(0, totalObserved - retained.length),
    retainedPhases: phases,
    receipts: retained,
    ...(receiptState ? { receiptState: { ...receiptState } } : {}),
  };
}
