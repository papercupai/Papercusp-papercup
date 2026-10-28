import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * WI-2145397 — recurrence guard for a whole bug CLASS, not one script.
 *
 * WHAT WENT WRONG. WI-2145150 relocated the host Postgres dumps from
 * /mnt/data/Backup/db-dumps to /mnt/backup/db-dumps by setting
 * `Environment=PAPERCUSP_HOST_PG_DUMP_DIR=...` on TWO systemd units. Every other
 * consumer resolves that same variable with a hardcoded fallback to the abandoned
 * path — and a systemd user unit inherits no interactive shell environment. So any
 * unit that runs such a script WITHOUT setting the variable silently reads a
 * directory nothing writes any more.
 *
 * papercup-backup-health.service was exactly that: no Environment= line, so the
 * backup-freshness probe tailed a db-backup.log frozen on "backup FAILED". The alarm
 * could never clear (no OK can be appended to a dead file) and the probe was
 * simultaneously blind to any REAL failure. Three agents spent a false CRITICAL
 * triage on it inside thirty minutes while the backup was in fact healthy.
 *
 * WHY A TEST AND NOT A COMMENT. The failure is silent in both directions and looks
 * exactly like success: the unit runs, exits 0, and reports a confident verdict about
 * the wrong directory. Nothing fails until a human reads a stale number. This is the
 * cheapest place to make it loud.
 *
 * THE INVARIANT. If a unit's ExecStart runs a script that resolves
 * PAPERCUSP_HOST_PG_DUMP_DIR, that unit must set PAPERCUSP_HOST_PG_DUMP_DIR.
 * A per-unit Environment= keeps the unit correct on its own, independent of
 * ~/.config/environment.d/90-papercusp-backup-dump-dir.conf (which sets it for every
 * user unit but is host state, not version-controlled, and absent on a fresh checkout).
 */

const ENV_VAR = 'PAPERCUSP_HOST_PG_DUMP_DIR';
const EXPECTED_DUMP_DIR = '/mnt/cold-a/Backup/db-dumps';
const DUMP_UNITS = [
  'papercusp-db-backup.service',
  'papercup-backup-health.service',
  'kopia-healthcheck.service',
  'kopia-snapshots.service',
  'papercusp-db-backup-alert.service',
];
const DUMP_READER_SCRIPTS = [
  '../systemd/papercusp-db-backup.sh',
  '../papercup-backup-health-check.sh',
  '../systemd/kopia-snapshot-all.sh',
  '../systemd/kopia-healthcheck.sh',
  '../systemd/kopia-backup-alert.sh',
];
// Overridable so falsifiability can be proven against a COPY outside the tree, rather
// than by mutating the shared checkout (which git-sync would commit mid-probe).
const SYSTEMD_DIR =
  process.env.BACKUP_ENV_CONTRACT_SYSTEMD_DIR ?? resolve(__dirname, '..', 'systemd');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Resolve a systemd ExecStart token to a real file, honouring %h. */
function resolveScript(token: string): string | null {
  const candidates = token.startsWith('%h/')
    ? [resolve(homedir(), token.slice(3))]
    : token.startsWith('/')
      ? [token]
      : [resolve(REPO_ROOT, token), resolve(SYSTEMD_DIR, token)];
  return candidates.find((c) => existsSync(c)) ?? null;
}

interface Pair {
  unit: string;
  script: string;
  unitSetsVar: boolean;
}

function scanUnits(): { pairs: Pair[]; unitsScanned: number } {
  const units = readdirSync(SYSTEMD_DIR).filter((f) => f.endsWith('.service'));
  const pairs: Pair[] = [];

  for (const unit of units) {
    const body = readFileSync(resolve(SYSTEMD_DIR, unit), 'utf8');

    // A unit may legitimately set the variable via Environment= or EnvironmentFile=.
    const unitSetsVar =
      new RegExp(`^Environment=(?:"?)${ENV_VAR}=`, 'm').test(body) ||
      new RegExp(`^EnvironmentFile=.*`, 'm').test(body);

    // EVERY script token across EVERY ExecStart line — a wrapped ExecStart such as
    // `kopia-backup-guard.sh --mode scheduled -- papercusp-db-backup.sh` carries the real
    // consumer in a LATER token, so stopping at the first one under-reports.
    const execStarts = body
      .split('\n')
      .filter((l) => l.startsWith('ExecStart='))
      .map((l) => l.replace(/^ExecStart=[-+!@]*/, ''));

    for (const line of execStarts) {
      for (const token of line.split(/\s+/).filter((t) => t.endsWith('.sh'))) {
        const script = resolveScript(token);
        if (!script) continue;
        if (!readFileSync(script, 'utf8').includes(ENV_VAR)) continue;
        pairs.push({ unit, script, unitSetsVar });
      }
    }
  }

  return { pairs, unitsScanned: units.length };
}

