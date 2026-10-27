/** Read-only production preparation. No archive restoration, configuration
 * materialization, checkpoint write, lease acquisition or inbox consumption. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { resolveResumeTarget, type ResumeTarget } from './agent-launch-core';
import { getAdvSession } from './adv-sessions';
import { loopScope } from './carry-note';
import { findSessionTranscript } from './claude-sessions';
import { findLiveHostAsync } from './events/await/psu-pty-discovery';
import { nativeSessionHandleForAdvSession } from './native-session-handles';
import { readProcessIdentity } from './process-identity';
import { readAssumeCallerPause } from './session-assume-pause';
import { findCodexRolloutPathByUuid, findOmpSessionPath } from './session-transcript-resolvers';
import { codexThreadWriterHolder, sessionProcessHolder } from '../../../apps/operator/scripts/psu-launcher.mjs';
import type { AssumeActor, AssumeCaller, AssumeContext, AssumePreparation, AssumeRequest, AssumeTarget } from './session-assume';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const backendOf = (value: string | null): AssumeTarget['backend'] | null =>
  value === 'claude' || value === 'codex' || value === 'omp' ? value : null;

/** A host-owned file under the exact target's native home. Links below that
 * root, incomplete JSONL, mismatched native ids and concurrent edits refuse. */
export async function readAssumeTranscriptPin(
  file: string, root: string, backend: AssumeTarget['backend'], nativeId: string,
  prefix?: AssumeContext,
): Promise<AssumeContext | null> {
  try {
    const inside = relative(root, file);
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) return null;
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(file);
    if (canonicalFile !== join(canonicalRoot, inside)) return null;
    const fd = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await fd.stat();
      // Bounded parsing matches the existing complete-native-source reader's
      // contract. Oversized/partial sources are unavailable, never downgraded
      // to a guessed transcript or checkpoint mode.
      if (!before.isFile() || before.size === 0 || before.size > 16 * 1024 * 1024) return null;
      const bytes = await fd.readFile();
      const after = await lstat(canonicalFile);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== bytes.length || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
      const source = bytes.toString('utf8');
      if (!Buffer.from(source, 'utf8').equals(bytes)) return null;
      let bound = false;
      for (const line of source.split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const id = backend === 'codex' && entry.type === 'session_meta' ? entry.payload?.id
          : backend === 'omp' && entry.type === 'session' ? entry.id
            : backend === 'claude' ? entry.sessionId : undefined;
        if (id !== undefined) {
          if (id !== nativeId) return null;
          bound = true;
        }
      }
      if (!bound) return null;
      if (prefix) {
        const [dev, ino, length] = prefix.revision.split(':');
        const size = Number(length);
        if (prefix.mode !== 'native-resume' || prefix.ref !== nativeId ||
            dev !== String(before.dev) || ino !== String(before.ino) ||
            !/^\d+$/.test(length ?? '') || !Number.isSafeInteger(size) || size <= 0 ||
            size > bytes.length || sha256(bytes.subarray(0, size)) !== prefix.sha256) return null;
        return { ...prefix };
      }
      return { mode: 'native-resume', ref: nativeId, sha256: sha256(bytes),
        revision: `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}` };
    } finally { await fd.close(); }
  } catch { return null; }
}

/** Exact workspace + owner-scoped durable checkpoint, tied to this registration
 * by its write time. The general carry reader intentionally searches across
 * workspaces for recovery; takeover must use the stricter scope here. */
export async function readAssumeCheckpoint(target: Pick<ResumeTarget, 'ownerId' | 'workspaceId' | 'harnessSlug' | 'binding'>): Promise<AssumeContext | null> {
  if (!target.ownerId || !target.workspaceId || !target.harnessSlug || !target.binding) return null;
  const { sql } = getOrgPg();
  const scope = loopScope(target.harnessSlug, target.ownerId);
  const [row] = await sql<Array<{ note: string; revision: string }>>`
    SELECT note, body_ts::text AS revision FROM harness_shared.carry_notes
     WHERE workspace_id = ${target.workspaceId} AND scope = ${scope}
       AND note IS NOT NULL AND length(trim(note)) > 0
       AND body_ts >= extract(epoch FROM ${target.binding.startedAt}::timestamptz) * 1000
     LIMIT 1
  `;
  if (!row || !row.note.trim() || !row.revision) return null;
  return { mode: 'checkpoint', ref: `carry-note:${scope}`, sha256: sha256(row.note), revision: row.revision };
}

/** Read the exact pinned body only inside the authorized host commit path.
 * body_ts is the body revision; updated_ts also changes on attestations. */
export async function readAssumeCheckpointBody(plan: AssumePreparation): Promise<string> {
  const target = plan.target;
  const scope = loopScope(target.harnessSlug, target.ownerId);
  if (target.context.mode !== 'checkpoint' || target.context.ref !== `carry-note:${scope}`)
    throw new Error('assume-checkpoint-unavailable');
  const { sql } = getOrgPg();
  const [row] = await sql<Array<{ note: string }>>`
    SELECT note FROM harness_shared.carry_notes
     WHERE workspace_id = ${target.workspaceId} AND scope = ${scope}
       AND body_ts::text = ${target.context.revision}
       AND body_ts >= extract(epoch FROM ${target.binding.startedAt}::timestamptz) * 1000
     LIMIT 1
  `;
  if (!row?.note?.trim() || sha256(row.note) !== target.context.sha256)
    throw new Error('assume-checkpoint-changed');
  return row.note;
}

