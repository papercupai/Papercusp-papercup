/**
 * Coverage for the local rubric store (local-first-party-rubric-bundling-2026-07-07) —
 * the bundled first-party rubrics behind the workspace-store seed. Hermetic where it
 * can be: fixture rubric dirs on disk, roots injected (no PAPERCUSP_RUBRICS_DIR, no
 * DB). Exercises: layered enumeration + user-shadows-bundled, listing.json fallback,
 * ref/id resolution, METHOD.md read, the seed's pure no-clobber/idempotence core — and
 * a build-time guarantee that the REAL in-repo rubrics/ content dirs parse against
 * rubricTemplateDataSchema (what the seed will fail-loud validate at propose time).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listLocalRubrics,
  resolveLocalRubric,
  readLocalRubricMethod,
  rubricsNeedingSeed,
  seedContentHash,
  FIRST_PARTY_RUBRIC_SEED_OWNER,
  type ExistingRubricRow,
  type RubricRoot,
  type SeedableTemplateData,
} from './rubric-store';
import { rubricTemplateDataSchema } from '../agent-tools/plans/rubric-template';

let scratch: string;
let bundled: string;
let user: string;
let roots: RubricRoot[];

const criterion = (key: string) => ({
  key,
  title: `t-${key}`,
  model: 'how it should work',
  method: 'how to check',
  driftMarkers: 'what broken looks like',
});

const manifest = (rubricId: string, extra: object = {}) => ({
  rubricId,
  title: `Rubric ${rubricId}`,
  characteristic: 'agent-behavior',
  description: 'd',
  ratingScale: ['pass', 'partial', 'fail', 'unknown'],
  methodRef: null,
  criteria: [criterion('c-one')],
  version: '0.1.0',
  source: 'first-party',
  ...extra,
});

function writeRubric(
  root: string,
  ref: string,
  opts: { manifest?: object; listing?: object; method?: string } = {},
): string {
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  if (opts.manifest !== undefined) writeFileSync(join(dir, 'rubric.json'), JSON.stringify(opts.manifest));
  if (opts.listing !== undefined) writeFileSync(join(dir, 'listing.json'), JSON.stringify(opts.listing));
  if (opts.method !== undefined) writeFileSync(join(dir, 'METHOD.md'), opts.method);
  return dir;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rstore-'));
  bundled = join(scratch, 'bundled');
  user = join(scratch, 'user');
  mkdirSync(bundled, { recursive: true });
  mkdirSync(user, { recursive: true });
  roots = [
    { dir: bundled, layer: 'bundled' },
    { dir: user, layer: 'user' },
  ];
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe('listLocalRubrics', () => {
  it('enumerates self-describing dirs, skips non-rubrics, sorts by ref', () => {
    writeRubric(bundled, 'su-agent-behavior', { manifest: manifest('su-agent-behavior'), method: '# how' });
    writeRubric(bundled, 'fleet-execution-health', {
      manifest: manifest('fleet-execution-health', { characteristic: 'fleet-execution' }),
    });
    writeFileSync(join(bundled, 'README.md'), '# not a rubric'); // skipped (not a dir)
    mkdirSync(join(bundled, 'empty-dir')); // skipped (no rubric.json)
    writeRubric(bundled, 'broken', { manifest: { rubricId: 'broken', title: 'x' } }); // skipped (no criteria/scale)

    const all = listLocalRubrics(roots);
    expect(all.map((r) => r.ref)).toEqual(['fleet-execution-health', 'su-agent-behavior']);
    expect(all.find((r) => r.ref === 'su-agent-behavior')).toMatchObject({
      rubricId: 'su-agent-behavior',
      title: 'Rubric su-agent-behavior',
      characteristic: 'agent-behavior',
      layer: 'bundled',
      source: 'first-party',
      version: '0.1.0',
    });
  });

  it('a user-layer ref shadows a bundled one (the v2 install-over-first-party seam)', () => {
    writeRubric(bundled, 'su-agent-behavior', { manifest: manifest('su-agent-behavior') });
    writeRubric(user, 'su-agent-behavior', {
      manifest: manifest('su-agent-behavior', { title: 'Installed', source: 'installed' }),
    });
    const all = listLocalRubrics(roots);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: 'Installed', layer: 'user', source: 'installed' });
  });

  it('listing.json fills storefront gaps the manifest lacks (description/version)', () => {
    const thin = manifest('su-agent-behavior');
    delete (thin as Record<string, unknown>).description;
    delete (thin as Record<string, unknown>).version;
    writeRubric(bundled, 'su-agent-behavior', {
      manifest: thin,
      listing: { id: 'su-agent-behavior', description: 'from listing', version: '0.2.0' },
    });
    expect(listLocalRubrics(roots)[0]).toMatchObject({ description: 'from listing', version: '0.2.0' });
  });
});

describe('resolveLocalRubric + readLocalRubricMethod', () => {
  it('resolves by ref and by rubricId, null on miss; reads METHOD.md when shipped', () => {
    const dir = writeRubric(bundled, 'su-agent-behavior', {
      manifest: manifest('su-agent-behavior', { methodRef: 'su-agent-behavior' }),
      method: '# The exam\nMode A probe',
    });
    writeRubric(bundled, 'no-method', { manifest: manifest('no-method') });

    expect(resolveLocalRubric('su-agent-behavior', roots)?.dir).toBe(dir);
    expect(resolveLocalRubric('nope', roots)).toBeNull();
    expect(readLocalRubricMethod({ dir })).toContain('Mode A probe');
    expect(readLocalRubricMethod(resolveLocalRubric('no-method', roots)!)).toBeNull();
  });
});

describe('rubricsNeedingSeed (the seed decision core)', () => {
  const row = (rubricId: string, over: Partial<ExistingRubricRow> = {}): ExistingRubricRow => ({
    rubricId,
    owner: 'someone@real',
    valid: true,
    ...over,
  });

  it('no-clobber: an existing workspace rubricId always wins; idempotent on re-run', () => {
    writeRubric(bundled, 'su-agent-behavior', { manifest: manifest('su-agent-behavior') });
    writeRubric(bundled, 'pot-coordination-health', {
      manifest: manifest('pot-coordination-health', { characteristic: 'hive-coordination' }),
    });
    const all = listLocalRubrics(roots);

    // cold start: everything seeds
    expect(rubricsNeedingSeed(all, []).map((r) => r.rubricId)).toEqual([
      'pot-coordination-health',
      'su-agent-behavior',
    ]);
    // an existing id blocks its seed
    expect(rubricsNeedingSeed(all, [row('su-agent-behavior')]).map((r) => r.rubricId)).toEqual([
      'pot-coordination-health',
    ]);
    // after a full seed, a re-run is a no-op (idempotence)
    expect(rubricsNeedingSeed(all, all.map((r) => row(r.rubricId, { owner: FIRST_PARTY_RUBRIC_SEED_OWNER })))).toEqual(
      [],
    );
  });

  it('reclaims a WEDGED seeder-owned row (invalid template_data) but never a real author\'s', () => {
    writeRubric(bundled, 'su-agent-behavior', { manifest: manifest('su-agent-behavior') });
    writeRubric(bundled, 'pot-coordination-health', {
      manifest: manifest('pot-coordination-health', { characteristic: 'hive-coordination' }),
    });
    const all = listLocalRubrics(roots);

    // The WI-3617 wedge: a seeder-owned row whose template_data no longer parses
    // (e.g. NULLed by a broken restore) is invisible to reads yet blocked its own
    // re-seed forever under the raw-slug check. It now counts as needing seed.
    expect(
      rubricsNeedingSeed(all, [
        row('pot-coordination-health', { owner: FIRST_PARTY_RUBRIC_SEED_OWNER, valid: false }),
        row('su-agent-behavior', { owner: FIRST_PARTY_RUBRIC_SEED_OWNER, valid: true }),
      ]).map((r) => r.rubricId),
    ).toEqual(['pot-coordination-health']);

    // A half-authored row under a REAL owner still blocks, invalid or not — the
    // seed must never overwrite content a person/agent is mid-editing.
    expect(
      rubricsNeedingSeed(all, [
        row('pot-coordination-health', { owner: 'su-somebody', valid: false }),
        row('su-agent-behavior', { owner: null, valid: false }),
      ]),
    ).toEqual([]);
  });

  describe('EI-12932: content-drift auto-upgrade of an already-seeded rubric', () => {
    const seedRow = (rubricId: string, td: SeedableTemplateData): ExistingRubricRow => ({
      rubricId,
      owner: FIRST_PARTY_RUBRIC_SEED_OWNER,
      valid: true,
      templateData: td,
    });

    it('no templateData supplied ⇒ never auto-upgrades (safe default)', () => {
      writeRubric(bundled, 'su-agent-behavior', {
        manifest: manifest('su-agent-behavior', { criteria: [criterion('c-one'), criterion('c-two')] }),
      });
      const all = listLocalRubrics(roots);
      expect(rubricsNeedingSeed(all, [row('su-agent-behavior', { owner: FIRST_PARTY_RUBRIC_SEED_OWNER })])).toEqual(
        [],
      );
    });

    it('a stale seeder-owned row (bundle changed, content untouched since last seed) upgrades', () => {
      writeRubric(bundled, 'su-agent-behavior', {
        manifest: manifest('su-agent-behavior', { criteria: [criterion('c-one'), criterion('c-two')] }),
      });
      const all = listLocalRubrics(roots);
      // Simulate: the row was seeded when the bundle had only 'c-one', and nothing has
      // touched it since (its recorded seedContentHash matches its own live content).
      const staleFields: SeedableTemplateData = {
        characteristic: 'agent-behavior',
        criteria: [criterion('c-one')],
        ratingScale: ['pass', 'partial', 'fail', 'unknown'],
        methodRef: null,
        description: 'd',
      };
      const staleHash = seedContentHash(staleFields);
      expect(
        rubricsNeedingSeed(all, [
          seedRow('su-agent-behavior', { ...staleFields, seedContentHash: staleHash }),
        ]).map((r) => r.rubricId),
      ).toEqual(['su-agent-behavior']);
    });

    it('bootstrap: a row seeded before seedContentHash existed (absent) trusts its current content as the baseline', () => {
      writeRubric(bundled, 'su-agent-behavior', {
        manifest: manifest('su-agent-behavior', { criteria: [criterion('c-one'), criterion('c-two')] }),
      });
      const all = listLocalRubrics(roots);
      const legacyFields: SeedableTemplateData = {
        characteristic: 'agent-behavior',
        criteria: [criterion('c-one')],
        ratingScale: ['pass', 'partial', 'fail', 'unknown'],
        methodRef: null,
        description: 'd',
        // no seedContentHash — a pre-EI-12932 seeded row
      };
      expect(
        rubricsNeedingSeed(all, [seedRow('su-agent-behavior', legacyFields)]).map((r) => r.rubricId),
      ).toEqual(['su-agent-behavior']);
    });

    it('already up to date (live content matches the bundle) ⇒ no-op, even with no recorded hash', () => {
      writeRubric(bundled, 'su-agent-behavior', { manifest: manifest('su-agent-behavior') });
      const all = listLocalRubrics(roots);
      const bundledRubric = all[0]!;
      const matchingFields: SeedableTemplateData = {
        characteristic: bundledRubric.characteristic,
        criteria: bundledRubric.criteria,
        ratingScale: bundledRubric.ratingScale,
        methodRef: bundledRubric.methodRef,
        description: bundledRubric.description,
      };
      expect(rubricsNeedingSeed(all, [seedRow('su-agent-behavior', matchingFields)])).toEqual([]);
    });

    it('a row that diverged since its last recorded seed (a local amend under the seed owner) is left untouched', () => {
      writeRubric(bundled, 'su-agent-behavior', {
        manifest: manifest('su-agent-behavior', { criteria: [criterion('c-one'), criterion('c-two')] }),
      });
      const all = listLocalRubrics(roots);
      // The seeder last wrote 'c-one' only (recorded hash reflects that) — but the LIVE
      // content now also carries a locally-amended field on c-one (amendRubric can do this
      // while still falling back to the seed owner identity when no `by` is given). The
      // live content no longer matches the recorded seedContentHash, so — even though the
      // bundle now also differs from live — this must NOT be treated as safe to upgrade.
      const originallySeeded: SeedableTemplateData = {
        characteristic: 'agent-behavior',
        criteria: [criterion('c-one')],
        ratingScale: ['pass', 'partial', 'fail', 'unknown'],
        methodRef: null,
        description: 'd',
      };
      const recordedHash = seedContentHash(originallySeeded);
      const locallyAmended: SeedableTemplateData = {
        ...originallySeeded,
        criteria: [{ ...criterion('c-one'), title: 'a human retitled this' }],
        seedContentHash: recordedHash,
      };
      expect(rubricsNeedingSeed(all, [seedRow('su-agent-behavior', locallyAmended)])).toEqual([]);
    });
  });

  describe('seedContentHash (EI-12932)', () => {
    it('is stable regardless of object key order (jsonb round-tripping never causes a false drift signal)', () => {
      const a = { characteristic: 'x', criteria: [criterion('c-one')], ratingScale: ['a', 'b'], description: 'd' };
      const b = { description: 'd', ratingScale: ['a', 'b'], criteria: [criterion('c-one')], characteristic: 'x' };
      expect(seedContentHash(a)).toBe(seedContentHash(b));
    });

    it('changes when the comparable content genuinely changes', () => {
      const a = { characteristic: 'x', criteria: [criterion('c-one')], ratingScale: ['a', 'b'] };
      const b = { characteristic: 'x', criteria: [criterion('c-two')], ratingScale: ['a', 'b'] };
      expect(seedContentHash(a)).not.toBe(seedContentHash(b));
    });

    it('ignores empty-string methodRef/description (matching how buildRubricTemplateData omits them)', () => {
      const withEmpties = {
        characteristic: 'x',
        criteria: [criterion('c-one')],
        ratingScale: ['a', 'b'],
        methodRef: '',
        description: '',
      };
      const withoutEmpties = { characteristic: 'x', criteria: [criterion('c-one')], ratingScale: ['a', 'b'] };
      expect(seedContentHash(withEmpties)).toBe(seedContentHash(withoutEmpties));
    });
  });
});

describe('the REAL bundled first-party set (in-repo rubrics/)', () => {
  // <repo>/packages/operator-core/lib/cupboard → four levels up is the repo root.
  const inRepo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'rubrics');

  it('every shipped rubric dir resolves and its data passes rubricTemplateDataSchema', () => {
    expect(existsSync(inRepo)).toBe(true);
    const shipped = listLocalRubrics([{ dir: inRepo, layer: 'bundled' }]);
    expect(shipped.map((r) => r.rubricId)).toEqual([
      'experiment-component-quality',
      'experiment-hive-quality',
      'experiment-instance-quality',
      'experiment-replay-quality',
      'fleet-execution-health',
      'plan-class-bugfix',
      'plan-class-feature-ship',
      'plan-class-general',
      'plan-class-investigation',
      'plan-class-migration',
      'pot-coordination-health',
      'spec-quality',
      'spec-test-adequacy',
      'su-agent-behavior',
    ]);
    for (const r of shipped) {
      // exactly what the seed hands proposeRubric → buildRubricTemplateData validates
      const parsed = rubricTemplateDataSchema.safeParse({
        characteristic: r.characteristic,
        criteria: r.criteria,
        ratingScale: r.ratingScale,
        ...(r.methodRef ? { methodRef: r.methodRef } : {}),
        ...(r.description ? { description: r.description } : {}),
      });
      expect(parsed.success, `rubric.json for '${r.rubricId}' must satisfy the rubric template schema`).toBe(true);
      expect(r.source).toBe('first-party');
      // a rubric that declares a methodRef must ship its METHOD.md runbook copy
      if (r.methodRef) expect(readLocalRubricMethod(r)).toBeTruthy();
    }
  });

  it('every plan-class rubric requires the independent grader to spot-check audit citations', () => {
    const shipped = listLocalRubrics([{ dir: inRepo, layer: 'bundled' }]);
    const planClasses = shipped.filter((r) => r.rubricId.startsWith('plan-class-'));

    expect(planClasses.map((r) => r.rubricId)).toEqual([
      'plan-class-bugfix',
      'plan-class-feature-ship',
      'plan-class-general',
      'plan-class-investigation',
      'plan-class-migration',
    ]);
    for (const rubric of planClasses) {
      const spotCheck = rubric.criteria.filter((c) => c.key === 'audit-citations-spot-checked');
      expect(spotCheck, rubric.rubricId).toHaveLength(1);
      expect(spotCheck[0]!.method).toMatch(/code\/test citation/);
      expect(spotCheck[0]!.method).toMatch(/doc, workitem, and none/);
    }
  });
});
