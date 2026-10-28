/**
 * build:typecheck — registration + the two pure helpers behind its refusal path
 * (plan `bash-to-tool-substitution-2026-07-26`, P-024).
 *
 * The compile itself is covered by live verification against the real compiler
 * (a spawn per case would make this suite minutes long for no extra signal);
 * what is asserted here is everything that decides WHETHER a compile happens and
 * what the caller is told when it does not — which is where this tool's whole
 * correctness argument lives.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import * as childProcess from 'node:child_process';
import type { ToolResult } from '@papercusp/tooldef';
import type { TscDiagnostic, TscFileCount } from '../../tsc-diagnostics';

// WI-10003415: a scoped run asks the shared typecheck service first. Every test points at a
// socket that does not exist, so none reaches the real service on this box; the service tests
// below stand up a fake one.
process.env.PAPERCUSP_TSC_SERVICE_SOCKET = join(tmpdir(), `no-tsc-service-${process.pid}.sock`);

const governedExecution = vi.hoisted(() => ({
  begin: vi.fn(),
  finish: vi.fn(async () => true),
  cancel: vi.fn(async () => true),
}));

// ESM module namespaces are frozen (non-configurable), so `vi.spyOn` cannot patch
// `node:child_process`'s `spawn` export directly — it must be mocked at the module
// level instead. Only `spawn` is replaced; everything else passes through to the
// real module via `importOriginal`.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock('../../resource-governor/execution', () => ({
  governedExecutionRuntime: vi.fn(() => ({ governor: {}, driver: {} })),
  beginGovernedExecution: governedExecution.begin.mockImplementation(async () => ({
    receiptId: 'receipt-build-typecheck',
    context: {},
    lease: {},
    finish: governedExecution.finish,
    cancel: governedExecution.cancel,
  })),
}));

import '../index';
import { lookupByMcpName } from '@papercusp/tooldef';
import buildTypecheck, {
  resolveProjectPath,
  suggestProjects,
  runTsc,
  buildScopedTsconfig,
  buildTimeoutHint,
  boundDiagnostics,
  ambientTypePackages,
  projectDeclaresTypes,
  selectTypecheckRoot,
  resolveTypecheckCwd,
  partitionScopedDiagnostics,
  serviceBudgetMs,
  buildTypecheckAbortCompletionReceipt,
} from './typecheck';
// The EI-18776865728050036 class guard moved to capability/foreground-transport-cap.test.ts
// (EI-20645849301780712) — it now lives beside the module it guards, and its tool list is
// COMPLETE. This file's copy enumerated only build:typecheck + testing:run, which is precisely
// how capability:bash and code:run stayed un-clamped while a "class guard" was passing.

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A fake child_process that never emits 'close'/'error' on its own — used to
 * pin runTsc's timeout/kill behaviour without a real wedged subprocess.
 * Module-scoped (not just local to one describe block) so the
 * EI-19342308665972321 process-group-kill tests below can reuse it.
 */
function fakeChild() {
  const emitter = new EventEmitter();
  const killCalls: string[] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(emitter, {
    stdout,
    stderr,
    kill: (signal?: string) => { killCalls.push(signal ?? 'SIGTERM'); return true; },
  });
  return { child: emitter as unknown as childProcess.ChildProcess, killCalls };
}

describe('registration', () => {
  it('is reachable through the projection registry (the index import is not optional)', () => {
    // A tool file that exists but is never imported from agent-tools/index.ts is
    // invisible to every surface — the failure is silent and looks like a
    // missing tool at dispatch time, hours later.
    expect(lookupByMcpName('build:typecheck'), 'build:typecheck missing from the registry').toBeTruthy();
  });

  it('declares the argument surface the substitution audit models', () => {
    expect(Object.keys((buildTypecheck as unknown as { args: { shape: Record<string, unknown> } }).args.shape).sort())
      .toEqual(['dirs', 'files', 'incremental', 'maxErrors', 'project', 'scopeToFiles', 'timeoutMs']);
  });

  it('declares the late-return completion receipt on the projected tool', () => {
    expect(buildTypecheck.abortCompletionReceipt).toBe(buildTypecheckAbortCompletionReceipt);
  });
});

describe('EI-25833565319673625 — build:typecheck late-return receipt', () => {
  const attempt = { callId: 'typecheck-call-1', toolName: 'build:typecheck' };
  const result = (payload: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ data: payload }) }],
  }) as ToolResult;

  it('records a complete failed verdict because diagnostics are still a durable result', () => {
    expect(buildTypecheckAbortCompletionReceipt(
      { project: 'packages/operator-core' },
      result({ ok: false, project: 'packages/operator-core', errorCount: 2, durationMs: 1200 }),
      attempt,
    )).toMatchObject({
      status: 'recorded',
      effectRef: 'build-typecheck:typecheck-call-1:packages/operator-core',
      diagnostics: { project: 'packages/operator-core', ok: false, errorCount: 2 },
    });
  });

  it('keeps a timeout unresolved so a caller does not overlap the timed-out compiler', () => {
    expect(buildTypecheckAbortCompletionReceipt(
      { project: 'packages/operator-core' },
      result({ ok: false, error: 'timeout', project: 'packages/operator-core', durationMs: 58_000 }),
      attempt,
    )).toMatchObject({ status: 'recovery-incomplete', failures: ['typecheck-timeout'] });
  });

  it('marks pre-execution refusals as no-effect outcomes', () => {
    expect(buildTypecheckAbortCompletionReceipt(
      { project: '.' },
      result({ ok: false, error: 'project_not_found' }),
      attempt,
    )).toMatchObject({ status: 'not-recorded', diagnostics: { error: 'project_not_found' } });
  });

  it('fails closed when the result lacks a verdict or attempt identity', () => {
    expect(buildTypecheckAbortCompletionReceipt(
      {},
      result({ ok: true, project: 'packages/operator-core' }),
      { callId: '', toolName: 'build:typecheck' },
    )).toMatchObject({ status: 'recovery-incomplete', failures: ['missing-attempt-identity'] });
    expect(buildTypecheckAbortCompletionReceipt(
      {},
      result({ project: 'packages/operator-core' }),
      attempt,
    )).toMatchObject({ status: 'recovery-incomplete', failures: ['missing-typecheck-verdict'] });
  });
});

describe('bounded diagnostic serialization', () => {
  const diagnostic = (i: number): TscDiagnostic => ({
    file: `file-${i}.ts`,
    line: 1,
    column: 1,
    code: 'TS0000',
    category: 'error',
    message: 'synthetic',
  });
  const fileCount = (i: number): TscFileCount => ({ file: `file-${i}.ts`, count: 1 });

  it('marks both bounded arrays while preserving their complete counts', () => {
    const errors = Array.from({ length: 3 }, (_, i) => diagnostic(i));
    const byFile = Array.from({ length: 31 }, (_, i) => fileCount(i));
    const bounded = boundDiagnostics(errors, byFile, 2);

    expect(bounded.errors).toHaveLength(2);
    expect(bounded.errorsTruncated).toBe(true);
    expect(bounded.byFile).toHaveLength(30);
    expect(bounded.byFileTruncated).toBe(true);
    expect(bounded.filesWithErrors).toBe(31);
  });

  it('does not mark complete arrays as truncated', () => {
    const bounded = boundDiagnostics([diagnostic(0)], [fileCount(0)], 2);

    expect(bounded.errorsTruncated).toBe(false);
    expect(bounded.byFileTruncated).toBe(false);
    expect(bounded.filesWithErrors).toBe(1);
  });
});

