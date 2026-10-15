/**
 * Production FinalizationCertificate -> AdmissionCertificate source.
 *
 * Governance events are read from the pot's durable federated setting log, folded
 * with the shared governance projector, and resolved for the exact plan revision
 * and policy epoch the lifecycle door is holding. The newest matching round wins
 * deterministically; an open/paused/revoked/quarantined newer round therefore
 * cannot be bypassed by an older certificate for the same revision.
 */
import { canonicalJson } from '../../authority/authority-rpc-envelope';
import { resolveFederatedPotScope } from '../../federated-pot-scope';
import { potHomeSlugForHarness } from '../../hive-federation';
import {
  admissibleCertificate,
  projectGovernanceFederation,
  resolveRoundControls,
  type FederatedGovernanceEvent,
  type PlanGovernanceControls,
} from './governance-federation';
import { finalizeGovernanceRound, rebuildGovernanceRound, type FinalizationCertificate, type GovernanceRound } from './governance-round';
import type { AdmissionCertificate } from './plan-admission-enforcement';
import type { PlanAdmissionCertificateSource } from './plan-admission-gate';
import {
  authenticatePlanAdmissionGovernanceEvents,
  resolvePlanAdmissionGovernanceAuthority,
  readPlanAdmissionGovernanceSnapshot,
  type PlanAdmissionGovernanceSnapshot,
} from './plan-admission-governance-store';
import { canonicalizePlanAdmissionPolicy } from './plan-admission-policy';
import { governanceAuthorityHash } from './governance-authentication';

type ResolvePotHomeSlug = (
  workspaceId: string,
  harnessSlug: string,
) => Promise<string | null>;
type ReadSnapshot = (
  input: { workspaceId: string; potHomeSlug: string; planRevisionHash?: string; policyVersion?: number },
) => Promise<PlanAdmissionGovernanceSnapshot>;

export interface PlanAdmissionCertificateSourceDeps {
  readonly resolvePotHomeSlug?: ResolvePotHomeSlug;
  readonly readSnapshot?: ReadSnapshot;
  readonly resolveAuthority?: typeof resolvePlanAdmissionGovernanceAuthority;
}

export interface AuthenticatedGovernanceFinalization {
  readonly certificate: FinalizationCertificate | null;
  readonly governance: PlanGovernanceControls | null;
}

export type GovernanceFinalizationInput = Parameters<PlanAdmissionCertificateSource['resolve']>[0];
export interface AuthenticatedGovernanceFinalizationSource extends PlanAdmissionCertificateSource {
  resolveFinalization(input: GovernanceFinalizationInput): Promise<AuthenticatedGovernanceFinalization>;
}

export function bridgeFinalizationToAdmissionCertificate(
  certificate: {
    readonly planRevisionHash: string;
    readonly policyVersion: number;
    readonly admitted: boolean;
    readonly finalizedAtMs: number;
    readonly certificateHash: string;
  },
  ratificationWindowSec: number,
): AdmissionCertificate {
  return {
    planRevisionHash: certificate.planRevisionHash,
    policyVersion: certificate.policyVersion,
    admitted: certificate.admitted,
    expiresAtMs: certificate.finalizedAtMs + ratificationWindowSec * 1_000,
    certificateHash: certificate.certificateHash,
  };
}

function roundOpenEvents(
  events: readonly FederatedGovernanceEvent[],
  planRevisionHash: string,
  policyVersion: number,
): Array<{ event: FederatedGovernanceEvent; round: GovernanceRound }> {
  return events.flatMap((event) =>
    event.body.kind === 'round-open' &&
    event.body.round.planRevisionHash === planRevisionHash &&
    event.body.round.policyVersion === policyVersion
      ? [{ event, round: event.body.round }]
      : [],
  );
}

function quarantinedControls(roundId: string, detail: string): PlanGovernanceControls {
  return {
    roundId,
    status: 'quarantined',
    quarantineReason: detail,
    revokedReason: null,
  };
}

