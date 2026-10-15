/**
 * verify-tauri-headless-launch-provenance.test.ts — the RECURRENCE GUARD for
 * EI-20200818150345989.
 *
 * The bug: `tauri-agent-tools probe` exposes healthy bridge PIDs without saying
 * whether a bridge belongs to an agent rig or the owner's live desktop. A peer
 * nearly drove the owner's DISPLAY=:0 window after inferring that an existing
 * bridge was a cheap reusable test rig. The failure was silent and the only
 * protection was another agent noticing the mistake.
 *
 * The fix: verify-tauri-headless.sh requires the tracked caller's PAPERCUSP_SID,
 * stamps it plus a dedicated launch-provenance marker into the child process,
 * matches both values from the target process's own /proc/<pid>/environ, and only
 * then exports VERIFY_TAURI_PID. This text guard pins the handoff wiring without
 * booting a full Tauri/Xvfb stack in the unit suite.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const bridgeBlock = src.match(
  /BRIDGE_PID=""[\s\S]*?export VERIFY_TAURI_PID="\$BRIDGE_PID"/,
)?.[0];

describe('EI-20200818150345989 — verifier bridge handoff carries launch provenance', () => {
  it('guards the intended script and requires a tracked caller identity', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('TAURI_OWNER_SID="${PAPERCUSP_SID:-}"');
    expect(src).toContain('refusing to launch an unattributed Tauri verifier');
  });

  it('stamps both the existing session identity and a dedicated provenance marker', () => {
    expect(src).toContain('PAPERCUSP_SID="$TAURI_OWNER_SID"');
    expect(src).toContain(
      'TAURI_LAUNCH_PROVENANCE="agent:$TAURI_OWNER_SID:run:$(date +%s%N)-$$-$RANDOM"',
    );
    expect(src).toContain(
      'PAPERCUSP_TAURI_LAUNCH_PROVENANCE="$TAURI_LAUNCH_PROVENANCE"',
    );
  });

  it('makes provenance unique per invocation, not merely per long-lived agent session', () => {
    expect(src).not.toContain('TAURI_LAUNCH_PROVENANCE="agent:$TAURI_OWNER_SID"\n');
    expect(src).toMatch(/TAURI_LAUNCH_PROVENANCE=.*:run:.*\$\$/);
  });

  it('requires display, operator port, SID, and provenance from the target process environment', () => {
    expect(bridgeBlock).toBeTruthy();
    expect(bridgeBlock).toContain('DISPLAY=:$DISPLAY_NUM');
    expect(bridgeBlock).toContain('OPERATOR_DEV_PORT=$DEV_PORT');
    expect(bridgeBlock).toContain('PAPERCUSP_SID=$TAURI_OWNER_SID');
    expect(bridgeBlock).toContain(
      'PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$TAURI_LAUNCH_PROVENANCE',
    );
    expect(bridgeBlock).toContain('find_pid_by_env "debug/papercusp-desktop"');
    expect(src).toContain('/proc/$p/environ');
  });

  it('re-checks provenance immediately before exposing the PID', () => {
    expect(bridgeBlock).toContain('BRIDGE_ENVIRON=');
    expect(bridgeBlock).toContain('/proc/$BRIDGE_PID/environ');
    expect(bridgeBlock).toContain('lost the expected launch provenance');
    expect(bridgeBlock).toContain('export VERIFY_TAURI_PID="$BRIDGE_PID"');
  });

  it('exports the verified identity to assertion and --boot-only callers', () => {
    // The ORDERING property is the point and is unchanged: the identity is
    // exported only AFTER the bridge has been verified, i.e. before the
    // --boot-only branch can hand anything to a caller.
    const bridgeExportIdx = src.indexOf(
      'export VERIFY_TAURI_OWNER_SID="$TAURI_OWNER_SID"',
    );
    const bootOnlyIdx = src.indexOf('if [ "${1:-}" = "--boot-only" ]; then');
    const bootOnlyHandoffIdx = src.indexOf('write_boot_only_env_script || exit 1');
    expect(bridgeExportIdx).toBeGreaterThan(-1);
    expect(bridgeExportIdx).toBeLessThan(bootOnlyIdx);
    expect(bootOnlyHandoffIdx).toBeGreaterThan(bootOnlyIdx);

    // EI-20226754912676562 changed the CARRIER, not the property: the verified
    // identity now reaches a --boot-only caller through the private per-run env
    // file instead of a raw export block on shared stdout.
    expect(src).toContain(
      String.raw`printf 'VERIFY_TAURI_OWNER_SID=%q\n' "$VERIFY_TAURI_OWNER_SID"`,
    );
    expect(src).toContain(
      String.raw`printf 'VERIFY_TAURI_LAUNCH_PROVENANCE=%q\n' "$VERIFY_TAURI_LAUNCH_PROVENANCE"`,
    );

    // ...and that carrier re-checks provenance against the TARGET's own environ
    // at source time, because a caller can source a stale/copied path long
    // after this boot completed.
    expect(src).toContain(
      'PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$VERIFY_TAURI_LAUNCH_PROVENANCE',
    );

    // Recurrence guard for the bug that motivated the change: no raw
    // `export VERIFY_TAURI_X=$VERIFY_TAURI_X` block may come back, because a
    // shared stdout log lets one caller reconstruct a PEER's rig identity.
    expect(src).not.toMatch(/export VERIFY_TAURI_[A-Z_]+=\$VERIFY_TAURI_[A-Z_]+/);
  });
});
