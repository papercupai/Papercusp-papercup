/**
 * WI-10005764 — the committed-source loader (scripts/lib/committed-source-loader.mjs).
 *
 * The restricted-hold census judges whether code a restricted session wrote may run with network,
 * but its own ~5,600-module closure lives in the same shared tree. Every census spawn therefore
 * loads this loader BEFORE tsx, so a checkout ES module runs its committed (HEAD) bytes, a new
 * uncommitted module refuses, and checkout CommonJS runs only when the text _compile receives is
 * its committed blob (WI-6554700010009021). This suite pins that contract on a
 * scratch git repo (each verdict beside a no-loader control proving the dirty bytes are really
 * there), and then runs the REAL census CLI under the loader, forcing its closure-worker fork.
 *
 * Lives in operator-core beside restricted-hold-preflight.test.ts so the gate's lane selects it
 * (a test under scripts/lib runs only under the root config, which no gate task runs). It never
 * imports the loader: importing it registers process-wide hooks. It only spawns node with it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMITTED_SOURCE_LOADER,
  RESTRICTED_HOLD_PREFLIGHT_CLI,
  RESTRICTED_HOLD_PREFLIGHT_EXIT,
  RESTRICTED_HOLD_PREFLIGHT_MARKER,
  censusSpawnArgs,
} from '../../../../scripts/lib/restricted-hold-preflight.mjs';

const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx');
const AUDIT_ENV = 'PAPERCUSP_COMMITTED_SOURCE_AUDIT';

type AuditRecord = { via: 'esm' | 'cjs'; kind: string; file: string; rel: string | null;
  schemaVersion?: string; boundary?: string; pid?: number; threadId?: number; format?: string;
  inputSha256?: string; returnedSha256?: string | null; returnedByteLength?: number | null;
  unresolved?: string[]; refused?: boolean };
const sha256 = (source: string): string => createHash('sha256').update(source).digest('hex');

/** process.env without git's repository-selecting variables, so `git -C <dir>` means that dir. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  delete env.NODE_OPTIONS;
  return env;
}

function git(dir: string, args: string[]): void {
  const result = spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: cleanEnv(),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

let fixture = '';
let scratch = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wi5764-loader-'));
  fixture = join(scratch, 'repo');
  mkdirSync(fixture);
  git(fixture, ['init', '-q']);
  put(fixture, 'package.json', '{ "type": "module" }\n');
  put(fixture, '.gitignore', 'gen/\nnode_modules/\n');
  put(fixture, 'mod.mjs', "export const v = 'HEAD';\n");
  put(fixture, 'entry.mjs', "import { v } from './mod.mjs';\nconsole.log(`V=${v}`);\n");
  // Extensionless import: only tsx's resolver can follow it, so a pass proves tsx ran AFTER the loader.
  put(fixture, 'ts/mod.ts', "export const v: string = 'HEAD';\n");
  put(fixture, 'ts/entry.ts', "import { v } from './mod';\nconsole.log(`V=${v}`);\n");
  put(fixture, 'new-entry.mjs', "import './new.mjs';\nconsole.log('ENTRY-RAN');\n");
  put(fixture, 'ignored-entry.mjs', "import { g } from './gen/out.mjs';\nconsole.log(`G=${g}`);\n");
  put(fixture, 'cjs-entry.mjs', "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./c.cjs');\n");
  put(fixture, 'c.cjs', "console.log('CJS-RAN');\n");
  // WI-6554700010009021: CommonJS is judged at _compile, so these pin each CommonJS verdict.
  put(fixture, 'req-entry.mjs', "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)(process.argv[2]);\n");
  put(fixture, 'c-dirty.cjs', "console.log('CJS-HEAD');\n");
  put(fixture, 'ts/c.cts', "const v: string = 'CTS';\nconsole.log(`CTS-RAN=${v}`);\n");
  // Dev sidecars live beneath an app package with no module declaration.
  // Their narrower bin package must keep tsx on the ESM load path, where the
  // committed-source loader judges raw bytes before the transform.
  put(fixture, 'apps/operator/package.json', '{}\n');
  put(fixture, 'apps/operator/bin/package.json', readFileSync(join(REPO, 'apps/operator/bin/package.json'), 'utf8'));
  put(fixture, 'apps/operator/bin/sidecar.ts', "import { v } from './value';\nconsole.log(`SIDECAR=${v}`);\n");
  put(fixture, 'apps/operator/bin/value.ts', "export const v: string = 'HEAD';\n");
  put(fixture, 'apps/operator/cjs-bin/sidecar.ts', "const v: string = 'HEAD';\nconsole.log(`SIDECAR=${v}`);\n");
  put(fixture, 'cjs/package.json', '{ "type": "commonjs" }\n');
  put(fixture, 'cjs/[eval]-wrapper', "console.log('FILE-WRAPPER-RAN');\n");
  put(fixture, 'cjs/[stdin]-wrapper', "console.log('FILE-WRAPPER-RAN');\n");
  put(fixture, 'dep-entry.mjs', "import { d } from 'dep';\nconsole.log(`D=${d}`);\n");
  put(fixture, 'packages/workspace/package.json', '{ "name": "workspace", "type": "module", "exports": { ".": "./value.mjs", "./new": "./new.mjs", "./cjs": "./value.cjs" } }\n');
  put(fixture, 'packages/workspace/value.mjs', "export const v = 'HEAD';\n");
  put(fixture, 'packages/workspace/value.cjs', "console.log('WORKSPACE-CJS-RAN');\n");
  put(fixture, 'workspace-entry.mjs', "import { v } from 'workspace';\nconsole.log(`WORKSPACE=${v}`);\n");
  put(fixture, 'workspace-new-entry.mjs', "import 'workspace/new';\nconsole.log('WORKSPACE-ENTRY-RAN');\n");
  put(fixture, 'workspace-cjs-entry.mjs', "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('workspace/cjs');\n");
  put(fixture, 'cjs-config/package.json', '{"private":true}\n');
  put(fixture, 'cjs-config/vitest.config.ts', 'export default { marker: "HEAD" };\n');
  put(fixture, 'esm-config/package.json', '{"private":true,"type":"module"}\n');
  put(fixture, 'esm-config/vitest.config.ts', 'export default { marker: "HEAD" };\n');
  // The census's closure walk forks its worker with execArgv: [] — only NODE_OPTIONS reaches it.
  put(fixture, 'fork-entry.mjs', [
    "import { fork } from 'node:child_process';",
    "const child = fork(new URL('./child.mjs', import.meta.url), [], { execArgv: [] });",
    'child.on(\'exit\', (code) => process.exit(code ?? 1));',
    '',
  ].join('\n'));
  put(fixture, 'child.mjs', "import { v } from './mod.mjs';\nconsole.log(`CHILD=${v}`);\n");
  // WI-10005802: a door ENTRY (the file node was asked to run), not just a module it imports.
  put(fixture, 'door.mjs', "console.log('DOOR=HEAD');\n");
  git(fixture, ['add', '-A']);
  git(fixture, ['commit', '-q', '-m', 'fixture']);

  // The working tree after the commit: what a held restricted write would look like.
  put(fixture, 'door.mjs', "console.log('DOOR=DIRTY');\n");
  put(fixture, 'new-door.mjs', "console.log('NEW-DOOR-RAN');\n");
  put(fixture, 'mod.mjs', "export const v = 'DIRTY';\n");
  put(fixture, 'ts/mod.ts', "export const v: string = 'DIRTY';\n");
  put(fixture, 'apps/operator/bin/value.ts', "export const v: string = 'DIRTY';\n");
  put(fixture, 'new.mjs', "console.log('NEW-RAN');\n");
  put(fixture, 'gen/out.mjs', "export const g = 'GEN';\n");
  put(fixture, 'node_modules/dep/package.json', '{ "name": "dep", "type": "module", "exports": "./index.mjs" }\n');
  put(fixture, 'node_modules/dep/index.mjs', "export const d = 'DEP';\n");
  put(fixture, 'packages/workspace/value.mjs', "export const v = 'DIRTY';\n");
  put(fixture, 'packages/workspace/new.mjs', "console.log('WORKSPACE-NEW-RAN');\n");
  put(fixture, 'packages/workspace/value.cjs', "console.log('WORKSPACE-CJS-DIRTY-RAN');\n");
  put(fixture, 'c-dirty.cjs', "console.log('CJS-DIRTY');\n");
  put(fixture, 'c-new.cjs', "console.log('CJS-NEW-RAN');\n");
  // Real files named like Node's virtual wrappers, dirtied: no name-based exemption may run them.
  put(fixture, 'cjs/[eval]-wrapper', "console.log('FILE-WRAPPER-RAN-DIRTY');\n");
  put(fixture, 'cjs/[stdin]-wrapper', "console.log('FILE-WRAPPER-RAN-DIRTY');\n");
  symlinkSync(join(fixture, 'packages/workspace'), join(fixture, 'node_modules/workspace'), 'dir');
  // `--import tsx` resolves from the cwd; the real package lives under the repo's node_modules.
  symlinkSync(join(REPO, 'node_modules', 'tsx'), join(fixture, 'node_modules', 'tsx'), 'dir');
}, 60_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** The census's own loader prefix (everything before the CLI path), so this is the real door argv. */
function censusPrefix(): { prefix: string[]; env: NodeJS.ProcessEnv } {
  const census = censusSpawnArgs([], cleanEnv());
  return { prefix: census.argv.slice(0, census.argv.indexOf(RESTRICTED_HOLD_PREFLIGHT_CLI)), env: census.env };
}

