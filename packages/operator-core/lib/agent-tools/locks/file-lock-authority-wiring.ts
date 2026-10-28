/**
 * file-lock-authority-wiring — the boot binding that lights up cross-machine file-lock
 * serialization (fed-reanchor-2026-06-06 P-060 cutover 2; the live half of
 * `hive-scoped-federation`'s Track B).
 *
 * Two halves, both wired here at module load (side-effect import from the agent-tools
 * barrel):
 *
 *  1. REQUESTING side — `routeFileLockOp` (called from locks:acquire / locks:release)
 *     needs to map a `coordination_domain` (repo realpath) → harness → (if a Hive
 *     member) Hive, to pick the authority. Those resolvers default to `null` (→ run
 *     locally), so until wired the cutover is dormant. Here we wire them to the harness
 *     registry via a sync-readable snapshot (the resolver signature is sync; the
 *     registry read is async, so we keep a `Map` refreshed on a timer + at boot).
 *
 *  2. AUTHORITY side — when a REMOTE peer routes its acquire/release to THIS machine as
 *     the elected authority, `registerFileLockAuthorityOps` runs the op against our local
 *     su-lock store on the requester's behalf. `adaptSuLockStore` is that store adapter.
 *
 * N=1 invariant: on a single box there are no remote peers in `shared_presence`, so
 * `routeFileLockOp`'s remote-peers-cache fast-path always resolves "no peers" → runs
 * `op.local()` directly. The resolver values are irrelevant when there are no peers, so
 * this whole module is a **dormant passthrough** at single-hive — it only engages once a
 * second Swarm appears (the hardware-gated cross-machine path). The authority handlers
 * registered here are likewise never invoked without an inbound peer RPC.
 *
 * Deliberately NOT covered: the locks:acquire WAIT / wake_on_grant queue stays
 * machine-local. Only the fast-path acquire + release route to the authority (the per-edit
 * hot path).
 *
 * RATIFIED as intentional EVENTUAL behavior — not a deferral (WI-6047, plan
 * shared-hive-cross-machine-scale-10k-2026-06-29 P-006, which posed exactly this fork:
 * route waiters through the per-Hive authority, OR document it as intentional). This note
 * previously read "cross-machine waiter-queue coherence is a further step", which left the
 * question open and kept re-surfacing. The decision, and why it is safe:
 *
 *  1. CORRECTNESS IS UNAFFECTED. acquire + release DO route to the elected authority
 *     (half 2 above), so grant decisions are authority-serialized across machines. A
 *     machine-local WAITER QUEUE cannot produce a double-grant — only the WAKE is local.
 *  2. LIVENESS IS BOUNDED. A sleeping waiter's ticket stays grant-eligible for
 *     WAKE_QUEUE_WINDOW_SEC (acquire.ts, default 1800s), and a grant to an agent that
 *     never wakes is itself bounded by the lock TTL lease backstop (D-004 #3).
 *  3. IT FAILS LOUD, NOT SILENT — the leg that settles it. When a queue wait lapses
 *     expired/cancelled/missing, lock-grant-bridge.ts STILL fires the waiter's event with
 *     granted:false and "queue wait ended WITHOUT a grant ... re-queue or pivot". A
 *     cross-machine waiter is therefore never left hanging on a grant it cannot see; it is
 *     woken with a terminal, actionable result.
 *
 * So the residual costs a cross-machine waiter added LATENCY (it waits out its window
 * rather than being woken promptly by the remote release), with git-merge as the
 * correctness backstop. Routing the waiter queue through the authority is materially more
 * machinery (queue coherence, grant hand-off, cancellation) than that latency buys —
 * revisit only if a real workload shows two machines contending the SAME file, which a
 * single-box N=1 deployment cannot exhibit. Nothing here forecloses doing it later.
 */

import { realpathSync } from 'node:fs';
import { managedSetInterval } from '@papercusp/scheduled-registry';

