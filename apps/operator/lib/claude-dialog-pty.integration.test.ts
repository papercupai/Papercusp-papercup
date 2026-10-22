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
  const selections = () => [...captured().matchAll(/DIALOG_SELECTION_(\{[^\r\n]*\})/g)]
    .map((match) => JSON.parse(match[1]) as { n: number; selection: string; inputHex: string });
  const childMenu = String.raw`
    let n=0, input='';
    process.stdin.setRawMode(true);
    process.stdin.on('data', d => {
      if(d.toString().includes('QUIT')) process.exit(0);
      input += d.toString();
      let end;
      while((end=input.indexOf('\r')) >= 0) {
        const keys=input.slice(0,end+1); input=input.slice(end+1);
        const down=(keys.match(/\x1b\[B/g)||[]).length;
        const selection=['first option','second option'][down%2];
        process.stdout.write('DIALOG_SELECTION_'+JSON.stringify({n:++n,selection,inputHex:Buffer.from(keys).toString('hex')})+'\n');
      }
    });
    process.stdout.write('DIALOG_READY\n');
  `;
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', childMenu],
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
    const machineInput = '\x1b[B\r';
    expect(await injectIntoHost(socketPathFor(ownerId), {
      mode: 'raw', data: machineInput, ownerId,
    })).toBe(true);
    await vi.waitFor(() => expect(selections()).toHaveLength(1), { timeout: 3000 });
    expect(selections()[0]).toEqual({ n: 1, selection: 'second option', inputHex: Buffer.from(machineInput).toString('hex') });
    const machineContext = finishClaudeDialog(ownerId, 'native-session', 'machine-question', selections()[0].selection, env);
    expect(machineContext).toContain('"source":"automatic"');
    expect(machineContext).toContain('Answer: second option');

    openClaudeDialog(ownerId, 'native-session', 'human-question', env);
    const humanInput = '\r';
    stdin.emit('data', Buffer.from(humanInput));
    await vi.waitFor(() => expect(selections()).toHaveLength(2), { timeout: 3000 });
    expect(selections()[1]).toEqual({ n: 2, selection: 'first option', inputHex: Buffer.from(humanInput).toString('hex') });
    const humanContext = finishClaudeDialog(ownerId, 'native-session', 'human-question', selections()[1].selection, env);
    expect(humanContext).toContain('"source":"human"');
    expect(humanContext).toContain('Answer: first option');
  } finally {
    stdin.emit('data', Buffer.from('QUIT'));
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
}, 12000);
