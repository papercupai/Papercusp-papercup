/** P-007 shared target-bound admission. Hosted verification and funding belong
 * to the authenticated turn host, including current authority before dispatch. */
import type { DispatchProjectedDeps } from '@papercusp/agent-mcp';
import { listAllProjectedTools, resolveMcpName, type ProjectedTool } from '@papercusp/tooldef';
import { createHash } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { readInstalledPluginProvenance } from '../cupboard/install-plugin-core';
import { bindInstalledPerUseOffer, readHostedPerUseOffers, readHostedToolEntitlements,
  type HostedPerUseOffer, type MeteredTransportDeps } from '../cupboard/metered-invocation-door-io';
import { readInstalledPluginCommerceProvenance } from '../cupboard/install-io';
import type { FundedToolTurnHost } from '../cupboard/funded-turn-host';
import type { FundedToolTurnBinding, FundedToolTurnResult } from '../cupboard/funded-tool-turn-store';
import type { InstalledPluginProvenance } from '../cupboard/types';
import type { SuCodexTurnAdmission, SuCodexTurnLifecycle } from '../su-session-usage';
import { declareMeter, LocalMeteredTurnRefusedError, type LocalMeteredTurn } from '../p2p/metered-invocation';

type Request = Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0];
type FundedInstalledAdmission = { ok: true; admission: AdmittedPerUseToolTurn;
  turnId: string; binding: FundedToolTurnBinding };
type NativeAdmissionContext = Parameters<SuCodexTurnLifecycle['admit']>[0];
type InstalledAdmissionInput = Parameters<typeof admitInstalledPerUseToolTurn>[0];
type NativePlan = {
  context: Pick<NativeInstalledTurnContext, 'principalId' | 'advSessionId' | 'mcpServer' | 'nativeTools'>;
  host: Pick<FundedToolTurnHost, 'admit' | 'localTurn' | 'complete'>;
  installations: readonly Omit<InstalledAdmissionInput, 'host' | 'context'>[];
  freeAdmissions?: readonly VerifiedFreeToolAdmission[];
};
type NativeLifecycleDeps = {
  identityLifecycle: SuCodexTurnLifecycle;
  resolvePlan(context: NativeAdmissionContext): Promise<NativePlan>;
  recordFailure(input: { context: NativeAdmissionContext; turnIds: readonly string[];
    phase: Parameters<SuCodexTurnAdmission['reconcile']>[0]['phase']; message: string }): Promise<void>;
  nowMs?: () => number;
};

/** Host-owned capability from once-per-turn authenticated admission. The host
 * must verify the installed provenance, entitlement and funding, retain durable
 * local CAS/outbox state, and withdraw admission on revocation. Never build this
 * from invocation arguments or treat a LocalMeteredTurn as funding evidence. */
export interface AdmittedPerUseToolTurn {
  readonly kind: 'per-use';
  readonly workspaceId: string;
  readonly principalId: string;
  readonly payer: string;
  readonly provenance: InstalledPluginProvenance;
  readonly offer: HostedPerUseOffer;
  readonly entitled: boolean;
  readonly turn: LocalMeteredTurn;
  /** Host-owned refresh capability; never provided by invocation arguments. */
  readonly verifyCurrentAuthority?: () => Promise<void>;
}

export interface VerifiedFreeToolAdmission {
  readonly kind: 'free';
  readonly workspaceId: string;
  readonly principalId: string;
  readonly provenance: InstalledPluginProvenance;
}

/** Host-only installation composition. Keep the installed loader outside the
 * leaf monetary host: the Worker also compiles that host and must not pull in
 * operator runtime, plugin loaders or UI types. No invocation args grant this
 * capability. The native/app lifecycle owns all resolvers and withdraws the
 * returned local lease on revocation with turn.stopAdmission(). */
