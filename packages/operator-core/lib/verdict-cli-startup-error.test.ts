/**
 * EI-20110538428919633 regression guard — verdict-cli must preserve a daemon's
 * actionable stderr when startup times out instead of reporting only a generic
 * 15-second deadline. The dependency is patched through patch-package, so this
 * test launches the installed CLI and replaces only the spawned `node` command
 * with a deterministic failing daemon fixture.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

describe('verdict-cli startup diagnostics (EI-20110538428919633)', () => {
  it('includes a failed daemon stderr tail in the startup error', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-startup-error-'));
    const fakeNode = join(fixtureRoot, 'node');
    const dataDir = join(fixtureRoot, 'data');
    const sentinel = "browserType.launch: Executable doesn't exist at /tmp/chromium";

    try {
      await writeFile(
        fakeNode,
        `#!/usr/bin/env bash
printf '%s\\n' "$VERDICT_TEST_SENTINEL" 'Please run: npx playwright install' >&2
exit 1
`,
        'utf8',
      );
      await chmod(fakeNode, 0o755);

      let failure: unknown = null;
      try {
        await execFileAsync(
          process.execPath,
          [require.resolve('verdict-cli/bin/browse.mjs'), 'status'],
          {
            env: {
              ...process.env,
              PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
              VERDICT_DATA_DIR: dataDir,
              VERDICT_START_TIMEOUT_MS: '750',
              VERDICT_TEST_SENTINEL: sentinel,
              VERDICT_SESSION: '',
              PAPERCUSP_SID: '',
              CODEX_SESSION_ID: '',
            },
            maxBuffer: 32 * 1024,
            timeout: 20_000,
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).not.toBeNull();
      const stderr =
        typeof failure === 'object' && failure !== null && 'stderr' in failure
          ? String((failure as { stderr?: unknown }).stderr ?? '')
          : '';
      expect(stderr).toContain('Server failed to start within 750ms');
      expect(stderr).toContain('--- server stderr ---');
      expect(stderr).toContain(sentinel);
      expect(stderr).toContain('npx playwright install');

      const cliSource = await readFile(require.resolve('verdict-cli/bin/browse.mjs'), 'utf8');
      expect(cliSource).toContain(': 30_000;');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 5_000);

  it('rejects an unknown command before spawning the persistent daemon', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-unknown-command-'));
    const fakeNode = join(fixtureRoot, 'node');
    const dataDir = join(fixtureRoot, 'data');
    const markerFile = join(fixtureRoot, 'daemon-was-spawned.marker');

    try {
      await writeFile(
        fakeNode,
        `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, String(process.pid));
`,
        'utf8',
      );
      await chmod(fakeNode, 0o755);

      let failure: unknown = null;
      try {
        await execFileAsync(
          process.execPath,
          [require.resolve('verdict-cli/bin/browse.mjs'), '--help'],
          {
            env: {
              ...process.env,
              PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
              VERDICT_DATA_DIR: dataDir,
              VERDICT_SESSION: '',
              PAPERCUSP_SID: '',
              CODEX_SESSION_ID: '',
            },
            maxBuffer: 32 * 1024,
            timeout: 5_000,
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).not.toBeNull();
      const stderr =
        typeof failure === 'object' && failure !== null && 'stderr' in failure
          ? String((failure as { stderr?: unknown }).stderr ?? '')
          : '';
      expect(stderr).toContain('Unknown command: --help');
      expect(stderr).toContain('verdict (with no command) for usage');
      await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(dataDir, 'verdict.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('isolates Papercusp agent clients by their implicit session identity', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-session-isolation-'));
    const fakeNode = join(fixtureRoot, 'node');
    const dataDir = join(fixtureRoot, 'data');
    const daemonPids: number[] = [];

    try {
      await writeFile(
        fakeNode,
        `#!${process.execPath}
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const dataDir = process.env.VERDICT_DATA_DIR;
const session = process.env.VERDICT_SESSION || '';
const stateDir = session ? resolve(dataDir, 'sessions', session) : dataDir;
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  res.writeHead(200);
  res.end('session=' + session);
});
server.listen(0, '127.0.0.1', () => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, 'verdict.json'), JSON.stringify({
    port: server.address().port,
    token: 'fixture-token',
    pid: process.pid,
    started: new Date().toISOString(),
  }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
        'utf8',
      );
      await chmod(fakeNode, 0o755);

      const run = (sid: string) =>
        execFileAsync(process.execPath, [require.resolve('verdict-cli/bin/browse.mjs'), 'status'], {
          env: {
            ...process.env,
            PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
            VERDICT_DATA_DIR: dataDir,
            VERDICT_SESSION: '',
            PAPERCUSP_SID: sid,
            CODEX_SESSION_ID: '',
            VERDICT_START_TIMEOUT_MS: '3000',
          },
          maxBuffer: 32 * 1024,
          timeout: 8_000,
        });

      const [agentA, agentB] = await Promise.all([run('agent-a'), run('agent-b')]);
      expect(agentA.stdout).toContain('session=agent-a');
      expect(agentB.stdout).toContain('session=agent-b');

      const agentAState = JSON.parse(
        await readFile(join(dataDir, 'sessions', 'agent-a', 'verdict.json'), 'utf8'),
      ) as { pid: number };
      const agentBState = JSON.parse(
        await readFile(join(dataDir, 'sessions', 'agent-b', 'verdict.json'), 'utf8'),
      ) as { pid: number };
      daemonPids.push(agentAState.pid, agentBState.pid);
      expect(agentAState.pid).not.toBe(agentBState.pid);
      await expect(readFile(join(dataDir, 'verdict.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      for (const sid of ['agent-a', 'agent-b']) {
        try {
          const state = JSON.parse(
            await readFile(join(dataDir, 'sessions', sid, 'verdict.json'), 'utf8'),
          ) as { pid: number };
          daemonPids.push(state.pid);
        } catch {
          // The fixture may have failed before it wrote its state file.
        }
      }
      for (const pid of new Set(daemonPids)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The fixture daemon may already have exited during test teardown.
        }
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 12_000);

  it('reports a normal stop when a named session closes its response socket', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-session-stop-'));
    const dataDir = join(fixtureRoot, 'data');
    const sessionName = 'socket-close';
    let requestCount = 0;
    const server = createServer((req) => {
      requestCount += 1;
      req.resume();
      req.once('end', () => req.socket.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
      await mkdir(join(dataDir, 'sessions', sessionName), { recursive: true });
      await writeFile(
        join(dataDir, 'sessions', sessionName, 'verdict.json'),
        JSON.stringify({
          port: address.port,
          token: 'fixture-token',
          pid: process.pid,
          started: new Date().toISOString(),
        }),
        'utf8',
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        [require.resolve('verdict-cli/bin/browse.mjs'), 'sessions', 'stop', sessionName],
        {
          env: {
            ...process.env,
            VERDICT_DATA_DIR: dataDir,
            VERDICT_SESSION: '',
            PAPERCUSP_SID: '',
            CODEX_SESSION_ID: '',
          },
          maxBuffer: 32 * 1024,
          timeout: 8_000,
        },
      );

      expect(stdout).toBe(`Session "${sessionName}" stopped.\n`);
      expect(stdout).not.toContain('was not responding');
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('clears console evidence when the active page navigates', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-navigation-evidence-'));
    const dataDir = join(fixtureRoot, 'data');
    const env = {
      ...process.env,
      VERDICT_DATA_DIR: dataDir,
      VERDICT_SESSION: 'navigation-evidence',
      PAPERCUSP_SID: '',
      CODEX_SESSION_ID: '',
      VERDICT_START_TIMEOUT_MS: '5000',
      VERDICT_IDLE_TIMEOUT: '60000',
    };
    const run = (command: string, ...args: string[]) =>
      execFileAsync(process.execPath, [require.resolve('verdict-cli/bin/browse.mjs'), command, ...args], {
        env,
        maxBuffer: 32 * 1024,
        timeout: 12_000,
      });

    try {
      await run('goto', 'data:text/html,<script>console.log("NAV-A-CONSOLE")</script><body>A</body>');
      await run('goto', 'data:text/html,<script>console.log("NAV-B-CONSOLE")</script><body>B</body>');
      const { stdout } = await run('console');

      expect(stdout).not.toContain('NAV-A-CONSOLE');
      expect(stdout).toContain('NAV-B-CONSOLE');
    } finally {
      await run('stop').catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('bounds networkidle waits so a chain returns after DOMContentLoaded', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-networkidle-bound-'));
    const dataDir = join(fixtureRoot, 'data');
    const sessionName = 'networkidle-bound';
    const sockets = new Set<{ destroy(): void }>();
    const server = createServer((req, res) => {
      sockets.add(req.socket);
      req.socket.once('close', () => sockets.delete(req.socket));

      if (req.url === '/pending') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('intentionally pending');
        return;
      }

      const pageName =
        req.url === '/one' ? 'CHAIN-PAGE-ONE' : req.url === '/two' ? 'CHAIN-PAGE-TWO' : null;
      if (!pageName) {
        res.writeHead(404);
        res.end('missing');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!doctype html><body>${pageName}</body>` +
          `<script>fetch('/pending', { cache: 'no-store' });</script>`,
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const env = {
        ...process.env,
        VERDICT_DATA_DIR: dataDir,
        VERDICT_SESSION: sessionName,
        PAPERCUSP_SID: '',
        CODEX_SESSION_ID: '',
        VERDICT_START_TIMEOUT_MS: '5000',
        VERDICT_IDLE_TIMEOUT: '60000',
        VERDICT_NETWORK_IDLE_TIMEOUT_MS: '100',
      };
      const run = (command: string, ...args: string[]) =>
        execFileAsync(
          process.execPath,
          [require.resolve('verdict-cli/bin/browse.mjs'), command, ...args],
          { env, maxBuffer: 32 * 1024, timeout: 10_000 },
        );

      // Warm the daemon so this assertion measures the per-navigation wait,
      // rather than browser startup.
      await run('status');
      const chain = JSON.stringify([
        ['goto', `${baseUrl}/one`],
        ['url'],
        ['goto', `${baseUrl}/two`],
        ['js', 'document.body.innerText'],
      ]);
      const startedAt = Date.now();
      const { stdout } = await run('chain', chain);
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(5_000);
      expect(stdout).toContain(`goto: Navigated to ${baseUrl}/one`);
      expect(stdout).toContain(`url: ${baseUrl}/one`);
      expect(stdout).toContain(`goto: Navigated to ${baseUrl}/two`);
      expect(stdout).toContain('js: CHAIN-PAGE-TWO');
    } finally {
      await execFileAsync(
        process.execPath,
        [require.resolve('verdict-cli/bin/browse.mjs'), 'stop'],
        {
          env: {
            ...process.env,
            VERDICT_DATA_DIR: dataDir,
            VERDICT_SESSION: sessionName,
            PAPERCUSP_SID: '',
            CODEX_SESSION_ID: '',
          },
          maxBuffer: 32 * 1024,
          timeout: 10_000,
        },
      ).catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('returns a failing CLI status while preserving diagnostics when a nested command throws', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-chain-error-status-'));
    const dataDir = join(fixtureRoot, 'data');
    const sessionName = 'chain-error-status';
    const env = {
      ...process.env,
      VERDICT_DATA_DIR: dataDir,
      VERDICT_SESSION: sessionName,
      PAPERCUSP_SID: '',
      CODEX_SESSION_ID: '',
      VERDICT_START_TIMEOUT_MS: '5000',
      VERDICT_IDLE_TIMEOUT: '60000',
    };
    const run = (command: string, ...args: string[]) =>
      execFileAsync(
        process.execPath,
        [require.resolve('verdict-cli/bin/browse.mjs'), command, ...args],
        { env, maxBuffer: 32 * 1024, timeout: 12_000 },
      );

    try {
      // Warm the daemon so the assertion covers chain status propagation, not
      // startup failure handling.
      await run('status');
      const chain = JSON.stringify([
        ['js', "throw new Error('CHAIN-JS-FAIL')"],
        ['url'],
      ]);

      let failure: unknown = null;
      try {
        await run('chain', chain);
      } catch (error) {
        failure = error;
      }

      expect(failure).not.toBeNull();
      const err = failure as { code?: number; stderr?: unknown };
      expect(err.code).not.toBe(0);
      const stderr = String(err.stderr ?? '');
      expect(stderr).toContain('js: Error:');
      expect(stderr).toContain('CHAIN-JS-FAIL');
      // The chain continues and the failing response still carries the
      // bounded per-command transcript, rather than only a generic HTTP error.
      expect(stderr).toContain('url: about:blank');
    } finally {
      await run('stop').catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 25_000);

  it('exits after a successful first command while the detached daemon stays alive', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-startup-unref-'));
    const fakeNode = join(fixtureRoot, 'node');
    const dataDir = join(fixtureRoot, 'data');
    let daemonPid: number | null = null;

    try {
      await writeFile(
        fakeNode,
        `#!${process.execPath}
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const dataDir = process.env.VERDICT_DATA_DIR;
const token = 'fixture-token';
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  res.writeHead(200);
  res.end('fixture-ready');
});
server.listen(0, '127.0.0.1', () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, 'verdict.json'), JSON.stringify({
    port: server.address().port,
    token,
    pid: process.pid,
    started: new Date().toISOString(),
  }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
        'utf8',
      );
      await chmod(fakeNode, 0o755);

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [require.resolve('verdict-cli/bin/browse.mjs'), 'status'],
        {
          env: {
            ...process.env,
            PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
            VERDICT_DATA_DIR: dataDir,
            VERDICT_START_TIMEOUT_MS: '3000',
            VERDICT_SESSION: '',
            PAPERCUSP_SID: '',
            CODEX_SESSION_ID: '',
          },
          maxBuffer: 32 * 1024,
          timeout: 5_000,
        },
      );

      expect(stdout).toContain('fixture-ready');
      expect(stderr).toContain('Server ready');
      const state = JSON.parse(await readFile(join(dataDir, 'verdict.json'), 'utf8')) as {
        pid: number;
      };
      daemonPid = state.pid;
      expect(() => process.kill(state.pid, 0)).not.toThrow();
    } finally {
      if (daemonPid !== null) {
        try {
          process.kill(daemonPid, 'SIGTERM');
        } catch {
          // The fixture daemon may already have exited during test teardown.
        }
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('keeps frame realms distinct and never retains a frame after a failed selector', async () => {
    // EI-22165824068092618. Two defects compounded into a wrong ANSWER rather
    // than an error: `frame` stashed the top page as `page._mainPage` and then
    // reassigned `page` to a Playwright Frame, which does not carry that
    // property — so `frame-exit` was a permanent no-op. The next `frame`
    // selector was then evaluated INSIDE the frame we never left, could not
    // match, and silently kept it. Two probes of two "different" panes both
    // measured the first pane and read as independent corroboration.
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-frame-realm-'));
    const dataDir = join(fixtureRoot, 'data');
    const env = {
      ...process.env,
      VERDICT_DATA_DIR: dataDir,
      VERDICT_SESSION: 'frame-realm-guard',
      PAPERCUSP_SID: '',
      CODEX_SESSION_ID: '',
      VERDICT_START_TIMEOUT_MS: '5000',
      VERDICT_IDLE_TIMEOUT: '60000',
      // Also exercises the bounded-timeout escape hatch; the default is 5s.
      VERDICT_FRAME_TIMEOUT_MS: '1000',
    };
    const run = (command: string, ...args: string[]) =>
      execFileAsync(
        process.execPath,
        [require.resolve('verdict-cli/bin/browse.mjs'), command, ...args],
        { env, maxBuffer: 32 * 1024, timeout: 20_000 },
      );

    try {
      await writeFile(join(fixtureRoot, 'a.html'), '<!doctype html><body><h1>PANE-A</h1></body>', 'utf8');
      await writeFile(join(fixtureRoot, 'b.html'), '<!doctype html><body><h1>PANE-B</h1></body>', 'utf8');
      await writeFile(
        join(fixtureRoot, 'host.html'),
        '<!doctype html><body><iframe id="a" src="a.html"></iframe>' +
          '<iframe id="b" src="b.html"></iframe></body>',
        'utf8',
      );
      await run('goto', `file://${join(fixtureRoot, 'host.html')}`);

      await run('frame', 'iframe#a');
      const paneA = await run('js', 'document.body.innerText');
      await run('frame-exit');
      await run('frame', 'iframe#b');
      const paneB = await run('js', 'document.body.innerText');

      // The regression assertion: before the fix BOTH of these read PANE-A.
      expect(paneA.stdout).toContain('PANE-A');
      expect(paneB.stdout).toContain('PANE-B');
      expect(paneB.stdout).not.toContain('PANE-A');

      // A selector that cannot match must fail LOUDLY (non-zero exit) and drop
      // back to the top document instead of leaving us pointed at pane A.
      await run('frame-exit');
      await run('frame', 'iframe#a');
      let failure: unknown = null;
      try {
        await run('frame', 'iframe#does-not-exist');
      } catch (error) {
        failure = error;
      }
      expect(failure).not.toBeNull();
      const stderr =
        typeof failure === 'object' && failure !== null && 'stderr' in failure
          ? String((failure as { stderr?: unknown }).stderr ?? '')
          : '';
      expect(stderr).toContain('no match for iframe#does-not-exist');
      expect(stderr).toContain('reset to top document');

      const afterFailure = await run('js', 'document.body.innerText');
      expect(afterFailure.stdout).not.toContain('PANE-A');
      expect(afterFailure.stdout).not.toContain('PANE-B');

      // Calibration: the instrument still works after the failure, so the two
      // negative assertions above cannot pass merely because probing broke.
      await run('frame', 'iframe#b');
      const recovered = await run('js', 'document.body.innerText');
      expect(recovered.stdout).toContain('PANE-B');
    } finally {
      await run('stop').catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('imports Chrome v11 encrypted cookies through TMPDIR and removes the temporary copy', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-chrome-cookie-import-'));
    const dataDir = join(fixtureRoot, 'data');
    const binDir = join(fixtureRoot, 'bin');
    const cookieDb = join(fixtureRoot, 'Cookies');
    const cookieTempDir = join(fixtureRoot, 'cookie-tmp');
    const copyPathRecord = join(fixtureRoot, 'cookie-copy-path');
    const hostKey = 'workatastartup.com';
    const cookieValue = 'fixture-v11-cookie-value';
    const chromeSecret = 'fixture-chrome-libsecret-password';
    const key = pbkdf2Sync(Buffer.from(chromeSecret, 'utf8'), Buffer.from('saltysalt'), 1, 16, 'sha1');
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const encryptedPayload = Buffer.concat([
      createHash('sha256').update(hostKey, 'utf8').digest(),
      Buffer.from(cookieValue, 'utf8'),
    ]);
    const encryptedValue = Buffer.concat([
      Buffer.from('v11', 'ascii'),
      cipher.update(encryptedPayload),
      cipher.final(),
    ]).toString('hex');

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'secret-tool'),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${chromeSecret}\n`)});\n`,
      'utf8',
    );
    await chmod(join(binDir, 'secret-tool'), 0o755);
    await execFileAsync(
      'sqlite3',
      [
        cookieDb,
        [
          'CREATE TABLE cookies(name TEXT,value TEXT,encrypted_value BLOB,host_key TEXT,path TEXT,is_secure INTEGER,is_httponly INTEGER);',
          `INSERT INTO cookies VALUES ('sid', '', X'${encryptedValue}', '${hostKey}', '/', 1, 0);`,
        ].join(' '),
      ],
      { maxBuffer: 32 * 1024 },
    );

    const sqliteBinary = (await execFileAsync('which', ['sqlite3'])).stdout.trim();
    await mkdir(cookieTempDir);
    await writeFile(
      join(binDir, 'sqlite3'),
      `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
writeFileSync(${JSON.stringify(copyPathRecord)}, process.argv[3]);
const result = spawnSync(${JSON.stringify(sqliteBinary)}, process.argv.slice(2), { encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`,
      'utf8',
    );
    await chmod(join(binDir, 'sqlite3'), 0o755);

    const env = {
      ...process.env,
      TMPDIR: cookieTempDir,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      VERDICT_DATA_DIR: dataDir,
      VERDICT_CHROME_COOKIE_DB: cookieDb,
      VERDICT_SESSION: 'chrome-cookie-import',
      PAPERCUSP_SID: '',
      CODEX_SESSION_ID: '',
      VERDICT_START_TIMEOUT_MS: '5000',
      VERDICT_IDLE_TIMEOUT: '60000',
    };
    const run = (command: string, ...args: string[]) =>
      execFileAsync(
        process.execPath,
        [require.resolve('verdict-cli/bin/browse.mjs'), command, ...args],
        { env, maxBuffer: 32 * 1024, timeout: 15_000 },
      );

    try {
      const imported = await run('cookie-import', hostKey);
      expect(imported.stdout).toContain(`Imported 1 cookies for ${hostKey}`);
      const copiedPath = await readFile(copyPathRecord, 'utf8');
      expect(dirname(copiedPath)).toBe(cookieTempDir);
      await expect(readFile(copiedPath)).rejects.toMatchObject({ code: 'ENOENT' });

      const cookies = await run('cookies', `https://${hostKey}/`);
      expect(cookies.stdout).toContain(`sid=${cookieValue}`);
    } finally {
      await run('stop').catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
