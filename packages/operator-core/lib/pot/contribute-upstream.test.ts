import { describe, it, expect, vi } from 'vitest';
import {
  contributeUpstream,
  type ContributeUpstreamInput,
  type SelfPotMember,
} from './contribute-upstream';
import { PAPERCUSP_CANONICAL_REPO_URL } from './enable-platform-mode';

// All external effects (registry read, export, Comb publish, fork push + PR,
// gh token) are injectable seams, so the whole flow is unit-testable with no IO.

const MEMBER_WITH_FORK: SelfPotMember = {
  memberSlug: 'papercusp-platform',
  potSlug: 'papercusp-platform-pot',
  path: '/tmp/self-pot',
  upstreamRemote: 'https://github.com/Papercusp/papercup.git',
  defaultBranch: 'main',
  forkRemote: 'https://github.com/alice/papercup.git',
};

const MEMBER_NO_FORK: SelfPotMember = {
  memberSlug: 'papercusp-platform',
  potSlug: 'papercusp-platform-pot',
  path: '/tmp/self-pot',
  upstreamRemote: 'https://github.com/Papercusp/papercup.git',
  defaultBranch: 'main',
};

describe('report contribution consent and shared intake (P-015)', () => {
  const receipt = { routed: 'work-item', classification: { kind: 'bug', basis: 'defect-cue' }, capture: { ok: true, issue: { id: 'EI-report' } } } as const;

  it('does not resolve membership or write before consent', async () => {
    const membership = vi.fn();
    const intake = vi.fn();
    expect(await contributeUpstream({ kind: 'report', report: { text: 'Export crashes' }, hasCanonicalReportMembership: membership, intakeReport: intake }))
      .toMatchObject({ prepared: true, needs: ['confirm'] });
    expect(membership).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });

  it('requires canonical membership rather than treating an arbitrary local Pot as upstream', async () => {
    const intake = vi.fn().mockResolvedValue(receipt);
    const result = await contributeUpstream({ kind: 'report', confirm: true, report: { text: 'Export crashes' }, hasCanonicalReportMembership: async () => false, intakeReport: intake });
    expect(result).toMatchObject({ prepared: true, needs: ['canonical-Pot membership'] });
    expect(intake).not.toHaveBeenCalled();
  });

  it('uses the existing shared intake and returns queued, not received upstream', async () => {
    const intake = vi.fn().mockResolvedValue(receipt);
    const context = { appVersion: '0.0.1', screen: '/settings' };
    const result = await contributeUpstream({ kind: 'report', confirm: true, workspaceId: 'install-ws', report: { text: 'Export crashes', reportContext: context }, hasCanonicalReportMembership: async () => true, intakeReport: intake });
    expect(intake).toHaveBeenCalledWith({ text: 'Export crashes', reportContext: context, scope: 'harness:papercusp', workspaceId: 'install-ws' });
    expect(result).toMatchObject({ queued: true, result: receipt });
    expect(result).not.toHaveProperty('sent');
  });

  it('does not claim an upstream bug receipt when classification stores a note', async () => {
    const result = await contributeUpstream({ kind: 'report', confirm: true, report: { text: 'FYI: a note' }, hasCanonicalReportMembership: async () => true, intakeReport: vi.fn().mockResolvedValue({ routed: 'memory' }) });
    expect(result).toMatchObject({ ok: true, localOnly: true, result: { routed: 'memory' } });
    expect(result).not.toHaveProperty('queued');
    expect(result).not.toHaveProperty('sent');
  });

  it('requires report text before touching membership or capture', async () => {
    const membership = vi.fn();
    const intake = vi.fn();
    expect(await contributeUpstream({ kind: 'report', confirm: true, report: { text: ' ' }, hasCanonicalReportMembership: membership, intakeReport: intake }))
      .toMatchObject({ prepared: true, needs: ['report'] });
    expect(membership).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });

  it('does not forward a forged reporter or an arbitrary target scope', async () => {
    const intake = vi.fn().mockResolvedValue(receipt);
    await contributeUpstream({ kind: 'report', confirm: true, workspaceId: 'install-ws',
      report: { text: 'Export crashes', scope: 'harness:private', reporterId: 'admin' } as never,
      hasCanonicalReportMembership: async () => true, intakeReport: intake });
    expect(intake).toHaveBeenCalledWith({ text: 'Export crashes', scope: 'harness:papercusp', workspaceId: 'install-ws' });
  });

  it('returns a failure, not a receipt, if membership cannot be checked', async () => {
    const intake = vi.fn();
    const result = await contributeUpstream({ kind: 'report', confirm: true, report: { text: 'Export crashes' },
      hasCanonicalReportMembership: async () => { throw new Error('membership unavailable'); }, intakeReport: intake });
    expect(result).toMatchObject({ ok: false, error: 'report_contribution_failed' });
    expect(intake).not.toHaveBeenCalled();
  });

  it('never claims queued delivery for failed capture or a missing local receipt', async () => {
    for (const capture of [{ ok: false }, { ok: true }]) {
      const result = await contributeUpstream({ kind: 'report', confirm: true, report: { text: 'Export crashes' },
        hasCanonicalReportMembership: async () => true,
        intakeReport: vi.fn().mockResolvedValue({ ...receipt, capture }) });
      expect(result).toMatchObject({ ok: false, error: 'report_contribution_failed' });
      expect(result).not.toHaveProperty('queued');
    }
  });
});

