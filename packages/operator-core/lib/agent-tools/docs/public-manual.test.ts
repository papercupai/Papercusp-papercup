import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicManualSource, getPublicManual, searchPublicManual, resolvePublicManualRoot } from './_public-manual';

describe('canonical public manual retrieval', () => {
  let root: string;
  const faq = '---\ntitle: Common questions\n---\n## Does closing the browser stop my agents?\n\nAlso asked as: Can work continue after I close the tab? Do I need to keep the browser open?\n\nRemote work can continue; the host must stay connected. Read [Cloud workspaces](/docs/cloud-workspaces).\n';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'public-manual-'));
    await writeFile(join(root, 'faq.mdx'), faq);
    await writeFile(join(root, 'cloud-workspaces.mdx'), '---\ntitle: Cloud workspaces\n---\nA host is the computer running your work.');
    await mkdir(join(root, 'private'));
    await writeFile(join(root, 'private', 'secret.mdx'), '---\ntitle: Private secret\n---\nPRIVATE_CANARY remote browser credentials');
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it('retrieves canonical answers and both paraphrases with embeddings unavailable', async () => {
    const source = createPublicManualSource(root);
    for (const query of ['closing the browser', 'Can work continue after I close the tab?', 'Do I need to keep the browser open?']) {
      const result = await searchPublicManual({ query }, source);
      expect(result).toMatchObject({ surface: 'public', legs: { lexical: { status: 'ran' }, semantic: { status: 'not-run' } } });
      expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'faq', url: '/docs/faq#does-closing-the-browser-stop-my-agents' })]));
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    }
    const result = await getPublicManual({ slugs: ['faq'], heading: 'Does closing the browser stop my agents?' }, source);
    expect(JSON.stringify(result)).toContain('Remote work can continue');
  });

  it('pairs a public positive control with private paths, namespaces and traversal negatives', async () => {
    vi.stubEnv('PAPERCUSP_PROJECT_DOCS_ROOT', join(root, 'private'));
    const source = createPublicManualSource(root);
    expect(await source.getPage('faq')).not.toBeNull();
    for (const slug of ['private/secret', '../private/secret', '/internal/docs/secret', '%2e%2e/secret']) {
      expect(await source.getPage(slug)).toBeNull();
      expect(JSON.stringify(await getPublicManual({ slugs: [slug] }, source))).not.toContain('PRIVATE_CANARY');
    }
    expect(await getPublicManual({ slugs: ['faq'], source: true }, source)).toMatchObject({ error: 'public_source_read_forbidden' });
  });

  it('expands a public manual document path into each declared source anchor', async () => {
    const source = createPublicManualSource(resolve(import.meta.dirname, '../../../../../apps/papercusp-docs/src/content/docs'));
    const expansion = await source.expandSubjectRefs(['apps/papercusp-docs/src/content/docs/faq.mdx']);
    expect(expansion).toEqual({
      refs: [
        'packages/operator-core/lib/auth/hosted/self-signup.ts',
        'packages/operator-core/lib/auth/hosted/billing/entitlement-seam.ts',
        'packages/operator-core/lib/agent-tools/mode/set.ts',
        'packages/operator-core/lib/workspace-host/hosted-provider-delegation.ts',
        'packages/operator-core/lib/agent-tools/access/create.ts',
        'packages/operator-core/lib/agent-tools/backup/snapshot_create.ts',
        'packages/operator-core/lib/agent-tools/backup/restore.ts',
      ],
      unresolvedDocuments: [],
    });
  });

  it('marks a public document without usable source anchors as incomplete', async () => {
    const source = createPublicManualSource(root);
    const expansion = await source.expandSubjectRefs(['faq.mdx', 'src/direct.ts']);
    expect(expansion).toEqual({ refs: ['src/direct.ts'], unresolvedDocuments: ['faq.mdx'] });
  });

  it('invalidates rendered answers and search metadata when canonical bytes change', async () => {
    const source = createPublicManualSource(root);
    const before = await getPublicManual({ slugs: ['faq'] }, source);
    await writeFile(join(root, 'faq.mdx'), faq.replace('Remote work can continue', 'Updated answer: remote work continues'));
    const after = await getPublicManual({ slugs: ['faq'] }, source);
    expect('revision' in before).toBe(true);
    expect('revision' in after).toBe(true);
    if (!('revision' in before) || !('revision' in after)) throw new Error('public read failed');
    expect(after.revision).not.toBe(before.revision);
    expect(JSON.stringify(after)).toContain('Updated answer');
    expect(JSON.stringify(await searchPublicManual({ query: 'Updated answer' }, source))).toContain('Updated answer');
  });

  it('reports missing source and removed FAQ as recoverable outages without private fallback', async () => {
    const source = createPublicManualSource(root);
    await source.getPage('faq');
    await rm(join(root, 'faq.mdx'));
    expect(await searchPublicManual({ query: 'browser' }, source)).toMatchObject({ error: 'public_docs_unavailable', hits: [], fallbackUrl: '/docs/faq' });
    expect(await getPublicManual({ slugs: ['faq'] }, source)).toMatchObject({ error: 'public_docs_unavailable', recoverable: true });
  });

  it('does not follow a private symlink into the public corpus', async () => {
    await symlink(join(root, 'private', 'secret.mdx'), join(root, 'secret.mdx'));
    const source = createPublicManualSource(root);
    expect(await source.getPage('secret')).toBeNull();
    expect(JSON.stringify(await searchPublicManual({ query: 'credentials' }, source))).not.toContain('PRIVATE_CANARY');
  });

  it('a fresh source retrieves the maintained FAQ shipped in the repository', async () => {
    const source = createPublicManualSource(resolve(import.meta.dirname, '../../../../../apps/papercusp-docs/src/content/docs'));
    const result = await searchPublicManual({ query: 'Does stopping a workspace make it free?' }, source);
    expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'faq' })]));
    expect(JSON.stringify(await getPublicManual({ slugs: ['faq'], heading: 'Does stopping a workspace make it free?' }, source))).toContain('charge');
  });

  it('ranks the relevant FAQ question in the top three against the full maintained corpus', async () => {
    const source = createPublicManualSource(resolve(import.meta.dirname, '../../../../../apps/papercusp-docs/src/content/docs'));
    for (const query of ['closing the browser', 'Can work continue after I close the tab?', 'Do I need to keep the browser open?', 'Can I close this tab?', 'Will remote work stop when I disconnect?', 'browesr']) {
      const result = await searchPublicManual({ query, limit: 3 }, source);
      expect(result.hits, query).toEqual(expect.arrayContaining([expect.objectContaining({
        slug: 'faq',
        title: 'Does closing the browser stop my agents?',
        url: '/docs/faq#does-closing-the-browser-stop-my-agents',
      })]));
    }
    expect(await searchPublicManual({ query: 'quantumxyz', limit: 3 }, source)).toMatchObject({ hits: [], hitCount: 0 });
  });

  it('retrieves all twenty canonical FAQ questions and their two published paraphrases', async () => {
    const contentRoot = resolve(import.meta.dirname, '../../../../../apps/papercusp-docs/src/content/docs');
    const source = createPublicManualSource(contentRoot);
    const questions = [...(await readFile(join(contentRoot, 'faq.mdx'), 'utf8')).matchAll(/^## (.+)\n\nAlso asked as: (.+)$/gm)];
    expect(questions).toHaveLength(20);
    for (const [, title, alternateQuestions] of questions) {
      const paraphrases = alternateQuestions.match(/[^?]+\?/g) ?? [];
      expect(paraphrases, title).toHaveLength(2);
      for (const query of [title, ...paraphrases]) {
        const result = await searchPublicManual({ query: query.trim(), limit: 3 }, source);
        expect(result.hits, query).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'faq', title })]));
      }
    }
  });

  it('retrieves ordinary misspellings without inventing a match for an unrelated query', async () => {
    const source = createPublicManualSource(root);
    for (const query of ['browesr', 'broswer', 'browsr']) {
      const result = await searchPublicManual({ query }, source);
      expect(result).toMatchObject({ query, correctedQuery: 'browser' });
      expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'faq' })]));
    }
    expect(await searchPublicManual({ query: 'quantumxyz' }, source)).toMatchObject({ hits: [], hitCount: 0 });
  });

  it('resolves and reads a standalone bundle without a monorepo source tree', async () => {
    const installed = join(root, 'installed');
    const bundle = join(installed, 'public/manual-source');
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, 'faq.mdx'), faq);
    const cwd = join(installed, 'server');
    await mkdir(cwd);
    expect(resolvePublicManualRoot(cwd, installed)).toBe(bundle);
    const source = createPublicManualSource(resolvePublicManualRoot(cwd, installed));
    expect(JSON.stringify(await getPublicManual({ slugs: ['faq'] }, source))).toContain('Remote work can continue');
    expect((await searchPublicManual({ query: 'browser' }, source)).hits.length).toBeGreaterThan(0);
  });
});
