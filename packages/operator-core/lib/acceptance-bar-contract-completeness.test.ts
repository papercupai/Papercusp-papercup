import { describe, expect, it } from 'vitest';
import publicVitestConfig from '../../../apps/operator-public/vitest.config';
import { RECORDED_TEST_LAYERS, recordedTestLayer } from '@papercusp/test-config/execution-details';
import {
  acceptanceBarContractGaps,
  checkFileTestLayers,
  isExplicitlyManualCheck,
  type AcceptanceBarContractGapInput,
} from './acceptance-bar-contract-completeness';

const complete: AcceptanceBarContractGapInput = {
  role: 'outcome',
  method: 'Run the focused proof and read its verdict.',
  check: { kind: 'tests', files: ['packages/operator-core/lib/foo.integration.test.ts'] },
  requiredTestLayers: ['integration'],
  automatedProofRequired: true,
};

const gapsOf = (input: Partial<AcceptanceBarContractGapInput>) =>
  acceptanceBarContractGaps({ ...complete, ...input }).map((finding) => finding.gap);

describe('checkFileTestLayers — the repo test taxonomy and configured file routes', () => {
  it('classifies each canonical framework and refuses to guess for non-test paths', () => {
    expect([...checkFileTestLayers('lib/a.test.ts')!]).toEqual(['unit']);
    expect([...checkFileTestLayers('lib/a.integration.test.ts')!]).toEqual(['integration']);
    expect([...checkFileTestLayers('lib/a.browser.test.tsx')!]).toEqual(['browser']);
    expect([...checkFileTestLayers('apps/operator/e2e/flow.spec.ts')!]).toEqual(['e2e']);
    expect([...checkFileTestLayers('lib/llm-testing/scenarios/su/a.test.ts')!].sort()).toEqual(['llm', 'unit']);
    expect(checkFileTestLayers('lib/a.ts')).toBeNull();
  });

  it('recognizes the actual public integration projects without promoting a matching basename elsewhere', () => {
    for (const file of ['treasury.test.ts', 'transparency-routes.test.ts', 'identity-metered-usage.test.ts']) {
      expect([...checkFileTestLayers(`apps/operator-public/src/__tests__/${file}`)!]).toEqual(['integration']);
      expect([...checkFileTestLayers(`lib/${file}`)!]).toEqual(['unit']);
    }
    expect([...checkFileTestLayers(' apps\\operator-public\\src\\__tests__\\identity-metered-usage.test.ts ')!])
      .toEqual(['integration']);
  });

  it('keeps hosted statement tests out of the unit project and in their measured integration project', () => {
    expect(publicVitestConfig).toMatchObject({ test: { projects: expect.arrayContaining([
      expect.objectContaining({ test: expect.objectContaining({
        name: 'unit', exclude: expect.arrayContaining(['**/identity-metered-usage.test.ts']),
      }) }),
      expect.objectContaining({ test: expect.objectContaining({
        name: 'treasury-integration', provide: { papercuspTestLayer: 'integration' },
        include: ['src/__tests__/treasury.test.ts', 'src/__tests__/transparency-routes.test.ts'],
      }) }),
      expect.objectContaining({ test: expect.objectContaining({
        name: 'funded-turn-host-integration', provide: { papercuspTestLayer: 'integration' },
        include: ['src/__tests__/funded-turn-host.integration.test.ts', 'src/__tests__/identity-metered-usage.test.ts'],
      }) }),
    ]) } });
  });
});

// EI-24434635346407728 — a BAR may require only layers the ledger recorder can write.
// Before, the recorder knew unit|integration|browser while BARs required e2e|llm, so
// those clauses could never pass correct-layer.
describe('one test-layer taxonomy for BAR contracts and the ledger recorder', () => {
  const everyClassifiedLayer = new Set(
    ['a.test.ts', 'a.integration.test.ts', 'a.browser.test.tsx', 'e2e/a.spec.ts', 'llm-testing/a.test.ts', 'a.llm.test.ts']
      .flatMap((path) => [...(checkFileTestLayers(path) ?? [])]),
  );

  it('every layer a check file can prove is a layer the recorder persists and reads back', () => {
    expect([...everyClassifiedLayer].sort()).toEqual([...RECORDED_TEST_LAYERS].sort());
    for (const layer of RECORDED_TEST_LAYERS) {
      expect(recordedTestLayer({ schemaVersion: 1, testLayer: layer })).toBe(layer);
      expect(recordedTestLayer(JSON.stringify({ schemaVersion: 1, testLayer: layer }))).toBe(layer);
    }
  });

  it('still refuses a layer outside the taxonomy rather than widening silently', () => {
    expect(recordedTestLayer({ schemaVersion: 1, testLayer: 'mutation' })).toBeUndefined();
    expect(recordedTestLayer({ schemaVersion: 2, testLayer: 'llm' })).toBeUndefined();
  });
});

