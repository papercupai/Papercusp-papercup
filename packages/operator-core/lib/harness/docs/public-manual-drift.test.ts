import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frontmatterDocuments, parseDocumentsField, type GitRunner } from './subject-ref';
import { checkDocDrift } from './drift';
import { classifyDrift } from './freshness-sweep';

describe('public manual reuses the ordinary manual-doc drift contract', () => {
  it.each([
    'packages/operator-core/lib/auth/hosted/self-signup.ts',
    'packages/operator-core/lib/auth/hosted/billing/entitlement-seam.ts',
    'packages/operator-core/lib/agent-tools/mode/set.ts',
    'packages/operator-core/lib/workspace-host/hosted-provider-delegation.ts',
    'packages/operator-core/lib/agent-tools/access/create.ts',
    'packages/operator-core/lib/agent-tools/backup/snapshot_create.ts',
    'packages/operator-core/lib/agent-tools/backup/restore.ts',
  ])('the canonical FAQ requests sensitive review when %s changes', async (changed) => {
    const root = resolve(import.meta.dirname, '../../../../../');
    const faq = readFileSync(resolve(root, 'apps/papercusp-docs/src/content/docs/faq.mdx'), 'utf8');
    const subjects = parseDocumentsField(frontmatterDocuments(faq));
    const paths = subjects.flatMap((subject) => subject.kind === 'path' ? subject.globs : []);
    expect(paths).toContain(changed);
    const runGit: GitRunner = async (args) => ({
      code: 0, stdout: args.includes(changed) ? `abcdefabcdefabcdefabcdefabcdefabcdefabcd\n${changed}\n` : '', stderr: '',
    });
    const drift = await checkDocDrift(subjects, '1234567', { repoRoot: root, runGit });
    expect(drift.changedPaths).toContain(changed);
    expect(classifyDrift({ source: 'manual', subjectRef: subjects }, drift)).toMatchObject({ status: 'review' });
    const unchanged = await checkDocDrift(subjects, '1234567', {
      repoRoot: root, runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(classifyDrift({ source: 'manual', subjectRef: subjects }, unchanged)).toMatchObject({ status: 'fresh' });
  });

  it('a change to the real quickstart signup anchor requests review, not regeneration or silent freshness', async () => {
    const root = resolve(import.meta.dirname, '../../../../../');
    const page = readFileSync(resolve(root, 'apps/papercusp-docs/src/content/docs/quickstart.mdx'), 'utf8');
    const subjects = parseDocumentsField(frontmatterDocuments(page));
    const changed = 'packages/operator-core/lib/auth/hosted/self-signup.ts';
    const runGit: GitRunner = async (args) => ({
      code: 0, stdout: args.includes(changed) ? `abcdefabcdefabcdefabcdefabcdefabcdefabcd\n${changed}\n` : '', stderr: '',
    });
    const drift = await checkDocDrift(subjects, '1234567', { repoRoot: root, runGit });
    expect(drift.stale).toBe(true);
    expect(drift.changedPaths).toContain(changed);
    expect(classifyDrift({ source: 'manual', subjectRef: subjects }, drift)).toMatchObject({ status: 'review' });
  });
  it('the unchanged same-anchor positive control remains fresh', async () => {
    const subjects = [{ kind: 'path' as const, globs: ['src/signup.ts'] }];
    const drift = await checkDocDrift(subjects, '1234567', {
      repoRoot: '/fixture', runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(drift.stale).toBe(false);
    expect(classifyDrift({ source: 'manual', subjectRef: subjects }, drift)).toMatchObject({ status: 'fresh' });
  });
});
