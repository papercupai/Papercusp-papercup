import type { WorkspaceHostScopeRef, WorkspaceHostSize } from "./workspace-host-types";

/**
 * Ordinary VM eligibility, not a second scheduler or an allocation ledger.
 * The controller must atomically reserve the returned generation/fence and revalidate
 * this snapshot before acting. One customer owns a VM at a time (capacity-cost D-065).
 */
export interface WorkspaceHostPoolAffinity {
  target: string;
  scope: WorkspaceHostScopeRef;
  region: string;
  zone: string;
}

export interface WorkspaceHostPoolRequest extends WorkspaceHostPoolAffinity {
  workspaceId: string;
  customerWorkspaceId: string;
  /** Stable tenant volume identity, never a disposable boot/swap disk. */
  dataVolumeId: string;
  architecture: string;
  runtimeBundleSha256: string;
  minimum: Pick<WorkspaceHostSize, "cpuCount" | "memoryMiB">;
  nowMs: number;
  maxObservationAgeMs: number;
  /** Already admitted by the caller's quota/budget/provider checks. */
  mayProvision: boolean;
}

export interface WorkspaceHostPoolCandidate extends WorkspaceHostPoolAffinity {
  workspaceId: string;
  hostId: string;
  generation: number;
  controllerFence: number;
  architecture: string;
  runtimeBundleSha256: string;
  size: Pick<WorkspaceHostSize, "cpuCount" | "memoryMiB">;
  state: "running" | "stopped" | "draining" | "failed";
  /** stopped-verified is provider/disk evidence for the same owner, never service health. */
  health: "healthy" | "unhealthy" | "unknown" | "stopped-verified";
  observedAtMs: number;
  customerWorkspaceId: string | null;
  dataVolumeId: string | null;
  /** Any pending reservation removes this VM from new placement. Replay resumes its operation. */
  reservationId: string | null;
  /** Provider/runtime proof of a never-used or reimaged empty host; not a boolean supplied by a customer. */
  cleanAttestationRef: string | null;
}

export type WorkspaceHostPoolRefusal =
  | "workspace-mismatch" | "data-affinity-mismatch" | "runtime-mismatch"
  | "invalid-capacity" | "insufficient-capacity" | "invalid-generation"
  | "stale-observation" | "unhealthy" | "unavailable" | "reserved"
  | "foreign-tenant" | "wrong-volume" | "unclean" | "warm-host-not-running";

export interface WorkspaceHostPoolRejection {
  hostId: string;
  reasons: WorkspaceHostPoolRefusal[];
}

export type WorkspaceHostPoolPlacement = {
  rejected: WorkspaceHostPoolRejection[];
} & (
  | {
      kind: "reuse" | "start" | "assign-warm";
      hostId: string;
      /** Compare-and-set preconditions, not an acquired lease. */
      generation: number;
      controllerFence: number;
    }
  | { kind: "provision" | "queue"; reason: "no-eligible-host" | "existing-tenant-needs-reconciliation" }
);

const nonEmpty = (value: string): boolean => typeof value === "string" && value.trim().length > 0;
const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const validCapacity = (value: Pick<WorkspaceHostSize, "cpuCount" | "memoryMiB">): boolean =>
  Number.isFinite(value.cpuCount) && value.cpuCount > 0 && positiveInteger(value.memoryMiB);
const digest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function validateRequest(request: WorkspaceHostPoolRequest): void {
  if (![request.workspaceId, request.customerWorkspaceId, request.dataVolumeId, request.target,
    request.scope.kind, request.scope.id, request.region, request.zone, request.architecture].every(nonEmpty)) {
    throw new Error("workspace-host pool requires tenant identity and explicit durable-data affinity");
  }
  if (!digest(request.runtimeBundleSha256) || !validCapacity(request.minimum) ||
      !Number.isSafeInteger(request.nowMs) || request.nowMs < 0 ||
      !positiveInteger(request.maxObservationAgeMs) || typeof request.mayProvision !== "boolean") {
    throw new Error("workspace-host pool requires valid runtime, capacity, clock and admission inputs");
  }
}

