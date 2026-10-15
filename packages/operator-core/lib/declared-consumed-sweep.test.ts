/**
 * P-002 — the declared-vs-consumed sweep's predicates.
 *
 * Every test below locks a distinction whose LOSS produces a green gate over a
 * real defect. Four of them are regression tests in the literal sense: the sweep
 * shipped each of these false verdicts during its own construction, and a green
 * run is what reported them. That is the point worth preserving — the gate was
 * only trustworthy once it FAILED on a field a human had already proven dead, so
 * these cases pin the failure, not the pass.
 */
// prettier-ignore — ENFORCES the "ONE line" rule below rather than merely documenting it:
// prettier wants to reflow this import into a multi-line list, which is exactly what unguards
// the specifier. It sits above the pair because @ts-ignore must own the slot nearest the import.
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs gate script, no .d.ts. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build. This file was the ONE sibling missing this warning, and is the one P-007 copied the preamble from (EI-20003406761040732).
import { stripComments, blankQuotedStrings, interfaceRanges, classifyTsField, classifySqlColumn, judgeConsumption, rollupSweep, looksGenerated, isBuildOutput, isTestFile, DECLARED_FIELDS, DECLARED_COLUMNS } from '../../../scripts/check-declared-consumed.mjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('judgeConsumption — the four-way split', () => {
  it('needs BOTH ends of the wire to call a field consumed', () => {
    expect(judgeConsumption({ declarations: 1, writes: 2, reads: 3 })).toBe('consumed');
  });

  it('WI-6444 shape: written and never read is write-only, not consumed', () => {
    expect(judgeConsumption({ declarations: 1, writes: 6, reads: 0 })).toBe('write-only');
  });

  it('WI-6465 shape: read and never written is read-only, not consumed', () => {
    expect(judgeConsumption({ declarations: 1, writes: 0, reads: 4 })).toBe('read-only');
  });

  it('declared and untouched at both ends is inert', () => {
    expect(judgeConsumption({ declarations: 1, writes: 0, reads: 0 })).toBe('inert');
  });

  /**
   * The static analogue of P-001's `no-data`. Zero writes and zero reads against
   * zero DECLARATIONS is not a defect report — it is the gate describing a target
   * that no longer exists. Collapsing it into `inert` sends someone hunting for a
   * consumer of a field that was renamed away.
   */
  it('distinguishes "nothing uses it" from "it is not there any more"', () => {
    expect(judgeConsumption({ declarations: 0, writes: 0, reads: 0 })).toBe('not-declared');
    expect(judgeConsumption({ declarations: 0, writes: 0, reads: 0 })).not.toBe('inert');
  });
});

