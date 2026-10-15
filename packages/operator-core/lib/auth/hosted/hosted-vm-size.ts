/**
 * Own-VM size for a GCP workspace host, chosen from how many agents the workspace will run
 * (WI-10006498, plan agent-capacity-and-cost-gcp-2026-09-30).
 *
 * Before this, every hosted workspace got e2-standard-4 whatever its agent count. That shape is
 * measured to hold 15 mixed agents on its own VM (D-019), so a 50-agent workspace was
 * under-provisioned from its first boot, and fixing it later costs a resize (~110 s down).
 *
 * The rows are the MEASURED x86 mixed-work shapes. `maxAgents` is the own-VM limit the cost model
 * derives (scripts/agent-capacity/size-guide.ts `ownVmAgents`: the workspace's p99 busy agents
 * plus one slot for its Server). The Arm c4a shapes are measured too but are left out: the hosted
 * image is amd64 (GCP_FIRST_WORKSPACE_DEFAULTS.image).
 *
 * PINNED, not hand-maintained: scripts/agent-capacity/size-guide.test.ts fails if any row stops
 * matching the cost model, or if a pick here stops being the cheapest single x86 VM.
 * Dependency-free on purpose, so that test can import it without loading operator-core.
 */
export const HOSTED_GCP_OWN_VM_SIZES = [
  { size: 'e2-standard-4', maxAgents: 15 },
  { size: 'e2-standard-8', maxAgents: 67 },
  { size: 'e2-custom-16-32768', maxAgents: 158 },
] as const;

/** Largest workspace one measured x86 VM holds. More needs a shared pool (D-046), not a bigger VM. */
export const HOSTED_GCP_MAX_EXPECTED_AGENTS = HOSTED_GCP_OWN_VM_SIZES[HOSTED_GCP_OWN_VM_SIZES.length - 1].maxAgents;

/** A usable agent count: a whole number from 1 to {@link HOSTED_GCP_MAX_EXPECTED_AGENTS}. */
export function isValidExpectedAgents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= HOSTED_GCP_MAX_EXPECTED_AGENTS;
}

/**
 * The smallest measured x86 shape whose own-VM limit holds `expectedAgents`. Returns null for a
 * count outside 1..{@link HOSTED_GCP_MAX_EXPECTED_AGENTS}, so a caller refuses it instead of
 * silently provisioning a VM too small for it.
 */
export function hostedGcpSizeForAgents(expectedAgents: number): string | null {
  if (!isValidExpectedAgents(expectedAgents)) return null;
  return HOSTED_GCP_OWN_VM_SIZES.find((row) => expectedAgents <= row.maxAgents)?.size ?? null;
}
