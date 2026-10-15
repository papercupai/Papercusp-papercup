import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: vi.fn() }));

import { getOrgPg } from '@papercusp/db-org';
import { mockOrgPgSql } from '../../testing/mock-org-pg';
import {
  resolveWakeMode,
  resolveWakeModeFrom,
  coerceWakeMode,
  getDefaultWakeMode,
  setDefaultWakeMode,
  getWakeModeOverride,
  getWakeModeOverridesFor,
  setWakeMode,
  ensureFleetMemberWakeAuto,
  ensureLaunchedWakeAuto,
  DEFAULT_WAKE_MODE,
  WAKE_MODES,
} from './wake-mode';

// A Map-backed fake `sql` template tag mimicking the operator_settings KV: an
// INSERT upserts (key=vals[0] → value=vals[1]); a SELECT returns the row for
// its key=vals[0] (or none); a `key = ANY(...)` SELECT returns {key, value} for
// every listed key that exists. A `LIKE` read is deliberately NOT modelled: it
// returns every row, so a regression to an unscoped scan shows up as rows for
// owners the caller never asked about.
function fakeKv() {
  const store = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const sql = vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join('§');
    if (q.includes('INSERT')) {
      store.set(String(vals[0]), String(vals[1]));
      descriptions.set(String(vals[0]), String(vals[2]));
      return Promise.resolve([] as unknown[]);
    }
    if (q.includes('ANY(')) {
      const keys = vals[0] as string[];
      return Promise.resolve(
        keys.filter((k) => store.has(k)).map((k) => ({ key: k, value: store.get(k)! })),
      );
    }
    if (q.includes('LIKE')) {
      return Promise.resolve([...store.entries()].map(([key, value]) => ({ key, value })));
    }
    const v = store.get(String(vals[0])); // SELECT value WHERE key = vals[0]
    return Promise.resolve(v === undefined ? [] : [{ value: v }]);
  });
  return { sql, store, descriptions };
}

let kv: ReturnType<typeof fakeKv>;
beforeEach(() => {
  kv = fakeKv();
  mockOrgPgSql(vi.mocked(getOrgPg), kv.sql);
});
afterEach(() => vi.clearAllMocks());

describe('wake-mode pure helpers (P-015 / D-005)', () => {
  it('coerceWakeMode narrows valid modes + rejects garbage/null', () => {
    expect(coerceWakeMode('auto')).toBe('auto');
    expect(coerceWakeMode('manual')).toBe('manual');
    expect(coerceWakeMode('bogus')).toBeNull();
    expect(coerceWakeMode(null)).toBeNull();
  });
  it('resolveWakeModeFrom: override > global default > auto', () => {
    expect(resolveWakeModeFrom('manual', 'auto')).toBe('manual');
    expect(resolveWakeModeFrom(null, 'manual')).toBe('manual');
    expect(resolveWakeModeFrom(null, null)).toBe('auto');
    expect(DEFAULT_WAKE_MODE).toBe('auto');
    expect(WAKE_MODES).toEqual(['auto', 'manual']);
  });
});

describe('wake-mode store (operator_settings KV)', () => {
  it('defaults to auto with nothing configured (default-preserving)', async () => {
    expect(await getDefaultWakeMode()).toBe('auto');
    expect(await getWakeModeOverride('s-1')).toBeNull();
    expect(await resolveWakeMode('s-1')).toBe('auto');
  });
  it('a global default applies to every agent without an override', async () => {
    await setDefaultWakeMode('manual');
    expect(await getDefaultWakeMode()).toBe('manual');
    expect(await resolveWakeMode('s-anything')).toBe('manual');
  });
  it('a per-agent override beats the global default', async () => {
    await setDefaultWakeMode('manual');
    await setWakeMode('s-1', 'auto');
    expect(await resolveWakeMode('s-1')).toBe('auto'); // override wins
    expect(await resolveWakeMode('s-2')).toBe('manual'); // falls back to the default
  });
  it('a garbage stored value falls back to the default', async () => {
    kv.store.set('wake_mode:default', 'nonsense');
    expect(await getDefaultWakeMode()).toBe('auto');
  });
});