import {
  registerFileLockAuthorityOps,
  isNativeEditProofForPaths,
  type FileLockReleaseParams,
  FILE_LOCK_OP_KINDS,
  hookOperationStoreIdentity,
  decodeHookOperationPrepare,
  finishHookLockOperationSchema,
  emitReleaseLockEvents,
  type FileLockCoordinator,
} from '../../authority/file-lock-authority-ops';
import {
  configureFileLockDomainResolver,
  configureFileLockHiveResolver,
  routeFileLockOp,
} from '../../authority/file-lock-routing';
import { wireAuthorityRpcTransport } from '../../authority/transport-wiring';
import { registerReportAttachmentRpc } from '../../harness/improvements/report-attachment-rpc';
import { registerSellerReceiptRpc } from '../../cupboard/seller-receipt-rpc';
import { wireAuthorityRpcSwarmTransport } from '../../authority/authority-rpc-swarm-wiring';
import { wireLockEventStream } from '../../authority/lock-event-wiring';
import { wirePeerEviction } from '../../authority/eviction-wiring';
import { loadHarnessRegistry } from '../../harness-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryAcquire, tryRelease, tryFinishHookOperation, readQueue, getTxPool } from './su-lock-store';
import { recordEditAttributionStrict } from '../../edit-attribution';
import { noteShaTokenRelease } from '../../authority/sha-token-registry';
import { recordLockEvent } from '../../authority/lock-event-stream';

// ── Authority-side store adapter ────────────────────────────────────────────────
/**
 * Adapt the operator's PG-backed su-lock store to the `FileLockCoordinator` seam the
 * authority op-handlers drive. Every method binds to the op's OWN `coordinationDomain`
 * (threaded on the wire) so the authority serves the requester's physical repo, and wraps
 * the store call in `inWorkspaceTxn` exactly as the live locks:* tools do.
 */
export function adaptSuLockStore(): FileLockCoordinator {
  return {
    operationStoreIdentity: hookOperationStoreIdentity,
    async acquire(p) {
      const r = await inWorkspaceTxn(p.coordinationDomain, p.owner, (tx) =>
        tryAcquire(tx, {
          coordinationDomain: p.coordinationDomain,
          owner: p.owner,
          ownerLabel: p.ownerLabel ?? null,
          paths: p.paths,
          intent: p.intent,
          ttlSec: p.ttlSec,
          goalRef: p.goalRef,
          automatic: p.automatic,
          operation: p.operation,
        }),
        { paths: p.paths },
      );
      if (r.ok) {
        return {
          ok: true,
          lockId: r.lock_id,
          expiresTs: r.expires_ts.toISOString(),
          newlyHeld: r.newly_held,
          ...(p.operation ? { operationId: p.operation.id } : {}),
        };
      }
      return {
        ok: false,
        busy: r.busy.map((b) => ({ path: b.path, owner: b.owner })),
        ...(p.operation ? { operationId: p.operation.id } : {}),
        ...('reason' in r
          ? { reason: r.reason }
          : {}),
        ...('retryable' in r && r.retryable
          ? { reason: r.reason, retryable: true }
          : {}),
      };
    },

    async release(p) {
      if (p.operation) return finishHookOperationAtAuthority(p);
      const r = await inWorkspaceTxn(p.coordinationDomain, p.owner, (tx) =>
        tryRelease(tx, {
          coordinationDomain: p.coordinationDomain,
          owner: p.owner,
          lockId: p.lockId,
          paths: p.paths,
          allMine: p.allMine,
        }),
        { paths: p.paths },
      );
      // EI-20405390083792304: carry `heldBefore` back to the requester so a
      // routed release can distinguish "held nothing" from "matched nothing"
      // exactly like a local one. Without it the remote path would have to
      // report the count as unknown, and the requester's `released: []` would
      // stay ambiguous on precisely the cross-tree/cross-machine setups where
      // a domain mismatch is most likely in the first place.
      return { ok: true, released: r.released, heldBefore: r.heldBefore };
    },

    async queue(p) {
      const sql = getTxPool();
      // Preserve the distinction between an omitted filter (all paths) and an
      // explicit empty filter (no paths). readQueue fails closed for the latter.
      return readQueue(sql, { coordinationDomain: p.coordinationDomain, paths: p.paths });
    },
  };
}

/** Completion validates the stored operation inside its transaction. A strict
 * ledger failure rolls back release; duplicate proofs use the operation UUID. */
