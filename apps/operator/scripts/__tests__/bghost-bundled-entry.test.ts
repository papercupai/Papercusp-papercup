import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = join(__dirname, '..');
const BUNDLE_HOST = join(SCRIPTS_DIR, '..', 'bin', 'bundle-host.sh');
const BUNDLE_HOST_COMMON = join(SCRIPTS_DIR, '..', 'bin', 'bundle-host-common.sh');
const DROP_IN = join(SCRIPTS_DIR, 'systemd', 'papercup-bg-host.service.d', '95-bundled-entry.conf');
const GATEWAY_AUTHORITY_DROP_IN = join(
  SCRIPTS_DIR,
  'systemd',
  'papercup-bg-host.service.d',
  '97-gateway-systemd-authority.conf',
);
const PACKAGED_SERVER_GATEWAY_AUTHORITY_DROP_IN = join(
  SCRIPTS_DIR,
  'systemd',
  'papercusp-server.service.d',
  '97-gateway-systemd-authority.conf',
);
const DEPENDENCY_GENERATION_DROP_IN = join(
  SCRIPTS_DIR,
  'systemd',
  'papercup-bg-host.service.d',
  '98-dependency-generation-root.conf',
);
const README = join(SCRIPTS_DIR, 'systemd', 'README.md');

/**
 * The path as the UNIT spells it — systemd's %h specifier, not an absolute path.
 * This deliberately does NOT reuse BUNDLE_HOST (an absolute fs path derived from
 * __dirname): asserting the drop-in contains this checkout's absolute path is what
 * previously pinned a build-box home directory into shipped source, which the
 * identity-lint leg of green-checkpoint rejects.
 */
const BUNDLE_HOST_UNIT_PATH = '%h/papercupai-workspace/papercusp/apps/operator/bin/bundle-host.sh';
const SNAPSHOT_LAUNCHER_UNIT_PATH = '%h/papercupai-workspace/papercusp/apps/operator/scripts/systemd/papercusp-script-snapshot.sh';

/**
 * SCOPE — THIS SUITE READS REPO FILES ONLY. It cannot see systemd and must never be
 * read as evidence that the drop-in is installed on any host.
 *
 * It was previously named a "systemd contract" while containing no systemd, and that
 * naming did real damage: 95-bundled-entry.conf sat absent from the live unit's
 * DropInPaths for a full day while this suite was green, and three other components
 * were written assuming it was active (bghost-watchdog.mjs, check-host-bundle-builds.mjs,
 * and this file). See plan substrate-observability-bug-wave-2026-08-26 D-002/D-004.
 *
 * The host-side fact — "is this drop-in actually loaded by the unit?" — is asserted by
 * scripts/check-systemd-dropins-installed.mjs, which reads live DropInPaths. That check
 * cannot live here: CI has no user systemd session, so the fact is unobservable from a
 * vitest by construction.
 */
