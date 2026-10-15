import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTextCollector } from '../child-output';
import { LIVE_HEALTH_MONITOR_READY_PREFIX } from './live-health-monitor-main';
import { LIVE_HEALTH_MONITOR_READY_TIMEOUT_MS } from './live-health-supervisor';
import {
  decodeLiveHealthHistorySnapshot,
  LIVE_HEALTH_HISTORY_MAX_BYTES,
  LIVE_HEALTH_HISTORY_MAX_RECORD_BYTES,
} from './live-health-monitor';
import {
  LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
  liveHealthWindow,
  measuredLiveHealthReading,
  type LiveHealthSnapshot,
} from './live-health';

const REPO_ROOT = join(import.meta.dirname, '../../../../');
const BIN = join(import.meta.dirname, 'live-health-monitor-bin.ts');
const children = new Set<ChildProcess>();
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child);
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function waitForReady(child: ChildProcess, timeoutMs = LIVE_HEALTH_MONITOR_READY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    // Boundary-safe incremental read — see createTextCollector.peek().
    const collector = createTextCollector();
    let consumedChars = 0;
    const timeout = setTimeout(() => reject(new Error(`monitor readiness timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error: Error | null, line = '') => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(line);
    };
    collector.attach(child.stdout);
    child.stdout?.on('data', () => {
      const all = collector.peek();
      const lines = all.slice(consumedChars).split('\n');
      const partial = lines.pop() ?? '';
      consumedChars = all.length - partial.length;
      const ready = lines.find((line) => line.startsWith(LIVE_HEALTH_MONITOR_READY_PREFIX));
      if (ready) finish(null, ready);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) =>
      finish(new Error(`monitor exited before ready (${signal ?? code ?? 'unknown'})`)),
    );
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`monitor did not exit after stdin close within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe('resource-governor live-health out-of-process monitor', () => {
  it('advances oversized history through the real producer without dropping writer observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-live-health-large-producer-'));
    roots.push(root);
    const sourcePaths = ['live-health-monitor.ts', 'live-health-monitor-main.ts', 'live-health-monitor-bin.ts'];
    const sourceHashes = await Promise.all(sourcePaths.map(async (path) => ({
      path, sha256: createHash('sha256').update(await readFile(join(import.meta.dirname, path))).digest('hex'),
    })));
    let isolatedDatabase: { database: string; port: number } | null = null;
    // This same maintained test also runs in the ordinary integration suite.
    // When launched by the background-federation route, verify the actual
    // private connection and environment rather than inferring isolation.
    if (process.env.PAPERCUSP_WORKSPACE?.startsWith('test-runtime-')) {
      expect(process.env.PAPERCUSP_HOME).toBe(join(process.env.HOME!, '.papercusp'));
      expect(tmpdir()).toBe(join(dirname(process.env.HOME!), 'tmp'));
      // setup-hermetic-env removes ambient host launch switches. This test
      // starts the standalone monitor explicitly below; it does not boot bg-host.
      expect(process.env.PAPERCUSP_BACKGROUND_WORKERS).toBeUndefined();
      expect(process.env.PAPERCUSP_DBOS_ROUTINES).toBe('0');
      expect(process.env.PAPERCUSP_SKIP_PG_DISCOVERY).toBe('1');
      expect(process.env.PAPERCUSP_SID).toBeUndefined();
      const { Client } = await import('pg');
      const client = new Client({ connectionString: process.env.HARNESS_ADMIN_DATABASE_URL });
      try {
        await client.connect();
        const result = await client.query<{ database: string; port: number }>(
          'select current_database() as database, inet_server_port() as port',
        );
        isolatedDatabase = result.rows[0]!;
        expect(isolatedDatabase.port).toBe(Number(process.env.PAPERCUSP_PG_PORT));
      } finally {
        await client.end();
      }
    }
    await mkdir(join(root, 'fragments'));
    const publishedAtMs = Date.now();
    const ids = Array.from({ length: 700 }, (_, index) => `monitor.fixture:${index}`);
    await Promise.all(ids.map(async (id, index) => {
      const fragment = {
        schemaVersion: LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
        publishedAtMs,
        writer: { id, kind: 'monitor', instanceId: `fleet-${index}`, pid: index + 1,
          platform: 'linux', startedAtMs: publishedAtMs },
        signals: {
          'disk.freeBytes': measuredLiveHealthReading({ key: 'disk.freeBytes', value: index + 1,
            writerId: id, observedAtMs: publishedAtMs, collectedAtMs: publishedAtMs,
            window: liveHealthWindow('instant', publishedAtMs, publishedAtMs), confidence: 1 }),
        },
      };
      await writeFile(join(root, 'fragments', `${id.replaceAll(':', '-')}.json`), JSON.stringify(fragment));
    }));
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR: root };
    delete childEnv.VITEST;
    const child = spawn(process.execPath, [join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), BIN], {
      cwd: REPO_ROOT, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: false,
    });
    children.add(child);
    const stderr = createTextCollector();
    stderr.attach(child.stderr);
    await waitForReady(child);
    const historyPath = join(root, 'live-health-history.jsonl');
    await expect.poll(async () => {
      const rows = (await readFile(historyPath, 'utf8')).trim().split('\n');
      const first = JSON.parse(rows[0]!);
      let latestStart = 0;
      for (let index = 0; index < rows.length; index += 1) {
        if (JSON.parse(rows[index]!).part === 0) latestStart = index;
      }
      const latest = decodeLiveHealthHistorySnapshot(rows.slice(latestStart));
      return first.encoding && latest ? latest.sequence : 0;
    }, { timeout: 12_000, interval: 100 }).toBeGreaterThanOrEqual(2);
    child.stdin?.end();
    await waitForExit(child);
    expect(child.exitCode).toBe(0);
    children.delete(child);
    const current = JSON.parse(await readFile(join(root, 'live-health.json'), 'utf8')) as LiveHealthSnapshot;
    const history = await readFile(historyPath, 'utf8');
    const rows = history.trim().split('\n');
    const retained: LiveHealthSnapshot[] = [];
    for (let index = 0; index < rows.length;) {
      const parts = JSON.parse(rows[index]!).parts ?? 1;
      const snapshot = decodeLiveHealthHistorySnapshot(rows.slice(index, index + parts));
      expect(snapshot).not.toBeNull();
      retained.push(snapshot!);
      index += parts;
    }
    expect(Buffer.byteLength(JSON.stringify(current))).toBeGreaterThan(LIVE_HEALTH_HISTORY_MAX_RECORD_BYTES);
    expect(retained.at(-1)).toEqual(current);
    expect(retained.length).toBeGreaterThanOrEqual(2);
    for (const snapshot of retained) {
      expect(Object.keys(snapshot.writers)).toHaveLength(ids.length + 1);
      for (const [index, id] of ids.entries()) {
        expect(snapshot.observations['disk.freeBytes'][id]).toMatchObject({ writerId: id, value: index + 1 });
      }
    }
    expect(rows.every((row) => Buffer.byteLength(row) + 1 <= LIVE_HEALTH_HISTORY_MAX_RECORD_BYTES)).toBe(true);
    expect((await stat(historyPath)).size).toBeLessThanOrEqual(LIVE_HEALTH_HISTORY_MAX_BYTES);
    expect(stderr.peek()).not.toMatch(/history (?:row exceeded|write failed)/);
    const hashesAfter = await Promise.all(sourcePaths.map(async (path) => ({
      path, sha256: createHash('sha256').update(await readFile(join(import.meta.dirname, path))).digest('hex'),
    })));
    expect(hashesAfter).toEqual(sourceHashes);
    console.log(JSON.stringify({ kind: 'live-health-producer-history-proof', sourceHashes,
      workspace: process.env.PAPERCUSP_WORKSPACE, home: process.env.HOME, isolatedDatabase,
      childPid: child.pid, childExitCode: child.exitCode, currentBytes: Buffer.byteLength(JSON.stringify(current)),
      retainedBytes: Buffer.byteLength(history), retainedSamples: retained.length, writers: ids.length + 1 }));
  }, 45_000);

  it('boots, writes a whole atomic snapshot, and follows the parent-owned stdin lifetime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-live-health-'));
    roots.push(root);
    const childEnv = { ...process.env };
    delete childEnv.VITEST;
    childEnv.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR = root;
    const child = spawn('npx', ['tsx', BIN], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    children.add(child);
    const ready = await waitForReady(child);
    expect(ready).toContain('resource-governor-live-health-v2');

    const snapshot = JSON.parse(await readFile(join(root, 'live-health.json'), 'utf8')) as LiveHealthSnapshot;
    expect(snapshot.schemaVersion).toBe('resource-governor-live-health-v2');
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.profile).toMatchObject({ source: '@papercusp/resource-profile' });
    expect(snapshot.profile.effectiveCores).toBeGreaterThan(0);
    expect(Object.keys(snapshot.writers).some((id) => id.startsWith('monitor.host:'))).toBe(true);
    expect(snapshot.signals['memory.hostUsedBytes']).toMatchObject({ state: 'measured' });
    expect(snapshot.signals['database.waitP95Ms']).toEqual(expect.objectContaining({ state: 'unknown', value: null }));
    expect(snapshot.observations['memory.hostUsedBytes']).toBeTruthy();
    expect(snapshot.storage?.snapshots.find((row) => row.path === '/')).toMatchObject({ state: 'measured' });
    expect(snapshot.storage?.snapshots.find((row) => row.path === root)).toMatchObject({ state: 'measured' });
    for (const row of snapshot.storage!.snapshots.filter((row) => row.state === 'measured')) {
      expect(row.totalBytes).toBeGreaterThan(0);
      expect(row.totalInodes).toBeGreaterThanOrEqual(0);
      expect(row.freeInodes).toBeLessThanOrEqual(row.totalInodes!);
      expect(row.reservationState).toBe('measured');
    }
    // READY precedes archival work. Closing the parent's lifetime pipe must
    // drain that same sample rather than lose the first retained observation.
    child.stdin?.end();
    await waitForExit(child);
    const historyRows = (await readFile(join(root, 'live-health-history.jsonl'), 'utf8')).trim().split('\n');
    const first = JSON.parse(historyRows[0]!);
    const retained = decodeLiveHealthHistorySnapshot(historyRows.slice(0, first.parts ?? 1));
    expect(retained?.storage).toEqual(snapshot.storage);
    children.delete(child);
  }, 30_000);
});
