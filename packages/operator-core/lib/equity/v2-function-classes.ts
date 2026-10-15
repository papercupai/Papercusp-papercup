/**
 * Who may call each state-changing function of PapercuspEquityV2 (dao-hr-people-2026-10-11
 * D-004, D-008). `governance` = only the timelock after a member vote (hire, fire, eligibility
 * freeze, admin replacement); `admin` = the bounded admin role, no vote; `anyone` = any caller,
 * but the contract scopes the effect to the caller's own position (or, for bootstrap wiring,
 * to the issuer wallet before governance is bound). equity-v2.test.ts asserts this table matches
 * the compiled ABI exactly and that every governance/admin entry refuses other callers.
 */
export type EquityV2CallerClass = 'governance' | 'admin' | 'anyone';
export interface EquityV2FunctionClass { class: EquityV2CallerClass; scope: string }

export const EQUITY_V2_FUNCTION_CLASSES = Object.freeze({
  registerHolder: { class: 'governance', scope: 'hire: register the new holder' },
  commitGrant: { class: 'governance', scope: 'hire: commit the equity grant' },
  stopGrant: { class: 'governance', scope: 'fire: stop future vesting; earned equity stays' },
  setEligibility: { class: 'governance', scope: 'legal eligibility freeze or restore' },
  replaceAdmin: { class: 'governance', scope: 'replace a lost or compromised admin' },
  transferAdmin: { class: 'admin', scope: 'hand the admin role to a successor' },
  setGrantLimit: { class: 'admin', scope: 'prospective per-grant limit, at most the immutable maximum' },
  setReturnPolicy: { class: 'admin', scope: 'payout rate and cadence within the immutable ceiling and minimum interval' },
  raiseGrant: { class: 'admin', scope: 'raise an unvested grant within the per-grant limit' },
  triggerPayout: { class: 'admin', scope: 'trigger a due payout at the configured rate' },
  activateGenesis: { class: 'anyone', scope: 'issuer bootstrap wallet only, once' },
  bindGovernance: { class: 'anyone', scope: 'issuer bootstrap wallet only, once, before governance is bound' },
  acceptTerms: { class: 'anyone', scope: "the caller's own registration" },
  claimGrant: { class: 'anyone', scope: "the caller's own grant" },
  resignGrant: { class: 'anyone', scope: "the caller's own grant (resignation)" },
  claimReturn: { class: 'anyone', scope: "the caller's own payout entitlement" },
  setRecoveryAgent: { class: 'anyone', scope: "the caller's own registration" },
  requestRecovery: { class: 'anyone', scope: "the holder's wallet or its pre-authorized recovery agent" },
  acceptRecovery: { class: 'anyone', scope: 'the requested recovery destination wallet' },
  transfer: { class: 'anyone', scope: "the caller's own shares, eligible parties only" },
  transferFrom: { class: 'anyone', scope: 'an approved allowance, eligible parties only' },
  approve: { class: 'anyone', scope: "the caller's own allowance" },
  delegate: { class: 'anyone', scope: "the caller's own voting power, eligible delegatee only" },
  delegateBySig: { class: 'anyone', scope: "the signer's own voting power, eligible delegatee only" },
} satisfies Record<string, EquityV2FunctionClass>);

export type EquityV2FunctionName = keyof typeof EQUITY_V2_FUNCTION_CLASSES;