describe(`systemd units that read ${ENV_VAR}`, () => {
  it('every unit running a dump-dir-reading script sets the variable itself', () => {
    const { pairs } = scanUnits();

    const violations = pairs
      .filter((p) => !p.unitSetsVar)
      .map((p) => `${p.unit} runs ${p.script.replace(REPO_ROOT + '/', '')} which reads ${ENV_VAR}, but the unit never sets it`);

    expect(violations).toEqual([]);
  });

  it('pins each producer, reader, and Kopia source fallback to one cold-a path', () => {
    for (const scriptPath of DUMP_READER_SCRIPTS) {
      const source = readFileSync(resolve(SYSTEMD_DIR, scriptPath), 'utf8');
      expect(source, scriptPath).toContain(`${ENV_VAR}:-${EXPECTED_DUMP_DIR}`);
    }
    const coverageReader = readFileSync(resolve(REPO_ROOT, 'packages/backup/src/host-dump-coverage.ts'), 'utf8');
    expect(coverageReader).toContain(`DEFAULT_HOST_PG_DUMP_DIR = '${EXPECTED_DUMP_DIR}'`);
  });

  it('sets the same dump path explicitly on every systemd consumer', () => {
    for (const unit of DUMP_UNITS) {
      const body = readFileSync(resolve(SYSTEMD_DIR, unit), 'utf8');
      expect(body, unit).toContain(`Environment=${ENV_VAR}=${EXPECTED_DUMP_DIR}`);
    }
  });

  it('requires the dedicated dump mount for scheduled writers and Kopia freshness checks', () => {
    const mountedConsumers = [
      'papercusp-db-backup.service',
      'kopia-snapshots.service',
      'kopia-healthcheck.service',
    ];

    for (const unit of mountedConsumers) {
      const body = readFileSync(resolve(SYSTEMD_DIR, unit), 'utf8');
      expect(body, unit).toContain(`RequiresMountsFor=${EXPECTED_DUMP_DIR}`);
    }
  });

  /**
   * CALIBRATION — without this, a parser regression (a changed ExecStart shape, a
   * renamed directory, a %h path that stops resolving) makes the assertion above pass
   * by examining NOTHING, and a vacuous pass is indistinguishable from real safety.
   * That is the same class of false green this whole guard exists to catch, so the
   * guard must not be able to commit it.
   */
  it('actually examined real units and found real consumers (anti-vacuous-pass)', () => {
    const { pairs, unitsScanned } = scanUnits();

    expect(unitsScanned).toBeGreaterThan(5);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs.map((p) => p.unit)).toContain('papercup-backup-health.service');
    expect(pairs.map((p) => p.unit)).toContain('papercusp-db-backup.service');
  });
});

describe('systemd backup install recipe', () => {
  it('installs the tracked alert at the path its failure unit executes', () => {
    const readme = readFileSync(resolve(SYSTEMD_DIR, 'README.md'), 'utf8');
    const alertUnit = readFileSync(resolve(SYSTEMD_DIR, 'papercusp-db-backup-alert.service'), 'utf8');
    const backupUnit = readFileSync(resolve(SYSTEMD_DIR, 'papercusp-db-backup.service'), 'utf8');

    expect(readme).toContain('ln -sf "$(pwd)/kopia-backup-alert.sh" ~/.config/kopia/backup-alert.sh');
    expect(readme).not.toMatch(/recreate\s+`~\/\.config\/kopia\/db-backup\.sh`/i);
    expect(alertUnit).toContain('ExecStart=%h/.config/kopia/backup-alert.sh');
    expect(backupUnit).toContain('papercusp-db-backup.sh');
    expect(existsSync(resolve(SYSTEMD_DIR, 'kopia-backup-alert.sh'))).toBe(true);
    expect(existsSync(resolve(SYSTEMD_DIR, 'papercusp-db-backup.sh'))).toBe(true);
  });
});
