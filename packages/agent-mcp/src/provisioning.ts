/**
 * Provisioning for system:<name> principals.
 *
 * Creates a fresh bearer and writes it to two PG tables:
 *   1. harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
 *   2. harness_shared.token_index (token, kind='system', slug='system:<name>', workspace_id)
 *
 * Was previously also duplicated to `<papercuspRoot>/system/<name>/config.json`
 * for read-access by the operator's dispatch routes — that file is gone;
 * routes now read the bearer from token_index via apps/operator/lib/system-principal.ts.
 *
 * Idempotent per (workspace, name): re-running with the same name skips
 * if a row already exists (use `force: true` to rotate the bearer).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@papercusp/tooldef';
import { withWorkspace } from '@papercusp/db-org';
import { PRINCIPAL_INVALIDATE_CHANNEL } from './auth';

/**
 * Tell every live auth cache (auth.ts LISTEN) that this principal's
 * capabilities changed. Runs inside the write tx — PG queues the NOTIFY
 * and delivers it on commit (dropped on rollback).
 */
async function notifyPrincipalChanged(tx: Sql, workspaceId: string, slug: string): Promise<void> {
  const payload = JSON.stringify({ workspace_id: workspaceId, slug });
  await tx`SELECT pg_notify(${PRINCIPAL_INVALIDATE_CHANNEL}, ${payload})`;
}

export interface ProvisionSystemPrincipalArgs {
  workspaceId: string;
  name: string;
  capabilities: string[];
  papercuspRoot: string;
  force?: boolean;
}

export interface ProvisionResult {
  workspaceId: string;
  name: string;
  /** The freshly-minted bearer — present ONLY when a bearer was created (initial
   *  provision) or rotated (`force`). ABSENT on a capabilities-only RECONCILE, which
   *  leaves the existing bearer untouched (there is no new bearer to return). */
  bearer?: string;
  /** Display label kept for log/UI surfaces; refers to where the bearer
   *  USED TO be written. The actual source of truth is now PG (token_index). */
  configPath: string;
  rotated: boolean;
  /** True when an ALREADY-PROVISIONED principal's capabilities were brought up to the
   *  code-defined set IN PLACE (additive, NO bearer rotation). EI-2048. */
  reconciled?: boolean;
}

/**
 * The ADDITIVE capability-reconcile decision (EI-2048), pure + exported for tests.
 * Returns the caps in `code` that `stored` lacks (`missing`) and the union to persist
 * (`merged`). NEVER removes a stored cap not in `code` — shrinking a principal's caps is
 * an attended `force` reprovision, not an automatic forceless-deploy side effect. When
 * `missing` is empty the live row is already current and the caller writes nothing.
 */
export function reconcileCapabilities(
  stored: readonly string[],
  code: readonly string[],
): { missing: string[]; merged: string[] } {
  const have = new Set(stored);
  const missing = code.filter((c) => !have.has(c));
  return { missing, merged: missing.length ? [...stored, ...missing] : [...stored] };
}

export function normalizeCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

