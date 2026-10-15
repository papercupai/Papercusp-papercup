/**
 * Unit tests for ensureOmpSuInstalled (ensure-omp-su.ts) — its OWN logic.
 *
 * The sibling ensure-omp-su.test.ts only asserts the retired-wrapper
 * behavior. This file covers the parts the prompt calls out as untested:
 *   - the single-flight cache returns the SAME promise across concurrent
 *     calls, and HOLDS the cache even when the cached run rejects (a
 *     transient failure must NOT cause the next launch to re-spend ~5s)
 *   - the non-Linux guard early-returns (no bootstrap / no shellouts)
 *   - OMP config is delegated to the canonical integration, with no duplicate
 *     direct `execFile('omp', ...)` child from this bootstrap helper
 *
 * Hermetic: child_process (execSync/execFile) + fs + os + the two
 * desktop-install leaves are all mocked; nothing spawns or touches the
 * real home. `process.platform` is overridden per-test (it's read-only, so
 * via Object.defineProperty) and restored after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome = '';
const realPlatform = process.platform;
const realPath = process.env.PATH;

/** Override the read-only process.platform for one test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

const execFileSpy = vi.fn();
const installPapercuspFilesSpy = vi.fn(async () => ({ playbookWritten: true, extensionWritten: true }));
const installOmpIntegrationSpy = vi.fn(async () => ({ changed: false, actions: [], reason: undefined }));
// Holder so a single os mock can be flipped to throw from homedir() per-test
// after the bootstrap installer has actually run (the rejection-hold case) —
// no per-test re-mock, so nothing leaks.
const homeState = { throwAfterInstall: false };

beforeEach(() => {
  vi.resetModules();
  execFileSpy.mockReset();
  installPapercuspFilesSpy.mockClear();
  installOmpIntegrationSpy.mockClear();
  homeState.throwAfterInstall = false;
  tmpHome = mkdtempSync(join(tmpdir(), 'ensure-omp-su-cache-'));

  // Plant a stub OMP path so bootstrap-state resolution is deterministic. The
  // execFile spy below catches any direct OMP config child if this helper grows
  // a duplicate shellout again.
  mkdirSync(join(tmpHome, 'bin'), { recursive: true });
  writeFileSync(join(tmpHome, 'bin', 'omp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(tmpHome, 'bin', 'omp-su'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${join(tmpHome, 'bin')}:${realPath ?? ''}`;

  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...actual,
      homedir: () => {
        if (homeState.throwAfterInstall && installPapercuspFilesSpy.mock.calls.length > 0) {
          throw new Error('home blown up');
        }
        return tmpHome;
      },
    };
  });
  // A reintroduced direct OMP config child is recorded but never spawned.
  vi.doMock('node:child_process', () => ({
    execFile: (...args: unknown[]) => {
      execFileSpy(...args);
      const callback = args.at(-1) as (error: Error | null) => void;
      queueMicrotask(() => callback(null));
    },
  }));
  // Partial mock (see ensure-omp-su.test.ts): keep the real pure
  // resolveInstallPaths; stub only the fs-writing installer.
  vi.doMock('./desktop-install/papercusp-files', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./desktop-install/papercusp-files')>();
    return {
      ...actual,
      installPapercuspFiles: installPapercuspFilesSpy,
    };
  });
  vi.doMock('./desktop-install/omp-integration', () => ({
    installOmpIntegration: installOmpIntegrationSpy,
  }));
});

afterEach(() => {
  setPlatform(realPlatform);
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  vi.doUnmock('node:os');
  vi.doUnmock('node:child_process');
  vi.doUnmock('./desktop-install/papercusp-files');
  vi.doUnmock('./desktop-install/omp-integration');
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensureOmpSuInstalled — single-flight cache', () => {
  it('single-flights concurrent + repeat calls — the heavy work runs exactly once', async () => {
    setPlatform('linux');
    const mod = await import('./ensure-omp-su');

    // Two concurrent callers + a third after settle. (ensureOmpSuInstalled is
    // an `async` function, so each call returns a fresh promise wrapping the
    // cached one — identity differs by design; the contract is that the heavy
    // work behind the cache runs ONCE, which we assert by side-effect.)
    const p1 = mod.ensureOmpSuInstalled();
    const p2 = mod.ensureOmpSuInstalled();
    await Promise.all([p1, p2]);

    // The heavy bootstrap + canonical OMP integration ran once despite two
    // concurrent callers. This also guards against restoring a second direct
    // `execFile('omp', ...)` config sequence here.
    expect(installPapercuspFilesSpy).toHaveBeenCalledTimes(1);
    expect(installOmpIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy).not.toHaveBeenCalled();

    // A THIRD call after settle still reuses the cache (no re-run).
    await mod.ensureOmpSuInstalled();
    expect(installPapercuspFilesSpy).toHaveBeenCalledTimes(1);
    expect(installOmpIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('HOLDS the cache on rejection — a failing run is not retried by the next call', async () => {
    setPlatform('linux');
    // Force the cached run to REJECT after the heavy bootstrap: homedir() (the
    // default arg of readEngineerOmpBootstrapState, called unguarded at the
    // tail of the IIFE) throws via the per-test holder flag.
    homeState.throwAfterInstall = true;
    const mod = await import('./ensure-omp-su');

    const p1 = mod.ensureOmpSuInstalled();
    // Swallow the floating cached rejection up-front so vitest's
    // unhandled-rejection guard doesn't flag it before assertions attach.
    p1.catch(() => {});
    await expect(p1).rejects.toThrow('home blown up');

    // The next call re-exposes the SAME held (rejected) cache — it does NOT
    // re-run the work. (Identity differs — async fn — so we assert by the
    // rejection + the unchanged side-effect count.)
    const p2 = mod.ensureOmpSuInstalled();
    p2.catch(() => {});
    await expect(p2).rejects.toThrow('home blown up');
    // The heavy bootstrap still ran exactly once (the held, failed run);
    // the second call did NOT re-invoke it.
    expect(installPapercuspFilesSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ensureOmpSuInstalled — platform guard', () => {
  it('non-Linux: early-returns without bootstrapping or shelling out', async () => {
    setPlatform('darwin');
    const mod = await import('./ensure-omp-su');

    await mod.ensureOmpSuInstalled();

    expect(installPapercuspFilesSpy).not.toHaveBeenCalled();
    expect(installOmpIntegrationSpy).not.toHaveBeenCalled();
    expect(execFileSpy).not.toHaveBeenCalled();
  });
});

describe('ensureOmpSuInstalled — OMP integration ownership', () => {
  it('delegates OMP configuration to the canonical integration without a duplicate child sequence', async () => {
    setPlatform('linux');
    const mod = await import('./ensure-omp-su');

    await mod.ensureOmpSuInstalled();

    expect(installOmpIntegrationSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy).not.toHaveBeenCalled();
  });
});
