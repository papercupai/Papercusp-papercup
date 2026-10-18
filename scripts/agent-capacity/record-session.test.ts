import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { claudeEnv, cleanEnv, cliArgs, codexConfigToml, codexSelectionFromArgv, CORPUS_FILE, corpusFileFromArgv, loadCorpus, recordedWorkDir, recordingLimitFromArgv, sessionDiff, summarizeToolCalls, summarizeToolOutcomes } from './record-session';
import { capacityCacheRoot } from './host-admission';

describe('batch recording request allowance', () => {
  const selection = { model: 'gpt-6-luna', effort: 'low' as const };
  it('requires explicit Codex binding and preserves legacy absence', () => {
    expect(recordingLimitFromArgv([], 'codex')).toBeUndefined();
    expect(recordingLimitFromArgv(['--max-model-requests', '20'], 'codex', selection)?.snapshot())
      .toEqual({ ...selection, maxRequests: 20, admitted: 0, denied: 0 });
    expect(() => recordingLimitFromArgv(['--max-model-requests', '20'], 'codex')).toThrow(/explicit Codex/);
    expect(() => recordingLimitFromArgv(['--max-model-requests', '20'], 'claude', selection)).toThrow(/explicit Codex/);
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '--tasks', ''])('rejects an invalid allowance %j before sessions start', (value) => {
    expect(() => recordingLimitFromArgv(['--max-model-requests', value], 'codex', selection)).toThrow();
  });
  it('requires a batch allowance for byte limits and retains both in the saved snapshot', () => {
    expect(() => recordingLimitFromArgv(['--max-request-bytes', '65536'], 'codex', selection)).toThrow(/requires --max-model-requests/);
    expect(recordingLimitFromArgv(['--max-model-requests', '20', '--max-request-bytes', '65536'], 'codex', selection)?.snapshot())
      .toEqual({ ...selection, maxRequests: 20, maxRequestBytes: 65536, admitted: 0, denied: 0 });
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '--tasks', ''])('rejects an invalid byte allowance %j before sessions start', (value) => {
    expect(() => recordingLimitFromArgv(['--max-model-requests', '20', '--max-request-bytes', value], 'codex', selection)).toThrow();
  });
});

