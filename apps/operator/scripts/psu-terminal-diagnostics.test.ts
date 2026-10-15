// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  readTerminalFlags, runTerminalCheck, softwareFlowControl,
  terminalGuidance, terminalSetup, terminalStartupNotice,
} from './psu-terminal-diagnostics.mjs';
import { parseArgs, PSU_HELP_TEXT } from './psu-launcher.mjs';

describe('local terminal diagnostics and customer guidance', () => {
  it('explains shared renderer risk without asserting a diagnosed freeze', () => {
    const text = terminalGuidance({ env: { VTE_VERSION: '7600' }, flags: '-ixon', interactive: true });
    expect(text).toContain('GNOME/VTE');
    expect(text).toContain('can share one renderer');
    expect(text).toContain('does not prove why');
    expect(text).toContain('alacritty -e psu');
    expect(text).toContain('10,000 lines');
    expect(text).toContain('psu --headless');
    expect(text).not.toContain('run: stty -ixon');
  });

  it('distinguishes flow-control suspension from a frozen GUI', () => {
    expect(softwareFlowControl('speed 38400; -ixoff ixon;')).toBe(true);
    expect(softwareFlowControl('speed 38400; -ixon -ixoff;')).toBe(false);
    expect(softwareFlowControl(null)).toBeNull();
    expect(softwareFlowControl('unknown')).toBeNull();
    const text = terminalGuidance({ env: {}, flags: 'ixon', interactive: true });
    expect(text).toContain('press Ctrl-Q');
    expect(text).toContain('window still moves/repaints');
    expect(text).toContain('stty -ixon');
  });

  it('keeps remote renderer identity uncertain and skips automatic notices for headless users', () => {
    const env = { VTE_VERSION: '7600', SSH_CONNECTION: 'connection', TMUX: 'session' };
    expect(terminalSetup(env)).toMatchObject({ vte: true, remote: true, multiplexed: true });
    expect(terminalGuidance({ env })).toContain('local renderer is unknown');
    expect(terminalStartupNotice({ env, interactive: true })).toContain('psu --terminal-check');
    expect(terminalStartupNotice({ env, interactive: true, headless: true })).toBeNull();
    expect(terminalStartupNotice({ env, interactive: false })).toBeNull();
    expect(terminalStartupNotice({ env: {}, interactive: true })).toBeNull();
  });

  it('runs read-only without an operator or credential request', async () => {
    const readFlags = vi.fn(async () => 'ixon');
    const text = await runTerminalCheck({ env: {}, interactive: true, readFlags });
    expect(readFlags).toHaveBeenCalledWith({ interactive: true });
    expect(text).toContain('local, read-only');
    expect(text).toContain('enabled');
    expect(parseArgs(['--terminal-check', '--agent=invalid']).terminalCheck).toBe(true);
    expect(parseArgs(['--', '--terminal-check']).terminalCheck).toBe(false);
    expect(PSU_HELP_TEXT).toContain('--terminal-check');
  });

  it('reads flags without modifying them and bounds a stalled stty command', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    const spawnCommand = vi.fn(() => child);
    const pending = readTerminalFlags({ interactive: true, platform: 'linux', spawnCommand });
    expect(spawnCommand).toHaveBeenCalledWith('stty', ['-a'], { stdio: ['inherit', 'pipe', 'ignore'] });
    child.stdout.emit('data', Buffer.from('-ixon'));
    child.emit('close', 0);
    expect(await pending).toBe('-ixon');
    expect(await readTerminalFlags({ interactive: false, spawnCommand })).toBeNull();
    expect(await readTerminalFlags({ interactive: true, platform: 'win32', spawnCommand })).toBeNull();
    const stalled = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    expect(await readTerminalFlags({ interactive: true, platform: 'linux', spawnCommand: () => stalled })).toBeNull();
    expect(stalled.kill).toHaveBeenCalledOnce();
  });
});
