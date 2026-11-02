/**
 * WI-6282 — the GitHub-bridge leg's WI-3500 catch-up pin must not run git in a
 * store directory that does not exist yet.
 *
 * LIVE-REPRODUCED on the P-302 rig 2026-07-27: a cold joiner's first git-sync tick
 * logged `bare canonical catch-up pin failed: Error: spawn git ENOENT`. That string
 * occurred exactly once in a 30k-line log — on the first tick after the store was
 * deliberately removed, never on a warm tick.
 *
 * The trap is the ERROR TEXT, not just the failure: `hiveGitRepoPath()` only computes
 * a path (unlike `ensurePotGitRepo`, which creates), and this leg runs BEFORE the
 * bootstrap leg that does. Node reports a missing CWD as ENOENT *on the binary*, so
 * the message reads "git is not installed" — sending whoever debugs a failed join
 * after entirely the wrong thing. The cold path is the new-joiner path, so this is
 * the first message a fresh device can emit.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loadHarnessRegistryMock = vi.hoisted(() => vi.fn());
const hiveGitRepoPathMock = vi.hoisted(() => vi.fn());
const pathExistsMock = vi.hoisted(() => vi.fn());
const defaultRunGitMock = vi.hoisted(() => vi.fn());
const runGithubBridgeTickMock = vi.hoisted(() => vi.fn());
const loadHiveEffectAuthorityMock = vi.hoisted(() => vi.fn());
const emitGitSyncEgressedEventMock = vi.hoisted(() => vi.fn());
/** The routines row the leg reads its watermarks from. A non-null `wb_sha` is what
 *  arms the catch-up pin at all — without it the pin is skipped for an unrelated
 *  reason and the test would pass vacuously. */
const sqlMock = vi.hoisted(() => Object.assign(vi.fn(), { unsafe: vi.fn() }));

vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: loadHarnessRegistryMock,
}));
// The bridge leg now resolves the signed protocol scope before reading its
// routine watermarks. Keep this focused fixture hermetic and give that real
// resolver the same stable hive identity used by the broader action suite.
vi.mock('../../hive-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHiveBySlug: vi.fn(async () => ({ pubkeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })),
}));
// Partial: unrelated modules pulled in transitively (locks/configure.ts) call other
// db-org exports at import time, and vitest throws on ANY access to a missing mock key.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: sqlMock, unsafe: vi.fn() }),
}));
vi.mock('../../sync/pot-git/storage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hiveGitRepoPath: hiveGitRepoPathMock,
  pathExists: pathExistsMock,
  defaultRunGit: defaultRunGitMock,
}));
vi.mock('../../sync/pot-git/github-bridge-tick', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runGithubBridgeTick: runGithubBridgeTickMock,
}));
// WI-10006624: the owning-hive key decides whether this member bridges GitHub at all.
vi.mock('../../sync/pot-git/hive-effect-authority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHiveEffectAuthority: loadHiveEffectAuthorityMock,
}));
// An OWNER key makes the leg resolve its serving actor; keep that hermetic and fast
// (the real path boots a harness and waits 30s before giving up).
vi.mock('../../sync/hyperbee/boot-all', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBootedHarness: () => undefined,
  bootSingleHarness: async () => {
    throw new Error('unit test: no harness boot');
  },
}));
vi.mock('../../sync/hyperbee/substrate-booted-handles-pg', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPgGitServingCapability: async () => {
    throw new Error('unit test: no advertised serving');
  },
}));
vi.mock('./git-sync-events', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitGitSyncEgressedEvent: emitGitSyncEgressedEventMock,
}));

import {
  githubBridgeErrorTransitionLine,
  refreshRemoteTrackingRefFromProvenTip,
  resolveGithubCredentialHelper,
  runGithubBridgeLeg,
  recoverEmptyCanonicalRef,
} from './git-sync-action';
import { BRIDGE_CANONICAL_REF, GITHUB_CREDENTIAL_HELPER_KEY } from '../../sync/pot-git/github-bridge-tick';
import { hiveEffectFixture } from '../../sync/pot-git/hive-effect-authority.fixture';

const SLUG = 'shop-hive';
const WS = 'ws-1';
const BARE = '/repos/shop-hive/shop-hive.git';

/** Did the leg spawn git against the bare store? That — not the log text — is the
 *  behaviour under test: on a cold device the spawn itself is what dies. */
