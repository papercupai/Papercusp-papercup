/**
 * verify-tauri-headless-memory-watchdog.test.ts — the RECURRENCE GUARD for EI-11641.
 *
 * The bug: scripts/verify-tauri-headless.sh boots an isolated desktop instance
 * whose operator sidecar (via papercusp-desktop/bin/dev-operator-ifneeded.sh)
 * runs with PAPERCUSP_BACKGROUND_WORKERS=0 yet still boots the full operator
 * (substrate + the DBOS routines tick). Its FRESH-boot RSS is therefore
 * background-primary-sized (~3.3 GB observed), but resolveMemoryWatchdogLimitMb()
 * (memory-watchdog.ts) mis-sizes a BG=0 host to the 3200 MiB REQUEST-worker
 * limit — BELOW that boot RSS. The memory-watchdog then recycled the sidecar
 * every ~60 s in a perpetual loop; the webview's backend churned and the
 * tauri-agent-tools bridge wedged (every eval timed out), making live UI
 * verification impossible on a loaded box.
 *
 * The fix: the verify launch env pins PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB to the
 * background-primary limit (the sidecar's real footprint), which
 * resolveMemoryWatchdogLimitMb() honours as an explicit override — a genuine
 * runaway still recycles, a normal substrate boot never does.
 *
 * A `readFileSync` text guard is the right shape here (same rationale as the
 * sibling verify-tauri-headless-spa-isolation.test.ts): the script boots a real
 * Tauri/Xvfb stack, so its launch-env wiring can only be asserted at the wiring
 * site, not by running it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND,
  MEMORY_WATCHDOG_LIMIT_MB_REQUEST,
} from '@papercusp/operator-core/lib/memory-watchdog';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const DEV_HOST_SCRIPT = resolve(__dirname, '../../../papercusp-desktop/bin/dev-operator-ifneeded.sh');
const devHostSrc = readFileSync(DEV_HOST_SCRIPT, 'utf8');

describe('EI-11641 — verify-tauri-headless exempts the isolated sidecar from the 3200 MiB request-worker limit', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    // The sidecar this exemption targets is booted with BG=0, so the role-aware
    // default would otherwise pick the request limit — that is the whole premise.
    expect(src).toContain('PAPERCUSP_DEV_API_TARGET="$DEV_PORT"');
  });

  it('pins PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB into the launched instance env', () => {
    // The pin must reach the launched instance's env (it propagates ambient
    // through dev-operator-ifneeded.sh → hono-host.ts). Without it the sidecar's
    // resolveMemoryWatchdogLimitMb() falls through to the 3200 request default.
    expect(src).toMatch(/PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=\$MEMORY_LIMIT_MB/);
  });

  it('defaults the limit to the background-primary footprint, not the request limit', () => {
    // The default must be the substrate-sized background limit — high enough that a
    // fresh boot (~3.3 GB) never trips it.
    expect(src).toMatch(
      new RegExp(`MEMORY_LIMIT_MB="\\$\\{VERIFY_TAURI_MEMORY_LIMIT_MB:-${MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND}\\}"`),
    );
    // Sanity-anchor the constants so a change to either surfaces here.
    expect(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND).toBe(12288);
    expect(MEMORY_WATCHDOG_LIMIT_MB_REQUEST).toBe(3200);
  });

  it('NEVER pins the sidecar back at the 3200 request limit its own boot exceeds (the non-fix)', () => {
    // Pinning the limit to the request value it already exceeds re-introduces the
    // perpetual recycle loop — the exact bug. The literal default must not be it.
    expect(src).not.toMatch(
      new RegExp(`MEMORY_LIMIT_MB="\\$\\{VERIFY_TAURI_MEMORY_LIMIT_MB:-${MEMORY_WATCHDOG_LIMIT_MB_REQUEST}\\}"`),
    );
    expect(src).not.toMatch(/PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=3200/);
  });

  it('lets the operator override the limit via VERIFY_TAURI_MEMORY_LIMIT_MB', () => {
    expect(src).toMatch(/MEMORY_LIMIT_MB="\$\{VERIFY_TAURI_MEMORY_LIMIT_MB:-\d+\}"/);
  });

  it('refuses an isolated source root that would silently fall back to the unbundled tsx host', () => {
    const sourceRootGuard = devHostSrc.match(
      /if \[ -n "\$DEV_SOURCE_ROOT" \] && \[ -z "\$DEV_HOST_ENTRY" \]; then([\s\S]*?)\nfi/,
    )?.[1];
    expect(sourceRootGuard).toBeTruthy();
    expect(sourceRootGuard).toContain('PAPERCUSP_DEV_HOST_ENTRY');
    expect(sourceRootGuard).toContain('apps/operator/bin/bundle-host.sh');
    expect(sourceRootGuard).toMatch(/exit 1/);
  });
});
