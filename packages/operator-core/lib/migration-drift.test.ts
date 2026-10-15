import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeSchemaAhead,
  classifyMissingByDeployedTree,
  computeContentDrift,
  classifyContentDrift,
  resolveDeployedSqlDir,
  resolveSqlDir,
  resolveCanonicalStagingSqlDir,
  digestAppliedMigrationRows,
  readAppliedMigrationLedgerIdentity,
  migrationReplayTestTimeoutMs,
  type MigrationContentDrift,
} from './migration-drift';

describe('readAppliedMigrationLedgerIdentity', () => {
  it('hashes a sorted filename and sha256 frontier, excluding row order', async () => {
    const first = await readAppliedMigrationLedgerIdentity(async () => [
      { filename: '002-second.sql', sha256: 'sha-b' },
      { filename: '001-first.sql', sha256: 'sha-a' },
    ]);
    const reordered = await readAppliedMigrationLedgerIdentity(async () => [
      { filename: '001-first.sql', sha256: 'sha-a' },
      { filename: '002-second.sql', sha256: 'sha-b' },
    ]);
    const changed = digestAppliedMigrationRows([
      { filename: '001-first.sql', sha256: 'sha-a' },
      { filename: '002-second.sql', sha256: 'sha-c' },
    ]);

    expect(first).toMatchObject({ state: 'known', rows: [
      { filename: '001-first.sql', sha256: 'sha-a' },
      { filename: '002-second.sql', sha256: 'sha-b' },
    ] });
    expect(reordered).toEqual(first);
    expect(first.state === 'known' ? first.digest : null).not.toBe(changed);
  });

  it('preserves failed or malformed ledger reads as unknown', async () => {
    await expect(
      readAppliedMigrationLedgerIdentity(async () => {
        throw new Error('database unavailable');
      }),
    ).resolves.toEqual({ state: 'unknown', reason: 'query-failed' });
    await expect(
      readAppliedMigrationLedgerIdentity(async () => [
        { filename: '001-first.sql', sha256: undefined as unknown as null },
      ]),
    ).resolves.toEqual({ state: 'unknown', reason: 'malformed-ledger' });
  });
});

describe('migrationReplayTestTimeoutMs', () => {
  it('keeps the historical floor for small corpora and grows with migration count', () => {
    expect(migrationReplayTestTimeoutMs(0)).toBe(300_000);
    expect(migrationReplayTestTimeoutMs(200)).toBe(300_000);
    expect(migrationReplayTestTimeoutMs(1_139)).toBe(1_708_500);
    expect(() => migrationReplayTestTimeoutMs(-1)).toThrow(/non-negative/);
  });
});
import type { AppliedMigrationTextResult } from './migration-applied-text';

/**
 * EI-19365742982915607: an applied migration edited AFTER it ran. The edit
 * never executes (the runner skips anything already recorded), so the file on
 * disk silently misdescribes the live schema — forever.
 *
 * The real case this reproduces: mig 708 ran at 2026-08-01T19:15:49Z against a
 * blob containing zero `closed_ts`; a PART 2 hunk was committed 9 minutes
 * later. PART 1 was live, PART 2 never was, and every reader who grepped the
 * .sql concluded closed_ts federation had shipped.
 */
