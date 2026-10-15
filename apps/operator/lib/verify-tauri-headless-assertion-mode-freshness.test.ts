/**
 * verify-tauri-headless-assertion-mode-freshness.test.ts — the RECURRENCE GUARD
 * for EI-19444780917356384.
 *
 * The bug: scripts/verify-tauri-headless.sh freezes immutable SPA and operator
 * host artifacts at boot (EI-10364) and correctly warns that an edit made AFTER
 * boot will never be picked up, pointing the caller at
 * `$VERIFY_TAURI_FRESHNESS_CHECK` (EI-17134). Its containment sentinel originally
 * searched only the SPA, so a backend-only change that was present in the frozen
 * host bundle was rejected as stale.
 * That variable was exported ONLY on the `--boot-only` path. In assertion mode
 * (`verify-tauri-headless.sh -- <cmd>`) the assertion command ran with
 * VERIFY_TAURI_PID/PORT/DISPLAY/LOG/POLL exported but NOT the freshness check —
 * so the documented guard died with `VERIFY_TAURI_FRESHNESS_CHECK: unbound
 * variable` in exactly the mode used for one-shot CI-style verification.
 *
 * Why it was expensive: the failure is silent and points the WRONG WAY. A run
 * against a stale snapshot produces a clean, well-formed, CONFIDENT "your fix
 * does not work" — indistinguishable from a genuine failure. Measured: an edit
 * built at 10:58:00 against a snapshot frozen ~10:57 burned a ~6-minute
 * boot+drive cycle and came within one manual grep of sending an agent off to
 * "re-fix" already-correct code.
 *
 * The original fix has two halves, and this suite pins BOTH:
 *   1. export the guard paths on the COMMON path so assertion mode can reach
 *      them (the positional assertions below are what make this real — an export
 *      that drifts back inside the --boot-only branch re-creates the bug while
 *      still matching a naive `toContain`);
 *   2. RUN the guard before exec'ing the assertion command, since a guard the
 *      caller must remember to invoke is the same class of gap the wrapper
 *      itself exists to close.
 *
 * Host-aware containment is pinned here too: SPA remains the default scope,
 * while `VERIFY_TAURI_ASSERT_SNAPSHOT_SCOPE=host` checks the immutable plain-node
 * host bundle without weakening the existing SPA requirement.
 *
 * A readFileSync text guard is the right shape here: the script boots a real
 * Tauri/Xvfb stack, so its env wiring can only be asserted at the wiring site
 * (same rationale as verify-tauri-headless-spa-isolation.test.ts).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

/** Index of the `--boot-only` branch: everything before it runs in BOTH modes. */
const bootOnlyBranchIdx = src.indexOf('if [ "${1:-}" = "--boot-only" ]; then');
/** Index of the final exec of the caller's assertion command. */
const assertionExecIdx = src.lastIndexOf('log "running assertion command: $*"');
const containmentIdx = src.indexOf('SNAPSHOT_NEEDLE="${VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS:-}"');
const containmentEndIdx = src.indexOf('verify_assertion_input_integrity || exit $?', containmentIdx);
const containmentBlock = src.slice(containmentIdx, containmentEndIdx);

