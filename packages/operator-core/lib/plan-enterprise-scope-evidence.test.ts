import { describe, expect, it } from 'vitest';
import {
  ENTERPRISE_AREAS, evidenceTable, inspectEnterpriseScope, inspectEnterpriseEvidenceRecord,
  type EnterpriseEvidenceRecord,
} from './doc-claims/enterprise-evidence';

function scope() {
  return {
    census: '| Enterprise area | State | Reuse | Owner |\n| --- | --- | --- | --- |\n'
      + ENTERPRISE_AREAS.map((name) => `| ${name} | SOURCE-ONLY: [writer](writer.ts); runtime unknown | Extend existing writer | Platform P-001 / WI-10007896 |`).join('\n'),
    assumptions: 'D-009 D-010\n| Id | Assumption | Source | Override |\n| --- | --- | --- | --- |\n'
      + Array.from({ length: 10 }, (_, i) => `| A-${i + 1} — ASSUMED | Engineering choice | D-009 | Actual buyer finding |`).join('\n'),
    pilot: 'A-1 to A-10 define the assumed pilot contract',
  };
}

describe('R1 semantic scope detector (fixture controls, no buyer approval)', () => {
  it('accepts a complete truthful source-only matrix and retains operational gaps', () => {
    const result = inspectEnterpriseScope(scope());
    expect(result.violations).toEqual([]);
    expect(result.unverified).toContain('immutable approved P-003 scope, threshold and approval record');
  });
  it.each(ENTERPRISE_AREAS)('detects removal of area %s', (area) => {
    const input = scope();
    input.census = input.census.split('\n').filter((line) => !line.startsWith(`| ${area} |`)).join('\n');
    expect(inspectEnterpriseScope(input).violations).toContainEqual({ code: 'scope-population', subject: area });
  });
  it.each([
    ['support promotion', 'SOURCE-ONLY:', 'SUPPORTED:', 'source-classification'],
    ['duplicate surface', 'Extend existing writer', 'Build new registry', 'reuse-justification'],
    ['unowned area', 'Platform P-001 / WI-10007896', 'TBD', 'scope-owner'],
  ])('rejects %s while preserving the population', (_name, before, after, code) => {
    const input = scope(); input.census = input.census.replace(before, after);
    expect(inspectEnterpriseScope(input).violations.map((v) => v.code)).toContain(code);
  });
  it.each(['buyer-evidence', 'partner-evidence', 'customer-evidence'])('refuses ASSUMED relabelled as %s', (label) => {
    const input = scope(); input.assumptions = input.assumptions.replace('Engineering choice', label);
    expect(inspectEnterpriseScope(input).violations.map((v) => v.code)).toContain('assumption-classification');
  });
  it('permits explicit denial of customer evidence but refuses a separate affirmative claim', () => {
    const input = scope();
    input.assumptions = input.assumptions.replace('Engineering choice', 'Internal simulation, never reported as customer evidence');
    expect(inspectEnterpriseScope(input).violations).toEqual([]);
    input.assumptions = input.assumptions.replace('never reported as customer evidence', 'never reported as customer evidence; this is buyer-evidence');
    expect(inspectEnterpriseScope(input).violations.map((v) => v.code)).toContain('assumption-classification');
  });
  it('refuses missing assumption, override, authority and pilot bindings separately', () => {
    const input = scope();
    input.assumptions = input.assumptions.replace('A-10 — ASSUMED', 'A-9 — ASSUMED').replace('D-010', '').replace('Actual buyer finding', '');
    input.pilot = 'Approved with no assumption references';
    expect(new Set(inspectEnterpriseScope(input).violations.map((v) => v.code))).toEqual(new Set([
      'assumption-population', 'assumption-provenance', 'assumption-authority', 'pilot-assumption-binding',
    ]));
  });
  it('does not split escaped table pipes or accept a missing separator', () => {
    expect(evidenceTable('| Id | Value |\n| --- | --- |\n| A-1 | a \\| b |', 'Id')).toEqual([['A-1', 'a \\| b']]);
    expect(evidenceTable('| Id | Value |\n| A-1 | a |', 'Id')).toEqual([]);
  });
});

const record: EnterpriseEvidenceRecord = {
  ref: 'fixture:approved-scope', hash: 'a'.repeat(64), workspace: 'fixture-workspace',
  subject: 'P-003@1', profile: 'assumed-internal', owner: 'fixture-approver',
  observedAt: '2026-10-14T00:00:00Z', expiresAt: '2026-10-16T00:00:00Z',
};
const context = { workspace: record.workspace, subject: record.subject, profile: record.profile, now: Date.parse('2026-10-15T00:00:00Z') };
describe('R1 attributable record resolver (test fixtures confer no approval)', () => {
  it('requires the independently resolved record', () => {
    expect(inspectEnterpriseEvidenceRecord(record, context, () => undefined)).toEqual([{ code: 'record-missing', subject: record.ref }]);
    expect(inspectEnterpriseEvidenceRecord(record, context, () => record)).toEqual([]);
  });
  it.each(['hash', 'owner', 'subject', 'workspace', 'profile', 'observedAt', 'expiresAt'] as const)('refuses misattributed %s', (key) => {
    const forged = { ...record, [key]: 'forged' };
    expect(inspectEnterpriseEvidenceRecord(forged, context, () => record)).toContainEqual({ code: 'record-binding', subject: key });
  });
  it.each(['workspace', 'subject', 'profile'] as const)('refuses a genuinely stored foreign %s', (key) => {
    const foreign = { ...record, [key]: 'foreign' };
    expect(inspectEnterpriseEvidenceRecord(foreign, context, () => foreign)).toContainEqual({ code: 'record-scope', subject: key });
  });
  it.each(['2026-10-15T00:00:00Z', 'invalid', '2026-10-13T00:00:00Z'])('refuses stale/invalid expiry %s', (expiresAt) => {
    const stale = { ...record, expiresAt };
    expect(inspectEnterpriseEvidenceRecord(stale, context, () => stale).map((v) => v.code)).toContain('record-stale');
  });
});
