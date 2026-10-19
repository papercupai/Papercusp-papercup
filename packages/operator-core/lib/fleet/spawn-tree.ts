/**
 * fleet/spawn-tree — durable read/write of the parent→child spawn tree
 * (harness_shared.spawned_agents).
 *
 * The structured-concurrency toolkit (@papercusp/structured-concurrency) defines the
 * SpawnTreeStore port; the actual SQL lives in `./pg-stores`. This module keeps the
 * historical `<fn>(sql, …)` entry points (consumed by the fleet:* tools and the
 * integration suite) as thin re-exports of the PG store ops, so callers compose inside a
 * transaction exactly as before.
 */
export type { RecordSpawnInput, FinishSpawnInput } from '@papercusp/structured-concurrency';
export {
  recordSpawnPg as recordSpawn,
  finishSpawnPg as finishSpawn,
  getSpawnPg as getSpawn,
  getSubtreePg as getSubtree,
  openChildrenPg as openChildren,
  directChildrenPg as directChildren,
} from './pg-stores';

// getSubtree's options type is the toolkit's SubtreeQuery — re-exported under the
// historical name for call sites that referenced it.
export type { SubtreeQuery as SubtreeOptions } from '@papercusp/structured-concurrency';

import type { Db } from './pg-stores';
import { bareModelId, resolveCodexModel } from '../model-context-budget.mjs';
import { resolveGatewayModel } from '../inference-gateway/model-aliases';

/** Launch/request evidence extends the existing spawn row; it is never admission state. */
export interface SpawnAccountRoute {
  ownerId: string;
  accountRoute: string | null;
  requestedBackend: string;
  requestedModel: string;
  requestedEffort: string | null;
  launchedBackend: string;
  launchedModel: string;
  launchedEffort: string | null;
  resolvedAccountIds: string[];
  reason?: 'capacity';
}

/** Initial declared route, before the invoke chokepoint fills the resolved account set. */
export function spawnAccountRouteFromLaunch(body: Record<string, unknown>, ownerId: string): SpawnAccountRoute | null {
  const backend = typeof body.spawnBackend === 'string' ? body.spawnBackend : '';
  const spec = typeof body.spawnModel === 'string' ? body.spawnModel : '';
  const account = typeof body.account === 'string' ? body.account.trim() : '';
  if (!account || !backend || !spec) return null;
  const requestedSpec = typeof body.requestedSpawnModel === 'string' ? body.requestedSpawnModel : spec;
  const requestedBackend = typeof body.requestedSpawnBackend === 'string' ? body.requestedSpawnBackend : backend;
  const requestedModel = bareModelId(requestedSpec);
  const effort = (value: string) => bareModelId(value) === value ? null : value.slice(value.lastIndexOf(':') + 1);
  return {
    ownerId, accountRoute: account, requestedBackend, requestedModel, requestedEffort: effort(requestedSpec),
    launchedBackend: backend, launchedModel: bareModelId(backend === 'codex' ? resolveCodexModel(spec) : spec),
    launchedEffort: effort(spec), resolvedAccountIds: [],
    ...(body.spawnFallbackReason === 'capacity' ? { reason: 'capacity' as const } : {}),
  };
}

export interface SpawnFirstGatewayRequest {
  ownerId: string;
  /** Includes the gateway process incarnation, since its numeric counter restarts. */
  requestId: string;
  requestOrdinal: number;
  provider: string;
  protocol: string;
  model: string | null;
  effort: string | null;
  servingAccountId: string | null;
  outcome: string;
  finalStatus: number | null;
  startedAt: number;
}

export function assertSpawnAccountRoute(spawnId: string, route: SpawnAccountRoute): void {
  if (!spawnId || route.ownerId !== spawnId) throw new Error('spawn route owner must equal spawn id');
  if (!route.requestedBackend || !route.requestedModel || !route.launchedBackend || !route.launchedModel) {
    throw new Error('spawn route requires requested and launched backend/model');
  }
  if (route.resolvedAccountIds.some(id => !id || typeof id !== 'string')
    || new Set(route.resolvedAccountIds).size !== route.resolvedAccountIds.length) {
    throw new Error('spawn route requires a unique resolved account set');
  }
}

/**
 * Return the model id that the gateway records for a launch route's first request.
 *
 * Claude launch specs may carry the client-side `[1m]` window marker, while the
 * Anthropic gateway strips that marker and records the real upstream API id. Keep
 * the persisted launch route lossless and normalize only at this evidence seam.
 */
export function spawnRouteGatewayModel(route: Pick<SpawnAccountRoute, 'launchedBackend' | 'launchedModel'>): string {
  return route.launchedBackend === 'claude-code'
    ? resolveGatewayModel(route.launchedModel).model
    : route.launchedModel;
}

export async function recordSpawnAccountRoute(sql: Db, spawnId: string, route: SpawnAccountRoute): Promise<void> {
  assertSpawnAccountRoute(spawnId, route);
  const rows = await sql`
    UPDATE harness_shared.spawned_agents
       SET account_route = ${sql.json(route as never)}
     WHERE spawn_id = ${spawnId}
       AND (account_route IS NULL OR account_route->>'ownerId' = ${spawnId})
     RETURNING spawn_id`;
  if (rows.length !== 1) throw new Error('spawn route has no matching spawn row');
}

/** Earliest-start wins, even when overlapping requests finish in the opposite order. */
export async function recordSpawnFirstGatewayRequest(sql: Db, request: SpawnFirstGatewayRequest): Promise<boolean> {
  if (!request.ownerId || !request.requestId) throw new Error('gateway request requires exact owner and request ids');
  const rows = await sql`
    UPDATE harness_shared.spawned_agents
       SET first_gateway_request = ${sql.json(request as never)}
     WHERE spawn_id = ${request.ownerId}
       AND account_route->>'ownerId' = ${request.ownerId}
       AND (first_gateway_request IS NULL
         OR (first_gateway_request->>'startedAt')::numeric > ${request.startedAt}
         OR ((first_gateway_request->>'startedAt')::numeric = ${request.startedAt}
           AND (first_gateway_request->>'requestOrdinal')::numeric > ${request.requestOrdinal}))
     RETURNING spawn_id`;
  return rows.length === 1;
}

/** Configuration alone, a foreign request, or missing attribution never passes. */
export function verifySpawnFirstGatewayRequest(
  spawnId: string, route: SpawnAccountRoute, request: SpawnFirstGatewayRequest | null,
): boolean {
  assertSpawnAccountRoute(spawnId, route);
  return !!request && request.ownerId === spawnId && !!request.requestId
    && request.outcome === 'ok' && request.finalStatus === 200
    && request.model === spawnRouteGatewayModel(route) && request.effort === route.launchedEffort
    && request.provider === (route.launchedBackend === 'codex' ? 'codex' : 'claude')
    && !!request.servingAccountId && route.resolvedAccountIds.includes(request.servingAccountId);
}