export async function readAssumeCaller(actor: AssumeActor): Promise<AssumeCaller | null> {
  const [target, host] = await Promise.all([
    resolveResumeTarget({ agentId: actor.ownerId }), findLiveHostAsync(actor.ownerId),
  ]);
  if (!target.ok || !host || target.ownerId !== actor.ownerId || target.workspaceId !== actor.workspaceId ||
      host.ownerId !== actor.ownerId || !host.ptyPid || !target.binding) return null;
  const backend = backendOf(target.agent);
  const nativeId = backend === 'omp' ? target.ompThreadId : target.sessionId;
  const capability = (host as typeof host & {
    identityAssume?: { version: number; hostId: string; attachmentId: string };
  }).identityAssume;
  if (!backend || !nativeId || !capability || capability.version !== 1 ||
      !capability.hostId || !capability.attachmentId ||
      (host.nativeSessionId && host.nativeSessionId !== nativeId)) return null;
  const nativeProcessStart = readProcessIdentity(host.ptyPid);
  return { ...actor, nativeSessionId: nativeId, incarnation: target.binding.startedAt,
    ...(nativeProcessStart ? { nativeProcessStart } : {}),
    backend, nativePid: host.ptyPid, hostId: capability.hostId, attachmentId: capability.attachmentId };
}

/** ResolveResumeTarget may follow a successor or accept a prefix for ordinary
 * resume. Takeover additionally requires equality with the canonical owner and
 * current full-precision binding, and probes the native writer independently. */
export async function readAssumeTarget(request: AssumeRequest, workspaceId: string,
  nativePrefix?: AssumeContext): Promise<AssumeTarget | null> {
  const target = await resolveResumeTarget({ agentId: request.targetOwnerId });
  if (!target.ok || target.ownerId !== request.targetOwnerId || target.workspaceId !== workspaceId ||
      !target.harnessSlug || !target.binding || !target.ownerId) return null;
  const backend = backendOf(target.agent);
  const nativeId = backend === 'omp' ? target.ompThreadId : target.sessionId;
  if (!backend || !nativeId || target.binding.coordOwnerId !== target.ownerId ||
      (backend === 'omp' ? target.binding.ompThreadId !== nativeId : target.binding.sessionId !== nativeId)) return null;
  const row = await getAdvSession(target.advSessionId);
  if (!row || row.workspaceId !== target.workspaceId || row.coordOwnerId !== target.ownerId) return null;
  const native = nativeSessionHandleForAdvSession(row);
  if (!native || native.backend !== backend) return null;
  const host = await findLiveHostAsync(target.ownerId);
  const process = sessionProcessHolder(nativeId);
  const lock = native.backend === 'codex' ? codexThreadWriterHolder(native.codexHome, nativeId) : null;
  const writer = process.held || lock?.held ? 'held' as const
    : process.reason === 'clean-scan' && (!lock || ['free', 'no-lock-file'].includes(lock.reason))
      ? 'free' as const : 'unknown' as const;
  // Do not read a live/unknown target's conversation as part of a refusal.
  if (!target.endedAt || target.live || host || writer !== 'free') {
    return { ownerId: target.ownerId, workspaceId: target.workspaceId, harnessSlug: target.harnessSlug,
      advSessionId: target.advSessionId, role: target.role ?? 'su', nativeSessionId: nativeId,
      executionNativeSessionId: nativeId, backend, binding: target.binding,
      writerGeneration: sha256(JSON.stringify([target.binding, writer, lock?.reason])), writer,
      ended: !!target.endedAt, liveHost: target.live || !!host,
      context: { mode: request.contextMode, ref: nativeId, sha256: '0'.repeat(64), revision: 'unavailable' } };
  }
  let context: AssumeContext | null;
  if (request.contextMode === 'checkpoint') {
    // The existing managed carry has no OMP consumer. Refuse before custody.
    if (backend === 'omp') return null;
    context = await readAssumeCheckpoint(target);
  }
  else {
    const root = native.backend === 'codex' ? join(native.codexHome, 'sessions')
      : native.backend === 'claude' && native.configDir ? join(native.configDir, 'projects')
        : native.backend === 'omp' && native.agentHome ? join(native.agentHome, 'sessions') : null;
    const file = native.backend === 'codex' ? await findCodexRolloutPathByUuid(nativeId, { homeOverride: native.codexHome })
      : native.backend === 'claude' ? await findSessionTranscript(nativeId, { owner: target.ownerId })
        : await findOmpSessionPath(nativeId, { sessionKey: target.advSessionId });
    context = root && file ? await readAssumeTranscriptPin(file, root, backend, nativeId, nativePrefix) : null;
  }
  if (!context) return null;
  const pause = await readAssumeCallerPause(target.ownerId);
  if (pause && (pause.workspaceId !== target.workspaceId || pause.nativeSessionId !== nativeId ||
      pause.incarnation !== target.binding.startedAt || request.contextMode !== 'native-resume')) return null;
  // A stable request-derived fresh id survives preview/commit re-resolution.
  // It is distinct from native-resume and cannot silently reopen old history.
  const digest = sha256(JSON.stringify([request.requestId, target.binding, context]));
  const freshId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return { ownerId: target.ownerId, workspaceId: target.workspaceId, harnessSlug: target.harnessSlug,
    advSessionId: target.advSessionId, role: target.role ?? 'su', nativeSessionId: nativeId,
    executionNativeSessionId: request.contextMode === 'native-resume' ? nativeId : backend === 'codex' ? null : freshId,
    backend, binding: target.binding,
    writerGeneration: sha256(JSON.stringify([target.binding, writer, lock?.reason])),
    writer, ended: true, liveHost: false, context,
    ...(pause ? { returnFrom: { transitionKey: pause.transitionKey,
      checkpointRef: pause.checkpointRef, checkpointSha256: pause.checkpointSha256 } } : {}) };
}
