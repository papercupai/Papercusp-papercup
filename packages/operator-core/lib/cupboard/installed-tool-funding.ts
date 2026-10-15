/** D-066: explicit host grants compose the existing encrypted credential store,
 * keychain, SKU routing store and monetary host. No dispatch argument is authority. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { AttachedInstalledToolFunding } from '../agent-tools/per-use-chokepoint';
import { loadHiveKeyStatus, signWithHiveKey } from '../identity/hive-keypair';
import { verifyEd25519 } from '../identity/ed25519';
import { verifySellerReceiptAuthority } from '../p2p/metered-invocation';
import { readIntegrationKey } from '../integration-credentials';
import { activeWorkspaceId } from '../workspace-registry';
import { readReleaseFunding } from './identity-release-funding-store';
import { FundedToolTurnHost, FundedIdentityTurnHost, type FundedIdentityTurnHostDeps } from './funded-turn-host';
import { FundedToolTurnStore } from './funded-tool-turn-store';
import { FundedIdentityTurnStore, isIdentityWorkItemBinding, type FundedIdentityTurnBinding,
  type IdentityWorkItemBinding } from './funded-turn-store';
import type { WorkItem } from '../work-items';
import { quoteIdentityInferenceTurn } from './identity-per-use-offer';
import type { readAppliedIdentityRules } from '../agent-identities/sync-hook-rules';
import type { resolveAppliedIdentityReleaseLayers } from './identity-activation-gate-io';
import { readHostedToolChannel, readHostedToolEntitlements, readHostedPerUseOffers, type HostedPerUseOffer,
  type MeteredTransportDeps } from './metered-invocation-door-io';
import { INSTALLED_TOOL_FUNDING_CONFIG, fundingPartySchema, remoteSellerSchema, sellerGrantSchema,
  remoteSellerReceiptCapability } from './seller-receipt-rpc';
export { INSTALLED_TOOL_FUNDING_CONFIG } from './seller-receipt-rpc';

/** JSON authorization in the existing workspace integration configuration.
 * Token refs name OTHER encrypted entries; private keys remain in the keychain.
 * Budgets are per native turn, valid only until the absolute expiresAtMs. */
