import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { withWorkspace } from '@papercusp/db-org';
import { lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { markAdvSessionEnded } from '../adv-sessions';
import { probeProcessLiveness } from '../agent-tools/coordination/presence';
import {
  INTERNAL_EXPECTED_SUCCESSOR_BINDING,
  type InternalExpectedSuccessorBinding,
  type ResumeTarget,
} from '../agent-launch-core';
import { PROJECTED_DEPS } from '../projected-tool-deps';

export type CompactionForceSuccessorTarget = ResumeTarget & {
  ownerId: string;
  workspaceId: string;
  harnessSlug: string;
  binding: NonNullable<ResumeTarget['binding']>;
};

export interface CompactionForceSuccessorInput {
  target: CompactionForceSuccessorTarget;
  brief: string;
}

export interface CompactionForceSuccessorResult {
  verified: boolean;
  detail: string;
}

export type HostlessSourceProcessVerdict = 'dead' | 'live' | 'unknown';

/**
 * Hostless recovery may only close an open source row after a positive local
 * process-death observation. `display:'terminal'` is the adv-session contract
 * that the recorded pid belongs to this operator host. Headless launches are
 * also local psu processes, but intentionally have no display marker; their
 * explicit `headless` placement is the local provenance for probing the pid.
 * A missing/other display without that headless provenance, missing pid,
 * remote/ambiguous probe, or live pid stays unknown/live and keeps the identity
 * fence closed.
 */
export function hostlessSourceProcessVerdict(
  target: Pick<CompactionForceSuccessorTarget, 'live' | 'endedAt' | 'endedBy' | 'display' | 'headless' | 'pid'>,
  probe: (record: { host?: string | null; pid?: number | null }) => boolean | null = probeProcessLiveness,
  localHost = hostname(),
): HostlessSourceProcessVerdict {
  if (target.endedAt != null || target.endedBy != null) return 'dead';
  if (target.live) return 'live';
  const localProcessProvenance = target.display === 'terminal' ||
    (target.headless === true && (target.display == null || target.display === ''));
  if (!localProcessProvenance || !Number.isSafeInteger(target.pid) || (target.pid ?? 0) <= 0) {
    return 'unknown';
  }
  const observed = probe({ host: localHost, pid: target.pid });
  return observed === false ? 'dead' : observed === true ? 'live' : 'unknown';
}

/** Reconcile one exact hostless source incarnation before retaining its owner id. */
async function reconcileHostlessSource(
  target: CompactionForceSuccessorTarget,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const verdict = hostlessSourceProcessVerdict(target);
  if (verdict === 'live') {
    return { ok: false, detail: 'the source process is still live; identity-preserving replacement is refused' };
  }
  if (verdict !== 'dead') {
    return {
      ok: false,
      detail: 'the source has no live PTY host but its local terminal process death is unproven; identity-preserving replacement is refused',
    };
  }
  // A reconciler/reaper may have already recorded this exact source as ended.
  // Repeating the terminal UPDATE would lose its `ended_at IS NULL` CAS and
  // incorrectly block recovery; launch-agent rechecks the immutable binding,
  // live host, and Codex writer before opening the successor.
  if (target.endedAt != null) return { ok: true };
  try {
    const ended = await markAdvSessionEnded(target.advSessionId, null, 'reconciler', {
      expectedBinding: target.binding,
      throwOnError: true,
    });
    return ended
      ? { ok: true }
      : { ok: false, detail: 'the exact hostless source binding lost its compare-and-swap' };
  } catch (error) {
    return {
      ok: false,
      detail: `hostless source terminal reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function forceSuccessorIdempotencyKey(target: CompactionForceSuccessorTarget): string {
  const identity = [
    target.ownerId,
    target.workspaceId,
    target.advSessionId,
    target.binding.coordOwnerId,
    target.binding.sessionId ?? '',
    target.binding.startedAt,
  ].join('\0');
  return `compaction-force-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resultData(result: unknown): Record<string, unknown> | null {
  const root = asRecord(result);
  const structured = asRecord(root?.structuredContent);
  return asRecord(structured?.data) ?? asRecord(root?.data) ?? structured ?? root;
}

function resultText(result: unknown): string | null {
  const root = asRecord(result);
  const content = Array.isArray(root?.content) ? root.content : [];
  const text = content.map(asRecord).find((item) => typeof item?.text === 'string')?.text;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 700) : null;
}

function verifiedSuccessorResult(
  result: unknown,
  ownerId: string,
): boolean {
  const root = asRecord(result);
  const data = resultData(result);
  const launch = asRecord(data?.launch);
  const verdict = asRecord(launch?.freshVerdict);
  const sessions = Array.isArray(verdict?.sessions) ? verdict.sessions.map(asRecord) : [];
  return root?.isError !== true &&
    launch?.mode === 'successor' &&
    launch?.resumedOwnerId === ownerId &&
    launch?.agentStarted === true &&
    verdict?.agentStarted === true &&
    sessions.some((session) => session?.ownerId === ownerId);
}

/**
 * Internal successor dispatch for the watchdog's no-PTY-host force path.
 * This uses the normal projected capability so launch preflight, source
 * reconciliation, terminal evidence, process supervision, and launch proof
 * remain on the canonical path.
 */
export async function dispatchCompactionForceSuccessor(
  input: CompactionForceSuccessorInput,
): Promise<CompactionForceSuccessorResult> {
  const toolName = 'capability:launch-agent';
  const tool = lookupByMcpName(toolName);
  if (!tool) return { verified: false, detail: 'capability:launch-agent is not registered.' };

  const { target } = input;
  const actor = 'system:compaction-compliance-watchdog';
  const expected: InternalExpectedSuccessorBinding = {
    ownerId: target.ownerId,
    advSessionId: target.advSessionId,
    workspaceId: target.workspaceId,
    harnessSlug: target.harnessSlug,
    binding: target.binding,
    requirePositiveTerminalEvidence: true,
  };
  const args = {
    successor: { agentId: target.ownerId },
    brief: input.brief,
    harness: target.harnessSlug,
    headless: target.headless === true,
    idempotencyKey: forceSuccessorIdempotencyKey(target),
  };

  const result = await withWorkspace(target.workspaceId, async (tx) => {
    const source = await reconcileHostlessSource(target);
    if (!source.ok) return { isError: true, content: [{ type: 'text', text: source.detail }] };
    const ctx = {
      workspaceId: target.workspaceId,
      harnessSlug: target.harnessSlug,
      role: 'operator',
      featureId: null,
      chunkId: null,
      runId: `compaction-force-successor-${target.advSessionId}`,
      spawnId: 'compaction-compliance-watchdog',
      parentSpawnId: null,
      uiClientId: actor,
      isSuperuser: false,
      gateBypass: { capability: true, quota: true },
      profile: 'engineer',
      transport: 'in_process',
      log: () => {},
      progress: () => {},
      emit: () => {},
      signal: new AbortController().signal,
      tx,
      principal: {
        slug: actor,
        workspaceId: target.workspaceId,
        capabilities: new Set(['*']),
      },
    } as UnifiedToolContext & { [INTERNAL_EXPECTED_SUCCESSOR_BINDING]?: InternalExpectedSuccessorBinding };
    ctx[INTERNAL_EXPECTED_SUCCESSOR_BINDING] = expected;
    return dispatchProjectedToolToMcp(tool, toolName, args, ctx, PROJECTED_DEPS);
  });

  if (verifiedSuccessorResult(result, target.ownerId)) {
    return { verified: true, detail: 'The successor launch and first turn were positively verified.' };
  }
  return {
    verified: false,
    detail: resultText(result) ?? 'The successor launch did not return positive first-turn evidence.',
  };
}
