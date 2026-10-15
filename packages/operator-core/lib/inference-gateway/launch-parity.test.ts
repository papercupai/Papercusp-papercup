/**
 * P-012 LAUNCH-MATRIX PARITY — the executable form of spec `capless-p012-deployment-parity@1`.
 *
 * SPEC BEHAVIOR: "Equivalent gateway inputs produce equivalent admission decisions across
 * development, sidecar, systemd, packaged, container, and platform launch paths."
 *
 * SPEC FALSIFIER: "One launch path reinstalls a legacy concurrency, queue, provider, or
 * per-account cap that another path does not."
 * SPEC PROBE METHOD: "Boot each supported launch path with the same compatibility inputs and
 * compare the canonical state readback."
 *
 * This file implements that probe literally: it BOOTS a real gateway once per launch path with
 * that path's own environment, reads the canonical `/stats` capacity surface, and asserts every
 * path reports the SAME numbers. The interesting row is `systemd+legacy-reinstated`, which sets
 * the retired ceiling variables to a deliberately tiny value: if any launch path still honoured
 * them, that row's readback would diverge from the others and this test fails. That is the exact
 * observation the spec names as its falsifier, so a green here is evidence and not decoration.
 *
 * WHY THIS LAYER: the sibling unit tests prove each PIECE (the readback detects a retired var,
 * the census row is anchored). None of them boots two launch paths and compares them, which is
 * the only way to observe a per-path divergence. See plan decision D-014 for why the packaged and
 * container cells are asserted structurally rather than booted: they spawn no gateway at all.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startGatewayService, type RunningGatewayService } from './launch';

/** The retired ceilings. Spelled out so the falsifier below can name what must stay inert.
 *  Both are asserted to have ZERO live `process.env` reads by retired-capacity-env.test.ts;
 *  this file proves the complementary property — that SETTING them changes no decision. */
const RETIRED_CLAUDE_CEILING = 'PAPERCUSP_GATEWAY_CONCURRENCY';
const RETIRED_CODEX_CEILING = 'PAPERCUSP_GATEWAY_CODEX_CONCURRENCY';

/** Deliberately tiny: if ANY launch path still honoured these, admission would clamp to 1 and the
 *  cross-path comparison would diverge loudly instead of drifting subtly. */
const REINSTATEMENT_ATTEMPT = '1';

let upstream: http.Server | undefined;
let svc: RunningGatewayService | undefined;

afterEach(async () => {
  await svc?.stop();
  svc = undefined;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
});

