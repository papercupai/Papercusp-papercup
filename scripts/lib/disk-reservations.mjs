/**
 * Reader for the build disk-reservation ledger (EI-21951384112327922).
 *
 * The ledger is WRITTEN by papercusp-desktop/bin/lib/disk-preflight.sh, which every
 * multi-GB shell build entry point calls. This module is the Node-side READER, so
 * that the Cargo admission gate in cargo-result.mjs stops admitting into space a
 * sidecar/Windows-cross build has already been promised.
 *
 * WHY READ-ONLY HERE: a reservation is a DECLARED demand ("I am about to consume
 * N GB"). The shell callers declare one (8GB staging, 12GB cross-compile); the
 * Cargo gate has no declared demand — it enforces floors, not a size — so it has
 * nothing honest to reserve. Inventing a number would be a guess dressed as a
 * measurement. Respecting other builds' declarations needs no such guess, and is
 * the half that removes the over-commit.
 *
 * FAIL-OPEN, ALWAYS: every failure to locate, read, or parse the ledger returns 0
 * outstanding bytes, matching disk-preflight.sh's rule that a guard which cannot
 * measure must never become a new way for builds to die.
 *
 * ⚠ THE ON-DISK FORMAT AND THE MOUNT KEY ARE SHARED WITH THAT SHELL FILE. If the
 * two derivations ever diverge, the ledger silently SPLITS in two and each side
 * reads an empty ledger — the failure is invisible, and looks exactly like "no
 * other builds are running". disk-reservations.test.ts pins the two against each
 * other by executing both, so drift fails a test instead of disabling the guard.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GIB = 1024 * 1024 * 1024;

/** Ledger root. Mirrors PAPERCUSP_DISK_RESERVATION_DIR in disk-preflight.sh.
 * Scratch placement must not partition the machine-wide reservation ledger. */
export function reservationDir(env = process.env) {
  return env.PAPERCUSP_DISK_RESERVATION_DIR || '/tmp/papercusp-disk-reservations';
}

/**
 * Physical filesystem key, shared with papercusp_mount_key. Bind mounts have
 * different mount points but spend the same bytes; st_dev joins their budgets.
 * Retain the old mount-point fallback where device identity is unavailable.
 * Returns '' when it cannot be determined (caller then fails open).
 */
export function mountKeyForPath(path) {
  const device = deviceForPath(path);
  if (device !== null) return `dev-${device}`;
  try {
    const out = execFileSync('df', ['-Pk', path], { encoding: 'utf8', timeout: 5000 });
    const line = out.split('\n')[1];
    if (!line) return '';
    // -P guarantees one line per fs, so the mount point is everything from field 6.
    const fields = line.trim().split(/\s+/);
    const mount = fields.slice(5).join(' ');
    if (!mount) return '';
    return mount.replace(/[^A-Za-z0-9]/g, '_');
  } catch {
    return '';
  }
}

