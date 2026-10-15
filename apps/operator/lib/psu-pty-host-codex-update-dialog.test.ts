// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CODEX_STARTUP_UPDATE_CHECK_OVERRIDE,
  CODEX_STARTUP_UPDATE_DIALOG_ESCAPE_KEY,
  managedCodexStartupUpdateDialogEnabled,
  makeManagedCodexStartupUpdateDialogStateMachine,
  withManagedCodexStartupConfig,
} from '../scripts/psu-pty-host.mjs';

// WI-10008156: the screen Codex 0.162.0 actually rendered, captured from
// su-c210fe1b's codex-starting-stuck-snapshot (2026-10-10T15:04:49Z) with the
// host's own ESC rendering. The first choice carries a parenthetical install
// command, unlike the bare `Update now` fixture above. That difference kept
// the dismissal from ever firing.
const measuredCodex0162UpdateMenu = [
  '\x1b[?2026h\x1b[1;1H\x1b[1m✨ Update available! \x1b[22m\x1b[2m· 0.162.0 → 0.162.1',
  '\x1b[3;1H\x1b[22m  \x1b[2mRelease notes: \x1b[4m\x1b]8;;https://github.com/openai/codex/releases/latest\x07',
  'https://github.com/openai/codex/releases/latest\x1b]8;;\x07\x1b[4;1H\x1b[24m\x1b[22m ',
  '\x1b[5;1H\x1b[1m\x1b[38;2;0;0;46;48;2;99;168;248m› 1. Update now (runs `npm install -g @openai/codex`)   ',
  '\x1b[6;1H\x1b[22m\x1b[39;48;2;79;41;67m  2. Skip',
  '\x1b[7;1H  3. Skip until next version',
  '\x1b[8;1H \x1b[9;1H  \x1b[1menter\x1b[22m\x1b[2m continue · \x1b[22m\x1b[1mesc\x1b[22m\x1b[2m skip',
  '\x1b[10;1H\x1b[22m \x1b[39m\x1b[49m\x1b[0m\x1b[?2026l',
].join('');

const codexUpdateMenu = [
  '\x1b[?1049h\x1b[2;1HUpdate available 0.161.0 → 0.162.0',
  '\x1b[3;1H› 1. Update now',
  '\x1b[4;1H  2. Skip',
  '\x1b[5;1H  3. Skip until next version',
].join('');

