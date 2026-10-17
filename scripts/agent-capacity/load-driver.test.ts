import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeChunk, type RecordedExchange } from './record-proxy';
import type { Corpus, SessionMeta } from './record-session';
import { startReplayServer } from './replay-server';
import { capacityCacheRoot } from './host-admission';
import { achievedConcurrency, checkParkedPlan, drive, loadMetas, nodeMajor, nodeMismatches, parseAgentEnv, replayPath, replayTimeoutMs, selectSessions, sessionFor, summarize, summarizeParked, toolOutcomesDiverge, versionMismatches, type ParkRelease } from './load-driver';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

vi.mock('./replay-server', async importOriginal => {
  const actual = await importOriginal<typeof import('./replay-server')>();
  return { ...actual, startReplayServer: vi.fn(actual.startReplayServer) };
});

describe('default corpus placement', () => {
  it('reads the shared-host data corpus by default and preserves an explicit corpus', () => {
    const read = vi.mocked(fs.readdirSync).mockReturnValueOnce([]).mockReturnValueOnce([]);
    try {
      expect(loadMetas()).toEqual([]);
      expect(read).toHaveBeenLastCalledWith(path.join(platform() === 'linux'
        ? '/mnt/data/agent-capacity' : path.join(homedir(), '.cache', 'agent-capacity'), 'corpus'));
      expect(loadMetas('/explicit/corpus')).toEqual([]);
      expect(read).toHaveBeenLastCalledWith('/explicit/corpus');
    } finally {
      read.mockReset();
    }
  });
});

describe('parseAgentEnv', () => {
  it('absent or blank is no extra env', () => {
    expect(parseAgentEnv(undefined)).toBeUndefined();
    expect(parseAgentEnv('  ')).toBeUndefined();
  });

  it('parses KEY=VALUE pairs separated by ";", keeping "=" inside a value and empty values', () => {
    expect(parseAgentEnv('PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE=papercusp-tsc-service;A=b=c;EMPTY=;')).toEqual({
      PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE: 'papercusp-tsc-service',
      A: 'b=c',
      EMPTY: '',
    });
  });

  it('refuses a pair with no key or a key that is not a variable name', () => {
    expect(() => parseAgentEnv('NOEQUALS')).toThrow(/expected KEY=VALUE/);
    expect(() => parseAgentEnv('=v')).toThrow(/expected KEY=VALUE/);
    expect(() => parseAgentEnv('1BAD=v')).toThrow(/expected KEY=VALUE/);
  });
});

// WI-10004672: the corpus profile limits gave each recording a different slowdown tolerance
// (286s recorded against 300s timed out under ANY slowdown), so the limit is relative.
describe('replayTimeoutMs', () => {
  it('allows every replay the same 3x slowdown, never less than 60s', () => {
    expect(replayTimeoutMs(286_090)).toBe(858_270);
    expect(replayTimeoutMs(598_292)).toBe(1_794_876);
    expect(replayTimeoutMs(5_000)).toBe(60_000);
  });
});

// WI-10004672: P-005 asked for 64 sessions and held about 13, and nothing noticed.
describe('achievedConcurrency', () => {
  const start = Date.parse('2026-10-01T00:00:00Z');
  const at = (offsetSec: number, wallSec: number) => ({ startedAt: new Date(start + offsetSec * 1000).toISOString(), wallMs: wallSec * 1000 });
  const window = { startMs: start, agents: 4, staggerMs: 1000, durationSec: 103 };

  it('counts sessions whose CLI is running, from the last stagger to the deadline', () => {
    // Window is [3s, 103s): four sessions spanning it hold 4; one gone at 53s halves its share.
    const full = [at(0, 200), at(1, 200), at(2, 200), at(3, 200)];
    expect(achievedConcurrency(full, window)).toEqual({ target: 4, mean: 4, max: 4, fraction: 1, windowSec: 100 });
    const half = [at(0, 200), at(1, 200), at(2, 200), at(3, 50)];
    expect(achievedConcurrency(half, window)).toMatchObject({ mean: 3.5, max: 4, fraction: 0.88 });
  });

  it('reads a slot stuck in setup as not running, so an underdriven step is visible', () => {
    // Two slots spend the whole window outside the CLI (setup): only 2 of 4 ever run.
    expect(achievedConcurrency([at(0, 200), at(1, 200)], window)).toMatchObject({ mean: 2, fraction: 0.5 });
  });

  it('has no window to judge when the stagger outlasts the duration', () => {
    expect(achievedConcurrency([at(0, 10)], { ...window, durationSec: 2 })).toBeNull();
  });
});

