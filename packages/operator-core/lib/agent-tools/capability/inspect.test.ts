/**
 * Unit tests for capability:inspect's command resolution (EI-524 / P-035).
 * The exec itself reuses the bash-jobs runner (tested in bash-jobs.test.ts); the
 * security-load-bearing part is the PURE command construction + path validation,
 * which is what these cover — proving the agent can never inject a shell command.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const canonicalBackground = vi.hoisted(() => vi.fn(async () => ({ data: {
  ok: true, mode: 'background', status: 'pending', detachedRunId: 'canonical-run',
  taskId: 'canonical-task', statusRef: { tool: 'testing:run-status', args: { runId: 'canonical-run' } },
} })));
vi.mock('../testing/run', () => ({ default: {
  args: { safeParse: (args: unknown) => ({ success: true, data: args }) }, handler: canonicalBackground,
} }));

// The response contract is independent of child-process execution. Keep this
// regression deterministic by replacing only the launcher while preserving the
// real command-resolution and cwd validation paths below.
vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  startBackground: vi.fn(),
}));
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
  capabilityExecSandboxPolicy: vi.fn(async () => ({ enabled: false, required: false })),
}));
vi.mock('../../../../../scripts/lib/tsc-baseline-gate.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../scripts/lib/tsc-baseline-gate.mjs')>()),
  discoverSiblingTypecheckGates: vi.fn(async () => ({
    gates: [{ npmScript: 'lint:tsc', prefixes: ['packages/operator-core/', 'pkg/'] }],
    unresolved: [],
    rosterReadable: true,
  })),
}));

import {
  resolveInspectCommand,
  resolveScopedTypecheckCommand,
  resolveTypecheckCwd,
  filterTscOutputToPaths,
  deadTypecheckVerdict,
  resolveNpmWorkspaceAlias,
} from './inspect';
import inspectTool from './inspect';
import { startBackground } from './bash-jobs';
import { vmCopyInspectSchema } from './vm-copy-authority';

const BASE = '/repo';
const OPERATOR_CORE_GATES = [{ npmScript: 'lint:tsc', prefixes: ['packages/operator-core/'] }];
const INSPECT_STATE = mkdtempSync(join(tmpdir(), 'cap-inspect-response-'));
const INSPECT_PACKAGE = join(INSPECT_STATE, 'pkg');
mkdirSync(INSPECT_PACKAGE);
mkdirSync(join(INSPECT_PACKAGE, 'src'));
writeFileSync(join(INSPECT_PACKAGE, 'src/a.ts'), 'export const a = 1;\n');
const NODE_TEST_PACKAGE = join(INSPECT_STATE, 'node-tests');
mkdirSync(join(NODE_TEST_PACKAGE, 'test'), { recursive: true });
writeFileSync(
  join(NODE_TEST_PACKAGE, 'package.json'),
  JSON.stringify({
    name: 'node-tests',
    scripts: {
      'test:node-file': 'node --test test/foo.test.js',
      'test:node-many': 'node --test test/foo.test.js test/bar.test.js',
    },
  }),
);
writeFileSync(join(NODE_TEST_PACKAGE, 'test/foo.test.js'), '');
writeFileSync(join(NODE_TEST_PACKAGE, 'test/bar.test.js'), '');
writeFileSync(join(NODE_TEST_PACKAGE, 'test/unlisted.test.js'), '');

type ToolResultish = { content: Array<{ text: string }>; isError?: boolean };
type Tool = { handler: (a: unknown, c: unknown) => Promise<ToolResultish> };
const inspect = inspectTool as unknown as Tool;

function inspectCtx() {
  return {
    projectDir: INSPECT_STATE,
    stateDir: INSPECT_STATE,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
  } as never;
}

describe('protected vm-copy inspect branch', () => {
  const request = { schemaVersion: 1, phase: 'preflight', challenge: 'c'.repeat(64), operationId: 'copy-1',
    manifestRawBase64: Buffer.from('{}').toString('base64'), manifestSha256: 'a'.repeat(64) };
  it('advertises a distinct strict branch and rejects shell/identity overrides', () => {
    const schema = (inspectTool as unknown as { args: { safeParse(value: unknown): { success: boolean } } }).args;
    expect(schema.safeParse({ check: 'vm-copy-authority', request }).success).toBe(true);
    expect(schema.safeParse({ check: 'vm-copy-authority', request, command: 'anything' }).success).toBe(false);
    expect(schema.safeParse({ check: 'vm-copy-authority', request: { ...request, ownerId: 'foreign' } }).success).toBe(false);
    expect(vmCopyInspectSchema.safeParse({ check: 'test', request }).success).toBe(false);
  });
  it('refuses an invalid manifest before resolving a cwd or starting a shell', async () => {
    const start = vi.mocked(startBackground); const calls = start.mock.calls.length;
    const result = await inspect.handler({ check: 'vm-copy-authority', request }, {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).reason).toBe('vm-copy-manifest-digest');
    expect(start.mock.calls.length).toBe(calls);
  });
});

describe('resolveInspectCommand — verb mapping', () => {
  it('typecheck requires a package', () => {
    const r = resolveInspectCommand({ check: 'typecheck' }, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_args');
  });

  it('typecheck with a package → `npx tsc --noEmit` in the package dir', () => {
    expect(resolveInspectCommand({ check: 'typecheck', package: 'packages/operator-core' }, BASE)).toEqual({
      ok: true,
      command: 'npx tsc --noEmit',
      cwd: '/repo/packages/operator-core',
    });
  });

  it('an unresolved scoped npm name still fails bad_package, naming both accepted forms', () => {
    const r = resolveInspectCommand({ check: 'typecheck', package: '@papercusp/not-a-pkg' }, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('bad_package');
      expect(r.message).toContain('repository-relative directory containing tsconfig.json');
      expect(r.message).toContain('@papercusp/operator-core');
    }
  });

  it('EI-21200682380693689: an npm workspace alias resolves to the workspace dir', () => {
    expect(
      resolveInspectCommand(
        { check: 'typecheck', package: '@papercusp/operator-core' },
        BASE,
        (name) => (name === '@papercusp/operator-core' ? 'packages/operator-core' : null),
      ),
    ).toEqual({ ok: true, command: 'npx tsc --noEmit', cwd: '/repo/packages/operator-core' });
  });

describe('resolveNpmWorkspaceAlias — EI-21200682380693689', () => {
  it('resolves a scoped workspace name through its real node_modules symlink, end to end', () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-inspect-ws-'));
    const pkgDir = join(root, 'libs', 'flags');
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(join(root, 'node_modules', '@papercusp'), { recursive: true });
    symlinkSync(pkgDir, join(root, 'node_modules', '@papercusp', 'flags'), 'dir');
    expect(resolveNpmWorkspaceAlias('@papercusp/flags', root)).toBe(join('libs', 'flags'));
    // The DEFAULT (filesystem-backed) wiring through the pure resolver.
    expect(resolveInspectCommand({ check: 'typecheck', package: '@papercusp/flags' }, root)).toEqual({
      ok: true,
      command: 'npx tsc --noEmit',
      cwd: pkgDir,
    });
  });

  it('passes non-scoped names through and refuses unresolved or escaping links', () => {
    expect(resolveNpmWorkspaceAlias('flags', '/repo')).toBeNull();
    expect(resolveNpmWorkspaceAlias('@papercusp/missing', '/repo')).toBeNull();
    // A link whose target escapes the project dir is not a workspace.
    expect(resolveNpmWorkspaceAlias('@papercusp/evil', '/repo', () => '/etc/passwd')).toBeNull();
    // A link resolving INSIDE node_modules (a vendored dep) is refused.
    expect(
      resolveNpmWorkspaceAlias('@papercusp/vendor', '/repo', () => '/repo/node_modules/@papercusp/vendor'),
    ).toBeNull();
  });
});

  it('typecheck with package-relative onlyPaths → the package baseline gate with repo-relative files', () => {
    expect(
      resolveScopedTypecheckCommand(
        {
          check: 'typecheck',
          package: 'packages/operator-core',
          onlyPaths: ['lib/agent-tools/git_sync/run.ts', 'lib/agent-tools/git_sync/run.test.ts'],
        },
        BASE,
        OPERATOR_CORE_GATES,
        () => true,
      ),
    ).toEqual({
      ok: true,
      command:
        'npm run lint:tsc -- --files=packages/operator-core/lib/agent-tools/git_sync/run.ts,packages/operator-core/lib/agent-tools/git_sync/run.test.ts',
      cwd: BASE,
    });
  });

  it('typecheck with repo-relative onlyPaths does not double-prefix the package', () => {
    expect(
      resolveScopedTypecheckCommand(
        {
          check: 'typecheck',
          package: 'packages/operator-core',
          onlyPaths: ['packages/operator-core/lib/agent-tools/git_sync/run.ts'],
        },
        BASE,
        OPERATOR_CORE_GATES,
        () => true,
      ),
    ).toEqual({
      ok: true,
      command: 'npm run lint:tsc -- --files=packages/operator-core/lib/agent-tools/git_sync/run.ts',
      cwd: BASE,
    });
  });

  it('refuses a scoped run when no declared baseline gate covers the file', () => {
    const r = resolveScopedTypecheckCommand(
      { check: 'typecheck', package: 'libs/raw-tsc-package', onlyPaths: ['src/a.ts'] },
      BASE,
      OPERATOR_CORE_GATES,
      () => true,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('no_baseline_gate');
      expect(r.message).toContain('cannot honestly judge');
    }
  });

  it('refuses a covered-but-missing onlyPath instead of manufacturing a scoped green', () => {
    const r = resolveScopedTypecheckCommand(
      { check: 'typecheck', package: 'packages/operator-core', onlyPaths: ['lib/does-not-exist.ts'] },
      BASE,
      OPERATOR_CORE_GATES,
      () => false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('only_path_not_found');
      expect(r.message).toContain('never present');
    }
  });

  it('refuses paths spanning multiple baseline gates instead of producing one misleading verdict', () => {
    const r = resolveScopedTypecheckCommand(
      {
        check: 'typecheck',
        package: 'packages/operator-core',
        onlyPaths: [
          'packages/operator-core/lib/a.ts',
          'apps/operator-vite/src/b.ts',
        ],
      },
      BASE,
      [
        ...OPERATOR_CORE_GATES,
        { npmScript: 'lint:tsc:operator-vite', prefixes: ['apps/operator-vite/'] },
      ],
      () => true,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('mixed_baseline_gates');
      expect(r.message).toContain('Split them');
    }
  });

  it('test with no package → repo `npm run test:affected` at the root', () => {
    expect(resolveInspectCommand({ check: 'test' }, BASE)).toEqual({
      ok: true,
      command: 'npm run test:affected',
      cwd: BASE,
    });
  });

  it('test with a package → `npx vitest run` in the package', () => {
    expect(resolveInspectCommand({ check: 'test', package: 'libs/flags' }, BASE)).toEqual({
      ok: true,
      command: 'npx vitest run',
      cwd: '/repo/libs/flags',
    });
  });

  it('test with a package + path → narrows the vitest run to the file', () => {
    expect(resolveInspectCommand({ check: 'test', package: 'libs/flags', path: 'src/x.test.ts' }, BASE)).toEqual({
      ok: true,
      command: 'npx vitest run src/x.test.ts',
      cwd: '/repo/libs/flags',
    });
  });

  it('test with a package + repo-relative path → normalizes to the package-relative file', () => {
    expect(
      resolveInspectCommand({
        check: 'test',
        package: 'packages/operator-core',
        path: 'packages/operator-core/lib/foo.test.ts',
      }, BASE),
    ).toEqual({
      ok: true,
      command: 'npx vitest run lib/foo.test.ts',
      cwd: '/repo/packages/operator-core',
    });
  });

  it('test with a package + integration path → uses the repository test router', () => {
    expect(
      resolveInspectCommand({
        check: 'test',
        package: 'packages/operator-core',
        path: 'lib/events/await/await-store.integration.test.ts',
      }, BASE),
    ).toEqual({
      ok: true,
      command: 'npm run test:file -- packages/operator-core/lib/events/await/await-store.integration.test.ts',
      cwd: BASE,
    });
  });

  it('test with a package + e2e path → uses the repository test router', () => {
    expect(
      resolveInspectCommand({
        check: 'test',
        package: 'packages/operator-core',
        path: 'lib/workspace-host/personal-ssh-connection.e2e.test.ts',
      }, BASE),
    ).toEqual({
      ok: true,
      command: 'npm run test:file -- packages/operator-core/lib/workspace-host/personal-ssh-connection.e2e.test.ts',
      cwd: BASE,
    });
  });

  it('test with a package-declared exact node:test script → uses that script', () => {
    expect(
      resolveInspectCommand({ check: 'test', package: 'node-tests', path: 'test/foo.test.js' }, INSPECT_STATE),
    ).toEqual({
      ok: true,
      command: 'npm run test:node-file',
      cwd: NODE_TEST_PACKAGE,
    });
  });

  it('test with a node:test package and no exact script → uses the fixed direct runner', () => {
    expect(
      resolveInspectCommand({ check: 'test', package: 'node-tests', path: 'test/unlisted.test.js' }, INSPECT_STATE),
    ).toEqual({
      ok: true,
      command: 'node --test test/unlisted.test.js',
      cwd: NODE_TEST_PACKAGE,
    });
  });

  it('test with a repo-relative path and no package → runs that file from the repository root', () => {
    expect(
      resolveInspectCommand({ check: 'test', path: 'packages/operator-core/lib/foo.test.ts' }, BASE),
    ).toEqual({
      ok: true,
      command: 'npx vitest run packages/operator-core/lib/foo.test.ts',
      cwd: BASE,
    });
  });

  it('test with a repo-relative layered path and no package → uses the repository test router', () => {
    expect(
      resolveInspectCommand({
        check: 'test',
        path: 'packages/operator-core/lib/events/await/await-store.integration.test.ts',
      }, BASE),
    ).toEqual({
      ok: true,
      command: 'npm run test:file -- packages/operator-core/lib/events/await/await-store.integration.test.ts',
      cwd: BASE,
    });
  });

  it('path is rejected for typecheck', () => {
    expect(resolveInspectCommand({ check: 'typecheck', package: 'p', path: 'x' }, BASE).ok).toBe(false);
  });

  it('test with package-relative onlyPaths → uses the root exact multi-file router', () => {
    expect(
      resolveInspectCommand(
        { check: 'test', package: 'packages/operator-core', onlyPaths: ['lib/foo.test.ts', 'lib/bar.test.ts'] },
        BASE,
      ),
    ).toEqual({
      ok: true,
      command: 'npm run test:file -- packages/operator-core/lib/foo.test.ts packages/operator-core/lib/bar.test.ts',
      cwd: BASE,
    });
  });

  it('test with package + repo-relative onlyPaths → does not double-prefix paths', () => {
    expect(
      resolveInspectCommand(
        {
          check: 'test',
          package: 'packages/operator-core',
          onlyPaths: [
            'packages/operator-core/lib/foo.test.ts',
            'packages/operator-core/lib/bar.integration.test.ts',
          ],
        },
        BASE,
      ),
    ).toEqual({
      ok: true,
      command:
        'npm run test:file -- packages/operator-core/lib/foo.test.ts packages/operator-core/lib/bar.integration.test.ts',
      cwd: BASE,
    });
  });

  it('test with repo-relative onlyPaths and no package → uses the root exact multi-file router', () => {
    expect(
      resolveInspectCommand(
        {
          check: 'test',
          onlyPaths: ['packages/operator-core/lib/foo.test.ts', 'packages/operator-core/lib/bar.test.ts'],
        },
        BASE,
      ),
    ).toEqual({
      ok: true,
      command: 'npm run test:file -- packages/operator-core/lib/foo.test.ts packages/operator-core/lib/bar.test.ts',
      cwd: BASE,
    });
  });

  it('rejects ambiguous test path arguments when path and onlyPaths are both supplied', () => {
    const r = resolveInspectCommand(
      { check: 'test', package: 'packages/operator-core', path: 'lib/foo.test.ts', onlyPaths: ['lib/bar.test.ts'] },
      BASE,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('bad_args');
      expect(r.message).toContain('cannot be supplied together');
    }
  });

  it('publishes self-correcting guidance for the flattened test/typecheck argument surface', () => {
    const shape = (inspectTool as unknown as { args: { options: Array<{ shape: Record<string, { description?: string }> }> } }).args.options[0].shape;
    expect(shape.package.description).toMatch(/Repository-relative directory path to run in/);
    expect(shape.package.description).toMatch(/or the canonical npm workspace name such as "@papercusp\/operator-core"/);
    expect(shape.onlyPaths.description).toMatch(/For test, pass one or more package-relative paths/);
    expect(shape.onlyPaths.description).toMatch(/root `npm run test:file -- <paths…>` router/);
    expect(shape.onlyPaths.description).toMatch(/For typecheck, discover the repository baseline gate/);
    expect(shape.path.description).toMatch(/one test file\/dir/);
    expect(shape.path.description).toMatch(/when omitted, it is repo-relative/);
    expect(shape.path.description).toMatch(/\.e2e\.test\.\*/);
    expect(shape.path.description).toMatch(/multiple exact files, use `onlyPaths` instead/);
    expect(shape.runInBackground.description).toMatch(/Compatibility alias for run_in_background/);
  });
});

