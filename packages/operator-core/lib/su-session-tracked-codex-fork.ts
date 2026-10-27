/** Prepare a native fork without starting a turn or inheriting runtime duties. */
import { resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { prepareSuLaunch } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { getAdvSessionInWorkspace } from './adv-sessions';
import { resolveAgentBinarySync } from './agent-bin-detect';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { CodexNativeSessionHandle } from './native-session-handles';
import { forkCodexNativeHistory, prepareCodexForkHistory } from './su-session-codex-fork';
import { startSuStdioPeer, type SuStdioPeer } from './su-session-stdio-peer';

export interface TrackedCodexForkSource {
  advSessionId: number;
  nativeSessionId: string;
}
export interface NativeForkLineage extends TrackedCodexForkSource {
  ownerId: string;
}

export async function resolveTrackedCodexForkSource(input: TrackedCodexForkSource,
  workspaceId: string, cwd: string): Promise<CodexNativeSessionHandle> {
  const parent = await getAdvSessionInWorkspace(input.advSessionId, workspaceId);
  if (!parent || parent.agent !== 'codex' || !parent.coordOwnerId || parent.retiredAt
    || parent.sessionId !== input.nativeSessionId || !parent.cwd || resolve(parent.cwd) !== resolve(cwd)) {
    throw new Error('Tracked Codex fork source does not match its recorded workspace, native identity and project');
  }
  return { backend: 'codex', source: 'adv_sessions', ownerId: parent.coordOwnerId,
    codexHome: codexHomeForSessionKey(parent.id), rolloutId: input.nativeSessionId,
    exactResumeSupported: true, missingReason: null };
}

/** Native ID and lineage commit together. The source cannot be substituted
 * between history capture and registration, and an existing child is immutable. */
export async function registerTrackedCodexFork(input: {
  workspaceId: string; childAdvSessionId: number; childOwnerId: string;
  childNativeSessionId: string; source: NativeForkLineage;
}): Promise<void> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: number }[]>`
    UPDATE harness_shared.adv_sessions child
       SET session_id = ${input.childNativeSessionId},
           launch_spec = jsonb_set(child.launch_spec, '{nativeFork}', ${JSON.stringify(input.source)}::text::jsonb)
      FROM harness_shared.adv_sessions parent
     WHERE child.id = ${input.childAdvSessionId} AND child.workspace_id = ${input.workspaceId}
       AND child.coord_owner_id = ${input.childOwnerId} AND child.agent = 'codex'
       AND child.session_id IS NULL AND child.ended_at IS NULL AND child.retired_at IS NULL
       AND jsonb_typeof(child.launch_spec) = 'object'
       AND parent.id = ${input.source.advSessionId} AND parent.workspace_id = child.workspace_id
       AND parent.coord_owner_id = ${input.source.ownerId} AND parent.agent = 'codex'
       AND parent.session_id = ${input.source.nativeSessionId} AND parent.retired_at IS NULL
       AND parent.id <> child.id AND parent.coord_owner_id <> child.coord_owner_id
       AND parent.session_id <> ${input.childNativeSessionId}
     RETURNING child.id`;
  if (rows.length !== 1) throw new Error('Tracked Codex fork native identity and lineage registration refused');
}

/** Bootstrap's replay receipt is written only after this peer has exited and
 * registration has committed. The CLI then resumes the exact child UUID. */
export async function completeTrackedCodexFork(boot: BootstrapSuResult,
  source: TrackedCodexForkSource,
  deps: { startPeer?: typeof startSuStdioPeer } = {}): Promise<{ nativeSessionId: string; nativeFork: NativeForkLineage }> {
  const ownerId = boot.envelopeEnv.PAPERCUSP_SID;
  if (boot.agent !== 'codex' || !boot.sessionId || !ownerId || !boot.codexHome) {
    throw new Error('Tracked Codex fork requires a complete fresh child bootstrap');
  }
  const parent = await resolveTrackedCodexForkSource(source, boot.workspaceId, boot.cwd);
  const nativeFork = { ...source, ownerId: parent.ownerId! };
  const launch = prepareSuLaunch(boot, { executionKind: 'programmatic' });
  const prepared = await prepareCodexForkHistory({ source: parent, childOwnerId: ownerId, childHome: boot.codexHome });
  let peer: SuStdioPeer | undefined;
  let unregisteredRollout: string | undefined;
  let unregisteredChildId: string | undefined;
  try {
    const binary = resolveAgentBinarySync('codex') ?? 'codex';
    peer = await (deps.startPeer ?? startSuStdioPeer)({ binary, args: ['app-server'],
      cwd: boot.cwd, env: launch.env, workspaceId: boot.workspaceId, ownerId, onMessage: () => {},
      spec: { class: 'agent-session', title: 'Prepare tracked Codex fork', launchedBy: ownerId,
        argv: [binary, 'app-server'], cwd: boot.cwd,
        detail: { coordOwnerId: ownerId, advSessionId: boot.sessionId, forkSourceAdvSessionId: source.advSessionId } } });
    await peer.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_fork', version: '1' } } });
    peer.send({ method: 'initialized', params: {} });
    const result = await forkCodexNativeHistory({ peer, source: parent, prepared,
      childOwnerId: ownerId, childHome: boot.codexHome,
      retainHistory: false,
      params: { cwd: boot.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' } });
    const nativeSessionId = String((result.thread as { id: string }).id);
    // forkCodexNativeHistory has verified this path belongs to the fresh child.
    unregisteredRollout = (result.thread as { path: string }).path;
    unregisteredChildId = nativeSessionId;
    await peer.close(); await peer.done; peer = undefined;
    await registerTrackedCodexFork({ workspaceId: boot.workspaceId, childAdvSessionId: boot.sessionId,
      childOwnerId: ownerId, childNativeSessionId: nativeSessionId, source: nativeFork });
    prepared.retain();
    unregisteredRollout = undefined;
    return { nativeSessionId, nativeFork };
  } finally {
    try { if (peer) { await peer.close(); await peer.done; } }
    finally {
      try { if (unregisteredRollout) await unlink(unregisteredRollout); }
      finally { await prepared.cleanup(unregisteredChildId); }
    }
  }
}