describe('vacuous pass (1) — a declaration is not a use', () => {
  const src = `
export interface CellSpec {
  cell: string;
  unknownHoist?: string;
  ordered?: { stages: string[] };
}

export const GIT_CELL = {
  cell: 'git.pipelinePosition',
  unknownHoist: 'positionsUnknown',
};
`;

  it('reads an interface property as a declaration and an object-literal property as a write', () => {
    const c = classifyTsField(src, 'unknownHoist');
    expect(c.declarations).toHaveLength(1);
    expect(c.writes).toHaveLength(1);
    expect(c.reads).toHaveLength(0);
  });

  it('does not let the declaration alone make a field look consumed', () => {
    const only = classifyTsField('interface S {\n  ordered?: { stages: string[] };\n}', 'ordered');
    expect(only.declarations).toHaveLength(1);
    expect(only.writes).toHaveLength(0);
    expect(only.reads).toHaveLength(0);
    expect(judgeConsumption({ declarations: 1, writes: 0, reads: 0 })).toBe('inert');
  });

  /**
   * A property is recognised only at the START of a line. Real declarations and
   * real registrations are formatted that way; a one-line `{ ordered: 1 }` is
   * missed. The miss is deliberate and safe in the ONE direction that matters:
   * an unseen write leaves the field looking read-only or not-declared, both of
   * which FAIL loudly. There is no formatting that turns a miss into a pass.
   */
  it('misses a mid-line property, and fails rather than passes when it does', () => {
    expect(classifyTsField('const x = { ordered: 1 };', 'ordered').writes).toHaveLength(0);
    expect(judgeConsumption({ declarations: 0, writes: 0, reads: 0 })).not.toBe('consumed');
  });

  it('tracks the interface body by brace depth, so a later literal is still a write', () => {
    const ranges = interfaceRanges(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(2);
    expect(ranges[0].end).toBe(6);
  });

  it('does not treat an unbraced type alias as a declaration body', () => {
    const src = ["type Verdict = 'a' | 'b';", 'const x = {', '  ordered: 1,', '};'].join('\n');
    expect(interfaceRanges(src)).toHaveLength(0);
    // Outside any interface body, the property is a WRITE, not a declaration.
    const c = classifyTsField(src, 'ordered');
    expect(c.writes).toEqual([3]);
    expect(c.declarations).toHaveLength(0);
  });
});

describe('vacuous pass (2) — a comment is not a use', () => {
  it('ignores a property access that only appears in a docblock', () => {
    const src = [
      '/** `key` is the declared field name (`spec.unknownHoist`) — carried rather than',
      ' *  recomputed. See also spec.unknownHoist above. */',
      'const x = 1;',
    ].join('\n');
    expect(classifyTsField(src, 'unknownHoist').reads).toHaveLength(0);
  });

  it('ignores a field named inside a line comment', () => {
    expect(classifyTsField('// spec.materiality is resolved later\nconst y = 2;', 'materiality').reads).toHaveLength(0);
  });

  /** cell-registry.ts names `materiality` in nine rejection MESSAGES. */
  it('ignores a field named inside a quoted rejection message', () => {
    const src = "reject('materiality', 'materiality-path-missing', 'materiality must name a `path`.');";
    expect(classifyTsField(src, 'materiality').reads).toHaveLength(0);
  });

  it('preserves line numbers while blanking, so reported sites stay accurate', () => {
    const src = 'const a = 1;\n/* spec.ordered\n   spec.ordered */\nconst b = spec.ordered;';
    const c = classifyTsField(src, 'ordered');
    expect(c.reads).toEqual([4]);
  });

  it('leaves template literals intact — SQL lives in them', () => {
    const src = 'const q = `SELECT superseded_at FROM agent_facts`;';
    expect(stripComments(src)).toContain('superseded_at');
    expect(blankQuotedStrings(src)).toContain('superseded_at');
  });

  it('blanks the contents of quoted strings but keeps their length', () => {
    const src = "const a = 'materiality';";
    expect(blankQuotedStrings(src)).toHaveLength(src.length);
    expect(blankQuotedStrings(src)).not.toContain('materiality');
  });
});

describe('vacuous pass (3) — the declaring module is not a consumer', () => {
  /**
   * `validateCellSpec` reads `spec.unknownHoist` twice, in the same file that
   * declares it. Counting those, the sweep stays green after the real emission
   * in cell-read.ts is deleted — i.e. it fails to re-derive WI-6444, the one
   * thing it must do. This test pins the two halves the sweep must keep apart.
   */
  it('sees the validator read, which is why the caller must exclude the declaring file', () => {
    const declaringModule = `
export interface CellSpec {
  unknownHoist?: string;
}
export function validateCellSpec(spec: CellSpec) {
  if (spec.nullable && !spec.unknownHoist?.trim()) return ['unknown-not-hoisted'];
  if (!spec.nullable && spec.unknownHoist) return ['hoist-without-nullable'];
  return [];
}`;
    const c = classifyTsField(declaringModule, 'unknownHoist');
    expect(c.declarations).toHaveLength(1);
    expect(c.reads).toHaveLength(2);

    // Excluded (what the sweep does) the field has no consumer at all.
    expect(judgeConsumption({ declarations: 1, writes: 0, reads: 0 })).toBe('inert');
    // Counted, the very same field reads as fully consumed. That is the trap.
    expect(judgeConsumption({ declarations: 1, writes: 1, reads: c.reads.length })).toBe('consumed');
  });

  it('every declared field names the module the exclusion applies to', () => {
    for (const f of DECLARED_FIELDS) {
      expect(f.declaredIn, `${f.id} must declare its home module`).toMatch(/\.ts$/);
    }
  });
});

describe('vacuous pass (4)+(5) — retired and generated code are not consumers', () => {
  it('skips retired surfaces', () => {
    expect(DECLARED_FIELDS.length).toBeGreaterThan(0);
    // `_retired` is in SKIP_DIRS; assert via the walker's contract on test files.
    expect(isTestFile('packages/operator-core/lib/cell-read.test.ts')).toBe(true);
    expect(isTestFile('packages/operator-core/lib/cell-read.ts')).toBe(false);
    expect(isTestFile('apps/operator/e2e/thing.spec.ts')).toBe(true);
  });

  /**
   * THE ONE THAT ACTUALLY FIRED. The sweep's first green run reported
   * `CellSpec.ordered` as consumed with 46 readers; all 46 were `.ordered` inside
   * checked-in storybook webpack bundles. Minified code collides with everything,
   * so a bundle in the tree can vouch for any field name at all.
   */
  it('recognises a minified bundle by line length, not by path', () => {
    expect(looksGenerated(`const a=1;${'x'.repeat(3000)}\n`)).toBe(true);
    expect(looksGenerated('const a = 1;\nconst b = spec.ordered;\n')).toBe(false);
    expect(looksGenerated('short file, no newline at all')).toBe(false);
  });

  /**
   * THE ONE THAT FIRED SECOND, in the opposite direction (EI-19409948281572150).
   * "Has one long line" is not "is minified". `cell-registrations.ts` carries a
   * single 2657-char prose `why:` string in a 628-line hand-written file — 6.9%
   * of its bytes — and the presence-based form dropped the whole file. That file
   * is the ONLY writer of `CellSpec.unknownHoist` and `CellSpec.materiality`, so
   * the sweep reported both as 0-writer "read-only" and red-pinned the fleet gate
   * on fields written 7 and 1 times.
   *
   * This is the dangerous direction precisely because a skipped file is
   * indistinguishable from an absent one: the sweep under-scans in SILENCE.
   */
  it('does NOT treat a source file with one long prose literal as generated', () => {
    // Shape of cell-registrations.ts: one very long line, overwhelmingly normal source.
    const source = `${'const line = 1;\n'.repeat(600)}const why = '${'p'.repeat(2657)}';\n`;
    expect(looksGenerated(source)).toBe(false);

    // And the guard still catches the real thing: a bundle is long lines ALL THE WAY DOWN.
    expect(looksGenerated(`${'y'.repeat(3000)}\n${'z'.repeat(3000)}\n`)).toBe(true);
  });

  /**
   * The discriminator is DOMINANCE of long-line bytes, so the verdict must turn
   * on the ratio rather than on any single line — pinned in both directions so a
   * future tweak cannot quietly restore presence-based detection.
   */
  it('splits generated from source on long-line byte SHARE', () => {
    const longLine = `${'x'.repeat(3000)}\n`;
    const shortLine = 'const a = 1;\n';
    // ~99% long-line bytes → generated.
    expect(looksGenerated(longLine + shortLine.repeat(5))).toBe(true);
    // Same single long line diluted by ordinary source → NOT generated.
    expect(looksGenerated(longLine + shortLine.repeat(400))).toBe(false);
  });

  /**
   * THE ONE THAT NEARLY SHIPPED (EI-19409948281572150). A BUNDLED-BUT-NOT-MINIFIED
   * artifact defeats every line-shape test there is: `dist-host/hono-host.mjs` is
   * 62.9 MB across 1,219,924 lines with only 14.4% of its bytes in long lines —
   * shaped exactly like source. Admitting it contributed 412 writes and 1,802
   * reads of `summary` on its own and flipped every column row to a confident
   * "consumed", which is the storybook defect at 40x scale: it GREENS the gate by
   * manufacturing consumers.
   *
   * Shape cannot catch it, so location must. This test is why `isBuildOutput`
   * exists; delete it and the sweep starts vouching for fields nothing reads.
   */
  it('excludes build output by LOCATION, since shape cannot catch a non-minified bundle', () => {
    expect(isBuildOutput('apps/operator/dist-host/hono-host.mjs')).toBe(true);
    expect(isBuildOutput('apps/operator/dist-devhost/server.mjs')).toBe(true);
    expect(isBuildOutput('apps/operator/dist-hosted-control-plane/serve.mjs')).toBe(true);
    expect(isBuildOutput('apps/operator-vite/dist/assets/DevAdminRail-BAsNLrF6.js')).toBe(true);
    expect(isBuildOutput('libs/agent-chat/storybook-static/assets/PatchBlock.stories.js')).toBe(true);
    expect(isBuildOutput('apps/operator/public/docs/pagefind/pagefind-highlight.js')).toBe(true);

    // The drizzle mirror is generated but lives outside any build dir, and column
    // scoping is FILE-level — one file naming every table makes every column look
    // consumed (measured: workspace_id 1W/12R reported as 123W/2566R).
    expect(isBuildOutput('libs/papercusp/libs/db/src/schema/generated.ts')).toBe(true);
    expect(isBuildOutput('libs/papercusp/libs/db/src/schema/schema.ts')).toBe(true);

    // Real source must NOT be excluded — matching is on a path SEGMENT, so a
    // substring like `distributed-` never trips it.
    expect(isBuildOutput('packages/operator-core/lib/cell-registrations.ts')).toBe(false);
    expect(isBuildOutput('libs/flags/src/types.ts')).toBe(false);
    expect(isBuildOutput('packages/operator-core/lib/distributed-lock.ts')).toBe(false);
    expect(isBuildOutput('apps/operator/scripts/psu-launcher.mjs')).toBe(false);
  });
});

describe('vacuous pass (6) — a spread is not a property access', () => {
  /**
   * `[...ordered.map(f)]` in an unrelated codegen script was the single "read"
   * that kept CellSpec.ordered green after the bundles were excluded. One
   * false positive was enough to hide the defect completely.
   */
  it('does not count the third dot of a spread as a member access', () => {
    expect(classifyTsField('const out = [...ordered.map(serializeDomain)];', 'ordered').reads).toHaveLength(0);
  });

  it('still counts a genuine member access, including optional chaining', () => {
    expect(classifyTsField('const a = spec.ordered;', 'ordered').reads).toEqual([1]);
    expect(classifyTsField('const a = spec?.ordered;', 'ordered').reads).toEqual([1]);
    expect(classifyTsField('const a = cell.spec.ordered;', 'ordered').reads).toEqual([1]);
  });

  it('does not match a field name that is merely a suffix of another', () => {
    expect(classifyTsField('const a = x.reordered;', 'ordered').reads).toHaveLength(0);
  });

  it('separates assignment from comparison', () => {
    expect(classifyTsField('spec.ordered = next;', 'ordered').writes).toEqual([1]);
    expect(classifyTsField('if (spec.ordered === next) {}', 'ordered').reads).toEqual([1]);
    expect(classifyTsField('if (spec.ordered => next) {}', 'ordered').reads).toEqual([1]);
  });
});

describe('classifySqlColumn — write clauses vs read clauses', () => {
  it('reads an UPDATE ... SET as a write', () => {
    const src = 'const q = `UPDATE harness_shared.agent_facts SET superseded_at = COALESCE(superseded_at, now()) WHERE id = $1`;';
    const c = classifySqlColumn(src, 'superseded_at');
    expect(c.writes.length).toBeGreaterThan(0);
  });

  it('reads an INSERT column list as a write', () => {
    const src = 'const q = `INSERT INTO harness_shared.agent_plane_measurements (workspace_id, interpretable_count, metric_count) VALUES ($1,$2,$3)`;';
    expect(classifySqlColumn(src, 'interpretable_count').writes.length).toBeGreaterThan(0);
  });

  it('reads a WHERE predicate as a read, not a write', () => {
    const src = 'const q = `SELECT id FROM harness_shared.agent_facts WHERE superseded_at IS NULL`;';
    const c = classifySqlColumn(src, 'superseded_at');
    expect(c.reads.length).toBeGreaterThan(0);
    expect(c.writes).toHaveLength(0);
  });

  it('reads a select-list projection as a read', () => {
    const src = 'const q = `SELECT superseded_at::text AS superseded_at FROM harness_shared.agent_facts`;';
    expect(classifySqlColumn(src, 'superseded_at').reads.length).toBeGreaterThan(0);
  });

  /** A row type mirroring the column does not touch it — (1) in SQL costume. */
  it('skips a column name that is only a field on a row interface', () => {
    const src = 'export interface FactRow {\n  superseded_at: string | null;\n}';
    const c = classifySqlColumn(src, 'superseded_at');
    expect(c.reads).toHaveLength(0);
    expect(c.writes).toHaveLength(0);
  });

  it('ignores a column named only in a comment', () => {
    const src = '// superseded_at IS NULL is the current-fact filter\nconst a = 1;';
    const c = classifySqlColumn(src, 'superseded_at');
    expect(c.reads).toHaveLength(0);
    expect(c.writes).toHaveLength(0);
  });
});

describe('rollupSweep — what fails the build', () => {
  const row = (over: Record<string, unknown>) => ({ id: 'x', verdict: 'consumed', ...over });

  it('passes when everything is consumed', () => {
    const roll = rollupSweep([row({}), row({ id: 'y' })]);
    expect(roll.consumed).toBe(2);
    expect(roll.failures).toHaveLength(0);
  });

  it('fails on an unexplained unconsumed field', () => {
    const roll = rollupSweep([row({ id: 'dead', verdict: 'write-only' })]);
    expect(roll.failures).toHaveLength(1);
    expect(roll.failures[0].id).toBe('dead');
  });

  /**
   * A filed, owned gap is REPORTED, never re-failed — re-failing the build for a
   * known-open bug is how a gate becomes noise the fleet routes around, which is
   * what nearly killed lint:no-bespoke-state-read (WI-6464).
   */
  it('reports a knownUnbuilt gap without failing the build', () => {
    const roll = rollupSweep([row({ id: 'ordered', verdict: 'write-only', knownUnbuilt: 'WI-6473' })]);
    expect(roll.failures).toHaveLength(0);
    expect(roll.knownUnbuilt).toBe(1);
  });

  it('surfaces a stale row separately from a missing consumer', () => {
    const roll = rollupSweep([row({ id: 'gone', verdict: 'not-declared' })]);
    expect(roll.stale).toHaveLength(1);
    expect(roll.failures).toHaveLength(0);
  });
});

describe('the census rows themselves', () => {
  it('gives every target a stated consequence, so no field is watched by nobody', () => {
    for (const t of [...DECLARED_FIELDS, ...DECLARED_COLUMNS]) {
      expect(t.why, `${t.id} must say what breaks`).toBeTruthy();
      expect((t.why as string).length).toBeGreaterThan(40);
    }
  });

  it('scopes every column to the table that owns it', () => {
    for (const c of DECLARED_COLUMNS) {
      expect(c.table, `${c.id} must name its table`).toBeTruthy();
      expect(c.id).toBe(`${c.table}.${c.name}`);
      expect(c.migration).toMatch(/^\d{3}-.*\.sql$/);
    }
  });

  /**
   * THE COVERAGE VACUITY. Every rule above stops the sweep lying about a field it
   * WATCHES; none of them stop it from watching the wrong set. A new optional
   * field added to `CellSpec` tomorrow is exactly the WI-6444 risk surface, and
   * with no row here it is unwatched — the gate stays green while the defect
   * class it exists for walks straight past it. `assessment` is the one retained
   * required-field row: requiring its producer prevents an unwritten value, but
   * does not prevent its consumer from being deleted. So the field list is
   * checked against the real interface rather than maintained by hope.
   */
  it('watches EVERY optional field plus the required assessment consumer, not a snapshot of them', () => {
    const source = readFileSync(new URL('./cell-registry.ts', import.meta.url), 'utf8');
    const body = stripComments(source).split('export interface CellSpec {')[1]?.split('\n}')[0];
    expect(body, 'CellSpec interface not found — this test is watching nothing').toBeTruthy();

    const optional = [...body.matchAll(/^\s{2}([a-zA-Z_][\w]*)\?\s*:/gm)].map((m) => m[1]).sort();
    const watched = DECLARED_FIELDS.map((f: { name: string }) => f.name).sort();
    const requiredConsumerGuards = ['assessment'];

    expect(optional.length).toBeGreaterThan(0);
    expect(watched).toEqual([...optional, ...requiredConsumerGuards].sort());
  });

  it('covers all three migrations this plane shipped', () => {
    const migs = new Set(DECLARED_COLUMNS.map((c: { migration: string }) => c.migration.slice(0, 3)));
    expect(migs).toEqual(new Set(['689', '694', '697']));
  });
});