function genBearer(): string {
  return randomBytes(32).toString('base64url');
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function provisionSystemPrincipal(
  args: ProvisionSystemPrincipalArgs,
): Promise<ProvisionResult | null> {
  const { workspaceId, name, capabilities, papercuspRoot, force } = args;
  const configPath = `${papercuspRoot}/system/${name}/config.json`;

  return withWorkspace(workspaceId, async (tx) => {
    const existing = await tx<Array<{ bearer_hash: string; capabilities: unknown }>>`
      SELECT bearer_hash, capabilities
        FROM harness_shared.system_principals
       WHERE workspace_id = ${workspaceId} AND name = ${name}
       LIMIT 1
    `;
    if (existing.length > 0 && !force) {
      // EI-2048: a capability ADDED in code (e.g. operator's memory:*/locks:* grant on
      // 2026-06-20) never reached an already-provisioned row — provision-without-force
      // used to be a pure no-op, and the only way to apply it (`force`) ROTATES the
      // bearer, breaking every live connection. So reconcile capabilities IN PLACE,
      // ADDITIVELY: grant the caps the code-defined set has that the live row lacks, and
      // NEVER auto-revoke (shrinking a principal's caps stays an attended `force`
      // reprovision — auto-revoking under a live session is the dangerous direction). The
      // bearer is untouched (zero token churn / no broken connections); NOTIFY makes
      // auth.ts's cache reload. A normal (forceless) deploy now self-heals cap drift.
      const storedCaps = normalizeCapabilities(existing[0].capabilities);
      const { missing, merged } = reconcileCapabilities(storedCaps, capabilities);
      if (missing.length === 0) return null; // already current — a true no-op
      await tx`
        UPDATE harness_shared.system_principals
           SET capabilities = ${JSON.stringify(merged)}::jsonb
         WHERE workspace_id = ${workspaceId} AND name = ${name}
      `;
      await notifyPrincipalChanged(tx, workspaceId, `system:${name}`);
      return { workspaceId, name, configPath, rotated: false, reconciled: true };
    }
    const bearer = genBearer();
    const bearerHash = hash(bearer);
    if (existing.length > 0) {
      // Rotate.
      await tx`
        UPDATE harness_shared.system_principals
           SET bearer_hash = ${bearerHash},
               capabilities = ${JSON.stringify(capabilities)}::jsonb
         WHERE workspace_id = ${workspaceId} AND name = ${name}
      `;
      await tx`
        DELETE FROM harness_shared.token_index
         WHERE kind = 'system'
           AND harness_slug = ${`system:${name}`}
           AND workspace_id = ${workspaceId}
      `;
    } else {
      await tx`
        INSERT INTO harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
        VALUES (${workspaceId}, ${name}, ${bearerHash}, ${JSON.stringify(capabilities)}::jsonb)
      `;
    }
    await tx`
      INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
      VALUES (${bearer}, 'system', ${`system:${name}`}, ${workspaceId})
      ON CONFLICT (token) DO UPDATE
        SET kind = 'system', harness_slug = ${`system:${name}`}, workspace_id = ${workspaceId}
    `;
    await notifyPrincipalChanged(tx, workspaceId, `system:${name}`);

    return {
      workspaceId,
      name,
      bearer,
      configPath,
      rotated: existing.length > 0,
    };
  });
}

export interface StartPiSessionArgs {
  workspaceId: string;
  sessionId: string;
  capabilities?: string[];
  /** Exact canonical MCP tool names. A PI session never infers this from URL `?tools=`. */
  allowedTools: string[];
  /** Absolute durable expiry. Defaults to one day for non-interactive PI sessions. */
  expiresAt?: Date;
}

export interface PiSessionResult {
  bearer: string;
  sessionId: string;
}

export const DEFAULT_PI_CAPABILITIES = [
  'tasks:read',
  'goals:read',
  'harness:read',
  'messages:read',
  'search:read',
];

export const DEFAULT_PI_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export async function startPiSession(
  args: StartPiSessionArgs,
): Promise<PiSessionResult> {
  const { workspaceId, sessionId } = args;
  const caps = args.capabilities === undefined ? DEFAULT_PI_CAPABILITIES : args.capabilities;
  const allowedTools = [...new Set(args.allowedTools.map((name) => name.trim()).filter(Boolean))];
  const expiresAt = args.expiresAt ?? new Date(Date.now() + DEFAULT_PI_SESSION_TTL_MS);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new TypeError('pi_session_expiry_must_be_in_the_future');
  }
  return withWorkspace(workspaceId, async (tx) => {
    const bearer = genBearer();
    const bearerHash = hash(bearer);
    await tx`
      INSERT INTO harness_shared.pi_sessions
        (workspace_id, session_id, bearer_hash, capabilities, allowed_tools, expires_at)
      VALUES (
        ${workspaceId}, ${sessionId}, ${bearerHash}, ${JSON.stringify(caps)}::jsonb,
        ${JSON.stringify(allowedTools)}::jsonb, ${expiresAt}
      )
    `;
    await tx`
      INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
      VALUES (${bearer}, 'pi', ${`pi:${sessionId}`}, ${workspaceId})
    `;
    await notifyPrincipalChanged(tx, workspaceId, `pi:${sessionId}`);
    return { bearer, sessionId };
  });
}

