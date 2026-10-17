import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../../cupboard/publish-plugin-core', () => ({ publishInstalledUnitToCupboard: h.publish }));
vi.mock('../../cupboard/publish-template-core', () => ({ publishTemplateToCupboard: h.publish }));
vi.mock('../../cupboard/publish-rubric-core', () => ({ publishRubricToCupboard: h.publish }));
vi.mock('../../cupboard/publish-plan-core', () => ({ publishPlanToCupboard: h.publish }));
vi.mock('../../cupboard/publish-recipe-core', () => ({ publishRecipeToCupboard: h.publish }));
vi.mock('../../cupboard/publish-goal-core', () => ({ publishGoalToCupboard: h.publish }));
vi.mock('../../cupboard/publish-rule-core', () => ({ publishRuleToCupboard: h.publish }));
vi.mock('../../cupboard/publish-theme-core', () => ({ publishThemeToCupboard: h.publish }));
vi.mock('../../cupboard/publish-event-core', () => ({ publishEventToCupboard: h.publish }));
vi.mock('../../cupboard/publish-datatype-core', () => ({ publishDatatypeToCupboard: h.publish }));
vi.mock('../../cupboard/publish-listing', () => ({ publishListingToCupboard: h.publish }));
vi.mock('../../cupboard/validate-app-manifest', () => ({
  assertAppManifestResolves: async () => ({ version: '1.0.0', platforms: ['linux-x86_64'] }),
  AppManifestError: class extends Error {},
}));
vi.mock('../../cupboard/resolve-repo-coords', () => ({
  resolveRepoCoordsFromDir: async () => ({ github_owner: 'publisher', github_name: 'project',
    github_repository_id: 42, github_url: 'https://github.com/publisher/project' }),
  gitOriginUrl: vi.fn(), fetchGithubRepoMeta: vi.fn(),
}));
vi.mock('../knowledge_packs/_shared', async importOriginal => ({
  ...await importOriginal<typeof import('../knowledge_packs/_shared')>(), knowledgePacksEnabled: async () => true,
}));

import app from './publish-app';
import plugin from './publish-plugin';
import template from './publish-template';
import rubric from './publish-rubric';
import plan from './publish-plan';
import recipe from './publish-recipe';
import goal from './publish-goal';
import rule from './publish-rule';
import theme from './publish-theme';
import event from './publish-event';
import datatype from './publish-datatype';
import { publishTool as knowledgePack } from '../knowledge_packs/publish';

const publishers = [app, plugin, template, rubric, plan, recipe, goal, rule, theme, event, datatype, knowledgePack];
const args = { appId: 'item', ref: 'item', slug: 'item', id: 'item', goalId: 'item', themeId: 'item',
  eventKey: 'item', datatypeId: 'item', packId: 'item', unitId: 'item', kind: 'plugin',
  githubUrl: 'https://github.com/publisher/project', repoDir: '/fixture/project',
  latestJsonUrl: 'https://example.test/latest.json', title: 'Item', description: 'Description' };
const context = { principal: { workspaceId: 'receipt-test' } };
function payload(result: unknown): Record<string, unknown> {
  const envelope = result as { data?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> };
  return envelope.data ?? JSON.parse(envelope.content?.find(part => part.type === 'text')?.text ?? '{}');
}
async function publish(tool: typeof publishers[number]) {
  return payload(await tool.handler(args as never, context as never));
}
beforeEach(() => h.publish.mockReset());

describe('production publication receipts', () => {
  it('covers the full Cupboard publish-tool population; blueprint has its existing dedicated behavioral suite', () => {
    const discovered = readdirSync(new URL('.', import.meta.url))
      .filter(file => /^publish-.*\.ts$/.test(file) && !file.endsWith('.test.ts'))
      .flatMap(file => [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/name: '(cupboard:publish-[^']+)'/g)]
        .map(match => match[1])).sort();
    // Commerce products/offers do not create moderated Cupboard listings.
    // Keep that explicit exception in the census so a new listing publisher fails it.
    expect(discovered).toEqual([...publishers.filter(tool => tool !== knowledgePack).map(tool => tool.name),
      'cupboard:publish-offer'].sort());
  });
  for (const tool of publishers) {
    describe(tool.name, () => {
      it.each(['pending', 'approved', 'rejected'])('keeps the actual %s review state and both tracking actions', async review_status => {
        const listing = { id: 'published-item', review_status };
        h.publish.mockResolvedValue({ ok: true, listing, data: listing,
          export: { ref: 'item', dir: '/fixture/export', written: { ref: 'item', dir: '/fixture/export' } } });
        const result = await publish(tool);
        expect(h.publish).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ ok: true, listingId: 'published-item', review_status,
          mySubmissionsPath: '/cupboard?kind=my-submissions', mySubmissionsTool: 'cupboard:my-listings' });
        expect(result.hint).toContain(review_status === 'pending' ? 'pending review' : review_status);
      });
      it('does not claim a submission when its publisher refuses', async () => {
        h.publish.mockResolvedValue({ ok: false, error: 'forbidden', status: 403 });
        const result = await publish(tool);
        expect(result).toMatchObject({ ok: false, error: 'forbidden' });
        expect(result).not.toHaveProperty('mySubmissionsPath');
        expect(result).not.toHaveProperty('mySubmissionsTool');
      });
    });
  }
  it.each([plan, recipe, goal, rule, theme, event, datatype])('$name does not claim a submission for export-only', async tool => {
    h.publish.mockResolvedValue({ ok: true, exportedOnly: true,
      export: { ref: 'item', dir: '/fixture/export', written: { ref: 'item', dir: '/fixture/export' } } });
    const result = payload(await tool.handler({ ...args, exportOnly: true } as never, context as never));
    expect(result).toMatchObject({ ok: true, exportedOnly: true });
    expect(result).not.toHaveProperty('mySubmissionsPath');
    expect(result).not.toHaveProperty('mySubmissionsTool');
  });
});
