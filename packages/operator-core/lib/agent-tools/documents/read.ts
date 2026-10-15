import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { ContentIntakeError } from '../../content-intake';
import { providedContentSchema, readProvidedContent } from './content';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import { ContentSummaryError, summaryOptionsSchema, summarizeContent } from '../../content-summary';

export default defineTool({
  name: 'documents:read',
  capability: 'search:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle'],
  description: 'Read original text or explicitly summarize already authorized text, selection, HTML or PDF. Summaries support length/audience/focus/format/language, model/account, bounded full-input processing and scoped caching. Reports source coverage. No new source access.',
  guidance: {
    when: 'You have authorized content and need a common readable representation before reading aloud or explicitly summarizing.',
    notWhen: 'You need to obtain private source content: use documents:search or the existing source reader first. A provenance ref does not fetch or grant access.',
    chaining: 'Native-agent summaries remain direct when the complete source already fits your context. Use operation:summarize for large/repeated jobs. Check coverage before claiming a whole document; partial search extracts remain partial. For background execution reuse managed capability:bash with ptool documents:read --json-file. Cancellation and time/model-call budgets apply. To speak an explicit summary, send only the returned summary to voice:say operation:read with separate speech cloud consent.',
  },
  args: z.object({
    content: providedContentSchema,
    operation: z.enum(['read', 'summarize']).optional(),
    summary: summaryOptionsSchema.optional(),
    maxChars: z.number().int().min(1).max(50_000).optional().describe('Returned text limit (default 4000). Longer sources explicitly report partial coverage; speech consumes the shared intake internally without this tool-response limit.'),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    try {
      if (args.operation === 'summarize') {
        const source = await readProvidedContent(args.content, ctx);
        return { data: { ok: true, ...await summarizeContent(source, args.summary, ctx.signal) } };
      }
      return { data: { ok: true, ...await readProvidedContent(args.content, ctx, args.maxChars ?? 4000) } };
    }
    catch (error) {
      if (!(error instanceof ContentIntakeError) && !(error instanceof ContentSummaryError)) throw error;
      return { data: { ok: false, error: error.code, message: error.message,
        ...(error instanceof ContentSummaryError && error.diagnostics ? { diagnostics: error.diagnostics } : {}) } };
    }
  },
  timeoutSec: 190,
  effect: 'write', // explicit summaries incur metered model calls
  effectForCall: args => args.operation === 'summarize' ? 'write' : 'read',
});
