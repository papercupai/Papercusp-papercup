/**
 * release-config tests — the env seam that per-hive-git-and-release-gate (P-006/P-008)
 * generalizes through. The green-checkpoint/deploy SUBPROCESS resolves its roots, branches
 * and green command from `releaseConfig()`, which reads PAPERCUSP_* env. The per-hive handler
 * (release-actions.ts → resolveCheckpointRouting → hive-release-env.ts) hands that env overlay
 * to the subprocess, so THIS boundary is where a hive's identity becomes its paths.
 *
 * P-008 acceptance, proved end-to-end at the releaseConfig() boundary:
 *   - papercusp (no overlay / default env) → the LEGACY ../papercup-release root plus a
 *     PER-ROOT ../<basename>-checkpoint checkout (2026-07-02: the old fixed
 *     `papercup-checkpoint` name let two lineages race one checkout — see release-config.ts),
 *     main/staging, npm run test:affected.
 *   - a per-hive overlay env (the shape resolveHiveReleaseEnv emits) → the namespaced
 *     <slug>-release / <slug>-checkpoint roots, the hive's branches + green command.
 *   - an explicit caller override beats env (the operator-host PAPERCUSP_INTEGRATION_ROOT must
 *     not defeat the release lib's own throwaway-repo test overrides — release-config.ts comment).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  releaseConfig,
  describeIntegrationRoot,
  integrationRootEvidence,
  databaseEvidence,
  assertGateableIntegrationRoot,
  isNonGateableCheckout,
} from './release-config';

/** Every PAPERCUSP_* key releaseConfig() reads — cleared so the host's live overlay (the
 *  :3070 operator exports PAPERCUSP_INTEGRATION_ROOT etc.) can't make these assertions flap. */
const RELEASE_ENV_KEYS = [
  'PAPERCUSP_INTEGRATION_ROOT',
  'PAPERCUSP_RELEASE_ROOT',
  'PAPERCUSP_CHECKPOINT_ROOT',
  'PAPERCUSP_RELEASE_REF',
  'PAPERCUSP_INTEGRATION_BRANCH',
  'PAPERCUSP_SYSTEMD_UNIT',
  'PAPERCUSP_BACKGROUND_SYSTEMD_UNIT',
  'PAPERCUSP_HEALTH_URL',
  'PAPERCUSP_GREEN_CMD',
  'PAPERCUSP_CHECKPOINT_LOG_DIR',
  'PAPERCUSP_HONO_PORT',
  'PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE',
] as const;

