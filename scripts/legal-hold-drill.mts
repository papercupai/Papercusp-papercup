#!/usr/bin/env tsx
/** P-017 operational acceptance. Creates and drops ONLY private migrated fixture databases. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createOrgTestDb } from '../packages/operator-core/test/_org-test-db.ts';
import { snapshotOrgFixture } from '../packages/operator-core/test/_org-snapshot.ts';
import { runLegalHoldDrill } from '../packages/operator-core/lib/data-governance/legal-holds-operational.ts';
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';

// Verification-harness contract (lint:vh-contract): selection flags (--only/--from/--reuse) are
// parsed out; the first remaining positional is the evidence path, exactly as before.
const selection = parseSelectionArgs(process.argv.slice(2));
const output = selection.rest[0];
if (!output) throw new Error('Usage: node --import tsx scripts/legal-hold-drill.mts <evidence.json>');
const sourcePaths = [
  'scripts/legal-hold-drill.mts',
  'packages/operator-core/lib/data-governance/legal-holds-operational.ts',
  'packages/operator-core/lib/data-governance/legal-holds.ts',
  'packages/operator-core/lib/data-governance/organization-data-receipts.ts',
  'packages/operator-core/lib/data-sources/chat-retrieval-units.ts',
  'packages/operator-core/lib/data-sources/documents-corpus.ts',
  'packages/operator-core/test/_org-test-db.ts',
  'packages/operator-core/test/_org-snapshot.ts',
];
const sourceSnapshot = () => Promise.all(sourcePaths.map(async path => ({ path,
  sha256: createHash('sha256').update(await readFile(resolve(path))).digest('hex') })));
const harness = await runHarness({
  contract: { name: 'legal-hold-drill', phases: [{ id: 'drill', description: 'P-017 isolated physical-snapshot legal-hold acceptance' }] },
  evidenceRoot: defaultEvidenceRoot('legal-hold-drill'), selection, reuseFrom: selection.reuse,
  async runPhase(ctx) {
    ctx.markStep('isolated-org-fixture');
    const startedAt = new Date().toISOString();
    const executedSources = await sourceSnapshot();
    const org = await createOrgTestDb();
    try {
      const result = await runLegalHoldDrill({ sql: org.adminSql, snapshot: () => snapshotOrgFixture(org) });
      const sourceStable = JSON.stringify(executedSources) === JSON.stringify(await sourceSnapshot());
      result.assertions.push({ id: 'executed-source-bytes-stable', passed: sourceStable,
        evidence: `SHA-256 before/after execution agrees for ${executedSources.length} explicitly enumerated source files.` });
      if (!sourceStable) result.exitCode = 1;
      const artifact = { schemaVersion: 1, kind: 'operational-test-evidence',
        name: 'P-017 physical snapshot legal-hold acceptance', framework: 'operational',
        command: ['node', '--import', 'tsx', 'scripts/legal-hold-drill.mts', output],
        startedAt, finishedAt: new Date().toISOString(), ...result, executedSources,
        boundary: 'Isolated physical PostgreSQL snapshot; production governance APIs. No host/cloud backup or deployed-main claim.' };
      await writeFile(resolve(output), JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write(JSON.stringify({ output, exitCode: result.exitCode, assertions: result.assertions }) + '\n');
      if (result.exitCode === 0) return { ok: true, detail: `${result.assertions.length} assertion(s) passed` };
      const failed = result.assertions.filter((a) => !a.passed).map((a) => a.id);
      return { ok: false, reasonCode: 'drill-assertion-failed', step: 'legal-hold-drill', detail: `failed: ${failed.join(', ') || `exitCode ${result.exitCode}`}` };
    } finally { await org.cleanup(); }
  },
});
process.exitCode = harness.verdict === 'pass' ? 0 : 1;
