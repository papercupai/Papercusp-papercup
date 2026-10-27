import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * WI-2146225 — the dump directory's .kopiaignore rules are TREE-OWNED.
 *
 * WHY THIS EXISTS. The `*.tmp` rule and the tier-2 exclusion both used to live
 * ONLY as lines in an untracked .kopiaignore sitting in the dump directory,
 * owned by nobody. When WI-2145150 relocated the dumps to /mnt/backup/db-dumps
 * the file did not travel, the protection silently ceased to exist, and nothing
 * anywhere raised an error. That is the same failure shape as this work-item's
 * other defects: state kept outside the tree does not survive a move.
 *
 * WHY IT MATTERS *MORE* FOR TIER 2 THAN FOR *.tmp. A missing `*.tmp` rule costs
 * a pointless upload of a half-written dump. A missing `<db>-transcript` rule
 * costs ~73G of high-churn duplicate data uploaded into a repo whose volume
 * capacity is the exact wall that caused the relocation in the first place —
 * and it fails in the EXPENSIVE direction while every status surface stays
 * green, because a sweep that starts covering more files looks like success.
 *
 * THE ASSERTION THAT IS LOAD-BEARING is the negative one: `<db>-state` must
 * NEVER be excluded. Tier 1 is the ENROLLED tier (ratified on WI-2146225:
 * "enroll tier 1, never tier 2"), and it is the only backup of current papercusp
 * state once the undifferentiated dump is retired. A stray exclusion there would
 * silently return the system to zero coverage — the precise condition this
 * work-item was filed to repair — while the run still exits 0.
 *
 * These execute the REAL function body lifted from the shipped script, not a
 * reimplementation of it, so a change to the script's logic is what the guard
 * sees.
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) rather than by mutating the shared
// checkout, which git-sync would commit mid-probe.
const SCRIPT =
  process.env.BACKUP_KOPIAIGNORE_SCRIPT ??
  resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');

const src = readFileSync(SCRIPT, 'utf8');

/**
 * Lift the real `ensure_kopiaignore_rule` body out of the shipped script and run
 * it against a throwaway dump dir. Extraction is anchored on the function name
 * and asserted below, so a rename surfaces as a failing positive control rather
 * than as a vacuously passing test.
 */
function extractFn(): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith('ensure_kopiaignore_rule() {'));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) return '';
  return lines.slice(start, end + 1).join('\n');
}

/** Run the real function against `dump`, once per rule in `calls`. */
function runProvisioning(dump: string, calls: Array<[string, string?]>): string {
  const fn = extractFn();
  const invocations = calls
    .map(([rule, why]) => `ensure_kopiaignore_rule ${JSON.stringify(rule)} ${JSON.stringify(why ?? '')}`)
    .join('\n');
  const harness = [
    'set -eu',
    `DUMP=${JSON.stringify(dump)}`,
    'log() { :; }',
    fn,
    invocations,
  ].join('\n');
  execFileSync('bash', ['-c', harness], { stdio: 'pipe' });
  return readFileSync(join(dump, '.kopiaignore'), 'utf8');
}