describe('computeContentDrift', () => {
  const rows = (...pairs: Array<[string, string | null]>) =>
    pairs.map(([filename, sha256]) => ({ filename, sha256 }));

  it('flags an applied migration whose bytes changed after it ran', () => {
    expect(
      computeContentDrift(
        rows(['708-federate.sql', 'recorded-sha'], ['707-fine.sql', 'same']),
        new Map([
          ['708-federate.sql', 'edited-sha'],
          ['707-fine.sql', 'same'],
        ]),
      ),
    ).toEqual([
      {
        filename: '708-federate.sql',
        recordedSha256: 'recorded-sha',
        diskSha256: 'edited-sha',
      },
    ]);
  });

  it('is empty when every applied file still matches its recorded hash', () => {
    expect(
      computeContentDrift(
        rows(['001-a.sql', 'aaa'], ['002-b.sql', 'bbb']),
        new Map([
          ['001-a.sql', 'aaa'],
          ['002-b.sql', 'bbb'],
        ]),
      ),
    ).toEqual([]);
  });

  it('a legacy row with no recorded sha256 is UNJUDGEABLE, never reported as drift', () => {
    // Absence of evidence is not evidence of drift — reporting these would
    // bury the real signal under every pre-sha256 migration in history.
    expect(
      computeContentDrift(
        rows(['001-legacy.sql', null], ['002-blank.sql', '  ']),
        new Map([
          ['001-legacy.sql', 'whatever'],
          ['002-blank.sql', 'whatever'],
        ]),
      ),
    ).toEqual([]);
  });

  it('a file gone from disk is `extra`, not content drift (no double reporting)', () => {
    expect(computeContentDrift(rows(['600-squashed.sql', 'sha']), new Map())).toEqual([]);
  });

  it('ignores runner-ineligible rows (templates / manual-only)', () => {
    expect(
      computeContentDrift(
        rows(['999-per-harness-template.sql', 'sha'], ['040-plugin-configs-backfill.sql', 'sha']),
        new Map([
          ['999-per-harness-template.sql', 'different'],
          ['040-plugin-configs-backfill.sql', 'different'],
        ]),
      ),
    ).toEqual([]);
  });

  it('EI-19415309774723126: excludes 000-baseline.sql — frozen/generated, diverges by design', () => {
    // pull-schema.mjs regenerates this file wholesale from the live schema, so
    // its on-disk bytes routinely differ from whatever was recorded at apply
    // time even with no half-landed migration involved. It must never show up
    // as content drift, unlike every other runner-eligible file.
    expect(
      computeContentDrift(
        rows(['000-baseline.sql', 'recorded-sha'], ['001-real.sql', 'recorded-sha']),
        new Map([
          ['000-baseline.sql', 'regenerated-different-sha'],
          ['001-real.sql', 'edited-sha'],
        ]),
      ),
    ).toEqual([
      { filename: '001-real.sql', recordedSha256: 'recorded-sha', diskSha256: 'edited-sha' },
    ]);
  });

  it('reports every drifted file, sorted by filename', () => {
    expect(
      computeContentDrift(
        rows(['710-c.sql', 'r3'], ['700-a.sql', 'r1'], ['705-b.sql', 'r2']),
        new Map([
          ['710-c.sql', 'd3'],
          ['700-a.sql', 'd1'],
          ['705-b.sql', 'd2'],
        ]),
      ).map((d) => d.filename),
    ).toEqual(['700-a.sql', '705-b.sql', '710-c.sql']);
  });
});

/**
 * EI-19408574209859155: a byte difference is not yet a verdict. `computeContentDrift`
 * above answers "did the bytes change"; this answers "did anything that RUNS change" —
 * separating a real half-landed migration from the provably-benign comment-only edit
 * that `lint:migration-forward-compat`'s own escape hatch (a `-- FORWARD-COMPAT:`
 * COMMENT written into an already-applied file) necessarily produces.
 *
 * Both IO seams are injected, so these run without git or a filesystem.
 */
