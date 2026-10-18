/** P-008: compose the registered roster guidance and maintained document with their real search engines. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { searchDocs, starlightContentAdapter } from '@papercusp/docs-engine';
import { findTools } from '../../cupboard/tool-find';
import { buildCorpus } from '../tools/find';
import './tools/roster';

// This check measures deterministic lexical integration. The separate live
// e2e receipt measures both authenticated production discovery surfaces.
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: vi.fn().mockResolvedValue(null),
  interactiveEmbedAcquireBudgetMs: () => 4000,
}));

describe('parked audit discovery integration', () => {
  it('routes the registered roster guidance and maintained how-to through the real lexical search engines', async () => {
    const query = 'parked agent audit';
    const registry = buildCorpus();
    const roster = registry.corpus.find(row => row.tool === 'coord:roster');
    expect(roster, 'the production roster must be registered').toBeTruthy();
    expect(roster?.description).toContain('view=audit');
    expect(roster?.argSchema).toContain('auditDirectiveId');
    const tools = await findTools(registry.corpus, query, { limit: 3 });
    expect(tools.map(row => row.tool)).toContain('coord:roster');

    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const source = starlightContentAdapter({ contentRoot: resolve(root, 'apps/operator-docs/src/content/docs'), name: 'parked-audit-docs' });
    const docs = await searchDocs(source, { query, limit: 3 });
    const howTo = docs.hits.find(row => row.slug === 'agent-insights/parked-agent-audit-roster-view');
    expect(howTo, 'the actual maintained how-to must rank in the top three').toBeTruthy();
    expect(howTo?.title).toContain('coord:roster');
  }, 90_000);
});
