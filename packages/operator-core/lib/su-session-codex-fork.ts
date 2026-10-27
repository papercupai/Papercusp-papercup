/** Native history is the only state copied into a new tracked Codex runtime.
 * Claims, callbacks, commands and wake registrations stay with the parent. */
import { constants, createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { parse } from '@iarna/toml';
import type { CodexNativeSessionHandle } from './native-session-handles';
import { findCodexRolloutPathByUuid } from './session-transcript-resolvers';
import type { RpcFrame, SuStdioPeer } from './su-session-stdio-peer';

function record(value: unknown): RpcFrame {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RpcFrame : {};
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

interface HistoryInput {
  source: CodexNativeSessionHandle;
  childOwnerId: string;
  childHome: string;
}
export interface PreparedCodexForkHistory {
  sourceId: string;
  childHome: string;
  retain(): void;
  cleanup(unregisteredChildId?: string): Promise<void>;
}

const HISTORY_TABLES = ['thread_turns', 'thread_items', 'thread_history_projection_state', 'thread_realtime_items'];
function sqliteHome(home: string): string {
  const configPath = join(home, 'config.toml');
  const configured = existsSync(configPath) ? parse(readFileSync(configPath, 'utf8')).sqlite_home : undefined;
  if (configured === undefined) return home;
  if (typeof configured !== 'string' || !isAbsolute(configured)) throw new Error('Codex fork requires an absolute native sqlite_home');
  return configured;
}

/** Take one read transaction, including WAL rows, without opening the source for
 * writing. Only this thread's history and native schema migrations cross homes.
 * Never copy state/queue/goal databases, configuration, callbacks or writer locks. */
function historySnapshot(path: string, threadIds: string[]): Buffer {
  const source = new Database(path, { readonly: true, fileMustExist: true });
  const snapshot = new Database(':memory:');
  try {
    return source.transaction(() => {
      const schema = source.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string; sql: string }>;
      if (!schema.some(row => row.name === 'thread_turns') || schema.some(row => ![...HISTORY_TABLES, '_sqlx_migrations'].includes(row.name))) {
        throw new Error('Codex fork native history schema is unsupported');
      }
      for (const table of schema) {
        snapshot.exec(table.sql);
        const rows = source.prepare(`SELECT * FROM "${table.name}"${table.name === '_sqlx_migrations' ? '' : ` WHERE thread_id IN (${threadIds.map(() => '?').join(',')})`}`).raw()
          .all(...(table.name === '_sqlx_migrations' ? [] : threadIds)) as Array<Array<unknown>>;
        if (rows.length) {
          const insert = snapshot.prepare(`INSERT INTO "${table.name}" VALUES (${rows[0].map(() => '?').join(',')})`);
          for (const row of rows) insert.run(...row);
        }
      }
      for (const index of source.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ sql: string }>) {
        snapshot.exec(index.sql);
      }
      return snapshot.serialize();
    })();
  } finally { snapshot.close(); source.close(); }
}

async function ancestorId(path: string, expectedId: string): Promise<string | null> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const row = record(JSON.parse(line)), meta = record(row.payload);
      if (row.type !== 'session_meta' || meta.id !== expectedId) throw new Error('Codex fork history metadata identity mismatch');
      if (meta.forked_from_id == null) return null;
      if (typeof meta.forked_from_id !== 'string' || !meta.forked_from_id) throw new Error('Codex fork ancestor identity is invalid');
      return meta.forked_from_id;
    }
    throw new Error('Codex fork history metadata is absent');
  } finally { lines.close(); stream.destroy(); }
}

/** Complete the history transfer BEFORE the child app-server opens its SQLite
 * connections. A rollout alone is insufficient for paginated native threads. */
