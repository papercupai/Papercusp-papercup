/**
 * Cross-platform, out-of-process live-health sampler.
 *
 * This module owns only observation and freshness. It never decides whether a
 * reading should contract admission; that belongs to the P-005/P-006 controller.
 * Linux-specific probes fail to explicit unknown on every other platform.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getResourceProfile, type ResourceProfile } from '@papercusp/resource-profile';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { readReservationSnapshot } from '../../../../scripts/lib/disk-reservations.mjs';
import { diskPolicyFromEnv } from '../storage/disk-space-policy';
import { measureLiveNodeEntrySource, isLiveNodeEntrySourceCurrent, type LiveNodeEntrySource } from '../runtime-vintage';
import {
  LIVE_HEALTH_SCHEMA_VERSION,
  LIVE_HEALTH_SIGNAL_SPECS,
  emptyLiveHealthObservations,
  emptyLiveHealthSignals,
  isLiveHealthFragment,
  isLiveHealthSnapshot,
  isLiveHealthStorage,
  isLiveHealthWriter,
  isLiveHealthSourceCustody,
  liveHealthWindow,
  measuredLiveHealthReading,
  mergeLiveHealthFragments,
  unknownLiveHealthReading,
  type LiveHealthFragment,
  type LiveHealthPlatformProfile,
  type LiveHealthReading,
  type LiveHealthSignalKey,
  type LiveHealthSnapshot,
  type LiveHealthStorageSample,
  type LiveHealthWriter,
  type LiveHealthSourceCustody,
} from './live-health';

export const LIVE_HEALTH_DEFAULT_CADENCE_MS = 2_000;
/** A missing or older-than-this atomic snapshot is not current host evidence. */
export const LIVE_HEALTH_SNAPSHOT_MAX_AGE_MS = 15_000;
export const LIVE_HEALTH_FRAGMENT_RETENTION_MS = 24 * 60 * 60_000;
export const LIVE_HEALTH_PAGE_BYTES = 4_096;
export const LIVE_HEALTH_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const LIVE_HEALTH_HISTORY_MAX_SAMPLES = 3_600;
export const LIVE_HEALTH_HISTORY_MAX_RECORD_BYTES = 256 * 1024;

export interface LiveHealthPaths {
  readonly rootDir: string;
  readonly fragmentsDir: string;
  readonly snapshotPath: string;
}

export function resolveLiveHealthPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): LiveHealthPaths {
  const rootDir = env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR
    ? env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR
    : join(home, '.papercusp', 'runtime', 'resource-governor');
  return {
    rootDir,
    fragmentsDir: join(rootDir, 'fragments'),
    snapshotPath: join(rootDir, 'live-health.json'),
  };
}

export function liveHealthFragmentPath(paths: LiveHealthPaths, writerId: string): string {
  const safe = writerId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 180) || 'writer';
  return join(paths.fragmentsDir, `${safe}.json`);
}

