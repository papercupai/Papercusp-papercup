import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { forkCodexNativeHistory, prepareCodexForkHistory } from './su-session-codex-fork';
import type { RpcFrame } from './su-session-stdio-peer';

const dirs: string[] = [];
const PARENT = '11111111-1111-4111-8111-111111111111';
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'su-fork-')); dirs.push(root);
  const sourceHome = join(root, 'parent'), childHome = join(root, 'child');
  const historyDir = join(sourceHome, 'sessions', '2026', '10', '25');
  mkdirSync(historyDir, { recursive: true }); mkdirSync(childHome);
  const sourcePath = join(historyDir, `rollout-2026-${PARENT}.jsonl`);
  const history = JSON.stringify({ type: 'session_meta', payload: { id: PARENT } }) + '\n';
  writeFileSync(sourcePath, history);
  writeFileSync(join(sourceHome, 'config.toml'), 'model = "parent-only-config"');
  const childPath = join(childHome, 'rollout-child.jsonl');
  const request = vi.fn(async (frame: RpcFrame): Promise<RpcFrame> => {
    if (frame.method === 'thread/read') return { thread: { id: PARENT, turns: [
      { id: 'done', status: 'completed' }, { id: 'pending-question', status: 'inProgress' },
    ] } };
    writeFileSync(childPath, history);
    return { thread: { id: 'child-thread', forkedFromId: PARENT, path: childPath } };
  });
  return { root, sourcePath, history, sourceHome, childPath, childHome, request,
    input: { source: { backend: 'codex' as const, source: 'adv_sessions' as const,
      ownerId: 'parent-owner', codexHome: sourceHome, rolloutId: PARENT, exactResumeSupported: true, missingReason: null },
      peer: { request }, childOwnerId: 'child-owner', childHome,
      params: { cwd: root, model: 'selected-model', approvalPolicy: 'on-request', sandbox: 'workspace-write' } } };
}
describe('tracked Codex history fork', () => {
  it.each(['state_5.sqlite', 'thread_history_1.sqlite'])(
    'refuses existing %s before seeding or cleaning another native runtime', async name => {
      const f = fixture();
      const before = Buffer.from('existing native index must not be opened or changed');
      writeFileSync(join(f.childHome, name), before);
      await expect(prepareCodexForkHistory(f.input)).rejects.toThrow('requires fresh child native indexes');
      expect(readFileSync(join(f.childHome, name))).toEqual(before);
      expect(readdirSync(f.childHome)).toEqual([name]);
      expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.history);
    });
  it('removes refused fork metadata and history while preserving unrelated native threads', async () => {
    const f = fixture();
    const state = join(f.childHome, 'native-state'); mkdirSync(state);
    writeFileSync(join(f.childHome, 'config.toml'), `sqlite_home = ${JSON.stringify(state)}`);
    const prepared = await prepareCodexForkHistory(f.input);
    const metadata = new Database(join(state, 'state_99.sqlite'));
    const history = new Database(join(state, 'thread_history_1.sqlite'));
    try {
      metadata.exec('CREATE TABLE threads(id TEXT PRIMARY KEY); CREATE TABLE thread_dynamic_tools(thread_id TEXT REFERENCES threads(id), name TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT)');
      history.exec('CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT)');
      for (const id of [PARENT, 'refused-child', 'unrelated']) {
        metadata.prepare('INSERT INTO threads VALUES(?)').run(id);
        metadata.prepare('INSERT INTO thread_dynamic_tools VALUES(?, ?)').run(id, 'tool');
        metadata.prepare('INSERT INTO thread_spawn_edges VALUES(?, ?)').run(id, id);
        history.prepare('INSERT INTO thread_turns VALUES(?, ?)').run(id, 'turn');
      }
      await prepared.cleanup('refused-child');
      await prepared.cleanup('refused-child');
      expect(metadata.prepare('SELECT * FROM threads').all()).toEqual([{ id: 'unrelated' }]);
      expect(metadata.prepare('SELECT * FROM thread_dynamic_tools').all()).toEqual([{ thread_id: 'unrelated', name: 'tool' }]);
      expect(metadata.prepare('SELECT * FROM thread_spawn_edges').all()).toEqual([{ parent_thread_id: 'unrelated', child_thread_id: 'unrelated' }]);
      expect(history.prepare('SELECT * FROM thread_turns').all()).toEqual([{ thread_id: 'unrelated', turn_id: 'turn' }]);
      expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.history);
    } finally { metadata.close(); history.close(); }
  });
  it.each(['missing', 'cycle'] as const)('refuses %s ancestor history before creating a child seed', async kind => {
    const f = fixture();
    writeFileSync(f.sourcePath, JSON.stringify({ type: 'session_meta', payload: { id: PARENT,
      forked_from_id: kind === 'cycle' ? PARENT : '22222222-2222-4222-8222-222222222222' } }) + '\n');
    await expect(prepareCodexForkHistory(f.input)).rejects.toThrow(/ancestor history/);
    expect(readdirSync(f.childHome)).toEqual([]);
    expect(f.request).not.toHaveBeenCalled();
  });
  it('finds a completed boundary beyond the first native page', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ thread: { id: PARENT, historyMode: 'paginated', turns: [] } })
      .mockResolvedValueOnce({ data: [{ id: 'pending', status: 'inProgress' }], nextCursor: 'older' })
      .mockResolvedValueOnce({ data: [{ id: 'older-completed', status: 'completed' }], nextCursor: null });
    await forkCodexNativeHistory(f.input);
    expect(f.request.mock.calls[2][0]).toMatchObject({ method: 'thread/turns/list', params: { cursor: 'older' } });
    expect(f.request.mock.calls[3][0]).toMatchObject({ method: 'thread/fork', params: { lastTurnId: 'older-completed' } });
  });
  it('refuses repeated native history cursors without forking', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ thread: { id: PARENT, historyMode: 'paginated', turns: [] } })
      .mockResolvedValue({ data: [], nextCursor: 'repeated' });
    await expect(forkCodexNativeHistory(f.input)).rejects.toThrow('pagination did not advance');
    expect(f.request.mock.calls.every(([frame]) => frame.method !== 'thread/fork')).toBe(true);
  });
  it('snapshots only the declared thread, including uncheckpointed WAL history, into the configured child storage', async () => {
    const f = fixture();
    const parentState = join(f.sourceHome, 'native-state'), childState = join(f.childHome, 'native-state');
    mkdirSync(parentState); mkdirSync(childState);
    writeFileSync(join(f.sourceHome, 'config.toml'), `sqlite_home = ${JSON.stringify(parentState)}`);
    writeFileSync(join(f.childHome, 'config.toml'), `sqlite_home = ${JSON.stringify(childState)}`);
    writeFileSync(join(parentState, 'queue_1.sqlite'), 'parent queue must not cross');
    const db = new Database(join(parentState, 'thread_history_1.sqlite'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT)');
      const insert = db.prepare('INSERT INTO thread_turns VALUES(?,?,?)');
      insert.run(PARENT, 'completed-parent', 'completed');
      insert.run('unrelated-thread', 'secret-unrelated-turn', 'completed');
      const prepared = await prepareCodexForkHistory(f.input);
      const child = new Database(join(childState, 'thread_history_1.sqlite'));
      try {
        expect(child.prepare('SELECT * FROM thread_turns').all()).toEqual([
          { thread_id: PARENT, turn_id: 'completed-parent', status: 'completed' },
        ]);
        expect(readdirSync(childState)).not.toContain('queue_1.sqlite');
        child.prepare('INSERT INTO thread_turns VALUES(?,?,?)').run('new-child', 'own-turn', 'completed');
        await prepared.cleanup(); await prepared.cleanup();
        expect(child.prepare('SELECT thread_id FROM thread_turns').all()).toEqual([{ thread_id: 'new-child' }]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM thread_turns').get()).toEqual({ n: 2 });
      } finally { child.close(); }
    } finally { db.close(); }
  });
  it('refuses an existing child database before replacing any child history', async () => {
    const f = fixture();
    const db = new Database(join(f.sourceHome, 'thread_history_1.sqlite'));
    db.exec('CREATE TABLE thread_turns(thread_id TEXT)'); db.close();
    const childDb = join(f.childHome, 'thread_history_1.sqlite'); writeFileSync(childDb, 'existing-child');
    await expect(prepareCodexForkHistory(f.input)).rejects.toThrow();
    expect(readFileSync(childDb, 'utf8')).toBe('existing-child');
    expect(readdirSync(f.childHome)).toEqual(['thread_history_1.sqlite']);
  });
  it('forks only through a completed turn and retains the frozen ancestor needed by paginated history', async () => {
    const f = fixture(); await expect(forkCodexNativeHistory(f.input)).resolves.toMatchObject({ thread: { id: 'child-thread' } });
    expect(f.request.mock.calls[1][0]).toEqual({ method: 'thread/fork', params: {
      ...f.input.params, threadId: PARENT, ephemeral: false, lastTurnId: 'done',
    } });
    expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.history);
    expect(readdirSync(f.childHome)).not.toContain('config.toml');
    expect(readdirSync(join(f.childHome, 'sessions', '2026', '10', '25'))).toEqual([`rollout-2026-${PARENT}.jsonl`]);
  });
  it.each(['owner', 'home', 'missing-id', 'unpersisted'] as const)('refuses invalid fork authority before RPC (%s)', async mode => {
    const f = fixture();
    if (mode === 'owner') f.input.childOwnerId = 'parent-owner';
    if (mode === 'home') f.input.childHome = f.sourceHome;
    if (mode === 'missing-id') f.input.source.rolloutId = '';
    if (mode === 'unpersisted') f.input.source.exactResumeSupported = false;
    await expect(forkCodexNativeHistory(f.input)).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['same-id', 'wrong-parent', 'foreign-path', 'read-failure', 'pending-only', 'fork-failure'] as const)(
    'cleans the seed and preserves the parent on failure (%s)', async mode => {
      const f = fixture();
      if (mode === 'read-failure') f.request.mockRejectedValueOnce(new Error('read failed'));
      else if (mode === 'pending-only') f.request.mockResolvedValueOnce({ thread: { id: PARENT, turns: [{ id: 'pending', status: 'inProgress' }] } });
      else f.request.mockImplementationOnce(async () => ({ thread: { id: PARENT, turns: [{ id: 'done', status: 'completed' }] } }))
        .mockImplementationOnce(async () => {
          if (mode === 'fork-failure') throw new Error('fork failed');
          writeFileSync(f.childPath, f.history);
          return { thread: { id: mode === 'same-id' ? PARENT : 'child-thread',
            forkedFromId: mode === 'wrong-parent' ? 'foreign-parent' : PARENT,
            path: mode === 'foreign-path' ? f.sourcePath : f.childPath } };
        });
      await expect(forkCodexNativeHistory(f.input)).rejects.toThrow();
      expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.history);
      expect(readdirSync(join(f.childHome, 'sessions', '2026', '10', '25'))).toEqual([]);
    });
});