describe('capability:inspect — background launch response', () => {
  it('accepts the camelCase compatibility alias for background runs', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-camel-case-alias',
      taskId: 'task-camel-case-alias',
      logPath: '/tmp/bash-camel-case-alias.log',
    } as never);

    const result = await inspect.handler(
      { check: 'test', package: 'pkg', runInBackground: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-camel-case-alias',
      task_id: 'task-camel-case-alias',
      status: 'running',
    });
    expect(vi.mocked(startBackground)).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'npx vitest run', cwd: INSPECT_PACKAGE }),
      expect.any(Number),
    );
  });

  it('returns the durable task_id alongside the in-memory bash_id', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-response-probe',
      taskId: 'task-response-probe',
      logPath: '/tmp/bash-response-probe.log',
    } as never);

    const result = await inspect.handler(
      { check: 'test', package: 'pkg', run_in_background: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-response-probe',
      task_id: 'task-response-probe',
      status: 'running',
    });
    expect(vi.mocked(startBackground)).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'npx vitest run', cwd: INSPECT_PACKAGE }),
      expect.any(Number),
    );
  });

  it('honors onlyPaths in the launched background command instead of silently dropping it', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-scoped-typecheck',
      taskId: 'task-scoped-typecheck',
      logPath: '/tmp/bash-scoped-typecheck.log',
    } as never);

    const result = await inspect.handler(
      { check: 'typecheck', package: 'pkg', onlyPaths: ['src/a.ts'], run_in_background: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-scoped-typecheck',
      status: 'running',
      command: 'npm run lint:tsc -- --files=pkg/src/a.ts',
    });
    expect(vi.mocked(startBackground)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm run lint:tsc -- --files=pkg/src/a.ts',
        cwd: INSPECT_STATE,
      }),
      expect.any(Number),
    );
  });

  it('routes a background integration test through canonical input preparation', async () => {
    const bashCalls = vi.mocked(startBackground).mock.calls.length;
    const result = await inspect.handler(
      { check: 'test', package: 'pkg', path: 'src/foo.integration.test.ts', run_in_background: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      mode: 'background', status: 'pending', detachedRunId: 'canonical-run',
    });
    expect(canonicalBackground).toHaveBeenLastCalledWith(
      { files: [join(INSPECT_PACKAGE, 'src/foo.integration.test.ts')], background: true },
      expect.objectContaining({ projectDir: INSPECT_STATE }),
    );
    expect(vi.mocked(startBackground)).toHaveBeenCalledTimes(bashCalls);
  });

  it('normalizes a background repo-relative test path supplied with a package', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-package-repo-relative-test',
      taskId: 'task-package-repo-relative-test',
      logPath: '/tmp/bash-package-repo-relative-test.log',
    } as never);

    const result = await inspect.handler(
      {
        check: 'test',
        package: 'pkg',
        path: 'pkg/src/foo.test.ts',
        run_in_background: true,
      },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      mode: 'background', status: 'pending', detachedRunId: 'canonical-run',
    });
    expect(canonicalBackground).toHaveBeenLastCalledWith(
      { files: [join(INSPECT_PACKAGE, 'src/foo.test.ts')], background: true },
      expect.objectContaining({ projectDir: INSPECT_STATE }),
    );
  });

  it('launches a background repo-relative test path without a package', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-repo-relative-test',
      taskId: 'task-repo-relative-test',
      logPath: '/tmp/bash-repo-relative-test.log',
    } as never);

    const result = await inspect.handler(
      { check: 'test', path: 'packages/operator-core/lib/foo.test.ts', run_in_background: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      mode: 'background', status: 'pending', detachedRunId: 'canonical-run',
    });
    expect(canonicalBackground).toHaveBeenLastCalledWith(
      { files: [join(INSPECT_STATE, 'packages/operator-core/lib/foo.test.ts')], background: true },
      expect.objectContaining({ projectDir: INSPECT_STATE }),
    );
  });
});

