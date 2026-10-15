/**
 * hook-probe.test.ts — guards the probe helper (hook-probe.ts), EI-23757282243623667.
 *
 * The bug class: a fail-open hook copied OUT of its directory (the natural way to A/B a pre-fix
 * version) loses its sibling files, crashes at import, and — because its contract is "never fail,
 * print nothing on allow" — returns exactly what ALLOW returns. Every case then reads ALLOW,
 * including the one that must BLOCK.
 *
 * Every fixture lives in a mkdtemp dir OUTSIDE the repo (git-sync sweeps the tree). The fixture
 * hook is a node `.mjs` that dynamic-imports a sibling inside try/catch — the same shape as the
 * real hooks' `from mcp_response import …` — so the footgun is reproduced, not simulated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  HOOKS_CC_DIR,
  HookInstrumentError,
  assertHookInstrument,
  classifyHookRun,
  cleanGitEnv,
  defaultIsBlock,
  materializeHookDir,
  runHookVerdict,
} from './hook-probe';

const SIBLING = `export function shouldBlock(input) {
  return input.tool_name === 'Bash' || input.tool_name === 'tools:invoke';
}
`;

/** CURRENT hook: blocks Bash AND tools:invoke. Swallows every failure silently (fail-open). */
const HOOK_CURRENT = `import { readFileSync } from 'node:fs';
try {
  const { shouldBlock } = await import('./sibling.mjs');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (shouldBlock(input)) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'no' }));
} catch (err) {
  if (process.env.GUARD_LOUD) process.stderr.write(String(err) + '\\n');
}
process.exit(0);
`;

/** HISTORICAL hook: the pre-fix version — blind to tools:invoke (only blocks Bash). */
const HOOK_HISTORICAL = HOOK_CURRENT.replace(
  'if (shouldBlock(input))',
  "if (shouldBlock(input) && input.tool_name === 'Bash')",
);

const ENV = { PATH: process.env.PATH ?? '' };
const bash = JSON.stringify({ tool_name: 'Bash', tool_input: {} });
const toolsInvoke = JSON.stringify({ tool_name: 'tools:invoke', tool_input: {} });
const read = JSON.stringify({ tool_name: 'Read', tool_input: {} });
const POSITIVE = { name: 'bare Bash must block', input: bash };
const NEGATIVE = { name: 'Read must allow', input: read };

let root: string;
let hooksDir: string;

beforeAll(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'hook-probe-test-'));
  hooksDir = join(root, 'hooks');
  fs.mkdirSync(hooksDir);
  fs.writeFileSync(join(hooksDir, 'sibling.mjs'), SIBLING);
  fs.writeFileSync(join(hooksDir, 'guard.mjs'), HOOK_CURRENT);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('classifyHookRun — a crash is never an ALLOW', () => {
  const ok = { status: 0, stdout: '', stderr: '' };
  it('clean empty exit-0 is ALLOW', () => {
    expect(classifyHookRun(ok)).toBe('ALLOW');
  });
  it('exit 2 and the JSON block encodings are BLOCK', () => {
    expect(classifyHookRun({ ...ok, status: 2, stderr: 'because' })).toBe('BLOCK');
    expect(classifyHookRun({ ...ok, stdout: '{"decision":"block"}' })).toBe('BLOCK');
    expect(
      classifyHookRun({
        ...ok,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
      }),
    ).toBe('BLOCK');
  });
  it('exit-0 with stderr (a swallowed traceback) is CRASHED, not ALLOW', () => {
    expect(
      classifyHookRun({ ...ok, stderr: 'Traceback…\nModuleNotFoundError: pc_tty' }),
    ).toBe('CRASHED');
  });
  it('a non-zero exit, or a signal (null status), is CRASHED', () => {
    expect(classifyHookRun({ ...ok, status: 1 })).toBe('CRASHED');
    expect(classifyHookRun({ ...ok, status: null })).toBe('CRASHED');
  });
  it('tolerateStderr ignores ONLY matching lines', () => {
    const notice = { ...ok, stderr: 'note: benign\n' };
    expect(classifyHookRun(notice, { tolerateStderr: /^note: benign/ })).toBe('ALLOW');
    expect(
      classifyHookRun({ ...notice, stderr: 'note: benign\nBOOM\n' }, { tolerateStderr: /^note:/ }),
    ).toBe('CRASHED');
  });
  it('BLOCK beats stderr noise (a decision cannot be printed by a crash)', () => {
    expect(
      classifyHookRun({ status: 0, stdout: '{"decision":"block"}', stderr: 'warn' }),
    ).toBe('BLOCK');
  });
  it('malformed stdout is not a block', () => {
    expect(defaultIsBlock({ status: 0, stdout: 'not json', stderr: '' })).toBe(false);
  });
});