export async function admitInstalledPerUseToolTurn(input: {
  host: Pick<FundedToolTurnHost, 'admit' | 'localTurn'>;
  payerTransport: MeteredTransportDeps;
  context: Pick<FundedToolTurnBinding, 'workspaceId' | 'ownerId' | 'principalId' | 'executionId' | 'admissionId'>;
  installation: Parameters<typeof readInstalledPluginCommerceProvenance>[0];
  /** Omitted: use the hosted bearer principal. A host may select an authorized
   * organization; invocation arguments cannot provide this resolver. */
  resolvePayer?: () => Promise<string>;
  resolveFunding: (offer: HostedPerUseOffer) => Promise<Pick<FundedToolTurnBinding, 'channelId' | 'quantityCeiling' | 'expiresAtMs'>>;
  verifyCurrentAuthority?: (binding: FundedToolTurnBinding) => Promise<void>;
  readProvenance?: typeof readInstalledPluginCommerceProvenance;
}): Promise<FundedInstalledAdmission | Extract<FundedToolTurnResult, { ok: false }>> {
  const context = structuredClone(input.context), installation = structuredClone(input.installation);
  const verifyCurrentAuthority = input.verifyCurrentAuthority;
  const loaded = await (input.readProvenance ?? readInstalledPluginCommerceProvenance)(installation);
  if (!loaded) return { ok: false, code: 'installation-binding-required', detail: 'exact installed commerce provenance is required' };
  const provenance = structuredClone(loaded), requestedPayer = await input.resolvePayer?.();
  const catalog = await readHostedPerUseOffers(input.payerTransport);
  if (!catalog.ok) return catalog;
  const bound = bindInstalledPerUseOffer(provenance, catalog.offers);
  if (!bound.ok) return bound;
  const entitlement = await readHostedToolEntitlements(requestedPayer, input.payerTransport);
  if (!entitlement.ok) return entitlement;
  if (!entitlement.productIds.includes(bound.offer.productId)) return { ok: false, code: 'tool-entitlement-required', detail: 'authenticated buyer has no active entitlement' };
  const payer = entitlement.payer;
  const funding = await input.resolveFunding(structuredClone(bound.offer));
  const binding: FundedToolTurnBinding = { ...context, kind: 'tool', payer, seller: bound.offer.creatorId,
    channelId: funding.channelId, quantityCeiling: funding.quantityCeiling, expiresAtMs: funding.expiresAtMs,
    offer: bound.offer, provenanceHash: createHash('sha256').update(canonicalJson(provenance)).digest('hex') };
  const admitted = await input.host.admit(binding);
  if (!admitted.ok) return admitted;
  return { ok: true, turnId: admitted.turn.turnId, binding: structuredClone(admitted.turn.binding), admission: { kind: 'per-use', ...context, payer,
    provenance, offer: bound.offer, entitled: true, turn: input.host.localTurn(admitted.turn),
    verifyCurrentAuthority: verifyCurrentAuthority && (() => verifyCurrentAuthority(structuredClone(binding))) } };
}

/** Process-local extension of the installed admission provider. Registration is
 * a trusted host capability, never a tool. A different request worker must route
 * to this owning host; this lookup cannot reconstruct authority from metadata.
 * Keep call tombstones until withdrawal so a new dispatch nonce cannot replay an
 * observed native call. Restart loses lookup authority and retains durable holds. */
export class NativeInstalledPerUseTurns {
  private readonly turns = new Map<string, NativeInstalledTurnEntry>();

  /** Authenticated host notification capability, never a dispatch argument.
   * Revocation stops the entire affected native turn's installed population;
   * its original monetary holds remain available for completion/recovery. */
  revoke(input: { workspaceId: string; principalId: string; target:
    { kind: 'principal' } | { kind: 'channel' | 'product'; id: string } |
    { kind: 'installation'; provenanceHash: string };
  }): Promise<readonly { nativeSessionId: string; ownerTurnId: string; turnIds: readonly string[] }[]> {
    const boundedId = (value: string) => /^[A-Za-z0-9._:-]{1,256}$/.test(value);
    if (!boundedId(input.workspaceId) || !boundedId(input.principalId) ||
      !['principal', 'channel', 'product', 'installation'].includes(input.target.kind) ||
      (input.target.kind === 'installation' ? !/^[a-f0-9]{64}$/.test(input.target.provenanceHash) :
        input.target.kind !== 'principal' && !boundedId(input.target.id))) {
      throw new Error('Revocation requires an exact authenticated scope and target');
    }
    const affected = [...this.turns.entries()].filter(([, entry]) => {
      if (entry.context.workspaceId !== input.workspaceId || entry.context.principalId !== input.principalId) return false;
      const target = input.target;
      if (target.kind === 'principal') return true;
      if (target.kind === 'channel') return entry.admissions.some(value => value.binding.channelId === target.id);
      if (target.kind === 'product') return entry.admissions.some(value => value.admission.offer.productId === target.id);
      if (target.kind !== 'installation') return false;
      return entry.admissions.some(value => value.binding.provenanceHash === target.provenanceHash) ||
        entry.freeAdmissions.some(value => fingerprint(canonicalJson(value.provenance)) === target.provenanceHash);
    });
    const lineage = affected.map(([, entry]) => ({ nativeSessionId: entry.context.nativeSessionId,
      ownerTurnId: entry.context.ownerTurnId, turnIds: entry.admissions.map(value => value.turnId) }));
    // Revoke the whole cohort before calling any persistence capability: even
    // synchronous callbacks from one stop cannot enter another affected turn.
    for (const [, entry] of affected) entry.withdrawn = true;
    return Promise.all(affected.map(([key, entry]) => this.withdrawEntry(key, entry))).then(() => lineage);
  }

