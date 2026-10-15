import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeEnv, cleanEnv, cliArgs, codexConfigToml, CORPUS_FILE, corpusFileFromArgv, loadCorpus, sessionDiff, summarizeToolCalls, summarizeToolOutcomes } from './record-session';

describe('corpusFileFromArgv', () => {
  it('defaults to the shipped corpus and resolves --tasks-file when given', () => {
    expect(corpusFileFromArgv(['node', 'record-session.ts', '--cli', 'claude'])).toBe(CORPUS_FILE);
    expect(corpusFileFromArgv(['node', 'x', '--tasks-file', 'p019/tasks.json', '--cli', 'codex'])).toBe(path.resolve('p019/tasks.json'));
  });
  it('does not read load-driver --corpus (the recordings dir) as the task file', () => {
    expect(corpusFileFromArgv(['node', 'load-driver.ts', '--corpus', '/tmp/recordings'])).toBe(CORPUS_FILE);
  });
  it('refuses --tasks-file with no path instead of silently using the shipped corpus', () => {
    expect(() => corpusFileFromArgv(['node', 'x', '--tasks-file'])).toThrow(/needs a path/);
    expect(() => corpusFileFromArgv(['node', 'x', '--tasks-file', '--cli'])).toThrow(/needs a path/);
  });
});

describe('corpus manifest', () => {
  const corpus = loadCorpus();
  it('pins every repo to a full commit sha and gives every task a known repo and profile', () => {
    for (const repo of Object.values(corpus.repos)) expect(repo.sha).toMatch(/^[0-9a-f]{40}$/);
    for (const t of corpus.tasks) {
      expect(corpus.repos[t.repo]).toBeDefined();
      expect(corpus.timeoutSec[t.profile]).toBeGreaterThan(0);
    }
  });
  it('has unique task ids and covers light, typical and heavy on each repo', () => {
    expect(new Set(corpus.tasks.map((t) => t.id)).size).toBe(corpus.tasks.length);
    for (const repo of Object.keys(corpus.repos)) {
      const profiles = new Set(corpus.tasks.filter((t) => t.repo === repo).map((t) => t.profile));
      expect(profiles).toEqual(new Set(['light', 'typical', 'heavy']));
    }
  });
});

describe('recorded CLI environment', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    PAPERCUSP_SID: 'su-1',
    CLAUDE_CONFIG_DIR: '/psu/cfg',
    ANTHROPIC_API_KEY: 'sk-live',
    CODEX_HOME: '/psu/codex',
    OPENAI_API_KEY: 'sk-oa',
  };
  it('drops every agent/session variable so the CLI is customer-shaped', () => {
    expect(cleanEnv(base)).toEqual({ PATH: '/usr/bin', HOME: '/home/x' });
  });
  it('points claude at the proxy with the gateway bearer and a fresh config dir', () => {
    const env = claudeEnv(base, 'http://127.0.0.1:5000', '/tmp/cfg');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5000');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('papercusp-gateway');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PAPERCUSP_SID).toBeUndefined();
  });
  it('gives codex a single responses-wire provider at the proxy /v1', () => {
    const toml = codexConfigToml('http://127.0.0.1:5000');
    expect(toml).toContain('model_provider = "capture"');
    expect(toml).toContain('base_url = "http://127.0.0.1:5000/v1"');
    expect(toml).toContain('wire_api = "responses"');
  });
  it('runs codex non-interactively in the work dir and claude with bypassed permissions', () => {
    expect(cliArgs('codex', 'do it', '/w', 'sonnet')).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', '/w', 'do it']);
    expect(cliArgs('claude', 'do it', '/w', 'sonnet')).toContain('--dangerously-skip-permissions');
  });
});

describe('tool-call summary', () => {
  it('counts claude tool_use blocks by name', () => {
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }] } },
    ].map((l) => JSON.stringify(l));
    expect(summarizeToolCalls('claude', lines.join('\n') + '\nnot-json\n')).toEqual({ Bash: 2, Read: 1 });
  });
  it('counts codex completed items other than messages and reasoning', () => {
    const lines = [
      { type: 'item.completed', item: { type: 'reasoning' } },
      { type: 'item.completed', item: { type: 'command_execution' } },
      { type: 'item.started', item: { type: 'command_execution' } },
      { type: 'item.completed', item: { type: 'file_change' } },
      { type: 'item.completed', item: { type: 'agent_message' } },
    ].map((l) => JSON.stringify(l));
    expect(summarizeToolCalls('codex', lines.join('\n'))).toEqual({ command_execution: 1, file_change: 1 });
  });
});

describe('tool-outcome summary', () => {
  it('counts claude tool_result blocks and those marked is_error', () => {
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Exit code 2' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }, { type: 'text', text: 'not a result' }] } },
      { type: 'user', message: { content: 'plain prompt' } },
    ].map((l) => JSON.stringify(l));
    expect(summarizeToolOutcomes('claude', lines.join('\n') + '\nnot-json\n')).toEqual({ results: 2, errors: 1 });
  });
  it('counts codex completed tool items and those with status failed', () => {
    const lines = [
      { type: 'item.completed', item: { type: 'command_execution', status: 'failed', exit_code: 1 } },
      { type: 'item.completed', item: { type: 'command_execution', status: 'completed', exit_code: 0 } },
      { type: 'item.started', item: { type: 'command_execution', status: 'in_progress' } },
      { type: 'item.completed', item: { type: 'file_change', status: 'completed' } },
      { type: 'item.completed', item: { type: 'agent_message' } },
    ].map((l) => JSON.stringify(l));
    expect(summarizeToolOutcomes('codex', lines.join('\n'))).toEqual({ results: 3, errors: 1 });
  });
});

describe('sessionDiff', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

  it('captures committed, uncommitted and untracked changes against the pinned sha', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'session-diff-'));
    try {
      git(dir, 'init', '-q');
      writeFileSync(path.join(dir, 'committed.txt'), 'base\n');
      writeFileSync(path.join(dir, 'edited.txt'), 'base\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      writeFileSync(path.join(dir, 'committed.txt'), 'agent commit\n');
      git(dir, 'commit', '-qam', 'agent fix');
      writeFileSync(path.join(dir, 'edited.txt'), 'agent edit\n');
      writeFileSync(path.join(dir, 'new.test.ts'), 'agent test\n');

      // The old diff.patch (worktree vs index) loses the committed fix and the new file.
      expect(git(dir, 'diff')).not.toContain('agent commit');

      const patch = await sessionDiff(dir, base);
      expect(patch).toContain('+agent commit');
      expect(patch).toContain('+agent edit');
      expect(patch).toContain('+agent test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty patch instead of throwing when the directory is not a git checkout', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'session-diff-'));
    try {
      expect(await sessionDiff(dir, '0'.repeat(40))).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
