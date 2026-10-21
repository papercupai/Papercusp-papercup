import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GREEN_CHECKPOINT = readFileSync(
  join(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts'),
  'utf8',
);

describe('longest-green-prefix salvage budget claim', () => {
  it('uses measured candidate-suite time for a normal first-confirm estimate', () => {
    expect(GREEN_CHECKPOINT).toMatch(/const candidateSuiteStartedAtMs = Date\.now\(\);/);
    expect(GREEN_CHECKPOINT).toMatch(
      /const candidateSuiteDurationMs = confirmSuiteEstimateSeedMs\(\s*\{\s*suiteSkipped,\s*nowMs: Date\.now\(\),\s*runStartedAtMs,\s*candidateSuiteStartedAtMs,\s*\}\s*\);/,
    );
    expect(GREEN_CHECKPOINT).toMatch(
      /const salvageCostEstimateMs = candidateSuiteDurationMs;/,
    );
  });

  it('does not repeat the superseded whole-run explanation beside the admission gate', () => {
    const correctionStart = GREEN_CHECKPOINT.indexOf(
      '// ⚠ CORRECTED 2026-08-25 (WI-40086, plan D-064).',
    );
    const admissionStart = GREEN_CHECKPOINT.indexOf('const salvageDeadlineMs =');
    expect(correctionStart).toBeGreaterThanOrEqual(0);
    expect(admissionStart).toBeGreaterThan(correctionStart);

    const admissionRationale = GREEN_CHECKPOINT.slice(correctionStart, admissionStart);
    expect(admissionRationale).not.toContain('because the estimate is whole-run elapsed');
    expect(admissionRationale).not.toContain('this gate reduces to 2T < deadline');
    expect(admissionRationale).not.toContain('Tracked as EI-21434759422783893');
  });
});
