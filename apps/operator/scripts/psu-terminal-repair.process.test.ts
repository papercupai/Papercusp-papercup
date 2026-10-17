// @vitest-environment node
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeLateInspectorWhenAvailable } from './psu-terminal-repair.mjs';
import { discoverInspector } from '../../../scripts/cdp-inspector.mjs';

describe('late terminal inspector cleanup process boundary', () => {
  it.skipIf(process.platform !== 'linux')('closes a late real inspector without replacing or stopping its process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-late-inspector-'));
    const file = join(root, 'psu-launcher.mjs');
    writeFileSync(file, `import inspector from 'node:inspector';
      process.on('message', message => {
        if (message === 'open') setTimeout(() => {
          inspector.open(0, '127.0.0.1');
          process.send({ url: inspector.url() });
        }, 50);
        if (message === 'ping') process.send({ pid: process.pid, pong: true });
      });
      process.send({ ready: true, pid: process.pid });
    `);
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '' },
    });
    let url: string | undefined;
    let stderr = '';
    child.stderr?.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.on('message', (message: any) => { if (message.url) url = message.url; });
    try {
      const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
      expect(ready).toMatchObject({ ready: true, pid: child.pid });
      const stat = readFileSync('/proc/' + child.pid + '/stat', 'utf8');
      const started = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
      let polls = 0;
      const receipt = await closeLateInspectorWhenAvailable({
        pid: child.pid!, entry: file, started, maxWaitMs: 5000, pollIntervalMs: 10,
        discover: async () => {
          polls++;
          if (polls === 1) child.send('open');
          if (!url) return null;
          return discoverInspector({ startPort: Number(new URL(url).port), portCount: 1 });
        },
      });
      expect(receipt, stderr).toMatchObject({ closed: true });
      expect(polls).toBeGreaterThan(1);
      expect(url).toBeDefined();
      expect(await discoverInspector({ startPort: Number(new URL(url!).port), portCount: 1 })).toBeNull();
      expect(child.exitCode).toBeNull();
      const pong = once(child, 'message', { signal: AbortSignal.timeout(3000) });
      child.send('ping');
      expect((await pong)[0]).toEqual({ pid: child.pid, pong: true });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
