/**
 * P-531 (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005523): a sidecar spawned by
 * its Server exits when idle so the embedding model's ~1 GB returns to the host, and
 * the spawner treats that announced clean exit as idle (no crash-respawn) and
 * re-launches lazily. These tests pin the three seams: the idle predicate + env
 * parsing, the server's activity accounting (the liveness probe must NOT count as
 * activity), and the spawner's exit classification.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmbedSidecarServer,
  EMBED_SIDECAR_IDLE_EXIT_ENV,
  EMBED_SIDECAR_PROBE_HEADER,
  resolveEmbedSidecarIdleExitMs,
  shouldIdleExit,
  type EmbedSidecarHandle,
} from './embed-sidecar-server';
import { classifyEmbedSidecarExit } from './embed-sidecar-spawn';

describe('shouldIdleExit', () => {
  const idle = { inFlight: 0, lastActivityAt: 1_000 };
  it('never exits when the window is 0 (feature off)', () => {
    expect(shouldIdleExit(idle, 10_000_000, 0)).toBe(false);
  });
  it('exits once the idle window has fully elapsed with nothing in flight', () => {
    expect(shouldIdleExit(idle, 1_000 + 60_000, 60_000)).toBe(true);
    expect(shouldIdleExit(idle, 1_000 + 59_999, 60_000)).toBe(false);
  });
  it('never exits while a request is in flight, however old the last activity', () => {
    expect(shouldIdleExit({ inFlight: 1, lastActivityAt: 0 }, 10_000_000, 60_000)).toBe(false);
  });
});

describe('resolveEmbedSidecarIdleExitMs', () => {
  it('is 0 (never) when unset, non-numeric, zero or negative', () => {
    expect(resolveEmbedSidecarIdleExitMs({})).toBe(0);
    for (const v of ['', 'abc', '0', '-5']) {
      expect(resolveEmbedSidecarIdleExitMs({ [EMBED_SIDECAR_IDLE_EXIT_ENV]: v })).toBe(0);
    }
  });
  it('parses a positive window in ms', () => {
    expect(resolveEmbedSidecarIdleExitMs({ [EMBED_SIDECAR_IDLE_EXIT_ENV]: '600000' })).toBe(600_000);
  });
});

describe('createEmbedSidecarServer activity accounting', () => {
  let handle: EmbedSidecarHandle | null = null;
  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  async function boot(): Promise<string> {
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      embedDevice: { load: async () => ({ setting: null, changed: false, readError: null }) },
    });
    return `http://127.0.0.1:${await handle.listening}`;
  }

  it('does not count GET /healthz as activity, so liveness probes cannot keep an idle sidecar alive', async () => {
    const base = await boot();
    const before = handle!.activity();
    await new Promise((r) => setTimeout(r, 20));
    const res = await fetch(`${base}/healthz`);
    await res.arrayBuffer();
    const after = handle!.activity();
    expect(after.inFlight).toBe(0);
    expect(after.lastActivityAt).toBe(before.lastActivityAt);
  });

  it('does not count a request marked as a health probe as activity (P-532b)', async () => {
    const base = await boot();
    const before = handle!.activity();
    await new Promise((r) => setTimeout(r, 20));
    const res = await fetch(`${base}/embed`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', [EMBED_SIDECAR_PROBE_HEADER]: '1' },
    });
    expect(res.status).toBe(400);
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 20));
    const after = handle!.activity();
    expect(after.inFlight).toBe(0);
    expect(after.lastActivityAt).toBe(before.lastActivityAt);
  });

  it('counts a work request while open and stamps activity when it ends', async () => {
    const base = await boot();
    const before = handle!.activity();
    await new Promise((r) => setTimeout(r, 20));
    // An invalid body is answered 400 without loading any model — still a work request.
    const res = await fetch(`${base}/embed`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 20));
    const after = handle!.activity();
    expect(after.inFlight).toBe(0);
    expect(after.lastActivityAt).toBeGreaterThan(before.lastActivityAt);
    expect(shouldIdleExit(after, after.lastActivityAt + 1_000, 60_000)).toBe(false);
  });
});

describe('classifyEmbedSidecarExit', () => {
  it('treats only an announced clean exit as idle', () => {
    expect(classifyEmbedSidecarExit({ idleExitAnnounced: true, code: 0 })).toBe('idle-exit');
  });
  it('keeps every other exit a crash (respawned): unannounced, non-zero after the announcement, or killed', () => {
    expect(classifyEmbedSidecarExit({ idleExitAnnounced: false, code: 0 })).toBe('crash');
    expect(classifyEmbedSidecarExit({ idleExitAnnounced: true, code: 134 })).toBe('crash');
    expect(classifyEmbedSidecarExit({ idleExitAnnounced: true, code: null })).toBe('crash');
  });
});
