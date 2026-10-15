/** BYOC release-journal -> agent carry adapter. */
import type { Sql } from 'postgres';
import type { TaskReleaseJournal, TaskReleaseReceipt, TaskReleaseReceiptState } from './task-manager/store';
import { taskReleaseJournalFromDetail } from './task-manager/store';
import { evaluateWorkspaceHostSoak, resolveWorkspaceHostSoakPolicy, type WorkspaceHostSoakPolicy } from './workspace-host/soak';
import type { WorkspaceHostSoakRecord } from './workspace-host/soak-store';

export const BYOC_RELEASE_CARRY_SCHEMA_VERSION = 'byoc-release-carry-v1' as const;
export const BYOC_RELEASE_CARRY_MAX = 3;

export const BYOC_RELEASE_MILESTONES = [
  { key: 'build', label: 'build', stages: ['release.build.'] },
  { key: 'publication', label: 'publication', stages: ['publish.finalize'] },
  { key: 'root-bootstrap', label: 'root bootstrap', stages: ['workspace.root-bootstrap', 'root.bootstrap'] },
  { key: 'fixed-agent-initialization', label: 'fixed-agent initialization', stages: ['workspace.fixed-agent-initialization', 'fixed-agent.initialization'] },
  { key: 'customer-acceptance', label: 'DesktopSession/customer acceptance', stages: ['desktop-session.customer-acceptance', 'customer.acceptance'] },
  { key: 'soak', label: 'soak', stages: ['acceptance.soak', 'acceptance.soak-24h', 'release.soak-24h'] },
  { key: 'resource-census', label: 'teardown/eight-kind resource census', stages: ['teardown.resource-census'] },
  { key: 'billing-closure', label: 'billing closure', stages: ['billing.closure'] },
  { key: 'cleanup', label: 'cleanup', stages: ['release.cleanup'] },
  { key: 'shipment', label: 'final green shipment', stages: ['release.shipment.green', 'deploy.green'] },
] as const;

export type ByocReleaseMilestoneKey = (typeof BYOC_RELEASE_MILESTONES)[number]['key'];
export type ByocReleaseMilestoneStatus = 'verified' | 'failed' | 'pending' | 'blocked';

export interface ByocReleaseMilestone {
  key: ByocReleaseMilestoneKey;
  label: string;
  status: ByocReleaseMilestoneStatus;
  receiptState: TaskReleaseReceiptState | null;
  receiptSequence: number | null;
  evidenceRefs: string[];
}

export interface ByocReleaseMilestoneProjection {
  current: ByocReleaseMilestoneKey | null;
  customerReady: boolean;
  shipped: boolean;
  milestones: ByocReleaseMilestone[];
  contradictions: string[];
}

export interface ByocReleaseCarrySnapshot {
  schemaVersion: typeof BYOC_RELEASE_CARRY_SCHEMA_VERSION;
  taskId: string;
  workItemId: string | null;
  operationId: string;
  cursor: number;
  currentStage: string | null;
  currentState: TaskReleaseReceiptState | null;
  artifactIdentity: unknown;
  sourceIdentity: unknown;
  credentialGeneration: string | null;
  credentialExpiresAt: string | null;
  spentRequestIdentities: string[];
  evidenceRefs: string[];
  milestoneProjection: ByocReleaseMilestoneProjection;
  nextAction: string;
  /** Exact ledger pointer for older receipts/input preimages omitted here. */
  historyRef: string;
}

function receiptMatchesMilestone(
  receipt: TaskReleaseReceipt,
  milestone: (typeof BYOC_RELEASE_MILESTONES)[number],
): boolean {
  return milestone.stages.some((stage) =>
    stage.endsWith('.') ? receipt.stage.startsWith(stage) : receipt.stage === stage,
  ) || receipt.evidenceRefs.includes(`milestone:${milestone.key}`);
}

/**
 * Derive the user-visible release phase from the complete receipt chain. A
 * downstream committed receipt is evidence, but it is not permission to skip a
 * failed or absent prerequisite: the public phase advances only across the
 * contiguous verified prefix and the impossible chain is reported explicitly.
 */
export interface ByocReleaseMilestoneOptions {
  /** An explicit acceptance bar; omitted keeps the ordinary receipt-only carry view. */
  minimumSoakDurationMs?: number;
}

function oneEvidenceValue(receipt: TaskReleaseReceipt, prefix: string): string | null {
  const refs = receipt.evidenceRefs.filter((ref) => ref.startsWith(prefix));
  return refs.length === 1 && refs[0]!.length > prefix.length ? refs[0]!.slice(prefix.length) : null;
}

