/**
 * Smoke tests for the ported `user` family — the shared invariant is the
 * seeded-`default`-user fallback (getSessionUserOrDefault): per-user data
 * routes resolve the session user when a cookie is present and fall back
 * to the default user when it isn't (single-user desktop installs — the
 * webview typically carries no session cookie; a strict 401 here blanked
 * the settings memory page on 2026-06-11). Validation branches covered
 * where they exist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const DEFAULT_USER = { id: 'default-user', username: 'default', display_name: 'User', has_password: false };

vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../auth', () => ({
  getSessionUser: vi.fn(async () => null),
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'default-user', username: 'default', display_name: 'User', has_password: false })),
}));
vi.mock('../../user-preferences', () => ({
  loadUserPreferences: vi.fn(async () => ({})),
  saveUserPreferences: vi.fn(async (_id, p) => p),
  clearUserPreferenceKey: vi.fn(async () => {}),
}));
vi.mock('../../memory/mem0-client', () => ({
  getMemoryClient: vi.fn(async () => null),
  invalidateMemoryClient: vi.fn(),
}));
vi.mock('../../memory/feedback', () => ({
  recordFeedback: vi.fn(async () => {}),
  loadFeedbackStats: vi.fn(async () => ({ total_edits: 0, total_deletes: 0, recent: [] })),
}));
vi.mock('../../memory/learning', () => ({
  buildLearningInstructions: vi.fn(async () => null),
}));
vi.mock('../../voice-prefs', async (orig) => {
  const actual = await orig<typeof import('../../voice-prefs')>();
  return {
    ...actual,
    loadVoicePrefs: vi.fn(async () => ({
      ...actual.DEFAULT_VOICE_PREFS,
      memoryEmbedderMode: 'harrier',
    })),
  };
});
vi.mock('../../memory/reembed', () => ({
  reembedMemories: vi.fn(async () => ({
    fromCollection: 'harness_shared.memory_vec_openai',
    toCollection: 'harness_shared.memory_vec_local',
    fromProfileId: 'openai-text-embedding-3-small-768@v1',
    toProfileId: 'local-bge-small-en-v1.5@v1',
    totalSource: 0,
    reembedded: 0,
    skipped: 0,
    errors: 0,
    coverage: { eligible: 0, source: 0, target: 0, missing: 0 },
    durationMs: 1,
  })),
}));
vi.mock('../../memory/profile-cutover', async (orig) => ({
  ...(await orig<typeof import('../../memory/profile-cutover')>()),
  cutoverMemoryProfile: vi.fn(async (input: {
    userId: string; fromMode: string; toMode: string; fromProfileId: string; toProfileId: string;
  }) => ({
    coverage: { eligible: 2, source: 2, target: 2, missing: 0 },
    servingMode: input.toMode,
    servingProfileId: input.toProfileId,
    previousMode: input.fromMode,
    previousProfileId: input.fromProfileId,
    selectionLayer: 'user',
  })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../../harness-registry', async (orig) => ({
  ...(await orig<typeof import('../../harness-registry')>()), loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) }));
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  registeredMemoryBackends: vi.fn(() => ['fake']),
}));
vi.mock('../../memory/backend-selection', () => ({
  currentMemoryBackendChoice: vi.fn(() => 'fake'),
  writeMemoryBackendChoice: vi.fn(async () => {}),
  initMemoryBackendSelection: vi.fn(async () => {}),
}));
// The list route's audit enrichment queries memory_canonical/memory_anchors
// through the pooled org connection — stub the tagged-template `sql`.
const { orgSql } = vi.hoisted(() => ({
  orgSql: vi.fn(async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('memory_anchors')) return [];
    if (text.includes('memory_canonical')) {
      return [{
        id: 'mem-newer',
        state: 'active',
        last_validated_at: null,
        last_surfaced_at: null,
        created_at: new Date('2026-06-01T00:00:00Z'),
        updated_at: new Date('2026-06-08T00:00:00Z'),
      }];
    }
    return [];
  }),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: orgSql }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

import { getSessionUserOrDefault } from '../../auth';
import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import userPreferences from '../routes/user/preferences';
import userSearch from '../routes/user/search';
import userMemory from '../routes/user/memory';
import userMemoryFeedback from '../routes/user/memory-feedback';
import userMemoryReembed from '../routes/user/memory-reembed';
import userMemoryAudit from '../routes/user/memory-audit';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const post = (body: object) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

const fakeBackend = (entries: object[]) => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  list: vi.fn(async () => entries),
  get: vi.fn(async () => null),
  forget: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  remember: vi.fn(async () => ({ ids: ['new-1'] })),
});

afterEach(() => vi.clearAllMocks());

describe('memory delete input validation before backend access', () => {
  it('rejects a missing target even when the memory store is unavailable', async () => {
    const { getMemoryBackend } = await import('../../memory/backend');
    const backend = fakeBackend([]);
    backend.available.mockResolvedValue({ ok: false });
    vi.mocked(getMemoryBackend).mockReturnValue(backend as any);
    const res = await appWith(userMemory as AnyRoute[]).request('/user/memory', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('id_or_all_required');
    expect(backend.available).not.toHaveBeenCalled();
    expect(backend.forget).not.toHaveBeenCalled();
  });
  it('still reports an unavailable store for a valid deletion target', async () => {
    const { getMemoryBackend } = await import('../../memory/backend');
    const backend = fakeBackend([]);
    backend.available.mockResolvedValue({ ok: false, reason: 'offline' } as never);
    vi.mocked(getMemoryBackend).mockReturnValue(backend as any);
    const res = await appWith(userMemory as AnyRoute[]).request('/user/memory?id=existing', { method: 'DELETE' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('offline');
    expect(backend.forget).not.toHaveBeenCalled();
  });
});

describe('user family ports — default-user fallback when no session', () => {
  it('GET /user/preferences serves the default user without a session', async () => {
    const res = await appWith(userPreferences as AnyRoute[]).request('/user/preferences');
    expect(res.status).toBe(200);
    expect((await res.json()).payload).toEqual({});
    const { loadUserPreferences } = await import('../../user-preferences');
    expect(vi.mocked(loadUserPreferences)).toHaveBeenCalledWith('default-user');
  });
  it('PATCH /user/preferences writes as the default user without a session', async () => {
    const res = await appWith(userPreferences as AnyRoute[]).request('/user/preferences', {
      method: 'PATCH', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });
  it('GET /user/search resolves the default user without a session', async () => {
    // Empty q returns the early empty envelope — past the auth gate.
    const res = await appWith(userSearch as AnyRoute).request('/user/search');
    expect(res.status).toBe(200);
    expect((await res.json()).memories).toEqual([]);
    expect(vi.mocked(getSessionUserOrDefault)).toHaveBeenCalled();
  });
  it('GET /user/memory lists the default user pool without a session', async () => {
    const { getMemoryBackend } = await import('../../memory/backend');
    vi.mocked(getMemoryBackend).mockReturnValue(fakeBackend([]) as never);
    const res = await appWith(userMemory as AnyRoute[]).request('/user/memory');
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });
  it('GET /user/memory/backend reports the default userId without a session', async () => {
    const { getMemoryBackend } = await import('../../memory/backend');
    vi.mocked(getMemoryBackend).mockReturnValue(fakeBackend([]) as never);
    const res = await appWith(userMemory as AnyRoute[]).request('/user/memory/backend');
    expect(res.status).toBe(200);
    expect((await res.json()).userId).toBe('default-user');
  });
  it('GET /user/memory/feedback serves learning instructions without a session', async () => {
    const res = await appWith(userMemoryFeedback as AnyRoute).request('/user/memory/feedback');
    expect(res.status).toBe(200);
    expect((await res.json()).learning_instructions).toBeNull();
  });
  it('POST /user/memory/reembed reaches validation without a session', async () => {
    const res = await appWith(userMemoryReembed as unknown as AnyRoute[]).request('/user/memory/reembed', post({}));
    expect(res.status).toBe(400); // invalid_mode — auth no longer blocks
  });
  it('POST /user/memory/audit reaches the full-flag path without a session', async () => {
    const res = await appWith(userMemoryAudit as AnyRoute).request('/user/memory/audit', post({ full: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe('full_audit_pending_layer_3');
  });
});

describe('POST /user/memory/audit — full-flag pathway', () => {
  it('returns full-audit estimate when full=true', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1' });
    const res = await appWith(userMemoryAudit as AnyRoute).request(
      '/user/memory/audit',
      post({ full: true }),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.skipped).toBe(true);
    expect(j.reason).toBe('full_audit_pending_layer_3');
    expect(j.estimate).toBeDefined();
    expect(j.estimate.tokens).toBeGreaterThan(0);
  });
});

describe('user family ports — happy path / validation', () => {
  it('GET /user/preferences returns the session user payload when authenticated', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1' });
    const res = await appWith(userPreferences as AnyRoute[]).request('/user/preferences');
    expect(res.status).toBe(200);
    expect((await res.json()).payload).toEqual({});
    const { loadUserPreferences } = await import('../../user-preferences');
    expect(vi.mocked(loadUserPreferences)).toHaveBeenCalledWith('u1');
  });
  it('DELETE /user/preferences without key returns 400', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1' });
    const res = await appWith(userPreferences as AnyRoute[]).request('/user/preferences', {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });
  it('POST /user/memory/reembed rejects invalid mode with 400', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1' } as never);
    const res = await appWith(userMemoryReembed as unknown as AnyRoute[]).request('/user/memory/reembed', post({ from: 'x', to: 'y' }));
    expect(res.status).toBe(400);
  });
  it('GET /user/memory/reembed returns exact current and target profile identities', async () => {
    const res = await appWith(userMemoryReembed as unknown as AnyRoute[]).request('/user/memory/reembed');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.current).toEqual({
      mode: 'harrier',
      profileId: 'harrier-oss-v1-0.6b-1024@v1',
    });
    expect(json.profiles.local).toEqual({ profileId: 'local-bge-small-en-v1.5@v1' });
  });
  it('POST /user/memory/reembed rejects same-mode noop with 400', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1' } as never);
    const res = await appWith(userMemoryReembed as unknown as AnyRoute[]).request('/user/memory/reembed', post({ from: 'openai', to: 'openai' }));
    expect(res.status).toBe(400);
  });
  it('PATCH /user/preferences refuses a direct serving-profile change', async () => {
    const res = await appWith(userPreferences as AnyRoute[]).request(
      '/user/preferences',
      { method: 'PATCH', body: JSON.stringify({ memoryEmbedderMode: 'local' }), headers: { 'content-type': 'application/json' } },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('memory_profile_cutover_required');
    const { saveUserPreferences } = await import('../../user-preferences');
    expect(vi.mocked(saveUserPreferences)).not.toHaveBeenCalled();
  });
  it('POST /user/memory/reembed requires exact identities for a cutover', async () => {
    const res = await appWith(userMemoryReembed as unknown as AnyRoute[]).request(
      '/user/memory/reembed',
      post({ from: 'openai', to: 'local', cutover: true }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('profile_ids_required_for_cutover');
  });
  it('POST /user/memory/reembed builds with exact profiles then applies one coverage-gated cutover', async () => {
    const body = {
      from: 'openai',
      to: 'local',
      fromProfileId: 'openai-text-embedding-3-small-768@v1',
      toProfileId: 'local-bge-small-en-v1.5@v1',
      cutover: true,
    } as const;
    const res = await appWith(userMemoryReembed as unknown as AnyRoute[]).request('/user/memory/reembed', post(body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cutover).toMatchObject({
      requested: true,
      applied: true,
      servingMode: 'local',
      previousMode: 'openai',
    });
    const { reembedMemories } = await import('../../memory/reembed');
    const { cutoverMemoryProfile } = await import('../../memory/profile-cutover');
    expect(vi.mocked(reembedMemories)).toHaveBeenCalledWith('openai', 'local', {
      fromProfileId: body.fromProfileId,
      toProfileId: body.toProfileId,
    });
    expect(vi.mocked(cutoverMemoryProfile)).toHaveBeenCalledWith({
      userId: 'default-user',
      fromMode: 'openai',
      toMode: 'local',
      fromProfileId: body.fromProfileId,
      toProfileId: body.toProfileId,
    });
  });
});

describe('GET /user/memory — list enrichment (memory-settings-page-refresh)', () => {
  const ENTRIES = [
    // No canonical row → falls back to metadata.turn_at for ordering.
    { id: 'mem-older', text: 'older fact', kind: 'feedback', scope: 'u1', metadata: { turn_at: 5 } },
    // Canonical row exists (orgSql stub) → gets dates + audit state.
    { id: 'mem-newer', text: 'newer fact', kind: 'reference', scope: 'u1', metadata: { description: 'a one-liner' } },
  ];

  it('passes kinds through untouched, lifts canonical dates, sorts newest-first', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1' } as never);
    const { getMemoryBackend } = await import('../../memory/backend');
    vi.mocked(getMemoryBackend).mockReturnValue(fakeBackend(ENTRIES) as never);
    const res = await appWith(userMemory as AnyRoute[]).request('/user/memory');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.results).toHaveLength(2);
    // The canonical-dated row (2026-06-08) outranks the turn_at=5 row.
    expect(j.results[0].id).toBe('mem-newer');
    expect(j.results[0].kind).toBe('reference'); // kind-agnostic — no taxonomy filter
    expect(j.results[0].created_at).toBe('2026-06-01T00:00:00.000Z');
    expect(j.results[0].updated_at).toBe('2026-06-08T00:00:00.000Z');
    expect(j.results[0].audit.state).toBe('active');
    expect(j.results[1].id).toBe('mem-older');
    expect(j.results[1].audit).toBeUndefined();
  });

  it('still serves the list when the canonical enrichment query throws (the uuid=text regression)', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1' } as never);
    const { getMemoryBackend } = await import('../../memory/backend');
    vi.mocked(getMemoryBackend).mockReturnValue(fakeBackend(ENTRIES) as never);
    orgSql.mockRejectedValueOnce(new Error('operator does not exist: uuid = text'));
    const res = await appWith(userMemory as AnyRoute[]).request('/user/memory');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.results).toHaveLength(2);
    expect(j.results.every((r: { audit?: unknown }) => r.audit === undefined)).toBe(true);
  });
});

describe('POST /user/memory — create (P-010) + invalidate (P-008)', () => {
  it('writes through the backend seam, records create feedback, fires the list invalidate', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1', display_name: 'A' } as never);
    const backend = fakeBackend([]);
    const { getMemoryBackend } = await import('../../memory/backend');
    vi.mocked(getMemoryBackend).mockReturnValue(backend as never);
    const res = await appWith(userMemory as AnyRoute[]).request(
      '/user/memory',
      post({ text: 'a new fact', kind: 'reference' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ids).toEqual(['new-1']);
    expect(backend.remember).toHaveBeenCalledWith(
      'a new fact',
      expect.objectContaining({ scope: 'u1', kind: 'reference' }),
    );
    const { recordFeedback } = await import('../../memory/feedback');
    expect(vi.mocked(recordFeedback)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', memId: 'new-1', newText: 'a new fact' }),
    );
    const { notifySyncInvalidate } = await import('../../sync-sse');
    expect(vi.mocked(notifySyncInvalidate)).toHaveBeenCalledWith('userMemory.list');
  });

  it('scopes to a harness pool when harness_slug is passed', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1', display_name: 'A' } as never);
    const backend = fakeBackend([]);
    const { getMemoryBackend } = await import('../../memory/backend');
    vi.mocked(getMemoryBackend).mockReturnValue(backend as never);
    const res = await appWith(userMemory as AnyRoute[]).request(
      '/user/memory',
      post({ text: 'team convention', harness_slug: 'sheets' }),
    );
    expect(res.status).toBe(200);
    expect(backend.remember).toHaveBeenCalledWith(
      'team convention',
      expect.objectContaining({ scope: 'harness:sheets' }),
    );
  });

  it('400s without text', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValueOnce({ ...DEFAULT_USER, id: 'u1' } as never);
    const { getMemoryBackend } = await import('../../memory/backend');
    vi.mocked(getMemoryBackend).mockReturnValue(fakeBackend([]) as never);
    const res = await appWith(userMemory as AnyRoute[]).request('/user/memory', post({ kind: 'reference' }));
    expect(res.status).toBe(400);
  });
});