describe('snapshot marker admission before database and native boot', () => {
  function probe(scope: 'spa' | 'host', marker: string, content?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'snapshot-marker-preflight.'));
    try {
      const artifact = join(dir, 'bundle.js');
      if (content !== undefined) writeFileSync(artifact, content);
      const start = src.indexOf('verify_snapshot_marker_preflight() {');
      const end = src.indexOf('\n\nvh_run_step snapshot-containment-preflight', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return spawnSync('bash', ['-c', [
        'set -eu', 'log() { :; }', src.slice(start, end),
        'verify_snapshot_marker_preflight',
      ].join('\n')], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, SNAPSHOT_SCOPE: scope, SPA_DIST: dir,
          OPERATOR_HOST_BUNDLE: artifact, VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS: marker },
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('rejects a runtime-concatenated DOM id while accepting an emitted statement literal', () => {
    const bundle = '({"data-testid":`cupboard-kind-tab-${k}`,"aria-label":"Identity usage statement"})';
    const absent = probe('spa', 'cupboard-kind-tab-statements', bundle);
    expect(absent.status, absent.stderr).toBe(3);
    expect(absent.stderr).toContain('runtime-concatenated DOM id');
    const present = probe('spa', 'Identity usage statement', bundle);
    expect(present.status, present.stderr).toBe(0);
  });

  it.each(['spa', 'host'] as const)('refuses a missing artifact in %s scope', scope => {
    const result = probe(scope, 'missing-marker');
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain('refusing before database/native boot');
  });

  it('checks the frozen host artifact for backend markers', () => {
    const result = probe('host', 'backend-acceptance-marker', 'const x="backend-acceptance-marker";');
    expect(result.status, result.stderr).toBe(0);
  });

  it('does not require a marker when none was requested', () => {
    const result = probe('spa', '');
    expect(result.status, result.stderr).toBe(0);
  });

  it('runs admission before database preparation and native launch', () => {
    const preflight = src.indexOf('vh_run_step snapshot-containment-preflight verify_snapshot_marker_preflight || exit $?');
    const database = src.indexOf('vh_step isolated-database-prepare');
    const native = src.indexOf('vh_step "launch-attempt-$BOOT_ATTEMPTS"');
    expect(preflight).toBeGreaterThan(-1);
    expect(database).toBeGreaterThan(preflight);
    expect(native).toBeGreaterThan(database);
  });
});

describe('EI-19444780917356384 — the freshness guard is reachable in assertion (`--`) mode', () => {
  it('is the right script, with both anchor sites present (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    // Both anchors must exist, or every positional assertion below is vacuous.
    expect(bootOnlyBranchIdx).toBeGreaterThan(-1);
    expect(assertionExecIdx).toBeGreaterThan(-1);
    // The guard being pinned must itself still exist.
    expect(src).toContain('check-freshness.sh');
  });

  it('exports VERIFY_TAURI_FRESHNESS_CHECK on the COMMON path, not only under --boot-only', () => {
    const exportIdx = src.indexOf('export VERIFY_TAURI_FRESHNESS_CHECK="$WORK/check-freshness.sh"');
    expect(exportIdx).toBeGreaterThan(-1);
    // THE bug: the export sat inside the --boot-only branch, so assertion mode
    // never saw it. Being textually present is not enough — it must be reached
    // before the branch that returns control to a --boot-only caller.
    expect(exportIdx).toBeLessThan(bootOnlyBranchIdx);
  });

  it('exports VERIFY_TAURI_SPA_DIST (the frozen bundle) on the common path too', () => {
    // The decisive question is "is MY change in the code under test?", which is
    // answered by grepping the FROZEN bundle — unreachable without this path.
    const exportIdx = src.indexOf('export VERIFY_TAURI_SPA_DIST="$SPA_DIST"');
    expect(exportIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeLessThan(bootOnlyBranchIdx);
  });

  it('validates the containment scope before allocating the expensive verifier', () => {
    const scopeIdx = src.indexOf('SNAPSHOT_SCOPE="${VERIFY_TAURI_ASSERT_SNAPSHOT_SCOPE:-spa}"');
    const workIdx = src.indexOf('WORK="$(mktemp -d');

    expect(scopeIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeLessThan(workIdx);
    expect(src).toContain("VERIFY_TAURI_ASSERT_SNAPSHOT_SCOPE must be 'spa' or 'host'");
    expect(src).toContain('spa|host');
  });

  it('RUNS the freshness check before the assertion command, not merely advertises it', () => {
    const runIdx = src.indexOf('! bash "$VERIFY_TAURI_FRESHNESS_CHECK"');
    expect(runIdx).toBeGreaterThan(-1);
    // Must fire BEFORE control is handed to the caller's command — a warning
    // printed afterwards cannot stop a false negative from being reported.
    expect(runIdx).toBeLessThan(assertionExecIdx);
  });

  it('fails FAST, with a distinct exit code, when the frozen bundle lacks the caller"s change', () => {
    const needleIdx = src.indexOf('VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS');
    expect(needleIdx).toBeGreaterThan(-1);
    // Greps the FROZEN snapshot ($SPA_DIST), never the shared dist the fleet
    // watcher rewrites — grepping the shared dist would answer the wrong
    // question and re-create the very false negative this guard exists to stop.
    expect(src).toMatch(/grep -rqF -- "\$SNAPSHOT_NEEDLE" "\$SPA_DIST"/);
    // Exit 3 keeps "your change isn't in the bundle" distinguishable from an
    // ordinary assertion failure (1) and a usage error (2).
    expect(src).toMatch(/exit 3/);
    // And it must abort BEFORE the assertion runs, otherwise the confident
    // wrong answer is still emitted.
    expect(needleIdx).toBeLessThan(assertionExecIdx);
  });

  it('keeps SPA containment as the default and does not weaken its frozen-bundle check', () => {
    expect(containmentIdx).toBeGreaterThan(-1);
    expect(containmentEndIdx).toBeGreaterThan(containmentIdx);
    expect(containmentBlock).toContain('case "$SNAPSHOT_SCOPE" in');
    const spaIdx = containmentBlock.indexOf('    spa)');
    const hostIdx = containmentBlock.indexOf('    host)');
    expect(spaIdx).toBeGreaterThan(-1);
    expect(hostIdx).toBeGreaterThan(spaIdx);
    const spaBlock = containmentBlock.slice(spaIdx, hostIdx);
    expect(spaBlock).toMatch(/grep -rqF -- "\$SNAPSHOT_NEEDLE" "\$SPA_DIST"/);
    expect(spaBlock).toContain('run froze NO SPA');
  });

  it('supports backend-only containment against the immutable operator host bundle', () => {
    const hostIdx = containmentBlock.indexOf('    host)');
    expect(hostIdx).toBeGreaterThan(-1);
    const hostBlock = containmentBlock.slice(hostIdx);
    expect(hostBlock).toContain('VERIFY_TAURI_ASSERT_SNAPSHOT_SCOPE=host');
    expect(hostBlock).toContain('OPERATOR_HOST_BUNDLE');
    expect(hostBlock).toMatch(/grep -qF -- "\$SNAPSHOT_NEEDLE" "\$OPERATOR_HOST_BUNDLE"/);
    expect(hostBlock).toContain('no frozen operator host bundle');
    expect(hostBlock).toContain('exit 3');
    expect(hostBlock).not.toContain('run froze NO SPA');
  });

  it('keeps the drift warning ADVISORY (a peer"s rebuild must not fail a valid run)', () => {
    // Drift means the shared dist moved, which on this box happens constantly
    // because of other agents' edits — it does NOT prove the caller's change is
    // missing. Hard-failing on drift would block valid runs, so the drift path
    // must warn (log) rather than exit. Pinned by asserting the drift branch
    // body carries no bare exit.
    // Bound the actual branch. Later independent source-integrity checks may
    // correctly refuse a run; they are not part of the advisory drift warning.
    const driftIdx = src.indexOf('! bash "$VERIFY_TAURI_FRESHNESS_CHECK"');
    const driftEndIdx = src.indexOf('\nfi\n', driftIdx);
    expect(driftIdx).toBeGreaterThan(-1);
    expect(driftEndIdx).toBeGreaterThan(driftIdx);
    expect(driftEndIdx).toBeLessThan(assertionExecIdx);
    const driftBlock = src.slice(driftIdx, driftEndIdx);
    expect(driftBlock).toContain('DRIFT');
    expect(driftBlock).not.toMatch(/^\s*exit \d/m);
    // …and it must point at the decisive check rather than dead-ending.
    expect(driftBlock).toContain('VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS');
  });

  it('ignores unrelated generated docs churn in the default freshness scope', () => {
    // apps/operator-vite/dist/docs is a separately rebuilt static site. A
    // pagefind refresh must not invalidate an ordinary operator-SPA run whose
    // frozen app bundle did not change.
    const helperStart = src.indexOf('cat > "$WORK/check-freshness.sh" <<FRESH');
    const helperEnd = src.indexOf('\nFRESH\n', helperStart);
    const helper = src.slice(helperStart, helperEnd);
    expect(helper).toContain('VERIFY_TAURI_FRESHNESS_INCLUDE_DOCS');
    const defaultStart = helper.indexOf('  0|');
    const defaultBranch = helper.slice(defaultStart, helper.indexOf('  *)', defaultStart));
    expect(defaultBranch).toContain('-path "\\$SHARED_SPA_DIST/docs" -prune -o');
    expect(defaultBranch).toContain('-newer "\\$SPA_DIST/.frozen-at" -type f -print');
  });

  it('supports an explicit docs-inclusive freshness check for docs UI verification', () => {
    const helperStart = src.indexOf('cat > "$WORK/check-freshness.sh" <<FRESH');
    const helperEnd = src.indexOf('\nFRESH\n', helperStart);
    const helper = src.slice(helperStart, helperEnd);
    const docsStart = helper.indexOf('  1)');
    const docsBranch = helper.slice(docsStart, helper.indexOf('  0|', docsStart));
    expect(docsBranch).toContain(
      'CHANGED="\\$(find "\\$SHARED_SPA_DIST" -newer "\\$SPA_DIST/.frozen-at" -type f',
    );
    expect(helper).toContain('must be 0 or 1');
  });
});
