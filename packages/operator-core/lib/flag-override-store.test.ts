/**
 * flag-override-store.test.ts — recurrence guard for the silent-flag-override class
 * (codex-gateway-chatgpt-live-2026-07-09).
 *
 * THE BUG THIS PINS: `getFlag()` reads the PG override store only in a process that called
 * `initFlagOverrideStore()`. That call lived solely in `flag-bus.ts`, which the standalone
 * inference-gateway process does not import — so the gateway silently ignored every runtime
 * `flags:set` and fell through to FLAG_DEFAULTS. The flip reported success and changed nothing;
 * nothing failed, nothing logged. A DETECTOR, not just a fix, is what this file adds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const readOperatorState = vi.fn();
const writeOperatorState = vi.fn();
let activeWorkspace = 'ws-under-test';
// WI-6793: capture the cross-process announce (pg_notify) the set() path fires.
const pgNotifyCalls: Array<{ values: unknown[] }> = [];

vi.mock('./operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
  writeOperatorState: (...a: unknown[]) => writeOperatorState(...a),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => activeWorkspace }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (_strings: TemplateStringsArray, ...values: unknown[]) => {
        pgNotifyCalls.push({ values });
        return Promise.resolve([]);
      },
      { begin: vi.fn() },
    ),
  }),
}));

import { initFlagOverrideStore, isOverrideStoreConfigured, getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  installFlagOverrideStore,
  FLAG_OVERRIDES_STATE_KEY,
  FLAG_CHANGE_CHANNEL,
  GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
} from './flag-override-store';

// Keep the failure-mode assertions below anchored to a flag that is intentionally
// default-off. CODEX_GATEWAY_OAUTH_PROXY graduated on 2026-08-27, so its derived
// FLAG_DEFAULTS entry is now true and cannot prove that an absent store falls back
// to an off default.
const DEFAULT_OFF_FLAG = FLAGS.CLOUDFLARE_PUBLISH;

describe('installFlagOverrideStore', () => {
  beforeEach(() => {
    readOperatorState.mockReset();
    writeOperatorState.mockReset();
    activeWorkspace = 'ws-under-test';
    pgNotifyCalls.length = 0;
    initFlagOverrideStore(null); // start from "no store", the buggy state
  });
  afterEach(() => {
    initFlagOverrideStore(null);
  });

  it('is NOT configured until installed — the exact state the gateway process was in', () => {
    expect(isOverrideStoreConfigured()).toBe(false);
  });

  it('installs a store that getFlag() actually consults', async () => {
    // A flag whose baked default is OFF, overridden ON at runtime.
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true });
    installFlagOverrideStore();
    expect(isOverrideStoreConfigured()).toBe(true);
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(true);
    expect(readOperatorState).toHaveBeenCalledWith(FLAG_OVERRIDES_STATE_KEY);
    expect(readOperatorState).toHaveBeenCalledWith(
      FLAG_OVERRIDES_STATE_KEY,
      GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
    );
  });

  it('WITHOUT the store, a runtime override is silently ignored (the regression, pinned)', async () => {
    // The store is never installed, so the same PG row is never read: getFlag falls through to
    // the baked default. This asserts the FAILURE MODE so a future refactor that drops the
    // install() call is caught here rather than by a dark flag that mysteriously won't turn on.
    readOperatorState.mockResolvedValue({ [DEFAULT_OFF_FLAG]: true });
    await expect(getFlag(DEFAULT_OFF_FLAG, 'system')).resolves.toBe(false);
    expect(readOperatorState).not.toHaveBeenCalled();
  });

  it('set(key, null) deletes the override rather than writing false', async () => {
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true, other: true });
    installFlagOverrideStore();
    const { setFlagOverride } = await import('@papercusp/flags/server');
    await setFlagOverride(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, null);
    expect(writeOperatorState).toHaveBeenCalledWith(
      FLAG_OVERRIDES_STATE_KEY,
      { other: true },
      GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
    );
  });

  it('an existing global row supersedes legacy workspace rows in every workspace (EI-1831)', async () => {
    readOperatorState.mockImplementation(async (_table: string, workspace?: string) => {
      if (workspace === GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID) {
        return { [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true };
      }
      return { [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: false };
    });
    installFlagOverrideStore();

    activeWorkspace = 'ws-a';
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(true);
    activeWorkspace = 'ws-b';
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(true);
  });

  it('the FIRST global write seeds @global from the legacy workspace row (WI-10005101)', async () => {
    // Measured 2026-10-01: one flags:set created '@global' with only its own key, and every
    // other legacy override (WATCHDOG_AUTO_CLOSE among them) silently reverted to default.
    readOperatorState.mockImplementation(async (_table: string, workspace?: string) => {
      if (workspace === GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID) return null; // pre-cutover: no global row
      return { [DEFAULT_OFF_FLAG]: true, other: false };
    });
    writeOperatorState.mockResolvedValue(undefined);
    installFlagOverrideStore();
    const { setFlagOverride } = await import('@papercusp/flags/server');
    await setFlagOverride(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, true);
    expect(writeOperatorState).toHaveBeenCalledWith(
      FLAG_OVERRIDES_STATE_KEY,
      { [DEFAULT_OFF_FLAG]: true, other: false, [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true },
      GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
    );
  });

  it('once @global exists, a write never re-merges legacy rows (no resurrection)', async () => {
    readOperatorState.mockImplementation(async (_table: string, workspace?: string) => {
      if (workspace === GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID) return { kept: true };
      return { [DEFAULT_OFF_FLAG]: true };
    });
    writeOperatorState.mockResolvedValue(undefined);
    installFlagOverrideStore();
    const { setFlagOverride } = await import('@papercusp/flags/server');
    await setFlagOverride(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, true);
    expect(writeOperatorState).toHaveBeenCalledWith(
      FLAG_OVERRIDES_STATE_KEY,
      { kept: true, [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true },
      GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
    );
  });

  it('an empty global row is a cutover marker and does not resurrect legacy values after clear', async () => {
    readOperatorState.mockImplementation(async (_table: string, workspace?: string) => {
      if (workspace === GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID) return {};
      return { [DEFAULT_OFF_FLAG]: true };
    });
    installFlagOverrideStore();

    activeWorkspace = 'ws-a';
    await expect(getFlag(DEFAULT_OFF_FLAG, 'system')).resolves.toBe(false);
    activeWorkspace = 'ws-b';
    await expect(getFlag(DEFAULT_OFF_FLAG, 'system')).resolves.toBe(false);
  });

  it('is idempotent — installing twice leaves a working store', async () => {
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true });
    installFlagOverrideStore();
    installFlagOverrideStore();
    expect(isOverrideStoreConfigured()).toBe(true);
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(true);
  });

  it('set() announces the write cross-process via pg_notify — the WI-6793 propagation seam', async () => {
    // WITHOUT this announce, a flags:set converges in other processes only via the
    // ~5s cache TTL, and sticky onFlagChange subscribers (workspace-brain-scope's
    // keying latch) hold the pre-flip value until their process restarts.
    readOperatorState.mockResolvedValue({});
    writeOperatorState.mockResolvedValue(undefined);
    installFlagOverrideStore();
    const { setFlagOverride } = await import('@papercusp/flags/server');
    await setFlagOverride(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, true);
    // The announce is fire-and-forget AFTER the awaited write — let it flush.
    await vi.waitFor(() => expect(pgNotifyCalls.length).toBe(1));
    const [channel, payload] = pgNotifyCalls[0].values as [string, string];
    expect(channel).toBe(FLAG_CHANGE_CHANNEL);
    expect(JSON.parse(payload)).toEqual({
      workspaceId: GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID,
      key: FLAGS.CODEX_GATEWAY_OAUTH_PROXY,
    });
  });
});

/**
 * EVERY standalone process that reaches a flag read must install the override store.
 *
 * These processes do NOT import flag-bus (it drags in SSE + lexicon config), so each must
 * install the store itself or it silently serves FLAG_DEFAULTS and ignores every `flags:set`.
 * The gateway shipped in exactly that state; its two sibling sidecars (spawner, substrate) had
 * the same latent hole, found by transitive import-reachability rather than by grep — a DIRECT
 * grep exonerates all three, because each one's flag read lives several modules deep (the
 * gateway's is in launch.ts, not sidecar-main.ts).
 *
 * Table-driven so adding a new sidecar to the list is the natural way to protect it.
 */
