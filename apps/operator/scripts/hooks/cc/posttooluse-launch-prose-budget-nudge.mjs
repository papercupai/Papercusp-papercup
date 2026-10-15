#!/usr/bin/env node
// PostToolUse advisory: check launch-prose ceilings immediately after prompt/doc-part edits.
// WI-10004682 / WI-6554700010009148 — surface a breach before git-sync commits it.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editedPathsFrom } from './posttooluse-frozen-candidate-edit-nudge.mjs';

const CHECKER_REL = join('scripts', 'check-launch-prose-budget.ts');
const MAX_OUTPUT = 2_000_000;

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

function normalise(filePath) {
  return String(filePath || '').split(sep).join('/');
}

/** Prompt sources and projected guide files whose bytes feed launch prose. */
export function isLaunchProsePath(filePath) {
  const path = normalise(filePath);
  if (!path) return false;
  if (/(?:^|\/)(?:CLAUDE|AGENTS)\.md$/.test(path)) return true;
  return /(?:^|\/)apps\/operator\/prompts\/[^/]+\.md$/.test(path);
}

/** A set-doc-part/projector write changes the canonical harness doc-part corpus. */
export function isDocPartWrite(toolName, toolInput = {}) {
  const values = [toolInput.command, toolInput.cmd, toolInput.file_path, toolInput.part_key, toolInput.partKey]
    .filter(Boolean)
    .join(' ');
  if (/set-doc-part(?:\.ts)?/.test(values) && /(?:--write|write)/.test(values)) return true;
  if (/project-doc-parts\.mjs/.test(values) && /(?:--write|write)/.test(values)) return true;
  return false;
}

export function shouldCheck(toolName, toolInput = {}) {
  if (/(?:^|__)tools[_:]invoke$/.test(String(toolName))) {
    return shouldCheck(toolInput.name, toolInput.args);
  }
  const name = ({ edit: 'Edit', write: 'Write', multi_edit: 'MultiEdit', ast_edit: 'Edit' })[toolName] || String(toolName || '');
  const editTool = /^(?:Edit|Write|MultiEdit|apply_patch|write_file|edit_file)$/.test(name) || /capability[_:-](?:edit|write|multi_?edit|patch)$/.test(name);
  if (editTool) {
    const paths = editedPathsFrom({ tool_name: name, tool_input: toolInput });
    if (paths.some(isLaunchProsePath)) return true;
  }
  return isDocPartWrite(name, toolInput);
}

export function findRepoRoot(startPath, exists = existsSync) {
  let dir = dirname(resolve(startPath));
  for (let i = 0; i < 40; i += 1) {
    if (exists(join(dir, CHECKER_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function runBudget(root, spawn = execFileSync) {
  try {
    const stdout = spawn(process.execPath, ['--import', 'tsx', CHECKER_REL, '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: MAX_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } catch (error) {
    // A budget breach exits 1 WITH the JSON report. Discarding stdout here would
    // silence exactly the failing case this hook must report.
    if (error?.status === 1 && error.stdout) {
      try { return JSON.parse(String(error.stdout)); } catch { /* report unavailable below */ }
    }
    return null;
  }
}

export function formatNudge(report) {
  if (!report || !Array.isArray(report.failures) || report.failures.length === 0) return '';
  return [
    '⚠ launch-prose budget breach detected immediately after this edit (WI-10004682):',
    ...report.failures.map((failure) => `  • ${failure.message || `${failure.surface || 'unknown surface'}: ${failure.status || 'failed'}`}`),
    'Run `npm run lint:launch-prose-budget -- --json` for the complete report; trim prose before git-sync commits it.',
  ].join('\n');
}

export function nudgeFor(toolName, toolInput = {}, { root, cwd = process.cwd(), run = runBudget } = {}) {
  if (/(?:^|__)tools[_:]invoke$/.test(String(toolName))) {
    return nudgeFor(toolInput.name, toolInput.args, { root, cwd, run });
  }
  if (!shouldCheck(toolName, toolInput)) return '';
  const paths = editedPathsFrom({ tool_name: toolName, tool_input: toolInput });
  const repo = root || paths.map((path) => findRepoRoot(resolve(cwd, path))).find(Boolean)
    || findRepoRoot(join(cwd, '_launch-prose-hook'));
  if (!repo) return '';
  const report = run(repo);
  if (!report || !Array.isArray(report.failures)) return '⚠ launch-prose budget NOT checked: the edit-time checker failed. Run `npm run lint:launch-prose-budget` before relying on this edit.';
  return formatNudge(report);
}

async function readStdin() {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const message = nudgeFor(input.tool_name, input.tool_input ?? {}, { cwd: input.cwd || process.cwd() });
    if (message) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }) + '\n');
    }
  } catch {
    // PostToolUse is advisory and must fail open after the edit succeeds.
  }
}
