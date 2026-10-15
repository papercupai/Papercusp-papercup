/**
 * github-bridge-tick (github-bridge-hive-egress P-008) — the composed bridge
 * pass with every mechanism seam injected (unit-hermetic: no git, no PG, no
 * network). The mechanisms themselves are covered by their own suites
 * (P-001/P-002/P-005/P-006); this proves the COMPOSITION contract.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached — inject seams in tests');
  },
}));

import {
  runGithubBridgeTick,
  BRIDGE_REMOTE_STAGING_REF,
  BRIDGE_CANONICAL_REF,
  GITHUB_CREDENTIAL_HELPER_KEY,
  withGithubCredentialHelper,
  type BridgeTickInput,
} from './github-bridge-tick';
import type { IngressResult } from './github-ingress';
import type { AdmissionResult } from './github-ingress-admission';
import type { EgressInput, EgressResult } from './github-egress';
import type { DivergenceVerdict } from './github-divergence';

const CANONICAL = 'c'.repeat(40);
const HEAD_A = 'a'.repeat(40);

const cleanIngress = (over: Partial<IngressResult> = {}): IngressResult => ({
  ok: true,
  namespaceKey: 'ns',
  updated: [],
  upToDate: ['main'],
  nonFF: [],
  absent: [],
  errors: [],
  ...over,
});

const admitClean = (): AdmissionResult => ({
  admit: true,
  basis: 'clean',
  blockedAuthors: [],
  unknownAuthors: [],
  checkedAuthorIds: [],
  errors: [],
});

const cleanEgress = (over: Partial<EgressResult> = {}): EgressResult => ({
  ok: true,
  pushed: [{ remoteRef: BRIDGE_REMOTE_STAGING_REF, from: null, to: CANONICAL }],
  upToDate: [],
  rejectedNonFF: [],
  blockedSecrets: [],
  exemptedFindings: [],
  tagsPushed: [],
  tagsRejected: [],
  remoteErrors: [],
  errors: [],
  ...over,
});

/** Base input: canonical ref resolvable, all seams injected + captured. */
function bridgeInput(over: Partial<BridgeTickInput> = {}, seams: Partial<NonNullable<BridgeTickInput['deps']>> = {}) {
  const recorded: DivergenceVerdict[] = [];
  const egressCalls: unknown[] = [];
  const input: BridgeTickInput = {
    potHomeSlug: 'shop-hive',
    workspaceId: 'ws',
    repoKey: 'shop',
    githubRemote: 'https://github.com/acme/shop.git',
    branches: ['main'],
    upstreamWrite: true,
    lastAdmitted: null,
    deps: {
      repoPath: '/tmp/fake-bare.git',
      runGit: async (args) =>
        args[0] === 'rev-parse'
          ? { code: 0, stdout: `${CANONICAL}\n`, stderr: '' }
          : { code: 0, stdout: '', stderr: '' },
      ingress: async () => cleanIngress(),
      admit: async () => admitClean(),
      egress: async (i) => (egressCalls.push(i), cleanEgress()),
      record: async (_h, _w, v) => void recorded.push(v),
      ...seams,
    },
    ...over,
  };
  return { input, recorded, egressCalls };
}

describe('withGithubCredentialHelper', () => {
  it('pins GitHub network commands to the checkout helper without changing bare-store plumbing', async () => {
    const runGit = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const wrapped = withGithubCredentialHelper(runGit, '!/tmp/gh-credential-aviynw.sh');
    const opts = { timeoutMs: 1234 };

    await wrapped(
      ['fetch', 'https://github.com/acme/shop.git', '+refs/heads/main:refs/ingress/main'],
      '/tmp/bare.git',
      opts,
    );
    await wrapped(['rev-parse', '--verify', 'refs/hive/staging'], '/tmp/bare.git', opts);

    expect(runGit).toHaveBeenNthCalledWith(
      1,
      [
        '-c',
        `${GITHUB_CREDENTIAL_HELPER_KEY}=`,
        '-c',
        `${GITHUB_CREDENTIAL_HELPER_KEY}=!/tmp/gh-credential-aviynw.sh`,
        'fetch',
        'https://github.com/acme/shop.git',
        '+refs/heads/main:refs/ingress/main',
      ],
      '/tmp/bare.git',
      opts,
    );
    expect(runGit).toHaveBeenNthCalledWith(2, ['rev-parse', '--verify', 'refs/hive/staging'], '/tmp/bare.git', opts);
  });

  it('ignores blank or newline-bearing helper values', async () => {
    const runGit = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await withGithubCredentialHelper(runGit, '  \n  ')(['fetch', 'https://github.com/acme/shop.git'], '/tmp/bare.git');
    await withGithubCredentialHelper(runGit, '!bad\nhelper')(
      ['fetch', 'https://github.com/acme/shop.git'],
      '/tmp/bare.git',
    );

    expect(runGit).toHaveBeenNthCalledWith(1, ['fetch', 'https://github.com/acme/shop.git'], '/tmp/bare.git');
    expect(runGit).toHaveBeenNthCalledWith(2, ['fetch', 'https://github.com/acme/shop.git'], '/tmp/bare.git');
  });
});