describe('replayPath', () => {
  const recorded = { sessionId: 'codex-x', env: { path: '/rec/bin:/usr/bin', node: 'v22.1.0' } };
  it('keeps the driver PATH by default and uses the recorded one only when asked', () => {
    expect(replayPath('inherit', '/vm/bin:/usr/bin', recorded)).toBe('/vm/bin:/usr/bin');
    expect(replayPath('recorded', '/vm/bin:/usr/bin', recorded)).toBe('/rec/bin:/usr/bin');
  });
  it('puts a pinned build first in either mode', () => {
    expect(replayPath('recorded', '/vm/bin', recorded, '/pin/codex-0.159.2')).toBe(`/pin/codex-0.159.2${path.delimiter}/rec/bin:/usr/bin`);
    expect(replayPath('inherit', undefined, recorded, '/pin')).toBe('/pin');
  });
  it('refuses recorded mode for a recording made before PATH capture, instead of silently inheriting', () => {
    expect(() => replayPath('recorded', '/vm/bin', { sessionId: 'old' })).toThrow(/no recorded PATH/);
  });
});

function meta(over: Omit<Partial<SessionMeta>, 'repo'> & { id: string; profile?: 'light' | 'typical' | 'heavy'; repo?: string }): SessionMeta {
  const repo = over.repo ?? 'r';
  return {
    sessionId: over.id,
    corpusVersion: 1,
    task: { id: 't1', repo, profile: over.profile ?? 'light', prompt: 'Do the thing.' },
    repo: { name: repo, sha: 'abc', kind: 'k' },
    cli: over.cli ?? 'claude',
    cliVersion: 'v',
    claudeModel: 'sonnet',
    startedAt: '2026-09-30T00:00:00Z',
    wallMs: over.wallMs ?? 100,
    exitCode: over.exitCode === undefined ? 0 : over.exitCode,
    timedOut: over.timedOut ?? false,
    exchanges: 2,
    toolCalls: {},
    diffBytes: 0,
  };
}

