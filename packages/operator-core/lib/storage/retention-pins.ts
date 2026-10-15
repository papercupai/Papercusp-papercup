/** Agent retention pins use the existing release-retention lease store.
 * The unchanged TSV schema protects pins in both shell and TypeScript deleters;
 * owner/reason metadata lives in the opaque tag, not a parallel pin database.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { defaultRetentionDir, readRetentionPins, RETENTION_SCHEMA, withRetentionPinProtection,
  type RetentionPin } from '../../../../scripts/lib/retention-pins.mjs';
export { readRetentionPins, readRetentionPinsAsync, withRetentionPinProtection,
  retentionPinProtectsPath as pinProtectsPath } from '../../../../scripts/lib/retention-pins.mjs';
export type { RetentionPin } from '../../../../scripts/lib/retention-pins.mjs';

/** The final protection read and deletion share storage:pin's cross-process mutex. */
export async function withUnpinnedPath(path: string, remove: () => boolean | Promise<boolean>): Promise<boolean> {
  return withRetentionPinProtection((isPinned) => isPinned(path) ? false : remove());
}

const TAG_PREFIX = 'agent-pin-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createRetentionPin(input: { path: string; owner: string; reason: string; expiresAt: string },
  options: { dir?: string; nowMs?: number } = {}): RetentionPin {
  const nowMs = options.nowMs ?? Date.now();
  const expiry = Date.parse(input.expiresAt);
  if (!input.owner.trim() || !input.reason.trim()) throw new Error('pin requires an owner and reason');
  if (!Number.isFinite(expiry) || expiry <= nowMs) throw new Error('pin requires a finite future expiry');
  if (!isAbsolute(input.path) || /[\r\n\0]/.test(input.path)) throw new Error('pin requires an absolute path without line breaks');
  const logical = normalize(input.path);
  // A missing target is an error, never a silently ineffective pin.
  const paths = [...new Set([logical, realpathSync(logical)])];
  const dir = options.dir ?? defaultRetentionDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pin: RetentionPin = { id: randomUUID(), owner: input.owner.trim(), reason: input.reason.trim(),
    createdAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiry).toISOString(), paths };
  const tag = TAG_PREFIX + Buffer.from(JSON.stringify({ version: 1, id: pin.id, owner: pin.owner,
    reason: pin.reason, createdAt: pin.createdAt })).toString('base64url');
  const body = [`schema=${RETENTION_SCHEMA}`, `tag=${tag}`, `created_ns=${BigInt(Math.floor(nowMs)) * 1_000_000n}`,
    `expires_ns=${BigInt(expiry) * 1_000_000n}`, ...paths.map((p) => `path=${p}`), ''].join('\n');
  const file = join(dir, `lease-agent-pin-${pin.id}.tsv`);
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return pin;
}

/** Only the pin's authenticated owner can release it through the agent tool. */
export function removeRetentionPin(id: string, owner: string, options: { dir?: string } = {}): boolean {
  if (!UUID.test(id)) throw new Error('invalid pin id');
  const read = readRetentionPins({ ...options, includeExpired: true });
  if (read.errors.length) throw new Error(`retention pins unreadable: ${read.errors.join('; ')}`);
  const pin = read.pins.find((p) => p.id === id);
  if (!pin) return false;
  if (pin.owner !== owner) throw new Error('only the pin owner may release it');
  unlinkSync(join(options.dir ?? defaultRetentionDir(), `lease-agent-pin-${id}.tsv`));
  return true;
}