describe('classifyContentDrift', () => {
  const entry: MigrationContentDrift = {
    filename: '727-widen.sql',
    recordedSha256: 'recorded',
    diskSha256: 'disk',
  };
  const appliedOk = (text: string) => (): AppliedMigrationTextResult => ({
    ok: true,
    text,
    commit: 'e786f7391c46dd32ec2a53b7e819289e087f3e86',
  });

  it('classifies a comment-only edit as benign, citing the commit it compared against', async () => {
    const [got] = await classifyContentDrift(
      [entry],
      appliedOk('ALTER TABLE t ADD COLUMN c int;\n'),
      () => '-- FORWARD-COMPAT: cannot break the deployed release.\nALTER TABLE t ADD COLUMN c int;\n',
    );
    expect(got.classification).toBe('comments-only');
    expect(got.classificationDetail).toContain('e786f7391c46');
    // The raw byte-level fields are preserved — this classifies, never hides.
    expect(got).toMatchObject(entry);
  });

  it('classifies a real half-landed migration as executable (the mig-708 hazard)', async () => {
    const [got] = await classifyContentDrift(
      [entry],
      appliedOk('ALTER TABLE t ADD COLUMN a int;\n'),
      () => 'ALTER TABLE t ADD COLUMN a int;\nALTER TABLE t ADD COLUMN closed_ts timestamptz;\n',
    );
    expect(got.classification).toBe('executable');
    expect(got.classificationDetail).toMatch(/never ran and never will/);
  });

  it('SAFETY: unrecoverable applied text is `unclassified`, never benign', async () => {
    // The packaged/headless case — no git repo, so recovery is impossible by
    // construction. The correct outcome is today's behavior (report the drift).
    const [got] = await classifyContentDrift(
      [entry],
      () => ({ ok: false, reason: 'the file has no git history in this tree' }),
      () => 'anything',
    );
    expect(got.classification).toBe('unclassified');
    expect(got.classificationDetail).toMatch(/applied text unrecoverable/);
  });

  it('SAFETY: unlexable SQL on either side is `unclassified`, never benign', async () => {
    const [fromApplied] = await classifyContentDrift([entry], appliedOk("SELECT 'oops;"), () => 'SELECT 1;');
    expect(fromApplied.classification).toBe('unclassified');
    expect(fromApplied.classificationDetail).toMatch(/applied SQL unparseable/);

    const [fromDisk] = await classifyContentDrift([entry], appliedOk('SELECT 1;'), () => "SELECT 'oops;");
    expect(fromDisk.classification).toBe('unclassified');
    expect(fromDisk.classificationDetail).toMatch(/on-disk SQL unparseable/);
  });

  it('SAFETY: an unreadable on-disk file is `unclassified`, never benign', async () => {
    const [got] = await classifyContentDrift([entry], appliedOk('SELECT 1;'), () => null);
    expect(got.classification).toBe('unclassified');
    expect(got.classificationDetail).toMatch(/on-disk text unreadable/);
  });

  it('SAFETY: a THROWING seam is caught and reported, never allowed to look benign', async () => {
    const [fromApplied] = await classifyContentDrift(
      [entry],
      () => {
        throw new Error('git exploded');
      },
      () => 'SELECT 1;',
    );
    expect(fromApplied.classification).toBe('unclassified');
    expect(fromApplied.classificationDetail).toMatch(/git exploded/);

    const [fromDisk] = await classifyContentDrift([entry], appliedOk('SELECT 1;'), () => {
      throw new Error('EACCES');
    });
    expect(fromDisk.classification).toBe('unclassified');
    expect(fromDisk.classificationDetail).toMatch(/EACCES/);
  });

  it('every entry always carries a populated classificationDetail', async () => {
    const many = await classifyContentDrift(
      [entry, { ...entry, filename: '728-b.sql' }],
      appliedOk('SELECT 1;'),
      () => 'SELECT 1; -- c',
    );
    expect(many).toHaveLength(2);
    for (const d of many) expect(d.classificationDetail.length).toBeGreaterThan(0);
  });

  it('batches applied-text reads in bounded groups and preserves result order', async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      ...entry,
      filename: `migration-${i}.sql`,
    }));
    const batchSizes: number[] = [];
    const classified = await classifyContentDrift(
      many,
      () => {
        throw new Error('the batch reader should serve every entry');
      },
      () => 'SELECT 1; -- current comment',
      {
        readAppliedTexts: async (batch) => {
          batchSizes.push(batch.length);
          return batch.map(() => ({
            ok: true as const,
            text: 'SELECT 1;',
            commit: 'e786f7391c46dd32ec2a53b7e819289e087f3e86',
          }));
        },
      },
    );

    expect(batchSizes).toEqual([32, 3]);
    expect(classified.map((d) => d.filename)).toEqual(many.map((d) => d.filename));
    expect(classified.every((d) => d.classification === 'comments-only')).toBe(true);
  });

  it('fails closed when a batched history read runs past the classifier budget', async () => {
    let time = 0;
    const classified = await classifyContentDrift(
      [entry, { ...entry, filename: '728-b.sql' }],
      () => {
        throw new Error('the batch reader should serve every entry');
      },
      () => 'SELECT 1;',
      {
        budgetMs: 100,
        now: () => time,
        readAppliedTexts: async (batch) => {
          time = 101;
          return batch.map(() => ({
            ok: true as const,
            text: 'SELECT 1;',
            commit: 'e786f7391c46dd32ec2a53b7e819289e087f3e86',
          }));
        },
      },
    );

    expect(classified.map((d) => d.classification)).toEqual(['unclassified', 'unclassified']);
    expect(classified[0]?.classificationDetail).toMatch(/100ms classification budget was exhausted/);
  });

  it('stops spending past the budget and marks the REST unclassified, never benign', async () => {
    // Injected clock: the first entry is classified, then time jumps past the
    // budget, so everything after it must degrade to unclassified rather than
    // keep walking git history.
    let t = 0;
    const clock = () => (t += 600); // each read advances 600ms
    const many = [
      { filename: 'a.sql', recordedSha256: 'r', diskSha256: 'd' },
      { filename: 'b.sql', recordedSha256: 'r', diskSha256: 'd' },
      { filename: 'c.sql', recordedSha256: 'r', diskSha256: 'd' },
    ];
    const got = await classifyContentDrift(
      many,
      appliedOk('SELECT 1;'),
      () => 'SELECT 1; -- benign comment',
      { budgetMs: 1000, now: clock },
    );
    // First is classified normally...
    expect(got[0].classification).toBe('comments-only');
    // ...the rest ran out of budget, and are HAZARDOUS, not benign.
    expect(got[1].classification).toBe('unclassified');
    expect(got[1].classificationDetail).toMatch(/budget was exhausted/);
    expect(got[2].classification).toBe('unclassified');
  });

  it('is empty-safe — the normal case, where nothing drifted at all', async () => {
    expect(
      await classifyContentDrift(
        [],
        () => {
          throw new Error('must not be called');
        },
        () => {
          throw new Error('must not be called');
        },
      ),
    ).toEqual([]);
  });
});

