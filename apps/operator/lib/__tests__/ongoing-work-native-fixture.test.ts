import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordNativeCollectionJourney } from '../../e2e/_ongoing-work-native-fixture';

describe('native collection journey custody', () => {
  it.each(['pass', 'assertion-failure', 'source-drift', 'missing-test'])(
    'retains an authentic %s verdict without inventing a pass', async outcome => {
      const root = await mkdtemp(join(tmpdir(), 'native-journey-custody-'));
      try {
        await mkdir(join(root, 'test'));
        const file = join(root, 'test/native.spec.mts');
        await writeFile(file, 'original source');
        const startedAt = Date.now();
        const run = async () => {
          if (outcome === 'assertion-failure') throw new Error('native assertion failed');
          if (outcome === 'source-drift') await writeFile(file, 'changed source');
        };
        const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
          testedInputs: [{ path: 'test/native.spec.mts', sha256: createHash('sha256').update('original source').digest('hex') }] };
        const execute = recordNativeCollectionJourney({ sourceRoot: root, sourceReceipt: receipt,
          verifierRunId: '20261009T000000Z-100', evidenceRoot: join(root, 'evidence'),
          testPath: outcome === 'missing-test' ? 'test/other.spec.mts' : 'test/native.spec.mts', run });
        if (outcome !== 'pass') {
          await expect(execute).rejects.toThrow();
          if (outcome !== 'missing-test') {
            const [runId] = (await readdir(join(root, 'evidence'))).filter(name => /^\d{8}T/.test(name));
            const result = JSON.parse(await readFile(join(root, 'evidence', runId, 'result.json'), 'utf8'));
            expect(result.verdict).toBe('fail');
            await expect(readFile(join(root, 'evidence', runId, 'phases/native/manifest.json')))
              .rejects.toMatchObject({ code: 'ENOENT' });
          }
          return;
        }
        const selector = await execute;
        const result = JSON.parse(await readFile(join(root, 'evidence', selector.journeyRunId, 'result.json'), 'utf8'));
        const manifest = JSON.parse(await readFile(join(root, 'evidence', selector.journeyRunId, 'phases/native/manifest.json'), 'utf8'));
        expect(result).toMatchObject({ harness: 'native-journey', verdict: 'pass', reuseFromRunId: null });
        expect(Date.parse(result.startedAt)).toBeGreaterThanOrEqual(startedAt);
        expect(Date.parse(result.endedAt)).toBeLessThanOrEqual(Date.now());
        expect(manifest).toMatchObject({ result: 'pass', sourceCommit: receipt.sourceCommit,
          sourceFingerprints: receipt.testedInputs, verifierRunId: selector.verifierRunId });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
});
