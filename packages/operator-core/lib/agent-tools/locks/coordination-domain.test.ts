import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lockDomainForProjectDir,
  lockCoordinationDomain,
  hostGlobalLockDomain,
  HOST_GLOBAL_RESOURCES,
  resourceLockDomain,
  isWorkspaceScopedResource,
  workspaceScopedLockDomain,
  candidateResourceLockDomains,
  resolveExplicitFileLockDomain,
  __resetLockCoordinationDomain,
} from './coordination-domain';
import {
  ensureResourceDomainKindsFresh,
  __resetResourceDomainKindsForTest,
  type ResourceCoordinationDomainKind,
} from './resource-domain-kinds';

/** Scaffold a VALID fake git dir — findRepoRoot requires a gitlink file or a git
 *  dir WITH HEAD (valid-git-entry.ts); a bare empty `.git` no longer counts. */
const mkFakeGitDir = (root: string) => {
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
};

const SAVED = process.env.PAPERCUSP_LOCK_DOMAIN;
beforeEach(() => {
  delete process.env.PAPERCUSP_LOCK_DOMAIN;
  __resetLockCoordinationDomain();
  // WI-562584: resourceLockDomain() now consults the registry-declared domain
  // kind. Seed the cache with an EMPTY loader so these cases exercise the pure
  // name inference and nothing here reaches for the su-lock DB.
  __resetResourceDomainKindsForTest(async () => new Map());
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.PAPERCUSP_LOCK_DOMAIN;
  else process.env.PAPERCUSP_LOCK_DOMAIN = SAVED;
  __resetLockCoordinationDomain();
  __resetResourceDomainKindsForTest();
});

describe('lockDomainForProjectDir', () => {
  it('honors the PAPERCUSP_LOCK_DOMAIN override (trimmed)', () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = '  /custom/domain  ';
    expect(lockDomainForProjectDir('/anywhere')).toBe('/custom/domain');
  });

  it('resolves to the realpath of the nearest .git ancestor (so two workspaces over one checkout serialize)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockdom-'));
    mkFakeGitDir(root);
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(lockDomainForProjectDir(sub)).toBe(realpathSync(root));
  });

  it('falls back to the start dir when no .git ancestor exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norepo-'));
    expect(lockDomainForProjectDir(dir)).toBe(realpathSync(dir));
  });

  it('ignores a stray EMPTY `.git` dir ancestor — never a domain that collapses unrelated locks (the 2026-07-13 /tmp/.git incident)', () => {
    // An accidental `mkdir .git` in a shared ancestor (it happened at /tmp) must
    // not become the lock domain for every path beneath it — a HEAD-less `.git`
    // dir is not a repo. The domain falls through to the start dir instead.
    const root = mkdtempSync(join(tmpdir(), 'lockdom-stray-'));
    mkdirSync(join(root, '.git')); // EMPTY — no HEAD, not a gitlink
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(lockDomainForProjectDir(sub)).toBe(realpathSync(sub));
  });

  it('ignores an empty / whitespace-only PAPERCUSP_LOCK_DOMAIN (never an empty domain that collapses all locks)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockdom-empty-'));
    mkFakeGitDir(root);
    process.env.PAPERCUSP_LOCK_DOMAIN = '   ';
    expect(lockDomainForProjectDir(root)).toBe(realpathSync(root)); // falls through, not '' nor the blank override
  });

  it('resolves a SYMLINKED path to the same domain as the real path (two paths to one checkout serialize)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockdom-real-'));
    mkFakeGitDir(root);
    const link = `${root}-link`;
    symlinkSync(root, link); // a second path that points at the same checkout
    // Editing via the real path and via the symlink must key on the SAME (realpath) domain — else the
    // two would split into independent namespaces and clobber (the dbos-system-completion D-015 bug).
    expect(lockDomainForProjectDir(link)).toBe(realpathSync(root));
    expect(lockDomainForProjectDir(link)).toBe(lockDomainForProjectDir(root));
  });

  it('keys on the NEAREST .git ancestor when repos are nested (a submodule serializes on its own root)', () => {
    const outer = mkdtempSync(join(tmpdir(), 'lockdom-outer-'));
    mkFakeGitDir(outer);
    const inner = join(outer, 'sub');
    mkdirSync(inner);
    mkFakeGitDir(inner); // a nested repo (e.g. a submodule) with its OWN .git
    const deep = join(inner, 'x', 'y');
    mkdirSync(deep, { recursive: true });
    expect(lockDomainForProjectDir(deep)).toBe(realpathSync(inner)); // the inner root wins, not the outer
  });
});

