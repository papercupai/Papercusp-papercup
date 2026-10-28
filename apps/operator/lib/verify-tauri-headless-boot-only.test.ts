/**
 * WI-4975: a background subshell inherits its parent's EXIT trap. The
 * --boot-only port-lock keeper must clear teardown before waiting, otherwise
 * a normal wrapper exit destroys the isolated app it just handed to the user.
 */
import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('WI-4975 — verify-tauri-headless --boot-only keeps the isolated app alive', () => {
  it('detaches the display and window manager from the launcher terminal', () => {
    expect(src).toMatch(/start_verify_process "\$\{VERIFY_SCOPE_BASE\}-xvfb"/);
    expect(src).toMatch(/start_verify_process "\$\{VERIFY_SCOPE_BASE\}-openbox"/);
  });

  it('inherits an existing managed task scope instead of creating an unaccounted sibling', () => {
    // capability:bash stamps this reserved marker only after durable task
    // enrollment, and the bash-job service cgroup is the root the verifier
    // must inherit. Do not infer ledger ownership from a particular systemd
    // unit suffix: bash jobs use a managed service, not a verifier scope.
    expect(src).toContain('PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID');
    expect(src).toContain('if [ -n "$CAPABILITY_BASH_BACKGROUND_TASK_ID" ]; then');
    expect(src).toContain('VERIFY_SCOPE_MODE="inherit"');
    expect(src).toContain('VERIFY_SCOPE_INHERITED=1');
    expect(src).toMatch(/if \[ -n "\$CAPABILITY_BASH_BACKGROUND_TASK_ID" \]; then[\s\S]*?VERIFY_SCOPE_MODE="inherit"[\s\S]*?elif \[ "\$\(uname -s/);
    expect(src).toMatch(/if \[ "\$VERIFY_SCOPE_MODE" = "sibling" \]; then[\s\S]*?systemd-run --user --scope/);
    expect(src).toContain('children stay in capability:bash managed task scope');
  });

  it('keeps the sibling user-scope fallback for untracked callers', () => {
    expect(src).toContain('systemd-run --user --scope --quiet --collect');
    expect(src).toContain('--slice="$VERIFY_SCOPE_SLICE"');
    expect(src).toContain('VERIFY_SCOPE_SLICE="papercusp-agent-session.slice"');
    expect(src).toMatch(/TAURI_SCOPE_UNIT="\$\{VERIFY_SCOPE_BASE\}-tauri-\$\{BOOT_ATTEMPTS\}"/);
    // `--property=CollectMode=inactive-or-failed` joined the invocation on
    // 2026-08-23 (7063f790 — failed scopes must self-collect too); the probe
    // unit and its position in the same invocation are what this guard pins.
    expect(src).toContain(
      'systemd-run --user --scope --quiet --collect --property=CollectMode=inactive-or-failed --unit="${VERIFY_SCOPE_BASE}-probe"',
    );
    expect(src).toContain('VERIFY_TAURI_SCOPE_MODE');
    expect(src).toContain('VERIFY_TAURI_SCOPE_INHERITED');
  });

  it('leaves a provenance-aware liveness check for boot-only callers', () => {
    expect(src).toContain('VERIFY_TAURI_LIVENESS_CHECK');
    expect(src).toContain('verifier bridge PID \\$PID is gone');
    expect(src).toContain('PID may have been reused; refusing to drive another bridge');
    expect(src).toContain('PAPERCUSP_TAURI_LAUNCH_PROVENANCE=\\$EXPECTED_PROVENANCE');
    expect(src).toContain('before every tauri-agent-tools eval/check/click/type/capture');
  });

  it('clears teardown traps inside the background keeper before it can exit', () => {
    const branch = src.match(/if \[ "\$\{1:-\}" = "--boot-only" \]; then([\s\S]*?)\nfi/)?.[1];
    expect(branch).toBeTruthy();
    // The trap-clear is the FIRST statement inside the keeper subshell, before its
    // wait — so a normal wrapper exit can never tear down the isolated app. EI-11559
    // switched the keeper to watch the DISPLAY (XVFB_PID) rather than the tauri-dev
    // wrapper (TAURI_PID, which can exit early on handoff); the WI-4975 property is
    // unchanged.
    expect(branch).toMatch(/\(\s*trap - EXIT INT TERM\s*\n\s*while kill -0 "\$XVFB_PID"[^;]*; do sleep 2; done/);
  });

  it('does not start the keeper before clearing only the parent trap', () => {
    expect(src).not.toMatch(
      /\(\s*while kill -0 "\$XVFB_PID"[\s\S]*?\) &\s*\n\s*PORT_LOCK_KEEPER_PID=\$!\s*\n\s*trap - EXIT INT TERM/,
    );
  });
});

describe('EI-21587904634585710 — boot-only task lifetime is explicit', () => {
  it('refuses a capability:bash boot-only launch before allocating verifier resources', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'verify-tauri-headless-task-lifetime.'));

    try {
      const result = spawnSync('bash', [SCRIPT, '--boot-only'], {
        cwd: ROOT,
        env: {
          ...hermeticSpawnEnv(),
          PAPERCUSP_REPO_DIR: join(scratch, 'missing-repo'),
          PAPERCUSP_SID: 'test-boot-only-task-lifetime',
          PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'task-under-test',
          TMPDIR: scratch,
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('refusing before verifier boot');
      expect(result.stderr).toContain('task-under-test');
      expect(result.stderr).toContain('--boot-only-i-accept-task-lifetime');
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('requires the explicit escape and routes it through the existing boot-only branch', () => {
    expect(src).toContain('--boot-only-i-accept-task-lifetime');
    expect(src).toContain('$0 --boot-only-i-accept-task-lifetime');
    expect(src).toContain('BOOT_ONLY_ACCEPT_TASK_LIFETIME=1');
    expect(src).toMatch(
      /--boot-only-i-accept-task-lifetime\)[\s\S]*?set -- --boot-only[\s\S]*?if \[ "\$\{1:-\}" = "--boot-only" \]; then/,
    );
    expect(src).toContain(
      'verifier dies when task=${CAPABILITY_BASH_BACKGROUND_TASK_ID} ends',
    );
  });
});
