/** A Claude fork gets native history, never its parent's live runtime duties. */
import { constants } from 'node:fs';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getAdvSessionInWorkspace } from './adv-sessions';
import { findSessionTranscript } from './claude-sessions';
import { neutralizeForkSeedToolReferences } from './claude-resume-tool-references.mjs';
import type { ClaudeNativeSessionHandle } from './native-session-handles';

export interface TrackedClaudeForkSource {
  advSessionId: number;
  nativeSession: ClaudeNativeSessionHandle;
}

export async function prepareTrackedClaudeFork(input: {
  source: TrackedClaudeForkSource;
  workspaceId: string;
  cwd: string;
  childAdvSessionId: number;
  childOwnerId: string;
  childNativeSessionId: string;
  childConfigDir: string;
}): Promise<{ transcriptPath: string; register(): Promise<void>; cleanup(): Promise<void> }> {
  const { source } = input, handle = source.nativeSession;
  const parent = await getAdvSessionInWorkspace(source.advSessionId, input.workspaceId);
  if (!parent || parent.agent !== 'claude' || parent.retiredAt || !parent.cwd
    || resolve(parent.cwd) !== resolve(input.cwd) || !handle.ownerId || !handle.sessionId || !handle.configDir
    || !handle.exactResumeSupported || handle.missingReason
    || parent.coordOwnerId !== handle.ownerId || parent.sessionId !== handle.sessionId
    || Number(parent.id) === input.childAdvSessionId || handle.ownerId === input.childOwnerId
    || handle.sessionId === input.childNativeSessionId || resolve(handle.configDir) === resolve(input.childConfigDir)) {
    throw new Error('Tracked Claude fork source does not match its recorded workspace, identity and project');
  }
  const sourceRoot = join(handle.configDir, 'projects');
  const transcript = await findSessionTranscript(handle.sessionId, { owner: handle.ownerId, roots: [sourceRoot] });
  if (!transcript) throw new Error('Tracked Claude fork source transcript is unavailable');
  const path = relative(sourceRoot, transcript);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('Claude fork transcript is outside its recorded configuration');
  }
  const seed = join(input.childConfigDir, 'projects', path);
  await mkdir(dirname(seed), { recursive: true });
  await copyFile(transcript, seed, constants.COPYFILE_EXCL);
  try { neutralizeForkSeedToolReferences(join(input.childConfigDir, 'projects'), handle.sessionId); }
  catch (error) { await unlink(seed); throw error; }
  let registered = false;
  return {
    transcriptPath: seed,
    async register() {
      const { sql } = getOrgPg();
      const lineage = { advSessionId: source.advSessionId, nativeSessionId: handle.sessionId, ownerId: handle.ownerId };
      const rows = await sql`
        UPDATE harness_shared.adv_sessions child
           SET launch_spec = jsonb_set(child.launch_spec, '{nativeFork}', ${JSON.stringify(lineage)}::text::jsonb)
          FROM harness_shared.adv_sessions parent
         WHERE child.id = ${input.childAdvSessionId} AND child.workspace_id = ${input.workspaceId}
           AND child.coord_owner_id = ${input.childOwnerId} AND child.agent = 'claude'
           AND child.session_id = ${input.childNativeSessionId} AND child.ended_at IS NULL AND child.retired_at IS NULL
           AND jsonb_typeof(child.launch_spec) = 'object' AND NOT (child.launch_spec ? 'nativeFork')
           AND parent.id = ${parent.id} AND parent.workspace_id = child.workspace_id
           AND parent.coord_owner_id = ${handle.ownerId} AND parent.agent = 'claude'
           AND parent.session_id = ${handle.sessionId} AND parent.retired_at IS NULL
         RETURNING child.id`;
      if (rows.length !== 1) throw new Error('Tracked Claude fork identity and lineage registration refused');
      registered = true;
    },
    async cleanup() {
      if (registered) return;
      await unlink(seed);
      const childTranscript = await findSessionTranscript(input.childNativeSessionId, {
        owner: input.childOwnerId, roots: [join(input.childConfigDir, 'projects')],
      });
      if (childTranscript) await unlink(childTranscript);
    },
  };
}
