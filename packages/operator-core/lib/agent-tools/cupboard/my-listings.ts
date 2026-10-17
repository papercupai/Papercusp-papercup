import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'cupboard:my-listings',
  capability: 'harness:read',
  crossWorkspace: true,
  description: 'List your Cupboard submissions, including pending review, approved, rejected, delisted listings and creator drafts. Authenticates with the operator’s GitHub identity. Follow nextCursor for more pages.',
  guidance: {
    when: 'Checking what you published, its moderation state or rejection reason, or finding your own listing to delist.',
    notWhen: 'Searching the public catalog for someone else’s packages; use cupboard:search.',
    chaining: 'Read submissions → inspect review_status/review_reason → use cupboard:unpublish with a listing id to delist.',
    seeAlso: ['cupboard:search', 'cupboard:unpublish'],
  },
  args: z.object({ limit: z.number().int().min(1).max(200).optional(), cursor: z.string().regex(/^\d+$/).max(20).optional() }).strict(),
  async handler(args) {
    const { readMyCupboardListings } = await import('../../cupboard/my-listings');
    return { data: await readMyCupboardListings(args) };
  },
});