describe('the footgun, reproduced: single-file copy out of the hooks dir', () => {
  it('reads ALLOW for the control that MUST block — and assertHookInstrument catches it', async () => {
    const lone = fs.mkdtempSync(join(os.tmpdir(), 'hook-probe-lone-'));
    try {
      // The "obvious" way: copy ONE file, no siblings.
      fs.copyFileSync(join(hooksDir, 'guard.mjs'), join(lone, 'guard.mjs'));
      const naive = await runHookVerdict(join(lone, 'guard.mjs'), { input: bash, env: ENV });
      // Silent fail-open: the crash is byte-identical to ALLOW. THIS is the false reading.
      expect(naive.run.stdout).toBe('');
      expect(naive.verdict).toBe('ALLOW');
      // …and the control is what exposes it.
      await expect(
        assertHookInstrument(join(lone, 'guard.mjs'), { env: ENV, positiveControl: POSITIVE }),
      ).rejects.toThrow(HookInstrumentError);
      await expect(
        assertHookInstrument(join(lone, 'guard.mjs'), { env: ENV, positiveControl: POSITIVE }),
      ).rejects.toThrow(/INSTRUMENT is broken, not the subject/);
    } finally {
      fs.rmSync(lone, { recursive: true, force: true });
    }
  });

  it('when the hook is loud on stderr, classification says CRASHED naming the missing sibling', async () => {
    const lone = fs.mkdtempSync(join(os.tmpdir(), 'hook-probe-lone-'));
    try {
      fs.copyFileSync(join(hooksDir, 'guard.mjs'), join(lone, 'guard.mjs'));
      const r = await runHookVerdict(join(lone, 'guard.mjs'), {
        input: bash,
        env: { ...ENV, GUARD_LOUD: '1' },
      });
      expect(r.verdict).toBe('CRASHED');
      expect(r.run.stderr).toMatch(/sibling\.mjs/);
    } finally {
      fs.rmSync(lone, { recursive: true, force: true });
    }
  });
});

describe('materializeHookDir — whole-directory copy resolves siblings', () => {
  it('a relocated copy of the CURRENT hook passes both controls and blocks tools:invoke', async () => {
    const m = materializeHookDir({ hooksDir, hookFile: 'guard.mjs' });
    try {
      await assertHookInstrument(m.hookPath, {
        env: ENV,
        positiveControl: POSITIVE,
        negativeControl: NEGATIVE,
      });
      expect((await runHookVerdict(m.hookPath, { input: toolsInvoke, env: ENV })).verdict).toBe(
        'BLOCK',
      );
    } finally {
      m.cleanup();
    }
  });

  it('A/B with historical bytes: both arms pass the control, ONLY the arms differ on the subject case', async () => {
    const current = materializeHookDir({ hooksDir, hookFile: 'guard.mjs' });
    const old = materializeHookDir({ hooksDir, hookFile: 'guard.mjs', content: HOOK_HISTORICAL });
    try {
      for (const m of [current, old]) {
        await assertHookInstrument(m.hookPath, { env: ENV, positiveControl: POSITIVE });
      }
      const cur = await runHookVerdict(current.hookPath, { input: toolsInvoke, env: ENV });
      const prev = await runHookVerdict(old.hookPath, { input: toolsInvoke, env: ENV });
      expect(cur.verdict).toBe('BLOCK'); // fixed
      expect(prev.verdict).toBe('ALLOW'); // the genuine pre-fix blind spot — now a TRUSTED ALLOW
    } finally {
      current.cleanup();
      old.cleanup();
    }
  });

  it('preserves the subject file mode when overwriting', () => {
    fs.chmodSync(join(hooksDir, 'guard.mjs'), 0o755);
    const m = materializeHookDir({ hooksDir, hookFile: 'guard.mjs', content: HOOK_HISTORICAL });
    try {
      expect(fs.statSync(m.hookPath).mode & 0o777).toBe(0o755);
    } finally {
      m.cleanup();
    }
  });

  it('refuses: both content and gitRef · a path (not basename) · a missing subject', () => {
    expect(() =>
      materializeHookDir({ hooksDir, hookFile: 'guard.mjs', content: 'x', gitRef: 'abc' }),
    ).toThrow(/not both/);
    expect(() => materializeHookDir({ hooksDir, hookFile: '../x.mjs' })).toThrow(/basename/);
    expect(() => materializeHookDir({ hooksDir, hookFile: 'nope.mjs' })).toThrow(/not found/);
  });

  it('cleanup removes the temp dir and is idempotent', () => {
    const m = materializeHookDir({ hooksDir, hookFile: 'guard.mjs' });
    expect(fs.existsSync(m.dir)).toBe(true);
    m.cleanup();
    m.cleanup();
    expect(fs.existsSync(m.dir)).toBe(false);
  });

  it('does not carry __tests__ into the copy', () => {
    fs.mkdirSync(join(hooksDir, '__tests__'), { recursive: true });
    fs.writeFileSync(join(hooksDir, '__tests__', 'x.test.ts'), '//');
    const m = materializeHookDir({ hooksDir, hookFile: 'guard.mjs' });
    try {
      expect(fs.existsSync(join(m.dir, '__tests__'))).toBe(false);
      expect(fs.existsSync(join(m.dir, 'sibling.mjs'))).toBe(true);
    } finally {
      m.cleanup();
      fs.rmSync(join(hooksDir, '__tests__'), { recursive: true, force: true });
    }
  });
});

