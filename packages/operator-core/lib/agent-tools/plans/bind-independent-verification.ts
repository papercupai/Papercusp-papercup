/**
 * `plans:bind-independent-verification` — the ONE evidence write a recruited acceptance judge
 * performs (EI-25692833751908142, verification-system-improvements-2026-10-10 D-049).
 *
 * The ship gate refuses `independent_verification_missing` (D-005) until an agent outside the
 * implementers' lineage records an `independent-verification` binding for each live outcome
 * bar, and the recruiter hands that job to the judge it launches (renderIndependentVerificationBrief).
 * But `plans:bind-spec-evidence` declares the coarse `plans:write` capability for EVERY
 * evidence kind, and the `judge` principal deliberately lacks `plans:write` — granting it would
 * let a grader author implementer evidence, rewrite specs and change plan status. So the only
 * agent the system recruits for independent verification could not record it, and the plan
 * stalled at the gate after a matching re-observation.
 *
 * The capability check is static per tool (agent-mcp server.ts), so the narrow grant needs its
 * own door: this verb carries `plans:independent-verification:write` (granted to `judge` in
 * role-principal-caps.ts) and accepts ONLY hand-built `independent-verification` bindings —
 * no other evidence kind, no `fromTestRun` derivation, no `retract`, no `supersedeAtRevision`.
 * It re-validates the call through `plans:bind-spec-evidence`'s own argument schema and runs
 * that tool's handler, so every store-side rule (fingerprint equality with the cited binding,
 * lineage independence enforced by the ship gate, vetting advisories) applies unchanged. The
 * wrapper narrows WHAT can be written; it never widens how a binding is checked.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { harnessArg } from '../_harness-scope';
import bindSpecEvidence, { bindingSchema } from './bind-spec-evidence';

export const INDEPENDENT_VERIFICATION_WRITE_CAPABILITY = 'plans:independent-verification:write';

const independentBindingSchema = bindingSchema.refine((b) => b.evidenceKind === 'independent-verification', {
  message:
    "plans:bind-independent-verification records ONLY evidenceKind 'independent-verification'. Any other kind is implementer evidence and goes through plans:bind-spec-evidence (capability plans:write).",
  path: ['evidenceKind'],
}).describe(
  "Copy implementer's workItemId/specId/specRevision, evidenceRef and unchanged currentMeasurement as measurement (or sourceFingerprint); verifiesBindingId=its id. details.note records independent observation/time/runtime.",
);

const argsSchema = refineEvenWithShapeIssues(
  z.object({
    harness: harnessArg,
    slug: z.string().min(1).describe('Plan owning the outcome bar this observation independently re-verifies.'),
    binding: independentBindingSchema.optional(),
    items: z.array(independentBindingSchema).min(1).max(100).optional(),
  }),
  (args, ctx) => {
    if ([args.binding, args.items].filter(Boolean).length !== 1) {
      ctx.addIssue({ code: 'custom', path: [], message: 'pass exactly one of binding or items' });
    }
  },
);

export default defineTool({
  name: 'plans:bind-independent-verification',
  description:
    "Record an independent re-observation of a live/deployed outcome bar: an evidenceKind 'independent-verification' binding citing the implementer's binding (verifiesBindingId) on the same spec revision. The narrow door a recruited acceptance judge uses to clear the ship gate's independent_verification_missing; it accepts no other evidence kind. Same storage and checks as plans:bind-spec-evidence: the store re-measures source and environment and refuses a mismatch with the cited binding.",
  guidance: {
    when: 'A grader brief asks you to independently verify a live bar: after re-observing the cited receipt yourself and finding it matches.',
    notWhen:
      'Your observation contradicts the receipt (do not bind; rate the criterion on what you saw). Implementer evidence of any kind — plans:bind-spec-evidence.',
    chaining: 'plans:get-spec-evidence (read the cited binding) → re-observe → plans:bind-independent-verification → scorecards:emit.',
  },
  capability: INDEPENDENT_VERIFICATION_WRITE_CAPABILITY,
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const inner = bindSpecEvidence.args.parse({
      ...(args.harness === undefined ? {} : { harness: args.harness }),
      slug: args.slug,
      ...(args.binding ? { binding: args.binding } : { items: args.items }),
    });
    return bindSpecEvidence.handler(inner, ctx);
  },
});