function deviceForPath(path) {
  while (path) {
    try { return String(statSync(path).dev); } catch { /* missing staging leaf */ }
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  return null;
}

/** Read live pre-upgrade claims without rewriting or losing their identities. */
function reservationKeys(path, ledger, issues, nowSec) {
  const key = mountKeyForPath(path);
  const keys = new Set(key ? [key] : []);
  const device = deviceForPath(path);
  if (device === null) return keys;
  try {
    const directories = new Set(readdirSync(ledger));
    if (![...directories].some((name) => name.startsWith('_'))) return keys;
    let out;
    try {
      out = execFileSync('df', ['-Pk', '-a'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // df reports all readable mounts even when one unrelated mount is denied.
      // Discarding those rows loses known live claims on otherwise healthy disks.
      out = typeof error.stdout === 'string' ? error.stdout : '';
    }
    const mappedLegacy = new Set();
    for (const line of out.split('\n').slice(1)) {
      const mount = line.trim().split(/\s+/).slice(5).join(' ');
      const legacy = mount.replace(/[^A-Za-z0-9]/g, '_');
      if (!mount || !directories.has(legacy)) continue;
      const mountDevice = deviceForPath(mount);
      if (mountDevice === null) continue;
      mappedLegacy.add(legacy);
      if (mountDevice === device) keys.add(legacy);
    }
    // Strict evidence needs the ledger's live demand to be accounted for, not
    // success from unrelated df probes. Empty, expired and dead-owner legacy
    // directories carry no demand. An unmapped live claim still fails closed.
    if (issues) for (const legacy of directories) {
      if (!legacy.startsWith('_') || mappedLegacy.has(legacy)) continue;
      for (const name of readdirSync(join(ledger, legacy))) {
        if (!name.endsWith('.res')) continue;
        let rec;
        try { rec = parseRecord(readFileSync(join(ledger, legacy, name), 'utf8')); }
        catch (error) {
          if (error.code !== 'ENOENT') issues.push(`legacy-claim:${error.code || 'unreadable'}`);
          continue;
        }
        const expires = Number(rec.expires), pid = Number(rec.pid);
        if (rec.expires?.trim() && Number.isFinite(expires) && expires >= 0 && nowSec > expires) continue;
        if (Number.isInteger(pid) && pid > 0 && !ownerStillLive(pid, rec.start, issues)) continue;
        issues.push(`legacy-mounts:unresolved-claim:${legacy}`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') issues?.push(`ledger:${error.code || 'unreadable'}`);
  }
  return keys;
}

/** A pid is live only if it exists AND is the same process that made the claim. */
function ownerStillLive(pid, recordedStart, issues) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'ESRCH') issues?.push(`owner:${error.code || 'unreadable'}`);
    return false; // gone (ESRCH), or not ours to signal (EPERM) — treat as dead
  }
  if (!recordedStart) return true; // no start time recorded (darwin): TTL is the backstop
  let currentStart = '';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parens: split after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(') ') + 2);
    currentStart = rest.split(/\s+/)[19] || '';
  } catch (error) {
    issues?.push(`owner-start:${error.code || 'unreadable'}`);
    return true; // unreadable /proc — fall back to the TTL rather than over-reaping
  }
  if (!currentStart) return true;
  return currentStart === recordedStart; // differs => pid was recycled
}

function parseRecord(text) {
  const rec = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) rec[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return rec;
}

/**
 * Total GB other LIVE builds have reserved on the filesystem containing `path`.
 * Read-only: unlike the shell writer this never reaps, so a concurrent build's
 * ledger is never mutated by a mere reader.
 * @param {string} path
 * @param {{ env?: NodeJS.ProcessEnv, now?: number, issues?: string[] }} [options]
 */
export function readReservedGb(path, { env = process.env, now = Date.now(), issues } = {}) {
  const ledger = reservationDir(env);
  let total = 0;
  const nowSec = Math.floor(now / 1000);
  for (const key of reservationKeys(path, ledger, issues, nowSec)) {
    let entries;
    try { entries = readdirSync(join(ledger, key)); } catch (error) {
      if (error.code !== 'ENOENT') issues?.push(`claims:${error.code || 'unreadable'}`);
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.res')) continue;
      let rec;
      try {
        rec = parseRecord(readFileSync(join(ledger, key, name), 'utf8'));
      } catch (error) {
        // A concurrently released claim is absent, not an unreadable demand.
        if (error.code !== 'ENOENT') issues?.push(`claim:${error.code || 'unreadable'}`);
        continue;
      }
      const pid = Number(rec.pid);
      const gb = Number(rec.gb);
      const expires = Number(rec.expires);
      if (!rec.expires?.trim() || !Number.isFinite(expires) || expires < 0) issues?.push('claim:unknown-expiry');
      if (Number.isFinite(expires) && nowSec > expires) continue;
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(gb) || gb < 0 || (issues && !rec.gb?.trim())) {
        issues?.push('claim:invalid-demand');
        continue;
      }
      if (!ownerStillLive(pid, rec.start, issues)) continue;
      total += gb;
    }
  }
  return total;
}

/** Same, in bytes — the unit assessCargoDiskAdmission takes. */
export function readReservedBytes(path, opts) {
  return readReservedGb(path, opts) * GIB;
}

