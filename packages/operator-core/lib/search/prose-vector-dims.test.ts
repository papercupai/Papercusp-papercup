/**
 * The STORAGE half of D-001's guard.
 *
 * D-001 (prose-embedding-384-untrained-mrl-fix-2026-08-02) made every embedder
 * DECLARE the width it emits, and made the builders derive their constant from
 * that declaration so the two could not drift. It left the other side of the
 * contract unguarded: nothing asserted that the width a mode emits is the width
 * the database columns can actually hold. They agreed only by coincidence —
 * every mode happened to be 384 — and `384` was restated in seven files.
 *
 * That gap is not theoretical. A width mismatch does not throw at startup; it
 * surfaces either as a pgvector INSERT error inside a background sweep nobody
 * is watching, or — the quieter and worse case — as a dims guard that skips
 * every prose surface, which is indistinguishable from "embeddings are turned
 * off". These tests make the disagreement red HERE instead.
 */

import { describe, it, expect } from 'vitest';
import {
  EMBEDDER_DIM_SPECS,
  isTrainedDim,
  MODE_DIMS,
  VEC_TABLE,
  type EmbedderMode,
} from '@papercusp/memory';
import {
  PROSE_VECTOR_DIMS,
  PROSE_ELIGIBLE_MODES,
  PROSE_VECTOR_COLUMNS,
  PROSE_MEMORY_VEC_COLUMNS,
  WIDTH_MIGRATION_WIPE_SET,
  PROSE_VECTOR_STORAGE_PROFILE,
  fitsProseColumns,
  computeProseColumnWidthSkew,
  modeTargetDims,
  resolveProseProfileSelection,
  resolveCurrentProseProfileSelection,
  resolveAcceptedProseProfileSelection,
  storedProseIdentityMatches,
  validateProseStorageCompatibility,
} from './prose-vector-dims';
// The sweep that has to REFILL whatever a width migration wipes — asserted
// against the widened set below, so the two lists cannot drift apart again.
import { TARGETS } from './embed-backfill';
// Personal Vault is intentionally not part of TARGETS: its dedicated target
// hard-pins the local-only EmbeddingGemma path and is invoked as a separate leg.
import { PERSONAL_EMBED_TARGET } from '../personal-vault/embedding';

const REFILL_TARGETS = [...TARGETS, PERSONAL_EMBED_TARGET];

