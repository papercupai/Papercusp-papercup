/**
 * Integration rung for the deployed-unit model-file guard
 * (reboot-residue-service-repairs-2026-10-03, spec FAIL-P-002-ornith-model-blob).
 *
 * Contract: when the GGUF named by the catalog-selected llama-server unit is missing from its
 * configured path, the deployed-unit audit reports it as degraded. ensureLocalBackendRunning runs
 * that audit before it starts llama-ornith.service, so the service is never reported healthy on a
 * missing blob. The unit rung (unit-drift.test.ts) injects `access` stubs. This rung uses none:
 * it renders the unit with the production renderer for the real ornith catalog entry, puts the
 * weights path on a real filesystem, and lets the audit's default `fs.access` decide. That is the
 * boundary the 2026-10-02 reboot residue crossed, when a disk reclamation deleted the model store
 * under a still-running process.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLlamaServerUnit } from './backend-config';
import { CERTIFIED_CATALOG } from './catalog';
import { auditDeployedUnitForBackend } from './unit-drift';

const ORNITH = CERTIFIED_CATALOG.find((e) => e.id === 'ornith-35b-iq3m-llama-server')!;
// The registered `ornith-llamaserver` local_backends row as it exists on the dev box (kind + its full
// alias list), so the catalog join runs over the same input the gateway hands it.
const BACKEND = {
  kind: ORNITH.backend,
  models: [ORNITH.model.ollamaRef, `ollama-cc/${ORNITH.model.ollamaRef}`, 'ornith:35b', 'ornith:fast', 'ornith-35b', 'ornith'],
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A unit exactly as the provisioner would render it for the ornith entry, pointing at `weightsPath`. */
function deployedUnit(weightsPath: string): string {
  return renderLlamaServerUnit({
    alias: ORNITH.model.ollamaRef,
    weightsPath,
    host: ORNITH.serve.host,
    port: ORNITH.serve.portDefault,
    parallelSlots: ORNITH.serve.parallelSlots,
    ctxTotal: ORNITH.serve.ctxTotal,
    kvCacheType: ORNITH.serve.kvCacheType,
    flashAttn: ORNITH.serve.flashAttn,
    jinja: ORNITH.serve.jinja,
    reasoningBudget: ORNITH.serve.reasoningBudget,
    gpuLayers: ORNITH.serve.gpuLayers,
    fit: ORNITH.serve.fit,
    fitTargetMiB: ORNITH.serve.fitTargetMiB,
    // A binary that really exists and is executable, so the engine-binary check answers from disk too.
    binPath: process.execPath,
    logPath: '/var/tmp/llama-server-ornith.log',
  });
}

function blobStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ornith-blob-store-'));
  dirs.push(dir);
  return dir;
}

describe('deployed-unit audit on a real filesystem — missing ornith GGUF (FAIL-P-002)', () => {
  it('the catalog entry resolves for the ornith backend (the audit is not vacuously unauditable)', async () => {
    const audit = await auditDeployedUnitForBackend(BACKEND, deployedUnit(join(blobStore(), 'present.gguf')));
    expect(audit.verdict).not.toBe('unauditable');
    expect(audit.catalogEntryId).toBe(ORNITH.id);
  });

  it('weights absent at the configured blob path → degraded, model[missing], never ok', async () => {
    const missing = join(blobStore(), 'sha256-deleted-by-disk-reclamation');
    const audit = await auditDeployedUnitForBackend(BACKEND, deployedUnit(missing));
    expect(audit.verdict).toBe('degraded');
    expect(audit.model).toMatchObject({ ok: false, reason: 'missing' });
    expect(audit.summary).toContain('model[missing');
    expect(audit.summary).toContain(missing);
  });

  it('weights present and readable → the model check passes (control)', async () => {
    const present = join(blobStore(), 'sha256-present');
    writeFileSync(present, 'GGUF');
    const audit = await auditDeployedUnitForBackend(BACKEND, deployedUnit(present));
    expect(audit.model).toMatchObject({ ok: true });
    expect(audit.summary).not.toContain('model[');
    expect(audit.binary).toMatchObject({ ok: true });
  });

  it.skipIf(process.getuid?.() === 0)('weights present but unreadable → degraded, not ok', async () => {
    const unreadable = join(blobStore(), 'sha256-unreadable');
    writeFileSync(unreadable, 'GGUF');
    chmodSync(unreadable, 0o000);
    const audit = await auditDeployedUnitForBackend(BACKEND, deployedUnit(unreadable));
    expect(audit.verdict).toBe('degraded');
    expect(audit.model).toMatchObject({ ok: false, reason: 'not-readable' });
  });
});
