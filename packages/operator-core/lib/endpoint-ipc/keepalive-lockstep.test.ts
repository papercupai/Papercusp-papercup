/**
 * The endpoint-IPC keepalive event name is written in two languages: the Node server sends it
 * (`IPC_KEEPALIVE_EVENT` in `@papercusp/ipc-endpoint-server`) and the desktop's Rust client
 * swallows it as activity (`IPC_KEEPALIVE_EVENT` in papercusp-desktop/src-tauri/src/endpoint_ipc.rs).
 * If the two drift, the desktop forwards every keepalive to the webview AND stops counting them as
 * activity, so slow requests are force-failed as wedged again (WI-6554700010008458). This pins them.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IPC_KEEPALIVE_INTERVAL_MS, IPC_KEEPALIVE_EVENT } from '@papercusp/ipc-endpoint-server';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RUST_CLIENT = resolve(REPO_ROOT, 'papercusp-desktop/src-tauri/src/endpoint_ipc.rs');

function rustConst(source: string, name: string): string {
  const match = new RegExp(`const ${name}: [^=]+= ([^;]+);`).exec(source);
  if (!match) throw new Error(`endpoint_ipc.rs declares no const ${name}`);
  return match[1]!.trim();
}

describe('endpoint-IPC keepalive lockstep (Node server ↔ desktop Rust client)', () => {
  const source = readFileSync(RUST_CLIENT, 'utf8');

  it('names the keepalive event identically on both sides', () => {
    expect(rustConst(source, 'IPC_KEEPALIVE_EVENT')).toBe(JSON.stringify(IPC_KEEPALIVE_EVENT));
  });

  it('beats well inside the client call budget, so one late beat cannot trip the watchdog', () => {
    const budget = Number(rustConst(source, 'IPC_CALL_IDLE_TIMEOUT_MS').replace(/_/g, ''));
    expect(Number.isFinite(budget)).toBe(true);
    expect(DEFAULT_IPC_KEEPALIVE_INTERVAL_MS * 3).toBeLessThanOrEqual(budget);
  });
});