  /** Production population supplier over the existing loaded registry. The
   * authenticated host selects the exact allowed target cohort and financial
   * capabilities; request arguments cannot add installations to a turn. */
  nativeLifecycleFromCatalog(deps: Omit<NativeLifecycleDeps, 'resolvePlan'> & {
    resolveContext(context: NativeAdmissionContext): Promise<Pick<NativePlan, 'context' | 'host'> & {
      toolNames: readonly string[];
    }>;
    resolveInstallation(input: { context: NativeAdmissionContext;
      installation: InstalledAdmissionInput['installation']; provenance: InstalledPluginProvenance;
    }): Promise<Omit<InstalledAdmissionInput, 'host' | 'context' | 'installation' | 'readProvenance'>>;
    readTools?: () => readonly ProjectedTool[];
    readProvenance?: typeof readInstalledPluginCommerceProvenance;
  }): SuCodexTurnLifecycle {
    return this.nativeLifecycle({ ...deps, resolvePlan: async context => {
      const resolved = await deps.resolveContext(structuredClone(context));
      const boundContext = structuredClone(resolved.context), names = [...resolved.toolNames];
      if (names.length > 1000 || new Set(names).size !== names.length)
        throw new Error('Native installed target cohort must be distinct and bounded');
      // Capture loader-owned fields before the first hosted provenance read.
      const tools = (deps.readTools ?? listAllProjectedTools)().map(value => ({
        name: value.expose.mcp?.name, pluginName: value.pluginName,
        installation: value.pluginInstallation && { ...value.pluginInstallation },
      }));
      const selected = names.map(name => {
        const matches = tools.filter(value => value.name === name);
        if (matches.length !== 1) throw new Error('Native target is not an exact current loaded tool: ' + name);
        return matches[0]!;
      });
      for (const target of Object.values(boundContext.nativeTools)) {
        const matches = tools.filter(value => value.name === target);
        if (matches.length !== 1 || (matches[0]!.installation && !names.includes(target)))
          throw new Error('Native tool mapping escapes the admitted loaded target cohort');
      }
      const population = new Map<string, InstalledAdmissionInput['installation']>();
      for (const value of selected) {
        if (!value.installation) continue;
        const installation = { name: value.pluginName, version: value.installation.version, path: value.installation.path };
        const previous = population.get(installation.name);
        if (previous && canonicalJson(previous) !== canonicalJson(installation))
          throw new Error('Native target cohort contains conflicting loaded installations');
        population.set(installation.name, installation);
      }
      const installations: NativePlan['installations'][number][] = [], freeAdmissions: VerifiedFreeToolAdmission[] = [];
      for (const installation of population.values()) {
        const loaded = await (deps.readProvenance ?? readInstalledPluginCommerceProvenance)(structuredClone(installation));
        if (!loaded) continue; // Non-Cupboard installations retain the existing dispatch path.
        const provenance = structuredClone(loaded);
        if (provenance.name !== installation.name || provenance.version !== installation.version)
          throw new Error('Hosted provenance differs from the exact loaded installation');
        if (provenance.listing.priceModel === 'free') {
          freeAdmissions.push({ kind: 'free', workspaceId: context.workspaceId,
            principalId: boundContext.principalId, provenance });
          continue;
        }
        if (provenance.listing.priceModel !== 'per-use')
          throw new Error('Installed pricing requires a supported native admission');
        const capability = await deps.resolveInstallation({ context: structuredClone(context),
          installation: structuredClone(installation), provenance: structuredClone(provenance) });
        installations.push({ ...capability, installation: structuredClone(installation),
          readProvenance: async requested => {
            if (canonicalJson(requested) !== canonicalJson(installation))
              throw new Error('Native funding requested another loaded installation');
            return structuredClone(provenance);
          } });
      }
      return { context: boundContext, host: resolved.host, installations, freeAdmissions };
    } });
  }

