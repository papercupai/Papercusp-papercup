/**
 * WI-10005995 — the isolated-DHT product-host alarm behind dev:service_health.
 * systemd, /proc and the rig-lock read are injected, so nothing here touches the
 * real host. Acceptance (from the work-item): a PAPERCUSP_DHT_BOOTSTRAP drop-in
 * present with NO rig lock held → a warning; with the rig lock held → none.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../locks/su-lock-store', () => ({
  getTxPool: vi.fn(() => ({})),
  listLiveResourceDomains: vi.fn(),
}));

import { listLiveResourceDomains } from '../locks/su-lock-store';
import {
  classifyDhtEnvironment,
  dhtUniverseNextVerb,
  parseEnvironmentLines,
  parseProcEnviron,
  parseSystemdEnvironmentProperty,
  PHYSICAL_RIG_RESOURCE,
  probeProductHostDhtUniverse,
  readRigLockHeld,
} from './dht-universe-probe';
import { resolveEffectiveDhtBootstrap } from '../../sync/hyperbee/dht-universe';

const BG = 'papercusp-bg-host.service';
const STAGING = 'papercusp-staging-api.service';
const RIG_DHT = '172.31.44.1:49838';
const noFile = (): string => {
  throw new Error('ENOENT');
};

/** A `systemctl --user show -p Id -p LoadState -p MainPID -p Environment` body, one block per unit. */
function showBlock(unit: string, opts: { pid?: number; env?: string; loadState?: string } = {}): string {
  return [
    `Id=${unit}`,
    `LoadState=${opts.loadState ?? 'loaded'}`,
    `MainPID=${opts.pid ?? 0}`,
    `Environment=${opts.env ?? 'HOME=/var/lib/op NODE_ENV=production'}`,
  ].join('\n');
}

function fakeSystemctl(blocks: string[], managerEnv = 'HOME=/var/lib/op\nPATH=/usr/bin') {
  return vi.fn(async (args: string[]) => (args.includes('show-environment') ? managerEnv : blocks.join('\n\n')));
}

const environ = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0') + '\0';