describe('releaseConfig — per-hive env seam (P-008)', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of RELEASE_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of RELEASE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('papercusp default (no overlay) → LEGACY papercup-release + per-root <basename>-checkpoint + main/staging', () => {
    const cfg = releaseConfig();
    // releaseRoot keeps the legacy fixed name — the live papercusp-dev-api.service points at
    // it. checkpointRoot is per-root (disposable checkout, safe to namespace) so two
    // lineages sharing a parent dir can never race one checkout.
    expect(basename(cfg.releaseRoot)).toBe('papercup-release');
    expect(basename(cfg.checkpointRoot)).toBe(`${basename(cfg.integrationRoot)}-checkpoint`);
    expect(cfg.releaseRef).toBe('main');
    expect(cfg.integrationBranch).toBe('staging');
    expect(cfg.systemdUnit).toBe('papercusp-dev-api.service');
    expect(cfg.backgroundSystemdUnit).toBe('papercusp-bg-host.service');
    expect(cfg.greenCmd).toBe('npm run test:related');
    expect(cfg.greenCheckpointCapacityMode).toBe('shared');
  });

  it('keeps the background-unit override, including an explicit empty disable value', () => {
    process.env.PAPERCUSP_BACKGROUND_SYSTEMD_UNIT = 'papercusp-bg-host-test.service';
    expect(releaseConfig().backgroundSystemdUnit).toBe('papercusp-bg-host-test.service');

    process.env.PAPERCUSP_BACKGROUND_SYSTEMD_UNIT = '';
    expect(releaseConfig().backgroundSystemdUnit).toBe('');
    expect(releaseConfig({ backgroundSystemdUnit: 'papercusp-bg-host-override.service' }).backgroundSystemdUnit).toBe(
      'papercusp-bg-host-override.service',
    );
  });

  it('selects reserved capacity only when explicitly configured', () => {
    process.env.PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE = 'reserved';
    expect(releaseConfig().greenCheckpointCapacityMode).toBe('reserved');
  });

  it('rejects an invalid capacity mode instead of silently oversubscribing the shared host', () => {
    process.env.PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE = 'dedicated';
    expect(() => releaseConfig()).toThrow(
      /PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE must be "shared" or "reserved".*dedicated/,
    );
  });

  it('two integration roots under ONE parent → DISTINCT checkpoint roots (cross-lineage race fix, 2026-07-02)', () => {
    // The real incident pair: the live papercusp root and the retired papercup root both
    // live under papercupai-workspace/. With the old fixed `papercup-checkpoint` default
    // both resolved to the SAME checkout; the stale lineage (resurrected via .env.local on
    // :3070) ran git checkout there mid-suite of a live papercusp run.
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/ws/papercusp';
    const live = releaseConfig();
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/ws/papercup';
    const retired = releaseConfig();
    expect(live.checkpointRoot).toBe('/ws/papercusp-checkpoint');
    // The retired root's basename still derives the LEGACY name — a straggler run of that
    // lineage keeps its existing dir rather than colliding with papercusp's new one.
    expect(retired.checkpointRoot).toBe('/ws/papercup-checkpoint');
    expect(live.checkpointRoot).not.toBe(retired.checkpointRoot);
  });

  it('per-hive overlay env (resolveHiveReleaseEnv shape) → NAMESPACED <slug>-* roots + the hive branches/greenCmd', () => {
    // Exactly the env overlay hive-release-env.ts emits for a regular coding hive.
    const hiveHome = '/tmp/hives/oddsmith-hive';
    process.env.PAPERCUSP_INTEGRATION_ROOT = hiveHome;
    process.env.PAPERCUSP_RELEASE_ROOT = '/tmp/hives/oddsmith-hive-release';
    process.env.PAPERCUSP_CHECKPOINT_ROOT = '/tmp/hives/oddsmith-hive-checkpoint';
    process.env.PAPERCUSP_INTEGRATION_BRANCH = 'staging';
    process.env.PAPERCUSP_RELEASE_REF = 'main';
    process.env.PAPERCUSP_GREEN_CMD = 'npm run test:ci';

    const cfg = releaseConfig();
    expect(cfg.integrationRoot).toBe(hiveHome);
    expect(cfg.releaseRoot).toBe('/tmp/hives/oddsmith-hive-release');
    expect(cfg.checkpointRoot).toBe('/tmp/hives/oddsmith-hive-checkpoint');
    expect(cfg.releaseRef).toBe('main');
    expect(cfg.integrationBranch).toBe('staging');
    expect(cfg.greenCmd).toBe('npm run test:ci');
    // The per-hive roots are genuinely DISTINCT from the legacy papercup-* roots — a hive's
    // green-checkpoint can never touch papercusp's checkout (the isolation the gate relies on).
    expect(basename(cfg.releaseRoot)).not.toBe('papercup-release');
    expect(basename(cfg.checkpointRoot)).not.toBe('papercup-checkpoint');
  });

  it('explicit caller override beats env (operator-host overlay must not defeat throwaway-repo test overrides)', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/tmp/hives/oddsmith-hive';
    process.env.PAPERCUSP_GREEN_CMD = 'npm run test:ci';
    process.env.PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE = 'reserved';
    const cfg = releaseConfig({
      integrationRoot: '/tmp/throwaway',
      greenCmd: 'echo green',
      greenCheckpointCapacityMode: 'shared',
    });
    expect(cfg.integrationRoot).toBe('/tmp/throwaway');
    expect(cfg.greenCmd).toBe('echo green');
    expect(cfg.greenCheckpointCapacityMode).toBe('shared');
  });
});

/**
 * WI-38241 — the SECOND integrationRoot resolver.
 *
 * release-actions.ts guards the routine dispatcher's `cwd`-relative fallback. THIS file is the
 * resolver green-checkpoint itself consumes, and its fallback (`scriptRepoRoot()`) is different:
 * it resolves to whichever repo the SCRIPT FILE lives in. Safer than cwd — run staging's copy,
 * get staging — but still silently wrong in the one case that matters: run papercup-release's
 * copy with no env and the gate judges the DEPLOY ARTIFACT, with no error and no log line
 * naming the tree.
 *
 * These take env/overrides as ARGUMENTS, so they need no process.env mutation and cannot flap
 * against the host's live overlay.
 */
