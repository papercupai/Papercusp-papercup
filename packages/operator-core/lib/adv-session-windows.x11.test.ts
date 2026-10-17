/** Real window-manager acceptance. Uses an isolated display, never the owner's. */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { focusWindowId, sameX11WindowId } from './adv-session-windows';

const exec = promisify(execFile);
const supported = process.platform === 'linux' && existsSync('/usr/bin/Xvfb') && existsSync('/usr/bin/openbox') && existsSync('/usr/bin/xmessage');

describe.runIf(supported)('real X11 workspace focus', () => {
  it('brings here, switches there, and restores a minimized existing window', async () => {
    const children: ChildProcess[] = [];
    try {
      const xvfb = spawn('/usr/bin/Xvfb', ['-displayfd', '3', '-screen', '0', '800x600x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
      children.push(xvfb);
      const display = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Xvfb display readiness timeout')), 5000);
        xvfb.once('error', (e) => { clearTimeout(timer); reject(e); });
        xvfb.stdio[3]!.once('data', (data: Buffer) => { clearTimeout(timer); resolve(`:${data.toString().trim()}`); });
      });
      const env = { ...process.env, DISPLAY: display };
      const command = async (bin: string, args: string[]) => {
        try { return { status: 0, stdout: (await exec(bin, args, { env, timeout: 2000 })).stdout }; }
        catch (error) { return { status: 1, stdout: String((error as { stderr?: string }).stderr ?? error) }; }
      };
      const wm = spawn('/usr/bin/openbox', ['--sm-disable', '--startup', '/usr/bin/printf PC_FOCUS_WM_READY'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(wm);
      let wmError = '';
      wm.stderr!.on('data', (data: Buffer) => { wmError = (wmError + data.toString()).slice(-1500); });
      // _NET_SUPPORTING_WM_CHECK is published before startup finishes. Mapping
      // during that phase can lose the MapRequest. Use the WM's own startup
      // completion hook, not the early property, as the fixture readiness gate.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Openbox startup did not complete: ${wmError}`)), 5000);
        let output = '';
        wm.stdout!.on('data', (data: Buffer) => {
          output += data.toString();
          if (output.includes('PC_FOCUS_WM_READY')) { clearTimeout(timer); resolve(); }
        });
        wm.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      await vi.waitFor(async () => expect((await command('wmctrl', ['-m'])).status).toBe(0), { timeout: 5000 });
      await command('wmctrl', ['-n', '2']);
      await command('wmctrl', ['-s', '0']);
      const title = `pc-focus-fixture-${process.pid}`;
      const message = spawn('/usr/bin/xmessage', ['-title', title, '-fn', 'fixed', '-geometry', '260x100+40+40', 'Existing focus test window'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      children.push(message);
      let messageError = '';
      message.stderr!.on('data', (data: Buffer) => { messageError = (messageError + data.toString()).slice(-1500); });
      let id = '';
      try { await vi.waitFor(async () => {
        if (message.exitCode !== null || message.signalCode !== null) throw new Error(`xmessage exited (${message.exitCode}/${message.signalCode}): ${messageError}`);
        const ids = (await command('xdotool', ['search', '--name', `^${title}$`])).stdout.trim().split('\n');
        expect(ids, `window missing; xmessage stderr: ${messageError}`).toHaveLength(1);
        expect(ids[0]).toMatch(/^\d+$/); id = `0x${BigInt(ids[0]).toString(16)}`;
      }, { timeout: 5000 }); } catch (error) {
        throw new Error(`${String(error)}; display=${display}; wmExit=${wm.exitCode}; wmStderr=${wmError}; windows=${(await command('wmctrl', ['-l'])).stdout}; tree=${(await command('xwininfo', ['-root', '-tree'])).stdout.slice(-2500)}`);
      }
      const mapped = await command('xdotool', ['windowmap', id]);
      expect(mapped, `initial map request on ${display}: ${JSON.stringify(mapped)}`).toMatchObject({ status: 0 });
      await vi.waitFor(async () => {
        const state = await command('xprop', ['-id', id, '_NET_WM_DESKTOP', 'WM_STATE']);
        const map = await command('xwininfo', ['-id', id]);
        expect(state.stdout, `WM state: ${state.stdout}; map: ${map.stdout}`).toMatch(/CARDINAL.*=\s*\d+/);
        expect(map.stdout).toContain('Map State: IsViewable');
      }, { timeout: 5000 });
      const check = async (desktop: number) => {
        expect((await command('xprop', ['-root', '_NET_CURRENT_DESKTOP'])).stdout).toContain(`= ${desktop}`);
        expect((await command('xprop', ['-id', id, '_NET_WM_DESKTOP'])).stdout).toContain(`= ${desktop}`);
        expect(sameX11WindowId((await command('xdotool', ['getactivewindow'])).stdout, id)).toBe(true);
        expect((await command('xwininfo', ['-id', id])).stdout).toContain('Map State: IsViewable');
      };
      await command('wmctrl', ['-ir', id, '-t', '1']);
      expect(await focusWindowId(id, { runCommand: command })).toBe(true);
      await check(0);
      await command('wmctrl', ['-ir', id, '-t', '1']);
      expect(await focusWindowId(id, { runCommand: command, workspace: 'window' })).toBe(true);
      await check(1);
      await command('xdotool', ['windowminimize', id]);
      expect(await focusWindowId(id, { runCommand: command })).toBe(true);
      await check(1);
    } finally {
      for (const child of children.reverse()) {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        const deadline = setTimeout(() => child.kill('SIGKILL'), 1500);
        child.kill('SIGTERM');
        await exited;
        clearTimeout(deadline);
      }
    }
  }, 20000);
});
