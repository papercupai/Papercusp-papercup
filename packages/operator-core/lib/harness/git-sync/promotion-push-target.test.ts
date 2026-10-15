import { describe, expect, it } from 'vitest';
import type { ProjectEntry } from '../../harness-registry';
import type { PotIntegrationModeRead } from './pot-integration-mode';
import { resolvePromotionPushTarget } from './promotion-push-target';

const REPO = '/repos/pot-a';
const FORK = 'https://github.com/forker/pot-a.git';
const UPSTREAM = 'https://github.com/upstream/pot-a.git';

function entry(over: Partial<ProjectEntry> = {}): ProjectEntry {
  return { slug: 'pot-a', path: REPO, self_repo: true, github_remote: UPSTREAM, ...over } as ProjectEntry;
}

function run(
  projects: readonly ProjectEntry[] | Error,
  read: PotIntegrationModeRead,
  workspaceId: string | null = 'ws-1',
) {
  return resolvePromotionPushTarget(
    { repoPath: `${REPO}/`, workspaceId: workspaceId ?? undefined },
    {
      loadProjects: async () => {
        if (projects instanceof Error) throw projects;
        return projects;
      },
      readMode: async () => read,
      canonical: (p) => p.replace(/\/+$/, ''),
    },
  );
}

const REVIEW: PotIntegrationModeRead = { mode: 'review', source: 'set' };

describe('resolvePromotionPushTarget', () => {
  it('publishes to origin when no registered pot owns the checkout', async () => {
    expect((await run([entry({ path: '/elsewhere' })], REVIEW)).kind).toBe('origin');
  });

  it('publishes to origin for a registered repo that is not a pot home or member', async () => {
    expect((await run([entry({ self_repo: false, fork_remote: FORK })], REVIEW)).kind).toBe('origin');
  });

  it('publishes to origin in direct mode (explicit or default)', async () => {
    expect((await run([entry({ fork_remote: FORK })], { mode: 'direct', source: 'set' })).kind).toBe('origin');
    expect((await run([entry({ fork_remote: FORK })], { mode: 'direct', source: 'absent' })).kind).toBe('origin');
  });

  it('routes a review-mode pot with a fork to the pot-fork remote, never origin', async () => {
    const t = await run([entry({ fork_remote: FORK })], REVIEW);
    expect(t).toMatchObject({
      kind: 'fork',
      remoteName: 'pot-fork',
      url: FORK,
      potHomeSlug: 'pot-a',
      upstreamRemote: UPSTREAM,
      integration: REVIEW,
    });
  });

  it('uses the hive_slug as the pot home for a hive member', async () => {
    const t = await run([entry({ self_repo: false, hive_slug: 'hive-x', fork_remote: FORK })], REVIEW);
    expect(t).toMatchObject({ kind: 'fork', potHomeSlug: 'hive-x' });
  });

  it('publishes nowhere for a review-mode pot without a fork', async () => {
    expect(await run([entry()], REVIEW)).toMatchObject({ kind: 'skip', reason: 'working_copy_fork_missing' });
  });

  it('holds promotion when the mode cannot be read or is malformed (fail closed)', async () => {
    expect(await run([entry({ fork_remote: FORK })], { mode: 'direct', source: 'error' })).toMatchObject({
      kind: 'hold',
      reason: 'integration_mode_unknown',
    });
    expect(await run([entry({ fork_remote: FORK })], { mode: 'direct', source: 'malformed' })).toMatchObject({
      kind: 'hold',
      reason: 'integration_mode_malformed',
    });
  });

  it('holds promotion when the registry cannot be loaded', async () => {
    expect(await run(new Error('pg down'), REVIEW)).toMatchObject({ kind: 'hold', reason: 'registry_unreadable' });
  });

  it('holds promotion for a pot when no workspace id is known', async () => {
    expect(await run([entry({ fork_remote: FORK })], REVIEW, null)).toMatchObject({
      kind: 'hold',
      reason: 'integration_mode_unknown',
    });
  });
});
