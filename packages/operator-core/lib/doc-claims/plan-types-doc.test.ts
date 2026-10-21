/**
 * Pins the plan-types agent-insights doc and the plan-completion guidance to the type registry
 * (plan-item-types-registry-cupboard-2026-10-20 P-009, R-23, SPEC-P-009). See ./plan-types-doc.ts.
 *
 * The fixture controls are load-bearing: once the live assertions are green they stop being
 * evidence that the judges can fail, so each fixture reproduces a drift that MUST be caught.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_CATALOG } from '../plan-types/builtin-catalog';
import {
  PLAN_TYPES_DOC_LINK,
  documentedBuiltinItemTypes,
  judgeBuiltinItemTypes,
  judgeGuidanceItemTypeLine,
} from './plan-types-doc';

// lib/doc-claims -> lib -> operator-core -> packages -> <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const INSIGHTS = join(ROOT, 'apps/operator-docs/src/content/docs/agent-insights');
const DOC = join(INSIGHTS, 'plan-and-item-types.mdx');
const RUNBOOK = join(INSIGHTS, 'acceptance-rubrics-on-every-plan-runbook.mdx');
const GUIDE = join(ROOT, 'CLAUDE.md');

const SEED = ['papercusp/code', 'papercusp/doc'];
const seedLine = (ids: string[]) =>
  `- The built-ins are now seeded first-party types: item types ${ids.map((i) => `\`${i}\``).join(', ')}, and plan types \`papercusp/coding\`, \`papercusp/general\`.`;
const GOOD_GUIDANCE = `Deliverables resolve through the type registry ([plan and item types](${PLAN_TYPES_DOC_LINK})).`;

describe('the plan-types doc lists exactly the seeded item types (R-23)', () => {
  describe('fixture controls (the judge must be able to FAIL)', () => {
    it('passes a doc that lists the seed', () => {
      expect(judgeBuiltinItemTypes(seedLine(SEED), SEED)).toEqual({ ok: true, problems: [] });
    });
    it('catches a doc that omits a seeded item type', () => {
      expect(judgeBuiltinItemTypes(seedLine(['papercusp/code']), SEED).problems).toEqual([
        'the doc omits built-in item type papercusp/doc',
      ]);
    });
    it('catches a doc that lists an item type the seed does not define', () => {
      expect(judgeBuiltinItemTypes(seedLine([...SEED, 'papercusp/legal']), SEED).problems).toEqual([
        'the doc lists papercusp/legal, which the registry seed does not define',
      ]);
    });
    it('catches a doc that lost its seed sentence', () => {
      expect(judgeBuiltinItemTypes('## The model\nNo list here.', SEED).ok).toBe(false);
    });
  });

  it('the live doc lists every item type BUILTIN_CATALOG seeds, and nothing else', () => {
    const doc = readFileSync(DOC, 'utf8');
    const seeded = BUILTIN_CATALOG.itemTypes.map((t) => t.id);
    expect(seeded.length).toBeGreaterThan(0);
    expect(documentedBuiltinItemTypes(doc)).not.toBeNull();
    expect(judgeBuiltinItemTypes(doc, seeded)).toEqual({ ok: true, problems: [] });
  });
});

describe('the plan-completion guidance links the plan-types doc (SPEC-P-009, R-23)', () => {
  describe('fixture controls (the judge must be able to FAIL)', () => {
    it('passes a type-registry line that links the doc', () => {
      expect(judgeGuidanceItemTypeLine('guide', GOOD_GUIDANCE)).toEqual({ ok: true, problems: [] });
    });
    it('catches guidance that omits the link', () => {
      expect(judgeGuidanceItemTypeLine('guide', 'Deliverables resolve through the type registry.').problems).toEqual([
        `guide does not link ${PLAN_TYPES_DOC_LINK}`,
      ]);
    });
    it('catches a link that no longer sits on the type-registry line', () => {
      const text = `Deliverables resolve through the registry.\nSee [types](${PLAN_TYPES_DOC_LINK}).`;
      expect(judgeGuidanceItemTypeLine('guide', text).problems).toEqual([
        'guide links the plan-types doc, but not from its type-registry line',
      ]);
    });
  });

  it('the plan-completion runbook keeps its item-type line', () => {
    expect(judgeGuidanceItemTypeLine('the runbook', readFileSync(RUNBOOK, 'utf8'))).toEqual({ ok: true, problems: [] });
  });

  it('the project guide (CLAUDE.md, projected from its doc part) keeps its item-type line', () => {
    expect(judgeGuidanceItemTypeLine('CLAUDE.md', readFileSync(GUIDE, 'utf8'))).toEqual({ ok: true, problems: [] });
  });
});
