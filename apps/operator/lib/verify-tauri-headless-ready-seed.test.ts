/**
 * verify-tauri-headless-ready-seed.test.ts — the guard for EI-20191599988350937.
 *
 * The gap: VERIFY_TAURI_ISOLATED_DB=1 correctly boots a fresh migrated database,
 * which makes the run a genuine FIRST-RUN install. The root route sends a
 * first-run install to the onboarding tutorial, so every post-onboarding route
 * assertion under isolation measured the tutorial instead of the route under
 * test. Proving such a route then required either a second read-only run
 * against the SHARED live DB (giving up isolation, and write-unsafe) or
 * hand-driving the whole onboarding flow.
 *
 * The fix: an OPT-IN ready-app seed. VERIFY_TAURI_ISOLATED_SEED=ready marks
 * onboarding complete and nothing else; `fresh` stays the default so the
 * existing fresh-install mode is unchanged.
 *
 * Two properties carry the safety of this feature and are asserted below:
 *
 *   1. `ready` is REFUSED without VERIFY_TAURI_ISOLATED_DB=1. The seed is a
 *      WRITE, and in the default (shared) mode its target is the owner's real
 *      live database — the exact incident class VERIFY_TAURI_ISOLATED_DB was
 *      introduced to prevent (EI-10387). It must not be reachable through this
 *      knob.
 *   2. The seed asserts its READ-BACK, not the PATCH status. A 200 that did not
 *      persist still leaves an unseeded app, and the caller would then get a
 *      healthy-looking shell that silently redirects to onboarding — the
 *      false-green shape the origin-health gate (EI-13218) already exists to
 *      prevent one layer up.
 *
 * A readFileSync text guard is the right shape here for the same reason its
 * sibling verify-tauri-headless-isolated-db.test.ts gives: the script boots a
 * real Tauri/Xvfb/Postgres stack, so its wiring can only be asserted at the
 * wiring site. The behavioural half of this feature (that the seeded run lands
 * on /adv while a fresh run lands on first-run) was verified live, as a
 * control/treatment pair, on the work-item.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY
// outside the tree (same convention as verify-tauri-headless-bind-retry.test.ts),
// so this guard's falsifiability can be proven without ever mutating the shared
// checkout — where a git-sync sweep could commit the mutant mid-probe.
const SCRIPT =
  process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const readySeedStart = src.indexOf('if [ "$ISOLATED_SEED" = "ready" ]; then');
const readySeedEnd = src.indexOf('export VERIFY_TAURI_SEED="$ISOLATED_SEED"', readySeedStart);
const readySeedBlock = src.slice(readySeedStart, readySeedEnd);

describe('EI-20191599988350937 — opt-in ready-app seed for isolated verification', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('EI-20191599988350937');
  });

  it('is opt-in and defaults to fresh, leaving the existing mode unchanged', () => {
    expect(src).toMatch(/ISOLATED_SEED="\$\{VERIFY_TAURI_ISOLATED_SEED:-fresh\}"/);
  });

  it('accepts only fresh|ready and refuses anything else', () => {
    expect(src).toMatch(/case "\$ISOLATED_SEED" in\s*\n\s*fresh\|ready\)/);
    expect(src).toMatch(/VERIFY_TAURI_ISOLATED_SEED must be 'fresh' or 'ready'/);
  });

  /**
   * The safety rail. Without this the knob is a documented route to writing
   * onboarding state into the owner's live database.
   */
  it('REFUSES ready without VERIFY_TAURI_ISOLATED_DB=1 (never writes the shared live DB)', () => {
    expect(src).toMatch(
      /if \[ "\$ISOLATED_SEED" = "ready" \] && \[ "\$\{VERIFY_TAURI_ISOLATED_DB:-0\}" != "1" \]; then/,
    );
    expect(src).toMatch(/VERIFY_TAURI_ISOLATED_SEED=ready requires VERIFY_TAURI_ISOLATED_DB=1/);
    // The refusal must explain the stake, not just the rule.
    expect(src).toMatch(/lands on the SHARED live database/);
  });

  it('validates the seed BEFORE the expensive boot, so misuse costs no build', () => {
    const seedParse = src.indexOf('ISOLATED_SEED="${VERIFY_TAURI_ISOLATED_SEED:-fresh}"');
    const xvfbBoot = src.indexOf('boot Xvfb (isolated, headless');
    const pgBoot = src.indexOf('boot a genuinely isolated, throwaway embedded Postgres');
    expect(seedParse).toBeGreaterThan(-1);
    expect(xvfbBoot).toBeGreaterThan(-1);
    expect(pgBoot).toBeGreaterThan(-1);
    expect(seedParse).toBeLessThan(xvfbBoot);
    expect(seedParse).toBeLessThan(pgBoot);
  });

  it('seeds through the app’s own idempotent endpoint, not hand-written SQL', () => {
    expect(src).toMatch(/PATCH[\s\S]{0,400}\/api\/desktop\/setup-wizard-state/);
    expect(src).toContain('finished_at');
    // A raw INSERT/UPDATE against the state table would drift from the storage
    // shape the endpoint owns; the seed must never reach for one.
    expect(src).not.toMatch(/INSERT INTO[\s\S]{0,200}setup_wizard_state/i);
    expect(src).not.toMatch(/UPDATE[\s\S]{0,200}setup_wizard_state[\s\S]{0,200}SET/i);
  });

  it('asserts the READ-BACK, so a non-persisted 200 cannot pass as seeded', () => {
    // The gate the root route consults is a non-empty finished_at STRING.
    expect(src).toMatch(/"finishedAt"\[\[:space:\]\]\*:\[\[:space:\]\]\*"\[\^"\]\+"/);
    expect(src).toMatch(/could not mark onboarding complete/);
  });

  it('uses a bounded owned-origin HTTP transaction instead of the bridge client’s 5s eval', () => {
    expect(readySeedStart).toBeGreaterThan(-1);
    expect(readySeedEnd).toBeGreaterThan(readySeedStart);
    expect(readySeedBlock).toContain(
      'SEED_URL="$(verify_tauri_dev_url "$DEV_PORT")/api/desktop/setup-wizard-state"',
    );
    expect(readySeedBlock).toContain('const timeoutMs = 30_000;');
    expect(readySeedBlock).toContain('AbortSignal.timeout(timeoutMs)');
    expect(readySeedBlock).not.toContain('$VERIFY_TAURI_AGENT_TOOLS_BIN');
  });

  it('provisions the isolated operator principal before marking the app ready', () => {
    const provisionAt = readySeedBlock.indexOf("new URL('/api/agent-mcp/provision', url)");
    const wizardAt = readySeedBlock.indexOf("body: JSON.stringify({ finished_at: stamp })");
    expect(provisionAt).toBeGreaterThan(-1);
    expect(wizardAt).toBeGreaterThan(provisionAt);
    expect(readySeedBlock).toContain("entry?.name === 'operator'");
    expect(readySeedBlock).toContain('!provision.ok || !operatorPrincipal');
  });

  it('retains PATCH/GET status and body evidence instead of replacing a failure with an empty result', () => {
    expect(readySeedBlock).toContain('provisionStatus: provision.status');
    expect(readySeedBlock).toContain('provisionBody: clip(provisionBody)');
    expect(readySeedBlock).toContain('patchStatus: patch.status');
    expect(readySeedBlock).toContain('getStatus: read.status');
    expect(readySeedBlock).toContain('patchBody: clip(patchBody)');
    expect(readySeedBlock).toContain('getBody: clip(getBody)');
    expect(readySeedBlock).not.toContain('|| SEED_JSON=""');
    expect(readySeedBlock).toContain('PATCH/GET status, body, or transport evidence: $SEED_JSON');
  });

  it('fails the run rather than handing back a shell that still redirects', () => {
    expect(readySeedBlock).toMatch(/Refusing to hand back a shell/);
    expect(readySeedBlock.slice(0, readySeedBlock.indexOf('log "ready-app seed VERIFIED'))).toMatch(
      /exit 1/,
    );
  });

  it('tells the assertion command and a --boot-only caller which seed ran', () => {
    expect(src).toMatch(/export VERIFY_TAURI_SEED="\$ISOLATED_SEED"/);
    expect(src).toMatch(/printf 'VERIFY_TAURI_SEED=%q\\n' "\$ISOLATED_SEED"/);
  });

  it('documents the knob, its default, and why it is gated', () => {
    expect(src).toMatch(/VERIFY_TAURI_ISOLATED_SEED\s+which app STATE the isolated run starts from/);
    expect(src).toMatch(/Default `fresh`/);
    expect(src).toMatch(/REQUIRES VERIFY_TAURI_ISOLATED_DB=1 and is/);
  });
});