describe('scopeToFiles requested-file verdict (EI-19367920569086881)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'build-typecheck-scoped-verdict-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'src', 'target.ts'), 'export const target = 1;');
    writeFileSync(join(root, 'src', 'dependency.ts'), 'export const dependency = 1;');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const diagnostic = (file: string | null, code = 'TS2322'): TscDiagnostic => ({
    file,
    line: file ? 1 : null,
    column: file ? 1 : null,
    code,
    category: 'error',
    message: 'synthetic',
  });

  const runScoped = async (lines: string[], maxErrors = 50) => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout?.emit('data', Buffer.from(`${lines.join('\n')}\n`));
        child.emit('close', 2);
      });
      return child;
    });
    try {
      return await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler(
        { project: '.', files: ['src/target.ts'], scopeToFiles: true, maxErrors },
        { projectDir: root },
      );
    } finally {
      spawnMock.mockReset();
    }
  };

  it('partitions requested, imported, and unattributed diagnostics without reordering them', () => {
    const imported = diagnostic('src/dependency.ts');
    const requested = diagnostic('src/target.ts');
    const global = diagnostic(null, 'TS5023');
    const out = partitionScopedDiagnostics(
      [imported, requested, global],
      [join(root, 'src', 'target.ts')],
    );

    expect(out).toEqual({
      requested: [requested],
      other: [imported, global],
      unattributed: [global],
    });
  });

  it('returns a clean requested-file verdict while keeping imported-file errors visible', async () => {
    const raw = await runScoped([
      "src/dependency.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    ]);

    expect(raw.data).toMatchObject({
      ok: true,
      scopedVerdict: 'requested-files-clean',
      scopedVerdictIncomplete: false,
      errorCount: 0,
      errorsInRequestedFiles: 0,
      totalErrorCount: 1,
      otherErrorCount: 1,
      unattributedErrorCount: 0,
      exitCode: 0,
      compilerExitCode: 2,
    });
    expect(raw.data.errors).toEqual([]);
    expect((raw.data.otherErrors as TscDiagnostic[]).map((error) => error.file)).toEqual([
      'src/dependency.ts',
    ]);
  });

  it('keeps requested-file errors primary even when graph errors arrive first and exhaust the cap', async () => {
    const raw = await runScoped(
      [
        "src/dependency.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/target.ts(2,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      ],
      1,
    );

    expect(raw.data).toMatchObject({
      ok: false,
      scopedVerdict: 'requested-files-error',
      errorCount: 1,
      totalErrorCount: 2,
      otherErrorCount: 1,
      otherErrorsTruncated: true,
      exitCode: 2,
      compilerExitCode: 2,
    });
    expect((raw.data.errors as TscDiagnostic[]).map((error) => error.file)).toEqual(['src/target.ts']);
  });

  it('does not report clean when a global diagnostic makes requested-file coverage indeterminate', async () => {
    const raw = await runScoped(["error TS5023: Unknown compiler option '--synthetic'."]);

    expect(raw.data).toMatchObject({
      ok: false,
      scopedVerdict: 'incomplete',
      scopedVerdictIncomplete: true,
      errorCount: 0,
      otherErrorCount: 1,
      unattributedErrorCount: 1,
      exitCode: 2,
      compilerExitCode: 2,
    });
  });
});

describe('scoped runs ask the shared typecheck service first (WI-10003415)', () => {
  let root: string;
  let socketPath: string;
  let server: Server;
  let requests: Record<string, unknown>[];
  let reply: (request: Record<string, unknown>) => Record<string, unknown>;

  const served = (output: string, errorCount: number, extra: Record<string, unknown> = {}) => ({
    ok: true,
    output,
    errorCount,
    checked: ['src/importer.ts', 'src/target.ts'],
    counts: { named: 1, typeReferencing: 0, importers: 1 },
    namedNotInProgram: [],
    snapshotAgeMs: 5,
    queuedMs: 7,
    refreshMs: 9,
    checkMs: 11,
    ...extra,
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'build-typecheck-service-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'src', 'target.ts'), 'export interface Target { a: number }');
    writeFileSync(join(root, 'src', 'importer.ts'), "import type { Target } from './target';");
    socketPath = join(root, 'svc.sock');
    // The real protocol: one JSON line in, one JSON line back (scripts/lib/tsc-service.mjs).
    server = createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        requests.push(request);
        // Protocol v2: a terminal reply must be a `result`, name the serving runtime, and echo
        // the request's requestId + identity — requestTscService refuses anything else.
        socket.end(
          `${JSON.stringify({
            kind: 'result',
            runtime: { pid: 4242, startedAt: 1 },
            ...reply(request),
            requestId: request.requestId,
            identity: request.identity,
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    reply = () => served('', 0);
    vi.stubEnv('PAPERCUSP_TSC_SERVICE_SOCKET', socketPath);
    vi.stubEnv('PAPERCUSP_TSC_SERVICE', '1');
    governedExecution.begin.mockClear();
    vi.mocked(childProcess.spawn).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(childProcess.spawn).mockReset();
  });

  const handle = (args: Record<string, unknown>) =>
    (
      buildTypecheck as unknown as {
        handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
      }
    ).handler(args, { projectDir: root });

  const scopedArgs = { project: '.', files: ['src/target.ts'], scopeToFiles: true };

  /** The CLI fallback: one fake compiler that prints `lines` and exits `code`. */
  const cliPrints = (lines: string[], code: number) => {
    const { child } = fakeChild();
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (lines.length) child.stdout?.emit('data', Buffer.from(`${lines.join('\n')}\n`));
        child.emit('close', code);
      });
      return child;
    });
  };

  it('answers from the service without spawning a compiler or taking a process admission', async () => {
    reply = () =>
      served("src/importer.ts(1,15): error TS2305: Module './target' has no exported member 'Target'.\n", 1);

    const raw = await handle(scopedArgs);

    expect(requests).toEqual([
      expect.objectContaining({
        v: 2,
        root,
        project: join(root, 'tsconfig.json'),
        files: [join(root, 'src', 'target.ts')],
        requestId: expect.any(String),
        identity: expect.objectContaining({ project: join(root, 'tsconfig.json') }),
      }),
    ]);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(governedExecution.begin).not.toHaveBeenCalled();
    expect(raw.data).toMatchObject({
      ok: true,
      engine: 'tsc-service',
      scopedVerdict: 'requested-files-clean',
      errorCount: 0,
      totalErrorCount: 1,
      otherErrorCount: 1,
      exitCode: 0,
      compilerExitCode: 1,
      serviceScope: { checkedFiles: 2, named: 1, typeReferencing: 0, importers: 1, queuedMs: 7, refreshMs: 9, checkMs: 11 },
    });
    expect(raw.data).not.toHaveProperty('serviceFallback');
    expect(raw.data).not.toHaveProperty('parseWarning');
    // The service's otherErrors are the REVERSE graph (an importer), and the caveat says so.
    expect((raw.data.otherErrors as TscDiagnostic[]).map((error) => error.file)).toEqual(['src/importer.ts']);
    expect(raw.data.scopeCaveat).toMatch(/shared typecheck service/);
    expect(raw.data.scopeCaveat).toMatch(/TRANSITIVE importer/);
  });

  it('reports an error in a requested file as that file failing', async () => {
    reply = () => served("src/target.ts(1,30): error TS2322: Type 'string' is not assignable to type 'number'.\n", 1);

    const raw = await handle(scopedArgs);

    expect(raw.data).toMatchObject({
      ok: false,
      engine: 'tsc-service',
      scopedVerdict: 'requested-files-error',
      errorCount: 1,
      errorsInRequestedFiles: 1,
      exitCode: 1,
    });
  });

  it("cross-checks the parser against the service's own error tally", async () => {
    reply = () => served("src/target.ts(1,30): error TS2322: Type 'string' is not assignable to type 'number'.\n", 2);

    const raw = await handle(scopedArgs);

    expect(raw.data.parseWarning).toMatch(/reported 2 errors but 1 were parsed/);
  });

  it('falls back to the CLI when the service declines, and says why', async () => {
    reply = () => ({ ok: false, reason: 'scope-too-wide', detail: '1600 files (limit 1500)' });
    cliPrints([], 0);

    const raw = await handle(scopedArgs);

    expect(requests).toHaveLength(1);
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(governedExecution.begin).toHaveBeenCalledTimes(1);
    expect(raw.data).toMatchObject({
      ok: true,
      engine: 'tsc-cli',
      serviceFallback: 'declined: scope-too-wide (1600 files (limit 1500))',
      scopedVerdict: 'requested-files-clean',
    });
    expect(raw.data).not.toHaveProperty('serviceScope');
  });

  it('falls back rather than report clean a requested file the service never checked', async () => {
    // A file outside the project's program has no diagnostics on the service because it was
    // never checked. Taking the empty output would be a green the tool did not earn.
    reply = () => served('', 0, { namedNotInProgram: ['src/target.ts'] });
    cliPrints(["src/target.ts(1,30): error TS2322: Type 'string' is not assignable to type 'number'."], 1);

    const raw = await handle(scopedArgs);

    expect(raw.data).toMatchObject({ ok: false, engine: 'tsc-cli', scopedVerdict: 'requested-files-error' });
    expect(raw.data.serviceFallback).toMatch(/never checked them: src\/target\.ts/);
  });

  it('falls back when the service is unreachable', async () => {
    vi.stubEnv('PAPERCUSP_TSC_SERVICE_SOCKET', join(root, 'absent.sock'));
    cliPrints([], 0);

    const raw = await handle(scopedArgs);

    expect(raw.data).toMatchObject({ ok: true, engine: 'tsc-cli' });
    expect(raw.data.serviceFallback).toMatch(/^unreachable at .*absent\.sock/);
  });

  it('never contacts the service when PAPERCUSP_TSC_SERVICE=0', async () => {
    vi.stubEnv('PAPERCUSP_TSC_SERVICE', '0');
    cliPrints([], 0);

    const raw = await handle(scopedArgs);

    expect(requests).toEqual([]);
    expect(raw.data).toMatchObject({ engine: 'tsc-cli', serviceFallback: 'PAPERCUSP_TSC_SERVICE=0' });
  });

  it('keeps a project-wide run on the compiler: only it can give a project-wide total', async () => {
    cliPrints([], 0);

    const raw = await handle({ project: '.', files: ['src/target.ts'] });

    expect(requests).toEqual([]);
    expect(raw.data).toMatchObject({ ok: true, engine: 'tsc-cli' });
    expect(raw.data).not.toHaveProperty('serviceFallback');
  });

  it('leaves the CLI fallback a real share of the foreground budget', () => {
    expect(serviceBudgetMs(50_000)).toBe(35_000);
    expect(serviceBudgetMs(30_000)).toBe(20_000);
    expect(serviceBudgetMs(1_000)).toBe(1_000);
  });
});

describe('EI-19278981435037331 — syntax failures make diagnostic counts lower bounds', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'build-typecheck-completeness-'));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const runWithDiagnostic = async (diagnostic: string) => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout?.emit('data', Buffer.from(`${diagnostic}\n`));
        child.emit('close', 2);
      });
      return child;
    });
    try {
      return await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler({ project: '.' }, { projectDir: root });
    } finally {
      spawnMock.mockReset();
    }
  };

  it('marks a parser-aborted count incomplete even when the returned array was not truncated', async () => {
    const raw = await runWithDiagnostic("broken.ts(1,1): error TS1005: '}' expected.");

    expect(raw.data).toMatchObject({
      ok: false,
      errorCount: 1,
      errorsTruncated: false,
      syntaxBroken: ['broken.ts'],
      semanticCheckIncomplete: true,
    });
    expect(String(raw.data.countCaveat)).toContain('LOWER BOUNDS');
    expect(String(raw.data.countCaveat)).toContain('errorsTruncated:false');
  });

  it('reports a semantic-only diagnostic run as complete and omits the caveat', async () => {
    const raw = await runWithDiagnostic("typed.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.");

    expect(raw.data).toMatchObject({
      ok: false,
      errorCount: 1,
      syntaxBroken: [],
      semanticCheckIncomplete: false,
    });
    expect(raw.data).not.toHaveProperty('countCaveat');
  });
});

describe('resolveProjectPath — tsc\'s own project resolution', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p024-resolve-'));
    mkdirSync(join(root, 'packages', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'packages', 'alpha', 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'packages', 'alpha', 'tsconfig.build.json'), '{}');
    mkdirSync(join(root, 'packages', 'beta'), { recursive: true });
    // beta deliberately has NO tsconfig.json.
    writeFileSync(join(root, 'tsconfig.base.json'), '{}');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('resolves a DIRECTORY to its tsconfig.json', () => {
    expect(resolveProjectPath(root, 'packages/alpha')).toBe(join(root, 'packages', 'alpha', 'tsconfig.json'));
  });

  it('resolves an explicit config FILE to itself (tsconfig.build.json is a real operand in the corpus)', () => {
    expect(resolveProjectPath(root, 'packages/alpha/tsconfig.build.json')).toBe(join(root, 'packages', 'alpha', 'tsconfig.build.json'));
  });

  it('resolves an ABSOLUTE path', () => {
    expect(resolveProjectPath(root, join(root, 'packages/alpha'))).toBe(join(root, 'packages', 'alpha', 'tsconfig.json'));
  });

  it('returns null for a directory with no tsconfig — NOT a silent zero-file check', () => {
    expect(resolveProjectPath(root, 'packages/beta')).toBeNull();
  });

  it('returns null for `.` and `tsconfig.json` at a root that has only tsconfig.base.json', () => {
    // This is the exact live behaviour that motivates the tool: TS5057 / TS5058,
    // zero files checked, and the two most common operands in the whole corpus.
    expect(resolveProjectPath(root, '.')).toBeNull();
    expect(resolveProjectPath(root, 'tsconfig.json')).toBeNull();
  });

  it('returns null for a path that does not exist at all', () => {
    expect(resolveProjectPath(root, 'packages/does-not-exist')).toBeNull();
  });
});

describe('selectTypecheckRoot — phantom-root fallback', () => {
  let requested: string;
  let integration: string;
  let phantom: string;

  beforeAll(() => {
    requested = mkdtempSync(join(tmpdir(), 'build-typecheck-root-requested-'));
    integration = mkdtempSync(join(tmpdir(), 'build-typecheck-root-integration-'));
    phantom = mkdtempSync(join(tmpdir(), 'build-typecheck-root-phantom-'));
    for (const root of [requested, integration]) {
      mkdirSync(join(root, 'packages', 'alpha'), { recursive: true });
      writeFileSync(join(root, 'packages', 'alpha', 'tsconfig.json'), '{}');
    }
  });

  afterAll(() => {
    for (const root of [requested, integration, phantom]) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the integration checkout when the requested root cannot resolve the project', () => {
    expect(selectTypecheckRoot('packages/alpha', phantom, integration))
      .toEqual({ root: integration, source: 'integration-root' });
  });

  it('keeps a valid requested checkout authoritative when both roots resolve the project', () => {
    expect(selectTypecheckRoot('packages/alpha', requested, integration))
      .toEqual({ root: requested, source: 'requested' });
  });

  it('preserves the requested root when neither tree resolves the project', () => {
    expect(selectTypecheckRoot('packages/missing', phantom, integration))
      .toEqual({ root: phantom, source: 'requested' });
  });

  it('uses the canonical fallback in the raw handler, not only in the pure selector', async () => {
    const priorIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = integration;
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    try {
      const raw = await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler({ project: 'packages/alpha' }, { projectDir: phantom });

      expect(raw.data).toMatchObject({
        ok: true,
        project: 'packages/alpha/tsconfig.json',
        errorCount: 0,
      });
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['-p', join(integration, 'packages', 'alpha', 'tsconfig.json')]),
        expect.objectContaining({ cwd: integration }),
      );
      expect(governedExecution.begin).toHaveBeenCalledWith(
        expect.objectContaining({
          admissionClass: 'process',
          payloadRef: 'build:typecheck:packages/alpha/tsconfig.json',
        }),
        expect.objectContaining({ owner: 'build:typecheck' }),
        expect.any(Object),
      );
      expect(governedExecution.finish).toHaveBeenCalled();
    } finally {
      spawnMock.mockReset();
      if (priorIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = priorIntegrationRoot;
    }
  });

  it('keeps project_not_found loud and rooted at the caller tree when fallback also misses', async () => {
    const priorIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = integration;
    try {
      const raw = await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler({ project: 'packages/missing' }, { projectDir: phantom });

      expect(raw.data).toMatchObject({
        ok: false,
        error: 'project_not_found',
        project: 'packages/missing',
        searchedFrom: phantom,
      });
    } finally {
      if (priorIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = priorIntegrationRoot;
    }
  });
});

describe('resolveTypecheckCwd — absolute external projects use their package-local toolchain', () => {
  let callerRoot: string;
  let externalRoot: string;

  beforeAll(() => {
    callerRoot = mkdtempSync(join(tmpdir(), 'build-typecheck-caller-'));
    externalRoot = mkdtempSync(join(tmpdir(), 'build-typecheck-external-'));
    writeFileSync(join(externalRoot, 'tsconfig.json'), '{}');
    // The marker models the target's package-local compiler. The handler still spawns
    // `npx tsc`; its cwd is the selection that makes this binary win over the caller's.
    mkdirSync(join(externalRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(externalRoot, 'node_modules', '.bin', 'tsc'), '#!/usr/bin/env node\n');
  });

  afterAll(() => {
    rmSync(callerRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  });

  it('selects the external config directory for an absolute project outside the caller root', () => {
    expect(resolveTypecheckCwd(join(externalRoot, 'tsconfig.json'), callerRoot, join(externalRoot, 'tsconfig.json')))
      .toEqual({ cwd: externalRoot, source: 'external-project' });
  });

  it('keeps the caller workspace cwd for relative and in-tree absolute projects', () => {
    expect(resolveTypecheckCwd('tsconfig.json', callerRoot, join(callerRoot, 'tsconfig.json')))
      .toEqual({ cwd: callerRoot, source: 'caller' });
    expect(resolveTypecheckCwd(join(callerRoot, 'tsconfig.json'), callerRoot, join(callerRoot, 'tsconfig.json')))
      .toEqual({ cwd: callerRoot, source: 'caller' });
  });

  it('passes the external cwd through the handler to the compiler spawn', async () => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    try {
      const raw = await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler({ project: join(externalRoot, 'tsconfig.json') }, { projectDir: callerRoot });

      expect(raw.data).toMatchObject({ ok: true, errorCount: 0 });
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['tsc', '-p', join(externalRoot, 'tsconfig.json')]),
        expect.objectContaining({ cwd: externalRoot }),
      );
    } finally {
      spawnMock.mockReset();
    }
  });
});

describe('an include-glob file that vanishes mid-run is churn, not "checked nothing" (EI-24801454238382823)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ei2480-vanish-'));
    mkdirSync(join(root, 'lib', 'probe'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'lib', 'probe', 'back.ts'), 'export {};\n');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // tsc's verbatim wording for a glob-listed file it could not read (TypeScript 6.0.3).
  const vanishedLines = (abs: string) => [
    `error TS6053: File '${abs}' not found.`,
    '  The file is in the program because:',
    `    Matched by include pattern 'lib/**/*.ts' in '${join(root, 'tsconfig.json')}'`,
  ];

  async function runWith(lines: string[]) {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout?.emit('data', Buffer.from(`${lines.join('\n')}\n`));
        child.emit('close', 2);
      });
      return child;
    });
    try {
      return await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler({ project: '.' }, { projectDir: root });
    } finally {
      spawnMock.mockReset();
    }
  }

  it('judges the checked program and names the vanished file when it is gone for good', async () => {
    const raw = await runWith(vanishedLines(join(root, 'lib', 'probe', 'gone.ts')));
    expect(raw.data.error).toBeUndefined();
    expect(raw.data).toMatchObject({
      ok: true,
      errorCount: 0,
      vanishedDuringRun: ['lib/probe/gone.ts'],
      inputRaceIncomplete: false,
    });
    expect(raw.data.parseWarning).toBeUndefined();
  });

  it('stays NOT ok when a vanished file exists again — tsc never checked it', async () => {
    const raw = await runWith(vanishedLines(join(root, 'lib', 'probe', 'back.ts')));
    expect(raw.data.error).toBeUndefined();
    expect(raw.data).toMatchObject({
      ok: false,
      inputRaceIncomplete: true,
      vanishedStillPresent: ['lib/probe/back.ts'],
    });
  });

  it('still reports every real error beside a vanished file, and only those', async () => {
    const raw = await runWith([
      ...vanishedLines(join(root, 'lib', 'probe', 'gone.ts')),
      "lib/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ]);
    expect(raw.data).toMatchObject({ ok: false, errorCount: 1, vanishedDuringRun: ['lib/probe/gone.ts'] });
    expect((raw.data.errors as { code: string }[]).map((e) => e.code)).toEqual(['TS2322']);
  });

  it('keeps refusing a genuinely missing operand as nothing_typechecked', async () => {
    const raw = await runWith([
      `error TS6053: File '${join(root, 'nope.ts')}' not found.`,
      '  The file is in the program because:',
      '    Root file specified for compilation',
    ]);
    expect(raw.data).toMatchObject({ ok: false, error: 'nothing_typechecked', code: 'TS6053' });
  });
});

describe('dirs — the directory-attribution question `files` (suffix match) cannot express (EI-22050606808498557)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p024-dirs-'));
    mkdirSync(join(root, 'apps', 'operator-vite', 'lib'), { recursive: true });
    mkdirSync(join(root, 'apps', 'operator', 'lib'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), '{}');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const emitDiagnosticsAndClose = (child: ReturnType<typeof fakeChild>['child']) => {
    queueMicrotask(() => {
      child.stdout?.emit('data', Buffer.from(
        [
          'apps/operator/lib/a.ts(1,1): error TS1: x',
          'apps/operator-vite/lib/b.ts(1,1): error TS1: y',
        ].join('\n') + '\n',
      ));
      child.emit('close', 2);
    });
  };

  it('filters to diagnostics under the requested directory and reports the project-wide total separately', async () => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => { emitDiagnosticsAndClose(child); return child; });
    try {
      const raw = await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler({ project: '.', dirs: ['apps/operator-vite'] }, { projectDir: root });

      expect(raw.data).toMatchObject({ errorCount: 1, totalErrorCount: 2, filteredToDirs: ['apps/operator-vite'] });
      expect((raw.data.errors as { file: string }[]).map((e) => e.file)).toEqual(['apps/operator-vite/lib/b.ts']);
    } finally {
      spawnMock.mockReset();
    }
  });

  it('never matches a sibling directory sharing a name prefix (apps/operator vs apps/operator-vite)', async () => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => { emitDiagnosticsAndClose(child); return child; });
    try {
      const raw = await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler({ project: '.', dirs: ['apps/operator'] }, { projectDir: root });

      expect((raw.data.errors as { file: string }[]).map((e) => e.file)).toEqual(['apps/operator/lib/a.ts']);
    } finally {
      spawnMock.mockReset();
    }
  });

  it('combines with `files` as an OR, deduped, when both are given', async () => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => { emitDiagnosticsAndClose(child); return child; });
    try {
      const raw = await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler(
        { project: '.', dirs: ['apps/operator-vite'], files: ['apps/operator/lib/a.ts'] },
        { projectDir: root },
      );

      expect((raw.data.errors as { file: string }[]).map((e) => e.file).sort()).toEqual([
        'apps/operator-vite/lib/b.ts',
        'apps/operator/lib/a.ts',
      ].sort());
      expect(raw.data.errorCount).toBe(2);
    } finally {
      spawnMock.mockReset();
    }
  });
});

/**
 * EI-22142032090978471 — `npx tsc` with no local tsc binary runs the REGISTRY SQUATTER
 * `tsc@2.0.4` instead: a package whose whole body prints a banner and exits 1.
 *
 * The `tsc_failed_to_run` branch already refused to call that clean (measured: it exits
 * 1, never 0, including on a cold npx cache — the filed "EXITS 0" does not reproduce).
 * What it got wrong was WHICH failure it was, sending the reader after the project
 * operand or the tsconfig when both are fine and `node_modules` is the problem.
 */
describe('EI-22142032090978471 — the npx decoy package is named, not blamed on the tsconfig', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tsc-decoy-'));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Captured verbatim 2026-09-02; ANSI written as `\x1b` per lint:no-control-bytes. */
  const DECOY_BANNER = [
    '',
    '\x1b[41m\x1b[37m                This is not the tsc command you are looking for                \x1b[0m',
    '',
    'To get access to the TypeScript compiler, \x1b[34mtsc\x1b[0m, from the command line either:',
    '- Use \x1b[1mnpm install typescript\x1b[0m to first add TypeScript to your project \x1b[1mbefore\x1b[0m using npx',
  ].join('\n');

  const runWithOutput = async (output: string, exitCode: number) => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout?.emit('data', Buffer.from(`${output}\n`));
        child.emit('close', exitCode);
      });
      return child;
    });
    try {
      return await (
        buildTypecheck as unknown as {
          handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>;
        }
      ).handler({ project: '.' }, { projectDir: root });
    } finally {
      spawnMock.mockReset();
    }
  };

  it('reports tsc_decoy_package_ran with the install remedy, not a tsconfig hunt', async () => {
    const raw = await runWithOutput(DECOY_BANNER, 1);
    expect(raw.data.ok).toBe(false);
    expect(raw.data.error).toBe('tsc_decoy_package_ran');
    expect(String(raw.data.message)).toContain('install:safe');
    // It must actively clear the innocent suspects, or the reader still audits them.
    expect(String(raw.data.message)).toMatch(/tsconfig/i);
  });

  it('CALIBRATION: an ordinary toolchain failure keeps the generic verdict', async () => {
    // Without this, the test above passes just as well if every failure were relabelled
    // as the decoy — which would be a strictly worse misattribution than the one fixed.
    const raw = await runWithOutput('error: cannot find module ./nope', 2);
    expect(raw.data.error).toBe('tsc_failed_to_run');
  });

  it('CALIBRATION: the banner fixture still carries real ANSI, not flattened text', () => {
    expect(DECOY_BANNER).toContain(String.fromCharCode(27));
  });
});

describe('suggestProjects — a refusal has to be actionable', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p024-suggest-'));
    // packages/ alone holds more than the cap, which is what broke the first
    // implementation: it filled all 12 slots before reaching apps/ or libs/.
    for (let i = 0; i < 20; i += 1) {
      mkdirSync(join(root, 'packages', `pkg${String(i).padStart(2, '0')}`), { recursive: true });
      writeFileSync(join(root, 'packages', `pkg${String(i).padStart(2, '0')}`, 'tsconfig.json'), '{}');
    }
    mkdirSync(join(root, 'apps', 'operator'), { recursive: true });
    writeFileSync(join(root, 'apps', 'operator', 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'libs', 'flags'), { recursive: true });
    writeFileSync(join(root, 'libs', 'flags', 'tsconfig.json'), '{}');
    // A directory with no tsconfig must never be suggested.
    mkdirSync(join(root, 'apps', 'no-config'), { recursive: true });
    // EI-19302566985147894: a NESTED workspace (the real one is the
    // `libs/papercusp` git submodule, which carries its own libs/*). Its
    // projects sit at depth 3 and were invisible to the old one-level scan.
    mkdirSync(join(root, 'libs', 'submodule', 'libs', 'db'), { recursive: true });
    writeFileSync(join(root, 'libs', 'submodule', 'libs', 'db', 'tsconfig.json'), '{}');
    // Retired trees and dependency dirs must stay pruned even though they DO
    // contain a real tsconfig.json — suggesting them sends agents at dead code.
    mkdirSync(join(root, 'libs', 'submodule', '_retired', 'apps-web'), { recursive: true });
    writeFileSync(join(root, 'libs', 'submodule', '_retired', 'apps-web', 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'libs', 'submodule', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'libs', 'submodule', 'node_modules', 'dep', 'tsconfig.json'), '{}');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('INTERLEAVES the buckets so a crowded packages/ cannot crowd out apps/ and libs/', () => {
    // Live verification caught the opposite: 12 suggestions, every one from
    // packages/, handed to an agent who meant apps/operator-vite.
    const suggestions = suggestProjects(root);
    expect(suggestions.some((s) => s.startsWith('apps/')), `no apps/ suggestion in: ${suggestions.join(', ')}`).toBe(true);
    expect(suggestions.some((s) => s.startsWith('libs/')), `no libs/ suggestion in: ${suggestions.join(', ')}`).toBe(true);
    expect(suggestions.some((s) => s.startsWith('packages/'))).toBe(true);
  });

  it('caps the list so a refusal stays readable', () => {
    expect(suggestProjects(root).length).toBeLessThanOrEqual(12);
  });

  it('suggests only directories that really contain a tsconfig.json', () => {
    expect(suggestProjects(root)).not.toContain('apps/no-config/tsconfig.json');
    for (const s of suggestProjects(root)) expect(s.endsWith('tsconfig.json')).toBe(true);
  });

  it('finds projects inside a NESTED workspace, not just one level down (EI-19302566985147894)', () => {
    // The old scan read only `libs/<entry>/tsconfig.json`, so every project in
    // the libs/papercusp submodule was permanently unsuggestable and an agent
    // hitting project_not_found was handed a list that implied none existed.
    expect(suggestProjects(root)).toContain('libs/submodule/libs/db/tsconfig.json');
  });

  it('still prunes node_modules and _retired even though they contain real tsconfigs', () => {
    const suggestions = suggestProjects(root);
    expect(suggestions.some((s) => s.includes('node_modules'))).toBe(false);
    expect(suggestions.some((s) => s.includes('_retired'))).toBe(false);
  });

  it('ranks shallower projects first, so widening the scan cannot demote a top-level project', () => {
    const suggestions = suggestProjects(root);
    const flags = suggestions.indexOf('libs/flags/tsconfig.json');
    const nested = suggestions.indexOf('libs/submodule/libs/db/tsconfig.json');
    expect(flags).toBeGreaterThanOrEqual(0);
    expect(nested).toBeGreaterThan(flags);
  });

  it('RANKS projects sharing the requested path prefix first (EI-19302566985147894)', () => {
    // Widening the scan alone fixed nothing on the real tree: the cap is filled
    // by depth-1 projects long before a nested one is reached, so the caller's
    // own operand has to rank the list. Verified live, not just here.
    const suggestions = suggestProjects(root, 'libs/submodule/libs/db');
    expect(suggestions[0]).toBe('libs/submodule/libs/db/tsconfig.json');
  });

  it('surfaces sibling projects of a requested path that has no tsconfig of its own', () => {
    // The real case: an agent edits libs/papercusp/packages/<x>, asks to
    // typecheck it, and needs to be shown the projects that DO exist nearby.
    const suggestions = suggestProjects(root, 'libs/submodule/packages/nothing-here');
    expect(suggestions.some((s) => s.startsWith('libs/submodule/'))).toBe(true);
  });

  it('matches whole path SEGMENTS, so a prefix-of-a-name is not treated as related', () => {
    // 'libs/sub' shares the real segment `libs`, so every libs/* project is
    // legitimately related and ranks. What must NOT happen is `sub` partially
    // matching `submodule` and promoting that subtree above its siblings — a
    // typo would then outrank the projects the caller actually has.
    const suggestions = suggestProjects(root, 'libs/sub');
    expect(suggestions[0]).toBe('libs/flags/tsconfig.json');
    expect(suggestions[0]).not.toBe('libs/submodule/libs/db/tsconfig.json');
    // Contrast: the exact segment DOES promote the subtree.
    expect(suggestProjects(root, 'libs/submodule')[0]).toBe('libs/submodule/libs/db/tsconfig.json');
  });

  it('falls back to the generic interleaved list when the operand relates to nothing', () => {
    // `-p .` is the single most common mistake; it must still get the full list.
    expect(suggestProjects(root, '.')).toEqual(suggestProjects(root));
    expect(suggestProjects(root, 'tsconfig.json')).toEqual(suggestProjects(root));
  });

  it('still caps the list once related projects are prepended', () => {
    expect(suggestProjects(root, 'libs/submodule/libs/db').length).toBeLessThanOrEqual(12);
  });

  it('never repeats a project that is both related and generically ranked', () => {
    const suggestions = suggestProjects(root, 'libs/flags');
    expect(new Set(suggestions).size).toBe(suggestions.length);
  });

  it('returns an empty list rather than throwing when no bucket exists', () => {
    const bare = mkdtempSync(join(tmpdir(), 'p024-bare-'));
    try {
      expect(suggestProjects(bare)).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * EI-20269996848904497: timeout recovery must use a route reachable from su.
 * `capability:inspect` and `capability:bash_output` are not exposed on that surface; the
 * repo's operator-core `lint:tsc` entrypoint is the canonical full-project fallback.
 */
describe('EI-20269996848904497: the timeout hint names the reachable operator-core gate', () => {
  it('uses explicit lint:tsc file scoping and no unreachable detached-tool route', () => {
    const src = readFileSync(join(__dirname, 'typecheck.ts'), 'utf8');
    const timeoutStart = src.indexOf('if (outcome.timedOut)');
    const diagnosticsStart = src.indexOf('const diagnostics = parseTscDiagnostics(outcome.output);', timeoutStart);
    const timeoutBranch = src.slice(timeoutStart, diagnosticsStart);
    expect(timeoutStart).toBeGreaterThanOrEqual(0);
    expect(diagnosticsStart).toBeGreaterThan(timeoutStart);
    expect(timeoutBranch).toMatch(/buildTimeoutHint\(.*args\.scopeToFiles/);
    expect(src).toMatch(/npm run lint:tsc -- --files=path\/to\/changed\.ts,path\/to\/another\.ts/);
    expect(timeoutBranch).not.toMatch(/capability:(inspect|bash_output)/);
  });
});

describe('EI-20277722187795413: scoped timeout guidance escalates instead of looping', () => {
  it('leads with the baseline gate after an already-scoped run timed out', () => {
    const hint = buildTimeoutHint('packages/operator-core/tsconfig.json', 50_000, true);

    expect(hint).toContain('SCOPED RUN ALSO TIMED OUT');
    expect(hint).toContain('npm run lint:tsc -- --files=path/to/changed.ts,path/to/another.ts');
    expect(hint).not.toContain('scopeToFiles');
    expect(hint).not.toContain('CHEAPEST NEXT STEP');
  });

  it('still offers the scoped run after a first project-wide timeout', () => {
    const hint = buildTimeoutHint('packages/operator-core/tsconfig.json', 50_000, false);

    expect(hint).toContain('CHEAPEST NEXT STEP');
    expect(hint).toContain('scopeToFiles: true');
  });
});

/**
 * EI-18793290418757939 — the fleet drain bug: repeated watchdog signal
 * `tool "build:typecheck" exceeded timeout of 60s (handler returned but
 * signal had aborted)`.
 *
 * Root cause: the old runTsc() gated promise resolution on the child's own
 * 'close' event even AFTER firing the internal timeout — it only killed the
 * child and kept waiting. Under real memory-pressure thrashing on this box
 * (repeatedly reported by the infra-liveness watchdog as PSI memory
 * saturation / swap thrashing, the WI-5471 class), a killed process is not
 * guaranteed to actually close promptly, so the handler's real wall-clock
 * time could run well past both the outer MCP deadline and the
 * dispatch-stack's own hard AbortController timeout (60s default) — the
 * "handler returned but signal had aborted" signature is dispatch-stack's own
 * message for exactly that: it aborted, and the handler returned anyway,
 * much later.
 *
 * These tests fake the child process (never emitting 'close') to prove the
 * fix without needing a real wedged subprocess: `runTsc`'s promise must
 * settle at its OWN timer, not whenever (or whether) the child actually dies.
 */
describe('EI-18793290418757939 — runTsc settles at its own timer even when the child never closes', () => {
  it('resolves promptly with timedOut:true instead of hanging on a child that never emits close', async () => {
    const { child, killCalls } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(child);
    try {
      const start = Date.now();
      // Short timeout; the fake child deliberately never emits 'close' or 'error' —
      // simulating a wedged/D-state process that a SIGKILL cannot promptly reap.
      const outcome = await runTsc(['--noEmit'], process.cwd(), 40);
      const elapsedMs = Date.now() - start;

      expect(outcome.timedOut).toBe(true);
      expect(outcome.code).toBeNull();
      // The whole regression: settling must not wait on the child's own lifecycle.
      // Generous vs. the 40ms timer to absorb CI scheduling jitter, but nowhere near
      // "blocked on a process that never closes".
      expect(elapsedMs).toBeLessThan(2000);
      expect(killCalls).toContain('SIGTERM');
    } finally {
      spawnMock.mockReset();
    }
  });

  it('a LATE close/error from the child after settling is a harmless no-op (no double-resolve, no crash)', async () => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(child);
    try {
      const outcome = await runTsc(['--noEmit'], process.cwd(), 20);
      expect(outcome.timedOut).toBe(true);
      // Fire 'close' well after the promise already settled — must not throw,
      // must not change the already-returned outcome.
      expect(() => child.emit('close', 0)).not.toThrow();
      expect(outcome.timedOut).toBe(true);
    } finally {
      spawnMock.mockReset();
    }
  });

  it('still resolves normally (timedOut:false) when the child closes before the timer fires', async () => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(child);
    try {
      queueMicrotask(() => child.emit('close', 0));
      const outcome = await runTsc(['--noEmit'], process.cwd(), 5000);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.code).toBe(0);
    } finally {
      spawnMock.mockReset();
    }
  });
});

/**
 * EI-19342308665972321 — `npx tsc` is TWO processes (npx forks a separate
 * `node .../.bin/tsc` grandchild rather than exec-replacing itself). Killing
 * only the npx wrapper on timeout ORPHANS that grandchild — measured live: a
 * "timed out" compile was still running ~4 minutes after this tool returned
 * `error:'timeout'`. The fix mirrors capability/bash-jobs.ts's already-vetted
 * `detached:true` + negative-pid process-group kill.
 */
describe('EI-19342308665972321 — runTsc kills the WHOLE process group on timeout, not just npx', () => {
  it('spawns tsc as its own process-group leader (detached: true)', async () => {
    const { child } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(child);
    try {
      await runTsc(['--noEmit'], process.cwd(), 20);
      const opts = spawnMock.mock.calls.at(-1)?.[2] as { detached?: boolean } | undefined;
      expect(opts?.detached).toBe(true);
    } finally {
      spawnMock.mockReset();
    }
  });

  it('on timeout, signals the NEGATIVE pid — the whole process group, not just the npx wrapper', async () => {
    const { child } = fakeChild();
    Object.assign(child, { pid: 424242 });
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await runTsc(['--noEmit'], process.cwd(), 20);
      expect(killSpy).toHaveBeenCalledWith(-424242, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
      spawnMock.mockReset();
    }
  });

  it('falls back to a direct child.kill when the process-group signal fails (pid gone/reused)', async () => {
    const { child, killCalls } = fakeChild();
    Object.assign(child, { pid: 424243 });
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      await runTsc(['--noEmit'], process.cwd(), 20);
      expect(killCalls).toContain('SIGTERM');
    } finally {
      killSpy.mockRestore();
      spawnMock.mockReset();
    }
  });

  it('still calls child.kill directly when pid is unavailable — never a silent no-op', async () => {
    // The fake child never sets `pid` (mirrors a spawn that never got a real pid).
    const { child, killCalls } = fakeChild();
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill');
    try {
      await runTsc(['--noEmit'], process.cwd(), 20);
      expect(killSpy).not.toHaveBeenCalled();
      expect(killCalls).toContain('SIGTERM');
    } finally {
      killSpy.mockRestore();
      spawnMock.mockReset();
    }
  });
});

/**
 * EI-19297428004790873 — the scoped-config builder behind `scopeToFiles`.
 *
 * Each assertion here pins a property whose ABSENCE is silent: a broken one does not
 * throw, it produces a config that compiles the wrong program and still exits 0. That
 * is the same false-green shape as the hand-rolled `tsc | head` fallback this mode
 * exists to replace, so these are correctness guards, not shape trivia.
 */
describe('scoped package type references with the real compiler (WI-10006343)', () => {
  let root: string;
  let project: string;
  let ts: typeof import('typescript');
  beforeAll(async () => { ts = await import('typescript'); });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scoped-package-types-'));
    const dir = join(root, 'packages', 'fixture');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'test-kit'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'unwanted-kit'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'test-kit', 'globals.d.ts'), 'declare const testFixtureValue: 42;');
    writeFileSync(join(root, 'node_modules', 'unwanted-kit', 'index.d.ts'), 'declare const unwantedFixtureValue: number;');
    project = join(dir, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      target: 'ES2022', strict: true, skipLibCheck: true, types: ['test-kit/globals'] }, include: ['src/**/*.ts'] }));
    writeFileSync(join(dir, 'src', 'target.ts'), 'export const answer = testFixtureValue;');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function diagnostics(configPath: string) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
    // Match tsc -p: automatic type resolution needs the actual config location.
    expect(parsed.options.configFilePath).toBe(configPath);
    return [...parsed.errors, ...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))]
      .map(error => ({ code: error.code, message: ts.flattenDiagnosticMessageText(error.messageText, '\n') }));
  }

  it('preserves an explicit package subpath type that resolves in the original project', () => {
    expect(diagnostics(project)).toEqual([]);
    const scope = buildScopedTsconfig(root, project, ['packages/fixture/src/target.ts']);
    try { expect(diagnostics(scope.configPath)).toEqual([]); }
    finally { scope.cleanup(); }
  });

  it('does not import other node_modules globals while restoring the explicit package', () => {
    writeFileSync(join(dirname(project), 'src', 'target.ts'), 'export const answer = testFixtureValue + unwantedFixtureValue;');
    const scope = buildScopedTsconfig(root, project, ['packages/fixture/src/target.ts']);
    try {
      const errors = diagnostics(scope.configPath);
      expect(errors).toHaveLength(1);
      expect([2304, 2552]).toContain(errors[0].code);
      expect(errors[0].message).toContain('unwantedFixtureValue');
    } finally { scope.cleanup(); }
  });

  it('keeps an explicitly empty types list empty', () => {
    const config = JSON.parse(readFileSync(project, 'utf8'));
    config.compilerOptions.types = [];
    writeFileSync(project, JSON.stringify(config));
    const scope = buildScopedTsconfig(root, project, ['packages/fixture/src/target.ts']);
    try { expect(diagnostics(scope.configPath).map(error => error.code)).toEqual([2304]); }
    finally { scope.cleanup(); }
  });

  it('still rejects an actually missing package type', () => {
    const config = JSON.parse(readFileSync(project, 'utf8'));
    config.compilerOptions.types = ['missing-kit/globals'];
    writeFileSync(project, JSON.stringify(config));
    const scope = buildScopedTsconfig(root, project, ['packages/fixture/src/target.ts']);
    try { expect(diagnostics(scope.configPath).map(error => error.code)).toContain(2688); }
    finally { scope.cleanup(); }
  });
});

describe('buildScopedTsconfig (scopeToFiles)', () => {
  const pkgRoot = join(__dirname, '..', '..', '..');
  const realFile = join(pkgRoot, 'lib', 'tsc-diagnostics.ts');
  const projectTsconfig = join(pkgRoot, 'tsconfig.json');

  it('emits include:[] so the extended project globs cannot silently pull the whole project back in', () => {
    const s = buildScopedTsconfig(pkgRoot, projectTsconfig, [realFile]);
    try {
      const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
      // Without this, `files` is ADDITIVE to the inherited `include` — the run still
      // looks scoped, costs the same as project-wide, and nothing reports the loss.
      expect(cfg.include, 'inherited include globs would restore project-wide cost').toEqual([]);
      expect(cfg.files).toContain(realFile);
      expect(cfg.files.every((f: string) => isAbsolute(f))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  it('retains project-local ambient declarations without restoring source globs', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'p024-ambient-declarations-'));
    const projectRoot = join(repoRoot, 'apps', 'operator');
    const sourceFile = join(projectRoot, 'ReviewReportShell.tsx');
    const rootAmbient = join(projectRoot, 'css-modules.d.ts');
    const nestedAmbient = join(projectRoot, 'types', 'globals.d.ts');
    const dependencyAmbient = join(projectRoot, 'node_modules', 'pkg', 'index.d.ts');
    const projectTsconfig = join(projectRoot, 'tsconfig.json');
    mkdirSync(dirname(sourceFile), { recursive: true });
    mkdirSync(dirname(nestedAmbient), { recursive: true });
    mkdirSync(dirname(dependencyAmbient), { recursive: true });
    writeFileSync(sourceFile, 'export const shell = 1;');
    writeFileSync(rootAmbient, "declare module '*.css';");
    writeFileSync(nestedAmbient, 'declare const ambientGlobal: string;');
    writeFileSync(dependencyAmbient, 'declare const dependencyGlobal: string;');
    writeFileSync(
      projectTsconfig,
      JSON.stringify({ include: ['**/*.ts', '**/*.tsx'] }),
    );

    try {
      const s = buildScopedTsconfig(repoRoot, projectTsconfig, [sourceFile]);
      try {
        const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
        expect(cfg.include).toEqual([]);
        expect(cfg.files.sort()).toEqual([sourceFile, rootAmbient, nestedAmbient].sort());
        expect(cfg.files).not.toContain(dependencyAmbient);
      } finally {
        s.cleanup();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('writes typeRoots and extends as ABSOLUTE paths, because the config lives outside the tree', () => {
    const s = buildScopedTsconfig(pkgRoot, projectTsconfig, [realFile]);
    try {
      const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
      // Relative here resolves against the TEMP dir, so every ambient @types vanishes
      // and the run drowns in phantom errors — the trap that cost the filing agent a round.
      expect(isAbsolute(cfg.compilerOptions.typeRoots[0])).toBe(true);
      expect(isAbsolute(cfg.extends)).toBe(true);
      expect(cfg.compilerOptions.rootDir).toBe(pkgRoot);
      expect(cfg.files.every((f: string) => isAbsolute(f))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  it('writes the config OUTSIDE the repo tree, so git-sync cannot sweep it into a commit', () => {
    const s = buildScopedTsconfig(pkgRoot, projectTsconfig, [realFile]);
    try {
      // git-sync commits the WHOLE shared tree on a timer; a temp tsconfig written
      // next to the real one would be committed by whoever's tick lands first.
      expect(s.configPath.startsWith(pkgRoot), `scoped config leaked into the tree at ${s.configPath}`).toBe(false);
      expect(s.configPath.startsWith(tmpdir())).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  it('separates resolvable files from missing ones instead of silently dropping them', () => {
    const s = buildScopedTsconfig(pkgRoot, projectTsconfig, [realFile, 'lib/does-not-exist-xyz.ts']);
    try {
      // A dropped path is how a scoped run ends up compiling an empty program and
      // exiting 0 — the handler refuses on an empty resolvedFiles, which needs this split.
      expect(s.resolvedFiles).toHaveLength(1);
      expect(s.missing).toEqual(['lib/does-not-exist-xyz.ts']);
    } finally {
      s.cleanup();
    }
  });

  it('resolves repo-relative paths against the root and leaves absolute ones alone', () => {
    const s = buildScopedTsconfig(pkgRoot, projectTsconfig, ['lib/tsc-diagnostics.ts']);
    try {
      expect(s.missing).toEqual([]);
      expect(s.resolvedFiles[0]).toBe(realFile);
    } finally {
      s.cleanup();
    }
  });

  it('resolves package-relative paths when the selected project is nested under the repository root', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'p024-repo-root-'));
    const nestedRoot = join(repoRoot, 'packages', 'operator-core');
    const nestedFile = join(nestedRoot, 'lib', 'example.ts');
    const nestedTsconfig = join(nestedRoot, 'tsconfig.json');
    mkdirSync(dirname(nestedFile), { recursive: true });
    writeFileSync(nestedFile, 'export const example = 1;');
    writeFileSync(nestedTsconfig, '{}');

    try {
      const s = buildScopedTsconfig(repoRoot, nestedTsconfig, ['lib/example.ts']);
      try {
        expect(s.missing).toEqual([]);
        expect(s.resolvedFiles).toEqual([nestedFile]);
      } finally {
        s.cleanup();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('cleanup removes the temp directory and is safe to call twice', () => {
    const s = buildScopedTsconfig(pkgRoot, projectTsconfig, [realFile]);
    expect(existsSync(s.configPath)).toBe(true);
    s.cleanup();
    expect(existsSync(s.configPath)).toBe(false);
    expect(() => s.cleanup()).not.toThrow();
  });
});

// Trap 3: absolute `typeRoots` is NECESSARY BUT NOT SUFFICIENT. With `types` left
// undefined, TS's automatic "@types under typeRoots" inclusion does not survive the config
// living in a temp dir, so every ambient global disappears. MEASURED 2026-08-02 on
// apps/operator/scripts/hooks/cc/__tests__/pc-heavy.test.ts: 28 phantom errors -> 0 with
// `types` populated. It hid for so long because operator-core — the project the scoped mode
// was proved on — declares `types: ["node"]` itself and was immune.
describe('ambientTypePackages — what tsc would have auto-included', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p024-ambient-'));
    const typeRoot = join(root, 'node_modules', '@types');
    mkdirSync(join(typeRoot, 'node'), { recursive: true });
    mkdirSync(join(typeRoot, 'babel__core'), { recursive: true });
    mkdirSync(join(typeRoot, '.cache'), { recursive: true });
    writeFileSync(join(typeRoot, 'README.md'), 'not a package');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('returns the directory names as bare package names, sorted', () => {
    // Bare names are the form `compilerOptions.types` expects — NOT paths.
    expect(ambientTypePackages(join(root, 'node_modules', '@types'))).toEqual([
      'babel__core',
      'node',
    ]);
  });

  it('ignores files and dot-directories, which are not packages', () => {
    const got = ambientTypePackages(join(root, 'node_modules', '@types'));
    expect(got).not.toContain('README.md');
    expect(got).not.toContain('.cache');
  });

  it('returns [] rather than throwing when @types does not exist', () => {
    // The caller keys off the empty array to OMIT `types` entirely. Emitting `types: []`
    // would mean "include NO ambient packages" — strictly worse than not setting it, and
    // would guarantee the exact phantom-error flood this repair exists to stop.
    expect(ambientTypePackages(join(root, 'nope', '@types'))).toEqual([]);
  });
});

describe('projectDeclaresTypes — the gate that keeps the repair from being destructive', () => {
  let root: string;
  const write = (name: string, body: unknown | string) =>
    writeFileSync(
      join(root, name),
      typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    );

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p024-declares-'));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('is TRUE when the project declares compilerOptions.types', () => {
    // MEASURED 2026-08-02: injecting the full 96-package enumeration into a scoped run of
    // packages/operator-core took it from 1 error to 92 — an explicit `types` in the
    // extending config OVERRIDES the inherited one, and operator-core pins `types: ["node"]`
    // precisely to keep the other ambient test-framework globals out.
    write('declares.json', { compilerOptions: { types: ['node'] } });
    expect(projectDeclaresTypes(join(root, 'declares.json'))).toBe(true);
  });

  it('is TRUE for an explicitly EMPTY types, which is a deliberate exclusion', () => {
    // `types: []` means "no ambient packages at all" — a stronger statement than silence,
    // and the one case where overriding would do the most damage.
    write('empty-types.json', { compilerOptions: { types: [] } });
    expect(projectDeclaresTypes(join(root, 'empty-types.json'))).toBe(true);
  });

  it('is FALSE when nothing in the chain declares types — the case the repair is for', () => {
    write('bare.json', { compilerOptions: { strict: true } });
    expect(projectDeclaresTypes(join(root, 'bare.json'))).toBe(false);
  });

  it('is FALSE for a config with no compilerOptions at all', () => {
    write('nothing.json', { include: ['src'] });
    expect(projectDeclaresTypes(join(root, 'nothing.json'))).toBe(false);
  });

  it('follows the extends chain and finds a types declared by the PARENT', () => {
    write('parent-typed.json', { compilerOptions: { types: ['node'] } });
    write('child-of-typed.json', { extends: './parent-typed.json', compilerOptions: { strict: true } });
    expect(projectDeclaresTypes(join(root, 'child-of-typed.json'))).toBe(true);
  });

  it('follows the extends chain and still reports FALSE when no link declares types', () => {
    write('grandparent-bare.json', { compilerOptions: { strict: true } });
    write('parent-bare.json', { extends: './grandparent-bare.json' });
    write('child-bare.json', { extends: './parent-bare.json' });
    expect(projectDeclaresTypes(join(root, 'child-bare.json'))).toBe(false);
  });

  it('resolves an extends WITHOUT the .json suffix, the way tsc does', () => {
    write('suffixless-parent.json', { compilerOptions: { types: ['node'] } });
    write('suffixless-child.json', { extends: './suffixless-parent' });
    expect(projectDeclaresTypes(join(root, 'suffixless-child.json'))).toBe(true);
  });

  it('is FALSE for a tsconfig whose paths contain "@/*" AND a later "**/*" glob — the case that defeated the first implementation', () => {
    // REGRESSION GUARD, not a hypothetical. The first version stripped JSONC comments
    // UNCONDITIONALLY, and the block-comment regex treated the `/*` inside `"@/*"` as the
    // START of a comment. It then ran to the first `*/` it could find — which is the `*/`
    // inside an `"**/*.ts"` include glob — and ate everything between: all of `paths`, and
    // whatever else lay in the gap. That made apps/operator's perfectly VALID JSON
    // unparseable; since this function fails open, every project then reported "declares
    // types", the repair silently never ran, and every surface still looked right.
    // Hence: JSON.parse FIRST, strip only as a fallback.
    //
    // ⚠ BOTH HALVES ARE LOAD-BEARING. A fixture with only the `@/*` alias PASSES against
    // the broken implementation too — the regex needs a closing `*/` to consume anything,
    // so an unpaired opener strips nothing and the JSON survives. Verified 2026-08-02
    // against the original code: alias-only => parses (test vacuous); alias + `**/*.ts`
    // => throws (test bites). Do not "simplify" this fixture down to the alias.
    const fixture = {
      compilerOptions: {
        strict: true,
        baseUrl: '.',
        paths: { '@/*': ['./*'], '@papercusp/operator-core/*': ['../../packages/operator-core/*'] },
      },
      include: ['**/*.ts', '**/*.tsx'],
    };
    const raw = JSON.stringify(fixture, null, 2);
    // Assert the fixture is still ADVERSARIAL, so a later edit cannot quietly defang it.
    expect(/\/\*[\s\S]*?\*\//.test(raw), 'fixture no longer contains a /* … */ pair — it would pass against the BROKEN implementation too').toBe(true);
    write('alias.json', raw);
    expect(projectDeclaresTypes(join(root, 'alias.json'))).toBe(false);
  });

  it('still parses a genuinely JSONC config (comments + trailing comma) via the fallback', () => {
    write(
      'jsonc.json',
      ['{', '  // the ambient set is pinned on purpose', '  "compilerOptions": {', '    "types": ["node"],', '  },', '}'].join('\n'),
    );
    expect(projectDeclaresTypes(join(root, 'jsonc.json'))).toBe(true);
  });

  it('fails OPEN (true) on a file that does not exist', () => {
    // The enumeration is a repair for a KNOWN-broken case, never something to force on a
    // project whose intent we could not read.
    expect(projectDeclaresTypes(join(root, 'absent.json'))).toBe(true);
  });

  it('fails OPEN (true) on genuinely malformed JSON', () => {
    write('broken.json', '{ this is not json at all ');
    expect(projectDeclaresTypes(join(root, 'broken.json'))).toBe(true);
  });

  it('fails OPEN (true) on a BARE PACKAGE extends, which is not resolvable from here', () => {
    write('pkg-extends.json', { extends: '@tsconfig/node20/tsconfig.json' });
    expect(projectDeclaresTypes(join(root, 'pkg-extends.json'))).toBe(true);
  });

  it('fails OPEN (true) on an extends pointing at a file that is missing', () => {
    write('dangling.json', { extends: './no-such-parent.json' });
    expect(projectDeclaresTypes(join(root, 'dangling.json'))).toBe(true);
  });

  it('fails OPEN (true) on a CYCLIC extends chain instead of recursing forever', () => {
    write('cycle-a.json', { extends: './cycle-b.json' });
    write('cycle-b.json', { extends: './cycle-a.json' });
    expect(projectDeclaresTypes(join(root, 'cycle-a.json'))).toBe(true);
  });
});

describe('buildScopedTsconfig — the types gate, end to end', () => {
  let root: string;
  let file: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p024-typesgate-'));
    mkdirSync(join(root, 'node_modules', '@types', 'node'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '@types', 'babel__core'), { recursive: true });
    file = join(root, 'a.ts');
    writeFileSync(file, 'export const a = 1;\n');
    writeFileSync(
      join(root, 'tsconfig.undeclared.json'),
      // Shaped like the real apps/operator: a `@/*` alias AND a `**/*.ts` glob, i.e. a
      // `/* … */` pair. See the projectDeclaresTypes alias test for why both halves matter
      // — with only the alias this fixture passes against the broken implementation too.
      JSON.stringify({
        compilerOptions: { strict: true, paths: { '@/*': ['./*'] } },
        include: ['**/*.ts'],
      }),
    );
    writeFileSync(
      join(root, 'tsconfig.declared.json'),
      JSON.stringify({ compilerOptions: { types: ['node'] } }),
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('INJECTS the enumerated ambient set for a project that declares no types', () => {
    const s = buildScopedTsconfig(root, join(root, 'tsconfig.undeclared.json'), [file]);
    try {
      const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
      expect(cfg.compilerOptions.types).toEqual(['babel__core', 'node']);
    } finally {
      s.cleanup();
    }
  });

  it('OMITS types entirely for a project that declares its own, leaving the inherited set intact', () => {
    const s = buildScopedTsconfig(root, join(root, 'tsconfig.declared.json'), [file]);
    try {
      const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
      // Not `types: []` — the key must be ABSENT, or it overrides the project's own pin.
      expect('types' in cfg.compilerOptions).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  it('OMITS types when @types cannot be read, degrading to the previous behaviour', () => {
    const bare = mkdtempSync(join(tmpdir(), 'p024-notypes-'));
    const bareFile = join(bare, 'a.ts');
    writeFileSync(bareFile, 'export const a = 1;\n');
    writeFileSync(join(bare, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    const s = buildScopedTsconfig(bare, join(bare, 'tsconfig.json'), [bareFile]);
    try {
      const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
      expect('types' in cfg.compilerOptions).toBe(false);
    } finally {
      s.cleanup();
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
