/**
 * operator:preview_prompt — build a scanner or converse prompt
 * for a given request without actually running it. Useful for debug
 * + plugin-author validation of how their card affects prompt
 * assembly.
 *
 * `userId` defaults to a debug placeholder so callers don't need a
 * real session. `showFirstRun: true` forces the first-run intro
 * regardless of marker state.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { buildOperatorPrompt } from '../../operator-prompt';
import { PROMPT_ROLES } from '../../prompt-assembly';

export default defineTool({
  name: 'operator:preview_prompt',
  profile: 'engineer',
  description: 'Build a scanner or converse prompt without running a model. Converse previews use the actual chat prompt builder with explicit role, trust and tool-catalog inputs.',
  capability: 'operator:read',
  guidance: {
    when: `Render the operator's assembled prompt for a given trigger — debug tool to verify what the model sees.`,
    notWhen: `Production code shouldn't depend on this; it's diagnostic only.`,
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    request: z.string(),
    userId: z.string().optional(),
    showFirstRun: z.boolean().optional(),
    brain: z.enum(['scanner', 'converse']).optional(),
    role: z.enum(PROMPT_ROLES).optional(),
    hostTrust: z.enum(['owner', 'public']).optional(),
    audienceMode: z.enum(['engineer', 'novice']).optional(),
    modality: z.enum(['text', 'voice']).optional(),
    toolNames: z.array(z.string()).optional().describe('Exact tool catalog to render, supplied by the diagnostic caller. Omitted means no tools; this preview does not resolve a principal or mount MCP tools.'),
  }),
  async handler(args) {
    if (args.brain === 'converse') {
      // Lazy-load the chat brain so the legacy scanner route stays unchanged.
      // Public + no user + no tools is the safe diagnostic default: never
      // inherit the owner's catalog or recall another user's private memory.
      const { buildOperatorPrompt: buildConversePrompt } = await import('./converse-prompt');
      const { readServingGeneration } = await import('../../serving-generation');
      const role = args.role ?? 'papercup';
      const hostTrust = args.hostTrust ?? 'public';
      const toolNames = args.toolNames ?? [];
      const result = await buildConversePrompt({
        messages: [{ role: 'user', content: args.request }],
        trigger: 'user_message',
        role,
        hostTrust,
        audienceMode: args.audienceMode ?? 'novice',
        modality: args.modality ?? 'text',
        toolNames,
      }, null);
      return { data: {
        ...result,
        provenance: {
          builder: 'operator/converse-prompt',
          role,
          hostTrust,
          toolNames,
          toolSelection: args.toolNames === undefined ? 'empty-default' : 'caller-supplied',
          servingGeneration: await readServingGeneration(),
        },
      } };
    }
    const result = await buildOperatorPrompt({
      request: args.request,
      userId: args.userId ?? 'debug-preview',
      showFirstRun: args.showFirstRun,
    });
    return { data: result };
  },
});
