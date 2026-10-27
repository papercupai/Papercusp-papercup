/**
 * host-dump-coverage-defaults.test.ts — pin the TWO-SIDED contract between the
 * host backup shell script and the TypeScript hook that reads its receipt.
 *
 * `packages/backup/src/host-dump-coverage.ts` decides whether the per-workspace
 * dump is redundant by reading `STATUS.json` written by
 * `apps/operator/scripts/systemd/papercusp-db-backup.sh`. Nothing at runtime
 * couples them: the script is a shell file executed by systemd, and the reader
 * is TypeScript in a different package. Every field below is therefore a second
 * copy of a truth the other side owns, and the derived-truth ladder says an
 * un-pinned copy WILL drift.
 *
 * The drift is not loud. If the directory default or a field name diverges, the
 * hook simply never establishes coverage and silently resumes the redundant
 * multi-GB hourly dumps this change removed — the exact bug
 * (EI-21874492117996483) coming back with no error anywhere. These assertions
 * are what make that failure a red test instead of a quiet regression.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST_PG_DUMP_DIR, HOST_PG_DUMP_DIR_ENV } from './host-dump-coverage';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED
// COPY outside the tree, so the guard's falsifiability can be demonstrated
// without ever mutating the shared checkout (where the git-sync sweep would
// happily commit the mutant mid-probe). Unset in normal runs.
const SCRIPT_PATH =
  process.env.PROBE_SCRIPT ||
  join(__dirname, '../../../apps/operator/scripts/systemd/papercusp-db-backup.sh');
const script = readFileSync(SCRIPT_PATH, 'utf8');

describe('papercusp-db-backup.sh ↔ host-dump-coverage.ts', () => {
  it('is readable at the expected path (a moved script must fail loudly here)', () => {
    // Guards the assertions below from becoming vacuous: every other test in
    // this file greps `script`, so a silently-empty read would pass them all.
    expect(script.length).toBeGreaterThan(1000);
    expect(script).toContain('pg_dump');
  });

  it('resolves its dump directory from the SAME env var the reader uses', () => {
    expect(script).toContain(HOST_PG_DUMP_DIR_ENV);
  });

  it('falls back to the SAME default directory the reader assumes', () => {
    expect(script).toContain(`\${${HOST_PG_DUMP_DIR_ENV}:-${DEFAULT_HOST_PG_DUMP_DIR}}`);
  });

  it('writes STATUS.json into that directory', () => {
    expect(script).toMatch(/STATUS="\$DUMP\/STATUS\.json"/);
  });

  it('records the cluster identity the reader requires before it will skip', () => {
    // Without this field the reader can never prove same-cluster, so it never
    // skips — safe, but the redundancy silently returns.
    expect(script).toMatch(/system_identifier\s+FROM\s+pg_control_system\(\)/);
    expect(script).toContain('"systemIdentifier": "%s"');
  });

  it('emits the identity as digits-or-empty so a malformed value cannot read as proof', () => {
    expect(script).toMatch(/SYSID=.*tr -dc '0-9'/);
  });

  it('emits the other receipt fields the reader consumes', () => {
    for (const field of ['"ok"', '"lastSuccessEpoch"', '"dumped"']) {
      expect(script).toContain(field);
    }
  });

  it('writes a dump-start timestamp and cluster identity for each completed artifact', () => {
    expect(script).toContain('artifactReceipts');
    expect(script).toContain('dumpStartEpoch');
    expect(script).toContain('systemIdentifier');
    expect(script).toContain('artifact_receipts_json() {');
    expect(script).toMatch(/ARTIFACT_DUMP_START_EPOCHS\["\$label"\]="\$dump_started_epoch"/);
  });
});
