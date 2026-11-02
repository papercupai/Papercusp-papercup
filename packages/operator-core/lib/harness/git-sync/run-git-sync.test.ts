import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

// WI-6824: runGitSync's `log` sink defaults to console.warn. It used to default to a no-op,
// which is why an unrelated-history merge failure alarmed the fleet for ~10h while leaving
// ZERO trace in journald — and why this suite passed in silence despite driving the
// conflict/error/oversized/quarantine paths, all of which narrate. The narration is
// EXPECTED here, so capture it rather than letting vitest-fail-on-console reject it.
let gitSyncWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  gitSyncWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  gitSyncWarnSpy?.mockRestore();
  gitSyncWarnSpy = undefined;
});
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  existsSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  runGitSync,
  SOURCE_CUSTODY_REF_PREFIX,
  commitAttributedGroups,
  defaultRunToolCatalogGenerator,
  defaultRunGeneratedDeclarationsGenerator,
  defaultRunToolRoutingCheck,
  classifyProtectedPathExclusions,
  addFailureIgnoredPaths,
  addFailureStrayPaths,
  discoverSubmodulesRecursive,
  isIndexLockFailure,
  isConfigLockFailure,
  isPathspecBeyondSymbolicLinkFailure,
  isPathspecInSubmoduleFailure,
  inSubmoduleProtectedExclusions,
  isTransientStatFailure,
  preflightInvalidIndex,
  MIN_VALID_GIT_INDEX_BYTES,
  clearStaleIndexLock,
  clearStaleConfigLock,
  clearStaleMaintenanceLock,
  scavengeStaleTempPacks,
  STALE_INDEX_LOCK_MS,
  STALE_MAINTENANCE_LOCK_MS,
  STALE_TEMP_PACK_MS,
  GIT_SYNC_BOT_EMAIL,
  GIT_SYNC_BOT_NAME,
  affectsToolRouting,
  affectsGeneratedDeclarations,
  migrationDependencyFenceSkips,
  checkToolRoutingBeforeCommit,
  generatedDeclarationPair,
  expandGeneratedDeclarationPairHolds,
  guardStagedIndexBeforeCommit,
  DECLARATION_STATUS_MAX_RETRIES,
  regenerateGeneratedDeclarationsBeforeCommit,
  isDeclarationsGraphCandidate,
  defaultListDeclarationsGraphMembers,
  declarationCompileErrors,
  declarationCompileOffenders,
  regenerateToolCatalogBeforeCommit,
  expandAtomicLiveLockExclusions,
  expandCargoPackageLiveLockExclusions,
  expandNpmManifestClosure,
  summarizeFetchFailure,
  isNpmManifestPath,
  runGitBounded,
  censusStrandedSubmodules,
  DEPENDENCY_GENERATION_ROOT_RECORD,
  measureAttributedFileShare,
  type RunGit,
  type GitSyncStepRunner,
} from './run-git-sync';
import { isVerbatimCheckIgnorePath } from './check-ignore-argv';
import { dependencyGenerationRootRecord } from '../../release/dependency-generation-prebuild';
import type { AttributionRosterEntry, FileAttribution } from './git-sync-attribution';
import { resolveAttributionRepo } from './attribution-repo';
import { runGitLocal } from '../docs/git-runner';
import type { ContentDetector } from '../../content-lint/registry';
import type { RunGitStdin } from '../../sync/pot-git/storage';
import { emitGitSyncCommittedEvent } from './git-sync-events';
import { gitSyncScopePayloadFilter } from '../../agent-tools/events/git-sync-await-scope';
import { payloadMatchesFilter } from '../../events/await/pattern';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { requireHiveEffectAuthority } from '../../sync/pot-git/hive-effect-authority';
import { withFsMutex, withFsMutexRead } from '../../../../../scripts/lib/fs-mutex.mjs';
// @ts-expect-error -- buildless plain-JS module family, no declaration file.
import { installLockNameForRoot } from '../../../../../scripts/lib/install-lock-name.mjs';
import { acquireInstallBoundaryLease, type InstallBoundaryLease } from '../../install-boundary-lease';

/** A test content detector that quarantines any matched file whose text contains BROKEN. */
const brokenDetector: ContentDetector = {
  key: 'fake-broken',
  glob: '**/*.md',
  matches: (f) => f.endsWith('.md'),
  detect: (_f, text) => (text.includes('BROKEN') ? 'contains BROKEN' : null),
  fixerRole: 'content-fixer',
};

/** Run git synchronously for test setup; throws on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}
function configUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@papercusp.local');
  git(repo, 'config', 'user.name', 'git-sync test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

/**
 * Avoid the production spawner sidecar in this focused real-git regression.
 * Forwards `options.env` as an overlay, exactly like the production runners:
 * attributed commits bind a private GIT_INDEX_FILE through it (WI-10006705) and
 * refuse to run on a runner that drops it.
 */
const directRunGit: RunGit = async (args, cwd, options) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? result.error ?? ''),
  };
};

// The production sidecar is selected through the shared enable flag. Tests in
// this file create disposable repositories and must exercise the injected/local
// runner regardless of the host's inherited sidecar setting. Preserve an
// explicit caller override so the suite remains non-destructive to its process.
let savedGitSyncSidecarOverride: string | undefined;
beforeAll(() => {
  savedGitSyncSidecarOverride = process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR;
  process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = '0';
});
afterAll(() => {
  if (savedGitSyncSidecarOverride === undefined) delete process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR;
  else process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = savedGitSyncSidecarOverride;
  savedGitSyncSidecarOverride = undefined;
});

const REPO_ROOT = resolve(__dirname, '../../../../..');

describe('migrationDependencyFenceSkips (EI-24940157290396415)', () => {
  const refused = {
    scope: 'libs/sub',
    path: 'libs/db/sql/999-unreserved-migration.sql',
    reason: 'migration-reservation' as const,
    detail: 'reservation missing',
  };

  it('holds same-work-item root sources while allowing unrelated attributed work to advance', () => {
    const roster: AttributionRosterEntry[] = [
      {
        agent: 'su-migration',
        files: ['libs/sub/libs/db/sql/999-unreserved-migration.sql', 'schema-consumer.ts'],
        workItems: ['WI-migration'],
      },
      { agent: 'su-unrelated', files: ['root-unrelated.ts'], workItems: ['WI-other'] },
    ];

    expect(migrationDependencyFenceSkips([refused], ['schema-consumer.ts', 'root-unrelated.ts'], roster)).toEqual([
      {
        scope: 'superproject',
        path: 'schema-consumer.ts',
        reason: 'migration-dependency-fence',
        detail:
          'deferred because this path shares work-item attribution with a reservation-blocked migration at ' +
          'libs/sub/libs/db/sql/999-unreserved-migration.sql',
        // WI-10006493: structured provenance, so dev:pipeline_position can name the blocker.
        blockingMigrations: ['libs/sub/libs/db/sql/999-unreserved-migration.sql'],
        blockingAgents: ['su-migration'],
        blockingWorkItems: ['WI-migration'],
      },
    ]);
  });

  it('holds every dirty root source when the refused migration itself is unattributed', () => {
    const roster: AttributionRosterEntry[] = [
      { agent: 'su-other', files: ['schema-consumer.ts', 'root-unrelated.ts'], workItems: ['WI-other'] },
    ];

    expect(migrationDependencyFenceSkips([refused], ['schema-consumer.ts', 'root-unrelated.ts'], roster)).toEqual([
      {
        scope: 'superproject',
        path: 'schema-consumer.ts',
        reason: 'migration-dependency-fence',
        detail:
          'deferred because a reservation-blocked migration could not be attributed; holding this path until its dependency is known',
        blockingMigrations: ['libs/sub/libs/db/sql/999-unreserved-migration.sql'],
        blockingAgents: [],
        blockingWorkItems: [],
        unattributedMigrations: ['libs/sub/libs/db/sql/999-unreserved-migration.sql'],
      },
      {
        scope: 'superproject',
        path: 'root-unrelated.ts',
        reason: 'migration-dependency-fence',
        detail:
          'deferred because a reservation-blocked migration could not be attributed; holding this path until its dependency is known',
        blockingMigrations: ['libs/sub/libs/db/sql/999-unreserved-migration.sql'],
        blockingAgents: [],
        blockingWorkItems: [],
        unattributedMigrations: ['libs/sub/libs/db/sql/999-unreserved-migration.sql'],
      },
    ]);
  });

  // EI-25203408414398603: the edit ledger records a nested repo's edit relative to THAT repo with
  // repo=NULL ('libs/db/sql/NNNN-x.sql', never '<scope>/libs/db/sql/…'). Matching only the
  // scope-qualified form left every real child migration unattributed, which deferred EVERY dirty
  // superproject path — one stray migration froze the whole superproject for 30+ minutes.
  it('attributes a child migration recorded nested-repo-relative, the shape the edit ledger writes', () => {
    const roster: AttributionRosterEntry[] = [
      { agent: 'su-migration', files: ['libs/db/sql/999-unreserved-migration.sql'], workItems: [] },
      { agent: 'su-migration', files: ['schema-consumer.ts'], workItems: [] },
      { agent: 'su-unrelated', files: ['root-unrelated.ts'], workItems: ['WI-other'] },
    ];

    expect(migrationDependencyFenceSkips([refused], ['schema-consumer.ts', 'root-unrelated.ts'], roster)).toEqual([
      {
        scope: 'superproject',
        path: 'schema-consumer.ts',
        reason: 'migration-dependency-fence',
        detail:
          'deferred because this path is attributed to the same agent as a reservation-blocked migration at ' +
          'libs/sub/libs/db/sql/999-unreserved-migration.sql',
        blockingMigrations: ['libs/sub/libs/db/sql/999-unreserved-migration.sql'],
        blockingAgents: ['su-migration'],
        blockingWorkItems: [],
      },
    ]);
  });

  it('normalizes absolute roster paths against superRoot, like every other attribution caller', () => {
    const roster: AttributionRosterEntry[] = [
      {
        agent: 'su-migration',
        files: ['/repo/libs/sub/libs/db/sql/999-unreserved-migration.sql', '/repo/schema-consumer.ts'],
        workItems: ['WI-migration'],
      },
      { agent: 'su-unrelated', files: ['/repo/root-unrelated.ts'], workItems: ['WI-other'] },
    ];

    expect(
      migrationDependencyFenceSkips([refused], ['schema-consumer.ts', 'root-unrelated.ts'], roster, '/repo').map(
        (s) => s.path,
      ),
    ).toEqual(['schema-consumer.ts']);
    // Without superRoot the absolute entries cannot match, so the fence fails closed on everything.
    expect(
      migrationDependencyFenceSkips([refused], ['schema-consumer.ts', 'root-unrelated.ts'], roster).map((s) => s.path),
    ).toEqual(['schema-consumer.ts', 'root-unrelated.ts']);
  });
});

describe('EI-24827889655898454 git-sync TSX install boundary', () => {
  it('holds all three TSX generator launches behind install:safe and releases readers afterward', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'git-sync-install-boundary-repo-'));
    const lockRoot = mkdtempSync(join(tmpdir(), 'git-sync-install-boundary-locks-'));
    const savedLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockRoot;

    let releaseWriter = () => {};
    let signalWriterHeld = () => {};
    const writerHeld = new Promise<void>((resolve) => { signalWriterHeld = resolve; });
    const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const lockName = installLockNameForRoot(repoRoot);
    const writer = withFsMutex(lockName, async () => {
      signalWriterHeld();
      await writerRelease;
    }, { retryMs: 1 });

    try {
      await writerHeld;
      let signalReadersWaiting = () => {};
      const readersWaiting = new Promise<void>((resolve) => { signalReadersWaiting = resolve; });
      let waitingCount = 0;
      const acquire = (root: string) => acquireInstallBoundaryLease(root, {
        env: {},
        timeoutMs: 10_000,
        readLease: (name, fn, options) => withFsMutexRead(name, fn, {
          ...options,
          retryMs: 1,
          onWaiting: () => {
            waitingCount += 1;
            if (waitingCount === 3) signalReadersWaiting();
          },
        }),
      });
      let signalSpawnStarted = () => {};
      const spawnStarted = new Promise<void>((resolve) => { signalSpawnStarted = resolve; });
      const spawnChild = vi.fn(() => {
        signalSpawnStarted();
        const child = Object.assign(new EventEmitter(), {
          stdout: null,
          stderr: null,
          kill: vi.fn(),
        });
        queueMicrotask(() => child.emit('close', 0));
        return child as unknown as ChildProcess;
      }) as unknown as typeof spawn;
      const dependencies = { acquire, spawnChild };
      const running = [
        defaultRunToolCatalogGenerator(repoRoot, dependencies),
        defaultRunGeneratedDeclarationsGenerator(repoRoot, dependencies),
        defaultRunToolRoutingCheck(repoRoot, dependencies),
      ];
      const observed = await Promise.race([
        readersWaiting.then(() => 'waiting-on-writer'),
        spawnStarted.then(() => 'spawn-started'),
        Promise.all(running).then(() => 'finished'),
      ]);

      expect(observed).toBe('waiting-on-writer');
      expect(spawnChild).not.toHaveBeenCalled();
      releaseWriter();
      await writer;
      const results = await Promise.all(running);
      expect(results.map((result) => result.code)).toEqual([0, 0, 0]);
      expect(spawnChild).toHaveBeenCalledTimes(3);

      let installRan = false;
      await withFsMutex(lockName, async () => { installRan = true; }, { retryMs: 1 });
      expect(installRan).toBe(true);
    } finally {
      releaseWriter();
      await writer;
      if (savedLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = savedLockRoot;
      rmSync(lockRoot, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('refuses launch when the install boundary times out', async () => {
    const lease: InstallBoundaryLease = {
      outcome: 'timed-out',
      waitedMs: 10_000,
      lockName: 'npm-install-test',
      detail: 'install writer remains active',
      release: vi.fn(),
    };
    const spawnChild = vi.fn() as unknown as typeof spawn;

    const result = await defaultRunToolCatalogGenerator('/unused', {
      acquire: async () => lease,
      spawnChild,
    });
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('install:safe boundary was timed-out');
    expect(spawnChild).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });
});

describe('expandAtomicLiveLockExclusions — staggered edit-lock protection', () => {
  it('expands a lock without goal attribution to every dirty path in its nearest Cargo package', async () => {
    const dirty = [
      'apps/tui/Cargo.toml',
      'apps/tui/src/main.rs',
      'apps/tui/src/fresh_exec.rs',
      'apps/tui/src/self_install.rs',
      'apps/tui/src/voice_proxy.rs',
      'apps/other/src/lib.rs',
    ];
    const manifests = new Map([
      ['apps/tui/Cargo.toml', '[package]\nname = "pui"\n'],
      ['Cargo.toml', '[workspace]\nmembers = ["apps/tui"]\n'],
    ]);

    const result = await expandCargoPackageLiveLockExclusions(
      dirty,
      ['apps/tui/src/main.rs'],
      async (path) => manifests.get(path) ?? null,
    );

    expect(result).toEqual({
      paths: [
        'apps/tui/Cargo.toml',
        'apps/tui/src/fresh_exec.rs',
        'apps/tui/src/main.rs',
        'apps/tui/src/self_install.rs',
        'apps/tui/src/voice_proxy.rs',
      ],
      packages: [{
        root: 'apps/tui',
        paths: [
          'apps/tui/Cargo.toml',
          'apps/tui/src/fresh_exec.rs',
          'apps/tui/src/main.rs',
          'apps/tui/src/self_install.rs',
          'apps/tui/src/voice_proxy.rs',
        ],
      }],
    });
  });

  it('expands one live-held file to every dirty file in its attributed work-item cohort', () => {
    const attribution = new Map<string, FileAttribution>([
      ['source.ts', { agent: 'su-peer', workItems: ['WI-1834529'] }],
      ['source.test.ts', { agent: 'su-peer', workItems: ['WI-1834529'] }],
      ['unrelated.ts', { agent: 'su-peer', workItems: ['WI-other'] }],
    ]);

    expect(
      expandAtomicLiveLockExclusions(
        ['source.ts', 'source.test.ts', 'unrelated.ts'],
        [{ path: 'source.ts', owner: 'su-peer', intent: 'editing source', goalRef: ' WI-1834529 ' }],
        attribution,
      ),
    ).toEqual({
      paths: ['source.test.ts', 'source.ts'],
      groups: [{
        key: JSON.stringify(['su-peer', 'WI-1834529']),
        owner: 'su-peer',
        goalRef: 'WI-1834529',
        paths: ['source.test.ts', 'source.ts'],
      }],
      generatedDeclarationPairs: [],
    });
  });

  it('keeps legacy/null-goal locks at per-path granularity instead of grouping by owner', () => {
    const attribution = new Map<string, FileAttribution>([
      ['source.ts', { agent: 'su-peer', workItems: ['WI-legacy'] }],
      ['source.test.ts', { agent: 'su-peer', workItems: ['WI-legacy'] }],
    ]);

    expect(
      expandAtomicLiveLockExclusions(
        ['source.ts', 'source.test.ts'],
        [{ path: 'source.ts', owner: 'su-peer', intent: 'editing source' }],
        attribution,
      ),
    ).toEqual({ paths: ['source.ts'], groups: [], generatedDeclarationPairs: [] });
  });

  it('expands a live lock over both enrolled generated declaration paths only', () => {
    const source = 'scripts/proc-guard.mjs';
    const artifact = 'scripts/proc-guard.d.mts';
    const paths = [source, artifact];

    expect(expandGeneratedDeclarationPairHolds([source], paths)).toEqual({
      paths: [artifact, source],
      pairs: [{ source, artifact, heldPath: source }],
    });
    expect(expandGeneratedDeclarationPairHolds([source], [source])).toEqual({ paths: [], pairs: [] });
    expect(
      expandAtomicLiveLockExclusions(
        paths,
        [{ path: source, owner: 'su-peer', intent: 'editing declaration source' }],
        undefined,
        paths,
      ),
    ).toEqual({
      paths: [artifact, source],
      groups: [],
      generatedDeclarationPairs: [{ source, artifact, heldPath: source }],
    });
  });

  it('requires both the lock owner and work-item to match before expanding a cohort', () => {
    const attribution = new Map<string, FileAttribution>([
      ['source.ts', { agent: 'su-peer', workItems: ['WI-atomic'] }],
      ['source.test.ts', { agent: 'su-peer', workItems: ['WI-atomic'] }],
      ['other-work.ts', { agent: 'su-peer', workItems: ['WI-other'] }],
      ['other-owner.ts', { agent: 'su-other', workItems: ['WI-atomic'] }],
    ]);

    expect(
      expandAtomicLiveLockExclusions(
        ['source.ts', 'source.test.ts', 'other-work.ts', 'other-owner.ts'],
        [{ path: 'source.ts', owner: 'su-peer', intent: 'editing source', goalRef: 'WI-atomic' }],
        attribution,
      ),
    ).toEqual({
      paths: ['source.test.ts', 'source.ts'],
      groups: [{
        key: JSON.stringify(['su-peer', 'WI-atomic']),
        owner: 'su-peer',
        goalRef: 'WI-atomic',
        paths: ['source.test.ts', 'source.ts'],
      }],
      generatedDeclarationPairs: [],
    });
  });
});

describe('summarizeFetchFailure — a failed fetch keeps its reason (WI-10004103)', () => {
  it('prefers the disk-headroom refusal over surrounding git noise', () => {
    const stderr =
      'remote: Enumerating objects: 5\n' +
      'git fetch stopped for disk headroom at /home/u/repo/.git/objects: 30064771072 bytes available; critical reserve 43249416192 bytes\n' +
      'error: some trailing line\n';
    expect(summarizeFetchFailure(stderr)).toBe(
      'git fetch stopped for disk headroom at /home/u/repo/.git/objects: 30064771072 bytes available; critical reserve 43249416192 bytes',
    );
  });

  it('otherwise uses the last non-empty line, whitespace collapsed', () => {
    expect(summarizeFetchFailure("From x\n  fatal:   unable to access 'https://github.com/o/r/':  Could not resolve host\n\n")).toBe(
      "fatal: unable to access 'https://github.com/o/r/': Could not resolve host",
    );
  });

  it('keeps a concrete SSH cause instead of Git’s generic repository-exists footer', () => {
    const stderr = [
      'git@github.com: Permission denied (publickey).',
      'fatal: Could not read from remote repository.',
      'Please make sure you have the correct access rights',
      'and the repository exists.',
    ].join('\n');
    expect(summarizeFetchFailure(stderr)).toBe('git@github.com: Permission denied (publickey).');
  });

  it('falls back to Git’s generic fatal line when the footer has no concrete cause', () => {
    const stderr = [
      'fatal: Could not read from remote repository.',
      'Please make sure you have the correct access rights',
      'and the repository exists.',
    ].join('\n');
    expect(summarizeFetchFailure(stderr)).toBe('fatal: Could not read from remote repository.');
  });

  it('is empty for empty stderr and caps a runaway line', () => {
    expect(summarizeFetchFailure('')).toBe('');
    expect(summarizeFetchFailure(undefined)).toBe('');
    const long = summarizeFetchFailure(`fatal: ${'x'.repeat(1000)}`);
    expect(long.length).toBe(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

// EI-24649116564770033 / WI-10004077: a withheld manifest must not let the rest of an npm
// dependency change land alone (observed: operator-core's dep without root entry + lockfile).
describe('expandNpmManifestClosure — npm manifests land together', () => {
  const dirty = [
    'package.json',
    'package-lock.json',
    'packages/operator-core/package.json',
    'packages/operator-core/lib/x.ts',
  ];

  it('withholds every other dirty manifest when the root package.json is withheld', () => {
    expect(expandNpmManifestClosure(dirty, ['package.json'])).toEqual({
      paths: ['package-lock.json', 'packages/operator-core/package.json'],
      triggers: ['package.json'],
    });
  });

  it('is triggered by a withheld workspace manifest too, and by a directory exclusion', () => {
    expect(expandNpmManifestClosure(dirty, ['packages/operator-core']).paths).toEqual([
      'package-lock.json',
      'package.json',
    ]);
  });

  it('does nothing when no dirty manifest is withheld, including a lock on a CLEAN manifest', () => {
    expect(expandNpmManifestClosure(dirty, ['packages/operator-core/lib/x.ts'])).toEqual({ paths: [], triggers: [] });
    expect(expandNpmManifestClosure(['packages/a/package.json'], ['package.json'])).toEqual({ paths: [], triggers: [] });
  });

  it('never treats node_modules or look-alike names as manifests', () => {
    expect(isNpmManifestPath('node_modules/x/package.json')).toBe(false);
    expect(isNpmManifestPath('docs/package.json.md')).toBe(false);
    expect(isNpmManifestPath('npm-shrinkwrap.json')).toBe(true);
    expect(
      expandNpmManifestClosure(['package.json', 'node_modules/x/package.json'], ['package.json']).paths,
    ).toEqual([]);
  });
});

describe('git-sync commit identity', () => {
  it('uses a verified GitHub no-reply email for automated pushes', () => {
    expect(GIT_SYNC_BOT_NAME).toBe('papercusp-git-sync');
    expect(GIT_SYNC_BOT_EMAIL).toBe('papercupai@users.noreply.github.com');
    expect(GIT_SYNC_BOT_EMAIL).not.toMatch(/@papercusp\.local$/);
  });
});

describe('EI-217286 action abort propagation', () => {
  it('terminates a signal-bearing local git child instead of leaving it running after lease cleanup', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'git-sync-abort-'));
    execFileSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    const savedMode = process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE;
    const controller = new AbortController();
    process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE = '1'; // force the cancellable local runner
    const abortTimer = setTimeout(() => controller.abort(new Error('test action timeout')), 25);
    abortTimer.unref?.();
    try {
      const result = await runGitBounded(
        ['-c', 'alias.wait=!exec sleep 30', 'wait'],
        repo,
        5_000,
        { signal: controller.signal },
      );

      expect(result.code).toBe(-1);
      expect(result.stderr).toContain('aborted by the git-sync stall guard');
    } finally {
      clearTimeout(abortTimer);
      if (savedMode === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE = savedMode;
    }
  });
});

describe('WI-39922 tool-catalog pre-commit regeneration', () => {
  it('runs the generator for a catalog-affecting dirty source when the canonical surfaces are tracked', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: ' M packages/operator-core/lib/agent-tools/example.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: 'scripts/gen-tool-catalog.ts\n.papercusp/tool-catalog.json\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: 'wrote catalog', stderr: '' }));
    const logs: string[] = [];

    await regenerateToolCatalogBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      runGenerator,
    );

    expect(runGenerator).toHaveBeenCalledOnce();
    expect(calls.map((args) => args[0])).toEqual(['status', 'ls-files']);
    expect(logs.join('\n')).toMatch(/regenerated \.papercusp\/tool-catalog\.json before commit/);
  });

  it('does nothing for irrelevant dirty paths, including adjacent tool test files', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: ' M README.md\0 M packages/operator-core/lib/agent-tools/example.test.ts\0',
        stderr: '',
      };
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await regenerateToolCatalogBeforeCommit({ runGit, repoPath: '/fake', log: () => {} }, runGenerator);

    expect(runGenerator).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('status');
  });

  it('does not run the papercusp-specific generator when its tracked surfaces are absent', async () => {
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: ' M packages/operator-core/lib/agent-tools/example.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await regenerateToolCatalogBeforeCommit({ runGit, repoPath: '/unrelated-repo', log: () => {} }, runGenerator);

    expect(runGenerator).not.toHaveBeenCalled();
  });
});

describe('EI-21444216858331991 generated declarations pre-commit regeneration', () => {
  it('maps both halves of a generated declaration pair and ignores unrelated paths', () => {
    expect(generatedDeclarationPair('apps/operator/scripts/psu-launcher.mjs')).toEqual({
      source: 'apps/operator/scripts/psu-launcher.mjs',
      artifact: 'apps/operator/scripts/psu-launcher.d.mts',
    });
    expect(generatedDeclarationPair('apps/operator/scripts/psu-launcher.d.mts')).toEqual({
      source: 'apps/operator/scripts/psu-launcher.mjs',
      artifact: 'apps/operator/scripts/psu-launcher.d.mts',
    });
    expect(affectsGeneratedDeclarations('tsconfig.declarations.json')).toBe(true);
    expect(affectsGeneratedDeclarations('package-lock.json')).toBe(true);
    expect(affectsGeneratedDeclarations('README.md')).toBe(false);
  });

  it('regenerates an enrolled dirty source and returns the pair as one atomic commit group', async () => {
    const source = 'apps/operator/scripts/psu-launcher.mjs';
    const artifact = 'apps/operator/scripts/psu-launcher.d.mts';
    let statusReads = 0;
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') {
        statusReads += 1;
        return {
          code: 0,
          stdout: statusReads === 1 ? ` M ${source}\0` : ` M ${source}\0 M ${artifact}\0`,
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: `scripts/gen-declarations.ts\ntsconfig.declarations.json\npackage.json\npackage-lock.json\n${source}\n${artifact}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: 'emitted 1 declaration', stderr: '' }));
    const logs: string[] = [];

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      runGenerator,
    );

    expect(runGenerator).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'regenerated', atomicPaths: [source, artifact] });
    expect(logs.join('\n')).toMatch(/regenerated tracked declarations before commit/);
  });

  it('retries a transient status-read failure before running declaration repair', async () => {
    const source = 'apps/operator/scripts/psu-launcher.mjs';
    const artifact = 'apps/operator/scripts/psu-launcher.d.mts';
    let statusReads = 0;
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') {
        statusReads += 1;
        if (statusReads === 1) return { code: 128, stdout: '', stderr: 'temporary admission failure' };
        return { code: 0, stdout: ` M ${source}\0`, stderr: '' };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: `scripts/gen-declarations.ts\ntsconfig.declarations.json\n${source}\n${artifact}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: 'emitted declaration', stderr: '' }));

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: () => {} },
      runGenerator,
    );

    expect(statusReads).toBe(3); // initial failed read + successful retry + post-emit census
    expect(runGenerator).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'regenerated', atomicPaths: [source, artifact] });
  });

  it('WI-6554700010010659: a failed emit defers the declaration surface plus the dirty files tsc names', async () => {
    const source = 'apps/operator/scripts/psu-launcher.mjs';
    const artifact = 'apps/operator/scripts/psu-launcher.d.mts';
    const culprit = 'packages/operator-core/lib/verifier-source.ts';
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') return { code: 0, stdout: ` M ${source}\0 M ${culprit}\0 M docs/other.md\0`, stderr: '' };
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: `scripts/gen-declarations.ts\ntsconfig.declarations.json\n${source}\n${artifact}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: () => {} },
      async () => ({
        code: 1,
        stdout: '',
        stderr:
          `tsc failed:\n/fake/${culprit}(7,37): error TS5097: An import path can only end with a '.ts' extension.\n` +
          "scripts/not-dirty.ts(1,1): error TS2304: Cannot find name 'y'.\n",
      }),
    );

    expect(result).toMatchObject({
      status: 'deferred',
      atomicPaths: [artifact, source, culprit, 'scripts/gen-declarations.ts', 'tsconfig.declarations.json'].sort(),
      compilerErrors: [
        {
          path: culprit,
          diagnostic: `${culprit}(7,37): error TS5097: An import path can only end with a '.ts' extension.`,
        },
      ],
    });
  });

  it('WI-6554700010010659: declarationCompileErrors parses tsc diagnostics into repo-relative files', () => {
    const output = [
      'tsc failed:',
      'a/b.ts(1,2): error TS1000: first',
      '  /repo/a/b.ts(3,4): error TS1001: second',
      '/repo/./c.ts(5,6): error TS1002: absolute inside root',
      '/elsewhere/d.ts(1,1): error TS1003: outside root',
      '../up.ts(1,1): error TS1004: escapes root',
      'a/b.ts(9,9): warning-like text that is not an error line',
      'Error: Command failed',
    ].join('\n');

    expect(declarationCompileErrors(output, '/repo')).toEqual([
      { path: 'a/b.ts', diagnostic: 'a/b.ts(1,2): error TS1000: first\na/b.ts(3,4): error TS1001: second' },
      { path: 'c.ts', diagnostic: 'c.ts(5,6): error TS1002: absolute inside root' },
    ]);
    expect(declarationCompileOffenders(declarationCompileErrors(output, '/repo/'))[0]).toMatchObject({
      file: 'a/b.ts',
      detectorKey: 'declarations-tsc',
      fixerRole: 'content-fixer',
    });
  });

  it('defers the whole declaration surface when the writer fails without naming a file', async () => {
    const source = 'apps/operator/scripts/psu-launcher.mjs';
    const artifact = 'apps/operator/scripts/psu-launcher.d.mts';
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') return { code: 0, stdout: ` M ${source}\0`, stderr: '' };
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: `scripts/gen-declarations.ts\ntsconfig.declarations.json\n${source}\n${artifact}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const logs: string[] = [];

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      async () => ({ code: 1, stdout: '', stderr: 'declaration emit failed' }),
    );

    expect(result).toEqual({
      status: 'deferred',
      atomicPaths: [artifact, source, 'scripts/gen-declarations.ts', 'tsconfig.declarations.json'].sort(),
      detail: 'declaration emit failed',
      compilerErrors: [],
    });
    expect(logs.join('\n')).toMatch(/declaration regeneration failed \(declaration emit failed\) — deferring 4/);
  });
});

describe('WI-6554700010011061 declarations program-graph sources trigger the commit-time emit', () => {
  const inGraph = 'packages/operator-core/lib/verifier-source.ts';
  const outOfGraph = 'packages/operator-core/lib/unrelated.ts';
  const source = 'apps/operator/scripts/psu-launcher.mjs';
  const artifact = 'apps/operator/scripts/psu-launcher.d.mts';
  const inventory = `scripts/gen-declarations.ts\ntsconfig.declarations.json\n${source}\n${artifact}\n`;

  /** A git double whose status is `dirty` before the emit and `after` once it ran; it records every call. */
  function declarationGit(dirty: string[], after: string[] = dirty) {
    const calls: string[] = [];
    let statusReads = 0;
    const runGit: RunGit = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'status') {
        statusReads += 1;
        const paths = statusReads === 1 ? dirty : after;
        return { code: 0, stdout: paths.map((path) => ` M ${path}\0`).join(''), stderr: '' };
      }
      if (args[0] === 'ls-files') return { code: 0, stdout: inventory, stderr: '' };
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    return { runGit, calls };
  }

  it('classifies only source files outside node_modules as graph candidates', () => {
    expect(isDeclarationsGraphCandidate(inGraph)).toBe(true);
    expect(isDeclarationsGraphCandidate('scripts/lib/x.mjs')).toBe(true);
    expect(isDeclarationsGraphCandidate('libs/generic/deployment-driver/src/a.mts')).toBe(true);
    expect(isDeclarationsGraphCandidate('docs/README.md')).toBe(false);
    expect(isDeclarationsGraphCandidate('node_modules/pkg/index.ts')).toBe(false);
    expect(isDeclarationsGraphCandidate('../sibling/a.ts')).toBe(false);
  });

  it('runs the emit for a dirty in-graph TS file when no enrolled input is dirty', async () => {
    const { runGit } = declarationGit([inGraph, 'docs/other.md']);
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const listGraphMembers = vi.fn(async (_repo: string, candidates: readonly string[]) =>
      candidates.filter((path) => path === inGraph),
    );
    const logs: string[] = [];

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      runGenerator,
      listGraphMembers,
    );

    expect(listGraphMembers).toHaveBeenCalledExactlyOnceWith('/fake', [inGraph]);
    expect(runGenerator).toHaveBeenCalledOnce();
    // The source is not forced into the catch-all: no projection changed here.
    expect(result).toEqual({ status: 'regenerated', atomicPaths: [] });
    expect(logs.join('\n')).toMatch(/0 dirty pair\(s\), 1 dirty program-graph source\(s\)/);
  });

  it('a regenerated projection is still committed atomically with its enrolled source', async () => {
    const { runGit } = declarationGit([inGraph], [inGraph, artifact]);
    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: () => {} },
      async () => ({ code: 0, stdout: '', stderr: '' }),
      async () => [inGraph],
    );
    expect(result).toEqual({ status: 'regenerated', atomicPaths: [source, artifact] });
  });

  it('a dirty TS file outside the graph runs nothing and skips the inventory read', async () => {
    const { runGit, calls } = declarationGit([outOfGraph]);
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: () => {} },
      runGenerator,
      async () => [],
    );

    expect(result).toEqual({ status: 'not-needed', atomicPaths: [] });
    expect(runGenerator).not.toHaveBeenCalled();
    expect(calls).toEqual(['status']);
  });

  it('a repository without the graph helper behaves exactly as before', async () => {
    const { runGit, calls } = declarationGit([inGraph]);
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: () => {} },
      runGenerator,
      async () => null,
    );

    expect(result).toEqual({ status: 'not-needed', atomicPaths: [] });
    expect(runGenerator).not.toHaveBeenCalled();
    expect(calls).toEqual(['status']);
    // The real default resolves null when the helper is absent, without spawning.
    await expect(defaultListDeclarationsGraphMembers('/nonexistent-wi11061-repo', [inGraph])).resolves.toBeNull();
  });

  it('a failed graph lookup is fail-soft and says so', async () => {
    const { runGit } = declarationGit([inGraph]);
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const logs: string[] = [];

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      runGenerator,
      async () => {
        throw new Error('tsc --listFilesOnly exited 1');
      },
    );

    expect(result).toEqual({ status: 'not-needed', atomicPaths: [] });
    expect(runGenerator).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/declarations program-graph lookup failed \(Error: tsc --listFilesOnly exited 1\)/);
  });

  it('a failing emit holds back the in-graph file tsc names while the rest commits', async () => {
    const { runGit } = declarationGit([inGraph, 'docs/other.md']);
    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: () => {} },
      async () => ({
        code: 1,
        stdout: '',
        stderr: `/fake/${inGraph}(7,37): error TS5097: An import path can only end with a '.ts' extension.\n`,
      }),
      async () => [inGraph],
    );
    expect(result).toMatchObject({
      status: 'deferred',
      atomicPaths: [artifact, source, inGraph, 'scripts/gen-declarations.ts', 'tsconfig.declarations.json'].sort(),
      compilerErrors: [{ path: inGraph }],
    });
  });

  it('an enrolled pair still triggers the emit when the graph lookup is unavailable', async () => {
    const { runGit } = declarationGit([source, inGraph], [source, artifact, inGraph]);
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: () => {} },
      runGenerator,
      async () => null,
    );
    expect(runGenerator).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'regenerated', atomicPaths: [source, artifact] });
  });
});

