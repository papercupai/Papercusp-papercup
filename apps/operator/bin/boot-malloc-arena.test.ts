/**
 * boot-malloc-arena: every host launch path gets a glibc malloc arena cap,
 * whether or not its launcher set one (host-memory-reduction-2026-09-27).
 *
 * The planner is tested directly; the side-effect module is only ever run in
 * a spawned child, because importing it here would re-exec a vitest worker if
 * the host-entry guard ever regressed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as realPlanner from './malloc-arena-reexec';

// Probe seam: scripts/mutation-probe.sh (copy-out mode) points this at a mutated copy.
const {
  HOST_MALLOC_ARENA_MAX,
  planMallocArenaReexec,
  planSelfOnlyPreloadScrub,
  ALLOCATOR_PRELOAD_SCOPE_ENV,
}: typeof realPlanner = process.env
  .MALLOC_ARENA_REEXEC_SUBJECT
  ? await import(process.env.MALLOC_ARENA_REEXEC_SUBJECT)
  : realPlanner;

const repoRoot = join(__dirname, '../../..');

const base = {
  platform: 'linux' as NodeJS.Platform,
  env: { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=4096' } as NodeJS.ProcessEnv,
  execPath: '/opt/node/bin/node',
  execArgv: ['--require', '/r/tsx/preflight.cjs', '--import', 'file:///r/tsx/loader.mjs'],
  argv: ['/opt/node/bin/node', '/repo/apps/operator/bin/hono-host.ts', '--ensure'],
  isMainThread: true,
  hasExecve: true,
};

describe('planMallocArenaReexec', () => {
  it('re-executes an uncapped host with its exact argv, execArgv and env plus the cap', () => {
    const plan = planMallocArenaReexec({ ...base, env: { ...base.env, DROPPED: undefined } });
    expect(plan).toEqual({
      action: 'reexec',
      file: '/opt/node/bin/node',
      args: [
        '/opt/node/bin/node',
        '--require',
        '/r/tsx/preflight.cjs',
        '--import',
        'file:///r/tsx/loader.mjs',
        '/repo/apps/operator/bin/hono-host.ts',
        '--ensure',
      ],
      env: { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=4096', MALLOC_ARENA_MAX: HOST_MALLOC_ARENA_MAX },
    });
  });

  it.each([
    '/repo/apps/operator/bin/hono-host.ts',
    '/repo/papercup-release/apps/operator/dist-host/hono-host.mjs',
    '/opt/papercusp/sidecar/serve.mjs',
    '/repo/apps/operator/bin/serve.ts',
    'C:\\papercusp\\sidecar\\serve.mjs',
  ])('treats %s as a host entry', (entry) => {
    expect(planMallocArenaReexec({ ...base, argv: ['/n', entry] }).action).toBe('reexec');
  });

  it.each([
    '/repo/node_modules/vitest/dist/workers/forks.js',
    '/repo/apps/operator/bin/hono-host.test.ts',
    '/repo/scripts/observe.mjs',
    '/repo/apps/operator/bin/serve-helpers.ts',
  ])('leaves an importer launched as %s alone', (entry) => {
    expect(planMallocArenaReexec({ ...base, argv: ['/n', entry] })).toEqual({
      action: 'none',
      reason: 'not-host-entry',
    });
  });

  it('leaves argv-less processes alone', () => {
    expect(planMallocArenaReexec({ ...base, argv: ['/n'] })).toEqual({ action: 'none', reason: 'not-host-entry' });
  });

  it.each([
    [{ platform: 'darwin' as NodeJS.Platform }, 'not-linux'],
    [{ env: { MALLOC_ARENA_MAX: '8' } }, 'already-set'],
    [{ env: { GLIBC_TUNABLES: 'glibc.malloc.arena_max=4' } }, 'tunable-set'],
    [{ isMainThread: false }, 'worker-thread'],
    [{ hasExecve: false }, 'no-execve'],
  ] as const)('does not re-exec when %o (%s)', (override, reason) => {
    expect(planMallocArenaReexec({ ...base, ...override })).toEqual({ action: 'none', reason });
  });
});

describe.runIf(process.platform === 'linux')('boot-malloc-arena re-exec, end to end', () => {
  let dir: string;
  const uncappedEnv = () => {
    const env = { ...process.env };
    delete env.MALLOC_ARENA_MAX;
    delete env.GLIBC_TUNABLES;
    return env;
  };
  const fixture = (name: string) => {
    const path = join(dir, name);
    writeFileSync(
      path,
      `import ${JSON.stringify(join(__dirname, 'boot-malloc-arena.ts'))};\n` +
        'console.log(JSON.stringify({ pid: process.pid, cap: process.env.MALLOC_ARENA_MAX ?? null, ' +
        'args: process.argv.slice(2) }));\n',
    );
    return path;
  };
  const run = (script: string, env: NodeJS.ProcessEnv) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--flag', 'x y'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return { result, out: JSON.parse(result.stdout.trim().split('\n').pop()!) };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'boot-malloc-arena-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-executes an uncapped host in place: same pid, cap set, argv kept, one log line', () => {
    const { result, out } = run(fixture('serve.ts'), uncappedEnv());
    expect(out).toEqual({ pid: result.pid, cap: HOST_MALLOC_ARENA_MAX, args: ['--flag', 'x y'] });
    const lines = result.stderr.split('\n').filter((l) => l.includes('[boot-malloc-arena]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`re-executing pid ${result.pid} with MALLOC_ARENA_MAX=${HOST_MALLOC_ARENA_MAX}`);
  });

  it('keeps a launcher-set value and does not re-exec', () => {
    const { result, out } = run(fixture('hono-host.ts'), { ...uncappedEnv(), MALLOC_ARENA_MAX: '8' });
    expect(out.cap).toBe('8');
    expect(result.stderr).not.toContain('[boot-malloc-arena]');
  });

  it('does nothing in a process that only imports a host module', () => {
    const { result, out } = run(fixture('some-tool.ts'), uncappedEnv());
    expect(out.cap).toBeNull();
    expect(result.stderr).not.toContain('[boot-malloc-arena]');
  });
});

describe('planSelfOnlyPreloadScrub (WI-10005291)', () => {
  const J = '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2';

  it('does nothing unless the launcher asked for a self-only preload', () => {
    expect(planSelfOnlyPreloadScrub({ LD_PRELOAD: J, MALLOC_CONF: 'narenas:4' })).toBeNull();
    expect(planSelfOnlyPreloadScrub({ LD_PRELOAD: J, [ALLOCATOR_PRELOAD_SCOPE_ENV]: 'all' })).toBeNull();
  });

  it('removes the jemalloc preload, its config and the marker', () => {
    expect(
      planSelfOnlyPreloadScrub({ LD_PRELOAD: J, MALLOC_CONF: 'background_thread:true', [ALLOCATOR_PRELOAD_SCOPE_ENV]: 'self' }),
    ).toEqual({ LD_PRELOAD: undefined, MALLOC_CONF: undefined, [ALLOCATOR_PRELOAD_SCOPE_ENV]: undefined });
  });

  it.each([
    [`/opt/a.so:${J}`, '/opt/a.so'],
    [`${J} /opt/a.so  /opt/b.so`, '/opt/a.so:/opt/b.so'],
    ['libjemalloc.so.2:/opt/a.so', '/opt/a.so'],
    ['/opt/libjemalloc.so', undefined],
    ['/opt/libjemalloc-shim.so', '/opt/libjemalloc-shim.so'],
  ])('keeps the other preload entries of %j', (preload, expected) => {
    expect(planSelfOnlyPreloadScrub({ LD_PRELOAD: preload, [ALLOCATOR_PRELOAD_SCOPE_ENV]: 'self' })?.LD_PRELOAD).toBe(
      expected,
    );
  });
});

describe.runIf(process.platform === 'linux')('self-only allocator preload, end to end', () => {
  const realJemalloc = '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2';
  let dir: string;
  // The fixture reports what this process kept AND what a child it spawns with the
  // default (inherited) environment sees, which is the property that matters.
  const fixture = () => {
    const path = join(dir, 'hono-host.ts');
    writeFileSync(
      path,
      `import ${JSON.stringify(join(__dirname, 'boot-malloc-arena.ts'))};\n` +
        "import { readFileSync } from 'node:fs';\n" +
        "import { execFileSync } from 'node:child_process';\n" +
        "const child = execFileSync('sh', ['-c', 'printf \"%s|%s|%s|\" \"$LD_PRELOAD\" \"$MALLOC_CONF\" \"$" +
        ALLOCATOR_PRELOAD_SCOPE_ENV +
        "\"; grep -c libjemalloc /proc/$$/maps || true']).toString().trim().split('|');\n" +
        'console.log(JSON.stringify({ pid: process.pid, cap: process.env.MALLOC_ARENA_MAX ?? null, ' +
        'ldPreload: process.env.LD_PRELOAD ?? null, mallocConf: process.env.MALLOC_CONF ?? null, ' +
        `marker: process.env.${ALLOCATOR_PRELOAD_SCOPE_ENV} ?? null, ` +
        "selfJemalloc: readFileSync('/proc/self/maps', 'utf8').includes('libjemalloc'), " +
        'child: { ldPreload: child[0], mallocConf: child[1], marker: child[2], jemallocMaps: Number(child[3]) } }));\n',
    );
    return path;
  };
  const run = (env: NodeJS.ProcessEnv) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture()], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return { result, out: JSON.parse(result.stdout.trim().split('\n').pop()!) };
  };
  const preloadEnv = (ldPreload: string, cap: string | undefined) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LD_PRELOAD: ldPreload,
      MALLOC_CONF: 'background_thread:true,narenas:4',
      [ALLOCATOR_PRELOAD_SCOPE_ENV]: 'self',
    };
    delete env.GLIBC_TUNABLES;
    if (cap === undefined) delete env.MALLOC_ARENA_MAX;
    else env.MALLOC_ARENA_MAX = cap;
    return env;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'boot-preload-scrub-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('children inherit neither the jemalloc preload nor its config; other preload entries survive', () => {
    // A missing library: ld.so warns and continues, so this runs on any Linux box.
    const { out } = run(preloadEnv('/nonexistent-p6e9bd/libjemalloc.so.2:/nonexistent-p6e9bd/libkeep.so', '2'));
    expect(out).toMatchObject({ ldPreload: '/nonexistent-p6e9bd/libkeep.so', mallocConf: null, marker: null });
    expect(out.child).toMatchObject({ ldPreload: '/nonexistent-p6e9bd/libkeep.so', mallocConf: '', marker: '' });
  });

  it.runIf(existsSync(realJemalloc)).each([
    ['launcher-capped (no re-exec)', '2'],
    ['uncapped (re-exec in place)', undefined],
  ])('%s: the host runs on jemalloc and its children do not', (_label, cap) => {
    const { result, out } = run(preloadEnv(realJemalloc, cap));
    expect(out.pid).toBe(result.pid);
    expect(out.cap).toBe(HOST_MALLOC_ARENA_MAX);
    expect(out.selfJemalloc).toBe(true);
    expect(out).toMatchObject({ ldPreload: null, mallocConf: null, marker: null });
    expect(out.child).toEqual({ ldPreload: '', mallocConf: '', marker: '', jemallocMaps: 0 });
    const lines = result.stderr.split('\n').filter((l) => l.includes('self-only allocator preload'));
    expect(lines).toEqual([expect.stringContaining(`jemalloc active in pid ${result.pid}`)]);
  });
});

describe('host entries import boot-malloc-arena before anything else', () => {
  it.each(['hono-host.ts', 'serve.ts'])('%s', (entry) => {
    const src = readFileSync(join(__dirname, entry), 'utf8');
    const firstImport = src.match(/^import\s[^;]*;/m)?.[0];
    expect(firstImport?.replace(/"/g, "'")).toBe("import './boot-malloc-arena';");
  });
});
