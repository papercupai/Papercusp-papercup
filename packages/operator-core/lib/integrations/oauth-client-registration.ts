/**
 * OAuth client registrations a provider package resolves through `clientRegistrationRef`
 * (plan cupboard-distributable-integrations-2026-10-10 P-009; SPEC-R-2-P-009, SPEC-R-7-P-009).
 *
 * A provider package never carries a client secret: the SDK refuses a secret-named key in
 * `provider.oauth`, so each owner registers an OAuth app with the vendor and gives the host its
 * client ID and secret. They live host-side in `oauth-apps.json` under the papercusp root, keyed by
 * the credential group's registration ref. This module is the one place that:
 *  - derives that key (`clientRegistrationRefOf`), which the connect path and the settings page
 *    both use, so the page saves exactly the entry the connect flow reads;
 *  - reads an entry (`readOAuthClientRegistration`), the reader behind `resolveOAuthProvider`;
 *  - reports an entry's status without its secret (`oauthClientRegistrationStatus`);
 *  - writes one entry (`saveOAuthClientRegistration`), atomically, mode 0600, keeping every other
 *    entry in the file (the legacy GitHub and Facebook loader reads the same file).
 *
 * No read path here returns a client secret, and no refusal message carries a submitted value.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';
import { operatorApiBase } from '../operator-api-base';
import { papercuspPath } from '../papercusp-root';

export const OAUTH_APPS_FILE = 'oauth-apps.json';

/** One entry of oauth-apps.json, as the connect path reads it. */
export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  clientSecretFile?: string;
  redirectUri?: string;
  /** When this host last saved the entry from the settings page (ISO-8601); absent for hand-written entries. */
  savedAt?: string;
}

/** What the settings page may know about a registration. Never the secret. */
export interface OAuthClientRegistrationStatus {
  /** The oauth-apps.json key this provider's connect flow reads. */
  ref: string;
  configured: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  /** The redirect URL to enter in the vendor's app settings: the registration's own, else the operator's callback. */
  redirectUri: string;
  savedAt: string | null;
}

export type OAuthClientRegistrationErrorCode =
  | 'invalid-client-id'
  | 'invalid-client-secret'
  | 'client-secret-required'
  | 'registrations-unreadable';

export class OAuthClientRegistrationError extends Error {
  constructor(
    readonly code: OAuthClientRegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthClientRegistrationError';
  }
}

const MAX_CLIENT_ID = 512;
const MAX_CLIENT_SECRET = 4096;

/** The credential group a descriptor's OAuth connection belongs to (one token per group). */
export function credentialGroupOf(descriptor: ProviderDescriptor): string {
  return descriptor.oauth?.credentialGroup ?? descriptor.id;
}

/**
 * The oauth-apps.json key for a descriptor's OAuth client: the group lead's (first member by id)
 * `clientRegistrationRef`, else the group id. Null when the descriptor has no OAuth block.
 * `registered` is every registered descriptor; the descriptor itself counts as a member.
 */
export function clientRegistrationRefOf(descriptor: ProviderDescriptor, registered: readonly ProviderDescriptor[]): string | null {
  if (!descriptor.oauth) return null;
  const group = credentialGroupOf(descriptor);
  const members = [descriptor, ...registered.filter((entry) => entry.id !== descriptor.id)]
    .filter((entry) => entry.oauth && credentialGroupOf(entry) === group)
    .sort((a, b) => a.id.localeCompare(b.id));
  return members[0]?.oauth?.clientRegistrationRef ?? group;
}

/** The operator's provider-neutral OAuth callback, used when a registration names no redirect. */
export function defaultOAuthRedirectUri(): string {
  return new URL('/api/oauth/callback', operatorApiBase()).toString();
}