describe('EI-20428405431869483 generated tool-routing pre-commit check', () => {
  it('limits the dirty-path trigger to routing sources, excluding pair tests', () => {
    expect(affectsToolRouting('packages/operator-core/lib/bash-substitution/pairs/dependency-install.ts')).toBe(true);
    expect(affectsToolRouting('packages/operator-core/lib/bash-substitution/pairs/model-drift.test.ts')).toBe(false);
    expect(affectsToolRouting('packages/operator-core/lib/bash-substitution/routing-table.ts')).toBe(true);
    expect(affectsToolRouting('scripts/gen-tool-routing.ts')).toBe(true);
    expect(affectsToolRouting('packages/operator-core/lib/bash-substitution/routing-table.test.ts')).toBe(false);
    expect(affectsToolRouting('README.md')).toBe(false);
  });

  it('runs the bounded check for an affected dirty source when canonical surfaces are tracked', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: ' M packages/operator-core/lib/bash-substitution/pairs/dependency-install.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout:
            'scripts/gen-tool-routing.ts\npackages/operator-core/lib/bash-substitution/routing-table.ts\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runCheck = vi.fn(async () => ({ code: 0, stdout: 'routing clean', stderr: '' }));
    const logs: string[] = [];

    await checkToolRoutingBeforeCommit({ runGit, repoPath: '/fake', log: (message) => logs.push(message) }, runCheck);

    expect(runCheck).toHaveBeenCalledOnce();
    expect(calls.map((args) => args[0])).toEqual(['status', 'ls-files']);
    expect(logs.join('\n')).toMatch(/generated tool-routing check passed before commit/);
  });

  it('does nothing for irrelevant dirty paths and pair test files', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout:
          ' M README.md\0 M packages/operator-core/lib/bash-substitution/pairs/model-drift.test.ts\0 M packages/operator-core/lib/bash-substitution/routing-table.test.ts\0',
        stderr: '',
      };
    };
    const runCheck = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await checkToolRoutingBeforeCommit({ runGit, repoPath: '/fake', log: () => {} }, runCheck);

    expect(runCheck).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('status');
  });

  it('keeps a failed check fail-soft so the git-sync commit can continue', async () => {
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: ' M scripts/gen-tool-routing.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout:
            'scripts/gen-tool-routing.ts\npackages/operator-core/lib/bash-substitution/routing-table.ts\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const logs: string[] = [];

    await checkToolRoutingBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      async () => ({ code: 1, stdout: '', stderr: 'canonical routing part is stale' }),
    );

    expect(logs.join('\n')).toMatch(/generated tool-routing check failed.*continuing with the commit fail-soft/);
  });
});