  /** Trusted host composition. Resolve and fund the exact installed population
   * before native delivery. The identity lifecycle is required because supplying
   * this capability replaces the engine's default identity admission gate. */
  nativeLifecycle(deps: NativeLifecycleDeps): SuCodexTurnLifecycle {
    return { admit: async rawContext => {
      const context = structuredClone(rawContext);
      const identity = await deps.identityLifecycle.admit(structuredClone(context));
      if (!identity.ok) return identity;
      const admissions: FundedInstalledAdmission[] = [];
      let plan: Awaited<ReturnType<typeof deps.resolvePlan>> | undefined;
      let hooks: ReturnType<NativeInstalledPerUseTurns['register']> | undefined;
      const recordFailure = (failure: Parameters<SuCodexTurnAdmission['reconcile']>[0]) =>
        deps.recordFailure({ context: structuredClone(context), turnIds: admissions.map(value => value.turnId), ...failure });
      try {
        plan = await deps.resolvePlan(structuredClone(context));
        if (plan.installations.length === 0 && !plan.freeAdmissions?.length) return identity;
        if (plan.installations.length + (plan.freeAdmissions?.length ?? 0) > 1000)
          throw new Error('Native installed population exceeds the admission bound');
        for (const installation of plan.installations) {
          const admitted = await admitInstalledPerUseToolTurn({ ...installation, host: plan.host,
            context: { workspaceId: context.workspaceId, ownerId: context.ownerId, principalId: plan.context.principalId,
              executionId: context.nativeSessionId, admissionId: context.ownerTurnId } });
          if (!admitted.ok) throw new Error(admitted.code + ': ' + admitted.detail);
          admissions.push(admitted);
        }
        hooks = this.register({ ...plan.context, ...context, admissions, freeAdmissions: plan.freeAdmissions });
      } catch (error) {
        // No lookup was published and native delivery has not begun. Only known
        // successful local handles can be closed as unserved; an uncertain
        // reservation remains in the existing durable ledger for recovery.
        const message = error instanceof Error ? error.message : String(error);
        const closedAtMs = (deps.nowMs ?? Date.now)();
        const recovery = await Promise.allSettled([
          ...admissions.map(async value => {
            await value.admission.turn.stopAdmission();
            const result = await plan!.host.complete(context.workspaceId, value.turnId, value.admission.turn, closedAtMs);
            if (!result.ok) throw new Error(result.code + ': ' + result.detail);
          }),
          identity.reconcile({ phase: 'delivery', message }), recordFailure({ phase: 'delivery', message }),
        ]);
        const failures = recovery.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
        return { ok: false, code: 'native-installed-admission-failed', retryable: false,
          message: message + (failures.length ? '; recovery remains unconfirmed: ' + failures.map(value => String(value.reason)).join('; ') : '') };
      }
      const registered = hooks, host = plan.host;
      let nativeTurnId: string | null = null, bound = false;
      let binding: Promise<void> | undefined;
      let closure: Parameters<SuCodexTurnAdmission['complete']>[0] | undefined;
      let closing: Promise<void> | undefined, completed = false, withdrawn = false;
      const withdraw = () => {
        withdrawn = true;
        return registered.withdraw();
      };
      const requireSuccess = async (operations: readonly Promise<unknown>[]) => {
        const results = await Promise.allSettled(operations);
        const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
        if (errors.length) throw new AggregateError(errors.map(value => value.reason), 'Native installed monetary recovery remains unconfirmed');
      };
      return { ok: true,
        bindNativeTurn: value => {
          if (withdrawn || !/^[A-Za-z0-9._:-]{1,256}$/.test(value) || (nativeTurnId !== null && nativeTurnId !== value))
            return Promise.reject(new Error('Native installed turn retains its original binding'));
          if (binding) return binding;
          // Elect the immutable binding before an asynchronous identity write.
          nativeTurnId = value;
          binding = (async () => {
            await identity.bindNativeTurn(value);
            await registered.bindNativeTurn(value);
            bound = true;
          })();
          return binding;
        },
        observeToolCall: async observation => {
          if (withdrawn || !bound || observation.nativeTurnId !== nativeTurnId)
            throw new Error('Native installed observation requires its original active bound turn');
          await identity.observeToolCall?.(observation);
          await registered.observeToolCall!(observation);
        },
        complete: input => {
          if (!bound || input.nativeTurnId !== nativeTurnId ||
            !Number.isSafeInteger(input.completedAtMs) || input.completedAtMs < 0 ||
            (closure && canonicalJson(closure) !== canonicalJson(input))) {
            return Promise.reject(new Error('Native installed completion retains its original turn and closure'));
          }
          if (completed) return Promise.resolve();
          if (closing) return closing;
          closure ??= structuredClone(input);
          // Lookup authority disappears synchronously before the first await.
          const stopped = withdraw();
          closing = (async () => {
            await stopped;
            await requireSuccess([
              ...admissions.map(async value => {
                const result = await host.complete(context.workspaceId, value.turnId, value.admission.turn, closure!.completedAtMs);
                if (!result.ok) throw new Error(result.code + ': ' + result.detail);
              }), identity.complete(structuredClone(closure!)),
            ]);
            completed = true;
          })().finally(() => { closing = undefined; });
          return closing;
        },
        reconcile: failure => requireSuccess([withdraw(), identity.reconcile({ ...failure }), recordFailure({ ...failure })]),
      };
    } };
  }

