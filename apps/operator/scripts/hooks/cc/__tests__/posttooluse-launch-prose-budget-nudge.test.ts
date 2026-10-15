import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  findRepoRoot,
  formatNudge,
  isDocPartWrite,
  isLaunchProsePath,
  nudgeFor,
  runBudget,
  shouldCheck,
} = await import(process.env.PAPERCUSP_PROSE_BUDGET_SUBJECT || '../posttooluse-launch-prose-budget-nudge.mjs');

describe('posttooluse-launch-prose-budget-nudge', () => {
  it('recognises prompt and projected guide paths, but not ordinary source files', () => {
    expect(isLaunchProsePath('/repo/apps/operator/prompts/papercusp-su.codex.md')).toBe(true);
    expect(isLaunchProsePath('/repo/CLAUDE.md')).toBe(true);
    expect(isLaunchProsePath('/repo/packages/operator-core/lib/foo.ts')).toBe(false);
  });

  it('recognises set-doc-part and projector writes', () => {
    expect(isDocPartWrite('Bash', { command: 'node scripts/set-doc-part.ts --write' })).toBe(true);
    expect(isDocPartWrite('Bash', { command: 'node scripts/project-doc-parts.mjs --write' })).toBe(true);
    expect(isDocPartWrite('Bash', { command: 'node scripts/set-doc-part.ts --show' })).toBe(false);
    expect(isDocPartWrite('docs:author', { write: true })).toBe(false);
  });

  it('checks prompt edits and ignores unrelated edits', () => {
    expect(shouldCheck('Edit', { file_path: '/repo/apps/operator/prompts/foo.md' })).toBe(true);
    expect(shouldCheck('Edit', { file_path: '/repo/packages/foo.ts' })).toBe(false);
    expect(shouldCheck('Edit', { file_path: 'apps/operator/prompts/foo.md' })).toBe(true);
    expect(shouldCheck('apply_patch', '*** Begin Patch\n*** Update File: apps/operator/prompts/foo.md\n@@\n-a\n+b\n*** End Patch')).toBe(true);
    expect(shouldCheck('mcp__papercusp_su__tools_invoke', { name: 'capability:edit', args: { file_path: 'apps/operator/prompts/foo.md' } })).toBe(true);
    expect(shouldCheck('tools:invoke', { name: 'capability:patch', args: { edits: [{ file_path: 'apps/operator/prompts/foo.md' }] } })).toBe(true);
    expect(shouldCheck('capability:patch', { edits: [{ file_path: 'apps/operator/prompts/foo.md' }] })).toBe(true);
    expect(shouldCheck('edit', { path: 'apps/operator/prompts/foo.md' })).toBe(true);
    expect(shouldCheck('ast_edit', { path: 'apps/operator/prompts/foo.md' })).toBe(true);
    expect(shouldCheck('write', { path: 'ordinary.ts' })).toBe(false);
    expect(shouldCheck('Read', { file_path: '/repo/apps/operator/prompts/foo.md' })).toBe(false);
  });

  it('formats only actual budget failures', () => {
    expect(formatNudge({ failures: [] })).toBe('');
    expect(formatNudge({ failures: [{ surface: 'su-base:power', message: 'over by 4 B' }] })).toContain('over by 4 B');
  });

  it('delivers breach verdicts for both prompt edits and doc-part writes', () => {
    for (const [tool, input] of [
      ['Edit', { file_path: '/repo/apps/operator/prompts/foo.md' }],
      ['capability:bash', { command: 'node scripts/set-doc-part.ts --write' }],
    ] as const) {
      expect(nudgeFor(tool, input, { root: '/repo', run: () => ({ failures: [{ message: 'over by 4 B' }] }) })).toContain('over by 4 B');
    }
  });

  it('fails open when the checker cannot run', () => {
    expect(nudgeFor('Edit', { file_path: '/repo/apps/operator/prompts/foo.md' }, {
      root: '/repo',
      run: () => null,
    })).toContain('NOT checked');
    expect(nudgeFor('Edit', { file_path: '/repo/apps/operator/prompts/foo.md' }, {
      root: '/repo', run: () => ({}),
    })).toContain('NOT checked');
  });

  it('retains a failing checker report from exit-1 stdout', () => {
    const report = { ok: false, failures: [{ message: 'power over by 4 B' }] };
    const result = runBudget('/repo', () => { throw Object.assign(new Error('exit 1'), { status: 1, stdout: JSON.stringify(report) }); });
    expect(result).toEqual(report);
    expect(formatNudge(result)).toContain('power over by 4 B');
    expect(runBudget('/repo', () => { throw Object.assign(new Error('timeout'), { status: null }); })).toBeNull();
  });

  it('finds the repository from a nested hook path', () => {
    expect(findRepoRoot('/repo/apps/operator/prompts/foo.md', (path) => path === '/repo/scripts/check-launch-prose-budget.ts')).toBe('/repo');
  });

  it.each([
    { name: 'breach', checker: 'console.log(JSON.stringify({failures:[{message:"overlay over by 4 B"}]})); process.exitCode=1;', expected: 'overlay over by 4 B' },
    { name: 'success', checker: 'console.log(JSON.stringify({failures:[]}));', expected: null },
    { name: 'checker error', checker: 'process.exitCode=2;', expected: 'NOT checked' },
    { name: 'malformed report', checker: 'console.log("{}");', expected: 'NOT checked' },
  ])('delivers $name through the real PostToolUse subprocess', ({ checker, expected }) => {
    const root = mkdtempSync(join(tmpdir(), 'launch-prose-hook-'));
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
    try {
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'scripts/check-launch-prose-budget.ts'), checker);
      symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
      const installed = join(root, '.papercusp/hooks/cc');
      mkdirSync(installed, { recursive: true });
      for (const file of ['posttooluse-launch-prose-budget-nudge.mjs', 'posttooluse-frozen-candidate-edit-nudge.mjs']) {
        copyFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', file), join(installed, file));
      }
      const result = spawnSync(process.execPath, [join(installed, 'posttooluse-launch-prose-budget-nudge.mjs')], {
        cwd: root,
        input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'apps/operator/prompts/example.md' }, cwd: root }),
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      if (expected === null) expect(result.stdout).toBe('');
      else expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolUse', additionalContext: expect.stringContaining(expected) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