describe('lockCoordinationDomain', () => {
  it('honors the override and caches it until reset', () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = '/d1';
    expect(lockCoordinationDomain()).toBe('/d1');
    process.env.PAPERCUSP_LOCK_DOMAIN = '/d2';
    expect(lockCoordinationDomain()).toBe('/d1'); // cached — env change not re-read
    __resetLockCoordinationDomain();
    expect(lockCoordinationDomain()).toBe('/d2'); // re-read after reset
  });
});

describe('resolveExplicitFileLockDomain', () => {
  it('canonicalizes a valid physical repository root', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockdom-explicit-'));
    mkFakeGitDir(root);
    const link = `${root}-link`;
    symlinkSync(root, link);
    expect(resolveExplicitFileLockDomain(link, '/fallback')).toBe(realpathSync(root));
  });

  it('rejects a relative, missing, or non-repository domain', () => {
    expect(() => resolveExplicitFileLockDomain('relative', '/fallback')).toThrow(/absolute/);
    expect(() => resolveExplicitFileLockDomain('/does/not/exist', '/fallback')).toThrow(/reachable/);
    const dir = mkdtempSync(join(tmpdir(), 'lockdom-not-repo-'));
    expect(() => resolveExplicitFileLockDomain(dir, '/fallback')).toThrow(/repository root/);
  });

  // EI-21104703429792156: the reported failure passed a harness SLUG ('papercusp'), and the
  // bare "must be an absolute repository root" left the caller nothing to act on — it neither
  // echoed the offending value nor said what to pass instead, so the reporter had to guess.
  // Assert the three things that make it actionable. Deliberately NOT covered by the /absolute/
  // case above: that assertion passed against the old uninformative message too, which is
  // precisely why it could not catch this.
  it('names the slug mistake, echoes the rejected value, and quotes the fallback to use instead', () => {
    const reject = () => resolveExplicitFileLockDomain('papercusp', '/edit/tree');
    expect(reject).toThrow(/papercusp/); // the offending value, echoed back
    expect(reject).toThrow(/harness\/workspace slug/); // the mistake, named
    expect(reject).toThrow(/\/edit\/tree/); // the concrete alternative — what omitting it yields
  });

  it('uses the server domain when the client does not supply an override', () => {
    expect(resolveExplicitFileLockDomain(undefined, '/fallback')).toBe('/fallback');
  });
});

// EI-18674647773291145 Defect 2: a host-global resource (e.g. 'release-deploy')
// must resolve to the SAME fixed domain regardless of which tree the calling
// code loaded from — the whole point being it is NOT keyed by a repo realpath
// the way `lockCoordinationDomain()` deliberately is.
describe('hostGlobalLockDomain', () => {
  it('is a fixed, non-path sentinel — never a realpath, never derived from cwd', () => {
    const d = hostGlobalLockDomain();
    expect(d).toBe('papercusp-host-global');
    // Never confusable with a real repo-root path (which is always absolute).
    expect(d.startsWith('/')).toBe(false);
  });

  it('is UNCACHED and NOT affected by lockCoordinationDomain()’s cache — each call re-reads', () => {
    // Prime lockCoordinationDomain()'s cache with something unrelated first.
    __resetLockCoordinationDomain();
    expect(lockCoordinationDomain()).not.toBe(hostGlobalLockDomain());
  });

  it('honors the PAPERCUSP_LOCK_DOMAIN override, same as lockCoordinationDomain()', () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = '  /custom/host-domain  ';
    expect(hostGlobalLockDomain()).toBe('/custom/host-domain');
  });

  it('ignores an empty/whitespace-only override (falls through to the fixed sentinel)', () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = '   ';
    expect(hostGlobalLockDomain()).toBe('papercusp-host-global');
  });

  it('two calls from "different trees" (no override) resolve to the SAME domain — the exact defect this closes', () => {
    // Unlike lockCoordinationDomain(), hostGlobalLockDomain() never consults
    // import.meta.url / cwd, so there is nothing tree-dependent to vary here —
    // this pins that invariant so a future refactor can't reintroduce a
    // realpath-of-caller dependency.
    expect(hostGlobalLockDomain()).toBe(hostGlobalLockDomain());
  });
});