  register(input: NativeInstalledTurnContext & {
    admissions: readonly FundedInstalledAdmission[];
    freeAdmissions?: readonly VerifiedFreeToolAdmission[];
  }): Pick<SuCodexTurnAdmission, 'bindNativeTurn' | 'observeToolCall'> & { withdraw(): Promise<void> } {
    const { admissions: original, freeAdmissions: originalFree = [], ...rawContext } = input;
    const context = structuredClone(rawContext);
    const boundedId = (value: string) => /^[A-Za-z0-9._:-]{1,256}$/.test(value);
    if ([context.workspaceId, context.ownerId, context.principalId, context.nativeSessionId,
      context.ownerTurnId, context.mcpServer].some(value => !boundedId(value)) ||
      context.nativeSessionId.length > 128 || !Number.isSafeInteger(context.advSessionId) || context.advSessionId <= 0 ||
      original.length + originalFree.length === 0 || original.length + originalFree.length > 1000 ||
      Object.entries(context.nativeTools).some(([name, target]) => !boundedId(name) || !boundedId(target))) {
      throw new Error('Exact authenticated native turn context and bounded tool bindings are required');
    }
    const admissions = original.map(value => ({ ...value, binding: structuredClone(value.binding),
      admission: { ...value.admission, provenance: structuredClone(value.admission.provenance),
        offer: structuredClone(value.admission.offer) } }));
    const provenanceHashes = new Set<string>(), turnIds = new Set<string>();
    for (const value of admissions) {
      const b = value.binding, a = value.admission;
      const provenanceHash = createHash('sha256').update(canonicalJson(a.provenance)).digest('hex');
      if (value.ok !== true || a.kind !== 'per-use' || !a.entitled || b.kind !== 'tool' ||
        b.workspaceId !== context.workspaceId || b.ownerId !== context.ownerId ||
        b.principalId !== context.principalId || b.executionId !== context.nativeSessionId ||
        b.admissionId !== context.ownerTurnId || a.workspaceId !== b.workspaceId || a.principalId !== b.principalId ||
        a.payer !== b.payer || b.seller !== a.offer.creatorId || b.provenanceHash !== provenanceHash ||
        canonicalJson(b.offer) !== canonicalJson(a.offer) || value.turnId !== a.turn.snapshot().turnId ||
        a.turn.snapshot().admissionClosed || provenanceHashes.has(provenanceHash) || turnIds.has(value.turnId)) {
        throw new Error('Native lookup requires distinct original funded installation admissions');
      }
      provenanceHashes.add(provenanceHash); turnIds.add(value.turnId);
    }
    const freeAdmissions = originalFree.map(value => structuredClone(value));
    for (const value of freeAdmissions) {
      const provenanceHash = createHash('sha256').update(canonicalJson(value.provenance)).digest('hex');
      if (value.kind !== 'free' || value.workspaceId !== context.workspaceId ||
        value.principalId !== context.principalId || value.provenance.listing.priceModel !== 'free' ||
        provenanceHashes.has(provenanceHash))
        throw new Error('Native lookup requires distinct original verified free installations');
      provenanceHashes.add(provenanceHash);
    }
    const key = this.key(context.workspaceId, context.advSessionId, fingerprint(context.nativeSessionId));
    if (this.turns.has(key)) throw new Error('The native execution already has a host admission');
    const entry = { context, admissions, freeAdmissions, nativeTurnId: null as string | null, withdrawn: false,
      observations: new Map<string, { toolName: string; consumed: boolean }>() };
    this.turns.set(key, entry);
    return {
      bindNativeTurn: async nativeTurnId => {
        if (entry.withdrawn || !boundedId(nativeTurnId) || (entry.nativeTurnId !== null && entry.nativeTurnId !== nativeTurnId)) {
          throw new Error('Native lookup retains its original bound turn');
        }
        entry.nativeTurnId = nativeTurnId;
      },
      observeToolCall: async ({ nativeTurnId, callId, server, tool }) => {
        if (entry.withdrawn || entry.nativeTurnId === null || entry.nativeTurnId !== nativeTurnId || !boundedId(callId)) {
          throw new Error('Native call observation requires its original active bound turn');
        }
        if (server !== context.mcpServer || !Object.hasOwn(context.nativeTools, tool)) return;
        const toolName = context.nativeTools[tool]!;
        const callKey = fingerprint(callId), prior = entry.observations.get(callKey);
        if (prior) {
          if (prior.toolName !== toolName) throw new Error('Native call observation changed its target');
          return;
        }
        if (entry.observations.size >= 1000) throw new Error('Native turn call population exceeds the admission bound');
        entry.observations.set(callKey, { toolName, consumed: false });
      },
      withdraw: () => this.withdrawEntry(key, entry),
    };
  }

