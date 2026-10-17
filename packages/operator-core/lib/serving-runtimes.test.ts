/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-001/P-006 — per-runtime containment.
 *
 * The defect this guards: "is my change live" was answered for ONE runtime (:3070) and
 * read as an answer for all of them. Each case below pins one runtime's own rule, and
 * the three-valued contract (null-with-a-reason is never collapsed into false).
 */
import { describe, expect, it } from 'vitest';
import {
  CURRENT_BUILD_TEST_CLASSES,
  currentBuildRoutesForRuntime,
  currentBuildTestRoute,
  SERVING_RUNTIME_IDS,
  describeServingRuntimes,
  evaluateServingRuntime,
  parseHealthBundleState,
  pickVintageForUnit,
  probeServingRuntime,
  resolveServingRuntimeAlias,
  runtimesForHost,
  selectServingRuntimes,
  servingRuntimesLead,
  servingRuntimesMentioned,
  type ServingRuntimeEntry,
  type ServingRuntimeProbe,
} from './serving-runtimes';
import type { RuntimeVintageRow } from './runtime-vintage';
import { shapePipelinePosition, PIPELINE_POSITION_RESPONSE_BUDGET_CHARS } from './agent-tools/dev/pipeline_position';
import type { PipelinePosition } from './git-pipeline-position';

const probe = (over: Partial<ServingRuntimeProbe> & Pick<ServingRuntimeProbe, 'runtime'>): ServingRuntimeProbe => ({
  role: 'owner',
  pid: 100,
  startedAtMs: 2_000,
  buildSha: 'a'.repeat(40),
  buildShaSource: 'runtime-vintage',
  blobContains: null,
  blobUnknown: null,
  fileMtimeMs: 1_000,
  instances: null,
  ...over,
});

const vintage = (over: Partial<RuntimeVintageRow>): RuntimeVintageRow => ({
  workspaceId: 'ws',
  unit: 'hono-host:3271',
  host: 'box',
  treeSha: 'b'.repeat(40),
  buildTime: null,
  bundleVersion: '0.0.0',
  pid: 7,
  extra: {},
  reportedAt: new Date(10_000).toISOString(),
  ...over,
});

describe('runtime selection', () => {
  it('selects a concrete test class without promoting a background gap into staging readiness', () => {
    expect(currentBuildTestRoute('operator-api')).toMatchObject({
      runtime: 'staging-operator',
      readiness: 'ready',
    });
    // Maintained sync resolves the committed local integration branch, which may
    // differ from origin/staging; the route must describe that source accurately.
    expect(currentBuildTestRoute('operator-api')?.source).toMatch(/committed local/i);
    expect(currentBuildTestRoute('operator-api')?.source).not.toContain('origin/staging');
    expect(currentBuildRoutesForRuntime('bg-host')).toMatchObject([
      { id: 'background-federation', readiness: 'requires-prerequisites' },
    ]);
    expect(currentBuildRoutesForRuntime('desktop-shell').map(({ id }) => id))
      .toEqual(['migration', 'desktop-native', 'candidate-install-upgrade']);
    expect(currentBuildTestRoute('candidate-install-upgrade')).toMatchObject({
      routeFile: 'papercusp-desktop/bin/candidate-install-upgrade-rollback.sh',
      readiness: 'requires-prerequisites',
      verification: expect.stringContaining('SHA-256'),
    });
    expect(currentBuildRoutesForRuntime('release-operator')).toEqual([]);
    expect(currentBuildTestRoute('unrecognized')).toBeNull();
  });

  it('keeps pre-release route gaps explicit instead of claiming :3170 covers every class', () => {
    expect(CURRENT_BUILD_TEST_CLASSES.map(({ id }) => id)).toEqual([
      'unit-integration', 'operator-api', 'background-federation', 'migration',
      'desktop-native', 'multi-machine-p2p-git', 'aws-ami-candidate', 'candidate-install-upgrade', 'final-release',
    ]);
    expect(CURRENT_BUILD_TEST_CLASSES.filter(({ readiness }) => readiness === 'gap').map(({ id }) => id))
      .toEqual([]);
    expect(CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'final-release')?.readiness).toBe('release-only');
  });

  it('maps every ownership host to at least one runtime, and the operator to BOTH checkouts', () => {
    expect(runtimesForHost('operator-release')).toEqual(['release-operator', 'staging-operator']);
    expect(runtimesForHost('bg-host')).toEqual(['bg-host']);
    expect(runtimesForHost('gateway')).toEqual(['gateway']);
    expect(runtimesForHost('embed-sidecar')).toEqual(['embed-sidecar']);
    expect(runtimesForHost('psu-pty-host')).toEqual(['psu-pty-host']);
    expect(runtimesForHost('tauri-desktop')).toEqual(['desktop-shell']);
  });

  it('owners come first; shared library code adds the canonical-tree hosts as `shared`', () => {
    const sel = selectServingRuntimes('packages/operator-core/lib/harness/routines/x.ts', [{ host: 'bg-host' }]);
    expect(sel[0]).toEqual({ runtime: 'bg-host', role: 'owner' });
    expect(sel.filter((s) => s.role === 'shared').map((s) => s.runtime)).toEqual([
      'release-operator',
      'staging-operator',
      'gateway',
    ]);
  });

  it('a non-library path lists only its owners, and a sha-only probe lists nothing', () => {
    expect(selectServingRuntimes('apps/operator/scripts/psu-pty-host.mjs', [{ host: 'psu-pty-host' }])).toEqual([
      { runtime: 'psu-pty-host', role: 'owner' },
    ]);
    expect(selectServingRuntimes(null, null)).toEqual([]);
  });
});

