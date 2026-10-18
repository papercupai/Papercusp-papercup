/**
 * EI-20226754912676562 — the --boot-only handoff must not be a shared-log
 * export block.
 *
 * Two concurrent callers can redirect stdout to the same path.  Printing raw
 * `export VERIFY_TAURI_*` lines there lets a tail/source workflow import a
 * peer's live bridge PID, port, display, and stop script.  The recurrence
 * guard pins the safer contract: a private per-run env file plus an ownership
 * check against both the current caller and the target process.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const bootOnlyBranch = src.match(
  /if \[ "\$\{1:-\}" = "--boot-only" \]; then([\s\S]*?)\nfi/,
)?.[1];

describe('EI-20226754912676562 — --boot-only handoff is per-run and owner-verified', () => {
  it('writes a private per-run env file before returning control', () => {
    expect(bootOnlyBranch).toBeTruthy();
    expect(src).toContain('BOOT_ONLY_ENV="$WORK/env.sh"');
    expect(bootOnlyBranch).toContain('write_boot_only_env_script');
    expect(src).toContain('chmod 600 "$BOOT_ONLY_ENV"');
  });

  it('prints a source command for the unique env file, not raw exports to a shared log', () => {
    expect(bootOnlyBranch).toBeTruthy();
    expect(bootOnlyBranch).toContain('printf \'source %q\\n\' "$BOOT_ONLY_ENV"');
    expect(bootOnlyBranch).not.toContain('export VERIFY_TAURI_PID=$VERIFY_TAURI_PID');
    expect(bootOnlyBranch).not.toContain('export VERIFY_TAURI_STOP=$WORK/stop.sh');
  });

  it('re-checks both caller identity and target-process provenance when sourced', () => {
    expect(src).toContain('PAPERCUSP_SID=${PAPERCUSP_SID:-}');
    expect(src).toContain('/proc/$VERIFY_TAURI_PID/environ');
    expect(src).toContain('PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$VERIFY_TAURI_LAUNCH_PROVENANCE');
    expect(src).toContain('VERIFY_TAURI_ENV_FILE points at a verifier owned by another session');
    expect(src).toContain('verify_tauri_assert_owned');
  });
});

/**
 * WI-6554700010017687 — the env file must load in a plain caller shell.
 *
 * Its body is a literal heredoc that runs in the CALLER's shell, where none
 * of the verifier's vh_* helpers exist. A source-text pin cannot see that
 * boundary (a mechanical vh_run_step rename passed every pin and made
 * `source env.sh` exit 127 for nine days), so this sources the real body in
 * `bash --noprofile --norc` against a live target process.
 */
const ENV_BODY = src.match(
  /cat <<'BOOT_ONLY_ENV_SCRIPT'\n([\s\S]*?)\nBOOT_ONLY_ENV_SCRIPT\n/,
)?.[1];

describe.skipIf(process.platform !== 'linux')(
  'WI-6554700010017687 — the --boot-only env file loads in a caller shell',
  () => {
    const OWNER = 'su-wi17687-owner';
    const DISPLAY = ':977';
    const PORT = '45977';
    const PROVENANCE = 'wi17687-provenance';
    let target: ChildProcess;
    let dir: string;
    let envFile: string;

    beforeAll(() => {
      // The "bridge" whose /proc/<pid>/environ the ownership check reads.
      target = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
        env: {
          DISPLAY,
          OPERATOR_DEV_PORT: PORT,
          PAPERCUSP_SID: OWNER,
          PAPERCUSP_TAURI_LAUNCH_PROVENANCE: PROVENANCE,
        },
        stdio: 'ignore',
      });
      dir = mkdtempSync(join(tmpdir(), 'wi17687-'));
      envFile = join(dir, 'env.sh');
      const bin = process.execPath;
      const header = [
        `VERIFY_TAURI_PID=${target.pid}`,
        `VERIFY_TAURI_PORT=${PORT}`,
        `VERIFY_TAURI_DISPLAY=${DISPLAY}`,
        `VERIFY_TAURI_OWNER_SID=${OWNER}`,
        `VERIFY_TAURI_LAUNCH_PROVENANCE=${PROVENANCE}`,
        `VERIFY_TAURI_AGENT_TOOLS_BIN=${bin}`,
        `VERIFY_TAURI_AGENT_TOOLS_BIN_DIR=${dirname(bin)}`,
        `VERIFY_TAURI_CARGO_BIN=${bin}`,
        `VERIFY_TAURI_CARGO_BIN_DIR=${dirname(bin)}`,
      ].join('\n');
      writeFileSync(envFile, `${header}\n${ENV_BODY ?? ''}\n`);
    });

    afterAll(() => {
      target?.kill('SIGKILL');
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function sourceAs(sid: string) {
      // No vh_* helper is defined here: this is exactly the caller's shell.
      const script = [
        'source "$1"; rc=$?',
        'echo "RC=$rc"',
        'echo "VH=$(type -t vh_run_step || echo none)"',
        // A child process proves the values are EXPORTED, not just set.
        `${JSON.stringify(process.execPath)} -e 'console.log("CHILD_DISPLAY=" + (process.env.DISPLAY ?? "")); console.log("CHILD_PID=" + (process.env.VERIFY_TAURI_PID ?? ""))'`,
      ].join('\n');
      return spawnSync('bash', ['--noprofile', '--norc', '-c', script, 'bash', envFile], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PAPERCUSP_SID: sid, DISPLAY: ':1' },
        encoding: 'utf8',
      });
    }

    it('extracts the env-file body from the script', () => {
      expect(ENV_BODY).toBeTruthy();
      expect(ENV_BODY).toContain('verify_tauri_assert_owned');
    });

    it('sources cleanly for the owning session and exports the rig DISPLAY', () => {
      const r = sourceAs(OWNER);
      expect(r.stderr).not.toContain('command not found');
      expect(r.stdout).toContain('RC=0');
      expect(r.stdout).toContain('VH=none');
      // The caller's own DISPLAY (:1, the owner's desktop) must be replaced.
      expect(r.stdout).toContain(`CHILD_DISPLAY=${DISPLAY}`);
      expect(r.stdout).toContain(`CHILD_PID=${target.pid}`);
    });

    it('still refuses a different session and exports nothing', () => {
      const r = sourceAs('su-someone-else');
      expect(r.stdout).toContain('RC=1');
      expect(r.stderr).toContain('owned by another session');
      expect(r.stdout).toContain('CHILD_DISPLAY=:1');
      expect(r.stdout).toContain('CHILD_PID=\n');
    });
  },
);

