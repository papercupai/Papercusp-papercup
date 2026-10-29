/**
 * P-013 (production-readiness-test-coverage) — destructive `auth: 'public'`
 * routes. These mutate durable / ship-critical state yet carry no per-route
 * principal check; the perimeter is the operator's loopback-only bind (see the
 * posture decision recorded on the plan). This file asserts, for the
 * file-system-safe subset, that each route:
 *   - is reachable with NO auth header (documents the public posture),
 *   - rejects malformed payloads, and
 *   - dispatches to the (mocked) side-effecting collaborator on valid input.
 *
 * Coverage note: a validation-consistency finding is asserted directly — the
 * backups routes parse with in-handler zod (bad body → 500), while the flags
 * routes declare `input` (bad body → 400 via the route-stack). Recorded as a
 * decision on the plan.
 *
 * DEFERRED: `harness/spawn.ts` (/launch, /invoke) is intentionally NOT tested
 * here — it shells out via node:child_process.spawn to the orchestrator, and
 * exercising it risks real spawns; it needs its own carefully-mocked file.
 *
 * Harness mirrors auth.test.ts: registerRoute → throwaway Hono app →
 * app.request(). All side-effecting deps are mocked; `node:fs` writes are
 * stubbed so the real ~/.papercusp/posthog.json is never touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const restoreToClone = vi.fn();
const restoreInPlace = vi.fn();
const promoteRestore = vi.fn();
const rollbackPromote = vi.fn();
vi.mock('../../backup', () => ({
  workspaceBackupFor: vi.fn(() => ({
    // `restoreCloneWithDeadline` — the seam /backups/restore routes through since
    // 18ee38757a8 — derives the clone target from the backend's `workspaceRoot`
    // BEFORE it calls `restoreToClone`. A fake without it made `cloneSlug(undefined)`
    // throw a TypeError into the handler's catch → 500 on the valid-input case.
    workspaceRoot: '/ws',
    restoreToClone,
    restoreInPlace,
    promoteRestore,
    rollbackPromote,
  })),
  triggerSnapshotEvent: vi.fn(async () => {}),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
// The flags/set success path now writes an audit row (recordFlagAudit → real
// PG, EI-293). Stub it so this hermetic route test never touches a DB / warns
// in CI; the real write is covered by flag-audit.integration.test.ts.
vi.mock('../../flag-audit', () => ({ recordFlagAudit: vi.fn(async () => {}) }));

const setFlag = vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
const setFlagOverride = vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
// EI-18712738949489735: the pg-override success path now reads back via getFlag()
// before reporting success — default it to echo the just-written value (the write
// "took", as far as this process's own resolver is concerned) so the pre-existing
// pg-override-success cases here are unaffected; tests targeting the readback guard
// itself override this per-case.
const getFlag = vi.fn(async (): Promise<boolean> => {
  const last = setFlagOverride.mock.calls.at(-1) as [string, boolean | null] | undefined;
  return last ? Boolean(last[1]) : true;
});
vi.mock('@papercusp/flags/server', () => ({
  setFlag: (...a: unknown[]) => setFlag(...(a as [])),
  setFlagOverride: (...a: unknown[]) => setFlagOverride(...(a as [])),
  getFlag: (...a: unknown[]) => getFlag(...(a as [])),
  // The 'production' preset clears runtime overrides (preset.ts, 2026-06-18). The
  // handler awaits it; the mock must provide it or the production case 500s.
  clearAllFlagOverrides: () => Promise.resolve([]),
}));
const publishFlagChange = vi.fn();
const reinitFlagBackend = vi.fn();
vi.mock('../../flag-bus', () => ({
  publishFlagChange: (...a: unknown[]) => publishFlagChange(...(a as [])),
  reinitFlagBackend: () => reinitFlagBackend(),
}));
vi.mock('../../posthog-config', () => ({ resetPosthogConfigForTest: vi.fn() }));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

// Stub only the *writes* so the preset route never mutates the real
// ~/.papercusp/posthog.json. Reads pass through (harmless + preset catches).
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import { ALL_FLAG_KEYS } from '@papercusp/flags';

import backupRestore from '../routes/backups/restore';
import backupRollback from '../routes/backups/rollback';
import backupPromote from '../routes/backups/promote';
import flagsSet from '../routes/flags/set';
import flagsPreset from '../routes/flags/preset';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
function appWith(def: AnyRoute): Hono {
  const app = new Hono();
  registerRoute(app, def);
  return app;
}
const post = (b: unknown) => ({
  method: 'POST',
  body: JSON.stringify(b),
  headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  // Shape tracks the real collaborator (RestoreCloneBackend.restoreToClone →
  // { targetPath }), which restoreCloneWithDeadline returns verbatim. `vi.fn()` is
  // untyped, so a drifted fixture here is invisible to lint:tsc.
  restoreToClone.mockResolvedValue({ targetPath: '/clone' });
  restoreInPlace.mockResolvedValue({ ok: true });
  promoteRestore.mockResolvedValue({ ok: true });
  rollbackPromote.mockResolvedValue({ ok: true });
  setFlag.mockResolvedValue({ ok: true });
});
afterEach(() => vi.clearAllMocks());

describe('backups public routes — destructive, auth:public (P-013)', () => {
  describe('POST /backups/restore', () => {
    const app = () => appWith(backupRestore as AnyRoute);
    it('is reachable with no auth header + rejects a bad body (500 via in-handler zod)', async () => {
      const res = await app().request('/backups/restore', post({})); // kopiaSnapshotId missing
      expect(res.status).toBe(500); // in-handler Schema.parse throw → caught → 500 (NOT 400)
      expect(restoreToClone).not.toHaveBeenCalled();
    });
    it('clone mode (default) dispatches restoreToClone', async () => {
      const res = await app().request('/backups/restore', post({ kopiaSnapshotId: 'snap1' }));
      expect(res.status).toBe(200);
      expect(restoreToClone).toHaveBeenCalledOnce();
      expect(restoreInPlace).not.toHaveBeenCalled();
    });
    it('in_place mode dispatches restoreInPlace', async () => {
      const res = await app().request('/backups/restore', post({ kopiaSnapshotId: 'snap1', mode: 'in_place' }));
      expect(res.status).toBe(200);
      expect(restoreInPlace).toHaveBeenCalledOnce();
      expect(restoreToClone).not.toHaveBeenCalled();
    });
  });

  describe('POST /backups/rollback', () => {
    const app = () => appWith(backupRollback as AnyRoute);
    it('rejects a bad body (500); dispatches rollbackPromote on valid input', async () => {
      expect((await app().request('/backups/rollback', post({}))).status).toBe(500);
      const res = await app().request('/backups/rollback', post({ brokenPath: '/x' }));
      expect(res.status).toBe(200);
      expect(rollbackPromote).toHaveBeenCalledOnce();
    });
  });

  describe('POST /backups/promote', () => {
    const app = () => appWith(backupPromote as AnyRoute);
    it('rejects a bad body (500); dispatches promoteRestore on valid input', async () => {
      expect((await app().request('/backups/promote', post({}))).status).toBe(500);
      const res = await app().request('/backups/promote', post({ restoredPath: '/r' }));
      expect(res.status).toBe(200);
      expect(promoteRestore).toHaveBeenCalledOnce();
    });
  });
});

describe('flags public routes — mutate ship gates, auth:public (P-013)', () => {
  describe('POST /flags/set', () => {
    const app = () => appWith(flagsSet as AnyRoute);
    it('rejects a malformed body with 400 (declared input schema)', async () => {
      const res = await app().request('/flags/set', post({ key: 'x' })); // enabled missing
      expect(res.status).toBe(400);
    });
    it('rejects an unknown flag key with 400 (no setFlag call)', async () => {
      const res = await app().request('/flags/set', post({ key: 'definitely_not_a_flag', enabled: true }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: 'unknown flag key' });
      expect(setFlag).not.toHaveBeenCalled();
    });
    it('sets a known flag + broadcasts the change', async () => {
      const key = ALL_FLAG_KEYS[0];
      const res = await app().request('/flags/set', post({ key, enabled: true }));
      expect(res.status).toBe(200);
      expect(setFlag).toHaveBeenCalledWith(key, true);
      // PostHog owns the flip now — any stale PG override is cleared (P-070).
      expect(setFlagOverride).toHaveBeenCalledWith(key, null);
      expect(publishFlagChange).toHaveBeenCalledWith(key);
    });
    it('falls back to the PG override store when PostHog is configured but unreachable (EI-7088)', async () => {
      const key = ALL_FLAG_KEYS[0];
      setFlag.mockResolvedValue({ ok: false, reason: 'posthog_down' });
      const res = await app().request('/flags/set', post({ key, enabled: true }));
      // EI-7088: ANY setFlag failure (not just "not configured") now falls back
      // to the PG override store, so a PostHog outage doesn't block runtime
      // flag toggling. The 502-on-both-failing case is covered below.
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, key, enabled: true, backend: 'pg-override' });
      expect(setFlagOverride).toHaveBeenCalledWith(key, true);
      expect(publishFlagChange).toHaveBeenCalledWith(key);
    });
    it('falls back to the PG override store when PostHog is not configured (P-070)', async () => {
      const key = ALL_FLAG_KEYS[0];
      setFlag.mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
      const res = await app().request('/flags/set', post({ key, enabled: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, key, enabled: true, backend: 'pg-override' });
      expect(setFlagOverride).toHaveBeenCalledWith(key, true);
      expect(publishFlagChange).toHaveBeenCalledWith(key);
    });
    it('502s when neither PostHog nor the override store can take the flip', async () => {
      setFlag.mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
      setFlagOverride.mockResolvedValue({ ok: false, reason: 'override-store-not-configured' });
      const res = await app().request('/flags/set', post({ key: ALL_FLAG_KEYS[0], enabled: true }));
      expect(res.status).toBe(502);
      expect(publishFlagChange).not.toHaveBeenCalled();
    });
  });

  describe('POST /flags/preset', () => {
    const app = () => appWith(flagsPreset as AnyRoute);
    it('rejects an unknown preset name with 400', async () => {
      expect((await app().request('/flags/preset', post({ name: 'bogus' }))).status).toBe(400);
    });
    it('production preset disables testingFeatures', async () => {
      const res = await app().request('/flags/preset', post({ name: 'production' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, preset: 'production', testingFeatures: false });
    });
    it('testing preset enables every flag', async () => {
      const res = await app().request('/flags/preset', post({ name: 'testing' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, preset: 'testing', testingFeatures: true });
      expect(setFlag).toHaveBeenCalledTimes(ALL_FLAG_KEYS.length);
    });
  });
});

describe('loopback gate — destructive routes reject non-loopback origin (D-009)', () => {
  // The developer shell may deliberately opt into remote administration. This
  // suite pins the default perimeter, so isolate that override and restore it.
  beforeEach(() => {
    vi.stubEnv('PAPERCUSP_ALLOW_REMOTE_ADMIN', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The guard reads the host from req.url; app.request with a full non-loopback
  // URL exercises the 0.0.0.0-bind threat without fighting the forbidden `Host`
  // header. The existing tests above use path-only requests (→ http://localhost)
  // so they stay on the loopback (allowed) path.
  const cases: Array<{ name: string; def: AnyRoute; path: string; body: unknown }> = [
    { name: 'backups/restore', def: backupRestore as AnyRoute, path: '/backups/restore', body: { kopiaSnapshotId: 's' } },
    { name: 'backups/rollback', def: backupRollback as AnyRoute, path: '/backups/rollback', body: { brokenPath: '/x' } },
    { name: 'backups/promote', def: backupPromote as AnyRoute, path: '/backups/promote', body: { restoredPath: '/r' } },
    { name: 'flags/set', def: flagsSet as AnyRoute, path: '/flags/set', body: { key: ALL_FLAG_KEYS[0], enabled: true } },
    { name: 'flags/preset', def: flagsPreset as AnyRoute, path: '/flags/preset', body: { name: 'testing' } },
  ];
  const send = (def: AnyRoute, origin: string, path: string, body: unknown) =>
    appWith(def).request(`${origin}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });

  for (const c of cases) {
    it(`${c.name} → 403 loopback_only from a non-loopback host (before any side effect)`, async () => {
      const res = await send(c.def, 'http://192.168.1.50:3070', c.path, c.body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'loopback_only' });
      expect(restoreToClone).not.toHaveBeenCalled();
      expect(promoteRestore).not.toHaveBeenCalled();
      expect(rollbackPromote).not.toHaveBeenCalled();
      expect(setFlag).not.toHaveBeenCalled();
    });
    it(`${c.name} → reachable (not 403) from a loopback host`, async () => {
      const res = await send(c.def, 'http://localhost', c.path, c.body);
      expect(res.status).not.toBe(403);
    });
  }
});
