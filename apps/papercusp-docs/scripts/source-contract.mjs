import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import { frontmatterDocuments, parseDocumentsField } from '../../../packages/operator-core/lib/harness/docs/subject-ref.ts';

export const PUBLIC_MANUAL_GUIDES = [
  'index', 'quickstart', 'using-the-app', 'accounts-and-billing',
  'workspaces-and-agents', 'plans-and-work', 'agent-modes-and-fleets', 'voice',
  'cloud-workspaces', 'harness-templates', 'harness-snapshots', 'plugins',
  'remote-access', 'faq', 'troubleshooting',
];

// Published question anchors are a compatibility contract. Copy edits must keep
// these destinations working for bookmarks and Papercup's public citations.
export const PUBLIC_FAQ_ANCHORS = [
  'what-is-papercusp', 'what-is-papercup', 'what-is-a-workspace',
  'do-i-need-the-desktop-app', 'does-closing-the-browser-stop-my-agents',
  'which-cloud-option-should-i-choose', 'is-my-workspace-ready-when-its-card-appears',
  'do-i-create-an-account-every-time', 'why-can-i-not-see-my-organizations-workspace',
  'what-can-i-be-charged-for', 'does-returning-from-checkout-mean-payment-is-confirmed',
  'does-stopping-a-workspace-make-it-free', 'what-should-i-check-before-deleting-a-workspace',
  'who-can-access-my-data', 'where-should-i-enter-credentials',
  'what-does-auto-let-an-agent-do', 'how-do-i-know-a-task-is-finished',
  'what-if-an-agent-makes-a-mistake-or-gets-stuck', 'is-my-conversation-a-backup',
  'how-do-i-get-help-safely',
];

/**
 * Check the public FAQ structure using Astro's existing heading slugger.
 * Source truth and sensitive-answer approval remain separate review evidence.
 * @param {string} contentRoot
 */
export function assertPublicManualFaq(contentRoot) {
  const text = readFileSync(resolve(contentRoot, 'faq.mdx'), 'utf8');
  const headings = [...text.matchAll(/^## (.+)$/gm)];
  const slugger = new GithubSlugger();
  const anchors = new Set();
  const errors = [];
  const entries = headings.map((heading, i) => {
    const question = heading[1];
    const anchor = slugger.slug(question);
    const originalAnchor = new GithubSlugger().slug(question);
    if (anchors.has(originalAnchor)) errors.push(`duplicate FAQ anchor: ${originalAnchor}`);
    anchors.add(anchor);
    const body = text.slice((heading.index ?? 0) + heading[0].length, headings[i + 1]?.index ?? text.length);
    const aliasesLine = body.match(/^Also asked as:\s*(.+)$/m)?.[1] ?? '';
    const aliases = aliasesLine.match(/[^?]+\?/g)?.map((alias) => alias.trim()) ?? [];
    if (new Set(aliases).size < 2) errors.push(`FAQ needs two alternate phrasings: ${anchor}`);
    const answer = body.replace(/^Also asked as:.*$/m, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    if (answer.trim().split(/\s+/).length < 15) errors.push(`FAQ needs a short answer: ${anchor}`);
    const guideLinks = [...body.matchAll(/\]\((\/docs\/[^)\s]*)\)/g)].map((link) => link[1]);
    if (!guideLinks.length) errors.push(`FAQ needs a fuller-guide link: ${anchor}`);
    if (/\]\(\/internal\/docs/.test(body)) errors.push(`private-doc link in FAQ: ${anchor}`);
    for (const link of guideLinks) {
      const [pathname, fragment] = link.split('#');
      const slug = pathname.slice('/docs/'.length).split('?')[0].replace(/\/$/, '') || 'index';
      const file = resolve(contentRoot, `${slug}.mdx`);
      if (slug === 'faq' || !file.startsWith(resolve(contentRoot) + sep) || !existsSync(file)) {
        errors.push(`broken FAQ fuller-guide link: ${anchor}: ${link}`);
      } else if (fragment) {
        const guideSlugger = new GithubSlugger();
        const guideAnchors = [...readFileSync(file, 'utf8').matchAll(/^#{1,6} (.+)$/gm)]
          .map((match) => guideSlugger.slug(match[1]));
        if (!guideAnchors.includes(fragment)) errors.push(`broken FAQ guide anchor: ${anchor}: ${link}`);
      }
    }
    return { question, anchor, aliases, guideLinks };
  });
  if (entries.length < 20) errors.push('FAQ needs at least 20 questions');
  for (const anchor of PUBLIC_FAQ_ANCHORS) {
    if (!anchors.has(anchor)) errors.push(`missing stable FAQ anchor: ${anchor}`);
  }
  if (errors.length) throw new Error(`public_manual_faq_contract:\n${errors.join('\n')}`);
  return { questions: entries.length, entries };
}

/**
 * Build-time documentation-impact guard, shared with the maintained test suite.
 * Reuse the same documents: parser as the post-sync drift/steward pipeline.
 * This verifies coverage/anchors/links, not the semantic truth of prose: the
 * existing baseline and review mechanism owns that separate responsibility.
 */
export function assertPublicManualSource(docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const repo = resolve(docsRoot, '../..');
  const content = resolve(docsRoot, 'src/content/docs');
  const config = readFileSync(resolve(docsRoot, 'astro.config.mjs'), 'utf8');
  const files = readdirSync(content).filter((name) => name.endsWith('.mdx'));
  const errors = [];
  for (const slug of PUBLIC_MANUAL_GUIDES) {
    if (!files.includes(`${slug}.mdx`)) errors.push(`missing guide: ${slug}`);
    if (slug !== 'index' && !config.includes(`'${slug}'`)) errors.push(`missing sidebar guide: ${slug}`);
  }
  for (const file of files) {
    const text = readFileSync(resolve(content, file), 'utf8');
    const refs = parseDocumentsField(frontmatterDocuments(text));
    if (!refs.length) errors.push(`untracked guide: ${file}`);
    for (const ref of refs) {
      if (ref.kind !== 'path') { errors.push(`guide needs concrete source paths: ${file}`); continue; }
      for (const path of ref.globs) {
        const abs = resolve(repo, path);
        if (!abs.startsWith(repo + sep) || !existsSync(abs) ||
            !realpathSync(abs).startsWith(realpathSync(repo) + sep)) {
          errors.push(`dead or escaping source anchor: ${file}: ${path}`);
        }
      }
    }
    if (/\]\(\/internal\/docs/.test(text)) errors.push(`private-doc link: ${file}`);
    for (const match of text.matchAll(/\]\(\/docs\/([^)#?]*)/g)) {
      const slug = match[1].replace(/\/$/, '') || 'index';
      if (!files.includes(`${slug}.mdx`)) errors.push(`broken guide link: ${file}: ${slug}`);
    }
  }
  if (errors.length) throw new Error(`public_manual_source_contract:\n${errors.join('\n')}`);
  assertPublicManualFaq(content);
  return { guides: files.length, sourceRoot: content };
}