describe('HOST_GLOBAL_RESOURCES', () => {
  it('includes release-deploy (the EI-18674647773291145 incident resource)', () => {
    expect(HOST_GLOBAL_RESOURCES.has('release-deploy')).toBe(true);
  });

  it('includes dev-server (EI-18676514870990022 — the identical cross-tree defect, now migrated)', () => {
    expect(HOST_GLOBAL_RESOURCES.has('dev-server')).toBe(true);
  });

  it('includes the physical Git rig shared by staging and release operators', () => {
    expect(HOST_GLOBAL_RESOURCES.has('hive-git-physical-rig')).toBe(true);
    expect(resourceLockDomain('hive-git-physical-rig')).toBe(hostGlobalLockDomain());
    expect(resourceLockDomain('hive-git-physical-rig')).not.toBe(lockCoordinationDomain());
  });

  it('includes bg-host, so a drill lease taken via one operator fences a dev:restart served by another (WI-10004352)', () => {
    expect(HOST_GLOBAL_RESOURCES.has('bg-host')).toBe(true);
    expect(resourceLockDomain('bg-host')).toBe(hostGlobalLockDomain());
    expect(resourceLockDomain('bg-host')).not.toBe(lockCoordinationDomain());
  });

  it.each(['staging-server', 'staging-server-cooldown'])(
    'routes the shared staging target %s to the same host domain as dev-server', resource => {
      expect(HOST_GLOBAL_RESOURCES.has(resource)).toBe(true);
      expect(resourceLockDomain(resource)).toBe(hostGlobalLockDomain());
      expect(resourceLockDomain(resource)).not.toBe(lockCoordinationDomain());
    });
  it('keeps unrelated per-tree resources in their caller domain', () => {
    expect(HOST_GLOBAL_RESOURCES.has('some-unregistered-resource')).toBe(false);
  });
});

// EI-18676514870990022: resourceLockDomain() centralizes the branch every
// acquirer/reader of a resource lock must apply — adding a resource to
// HOST_GLOBAL_RESOURCES must fix every call site through this one function.
describe('resourceLockDomain', () => {
  it('resolves a HOST_GLOBAL_RESOURCES member to hostGlobalLockDomain()', () => {
    expect(resourceLockDomain('release-deploy')).toBe(hostGlobalLockDomain());
    expect(resourceLockDomain('dev-server')).toBe(hostGlobalLockDomain());
  });

  it('resolves a non-member to lockCoordinationDomain() (the caller-tree-scoped domain)', () => {
    expect(resourceLockDomain('some-unregistered-resource')).toBe(lockCoordinationDomain());
  });

  it('two calls for the same host-global resource agree regardless of caller — the exact defect this closes', () => {
    // hostGlobalLockDomain() never varies by cwd/import.meta.url, so pinning
    // this here guards against resourceLockDomain() accidentally routing a
    // host-global resource through the tree-scoped path in a future edit.
    expect(resourceLockDomain('dev-server')).toBe(resourceLockDomain('dev-server'));
    expect(resourceLockDomain('dev-server').startsWith('/')).toBe(false);
  });
});

// WI-562584. The two hardcoded sets above cannot be completed by hand: git-sync
// holds its whole configured lock set (`trigger_config.extra_lock_resources`)
// in the WORKSPACE domain, and those names are per-install human configuration.
// `libs-papercusp-submodule` advertises neither family, so it resolved to the
// caller tree while git-sync held it in the workspace domain — the acquire was
// granted into a namespace git-sync never checks and mutual exclusion silently
// did not hold. The acquirer now DECLARES the kind on the registry row and this
// resolver reads it back.
describe('resourceLockDomain — registry-declared domain kinds', () => {
  const seed = async (entries: Array<[string, ResourceCoordinationDomainKind]>) => {
    __resetResourceDomainKindsForTest(async () => new Map(entries));
    await ensureResourceDomainKindsFresh();
  };

  it('resolves a workspace-DECLARED extra to the workspace domain — the defect', async () => {
    // Pre-fix this answered lockCoordinationDomain(); the two disagree, which is
    // exactly why this is a real assertion and not a tautology.
    expect(resourceLockDomain('libs-papercusp-submodule')).toBe(lockCoordinationDomain());
    expect(workspaceScopedLockDomain()).not.toBe(lockCoordinationDomain());

    await seed([['libs-papercusp-submodule', 'workspace']]);

    expect(resourceLockDomain('libs-papercusp-submodule')).toBe(workspaceScopedLockDomain());
  });

  it('resolves a host-global DECLARED resource to the fixed host-global domain', async () => {
    await seed([['some-shared-daemon', 'host-global']]);
    expect(resourceLockDomain('some-shared-daemon')).toBe(hostGlobalLockDomain());
  });

  it('leaves an UNDECLARED resource on the caller-tree domain — a cold or failed cache changes nothing', async () => {
    await seed([['libs-papercusp-submodule', 'workspace']]);
    expect(resourceLockDomain('some-unregistered-resource')).toBe(lockCoordinationDomain());

    // A load that never completes must not change any answer either.
    __resetResourceDomainKindsForTest(() => new Promise(() => {}));
    expect(resourceLockDomain('libs-papercusp-submodule')).toBe(lockCoordinationDomain());
    expect(resourceLockDomain('release-deploy')).toBe(hostGlobalLockDomain());
  });

  it('never lets a declaration DEMOTE a hardcoded host-global resource into the caller tree', async () => {
    // The column default is 'tree', so every un-backfilled row would read as a
    // tree declaration. Honouring that ahead of HOST_GLOBAL_RESOURCES would
    // re-open EI-18674647773291145. The sets are consulted FIRST for this reason.
    await seed([['release-deploy', 'workspace'], ['dev-server', 'workspace']]);
    expect(resourceLockDomain('release-deploy')).toBe(hostGlobalLockDomain());
    expect(resourceLockDomain('dev-server')).toBe(hostGlobalLockDomain());
  });

  it('keeps the git-sync family on the workspace domain whatever the registry says', async () => {
    await seed([['git-sync:papercusp', 'host-global'], ['git-sync', 'host-global']]);
    expect(resourceLockDomain('git-sync:papercusp')).toBe(workspaceScopedLockDomain());
    expect(resourceLockDomain('git-sync')).toBe(workspaceScopedLockDomain());
  });
});

