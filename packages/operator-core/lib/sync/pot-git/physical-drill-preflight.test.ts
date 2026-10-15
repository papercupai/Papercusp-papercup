import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommsTrustEntry } from '../../trust/comms-trust';
import { PHASE_D_TIER_HOLD_NOTE_PREFIX } from './physical-drill-phase-d';
import {
  DRILL_OWNER_PORT,
  DRILL_PHASE_D_LOCK_OWNER_MARKER,
  DRILL_SOURCE_DIR,
  DRILL_SOURCE_SHA_ENV,
  DRILL_TOWER_SOURCE_ENV,
  drillSourceViolation,
  gitBlobId,
  integrationBaselineViolation,
  observeDrillSource,
  observeIntegrationBaseline,
  PHYSICAL_DRILL_PREFLIGHT_CHECKS,
  PHYSICAL_DRILL_PREFLIGHT_FAILED,
  parseBuildStamp,
  parsePhysicalDrillPreflightArgs,
  parseVmPayloadProbe,
  physicalDrillPreflightMode,
  runPhysicalDrillPreflight,
  vmPayloadProbeCommand,
  type DrillSourceObservation,
  type IntegrationBaselineObservation,
  type PhysicalDrillPreflightDeps,
  type VmPayloadProbe,
} from './physical-drill-preflight';

// physical-drill-iteration-speed-2026-09-29 P-003 (R-5): each P-505 guard-rail fact
// is an executable, read-only refusal that runs before the first rig ssh. Every
// dependency is stubbed — no real ssh, git, database or HTTP call happens here.

const NOW = Date.parse('2026-09-30T02:00:00Z');
const SERVE = 'a'.repeat(64);
const HARNESS = 'b'.repeat(64);
const VM_USER = 1567022;
const TOWER_USER = 279242982;

function trust(overrides: Partial<CommsTrustEntry> = {}): CommsTrustEntry {
  return {
    githubUserId: VM_USER,
    tier: 'steer',
    gate: false,
    note: 'Owner device identity — canary auto-integrate unblock',
    expiresAtMs: null,
    createdTs: NOW - 1_000,
    updatedTs: NOW - 1_000,
    ...overrides,
  };
}

function vmProbe(overrides: Partial<VmPayloadProbe> = {}): VmPayloadProbe {
  return {
    stampServeSha256: SERVE,
    stampHarnessSuSha256: HARNESS,
    serveSha256: SERVE,
    harnessSuSha256: HARNESS,
    ownerHealthStatus: '200',
    ...overrides,
  };
}

const PIN = 'c'.repeat(40);
const PHASE_D_WITH_LOCK = `const owner = \`${DRILL_PHASE_D_LOCK_OWNER_MARKER}\${runId}\`;`;
const PHASE_D_PATH = 'packages/operator-core/lib/sync/pot-git/physical-drill-phase-d.ts';
const PHASE_E_PATH = 'packages/operator-core/lib/sync/pot-git/physical-drill-phase-e.ts';

/** A pinned run whose tower snapshot equals the pinned commit (D-086). */
function pinnedSource(
  overrides: Partial<Extract<DrillSourceObservation, { pinned: true }>> = {},
): DrillSourceObservation {
  const blobs = new Map([
    [PHASE_D_PATH, '1'.repeat(40)],
    [PHASE_E_PATH, '2'.repeat(40)],
  ]);
  return { pinned: true, sha: PIN, commitBlobs: blobs, executedBlobs: new Map(blobs), phaseD: PHASE_D_WITH_LOCK, ...overrides };
}

/** A healthy rig; each test breaks exactly one thing. */
const STAGING = 'e6ef2827d75e4045e7095c96b05bfb94d13fe6cb';
const TOWER_KEY = '3DCu5+PUoj6hPu0mXDWXhad9c5/OCAj7VGDhoeIXpUM=';

function baseline(overrides: Partial<IntegrationBaselineObservation> = {}): IntegrationBaselineObservation {
  return {
    target: 'hello-world-3-pot/gh-1303510992',
    canonicalStagingOid: STAGING,
    worktreeHeadOid: STAGING,
    worktreeContained: true,
    blockedHeads: [],
    ...overrides,
  };
}