describe('Quick Access native shortcut seed', () => {
  const validate = src.match(/^validate_isolated_shortcut\(\) \{[\s\S]*?^\}/m)?.[0];
  const seed = src.match(/^seed_isolated_shortcut\(\) \{[\s\S]*?^\}/m)?.[0];

  function run(shortcut: string, isolated = '1', wrongHome = false) {
    expect(validate).toBeTruthy();
    expect(seed).toBeTruthy();
    const root = mkdtempSync(resolve(tmpdir(), 'quick-access-seed-test-'));
    const home = resolve(root, 'owner-home');
    const privateHome = resolve(root, 'papercusp-home');
    mkdirSync(home); mkdirSync(privateHome);
    const ownerChoice = resolve(home, 'docs-search-shortcut.json');
    writeFileSync(ownerChoice, '{"accelerator":null}');
    try {
      const result = spawnSync('bash', ['-c', [
        'set -eu', validate, seed,
        'WORK="$1"; ISOLATED_HOME="$WORK/papercusp-home"; ISOLATED_DB="$VERIFY_TAURI_ISOLATED_DB"',
        ...(wrongHome ? ['ISOLATED_HOME="$HOME"'] : []),
        'validate_isolated_shortcut && seed_isolated_shortcut',
      ].join('\n'), 'seed-test', root], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, VERIFY_TAURI_ISOLATED_DB: isolated, VERIFY_TAURI_ISOLATED_SHORTCUT: shortcut },
      });
      expect(readFileSync(ownerChoice, 'utf8')).toBe('{"accelerator":null}');
      const path = resolve(privateHome, 'docs-search-shortcut.json');
      return { status: result.status, choice: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('does not seed a choice by default', () => {
    expect(run('')).toEqual({ status: 0, choice: null });
  });
  it('uses only the private home and the real persisted payload', () => {
    expect(run('CmdOrCtrl+Shift+K')).toEqual({ status: 0, choice: { accelerator: 'CmdOrCtrl+Shift+K' } });
  });
  it('refuses a shortcut with a shared database or non-private home', () => {
    expect(run('CmdOrCtrl+Shift+K', '0')).toEqual({ status: 2, choice: null });
    expect(run('CmdOrCtrl+Shift+K', '1', true)).toEqual({ status: 2, choice: null });
  });
  it('refuses arbitrary accelerators before the expensive boot', () => {
    expect(run('not-a-preset')).toEqual({ status: 2, choice: null });
    expect(src.indexOf('validate_isolated_shortcut || exit $?')).toBeLessThan(src.indexOf('boot Xvfb (isolated, headless'));
  });
});