const id = z.string().min(1).max(300).refine(value => value.trim() === value);
const micros = z.string().regex(/^[1-9][0-9]{0,20}$/);
const party = fundingPartySchema;
const grantSchema = z.object({ workspaceId: id, ownerId: id, principalId: id,
  skuRef: id, offerId: id, productId: id, provenanceHash: z.string().regex(/^[a-f0-9]{64}$/),
  termsHash: z.string().regex(/^[a-f0-9]{64}$/), payer: party, seller: party.extend({ remote: remoteSellerSchema.optional() }),
  quantityPerTurn: z.number().int().min(1).max(1000), maxMicrosPerTurn: micros,
  expiresAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const configSchema = z.object({ schema: z.literal('papercusp.installed-tool-funding/v1'),
  grants: z.array(grantSchema).max(1000), sellerGrants: z.array(sellerGrantSchema).max(1000).optional() }).strict();
type Session = { workspaceId: string; ownerId: string; principalId: string };
type Host = AttachedInstalledToolFunding['host'];
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

type Deps = {
  readKey?: typeof readIntegrationKey;
  workspaceId?: () => string;
  sql?: () => Promise<Sql>;
  readFunding?: typeof readReleaseFunding;
  readParty?: typeof readHostedToolEntitlements;
  readChannel?: typeof readHostedToolChannel;
  readOffers?: typeof readHostedPerUseOffers;
  readKeyStatus?: typeof loadHiveKeyStatus;
  sign?: typeof signWithHiveKey;
  createHost?: (deps: ConstructorParameters<typeof FundedToolTurnHost>[0]) => Host;
  remoteSeller?: typeof remoteSellerReceiptCapability;
  nowMs?: () => number;
};

/** Called fresh for each native turn. Missing configuration grants nothing.
 * This resolves real independently configured seller credentials, rather than
 * manufacturing a seller capability from the buyer's default GitHub login. */
export async function productionInstalledToolFunding(session: Session, deps: Deps = {}): Promise<AttachedInstalledToolFunding | undefined> {
  if ((deps.workspaceId ?? activeWorkspaceId)() !== session.workspaceId)
    throw new Error('installed-funding-workspace-mismatch');
  const readKey = deps.readKey ?? readIntegrationKey;
  const raw = await readKey(INSTALLED_TOOL_FUNDING_CONFIG);
  if (raw === undefined) return undefined;
  const parsed = configSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('installed-funding-grant-invalid');
  const grants = parsed.data.grants.filter(grant => grant.workspaceId === session.workspaceId &&
    grant.ownerId === session.ownerId && grant.principalId === session.principalId);
  const hosts = new Map<string, Host>();
  const turnHosts = new Map<string, Host>();
  const nowMs = deps.nowMs ?? Date.now;
  const sql = deps.sql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql as unknown as Sql);
  const forOffer = (offerId: string) => {
    const host = hosts.get(offerId);
    if (!host) throw new Error('installed-funding-host-unavailable');
    return host;
  };
  return {
    host: {
      admit: async binding => {
        const host = forOffer(binding.offer.offerId), admitted = await host.admit(binding);
        if (admitted.ok) turnHosts.set(admitted.turn.turnId, host);
        return admitted;
      },
      localTurn: turn => forOffer(turn.binding.offer.offerId).localTurn(turn),
      complete: (workspaceId, turnId, meter, closedAtMs) => {
        // The meter retains its release, but the durable host is selected by the
        // original admitted turn id, never by an invocation's supplied SKU.
        const host = turnHosts.get(turnId);
        if (!host) throw new Error('installed-funding-turn-unavailable');
        return host.complete(workspaceId, turnId, meter, closedAtMs);
      },
    },
    resolveInstallation: async input => {
      if (input.context.workspaceId !== session.workspaceId || input.context.ownerId !== session.ownerId)
        throw new Error('installed-funding-session-mismatch');
      const matches = grants.filter(grant => grant.skuRef === input.provenance.listing.skuRef &&
        grant.provenanceHash === hash(input.provenance));
      if (matches.length !== 1) throw new Error('installed-funding-exact-grant-required');
      const grant = matches[0]!;
      if (grant.expiresAtMs <= nowMs()) throw new Error('installed-funding-grant-expired');
      if (grant.payer.credentialRef === grant.seller.credentialRef || grant.payer.pubkeyBase64 === grant.seller.pubkeyBase64 ||
          grant.payer.principal === grant.seller.principal)
        throw new Error('installed-funding-independent-seller-required');
      const payerToken = await readKey(grant.payer.credentialRef);
      const sellerToken = grant.seller.remote ? undefined : await readKey(grant.seller.credentialRef);
      if (!payerToken?.trim() || (!grant.seller.remote && (!sellerToken?.trim() || payerToken === sellerToken)))
        throw new Error('installed-funding-independent-credentials-required');
      const payerTransport: MeteredTransportDeps = { authToken: payerToken };
      const sellerTransport: MeteredTransportDeps = { authToken: sellerToken };
      for (const [party, transport] of [[grant.payer, payerTransport], [grant.seller, sellerTransport]] as const) {
        if (party === grant.seller && grant.seller.remote) continue;
        const principal = await (deps.readParty ?? readHostedToolEntitlements)(undefined, transport);
        if (!principal.ok || principal.payer !== party.principal) throw new Error('installed-funding-credential-principal-mismatch');
        const key = await (deps.readKeyStatus ?? loadHiveKeyStatus)(session.workspaceId, party.hiveSlug);
        if (key.kind !== 'ok' || key.pubkeyBase64 !== party.pubkeyBase64)
          throw new Error('installed-funding-signing-key-mismatch');
      }
      const signer = (party: typeof grant.payer) => async (bytes: Buffer) => {
        const signature = await (deps.sign ?? signWithHiveKey)(session.workspaceId, party.hiveSlug, bytes);
        if (!verifyEd25519(bytes, party.pubkeyBase64, signature)) throw new Error('installed-funding-signing-key-changed');
        return signature.toString('base64');
      };
      const originalGrantHash = hash(grant);
      let remote: ReturnType<typeof remoteSellerReceiptCapability> | undefined;
      const refreshTransport = (transport: MeteredTransportDeps): MeteredTransportDeps => ({ ...transport,
        fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }) });
      const payerRefresh = refreshTransport(payerTransport), sellerRefresh = refreshTransport(sellerTransport);
      return { payerTransport, resolvePayer: async () => grant.payer.principal,
        verifyCurrentAuthority: async binding => {
          if ((deps.workspaceId ?? activeWorkspaceId)() !== session.workspaceId || grant.expiresAtMs <= nowMs())
            throw new Error('installed-funding-authority-expired');
          const currentRaw = await readKey(INSTALLED_TOOL_FUNDING_CONFIG);
          const current = configSchema.safeParse(currentRaw === undefined ? undefined : JSON.parse(currentRaw));
          if (!current.success || current.data.grants.filter(value => hash(value) === originalGrantHash).length !== 1)
            throw new Error('installed-funding-grant-withdrawn');
          for (const [party, token] of [[grant.payer, payerToken], [grant.seller, sellerToken]] as const) {
            if (party === grant.seller && grant.seller.remote) continue;
            if (await readKey(party.credentialRef) !== token) throw new Error('installed-funding-credential-changed');
            const key = await (deps.readKeyStatus ?? loadHiveKeyStatus)(session.workspaceId, party.hiveSlug);
            if (key.kind !== 'ok' || key.pubkeyBase64 !== party.pubkeyBase64)
              throw new Error('installed-funding-signing-key-changed');
          }
          const entitlement = await (deps.readParty ?? readHostedToolEntitlements)(grant.payer.principal, payerRefresh);
          if (!entitlement.ok || entitlement.payer !== grant.payer.principal || !entitlement.productIds.includes(grant.productId))
            throw new Error('installed-funding-entitlement-withdrawn');
          if (grant.seller.remote) {
            if (!remote) throw new Error('installed-funding-remote-seller-unavailable');
            await remote.verify();
          } else {
            const seller = await (deps.readParty ?? readHostedToolEntitlements)(grant.seller.principal, sellerRefresh);
            if (!seller.ok || seller.payer !== grant.seller.principal)
              throw new Error('installed-funding-seller-authority-withdrawn');
          }
          const catalog = await (deps.readOffers ?? readHostedPerUseOffers)(payerRefresh);
          const offers = catalog.ok ? catalog.offers.filter(value => value.offerId === grant.offerId) : [];
          if (offers.length !== 1 || canonicalJson(offers[0]) !== canonicalJson(binding.offer) ||
              !offers[0]!.active || !offers[0]!.productActive)
            throw new Error('installed-funding-offer-withdrawn');
          const channel = await (deps.readChannel ?? readHostedToolChannel)(binding.channelId,
            grant.payer.principal, payerRefresh, grant.payer.pubkeyBase64);
          if (!channel.ok || grant.expiresAtMs <= nowMs()) throw new Error('installed-funding-channel-withdrawn');
        },
        resolveFunding: async (offer: HostedPerUseOffer) => {
          if (offer.offerId !== grant.offerId || offer.productId !== grant.productId || offer.skuRef !== grant.skuRef ||
              offer.creatorId !== grant.seller.principal || hash(offer.terms) !== grant.termsHash ||
              !offer.receiptAuthority || offer.receiptAuthority.pubkeyBase64 !== grant.seller.pubkeyBase64 ||
              !verifySellerReceiptAuthority({ seller: offer.creatorId, offerId: offer.offerId,
                productId: offer.productId, skuRef: offer.skuRef }, offer.receiptAuthority) ||
              !offer.active || !offer.productActive || grant.expiresAtMs <= nowMs())
            throw new Error('installed-funding-offer-grant-mismatch');
          const quantityCeiling = BigInt(grant.quantityPerTurn);
          const amount = BigInt(offer.terms.unitPriceMicros) * quantityCeiling;
          if (amount > BigInt(grant.maxMicrosPerTurn)) throw new Error('installed-funding-budget-exceeded');
          const connection = await sql();
          const channelId = (await (deps.readFunding ?? readReleaseFunding)(connection, session.workspaceId, [offer.skuRef])).get(offer.skuRef)?.channelId;
          if (!channelId) throw new Error('installed-funding-channel-binding-required');
          const channel = await (deps.readChannel ?? readHostedToolChannel)(channelId, grant.payer.principal, payerTransport, grant.payer.pubkeyBase64);
          if (!channel.ok || channel.escrowMicros - channel.committedMicros < amount)
            throw new Error('installed-funding-channel-unavailable');
          if (grant.seller.remote) {
            remote = (deps.remoteSeller ?? remoteSellerReceiptCapability)(grant.seller.remote, grant.seller.pubkeyBase64, channelId);
            await remote.verify();
          }
          const host = (deps.createHost ?? (value => new FundedToolTurnHost(value)))({ store: new FundedToolTurnStore(connection),
            payerTransport, sellerTransport, signVoucher: signer(grant.payer),
            signReceipt: remote ? remote.signReceipt : signer(grant.seller),
            ...(remote ? { settleRemote: remote.settle } : {}), nowMs });
          if (hosts.has(offer.offerId)) throw new Error('installed-funding-duplicate-offer');
          hosts.set(offer.offerId, host);
          return { channelId, quantityCeiling, expiresAtMs: grant.expiresAtMs };
        } };
    },
  };
}