export async function prepareCodexForkHistory(input: HistoryInput): Promise<PreparedCodexForkHistory> {
  const { source } = input;
  if (!source.ownerId || source.ownerId === input.childOwnerId || !source.rolloutId
    || !source.exactResumeSupported) throw new Error('Codex fork requires a distinct tracked parent identity');
  const [sourceHome, childHome] = await Promise.all([realpath(source.codexHome), realpath(input.childHome)]);
  if (sourceHome === childHome) throw new Error('Codex fork requires a fresh child home');
  const sourceSessions = join(sourceHome, 'sessions');
  const history: Array<{ id: string; path: string; seed: string }> = [];
  let ancestor: string | null = source.rolloutId;
  // A fork of a fork still needs every immutable ancestor referenced by native
  // paginated history. Resolve only this chain; unrelated conversations stay out.
  while (ancestor) {
    if (history.some(row => row.id === ancestor)) throw new Error('Codex fork ancestor history contains a cycle');
    const path = await findCodexRolloutPathByUuid(ancestor, { homeOverride: sourceHome });
    if (!path || !(await lstat(path)).isFile() || !inside(sourceSessions, await realpath(path))) {
      throw new Error('Codex fork parent or ancestor history is unavailable');
    }
    history.push({ id: ancestor, path, seed: join(childHome, 'sessions', relative(sourceSessions, await realpath(path))) });
    ancestor = await ancestorId(path, ancestor);
  }
  const sourceDb = join(sqliteHome(sourceHome), 'thread_history_1.sqlite');
  const childState = sqliteHome(childHome), childDb = join(childState, 'thread_history_1.sqlite');
  const sourceState = await realpath(dirname(sourceDb));
  await mkdir(childState, { recursive: true });
  if (sourceState === await realpath(childState)) throw new Error('Codex fork requires independent native history storage');
  // Refuse before creating seeds or entering their cleanup scope: existing
  // native indexes belong to another runtime and must remain byte-identical.
  if ((await readdir(childState)).some(name => /^(?:state_\d+|thread_history_1)\.sqlite(?:-(?:wal|shm))?$/.test(name))) {
    throw new Error('Codex fork requires fresh child native indexes');
  }
  // Snapshot the index first; the subsequently copied append-only rollouts must
  // include at least the bytes indexed by this consistent read transaction.
  const snapshot = existsSync(sourceDb) ? historySnapshot(sourceDb, history.map(row => row.id)) : null;
  let cleaned = false, retained = false;
  const seeds: string[] = [];
  const cleanup = async (unregisteredChildId?: string) => {
    if (cleaned || retained) return;
    const ids = [...history.map(row => row.id), ...(unregisteredChildId ? [unregisteredChildId] : [])];
    try {
      if (existsSync(childDb)) {
        const db = new Database(childDb, { fileMustExist: true });
        try { db.transaction(() => {
          for (const name of HISTORY_TABLES) {
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) {
              for (const id of ids) db.prepare(`DELETE FROM "${name}" WHERE thread_id = ?`).run(id);
            }
          }
        })(); } finally { db.close(); }
      }
      // thread/read and thread/fork also register metadata outside the history
      // database. The native writer must be closed before this cleanup runs.
      // Remove only the failed fork's identities from the child's own storage;
      // unrelated threads and the parent's databases are never opened for writes.
      for (const name of (await readdir(childState)).filter(name => /^state_\d+\.sqlite$/.test(name))) {
        const db = new Database(join(childState, name), { fileMustExist: true });
        try {
          db.pragma('foreign_keys = ON');
          db.transaction(() => {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
            const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
            for (const table of tables.filter(table => table.name !== 'threads')) {
              const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as Array<{ name: string }>;
              const keys = columns.filter(column => ['thread_id', 'parent_thread_id', 'child_thread_id'].includes(column.name));
              if (!keys.length) continue;
              const remove = db.prepare(`DELETE FROM ${quote(table.name)} WHERE ${keys.map(key => `${quote(key.name)} = ?`).join(' OR ')}`);
              for (const id of ids) remove.run(...keys.map(() => id));
            }
            if (tables.some(table => table.name === 'threads')) {
              const remove = db.prepare('DELETE FROM threads WHERE id = ?');
              for (const id of ids) remove.run(id);
            }
          })();
        } finally { db.close(); }
      }
    } finally { for (const seed of seeds) await unlink(seed); cleaned = true; }
  };
  try {
    for (const row of history) {
      await mkdir(dirname(row.seed), { recursive: true });
      if (resolve(await realpath(dirname(row.seed))) !== resolve(dirname(row.seed))) {
        throw new Error('Codex fork seed directory must not redirect outside the child home');
      }
      await copyFile(row.path, row.seed, constants.COPYFILE_EXCL); seeds.push(row.seed);
    }
    if (snapshot) {
      await writeFile(childDb, snapshot, { flag: 'wx', mode: 0o600 });
    }
    return { sourceId: source.rolloutId, childHome, cleanup, retain: () => { retained = true; } };
  } catch (error) { await cleanup(); throw error; }
}

