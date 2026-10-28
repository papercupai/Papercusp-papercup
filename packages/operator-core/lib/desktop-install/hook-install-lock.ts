import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { tryAcquire, tryRelease, normalizePaths } from '../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../agent-tools/locks/in-workspace-txn';
import { resolveExternalPathLockIdentity } from '../agent-tools/locks/external-path';
import { fileLockCoordinationDomain } from '../agent-tools/locks/coordination-domain';
import { routeFileLockOp } from '../authority/file-lock-routing';
import {
  FILE_LOCK_OP_KINDS,
  emitAcquireLockEvents,
  emitReleaseLockEvents,
  type FileLockAcquireParams,
  type FileLockAcquireResult,
  type FileLockReleaseParams,
} from '../authority/file-lock-authority-ops';
import { recordLockEvent } from '../authority/lock-event-stream';

const INSTALL_LOCK_TTL_SEC = 600;
const INSTALL_LOCK_INTENT = 'Automatic install of shared Papercusp hooks';

export type HookInstallLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: string };

type AcquireResult = Awaited<ReturnType<typeof tryAcquire>>;
type ReleaseResult = { ok: boolean; released: string[]; reason?: string };

function decodeRemoteAcquire(raw: unknown, paths: string[], ttlSec: number): AcquireResult {
  const result = raw as FileLockAcquireResult;
  if (result?.ok) {
    const parsedExpiry = result.expiresTs ? Date.parse(result.expiresTs) : Number.NaN;
    return {
      ok: true,
      lock_id: result.lockId ?? '',
      expires_ts: Number.isFinite(parsedExpiry)
        ? new Date(parsedExpiry)
        : new Date(Date.now() + ttlSec * 1000),
      held: paths,
      newly_held: result.newlyHeld ?? paths,
    };
  }

  const expires = new Date(Date.now() + ttlSec * 1000);
  const busy = (result?.busy ?? []).map((holder) => ({
    path: holder.path,
    owner: holder.owner,
    owner_label: null,
    intent: '',
    expires_ts: expires,
  }));
  if (result?.retryable && result.reason === 'upsert_race') {
    return { ok: false, busy, reason: 'upsert_race', retryable: true };
  }
  if (result?.reason === 'queued_waiter') {
    return { ok: false, busy, reason: 'queued_waiter' };
  }
  return { ok: false, busy };
}

function hookInstallLockPaths(home: string): { coordinationDomain: string; paths: string[] } {
  // These directory claims overlap every file in both hook families, including
  // the install provenance stamps, using the same canonical identity as
  // locks:acquire external_paths and the native edit hooks.
  const identities = ['inject', 'omp'].map((family) =>
    resolveExternalPathLockIdentity(
      path.join(home, '.papercusp', 'hooks', family),
      { home },
    ),
  );
  const managedDomains = Array.from(
    new Set(
      identities
        .map((identity) => identity.coordinationDomain)
        .filter((domain): domain is string => domain !== undefined),
    ),
  );
  if (managedDomains.length > 1 ||
      (managedDomains.length === 1 && identities.some((identity) => identity.coordinationDomain === undefined))) {
    throw new Error('hook install paths do not resolve to one shared file-lock domain');
  }
  return {
    coordinationDomain: managedDomains[0] ?? fileLockCoordinationDomain(),
    paths: normalizePaths(identities.map((identity) => identity.path)),
  };
}

export async function withHookInstallLock<T>(
  home: string,
  operation: () => Promise<T>,
): Promise<HookInstallLockResult<T>> {
  const { coordinationDomain, paths } = hookInstallLockPaths(home);
  const owner = 'system:hook-installer:' + randomUUID();
  const ownerLabel = 'automatic Papercusp hook installer';
  const ttlSec = INSTALL_LOCK_TTL_SEC;
  const acquireParams: FileLockAcquireParams = {
    coordinationDomain,
    owner,
    ownerLabel,
    paths,
    intent: INSTALL_LOCK_INTENT,
    ttlSec,
    automatic: true,
  };
  const routedAcquire = await routeFileLockOp<AcquireResult>(coordinationDomain, {
    local: () =>
      inWorkspaceTxn(
        coordinationDomain,
        owner,
        (tx) => tryAcquire(tx, acquireParams),
        { paths },
      ),
    remote: {
      kind: FILE_LOCK_OP_KINDS.acquire,
      payload: acquireParams,
      decode: (raw) => decodeRemoteAcquire(raw, paths, ttlSec),
    },
  });
  const acquired = routedAcquire.value;
  if (!acquired.ok) {
    const holder = acquired.busy[0];
    return {
      acquired: false,
      reason: holder
        ? 'held by ' + holder.owner + ' at ' + holder.path
        : ('reason' in acquired ? acquired.reason : 'lock is busy'),
    };
  }
  if (!acquired.lock_id) {
    return { acquired: false, reason: 'lock store returned no lock id' };
  }

  if (routedAcquire.scope && routedAcquire.via !== 'remote-authority') {
    emitAcquireLockEvents((event) => void recordLockEvent(event), {
      scope: routedAcquire.scope,
      owner,
      paths: acquired.held,
      expiresAtMs: acquired.expires_ts.getTime(),
      ts: Date.now(),
    });
  }

  try {
    return { acquired: true, value: await operation() };
  } finally {
    try {
      const releaseParams: FileLockReleaseParams = {
        coordinationDomain,
        owner,
        lockId: acquired.lock_id,
      };
      const routedRelease = await routeFileLockOp<ReleaseResult>(coordinationDomain, {
        local: async () => {
          const result = await inWorkspaceTxn(
            coordinationDomain,
            owner,
            (tx) => tryRelease(tx, releaseParams),
            { paths },
          );
          return {
            ok: result.released.length === paths.length,
            released: result.released,
          };
        },
        remote: {
          kind: FILE_LOCK_OP_KINDS.release,
          payload: releaseParams,
          decode: (raw) => {
            const result = raw as ReleaseResult;
            if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.released)) {
              throw new Error('lock authority returned an invalid release result');
            }
            return result;
          },
        },
      });
      const released = routedRelease.value;
      if (routedRelease.scope && routedRelease.via !== 'remote-authority' && released.released.length > 0) {
        emitReleaseLockEvents((event) => void recordLockEvent(event), {
          scope: routedRelease.scope,
          owner,
          released: released.released,
          ts: Date.now(),
        });
      }
      if (!released.ok || released.released.length !== paths.length) {
        console.error(
          '[desktop-install] hook file-lock release incomplete; expected ' +
            paths.length +
            ' path(s), released ' +
            released.released.length,
        );
      }
    } catch (err) {
      console.error(
        '[desktop-install] hook file-lock release failed: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
