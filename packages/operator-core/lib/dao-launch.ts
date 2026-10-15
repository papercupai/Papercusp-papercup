/**
 * DAO launch preparation. Drafts describe intended rules and evidence; they
 * never confer membership, enact policy, verify a provider, or move funds.
 * Reuses the commercial membership vocabulary and plan-admission validator.
 */
import { z } from 'zod';
import { validatePlanAdmissionPolicy } from './agent-tools/plans/plan-admission-policy';
import type { OrgRole } from './cupboard/commerce-accounts';

const short = z.string().trim().max(240);
const reference = z.string().trim().max(600);
export const DAO_LAUNCH_STEPS = ['organization', 'governance', 'legal', 'banking', 'review'] as const;
export type DaoLaunchStep = typeof DAO_LAUNCH_STEPS[number];

export const daoLaunchSectionsSchema = z.object({
  purpose: z.string().trim().max(2400),
  founders: z.array(z.object({
    name: short.min(1),
    contact: short,
    role: z.enum(['owner', 'admin', 'member']),
  }).strict()).min(1).max(30),
  owners: z.object({
    organization: short, governance: short, legal: short, banking: short, review: short,
  }).strict(),
  governance: z.object({
    voting: z.enum(['members', 'ownership']),
    quorumBps: z.number().int().min(1).max(10_000),
    approvalBps: z.number().int().min(5_001).max(10_000),
    votingDays: z.number().int().min(1).max(365),
    delegation: z.boolean(),
    ownershipReference: reference,
    prepared: z.boolean(),
  }).strict(),
  funding: z.object({
    basis: z.enum(['net-revenue', 'identity-markup', 'contributions']),
    shareBps: z.number().int().min(0).max(10_000),
    agreementReference: reference,
    acceptContributions: z.boolean(),
    prepared: z.boolean(),
  }).strict(),
  legal: z.object({
    route: z.enum(['existing', 'new']),
    country: short,
    entityName: short,
    registrationReference: reference,
    documentReference: reference,
    advisor: short,
    reviewState: z.enum(['not-started', 'in-review', 'prepared']),
  }).strict(),
  banking: z.object({
    provider: short,
    applicationReference: reference,
    reservePlan: z.string().trim().max(1200),
    chain: short,
    safeAddress: z.string().trim().regex(/^$|^0x[a-fA-F0-9]{40}$/, 'Use an EVM address or leave this empty'),
    signers: z.array(z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'Each signer needs an EVM address')).max(20),
    threshold: z.number().int().min(1).max(20),
    prepared: z.boolean(),
  }).strict(),
}).strict().superRefine((sections, ctx) => {
  const policy = validatePlanAdmissionPolicy({
    policyVersion: 1, quorumBps: sections.governance.quorumBps,
    approvalBps: sections.governance.approvalBps,
    ratificationWindowSec: sections.governance.votingDays * 86_400,
    materiality: { maxChangedLines: 200, maxChangedItems: 3 },
  });
  if (!policy.ok) ctx.addIssue({ code: 'custom', path: ['governance'], message: 'Invalid plan-admission policy' });
  const addresses = sections.banking.signers.map(s => s.toLowerCase());
  if (new Set(addresses).size !== addresses.length) {
    ctx.addIssue({ code: 'custom', path: ['banking', 'signers'], message: 'Use different signer addresses' });
  }
  if (sections.banking.signers.length && sections.banking.threshold > sections.banking.signers.length) {
    ctx.addIssue({ code: 'custom', path: ['banking', 'threshold'], message: 'Threshold cannot exceed the signer count' });
  }
});

export type DaoLaunchSections = z.infer<typeof daoLaunchSectionsSchema>;
export interface DaoLaunchRecord {
  id: string;
  name: string;
  creatorId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sections: DaoLaunchSections;
  /** Review binds to one exact revision. Editing any section invalidates it. */
  reviewedRevision: number | null;
}
export interface DaoLaunchProjection extends DaoLaunchRecord {
  steps: DaoLaunchChecklistStep[];
  completedSteps: number;
  preparationReady: boolean;
  /** Actual provider/chain connections are not established by a draft. */
  fundingActive: false;
  treasuryBalance: null;
}
export interface DaoLaunchChecklistStep {
  id: DaoLaunchStep;
  title: string;
  description: string;
  owner: string;
  state: 'prepared' | 'next' | 'waiting' | 'todo';
  missing: string[];
}

export const createDaoLaunchSchema = z.object({
  name: short.min(1),
  purpose: z.string().trim().min(1).max(2400),
}).strict();
export const updateDaoLaunchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: short.min(1),
  sections: daoLaunchSectionsSchema,
}).strict();
export const reviewDaoLaunchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  acknowledgePreparationOnly: z.literal(true),
}).strict();

