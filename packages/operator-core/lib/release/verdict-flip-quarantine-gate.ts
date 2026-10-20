/**
 * P-008 (green-main-ratchet-convergence-2026-10-17, R-7): the green checkpoint's side of the
 * same-commit verdict-flip quarantine. `verdict-flip-quarantine.ts` holds the pure rules; this
 * module runs them once per gate run with injected effects, plus the production effects.
 *
 * Per run:
 *  1. Observations come from the gate's own isolation re-runs on the candidate (a file that
 *     failed in the suite and passed alone on the same tree flipped on that commit).
 *  2. Each new flip gets a de-quarantine work-item assigned to its owner FIRST, then the
 *     quarantine row naming it. A failed filing writes no row, so no quarantine is unowned.
 *  3. A critical-area quarantine notifies the owner at once.
 *  4. The ACTIVE quarantine rows (old and new) are returned for the caller to exclude from the
 *     failure count.
 * Every effect is best-effort per flip: one failure is reported and the rest continue.
 */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { GateVerdictTarget } from './gate-verdict-target';
import { pgTestDowngradeStore, type TestDowngradeRecord, type TestDowngradeStore } from './test-downgrade-store';
import {
  FLAKY_QUARANTINE_AUTHOR,
  FLAKY_QUARANTINE_KIND,
  buildFlakyQuarantineRecord,
  dequarantineWorkItemDraft,
  detectSameCommitVerdictFlips,
  observationsFromIsolationRetries,
  planVerdictFlipQuarantine,
  type IsolationRetry,
  type QuarantineAction,
  type VerdictFlip,
} from './verdict-flip-quarantine';

/** Who owns a new quarantine when nothing more specific is configured: the human owner. */
export const FLAKY_QUARANTINE_DEFAULT_OWNER = 'human';
/** Env override naming a standing flake owner (an agent id or `human`). */
export const FLAKY_QUARANTINE_OWNER_ENV = 'PAPERCUSP_FLAKY_QUARANTINE_OWNER';

export function flakyQuarantineOwnerFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env[FLAKY_QUARANTINE_OWNER_ENV] ?? '').trim() || FLAKY_QUARANTINE_DEFAULT_OWNER;
}

export interface VerdictFlipGateDeps {
  store: Pick<TestDowngradeStore, 'listActive' | 'insert' | 'markOwnerNotified'>;
  /** Files the de-quarantine work-item and returns its id. */
  fileWorkItem(draft: ReturnType<typeof dequarantineWorkItemDraft>): Promise<string>;
  notifyOwner(action: QuarantineAction, record: TestDowngradeRecord): Promise<void>;
  ownerOf(flip: VerdictFlip): string | null;
  now(): Date;
}

/** What one run did, persisted on `gate_health.verdictFlipQuarantine`. */
export interface VerdictFlipQuarantineHealth {
  flips: number;
  quarantined: { testFile: string; testCase: string; owner: string; workItemId: string }[];
  alreadyCovered: number;
  unowned: string[];
  errors: string[];
}

/**
 * Re-validate a `verdictFlipQuarantine` value read back out of JSON (the result marker) before
 * release-actions stores it in gate_health (WI-6554700010018008). A malformed value is dropped.
 */
export function parseVerdictFlipQuarantineHealth(value: unknown): VerdictFlipQuarantineHealth | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  if (typeof v.flips !== 'number' || typeof v.alreadyCovered !== 'number') return null;
  if (!strings(v.unowned) || !strings(v.errors) || !Array.isArray(v.quarantined)) return null;
  const quarantined = (v.quarantined as unknown[]).filter(
    (q): q is VerdictFlipQuarantineHealth['quarantined'][number] =>
      typeof q === 'object' && q !== null &&
      ['testFile', 'testCase', 'owner', 'workItemId'].every((k) => typeof (q as Record<string, unknown>)[k] === 'string'),
  );
  return {
    flips: v.flips,
    quarantined,
    alreadyCovered: v.alreadyCovered,
    unowned: v.unowned as string[],
    errors: v.errors as string[],
  };
}