describe('acceptanceBarContractGaps', () => {
  it('passes a complete contract', () => {
    expect(gapsOf({})).toEqual([]);
  });

  it('names METHOD, check and layers separately — the late-amendment shape of an unrefined seed', () => {
    expect(gapsOf({ method: '  ', check: undefined, requiredTestLayers: undefined })).toEqual([
      'method_missing',
      'check_missing',
      'test_layers_missing',
    ]);
  });

  it('demands layers only from an outcome that owes automated proof', () => {
    expect(gapsOf({ requiredTestLayers: [], automatedProofRequired: false })).toEqual([]);
    expect(gapsOf({ requiredTestLayers: [], role: 'disclosure' })).toEqual([]);
  });

  // docs/evidence/review-system-time-audit-2026-09-23.md: R-6 declared integration while
  // its check named a string-level unit test, and nothing flagged it until vetting.
  it('refuses a check file that cannot satisfy a declared layer (the R-6 shape)', () => {
    const findings = acceptanceBarContractGaps({
      ...complete,
      check: { kind: 'tests', files: ['lib/foo.test.ts'] },
    });
    expect(findings.map((finding) => finding.gap)).toEqual(['check_layer_mismatch']);
    expect(findings[0]!.detail).toContain('integration');
    expect(findings[0]!.detail).toContain('lib/foo.test.ts is unit');
  });

  it('accepts a check whose files jointly cover every declared layer', () => {
    expect(
      gapsOf({
        check: { kind: 'tests', files: ['lib/a.test.ts', 'lib/a.integration.test.ts'] },
        requiredTestLayers: ['unit', 'integration'],
      }),
    ).toEqual([]);
  });

  it('accepts configured hosted integration proof while still refusing it as unit proof', () => {
    const check = { kind: 'tests', files: ['apps/operator-public/src/__tests__/identity-metered-usage.test.ts'] } as const;
    expect(gapsOf({ check: { ...check, files: [...check.files] }, requiredTestLayers: ['integration'] })).toEqual([]);
    expect(gapsOf({ check: { ...check, files: [...check.files] }, requiredTestLayers: ['unit'] }))
      .toEqual(['check_layer_mismatch']);
  });

  it('claims no mismatch when a check file has no naming convention', () => {
    expect(gapsOf({ check: { kind: 'tests', files: ['scripts/probe.mjs'] } })).toEqual([]);
  });

  // WI-10006536: rubric acceptance-pot-review-integration-mode-2026-10-05 R-4 declared
  // ['component','unit']. The ledger records *.component.test.tsx runs as 'unit' and binding
  // refuses any other label, so correct-layer could never pass — yet authoring accepted it.
  it('refuses a declared layer the run ledger can never record (component / mutation / live)', () => {
    for (const layer of ['component', 'mutation', 'live']) {
      const findings = acceptanceBarContractGaps({
        ...complete,
        check: { kind: 'tests', files: ['lib/a.test.ts'] },
        requiredTestLayers: ['unit', layer],
      });
      expect(findings.map((finding) => finding.gap)).toEqual(['test_layer_unrecordable']);
      expect(findings[0]!.detail).toContain(layer);
      for (const recorded of RECORDED_TEST_LAYERS) expect(findings[0]!.detail).toContain(recorded);
    }
    // Normalized before judging, so a casing/underscore variant of a recorded layer is still fine.
    expect(gapsOf({ check: { kind: 'tests', files: ['lib/a.test.ts'] }, requiredTestLayers: [' Unit '] })).toEqual([]);
  });

  it('accepts every layer the recorder persists', () => {
    for (const layer of RECORDED_TEST_LAYERS) {
      expect(
        acceptanceBarContractGaps({ ...complete, check: { kind: 'tests', files: ['scripts/probe.mjs'] }, requiredTestLayers: [layer] })
          .map((finding) => finding.gap),
      ).not.toContain('test_layer_unrecordable');
    }
  });

  // goal-agent-behavior-feedback-2026-09-06 carried seven BARs of exactly this shape.
  it('refuses an explicitly manual check that still declares test layers', () => {
    const manual = { kind: 'instrument', instrumentKey: 'none' } as const;
    expect(isExplicitlyManualCheck(manual)).toBe(true);
    const findings = acceptanceBarContractGaps({
      ...complete,
      check: manual,
      requiredTestLayers: ['llm', 'e2e'],
    });
    expect(findings.map((finding) => finding.gap)).toEqual(['check_layer_mismatch']);
    expect(findings[0]!.detail).toContain('omit the `requiredTestLayers` field');
    // The truly manual BAR (no layers, no automated obligation) is complete.
    expect(gapsOf({ check: manual, requiredTestLayers: [], automatedProofRequired: false })).toEqual([]);
  });
});
