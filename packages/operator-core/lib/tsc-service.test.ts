/**
 * WI-10003404 / plan host-memory-reduction-2026-09-27 P-004 — the shared typecheck service's pure
 * half (scripts/lib/tsc-service.mjs): which gate runs may use it, which files a scoped verdict
 * needs checked, and rendering API diagnostics in the CLI's own `--pretty false` text so the gate's
 * existing parser reads service output unchanged.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
const nativeDir = dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json'));
const { API } = await import(pathToFileURL(join(nativeDir, 'dist/api/async/api.js')).href);
// eslint-disable-next-line import/no-relative-packages
import {
  TSC_SERVICE_ENV,
  TSC_SERVICE_TIMEOUT_MS,
  TSC_SERVICE_UNIT_TEMPLATE_ENV,
  baselineWithinScope,
  checkedSetFor,
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
  tscServiceSocketPath,
  tscServiceTemplateSocket,
  tscServiceTemplateSocketUnit,
  typecheckViaService,
  unescapeSystemctlValue,
} from '../../../scripts/lib/tsc-service.mjs';
// eslint-disable-next-line import/no-relative-packages
import { parseTscErrors } from '../../../scripts/lib/tsc-baseline-gate.mjs';

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
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (data) => receivedIds.push(JSON.parse(String(data)).requestId));
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const lines: string[] = [];
    try {
      const startedAt = Date.now();
      const result = await typecheckViaService({
        root: '/repo',
        project: '/repo/tsconfig.json',
        files: ['src/a.ts'],
        label: 'test',
        timeoutMs: 50,
        log: (line) => lines.push(line),
        env: { PAPERCUSP_TSC_SERVICE_SOCKET: socketPath },
      });

      expect(result).toBeNull();
      expect(lines.join('\n')).toContain('no answer within 50 ms');
      expect(receivedIds).toHaveLength(1);
      expect(receivedIds[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(lines.join('\n')).toContain(`requestId=${receivedIds[0]}`);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
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
      env: { ...process.env, PAPERCUSP_TSC_SERVICE_ROOT: dir, PAPERCUSP_TSC_SERVICE_SOCKET: socketPath },
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
      // Drain stdout before inspecting the trace and assert that the compiler child also exits.
      child.kill('SIGTERM');
      await closed;
      for (const phase of ['queued', 'refresh', 'refreshed', 'program-files', 'scope', 'program-diagnostics', 'file-diagnostics', 'render-diagnostics', 'complete']) {
        expect(output).toContain(`requestId=trace-test-123 project=tsconfig.json named=1 phase=${phase}`);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
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
