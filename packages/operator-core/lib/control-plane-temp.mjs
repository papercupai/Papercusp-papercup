import {
  accessSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp as mkdtempAsync } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const KINDS = new Set(['payload', 'socket', 'log']);
// Reserve enough bytes for the deepest short PTY socket path on Linux.
const SOCKET_TEMP_ROOT_MAX_BYTES = 15;
const RETRYABLE_CODES = new Set([
  'EACCES', 'EEXIST', 'EISDIR', 'EMFILE', 'ENFILE', 'ENOSPC',
  'ENOTDIR', 'ENOENT', 'EPERM', 'EROFS',
]);

function usableDirectory(path, runtimeDir, options) {
  if (options.isUsableDirectory) return options.isUsableDirectory(path);
  try {
    if (!isAbsolute(path)) return false;
    const info = (options.statSync ?? statSync)(path);
    if (!info.isDirectory()) return false;
    if (path === runtimeDir && typeof process.getuid === 'function') {
      if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return false;
    }
    (options.accessSync ?? accessSync)(path, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function retryable(error) {
  return RETRYABLE_CODES.has(error?.code);
}

function assertFilenamePart(value, name) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.includes('/') || value.includes('\\') || value.includes('\0') ||
      value === '.' || value === '..') {
    throw new TypeError('Invalid control-plane temp ' + name);
  }
}

/** Ordered, writable roots for short-lived control-plane files.
 * Payloads prefer shared memory for capacity; sockets and diagnostic logs
 * prefer the per-user runtime directory. The OS temp root is a last resort.
 */
export function controlPlaneTempCandidates(kind = 'payload', options = {}) {
  if (!KINDS.has(kind)) throw new TypeError('Invalid control-plane temp kind: ' + kind);
  const env = options.env ?? process.env;
  const runtimeDir = options.runtimeDir !== undefined
    ? options.runtimeDir
    : (typeof env.XDG_RUNTIME_DIR === 'string' ? env.XDG_RUNTIME_DIR.trim() : '');
  const tempDir = options.tempDir ?? options.tmpdir ?? tmpdir();
  const sharedMemoryDir = options.sharedMemoryDir === undefined ? '/dev/shm' : options.sharedMemoryDir;
  const platform = options.platform ?? process.platform;
  const sharedMemory = platform === 'linux' ? sharedMemoryDir : null;
  const ordered = kind === 'payload'
    ? [sharedMemory, runtimeDir, tempDir]
    : [runtimeDir, sharedMemory, tempDir];
  const seen = new Set();
  const out = [];
  for (const candidate of ordered) {
    if (typeof candidate !== 'string' || !candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (kind === 'socket' && Buffer.byteLength(candidate) > SOCKET_TEMP_ROOT_MAX_BYTES) continue;
    if (usableDirectory(candidate, runtimeDir, options)) out.push(candidate);
  }
  return out;
}

/** Return the preferred writable root without allocating anything. */
export function controlPlaneTempRoot(kind = 'payload', options = {}) {
  const root = controlPlaneTempCandidates(kind, options)[0];
  if (root) return root;
  throw new Error('No writable control-plane temp root for ' + kind);
}

/** Create a private directory, falling back across runtime filesystems if the
 * preferred one is unavailable or full. Node creates mkdtemp directories 0700.
 */
export function createControlPlaneTempDir(prefix, kind = 'payload', options = {}) {
  assertFilenamePart(prefix, 'prefix');
  let lastError = null;
  for (const root of controlPlaneTempCandidates(kind, options)) {
    try {
      return (options.mkdtempSync ?? mkdtempSync)(join(root, prefix));
    } catch (error) {
      if (!retryable(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No writable control-plane temp root for ' + kind);
}

/** Create a private directory and write its payload before choosing a root.
 * If the preferred filesystem fills during the write, discard the partial
 * directory and retry on the next isolated runtime filesystem.
 */
export function createControlPlaneTempDirWithFile(prefix, filename, contents, kind = 'payload', options = {}) {
  assertFilenamePart(prefix, 'prefix');
  assertFilenamePart(filename, 'filename');
  let lastError = null;
  for (const root of controlPlaneTempCandidates(kind, options)) {
    let directory = null;
    try {
      directory = (options.mkdtempSync ?? mkdtempSync)(join(root, prefix));
      (options.writeFileSync ?? writeFileSync)(
        join(directory, filename),
        contents,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      return directory;
    } catch (error) {
      if (directory) {
        try { (options.rmSync ?? rmSync)(directory, { recursive: true, force: true }); }
        catch { /* preserve the allocation error */ }
      }
      if (!retryable(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No writable control-plane temp root for ' + kind);
}

/** Async companion for listeners whose socket directory is created with fs/promises. */
export async function createControlPlaneTempDirAsync(prefix, kind = 'payload', options = {}) {
  assertFilenamePart(prefix, 'prefix');
  let lastError = null;
  for (const root of controlPlaneTempCandidates(kind, options)) {
    try {
      return await (options.mkdtempAsync ?? mkdtempAsync)(join(root, prefix));
    } catch (error) {
      if (!retryable(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No writable control-plane temp root for ' + kind);
}

/** Create a private, uniquely named file and return its path. */
export function createControlPlaneTempFile(prefix, suffix, kind = 'payload', options = {}) {
  assertFilenamePart(prefix, 'prefix');
  assertFilenamePart(suffix, 'suffix');
  let lastError = null;
  for (const root of controlPlaneTempCandidates(kind, options)) {
    const filename = prefix + process.pid + '-' + (options.randomUUID ?? randomUUID)() + suffix;
    const path = join(root, filename);
    let fd = null;
    try {
      fd = (options.openSync ?? openSync)(path, 'wx', 0o600);
      (options.closeSync ?? closeSync)(fd);
      return path;
    } catch (error) {
      if (fd !== null) {
        try { (options.closeSync ?? closeSync)(fd); } catch { /* preserve the original error */ }
      }
      try { (options.unlinkSync ?? unlinkSync)(path); } catch { /* it may not have been created */ }
      if (!retryable(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No writable control-plane temp root for ' + kind);
}