  /** Synchronous claim at the dispatch seat. No handler/input/output cohort can
   * add an observation or choose a payer. A wrapper observation permits exactly
   * one indirect target among the installations funded BEFORE inference. */
  resolve(request: Request): AdmittedPerUseToolTurn | VerifiedFreeToolAdmission | null {
    const native = request.ctx.requestOrigin?.nativeSession, principal = request.ctx.principal;
    if (request.ctx.requestOrigin?.transport !== 'mcp' || native?.binding !== 'bound' ||
      native.carrier !== 'meta:threadId' || !/^[a-f0-9]{64}$/.test(native.valueFingerprint) ||
      !native.callIdFingerprint || !/^[a-f0-9]{64}$/.test(native.callIdFingerprint) ||
      !Number.isSafeInteger(native.candidateAdvSessionId) || !principal?.workspaceId ||
      !['trusted', 'verified'].includes(principal.trust ?? '') || request.ctx.workspaceId !== principal.workspaceId ||
      request.ctx.advSessionId !== native.candidateAdvSessionId) return null;
    const entry = this.turns.get(this.key(principal.workspaceId, native.candidateAdvSessionId!, native.valueFingerprint));
    if (!entry || entry.withdrawn || entry.nativeTurnId === null || entry.context.principalId !== principal.slug ||
      entry.context.ownerId !== request.ctx.uiClientId) return null;
    const observed = entry.observations.get(native.callIdFingerprint);
    if (!observed || observed.consumed || (observed.toolName === 'tools:invoke'
      ? request.ctx.indirectDispatch !== true : observed.toolName !== request.toolName || request.ctx.indirectDispatch === true)) return null;
    const installation = request.tool.pluginInstallation;
    if (!installation) return null;
    const admitted = entry.admissions.find(value => value.admission.provenance.name === request.tool.pluginName &&
      value.admission.provenance.version === installation.version);
    const free = entry.freeAdmissions.find(value => value.provenance.name === request.tool.pluginName &&
      value.provenance.version === installation.version);
    if (free && !admitted) {
      observed.consumed = true;
      return structuredClone(free);
    }
    if (!admitted || admitted.admission.turn.snapshot().admissionClosed) return null;
    observed.consumed = true;
    // Return a snapshot of immutable terms. The local meter remains the single
    // original capability; callers cannot mutate later lookup authority.
    return { ...admitted.admission, provenance: structuredClone(admitted.admission.provenance),
      offer: structuredClone(admitted.admission.offer), verifyCurrentAuthority: async () => {
        try {
          if (entry.withdrawn) throw new Error('native-installed-authority-withdrawn');
          await admitted.admission.verifyCurrentAuthority?.();
          // An external revoke may have arrived while the hosted read awaited.
          if (entry.withdrawn || admitted.admission.turn.snapshot().admissionClosed)
            throw new Error('native-installed-authority-withdrawn');
        } catch (error) {
          await this.revoke({ workspaceId: entry.context.workspaceId, principalId: entry.context.principalId,
            target: { kind: 'installation', provenanceHash: admitted.binding.provenanceHash } });
          throw error;
        }
      } };
  }

  private key(workspaceId: string, advSessionId: number, nativeFingerprint: string): string {
    return canonicalJson([workspaceId, advSessionId, nativeFingerprint]);
  }

  private withdrawEntry(key: string, entry: NativeInstalledTurnEntry): Promise<void> {
    // Retain the tombstone on any failed stop. Revocation never proves that a
    // served unit is absent and never closes/refunds the durable funded row.
    entry.withdrawn = true;
    return Promise.all(entry.admissions.map(async value => {
      await value.admission.turn.stopAdmission();
    })).then(() => {
      if (this.turns.get(key) === entry) this.turns.delete(key);
    });
  }
}

