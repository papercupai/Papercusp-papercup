import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const REAP_TAIL_MAX_BYTES = 128 * 1024;
const validTaskId = (id: string) => id.length > 0 && !/[\\/\0]/.test(id) && id !== '.' && id !== '..';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Keep the archive's identity receipt beside its bytes, beyond task-ledger GC. */
export async function archiveReapTail(taskId: string, logPath: string, home = homedir(), at = new Date()): Promise<string> {
  if (!validTaskId(taskId)) throw new Error('Invalid reaper task id');
  const date = at.toISOString().slice(0, 10);
  const directory = join(home, '.papercusp', 'reap-archive', date);
  await mkdir(directory, { recursive: true });
  const source = await open(logPath, 'r');
  let bytes: Buffer;
  try {
    const metadata = await source.stat();
    if (!metadata.isFile()) throw new Error('Reaper log must be a regular file');
    const length = Math.min(metadata.size, REAP_TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await source.read(buffer, 0, length, metadata.size - length);
    bytes = buffer.subarray(0, bytesRead);
  } finally { await source.close(); }
  const destination = join(directory, `${taskId}.tail.log`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const tail = await open(destination, flags, 0o600);
  try { await tail.writeFile(bytes); } finally { await tail.close(); }
  const receipt = await open(`${destination}.receipt.json`, flags, 0o600);
  try {
    await receipt.writeFile(JSON.stringify({ version: 1, producer: 'task-reconcile-reap-tail-archive', taskId, date,
      bytes: bytes.length, sha256: digest(bytes) }));
  } finally { await receipt.close(); }
  return destination;
}

/** A missing, stale, linked or malformed receipt never proves provenance. */
export async function verifyReapTailReceipt(path: string, taskId: string, date: string): Promise<boolean> {
  if (!validTaskId(taskId)) return false;
  try {
    const receipt = await open(`${path}.receipt.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
    let proof;
    try {
      const metadata = await receipt.stat();
      if (!metadata.isFile() || metadata.size > 4096) return false;
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await receipt.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096 || bytesRead !== metadata.size) return false;
      proof = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await receipt.close(); }
    if (proof?.version !== 1 || proof.producer !== 'task-reconcile-reap-tail-archive' || proof.taskId !== taskId || proof.date !== date
      || !Number.isInteger(proof.bytes) || proof.bytes < 0 || proof.bytes > REAP_TAIL_MAX_BYTES || !/^[a-f0-9]{64}$/.test(proof.sha256)) return false;
    const tail = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await tail.stat();
      if (!metadata.isFile() || metadata.size !== proof.bytes) return false;
      const buffer = Buffer.alloc(REAP_TAIL_MAX_BYTES + 1);
      const { bytesRead } = await tail.read(buffer, 0, buffer.length, 0);
      return bytesRead === proof.bytes && digest(buffer.subarray(0, bytesRead)) === proof.sha256;
    } finally { await tail.close(); }
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ELOOP', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
