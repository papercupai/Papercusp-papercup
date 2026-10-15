/**
 * Shipped SAMPLE contract templates (dao-hr-people-2026-10-11 P-001, D-006).
 *
 * These are placeholders that let the hiring flow run end to end on the test chain and the
 * e-signature sandbox. They are NOT counsel-approved, can never be approved
 * (contract-templates.ts refuses), and every contract generated from one is stamped
 * "Non-binding sample". Real templates come from counsel (owner follow-up WI-6554700010008575)
 * and are registered with createContractTemplate.
 */
import type { DocumentKind } from './contract-templates';
import type { EngagementType } from './work-profile';

export interface SampleContractTemplate {
  templateKey: string;
  documentKind: DocumentKind;
  engagementType: EngagementType;
  jurisdiction: string;
  title: string;
  body: string;
  mergeFields: string[];
}

const SAMPLE_JURISDICTION = 'US-DE';
const BANNER = 'SAMPLE TEMPLATE — NOT REVIEWED OR APPROVED BY COUNSEL. FOR TESTING ONLY.';

function sample(
  documentKind: DocumentKind,
  engagementType: EngagementType,
  title: string,
  clauses: string[],
): SampleContractTemplate {
  const body = [BANNER, '', `${title} (${engagementType}, ${SAMPLE_JURISDICTION})`, '', ...clauses].join('\n');
  const mergeFields = [...new Set([...body.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!))].sort();
  return {
    templateKey: `sample-${documentKind}-${engagementType}-${SAMPLE_JURISDICTION.toLowerCase()}`,
    documentKind,
    engagementType,
    jurisdiction: SAMPLE_JURISDICTION,
    title: `Sample ${title}`,
    body,
    mergeFields,
  };
}

const PARTIES = 'This agreement is between {{issuer_title}} ("the Company") and {{person_ref}} ("you").';
const ROLE = 'Role: {{role_title}}, starting {{start_date}}.';
const PAY = 'Pay: {{pay_amount}} {{pay_currency}} per {{pay_cadence}}.';
const CONDITION = 'This agreement takes effect only upon passage of the DAO hire proposal {{hire_proposal_ref}}.';

export const SAMPLE_CONTRACT_TEMPLATES: readonly SampleContractTemplate[] = [
  sample('employment-agreement', 'employee', 'Employment agreement', [PARTIES, ROLE, PAY, CONDITION]),
  sample('contractor-agreement', 'contractor', 'Contractor agreement', [
    PARTIES,
    'Services: {{role_title}}, starting {{start_date}}. You are an independent contractor, not an employee.',
    PAY,
    CONDITION,
  ]),
  ...(['employee', 'contractor'] as const).flatMap((engagement) => [
    sample('ip-assignment', engagement, 'Intellectual property assignment', [
      PARTIES,
      'You assign to the Company the work product you create for it in the course of {{role_title}}.',
    ]),
    sample('equity-grant-agreement', engagement, 'Equity grant agreement', [
      PARTIES,
      'Grant: {{share_amount}} shares vesting over {{vesting_months}} months with a {{cliff_months}}-month cliff.',
      CONDITION,
    ]),
    sample('onboarding-forms-list', engagement, 'Onboarding forms list', [
      'Forms {{person_ref}} completes before starting: identity verification, wallet binding, tax form for {{tax_jurisdiction}}.',
    ]),
  ]),
];
