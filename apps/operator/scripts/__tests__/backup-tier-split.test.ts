import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * WI-2146225 — recurrence guards for the TIERED Postgres dump.
 *
 * WHY THE SPLIT EXISTS. Measured 2026-09-05 by attributing every -Fd data member
 * of the live 93 GiB papercusp dump to its table via the archive TOC: six
 * append-only transcript/telemetry tables are 73 GiB of it (78%), and the state
 * that actually has to come back to restart the system is the other 20 GiB. So
 * the recovery-point objective of the irreplaceable state was being set by the
 * cost of dumping history we can live without.
 *
 * WHY THE SPLIT LIVES IN THE PRODUCER AND NOT IN KOPIA. It was first ratified as
 * a kopia exclusion. That is NOT EXPRESSIBLE: a -Fd dump names its data members
 * by pg_dump's internal dumpId, and dumpIds DRIFT between dump sets (measured:
 * session_archive_files was 30053 in the live set and 30016 in a frozen one,
 * +37 on every row) while only the pg OID is stable. A filename exclusion would
 * go on matching a DIFFERENT table every run, with no error anywhere.
 *
 * THE FAILURE THESE GUARD. Both hazards below are silent in BOTH directions —
 * the run exits 0, the artifact validates under `pg_restore -l`, and STATUS.json
 * is green — which is why they are pinned here rather than trusted to review:
 *
 *   1. SPLIT-BRAIN LISTS. If the exclude list and the include list are ever
 *      maintained separately, a table in NEITHER is silently in no backup at
 *      all, and a table in BOTH is stored twice. The only structural defence is
 *      that both are derived from ONE list, so that is what is asserted.
 *
 *   2. A PATTERN THAT MATCHES NOTHING. `pg_dump --exclude-table-data=<pattern>`
 *      does not error when the pattern matches nothing. One typo or one renamed
 *      table therefore leaves the 42 GiB table in the "state" tier AND drops it
 *      from the transcript tier simultaneously — un-splitting the thing while
 *      reporting success. Size cannot catch it (both tiers legitimately move run
 *      to run), so the script must verify existence up front, against the
 *      database being dumped rather than the `postgres` maintenance database
 *      (asking the wrong one reports every table missing and disables the tiers
 *      permanently — the same bug wearing the opposite mask).
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2), rather than by mutating the shared
// checkout — which git-sync would commit mid-probe.
const SCRIPT =
  process.env.BACKUP_TIER_SPLIT_SCRIPT ??
  resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');

const src = readFileSync(SCRIPT, 'utf8');

// The CONSUMER half of the split. Its BACKUP_ARTIFACTS default has to name the
// artifacts this producer actually writes, and nothing in either script's own
// tests can see that pairing — see the cross-file case at the bottom.
const HEALTH_CHECK_SCRIPT =
  process.env.BACKUP_HEALTH_CHECK_SCRIPT ??
  resolve(__dirname, '..', 'papercup-backup-health-check.sh');

const healthCheckSrc = readFileSync(HEALTH_CHECK_SCRIPT, 'utf8');

/**
 * Shell source with comment lines removed.
 *
 * Needed because this file's subject is a heavily-commented script whose comments
 * QUOTE the constructs the guards assert are absent — so a whole-text match reads
 * the explanation as the offence, and (worse, in the other direction) a construct
 * could be "found" only in prose. Line-granular on purpose: a trailing `#` inside
 * a string would be mangled by anything cleverer, and no guard here needs it.
 */