const gitRanAgainstStore = () =>
  defaultRunGitMock.mock.calls.some((c) => c[1] === BARE);

describe('EI-27658326760198862 — malformed loose canonical ref (real Git)', () => {
  it.each(['recover', 'no-owner', 'held-lock', 'packed-ahead', 'nonempty'] as const)(
    'repairs only an authorized empty shadow while retaining Git locks and packed ancestry: %s', async mode => {
    const { defaultRunGit: realGit } = await vi.importActual<typeof import('../../sync/pot-git/storage')>(
      '../../sync/pot-git/storage',
    );
    const root = await mkdtemp(join(tmpdir(), 'bridge-broken-canonical-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const git = async (...args: string[]) => {
      const result = await realGit(args, root);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      await git('init', '-q', '-b', 'staging');
      await git('-c', 'user.name=Bridge test', '-c', 'user.email=bridge@example.test',
        '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'accepted');
      const accepted = await git('rev-parse', 'HEAD');
      let packed = accepted;
      if (mode === 'packed-ahead') {
        await git('-c', 'user.name=Bridge test', '-c', 'user.email=bridge@example.test',
          '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'newer canonical');
        packed = await git('rev-parse', 'HEAD');
      }
      await git('update-ref', BRIDGE_CANONICAL_REF, packed);
      await git('pack-refs', '--all');
      await mkdir(join(root, '.git/refs/hive'), { recursive: true });
      await writeFile(join(root, '.git', BRIDGE_CANONICAL_REF), '');
      const broken = await realGit(['rev-parse', '--verify', '--quiet', BRIDGE_CANONICAL_REF], root);
      expect(broken.code).not.toBe(0);
      expect(broken.stderr).toContain('broken ref');
      const normalPin = await realGit(['update-ref', BRIDGE_CANONICAL_REF, accepted], root);
      expect(normalPin.code).not.toBe(0);
      const refPath = join(root, '.git', BRIDGE_CANONICAL_REF);
      if (mode === 'held-lock') await writeFile(`${refPath}.lock`, 'peer');
      if (mode === 'nonempty') await writeFile(refPath, 'malformed-but-not-empty\n');
      const recovered = await recoverEmptyCanonicalRef({
        ...hiveEffectFixture(), ...(mode === 'no-owner' ? { authority: null } : {}),
        repoPath: join(root, '.git'), acceptedSha: accepted, runGit: realGit,
      });
      if (mode === 'recover') {
        expect(recovered).toEqual({ recovered: true });
        expect(await git('rev-parse', '--verify', BRIDGE_CANONICAL_REF)).toBe(accepted);
      } else {
        expect(recovered.recovered).toBe(false);
        expect(await readFile(refPath, 'utf8')).toBe(mode === 'nonempty' ? 'malformed-but-not-empty\n' : '');
        if (mode === 'held-lock') expect(await readFile(`${refPath}.lock`, 'utf8')).toBe('peer');
        else await expect(readFile(`${refPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  loadHarnessRegistryMock.mockResolvedValue({
    projects: [{ slug: SLUG, hive_slug: SLUG, self_repo: true }],
  });
  hiveGitRepoPathMock.mockReturnValue(BARE);
  // wb_sha present ⇒ the pin is armed. prev_egress_head/last_admitted are irrelevant here.
  sqlMock.mockResolvedValue([{ la: null, wb_sha: 'a'.repeat(40), prev_egress_head: null }]);
  sqlMock.unsafe.mockReset();
  emitGitSyncEgressedEventMock.mockReset();
  defaultRunGitMock.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  // Default: this device does NOT hold the owning hive key (a p2p joiner).
  loadHiveEffectAuthorityMock.mockResolvedValue(null);
});

describe('runGithubBridgeLeg — WI-6282 cold-store catch-up pin', () => {
  it('does NOT spawn git when the bare store does not exist yet (the cold-joiner case)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(false); // cold device: nothing created it yet
      await expect(runGithubBridgeLeg(SLUG, WS)).resolves.toBeUndefined();
      expect(gitRanAgainstStore()).toBe(false);
      // and specifically never the two pin commands
      const argv0s = defaultRunGitMock.mock.calls.map((c) => (c[0] as string[])[0]);
      expect(argv0s).not.toContain('rev-parse');
      expect(argv0s).not.toContain('update-ref');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('DOES pin on a warm store — the guard skips the cold case only, it does not disable the pin', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(true);
      // rev-parse non-zero = canonical ref absent = the pin has work to do.
      defaultRunGitMock.mockImplementation(async (args: string[]) =>
        (args[0] === 'rev-parse' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      );
      await runGithubBridgeLeg(SLUG, WS);
      const argv0s = defaultRunGitMock.mock.calls.map((c) => (c[0] as string[])[0]);
      expect(argv0s).toContain('rev-parse');
      expect(argv0s).toContain('update-ref');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('names the PATH when a warm-store pin genuinely fails (the original message had none)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(true);
      defaultRunGitMock.mockImplementation(async (args: string[]) =>
        args[0] === 'rev-parse'
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: 'some git failure' },
      );
      await runGithubBridgeLeg(SLUG, WS);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('catch-up pin failed'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(BARE));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('runGithubBridgeLeg — EI-18751829787526583: a STALE-but-present canonical ref must also re-pin', () => {
  const WATERMARK = 'a'.repeat(40);
  const STALE = 'b'.repeat(40);

  it('canonical exists but is a strict ancestor of the watermark → re-pins CAS\'d against the stale sha', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(true);
      sqlMock.mockResolvedValue([{ la: null, wb_sha: WATERMARK, prev_egress_head: null }]);
      defaultRunGitMock.mockImplementation(async (args: string[]) => {
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${STALE}\n`, stderr: '' };
        if (args[0] === 'merge-base') return { code: 0, stdout: '', stderr: '' }; // STALE IS an ancestor of WATERMARK
        return { code: 0, stdout: '', stderr: '' };
      });
      await runGithubBridgeLeg(SLUG, WS);
      const calls = defaultRunGitMock.mock.calls.map((c) => c[0] as string[]);
      expect(calls).toContainEqual(['merge-base', '--is-ancestor', STALE, WATERMARK]);
      expect(calls).toContainEqual(['update-ref', BRIDGE_CANONICAL_REF, WATERMARK, STALE]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('was STALE'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('canonical DIVERGED from the watermark (not an ancestor) → never re-pinned (not this guard\'s problem)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(true);
      sqlMock.mockResolvedValue([{ la: null, wb_sha: WATERMARK, prev_egress_head: null }]);
      defaultRunGitMock.mockImplementation(async (args: string[]) => {
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${STALE}\n`, stderr: '' };
        if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'not an ancestor' };
        return { code: 0, stdout: '', stderr: '' };
      });
      await runGithubBridgeLeg(SLUG, WS);
      const calls = defaultRunGitMock.mock.calls.map((c) => c[0] as string[]);
      expect(calls).not.toContainEqual(['update-ref', BRIDGE_CANONICAL_REF, WATERMARK, STALE]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('canonical already equals the watermark → no merge-base call at all (the healthy case)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(true);
      sqlMock.mockResolvedValue([{ la: null, wb_sha: WATERMARK, prev_egress_head: null }]);
      defaultRunGitMock.mockImplementation(async (args: string[]) =>
        args[0] === 'rev-parse' ? { code: 0, stdout: `${WATERMARK}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' },
      );
      await runGithubBridgeLeg(SLUG, WS);
      const argv0s = defaultRunGitMock.mock.calls.map((c) => (c[0] as string[])[0]);
      expect(argv0s).not.toContain('merge-base');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('runGithubBridgeLeg — owner-actionable egress failures', () => {
  it('promotes a non-transient bridge rejection into top-level routine failure metadata', async () => {
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [
        {
          slug: SLUG,
          hive_slug: SLUG,
          self_repo: true,
          github_remote: 'https://github.com/acme/shop.git',
          // A fork avoids the live upstream permission probe; the bridge tick is mocked below.
          fork_remote: 'https://github.com/me/shop.git',
        },
      ],
    });
    pathExistsMock.mockResolvedValue(false);
    runGithubBridgeTickMock.mockResolvedValue({
      ran: true,
      egressTarget: 'fork',
      ingressed: { updated: 0, upToDate: 1, nonFF: 0, absent: 0 },
      admissions: [],
      lastAdmitted: null,
      egress: { pushed: 0, upToDate: 0, rejectedNonFF: 0, blockedSecrets: 0 },
      egressHead: null,
      verdict: {
        action: 'escalate',
        needsOwner: true,
        signals: [{ kind: 'bridge-egress-unreachable', errors: ['workflow scope missing'], transient: false }],
        detail:
          'github-bridge divergence: GitHub rejected the staging push because the OAuth App lacks workflow scope; ' +
          'fix the remote account/credential or destination before expecting off-box progress.',
      },
      errors: ['egress: push refs/heads/staging: GitHub rejected the workflow file: workflow scope missing'],
    });

    // WI-10006470: a streak's first error tick is journaled too (prev errors: none).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runGithubBridgeLeg(SLUG, WS);
      expect(warnSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringContaining(`[github-bridge] ${SLUG}: tick errors (divergence=escalate): egress: push`),
      );
    } finally {
      warnSpy.mockRestore();
    }

    const [, params] = sqlMock.unsafe.mock.calls.at(-1) as [string, unknown[]];
    const metadata = JSON.parse(params[2] as string) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      last_status: 'error',
      last_error: expect.stringContaining('workflow scope'),
      last_errors: ['egress: push refs/heads/staging: GitHub rejected the workflow file: workflow scope missing'],
      github_bridge: expect.objectContaining({
        divergence: 'escalate',
        needs_owner: true,
        errors: ['egress: push refs/heads/staging: GitHub rejected the workflow file: workflow scope missing'],
      }),
    });
    expect(metadata.last_error).toEqual(expect.stringContaining('fix the remote account/credential'));
    // The bridge patch is applied after recordOutcome. It must not overwrite the
    // local stage evidence that the watchdog uses to distinguish an egress-only
    // failure from a commit strand (EI-20315742298217655).
    expect(metadata).not.toHaveProperty('local_sync_status');
    expect(metadata).not.toHaveProperty('local_sync_head_sha');
    expect(emitGitSyncEgressedEventMock).not.toHaveBeenCalled();
  });
});

describe('GitHub credential-helper handoff', () => {
  it('resolves the last non-empty checkout-local helper', async () => {
    defaultRunGitMock.mockResolvedValue({
      code: 0,
      stdout: `\n!/tmp/old-helper.sh\n\n!/tmp/gh-credential-aviynw.sh\n`,
      stderr: '',
    });

    await expect(resolveGithubCredentialHelper('/clones/oddsmith')).resolves.toBe('!/tmp/gh-credential-aviynw.sh');
    expect(defaultRunGitMock).toHaveBeenCalledWith(
      ['config', '--local', '--get-all', GITHUB_CREDENTIAL_HELPER_KEY],
      '/clones/oddsmith',
    );
  });

  it('passes the registered checkout helper into the bare-store bridge tick', async () => {
    const helper = '!/tmp/gh-credential-aviynw.sh';
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [
        {
          slug: SLUG,
          path: '/clones/oddsmith',
          hive_slug: SLUG,
          self_repo: true,
          github_remote: 'https://github.com/aviynw/oddsmith.git',
          fork_remote: 'https://github.com/aviynw/oddsmith.git',
        },
      ],
    });
    pathExistsMock.mockResolvedValue(false);
    defaultRunGitMock.mockImplementation(async (args: string[]) =>
      args[0] === 'config'
        ? { code: 0, stdout: `${helper}\n`, stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    runGithubBridgeTickMock.mockResolvedValue({
      ran: true,
      egressTarget: 'fork',
      ingressed: { updated: 0, upToDate: 1, nonFF: 0, absent: 0 },
      admissions: [],
      lastAdmitted: null,
      egress: { pushed: 0, upToDate: 1, rejectedNonFF: 0, blockedSecrets: 0 },
      egressHead: null,
      verdict: { action: 'clear', needsOwner: false, signals: [], detail: '' },
      errors: [],
    });

    await runGithubBridgeLeg(SLUG, WS);

    expect(runGithubBridgeTickMock).toHaveBeenCalledWith(
      expect.objectContaining({
        githubCredentialHelper: helper,
        repoKey: 'gh-aviynw--oddsmith',
      }),
    );
  });
});

/**
 * WI-10006624 / D-022 — only the OWNING hive bridges GitHub.
 *
 * LIVE-OBSERVED on c1006k (2026-10-06): a cold p2p joiner (no owning hive key) ran the
 * bridge's GitHub ingress every tick. The service user had no git credential, so ingress
 * failed for every branch, and three sweeps later git-sync-stall-watchdog raised a
 * persistent FAULT ALARM on a joiner whose p2p sync was healthy. Its egress was already
 * refused by the hive-effect authority, so ingress there fed nothing it may act on.
 * The integrator leg already declines `not_hive_owner`; the bridge must match.
 */
describe('runGithubBridgeLeg — WI-10006624 non-owner members do not bridge GitHub', () => {
  const bridgedRegistry = {
    projects: [
      {
        slug: SLUG,
        path: '/clones/hello',
        hive_slug: SLUG,
        self_repo: true,
        github_remote: 'https://github.com/acme/hello.git',
      },
    ],
  };
  const clearOutcome = {
    ran: false,
    egressTarget: 'skipped',
    ingressed: { updated: 0, upToDate: 0, nonFF: 0, absent: 0 },
    admissions: [],
    lastAdmitted: null,
    egress: null,
    egressHead: null,
    verdict: { action: 'clear', needsOwner: false, signals: [], detail: '' },
    errors: [],
  };
  const writerSeam = async (): Promise<boolean | undefined> => {
    expect(runGithubBridgeTickMock).toHaveBeenCalledOnce();
    const input = runGithubBridgeTickMock.mock.calls[0]![0] as {
      deps?: { isBridgeWriter?: () => Promise<boolean> };
    };
    return input.deps?.isBridgeWriter?.();
  };

  it('a member WITHOUT the owning hive key answers the writer seam false (the tick then skips not_bridge_writer)', async () => {
    loadHarnessRegistryMock.mockResolvedValue(bridgedRegistry);
    pathExistsMock.mockResolvedValue(false);
    loadHiveEffectAuthorityMock.mockResolvedValue(null);
    runGithubBridgeTickMock.mockResolvedValue({ ...clearOutcome, skipped: 'not_bridge_writer' });

    await runGithubBridgeLeg(SLUG, WS);

    // A missing seam (undefined) would default to "writer" inside the tick — the bug.
    expect(await writerSeam()).toBe(false);
  });

  it('the OWNING member answers the writer seam true — the guard narrows to non-owners, it does not disable the bridge', async () => {
    loadHarnessRegistryMock.mockResolvedValue(bridgedRegistry);
    pathExistsMock.mockResolvedValue(false);
    loadHiveEffectAuthorityMock.mockResolvedValue({
      hive_id: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      sign: async () => Buffer.alloc(64),
    });
    runGithubBridgeTickMock.mockResolvedValue(clearOutcome);
    // No serving actor in a unit test: the leg says so and continues (effectAuthority null).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runGithubBridgeLeg(SLUG, WS);

    // Keyed on the owning KEY, not on the serving actor: an owner whose actor is
    // missing still bridges and REPORTS the refusal instead of silently skipping.
    expect(await writerSeam()).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('serving unavailable'))).toBe(true);
    warn.mockRestore();
  });
});

describe('runGithubBridgeLeg — EI-20331175777179195 truthful egress event', () => {
  const EGRESS_HEAD = 'e'.repeat(40);
  const PREVIOUS_EGRESS_HEAD = 'b'.repeat(40);
  const INCLUDED_ANCESTOR = 'c'.repeat(40);

  const healthyOutcome = (egressHead: string | null) => ({
    ran: true,
    egressTarget: 'upstream' as const,
    ingressed: { updated: 0, upToDate: 1, nonFF: 0, absent: 0 },
    admissions: [],
    lastAdmitted: null,
    egress: { pushed: egressHead ? 1 : 0, upToDate: 0, rejectedNonFF: 0, blockedSecrets: 0 },
    egressHead,
    verdict: { action: 'clear' as const, needsOwner: false, signals: [], detail: '' },
    errors: [],
  });

  it('refreshes origin/staging with an explicit refspec from proven upstream egress, never FETCH_HEAD or a merge', async () => {
    const checkout = '/clones/shop';
    const proven = EGRESS_HEAD;
    const calls: string[][] = [];
    defaultRunGitMock.mockImplementation(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${proven}\n`, stderr: '' };
      if (args[0] === 'merge-base') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    await expect(
      refreshRemoteTrackingRefFromProvenTip(checkout, proven, { runGit: defaultRunGitMock }),
    ).resolves.toMatchObject({
      refreshed: true,
      trackingRef: 'refs/remotes/origin/staging',
      observedSha: proven,
    });
    expect(calls).toContainEqual([
      'fetch',
      '--no-tags',
      'origin',
      'refs/heads/staging:refs/remotes/origin/staging',
    ]);
    expect(calls.some((args) => args[0] === 'merge')).toBe(false);
    expect(calls.some((args) => args.includes('FETCH_HEAD'))).toBe(false);
  });

  it('does not bless a remote tip that no longer contains the bridge proof', async () => {
    const calls: string[][] = [];
    defaultRunGitMock.mockImplementation(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' };
      if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'not contained' };
      return { code: 0, stdout: '', stderr: '' };
    });

    await expect(
      refreshRemoteTrackingRefFromProvenTip('/clones/shop', EGRESS_HEAD, { runGit: defaultRunGitMock }),
    ).resolves.toMatchObject({ refreshed: false, observedSha: 'f'.repeat(40) });
    expect(calls).toContainEqual([
      'fetch',
      '--no-tags',
      'origin',
      'refs/heads/staging:refs/remotes/origin/staging',
    ]);
  });

  it('refreshes only the upstream target; fork egress does not masquerade as origin/staging', async () => {
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: SLUG, path: '/clones/shop', hive_slug: SLUG, self_repo: true, github_remote: 'https://github.com/acme/shop.git', fork_remote: 'https://github.com/me/shop.git' }],
    });
    pathExistsMock.mockResolvedValue(false);
    runGithubBridgeTickMock.mockResolvedValue({ ...healthyOutcome(EGRESS_HEAD), egressTarget: 'fork' });

    await runGithubBridgeLeg(SLUG, WS);

    expect(defaultRunGitMock.mock.calls.map((c) => c[0] as string[])).not.toContainEqual([
      'fetch',
      '--no-tags',
      'origin',
      'refs/heads/staging:refs/remotes/origin/staging',
    ]);
  });

  it('uses the ticking workspace registry so a mismatched ambient registry cannot skip the metadata refresh', async () => {
    loadHarnessRegistryMock.mockImplementation(async (workspaceId?: string) => ({
      projects:
        workspaceId === WS
          ? [{ slug: SLUG, hive_slug: SLUG, self_repo: true, github_remote: 'https://github.com/acme/shop.git', fork_remote: 'https://github.com/me/shop.git' }]
          : [],
    }));
    pathExistsMock.mockResolvedValue(false);
    runGithubBridgeTickMock.mockResolvedValue(healthyOutcome(EGRESS_HEAD));

    await runGithubBridgeLeg(SLUG, WS);

    expect(loadHarnessRegistryMock).toHaveBeenCalledWith(WS);
    expect(runGithubBridgeTickMock).toHaveBeenCalledOnce();
    expect(emitGitSyncEgressedEventMock).toHaveBeenCalledWith(EGRESS_HEAD, {
      scope: { installSlug: SLUG, workspaceId: WS },
    });
  });

  it('includes newly egressed ancestors in precise event signaling', async () => {
    pathExistsMock.mockResolvedValue(false);
    sqlMock.mockResolvedValue([{ la: null, wb_sha: 'a'.repeat(40), prev_egress_head: PREVIOUS_EGRESS_HEAD }]);
    runGithubBridgeTickMock.mockResolvedValue(healthyOutcome(EGRESS_HEAD));
    defaultRunGitMock.mockImplementation(async (args: string[]) =>
      args[0] === 'rev-list'
        ? { code: 0, stdout: `${EGRESS_HEAD}\n${INCLUDED_ANCESTOR}\n`, stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );

    await runGithubBridgeLeg(SLUG, WS);

    expect(defaultRunGitMock).toHaveBeenCalledWith(
      ['rev-list', '--topo-order', `${PREVIOUS_EGRESS_HEAD}..${EGRESS_HEAD}`],
      BARE,
    );
    expect(emitGitSyncEgressedEventMock).toHaveBeenCalledWith(
      EGRESS_HEAD,
      { scope: { installSlug: SLUG, workspaceId: WS } },
      { includedShas: [EGRESS_HEAD, INCLUDED_ANCESTOR] },
    );
  });

  it('emits only after the writer-backed metadata watermark is persisted', async () => {
    const order: string[] = [];
    pathExistsMock.mockResolvedValue(false);
    runGithubBridgeTickMock.mockResolvedValue(healthyOutcome(EGRESS_HEAD));
    sqlMock.unsafe.mockImplementation(async () => {
      order.push('metadata');
    });
    emitGitSyncEgressedEventMock.mockImplementation(() => {
      order.push('event');
    });

    await runGithubBridgeLeg(SLUG, WS);

    expect(emitGitSyncEgressedEventMock).toHaveBeenCalledOnce();
    expect(emitGitSyncEgressedEventMock).toHaveBeenCalledWith(EGRESS_HEAD, {
      scope: { installSlug: SLUG, workspaceId: WS },
    });
    expect(order.slice(-2)).toEqual(['metadata', 'event']);
  });

  it('does not emit when the bridge has no successful remote staging proof', async () => {
    pathExistsMock.mockResolvedValue(false);
    runGithubBridgeTickMock.mockResolvedValue(healthyOutcome(null));

    await runGithubBridgeLeg(SLUG, WS);

    expect(emitGitSyncEgressedEventMock).not.toHaveBeenCalled();
  });
});

/**
 * WI-10006470 — `github_bridge.errors` is replaced wholesale every tick, so once an
 * error streak cleared its cause was gone (hello-world-3-pot 2026-10-06: a 3-sweep
 * "remote could not be contacted" fault, undiagnosable after the next clean tick).
 * The leg must journal a streak's START/CHANGE and its CLEARING, and stay quiet on
 * an identical repeat and on clean-after-clean.
 */
describe('runGithubBridgeLeg — WI-10006470 bridge error transitions are journaled', () => {
  const UNREACHABLE = 'ingress main: fatal: unable to access https://github.com/acme/shop.git/: Could not resolve host';
  const outcome = (errors: string[]) => ({
    ran: true,
    egressTarget: 'fork' as const,
    ingressed: { updated: 0, upToDate: errors.length ? 0 : 1, nonFF: 0, absent: 0 },
    admissions: [],
    lastAdmitted: null,
    egress: { pushed: 0, upToDate: 0, rejectedNonFF: 0, blockedSecrets: 0 },
    egressHead: null,
    verdict: errors.length
      ? { action: 'escalate' as const, needsOwner: false, signals: [], detail: '' }
      : { action: 'clear' as const, needsOwner: false, signals: [], detail: '' },
    errors,
  });
  const bridgeLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((line: string) => line.startsWith(`[github-bridge] ${SLUG}:`));

  const runWith = async (prevErrors: unknown, errors: string[]) => {
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [
        {
          slug: SLUG,
          hive_slug: SLUG,
          self_repo: true,
          github_remote: 'https://github.com/acme/shop.git',
          // A fork avoids the live upstream permission probe; the bridge tick is mocked.
          fork_remote: 'https://github.com/me/shop.git',
        },
      ],
    });
    pathExistsMock.mockResolvedValue(false);
    sqlMock.mockResolvedValue([{ la: null, wb_sha: null, prev_egress_head: null, prev_errors: prevErrors }]);
    runGithubBridgeTickMock.mockResolvedValue(outcome(errors));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runGithubBridgeLeg(SLUG, WS);
      return bridgeLines(warnSpy);
    } finally {
      warnSpy.mockRestore();
    }
  };

  it('journals the cause when a streak STARTS (clean → errors)', async () => {
    const lines = await runWith([], [UNREACHABLE]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tick errors (divergence=escalate)');
    expect(lines[0]).toContain('Could not resolve host');
  });

  it('stays quiet on an identical repeat tick (already journaled)', async () => {
    expect(await runWith([UNREACHABLE], [UNREACHABLE])).toEqual([]);
  });

  it('journals again when the errors CHANGE mid-streak', async () => {
    const lines = await runWith([UNREACHABLE], ['ingress main: remote: Repository not found.']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Repository not found');
  });

  it('journals the CLEARING with the previous cause, so a recovered streak stays diagnosable', async () => {
    const lines = await runWith([UNREACHABLE], []);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tick errors cleared');
    expect(lines[0]).toContain('Could not resolve host');
  });

  it('stays quiet on a clean tick after a clean tick', async () => {
    expect(await runWith([], [])).toEqual([]);
    expect(await runWith(null, [])).toEqual([]);
  });
});

describe('githubBridgeErrorTransitionLine (WI-10006470)', () => {
  it('treats a non-array persisted value as "no previous errors"', () => {
    expect(githubBridgeErrorTransitionLine('s', { not: 'an array' }, [], 'clear')).toBeNull();
    expect(githubBridgeErrorTransitionLine('s', 'boom', ['e1'], 'escalate')).toContain('tick errors');
  });

  it('compares on the persisted cap (first 10), so an 11+-error streak does not re-journal every tick', () => {
    const errors = Array.from({ length: 12 }, (_, i) => `e${i}`);
    expect(githubBridgeErrorTransitionLine('s', errors.slice(0, 10), errors, 'escalate')).toBeNull();
  });
});