/**
 * WI-5050 (WI-4070 class): `schemaAhead` flags applied migrations numbered
 * beyond anything the running code tree ships — a stale operator against a
 * newer-migrated shared DB (the dev-source rot that silently killed VM
 * federation via the mig-557 hives→pots rename).
 */
describe('computeSchemaAhead', () => {
  const onDisk = ['001-a.sql', '002-b.sql', '557-hives-to-pots.sql'];

  it('is empty when the DB has nothing newer than the code tree', () => {
    expect(computeSchemaAhead(onDisk, ['001-a.sql', '002-b.sql'])).toEqual([]);
    expect(computeSchemaAhead(onDisk, onDisk)).toEqual([]);
  });

  it('flags applied migrations numbered beyond the on-disk cap', () => {
    expect(
      computeSchemaAhead(onDisk, ['001-a.sql', '558-newer.sql', '614-adjacency-state.sql']),
    ).toEqual(['558-newer.sql', '614-adjacency-state.sql']);
  });

  it('ignores non-numbered / runner-ineligible applied rows', () => {
    expect(
      computeSchemaAhead(onDisk, ['999-per-harness-template.sql', 'notes.txt', 'zzz.sql']),
    ).toEqual([]);
  });

  it('returns empty when the code tree has no numbered migrations (unknown ≠ ahead)', () => {
    expect(computeSchemaAhead([], ['558-newer.sql'])).toEqual([]);
    expect(computeSchemaAhead(['README.md'], ['558-newer.sql'])).toEqual([]);
  });

  it('an applied row EQUAL to the cap is not "ahead"', () => {
    expect(computeSchemaAhead(onDisk, ['557-hives-to-pots.sql'])).toEqual([]);
  });
});

/**
 * WI-6037: `missing` alone can't distinguish a genuine unapplied migration from the
 * normal staging-ahead-of-release window (the staging tree legitimately contains
 * migration files the release tree hasn't received yet). classifyMissingByDeployedTree
 * splits `missing` against what's actually on disk in the DEPLOYED tree.
 */