function run(argv: string[], env: NodeJS.ProcessEnv, auditFile?: string, input?: string) {
  const result = spawnSync(process.execPath, argv, {
    cwd: fixture,
    env: auditFile ? { ...env, [AUDIT_ENV]: auditFile } : env,
    encoding: 'utf8',
    input,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function runViteConfig(configDirectory: string, configLoader: 'bundle' | 'native' = 'bundle', auditFile?: string) {
  const configFile = join(configDirectory, 'vitest.config.ts');
  const script = [
    "import { loadConfigFromFile } from 'vite';",
    "const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, "
      + JSON.stringify(configFile) + ', ' + JSON.stringify(configDirectory)
      + ", 'silent', undefined, " + JSON.stringify(configLoader) + ");",
    "console.log('CONFIG=' + loaded.config.marker);",
  ].join('\n');
  const result = spawnSync(process.execPath, [
    '--import', COMMITTED_SOURCE_LOADER, '--input-type=module', '-e', script,
  ], { cwd: REPO, env: auditFile ? { ...cleanEnv(), [AUDIT_ENV]: auditFile } : cleanEnv(),
    encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function underLoader(entry: string, auditFile?: string) {
  const { prefix, env } = censusPrefix();
  return run([...prefix, entry], env, auditFile);
}

function readAudit(file: string): AuditRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as AuditRecord);
}

describe('committed-source loader — a scratch checkout', () => {
  it.each([
    ['entry.mjs', [], 'V=DIRTY'],
    ['req-entry.mjs', ['./c-dirty.cjs'], 'CJS-DIRTY'],
    ['new-door.mjs', [], 'NEW-DOOR-RAN'],
  ])('refuses an unsupported interpreter before %s executes', (entry, args, marker) => {
    // The default Node lane models the unsupported-runtime branch. An explicit
    // Bun pin exercises its actual preload behavior with the identical controls.
    const bun = process.env.PAPERCUSP_RUNTIME_TEST_BUN;
    const executable = bun ?? process.execPath;
    const target = join(fixture, entry);
    const env = cleanEnv();
    delete env.BUN_OPTIONS;
    const control = spawnSync(executable, [target, ...args], {
      cwd: fixture, env, encoding: 'utf8', timeout: 15_000,
    });
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toContain(marker);
    const guardedArgs = bun
      ? ['--preload', COMMITTED_SOURCE_LOADER, target, ...args]
      : ['--input-type=module', '-e', [
        "Object.defineProperty(process.versions, 'bun', { value: 'modeled-unsupported-runtime' });",
        `await import(${JSON.stringify(COMMITTED_SOURCE_LOADER)});`,
        `process.argv = [process.execPath, ${JSON.stringify(target)}, ...${JSON.stringify(args)}];`,
        `await import(${JSON.stringify(target)});`,
      ].join('\n')];
    const guarded = spawnSync(executable, guardedArgs, {
      cwd: fixture, env, encoding: 'utf8', timeout: 15_000,
    });
    expect(guarded.status, guarded.stderr).not.toBe(0);
    expect(guarded.stdout).not.toContain(marker);
    expect(guarded.stderr).toContain('COMMITTED_SOURCE requires Node');
  }, 45_000);

  it('runs retained ESM beneath an info-only Git metadata directory outside a checkout', () => {
    const outside = mkdtempSync(join(scratch, 'retained-api-'));
    put(outside, '.git/info/exclude', '*.log\n');
    put(outside, 'artifacts/api.mjs', "console.log('RETAINED-API-RAN');\n");
    const env = cleanEnv();
    delete env.PAPERCUSP_COMMITTED_SOURCE_GIT;
    env.PATH = '';
    const result = run(['--import', COMMITTED_SOURCE_LOADER, join(outside, 'artifacts/api.mjs')], env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('RETAINED-API-RAN');
  }, 60_000);

  it('keeps enforcing committed bytes inside a checkout beneath info-only ancestor metadata', () => {
    const ancestor = mkdtempSync(join(scratch, 'ignore-ancestor-'));
    put(ancestor, '.git/info/exclude', '*.log\n');
    const repo = join(ancestor, 'checkout');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    put(repo, 'entry.mjs', "console.log('NESTED=HEAD');\n");
    git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'fixture']);
    put(repo, 'entry.mjs', "console.log('NESTED=DIRTY');\n");
    const result = run(['--import', COMMITTED_SOURCE_LOADER, join(repo, 'entry.mjs')], cleanEnv());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('NESTED=HEAD');
    expect(result.stdout).not.toContain('NESTED=DIRTY');
  }, 60_000);

  it('refuses a damaged checkout rather than treating its missing HEAD as outside code', () => {
    const damaged = mkdtempSync(join(scratch, 'damaged-repo-'));
    git(damaged, ['init', '-q']);
    put(damaged, 'entry.mjs', "console.log('DAMAGED-REPO-RAN');\n");
    rmSync(join(damaged, '.git/HEAD'));
    const result = run(['--import', COMMITTED_SOURCE_LOADER, join(damaged, 'entry.mjs')], cleanEnv());
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('DAMAGED-REPO-RAN');
    expect(result.stderr).toMatch(/not a git repository/i);
  }, 60_000);

  it('pins git at loader registration so a descendant fake PATH cannot intercept checkout reads', () => {
    const binDir = join(scratch, 'fake-git-bin');
    const fakeGit = join(binDir, process.platform === 'win32' ? 'git.exe' : 'git');
    const fakeGitCalls = join(scratch, 'fake-git-calls');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(fakeGit, [
      '#!/bin/sh',
      'printf "called\\n" >> "$FAKE_GIT_CALLS"',
      'exit 97',
      '',
    ].join('\n'));
    chmodSync(fakeGit, 0o755);

    const parent = [
      "import { spawnSync } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const childPath = [${JSON.stringify(binDir)}, process.env.PATH].filter(Boolean).join(${JSON.stringify(delimiter)});`,
      'const fakeEnv = { ...process.env, PATH: childPath };',
      "const fakeControl = spawnSync('git', ['--version'], { env: fakeEnv, encoding: 'utf8' });",
      "if (fakeControl.status !== 97) throw new Error('fake git did not intercept the control call');",
      `writeFileSync(${JSON.stringify(fakeGitCalls)}, '');`,
      `const child = spawnSync(process.execPath, ['--import', ${JSON.stringify(COMMITTED_SOURCE_LOADER)}, 'entry.mjs'], { cwd: process.cwd(), env: fakeEnv, encoding: 'utf8' });`,
      'if (child.error) throw child.error;',
      'process.stdout.write(child.stdout ?? "");',
      'if (child.stderr) process.stderr.write(child.stderr);',
      'process.exitCode = child.status ?? 1;',
    ].join('\n');
    const env = cleanEnv();
    delete env.PAPERCUSP_COMMITTED_SOURCE_GIT;
    env.FAKE_GIT_CALLS = fakeGitCalls;

    const result = spawnSync(process.execPath, [
      '--import', COMMITTED_SOURCE_LOADER, '--input-type=module', '-e', parent,
    ], { cwd: fixture, env, encoding: 'utf8', timeout: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('V=HEAD');
    expect(readFileSync(fakeGitCalls, 'utf8')).toBe('');
  }, 75_000);

  it('ignores inherited Git repository selectors when reading the checkout HEAD', () => {
    const env = cleanEnv();
    env.GIT_DIR = join(scratch, 'missing-git-dir');
    env.GIT_WORK_TREE = join(scratch, 'other-worktree');
    env.GIT_INDEX_FILE = join(scratch, 'missing-index');
    env.GIT_OBJECT_DIRECTORY = join(scratch, 'missing-objects');
    env.GIT_COMMON_DIR = join(scratch, 'missing-common');
    const result = run(['--import', COMMITTED_SOURCE_LOADER, join(fixture, 'entry.mjs')], env);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('V=HEAD');
  }, 60_000);

  it.each([
    { name: 'eval', argv: ['-e', "console.log('INLINE-RAN')"], input: undefined },
    { name: 'print', argv: ['-p', "'INLINE-RAN'"], input: undefined },
    { name: 'stdin', argv: [], input: "console.log('INLINE-RAN')\n" },
  ])('allows Node virtual $name wrappers under the inherited test:file preload', ({ argv, input }) => {
    const loaded = run(argv, { ...cleanEnv(), NODE_OPTIONS: `--import=${COMMITTED_SOURCE_LOADER}` }, undefined, input);
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('INLINE-RAN');
  }, 60_000);

  it('still substitutes a dirty checkout ESM imported from eval', () => {
    const loaded = run(['-e', "import('./mod.mjs').then(({v}) => console.log('V=' + v))"], {
      ...cleanEnv(), NODE_OPTIONS: `--import=${COMMITTED_SOURCE_LOADER}`,
    });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('V=HEAD');
    expect(loaded.stdout).not.toContain('V=DIRTY');
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted mod.mjs');
  }, 60_000);

  it('runs committed checkout CommonJS required from eval', () => {
    const loaded = run(['-e', "require('./c.cjs')"], {
      ...cleanEnv(), NODE_OPTIONS: `--import=${COMMITTED_SOURCE_LOADER}`,
    });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('CJS-RAN');
  }, 60_000);

  it.each(['c-dirty.cjs', 'cjs/[eval]-wrapper', 'cjs/[stdin]-wrapper'])('still refuses dirty checkout CommonJS %s required from eval', (file) => {
    const control = run(['-e', `require(${JSON.stringify('./' + file)})`], cleanEnv());
    expect(control.stdout).toMatch(/CJS-DIRTY|FILE-WRAPPER-RAN-DIRTY/);
    const loaded = run(['-e', `require(${JSON.stringify('./' + file)})`], {
      ...cleanEnv(), NODE_OPTIONS: `--import=${COMMITTED_SOURCE_LOADER}`,
    });
    expect(loaded.status, loaded.stderr).not.toBe(0);
    expect(loaded.stderr).toContain(`COMMITTED_SOURCE refused ${file}`);
    expect(loaded.stdout).not.toMatch(/CJS-|FILE-WRAPPER-RAN/);
  }, 60_000);

  it('censusSpawnArgs puts the loader first and tsx second', () => {
    expect(censusPrefix().prefix).toEqual(['--import', COMMITTED_SOURCE_LOADER, '--import', 'tsx']);
  });

  it('runs the HEAD bytes of a dirty module, and says so on stderr', () => {
    const control = run(['entry.mjs'], cleanEnv());
    expect(control.stdout).toContain('V=DIRTY');

    const audit = join(scratch, 'dirty.audit');
    const loaded = underLoader('entry.mjs', audit);
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('V=HEAD');
    expect(loaded.stdout).not.toContain('V=DIRTY');
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted mod.mjs');
    // EI-25650771950762931: the line lands in launcher output that also carries a test run, so it
    // must scope itself to the process that ran the HEAD bytes (pid + entry script, delivered to
    // the hooks thread through register's data) and say child processes load working-tree bytes.
    const line = loaded.stderr.split('\n').find((l) => l.startsWith('COMMITTED_SOURCE substituted mod.mjs'));
    expect(line).toMatch(
      /^COMMITTED_SOURCE substituted mod\.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only \(pid \d+, entry entry\.mjs\); a process it starts without this loader \(vitest's test workers included\) loads the working-tree bytes$/,
    );
    const kinds = Object.fromEntries(readAudit(audit).filter((r) => r.rel).map((r) => [r.rel, r.kind]));
    expect(kinds).toMatchObject({ 'entry.mjs': 'committed', 'mod.mjs': 'substituted' });
  }, 60_000);

  it('substitutes BEFORE tsx transforms: a dirty TypeScript module runs its committed version', () => {
    const control = run(['--import', 'tsx', 'ts/entry.ts'], cleanEnv());
    expect(control.stdout).toContain('V=DIRTY');

    const loaded = underLoader('ts/entry.ts');
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('V=HEAD');
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted ts/mod.ts');
  }, 60_000);

  it('records the exact returned committed bytes separately from its dirty input', () => {
    const audit = join(scratch, 'returned.audit');
    expect(underLoader('entry.mjs', audit).status).toBe(0);
    const records = readAudit(audit);
    const dirty = records.find((record) => record.rel === 'mod.mjs');
    const entry = records.find((record) => record.rel === 'entry.mjs');
    expect(dirty).toMatchObject({
      schemaVersion: 'committed-source-load-receipt-v1', boundary: 'node-esm-load-return',
      kind: 'substituted', format: 'module',
      inputSha256: sha256("export const v = 'DIRTY';\n"),
      returnedSha256: sha256("export const v = 'HEAD';\n"),
      returnedByteLength: Buffer.byteLength("export const v = 'HEAD';\n"),
      unresolved: ['later-loader-transforms-unmeasured', 'loader-self-unmeasured'],
    });
    expect(dirty?.pid).toBeGreaterThan(0);
    expect(dirty?.threadId).toBeGreaterThan(0);
    expect(entry?.returnedSha256).toBe(sha256(readFileSync(join(fixture, 'entry.mjs'), 'utf8')));
    expect(entry?.inputSha256).toBe(entry?.returnedSha256);
  }, 60_000);

  it('records refused input without claiming any returned bytes', () => {
    const audit = join(scratch, 'refused.audit');
    expect(underLoader('new-entry.mjs', audit).status).not.toBe(0);
    expect(readAudit(audit).find((record) => record.rel === 'new.mjs')).toMatchObject({
      kind: 'uncommitted', inputSha256: sha256("console.log('NEW-RAN');\n"),
      returnedSha256: null, returnedByteLength: null,
    });
  }, 60_000);

  it('does not label its returned bytes as the final execution after another loader transforms them', () => {
    const audit = join(scratch, 'transformed.audit');
    const transformer = join(scratch, 'transformer.mjs');
    const original = "export const v = 'HEAD';\n";
    const transformed = "export const v = 'TRANSFORMED';\n";
    writeFileSync(transformer, [
      "import { register } from 'node:module';",
      "if (!new URL(import.meta.url).searchParams.has('hook')) register(import.meta.url + '?hook');",
      'export async function load(url, context, nextLoad) {',
      '  const result = await nextLoad(url, context);',
      `  return url.endsWith('/mod.mjs') ? { ...result, source: ${JSON.stringify(transformed)} } : result;`,
      '}',
    ].join('\n'));
    const result = run(['--import', COMMITTED_SOURCE_LOADER, '--import', transformer, 'entry.mjs'], cleanEnv(), audit);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('V=TRANSFORMED');
    const receipt = readAudit(audit).find((record) => record.rel === 'mod.mjs');
    expect(receipt).toMatchObject({ boundary: 'node-esm-load-return', returnedSha256: sha256(original) });
    expect(receipt?.returnedSha256).not.toBe(sha256(transformed));
    expect(receipt?.unresolved).toContain('later-loader-transforms-unmeasured');
  }, 60_000);

  it('refuses a module with no committed version that git does not ignore, before any code runs', () => {
    const control = run(['new-entry.mjs'], cleanEnv());
    expect(control.stdout).toContain('NEW-RAN');

    const loaded = underLoader('new-entry.mjs');
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused new.mjs');
    expect(loaded.stdout).not.toContain('NEW-RAN');
    expect(loaded.stdout).not.toContain('ENTRY-RAN');
  }, 60_000);

  it('runs an ignored file (generated output) and a node_modules dependency as read', () => {
    const audit = join(scratch, 'ignored.audit');
    const ignored = underLoader('ignored-entry.mjs', audit);
    expect(ignored.status).toBe(0);
    expect(ignored.stdout).toContain('G=GEN');

    const dep = underLoader('dep-entry.mjs', audit);
    expect(dep.status).toBe(0);
    expect(dep.stdout).toContain('D=DEP');

    const records = readAudit(audit);
    expect(records.find((r) => r.rel === 'gen/out.mjs')?.kind).toBe('ignored');
    expect(records.find((r) => r.rel === 'node_modules/dep/index.mjs')?.kind).toBe('dependency');
  }, 60_000);

  it.each([[false, false], [false, true], [true, false], [true, true]])('loads committed workspace alias bytes with preserveSymlinks=%s and tsx=%s', (preserveSymlinks, withTsx) => {
    const options = preserveSymlinks ? ['--preserve-symlinks'] : [];
    const control = run([...options, 'workspace-entry.mjs'], cleanEnv());
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toContain('WORKSPACE=DIRTY');

    const { prefix, env } = censusPrefix();
    // Keep tsx in its installed dependency tree: --preserve-symlinks would resolve its
    // get-tsconfig dependency inside this fixture if we loaded the fixture's tsx link.
    const aliasPrefix = withTsx ? prefix.map((arg) => arg === 'tsx' ? TSX_LOADER : arg) : ['--import', COMMITTED_SOURCE_LOADER];
    const aliasEnv = withTsx ? env : cleanEnv();
    const audit = join(scratch, `workspace-${preserveSymlinks}-${withTsx}.audit`);
    const loaded = run([...options, ...aliasPrefix, 'workspace-entry.mjs'], aliasEnv, audit);
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('WORKSPACE=HEAD');
    expect(loaded.stdout).not.toContain('WORKSPACE=DIRTY');
    expect(readAudit(audit).find((record) => record.rel === 'packages/workspace/value.mjs')).toMatchObject({
      kind: 'substituted', returnedSha256: sha256("export const v = 'HEAD';\n"),
    });
  }, 60_000);

  // WI-6554700010009021: the ES hook never sees CommonJS, so _compile judges the text it is handed.
  it('runs a committed checkout CommonJS module, judged at _compile', () => {
    const audit = join(scratch, 'cjs-committed.audit');
    const loaded = underLoader('cjs-entry.mjs', audit);
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('CJS-RAN');
    expect(loaded.stderr).not.toContain('COMMITTED_SOURCE');
    expect(readAudit(audit).find((record) => record.via === 'cjs' && record.rel === 'c.cjs')).toMatchObject({
      kind: 'committed', refused: false,
    });
  }, 60_000);

  it('refuses a dirty checkout CommonJS module rather than running either version', () => {
    const control = run(['req-entry.mjs', './c-dirty.cjs'], cleanEnv());
    expect(control.stdout).toContain('CJS-DIRTY');

    const audit = join(scratch, 'cjs-dirty.audit');
    const { prefix, env } = censusPrefix();
    const loaded = run([...prefix, 'req-entry.mjs', './c-dirty.cjs'], env, audit);
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused c-dirty.cjs');
    expect(loaded.stdout).not.toMatch(/CJS-DIRTY|CJS-HEAD/);
    expect(readAudit(audit).find((record) => record.via === 'cjs' && record.rel === 'c-dirty.cjs')).toMatchObject({
      kind: 'substituted', refused: true,
    });
  }, 60_000);

  // WI-6554700010009516: a test that spawns `node` inherits NODE_OPTIONS (so this loader) and
  // captures the child's stderr, so the substituted/refused line never reaches the launcher that
  // prints the verdict. The notice channel records ONLY modules that did not run as read.
  it('appends one notice per substituted or refused module to PAPERCUSP_COMMITTED_SOURCE_NOTICES, none for committed ones', () => {
    const NOTICE_ENV = 'PAPERCUSP_COMMITTED_SOURCE_NOTICES';
    const notices = join(scratch, 'child.notices');
    const { prefix, env } = censusPrefix();
    const withNotices = { ...env, [NOTICE_ENV]: notices };
    expect(run([...prefix, 'entry.mjs'], withNotices).stdout).toContain('V=HEAD');
    expect(run([...prefix, 'new-entry.mjs'], withNotices).status).not.toBe(0);
    expect(run([...prefix, 'req-entry.mjs', './c-dirty.cjs'], withNotices).status).not.toBe(0);
    expect(run([...prefix, 'door.mjs'], withNotices).stdout).toContain('DOOR=HEAD');
    const records = readFileSync(notices, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const top = realpathSync(fixture);
    const base = { schemaVersion: 'committed-source-notice-v1', top, pid: expect.any(Number) };
    expect(records).toEqual([
      { ...base, kind: 'substituted', via: 'esm', rel: 'mod.mjs', entry: 'entry.mjs' },
      { ...base, kind: 'refused', via: 'esm', rel: 'new.mjs', reason: 'uncommitted', entry: 'new-entry.mjs' },
      { ...base, kind: 'refused', via: 'cjs', rel: 'c-dirty.cjs', reason: 'differs-from-head', entry: 'req-entry.mjs' },
      { ...base, kind: 'substituted', via: 'esm', rel: 'door.mjs', entry: 'door.mjs' },
    ]);
    // Control: the channel is opt-in — the same substitution with the variable unset adds no line.
    const before = readFileSync(notices, 'utf8');
    const loaded = run([...prefix, 'entry.mjs'], env);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted mod.mjs');
    expect(readFileSync(notices, 'utf8')).toBe(before);
  }, 60_000);

  it('refuses an uncommitted checkout CommonJS module', () => {
    const control = run(['req-entry.mjs', './c-new.cjs'], cleanEnv());
    expect(control.stdout).toContain('CJS-NEW-RAN');

    const { prefix, env } = censusPrefix();
    const loaded = run([...prefix, 'req-entry.mjs', './c-new.cjs'], env);
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused c-new.cjs');
    expect(loaded.stdout).not.toContain('CJS-NEW-RAN');
  }, 60_000);

  it('refuses committed TypeScript that tsx rewrites on the CommonJS path', () => {
    const { prefix, env } = censusPrefix();
    const loaded = run([...prefix, 'req-entry.mjs', './ts/c.cts'], env);
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused ts/c.cts');
    expect(loaded.stdout).not.toContain('CTS-RAN');
  }, 60_000);

  it('runs a dev sidecar through ESM and substitutes a dirty imported dependency before tsx transforms it', () => {
    const entry = 'apps/operator/bin/sidecar.ts';
    const control = run(['--import', 'tsx', entry], cleanEnv());
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toContain('SIDECAR=DIRTY');

    const loaded = underLoader(entry);
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('SIDECAR=HEAD');
    expect(loaded.stdout).not.toContain('SIDECAR=DIRTY');
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted apps/operator/bin/value.ts');
  }, 60_000);

  it('refuses the same clean dev TypeScript format without the entrypoint module declaration', () => {
    const entry = 'apps/operator/cjs-bin/sidecar.ts';
    const control = run(['--import', 'tsx', entry], cleanEnv());
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toContain('SIDECAR=HEAD');

    const loaded = underLoader(entry);
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused apps/operator/cjs-bin/sidecar.ts');
    expect(loaded.stdout).not.toContain('SIDECAR=HEAD');
  }, 60_000);

  it("runs committed TypeScript that Node strips inside _compile, so _compile's format argument is forwarded", () => {
    const loaded = run(['--import', COMMITTED_SOURCE_LOADER, 'req-entry.mjs', './ts/c.cts'], cleanEnv());
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('CTS-RAN=CTS');
  }, 60_000);

  it.each([false, true])('refuses uncommitted workspace alias bytes with preserveSymlinks=%s', (preserveSymlinks) => {
    const options = preserveSymlinks ? ['--preserve-symlinks'] : [];
    const control = run([...options, 'workspace-new-entry.mjs'], cleanEnv());
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toContain('WORKSPACE-NEW-RAN');
    const loaded = run([...options, '--import', COMMITTED_SOURCE_LOADER, 'workspace-new-entry.mjs'], cleanEnv());
    expect(loaded.status, loaded.stderr).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused packages/workspace/new.mjs');
    expect(loaded.stdout).not.toContain('WORKSPACE-NEW-RAN');
    expect(loaded.stdout).not.toContain('WORKSPACE-ENTRY-RAN');
  }, 60_000);

  it.each([false, true])('refuses dirty CommonJS workspace alias bytes with preserveSymlinks=%s', (preserveSymlinks) => {
    const options = preserveSymlinks ? ['--preserve-symlinks'] : [];
    const control = run([...options, 'workspace-cjs-entry.mjs'], cleanEnv());
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toContain('WORKSPACE-CJS-DIRTY-RAN');
    const loaded = run([...options, '--import', COMMITTED_SOURCE_LOADER, 'workspace-cjs-entry.mjs'], cleanEnv());
    expect(loaded.status, loaded.stderr).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused packages/workspace/value.cjs');
    expect(loaded.stdout).not.toContain('WORKSPACE-CJS-DIRTY-RAN');
  }, 60_000);

  it('reaches a child forked with execArgv: [] through NODE_OPTIONS, and only through it', () => {
    const { prefix, env } = censusPrefix();
    const loaded = run([...prefix, 'fork-entry.mjs'], env);
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('CHILD=HEAD');

    // Control: the same argv without the NODE_OPTIONS half leaves the forked child unjudged.
    const withoutOptions = { ...env };
    delete withoutOptions.NODE_OPTIONS;
    expect(run([...prefix, 'fork-entry.mjs'], withoutOptions).stdout).toContain('CHILD=DIRTY');
  }, 60_000);

  // WI-10005802: the doors start their own node entries (the router, the tree and bundle gates,
  // the bundle-host helpers) as `node --import <loader> <entry>` — no tsx, no NODE_OPTIONS — so a
  // held write to the ENTRY itself runs its committed bytes, and a new uncommitted entry refuses.
  it('runs the committed bytes of a dirty door ENTRY started as `node --import <loader> <entry>`', () => {
    expect(run(['door.mjs'], cleanEnv()).stdout).toContain('DOOR=DIRTY');

    const loaded = run(['--import', COMMITTED_SOURCE_LOADER, 'door.mjs'], cleanEnv());
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('DOOR=HEAD');
    expect(loaded.stdout).not.toContain('DOOR=DIRTY');
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted door.mjs');
  }, 60_000);

  it('refuses a door entry with no committed version before it runs', () => {
    expect(run(['new-door.mjs'], cleanEnv()).stdout).toContain('NEW-DOOR-RAN');

    const loaded = run(['--import', COMMITTED_SOURCE_LOADER, 'new-door.mjs'], cleanEnv());
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused new-door.mjs');
    expect(loaded.stdout).not.toContain('NEW-DOOR-RAN');
  }, 60_000);
});

describe('committed-source loader — Vite config bundles', () => {
  it('accepts a clean CommonJS config bundle and refuses one built from dirty source', () => {
    const configDirectory = join(fixture, 'cjs-config');
    const clean = runViteConfig(configDirectory);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('CONFIG=HEAD');

    put(fixture, 'cjs-config/vitest.config.ts', 'export default { marker: "DIRTY" };\n');
    const dirty = runViteConfig(configDirectory);
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain('COMMITTED_SOURCE refused cjs-config/vitest.config.ts');
    expect(dirty.stdout).not.toContain('CONFIG=DIRTY');
  }, 60_000);

  it('checks the original source behind Vite ESM config bundles in .vite-temp', () => {
    const configDirectory = join(fixture, 'esm-config');
    const clean = runViteConfig(configDirectory);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('CONFIG=HEAD');

    put(fixture, 'esm-config/vitest.config.ts', 'export default { marker: "DIRTY" };\n');
    const dirty = runViteConfig(configDirectory);
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain('COMMITTED_SOURCE refused esm-config/vitest.config.ts');
    expect(dirty.stdout).not.toContain('CONFIG=DIRTY');
  }, 60_000);

  it('accepts charset-qualified inline maps and still refuses dirty Vite config source', () => {
    const configDirectory = join(fixture, 'esm-config');
    const configFile = join(configDirectory, 'vitest.config.ts');
    const bundleFile = join(fixture, 'node_modules/.vite-temp/vitest.config.ts.timestamp-1-abc.mjs');
    const writeBundle = (marker: string, source: string) => {
      const injected = 'const __vite_injected_original_dirname = '
        + JSON.stringify(dirname(configFile)) + ';'
        + 'const __vite_injected_original_filename = '
        + JSON.stringify(configFile) + ';'
        + 'const __vite_injected_original_import_meta_url = '
        + JSON.stringify(pathToFileURL(configFile).href) + ';';
      const map = {
        version: 3,
        file: bundleFile,
        sourceRoot: pathToFileURL(dirname(configFile) + '/').href,
        sources: [configFile],
        sourcesContent: [injected + source],
        names: [],
        mappings: '',
      };
      mkdirSync(dirname(bundleFile), { recursive: true });
      writeFileSync(bundleFile, 'console.log("CONFIG=' + marker + '");\n'
        + '//# sourceMappingURL=data:application/json;charset=utf-8;base64,'
        + Buffer.from(JSON.stringify(map)).toString('base64') + '\n');
    };

    const headSource = 'export default { marker: "HEAD" };\n';
    put(fixture, 'esm-config/vitest.config.ts', headSource);
    writeBundle('HEAD', headSource);
    const clean = run(['--import', COMMITTED_SOURCE_LOADER, bundleFile], cleanEnv());
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('CONFIG=HEAD');

    put(fixture, 'esm-config/vitest.config.ts', 'export default { marker: "DIRTY" };\n');
    writeBundle('DIRTY', readFileSync(configFile, 'utf8'));
    const dirty = run(['--import', COMMITTED_SOURCE_LOADER, bundleFile], cleanEnv());
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain('COMMITTED_SOURCE refused esm-config/vitest.config.ts');
    expect(dirty.stdout).not.toContain('CONFIG=DIRTY');
  }, 60_000);

  it('accepts native config source without a bundle map and substitutes dirty bytes', () => {
    const configDirectory = join(fixture, 'esm-config');
    put(fixture, 'esm-config/vitest.config.ts', 'export default { marker: "HEAD" };\n');
    const cleanAudit = join(scratch, 'native-config-clean.audit');
    const clean = runViteConfig(configDirectory, 'native', cleanAudit);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('CONFIG=HEAD');
    expect(readAudit(cleanAudit)).toContainEqual(expect.objectContaining({
      via: 'esm', kind: 'committed', rel: 'esm-config/vitest.config.ts',
    }));

    put(fixture, 'esm-config/vitest.config.ts', 'export default { marker: "DIRTY" };\n');
    const dirtyAudit = join(scratch, 'native-config-dirty.audit');
    const dirty = runViteConfig(configDirectory, 'native', dirtyAudit);
    expect(dirty.status, dirty.stderr).toBe(0);
    expect(dirty.stdout).toContain('CONFIG=HEAD');
    expect(dirty.stdout).not.toContain('CONFIG=DIRTY');
    expect(readAudit(dirtyAudit)).toContainEqual(expect.objectContaining({
      via: 'esm', kind: 'substituted', rel: 'esm-config/vitest.config.ts',
    }));
  }, 60_000);
});

/**
 * WI-10005802: the CLI launchers of the test router. testing:run judges the router's own closure in
 * its in-process census before it spawns the router; the CLI paths have no such step, so they
 * start the router (and the install-mutex hop before it) under the committed-source loader.
 */
describe('committed-source loader — the test router CLI launchers', () => {
  const LOADER_FLAG = '--import ./scripts/lib/committed-source-loader.mjs';
  const scripts = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

  it('every root package.json script that starts the router or its install-mutex hop passes the loader first', () => {
    const launches = Object.entries(scripts).flatMap(([name, command]) =>
      [...command.matchAll(/\bnode\s+((?:--\S+\s+(?:\S+\s+)?)*?)(scripts\/(?:test-files|npm-install-safe)\.mjs)/g)].map((m) => ({
        name,
        entry: m[2],
        flags: m[1].trim(),
      })),
    );
    // Positive control: the population this guard judges is real.
    expect(launches.map((l) => l.name)).toEqual(expect.arrayContaining(['test:file', 'lint:tool-prompts']));
    // install:safe is the dependency installer, not a door: it runs no test code.
    const doors = launches.filter((l) => l.name !== 'install:safe');
    expect(doors.filter((l) => l.flags !== LOADER_FLAG)).toEqual([]);
    expect(scripts['test:file']).toContain(`node ${LOADER_FLAG} scripts/npm-install-safe.mjs --exec-under-lock -- node ${LOADER_FLAG} scripts/test-files.mjs`);
  });

  it('scripts/workspace-test.mjs routes explicit files through the router under the loader', async () => {
    const { workspaceTestInvocation } = (await import('../../../../scripts/workspace-test.mjs')) as {
      workspaceTestInvocation: (argv: string[], repoRoot: string) => { command: string; args: string[]; routed: boolean };
    };
    const invocation = workspaceTestInvocation(['a.test.ts'], REPO);
    expect(invocation.routed).toBe(true);
    expect(invocation.args.slice(0, 3)).toEqual(['--import', COMMITTED_SOURCE_LOADER, join(REPO, 'scripts', 'test-files.mjs')]);
  });
});

describe('committed-source loader — the real census closure', () => {
  function census(args: string[], holdings: unknown[]) {
    const dir = mkdtempSync(join(scratch, 'census-'));
    const holdingsFile = join(dir, 'census.json');
    const audit = join(dir, 'audit');
    writeFileSync(holdingsFile, JSON.stringify(holdings));
    const spawn = censusSpawnArgs(args, { ...cleanEnv(), VITEST: 'true', PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: holdingsFile, [AUDIT_ENV]: audit });
    const result = spawnSync(process.execPath, spawn.argv, { cwd: REPO, env: spawn.env, encoding: 'utf8', timeout: 120_000 });
    const verdictLine = (result.stdout ?? '').split('\n').find((l) => l.startsWith(`${RESTRICTED_HOLD_PREFLIGHT_MARKER} `));
    return {
      status: result.status,
      stderr: result.stderr ?? '',
      verdict: verdictLine ? JSON.parse(verdictLine.slice(RESTRICTED_HOLD_PREFLIGHT_MARKER.length + 1)) : null,
      records: readAudit(audit),
    };
  }

  it('the census and its forked closure worker run only committed ES modules (none CommonJS, none uncommitted)', () => {
    // Run the REAL census and compiler child over a bounded fixture graph. Their
    // own code still comes from REPO under the loader. Unrelated evolving router
    // imports must not decide whether this test can observe the loader boundary.
    const held = join(fixture, 'held-nonexistent.ts');
    const result = census([fixture, join(fixture, 'entry.mjs')], [{ path: held, owner: 'su-restricted', intent: 'x' }]);

    expect(result.status, JSON.stringify({ verdict: result.verdict, stderr: result.stderr })).toBe(RESTRICTED_HOLD_PREFLIGHT_EXIT.admit);
    expect(result.verdict).toEqual({ verdict: 'admit' });

    const judged = result.records.filter((r) => r.kind === 'committed' || r.kind === 'substituted');
    expect(judged.some((r) => r.rel === 'packages/operator-core/lib/agent-tools/testing/restricted-hold-preflight-cli.ts')).toBe(true);
    // The forked worker reached the loader through NODE_OPTIONS alone.
    expect(judged.some((r) => /mutation-probe-closure\.worker\.[mc]?[jt]s$/.test(r.rel ?? ''))).toBe(true);
    // ES-only: no checkout module of the census reaches CommonJS at all, committed or not.
    expect(result.records.filter((r) => r.via === 'cjs' || r.kind === 'uncommitted')).toEqual([]);
  }, 180_000);
});
