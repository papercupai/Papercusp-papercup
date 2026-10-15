/**
 * jev-settings.test.ts — P-013 / D-008 of jev-decision-model-integration-2026-09-29.
 *
 * Pins the one rule every memory-injection consumer depends on: Jev is
 * EFFECTIVELY off unless the user chose shadow/on AND a key is stored, and
 * "off" means zero network calls. Also pins that the raw key never leaves the
 * store through the view, and that unreadable state falls back to today's system.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  failReads: false,
  reads: 0,
  writes: [] as Array<{ key: string; value: string; workspace: string }>,
  /** decision_model_calls inserts, keyed by column name (parsed from the INSERT's column list). */
  ledger: [] as Array<Record<string, unknown>>,
}));
const creds = vi.hoisted(() => ({ store: {} as Record<string, string>, reads: 0, failReads: false }));

// P-008 (jev-memory-timeouts-to-zero-2026-10-01): the real jevFetch makes the request
// on a worker thread, where a stubbed global fetch cannot reach. These tests pin the
// client wiring (zero calls when off, key per call, the ledger row), not the
// transport, so jevFetch is routed through the stub. jev-transport.test.ts covers
// the transport itself.
vi.mock('./jev-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-transport')>()),
  jevFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('SELECT value')) {
        db.reads += 1;
        if (db.failReads) return Promise.reject(new Error('pg down'));
        const v = db.rows.get(values[0] as string);
        return Promise.resolve(v === undefined ? [] : [{ value: v }]);
      }
      if (text.includes('INSERT INTO harness_shared.operator_settings')) {
        const [key, value, , workspace] = values as [string, string, number, string];
        db.rows.set(key, value);
        db.writes.push({ key, value, workspace });
        return Promise.resolve([]);
      }
      if (text.includes('INSERT INTO harness_shared.decision_model_calls')) {
        const cols = text.slice(text.indexOf('(') + 1, text.indexOf(') VALUES')).split(',').map((c) => c.trim());
        db.ledger.push(Object.fromEntries(cols.map((c, i) => [c, values[i]])));
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected SQL: ${text}`));
    }, {
      // Transaction-capable like the production org client (WI-40234).
      begin: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(undefined),
      array: (v: unknown) => v,
      json: (v: unknown) => v,
    }),
  }),
}));

vi.mock('../integration-credentials', () => ({
  readIntegrationKey: async (name: string) => {
    creds.reads += 1;
    if (creds.failReads) throw new Error('pg down');
    return creds.store[name];
  },
  writeIntegrationCredentials: async (partial: Record<string, string | null>) => {
    for (const [k, v] of Object.entries(partial)) {
      if (v === null) delete creds.store[k];
      else creds.store[k] = v;
    }
    return creds.store;
  },
  maskIntegrationKey: (v: string | null | undefined) => (v && v.length >= 8 ? `${v.slice(0, 3)}...${v.slice(-4)}` : null),
}));

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import { configureDecisionModel, decide } from '@papercusp/decision-model';
import {
  __resetJevSettingsCacheForTest,
  ensureJevDecisionClient,
  getJevMode,
  getJevSettingsView,
  JEV_API_KEY_NAME,
  JEV_PRICING,
  jevModeKey,
  readJevApiKey,
  resolveJevMemoryInjection,
  setJevApiKey,
  setJevMode,
} from './jev-settings';

// Deliberately low-entropy: an obvious fixture, never mistakable for a real key.
const KEY = 'fake-jev-key-aaaaaaaa';

beforeEach(() => {
  db.rows.clear();
  db.failReads = false;
  db.reads = 0;
  db.writes = [];
  db.ledger = [];
  creds.store = {};
  creds.reads = 0;
  creds.failReads = false;
  __resetJevSettingsCacheForTest();
  configureDecisionModel(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureDecisionModel(null);
});

describe('mode store', () => {
  it('defaults to off when nothing is stored', async () => {
    expect(await getJevMode()).toBe('off');
  });

  it('round-trips a mode under the per-workspace key', async () => {
    await setJevMode('shadow');
    expect(db.writes).toEqual([{ key: jevModeKey('ws-test'), value: 'shadow', workspace: 'ws-test' }]);
    __resetJevSettingsCacheForTest();
    expect(await getJevMode()).toBe('shadow');
  });

  it('keeps workspaces independent', async () => {
    await setJevMode('on', 'ws-a');
    __resetJevSettingsCacheForTest();
    expect(await getJevMode('ws-a')).toBe('on');
    expect(await getJevMode('ws-b')).toBe('off');
  });

  it('an unrecognised stored value reads as off', async () => {
    db.rows.set(jevModeKey('ws-test'), 'maybe');
    expect(await getJevMode()).toBe('off');
  });

  it('a read failure reads as off (today’s system), not as a throw', async () => {
    db.rows.set(jevModeKey('ws-test'), 'on');
    db.failReads = true;
    expect(await getJevMode()).toBe('off');
  });

  it('caches reads briefly, and a write refreshes the cache at once', async () => {
    await getJevMode();
    await getJevMode();
    expect(db.reads).toBe(1);
    await setJevMode('on');
    expect(await getJevMode()).toBe('on');
    expect(db.reads).toBe(1);
  });

  it('rejects an invalid mode', async () => {
    await expect(setJevMode('always' as never)).rejects.toThrow(/invalid Jev mode/);
  });
});

describe('the effective-mode gate', () => {
  it.each([
    ['off', true, 'off'],
    ['off', false, 'off'],
    ['shadow', false, 'off'],
    ['on', false, 'off'],
    ['shadow', true, 'shadow'],
    ['on', true, 'on'],
  ] as const)('mode %s with key=%s ⇒ effective %s', async (mode, withKey, effective) => {
    if (mode !== 'off') await setJevMode(mode);
    if (withKey) await setJevApiKey(KEY);
    const r = await resolveJevMemoryInjection();
    expect(r).toEqual({ mode, keyPresent: withKey, effective });
  });
});

describe('key store', () => {
  it('saves the key trimmed under TYPESAFE_API_KEY and clears it with null', async () => {
    await setJevApiKey(`  ${KEY}\n`);
    expect(creds.store[JEV_API_KEY_NAME]).toBe(KEY);
    await setJevApiKey(null);
    expect(creds.store).not.toHaveProperty(JEV_API_KEY_NAME);
  });

  it.each([['short'], ['has a space in it'], ['x'.repeat(5000)]])('rejects an implausible key %#', async (bad) => {
    await expect(setJevApiKey(bad)).rejects.toThrow();
    expect(creds.store).not.toHaveProperty(JEV_API_KEY_NAME);
  });

  // WI-10004485: every recall resolved the key twice (gate + client), each a
  // Postgres read made before the client's 400 ms deadline is armed.
  it('reuses one key read across recalls, so a recall does not hit Postgres for it', async () => {
    creds.store[JEV_API_KEY_NAME] = KEY;
    await setJevMode('shadow');
    for (let i = 0; i < 5; i += 1) expect((await resolveJevMemoryInjection()).effective).toBe('shadow');
    expect(await readJevApiKey()).toBe(KEY);
    expect(creds.reads).toBe(1);
  });

  it('a save or a clear is seen at once, without waiting for the cache to expire', async () => {
    await setJevApiKey(KEY);
    expect(await readJevApiKey()).toBe(KEY);
    await setJevApiKey(null);
    expect(await readJevApiKey()).toBeNull();
    expect((await resolveJevMemoryInjection()).keyPresent).toBe(false);
    expect(creds.reads).toBe(0);
  });

  it('a failed key read is not cached: it reads as no key, and the next call reads again', async () => {
    creds.store[JEV_API_KEY_NAME] = KEY;
    creds.failReads = true;
    expect(await readJevApiKey()).toBeNull();
    creds.failReads = false;
    expect(await readJevApiKey()).toBe(KEY);
    expect(creds.reads).toBe(2);
  });

  it('the view masks the key and never carries it raw', async () => {
    await setJevApiKey(KEY);
    await setJevMode('shadow');
    const view = await getJevSettingsView();
    expect(view).toEqual({ mode: 'shadow', keyPresent: true, maskedKey: 'fak...aaaa', effective: 'shadow', model: 'jev-1.13.0' });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });
});

describe('the decision client', () => {
  it('with no key stored, a decision is inconclusive(no-key) and makes ZERO network calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    ensureJevDecisionClient();
    const out = await decide({ state: 'turn text', questions: { q: { type: 'yesNo', instructions: 'Relevant?' } } });
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'no-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the key per call, so a key saved after install is used without a restart', async () => {
    const fetchSpy = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    ensureJevDecisionClient();
    await setJevApiKey(KEY);
    const out = await decide({ state: 'turn text', questions: { q: { type: 'yesNo', instructions: 'Relevant?' } } });
    expect(out).toMatchObject({ kind: 'answered', answers: { q: { pYes: 0.9 } } });
    const init = (fetchSpy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('installs one process-wide client', () => {
    expect(ensureJevDecisionClient()).toBe(ensureJevDecisionClient());
  });
});

// WI-10004268: the client used to record calls without pricing, so every
// decision_model_calls row had cost_usd NULL and the ledger reported $0 spend.
describe('the call ledger row', () => {
  it('prices Jev at $0.042 per million input tokens, output free', () => {
    expect(JEV_PRICING).toEqual({ inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 });
  });

  it('an answered call is written with a non-null cost computed from its input tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: { q: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 12_345, output_tokens: 7 },
      }),
    })));
    ensureJevDecisionClient();
    await setJevApiKey(KEY);
    await decide({ state: 'turn text', questions: { q: { type: 'yesNo', instructions: 'Relevant?' } } });
    // The ledger write is fire-and-forget, so wait for it to land.
    await vi.waitFor(() => expect(db.ledger).toHaveLength(1));
    const row = db.ledger[0];
    expect(row).toMatchObject({ outcome: 'answered', input_tokens: 12_345, output_tokens: 7 });
    expect(row.cost_usd).not.toBeNull();
    expect(row.cost_usd as number).toBeCloseTo((12_345 * 0.042) / 1_000_000, 12);
  });

  it('an inconclusive call has no tokens, so its cost stays null', async () => {
    vi.stubGlobal('fetch', vi.fn());
    ensureJevDecisionClient();
    await decide({ state: 'turn text', questions: { q: { type: 'yesNo', instructions: 'Relevant?' } } });
    await vi.waitFor(() => expect(db.ledger).toHaveLength(1));
    expect(db.ledger[0]).toMatchObject({ outcome: 'inconclusive', inconclusive_reason: 'no-key', cost_usd: null });
  });
});