describe('classifyMissingByDeployedTree', () => {
  const missing = ['670-a.sql', '671-b.sql', '672-c.sql'];

  it('splits into deployed (real hazard) vs pending-deploy (staging-ahead noise)', () => {
    // 670/671 exist in the deployed tree (genuinely unapplied there); 672 is staging-only.
    expect(classifyMissingByDeployedTree(missing, ['670-a.sql', '671-b.sql', '900-other.sql'])).toEqual({
      missingDeployed: ['670-a.sql', '671-b.sql'],
      missingPendingDeploy: ['672-c.sql'],
    });
  });

  it('the staging-ahead case: nothing missing exists in the deployed tree', () => {
    expect(classifyMissingByDeployedTree(missing, ['001-old.sql'])).toEqual({
      missingDeployed: [],
      missingPendingDeploy: missing,
    });
  });

  it('the masking-control case: everything missing also exists in the deployed tree', () => {
    expect(classifyMissingByDeployedTree(missing, missing)).toEqual({
      missingDeployed: missing,
      missingPendingDeploy: [],
    });
  });

  it('null deployedOnDisk (tree unresolvable) fails TOWARD reporting, not silent suppression', () => {
    expect(classifyMissingByDeployedTree(missing, null)).toEqual({
      missingDeployed: missing,
      missingPendingDeploy: [],
    });
  });

  it('is empty-safe', () => {
    expect(classifyMissingByDeployedTree([], [])).toEqual({ missingDeployed: [], missingPendingDeploy: [] });
    expect(classifyMissingByDeployedTree([], null)).toEqual({ missingDeployed: [], missingPendingDeploy: [] });
  });
});

/**
 * EI-18737837917400418: a packaged/headless deploy (a Tauri sidecar, a
 * standalone rig install) has no repo tree above cwd, so `resolveSqlDir` MUST
 * be resolvable from `PAPERCUSP_PG_SQL_DIR` alone — it used to try only
 * repo-relative candidates and silently return null on such a layout, which
 * skipped the EI-13992 boot-apply safety net on every boot.
 */
