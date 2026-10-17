/**
 * Linux administrator policy for the existing desktop update lane.
 *
 * Provision /etc/papercusp/managed-policy.json as root, mode 0644 (or stricter):
 *   { "version": 1, "update_channel": "stable" }
 * All ancestors must be real root-owned directories without group/other write
 * permission. No environment/path override: user-owned configuration and the
 * operator database must not be able to bypass an administrator's update ring.
 * Absence is unmanaged; a present but invalid/unreadable policy fails closed.
 * This is a Linux source contract, not Intune/Jamf/package qualification.
 */
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import type { Stats } from 'node:fs';
import type { UpdateChannel } from './endpoint-route/routes/desktop/setup-wizard-state';

export const MANAGED_UPDATE_POLICY_PATH = '/etc/papercusp/managed-policy.json';
const MAX_POLICY_BYTES = 16_384;

export class ManagedUpdatePolicyError extends Error {
  constructor(
    readonly code: 'managed_policy_invalid' | 'update_channel_managed',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedUpdatePolicyError';
  }

  get status(): 409 | 503 {
    return this.code === 'update_channel_managed' ? 409 : 503;
  }
}

function invalid(): never {
  throw new ManagedUpdatePolicyError(
    'managed_policy_invalid',
    `Administrator update policy at ${MANAGED_UPDATE_POLICY_PATH} is invalid or unreadable.`,
  );
}

function trusted(stat: Stats): boolean {
  return stat.uid === 0 && (stat.mode & 0o022) === 0;
}

/** Re-read on each decision, so administrator changes need no process restart. */
export function readManagedUpdateChannel(): UpdateChannel | null {
  if (process.platform !== 'linux') return null;
  let fd: number | undefined;
  try {
    for (const path of ['/', '/etc', '/etc/papercusp']) {
      let stat: Stats;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (path === '/etc/papercusp' && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      if (!stat.isDirectory() || !trusted(stat)) invalid();
    }
    try {
      // NONBLOCK prevents a substituted FIFO from hanging before fstat rejects it.
      fd = openSync(MANAGED_UPDATE_POLICY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const before = fstatSync(fd);
    if (!before.isFile() || !trusted(before) || before.nlink !== 1 || before.size < 1 || before.size > MAX_POLICY_BYTES) invalid();
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    const after = fstatSync(fd);
    if (bytes > MAX_POLICY_BYTES || bytes !== before.size ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink) invalid();
    const policy: unknown = JSON.parse(buffer.toString('utf8', 0, bytes));
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) invalid();
    const record = policy as Record<string, unknown>;
    if (record.version !== 1 || Object.keys(record).some(key => key !== 'version' && key !== 'update_channel')) invalid();
    if (record.update_channel !== 'alpha' && record.update_channel !== 'beta' && record.update_channel !== 'stable') invalid();
    return record.update_channel;
  } catch (error) {
    if (error instanceof ManagedUpdatePolicyError) throw error;
    return invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