function healthy(overrides: Partial<PhysicalDrillPreflightDeps> = {}): Required<PhysicalDrillPreflightDeps> {
  return {
    listTrust: vi.fn(async () => [trust(), trust({ githubUserId: TOWER_USER })]),
    readCanaryMode: vi.fn(async () => ({ mode: 'bridged', source: 'set' })),
    observeDrillSource: vi.fn(async () => pinnedSource()),
    probeVm: vi.fn(async () => vmProbe()),
    readTowerStamp: vi.fn(async () => ({ serveSha256: SERVE, harnessSuSha256: HARNESS, composedAt: '2026-09-29T01:12:18Z' })),
    towerHealthStatus: vi.fn(async () => 200),
    observeIntegrationBaseline: vi.fn(async () => baseline()),
    nowMs: () => NOW,
    ...overrides,
  } as Required<PhysicalDrillPreflightDeps>;
}

async function refusal(deps: PhysicalDrillPreflightDeps, vmGithubUserId: number | null = VM_USER) {
  const report = await runPhysicalDrillPreflight({ vmGithubUserId }, deps);
  expect(report.ok).toBe(false);
  return report.firstFailure!;
}

describe('runPhysicalDrillPreflight', () => {
  it('passes a healthy rig on every named check (test-file edits are not drill source)', async () => {
    const report = await runPhysicalDrillPreflight({ vmGithubUserId: VM_USER }, healthy());
    expect(report.ok).toBe(true);
    expect(report.firstFailure).toBeNull();
    expect(report.results.map((result) => result.check)).toEqual([...PHYSICAL_DRILL_PREFLIGHT_CHECKS]);
    expect(report.results.every((result) => result.ok)).toBe(true);
  });

  it('drill-source-committed (unpinned): refuses uncommitted or untracked drill source, naming the files', async () => {
    const failure = await refusal(
      healthy({
        observeDrillSource: vi.fn(async (): Promise<DrillSourceObservation> => ({
          pinned: false,
          statusLines: [
            ` M ${PHASE_E_PATH}`,
            '?? packages/operator-core/lib/sync/pot-git/physical-drill-new.ts',
            ' M packages/operator-core/lib/sync/pot-git/physical-drill-phase-d.test.ts',
          ],
          phaseD: PHASE_D_WITH_LOCK,
        })),
      }),
    );
    expect(failure.check).toBe('drill-source-committed');
    expect(failure.reason).toContain('physical-drill-phase-e.ts');
    expect(failure.reason).toContain('physical-drill-new.ts');
    expect(failure.reason).not.toContain('phase-d.test.ts');
    expect(failure.reason).toContain('git archive');
  });

  it('drill-source-committed (unpinned): test-file edits alone are not drill source', () => {
    expect(
      drillSourceViolation({
        pinned: false,
        statusLines: [' M packages/operator-core/lib/sync/pot-git/physical-drill-phase-d.test.ts'],
        phaseD: PHASE_D_WITH_LOCK,
      }),
    ).toBeNull();
  });

  it('drill-source-committed: refuses a Phase D without the live dirt lock (WI-10003741), pinned or not', async () => {
    const pinned = await refusal(
      healthy({ observeDrillSource: vi.fn(async () => pinnedSource({ phaseD: 'export const nothing = 1;' })) }),
    );
    expect(pinned.check).toBe('drill-source-committed');
    expect(pinned.reason).toContain(DRILL_PHASE_D_LOCK_OWNER_MARKER);
    expect(pinned.reason).toContain(`pinned commit ${PIN.slice(0, 12)}`);
    expect(
      drillSourceViolation({ pinned: false, statusLines: [], phaseD: 'export const nothing = 1;' }),
    ).toContain(`HEAD ${PHASE_D_PATH}`);
  });

  it('drill-source-committed (pinned, D-086): refuses a tower snapshot that differs from the pinned commit, naming the file', async () => {
    const failure = await refusal(
      healthy({
        observeDrillSource: vi.fn(async () =>
          pinnedSource({ executedBlobs: new Map([[PHASE_D_PATH, '1'.repeat(40)], [PHASE_E_PATH, '9'.repeat(40)]]) }),
        ),
      }),
    );
    expect(failure.check).toBe('drill-source-committed');
    expect(failure.reason).toContain(`differing: ${PHASE_E_PATH}`);
    expect(failure.reason).toContain(`pinned commit ${PIN.slice(0, 12)}`);
    const missingAndExtra = drillSourceViolation(
      pinnedSource({ executedBlobs: new Map([[PHASE_D_PATH, '1'.repeat(40)], ['packages/operator-core/lib/sync/pot-git/x.ts', '3'.repeat(40)]]) }),
    );
    expect(missingAndExtra).toContain(`missing: ${PHASE_E_PATH}`);
    expect(missingAndExtra).toContain('extra: packages/operator-core/lib/sync/pot-git/x.ts');
  });

  it('drill-source-committed (pinned): an empty pinned drill source is a refusal, not a vacuous match', () => {
    expect(drillSourceViolation(pinnedSource({ commitBlobs: new Map(), executedBlobs: new Map() }))).toContain(
      'has no drill source',
    );
  });

  it('canary-mode-baseline: refuses a canary a crashed Phase E left in legacy', async () => {
    const failure = await refusal(healthy({ readCanaryMode: vi.fn(async () => ({ mode: 'legacy', source: 'set' })) }));
    expect(failure.check).toBe('canary-mode-baseline');
    expect(failure.reason).toContain("'legacy'");
    expect(failure.reason).toContain('phase-e-mode-ensure bridged');
  });

  it('vm-trust-hold-ready: refuses a never-restored below-steer hold, even after it lapsed', async () => {
    for (const expiresAtMs of [NOW + 60_000, NOW - 60_000]) {
      const failure = await refusal(
        healthy({
          listTrust: vi.fn(async () => [
            trust({
              tier: 'message',
              note: `${PHASE_D_TIER_HOLD_NOTE_PREFIX} p505-run-27; restore the prior row via phase-d-tier-restore`,
              expiresAtMs,
            }),
          ]),
        }),
      );
      expect(failure.check).toBe('vm-trust-hold-ready');
      expect(failure.reason).toContain('p505-run-27');
      expect(failure.reason).toContain(`github user ${VM_USER}`);
      expect(failure.reason).toContain(expiresAtMs > NOW ? 'expires' : 'lapsed');
    }
  });

  it('vm-trust-hold-ready: refuses a gate-only VM row the hold could not restore exactly', async () => {
    const failure = await refusal(healthy({ listTrust: vi.fn(async () => [trust({ tier: null, gate: true })]) }));
    expect(failure.check).toBe('vm-trust-hold-ready');
    expect(failure.reason).toContain('gate-only');
  });

  it('vm-trust-hold-ready: another user\'s gate-only row is irrelevant when the VM user is known, and refused when it is not', async () => {
    const deps = healthy({
      listTrust: vi.fn(async () => [trust(), trust({ githubUserId: 42, tier: null, gate: true })]),
    });
    expect((await runPhysicalDrillPreflight({ vmGithubUserId: VM_USER }, deps)).ok).toBe(true);
    const failure = await refusal(deps, null);
    expect(failure.reason).toContain('github user 42');
    expect(failure.reason).toContain('VM user unknown');
  });

  it('vm-payload-current: refuses a VM payload that is not the build the tower composed', async () => {
    const other = 'c'.repeat(64);
    const failure = await refusal(
      healthy({ probeVm: vi.fn(async () => vmProbe({ stampServeSha256: other, serveSha256: other })) }),
    );
    expect(failure.check).toBe('vm-payload-current');
    expect(failure.reason).toContain('not the build the tower last composed');
  });

  it('vm-payload-current: refuses current code against a stale harness (WI-10003486)', async () => {
    const failure = await refusal(healthy({ probeVm: vi.fn(async () => vmProbe({ harnessSuSha256: 'd'.repeat(64) })) }));
    expect(failure.check).toBe('vm-payload-current');
    expect(failure.reason).toContain('stale harness');
  });

  it('vm-payload-current: an unknown expected build is a refusal, not a pass', async () => {
    const failure = await refusal(healthy({ readTowerStamp: vi.fn(async () => null) }));
    expect(failure.check).toBe('vm-payload-current');
    expect(failure.reason).toContain('compose-rig-sidecar-current.sh');
  });

  it('hosts-answering: refuses when either owner does not answer health', async () => {
    const vmDown = await refusal(healthy({ probeVm: vi.fn(async () => vmProbe({ ownerHealthStatus: '000' })) }));
    expect(vmDown.check).toBe('hosts-answering');
    expect(vmDown.reason).toContain('VM owner');
    const towerDown = await refusal(healthy({ towerHealthStatus: vi.fn(async () => 0) }));
    expect(towerDown.check).toBe('hosts-answering');
    expect(towerDown.reason).toContain('tower');
  });

  it('hosts-answering reads the owner ports the run targets, not the live :3070 (same-box rig, D-003)', async () => {
    // Physical rig: both owners on DRILL_OWNER_PORT.
    const physical = healthy();
    await runPhysicalDrillPreflight({ checks: ['hosts-answering'] }, physical);
    expect(physical.towerHealthStatus).toHaveBeenCalledWith(DRILL_OWNER_PORT);
    expect(physical.probeVm).toHaveBeenCalledWith(DRILL_OWNER_PORT);
    // Same-box rig: two throwaway owners on their own ports. Reading :3070 here would measure
    // the live operator and report a rig that is down as up.
    const sameBox = healthy({
      towerHealthStatus: vi.fn(async (port: number) => (port === 18471 ? 200 : 0)),
      probeVm: vi.fn(async (port: number) => vmProbe({ ownerHealthStatus: port === 18571 ? '200' : '000' })),
    });
    const up = await runPhysicalDrillPreflight({ checks: ['hosts-answering'], towerPort: 18471, vmOwnerPort: 18571 }, sameBox);
    expect(up.ok).toBe(true);
    expect(sameBox.towerHealthStatus).toHaveBeenCalledWith(18471);
    expect(sameBox.probeVm).toHaveBeenCalledWith(18571);
    const down = await runPhysicalDrillPreflight(
      { checks: ['hosts-answering'], towerPort: 18472, vmOwnerPort: 18572 },
      healthy({ towerHealthStatus: vi.fn(async () => 0), probeVm: vi.fn(async () => vmProbe({ ownerHealthStatus: '000' })) }),
    );
    expect(down.firstFailure?.reason).toContain('tower :18472/api/health');
    expect(down.firstFailure?.reason).toContain('VM owner :18572/api/health');
    expect(down.firstFailure?.reason).not.toContain(`:${DRILL_OWNER_PORT}`);
  });

  it('a check whose gatherer throws FAILS — an unmeasured guard rail is not a pass', async () => {
    const failure = await refusal(
      healthy({ listTrust: vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'))) }),
    );
    expect(failure.check).toBe('vm-trust-hold-ready');
    expect(failure.reason).toContain('could not be evaluated');
    expect(failure.reason).toContain('ECONNREFUSED');
  });

  it('--check runs only the named checks and gathers nothing else (no ssh for a source-only check)', async () => {
    const deps = healthy();
    const report = await runPhysicalDrillPreflight({ checks: ['drill-source-committed'] }, deps);
    expect(report.results.map((result) => result.check)).toEqual(['drill-source-committed']);
    expect(deps.probeVm).not.toHaveBeenCalled();
    expect(deps.listTrust).not.toHaveBeenCalled();
    expect(deps.readCanaryMode).not.toHaveBeenCalled();
  });

  it('vm-payload-current and hosts-answering share ONE VM ssh round-trip', async () => {
    const deps = healthy();
    await runPhysicalDrillPreflight({}, deps);
    expect(deps.probeVm).toHaveBeenCalledTimes(1);
  });
});

describe('physicalDrillPreflightMode (producer rig-preflight)', () => {
  it('returns the report when every check passes', async () => {
    const report = await physicalDrillPreflightMode(['--vm-github-user-id', String(VM_USER)], healthy());
    expect(report.ok).toBe(true);
  });

  it('refuses with a first line naming the failed check, then every other failure', async () => {
    const run = physicalDrillPreflightMode(
      [],
      healthy({
        readCanaryMode: vi.fn(async () => ({ mode: 'legacy', source: 'set' })),
        towerHealthStatus: vi.fn(async () => 503),
      }),
    );
    await expect(run).rejects.toThrow(/^PHYSICAL_PREFLIGHT_FAILED canary-mode-baseline: /);
    const message = await run.then(
      () => '',
      (error: Error) => error.message,
    );
    const lines = message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^${PHYSICAL_DRILL_PREFLIGHT_FAILED} hosts-answering: `));
  });

  it('parses --check/--vm-github-user-id and rejects anything else before gathering', () => {
    expect(parsePhysicalDrillPreflightArgs(['--check', 'canary-mode-baseline', '--check', 'hosts-answering'])).toEqual({
      checks: ['canary-mode-baseline', 'hosts-answering'],
      vmGithubUserId: null,
    });
    expect(parsePhysicalDrillPreflightArgs(['--vm-github-user-id', '1567022']).vmGithubUserId).toBe(1567022);
    expect(parsePhysicalDrillPreflightArgs(['--tower-port', '18471', '--vm-port', '18571'])).toEqual({
      checks: [],
      vmGithubUserId: null,
      towerPort: 18471,
      vmOwnerPort: 18571,
    });
    for (const bad of [
      ['--check', 'nope'],
      ['--check'],
      ['--vm-github-user-id', '0'],
      ['--force'],
      ['--tower-port', '0'],
      ['--tower-port', '65536'],
      ['--vm-port', '3070;rm'],
      ['--vm-port'],
    ]) {
      expect(() => parsePhysicalDrillPreflightArgs(bad)).toThrow(/usage: physical-drill-producer rig-preflight/);
    }
  });
});

describe('VM probe plumbing', () => {
  it('parses the single ssh output, treating a silent health curl as not answering', () => {
    expect(
      parseVmPayloadProbe(
        `stamp.serveSha256=${SERVE}\nstamp.harnessSuSha256=${HARNESS}\nserve=${SERVE}\nharness=${HARNESS}\nhealth=200\n`,
      ),
    ).toEqual(vmProbe());
    expect(parseVmPayloadProbe('serve=\nharness=\nhealth=\n')).toEqual({
      stampServeSha256: '',
      stampHarnessSuSha256: '',
      serveSha256: '',
      harnessSuSha256: '',
      ownerHealthStatus: '000',
    });
  });

  it('reads the tower compose stamp in the shape compose-rig-sidecar-current.sh writes', () => {
    expect(
      parseBuildStamp(
        `sha=aef4431553c9 dirty=1 composedAt=2026-09-29T01:12:18Z\nserveSha256=${SERVE}\nserveBytes=1\nharnessSuSha256=${HARNESS}\n`,
      ),
    ).toEqual({ serveSha256: SERVE, harnessSuSha256: HARNESS, composedAt: '2026-09-29T01:12:18Z' });
  });

  it('defaults the VM payload dir to the VM\'s own $HOME and is read-only', () => {
    const command = vmPayloadProbeCommand();
    expect(command).toContain('"$HOME/rig-sidecar-current"/BUILD-STAMP.txt');
    expect(command).not.toMatch(/\/Users\//);
    expect(command).not.toMatch(/\b(rm|mv|cp|tee|kill)\b|>\s*[^&/]/);
    expect(vmPayloadProbeCommand("/tmp/it's")).toContain(`'/tmp/it'\\''s'/serve.mjs`);
  });

  it('reads the VM owner health on the port it is given, defaulting to the physical owner port', () => {
    expect(vmPayloadProbeCommand()).toContain(`http://127.0.0.1:${DRILL_OWNER_PORT}/api/health`);
    expect(vmPayloadProbeCommand(undefined, 18571)).toContain('http://127.0.0.1:18571/api/health');
    expect(vmPayloadProbeCommand(undefined, 18571)).not.toContain(`:${DRILL_OWNER_PORT}/`);
    expect(() => vmPayloadProbeCommand(undefined, 0)).toThrow(/not a TCP port/);
  });
});

describe('probe wiring', () => {
  // Overridable so a copy-out mutation probe can point this guard at a mutated copy.
  const probePath =
    process.env.PHYSICAL_PROBE_UNDER_TEST ??
    fileURLToPath(new URL('../../../../../papercusp-desktop/bin/vm-rig/hive-git-physical-probe.sh', import.meta.url));

  it('pins candidate gitlinks despite live head/config drift and refuses invalid refs', () => {
    const root = mkdtempSync(join(tmpdir(), 'physical-source-pin-'));
    const sub = join(root, 'libs', 'example');
    const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    }).trim();
    try {
      mkdirSync(sub, { recursive: true });
      gitAt(root, 'init', '-q');
      gitAt(sub, 'init', '-q');
      writeFileSync(join(sub, 'payload'), 'candidate');
      gitAt(sub, 'add', 'payload');
      gitAt(sub, 'commit', '-qm', 'candidate');
      const subSha = gitAt(sub, 'rev-parse', 'HEAD');
      writeFileSync(join(root, '.gitmodules'), '[submodule "example"]\npath = libs/example\nurl = ./example\n');
      gitAt(root, 'add', '.gitmodules');
      gitAt(root, 'update-index', '--add', '--cacheinfo', `160000,${subSha},libs/example`);
      gitAt(root, 'commit', '-qm', 'candidate');
      const candidate = gitAt(root, 'rev-parse', 'HEAD');
      writeFileSync(join(sub, 'payload'), 'later');
      gitAt(sub, 'commit', '-qam', 'later');
      writeFileSync(join(root, '.gitmodules'), '[submodule "wrong"]\npath = libs/missing\nurl = ./missing\n');
      const source = readFileSync(probePath, 'utf8').split('# SOURCE-PIN-BEGIN')[1].split('# SOURCE-PIN-END')[0];
      const run = (ref: string) => execFileSync('bash', ['-c',
        'set -euo pipefail; fail() { echo "$*" >&2; exit 1; };\n' + source +
        '\nprintf "%s\\n" "$source_sha" "${staged_submodules[@]}" "${staged_submodule_shas[@]}"',
      ], { encoding: 'utf8', env: { ...process.env, REPO_ROOT: root, HIVE_GIT_PHYSICAL_SOURCE_REF: ref } });
      expect(run(candidate).trim().split('\n')).toEqual([candidate, 'libs/example', subSha]);
      expect(() => run('not-a-valid-ref')).toThrow();
      expect(() => run('--all')).toThrow();
      rmSync(join(sub, '.git'), { recursive: true, force: true });
      expect(() => run(candidate)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runs rig-preflight after the readiness gate and before run_dir and the first rig ssh, failing closed', () => {
    const probe = readFileSync(probePath, 'utf8');
    const code = probe
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const preflight = code.search(/"\$TSX" "\$PRODUCER" rig-preflight\b/);
    expect(preflight).toBeGreaterThan(-1);
    expect(code.indexOf('--require-ready')).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(code.indexOf('run_dir="$(mktemp'));
    expect(preflight).toBeLessThan(code.search(/\bssh "\$\{SSH_OPTS\[@\]\}"/));
    const call = code.slice(preflight, code.indexOf('\n', code.indexOf('|| fail', preflight)));
    expect(call).toMatch(/\|\| fail /);
    expect(code.slice(code.lastIndexOf('\n', preflight), preflight)).toContain('PCUSP_VM_SSH="$VM"');
  });

  it('reuses the candidate snapshot for local legs before schema checks without retargeting the physical repo', () => {
    const probe = readFileSync(probePath, 'utf8');
    const offline = probe.indexOf("printf 'local candidate source ready:");
    expect(offline).toBeGreaterThan(probe.indexOf('run_source_overlay_js | node'));
    expect(offline).toBeLessThan(probe.indexOf('phase-e-preflight >/dev/null'));
    expect(probe.slice(offline, probe.indexOf('phase-e-preflight >/dev/null'))).toContain('exit 0');
    const drill = readFileSync(fileURLToPath(new URL('../../../../../papercusp-desktop/bin/hive-git-drill.sh', import.meta.url)), 'utf8');
    const local = drill.indexOf('--local-source-out "$WORK/local-source"');
    const sql = drill.indexOf('REPO_SQL_DIR="$REPO_DIR/');
    expect(local).toBeGreaterThan(-1);
    expect(local).toBeLessThan(sql);
    expect(drill.slice(local, sql)).toContain('REPO_DIR="$WORK/local-source"');
    expect(drill).toContain('PAPERCUSP_REPO_DIR="$LIVE_REPO_DIR" HIVE_GIT_PHYSICAL_PLAN=');
  });

  it('exports the D-086 pin (pinned sha + tower snapshot) before the rig-preflight call', () => {
    const code = readFileSync(probePath, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const preflight = code.search(/"\$TSX" "\$PRODUCER" rig-preflight\b/);
    const sha = code.indexOf(`export ${DRILL_SOURCE_SHA_ENV}="$source_sha"`);
    const snapshot = code.indexOf(`export ${DRILL_TOWER_SOURCE_ENV}="$tower_source"`);
    expect(sha).toBeGreaterThan(code.indexOf('source_sha="$(git'));
    expect(snapshot).toBeGreaterThan(code.indexOf('stage_pinned_source tower'));
    expect(sha).toBeLessThan(preflight);
    expect(snapshot).toBeLessThan(preflight);
  });
});

// D-086 behaviours through the REAL default gatherers against a throwaway git repo:
// (1) a pinned run passes even while the live tree is dirty, because the dirt is not
// part of the run; (2) the same dirt refuses an unpinned (standalone) preflight;
// (3) a snapshot that drifted from its pinned commit refuses.
describe('observeDrillSource against a real git repo (D-086)', () => {
  let repo = '';
  let snapshot = '';
  let sha = '';
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const write = (root: string, rel: string, body: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'd086-repo-'));
    snapshot = mkdtempSync(join(tmpdir(), 'd086-snapshot-'));
    git('init', '-q');
    git('config', 'user.email', 'd086@test.invalid');
    git('config', 'user.name', 'd086');
    write(repo, PHASE_D_PATH, `${PHASE_D_WITH_LOCK}\n`);
    write(repo, PHASE_E_PATH, 'export const e = 1;\n');
    write(repo, `${DRILL_SOURCE_DIR}/physical-drill-phase-e.test.ts`, 'it.todo("e");\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'pinned');
    sha = git('rev-parse', 'HEAD');
    execFileSync('bash', ['-c', `git -C '${repo}' archive --format=tar ${sha} -- packages | tar -xf - -C '${snapshot}'`]);
    // A peer's uncommitted edit AFTER the pin: exactly what used to refuse every rig run.
    write(repo, PHASE_E_PATH, 'export const e = 2; // peer edit in flight\n');
    vi.stubEnv('PAPERCUSP_REPO_DIR', repo);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
    rmSync(snapshot, { recursive: true, force: true });
  });

  it('gitBlobId matches git hash-object', () => {
    expect(gitBlobId(Buffer.from('export const e = 1;\n'))).toBe(
      execFileSync('bash', ['-c', `printf 'export const e = 1;\\n' | git hash-object --stdin`], { encoding: 'utf8' }).trim(),
    );
  });

  it('(1) pinned: the live tree is dirty, the snapshot equals the pinned commit, so it PASSES', async () => {
    const observed = await observeDrillSource({ [DRILL_SOURCE_SHA_ENV]: sha, [DRILL_TOWER_SOURCE_ENV]: snapshot });
    expect(observed.pinned).toBe(true);
    if (observed.pinned) {
      expect([...observed.commitBlobs.keys()].sort()).toEqual([PHASE_D_PATH, PHASE_E_PATH]);
    }
    expect(drillSourceViolation(observed)).toBeNull();
  });

  it('(2) unpinned: the same live-tree dirt REFUSES, naming the file', async () => {
    const violation = drillSourceViolation(await observeDrillSource({}));
    expect(violation).toContain(PHASE_E_PATH);
    expect(violation).toContain('unpinned');
  });

  it('(3) pinned: a snapshot that drifted from its commit REFUSES', async () => {
    write(snapshot, PHASE_E_PATH, 'export const e = 3; // tampered\n');
    const violation = drillSourceViolation(
      await observeDrillSource({ [DRILL_SOURCE_SHA_ENV]: sha, [DRILL_TOWER_SOURCE_ENV]: snapshot }),
    );
    expect(violation).toContain(`differing: ${PHASE_E_PATH}`);
  });

  it('half a pin or a malformed sha is a wiring fault that fails the check', async () => {
    await expect(observeDrillSource({ [DRILL_SOURCE_SHA_ENV]: sha })).rejects.toThrow('must be set together');
    await expect(
      observeDrillSource({ [DRILL_SOURCE_SHA_ENV]: 'HEAD', [DRILL_TOWER_SOURCE_ENV]: snapshot }),
    ).rejects.toThrow('not a full commit sha');
    const report = await runPhysicalDrillPreflight(
      { checks: ['drill-source-committed'] },
      { observeDrillSource: () => observeDrillSource({ [DRILL_TOWER_SOURCE_ENV]: snapshot }) },
    );
    expect(report.ok).toBe(false);
    expect(report.firstFailure?.reason).toContain('could not be evaluated');
  });
});

describe('hold-note single source', () => {
  it('the hold Phase D writes carries the prefix the preflight recognises', () => {
    const phaseD = readFileSync(fileURLToPath(new URL('./physical-drill-phase-d.ts', import.meta.url)), 'utf8');
    expect(phaseD).toContain('note: `${PHASE_D_TIER_HOLD_NOTE_PREFIX} ${input.runId};');
  });
});

// Same-box run 12 (WI-10003976): both owners' rig-up heads sat in the tower's ratify
// queue as below-steer-tier, so Phase D's tower convergence burned its whole budget.
describe('integration-queue-clear', () => {
  const HEAD = '1'.repeat(40);

  it('passes a baseline whose member heads are all in staging', () => {
    expect(integrationBaselineViolation(baseline())).toBeNull();
  });

  it('refuses a queued member head, naming the device, the head and the reason', async () => {
    const failure = await refusal(
      healthy({
        observeIntegrationBaseline: vi.fn(async () =>
          baseline({ blockedHeads: [{ devicePubkey: TOWER_KEY, headSha: HEAD, reason: 'below-steer-tier' }] }),
        ),
      }),
    );
    expect(failure.check).toBe('integration-queue-clear');
    expect(failure.reason).toContain('ratify queue');
    expect(failure.reason).toContain(`${TOWER_KEY.slice(0, 12)}@${HEAD.slice(0, 12)} (below-steer-tier)`);
    expect(failure.reason).toContain('trust:comms set');
  });

  it('refuses a tower worktree that staging does not contain', () => {
    const reason = integrationBaselineViolation(baseline({ worktreeHeadOid: HEAD, worktreeContained: false }));
    expect(reason).toContain(`worktree HEAD ${HEAD.slice(0, 12)} is not contained in canonical staging ${STAGING.slice(0, 12)}`);
  });

  it('refuses a store whose integrator never advanced staging', () => {
    expect(integrationBaselineViolation(baseline({ canonicalStagingOid: null }))).toContain('has no canonical staging');
  });

  describe('observeIntegrationBaseline on a real store (the run-12 shape)', () => {
    let root: string;
    const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    const commitFile = (cwd: string, file: string, body: string) => {
      writeFileSync(join(cwd, file), body);
      g(cwd, 'add', file);
      g(cwd, 'commit', '-q', '-m', file);
      return g(cwd, 'rev-parse', 'HEAD');
    };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'pds-baseline-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('reports the unabsorbed tower head and worktree, ignores absorbed and unpublished rows, and clears once integrated', async () => {
      const store = join(root, 'store.git');
      const work = join(root, 'work');
      execFileSync('git', ['init', '-q', '--bare', store]);
      execFileSync('git', ['init', '-q', work]);
      g(work, 'config', 'user.email', 'pds@test.invalid');
      g(work, 'config', 'user.name', 'pds');
      const base = commitFile(work, 'README', 'hello\n');
      const towerHead = commitFile(work, 'blueprint.yaml', 'tower rig-up\n');
      g(work, 'checkout', '-q', '-b', 'vm', base);
      const vmHead = commitFile(work, 'shared.json', '{}\n');
      const staging = commitFile(work, 'p505-phase-d-overlap.txt', 'below-steer\n');
      g(work, 'push', '-q', store, `${towerHead}:refs/namespaces/tower/refs/heads/master`);
      g(work, 'push', '-q', store, `${vmHead}:refs/namespaces/vm/refs/heads/master`);
      g(work, 'push', '-q', store, `${staging}:refs/hive/staging`);
      g(work, 'checkout', '-q', towerHead);
      const unpublished = '2'.repeat(40);
      const request = (devicePubkey: string, headSha: string) => ({
        workspaceId: 'papercusp-workspace',
        potSlug: 'hello-world-pot',
        repoKey: 'gh-1296269',
        devicePubkey,
        headSha,
        authorGithubUserId: null,
        reason: 'below-steer-tier' as const,
        state: 'pending' as const,
        createdTs: NOW,
        ratifiedTs: null,
      });
      const pending = [request(TOWER_KEY, towerHead), request('CIVgFN1u9IhA', vmHead), request('stale-device', unpublished)];

      const observed = await observeIntegrationBaseline({ repoPath: store, worktreePath: work, listPending: async () => pending });
      expect(observed.canonicalStagingOid).toBe(staging);
      expect(observed.worktreeHeadOid).toBe(towerHead);
      expect(observed.worktreeContained).toBe(false);
      expect(observed.blockedHeads).toEqual([{ devicePubkey: TOWER_KEY, headSha: towerHead, reason: 'below-steer-tier' }]);
      expect(integrationBaselineViolation(observed)).toContain('ratify queue');

      // The integrator absorbs the tower head: staging now contains everything.
      g(work, 'checkout', '-q', staging);
      g(work, 'merge', '-q', '--no-edit', towerHead);
      g(work, 'push', '-q', '-f', store, 'HEAD:refs/hive/staging');
      const settled = await observeIntegrationBaseline({ repoPath: store, worktreePath: work, listPending: async () => pending });
      expect(settled.worktreeContained).toBe(true);
      expect(settled.blockedHeads).toEqual([]);
      expect(integrationBaselineViolation(settled)).toBeNull();
    });
  });
});
