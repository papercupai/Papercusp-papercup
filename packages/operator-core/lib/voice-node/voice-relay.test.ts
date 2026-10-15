/**
 * Voice relay config resolution (P-013/D-009) — env ∪ PG ∪ shipped defaults,
 * validation, and which DHT universe gets the defaults
 * (plan public-blind-relay-2026-10-01, R-3/R-4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  state: null as unknown,
  written: [] as Array<{ key: string; value: unknown }>,
}));

vi.mock('../operator-state-pg', () => ({
  readOperatorState: async () => pg.state,
  writeOperatorState: async (key: string, value: unknown) => {
    pg.written.push({ key, value });
  },
}));

import { DEFAULT_RELAY_KEYS, defaultRelayKeysApply, getVoiceRelayKeys, readVoiceRelayState } from './voice-relay';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
/** A custom bootstrap list: an isolated rig, which cannot reach a public-DHT relay. */
const ISOLATED = { dhtBootstrap: [{ host: '172.31.44.1', port: 49838 }], bootstrapMisconfigured: false };
const PUBLIC = { dhtBootstrap: undefined, bootstrapMisconfigured: false };
/** PAPERCUSP_DHT_BOOTSTRAP was set but parsed to nothing: the swarm lands on the public DHT anyway. */
const MISCONFIGURED = { dhtBootstrap: undefined, bootstrapMisconfigured: true };
const hex = (keys: Buffer[]) => keys.map((b) => b.toString('hex'));

afterEach(() => {
  pg.state = null;
  pg.written.length = 0;
  delete process.env.PAPERCUSP_VOICE_RELAY_KEYS;
  delete process.env.PAPERCUSP_RELAY_DEFAULTS;
});

describe('getVoiceRelayKeys — configured keys (isolated DHT, no defaults)', () => {
  it('returns [] with nothing configured', async () => {
    expect(await getVoiceRelayKeys(ISOLATED)).toEqual([]);
  });

  it('parses env keys (comma-separated hex)', async () => {
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = `${KEY_A}, ${KEY_B}`;
    expect(hex(await getVoiceRelayKeys(ISOLATED))).toEqual([KEY_A, KEY_B]);
  });

  it('unions env with the PG state, deduped', async () => {
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = KEY_A;
    pg.state = { relayKeys: [KEY_A, KEY_B] };
    expect(hex(await getVoiceRelayKeys(ISOLATED))).toEqual([KEY_A, KEY_B]);
  });

  it('drops malformed keys instead of throwing', async () => {
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = `nonsense, ${KEY_A}, 1234`;
    pg.state = { relayKeys: ['zz'.repeat(32)] };
    expect(hex(await getVoiceRelayKeys(ISOLATED))).toEqual([KEY_A]);
  });
});

describe('getVoiceRelayKeys — shipped default relay keys', () => {
  it('ships at least one well-formed default key', () => {
    expect(DEFAULT_RELAY_KEYS.length).toBeGreaterThan(0);
    for (const k of DEFAULT_RELAY_KEYS) expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives a public-DHT swarm the defaults with no env and no PG keys', async () => {
    expect(hex(await getVoiceRelayKeys(PUBLIC))).toEqual([...DEFAULT_RELAY_KEYS]);
  });

  it('treats an empty bootstrap list as the public DHT (hyperdht falls back to its own nodes)', async () => {
    expect(hex(await getVoiceRelayKeys({ dhtBootstrap: [], bootstrapMisconfigured: false }))).toEqual([
      ...DEFAULT_RELAY_KEYS,
    ]);
  });

  it('puts configured keys first and dedupes a default that is also configured', async () => {
    const def = DEFAULT_RELAY_KEYS[0]!;
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = KEY_A;
    pg.state = { relayKeys: [def.toUpperCase(), KEY_B] };
    expect(hex(await getVoiceRelayKeys(PUBLIC))).toEqual([KEY_A, def, KEY_B, ...DEFAULT_RELAY_KEYS.slice(1)]);
  });

  it('never gives an isolated-DHT swarm the defaults', async () => {
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = KEY_A;
    const keys = hex(await getVoiceRelayKeys(ISOLATED));
    expect(keys).toEqual([KEY_A]);
    for (const k of DEFAULT_RELAY_KEYS) expect(keys).not.toContain(k);
  });

  it('never gives a misconfigured-DHT swarm the defaults, though it lands on the public DHT', async () => {
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = KEY_A;
    const keys = hex(await getVoiceRelayKeys(MISCONFIGURED));
    expect(keys).toEqual([KEY_A]);
    for (const k of DEFAULT_RELAY_KEYS) expect(keys).not.toContain(k);
    expect(defaultRelayKeysApply(MISCONFIGURED, {})).toBe(false);
  });

  it('PAPERCUSP_RELAY_DEFAULTS=0 opts a public swarm out', async () => {
    process.env.PAPERCUSP_RELAY_DEFAULTS = '0';
    pg.state = { relayKeys: [KEY_B] };
    expect(hex(await getVoiceRelayKeys(PUBLIC))).toEqual([KEY_B]);
  });

  it('defaultRelayKeysApply: public yes, isolated no, opt-out no', () => {
    expect(defaultRelayKeysApply(PUBLIC, {})).toBe(true);
    expect(defaultRelayKeysApply(ISOLATED, {})).toBe(false);
    expect(defaultRelayKeysApply(PUBLIC, { PAPERCUSP_RELAY_DEFAULTS: ' 0 ' })).toBe(false);
    expect(defaultRelayKeysApply(PUBLIC, { PAPERCUSP_RELAY_DEFAULTS: '1' })).toBe(true);
  });
});

describe('readVoiceRelayState', () => {
  it('defaults to {} when the row is unset', async () => {
    expect(await readVoiceRelayState()).toEqual({});
  });
  it('returns the stored state', async () => {
    pg.state = { serve: true, relayKeys: [KEY_A] };
    expect(await readVoiceRelayState()).toEqual({ serve: true, relayKeys: [KEY_A] });
  });
});