export async function finishHookOperationAtAuthority(p: FileLockReleaseParams): ReturnType<FileLockCoordinator['release']> {
  const operation = p.operation;
  if (!operation || !finishHookLockOperationSchema.safeParse({ ...operation, ttl_sec: operation.ttlSec }).success ||
      !['cancelled', 'completed'].includes(operation.outcome)) {
    return { ok: false, reason: 'operation_conflict' };
  }
  const proof = p.nativeEditProof;
  if ((operation.outcome === 'cancelled' && proof) ||
      (proof && !isNativeEditProofForPaths(proof, operation.paths))) {
    return { ok: false, reason: 'operation_proof_conflict', operationId: operation.id };
  }
  return inWorkspaceTxn(p.coordinationDomain, p.owner, async (tx) => {
    const result = await tryFinishHookOperation(tx, {
      coordinationDomain: p.coordinationDomain, owner: p.owner, ownerLabel: null,
      paths: operation.paths, intent: operation.intent, ttlSec: operation.ttlSec,
      automatic: true, operation, outcome: operation.outcome,
    });
    if (!result.ok) return { ...result, operationId: operation.id };
    if (proof) {
      // Covers a lost acquire reply and a deliberately retained hold as well as
      // paths released now. Only the validated operation's requested scope wins.
      // WI-6554700010019499: workspaceId is load-bearing — git-sync reads this ledger
      // scoped by workspace, so a NULL here makes the author invisible to commit
      // attribution and to the migration-dependency fence.
      await recordEditAttributionStrict({
        repoRoot: p.coordinationDomain, files: result.requestedPaths, agentId: p.owner,
        intent: `PostToolUse:${proof.source}:${proof.tool ?? proof.tools?.join(',')}`,
        goalRef: result.goalRef ?? undefined, dispatchCallId: operation.id,
        workspaceId: p.workspaceId, contributor: p.contributor, sessionId: proof.sessionId,
      });
    }
    return { ...result, operationId: operation.id, attributed: proof ? result.requestedPaths : [] };
  }, { paths: operation.paths });
}

/** Finish must use the pin prepared BEFORE acquire. Never re-prepare on a
 * changed authority and never search another domain for a matching hold. */
export async function routeHookOperationFinish(p: FileLockReleaseParams, authority: string | undefined): Promise<Record<string, unknown>> {
  const operation = p.operation;
  if (!operation || !authority) return { ok: false, reason: 'operation_authority_unknown' };
  try {
    const routed = await routeFileLockOp(p.coordinationDomain, {
      authorityFence: {
        expected: authority,
        localStoreIdentity: hookOperationStoreIdentity,
        prepare: (): Awaited<ReturnType<FileLockCoordinator['release']>> => ({ ok: false, reason: 'operation_authority_unknown' }),
      },
      local: () => finishHookOperationAtAuthority(p),
      remote: {
        kind: FILE_LOCK_OP_KINDS.release, payload: p,
        prepare: { kind: FILE_LOCK_OP_KINDS.queue,
          payload: { owner: p.owner, coordinationDomain: p.coordinationDomain, operationPrepare: true },
          decode: decodeHookOperationPrepare },
        decode: (raw): Awaited<ReturnType<FileLockCoordinator['release']>> => {
          const r = raw as Awaited<ReturnType<FileLockCoordinator['release']>>;
          if (r.operationId !== operation.id) throw new Error('operation response unavailable');
          return r;
        },
      },
    });
    const r = routed.value;
    if (r.ok && r.released) {
      noteShaTokenRelease(p.coordinationDomain, r.released, p.publishedSha ?? null, Date.now());
      if (routed.scope && routed.via !== 'remote-authority') {
        emitReleaseLockEvents((event) => void recordLockEvent(event), {
          scope: routed.scope, owner: p.owner, released: r.released, ts: Date.now(), publishedSha: p.publishedSha,
        });
      }
    }
    return { ok: r.ok, reason: r.reason, operation_id: r.operationId, released: r.released,
      requested_paths: r.requestedPaths, attributed: r.attributed, held_before: r.heldBefore, state: r.state };
  } catch (err) {
    return { ok: false, reason: (err as { reason?: string }).reason ?? 'operation_authority_unknown', operation_id: operation.id };
  }
}

// ── Requesting-side resolver snapshot ───────────────────────────────────────────
// The resolvers are synchronous; the registry read is async. Keep a `Map` snapshot
// refreshed at boot + on a timer. A miss → null → the op runs locally (safe default).
let _domainToSlug = new Map<string, string>();
let _slugToHive = new Map<string, string>();

