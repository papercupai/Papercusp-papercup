// D-010: installed runtime eligibility must be checked before PostgreSQL boot.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyTauriSignature } from '@papercusp/tauri-release-kit/signature';
import type { ApplicationRuntimeAcceptanceRequest } from './application-runtime-acceptance';
import type { ApplicationRuntimeAcceptance } from './bundled-node';

// Only the compiler supplies this key, from this source cut's tauri.conf.json.
// Source/dev builds have no trust root. Environment and receipt keys are ignored.
declare const __PAPERCUSP_RUNTIME_ACCEPTANCE_PUBLIC_KEY__: string | undefined;
const compiledPublicKey = typeof __PAPERCUSP_RUNTIME_ACCEPTANCE_PUBLIC_KEY__ === 'string'
  ? __PAPERCUSP_RUNTIME_ACCEPTANCE_PUBLIC_KEY__ : '';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const envelopeSchema = z.object({
  schemaVersion: z.literal('application-runtime-acceptance/v1'),
  planSlug: z.literal('node-to-bun-staged-migration-2026-10-22'), harnessSlug: z.string().min(1),
  canonicalSnapshotHash: digest, issuedAt: z.number().int().nonnegative(),
  acceptance: z.object({
    verdict: z.literal('accepted'), evidenceRef: z.string().min(1),
    candidateSha256: digest, sourceSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    role: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), binarySha256: digest,
    nodeBinarySha256: digest, entrypointSha256: digest, validUntil: z.number().int().positive(),
  }).strict(),
}).strict();

/** Canonical eligibility at issuance through signed expiry; offline revocations are unknowable. */
export async function readSignedApplicationRuntimeAcceptance(request: ApplicationRuntimeAcceptanceRequest & {
  envelope: Uint8Array; signature: string; trustedPublicKey: string;
}): Promise<ApplicationRuntimeAcceptance | null> {
  if (!request.envelope.length || request.envelope.length > 64 * 1024 || request.signature.length > 16 * 1024
    || !request.trustedPublicKey || request.trustedPublicKey.length > 8192) return null;
  const { candidate, role, harnessSlug, evidenceRef } = structuredClone({ candidate: request.candidate,
    role: request.role, harnessSlug: request.harnessSlug, evidenceRef: request.evidenceRef });
  const envelope = await verifyEnvelope(request.envelope, request.signature, request.trustedPublicKey);
  if (!envelope) return null;
  const { acceptance } = envelope;
  if (!candidate.bun || !candidate.roles.includes(role) || envelope.harnessSlug !== harnessSlug
    || acceptance.evidenceRef !== evidenceRef || acceptance.role !== role
    || acceptance.candidateSha256 !== candidate.candidateSha256 || acceptance.sourceSha !== candidate.sourceSha
    || acceptance.binarySha256 !== candidate.bun.binarySha256
    || acceptance.nodeBinarySha256 !== candidate.node.binarySha256
    || acceptance.entrypointSha256 !== candidate.entrypointSha256) return null;
  return acceptance;
}

async function verifyEnvelope(envelope: Uint8Array, signatureText: string, key: string) {
  if (!key || key.length > 8192 || !envelope.length || envelope.length > 64 * 1024
    || !signatureText || signatureText.length > 16 * 1024) return null;
  const bytes = Buffer.from(envelope);
  const signature = await verifyTauriSignature(key, signatureText,
    algo => algo === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes);
  if (!signature.valid) return null;
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) return null;
    const { issuedAt, acceptance } = parsed.data;
    const now = Date.now();
    return issuedAt <= now && issuedAt < acceptance.validUntil && acceptance.validUntil > now ? parsed.data : null;
  } catch { return null; }
}

function boundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error('invalid eligibility file size/type');
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > limit) throw new Error('eligibility file grew');
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}

/** Companion is outside the immutable sidecar, selected by exact provenance digest. */
export async function readInstalledApplicationRuntimeAcceptance(
  request: ApplicationRuntimeAcceptanceRequest, sidecarDir: string,
): Promise<ApplicationRuntimeAcceptance | null> {
  if (!compiledPublicKey || !digest.safeParse(request.candidate.candidateSha256).success) return null;
  const base = resolve(sidecarDir, '..', 'runtime-acceptance', request.candidate.candidateSha256);
  try {
    return await readSignedApplicationRuntimeAcceptance({ ...request, trustedPublicKey: compiledPublicKey,
      envelope: boundedFile(base + '.json', 64 * 1024),
      signature: boundedFile(base + '.json.sig', 16 * 1024).toString('utf8').trim() });
  } catch { return null; }
}

/** Install separately from frozen package bytes; validity is rechecked on every boot. */
export async function installApplicationRuntimeAcceptance(envelopePath: string, signaturePath: string, sidecarDir: string) {
  const envelope = boundedFile(envelopePath, 64 * 1024);
  const signature = boundedFile(signaturePath, 16 * 1024).toString('utf8').trim();
  const verified = await verifyEnvelope(envelope, signature, compiledPublicKey);
  if (!verified) throw new Error('runtime eligibility signature, trust root or expiry refused');
  const dir = resolve(sidecarDir, '..', 'runtime-acceptance');
  mkdirSync(dir, { recursive: true });
  const base = resolve(dir, verified.acceptance.candidateSha256);
  const temp = base + '.' + process.pid + '.' + Date.now();
  try {
    writeFileSync(temp + '.json', envelope, { flag: 'wx', mode: 0o644 });
    writeFileSync(temp + '.sig', signature + '\n', { flag: 'wx', mode: 0o644 });
    // A concurrent boot during replacement may refuse a mismatched pair. It
    // can never authorize one; the next boot rechecks the complete signature.
    renameSync(temp + '.sig', base + '.json.sig');
    renameSync(temp + '.json', base + '.json');
  } finally {
    rmSync(temp + '.json', { force: true }); rmSync(temp + '.sig', { force: true });
  }
  return { candidateSha256: verified.acceptance.candidateSha256, validUntil: verified.acceptance.validUntil };
}
