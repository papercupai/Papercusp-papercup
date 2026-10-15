/**
 * setup-tools.test.ts — the setup:* onboarding-tutor verbs
 * (agent-first-onboarding-2026-07-03 P-004), PG + credentials mocked.
 *
 * Pins: the wizard-state merge semantics (consent decided both ways, channel
 * choice, graduation idempotence + force), the save_key mask (raw secret
 * never echoed), and that setup:status is a pure projection of
 * collectSetupStatus (the same read the GUI wizard uses).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/setup/setup-tools.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});

const h = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    read: vi.fn(async (k: string) => store.get(k) ?? null),
    write: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
    update: vi.fn(async <T>(k: string, fallback: T, mutate: (current: T) => T) => {
      const next = mutate((store.get(k) ?? fallback) as T);
      store.set(k, next);
      return next;
    }),
    creds: { current: {} as Record<string, string | undefined> },
    collect: vi.fn(async () => ({
      statuses: { git: 'ok', telemetry: 'needs-attention' },
      agentRuntime: { claude: true, codex: false, omp: false },
    })),
  };
});
vi.mock('../../operator-state-pg', () => ({
  readOperatorState: h.read,
  writeOperatorState: h.write,
  updateOperatorState: h.update,
}));
vi.mock('../../setup-wizard-install-id', () => ({ ensureInstallId: vi.fn() }));
vi.mock('../../credentials', () => ({
  readCredentials: vi.fn(async () => ({ ...h.creds.current })),
  writeCredentials: vi.fn(async (c: Record<string, string | undefined>) => {
    h.creds.current = c;
    return c;
  }),
  maskSecret: (v?: string | null) => (v ? `${v.slice(0, 3)}…` : null),
}));
vi.mock('../../integration-credentials', () => ({
  readIntegrationCredentials: vi.fn(async () => (h.store.get('operator_integration_credentials') as Record<string, string>) ?? {}),
  writeIntegrationCredentials: vi.fn(async (partial: Record<string, string | null>) => {
    const current = (h.store.get('operator_integration_credentials') as Record<string, string>) ?? {};
    const next = { ...current };
    for (const [k, v] of Object.entries(partial)) {
      if (v === null || v === '') delete next[k];
      else next[k] = v;
    }
    h.store.set('operator_integration_credentials', next);
    return next;
  }),
  maskIntegrationKey: (v?: string | null) => (v && v.length >= 8 ? `${v.slice(0, 3)}...${v.slice(-4)}` : null),
}));
vi.mock('../../endpoint-route/routes/desktop/setup-status', () => ({
  collectSetupStatus: h.collect,
}));
vi.mock('../../memory/configure', () => ({ clearOpenAiEmbedHardExhaustion: vi.fn() }));

const setTelemetry = (await import('./set_telemetry')).default;
const setChannel = (await import('./set_update_channel')).default;
const complete = (await import('./complete')).default;
const saveKey = (await import('./save_key')).default;
const { clearOpenAiEmbedHardExhaustion } = await import('../../memory/configure');
const saveIntegrationKey = (await import('./save_integration_key')).default;
const status = (await import('./status')).default;
const setProgress = (await import('./set_tutorial_progress')).default;

// Accepts BOTH ToolResponse shapes — the canonical { data } and the legacy
// inline-JSON { content:[{ text }] } — so migrating a tool to { data } never
// requires repointing this helper again (2026-07-26 batch's pattern).
type Out = { data: unknown } | { content: { text: string }[] };
const body = (o: Out) => ('data' in o ? o.data : JSON.parse(o.content[0]!.text));
const call = (
  tool: { handler: (a: never, c: never) => unknown },
  args: Record<string, unknown> = {},
) => tool.handler(args as never, {} as never) as Promise<Out>;

const wizard = () => h.store.get('setup_wizard_state') as Record<string, unknown> | undefined;

beforeEach(() => {
  h.store.clear();
  h.creds.current = {};
  h.update.mockClear();
  vi.mocked(clearOpenAiEmbedHardExhaustion).mockClear();
});

describe('setup:set_telemetry', () => {
  it('records consent BOTH ways — true and false are each a decision', async () => {
    expect(body(await call(setTelemetry, { enabled: true }))).toEqual({ telemetry_enabled: true });
    expect(wizard()?.telemetry_enabled).toBe(true);
    expect(body(await call(setTelemetry, { enabled: false }))).toEqual({ telemetry_enabled: false });
    expect(wizard()?.telemetry_enabled).toBe(false);
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenLastCalledWith('setup_wizard_state', { step_status: {} }, expect.any(Function));
  });
});

describe('setup:set_update_channel', () => {
  it('sets the channel and PRESERVES other wizard state (merge, not replace)', async () => {
    await call(setTelemetry, { enabled: true });
    const b = body(await call(setChannel, { channel: 'beta' }));
    expect(b).toEqual({ update_channel: 'beta' });
    expect(wizard()).toMatchObject({ update_channel: 'beta', telemetry_enabled: true });
  });
});

describe('setup:complete (graduation)', () => {
  // desktop-update-center-and-release-tooling-2026-07-10 P-1: graduation is gated on
  // every `required` optional-setup item (today just telemetry) being decided, via the
  // SAME collectSetupStatus probe setup:status projects. The shared top-level mock
  // defaults to telemetry:'needs-attention' (pinned by the setup:status test below), so
  // any test that expects an UNGATED graduation must explicitly mark telemetry decided
  // for that one collectSetupStatus call.
  const telemetryDecided = () =>
    h.collect.mockResolvedValueOnce({
      statuses: { git: 'ok', telemetry: 'ok' },
      agentRuntime: { claude: true, codex: false, omp: false },
    });

  it('stamps finished_at once and is idempotent after that', async () => {
    telemetryDecided(); // only the first (non-early-return) call probes the gate
    const first = body(await call(complete));
    expect(first.alreadyFinished).toBe(false);
    expect(typeof first.finished_at).toBe('string');

    const second = body(await call(complete));
    expect(second).toEqual({ finished_at: first.finished_at, alreadyFinished: true });
  });

  it('force re-stamps', async () => {
    telemetryDecided();
    await call(complete);
    const forced = body(await call(complete, { force: true }));
    expect(forced.alreadyFinished).toBe(false);
    expect(typeof forced.finished_at).toBe('string');
  });

  it('refuses graduation while a required item (telemetry) is undecided', async () => {
    // default mock: telemetry stays 'needs-attention' — the gate must block.
    const blocked = body(await call(complete));
    expect(blocked.alreadyFinished).toBe(false);
    expect(blocked.error).toBe('required_setup_undecided');
    expect(blocked.undecided).toEqual(['telemetry']);
    expect(blocked.finished_at).toBeUndefined();
  });

  it('force bypasses the required-item gate entirely', async () => {
    // default mock: telemetry undecided, yet force skips the gate + stamps directly.
    const forced = body(await call(complete, { force: true }));
    expect(forced.alreadyFinished).toBe(false);
    expect(typeof forced.finished_at).toBe('string');
  });
});

describe('setup:save_key', () => {
  it('stores the trimmed secret and returns it MASKED, never raw', async () => {
    const raw = '  sk-test-123456789  ';
    const b = body(await call(saveKey, { key: 'openai_api_key', value: raw }));
    expect(h.creds.current.openai_api_key).toBe('sk-test-123456789');
    expect(b).toEqual({ ok: true, key: 'openai_api_key', masked: 'sk-…' });
    expect(JSON.stringify(b)).not.toContain('123456789');
  });

  it('merges instead of clobbering other keys', async () => {
    h.creds.current = { github_pat: 'ghp_existing' };
    await call(saveKey, { key: 'anthropic_api_key', value: 'sk-ant-abcdef' });
    expect(h.creds.current).toMatchObject({
      github_pat: 'ghp_existing',
      anthropic_api_key: 'sk-ant-abcdef',
    });
  });

  // WI-3615: a re-saved openai_api_key is the ONLY signal that clears the sticky
  // hard-exhaustion latch (memory/configure.ts) — assert the hook fires precisely there,
  // not on every save (which would spuriously re-try a key that's still actually dead).
  it('WI-3615: re-saving openai_api_key clears the sticky embed-exhaustion latch', async () => {
    await call(saveKey, { key: 'openai_api_key', value: 'sk-new-0123456789' });
    expect(clearOpenAiEmbedHardExhaustion).toHaveBeenCalledTimes(1);
  });

  it('WI-3615: saving a DIFFERENT key does NOT touch the embed-exhaustion latch', async () => {
    await call(saveKey, { key: 'anthropic_api_key', value: 'sk-ant-abcdef' });
    await call(saveKey, { key: 'github_pat', value: 'ghp_0123456789' });
    await call(saveKey, { key: 'zeroentropy_api_key', value: 'ze-0123456789' });
    expect(clearOpenAiEmbedHardExhaustion).not.toHaveBeenCalled();
  });
});

describe('setup:save_integration_key', () => {
  it('stores a third-party integration key and returns it MASKED, never raw', async () => {
    const raw = ['fake', 'weather', 'testtoken', '99'].join('-');
    const b = body(await call(saveIntegrationKey, { name: 'WEATHERAPI_API_KEY', value: raw }));
    expect(b).toEqual({ ok: true, name: 'WEATHERAPI_API_KEY', masked: `${raw.slice(0, 3)}...${raw.slice(-4)}` });
    expect(JSON.stringify(b)).not.toContain(raw);
    expect((h.store.get('operator_integration_credentials') as Record<string, string>).WEATHERAPI_API_KEY).toBe(raw);
  });

  it('rejects a non-SCREAMING_SNAKE_CASE name (schema validation)', () => {
    expect(() => saveIntegrationKey.args.parse({ name: 'weatherApiKey', value: 'placeholder1' })).toThrow();
    expect(() => saveIntegrationKey.args.parse({ name: 'WEATHERAPI_API_KEY', value: 'placeholder1' })).not.toThrow();
  });

  it('merges instead of clobbering other integration keys', async () => {
    await call(saveIntegrationKey, { name: 'FOO_API_KEY', value: 'foo-placeholder-1' });
    await call(saveIntegrationKey, { name: 'BAR_API_KEY', value: 'bar-placeholder-2' });
    expect(h.store.get('operator_integration_credentials')).toMatchObject({
      FOO_API_KEY: 'foo-placeholder-1',
      BAR_API_KEY: 'bar-placeholder-2',
    });
  });
});

describe('setup:set_tutorial_progress', () => {
  it('merges position + completed list, preserving other wizard state', async () => {
    await call(setTelemetry, { enabled: true });
    let b = body(await call(setProgress, { last_section_id: 'ch1-01-server-gui-tutorial' }));
    expect(b.tutorial_progress).toMatchObject({ last_section_id: 'ch1-01-server-gui-tutorial' });

    b = body(
      await call(setProgress, {
        last_section_id: 'ch2-01-plans',
        completed_ids: ['ch1-01-server-gui-tutorial', 'ch1-02-pots-harnesses-blueprints'],
      }),
    );
    expect(b.tutorial_progress).toMatchObject({
      last_section_id: 'ch2-01-plans',
      completed_ids: ['ch1-01-server-gui-tutorial', 'ch1-02-pots-harnesses-blueprints'],
    });
    expect(typeof b.tutorial_progress.updated_at).toBe('string');
    expect(wizard()).toMatchObject({ telemetry_enabled: true }); // merge, not replace
  });

  it('clear erases progress (restart from the top)', async () => {
    await call(setProgress, { last_section_id: 'ch2-01-plans' });
    const b = body(await call(setProgress, { clear: true }));
    expect(b.tutorial_progress).toBeNull();
    expect(wizard()?.tutorial_progress).toBeUndefined();
  });
});

describe('setup:status', () => {
  it('is a pure projection of collectSetupStatus (the wizard-shared read)', async () => {
    const b = body(await call(status));
    expect(h.collect).toHaveBeenCalled();
    expect(b).toEqual({
      statuses: { git: 'ok', telemetry: 'needs-attention' },
      agentRuntime: { claude: true, codex: false, omp: false },
    });
  });
});