function deps(over: Partial<ContributeUpstreamInput> = {}): ContributeUpstreamInput {
  return {
    kind: 'knowledge-pack',
    workspaceId: 'w',
    resolveSelfPotMember: async () => MEMBER_WITH_FORK,
    exportPack: async () => ({ ok: true, packDir: '/tmp/self-pot/knowledge-packs/p', exported: 3, skippedPackRows: 0 }),
    publishPack: async () => ({ ok: true, listingId: 'lst_1', reviewStatus: 'pending' }),
    pushAndOpenPr: async () => ({
      ok: true,
      forkOwner: 'alice',
      forkFullName: 'alice/papercup',
      created: false,
      prNumber: 42,
      prUrl: 'https://github.com/Papercusp/papercup/pull/42',
    }),
    resolveGhToken: async () => ({ ok: true, token: 'tkn' }),
    // PR-4 (b): inject a no-op producer so the flow stays IO-free; the pr-path
    // tests below override it with a spy to assert the WI→PR row is written.
    recordFeaturePr: async () => {},
    ...over,
  };
}

describe('contributeUpstream — kind:knowledge-pack (the Comb path) (P-072)', () => {
  it('PREPARED without confirm: exports locally but does NOT publish to the Comb', async () => {
    let published = false;
    const res = await contributeUpstream(
      deps({
        packId: 'my-pack',
        title: 'My Pack',
        description: 'desc',
        publishPack: async () => {
          published = true;
          return { ok: true, reviewStatus: 'pending' };
        },
      }),
    );
    expect(published).toBe(false);
    expect(res).toMatchObject({ ok: true, kind: 'knowledge-pack', prepared: true });
    if ('prepared' in res) expect(res.needs).toContain('confirm');
  });

  it('PREPARED reports missing required args as needs (no confirm fired)', async () => {
    const res = await contributeUpstream(deps({ confirm: true, packId: 'p' /* no title/description */ }));
    expect(res).toMatchObject({ ok: true, prepared: true });
    if ('prepared' in res) {
      expect(res.needs).toEqual(expect.arrayContaining(['title', 'description']));
    }
  });

  it('SENT with confirm: lists the pack on the Comb and the listing stays PENDING', async () => {
    let publishedArgs: unknown = null;
    const res = await contributeUpstream(
      deps({
        confirm: true,
        packId: 'my-pack',
        title: 'My Pack',
        description: 'desc',
        publishPack: async (_m, a) => {
          publishedArgs = a;
          return { ok: true, listingId: 'lst_9', reviewStatus: 'pending' };
        },
      }),
    );
    expect(publishedArgs).toMatchObject({ packId: 'my-pack' });
    expect(res).toMatchObject({ ok: true, kind: 'knowledge-pack', sent: true });
    if ('sent' in res) {
      // The Comb publish stays PENDING (moderation-gated, D-007) — never auto-public.
      expect(res.result.reviewStatus).toBe('pending');
      expect(res.summary).toContain('PENDING');
    }
  });

  it('a failed export (no organic learnings) is a clean error, never a throw', async () => {
    const res = await contributeUpstream(
      deps({
        confirm: true,
        packId: 'p',
        title: 't',
        description: 'd',
        exportPack: async () => ({ ok: false, error: 'nothing_to_export' }),
      }),
    );
    expect(res).toMatchObject({ ok: false, error: 'nothing_to_export' });
  });
});

