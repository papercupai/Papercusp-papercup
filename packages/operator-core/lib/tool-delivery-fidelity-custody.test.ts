import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findBoxIdentityPaths, findOwnerNameLeaks } from '../../../scripts/lib/identity-leak-patterns.mjs';
import fidelity from './llm-testing/fixtures/tool-delivery-fidelity-candidate-20261023.json';
import original from './llm-testing/fixtures/tool-delivery-full-after-use-20261021.json';
import diagnostic from './llm-testing/fixtures/tool-delivery-diagnostic-candidate-20261023.json';
import { toolDeliveryExperiment, toolDeliveryPreregistration, validateToolDeliveryBatchReceipt,
  verifyToolDeliverySourceCustody, toolDeliveryCommittedSubmodules, readToolDeliveryCommittedSource,
  type ToolDeliveryRun } from './tool-delivery-acceptance';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const guardPath = 'packages/operator-core/lib/tool-delivery-fidelity-custody.test.ts';
function sourceFixture() {
  const registration = structuredClone(fidelity) as unknown as ReturnType<typeof toolDeliveryPreregistration>;
  const sources = new Map<string, Buffer>();
  for (const path of Object.keys(registration.sourcePins.files)) {
    const bytes = Buffer.from(path);
    sources.set(path, bytes);
    registration.sourcePins.files[path as keyof typeof registration.sourcePins.files] = sha(bytes);
  }
  for (const [scenario, path] of Object.entries(registration.sourcePins.scenarioPaths)) {
    const bytes = Buffer.from(scenario);
    sources.set(path, bytes);
    (registration.experiment.manifestContract.scenarioHashes as Record<string, string>)[scenario] = sha(bytes);
  }
  const prompt = 'Synthetic private fidelity prompt';
  registration.experiment.manifestContract.systemSha256 = sha(JSON.stringify(prompt));
  for (const arm of ['compact', 'full'] as const) registration.variants[arm].systemPromptTextSha256 = sha(prompt);
  const frozen = structuredClone(registration);
  for (const arm of ['compact', 'full'] as const) Object.assign(frozen.variants[arm].configDelta, { systemPromptText: prompt });
  const privateCapture = Buffer.from(JSON.stringify(frozen));
  registration.capture.privateCapture.originalSha256 = sha(privateCapture);
  sources.set(guardPath, Buffer.from('separately pinned fidelity custody controls'));
  registration.measurementAmendment = {
    decisionRef: 'deterministic-tool-definition-delivery-2026-09-21#D-999',
    registeredAt: '2026-10-23T15:00:00Z',
    sourceReplacements: { 'packages/operator-core/lib/tool-delivery-acceptance.ts': {
      originalSha256: registration.sourcePins.files['packages/operator-core/lib/tool-delivery-acceptance.ts'],
      sha256: registration.sourcePins.files['packages/operator-core/lib/tool-delivery-acceptance.ts'],
    } },
    addedFiles: { [guardPath]: sha(sources.get(guardPath)!) },
  };
  return { registration, privateCapture, sources, buildSha: '0123456789abcdef',
    readSource: (path: string, _ref?: string) => sources.get(path)! };
}

