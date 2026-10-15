/**
 * PostgreSQL SCRAM-SHA-256 password verifiers, computed locally
 * (plan cloud-portal-public-release-2026-10-13, P-004).
 *
 * `CREATE ROLE … PASSWORD 'SCRAM-SHA-256$…'` stores a pre-hashed verifier as-is. The
 * Cloud SQL provisioner uses it so the role's plaintext password exists in exactly
 * one place, Secret Manager, and never appears in the SQL text sent to the
 * ExecuteSql API, in argv or in an audit log.
 *
 * Format (PostgreSQL `scram_build_secret`, RFC 5802 / RFC 7677):
 *   SCRAM-SHA-256$<iterations>:<salt b64>$<StoredKey b64>:<ServerKey b64>
 * The password must already be SASLprep-normalized. `generatePassword` emits only
 * base64url characters, for which SASLprep is the identity, so it is safe here.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export const SCRAM_ITERATIONS = 4096;
const SALT_BYTES = 16;

const hmac = (key: Buffer, data: string | Buffer): Buffer => createHmac('sha256', key).update(data).digest();

export interface ScramVerifierParts {
  iterations: number;
  salt: Buffer;
  storedKey: Buffer;
  serverKey: Buffer;
}

export function scramVerifierParts(
  password: string,
  salt: Buffer = randomBytes(SALT_BYTES),
  iterations: number = SCRAM_ITERATIONS,
): ScramVerifierParts {
  if (!password) throw new Error('scram: empty password');
  if (!Number.isInteger(iterations) || iterations < 4096) throw new Error('scram: iterations must be an integer >= 4096');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  return {
    iterations,
    salt,
    storedKey: createHash('sha256').update(clientKey).digest(),
    serverKey: hmac(salted, 'Server Key'),
  };
}

export function scramSha256Verifier(password: string, salt?: Buffer, iterations?: number): string {
  const p = scramVerifierParts(password, salt, iterations);
  return `SCRAM-SHA-256$${p.iterations}:${p.salt.toString('base64')}$${p.storedKey.toString('base64')}:${p.serverKey.toString('base64')}`;
}

/** A 256-bit random password using only base64url characters (SASLprep-stable, URL-safe). */
export function generatePassword(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