/** Resolve a repo realpath → its registry slug (best-effort; realpath both sides). */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // path gone / not yet present — fall back to the raw string
  }
}

async function refreshResolverSnapshot(): Promise<void> {
  const reg = await loadHarnessRegistry(activeWorkspaceId());
  const d2s = new Map<string, string>();
  const s2h = new Map<string, string>();
  for (const proj of reg.projects) {
    if (proj.path) d2s.set(realpathOrSelf(proj.path), proj.slug);
    // The home Hive for this harness (mirrors potHomeSlugForHarness, sync from the
    // registry row): a kind:'hive' harness is its own home; a member points via hive_slug.
    const hiveHome = proj.harness_kind === 'hive' ? proj.slug : (proj.hive_slug ?? null);
    if (hiveHome) s2h.set(proj.slug, hiveHome);
  }
  _domainToSlug = d2s;
  _slugToHive = s2h;
}

/** Refresh cadence for the resolver snapshot (ms). Membership/checkout changes are rare. */
const RESOLVER_REFRESH_MS = 60_000;

let _wired = false;

/**
 * Wire both halves at boot. Idempotent. Safe to call before PG is reachable — the first
 * snapshot refresh is best-effort (a failure leaves the empty maps → everything resolves
 * local, the correct pre-cutover behavior — and the next tick retries).
 */
export function wireFileLockAuthority(): void {
  if (_wired) return;
  _wired = true;

  configureFileLockDomainResolver((domain) => _domainToSlug.get(realpathOrSelf(domain)) ?? null);
  configureFileLockHiveResolver((slug) => _slugToHive.get(slug) ?? null);
  registerFileLockAuthorityOps(adaptSuLockStore());
  // The wire-leg (P-006, coord-system-e2e): the HTTP transport ships registered, so
  // remote-authority ops cross the wire as soon as a peer address resolves (seam:
  // configurePeerAddressResolver / PAPERCUSP_AUTHORITY_PEER_ADDRESSES). No address →
  // fail-open, exactly the pre-wiring behavior.
  wireAuthorityRpcTransport();
  registerReportAttachmentRpc();
  registerSellerReceiptRpc();
  // shared-hive-hardening P-001 / D-005 (owner-ratified option c): compose the
  // Hyperswarm-mux RPC transport IN FRONT of the HTTP one so NAT'd desktop peers
  // are reachable over the existing connection. Async (resolves the device signer
  // + shared swarm) + flag-gated (papercusp-authority-rpc-protomux, default OFF —
  // cross-machine path is real-hardware-unverified, P-003); a no-op + never-throws
  // when off, leaving the HTTP-only registration above in place.
  void wireAuthorityRpcSwarmTransport().catch(() => {
    /* fail-open: HTTP-only transport stands (D-004) */
  });
  // P-015: the lock-event stream (authority grants/releases append to the peer-log
  // so a NEW authority reconstructs the live lock set instantly on failover; no-op
  // when not federating). P-016: the φ+SWIM eviction probe (flag-gated, dark) so a
  // crashed authority is evicted before the 90s staleness window. Both are dormant
  // single-box / fail-open, like the rest of this module.
  wireLockEventStream();
  wirePeerEviction();

  void refreshResolverSnapshot().catch(() => {
    /* best-effort: empty maps → resolve local; the timer retries */
  });
  // Refresh the resolver snapshot on a cadence (registered for inventory visibility;
  // the registry unrefs the timer so it never keeps the process alive).
  managedSetInterval('file-lock-resolver-refresh', RESOLVER_REFRESH_MS, () => {
    void refreshResolverSnapshot().catch(() => undefined);
  }, { category: 'cache' });
}

/** Test seam: force a synchronous snapshot refresh (awaitable) + read the maps. */
export const _testing = {
  refreshResolverSnapshot,
  domainToSlug: () => _domainToSlug,
  slugToHive: () => _slugToHive,
  reset: () => {
    _domainToSlug = new Map();
    _slugToHive = new Map();
    _wired = false;
  },
};

// Boot side-effect — mirror locks/configure.ts. Importing this module wires the cutover.
wireFileLockAuthority();
