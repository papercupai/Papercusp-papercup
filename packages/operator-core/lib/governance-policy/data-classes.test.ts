/**
 * dlp-class-canary:model-inference — P-016a DLP classification enforcement (WI-6554700010011918,
 * papercusp-enterprise-readiness-roadmap-2026-10-09 P-016).
 *
 * One vocabulary: a customer data class (auth/hosted/customer-data-map.ts) is governed as the
 * dataUse label `class:<cls>`. This canary pins the four places that vocabulary must agree:
 *  1. the labels themselves,
 *  2. the policy write path, which refuses a `class:` value that names no class,
 *  3. the dispatch seat, which judges a `dataClass` argument as its `class:` label,
 *  4. the model-inference injection legs, which carry the classes of their processing-map path,
 * and proves the journey end to end: `dataUse.deny: ['class:pii']` withholds every injection leg
 * that can carry personal data, while a rule on a class no leg carries withholds none.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_DATA_CLASSES,
  CUSTOMER_DATA_CLASS_DESCRIPTIONS,
  DATA_CLASS_USE_PREFIX,
  dataClassUseLabel,
  isCustomerDataClass,
} from '../auth/hosted/customer-data-map';
import { pilotPathDataClasses } from '../data-governance/pilot-processing-map';
import { governedDataClasses } from './control';
import { governedRequestOf } from './enforce';
import { evaluateInheritedPolicy, type PolicyLayer } from './inherited-policy';
import {
  INJECTION_LEG_PROCESSING_PATH,
  MODEL_CONTEXT_DATA_USE,
  injectionGovernedRequest,
  injectionLegDataClassLabels,
  type InjectionLeg,
} from './session-governance';
import { unknownDataClassLabel, validateLayerInput, type UpsertLayerInput } from './store';

const LEGS: InjectionLeg[] = ['personal', 'pot', 'organization', 'live'];

function layer(rules: PolicyLayer['rules'], exceptions: PolicyLayer['exceptions'] = []): PolicyLayer {
  return { layerId: 'org-root', level: 'organization', version: 1, rules, exceptions };
}

function upsert(over: Partial<UpsertLayerInput>): UpsertLayerInput {
  return {
    layerId: 'org-root',
    level: 'organization',
    scopeRef: 'org-1',
    parentLayerId: null,
    rules: {},
    actor: 'admin:test',
    reason: 'dlp canary',
    ...over,
  };
}

describe('dlp-class-canary:model-inference', () => {
  it('labels every customer data class as class:<cls>, and describes each one', () => {
    expect(DATA_CLASS_USE_PREFIX).toBe('class:');
    for (const cls of CUSTOMER_DATA_CLASSES) {
      expect(dataClassUseLabel(cls)).toBe(`class:${cls}`);
      expect(CUSTOMER_DATA_CLASS_DESCRIPTIONS[cls].trim().length, cls).toBeGreaterThan(10);
    }
    expect(CUSTOMER_DATA_CLASSES).toContain('customer-content');
    expect(isCustomerDataClass('pii')).toBe(true);
    expect(isCustomerDataClass('pll')).toBe(false);
  });

  it('exposes the vocabulary to administrators in the policy state', () => {
    expect(governedDataClasses()).toEqual(
      CUSTOMER_DATA_CLASSES.map((cls) => ({
        label: `class:${cls}`,
        class: cls,
        description: CUSTOMER_DATA_CLASS_DESCRIPTIONS[cls],
      })),
    );
  });

  describe('policy write path', () => {
    it('accepts a rule and an exception that name real classes', () => {
      expect(validateLayerInput(upsert({ rules: { dataUse: { deny: ['class:pii', 'class:secret'] } } }))).toBeNull();
      expect(validateLayerInput(upsert({ rules: { dataUse: { allow: ['class:operational', 'model-context'] } } }))).toBeNull();
      expect(
        validateLayerInput(
          upsert({
            rules: { dataUse: { deny: ['class:pii'] } },
            exceptions: [{ category: 'dataUse', pattern: 'class:pii', reason: 'support case', expiresAt: '2099-01-01T00:00:00Z' }],
          }),
        ),
      ).toBeNull();
    });

    it('refuses a class: value that names no class, in a rule or an exception', () => {
      expect(validateLayerInput(upsert({ rules: { dataUse: { deny: ['class:pll'] } } }))).toMatch(
        /^rules\.dataUse\.deny: 'class:pll' names no customer data class/,
      );
      expect(validateLayerInput(upsert({ rules: { dataUse: { allow: ['class:'] } } }))).toMatch(/^rules\.dataUse\.allow: /);
      expect(
        validateLayerInput(
          upsert({
            exceptions: [{ category: 'dataUse', pattern: 'class:secrets', reason: 'typo', expiresAt: '2099-01-01T00:00:00Z' }],
          }),
        ),
      ).toMatch(/^exceptions\[0\]\.pattern: 'class:secrets' names no customer data class/);
    });

    it('leaves a wildcard family match and a non-class value to the evaluator', () => {
      expect(unknownDataClassLabel('class:*')).toBeNull();
      expect(unknownDataClassLabel('model-context')).toBeNull();
      expect(unknownDataClassLabel('class:pii')).toBeNull();
      expect(unknownDataClassLabel('class:nope')).toContain('class:pii');
    });
  });

  it('judges a dispatch dataClass argument as its class: label', () => {
    const subject = governedRequestOf({
      toolName: 'tools:invoke',
      capabilities: [],
      boundary: 'dispatch',
      args: { name: 'export:run', dataClass: 'PII', args: { dataClasses: ['billing', 'not-a-class'] } },
    });
    expect(subject.dataUse).toEqual(expect.arrayContaining(['class:pii', 'class:billing']));
    expect(subject.dataUse).not.toContain('class:not-a-class');
  });

  it('carries each injection leg’s processing-map classes on the model-inference subject', () => {
    for (const leg of LEGS) {
      const expected = pilotPathDataClasses(INJECTION_LEG_PROCESSING_PATH[leg]).map(dataClassUseLabel);
      expect(expected.length, leg).toBeGreaterThan(0);
      expect(injectionLegDataClassLabels(leg)).toEqual(expected);
      const subject = injectionGovernedRequest(leg);
      expect(subject.dataUse?.[0]).toBe(MODEL_CONTEXT_DATA_USE);
      expect(subject.dataUse).toEqual(expect.arrayContaining(expected));
    }
  });

  it('withholds every leg that can carry personal data under dataUse.deny class:pii', () => {
    const chain = [layer({ dataUse: { deny: ['class:pii'] } })];
    for (const leg of LEGS) {
      const verdict = evaluateInheritedPolicy(chain, injectionGovernedRequest(leg));
      expect(verdict.allow, leg).toBe(false);
      if (!verdict.allow) expect(verdict.decidedBy.category).toBe('dataUse');
    }
  });

  it('withholds no leg under a rule on a class no leg carries', () => {
    const chain = [layer({ dataUse: { deny: ['class:secret', 'class:billing'] } })];
    for (const leg of LEGS) {
      expect(evaluateInheritedPolicy(chain, injectionGovernedRequest(leg)).allow, leg).toBe(true);
    }
  });

  it('lets an unexpired dataUse exception re-admit the class', () => {
    const chain = [
      layer({ dataUse: { deny: ['class:pii'] } }, [
        { category: 'dataUse', pattern: 'class:pii', reason: 'support case', expiresAt: '2099-01-01T00:00:00Z' },
      ]),
    ];
    expect(evaluateInheritedPolicy(chain, injectionGovernedRequest('personal'), new Date('2026-10-14T00:00:00Z')).allow).toBe(true);
  });
});