describe('papercup-bg-host and Linux gateway-authority file contracts', () => {
  const bundleHost = readFileSync(BUNDLE_HOST, 'utf8');
  const bundleHostCommon = readFileSync(BUNDLE_HOST_COMMON, 'utf8');
  const dropIn = readFileSync(DROP_IN, 'utf8');
  const gatewayAuthorityDropIn = readFileSync(GATEWAY_AUTHORITY_DROP_IN, 'utf8');
  const packagedServerGatewayAuthorityDropIn = readFileSync(PACKAGED_SERVER_GATEWAY_AUTHORITY_DROP_IN, 'utf8');
  const dependencyGenerationDropIn = readFileSync(DEPENDENCY_GENERATION_DROP_IN, 'utf8');
  const readme = readFileSync(README, 'utf8');

  it('pins dependency-generation writes to the dedicated data mount (WI-10003403)', () => {
    expect(dependencyGenerationDropIn).toContain('[Service]');
    expect(dependencyGenerationDropIn).toContain(
      'Environment=PAPERCUSP_DEPENDENCY_GENERATION_ROOT=/mnt/data/papercusp-dependency-generations',
    );
    expect(readme).toContain('/mnt/data/papercusp-dependency-generations');
  });

  it('keeps the bundle-host consumer map aligned with the tracked bg-host drop-in', () => {
    expect(bundleHost).toContain(':3271 bg-host');
    expect(bundleHost).toContain('95-bundled-entry.conf');
    expect(bundleHost).not.toContain('(:3270 bg-host');

    // REMOVED 2026-08-26 (D-004): two assertions used to live here —
    //   expect(bundleHost).not.toContain('has NO ExecStartPre');
    //   expect(bundleHost).not.toContain('missing drop-in is filed separately');
    // Those phrases described the drop-in being un-installed, which was STILL TRUE when
    // the assertions were added. They made the build fail if anyone wrote the accurate
    // sentence back into bundle-host.sh, so the suite's green state was maintained by
    // deleting a true statement about the world. Do not reintroduce a not.toContain that
    // forbids describing a real condition; assert the condition itself instead — here,
    // scripts/check-systemd-dropins-installed.mjs does that against live DropInPaths.
  });

  it('bakes the source SHA into the generated host so runtime identity cannot borrow checkout HEAD', () => {
    expect(bundleHost).toContain('git -C "$REPO_ROOT" rev-parse --short HEAD');
    expect(bundleHost).toContain('BUNDLED_SOURCE_SHA_DEFINE');
    expect(bundleHost).toContain('--define:__PAPERCUSP_BUNDLED_SOURCE_SHA__');
    expect(bundleHost).toContain('"${BUNDLED_SOURCE_SHA_DEFINE[@]}"');
  });

  it('fails closed when the bundled CLI-entry recurrence guard rejects the graph', () => {
    // The guard runs through bundle_host_run_step (step-timing log); that wrapper must
    // propagate the checker's exit status, or `if !` silently stops failing closed.
    const guard =
      'if ! bundle_host_run_step host-cli-guard "${COMMITTED_NODE[@]}" "$REPO_ROOT/scripts/check-bundled-cli-entry-guards.mjs" \\';
    expect(bundleHost).toContain(guard);
    expect(bundleHostCommon).toContain('"$@" || step_rc=$?');
    expect(bundleHostCommon).toContain('return "$step_rc"');
    const guardAt = bundleHost.indexOf(guard);
    const exitAt = bundleHost.indexOf('    exit 1\n  fi', guardAt);
    const swapAt = bundleHost.indexOf('  mv -f "$TMPFILE" "$OUTFILE"', guardAt);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(exitAt).toBeGreaterThan(guardAt);
    expect(swapAt).toBeGreaterThan(exitAt);
  });

  it('resets the base ExecStart, bundles first, and preserves the inline runtime environment', () => {
    const serviceLines = dropIn.split('\n').map((line) => line.trim());
    const execLines = serviceLines.filter((line) => line.startsWith('ExecStart'));
    const environmentLines = serviceLines.filter((line) => line.startsWith('Environment='));

    // WI-10006398: bundle-host.sh runs from a frozen snapshot, with the checkout pinned.
    expect(execLines).toEqual([
      `ExecStartPre=${SNAPSHOT_LAUNCHER_UNIT_PATH} ${BUNDLE_HOST_UNIT_PATH}`,
      'ExecStart=',
      'ExecStart=/usr/bin/bash -c "set -a; [ -f .env.local ] && . ./.env.local; PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH=$${PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH:-$$GOOGLE_APPLICATION_CREDENTIALS}; unset GOOGLE_APPLICATION_CREDENTIALS; set +a; exec env \\',
    ]);
    expect(dropIn.indexOf('ExecStartPre=')).toBeLessThan(dropIn.indexOf('ExecStart=\n'));
    expect(dropIn.indexOf('ExecStart=\n')).toBeLessThan(dropIn.indexOf('ExecStart=/usr/bin/bash'));
    expect(dropIn).toContain('node dist-host/hono-host.mjs"');
    expect(dropIn).not.toContain('npx tsx bin/hono-host.ts');
    // Supervisor policy belongs on the unit; child runtime configuration stays
    // inline in ExecStart. Requiring the exact set catches drift in either
    // direction without rejecting the stale-bundle availability opt-in.
    expect(environmentLines).toEqual([
      'Environment=PAPERCUSP_BUNDLE_ALLOW_STALE_START=1',
      'Environment=BUNDLE_HOST_OPERATOR_DIR=%h/papercupai-workspace/papercusp/apps/operator',
    ]);

    for (const assignment of [
      'PAPERCUSP_HONO_PORT=3271',
      'PAPERCUSP_BIND_HOST=127.0.0.1',
      'PAPERCUSP_BACKGROUND_WORKERS=1',
      'PAPERCUSP_DBOS_ENABLE=1',
      'PAPERCUSP_DBOS_ORCHESTRATOR=1',
      'PAPERCUSP_DBOS_ROUTINES=1',
      'PAPERCUSP_DBOS_TIMERS=1',
      'PAPERCUSP_DBOS_AUTOLOOP=0',
      'DB_IDLE_TIMEOUT=10',
      'PAPERCUSP_EXPECTED_OPERATOR_PROCS=6',
      'DBOS__VMID=bg-host-3270',
      'DBOS__APPVERSION=bg-host-v1',
    ]) {
      expect(dropIn).toContain(`  ${assignment} \\`);
    }
    // PgBouncer bounds real backends. Keeping a per-process org-pool pin here
    // instead starves bg-host's client queue before the pooler reaches capacity.
    expect(dropIn).not.toContain('PAPERCUSP_DB_POOL_MAX=');
  });

  it('raises TimeoutStartSec, because ExecStartPre spends the start budget (D-003)', () => {
    // ExecStartPre time counts against TimeoutStartSec for Type=simple. The base unit
    // inherits systemd's 90s default and nothing else raises it, so the drop-in that ADDS
    // an ExecStartPre owns the timeout too — shipping one without the other leaves a
    // bundle build racing a 90s deadline on a box measured at load 421.
    const match = dropIn.match(/^TimeoutStartSec=(\d+)$/m);
    expect(match, 'the drop-in adds an ExecStartPre, so it must also raise TimeoutStartSec').not.toBeNull();
    // Measured 2026-08-26: bundle-host.sh takes 36.61s warm. That figure is a FLOOR
    // (n=1, warm cache, unloaded box), so require real headroom over it rather than a fit.
    expect(Number(match![1])).toBeGreaterThanOrEqual(180);
  });

  it('spells paths with systemd %h rather than a build-box home directory', () => {
    // A hardcoded /home/<user>/ path here is shipped source and reds the identity-lint
    // leg of green-checkpoint, freezing main fleet-wide. %h is already the convention in
    // this directory (llm-test-nightly.service, marketplace-api.service).
    expect(dropIn).not.toMatch(/\/home\/[a-z]/i);
    expect(dropIn).toContain('ExecStartPre=%h/');
  });

  it('documents the canonical symlink installation without restarting services', () => {
    expect(readme).toContain('papercup-bg-host.service.d/95-bundled-entry.conf');
    expect(readme).toContain('papercup-bg-host.service.d/98-dependency-generation-root.conf');
    expect(readme).toContain('sudo install -d -m 0750');
    expect(readme).toMatch(/mkdir -p ~\/\.config\/systemd\/user\/papercup-bg-host\.service\.d/);
    expect(readme).toMatch(/ln -sfn "\$\(pwd\)\/papercup-bg-host\.service\.d\/95-bundled-entry\.conf"/);
    expect(readme).toContain('systemctl --user daemon-reload');
    expect(readme).toMatch(/Do not restart bg-host or\s+papercusp-server as part of this installation/);
  });

  it('pins the standalone systemd gateway as the single Linux :8788 authority (EI-22359055031706978)', () => {
    expect(gatewayAuthorityDropIn).toContain('[Service]');
    expect(gatewayAuthorityDropIn).toContain('Environment=PAPERCUSP_GATEWAY_SUPERVISE=0');
    expect(gatewayAuthorityDropIn).toContain('papercup-inference-gateway.service');
    expect(gatewayAuthorityDropIn).toContain('EADDRINUSE');
    expect(gatewayAuthorityDropIn).not.toMatch(/\/home\/[a-z]/i);

    expect(readme).toContain('97-gateway-systemd-authority.conf');
    expect(readme).toMatch(
      /ln -sfn "\$\(pwd\)\/papercup-bg-host\.service\.d\/97-gateway-systemd-authority\.conf"/,
    );
    expect(readme).toContain('PAPERCUSP_GATEWAY_SUPERVISE=0');
    expect(readme).toContain('papercup-inference-gateway.service');
  });

  it('disables the packaged server fallback only through the shared Linux host override', () => {
    expect(packagedServerGatewayAuthorityDropIn).toContain('[Service]');
    expect(packagedServerGatewayAuthorityDropIn).toContain('Environment=PAPERCUSP_GATEWAY_SUPERVISE=0');
    expect(packagedServerGatewayAuthorityDropIn).toContain('papercup-inference-gateway.service');
    expect(packagedServerGatewayAuthorityDropIn).toContain('without the dedicated gateway');

    expect(readme).toContain('papercusp-server.service.d/97-gateway-systemd-authority.conf');
    expect(readme).toMatch(/mkdir -p ~\/\.config\/systemd\/user\/papercusp-server\.service\.d/);
    expect(readme).toMatch(
      /ln -sfn "\$\(pwd\)\/papercusp-server\.service\.d\/97-gateway-systemd-authority\.conf"/,
    );
    expect(readme).toMatch(/Do not restart bg-host or\s+papercusp-server/);
  });
});
