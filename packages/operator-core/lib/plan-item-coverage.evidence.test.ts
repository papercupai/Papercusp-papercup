import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repository = new URL('../../../', import.meta.url);
const evidence = (name: string) => JSON.parse(readFileSync(
  new URL(`docs/evidence/${name}`, repository), 'utf8',
));
const baseName = 'papercusp-oct1-p010-source-preflight-meta-fixed-2026-10-02.json';
const deadlineName = 'papercusp-oct1-p010-deadline-preflight-2026-10-02.json';
const qualificationName = 'papercusp-oct1-p010-source-qualification-2026-10-02.json';

describe('P010 persisted source receipts', () => {
  // Verify repository artifacts, not a freshly generated copy. This catches a
  // later path redaction or serialization change that strands a byte receipt.
  it.each(['livePreflightR26', 'deadlineGuardPrivate'])(
    '%s resolves its base receipt to the exact persisted bytes', (run) => {
      const receipt = evidence(deadlineName)[run].sourceEvidence.sourceGraph.baseReceipt;
      expect(receipt.path).toBe(`docs/evidence/${baseName}`);
      const bytes = readFileSync(new URL(receipt.path, repository));
      expect(createHash('sha256').update(bytes).digest('hex'), receipt.path).toBe(receipt.sha256);
      expect(receipt.selector).toBe('rows[0].sourceEvidence.sources');
      const sources = JSON.parse(bytes.toString()).rows[0].sourceEvidence.sources;
      expect(sources).toHaveLength(1085);
      expect(new Set(sources.map((source: { path: string }) => source.path)).size).toBe(1085);
    },
  );

  it('the qualification receipt agrees with both retained deadline runs', () => {
    const receipt = evidence(qualificationName).correctedBenchmarkPreflight.sourceReceipt;
    const bytes = readFileSync(new URL(receipt.path, repository));
    expect(createHash('sha256').update(bytes).digest('hex'), fileURLToPath(new URL(receipt.path, repository)))
      .toBe(receipt.sha256);
    const deadline = evidence(deadlineName);
    for (const run of ['livePreflightR26', 'deadlineGuardPrivate']) {
      expect(deadline[run].sourceEvidence.sourceGraph.baseReceipt.sha256).toBe(receipt.sha256);
    }
  });
});
