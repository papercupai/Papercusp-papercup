/**
 * drop-database-force-guard.test.ts — the DROP DATABASE / WITH (FORCE) CI guard's
 * detection predicate (WI-4311).
 *
 * The guard (`scripts/check-drop-database-force.mjs`) runs green on the clean tree,
 * which only establishes the no-false-positive direction. A guard that has never
 * failed is a guard nobody has tested, so this file locks the direction WI-4311
 * actually asks for: that the predicate FLAGS a new unforced DROP DATABASE while not
 * flagging the forced form, prettier-wrapped calls, or prose in comments.
 *
 * The predicate is pure (text -> findings), so falsifiability is proven with
 * permanent in-file CONTROLS — never by mutating the shared tree, which on this
 * repo races git-sync and has already committed a mutant (EI-19450431506682666).
 */
import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';
import {
  findUnforcedDrops,
  findOffenders,
  stripComments,
  // TS7016 is reported on the module SPECIFIER line, so the suppression sits directly above it.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
} from '../../../scripts/check-drop-database-force.mjs';

const REPO_ROOT = new URL('../../../', import.meta.url);

describe('drop-database-force guard predicate (WI-4311)', () => {
  // ---- CONTROLS: deliberately-wrong input the guard MUST catch -------------
  // These are the mutants. If any of these ever stops being flagged, the guard has
  // silently gone inert and WI-4311's whole class is unguarded again.

  it('FLAGS a bare DROP DATABASE with no WITH (FORCE)', () => {
    const hits = findUnforcedDrops('await admin.unsafe(`DROP DATABASE IF EXISTS "${db}"`);');
    expect(hits).toHaveLength(1);
  });

  it('FLAGS the exact pre-fix shape from WI-4311 (terminate-then-plain-drop)', () => {
    const src = [
      "await a.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`);",
      'await a.unsafe(`DROP DATABASE IF EXISTS "${name}"`);',
    ].join('\n');
    const hits = findUnforcedDrops(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('DROP DATABASE');
  });

  it('FLAGS a lowercase / whitespace-variant drop  database', () => {
    expect(findUnforcedDrops('sql`drop   database if exists "x"`;')).toHaveLength(1);
  });

  it('FLAGS the unforced one in a file that also gets it RIGHT elsewhere', () => {
    // The failure shape WI-4311 actually shipped in: the shared helper was fixed, so
    // the file contains WITH (FORCE) — while a second, hand-rolled site did not. A
    // whole-file "contains FORCE anywhere" test would pass this and miss the bug.
    const src = [
      'await a.unsafe(`DROP DATABASE IF EXISTS "${a1}" WITH (FORCE)`);',
      'await b.unsafe(`DROP DATABASE IF EXISTS "${b2}"`);',
    ].join('\n');
    const hits = findUnforcedDrops(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  // ---- CALIBRATION: the real fixed form MUST pass --------------------------
  // Without these, the controls above would also pass if the predicate simply
  // flagged everything containing "DROP DATABASE".

  it('does NOT flag the forced form', () => {
    expect(findUnforcedDrops('await a.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);')).toHaveLength(0);
  });

  it('does NOT flag a prettier-wrapped call whose FORCE lands on the next line', () => {
    const src = ['await cleanup.unsafe(', '  `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,', ');'].join('\n');
    expect(findUnforcedDrops(src)).toHaveLength(0);
  });

  it('does NOT flag prose mentions in line or block comments', () => {
    expect(findUnforcedDrops('// a plain DROP DATABASE can block on a live backend')).toHaveLength(0);
    expect(findUnforcedDrops('/**\n * pg_stat_statements has no DROP DATABASE hook.\n */')).toHaveLength(0);
  });

  it('does NOT flag a test TITLE that names the statement (prose, not a statement)', () => {
    // Test names are not SQL executor arguments, even when they contain the banned words.
    expect(findUnforcedDrops("describe('cancelled DROP DATABASE never leaks an INVALID database', () => {")).toHaveLength(0);
    expect(findUnforcedDrops('it(`a plain DROP DATABASE blocks on a live backend`, async () => {')).toHaveLength(0);
    expect(findUnforcedDrops('  test.each(cases)("DROP DATABASE %s", (c) => {')).toHaveLength(0);
  });

  it('ignores descriptive cleanup labels and status tuples but still scans executable SQL', () => {
    const labels = [
      'const results = [',
      "  { name: 'DROP DATABASE', run: () => {} },",
      "  ['DROP DATABASE', 'completed'],",
      "  { name: 'DROP DATABASE', run: neverSettles },",
      "  ['DROP DATABASE', 'timed-out'],",
      '];',
      'await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);',
    ].join('\n');
    expect(findUnforcedDrops(labels)).toEqual([]);

    const withUnforcedSql = labels + '\nawait admin.unsafe("DROP DATABASE IF EXISTS x");';
    const hits = findUnforcedDrops(withUnforcedSql);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('admin.unsafe');
  });

  it('STILL flags an unforced statement that shares a line with a test title', () => {
    // A title is ignored, but its nested SQL executor call is still scanned.
    const line = "it('drops', async () => { await admin.unsafe('DROP DATABASE IF EXISTS x'); });";
    expect(findUnforcedDrops(line)).toHaveLength(1);
    const plain = 'await admin.unsafe(`DROP DATABASE IF EXISTS "${n}"`);';
    expect(findUnforcedDrops(plain)).toHaveLength(1);
  });

  it('tolerates WITH(FORCE) spacing variants', () => {
    expect(findUnforcedDrops('a.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH(FORCE)`);')).toHaveLength(0);
  });

  it('stripComments removes block and line comments', () => {
    expect(stripComments('/* x */ code // y')).not.toContain('x');
  });

  // ---- REAL-SOURCE CALIBRATION --------------------------------------------
  // Synthetic fixtures prove the predicate self-consistent, not that it matches
  // reality. These run it against the ACTUAL files WI-4311 was about, so a
  // predicate that only works on hand-written fixtures cannot pass.

  it.each([
    'libs/test-config/src/pg-migrate.ts',
    'libs/test-config/src/pg-migrate.integration.test.ts',
    'packages/operator-core/lib/release-preflight-migration-boot-smoke.integration.test.ts',
  ])('real source is clean: %s', (rel) => {
    const text = readFileSync(new URL(rel, REPO_ROOT), 'utf8');
    expect(findUnforcedDrops(text)).toEqual([]);
  });

  it('real makeDrop() source still carries WITH (FORCE) (the canonical fix)', () => {
    const text = readFileSync(new URL('libs/test-config/src/pg-migrate.ts', REPO_ROOT), 'utf8');
    expect(text).toContain('WITH (FORCE)');
  });

  // ---- TREE RATCHET -------------------------------------------------------
  // This must live HERE, not only in the standalone script, because
  // scripts/affected-tests.mjs SKIPS the repo-wide guard task whenever the owning
  // workspace's full `test` suite is already queued — on the explicit assumption
  // that "that suite already contains the guard". For an operator-core change that
  // is the common path, so without this test the tree would go unscanned exactly
  // when operator-core is what changed. Mirrors how lint:partial-index-alignment
  // keeps its ratchet in a vitest file for the same reason.
  it('the tree is currently clean: no unforced DROP DATABASE anywhere', () => {
    const { offenders, unscanned } = findOffenders();
    // Assert coverage too — a scan that silently reached nothing would report the
    // same empty offender list as a genuinely clean tree.
    expect(unscanned ?? []).toEqual([]);
    expect(offenders).toEqual([]);
  });
});
