/**
 * WI-10003404 / plan host-memory-reduction-2026-09-27 P-004 — the shared typecheck service's pure
 * half (scripts/lib/tsc-service.mjs): which gate runs may use it, which files a scoped verdict
 * needs checked, and rendering API diagnostics in the CLI's own `--pretty false` text so the gate's
 * existing parser reads service output unchanged.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
const nativeDir = dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json'));
const { API } = await import(pathToFileURL(join(nativeDir, 'dist/api/async/api.js')).href);
// eslint-disable-next-line import/no-relative-packages
import {
  TSC_SERVICE_ENV,
  TSC_SERVICE_TIMEOUT_MS,
  TSC_SERVICE_UNIT_TEMPLATE_ENV,
  baselineWithinScope,
  checkedSetFor,
  checkedSetForCooperatively,
  closeTscServiceCompiler,
  takeTscServiceProjectBatch,
  formatTscServiceBanner,
  lineAndCharacter,
  lineStarts,
  namedSetFor,
  refreshProjectRootFiles,
  resolveTscServiceTimeoutMs,
  readTextOrNull,
  renderDiagnostics,
  requestTscService,
  serviceProjectFromTscCommand,
  systemdEscapePath,
  tscServiceEligibility,
  tscServiceRequestId,
  tscServiceIdentity,
  tscServiceSocketPath,
  tscServiceTemplateSocket,
  tscServiceTemplateSocketUnit,
  typecheckViaService,
  unescapeSystemctlValue,
} from '../../../scripts/lib/tsc-service.mjs';
// eslint-disable-next-line import/no-relative-packages
import { parseTscErrors } from '../../../scripts/lib/tsc-baseline-gate.mjs';

describe('bundled typecheck service identity', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const clientSource = join(repoRoot, 'scripts/lib/tsc-service.mjs');
  const serverSource = join(repoRoot, 'scripts/tsc-service/server.mjs');
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  async function bundled(withSources: boolean, withCompiler = true,
    outputRelative = 'apps/operator/dist-host/host.mjs') {
    const root = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'tsc-bundled-identity-'));
    roots.push(root);
    const output = join(root, outputRelative);
    mkdirSync(dirname(output), { recursive: true });
    if (withCompiler) symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    else {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      symlinkSync(dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
        join(root, 'node_modules/typescript'), 'dir');
    }
    if (withSources) {
      for (const [relativePath, source] of [
        ['scripts/lib/tsc-service.mjs', clientSource],
        ['scripts/tsc-service/server.mjs', serverSource],
      ]) {
        const destination = join(root, relativePath!);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(source!));
      }
    }
    await build({
      stdin: { contents: `export { tscServiceIdentity, tscServiceSocketPath } from ${JSON.stringify(clientSource)}`,
        resolveDir: repoRoot, sourcefile: 'tsc-identity-entry.mjs' },
      outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    });
    return { root, output };
  }

  it('imports a relocated host bundle and captures its own source identity once', async () => {
    const { root, output } = await bundled(true);
    const expected = createHash('sha256').update(readFileSync(clientSource)).update(readFileSync(serverSource)).digest('hex');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      const service = await import(${JSON.stringify(pathToFileURL(output).href)});
      const before = service.tscServiceIdentity({});
      writeFileSync(${JSON.stringify(join(root, 'scripts/lib/tsc-service.mjs'))}, 'changed after module load');
      console.log(JSON.stringify({ before, after: service.tscServiceIdentity({}) }));
    `], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.before.serviceSourceSha256).toBe(expected);
    expect(result.after).toEqual(result.before);
    expect(result.before.compilerVersion).toBe(JSON.parse(readFileSync(join(nativeDir, 'package.json'), 'utf8')).version);
    expect(result.before.compilerInstall).toBe(nativeDir);
    expect(result.before.compilerArtifactsSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['source', 'host bundle'])('keeps %s metadata usable with source assets but no optional native compiler', async layout => {
    const { root, output } = await bundled(true, false);
    const entry = layout === 'source' ? join(root, 'scripts/lib/tsc-service.mjs') : output;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      let missingCompiler;
      try { createRequire(${JSON.stringify(pathToFileURL(entry).href)}).resolve('@typescript/native/package.json'); }
      catch (error) { missingCompiler = error.code; }
      const service = await import(${JSON.stringify(pathToFileURL(entry).href)});
      let failure;
      try { service.tscServiceIdentity({}); } catch (error) { failure = error.code; }
      console.log(JSON.stringify({ missingCompiler, socket: service.tscServiceSocketPath({ XDG_RUNTIME_DIR: '/private' }), failure }));
    `], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ missingCompiler: 'MODULE_NOT_FOUND',
      socket: '/private/papercusp-tsc-service.sock', failure: 'service-identity-unavailable' });
  });

  it.each(['unreadable', 'invalid JSON'])('keeps source metadata usable when optional compiler metadata is %s', async fault => {
    const { root } = await bundled(true, false);
    const metadata = join(root, 'compiler-metadata.json');
    if (fault === 'unreadable') mkdirSync(metadata);
    else writeFileSync(metadata, '{');
    const entry = join(root, 'scripts/lib/tsc-service.mjs');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      let resolutions = 0;
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === '@typescript/native/package.json') {
          resolutions++;
          return { url: ${JSON.stringify(pathToFileURL(metadata).href)}, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      } });
      const service = await import(${JSON.stringify(pathToFileURL(entry).href)});
      let failure;
      try { service.tscServiceIdentity({}); } catch (error) { failure = error.code; }
      console.log(JSON.stringify({ resolutions, socket: service.tscServiceSocketPath({ XDG_RUNTIME_DIR: '/private' }), failure }));
    `], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ resolutions: 1,
      socket: '/private/papercusp-tsc-service.sock', failure: 'service-identity-unavailable' });
  });

  it('keeps metadata imports usable without source assets and refuses identity certification', async () => {
    const { output } = await bundled(false);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const service = await import(${JSON.stringify(pathToFileURL(output).href)});
      let failure;
      try { service.tscServiceIdentity({}); } catch (error) { failure = error.code; }
      console.log(JSON.stringify({ socket: service.tscServiceSocketPath({ XDG_RUNTIME_DIR: '/private' }), failure }));
    `], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ socket: '/private/papercusp-tsc-service.sock', failure: 'service-identity-unavailable' });
  });

  it.each([
    { sources: false, outputRelative: 'apps/operator/dist-host/host.mjs' },
    { sources: true, outputRelative: 'papercusp-desktop/src-tauri/sidecar.tmp.fixture/serve.mjs' },
    { sources: true, outputRelative: 'papercusp-desktop/src-tauri/sidecar.tmp.fixture/tsc-service.mjs' },
  ])('boots metadata without native compiler resolution for $outputRelative (parent sources: $sources)', async ({ sources, outputRelative }) => {
    const { output } = await bundled(sources, false, outputRelative);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('@typescript/native')) throw new Error('ESCAPED_BUNDLE: ' + specifier);
        return nextResolve(specifier, context);
      } });
      const service = await import(${JSON.stringify(pathToFileURL(output).href)});
      let failure;
      try { service.tscServiceIdentity({}); } catch (error) { failure = error.code; }
      console.log(JSON.stringify({ socket: service.tscServiceSocketPath({ XDG_RUNTIME_DIR: '/private' }), failure }));
    `], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ socket: '/private/papercusp-tsc-service.sock', failure: 'service-identity-unavailable' });
  });

  it.each([
    { release: 'client cancellation', faultPhase: 'diagnostic', serviceTimeoutMs: 30_000, clientTimeoutMs: 1_000, expectedReason: 'timed-out' },
    { release: 'server deadline', faultPhase: 'diagnostic', serviceTimeoutMs: 4_000, clientTimeoutMs: 15_000, expectedReason: 'request-deadline-exceeded' },
    { release: 'server deadline', faultPhase: 'initialize', serviceTimeoutMs: 4_000, clientTimeoutMs: 15_000, expectedReason: 'request-deadline-exceeded' },
    { release: 'server deadline', faultPhase: 'snapshot', serviceTimeoutMs: 4_000, clientTimeoutMs: 15_000, expectedReason: 'request-deadline-exceeded' },
  ])('recovers from orphaned compiler RPCs and refuses same-version compiler replacement on a live daemon ($release, $faultPhase)', async ({ serviceTimeoutMs, clientTimeoutMs, expectedReason, faultPhase }) => {
    const root = mkdtempSync(join(tmpdir(), 'tsc-compiler-replacement-'));
    roots.push(root);
    const scoped = join(root, 'node_modules/@typescript');
    mkdirSync(scoped, { recursive: true });
    cpSync(nativeDir, join(scoped, 'native'), { recursive: true });
    const nativePackage = JSON.parse(readFileSync(join(nativeDir, 'package.json'), 'utf8'));
    const platformName = `${nativePackage.name.split('/').pop()}-${process.platform}-${process.arch}`;
    cpSync(dirname(createRequire(import.meta.url).resolve(`@typescript/${platformName}/package.json`)), join(scoped, platformName), { recursive: true });
    symlinkSync(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), join(root, 'node_modules/typescript'), 'dir');
    for (const [relativePath, source] of [['scripts/lib/tsc-service.mjs', clientSource], ['scripts/tsc-service/server.mjs', serverSource]]) {
      const destination = join(root, relativePath!);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(source!));
    }
    const project = join(root, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, files: ['a.ts', 'hang.ts'] }));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
    writeFileSync(join(root, 'hang.ts'), 'export const hang = 1;');
    const entry = join(scoped, 'native/dist/api/async/api.js');
    // cpSync preserves the immutable dependency snapshot's read-only mode.
    // Fault injection owns this independent copy, never the donor inode.
    chmodSync(entry, 0o644);
    // Fault injection stays inside this private compiler copy. Refresh and
    // normal checks use the real native API. Stall exactly one operation after
    // a clean control, until the service disposes its unobserved connection.
    const originalApi = readFileSync(entry, 'utf8');
    expect(originalApi).toContain('async getSemanticDiagnostics(file) {');
    expect(originalApi).toContain('async updateSnapshot(params) {');
    expect(originalApi).toContain('async ensureInitialized() {');
    const faultMarker = join(root, 'stall-rpc-once');
    const stallOnce = `
      const fs = await import('node:fs');
      if (fs.existsSync(${JSON.stringify(faultMarker)})) {
        fs.unlinkSync(${JSON.stringify(faultMarker)});
        console.log('HUNG_OPERATION_READY');
        return new Promise((resolve, reject) => this.client.connection.onDispose(() => reject(new Error('orphan ${faultPhase} disposed'))));
      }
    `;
    writeFileSync(entry, originalApi.replace('async ensureInitialized() {', `async ensureInitialized() {
      ${faultPhase === 'initialize' ? stallOnce : ''}
    `).replace('async updateSnapshot(params) {', `async updateSnapshot(params) {
      if (this.activeSnapshots.size > 0) throw new Error('previous native snapshot still retained');
      ${faultPhase === 'snapshot' ? stallOnce : ''}
    `).replace('async getSemanticDiagnostics(file) {', `async getSemanticDiagnostics(file) {
      ${faultPhase === 'diagnostic' ? stallOnce : ''}
    `));
    const socketPath = join(root, 'compiler.sock');
    const child = spawn(process.execPath, [join(root, 'scripts/tsc-service/server.mjs')], { cwd: root,
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_TSC_SERVICE_ROOT: root, PAPERCUSP_TSC_SERVICE_SOCKET: socketPath,
        PAPERCUSP_TSC_SERVICE_TIMEOUT_MS: String(serviceTimeoutMs) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(output)), 10_000);
        child.stdout.on('data', () => { if (output.includes('listening on')) { clearTimeout(timer); resolve(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
      });
      const runCaller = (files = ['a.ts'], timeoutMs = 10000, operation?: string) => new Promise<any>((resolve, reject) => {
        const caller = spawn(process.execPath, ['--input-type=module', '-e', `
          const service = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/tsc-service.mjs')).href)});
          const request = { requestId: crypto.randomUUID(), root: ${JSON.stringify(root)}, project: ${JSON.stringify(project)}, files: ${JSON.stringify(files)}, scope: 'named', operation: ${JSON.stringify(operation)} };
          const result = await service.requestTscService({ socketPath: ${JSON.stringify(socketPath)}, request, timeoutMs: ${timeoutMs} })
            .catch(error => ({ ok: false, reason: error.code }));
          console.log(JSON.stringify({ requestId: request.requestId, result, identity: service.tscServiceIdentity(request) }));
        `], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        caller.stdout.on('data', data => { stdout += data; });
        caller.stderr.on('data', data => { stderr += data; });
        caller.once('error', reject);
        caller.once('close', code => { if (code === 0) resolve(JSON.parse(stdout)); else reject(new Error(stderr)); });
      });
      const before = await runCaller();
      expect(before.result).toMatchObject({ ok: true, kind: 'result', errorCount: 0 });
      writeFileSync(faultMarker, 'stall once');
      const hanging = runCaller(['hang.ts'], clientTimeoutMs);
      await expect.poll(() => output, { timeout: 5000 }).toContain('HUNG_OPERATION_READY');
      const observed = await runCaller(['a.ts'], 1000, 'identity');
      expect(observed.result).toMatchObject({ ok: true, identityOnly: true, checked: [],
        runtime: { pid: child.pid }, identity: before.identity });
      expect((await runCaller(['a.ts'], 1000, 'unsupported')).result.ok).toBe(false);
      const queued = runCaller();
      const expired = await hanging;
      const recovered = await queued;
      expect(expired.result).toMatchObject({ ok: false, reason: expectedReason });
      expect(recovered.result).toMatchObject({ ok: true, kind: 'result', errorCount: 0 });
      expect(output).toContain(`orphan ${faultPhase} disposed`);
      const prefix = `requestId=${expired.requestId} project=tsconfig.json named=1 phase=`;
      expect(output).toContain(`${prefix}compiler-initialize`);
      if (faultPhase === 'initialize') {
        expect(output).not.toContain(`${prefix}compiler-initialized`);
        expect(output).not.toContain(`${prefix}snapshot-update`);
      } else {
        expect(output).toContain(`${prefix}compiler-initialized`);
        expect(output).toContain(`${prefix}snapshot-update`);
        if (faultPhase === 'snapshot') expect(output).not.toContain(`${prefix}snapshot-updated`);
        else expect(output).toContain(`${prefix}snapshot-updated`);
      }
      // Exercise a previously loaded caller's identity, after the API has
      // already reset once. Alter only the PRIVATE executable, preserving its
      // version/path and executable format (ELF permits trailing data).
      const baseName = nativePackage.name.split('/').pop();
      const executable = join(scoped, platformName, 'lib', `${baseName === 'typescript' ? 'tsc' : 'tsgo'}${process.platform === 'win32' ? '.exe' : ''}`);
      writeFileSync(executable + '.replacement', Buffer.concat([readFileSync(executable), Buffer.from('\nprivate-replacement\n')]), { mode: 0o755 });
      renameSync(executable + '.replacement', executable);
      const stale = await new Promise<any>((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = '';
        const timer = setTimeout(() => { socket.destroy(); reject(new Error(output)); }, 10_000);
        socket.on('connect', () => socket.write(JSON.stringify({ v: 2, requestId: 'old-caller-after-reset',
          root, project, files: ['a.ts'], scope: 'named', identity: before.identity }) + '\n'));
        socket.setEncoding('utf8'); // boundary-safe decode (WI-6728)
        socket.on('data', data => {
          buffer += data;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
            if (response.kind === 'result') { clearTimeout(timer); socket.destroy(); resolve(response); }
          }
        });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      expect(stale).toMatchObject({ ok: false, reason: 'refresh-failed', detail: expect.stringContaining('compiler artifacts changed') });
      writeFileSync(entry, readFileSync(entry, 'utf8') + '\n// replacement without version bump\n');
      const after = await runCaller();
      expect(after.identity.compilerVersion).toBe(before.identity.compilerVersion);
      expect(after.identity.compilerInstall).toBe(before.identity.compilerInstall);
      expect(after.identity.compilerArtifactsSha256).not.toBe(before.identity.compilerArtifactsSha256);
      expect(after.result).toMatchObject({ ok: false, reason: 'identity-mismatch' });
      if (expectedReason === 'request-deadline-exceeded') {
        console.info('TSC_SERVICE_RECOVERY_RECEIPT ' + JSON.stringify({ runtime: before.result.runtime,
          serviceSourceSha256: before.identity.serviceSourceSha256, serviceTimeoutMs, clientTimeoutMs, faultPhase,
          terminalReason: expired.result.reason, recoveryOk: recovered.result.ok,
          recoveryChecked: recovered.result.checked, recoveryErrorCount: recovered.result.errorCount }));
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  }, 30_000);
});

describe('native compiler ownership during reset', () => {
  it.each([false, true])('reaps the child after client disposal rejects (ignores EOF=%s)', async ignoresEof => {
    const child = spawn(process.execPath, ['-e', ignoresEof
      ? "process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdin.on('end', () => {}); console.log('ready'); setInterval(() => {}, 1000);"
      : "process.stdin.resume(); console.log('ready');"], {
      env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8'); // boundary-safe decode (WI-6728)
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-1_000); });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`compiler fixture did not start: ${stderr}`)), 5_000);
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`compiler fixture exited before readiness: code=${code} signal=${signal}: ${stderr}`));
        });
      });
      const api = { client: { process: child, close: async () => { throw new Error('snapshot connection already disposed'); } },
        clearSourceFileCache: vi.fn() };
      await closeTscServiceCompiler(api, { graceMs: 50, killWaitMs: 5_000 });
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(child.stdin.writableEnded).toBe(true);
      expect(api.clearSourceFileCache).toHaveBeenCalledOnce();
      if (ignoresEof) expect(child.signalCode).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });
});

describe('shared compiler project admission', () => {
  it('coalesces one project while preserving other callers and dropping cancelled requests', () => {
    const request = (project: string, cancelled = false) => ({ request: { project }, cancelled });
    const cancelled = request('cancelled', true);
    const a1 = request('a'), b1 = request('b'), a2 = request('a'), c1 = request('c'), b2 = request('b');
    const queue = [cancelled, a1, b1, a2, c1, b2];
    expect(takeTscServiceProjectBatch(queue)).toEqual([a1, a2]);
    expect(queue).toEqual([b1, c1, b2]);
    expect(takeTscServiceProjectBatch(queue)).toEqual([b1, b2]);
    expect(takeTscServiceProjectBatch(queue)).toEqual([c1]);
    expect(takeTscServiceProjectBatch(queue)).toEqual([]);
  });
});

describe('serviceProjectFromTscCommand', () => {
  it('accepts every leg shape in use today', () => {
    expect(serviceProjectFromTscCommand('npx tsc -p packages/operator-core/tsconfig.json --noEmit --incremental false')).toBe(
      'packages/operator-core/tsconfig.json',
    );
    expect(serviceProjectFromTscCommand('npx --no-install tsc --project scripts/tsconfig.json --noEmit')).toBe('scripts/tsconfig.json');
  });

  it('refuses any flag the service cannot reproduce, rather than guessing', () => {
    expect(serviceProjectFromTscCommand('npx tsc -p a/tsconfig.json --noEmit --strict false')).toBeNull();
    expect(serviceProjectFromTscCommand('npx tsc -p a/tsconfig.json --incremental true')).toBeNull();
    expect(serviceProjectFromTscCommand('node fake-tsc.mjs')).toBeNull();
    expect(serviceProjectFromTscCommand('npx tsc --noEmit')).toBeNull();
  });
});

describe('tscServiceEligibility', () => {
  const base = {
    tscCommand: 'npx tsc -p packages/operator-core/tsconfig.json --noEmit --incremental false',
    explicitFiles: new Set(['packages/operator-core/lib/a.ts']),
    argv: ['--files=packages/operator-core/lib/a.ts'],
    root: '/repo',
    env: {},
  };

  it('routes an explicit --files run to the project config, resolved against root', () => {
    expect(tscServiceEligibility(base)).toEqual({ eligible: true, project: '/repo/packages/operator-core/tsconfig.json' });
  });

  it('keeps every whole-program run on the CLI', () => {
    expect(tscServiceEligibility({ ...base, explicitFiles: null }).eligible).toBe(false);
    expect(tscServiceEligibility({ ...base, argv: [...base.argv, '--update'] }).eligible).toBe(false);
    expect(tscServiceEligibility({ ...base, argv: [...base.argv, '--seed'] }).eligible).toBe(false);
  });

  it(`honours ${TSC_SERVICE_ENV}=0 and a service bound to another checkout`, () => {
    expect(tscServiceEligibility({ ...base, env: { [TSC_SERVICE_ENV]: '0' } }).eligible).toBe(false);
    expect(tscServiceEligibility({ ...base, serviceRoot: '/elsewhere' }).eligible).toBe(false);
    expect(tscServiceEligibility({ ...base, serviceRoot: '/repo/' }).eligible).toBe(true);
  });
});

describe('tscServiceSocketPath', () => {
  it('prefers the explicit override, then XDG_RUNTIME_DIR', () => {
    expect(tscServiceSocketPath({ PAPERCUSP_TSC_SERVICE_SOCKET: '/tmp/x.sock' })).toBe('/tmp/x.sock');
    expect(tscServiceSocketPath({ XDG_RUNTIME_DIR: '/run/user/7' })).toBe('/run/user/7/papercusp-tsc-service.sock');
  });
});

// WI-10005362: hosted hosts run one template instance per checkout.
describe('systemdEscapePath', () => {
  it('matches `systemd-escape --path` (vectors captured from systemd 255)', () => {
    expect(systemdEscapePath('/srv/papercusp/workspaces/papercusp')).toBe('srv-papercusp-workspaces-papercusp');
    expect(systemdEscapePath('/srv/papercusp/workspaces/papercusp-desktop/')).toBe('srv-papercusp-workspaces-papercusp\\x2ddesktop');
    expect(systemdEscapePath('/home/x/.dir/a b/ü')).toBe('home-x-.dir-a\\x20b-\\xc3\\xbc');
    expect(systemdEscapePath('/')).toBe('-');
    expect(systemdEscapePath('/a//b/./c')).toBe('a-b-c');
    expect(systemdEscapePath('/.hidden/x')).toBe('\\x2ehidden-x');
  });

  it('names the socket unit for the resolved checkout', () => {
    expect(tscServiceTemplateSocketUnit('papercusp-tsc-service', '/srv/papercusp/workspaces/papercusp/')).toBe(
      'papercusp-tsc-service@srv-papercusp-workspaces-papercusp.socket',
    );
  });
});

describe('tscServiceTemplateSocket', () => {
  const unit = 'papercusp-tsc-service@srv-w-repo.socket';
  type Call = { command: string; args: string[]; env: Record<string, string | undefined> };
  function fakeRun(results: Array<{ status: number | null; stdout?: string; stderr?: string }>) {
    const calls: Call[] = [];
    // `options: object` matches the client's injected `run` contract; the client always passes `{ env }`.
    const run = (command: string, args: string[], options: object) => {
      calls.push({ command, args, env: (options as { env: Record<string, string | undefined> }).env });
      return results[calls.length - 1] ?? { status: 1, stdout: '', stderr: 'unexpected call' };
    };
    return { calls, run };
  }

  it('starts the instance socket, then returns the path systemd bound (without the type suffix)', () => {
    const { calls, run } = fakeRun([
      { status: 0, stdout: '' },
      { status: 0, stdout: '/run/user/1001/papercusp-tsc-service-srv-w-repo.sock (Stream)\n' },
    ]);
    const located = tscServiceTemplateSocket({ template: 'papercusp-tsc-service', root: '/srv/w/repo', env: {}, run });
    expect(located).toEqual({ unit, socketPath: '/run/user/1001/papercusp-tsc-service-srv-w-repo.sock' });
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['systemctl', '--user', 'start', unit],
      ['systemctl', '--user', 'show', '-p', 'Listen', '--value', unit],
    ]);
    // systemctl --user finds the user bus through XDG_RUNTIME_DIR, which an SSH exec may not carry.
    expect(calls[0].env.XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
  });

  it('decodes systemctl show escaping, so an escaped instance path matches the socket on disk', () => {
    // Shape measured on systemd 255 for a checkout whose path holds a `-`: the socket file name
    // holds a literal `\x2d`, which `systemctl show` prints as `\\x2d`.
    const printed = '/run/user/1001/papercusp-tsc-service-srv-ws-papercusp\\\\x2ddesktop.sock (Stream)\n';
    const { run } = fakeRun([{ status: 0 }, { status: 0, stdout: printed }]);
    const located = tscServiceTemplateSocket({ template: 'papercusp-tsc-service', root: '/srv/ws/papercusp-desktop', env: {}, run });
    expect(located).toEqual({
      unit: 'papercusp-tsc-service@srv-ws-papercusp\\x2ddesktop.socket',
      socketPath: '/run/user/1001/papercusp-tsc-service-srv-ws-papercusp\\x2ddesktop.sock',
    });
    expect(unescapeSystemctlValue('a\\xc3\\xbcb\\\\c\\tz')).toBe('aüb\\c\tz');
    expect(unescapeSystemctlValue('/plain/path.sock')).toBe('/plain/path.sock');
  });

  it('reports a failed start without asking for the socket, so the caller falls back to the CLI', () => {
    const { calls, run } = fakeRun([{ status: 5, stderr: 'Unit papercusp-tsc-service@srv-w-repo.socket not found.\n' }]);
    const located = tscServiceTemplateSocket({ template: 'papercusp-tsc-service', root: '/srv/w/repo', env: { XDG_RUNTIME_DIR: '/run/user/9' }, run });
    expect(located).toEqual({ unit, error: expect.stringContaining('not found') });
    expect(calls).toHaveLength(1);
    expect(calls[0].env.XDG_RUNTIME_DIR).toBe('/run/user/9');
  });

  it('refuses a unit that bound no unix socket', () => {
    const { run } = fakeRun([{ status: 0 }, { status: 0, stdout: '\n' }]);
    expect(tscServiceTemplateSocket({ template: 'papercusp-tsc-service', root: '/srv/w/repo', env: {}, run })).toEqual({
      unit,
      error: `${unit} reports no unix socket`,
    });
  });
});

describe('typecheckViaService under a unit template', () => {
  it('falls back (returns null and says why) when the template instance cannot start', async () => {
    const lines: string[] = [];
    const response = await typecheckViaService({
      root: '/nonexistent/checkout',
      project: '/nonexistent/checkout/tsconfig.json',
      files: ['a.ts'],
      label: 'test',
      log: (line) => lines.push(line),
      // A template name no user manager has: the real `systemctl --user start` refuses it.
      env: { [TSC_SERVICE_UNIT_TEMPLATE_ENV]: 'papercusp-tsc-service-test-absent', XDG_RUNTIME_DIR: '/nonexistent/runtime' },
    });
    expect(response).toBeNull();
    expect(lines.join('\n')).toMatch(/TSC_SERVICE unavailable .*papercusp-tsc-service-test-absent@nonexistent-checkout\.socket/);
  });
});

describe('bounded shared-service timeout', () => {
  it('keeps request IDs bounded and rejects log delimiters', () => {
    expect(tscServiceRequestId('caller-123')).toBe('caller-123');
    for (const value of [undefined, '', 'x'.repeat(81), 'fake\nphase=complete']) {
      expect(tscServiceRequestId(value)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('caps configured waits at 30 seconds while allowing shorter budgets', () => {
    expect(TSC_SERVICE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(resolveTscServiceTimeoutMs(undefined)).toBe(30_000);
    expect(resolveTscServiceTimeoutMs('240000')).toBe(30_000);
    expect(resolveTscServiceTimeoutMs(240_000)).toBe(30_000);
    expect(resolveTscServiceTimeoutMs('15000')).toBe(15_000);
  });

  it('falls back promptly when the socket accepts a request but never answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-service-unresponsive-'));
    const socketPath = join(dir, 'service.sock');
    const sockets = new Set<import('node:net').Socket>();
    const receivedIds: string[] = [];
    let requestReceived!: () => void;
    const receivedRequest = new Promise<void>(resolve => { requestReceived = resolve; });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (data) => {
        receivedIds.push(JSON.parse(String(data)).requestId);
        requestReceived();
      });
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const lines: string[] = [];
    const setRealTimeout = globalThis.setTimeout;
    const clearRealTimeout = globalThis.clearTimeout;
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Socket delivery is real I/O; advance only the client deadline after
      // the fixture has received the request. A busy poll phase must not race
      // this guard's assertion that the request reached the silent server.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = typecheckViaService({
        root: '/repo',
        project: '/repo/tsconfig.json',
        files: ['src/a.ts'],
        label: 'test',
        timeoutMs: 50,
        log: (line) => lines.push(line),
        env: { PAPERCUSP_TSC_SERVICE_SOCKET: socketPath },
      });
      await Promise.race([receivedRequest, new Promise<never>((_resolve, reject) => {
        deliveryTimer = setRealTimeout(() => reject(new Error('fixture socket did not receive the request')), 5_000);
      })]);
      await vi.advanceTimersByTimeAsync(49);
      expect(lines).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result).toBeNull();
      expect(lines.join('\n')).toContain('no answer within 50 ms');
      expect(receivedIds).toHaveLength(1);
      expect(lines.join('\n')).toContain(`TSC_SERVICE request failed at ${socketPath}`);
      expect(lines.join('\n')).not.toContain('unreachable');
      expect(receivedIds[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(lines.join('\n')).toContain(`requestId=${receivedIds[0]}`);
    } finally {
      if (deliveryTimer) clearRealTimeout(deliveryTimer);
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('service request phase correlation', () => {
  it('traces a real isolated compiler request with the caller ID and preserves diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-service-trace-'));
    const socketPath = join(dir, 'service.sock');
    const project = join(dir, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [] }, files: ['a.ts', 'other.ts', 'caller.ts'] }));
    writeFileSync(join(dir, 'a.ts'), 'export const a: number = "wrong";\n');
    writeFileSync(join(dir, 'other.ts'), 'export const other = 1;\n');
    writeFileSync(join(dir, 'caller.ts'), "import { a } from './a.js';\nexport const caller = a;\n");
    const serverPath = fileURLToPath(new URL('../../../scripts/tsc-service/server.mjs', import.meta.url));
    const child = spawn(process.execPath, [serverPath], {
      // The test:file loader pins spawned scripts to HEAD; this child must exercise the local
      // service implementation under test.
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_TSC_SERVICE_ROOT: dir, PAPERCUSP_TSC_SERVICE_SOCKET: socketPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`service did not listen: ${output}`)), 10_000);
        const ready = (data: Buffer) => {
          if (String(data).includes('listening on')) { clearTimeout(timer); resolve(); }
        };
        child.stdout.on('data', ready);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`service exited: ${output}`)); });
      });
      const response = await requestTscService({
        socketPath,
        request: { v: 1, requestId: 'trace-test-123', root: dir, project, files: ['a.ts'] },
        timeoutMs: 10_000,
      });
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.errorCount).toBe(1);
        expect(response.output).toContain('TS2322');
        expect(response.checked).toContain('caller.ts');
      }
      // The next request refreshes the snapshot. Its dependency graph must reflect the edit.
      writeFileSync(join(dir, 'caller.ts'), "import { other } from './other.js';\nexport const caller = other;\n");
      const refreshed = await requestTscService({
        socketPath,
        request: { v: 1, requestId: 'trace-test-refresh', root: dir, project, files: ['other.ts'] },
        timeoutMs: 10_000,
      });
      expect(refreshed.ok).toBe(true);
      if (refreshed.ok) {
        expect(refreshed.errorCount).toBe(0);
        expect(refreshed.checked.sort()).toEqual(['caller.ts', 'other.ts']);
      }
      // A timeout destroys the caller's socket. Node also ends the server's writable side
      // after the peer FIN, which must not be mistaken for a reply sent by this service.
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath);
        const prefix = 'requestId=trace-test-disconnect project=tsconfig.json named=1 phase=';
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.stdout.off('data', observe);
          socket.destroy();
          if (error) reject(error);
          else resolve();
        };
        const observe = () => {
          if (output.includes(`${prefix}refresh-abort-no-clients`)) finish();
          else if (output.includes(`${prefix}complete`)) finish(new Error('disconnected request completed instead of cancelling'));
        };
        const timer = setTimeout(() => finish(new Error(`disconnect was not observed: ${output}`)), 5_000);
        child.stdout.on('data', observe);
        socket.on('error', finish);
        // Send the full request then FIN immediately, without racing child stdout delivery.
        const request = { v: 2, requestId: 'trace-test-disconnect', root: dir, project, files: ['other.ts'] };
        socket.on('connect', () => socket.end(`${JSON.stringify({ ...request, identity: tscServiceIdentity(request) })}\n`));
      });
      const recovered = await requestTscService({
        socketPath,
        request: { v: 1, requestId: 'trace-test-after-abort', root: dir, project, files: ['other.ts'] },
        timeoutMs: 10_000,
      });
      expect(recovered.ok).toBe(true);
      // Drain stdout before inspecting the trace and assert that the compiler child also exits.
      child.kill('SIGTERM');
      await closed;
      expect(output).not.toContain('COMMITTED_SOURCE substituted scripts/tsc-service/server.mjs');
      for (const phase of ['queued', 'refresh', 'compiler-initialize', 'compiler-initialized', 'snapshot-update', 'snapshot-updated', 'project-roots-refresh', 'project-roots-refreshed', 'refreshed', 'program-files', 'scope', 'program-diagnostics', 'file-diagnostics', 'render-diagnostics', 'complete']) {
        expect(output).toContain(`requestId=trace-test-123 project=tsconfig.json named=1 phase=${phase}`);
      }
      expect(output).not.toContain('requestId=trace-test-123 project=tsconfig.json named=1 phase=client-disconnected');
      expect(output).not.toContain('requestId=trace-test-refresh project=tsconfig.json named=1 phase=client-disconnected');
      expect(output).toContain('requestId=trace-test-disconnect project=tsconfig.json named=1 phase=refresh-abort-no-clients');
      expect(output).not.toContain('requestId=trace-test-disconnect project=tsconfig.json named=1 phase=complete');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
});

describe('focused service protocol', () => {
  type Request = Record<string, any>;
  async function withSocket(
    handle: (request: Request, socket: import('node:net').Socket) => void,
    check: (args: { socketPath: string; request: Request; lines: string[]; call: (timeoutMs?: number) => ReturnType<typeof typecheckViaService> }) => Promise<void>,
  ) {
    const root = mkdtempSync(join(tmpdir(), 'tsc-protocol-'));
    const socketPath = join(root, 'service.sock');
    const project = join(root, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({ compilerOptions: { noEmit: true }, files: ['a.ts'] }));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
    const request = { v: 1, root, project, files: ['a.ts'], requestId: 'protocol-test' };
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.includes('\n')) handle(JSON.parse(buffer.split('\n')[0]!), socket);
      });
    });
    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    try {
      await check({ socketPath, request, lines, call: timeoutMs => typecheckViaService({ root, project, files: request.files,
        label: 'test', timeoutMs, env: { PAPERCUSP_TSC_SERVICE_SOCKET: socketPath }, log: line => lines.push(line) }) });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }
  const frame = (request: Request, value: Request) => JSON.stringify({ kind: 'result', requestId: request.requestId,
    identity: request.identity, runtime: { pid: process.pid, startedAt: Date.now() }, ...value }) + '\n';

  async function withCompiler(check: (args: { root: string; request: Request; socketPath: string; child: ReturnType<typeof spawn>; output: () => string }) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'tsc-protocol-live-'));
    const socketPath = join(root, 'service.sock');
    const project = join(root, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [] }, files: ['a.ts'] }));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../scripts/tsc-service/server.mjs', import.meta.url))],
      { env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_TSC_SERVICE_ROOT: root, PAPERCUSP_TSC_SERVICE_SOCKET: socketPath },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', data => { output += data; });
    child.stderr!.on('data', data => { output += data; });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`service did not start: ${output}`)), 10_000);
        child.stdout!.on('data', () => { if (output.includes('listening on')) { clearTimeout(timer); resolve(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`service exited: ${output}`)); });
      });
      await check({ root, socketPath, child, output: () => output,
        request: { v: 1, root, project, files: ['a.ts'], requestId: 'live-protocol' } });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('reports queued progress without treating it as a terminal result', async () => {
    let finish: () => void = () => {};
    await withSocket((request, socket) => {
      socket.write(frame(request, { kind: 'progress', phase: 'queued' }));
      finish = () => socket.end(frame(request, { ok: false, reason: 'test-terminal' }));
    }, async ({ socketPath, request }) => {
      const phases: string[] = [];
      let settled = false;
      const response = requestTscService({ socketPath, request, timeoutMs: 1000,
        onProgress: progress => { phases.push(progress.phase); expect(settled).toBe(false); finish(); } });
      const result = await response;
      settled = true;
      expect(phases).toEqual(['queued']);
      expect(result).toMatchObject({ kind: 'result', ok: false, reason: 'test-terminal' });
    });
  });

  it('distinguishes unavailable, unsupported and timed-out requests', async () => {
    await expect(requestTscService({ socketPath: join(tmpdir(), `absent-${Date.now()}.sock`), request: {} }))
      .rejects.toMatchObject({ code: 'ENOENT' });
    // A normal refusal may arrive after the timeout-specific case's short deadline.
    await withSocket((request, socket) => setTimeout(() => socket.end(frame(request, { ok: false, reason: 'declaration-emit-project' })), 100),
      async ({ call, lines }) => { expect(await call()).toBeNull(); expect(lines.join('\n')).toContain('state=declaration-emit-project'); });
    await withSocket(() => {}, async ({ call, lines }) => {
      expect(await call(50)).toBeNull();
      expect(lines.join('\n')).toContain('state=timed-out');
    });
  });

  it('refuses response identity mismatches', async () => {
    const success = { ok: true, output: '', errorCount: 0, checked: ['a.ts'], namedNotInProgram: [], counts: {} };
    // Calibrate the complete terminal result before changing only its correlation.
    await withSocket((request, socket) => socket.end(frame(request, success)),
      async ({ socketPath, request }) => {
        await expect(requestTscService({ socketPath, request })).resolves.toMatchObject(success);
      });
    await withSocket((request, socket) => socket.end(frame(request, { ...success, requestId: 'another-request' })),
      async ({ socketPath, request }) => {
        await expect(requestTscService({ socketPath, request })).rejects.toMatchObject({
          code: 'identity-mismatch',
          message: expect.stringContaining('expectedRequestId="protocol-test" actualRequestId="another-request" changedIdentityFields=[]'),
        });
      });
  });

  it('reports full-compile fallback as accountable fallback rather than focused success', async () => {
    await withSocket((request, socket) => socket.end(frame(request, { ok: false, reason: 'scope-too-wide' })),
      async ({ call, lines }) => {
        expect(await call()).toBeNull();
        expect(lines.join('\n')).toContain('resultOrigin=full-compile-required');
        expect(lines.join('\n')).not.toContain('used=1');
      });
  });

  it('refuses compiler and source identity mismatches', async () => {
    for (const key of ['compilerVersion', 'compilerArtifactsSha256', 'serviceSourceSha256', 'projectConfigSha256', 'namedSources']) {
      await withSocket((request, socket) => socket.end(frame(request, { ok: true,
        identity: { ...request.identity, [key]: 'different' } })), async ({ socketPath, request }) => {
        await expect(requestTscService({ socketPath, request })).rejects.toMatchObject({
          code: 'identity-mismatch',
          message: expect.stringContaining(`expectedRequestId="protocol-test" actualRequestId="protocol-test" changedIdentityFields=["${key}"]`),
        });
      });
    }
  });

  it('identifies a real compiler source-drift refusal without blaming request correlation', async () => {
    await withCompiler(async ({ root, socketPath, request }) => {
      const identity = tscServiceIdentity(request);
      await expect(requestTscService({ socketPath, request: { ...request, identity } }))
        .resolves.toMatchObject({ ok: true, checked: ['a.ts'], errorCount: 0 });
      writeFileSync(join(root, 'a.ts'), 'export const a = 2;');
      await expect(requestTscService({ socketPath, request: { ...request, identity } })).rejects.toMatchObject({
        code: 'identity-mismatch',
        message: expect.stringContaining('expectedRequestId="live-protocol" actualRequestId="live-protocol" changedIdentityFields=["namedSources"] responseKind="result" serverReason="identity-mismatch"'),
      });
      const phases: string[] = [];
      await expect(requestTscService({ socketPath, request,
        onProgress: progress => {
          phases.push(progress.phase);
          writeFileSync(join(root, 'a.ts'), 'export const a = 3;');
        },
      })).rejects.toMatchObject({
        code: 'identity-mismatch',
        message: expect.stringContaining('changedIdentityFields=["namedSources"] responseKind="result" serverReason="identity-mismatch" serverDetail="source or config changed during the request"'),
      });
      expect(phases).toEqual(['accepted']);
    });
  }, 15_000);

  it('refuses oversized scopes with an explicit full-compile fallback', async () => {
    await withCompiler(async ({ socketPath, request, root }) => {
      const lines: string[] = [];
      const result = await typecheckViaService({ root, project: request.project, files: Array(501).fill('a.ts'),
        label: 'test', env: { PAPERCUSP_TSC_SERVICE_SOCKET: socketPath }, log: line => lines.push(line) });
      expect(result).toBeNull();
      expect(lines.join('\n')).toContain('state=scope-too-wide resultOrigin=full-compile-required');
      expect(lines.join('\n')).not.toContain('used=1');
    });
  }, 15_000);

  it('refuses a wrong checkout without falling back when the caller requires its service', async () => {
    await withCompiler(async ({ socketPath, request, root }) => {
      const lines: string[] = [];
      await expect(typecheckViaService({ root: join(root, 'another-checkout'), project: request.project,
        files: ['a.ts'], label: 'native-readiness',
        env: { PAPERCUSP_TSC_SERVICE_SOCKET: socketPath, PAPERCUSP_TSC_SERVICE_REQUIRED: '1' },
        log: line => lines.push(line) })).rejects.toThrow('TSC_SERVICE_REQUIRED');
      expect(lines.join('\n')).not.toContain('running the full');
    });
  }, 15_000);

  it('preserves cross-project selection and delegated diagnostic correctness', async () => {
    await withCompiler(async ({ root, socketPath, request }) => {
      writeFileSync(join(root, 'b.ts'), 'export const b: number = "wrong";');
      const project = join(root, 'second.json');
      writeFileSync(project, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [] }, files: ['b.ts'] }));
      const first = await requestTscService({ socketPath, request: { ...request, files: ['a.ts', 'b.ts'] } });
      const delegated = await requestTscService({ socketPath, request: { ...request, project, files: ['b.ts'] } });
      expect(first).toMatchObject({ ok: true, namedNotInProgram: ['b.ts'], checked: ['a.ts'], errorCount: 0 });
      expect(delegated).toMatchObject({ ok: true, checked: ['b.ts'], errorCount: 1, output: expect.stringContaining('TS2322') });
      if (first.ok) expect(formatTscServiceBanner(first, { routedAway: ['b.ts'] }).join('\n')).toContain('judged by its own leg');
    });
  }, 15_000);

  it('cancels orphaned refreshes without cancelling live callers', async () => {
    await withCompiler(async ({ socketPath, request, child, output }) => {
      let live: ReturnType<typeof requestTscService> | undefined;
      await new Promise<void>((resolve, reject) => {
        const orphan = createConnection(socketPath);
        const timer = setTimeout(() => { orphan.destroy(); reject(new Error(`no accepted request: ${output()}`)); }, 5_000);
        orphan.on('error', reject);
        orphan.on('connect', () => orphan.write(JSON.stringify({ ...request, v: 2, requestId: 'orphan', identity: tscServiceIdentity(request) }) + '\n'));
        orphan.once('data', () => {
          // The next caller remains live while the first refresh loses its only observer.
          live = requestTscService({ socketPath, request: { ...request, requestId: 'live-after-orphan' }, timeoutMs: 10_000 });
          orphan.destroy();
          clearTimeout(timer);
          resolve();
        });
      });
      expect(await live).toMatchObject({ ok: true, kind: 'result', requestId: 'live-after-orphan' });
      // Child stdout is drained on shutdown before checking the cancellation observation.
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
      expect(output()).toContain('requestId=orphan project=tsconfig.json named=1 phase=refresh-abort-no-clients');
      expect(output()).not.toContain('requestId=live-after-orphan project=tsconfig.json named=1 phase=client-disconnected');
    });
  }, 20_000);
});

describe('line/column from UTF-16 offsets', () => {
  it('handles LF, CRLF and astral characters the way the CLI counts columns', () => {
    const text = "a\r\nconst s = '🚀';\nx";
    const starts = lineStarts(text);
    expect(starts).toEqual([0, 3, 19]);
    // `;` after the rocket: the rocket is two UTF-16 units, so the column is 14, not 13.
    expect(lineAndCharacter(starts, text.indexOf("';"))).toEqual({ line: 1, character: 13 });
    expect(lineAndCharacter(starts, text.length - 1)).toEqual({ line: 2, character: 0 });
  });
});

describe('renderDiagnostics', () => {
  const root = '/repo';
  const text = 'const a: number = "x";\nconst f: (x: number) => void = (x: string) => {};\n';
  const textFor = (file: string) => (file === '/repo/src/a.ts' ? text : null);

  it('matches `tsc --pretty false`: location, code, chain lines two spaces deeper per level', () => {
    const out = renderDiagnostics(
      [
        { fileName: '/repo/src/a.ts', pos: 6, code: 2322, category: 1, text: "Type 'string' is not assignable to type 'number'." },
        {
          fileName: '/repo/src/a.ts',
          pos: 29,
          code: 2322,
          category: 1,
          text: "Type '(x: string) => void' is not assignable to type '(x: number) => void'.",
          messageChain: [
            {
              pos: 29,
              code: 2328,
              category: 1,
              text: "Types of parameters 'x' and 'x' are incompatible.",
              messageChain: [{ pos: 29, code: 2322, category: 1, text: "Type 'number' is not assignable to type 'string'." }],
            },
          ],
        },
        { fileName: '/repo/src/a.ts', pos: 0, code: 6133, category: 2, text: 'a suggestion, not an error' },
        { pos: 0, code: 5023, category: 1, text: "Unknown compiler option 'x'." },
      ],
      { root, textFor },
    );
    expect(out).toBe(
      "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
        "src/a.ts(2,7): error TS2322: Type '(x: string) => void' is not assignable to type '(x: number) => void'.\n" +
        "  Types of parameters 'x' and 'x' are incompatible.\n" +
        "    Type 'number' is not assignable to type 'string'.\n" +
        "error TS5023: Unknown compiler option 'x'.\n",
    );
  });

  it('is read back by the gate parser with the same per-file attribution', () => {
    const out = renderDiagnostics(
      [{ fileName: '/repo/src/a.ts', pos: 6, code: 2322, category: 1, text: 'x' }],
      { root, textFor },
    );
    expect(parseTscErrors(out)).toEqual([{ file: 'src/a.ts', code: 'TS2322' }]);
  });
});

describe('refreshProjectRootFiles', () => {
  it('reports files newly included and deleted from a loaded project program', async () => {
    const currentSnapshot = {
      getProject: () => ({ rootFiles: ['/repo/lib/kept.ts', '/repo/lib/deleted.ts'] }),
      dispose: () => { disposed = true; },
    };
    const nextSnapshot = { getProject: () => ({ rootFiles: ['/repo/lib/kept.ts', '/repo/lib/created.ts'] }), dispose: () => {} };
    const calls: unknown[] = [];
    let disposed = false;
    const api = {
      parseConfigFile: async () => ({ fileNames: ['/repo/lib/kept.ts', '/repo/lib/created.ts'] }),
      updateSnapshot: async (params: unknown) => { calls.push(params); return nextSnapshot; },
    };

    const result = await refreshProjectRootFiles({ api, snapshot: currentSnapshot, projects: ['/repo/tsconfig.json'] });

    expect(calls).toEqual([{ fileChanges: { created: ['/repo/lib/created.ts'], deleted: ['/repo/lib/deleted.ts'] } }]);
    expect(disposed).toBe(true);
    expect(result).toBe(nextSnapshot);
  });

  it('leaves the snapshot alone when the include set is unchanged', async () => {
    const currentSnapshot = {
      getProject: () => ({ rootFiles: ['/repo/lib/a.ts', '/repo/lib/b.ts'] }),
      dispose: () => { disposed = true; },
    };
    let disposed = false;
    let updated = false;
    const api = {
      parseConfigFile: async () => ({ fileNames: ['/repo/lib/b.ts', '/repo/lib/a.ts'] }),
      updateSnapshot: async () => { updated = true; return currentSnapshot; },
    };

    const result = await refreshProjectRootFiles({ api, snapshot: currentSnapshot, projects: ['/repo/tsconfig.json'] });

    expect(result).toBe(currentSnapshot);
    expect(disposed).toBe(false);
    expect(updated).toBe(false);
  });
});

describe('refreshProjectRootFiles with the native TypeScript API', () => {
  it('removes deleted roots and includes recreated roots in the loaded program', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'tsc-service-root-refresh-'));
    const config = join(testDir, 'tsconfig.json');
    const keptFile = join(testDir, 'kept.ts');
    const changedFile = join(testDir, 'changed.ts');
    writeFileSync(config, JSON.stringify({ compilerOptions: { noEmit: true }, include: ['*.ts'] }));
    writeFileSync(keptFile, 'export const kept = true;\n');
    writeFileSync(changedFile, 'export const removed = true;\n');

    const api = new API({ cwd: testDir });
    let snapshot: any;
    try {
      snapshot = await api.updateSnapshot({ openProjects: [config] });
      expect(snapshot.getProject(config)?.rootFiles).toContain(changedFile);

      rmSync(changedFile);
      snapshot = await api.updateSnapshot({ fileChanges: { invalidateAll: true } });
      // Invalidation refreshes contents but leaves the old include-root set loaded.
      expect(snapshot.getProject(config)?.rootFiles).toContain(changedFile);
      const staleDiagnostics = await snapshot.getProject(config)?.program.getProgramDiagnostics();
      expect(staleDiagnostics?.some((diagnostic: any) => diagnostic.code === 6053)).toBe(true);

      snapshot = await refreshProjectRootFiles({ api, snapshot, projects: [config] });
      expect(snapshot.getProject(config)?.rootFiles).not.toContain(changedFile);
      const deletionDiagnostics = await snapshot.getProject(config)?.program.getProgramDiagnostics();
      expect(deletionDiagnostics?.some((diagnostic: any) => diagnostic.code === 6053)).toBe(false);

      writeFileSync(changedFile, 'export const recreated: number = \"wrong\";\n');
      snapshot = await api.updateSnapshot({ fileChanges: { invalidateAll: true } });
      expect(snapshot.getProject(config)?.rootFiles).not.toContain(changedFile);

      snapshot = await refreshProjectRootFiles({ api, snapshot, projects: [config] });
      expect(snapshot.getProject(config)?.rootFiles).toContain(changedFile);
      const recreationDiagnostics = await snapshot.getProject(config)?.program.getSemanticDiagnostics(changedFile);
      expect(recreationDiagnostics?.some((diagnostic: any) => diagnostic.code === 2322)).toBe(true);
    } finally {
      snapshot?.dispose();
      await api.close();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('checkedSetFor', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('checks resolved importers, excluding bare type-name collisions', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-scope-'));
    const write = (rel: string, body: string) => {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    write('lib/shapes.ts', 'export interface Shape { sides: number }\nexport function area() { return 1; }\n');
    write('lib/uses-type.ts', "const s: Shape = { sides: 1 };\n");
    write('lib/sub/imports-rel.ts', "import { area } from '../shapes.js';\narea();\n");
    write('app/imports-alias.ts', "import { area } from '@/lib/shapes';\narea();\n");
    write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
    write('lib/unrelated.ts', "import { other } from './other.js';\n");
    write('node_modules/pkg/index.d.ts', 'export type Shape = 1;\n');
    const abs = (rel: string) => join(dir, rel);
    const scope = checkedSetFor({
      root: dir,
      named: ['lib/shapes.ts', 'lib/not-in-program.ts'],
      programFiles: ['lib/shapes.ts', 'lib/uses-type.ts', 'lib/sub/imports-rel.ts', 'app/imports-alias.ts', 'lib/unrelated.ts', 'node_modules/pkg/index.d.ts'].map(abs),
      readText: readTextOrNull,
    });
    expect(scope.files.sort()).toEqual(['app/imports-alias.ts', 'lib/shapes.ts', 'lib/sub/imports-rel.ts'].map(abs).sort());
    expect(scope).toMatchObject({ named: 1, typeReferencing: 0, importers: 2, namedNotInProgram: ['lib/not-in-program.ts'] });
  });

  it('treats an index file as importable by its directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-scope-'));
    mkdirSync(join(dir, 'lib/feature'), { recursive: true });
    writeFileSync(join(dir, 'lib/feature/index.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'lib/caller.ts'), "import { x } from './feature';\n");
    const scope = checkedSetFor({
      root: dir,
      named: ['lib/feature/index.ts'],
      programFiles: [join(dir, 'lib/feature/index.ts'), join(dir, 'lib/caller.ts')],
      readText: readTextOrNull,
    });
    expect(scope.importers).toBe(1);
  });

  it('keeps named consumer scope bounded without resolving reverse importers', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-named-scope-'));
    const abs = (name: string) => join(dir, name);
    const named = abs('lib/shapes.ts');
    const caller = abs('app/caller.ts');
    const missing = abs('missing.ts');
    const scope = namedSetFor({
      root: dir,
      named: ['lib/shapes.ts', 'missing.ts'],
      programFiles: [named, caller],
    });
    expect(scope).toEqual({
      files: [named],
      named: 1,
      typeReferencing: 0,
      importers: 0,
      namedNotInProgram: ['missing.ts'],
    });
    expect(scope.files).not.toContain(caller);
    expect(scope.namedNotInProgram).not.toContain(missing);
  });

  it('retains every caller through shared barrels and cycles while reading each module once', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-scope-'));
    const abs = (name: string) => join(dir, name);
    writeFileSync(abs('changed.ts'), 'export interface Shape { sides: number }\n');
    writeFileSync(abs('barrel.ts'), "export type { Shape } from './changed.js';\nexport type { Other } from './cycle.js';\n");
    writeFileSync(abs('cycle.ts'), "export type { Shape } from './barrel.js';\nexport interface Other { value: number }\n");
    const callers = Array.from({ length: 40 }, (_, i) => `caller-${i}.ts`);
    for (const caller of callers) {
      writeFileSync(abs(caller), "import type { Shape } from './barrel.js';\nexport const shape: Shape = { sides: 4 };\n");
    }
    const reads = new Map<string, number>();
    const scope = checkedSetFor({
      root: dir,
      named: ['changed.ts'],
      programFiles: [...callers, 'changed.ts', 'cycle.ts'].map(abs),
      readText: (file: string) => {
        reads.set(file, (reads.get(file) ?? 0) + 1);
        return readTextOrNull(file);
      },
    });
    expect(scope.files.sort()).toEqual([...callers, 'changed.ts', 'cycle.ts'].map(abs).sort());
    expect(scope.importers).toBe(callers.length + 1);
    expect([...reads.keys()].sort()).toEqual([...callers, 'changed.ts', 'cycle.ts', 'barrel.ts'].map(abs).sort());
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
  });

  it('reuses a snapshot dependency census across named scopes and rebuilds after refresh', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-scope-cache-'));
    const abs = (name: string) => join(dir, name);
    writeFileSync(abs('changed.ts'), 'export const value = 1;\n');
    writeFileSync(abs('other.ts'), 'export const value = 2;\n');
    writeFileSync(abs('caller.ts'), "import { value } from './changed.js';\n");
    const reads = new Map<string, number>();
    const dependencyCache = new Map<string, Map<string, Set<string>>>();
    const options = {
      root: dir,
      programFiles: ['changed.ts', 'other.ts', 'caller.ts'].map(abs),
      readText: (file: string) => {
        reads.set(file, (reads.get(file) ?? 0) + 1);
        return readTextOrNull(file);
      },
      dependencyCache,
    };
    expect(checkedSetFor({ ...options, named: ['changed.ts'] }).files.sort())
      .toEqual(['caller.ts', 'changed.ts'].map(abs).sort());
    expect(checkedSetFor({ ...options, named: ['other.ts'] }).files).toEqual([abs('other.ts')]);
    expect([...reads.values()]).toEqual([1, 1, 1]);

    // A new compiler snapshot invalidates the census even when its file list is unchanged.
    writeFileSync(abs('caller.ts'), "import { value } from './other.js';\n");
    dependencyCache.clear();
    expect(checkedSetFor({ ...options, named: ['other.ts'] }).files.sort())
      .toEqual(['caller.ts', 'other.ts'].map(abs).sort());
    expect(checkedSetFor({ ...options, named: ['changed.ts'] }).files).toEqual([abs('changed.ts')]);
    expect([...reads.values()]).toEqual([2, 2, 2]);
  });

  it('stops an overwide service scope after proving its limit without caching an incomplete graph', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-wide-scope-'));
    const abs = (name: string) => join(dir, name);
    writeFileSync(abs('changed.ts'), 'export const value = 1;\n');
    const callers = Array.from({ length: 40 }, (_, i) => `caller-${i}.ts`);
    for (const caller of callers) writeFileSync(abs(caller), "import { value } from './changed.js';\n");
    let reads = 0;
    const dependencyCache = new Map<string, Map<string, Set<string>>>();
    const options = {
      root: dir, named: ['changed.ts'], programFiles: ['changed.ts', ...callers].map(abs),
      dependencyCache, readText: (file: string) => { reads += 1; return readTextOrNull(file); },
    };
    const limited = checkedSetFor({ ...options, maxFiles: 5 });
    expect(limited.files).toHaveLength(6);
    expect(reads).toBeLessThan(options.programFiles.length);
    expect(dependencyCache.size).toBe(0);
    const complete = checkedSetFor(options);
    expect(complete.files).toHaveLength(41);
    expect(limited.files.every((file) => complete.files.includes(file))).toBe(true);
    expect(dependencyCache.size).toBe(1);
  });

  it('yields during reverse-importer census so a client disconnect can cancel the walk', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-cancel-scope-'));
    const abs = (name: string) => join(dir, name);
    writeFileSync(abs('changed.ts'), 'export const value = 1;\n');
    writeFileSync(
      abs('caller.ts'),
      `${Array.from({ length: 512 }, () => "import { value } from './changed.js';").join('\n')}\nexport const caller = value;\n`,
    );

    let cancelled = false;
    let reads = 0;
    // This stands in for the socket's `close` callback. It can only run if the census yields to
    // Node; the synchronous walker should finish before it is observed.
    setImmediate(() => { cancelled = true; });
    const syncScope = checkedSetFor({
      root: dir,
      named: ['changed.ts'],
      programFiles: [abs('caller.ts'), abs('changed.ts')],
      readText: readTextOrNull,
    });
    expect(syncScope.files.sort()).toEqual([abs('caller.ts'), abs('changed.ts')].sort());
    expect(cancelled).toBe(false);

    const dependencyCache = new Map<string, Map<string, Set<string>>>();
    const scope = await checkedSetForCooperatively({
      root: dir,
      named: ['changed.ts'],
      programFiles: [abs('caller.ts'), abs('changed.ts')],
      dependencyCache,
      readText: (file: string) => { reads += 1; return readTextOrNull(file); },
    }, { isCancelled: () => cancelled });

    expect(scope).toBeNull();
    expect(cancelled).toBe(true);
    expect(reads).toBe(1);
    expect(dependencyCache.size).toBe(0);
  }, 5_000);
});

// WI-10007624: on a mixed --files run, operator-core's leg printed "2 named file(s) are not in this
// project's program" for apps/operator files the operator leg had already judged clean, beside its own
// status=clean. It read as a false green. Routed files must be named as judged elsewhere.
describe('formatTscServiceBanner', () => {
  const response = (namedNotInProgram: string[]) =>
    ({
      ok: true,
      checked: ['x'],
      counts: { named: 2, typeReferencing: 0, importers: 0 },
      errorCount: 0,
      queuedMs: 1,
      checkMs: 1,
      snapshotAgeMs: 1,
      namedNotInProgram,
    }) as unknown as Parameters<typeof formatTscServiceBanner>[0];
  const routedOp = ['apps/operator/lib/a.ts', 'apps/operator/lib/b.test.ts'];

  it('names routed files as judged by their own leg, never as not-in-program', () => {
    const lines = formatTscServiceBanner(response(routedOp), { routedAway: routedOp.map((f) => `./${f}`) }).join('\n');
    expect(lines).not.toContain("not in this project's program");
    expect(lines).toContain('2 named file(s) belong to another project and were judged by its own leg');
    expect(lines).toContain('apps/operator/lib/a.ts');
  });

  it('keeps a file nobody judged on the not-in-program line', () => {
    const lines = formatTscServiceBanner(response([...routedOp, 'stray/c.ts']), { routedAway: routedOp }).join('\n');
    expect(lines).toContain("1 named file(s) are not in this project's program, as with the CLI: stray/c.ts");
    expect(lines).toContain('2 named file(s) belong to another project');
  });

  it('without a routed set, behaves exactly as before', () => {
    const lines = formatTscServiceBanner(response(['stray/c.ts'])).join('\n');
    expect(lines).toContain("1 named file(s) are not in this project's program");
    expect(lines).not.toContain('belong to another project');
  });
});

describe('baselineWithinScope', () => {
  it('drops baselined files the service never judged, so they cannot read as improvements', () => {
    expect(baselineWithinScope({ 'a.ts': 2, 'b.ts': 1, '(unattributed)': 1 }, new Set(['a.ts']))).toEqual({ 'a.ts': 2 });
  });
});