function refuse(request: WorkspaceHostPoolRequest, host: WorkspaceHostPoolCandidate): WorkspaceHostPoolRefusal[] {
  const reasons: WorkspaceHostPoolRefusal[] = [];
  if (host.workspaceId !== request.workspaceId) reasons.push("workspace-mismatch");
  if (host.target !== request.target || host.scope.kind !== request.scope.kind || host.scope.id !== request.scope.id ||
      host.region !== request.region || host.zone !== request.zone) reasons.push("data-affinity-mismatch");
  if (host.architecture !== request.architecture || host.runtimeBundleSha256 !== request.runtimeBundleSha256) {
    reasons.push("runtime-mismatch");
  }
  if (!validCapacity(host.size)) reasons.push("invalid-capacity");
  else if (host.size.cpuCount < request.minimum.cpuCount || host.size.memoryMiB < request.minimum.memoryMiB) {
    reasons.push("insufficient-capacity");
  }
  if (!positiveInteger(host.generation) || !positiveInteger(host.controllerFence)) reasons.push("invalid-generation");
  if (!Number.isSafeInteger(host.observedAtMs) || host.observedAtMs < 0 || host.observedAtMs > request.nowMs ||
      request.nowMs - host.observedAtMs > request.maxObservationAgeMs) reasons.push("stale-observation");
  const verifiedStoppedOwner = host.state === "stopped" && host.health === "stopped-verified" &&
    host.customerWorkspaceId === request.customerWorkspaceId && host.dataVolumeId === request.dataVolumeId;
  if (host.state === "stopped" ? !verifiedStoppedOwner : host.health !== "healthy") reasons.push("unhealthy");
  if (host.state !== "running" && host.state !== "stopped") reasons.push("unavailable");
  if (host.reservationId !== null) reasons.push("reserved");
  if (host.customerWorkspaceId !== null && host.customerWorkspaceId !== request.customerWorkspaceId) {
    reasons.push("foreign-tenant");
  }
  if (host.customerWorkspaceId === request.customerWorkspaceId) {
    if (host.dataVolumeId !== request.dataVolumeId) reasons.push("wrong-volume");
  } else if (host.customerWorkspaceId === null) {
    // A clean VM has NO customer volume, even one belonging to the requesting customer.
    if (host.dataVolumeId !== null || !nonEmpty(host.cleanAttestationRef ?? "")) reasons.push("unclean");
    if (host.state !== "running") reasons.push("warm-host-not-running");
  }
  return reasons;
}

/** Pure, deterministic selection; never reserves, boots, stops, moves or attaches a disk. */
export function selectWorkspaceHostPoolPlacement(
  request: WorkspaceHostPoolRequest,
  candidates: readonly WorkspaceHostPoolCandidate[],
): WorkspaceHostPoolPlacement {
  validateRequest(request);
  const ids = new Set<string>();
  for (const host of candidates) {
    if (!nonEmpty(host.hostId) || ids.has(host.hostId)) {
      throw new Error("workspace-host pool snapshot requires unique non-empty host ids");
    }
    ids.add(host.hostId);
  }
  const rejected: WorkspaceHostPoolRejection[] = [];
  const eligible: WorkspaceHostPoolCandidate[] = [];
  for (const host of candidates) {
    const reasons = refuse(request, host);
    if (reasons.length) rejected.push({ hostId: host.hostId, reasons });
    else eligible.push(host);
  }
  rejected.sort((a, b) => compare(a.hostId, b.hostId));
  const owners = candidates.filter((host) => host.workspaceId === request.workspaceId &&
    (host.customerWorkspaceId === request.customerWorkspaceId || host.dataVolumeId === request.dataVolumeId));
  // A stale/unhealthy owner or a second wake cannot be routed around by provisioning.
  // The existing durable operation must fence and reconcile that writer first. Even a
  // clean warm VM must not be assigned while another VM may own this tenant's data.
  if (owners.length > 1 || owners.some((owner) => !eligible.includes(owner))) {
    return { kind: "queue", reason: "existing-tenant-needs-reconciliation", rejected };
  }
  // Existing data locality first, then smallest adequate capacity, then stable id.
  // This is not a price ranking: no unmeasured price is silently assumed free.
  eligible.sort((a, b) =>
    Number(b.customerWorkspaceId === request.customerWorkspaceId) - Number(a.customerWorkspaceId === request.customerWorkspaceId) ||
    a.size.memoryMiB - b.size.memoryMiB || a.size.cpuCount - b.size.cpuCount || compare(a.hostId, b.hostId));
  const selected = eligible[0];
  if (!selected) return { kind: request.mayProvision ? "provision" : "queue", reason: "no-eligible-host", rejected };
  return {
    kind: selected.customerWorkspaceId === null ? "assign-warm" : selected.state === "stopped" ? "start" : "reuse",
    hostId: selected.hostId,
    generation: selected.generation,
    controllerFence: selected.controllerFence,
    rejected,
  };
}