interface NativeInstalledTurnEntry {
  context: NativeInstalledTurnContext;
  nativeTurnId: string | null;
  withdrawn: boolean;
  admissions: readonly FundedInstalledAdmission[];
  freeAdmissions: readonly VerifiedFreeToolAdmission[];
  observations: Map<string, { toolName: string; consumed: boolean }>;
}

interface NativeInstalledTurnContext {
  workspaceId: string;
  ownerId: string;
  principalId: string;
  nativeSessionId: string;
  ownerTurnId: string;
  advSessionId: number;
  mcpServer: string;
  /** Exact native MCP names resolved by the trusted host's catalog. */
  nativeTools: Readonly<Record<string, string>>;
}
const fingerprint = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const nativeInstalledPerUseTurns = pinModuleState('@papercusp/operator-core.native-installed-per-use-turns',
  () => new NativeInstalledPerUseTurns());

type CatalogLifecycleDeps = Parameters<NativeInstalledPerUseTurns['nativeLifecycleFromCatalog']>[0];
/** Attached-engine capability, never an owner command or invocation argument.
 * The authenticated host supplies both parties' financial authority explicitly. */
export interface AttachedInstalledToolFunding {
  host: NativePlan['host'];
  resolveInstallation: CatalogLifecycleDeps['resolveInstallation'];
}

/** Fresh and resumed engines re-read native inventory on every turn. A wrapper
 * can reach deferred installed targets, so its cohort includes those loaded
 * installations before inference. Missing financial authority refuses paid
 * admission; it cannot be reconstructed from a saved session descriptor. */
export function attachedInstalledToolLifecycle(deps: {
  session: { workspaceId: string; ownerId: string; advSessionId: number; principalId: string };
  identityLifecycle: SuCodexTurnLifecycle;
  readNativeToolNames(): Promise<readonly string[]>;
  recordFailure: NativeLifecycleDeps['recordFailure'];
  funding?: AttachedInstalledToolFunding;
  resolveFunding?: () => Promise<AttachedInstalledToolFunding | undefined>;
  registry?: NativeInstalledPerUseTurns;
  readTools?: CatalogLifecycleDeps['readTools'];
  readProvenance?: CatalogLifecycleDeps['readProvenance'];
  resolveNativeName?: (name: string) => string | undefined;
}): SuCodexTurnLifecycle {
  const unavailable = () => { throw new Error('native-installed-funding-unavailable: authenticated tool funding and seller capabilities are required'); };
  const unfundedHost: NativePlan['host'] = { admit: unavailable, localTurn: unavailable, complete: unavailable };
  const session = structuredClone(deps.session);
  return { admit: async context => {
    if (context.workspaceId !== session.workspaceId || context.ownerId !== session.ownerId)
      return { ok: false, code: 'native-installed-session-mismatch', message: 'Installed admission requires the attached engine owner', retryable: false };
    let catalog: readonly ProjectedTool[] = [];
    let funding = deps.funding;
    // Resolve secrets only for a verified paid installation. Core/free cohorts
    // keep their existing admission even on a host with no commerce credentials.
    const fundingHost: NativePlan['host'] = {
      admit: binding => (funding?.host ?? unfundedHost).admit(binding),
      localTurn: turn => (funding?.host ?? unfundedHost).localTurn(turn),
      complete: (...args) => (funding?.host ?? unfundedHost).complete(...args),
    };
    return (deps.registry ?? nativeInstalledPerUseTurns).nativeLifecycleFromCatalog({
      identityLifecycle: deps.identityLifecycle, recordFailure: deps.recordFailure,
      readProvenance: deps.readProvenance, readTools: () => catalog,
      resolveInstallation: async input => {
        funding ??= await deps.resolveFunding?.();
        return funding ? funding.resolveInstallation(input) : unavailable();
      },
      resolveContext: async () => {
        const nativeNames = [...await deps.readNativeToolNames()];
        if (nativeNames.length > 1000 || new Set(nativeNames).size !== nativeNames.length)
          throw new Error('Native installed inventory must be distinct and bounded');
        catalog = (deps.readTools ?? listAllProjectedTools)();
        const nativeTools: Record<string, string> = Object.create(null);
        for (const name of nativeNames) {
          const canonical = deps.resolveNativeName ? deps.resolveNativeName(name) : resolveMcpName(name)?.expose.mcp?.name;
          // Unloaded native/core tools grant no installed lookup authority.
          if (canonical) nativeTools[name] = canonical;
        }
        const names = new Set(Object.values(nativeTools));
        if (names.has('tools:invoke')) for (const tool of catalog) {
          if (tool.pluginInstallation && tool.expose.mcp?.name) names.add(tool.expose.mcp.name);
        }
        return { context: { principalId: session.principalId, advSessionId: session.advSessionId,
          mcpServer: 'papercusp-su', nativeTools }, host: fundingHost, toolNames: [...names] };
      },
    }).admit(context);
  } };
}