it('threads the selected helper through ingress and egress while leaving canonical reads unmodified', async () => {
  const helper = '!/tmp/gh-credential-aviynw.sh';
  const calls: string[][] = [];
  let ingressHistorySourcePath: string | undefined;
  const { input } = bridgeInput(
    { githubCredentialHelper: helper, historySourcePath: '/tmp/registered-checkout' },
    {
      runGit: async (args) => {
        calls.push(args);
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${CANONICAL}\n`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      ingress: async ({ runGit, repoPath, remoteUrl, historySourcePath }) => {
        ingressHistorySourcePath = historySourcePath;
        await runGit?.(['fetch', remoteUrl, '+refs/heads/main:refs/ingress/main'], repoPath);
        return cleanIngress();
      },
      egress: async ({ runGit, repoPath, remoteUrl }) => {
        await runGit?.(['ls-remote', remoteUrl, BRIDGE_REMOTE_STAGING_REF], repoPath);
        return cleanEgress();
      },
    },
  );

  await runGithubBridgeTick(input);

  expect(ingressHistorySourcePath).toBe('/tmp/registered-checkout');
  expect(calls).toContainEqual([
    '-c',
    `${GITHUB_CREDENTIAL_HELPER_KEY}=`,
    '-c',
    `${GITHUB_CREDENTIAL_HELPER_KEY}=${helper}`,
    'fetch',
    input.githubRemote,
    '+refs/heads/main:refs/ingress/main',
  ]);
  expect(calls).toContainEqual(['rev-parse', '--verify', '--quiet', BRIDGE_CANONICAL_REF]);
  expect(calls).toContainEqual([
    '-c',
    `${GITHUB_CREDENTIAL_HELPER_KEY}=`,
    '-c',
    `${GITHUB_CREDENTIAL_HELPER_KEY}=${helper}`,
    'ls-remote',
    input.githubRemote,
    BRIDGE_REMOTE_STAGING_REF,
  ]);
});

describe('runGithubBridgeTick — an unreachable remote must not read green', () => {
  it('egresses a newly integrated head without repeating ingress/admission or clearing their refusal', async () => {
    let canonical = HEAD_A;
    const ingress = vi.fn(async () => cleanIngress({ updated: [{ branch: 'main', from: null, to: HEAD_A, forced: false }] }));
    const admit = vi.fn(async (): Promise<AdmissionResult> => ({ ...admitClean(), admit: false, basis: 'error', errors: ['admission unavailable'] }));
    const egress = vi.fn(async (i: EgressInput) => cleanEgress({ pushed: [{ remoteRef: BRIDGE_REMOTE_STAGING_REF, from: null, to: i.refs[0].sha }] }));
    const { input } = bridgeInput({}, {
      ingress, admit, egress,
      runGit: async () => ({ code: 0, stdout: canonical + '\n', stderr: '' }),
    });
    const early = await runGithubBridgeTick(input);
    canonical = CANONICAL; // the integrator advances staging later in the same fire
    const late = await runGithubBridgeTick({ ...input, ingressSnapshot: early.ingressSnapshot });

    expect(early.egressHead).toBe(HEAD_A);
    expect(late.egressHead).toBe(CANONICAL);
    expect(ingress).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
    expect(egress).toHaveBeenCalledTimes(2);
    expect(late.lastAdmitted).toBeNull();
    expect(late.verdict.signals).toContainEqual(expect.objectContaining({ kind: 'admission-blocked', head: HEAD_A }));
    expect(late.errors).toContain('admission aaaaaaaaaaaa: admission unavailable');
  });

  // The oddsmith regression (2026-07-19): the bare store resolved a different
  // git credential than the clone, so ingress hit `Repository not found` on
  // every tick. Every structured residue was empty BECAUSE nothing was
  // fetched, so the tick classified `clear` while the bridge was inert and
  // origin was frozen.
  it('ingress that reaches NOTHING and only errors → escalate + needsOwner (not clear)', async () => {
    const { input, recorded } = bridgeInput(
      {},
      {
        ingress: async () =>
          cleanIngress({
            ok: false,
            upToDate: [],
            errors: [{ branch: 'main', message: 'remote: Repository not found.' }],
          }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(true);
    expect(out.verdict.signals.map((s) => s.kind)).toContain('bridge-remote-unreachable');
    expect(recorded.at(-1)?.action).toBe('escalate');
  });

  it('a per-branch error alongside a branch that DID resolve is not "unreachable"', async () => {
    const { input } = bridgeInput(
      {},
      {
        ingress: async () => cleanIngress({ errors: [{ branch: 'gone', message: "couldn't find remote ref gone" }] }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.signals.map((s) => s.kind)).not.toContain('bridge-remote-unreachable');
  });

  // EI-18152354175913564: a `spawn git ENOENT` right after a bg-host restart
  // misclassified as "fix the remote URL or credential" — an owner acting on
  // that literal guidance wastes time on a problem that was never a
  // credential/URL issue and had already self-cleared.
  it('a spawn-level fault (transient) still escalates but does NOT need an owner', async () => {
    const { input } = bridgeInput(
      {},
      {
        ingress: async () =>
          cleanIngress({
            ok: false,
            upToDate: [],
            errors: [{ branch: 'main', message: 'Error: spawn git ENOENT', transient: true }],
          }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.signals.map((s) => s.kind)).toContain('bridge-remote-unreachable');
    expect(out.verdict.needsOwner).toBe(false);
    expect(out.verdict.detail).not.toMatch(/fix the remote URL or wire the credential/i);
    expect(out.verdict.detail).toMatch(/transient/i);
  });

  it('a mix of transient AND real errors across branches is NOT treated as transient', async () => {
    const { input } = bridgeInput(
      {},
      {
        ingress: async () =>
          cleanIngress({
            ok: false,
            upToDate: [],
            errors: [
              { branch: 'main', message: 'Error: spawn git ENOENT', transient: true },
              { branch: 'staging', message: 'remote: Repository not found.', transient: false },
            ],
          }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.needsOwner).toBe(true);
    expect(out.verdict.detail).toMatch(/fix the remote URL or wire the credential/i);
  });
});

describe('runGithubBridgeTick — composition', () => {
  it('clean pass: ingress → egress canonical staging to the resolved target → clear verdict', async () => {
    const { input, recorded, egressCalls } = bridgeInput();
    const out = await runGithubBridgeTick(input);
    expect(out.ran).toBe(true);
    expect(out.egressTarget).toBe('upstream');
    expect(out.egress).toMatchObject({ pushed: 1, rejectedNonFF: 0 });
    expect((egressCalls[0] as { refs: Array<{ sha: string; remoteRef: string }> }).refs).toEqual([
      { sha: CANONICAL, remoteRef: BRIDGE_REMOTE_STAGING_REF },
    ]);
    expect(out.verdict.action).toBe('clear');
    expect(recorded).toHaveLength(1); // clean pass still records (clears) the escalation
  });

  it('egress transport failure records an escalation instead of clearing divergence', async () => {
    const { input, recorded } = bridgeInput(
      {},
      {
        egress: async () =>
          cleanEgress({
            pushed: [],
            remoteErrors: [{ message: 'push refs/heads/staging: 403 email verification required', transient: false }],
            errors: ['push refs/heads/staging: remote rejected with 403'],
          }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(true);
    expect(out.verdict.signals.map((s) => s.kind)).toContain('bridge-egress-unreachable');
    expect(recorded.at(-1)?.action).toBe('escalate');
  });

  it('workflow-scope egress refusal routes to the agent lane instead of needs_owner', async () => {
    const { input, recorded } = bridgeInput(
      {},
      {
        egress: async () =>
          cleanEgress({
            pushed: [],
            remoteErrors: [
              {
                message:
                  'push refs/heads/staging: refusing to allow an OAuth App to update workflow without workflow scope',
                transient: false,
              },
            ],
            errors: ['push refs/heads/staging: workflow scope missing'],
          }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(false);
    expect(out.verdict.agentActionable).toBe(true);
    expect(out.verdict.agentRemedies?.[0]?.command).toBe('git checkout origin/staging -- .github/workflows/ci.yml');
    expect(recorded.at(-1)?.agentActionable).toBe(true);
  });

  it('fork wins over upstream write (D-007b preserved)', async () => {
    const { input, egressCalls } = bridgeInput({ forkRemote: 'https://github.com/me/shop.git' });
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('fork');
    expect((egressCalls[0] as { remoteUrl: string }).remoteUrl).toBe('https://github.com/me/shop.git');
  });

  it('no fork + GitHub AFFIRMATIVELY refused write → egress skipped, ingress still runs', async () => {
    const { input, egressCalls } = bridgeInput({ upstreamWrite: false });
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('skipped');
    expect(out.egress).toBeNull();
    expect(egressCalls).toHaveLength(0);
    expect(out.ingressed.upToDate).toBe(1);
  });

  it('no fork + UNKNOWN upstream write → still egresses (probe and transport are different credential planes)', async () => {
    const { input, egressCalls } = bridgeInput({ upstreamWrite: null });
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('upstream');
    expect(egressCalls).toHaveLength(1);
  });

  it('no canonical staging yet → egress skipped, and the pass ESCALATES rather than reading clear', async () => {
    // Regression (hello-world-3-pot canary, 2026-07-18): a live egress target
    // with an unestablished canonical ref used to be indistinguishable from a
    // healthy no-op — `egress: null` + verdict 'clear' every tick — so GitHub
    // origin silently froze 8 commits / ~22h behind while the bridge reported
    // green. Nothing may be pushed without a canonical, but it MUST be loud.
    const { input, recorded, egressCalls } = bridgeInput(
      {},
      { runGit: async () => ({ code: 1, stdout: '', stderr: '' }) },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.egress).toBeNull();
    expect(egressCalls).toHaveLength(0); // still never pushes a canonical it cannot read
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.signals).toEqual([
      { kind: 'egress-canonical-missing', canonicalRef: BRIDGE_CANONICAL_REF, watermarkSha: null },
    ]);
    // Not an owner lever — the integrator's next publish (or the catch-up pin) clears it.
    expect(out.verdict.needsOwner).toBe(false);
    expect(out.verdict.detail).toMatch(/canonical ref absent/i);
    expect(out.errors.some((e) => e.includes(BRIDGE_CANONICAL_REF))).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it('canonical missing is NOT signalled when there is no egress target at all (nothing to freeze)', async () => {
    const { input } = bridgeInput(
      { upstreamWrite: false },
      { runGit: async () => ({ code: 1, stdout: '', stderr: '' }) },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('skipped');
    expect(out.verdict.action).toBe('clear');
  });

  it('no github remote at all → skipped pass, watermark untouched', async () => {
    const { input } = bridgeInput({ githubRemote: undefined, lastAdmitted: HEAD_A });
    const out = await runGithubBridgeTick(input);
    expect(out).toMatchObject({ ran: false, skipped: 'no_github_remote', lastAdmitted: HEAD_A });
  });

  it('admitted ingressed head advances the watermark; blocked head does NOT and escalates needs_owner', async () => {
    const updated = [{ branch: 'main', from: null, to: HEAD_A, forced: false }];
    // admitted:
    let { input } = bridgeInput({}, { ingress: async () => cleanIngress({ updated, upToDate: [] }) });
    let out = await runGithubBridgeTick(input);
    expect(out.lastAdmitted).toBe(HEAD_A);
    expect(out.admissions).toEqual([{ head: HEAD_A, admit: true, basis: 'clean' }]);
    // blocked:
    ({ input } = bridgeInput(
      {},
      {
        ingress: async () => cleanIngress({ updated, upToDate: [] }),
        admit: async () => ({
          ...admitClean(),
          admit: false,
          basis: 'blocked',
          blockedAuthors: [{ githubUserId: 7, commits: [HEAD_A] }],
        }),
      },
    ));
    out = await runGithubBridgeTick(input);
    expect(out.lastAdmitted).toBeNull();
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(true);
  });

  it('egress rejectedNonFF + ingress nonFF fold into the recorded divergence verdict', async () => {
    const { input, recorded } = bridgeInput(
      {},
      {
        ingress: async () =>
          cleanIngress({ nonFF: [{ branch: 'main', local: 'l'.repeat(40), remote: 'r'.repeat(40) }], upToDate: [] }),
        egress: async () =>
          cleanEgress({
            pushed: [],
            rejectedNonFF: [
              {
                remoteRef: BRIDGE_REMOTE_STAGING_REF,
                remoteSha: 'x'.repeat(40),
                localSha: CANONICAL,
                reason: 'diverged',
              },
            ],
          }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(true); // the ingress rewrite is the owner lever
    expect(recorded[0].signals.map((s) => s.kind).sort()).toEqual(['egress-non-ff', 'ingress-non-ff']);
  });

  it('isBridgeWriter=false skips the pass (D-002 affinity seam)', async () => {
    const { input, egressCalls } = bridgeInput({}, { isBridgeWriter: async () => false });
    const out = await runGithubBridgeTick(input);
    expect(out).toMatchObject({ ran: false, skipped: 'not_bridge_writer' });
    // A deliberate "no" is a clean skip — nothing is reported as an error.
    expect(out.errors).toEqual([]);
    expect(egressCalls).toHaveLength(0);
  });

  // WI-10002587: a seam FAILURE is an unknown answer, not a "no". It must stay
  // distinguishable from `false`: record the error and PROCEED, because egress is
  // FF-only + CAS and github-egress enforces the hive-effect authority itself.
  it('isBridgeWriter throwing records the error and PROCEEDS — distinguishable from false', async () => {
    const { input, egressCalls } = bridgeInput(
      {},
      {
        isBridgeWriter: async () => {
          throw new Error('lease table unreachable');
        },
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.skipped).toBeUndefined();
    expect(out.ran).toBe(true);
    expect(out.errors).toEqual([expect.stringMatching(/^isBridgeWriter seam failed \(proceeding.*lease table unreachable$/)]);
    expect(egressCalls).toHaveLength(1);
  });

  it('isBridgeWriter=true runs the pass with no seam error', async () => {
    const { input, egressCalls } = bridgeInput({}, { isBridgeWriter: async () => true });
    const out = await runGithubBridgeTick(input);
    expect(out.skipped).toBeUndefined();
    expect(out.errors.filter((e) => e.includes('isBridgeWriter'))).toEqual([]);
    expect(egressCalls).toHaveLength(1);
  });
});

describe('runGithubBridgeTick — EI-18751829787526583: a stale-but-PRESENT canonical must not read green', () => {
  const WATERMARK = 'e'.repeat(40);

  /** merge-base --is-ancestor CANONICAL WATERMARK → 0 (ancestor); rev-list --count → N. */
  const staleGit = (behindCount: number) => async (args: string[]) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${CANONICAL}\n`, stderr: '' };
    if (args[0] === 'merge-base') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-list') return { code: 0, stdout: `${behindCount}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  it('canonical behind the accepted watermark → escalate + egress-canonical-stale, still egresses (publishes the stale content)', async () => {
    const { input, recorded, egressCalls } = bridgeInput({ expectedCanonicalSha: WATERMARK }, { runGit: staleGit(21) });
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(false); // self-heals via the catch-up pin / next integrator publish
    expect(out.verdict.signals).toContainEqual({
      kind: 'egress-canonical-stale',
      canonicalSha: CANONICAL,
      expectedSha: WATERMARK,
      behindCount: 21,
    });
    expect(out.verdict.detail).toMatch(/STALE/);
    expect(out.errors.some((e) => e.includes('STALE'))).toBe(true);
    // egress still runs — it publishes exactly what canonical holds today.
    expect(egressCalls).toHaveLength(1);
    expect(recorded.at(-1)?.action).toBe('escalate');
  });

  it('canonical already equal to the watermark → no signal (the healthy case)', async () => {
    const { input } = bridgeInput({ expectedCanonicalSha: CANONICAL });
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.signals.map((s) => s.kind)).not.toContain('egress-canonical-stale');
  });

  it('no expectedCanonicalSha given → staleness detection is skipped entirely (back-compat)', async () => {
    const { input } = bridgeInput();
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.signals.map((s) => s.kind)).not.toContain('egress-canonical-stale');
  });

  it('passes the stored scan cursor into egress and returns the next cursor', async () => {
    const previousCursor = {
      version: 1 as const,
      policyFingerprint: 'a'.repeat(64),
      baseSha: HEAD_A,
      targetSha: CANONICAL,
      lastScannedCommitSha: HEAD_A,
    };
    const nextCursor = { ...previousCursor, lastScannedCommitSha: CANONICAL };
    const captured: unknown[] = [];
    const { input } = bridgeInput(
      { egressScanProgress: previousCursor },
      {
        egress: async (egressInput) => {
          captured.push(egressInput);
          return cleanEgress({ scanProgress: nextCursor });
        },
      },
    );

    const out = await runGithubBridgeTick(input);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ scanProgress: previousCursor });
    expect(out.egressScanProgress).toEqual(nextCursor);
  });

  it('canonical DIVERGED (not an ancestor) from the watermark → not flagged stale (a different problem)', async () => {
    const { input } = bridgeInput(
      { expectedCanonicalSha: WATERMARK },
      {
        runGit: async (args) => {
          if (args[0] === 'rev-parse') return { code: 0, stdout: `${CANONICAL}\n`, stderr: '' };
          if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'not an ancestor' };
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.signals.map((s) => s.kind)).not.toContain('egress-canonical-stale');
  });
});