/** Atomic same-directory replacement; readers see the old or new whole JSON. */
export async function writeLiveHealthJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function writeLiveHealthText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), '.' + process.pid + '-' + randomUUID() + '.tmp');
  try {
    await writeFile(tmp, value, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

interface LiveHealthHistoryWriterOptions {
  readonly maxBytes?: number;
  readonly maxSamples?: number;
  readonly maxRecordBytes?: number;
}

interface LiveHealthHistoryTail {
  readonly text: string;
  readonly needsRewrite: boolean;
}

export const LIVE_HEALTH_STORAGE_HISTORY_SCHEMA = 'live-health-storage-history-v1' as const;
/** Storage observations only; this never represents a complete fleet snapshot. */
export interface LiveHealthStorageHistorySample {
  readonly schemaVersion: typeof LIVE_HEALTH_STORAGE_HISTORY_SCHEMA;
  readonly sequence: number;
  readonly sampledAtMs: number;
  readonly cadenceMs: number;
  readonly writer: LiveHealthWriter;
  readonly storage: LiveHealthStorageSample;
  readonly sourceCustody?: LiveHealthSourceCustody | null;
}

function isStorageHistorySample(value: unknown): value is LiveHealthStorageHistorySample {
  if (!value || typeof value !== 'object') return false;
  const row = value as LiveHealthStorageHistorySample;
  return row.schemaVersion === LIVE_HEALTH_STORAGE_HISTORY_SCHEMA &&
    Number.isSafeInteger(row.sequence) && row.sequence > 0 &&
    Number.isFinite(row.sampledAtMs) && Number.isFinite(row.cadenceMs) && row.cadenceMs > 0 &&
    isLiveHealthWriter(row.writer) && row.writer.kind === 'monitor' && row.writer.startedAtMs <= row.sampledAtMs &&
    isLiveHealthStorage(row.storage) && row.storage.startedAtMs >= row.sampledAtMs &&
    (row.sourceCustody === undefined || row.sourceCustody === null ||
      (isLiveHealthSourceCustody(row.sourceCustody) && row.sourceCustody.nativePid === row.writer.pid &&
        row.sourceCustody.sampleStartedAtMs === row.sampledAtMs));
}

export function liveHealthStorageHistorySample(snapshot: LiveHealthSnapshot): LiveHealthStorageHistorySample | null {
  const writer = Object.values(snapshot.writers).find((row) =>
    row.kind === 'monitor' && row.startedAtMs === snapshot.monitorStartedAtMs && row.id === `monitor.host:${row.pid}`);
  if (!snapshot.storage || !writer) return null;
  return { schemaVersion: LIVE_HEALTH_STORAGE_HISTORY_SCHEMA, sequence: snapshot.sequence,
    sampledAtMs: snapshot.sampledAtMs, cadenceMs: snapshot.cadenceMs, writer, storage: snapshot.storage,
    ...(snapshot.sourceCustody === undefined ? {} : { sourceCustody: snapshot.sourceCustody }) };
}

const HISTORY_ENCODING = 'live-health-history-gzip-v1';
const HISTORY_MAX_DECODED_BYTES = 32 * 1024 * 1024;
interface EncodedHistoryPart {
  encoding: typeof HISTORY_ENCODING;
  sourceBytes: number;
  sha256: string;
  part: number;
  parts: number;
  data: string;
}

function historyPart(value: unknown): value is EncodedHistoryPart {
  if (!value || typeof value !== 'object') return false;
  const p = value as EncodedHistoryPart;
  return p.encoding === HISTORY_ENCODING && Number.isSafeInteger(p.sourceBytes) && p.sourceBytes > 0 &&
    p.sourceBytes <= HISTORY_MAX_DECODED_BYTES && typeof p.sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.sha256) &&
    Number.isSafeInteger(p.parts) && p.parts > 0 && p.parts <= 100_000 &&
    Number.isSafeInteger(p.part) && p.part >= 0 && p.part < p.parts && typeof p.data === 'string';
}

function decodeHistoryValue(rows: readonly string[]): unknown {
  try {
    const values: unknown[] = rows.map((row) => JSON.parse(row));
    if (values.length === 1 && (isLiveHealthSnapshot(values[0]) || isStorageHistorySample(values[0]))) return values[0];
    const first = values[0];
    if (!historyPart(first) || first.part !== 0 || values.length !== first.parts) return null;
    if (!values.every((p, index) => historyPart(p) && p.part === index && p.parts === first.parts &&
      p.sha256 === first.sha256 && p.sourceBytes === first.sourceBytes)) return null;
    const encoded = (values as EncodedHistoryPart[]).map((p) => p.data).join('');
    const compressed = Buffer.from(encoded, 'base64');
    if (compressed.toString('base64') !== encoded) return null;
    const raw = gunzipSync(compressed, { maxOutputLength: first.sourceBytes });
    if (raw.length !== first.sourceBytes || createHash('sha256').update(raw).digest('hex') !== first.sha256) return null;
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

/** Decode one complete history sample, including legacy unencoded snapshots. */
export function decodeLiveHealthHistorySnapshot(rows: readonly string[]): LiveHealthSnapshot | null {
  const value = decodeHistoryValue(rows);
  return isLiveHealthSnapshot(value) ? value : null;
}

export function decodeLiveHealthStorageHistorySample(rows: readonly string[]): LiveHealthStorageHistorySample | null {
  const value = decodeHistoryValue(rows);
  return isStorageHistorySample(value) ? value : null;
}

function encodeHistorySnapshot(snapshot: LiveHealthSnapshot | LiveHealthStorageHistorySample, maxRecordBytes: number): string[] | null {
  const raw = Buffer.from(JSON.stringify(snapshot));
  if (raw.length + 1 <= maxRecordBytes) return [raw.toString('utf8')];
  if (raw.length > HISTORY_MAX_DECODED_BYTES) return null;
  const data = gzipSync(raw).toString('base64');
  const header = { encoding: HISTORY_ENCODING, sourceBytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };
  // Reserve the largest supported part indices before splitting, so every physical
  // JSONL row respects the cap even when the snapshot needs multiple rows.
  const overhead = Buffer.byteLength(JSON.stringify({ ...header, part: 100_000, parts: 100_000, data: '' })) + 1;
  const chunkBytes = maxRecordBytes - overhead;
  if (chunkBytes < 1) return null;
  const parts = Math.ceil(data.length / chunkBytes);
  if (parts > 100_000) return null;
  return Array.from({ length: parts }, (_, part) => JSON.stringify({
    ...header, part, parts, data: data.slice(part * chunkBytes, (part + 1) * chunkBytes),
  }));
}

/**
 * Append complete snapshots as JSONL while bounding disk use and sample count.
 * The monitor is the sole writer for this path; appends are serialized so an
 * overlapping slow sample cannot race a retention compaction.
 */
export class LiveHealthHistoryWriter {
  readonly path: string;
  readonly maxBytes: number;
  readonly maxSamples: number;
  readonly maxRecordBytes: number;
  private initialized = false;
  private rowCount = 0;
  private byteCount = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(path: string, options: LiveHealthHistoryWriterOptions = {}) {
    this.path = path;
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? LIVE_HEALTH_HISTORY_MAX_BYTES));
    this.maxSamples = Math.max(1, Math.floor(options.maxSamples ?? LIVE_HEALTH_HISTORY_MAX_SAMPLES));
    this.maxRecordBytes = Math.max(
      1,
      Math.min(this.maxBytes, Math.floor(options.maxRecordBytes ?? LIVE_HEALTH_HISTORY_MAX_RECORD_BYTES)),
    );
  }

  append(snapshot: LiveHealthSnapshot | LiveHealthStorageHistorySample): Promise<boolean> {
    const result = this.pending.then(() => this.appendSerial(snapshot));
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  private async readTail(): Promise<LiveHealthHistoryTail> {
    const file = await open(this.path, 'r').catch(() => null);
    if (!file) return { text: '', needsRewrite: false };
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, this.maxBytes);
      if (length === 0) return { text: '', needsRewrite: size > 0 };
      const start = size - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      let needsRewrite = start > 0;
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
      }
      if (text && !text.endsWith('\n')) {
        const lastNewline = text.lastIndexOf('\n');
        text = lastNewline < 0 ? '' : text.slice(0, lastNewline + 1);
        needsRewrite = true;
      }
      return { text, needsRewrite };
    } finally {
      await file.close();
    }
  }

  private validFrames(text: string): string[][] {
    const frames: string[][] = [];
    const rows = text.split(/\r?\n/).filter(Boolean);
    for (let index = 0; index < rows.length; index += 1) {
      const line = rows[index]!;
      try {
        const value: unknown = JSON.parse(line);
        if (historyPart(value)) {
          if (value.part !== 0 || value.parts > rows.length - index) continue;
          const frame = rows.slice(index, index + value.parts);
          if (!decodeLiveHealthHistorySnapshot(frame) && !decodeLiveHealthStorageHistorySample(frame)) continue;
          frames.push(frame);
          index += value.parts - 1;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          frames.push([line]);
        }
      } catch {
        // Ignore malformed/torn records, retaining only whole history samples.
      }
    }
    return frames;
  }

  private async replaceRows(frames: readonly string[][], targetRows: number, targetBytes: number): Promise<void> {
    const kept: string[][] = [];
    let bytes = 0;
    for (let index = frames.length - 1; index >= 0 && kept.length < targetRows; index -= 1) {
      const frame = frames[index]!;
      const rowBytes = frame.reduce((total, row) => total + Buffer.byteLength(row) + 1, 0);
      if (bytes + rowBytes > targetBytes) break;
      kept.push(frame);
      bytes += rowBytes;
    }
    const ordered = kept.reverse().flat();
    await writeLiveHealthText(this.path, ordered.length ? ordered.join('\n') + '\n' : '');
    this.rowCount = kept.length;
    this.byteCount = bytes;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const tail = await this.readTail();
    const rawRows = tail.text.split(/\r?\n/).filter(Boolean);
    const frames = this.validFrames(tail.text);
    this.rowCount = frames.length;
    this.byteCount = frames.flat().reduce((total, row) => total + Buffer.byteLength(row) + 1, 0);
    this.initialized = true;
    if (
      tail.needsRewrite ||
      frames.flat().length !== rawRows.length ||
      this.rowCount > this.maxSamples ||
      this.byteCount > this.maxBytes
    ) {
      await this.replaceRows(frames, this.maxSamples, this.maxBytes);
    }
  }

  private async appendSerial(snapshot: LiveHealthSnapshot | LiveHealthStorageHistorySample): Promise<boolean> {
    const rows = encodeHistorySnapshot(snapshot, this.maxRecordBytes);
    if (!rows) return false;
    const row = rows.join('\n') + '\n';
    const rowBytes = Buffer.byteLength(row);
    if (rowBytes > this.maxBytes) return false;
    await this.initialize();
    if (this.rowCount + 1 > this.maxSamples || this.byteCount + rowBytes > this.maxBytes) {
      const tail = await this.readTail();
      await this.replaceRows(
        this.validFrames(tail.text),
        Math.floor(this.maxSamples / 2),
        Math.floor(this.maxBytes / 2),
      );
    }
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, row, { encoding: 'utf8', mode: 0o600 });
    this.rowCount += 1;
    this.byteCount += rowBytes;
    return true;
  }
}

