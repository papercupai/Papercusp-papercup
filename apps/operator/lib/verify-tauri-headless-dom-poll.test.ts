/**
 * EI-10822: sync-backed screens can render after client-side navigation has
 * completed. The isolated Tauri verifier must offer a bounded DOM poll instead
 * of making callers guess a fixed sleep that races cold-boot queries.
 */
import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// Overridable so falsifiability can be proven against a MUTATED COPY outside
// the tree (scripts/mutation-probe.sh tier 2) instead of mutating the shared
// checkout, where a git-sync sweep can commit the mutant mid-probe.
const SCRIPT =
  process.env.VERIFY_TAURI_HEADLESS_SCRIPT ??
  resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const helper = src.match(/cat > "\$POLL" <<'POLL_SCRIPT'\n([\s\S]*?)\nPOLL_SCRIPT/)?.[1];

describe('EI-10822 — verify-tauri-headless DOM polling', () => {
  it('exports the per-run helper to assertion commands and boot-only sessions', () => {
    expect(src).toContain('export VERIFY_TAURI_POLL="$POLL"');
    // EI-20226754912676562 re-pointed this half of the guard. --boot-only used
    // to hand the helper path over by printing `export VERIFY_TAURI_POLL=...`
    // to stdout; concurrent callers redirecting that stream to one shared log
    // could source a PEER's block. The path now travels in the private per-run
    // env file and is re-exported only after that file re-verifies ownership.
    // Assert the NEW carrier — asserting the old one re-demands the bug.
    expect(src).toContain(
      String.raw`printf 'VERIFY_TAURI_POLL=%q\n' "$VERIFY_TAURI_POLL"`,
    );
    expect(src).toMatch(/^export (?=.*VERIFY_TAURI_POLL)(?=.*VERIFY_TAURI_STOP).*$/m);
    expect(helper).toBeTruthy();
  });

  it('retries a data-dependent check until it passes and pins the verified pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-poll-'));
    const helperPath = join(dir, 'poll-dom.sh');
    const fakeTool = join(dir, 'tauri-agent-tools');
    const attempts = join(dir, 'attempts');
    writeFileSync(helperPath, helper!);
    chmodSync(helperPath, 0o755);
    writeFileSync(fakeTool, `#!/usr/bin/env bash\ncount=$(cat "${attempts}" 2>/dev/null || echo 0)\ncount=$((count + 1))\nprintf '%s' "$count" > "${attempts}"\n[ "$1 $2" = "check --pid" ] || exit 9\n[ "$3" = "4242" ] || exit 8\n[ "$count" -ge 3 ]\n`);
    chmodSync(fakeTool, 0o755);

    const result = spawnSync(helperPath, ['--selector', 'body', '--text', 'ready'], {
      encoding: 'utf8',
      env: {
        ...hermeticSpawnEnv(),
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        VERIFY_TAURI_PID: '4242',
        VERIFY_TAURI_DOM_TIMEOUT: '5',
        VERIFY_TAURI_DOM_POLL_INTERVAL: '0',
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(attempts, 'utf8')).toBe('3');
  });

  it('fails with the last assertion output when the bounded timeout expires', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-poll-timeout-'));
    const helperPath = join(dir, 'poll-dom.sh');
    const fakeTool = join(dir, 'tauri-agent-tools');
    writeFileSync(helperPath, helper!);
    chmodSync(helperPath, 0o755);
    writeFileSync(fakeTool, '#!/usr/bin/env bash\necho "still loading" >&2\nexit 1\n');
    chmodSync(fakeTool, 0o755);

    const result = spawnSync(helperPath, ['--selector', 'body', '--text', 'ready'], {
      encoding: 'utf8',
      env: {
        ...hermeticSpawnEnv(),
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        VERIFY_TAURI_PID: '4242',
        VERIFY_TAURI_DOM_TIMEOUT: '0',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DOM assertion did not pass within 0s');
    expect(result.stderr).toContain('still loading');
  });

  it('supports quiet expected-miss probes without hiding a nonzero result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-poll-quiet-'));
    const helperPath = join(dir, 'poll-dom.sh');
    const fakeTool = join(dir, 'tauri-agent-tools');
    writeFileSync(helperPath, helper!);
    chmodSync(helperPath, 0o755);
    writeFileSync(fakeTool, '#!/usr/bin/env bash\necho "[FAIL] optional panel absent" >&2\nexit 1\n');
    chmodSync(fakeTool, 0o755);

    const result = spawnSync(
      helperPath,
      ['--quiet', '--selector', 'body', '--text', 'optional panel'],
      {
        encoding: 'utf8',
        env: {
          ...hermeticSpawnEnv(),
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          VERIFY_TAURI_PID: '4242',
          VERIFY_TAURI_DOM_TIMEOUT: '0',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('DOM assertion did not pass within 0s');
    expect(result.stderr).not.toContain('[FAIL] optional panel absent');
  });
});

/**
 * EI-18781011720418569 — the VACUOUS GREEN. A negative DOM assertion ("the old
 * copy is gone", "no `undefined` leaked") is trivially true of an EMPTY
 * document, so it passes before the sync-backed rows have reached the DOM: a
 * correct-looking script, a green exit, and zero coverage. Pane-level readiness
 * is not data-level readiness, and a negative assertion has nothing obvious to
 * poll FOR — which is exactly why it silently never gets a guard.
 */
describe('EI-18781011720418569 — negative assertions cannot pass against an empty DOM', () => {
  /** Records the argv it was called with, then exits with FAKE_EXIT (default 0). */
  const recordingTool = (capture: string) =>
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${capture}"\nexit "\${FAKE_EXIT:-0}"\n`;

  /**
   * Passes ONLY the bare presence guard (an --eval with no `&&`), so the fused
   * assertion fails while the guard itself is satisfiable. That split is what
   * separates "the subject never rendered" from "the subject rendered and the
   * claim was false" — the two failures this helper must not conflate.
   */
  const guardOnlyTool =
    '#!/usr/bin/env bash\n' +
    'expr=""\n' +
    'while [ "$#" -gt 0 ]; do [ "$1" = "--eval" ] && expr="$2"; shift; done\n' +
    'if [ "${GUARD_PASSES:-0}" = "1" ]; then\n' +
    '  case "$expr" in *"&&"*) exit 1 ;; *) exit 0 ;; esac\n' +
    'fi\n' +
    'exit 1\n';

  const runHelper = (
    toolScript: string,
    argv: string[],
    env: Record<string, string> = {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-poll-guard-'));
    const helperPath = join(dir, 'poll-dom.sh');
    const fakeTool = join(dir, 'tauri-agent-tools');
    const capture = join(dir, 'argv');
    writeFileSync(helperPath, helper!);
    chmodSync(helperPath, 0o755);
    writeFileSync(fakeTool, toolScript.replaceAll('__CAPTURE__', capture));
    chmodSync(fakeTool, 0o755);
    const result = spawnSync(helperPath, argv, {
      encoding: 'utf8',
      env: {
        ...hermeticSpawnEnv(),
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        VERIFY_TAURI_PID: '4242',
        VERIFY_TAURI_DOM_TIMEOUT: '0',
        VERIFY_TAURI_DOM_POLL_INTERVAL: '0',
        ...env,
      },
    });
    let argvSeen = '';
    try {
      argvSeen = readFileSync(capture, 'utf8');
    } catch {
      argvSeen = '';
    }
    return { result, argvSeen };
  };

  it('refuses an unguarded negative --eval instead of running it', () => {
    const { result, argvSeen } = runHelper(recordingTool('__CAPTURE__'), [
      '--eval',
      '!document.body.innerHTML.includes("paused from its own subsystem")',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('UNGUARDED NEGATIVE DOM assertion');
    expect(result.stderr).toContain('--require');
    // The bridge is never touched: a refusal that still ran the check would
    // leave the vacuous pass on stdout for a caller to misread.
    expect(argvSeen).toBe('');
  });

  it('refuses the empty-set form of the same trap', () => {
    const { result } = runHelper(recordingTool('__CAPTURE__'), [
      '--eval',
      'document.querySelectorAll(".row").length === 0',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('UNGUARDED NEGATIVE DOM assertion');
  });

  it('does not mistake a !! truthiness coercion for an absence check', () => {
    // `!!x` is a POSITIVE assertion — it fails on an empty DOM, which is the
    // behaviour we want — and the script header itself recommends the idiom.
    const { result } = runHelper(recordingTool('__CAPTURE__'), [
      '--eval',
      '!!document.querySelector("[data-testid=schedule-row]")',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('UNGUARDED NEGATIVE');
  });

  it('fuses --require into the SAME evaluation as the caller assertion', () => {
    // Fused, not sequenced: a separate guard call leaves a window in which the
    // rows can be present for the guard and gone for the assertion.
    const { result, argvSeen } = runHelper(recordingTool('__CAPTURE__'), [
      '--require',
      '[data-testid="schedule-row"]',
      '--eval',
      '!document.body.innerHTML.includes("old copy")',
    ]);

    expect(result.status).toBe(0);
    expect(argvSeen).toContain(
      `(document.querySelectorAll('[data-testid="schedule-row"]').length >= 1) && (!document.body.innerHTML.includes("old copy"))`,
    );
  });

  it('honours --require-min in the fused guard', () => {
    const { argvSeen } = runHelper(recordingTool('__CAPTURE__'), [
      '--require=.row',
      '--require-min=3',
      '--eval=!document.body.innerHTML.includes("old copy")',
    ]);

    expect(argvSeen).toContain(`--eval=(document.querySelectorAll('.row').length >= 3) &&`);
  });

  it('runs an unguarded negative when the caller takes the escape hatch', () => {
    const { result, argvSeen } = runHelper(recordingTool('__CAPTURE__'), [
      '--allow-unguarded-negative',
      '--eval',
      '!document.body.innerHTML.includes("old copy")',
    ]);

    expect(result.status).toBe(0);
    expect(argvSeen).toContain('!document.body.innerHTML.includes("old copy")');
    // The escape hatch is consumed here, never forwarded to the bridge.
    expect(argvSeen).not.toContain('--allow-unguarded-negative');
  });

  it('reports "the subject never rendered" rather than a bare assertion failure', () => {
    const { result } = runHelper(guardOnlyTool, [
      '--require',
      '[data-testid="schedule-row"]',
      '--eval',
      '!document.body.innerHTML.includes("old copy")',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('presence guard never matched');
    expect(result.stderr).toContain('[data-testid="schedule-row"]');
    expect(result.stderr).toContain('UNGUARDED negative check would have PASSED');
  });

  it('falls back to the ordinary failure when the subject DID render', () => {
    const { result } = runHelper(
      guardOnlyTool,
      [
        '--require',
        '[data-testid="schedule-row"]',
        '--eval',
        '!document.body.innerHTML.includes("old copy")',
      ],
      { GUARD_PASSES: '1' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DOM assertion did not pass within 0s');
    expect(result.stderr).not.toContain('presence guard never matched');
  });

  it('gates a non---eval assertion on the guard too', () => {
    const { result } = runHelper(guardOnlyTool, [
      '--require',
      '[data-testid="schedule-row"]',
      '--selector',
      'body',
      '--text',
      'ready',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('presence guard never matched');
  });

  it('refuses --require-min without a subject to count', () => {
    const { result } = runHelper(recordingTool('__CAPTURE__'), [
      '--require-min',
      '3',
      '--selector',
      'body',
      '--text',
      'ready',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--require-min needs --require');
  });

  it('refuses a guard that would accept zero nodes', () => {
    const { result } = runHelper(recordingTool('__CAPTURE__'), [
      '--require',
      '.row',
      '--require-min',
      '0',
      '--selector',
      'body',
      '--text',
      'ready',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('guard that accepts 0 nodes guards nothing');
  });

  it('documents the convention in the script usage header', () => {
    expect(src).toContain('GUARD EVERY NEGATIVE ASSERTION (EI-18781011720418569)');
  });
});