describe('resolveSqlDir', () => {
  const tmpRoots: string[] = [];
  const savedEnv = process.env.PAPERCUSP_PG_SQL_DIR;

  afterEach(() => {
    for (const p of tmpRoots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.PAPERCUSP_PG_SQL_DIR;
    else process.env.PAPERCUSP_PG_SQL_DIR = savedEnv;
  });

  it('resolves from PAPERCUSP_PG_SQL_DIR alone with NO repo tree above cwd (packaged layout)', () => {
    // A cwd with nothing above it resembling libs/papercusp/libs/db/sql — the
    // packaged-install case that used to fall through to null.
    const packagedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-packaged-'));
    tmpRoots.push(packagedCwd);
    const envSqlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-env-sql-'));
    tmpRoots.push(envSqlDir);
    fs.writeFileSync(path.join(envSqlDir, '001-a.sql'), '-- noop\n');

    process.env.PAPERCUSP_PG_SQL_DIR = envSqlDir;
    expect(resolveSqlDir(packagedCwd)).toBe(envSqlDir);
  });

  it('falls back to repo-relative candidates when the env var is unset', () => {
    delete process.env.PAPERCUSP_PG_SQL_DIR;
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-inrepo-'));
    tmpRoots.push(parent);
    const sqlDir = path.join(parent, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    expect(resolveSqlDir(parent)).toBe(sqlDir);
  });

  it('falls back to repo-relative candidates when the env var points at a nonexistent dir', () => {
    process.env.PAPERCUSP_PG_SQL_DIR = '/definitely/not/a/real/dir/xyz';
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-inrepo2-'));
    tmpRoots.push(parent);
    const sqlDir = path.join(parent, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    expect(resolveSqlDir(parent)).toBe(sqlDir);
  });

  it('returns null when neither the env var nor any repo-relative candidate exists', () => {
    process.env.PAPERCUSP_PG_SQL_DIR = '/definitely/not/a/real/dir/xyz';
    const packagedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-nothing-'));
    tmpRoots.push(packagedCwd);
    expect(resolveSqlDir(packagedCwd)).toBeNull();
  });
});

/**
 * resolveDeployedSqlDir: recovers the release-tree sql dir from an already-resolved
 * on-disk sql dir, using a `papercup-release` sibling of the tree's parent dir — no
 * git/env lookup needed for the common case. Verified against a real fixture tree
 * (not mocked) so the path-arithmetic itself is exercised, not just its assumption.
 */
describe('resolveDeployedSqlDir', () => {
  const tmpRoots: string[] = [];
  // Guard against an ambient PAPERCUSP_RELEASE_ROOT in the test-runner's own env
  // (set on a real :3070/:3170 host) shadowing the fixture sibling these tests rely on.
  const savedReleaseRootEnv = process.env.PAPERCUSP_RELEASE_ROOT;
  // WI-10005161: the shared release-root resolver also anchors on
  // PAPERCUSP_CANONICAL_TREE (set on :3170), so an inherited one would shadow the
  // fixture sibling the same way.
  const savedCanonicalTreeEnv = process.env.PAPERCUSP_CANONICAL_TREE;
  function makeTree(name: string, hasFile: boolean): string {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-test-'));
    tmpRoots.push(parent);
    const treeRoot = path.join(parent, name);
    const sqlDir = path.join(treeRoot, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    if (hasFile) fs.writeFileSync(path.join(sqlDir, '670-a.sql'), '-- noop\n');
    return parent;
  }

  beforeEach(() => {
    delete process.env.PAPERCUSP_RELEASE_ROOT;
    delete process.env.PAPERCUSP_CANONICAL_TREE;
  });

  afterEach(() => {
    for (const p of tmpRoots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    if (savedReleaseRootEnv === undefined) delete process.env.PAPERCUSP_RELEASE_ROOT;
    else process.env.PAPERCUSP_RELEASE_ROOT = savedReleaseRootEnv;
    if (savedCanonicalTreeEnv === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
    else process.env.PAPERCUSP_CANONICAL_TREE = savedCanonicalTreeEnv;
  });

  it('WI-10005161: a staging-generation serving tree finds the release checkout beside the canonical tree', () => {
    // :3170 serves <ws>/papercusp-staging.generations/.candidate-<sha>.<rand>/checkout
    // (95-bundled-entry exports it via `pwd -P`). Its parent holds no release checkout;
    // the box's release checkout sits beside the canonical edit tree.
    const ws = makeTree('papercusp', false);
    fs.mkdirSync(path.join(ws, 'papercup-release/libs/papercusp/libs/db/sql'), { recursive: true });
    const generationSqlDir = path.join(
      ws,
      'papercusp-staging.generations/.candidate-ab679a25a55f.LcugsF/checkout/libs/papercusp/libs/db/sql',
    );
    fs.mkdirSync(generationSqlDir, { recursive: true });
    // Without the declared edit tree the generation's sibling is all there is → null.
    expect(resolveDeployedSqlDir(generationSqlDir)).toBeNull();
    process.env.PAPERCUSP_CANONICAL_TREE = path.join(ws, 'papercusp');
    expect(resolveDeployedSqlDir(generationSqlDir)).toBe(
      path.join(ws, 'papercup-release/libs/papercusp/libs/db/sql'),
    );
  });

  it('returns null for a bogus sqlDir (no such tree)', () => {
    expect(resolveDeployedSqlDir(null)).toBeNull();
    expect(resolveDeployedSqlDir('/definitely/not/a/real/path/libs/papercusp/libs/db/sql')).toBeNull();
  });

  it('resolves the sibling papercup-release tree when it exists', () => {
    const parent = makeTree('papercusp', false);
    fs.mkdirSync(path.join(parent, 'papercup-release/libs/papercusp/libs/db/sql'), { recursive: true });
    const currentSqlDir = path.join(parent, 'papercusp/libs/papercusp/libs/db/sql');
    expect(resolveDeployedSqlDir(currentSqlDir)).toBe(
      path.join(parent, 'papercup-release/libs/papercusp/libs/db/sql'),
    );
  });

  it('resolves to itself when the current tree IS the release checkout', () => {
    // If this process is already running FROM papercup-release, its parent's
    // "papercup-release" sibling is itself — deployedSqlDir === sqlDir (no noise).
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-test-'));
    tmpRoots.push(parent);
    const releaseSqlDir = path.join(parent, 'papercup-release/libs/papercusp/libs/db/sql');
    fs.mkdirSync(releaseSqlDir, { recursive: true });
    expect(resolveDeployedSqlDir(releaseSqlDir)).toBe(releaseSqlDir);
  });

  it('returns null when there is no papercup-release sibling at all', () => {
    const parent = makeTree('papercusp', false);
    const currentSqlDir = path.join(parent, 'papercusp/libs/papercusp/libs/db/sql');
    expect(resolveDeployedSqlDir(currentSqlDir)).toBeNull();
  });
});

/**
 * EI-18757486483124756: `resolveCanonicalStagingSqlDir` resolves the CANONICAL
 * edit tree from `PAPERCUSP_CANONICAL_TREE`, with
 * `PAPERCUSP_INTEGRATION_ROOT` as a legacy fallback — unlike
 * `resolveDeployedSqlDir`, it does NOT derive from whichever tree is serving.
 */
describe('resolveCanonicalStagingSqlDir', () => {
  const tmpRoots: string[] = [];
  const savedEnv = process.env.PAPERCUSP_INTEGRATION_ROOT;
  const savedCanonicalTree = process.env.PAPERCUSP_CANONICAL_TREE;

  beforeEach(() => {
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    delete process.env.PAPERCUSP_CANONICAL_TREE;
  });

  afterEach(() => {
    for (const p of tmpRoots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = savedEnv;
    if (savedCanonicalTree === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
    else process.env.PAPERCUSP_CANONICAL_TREE = savedCanonicalTree;
  });

  it('returns null when neither canonical-root environment variable is set', () => {
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    delete process.env.PAPERCUSP_CANONICAL_TREE;
    expect(resolveCanonicalStagingSqlDir()).toBeNull();
  });

  it('resolves libs/papercusp/libs/db/sql under PAPERCUSP_INTEGRATION_ROOT when it exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-canonical-'));
    tmpRoots.push(root);
    const sqlDir = path.join(root, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
    expect(resolveCanonicalStagingSqlDir()).toBe(sqlDir);
  });

  it('prefers PAPERCUSP_CANONICAL_TREE over a serving mirror in PAPERCUSP_INTEGRATION_ROOT', () => {
    const canonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-edit-tree-'));
    const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-serving-mirror-'));
    tmpRoots.push(canonicalRoot, mirrorRoot);
    const canonicalSqlDir = path.join(canonicalRoot, 'libs/papercusp/libs/db/sql');
    const mirrorSqlDir = path.join(mirrorRoot, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(canonicalSqlDir, { recursive: true });
    fs.mkdirSync(mirrorSqlDir, { recursive: true });
    process.env.PAPERCUSP_CANONICAL_TREE = canonicalRoot;
    process.env.PAPERCUSP_INTEGRATION_ROOT = mirrorRoot;

    expect(resolveCanonicalStagingSqlDir()).toBe(canonicalSqlDir);
  });

  it('does not fall back to a serving mirror when the canonical edit tree has no sql dir', () => {
    const canonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-canonical-empty-'));
    const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-serving-mirror-'));
    tmpRoots.push(canonicalRoot, mirrorRoot);
    fs.mkdirSync(path.join(mirrorRoot, 'libs/papercusp/libs/db/sql'), { recursive: true });
    process.env.PAPERCUSP_CANONICAL_TREE = canonicalRoot;
    process.env.PAPERCUSP_INTEGRATION_ROOT = mirrorRoot;

    expect(resolveCanonicalStagingSqlDir()).toBeNull();
  });

  it('returns null when PAPERCUSP_INTEGRATION_ROOT is set but has no sql dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-canonical-empty-'));
    tmpRoots.push(root);
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
    expect(resolveCanonicalStagingSqlDir()).toBeNull();
  });

  it('is independent of the CURRENT tree — unlike resolveDeployedSqlDir, it does not derive from a sibling', () => {
    // Simulate the exact bug: PAPERCUSP_INTEGRATION_ROOT names a tree that is
    // NOT any sibling relationship of "current" — it is found directly.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-drift-canonical-direct-'));
    tmpRoots.push(root);
    const sqlDir = path.join(root, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    fs.writeFileSync(path.join(sqlDir, '680-new.sql'), '-- noop\n');
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
    expect(resolveCanonicalStagingSqlDir()).toBe(sqlDir);
  });
});
