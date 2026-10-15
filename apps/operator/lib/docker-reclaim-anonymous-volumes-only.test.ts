/**
 * docker-reclaim-anonymous-volumes-only.test.ts — RECURRENCE GUARD for WI-39305.
 *
 * The condition: this host's root filesystem (which holds BOTH $HOME and PGDATA)
 * filled to 99% while three successive CRITICAL work-items were filed and closed
 * by nobody — WI-38595 (90%), WI-38973 (95%), WI-39305 (99%). /var/lib/docker had
 * grown to 158 GiB, ~84 GiB of it pure garbage (build cache with zero active
 * references, unreferenced images, orphaned ANONYMOUS volumes) that no mechanism
 * ever reclaimed. `disk-space-alarm.ts` detects the condition but is read-only by
 * construction, so it had no actor on the other end (EI-20092729937622838:
 * 318 unheeded firings over 8 days under 1% free).
 *
 * `bin/reclaim-docker-disk.sh` is that actor. This guard exists because the
 * OBVIOUS way to write it is catastrophic:
 *
 *   `docker volume prune` deletes every DANGLING volume, NAMED ONES INCLUDED.
 *
 * On the measured box, 11 of the 154 dangling volumes were named persistent
 * application data — bytebot_postgres_data and the bytebot-pool_bytebot-N-postgres-data
 * set, automaker-*, sheets-clone*, litellm_litellm_pgdata, sidestage_*, the whole
 * restart_* family (odoo / plane / twenty / outline / chatwoot / vikunja / appflowy),
 * stalwart-agenticmail-data. They were "dangling" only because their services
 * happened not to be running at that moment. A blanket prune destroys all of them,
 * silently, and the loss is not recoverable from anywhere on this box.
 *
 * So the script removes ONLY volumes whose name is a Docker ANONYMOUS id
 * (^[0-9a-f]{64}$), which are ephemeral by definition. Anything a human or a
 * compose file NAMED is never a candidate.
 *
 * Test shape: a `readFileSync` wiring guard for the safety-critical prohibitions
 * (same rationale as the sibling live-federation-gate-sidecar-reaper.test.ts — the
 * script drives a real docker daemon, so its safety wiring can only be asserted at
 * the wiring site), PLUS a BEHAVIORAL check of the safety-critical half: the
 * classification pattern is extracted FROM THE SCRIPT ITSELF and evaluated against
 * real volume names observed on this box. That is what makes the guard falsifiable
 * rather than decorative — weakening the regex (say to `.*`, or dropping an anchor)
 * fails the behavioral assertions even though every text assertion still passes.
 *
 * PROBE_SCRIPT overrides the subject path so falsifiability can be proven against a
 * mutated COPY outside the tree (CLAUDE.md mutation-probe tier 2) — never by
 * mutating the shared tree, where the git-sync sweep can commit the mutant.
 */
import { existsSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(__dirname, '../../../bin/reclaim-docker-disk.sh');

const src = readFileSync(SCRIPT, 'utf8');

/** Strip comment-only lines so prohibitions match EXECUTABLE shell, not the docblock
 *  (which deliberately names `docker volume prune` in order to forbid it). */
const code = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** Real NAMED volumes observed on this box 2026-08-15 — every one of these was
 *  simultaneously "dangling" and irreplaceable persistent application data. */
const REAL_NAMED_VOLUMES = [
  'bytebot_postgres_data',
  'bytebot-pool_bytebot-1-postgres-data',
  'bytebot-pool_bytebot-10-postgres-data',
  'automaker-data',
  'automaker-opencode-cache',
  'sheets-clone_api-data',
  'sheets-clone--production_api-data-prod',
  'litellm_litellm_pgdata',
  'sidestage_sidestage-postgres',
  'sidestage-data_sidestage-typesense-data',
  'restart_odoo-pg-data',
  'restart_plane-minio-data',
  'restart_twenty-db-data',
  'restart_outline-postgres-data',
  'stalwart-agenticmail-data',
  'papercusp-scratch-f-autofit-001-1-hsdbnh1j_api-data',
];

/** Real ANONYMOUS volume ids (64 lowercase hex) — Docker's own ephemeral naming. */
const REAL_ANONYMOUS_VOLUMES = [
  'f078706e316d7446c30979d5defa2d2274f89615faff4cca3c28f9405b218ae2',
  'fc224d92d5a2b53a64498d192ccd6aacf2e99a614449689bdf7150b1bc531e33',
  'fef1e1bcfb858c5358d8f50fd13aca56b4ba63b88873a2edd0f51cdddf18d8cf',
];

/** Pull the anonymous-id pattern out of the script's own grep, so the behavioral
 *  assertions below test the SHIPPING classifier rather than a copy of it. */
function extractAnonymousPattern(): RegExp {
  const m = code.match(/grep\s+-E\s+'(\^[^']*\$)'/);
  if (!m) throw new Error('no anchored `grep -E` volume-classification pattern found in script');
  return new RegExp(m[1]);
}