describe('parsers (pure)', () => {
  it('reads systemd Environment= tokens, including a quoted token with a space', () => {
    expect(
      parseSystemdEnvironmentProperty(`PAPERCUSP_DHT_BOOTSTRAP=${RIG_DHT} "LABEL=two words" EMPTY=`),
    ).toEqual({ PAPERCUSP_DHT_BOOTSTRAP: RIG_DHT, LABEL: 'two words', EMPTY: '' });
    expect(parseSystemdEnvironmentProperty(undefined)).toEqual({});
  });

  it('reads /proc environ (NUL-separated) and show-environment (line-separated)', () => {
    expect(parseProcEnviron(environ({ A: '1', B: 'x=y' }))).toEqual({ A: '1', B: 'x=y' });
    expect(parseEnvironmentLines('A=1\nB=2\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('classifyDhtEnvironment — same precedence as the swarm', () => {
  it('env var wins and classifies isolated', () => {
    expect(classifyDhtEnvironment({ PAPERCUSP_DHT_BOOTSTRAP: RIG_DHT }, noFile, '/h')).toEqual({
      mode: 'isolated',
      source: 'env',
      bootstrap: RIG_DHT,
    });
  });

  it("falls back to the marker file under the PROCESS's HOME, not the prober's", () => {
    const readFile = vi.fn((p: string) => {
      if (p === '/var/lib/svc/.papercusp/dht-bootstrap') return `${RIG_DHT}\n`;
      throw new Error('ENOENT');
    });
    expect(classifyDhtEnvironment({ HOME: '/var/lib/svc' }, readFile, '/var/lib/prober')).toMatchObject({
      mode: 'isolated',
      source: 'file',
    });
  });

  it('no env and no file is the public DHT', () => {
    expect(classifyDhtEnvironment({}, noFile, '/h')).toEqual({ mode: 'public', source: 'none' });
  });

  it('an unparseable value is misconfigured, not public', () => {
    expect(classifyDhtEnvironment({ PAPERCUSP_DHT_BOOTSTRAP: 'garbage' }, noFile, '/h').mode).toBe('misconfigured');
  });

  it('resolveEffectiveDhtBootstrap honours PAPERCUSP_DHT_BOOTSTRAP_FILE over the default path', () => {
    const out = resolveEffectiveDhtBootstrap({
      env: { PAPERCUSP_DHT_BOOTSTRAP_FILE: '/etc/dht' },
      defaultFilePath: '/h/.papercusp/dht-bootstrap',
      readFile: (p) => (p === '/etc/dht' ? RIG_DHT : noFile()),
    });
    expect(out).toEqual({ raw: RIG_DHT, source: 'file', filePath: '/etc/dht' });
  });
});

describe('probeProductHostDhtUniverse — acceptance', () => {
  const dropIn = `HOME=/var/lib/op PAPERCUSP_DHT_BOOTSTRAP=${RIG_DHT}`;

  it('WARNS: a PAPERCUSP_DHT_BOOTSTRAP drop-in is present and no rig lock is held', async () => {
    const rigLockHeld = vi.fn(async () => false);
    const out = await probeProductHostDhtUniverse({
      platform: 'linux',
      systemctl: fakeSystemctl([showBlock(BG, { pid: 101, env: dropIn }), showBlock(STAGING, { pid: 202 })]),
      readProcEnviron: async (pid) =>
        pid === 101 ? environ({ HOME: '/var/lib/op', PAPERCUSP_DHT_BOOTSTRAP: RIG_DHT }) : environ({ HOME: '/var/lib/op' }),
      readFile: noFile,
      rigLockHeld,
    });
    expect(rigLockHeld).toHaveBeenCalledTimes(1);
    expect(out?.rigLockHeld).toBe(false);
    expect(out?.warnings).toHaveLength(1);
    expect(out?.warnings[0]?.unit).toBe(BG);
    expect(out?.warnings[0]?.warning).toContain(`no drill holds the ${PHYSICAL_RIG_RESOURCE} lock`);
    expect(out?.warnings[0]?.warning).toContain(RIG_DHT);
    expect(out?.hosts.find((h) => h.unit === STAGING)?.warning).toBeUndefined();
  });

  it('does NOT warn: the same drop-in while a drill holds the rig lock', async () => {
    const out = await probeProductHostDhtUniverse({
      platform: 'linux',
      systemctl: fakeSystemctl([showBlock(BG, { pid: 101, env: dropIn })]),
      readProcEnviron: async () => environ({ PAPERCUSP_DHT_BOOTSTRAP: RIG_DHT }),
      readFile: noFile,
      rigLockHeld: async () => true,
    });
    expect(out?.rigLockHeld).toBe(true);
    expect(out?.warnings).toEqual([]);
    expect(out?.hosts[0]).toMatchObject({ unit: BG, running: { mode: 'isolated' }, configured: { mode: 'isolated' } });
  });

  it('warns BEFORE the restart: a drop-in loaded into the unit but the process still on public', async () => {
    const out = await probeProductHostDhtUniverse({
      platform: 'linux',
      systemctl: fakeSystemctl([showBlock(BG, { pid: 101, env: dropIn })]),
      readProcEnviron: async () => environ({ HOME: '/var/lib/op' }),
      readFile: noFile,
      rigLockHeld: async () => false,
    });
    expect(out?.hosts[0]?.running?.mode).toBe('public');
    expect(out?.warnings[0]?.warning).toContain('the next start resolves ISOLATED');
    expect(out?.warnings[0]?.warning).not.toContain('the running process');
  });

  it('catches a stray user-manager environment variable, which no drop-in shows', async () => {
    const out = await probeProductHostDhtUniverse({
      platform: 'linux',
      systemctl: fakeSystemctl([showBlock(BG, { pid: 0 })], `HOME=/var/lib/op\nPAPERCUSP_DHT_BOOTSTRAP=${RIG_DHT}`),
      readFile: noFile,
      rigLockHeld: async () => false,
    });
    expect(out?.hosts[0]).toMatchObject({ running: null, configured: { mode: 'isolated' } });
    expect(out?.warnings).toHaveLength(1);
  });

  it('an UNREADABLE rig lock still warns (an alarm that goes quiet on missing evidence is the original bug)', async () => {
    const out = await probeProductHostDhtUniverse({
      platform: 'linux',
      systemctl: fakeSystemctl([showBlock(BG, { pid: 101, env: dropIn })]),
      readProcEnviron: async () => environ({ PAPERCUSP_DHT_BOOTSTRAP: RIG_DHT }),
      readFile: noFile,
      rigLockHeld: async () => null,
    });
    expect(out?.rigLockHeld).toBeNull();
    expect(out?.warnings[0]?.warning).toContain('lock could not be read');
  });

  it('all hosts public: no warning, and the lock store is never queried', async () => {
    const rigLockHeld = vi.fn(async () => false);
    const out = await probeProductHostDhtUniverse({
      platform: 'linux',
      systemctl: fakeSystemctl([showBlock(BG, { pid: 101 }), showBlock(STAGING, { pid: 202 })]),
      readProcEnviron: async () => environ({ HOME: '/var/lib/op' }),
      readFile: noFile,
      rigLockHeld,
    });
    expect(out).toEqual({
      hosts: [
        expect.objectContaining({ unit: BG, running: { mode: 'public', source: 'none' } }),
        expect.objectContaining({ unit: STAGING, running: { mode: 'public', source: 'none' } }),
      ],
      warnings: [],
    });
    expect(rigLockHeld).not.toHaveBeenCalled();
  });

  it('skips a unit not installed on this host, and keeps the others', async () => {
    const out = await probeProductHostDhtUniverse({
      platform: 'linux',
      systemctl: fakeSystemctl([showBlock(BG, { loadState: 'not-found' }), showBlock(STAGING, { pid: 202 })]),
      readProcEnviron: async () => environ({}),
      readFile: noFile,
      rigLockHeld: async () => false,
    });
    expect(out?.hosts.map((h) => h.unit)).toEqual([STAGING]);
  });

  it('an unreadable /proc environ reports running:null and still classifies the configured env', async () => {
    const out = await probeProductHostDhtUniverse({
      platform: 'linux',
      systemctl: fakeSystemctl([showBlock(BG, { pid: 101, env: dropIn })]),
      readProcEnviron: async () => {
        throw new Error('EACCES');
      },
      readFile: noFile,
      rigLockHeld: async () => false,
    });
    expect(out?.hosts[0]).toMatchObject({ mainPid: 101, running: null, configured: { mode: 'isolated' } });
    expect(out?.warnings).toHaveLength(1);
  });

  it('returns null (no verdict) when systemd cannot be read, or off Linux', async () => {
    await expect(
      probeProductHostDhtUniverse({
        platform: 'linux',
        systemctl: async () => {
          throw new Error('Failed to connect to bus');
        },
      }),
    ).resolves.toBeNull();
    await expect(probeProductHostDhtUniverse({ platform: 'darwin' })).resolves.toBeNull();
  });
});

describe('readRigLockHeld', () => {
  const live = vi.mocked(listLiveResourceDomains);

  it('true when any domain holds the rig lease, false when none does', async () => {
    live.mockResolvedValueOnce(['host-global']);
    await expect(readRigLockHeld()).resolves.toBe(true);
    expect(live).toHaveBeenLastCalledWith(expect.anything(), PHYSICAL_RIG_RESOURCE);
    live.mockResolvedValueOnce([]);
    await expect(readRigLockHeld()).resolves.toBe(false);
  });

  it('null (unknown) when the store throws or does not answer in time', async () => {
    live.mockRejectedValueOnce(new Error('pool closed'));
    await expect(readRigLockHeld()).resolves.toBeNull();
    live.mockReturnValueOnce(new Promise(() => {}));
    await expect(readRigLockHeld(10)).resolves.toBeNull();
  });
});

describe('dhtUniverseNextVerb', () => {
  it('routes each unit to its own restart target and names every bootstrap source', () => {
    expect(dhtUniverseNextVerb(BG)).toContain('dev:restart { target: "bg-host" }');
    expect(dhtUniverseNextVerb(STAGING)).toContain('dev:restart { target: "staging" }');
    expect(dhtUniverseNextVerb(BG)).toMatch(/show-environment.*dht-bootstrap/);
  });
});
