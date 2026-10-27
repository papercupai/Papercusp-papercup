/** Host-only full-image census plus the maintained committed-source hold oracle. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { moduleRepoRoot } from './module-repo-root';
import type { VerifierSourceReceipt } from '@papercusp/test-config/verifier-source';
import { restrictedFrozenSourceRefusal } from './agent-tools/testing/restricted-hold-fence';
import { runtimeSourceImageOrigin, type RuntimeSourceImage } from './blind-review-source-image';
import type { RuntimeSourceAdmission } from './blind-review-runtime-custody';

const helper = join(moduleRepoRoot(import.meta.url), 'scripts/lib/blind-review-sealed-source.py');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const generations = new WeakMap<RuntimeSourceImage, Map<string, string>>();

async function census(image: RuntimeSourceImage, signal?: AbortSignal): Promise<{
  version: number; source: VerifierSourceReceipt; generatedSha256: string;
}> {
  const child = spawn('/usr/bin/python3', ['-I', '-S', helper, 'inspect', '--sha256', image.imageSha256,
    '--max-bytes', String(image.imageBytes), '--manifest-sha256', image.manifestSha256],
  { stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    signal, timeout: 120_000 });
  return await new Promise((resolve, reject) => {
    let encoded = '', failure: unknown;
    child.stderr!.resume();
    // setEncoding: Node's own decoder holds a UTF-8 character split across two
    // chunks; a per-chunk toString() would turn it into replacement chars (WI-6728).
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      encoded += chunk;
      if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) {
        failure = new Error('broker_source_census_oversized'); child.kill();
      }
    });
    child.once('error', error => { failure ??= error; });
    child.once('close', code => {
      if (failure || code !== 0) { reject(failure ?? new Error('broker_source_census_failed')); return; }
      try { resolve(JSON.parse(encoded)); } catch { reject(new Error('broker_source_census_invalid')); }
    });
  });
}

/**
 * Produces input for the existing custody transaction, not a runtime lease.
 * Both this census and subsequent mount-exec receive image.handle.fd directly:
 * no child reopens the donor, and the kernel seal prevents drift between them.
 */
export async function admitRuntimeSourceImage(image: RuntimeSourceImage, options: {
  repositoryId: string; signal?: AbortSignal;
}): Promise<RuntimeSourceAdmission> {
  options.signal?.throwIfAborted();
  const origin = runtimeSourceImageOrigin(image);
  if (!options.repositoryId || options.repositoryId.length > 200) throw new Error('broker_repository_identity_invalid');
  const measured = await census(image, options.signal);
  if (measured.version !== 1 || measured.source.sourceCommit !== image.sourceCommit ||
      hash(measured.source) !== origin.sourceReceiptSha256 ||
      hash(measured.source.files) !== image.sourceTreeHash || measured.generatedSha256 !== origin.generatedSha256)
    throw new Error('broker_source_census_identity_changed');
  const refusal = await restrictedFrozenSourceRefusal(origin.repositoryRoot, measured.source);
  if (refusal) throw new Error(refusal.error);
  options.signal?.throwIfAborted();
  // A same-image retry is still fully measured, but must name the same census
  // generation so the durable admission tuple cannot change on a retry.
  let repositories = generations.get(image);
  if (!repositories) { repositories = new Map(); generations.set(image, repositories); }
  let censusGeneration = repositories.get(options.repositoryId);
  if (!censusGeneration) { censusGeneration = randomUUID(); repositories.set(options.repositoryId, censusGeneration); }
  return Object.freeze({ repositoryId: options.repositoryId, sourceCommit: image.sourceCommit,
    sourceTreeHash: image.sourceTreeHash, sourceInputsHash: image.sourceInputsHash,
    sourceImageNonce: image.sourceImageNonce, censusStatus: 'admit' as const, censusGeneration });
}
