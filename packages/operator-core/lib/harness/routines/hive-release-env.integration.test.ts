/**
 * hive-release-env — per-hive release-gate resolution (per-hive-git-and-release-gate P-006).
 *
 * resolveHiveReleaseGate runs against the REAL built-in blueprints (coding/work); the
 * registry + operator-home slug are mocked for resolveHiveReleaseEnv. No PG, no network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Generous timeout: resolveHiveReleaseGate cold-starts the built-in blueprint resolver
// (reads + resolves the blueprint tree from disk, ~5s on first call), which tips past the
// 5s default under heavy PARALLEL load (the full-suite green-checkpoint run) → a spurious
// timeout. Roomy budget kills that load-flake class (the "generous timeouts on import-heavy
// tests" convention from the green-checkpoint bring-up).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let registryProjects: Array<{ slug: string; path: string; self_repo?: boolean }>;
let homeSlug: string;
let tmpDirs: string[];

/** Env keys the DSN-routing tests below drive (EI-20709645463022690). Saved + restored
 *  wholesale so a test that plants an ambient operator DSN can never leak it into a
 *  sibling test — or into the rest of the worker's suite. */
const DSN_ENV_KEYS = [
  'HARNESS_ADMIN_DATABASE_URL',
  'DATABASE_URL',
  'PAPERCUSP_PG_URL',
  'PAPERCUSP_SKIP_PG_DISCOVERY',
  'PAPERCUSP_DEPENDENCY_GENERATION_ROOT',
] as const;
let savedDsnEnv: Record<string, string | undefined>;

/** Plant an ambient operator DSN exactly as the gate subprocess inherits one, with the
 *  namespaced + discovery sources cleared so `getHarnessAdminUrl()` resolves to THIS value
 *  (embedded-pg-discovery: env vars are consulted before the discovery file / native
 *  fallback). That makes the "re-homed to HARNESS_ADMIN_DATABASE_URL" assertion a real
 *  provenance check rather than an echo of a value the test also supplied under that name. */
const AMBIENT_OPERATOR_DSN = 'postgres://operator:pw@127.0.0.1:5432/papercusp_operator_test';
function plantAmbientOperatorDsn(): void {
  delete process.env.HARNESS_ADMIN_DATABASE_URL;
  delete process.env.PAPERCUSP_PG_URL;
  process.env.DATABASE_URL = AMBIENT_OPERATOR_DSN;
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
}

function makeHiveDir(extendsId: string, opts: { git?: boolean; extraKnobs?: string } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'hre-'));
  tmpDirs.push(d);
  mkdirSync(join(d, '.papercusp'), { recursive: true });
  const knobs = opts.extraKnobs ? `\nknobs:\n${opts.extraKnobs}` : '';
  writeFileSync(join(d, '.papercusp', 'blueprint.yaml'), `id: t\nextends: ${extendsId}${knobs}\n`);
  if (opts.git) mkdirSync(join(d, '.git'), { recursive: true });
  return d;
}

// The FIRST import of ./hive-release-env transforms its whole import graph — measured at
// 26s of vite transform under fleet load (2026-10-13, WI-6554700010009501), which alone
// nearly fills the 30s per-test budget and timed the first case out twice. vi.resetModules()
// below clears evaluated modules, not the transform cache, so paying that cold cost once
// here, under its own explicit budget, keeps it out of every test's measured budget.
beforeAll(async () => {
  await import('./hive-release-env');
}, 180_000);