describe('default recording placement', () => {
  it('places shared-host recording checkouts on data and preserves an explicit cache', () => {
    const root = platform() === 'linux'
      ? '/mnt/data/agent-capacity' : path.join(homedir(), '.cache', 'agent-capacity');
    expect(recordedWorkDir('placement-control')).toBe(path.join(root, 'work', 'placement-control'));
    expect(recordedWorkDir('placement-control', '/explicit/cache'))
      .toBe('/explicit/cache/work/placement-control');
  });

  it.skipIf(platform() !== 'linux')('uses the real recorder CLI default data checkout before starting the local CLI fixture', () => {
    const cache = capacityCacheRoot(__dirname);
    expect(cache).toBe('/mnt/data/agent-capacity');
    expect(statSync('/mnt/data').dev).not.toBe(statSync('/').dev);
    const preparedRoot = path.join(cache, 'prepared');
    mkdirSync(preparedRoot, { recursive: true });
    const prepared = realpathSync(mkdtempSync(path.join(preparedRoot, 'recorder-cli-')));
    const repo = path.basename(prepared);
    const taskId = repo;
    const fixture = mkdtempSync(path.join(tmpdir(), 'recorder-cli-fixture-'));
    const bin = path.join(fixture, 'bin');
    const out = path.join(fixture, 'recordings');
    mkdirSync(bin);
    writeFileSync(path.join(prepared, 'README'), 'prepared recorder source');
    const sha = 'a'.repeat(40);
    // Only Git metadata and the model CLI are fixtures. The recorder entrypoint,
    // storage admission, native cp, process cwd and filesystem writes are real.
    writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env node\n' +
      `if (process.argv.includes('rev-parse')) console.log('${sha}');\n`);
    writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('local-placement-fixture'); process.exit(0); }
const placement = { cwd: process.cwd(), device: fs.statSync('.').dev, before: fs.readFileSync('README', 'utf8') };
fs.writeFileSync('README', 'private recorder write');
placement.after = fs.readFileSync('README', 'utf8');
console.log(JSON.stringify(placement));
`);
    chmodSync(path.join(bin, 'git'), 0o755);
    chmodSync(path.join(bin, 'claude'), 0o755);
    const tasks = path.join(fixture, 'tasks.json');
    writeFileSync(tasks, JSON.stringify({ version: 1, suffix: '',
      timeoutSec: { light: 5, typical: 5, heavy: 5 },
      repos: { [repo]: { sha, kind: 'test' } },
      tasks: [{ id: taskId, repo, profile: 'light', prompt: 'Measure local placement.' }],
    }));
    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'record-session.ts'),
        '--tasks-file', tasks, '--cli', 'claude', '--tasks', taskId,
        '--isolation', 'none', '--out', out, '--keep-work', '--upstream', 'http://127.0.0.1:1'], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, NODE_OPTIONS: '', PC_HEAVY_BYPASS: '1' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const sessions = readdirSync(out);
      expect(sessions).toHaveLength(1);
      const session = path.join(out, sessions[0]!);
      const meta = JSON.parse(readFileSync(path.join(session, 'meta.json'), 'utf8'));
      expect(meta).toMatchObject({ exitCode: 0, timedOut: false, exchanges: 0 });
      expect(meta.workDir).toBe(path.join(cache, 'work', meta.sessionId));
      expect(statSync(meta.workDir).dev).toBe(statSync('/mnt/data').dev);
      expect(statSync(meta.workDir).dev).not.toBe(statSync('/').dev);
      expect(JSON.parse(readFileSync(path.join(session, 'cli.jsonl'), 'utf8'))).toEqual({
        cwd: meta.workDir, device: statSync('/mnt/data').dev,
        before: 'prepared recorder source', after: 'private recorder write',
      });
      expect(readFileSync(path.join(prepared, 'README'), 'utf8')).toBe('prepared recorder source');
      expect(existsSync(path.join(cache, 'cli-home', meta.sessionId))).toBe(false);
    } finally {
      // Clean only this fresh task's paths, including a child failure before meta.
      for (const parent of ['work', 'cli-home']) {
        const dir = path.join(cache, parent);
        if (existsSync(dir)) for (const name of readdirSync(dir)) {
          if (name.startsWith(`claude-${taskId}-`)) rmSync(path.join(dir, name), { recursive: true, force: true });
        }
      }
      rmSync(prepared, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

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
  it('writes explicit requested model/effort as root TOML settings for a corpus run', () => {
    const selection = codexSelectionFromArgv(['--cli', 'codex', '--codex-model', 'gpt-6-luna', '--codex-effort', 'low']);
    const parsed = JSON.parse(execFileSync('python3', ['-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], {
      input: codexConfigToml('http://127.0.0.1:5000', selection), encoding: 'utf8',
    }));
    expect(selection).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(parsed).toMatchObject({ model: 'gpt-6-luna', model_reasoning_effort: 'low', model_provider: 'capture' });
    expect(parsed.model_providers.capture).not.toHaveProperty('model');
  });
  it('keeps legacy selections unknown instead of inventing a model or effort', () => {
    expect(codexSelectionFromArgv(['--cli', 'codex'])).toBeUndefined();
    expect(codexConfigToml('http://127.0.0.1:5000')).not.toMatch(/^model(?:_reasoning_effort)? =/m);
  });
  it.each([
    ['--codex-model', 'gpt-6-luna'],
    ['--codex-effort', 'low'],
    ['--codex-model', '--codex-effort', 'low'],
    ['--codex-model', 'gpt-6-luna', '--codex-effort'],
    ['--codex-model', 'gpt-6-luna', '--codex-effort', 'typo'],
    ['--codex-model', 'gpt-6-luna\n[features]', '--codex-effort', 'low'],
  ])('refuses incomplete or invalid explicit Codex settings: %j', (...argv) => {
    expect(() => codexSelectionFromArgv(argv)).toThrow(/Codex|codex/);
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
