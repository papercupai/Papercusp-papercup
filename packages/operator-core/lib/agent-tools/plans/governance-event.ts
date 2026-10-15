/** Signed governance ingress reuses the immutable federated store and admission source. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { getPlanRow } from './source';
import { potHomeSlugForHarness } from '../../hive-federation';
import { resolveFederatedPotScope } from '../../federated-pot-scope';
import { appendPlanAdmissionGovernanceEvent, isFederatedGovernanceEvent,
  readPlanAdmissionGovernanceSnapshot, resolvePlanAdmissionGovernanceAuthority } from './plan-admission-governance-store';
import { productionPlanAdmissionCertificateSource } from './plan-admission-certificate-source';
import { checkPlanAdmission } from './plan-admission-gate';
import { createLocalGovernanceEvent, localGovernanceActor, localGovernanceSigner } from './governance-local-action';
import { projectGovernanceFederation, roundStatusAt } from './governance-federation';

export default defineTool({
  name: 'plans:governance-event',
  description: 'Append a signed immutable governance event for the current plan revision, or inspect its authenticated finalization and admission verdict. Trust comes from stored owner policy. No chain submission.',
  guidance: { when: 'Ratifying the current plan revision with signed events, or inspecting its admission certificate.',
    notWhen: 'Authoring policy or moving funds.', chaining: 'Append round-open, ballots and finalization; inspect before starting.' },
  capability: 'plans:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({ harness: harnessArg, slug: z.string().min(1).max(200),
    op: z.enum(['append', 'inspect', 'local-action']), event: z.unknown().optional(),
    expectedRevisionHash: z.string().min(1).optional(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('open') }).strict(),
      z.object({ kind: z.literal('vote'), roundId: z.string().min(1), choice: z.enum(['approve', 'reject', 'abstain']) }).strict(),
      z.object({ kind: z.literal('finalize'), roundId: z.string().min(1) }).strict(),
    ]).optional(),
  }).strict().superRefine((input, ctx) => {
    if (input.op === 'local-action' ? (!input.action || !input.expectedRevisionHash || input.event !== undefined) :
      (input.action !== undefined || input.expectedRevisionHash !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Local actions require an action and the reviewed revision, and cannot accept an imported event.' });
  }),
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const row = await getPlanRow(args.slug, opts);
    const result = async () => {
      if (!row) return { ok: false, error: 'not_found' };
      const potHomeSlug = await potHomeSlugForHarness(row.workspaceId, row.harnessSlug);
      if (!potHomeSlug) return { ok: false, error: 'pot_not_found' };
      const scope = { workspaceId: row.workspaceId, potHomeSlug };
      const potId = await resolveFederatedPotScope(row.workspaceId, potHomeSlug);
      const authority = await resolvePlanAdmissionGovernanceAuthority({ ...scope, potId });
      if (!authority) return { ok: false, error: 'unverified_governance_authority' };
      const snapshot = await readPlanAdmissionGovernanceSnapshot(scope);
      const signer = await localGovernanceSigner().catch(() => null);
      if (args.op === 'append' || args.op === 'local-action') {
        let event;
        if (args.op === 'local-action') {
          try {
            event = await createLocalGovernanceEvent({ authority, snapshot, signer,
              planRevisionHash: row.contentHash, expectedRevisionHash: args.expectedRevisionHash!, action: args.action!, nowMs: Date.now() });
          } catch (error) {
            return { ok: false, error: 'local_governance_action_refused', detail: error instanceof Error ? error.message : String(error) };
          }
        } else {
          if (!isFederatedGovernanceEvent(args.event)) return { ok: false, error: 'invalid_governance_event' };
          event = args.event;
        }
        const opened = snapshot.events.find(e => e.roundId === event.roundId && e.body.kind === 'round-open');
        const round = event.body.kind === 'round-open' ? event.body.round :
          opened?.body.kind === 'round-open' ? opened.body.round : null;
        if (round?.planRevisionHash !== row.contentHash) return { ok: false, error: 'revision_mismatch' };
        try {
          await appendPlanAdmissionGovernanceEvent({ ...scope, event });
        } catch (error) {
          return { ok: false, error: 'governance_event_refused', detail: error instanceof Error ? error.message : String(error) };
        }
      } else if (args.event !== undefined) return { ok: false, error: 'inspect_does_not_accept_event' };
      const nowMs = Date.now();
      const sourceInput = { slug: row.planSlug, door: 'start' as const,
        opts: { workspaceId: row.workspaceId, harnessSlug: row.harnessSlug },
        planRevisionHash: row.contentHash, policy: authority.policy, nowMs };
      const finalization = await productionPlanAdmissionCertificateSource.resolveFinalization(sourceInput);
      const admission = await checkPlanAdmission({ ...sourceInput, row });
      const current = args.op === 'inspect' ? snapshot : await readPlanAdmissionGovernanceSnapshot(scope);
      const projection = projectGovernanceFederation(authority.potId, current.events);
      const rounds = current.events.flatMap(event => {
        if (event.body.kind !== 'round-open' || event.body.round.planRevisionHash !== row.contentHash) return [];
        const projected = projection.rounds.get(event.roundId);
        return [{ roundId: event.roundId, status: projected ? roundStatusAt(projected, nowMs) : 'quarantined',
          expiresAtMs: event.body.round.createdAtMs + authority.policy.ratificationWindowSec * 1000,
          ballots: current.events.flatMap(ballot => ballot.roundId === event.roundId && ballot.body.kind === 'vote' ?
            [{ memberId: ballot.body.vote.memberId, choice: ballot.body.vote.choice, sequence: ballot.body.vote.sequence }] : []),
          certificate: projected?.certificates.length === 1 ? projected.certificates[0] : null }];
      });
      return { ok: true, planRevisionHash: row.contentHash, ...finalization, admission,
        actor: localGovernanceActor(authority, signer, nowMs),
        rounds, integrityErrors: current.integrityErrors, conflictedRoundIds: [...current.conflictedRoundIds] };
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(await result()) }] };
  },
});