describe('evaluateServingRuntime — each runtime answers from ITS OWN build identity', () => {
  it('checkout hosts: blob containment at their own sha is the whole answer', () => {
    const release = evaluateServingRuntime(probe({ runtime: 'release-operator', blobContains: false, buildShaSource: 'health' }));
    expect(release).toMatchObject({ containsChange: false, method: 'blob', unknownReason: null });
    const staging = evaluateServingRuntime(probe({ runtime: 'staging-operator', blobContains: true }));
    expect(staging).toMatchObject({ containsChange: true, method: 'blob' });
  });

  it('a checkout host with no build sha is UNKNOWN with a reason, never false', () => {
    const e = evaluateServingRuntime(probe({ runtime: 'release-operator', buildSha: null, buildShaSource: null }));
    expect(e.containsChange).toBeNull();
    expect(e.unknownReason?.code).toBe('insufficient-data');
  });

  it('an unresolvable blob read stays null and carries the resolver reason', () => {
    const e = evaluateServingRuntime(
      probe({ runtime: 'staging-operator', blobContains: null, blobUnknown: { code: 'resolver-failed', detail: 'x' } }),
    );
    expect(e.containsChange).toBeNull();
    expect(e.unknownReason).toEqual({ code: 'resolver-failed', detail: 'x' });
  });

  it('direct-source gateway: a matching blob at its boot HEAD is sufficient', () => {
    expect(evaluateServingRuntime(probe({ runtime: 'gateway', buildShaSource: 'runtime-vintage', blobContains: true, startedAtMs: 1, fileMtimeMs: 9 })))
      .toMatchObject({ containsChange: true, method: 'blob' });
  });

  it('direct-source gateway: started after the file changed ⇒ it loaded the edit (even one uncommitted at boot)', () => {
    expect(evaluateServingRuntime(probe({ runtime: 'gateway', blobContains: false, startedAtMs: 5, fileMtimeMs: 4 })))
      .toMatchObject({ containsChange: true, method: 'start-after-mtime' });
  });

  it('canonical-tree host: started before the file changed and the blob differs ⇒ false', () => {
    expect(evaluateServingRuntime(probe({ runtime: 'gateway', blobContains: false, startedAtMs: 3, fileMtimeMs: 4 })))
      .toMatchObject({ containsChange: false, method: 'start-after-mtime' });
  });

  describe('WI-10005936: a host that booted a last-known-good bundle after its rebuild failed', () => {
    // The measured shape: bg-host restarted at 09:04:45Z onto a bundle built at 07:39Z;
    // the edit landed at 08:57Z. start-after-mtime called that a pass.
    const BUILT = 7_39;
    const EDIT = 8_57;
    const START = 9_04;

    it('judges by the bundle build time, not the start time ⇒ false', () => {
      const e = evaluateServingRuntime(
        probe({
          runtime: 'bg-host',
          buildShaSource: 'health',
          blobContains: false,
          startedAtMs: START,
          fileMtimeMs: EDIT,
          bundle: { stale: true, servingBuiltAtMs: BUILT },
        }),
      );
      expect(e).toMatchObject({ containsChange: false, method: 'bundle-mtime', unknownReason: null });
    });

    it('a stale bundle built after the edit does carry it', () => {
      const e = evaluateServingRuntime(
        probe({ runtime: 'bg-host', blobContains: false, startedAtMs: START, fileMtimeMs: 7_00, bundle: { stale: true, servingBuiltAtMs: BUILT } }),
      );
      expect(e).toMatchObject({ containsChange: true, method: 'bundle-mtime' });
    });

    it('a matching blob at the boot HEAD (runtime-vintage) is NOT accepted: that HEAD postdates the bundle', () => {
      const e = evaluateServingRuntime(
        probe({
          runtime: 'bg-host',
          buildShaSource: 'runtime-vintage',
          blobContains: true,
          startedAtMs: START,
          fileMtimeMs: EDIT,
          bundle: { stale: true, servingBuiltAtMs: BUILT },
        }),
      );
      expect(e).toMatchObject({ containsChange: false, method: 'bundle-mtime' });
    });

    it('a matching blob at the health sha (baked into the bundle) is accepted', () => {
      const e = evaluateServingRuntime(
        probe({ runtime: 'bg-host', buildShaSource: 'health', blobContains: true, fileMtimeMs: EDIT, bundle: { stale: true, servingBuiltAtMs: BUILT } }),
      );
      expect(e).toMatchObject({ containsChange: true, method: 'blob' });
    });

    it('no baked-sha match and no bundle build time ⇒ unknown, never a start-time guess', () => {
      const e = evaluateServingRuntime(
        probe({ runtime: 'bg-host', blobContains: false, startedAtMs: START, fileMtimeMs: EDIT, bundle: { stale: true, servingBuiltAtMs: null } }),
      );
      expect(e.containsChange).toBeNull();
      expect(e.unknownReason?.code).toBe('insufficient-data');
    });

    it('a healthy bundle without an exact identity does not guess from start-after-mtime', () => {
      const e = evaluateServingRuntime(
        probe({ runtime: 'bg-host', blobContains: false, startedAtMs: START, fileMtimeMs: EDIT, bundle: { stale: false, servingBuiltAtMs: null } }),
      );
      expect(e.containsChange).toBeNull();
      expect(e.method).toBeNull();
      expect(e.unknownReason).toEqual({
        code: 'insufficient-data',
        detail: 'bg-host (routines, sweeps, watchdogs; canonical tree) reported a healthy bundle but no health-reported baked source sha or bundle build time; a runtime-vintage boot sha and process start cannot prove which bytes it loaded.',
      });
    });

    it('does not accept a matching runtime-vintage SHA as identity for a healthy bundle', () => {
      const e = evaluateServingRuntime(
        probe({
          runtime: 'bg-host',
          buildShaSource: 'runtime-vintage',
          blobContains: true,
          startedAtMs: START,
          fileMtimeMs: EDIT,
          bundle: { stale: false, servingBuiltAtMs: null },
        }),
      );
      expect(e).toMatchObject({ containsChange: null, method: null, unknownReason: { code: 'insufficient-data' } });
      expect(e.unknownReason?.detail).toMatch(/runtime-vintage boot sha and process start cannot prove/);
    });

    it.each([
      ['contains the source change', true, true],
      ['does not contain the source change even when the process started later', false, false],
    ])('uses the healthy bundle health SHA when it %s', (_label, blobContains, expected) => {
      const e = evaluateServingRuntime(
        probe({
          runtime: 'bg-host',
          buildShaSource: 'health',
          blobContains,
          startedAtMs: START,
          fileMtimeMs: EDIT,
          bundle: { stale: false, servingBuiltAtMs: null },
        }),
      );
      expect(e).toMatchObject({ containsChange: expected, method: 'blob', unknownReason: null });
    });

    it('a bundled canonical-tree host with no health bundle identity is unknown', () => {
      const e = evaluateServingRuntime(
        probe({ runtime: 'bg-host', blobContains: false, startedAtMs: START, fileMtimeMs: EDIT, bundle: null }),
      );
      expect(e.containsChange).toBeNull();
      expect(e.method).toBeNull();
      expect(e.unknownReason?.code).toBe('resolver-failed');
    });

    it('parses the bundleStale field of /api/health', () => {
      expect(parseHealthBundleState({ ok: true, sha: 'x' })).toEqual({ stale: false, servingBuiltAtMs: null });
      expect(
        parseHealthBundleState({ ok: true, bundleStale: { outfile: 'dist-host/hono-host.mjs', servingBundleMtime: '2026-10-03T07:39:41Z' } }),
      ).toEqual({ stale: true, servingBuiltAtMs: Date.parse('2026-10-03T07:39:41Z') });
      expect(parseHealthBundleState({ bundleStale: { outfile: '(unreadable marker)', servingBundleMtime: null } })).toEqual({
        stale: true,
        servingBuiltAtMs: null,
      });
      expect(parseHealthBundleState(null)).toBeNull();
    });

    it('probes bg-host health on :3271 and only canonical-tree hosts read the bundle state', async () => {
      const bundlePorts: number[] = [];
      const deps = {
        probeUnitStart: async () => ({ pid: 7, startedAtMs: START }),
        probeHealthSha: async (port: number) => (port === 3271 ? 'c'.repeat(40) : 'h'.repeat(40)),
        probeHealthBundle: async (port: number) => {
          bundlePorts.push(port);
          return { stale: true, servingBuiltAtMs: BUILT };
        },
        vintageRows: [],
        localHost: 'box',
        fileMtimeMs: EDIT,
        blobContainsAt: async () => ({ contains: false, unknown: null }),
      };
      const bg = await probeServingRuntime({ runtime: 'bg-host', role: 'owner' }, deps);
      expect(bg).toMatchObject({ buildSha: 'c'.repeat(40), buildShaSource: 'health', bundle: { stale: true, servingBuiltAtMs: BUILT } });
      await probeServingRuntime({ runtime: 'release-operator', role: 'owner' }, deps);
      expect(bundlePorts).toEqual([3271]);
      expect(evaluateServingRuntime(bg)).toMatchObject({ containsChange: false, method: 'bundle-mtime' });
    });

    // WI-10005944: the embed sidecar is built by the same bundle-host.sh (same fallback),
    // so it must read its own /healthz on :3384, not fall back to start-after-mtime.
    it('probes the embed sidecar on :3384/healthz and judges a stale fallback bundle by its mtime', async () => {
      const calls: string[] = [];
      const deps = {
        probeUnitStart: async () => ({ pid: 8, startedAtMs: START }),
        probeHealthSha: async (port: number, path?: string) => {
          calls.push(`sha ${port}${path}`);
          return 'e'.repeat(40);
        },
        probeHealthBundle: async (port: number, path?: string) => {
          calls.push(`bundle ${port}${path}`);
          return { stale: true, servingBuiltAtMs: BUILT };
        },
        vintageRows: [],
        localHost: 'box',
        fileMtimeMs: EDIT,
        // The fallback bundle's baked sha predates the edit.
        blobContainsAt: async () => ({ contains: false, unknown: null }),
      };
      const embed = await probeServingRuntime({ runtime: 'embed-sidecar', role: 'owner' }, deps);
      expect(calls).toEqual(['sha 3384/healthz', 'bundle 3384/healthz']);
      expect(embed).toMatchObject({ buildSha: 'e'.repeat(40), buildShaSource: 'health', bundle: { stale: true } });
      // Started after the edit, but the bundle it booted was built before it: not live.
      expect(evaluateServingRuntime(embed)).toMatchObject({ containsChange: false, method: 'bundle-mtime' });

      calls.length = 0;
      await probeServingRuntime({ runtime: 'bg-host', role: 'owner' }, deps);
      expect(calls).toEqual(['sha 3271/api/health', 'bundle 3271/api/health']);
    });
  });

  it('canonical-tree host with no runtime identity is unknown, not assumed stopped', () => {
    const e = evaluateServingRuntime(
      probe({ runtime: 'embed-sidecar', pid: null, startedAtMs: null, buildSha: null, buildShaSource: null }),
    );
    expect(e.containsChange).toBeNull();
    expect(e.unknownReason?.code).toBe('insufficient-data');
    expect(e.unknownReason?.detail).toMatch(/running state is unknown/);
    expect(e.unknownReason?.detail).not.toMatch(/is not running/);
  });

  it('psu pty hosts answer with instance counts', () => {
    const e = evaluateServingRuntime(
      probe({ runtime: 'psu-pty-host', buildSha: null, instances: { total: 5, current: 2 } }),
    );
    expect(e).toMatchObject({ containsChange: true, method: 'instances', instances: { total: 5, current: 2 } });
    expect(
      evaluateServingRuntime(probe({ runtime: 'psu-pty-host', buildSha: null, instances: { total: 5, current: 0 } }))
        .containsChange,
    ).toBe(false);
    expect(
      evaluateServingRuntime(probe({ runtime: 'psu-pty-host', buildSha: null, instances: { total: 0, current: 0 } }))
        .containsChange,
    ).toBeNull();
    expect(
      evaluateServingRuntime(probe({ runtime: 'psu-pty-host', buildSha: null, instances: null })).unknownReason?.code,
    ).toBe('resolver-failed');
  });

  it('the desktop shell is not-applicable, never false', () => {
    const e = evaluateServingRuntime(probe({ runtime: 'desktop-shell', buildSha: null }));
    expect(e.containsChange).toBeNull();
    expect(e.unknownReason?.code).toBe('not-applicable');
  });
});

