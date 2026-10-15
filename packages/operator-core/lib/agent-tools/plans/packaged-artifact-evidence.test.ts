import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measurePackagedArtifactEnvironment } from './packaged-artifact-evidence';
import { measureRepoFilesEvidenceAtRoot, repoFilesEvidenceMeasurementSchema } from './spec-evidence-store';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptPath = 'docs/evidence/shipment.json';
let root = '', artifacts = '', receipt: Record<string, any>, receiptSha = '';
async function save() {
  const raw = JSON.stringify(receipt);
  await writeFile(join(root, receiptPath), raw);
  receiptSha = digest(raw);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'package-evidence-'));
  artifacts = join(root, 'artifacts');
  await mkdir(artifacts); await mkdir(join(root, 'docs/evidence'), { recursive: true });
  await writeFile(join(artifacts, 'app.deb'), 'original');
  receipt = { schemaVersion: 1, kind: 'operational-test-evidence', exitCode: 0,
    assertions: [{ passed: true }], artifactRoot: artifacts,
    runtimeArtifacts: [{ path: 'app.deb', sha256: digest('original'), bytes: 8 }] };
  await save();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('retained final-package environment measurement', () => {
  it('binds a measured package receipt without a live process witness', async () => {
    const recipe = repoFilesEvidenceMeasurementSchema.parse({ schemaVersion: 1, kind: 'repo-files',
      sourcePaths: [receiptPath], artifactReceiptPath: receiptPath });
    const measured = await measureRepoFilesEvidenceAtRoot(root, recipe);
    expect(measured.environmentFingerprint).toBe(await measurePackagedArtifactEnvironment(root, receiptPath, receiptSha));
    expect(measured.environmentFingerprint).toMatch(/^sha256-packaged-artifact-set-v1:[a-f0-9]{64}$/);
  });
  it('remeasures replacement bytes even when the receipt is unchanged, and refuses binding them', async () => {
    const before = await measurePackagedArtifactEnvironment(root, receiptPath, receiptSha);
    await writeFile(join(artifacts, 'app.deb'), 'replaced');
    expect(await measurePackagedArtifactEnvironment(root, receiptPath, receiptSha)).not.toBe(before);
    await expect(measurePackagedArtifactEnvironment(root, receiptPath, receiptSha, { verifyExpectations: true }))
      .rejects.toThrow('package_artifact_receipt_mismatch');
  });
  it('fails closed for missing package bytes', async () => {
    await rm(join(artifacts, 'app.deb'));
    await expect(measurePackagedArtifactEnvironment(root, receiptPath, receiptSha)).rejects.toThrow();
  });
  it('rejects receipt changes after the source measurement', async () => {
    const originalSha = receiptSha;
    receipt.exitCode = 1; await save();
    await expect(measurePackagedArtifactEnvironment(root, receiptPath, originalSha))
      .rejects.toThrow('package_receipt_changed_since_source_measurement');
  });
  it.each(['failed-assertion', 'failed-command', 'duplicate-path', 'traversal'])('rejects %s receipts', async failure => {
    if (failure === 'failed-assertion') receipt.assertions[0].passed = false;
    if (failure === 'failed-command') receipt.exitCode = 1;
    if (failure === 'duplicate-path') receipt.runtimeArtifacts.push(receipt.runtimeArtifacts[0]);
    if (failure === 'traversal') receipt.runtimeArtifacts[0].path = '../outside.deb';
    await save();
    await expect(measurePackagedArtifactEnvironment(root, receiptPath, receiptSha)).rejects.toThrow();
  });
  it('rejects package symlinks outside the declared artifact root', async () => {
    await writeFile(join(root, 'outside.deb'), 'original');
    await rm(join(artifacts, 'app.deb'));
    await symlink(join(root, 'outside.deb'), join(artifacts, 'app.deb'));
    await expect(measurePackagedArtifactEnvironment(root, receiptPath, receiptSha))
      .rejects.toThrow('package_artifact_outside_root');
  });
  it.each([{ sourcePaths: ['src/feature.ts'] }, { runtimeUnits: ['desktop-shell'] },
    { artifactReceiptPath: 'receipt.json', sourcePaths: ['receipt.json'] }])(
    'refuses an unmeasured receipt or simultaneous process selector: %j', override => {
      expect(repoFilesEvidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'repo-files',
        sourcePaths: [receiptPath], artifactReceiptPath: receiptPath, ...override }).success).toBe(false);
    });
});