describe('WI-10004544 — Xvfb teardown is bound to the originating run', () => {
  const startDisplayServer = src.match(
    /start_display_server\(\) \{([\s\S]*?)^\}/m,
  )?.[1];
  const xvfbStopWriter = src.match(
    /^write_xvfb_stop_script\(\) \{[\s\S]*?^\}/m,
  )?.[0];
  const stopWriter = src.match(
    /^write_stop_script\(\) \{[\s\S]*?^\}/m,
  )?.[0];
  const retryStart = src.indexOf('if [ "$DISPLAY_LOST" = 1 ]; then');
  const retryEnd = src.indexOf('      display_lock_release', retryStart);
  const retryTeardown = retryStart >= 0 && retryEnd > retryStart
    ? src.slice(retryStart, retryEnd)
    : '';

  it('starts Xvfb with a unique run provenance and display marker', () => {
    expect(startDisplayServer).toBeTruthy();
    expect(startDisplayServer).toContain('PAPERCUSP_TAURI_LAUNCH_PROVENANCE');
    expect(startDisplayServer).toContain('PAPERCUSP_VERIFY_XVFB_DISPLAY');
  });

  it('rechecks both markers before TERM and fallback KILL', () => {
    expect(xvfbStopWriter).toBeTruthy();
    expect(xvfbStopWriter).toContain(
      'PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$EXPECTED_PROVENANCE',
    );
    expect(xvfbStopWriter).toContain(
      'PAPERCUSP_VERIFY_XVFB_DISPLAY=$EXPECTED_DISPLAY',
    );
    expect(xvfbStopWriter).toContain('kill -TERM "$xvfb_pid"');
    expect(xvfbStopWriter).toMatch(
      /xvfb_is_owned "\$xvfb_pid"[\s\S]*?kill -KILL "\$xvfb_pid"/,
    );
    expect(xvfbStopWriter).not.toMatch(/pkill\s+-9\s+-f\s+"Xvfb/);
  });

  it('uses the owned helper for final and retry teardown without unlinking shared display files', () => {
    expect(stopWriter).toBeTruthy();
    expect(stopWriter).toContain('"$WORK/stop-xvfb.sh"');
    expect(stopWriter).not.toContain('systemctl --user stop --no-block "${VERIFY_SCOPE_BASE}-xvfb.scope"');
    expect(stopWriter).not.toMatch(/pkill\s+-9\s+-f\s+"Xvfb/);
    expect(stopWriter).not.toContain('rm -f "/tmp/.X11-unix/X$DISPLAY_NUM"');
    expect(stopWriter).not.toContain('"/tmp/.X$DISPLAY_NUM-lock"');

    expect(retryTeardown).toContain('write_xvfb_stop_script');
    expect(retryTeardown).toContain('"$WORK/stop-xvfb.sh"');
    expect(retryTeardown).not.toMatch(/pkill\s+-9\s+-f\s+"Xvfb/);
    expect(retryTeardown).not.toContain('"/tmp/.X$DISPLAY_NUM-lock"');
  });
});