describe('managed Codex startup update dialog', () => {
  it('is enabled only for the managed Codex agent', () => {
    expect(managedCodexStartupUpdateDialogEnabled({ PAPERCUSP_AGENT: 'codex' })).toBe(true);
    expect(managedCodexStartupUpdateDialogEnabled({ PAPERCUSP_AGENT: 'CODEX' })).toBe(true);
    expect(managedCodexStartupUpdateDialogEnabled({ PAPERCUSP_AGENT: 'claude' })).toBe(false);
    expect(managedCodexStartupUpdateDialogEnabled({})).toBe(false);

    const disabled = makeManagedCodexStartupUpdateDialogStateMachine({
      enabled: managedCodexStartupUpdateDialogEnabled({ PAPERCUSP_AGENT: 'claude' }),
    });
    expect(disabled.observe(codexUpdateMenu)).toMatchObject({ action: 'none', phase: 'disabled', active: false });
  });

  it('recognizes the exact current menu across split ANSI and text chunks, then requests Escape once', () => {
    let now = 1_000;
    const dialog = makeManagedCodexStartupUpdateDialogStateMachine({
      now: () => now,
      screenDims: { rows: 8, cols: 80 },
    });

    expect(dialog.observe('\x1b[?1049h\x1b[2;')).toMatchObject({ action: 'none', phase: 'watching' });
    expect(dialog.observe('1H\x1b[1;3')).toMatchObject({ action: 'none', phase: 'watching' });
    expect(dialog.observe('2mUpdate available 0.161.0 → 0.162.0\x1b[0m')).toMatchObject({
      action: 'none', phase: 'watching',
    });
    expect(dialog.observe('\x1b[3;1H› 1. Update now')).toMatchObject({ action: 'none', phase: 'watching' });
    expect(dialog.observe('\x1b[4;1H  2. Skip')).toMatchObject({ action: 'none', phase: 'watching' });
    expect(dialog.observe('\x1b[5;1H  3. Skip until next version')).toMatchObject({
      action: 'send-escape', phase: 'complete', active: false,
    });
    expect(CODEX_STARTUP_UPDATE_DIALOG_ESCAPE_KEY).toBe('\x1b');
    expect(dialog.observe(codexUpdateMenu)).toMatchObject({ action: 'none', phase: 'complete', active: false });
    now += 1;
    expect(dialog.status()).toMatchObject({ phase: 'complete', active: false });
  });

  it('recognizes the measured Codex 0.162 menu whose first choice carries an install command', () => {
    const dialog = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 24, cols: 120 } });
    expect(dialog.observe(measuredCodex0162UpdateMenu)).toMatchObject({
      action: 'send-escape', phase: 'complete', active: false,
    });
  });

  it('keeps choice labels exact apart from a parenthetical suffix', () => {
    // `Skip until next version` must not satisfy the `Skip` row, and a suffix
    // that is not parenthetical does not count as the same choice.
    const skipOnlyOnce = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 24, cols: 120 } });
    expect(skipOnlyOnce.observe(measuredCodex0162UpdateMenu.replace('  2. Skip', '  2. Skip until next version')))
      .toMatchObject({ action: 'none', phase: 'watching' });

    const unparenthesized = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 24, cols: 120 } });
    expect(unparenthesized.observe(measuredCodex0162UpdateMenu.replace(
      'Update now (runs `npm install -g @openai/codex`)',
      'Update nowhere',
    ))).toMatchObject({ action: 'none', phase: 'watching' });
  });

  it('prepends the startup update-check override to the managed Codex binary only', () => {
    const env = { PAPERCUSP_AGENT: 'codex' };
    const command = '/opt/node/bin/codex';
    const argv = ['--no-daemon', '--no-alt-screen', 'resume', '01a12344-bee8-73d1-9ff7-8a27ed86b011'];
    expect(CODEX_STARTUP_UPDATE_CHECK_OVERRIDE).toBe('check_for_update_on_startup=false');
    expect(withManagedCodexStartupConfig({ command, args: argv, env }))
      .toEqual(['-c', 'check_for_update_on_startup=false', ...argv]);
    for (const bin of ['codex', 'C:\\tools\\codex.exe', '/opt/codex.cmd']) {
      expect(withManagedCodexStartupConfig({ command: bin, args: argv, env })[0]).toBe('-c');
    }
    // Pure: the caller's argv (what park/recycle mints read) is not mutated.
    expect(argv).toEqual(['--no-daemon', '--no-alt-screen', 'resume', '01a12344-bee8-73d1-9ff7-8a27ed86b011']);

    // Another agent, or another program under a Codex env (node -e, a shell, a
    // codex-named wrapper with a suffix), never receives a foreign `-c`: node
    // would read it as --check, and a shell as its command string.
    expect(withManagedCodexStartupConfig({ command, args: argv, env: { PAPERCUSP_AGENT: 'claude' } })).toEqual(argv);
    expect(withManagedCodexStartupConfig({ command, args: argv, env: {} })).toEqual(argv);
    for (const other of [process.execPath, '/bin/bash', '/usr/local/bin/codex-su', '/srv/codexhost']) {
      expect(withManagedCodexStartupConfig({ command: other, args: ['-e', '0'], env })).toEqual(['-e', '0']);
    }

    // An explicit caller setting wins, in every override spelling Codex accepts.
    for (const explicit of [
      ['-c', 'check_for_update_on_startup=true'],
      ['--config', 'check_for_update_on_startup = true'],
      ['--config=check_for_update_on_startup=true'],
    ]) {
      expect(withManagedCodexStartupConfig({ command, args: [...explicit, ...argv], env }))
        .toEqual([...explicit, ...argv]);
    }
    // Idempotent: applying it to an already-overridden argv adds nothing.
    const once = withManagedCodexStartupConfig({ command, args: argv, env });
    expect(withManagedCodexStartupConfig({ command, args: once, env })).toEqual(once);
  });

  it('ignores ordinary startup prose and menus missing any exact choice', () => {
    const prose = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 8, cols: 80 } });
    expect(prose.observe(
      '\x1b[?1049h\x1b[2;1HUpdate available: choose Update now, Skip, or Skip until next version.',
    )).toMatchObject({ action: 'none', phase: 'watching' });

    const incomplete = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 8, cols: 80 } });
    expect(incomplete.observe(codexUpdateMenu.replace('3. Skip until next version', '3. Keep current version')))
      .toMatchObject({ action: 'none', phase: 'watching' });
  });

  it('expires after the bounded startup window and disarms on the first submitted turn', () => {
    let now = 4_000;
    const expired = makeManagedCodexStartupUpdateDialogStateMachine({
      now: () => now,
      startupMs: 100,
      screenDims: { rows: 8, cols: 80 },
    });
    now += 100;
    expect(expired.observe(codexUpdateMenu)).toMatchObject({ action: 'expired', phase: 'expired', active: false });
    expect(expired.observe(codexUpdateMenu)).toMatchObject({ action: 'none', phase: 'expired', active: false });

    const submitted = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 8, cols: 80 } });
    submitted.complete();
    expect(submitted.observe(codexUpdateMenu)).toMatchObject({ action: 'none', phase: 'complete', active: false });
  });
});
