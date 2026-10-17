/**
 * pretooluse-control-bytes-content-guard — the recurrence guard for the
 * raw-control-byte-into-source CLASS (EI-19478121013052934).
 *
 * THE POINT OF THIS FILE: the class red-pinned the fleet gate TWICE in one day,
 * on two sibling files in the same directory — WI-9059
 * (test-file-name-filter.test.ts, 6x 0x1b, verdict 17:27Z) and
 * test-file-router.test.ts (4x 0x1b, verdicts 22:37Z + 23:34Z) — both while
 * building fixtures for EI-18819483316574031 (ANSI-coloured tool output).
 * `lint:no-control-bytes` already existed and caught both; it is a
 * GREEN-CHECKPOINT leg, so it caught them ~an hour later, fleet-wide, with
 * `main` frozen for everyone. The guard exists to move that detection to the
 * moment of authoring.
 *
 * WHY THE FIRST TEST IS THE IMPORTANT ONE: the hook FAILS OPEN by design (a bug
 * in a PreToolUse hook must never wedge every edit on the box). That is the right
 * call, and it has a sharp edge — if the policy import breaks, the guard silently
 * stops guarding and NOTHING reports it. Un-exporting `isScannedPath` from
 * scripts/check-no-control-bytes.mjs is a one-word change that reads as tidying
 * up an unused export. So the load-bearing assertion here is not "the hook denies"
 * but "the REAL policy it depends on is still exported" — otherwise this whole
 * suite could pass against a guard that is fully inert.
 *
 * The negative cases matter exactly as much: a guard that blocks ordinary edits
 * is one an agent routes around, which is how a working detector stops working.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../pretooluse-control-bytes-content-guard.mjs');
const POLICY = resolve(ROOT, 'scripts/check-no-control-bytes.mjs');

// A REAL ESC byte, written as an escape (this file is itself subject to the lint
// under test — writing it raw here would red the very gate this guard protects).
const ESC = '\x1b';

type Decision = { permissionDecision?: string; permissionDecisionReason?: string };

/** Drive the hook exactly as the CLI does: hook JSON on stdin, JSON or nothing out. */
function runHook(payload: unknown, hook = HOOK): Decision | null {
  const out = execFileSync('node', [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!out.trim()) return null;
  return (JSON.parse(out) as { hookSpecificOutput: Decision }).hookSpecificOutput;
}

function edit(relPath: string, newString: string) {
  return { tool_name: 'Edit', tool_input: { file_path: resolve(ROOT, relPath), new_string: newString } };
}
function write(relPath: string, content: string) {
  return { tool_name: 'Write', tool_input: { file_path: resolve(ROOT, relPath), content } };
}
function mcpEdit(relPath: string, newString: string, server = 'papercusp-su') {
  return {
    tool_name: `mcp__${server}__capability_edit`,
    tool_input: { file_path: resolve(ROOT, relPath), new_string: newString },
  };
}
function mcpWrite(relPath: string, content: string, server = 'papercusp-su') {
  return {
    tool_name: `mcp__${server}__capability_write`,
    tool_input: { file_path: resolve(ROOT, relPath), content },
  };
}
function applyPatch(patch: string | Record<string, string>) {
  return { tool_name: 'apply_patch', tool_input: patch, cwd: ROOT };
}

describe('the policy it depends on', () => {
  // THE load-bearing test: the hook fails open, so a broken import disables it silently.
  it('is still exported from check-no-control-bytes.mjs (the hook fails OPEN without it)', async () => {
    const mod = await import(`file://${POLICY}`);
    expect(typeof mod.isForbiddenControlByte, 'isForbiddenControlByte must stay exported').toBe('function');
    expect(typeof mod.isScannedPath, 'isScannedPath must stay exported').toBe('function');
  });

  it('is SHARED with the gate, not re-derived — the guard scopes exactly where the lint scans', async () => {
    const { isScannedPath } = await import(`file://${POLICY}`);
    expect(isScannedPath('packages/operator-core/lib/__tests__/test-file-router.test.ts')).toBe(true);
    // ALLOW_PREFIXES escape hatch must keep working through the same list.
    expect(isScannedPath('papercusp-desktop/src-tauri/env-sidecars/serve.mjs')).toBe(false);
  });

  // WI-39392: this exclusion is why the fleet gate went red for a full ~55min suite.
  // `git ls-files --recurse-submodules` walks INTO submodules, and several of them track
  // their own node_modules — so minified dependency bundles (vitest's cli-api chunks) were
  // scanned as if they were our source. They legitimately carry raw \x01-\x1f in string
  // tables, and the remedy this lint prints ("write it as an escape") is impossible in a
  // file npm reinstalls wholesale, so the red was unactionable by construction.
  it('never scans vendored dependency trees, at ANY depth or submodule (WI-39392)', async () => {
    const { isScannedPath } = await import(`file://${POLICY}`);
    // A SEGMENT match, not a prefix — the real offenders were nested inside submodules.
    expect(isScannedPath('libs/testing-shell/node_modules/vitest/dist/chunks/cli-api.BkDphVBG.js')).toBe(false);
    expect(isScannedPath('libs/generic/resumable-download/node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js')).toBe(false);
    expect(isScannedPath('node_modules/vitest/dist/chunks/cli-api.js')).toBe(false);
    // ...while a path that merely CONTAINS the word stays in scope — the exclusion must be
    // a path segment, never a substring, or it becomes an accidental escape hatch.
    expect(isScannedPath('packages/operator-core/lib/node_modules_report.ts')).toBe(true);
  });

  // The docs build mirrors pagefind to BOTH locations; only one was ever allowed, so the
  // second copy red-pinned the gate the moment a build produced it.
  it('allows BOTH pagefind mirrors, not just the internal one (WI-39392)', async () => {
    const { isScannedPath } = await import(`file://${POLICY}`);
    expect(isScannedPath('apps/operator/public/internal/docs/pagefind/pagefind-highlight.js')).toBe(false);
    expect(isScannedPath('apps/operator/public/docs/pagefind/pagefind-highlight.js')).toBe(false);
  });

  it('allows generated native fixture debug bundles in either producer layout (WI-6554700010015700)', async () => {
    const { isScannedPath } = await import(`file://${POLICY}`);
    expect(isScannedPath('apps/operator/dist-host-native-fixture-debug-2001983/hono-host.mjs')).toBe(false);
    expect(isScannedPath('apps/operator/apps/operator/dist-host-native-fixture-debug-2047298/spawner-sidecar.mjs')).toBe(false);
    // The exclusion is path-shaped, so similarly named hand-authored source remains scanned.
    expect(isScannedPath('apps/operator/lib/dist-host-native-fixture-debugger.ts')).toBe(true);
  });
});

describe('it is worktree-portable (WI-10811)', () => {
  // WHY THIS EXISTS, AND WHY NOTHING ELSE HERE COVERS IT: the hook used to pin
  // REPO_ROOT to an absolute path to the staging checkout. green-checkpoint runs
  // this suite from a DIFFERENT worktree (papercusp-checkpoint), so every path
  // below failed `startsWith(REPO_ROOT)`, toRepoRelative() returned null, and the
  // hook FAILED OPEN on genuine hits — red-pinning the fleet gate on 7 deny-cases
  // per run while the guard was silently inert in every non-staging worktree.
  //
  // The rest of this file structurally CANNOT catch that: fail-open IS allow, so
  // all 10 negative cases stay green against a completely inert hook, and the
  // positive cases only pass in the one tree where the literal happened to match.
  // So the assertion has to be on the RESOLUTION MECHANISM itself.
  it('resolves the live checkout from hook cwd, never a hardcoded absolute path', () => {
    const source = readFileSync(HOOK, 'utf8');
    expect(source).toContain('repoRootFrom(hook.cwd)');
    const fallbackLine = source.split('\n').find((l) => l.includes('const SOURCE_ROOT'));
    expect(fallbackLine, 'source-tree fallback must remain worktree-relative').toContain('import.meta.url');
    // A quoted absolute path here is the exact regression: it makes the guard
    // correct in one worktree and inert in every other.
    expect(fallbackLine, 'root must not be a hardcoded path literal').not.toMatch(/['"`]\s*\//);
  });

  it('still loads the shared policy after installation outside the repository', () => {
    const installedDir = mkdtempSync(join(tmpdir(), 'control-byte-hook-installed-'));
    const installedHook = join(installedDir, 'pretooluse-control-bytes-content-guard.mjs');
    try {
      copyFileSync(HOOK, installedHook);
      const d = runHook(
        { ...edit('packages/operator-core/lib/x.ts', `captured${ESC}`), cwd: ROOT },
        installedHook,
      );
      expect(d?.permissionDecision).toBe('deny');
    } finally {
      rmSync(installedDir, { recursive: true, force: true });
    }
  });
});

describe('it fires on the real thing', () => {
  it('DENIES the actual EI-19478121013052934 content (captured esbuild output, raw 0x1b)', () => {
    const d = runHook(
      edit(
        'packages/operator-core/lib/__tests__/test-file-router.test.ts',
        `'${ESC}[31mError: Transform failed with 1 error:${ESC}[39m\\n'`,
      ),
    );
    expect(d?.permissionDecision).toBe('deny');
    expect(d?.permissionDecisionReason).toContain('0x1b');
  });

  it('DENIES the WI-9059 shape too (Write, sibling file, same byte class)', () => {
    const d = runHook(write('packages/operator-core/lib/__tests__/test-file-name-filter.test.ts', `x${ESC}[2my`));
    expect(d?.permissionDecision).toBe('deny');
  });

  it('scans EVERY edit of a MultiEdit, not just the first', () => {
    const d = runHook({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: resolve(ROOT, 'packages/operator-core/lib/x.ts'),
        edits: [{ new_string: 'clean' }, { new_string: `dirty${ESC}` }],
      },
    });
    expect(d?.permissionDecision).toBe('deny');
  });

  it('DENIES a NUL byte as well (the byte that also blinds git diff)', () => {
    const d = runHook(write('packages/operator-core/lib/x.ts', 'a\x00b'));
    expect(d?.permissionDecision).toBe('deny');
  });

  it('DENIES MCP capability edit/write, including a renamed MCP server', () => {
    expect(runHook(mcpEdit('packages/operator-core/lib/x.ts', 'a\x00b'))?.permissionDecision).toBe('deny');
    expect(runHook(mcpWrite('packages/operator-core/lib/x.ts', `a${ESC}b`))?.permissionDecision).toBe('deny');
    expect(runHook(mcpEdit('packages/operator-core/lib/x.ts', 'a\x00b', 'some-other-server'))?.permissionDecision).toBe(
      'deny',
    );
  });

  it('DENIES every edit in an MCP capability multi-edit', () => {
    const d = runHook({
      tool_name: 'mcp__papercusp-su__capability_multi_edit',
      tool_input: {
        file_path: resolve(ROOT, 'packages/operator-core/lib/x.ts'),
        edits: [{ new_string: 'clean' }, { new_string: `dirty${ESC}` }],
      },
    });
    expect(d?.permissionDecision).toBe('deny');
  });

  it('DENIES a raw control byte in a Codex apply_patch added line', () => {
    const d = runHook(
      applyPatch(
        [
          '*** Begin Patch',
          '*** Update File: packages/operator-core/lib/x.ts',
          '@@',
          `+const captured = '${ESC}[31m';`,
          '*** End Patch',
        ].join('\n'),
      ),
    );
    expect(d?.permissionDecision).toBe('deny');
    expect(d?.permissionDecisionReason).toContain('packages/operator-core/lib/x.ts');
    expect(d?.permissionDecisionReason).toContain('0x1b');
  });

  it('DENIES wrapped Codex apply_patch input and checks every touched file', () => {
    const d = runHook(
      applyPatch({
        patch: [
          '*** Begin Patch',
          '*** Update File: packages/operator-core/lib/clean.ts',
          '@@',
          '+const clean = true;',
          '*** Update File: packages/operator-core/lib/dirty.ts',
          '@@',
          '+const dirty = "a\x00b";',
          '*** End Patch',
        ].join('\n'),
      }),
    );
    expect(d?.permissionDecision).toBe('deny');
    expect(d?.permissionDecisionReason).toContain('packages/operator-core/lib/dirty.ts');
    expect(d?.permissionDecisionReason).toContain('0x00');
  });
});

describe('it does not fire on ordinary edits', () => {
  it('ALLOWS the prescribed escape fix — otherwise the denial would be unfixable', () => {
    // Double-backslash in this source = the literal 4 chars \x1b, which is exactly
    // what the remediation asks the author to write.
    expect(runHook(edit('packages/operator-core/lib/__tests__/test-file-router.test.ts', "'\\x1b[31mErr'"))).toBeNull();
  });

  it('ALLOWS tabs, newlines and carriage returns', () => {
    expect(runHook(write('packages/operator-core/lib/x.ts', 'const a = 1;\n\tconst b = 2;\r\n'))).toBeNull();
  });

  it('ALLOWS a path the gate does not scan (non-source extension)', () => {
    expect(runHook(write('some/fixture.bin', `a${ESC}b`))).toBeNull();
  });

  it('ALLOWS a generated artifact under ALLOW_PREFIXES', () => {
    expect(runHook(write('papercusp-desktop/src-tauri/env-sidecars/serve.mjs', `a${ESC}b`))).toBeNull();
  });

  it('ALLOWS a file outside the repo entirely', () => {
    expect(
      runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/elsewhere/x.ts', content: `a${ESC}b` } }),
    ).toBeNull();
  });

  it('ALLOWS tools it does not govern', () => {
    expect(runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull();
    expect(runHook({ tool_name: 'mcp__papercusp-su__capability_read', tool_input: { file_path: '/tmp/x.ts' } })).toBeNull();
  });

  it('ALLOWS apply_patch to REMOVE a raw byte when the added line uses its escape', () => {
    const d = runHook(
      applyPatch(
        [
          '*** Begin Patch',
          '*** Update File: packages/operator-core/lib/x.ts',
          '@@',
          `-const captured = '${ESC}[31m';`,
          "+const captured = '\\x1b[31m';",
          '*** End Patch',
        ].join('\n'),
      ),
    );
    expect(d).toBeNull();
  });

  it('ALLOWS apply_patch raw bytes only in a path the gate does not scan', () => {
    const d = runHook(
      applyPatch(
        ['*** Begin Patch', '*** Add File: fixtures/raw.bin', `+a${ESC}b`, '*** End Patch'].join('\n'),
      ),
    );
    expect(d).toBeNull();
  });
});

describe('it fails open rather than wedging the box', () => {
  it('allows on malformed stdin', () => {
    const out = execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    expect(out.trim()).toBe('');
  });

  it('allows when file_path is missing', () => {
    expect(runHook({ tool_name: 'Edit', tool_input: { new_string: `a${ESC}b` } })).toBeNull();
  });
});

describe('the remediation text', () => {
  const reason = () =>
    runHook(edit('packages/operator-core/lib/__tests__/test-file-router.test.ts', `a${ESC}b`))
      ?.permissionDecisionReason ?? '';

  // Learned the hard way on WI-9059: Read normalises ESC away, so an Edit-based fix
  // silently deletes the escapes and leaves a test that passes while testing nothing.
  // If a future edit drops this sentence, the guard starts handing out advice that
  // produces a green vacuous test — worse than no advice.
  it('tells the author to fix with Write, NOT Edit (WI-9059)', () => {
    const r = reason();
    expect(r).toMatch(/`Write`, NOT `Edit`/);
    expect(r).toMatch(/normalises/i);
  });

  it('warns that the double-backslash form is inert', () => {
    expect(reason()).toMatch(/INERT/);
  });

  it('names the escape that actually fixes it', () => {
    expect(reason()).toContain('\\x1b');
  });
});