/**
 * Read the monitor's atomic snapshot only when it is structurally valid and
 * recent enough to describe the current host. A malformed, missing, future, or
 * stale file is an unknown reading rather than a healthy default.
 */
export async function readLiveHealthSnapshot(
  paths: LiveHealthPaths = resolveLiveHealthPaths(),
  nowMs = Date.now(),
  maxAgeMs = LIVE_HEALTH_SNAPSHOT_MAX_AGE_MS,
): Promise<LiveHealthSnapshot | null> {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return null;
  try {
    const value: unknown = JSON.parse(await readFile(paths.snapshotPath, 'utf8'));
    if (!isLiveHealthSnapshot(value)) return null;
    const ageMs = nowMs - value.sampledAtMs;
    if (ageMs < 0 || ageMs > maxAgeMs) return null;
    return value;
  } catch {
    return null;
  }
}

export interface PsiSample {
  readonly some60: number | null;
  readonly full60: number | null;
}

export function parsePsi(text: string | null): PsiSample {
  const out: { some60: number | null; full60: number | null } = { some60: null, full60: null };
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const kind = line.startsWith('some ') ? 'some60' : line.startsWith('full ') ? 'full60' : null;
    if (!kind) continue;
    const match = line.match(/\bavg60=([\d.]+)/);
    const value = match ? Number(match[1]) : Number.NaN;
    if (Number.isFinite(value)) out[kind] = value;
  }
  return out;
}