function receiptSoakPolicy(receipt: TaskReleaseReceipt): WorkspaceHostSoakPolicy | null {
  const policy = objectOrNull(objectOrNull(objectOrNull(receipt.inputIdentity)?.stageIdentity)?.policy);
  if (!policy) return null;
  try {
    const resolved = resolveWorkspaceHostSoakPolicy({
      durationMs: policy.durationMs as number, intervalMs: policy.intervalMs as number,
    });
    return Object.entries(resolved).every(([key, value]) => policy[key] === value) ? resolved : null;
  } catch {
    return null;
  }
}

function soakReceiptProblems(receipt: TaskReleaseReceipt | null, minimum: number): string[] {
  if (!Number.isSafeInteger(minimum) || minimum <= 0) return ['soak minimum duration must be a positive integer'];
  if (!receipt || receipt.state !== 'committed') return [];
  const problems: string[] = [];
  const policy = receiptSoakPolicy(receipt);
  if (!policy || policy.durationMs < minimum) problems.push('soak policy does not cover the required duration');
  if (oneEvidenceValue(receipt, 'soak-verdict:') !== 'pass') problems.push('soak receipt lacks one unambiguous passing evaluator verdict');
  const window = oneEvidenceValue(receipt, 'soak-window:')?.split('/');
  const times = window?.map((value) => Date.parse(value));
  if (!window || window.length !== 2 || !times?.every(Number.isFinite) ||
      window.some((value, index) => new Date(times[index]!).toISOString() !== value) ||
      times[1]! - times[0]! < Math.max(minimum, policy?.durationMs ?? minimum)) {
    problems.push('soak receipt lacks one valid window covering its policy and required duration');
  }
  return problems;
}

/**
 * Receipt projection only. An explicit duration bar rejects short or contradictory soak receipts;
 * deployed acceptance also needs readByocReleaseAcceptance to join the canonical persisted outcome.
 */
export function projectByocReleaseMilestones(
  journal: TaskReleaseJournal,
  options: ByocReleaseMilestoneOptions = {},
): ByocReleaseMilestoneProjection {
  return projectMilestones(journal, options);
}

function projectMilestones(
  journal: TaskReleaseJournal,
  options: ByocReleaseMilestoneOptions,
  persistedSoakProblems: readonly string[] = [],
): ByocReleaseMilestoneProjection {
  let prefixVerified = true;
  let current: ByocReleaseMilestoneKey | null = null;
  const contradictions: string[] = [];
  const milestones = BYOC_RELEASE_MILESTONES.map((definition) => {
    const receipt = [...journal.receipts].reverse().find((candidate) =>
      receiptMatchesMilestone(candidate, definition),
    ) ?? null;
    const soakProblems = definition.key === 'soak' ? [
      ...(options.minimumSoakDurationMs === undefined ? [] : soakReceiptProblems(receipt, options.minimumSoakDurationMs)),
      ...persistedSoakProblems,
    ] : [];
    contradictions.push(...soakProblems);
    const receiptVerified = receipt?.state === 'committed' && soakProblems.length === 0;
    let status: ByocReleaseMilestoneStatus;
    if (receiptVerified && prefixVerified) {
      status = 'verified';
      current = definition.key;
    } else if (receiptVerified) {
      status = 'blocked';
      contradictions.push(
        `${definition.label} has a committed receipt but an earlier prerequisite is not verified`,
      );
    } else if (receipt?.state === 'refused' || soakProblems.length > 0) {
      status = 'failed';
    } else {
      status = 'pending';
    }
    if (!receiptVerified) prefixVerified = false;
    return {
      key: definition.key,
      label: definition.label,
      status,
      receiptState: receipt?.state ?? null,
      receiptSequence: receipt?.sequence ?? null,
      evidenceRefs: [...(receipt?.evidenceRefs ?? [])],
    };
  });
  const customerReady = milestones
    .slice(0, BYOC_RELEASE_MILESTONES.findIndex((entry) => entry.key === 'customer-acceptance') + 1)
    .every((milestone) => milestone.status === 'verified');
  const shipped = milestones.every((milestone) => milestone.status === 'verified');
  return { current, customerReady, shipped, milestones, contradictions };
}

/**
 * Re-read an explicitly selected release task, then judge the exact soak named by its receipt from
 * the maintained persisted-sample reader and evaluator. This is an acceptance detector, not a soak
 * producer or proof that this candidate was promoted/deployed green.
 */