export async function runVerdictFlipQuarantine(
  input: { candidateSha: string; retries: readonly IsolationRetry[]; workspaceDirOf: (ws: string) => string | null },
  deps: VerdictFlipGateDeps,
): Promise<{ health: VerdictFlipQuarantineHealth; active: TestDowngradeRecord[] }> {
  const flips = detectSameCommitVerdictFlips(
    observationsFromIsolationRetries(input.candidateSha, input.retries, input.workspaceDirOf),
  );
  const health: VerdictFlipQuarantineHealth = { flips: flips.length, quarantined: [], alreadyCovered: 0, unowned: [], errors: [] };
  let active = await deps.store.listActive();
  if (flips.length === 0) return { health, active };
  const plan = planVerdictFlipQuarantine({ flips, active, ownerOf: deps.ownerOf });
  health.alreadyCovered = plan.alreadyCovered.length;
  health.unowned = plan.unowned.map((f) => f.testFile);
  for (const action of plan.toQuarantine) {
    const label = action.flip.testCase ? `${action.flip.testFile} > ${action.flip.testCase}` : action.flip.testFile;
    try {
      const workItemId = await deps.fileWorkItem(dequarantineWorkItemDraft(action));
      const built = buildFlakyQuarantineRecord(action, workItemId);
      if (!built.ok) {
        health.errors.push(`${label}: ${built.problems.join('; ')}`);
        continue;
      }
      const inserted = await deps.store.insert(built.record);
      if ('conflict' in inserted) {
        health.alreadyCovered += 1;
        continue;
      }
      health.quarantined.push({ testFile: inserted.testFile, testCase: inserted.testCase, owner: inserted.owner, workItemId });
      if (action.notifyOwner) {
        await deps.notifyOwner(action, inserted);
        await deps.store.markOwnerNotified(inserted.id, deps.now());
      }
    } catch (error) {
      health.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (health.quarantined.length > 0) active = await deps.store.listActive();
  return { health, active };
}

/** Production effects for one gate target: the Postgres store, the issue writer, a coord notice. */
export async function verdictFlipGateDepsFor(target: GateVerdictTarget): Promise<VerdictFlipGateDeps> {
  const [{ getOrgPg }, { createIssue }, { runWithWorkspace }, { sendMessage }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../issues-engineer'),
    import('../workspace-als'),
    import('../agent-tools/coordination/messages'),
  ]);
  const owner = flakyQuarantineOwnerFromEnv();
  const identity: AgentIdentity = {
    ownerId: FLAKY_QUARANTINE_AUTHOR,
    ownerLabel: 'system · flaky quarantine',
    source: 'principal',
    workspaceId: target.workspaceId,
    userId: null,
  };
  return {
    store: pgTestDowngradeStore(getOrgPg().sql, { workspaceId: target.workspaceId, harnessSlug: target.installSlug }),
    async fileWorkItem(draft) {
      const issue = await runWithWorkspace(target.workspaceId, () =>
        createIssue({
          title: draft.title,
          body: draft.body,
          severity: draft.severity,
          kind: 'bug',
          scope: `harness:${target.installSlug}`,
          assignee: draft.assignee,
          assignedBy: FLAKY_QUARANTINE_AUTHOR,
          createdBy: FLAKY_QUARANTINE_AUTHOR,
          topics: ['release-gate', FLAKY_QUARANTINE_KIND],
          sourcePlanSlug: 'green-main-ratchet-convergence-2026-10-17',
          sourcePlanItemIds: ['P-008'],
        }),
      );
      return issue.id;
    },
    async notifyOwner(action, record) {
      const area = action.criticalArea;
      await runWithWorkspace(target.workspaceId, () =>
        sendMessage(identity, {
          to: ['human'],
          summary: `Critical-area test quarantined as flaky: ${record.testFile}`,
          body:
            `The gate quarantined '${record.testFile}' automatically: its verdict flipped on one commit, so it cannot tell ` +
            `whether ${area?.label ?? 'this area'} is broken. While quarantined, main can promote with it unchecked` +
            `${area ? `: ${area.risk}` : ''}. De-quarantine work-item: ${record.bugId}.`,
          expectsReply: false,
          harnessSlug: target.installSlug,
        }),
      );
    },
    ownerOf: () => owner,
    now: () => new Date(),
  };
}