export function defaultDaoLaunchSections(founderName: string): DaoLaunchSections {
  const role: OrgRole = 'owner';
  return {
    purpose: '',
    founders: [{ name: founderName, contact: '', role }],
    owners: Object.fromEntries(DAO_LAUNCH_STEPS.map(step => [step, founderName])) as DaoLaunchSections['owners'],
    governance: { voting: 'members', quorumBps: 5000, approvalBps: 6700, votingDays: 7, delegation: true, ownershipReference: '', prepared: false },
    funding: { basis: 'net-revenue', shareBps: 1000, agreementReference: '', acceptContributions: true, prepared: false },
    legal: { route: 'existing', country: '', entityName: '', registrationReference: '', documentReference: '', advisor: '', reviewState: 'not-started' },
    banking: { provider: '', applicationReference: '', reservePlan: 'Operating funds; unused customer credits; refunds and chargebacks; taxes; DAO payable', chain: 'Base', safeAddress: '', signers: [], threshold: 2, prepared: false },
  };
}

/** Readiness is preparation readiness, not an authorization to transact. */
export function projectDaoLaunch(record: DaoLaunchRecord): DaoLaunchProjection {
  const s = record.sections;
  const missing: Record<DaoLaunchStep, string[]> = {
    organization: [], governance: [], legal: [], banking: [], review: [],
  };
  if (!record.name.trim()) missing.organization.push('Organization name');
  if (!s.purpose.trim()) missing.organization.push('Shared purpose');
  if (!s.founders.length) missing.organization.push('Founding member');
  if (!s.governance.prepared) missing.governance.push('Review the governance draft');
  if (s.governance.voting === 'ownership' && !s.governance.ownershipReference.trim()) missing.governance.push('Ownership register reference');
  if (!s.funding.prepared) missing.governance.push('Review the funding model');
  if (s.funding.basis !== 'contributions' && !s.funding.agreementReference.trim()) missing.governance.push('Revenue agreement reference');
  if (!s.legal.country.trim()) missing.legal.push('Jurisdiction');
  if (!s.legal.entityName.trim()) missing.legal.push('Entity name');
  if (s.legal.route === 'existing' && !s.legal.registrationReference.trim()) missing.legal.push('Registration reference');
  if (!s.legal.documentReference.trim()) missing.legal.push('Legal document reference');
  if (!s.legal.advisor.trim()) missing.legal.push('Legal review contact');
  if (s.legal.reviewState !== 'prepared') missing.legal.push('Legal preparation review');
  if (!s.banking.provider.trim()) missing.banking.push('Banking provider');
  if (!s.banking.applicationReference.trim()) missing.banking.push('Bank application or account reference');
  if (!s.banking.reservePlan.trim()) missing.banking.push('Reserve accounting plan');
  if (s.banking.signers.length < 2) missing.banking.push('At least two proposed treasury signers');
  if (s.banking.threshold < 2 || s.banking.threshold > s.banking.signers.length) missing.banking.push('Valid threshold of at least two');
  if (!s.banking.prepared) missing.banking.push('Review banking and signer preparation');
  if (record.reviewedRevision !== record.revision) missing.review.push('Review this exact draft version');

  const prepared = (step: DaoLaunchStep) => missing[step].length === 0;
  const titles = ['Define your purpose & founding team', 'Prepare governance & funding rules', 'Prepare your legal entity', 'Prepare banking & treasury', 'Review launch preparation'];
  const descriptions = [
    s.purpose || 'Give the organization a shared purpose and name its founding team.',
    s.governance.voting === 'members' ? 'Member-led voting with a documented funding model.' : 'Ownership-led voting requires an eligible ownership register.',
    s.legal.route === 'existing' ? 'Connect an existing entity and prepare its legal documents.' : 'Prepare a formation route with a legal advisor.',
    'Entity-owned banking, reserve accounting and multiple treasury signers.',
    'Review one consistent version before completing preparation.',
  ];
  let nextChosen = false;
  const steps = DAO_LAUNCH_STEPS.map((id, i): DaoLaunchChecklistStep => {
    const blocked = (id === 'banking' && !prepared('legal')) ||
      (id === 'review' && DAO_LAUNCH_STEPS.slice(0, 4).some(step => !prepared(step)));
    let state: DaoLaunchChecklistStep['state'] = 'todo';
    // A bank preparation cannot be "prepared" while its entity is incomplete.
    if (!blocked && prepared(id)) state = 'prepared';
    else if (blocked) state = 'waiting';
    else if (!nextChosen) { state = 'next'; nextChosen = true; }
    return { id, title: titles[i]!, description: descriptions[i]!, owner: s.owners[id] || 'Unassigned', state, missing: missing[id] };
  });
  const completedSteps = steps.filter(step => step.state === 'prepared').length;
  return { ...record, steps, completedSteps, preparationReady: completedSteps === 5, fundingActive: false, treasuryBalance: null };
}

/** Integer cents: a worked example, never a forecast or a settlement record. */
export function daoFundingExample(shareBps: number, eligibleCents = 100_000) {
  if (!Number.isSafeInteger(shareBps) || shareBps < 0 || shareBps > 10_000 ||
      !Number.isSafeInteger(eligibleCents) || eligibleCents < 0) throw new Error('Invalid funding example');
  const daoCents = Number(BigInt(eligibleCents) * BigInt(shareBps) / 10_000n);
  return { eligibleCents, daoCents, remainingCents: eligibleCents - daoCents };
}