describe('resolveInspectCommand — security (no shell injection / traversal)', () => {
  it('rejects shell metacharacters in package', () => {
    for (const bad of ['p; rm -rf /', 'p && curl evil', 'p`whoami`', 'p|tee', 'p$(x)', 'p x', 'p>out', 'p*']) {
      expect(resolveInspectCommand({ check: 'test', package: bad }, BASE).ok, `package "${bad}" must be rejected`).toBe(false);
    }
  });

  it('rejects shell metacharacters in path', () => {
    for (const bad of ['a.test.ts; rm -rf /', 'a && x', 'a|b', 'a $(b)']) {
      expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: bad }, BASE).ok, `path "${bad}" must be rejected`).toBe(false);
    }
  });

  it('rejects shell metacharacters in onlyPaths now that they enter the fixed command', () => {
    for (const bad of ['x.ts; rm -rf /', 'x.ts && curl evil', 'x.ts|tee', 'x $(whoami).ts', 'x,y.ts']) {
      const r = resolveScopedTypecheckCommand(
        { check: 'typecheck', package: 'pkg', onlyPaths: [bad] },
        BASE,
        [{ npmScript: 'lint:tsc', prefixes: ['pkg/'] }],
        () => true,
      );
      expect(r.ok, `onlyPath "${bad}" must be rejected`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('bad_only_path');
    }
  });

  it('rejects shell metacharacters in test onlyPaths before constructing the command', () => {
    for (const bad of ['x.test.ts; rm -rf /', 'x.test.ts && curl evil', 'x.test.ts|tee', 'x $(whoami).ts', 'x,y.test.ts']) {
      const r = resolveInspectCommand(
        { check: 'test', package: 'pkg', onlyPaths: [bad] },
        BASE,
      );
      expect(r.ok, `onlyPath "${bad}" must be rejected`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('bad_only_path');
    }
  });

  it('rejects parent-dir traversal in package and path', () => {
    expect(resolveInspectCommand({ check: 'test', package: '../etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'a/../../etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: '../../../etc/passwd' }, BASE).ok).toBe(false);
  });

  it('rejects an absolute package or path', () => {
    expect(resolveInspectCommand({ check: 'test', package: '/etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: '/etc/passwd' }, BASE).ok).toBe(false);
  });
});

/**
 * EI-19332092038566982 / EI-19331889744736428: `spawn`'s `cwd` must be a real directory. The
 * #1 wrong call shape observed live (all 6 sampled watchdog failures + an independently-filed
 * duplicate) was passing a tsconfig.json FILE as `package` — the containing directory is what
 * this tool actually needs as its cwd.
 */
describe('resolveTypecheckCwd (EI-19332092038566982 / EI-19331889744736428)', () => {
  it('passes a real directory through unchanged', () => {
    expect(resolveTypecheckCwd('/repo/packages/operator-core', true)).toEqual({
      ok: true,
      cwd: '/repo/packages/operator-core',
      corrected: false,
    });
  });

  it('auto-corrects a bare "tsconfig.json" file to its containing directory', () => {
    expect(resolveTypecheckCwd('/repo/packages/operator-core/tsconfig.json', false)).toEqual({
      ok: true,
      cwd: '/repo/packages/operator-core',
      corrected: true,
    });
  });

  it('auto-corrects a named tsconfig variant (e.g. tsconfig.build.json)', () => {
    expect(resolveTypecheckCwd('/repo/apps/operator/tsconfig.build.json', false)).toEqual({
      ok: true,
      cwd: '/repo/apps/operator',
      corrected: true,
    });
  });

  it('refuses a non-directory that is NOT a tsconfig file, with an actionable message', () => {
    const r = resolveTypecheckCwd('/repo/packages/operator-core/README.md', false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('bad_package_not_a_directory');
      expect(r.message).toMatch(/must be a directory/);
      expect(r.message).toContain('README.md');
    }
  });

  it('refuses a nonexistent path the same way (a stat failure is reported as not-a-directory)', () => {
    const r = resolveTypecheckCwd('/repo/does/not/exist', false);
    expect(r.ok).toBe(false);
  });
});

describe('filterTscOutputToPaths — "did MY change add a NEW error" (WI-1255)', () => {
  const OUT = [
    "lib/agent-tools/docs/author.ts(46,26): error TS2307: Cannot find module 'x'.",
    "../plugin-loader/src/wasm/jco-transpiler.ts(46,26): error TS2307: Cannot find module '@bytecodealliance/jco'.",
    "lib/other/foo.ts(1,1): error TS1005: ';' expected.",
    'Found 3 errors in 3 files.',
  ].join('\n');

  it('counts all errors but matches only the requested file', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/agent-tools/docs/author.ts']);
    expect(r.totalErrors).toBe(3);
    expect(r.matchedErrors).toBe(1);
    expect(r.matchedLines[0]).toContain('author.ts');
  });

  it('matches loosely (a basename fragment finds the file)', () => {
    expect(filterTscOutputToPaths(OUT, ['author.ts']).matchedErrors).toBe(1);
  });

  it('a directory fragment matches every file under it (and excludes others)', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/']);
    expect(r.matchedErrors).toBe(2); // author.ts + other/foo.ts, NOT the ../plugin-loader one
  });

  it('an unmatched path → 0 matched, full total (the clean signal)', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/nope/missing.ts']);
    expect(r.matchedErrors).toBe(0);
    expect(r.totalErrors).toBe(3);
  });

  it('ignores non-error lines (summary, blank)', () => {
    expect(filterTscOutputToPaths('Found 3 errors in 3 files.\n\n', ['x']).totalErrors).toBe(0);
  });

  it('empty output → zeros', () => {
    expect(filterTscOutputToPaths('', ['x'])).toEqual({ matchedErrors: 0, totalErrors: 0, matchedLines: [] });
  });
});

