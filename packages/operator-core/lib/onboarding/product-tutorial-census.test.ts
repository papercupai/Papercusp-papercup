import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PRODUCT_TUTORIAL_CHAPTERS, PRODUCT_TUTORIAL_LESSONS, PRODUCT_TUTORIAL_TARGETS, productTutorialTargetAvailability } from './product-tutorial-lesson';

interface CensusEntry { id: string; operatorKind?: string; module: string; route: string; teaches: string; policy: string }
interface SourceCensus {
  rail: CensusEntry[]; nonRail: CensusEntry[]; policies: Record<string, string>;
  curriculumVersion: number; evidenceClass: string; acceptanceStillRequired: string[];
}
const census: SourceCensus = JSON.parse(readFileSync(new URL('../../../../docs/evidence/account-first-tutorial-source-census.json', import.meta.url), 'utf8'));

function registeredSurfaceKinds(source: string): string[] {
  const file = ts.createSourceFile('surfaces.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result: string[] | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'OPERATOR_SURFACES' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      result = node.initializer.properties.map(property => {
        if (!ts.isPropertyAssignment(property) || !property.name || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
          throw new Error('Unresolved operator surface registration: update the census reader before claiming coverage');
        }
        return property.name.text;
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!result?.length) throw new Error('OPERATOR_SURFACES registry was not read');
  return result;
}

describe('account-first tutorial source census', () => {
  it('keeps the video practice in maintained destinations and preserves approved project and assessment boundaries', () => {
    const destinations = new Set(PRODUCT_TUTORIAL_TARGETS.map(target => target.id));
    for (const chapter of PRODUCT_TUTORIAL_CHAPTERS) {
      expect(PRODUCT_TUTORIAL_LESSONS.some(lesson => lesson.id === chapter.lessonId), chapter.id).toBe(true);
      const url = new URL(chapter.destination, 'https://app.papercusp.com');
      expect(destinations.has(url.searchParams.get('app')!), chapter.id).toBe(true);
    }
    const create = PRODUCT_TUTORIAL_CHAPTERS.find(chapter => chapter.id === 'create-project')!.prompt!;
    expect(create).toContain('title, owner and due date');
    expect(create).toContain('mark it complete');
    expect(create).toContain('Keep the data in the browser');
    expect(create).toContain('Keep the app private');
    const grade = PRODUCT_TUTORIAL_CHAPTERS.find(chapter => chapter.id === 'grade-project')!.prompt!;
    expect(grade).toContain('Keep this grade pass to assessment');
    expect(grade).toContain('leave implementation of findings for our next approved step');
    expect(PRODUCT_TUTORIAL_CHAPTERS.find(chapter => chapter.id === 'connect-psu')!.prompt).toContain('owner/status filters and a CSV export');
    expect(PRODUCT_TUTORIAL_CHAPTERS.find(chapter => chapter.id === 'visible-fleet')!.prompt).toContain('same cloud instance and project');
  });
  it('implements the source census in maintained lessons and permission-aware destinations', () => {
    const ids = PRODUCT_TUTORIAL_TARGETS.map(target => target.id).sort();
    expect(ids).toEqual([...census.rail, ...census.nonRail].map(entry => entry.id).sort());
    for (const target of PRODUCT_TUTORIAL_TARGETS) {
      expect(PRODUCT_TUTORIAL_LESSONS.find(lesson => lesson.id === target.module), target.id).toBeDefined();
      if (target.policy === 'workspace') {
        expect(productTutorialTargetAvailability(target, null), target.id).toContain('authorized workspace');
        expect(productTutorialTargetAvailability(target, 'authorized-workspace'), target.id).toBeNull();
      }
    }
    const billing = PRODUCT_TUTORIAL_LESSONS.find(lesson => lesson.id === 'billing')!;
    expect(billing.help).toContain('separate responsibilities');
    expect(billing.help).toContain('cancellation');
    expect(billing.help).toContain('If a payment fails');
    expect(billing.help).toContain('update the payment method');
    expect(billing.help).not.toMatch(/\$\d+/);
  });
  it('covers every maintained operator mount, including non-rail mounts', () => {
    const source = readFileSync(new URL('../../../operator-ui/src/surfaces/index.tsx', import.meta.url), 'utf8');
    const covered = [...census.rail, ...census.nonRail].flatMap(entry => entry.operatorKind ? [entry.operatorKind] : []);
    expect(covered.length).toBe(new Set(covered).size);
    expect(covered.sort()).toEqual(registeredSurfaceKinds(source).sort());
  });

  it('would reject a new registered capability until it is taught', () => {
    const covered = new Set([...census.rail, ...census.nonRail].flatMap(entry => entry.operatorKind ? [entry.operatorKind] : []));
    const changedRegistry = "export const OPERATOR_SURFACES = { plans: lazy(loadPlans), 'new-capability': lazy(loadNew) };";
    expect(registeredSurfaceKinds(changedRegistry).filter(kind => !covered.has(kind))).toEqual(['new-capability']);
  });

  it('maps each capability to a lesson, a route and explicit unavailable behavior', () => {
    const entries = [...census.rail, ...census.nonRail];
    expect(entries.length).toBe(new Set(entries.map(entry => entry.id)).size);
    for (const entry of entries) {
      expect(entry.module, entry.id).toBeTruthy();
      expect(entry.route, entry.id).toMatch(/^(\/|tutorial:)/);
      expect(entry.teaches, entry.id).toBeTruthy();
      expect(census.policies[entry.policy], entry.id).toBeTruthy();
    }
    expect(census.curriculumVersion).toBe(3);
    expect(census.evidenceClass).toBe('source-census');
    expect(census.acceptanceStillRequired).not.toEqual([]);
  });
});