describe('WI-38241: integration-root provenance + the gate-only refusal', () => {
  const WS = '/home/dev/papercupai-workspace';

  it('reports the SOURCE, not just the value — provenance is the half that settles an argument', () => {
    expect(describeIntegrationRoot({ integrationRoot: `${WS}/a` }, {})).toEqual({
      root: `${WS}/a`,
      source: 'override',
    });
    expect(describeIntegrationRoot({}, { PAPERCUSP_INTEGRATION_ROOT: `${WS}/b` })).toEqual({
      root: `${WS}/b`,
      source: 'PAPERCUSP_INTEGRATION_ROOT',
    });
  });

  it('preserves the documented precedence: override beats env', () => {
    expect(
      describeIntegrationRoot(
        { integrationRoot: `${WS}/override` },
        { PAPERCUSP_INTEGRATION_ROOT: `${WS}/env` },
      ),
    ).toEqual({ root: `${WS}/override`, source: 'override' });
  });

  it('the evidence line carries BOTH the root and how it was chosen', () => {
    const line = integrationRootEvidence({}, { PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercusp` });
    expect(line).toContain(`${WS}/papercusp`);
    expect(line).toContain('source=PAPERCUSP_INTEGRATION_ROOT');
    // must not mislabel an env root as derived — that sends a reader hunting the wrong bug
    expect(line).not.toContain('script-repo');
  });

  it('REFUSES a DERIVED release/checkpoint checkout, naming the path and the remedy', () => {
    for (const bad of ['papercup-release', 'papercusp-release', 'papercup-checkpoint', 'papercusp-checkpoint']) {
      expect(() => assertGateableIntegrationRoot({}, {}, () => `${WS}/${bad}`)).toThrow(
        /refusing to gate/,
      );
    }
    let msg = '';
    try {
      assertGateableIntegrationRoot({}, {}, () => `${WS}/papercup-release`);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain(`${WS}/papercup-release`); // the resolved path, not just a basename
    expect(msg).toContain('PAPERCUSP_INTEGRATION_ROOT'); // how to fix it
  });

  it('the predicate is falsifiable in BOTH directions against the real set', () => {
    expect(isNonGateableCheckout(`${WS}/papercup-release`)).toBe(true);
    expect(isNonGateableCheckout(`${WS}/papercusp-checkpoint`)).toBe(true);
    // and must NOT swallow the working tree, or the gate refuses everything
    expect(isNonGateableCheckout(`${WS}/papercusp`)).toBe(false);
    expect(isNonGateableCheckout(`${WS}/papercup`)).toBe(false);
    // a substring match would wrongly reject this; the check is on the basename
    expect(isNonGateableCheckout(`${WS}/papercup-release-notes`)).toBe(false);
  });

  it('an EXPLICITLY NAMED release checkout is ALLOWED — the guard is for the unselected case', () => {
    // Someone who names a root has stated an intent; refusing it would break legitimate
    // throwaway-checkout testing, which is what release-config's override seam exists for.
    expect(() =>
      assertGateableIntegrationRoot({ integrationRoot: `${WS}/papercup-release` }, {}),
    ).not.toThrow();
    expect(() =>
      assertGateableIntegrationRoot({}, { PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercup-release` }),
    ).not.toThrow();
  });

  it('a NORMAL derived root is allowed (the guard must not refuse the working path)', () => {
    expect(() =>
      assertGateableIntegrationRoot({ integrationRoot: `${WS}/papercusp` }, {}),
    ).not.toThrow();
  });

  it('SOURCE, not just path, decides the refusal — the same bad root passes when NAMED', () => {
    const bad = `${WS}/papercup-release`;
    // derived -> refused
    expect(() => assertGateableIntegrationRoot({}, {}, () => bad)).toThrow(/refusing to gate/);
    // same path, explicitly selected -> allowed. This pair is the whole design: the guard is
    // about NOBODY HAVING CHOSEN the root, not about the path being spelled a certain way.
    expect(() => assertGateableIntegrationRoot({ integrationRoot: bad }, {}, () => bad)).not.toThrow();
    expect(() =>
      assertGateableIntegrationRoot({}, { PAPERCUSP_INTEGRATION_ROOT: bad }, () => bad),
    ).not.toThrow();
  });

  it('the evidence line reports the DERIVED branch honestly too', () => {
    const line = integrationRootEvidence({}, {}, () => `${WS}/papercusp`);
    expect(line).toContain(`${WS}/papercusp`);
    expect(line).toContain('source=script-repo');
  });

  /* WI-38250 — this line is emitted by TWO independent implementations: this one, and
   * packages/operator-core/lib/harness/routines/release-actions.ts's same-named
   * integrationRootEvidence(). They have DIFFERENT resolvers and different fallbacks
   * (script-repo here, cwd-fallback there), yet both used to return a byte-identical
   * `integration root: <root> (source=<source>)`, emitted through the same
   * orchestratorStdoutTag() prefix. `source` does not separate them in the case that
   * matters: production sets PAPERCUSP_INTEGRATION_ROOT explicitly, so BOTH print
   * `source=PAPERCUSP_INTEGRATION_ROOT` and the log cannot say which resolver spoke.
   *
   * That is not cosmetic. The two can DISAGREE (different fallbacks), and a log showing
   * two identically-formatted lines with different roots and no attribution is strictly
   * worse than no line — it is the same unanswerable-from-the-log question that made the
   * 2026-08-12 freeze cost hours. Pin the emitter tag on BOTH sides; the sibling assertion
   * lives in release-actions.test.ts. */
  it('names its EMITTER, so the log can attribute the root to the resolver that chose it', () => {
    const env = { PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercusp` };
    const line = integrationRootEvidence({}, env);
    expect(line).toContain('emitter=gate-cli');
    // ...and must NOT claim the operator-core dispatcher's identity. If this ever passes,
    // the two emitters have converged again and attribution is silently lost.
    expect(line).not.toContain('emitter=routine-dispatcher');
  });

  /* The assertion above is only meaningful if an UNTAGGED line would fail it. A permanent
   * wrong-implementation control proves that, without mutating the shared tree — a probe
   * that edits the real file races git-sync's sweep, which commits whatever is on disk when
   * it ticks, so the mutant lands committed even when nothing goes wrong. */
  it('the emitter pin is FALSIFIABLE — the pre-WI-38250 format fails it', () => {
    const untagged = (root: string, source: string) => `integration root: ${root} (source=${source})`;
    const legacy = untagged(`${WS}/papercusp`, 'PAPERCUSP_INTEGRATION_ROOT');
    // the exact string both emitters used to return: indistinguishable, and it must FAIL
    expect(legacy).not.toContain('emitter=');
    // calibration — the control is only a control if the REAL subject passes the same check
    expect(integrationRootEvidence({}, { PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercusp` })).toContain(
      'emitter=',
    );
  });

  /* The gate wiring lives in green-checkpoint.ts's `if (require.main === module)` CLI block,
   * which by construction NEVER runs under vitest — so all 320 of that file's tests can pass
   * while the guard is not wired at all. Pin the call sites in source. */
  /* Matches STATEMENTS, not bare substrings. The first draft of this pin used
   * indexOf('releaseConfig()') and failed against the real file — because the COMMENT
   * explaining the guard mentions releaseConfig(), and the comment sorts before the call.
   * A prose mention silently defeated the check. Anything looking for code in source text
   * has to be shaped like the code, or documentation becomes a source of false verdicts. */
  const wiredIntoGateCli = (src: string): boolean => {
    const cli = src.indexOf('if (require.main === module)');
    if (cli === -1) return false;
    const body = src.slice(cli);
    const at = (re: RegExp) => body.search(re);
    const evidence = at(/console\.log\([^\n]*integrationRootEvidence\(\)/);
    const assertion = at(/^[ \t]*assertGateableIntegrationRoot\(\);/m);
    const cfg = at(/^[ \t]*const cfg = releaseConfig\(\);/m);
    if (evidence === -1 || assertion === -1 || cfg === -1) return false;
    // both must precede the config the gate then runs on, or they report after the fact
    return evidence < cfg && assertion < cfg;
  };

  it('is WIRED into the green-checkpoint CLI, before the config it gates on', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      fileURLToPath(new URL('./green-checkpoint.ts', import.meta.url)),
      'utf8',
    );
    expect(wiredIntoGateCli(src), 'green-checkpoint CLI must log + assert the root').toBe(true);
  });

  it('...and that wiring pin is falsifiable', () => {
    const wired = [
      'if (require.main === module) {',
      '  console.log(`x ${integrationRootEvidence()}`);',
      '  assertGateableIntegrationRoot();',
      '  const cfg = releaseConfig();',
      '}',
    ].join('\n');
    // calibration first: the real shape must pass, or the refusals below prove nothing
    expect(wiredIntoGateCli(wired)).toBe(true);

    // guard absent entirely
    expect(
      wiredIntoGateCli('if (require.main === module) {\n  const cfg = releaseConfig();\n}'),
    ).toBe(false);
    // logged but not ENFORCED — evidence without a refusal still gates the wrong tree
    expect(wiredIntoGateCli(wired.replace('  assertGateableIntegrationRoot();\n', ''))).toBe(false);
    // enforced but never LOGGED — a silent pass leaves the judged tree unrecorded
    expect(
      wiredIntoGateCli(wired.replace(/ {2}console\.log\(`x \$\{integrationRootEvidence\(\)\}`\);\n/, '')),
    ).toBe(false);
    // ordered AFTER the config the gate runs on — too late to be a guard
    expect(
      wiredIntoGateCli(
        [
          'if (require.main === module) {',
          '  const cfg = releaseConfig();',
          '  console.log(`x ${integrationRootEvidence()}`);',
          '  assertGateableIntegrationRoot();',
          '}',
        ].join('\n'),
      ),
    ).toBe(false);
    // A COMMENT MENTIONING THE CALLS IS NOT WIRING. This is the case that actually bit:
    // the first draft of the pin passed on prose and had to be rewritten.
    expect(
      wiredIntoGateCli(
        [
          'if (require.main === module) {',
          '  // calls integrationRootEvidence() and assertGateableIntegrationRoot() someday',
          '  const cfg = releaseConfig();',
          '}',
        ].join('\n'),
      ),
    ).toBe(false);
  });
});