// EI-6073: a FOREGROUND typecheck/test on a large package (operator-core's tsc ~60-90s) was
// hard-killed by the ~55s MCP transport cap with an opaque request_timeout — the handler never
// got to hint "use run_in_background". These pin the clamp (self-time-out below the cap) + the hint.
// The clamp + hint moved to ./foreground-transport-cap (EI-20645849301780712); their tests
// moved with them, and grew a cross-tool invariant naming every foreground-capable tool.

/**
 * EI-20019651513530828 / EI-20013137550825704 — a typecheck that DIED must never be
 * reportable as clean.
 *
 * The fixture is the real captured output: tsc OOMs before emitting a single
 * diagnostic, so the log contains zero `error TS####` lines. That is byte-for-byte
 * what a clean compile produces, which is the whole defect.
 */
const OOM_OUTPUT = [
  '',
  '<--- Last few GCs --->',
  '[3903:0x7f2c] 79183 ms: Mark-Compact (reduce) 4082.7 (4104.7) -> 4071.3 (4090.0) MB',
  '',
  'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
  'Aborted (core dumped)',
].join('\n');

/**
 * The REGISTRY SQUATTER's entire output, captured verbatim on 2026-09-02 by running
 * `npx tsc --noEmit -p tsconfig.json` in a scratch dir with no local typescript
 * (EI-22142032090978471). The ANSI codes are the real ones, written as `\x1b` escapes
 * per `lint:no-control-bytes`; the guard has to survive them, and the key phrase is
 * contiguous only because the package brackets the colour codes around the message
 * rather than inside it.
 *
 * Measured with it: the process exits **1**, in every invocation shape including a cold
 * npx cache. The filed report's "EXITS 0" does not reproduce — the decoy's own source
 * ends with `process.exitCode = 1`. So this was never a false green; it was a correct
 * verdict with the wrong cause attached.
 */