async function startUpstream(): Promise<string> {
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(upstream!.address() as { port: number }).port}`;
}

/** The capacity surface a divergence would show up in. These are exactly the four things the
 *  spec's falsifier enumerates — concurrency, queue, provider, per-account — read from the
 *  canonical `/stats` endpoint rather than from internals, so the comparison is over the same
 *  surface an operator or dashboard would consult. */
interface CanonicalCapacityReadback {
  maxQueued: number;
  concurrencyCap: number;
  aimdCap: number;
  aimdFloor: number;
  admissionMaxConcurrent: number;
  codexAimdCap: number | null;
  codexAimdFloor: number | null;
  clampApplied: number | null;
  /**
   * THE PER-CLASS CAPS — and the reason this list is not shorter.
   *
   * A first draft of this test compared only the scalars above and a mutation probe proved it
   * TOOTHLESS: making a launch path honour the retired PAPERCUSP_GATEWAY_CONCURRENCY moved the
   * per-tier caps (8,6,6,3,2 -> 1,1,1,1,1) and tier1Reserve (2 -> 1) while leaving
   * maxConcurrent, concurrencyCap and aimd untouched, so the mutant SURVIVED. The launch seed
   * sizes the priority-tier layer specifically; a comparison that omits it cannot observe a
   * launch path reinstating a per-class ceiling, which is precisely the spec's falsifier.
   * Do not trim these fields back to "the interesting ones" — they ARE the interesting ones.
   */
  admissionTierCaps: string;
  admissionTier1Reserve: number | null;
  codexTierCaps: string;
  codexTier1Reserve: number | null;
}

/** One row of the launch matrix: a supported way the gateway gets started, and the environment
 *  that path supplies to it. Every bootable path passes NO admission seed, because that is what
 *  the production sidecar does after P-010 (sidecar-main.ts:147-163 passes no `concurrency`). */
interface LaunchPath {
  readonly name: string;
  readonly env: NodeJS.ProcessEnv;
  /** True when this row is attempting to reinstate a retired ceiling. */
  readonly attemptsReinstatement: boolean;
}

/** The environment the systemd unit actually sets (apps/operator/scripts/systemd/
 *  papercup-inference-gateway.service). Copied from the unit, not invented. */
const SYSTEMD_UNIT_ENV: NodeJS.ProcessEnv = {
  PATH: '/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin',
  PAPERCUSP_INTEGRATION_ROOT: '/tmp/papercusp-parity-fixture',
  PAPERCUSP_GATEWAY_PORT: '8788',
  PAPERCUSP_GATEWAY_REQUEST_ABSORB_MS: '120000',
  HARNESS_ADMIN_DATABASE_URL: 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp',
};

const LAUNCH_MATRIX: readonly LaunchPath[] = [
  // A bare development invocation: no deployment environment at all.
  { name: 'development', env: {}, attemptsReinstatement: false },
  // The production sidecar (bin.ts -> runGatewaySidecarMain -> startGatewayService).
  {
    name: 'sidecar',
    env: { PAPERCUSP_GATEWAY_PORT: '8788', PAPERCUSP_WORKSPACE: 'parity-fixture' },
    attemptsReinstatement: false,
  },
  // The systemd unit's own environment block.
  { name: 'systemd', env: { ...SYSTEMD_UNIT_ENV }, attemptsReinstatement: false },
  // THE FALSIFIER ARM: the systemd path with both retired ceilings set to 1. A path that still
  // honoured either variable would clamp admission and diverge from every row above.
  {
    name: 'systemd+legacy-reinstated',
    env: {
      ...SYSTEMD_UNIT_ENV,
      [RETIRED_CLAUDE_CEILING]: REINSTATEMENT_ATTEMPT,
      [RETIRED_CODEX_CEILING]: REINSTATEMENT_ATTEMPT,
    },
    attemptsReinstatement: true,
  },
];

async function bootAndRead(
  path: LaunchPath,
  upstreamBase: string,
): Promise<{ readback: CanonicalCapacityReadback; warnings: string[] }> {
  const warnings: string[] = [];
  svc = await startGatewayService({
    port: 0,
    upstreamBase,
    // Every bootable launch path passes NO admission seed (P-010). Passing one here would
    // manufacture the parity this test exists to detect the absence of.
    env: path.env,
    log: (level, message) => {
      if (level === 'warn' || level === 'error') warnings.push(message);
    },
    resolveAccount: async () => ({
      accountId: 'parity-acct',
      credentialRef: 'token:/dev/null',
      source: 'env' as const,
    }),
    makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'parity-token', invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
    localBackendReloadIntervalMs: 0,
  });

  interface AdmissionSnapshot {
    maxConcurrent?: number;
    tier1Reserve?: number;
    byTier?: { tier: number; minShare: number }[];
  }
  const stats = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    maxQueued: number;
    concurrencyCap: number;
    aimd: { cap: number; floor: number };
    admission?: AdmissionSnapshot;
    codexAdmission?: AdmissionSnapshot;
    codexAimd?: { cap: number; floor: number };
    clamp?: { applied: number | null };
  };

  /** Render the tier ladder as a stable string so a deepEqual diff names the exact tier. */
  const tierCaps = (a: AdmissionSnapshot | undefined): string =>
    (a?.byTier ?? []).map((t) => `t${t.tier}=${t.minShare}`).join(',');

  const readback: CanonicalCapacityReadback = {
    maxQueued: stats.maxQueued,
    concurrencyCap: stats.concurrencyCap,
    aimdCap: stats.aimd.cap,
    aimdFloor: stats.aimd.floor,
    admissionMaxConcurrent: stats.admission?.maxConcurrent ?? -1,
    codexAimdCap: stats.codexAimd?.cap ?? null,
    codexAimdFloor: stats.codexAimd?.floor ?? null,
    clampApplied: stats.clamp?.applied ?? null,
    admissionTierCaps: tierCaps(stats.admission),
    admissionTier1Reserve: stats.admission?.tier1Reserve ?? null,
    codexTierCaps: tierCaps(stats.codexAdmission),
    codexTier1Reserve: stats.codexAdmission?.tier1Reserve ?? null,
  };

  await svc.stop();
  svc = undefined;
  return { readback, warnings };
}

test('every bootable launch path reports an IDENTICAL canonical capacity readback (spec falsifier arm)', async () => {
  const upstreamBase = await startUpstream();

  const observed: { name: string; readback: CanonicalCapacityReadback }[] = [];
  for (const path of LAUNCH_MATRIX) {
    const { readback } = await bootAndRead(path, upstreamBase);
    observed.push({ name: path.name, readback });
  }

  const [baseline, ...rest] = observed;
  assert.ok(baseline, 'the launch matrix must contain at least one bootable path');

  for (const row of rest) {
    assert.deepEqual(
      row.readback,
      baseline.readback,
      `launch path '${row.name}' diverged from '${baseline.name}'. ` +
        'That is the spec falsifier for capless-p012-deployment-parity: one launch path ' +
        'reinstalled a legacy concurrency, queue, provider, or per-account cap that another ' +
        `path did not. baseline=${JSON.stringify(baseline.readback)} ` +
        `observed=${JSON.stringify(row.readback)}`,
    );
  }

  // CALIBRATION: a comparison of four identical all-zero objects would also pass while proving
  // nothing. Assert the readback actually carries a live admission window, so the equality above
  // is over real values rather than over a uniformly empty surface.
  assert.ok(
    baseline.readback.aimdFloor > 0,
    `the canonical readback must expose a real admission floor for the parity comparison to mean ` +
      `anything; got ${JSON.stringify(baseline.readback)}`,
  );
  // The tier ladder is the field a mutation probe proved this test was previously blind to. If it
  // ever comes back empty, the deepEqual above silently stops covering per-class caps again —
  // identical empty strings compare equal just fine. Fail loudly instead.
  assert.ok(
    baseline.readback.admissionTierCaps.includes('t1='),
    `the canonical readback must expose the per-tier cap ladder; an empty ladder makes the parity ` +
      `comparison blind to exactly the per-class reinstatement this test exists to catch. ` +
      `got ${JSON.stringify(baseline.readback)}`,
  );
});

test('setting a retired ceiling changes NO admission decision but DOES raise a loud warning', async () => {
  const upstreamBase = await startUpstream();

  const clean = await bootAndRead(
    LAUNCH_MATRIX.find((p) => p.name === 'systemd')!,
    upstreamBase,
  );
  const reinstated = await bootAndRead(
    LAUNCH_MATRIX.find((p) => p.name === 'systemd+legacy-reinstated')!,
    upstreamBase,
  );

  // The decision surface is untouched...
  assert.deepEqual(
    reinstated.readback,
    clean.readback,
    'a retired ceiling must not move any admission number',
  );

  // ...but the operator is NOT left believing the variable did something. This is the
  // "environment readback" half of the spec's requiredEvidence: silence here was the actual
  // pre-P-012 defect — an operator setting the variable got no signal at all and reasonably
  // concluded it had capped the gateway.
  const mentionsClaudeCeiling = reinstated.warnings.some((w) => w.includes(RETIRED_CLAUDE_CEILING));
  const mentionsCodexCeiling = reinstated.warnings.some((w) => w.includes(RETIRED_CODEX_CEILING));
  assert.ok(
    mentionsClaudeCeiling,
    `expected a warning naming ${RETIRED_CLAUDE_CEILING}; got ${JSON.stringify(reinstated.warnings)}`,
  );
  assert.ok(
    mentionsCodexCeiling,
    `expected a warning naming ${RETIRED_CODEX_CEILING}; got ${JSON.stringify(reinstated.warnings)}`,
  );

  // NEGATIVE CONTROL: the same assertion must FAIL to hold on the clean path, or the warning
  // check above would pass for a build that simply warns unconditionally.
  assert.ok(
    !clean.warnings.some((w) => w.includes(RETIRED_CLAUDE_CEILING)),
    `the clean systemd path must NOT warn about ${RETIRED_CLAUDE_CEILING}; ` +
      `an unconditional warning would make the positive assertion vacuous. got ${JSON.stringify(clean.warnings)}`,
  );
});

/**
 * The RECURRENCE GUARD for plan decision D-014.
 *
 * D-014 established by measurement that the gateway has exactly one exec site and that the
 * packaged desktop app and both container images spawn no gateway at all — which is why those
 * two cells of the launch matrix are vacuous rather than untested. D-014 also declares its own
 * falsifier: "If any future change adds a second gateway spawn site, this decision is VOID."
 *
 * A one-time grep cannot enforce that. This test can: it re-runs the measurement on every CI
 * run, so the day someone adds a Tauri sidecar entry or a container CMD for the gateway, the
 * decision stops being silently wrong and this fails instead.
 */
test('the fleet systemd gateway pins its database instead of following desktop discovery', () => {
  const repoRoot = join(__dirname, '..', '..', '..', '..');
  const unit = readFileSync(
    join(repoRoot, 'apps/operator/scripts/systemd/papercup-inference-gateway.service'),
    'utf8',
  );
  const databasePin = unit.match(/^Environment="HARNESS_ADMIN_DATABASE_URL=([^"\r\n]+)"$/m)?.[1];
  assert.equal(databasePin, SYSTEMD_UNIT_ENV.HARNESS_ADMIN_DATABASE_URL);
  const database = new URL(databasePin!);
  assert.equal(database.hostname, 'localhost');
  assert.equal(database.port, '5432');
  assert.equal(database.pathname, '/papercusp');
});

test('D-014 recurrence guard: the packaged app and containers still spawn no gateway', () => {
  const repoRoot = join(__dirname, '..', '..', '..', '..');

  const surfaces = [
    'papercusp-desktop/src-tauri/tauri.conf.json',
    'papercusp-desktop/src-tauri/Cargo.toml',
    'Dockerfile.papercup',
    'Dockerfile.operator',
  ];

  // POSITIVE CONTROL: an empty scan and a mis-rooted scan are indistinguishable without one.
  // Every surface must exist and be non-trivial before its emptiness means anything. (The P-012
  // close caught exactly this failure mode: a probe whose own control silently returned nothing.)
  const present = surfaces.filter((rel) => existsSync(join(repoRoot, rel)));
  assert.ok(
    present.length > 0,
    `mis-rooted scan: none of ${JSON.stringify(surfaces)} resolved under ${repoRoot}. ` +
      'A zero-match result below would be meaningless.',
  );

  for (const rel of present) {
    const body = readFileSync(join(repoRoot, rel), 'utf8');
    assert.ok(body.length > 0, `${rel} is empty — the scan below would be vacuous`);

    for (const marker of ['inference-gateway/bin', RETIRED_CLAUDE_CEILING, RETIRED_CODEX_CEILING]) {
      assert.ok(
        !body.includes(marker),
        `${rel} now references '${marker}'. Plan decision D-014 asserted the packaged app and ` +
          'containers spawn no gateway and set no capacity ceiling; that measurement is now VOID. ' +
          'Re-evidence D-014 and the P-012/P-014 deployment-path cells before proceeding.',
      );
    }
  }
});