beforeEach(() => {
  vi.resetModules();
  registryProjects = [];
  homeSlug = 'papercusp';
  tmpDirs = [];
  savedDsnEnv = Object.fromEntries(DSN_ENV_KEYS.map((k) => [k, process.env[k]]));
  // Keep the real registry exports available to transitive imports (notably the
  // p2p revocation-reaper). A full mock here makes unrelated newly-added exports
  // fail module linking before any release-env assertion can run.
  vi.doMock('../../harness-registry', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    loadHarnessRegistry: async () => ({ projects: registryProjects }),
  }));
  vi.doMock('../operator-home-harness', () => ({
    operatorHomeHarnessSlug: () => homeSlug,
  }));
  // Default: no per-hive greenCmd override (deterministic + DB-free). A specific test
  // re-mocks this to assert the P-014 override precedence.
  vi.doMock('../../hive-settings-store', () => ({
    getReleaseGreenCmdOverride: async () => null,
  }));
});
afterEach(() => {
  for (const k of DSN_ENV_KEYS) {
    if (savedDsnEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedDsnEnv[k] as string;
  }
  vi.doUnmock('../../harness-registry');
  vi.doUnmock('../operator-home-harness');
  vi.doUnmock('../../hive-settings-store');
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('resolveHiveReleaseGate', () => {
  it('coding → enabled with staging/main defaults', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(makeHiveDir('coding'));
    expect(gate?.enabled).toBe(true);
    expect(gate?.integrationBranch).toBe('staging');
    expect(gate?.releaseRef).toBe('main');
  });

  it('work (non-coding) → gate disabled', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    expect(resolveHiveReleaseGate(makeHiveDir('work'))?.enabled).toBe(false);
  });

  it('no blueprint file → null', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const empty = mkdtempSync(join(tmpdir(), 'hre-empty-'));
    tmpDirs.push(empty);
    expect(resolveHiveReleaseGate(empty)).toBeNull();
  });

  it('surfaces the testCommand knob for greenCmd defaulting', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(makeHiveDir('coding', { extraKnobs: '  testCommand: npm run test:ci' }));
    expect(gate?.testCommand).toBe('npm run test:ci');
    expect(gate?.greenCmd).toBeNull(); // explicit greenCmd unset → caller falls back to testCommand
  });

  it('disables the operator SPA build for non-frontend generated repos', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(makeHiveDir('coding', {
      extraKnobs: '  fromRepo:\n    frontend: false',
    }));
    expect(gate?.spaBuildWorkspace).toBe('');
  });

  it('a coding MEMBER blueprint (coding-factory — no explicit releaseGate) gates by default (P-017 derived)', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    // coding-factory carries no releaseGate knob but IS a code repo (requiresRepo, repo-commit
    // output) — the derived rule enables it; the member is what create_from_repo clones run.
    expect(resolveHiveReleaseGate(makeHiveDir('coding-factory'))?.enabled).toBe(true);
  });

  it('WI-5164: no explicit integrationBranch knob (coding-factory, what create_from_repo actually ' +
    'extends) → falls back to the passed registryDefaultBranch, not a hardcoded staging', async () => {
    // NOTE: the top-level `coding` blueprint (used above) bakes `releaseGate.integrationBranch:
    // staging` in EXPLICITLY — its fallback branch of the ternary is never reached. The real
    // create_from_repo path extends `coding-factory` (detectionToOverride), which carries no
    // releaseGate knob at all — that's the blueprint this fix actually matters for.
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(makeHiveDir('coding-factory'), 'master');
    expect(gate?.integrationBranch).toBe('master');
  });

  it('WI-5164: an EXPLICIT blueprint integrationBranch knob still wins over registryDefaultBranch', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(
      makeHiveDir('coding-factory', { extraKnobs: '  releaseGate:\n    integrationBranch: custom-branch' }),
      'master',
    );
    expect(gate?.integrationBranch).toBe('custom-branch');
  });

  it('WI-5164: no registryDefaultBranch passed → keeps the old staging fallback (back-compat)', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(makeHiveDir('coding-factory'));
    expect(gate?.integrationBranch).toBe('staging');
  });

  it('WI-10006301: a working copy judges the branch git-sync integrates on, never its release ref', async () => {
    // A create_from_repo pot of a `main`-default repo: without the working-copy branch the
    // gate judged main against release ref main — permanently up-to-date, never promoted.
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const direct = resolveHiveReleaseGate(makeHiveDir('coding-factory'), 'main');
    expect(direct?.integrationBranch).toBe(direct?.releaseRef); // the trap, as configured for a direct pot
    const copy = resolveHiveReleaseGate(makeHiveDir('coding-factory'), 'main', 'staging');
    expect(copy?.integrationBranch).toBe('staging');
    expect(copy?.integrationBranch).not.toBe(copy?.releaseRef);
  });

  it('WI-10006301: the working-copy branch wins over an explicit blueprint knob (git-sync commits there regardless)', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(
      makeHiveDir('coding-factory', { extraKnobs: '  releaseGate:\n    integrationBranch: main' }),
      'main',
      'staging',
    );
    expect(gate?.integrationBranch).toBe('staging');
  });

});