describe('servingRuntimesLead', () => {
  const entry = (over: Partial<ServingRuntimeEntry> & Pick<ServingRuntimeEntry, 'runtime'>): ServingRuntimeEntry => ({
    ...evaluateServingRuntime(probe({ runtime: over.runtime, blobContains: true })),
    ...over,
  });

  it('non-release owners all running the change ⇒ leads with LIVE NOW and "does NOT wait on main"', () => {
    const lead = servingRuntimesLead([entry({ runtime: 'bg-host', buildSha: '635c4bd49f00' })]);
    expect(lead).toMatch(/^LIVE NOW on bg-host build 635c4bd49f/);
    expect(lead).toMatch(/does NOT wait on main/);
  });

  it('staging runs it, :3070 does not ⇒ names the split instead of a gate wait', () => {
    const lead = servingRuntimesLead([
      entry({ runtime: 'release-operator', releasePipelineApplies: true, containsChange: false }),
      entry({ runtime: 'staging-operator', containsChange: true }),
    ]);
    expect(lead).toMatch(/LIVE NOW on staging-operator/);
    expect(lead).toMatch(/release-operator does not run it yet/);
  });

  it('says nothing when no non-release owner runs the change, or when only a SHARED host does', () => {
    expect(servingRuntimesLead([entry({ runtime: 'bg-host', containsChange: false })])).toBeNull();
    expect(servingRuntimesLead([entry({ runtime: 'bg-host', role: 'shared' })])).toBeNull();
    expect(servingRuntimesLead([])).toBeNull();
    expect(servingRuntimesLead(undefined)).toBeNull();
  });

  it('describeServingRuntimes renders one clause per runtime with the unknown reason', () => {
    const text = describeServingRuntimes([
      entry({ runtime: 'bg-host' }),
      evaluateServingRuntime(probe({ runtime: 'desktop-shell', buildSha: null })),
    ]);
    expect(text).toMatch(/bg-host build a{10} \[owner\]: runs it/);
    expect(text).toMatch(/desktop-shell \[owner\]: unknown \(/);
  });
});

describe('aliases', () => {
  it('resolves ids and aliases, and finds runtime mentions in prose', () => {
    expect(resolveServingRuntimeAlias(':3070')).toBe('release-operator');
    expect(resolveServingRuntimeAlias('bg-host')).toBe('bg-host');
    expect(resolveServingRuntimeAlias('nonsense')).toBeNull();
    expect(servingRuntimesMentioned('measured on bg-host (and :3170)')).toEqual(['staging-operator', 'bg-host']);
    // a bare number is a count, not a runtime
    expect(servingRuntimesMentioned('3070 rows ingested')).toEqual([]);
    expect(SERVING_RUNTIME_IDS).toHaveLength(7);
  });
});

describe('probes', () => {
  it('joins a unit whose MainPID is a wrapper to its child reporter by cgroup, and ignores a previous generation', async () => {
    const rows = [
      vintage({ pid: 55, reportedAt: new Date(1_000).toISOString(), treeSha: 'old'.padEnd(40, '0') }),
      vintage({ pid: 56, reportedAt: new Date(10_000).toISOString(), treeSha: 'c'.repeat(40) }),
    ];
    const row = await pickVintageForUnit({
      unit: 'papercusp-bg-host.service',
      mainPid: 50,
      startedAtMs: 9_000,
      rows,
      localHost: 'box',
      vintageUnit: null,
      readCgroup: async (pid) => (pid === 56 || pid === 55 ? '0::/user.slice/papercusp-bg-host.service' : null),
    });
    expect(row?.pid).toBe(56);
  });

  it('prefers the health sha, falls back to runtime-vintage, and measures blob containment at that sha', async () => {
    const seen: string[] = [];
    const deps = {
      probeUnitStart: async () => ({ pid: 7, startedAtMs: 9_000 }),
      vintageRows: [vintage({ pid: 7 })],
      localHost: 'box',
      readCgroup: async () => null,
      fileMtimeMs: 1_000,
      // bg-host has a health port (:3271); stub it so this test never reaches a live host.
      probeHealthSha: async () => null,
      probeHealthBundle: async () => null,
      blobContainsAt: async (sha: string) => {
        seen.push(sha);
        return { contains: sha.startsWith('h'), unknown: null };
      },
    };
    const release = await probeServingRuntime(
      { runtime: 'release-operator', role: 'owner' },
      { ...deps, probeHealthSha: async () => 'h'.repeat(40) },
    );
    expect(release).toMatchObject({ buildShaSource: 'health', blobContains: true });
    const bg = await probeServingRuntime({ runtime: 'bg-host', role: 'owner' }, deps);
    expect(bg).toMatchObject({ buildSha: 'b'.repeat(40), buildShaSource: 'runtime-vintage', blobContains: false });
    expect(seen).toEqual(['h'.repeat(40), 'b'.repeat(40)]);
  });

  it('counts psu sessions launched after the file changed', async () => {
    const p = await probeServingRuntime(
      { runtime: 'psu-pty-host', role: 'owner' },
      {
        probeUnitStart: async () => null,
        vintageRows: [],
        localHost: 'box',
        fileMtimeMs: 5_000,
        blobContainsAt: async () => ({ contains: null, unknown: null }),
        listPtyHostInstances: async () => [
          { pid: 1, startedAtMs: 4_000 },
          { pid: 2, startedAtMs: 6_000 },
        ],
      },
    );
    expect(p.instances).toEqual({ total: 2, current: 1 });
  });
});

describe('dev:pipeline_position keeps servingRuntimes at every projection tier', () => {
  it('survives the budgeted projection of an oversized payload', () => {
    const servingRuntimes = [
      evaluateServingRuntime(probe({ runtime: 'bg-host', blobContains: true })),
      evaluateServingRuntime(probe({ runtime: 'release-operator', blobContains: false })),
    ];
    const big = {
      input: { path: 'a.ts', sha: null },
      summary: 'x',
      servingRuntimes,
      notes: Array.from({ length: 400 }, (_, i) => `note ${i} ${'y'.repeat(200)}`),
    } as unknown as PipelinePosition;
    const shaped = shapePipelinePosition(big) as Record<string, unknown>;
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(PIPELINE_POSITION_RESPONSE_BUDGET_CHARS + 2_000);
    expect(shaped.servingRuntimes).toEqual([
      expect.objectContaining({ runtime: 'bg-host', containsChange: true }),
      expect.objectContaining({ runtime: 'release-operator', containsChange: false }),
    ]);
  });
});