export interface SchedulerSample {
  readonly runnable: number | null;
  readonly blocked: number | null;
}

export function parseProcStat(text: string | null): SchedulerSample {
  const read = (name: string): number | null => {
    const match = text?.match(new RegExp(`(?:^|\\n)${name}\\s+(\\d+)`));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  return { runnable: read('procs_running'), blocked: read('procs_blocked') };
}

export interface MemoryKernelSample {
  readonly swapUsedBytes: number | null;
  readonly swapInPages: number | null;
  readonly swapOutPages: number | null;
}

export function parseMemoryKernel(meminfo: string | null, vmstat: string | null): MemoryKernelSample {
  const memKb = (name: string): number | null => {
    const match = meminfo?.match(new RegExp(`(?:^|\\n)${name}:\\s+(\\d+)\\s+kB`));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  const vm = (name: string): number | null => {
    const match = vmstat?.match(new RegExp(`(?:^|\\n)${name}\\s+(\\d+)`));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  const total = memKb('SwapTotal');
  const free = memKb('SwapFree');
  return {
    swapUsedBytes: total === null || free === null ? null : Math.max(0, total - free) * 1_024,
    swapInPages: vm('pswpin'),
    swapOutPages: vm('pswpout'),
  };
}

export interface NetworkCounters {
  readonly rxBytes: number;
  readonly txBytes: number;
}

export function parseNetworkCounters(text: string | null): NetworkCounters | null {
  if (!text) return null;
  let rxBytes = 0;
  let txBytes = 0;
  let rows = 0;
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || name === 'lo') continue;
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (fields.length < 16 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rxBytes += fields[0]!;
    txBytes += fields[8]!;
    rows++;
  }
  return rows > 0 ? { rxBytes, txBytes } : null;
}

export function parseCloseWaitCount(...tables: Array<string | null>): number | null {
  let readable = 0;
  let count = 0;
  for (const table of tables) {
    if (!table) continue;
    readable++;
    for (const line of table.split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '08') count++;
    }
  }
  return readable > 0 ? count : null;
}

export interface CpuCounters {
  readonly idleMs: number;
  readonly totalMs: number;
}

export function readCpuCounters(rows: ReturnType<typeof cpus>): CpuCounters | null {
  if (rows.length === 0) return null;
  let idleMs = 0;
  let totalMs = 0;
  for (const row of rows) {
    idleMs += row.times.idle;
    totalMs += row.times.user + row.times.nice + row.times.sys + row.times.idle + row.times.irq;
  }
  return totalMs > 0 ? { idleMs, totalMs } : null;
}

export interface HostLiveHealthCounters {
  readonly atMs: number;
  readonly cpu: CpuCounters | null;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly cpuPsi: PsiSample;
  readonly memoryPsi: PsiSample;
  readonly ioPsi: PsiSample;
  readonly scheduler: SchedulerSample;
  readonly memoryKernel: MemoryKernelSample;
  readonly network: NetworkCounters | null;
  readonly closeWaitCount: number | null;
  readonly diskFreeBytes: number | null;
  readonly storage?: LiveHealthStorageSample;
}

interface StorageProbes {
  filesystem(path: string): Promise<{ dev: number; totalBytes: number; availableBytes: number; totalInodes: number; freeInodes: number }>;
  reservations(path: string): ReturnType<typeof readReservationSnapshot>;
}

/** Retain the explicit watched population, including failed paths. Aliases read
 * one reservation budget; no independent alias sum or failure-as-zero evidence. */
export async function collectLiveHealthStorage(
  paths: readonly string[],
  now: () => number = Date.now,
  probes: StorageProbes = {
    filesystem: async (path) => {
      const [identity, fs] = await Promise.all([stat(path), statfs(path, { bigint: true })]);
      return { dev: identity.dev, totalBytes: Number(fs.blocks * fs.bsize),
        availableBytes: Number(fs.bavail * fs.bsize), totalInodes: Number(fs.files), freeInodes: Number(fs.ffree) };
    },
    reservations: readReservationSnapshot,
  },
): Promise<LiveHealthStorageSample> {
  const startedAtMs = now();
  const budgets = new Map<number, ReturnType<typeof readReservationSnapshot>>();
  const snapshots = await Promise.all([...new Set(paths)].map(async (path) => {
    try {
      const fs = await probes.filesystem(path);
      if (!Object.values(fs).every((n) => Number.isSafeInteger(n) && n >= 0) || fs.totalBytes <= 0 ||
        fs.availableBytes > fs.totalBytes || fs.freeInodes > fs.totalInodes) throw new Error('invalid-counters');
      let budget = budgets.get(fs.dev);
      if (!budget) {
        budget = probes.reservations(path);
        budgets.set(fs.dev, budget);
      }
      if (budget.deviceKey !== `dev-${fs.dev}`) throw new Error('reservation-device-changed');
      return { path, state: 'measured' as const, ...fs, reservationState: budget.state,
        reservedBytes: budget.reservedBytes, issues: budget.issues };
    } catch (error) {
      return { path, state: 'unknown' as const, dev: null, totalBytes: null, availableBytes: null,
        totalInodes: null, freeInodes: null, reservationState: 'unknown' as const, reservedBytes: null,
        issues: [error instanceof Error ? error.message : String(error)] };
    }
  }));
  return { startedAtMs, collectedAtMs: now(), policy: diskPolicyFromEnv(), snapshots };
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function collectHostLiveHealthCounters(
  nowMs: number,
  paths: LiveHealthPaths,
  currentPlatform: NodeJS.Platform = platform(),
): Promise<HostLiveHealthCounters> {
  await mkdir(paths.rootDir, { recursive: true });
  const linuxReads =
    currentPlatform === 'linux'
      ? await Promise.all([
          readTextOrNull('/proc/pressure/cpu'),
          readTextOrNull('/proc/pressure/memory'),
          readTextOrNull('/proc/stat'),
          readTextOrNull('/proc/meminfo'),
          readTextOrNull('/proc/vmstat'),
          readTextOrNull('/proc/net/dev'),
          readTextOrNull('/proc/net/tcp'),
          readTextOrNull('/proc/net/tcp6'),
          readTextOrNull('/proc/pressure/io'),
        ])
      : [null, null, null, null, null, null, null, null, null];
  const fs = await statfs(paths.rootDir).catch(() => null);
  const diskFreeBytes = fs ? Number(fs.bavail) * Number(fs.bsize) : null;
  const storage = await collectLiveHealthStorage([
    '/', paths.rootDir, tmpdir(), ...(currentPlatform === 'linux' ? ['/mnt/data', '/tmp/pcv'] : []),
    process.cwd(),
    ...(process.env.PAPERCUSP_DISK_ALARM_PATHS ?? '').split(',').map((path) => path.trim()).filter(Boolean),
  ]);
  return {
    atMs: nowMs,
    cpu: readCpuCounters(cpus()),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    cpuPsi: parsePsi(linuxReads[0]),
    memoryPsi: parsePsi(linuxReads[1]),
    ioPsi: parsePsi(linuxReads[8]),
    scheduler: parseProcStat(linuxReads[2]),
    memoryKernel: parseMemoryKernel(linuxReads[3], linuxReads[4]),
    network: parseNetworkCounters(linuxReads[5]),
    closeWaitCount: parseCloseWaitCount(linuxReads[6], linuxReads[7]),
    diskFreeBytes: Number.isFinite(diskFreeBytes) ? diskFreeBytes : null,
    storage,
  };
}

function platformUnknownReason(currentPlatform: NodeJS.Platform): string {
  return currentPlatform === 'linux' ? 'linux-probe-unavailable' : `unsupported-on-${currentPlatform}`;
}

function monitorReading(
  key: LiveHealthSignalKey,
  writerId: string,
  current: HostLiveHealthCounters,
  value: number | null,
  windowStartMs = current.atMs,
  confidence = 1,
): LiveHealthReading {
  const spec = LIVE_HEALTH_SIGNAL_SPECS[key];
  const window = liveHealthWindow(spec.windowKind, windowStartMs, current.atMs);
  return value === null
    ? unknownLiveHealthReading({
        key,
        writerId,
        observedAtMs: current.atMs,
        window,
        reason: platformUnknownReason(platform()),
      })
    : measuredLiveHealthReading({
        key,
        writerId,
        observedAtMs: current.atMs,
        window,
        value,
        confidence,
      });
}

function rate(current: number | null, previous: number | null, elapsedMs: number, scale = 1): number | null {
  if (current === null || previous === null || elapsedMs <= 0 || current < previous) return null;
  return ((current - previous) * scale * 1_000) / elapsedMs;
}

export function applyHostLiveHealthReadings(
  signals: Record<LiveHealthSignalKey, LiveHealthReading>,
  writerId: string,
  current: HostLiveHealthCounters,
  previous: HostLiveHealthCounters | null,
): void {
  const start = previous?.atMs ?? current.atMs;
  const elapsedMs = Math.max(0, current.atMs - start);
  let cpuPct: number | null = null;
  if (previous?.cpu && current.cpu) {
    const totalDelta = current.cpu.totalMs - previous.cpu.totalMs;
    const idleDelta = current.cpu.idleMs - previous.cpu.idleMs;
    if (totalDelta > 0 && idleDelta >= 0) cpuPct = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
  }
  signals['cpu.hostUtilizationPct'] = monitorReading('cpu.hostUtilizationPct', writerId, current, cpuPct, start);
  signals['cpu.psiSomePct'] = monitorReading(
    'cpu.psiSomePct',
    writerId,
    current,
    current.cpuPsi.some60,
    current.atMs - 60_000,
  );
  signals['scheduler.runnableCount'] = monitorReading(
    'scheduler.runnableCount',
    writerId,
    current,
    current.scheduler.runnable,
  );
  signals['scheduler.blockedCount'] = monitorReading(
    'scheduler.blockedCount',
    writerId,
    current,
    current.scheduler.blocked,
  );
  signals['memory.hostUsedBytes'] = monitorReading(
    'memory.hostUsedBytes',
    writerId,
    current,
    Math.max(0, current.totalMemoryBytes - current.freeMemoryBytes),
  );
  signals['memory.psiSomePct'] = monitorReading(
    'memory.psiSomePct',
    writerId,
    current,
    current.memoryPsi.some60,
    current.atMs - 60_000,
  );
  signals['memory.psiFullPct'] = monitorReading(
    'memory.psiFullPct',
    writerId,
    current,
    current.memoryPsi.full60,
    current.atMs - 60_000,
  );
  signals['io.psiSomePct'] = monitorReading(
    'io.psiSomePct',
    writerId,
    current,
    current.ioPsi.some60,
    current.atMs - 60_000,
  );
  signals['io.psiFullPct'] = monitorReading(
    'io.psiFullPct',
    writerId,
    current,
    current.ioPsi.full60,
    current.atMs - 60_000,
  );
  signals['memory.swapUsedBytes'] = monitorReading(
    'memory.swapUsedBytes',
    writerId,
    current,
    current.memoryKernel.swapUsedBytes,
  );
  signals['memory.swapInBytesPerSec'] = monitorReading(
    'memory.swapInBytesPerSec',
    writerId,
    current,
    rate(
      current.memoryKernel.swapInPages,
      previous?.memoryKernel.swapInPages ?? null,
      elapsedMs,
      LIVE_HEALTH_PAGE_BYTES,
    ),
    start,
  );
  signals['memory.swapOutBytesPerSec'] = monitorReading(
    'memory.swapOutBytesPerSec',
    writerId,
    current,
    rate(
      current.memoryKernel.swapOutPages,
      previous?.memoryKernel.swapOutPages ?? null,
      elapsedMs,
      LIVE_HEALTH_PAGE_BYTES,
    ),
    start,
  );
  signals['network.rxBytesPerSec'] = monitorReading(
    'network.rxBytesPerSec',
    writerId,
    current,
    rate(current.network?.rxBytes ?? null, previous?.network?.rxBytes ?? null, elapsedMs),
    start,
  );
  signals['network.txBytesPerSec'] = monitorReading(
    'network.txBytesPerSec',
    writerId,
    current,
    rate(current.network?.txBytes ?? null, previous?.network?.txBytes ?? null, elapsedMs),
    start,
  );
  signals['socket.closeWaitCount'] = monitorReading('socket.closeWaitCount', writerId, current, current.closeWaitCount);
  signals['disk.freeBytes'] = monitorReading('disk.freeBytes', writerId, current, current.diskFreeBytes);
  // Throughput needs a mount/device attribution writer. Do not sum overlapping
  // dm/partition rows from /proc/diskstats and present the double count as truth.
  for (const key of ['disk.readBytesPerSec', 'disk.writeBytesPerSec'] as const) {
    signals[key] = unknownLiveHealthReading({
      key,
      writerId,
      observedAtMs: current.atMs,
      window: liveHealthWindow('delta', start, current.atMs),
      reason: platform() === 'linux' ? 'block-device-attribution-unavailable' : platformUnknownReason(platform()),
    });
  }
}

export async function readLiveHealthFragments(paths: LiveHealthPaths, nowMs: number): Promise<LiveHealthFragment[]> {
  let names: string[];
  try {
    names = (await readdir(paths.fragmentsDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  // Independent files are intentionally parallel: a serial fs loop makes sample
  // latency grow linearly with process count. There is no fixed writer ceiling.
  const parsed = await Promise.all(
    names.map(async (name): Promise<LiveHealthFragment | null> => {
      const path = join(paths.fragmentsDir, name);
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isLiveHealthFragment(value)) return null;
        if (nowMs - value.publishedAtMs > LIVE_HEALTH_FRAGMENT_RETENTION_MS) {
          await unlink(path).catch(() => {});
          return null;
        }
        return value;
      } catch {
        return null;
      }
    }),
  );
  return parsed.filter((fragment): fragment is LiveHealthFragment => fragment !== null);
}

function liveHealthProfile(resourceProfile: ResourceProfile): LiveHealthPlatformProfile {
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    effectiveCores: resourceProfile.signals.cores,
    physicalCores: resourceProfile.signals.physicalCores ?? resourceProfile.signals.cores,
    totalMemoryBytes: resourceProfile.signals.totalMemBytes,
    embeddedPg: resourceProfile.signals.embeddedPg,
    hostRole: resourceProfile.signals.hostRole,
    source: '@papercusp/resource-profile',
  };
}

export interface LiveHealthMonitorOptions {
  readonly paths?: LiveHealthPaths;
  readonly cadenceMs?: number;
  readonly now?: () => number;
  readonly resourceProfile?: ResourceProfile;
  readonly collectHost?: typeof collectHostLiveHealthCounters;
  readonly readFragments?: typeof readLiveHealthFragments;
  readonly writeSnapshot?: typeof writeLiveHealthJson;
  readonly writeHistory?: (snapshot: LiveHealthSnapshot) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly sourceWitness?: {
    readonly capture: typeof measureLiveNodeEntrySource;
    readonly current: typeof isLiveNodeEntrySourceCurrent;
  };
}

export class LiveHealthMonitor {
  readonly paths: LiveHealthPaths;
  readonly cadenceMs: number;
  readonly writer: LiveHealthWriter;
  readonly profile: LiveHealthPlatformProfile;
  private readonly now: () => number;
  private readonly collectHost: typeof collectHostLiveHealthCounters;
  private readonly readFragments: typeof readLiveHealthFragments;
  private readonly writeSnapshot: typeof writeLiveHealthJson;
  private readonly writeHistory: (snapshot: LiveHealthSnapshot) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly sourcePin: LiveNodeEntrySource | null;
  private readonly sourceCurrent: typeof isLiveNodeEntrySourceCurrent;
  private previous: HostLiveHealthCounters | null = null;
  private sequence = 0;
  private timer: ManagedHandle | null = null;
  private lifecycle = 0;
  private lastSampleTiming: {
    startedAt: number;
    completedAt: number | null;
    phases: Record<string, number>;
  } | null = null;
  private sampleInFlight: {
    ready: Promise<LiveHealthSnapshot>;
    complete: Promise<LiveHealthSnapshot>;
  } | null = null;

  constructor(options: LiveHealthMonitorOptions = {}) {
    this.paths = options.paths ?? resolveLiveHealthPaths();
    this.cadenceMs = Math.max(250, options.cadenceMs ?? LIVE_HEALTH_DEFAULT_CADENCE_MS);
    this.now = options.now ?? Date.now;
    this.collectHost = options.collectHost ?? collectHostLiveHealthCounters;
    this.readFragments = options.readFragments ?? readLiveHealthFragments;
    this.writeSnapshot = options.writeSnapshot ?? writeLiveHealthJson;
    this.log = options.log ?? ((message) => console.warn(message));
    // Hash the direct loaded entry once; per-sample stat/identity checks refuse
    // edits or replacement without re-hashing a fleet-sized bundle every tick.
    this.sourcePin = (options.sourceWitness?.capture ?? measureLiveNodeEntrySource)(process.pid);
    this.sourceCurrent = options.sourceWitness?.current ?? isLiveNodeEntrySourceCurrent;
    const history = new LiveHealthHistoryWriter(join(this.paths.rootDir, 'live-health-history.jsonl'));
    // Fleet-sized observations cannot consume the storage interval's byte budget.
    // Reuse the same bounded writer/codec, with an explicit storage-only schema.
    const storageHistory = new LiveHealthHistoryWriter(join(this.paths.rootDir, 'live-health-storage-history.jsonl'));
    this.writeHistory = options.writeHistory ?? (async (snapshot) => {
      const storage = liveHealthStorageHistorySample(snapshot);
      if (storage) {
        try {
          if (!(await storageHistory.append(storage))) {
            this.log('[resource-governor-health] storage history row exceeded its configured cap; skipped');
          }
        } catch (error) {
          this.log('[resource-governor-health] storage history write failed: ' +
            (error instanceof Error ? error.message : String(error)));
        }
      }
      if (!(await history.append(snapshot))) {
        this.log('[resource-governor-health] history row exceeded its configured cap; skipped');
      }
    });
    const startedAtMs = this.now();
    this.writer = {
      id: `monitor.host:${process.pid}`,
      kind: 'monitor',
      instanceId: randomUUID(),
      pid: process.pid,
      platform: platform(),
      startedAtMs,
    };
    this.profile = liveHealthProfile(options.resourceProfile ?? getResourceProfile());
  }

  sampleOnce(): Promise<LiveHealthSnapshot> {
    return this.beginSample().complete;
  }

  private beginSample(): NonNullable<LiveHealthMonitor['sampleInFlight']> {
    if (this.sampleInFlight) return this.sampleInFlight;
    let published!: (snapshot: LiveHealthSnapshot) => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<LiveHealthSnapshot>((resolve, reject) => {
      published = resolve;
      failed = reject;
    });
    // sampleOnce callers await complete; start callers await ready. Observe the
    // optional readiness rejection without hiding the complete operation's error.
    void ready.catch(() => {});
    const complete = this.sampleSerial(published);
    const sample = { ready, complete };
    this.sampleInFlight = sample;
    const clear = () => {
      if (this.sampleInFlight === sample) this.sampleInFlight = null;
    };
    void complete.then(clear, (error) => { failed(error); clear(); });
    return sample;
  }

  private async sampleSerial(published: (snapshot: LiveHealthSnapshot) => void): Promise<LiveHealthSnapshot> {
    const started = performance.now();
    const previousTiming = this.lastSampleTiming;
    if (previousTiming && started - previousTiming.startedAt > LIVE_HEALTH_SNAPSHOT_MAX_AGE_MS) {
      this.log('[resource-governor-health] sample gap exceeded freshness: ' + JSON.stringify({
        gapMs: started - previousTiming.startedAt,
        previousSampleMs: previousTiming.completedAt === null ? null : previousTiming.completedAt - previousTiming.startedAt,
        sinceCompletionMs: previousTiming.completedAt === null ? null : Math.max(0, started - previousTiming.completedAt),
        previousPhases: previousTiming.phases,
      }));
    }
    const timing = { startedAt: started, completedAt: null as number | null, phases: {} as Record<string, number> };
    this.lastSampleTiming = timing;
    const phase = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const before = performance.now();
      try { return await run(); }
      finally { timing.phases[name] = Math.max(0, performance.now() - before); }
    };
    let complete = false;
    try {
      const sampledAtMs = this.now();
      const sourceBefore = this.sourcePin ? this.sourceCurrent(this.sourcePin) : false;
      const current = await phase('collectHost', () => this.collectHost(sampledAtMs, this.paths, this.profile.platform));
      const signals = emptyLiveHealthSignals(sampledAtMs);
      applyHostLiveHealthReadings(signals, this.writer.id, current, this.previous);
      const observations = emptyLiveHealthObservations();
      for (const [key, reading] of Object.entries(signals) as Array<[LiveHealthSignalKey, LiveHealthReading]>) {
        if (reading.writerId === this.writer.id) observations[key][this.writer.id] = reading;
      }
      const writers: Record<string, LiveHealthWriter> = { [this.writer.id]: this.writer };
      const fragments = await phase('readFragments', () => this.readFragments(this.paths, sampledAtMs));
      const composeStarted = performance.now();
      mergeLiveHealthFragments(signals, writers, fragments, sampledAtMs, observations);
      const collectedAtMs = this.now();
      signals['latency.monitorTickMs'] = measuredLiveHealthReading({
        key: 'latency.monitorTickMs',
        value: Math.max(0, performance.now() - started),
        writerId: this.writer.id,
        observedAtMs: collectedAtMs,
        collectedAtMs,
        window: liveHealthWindow('delta', sampledAtMs, collectedAtMs),
        confidence: 1,
      });
      observations['latency.monitorTickMs'][this.writer.id] = signals['latency.monitorTickMs'];
      const snapshot: LiveHealthSnapshot = {
        schemaVersion: LIVE_HEALTH_SCHEMA_VERSION,
        sequence: ++this.sequence,
        sampledAtMs,
        monitorStartedAtMs: this.writer.startedAtMs,
        cadenceMs: this.cadenceMs,
        profile: this.profile,
        writers,
        observations,
        signals,
        sourceCustody: this.sourcePin ? {
          kind: 'node-entry-sha256', nativePid: this.writer.pid!, processIdentity: this.sourcePin.processIdentity,
          sha256: this.sourcePin.sha256, sampleStartedAtMs: sampledAtMs, sampleCompletedAtMs: collectedAtMs,
          stableDuringSample: sourceBefore && this.sourceCurrent(this.sourcePin),
        } : null,
        ...(current.storage ? { storage: current.storage } : {}),
      };
      timing.phases.compose = Math.max(0, performance.now() - composeStarted);
      await phase('writeSnapshot', () => this.writeSnapshot(this.paths.snapshotPath, snapshot));
      this.previous = current;
      published(snapshot);
      // READY describes a complete atomic snapshot. Let the main entry emit it
      // before synchronous history compression/validation begins. Keep this whole
      // operation in flight through persistence so timer ticks cannot queue samples.
      await phase('historyYield', () => yieldToEventLoop());
      try {
        await phase('history', () => this.writeHistory(snapshot));
      } catch (error) {
        this.log('[resource-governor-health] history write failed: ' +
          (error instanceof Error ? error.message : String(error)));
      }
      complete = true;
      return snapshot;
    } finally {
      timing.completedAt = performance.now();
      const sampleMs = Math.max(0, timing.completedAt - started);
      if (sampleMs > LIVE_HEALTH_SNAPSHOT_MAX_AGE_MS) {
        // Collection latency alone cannot explain an archive stall or an idle
        // cadence gap. Log measurements, retaining the existing unknown policy.
        this.log('[resource-governor-health] sample exceeded freshness: ' + JSON.stringify({
          sequence: this.sequence, outcome: complete ? 'complete' : 'failed', sampleMs, phases: timing.phases,
        }));
      }
    }
  }

  async start(): Promise<LiveHealthSnapshot> {
    if (this.timer) return this.sampleOnce();
    const lifecycle = this.lifecycle;
    const first = await this.beginSample().ready;
    if (!this.timer && lifecycle === this.lifecycle) this.timer = managedSetInterval(
      'resource-governor-live-health-monitor',
      this.cadenceMs,
      async () => {
        if (this.sampleInFlight) return;
        try {
          await this.sampleOnce();
        } catch (error) {
          this.log(`[resource-governor-health] sample failed: ${error instanceof Error ? error.message : error}`);
        }
      },
      // D-004: must-sample — live host health (loop lag, memory, PSI, pressure) has no
      // event source to subscribe to; the reading only exists once you take it.
      { category: 'watchdog', classification: 'must-sample' },
    );
    return first;
  }

  async stop(): Promise<void> {
    this.lifecycle += 1;
    this.timer?.stop();
    this.timer = null;
    // Normal parent shutdown must preserve the sample whose READY was already
    // emitted, including its archival write. A failed sample is already surfaced
    // to its caller; it must not prevent stopping the process.
    await this.sampleInFlight?.complete.catch(() => {});
  }
}