describe('WI-39305 — docker reclaim removes ONLY anonymous volumes', () => {
  it('the script exists and is executable', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  // ── The safety-critical prohibitions ───────────────────────────────────────

  it('NEVER invokes the blanket `docker volume prune`', () => {
    // This is the whole reason the guard exists: `volume prune` cannot distinguish
    // an orphaned testcontainer volume from bytebot_postgres_data.
    expect(code).not.toMatch(/volume\s+prune/);
  });

  it('NEVER invokes `docker system prune`', () => {
    // `system prune --volumes` is `volume prune` wearing a hat; the bare form also
    // reaches containers and networks this script has no business touching.
    expect(code).not.toMatch(/system\s+prune/);
  });

  it('removes volumes only via an explicitly anchored anonymous-id filter', () => {
    expect(code).toMatch(/volume\s+rm/);
    expect(code).toMatch(/grep\s+-E\s+'\^\[0-9a-f\]\{64\}\$'/);
  });

  it('age-filters cache and image sweeps so an in-flight build is never disturbed', () => {
    expect(code).toMatch(/builder\s+prune[^\n]*--filter\s+"until=/);
    expect(code).toMatch(/image\s+prune[^\n]*--filter\s+"until=/);
  });

  it('never fails its timer (no `set -e`), so a wedged daemon is a logged no-op', () => {
    expect(code).toMatch(/^set -uo pipefail$/m);
    expect(code).not.toMatch(/^set -euo/m);
  });

  // ── The behavioral half — the classifier as it actually ships ──────────────

  describe('the shipping classifier', () => {
    const pattern = extractAnonymousPattern();

    it.each(REAL_NAMED_VOLUMES)('SPARES the named volume %s', (name) => {
      expect(pattern.test(name)).toBe(false);
    });

    it.each(REAL_ANONYMOUS_VOLUMES)('claims the anonymous volume %s', (id) => {
      expect(pattern.test(id)).toBe(true);
    });

    it('is anchored at BOTH ends — a named volume that merely CONTAINS a hex run is spared', () => {
      // Without the anchors, `prefix-<64 hex>-suffix` would match and a named
      // volume built around a hash would be destroyed.
      const hex = REAL_ANONYMOUS_VOLUMES[0];
      expect(pattern.test(`backup-${hex}`)).toBe(false);
      expect(pattern.test(`${hex}-keep`)).toBe(false);
    });

    it('rejects near-misses that are not Docker anonymous ids', () => {
      expect(pattern.test('f078706e')).toBe(false); // too short
      expect(pattern.test('F078706E316D7446C30979D5DEFA2D2274F89615FAFF4CCA3C28F9405B218AE2')).toBe(false); // uppercase
      expect(pattern.test(`${REAL_ANONYMOUS_VOLUMES[0]}a`)).toBe(false); // too long
    });
  });
});

describe('Podman stores use the existing guarded image policy', () => {
  const runFixture = (overrides: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'reclaim-container-fixture-'));
    const log = join(root, 'calls');
    const executable = (name: string, body: string) => writeFileSync(join(root, name), '#!/bin/bash\n' + body, { mode: 0o755 });
    try {
      executable('docker', 'exit 1\n');
      executable('sudo', '[[ "$1" == "-n" ]] && shift\nexport STORE=rootful\nexec "$@"\n');
      executable('podman', 'if [[ "$1" == "info" ]]; then exit "${PODMAN_DOWN:-0}"; fi\nprintf "%s %s\\n" "${STORE:-rootless}" "$*" >>"$FIXTURE_LOG"\n');
      executable('df', 'if [[ "$*" == *--output=avail* ]]; then echo "${FIXTURE_AVAILABLE:-100000000000}"; else echo 100000000000; fi\n');
      const output = execFileSync('bash', [SCRIPT], { encoding: 'utf8', timeout: 5000,
        env: { ...process.env, PATH: root + ':' + process.env.PATH, FIXTURE_LOG: log,
          DRY_RUN: '0', SKIP_IMAGES: '0', IMAGE_MAX_AGE: '168h', RECLAIM_MIN_FREE_PCT: '101', ...overrides } });
      return { output, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
    } finally { rmSync(root, { recursive: true, force: true }); }
  };

  it('collects only old unused images in both Podman stores even when Docker is unavailable', () => {
    const result = runFixture();
    expect(result.calls).toEqual([
      'rootless image prune -af --filter until=168h',
      'rootful image prune -af --filter until=168h',
    ]);
    expect(result.calls.join('\n')).not.toMatch(/--external|volume|container|system/);
  });

  it('previews both stores without invoking either prune', () => {
    const result = runFixture({ DRY_RUN: '1' });
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('DRY_RUN would run: podman image prune -af --filter until=168h');
    expect(result.output).toContain('DRY_RUN would run: sudo -n podman image prune -af --filter until=168h');
  });

  it('honors the existing image-sweep kill switch for both Podman stores', () => {
    expect(runFixture({ SKIP_IMAGES: '1' }).calls).toEqual([]);
  });

  it('collects only twelve-hour unused images below the shared write reserve', () => {
    const result = runFixture({ FIXTURE_AVAILABLE: '1000000000', IMAGE_MAX_AGE: '' });
    expect(result.calls).toEqual([
      'rootless image prune -af --filter until=12h',
      'rootful image prune -af --filter until=12h',
    ]);
    expect(result.calls.join('\n')).not.toMatch(/--external|volume|container|system/);
  });

  it('keeps an explicit operator age override during critical pressure', () => {
    const result = runFixture({ FIXTURE_AVAILABLE: '1000000000', IMAGE_MAX_AGE: '72h' });
    expect(result.calls.every(call => call.endsWith('until=72h'))).toBe(true);
  });

  it('keeps the ordinary retention window when free space is at the reserve', () => {
    const result = runFixture({ FIXTURE_AVAILABLE: '2000000000', IMAGE_MAX_AGE: '' });
    expect(result.calls.every(call => call.endsWith('until=168h'))).toBe(true);
  });

  it('keeps the kill switch effective during critical pressure', () => {
    expect(runFixture({ FIXTURE_AVAILABLE: '1000000000', IMAGE_MAX_AGE: '', SKIP_IMAGES: '1' }).calls).toEqual([]);
  });

  it('leaves unavailable Podman stores alone', () => {
    const result = runFixture({ PODMAN_DOWN: '1' });
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('podman-rootful unreachable');
  });
});
