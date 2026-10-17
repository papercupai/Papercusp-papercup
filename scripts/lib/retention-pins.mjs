// Portable runtime for the existing release-retention TSV store. Standalone
// desktop/VH cleaners and the server share this parser and filesystem mutex.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { withFsMutex } from './fs-mutex.mjs';

export const RETENTION_SCHEMA = 'papercusp-release-retention/v1';
const TAG_PREFIX = 'agent-pin-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function defaultRetentionDir(env = process.env) {
  return env.PAPERCUSP_RELEASE_RETENTION_ROOT || join(homedir(), '.papercusp', 'release-retention');
}

export function versionFromTag(tag) {
  return /^desktop-v(\d+\.\d+\.\d+)(?:-|$)/.exec(tag)?.[1] ?? null;
}

// Mirrors release_artifacts_retention_lease_read_paths. Unknown lines fail closed.
export function parseRetentionLease(file, text) {
  let schema = '';
  let tag = '';
  let expires = null;
  const paths = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq) : '';
    const value = eq > 0 ? line.slice(eq + 1) : '';
    if (key === 'schema') schema = value;
    else if (key === 'tag') tag = value;
    else if (key === 'created_ns') continue;
    else if (key === 'expires_ns') {
      if (!/^\d+$/.test(value)) return { ok: false, file, reason: 'invalid expires_ns' };
      expires = BigInt(value);
    } else if (key === 'path') paths.push(value);
    else return { ok: false, file, reason: `unexpected line '${line.slice(0, 40)}'` };
  }
  if (schema !== RETENTION_SCHEMA) return { ok: false, file, reason: `schema '${schema}'` };
  if (!tag) return { ok: false, file, reason: 'missing tag' };
  if (expires === null) return { ok: false, file, reason: 'missing expires_ns' };
  return { ok: true, lease: { file, tag, version: versionFromTag(tag), expiresNs: expires, paths } };
}

export function isLeaseLive(lease, nowMs) {
  return lease.expiresNs === 0n || lease.expiresNs > BigInt(Math.floor(nowMs)) * 1_000_000n;
}

const errText = error => (error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error)).slice(0, 160);

export function readRetentionLeases(dir) {
  const result = { leases: [], errors: [] };
  let names;
  try { names = readdirSync(dir); } catch (error) {
    if (error.code !== 'ENOENT') result.errors.push(`${dir}:${errText(error)}`);
    return result;
  }
  for (const name of names) {
    if (!/^lease-.*\.tsv$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const parsed = parseRetentionLease(file, readFileSync(file, 'utf8'));
      if (parsed.ok) result.leases.push(parsed.lease);
      else result.errors.push(`${name}:${parsed.reason}`);
    } catch (error) { result.errors.push(`${name}:${errText(error)}`); }
  }
  return result;
}

function pinsFromLeases(read, options) {
  const errors = [...read.errors];
  const pins = [];
  for (const lease of read.leases) {
    const pinFile = /[\\/]lease-agent-pin-[^\\/]+\.tsv$/.test(lease.file);
    if (!lease.tag.startsWith(TAG_PREFIX)) {
      if (pinFile) errors.push(`${lease.file}: missing pin metadata`);
      continue;
    }
    try {
      const meta = JSON.parse(Buffer.from(lease.tag.slice(TAG_PREFIX.length), 'base64url').toString('utf8'));
      if (meta.version !== 1 || !UUID.test(meta.id) || typeof meta.owner !== 'string' || !meta.owner.trim() ||
          typeof meta.reason !== 'string' || !meta.reason.trim() || !Number.isFinite(Date.parse(meta.createdAt)) ||
          lease.expiresNs <= 0n || !lease.paths.length || lease.paths.some(p => !isAbsolute(p) || /[\r\n\0]/.test(p))) {
        throw new Error('invalid pin metadata');
      }
      const expiresAt = new Date(Number(lease.expiresNs / 1_000_000n)).toISOString();
      if (options.includeExpired || isLeaseLive(lease, options.nowMs ?? Date.now())) {
        pins.push({ id: meta.id, owner: meta.owner, reason: meta.reason, createdAt: meta.createdAt, expiresAt, paths: lease.paths });
      }
    } catch (error) { errors.push(`${lease.file}: ${errText(error)}`); }
  }
  return { pins: pins.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), errors };
}

export function readRetentionPins(options = {}) {
  return pinsFromLeases(readRetentionLeases(options.dir ?? defaultRetentionDir()), options);
}

export async function readRetentionPinsAsync(options = {}) {
  const dir = options.dir ?? defaultRetentionDir();
  const read = { leases: [], errors: [] };
  try {
    for (const name of await readdir(dir)) {
      if (!/^lease-.*\.tsv$/.test(name)) continue;
      const file = join(dir, name);
      try {
        const parsed = parseRetentionLease(file, await readFile(file, 'utf8'));
        if (parsed.ok) read.leases.push(parsed.lease);
        else read.errors.push(`${name}:${parsed.reason}`);
      } catch (error) { read.errors.push(`${name}:${errText(error)}`); }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') read.errors.push(`${dir}:${errText(error)}`);
  }
  return pinsFromLeases(read, options);
}

/** A pin covers descendants and containing entries, excluding sibling prefixes. */
export function retentionPinProtectsPath(path, pins, nowMs = Date.now()) {
  const candidate = normalize(path);
  const contains = (outer, inner) => outer === '/' || outer === inner || inner.startsWith(outer + '/');
  return pins.some(pin => Date.parse(pin.expiresAt) > nowMs && pin.paths.some(p =>
    contains(normalize(p), candidate) || contains(candidate, normalize(p))));
}

/** For callers ALREADY holding papercusp-disk-retention. Never acquires a second lock. */
export function pinProtection(pins, nowMs = Date.now(), resolvePath = realpathSync) {
  return path => {
    let physical = path;
    try { physical = resolvePath(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return retentionPinProtectsPath(path, pins, nowMs) || retentionPinProtectsPath(physical, pins, nowMs);
  };
}

/** Final protection read and the entire destructive operation share storage:pin's mutex. */
export async function withRetentionPinProtection(work, options = {}) {
  return withFsMutex('papercusp-disk-retention', async () => {
    const nowMs = options.nowMs ?? Date.now();
    const read = await readRetentionPinsAsync({ ...options, nowMs });
    if (read.errors.length) throw new Error(`retention pins unreadable: ${read.errors.join('; ')}`);
    return work(pinProtection(read.pins, nowMs, options.resolvePath));
  }, { onWaiting: options.onWaiting });
}
