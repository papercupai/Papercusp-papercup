import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { nativeBootstrapEnvironment, runNativeVerifier, retainNativeDiagnostics, nativeHttpPhase, runNativeCommand, reloadNativeWorkbench } from './native-bootstrap-runtime';
import { verifierSourceFiles } from '../verifier-source';

const repo = resolve(import.meta.dirname, '../../../..');

describe('native bootstrap admission and lifecycle', () => {
  it('establishes one canonical group and preserves inherited attribution', () => {
    const env = nativeBootstrapEnvironment({ PAPERCUSP_WORKSPACE_ID: 'fixture' }, 'postgresql://fixture/ledger');
    expect(env.PAPERCUSP_TEST_RUN_GROUP).toMatch(/^dao-hr-native-[a-f0-9-]+$/);
    expect(env.PAPERCUSP_TEST_RUN_WORKSPACE).toBe('fixture');
    expect(nativeBootstrapEnvironment({ ...env, PAPERCUSP_WORKSPACE_ID: 'private-native-host' },
      env.PAPERCUSP_TEST_RUNS_DB_URL!)).toMatchObject({
      PAPERCUSP_TEST_RUN_GROUP: env.PAPERCUSP_TEST_RUN_GROUP,
      PAPERCUSP_TEST_RUN_WORKSPACE: 'fixture', PAPERCUSP_TEST_RUNS_DB_URL: env.PAPERCUSP_TEST_RUNS_DB_URL });
    expect(nativeBootstrapEnvironment({ ...env, PAPERCUSP_TEST_RUN_GROUP: 'outer-run' }, 'postgresql://fixture/ledger')
      .PAPERCUSP_TEST_RUN_GROUP).toBe('outer-run');
  });

  it('refuses missing ledger scope before allocation', () => {
    expect(() => nativeBootstrapEnvironment({}, 'postgresql://fixture/ledger')).toThrow('WORKSPACE');
    expect(() => nativeBootstrapEnvironment({ PAPERCUSP_WORKSPACE: 'fixture' }, '')).toThrow('DB_URL');
  });

  it('retains the exact native HTTP phase when a real peer closes the socket without retaining request secrets', async () => {
    const server = createServer((request, response) => { response.destroy(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const retained: object[] = [];
    try {
      await expect(nativeHttpPhase('sealed-document', async () => {
        const response = await fetch('http://127.0.0.1:' + address.port + '/private-contract?token=secret',
          { headers: { Authorization: 'Bearer secret' }, signal: AbortSignal.timeout(5000) });
        return response.arrayBuffer();
      }, diagnostic => retained.push(diagnostic))).rejects.toThrow('Native HTTP phase failed: sealed-document; errorCode=UND_ERR_SOCKET');
      expect(retained).toEqual([{ phase: 'sealed-document', errorCode: 'UND_ERR_SOCKET' }]);
      expect(JSON.stringify(retained)).not.toMatch(/secret|private-contract|127\.0\.0\.1/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('classifies body-read failures and preserves successful native HTTP results', async () => {
    const retained: object[] = [];
    const response = new Response(new ReadableStream({ start(controller) {
      controller.error(new Error('private provider response', { cause: { code: 'PRIVATE_TOKEN' } }));
    } }));
    await expect(nativeHttpPhase('audit-certificate', () => response.arrayBuffer(), diagnostic => retained.push(diagnostic)))
      .rejects.toThrow('Native HTTP phase failed: audit-certificate; errorCode=unclassified');
    expect(retained).toEqual([{ phase: 'audit-certificate', errorCode: 'unclassified' }]);
    expect(await nativeHttpPhase('wallet-rpc', async () => 'transaction-hash', diagnostic => retained.push(diagnostic)))
      .toBe('transaction-hash');
    expect(retained).toHaveLength(1);
  });

  it.each(['blocking', 'async'] as const)('distinguishes idle socket reuse from origin loss across %s native commands', async mode => {
    // The origin must run outside this event loop: native commands cannot pause
    // its idle timeout. Return a connection id to prove that it stayed alive.
    const server = spawn(process.execPath, ['-e', `
      const server = require('node:http').createServer((req, res) => {
        res.end(JSON.stringify({ connection: req.socket.connectionId }));
      });
      let connections = 0;
      server.on('connection', socket => { socket.connectionId = ++connections; });
      server.keepAliveTimeout = 5000;
      server.keepAliveTimeoutBuffer = 0;
      server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
      process.on('disconnect', () => { server.closeAllConnections(); server.close(); });
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, NODE_OPTIONS: '' } });
    const stopped = once(server, 'exit');
    try {
      const [{ port }] = await once(server, 'message', { signal: AbortSignal.timeout(5000) }) as [{ port: number }];
      const url = 'http://127.0.0.1:' + port;
      const read = async () => (await fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) })).json();
      const first = await read();
      await delay(25); // Let fetch release the consumed response into its pool.
      expect((await read()).connection, 'the control must actually reuse a warm connection').toBe(first.connection);
      await delay(25);
      const args = ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500)'];
      const options = { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 10_000 };
      if (mode === 'blocking') {
        execFileSync(process.execPath, args, options);
        await expect(read()).rejects.toMatchObject({ cause: { code: 'UND_ERR_SOCKET' } });
        // A fresh connection still succeeds: the origin did not exit.
        expect((await read()).connection).toBeGreaterThan(first.connection);
      } else {
        await runNativeCommand(process.execPath, args, { ...options, encoding: 'utf8' });
        expect((await read()).connection).toBeGreaterThan(first.connection);
      }
    } finally { server.kill(); await stopped; }
  }, 15_000);

  it('retains native command stdout, exit failures and deadlines without blocking its caller', async () => {
    const options = { encoding: 'utf8' as const, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 5000 };
    expect(await runNativeCommand(process.execPath, ['-e', 'process.stdout.write("native-result")'], options)).toBe('native-result');
    await expect(runNativeCommand(process.execPath, ['-e', 'process.exit(7)'], options)).rejects.toMatchObject({ code: 7 });
    await expect(runNativeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout: 100 }))
      .rejects.toMatchObject({ killed: true, signal: 'SIGTERM' });
  });

  function reloadFixture(states: Array<'old-document' | 'missing-router' | 'missing-workspace' | 'ready'>) {
    const document = (routerReady: boolean, workspaceReady: boolean) => ({
      window: routerReady ? { __TSR_ROUTER__: { navigate() {} } } : {},
      location: { href: 'https://native.fixture.invalid/daos?private=not-for-diagnostics' },
      document: { querySelector: () => workspaceReady ? {} : null },
    });
    let page = document(true, true);
    const observed: boolean[] = [], calls: string[][] = [];
    const failure = new Error('Native readiness deadline');
    const native = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === 'eval') return String(runInNewContext(args[1], page));
      if (args[0] === 'navigate') return '{"success":true}'; // The old document is still ready.
      if (args[0] === 'wait') {
        for (const state of states) {
          if (state !== 'old-document') page = document(state !== 'missing-router', state !== 'missing-workspace');
          const ready = Boolean(runInNewContext(args[2], page));
          observed.push(ready);
          if (ready) return 'true';
        }
        throw failure;
      }
      throw new Error('Unexpected native command');
    };
    return { native, observed, calls, failure };
  }

  it('waits for document replacement, router initialization and workspace render after native navigation acknowledges', async () => {
    const fixture = reloadFixture(['old-document', 'missing-router', 'missing-workspace', 'ready']);
    const diagnostics: object[] = [];
    await reloadNativeWorkbench(fixture.native, diagnostic => diagnostics.push(diagnostic));
    expect(fixture.observed).toEqual([false, false, false, true]);
    expect(fixture.calls.map(call => call[0])).toEqual(['eval', 'navigate', 'wait']);
    expect(fixture.calls[1]).toEqual(['navigate', 'https://native.fixture.invalid/daos?private=not-for-diagnostics', '--json']);
    expect(fixture.calls[2].slice(3)).toEqual(['--timeout', '60000', '--interval', '500']);
    expect(diagnostics).toEqual([]);
  });

  it.each(['old-document', 'missing-router', 'missing-workspace'] as const)('refuses a reload stuck at %s and retains safe readiness evidence', async state => {
    const fixture = reloadFixture([state]);
    const diagnostics: object[] = [];
    await expect(reloadNativeWorkbench(fixture.native, diagnostic => diagnostics.push(diagnostic))).rejects.toBe(fixture.failure);
    expect(fixture.observed).toEqual([false]);
    expect(diagnostics).toEqual([{ phase: 'reload-ready', state: {
      documentReplaced: state !== 'old-document', routerReady: state !== 'missing-router', workspaceReady: state !== 'missing-workspace',
    } }]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|native\.fixture|https:/);
  });

  it('retains failed verifier assertion snapshots through scratch teardown without copying credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-diagnostic-retention-'));
    const scratch = join(dir, 'private'), evidence = join(dir, 'evidence');
    mkdirSync(scratch); mkdirSync(evidence);
    const result = join(scratch, 'result.json'), log = join(evidence, 'native.log');
    const suffixes = ['.text-failure.json', '.response-failure.json', '.wallet-render-failure.json',
      '.completion-response.json', '.control-failure.json', '.http-failure.json', '.navigation-failure.json'];
    const snapshots = [
      ...suffixes.slice(0, 3).map((suffix, i) => ({ failure: suffix, step: i, text: 'Native candidate' })),
      { status: 409, ok: false, error: 'invalid_completion',
        completion: { check: 'envelope_schema', providerStatus: 'PENDING', invalidFields: ['completedAt'] } },
      { scope: 'onboarding', control: 'Wallet signature', controls: [], alerts: [] },
      { phase: 'sealed-document', errorCode: 'UND_ERR_SOCKET' },
      { phase: 'reload-ready', state: { documentReplaced: true, routerReady: false, workspaceReady: false } },
    ];
    writeFileSync(join(scratch, 'native-config.json'), '{"privateKey":"secret"}');
    writeFileSync(join(scratch, 'candidate-provider.json'), '{"cookies":["secret"]}');
    writeFileSync(log + suffixes[0], 'stale', { mode: 0o644 });
    try {
      try {
        const code = await runNativeVerifier(process.execPath, ['-e',
          `const fs=require('node:fs'); ${JSON.stringify(suffixes)}.forEach((suffix,i)=>fs.writeFileSync(${JSON.stringify(result)}+suffix,JSON.stringify(${JSON.stringify(snapshots)}[i]))); process.exitCode=1;`],
        { signal: new AbortController().signal, timeoutMs: 10_000, stdio: 'ignore' });
        expect(code).toBe(1);
        throw new Error('native assertion failed');
      } finally {
        expect(retainNativeDiagnostics(result, log)).toEqual(suffixes.map(suffix =>
          ({ suffix, status: 'retained', path: log + suffix })));
        rmSync(scratch, { recursive: true, force: true });
      }
    } catch (error) {
      expect((error as Error).message).toBe('native assertion failed');
      expect(existsSync(scratch)).toBe(false);
      expect(readdirSync(evidence).sort()).toEqual(suffixes.map(suffix => 'native.log' + suffix).sort());
      for (const [i, suffix] of suffixes.entries()) {
        expect(JSON.parse(readFileSync(log + suffix, 'utf8'))).toEqual(snapshots[i]);
        expect(statSync(log + suffix).mode & 0o777).toBe(0o600);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('bounds diagnostic retention and leaves missing snapshots optional', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-diagnostic-bounds-'));
    const result = join(dir, 'result.json'), log = join(dir, 'native.log');
    try {
      expect(retainNativeDiagnostics(result, log)).toEqual([]);
      writeFileSync(result + '.text-failure.json', Buffer.alloc(1024 * 1024 + 1));
      mkdirSync(result + '.response-failure.json');
      writeFileSync(join(dir, 'private-config.json'), 'secret');
      symlinkSync(join(dir, 'private-config.json'), result + '.wallet-render-failure.json');
      expect(retainNativeDiagnostics(result, log)).toEqual([
        { suffix: '.text-failure.json', status: 'skipped', reason: 'exceeds-1MiB' },
        { suffix: '.response-failure.json', status: 'skipped', reason: 'not-regular-file' },
        { suffix: '.wallet-render-failure.json', status: 'error', reason: 'ELOOP' },
      ]);
      expect(readdirSync(dir).some(name => name.startsWith('native.log'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('checks the DAO assertion run group before native preparation', () => {
    const assertion = join(repo, 'scripts/tauri-surface-verify-dao-hr.mts');
    const required = readFileSync(assertion, 'utf8').match(/REQUIRED_ENV=(.*)/)![1].split(',');
    const env = { ...process.env, ...Object.fromEntries(required.map(key => [key, 'fixture'])),
      PAPERCUSP_TEST_RUN_GROUP: '' };
    let failure: { status: number; stderr: Buffer } | undefined;
    try { execFileSync(process.execPath, [join(repo, 'scripts/lib/verify-tauri-assertion-env.mjs'),
      '--command', 'node', '--import', 'tsx', assertion], { env, stdio: 'pipe' }); }
    catch (error) { failure = error as typeof failure; }
    expect(failure?.status).toBe(2);
    expect(String(failure?.stderr)).toContain('PAPERCUSP_TEST_RUN_GROUP is required before verifier preparation');
  });

  it.each(['cancel', 'deadline'] as const)('joins a verifier and its grandchild on %s', async mode => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-verifier-lifecycle-'));
    const ready = join(dir, 'ready'), leaked = join(dir, 'late-effect');
    const controller = new AbortController();
    const grandchild = `process.on('SIGTERM', () => {
      setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(leaked)}, 'leaked'), 500);
    }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],
      { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    try {
      const running = runNativeVerifier(process.execPath, ['-e', parent], {
        signal: controller.signal, timeoutMs: 10_000,
        killGraceMs: 50, stdio: 'ignore' });
      // Attach immediately so a deadline cannot become an unhandled rejection.
      const outcome = running.catch(error => error as Error);
      const started = Date.now();
      while (!existsSync(ready) && Date.now() - started < 8000) await delay(25);
      expect(existsSync(ready)).toBe(true);
      if (mode === 'cancel') controller.abort();
      expect(await outcome).toMatchObject({ message: expect.stringMatching(mode === 'cancel' ? /cancelled/ : /budget/) });
      await delay(700);
      expect(existsSync(leaked), 'a descendant must not write after joined teardown').toBe(false);
    } finally {
      controller.abort();
      // The deliberately hostile fixture must also be cleaned when the guard regresses.
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('refuses an already cancelled or exhausted launch without starting a child', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runNativeVerifier('does-not-exist', [], { signal: controller.signal, timeoutMs: 10 }))
      .rejects.toThrow();
    await expect(runNativeVerifier('does-not-exist', [], { signal: new AbortController().signal, timeoutMs: 0 }))
      .rejects.toThrow('preparation budget');
  });

  it.each(['prepare', 'boot', 'assert'] as const)('enforces a separate %s phase budget and retains its output', async phase => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-verifier-phase-'));
    const log = join(dir, 'output.log'), fd = openSync(log, 'w');
    const controller = new AbortController();
    // Repeated markers simulate noisy progress; they must never renew a phase.
    const marker = phase === 'prepare' ? '' : `console.error('VH_BEGIN phase=${phase}');`;
    const program = marker + `setInterval(() => { ${marker} }, 10);`;
    try {
      await expect(runNativeVerifier(process.execPath, ['-e', program], {
        signal: controller.signal, timeoutMs: 10_000, killGraceMs: 25, logFd: fd,
        phaseBudgetsMs: { prepare: phase === 'prepare' ? 250 : 8000, boot: 150, assert: 150 },
      })).rejects.toThrow(`Native verifier ${phase} phase exceeded`);
      if (phase !== 'prepare') {
        const output = readFileSync(log, 'utf8');
        expect(output.match(new RegExp(`VH_BEGIN phase=${phase}`, 'g'))!.length).toBeGreaterThan(1);
      }
    } finally { controller.abort(); closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);

  it.each(['disabled', 'retention-failed', 'missing'] as const)(
    'advances verifier deadlines when optional instrumentation is %s', async mode => {
      const dir = mkdtempSync(join(tmpdir(), 'daohr-verifier-uninstrumented-'));
      const log = join(dir, 'output.log'), fd = openSync(log, 'w');
      const controller = new AbortController();
      const shell = readFileSync(join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
      // Execute the real initialization and section boundaries, including vh.sh's
      // fail-open path. A synthetic marker producer would miss this coupling.
      const start = shell.indexOf('# ── Verification-harness contract');
      const end = shell.indexOf("\ntrap 'handle_signal INT' INT", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const section = (phase: string) => {
        const call = shell.match(new RegExp(`^(?:verifier_begin_phase|vh_begin) ${phase}$`, 'm'));
        expect(call, `real ${phase} section boundary`).not.toBeNull();
        return call![0];
      };
      const program = ['set -eu', shell.slice(start, end),
        'printf "OPTIONAL_DISABLED=%s\\n" "${VH_DISABLED:-missing}"',
        'sleep 2', section('boot'), 'sleep 2', section('assert'), 'sleep 2'].join('\n');
      try {
        await expect(runNativeVerifier('bash', ['-c', program], {
          signal: controller.signal, timeoutMs: 15_000, killGraceMs: 25, logFd: fd,
          phaseBudgetsMs: { prepare: 3000, boot: 3000, assert: 3000 },
          env: { ...process.env, REPO_DIR: mode === 'missing' ? dir : repo,
            VH_DISABLE: mode === 'disabled' ? '1' : '0', VH_FAIL_OPEN: '1',
            VH_TSX: '/bin/false', VERIFY_TAURI_EVIDENCE_ROOT: join(dir, 'evidence'),
            VERIFY_TAURI_SOURCE_REF: '' },
        })).resolves.toBe(0);
        const output = readFileSync(log, 'utf8');
        for (const phase of ['prepare', 'boot', 'assert']) expect(output).toContain(`VH_BEGIN phase=${phase}`);
        expect(output).toContain(`OPTIONAL_DISABLED=${mode === 'missing' ? 'missing' : '1'}`);
        expect(output).not.toMatch(/^HARNESS_RESULT(?:\s|$)/m);
        if (mode === 'retention-failed') expect(output).toContain('reason=retention-command-failed');
      } finally { controller.abort(); closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
    }, 20_000);
});

describe('nested frozen verifier scratch boundary', () => {
  it.each(['hardlink', 'copy'])('keeps %s snapshots outside the attested donor archive', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-snapshot-boundary-'));
    const sourceRoot = join(dir, 'source'), temporary = join(sourceRoot, 'temporary');
    mkdirSync(temporary, { recursive: true });
    writeFileSync(join(sourceRoot, 'helper.ts'), 'export const committed = true;\n');
    writeFileSync(join(sourceRoot, '.verifier-source.json'), '{}');
    const census = verifierSourceFiles(sourceRoot);
    const shell = readFileSync(join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const select = shell.match(/select_verifier_snapshot_root\(\) \{[\s\S]*?\n\}/)![0];
    try {
      const parent = execFileSync('bash', ['-c', select + '\nselect_verifier_snapshot_root'], {
        encoding: 'utf8', env: { ...process.env, REPO_DIR: sourceRoot, TMPDIR: temporary,
          VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: mode } }).trim();
      expect(parent).toBe(dir);
      const generated = mkdtempSync(join(parent, 'verify-tauri-headless.'));
      writeFileSync(join(generated, '.papercusp-run'), 'fixture');
      expect(verifierSourceFiles(sourceRoot)).toEqual(census);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses the sibling filesystem for cross-device hardlinks from a frozen source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-snapshot-cross-device-'));
    const sourceRoot = join(dir, 'source'), temporary = join(dir, 'other-device');
    mkdirSync(sourceRoot); mkdirSync(temporary);
    writeFileSync(join(sourceRoot, '.verifier-source.json'), '{}');
    const shell = readFileSync(join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const select = shell.match(/select_verifier_snapshot_root\(\) \{[\s\S]*?\n\}/)![0];
    try {
      const parent = execFileSync('bash', ['-c',
        // Model an eligible data-device donor, distinct from both / and TMPDIR.
        'stat() { if [ "${@: -1}" = / ]; then echo 0; elif [ "${@: -1}" = "$TMPDIR" ]; then echo 2; else echo 1; fi; }\n' + select + '\nselect_verifier_snapshot_root'], {
        encoding: 'utf8', env: { ...process.env, REPO_DIR: sourceRoot, TMPDIR: temporary,
          VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: 'hardlink' } }).trim();
      expect(parent).toBe(dir);
      expect(existsSync(join(sourceRoot, '.papercusp'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