const NPX_TSC_DECOY_OUTPUT = [
  '',
  '\x1b[41m                                                                               \x1b[0m',
  '\x1b[41m\x1b[37m                This is not the tsc command you are looking for                \x1b[0m',
  '\x1b[41m                                                                               \x1b[0m',
  '',
  'To get access to the TypeScript compiler, \x1b[34mtsc\x1b[0m, from the command line either:',
  '',
  '- Use \x1b[1mnpm install typescript\x1b[0m to first add TypeScript to your project \x1b[1mbefore\x1b[0m using npx',
  '- Use \x1b[1myarn\x1b[0m to avoid accidentally running code from un-installed packages',
  '',
].join('\n');

describe('deadTypecheckVerdict — a crashed typecheck is never a pass', () => {
  it('returns null for a genuinely clean run (CALIBRATION — must not cry wolf)', () => {
    expect(deadTypecheckVerdict({ exitCode: 0, status: 'completed', output: '', parsedErrors: 0 })).toBeNull();
  });

  it('returns null for ordinary type errors — nonzero exit WITH diagnostics is a real result', () => {
    expect(
      deadTypecheckVerdict({
        exitCode: 1,
        status: 'completed',
        output: "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
        parsedErrors: 1,
      }),
    ).toBeNull();
  });

  it('flags the real OOM as out-of-memory, with the heap remedy', () => {
    const v = deadTypecheckVerdict({ exitCode: 134, status: 'failed', output: OOM_OUTPUT, parsedErrors: 0 });
    expect(v).not.toBeNull();
    expect(v!.reason).toBe('typecheck_died_out_of_memory');
    expect(v!.headline).toContain('MEASURED NOTHING');
    expect(v!.advice).toContain('max-old-space-size');
  });

  it('detects the OOM by exit 134 alone, when the trace was truncated away', () => {
    // Output spills to a log on large runs, so the heap banner is often NOT in the
    // buffer the tool still holds. The exit code has to be sufficient on its own.
    const v = deadTypecheckVerdict({ exitCode: 134, status: 'failed', output: '', parsedErrors: 0 });
    expect(v?.reason).toBe('typecheck_died_out_of_memory');
  });

  it('detects the OOM by its message alone, when the exit code was lost', () => {
    const v = deadTypecheckVerdict({ exitCode: null, status: 'failed', output: OOM_OUTPUT, parsedErrors: 0 });
    expect(v?.reason).toBe('typecheck_died_out_of_memory');
  });

  it('flags a timeout that produced no diagnostics, and points at a detached re-run', () => {
    const v = deadTypecheckVerdict({ exitCode: null, status: 'timed_out', output: '', parsedErrors: 0 });
    expect(v?.reason).toBe('typecheck_timed_out_without_diagnostics');
    expect(v?.advice).toContain('run_in_background');
  });

  it('flags any other nonzero exit with no diagnostics (a bad operand, a missing tsconfig)', () => {
    const v = deadTypecheckVerdict({ exitCode: 2, status: 'completed', output: 'nonsense', parsedErrors: 0 });
    expect(v?.reason).toBe('typecheck_died_without_diagnostics');
  });

  it('names the npx DECOY package rather than blaming the tsconfig (EI-22142032090978471)', () => {
    // Exit 1, zero diagnostics — the generic branch above already caught this shape,
    // so the bug was never a false green. The defect was ATTRIBUTION: it advised
    // "a bad --project operand, a missing tsconfig, or a crash", and an agent spends
    // the next half hour auditing a tsconfig that is perfectly fine.
    const v = deadTypecheckVerdict({
      exitCode: 1,
      status: 'completed',
      output: NPX_TSC_DECOY_OUTPUT,
      parsedErrors: 0,
    });
    expect(v?.reason).toBe('typecheck_ran_npx_decoy_package');
    expect(v?.headline).toContain('MEASURED NOTHING');
    // The remedy has to be the one that actually works.
    expect(v?.advice).toContain('install:safe');
    // ...and it must actively clear the innocent suspects, or the reader still checks them.
    expect(v?.advice).toMatch(/tsconfig/i);
  });

  it('does NOT mistake a real compile that merely mentions TypeScript for the decoy', () => {
    // The decoy's other line ("To get access to the TypeScript compiler…") is ordinary
    // English and can reach this buffer from a diagnostic or a path. Keying on it would
    // mislabel a REAL failure, which is strictly worse than the generic verdict.
    const v = deadTypecheckVerdict({
      exitCode: 1,
      status: 'completed',
      output: 'To get access to the TypeScript compiler, see docs/typescript.md',
      parsedErrors: 0,
    });
    expect(v?.reason).toBe('typecheck_died_without_diagnostics');
  });

  it('CALIBRATION: the decoy output carries zero parseable diagnostics', () => {
    // The premise the whole branch rests on — if the banner ever parsed as an error,
    // `parsedErrors > 0` would return null before the decoy check is reached.
    expect(filterTscOutputToPaths(NPX_TSC_DECOY_OUTPUT, ['src/a.ts']).totalErrors).toBe(0);
  });

  it('CALIBRATION: the fixture still carries real ANSI, not flattened text', () => {
    // A later edit that round-trips this file through a control-byte-normalising reader
    // (or writes `\\x1b` instead of `\x1b`) would leave every assertion above passing
    // while the fixture silently stopped exercising ANSI-bearing output at all.
    expect(NPX_TSC_DECOY_OUTPUT).toContain(String.fromCharCode(27));
  });

  it('PRE-FIX CONTROL: the OOM output really is indistinguishable from clean to the filter', () => {
    // This is what made the bug invisible and is why the guard cannot be derived from
    // the output alone: the crashed run yields the SAME zero the old code turned into
    // "(no tsc errors in the specified paths)". If this ever stops being 0, the fixture
    // has drifted and the tests above are no longer reproducing the real failure.
    const f = filterTscOutputToPaths(OOM_OUTPUT, ['packages/operator-core/lib/x.ts']);
    expect(f.totalErrors).toBe(0);
    expect(f.matchedLines).toEqual([]);
    // ...yet the run must still be judged dead, on the exit code / banner instead.
    expect(deadTypecheckVerdict({ exitCode: 134, status: 'failed', output: OOM_OUTPUT, parsedErrors: f.totalErrors })).not.toBeNull();
  });
});
