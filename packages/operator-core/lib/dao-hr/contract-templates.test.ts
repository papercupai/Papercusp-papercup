/**
 * Unit tests for the pure half of the contract-template registry (dao-hr-people-2026-10-11 P-001).
 * Expected values are literals written from the clauses, never recomputed through the subject.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ContractTemplateError,
  NON_BINDING_STAMP,
  approvalApplies,
  bindingGate,
  buildCounselApprovalRecord,
  renderTemplate,
  stampDocument,
  templateContentHash,
  validateTemplateContent,
} from './contract-templates';
import { SAMPLE_CONTRACT_TEMPLATES } from './contract-template-samples';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ContractTemplateError ? error.code : `not-a-ContractTemplateError:${String(error)}`;
  }
}

describe('SPEC-P-001 — an unapproved template yields a Non-binding sample', () => {
  it('the gate stamps a contract whose template has no counsel approval, even with a formed entity', () => {
    expect(bindingGate({ isSample: false, counselApproved: false, entityFormed: true })).toEqual({
      bindingEligible: false,
      stamp: 'Non-binding sample',
      reasons: ['template_unapproved'],
    });
  });

  it('the stamp is written into the document itself', () => {
    const gate = bindingGate({ isSample: false, counselApproved: false, entityFormed: true });
    const doc = stampDocument('Body text.', gate);
    expect(doc.startsWith('NON-BINDING SAMPLE — Non-binding sample: the template version has no counsel approval.')).toBe(true);
    expect(doc.endsWith('\n\nBody text.')).toBe(true);
  });

  it('a sample template is never bindable', () => {
    expect(bindingGate({ isSample: true, counselApproved: true, entityFormed: true })).toMatchObject({
      bindingEligible: false,
      stamp: 'Non-binding sample',
      reasons: ['template_is_sample'],
    });
  });

  it('only approved + formed + non-sample is eligible, with no stamp', () => {
    expect(bindingGate({ isSample: false, counselApproved: true, entityFormed: true })).toEqual({
      bindingEligible: true,
      stamp: null,
      reasons: [],
    });
    expect(stampDocument('Body text.', { bindingEligible: true, stamp: null, reasons: [] })).toBe('Body text.');
  });
});

describe('SPEC-P-001-B — an approved template without a formed entity is still a Non-binding sample', () => {
  it('the gate stamps it and names the missing entity', () => {
    expect(bindingGate({ isSample: false, counselApproved: true, entityFormed: false })).toEqual({
      bindingEligible: false,
      stamp: 'Non-binding sample',
      reasons: ['no_formed_entity'],
    });
  });

  it('the document stamp says no issuing entity has been formed', () => {
    const doc = stampDocument('x', bindingGate({ isSample: false, counselApproved: true, entityFormed: false }));
    expect(doc).toContain('Non-binding sample: no issuing entity has been formed.');
  });
});

describe('SPEC-P-001-F — an approval record stores the hash of the version it approves', () => {
  const version = { templateKey: 'offer-letter-us-ca', version: 3, contentHash: `sha256:${'a'.repeat(64)}` };

  it('copies the approved version’s hash, key and number', () => {
    const record = buildCounselApprovalRecord(version, {
      approverRef: 'Counsel LLP (J. Doe)',
      approvedOn: '2026-10-01',
      reference: 'MATTER-42',
    });
    expect(record).toEqual({
      templateKey: 'offer-letter-us-ca',
      version: 3,
      contentHash: `sha256:${'a'.repeat(64)}`,
      approverRef: 'Counsel LLP (J. Doe)',
      approvedOn: '2026-10-01',
      reference: 'MATTER-42',
    });
  });

  it('a record for a different version holds that version’s hash, not another’s', () => {
    const other = { templateKey: 'offer-letter-us-ca', version: 4, contentHash: `sha256:${'b'.repeat(64)}` };
    const record = buildCounselApprovalRecord(other, { approverRef: 'Counsel LLP', approvedOn: '2026-10-02', reference: 'M-43' });
    expect(record.contentHash).toBe(`sha256:${'b'.repeat(64)}`);
    expect(record.version).toBe(4);
  });

  it('the approval applies only while the version still has that hash', () => {
    expect(approvalApplies({ contentHash: `sha256:${'a'.repeat(64)}` }, `sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(approvalApplies({ contentHash: `sha256:${'a'.repeat(64)}` }, `sha256:${'c'.repeat(64)}`)).toBe(false);
    expect(approvalApplies(null, `sha256:${'a'.repeat(64)}`)).toBe(false);
  });
});

describe('content hash', () => {
  it('is sha256 over {body, sorted mergeFields} as canonical JSON', () => {
    const expected = `sha256:${createHash('sha256').update('{"body":"Hi {{a}} {{b}}","mergeFields":["a","b"]}', 'utf8').digest('hex')}`;
    expect(templateContentHash('Hi {{a}} {{b}}', ['b', 'a'])).toBe(expected);
  });

  it('changes when the body changes', () => {
    expect(templateContentHash('Hi {{a}}', ['a'])).not.toBe(templateContentHash('Hi there {{a}}', ['a']));
  });
});

describe('merge fields', () => {
  it('declared fields must match the placeholders exactly', () => {
    expect(validateTemplateContent('Dear {{name_ref}}, {{x}}', ['x', 'name_ref'])).toEqual({
      body: 'Dear {{name_ref}}, {{x}}',
      mergeFields: ['name_ref', 'x'],
    });
    expect(codeOf(() => validateTemplateContent('Dear {{a}}', []))).toBe('invalid_input');
    expect(codeOf(() => validateTemplateContent('Dear {{a}}', ['a', 'b']))).toBe('invalid_input');
    expect(codeOf(() => validateTemplateContent('Dear {{Bad Name}}', []))).toBe('invalid_input');
    expect(codeOf(() => validateTemplateContent('   ', []))).toBe('invalid_input');
  });

  it('rendering fills every field and refuses missing or unknown values', () => {
    expect(renderTemplate('Dear {{a}}, {{ b }}.', ['a', 'b'], { a: 'Ana', b: 'welcome' })).toBe('Dear Ana, welcome.');
    expect(codeOf(() => renderTemplate('Dear {{a}}', ['a'], {}))).toBe('merge_value_missing');
    expect(codeOf(() => renderTemplate('Dear {{a}}', ['a'], { a: 'x', z: 'y' }))).toBe('merge_value_unexpected');
  });
});

describe('SPEC-P-001-D (unit) — the approval record refuses missing fields', () => {
  const version = { templateKey: 't', version: 1, contentHash: `sha256:${'a'.repeat(64)}` };
  it('approver-missing / date-missing / reference-missing each refuse', () => {
    expect(codeOf(() => buildCounselApprovalRecord(version, { approverRef: '', approvedOn: '2026-10-01', reference: 'R' }))).toBe('invalid_input');
    expect(codeOf(() => buildCounselApprovalRecord(version, { approverRef: 'C', approvedOn: undefined, reference: 'R' }))).toBe('invalid_input');
    expect(codeOf(() => buildCounselApprovalRecord(version, { approverRef: 'C', approvedOn: '2026-02-30', reference: 'R' }))).toBe('invalid_input');
    expect(codeOf(() => buildCounselApprovalRecord(version, { approverRef: 'C', approvedOn: '2026-10-01', reference: '  ' }))).toBe('invalid_input');
  });
});

describe('shipped sample templates', () => {
  it('cover every document kind and are each labelled as a counsel-unreviewed sample', () => {
    expect(SAMPLE_CONTRACT_TEMPLATES.map((t) => `${t.documentKind}/${t.engagementType}`).sort()).toEqual([
      'contractor-agreement/contractor',
      'employment-agreement/employee',
      'equity-grant-agreement/contractor',
      'equity-grant-agreement/employee',
      'ip-assignment/contractor',
      'ip-assignment/employee',
      'onboarding-forms-list/contractor',
      'onboarding-forms-list/employee',
    ]);
    for (const t of SAMPLE_CONTRACT_TEMPLATES) {
      expect(t.body.startsWith('SAMPLE TEMPLATE — NOT REVIEWED OR APPROVED BY COUNSEL.')).toBe(true);
      expect(t.templateKey.startsWith('sample-')).toBe(true);
      expect(validateTemplateContent(t.body, t.mergeFields).mergeFields).toEqual(t.mergeFields);
    }
  });

  it('exports the stamp text the plan names', () => {
    expect(NON_BINDING_STAMP).toBe('Non-binding sample');
  });
});
