/**
 * The verification-module catalog (plan-verification-profiles-2026-10-17 D-001), as a LEAF module.
 *
 * It lives apart from plan-verification-profile.ts so the registry modules (definitions,
 * builtin-catalog, resolve-verification) can read it at module-evaluation time without a load
 * cycle: plan-verification-profile.ts imports the registry resolver as its default
 * (plan-item-types-registry-cupboard-2026-10-20 P-002), and the registry reads this catalog
 * while it builds its zod schemas and first-party definitions. plan-verification-profile.ts
 * re-exports both constants, so existing importers are unchanged. Import nothing here.
 */

export const VERIFICATION_MODULES = ['generic-core', 'code', 'design-evidence', 'packaged-artifact'] as const;
export type VerificationModule = (typeof VERIFICATION_MODULES)[number];

export const DOMAIN_MODULES = ['design-evidence', 'packaged-artifact'] as const satisfies readonly VerificationModule[];
export type DomainModule = (typeof DOMAIN_MODULES)[number];