describe('papercusp-db-backup.sh .kopiaignore provisioning (WI-2146225)', () => {
  it('is the script we think it is, and the function is extractable (positive control)', () => {
    // A guard whose subject silently became the wrong file — or whose extraction
    // silently returned nothing — passes vacuously. Fail loudly instead.
    expect(src).toContain('ensure_kopiaignore_rule');
    const fn = extractFn();
    expect(fn).not.toBe('');
    expect(fn).toContain('grep -qxF');
  });

  it('provisions a missing .kopiaignore with the *.tmp rule', () => {
    const dump = mkdtempSync(join(tmpdir(), 'kopiaignore-'));
    try {
      const out = runProvisioning(dump, [['*.tmp', 'in-progress dumps']]);
      expect(out.split('\n')).toContain('*.tmp');
    } finally {
      rmSync(dump, { recursive: true, force: true });
    }
  });

  it('excludes tier 2 (<db>-transcript) and NEVER tier 1 (<db>-state)', () => {
    const dump = mkdtempSync(join(tmpdir(), 'kopiaignore-'));
    try {
      const out = runProvisioning(dump, [
        ['*.tmp'],
        ['papercusp-transcript', 'tier 2 is never enrolled'],
      ]);
      const rules = out.split('\n').filter((l) => l && !l.startsWith('#'));
      expect(rules).toContain('papercusp-transcript');
      // THE LOAD-BEARING ASSERTION: tier 1 is the enrolled tier. Excluding it
      // returns papercusp to zero backup coverage, silently.
      expect(rules).not.toContain('papercusp-state');
      expect(out).not.toMatch(/^papercusp-state$/m);
    } finally {
      rmSync(dump, { recursive: true, force: true });
    }
  });

  it('is idempotent — repeated runs do not duplicate a rule', () => {
    const dump = mkdtempSync(join(tmpdir(), 'kopiaignore-'));
    try {
      runProvisioning(dump, [['*.tmp'], ['papercusp-transcript']]);
      const out = runProvisioning(dump, [['*.tmp'], ['papercusp-transcript']]);
      const count = (rule: string) => out.split('\n').filter((l) => l === rule).length;
      expect(count('*.tmp')).toBe(1);
      expect(count('papercusp-transcript')).toBe(1);
    } finally {
      rmSync(dump, { recursive: true, force: true });
    }
  });

  it('rejects missing transcript exclusions with the real Kopia engine before accepting local-only eligibility', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-eligibility-'));
    const dump = join(root, 'dump');
    const config = join(root, 'repository.config');
    const kopia = (...args: string[]) => execFileSync('/usr/bin/kopia', [
      '--config-file', config, '--password=isolated-fixture', '--no-use-keyring',
      '--disable-file-logging', '--no-progress', ...args,
    ], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
    try {
      for (const tier of ['state', 'transcript']) {
        mkdirSync(join(dump, 'pg', `papercusp-${tier}`), { recursive: true });
        writeFileSync(join(dump, 'pg', `papercusp-${tier}`, `${tier}-sentinel`), tier);
      }
      kopia('repository', 'create', 'filesystem', '--path', join(root, 'repository'));
      kopia('policy', 'set', '--global', '--add-dot-ignore=.kopiaignore');
      runProvisioning(dump, [['*.tmp']]);
      const missingRule = kopia('snapshot', 'estimate', dump, '--show-files');
      expect(missingRule).toContain('state-sentinel');
      expect(missingRule).toContain('transcript-sentinel');
      const eligible = (listing: string) => listing.includes('state-sentinel') && !listing.includes('transcript-sentinel');
      expect(eligible(missingRule)).toBe(false);

      runProvisioning(dump, [['papercusp-transcript']]);
      const excluded = kopia('snapshot', 'estimate', dump, '--show-files');
      expect(excluded).toContain('state-sentinel');
      expect(excluded).not.toContain('transcript-sentinel');
      expect(eligible(excluded)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('never eats operator-added exclusions (append-only)', () => {
    const dump = mkdtempSync(join(tmpdir(), 'kopiaignore-'));
    try {
      writeFileSync(join(dump, '.kopiaignore'), '# operator\nsome-operator-exclusion\n');
      const out = runProvisioning(dump, [['*.tmp'], ['papercusp-transcript']]);
      expect(out).toContain('some-operator-exclusion');
      expect(out).toContain('# operator');
      expect(out.split('\n')).toContain('*.tmp');
    } finally {
      rmSync(dump, { recursive: true, force: true });
    }
  });

  it('never provisions an exclusion for tier 1 at ANY call site', () => {
    // The behavioural tests above drive the function with explicit rules, so on
    // their own they cannot see a NEW call that excludes tier 1 — which is the
    // single most expensive mistake available here (it silently returns
    // papercusp to zero backup coverage while every status surface stays green).
    // Assert over the real call sites instead. The function DEFINITION line is
    // `ensure_kopiaignore_rule() {` with no space before `(`, so the `\s+` here
    // does not match it.
    const calls = [...src.matchAll(/ensure_kopiaignore_rule\s+(\S+)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0); // positive control: sites were found
    for (const call of calls) {
      expect(call).not.toMatch(/-state/);
    }
  });

  it('derives the tier-2 rule from PC_BACKUP_TIER_DBS rather than hardcoding it', () => {
    // Derived-truth ladder: a hardcoded 'papercusp-transcript' would drift the
    // moment the tier set changes, and the drift is silent.
    expect(src).toMatch(/ensure_kopiaignore_rule "\$db-transcript"/);
    expect(src).toMatch(/for db in \$PC_BACKUP_TIER_DBS; do\s*\n\s*ensure_kopiaignore_rule/);
  });
});
