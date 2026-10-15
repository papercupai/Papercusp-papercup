import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { GitHubPrHost, parseRemote } from './github';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockOctokit(overrides: Partial<{
  pullsCreate: unknown;
  pullsGet: unknown;
  pullsListReviews: unknown;
  pullsCreateReview: unknown;
  pullsMerge: unknown;
  pullsList: unknown;
  reposGetContent: unknown;
}>): Octokit {
  return {
    paginate: vi.fn(async (method, args) => (await method(args)).data),
    pulls: {
      create: vi.fn().mockResolvedValue(overrides.pullsCreate ?? { data: makePrData() }),
      get: vi.fn().mockResolvedValue(overrides.pullsGet ?? { data: makePrData() }),
      listReviews: vi.fn().mockResolvedValue(overrides.pullsListReviews ?? { data: [] }),
      createReview: vi.fn().mockResolvedValue(overrides.pullsCreateReview ?? { data: {} }),
      merge: vi.fn().mockResolvedValue(overrides.pullsMerge ?? { data: { sha: 'abc123' } }),
      list: vi.fn().mockResolvedValue(overrides.pullsList ?? { data: [makePrData()] }),
      listCommits: vi.fn().mockResolvedValue({ data: [{ sha: 'deadbeef', commit: { message: 'Fix', author: { name: 'Alice' } }, html_url: 'https://github.com/commit' }] }),
      listFiles: vi.fn().mockResolvedValue({ data: [{ filename: 'file.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@\n+safe' }] }),
      update: vi.fn().mockResolvedValue({ data: {} }),
    },
    repos: {
      getContent: vi.fn().mockResolvedValue(overrides.reposGetContent ?? { data: '' }),
      getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { statuses: [] } }),
      getBranch: vi.fn().mockResolvedValue({ data: { commit: { sha: 'base' } } }),
    },
    checks: { listForRef: vi.fn().mockResolvedValue({ data: [] }) },
  } as unknown as Octokit;
}

function makePrData(n = 42) {
  return {
    number: n,
    title: 'Fix the thing',
    body: 'This PR does the thing.',
    state: 'open',
    merged: false,
    head: { sha: 'deadbeef', ref: 'fix/thing' },
    base: { ref: 'main' },
    user: { id: 1234, login: 'alice' },
    html_url: 'https://github.com/owner/repo/pull/' + n,
    created_at: '2026-05-24T10:00:00Z',
    updated_at: '2026-05-24T11:00:00Z',
    merged_at: null,
  };
}

const REMOTE = 'github.com/owner/repo';