describe('materializeHookDir { gitRef } — the pre-fix arm read from history', () => {
  it('materialises the subject as of an older SHA, siblings intact', async () => {
    const repo = fs.mkdtempSync(join(os.tmpdir(), 'hook-probe-repo-'));
    try {
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-c',
            'user.name=probe',
            '-c',
            'user.email=probe@example.invalid',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'core.hooksPath=/dev/null',
            ...args,
          ],
          { cwd: repo, encoding: 'utf8', env: cleanGitEnv() },
        ).trim();
      git('init', '-q');
      fs.mkdirSync(join(repo, 'hooks'));
      fs.writeFileSync(join(repo, 'hooks', 'sibling.mjs'), SIBLING);
      fs.writeFileSync(join(repo, 'hooks', 'guard.mjs'), HOOK_HISTORICAL);
      git('add', '-A');
      git('commit', '-q', '-m', 'v1 (pre-fix)');
      const preFixSha = git('rev-parse', 'HEAD');
      fs.writeFileSync(join(repo, 'hooks', 'guard.mjs'), HOOK_CURRENT);
      git('add', '-A');
      git('commit', '-q', '-m', 'v2 (fix)');

      const old = materializeHookDir({
        hooksDir: join(repo, 'hooks'),
        hookFile: 'guard.mjs',
        gitRef: preFixSha,
      });
      const cur = materializeHookDir({ hooksDir: join(repo, 'hooks'), hookFile: 'guard.mjs' });
      try {
        await assertHookInstrument(old.hookPath, { env: ENV, positiveControl: POSITIVE });
        await assertHookInstrument(cur.hookPath, { env: ENV, positiveControl: POSITIVE });
        expect((await runHookVerdict(old.hookPath, { input: toolsInvoke, env: ENV })).verdict).toBe(
          'ALLOW',
        );
        expect((await runHookVerdict(cur.hookPath, { input: toolsInvoke, env: ENV })).verdict).toBe(
          'BLOCK',
        );
      } finally {
        old.cleanup();
        cur.cleanup();
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('calibration against a REAL shipped hook', () => {
  it('a whole-directory copy of the real hooks/cc runs pretooluse-generated-file-edit-guard with the control intact', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'hook-probe-real-'));
    const m = materializeHookDir({
      hooksDir: HOOKS_CC_DIR,
      hookFile: 'pretooluse-generated-file-edit-guard.mjs',
    });
    try {
      const generated = join(dir, 'GENERATED.md');
      const hand = join(dir, 'HAND.md');
      fs.writeFileSync(generated, '<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->\n\n# Body\n');
      fs.writeFileSync(hand, '# Hand authored\n');
      const edit = (p: string) => JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: p } });
      await assertHookInstrument(m.hookPath, {
        // Cleared so an exported bypass cannot turn the positive control into a false ALLOW.
        env: { PATH: process.env.PATH ?? '', PAPERCUSP_ALLOW_GENERATED_EDIT: '' },
        positiveControl: { name: 'edit of a GENERATED file must block', input: edit(generated) },
        negativeControl: { name: 'edit of a hand-authored file must allow', input: edit(hand) },
      });
    } finally {
      m.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
