/**
 * Personal (consumer) provider accounts — provider-neutral (provider-adapters-to-packages-2026-10-11
 * D-036; the account rule is D-039 of the Google migration, owner directive #1822: a personal mail
 * account stays out of the relationship graph / CRM).
 *
 * A provider package declares `oauth.personalAccountDomains`. An account whose identity is an
 * address in one of those domains is personal: the host never routes its `person` records to the
 * relationship graph. The host applies it twice: provisioning strips the `person` destination
 * (connection-lifecycle.ts), and participant delivery refuses to build the graph sink
 * (relationship-graph/participants.ts) even if a row's policy still carries one.
 */
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';

/** The datatype whose routing is the relationship-graph grant. */
export const PERSON_DESTINATION_DATATYPE = 'person';

/**
 * Credential-slot forms a row carries before its real account identity is known
 * (`<token-store plugin>:<field>`, or the older `legacy-owner:` placeholder).
 */
export function isProvisionalProviderAccountId(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? '';
  if (!normalized) return true;
  return normalized.startsWith('provider:') || normalized.startsWith('legacy-owner:');
}

/** The source fields {@link canonicalSourceAccountId} reads. */
export interface SourceAccountIdentity {
  providerAccountId: string | null;
  cursor: Readonly<Record<string, unknown>>;
  config: Readonly<Record<string, unknown>>;
}

function recordedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.includes('@') ? normalized : null;
}

/** The mailbox identity a provider recorded on a source once it learned it (cursor first). */
function recordedAccountIdentity(source: SourceAccountIdentity): string | null {
  return (
    recordedEmail(source.cursor.emailAddress) ??
    recordedEmail(source.cursor.email_address) ??
    recordedEmail(source.config.emailAddress) ??
    recordedEmail(source.config.email_address)
  );
}

/**
 * The account a source belongs to, for owner-facing status. A row still carrying a provisional
 * account id adopts the identity any sibling with the SAME provisional id recorded (a mail
 * provider writes the mailbox into its cursor), so one old connection does not render as a ghost
 * account beside its canonical row. Anything else is returned unchanged.
 */
export function canonicalSourceAccountId(
  source: SourceAccountIdentity,
  sources: readonly SourceAccountIdentity[] = [source],
): string | null {
  const providerAccountId = source.providerAccountId?.trim() ?? '';
  if (!providerAccountId) return null;
  if (!isProvisionalProviderAccountId(providerAccountId)) return providerAccountId;
  const provisional = providerAccountId.toLowerCase();
  for (const sibling of [source, ...sources]) {
    if (sibling.providerAccountId?.trim().toLowerCase() !== provisional) continue;
    const identity = recordedAccountIdentity(sibling);
    if (identity) return identity;
  }
  return providerAccountId;
}

/**
 * True when the descriptor declares personal-account domains and `accountId` is not provably
 * outside them. Fails closed: a declared provider whose account identity is unknown or provisional
 * counts as personal, so an unresolved identity can never widen into a CRM grant.
 */
export function isPersonalProviderAccount(
  descriptor: Pick<ProviderDescriptor, 'oauth'>,
  accountId: string | null | undefined,
): boolean {
  const domains = descriptor.oauth?.personalAccountDomains ?? [];
  if (domains.length === 0) return false;
  if (isProvisionalProviderAccountId(accountId)) return true;
  const normalized = accountId!.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return false;
  return domains.includes(normalized.slice(at + 1));
}