describe('GitHub PR viewer', () => {
  it('lists merged and closed history using pagination and neutral identities', async () => {
    const oc = mockOctokit({ pullsList: { data: [makePrData(), { ...makePrData(43), state: 'closed', merged_at: '2026-10-05', merge_commit_sha: 'landed' }, { ...makePrData(44), state: 'closed' }] } });
    const r = await new GitHubPrHost(oc).listPrs({ remote: REMOTE, state: 'all' });
    expect(r.ok && r.data.map(p => [p.ref.number, p.state])).toEqual([[42, 'open'], [43, 'merged'], [44, 'closed']]);
    expect(oc.paginate).toHaveBeenCalledWith(oc.pulls.list, expect.objectContaining({ state: 'all', per_page: 100 }));
  });
  it("reports each PR's head repository, null when the head fork is gone (WI-10006271)", async () => {
    const fromFork = { ...makePrData(50), head: { sha: 'f1', ref: 'fix/thing', repo: { full_name: 'potbot/repo' } } };
    const forkDeleted = { ...makePrData(51), head: { sha: 'f2', ref: 'fix/thing', repo: null } };
    const oc = mockOctokit({ pullsList: { data: [fromFork, forkDeleted] } });
    const r = await new GitHubPrHost(oc).listPrs({ remote: REMOTE, state: 'all' });
    expect(r.ok && r.data.map((p) => [p.ref.number, p.head_repo])).toEqual([[50, 'potbot/repo'], [51, null]]);
  });
  it('loads commits, patches, target and diff without calling absent checks green', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.get).mockImplementation(async (args) => ({ data: args?.mediaType ? 'diff --git file.ts\n+safe' : makePrData() }) as unknown as Awaited<ReturnType<Octokit['pulls']['get']>>);
    const r = await new GitHubPrHost(oc).getPrDetails({ remote: REMOTE, number: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.pr.checks_state).toBe('unknown');
      expect(r.data.files[0].patch).toContain('+safe');
      expect(r.data.commits[0].message).toBe('Fix');
      expect(r.data.targetSha).toBe('base');
    }
  });
  it('rejects details when the head changes during the read', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.get).mockResolvedValueOnce({ data: makePrData() } as unknown as Awaited<ReturnType<Octokit['pulls']['get']>>)
      .mockResolvedValueOnce({ data: 'diff' } as unknown as Awaited<ReturnType<Octokit['pulls']['get']>>)
      .mockResolvedValueOnce({ data: { ...makePrData(), head: { sha: 'moved', ref: 'fix/thing' } } } as unknown as Awaited<ReturnType<Octokit['pulls']['get']>>);
    const r = await new GitHubPrHost(oc).getPrDetails({ remote: REMOTE, number: 42 });
    expect(!r.ok && r.error.kind).toBe('conflict');
  });
  it('closes the requested PR and surfaces host failures', async () => {
    const oc = mockOctokit({});
    expect((await new GitHubPrHost(oc).closePr({ remote: REMOTE, number: 42 })).ok).toBe(true);
    expect(oc.pulls.update).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 42, state: 'closed' });
    vi.mocked(oc.pulls.update).mockRejectedValue({ status: 403, message: 'denied' });
    expect((await new GitHubPrHost(oc).closePr({ remote: REMOTE, number: 42 })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseRemote
// ---------------------------------------------------------------------------

describe('parseRemote', () => {
  it('parses github.com/owner/repo', () => {
    expect(parseRemote('github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });
  it('parses https://github.com/owner/repo.git', () => {
    expect(parseRemote('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });
  it('returns null for non-github remotes', () => {
    expect(parseRemote('gitlab.com/owner/repo')).toBeNull();
    expect(parseRemote('')).toBeNull();
    expect(parseRemote('just-a-word')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P-040a — openPr
// ---------------------------------------------------------------------------

describe('GitHubPrHost.openPr', () => {
  it('P-040a: returns structured Pr on success', async () => {
    const host = new GitHubPrHost(mockOctokit({}));
    const result = await host.openPr({
      remote: REMOTE,
      title: 'Fix the thing',
      body: 'Body',
      head_ref: 'fix/thing',
      base_ref: 'main',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ref.number).toBe(42);
      expect(result.data.state).toBe('open');
    }
  });

  it('P-040a: maps 422 to validation error', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.create).mockRejectedValue({ status: 422, message: 'Validation failed' });
    const host = new GitHubPrHost(oc);
    const result = await host.openPr({ remote: REMOTE, title: 'x', body: '', head_ref: 'f', base_ref: 'main' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });

  it('P-040a: returns validation error on unparseable remote', async () => {
    const host = new GitHubPrHost(mockOctokit({}));
    const result = await host.openPr({ remote: 'not-github', title: 'x', body: '', head_ref: 'f', base_ref: 'main' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });

  it('builds cross-fork head "<head_owner>:<head_ref>" while keeping owner/repo upstream', async () => {
    const oc = mockOctokit({});
    const host = new GitHubPrHost(oc);
    await host.openPr({
      remote: REMOTE, // upstream github.com/owner/repo
      title: 'Feature from a fork',
      body: 'b',
      head_ref: 'harness/F-001',
      base_ref: 'main',
      head_owner: 'aviynw',
    });
    const arg = vi.mocked(oc.pulls.create).mock.calls[0]?.[0] as unknown as {
      owner: string;
      repo: string;
      head: string;
      base: string;
    };
    // PR is opened ON the upstream repo, with the head namespaced to the fork.
    expect(arg.owner).toBe('owner');
    expect(arg.repo).toBe('repo');
    expect(arg.head).toBe('aviynw:harness/F-001');
    expect(arg.base).toBe('main');
  });

  it('builds same-repo head "<head_ref>" when head_owner is omitted (back-compat)', async () => {
    const oc = mockOctokit({});
    const host = new GitHubPrHost(oc);
    await host.openPr({
      remote: REMOTE,
      title: 'Feature on a branch',
      body: 'b',
      head_ref: 'fix/thing',
      base_ref: 'main',
    });
    const arg = vi.mocked(oc.pulls.create).mock.calls[0]?.[0] as unknown as {
      owner: string;
      repo: string;
      head: string;
      base: string;
    };
    expect(arg.head).toBe('fix/thing');
  });
});

// ---------------------------------------------------------------------------
// P-040b — getPr
// ---------------------------------------------------------------------------

describe('GitHubPrHost.getPr', () => {
  it('P-040b: returns Pr on success', async () => {
    const host = new GitHubPrHost(mockOctokit({}));
    const result = await host.getPr({ remote: REMOTE, number: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.head_sha).toBe('deadbeef');
  });

  it('P-040b: state is merged when merged=true', async () => {
    const prData = { ...makePrData(), state: 'closed', merged: true };
    const host = new GitHubPrHost(mockOctokit({ pullsGet: { data: prData } }));
    const result = await host.getPr({ remote: REMOTE, number: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.state).toBe('merged');
  });

  it('P-040b: maps 404 to not_found', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.get).mockRejectedValue({ status: 404, message: 'Not Found' });
    const host = new GitHubPrHost(oc);
    const result = await host.getPr({ remote: REMOTE, number: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// P-040c — postReview
// ---------------------------------------------------------------------------

describe('GitHubPrHost.postReview', () => {
  it('P-040c: returns ok void on approve', async () => {
    const host = new GitHubPrHost(mockOctokit({}));
    const result = await host.postReview({ ref: { remote: REMOTE, number: 42 }, event: 'approve' });
    expect(result.ok).toBe(true);
  });

  it('P-040c: maps 422 to validation', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.createReview).mockRejectedValue({ status: 422, message: 'Cannot approve own PR' });
    const host = new GitHubPrHost(oc);
    const result = await host.postReview({ ref: { remote: REMOTE, number: 42 }, event: 'approve' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// P-040d — merge
// ---------------------------------------------------------------------------

describe('GitHubPrHost.merge', () => {
  it('P-040d: returns merge_commit_sha on success', async () => {
    const host = new GitHubPrHost(mockOctokit({}));
    const result = await host.merge({ ref: { remote: REMOTE, number: 42 }, method: 'squash' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.merge_commit_sha).toBe('abc123');
  });

  it('P-040d: maps 409 to conflict', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.merge).mockRejectedValue({ status: 409, message: 'Head diverged' });
    const host = new GitHubPrHost(oc);
    const result = await host.merge({ ref: { remote: REMOTE, number: 42 }, method: 'squash' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('conflict');
  });
});

// ---------------------------------------------------------------------------
// P-040e — listOpenPrs
// ---------------------------------------------------------------------------

describe('GitHubPrHost.listOpenPrs', () => {
  it('P-040e: returns array of open PRs', async () => {
    const host = new GitHubPrHost(mockOctokit({}));
    const result = await host.listOpenPrs({ remote: REMOTE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].ref.number).toBe(42);
      expect(result.data[0].state).toBe('open');
    }
  });

  it('P-040e: maps 429 to rate_limited with retry_after_ms', async () => {
    const futureReset = Math.floor((Date.now() + 30000) / 1000);
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.list).mockRejectedValue({
      status: 429,
      message: 'Too many requests',
      response: { headers: { 'x-ratelimit-reset': String(futureReset) } },
    });
    const host = new GitHubPrHost(oc);
    const result = await host.listOpenPrs({ remote: REMOTE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate_limited');
      expect(result.error.retry_after_ms).toBeGreaterThan(0);
    }
  });

  it('P-040e: maps 5xx to server_error', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.list).mockRejectedValue({ status: 503, message: 'Service unavailable' });
    const host = new GitHubPrHost(oc);
    const result = await host.listOpenPrs({ remote: REMOTE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('server_error');
  });
});

// ---------------------------------------------------------------------------
// PR-2 — getPrDiff (the reviewer's diff input)
// ---------------------------------------------------------------------------

describe('GitHubPrHost.getPrDiff', () => {
  const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';

  it('returns the raw unified diff and requests the diff media type', async () => {
    const oc = mockOctokit({ pullsGet: { data: DIFF } });
    const host = new GitHubPrHost(oc);
    const result = await host.getPrDiff({ remote: REMOTE, number: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(DIFF);
    expect(vi.mocked(oc.pulls.get)).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        pull_number: 42,
        mediaType: { format: 'diff' },
      }),
    );
  });

  it('maps 404 to not_found', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.pulls.get).mockRejectedValue({ status: 404, message: 'Not Found' });
    const host = new GitHubPrHost(oc);
    const result = await host.getPrDiff({ remote: REMOTE, number: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });

  it('rejects an unparseable remote with a validation error', async () => {
    const host = new GitHubPrHost(mockOctokit({}));
    const result = await host.getPrDiff({ remote: 'gitlab.com/o/r', number: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// PR-2 — getRepoFile (repo conventions loading)
// ---------------------------------------------------------------------------

describe('GitHubPrHost.getRepoFile', () => {
  it('returns the raw file content at the requested path + ref', async () => {
    const oc = mockOctokit({ reposGetContent: { data: '# Conventions\nAlways add a test.' } });
    const host = new GitHubPrHost(oc);
    const result = await host.getRepoFile({ remote: REMOTE, path: 'CONTRIBUTING.md', ref: 'main' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain('Always add a test.');
    expect(vi.mocked(oc.repos.getContent)).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        path: 'CONTRIBUTING.md',
        ref: 'main',
        mediaType: { format: 'raw' },
      }),
    );
  });

  it('maps a missing file (404) to not_found', async () => {
    const oc = mockOctokit({});
    vi.mocked(oc.repos.getContent).mockRejectedValue({ status: 404, message: 'Not Found' });
    const host = new GitHubPrHost(oc);
    const result = await host.getRepoFile({ remote: REMOTE, path: 'AGENTS.md' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });

  it('rejects an unparseable remote with a validation error', async () => {
    const host = new GitHubPrHost(mockOctokit({}));
    const result = await host.getRepoFile({ remote: 'bad-remote', path: 'CONTRIBUTING.md' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });
});