describe('runGitSync (real git, no submodule)', () => {
  let root: string;
  let originDir: string; // bare origin
  let repo: string; // the "harness" working clone

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-'));
    originDir = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', originDir);
    // seed an initial commit onto origin/main
    const seed = join(root, 'seed');
    git(root, 'clone', originDir, seed);
    configUser(seed);
    writeFileSync(join(seed, 'file.txt'), 'line1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    // the harness working clone
    repo = join(root, 'repo');
    git(root, 'clone', originDir, repo);
    configUser(repo);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cfg = { pushSubmodules: false } as const;
  // WI-38594: read FULL messages (%B), not subjects — diff-derived subjects demote the
  // sweep message stem ('auto-commit test') and per-agent intent lines to the commit BODY,
  // so marker assertions must scan the whole message to keep their meaning.
  const originLog = () => git(originDir, 'log', '--format=%B', 'main');

  it('commits a dirty tree and pushes it to origin (happy path)', async () => {
    writeFileSync(join(repo, 'new.txt'), 'hello\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    // origin received the auto-commit
    expect(originLog()).toMatch(/auto-commit test/);
    // working tree is clean after sync
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-25358130293460599: reclaims a stale index.lock during the full catch-all publish path', async () => {
    writeFileSync(join(repo, 'stale-lock-recovery.txt'), 'recovered\n');
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, 'orphaned test lock');
    const staleAt = new Date(Date.now() - STALE_INDEX_LOCK_MS - 1_000);
    utimesSync(lockPath, staleAt, staleAt);

    const logs: string[] = [];
    let catchAllRefreshAttempts = 0;
    const runGit: RunGit = async (args, cwd, options) => {
      if (args[0] === 'reset' && args.some((arg) => arg.startsWith('--pathspec-from-file='))) {
        catchAllRefreshAttempts++;
      }
      return directRunGit(args, cwd, options);
    };
    const out = await runGitSync('test', {
      repoPath: repo,
      runGit,
      config: cfg,
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(catchAllRefreshAttempts).toBe(2); // blocked once, then retried after stale-lock cleanup
    expect(existsSync(lockPath)).toBe(false);
    expect(logs.join('\n')).toContain('cleared STALE index.lock');
    expect(originLog()).toMatch(/auto-commit test/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  // WI-10008133: a freshly created EMPTY remote used to fail every tick with
  // "couldn't find remote ref" + "cannot reconcile", so its first publish never landed.
  it('publishes HEAD as the first commit of an EMPTY remote (WI-10008133)', async () => {
    const emptyDir = join(root, 'empty.git');
    git(root, 'init', '--bare', '-b', 'main', emptyDir);
    git(repo, 'remote', 'set-url', 'origin', emptyDir);
    writeFileSync(join(repo, 'first.txt'), 'first publish\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    expect(git(emptyDir, 'rev-parse', 'refs/heads/main')).toBe(git(repo, 'rev-parse', 'HEAD'));
    // the next tick reconciles normally against the now-populated remote
    const again = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(again.status).not.toBe('error');
  });

  it('still fails loudly when the remote has OTHER heads but not the branch (WI-10008133)', async () => {
    const populatedDir = join(root, 'populated.git');
    git(root, 'init', '--bare', '-b', 'main', populatedDir);
    git(repo, 'push', populatedDir, 'HEAD:refs/heads/other');
    git(repo, 'remote', 'set-url', 'origin', populatedDir);
    writeFileSync(join(repo, 'local.txt'), 'x\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('error');
    if (out.status === 'error') expect(out.errors.map(e => e.message).join('\n')).toMatch(/cannot reconcile/);
    expect(git(populatedDir, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe('refs/heads/other');
  });

  it('includes harness identity in equivalent superproject guard logs across hives', async () => {
    const secondRepo = join(root, 'repo-second-hive');
    git(root, 'clone', originDir, secondRepo);
    configUser(secondRepo);

    for (const checkout of [repo, secondRepo]) {
      writeFileSync(join(checkout, 'package.json'), '{"name":"hive-app"}\n');
      writeFileSync(join(checkout, 'package-lock.json'), '{"name":"hive-app","lockfileVersion":3}\n');
      writeFileSync(join(checkout, 'unrelated.txt'), 'ordinary work\n');
    }

    const papercuspLogs: string[] = [];
    const phoneAppLogs: string[] = [];
    const papercusp = await runGitSync('papercusp', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['package.json'],
      log: (message) => papercuspLogs.push(message),
    });
    const phoneApp = await runGitSync('phone-app', {
      repoPath: secondRepo,
      config: cfg,
      excludePaths: ['package.json'],
      log: (message) => phoneAppLogs.push(message),
    });

    expect(papercusp.status).toBe('synced');
    expect(phoneApp.status).toBe('synced');
    expect(papercuspLogs.join('\n')).toContain('[git-sync] papercusp/superproject: keeping npm manifests atomic');
    expect(phoneAppLogs.join('\n')).toContain('[git-sync] phone-app/superproject: keeping npm manifests atomic');
    expect(git(repo, 'status', '--porcelain', '--', 'package.json', 'package-lock.json')).toMatch(/package\.json/);
    expect(git(secondRepo, 'status', '--porcelain', '--', 'package.json', 'package-lock.json')).toMatch(/package\.json/);
    expect(git(originDir, 'show', 'main:unrelated.txt')).toBe('ordinary work');
    expect(() => git(originDir, 'show', 'main:package.json')).toThrow();
    expect(() => git(originDir, 'show', 'main:package-lock.json')).toThrow();
  });

  it('reports a sidecar admission refusal during merge without treating it as a Git conflict or aborting an unstarted merge', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args, cwd) => {
      calls.push(args);
      if (args.includes('merge') && args.includes('--no-edit')) {
        return {
          code: -1, stdout: '',
          stderr: 'spawner sidecar admission failed: resource_governor_admissions_time_chk',
        };
      }
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
      return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    };
    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((error) => error.message).join('\n'))
        .toContain('sidecar infrastructure refusal before Git dispatch');
      expect(out.errors.map((error) => error.message).join('\n')).not.toContain('merge failed');
    }
    expect(calls.some((args) => args.includes('--abort'))).toBe(false);
  });

  it('bridges a fully represented release main into staging ancestry without changing the staging tree', async () => {
    git(repo, 'checkout', '-b', 'staging');
    writeFileSync(join(repo, 'repair.txt'), 'fixed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'canonical staging repair');
    writeFileSync(join(repo, 'later.txt'), 'later staging work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'later staging work');
    git(repo, 'push', '-u', 'origin', 'staging');
    const stagingBefore = git(repo, 'rev-parse', 'HEAD');
    const stagingTree = git(repo, 'rev-parse', 'HEAD^{tree}');

    const isolated = join(root, 'isolated-repair');
    git(root, 'clone', originDir, isolated);
    configUser(isolated);
    writeFileSync(join(isolated, 'repair.txt'), 'fixed\n');
    git(isolated, 'add', '-A');
    git(isolated, 'commit', '--no-verify', '-m', 'isolated frozen repair');
    const isolatedMain = git(isolated, 'rev-parse', 'HEAD');
    git(isolated, 'push', 'origin', 'main');

    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: { ...cfg, branch: 'staging' },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.merged).toContain('superproject');
    const bridged = git(originDir, 'rev-parse', 'refs/heads/staging');
    expect(bridged).not.toBe(stagingBefore);
    expect(git(originDir, 'rev-parse', `${bridged}^{tree}`)).toBe(stagingTree);
    expect(git(originDir, 'show', '-s', '--format=%P', bridged).split(' ')).toEqual([
      stagingBefore,
      isolatedMain,
    ]);
    expect(git(originDir, 'merge-base', '--is-ancestor', isolatedMain, bridged)).toBe('');
    expect(logs.join('\n')).toMatch(/bridged fully-represented origin\/main into current ancestry/);
  });

  it('WI-40066: bridges release main in commit-only bridged mode without reconciling or pushing origin/staging', async () => {
    git(repo, 'checkout', '-b', 'staging');
    writeFileSync(join(repo, 'repair.txt'), 'fixed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'canonical staging repair');
    writeFileSync(join(repo, 'later.txt'), 'later staging work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'later staging work');
    git(repo, 'push', '-u', 'origin', 'staging');
    const stagingBefore = git(repo, 'rev-parse', 'HEAD');
    const stagingTree = git(repo, 'rev-parse', 'HEAD^{tree}');

    const isolated = join(root, 'isolated-commit-only-repair');
    git(root, 'clone', originDir, isolated);
    configUser(isolated);
    writeFileSync(join(isolated, 'repair.txt'), 'fixed\n');
    git(isolated, 'add', '-A');
    git(isolated, 'commit', '--no-verify', '-m', 'isolated frozen repair');
    const isolatedMain = git(isolated, 'rev-parse', 'HEAD');
    git(isolated, 'push', 'origin', 'main');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: {
        ...cfg,
        branch: 'staging',
        push: false,
        reconcileSuperprojectOrigin: false,
        bridgeContainedReleaseMainOnCommitOnly: true,
      },
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toEqual([]);
      expect(out.merged).toEqual(['superproject']);
    }
    const bridged = git(repo, 'rev-parse', 'HEAD');
    expect(bridged).not.toBe(stagingBefore);
    expect(git(repo, 'rev-parse', 'HEAD^{tree}')).toBe(stagingTree);
    expect(git(repo, 'show', '-s', '--format=%P', bridged).split(' ')).toEqual([
      stagingBefore,
      isolatedMain,
    ]);
    expect(git(repo, 'merge-base', '--is-ancestor', isolatedMain, bridged)).toBe('');
    expect(git(originDir, 'rev-parse', 'refs/heads/staging')).toBe(stagingBefore);
  });

  it('declines the release-main ancestry bridge when a main-only blob is not identical on staging', async () => {
    git(repo, 'checkout', '-b', 'staging');
    writeFileSync(join(repo, 'repair.txt'), 'staging version\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'different staging change');
    git(repo, 'push', '-u', 'origin', 'staging');
    const stagingBefore = git(repo, 'rev-parse', 'HEAD');

    const isolated = join(root, 'isolated-mismatch');
    git(root, 'clone', originDir, isolated);
    configUser(isolated);
    writeFileSync(join(isolated, 'repair.txt'), 'main version\n');
    git(isolated, 'add', '-A');
    git(isolated, 'commit', '--no-verify', '-m', 'unrepresented main repair');
    const isolatedMain = git(isolated, 'rev-parse', 'HEAD');
    git(isolated, 'push', 'origin', 'main');

    const logs: string[] = [];
    await runGitSync('test', {
      repoPath: repo,
      config: { ...cfg, branch: 'staging' },
      log: (message) => logs.push(message),
    });

    expect(git(originDir, 'rev-parse', 'refs/heads/staging')).toBe(stagingBefore);
    expect(() => git(originDir, 'merge-base', '--is-ancestor', isolatedMain, stagingBefore)).toThrow();
    expect(logs.join('\n')).toMatch(/release-main ancestry bridge declined/);
    expect(logs.join('\n')).toMatch(/repair\.txt.*not represented exactly on HEAD/);
  });

  it('EI-20744916065879285: excludes a protected tracked path while committing the rest of the tree', async () => {
    // Model a live peer edit: the protected file already exists in the index, while a
    // separate file is ordinary shared-tree work that this tick should still publish.
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['file.txt'],
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('deliberately-protected mutation\n');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
  });

  it('EI-22494259338317391: removes a pre-staged protected path from the commit index without touching its working tree', async () => {
    // `git checkout <sha> -- <path>` stages the selected blob as well as writing it.
    // Reproduce the lock incident with a repair-head blob staged before git-sync
    // receives the protected path.
    git(repo, 'checkout', '-q', '-b', 'repair-source');
    writeFileSync(join(repo, 'file.txt'), 'repair-head blob\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'repair-head');
    const repairHead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', repairHead, '--', 'file.txt');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');

    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('file.txt');

    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['file.txt'],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('repair-head blob\n');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toBe('M file.txt');
    expect(logs.join('\n')).toContain('removed 1 pre-staged protected path(s) from the commit index');
  });

  it('WI-10004413: an ORPHANED index.lock at the unstage-protected-paths reset is reclaimed instead of failing "could not unstage protected paths" every tick', async () => {
    // 2026-09-30: a writer died after staging a now-protected path, leaving a 0-byte
    // .git/index.lock. The reset that unstages protected paths is the FIRST index
    // writer of the tick, so without the shared stale-lock recovery every tick failed
    // here and the superproject stayed frozen for over an hour until someone removed the lock by hand.
    git(repo, 'checkout', '-q', '-b', 'repair-source');
    writeFileSync(join(repo, 'file.txt'), 'repair-head blob\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'repair-head');
    const repairHead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', repairHead, '--', 'file.txt');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('file.txt');

    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['file.txt'],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(existsSync(lockPath)).toBe(false);
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(logs.join('\n')).toContain('cleared STALE index.lock');
    expect(logs.join('\n')).toContain('removed 1 pre-staged protected path(s) from the commit index');
  });

  it('WI-10004413: a FRESH index.lock at the unstage-protected-paths reset is NOT touched', async () => {
    git(repo, 'checkout', '-q', '-b', 'repair-source');
    writeFileSync(join(repo, 'file.txt'), 'repair-head blob\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'repair-head');
    const repairHead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', repairHead, '--', 'file.txt');

    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, ''); // mtime = now: a live writer

    const out = await runGitSync('test', { repoPath: repo, config: cfg, excludePaths: ['file.txt'] });

    expect(out.status).not.toBe('synced');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('WI-10001350: quarantines an unreserved migration while committing unrelated files', async () => {
    const migration = 'libs/db/sql/999-unreserved-migration.sql';
    mkdirSync(join(repo, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(repo, migration), '-- intentionally unreserved\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const checker = vi.fn(async (_dirtyPaths: readonly string[]) => [{
      path: migration,
      reason: '[migration-reservation-guard] 999-unreserved-migration.sql has no reservation row',
    }]);
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      migrationReservationChecker: checker,
      log: (message) => logs.push(message),
    });

    expect(checker).toHaveBeenCalledOnce();
    expect(checker.mock.calls[0]?.[0]).toEqual([migration]);
    expect(out.status, JSON.stringify({ out, logs })).toBe('synced');
    expect(out.skippedPaths).toContainEqual({
      scope: 'superproject',
      path: migration,
      reason: 'migration-reservation',
      detail: '[migration-reservation-guard] 999-unreserved-migration.sql has no reservation row',
    });
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(migration);
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', migration)).toMatch(/999-unreserved-migration\.sql/);
    expect(logs.join('\n')).toContain('deferring migration');
  });

  it('WI-10001350: reservation-check failure defers candidate migrations fail-closed and commits unrelated files', async () => {
    const migration = 'libs/db/sql/999-unreadable-reservation.sql';
    mkdirSync(join(repo, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(repo, migration), '-- reservation status is unavailable\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const logs: string[] = [];
    const checker = vi.fn(async (_dirtyPaths: readonly string[]) => {
      throw new Error('reservation ledger unavailable');
    });

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      migrationReservationChecker: checker,
      log: (message) => logs.push(message),
    });

    expect(out.status, JSON.stringify({ out, logs })).toBe('synced');
    expect(out.skippedPaths).toContainEqual({
      scope: 'superproject',
      path: migration,
      reason: 'migration-reservation',
      detail: 'reservation check failed; deferring fail-closed: reservation ledger unavailable',
    });
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(migration);
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(repo, 'status', '--porcelain', '--', migration)).toMatch(/999-unreadable-reservation\.sql/);
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toBe('');
  });

  it('WI-10001350: rechecks staged migrations and selectively unstages a reservation race', async () => {
    const migration = 'libs/db/sql/999-raced-migration.sql';
    mkdirSync(join(repo, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(repo, migration), '-- reservation removed after preflight\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    let checks = 0;
    const checker = vi.fn(async (_dirtyPaths: readonly string[]) => {
      checks += 1;
      if (checks === 2) {
        return [{ path: migration, reason: '[migration-reservation-guard] 999-raced-migration.sql reservation disappeared' }];
      }
      return [];
    });
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      migrationReservationChecker: checker,
      log: (message) => logs.push(message),
    });

    expect(checker).toHaveBeenCalledTimes(2);
    expect(checker.mock.calls[0]?.[0]).toEqual([migration]);
    expect(checker.mock.calls[1]?.[0]).toEqual([migration]);
    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toContainEqual({
      scope: 'superproject',
      path: migration,
      reason: 'migration-reservation',
      detail: '[migration-reservation-guard] 999-raced-migration.sql reservation disappeared',
    });
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(migration);
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', migration)).toMatch(/999-raced-migration\.sql/);
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toBe('');
    expect(logs.join('\n')).toContain('deferring migration');
  });

  it('EI-22435583452728403: refreshes live locks at the commit seam before staging', async () => {
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const refreshLiveLockHoldings = vi.fn(async () => [{
      path: 'file.txt',
      owner: 'su-peer',
      intent: 'lock acquired after the initial git-sync census',
    }]);

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings,
    });

    // Pre-stage census + post-stage census + post-pass check for the still-held path.
    expect(refreshLiveLockHoldings).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toEqual([{
      scope: 'superproject',
      path: 'file.txt',
      owner: 'su-peer',
      intent: 'lock acquired after the initial git-sync census',
    }]);
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('deliberately-protected mutation\n');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
  });

  it('WI-6554700010009254: a late source lock unstages its generated declaration pair together', async () => {
    const pairRepo = mkdtempSync(join(tmpdir(), 'git-sync-declaration-pair-lock-'));
    const source = 'scripts/proc-guard.mjs';
    const artifact = 'scripts/proc-guard.d.mts';
    try {
      execFileSync('git', ['init', '-q', pairRepo], { encoding: 'utf8' });
      configUser(pairRepo);
      mkdirSync(join(pairRepo, 'scripts'), { recursive: true });
      writeFileSync(join(pairRepo, source), 'export const value = 1;\n');
      writeFileSync(join(pairRepo, artifact), 'export declare const value: 1;\n');
      git(pairRepo, 'add', source, artifact);
      git(pairRepo, 'commit', '--no-verify', '-m', 'seed generated declaration pair');

      writeFileSync(join(pairRepo, source), 'export const value = 2;\n');
      writeFileSync(join(pairRepo, artifact), 'export declare const value: 2;\n');
      git(pairRepo, 'add', source, artifact);
      const result = await guardStagedIndexBeforeCommit({
        runGit: directRunGit,
        repoPath: pairRepo,
        scope: 'superproject',
        refreshLiveLockHoldings: async () => [{
          path: source,
          owner: 'su-peer',
          intent: 'editing declaration source',
        }],
        generatedDeclarationPaths: [source, artifact],
        readText: async () => null,
        log: () => {},
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.unstaged.sort()).toEqual([artifact, source].sort());
      expect(git(pairRepo, 'diff', '--cached', '--name-only')).toBe('');
      expect(git(pairRepo, 'diff', '--name-only').split('\n').sort()).toEqual([artifact, source].sort());
    } finally {
      rmSync(pairRepo, { recursive: true, force: true });
    }
  });

  it('WI-10006725: a guard-held path a peer re-stages before the catch-all commit is not committed', async () => {
    writeFileSync(join(repo, 'file.txt'), 'held by a late lock\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    let census = 0;
    // The pre-stage census is clear, so `add -A` stages file.txt; the post-stage census
    // reports a late lock, so the guard holds file.txt back from this commit.
    const refreshLiveLockHoldings = vi.fn(async () => {
      census += 1;
      return census === 1 ? [] : [{ path: 'file.txt', owner: 'su-peer', intent: 'late lock' }];
    });
    // A peer `git add`s the held path into the SHARED index after the guard, right before
    // the catch-all records its commit (`write-tree` privately, or `git commit` on the
    // shared index — the pre-WI-10006725 path, which recorded the peer's entry).
    let peerStaged = false;
    const runGit: RunGit = async (args, cwd, options) => {
      if (!peerStaged && census >= 2 && (args.includes('write-tree') || args.includes('commit'))) {
        peerStaged = true;
        git(repo, 'add', 'file.txt');
      }
      return directRunGit(args, cwd, options);
    };

    const out = await runGitSync('test', { repoPath: repo, config: cfg, refreshLiveLockHoldings, runGit });

    expect(peerStaged).toBe(true);
    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toContainEqual({ scope: 'superproject', path: 'file.txt', owner: 'su-peer', intent: 'late lock' });
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    // The peer's staged entry is left as the peer wrote it; the committed path's shared
    // entry was refreshed to the commit, so it reads clean.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('file.txt');
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toBe('');
  });

  it('WI-10006725: a catch-all whose base moved before publish is not published and errors', async () => {
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    let moved = false;
    const runGit: RunGit = async (args, cwd, options) => {
      if (!moved && args[0] === 'update-ref' && args.includes('git-sync: catch-all commit')) {
        moved = true;
        // A second writer advances HEAD between the catch-all's commit-tree and its CAS.
        const peer = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'peer moved HEAD');
        git(repo, 'update-ref', 'HEAD', peer);
      }
      return directRunGit(args, cwd, options);
    };

    const out = await runGitSync('test', { repoPath: repo, config: cfg, runGit });

    expect(moved).toBe(true);
    expect(out.status).toBe('error');
    expect(JSON.stringify(out)).toContain('update-ref CAS refused');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('peer moved HEAD');
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toMatch(/normal\.txt/);
  });

  it('WI-10006725: an edit whose stat the shared index caches racily is still committed', async () => {
    // Git re-hashes an entry whose mtime is not older than the index file's own mtime (a
    // "racy" entry). A private index copied with a fresh mtime would trust that cached stat,
    // so a same-size edit would never stage. checkStat=minimal + trustctime=false reduce the
    // stat check to mtime seconds and size, which makes the race deterministic here.
    git(repo, 'config', 'core.checkStat', 'minimal');
    git(repo, 'config', 'core.trustctime', 'false');
    const file = join(repo, 'racy.txt');
    const second = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(file, 'version 1\n');
    utimesSync(file, second, second);
    git(repo, 'add', 'racy.txt');
    git(repo, 'commit', '--no-verify', '-m', 'racy seed');
    git(repo, 'push', 'origin', 'main');
    // Same size and mtime, different bytes; the shared index is stamped in the same second.
    writeFileSync(file, 'version 2\n');
    utimesSync(file, second, second);
    utimesSync(join(repo, '.git', 'index'), second, second);
    // Calibration: the shared index itself sees the edit (read without rewriting the index).
    expect(git(repo, '--no-optional-locks', 'status', '--porcelain', '--', 'racy.txt')).toMatch(/racy\.txt/);

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:racy.txt')).toBe('version 2');
  });

  it('WI-10006725: the catch-all still commits a force-added ignored file and an untracked ignored one stays out', async () => {
    writeFileSync(join(repo, '.gitignore'), '*.log\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '--no-verify', '-m', 'ignore logs');
    git(repo, 'push', 'origin', 'main');
    // An agent deliberately tracks one ignored file; `add -A` alone would never stage it.
    writeFileSync(join(repo, 'forced.log'), 'deliberately tracked\n');
    git(repo, 'add', '-f', 'forced.log');
    writeFileSync(join(repo, 'other.log'), 'still ignored\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const logs: string[] = [];

    const out = await runGitSync('test', { repoPath: repo, config: cfg, log: (m) => logs.push(m) });

    expect(out.status).toBe('synced');
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('forced.log');
    expect(originFiles).not.toContain('other.log');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(logs.join('\n')).toContain('carried 0 staged deletion(s) and 1 staged addition(s)');
  });

  it('EI-26153199126212596: keeps staged untracking when generated files are bulk-excluded', async () => {
    writeFileSync(join(repo, '.gitignore'), 'generated-output/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '--no-verify', '-m', 'ignore generated output');
    git(repo, 'push', 'origin', 'main');

    mkdirSync(join(repo, 'generated-output'), { recursive: true });
    const generated = ['bundle-a.mjs', 'bundle-b.mjs', 'bundle-c.mjs'];
    for (const name of generated) writeFileSync(join(repo, 'generated-output', name), Buffer.alloc(64, 1));
    git(repo, 'add', '-f', 'generated-output');
    git(repo, 'commit', '--no-verify', '-m', 'track generated output');
    git(repo, 'push', 'origin', 'main');

    // Remove only their index membership. The generated bytes stay local and ignored.
    git(repo, 'rm', '--cached', '--', ...generated.map((name) => 'generated-output/' + name));
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: { ...cfg, maxCommitTotalBytes: 64 },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(out.oversized.filter((file) => file.exclusionReason === 'cumulative-limit').map((file) => file.path).sort())
      .toEqual(generated.map((name) => 'generated-output/' + name).sort());
    expect(logs.join('\n')).not.toContain('removed 3 pre-staged protected path(s) from the commit index');
    expect(logs.join('\n')).toContain('catch-all carried 3 staged deletion(s) and 0 staged addition(s)');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    expect(originFiles.filter((path) => path.startsWith('generated-output/'))).toEqual([]);
    expect(git(repo, 'ls-files', '--', 'generated-output')).toBe('');
    expect(generated.every((name) => readFileSync(join(repo, 'generated-output', name)).length === 64)).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-26153199126212596: exempts only cumulative staged deletions without a late lock', async () => {
    const guardRepo = mkdtempSync(join(tmpdir(), 'git-sync-cumulative-deletion-guard-'));
    const safeDeletion = 'generated-output/safe.mjs';
    const lateLockedDeletion = 'generated-output/late-locked.mjs';
    const stagedAddition = 'generated-output/addition.mjs';
    try {
      execFileSync('git', ['init', '-q', guardRepo], { encoding: 'utf8' });
      configUser(guardRepo);
      mkdirSync(join(guardRepo, 'generated-output'), { recursive: true });
      writeFileSync(join(guardRepo, '.gitignore'), 'generated-output/\n');
      writeFileSync(join(guardRepo, safeDeletion), 'safe generated artifact\n');
      writeFileSync(join(guardRepo, lateLockedDeletion), 'late-locked generated artifact\n');
      git(guardRepo, 'add', '.gitignore');
      git(guardRepo, 'add', '-f', 'generated-output');
      git(guardRepo, 'commit', '--no-verify', '-m', 'seed generated artifacts');

      git(guardRepo, 'rm', '--cached', '--', safeDeletion, lateLockedDeletion);
      writeFileSync(join(guardRepo, stagedAddition), 'staged generated artifact\n');
      git(guardRepo, 'add', '-f', stagedAddition);
      const result = await guardStagedIndexBeforeCommit({
        runGit: directRunGit,
        repoPath: guardRepo,
        scope: 'superproject',
        excludedDependencies: [safeDeletion, lateLockedDeletion, stagedAddition],
        preserveCumulativeUntracking: new Set([safeDeletion, lateLockedDeletion, stagedAddition]),
        refreshLiveLockHoldings: async () => [{
          path: lateLockedDeletion,
          owner: 'su-peer',
          intent: 'late lock on generated artifact',
        }],
        readText: async () => null,
        log: () => {},
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.unstaged.sort()).toEqual([lateLockedDeletion, stagedAddition].sort());
      expect(git(guardRepo, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)).toEqual([safeDeletion]);
    } finally {
      rmSync(guardRepo, { recursive: true, force: true });
    }
  });

  it('EI-24356165312897992: commits released locks while retaining current locks and explicit exclusions', async () => {
    writeFileSync(join(repo, 'file.txt'), 'completed edit\n');
    writeFileSync(join(repo, 'explicit.txt'), 'explicitly excluded\n');
    writeFileSync(join(repo, 'new-lock.txt'), 'still being edited\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const currentLock = { path: 'new-lock.txt', owner: 'su-current', intent: 'editing now' };

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['explicit.txt'],
      liveLockHoldings: ['file.txt', 'explicit.txt'].map((path) => ({
        path, owner: 'su-finished', intent: 'released during the preflight',
      })),
      refreshLiveLockHoldings: async () => {
        // This path became dirty after the initial census. It still needs a
        // staging exclusion even though it cannot appear in skippedPaths yet.
        writeFileSync(join(repo, 'late-lock.txt'), 'new edit during preflight\n');
        return [currentLock, { path: 'late-lock.txt', owner: 'su-late', intent: 'editing now' }];
      },
    });

    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toEqual([{ scope: 'superproject', ...currentLock }]);
    expect(git(originDir, 'show', 'main:file.txt')).toBe('completed edit');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    const committedPaths = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(committedPaths).not.toContain('explicit.txt');
    expect(committedPaths).not.toContain('new-lock.txt');
    expect(committedPaths).not.toContain('late-lock.txt');
    expect(readFileSync(join(repo, 'explicit.txt'), 'utf8')).toBe('explicitly excluded\n');
    expect(readFileSync(join(repo, 'new-lock.txt'), 'utf8')).toBe('still being edited\n');
  });

  it('WI-6554700010018790: commits a live-held path released after the pre-stage census in the same pass', async () => {
    writeFileSync(join(repo, 'file.txt'), 'completed edit released during preparation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const releasedHold = { path: 'file.txt', owner: 'su-finished', intent: 'turn-scoped hold' };
    let refreshCount = 0;
    const refreshLiveLockHoldings = vi.fn(async () => {
      refreshCount += 1;
      // The pre-stage snapshot still sees the hold. The post-stage guard and the
      // post-pass census see the release, but file.txt was excluded from every add.
      return refreshCount === 1 ? [releasedHold] : [];
    });

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings,
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('completed edit released during preparation');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toBe('');
    expect(out.skippedPaths).not.toContainEqual(expect.objectContaining({ path: 'file.txt' }));
    expect(refreshLiveLockHoldings).toHaveBeenCalledTimes(5);
  });

  it('EI-22435583452728403: fails closed when the commit-time live-lock refresh rejects', async () => {
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const refreshLiveLockHoldings = vi.fn(async () => {
      throw new Error('live lock store unavailable during staging');
    });

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings,
    });

    expect(refreshLiveLockHoldings).toHaveBeenCalledOnce();
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((error) => error.message).join('\n')).toContain(
        'live lock refresh failed (fail-closed): live lock store unavailable during staging',
      );
    }
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('normal.txt');
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toMatch(/normal\.txt/);
  });

  // EI-24712906810240170: the pre-stage refresh cannot see a lock taken AFTER it. These
  // reproduce a mutation probe racing the sweep: the probe locks, then mutates, between the
  // pre-stage census (call 1) and `git add -A`. Call 2 is the post-stage census.
  it('EI-24712906810240170: a lock taken between the pre-stage census and the add never publishes the mutant', async () => {
    const original = readFileSync(join(repo, 'file.txt'), 'utf8');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const probeLock = { path: 'file.txt', owner: 'su-probe', intent: 'mutation probe' };
    let calls = 0;
    const refreshLiveLockHoldings = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // The probe acquires its lock just after this census reads, then mutates.
        writeFileSync(join(repo, 'file.txt'), 'MUTANT\n');
        return [];
      }
      return [probeLock]; // still mid-probe at the post-stage census
    });

    const out = await runGitSync('test', { repoPath: repo, config: cfg, refreshLiveLockHoldings });

    expect(refreshLiveLockHoldings).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe(original.trimEnd());
    expect(git(originDir, 'log', '-p', 'main')).not.toContain('MUTANT');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(out.skippedPaths).toContainEqual({ scope: 'superproject', ...probeLock });
    // The mutant stays in the working tree only, unstaged, for the probe to restore.
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('MUTANT\n');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('EI-24712906810240170: a probe that restores and releases before the commit does not publish the staged mutant', async () => {
    const original = readFileSync(join(repo, 'file.txt'), 'utf8');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    let calls = 0;
    const refreshLiveLockHoldings = vi.fn(async () => {
      calls += 1;
      if (calls === 1) writeFileSync(join(repo, 'file.txt'), 'MUTANT\n'); // mutated after this census
      // By the post-stage census the probe has restored the file and released its lock,
      // so no lock is visible: only the index still holds the mutant.
      else writeFileSync(join(repo, 'file.txt'), original);
      return [];
    });
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings,
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'log', '-p', 'main')).not.toContain('MUTANT');
    expect(git(originDir, 'show', 'main:file.txt')).toBe(original.trimEnd());
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toBe('');
    expect(logs.join('\n')).toContain('drifted after staging [file.txt]');
  });

  it('EI-24712906810240170: an edit that keeps changing after staging is deferred, then committed whole next tick', async () => {
    writeFileSync(join(repo, 'file.txt'), 'first half of an edit\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    let calls = 0;
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings: async () => {
        calls += 1;
        if (calls === 2) writeFileSync(join(repo, 'file.txt'), 'finished edit\n');
        return [];
      },
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'log', '-p', 'main')).not.toContain('first half of an edit');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');

    const next = await runGitSync('test', { repoPath: repo, config: cfg, refreshLiveLockHoldings: async () => [] });
    expect(next.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('finished edit');
  });

  it('reports a silent staged-deletion command failure without committing or pushing', async () => {
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const runGit: RunGit = async (args, cwd) => args.includes('--diff-filter=D')
      ? { code: -1, stdout: '', stderr: '' }
      : directRunGit(args, cwd);
    const out = await runGitSync('test', { repoPath: repo, config: cfg, runGit });
    expect(out.status).toBe('error');
    if (out.status !== 'error') throw new Error(`expected error outcome, got ${out.status}`);
    expect(out.errors.map((error) => error.message).join('\n')).toContain(
      'post-stage guard could not read staged deletions: git exited with code -1 without output',
    );
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('normal.txt');
    expect(git(repo, 'diff', '--cached', '--name-only')).toContain('normal.txt');
  });

  it('EI-24712906810240170: fails closed when the post-stage live-lock refresh rejects', async () => {
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    let calls = 0;
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings: async () => {
        calls += 1;
        if (calls === 2) throw new Error('lock store unavailable after staging');
        return [];
      },
    });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((error) => error.message).join('\n')).toContain(
        'post-stage live lock refresh failed (fail-closed): lock store unavailable after staging',
      );
    }
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('normal.txt');
  });

  it('EI-21267378554087084: an ignored scratch exclusion does not strand legitimate tracked work', async () => {
    const ignoredPath = '.papercusp/scratch';
    const ignoredArtifact = join(repo, ignoredPath, 'transient-artifact');
    writeFileSync(join(repo, '.gitignore'), `${ignoredPath}/\n`);
    mkdirSync(join(repo, ignoredPath), { recursive: true });
    writeFileSync(ignoredArtifact, 'must remain local and untracked\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: [ignoredPath],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(
      `${ignoredPath}/transient-artifact`,
    );
    expect(readFileSync(ignoredArtifact, 'utf8')).toBe('must remain local and untracked\n');
    expect(logs.join('\n')).toContain('pre-filtering ignored untracked protected path');
  });

  it('WI-6554700010010584: batches verbatim protected paths into ONE real check-ignore call', async () => {
    // Real git, not a fake: a fake answered `-z` happily while Git 2.43 rejects it
    // without --stdin, which is how wholesale-deletion-guard's batch went dead.
    writeFileSync(join(repo, '.gitignore'), 'ignored-*\nbuild/\n');
    mkdirSync(join(repo, 'build'), { recursive: true });
    mkdirSync(join(repo, 'real-dir'), { recursive: true });
    symlinkSync('real-dir', join(repo, 'linked-dir'));
    for (const file of ['ignored-plain', 'ignored-with space', 'ignored-"q"', 'ignored-ü', 'ignored-tracked', 'kept.txt', 'build/out.bin']) {
      writeFileSync(join(repo, file), 'x\n');
    }
    git(repo, 'add', '-f', 'ignored-tracked');
    const calls: string[][] = [];
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    };
    const verbatim = ['ignored-plain', 'ignored-with space', 'ignored-tracked', 'kept.txt', 'build/out.bin', 'ignored-missing'];
    const quoted = ['ignored-"q"', 'ignored-ü'];
    expect(verbatim.every(isVerbatimCheckIgnorePath)).toBe(true);
    expect(quoted.some(isVerbatimCheckIgnorePath)).toBe(false);
    const ignored = new Set(['ignored-plain', 'ignored-with space', 'build/out.bin', 'ignored-missing', ...quoted]);

    const batched = await classifyProtectedPathExclusions(runGit, repo, [...verbatim, ...quoted]);

    expect(batched.ignoredUntracked).toEqual(ignored); // a tracked match is never reported
    expect(batched.beyondSymlink).toEqual(new Set());
    expect(calls).toEqual([
      ['check-ignore', '--', ...verbatim],
      ...quoted.map((path) => ['check-ignore', '--', path]),
    ]);

    // Isolate a named fatal pathspec and retry the remaining verbatim paths together.
    calls.length = 0;
    const fallback = await classifyProtectedPathExclusions(runGit, repo, [...verbatim, 'linked-dir/x', ...quoted]);

    expect(fallback.ignoredUntracked).toEqual(ignored);
    expect(fallback.beyondSymlink).toEqual(new Set(['linked-dir/x']));
    expect(calls[0]).toEqual(['check-ignore', '--', ...verbatim, 'linked-dir/x']);
    expect(calls[1]).toEqual(['check-ignore', '--', ...verbatim]);
    expect(calls).toHaveLength(2 + quoted.length);
  });

  it('EI-27693013605402344: submodule and symlink exclusions do not fan out ordinary paths into single probes', async () => {
    writeFileSync(join(repo, '.gitignore'), 'ignored-*\n');
    mkdirSync(join(repo, 'real-dir'));
    symlinkSync('real-dir', join(repo, 'linked-dir'));
    git(repo, 'update-index', '--add', '--cacheinfo', '160000', git(repo, 'rev-parse', 'HEAD'), 'child');
    const ordinary = Array.from({ length: 120 }, (_, i) => `protected-${i}.ts`);
    const ignored = Array.from({ length: 20 }, (_, i) => `ignored-${i}`);
    const childPaths = Array.from({ length: 11 }, (_, i) => `child/src/protected-${i}.ts`);
    const paths = [...ordinary, ...ignored, ...childPaths, 'child', 'linked-dir/x'];
    const calls: string[][] = [];
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      return directRunGit(args, cwd);
    };

    const result = await classifyProtectedPathExclusions(runGit, repo, paths);

    expect(result.ignoredUntracked).toEqual(new Set(ignored));
    expect(result.inSubmodule).toEqual(new Set(childPaths));
    expect(result.beyondSymlink).toEqual(new Set(['linked-dir/x']));
    expect(result.inSubmodule.has('child')).toBe(false); // The gitlink itself stays protected.
    expect(calls).toHaveLength(3); // One failed batch per invalid class, then one successful batch.
    expect(calls.every((args) => args.length > 3)).toBe(true);
    expect(calls.at(-1)).toEqual(['check-ignore', '--', ...ordinary, ...ignored, 'child']);
  });

  it('EI-27693013605402344: an unknown failure after isolating a submodule preserves every exclusion', async () => {
    const runGit: RunGit = async (args) => args.includes('child/file.ts')
      ? { code: 128, stdout: '', stderr: "fatal: Pathspec 'child/file.ts' is in submodule 'child'" }
      : { code: 128, stdout: '', stderr: 'fatal: repository unavailable' };

    const result = await classifyProtectedPathExclusions(runGit, repo, ['safe.ts', 'child/file.ts']);

    expect(result).toEqual({ ignoredUntracked: new Set(), inSubmodule: new Set(), beyondSymlink: new Set() });
  });

  it('EI-24369292425690265: checks per-path protected paths with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    // A `"` makes Git C-quote the echoed name, so each of these takes the one-path probe.
    const paths = Array.from({ length: 24 }, (_, i) => `protected-"${i}"`);
    const runGit: RunGit = async (args) => {
      expect(args).toHaveLength(3);
      const path = args[2];
      seen.push(path);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (path === 'protected-"3"') return { code: 0, stdout: `"protected-\\"3\\""\n`, stderr: '' };
      if (path === 'protected-"9"') {
        return { code: 128, stdout: '', stderr: `fatal: pathspec '${path}' is beyond a symbolic link` };
      }
      return { code: 1, stdout: '', stderr: '' };
    };

    const result = await classifyProtectedPathExclusions(runGit, repo, paths);

    expect(new Set(seen)).toEqual(new Set(paths));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(result.ignoredUntracked).toEqual(new Set(['protected-"3"']));
    expect(result.beyondSymlink).toEqual(new Set(['protected-"9"']));
  });

  it('EI-21635845150755039: a protected symlink descendant does not strand stageable work', async () => {
    const protectedPath = 'src-tauri/target/release/bundle/deb/Papercusp Server_0.0.18_amd64.deb';
    const relocatedTarget = join(root, 'relocated-builds', 'papercusp-desktop-src-tauri-target');
    const relocatedArtifact = join(
      relocatedTarget,
      'release',
      'bundle',
      'deb',
      'Papercusp Server_0.0.18_amd64.deb',
    );
    mkdirSync(join(relocatedTarget, 'release', 'bundle', 'deb'), { recursive: true });
    writeFileSync(relocatedArtifact, 'relocated build artifact — never stage this\n');
    mkdirSync(join(repo, 'src-tauri'), { recursive: true });
    symlinkSync(relocatedTarget, join(repo, 'src-tauri', 'target'));
    writeFileSync(join(repo, '.gitignore'), 'src-tauri/target\n');
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: [protectedPath, 'file.txt'],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(protectedPath);
    expect(readFileSync(relocatedArtifact, 'utf8')).toBe('relocated build artifact — never stage this\n');
    expect(git(repo, 'ls-files', '--', 'src-tauri/target')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
    expect(logs.join('\n')).toContain('pre-filtering protected path(s) beyond a symbolic link');
    expect(
      isPathspecBeyondSymbolicLinkFailure(
        `fatal: pathspec '${protectedPath}' is beyond a symbolic link`,
      ),
    ).toBe(true);
  });

  /** A real submodule at apps/sub with one dirty file inside it (WI-6554700010018683). */
  function addDirtySubmodule(): { subPath: string; insidePath: string } {
    const subSource = join(root, 'sub-source');
    git(root, 'init', '-q', '-b', 'main', subSource);
    configUser(subSource);
    writeFileSync(join(subSource, 'route.ts'), 'export {};\n');
    git(subSource, 'add', '-A');
    git(subSource, 'commit', '--no-verify', '-q', '-m', 'sub init');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'apps/sub');
    git(repo, 'commit', '--no-verify', '-q', '-m', 'add submodule');
    writeFileSync(join(repo, 'apps', 'sub', 'route.ts'), 'export const held = 1;\n');
    return { subPath: 'apps/sub', insidePath: 'apps/sub/route.ts' };
  }

  it('WI-6554700010018683: classifies a protected path inside a submodule instead of failing the preflight', async () => {
    const { insidePath } = addDirtySubmodule();
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const runGit: RunGit = async (args, cwd) => {
      try {
        const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
      }
    };

    const result = await classifyProtectedPathExclusions(runGit, repo, [insidePath, 'file.txt']);

    // Before the fix the 128 was unclassified, so the whole preflight failed open and
    // returned NO classification at all.
    expect(result.inSubmodule).toEqual(new Set([insidePath]));
    expect(result.ignoredUntracked).toEqual(new Set());
    expect(result.beyondSymlink).toEqual(new Set());
  });

  it('WI-6554700010018683: a held path inside a submodule does not abort the superproject add', async () => {
    const { insidePath } = addDirtySubmodule();
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const logs: string[] = [];

    // submodulePaths: [] models any exclusion source that does not know the path is in
    // a submodule, so the in-submodule pathspec reaches this repo's own stage.
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      submodulePaths: [],
      excludePaths: [insidePath, 'file.txt'],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
    expect(logs.join('\n')).toContain('pre-filtering protected path(s) inside a submodule');
    expect(logs.join('\n')).not.toMatch(/is in submodule/);
  });

  it('WI-6554700010018683: an add failure drops every exclusion under the submodule Git named, and only those', () => {
    const output = "fatal: Pathspec ':(exclude,literal)apps/sub/app/api/quotes/route.ts' is in submodule 'apps/sub'\n";
    expect(isPathspecInSubmoduleFailure(output)).toBe(true);
    expect(isPathspecInSubmoduleFailure("fatal: pathspec 'x' is beyond a symbolic link")).toBe(false);
    expect(
      inSubmoduleProtectedExclusions(output, [
        'apps/sub/app/api/quotes/route.ts',
        'apps/sub/other.ts',
        'apps/sub',
        'apps/subway/x.ts',
        'file.txt',
      ]),
    ).toEqual(['apps/sub/app/api/quotes/route.ts', 'apps/sub/other.ts']);
    expect(inSubmoduleProtectedExclusions('fatal: something else', ['apps/sub/x.ts'])).toEqual([]);
  });

  it('EI-21371380265465702: git-sync ignores in-progress dependency-generation build markers', async () => {
    // The production integration tree uses the canonical root policy. Copy it
    // into the throwaway clone so this test fails if the policy ever stops
    // excluding a build marker, rather than merely testing a duplicated fixture
    // pattern.
    writeFileSync(join(repo, '.gitignore'), readFileSync(join(REPO_ROOT, '.gitignore')));
    const markerPaths = [
      '.papercusp/dependency-generations/.build-pending-host-123-456/tree/file',
      'packages/mock/.papercusp/dependency-generations/.build-pending-host-123-456/tree/file',
    ];
    for (const markerPath of markerPaths) {
      mkdirSync(join(repo, markerPath, '..'), { recursive: true });
      writeFileSync(join(repo, markerPath), 'in-progress generation\n');
    }
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    for (const markerPath of markerPaths) {
      expect(originFiles).not.toContain(markerPath);
      expect(git(repo, 'check-ignore', '-v', '--no-index', markerPath)).toContain(
        '.papercusp/dependency-generations/',
      );
    }
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toBe('');
  });

  it('EI-22737671025165479: untracks legacy dependency-generation runtime state without deleting it', async () => {
    const selector = '.papercusp/dependency-generations/.inputs/legacy-selector';
    const selectorPath = join(repo, selector);
    mkdirSync(join(selectorPath, '..'), { recursive: true });
    writeFileSync(selectorPath, 'schema=1\ncreated=1\n');
    git(repo, 'add', '-f', selector);
    git(repo, 'commit', '--no-verify', '-m', 'legacy tracked runtime state');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, '.papercusp/dependency-generations/.gitignore'), '*\n');
    writeFileSync(selectorPath, 'schema=1\ncreated=2\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(selector);
    expect(readFileSync(selectorPath, 'utf8')).toBe('schema=1\ncreated=2\n');
    expect(git(repo, 'check-ignore', '-v', '--no-index', selector)).toContain(
      '.papercusp/dependency-generations/.gitignore',
    );
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(logs.join('\n')).toContain(
      'legacy tracked dependency-generation runtime path(s) from the index',
    );
  });

  describe('WI-10006277: the host-local dependency-generation root record never reaches a user repo', () => {
    const record = DEPENDENCY_GENERATION_ROOT_RECORD;
    // A host-local absolute store path, as dependency-generation.sh records it.
    const storeLine = `${join(tmpdir(), 'pc-dependency-generations')}\n`;
    const excludeFile = () => git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');

    it('names the same path dependency-generation-prebuild writes', () => {
      const root = join(tmpdir(), 'integration-root');
      expect(join(root, record)).toBe(dependencyGenerationRootRecord(root));
    });

    it('untracks an already-committed record privately and keeps the file on disk', async () => {
      const recordPath = join(repo, record);
      mkdirSync(join(recordPath, '..'), { recursive: true });
      writeFileSync(recordPath, storeLine);
      git(repo, 'add', record);
      git(repo, 'commit', '--no-verify', '-m', 'git-sync committed the record (pre-fix)');
      git(repo, 'push', 'origin', 'main');
      writeFileSync(join(repo, 'normal.txt'), 'agent work\n');
      const logs: string[] = [];

      const out = await runGitSync('test', { repoPath: repo, config: cfg, log: (m) => logs.push(m) });

      expect(out.status).toBe('synced');
      const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
      expect(originFiles).not.toContain(record);
      expect(originFiles).toContain('normal.txt');
      // The repair is private: no tracked .gitignore appears in the user's repository.
      expect(originFiles).not.toContain('.gitignore');
      expect(readFileSync(recordPath, 'utf8')).toBe(storeLine);
      expect(git(repo, 'check-ignore', '-v', '--no-index', record)).toContain('info/exclude');
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(logs.join('\n')).toContain(`removed legacy tracked ${record} from the index`);
    });

    it('never commits a freshly written record, and writes the exclude rule once', async () => {
      mkdirSync(join(repo, '.papercusp'), { recursive: true });
      writeFileSync(join(repo, record), storeLine);
      writeFileSync(join(repo, 'normal.txt'), 'agent work\n');

      expect((await runGitSync('test', { repoPath: repo, config: cfg })).status).toBe('synced');
      writeFileSync(join(repo, 'normal.txt'), 'more agent work\n');
      expect((await runGitSync('test', { repoPath: repo, config: cfg })).status).toBe('synced');

      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(record);
      expect(git(originDir, 'show', 'main:normal.txt')).toBe('more agent work');
      const rules = readFileSync(excludeFile(), 'utf8').split('\n').filter((l) => l === `/${record}`);
      expect(rules).toHaveLength(1);
    });

    it("leaves info/exclude alone when the repo's own .gitignore already ignores the record", async () => {
      // Papercusp's own tree: its root .gitignore names the record (WI-10005159).
      writeFileSync(join(repo, '.gitignore'), readFileSync(join(REPO_ROOT, '.gitignore')));
      mkdirSync(join(repo, '.papercusp'), { recursive: true });
      writeFileSync(join(repo, record), storeLine);

      expect((await runGitSync('test', { repoPath: repo, config: cfg })).status).toBe('synced');

      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(record);
      let exclude = '';
      try {
        exclude = readFileSync(excludeFile(), 'utf8');
      } catch {
        exclude = '';
      }
      expect(exclude).not.toContain(`/${record}`);
    });
  });

  it('WI-40770: a live-held dirty path stays excluded while the unlocked remainder syncs', async () => {
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');

    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['file.txt'],
      liveLockHoldings: [{
        path: 'file.txt',
        owner: 'su-peer',
        intent: 'editing the source half of an atomic change',
      }],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toEqual([{
      scope: 'superproject',
      path: 'file.txt',
      owner: 'su-peer',
      intent: 'editing the source half of an atomic change',
    }]);
    expect(logs.join('\n')).toContain('committing the unlocked remainder');

    // The protected edit remains local, while unrelated finished work reaches origin.
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt', 'normal.txt')).toMatch(/file\.txt/);
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt', 'normal.txt')).not.toMatch(/normal\.txt/);
  });

  it('EI-24492316853292543: a lock without goal attribution keeps its dirty Cargo package whole', async () => {
    mkdirSync(join(repo, 'apps/tui/src'), { recursive: true });
    writeFileSync(join(repo, 'apps/tui/Cargo.toml'), '[package]\nname = "pui"\nversion = "0.1.0"\n');
    writeFileSync(join(repo, 'apps/tui/src/main.rs'), 'fn main() {}\n');
    writeFileSync(join(repo, 'apps/tui/src/self_install.rs'), 'pub fn install() {}\n');
    writeFileSync(join(repo, 'apps/tui/src/voice_proxy.rs'), 'pub fn proxy() {}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed a Rust package');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, 'apps/tui/src/main.rs'), 'mod fresh_exec;\nfn main() {}\n');
    writeFileSync(join(repo, 'apps/tui/src/fresh_exec.rs'), 'pub fn spawn() {}\n');
    writeFileSync(join(repo, 'apps/tui/src/self_install.rs'), 'pub fn install() { crate::fresh_exec::spawn(); }\n');
    writeFileSync(join(repo, 'apps/tui/src/voice_proxy.rs'), 'pub fn proxy() { crate::fresh_exec::spawn(); }\n');
    writeFileSync(join(repo, 'normal.txt'), 'unrelated work\n');

    const lockedMain = {
      path: 'apps/tui/src/main.rs',
      owner: 'su-peer',
      intent: 'editing the PUI crate root',
    };
    const logs: string[] = [];
    const first = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      liveLockHoldings: [lockedMain],
      log: (message) => logs.push(message),
    });

    expect(first.status).toBe('synced');
    expect(first.skippedPaths).toContainEqual({ scope: 'superproject', ...lockedMain });
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('unrelated work');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('apps/tui/src/fresh_exec.rs');
    expect(git(originDir, 'show', 'main:apps/tui/src/self_install.rs')).toBe('pub fn install() {}');
    expect(git(originDir, 'show', 'main:apps/tui/src/voice_proxy.rs')).toBe('pub fn proxy() {}');
    expect(git(repo, 'status', '--porcelain', '--', 'apps/tui')).toMatch(/apps\/tui/);
    expect(logs.join('\n')).toContain('keeping dirty Rust package(s) atomic');

    const second = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(second.status).toBe('synced');
    expect(git(originDir, 'show', 'main:apps/tui/src/main.rs')).toContain('mod fresh_exec;');
    expect(git(originDir, 'show', 'main:apps/tui/src/self_install.rs')).toContain('crate::fresh_exec::spawn()');
    expect(git(originDir, 'show', 'main:apps/tui/src/voice_proxy.rs')).toContain('crate::fresh_exec::spawn()');
    expect(git(originDir, 'show', 'main:apps/tui/src/fresh_exec.rs')).toBe('pub fn spawn() {}');
  });

  it('EI-24492316853292543: a lock arriving after staging unstages the rest of its Cargo package', async () => {
    mkdirSync(join(repo, 'apps/tui/src'), { recursive: true });
    writeFileSync(join(repo, 'apps/tui/Cargo.toml'), '[package]\nname = "pui"\nversion = "0.1.0"\n');
    writeFileSync(join(repo, 'apps/tui/src/main.rs'), 'fn main() {}\n');
    writeFileSync(join(repo, 'apps/tui/src/self_install.rs'), 'pub fn install() {}\n');
    writeFileSync(join(repo, 'apps/tui/src/voice_proxy.rs'), 'pub fn proxy() {}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed a Rust package for a late lock');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, 'apps/tui/src/main.rs'), 'mod fresh_exec;\nfn main() {}\n');
    writeFileSync(join(repo, 'apps/tui/src/fresh_exec.rs'), 'pub fn spawn() {}\n');
    writeFileSync(join(repo, 'apps/tui/src/self_install.rs'), 'pub fn install() { crate::fresh_exec::spawn(); }\n');
    writeFileSync(join(repo, 'apps/tui/src/voice_proxy.rs'), 'pub fn proxy() { crate::fresh_exec::spawn(); }\n');
    writeFileSync(join(repo, 'normal.txt'), 'unrelated work\n');

    const lockedMain = {
      path: 'apps/tui/src/main.rs',
      owner: 'su-probe',
      intent: 'lock acquired after the pre-stage census',
    };
    let refreshes = 0;
    const refreshLiveLockHoldings = vi.fn(async () => {
      refreshes += 1;
      return refreshes === 1 ? [] : [lockedMain];
    });
    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings,
      log: (message) => logs.push(message),
    });

    expect(refreshLiveLockHoldings).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toContainEqual({ scope: 'superproject', ...lockedMain });
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('unrelated work');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('apps/tui/src/fresh_exec.rs');
    expect(git(originDir, 'show', 'main:apps/tui/src/self_install.rs')).toBe('pub fn install() {}');
    expect(git(originDir, 'show', 'main:apps/tui/src/voice_proxy.rs')).toBe('pub fn proxy() {}');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', 'apps/tui')).toMatch(/apps\/tui/);
    expect(logs.join('\n')).toContain('same Cargo package');
  });

  it('WI-1834529: a staggered lock defers the whole attributed source/test cohort', async () => {
    const sourcePath = 'source.ts';
    const testPath = 'source.test.ts';
    const normalPath = 'normal.txt';
    writeFileSync(join(repo, sourcePath), 'export const value = 1;\n');
    writeFileSync(join(repo, testPath), "import { value } from './source';\nexport const observed = value;\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed atomic edit cohort');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, sourcePath), 'export const value = 2;\n');
    writeFileSync(join(repo, testPath), "import { value } from './source';\nexport const observed = value + 1;\n");
    writeFileSync(join(repo, normalPath), 'unrelated work\n');

    const workItem = 'WI-1834529';
    const roster = [{
      agent: 'su-peer',
      intent: 'finish the source and test together',
      files: [sourcePath, testPath],
      workItems: [workItem],
    }];
    const logs: string[] = [];
    const first = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      excludePaths: [sourcePath],
      liveLockHoldings: [{
        path: sourcePath,
        owner: 'su-peer',
        intent: 'editing source',
        goalRef: workItem,
      }],
      loadRoster: async () => roster,
      log: (message) => logs.push(message),
    });

    expect(first.status).toBe('synced');
    expect(git(originDir, 'show', `main:${sourcePath}`)).toBe('export const value = 1;');
    expect(git(originDir, 'show', `main:${testPath}`)).toContain('observed = value;');
    expect(git(originDir, 'show', `main:${normalPath}`)).toBe('unrelated work');
    expect(git(repo, 'status', '--porcelain', '--', sourcePath, testPath)).toMatch(/source(?:\.test)?\.ts/);
    expect(logs.join('\n')).toContain('keeping 1 live edit cohort(s) atomic');

    // Once the staggered source lock is gone, both dirty files can publish together;
    // the first pass must not have left a source/test split in the remote tree.
    const second = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      loadRoster: async () => roster,
    });

    expect(second.status).toBe('synced');
    expect(git(originDir, 'show', `main:${sourcePath}`)).toBe('export const value = 2;');
    expect(git(originDir, 'show', `main:${testPath}`)).toContain('observed = value + 1;');
    expect(git(repo, 'status', '--porcelain', '--', sourcePath, testPath)).toBe('');
    expect(git(originDir, 'log', '--format=%B', 'main')).toContain(`Papercusp-Work-Item: ${workItem}`);
  });

  it('EI-22485648475962061: a locked untracked dependency holds back its dirty importer while unrelated work syncs', async () => {
    const dependencyPath = 'new-dep.ts';
    const importerPath = 'importer.ts';
    const controlPath = 'control.ts';

    // Seed the importer so the first pass exercises a dirty tracked importer,
    // matching the production failure rather than only an all-new pair.
    writeFileSync(join(repo, importerPath), 'export const value = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed importer');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, dependencyPath), 'export const dep = 42;\n');
    writeFileSync(join(repo, importerPath), "import { dep } from './new-dep';\nexport const value = dep;\n");
    writeFileSync(join(repo, controlPath), 'export const control = true;\n');

    const logs: string[] = [];
    const first = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      liveLockHoldings: [{
        path: dependencyPath,
        owner: 'su-peer',
        intent: 'PreToolUse:Write',
      }],
      log: (message) => logs.push(message),
    });

    expect(first.status).toBe('synced');
    expect(git(originDir, 'show', `main:${importerPath}`)).toBe('export const value = 1;');
    expect(git(originDir, 'show', `main:${controlPath}`)).toBe('export const control = true;');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(dependencyPath);
    expect(first.contentErrors).toEqual([
      expect.objectContaining({
        file: importerPath,
        detectorKey: 'quarantined-importer',
        // WI-6554700010008496: names the holder, not just the generic exclusion phase.
        error: expect.stringContaining('held by su-peer — PreToolUse:Write'),
        excludedRoot: dependencyPath,
        excludedRootReason: 'held by su-peer — PreToolUse:Write',
      }),
    ]);
    expect(git(repo, 'status', '--porcelain', '--', dependencyPath, importerPath)).toMatch(
      /(?:new-dep|importer)\.ts/,
    );
    expect(git(repo, 'status', '--porcelain', '--', controlPath)).toBe('');

    // Once the lock is gone, the dependency and importer publish together and
    // the previous pass has not left a broken remote tree behind.
    const second = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
    });

    expect(second.status).toBe('synced');
    expect(git(originDir, 'show', `main:${dependencyPath}`)).toBe('export const dep = 42;');
    expect(git(originDir, 'show', `main:${importerPath}`)).toContain('export const value = dep;');
    expect(git(repo, 'status', '--porcelain', '--', dependencyPath, importerPath)).toBe('');
  });

  it('does not hold an importer for a clean tracked dependency protected by a live lock', async () => {
    const exporterPath = 'exporter.ts';
    const importerPath = 'importer.ts';
    const controlPath = 'control.ts';
    writeFileSync(join(repo, exporterPath), 'export const oldValue = 1;\n');
    writeFileSync(join(repo, importerPath),
      "import { oldValue } from './exporter';\nexport const value = oldValue;\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed clean locked exporter');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, importerPath),
      "import { oldValue } from './exporter';\nexport const value = oldValue + 1;\n");
    writeFileSync(join(repo, controlPath), 'export const control = true;\n');

    const logs: string[] = [];
    const first = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      liveLockHoldings: [{ path: exporterPath, owner: 'su-peer', intent: 'reviewing exporter' }],
      log: (message) => logs.push(message),
    });

    expect(first.status).toBe('synced');
    expect(first.contentErrors).not.toContainEqual(expect.objectContaining({
      file: importerPath,
      detectorKey: 'quarantined-importer',
    }));
    expect(logs.join('\n')).not.toContain("post-stage guard: importer.ts imports './exporter'");
    expect(
      git(originDir, 'show', 'main:' + importerPath).includes('oldValue + 1'),
      JSON.stringify({ contentErrors: first.contentErrors, relevantLogs: logs.filter((line) => /import|commit|unstage|exclude/i.test(line)) }),
    ).toBe(true);
    expect(git(originDir, 'show', 'main:' + exporterPath)).toBe('export const oldValue = 1;');
    expect(git(originDir, 'show', 'main:' + controlPath)).toBe('export const control = true;');
    expect(git(repo, 'status', '--porcelain', '--', importerPath, exporterPath, controlPath)).toBe('');
  });

  it('EI-24269368801794879: a locked tracked exporter holds back a dirty importer of its new symbol', async () => {
    const exporterPath = 'exporter.ts';
    const importerPath = 'importer.ts';
    const controlPath = 'control.ts';
    writeFileSync(join(repo, exporterPath), 'export const oldValue = 1;\n');
    writeFileSync(join(repo, importerPath), "import { oldValue } from './exporter';\nexport const value = oldValue;\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed exporter and importer');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, exporterPath), 'export const oldValue = 1;\nexport const newValue = 2;\n');
    writeFileSync(join(repo, importerPath), "import { newValue } from './exporter';\nexport const value = newValue;\n");
    writeFileSync(join(repo, controlPath), 'export const control = true;\n');

    const first = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      liveLockHoldings: [{ path: exporterPath, owner: 'su-peer', intent: 'editing exporter' }],
    });

    expect(first.status).toBe('synced');
    expect(first.contentErrors).toContainEqual(expect.objectContaining({
      file: importerPath,
      detectorKey: 'quarantined-importer',
      error: expect.stringContaining('held by '),
      excludedRoot: exporterPath,
      excludedRootReason: expect.stringMatching(/^held by /),
    }));
    expect(git(originDir, 'show', `main:${exporterPath}`)).not.toContain('newValue');
    expect(git(originDir, 'show', `main:${importerPath}`)).not.toContain('newValue');
    expect(git(originDir, 'show', `main:${controlPath}`)).toBe('export const control = true;');

    const second = await runGitSync('test', { repoPath: repo, runGit: directRunGit, config: cfg });
    expect(second.status).toBe('synced');
    expect(git(originDir, 'show', `main:${exporterPath}`)).toContain('newValue');
    expect(git(originDir, 'show', `main:${importerPath}`)).toContain('newValue');
    expect(git(repo, 'status', '--porcelain', '--', exporterPath, importerPath)).toBe('');
  });

  it('WI-6554700010008411: a staged export removal stays with a quarantined importer whose HEAD still imports it', async () => {
    const excludedPath = 'start.ts';
    const importerPath = 'audit.ts';
    const providerPath = 'slug-scope.ts';
    const controlPath = 'control.ts';
    writeFileSync(join(repo, providerPath), 'export function requireUnambiguousSlugScope() { return true; }\n');
    writeFileSync(join(repo, importerPath),
      "import { requireUnambiguousSlugScope } from './slug-scope';\nexport const scope = requireUnambiguousSlugScope();\n");
    writeFileSync(join(repo, excludedPath), 'export const start = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed importer and provider API');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, excludedPath), 'export const start = 2; // BROKEN\n');
    // The working tree drops the old API import, but this file is held because it now
    // consumes an excluded dependency; its HEAD version still imports the old export.
    writeFileSync(join(repo, importerPath), "import { start } from './start';\nexport const scope = start;\n");
    writeFileSync(join(repo, providerPath), 'export const unrelated = 1;\n');
    writeFileSync(join(repo, controlPath), 'export const control = true;\n');
    const detector: ContentDetector = {
      key: 'fake-broken-dependency',
      glob: '**/start.ts',
      matches: file => file === excludedPath,
      detect: (_file, text) => text.includes('BROKEN') ? 'contains BROKEN' : null,
      fixerRole: 'content-fixer',
    };
    const logs: string[] = [];

    const first = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      contentDetectors: [detector],
      log: message => logs.push(message),
    });

    expect(first.status).toBe('synced');
    expect(first.contentErrors.some(row => row.file === importerPath && row.detectorKey === 'quarantined-importer')).toBe(true);
    expect(logs.join('\n')).toContain('staged providers with held HEAD consumers [slug-scope.ts]');
    expect(git(originDir, 'show', `main:${providerPath}`)).toContain('requireUnambiguousSlugScope');
    expect(git(originDir, 'show', `main:${importerPath}`)).toContain('requireUnambiguousSlugScope');
    expect(git(originDir, 'show', `main:${excludedPath}`)).toBe('export const start = 1;');
    expect(git(originDir, 'show', `main:${controlPath}`)).toBe('export const control = true;');
    expect(git(repo, 'status', '--porcelain', '--', excludedPath, importerPath, providerPath)).toMatch(/(?:start|audit|slug-scope)\.ts/);

    // Once the quarantined dependency is fixed, all three mutually dependent edits can
    // land together and the safety hold clears without manual cleanup.
    writeFileSync(join(repo, excludedPath), 'export const start = 2;\n');
    const recovered = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      contentDetectors: [detector],
    });
    expect(recovered.status).toBe('synced');
    expect(recovered.contentErrors).toEqual([]);
    expect(git(originDir, 'show', `main:${providerPath}`)).toBe('export const unrelated = 1;');
    expect(git(originDir, 'show', `main:${importerPath}`)).toContain("from './start'");
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-25203309445902479: a new importer created after the dirty census is held with its excluded dependencies', async () => {
    const quarantinedPath = 'quarantined-export.ts';
    const lockedPath = 'locked-export.ts';
    const importerPath = 'staged-deletion-hold.test.ts';
    const controlPath = 'control.txt';
    const detector: ContentDetector = {
      key: 'fake-broken-module',
      glob: '**/quarantined-export.ts',
      matches: (file) => file.endsWith('quarantined-export.ts'),
      detect: (_file, text) => (text.includes('BROKEN') ? 'contains BROKEN' : null),
      fixerRole: 'content-fixer',
    };
    writeFileSync(join(repo, quarantinedPath), 'export const quarantinedSymbol = 1;\nBROKEN\n');
    writeFileSync(join(repo, lockedPath), 'export const lockedSymbol = 2;\n');
    writeFileSync(join(repo, controlPath), 'unrelated work\n');

    // The first live-lock refresh runs after the initial dirty census. Model a new
    // untracked test file arriving in that window, importing both a content-quarantined
    // module and a live-locked module. `git add -A` will see the test even though the
    // earlier importer pass did not.
    let refreshes = 0;
    const refreshLiveLockHoldings = vi.fn(async () => {
      refreshes += 1;
      if (refreshes === 1) {
        writeFileSync(
          join(repo, importerPath),
          `import { quarantinedSymbol } from './quarantined-export';\n` +
            `import { lockedSymbol } from './locked-export';\n` +
            `export const value = quarantinedSymbol + lockedSymbol;\n`,
        );
      }
      return [{ path: lockedPath, owner: 'su-peer', intent: 'editing a new exporter' }];
    });
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      contentDetectors: [detector],
      refreshLiveLockHoldings,
      log: (message) => logs.push(message),
    });

    expect(refreshLiveLockHoldings).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('synced');
    const committed = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(committed).toContain(controlPath);
    expect(committed).not.toContain(importerPath);
    expect(committed).not.toContain(quarantinedPath);
    expect(committed).not.toContain(lockedPath);
    expect(logs.join('\n')).toContain(importerPath);
    expect(git(repo, 'status', '--porcelain', '--', importerPath)).toMatch(/staged-deletion-hold\.test\.ts/);
  });

  it('WI-40770: a repo with only live-held dirty paths still reports skipped-locked', async () => {
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      // Holder provenance alone is sufficient to protect the path; callers cannot
      // accidentally omit the parallel exclusion projection and commit through a lock.
      liveLockHoldings: [{
        path: 'file.txt',
        owner: 'su-peer',
        intent: 'editing the source half of an atomic change',
      }],
    });

    expect(out.status).toBe('skipped-locked');
    expect(out.skippedPaths).toEqual([{
      scope: 'superproject',
      path: 'file.txt',
      owner: 'su-peer',
      intent: 'editing the source half of an atomic change',
    }]);
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
  });

  it('EI-21444216858331991: regenerates and commits an attributed source with its declaration atomically', async () => {
    const generator = join(repo, 'scripts', 'gen-declarations.ts');
    const config = join(repo, 'tsconfig.declarations.json');
    const sourceRel = 'apps/operator/scripts/psu-launcher.mjs';
    const artifactRel = 'apps/operator/scripts/psu-launcher.d.mts';
    const source = join(repo, sourceRel);
    const artifact = join(repo, artifactRel);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'operator', 'scripts'), { recursive: true });
    writeFileSync(generator, '// declaration generator fixture\n');
    writeFileSync(config, '{"files":["apps/operator/scripts/psu-launcher.mjs"]}\n');
    writeFileSync(join(repo, 'package.json'), '{"private":true}\n');
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(source, 'export const version = 1;\n');
    writeFileSync(artifact, 'export declare const version = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed declaration fixture');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(source, 'export const version = 2;\n');
    const runGenerator = vi.fn(async (repoPath: string) => {
      expect(readFileSync(join(repoPath, sourceRel), 'utf8')).toContain('version = 2');
      writeFileSync(join(repoPath, artifactRel), 'export declare const version = 2;\n');
      return { code: 0, stdout: 'emitted declaration', stderr: '' };
    });
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      generatedDeclarationsRegenerator: (context) => regenerateGeneratedDeclarationsBeforeCommit(context, runGenerator),
      loadRoster: async () => [
        {
          agent: 'cup-declarations',
          agentLabel: 'Declaration Author',
          intent: 'change the launcher source',
          files: [sourceRel],
        },
      ],
    });

    expect(out.status).toBe('synced');
    expect(runGenerator).toHaveBeenCalledOnce();
    expect(git(originDir, 'show', `main:${sourceRel}`)).toContain('version = 2');
    expect(git(originDir, 'show', `main:${artifactRel}`)).toContain('version = 2');
    const sourceCommit = git(originDir, 'log', '-1', '--format=%H', 'main', '--', sourceRel);
    const artifactCommit = git(originDir, 'log', '-1', '--format=%H', 'main', '--', artifactRel);
    expect(sourceCommit).toBe(artifactCommit);
    expect(originLog()).not.toMatch(/change the launcher source/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-21444216858331991 + WI-6554700010010659: a failed declaration emit holds the pair and the compiler-named file, not the tree', async () => {
    const generator = join(repo, 'scripts', 'gen-declarations.ts');
    const config = join(repo, 'tsconfig.declarations.json');
    const sourceRel = 'apps/operator/scripts/psu-launcher.mjs';
    const artifactRel = 'apps/operator/scripts/psu-launcher.d.mts';
    const source = join(repo, sourceRel);
    const artifact = join(repo, artifactRel);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'operator', 'scripts'), { recursive: true });
    writeFileSync(generator, '// declaration generator fixture\n');
    writeFileSync(config, '{"files":["apps/operator/scripts/psu-launcher.mjs"]}\n');
    writeFileSync(source, 'export const version = 1;\n');
    writeFileSync(artifact, 'export declare const version = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed declaration fixture');
    git(repo, 'push', 'origin', 'main');

    // WI-6554700010010659: a TS file the declarations program reaches, and an
    // unrelated file, both tracked before the failing pass.
    const culpritRel = 'packages/operator-core/lib/verifier-source.ts';
    const unrelatedRel = 'docs/unrelated.md';
    mkdirSync(join(repo, 'packages', 'operator-core', 'lib'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, culpritRel), "export const verifier = 'v1';\n");
    writeFileSync(join(repo, unrelatedRel), 'unrelated v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed culprit and unrelated fixture');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(source, 'export const version = 2;\n');
    writeFileSync(join(repo, culpritRel), "import { x } from './process-identity.ts';\nexport const verifier = x;\n");
    writeFileSync(join(repo, unrelatedRel), 'unrelated v2\n');
    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
      generatedDeclarationsRegenerator: (context) =>
        regenerateGeneratedDeclarationsBeforeCommit(context, async () => ({
          code: 1,
          stdout: '',
          stderr:
            'tsc failed:\n' +
            `${culpritRel}(1,19): error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.\n` +
            // CONTROL: a clean file the compiler names is neither held nor reported.
            "scripts/clean-elsewhere.ts(3,1): error TS2304: Cannot find name 'y'.\n",
        })),
    });

    // The rest of the tree commits; the pair and the compiler-named dirty file do not.
    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', `main:${unrelatedRel}`)).toContain('unrelated v2');
    expect(git(originDir, 'show', `main:${sourceRel}`)).toContain('version = 1');
    expect(git(originDir, 'show', `main:${artifactRel}`)).toContain('version = 1');
    expect(git(originDir, 'show', `main:${culpritRel}`)).toContain("'v1'");
    expect(git(repo, 'status', '--porcelain', '--', sourceRel)).toMatch(/psu-launcher\.mjs/);
    expect(git(repo, 'status', '--porcelain', '--', culpritRel)).toMatch(/verifier-source\.ts/);
    const declarationOffenders = out.contentErrors.filter((row) => row.detectorKey === 'declarations-tsc');
    expect(declarationOffenders.map((row) => row.file)).toEqual([culpritRel]);
    expect(declarationOffenders[0]).toMatchObject({ fixerRole: 'content-fixer' });
    expect(declarationOffenders[0].error).toContain('TS5097');
    expect(logs.join('\n')).toMatch(/declaration regeneration failed/);
    expect(logs.join('\n')).toContain(`including 1 dirty file(s) its diagnostics name (${culpritRel})`);
  });

  it('WI-39922: a generator failure remains fail-soft and the tool source still commits', async () => {
    const generator = join(repo, 'scripts', 'gen-tool-catalog.ts');
    const catalog = join(repo, '.papercusp', 'tool-catalog.json');
    const tool = join(repo, 'packages', 'operator-core', 'lib', 'agent-tools', 'example.ts');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, '.papercusp'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'operator-core', 'lib', 'agent-tools'), { recursive: true });
    writeFileSync(generator, '// generator fixture\n');
    writeFileSync(catalog, '{"count":0}\n');
    writeFileSync(tool, 'export const version = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed catalog fixture');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(tool, 'export const version = 2;\n');
    const logs: string[] = [];
    const runGenerator = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'registry import failed on a half-written peer module',
    }));
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
      toolCatalogRegenerator: (context) => regenerateToolCatalogBeforeCommit(context, runGenerator),
    });

    expect(runGenerator).toHaveBeenCalledOnce();
    expect(out.status).toBe('synced');
    expect(logs.join('\n')).toMatch(/tool-catalog regeneration failed.*continuing with the commit fail-soft/);
    expect(git(originDir, 'show', 'main:packages/operator-core/lib/agent-tools/example.ts')).toContain('version = 2');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-20428405431869483: a failed routing check remains fail-soft and the affected pair still commits', async () => {
    const generator = join(repo, 'scripts', 'gen-tool-routing.ts');
    const routingTable = join(repo, 'packages', 'operator-core', 'lib', 'bash-substitution', 'routing-table.ts');
    const pair = join(repo, 'packages', 'operator-core', 'lib', 'bash-substitution', 'pairs', 'dependency-install.ts');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'operator-core', 'lib', 'bash-substitution', 'pairs'), { recursive: true });
    writeFileSync(generator, '// routing generator fixture\n');
    writeFileSync(routingTable, '// routing table fixture\n');
    writeFileSync(pair, 'export const version = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed routing fixture');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(pair, 'export const version = 2;\n');
    const logs: string[] = [];
    const runCheck = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'canonical routing part is stale',
    }));
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
      toolRoutingChecker: (context) => checkToolRoutingBeforeCommit(context, runCheck),
    });

    expect(runCheck).toHaveBeenCalledOnce();
    expect(out.status).toBe('synced');
    expect(logs.join('\n')).toMatch(/generated tool-routing check failed.*continuing with the commit fail-soft/);
    expect(git(originDir, 'show', 'main:packages/operator-core/lib/bash-substitution/pairs/dependency-install.ts')).toContain('version = 2');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it.each([false, true])('F6/EI-20349517520985072: HTTPS fallback reauthorizes its push (revoked=%s)', async (revoked) => {
    writeFileSync(join(repo, 'https-fallback.txt'), 'credential-plane fallback\n');
    const rewrite = 'url.https://github.com/.insteadOf=git@github.com:';
    const calls: string[][] = [];
    const failedOnce = new Set<string>();
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      const command = args[0];
      if ((command === 'fetch' || command === 'push') && !failedOnce.has(command)) {
        failedOnce.add(command);
        return { code: 128, stdout: '', stderr: 'git@github.com: Permission denied (publickey).\n' };
      }
      return realRunGit(args, cwd);
    };

    const beforePush = vi.fn(async (args: readonly string[]) => {
      if (revoked && args[0] === '-c') throw new Error('owner key no longer available');
    });
    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg, beforePush });

    expect(beforePush.mock.calls.map(([args]) => args)).toEqual([
      ['push', 'origin', 'HEAD:main'],
      ['-c', rewrite, 'push', 'origin', 'HEAD:main'],
    ]);
    expect(failedOnce).toEqual(new Set(['fetch', 'push']));
    expect(calls.filter((args) => args[0] === '-c' && args[1] === rewrite)).toEqual([
      ['-c', rewrite, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ...(!revoked ? [['-c', rewrite, 'push', 'origin', 'HEAD:main']] : []),
    ]);
    if (revoked) {
      expect(out.status).toBe('error');
      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('https-fallback.txt');
      expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('https-fallback.txt');
    } else {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') expect(out.pushed).toContain('superproject');
      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('https-fallback.txt');
    }
  });

  it('WI-2144358: retries an unresolved GitHub SSH account alias through configured HTTPS credentials', async () => {
    writeFileSync(join(repo, 'ssh-alias-fallback.txt'), 'account-alias transport fallback\n');
    const aliasUrl = 'git@github.com-git-graph:papercupai/git-graph.git';
    const rewrite = 'url.https://github.com/.insteadOf=git@github.com-git-graph:';
    const calls: string[][] = [];
    const failedOnce = new Set<string>();
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      const command = args[0];
      if (command === 'remote' && args[1] === 'get-url') {
        return { code: 0, stdout: `${aliasUrl}\n`, stderr: '' };
      }
      if ((command === 'fetch' || command === 'push') && !failedOnce.has(command)) {
        failedOnce.add(command);
        return {
          code: 128,
          stdout: '',
          stderr: 'ssh: Could not resolve hostname github.com-git-graph: Name or service not known\n',
        };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    expect(failedOnce).toEqual(new Set(['fetch', 'push']));
    expect(calls.filter((args) => args[0] === '-c' && args[1] === rewrite)).toEqual([
      ['-c', rewrite, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['-c', rewrite, 'push', 'origin', 'HEAD:main'],
    ]);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('ssh-alias-fallback.txt');
  });

  it('EI-20378687739683215: retries a GitHub SSH email-verification rejection through HTTPS', async () => {
    writeFileSync(join(repo, 'email-verification-fallback.txt'), 'verified automation account\n');
    const rewrite = 'url.https://github.com/.insteadOf=git@github.com:';
    const calls: string[][] = [];
    let rejectedPush = false;
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { code: 0, stdout: 'git@github.com:Papercusp/papercup.git\n', stderr: '' };
      }
      if (args[0] === 'push' && !rejectedPush) {
        rejectedPush = true;
        return { code: 1, stdout: '', stderr: 'remote: You must verify your email address.\n' };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    expect(calls).toContainEqual(['remote', 'get-url', 'origin']);
    expect(calls.filter((args) => args[0] === '-c' && args[1] === rewrite)).toEqual([
      ['-c', rewrite, 'push', 'origin', 'HEAD:main'],
    ]);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain(
      'email-verification-fallback.txt',
    );
  });

  it('EI-20378687739683215: does not rewrite a non-GitHub email-verification rejection', async () => {
    writeFileSync(join(repo, 'no-email-fallback.txt'), 'retain the original error\n');
    const calls: string[][] = [];
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === 'push') {
        return { code: 1, stdout: '', stderr: 'remote: You must verify your email address.\n' };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    expect(out.status).toBe('error');
    expect(calls).toContainEqual(['remote', 'get-url', 'origin']);
    expect(calls.some((args) => args.some((arg) => arg.includes('insteadOf=')))).toBe(false);
  });

  it('EI-20349517520985072: does not rewrite unrelated SSH publickey failures', async () => {
    writeFileSync(join(repo, 'no-fallback.txt'), 'keep the original failure\n');
    const calls: string[][] = [];
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === 'fetch') {
        return { code: 128, stdout: '', stderr: 'git@gitlab.com: Permission denied (publickey).\n' };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    expect(out.status).toBe('error');
    expect(calls.filter((args) => args.includes('fetch'))).toHaveLength(1);
    expect(calls.some((args) => args.some((arg) => arg.includes('insteadOf=')))).toBe(false);
  });

  it('STRANDING GUARD (2026-06-30 root cause): a nested embedded git repo with NO commit does NOT strand the tree — excludes it + retries + commits the real work', async () => {
    // The file that MUST reach origin.
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    // A stray embedded git repo with NO commit — exactly what a green-checkpoint test tmpdir
    // left under .papercusp/.vitest-tmpdir. A naive `git add -A` FATALs on it (exit 128,
    // "does not have a commit checked out") → stages NOTHING → the whole tree strands.
    const stray = join(repo, '.papercusp', '.vitest-tmpdir', 'green-STRAY');
    mkdirSync(stray, { recursive: true });
    git(stray, 'init', '-b', 'main'); // nested .git, NO commit

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    // Before the fix: status 'nothing', real-work.txt stranded forever. After: it recovers.
    expect(out.status).toBe('synced');
    expect(originLog()).toMatch(/auto-commit test/);
    // the real file reached origin (was NOT stranded)
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('real-work.txt');
  });

  it('STALE-LOCK SELF-HEAL (2026-07-04 incident): an ORPHANED .git/index.lock (dead writer, old mtime) is cleared + the tick still syncs', async () => {
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    // Exactly what a git process killed mid-`add -A` leaves behind: a lock file
    // nobody holds. Backdate it past STALE_INDEX_LOCK_MS so it is provably stale.
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, 'partial index the dead writer was building');
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    // Before the fix: EVERY tick failed "Unable to create '….index.lock': File exists"
    // until a human deleted the file. After: self-heals + commits this tick.
    expect(out.status).toBe('synced');
    expect(existsSync(lockPath)).toBe(false);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('real-work.txt');
  });

  it('STALE-LOCK SELF-HEAL: a FRESH index.lock (live writer) is NOT touched — the tick fails instead of robbing the holder', async () => {
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, 'a live git process is writing this'); // mtime = now

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).not.toBe('synced'); // the failure still surfaces (watchdog sees it)
    expect(existsSync(lockPath)).toBe(true); // the live writer keeps its lock
  });

  it('WI-10003529: a CLEAN repo behind origin reclaims an orphaned index.lock at the MERGE (its first index writer) instead of failing "merge failed (no conflicted paths)" every tick', async () => {
    // Upstream advances while the working clone has nothing to commit, so no
    // `git add`/`git commit` ever runs — the merge is the first operation that
    // needs the index lock (the P-203 Mac VM's libs/papercusp-db, 2026-09-27).
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'upstream.txt'), 'from a peer\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'upstream advance');
    git(seed, 'push', 'origin', 'main');
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, ''); // what a git killed by a restart leaves: empty, unheld
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    const metLock: string[] = [];
    const runGit: RunGit = async (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      const res = { code: r.status ?? -1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
      if (res.code !== 0 && isIndexLockFailure(`${res.stdout}\n${res.stderr}`)) metLock.push(args.join(' '));
      return res;
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    // Pin the scenario: the MERGE met the orphan (not an add/commit path, which
    // has had recovery since 2026-07-04) — otherwise this test guards nothing new.
    expect(metLock.length).toBeGreaterThan(0);
    expect(metLock[0]).toMatch(/\bmerge\b/);
    // Before the fix: status 'error' ("merge failed (no conflicted paths)") on every
    // tick until a human deleted the lock. After: reclaimed once, merge proceeds.
    expect(out.status).not.toBe('error');
    expect(existsSync(lockPath)).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(originDir, 'rev-parse', 'main'));
  });

  it('EI-21872458801896676: repairs a truncated canonical index before the dirty census and still commits the working tree', async () => {
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    const indexPath = join(repo, '.git', 'index');
    writeFileSync(indexPath, Buffer.alloc(0));
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(readFileSync(indexPath).length).toBeGreaterThanOrEqual(MIN_VALID_GIT_INDEX_BYTES);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('real-work.txt');
    expect(logs.join('\n')).toMatch(/repaired invalid Git index.*read-tree HEAD/i);
  });

  it('refuses invalid-index repair while a real process holds its descriptor open', async () => {
    const indexPath = join(repo, '.git', 'index');
    writeFileSync(indexPath, Buffer.alloc(0));
    const fd = openSync(indexPath, 'r');
    try {
      const result = await preflightInvalidIndex(directRunGit, repo, () => {});
      expect(result).toMatchObject({ status: 'refused', indexPath });
      if (result.status === 'refused') expect(result.reason).toContain('open by a live writer');
      expect(readFileSync(indexPath).length).toBe(0);
    } finally {
      closeSync(fd);
    }
  });

  it.each([
    ['live writer', true],
    ['unknown writer state', null],
  ] as const)(
    'EI-21872458801896676: refuses a truncated index when the %s cannot be ruled out',
    async (_label, open) => {
      const indexPath = join(repo, '.git', 'index');
      writeFileSync(indexPath, Buffer.alloc(0));
      const calls: string[][] = [];
      const logs: string[] = [];
      const runGit: RunGit = async (args) => {
        calls.push([...args]);
        if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
          return { code: 0, stdout: `${join(repo, '.git')}\n`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      };

      const result = await preflightInvalidIndex(runGit, repo, (message) => logs.push(message), {
        isOpen: async () => open,
      });

      expect(result.status).toBe('refused');
      expect(calls.some((args) => args[0] === 'read-tree')).toBe(false);
      expect(readFileSync(indexPath).length).toBe(0);
      expect(logs.join('\n')).toMatch(/refusing invalid Git index preflight/i);
    },
  );

  it('EI-21872458801896676: refuses a truncated index when index.lock appears during the re-stat window', async () => {
    const indexPath = join(repo, '.git', 'index');
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(indexPath, Buffer.alloc(0));
    let indexReads = 0;
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { code: 0, stdout: `${join(repo, '.git')}\n`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await preflightInvalidIndex(runGit, repo, () => {}, {
      isOpen: async () => false,
      inspectFile: async (path) => {
        if (path === indexPath) {
          indexReads++;
          return { size: 0, mtimeMs: 1, dev: 1, ino: 1, isFile: true };
        }
        if (path === lockPath && indexReads >= 2) {
          return { size: 0, mtimeMs: 1, dev: 1, ino: 2, isFile: true };
        }
        return null;
      },
    });

    expect(result.status).toBe('refused');
    expect(calls.some((args) => args[0] === 'read-tree')).toBe(false);
  });

  it('EI-20345390379109755: an orphaned config.lock is cleared before canonical submodule URL sync retries', async () => {
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    const lockPath = join(repo, '.git', 'config.lock');
    writeFileSync(lockPath, '');
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    let urlSyncAttempts = 0;
    const runGit: RunGit = async (args, cwd) => {
      if (args.join(' ') === 'submodule sync --recursive' && urlSyncAttempts++ === 0) {
        return {
          code: 1,
          stdout: '',
          stderr: `error: could not lock config file ${join(repo, '.git', 'config')}: File exists`,
        };
      }
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      runGit,
      submodulePaths: [],
      config: { ...cfg, pushSubmodules: true, pushSubmoduleOrigins: false },
      // WI-6554700010011004: pin the holder probe. The real one (fuser, then a /proc
      // scan) answers UNKNOWN on a slow process table, and UNKNOWN rightly keeps the lock.
      isGitLockOpen: async () => false,
    });

    expect(out.status).toBe('synced');
    expect(urlSyncAttempts).toBe(2);
    expect(existsSync(lockPath)).toBe(false);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('real-work.txt');
  }, 30_000);

  it.each([
    ['unknown', null],
    ['still open', true],
  ] as const)(
    'WI-6554700010011004: a config.lock whose holder is %s is preserved while the retried sync still lands',
    async (_label, holder) => {
      writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
      const lockPath = join(repo, '.git', 'config.lock');
      writeFileSync(lockPath, '');
      const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
      utimesSync(lockPath, tenMinAgo, tenMinAgo);

      let urlSyncAttempts = 0;
      const probed: string[] = [];
      const runGit: RunGit = async (args, cwd) => {
        if (args.join(' ') === 'submodule sync --recursive' && urlSyncAttempts++ === 0) {
          return {
            code: 1,
            stdout: '',
            stderr: `error: could not lock config file ${join(repo, '.git', 'config')}: File exists`,
          };
        }
        const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
        return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      };

      const out = await runGitSync('test', {
        repoPath: repo,
        runGit,
        submodulePaths: [],
        config: { ...cfg, pushSubmodules: true, pushSubmoduleOrigins: false },
        isGitLockOpen: async (path) => {
          probed.push(path);
          return holder;
        },
      });

      // The exact signature first seen under load: the retried sync lands, the guard keeps the lock.
      expect(out.status).toBe('synced');
      expect(urlSyncAttempts).toBe(2);
      expect(probed.length).toBeGreaterThan(0);
      expect(probed.every((path) => path.endsWith('config.lock'))).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
    },
    30_000,
  );

  it('isIndexLockFailure matches the git fatal (and only it)', () => {
    expect(
      isIndexLockFailure(
        "fatal: Unable to create '/x/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running",
      ),
    ).toBe(true);
    expect(isIndexLockFailure("error: 'x/' does not have a commit checked out")).toBe(false);
    expect(isIndexLockFailure('')).toBe(false);
  });

  it('isConfigLockFailure matches the git fatal (and only it)', () => {
    expect(isConfigLockFailure('error: could not lock config file /x/repo/.git/config: File exists')).toBe(true);
    expect(isConfigLockFailure("fatal: Unable to create '/x/repo/.git/index.lock': File exists")).toBe(false);
    expect(isConfigLockFailure('')).toBe(false);
  });

  it('clearStaleIndexLock unit edges: already-gone lock ⇒ retry ok; unlink failure ⇒ no retry', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const logs: string[] = [];
    // One STABLE snapshot: clearStaleIndexLock inspects before and after the holder
    // check and refuses when the two differ (WI-10006519).
    const orphan = { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 };
    // lock vanished between the failure and the heal (holder finished) — retry is safe
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        inspectLock: async () => null,
        hasLiveHolder: async () => false,
      }),
    ).toBe(true);
    // stale but unlink throws (permissions) — do NOT claim healed
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        inspectLock: async () => orphan,
        hasLiveHolder: async () => false,
        unlinkFile: async () => {
          throw new Error('EACCES');
        },
      }),
    ).toBe(false);
  });

  it('clearStaleIndexLock LIVE-HOLDER guard (EI-22703121889295786): an mtime-stale index.lock still held open by a live process is NEVER unlinked', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const logs: string[] = [];
    const unlinked: string[] = [];
    const orphan = { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 };
    // mtime says stale (staleMs:0 makes ANY age stale), but a live writer holds the fd —
    // this is the exact shape that truncated the canonical index to 0 bytes.
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        inspectLock: async () => orphan,
        staleMs: 0,
        hasLiveHolder: async () => true,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(false);
    expect(unlinked).toEqual([]);
    expect(logs.some((m) => m.includes('FRESH-BY-HOLDER'))).toBe(true);
    // same lock, same age, but no live holder ⇒ the stale-orphan path unlinks as before
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        inspectLock: async () => orphan,
        staleMs: 0,
        hasLiveHolder: async () => false,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(true);
    expect(unlinked).toEqual(['/fake/.git/index.lock']);
  });

  it('clearStaleIndexLock CHECK-THEN-ACT guard (WI-10006519): a lock REPLACED during the holder check is never unlinked', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const logs: string[] = [];
    const unlinked: string[] = [];
    // The aged 0-byte orphan is judged, then — while the (slow) holder scan runs —
    // it is removed and a different writer creates a fresh lock at the same path.
    // On 2026-10-06 the bg-host scan took ~10 min, so this window was real.
    const orphan = { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 };
    const liveWriter = { mtimeMs: Date.now(), size: 3_900_000, dev: 1, ino: 3 };
    const inspections = [orphan, liveWriter];
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        inspectLock: async () => inspections.shift() ?? null,
        hasLiveHolder: async () => false,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(false);
    expect(unlinked).toEqual([]);
    expect(logs.some((m) => m.includes('CHANGED during the holder check'))).toBe(true);

    // The orphan simply disappears during the check (its owner cleaned up) — retry, no unlink.
    const vanishing = [orphan, null];
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        inspectLock: async () => vanishing.shift() ?? null,
        hasLiveHolder: async () => false,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(true);
    expect(unlinked).toEqual([]);
  });

  it('clearStaleIndexLock logs how long the holder check took, and flags a slow one (WI-10006519)', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const logs: string[] = [];
    const orphan = { mtimeMs: 0, size: 0, dev: 1, ino: 2 };
    // now(): 10 min after the orphan's mtime for the age read, then the holder
    // check is timed at start and end, 12.3 s apart.
    const clock = [600_000, 600_000, 612_300];
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        inspectLock: async () => orphan,
        now: () => clock.shift() ?? 612_300,
        hasLiveHolder: async () => false,
        unlinkFile: async () => {},
      }),
    ).toBe(true);
    const cleared = logs.find((m) => m.includes('cleared STALE index.lock'));
    expect(cleared).toContain('holder check 12.3s — SLOW (WI-10006519)');
  });

  it('clearStaleMaintenanceLock reclaims an orphaned objects/maintenance.lock past its 1h floor (WI-6554700010018201)', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const unlinked: string[] = [];
    const snapshot = { mtimeMs: Date.now() - STALE_MAINTENANCE_LOCK_MS - 60_000, size: 0, dev: 1, ino: 2 };
    expect(
      await clearStaleMaintenanceLock(fakeRunGit, '/fake', () => {}, {
        inspectLock: async (p) => (p.endsWith('/objects/maintenance.lock') ? snapshot : null),
        isOpen: async () => false,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(true);
    expect(unlinked).toEqual(['/fake/.git/objects/maintenance.lock']);
  });

  it.each([
    // 10 min is past config.lock's 90s floor but inside maintenance's 1h floor.
    { name: 'younger than the 1h floor', ageMs: 10 * 60_000, open: false },
    { name: 'held open by a live maintenance run', ageMs: 2 * 60 * 60_000, open: true },
    { name: 'with unknown holder state', ageMs: 2 * 60 * 60_000, open: null },
  ])('clearStaleMaintenanceLock leaves a lock $name untouched', async ({ ageMs, open }) => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const unlinkFile = vi.fn(async () => {});
    const snapshot = { mtimeMs: Date.now() - ageMs, size: 0, dev: 1, ino: 2 };
    expect(
      await clearStaleMaintenanceLock(fakeRunGit, '/fake', () => {}, {
        inspectLock: async () => snapshot,
        isOpen: async () => open,
        unlinkFile,
      }),
    ).toBe(false);
    expect(unlinkFile).not.toHaveBeenCalled();
  });

  it('clearStaleConfigLock removes only an old empty holderless lock', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const unlinked: string[] = [];
    // One STABLE snapshot, like the it.each cases below: clearStaleConfigLock
    // inspects twice and bails if the two disagree. Recomputing Date.now()
    // inside the mock made `after` differ from `before` by the elapsed
    // millisecond, so this read as a replaced lock and returned false — a flake
    // that only showed up under lane load, where the two calls straddle a tick.
    const snapshot = { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 };
    expect(
      await clearStaleConfigLock(fakeRunGit, '/fake', () => {}, {
        inspectLock: async (p) => (p.endsWith('/config.lock') ? snapshot : null),
        isOpen: async () => false,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(true);
    expect(unlinked).toEqual(['/fake/.git/config.lock']);
  });

  it.each([
    {
      name: 'nonempty',
      snapshot: { mtimeMs: Date.now() - 10 * 60_000, size: 12, dev: 1, ino: 2 },
      open: false,
    },
    {
      name: 'held open',
      snapshot: { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 },
      open: true,
    },
    {
      name: 'holder state unknown',
      snapshot: { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 },
      open: null,
    },
  ])('clearStaleConfigLock leaves an old $name lock untouched', async ({ snapshot, open }) => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const unlinkFile = vi.fn(async () => {});

    expect(
      await clearStaleConfigLock(fakeRunGit, '/fake', () => {}, {
        inspectLock: async () => snapshot,
        isOpen: async () => open,
        unlinkFile,
      }),
    ).toBe(false);
    expect(unlinkFile).not.toHaveBeenCalled();
  });

  it('clearStaleConfigLock leaves a replaced lock untouched after holder inspection', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const unlinkFile = vi.fn(async () => {});
    let inspection = 0;

    expect(
      await clearStaleConfigLock(fakeRunGit, '/fake', () => {}, {
        inspectLock: async () => ({
          mtimeMs: Date.now() - 10 * 60_000,
          size: 0,
          dev: 1,
          ino: ++inspection,
        }),
        isOpen: async () => false,
        unlinkFile,
      }),
    ).toBe(false);
    expect(unlinkFile).not.toHaveBeenCalled();
  });

  it('addFailureStrayPaths parses the embedded-repo fatal path(s) + strips trailing slash', () => {
    const out =
      "error: '.papercusp/.vitest-tmpdir/green-oQOrHU/' does not have a commit checked out\n" +
      "error: 'other/nested/' does not have a commit checked out\nfatal: adding files failed";
    expect(addFailureStrayPaths(out)).toEqual(['.papercusp/.vitest-tmpdir/green-oQOrHU', 'other/nested']);
    expect(addFailureStrayPaths('nothing wrong here')).toEqual([]);
  });

  it('isTransientStatFailure matches the git ENOENT-race fatal (and only it)', () => {
    expect(
      isTransientStatFailure(
        "fatal: unable to stat 'apps/operator/app/_components/chat/curator-card-drill-in.test.ts.tmp.210675.fe78c436a08e': No such file or directory",
      ),
    ).toBe(true);
    // a DIFFERENT fatal must not false-positive into the wrong retry path
    expect(isTransientStatFailure("error: 'x/' does not have a commit checked out")).toBe(false);
    expect(isTransientStatFailure("fatal: Unable to create '/x/repo/.git/index.lock': File exists")).toBe(false);
    expect(isTransientStatFailure('')).toBe(false);
  });

  it('P-004 flag-ON: commits the unattributed residual before per-agent groups', async () => {
    writeFileSync(join(repo, 'mine.txt'), 'a\n'); // attributed to cup-7
    writeFileSync(join(repo, 'other.txt'), 'b\n'); // unattributed → catch-all
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      loadRoster: async () => [
        { agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'wire the parser', files: ['mine.txt'] },
      ],
    });
    expect(out.status).toBe('synced');
    // origin received BOTH the per-agent commit (intent subject) AND the catch-all auto-commit.
    const subjects = originLog();
    expect(subjects).toMatch(/wire the parser \(Cup Seven\)/);
    expect(subjects).toMatch(/auto-commit test/);
    // the per-agent commit carries a Co-Authored-By trailer crediting the agent (DERIVED attribution).
    const bodies = git(originDir, 'log', '--format=%B', 'main');
    expect(bodies).toContain('Co-Authored-By: Cup Seven <cup-7@agents.papercusp>');
    const orderedSubjects = git(originDir, 'log', '--format=%s', '--reverse', 'main').split('\n');
    const residualIndex = orderedSubjects.findIndex((subject) => subject.includes('other.txt'));
    const attributedIndex = orderedSubjects.findIndex((subject) => subject.includes('mine.txt'));
    expect(residualIndex).toBeGreaterThanOrEqual(0);
    expect(attributedIndex).toBeGreaterThanOrEqual(0);
    expect(residualIndex).toBeLessThan(attributedIndex);
    // both files landed; the tree is clean.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('binds post-stage stdin reads to the attributed private index', async () => {
    writeFileSync(join(repo, 'mine.txt'), 'clean staged content\n');
    const privateIndexes: string[] = [];
    const runGitStdin: RunGitStdin = async (args, cwd, stdin, options) => {
      const index = options?.env?.GIT_INDEX_FILE;
      if (index) privateIndexes.push(index);
      const result = spawnSync('git', args, {
        cwd,
        input: stdin,
        timeout: 30_000,
        killSignal: 'SIGKILL',
        env: options?.env ? { ...process.env, ...options.env } : process.env,
      });
      return {
        code: result.status ?? 1,
        stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ''),
        stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr ?? '',
      };
    };
    const detector: ContentDetector = {
      key: 'private-index-test',
      glob: '**/*',
      matches: (file) => file === 'mine.txt',
      detect: () => null,
      fixerRole: 'content-fixer',
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      loadRoster: async () => [
        { agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'wire the parser', files: ['mine.txt'] },
      ],
      contentDetectors: [detector],
      runGit: directRunGit,
      runGitStdin,
    });

    expect(out.status).toBe('synced');
    expect(privateIndexes.length).toBeGreaterThan(0);
    expect(privateIndexes.every((index) => index.includes('papercusp-git-sync-attributed-'))).toBe(true);
  });

  it('STRANDING GUARD (WI-1316 / 8186adfb5): a FAILED attributed commit (index.lock race) must NOT skip the catch-all — the remainder still commits', async () => {
    // mine.txt is attributed to cup-7 (peeled into its OWN commit first); other.txt is
    // unattributed (the catch-all remainder). We force the ONE attributed commit to fail
    // like the index.lock race that bit 2026-06-30. PRE-fix, syncOneRepo `return`-ed on
    // res.error and BOTH files stranded (mine.txt staged-uncommitted, other.txt untracked)
    // → an unbuildable tree ("Cannot find module"). POST-fix it logs + falls through to the
    // catch-all `git add -A`, so nothing strands. This is the deterministic guard WI-1316 asks
    // for: inject a runGit that fails the attributed commit but runs everything else for real.
    writeFileSync(join(repo, 'mine.txt'), 'a\n'); // attributed → cup-7
    writeFileSync(join(repo, 'other.txt'), 'b\n'); // unattributed → catch-all

    // A real-git runner (non-throwing: returns {code} instead of throwing on non-zero).
    // It forwards `options.env`: attributed commits run on a private GIT_INDEX_FILE.
    const realGit: RunGit = async (args, cwd, options) => {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        env: options?.env ? { ...process.env, ...options.env } : process.env,
      });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    // Fail ONLY the first attributed commit — the one carrying a `Papercusp-Agent:` trailer
    // (the catch-all auto-commit never does, so it runs for real). Do NOT execute it, exactly
    // like a write that never produced the commit.
    let attributedCommitFailed = false;
    const runGit: RunGit = async (args, cwd, options) => {
      // WI-5111: the bot-identity `-c` override precedes the subcommand, so match on
      // inclusion, not args[0]. WI-10006705: attributed commits are `commit-tree` on a
      // private index (published by an update-ref CAS), no longer `commit`.
      // WI-6554700010029864: the trailers travel as ONE `-m` paragraph, so match a line in it.
      const isAttributedCommit =
        args.includes('commit-tree') && args.some((a) => a.split('\n').some((line) => line.startsWith('Papercusp-Agent:')));
      if (isAttributedCommit && !attributedCommitFailed) {
        attributedCommitFailed = true;
        return { code: 1, stdout: '', stderr: "fatal: Unable to create '.git/index.lock': File exists." };
      }
      return realGit(args, cwd, options);
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      loadRoster: async () => [
        { agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'wire the parser', files: ['mine.txt'] },
      ],
      runGit,
    });

    // The injected failure MUST have fired — else the test proves nothing.
    expect(attributedCommitFailed).toBe(true);
    // The catch-all recovered: the tree synced + pushed DESPITE the attributed-commit error.
    expect(out.status).toBe('synced');
    // BOTH files reached origin — the remainder did NOT strand (the core regression).
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('mine.txt');
    expect(originFiles).toContain('other.txt');
    // The attributed subject never landed (that commit failed); only the catch-all auto-commit did.
    const subjects = originLog();
    expect(subjects).not.toMatch(/wire the parser/);
    expect(subjects).toMatch(/auto-commit test/);
    // working tree clean after the catch-all swept the failed group's files + the remainder.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('STRANDING GUARD: a FAILED attributed add must fall through to the catch-all — the group and remainder still commit', async () => {
    writeFileSync(join(repo, 'mine.txt'), 'a\n'); // attributed → cup-7
    writeFileSync(join(repo, 'other.txt'), 'b\n'); // unattributed → catch-all

    const realGit: RunGit = async (args, cwd, options) => {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        env: options?.env ? { ...process.env, ...options.env } : process.env,
      });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    // WI-10006705: the attributed add runs on a PRIVATE index (GIT_INDEX_FILE in
    // options.env). WI-10006725: so does the catch-all, but its argv is `add -A`, not
    // `add --`, so only the attributed add matches below and the catch-all runs for real.
    let attributedAddFailed = false;
    const runGit: RunGit = async (args, cwd, options) => {
      const onPrivateIndex = Boolean(options?.env?.GIT_INDEX_FILE);
      if (onPrivateIndex && args[0] === 'add' && args[1] === '--' && args.includes('mine.txt') && !attributedAddFailed) {
        attributedAddFailed = true;
        return { code: 1, stdout: '', stderr: "fatal: Unable to create '.git/index.lock': File exists." };
      }
      return realGit(args, cwd, options);
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      loadRoster: async () => [
        { agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'wire the parser', files: ['mine.txt'] },
      ],
      runGit,
    });

    expect(attributedAddFailed).toBe(true);
    expect(out.status).toBe('synced');
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('mine.txt');
    expect(originFiles).toContain('other.txt');
    const subjects = originLog();
    expect(subjects).not.toMatch(/wire the parser/);
    expect(subjects).toMatch(/auto-commit test/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it.each(['success', 'refusal'] as const)(
    'source custody preserves an active peer file lease during %s (real outer pipeline)', async (outcome) => {
      const path = 'vanished-with-active-lease.ts';
      const payload = 'available staged source alongside a peer lease\n';
      const peerBytes = 'peer edit must remain unpublished\n';
      const holding = { path: 'file.txt', owner: 'su-active-peer', intent: 'coherent edit still in progress' };
      const originalPeer = git(repo, 'show', 'HEAD:file.txt');
      writeFileSync(join(repo, path), payload);
      writeFileSync(join(repo, holding.path), peerBytes);
      git(repo, 'add', '--', path, holding.path);
      const oid = git(repo, 'rev-parse', `:${path}`);
      rmSync(join(repo, path));
      writeFileSync(join(repo, 'unrelated-with-lease.ts'), 'export const completed = true;\n');
      const index = git(repo, 'ls-files', '--stage');
      const head = git(repo, 'rev-parse', 'HEAD');
      const remote = git(originDir, 'rev-parse', 'main');
      let refused = false;
      let leaseReads = 0;
      const runGit: RunGit = async (args, cwd, options) => {
        if (outcome === 'refusal' && args[0] === 'cat-file' && args[1] === '-t' && args[2] === oid) {
          refused = true;
          return { code: 1, stdout: '', stderr: 'injected custody read refusal' };
        }
        return directRunGit(args, cwd, options);
      };
      const out = await runGitSync('test', {
        repoPath: repo, config: cfg, runGit,
        liveLockHoldings: [holding],
        refreshLiveLockHoldings: async () => { leaseReads += 1; return [holding]; },
        loadRoster: async () => [
          { agent: 'source-author', files: [path] },
          { agent: holding.owner, files: [holding.path] },
        ],
      });
      expect(refused).toBe(outcome === 'refusal');
      expect(readFileSync(join(repo, holding.path), 'utf8')).toBe(peerBytes);
      expect(git(originDir, 'show', 'main:file.txt')).toBe(originalPeer);
      if (outcome === 'refusal') {
        expect(out.status).toBe('error');
        expect(git(repo, 'ls-files', '--stage')).toBe(index);
        expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(originDir, 'rev-parse', 'main')).toBe(remote);
      } else {
        expect(out.status).toBe('synced');
        expect(leaseReads).toBeGreaterThan(0);
        expect(out.skippedPaths).toContainEqual({ scope: 'superproject', ...holding });
        const ref = git(repo, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX);
        expect(git(repo, 'show', `${ref}:payload`)).toBe(payload.trimEnd());
        expect(JSON.parse(git(repo, 'show', `${ref}:manifest.json`))).toMatchObject({ path, owner: 'source-author', oid });
        expect(git(originDir, 'show', 'main:unrelated-with-lease.ts')).toBe('export const completed = true;');
        expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main').split('\n')).not.toContain(path);
        expect(git(repo, 'status', '--porcelain', '--', holding.path)).not.toBe('');
      }
    },
  );

  it.each(['blob', 'empty', 'manifest', 'payload', 'tree', 'ref', 'readback', 'env'])(
    'source custody %s failure aborts before attributed/catch-all consumers (real outer pipeline)', async (failure) => {
      const path = 'vanished-authored.ts';
      writeFileSync(join(repo, path), 'available staged authored bytes\n');
      git(repo, 'add', '--', path);
      rmSync(join(repo, path));
      writeFileSync(join(repo, 'unrelated.ts'), 'unrelated work\n');
      const index = git(repo, 'ls-files', '--stage');
      const head = git(repo, 'rev-parse', 'HEAD');
      const remote = git(originDir, 'rev-parse', 'main');
      let failed = false;
      const afterFailure: string[][] = [];
      const runGit: RunGit = async (args, cwd, options) => {
        if (failed) afterFailure.push(args);
        const privateCustody = options?.env?.GIT_INDEX_FILE?.includes('source-custody');
        const match = failure === 'blob' && args[0] === 'cat-file' && args[1] === '-t'
          || failure === 'empty' && privateCustody && args[0] === 'read-tree'
          || failure === 'manifest' && args[0] === 'hash-object'
          || failure === 'payload' && privateCustody && args[0] === 'update-index'
          || failure === 'tree' && privateCustody && args[0] === 'write-tree'
          || failure === 'ref' && args[0] === 'update-ref' && args[1].startsWith(SOURCE_CUSTODY_REF_PREFIX)
          || failure === 'readback' && args[0] === 'cat-file' && args[1] === 'blob';
        if (match) {
          failed = true;
          return { code: 1, stdout: 'RAW_SOURCE_MUST_NOT_LEAK', stderr: 'RAW_SOURCE_MUST_NOT_LEAK' };
        }
        const dropEnv = failure === 'env' && Boolean(options?.env?.GIT_INDEX_FILE);
        if (dropEnv) failed = true;
        const r = spawnSync('git', args, {
          cwd, encoding: 'utf8', env: { ...process.env, ...(dropEnv ? {} : options?.env) },
        });
        return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      };
      const logs: string[] = [];
      const out = await runGitSync('test', {
        repoPath: repo, config: cfg, runGit, log: (m) => logs.push(m),
        loadRoster: async () => [{ agent: 'author', files: [path, 'unrelated.ts'] }],
      });
      expect(failed).toBe(true);
      expect(out.status).toBe('error');
      if (out.status === 'error') expect(out.errors.some((e) => e.message.includes('source-custody-refused:'))).toBe(true);
      expect(afterFailure.some((args) => ['add', 'reset', 'read-tree', 'update-index', 'commit', 'commit-tree'].includes(args[0]))).toBe(false);
      expect(git(repo, 'ls-files', '--stage')).toBe(index);
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(originDir, 'rev-parse', 'main')).toBe(remote);
      expect(logs.join('\n')).not.toContain('RAW_SOURCE_MUST_NOT_LEAK');
    },
  );

  it.each([
    ['same', 'deleted-snapshot'], ['different', 'deleted-snapshot'],
    ['same', 'after-capture'], ['different', 'after-capture'],
    ['same', 'attributed-stage'], ['different', 'attributed-stage'],
    ['same', 'attributed-refresh'], ['different', 'attributed-refresh'],
    ['same', 'catch-all-stage'], ['different', 'catch-all-stage'],
    ['same', 'catch-all-refresh'], ['different', 'catch-all-refresh'],
  ])('source custody keeps %s-byte restoration pending at %s (real outer pipeline)', async (kind, point) => {
    const path = 'vanished-authored.ts';
    const original = 'export const staged = true;\n';
    const restored = kind === 'same' ? original : 'export const peer = true;\n';
    writeFileSync(join(repo, path), original);
    git(repo, 'add', '--', path);
    const oid = git(repo, 'rev-parse', `:${path}`);
    rmSync(join(repo, path));
    writeFileSync(join(repo, 'unrelated.ts'), 'export const unrelated = true;\n');
    let hit = false;
    const runGit: RunGit = async (args, cwd, options) => {
      const capture = args[0] === 'update-ref' && args[1].startsWith(SOURCE_CUSTODY_REF_PREFIX);
      const pathspecRefresh = args.some((a) => a.startsWith('--pathspec-from-file='));
      const refresh = args[0] === 'reset' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(args[2] ?? '');
      const match = point === 'after-capture' && capture
        || point === 'attributed-stage' && args[0] === 'add' && args[1] === '--'
        || point === 'catch-all-stage' && args[0] === 'add' && args[1] === '-A'
        || point === 'attributed-refresh' && refresh && !pathspecRefresh
        || point === 'catch-all-refresh' && refresh && pathspecRefresh;
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options?.env } });
      const deletedSnapshot = point === 'deleted-snapshot' && args[0] === 'ls-files' && args.includes('--deleted');
      if (!hit && (match || deletedSnapshot)) {
        hit = true;
        writeFileSync(join(repo, path), restored);
      }
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const out = await runGitSync('test', {
      repoPath: repo, config: cfg, runGit,
      loadRoster: async () => point.startsWith('catch-all') ? [] : [{ agent: 'author', files: [path, 'unrelated.ts'] }],
      refreshLiveLockHoldings: async () => [],
    });
    expect(hit).toBe(true);
    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:unrelated.ts')).toBe('export const unrelated = true;');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(path);
    expect(readFileSync(join(repo, path), 'utf8')).toBe(restored);
    expect(git(repo, 'status', '--porcelain', '--', path)).not.toBe('');
    const refs = git(repo, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX).split('\n');
    expect(refs).toHaveLength(1);
    const manifest = JSON.parse(git(repo, 'show', `${refs[0]}:manifest.json`));
    expect(manifest).toMatchObject({ path, oid, owner: point.startsWith('catch-all') ? 'unknown' : 'author' });
    expect(git(repo, 'show', `${refs[0]}:payload`)).toBe(original.trim());
    expect(git(originDir, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
  });

  it.each(['100644', '100755', '120000'].flatMap((mode) => ['known', 'unknown'].map((ownership) => [mode, ownership])))(
    'source custody preserves %s with %s owner through normal branch publication', async (mode, ownership) => {
      const path = 'vanished-mode.txt';
      const payload = mode === '120000' ? Buffer.from('missing-symlink-target') : Buffer.from([255, 0, 128, 10]);
      const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: payload, encoding: 'utf8' }).trim();
      git(repo, 'update-index', '--add', '--cacheinfo', mode, oid, path);
      writeFileSync(join(repo, 'unrelated.txt'), 'unrelated work\n');
      const out = await runGitSync('test', {
        repoPath: repo, config: cfg,
        loadRoster: async () => ownership === 'known' ? [{ agent: 'author', files: [path, 'unrelated.txt'] }] : [],
      });
      expect(out.status).toBe('synced');
      const ref = git(repo, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX);
      expect(execFileSync('git', ['cat-file', 'blob', `${ref}:payload`], { cwd: repo })).toEqual(payload);
      expect(JSON.parse(git(repo, 'show', `${ref}:manifest.json`))).toMatchObject({ path, mode, oid, owner: ownership === 'known' ? 'author' : 'unknown' });
      expect(git(originDir, 'show', 'main:unrelated.txt')).toBe('unrelated work');
      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(path);
      expect(git(originDir, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
    },
  );

  it.each(['known', 'unknown'].flatMap((ownership) => ['gitlink', 'unmerged'].map((mode) => [ownership, mode])))(
    'source custody refuses %s-owner %s in the outer pipeline', async (ownership, mode) => {
      const path = 'vanished-unsupported.txt';
      const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'staged\n', encoding: 'utf8' }).trim();
      if (mode === 'gitlink') git(repo, 'update-index', '--add', '--cacheinfo', '160000', git(repo, 'rev-parse', 'HEAD'), path);
      else execFileSync('git', ['update-index', '--index-info'], { cwd: repo, input: `100644 ${oid} 1\t${path}\n100644 ${oid} 2\t${path}\n100644 ${oid} 3\t${path}\n` });
      const index = git(repo, 'ls-files', '--stage');
      const head = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'unrelated.txt'), 'unrelated work\n');
      const out = await runGitSync('test', {
        repoPath: repo, config: cfg,
        loadRoster: async () => ownership === 'known' ? [{ agent: 'author', files: [path] }] : [],
      });
      expect(out.status).toBe('error');
      expect(git(repo, 'ls-files', '--stage')).toBe(index);
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(originDir, 'rev-parse', 'main')).toBe(head);
    },
  );

  it.each(['tracked-deletion', 'generated-phantom', 'no-index-entry'])(
    'source custody retains the ordinary %s control in the outer pipeline', async (kind) => {
      const path = kind === 'tracked-deletion' ? 'tracked-delete.txt'
        : kind === 'generated-phantom' ? '.papercusp/dependency-exact-ref/example/.live-inputs' : 'already-gone.txt';
      if (kind !== 'no-index-entry') {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), 'ordinary\n');
        git(repo, 'add', '-f', '--', path);
        if (kind === 'tracked-deletion') {
          git(repo, 'commit', '-m', 'tracked deletion control');
          git(repo, 'push', 'origin', 'main');
        }
        rmSync(join(repo, path));
      }
      writeFileSync(join(repo, 'unrelated.txt'), 'unrelated work\n');
      const out = await runGitSync('test', {
        repoPath: repo, config: cfg, loadRoster: async () => [{ agent: 'author', files: [path, 'unrelated.txt'] }],
      });
      expect(out.status).toBe('synced');
      expect(git(originDir, 'show', 'main:unrelated.txt')).toBe('unrelated work');
      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(path);
      expect(git(repo, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
    },
  );

  it.each(['wrong-payload', 'unrooted-manifest'])(
    'source custody rejects the %s mutation in the outer pipeline', async (mutation) => {
      const path = 'vanished-mutated.txt';
      writeFileSync(join(repo, path), 'original staged bytes\n');
      git(repo, 'add', '--', path);
      const oid = git(repo, 'rev-parse', `:${path}`);
      rmSync(join(repo, path));
      const index = git(repo, 'ls-files', '--stage');
      const wrong = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'wrong bytes\n', encoding: 'utf8' }).trim();
      let hit = false;
      const runGit: RunGit = async (args, cwd, options) => {
        if (options?.env?.GIT_INDEX_FILE?.includes('source-custody') && args[0] === 'update-index') {
          hit = true;
          args = [...args];
          if (mutation === 'wrong-payload') args[4] = wrong;
          else args.splice(6);
        }
        const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options?.env } });
        return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      };
      const out = await runGitSync('test', { repoPath: repo, config: cfg, runGit });
      expect(hit).toBe(true);
      expect(out.status).toBe('error');
      expect(git(repo, 'ls-files', '--stage')).toBe(index);
      expect(git(repo, 'rev-parse', `:${path}`)).toBe(oid);
      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(path);
    },
  );

  it.each(['success', 'refusal'])(
    'source custody handles a late staged disappearance before catch-all (%s)', async (outcome) => {
      const path = 'late-vanished.txt';
      writeFileSync(join(repo, 'unrelated.txt'), 'unrelated work\n');
      let arrived = false;
      let refused = false;
      let consumedAfterRefusal = false;
      const runGit: RunGit = async (args, cwd, options) => {
        if (refused && ['add', 'reset', 'commit', 'commit-tree', 'update-index'].includes(args[0])) consumedAfterRefusal = true;
        if (arrived && outcome === 'refusal' && args[0] === 'update-ref' && args[1].startsWith(SOURCE_CUSTODY_REF_PREFIX)) {
          refused = true;
          return { code: 1, stdout: '', stderr: 'injected custody refusal' };
        }
        const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options?.env } });
        if (!arrived && args[0] === 'update-ref' && args[3] === 'HEAD' && r.status === 0) {
          arrived = true;
          writeFileSync(join(repo, path), 'late staged bytes\n');
          git(repo, 'add', '--', path);
          rmSync(join(repo, path));
        }
        return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      };
      const out = await runGitSync('test', {
        repoPath: repo, config: cfg, runGit, loadRoster: async () => [{ agent: 'author', files: ['unrelated.txt'] }],
      });
      expect(arrived).toBe(true);
      expect(out.status).toBe(outcome === 'success' ? 'synced' : 'error');
      expect(consumedAfterRefusal).toBe(false);
      expect(git(repo, 'show', `:${path}`)).toBe('late staged bytes');
      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(path);
      const ref = git(repo, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX);
      if (outcome === 'success') expect(git(repo, 'show', `${ref}:payload`)).toBe('late staged bytes');
      else expect(ref).toBe('');
    },
  );

  it('returns "nothing" on a clean, up-to-date tree', async () => {
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('nothing');
  });

  // EI-438 content guard (P-001/P-002/P-008): the broken file is EXCLUDED from the
  // commit + left dirty (quarantine, don't stall) while every clean file still syncs.
  it('content guard: commits the clean files, EXCLUDES + reports a broken one (quarantine, dont stall)', async () => {
    writeFileSync(join(repo, 'good.txt'), 'fine\n');
    writeFileSync(join(repo, 'bad.md'), 'this is BROKEN\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out.status).toBe('synced'); // the clean file synced despite the broken sibling
    expect(out.contentErrors).toEqual([
      {
        scope: 'superproject',
        file: 'bad.md',
        detectorKey: 'fake-broken',
        error: 'contains BROKEN',
        fixerRole: 'content-fixer',
        contentHash: '0bec6cfbbb9c9e24fe0b0d0898eece375bfde10840e87aa2ed9a0b4293f94260',
        detectorResultHash: '1056f0bdc70c0c0ffadd4e0742c00323a07e7ae989c1bde9ca544f8615970720',
      },
    ]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('good.txt'); // the clean file reached origin…
    expect(originFiles).not.toContain('bad.md'); // …but the broken one did NOT (excluded)
    // the broken file is left dirty/uncommitted in the working tree for the content-fixer
    expect(git(repo, 'status', '--porcelain')).toContain('bad.md');
  });

  it('content guard: the NEXT tick commits the file once it passes the detector (self-heal)', async () => {
    writeFileSync(join(repo, 'bad.md'), 'this is BROKEN\n');
    await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('bad.md');

    // the content-fixer repairs the file (no longer BROKEN) → the next tick commits it
    writeFileSync(join(repo, 'bad.md'), 'this is fine now\n');
    const out2 = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out2.status).toBe('synced');
    expect(out2.contentErrors).toEqual([]);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('bad.md'); // now it reaches origin
    expect(git(repo, 'status', '--porcelain')).toBe(''); // tree clean
  });

  it('content guard: production commit path auto-repairs raw NUL bytes before quarantine', async () => {
    const nul = String.fromCharCode(0);
    writeFileSync(join(repo, 'keys.ts'), `export const key = \`${'${a}'}${nul}${'${b}'}\`;\n`, 'utf8');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(out.contentErrors).toEqual([]);
    expect(readFileSync(join(repo, 'keys.ts'), 'utf8')).toBe('export const key = `${a}\\x00${b}`;\n');
    expect(git(originDir, 'show', 'main:keys.ts')).toBe('export const key = `${a}\\x00${b}`;');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('content guard: quarantines a zero-byte TypeScript module while unrelated source commits, then recovers it', async () => {
    writeFileSync(join(repo, 'empty-source.ts'), '');
    writeFileSync(join(repo, 'unrelated.ts'), 'export const ready = true;\n');

    const held = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(held.status).toBe('synced');
    expect(held.contentErrors).toContainEqual(expect.objectContaining({
      scope: 'superproject',
      file: 'empty-source.ts',
      detectorKey: 'empty-ts-source',
      fixerRole: 'content-fixer',
      error: expect.stringContaining('zero bytes'),
    }));
    expect(git(originDir, 'show', 'main:unrelated.ts')).toContain('ready = true');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('empty-source.ts');
    expect(git(repo, 'status', '--porcelain', '--', 'empty-source.ts')).toContain('empty-source.ts');

    writeFileSync(join(repo, 'empty-source.ts'), 'export const restored = true;\n');
    const recovered = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(recovered.status).toBe('synced');
    expect(recovered.contentErrors).toEqual([]);
    expect(git(originDir, 'show', 'main:empty-source.ts')).toContain('restored = true');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('content guard is a no-op when no detector matches the dirty files (clean tree commits as today)', async () => {
    writeFileSync(join(repo, 'plain.txt'), 'no detector targets .txt\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });
    expect(out.status).toBe('synced');
    expect(out.contentErrors).toEqual([]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  // EI-19932544083689229 remedy #1 (ATOMICITY): reproduces the live incident —
  // content-guard quarantines a broken SOURCE file; its clean *.test.* SIBLING
  // (which imports it via a relative specifier) must be held back TOO, not
  // committed alone. Pre-fix this test fails: the sibling test lands in HEAD
  // while its subject never does, and an isolated checkout gets an unresolvable
  // import forever.
  it('EI-19932544083689229: a dirty sibling that IMPORTS a content-guard-quarantined file is ALSO excluded (quarantine the pair, not just the broken half)', async () => {
    writeFileSync(join(repo, 'good.txt'), 'fine\n');
    writeFileSync(join(repo, 'watchdog.md'), 'this is BROKEN\n'); // content-guard quarantines this
    // The sibling "test" — clean text, but imports the quarantined file. Using a
    // real resolvable extension (.ts) + a relative specifier so the quarantine-import
    // guard's specifier scan actually fires (brokenDetector only targets *.md).
    writeFileSync(join(repo, 'watchdog.test.ts'), `import './watchdog.md';\nit('ok', () => {});\n`);

    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out.status).toBe('synced'); // the unrelated clean file still syncs
    const files = out.contentErrors.map((c) => c.file).sort();
    expect(files).toEqual(['watchdog.md', 'watchdog.test.ts']);
    const importerOffender = out.contentErrors.find((c) => c.file === 'watchdog.test.ts');
    expect(importerOffender?.detectorKey).toBe('quarantined-importer');
    expect(importerOffender?.error).toContain('watchdog.md');
    // WI-6554700010008496: the finding names its root and WHY the root was excluded.
    expect(importerOffender).toMatchObject({
      excludedRoot: 'watchdog.md',
      excludedRootReason: 'content guard: fake-broken',
    });

    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('good.txt');
    expect(originFiles).not.toContain('watchdog.md'); // subject excluded (as before)
    expect(originFiles).not.toContain('watchdog.test.ts'); // NEW: importer excluded too — the fix
    // both the subject AND its importer are left dirty for the content-fixer
    const dirty = git(repo, 'status', '--porcelain');
    expect(dirty).toContain('watchdog.md');
    expect(dirty).toContain('watchdog.test.ts');
  });

  it('EI-21031600248610340: a tracked-but-modified quarantined dependency does not infect its importer', async () => {
    writeFileSync(join(repo, 'watchdog.md'), 'initial and committed\n');
    git(repo, 'add', 'watchdog.md');
    git(repo, 'commit', '--no-verify', '-m', 'seed tracked dependency');
    git(repo, 'push', 'origin', 'HEAD:main');

    writeFileSync(join(repo, 'watchdog.md'), 'this is BROKEN\n');
    writeFileSync(join(repo, 'watchdog.test.ts'), `import './watchdog.md';\nit('ok', () => {});\n`);

    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out.status).toBe('synced');
    expect(out.contentErrors.map((c) => c.file)).toEqual(['watchdog.md']);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('watchdog.md');
    expect(originFiles).toContain('watchdog.test.ts');
    expect(git(originDir, 'show', 'main:watchdog.md')).toBe('initial and committed');
    expect(git(repo, 'status', '--porcelain')).toContain('watchdog.md');
    expect(git(repo, 'status', '--porcelain')).not.toContain('watchdog.test.ts');
  });

  it('WI-6554700010008496: an importer two hops behind a live-lock root names that root and its holder', async () => {
    writeFileSync(join(repo, 'held-root.ts'), 'export const existing = 1;\n');
    git(repo, 'add', 'held-root.ts');
    git(repo, 'commit', '--no-verify', '-m', 'seed held root');
    git(repo, 'push', 'origin', 'HEAD:main');
    writeFileSync(join(repo, 'held-root.ts'), 'export const existing = 1;\nexport const added = 2;\n');
    writeFileSync(join(repo, 'held-middle.ts'), "import { added } from './held-root';\nexport const middle = added;\n");
    writeFileSync(join(repo, 'held-leaf.ts'), "import { middle } from './held-middle';\nexport const leaf = middle;\n");
    const holding = { path: 'held-root.ts', owner: 'su-turn', intent: 'turn-scoped hold: edited this turn', goalRef: 'WI-1' };

    const out = await runGitSync('test', {
      repoPath: repo, config: cfg, excludePaths: [holding.path], liveLockHoldings: [holding],
    });

    const leaf = out.contentErrors.find((c) => c.file === 'held-leaf.ts');
    expect(leaf).toMatchObject({ detectorKey: 'quarantined-importer', excludedRoot: 'held-root.ts' });
    expect(leaf?.excludedRootReason).toBe('held by su-turn for WI-1 — turn-scoped hold: edited this turn');
    expect(leaf?.error).toContain(`→ 'held-middle.ts'`);
    expect(git(repo, 'status', '--porcelain')).toContain('held-leaf.ts');
  });

  it('EI-25437238223518184: commits a named package consumer only with its changed provider', async () => {
    const providerDir = join(repo, 'packages/provider/src');
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(repo, 'packages/provider/package.json'), JSON.stringify({
      name: '@fixture/provider', exports: { './telemetry': './src/telemetry.ts' },
    }));
    writeFileSync(join(providerDir, 'telemetry.ts'), 'export const existing = 1;\n');
    git(repo, 'add', 'packages/provider');
    git(repo, 'commit', '--no-verify', '-m', 'seed package provider');
    git(repo, 'push', 'origin', 'HEAD:main');

    const provider = 'packages/provider/src/telemetry.ts';
    const consumer = 'consumer.ts';
    const detector: ContentDetector = {
      ...brokenDetector, glob: '**/*.ts', matches: file => file === provider,
    };
    writeFileSync(join(repo, provider), 'export const newlyAdded = 2; // BROKEN\n');
    writeFileSync(join(repo, consumer), "import { newlyAdded } from '@fixture/provider/telemetry';\nexport const value = newlyAdded;\n");
    writeFileSync(join(repo, 'good.txt'), 'unrelated clean change\n');

    const held = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [detector] });
    expect(held.status).toBe('synced');
    expect(held.contentErrors.some(row => row.file === consumer && row.detectorKey === 'quarantined-importer')).toBe(true);
    const heldFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    expect(heldFiles).toContain('good.txt');
    expect(heldFiles).not.toContain(consumer);
    expect(git(originDir, 'show', 'main:' + provider)).toBe('export const existing = 1;');
    expect(git(repo, 'status', '--porcelain')).toContain(consumer);

    writeFileSync(join(repo, provider), 'export const newlyAdded = 2;\n');
    const recovered = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [detector] });
    expect(recovered.status).toBe('synced');
    expect(recovered.contentErrors).toEqual([]);
    expect(git(originDir, 'show', 'main:' + provider)).toBe('export const newlyAdded = 2;');
    expect(git(originDir, 'show', 'main:' + consumer)).toContain("from '@fixture/provider/telemetry'");
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-19932544083689229: once the subject is fixed, the previously-held-back importer commits too (self-heal, no residual quarantine)', async () => {
    writeFileSync(join(repo, 'watchdog.md'), 'this is BROKEN\n');
    writeFileSync(join(repo, 'watchdog.test.ts'), `import './watchdog.md';\nit('ok', () => {});\n`);
    await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('watchdog.test.ts');

    // content-fixer repairs the subject (no longer BROKEN) — the NEXT tick commits both.
    writeFileSync(join(repo, 'watchdog.md'), 'this is fine now\n');
    const out2 = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out2.status).toBe('synced');
    expect(out2.contentErrors).toEqual([]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('watchdog.md');
    expect(originFiles).toContain('watchdog.test.ts');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  // G20: the joiner-side push:false runtime invariant — a dirty tree COMMITS
  // locally but origin/main must be byte-for-byte UNCHANGED. Asserts via the
  // origin tip SHA (not just the commit-subject log) and proves the fresh local
  // commit is genuinely absent from origin.
  it('commits locally but does not push when push:false (origin/main SHA unchanged)', async () => {
    writeFileSync(join(repo, 'local.txt'), 'x\n');
    const originTipBefore = git(originDir, 'rev-parse', 'main');
    const localTipBefore = git(repo, 'rev-parse', 'HEAD');

    const out = await runGitSync('test', { repoPath: repo, config: { push: false, pushSubmodules: false } });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toEqual([]);

    // a NEW local commit exists (HEAD advanced) and carries the auto-commit subject
    const localTipAfter = git(repo, 'rev-parse', 'HEAD');
    expect(localTipAfter).not.toBe(localTipBefore);
    expect(git(repo, 'log', '--format=%B', '-1')).toMatch(/auto-commit test/);

    // origin/main is UNCHANGED — same tip SHA, and the commit-subject log is identical
    expect(git(originDir, 'rev-parse', 'main')).toBe(originTipBefore);
    expect(originLog()).not.toMatch(/auto-commit test/);
    // and the bare origin does NOT have the fresh local commit object reachable on main
    expect(() => git(originDir, 'merge-base', '--is-ancestor', localTipAfter, 'main')).toThrow();
  });

  // p2p-git-live-activation P-306 (Leg E bridged/commit-only false-alarm question): on a
  // BRIDGED hive, member git-sync runs with push:false (decideGitSyncPush) and the bridge
  // writer is the sole origin pusher — so a member's `fetch` to origin can legitimately fail
  // (offline bridge writer, transient network) on every single tick. GAP-4's push:true branch
  // would classify that as `status: 'error'` (unpushed HEAD, cannot reconcile) — which, if it
  // ever happened here, would persist across ticks and eventually trip the git-sync-stall
  // watchdog's errorStall signal. Proves it CANNOT: with push:false, an unreachable origin
  // still yields a local commit + `status: 'synced'` (never 'error'), so a commit-only member
  // can never accumulate the watchdog's errorStall streak from its own (expected) push-less
  // state — the false alarm this leg exists to rule out.
  it('bridged/commit-only (push:false): an UNREACHABLE origin still commits locally and never reports "error" (git-sync-stall false-alarm guard)', async () => {
    writeFileSync(join(repo, 'local.txt'), 'x\n');
    const localTipBefore = git(repo, 'rev-parse', 'HEAD');
    // simulate the bridge writer being unreachable: point origin at a path with no repo there.
    git(repo, 'remote', 'set-url', 'origin', join(root, 'no-such-remote.git'));

    const out = await runGitSync('test', { repoPath: repo, config: { push: false, pushSubmodules: false } });

    expect(out.status).not.toBe('error');
    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toEqual([]);
    // HEAD still advanced — the local commit landed despite the unreachable remote.
    const localTipAfter = git(repo, 'rev-parse', 'HEAD');
    expect(localTipAfter).not.toBe(localTipBefore);
  });

  // Same fetch-unreachable scenario on a CLEAN tree (no dirty files): the commit-only member
  // reports 'nothing', which the watchdog's commitNotAttemptable exemption already treats as
  // never head-stale — confirms the quiet-idle path holds under bridged mode too.
  it('bridged/commit-only (push:false): an unreachable origin on a CLEAN tree reports "nothing", never "error"', async () => {
    git(repo, 'remote', 'set-url', 'origin', join(root, 'no-such-remote.git'));
    const out = await runGitSync('test', { repoPath: repo, config: { push: false, pushSubmodules: false } });
    expect(out.status).toBe('nothing');
  });

  it('EI-21025944774670342: zero-byte loose objects fail closed with a specific corruption diagnosis before fetch', async () => {
    const fanoutDir = join(repo, '.git', 'objects', 'aa');
    const objectName = '0'.repeat(38);
    const objectPath = join(fanoutDir, objectName);
    mkdirSync(fanoutDir, { recursive: true });
    writeFileSync(objectPath, '');

    const broken = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(broken.status).toBe('error');
    if (broken.status === 'error') {
      const messages = broken.errors.map((error) => error.message).join('\n');
      expect(messages).toContain('local Git object database corrupt: 1 zero-byte loose object(s)');
      expect(messages).toContain(`aa${objectName}`);
      expect(messages).toContain('repair required before fetch');
      expect(messages).not.toContain('fetch failed; HEAD has unpushed commits');
    }

    rmSync(objectPath);
    const recovered = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(recovered.status).toBe('nothing');
  });

  it('EI-20232774599730947: P2P commit-only skips direct superproject reconciliation, so a retained installer seed is not transplanted again', async () => {
    // Model the physical Mac after restore: a retained synthetic seed marker,
    // an unrelated GitHub main, and new local work that belongs in the P2P
    // namespace rather than a direct origin/main rebase.
    git(repo, 'checkout', '--orphan', 'seeded');
    git(repo, 'rm', '-rf', '.');
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git(repo, 'add', 'seed.txt');
    git(repo, 'commit', '--no-verify', '-m', 'papercusp seed snapshot HEAD');
    const seedRoot = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/papercusp-seed-snapshot-test', seedRoot);
    writeFileSync(join(repo, 'local-p2p.txt'), 'local P2P work\n');

    const originTipBefore = git(originDir, 'rev-parse', 'main');
    const out = await runGitSync('test', {
      repoPath: repo,
      config: {
        push: false,
        pushSubmodules: false,
        reconcileSuperprojectOrigin: false,
      },
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toEqual([]);
      expect(out.merged).toEqual([]);
    }
    expect(git(originDir, 'rev-parse', 'main')).toBe(originTipBefore);
    expect(() => git(repo, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).toThrow();
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/papercusp/seed-recovery/')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('WI-10003527: a shallow clone whose HEAD and origin/main are both depth-1 deepens to a merge-base and fast-forwards instead of "refusing to merge unrelated histories"', async () => {
    // Model the P-203 VM submodule: HEAD is a depth-1 older remote commit, and
    // origin/main was later fetched at depth 1, so no merge-base exists locally
    // and a plain `git fetch` (tip already present) never supplies one.
    const seed = join(root, 'seed');
    const commit = (name: string) => {
      writeFileSync(join(seed, `${name}.txt`), `${name}\n`);
      git(seed, 'add', '-A');
      git(seed, 'commit', '--no-verify', '-m', name);
    };
    commit('c2');
    git(seed, 'push', 'origin', 'main');
    const shallowRepo = join(root, 'shallow');
    git(root, 'clone', '--depth', '1', `file://${originDir}`, shallowRepo);
    configUser(shallowRepo);
    for (const n of ['c3', 'c4', 'c5', 'c6']) commit(n);
    git(seed, 'push', 'origin', 'main');
    git(shallowRepo, 'fetch', '--depth', '1', 'origin', 'main');
    const originTip = git(originDir, 'rev-parse', 'main');
    expect(git(shallowRepo, 'rev-parse', 'origin/main')).toBe(originTip);
    expect(git(shallowRepo, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(() => git(shallowRepo, 'merge-base', 'HEAD', 'origin/main')).toThrow();

    const out = await runGitSync('test', { repoPath: shallowRepo, config: cfg });

    if (out.status === 'error') throw new Error(out.errors.map((e) => e.message).join('\n'));
    expect(git(shallowRepo, 'rev-parse', 'HEAD')).toBe(originTip);
    expect(git(shallowRepo, 'status', '--porcelain')).toBe('');
  });

  it('EI-20216304202023591: failed fetch removes only its fresh interrupted tmp_pack and reports reclaimed bytes', async () => {
    const packDir = join(repo, '.git', 'objects', 'pack');
    mkdirSync(packDir, { recursive: true });
    const existingTmpPack = join(packDir, 'tmp_pack_existing-from-before-fetch');
    const interruptedTmpPack = join(packDir, 'tmp_pack_interrupted-index-pack');
    writeFileSync(existingTmpPack, Buffer.alloc(64, 1));
    const reclaimedBytes = 8 * 1024 * 1024;
    const logs: string[] = [];
    const realRunGit: RunGit = async (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: r.status ?? -1,
        stdout: String(r.stdout ?? ''),
        stderr: `${String(r.stderr ?? '')}${r.error ? `\n${r.error.message}` : ''}`,
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      if (args.includes('fetch')) {
        // Simulate index-pack being interrupted after writing a large partial pack.
        writeFileSync(interruptedTmpPack, Buffer.alloc(reclaimedBytes, 7));
        return { code: 128, stdout: '', stderr: 'fatal: early EOF\n' };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      runGit,
      config: { pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('nothing');
    expect(existsSync(interruptedTmpPack)).toBe(false);
    expect(existsSync(existingTmpPack)).toBe(true);
    expect(logs).toContain(
      `[git-sync] ${repo}: failed fetch cleanup; pruned 1 newly-created unreferenced tmp_pack file(s), reclaimed ${reclaimedBytes} bytes`,
    );
  });

  it('EI-20224214315801764: pre-fetch scavenger removes only old unopened unreferenced tmp_pack leftovers', async () => {
    const packDir = join(repo, '.git', 'objects', 'pack');
    mkdirSync(packDir, { recursive: true });
    const now = Date.now();
    const staleTmpPack = join(packDir, 'tmp_pack_crash-left');
    const freshTmpPack = join(packDir, 'tmp_pack_live-fetch');
    const openTmpPack = join(packDir, 'tmp_pack_open-by-fetch');
    const referencedTmpPack = join(packDir, 'tmp_pack_has-index');
    const directoryTmpPack = join(packDir, 'tmp_pack_directory');
    writeFileSync(staleTmpPack, Buffer.alloc(4096, 1));
    writeFileSync(freshTmpPack, Buffer.alloc(4096, 2));
    writeFileSync(openTmpPack, Buffer.alloc(4096, 3));
    writeFileSync(referencedTmpPack, Buffer.alloc(4096, 4));
    writeFileSync(`${referencedTmpPack}.idx`, 'index sidecar');
    mkdirSync(directoryTmpPack);
    const oldSeconds = (now - 10 * 60_000) / 1000;
    for (const path of [staleTmpPack, openTmpPack, referencedTmpPack]) utimesSync(path, oldSeconds, oldSeconds);
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      staleTempPackMs: 60_000,
      isTempPackOpen: async (path) => path === openTmpPack,
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('nothing');
    expect(existsSync(staleTmpPack)).toBe(false);
    expect(existsSync(freshTmpPack)).toBe(true); // below the age floor
    expect(existsSync(openTmpPack)).toBe(true); // open-state proof is required
    expect(existsSync(referencedTmpPack)).toBe(true); // the index sidecar is a reference
    expect(existsSync(directoryTmpPack)).toBe(true); // regular-file proof is required
    expect(logs).toContain(
      `[git-sync] ${repo}: stale tmp_pack cleanup; pruned 1 unopened unreferenced file(s), reclaimed 4096 bytes`,
    );
  });

  it('stale tmp_pack scavenger fails closed when open-state is unknown', async () => {
    const packDir = join(repo, '.git', 'objects', 'pack');
    mkdirSync(packDir, { recursive: true });
    const staleTmpPack = join(packDir, 'tmp_pack_unknown-open-state');
    writeFileSync(staleTmpPack, Buffer.alloc(32, 5));
    const oldSeconds = (Date.now() - STALE_TEMP_PACK_MS - 60_000) / 1000;
    utimesSync(staleTmpPack, oldSeconds, oldSeconds);

    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const out = await scavengeStaleTempPacks(realRunGit, repo, () => {}, {
      staleMs: 60_000,
      isOpen: async () => null,
    });

    expect(out).toEqual({ removed: [], bytesReclaimed: 0 });
    expect(existsSync(staleTmpPack)).toBe(true);
  });

  it('a sync reclaims an orphaned objects/maintenance.lock so git auto-gc is not silently disabled (WI-6554700010018201)', async () => {
    const lock = join(repo, '.git', 'objects', 'maintenance.lock');
    writeFileSync(lock, '');
    const oldSeconds = (Date.now() - STALE_MAINTENANCE_LOCK_MS - 60_000) / 1000;
    utimesSync(lock, oldSeconds, oldSeconds);
    writeFileSync(join(repo, 'maintenance-lock.txt'), 'edit\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg, isGitLockOpen: async () => false });

    expect(out.status).not.toBe('error');
    expect(existsSync(lock)).toBe(false);
  });

  it('a bridged commit-only sync also reclaims an orphaned objects/maintenance.lock (WI-6554700010018483)', async () => {
    // The canonical papercusp repo is a bridged hive: its superproject never reaches
    // reconcileAndPushOneRepo, which is where the legacy reclaim lives.
    const lock = join(repo, '.git', 'objects', 'maintenance.lock');
    writeFileSync(lock, '');
    const oldSeconds = (Date.now() - STALE_MAINTENANCE_LOCK_MS - 60_000) / 1000;
    utimesSync(lock, oldSeconds, oldSeconds);
    writeFileSync(join(repo, 'maintenance-lock-bridged.txt'), 'edit\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: { ...cfg, push: false, reconcileSuperprojectOrigin: false },
      isGitLockOpen: async () => false,
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });

  it('on a divergent conflict: aborts to a CLEAN tree and reports conflicted files', async () => {
    // a second clone pushes a conflicting change to origin/main
    const other = join(root, 'other');
    git(root, 'clone', originDir, other);
    configUser(other);
    writeFileSync(join(other, 'file.txt'), 'OTHER-EDIT\n');
    git(other, 'add', '-A');
    git(other, 'commit', '--no-verify', '-m', 'other change');
    git(other, 'push', 'origin', 'main');

    // the harness repo edits the SAME line, then syncs → merge conflict
    writeFileSync(join(repo, 'file.txt'), 'LOCAL-EDIT\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('conflict');
    if (out.status === 'conflict') {
      expect(out.conflicts.map((c) => c.scope)).toContain('superproject');
      expect(out.conflicts.find((c) => c.scope === 'superproject')?.conflictedFiles).toContain('file.txt');
    }
    // tree must be clean (not mid-merge) — agents must never see a conflicted tree
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // no merge in progress
    let inMerge = false;
    try {
      git(repo, 'rev-parse', '--verify', 'MERGE_HEAD');
      inMerge = true;
    } catch {
      inMerge = false;
    }
    expect(inMerge).toBe(false);
    // local commit is preserved
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('LOCAL-EDIT\n');
  });
});

describe('measureAttributedFileShare (P-003, gate-systems-as-designed-2026-10-27)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitsync-share-'));
    git(repo, 'init', '-b', 'main');
    configUser(repo);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const commit = (files: string[], message: string): string => {
    for (const f of files) writeFileSync(join(repo, f), `${f} ${message.length}\n`);
    git(repo, 'add', '--', ...files);
    git(repo, 'commit', '--no-verify', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };

  it('counts ledger-attributed files by whether the commit that carried them names an agent', async () => {
    const named = commit(['a.ts'], 'feat: a\n\nPapercusp-Agent: su-1\nPapercusp-Work-Item: WI-1');
    // An anonymous sweep that took an attributed file, a regenerated declaration that is
    // anonymous on purpose (forceCatchAllPaths), and a script-written file with no owner.
    const anonymous = commit(['b.ts', 'gen.d.mts', 'script.json'], 'chore(git-sync): auto-commit');
    const attribution = new Map([['a.ts', {}], ['b.ts', {}], ['gen.d.mts', {}]]);
    expect(await measureAttributedFileShare(directRunGit, repo, [named, anonymous], attribution, ['gen.d.mts'])).toEqual({
      attributableFileCount: 2,
      attributedFileCount: 1,
    });
  });

  it('reads one-trailer-per-paragraph and multi-author messages, and counts a sha once', async () => {
    const legacy = commit(['a.ts'], 'feat: a\n\nPapercusp-Agent: su-1\n\nPapercusp-Work-Item: WI-1');
    const multi = commit(['b.ts', 'c.ts'], 'feat: b\n\nPapercusp-Agent: su-1\nPapercusp-Agent: su-2');
    const attribution = new Map([['a.ts', {}], ['b.ts', {}], ['c.ts', {}]]);
    expect(await measureAttributedFileShare(directRunGit, repo, [legacy, multi, multi], attribution)).toEqual({
      attributableFileCount: 3,
      attributedFileCount: 3,
    });
  });

  it('skips a commit git cannot read, and measures nothing without attribution', async () => {
    const sha = commit(['a.ts'], 'chore(git-sync): auto-commit');
    expect(await measureAttributedFileShare(directRunGit, repo, ['0'.repeat(40), sha], new Map([['a.ts', {}]]))).toEqual({
      attributableFileCount: 1,
      attributedFileCount: 0,
    });
    expect(await measureAttributedFileShare(directRunGit, repo, [sha], new Map())).toEqual({
      attributableFileCount: 0,
      attributedFileCount: 0,
    });
  });
});

describe('runGitSync (real git, with a submodule) — P-007 submodule-push-first', () => {
  let root: string;
  let superOrigin: string; // bare superproject origin
  let subOrigin: string; // bare submodule origin
  let repo: string; // the "harness" working clone (with submodule checked out)

  // file:// submodule add/update is blocked by default (CVE) — allow it in setup.
  const allowFile = ['-c', 'protocol.file.allow=always'];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-sub-'));
    superOrigin = join(root, 'super-origin.git');
    subOrigin = join(root, 'sub-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subOrigin);

    // seed the submodule's origin/main
    const subseed = join(root, 'subseed');
    git(root, 'clone', subOrigin, subseed);
    configUser(subseed);
    writeFileSync(join(subseed, 'sub.txt'), 'sub-v1\n');
    git(subseed, 'add', '-A');
    git(subseed, 'commit', '--no-verify', '-m', 'sub init');
    git(subseed, 'push', '-u', 'origin', 'main');

    // seed the superproject with the submodule at libs/sub
    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subOrigin, 'libs/sub');
    configUser(join(superseed, 'libs/sub'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + submodule');
    git(superseed, 'push', '-u', 'origin', 'main');

    // the harness working clone, with the submodule checked out
    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/sub'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // WI-6554700010018409: AttributionTally.scope must carry the repo label that
  // git_sync_commit_attribution uses for the same commits (resolveAttributionRepo).
  it('labels attribution tallies with each repo label from a superproject install', async () => {
    const sub = join(repo, 'libs/sub');
    writeFileSync(join(sub, 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');
    const out = await runGitSync('test', {
      repoPath: repo,
      loadRoster: async () => [
        {
          agent: 'cup-7',
          agentLabel: 'Cup Seven',
          intent: 'wire the parser',
          files: [join(sub, 'sub-new.txt'), join(repo, 'super-new.txt')],
        },
      ],
    });
    const scopes = (out.attribution ?? []).map((t) => t.scope).sort();
    expect(scopes).toEqual(['libs/sub', 'superproject']);
    for (const t of out.attribution ?? []) expect(t.agentCommitCount).toBe(1);
    expect(await resolveAttributionRepo(sub, runGitLocal)).toBe('libs/sub');
  });

  it("labels a submodule install's tally with its submodule path, not 'superproject'", async () => {
    const sub = join(repo, 'libs/sub');
    git(sub, 'checkout', 'main');
    writeFileSync(join(sub, 'sub-new.txt'), 'sub-v2\n');
    const out = await runGitSync('test/libs/sub', {
      repoPath: sub,
      loadRoster: async () => [
        { agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'wire the parser', files: [join(sub, 'sub-new.txt')] },
      ],
    });
    expect(out.attribution).toEqual([
      {
        scope: 'libs/sub',
        agentGroupCount: 1,
        agentCommitCount: 1,
        failedGroups: 0,
        error: null,
        attributableFileCount: 1,
        attributedFileCount: 1,
      },
    ]);
    // The same label the commit-attribution recorder writes for this repo's commits.
    expect(out.attribution?.[0]?.scope).toBe(await resolveAttributionRepo(sub, runGitLocal));
  });

  // P-003 (gate-systems-as-designed-2026-10-27): every sweep records its attributed-file share.
  it('records the sweep share: ledger-attributed files under an agent trailer, unowned files left out', async () => {
    const sub = join(repo, 'libs/sub');
    git(sub, 'checkout', 'main');
    writeFileSync(join(sub, 'a.txt'), 'a\n');
    writeFileSync(join(sub, 'b.txt'), 'b\n');
    writeFileSync(join(sub, 'generated.json'), '{}\n');
    const logs: string[] = [];
    const out = await runGitSync('test/libs/sub', {
      repoPath: sub,
      log: (m) => logs.push(m),
      loadRoster: async () => [
        { agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'wire the parser', files: [join(sub, 'a.txt'), join(sub, 'b.txt')] },
      ],
    });
    expect(out.attribution).toEqual([
      expect.objectContaining({ scope: 'libs/sub', agentCommitCount: 1, attributableFileCount: 2, attributedFileCount: 2 }),
    ]);
    expect(logs.some((m) => m.includes('attributed-file share 2/2 ledger-attributed file(s)'))).toBe(true);
    // generated.json had no owner, so it is committed anonymously without counting against the share.
    expect(git(sub, 'status', '--porcelain')).toBe('');
  });

  it('pushes the submodule branch to origin FIRST, then bumps+pushes the superproject pointer', () => {
    // dirty the submodule AND the superproject
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo }).then((out) => {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') {
        expect(out.pushed).toContain('superproject');
        expect(out.pushed).toContain('libs/sub');
      }

      // submodule origin received the sub commit (pushed to main from detached HEAD)
      expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
      // The commit is now anchored to a local branch before it is pushed.
      expect(git(join(repo, 'libs/sub'), 'branch', '--show-current')).toBe('main');
      // superproject origin received the super commit
      expect(git(superOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);

      // the committed superproject pointer == the submodule's pushed HEAD (fresh clone resolves the pin)
      const subHead = git(join(repo, 'libs/sub'), 'rev-parse', 'HEAD');
      const pointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
      expect(pointer).toBe(subHead);
      // and that submodule commit exists on the submodule's origin (pin is reachable remotely)
      expect(() => git(subOrigin, 'cat-file', '-e', `${subHead}^{commit}`)).not.toThrow();
    });
  });

  it('commits a changed superproject gitlink before attributed root sources', async () => {
    const subRepo = join(repo, 'libs/sub');
    writeFileSync(join(subRepo, 'sub.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'root-attributed.ts'), 'export const sourceVersion = 2;\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      loadRoster: async () => [
        {
          agent: 'cup-7',
          agentLabel: 'Cup Seven',
          intent: 'update the root integration',
          files: ['root-attributed.ts'],
        },
      ],
    });

    expect(out.status).toBe('synced');
    const subHead = git(subRepo, 'rev-parse', 'HEAD');
    const attributed = git(
      superOrigin,
      'log',
      '-1',
      '--fixed-strings',
      '--grep=Co-Authored-By: Cup Seven <cup-7@agents.papercusp>',
      '--format=%H',
      'main',
    );
    expect(attributed).not.toBe('');
    // The attributed commit's parent already carries the newly committed submodule pin.
    expect(git(superOrigin, 'rev-parse', attributed + '^:libs/sub')).toBe(subHead);
    expect(git(superOrigin, 'rev-parse', attributed + ':libs/sub')).toBe(subHead);
    expect(git(superOrigin, 'rev-parse', 'main:libs/sub')).toBe(subHead);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('commits attributed root sources while a protected submodule worktree has an unchanged gitlink', async () => {
    const subRepo = join(repo, 'libs/sub');
    const originalPointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
    writeFileSync(join(subRepo, 'sub.txt'), 'pending protected submodule edit\n');
    writeFileSync(join(repo, 'root-attributed.ts'), 'export const sourceVersion = 2;\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      excludePaths: ['libs/sub/sub.txt'],
      log: message => logs.push(message),
      loadRoster: async () => [{
        agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'update independent root source',
        files: ['root-attributed.ts'],
      }],
    });

    expect(out.status).toBe('synced');
    expect(git(superOrigin, 'show', 'main:root-attributed.ts')).toBe('export const sourceVersion = 2;');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(originalPointer);
    expect(git(subRepo, 'rev-parse', 'HEAD')).toBe(originalPointer);
    expect(readFileSync(join(subRepo, 'sub.txt'), 'utf8')).toBe('pending protected submodule edit\n');
    expect(git(subRepo, 'status', '--porcelain')).toContain('sub.txt');
    expect(git(repo, 'status', '--porcelain', 'root-attributed.ts')).toBe('');
    expect(logs.join('\n')).not.toContain('deferring attributed source path(s)');
  });

  it.each([false, true])('commits attributed root sources with a stale shared-index gitlink (protected child: %s)', async (protectedChild) => {
    const subRepo = join(repo, 'libs/sub');
    const originalPointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
    // Create a valid alternate commit without moving either repository's HEAD.
    const stalePointer = git(subRepo, 'commit-tree', git(subRepo, 'rev-parse', 'HEAD^{tree}'),
      '-p', originalPointer, '-m', 'stale index fixture');
    git(repo, 'update-index', '--cacheinfo', '160000', stalePointer, 'libs/sub');
    expect(stalePointer).not.toBe(originalPointer);
    expect(git(subRepo, 'rev-parse', 'HEAD')).toBe(originalPointer);
    expect(git(repo, 'rev-parse', ':libs/sub')).toBe(stalePointer);
    if (protectedChild) writeFileSync(join(subRepo, 'sub.txt'), 'protected child work\n');
    writeFileSync(join(repo, 'root-attributed.ts'), 'export const sourceVersion = 2;\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      excludePaths: protectedChild ? ['libs/sub/sub.txt'] : [],
      log: message => logs.push(message),
      loadRoster: async () => [{
        agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'update independent root source',
        files: ['root-attributed.ts'],
      }],
    });

    expect(out.status).toBe('synced');
    expect(logs.join('\n')).not.toContain('deferring attributed source path(s)');
    expect(git(superOrigin, 'show', 'main:root-attributed.ts')).toBe('export const sourceVersion = 2;');
    expect(git(superOrigin, 'rev-parse', 'main:libs/sub')).toBe(originalPointer);
    expect(git(subRepo, 'rev-parse', 'HEAD')).toBe(originalPointer);
    expect(git(repo, 'status', '--porcelain', 'root-attributed.ts')).toBe('');
    if (protectedChild) expect(readFileSync(join(subRepo, 'sub.txt'), 'utf8')).toBe('protected child work\n');
  });

  it.each(['parent pin', 'child HEAD'])('retains the attributed-source hold when the %s is unreadable', async (unreadable) => {
    const subRepo = join(repo, 'libs/sub');
    const originalPointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
    // A pending child commit survives private-index seeding; stale shared-index
    // dirt is intentionally discarded by the full sync before this guard runs.
    writeFileSync(join(subRepo, 'sub.txt'), 'sub-v2\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'protected pointer fixture');
    expect(git(subRepo, 'rev-parse', 'HEAD')).not.toBe(originalPointer);
    writeFileSync(join(repo, 'root-attributed.ts'), 'export const sourceVersion = 2;\n');
    let readingChild = false;
    let refusedReads = 0;
    const pinReads: Array<{ cwd: string; args: string[] }> = [];
    const runGit: RunGit = async (args, cwd, options) => {
      if (args.includes('rev-parse')) pinReads.push({ cwd, args });
      if (cwd === repo && args.join(' ') === 'rev-parse --verify HEAD:libs/sub') {
        readingChild = true;
        if (unreadable === 'parent pin') {
          refusedReads += 1;
          return { code: 128, stdout: '', stderr: 'fixture: unreadable parent pin' };
        }
      } else if (readingChild && cwd === subRepo && args.join(' ') === 'rev-parse HEAD') {
        readingChild = false;
        if (unreadable === 'child HEAD') {
          refusedReads += 1;
          return { code: 128, stdout: '', stderr: 'fixture: unreadable child HEAD' };
        }
      }
      return directRunGit(args, cwd, options);
    };
    const deferred: string[] = [];
    const out = await commitAttributedGroups(runGit, repo, new Map([
      ['root-attributed.ts', {
        agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'update independent root source',
      }],
    ]), ['libs/sub'], 'auto-commit test', {
      priorityPaths: ['libs/sub'],
      deferAttributedPaths: paths => deferred.push(...paths),
    });

    expect(refusedReads, JSON.stringify(pinReads)).toBeGreaterThan(0);
    expect(out.committedAny).toBe(false);
    expect(deferred).toEqual(['root-attributed.ts']);
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('root-attributed.ts');
    expect(git(superOrigin, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('root-attributed.ts');
    expect(readFileSync(join(repo, 'root-attributed.ts'), 'utf8')).toBe('export const sourceVersion = 2;\n');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(originalPointer);
  });

  it('retains the attributed-source hold for a genuinely changed protected gitlink', async () => {
    const subRepo = join(repo, 'libs/sub');
    const originalPointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
    writeFileSync(join(subRepo, 'sub.txt'), 'sub-v2\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'protected pointer fixture');
    const changedPointer = git(subRepo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'root-attributed.ts'), 'export const sourceVersion = 2;\n');
    const deferred: string[] = [];
    const out = await commitAttributedGroups(directRunGit, repo, new Map([
      ['root-attributed.ts', {
        agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'update independent root source',
      }],
    ]), ['libs/sub'], 'auto-commit test', {
      priorityPaths: ['libs/sub'],
      deferAttributedPaths: paths => deferred.push(...paths),
    });

    expect(changedPointer).not.toBe(originalPointer);
    expect(out.committedAny).toBe(false);
    expect(out.error).toContain('priority gitlink path(s) are excluded');
    expect(deferred).toEqual(['root-attributed.ts']);
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('root-attributed.ts');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(originalPointer);
    expect(git(subRepo, 'rev-parse', 'HEAD')).toBe(changedPointer);
  });

  it('falls back to one catch-all when the priority gitlink commit CAS is refused', async () => {
    const subRepo = join(repo, 'libs/sub');
    const initialSuperHead = git(superOrigin, 'rev-parse', 'main');
    writeFileSync(join(subRepo, 'sub.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'root-attributed.ts'), 'export const sourceVersion = 2;\n');
    let priorityCasRefused = false;
    const logs: string[] = [];
    const runGit: RunGit = async (args, cwd, options) => {
      if (
        !priorityCasRefused &&
        cwd === repo &&
        args.includes('update-ref') &&
        args.includes('git-sync: priority submodule gitlinks')
      ) {
        priorityCasRefused = true;
        return { code: 1, stdout: '', stderr: 'fatal: update-ref CAS refused by test' };
      }
      return directRunGit(args, cwd, options);
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      runGit,
      log: (message) => logs.push(message),
      loadRoster: async () => [
        {
          agent: 'cup-7',
          agentLabel: 'Cup Seven',
          intent: 'update the root integration',
          files: ['root-attributed.ts'],
        },
      ],
    });

    expect(priorityCasRefused).toBe(true);
    expect(out.status).toBe('synced');
    expect(logs.join('\n')).toContain('priority gitlink commit CAS refused');
    expect(git(superOrigin, 'rev-parse', 'main^')).toBe(initialSuperHead);
    const subHead = git(subRepo, 'rev-parse', 'HEAD');
    expect(git(superOrigin, 'rev-parse', 'main:libs/sub')).toBe(subHead);
    expect(git(superOrigin, 'show', 'main:root-attributed.ts')).toBe('export const sourceVersion = 2;');
    expect(
      git(
        superOrigin,
        'log',
        '--fixed-strings',
        '--grep=Co-Authored-By: Cup Seven <cup-7@agents.papercusp>',
        '--format=%H',
        'main',
      ),
    ).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-25243356801974396: merges a submodule pin when the incoming pin is an ancestor of the local pin', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'switch', 'main');

    // The remote superproject will point at this commit; the local pointer will
    // advance one commit further, so merge-ort should retain the local gitlink.
    writeFileSync(join(subRepo, 'incoming.txt'), 'incoming submodule commit\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'incoming submodule commit');
    const incomingSub = git(subRepo, 'rev-parse', 'HEAD');
    git(subRepo, 'push', 'origin', 'HEAD:main');

    writeFileSync(join(subRepo, 'local.txt'), 'local descendant\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'local submodule descendant');
    const localSub = git(subRepo, 'rev-parse', 'HEAD');
    git(subRepo, 'commit-graph', 'write', '--reachable');

    writeFileSync(join(repo, 'local-superproject.txt'), 'local superproject commit\n');
    git(repo, 'add', 'libs/sub', 'local-superproject.txt');
    git(repo, 'commit', '--no-verify', '-m', 'local superproject descendant pin');

    // Publish a sibling superproject commit whose gitlink points at incomingSub.
    const other = join(root, 'other');
    git(root, 'clone', superOrigin, other);
    configUser(other);
    git(other, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    const otherSub = join(other, 'libs/sub');
    git(otherSub, 'fetch', 'origin', 'main');
    git(otherSub, 'checkout', '--detach', incomingSub);
    writeFileSync(join(other, 'remote-superproject.txt'), 'remote superproject commit\n');
    git(other, 'add', 'libs/sub', 'remote-superproject.txt');
    git(other, 'commit', '--no-verify', '-m', 'remote superproject descendant pin');
    git(other, 'push', 'origin', 'main');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: { push: false, pushSubmodules: false },
    });

    expect(out.status, JSON.stringify(out)).toBe('synced');
    expect(git(repo, 'show', 'HEAD:remote-superproject.txt')).toBe('remote superproject commit');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(localSub);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  const makeMigrationFenceInputs = () => {
    const migration = 'libs/db/sql/999-unreserved-migration.sql';
    const subRepo = join(repo, 'libs/sub');
    mkdirSync(join(subRepo, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(subRepo, migration), '-- intentionally unreserved\n');
    writeFileSync(join(subRepo, 'sub-unrelated.txt'), 'submodule work\n');
    writeFileSync(join(repo, 'schema-consumer.ts'), 'export const schemaVersion = 2;\n');
    writeFileSync(join(repo, 'root-unrelated.txt'), 'unrelated root work\n');
    const checker = vi.fn(async (paths: readonly string[]) =>
      paths.includes(migration)
        ? [{ path: migration, reason: '[migration-reservation-guard] reservation missing' }]
        : [],
    );
    return { migration, subRepo, checker };
  };

  it('EI-24940157290396415: a refused migration fences same-work-item root sources while unrelated files advance', async () => {
    const { migration, subRepo, checker } = makeMigrationFenceInputs();
    const loadMigrationFenceRoster = vi.fn(async (): Promise<AttributionRosterEntry[]> => [
      {
        agent: 'su-migration',
        files: ['libs/sub/' + migration, 'schema-consumer.ts'],
        workItems: ['WI-migration'],
      },
      { agent: 'su-unrelated', files: ['root-unrelated.txt'], workItems: ['WI-other'] },
    ]);

    const out = await runGitSync('test', {
      repoPath: repo,
      migrationReservationChecker: checker,
      loadMigrationFenceRoster,
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('libs/sub');
    expect(loadMigrationFenceRoster).toHaveBeenCalledOnce();
    expect(out.skippedPaths ?? []).toContainEqual(
      expect.objectContaining({
        scope: 'libs/sub',
        path: migration,
        reason: 'migration-reservation',
      }),
    );
    expect(out.skippedPaths ?? []).toContainEqual(
      expect.objectContaining({
        scope: 'superproject',
        path: 'schema-consumer.ts',
        reason: 'migration-dependency-fence',
      }),
    );
    expect(git(subOrigin, 'show', 'main:sub-unrelated.txt')).toBe('submodule work');
    expect(() => git(subOrigin, 'show', 'main:' + migration)).toThrow();
    expect(git(superOrigin, 'show', 'main:root-unrelated.txt')).toBe('unrelated root work');
    expect(() => git(superOrigin, 'show', 'main:schema-consumer.ts')).toThrow();
    expect(git(subRepo, 'status', '--porcelain', '--', migration)).toMatch(/999-unreserved-migration\.sql/);
    expect(git(repo, 'status', '--porcelain', '--', 'schema-consumer.ts')).toMatch(/schema-consumer\.ts/);
    expect(git(repo, 'status', '--porcelain', '--', 'root-unrelated.txt')).toBe('');
  });

  it('attributes a refused migration through its exact live lock holder when the edit roster misses it', async () => {
    const { migration, subRepo, checker } = makeMigrationFenceInputs();
    const loadMigrationFenceRoster = vi.fn(async (): Promise<AttributionRosterEntry[]> => [
      { agent: 'su-lock-holder', files: ['schema-consumer.ts'], workItems: [] },
      { agent: 'su-unrelated', files: ['root-unrelated.txt'], workItems: ['WI-other'] },
    ]);

    const out = await runGitSync('test', {
      repoPath: repo,
      migrationReservationChecker: checker,
      loadMigrationFenceRoster,
      liveLockHoldings: [{
        path: `libs/sub/${migration}`,
        owner: 'su-lock-holder',
        intent: 'turn-scoped hold',
      }],
    });

    expect(out.status).toBe('synced');
    expect(loadMigrationFenceRoster).toHaveBeenCalledOnce();
    const fence = out.skippedPaths?.find(
      (entry) => 'reason' in entry && entry.reason === 'migration-dependency-fence' && entry.path === 'schema-consumer.ts',
    );
    if (!fence || !('reason' in fence) || fence.reason !== 'migration-dependency-fence') {
      throw new Error('Expected a migration dependency fence receipt');
    }
    expect(fence).toMatchObject({
      scope: 'superproject',
      path: 'schema-consumer.ts',
      reason: 'migration-dependency-fence',
      blockingMigrations: [`libs/sub/${migration}`],
      blockingAgents: ['su-lock-holder'],
      blockingWorkItems: [],
    });
    expect(fence?.unattributedMigrations).toBeUndefined();
    expect(fence?.detail).toContain('same agent');
    expect(out.skippedPaths ?? []).not.toContainEqual(
      expect.objectContaining({ scope: 'superproject', path: 'root-unrelated.txt', reason: 'migration-dependency-fence' }),
    );
    expect(out.skippedPaths ?? []).toContainEqual(
      expect.objectContaining({ scope: 'libs/sub', path: migration, reason: 'migration-reservation' }),
    );
    expect(() => git(subOrigin, 'show', 'main:' + migration)).toThrow();
    expect(git(superOrigin, 'show', 'main:root-unrelated.txt')).toBe('unrelated root work');
    expect(git(repo, 'status', '--porcelain', '--', 'schema-consumer.ts')).toMatch(/schema-consumer\.ts/);
    expect(git(repo, 'status', '--porcelain', '--', 'root-unrelated.txt')).toBe('');
    expect(git(subRepo, 'status', '--porcelain', '--', migration)).toMatch(/999-unreserved-migration\.sql/);
  });

  it('EI-24940157290396415: an unattributed refused migration holds all root sources fail-closed', async () => {
    const { migration, subRepo, checker } = makeMigrationFenceInputs();
    const loadMigrationFenceRoster = vi.fn(async (): Promise<AttributionRosterEntry[]> => [
      { agent: 'su-other', files: ['schema-consumer.ts', 'root-unrelated.txt'], workItems: ['WI-other'] },
    ]);

    const out = await runGitSync('test', {
      repoPath: repo,
      migrationReservationChecker: checker,
      loadMigrationFenceRoster,
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('libs/sub');
    expect(loadMigrationFenceRoster).toHaveBeenCalledOnce();
    expect(out.skippedPaths ?? []).toContainEqual(
      expect.objectContaining({
        scope: 'superproject',
        path: 'schema-consumer.ts',
        reason: 'migration-dependency-fence',
        detail: expect.stringContaining('could not be attributed'),
      }),
    );
    expect(out.skippedPaths ?? []).toContainEqual(
      expect.objectContaining({
        scope: 'superproject',
        path: 'root-unrelated.txt',
        reason: 'migration-dependency-fence',
      }),
    );
    expect(git(subOrigin, 'show', 'main:sub-unrelated.txt')).toBe('submodule work');
    expect(() => git(subOrigin, 'show', 'main:' + migration)).toThrow();
    expect(git(repo, 'status', '--porcelain', '--', 'schema-consumer.ts')).toMatch(/schema-consumer\.ts/);
    expect(git(repo, 'status', '--porcelain', '--', 'root-unrelated.txt')).toMatch(/root-unrelated\.txt/);
    expect(git(superOrigin, 'rev-parse', 'main:libs/sub')).toBe(git(subRepo, 'rev-parse', 'HEAD'));
    expect(() => git(superOrigin, 'show', 'main:schema-consumer.ts')).toThrow();
    expect(() => git(superOrigin, 'show', 'main:root-unrelated.txt')).toThrow();
  });

  it('EI-24433253827583139: refuses to publish an importer when submodule fetch failed before the export was observed', async () => {
    const subWriter = join(root, 'sub-writer');
    git(root, 'clone', subOrigin, subWriter);
    configUser(subWriter);
    writeFileSync(join(subWriter, 'turn-error.ts'), 'export const classify = () => "ok";\n');
    git(subWriter, 'add', '-A');
    git(subWriter, 'commit', '--no-verify', '-m', 'publish turn-error export');
    git(subWriter, 'push', '-u', 'origin', 'main');

    const remoteSubHead = git(subWriter, 'rev-parse', 'HEAD');
    const staleSubHead = git(join(repo, 'libs/sub'), 'rev-parse', 'HEAD');
    const originalSuperHead = git(superOrigin, 'rev-parse', 'main');
    expect(staleSubHead).not.toBe(remoteSubHead);
    expect(existsSync(join(repo, 'libs/sub', 'turn-error.ts'))).toBe(false);

    // This superproject source now depends on an export that exists at the submodule
    // origin but is absent from the locally pinned submodule revision.
    writeFileSync(join(repo, 'consumer.ts'), "import { classify } from './libs/sub/turn-error';\nvoid classify;\n");

    const failedSubmoduleFetch: RunGit = async (args, cwd) => {
      if (cwd === join(repo, 'libs/sub') && args[0] === 'fetch') {
        return { code: 1, stdout: '', stderr: 'simulated temporary submodule fetch failure' };
      }
      return directRunGit(args, cwd);
    };
    const out = await runGitSync('test', { repoPath: repo, runGit: failedSubmoduleFetch });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((e) => e.scope)).toContain('libs/sub');
      expect(out.pushed).not.toContain('superproject');
    }
    expect(git(superOrigin, 'rev-parse', 'main')).toBe(originalSuperHead);
    expect(git(superOrigin, 'rev-parse', 'main:libs/sub')).toBe(staleSubHead);
    // Preserve locally committed source for the next successful submodule-sync tick.
    expect(git(repo, 'show', 'HEAD:consumer.ts')).toContain("'./libs/sub/turn-error'");
  });

  it('EI-21234208817497976: clears an orphaned submodule .git/modules/**/index.lock and publishes the recovered gitlink', async () => {
    const subRepo = join(repo, 'libs/sub');
    writeFileSync(join(subRepo, 'sub-stale-lock-recovered.txt'), 'submodule work survived\n');

    // A checked-out submodule has a `.git` file in its worktree; the real index
    // lives under the superproject's `.git/modules/<path>` directory. Reproduce
    // the fleet incident at that actual path, not at the superproject index.
    const subGitDir = git(subRepo, 'rev-parse', '--absolute-git-dir');
    const lockPath = join(subGitDir, 'index.lock');
    writeFileSync(lockPath, 'partial index from a dead submodule writer');
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status, JSON.stringify(out)).toBe('synced');
    expect(existsSync(lockPath)).toBe(false);
    expect(git(subOrigin, 'ls-tree', '-r', '--name-only', 'main')).toContain('sub-stale-lock-recovered.txt');

    // The parent must point at the submodule commit that was actually published,
    // so a fresh clone can resolve the pin rather than receiving a broken gitlink.
    const subHead = git(subRepo, 'rev-parse', 'HEAD');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(subHead);
    expect(() => git(subOrigin, 'cat-file', '-e', `${subHead}^{commit}`)).not.toThrow();
  });

  it('EI-20611320499473924: attaches a detached submodule to an existing same-tip default branch before committing', async () => {
    const subRepo = join(repo, 'libs/sub');
    // `git submodule update` leaves HEAD detached. Pre-create the default branch at
    // that exact tip, then leave HEAD detached so the attach-only-if-same-tip path runs.
    git(subRepo, 'branch', '-f', 'main', 'HEAD');
    expect(git(subRepo, 'branch', '--show-current')).toBe('');
    writeFileSync(join(subRepo, 'sub-same-tip.txt'), 'same-tip\n');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('synced');
    expect(git(subRepo, 'branch', '--show-current')).toBe('main');
    expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
  });

  it('WI-1871750: fast-forwards a dormant local branch to its descendant detached HEAD without losing dirty work', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'branch', '-f', 'main', 'HEAD');

    // Reproduce the SideStage failure: a submodule update/peer integration advanced
    // detached HEAD while the dormant local branch stayed at its ancestor. The
    // committed descendant and the still-dirty work must both survive attachment.
    writeFileSync(join(subRepo, 'detached-descendant.txt'), 'committed while detached\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'detached descendant work');
    writeFileSync(join(subRepo, 'dirty-after-descendant.txt'), 'must survive branch attachment\n');
    expect(git(subRepo, 'branch', '--show-current')).toBe('');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('synced');
    expect(git(subRepo, 'branch', '--show-current')).toBe('main');
    expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/detached descendant work/);
    expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
    expect(git(subOrigin, 'show', 'main:detached-descendant.txt')).toBe('committed while detached');
    expect(git(subOrigin, 'show', 'main:dirty-after-descendant.txt')).toBe('must survive branch attachment');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(git(subRepo, 'rev-parse', 'HEAD'));
  });

  it('WI-2144358: continues a unique exact-tip remote preservation branch instead of divergent local main', async () => {
    const subRepo = join(repo, 'libs/sub');
    const originMain = git(subRepo, 'rev-parse', 'origin/main');

    git(subRepo, 'switch', '--detach', 'HEAD');
    writeFileSync(join(subRepo, 'pin-basis.txt'), 'preserved remotely\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'preserved detached work');
    const preservedHead = git(subRepo, 'rev-parse', 'HEAD');
    git(subRepo, 'push', 'origin', 'HEAD:refs/heads/restart-pin-fixture');

    git(subRepo, 'switch', 'main');
    writeFileSync(join(subRepo, 'local-main-only.txt'), 'must not be moved\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'divergent local main work');
    const divergentMain = git(subRepo, 'rev-parse', 'main');

    git(subRepo, 'switch', '--detach', preservedHead);
    writeFileSync(join(subRepo, 'dirty-after-pin.txt'), 'must continue on the preserved branch\n');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status, JSON.stringify(out)).toBe('synced');
    expect(git(subRepo, 'branch', '--show-current')).toBe('restart-pin-fixture');
    expect(git(subRepo, 'rev-parse', 'main')).toBe(divergentMain);
    expect(git(subOrigin, 'rev-parse', 'main')).toBe(originMain);
    expect(git(subOrigin, 'show', 'restart-pin-fixture:pin-basis.txt')).toBe('preserved remotely');
    expect(git(subOrigin, 'show', 'restart-pin-fixture:dirty-after-pin.txt')).toBe(
      'must continue on the preserved branch',
    );
  });

  it('WI-2144358: a clean local branch can reconcile through another exact-tip remote branch', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'switch', '--create', 'merge-local');
    writeFileSync(join(subRepo, 'preserved-local-head.txt'), 'reachable on the remote pin\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'local named branch preserved remotely');
    git(subRepo, 'push', 'origin', 'HEAD:restart-pin-fixture');
    const preservedHead = git(subRepo, 'rev-parse', 'HEAD');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status, JSON.stringify(out)).toBe('synced');
    expect(git(subRepo, 'branch', '--show-current')).toBe('merge-local');
    expect(git(subOrigin, 'rev-parse', 'restart-pin-fixture')).toBe(preservedHead);
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(preservedHead);
  });

  it('WI-2144358: ambiguous exact-tip preservation branches keep divergent attachment fail-closed', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'switch', '--detach', 'HEAD');
    writeFileSync(join(subRepo, 'ambiguous-pin-basis.txt'), 'two possible continuation branches\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'ambiguous preserved detached work');
    const preservedHead = git(subRepo, 'rev-parse', 'HEAD');
    git(subRepo, 'push', 'origin', 'HEAD:refs/heads/restart-pin-a');
    git(subRepo, 'push', 'origin', 'HEAD:refs/heads/restart-pin-b');

    git(subRepo, 'switch', 'main');
    writeFileSync(join(subRepo, 'ambiguous-local-main.txt'), 'must stay untouched\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'ambiguous divergent main work');
    const divergentMain = git(subRepo, 'rev-parse', 'main');
    git(subRepo, 'switch', '--detach', preservedHead);
    writeFileSync(join(subRepo, 'ambiguous-dirty.txt'), 'must not choose arbitrarily\n');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((error) => error.message).join('\n')).toMatch(/divergent local branch 'main'/i);
    }
    expect(git(subRepo, 'branch', '--show-current')).toBe('');
    expect(git(subRepo, 'rev-parse', 'main')).toBe(divergentMain);
    expect(git(subOrigin, 'rev-parse', 'restart-pin-a')).toBe(preservedHead);
    expect(git(subOrigin, 'rev-parse', 'restart-pin-b')).toBe(preservedHead);
  });

  it('EI-20611320499473924: refuses a detached submodule whose local default branch diverges', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'branch', '-f', 'main', 'HEAD');
    // Advance the local main branch, then return to the old tip detached. Git-sync
    // must refuse to move/overwrite that divergent branch rather than strand work.
    git(subRepo, 'switch', 'main');
    writeFileSync(join(subRepo, 'sub-branch-only.txt'), 'branch-only\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'branch-only local work');
    git(subRepo, 'switch', '--detach', 'HEAD~1');
    writeFileSync(join(subRepo, 'sub-divergent.txt'), 'divergent\n');
    expect(git(subRepo, 'branch', '--show-current')).toBe('');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((e) => e.message).join('\n')).toMatch(/divergent local branch 'main'/i);
    }
    expect(git(subRepo, 'branch', '--show-current')).toBe('');
    expect(git(subOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
  });

  it('EI-20329530284626235: restores a drifted initialized-submodule origin from canonical .gitmodules before push', async () => {
    const subRepo = join(repo, 'libs/sub');
    const staleOrigin = join(root, 'stale-https-equivalent.git');
    git(subRepo, 'remote', 'set-url', 'origin', staleOrigin);
    expect(git(subRepo, 'remote', 'get-url', 'origin')).toBe(staleOrigin);
    expect(git(repo, 'config', '-f', '.gitmodules', '--get', 'submodule.libs/sub.url')).toBe(subOrigin);

    writeFileSync(join(subRepo, 'sub-new.txt'), 'sub-v2\n');
    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('libs/sub');
    expect(git(subRepo, 'remote', 'get-url', 'origin')).toBe(subOrigin);
    expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
  });

  it('EI-18689553108460319: superproject push:false (bridged-hive commit-only) does NOT strand the submodule — it still pushes to its own origin', () => {
    // Simulates git-sync-action's hive-mode override — the bridge writer is meant to
    // become the SOLE pusher of the superproject's canonical refs, never of an
    // unrelated, independently-hosted submodule library.
    //
    // WI-6016: that override now sets BOTH flags (`cfg.push = false` +
    // `cfg.pushSubmoduleOrigins = true`), so this simulation passes both to stay
    // faithful to production. A BARE `push:false` can no longer mean "still push
    // submodules": it is ambiguous — a JOINER (decideGitSyncPush joinerSide) carries
    // push:false for an entirely different reason and must push NOTHING, ANYWHERE
    // (the S0 no-direct-push invariant, AH-6 in code-plane-federation.test.ts, which
    // this test's original bare-push:false form directly contradicted at the same
    // input). Splitting the knob stays supported; it is now opt-IN rather than
    // fail-open.
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo, config: { push: false, pushSubmoduleOrigins: true } }).then((out) => {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') {
        // the submodule still pushed to ITS OWN origin ...
        expect(out.pushed).toContain('libs/sub');
        // ... but the superproject did NOT (push:false is commit-only for it)
        expect(out.pushed).not.toContain('superproject');
      }
      // submodule origin received the sub commit
      expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
      // superproject origin did NOT receive the super commit — still local-only
      expect(git(superOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
      // the local superproject DOES have the pointer bump + local commit (commit-only, not skipped)
      expect(git(repo, 'log', '--format=%B', 'HEAD')).toMatch(/auto-commit test/);
    });
  });

  it.each(['missing', 'device', 'owner'] as const)('F6: independent submodule publication requires the owner key (%s)', async (signer) => {
    const subRepo = join(repo, 'libs/sub');
    const remoteBefore = git(subOrigin, 'rev-parse', 'main');
    const owner = generateEd25519KeypairDer();
    const device = generateEd25519KeypairDer();
    const scope = { hive_id: owner.pubkeyBase64, repo_key: 'parent-repo' };
    const beforePush = vi.fn(async (args: readonly string[], cwd: string) => {
      await requireHiveEffectAuthority(signer === 'missing' ? null : {
        ...scope,
        sign: async bytes => signWithPrivateKeyDer(signer === 'owner' ? owner.privateKeyDer : device.privateKeyDer, bytes),
      }, scope, ['git-sync-push', cwd, ...args]);
    });
    writeFileSync(join(subRepo, 'owner-fenced.txt'), 'local work survives refusal\n');

    const out = await runGitSync('test', {
      repoPath: repo, runGit: directRunGit,
      config: { push: false, pushSubmoduleOrigins: true }, beforePush,
    });

    expect(beforePush).toHaveBeenCalledWith(['push', 'origin', 'HEAD:main'], subRepo);
    expect(git(subRepo, 'rev-parse', 'HEAD')).not.toBe(remoteBefore);
    expect(git(subRepo, 'status', '--porcelain')).toBe('');
    if (signer === 'owner') {
      expect(out.status).toBe('synced');
      expect(git(subOrigin, 'rev-parse', 'main')).toBe(git(subRepo, 'rev-parse', 'HEAD'));
    } else {
      expect(out.status).toBe('error');
      if (out.status === 'error') expect(out.errors.map(e => e.message).join('\n')).toContain('owning hive key');
      expect(git(subOrigin, 'rev-parse', 'main')).toBe(remoteBefore);
    }
    expect(git(superOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
  });

  it('F6: submodule non-fast-forward retry reauthorizes before another push', async () => {
    const subRepo = join(repo, 'libs/sub');
    const remoteBefore = git(subOrigin, 'rev-parse', 'main');
    let pushes = 0;
    const beforePush = vi.fn(async () => {
      if (beforePush.mock.calls.length > 1) throw new Error('owner key no longer available');
    });
    const runGit: RunGit = async (args, cwd) => {
      if (args[0] === 'push') {
        pushes++;
        return { code: 1, stdout: '', stderr: '! [rejected] main -> main (non-fast-forward)' };
      }
      return directRunGit(args, cwd);
    };
    writeFileSync(join(subRepo, 'retry-fenced.txt'), 'preserved\n');
    const out = await runGitSync('test', {
      repoPath: repo, runGit, beforePush,
      config: { push: false, pushSubmoduleOrigins: true },
    });
    expect(out.status).toBe('error');
    expect(beforePush).toHaveBeenCalledTimes(2);
    expect(pushes).toBe(1);
    expect(git(subOrigin, 'rev-parse', 'main')).toBe(remoteBefore);
    expect(git(subRepo, 'rev-parse', 'HEAD')).not.toBe(remoteBefore);
  });

  it('EI-18689553108460319: `pushSubmoduleOrigins: false` opts a submodule back OUT of pushing too (explicit override still honored)', () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo, config: { pushSubmoduleOrigins: false } }).then((out) => {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') {
        expect(out.pushed).not.toContain('libs/sub');
        expect(out.pushed).toContain('superproject');
      }
      // submodule origin did NOT receive the sub commit — still local-only
      expect(git(subOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
    });
  });

  it('reconciles a DIVERGED submodule (behind its origin) via fetch+merge+push instead of erroring', () => {
    // a peer advances the submodule's origin → the harness submodule is now behind
    const subOther = join(root, 'subother');
    git(root, 'clone', subOrigin, subOther);
    configUser(subOther);
    writeFileSync(join(subOther, 'peer.txt'), 'peer-sub-change\n');
    git(subOther, 'add', '-A');
    git(subOther, 'commit', '--no-verify', '-m', 'peer sub change');
    git(subOther, 'push', 'origin', 'main');

    // local change in the submodule → diverged (local commit on a now-behind base)
    writeFileSync(join(repo, 'libs/sub', 'local-sub.txt'), 'local-sub-change\n');

    return runGitSync('test', { repoPath: repo }).then((out) => {
      // the OLD pipeline returned {status:'error'} (non-fast-forward); now it merges
      expect(out.status).toBe('synced');
      if (out.status === 'synced') expect(out.pushed).toContain('libs/sub');
      // both the peer's and the local submodule commit are now on the submodule origin
      const subOriginFiles = git(subOrigin, 'ls-tree', '-r', '--name-only', 'main');
      expect(subOriginFiles).toContain('peer.txt');
      expect(subOriginFiles).toContain('local-sub.txt');
    });
  });

  it('EI-255862: checkpoints the root commit proof before a later HEAD replaces it', async () => {
    const phases = new Map<string, unknown>();
    const step: GitSyncStepRunner = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      if (phases.has(name)) return structuredClone(phases.get(name)) as T;
      const result = await operation();
      phases.set(name, structuredClone(result));
      return result;
    };
    const options = { repoPath: repo, config: { push: false, pushSubmodules: false }, step };
    writeFileSync(join(repo, 'root-proof.txt'), 'first local tick\n');
    const first = await runGitSync('test', options);
    const firstCommit = git(repo, 'rev-parse', 'HEAD');
    expect(first.localCommitSha).toBe(firstCommit);

    writeFileSync(join(repo, 'later-tick.txt'), 'independent later tick\n');
    git(repo, 'add', 'later-tick.txt');
    git(repo, 'commit', '--no-verify', '-m', 'independent later tick');
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(firstCommit);

    const resumed = await runGitSync('test', options);
    expect(resumed.localCommitSha).toBe(firstCommit);
    expect(phases.get('git-sync:pointer-bump')).toMatchObject({ localCommitSha: firstCommit });

    // Legacy checkpoint outputs cannot prove which root commit was created.
    const legacyPhase = { ...phases.get('git-sync:pointer-bump') as Record<string, unknown> };
    delete legacyPhase.localCommitSha;
    phases.set('git-sync:pointer-bump', legacyPhase);
    const legacyResume = await runGitSync('test', options);
    expect(legacyResume.localCommitSha).toBeUndefined();
  });

  it('EI-255886: replaying an old commit phase cannot satisfy a newer no-SHA wait', async () => {
    const phases = new Map<string, unknown>();
    const step: GitSyncStepRunner = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      if (phases.has(name)) return structuredClone(phases.get(name)) as T;
      const result = await operation();
      phases.set(name, structuredClone(result));
      return result;
    };
    const options = { repoPath: repo, config: { push: false, pushSubmodules: false }, step };
    const scope = { installSlug: 'test', workspaceId: 'workspace-test' };
    const emit = vi.fn(async (_opts: { key: string; payload?: unknown }) => ({
      ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0,
    }));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      writeFileSync(join(repo, 'producer-time.txt'), 'first local tick\n');
      const first = await runGitSync('test', options);
      const firstCommit = git(repo, 'rev-parse', 'HEAD');
      expect(first.localCommitSha).toBe(firstCommit);

      // A later tick advances HEAD after this wait registered. Replay must carry
      // the original producer boundary, not the new HEAD or the emission time.
      const laterWait = gitSyncScopePayloadFilter(scope, 'committed', 2_000);
      now.mockReturnValue(4_000);
      writeFileSync(join(repo, 'later-producer.txt'), 'independent later tick\n');
      git(repo, 'add', 'later-producer.txt');
      git(repo, 'commit', '--no-verify', '-m', 'independent later producer');
      const resumed = await runGitSync('test', options);
      expect(resumed.localCommitSha).toBe(firstCommit);
      expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(firstCommit);
      emitGitSyncCommittedEvent(resumed.localCommitSha!, { scope, emit }, resumed.localCommitAtMs);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const payload = emit.mock.calls.find(([opts]) => opts.key === 'git-sync:committed')?.[0].payload;
      expect(payloadMatchesFilter(laterWait, payload)).toBe(false);
      expect(payloadMatchesFilter(gitSyncScopePayloadFilter(scope, 'committed', 500), payload)).toBe(true);
      expect(emit.mock.calls.map(([opts]) => opts.key)).toContain(`git-sync:committed:${firstCommit}`);
      expect(payload).toMatchObject({ sha: firstCommit, committedAtMs: 1_000 });
      expect(phases.get('git-sync:pointer-bump')).toMatchObject({ localCommitAtMs: 1_000 });

      // Old checkpoints can prove a SHA without a timestamp. Do not manufacture
      // freshness for them, while preserving the precise per-SHA signal.
      const legacyPhase = { ...phases.get('git-sync:pointer-bump') as Record<string, unknown> };
      delete legacyPhase.localCommitAtMs;
      phases.set('git-sync:pointer-bump', legacyPhase);
      emit.mockClear();
      const legacy = await runGitSync('test', options);
      emitGitSyncCommittedEvent(legacy.localCommitSha!, { scope, emit }, legacy.localCommitAtMs);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const legacyPayload = emit.mock.calls.find(([opts]) => opts.key === 'git-sync:committed')?.[0].payload;
      expect(payloadMatchesFilter(laterWait, legacyPayload)).toBe(false);
      expect(legacyPayload).not.toHaveProperty('committedAtMs');
      expect(emit.mock.calls.map(([opts]) => opts.key)).toContain(`git-sync:committed:${firstCommit}`);
    } finally {
      now.mockRestore();
    }
  });

  it('GAP-4: a submodule unreachable while ahead → errors + defers the superproject PUSH (no broken gitlink) but still COMMITS it locally', () => {
    // dirty the submodule (→ ahead after its local commit) and the superproject
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');
    // Break the canonical URL as well as the initialized copy. EI-20329530284626235
    // deliberately heals copy-only drift from `.gitmodules`, so this test must model
    // a genuinely unreachable canonical origin rather than stale local configuration.
    const goneOrigin = join(root, 'gone.git');
    git(repo, 'config', '-f', '.gitmodules', 'submodule.libs/sub.url', goneOrigin);
    git(join(repo, 'libs/sub'), 'remote', 'set-url', 'origin', goneOrigin);

    return runGitSync('test', { repoPath: repo }).then((out) => {
      expect(out.status).toBe('error');
      if (out.status === 'error') {
        expect(out.errors.map((e) => e.scope)).toContain('libs/sub');
        // the superproject must NOT be pushed — its gitlink would point at an unpushed
        // submodule commit a fresh clone can't resolve.
        expect(out.pushed).not.toContain('superproject');
      }
      expect(git(superOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);

      // EI-20182436053613562: the deferral is PUSH-ONLY. The superproject's own dirty
      // file has no relationship to any submodule pointer, and a local commit publishes
      // nothing, so it must still land. Gating the commit on this same condition is what
      // let ONE permanently-failing submodule push (a GitHub 403 no retry can clear)
      // freeze every agent's work in the shared tree for 12h — including untracked files
      // that existed on no other disk.
      expect(git(repo, 'log', '--format=%B', 'HEAD')).toMatch(/auto-commit test/);
      expect(git(repo, 'status', '--porcelain', 'super-new.txt')).toBe('');
      expect(out.headSha).toBe(git(repo, 'rev-parse', 'HEAD'));
      // The local root commit is independent of the aggregate submodule error.
      expect(out.localCommitSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    });
  });
});

describe('runGitSync (real git, two submodules) — GAP-1 continue-past-conflict', () => {
  let root: string;
  let superOrigin: string;
  let subAOrigin: string; // will be made to conflict
  let subBOrigin: string; // clean, ahead → must still push despite A's conflict
  let repo: string;
  const allowFile = ['-c', 'protocol.file.allow=always'];

  const seedSub = (origin: string, name: string): void => {
    const seed = join(root, `${name}seed`);
    git(root, 'clone', origin, seed);
    configUser(seed);
    writeFileSync(join(seed, `${name}.txt`), `${name}-v1\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', `${name} init`);
    git(seed, 'push', '-u', 'origin', 'main');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-2sub-'));
    superOrigin = join(root, 'super-origin.git');
    subAOrigin = join(root, 'subA-origin.git');
    subBOrigin = join(root, 'subB-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subAOrigin);
    git(root, 'init', '--bare', '-b', 'main', subBOrigin);
    seedSub(subAOrigin, 'subA');
    seedSub(subBOrigin, 'subB');

    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subAOrigin, 'libs/subA');
    git(superseed, ...allowFile, 'submodule', 'add', subBOrigin, 'libs/subB');
    configUser(join(superseed, 'libs/subA'));
    configUser(join(superseed, 'libs/subB'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + 2 submodules');
    git(superseed, 'push', '-u', 'origin', 'main');

    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/subA'));
    configUser(join(repo, 'libs/subB'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a conflict in one submodule does NOT block the sibling push, and defers the superproject PUSH (but still commits it locally)', () => {
    // subA: a peer pushes a conflicting line to origin; local edits the SAME line → conflict
    const aOther = join(root, 'subAother');
    git(root, 'clone', subAOrigin, aOther);
    configUser(aOther);
    writeFileSync(join(aOther, 'subA.txt'), 'PEER-EDIT\n');
    git(aOther, 'add', '-A');
    git(aOther, 'commit', '--no-verify', '-m', 'peer conflicting change');
    git(aOther, 'push', 'origin', 'main');
    writeFileSync(join(repo, 'libs/subA', 'subA.txt'), 'LOCAL-EDIT\n'); // same line → will conflict

    // subB: a clean local change → must be pushed despite subA conflicting
    writeFileSync(join(repo, 'libs/subB', 'subB-new.txt'), 'subB-v2\n');
    // dirty the superproject too → must NOT be pushed while subA is unreconciled
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo }).then((out) => {
      // overall: conflict, but the sibling + nothing-after is reported precisely
      expect(out.status).toBe('conflict');
      if (out.status === 'conflict') {
        expect(out.conflicts.map((c) => c.scope)).toContain('libs/subA');
        expect(out.conflicts.find((c) => c.scope === 'libs/subA')?.conflictedFiles).toContain('subA.txt');
        // GAP-1: the clean sibling pushed despite subA's conflict
        expect(out.pushed).toContain('libs/subB');
        // GAP-1: the superproject was DEFERRED (a submodule is unreconciled)
        expect(out.pushed).not.toContain('superproject');
      }
      // subB origin actually received the push
      expect(git(subBOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
      // superproject origin was NOT advanced (would publish an unresolvable subA pointer)
      expect(git(superOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
      // subA tree is clean (merge aborted) — local edit preserved
      expect(git(join(repo, 'libs/subA'), 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(readFileSync(join(repo, 'libs/subA', 'subA.txt'), 'utf8')).toBe('LOCAL-EDIT\n');
      // EI-20182436053613562: the DEFERRAL IS PUSH-ONLY — the superproject's own dirty
      // file was still committed LOCALLY. Deferring the local commit too is what stranded
      // every agent's work for 12h behind one unreconcilable submodule.
      expect(git(repo, 'log', '--format=%B', 'HEAD')).toMatch(/auto-commit test/);
      expect(git(repo, 'status', '--porcelain', 'super-new.txt')).toBe('');
      expect(out.headSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    });
  });

  it('EI-20744916065879285: maps protected superproject paths into submodule coordinates', async () => {
    // The caller speaks in superproject-root-relative paths. Both a root file and a
    // submodule file must remain unpublished, while unrelated work in each repo still
    // advances normally.
    writeFileSync(join(repo, 'super-protected.txt'), 'protected root mutation\n');
    writeFileSync(join(repo, 'super-normal.txt'), 'normal root work\n');
    writeFileSync(join(repo, 'libs/subA', 'subA.txt'), 'protected submodule mutation\n');
    writeFileSync(join(repo, 'libs/subB', 'subB-new.txt'), 'normal submodule work\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      excludePaths: [' super-protected.txt ', 'libs/subA/subA.txt'],
    });

    expect(out.status).toBe('synced');
    expect(git(superOrigin, 'show', 'main:super-normal.txt')).toBe('normal root work');
    expect(git(superOrigin, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('super-protected.txt');
    expect(git(subBOrigin, 'show', 'main:subB-new.txt')).toBe('normal submodule work');
    expect(git(subAOrigin, 'show', 'main:subA.txt')).toBe('subA-v1');
    expect(readFileSync(join(repo, 'super-protected.txt'), 'utf8')).toBe('protected root mutation\n');
    expect(readFileSync(join(repo, 'libs/subA', 'subA.txt'), 'utf8')).toBe('protected submodule mutation\n');
    expect(git(repo, 'status', '--porcelain', '--', 'super-protected.txt')).toMatch(/super-protected\.txt/);
    expect(git(join(repo, 'libs/subA'), 'status', '--porcelain', '--', 'subA.txt')).toMatch(/subA\.txt/);
  });

  it('EI-22435583452728403: maps refreshed root-relative locks into each submodule before staging', async () => {
    writeFileSync(join(repo, 'super-normal.txt'), 'normal root work\n');
    writeFileSync(join(repo, 'libs/subA', 'subA.txt'), 'protected submodule mutation\n');
    writeFileSync(join(repo, 'libs/subB', 'subB-new.txt'), 'normal submodule work\n');
    const refreshedHoldings = [{
      path: 'libs/subA/subA.txt',
      owner: 'su-peer',
      intent: 'submodule lock acquired after the initial census',
    }];
    const refreshLiveLockHoldings = vi.fn(async () => refreshedHoldings);

    const out = await runGitSync('test', {
      repoPath: repo,
      refreshLiveLockHoldings,
    });

    // The early root pass adds pre/post-stage censuses before the regular per-repo checks.
    expect(refreshLiveLockHoldings).toHaveBeenCalledTimes(8);
    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toContainEqual({
      scope: 'libs/subA',
      path: 'subA.txt',
      owner: 'su-peer',
      intent: 'submodule lock acquired after the initial census',
    });
    expect(git(subAOrigin, 'show', 'main:subA.txt')).toBe('subA-v1');
    expect(git(subBOrigin, 'show', 'main:subB-new.txt')).toBe('normal submodule work');
    expect(git(superOrigin, 'show', 'main:super-normal.txt')).toBe('normal root work');
    expect(readFileSync(join(repo, 'libs/subA', 'subA.txt'), 'utf8')).toBe('protected submodule mutation\n');
    expect(git(join(repo, 'libs/subA'), 'status', '--porcelain', '--', 'subA.txt')).toMatch(/subA\.txt/);
  });

  it('EI-24712906810240170: a submodule probe lock taken after the pre-stage census never publishes the mutant', async () => {
    // subA must already be dirty, or its pass never reaches the staging seam.
    writeFileSync(join(repo, 'libs/subA', 'subA-other.txt'), 'ordinary submodule work\n');
    const probeLock = { path: 'libs/subA/subA.txt', owner: 'su-probe', intent: 'mutation probe' };
    let mutated = false;
    const subRepo = join(repo, 'libs/subA');
    const runGit: RunGit = async (args, cwd, options) => {
      // Trigger after the submodule's pre-stage census but immediately before its
      // add. This keeps the regression tied to the race boundary, independent of
      // how many root or sibling lock refreshes the setup performs.
      if (!mutated && cwd === subRepo && args[0] === 'add') {
        mutated = true;
        writeFileSync(join(subRepo, 'subA.txt'), 'MUTANT\n');
      }
      return directRunGit(args, cwd, options);
    };
    const refreshLiveLockHoldings = vi.fn(async () => mutated ? [probeLock] : []);
    const logs: string[] = [];

    const out = await runGitSync('test', { repoPath: repo, runGit, refreshLiveLockHoldings, log: (m) => logs.push(m) });

    expect(mutated).toBe(true);
    expect(out.status).toBe('synced');
    expect(logs.join('\n')).toContain('libs/subA: post-stage guard held back');
    expect(git(subAOrigin, 'show', 'main:subA.txt')).toBe('subA-v1');
    expect(git(subAOrigin, 'log', '-p', 'main')).not.toContain('MUTANT');
    // The unlocked remainder still commits in the same tick (the COMMIT hop; publication is
    // exercised by the superproject tests above).
    expect(git(join(repo, 'libs/subA'), 'show', 'HEAD:subA-other.txt'), logs.join('\n')).toBe('ordinary submodule work');
    expect(git(join(repo, 'libs/subA'), 'log', '-p', 'HEAD')).not.toContain('MUTANT');
    expect(out.skippedPaths).toContainEqual({ scope: 'libs/subA', path: 'subA.txt', owner: 'su-probe', intent: 'mutation probe' });
    expect(readFileSync(join(repo, 'libs/subA', 'subA.txt'), 'utf8')).toBe('MUTANT\n');
  });
});

describe('runGitSync — EI-18 oversized-blob guard', () => {
  let root: string;
  let originDir: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-oversized-'));
    originDir = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', originDir);
    const seed = join(root, 'seed');
    git(root, 'clone', originDir, seed);
    configUser(seed);
    writeFileSync(join(seed, 'file.txt'), 'line1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    repo = join(root, 'repo');
    git(root, 'clone', originDir, repo);
    configUser(repo);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // A tiny limit so tests don't write real 95MB files.
  const cfg = { pushSubmodules: false, maxBlobBytes: 1024 } as const;

  it('EXCLUDES an oversized file from the auto-commit, still syncs the rest, and reports it', async () => {
    writeFileSync(join(repo, 'small.txt'), 'ok\n');
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(2048, 1));

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big.bin', sizeBytes: 2048 }]);

    // origin received small.txt but NOT the unpushable blob
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('big.bin');

    // the file is untouched on disk, just left uncommitted (untracked)
    expect(readFileSync(join(repo, 'big.bin')).length).toBe(2048);
    expect(git(repo, 'status', '--porcelain')).toContain('?? big.bin');
  });

  it('an oversized-ONLY dirty tree commits nothing ("nothing") but still reports the file', async () => {
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(4096, 1));
    const before = git(originDir, 'log', '--format=%B', 'main');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('nothing');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big.bin', sizeBytes: 4096 }]);
    expect(git(originDir, 'log', '--format=%B', 'main')).toBe(before); // origin untouched
  });

  it('a clean tree under the limit reports no oversized files', async () => {
    writeFileSync(join(repo, 'fits.txt'), 'small enough\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([]);
  });

  it('P-001: EXCLUDES an oversized file inside an UNTRACKED directory (-uall; the EI-18 bypass)', async () => {
    // A brand-new directory: without `-uall`, `git status --porcelain` collapses it to a
    // single `?? newdir/` entry whose lstat is a directory and is skipped — so the
    // oversized file inside is invisible, gets committed by `add -A`, and wedges the push
    // forever (the original EI-18 incident class). With `-uall` each file is listed.
    mkdirSync(join(repo, 'newdir'));
    writeFileSync(join(repo, 'newdir', 'big.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'small.txt'), 'ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'newdir/big.bin', sizeBytes: 2048 }]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('newdir/big.bin'); // the oversized blob never reached origin
  });

  it('oversized paths with spaces are excluded correctly (-z parsing + literal pathspec)', async () => {
    writeFileSync(join(repo, 'big file with spaces.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'small.txt'), 'ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big file with spaces.bin', sizeBytes: 2048 }]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('big file with spaces.bin');
  });
});

describe('runGitSync — EI-18 oversized in a SUBMODULE does not defer the superproject', () => {
  const allowFile = ['-c', 'protocol.file.allow=always'];
  let root: string;
  let superOrigin: string;
  let subOrigin: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-oversized-sub-'));
    superOrigin = join(root, 'super-origin.git');
    subOrigin = join(root, 'sub-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subOrigin);

    const subseed = join(root, 'subseed');
    git(root, 'clone', subOrigin, subseed);
    configUser(subseed);
    writeFileSync(join(subseed, 'sub.txt'), 'sub-v1\n');
    git(subseed, 'add', '-A');
    git(subseed, 'commit', '--no-verify', '-m', 'sub init');
    git(subseed, 'push', '-u', 'origin', 'main');

    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subOrigin, 'libs/sub');
    configUser(join(superseed, 'libs/sub'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + submodule');
    git(superseed, 'push', '-u', 'origin', 'main');

    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/sub'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('submodule syncs WITHOUT the big file; superproject pointer still bumps + pushes', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-small.txt'), 'sub ok\n');
    writeFileSync(join(repo, 'libs/sub', 'sub-big.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'super-new.txt'), 'super ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: { maxBlobBytes: 1024 } });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toContain('libs/sub');
      expect(out.pushed).toContain('superproject'); // NOT deferred by the exclusion
    }
    expect(out.oversized).toEqual([{ scope: 'libs/sub', path: 'sub-big.bin', sizeBytes: 2048 }]);

    // the submodule's origin got the small file, never the big one
    const subFiles = git(subOrigin, 'ls-tree', '-r', '--name-only', 'main');
    expect(subFiles).toContain('sub-small.txt');
    expect(subFiles).not.toContain('sub-big.bin');

    // the pushed superproject pointer resolves on the submodule origin (no broken gitlink)
    const pointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
    expect(() => git(subOrigin, 'cat-file', '-e', `${pointer}^{commit}`)).not.toThrow();
  });
});

describe('runGitSync — P-002 failure classification (injected git)', () => {
  /** A stub RunGit driven by a per-call decision fn — deterministic, no real git.
   *  WI-5111: commit/merge calls now carry a leading `-c user.name=... -c
   *  user.email=...` bot-identity override (run-git-sync.ts GIT_SYNC_IDENTITY_ARGS)
   *  BEFORE the subcommand — strip those global-flag pairs first (mirrors the
   *  production `gitSubcommand` skip-logic) so `handle`'s `args.join(' ').startsWith(...)`
   *  matchers still see the subcommand first, unaffected by the identity prefix. */
  const stripGitCFlags = (args: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '-C') {
        i++;
        continue;
      }
      out.push(args[i]!);
    }
    return out;
  };
  const fakeGit =
    (handle: (args: string[]) => { code: number; stdout?: string; stderr?: string }): RunGit =>
    async (args) => {
      const r = handle(stripGitCFlags(args));
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

  it('WI-10003100: overlaps sibling submodules but finishes children before parents', async () => {
    let releaseNested!: () => void;
    let releaseSibling!: () => void;
    let nestedEntered!: () => void;
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const enteredNested = new Promise<void>((resolve) => {
      nestedEntered = resolve;
    });
    const seen = new Set<string>();
    let siblingAWaiting = false;
    let siblingBEnteredWhileAWaiting = false;
    const run: RunGit = async (args, cwd) => {
      if (cwd !== '/fake' && !seen.has(cwd)) {
        seen.add(cwd);
        if (cwd === '/fake/libs/a/nested') {
          nestedEntered();
          await nestedGate;
        } else if (cwd === '/fake/libs/a') {
          siblingAWaiting = true;
          await siblingGate;
          siblingAWaiting = false;
        } else if (cwd === '/fake/libs/b') {
          siblingBEnteredWhileAWaiting = siblingAWaiting;
          releaseSibling();
        }
      }
      const command = stripGitCFlags(args).join(' ');
      if (command.startsWith('symbolic-ref')) return { code: 0, stdout: 'main', stderr: '' };
      if (command.startsWith('rev-parse HEAD')) return { code: 0, stdout: 'abc123', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const timeout = setTimeout(() => {
      releaseNested();
      releaseSibling();
    }, 2_000);
    try {
      const syncing = runGitSync('test', {
        repoPath: '/fake',
        runGit: run,
        submodulePaths: ['libs/a', 'libs/a/nested', 'libs/b'],
        config: { push: false, pushSubmoduleOrigins: false },
      });
      await enteredNested;
      expect(seen.has('/fake/libs/a')).toBe(false);
      expect(seen.has('/fake/libs/b')).toBe(false);
      releaseNested();
      await syncing;
      expect(siblingBEnteredWhileAWaiting).toBe(true);
      expect(seen).toEqual(new Set(['/fake/libs/a/nested', '/fake/libs/a', '/fake/libs/b']));
    } finally {
      clearTimeout(timeout);
      releaseNested();
      releaseSibling();
    }
  });

  it('P-002a: a commit failure is reported as error, NOT a phantom conflict', async () => {
    let commitAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' }; // no oversized
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' }; // dirty
      if (j.startsWith('add')) return { code: 0 };
      if (j.startsWith('rev-parse --absolute-git-dir')) return { code: 1, stderr: 'not a git directory' };
      if (j.startsWith('commit')) {
        commitAttempts++;
        return { code: 1, stderr: "fatal: Unable to create '.git/index.lock': File exists" };
      }
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });
    expect(out.status).toBe('error'); // NOT 'conflict' — no merge-resolver dispatched at a phantom
    if (out.status === 'error') {
      expect(out.errors.map((e) => e.scope)).toContain('superproject');
      expect(out.errors[0].message).toMatch(/commit failed/i);
    }
    expect(commitAttempts).toBe(1 + 3); // initial attempt + bounded live-contention retries
  });

  it('EI-258149: a publication failure remains an error when another dirty path is live-held', async () => {
    let commitAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z')) return { code: 0, stdout: ' M file.txt\0 M held.txt\0' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n M held.txt\n' };
      if (j.startsWith('rev-parse --absolute-git-dir')) return { code: 1, stderr: 'not a git directory' };
      if (j.startsWith('commit')) {
        commitAttempts++;
        return { code: 1, stderr: "fatal: Unable to create '.git/index.lock': File exists" };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      liveLockHoldings: [{ path: 'held.txt', owner: 'peer', intent: 'active edit' }],
      config: { push: false, pushSubmodules: false },
    });

    expect(commitAttempts).toBe(4);
    expect(out.skippedPaths).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'held.txt', owner: 'peer' })]));
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'superproject', message: expect.stringContaining('commit failed') })]));
    }
  });

  it('EI-21210284687094143: catch-all commit retries a transient live index.lock instead of red-sticking git-sync', async () => {
    let commitAttempts = 0;
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) return { code: 0 };
      if (j.startsWith('rev-parse --absolute-git-dir')) return { code: 1, stderr: 'live holder' };
      if (j.startsWith('commit')) {
        commitAttempts++;
        if (commitAttempts === 1) {
          return {
            code: 128,
            stderr:
              "fatal: Unable to create '/fake/.git/index.lock': File exists.\n\nAnother git process seems to be running",
          };
        }
        return { code: 0 };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(commitAttempts).toBe(2);
    expect(logs.join('\n')).toContain("'git commit' hit live index.lock contention");
  });

  it('EI-25545265520729999: a failed HEAD read cannot supply partial-outcome head evidence', async () => {
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j === 'submodule sync --recursive') return { code: 1, stderr: 'canonical URL sync unavailable' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j === 'rev-parse HEAD') return { code: 1, stdout: 'd'.repeat(40), stderr: 'HEAD read failed' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', { repoPath: '/fake', runGit: run, submodulePaths: ['libs/sub'] });

    expect(out.status).toBe('error');
    expect(out).not.toHaveProperty('headSha');
  });

  it('EI-20329530284626235: a failed canonical submodule URL sync is loud and blocks pushes', async () => {
    let fetchOrPushCalls = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j === 'submodule sync --recursive') return { code: 1, stderr: 'fatal: malformed .gitmodules URL' };
      if (j.startsWith('fetch') || j.startsWith('push')) fetchOrPushCalls++;
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('rev-parse HEAD')) return { code: 0, stdout: 'abc123' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', { repoPath: '/fake', runGit: run, submodulePaths: ['libs/sub'] });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors).toEqual([
        { scope: 'submodule-config', message: 'canonical submodule URL sync failed: fatal: malformed .gitmodules URL' },
      ]);
    }
    expect(fetchOrPushCalls).toBe(0);
  });

  it('EI-20347384139844425: live config.lock contention retries before failing the tick', async () => {
    let urlSyncAttempts = 0;
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j === 'submodule sync --recursive') {
        urlSyncAttempts++;
        if (urlSyncAttempts < 3) {
          return {
            code: 1,
            stderr: 'error: could not lock config file /fake/.git/config: File exists',
          };
        }
        return { code: 0 };
      }
      // Fail the stale-lock probe closed: this fixture represents a live writer,
      // never an orphan that git-sync is allowed to unlink.
      if (j === 'rev-parse --absolute-git-dir') return { code: 1, stderr: 'not a git directory' };
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count')) return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: true, pushSubmoduleOrigins: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('nothing');
    expect(urlSyncAttempts).toBe(3);
    expect(logs.filter((message) => message.includes('live config.lock contention'))).toHaveLength(2);
  });

  it('P-002a: a commit that simply had nothing to commit (all-oversized) is NOT an error', async () => {
    // every dirty file was excluded as oversized → `git commit` exits non-zero with
    // "nothing to commit" — benign, must fall through to fetch/merge, not error.
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) return { code: 0 };
      if (j.startsWith('commit')) return { code: 1, stdout: 'nothing to commit, working tree clean' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: false },
    });
    expect(out.status).toBe('nothing'); // benign — not an error
  });

  it('P-002b: a failed merge with NO conflicted paths is classified error, not conflict', async () => {
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' }; // clean tree
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge --no-edit'))
        return {
          code: 1,
          stderr: 'error: Your local changes to the following files would be overwritten by merge:\n  file.txt',
        };
      if (j.startsWith('diff --name-only --diff-filter=U')) return { code: 0, stdout: '' }; // NO unmerged paths
      if (j.startsWith('merge --abort')) return { code: 0 };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });
    expect(out.status).toBe('error'); // NOT 'conflict' — nothing for a merge-resolver to merge
    if (out.status === 'error') {
      expect(out.errors[0].message).toMatch(/merge failed \(no conflicted paths\)/);
      // A failed merge is not positive evidence that the merge stage completed.
      expect(out.mergeCompleted).toEqual([]);
    }
  });

  it('EI-20328688606935149: skips an authenticated no-op push when fetched origin already contains HEAD', async () => {
    let pushCalls = 0;
    let aheadChecks = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count origin/main..HEAD')) {
        aheadChecks++;
        return { code: 0, stdout: '0' };
      }
      if (j.startsWith('push')) {
        pushCalls++;
        return { code: 1, stderr: 'remote: You must verify your email address.' };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });

    expect(out.status).toBe('nothing');
    expect(aheadChecks).toBe(1);
    expect(pushCalls).toBe(0);
  });

  it('EI-20328688606935149: still pushes and reports a failure when HEAD is genuinely ahead', async () => {
    let pushCalls = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count origin/main..HEAD')) return { code: 0, stdout: '2' };
      if (j.startsWith('push')) {
        pushCalls++;
        return { code: 1, stderr: 'remote: You must verify your email address.' };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors[0]?.message).toMatch(/verify your email address/i);
      // The merge stage completed cleanly before the authenticated push failed. That
      // positive evidence must survive the error outcome so the action can retire an
      // earlier merge-conflict escalation without pretending the push succeeded.
      expect(out.mergeCompleted).toEqual(['superproject']);
    }
    expect(pushCalls).toBe(1);
  });

  it('EI-20328688606935149: fails open to the push when the ahead comparison is unavailable', async () => {
    let pushCalls = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count origin/main..HEAD')) return { code: 1, stderr: 'cannot resolve ref' };
      if (j.startsWith('push')) {
        pushCalls++;
        return { code: 0, stderr: 'Everything up-to-date' };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });

    expect(out.status).toBe('nothing');
    expect(pushCalls).toBe(1);
  });

  it('EI-18094449017685490: a transient ENOENT on `git add -A` (concurrent atomic-write race) is retried, not surfaced as an error', async () => {
    let addAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' }; // no oversized
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' }; // dirty
      if (j.startsWith('add')) {
        addAttempts++;
        // vanishes on the first two attempts (a concurrent atomic-write race), lands on the third
        if (addAttempts < 3) {
          return {
            code: 128,
            stderr: "fatal: unable to stat 'some/file.tmp.210675.abc': No such file or directory",
          };
        }
        return { code: 0 };
      }
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });
    expect(out.status).toBe('synced'); // NOT stranded on the transient race
    expect(addAttempts).toBe(3); // the original attempt + 2 retries before it resolved
  });

  it('WI-40170: an ignored protected path drops only its redundant exclusion pathspec and retries', async () => {
    const ignoredPath = 'tools/perf-test/wdio/package-lock.json';
    const stageableProtectedPath = 'tracked-protected.txt';
    const addCalls: string[][] = [];
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      // This case exercises the post-add stderr recovery path, so model the
      // preflight truthfully as "neither protected path is ignored" first.
      if (j.startsWith('check-ignore --')) return { code: 1, stdout: '' };
      if (j.startsWith('add')) {
        addCalls.push(args);
        if (addCalls.length === 1) {
          return {
            code: 1,
            stderr:
              'The following paths are ignored by one of your .gitignore files:\n' +
              `${ignoredPath}\n` +
              'hint: Use -f if you really want to add them.\n',
          };
        }
        return { code: 0 };
      }
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count')) return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      excludePaths: [ignoredPath, stageableProtectedPath],
      config: { pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(addCalls).toHaveLength(2);
    expect(addCalls[0]).toContain(`:(exclude,literal)${ignoredPath}`);
    expect(addCalls[0]).toContain(`:(exclude,literal)${stageableProtectedPath}`);
    expect(addCalls[1]).not.toContain(`:(exclude,literal)${ignoredPath}`);
    expect(addCalls[1]).toContain(`:(exclude,literal)${stageableProtectedPath}`);
    expect(logs.join('\n')).toContain('retrying without force-adding ignored files');
    expect(
      addFailureIgnoredPaths(
        `The following paths are ignored by one of your .gitignore files:\n${ignoredPath}\nhint: Use -f`,
      ),
    ).toEqual([ignoredPath]);
  });

  it('WI-2144346: an ignored ancestor drops only protected descendant exclusions and retries', async () => {
    const ignoredAncestor = 'apps/shop/.astro';
    const ignoredDescendants = [
      `${ignoredAncestor}/collections/blog.schema.json`,
      `${ignoredAncestor}/content-modules.mjs`,
    ];
    const unrelatedProtectedPath = 'apps/shop/src/content/config.ts';
    const addCalls: string[][] = [];
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('check-ignore --')) return { code: 1, stdout: '' };
      if (j.startsWith('add')) {
        addCalls.push(args);
        if (addCalls.length === 1) {
          return {
            code: 1,
            stderr:
              'The following paths are ignored by one of your .gitignore files:\n' +
              `${ignoredAncestor}/\n` +
              'hint: Use -f if you really want to add them.\n',
          };
        }
        return { code: 0 };
      }
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count')) return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      excludePaths: [...ignoredDescendants, unrelatedProtectedPath],
      config: { pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(addCalls).toHaveLength(2);
    for (const path of ignoredDescendants) {
      expect(addCalls[0]).toContain(`:(exclude,literal)${path}`);
      expect(addCalls[1]).not.toContain(`:(exclude,literal)${path}`);
    }
    expect(addCalls[1]).toContain(`:(exclude,literal)${unrelatedProtectedPath}`);
    expect(logs.join('\n')).toContain(`[${ignoredDescendants.join(', ')}]`);
    expect(logs.join('\n')).toContain('retrying without force-adding ignored files');
  });

  it('EI-21025874195651806: filters an ignored untracked protected path before the first add', async () => {
    const ignoredPath = 'tools/perf-test/wdio/package-lock.json';
    const stageableProtectedPath = 'tracked-protected.txt';
    const addCalls: string[][] = [];
    const checkIgnoreCalls: string[][] = [];
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('check-ignore --')) {
        checkIgnoreCalls.push(args);
        // Default `git check-ignore` suppresses tracked files. The fake models
        // that contract: only the ignored-untracked path is returned, so the
        // tracked protected path must remain in the exclusion pathspec. Both
        // paths are verbatim, so they arrive in ONE batched call (WI-6554700010010584).
        const queried = args.slice(2);
        return queried.includes(ignoredPath) ? { code: 0, stdout: `${ignoredPath}\n` } : { code: 1, stdout: '' };
      }
      if (j.startsWith('add')) {
        addCalls.push(args);
        return { code: 0 };
      }
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count')) return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      excludePaths: [ignoredPath, stageableProtectedPath],
      config: { pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(checkIgnoreCalls).toEqual([['check-ignore', '--', ignoredPath, stageableProtectedPath]]);
    expect(addCalls).toHaveLength(1); // no red first attempt + recovery retry
    expect(addCalls[0]).not.toContain(`:(exclude,literal)${ignoredPath}`);
    expect(addCalls[0]).toContain(`:(exclude,literal)${stageableProtectedPath}`);
    expect(logs.join('\n')).toContain('pre-filtering ignored untracked protected path');
  });

  it('EI-20201578457434474: live index.lock contention retries with bounded backoff before surfacing an error', async () => {
    let addAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) {
        addAttempts++;
        if (addAttempts < 3) {
          return {
            code: 128,
            stderr:
              "fatal: Unable to create '/fake/.git/index.lock': File exists.\n\nAnother git process seems to be running",
          };
        }
        return { code: 0 };
      }
      // Make the stale-lock probe fail closed in this injected case: the lock is
      // live contention, not an orphan we are allowed to unlink.
      if (j.startsWith('rev-parse --absolute-git-dir')) return { code: 1, stderr: 'not a git directory' };
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: false },
    });
    expect(out.status).toBe('synced');
    expect(addAttempts).toBe(3); // original attempt + 2 bounded contention retries
  });

  it('EI-18094449017685490: exhausting the transient-ENOENT retry budget still surfaces a real error (never a silent strand)', async () => {
    let addAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) {
        addAttempts++;
        return { code: 128, stderr: "fatal: unable to stat 'some/file.tmp.210675.abc': No such file or directory" };
      }
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });
    expect(out.status).toBe('error'); // a REAL, persistent failure still surfaces loudly
    if (out.status === 'error') expect(out.errors[0].message).toMatch(/git add -A failed/i);
    expect(addAttempts).toBe(4); // 1 original + TRANSIENT_STAT_FAILURE_MAX_RETRIES(3) retries, then give up
  });

  it('P-004: a detached HEAD syncs to its OWN remote default (origin/HEAD → main), not cfg.branch', async () => {
    const fetched: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 1, stderr: 'fatal: ref HEAD is not a symbolic ref' }; // detached
      if (j.startsWith('rev-parse --abbrev-ref origin/HEAD')) return { code: 0, stdout: 'origin/main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' }; // clean
      if (j.startsWith('fetch')) {
        fetched.push(args.join(' '));
        return { code: 0 };
      }
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    // cfg.branch='staging' (the superproject's branch) must NOT be used for this detached repo.
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: false, branch: 'staging' },
    });
    expect(out.status).toBe('nothing'); // clean + up-to-date on main
    // it fetched origin MAIN (the remote default), never origin staging (cfg.branch)
    expect(fetched).toContain('fetch origin +refs/heads/main:refs/remotes/origin/main');
    expect(fetched.join('|')).not.toContain('staging');
  });
});

describe('discoverSubmodulesRecursive — stray-gitlink fallback (2026-07-01)', () => {
  // The incident: ONE index gitlink with no .gitmodules mapping (a test's temp repo swept
  // in by an auto-commit) makes `git submodule status --recursive` exit 128 — the old
  // silent-[] return then stranded EVERY submodule's commits, every tick, while the
  // routine kept reporting "synced". The fallback must (a) SAY SO and (b) still discover
  // the top-level submodules from .gitmodules.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gitsync-discover-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fakeGit =
    (onStatus: { code: number; stdout: string; stderr: string }): RunGit =>
    async (args: string[], _cwd: string) => {
      if (args[0] === 'submodule') return onStatus;
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return {
          code: 0,
          stdout:
            'submodule.libs/a.path libs/a\nsubmodule.libs/deep/b.path libs/deep/b\nsubmodule.libs/uninit.path libs/uninit\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

  it('healthy path: parses recursive status, deepest-first, skipping uninitialized', async () => {
    const runGit = fakeGit({
      code: 0,
      stdout: ' abc123 libs/a (v1)\n def456 libs/deep/b (v2)\n-000000 libs/uninit\n',
      stderr: '',
    });
    expect(await discoverSubmodulesRecursive(runGit, dir)).toEqual(['libs/deep/b', 'libs/a']);
  });

  it('recursive status failure falls back to .gitmodules (initialized only) and logs loudly', async () => {
    // Simulate initialized worktrees for libs/a + libs/deep/b (a .git file), NOT libs/uninit.
    mkdirSync(join(dir, 'libs', 'a'), { recursive: true });
    mkdirSync(join(dir, 'libs', 'deep', 'b'), { recursive: true });
    writeFileSync(join(dir, 'libs', 'a', '.git'), 'gitdir: ../../.git/modules/libs/a\n');
    writeFileSync(join(dir, 'libs', 'deep', 'b', '.git'), 'gitdir: ../../../.git/modules/libs/deep/b\n');
    const logs: string[] = [];
    const runGit = fakeGit({
      code: 128,
      stdout: '',
      stderr: "fatal: no submodule mapping found in .gitmodules for path '.papercusp/scratch/tmp/relgit-XYZ'",
    });
    const paths = await discoverSubmodulesRecursive(runGit, dir, (m) => logs.push(m));
    expect(paths).toEqual(['libs/deep/b', 'libs/a']); // deepest-first, uninit skipped
    expect(logs.join('\n')).toContain('submodule discovery FAILED');
    expect(logs.join('\n')).toContain('relgit-XYZ'); // the stray path is NAMED for the operator
    expect(logs.join('\n')).toContain('git rm --cached'); // ...with the fix command
  });

  // EI-20402093158205519: a '-' row means only that `submodule.<name>.url` is missing from
  // .git/config — NOT that the worktree is empty. On the sidestage tree 7 of 8 submodules
  // were '-'-prefixed yet fully populated, so discovery returned 1 path and three tracked
  // files sat uncommitted for days with no error on any tick. Discovery must not stay
  // silent about a populated worktree it is skipping while that worktree holds real work.
  it('POPULATED but unregistered submodule holding tracked changes is reported, not silently skipped', async () => {
    // libs/uninit is '-' (never `git submodule init`-ed) but its worktree is on disk with
    // a real .git AND two tracked modifications — exactly the silent-strand shape.
    mkdirSync(join(dir, 'libs', 'uninit', '.git'), { recursive: true });
    const logs: string[] = [];
    const runGit: RunGit = async (args: string[], cwd: string) => {
      if (args[0] === 'submodule') {
        return { code: 0, stdout: ' abc123 libs/a (v1)\n-000000 libs/uninit\n', stderr: '' };
      }
      if (args[0] === 'status' && cwd.endsWith(join('libs', 'uninit'))) {
        return { code: 0, stdout: ' M grid-core/src/RichGrid.tsx\n M grid-core/src/index.ts\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    const paths = await discoverSubmodulesRecursive(runGit, dir, (m) => logs.push(m));

    // Behavior is unchanged — reporting only. These worktrees commonly sit on deliberate
    // detached pins, so auto-syncing them would fetch/merge/push and UNPIN them.
    expect(paths).toEqual(['libs/a']);
    const out = logs.join('\n');
    expect(out).toContain('STRANDED WORK');
    expect(out).toContain('libs/uninit'); // the at-risk path is NAMED
    expect(out).toContain('2 tracked file(s)'); // ...with how much is at risk
    expect(out).toContain('git submodule init'); // ...and the operator fix command
  });

  it('unregistered submodule with NO tracked changes stays quiet (scratch churn must not cry wolf)', async () => {
    // Same shape, but the only dirt is untracked scratch (.vitest-tmp/ during a test run).
    // `--untracked-files=no` must make this a non-event, or the warning fires on every tick
    // that any suite happens to be running and is quickly learned to be noise.
    mkdirSync(join(dir, 'libs', 'uninit', '.git'), { recursive: true });
    const logs: string[] = [];
    const runGit: RunGit = async (args: string[]) =>
      args[0] === 'submodule'
        ? { code: 0, stdout: ' abc123 libs/a (v1)\n-000000 libs/uninit\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }; // tracked-only status → clean

    expect(await discoverSubmodulesRecursive(runGit, dir, (m) => logs.push(m))).toEqual(['libs/a']);
    expect(logs.join('\n')).not.toContain('STRANDED WORK');
  });

  it('fallback with no .gitmodules yields [] without throwing', async () => {
    const runGit: RunGit = async (args) =>
      args[0] === 'submodule'
        ? { code: 128, stdout: '', stderr: 'fatal: broken' }
        : { code: 1, stdout: '', stderr: 'no such file' };
    expect(await discoverSubmodulesRecursive(runGit, dir, () => {})).toEqual([]);
  });
});

/**
 * EI-20459175302238839 — `censusStrandedSubmodules`, the census extracted from
 * `discoverSubmodulesRecursive` so a release/deploy preflight can measure the SAME
 * condition without running a sync pass (one copy of the logic, never two).
 *
 * The contract that matters to every consumer is the THREE-VALUED result:
 *   null → NOT MEASURED (`git submodule status` failed)
 *   []   → measured, nothing stranded  (a real all-clear)
 *   [..] → measured, work is stranded
 *
 * A consumer that collapses `null` into `[]` reintroduces exactly the silence this
 * census exists to break, so both are asserted here rather than left implicit. Each
 * case is driven through a stub `RunGit` over a real temp dir — no network, no
 * submodules, and no dependency on this repo's own submodule layout.
 */
describe('censusStrandedSubmodules — the measured/unmeasured contract (EI-20459175302238839)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strand-census-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Mark `<dir>/<p>` as a POPULATED-but-unregistered submodule (the census lstats `.git`). */
  const populate = (p: string) => mkdirSync(join(dir, p, '.git'), { recursive: true });

  /** A stub git: `submodule status` returns `statusOut`, `status --porcelain` returns `dirty`. */
  const stub = (
    statusOut: { code: number; stdout: string },
    dirty: Record<string, string> = {},
  ): RunGit => {
    return async (args, cwd) => {
      if (args[0] === 'submodule') return { ...statusOut, stderr: '' };
      const rel = cwd.startsWith(dir) ? cwd.slice(dir.length + 1) : cwd;
      return { code: 0, stdout: dirty[rel] ?? '', stderr: '' };
    };
  };

  it('returns NULL when `git submodule status` fails — NOT MEASURED, never an all-clear', async () => {
    const logs: string[] = [];
    // ONE stray gitlink anywhere in the tree makes `submodule status --recursive` exit
    // non-zero, which is why this is a real and recurring case rather than a corner.
    const got = await censusStrandedSubmodules(
      stub({ code: 128, stdout: '' }),
      dir,
      (m) => logs.push(m),
    );

    expect(got).toBeNull();
    // Explicitly NOT `[]` — the whole point of the three-valued result.
    expect(got).not.toEqual([]);
    expect(logs.join('\n')).toMatch(/NOT MEASURED/);
    expect(logs.join('\n')).toMatch(/not an all-clear/i);
  });

  it('returns [] when measured with nothing stranded — a real all-clear', async () => {
    const got = await censusStrandedSubmodules(
      stub({ code: 0, stdout: ' abc123 libs/registered (v1)\n' }),
      dir,
    );
    expect(got).toEqual([]);
    expect(got).not.toBeNull();
  });

  it('reports a POPULATED but unregistered submodule holding uncommitted tracked work', async () => {
    populate('libs/token-kit');
    const got = await censusStrandedSubmodules(
      stub({ code: 0, stdout: '-000000 libs/token-kit\n' }, {
        'libs/token-kit': ' M package.json\n M src/index.ts\n',
      }),
      dir,
    );

    // This is the WI-38933 shape: a patch that exists on exactly one box and in no history.
    expect(got).toEqual([
      { path: 'libs/token-kit', trackedFiles: 2, files: ['package.json', 'src/index.ts'] },
    ]);
  });

  it('ignores a genuinely UNINITIALIZED submodule — nothing on disk can be stranded', async () => {
    // '-' means only that `submodule.<name>.url` is absent from .git/config; it says
    // nothing about whether the worktree exists. No `.git` on disk → no work to lose.
    const got = await censusStrandedSubmodules(
      stub({ code: 0, stdout: '-000000 libs/never-cloned\n' }, {
        'libs/never-cloned': ' M ghost.ts\n', // must not be reached
      }),
      dir,
    );
    expect(got).toEqual([]);
  });

  it('ignores a populated, unregistered submodule that is CLEAN', async () => {
    populate('libs/pinned');
    const got = await censusStrandedSubmodules(stub({ code: 0, stdout: '-000000 libs/pinned\n' }), dir);
    // Parked on a deliberate detached pin with no local edits — reporting it would cry
    // wolf on every tick, which is how a real warning gets tuned out.
    expect(got).toEqual([]);
  });

  it('counts TRACKED modifications only — untracked scratch must never cry wolf', async () => {
    populate('libs/pinned');
    const seen: string[][] = [];
    const runGit: RunGit = async (args, cwd) => {
      seen.push(args);
      if (args[0] === 'submodule') return { code: 0, stdout: '-000000 libs/pinned\n', stderr: '' };
      void cwd;
      return { code: 0, stdout: '', stderr: '' };
    };
    await censusStrandedSubmodules(runGit, dir);

    // The exclusion is structural, not a post-filter: a test run leaving .vitest-tmp/ in
    // a submodule would otherwise strand-flag it on every single tick.
    const statusArgs = seen.find((a) => a[0] === 'status');
    expect(statusArgs).toContain('--untracked-files=no');
  });

  it('a dirty-status failure inside one submodule does not strand-flag it or throw', async () => {
    populate('libs/broken');
    const runGit: RunGit = async (args) =>
      args[0] === 'submodule'
        ? { code: 0, stdout: '-000000 libs/broken\n', stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    // An unreadable submodule yields no ROWS, so it is reported as not-stranded rather
    // than crashing the census (and with it every caller, including the deploy gate).
    expect(await censusStrandedSubmodules(runGit, dir)).toEqual([]);
  });
});

// WI-10004413 CLASS GUARD: every index-writing git call in run-git-sync.ts goes through
// recoverIndexLockContention or carries an allowlisted reason. On 2026-09-30 a single
// unwrapped writer (the unstage-protected-paths reset) never reclaimed an orphaned
// index.lock, and the superproject stayed frozen for over an hour until someone removed the lock by hand.
const INDEX_WRITING_GIT_RE =
  /\brunGit\(\s*\[\s*'(reset|read-tree|update-index|rm|checkout|merge|restore|mv|apply|add|commit|rebase|cherry-pick|revert)'/g;

/** Unwrapped index writers that are exempt. The key is a distinctive substring of the call line; the value is the reason. */
const UNWRAPPED_INDEX_WRITER_ALLOWLIST: Record<string, string> = {
  "runGit(['read-tree', 'HEAD']":
    'The index-repair routine owns its live-writer preflight and re-stat, and deliberately refuses (never unlinks) when a writer may hold the index.',
  "runGit(['rebase', '--rebase-merges'":
    'A multi-step rebase is not safely re-runnable: a blind retry after a partial failure would meet a rebase already in progress. On failure this path aborts and reports error with a recovery ref, so the next tick retries from a clean state.',
  "runGit(['rebase', '--abort']":
    'Best-effort cleanup on an already-failing transplant path: the result is ignored and the tick reports error regardless.',
  "runGit(['merge', '--abort']":
    'Cleanup after a merge that already ran through recoverIndexLockContention this tick, which reclaimed any orphaned lock.',
};

async function findUnwrappedIndexWriters(source: string): Promise<Array<{ line: number; text: string }>> {
  const { stripCommentsOnly, stripCommentsAndStrings } = await import(
    '../../../../../scripts/lib/strip-comments-and-strings.mjs'
  );
  const code: string = stripCommentsOnly(source, 'run-git-sync.ts');
  const bare: string = stripCommentsAndStrings(source, 'run-git-sync.ts');
  const wrapped: Array<[number, number]> = [];
  for (const m of bare.matchAll(/\brecoverIndexLockContention\(/g)) {
    const start = m.index ?? 0;
    let depth = 0;
    let end = start;
    for (let i = start + m[0].length - 1; i < bare.length; i++) {
      if (bare[i] === '(') depth++;
      else if (bare[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    wrapped.push([start, end]);
  }
  const out: Array<{ line: number; text: string }> = [];
  for (const m of code.matchAll(INDEX_WRITING_GIT_RE)) {
    const at = m.index ?? 0;
    if (wrapped.some(([s, e]) => at > s && at < e)) continue;
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const lineEnd = source.indexOf('\n', at);
    out.push({
      line: source.slice(0, at).split('\n').length,
      text: source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
    });
  }
  return out;
}

describe('WI-10004413 class guard: index-writing git calls in run-git-sync.ts reclaim orphaned index.lock', () => {
  it('CONTROL: flags an unwrapped index writer, and ignores wrapped and commented-out ones', async () => {
    const unwrapped = "async function f() {\n  const r = await runGit(['reset', '-q', 'HEAD', '--', ...p], repoPath);\n}\n";
    const wrapped =
      "async function f() {\n  const r = await recoverIndexLockContention(\n    await runGit(['reset', '-q', 'HEAD'], p),\n    () => runGit(['reset', '-q', 'HEAD'], p),\n    runGit, p, 'x', log,\n  );\n}\n";
    const commented = "// const r = await runGit(['reset', '-q', 'HEAD'], p);\nconst ok = 1;\n";
    expect(await findUnwrappedIndexWriters(unwrapped)).toEqual([
      { line: 2, text: "const r = await runGit(['reset', '-q', 'HEAD', '--', ...p], repoPath);" },
    ]);
    expect(await findUnwrappedIndexWriters(wrapped)).toEqual([]);
    expect(await findUnwrappedIndexWriters(commented)).toEqual([]);
  });

  it('every unwrapped index-writing runGit call in run-git-sync.ts is allowlisted with a reason, and every allowlist entry is still used', async () => {
    const source = readFileSync(new URL('./run-git-sync.ts', import.meta.url), 'utf8');
    // Non-vacuity: the file really wraps index writers, and the regex really matches unwrapped calls in it.
    expect((source.match(/\brecoverIndexLockContention\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
    const unwrapped = await findUnwrappedIndexWriters(source);
    expect(unwrapped.length).toBeGreaterThan(0);

    const keys = Object.keys(UNWRAPPED_INDEX_WRITER_ALLOWLIST);
    const violations = unwrapped.filter((u) => !keys.some((k) => u.text.includes(k)));
    expect(
      violations,
      'wrap these in recoverIndexLockContention (or allowlist them with a reason)',
    ).toEqual([]);
    const unused = keys.filter((k) => !unwrapped.some((u) => u.text.includes(k)));
    expect(unused, 'stale allowlist entries: remove them').toEqual([]);
  });
});
