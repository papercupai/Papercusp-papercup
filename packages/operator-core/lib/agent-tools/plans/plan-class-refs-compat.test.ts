/**
 * plan-verification-profiles-2026-10-17 R-17 (P-006): every plan-class reference that
 * existed before the general class was added still resolves afterwards (D-003).
 *
 * LEGACY_PLAN_CLASS_REFS is frozen on purpose. It is the set every stored acceptance
 * rubric referenced when the general class shipped (live census 2026-10-20: 613 class
 * references — feature-ship 437, bugfix 141, investigation 22, migration 13 — and no
 * other value). Do not derive it from the current list: the point is to catch a change
 * that drops or renames one of them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLAN_CLASS_RUBRIC_REFS as LEAF_PLAN_CLASS_RUBRIC_REFS,
  PLAN_CLASSES_BY_PROFILE,
  isPlanClassRubricRef,
  planClassAllowsAllExemptItems,
} from '../../plan-class-refs';
import { PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';
import { specQualitySubjectRef } from './spec-quality';
import { classRefFromSpecQualitySubjectRef } from './activation-class-ref';
import { listLocalRubrics } from '../../cupboard/rubric-store';

const LEGACY_PLAN_CLASS_REFS = [
  'plan-class-feature-ship',
  'plan-class-bugfix',
  'plan-class-migration',
  'plan-class-investigation',
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const inRepoRubrics = join(here, '..', '..', '..', '..', '..', 'rubrics');

describe('existing plan-class references stay valid after the general class is added', () => {
  it('the frozen legacy set matches every class reference recorded in the legacy audit snapshot', () => {
    const snapshot = readFileSync(join(here, '..', '..', '__fixtures__', 'plan-audit-legacy-snapshot.json'), 'utf8');
    const recorded = [...new Set(snapshot.match(/plan-class-[a-z-]+/g) ?? [])].sort();
    expect(recorded).toEqual([...LEGACY_PLAN_CLASS_REFS].sort());
  });

  it.each(LEGACY_PLAN_CLASS_REFS)('%s is still an accepted class on every surface', (classRef) => {
    // The canonical list, its re-export, and the predicate the gates use all accept it.
    expect(LEAF_PLAN_CLASS_RUBRIC_REFS).toContain(classRef);
    expect(PLAN_CLASS_RUBRIC_REFS).toContain(classRef);
    expect(isPlanClassRubricRef(classRef)).toBe(true);

    // It still has a shipped standard-kind class rubric for rubrics:propose to resolve.
    const shipped = listLocalRubrics([{ dir: inRepoRubrics, layer: 'bundled' }]).find((r) => r.rubricId === classRef);
    expect(shipped, `bundled rubric dir rubrics/${classRef}`).toBeDefined();
    expect(shipped!.source).toBe('first-party');

    // An activation audit still reads the class back from a spec-quality subject.
    const slug = 'compat-fixture-plan';
    expect(classRefFromSpecQualitySubjectRef(specQualitySubjectRef(slug, classRef, 'f'.repeat(64)), slug)).toBe(classRef);
  });

  it('the general class is added without displacing any legacy class', () => {
    expect(PLAN_CLASS_RUBRIC_REFS).toEqual([...LEGACY_PLAN_CLASS_REFS, 'plan-class-general']);
    expect(PLAN_CLASS_RUBRIC_REFS).toBe(LEAF_PLAN_CLASS_RUBRIC_REFS);
  });

  it('D-003: every class sits under exactly one verification profile', () => {
    const placed = Object.values(PLAN_CLASSES_BY_PROFILE).flat();
    expect([...placed].sort()).toEqual([...PLAN_CLASS_RUBRIC_REFS].sort());
    expect(new Set(placed).size).toBe(placed.length);
    expect(PLAN_CLASSES_BY_PROFILE.coding).toEqual([
      'plan-class-feature-ship',
      'plan-class-bugfix',
      'plan-class-migration',
    ]);
    expect(PLAN_CLASSES_BY_PROFILE.general).toEqual(['plan-class-general', 'plan-class-investigation']);
  });

  it('only investigation and general accept an all-exempt item set', () => {
    expect(PLAN_CLASS_RUBRIC_REFS.filter(planClassAllowsAllExemptItems)).toEqual([
      'plan-class-investigation',
      'plan-class-general',
    ]);
  });

  it('rejects a reference that is not a class', () => {
    expect(isPlanClassRubricRef('plan-class-unknown')).toBe(false);
    expect(isPlanClassRubricRef('spec-quality')).toBe(false);
    expect(isPlanClassRubricRef(undefined)).toBe(false);
  });
});
