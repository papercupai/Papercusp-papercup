/**
 * verify-tauri-headless-gtk-display-recovery.test.ts — the RECURRENCE GUARD for
 * EI-21903832503219853.
 *
 * The bug: the boot-attempt loop already re-picks a fresh PORT pair on an
 * EADDRINUSE bind race (EI-18734124566158657) — but a desktop binary that DIES
 * because its DISPLAY is dead/contended was NOT covered by that mechanism.
 * tao/winit's GTK backend panics with "Failed to initialize gtk backend!"
 * (tao event_loop.rs / gtk rt.rs) when the X server it opened at boot (Xvfb
 * :$DISPLAY_NUM) goes away or gets wedged — most often because a CONCURRENT
 * verifier instance's stale-display reaper raced ours. Before this fix that
 * panic read as a plain "tauri dev exited" (kill -0 failing), and
 * boot_failure_diag fired FATALLY even on attempt 1 of 2 — retrying nothing,
 * on the SAME display that had just proved unusable (a bare process retry
 * there would panic identically, since the display itself, not the tauri
 * binary, is what died).
 *
 * The fix: classify a GTK-init panic via gtk_init_failed() (checked in the
 * SAME position as port_lost_to_squatter, in BOTH wait loops), and on a hit,
 * tear down the dead display's Xvfb/openbox, release its lock, walk DISPLAY_NUM
 * forward, re-pick+re-lock a FRESH display (reusing pick_display()/
 * start_display_server() — the same functions the initial pick uses, factored
 * out for exactly this reuse) AND re-derive+re-lock fresh ports for it (ports
 * are display-derived, WI-4342), then continue the boot loop — before
 * surfacing anything as fatal. Only a SECOND loss (default MAX_BOOT_ATTEMPTS=2)
 * is fatal, with a message naming the display and the fix's own tracking id.
 *
 * A `readFileSync` text guard is the right shape here (same rationale as the
 * sibling verify-tauri-headless-*.test.ts, and its own analogue
 * verify-tauri-headless-bind-retry.test.ts for the port-race sibling fix):
 * the script boots a real Tauri/Xvfb/sidecar stack, so this wiring can only be
 * asserted at the wiring site, not by running it in CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY
// outside the tree (see verify-tauri-headless-bind-retry.test.ts for why this
// seam is load-bearing for falsifiability probes).
const SCRIPT =
  process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

/** Anchor on the counter so deadline preflight before it does not hide the loop. */
function bootLoop(): string {
  const loop = src.match(/\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
  expect(loop, 'the boot-attempt loop must still be findable').toBeTruthy();
  return loop!;
}

describe('EI-21903832503219853 — verify-tauri-headless re-picks a fresh display (not just a fresh port) on a GTK-init panic', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
  });

  it('factors display pick + Xvfb/openbox startup into reusable functions, called once at the initial pick', () => {
    const pickFn = src.match(/pick_display\(\) \{([\s\S]*?)\n\}/)?.[1];
    const startFn = src.match(/start_display_server\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(pickFn, 'pick_display() must exist').toBeTruthy();
    expect(startFn, 'start_display_server() must exist').toBeTruthy();
    expect(pickFn).toMatch(/reserve_display "\$DISPLAY_NUM"/);
    // Launch in the owning shell so process/cgroup bookkeeping survives;
    // command substitution would run it in a subshell and lose that state.
    expect(startFn).toMatch(/start_verify_process "\$\{VERIFY_SCOPE_BASE\}-xvfb"/);
    expect(startFn).toContain('XVFB_PID="$VERIFY_STARTED_PROCESS_PID"');
    expect(startFn).toMatch(/start_verify_process "\$\{VERIFY_SCOPE_BASE\}-openbox"/);
    expect(startFn).toContain('OPENBOX_PID="$VERIFY_STARTED_PROCESS_PID"');
    // Each is called exactly once at the ORIGINAL (non-retry) call site — one
    // procedure, two call sites (the second being the retry branch below), not
    // a duplicated copy.
    expect(src.match(/\npick_display\n/g)?.length).toBe(1);
    expect(src.match(/\nstart_display_server\n/g)?.length).toBe(1);
  });

  it('the EXIT/signal traps are armed BEFORE the first start_display_server call, so a mid-startup failure still tears down', () => {
    const trapIdx = src.indexOf('trap teardown EXIT');
    const firstCallIdx = src.indexOf('\nstart_display_server\n');
    expect(trapIdx).toBeGreaterThan(-1);
    expect(firstCallIdx).toBeGreaterThan(-1);
    expect(trapIdx).toBeLessThan(firstCallIdx);
  });

  it('classifies a GTK-init panic via a dedicated detector, read from $LOG at call time (stays correct after a re-pick)', () => {
    const fn = src.match(/gtk_init_failed\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn, 'gtk_init_failed() must exist').toBeTruthy();
    expect(fn).toMatch(/"\$LOG"/);

    // Behavioural proof against a REAL panic line (tao/winit's actual message)
    // and a red herring, so this cannot pass on a regex that merely looks
    // plausible — mirrors port_lost_to_squatter's own calibration test.
    const re = new RegExp(fn!.match(/grep -qE "([^"]+)"/)![1]);
    expect(
      re.test('thread \'main\' panicked at src/main.rs:12:5:\nFailed to initialize gtk backend!'),
      'the real tao/winit GTK-init panic line must trip the detector',
    ).toBe(true);
    expect(
      re.test('   0: gtk::rt::init'),
      'a gtk::rt::init backtrace frame must also trip the detector',
    ).toBe(true);
    expect(
      re.test('Running `target/debug/papercusp-desktop`'),
      'an ordinary boot line must NOT trip the detector',
    ).toBe(false);
    expect(
      re.test('[hono-host] fatal uncaughtException — exiting: Error: listen EADDRINUSE'),
      'a port-race fatal must NOT trip the display detector (they are classified independently)',
    ).toBe(false);
  });

  it('checks gtk_init_failed in the SAME position as port_lost_to_squatter, in BOTH wait loops', () => {
    const loop = bootLoop();

    // Loop 1: the attempt-start wait for the desktop binary to start.
    const startWait = loop.match(/until desktop_binary_started; do([\s\S]*?)\n {2}done/)?.[1];
    expect(startWait, 'the desktop-binary-start wait loop must still be findable').toBeTruthy();
    const portIdx1 = startWait!.indexOf('if port_lost_to_squatter; then PORT_LOST=1; break; fi');
    const gtkIdx1 = startWait!.indexOf('if gtk_init_failed; then DISPLAY_LOST=1; break; fi');
    const killIdx1 = startWait!.indexOf('kill -0 "$TAURI_PID"');
    expect(portIdx1).toBeGreaterThan(-1);
    expect(gtkIdx1).toBeGreaterThan(-1);
    expect(killIdx1).toBeGreaterThan(-1);
    // Both classifiers precede the kill -0 fatal probe, so a desktop binary
    // that died OF either cause routes to a re-pick instead of the
    // unconditional boot_failure_diag fatal.
    expect(gtkIdx1).toBeLessThan(killIdx1);
    expect(portIdx1).toBeLessThan(killIdx1);

    // Loop 2: the bridge wait, after the desktop binary has started.
    const bridgeWait = loop.match(/until grep -q "dev bridge listening"[\s\S]*?\n {4}done/)?.[0];
    expect(bridgeWait, 'the dev-bridge wait loop must still be findable').toBeTruthy();
    const portIdx2 = bridgeWait!.indexOf('if port_lost_to_squatter; then PORT_LOST=1; break; fi');
    const gtkIdx2 = bridgeWait!.indexOf('if gtk_init_failed; then DISPLAY_LOST=1; break; fi');
    const killIdx2 = bridgeWait!.indexOf('kill -0 "$TAURI_PID"');
    expect(portIdx2).toBeGreaterThan(-1);
    expect(gtkIdx2).toBeGreaterThan(-1);
    expect(killIdx2).toBeGreaterThan(-1);
    expect(gtkIdx2).toBeLessThan(killIdx2);
    expect(portIdx2).toBeLessThan(killIdx2);
  });

  it('DISPLAY_LOST=0 is (re-)initialized once per attempt, alongside PORT_LOST', () => {
    const loop = bootLoop();
    expect(loop).toMatch(/PORT_LOST=0\n\s*DISPLAY_LOST=0/);
  });

  it('on a GTK-init panic with attempts remaining: tears down the dead display, re-picks display AND ports, and CONTINUES (never exits)', () => {
    const loop = bootLoop();
    const retryBranch = loop.match(
      /if \[ "\$BOOT_ATTEMPTS" -lt "\$MAX_BOOT_ATTEMPTS" \]; then([\s\S]*?)\n {2}fi/,
    )?.[1];
    expect(retryBranch, 'the shared retry-budget branch must still be findable').toBeTruthy();

    const displayBranch = retryBranch!.match(/if \[ "\$DISPLAY_LOST" = 1 \]; then([\s\S]*?)\n {4}else\n/)?.[1];
    expect(displayBranch, 'a DISPLAY_LOST-specific sub-branch must exist inside the retry branch').toBeTruthy();

    // Tears down the dead display's own processes and releases its lock —
    // never leaves a stale Xvfb/openbox/lock behind for the display it is
    // abandoning.
    expect(displayBranch).toMatch(/kill -9 \$OPENBOX_PID/);
    expect(displayBranch).toContain('write_xvfb_stop_script');
    expect(displayBranch).toContain('"$WORK/stop-xvfb.sh"');
    expect(displayBranch).not.toMatch(/pkill\s+-9\s+-f\s+"Xvfb/);
    expect(displayBranch).not.toContain('rm -f "/tmp/.X11-unix/X$DISPLAY_NUM"');
    expect(displayBranch).not.toContain('"/tmp/.X$DISPLAY_NUM-lock"');
    expect(displayBranch).toMatch(/display_lock_release/);
    expect(displayBranch).toMatch(/fed_release_port_locks/);

    // Walks DISPLAY_NUM forward and re-runs the SAME pick+start procedure the
    // initial pick used — never retries against the display that just proved
    // dead/contended.
    expect(displayBranch).toMatch(/DISPLAY_NUM=\$\(\(DISPLAY_NUM \+ 1\)\)/);
    expect(displayBranch).toMatch(/\bpick_display\b/);
    expect(displayBranch).toMatch(/\bstart_display_server\b/);

    // Ports are display-derived (WI-4342) — a display re-pick must re-derive
    // AND re-lock fresh ports for the NEW display, not keep stale ones.
    expect(displayBranch).toMatch(/\bpick_and_lock_ports\b/);

    // The retry path must never itself exit — only the post-retry-budget
    // fatal below does. `continue` is the last statement in the captured
    // branch (right before the shared `\n  fi` that closes it).
    expect(retryBranch).toMatch(/\n {4}continue$/);
    expect(displayBranch).not.toMatch(/exit 1/);

    // The port-race sub-branch (the pre-existing sibling fix) must still be
    // present and untouched — the two causes are handled by distinct arms,
    // not merged into one.
    const portBranch = retryBranch!.match(/\n {4}else\n([\s\S]*?)\n {4}fi\n/)?.[1];
    expect(portBranch, 'the port-race else-branch must still be findable').toBeTruthy();
    expect(portBranch).toMatch(/EADDRINUSE racing/);
    expect(portBranch).toMatch(/PORT_BASE=\$\(\(DEV_PORT \+ 1\)\)/);
    expect(portBranch).not.toMatch(/DISPLAY_NUM=\$\(\(DISPLAY_NUM \+ 1\)\)/);
  });

  it('only surfaces fatal once the retry budget is exhausted, with a distinct GTK-panic message naming the fix', () => {
    const loop = bootLoop();
    expect(loop).toMatch(/FATAL: desktop binary panicked on gtk::rt::init/);
    expect(loop).toMatch(/attempt\(s\) across freshly-picked displays/);
    expect(loop).toMatch(/EI-21903832503219853/);
    const fatalIdx = loop.indexOf('FATAL: desktop binary panicked on gtk::rt::init');
    const exitIdx = loop.indexOf('exit 1', fatalIdx);
    expect(fatalIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(fatalIdx);

    // The GTK-panic fatal branch must be reached BEFORE the pre-existing
    // port-race fatal — they are mutually exclusive causes and the DISPLAY_LOST
    // check must not fall through to the (wrong) port-race FATAL message.
    const portFatalIdx = loop.indexOf('FATAL: our operator sidecar could not bind');
    expect(portFatalIdx).toBeGreaterThan(-1);
    expect(fatalIdx).toBeLessThan(portFatalIdx);
  });

  it('a clean boot (no GTK panic) is unaffected — DISPLAY_LOST stays 0 and the existing PORT_LOST branch selection is preserved', () => {
    const loop = bootLoop();
    // The two-cause selector at the top of the shared post-loop handling.
    expect(loop).toMatch(
      /if \[ "\$DISPLAY_LOST" = 1 \]; then\n\s*log "desktop binary PANICKED on gtk::rt::init/,
    );
    expect(loop).toMatch(/elif \[ "\$PORT_LOST" = 1 \]; then/);
    // The bridge-wait entry gate now excludes BOTH loss causes, not just the port one.
    expect(loop).toMatch(/if \[ "\$PORT_LOST" = 0 \] && \[ "\$DISPLAY_LOST" = 0 \]; then/);
  });
});
