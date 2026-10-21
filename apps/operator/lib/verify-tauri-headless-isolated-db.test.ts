/**
 * verify-tauri-headless-isolated-db.test.ts — the RECURRENCE GUARD for EI-10387.
 *
 * The bug: scripts/verify-tauri-headless.sh's header claimed the isolated
 * instance had its "own embedded-PG, own workspace state" — but the sidecar it
 * launched actually inherited the ambient env, so it connected to the SAME
 * live DATABASE_URL / PAPERCUSP_WORKSPACE as the real system. The Tauri
 * WebView also inherited the desktop profile, so localStorage preferences could
 * cross the supposedly write-safe boundary. An agent that trusted the header
 * could click a real Mug steering control (mutating owner state + waking the
 * real Mug) believing it was sandboxed.
 *
 * The fix: make the claim true, opt-in. VERIFY_TAURI_ISOLATED_DB=1 boots a
 * throwaway, fully-migrated, per-run embedded Postgres, scopes
 * PAPERCUSP_HOME/PAPERCUSP_WORKSPACE and the Tauri WebView profile to the run,
 * then *asserts at boot* by reading the REAL sidecar process's own
 * /proc/<pid>/environ — not just the launcher's own env construction — that the
 * resolved DB actually differs from the live one. It also round-trips a
 * localStorage sentinel in the private profile. The default (unset) mode is
 * left honestly documented as sharing the live DB/workspace/profile.
 *
 * A `readFileSync` text guard is the right shape here: the script boots a
 * real Tauri/Xvfb/Postgres stack, so its isolation wiring can only be
 * asserted at the wiring site, not by actually running it (same rationale as
 * verify-tauri-headless-spa-isolation.test.ts / tty-title-target.test.ts).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-10387 — verify-tauri-headless can genuinely isolate the database', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('EI-10387');
  });

  it('no longer makes the false unconditional isolation claim', () => {
    // The original false claim, verbatim, must not appear as an assertion —
    // it may only appear (once) inside the corrective "used to claim" note.
    const falseClaimCount = (
      src.match(/own embedded-PG, own workspace state/g) ?? []
    ).length;
    expect(falseClaimCount).toBeLessThanOrEqual(1);
    expect(src).toMatch(/This header used to claim.*own embedded-PG, own workspace state/);
    expect(src).toContain('That was FALSE');
  });

  it('honestly documents the default (shared-DB) mode', () => {
    expect(src).toMatch(/\*\*NOT\*\* ISOLATED: the DATABASE, the WORKSPACE, and the WebView profile/);
    expect(src).toContain('EVERY WRITE YOU MAKE IN THIS WINDOW IS A REAL WRITE TO LIVE STATE');
  });

  it('is opt-in via VERIFY_TAURI_ISOLATED_DB and defaults OFF (unchanged default behavior)', () => {
    expect(src).toMatch(/ISOLATED_DB="\$\{VERIFY_TAURI_ISOLATED_DB:-0\}"/);
  });

  it('boots a throwaway, per-run embedded Postgres reusing the hermetic-test primitive', () => {
    // Reuse-first: the same primitive scripts/with-test-pg.mjs uses, not a
    // hand-rolled second embedded-PG bootstrapper.
    expect(src).toContain('startEmbeddedPostgresServer');
    expect(src).toMatch(/ISOLATED_PG_DATA_DIR="\$WORK\/isolated-pgdata"/);
  });

  it('scopes PAPERCUSP_HOME/PAPERCUSP_WORKSPACE to the run when isolated', () => {
    expect(src).toMatch(/ISOLATED_HOME="\$WORK\/papercusp-home"/);
    expect(src).toMatch(/ISOLATED_WORKSPACE="verify-tauri-isolated-\$DISPLAY_NUM"/);
    expect(src).toMatch(/PAPERCUSP_HOME=\\"\$ISOLATED_HOME\\"/);
    expect(src).toMatch(/PAPERCUSP_WORKSPACE=\\"\$ISOLATED_WORKSPACE\\"/);
  });

  it('mints a private bearer and never reuses the real user bearer', () => {
    const work = mkdtempSync(join(tmpdir(), 'verify-bearer-isolation-'));
    try {
      const helper = src.match(/prepare_isolated_bearer\(\) \{\n[\s\S]*?\n\}\n/)?.[0];
      expect(helper).toBeTruthy();
      const realHome = join(work, 'real-home');
      const realToken = join(realHome, '.papercusp', 'superuser-token');
      const isolatedHome = join(work, 'isolated-home');
      mkdirSync(join(realHome, '.papercusp'), { recursive: true });
      writeFileSync(realToken, 'real-user-bearer-1234567890\n', { mode: 0o600 });
      const result = spawnSync('bash', ['-c', [
        'set -eu', helper,
        'ISOLATED_HOME="$1"',
        'mkdir -p "$ISOLATED_HOME"',
        'prepare_isolated_bearer',
      ].join('\n'), 'probe', isolatedHome], {
        encoding: 'utf8', env: { ...process.env, HOME: realHome },
      });
      expect(result.status, result.stderr).toBe(0);
      const isolatedToken = join(isolatedHome, 'superuser-token');
      const value = readFileSync(isolatedToken, 'utf8').trim();
      expect(value).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(realToken, 'utf8').trim()).not.toBe(value);
      expect(statSync(isolatedToken).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('isolates the Tauri WebView profile and guards localStorage with a sentinel', () => {
    expect(src).toMatch(/ISOLATED_WEBVIEW_ROOT="\$WORK\/webview-profile"/);
    expect(src).toMatch(/XDG_DATA_HOME=\\"\$ISOLATED_WEBVIEW_DATA\\"/);
    expect(src).toMatch(/XDG_CACHE_HOME=\\"\$ISOLATED_WEBVIEW_CACHE\\"/);
    expect(src).toMatch(/XDG_CONFIG_HOME=\\"\$ISOLATED_WEBVIEW_CONFIG\\"/);
    expect(src).toContain('PAPERCUSP_VERIFY_TAURI_ISOLATED=1');
    expect(src).toContain('dataDirectory');
    expect(src).toContain('verify-tauri-isolated=1');
    expect(src).toContain('ISOLATED_STORAGE_SENTINEL_KEY');
    expect(src).toContain('localStorage.getItem');
    expect(src).toContain('localStorage.setItem');
    expect(src).toContain('localStorage.removeItem');
    expect(src).toMatch(/rm -rf "\$ISOLATED_WEBVIEW_ROOT"/);
  });

  it('creates a private registered workspace and overrides hostile inherited identity at the real launch boundary', () => {
    const work = mkdtempSync(join(tmpdir(), 'dream-workspace-isolation-'));
    try {
      const helper = src.match(/prepare_isolated_workspace\(\) \{\n[\s\S]*?\n\}\n/)?.[0];
      // Match by content, not by which variable happens to come first: the line
      // grew a leading GH_CONFIG_DIR= (isolated gh auth) and may grow more.
      const envLine = src.split('\n').find((line) => line.trim().startsWith('ISOLATED_ENV_LINE="') && line.includes('PAPERCUSP_HOME='));
      // The env line builds its operator URL through the script's own helper.
      const devUrlHelper = src.match(/verify_tauri_dev_url\(\) \{\n[\s\S]*?\n\}\n/)?.[0];
      expect(helper).toBeTruthy();
      expect(envLine).toBeTruthy();
      expect(devUrlHelper).toBeTruthy();
      const probe = join(work, 'probe.cjs');
      writeFileSync(probe, `console.log(JSON.stringify({id:process.env.PAPERCUSP_WORKSPACE_ID,legacy:process.env.PAPERCUSP_WORKSPACE,root:process.env.PAPERCUSP_WORKSPACES_ROOT,codexHomes:process.env.PAPERCUSP_SU_CODEX_HOMES_DIR,ghConfig:process.env.GH_CONFIG_DIR,operatorBase:process.env.PAPERCUSP_OPERATOR_BASE,operatorUrl:process.env.PAPERCUSP_OPERATOR_URL}));`);
      const script = [
        'set -eu', helper, 'VERIFY_TAURI_DEV_HOST=127.0.0.1', devUrlHelper,
        'WORK="$1"; ISOLATED_WORKSPACE=verify-tauri-isolated-test; ISOLATED_HOME="$WORK/home"; ISOLATED_CODEX_HOMES_DIR="$WORK/su-codex-homes"; ISOLATED_GH_CONFIG_DIR="$WORK/gh-config"',
        'ISOLATED_ADMIN_URL=test-admin; ISOLATED_APP_URL=test-app; ISOLATED_PG_PORT=1234; DEV_PORT=33799',
        'ISOLATED_WEBVIEW_DATA="$WORK/data"; ISOLATED_WEBVIEW_CACHE="$WORK/cache"; ISOLATED_WEBVIEW_CONFIG="$WORK/config"',
        'prepare_isolated_workspace', envLine,
        'eval "$ISOLATED_ENV_LINE node \\"$WORK/probe.cjs\\""',
      ].join('\n');
      const result = spawnSync('bash', ['-c', script, 'probe', work], {
        encoding: 'utf8', env: { ...process.env, PAPERCUSP_WORKSPACE_ID: 'live-owner', PAPERCUSP_WORKSPACE: 'live-owner', PAPERCUSP_WORKSPACES_ROOT: '/do-not-touch-live-registry', PAPERCUSP_OPERATOR_BASE: 'http://127.0.0.1:3070', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ id: 'verify-tauri-isolated-test', legacy: 'verify-tauri-isolated-test', root: join(work, 'workspaces'), codexHomes: join(work, 'su-codex-homes'), ghConfig: join(work, 'gh-config'), operatorBase: 'http://127.0.0.1:33799', operatorUrl: 'http://127.0.0.1:33799' });
      const registry = JSON.parse(readFileSync(join(work, 'workspaces/registry.json'), 'utf8'));
      expect(registry.current).toBe('verify-tauri-isolated-test');
      expect(registry.workspaces.map((row: { id: string }) => row.id)).toEqual(['verify-tauri-isolated-test']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('verifies the running sidecar identity and exports it in both assertion and boot-only handoffs', () => {
    expect(src).toContain('grep -Fxq "PAPERCUSP_WORKSPACE_ID=$ISOLATED_WORKSPACE" <<<"$SIDECAR_ENVIRON"');
    expect(src).toContain('grep -Fxq "PAPERCUSP_WORKSPACES_ROOT=$ISOLATED_WORKSPACES_ROOT" <<<"$SIDECAR_ENVIRON"');
    expect(src).toContain('grep -Fxq "PAPERCUSP_OPERATOR_BASE=$(verify_tauri_dev_url "$DEV_PORT")" <<<"$SIDECAR_ENVIRON"');
    expect(src).toContain('grep -Fxq "PAPERCUSP_OPERATOR_URL=$(verify_tauri_dev_url "$DEV_PORT")" <<<"$SIDECAR_ENVIRON"');
    expect(src).toContain('grep -Fxq "PAPERCUSP_SU_CODEX_HOMES_DIR=$ISOLATED_CODEX_HOMES_DIR" <<<"$SIDECAR_ENVIRON"');
    expect(src).toContain('export PAPERCUSP_WORKSPACE_ID="$ISOLATED_WORKSPACE"');
    expect(src).toContain('export PAPERCUSP_WORKSPACES_ROOT="$ISOLATED_WORKSPACES_ROOT"');
    expect(src).toContain('export PAPERCUSP_SU_CODEX_HOMES_DIR="$ISOLATED_CODEX_HOMES_DIR"');
    expect(src).toContain("printf 'export PAPERCUSP_WORKSPACE_ID=%q\\n'");
    expect(src).toContain("printf 'export PAPERCUSP_WORKSPACES_ROOT=%q\\n'");
    expect(src).toContain("printf 'export PAPERCUSP_SU_CODEX_HOMES_DIR=%q\\n'");
  });

  it('repins the actual launch command after a port retry, overriding the initial isolated env line', () => {
    const work = mkdtempSync(join(tmpdir(), 'verifier-api-retry-'));
    try {
      const writer = src.match(/cat > "\$WORK\/launch.sh" <<LAUNCH\n[\s\S]*?\nLAUNCH\n/)?.[0];
      const devUrlHelper = src.match(/verify_tauri_dev_url\(\) \{\n[\s\S]*?\n\}\n/)?.[0];
      expect(writer).toBeTruthy();
      expect(devUrlHelper).toBeTruthy();
      // The launcher derives OPERATOR_DEV_URL from the RETRIED DEV_PORT just before
      // writing launch.sh; reproduce that derivation, not a hand-typed URL.
      expect(src).toContain('TAURI_DEV_URL="$(verify_tauri_dev_url "$DEV_PORT")"');
      expect(src).toContain('local OPERATOR_DEV_URL="$TAURI_DEV_URL"');
      const bin = join(work, 'bin'); mkdirSync(bin);
      const npm = join(bin, 'npm');
      const probe = join(work, 'probe.cjs');
      writeFileSync(probe, "console.log(JSON.stringify({base:process.env.PAPERCUSP_OPERATOR_BASE,url:process.env.PAPERCUSP_OPERATOR_URL,port:process.env.OPERATOR_DEV_PORT}));");
      writeFileSync(npm, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}\n`);
      chmodSync(npm, 0o700);
      const script = [
        'set -e', 'WORK="$1"; DESKTOP_DIR="$WORK"; DEV_PORT=33801; PTY_PORT=33805; DISPLAY_NUM=91',
        `ISOLATED_ENV_LINE='PAPERCUSP_OPERATOR_BASE="http://127.0.0.1:33800" PAPERCUSP_OPERATOR_URL="http://127.0.0.1:33800"'`,
        'VERIFY_TAURI_DEV_HOST=127.0.0.1', devUrlHelper,
        'TAURI_DEV_URL="$(verify_tauri_dev_url "$DEV_PORT")"; OPERATOR_DEV_URL="$TAURI_DEV_URL"',
        'TAURI_CONFIG="{}"; LAUNCH_PREFIX=()', writer, 'bash "$WORK/launch.sh"',
      ].join('\n');
      const result = spawnSync('bash', ['-c', script, 'test', work], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ base: 'http://127.0.0.1:33801', url: 'http://127.0.0.1:33801', port: '33801' });
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it.each([200, 400])('retains bounded response evidence and browser identity in the real health probe (%i)', async (status) => {
    const probe = src.match(/    const timeoutMs = \$\{HEALTH_PROBE_TIMEOUT\}[\s\S]*?\n  " 2>&1/)?.[0]
      .replace('${HEALTH_PROBE_TIMEOUT}', '8').replace(/\n  " 2>&1$/, '');
    expect(probe).toBeTruthy();
    const body = JSON.stringify({ error: 'unknown_workspace', workspace: 'wrong-window' }) + 'x'.repeat(1400);
    const result = JSON.parse(await runInNewContext(probe!, {
      AbortSignal, URL,
      window: { __PAPERCUSP_WS__: 'wrong-window', location: { href: 'http://127.0.0.1:33700/?ws=private-window' } },
      fetch: async (url: string) => new Response(url === '/api/health' ? body : 'ok', { status: url === '/api/health' ? status : 200 }),
    }));
    expect(result.apiHealth).toBe(status);
    expect(result.rootHtml).toBe(200);
    expect(result.apiHealthError).toBe(status === 400 ? body.slice(0, 1200) : undefined);
    expect(result.rootHtmlError).toBeUndefined();
    expect(result.browserWorkspace).toBe('wrong-window');
    expect(result.queryWorkspace).toBe('private-window');
  });

  it('wins over .env.local DATABASE_URL via the admin/app URL resolver precedence', () => {
    expect(src).toContain('HARNESS_ADMIN_DATABASE_URL');
    expect(src).toContain('HARNESS_DATABASE_URL');
  });

  it('refuses to proceed if the isolated port collides with the live box-canonical PG', () => {
    expect(src).toMatch(/LIVE_PG_JSON="\$HOME\/\.papercusp\/embedded-pg\.json"/);
    expect(src).toMatch(/picked the SAME port .* as the live box-canonical embedded-pg\.json — refusing to proceed/);
  });

  it('asserts GROUND TRUTH at boot from the real sidecar\'s own /proc/<pid>/environ, not just its own env construction', () => {
    // This is the check that would have caught the original bug: an
    // intervening env layer (.env.local, DEFAULT_DEV_CMD) silently
    // re-clobbering our override must fail loudly, not "verify" the live DB.
    expect(src).toMatch(/tr '\\0' '\\n' < "\/proc\/\$p\/environ"/);
    expect(src).toContain('SIDECAR_ADMIN_URL');
    expect(src).toMatch(/if \[ "\$SIDECAR_ADMIN_URL" != "\$ISOLATED_ADMIN_URL" \]/);
    expect(src).toMatch(/Refusing to proceed — this would silently/);
  });

  it('hands the verified disposable database and workspace identity to assertion commands', () => {
    const handoff = src.match(
      /# EI-22622028658305763:[\s\S]*?log "running assertion command: \$\*"/,
    )?.[0];
    expect(handoff).toBeTruthy();
    expect(handoff).toContain('if [ "$ISOLATED_DB" = "1" ]');
    expect(handoff).toContain('export PAPERCUSP_HOME="$ISOLATED_HOME"');
    expect(handoff).toContain('export PAPERCUSP_WORKSPACE="$ISOLATED_WORKSPACE"');
    expect(handoff).toContain(
      'export HARNESS_ADMIN_DATABASE_URL="$ISOLATED_ADMIN_URL"',
    );
    expect(handoff).toContain(
      'export HARNESS_DATABASE_URL="$ISOLATED_APP_URL"',
    );
    expect(handoff).toContain('export PAPERCUSP_VERIFY_TAURI_ISOLATED=1');
  });

  it('discovers the frozen plain-node host as well as the legacy source-entry process', () => {
    expect(src).toContain(
      "OPERATOR_HOST_PROCESS_RE='bin/hono-host\\.ts|dist-verify/hono-host\\.mjs'",
    );
    const isolationGuard = src.match(
      /if \[ "\$ISOLATED_DB" = "1" \]; then[\s\S]*?EI-10387 isolation VERIFIED[\s\S]*?\nfi/,
    )?.[0];
    expect(isolationGuard).toBeTruthy();
    expect(isolationGuard).toContain('find_pid_by_env "$OPERATOR_HOST_PROCESS_RE"');
    expect(isolationGuard).toContain('OPERATOR_DEV_PORT=$DEV_PORT');
  });

  it('uses the shared matcher for sidecar and bridge PID selection', () => {
    expect(src).toContain(
      'SIDECAR_PID="$(find_pid_by_env "$OPERATOR_HOST_PROCESS_RE" "OPERATOR_DEV_PORT=$DEV_PORT" || true)"',
    );
    expect(src).toMatch(/BRIDGE_PID="\$\(find_pid_by_env "debug\/papercusp-desktop"/);
    expect(src).toContain('"DISPLAY=:$DISPLAY_NUM"');
    expect(src).toContain('"OPERATOR_DEV_PORT=$DEV_PORT"');
    expect(src).toContain('"PAPERCUSP_SID=$TAURI_OWNER_SID"');
    expect(src).toContain('"PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$TAURI_LAUNCH_PROVENANCE"');
  });

  it('does not write matching PIDs to a pipe after the first reader exits', async () => {
    const helper = src.match(/find_pid_by_env\(\) \{\n[\s\S]*?\n\}\n/)?.[0];
    expect(helper).toBeTruthy();
    const marker = `verifier-pid-selector-${process.pid}-${Date.now()}`;
    const env = { ...process.env, VERIFY_TAURI_PID_SELECTOR: marker };
    const first = spawn('sleep', ['30'], { env, stdio: 'ignore' });
    const second = spawn('sleep', ['30'], { env, stdio: 'ignore' });
    const waitForSpawn = (child: ReturnType<typeof spawn>) => new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', () => resolveSpawn());
      child.once('error', rejectSpawn);
    });
    try {
      await Promise.all([waitForSpawn(first), waitForSpawn(second)]);
      const script = [
        'set -uo pipefail',
        "trap '' PIPE",
        helper!,
        'pgrep() { printf "%s\\n" "$FAKE_PID_1" "$FAKE_PID_2"; }',
        'selected="$(find_pid_by_env ignored "VERIFY_TAURI_PID_SELECTOR=$MATCH_VALUE")"',
        'status=$?',
        'printf "selected=%s\\nstatus=%s\\n" "$selected" "$status"',
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, FAKE_PID_1: String(first.pid), FAKE_PID_2: String(second.pid), MATCH_VALUE: marker },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(`selected=${first.pid}\nstatus=0\n`);
    } finally {
      if (first.exitCode === null) first.kill('SIGTERM');
      if (second.exitCode === null) second.kill('SIGTERM');
    }
  });

  it('removes the throwaway datadir at teardown (never leaks a migrated cluster into $TMPDIR)', () => {
    expect(src).toMatch(/rm -rf "\$ISOLATED_PG_DATA_DIR"/);
  });

  it('prints an affirming banner (not the scary shared-DB warning) only when isolation is on', () => {
    expect(src).toContain('GENUINELY ISOLATED DATABASE (EI-10387)');
    expect(src).toMatch(/if \[ "\$ISOLATED_DB" = "1" \]/);
  });
});
