// @vitest-environment node
/**
 * DIALOG-AUTO-ORIGIN: a single-case production PTY proof.
 *
 * Keep this case in its own file so the evidence run executes exactly one test
 * with no skipped remainder. The broad psu-pty-host integration file contains
 * unrelated cases and cannot provide that execution-integrity guarantee.
 */
import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execPath } from 'node:process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { openClaudeDialog, finishClaudeDialog } from '../scripts/hooks/cc/dialog-answer-provenance.mjs';
import {
  hostThroughPty as hostThroughPtyProduction,
  socketPathFor,
} from '../scripts/psu-pty-host.mjs';
import { injectIntoHost } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';

const hostThroughPty: typeof hostThroughPtyProduction = (options) =>
  hostThroughPtyProduction({ onExit: () => undefined, emitCompacted: () => null, ...options });

function fakeIo() {
  let captured = '';
  return {
    captured: () => captured,
    io: {
      stdout: {
        columns: 80,
        rows: 24,
        write: (data: Buffer | string) => { captured += data.toString(); },
        on() {},
        off() {},
      },
      stdin: { isTTY: false, on() {}, off() {}, resume() {}, pause() {} },
    },
  };
}

it('attributes real PTY dialog submissions to machine control or human terminal input', async () => {
  const ownerId = `su-dialog-pty-${process.pid}-${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'dialog-pty-'));
  const env = hermeticEnv({
    PAPERCUSP_SID: ownerId,
    PAPERCUSP_AGENT: 'claude',
    PAPERCUSP_TURN_PROVENANCE_DIR: dir,
  });
  const { captured, io } = fakeIo();
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
  });
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', "let n=0;process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(d.toString().includes('QUIT'))process.exit(0);process.stdout.write('DIALOG_KEY_'+(++n)+'\\n')});process.stdout.write('DIALOG_READY\\n')"],
    cwd: process.cwd(),
    env,
    ownerId,
    io: { ...io, stdin },
    bridgeTty: true,
    signalSource: new EventEmitter(),
  });
  try {
    await vi.waitFor(() => expect(captured()).toContain('DIALOG_READY'), { timeout: 5000 });

    openClaudeDialog(ownerId, 'native-session', 'machine-question', env);
    expect(await injectIntoHost(socketPathFor(ownerId), {
      mode: 'raw', data: '\r', ownerId,
    })).toBe(true);
    await vi.waitFor(() => expect(captured()).toContain('DIALOG_KEY_1'), { timeout: 3000 });
    expect(finishClaudeDialog(ownerId, 'native-session', 'machine-question', 'first option', env))
      .toContain('"source":"automatic"');

    openClaudeDialog(ownerId, 'native-session', 'human-question', env);
    stdin.emit('data', Buffer.from('\r'));
    await vi.waitFor(() => expect(captured()).toContain('DIALOG_KEY_2'), { timeout: 3000 });
    expect(finishClaudeDialog(ownerId, 'native-session', 'human-question', 'second option', env))
      .toContain('"source":"human"');
  } finally {
    stdin.emit('data', Buffer.from('QUIT'));
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
}, 12000);
