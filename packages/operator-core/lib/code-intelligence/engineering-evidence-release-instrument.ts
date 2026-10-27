import { join } from 'node:path';
import type { CommandInstrument } from '../rubric-instrument-registry';
import { ENGINEERING_RELEASE_BUDGET_MS } from '../../../../scripts/verify-engineering-evidence-release.mjs';

export const ENGINEERING_EVIDENCE_RELEASE_INSTRUMENT = 'native-engineering-evidence:final-release';
export const ENGINEERING_EVIDENCE_CURRENT_INSTRUMENT = 'native-engineering-evidence:current-build';
export function engineeringEvidenceReleaseInstrument(root: string, plane: 'final-release' | 'current-build' = 'final-release'): CommandInstrument {
  return { key: plane === 'final-release' ? ENGINEERING_EVIDENCE_RELEASE_INSTRUMENT : ENGINEERING_EVIDENCE_CURRENT_INSTRUMENT,
    evaluator: 'command', unit: 'count',
    description: `Fresh maintained Tauri graph/UI journey on the exact ${plane} artifact with accepted source containment and negative controls; current-build also runs the canonical integration/UI detectors on a throwaway PG. 0 verified; missing/mismatched evidence unknown. Independent acceptance remains separately enforced.`,
    argv: [process.execPath, join(root, 'scripts/verify-engineering-evidence-release.mjs'), root, plane],
    timeoutMs: ENGINEERING_RELEASE_BUDGET_MS + 60_000,
    parse(stdout) {
      try {
        const row = JSON.parse(stdout.trim());
        const integration = plane !== 'current-build' || (row.integration?.logPath && /^[a-f0-9]{64}$/.test(row.integration?.sha256 ?? '')
          && row.integration.files?.length === 4 && row.integration.result?.includes('requested=4 executed=4 matched=4 status=passed'));
        return integration && row.scope === `native-engineering-evidence-${plane}-v1` && row.status === 'pass' && row.plane === plane
          && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row.buildSha ?? '') && /^[a-f0-9]{64}$/.test(row.manifestSha256 ?? '')
          && /^[a-f0-9]{64}$/.test(row.receiptSha256 ?? '') && typeof row.receiptPath === 'string' && row.receiptPath.length > 0
          && typeof row.nonce === 'string' && row.nonce.length > 0 ? 0 : null;
      } catch { return null; }
    },
  };
}
