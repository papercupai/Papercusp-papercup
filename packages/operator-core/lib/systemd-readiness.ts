/**
 * systemd readiness notification for long-starting operator hosts.
 *
 * Type=notify services must not become active until the request listener is
 * bound. The helper is deliberately fire-and-forget: an unavailable notifier
 * must never turn a healthy HTTP host into a crash loop.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10_000;

function notifyTimeoutMs(): number {
  const configured = Number(process.env.PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, configured);
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown systemd notification failure';
  }
}

function logFailure(message: string): void {
  try {
    console.warn('[systemd-readiness] ' + message);
  } catch {
    // Logging is best effort. A notifier failure must not crash the host.
  }
}

/** Notify systemd after the HTTP server has actually bound its listener. */
export function notifySystemdReady(): void {
  if (!process.env.NOTIFY_SOCKET) return;

  try {
    const notifier = createSystemdNotifier();
    if (!notifier) return;
    // The one-shot CLI can time out in its acknowledgement barrier or exit
    // before the manager attributes its datagram. Keep the existing native
    // sender alive in our cgroup after READY, just as the Portal launcher does.
    // Type=notify credits readiness only after the listener has bound.
    void notifier.notify('READY=1').catch((error) => {
      notifier.close();
      logFailure('READY=1 notification failed: ' + errorMessage(error));
    });
  } catch (error) {
    logFailure('unable to create readiness notifier: ' + errorMessage(error));
  }
}

// Keep the sender alive in the service cgroup: a fork-per-ping --no-block
// notifier can exit before systemd attributes its datagram. libsystemd owns
// the native protocol; Python is only the host's stdlib FFI/stdio bridge.
const PERSISTENT_NOTIFY_BRIDGE = `
import ctypes, ctypes.util, json, sys
library = ctypes.util.find_library('systemd')
if not library:
    raise RuntimeError('libsystemd_unavailable')
systemd = ctypes.CDLL(library)
systemd.sd_notify.argtypes = [ctypes.c_int, ctypes.c_char_p]
systemd.sd_notify.restype = ctypes.c_int
for line in sys.stdin:
    request = json.loads(line)
    result = systemd.sd_notify(0, request['state'].encode('utf-8'))
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
`;

export interface SystemdNotifier {
  notify(state: string): Promise<void>;
  close(): void;
}

/** A single long-lived, cgroup-attributable sender for readiness AND watchdogs. */
export function createSystemdNotifier(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = notifyTimeoutMs(),
): SystemdNotifier | null {
  if (!env.NOTIFY_SOCKET) return null;
  const sender = spawn('python3', ['-u', '-c', PERSISTENT_NOTIFY_BRIDGE], {
    // Do not copy hosted integration secrets into this transport process.
    env: { PATH: env.PATH, NOTIFY_SOCKET: env.NOTIFY_SOCKET },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = createInterface({ input: sender.stdout });
  let sequence = 0;
  let closed = false;
  let failure: Error | undefined;
  const pending = new Map<number, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const failPending = (error: Error) => {
    failure = error;
    for (const call of pending.values()) {
      clearTimeout(call.timeout);
      call.reject(error);
    }
    pending.clear();
  };
  sender.stdin.on('error', failPending);
  sender.stdout.on('error', failPending);
  sender.stderr.on('error', failPending);
  sender.stderr.on('data', () => { /* Drain errors; never reflect arbitrary bridge output. */ });
  sender.once('error', (error) => failPending(error));
  sender.once('exit', (code, signal) => {
    if (!closed) failPending(new Error(`systemd_notification_sender_exit:${signal ?? code}`));
  });
  replies.on('line', (line) => {
    let reply: { id: number; result: number };
    try { reply = JSON.parse(line); } catch {
      failPending(new Error('systemd_notification_invalid_reply'));
      return;
    }
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    clearTimeout(call.timeout);
    if (reply.result > 0) call.resolve();
    else call.reject(new Error(`systemd_notification_send_failed:${reply.result}`));
  });
  return {
    notify(state) {
      if (closed || failure) return Promise.reject(failure ?? new Error('systemd_notification_sender_closed'));
      return new Promise<void>((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error('systemd_notification_send_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
        sender.stdin.write(`${JSON.stringify({ id, state })}\n`, (error) => {
          const call = pending.get(id);
          if (!error || !call) return;
          pending.delete(id);
          clearTimeout(call.timeout);
          call.reject(error);
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      failPending(new Error('systemd_notification_sender_closed'));
      replies.close();
      sender.stdin.end();
      sender.kill('SIGTERM');
    },
  };
}