export async function readByocReleaseAcceptance(
  input: { taskId: string; workspaceId: string; minimumSoakDurationMs: number },
  sql: Sql,
  readSoak?: (workspaceId: string, hostId: string, soakId: string) => Promise<WorkspaceHostSoakRecord>,
): Promise<ByocReleaseMilestoneProjection | null> {
  const rows = await sql<Array<{ detail: Record<string, unknown> | null }>>`
    SELECT detail FROM harness_shared.task_ledger
     WHERE workspace_id = ${input.workspaceId} AND task_id = ${input.taskId} AND class = 'deploy'
  `;
  const journal = taskReleaseJournalFromDetail(rows[0]?.detail);
  if (!journal) return null;
  const options = { minimumSoakDurationMs: input.minimumSoakDurationMs };
  const projection = projectByocReleaseMilestones(journal, options);
  if (projection.milestones.find(({ key }) => key === 'soak')?.status !== 'verified') return projection;
  const receipt = [...journal.receipts].reverse().find((candidate) =>
    receiptMatchesMilestone(candidate, BYOC_RELEASE_MILESTONES.find(({ key }) => key === 'soak')!),
  )!;
  const problems: string[] = [];
  const soakId = oneEvidenceValue(receipt, 'soak:');
  const host = oneEvidenceValue(receipt, 'soak-host:')?.split('/');
  const incarnation = oneEvidenceValue(receipt, 'soak-incarnation:');
  const image = oneEvidenceValue(receipt, 'soak-image:');
  if (!soakId || !host || host.length !== 2 || host[0] !== input.workspaceId || !host[1] || !incarnation || !image) {
    problems.push('soak receipt lacks an unambiguous subject in the selected workspace');
  } else {
    const read = readSoak ?? (await import('./workspace-host/soak-store')).readWorkspaceHostSoak;
    const record = await read(input.workspaceId, host[1], soakId);
    const policy = receiptSoakPolicy(receipt)!;
    const stage = objectOrNull(objectOrNull(receipt.inputIdentity)?.stageIdentity);
    const { releaseJournalBundleDigests } = await import('./workspace-host/release-stage-receipt');
    const digests = releaseJournalBundleDigests(journal);
    if (digests.length !== 1 || stage?.bundleSha256 !== digests[0]) {
      problems.push('soak receipt bundle does not match one unambiguous release candidate');
    }
    if (record.soakId !== soakId || record.envelope?.releaseTaskId !== input.taskId ||
        !Object.entries(policy).every(([key, value]) =>
          objectOrNull(record.envelope?.policy)?.[key] === value) ||
        record.malformedRows !== 0 ||
        record.samples.some((sample) => sample.soakId !== soakId ||
          sample.pinned.instanceId !== incarnation || sample.pinned.image !== image)) {
      problems.push('persisted soak identity, policy or sample integrity disagrees with the release receipt');
    }
    const evaluation = evaluateWorkspaceHostSoak({ samples: record.samples, policy, ended: true });
    if (evaluation.verdict !== 'pass' || evaluation.soakId !== soakId ||
        oneEvidenceValue(receipt, 'soak-window:') !== `${evaluation.window.first}/${evaluation.window.last}`) {
      problems.push('persisted soak evaluator does not confirm the committed passing window');
    }
  }
  return projectMilestones(journal, options, problems);
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function latestReceipt(journal: TaskReleaseJournal): TaskReleaseReceipt | null {
  return journal.receipts.at(-1) ?? null;
}

function nextActionFor(journal: TaskReleaseJournal): string {
  const latest = latestReceipt(journal);
  if (!latest) return 'Begin the first stage through the maintained release driver.';
  if (latest.state === 'intent' || latest.state === 'unknown') {
    return `Reconcile request ${latest.requestIdentity} at stage ${latest.stage} before any further mutation.`;
  }
  if (latest.state === 'refused') {
    return latest.evidenceRefs.includes('reconcile:confirmed-absent')
      ? `Resume stage ${latest.stage} through the maintained driver; it must mint a new one-use request identity.`
      : `Stop at stage ${latest.stage}; inspect its refusal evidence before retrying.`;
  }
  return `Advance through the maintained release driver without rerunning committed stage ${latest.stage}.`;
}

/**
 * Build the current compact receipt from the complete canonical journal. A
 * later call replaces an older projection wholesale; carry prose is never an
 * authority that can outvote the journal.
 */
export function projectByocReleaseCarry(
  taskId: string,
  workItemId: string | null,
  journal: TaskReleaseJournal,
): ByocReleaseCarrySnapshot {
  const credential = objectOrNull(journal.credential);
  return {
    schemaVersion: BYOC_RELEASE_CARRY_SCHEMA_VERSION,
    taskId,
    workItemId,
    operationId: journal.operationId,
    cursor: journal.cursor,
    currentStage: journal.currentStage,
    currentState: journal.currentState,
    artifactIdentity: journal.artifactIdentity ?? null,
    sourceIdentity: journal.source ?? null,
    credentialGeneration: typeof credential?.generation === 'string' ? credential.generation : null,
    credentialExpiresAt: typeof credential?.expiresAt === 'string' ? credential.expiresAt : null,
    spentRequestIdentities: [...journal.spentOperationIds],
    evidenceRefs: [...new Set(journal.receipts.flatMap((receipt) => receipt.evidenceRefs))],
    milestoneProjection: projectByocReleaseMilestones(journal),
    nextAction: nextActionFor(journal),
    historyRef: `task:${taskId}#release`,
  };
}

export interface ReadLinkedByocReleaseCarryInput {
  ownerId: string;
  workspaceId: string;
  heldWorkItemIds: readonly string[];
  limit?: number;
}

/**
 * Read only explicitly-associated deploy tasks. Selecting the workspace's
 * latest deploy would leak another agent's lane into this session's carry.
 */
export async function readLinkedByocReleaseCarries(
  input: ReadLinkedByocReleaseCarryInput,
  sql: Sql,
): Promise<ByocReleaseCarrySnapshot[]> {
  const held = [...new Set(input.heldWorkItemIds.filter(Boolean))];
  const limit = Math.min(Math.max(input.limit ?? BYOC_RELEASE_CARRY_MAX, 1), BYOC_RELEASE_CARRY_MAX);
  const rows = await sql<Array<{
    task_id: string;
    work_item_id: string | null;
    detail: Record<string, unknown> | null;
  }>>`
    SELECT task_id, work_item_id, detail
      FROM harness_shared.task_ledger
     WHERE workspace_id = ${input.workspaceId}
       AND class = 'deploy'
       AND jsonb_typeof(detail -> 'release') = 'object'
       AND (
         (${held.length > 0} AND work_item_id = ANY(${sql.array(held)}::text[]))
         OR detail ->> 'coordOwnerId' = ${input.ownerId}
       )
     ORDER BY (ended_at IS NULL) DESC, updated_at DESC, task_id DESC
     LIMIT ${limit}
  `;
  const snapshots: ByocReleaseCarrySnapshot[] = [];
  for (const row of rows) {
    const journal = taskReleaseJournalFromDetail(row.detail);
    if (journal) snapshots.push(projectByocReleaseCarry(row.task_id, row.work_item_id, journal));
  }
  return snapshots;
}

function compactList(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.join(', ') : empty;
}

export function renderByocReleaseCarry(snapshot: ByocReleaseCarrySnapshot): string {
  const milestones = snapshot.milestoneProjection.milestones
    .map((milestone) => `${milestone.label}=${milestone.status}${milestone.evidenceRefs.length > 0 ? ` [${milestone.evidenceRefs.join(', ')}]` : ''}`)
    .join('; ');
  return [
    `  • task ${snapshot.taskId}${snapshot.workItemId ? ` (work-item ${snapshot.workItemId})` : ''}`,
    `    operation=${snapshot.operationId}; cursor=${snapshot.cursor}; stage=${snapshot.currentStage ?? 'not-started'}; state=${snapshot.currentState ?? 'absent'}`,
    `    source=${JSON.stringify(snapshot.sourceIdentity)}; artifact=${JSON.stringify(snapshot.artifactIdentity)}`,
    `    credential=${snapshot.credentialGeneration ?? 'none'}${snapshot.credentialExpiresAt ? ` (expires ${snapshot.credentialExpiresAt})` : ''}`,
    `    spent request ids: ${compactList(snapshot.spentRequestIdentities, 'none')}`,
    `    evidence refs: ${compactList(snapshot.evidenceRefs, 'none')}`,
    `    evidence-backed milestones: ${milestones}`,
    `    customer-ready=${snapshot.milestoneProjection.customerReady}; shipped=${snapshot.milestoneProjection.shipped}`,
    ...(snapshot.milestoneProjection.contradictions.length > 0
      ? [`    ⚠ receipt contradictions: ${snapshot.milestoneProjection.contradictions.join('; ')}`]
      : []),
    `    next: ${snapshot.nextAction}`,
    `    older receipt narrative/input preimages: ${snapshot.historyRef}`,
  ].join('\n');
}
