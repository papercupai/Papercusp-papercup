/** Resolver door for the caller-harness checkpoint cell. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readHarnessCheckpointState } from '../../release/harness-checkpoint-state';

export default defineTool({
  name: 'checkpoint:state_snapshot',
  description: 'Resolver for gate.harnessCheckpoint: recorded checkpoint authority for the authenticated caller harness.',
  guidance: {
    when: 'As the resolver for state:read { cell:"gate.harnessCheckpoint" }.',
    notWhen: 'To inspect another harness or treat a stored runner as proof of liveness.',
    chaining: 'Read scoped ownership before a live gate action; verify the exact recorded runner before recovery.',
  },
  // @cell-lens gate.harnessCheckpoint
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({}),
  async handler(_args, ctx) {
    return { data: { checkpoint: await readHarnessCheckpointState(ctx) } };
  },
});
