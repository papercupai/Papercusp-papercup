/**
 * verify-tauri-headless-display-reservation.test.ts — the recurrence guard for
 * EI-21617008171422271.
 *
 * The bug: concurrent verifier launchers could both probe the same free Xvfb
 * display before either one started it. They then reserved distinct ports but
 * initialized GTK against the same DISPLAY, producing intermittent
 * "Failed to initialize GTK" panics. The fix is a per-display flock acquired
 * before the final taken check and held until normal teardown or the
 * --boot-only keeper has released the display and its derived ports.
 *
 * This is intentionally a static wiring guard: exercising two full Tauri
 * boots would be too expensive and environment-dependent for the unit suite,
 * while the race-prevention properties are the ordering and lifetime
 * invariants checked below.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-21617008171422271 — verify-tauri-headless atomically reserves displays', () => {
  it('uses a per-display flock and rechecks occupancy while holding it', () => {
    expect(src).toContain(
      'TAURI_VERIFIER_LOCK_ROOT="${XDG_RUNTIME_DIR:-${HOME:-/tmp}/.cache}/papercusp-tauri-verifier"',
    );
    expect(src).toContain(
      'DISPLAY_LOCK_DIR="${VERIFY_TAURI_DISPLAY_LOCK_DIR:-$TAURI_VERIFIER_LOCK_ROOT/display-locks}"',
    );
    expect(src).toMatch(/path="\$DISPLAY_LOCK_DIR\/display-\$n\.lock"/);
    expect(src).toContain('flock -n "$fd"');

    const start = src.indexOf('reserve_display() {');
    const end = src.indexOf('\n}\n\nDISPLAY_NUM=', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const reservation = src.slice(start, end);
    expect(reservation.indexOf('display_lock_try_acquire "$n"')).toBeGreaterThan(-1);
    expect(reservation.indexOf('display_lock_try_acquire "$n"')).toBeLessThan(
      reservation.indexOf('if x_display_taken "$n"'),
    );
    expect(reservation).toContain('display_lock_release');
  });

  it('routes both auto-picked and forced displays through the reservation', () => {
    // EI-21903832503219853: the walk-forward+reserve loop was factored into a
    // `pick_display()` function (so the GTK-init-panic retry can call the SAME
    // logic on a freshly re-picked display) — the "too close to a real seat"
    // guard moved INSIDE that function so a retry-path re-pick inherits it too,
    // so the region now ends at the function's closing brace + its call site
    // rather than at the (now-indented) guard line itself. The phase-timing
    // instrumentation may put `vh_step <phase>` marker lines between the closing
    // brace and the call site; they do not change the picker region.
    const start = src.indexOf('DISPLAY_NUM="${VERIFY_TAURI_DISPLAY_NUM:-}"');
    const callSite = /\n}\n(?:vh_step [\w-]+\n)*pick_display\n/g;
    callSite.lastIndex = Math.max(start, 0);
    const end = callSite.exec(src)?.index ?? -1;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const picker = src.slice(start, end);
    expect(picker).toContain('DISPLAY_AUTO_PICK=1');
    expect(picker).toContain('reserve_display "$DISPLAY_NUM"');
    expect(picker).toContain('DISPLAY_NUM=$((DISPLAY_NUM + 1))');
    expect(picker).toContain('DISPLAY_AUTO_PICK=0');
    expect(picker).toContain('[ "$DISPLAY_NUM" -ge 2 ]');
  });

  it('releases the reservation only after normal teardown has drained ports', () => {
    const start = src.indexOf('teardown() {');
    const end = src.indexOf('\n}\n\nverify_assertion_input_integrity', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const teardown = src.slice(start, end);
    expect(teardown.indexOf('wait_owned_ports_free')).toBeLessThan(
      teardown.indexOf('fed_release_port_locks'),
    );
    expect(teardown.indexOf('fed_release_port_locks')).toBeLessThan(
      teardown.indexOf('display_lock_release'),
    );
  });

  it('--boot-only transfers the display reservation to its keeper', () => {
    const keeperStart = src.indexOf('( trap - EXIT INT TERM\n    while kill -0 "$XVFB_PID"');
    const keeperEnd = src.indexOf('\n  PORT_LOCK_KEEPER_PID=$!', keeperStart);
    expect(keeperStart).toBeGreaterThan(-1);
    expect(keeperEnd).toBeGreaterThan(keeperStart);
    const keeper = src.slice(keeperStart, keeperEnd);
    expect(keeper).toContain('while kill -0 "$XVFB_PID" 2>/dev/null; do sleep 2; done');
    expect(keeper.indexOf('wait_owned_ports_free')).toBeGreaterThan(-1);
    expect(keeper.indexOf('wait_owned_ports_free')).toBeLessThan(
      keeper.indexOf('display_lock_release'),
    );
  });
});