const refuse = (code: string, detail: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify({ error: code, detail }) }],
});

export function createInstalledPerUseChokepoint(deps: {
  readProvenance?: typeof readInstalledPluginProvenance;
  /** Process-local lookup of ALREADY admitted authority, never hosted per-call IO. */
  resolveAdmittedTurn?: (request: Request) => AdmittedPerUseToolTurn | VerifiedFreeToolAdmission | null;
} = {}): NonNullable<DispatchProjectedDeps['aroundInvoke']> {
  return async (request) => {
    const installation = request.tool.pluginInstallation;
    if (!installation) return request.invoke();
    let provenance: InstalledPluginProvenance | null;
    try {
      provenance = await (deps.readProvenance ?? readInstalledPluginProvenance)({
        name: request.tool.pluginName, version: installation.version, path: installation.path,
      });
    } catch (error) {
      return refuse('installation_provenance_invalid', error instanceof Error ? error.message : String(error));
    }
    if (!provenance) return request.invoke();

    const principal = request.ctx.principal;
    if (!principal || !['trusted', 'verified'].includes(principal.trust ?? '') ||
        !principal.slug || !principal.workspaceId || principal.workspaceId === '*' ||
        (request.ctx.workspaceId !== undefined && request.ctx.workspaceId !== principal.workspaceId)) {
      return refuse('authenticated_tool_payer_required', 'Paid tools need the authenticated target principal in its workspace');
    }
    const admitted = deps.resolveAdmittedTurn?.(request);
    if (!admitted) return refuse(provenance.listing.priceModel === 'per-use'
      ? 'funded_tool_turn_required' : 'verified_tool_admission_required',
    'The host has not verified this installation and admitted its target');
    if (admitted.workspaceId !== principal.workspaceId || admitted.principalId !== principal.slug ||
        canonicalJson(admitted.provenance) !== canonicalJson(provenance)) {
      return refuse('tool_turn_binding_mismatch', 'Admission differs from this target principal or loaded installation');
    }
    // A locally edited receipt saying "free" cannot bypass hosted admission.
    if (admitted.kind === 'free') {
      return provenance.listing.priceModel === 'free' ? request.invoke()
        : refuse('tool_turn_binding_mismatch', 'Free admission differs from the installed pricing');
    }
    if (!admitted.entitled) return refuse('tool_entitlement_required', 'The admitted buyer has no active entitlement');
    const bound = bindInstalledPerUseOffer(provenance, [admitted.offer]);
    if (!bound.ok) return refuse(bound.code, bound.detail);
    const declared = declareMeter(bound.offer.terms);
    if (!declared.ok) return refuse(declared.code, declared.detail);
    if (declared.meter.meterUnit !== 'tool-call') {
      return refuse('unsupported_tool_meter', 'An invocation charge requires a published tool-call meter');
    }
    const state = admitted.turn.snapshot();
    if (!admitted.payer.trim() || state.payer !== admitted.payer ||
        state.seller !== bound.offer.creatorId || state.releaseRef !== bound.offer.skuRef ||
        canonicalJson({ ...state.meter, unitPriceMicros: String(state.meter.unitPriceMicros) }) !==
          canonicalJson({ ...declared.meter, unitPriceMicros: String(declared.meter.unitPriceMicros) }) ||
        !request.callId.trim()) {
      return refuse('tool_turn_binding_mismatch', 'The funded meter differs from the exact installed offer');
    }
    try {
      await admitted.verifyCurrentAuthority?.();
    } catch (error) {
      return refuse('tool_current_authority_required', error instanceof Error ? error.message : String(error));
    }
    try {
      return await admitted.turn.invoke({ payer: state.payer, releaseRef: state.releaseRef,
        usageNonce: request.callId, quantity: 1n }, request.invoke);
    } catch (error) {
      if (error instanceof LocalMeteredTurnRefusedError) return refuse(error.code, error.message);
      throw error;
    }
  };
}

// Empty until the owning authenticated host registers funded admissions. A
// request in another worker cannot borrow a session-wide or metadata-only turn.
export const installedPerUseChokepoint = createInstalledPerUseChokepoint({
  resolveAdmittedTurn: request => nativeInstalledPerUseTurns.resolve(request),
});