function stripComments(shell: string): string {
  return shell
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The default value of a `VAR="${VAR:-default}"` assignment. */
function defaultOf(name: string): string | null {
  const m = src.match(new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"`, 'm'));
  return m ? m[1] : null;
}

describe('papercusp-db-backup.sh tiered dump (WI-2146225)', () => {
  it('is the script we think it is (positive control)', () => {
    // A guard whose subject silently became the wrong file passes vacuously.
    expect(src).toContain('PC_BACKUP_TRANSCRIPT_TABLES');
    expect(src).toContain('dump_one');
  });

  it('derives BOTH tiers from a single table list, so no table can fall in the gap', () => {
    // One list variable, assigned exactly once.
    const assignments = src.match(/^PC_BACKUP_TRANSCRIPT_TABLES=/gm) ?? [];
    expect(assignments).toHaveLength(1);

    // Both tiers' pg_dump arguments are built inside one loop over that list.
    // Capturing the loop body is what makes this a structural claim rather than
    // a "both strings appear somewhere in the file" coincidence.
    const loop = src.match(
      /for t in \$PC_BACKUP_TRANSCRIPT_TABLES; do([\s\S]*?)\n {4}done/g,
    );
    expect(loop, 'expected a loop over PC_BACKUP_TRANSCRIPT_TABLES').toBeTruthy();
    const argBuildingLoop = (loop ?? []).find(
      (b) => b.includes('--exclude-table-data=') || b.includes('--table='),
    );
    expect(
      argBuildingLoop,
      'the exclude and include argument arrays must be built from the shared list',
    ).toBeTruthy();
    expect(argBuildingLoop).toContain('--exclude-table-data=$t');
    expect(argBuildingLoop).toContain('--table=$t');
  });

  it('names every default transcript table schema-qualified', () => {
    const list = defaultOf('PC_BACKUP_TRANSCRIPT_TABLES');
    expect(list, 'PC_BACKUP_TRANSCRIPT_TABLES must have a default').toBeTruthy();
    const tables = (list as string).split(/\s+/).filter(Boolean);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      // An unqualified name resolves by search_path, which pg_dump does not
      // share with this script — so it would match nothing, silently.
      expect(t, `${t} must be schema-qualified`).toMatch(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/);
    }
  });

  it('verifies the configured tables EXIST before dumping, against the target database', () => {
    expect(src).toContain('to_regclass');
    // The existence probe must connect to the database being dumped. $PSQL is
    // pinned to `-d postgres`, where these tables do not exist at all.
    const probeBlock = src.slice(Math.max(0, src.indexOf('to_regclass') - 600));
    expect(
      probeBlock,
      'the existence probe must use -d "$db", not the postgres maintenance DB',
    ).toContain('-d "$db"');
    // And a missing table must STOP the tier rather than dump a mislabelled one.
    expect(probeBlock).toMatch(/if \[ -n "\$missing" \]; then/);
  });

  it('routes both tiers through dump_one so they inherit the artifact safety rails', () => {
    // dump_one carries the space precondition, the chown/chmod that keeps the
    // artifact readable by both the archiver and pg_restore, the `pg_restore -l`
    // validation, and the atomic swap that preserves last-known-good. A tier
    // that dumped directly would silently lack all of them.
    expect(src).toMatch(/dump_one "\$db" "\$db-state"/);
    expect(src).toMatch(/dump_one "\$db" "\$db-transcript"/);
  });

  it('reddens the backup when a tier fails, now that the tiers ARE the backup', () => {
    // INVERTED at the 2026-09-05 cutover, deliberately. This test previously
    // asserted the OPPOSITE — that the tier pass must never append to FAILED —
    // and that was right while an undifferentiated papercusp dump existed: a tier
    // was then a redundant copy beside a green authoritative dump, so reddening
    // over it was the false-alarm trap the script header warns about twice.
    //
    // pg/papercusp is retired. The tier pair is the whole backup for a tiered
    // database, so the same silence is now the opposite defect: a failed tier
    // means NO fresh backup of that database exists, and a run that stays green
    // over it is the 30-day-unnoticed blindness EI-10733 exists to prevent.
    // OK derives from FAILED being empty, so appending is what reaches
    // ALERT-BACKUP-FAILING at all.
    const tierPass = src.slice(src.indexOf('AUTHORITATIVE PHASE'));
    expect(tierPass.length, 'expected the tier pass header').toBeGreaterThan(0);
    // CODE ONLY. The comments here deliberately QUOTE the deleted gate to say why
    // it must stay deleted, so a whole-text match finds the very string it is
    // asserting the absence of — and reports the explanation as the offence.
    // (This case caught exactly that on its first run.)
    const tierPassCode = stripComments(tierPass);
    expect(tierPassCode).toContain('TIER_FAILED+=');
    const plainFailedAppends = tierPassCode.match(/(?<!TIER_)FAILED\+=/g) ?? [];
    expect(
      plainFailedAppends.length,
      'a tier failure must reach the authoritative FAILED array (dump failure AND the missing-table refusal)',
    ).toBeGreaterThanOrEqual(2);
    // The dead gate: skipping the tiers unless the whole-db dump succeeded. A
    // tiered database is never in DUMPED any more, so leaving this in would skip
    // the only backup it has on every run while reporting "backup OK".
    expect(
      tierPassCode.match(/case " \$\{DUMPED\[\*\]\} " in/),
      'the "did the undifferentiated dump succeed" gate must stay deleted',
    ).toBeNull();
  });

  it('dumps a tiered database as tiers INSTEAD of whole, never both', () => {
    // The retirement itself. Before the cutover papercusp was written twice an
    // hour — ~94G undifferentiated plus ~95G of tiers covering the same rows — on
    // a run already taking ~20 minutes. The undifferentiated pass must therefore
    // SKIP a tiered database, and the decision has to be made before that pass
    // runs, which is why the two tier vars are declared above it.
    // Comments stripped FIRST: this pass explains the skip in prose that names
    // is_tiered, so an unstripped match would pass on the explanation alone —
    // green with the guard actually deleted. The false-PASS direction, and the one
    // no failing run ever reveals.
    const code = stripComments(src);
    const wholeDbPass = code.slice(code.indexOf('for db in $DBS; do'));
    expect(wholeDbPass.length, 'expected the undifferentiated pass').toBeGreaterThan(0);
    expect(
      wholeDbPass.slice(0, wholeDbPass.indexOf('\ndone')),
      'the undifferentiated pass must skip databases the tier pass owns',
    ).toMatch(/is_tiered "\$db"/);
    // Declaration order is load-bearing: is_tiered reads both vars, and a shell
    // reading them after this point would treat every database as untiered and
    // silently restore the double dump.
    expect(src.indexOf('PC_BACKUP_TIERS_ENABLED="${PC_BACKUP_TIERS_ENABLED:-1}"')).toBeLessThan(
      src.indexOf('for db in $DBS; do'),
    );
    expect(src.indexOf('PC_BACKUP_TIER_DBS="${PC_BACKUP_TIER_DBS:-papercusp}"')).toBeLessThan(
      src.indexOf('for db in $DBS; do'),
    );
    // Exactly one assignment of each, so the hoist cannot leave a shadowing copy
    // further down that reads correct in isolation.
    expect((src.match(/^PC_BACKUP_TIERS_ENABLED=/gm) ?? []).length).toBe(1);
    expect((src.match(/^PC_BACKUP_TIER_DBS=/gm) ?? []).length).toBe(1);
  });

  it('never writes a tiered database itself into .kopiaignore', () => {
    // PC_BACKUP_TIERS_ENABLED=0 is the escape hatch, and it works by dropping the
    // database back into the undifferentiated pass. An ignore rule for "$db" would
    // survive that fallback and turn it into silent ZERO coverage — the exact
    // condition WI-2146225 exists to repair. Only "$db-transcript" is ever excluded.
    const rules = stripComments(src).match(/ensure_kopiaignore_rule "[^"]*"/g) ?? [];
    expect(rules.length, 'expected .kopiaignore rules to assert on').toBeGreaterThan(0);
    expect(rules).toContain('ensure_kopiaignore_rule "$db-transcript"');
    expect(rules).not.toContain('ensure_kopiaignore_rule "$db"');
  });

  it('keeps the health-check consumer naming the artifacts that actually exist', () => {
    // THE CROSS-FILE STRAND, and the one nothing else can catch: the producer and
    // its alarm live in different files, so retiring pg/papercusp here while
    // papercup-backup-health-check.sh still asserted freshness over that path
    // produced both failures its own header warns about at once — a PERMANENT
    // false alarm on a path nothing writes (no fresh run can ever clear it), and a
    // BLIND detector, because the two artifacts now holding the whole database
    // were watched by nothing. Neither script's own tests can see the other half.
    const m = healthCheckSrc.match(/^BACKUP_ARTIFACTS="\$\{BACKUP_ARTIFACTS:-([^}]*)\}"/m);
    expect(m, 'expected a BACKUP_ARTIFACTS default to assert on').toBeTruthy();
    const artifacts = (m as RegExpMatchArray)[1].split(/\s+/).filter(Boolean);
    // Derived from the producer, not hardcoded: whatever database the producer
    // tiers must have BOTH its tiers watched, and must not be watched whole.
    const tierDbs = (defaultOf('PC_BACKUP_TIER_DBS') ?? '').split(/\s+/).filter(Boolean);
    expect(tierDbs.length, 'expected at least one tiered database').toBeGreaterThan(0);
    for (const db of tierDbs) {
      expect(artifacts, `${db}'s state tier must be watched`).toContain(`pg/${db}-state`);
      expect(artifacts, `${db}'s transcript tier must be watched`).toContain(
        `pg/${db}-transcript`,
      );
      expect(
        artifacts,
        `pg/${db} is retired — watching it is a permanent false alarm`,
      ).not.toContain(`pg/${db}`);
    }
  });

  it('pins the health-check self-test to its own fixture, not the production default', () => {
    // The self-test builds pg/papercusp + pg/restart in a temp tree. Inheriting the
    // production default meant this very cutover silently turned all 45 cases into
    // "artifact absent" — they keep running and keep printing ok while testing
    // nothing about staleness. Exported once inside the self-test block so a new
    // case cannot be added without it.
    const selfTest = healthCheckSrc.slice(
      healthCheckSrc.indexOf('if [ "${1:-}" = "--self-test" ]'),
    );
    expect(selfTest.length, 'expected the self-test block').toBeGreaterThan(0);
    expect(selfTest).toMatch(/export BACKUP_ARTIFACTS=/);
  });

  it('reports tier outcomes in STATUS.json under their own fields', () => {
    // A consumer must be able to assert on tier health directly instead of
    // inferring it from a whole-cluster boolean that deliberately excludes it.
    expect(src).toContain('"tierDumped"');
    expect(src).toContain('"tierFailed"');
    expect(src).toContain('"tiersEnabled"');
    expect(src).toContain('"tierNotDue"');
  });

  describe('transcript-tier cadence (WI-10004603)', () => {
    const code = stripComments(src);

    it('keeps its default inside the health check\'s staleness bar, with room for a deferred run', () => {
      const def = Number(defaultOf('PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC'));
      const maxAgeH = Number(
        (healthCheckSrc.match(/^BACKUP_MAX_AGE_H="\$\{BACKUP_MAX_AGE_H:-(\d+)\}"/m) ?? [])[1],
      );
      expect(def).toBeGreaterThan(0);
      expect(maxAgeH).toBeGreaterThan(0);
      // Worst case before a re-dump: the cadence, plus one hourly period of check
      // granularity, plus the time a run takes to reach the tier (<1 h), plus one
      // deferred run. That must still be under the alarm.
      expect(def + 3 * 3600).toBeLessThan(maxAgeH * 3600);
    });

    it('measures the artifact the same way the health check does (directory mtime)', () => {
      expect(code).toMatch(/transcript_tier_age\(\) \{[\s\S]*?stat -c %Y "\$1"/);
      expect(healthCheckSrc).toMatch(/mtime="\$\(stat -c %Y "\$f"/);
    });

    it('never counts a not-due tier as dumped or failed', () => {
      const branch = code.match(/tx_age=\$\(transcript_tier_age[\s\S]*?\n {4}fi\n/);
      expect(branch, 'expected the transcript dump branch').not.toBeNull();
      const [notDue, due] = (branch as RegExpMatchArray)[0].split(/\n\s*else\n/);
      expect(notDue).toContain('TIER_NOT_DUE+=("$db-transcript")');
      expect(notDue).not.toMatch(/DUMPED\+=|FAILED\+=|TRANSCRIPT_DUE\+=/);
      // A due tier is queued for the local-only phase (WI-10004870), never dumped
      // inside the shared-lock section.
      expect(due, 'expected the due branch').toBeDefined();
      expect(due).toContain('TRANSCRIPT_DUE+=("$db")');
      expect(due).not.toMatch(/dump_one/);
    });

    it('dumps the transcript tier only after every snapshotted artifact, outside the shared lock (WI-10004870)', () => {
      // The guard holds the host-wide Kopia lock for this whole script unless the
      // script asks for it back. The transcript tier is the only thing excluded
      // from every snapshot, so it is the only thing allowed after the ask: a
      // snapshotted artifact written after it could be captured mid-swap by a
      // sweep that just took the lock.
      const askAt = code.indexOf('release_shared_backup_lock "');
      expect(askAt, 'expected the early-release request').toBeGreaterThan(0);
      expect(
        (code.match(/release_shared_backup_lock "/g) ?? []).length,
        'exactly one call site',
      ).toBe(1);
      const before = code.slice(0, askAt);
      const after = code.slice(askAt);
      // Every snapshotted producer is BEFORE the ask.
      expect(before).toMatch(/dump_one "\$db" "\$db-state"/);
      expect(before).toContain('ODDSMITH_DISCOVERY=');
      expect(before).toMatch(/for db in \$DBS; do/);
      // After it: the transcript dump and nothing else that writes a dump.
      expect(after).toMatch(/dump_one "\$db" "\$db-transcript"/);
      expect((after.match(/dump_one /g) ?? []).length).toBe(1);
      expect(after).not.toMatch(/\bpg_dump\b|\bpg_dumpall\b/);
      // The only snapshotted file still written after the ask is STATUS.json, and
      // it is swapped in atomically through a *.tmp name .kopiaignore excludes, so a
      // sweep that starts early sees the old or the new receipt, never a torn one.
      expect((after.match(/mv -f /g) ?? []).length).toBe(1);
      expect(after).toContain('> "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"');
      expect(src).toContain("ensure_kopiaignore_rule '*.tmp'");
      // The phase only runs when a tier is actually due, so a not-due run keeps
      // the lock to its end exactly as before.
      expect(code).toMatch(
        /if \[ \$\{#TRANSCRIPT_DUE\[@\]\} -gt 0 \]; then\n {2}release_shared_backup_lock "/,
      );
    });

    it('asks the guard through its release path, and is a no-op outside the guard', () => {
      const fn = src.match(/release_shared_backup_lock\(\) \{[\s\S]*?\n\}\n/);
      expect(fn, 'expected release_shared_backup_lock').not.toBeNull();
      const dir = mkdtempSync(join(tmpdir(), 'backup-release-'));
      try {
        const request = join(dir, 'global.lock.release.123');
        const body = `log() { printf '%s\\n' "$*"; }\n${(fn as RegExpMatchArray)[0]}\nrelease_shared_backup_lock papercusp`;
        const asked = spawnSync('bash', ['-c', body], {
          encoding: 'utf8',
          env: { ...process.env, KOPIA_BACKUP_GUARD_RELEASE_PATH: request },
        });
        expect(asked.status, asked.stderr).toBe(0);
        expect(existsSync(request)).toBe(true);
        expect(asked.stdout).toContain('early release requested');

        const env = { ...process.env };
        delete env.KOPIA_BACKUP_GUARD_RELEASE_PATH;
        const manual = spawnSync('bash', ['-c', body], { encoding: 'utf8', env });
        expect(manual.status, manual.stderr).toBe(0);
        expect(manual.stdout).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still dumps when there is no artifact to keep', () => {
      // An absent or unreadable artifact yields an empty age, and an empty age
      // must fall through to dump_one, never to "not due".
      const fn = code.match(/transcript_tier_age\(\) \{[\s\S]*?\n\}/);
      expect(fn).not.toBeNull();
      expect((fn as RegExpMatchArray)[0]).toMatch(/\[ -d "\$1" \] \|\| return 0/);
      expect(code).toMatch(/\[ -n "\$tx_age" \] && \[ "\$tx_age" -ge 0 \]/);
    });
  });
});