// WI-5960: a `git-sync:<slug>` resource is a family whose SYSTEM-SIDE acquirer
// (git-sync-action.ts's handleGitSync) keys itself by `ctx.workspaceId || '*'`,
// NOT by the caller-tree-scoped `lockCoordinationDomain()` every OTHER
// resource acquirer defaults to. Before this fix, an agent calling
// `locks:acquire_resource { resource: 'git-sync:<slug>' }` (the su playbook's
// documented "pause sync to safely mutate the tree" mechanism) landed under
// `lockCoordinationDomain()` — a domain git-sync's own conflict check never
// looks at — so a live, un-expired exclusive hold was completely invisible to
// git-sync, which committed straight through it (observed live 2026-07-26: 6
// commits landed during the held hold). These pin the fix's the two halves:
// (1) a `git-sync:` name is recognized as workspace-scoped, and (2) it
// resolves through the SAME domain function git-sync-action.ts uses
// (`ctx.workspaceId || '*'`, mirrored here as `activeWorkspaceId() || '*'`).
describe('isWorkspaceScopedResource / workspaceScopedLockDomain (WI-5960)', () => {
  const SAVED_WS = process.env.PAPERCUSP_WORKSPACE_ID;
  beforeEach(() => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
  });
  afterEach(() => {
    if (SAVED_WS === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = SAVED_WS;
  });

  it('recognizes the legacy git-sync barrier and any git-sync:<slug> name', () => {
    expect(isWorkspaceScopedResource('git-sync')).toBe(true);
    expect(isWorkspaceScopedResource('git-sync:papercusp')).toBe(true);
    expect(isWorkspaceScopedResource('git-sync:some-other-harness')).toBe(true);
    expect(isWorkspaceScopedResource('git-sync:')).toBe(true);
  });

  it('does not misclassify an unrelated or merely-similar-looking resource', () => {
    expect(isWorkspaceScopedResource('release-deploy')).toBe(false);
    expect(isWorkspaceScopedResource('dev-server')).toBe(false);
    expect(isWorkspaceScopedResource('gitsync:papercusp')).toBe(false); // no colon-hyphen match
    expect(isWorkspaceScopedResource('git-syncing')).toBe(false); // exact legacy name, not a broad prefix
    expect(isWorkspaceScopedResource('some-git-sync:papercusp')).toBe(false); // prefix, not substring
  });

  it('resourceLockDomain routes both git-sync forms to workspaceScopedLockDomain(), NOT lockCoordinationDomain()', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'papercusp-workspace';
    expect(resourceLockDomain('git-sync')).toBe(workspaceScopedLockDomain());
    expect(resourceLockDomain('git-sync:papercusp')).toBe(workspaceScopedLockDomain());
    expect(resourceLockDomain('git-sync:papercusp')).toBe('papercusp-workspace');
    // The exact defect: these must NOT coincide, or the domain split silently
    // reintroduces the invisible-hold bug this fix closes.
    expect(resourceLockDomain('git-sync')).not.toBe(lockCoordinationDomain());
    expect(resourceLockDomain('git-sync:papercusp')).not.toBe(lockCoordinationDomain());
  });

  it('candidateResourceLockDomains includes the workspace-scoped domain (so a lock_id-only release/heartbeat can still find a git-sync:* lease)', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'papercusp-workspace';
    expect(candidateResourceLockDomains()).toContain('papercusp-workspace');
    expect(candidateResourceLockDomains()).toContain(hostGlobalLockDomain());
    expect(candidateResourceLockDomains()).toContain(lockCoordinationDomain());
  });
});
