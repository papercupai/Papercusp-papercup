/**
 * WI-6554700010008578 — the post-stage guard must not hold a staged importer whose ONLY edge to
 * an excluded provider is a bare side-effect import (`import './x';`) when that provider is
 * present at HEAD.
 *
 * MEASURED 2026-10-11 14:58-15:22Z (papercusp-bg-host journal): four consecutive sweeps
 * held `packages/operator-core/lib/agent-tools/index.ts`, whose only change was one new
 * `import './plans/bind-independent-verification';` line (target already committed), because
 * the hub ALSO side-effect-imports './chat/reply' and later './inbox/bulk-run' — tracked tool
 * modules a peer had changed outside this commit's index. A side-effect edge names no export,
 * so HEAD's old provider satisfies it; the guard's own HEAD-presence seam already says so, but
 * the post-stage call forced every excluded path to "not at HEAD", so a registration hub that
 * loads hundreds of tool modules was held whenever any one of them was dirty elsewhere.
 *
 * Named imports keep the conservative hold: an old provider may lack a new export.
 *
 * These tests drive real git repositories (same harness as untracked-import-hold.test.ts):
 * the defect is the gap between the working tree and the index a commit records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { guardStagedIndexBeforeCommit, type RunGit } from './run-git-sync';

const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

const runGit: RunGit = (args, cwd, options) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: { ...GIT_ENV, ...options?.env } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });

async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, repo);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

async function stagedPaths(repo: string): Promise<string[]> {
  return (await git(repo, 'diff', '--cached', '--name-only', '--no-renames')).split('\n').filter(Boolean).sort();
}

let repo: string;
const logs: string[] = [];
const log = (m: string) => logs.push(m);
const readText = async (rel: string): Promise<string | null> => {
  try {
    return readFileSync(join(repo, rel), 'utf8');
  } catch {
    return null;
  }
};

function guard() {
  return guardStagedIndexBeforeCommit({ runGit, repoPath: repo, scope: 'test', readText, log });
}

const HUB = 'lib/agent-tools/index.ts';

beforeEach(async () => {
  logs.length = 0;
  repo = mkdtempSync(join(tmpdir(), 'wi6554700010008578-'));
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  // The registration hub loads every tool by side effect; the new tool is already committed.
  write(repo, 'lib/agent-tools/chat/reply.ts', "export const reply = 'v1';\n");
  write(repo, 'lib/agent-tools/plans/new-tool.ts', "export const newTool = 'v1';\n");
  write(repo, HUB, "import './chat/reply';\n");
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'seed');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('WI-6554700010008578: side-effect-only importers of excluded providers present at HEAD', () => {
  it('commits the hub when a side-effect-imported tool module is changed outside this index (the measured shape)', async () => {
    // A peer's in-flight change to a tool the hub loads, left out of this commit's index.
    write(repo, 'lib/agent-tools/chat/reply.ts', "export const reply = 'v2';\n");
    // Our change: one new registration line for a tool already at HEAD.
    write(repo, HUB, "import './chat/reply';\nimport './plans/new-tool';\n");
    await git(repo, 'add', '--', HUB);
    expect(await stagedPaths(repo)).toEqual([HUB]);

    const result = await guard();

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: [] });
    expect(await stagedPaths(repo)).toEqual([HUB]);
    expect(logs.join('\n')).not.toContain(`${HUB} imports`);
  });

  it('still holds an importer that NAMES an export of the excluded provider', async () => {
    write(repo, 'lib/agent-tools/chat/reply.ts', "export const reply = 'v2';\nexport const replyV2 = 2;\n");
    write(repo, HUB, "import { replyV2 } from './chat/reply';\nexport const uses = replyV2;\n");
    await git(repo, 'add', '--', HUB);

    const result = await guard();

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: [HUB] });
    expect(await stagedPaths(repo)).toEqual([]);
    expect(logs.join('\n')).toContain('lib/agent-tools/chat/reply.ts');
  });

  it('still holds a side-effect importer when the same provider is also consumed by name elsewhere in the file', async () => {
    write(repo, 'lib/agent-tools/chat/reply.ts', "export const reply = 'v2';\n");
    write(repo, HUB, "import './chat/reply';\nexport { reply } from './chat/reply';\n");
    await git(repo, 'add', '--', HUB);

    const result = await guard();

    expect(result.ok && result.unstaged).toEqual([HUB]);
  });

  it('still holds a side-effect importer whose provider is untracked (absent from HEAD and this commit)', async () => {
    write(repo, 'lib/agent-tools/plans/brand-new.ts', "export const brandNew = 1;\n");
    write(repo, HUB, "import './chat/reply';\nimport './plans/brand-new';\n");
    await git(repo, 'add', '--', HUB);

    const result = await guard();

    expect(result.ok && result.unstaged).toEqual([HUB]);
    expect(logs.join('\n')).toContain('lib/agent-tools/plans/brand-new.ts');
  });
});