describe('contributeUpstream — kind:pr (the fork→canonical PR path) (P-072)', () => {
  function prDeps(over: Partial<ContributeUpstreamInput> = {}): ContributeUpstreamInput {
    return deps({
      kind: 'pr',
      featureBranch: 'platform/fix-1',
      prTitle: 'Fix a thing',
      prBody: 'Body of the PR.',
      ...over,
    });
  }

  it('PREPARED without confirm: does NOT push or open a PR', async () => {
    let fired = false;
    const res = await contributeUpstream(
      prDeps({
        pushAndOpenPr: async () => {
          fired = true;
          return { ok: false, error: 'should-not-run' };
        },
      }),
    );
    expect(fired).toBe(false);
    expect(res).toMatchObject({ ok: true, kind: 'pr', prepared: true });
    if ('prepared' in res) expect(res.needs).toContain('confirm');
  });

  it('NO direct-push to canonical: without a fork_remote it stays PREPARED (needs fork_remote), never sends', async () => {
    let fired = false;
    const res = await contributeUpstream(
      prDeps({
        confirm: true,
        resolveSelfPotMember: async () => MEMBER_NO_FORK,
        pushAndOpenPr: async () => {
          fired = true;
          return { ok: false, error: 'should-not-run' };
        },
      }),
    );
    // Even WITH confirm, a missing fork is a hard gate — the canonical repo is
    // never direct-pushed (D-007).
    expect(fired).toBe(false);
    expect(res).toMatchObject({ ok: true, kind: 'pr', prepared: true });
    if ('prepared' in res) expect(res.needs).toContain('fork_remote');
  });

  it('PREPARED when gh auth is missing (credential presence gate), never sends', async () => {
    let fired = false;
    const res = await contributeUpstream(
      prDeps({
        confirm: true,
        resolveGhToken: async () => ({ ok: false, reason: 'not_authenticated' }),
        pushAndOpenPr: async () => {
          fired = true;
          return { ok: false, error: 'should-not-run' };
        },
      }),
    );
    expect(fired).toBe(false);
    expect(res).toMatchObject({ ok: true, prepared: true });
    if ('prepared' in res) expect(res.needs).toContain('gh_auth');
  });

  it('SENT with confirm + fork + creds: pushes to the fork and opens a fork→canonical PR', async () => {
    let prArgs: unknown = null;
    const res = await contributeUpstream(
      prDeps({
        confirm: true,
        pushAndOpenPr: async (m, a) => {
          prArgs = { member: m, args: a };
          return {
            ok: true,
            forkOwner: 'alice',
            forkFullName: 'alice/papercup',
            created: true,
            prNumber: 7,
            prUrl: 'https://github.com/Papercusp/papercup/pull/7',
          };
        },
      }),
    );
    expect(res).toMatchObject({ ok: true, kind: 'pr', sent: true });
    if ('sent' in res) {
      expect(res.result).toMatchObject({ prNumber: 7, forkFullName: 'alice/papercup' });
      // The summary makes the fork→canonical, human-reviewed nature explicit.
      expect(res.summary).toContain('canonical Papercusp');
    }
    // The PR seam received the user's fork + the canonical upstream coords — the
    // push target is the fork, the PR base is canonical (never a direct push).
    expect((prArgs as { member: SelfPotMember }).member.forkRemote).toBe(MEMBER_WITH_FORK.forkRemote);
    expect((prArgs as { member: SelfPotMember }).member.upstreamRemote).toBe(PAPERCUSP_CANONICAL_REPO_URL);
  });

  it('a fork-PR seam failure is reported, never thrown', async () => {
    const res = await contributeUpstream(
      prDeps({ confirm: true, pushAndOpenPr: async () => ({ ok: false, error: 'push rejected' }) }),
    );
    expect(res).toMatchObject({ ok: false, kind: 'pr', error: 'fork_pr_failed', message: 'push rejected' });
  });

  it('PR-4: tracks the WI→PR row (member harness + featureBranch) when the PR is SENT', async () => {
    const rows: unknown[] = [];
    const res = await contributeUpstream(
      prDeps({ confirm: true, recordFeaturePr: async (r) => { rows.push(r); } }),
    );
    expect(res).toMatchObject({ ok: true, kind: 'pr', sent: true });
    expect(rows).toEqual([
      {
        workspaceId: 'w',
        harnessSlug: 'papercusp-platform',
        featureId: 'platform/fix-1',
        prUrl: 'https://github.com/Papercusp/papercup/pull/42',
      },
    ]);
  });

  it('PR-4: does NOT track a row when the PR stays PREPARED (nothing opened)', async () => {
    const rows: unknown[] = [];
    await contributeUpstream(prDeps({ recordFeaturePr: async (r) => { rows.push(r); } }));
    expect(rows).toEqual([]);
  });

  it('PR-4: a producer write failure does NOT fail the SENT contribution', async () => {
    const res = await contributeUpstream(
      prDeps({
        confirm: true,
        recordFeaturePr: async () => { throw new Error('pg down'); },
      }),
    );
    expect(res).toMatchObject({ ok: true, kind: 'pr', sent: true });
  });
});

describe('contributeUpstream — self-pot resolution', () => {
  it('a missing self-pot is a clean error (platform mode never enabled), never a throw', async () => {
    const res = await contributeUpstream(deps({ resolveSelfPotMember: async () => null }));
    expect(res).toMatchObject({ ok: false, error: 'self_hive_not_found' });
  });

  it('a throwing resolver is caught and reported, never crashes the flow', async () => {
    const res = await contributeUpstream(
      deps({
        resolveSelfPotMember: async () => {
          throw new Error('registry down');
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, error: 'self_hive_resolve_failed' });
  });
});
