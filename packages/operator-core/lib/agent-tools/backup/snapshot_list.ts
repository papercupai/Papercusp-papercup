import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readHostDumpInProgress, workspaceBackupFor } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'backup:snapshot_list',
  profile: 'engineer',
  description: 'List recent kopia snapshots, backup sessions holding granted relation locks, and the active host dump phase.',
  capability: 'backup:read',
  guidance: {
    when: `List backup snapshots — point-in-time captures of the workspace's PG + filesystem state.`,
    notWhen: `For publishable per-harness artifacts — this surface lists only full-workspace recovery snapshots, so use the artifact/catalog surface that owns the harness payload instead.`,
    seeAlso: [
      'backup:snapshot_create (create a new snapshot)',
      'backup:restore (apply a snapshot from the list)',
    ],
    chaining: "snapshots[] covers only THIS workspace's kopia-hook receipts in harness_shared.backup_snapshots. liveBackupSessions[] reports host or workspace backup sessions holding a granted relation AccessShareLock. hostDumpInProgress reports the host-side producer marker, including its phase and pid. An empty session list is not an all-clear when hostDumpInProgress is present.",
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    limit: z.number().int().min(1).max(500).default(50),
  }),
  async handler(args) {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const [snapshots, liveBackupSessions, hostDumpInProgress] = await Promise.all([
      wb.list(args.limit),
      wb.liveBackupSessions(),
      readHostDumpInProgress(),
    ]);
    return { data: { snapshots, liveBackupSessions, hostDumpInProgress } };
  },
});