/** D-073: host-only composition for an exact APPLIED paid identity. The same
 * grant's quantityPerTurn caps pricing blocks; maxMicrosPerTurn caps markup.
 * This supplies monetary authority, never a native billing capability. The
 * existing store still requires the complete provider-billed usage population. */
export async function productionFundedIdentityTurnHost(input: FundedIdentityTurnBinding, deps: Omit<Deps, 'createHost'> & {
  readApplied?: typeof readAppliedIdentityRules;
  resolveLayers?: typeof resolveAppliedIdentityReleaseLayers;
  createIdentityHost?: (deps: FundedIdentityTurnHostDeps) => FundedIdentityTurnHost;
  readWorkItem?: (ref: IdentityWorkItemBinding) => Promise<Pick<WorkItem, 'id' | 'harness' | 'assignee' | 'state'> | null>;
} = {}): Promise<FundedIdentityTurnHost | undefined> {
  const binding = structuredClone(input), readKey = deps.readKey ?? readIntegrationKey;
  const bindingHash = (value: FundedIdentityTurnBinding) => hash({ ...value,
    inferenceCeilingMicros: String(value.inferenceCeilingMicros) });
  const nowMs = deps.nowMs ?? Date.now;
  if ((deps.workspaceId ?? activeWorkspaceId)() !== binding.workspaceId)
    throw new Error('identity-funding-workspace-mismatch');
  if (binding.workItem !== undefined && !isIdentityWorkItemBinding(binding.workItem))
    throw new Error('identity-funding-work-item-invalid');
  const raw = await readKey(INSTALLED_TOOL_FUNDING_CONFIG);
  if (raw === undefined) return undefined;
  const config = configSchema.safeParse(JSON.parse(raw));
  if (!config.success) throw new Error('identity-funding-grant-invalid');
  const readApplied = deps.readApplied ?? (await import('../agent-identities/sync-hook-rules')).readAppliedIdentityRules;
  const resolveLayers = deps.resolveLayers ?? (await import('./identity-activation-gate-io')).resolveAppliedIdentityReleaseLayers;
  const worn = await readApplied(binding.ownerId, binding.workspaceId);
  if (!worn || worn.applied.specificationRevision !== binding.specificationRevision ||
      worn.applied.stateRevision !== binding.stateRevision ||
      !(await resolveLayers(worn)).some(layer => layer.skuRef === binding.offer.skuRef))
    throw new Error('identity-funding-applied-mismatch');
  const fingerprint = hash({ applied: worn.applied, packagePins: worn.packagePins });
  const matches = config.data.grants.filter(grant => grant.workspaceId === binding.workspaceId &&
    grant.ownerId === binding.ownerId && grant.principalId === binding.principalId &&
    grant.skuRef === binding.offer.skuRef && grant.provenanceHash === fingerprint && grant.offerId === binding.offerId);
  if (matches.length !== 1) throw new Error('identity-funding-exact-grant-required');
  const grant = matches[0]!, grantHash = hash(grant);
  const quote = quoteIdentityInferenceTurn({ offer: binding.offer, billedInferenceMicros: 0n,
    inferenceCeilingMicros: binding.inferenceCeilingMicros });
  if (!quote.ok || quote.reservationQuantity > BigInt(grant.quantityPerTurn) ||
      quote.reservedMarkupMicros > BigInt(grant.maxMicrosPerTurn))
    throw new Error('identity-funding-budget-exceeded');
  if (binding.payer !== grant.payer.principal || binding.seller !== grant.seller.principal ||
      hash(binding.offer) !== grant.termsHash || binding.expiresAtMs > grant.expiresAtMs)
    throw new Error('identity-funding-binding-mismatch');
  if (grant.payer.credentialRef === grant.seller.credentialRef || grant.payer.pubkeyBase64 === grant.seller.pubkeyBase64 ||
      grant.payer.principal === grant.seller.principal)
    throw new Error('identity-funding-independent-seller-required');
  const payerToken = await readKey(grant.payer.credentialRef);
  const sellerToken = grant.seller.remote ? undefined : await readKey(grant.seller.credentialRef);
  if (!payerToken?.trim() || (!grant.seller.remote && (!sellerToken?.trim() || payerToken === sellerToken)))
    throw new Error('identity-funding-independent-credentials-required');
  const transport = (authToken: string | undefined): MeteredTransportDeps => ({ authToken,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }) });
  const payerTransport = transport(payerToken), sellerTransport = transport(sellerToken);
  const remote = grant.seller.remote
    ? (deps.remoteSeller ?? remoteSellerReceiptCapability)(grant.seller.remote, grant.seller.pubkeyBase64, binding.channelId)
    : undefined;
  const sql = await (deps.sql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql as unknown as Sql))();
  const verifyCurrentAuthority = async (candidate: FundedIdentityTurnBinding) => {
    if (bindingHash(candidate) !== bindingHash(binding) || (deps.workspaceId ?? activeWorkspaceId)() !== binding.workspaceId ||
        binding.expiresAtMs <= nowMs() || grant.expiresAtMs <= nowMs())
      throw new Error('identity-funding-authority-expired-or-changed');
    if (binding.workItem) {
      const readWorkItem = deps.readWorkItem ?? (async (ref: IdentityWorkItemBinding) =>
        (await import('../work-items')).getWorkItem(ref.id, ref.harness, {}, sql));
      const item = await readWorkItem(structuredClone(binding.workItem));
      if (!item || item.id !== binding.workItem.id || item.harness !== binding.workItem.harness ||
          item.assignee !== binding.ownerId || !['open', 'todo', 'wip', 'blocked'].includes(item.state))
        throw new Error('identity-funding-work-item-unclaimed-or-changed');
    }
    const currentRaw = await readKey(INSTALLED_TOOL_FUNDING_CONFIG);
    const current = configSchema.safeParse(currentRaw === undefined ? undefined : JSON.parse(currentRaw));
    if (!current.success || current.data.grants.filter(value => hash(value) === grantHash).length !== 1)
      throw new Error('identity-funding-grant-withdrawn');
    const applied = await readApplied(binding.ownerId, binding.workspaceId);
    if (!applied || hash({ applied: applied.applied, packagePins: applied.packagePins }) !== fingerprint ||
        !(await resolveLayers(applied)).some(layer => layer.skuRef === binding.offer.skuRef))
      throw new Error('identity-funding-applied-withdrawn');
    for (const [party, token, io] of [[grant.payer, payerToken, payerTransport], [grant.seller, sellerToken, sellerTransport]] as const) {
      if (party === grant.seller && remote) continue;
      if (await readKey(party.credentialRef) !== token) throw new Error('identity-funding-credential-changed');
      const key = await (deps.readKeyStatus ?? loadHiveKeyStatus)(binding.workspaceId, party.hiveSlug);
      if (key.kind !== 'ok' || key.pubkeyBase64 !== party.pubkeyBase64) throw new Error('identity-funding-signing-key-changed');
      const principal = await (deps.readParty ?? readHostedToolEntitlements)(undefined, io);
      if (!principal.ok || principal.payer !== party.principal ||
          (party === grant.payer && !principal.productIds.includes(grant.productId)))
        throw new Error('identity-funding-entitlement-withdrawn');
    }
    const offers = await (deps.readOffers ?? readHostedPerUseOffers)(payerTransport);
    const rows = offers.ok ? offers.offers.filter(value => value.offerId === grant.offerId) : [];
    const offer = rows[0];
    if (rows.length !== 1 || !offer || !offer.active || !offer.productActive || offer.skuRef !== grant.skuRef ||
        offer.productId !== grant.productId || offer.creatorId !== grant.seller.principal || hash(offer.terms) !== grant.termsHash ||
        offer.receiptAuthority?.pubkeyBase64 !== grant.seller.pubkeyBase64 ||
        !verifySellerReceiptAuthority({ seller: offer.creatorId, offerId: offer.offerId, productId: offer.productId,
          skuRef: offer.skuRef }, offer.receiptAuthority)) throw new Error('identity-funding-offer-withdrawn');
    const channelId = (await (deps.readFunding ?? readReleaseFunding)(sql, binding.workspaceId, [grant.skuRef])).get(grant.skuRef)?.channelId;
    if (channelId !== binding.channelId) throw new Error('identity-funding-channel-binding-changed');
    const channel = await (deps.readChannel ?? readHostedToolChannel)(binding.channelId, grant.payer.principal, payerTransport, grant.payer.pubkeyBase64);
    // Once hosted funding is confirmed, its own reservation may consume the
    // free balance. FundedIdentityTurnHost checks funds when it reserves; this
    // refresh checks the exact channel's continuing authority, not free funds.
    if (!channel.ok || grant.expiresAtMs <= nowMs()) throw new Error('identity-funding-channel-withdrawn');
    if (remote) await remote.verify();
  };
  await verifyCurrentAuthority(binding);
  const signer = (party: typeof grant.payer) => async (bytes: Buffer) => {
    const signature = await (deps.sign ?? signWithHiveKey)(binding.workspaceId, party.hiveSlug, bytes);
    if (!verifyEd25519(bytes, party.pubkeyBase64, signature)) throw new Error('identity-funding-signing-key-changed');
    return signature.toString('base64');
  };
  return (deps.createIdentityHost ?? (value => new FundedIdentityTurnHost(value)))({
    store: new FundedIdentityTurnStore(sql), payerTransport, sellerTransport,
    signVoucher: signer(grant.payer), signReceipt: remote ? remote.signReceipt : signer(grant.seller),
    ...(remote ? { settleRemote: remote.settle } : {}), verifyCurrentAuthority, nowMs,
  });
}