export async function endPiSession(workspaceId: string, sessionId: string): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.pi_sessions
         SET ended_at = now()
       WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
    `;
    await tx`
      DELETE FROM harness_shared.token_index
       WHERE kind = 'pi' AND harness_slug = ${`pi:${sessionId}`} AND workspace_id = ${workspaceId}
    `;
    await notifyPrincipalChanged(tx, workspaceId, `pi:${sessionId}`);
  });
}

/** Supplemental possession credential for one server-issued native runtime.
 * It grants NO tool capabilities, role, harness, source scope or capture claim.
 * The trusted launcher must deliver it only to that runtime. Exact host call
 * observation and current resource authorization remain separate obligations. */
export interface NativeRuntimeBearerBinding {
  workspaceId: string;
  advSessionId: number;
  ownerId: string;
  provider: 'claude' | 'codex' | 'omp';
}

type NativeRuntimeRow = Omit<NativeRuntimeBearerBinding, 'advSessionId'> & {
  advSessionId: number | string; endedAt: unknown; retiredAt: unknown; name?: string; bearerHash?: string;
};

function validRuntimeBinding(binding: NativeRuntimeBearerBinding): boolean {
  return typeof binding.workspaceId === 'string' && !!binding.workspaceId && binding.workspaceId !== '*'
    && Number.isSafeInteger(binding.advSessionId) && binding.advSessionId > 0
    && typeof binding.ownerId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(binding.ownerId)
    && ['claude', 'codex', 'omp'].includes(binding.provider);
}

function runtimePrincipalName(binding: NativeRuntimeBearerBinding): string {
  // Retargeting an adv row cannot transfer an old credential to its new owner
  // or provider. No caller-supplied principal name or inherited root scope.
  return `native-runtime:${binding.advSessionId}:${hash(JSON.stringify([
    binding.workspaceId, binding.ownerId, binding.provider,
  ]))}`;
}

/** Extend the existing token_index/system_principals issuer, not a second
 * credential store. `issuer` must come from the launch request's resolver;
 * this server-only function is never projected as a tool or JSON argument.
 * Restrict issuance to the existing wildcard authority; a read-only device or
 * unverified loopback identity cannot turn itself into a runtime issuer. */
export async function provisionNativeRuntimeBearer(args: {
  workspaceId: string; advSessionId: number; issuer: Principal;
}): Promise<{ bearer: string; binding: NativeRuntimeBearerBinding }> {
  const { workspaceId, advSessionId, issuer } = args;
  if (!workspaceId || workspaceId === '*' || !Number.isSafeInteger(advSessionId) || advSessionId <= 0
    || !['trusted', 'verified'].includes(issuer.trust ?? '') || !issuer.slug
    || !issuer.capabilities.has('*') || ![workspaceId, '*'].includes(issuer.workspaceId)) {
    throw new Error('native_runtime_issuer_denied');
  }
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx<NativeRuntimeRow[]>`
      SELECT workspace_id AS "workspaceId", id::text AS "advSessionId", coord_owner_id AS "ownerId",
             agent AS provider, ended_at AS "endedAt", retired_at AS "retiredAt"
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${workspaceId} AND id = ${advSessionId}
       FOR UPDATE
    `;
    const row = rows[0];
    const runtime = row ? { ...row, advSessionId: Number(row.advSessionId) } : null;
    if (rows.length !== 1 || !runtime || !validRuntimeBinding(runtime) || runtime.workspaceId !== workspaceId
      || runtime.advSessionId !== advSessionId || runtime.endedAt !== null || runtime.retiredAt !== null) {
      throw new Error('native_runtime_issuance_binding_unavailable');
    }
    const binding: NativeRuntimeBearerBinding = { workspaceId, advSessionId,
      ownerId: runtime.ownerId, provider: runtime.provider };
    const name = runtimePrincipalName(binding), slug = `system:${name}`;
    const bearer = genBearer();
    await tx`
      INSERT INTO harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
      VALUES (${workspaceId}, ${name}, ${hash(bearer)}, '[]'::jsonb)
      ON CONFLICT (workspace_id, name) DO UPDATE
        SET bearer_hash = EXCLUDED.bearer_hash, capabilities = '[]'::jsonb
    `;
    await tx`DELETE FROM harness_shared.token_index
      WHERE workspace_id = ${workspaceId} AND kind = 'system' AND harness_slug = ${slug}`;
    await tx`INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
      VALUES (${bearer}, 'system', ${slug}, ${workspaceId})`;
    await notifyPrincipalChanged(tx, workspaceId, slug);
    return { bearer, binding };
  });
}

/** Uncached possession check, independent of normal bearer capability caches.
 * A token deletion/rotation or runtime end/retarget is visible on the next
 * check. Success proves only this binding; NEVER use it to scope siblings,
 * authorize a tool, or append a capture-completeness receipt. */
export async function verifyNativeRuntimeBearer(bearer: string,
  expected: NativeRuntimeBearerBinding): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(bearer) || !validRuntimeBinding(expected)) return false;
  return withWorkspace(expected.workspaceId, async (tx) => {
    const rows = await tx<NativeRuntimeRow[]>`
      SELECT a.workspace_id AS "workspaceId", a.id::text AS "advSessionId", a.coord_owner_id AS "ownerId",
             a.agent AS provider, a.ended_at AS "endedAt", a.retired_at AS "retiredAt",
             p.name, p.bearer_hash AS "bearerHash"
        FROM harness_shared.token_index t
        JOIN harness_shared.system_principals p
          ON t.workspace_id = p.workspace_id AND t.harness_slug = 'system:' || p.name
        JOIN harness_shared.adv_sessions a ON a.workspace_id = p.workspace_id
       WHERE t.token = ${bearer} AND t.kind = 'system'
         AND a.workspace_id = ${expected.workspaceId} AND a.id = ${expected.advSessionId}
    `;
    const row = rows[0];
    return rows.length === 1 && !!row && row.endedAt === null && row.retiredAt === null
      && row.workspaceId === expected.workspaceId && String(row.advSessionId) === String(expected.advSessionId)
      && row.ownerId === expected.ownerId && row.provider === expected.provider
      && row.name === runtimePrincipalName(expected) && row.bearerHash === hash(bearer);
  });
}