describe('getWakeModeOverridesFor — owner-scoped batch read (WI-10005228)', () => {
  it('returns overrides for exactly the requested owners, never the rest of the history', async () => {
    kv.store.set('wake_mode:agent:s-live-1', 'manual');
    kv.store.set('wake_mode:agent:s-live-2', 'auto');
    // Retained history the roster never renders — 10,342 rows of this live on 2026-10-02.
    for (let i = 0; i < 50; i += 1) kv.store.set(`wake_mode:agent:s-ended-${i}`, 'manual');
    kv.store.set('wake_mode:default', 'manual');

    const out = await getWakeModeOverridesFor(['s-live-1', 's-live-2', 's-no-override']);

    expect([...out.entries()].sort()).toEqual([
      ['s-live-1', 'manual'],
      ['s-live-2', 'auto'],
    ]);
  });

  it('issues ONE primary-key probe with the prefixed, de-duplicated keys — not a LIKE scan', async () => {
    await getWakeModeOverridesFor(['s-1', 's-2', 's-1', '']);

    expect(kv.sql).toHaveBeenCalledTimes(1);
    const [strings, ...vals] = kv.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = strings.join('?');
    expect(text).toMatch(/WHERE\s+key\s*=\s*ANY\(/);
    expect(text).not.toMatch(/LIKE/i);
    expect(vals[0]).toEqual(['wake_mode:agent:s-1', 'wake_mode:agent:s-2']);
  });

  it('an empty owner set costs no query at all', async () => {
    expect(await getWakeModeOverridesFor([])).toEqual(new Map());
    expect(kv.sql).not.toHaveBeenCalled();
  });

  it('calibration: the fake answers the OLD unscoped LIKE read with the whole history', async () => {
    // Keeps the first test above from passing vacuously: the pre-WI-10005228 query
    // (`WHERE key LIKE 'wake_mode:agent:%'`) through this same fake returns every
    // stored row, so a regression to it would surface the s-ended-* owners there.
    kv.store.set('wake_mode:agent:s-live-1', 'manual');
    for (let i = 0; i < 5; i += 1) kv.store.set(`wake_mode:agent:s-ended-${i}`, 'manual');
    const rows = (await kv.sql`SELECT key, value FROM harness_shared.operator_settings
      WHERE key LIKE 'wake_mode:agent:%'`) as Array<{ key: string }>;
    expect(rows).toHaveLength(6);
  });

  it('drops a garbage stored value (the owner then resolves via the global default)', async () => {
    kv.store.set('wake_mode:agent:s-1', 'nonsense');
    expect(await getWakeModeOverridesFor(['s-1'])).toEqual(new Map());
  });
});

describe('ensureFleetMemberWakeAuto — fleet-member wake immunity (WI-2185)', () => {
  it('writes an auto override for a MEMBER and returns the mode', async () => {
    expect(await ensureFleetMemberWakeAuto('s-member', 'member')).toBe('auto');
    expect(kv.store.get('wake_mode:agent:s-member')).toBe('auto');
    expect(await getWakeModeOverride('s-member')).toBe('auto');
  });
  it('makes the member immune to a manual GLOBAL default', async () => {
    await setDefaultWakeMode('manual');
    await ensureFleetMemberWakeAuto('s-member', 'member');
    // The member wins with its override; a peer without one still inherits manual.
    expect(await resolveWakeMode('s-member')).toBe('auto');
    expect(await resolveWakeMode('s-peer')).toBe('manual');
  });
  it('is a NO-OP for a leader (owner-gated by design) — no override row written', async () => {
    await setDefaultWakeMode('manual');
    expect(await ensureFleetMemberWakeAuto('s-leader', 'leader')).toBeNull();
    expect(kv.store.has('wake_mode:agent:s-leader')).toBe(false);
    expect(await getWakeModeOverride('s-leader')).toBeNull();
    expect(await resolveWakeMode('s-leader')).toBe('manual'); // still inherits the gate
  });
  it('is a NO-OP for a non-fleet launch (null/undefined role)', async () => {
    expect(await ensureFleetMemberWakeAuto('s-solo', null)).toBeNull();
    expect(await ensureFleetMemberWakeAuto('s-solo', undefined)).toBeNull();
    expect(kv.store.has('wake_mode:agent:s-solo')).toBe(false);
  });
  it('setWakeMode carries a custom description when given', async () => {
    await setWakeMode('s-x', 'auto', 'because WI-2185');
    expect(kv.store.get('wake_mode:agent:s-x')).toBe('auto');
    expect(kv.descriptions.get('wake_mode:agent:s-x')).toBe('because WI-2185');
  });

  it('updates the durable description when a mode changes again', async () => {
    await setDefaultWakeMode('manual', 'fencing stale leader');
    expect(kv.descriptions.get('wake_mode:default')).toBe('fencing stale leader');

    await setDefaultWakeMode('auto', 'replacement leader is live');
    expect(kv.descriptions.get('wake_mode:default')).toBe('replacement leader is live');
  });
});

describe('ensureLaunchedWakeAuto — generalized launched-wake-immunity (EI-19965557940158384)', () => {
  it('unchanged member behavior: writes an auto override for a MEMBER regardless of launchedByAgent', async () => {
    expect(await ensureLaunchedWakeAuto('s-member', { fleetRole: 'member', launchedByAgent: false })).toBe('auto');
    expect(kv.store.get('wake_mode:agent:s-member')).toBe('auto');
  });
  it('is a NO-OP for a leader regardless of launchedByAgent — owner-gated by design', async () => {
    await setDefaultWakeMode('manual');
    expect(await ensureLaunchedWakeAuto('s-leader', { fleetRole: 'leader', launchedByAgent: true })).toBeNull();
    expect(kv.store.has('wake_mode:agent:s-leader')).toBe(false);
    expect(await resolveWakeMode('s-leader')).toBe('manual'); // still inherits the gate
  });
  it('the new case: a FLEETLESS agent-launched session (no fleetRole) gets the auto override', async () => {
    await setDefaultWakeMode('manual');
    expect(await ensureLaunchedWakeAuto('s-solo-launched', { fleetRole: null, launchedByAgent: true })).toBe('auto');
    expect(kv.store.get('wake_mode:agent:s-solo-launched')).toBe('auto');
    expect(await resolveWakeMode('s-solo-launched')).toBe('auto'); // immune to the manual global default
  });
  it('preserves an explicit per-agent manual override for a launched member', async () => {
    await setDefaultWakeMode('auto');
    await setWakeMode('s-manual-member', 'manual');

    expect(await ensureLaunchedWakeAuto('s-manual-member', { fleetRole: 'member', launchedByAgent: true })).toBeNull();
    expect(await getWakeModeOverride('s-manual-member')).toBe('manual');
    expect(await resolveWakeMode('s-manual-member')).toBe('manual');
  });
  it('is a NO-OP for a fleetless, NOT agent-launched session (a human typing `psu su` directly)', async () => {
    await setDefaultWakeMode('manual');
    expect(await ensureLaunchedWakeAuto('s-human', { fleetRole: null, launchedByAgent: false })).toBeNull();
    expect(kv.store.has('wake_mode:agent:s-human')).toBe(false);
    expect(await resolveWakeMode('s-human')).toBe('manual'); // stays gated — the owner IS present
  });
  it('is a NO-OP for undefined fleetRole + launchedByAgent false (the fully-absent case)', async () => {
    expect(await ensureLaunchedWakeAuto('s-nothing', { fleetRole: undefined, launchedByAgent: false })).toBeNull();
    expect(kv.store.has('wake_mode:agent:s-nothing')).toBe(false);
  });
});

describe('EI-597 idempotent-skip — repeated set-to-same-value skips the write', () => {
  it('setDefaultWakeMode is a no-op INSERT/UPDATE when already at the target', async () => {
    await setDefaultWakeMode('manual');
    expect(kv.sql).toHaveBeenCalledTimes(2); // 1 read (idempotent check) + 1 real write
    await setDefaultWakeMode('manual'); // repeat — already manual
    expect(kv.sql).toHaveBeenCalledTimes(3); // +1 read only, NO extra INSERT/UPDATE
    expect(await getDefaultWakeMode()).toBe('manual');
  });
  it('setDefaultWakeMode still writes when the value actually changes', async () => {
    await setDefaultWakeMode('manual');
    await setDefaultWakeMode('auto');
    expect(await getDefaultWakeMode()).toBe('auto');
  });
  it('setWakeMode is a no-op when the per-agent override already matches', async () => {
    await setWakeMode('s-1', 'manual');
    const callsAfterFirst = kv.sql.mock.calls.length;
    await setWakeMode('s-1', 'manual'); // repeat — already manual
    // Only a read was added, not another INSERT.
    const insertCalls = kv.sql.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('§').includes('INSERT'));
    expect(insertCalls.length).toBe(1);
    expect(kv.sql.mock.calls.length).toBeGreaterThan(callsAfterFirst); // the read still happened
    expect(await getWakeModeOverride('s-1')).toBe('manual');
  });
  it('a HAMMERING caller (EI-597 repro shape) settles after the first write with zero further writes', async () => {
    // Simulates the runaway pattern: many rapid identical set calls.
    for (let i = 0; i < 50; i++) await setDefaultWakeMode('auto'); // already auto (the default) every time
    const insertCalls = kv.sql.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('§').includes('INSERT'));
    expect(insertCalls.length).toBe(0); // never wrote — already at target from the start
  });
});
