import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_HOSTED_ACCEPTANCE_ORIGIN = 'https://app.papercusp.com';

export interface HostedHttp1AcceptanceConfig {
  origin: string;
  storageStatePath: string;
  evidenceDir: string;
  proxyServer?: string;
  slo: {
    coldHydrationMs: number;
    finiteInteractionMs: number;
    reconnectReplayMs: number;
    fcpMs: number;
    lcpMs: number;
    syncQueueWaitMs: number;
  };
}

function exactLoopbackSocksProxy(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_PROXY must be an exact loopback SOCKS5 URL');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'socks5:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_PROXY must be an exact loopback SOCKS5 URL');
  }
  return `${url.protocol}//${url.hostname}:${url.port}`;
}

function exactHttpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN must be an exact HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN must be an exact HTTPS origin');
  }
  return url.origin;
}

function positiveMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function secureStorageStatePath(raw: string | undefined, cwd: string): string {
  if (!raw?.trim()) {
    throw new Error(
      'PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE is required; point it at a chmod 600 Playwright storage-state file',
    );
  }
  const file = isAbsolute(raw) ? raw : resolve(cwd, raw);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE must name an existing file');
  }
  if ((statSync(file).mode & 0o077) !== 0) {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE must not be readable by group or other users (chmod 600)');
  }
  return file;
}

/**
 * Parse the live-only acceptance profile. Missing auth is a hard failure, never
 * a skipped/anonymous run that could be mistaken for hosted acceptance.
 */
export function readHostedHttp1AcceptanceConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): HostedHttp1AcceptanceConfig {
  const origin = exactHttpsOrigin(
    env.PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN ?? DEFAULT_HOSTED_ACCEPTANCE_ORIGIN,
  );
  const storageStatePath = secureStorageStatePath(
    env.PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE,
    cwd,
  );
  const evidenceDir = resolve(
    env.PAPERCUSP_HOSTED_ACCEPTANCE_EVIDENCE_DIR?.trim() ||
      resolve(tmpdir(), 'papercusp-hosted-http1-acceptance'),
  );
  const proxyServer = exactLoopbackSocksProxy(env.PAPERCUSP_HOSTED_ACCEPTANCE_PROXY);
  return {
    origin,
    storageStatePath,
    evidenceDir,
    proxyServer,
    slo: {
      coldHydrationMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_COLD_HYDRATION_MS', 15_000),
      finiteInteractionMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_INTERACTION_MS', 5_000),
      reconnectReplayMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_RECONNECT_MS', 15_000),
      fcpMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_FCP_MS', 5_000),
      lcpMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_LCP_MS', 10_000),
      syncQueueWaitMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_SYNC_QUEUE_WAIT_MS', 1_000),
    },
  };
}

/** Evidence records paths only. Query strings can contain tickets or opaque IDs. */
export function redactEvidenceUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`;
}

export function isForcedHttp1(protocol: string): boolean {
  return protocol.toLowerCase() === 'http/1.1';
}

export interface HostedWorkspaceAcceptanceTarget {
  organizationId: string;
  workspaceId: string;
  hostId: string;
}

export interface HostedWorkspaceAcceptanceIdentity {
  sessionId: string;
  userId: string;
  organizationId: string;
  workspaceId: string;
  permissionVersion: number;
}

function acceptanceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('hosted acceptance identity record is missing');
  return value as Record<string, unknown>;
}

function acceptanceIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim())
    throw new Error('hosted acceptance identity identifier is missing');
  return value;
}

/** Retain only identity fields, never the cookie, email or upstream credentials. */
export function readHostedWorkspaceAcceptanceIdentity(
  response: unknown,
  target: HostedWorkspaceAcceptanceTarget,
): HostedWorkspaceAcceptanceIdentity {
  const body = acceptanceRecord(response);
  const session = acceptanceRecord(body.session);
  const identity = {
    sessionId: acceptanceIdentifier(session.sessionId),
    userId: acceptanceIdentifier(session.userId),
    organizationId: acceptanceIdentifier(session.organizationId),
    workspaceId: acceptanceIdentifier(session.workspaceId),
    permissionVersion: session.permissionVersion,
  };
  if (body.ok !== true || identity.organizationId !== target.organizationId ||
    identity.workspaceId !== target.workspaceId ||
    !Number.isSafeInteger(identity.permissionVersion) || Number(identity.permissionVersion) < 0)
    throw new Error('hosted acceptance browser identity does not match the target');
  return { ...identity, permissionVersion: Number(identity.permissionVersion) };
}

/** Join the server's actual channel binding before any guest command or file write. */
export function readHostedWorkspaceAcceptanceBinding(
  frame: unknown,
  identity: HostedWorkspaceAcceptanceIdentity,
  target: HostedWorkspaceAcceptanceTarget,
  expected: { kind: 'pty' | 'desktop'; role: 'controller' | 'observer'; generation?: number },
) {
  const message = acceptanceRecord(frame);
  const binding = acceptanceRecord(message.binding);
  if (message.type !== 'session.bound' || message.protocol !== 'papercusp-hosted-workspace.v1' ||
    message.kind !== expected.kind || message.role !== expected.role ||
    binding.organizationId !== identity.organizationId ||
    binding.organizationId !== target.organizationId ||
    binding.customerWorkspaceId !== identity.workspaceId ||
    binding.customerWorkspaceId !== target.workspaceId ||
    binding.hostId !== target.hostId || binding.hostedSessionId !== identity.sessionId ||
    !Number.isSafeInteger(binding.generation) || Number(binding.generation) < 1 ||
    (expected.generation !== undefined && binding.generation !== expected.generation))
    throw new Error('hosted acceptance connector binding does not match the browser and target');
  return {
    channelId: acceptanceIdentifier(message.channelId),
    kind: expected.kind,
    role: expected.role,
    organizationId: identity.organizationId,
    customerWorkspaceId: identity.workspaceId,
    hostId: target.hostId,
    hostedSessionId: identity.sessionId,
    generation: Number(binding.generation),
  };
}
