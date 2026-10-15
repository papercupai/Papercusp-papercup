/**
 * P-531 (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005523): re-launching
 * an embed sidecar that exited on idle.
 *
 * The sidecar announces an idle exit on stdout and then shuts down. Two
 * properties are pinned here with a FAKE child process (no real spawn, no
 * model load, no socket):
 *  1. an ensure that arrives DURING that shutdown window must not be handed the
 *     closing sidecar's URL — it waits, the exit triggers an immediate
 *     re-launch, and it resolves once the NEW child is ready;
 *  2. the wiring passes the per-attempt ensure hook only for a sidecar this
 *     process spawns, never for an explicit URL another process supervises.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeChild = import('node:events').EventEmitter & {
  stdout: import('node:events').EventEmitter;
  stderr: import('node:events').EventEmitter;
  killed: boolean;
};

const fake = vi.hoisted(() => ({ children: [] as FakeChild[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = Object.assign(new Emitter(), {
        stdout: new Emitter(),
        stderr: new Emitter(),
        killed: false,
        kill(this: { killed: boolean }) {
          this.killed = true;
          return true;
        },
      });
      fake.children.push(child);
      return child;
    }),
  };
});

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EMBED_SIDECAR_IDLE_EXIT_LINE, EMBED_SIDECAR_READY_LINE } from './embed-sidecar-server';
import {
  _resetEmbedSidecarSpawnStateForTests,
  EMBED_SIDECAR_ENABLE_ENV,
  embedSidecarLocalUrl,
  ensureEmbedSidecar,
  isEmbedSidecarReady,
  spawnEmbedSidecar,
} from './embed-sidecar-spawn';
import { localSidecarEnsure, type SidecarWiringDeps } from './embed-sidecar-wiring';

function say(child: FakeChild, line: string): void {
  child.stdout.emit('data', Buffer.from(`${line}\n`));
}

describe('ensureEmbedSidecar during an announced idle exit (P-531)', () => {
  const savedEnable = process.env[EMBED_SIDECAR_ENABLE_ENV];
  const savedPort = process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
  const savedHome = process.env.PAPERCUSP_HOME;
  let home: string;

  beforeEach(() => {
    fake.children.length = 0;
    vi.mocked(spawn).mockClear();
    _resetEmbedSidecarSpawnStateForTests();
    process.env[EMBED_SIDECAR_ENABLE_ENV] = '1';
    // P-530 ephemeral-port mode, with a private data dir so no real record is read.
    delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    home = mkdtempSync(path.join(tmpdir(), 'p531-idle-'));
    process.env.PAPERCUSP_HOME = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    _resetEmbedSidecarSpawnStateForTests();
    for (const [k, v] of [
      [EMBED_SIDECAR_ENABLE_ENV, savedEnable],
      ['PAPERCUSP_EMBED_SIDECAR_PORT', savedPort],
      ['PAPERCUSP_HOME', savedHome],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('waits for the re-launched child instead of returning the closing one', async () => {
    const first = spawnEmbedSidecar();
    expect(fake.children).toHaveLength(1);
    say(fake.children[0], `${EMBED_SIDECAR_READY_LINE} port=41001`);
    await first;
    expect(isEmbedSidecarReady()).toBe(true);

    // The child announces its idle exit but has not exited yet.
    say(fake.children[0], EMBED_SIDECAR_IDLE_EXIT_LINE);
    expect(isEmbedSidecarReady()).toBe(false);

    let resolved: string | null | undefined;
    const pending = ensureEmbedSidecar(['embed']).then((u) => {
      resolved = u;
      return u;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBeUndefined(); // parked, NOT handed the closing sidecar
    expect(fake.children).toHaveLength(1);

    // The announced clean exit: no crash-respawn, but the parked caller
    // triggers an immediate re-launch.
    fake.children[0].emit('exit', 0);
    expect(fake.children).toHaveLength(2);
    expect(resolved).toBeUndefined();

    // P-530: the re-launched child binds a NEW ephemeral port; the caller is
    // handed that one, never the closed child's.
    say(fake.children[1], `${EMBED_SIDECAR_READY_LINE} port=41002`);
    await expect(pending).resolves.toBe('http://127.0.0.1:41002');
    expect(embedSidecarLocalUrl()).toBe('http://127.0.0.1:41002');
    expect(isEmbedSidecarReady()).toBe(true);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('an idle exit with nobody waiting does not re-launch; the next ensure does', async () => {
    const first = spawnEmbedSidecar();
    say(fake.children[0], `${EMBED_SIDECAR_READY_LINE} port=41001`);
    await first;
    say(fake.children[0], EMBED_SIDECAR_IDLE_EXIT_LINE);
    fake.children[0].emit('exit', 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.children).toHaveLength(1); // stays down: that is the memory saving
    expect(embedSidecarLocalUrl()).toBeNull(); // P-530: no address while it is down

    // The sidecar is gone, so a running check fails. P-530: with no explicit
    // port there is no shared port to probe and no record (PAPERCUSP_HOME is a
    // fresh temp dir), so ensure spawns without touching any real sidecar.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const pending = ensureEmbedSidecar(['embed']);
    await vi.waitFor(() => expect(fake.children).toHaveLength(2));
    say(fake.children[1], `${EMBED_SIDECAR_READY_LINE} port=41003`);
    await expect(pending).resolves.toBe('http://127.0.0.1:41003');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('localSidecarEnsure (wiring, P-531)', () => {
  const deps = (explicit: string | null): SidecarWiringDeps & { ensure: ReturnType<typeof vi.fn> } => ({
    resolveUrl: () => explicit,
    ensure: vi.fn(async () => 'http://127.0.0.1:3384'),
    probeHealth: async () => null,
  });

  it('returns a hook that re-ensures the local sidecar with the caller capability', async () => {
    const d = deps(null);
    const hook = localSidecarEnsure(d, 'http://127.0.0.1:3384', 'rerank');
    expect(hook).toBeTypeOf('function');
    await hook!();
    expect(d.ensure).toHaveBeenCalledWith(['rerank']);
  });

  it('returns no hook for an explicit URL (that sidecar is supervised elsewhere)', () => {
    expect(localSidecarEnsure(deps('http://10.0.0.5:3384'), 'http://10.0.0.5:3384', 'embed')).toBeUndefined();
  });

  it('returns no hook when no sidecar is in play (pure in-process)', () => {
    expect(localSidecarEnsure(deps(null), null, 'embed', () => false)).toBeUndefined();
  });

  // WI-10005932: a null URL with the local sidecar ENABLED is a sidecar whose
  // start timed out, not "no sidecar". It must still get the hook, or the
  // client builds the model in-process in the main Server (P-532d pct3).
  it('returns a hook for a null URL when the local sidecar is enabled', async () => {
    const d = deps(null);
    const hook = localSidecarEnsure(d, null, 'embed', () => true);
    expect(hook).toBeTypeOf('function');
    await expect(hook!()).resolves.toBe('http://127.0.0.1:3384');
    expect(d.ensure).toHaveBeenCalledWith(['embed']);
  });

  it('an explicit URL still wins over an enabled local sidecar', () => {
    expect(localSidecarEnsure(deps('http://10.0.0.5:3384'), null, 'embed', () => true)).toBeUndefined();
  });
});
