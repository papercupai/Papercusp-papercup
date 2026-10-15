/**
 * P-532 (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005523): the embed
 * sidecar is ON by default inside a sidecar-capable bundle (packaged / hosted
 * Server, desktop, operator host) and OFF when running from source, and a
 * Server's own spawned sidecar exits when idle unless told otherwise.
 *
 * The entry pin at the bottom keeps EMBED_SIDECAR_REEXEC_ENTRIES honest: a name
 * listed there must belong to an entry whose boot diverts
 * PAPERCUSP_EMBED_SIDECAR_MODE=1 to the embed sidecar server. Without that
 * divert, re-exec'ing the bundle would boot a second full host instead.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS,
  EMBED_SIDECAR_REEXEC_ENTRIES,
  embedSidecarEnabled,
  runningFromSidecarCapableBundle,
  spawnedSidecarIdleExitEnv,
} from './embed-sidecar-spawn';
import { EMBED_SIDECAR_IDLE_EXIT_ENV, resolveEmbedSidecarIdleExitMs } from './embed-sidecar-server';

const SERVER_BUNDLE = '/opt/papercusp-server/app/serve.mjs';
const DESKTOP_BUNDLE = '/usr/lib/papercusp/env-sidecars/staging/serve.mjs';
const HOST_BUNDLE = '/srv/papercup-release/apps/operator/dist-host/hono-host.mjs';
const SOURCE = '/repo/packages/operator-core/lib/memory/embed-sidecar-spawn.ts';
const PROBE_BUNDLE = '/repo/apps/operator/dist-host/p008-hono-host-probe.mjs';

describe('P-532: embedSidecarEnabled default', () => {
  it('is ON with no env inside a sidecar-capable bundle', () => {
    expect(embedSidecarEnabled({}, SERVER_BUNDLE)).toBe(true);
    expect(embedSidecarEnabled({}, DESKTOP_BUNDLE)).toBe(true);
    expect(embedSidecarEnabled({}, HOST_BUNDLE)).toBe(true);
  });

  it('is OFF with no env when running from source or from a bundle without the divert', () => {
    expect(embedSidecarEnabled({}, SOURCE)).toBe(false);
    expect(embedSidecarEnabled({}, PROBE_BUNDLE)).toBe(false);
  });

  it('an explicit setting always wins: "1" on, any other set value off (including empty)', () => {
    expect(embedSidecarEnabled({ PAPERCUSP_EMBED_SIDECAR: '1' }, SOURCE)).toBe(true);
    expect(embedSidecarEnabled({ PAPERCUSP_EMBED_SIDECAR: '0' }, SERVER_BUNDLE)).toBe(false);
    // systemd `Environment=PAPERCUSP_EMBED_SIDECAR=` (bg-host's drop-in) means "off", not "default".
    expect(embedSidecarEnabled({ PAPERCUSP_EMBED_SIDECAR: '' }, HOST_BUNDLE)).toBe(false);
  });

  it('is never on inside the sidecar process itself', () => {
    expect(embedSidecarEnabled({ PAPERCUSP_EMBED_SIDECAR_MODE: '1' }, SERVER_BUNDLE)).toBe(false);
    expect(
      embedSidecarEnabled({ PAPERCUSP_EMBED_SIDECAR: '1', PAPERCUSP_EMBED_SIDECAR_MODE: '1' }, SERVER_BUNDLE),
    ).toBe(false);
  });

  it("defaults to this module's own path, which under vitest is source", () => {
    expect(runningFromSidecarCapableBundle()).toBe(false);
    expect(embedSidecarEnabled({})).toBe(false);
  });
});

describe('P-532: idle exit for a sidecar this Server spawns', () => {
  it('per-tenant (ephemeral port) child gets the default idle window, which the server honours', () => {
    const patch = spawnedSidecarIdleExitEnv({}, null);
    expect(patch).toEqual({ [EMBED_SIDECAR_IDLE_EXIT_ENV]: String(EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS) });
    expect(resolveEmbedSidecarIdleExitMs(patch)).toBe(EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS);
    expect(EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS).toBeGreaterThan(0);
  });

  it('an explicit parent value (including 0 = never) is inherited, not overridden', () => {
    expect(spawnedSidecarIdleExitEnv({ [EMBED_SIDECAR_IDLE_EXIT_ENV]: '0' }, null)).toEqual({});
    expect(spawnedSidecarIdleExitEnv({ [EMBED_SIDECAR_IDLE_EXIT_ENV]: '60000' }, null)).toEqual({});
  });

  it('a fixed shared port keeps never-exit: another process may hold that URL with no ensure hook', () => {
    expect(spawnedSidecarIdleExitEnv({}, 3384)).toEqual({});
  });
});

describe('P-532: every listed re-exec entry still diverts to the embed sidecar server', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const ENTRY_SOURCES: Record<string, string> = {
    'serve.mjs': 'apps/operator/bin/serve.ts',
    'hono-host.mjs': 'apps/operator/bin/hono-host.ts',
  };

  it('maps every listed bundle name to an entry source', () => {
    expect([...EMBED_SIDECAR_REEXEC_ENTRIES].sort()).toEqual(Object.keys(ENTRY_SOURCES).sort());
  });

  for (const [bundle, source] of Object.entries(ENTRY_SOURCES)) {
    it(`${bundle} (${source}) checks PAPERCUSP_EMBED_SIDECAR_MODE and runs runEmbedSidecarServer`, () => {
      const text = readFileSync(path.join(repoRoot, source), 'utf8');
      expect(text).toMatch(/process\.env\.PAPERCUSP_EMBED_SIDECAR_MODE\s*===\s*["']1["']/);
      expect(text).toMatch(/runEmbedSidecarServer\s*\(/);
    });
  }
});
