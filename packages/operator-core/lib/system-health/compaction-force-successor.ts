import { createHash } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import { lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
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
