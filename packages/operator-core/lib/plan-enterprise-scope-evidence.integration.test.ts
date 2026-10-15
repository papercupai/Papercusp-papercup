/** Artifact integration only. No mocked document is presented as buyer/runtime proof. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectEnterpriseScope } from './doc-claims/enterprise-evidence';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name: string) => readFileSync(resolve(root, 'docs/evidence', name), 'utf8');
const input = () => ({
  census: read('enterprise-capability-reuse-census-2026-10-09.md'),
  assumptions: read('enterprise-assumed-profile-2026-10-13.md'),
  pilot: read('enterprise-pilot-contract-draft-2026-10-11.md'),
});
describe('R1 maintained scope artifacts', () => {
  it('keeps the maintained census and per-row assumptions truthful without accepting the feature', () => {
    const result = inspectEnterpriseScope(input());
    expect(result.violations).toEqual([]);
    expect(result.unverified).toHaveLength(3);
    const source = JSON.parse(read('enterprise-capability-source-census-2026-10-09.json'));
    expect(source.testsExecuted).toEqual([]);
    expect(source.sourceHashes.every((entry: { evidenceKind: string; runtimeVerified: boolean }) =>
      entry.evidenceKind === 'source-inspection' && entry.runtimeVerified === false)).toBe(true);
  });
  it('catches actual census state promotion and a deleted population member', () => {
    const current = input();
    current.census = current.census.replace('SOURCE-ONLY:', 'SUPPORTED:').split('\n')
      .filter((line) => !line.startsWith('| Finance and accepted-outcome cost |')).join('\n');
    expect(inspectEnterpriseScope(current).violations.map((v) => v.code)).toEqual(expect.arrayContaining(['source-classification', 'scope-population']));
  });
  it('catches actual register row promoted to customer evidence while its global disclaimer survives', () => {
    const current = input();
    current.assumptions = current.assumptions.replace('A-1 Segment — ASSUMED', 'A-1 Segment — CUSTOMER-VERIFIED');
    expect(current.assumptions).toContain('Status: ASSUMED, not buyer evidence');
    expect(inspectEnterpriseScope(current).violations.map((v) => v.code)).toContain('assumption-classification');
  });
  it('catches an invented duplicate service without a reason existing surfaces fail', () => {
    const current = input(); current.census = current.census.replace('Extend the verified-receipt projection', 'Build new service');
    expect(inspectEnterpriseScope(current).violations.map((v) => v.code)).toContain('reuse-justification');
  });
});