describe('the prose column width contract', () => {
  it('declares accepted profile identity independently from emitting profiles', () => {
    expect(PROSE_VECTOR_STORAGE_PROFILE.dimensions).toBe(PROSE_VECTOR_DIMS);
    for (const mode of PROSE_ELIGIBLE_MODES) {
      const profile = EMBEDDER_DIM_SPECS[mode];
      expect(validateProseStorageCompatibility(profile), `${mode}: ${profile.profileId}`).toEqual([]);
      expect(PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds).toContain(profile.profileId);
    }
  });

  it('rejects an equal-width, equal-metric profile whose exact identity is not accepted', () => {
    const current = EMBEDDER_DIM_SPECS.gemma;
    expect(
      validateProseStorageCompatibility({
        profileId: 'gemma-embeddinggemma-300m-768@v2',
        targetDims: current.targetDims,
        distanceMetric: current.distanceMetric,
      }),
    ).toEqual([
      expect.stringContaining('does not accept profile gemma-embeddinggemma-300m-768@v2'),
    ]);
  });

  it('maps a legacy mode tag only to that mode\'s declared current profile', () => {
    const current = resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma);
    expect(current).toEqual({
      profileId: EMBEDDER_DIM_SPECS.gemma.profileId,
      legacyMode: 'gemma',
    });
    expect(storedProseIdentityMatches({ profileId: null, mode: 'gemma' }, current!)).toBe(true);
    expect(storedProseIdentityMatches({ profileId: null, mode: 'openai' }, current!)).toBe(false);

    // Mutation/control: the alternate has the same mode, width and metric. It
    // cannot borrow legacy rows merely because those weaker properties match.
    const alternate = {
      ...current!,
      profileId: 'gemma-embeddinggemma-300m-768@v2' as const,
      legacyMode: null,
    };
    expect(storedProseIdentityMatches({ profileId: null, mode: 'gemma' }, alternate)).toBe(false);
    expect(
      storedProseIdentityMatches(
        { profileId: 'gemma-embeddinggemma-300m-768@v2', mode: 'gemma' },
        alternate,
      ),
    ).toBe(true);
  });

  it('resolves mode-shaped diagnostic inputs only to their declared current profile', () => {
    expect(resolveCurrentProseProfileSelection('gemma')).toEqual({
      profileId: EMBEDDER_DIM_SPECS.gemma.profileId,
      legacyMode: 'gemma',
    });
    expect(resolveCurrentProseProfileSelection('local')).toBeNull();
    expect(resolveCurrentProseProfileSelection('future-mode')).toBeNull();
  });

  it('resolves an accepted exact id with only its canonical legacy fallback', () => {
    expect(resolveAcceptedProseProfileSelection(EMBEDDER_DIM_SPECS.openai.profileId)).toEqual({
      profileId: EMBEDDER_DIM_SPECS.openai.profileId,
      legacyMode: 'openai',
    });
    expect(resolveAcceptedProseProfileSelection('unknown-profile@v1')).toBeNull();
  });

  it('every prose-eligible mode emits EXACTLY the column width', () => {
    for (const mode of PROSE_ELIGIBLE_MODES) {
      expect(
        modeTargetDims(mode),
        `${mode} is declared prose-eligible but emits ${modeTargetDims(mode)} dims, ` +
          `while the prose columns are vector(${PROSE_VECTOR_DIMS}). Either its targetDims ` +
          `changed without the migration that widens the columns, or it should be removed ` +
          `from PROSE_ELIGIBLE_MODES.`,
      ).toBe(PROSE_VECTOR_DIMS);
    }
  });

  /**
   * The converse, and the one that catches the DANGEROUS direction: someone
   * widens a model to match the columns and forgets that this also makes it a
   * legal prose writer. Without this, the new mode's vectors would be stored
   * by the backfill sweep while the readers' eligibility list still excluded
   * it — a silent mixed-space column.
   */
  it('the eligible list is EXACTLY the set of modes that fit — no mode fits silently', () => {
    const actuallyFits = (Object.keys(EMBEDDER_DIM_SPECS) as EmbedderMode[])
      .filter((m) => EMBEDDER_DIM_SPECS[m].targetDims === PROSE_VECTOR_DIMS)
      .sort();
    expect(
      actuallyFits,
      'A mode now emits the prose column width but is not listed in PROSE_ELIGIBLE_MODES ' +
        '(or is listed but no longer fits). The list is a physical constraint, not a preference — ' +
        'update it in the same change that moved the width.',
    ).toEqual([...PROSE_ELIGIBLE_MODES].sort());
  });

  it('the width a prose-eligible mode emits is one it was actually TRAINED to emit', () => {
    // The original bug: 384 was a legal-looking prefix of gemma's 768 that the
    // model was never trained to nest at. A prose-eligible mode must not be
    // storing an untrained cut, whatever the column happens to be.
    for (const mode of PROSE_ELIGIBLE_MODES) {
      const spec = EMBEDDER_DIM_SPECS[mode];
      expect(
        isTrainedDim(spec, PROSE_VECTOR_DIMS),
        `${mode} (${spec.model}) would store an UNTRAINED ${PROSE_VECTOR_DIMS}-dim cut ` +
          `(native ${spec.nativeDims}, mrl '${spec.mrl}', trained at ${spec.trainedDims.join('/')}). ` +
          `That is the exact defect EI-19301722864393687 was filed for.`,
      ).toBe(true);
    }
  });

  it('no prose-eligible mode carries a stale untrainedCut acknowledgement', () => {
    for (const mode of PROSE_ELIGIBLE_MODES) {
      expect(EMBEDDER_DIM_SPECS[mode].untrainedCut, `${mode} fits the columns at a trained width, so its untrainedCut ack is stale — it would pre-authorize the NEXT untrained cut (D-001)`).toBeUndefined();
    }
  });

  it('modes that cannot emit the column width are excluded, with local named explicitly', () => {
    // Regression pin for D-005 §6. bge-small is natively 384 with no MRL, so a
    // 768 column makes it prose-ineligible. If someone "fixes" that by adding
    // local back to the list, the first test above reds — but pin the reason
    // here so the intent is legible rather than inferred from a failure.
    expect(EMBEDDER_DIM_SPECS.local.mrl).toBe('none');
    expect(EMBEDDER_DIM_SPECS.local.nativeDims).toBe(384);
    expect((PROSE_ELIGIBLE_MODES as readonly string[]).includes('local')).toBe(false);
    expect((PROSE_ELIGIBLE_MODES as readonly string[]).includes('harrier')).toBe(false);
  });

  it('fitsProseColumns is the dims guard, and rejects the near-miss widths', () => {
    expect(fitsProseColumns(PROSE_VECTOR_DIMS)).toBe(true);
    // The three widths that actually show up in this codebase's history.
    expect(fitsProseColumns(384)).toBe(false); // the old untrained cut
    expect(fitsProseColumns(512)).toBe(false); // the trained dim D-005 rejected
    expect(fitsProseColumns(1024)).toBe(false); // harrier / qwen3 native
  });

  /**
   * WI-7327. THE regression guard for the 9.5h silent outage, and the reason
   * `computeProseColumnWidthSkew` exists at all.
   *
   * The outage shape: `PROSE_VECTOR_DIMS` was raised to 768 and shipped while
   * the columns were still vector(384). The embedder then emitted 768, the
   * constant said 768, and `fitsProseColumns` — which only ever compares those
   * two — returned TRUE. The sweep proceeded and every single UPDATE was
   * rejected by pgvector, swallowed by a per-row catch, producing zero rows
   * written and zero log output for nine and a half hours.
   *
   * This test asserts the trap explicitly: the old guard PASSES on the outage
   * input (that is not a bug in it, it is its scope), and the new one CATCHES
   * it. If someone ever "simplifies" the width check back into
   * `fitsProseColumns`, this fails.
   */
  it('catches the constant-moved-but-migration-did-not skew that fitsProseColumns cannot see', () => {
    const liveColumnsStillAtOldWidth = PROSE_VECTOR_COLUMNS.map((c) => ({
      table: c.table,
      column: c.column,
      dims: 384,
    }));

    // The emitter agrees with the constant, so the cheap guard sees nothing wrong.
    expect(
      fitsProseColumns(PROSE_VECTOR_DIMS),
      'fitsProseColumns compares the embedder to the CONSTANT, so it passes here by construction',
    ).toBe(true);

    // The live-schema guard is the one that can see it.
    const skew = computeProseColumnWidthSkew(liveColumnsStillAtOldWidth);
    expect(
      skew.length,
      'every prose column is at the old width while the code emits the new one — ' +
        'this is the exact WI-7327 total-failure state and it must not be silent',
    ).toBe(PROSE_VECTOR_COLUMNS.length);
    for (const s of skew) {
      expect(s.liveDims).toBe(384);
      expect(s.declaredDims).toBe(PROSE_VECTOR_DIMS);
    }
  });

  it('reports NO skew when the live schema matches the declared width', () => {
    const healthy = PROSE_VECTOR_COLUMNS.map((c) => ({
      table: c.table,
      column: c.column,
      dims: PROSE_VECTOR_DIMS,
    }));
    expect(computeProseColumnWidthSkew(healthy)).toEqual([]);
  });

  it('treats an UNMEASURED column as unjudgeable, never as skew', () => {
    // A table that does not exist yet (an older DB, or a surface added later) is
    // simply absent from the catalog probe. Reporting absence as skew would turn
    // "this DB predates the surface" into a false total-failure alarm.
    expect(computeProseColumnWidthSkew([])).toEqual([]);
    // A non-positive/garbage width is likewise unjudgeable rather than skewed:
    // an unconstrained `vector` column reports atttypmod -1.
    expect(
      computeProseColumnWidthSkew([
        { table: 'harness_shared.work_items', column: 'embedding', dims: -1 },
      ]),
    ).toEqual([]);
  });

  /**
   * Units guard. For pgvector, `pg_attribute.atttypmod` holds the dimension
   * DIRECTLY — unlike varchar, where typmod is length + 4. Verified against the
   * live catalog 2026-08-03 (atttypmod 768 <-> `vector(768)`).
   *
   * This pins it because the `+4` convention is the thing a reader is most
   * likely to "remember" and helpfully add — and doing so would make every
   * healthy column report as skewed, i.e. refuse the entire sweep forever. That
   * is a worse outage than the one this guard was built to catch, so it is worth
   * a test of its own.
   */
  it('reads atttypmod as the dimension itself, with no varchar-style +4 offset', () => {
    const asIfPlusFour = computeProseColumnWidthSkew([
      {
        table: 'harness_shared.work_items',
        column: 'embedding',
        dims: PROSE_VECTOR_DIMS + 4,
      },
    ]);
    expect(
      asIfPlusFour,
      'a +4-adjusted width must register as SKEW — if this passes as healthy, ' +
        'the classifier has absorbed a varchar-style offset that pgvector does not use',
    ).toHaveLength(1);
  });

  it('lists every column the width contract covers', () => {
    // A new prose surface added without registering it here would be migrated
    // by hand and could quietly keep a stale width.
    expect(PROSE_VECTOR_COLUMNS.length).toBeGreaterThanOrEqual(5);
    for (const c of PROSE_VECTOR_COLUMNS) {
      expect(c.table.startsWith('harness_shared.'), `${c.table} should be schema-qualified`).toBe(true);
      expect(c.column.length).toBeGreaterThan(0);
    }
    // No duplicates — a repeated entry would make a migration ALTER twice and
    // read as broader coverage than it is.
    const keys = PROSE_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * EI-19374072666153095 — the OTHER half of "a width migration is survivable".
   *
   * A width change necessarily WIPES every column it touches (pgvector cannot
   * cast between widths, so migration 727 ALTERs `USING NULL`). That is only
   * acceptable because the backfill sweep refills them — which is true ONLY for
   * columns the refill paths actually visit. A column in PROSE_VECTOR_COLUMNS but
   * in neither the general TARGETS sweep nor a dedicated target is wiped by the
   * migration and refilled by nothing: a PERMANENT loss dressed up as a temporary
   * degradation.
   *
   * Measured before this guard existed: `code_recipes` (8,165 vectors) and
   * `datatype_registry` (8) were in the widened set and absent from TARGETS,
   * with no other re-embed path. Both are among the exact tables this module's
   * own docblock records as having been silently missed once already, which is
   * why the fix is an assertion rather than two more hand-maintained rows.
  */
  it('every column the migration WIPES has a backfill target that refills it', () => {
    const swept = new Set(REFILL_TARGETS.map((t) => `${t.table}.${t.embedCol}`));
    const memoryVec = new Set(PROSE_MEMORY_VEC_COLUMNS.map((c) => `${c.table}.${c.column}`));
    // The base-table half of the wipe set. memory_vec_* is excluded here because
    // its refill path is a DIFFERENT mechanism (asserted by the two tests below);
    // checking it for TARGETS membership would demand something inexpressible.
    const orphaned = WIDTH_MIGRATION_WIPE_SET.map((c) => `${c.table}.${c.column}`).filter(
      (k) => !memoryVec.has(k) && !swept.has(k),
    );
    expect(
      orphaned,
      `These prose columns are widened (and therefore NULLed) by a width migration but have no ` +
        `registered refill target, so nothing ever refills them — the vectors are lost permanently, ` +
        `not temporarily: ${orphaned.join(', ')}. Add the target to the owning refill path (with ` +
        `the real PRIMARY KEY in keyCols), or remove the column from PROSE_VECTOR_COLUMNS if it is ` +
        `genuinely not a shared prose surface.`,
    ).toEqual([]);
  });

  it('keeps Personal Vault on its dedicated local-only refill path', () => {
    const key = `${PERSONAL_EMBED_TARGET.table}.${PERSONAL_EMBED_TARGET.embedCol}`;
    expect(TARGETS.some((t) => `${t.table}.${t.embedCol}` === key)).toBe(false);
    expect(key).toBe('harness_shared.documents.embedding');
  });

  /**
   * WI-7326 — the OTHER half of the wipe set, and the half that actually lost
   * data. Migration 727 wiped `memory_vec_gemma` + `memory_vec_openai` alongside
   * the prose columns, but the guard above was written against
   * `PROSE_VECTOR_COLUMNS`, which deliberately excludes them. So the wipe set was
   * strictly larger than the set being checked, and the uncovered half went
   * unrefilled: 32,641 memories, 0 vectors, no error and no log line.
   *
   * A membership assertion would be circular here (the same list on both sides),
   * so this asserts the two facts the canonical sweep actually DEPENDS on to
   * write these tables — both silent-failure paths if they drift:
   *
   *   - `VEC_TABLE[mode]` is what `activeVecTable()` resolves; if it did not name
   *     the wiped table the sweep would refill a different one and recall would
   *     stay empty.
   *   - `MODE_DIMS[mode]` is the width guard in `embedAndUpsertVector`, which
   *     returns FALSE (never throws) on a mismatch — so a stale entry here makes
   *     every write a silent no-op, which is exactly the failure vec-write.ts's
   *     own docblock warns is "easy to miss".
   */
  it('every wiped memory_vec_* column is one the canonical sweep can actually write', () => {
    expect(PROSE_MEMORY_VEC_COLUMNS.length).toBe(PROSE_ELIGIBLE_MODES.length);
    for (const mode of PROSE_ELIGIBLE_MODES) {
      expect(
        `harness_shared.${VEC_TABLE[mode]}`,
        `${mode} is prose-eligible, so migration 727 wipes its vec table — but VEC_TABLE ` +
          `does not name the table PROSE_MEMORY_VEC_COLUMNS says was wiped, so the sweep ` +
          `would refill a different table and recall would stay empty.`,
      ).toBe(`harness_shared.memory_vec_${mode}`);
      expect(
        MODE_DIMS[mode],
        `${mode} is prose-eligible (its vec column moved to vector(${PROSE_VECTOR_DIMS}) with ` +
          `the prose columns), but MODE_DIMS says ${MODE_DIMS[mode]}. embedAndUpsertVector ` +
          `RETURNS FALSE on a width mismatch rather than throwing, so every refill write would ` +
          `silently no-op and this mode's recall would never come back.`,
      ).toBe(PROSE_VECTOR_DIMS);
    }
  });

  /**
   * The inverse trap: "fixing" a missing memory_vec refill by adding a TARGETS
   * entry. It type-checks, reads as correct, and is a permanent no-op — the
   * TARGETS sweep only ever runs `UPDATE <table> SET <col>` over rows that
   * already exist, and a width migration DELETEs every row in these join tables
   * (their `vector` is NOT NULL, so `USING NULL` cannot apply). An empty table
   * stays empty forever, with the sweep reporting a clean scanned:0 pass.
   */
  it('memory_vec_* is NOT in TARGETS — an UPDATE sweep can never repopulate an emptied join table', () => {
    const swept = new Set(TARGETS.map((t) => `${t.table}.${t.embedCol}`));
    for (const c of PROSE_MEMORY_VEC_COLUMNS) {
      expect(
        swept.has(`${c.table}.${c.column}`),
        `${c.table}.${c.column} has a TARGETS entry, which cannot work: that sweep UPDATEs ` +
          `existing rows, and a width migration deletes them all. Its refill path is ` +
          `memory/canonical-vec-backfill.ts, which selects on row ABSENCE and re-INSERTs.`,
      ).toBe(false);
    }
  });
});