describe('selection and scheduling', () => {
  const metas = [
    meta({ id: 'claude-b', profile: 'typical' }),
    meta({ id: 'claude-a' }),
    meta({ id: 'codex-a', cli: 'codex' }),
    meta({ id: 'claude-failed', exitCode: 1 }),
    meta({ id: 'claude-timeout', timedOut: true }),
  ];

  it('filters by cli/profile, drops failed or timed-out recordings, and sorts by id', () => {
    expect(selectSessions(metas, 'cli=claude', undefined).map((m) => m.sessionId)).toEqual(['claude-a', 'claude-b']);
    expect(selectSessions(metas, 'profile=light', undefined).map((m) => m.sessionId)).toEqual(['claude-a', 'codex-a']);
    expect(selectSessions(metas, 'cli=claude,cli=codex,profile=light', undefined).map((m) => m.sessionId)).toEqual(['claude-a', 'codex-a']);
  });

  it('interleaves groups so every window of slots plays a representative mix, whatever N is (WI-10004579)', () => {
    const corpus: SessionMeta[] = [];
    for (const cli of ['claude', 'codex'] as const)
      for (const repo of ['exc', 'mea'])
        for (const profile of ['light', 'typical'] as const)
          for (let i = 1; i <= 4; i++) corpus.push(meta({ id: `${cli}-${repo}-${profile}-${i}`, cli, repo, profile }));
    const sel = selectSessions(corpus, undefined, undefined);
    expect(sel).toHaveLength(32);
    const key = (m: SessionMeta) => `${m.cli}|${m.repo.name}|${m.task.profile}`;
    // n8, first pass: one session from each of the 8 groups. The old sorted order gave 8 claude-exc.
    expect(new Set(Array.from({ length: 8 }, (_, s) => key(sessionFor(sel, s, 0)))).size).toBe(8);
    // n2 over a 10-pass window still reaches codex (sorted order needed index >= 16).
    const n2 = new Set<string>();
    for (let s = 0; s < 2; s++) for (let it = 0; it < 10; it++) n2.add(sessionFor(sel, s, it).cli);
    expect([...n2].sort()).toEqual(['claude', 'codex']);
    // Uneven groups: nothing dropped or duplicated.
    const uneven = selectSessions([...corpus.slice(0, 3), ...corpus.slice(16, 17)], undefined, undefined);
    expect(uneven.map((m) => m.sessionId).sort()).toEqual([...corpus.slice(0, 3), ...corpus.slice(16, 17)].map((m) => m.sessionId).sort());
  });

  it('takes explicit ids verbatim and rejects unknown ids or keys', () => {
    expect(selectSessions(metas, undefined, ['codex-a', 'claude-b']).map((m) => m.sessionId)).toEqual(['codex-a', 'claude-b']);
    expect(() => selectSessions(metas, undefined, ['nope'])).toThrow(/no recorded session/);
    expect(() => selectSessions(metas, 'model=x', undefined)).toThrow(/bad --select/);
  });

  it('round-robins sessions across slots and iterations', () => {
    const s = [meta({ id: 'a' }), meta({ id: 'b' }), meta({ id: 'c' })];
    expect([0, 1, 2, 3].map((slot) => sessionFor(s, slot, 0).sessionId)).toEqual(['a', 'b', 'c', 'a']);
    expect([0, 1, 2].map((it) => sessionFor(s, 1, it).sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('calls a replay tool-diverged when its tool results or failures differ from the recording', () => {
    expect(toolOutcomesDiverge({ results: 6, errors: 1 }, { results: 6, errors: 1 })).toBe(false);
    expect(toolOutcomesDiverge({ results: 6, errors: 0 }, { results: 6, errors: 1 })).toBe(true);
    expect(toolOutcomesDiverge({ results: 6, errors: 0 }, { results: 5, errors: 0 })).toBe(true);
    // No recorded CLI log: nothing to compare against.
    expect(toolOutcomesDiverge(null, { results: 5, errors: 2 })).toBe(false);
  });

  it('names each CLI whose installed build is not one the sessions were recorded with', () => {
    const sessions = [
      { cli: 'claude' as const, cliVersion: '2.1.284 (Claude Code)' },
      { cli: 'codex' as const, cliVersion: 'codex-cli 0.159.2' },
      { cli: 'codex' as const, cliVersion: 'codex-cli 0.159.2' },
    ];
    const installed = (v: Record<string, string>) => (cli: string) => v[cli] ?? 'missing';
    expect(versionMismatches(sessions, installed({ claude: '2.1.284 (Claude Code)', codex: 'codex-cli 0.159.2' }))).toEqual([]);
    expect(versionMismatches(sessions, installed({ claude: '2.1.284 (Claude Code)', codex: 'codex-cli 0.157.1' }))).toEqual([
      { cli: 'codex', have: 'codex-cli 0.157.1', want: ['codex-cli 0.159.2'] },
    ]);
    expect(versionMismatches(sessions, installed({ codex: 'codex-cli 0.159.2' }))).toEqual([
      { cli: 'claude', have: 'missing', want: ['2.1.284 (Claude Code)'] },
    ]);
  });
});

// WI-10004683: recordings made on the tower's Node 25 (no bundled corepack) diverged on a Node 24
// VM, where `command -v corepack` succeeds. The driver now compares node majors as well.
describe('nodeMismatches', () => {
  it('parses a node major and rejects what does not parse', () => {
    expect(nodeMajor('v25.9.0')).toBe(25);
    expect(nodeMajor('24.18.1\n')).toBe(24);
    expect(nodeMajor('missing')).toBeNull();
    expect(nodeMajor(null)).toBeNull();
  });

  it('flags a recorded major the replay host does not match, and counts sessions it cannot check', () => {
    const sessions = [{ env: { path: null, node: 'v25.9.0' } }, { env: { path: null, node: 'v25.8.1' } }, {}];
    expect(nodeMismatches(sessions, 'v25.1.0')).toEqual({ have: 'v25.1.0', want: [], unchecked: 1 });
    expect(nodeMismatches(sessions, 'v24.18.1')).toEqual({ have: 'v24.18.1', want: ['v25.9.0', 'v25.8.1'], unchecked: 1 });
    expect(nodeMismatches(sessions, 'missing').want).toEqual(['v25.9.0', 'v25.8.1']);
    expect(nodeMismatches([{}], 'v24.18.1')).toEqual({ have: 'v24.18.1', want: [], unchecked: 1 });
  });
});

// cgroup accounting and event-loop hygiene: session-process.test.ts (shared with record-session).

describe('drive (end to end with a fake CLI)', () => {
  let root: string;
  const oldPath = process.env.PATH;

  // A stand-in `claude`: sends the requests a two-turn session would (2 then 4 messages),
  // plus one extra when FAKE_EXTRA=1 so the replay diverges; prints the -p prompt it got.
  // Like the real CLI it runs the tool calls it is streamed: each tool_use input (reassembled
  // from input_json_delta fragments) is a Write of `file_path`, reported as a stream-json
  // tool_result line that is_error when the write fails.
  const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const base = process.env.ANTHROPIC_BASE_URL;
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const results = [];
const runTools = (text) => {
  const inputs = {};
  for (const line of text.split('\\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const j = JSON.parse(line.slice(6));
      if (j.type === 'content_block_delta' && j.delta.type === 'input_json_delta') inputs[j.index] = (inputs[j.index] || '') + j.delta.partial_json;
    } catch {}
  }
  for (const s of Object.values(inputs)) {
    const { file_path } = JSON.parse(s);
    let is_error = false, content = file_path;
    try { fs.writeFileSync(file_path, 'x'); } catch (e) { is_error = true; content = e.code; }
    results.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error, content }] } }));
  }
};
const call = async (n) => {
  const r = await fetch(base + '/v1/messages?beta=true', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', stream: true, messages: Array(n).fill({}), tools: Array(20).fill({}) }) });
  const text = await r.text();
  runTools(text);
  return [r.status, text];
};
(async () => {
  if (base.includes('/T-p')) await new Promise(r => setTimeout(r, Number(process.env.CAPDRV_PARK_SETUP_DELAY_MS ?? 0)));
  const out = [await call(2), await call(4)];
  if (process.env.FAKE_EXTRA === '1') out.push(await call(6));
  for (const l of results) console.log(l);
  console.log(JSON.stringify({ prompt, out, cfg: process.env.CLAUDE_CONFIG_DIR ? 'set' : 'unset', cwd: process.cwd(), agentVar: process.env.CAPDRV_AGENT_PROBE ?? null }));
  process.exit(out.every(([s]) => s === 200) ? 0 : 1);
})();
`;

  const corpus: Corpus = { version: 1, suffix: 'SUFFIX', timeoutSec: { light: 30, typical: 30, heavy: 30 }, repos: {}, tasks: [] };

  const exch = (seq: number, messages: number): RecordedExchange => ({
    seq,
    sessionId: 'claude-s1',
    startedAt: '2026-09-30T00:00:00Z',
    method: 'POST',
    path: '/v1/messages?beta=true',
    req: { bytes: 1, sha256: 'x', model: 'claude-sonnet-5-5', stream: true, messages, tools: 20 },
    status: 200,
    contentType: 'text/event-stream',
    ttfbMs: 0,
    totalMs: 0,
    resBytes: 0,
    chunks: [encodeChunk(0, Buffer.from(`data: reply-${seq}\n\n`))],
  });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'capdrv-e2e-'));
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(path.join(root, 'bin', 'claude'), FAKE);
    chmodSync(path.join(root, 'bin', 'claude'), 0o755);
    process.env.PATH = `${path.join(root, 'bin')}:${oldPath}`;
    mkdirSync(path.join(root, 'cache', 'prepared', 'r'), { recursive: true });
    writeFileSync(path.join(root, 'cache', 'prepared', 'r', 'README'), 'repo');
    mkdirSync(path.join(root, 'corpus', 'claude-s1'), { recursive: true });
    writeFileSync(path.join(root, 'corpus', 'claude-s1', 'exchanges.jsonl'), [exch(1, 4), exch(0, 2)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
  afterEach(() => {
    process.env.PATH = oldPath;
    delete process.env.FAKE_EXTRA;
    rmSync(root, { recursive: true, force: true });
  });

  const run = (agents: number) =>
    drive({
      cacheDir: path.join(root, 'cache'),
      agents,
      sessions: [meta({ id: 'claude-s1' })],
      corpus,
      corpusDir: path.join(root, 'corpus'),
      outDir: path.join(root, 'out'),
      runId: 'T',
      speed: 0,
      staggerMs: 0,
      durationSec: 0,
      isolation: 'none',
      keepWork: false,
    });

  it('replays one recording to N concurrent agents, each with its own state, and cleans up', async () => {
    const runs = await run(3);
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      expect(r).toMatchObject({ exitCode: 0, timedOut: false, diverged: false, served: { exact: 2, shape: 0, path: 0, exhausted: 0 } });
      const printed = JSON.parse(readFileSync(path.join(root, 'out', 'sessions', `${r.instance}.cli.jsonl`), 'utf8'));
      expect(printed.prompt).toBe('Do the thing.\n\nSUFFIX');
      expect(printed.cfg).toBe('set');
      expect(printed.out.map((o: [number, string]) => o[1])).toEqual(['data: reply-0\n\n', 'data: reply-1\n\n']);
      // The default private workdir, and no agent env unless one is passed.
      // (Already deleted by teardown, so compare paths, not realpaths.)
      expect(printed.cwd).toContain(path.join('cache', 'replay-work', 'T', 's'));
      expect(printed.agentVar).toBeNull();
    }
    expect(readFileSync(path.join(root, 'out', 'agents.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(readFileSync(path.join(root, 'out', 'served.jsonl'), 'utf8').trim().split('\n')).toHaveLength(6);
    expect(() => readFileSync(path.join(root, 'cache', 'replay-work', 'T', 's0-i0', 'README'))).toThrow();
    expect(summarize(runs)).toMatchObject({ runs: 3, clean: 3, failed: 0, diverged: 0, served: { exact: 6, exhausted: 0 } });
  });

  it.skipIf(platform() !== 'linux')('drives a private copy on the native default data device through the local CLI fixture', async () => {
    const cacheRoot = capacityCacheRoot(__dirname);
    expect(cacheRoot).toBe('/mnt/data/agent-capacity');
    expect(statSync(cacheRoot).dev).not.toBe(statSync('/').dev);
    const cacheDir = realpathSync(mkdtempSync(path.join(cacheRoot, 'drive-placement-')));
    const prepared = path.join(cacheDir, 'prepared', 'r');
    mkdirSync(prepared, { recursive: true });
    writeFileSync(path.join(prepared, 'README'), 'native prepared source');
    try {
      const [result] = await drive({
        cacheDir, agents: 1, sessions: [meta({ id: 'claude-s1' })], corpus,
        corpusDir: path.join(root, 'corpus'), outDir: path.join(root, 'out'), runId: 'N',
        speed: 0, staggerMs: 0, durationSec: 0, isolation: 'none', keepWork: true,
      });
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, diverged: false });
      const printed = JSON.parse(readFileSync(path.join(root, 'out', 'sessions', `${result!.instance}.cli.jsonl`), 'utf8'));
      const checkout = path.join(cacheDir, 'replay-work', 'N', 's0-i0');
      expect(realpathSync(printed.cwd)).toBe(realpathSync(checkout));
      expect(statSync(printed.cwd).dev).toBe(statSync(cacheRoot).dev);
      expect(readFileSync(path.join(checkout, 'README'), 'utf8')).toBe('native prepared source');
      writeFileSync(path.join(checkout, 'README'), 'private session write');
      expect(readFileSync(path.join(prepared, 'README'), 'utf8')).toBe('native prepared source');
      expect(statSync(path.join(cacheDir, 'replay-home', 'N', 's0-i0')).dev).toBe(statSync(cacheRoot).dev);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it.skipIf(platform() !== 'linux').each(['copy', 'overlay'] as const)('refuses a native root-backed %s at driver setup without replacing its destination or starting the CLI', async (workdir) => {
    const cacheDir = realpathSync(mkdtempSync(path.join(homedir(), '.capacity-drive-refusal-')));
    expect(statSync(cacheDir).dev).toBe(statSync('/').dev);
    const prepared = path.join(cacheDir, 'prepared', 'r');
    const checkout = path.join(cacheDir, 'replay-work', 'N', 's0-i0');
    mkdirSync(prepared, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(prepared, 'README'), 'prepared source');
    const sentinel = path.join(checkout, 'sentinel');
    writeFileSync(sentinel, 'existing root destination');
    const identity = statSync(sentinel);
    try {
      await expect(drive({
        cacheDir, agents: 1, sessions: [meta({ id: 'claude-s1' })], corpus,
        corpusDir: path.join(root, 'corpus'), outDir: path.join(root, 'out'), runId: 'N',
        speed: 0, staggerMs: 0, durationSec: 0, isolation: 'none', keepWork: false, workdir,
      })).rejects.toThrow(/refuse the root filesystem/);
      expect(readFileSync(sentinel, 'utf8')).toBe('existing root destination');
      expect(statSync(sentinel).ino).toBe(identity.ino);
      expect(existsSync(`${checkout}.ovl`)).toBe(false);
      expect(existsSync(path.join(cacheDir, 'replay-home'))).toBe(false);
      expect(existsSync(path.join(root, 'out', 'sessions'))).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('shared workdir: every session runs in the prepared checkout itself and gets the agent env', async () => {
    const prepared = path.join(root, 'cache', 'prepared', 'r');
    const runs = await drive({
      cacheDir: path.join(root, 'cache'),
      agents: 2,
      sessions: [meta({ id: 'claude-s1' })],
      corpus,
      corpusDir: path.join(root, 'corpus'),
      outDir: path.join(root, 'out'),
      runId: 'W',
      speed: 0,
      staggerMs: 0,
      durationSec: 0,
      isolation: 'none',
      keepWork: false,
      workdir: 'shared',
      agentEnv: { CAPDRV_AGENT_PROBE: 'on' },
    });
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect(r).toMatchObject({ exitCode: 0, timedOut: false, diverged: false });
      const printed = JSON.parse(readFileSync(path.join(root, 'out', 'sessions', `${r.instance}.cli.jsonl`), 'utf8'));
      expect(realpathSync(printed.cwd)).toBe(realpathSync(prepared));
      expect(printed.agentVar).toBe('on');
    }
    // Teardown leaves the shared tree in place and never makes a per-session copy.
    expect(readFileSync(path.join(prepared, 'README'), 'utf8')).toBe('repo');
    expect(existsSync(path.join(root, 'cache', 'replay-work', 'W'))).toBe(false);
  });

  it('sweep runs every selected session exactly once across the slots', async () => {
    for (const id of ['claude-s2', 'claude-s3']) {
      mkdirSync(path.join(root, 'corpus', id), { recursive: true });
      writeFileSync(path.join(root, 'corpus', id, 'exchanges.jsonl'), readFileSync(path.join(root, 'corpus', 'claude-s1', 'exchanges.jsonl')));
    }
    const runs = await drive({
      cacheDir: path.join(root, 'cache'),
      agents: 2,
      sessions: ['claude-s1', 'claude-s2', 'claude-s3'].map((id) => meta({ id })),
      corpus,
      corpusDir: path.join(root, 'corpus'),
      outDir: path.join(root, 'out'),
      runId: 'S',
      speed: 0,
      staggerMs: 0,
      durationSec: 3600,
      isolation: 'none',
      keepWork: false,
      sweep: true,
    });
    expect(runs.map((r) => r.sessionId).sort()).toEqual(['claude-s1', 'claude-s2', 'claude-s3']);
    expect(new Set(runs.map((r) => r.slot))).toEqual(new Set([0, 1]));
    expect(summarize(runs)).toMatchObject({ runs: 3, clean: 3, diverged: 0, served: { exact: 6, exhausted: 0 } });
  });

  it('flags a replay that ran past its recording as diverged and failed', async () => {
    process.env.FAKE_EXTRA = '1';
    const [r] = await run(1);
    expect(r).toMatchObject({ exitCode: 1, diverged: true, served: { exact: 2, exhausted: 1 } });
    expect(summarize([r])).toMatchObject({ clean: 0, failed: 1, diverged: 1 });
  });

  describe('a recording whose tool call names its own absolute checkout path', () => {
    // The recorded session ran in recWork and its Write named `${recWork}/out.txt`, streamed
    // as two input_json_delta fragments that split the path.
    let recWork: string;
    const writeRecording = (recordedToolError: boolean) => {
      const input = JSON.stringify({ file_path: `${recWork}/out.txt` });
      const cut = input.indexOf(recWork) + 10;
      const delta = (pj: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: pj } })}\n\n`;
      const toolTurn = { ...exch(0, 2), chunks: [encodeChunk(0, Buffer.from(delta(input.slice(0, cut)))), encodeChunk(3, Buffer.from(delta(input.slice(cut))))] };
      const dir = path.join(root, 'corpus', 'claude-s1');
      writeFileSync(path.join(dir, 'exchanges.jsonl'), [toolTurn, exch(1, 4)].map((e) => JSON.stringify(e)).join('\n') + '\n');
      writeFileSync(path.join(dir, 'cli.jsonl'), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: recordedToolError, content: 'ok' }] } }) + '\n');
    };
    const runWith = (workDir: string) =>
      drive({
        cacheDir: path.join(root, 'cache'),
        agents: 1,
        sessions: [{ ...meta({ id: 'claude-s1' }), workDir }],
        corpus,
        corpusDir: path.join(root, 'corpus'),
        outDir: path.join(root, 'out'),
        runId: 'W',
        speed: 0,
        staggerMs: 0,
        durationSec: 0,
        isolation: 'none',
        keepWork: true,
      });
    const toolResults = (instance: string) =>
      readFileSync(path.join(root, 'out', 'sessions', `${instance}.cli.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((j) => j.type === 'user')
        .map((j) => j.message.content[0]);

    beforeEach(() => {
      recWork = path.join(root, 'rec-work', 'claude-s1-20261001T003519');
    });

    it('rewrites the path so the replayed tool writes into the replay checkout, matching the recording', async () => {
      writeRecording(false);
      const [r] = await runWith(recWork);
      const replayWork = path.join(root, 'cache', 'replay-work', 'W', 's0-i0');
      expect(toolResults(r.instance)).toEqual([{ type: 'tool_result', is_error: false, content: `${replayWork}/out.txt` }]);
      expect(readFileSync(path.join(replayWork, 'out.txt'), 'utf8')).toBe('x');
      expect(r).toMatchObject({
        exitCode: 0,
        served: { exact: 2, exhausted: 0 },
        toolOutcomes: { recorded: { results: 1, errors: 0 }, replayed: { results: 1, errors: 0 } },
        toolDiverged: false,
        diverged: false,
      });
      const served = readFileSync(path.join(root, 'out', 'served.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(served.map((s) => s.rewritten)).toEqual([true, false]);
    });

    it('flags the replay diverged when its tool failed where the recording succeeded, though every request matched exact', async () => {
      // The meta names the wrong checkout, so nothing is rewritten and the Write targets the
      // recording's directory, which does not exist here: the bug this check exists to catch.
      writeRecording(false);
      const [r] = await runWith(path.join(root, 'elsewhere'));
      expect(toolResults(r.instance)).toEqual([{ type: 'tool_result', is_error: true, content: 'ENOENT' }]);
      expect(r).toMatchObject({
        exitCode: 0,
        served: { exact: 2, shape: 0, path: 0, exhausted: 0 },
        toolOutcomes: { recorded: { results: 1, errors: 0 }, replayed: { results: 1, errors: 1 } },
        toolDiverged: true,
        diverged: true,
      });
      expect(summarize([r])).toMatchObject({ clean: 0, diverged: 1, toolDiverged: 1 });
    });
  });

  it.each([0, 1200])('parked (P-015): sessions wait for one shared release and finish intact with %i ms CLI setup', async (setupDelayMs) => {
    let release: ParkRelease | null = null;
    let releaseNow: (() => void) | undefined;
    const completed: Awaited<ReturnType<typeof drive>> = [];
    // Keep real HTTP, child processes, and elapsed-time measurements. Capture only the driver's
    // release timer so setup speed cannot decide whether either parked reply was actually held.
    const realSetTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(callback, ms, ...args);
      if (ms === 30_000) releaseNow = () => {
        clearTimeout(handle);
        callback(...args);
      };
      return handle;
    }) as typeof setTimeout);
    const driving = drive({
      cacheDir: path.join(root, 'cache'),
      agents: 1,
      sessions: [meta({ id: 'claude-s1' })],
      corpus,
      corpusDir: path.join(root, 'corpus'),
      outDir: path.join(root, 'out'),
      runId: 'T',
      speed: 0,
      staggerMs: 0,
      durationSec: 0,
      isolation: 'none',
      keepWork: false,
      parked: { agents: 2, atRequest: 2, releaseAtSec: 30 },
      agentEnv: { CAPDRV_PARK_SETUP_DELAY_MS: String(setupDelayMs) },
      onRun: (r) => completed.push(r),
      onRelease: (e) => (release = e),
    });
    let runs: Awaited<typeof driving>;
    try {
      const server = await vi.mocked(startReplayServer).mock.results.at(-1)!.value;
      await vi.waitFor(() => {
        expect(server.held()).toBe(2);
        expect(completed.map((r) => r.instance)).toEqual(['T-s0-i0']);
        expect(releaseNow).toBeTypeOf('function');
        expect(release).toBeNull();
      }, { timeout: 10_000, interval: 10 });
      releaseNow!();
      runs = await driving;
    } catch (error) {
      releaseNow?.();
      await driving;
      throw error;
    } finally {
      timer.mockRestore();
    }
    const active = runs.filter((r) => !r.parked);
    const parked = runs.filter((r) => r.parked);
    expect(active.map((r) => r.instance)).toEqual(['T-s0-i0']);
    expect(parked.map((r) => r.instance).sort()).toEqual(['T-p0-i0', 'T-p1-i0']);
    for (const r of runs) expect(r).toMatchObject({ exitCode: 0, timedOut: false, diverged: false, served: { exact: 2, exhausted: 0 } });
    // The active session finished before the release; each parked one sat on
    // its 2nd reply and finished only after it, with the reply intact.
    expect(release).toMatchObject({ held: 2, parked: 2 });
    const releasedAt = Date.parse((release as unknown as ParkRelease).at);
    const endOf = (r: (typeof runs)[number]) => Date.parse(r.startedAt) + r.wallMs;
    expect(endOf(active[0])).toBeLessThan(releasedAt);
    for (const r of parked) {
      expect(endOf(r)).toBeGreaterThanOrEqual(releasedAt - 5);
      const printed = JSON.parse(readFileSync(path.join(root, 'out', 'sessions', `${r.instance}.cli.jsonl`), 'utf8'));
      expect(printed.out.map((o: [number, string]) => o[1])).toEqual(['data: reply-0\n\n', 'data: reply-1\n\n']);
    }
    const served = readFileSync(path.join(root, 'out', 'served.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { instance: string; seq: number; heldMs?: number });
    const held = served.filter((s) => s.heldMs !== undefined);
    expect(held.map((s) => [s.instance, s.seq]).sort()).toEqual([['T-p0-i0', 1], ['T-p1-i0', 1]]);
    // heldMs starts at request arrival, not at drive() startup; there is no fixed lower bound.
    for (const s of held) expect(s.heldMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(path.join(root, 'out', 'parked.jsonl'), 'utf8')).toContain('"event":"release"');
    expect(summarizeParked(runs, release)).toMatchObject({ runs: 2, heldAtRelease: 2, failed: 0 });
    expect(summarize(active)).toMatchObject({ runs: 1, clean: 1, failed: 0 });
  });
});

describe('checkParkedPlan (P-015)', () => {
  it('returns the claude sessions to park, or none without a plan', () => {
    const s = [meta({ id: 'claude-a' }), meta({ id: 'codex-b', cli: 'codex' })];
    expect(checkParkedPlan(undefined, s, 600)).toEqual([]);
    expect(checkParkedPlan({ agents: 0, atRequest: 4, releaseAtSec: 1 }, s, 600)).toEqual([]);
    expect(checkParkedPlan({ agents: 3, atRequest: 4, releaseAtSec: 360 }, s, 600).map((m) => m.sessionId)).toEqual(['claude-a']);
  });

  it('refuses a plan that cannot run: no claude session, a bad hold point, or a release after the step ends', () => {
    expect(() => checkParkedPlan({ agents: 2, atRequest: 4, releaseAtSec: 60 }, [meta({ id: 'codex-b', cli: 'codex' })], 600)).toThrow(/claude/);
    expect(() => checkParkedPlan({ agents: 2, atRequest: 0, releaseAtSec: 60 }, [meta({ id: 'claude-a' })], 600)).toThrow(/park-at-request/);
    expect(() => checkParkedPlan({ agents: 2, atRequest: 4, releaseAtSec: 600 }, [meta({ id: 'claude-a' })], 600)).toThrow(/inside --duration-sec/);
  });
});