function registrationsPath(): string {
  return papercuspPath(OAUTH_APPS_FILE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The whole file. Missing → empty; present but not a JSON object → null (never treated as empty). */
async function readRegistrationsFile(): Promise<Record<string, unknown> | null> {
  // Resolved outside the try: a root that cannot be resolved is a host fault, not an unreadable file.
  const path = registrationsPath();
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asRegistration(value: unknown): OAuthClientRegistration | null {
  if (!isPlainObject(value) || typeof value.clientId !== 'string' || !value.clientId) return null;
  return value as unknown as OAuthClientRegistration;
}

/** One registration entry, or null when absent, malformed, or the file cannot be read. */
export async function readOAuthClientRegistration(ref: string): Promise<OAuthClientRegistration | null> {
  const file = await readRegistrationsFile();
  return file ? asRegistration(file[ref]) : null;
}

function statusOf(ref: string, entry: OAuthClientRegistration | null): OAuthClientRegistrationStatus {
  return {
    ref,
    configured: entry !== null,
    clientId: entry?.clientId ?? null,
    hasClientSecret: Boolean(entry && (entry.clientSecret || entry.clientSecretFile)),
    redirectUri: entry?.redirectUri ?? defaultOAuthRedirectUri(),
    savedAt: typeof entry?.savedAt === 'string' ? entry.savedAt : null,
  };
}

/** Status for one registration ref. Never carries the client secret. */
export async function oauthClientRegistrationStatus(ref: string): Promise<OAuthClientRegistrationStatus> {
  return statusOf(ref, await readOAuthClientRegistration(ref));
}

/** Status for several refs from one read of the file (the settings overview). */
export async function oauthClientRegistrationStatuses(refs: readonly string[]): Promise<Map<string, OAuthClientRegistrationStatus>> {
  const file = (await readRegistrationsFile()) ?? {};
  return new Map(refs.map((ref) => [ref, statusOf(ref, asRegistration(file[ref]))]));
}

/** A client ID or secret: one line of printable, non-space characters within a length cap. */
function credentialValueIssue(value: string, max: number): string | null {
  if (value.length === 0) return 'is empty';
  if (value.length > max) return `is longer than ${max} characters`;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return 'contains spaces or control characters';
  return null;
}

export interface SaveOAuthClientRegistrationInput {
  clientId: unknown;
  /** Omitted or empty keeps the secret already saved. */
  clientSecret?: unknown;
}

export interface SaveOAuthClientRegistrationOptions {
  /** True when the provider's flow needs a client secret (it does not use PKCE). */
  requireSecret: boolean;
}

// One writer at a time in this process, so two saves never interleave their read-modify-write.
const writer = pinModuleState('@papercusp/operator-core.oauth-client-registration.writer', () => ({
  tail: Promise.resolve() as Promise<unknown>,
}));

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writer.tail.then(task, task);
  writer.tail = run.catch(() => undefined);
  return run;
}

async function writeRegistrationsFile(next: Record<string, unknown>): Promise<void> {
  const target = registrationsPath();
  await fs.mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Save the client ID (and, when given, the secret) for one registration ref. An inline secret
 * replaces a `clientSecretFile`; an omitted secret keeps whichever one is saved. Other keys of the
 * entry (a custom `redirectUri`) and every other entry in the file are kept. Returns the status.
 */
export async function saveOAuthClientRegistration(
  ref: string,
  input: SaveOAuthClientRegistrationInput,
  options: SaveOAuthClientRegistrationOptions,
): Promise<OAuthClientRegistrationStatus> {
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  const idIssue = credentialValueIssue(clientId, MAX_CLIENT_ID);
  if (idIssue) throw new OAuthClientRegistrationError('invalid-client-id', `Client ID ${idIssue}.`);
  const secretGiven = typeof input.clientSecret === 'string' && input.clientSecret.trim() !== '';
  if (input.clientSecret !== undefined && input.clientSecret !== null && typeof input.clientSecret !== 'string') {
    throw new OAuthClientRegistrationError('invalid-client-secret', 'Client secret must be text.');
  }
  const clientSecret = secretGiven ? (input.clientSecret as string).trim() : undefined;
  if (clientSecret !== undefined) {
    const secretIssue = credentialValueIssue(clientSecret, MAX_CLIENT_SECRET);
    if (secretIssue) throw new OAuthClientRegistrationError('invalid-client-secret', `Client secret ${secretIssue}.`);
  }

  return serialized(async () => {
    const file = await readRegistrationsFile();
    if (!file) {
      throw new OAuthClientRegistrationError(
        'registrations-unreadable',
        `${OAUTH_APPS_FILE} exists but is not a JSON object; fix or remove it before saving here.`,
      );
    }
    const previous = isPlainObject(file[ref]) ? (file[ref] as Record<string, unknown>) : {};
    const next: Record<string, unknown> = { ...previous, clientId, savedAt: new Date().toISOString() };
    if (clientSecret !== undefined) {
      next.clientSecret = clientSecret;
      delete next.clientSecretFile;
    }
    if (options.requireSecret && !next.clientSecret && !next.clientSecretFile) {
      throw new OAuthClientRegistrationError('client-secret-required', 'This provider needs the app’s client secret as well as its client ID.');
    }
    await writeRegistrationsFile({ ...file, [ref]: next });
    return statusOf(ref, asRegistration(next));
  });
}
