/**
 * Recurrence guard for EI-20742798527438103 / EI-20961560846717550.
 *
 * The verifier previously reached a healthy owned bridge and only then tried a
 * bare `tauri-agent-tools` command. Codex's PATH contains the Node runtime but
 * not the managed ~/.local/nodeNN/bin directory, so the command exited 127 and
 * the origin guard mislabeled that dependency failure as an unreachable app.
 */
import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('verify-tauri-headless tauri-agent-tools dependency', () => {
  it('resolves the CLI and repairs PATH before allocating a verifier work dir', () => {
    const resolveIdx = src.indexOf(
      'VERIFY_TAURI_AGENT_TOOLS_BIN="$(resolve_tauri_agent_tools)"',
    );
    const workIdx = src.indexOf('WORK="$(mktemp -d');

    expect(resolveIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(workIdx);
    expect(src).toContain('command -v tauri-agent-tools');
    expect(src).toContain('/.local/node*/bin/tauri-agent-tools');
    expect(src).toContain(
      'PATH="$VERIFY_TAURI_AGENT_TOOLS_BIN_DIR:${PATH:-/usr/local/bin:/usr/bin:/bin}"',
    );
  });

  it('fails with the dependency diagnosis before creating any rig resources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-agent-tools-path.'));
    scratch.push(dir);
    const missing = join(dir, 'missing-tauri-agent-tools');
    const result = spawnSync('bash', [SCRIPT, '--boot-only'], {
      cwd: resolve(__dirname, '../../..'),
      env: {
        ...hermeticSpawnEnv(),
        PAPERCUSP_SID: 'test-agent-tools-preflight',
        // The test is exercising the script's own dependency preflight, not
        // capability:bash's task-lifetime guard.  Clear the managed-task marker
        // inherited when this suite runs through a detached verifier.
        PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: '',
        // The runner's own task deadline would trip the verifier's deadline
        // admission (exit 2) before the preflight under test (WI-6554700010030899).
        PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '',
        TMPDIR: dir,
        VERIFY_TAURI_AGENT_TOOLS_BIN: missing,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain(
      `VERIFY_TAURI_AGENT_TOOLS_BIN is not executable: ${missing}`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it('uses the resolved executable and preserves it in the boot-only handoff', () => {
    const health = src.match(
      /HEALTH_TIMEOUT=.*?origin health confirmed:[^\n]*/s,
    )?.[0];

    expect(health).toBeTruthy();
    expect(health).toContain('"$VERIFY_TAURI_AGENT_TOOLS_BIN" eval');
    expect(health).toContain('HEALTH_PROBE_TIMEOUT="${VERIFY_TAURI_HEALTH_PROBE_TIMEOUT:-8}"');
    expect(health).toContain('timeout --signal=TERM --kill-after=1 "${HEALTH_PROBE_TIMEOUT}s"');
    expect(health).toContain('AbortSignal.timeout(timeoutMs)');
    expect(health).toContain('apiHealthError: v[0].errorBody');
    expect(health).toContain('(await r.text()).slice(0, 1200)');
    expect(health).toContain('browserWorkspace: window.__PAPERCUSP_WS__ || null');
    expect(health).toContain('HEALTH_PROBE_STATUS" -eq 126');
    expect(health).toContain(
      'This is a verifier dependency/PATH failure, not evidence that the webview origin is unreachable.',
    );
    expect(src).toContain(
      String.raw`printf 'VERIFY_TAURI_AGENT_TOOLS_BIN=%q\n' "$VERIFY_TAURI_AGENT_TOOLS_BIN"`,
    );
    expect(src).toContain(
      'export PATH VERIFY_TAURI_AGENT_TOOLS_BIN VERIFY_TAURI_AGENT_TOOLS_BIN_DIR',
    );
  });
});
