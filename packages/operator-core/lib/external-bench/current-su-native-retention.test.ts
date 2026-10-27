import { expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneRuns, runHarness } from '@papercusp/verification-harness';
import { currentSuNativeRetainedArtifacts } from '../../test/isolated-integration-proof';

it.for([false, true])('retains current-su phase artifacts through pruning (managedCarry=%s)', async managedCarry => {
  const fixture = mkdtempSync(join(tmpdir(), 'current-su-retention-'));
  const evidenceRoot = join(fixture, 'isolated-integration');
  const requests = '[{"model":"private-fixture","managedCarry":true}]\n';
  vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(fixture, 'retention'));
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(fixture, 'locks'));
  try {
    const original = await runHarness({
      contract: { name: 'isolated-integration', phases: [{ id: 'prepare' }, { id: 'execute' }] },
      evidenceRoot, guardRails: [], retainedArtifacts: currentSuNativeRetainedArtifacts(managedCarry),
      runPhase: async ({ phase, evidenceDir }) => {
        if (phase === 'prepare') {
          writeFileSync(join(evidenceDir, 'operator-api-build.log'), 'original build\n');
          writeFileSync(join(evidenceDir, 'operator-api-build-result.json'), '{"status":0}\n');
          writeFileSync(join(evidenceDir, 'bundle-restricted-hold-inputs.json'), '[]\n');
          writeFileSync(join(evidenceDir, 'hono-host.mjs.build-steps.jsonl'), '{"event":"end"}\n');
        } else if (managedCarry) writeFileSync(join(evidenceDir, 'native-model-requests.json'), requests);
        return { ok: true };
      },
    });
    expect(original.verdict).toBe('pass');
    await runHarness({ contract: { name: 'isolated-integration', phases: [{ id: 'execute' }] },
      evidenceRoot, runId: '20991014T000000Z-1', guardRails: [], runPhase: async () => ({ ok: true }) });
    expect(await pruneRuns(evidenceRoot, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }), reserveBytes: () => 400,
    })).toContain(original.runId);
    expect(existsSync(original.evidenceDir)).toBe(false);
    const retainedRequests = join(evidenceRoot, 'retained', original.runId, 'phases/execute/native-model-requests.json');
    if (managedCarry) expect(readFileSync(retainedRequests, 'utf8')).toBe(requests);
    else expect(existsSync(retainedRequests)).toBe(false);
    expect(readFileSync(join(evidenceRoot, 'retained', original.runId,
      'phases/prepare/operator-api-build.log'), 'utf8')).toBe('original build\n');
  } finally {
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
});