/**
 * EI-20709645463022690 — the gate subprocess inherits the spawning operator's environment, so a
 * pot's suite can dial the papercusp operator's database and report every one of the pot's tables
 * as missing. That renders as "schema drift — 39 table(s) missing": a well-formed verdict about
 * the WRONG database, indistinguishable in the log from real drift, because the checkpoint log
 * never states the DSN at all.
 *
 * These pin the same two properties `integrationRootEvidence` above pins, for the same reason:
 * the line must SAY the right thing, and it must actually be CALLED. A builder nobody calls is
 * exactly the silent-but-well-formed failure this whole item is about.
 */
describe('databaseEvidence — which database is this gate run dialing', () => {
  it('names the endpoint from DATABASE_URL, redacted to host:port/dbname', () => {
    const line = databaseEvidence({
      DATABASE_URL: 'postgres://test:test@localhost:32787/papercusp_gym_loop_ab12cd',
    });
    // the measured real-world shape: a transient gym-loop DB carrying 0 of the pot's tables
    expect(line).toContain('localhost:32787/papercusp_gym_loop_ab12cd');
    expect(line).toContain('source=DATABASE_URL');
    expect(line).toContain('emitter=gate-cli');
  });

  /* THE LOAD-BEARING ONE. A run log is not a place to put a password, and this line is printed
   * unconditionally on every gate run into an artifact many agents read. */
  it('NEVER echoes the password, for any credential shape', () => {
    for (const dsn of [
      'postgres://user:hunter2@db.internal:5432/papercusp',
      'postgresql://admin:p%40ss%2Fw0rd@10.0.0.4:5432/prod',
      'postgres://:onlypass@host/db',
    ]) {
      const line = databaseEvidence({ DATABASE_URL: dsn });
      expect(line, `leaked a credential from ${dsn}`).not.toMatch(/hunter2|p%40ss|onlypass/);
      expect(line).not.toContain('@');
    }
  });

  /* An unparseable value may itself BE the secret — so the fallback must be a coarse label, never
   * an echo of the input. */
  it('does not echo an unparseable DATABASE_URL', () => {
    const line = databaseEvidence({ DATABASE_URL: 'not-a-url-but-maybe-a-secret' });
    expect(line).toContain('<unparseable-url>');
    expect(line).not.toContain('not-a-url-but-maybe-a-secret');
  });

  /* libpq reads these when no URL is set; they select a database just as effectively. An evidence
   * line that ignored them would report "unset" about a run that is very much connected. */
  it('falls back to the PG* variables when DATABASE_URL is unset', () => {
    const line = databaseEvidence({
      PGHOST: 'db.internal',
      PGPORT: '5433',
      PGDATABASE: 'sidestage',
    });
    expect(line).toContain('db.internal:5433/sidestage');
    expect(line).toContain('source=PG*');
  });

  /* Not the boring case: the child then falls back to libpq's own defaults (local socket, $USER as
   * the database name), which is its own class of dialing-the-wrong-database. */
  it('reports <unset> when nothing selects a database', () => {
    const line = databaseEvidence({});
    expect(line).toContain('<unset>');
    expect(line).toContain('source=none');
    expect(line).toContain('discovery file');
  });

  /* WI-10006055: the :3070 operator pins its DB with HARNESS_ADMIN_DATABASE_URL, not DATABASE_URL.
   * Reading only DATABASE_URL printed `<unset>` for a correctly pinned run, hiding the one datum
   * that separates "pinned" from "falls through to another install's discovery-file DB". */
  it('honours the db package precedence: HARNESS_ADMIN_DATABASE_URL > HARNESS_DATABASE_URL > DATABASE_URL', () => {
    const admin = databaseEvidence({
      HARNESS_ADMIN_DATABASE_URL: 'postgresql://harness_admin:s3cret@localhost:5432/papercusp',
      DATABASE_URL: 'postgresql://other:pw@localhost:24680/papercusp',
    });
    expect(admin).toContain('localhost:5432/papercusp');
    expect(admin).toContain('source=HARNESS_ADMIN_DATABASE_URL');
    expect(admin).not.toContain('s3cret');
    expect(databaseEvidence({ HARNESS_DATABASE_URL: 'postgresql://a:b@h:1/d' })).toContain('source=HARNESS_DATABASE_URL');
    expect(databaseEvidence({ DATABASE_URL: 'postgresql://a:b@h:1/d' })).toContain('source=DATABASE_URL');
  });

  /* The pin is only a pin if the pre-fix behaviour fails it. Before this change the gate emitted
   * NO database line whatsoever — a grep of the checkpoint log for the DSN returned zero hits. */
  it('the evidence pin is FALSIFIABLE — emitting nothing, or a raw DSN, fails it', () => {
    const dsn = 'postgres://test:test@localhost:32787/papercusp_gym_loop_ab12cd';
    // (a) the pre-fix world: no line at all
    expect('').not.toContain('database:');
    // (b) the naive fix: echo the DSN straight into the log
    expect(dsn).toContain('test:test@');
    // calibration — the control is only a control if the REAL subject passes the same checks
    const real = databaseEvidence({ DATABASE_URL: dsn });
    expect(real).toContain('database:');
    expect(real).not.toContain('test:test@');
  });

  /* Same construction as the integration-root wiring pin above, and for the same reason: the CLI
   * block never runs under vitest, so every behavioural test here can pass while the builder is
   * not wired at all. Match STATEMENTS, not bare substrings — a comment mentioning the call is
   * not the call. */
  const dbWiredIntoGateCli = (src: string): boolean => {
    const cli = src.indexOf('if (require.main === module)');
    if (cli === -1) return false;
    const body = src.slice(cli);
    const evidence = body.search(/console\.log\([^\n]*databaseEvidence\(\)/);
    const cfg = body.search(/^[ \t]*const cfg = releaseConfig\(\);/m);
    if (evidence === -1 || cfg === -1) return false;
    // must precede the config the gate then runs on, or it reports after the fact
    return evidence < cfg;
  };

  it('tags the emitter it was given, so the two call sites are distinguishable', () => {
    const env = { DATABASE_URL: 'postgres://u:p@h:5432/d' };
    expect(databaseEvidence(env)).toContain('emitter=gate-cli');
    expect(databaseEvidence(env, 'gate-run')).toContain('emitter=gate-run');
    // every branch must carry the tag, not just the DATABASE_URL one
    expect(databaseEvidence({}, 'gate-run')).toContain('emitter=gate-run');
    expect(databaseEvidence({ PGHOST: 'h' }, 'gate-run')).toContain('emitter=gate-run');
  });

  it('is WIRED into the green-checkpoint CLI, before the config it gates on', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      fileURLToPath(new URL('./green-checkpoint.ts', import.meta.url)),
      'utf8',
    );
    expect(dbWiredIntoGateCli(src), 'green-checkpoint CLI must log the database it will dial').toBe(
      true,
    );
  });

  /* THE LOAD-BEARING WIRING PIN, and the one this item actually turns on.
   *
   * The CLI pin above is NOT sufficient, and believing it was is the mistake this test exists to
   * prevent: green-checkpoint.ts's own comment at the gate-run emitter records that "the CLI
   * entrypoint's console line is visible on manual runs but is not captured by scheduler/routine
   * invocations" (WI-38250) — and scheduler runs are exactly the ones that red-pin a pot
   * unattended. A database line wired ONLY into the CLI block would pass every other test in this
   * file and still emit nothing into the persisted checkpoint transcript a responder reads.
   * Verified against the real artifact: the 2026-08-17T13:16Z sidestage log carries exactly one
   * "integration root:" line and it is emitter=gate-run, not gate-cli. */
  const dbWiredIntoGateRun = (src: string): boolean => {
    // the orchestrator-logger emission, tagged gate-run — deps.log, not console.log
    return /deps\.log\(\s*databaseEvidence\([^)]*["']gate-run["']\s*\)/.test(src);
  };

  it('is WIRED into the ORCHESTRATOR transcript, which is what scheduled runs persist', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      fileURLToPath(new URL('./green-checkpoint.ts', import.meta.url)),
      'utf8',
    );
    expect(
      dbWiredIntoGateRun(src),
      'a CLI-only database line is invisible to scheduled gate runs (WI-38250)',
    ).toBe(true);
  });

  it('...and the orchestrator wiring pin is falsifiable', () => {
    // calibration first: the real shape must pass, or the refusals below prove nothing
    expect(dbWiredIntoGateRun('deps.log(databaseEvidence(process.env, "gate-run"));')).toBe(true);
    // the exact bug this pin guards: emitted, but only from the CLI block
    expect(dbWiredIntoGateRun('console.log(`x ${databaseEvidence()}`);')).toBe(false);
    // emitted through the orchestrator but MIS-TAGGED, so the transcript lies about its source
    expect(dbWiredIntoGateRun('deps.log(databaseEvidence(process.env));')).toBe(false);
    // absent entirely
    expect(dbWiredIntoGateRun('deps.log(`integration root: x (emitter=gate-run)`);')).toBe(false);
  });

  it('...and that wiring pin is falsifiable', () => {
    const wired = [
      'if (require.main === module) {',
      '  console.log(`x ${databaseEvidence()}`);',
      '  const cfg = releaseConfig();',
      '}',
    ].join('\n');
    // calibration first: the real shape must pass, or the refusals below prove nothing
    expect(dbWiredIntoGateCli(wired)).toBe(true);
    // never logged — the exact pre-fix state this item is about
    expect(
      dbWiredIntoGateCli('if (require.main === module) {\n  const cfg = releaseConfig();\n}'),
    ).toBe(false);
    // logged AFTER the config the gate runs on — too late to explain the run it describes
    expect(
      dbWiredIntoGateCli(
        [
          'if (require.main === module) {',
          '  const cfg = releaseConfig();',
          '  console.log(`x ${databaseEvidence()}`);',
          '}',
        ].join('\n'),
      ),
    ).toBe(false);
    // A COMMENT MENTIONING THE CALL IS NOT WIRING — the case that bit the sibling pin.
    expect(
      dbWiredIntoGateCli(
        [
          'if (require.main === module) {',
          '  // someday this will call databaseEvidence() properly',
          '  const cfg = releaseConfig();',
          '}',
        ].join('\n'),
      ),
    ).toBe(false);
  });
});