describe('every standalone sidecar installs the override store (the actual regression guard)', () => {
  const ENTRYPOINTS: Array<{ file: string[]; startMarker: string; what: string }> = [
    { file: ['inference-gateway', 'sidecar-main.ts'], startMarker: 'await startGatewayService(', what: 'inference gateway' },
    { file: ['fleet', 'spawner-sidecar-server.ts'], startMarker: 'listenUnixSocketExclusive(server', what: 'spawner sidecar' },
    { file: ['sync', 'hyperbee', 'substrate-sidecar-server.ts'], startMarker: 'server.listen(', what: 'substrate sidecar' },
  ];

  it.each(ENTRYPOINTS)('$what installs the store before it starts serving', async ({ file, startMarker, what }) => {
    // Source-level assertion: importing these for real would boot a server / open a socket. What
    // matters is that the call EXISTS and PRECEDES the point a flag could first be read.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const raw = readFileSync(join(__dirname, ...file), 'utf8');
    // Strip block + line comments FIRST: the doc comments above each call legitimately name
    // `startGatewayService()` / the marker in prose, and a naive indexOf would match the comment
    // instead of the real call (this very guard caught exactly that on its first run, and would
    // now catch it three times over). Measure CODE, not prose.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const install = src.indexOf('installFlagOverrideStore()');
    const start = src.indexOf(startMarker);
    expect(install, `${what} must install the flag override store`).toBeGreaterThan(-1);
    expect(start, `${what} must reach its start marker (${startMarker})`).toBeGreaterThan(-1);
    expect(install, `${what}: install must run BEFORE any flag can be resolved`).toBeLessThan(start);
  });

  it.each(ENTRYPOINTS)('$what also LISTENs for cross-process flag flips (WI-6793)', async ({ file, what }) => {
    // The store makes overrides READABLE; the listener makes runtime FLIPS land. A sidecar
    // with only the store converges via the ~5s cache TTL — and any sticky onFlagChange
    // subscriber there holds the pre-flip value until restart (the bg-host scout-key bug).
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const raw = readFileSync(join(__dirname, ...file), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(src.indexOf('ensureFlagChangeListener()'), `${what} must install the flag-change listener`).toBeGreaterThan(-1);
  });

  it('hono-host wires the listener in BOTH process roles — request workers AND the cluster primary', async () => {
    // The clustered primary runs the background machinery (DBOS, routines, scout) but never
    // startRequestServers — a single worker-path call would miss exactly the process whose
    // sticky keying latch caused the observed bug.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const raw = readFileSync(
      join(__dirname, '..', '..', '..', 'apps', 'operator', 'bin', 'hono-host.ts'),
      'utf8',
    );
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const calls = src.split('ensureFlagChangeListener()').length - 1;
    expect(calls, 'hono-host needs the listener on the worker path AND in onPrimary').toBeGreaterThanOrEqual(2);
  });
});