describe('resolveHiveReleaseEnv', () => {
  it('not_found when the slug is not in the registry', async () => {
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('ghost', 'default');
    expect(res.enabled).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('gate_disabled for a non-coding (work) hive', async () => {
    const dir = makeHiveDir('work', { git: true });
    registryProjects = [{ slug: 'workhive', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('workhive', 'default');
    expect(res.enabled).toBe(false);
    expect(res.reason).toBe('gate_disabled');
  });

  it('no_repo only when the checkout has no .git (a metadata-only home)', async () => {
    const noGit = makeHiveDir('coding', { git: false });
    registryProjects = [{ slug: 'c1', path: noGit, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    expect((await resolveHiveReleaseEnv('c1', 'default')).reason).toBe('no_repo');
  });

  it('a code MEMBER (has .git, self_repo NOT set) IS gated — P-017 code-in-member', async () => {
    const withGit = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'c2', path: withGit, self_repo: false }]; // a member, not a self_repo home
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('c2', 'default');
    expect(res.enabled).toBe(true);
    expect(res.env.PAPERCUSP_INTEGRATION_ROOT).toBe(withGit);
  });

  it('operator-home slug → enabled with an EMPTY overlay (exact current behavior preserved)', async () => {
    const dir = makeHiveDir('coding', { git: true });
    homeSlug = 'papercusp';
    registryProjects = [{ slug: 'papercusp', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('papercusp', 'default');
    expect(res.enabled).toBe(true);
    expect(res.isOperatorHome).toBe(true);
    expect(res.env).toEqual({}); // no overlay → systemd-unit env + releaseConfig defaults
  });

  it('a regular coding hive → namespaced per-hive env overlay (build fallback greenCmd)', async () => {
    const dir = makeHiveDir('coding', { git: true });
    homeSlug = 'papercusp'; // dir slug differs → not the home
    registryProjects = [{ slug: 'oddsmith-hive', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv, DEFAULT_GREEN_CMD } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('oddsmith-hive', 'default');
    expect(res.enabled).toBe(true);
    expect(res.isOperatorHome).toBe(false);
    expect(res.env.PAPERCUSP_INTEGRATION_ROOT).toBe(dir);
    expect(res.env.PAPERCUSP_RELEASE_SLUG).toBe('oddsmith-hive');
    expect(res.env.PAPERCUSP_INTEGRATION_BRANCH).toBe('staging');
    expect(res.env.PAPERCUSP_RELEASE_REF).toBe('main');
    expect(res.env.PAPERCUSP_RELEASE_ROOT).toBe(join(dirname(dir), 'oddsmith-hive-release'));
    expect(res.env.PAPERCUSP_CHECKPOINT_ROOT).toBe(join(dirname(dir), 'oddsmith-hive-checkpoint'));
    expect(res.env.PAPERCUSP_GREEN_CMD).toBe(DEFAULT_GREEN_CMD); // coding greenCmd null + no testCommand
  });

  it('WI-2828: a subject hive with NO explicit frontend/spaBuildWorkspace knob still gets an ' +
    'explicit SKIP — never silently inherits @papercusp/operator-vite via omission', async () => {
    // The exact quartermaster-shaped trap: a plain coding hive that declares neither
    // `fromRepo.frontend: false` NOR an explicit `releaseGate.spaBuildWorkspace`. Before the
    // durable fix, PAPERCUSP_SPA_BUILD_WORKSPACE was left UNSET here, and release-config.ts's
    // own fallback silently assumed '@papercusp/operator-vite' — red-pinning any hive whose
    // tree doesn't carry that workspace. The opt-in-only default must set it to '' explicitly.
    const dir = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'quartermaster-shaped', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('quartermaster-shaped', 'default');
    expect(res.env.PAPERCUSP_SPA_BUILD_WORKSPACE).toBe('');
  });

  it('WI-2833 (landed): a hive that explicitly opts in via releaseGate.spaBuildWorkspace gets ' +
    "its own SPA workspace built — the blueprint knobs zod schema now carries the field " +
    "through instead of silently stripping it (was WI-2828's opt-in-default fix; this is the " +
    'separate opt-in-PATH fix for a hive that actually carries its own operator SPA)', async () => {
    const dir = makeHiveDir('coding', { extraKnobs: '  releaseGate:\n    spaBuildWorkspace: "@my-org/my-spa"', git: true });
    registryProjects = [{ slug: 'has-own-spa', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('has-own-spa', 'default');
    expect(res.env.PAPERCUSP_SPA_BUILD_WORKSPACE).toBe('@my-org/my-spa');
  });

  it('greenCmd defaults to the testCommand knob when set (the gate runs the SAME test command)', async () => {
    const dir = makeHiveDir('coding', { git: true, extraKnobs: '  testCommand: npm run test:affected' });
    registryProjects = [{ slug: 'mycode', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('mycode', 'default');
    expect(res.env.PAPERCUSP_GREEN_CMD).toBe('npm run test:affected');
    expect(res.greenCmdOverridden).toBe(false);
  });

  it('threads an empty SPA workspace override for non-frontend repos so the gate skips operator-vite', async () => {
    const dir = makeHiveDir('coding', {
      git: true,
      extraKnobs: '  testCommand: npm test\n  fromRepo:\n    frontend: false',
    });
    registryProjects = [{ slug: 'oddsmith-hive', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('oddsmith-hive', 'default');
    expect(res.env.PAPERCUSP_GREEN_CMD).toBe('npm test');
    expect(res.env.PAPERCUSP_SPA_BUILD_WORKSPACE).toBe('');
  });

  it('WI-5164: a from-repo pot on a master-default repo seeds PAPERCUSP_INTEGRATION_BRANCH=master, not staging', async () => {
    // The exact bug: /api/harness/pots/from-repo records github_default_branch from the
    // clone's actual default branch (e.g. GitHub's octocat/Hello-World → 'master'). The
    // blueprint carries no explicit releaseGate.integrationBranch knob, so before this fix
    // the green-checkpoint routine hardcoded 'staging' and rev-parsed a branch the clone
    // never has — exiting 1 on EVERY tick, forever.
    const dir = makeHiveDir('coding-factory', { git: true });
    registryProjects = [
      { slug: 'hello-world-3', path: dir, self_repo: false, github_default_branch: 'master' } as {
        slug: string;
        path: string;
        self_repo?: boolean;
        github_default_branch?: string;
      },
    ];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('hello-world-3', 'default');
    expect(res.enabled).toBe(true);
    expect(res.env.PAPERCUSP_INTEGRATION_BRANCH).toBe('master');
  });

  it('WI-10006317: a main-default from-repo pot (integration == release) stays seeded but routes to an explicit misconfigured skip', async () => {
    // Observed on the P-023 pilot: github_default_branch 'main' resolved integrationBranch
    // 'main' == releaseRef 'main', so every fire read 'up-to-date' and nothing was ever tested.
    const mainDir = makeHiveDir('coding-factory', { git: true });
    const masterDir = makeHiveDir('coding-factory', { git: true });
    const projects: Array<{ slug: string; path: string; self_repo?: boolean; github_default_branch?: string }> = [
      { slug: 'main-default', path: mainDir, self_repo: false, github_default_branch: 'main' },
      { slug: 'master-default', path: masterDir, self_repo: false, github_default_branch: 'master' },
    ];
    registryProjects = projects;
    const { resolveHiveReleaseEnv, resolveCheckpointRouting } = await import('./hive-release-env');

    const res = await resolveHiveReleaseEnv('main-default', 'default');
    expect(res.enabled).toBe(true); // still seeded — the fault must stay visible
    expect(res.misconfiguration?.code).toBe('integration-equals-release');
    const routing = await resolveCheckpointRouting({ installSlug: 'main-default', workspaceId: 'default' }, '/DEFAULT');
    expect(routing.skip?.misconfigured).toBe(true);
    expect(routing.skip?.reason).toMatch(/^integration-equals-release: integration branch 'main'/);

    // Control: a pot whose integration branch differs from its release ref is unaffected.
    const control = await resolveHiveReleaseEnv('master-default', 'default');
    expect(control.misconfiguration).toBeUndefined();
    const controlRouting = await resolveCheckpointRouting({ installSlug: 'master-default', workspaceId: 'default' }, '/DEFAULT');
    expect(controlRouting.skip).toBeUndefined();
  });

  it('WI-10006317: gateMisconfiguration flags exactly integration == release', async () => {
    const { gateMisconfiguration } = await import('./hive-release-env');
    expect(gateMisconfiguration({ integrationBranch: 'main', releaseRef: 'main' })?.code).toBe('integration-equals-release');
    expect(gateMisconfiguration({ integrationBranch: 'staging', releaseRef: 'main' })).toBeNull();
    expect(gateMisconfiguration({ integrationBranch: 'main', releaseRef: 'release' })).toBeNull();
  });

  it('WI-5164: a self_repo hive with no github_default_branch recorded still defaults to staging', async () => {
    const dir = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'fresh-init-hive', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('fresh-init-hive', 'default');
    expect(res.env.PAPERCUSP_INTEGRATION_BRANCH).toBe('staging');
  });

  it('a per-hive owner override beats the knob/testCommand/build and sets greenCmdOverridden (P-014)', async () => {
    const dir = makeHiveDir('coding', { git: true, extraKnobs: '  testCommand: npm run test:affected' });
    registryProjects = [{ slug: 'mycode', path: dir, self_repo: true }];
    // The /admin/git edit stores a per-hive override in hive_settings → it wins.
    vi.doMock('../../hive-settings-store', () => ({
      getReleaseGreenCmdOverride: async (_ws: string, slug: string) =>
        slug === 'mycode' ? 'npm run gate:custom' : null,
    }));
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('mycode', 'default');
    expect(res.env.PAPERCUSP_GREEN_CMD).toBe('npm run gate:custom');
    expect(res.greenCmd).toBe('npm run gate:custom');
    expect(res.greenCmdOverridden).toBe(true);
  });
});

/**
 * EI-20709645463022690 — the gate subprocess inherited the OPERATOR's DATABASE_URL, so a
 * SUBJECT pot's suite silently dialed papercusp's database instead of its own (observed as a
 * "schema drift — 39 tables" red on sidestage that nobody could reproduce in the pot's tree).
 *
 * The fix is deliberately TWO-SIDED and both sides are load-bearing, so both are pinned here:
 *   - CLEAR the ambient DATABASE_URL/PG* → the pot's own hermetic default wins;
 *   - SET HARNESS_ADMIN_DATABASE_URL → the gate's OWN bookkeeping (green-checkpoint.ts
 *     dynamically imports gate-verdict-target / coordination / db-boot-migrate) still reaches
 *     papercusp's database. Clearing alone would have fixed the pot by BREAKING verdict
 *     recording for every pot gate — a test that asserted only the deletion would have called
 *     that regression green.
 */
describe('resolveHiveReleaseEnv — subject-hive DSN routing (EI-20709645463022690)', () => {
  it('a gated non-home hive: re-homes the operator DSN to HARNESS_ADMIN_DATABASE_URL and CLEARS the ambient one', async () => {
    plantAmbientOperatorDsn();
    const dir = makeHiveDir('coding', { git: true });
    homeSlug = 'papercusp';
    registryProjects = [{ slug: 'sidestage', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('sidestage', 'default');

    expect(res.enabled).toBe(true);
    expect(res.isOperatorHome).toBe(false);
    // (a) papercusp's DSN survives, on its OWN channel — the one embedded-pg-discovery ranks
    // ABOVE DATABASE_URL, so the gate's own bookkeeping still finds it after the clear.
    expect(res.env.HARNESS_ADMIN_DATABASE_URL).toBe(AMBIENT_OPERATOR_DSN);
    // (b) …and the ambient channel the POT reads is scheduled for deletion.
    expect(res.clearEnv).toContain('DATABASE_URL');
    for (const k of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE']) {
      expect(res.clearEnv).toContain(k);
    }
    // The overlay must not ALSO re-set the bare DATABASE_URL — the overlay is applied after
    // the deletions, so an entry here would silently undo the whole fix.
    expect(res.env.DATABASE_URL).toBeUndefined();
  });

  it('operator-home → clearEnv EMPTY: papercusp keeps the DSN its own PG-backed gate legs need (D-007)', async () => {
    plantAmbientOperatorDsn();
    const dir = makeHiveDir('coding', { git: true });
    homeSlug = 'papercusp';
    registryProjects = [{ slug: 'papercusp', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('papercusp', 'default');

    expect(res.isOperatorHome).toBe(true);
    expect(res.clearEnv).toEqual([]);
    expect(res.env).toEqual({});
  });

  it('every disabled branch returns clearEnv [] — a skipped hive never mutates a subprocess env', async () => {
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const notFound = await resolveHiveReleaseEnv('ghost', 'default');

    const workDir = makeHiveDir('work', { git: true });
    registryProjects = [{ slug: 'workhive', path: workDir, self_repo: true }];
    const gateDisabled = await resolveHiveReleaseEnv('workhive', 'default');

    const noGitDir = makeHiveDir('coding', { git: false });
    registryProjects = [{ slug: 'c1', path: noGitDir, self_repo: true }];
    const noRepo = await resolveHiveReleaseEnv('c1', 'default');

    expect([notFound.reason, gateDisabled.reason, noRepo.reason]).toEqual([
      'not_found',
      'gate_disabled',
      'no_repo',
    ]);
    for (const res of [notFound, gateDisabled, noRepo]) expect(res.clearEnv).toEqual([]);
  });
});

describe('resolveCheckpointRouting', () => {
  it('keeps a foreign hive on its recorded store for scheduled and manual launchers', async () => {
    const dir = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'subject', path: dir, self_repo: true }];
    writeFileSync(join(dir, '.papercusp', 'dependency-generation-root'), '/target/gens\n/former/gens\n');
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const { resolveDependencyGenerationRoot, resolveDependencyGenerationRetentionRoots } =
      await import('../../release/dependency-generation-prebuild');
    for (const ambient of ['/operator/gens', undefined]) {
      if (ambient) process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = ambient;
      else delete process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT;
      const routing = await resolveCheckpointRouting({ installSlug: 'subject', workspaceId: 'default' }, '/TOOLING');
      const childEnv = { ...process.env, ...routing.extraEnv };
      expect(routing.extraEnv.PAPERCUSP_DEPENDENCY_GENERATION_ROOT).toBe('/target/gens');
      expect(resolveDependencyGenerationRoot(dir, childEnv)).toBe('/target/gens');
      expect(resolveDependencyGenerationRetentionRoots(dir, childEnv)).toEqual(['/target/gens', '/former/gens']);
    }
  });

  it('retains the inherited store fallback when a foreign record is absent or invalid', async () => {
    const dir = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'subject', path: dir, self_repo: true }];
    process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = '/operator/gens';
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const { resolveDependencyGenerationRoot } = await import('../../release/dependency-generation-prebuild');
    for (const record of [undefined, 'relative/store\n/old/gens\n']) {
      if (record) writeFileSync(join(dir, '.papercusp', 'dependency-generation-root'), record);
      const routing = await resolveCheckpointRouting({ installSlug: 'subject', workspaceId: 'default' }, '/TOOLING');
      expect(routing.extraEnv.PAPERCUSP_DEPENDENCY_GENERATION_ROOT).toBeUndefined();
      expect(resolveDependencyGenerationRoot(dir, { ...process.env, ...routing.extraEnv })).toBe('/operator/gens');
    }
  });

  it('leaves operator-home store selection to its existing environment', async () => {
    const dir = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'papercusp', path: dir, self_repo: true }];
    writeFileSync(join(dir, '.papercusp', 'dependency-generation-root'), '/recorded/gens\n');
    process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = '/operator/gens';
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const { resolveDependencyGenerationRoot } = await import('../../release/dependency-generation-prebuild');
    const routing = await resolveCheckpointRouting({ installSlug: 'papercusp', workspaceId: 'default' }, dir);
    expect(routing.extraEnv).toEqual({});
    expect(resolveDependencyGenerationRoot(dir, process.env)).toBe('/operator/gens');
  });

  it('no installSlug → default root, empty overlay, no skip (current behavior)', async () => {
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ workspaceId: 'default' }, '/DEFAULT');
    expect(r.root).toBe('/DEFAULT');
    expect(r.extraEnv).toEqual({});
    expect(r.skip).toBeUndefined();
  });

  it('operator-home slug → default root + empty overlay (exact current behavior preserved)', async () => {
    homeSlug = 'papercusp';
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ installSlug: 'papercusp', workspaceId: 'default' }, '/DEFAULT');
    expect(r.root).toBe('/DEFAULT');
    expect(r.extraEnv).toEqual({});
    expect(r.skip).toBeUndefined();
    // WI-10006274: the home keeps the fork-derived memory cap, so it carries no foreign greenCmd.
    expect(r.greenCmd ?? null).toBeNull();
  });

  it('keeps caller tooling but binds every home launcher to the registered canonical subject', async () => {
    homeSlug = 'papercusp';
    registryProjects = [{ slug: homeSlug, path: '/canonical/papercusp', self_repo: true }];
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    for (const installSlug of [undefined, homeSlug]) {
      for (const toolingRoot of ['/operator/release', '/operator/staging']) {
        const r = await resolveCheckpointRouting({ installSlug, workspaceId: 'default' }, toolingRoot);
        expect(r.root).toBe(toolingRoot);
        expect(r.extraEnv.PAPERCUSP_INTEGRATION_ROOT).toBe('/canonical/papercusp');
        expect(r.clearEnv).toEqual([]);
        expect(r.skip).toBeUndefined();
      }
    }
    const canonical = await resolveCheckpointRouting(
      { installSlug: homeSlug, workspaceId: 'default' },
      '/canonical/papercusp',
    );
    expect(canonical.extraEnv).toEqual({});
  });

  it('gated coding hive → TOOLING root (not the hive) + the hive in extraEnv (P-019)', async () => {
    const dir = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'oddsmith-hive', path: dir, self_repo: true }];
    const { resolveCheckpointRouting, DEFAULT_GREEN_CMD } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ installSlug: 'oddsmith-hive', workspaceId: 'default' }, '/DEFAULT');
    // root stays the TOOLING root — green-checkpoint.ts + the setup script live there, not in
    // the hive's repo. The hive is the SUBJECT, carried in extraEnv.
    expect(r.root).toBe('/DEFAULT');
    expect(r.extraEnv.PAPERCUSP_INTEGRATION_ROOT).toBe(dir);
    expect(r.skip).toBeUndefined();
    // WI-10006274: the memory admission sizes this pot's request from its own gate command,
    // so the routing must carry it (a coding hive with no testCommand runs the build fallback).
    expect(r.greenCmd).toBe(DEFAULT_GREEN_CMD);
  });

  it('EI-20709645463022690: a gated hive threads clearEnv + the namespaced DSN through to the caller', async () => {
    plantAmbientOperatorDsn();
    const dir = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'sidestage', path: dir, self_repo: true }];
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ installSlug: 'sidestage', workspaceId: 'default' }, '/DEFAULT');
    // release-actions' runScript reads exactly these two fields; a routing that resolved the
    // hive correctly but dropped clearEnv on the floor would leave the bug fully intact.
    expect(r.clearEnv).toContain('DATABASE_URL');
    expect(r.extraEnv.HARNESS_ADMIN_DATABASE_URL).toBe(AMBIENT_OPERATOR_DSN);
  });

  it('EI-20709645463022690: no-slug, operator-home and skipped routings all carry clearEnv []', async () => {
    plantAmbientOperatorDsn();
    homeSlug = 'papercusp';
    const workDir = makeHiveDir('work', { git: true });
    registryProjects = [{ slug: 'workhive', path: workDir, self_repo: true }];
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const noSlug = await resolveCheckpointRouting({ workspaceId: 'default' }, '/DEFAULT');
    const home = await resolveCheckpointRouting({ installSlug: 'papercusp', workspaceId: 'default' }, '/DEFAULT');
    const skipped = await resolveCheckpointRouting({ installSlug: 'workhive', workspaceId: 'default' }, '/DEFAULT');
    expect(skipped.skip?.reason).toBe('gate_disabled');
    for (const r of [noSlug, home, skipped]) expect(r.clearEnv).toEqual([]);
  });

  it('non-gated slug (work hive) → skip with reason, default root, no suite', async () => {
    const dir = makeHiveDir('work', { git: true });
    registryProjects = [{ slug: 'workhive', path: dir, self_repo: true }];
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ installSlug: 'workhive', workspaceId: 'default' }, '/DEFAULT');
    expect(r.skip?.reason).toBe('gate_disabled');
    expect(r.root).toBe('/DEFAULT');
    expect(r.extraEnv).toEqual({});
  });
});