export async function forkCodexNativeHistory(input: HistoryInput & {
  peer: Pick<SuStdioPeer, 'request'>;
  prepared?: PreparedCodexForkHistory;
  params: RpcFrame;
  /** Tracked bootstrap retains ancestry only after lineage registration. */
  retainHistory?: boolean;
}): Promise<RpcFrame> {
  const { source, peer } = input;
  if (!source.ownerId || source.ownerId === input.childOwnerId || !source.rolloutId
    || !source.exactResumeSupported) throw new Error('Codex fork requires a distinct tracked parent identity');
  const [sourceHome, childHome] = await Promise.all([realpath(source.codexHome), realpath(input.childHome)]);
  if (sourceHome === childHome) throw new Error('Codex fork requires a fresh child home');
  const sourcePath = await findCodexRolloutPathByUuid(source.rolloutId, { homeOverride: source.codexHome });
  if (!sourcePath || !inside(sourceHome, await realpath(sourcePath)) || !(await lstat(sourcePath)).isFile()) {
    throw new Error('Codex fork parent history is unavailable');
  }
  const prepared = input.prepared ?? await prepareCodexForkHistory(input);
  try {
    if (prepared.sourceId !== source.rolloutId || prepared.childHome !== childHome) throw new Error('Codex fork prepared history identity mismatch');
    const read = await peer.request({ method: 'thread/read', params: { threadId: source.rolloutId, includeTurns: true } });
    const parent = record(read.thread);
    if (parent.id !== source.rolloutId || !Array.isArray(parent.turns)) throw new Error('Codex fork could not verify parent history');
    const turns = parent.turns.map(record);
    let boundary = turns.filter(turn => turn.status === 'completed' && typeof turn.id === 'string').at(-1);
    if (!boundary && parent.historyMode === 'paginated') {
      let cursor: unknown;
      const seen = new Set<string>();
      do {
        const page = await peer.request({ method: 'thread/turns/list', params: {
          threadId: source.rolloutId, sortDirection: 'desc', limit: 100, itemsView: 'summary',
          ...(cursor ? { cursor } : {}),
        } });
        boundary = (Array.isArray(page.data) ? page.data.map(record) : [])
          .find(turn => turn.status === 'completed' && typeof turn.id === 'string');
        cursor = page.nextCursor;
        if (cursor && !boundary) {
          const key = JSON.stringify(cursor);
          if (seen.has(key)) throw new Error('Codex fork history pagination did not advance');
          seen.add(key);
        }
      } while (!boundary && cursor);
    }
    // An empty or entirely pending history has no safe inclusive boundary.
    if (!boundary) throw new Error(`Codex fork has no completed parent turn boundary (mode=${String(parent.historyMode)}, turns=${turns.length}, statuses=${turns.map(turn => String(turn.status)).join(',')})`);
    const result = await peer.request({ method: 'thread/fork', params: {
      ...input.params, threadId: source.rolloutId, ephemeral: false,
      ...(boundary ? { lastTurnId: boundary.id } : {}),
    } });
    const child = record(result.thread);
    if (typeof child.id !== 'string' || !child.id || child.id === source.rolloutId
      || child.forkedFromId != null && child.forkedFromId !== source.rolloutId
      || typeof child.path !== 'string' || !inside(childHome, await realpath(child.path))) {
      throw new Error('Codex fork did not return an independently persisted child identity');
    }
    // Native paginated forks retain immutable ancestor references. These
    // copied history rows/files are part of the child's durable conversation,
    // never a link to the parent's live storage or runtime ownership.
    if (input.retainHistory !== false) prepared.retain();
    return result;
  } finally {
    if (input.retainHistory !== false || !input.prepared) await prepared.cleanup();
  }
}