describe('prospective fidelity experiment custody', () => {
  it('requires a prospective test-config gitlink without mutating the frozen treatment', () => {
    const f = sourceFixture(), original = structuredClone(f.registration.sourcePins);
    const path = 'libs/test-config/src/execution-details.ts';
    f.sources.set(path, Buffer.from('new strict recorder contract'));
    f.registration.measurementAmendment!.addedFiles[path] = sha(f.sources.get(path)!);
    expect(verifyToolDeliverySourceCustody(f).verified).toBe(false);
    f.registration.measurementAmendment!.addedSubmodules = { 'libs/test-config': 'a'.repeat(40) };
    expect(verifyToolDeliverySourceCustody(f).verified).toBe(true);
    expect(f.registration.sourcePins).toEqual(original);
    const pins = toolDeliveryCommittedSubmodules(f.registration);
    const git = (args: string[], directory?: string) => directory
      ? Buffer.from('new strict recorder contract') : Buffer.from('b'.repeat(40));
    expect(() => readToolDeliveryCommittedSource(path, f.buildSha, pins, git)).toThrow(/registered gitlink/);
    f.registration.measurementAmendment!.addedSubmodules['libs/testing-shell'] = 'b'.repeat(40);
    expect(() => toolDeliveryCommittedSubmodules(f.registration)).toThrow(/cannot be replaced/);
  });
  it('selects its own frozen treatment and keeps both historical identities separate', () => {
    expect(toolDeliveryPreregistration(fidelity.experiment.id)).toEqual(fidelity);
    expect(toolDeliveryExperiment(fidelity.experiment.id).arms).toEqual(fidelity.experiment.arms);
    expect(fidelity.capture.privateCapture.originalSha256).toBe('7551ffcc0c19a88f569127dbfebccbb2741d9e35576967027273c52bfceed48d');
    for (const prior of [original, diagnostic]) {
      expect(fidelity.experiment.id).not.toBe(prior.experiment.id);
      expect(fidelity.capture.privateCapture.originalSha256).not.toBe(prior.capture.privateCapture.originalSha256);
      expect(toolDeliveryPreregistration(prior.experiment.id)).toEqual(prior);
    }
    expect(fidelity.custodyPaths.receiptDirectory).toBe('fidelity-candidate-once-20261023');
    expect(findBoxIdentityPaths(JSON.stringify(fidelity))).toEqual([]);
    expect(findOwnerNameLeaks(JSON.stringify(fidelity))).toEqual([]);
    for (const arm of Object.values(fidelity.variants)) expect(arm.configDelta).not.toHaveProperty('systemPromptText');
  });
  it('requires the new separately pinned controls and rejects changed loaded treatment or private capture', () => {
    const valid = sourceFixture();
    expect(verifyToolDeliverySourceCustody(valid).verified).toBe(true);
    for (const path of [guardPath, 'apps/operator/scripts/tool-delivery.generated.mjs',
      Object.values(valid.registration.sourcePins.scenarioPaths)[0]!]) {
      const changed = sourceFixture();
      changed.readSource = (file, ref) => file === path && ref === changed.buildSha
        ? Buffer.from('wrong loaded bytes') : changed.sources.get(file)!;
      expect(verifyToolDeliverySourceCustody(changed).verified, path).toBe(false);
    }
    for (const prior of [original, diagnostic]) {
      const mixed = sourceFixture();
      mixed.registration.capture.privateCapture.originalSha256 = prior.capture.privateCapture.originalSha256;
      expect(verifyToolDeliverySourceCustody(mixed).verified).toBe(false);
    }
  });
  it('rejects either historical execution marker and any hidden or replaced attempt', () => {
    const registration = toolDeliveryPreregistration(fidelity.experiment.id);
    const at = new Date(Date.parse(registration.measurementAmendment!.registeredAt) + 1000).toISOString();
    const marker = { at, experimentId: registration.experiment.id,
      privateSha256: registration.capture.privateCapture.originalSha256 };
    const rows: ToolDeliveryRun[] = [];
    const receipt = registration.configuration.armOrder.flatMap(block => block.arms.map(arm => {
      const variant = registration.experiment.arms[arm === 'compact' ? 'compactArm' : 'fullArm'];
      const subset: ToolDeliveryRun[] = [0, 1, 2].map(index => ({
        id: block.scenario + ':' + arm + ':' + index, scenario_id: block.scenario, scenario_hash: 'synthetic',
        sut_model: 'synthetic', judge_model: 'synthetic', status: 'passed', variant, started_at: new Date(at),
        matrix_index: index, transcript_norm_json: [],
      }));
      rows.push(...subset);
      return { scenario: block.scenario, arm, variantId: variant,
        ids: subset.map(row => row.id), statuses: subset.map(row => row.status) };
    }));
    expect(validateToolDeliveryBatchReceipt(rows, marker, receipt, registration)).toBeUndefined();
    for (const prior of [original, diagnostic]) {
      expect(validateToolDeliveryBatchReceipt(rows, { ...marker, experimentId: prior.experiment.id }, receipt, registration)).toBeTypeOf('string');
      expect(validateToolDeliveryBatchReceipt(rows, marker, receipt, toolDeliveryPreregistration(prior.experiment.id))).toBeTypeOf('string');
    }
    expect(validateToolDeliveryBatchReceipt(rows.slice(1), marker, receipt, registration)).toBeTypeOf('string');
    const replaced = structuredClone(receipt);
    replaced[0]!.ids[0] = 'unrecorded-replacement';
    expect(validateToolDeliveryBatchReceipt(rows, marker, replaced, registration)).toBeTypeOf('string');
  });
});
