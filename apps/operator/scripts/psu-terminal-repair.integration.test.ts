// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyTerminalIdentityRepair, LEGACY_IDENTITY_FUNCTION } from './psu-terminal-repair.mjs';
import { closeInspector, createCdpClient, discoverInspector } from '../../../scripts/cdp-inspector.mjs';

describe('terminal identity repair adoption', () => {
  it.skipIf(process.platform !== 'linux')('keeps SIGUSR1 inspector publication off stderr when HTTP-only mode is enabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-safe-inspector-'));
    const file = join(root, 'psu-launcher.mjs');
    writeFileSync(file, `setInterval(() => process.send?.({ debugPort: process.debugPort }), 20);\n`);
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, NODE_OPTIONS: '--inspect-publish-uid=http --inspect-port=0' },
    });
    let stderr = '';
    child.stderr?.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    let port = 0;
    const portReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SIGUSR1 did not open an inspector')), 5000);
      child.on('message', (message: any) => {
        if (Number.isInteger(message?.debugPort) && message.debugPort > 0) {
          port = message.debugPort;
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`fixture exited ${code}`)); });
    });
    let client: ReturnType<typeof createCdpClient> | undefined;
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      process.kill(child.pid!, 'SIGUSR1');
      await portReady;
      expect(stderr).not.toMatch(/Debugger listening|For help, see:/);
      const target = await discoverInspector({ startPort: port, portCount: 1 });
      expect(target).toBeTruthy();
      client = createCdpClient(target!.wsUrl, { requestTimeoutMs: 3000 });
      await client.connect();
      await closeInspector(client, target!.port);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it.skipIf(process.platform !== 'linux')('updates a captured ESM callback in a real live process without replacing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-identity-adoption-'));
    const file = join(root, 'legacy.mjs');
    // Keep this real-process probe in the integration suite so its ledger proof
    // records the boundary it exercises. Global and local reads are independent
    // observations of V8 adopting the repair into an already captured callback.
    writeFileSync(file, `import { readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      globalThis.globalReads=0;
      const resolveLinuxCodexStartupPid=()=>process.pid;
      const codexThreadWriterHolder=(home,id,options)=>{
        if (options.readProcLocks) { options.readProcLocks(); globalThis.localReads=(globalThis.localReads||0)+1; }
        else globalThis.globalReads++;
        return {held:true,pid:process.pid,sessionId:'native-thread'};
      };
      ${LEGACY_IDENTITY_FUNCTION}
      globalThis.captured=()=>codexNativeIdForPty('/home',process.pid);
      process.stdout.write('MODULE_READY\\n');
      setInterval(()=>{},1000);
    `);
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let client: ReturnType<typeof createCdpClient> | undefined;
    let stderr = '';
    try {
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Module never reached readiness: ' + stderr)), 5000);
        let output = '';
        child.stdout.on('data', (data) => { output += data; if (output.includes('MODULE_READY')) { clearTimeout(timer); resolve(); } });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Fixture exited before readiness: ' + code + ' ' + stderr)); });
        child.once('error', reject);
      });
      const inspector = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Inspector not ready: ' + stderr)), 5000);
        child.stderr.on('data', (data) => { stderr += data; const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
        child.once('error', reject);
      });
      const [url] = await Promise.all([inspector, ready]);
      client = createCdpClient(url, { requestTimeoutMs: 3000 });
      await client.connect();
      const sample = async () => (await client!.evaluate('({pid:process.pid,result:captured(),globalReads,localReads:globalThis.localReads||0})', { returnByValue: true })).result.value;
      const before = await sample();
      expect(before).toMatchObject({ pid: child.pid, result: 'native-thread', globalReads: 1, localReads: 0 });
      const parsed: any[] = [];
      client.ws.on?.('message', (data: any) => { const m = JSON.parse(String(data)); if (m.method === 'Debugger.scriptParsed' && m.params.url === pathToFileURL(file).href) parsed.push(m.params); });
      await client.send('Debugger.enable');
      expect(parsed).toHaveLength(1);
      const scriptId = parsed[0].scriptId;
      const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId });
      const receipt = await applyTerminalIdentityRepair(client, { scriptId, source: scriptSource, apply: true });
      expect(receipt.applied).toBe(true);
      expect(await sample()).toMatchObject({ pid: before.pid, result: 'native-thread', globalReads: 1, localReads: 1 });
      expect((await applyTerminalIdentityRepair(client, { scriptId,
        source: (await client.send('Debugger.getScriptSource', { scriptId })).scriptSource, apply: true })).needed).toBe(false);
    } finally {
      client?.close();
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
