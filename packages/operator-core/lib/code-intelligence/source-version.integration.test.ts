/** P003 source identities cross the actual forked compiler boundary. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { sourceIdentityContinuity } from './contracts';

let root = '';
const source = 'export function target() { return 1; }\nexport function caller() { return target(); }\n';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'native-source-version-')); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/control.ts'), source); });
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('source-version evidence at the compiler seam', () => {
  it('pins actual snapshot bytes, retains old proof after edits and never implies runtime execution', async () => {
    const query = () => firstPartyCallersOffthread({ root, repositoryId: 'fixture-repository-a', name: 'target', vendorDir: LSP_VENDOR_DIR });
    const original = await query();
    expect(original.error).toBeNull();
    expect(original.sites.map(s => `${s.path}:${s.line1}`)).toEqual(['src/control.ts:2']);
    expect(original.evidence!.sourceScope).toMatchObject({ repositoryId: 'fixture-repository-a', identityKind: 'registry' });
    expect(original.evidence!.sourceScope.supportingFiles).toEqual([{ path: 'src/control.ts', contentHash: hash(source), language: 'typescript', representation: 'full-source' }]);
    expect(original.evidence!.relationships).toEqual([{ siteIndex: 0, kind: 'callers', origin: 'compiler', knowledge: 'observed', runtimeExecution: 'unknown' }]);
    const oldId = original.evidence!.siteIdentities[0]!.versionedSymbolId;
    const changed = '// shifted source\n' + source;
    writeFileSync(join(root, 'src/control.ts'), changed);
    const fresh = await query();
    expect(fresh.sites[0]!.line1).toBe(3);
    expect(fresh.evidence!.siteIdentities[0]!.contentHash).toBe(hash(changed));
    expect(sourceIdentityContinuity(oldId, fresh.evidence!.siteIdentities[0]!.versionedSymbolId)).toBe('needs-resolution');
    expect(original.evidence!.siteIdentities[0]!.contentHash).toBe(hash(source));
    rmSync(join(root, 'src/control.ts'));
    const deleted = await query();
    expect(deleted.sites).toEqual([]);
    expect(deleted.evidence!.sourceScope).toMatchObject({ repositoryId: 'fixture-repository-a',
      sourceFingerprint: null, supportingFiles: [] });
    expect(deleted.evidence!.siteIdentities).toEqual([]);
    expect(deleted.evidence!.relationships).toEqual([]);
    expect(deleted.evidence!.graphScope.sourceCompleteness).toBe('unverified');
  }, 60_000);

  it('retains the requested repository and search boundary for an empty candidate set', async () => {
    writeFileSync(join(root, 'src/control.ts'), source);
    const answer = await firstPartyCallersOffthread({ root, repositoryId: 'fixture-repository-a',
      name: 'absentTarget', paths: ['src'], vendorDir: LSP_VENDOR_DIR });
    expect(answer.error).toBeNull();
    expect(answer.sites).toEqual([]);
    expect(answer.evidence!.sourceScope).toEqual({ repositoryId: 'fixture-repository-a',
      identityKind: 'registry', paths: ['src'], sourceFingerprint: null, supportingFiles: [] });
    expect(answer.evidence!.languageCapabilities.every(capability => capability.status === 'unknown')).toBe(true);
    expect(answer.evidence!.graphScope.limitations.join(' ')).toMatch(/no compiler snapshot/i);
  }, 60_000);

  it('preserves the scope on compiler and worker failures without fabricating source hashes', async () => {
    const failedCompiler = await firstPartyCallersOffthread({ root, repositoryId: 'fixture-repository-a',
      name: 'not an identifier', vendorDir: LSP_VENDOR_DIR });
    expect(failedCompiler.error).toMatch(/one identifier/);
    expect(failedCompiler.evidence!.sourceScope).toMatchObject({ repositoryId: 'fixture-repository-a',
      sourceFingerprint: null, supportingFiles: [] });
    expect(failedCompiler.evidence!.relationships).toEqual([]);
    const workerPath = join(root, 'failed-worker.mjs');
    writeFileSync(workerPath, 'process.on("message", () => process.exit(3));\n');
    const failedWorker = await firstPartyCallersOffthread({ root, repositoryId: 'fixture-repository-a',
      name: 'target', vendorDir: LSP_VENDOR_DIR }, { workerPath });
    expect(failedWorker.error).toMatch(/exited/);
    expect(failedWorker.evidence!.sourceScope).toMatchObject({ repositoryId: 'fixture-repository-a',
      sourceFingerprint: null, supportingFiles: [] });
    expect(failedWorker.evidence!.siteIdentities).toEqual([]);
    expect(failedWorker.freshness.health).toBe('unhealthy');
  }, 60_000);
});
