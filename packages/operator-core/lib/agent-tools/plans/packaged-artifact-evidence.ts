/** Independently measure final package bytes named by a measured operational receipt. */
import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const normalizedPath = z.string().min(1).max(1000).refine(value =>
  !isAbsolute(value) && !value.includes('\\') &&
  !value.split('/').some(part => ['', '.', '..'].includes(part)));
const receiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('operational-test-evidence'),
  exitCode: z.literal(0),
  assertions: z.array(z.object({ passed: z.literal(true) }).passthrough()).min(1).max(100),
  artifactRoot: z.string().min(1).max(4096).refine(isAbsolute),
  runtimeArtifacts: z.array(z.object({
    path: normalizedPath, sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(32 * 1024 ** 3),
  }).strict()).min(1).max(32),
}).passthrough();

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * No process is invented for a completed package. Stream its retained bytes and
 * pin the open file's identity on both sides of the read. Initial binding checks
 * the receipt's expected digests; subsequent reads return actual digests so a
 * replacement is stale. Missing/unsafe/unstable files fail closed as unknown.
 */
export async function measurePackagedArtifactEnvironment(
  repoRoot: string, receiptPath: string, receiptSha256: string,
  options: { verifyExpectations?: boolean } = {},
): Promise<string> {
  const root = await realpath(repoRoot);
  const receiptFile = await realpath(resolve(root, receiptPath));
  if (!contained(root, receiptFile)) throw new Error('package_receipt_outside_root');
  const info = await stat(receiptFile);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('package_receipt_invalid_size');
  const raw = await readFile(receiptFile);
  if (createHash('sha256').update(raw).digest('hex') !== receiptSha256) {
    throw new Error('package_receipt_changed_since_source_measurement');
  }
  const receipt = receiptSchema.parse(JSON.parse(raw.toString('utf8')));
  if (new Set(receipt.runtimeArtifacts.map(artifact => artifact.path)).size !== receipt.runtimeArtifacts.length) {
    throw new Error('package_artifact_duplicate_path');
  }
  const artifactRoot = await realpath(receipt.artifactRoot);
  const entries = [];
  for (const artifact of receipt.runtimeArtifacts.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    const path = await realpath(resolve(artifactRoot, artifact.path));
    if (!contained(artifactRoot, path)) throw new Error('package_artifact_outside_root');
    const file = await open(path, 'r');
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(32 * 1024 ** 3)) throw new Error('package_artifact_invalid_size');
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat({ bigint: true });
      const current = await stat(path, { bigint: true });
      const pin = (value: typeof before) =>
        [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
      if (pin(before) !== pin(after) || pin(after) !== pin(current) ||
        await realpath(resolve(artifactRoot, artifact.path)) !== path) {
        throw new Error('package_artifact_changed_during_measurement');
      }
      const sha256 = hash.digest('hex');
      const bytes = Number(after.size);
      if (options.verifyExpectations && (sha256 !== artifact.sha256 || bytes !== artifact.bytes)) {
        throw new Error(`package_artifact_receipt_mismatch:${artifact.path}`);
      }
      entries.push({ path: artifact.path, bytes, sha256 });
    } finally {
      await file.close();
    }
  }
  return 'sha256-packaged-artifact-set-v1:' + createHash('sha256')
    .update(JSON.stringify({ artifactRoot, entries })).digest('hex');
}