export function createPlanAdmissionCertificateSource(
  deps: PlanAdmissionCertificateSourceDeps = {},
): AuthenticatedGovernanceFinalizationSource {
  const resolvePotHomeSlug = deps.resolvePotHomeSlug ?? potHomeSlugForHarness;
  const readSnapshot = deps.readSnapshot ?? readPlanAdmissionGovernanceSnapshot;

  const resolveFinalization = async (input: GovernanceFinalizationInput): Promise<AuthenticatedGovernanceFinalization> => {
      const workspaceId = input.opts.workspaceId;
      const harnessSlug = input.opts.harnessSlug;
        if (!workspaceId || !harnessSlug || !Number.isSafeInteger(input.nowMs)) return { certificate: null, governance: null };

      try {
        const potHomeSlug = await resolvePotHomeSlug(workspaceId, harnessSlug);
        if (!potHomeSlug) return { certificate: null, governance: null };
        const stored = await readSnapshot({ workspaceId, potHomeSlug,
          planRevisionHash: input.planRevisionHash, policyVersion: input.policy.policyVersion });
        const authority = await (deps.resolveAuthority ?? resolvePlanAdmissionGovernanceAuthority)(
          { workspaceId, potHomeSlug, potId: stored.potId });
        if (!authority || canonicalizePlanAdmissionPolicy(authority.policy) !== canonicalizePlanAdmissionPolicy(input.policy))
          return { certificate: null, governance: null };
        const candidateIds = new Set(roundOpenEvents(stored.events, input.planRevisionHash, input.policy.policyVersion)
          .filter(candidate => candidate.round.authorityHash === governanceAuthorityHash(authority))
          .map(candidate => candidate.round.roundId));
        const authenticated = authenticatePlanAdmissionGovernanceEvents(
          stored.events.filter(event => candidateIds.has(event.roundId)), authority, input.nowMs);
        const snapshot = { ...stored, events: authenticated.events,
          integrityErrors: [...stored.integrityErrors, ...authenticated.integrityErrors] };
        // A malformed dedicated-prefix row means the event set is incomplete or
        // tampered. Never admit from a partial subset that merely happens to retain
        // one valid finalization certificate.
        if (snapshot.integrityErrors.length > 0) {
          return { certificate: null, governance: null };
        }

        const candidates = roundOpenEvents(
          snapshot.events,
          input.planRevisionHash,
          input.policy.policyVersion,
        ).sort(
          (a, b) =>
            b.round.createdAtMs - a.round.createdAtMs ||
            a.round.roundId.localeCompare(b.round.roundId) ||
            a.event.eventId.localeCompare(b.event.eventId),
        );
        const selected = candidates[0];
        if (!selected) return { certificate: null, governance: null };

        const selectedRoundDefinitions = new Set(
          snapshot.events.flatMap((event) =>
            event.body.kind === 'round-open' && event.body.round.roundId === selected.round.roundId
              ? [canonicalJson(event.body.round)]
              : [],
          ),
        );
        if (
          snapshot.conflictedRoundIds.has(selected.round.roundId) ||
          selectedRoundDefinitions.size > 1
        ) {
          return {
            certificate: null,
            governance: quarantinedControls(
              selected.round.roundId,
              `immutable governance-event conflict for round ${selected.round.roundId}`,
            ),
          };
        }

        const projection = projectGovernanceFederation(snapshot.potId, snapshot.events);
        const governance = resolveRoundControls(
          projection,
          selected.round.roundId,
          input.nowMs,
        );
        const finalization = admissibleCertificate(
          projection,
          selected.round.roundId,
          input.nowMs,
        );
        if (!finalization) return { certificate: null, governance };
        if (!Number.isSafeInteger(finalization.finalizedAtMs) ||
            finalization.finalizedAtMs < selected.round.createdAtMs || finalization.finalizedAtMs > input.nowMs ||
            snapshot.events.some(event => event.roundId === selected.round.roundId && event.body.kind === 'finalize' &&
              event.occurredAtMs !== event.body.certificate.finalizedAtMs))
          return { certificate: null, governance: quarantinedControls(selected.round.roundId, 'invalid finalization time') };
        // A hash authenticates bytes, not the claimed verdict. Rebuild from the
        // independently authenticated ballots and the pinned owner policy/roster.
        // The signed certificate commits the complete immutable ballot set.
        // A backdated ballot delivered later cannot change that commitment;
        // every listed ballot must still arrive, authenticate and reconstruct.
        const certifiedIds = new Set(finalization.voteEventIds);
        if (certifiedIds.size !== finalization.voteEventIds.length)
          return { certificate: null, governance: quarantinedControls(selected.round.roundId, 'duplicate certified ballot id') };
        const ballots = snapshot.events.flatMap(event => event.roundId === selected.round.roundId &&
          event.body.kind === 'vote' && certifiedIds.has(event.body.vote.eventId) && event.occurredAtMs <= finalization.finalizedAtMs
          ? [event.body.vote] : []);
        const rebuilt = rebuildGovernanceRound(selected.round, ballots);
        if (!rebuilt.ok) return { certificate: null,
          governance: quarantinedControls(selected.round.roundId, `ballot reconstruction refused: ${rebuilt.detail}`) };
        const reconstructed = finalizeGovernanceRound({ round: selected.round, events: rebuilt.value,
          policy: authority.policy, members: authority.members.filter(m => !m.revoked && m.roles.includes('vote')),
          delegations: authority.delegations, nowMs: finalization.finalizedAtMs });
        if (!reconstructed.ok || canonicalJson(reconstructed.value) !== canonicalJson(finalization))
          return { certificate: null, governance: quarantinedControls(selected.round.roundId,
            'finalization does not match authenticated ballot reconstruction') };
        return {
          certificate: finalization,
          governance,
        };
      } catch {
        // Governance exists, so a storage/scope read failure must fail CLOSED.
        // Returning no certificate gives the caller its normal typed refusal instead
        // of turning a transient backing-store fault into an unstructured tool crash.
        return { certificate: null, governance: null };
      }
  };
  return {
    resolveFinalization,
    async resolve(input) {
      const resolved = await resolveFinalization(input);
      return {
        certificate: resolved.certificate ? bridgeFinalizationToAdmissionCertificate(
          resolved.certificate, input.policy.ratificationWindowSec) : null,
        governance: resolved.governance,
      };
    },
  };
}

/** Production default imported by the common gate; test overrides still win. */
export const productionPlanAdmissionCertificateSource =
  createPlanAdmissionCertificateSource({
    readSnapshot: async ({ workspaceId, potHomeSlug, planRevisionHash, policyVersion }) => {
      const potId = await resolveFederatedPotScope(workspaceId, potHomeSlug);
      const snapshot = await readPlanAdmissionGovernanceSnapshot({
        workspaceId,
        potHomeSlug,
        planRevisionHash,
        policyVersion,
      });
      // Pin the source and store to the same canonical identity even if a registry
      // refresh races the two reads. A mismatch fails closed as an integrity error.
      return snapshot.potId === potId
        ? snapshot
        : {
            ...snapshot,
            integrityErrors: [
              ...snapshot.integrityErrors,
              `pot scope changed while resolving certificate: '${potId}' -> '${snapshot.potId}'`,
            ],
          };
    },
  });