/** Read the same ledger for evidence, retaining compatibility-reader uncertainty.
 * An absent ledger is measured zero. An unreadable/malformed live claim cannot
 * certify zero demand. This never reserves, reaps, or changes build admission.
 * @param {string} path
 * @param {{ env?: NodeJS.ProcessEnv, now?: number }} [options]
 * @returns {{ state: 'measured' | 'unknown', deviceKey: string, reservedBytes: number | null,
 *   knownReservedBytes: number | null, issues: string[] }}
 */
export function readReservationSnapshot(path, options = {}) {
  const issues = [];
  const deviceKey = mountKeyForPath(path);
  if (!deviceKey.startsWith('dev-')) issues.push('device:unknown');
  const knownReservedBytes = readReservedGb(path, { ...options, issues }) * GIB;
  if (!Number.isSafeInteger(knownReservedBytes) || knownReservedBytes < 0) issues.push('claim:invalid-total');
  return { state: issues.length ? 'unknown' : 'measured', deviceKey,
    reservedBytes: issues.length ? null : knownReservedBytes,
    knownReservedBytes: Number.isSafeInteger(knownReservedBytes) && knownReservedBytes >= 0 ? knownReservedBytes : null,
    issues };
}

/** Strict evidence admission: combine every destination spending the same device.
 * This is a measurement, not a reservation receipt; callers must still reserve.
 * Unlike the build reader, unknown capacity cannot qualify an evidence window.
 *
 * @param {Array<{ path: string, bytes: number }>} allocations destinations and the bytes each will consume
 * @param {{
 *   protectedBytes?: number,
 *   keyForPath?: (path: string) => string,
 *   reservedBytesForPath?: (path: string) => number,
 *   availableBytesForPath?: (path: string) => number,
 * }} [options]
 * @returns {{ admitted: boolean, devices: Array<{
 *   key: string, paths: string[], allocationBytes: number, availableBytes: number,
 *   reservedBytes: number, protectedBytes: number, requiredBytes: number,
 *   effectiveBytes: number, admitted: boolean,
 * }> }} one budget per physical device; admitted only when every device fits
 */
export function assessAllocationDiskAdmission(allocations, {
  protectedBytes = 0,
  keyForPath = mountKeyForPath,
  reservedBytesForPath = readReservedBytes,
  availableBytesForPath = (path) => {
    for (;;) {
      try {
        const fs = statfsSync(path, { bigint: true });
        return Number(fs.bavail * fs.bsize);
      } catch (error) {
        if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
        path = dirname(path);
      }
    }
  },
} = {}) {
  if (!Number.isSafeInteger(protectedBytes) || protectedBytes < 0 || !allocations.length) {
    throw new Error('A non-empty allocation and nonnegative byte budgets are required');
  }
  const devices = new Map();
  for (const { path, bytes } of allocations) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid allocation bytes');
    const key = keyForPath(path);
    if (!key) throw new Error(`Physical filesystem is unknown: ${path}`);
    const available = availableBytesForPath(path);
    const reserved = reservedBytesForPath(path);
    if (![available, reserved].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error(`Filesystem capacity is unknown: ${path}`);
    }
    const device = devices.get(key) ?? { key, paths: [], allocationBytes: 0,
      availableBytes: available, reservedBytes: reserved, protectedBytes };
    device.paths.push(path);
    device.allocationBytes += bytes;
    if (!Number.isSafeInteger(device.allocationBytes)) throw new Error('Allocation exceeds safe byte range');
    // Conservative if measurements change between destinations on one device.
    device.availableBytes = Math.min(device.availableBytes, available);
    device.reservedBytes = Math.max(device.reservedBytes, reserved);
    devices.set(key, device);
  }
  const budgets = [...devices.values()].map((device) => ({ ...device,
    requiredBytes: device.allocationBytes + device.protectedBytes,
    effectiveBytes: device.availableBytes - device.reservedBytes,
    admitted: device.availableBytes - device.reservedBytes >= device.allocationBytes + device.protectedBytes,
  }));
  return { admitted: budgets.every((device) => device.admitted), devices: budgets };
}
