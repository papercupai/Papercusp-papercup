/** D-052 orchestration. Authority is host-owned, never request JSON. The
 * authority adapter must keep current issuer and canonical subject authority
 * valid for the duration of the supplied storage operation. */
import { randomUUID } from 'node:crypto';
import { HostedLeadBindingChallengeCodec, MAX_LEAD_BINDING_CHALLENGE_MS,
  parseHostedLeadBindingScope, type HostedLeadBindingScope } from './hosted-lead-binding';
import type { PostgresHostedLeadBindingStore } from './hosted-lead-binding-postgres';
import { isHostedPrincipal, type HostedPrincipal } from './hosted-principal';

export interface HostedLeadBindingAuthority {
  /** Revalidate issuer and exact canonical person in this workspace. A merge
   * invalidates the old challenge; do not silently transfer it to a survivor. */
  withCurrentIssuer<T>(scope: HostedLeadBindingScope, issuerRef: string,
    operation: (store?: HostedLeadBindingStorage) => Promise<T>): Promise<T | null>;
  /** Receipt reads/revokes still require the current canonical subject. */
  withCurrentSubject<T>(scope: HostedLeadBindingScope,
    operation: (store?: HostedLeadBindingStorage) => Promise<T>): Promise<T | null>;
}

export type HostedLeadBindingStorage = Pick<PostgresHostedLeadBindingStore, 'issue' | 'redeem' | 'read' | 'revoke'>;

export class HostedLeadBindingService {
  constructor(private readonly codec: HostedLeadBindingChallengeCodec,
    private readonly store: HostedLeadBindingStorage, private readonly authority: HostedLeadBindingAuthority,
    private readonly environment: HostedLeadBindingScope['environment'],
    private readonly clock: () => number = Date.now,
    private readonly challengeId: () => string = randomUUID) {}

  private scope(input: HostedLeadBindingScope): HostedLeadBindingScope {
    const scope = parseHostedLeadBindingScope(input);
    if (scope.environment !== this.environment) throw new Error('lead_binding_environment_mismatch');
    return scope;
  }

  /** issuerRef comes from authenticated operator identity, not a body field. */
  async issue(input: HostedLeadBindingScope, issuerRef: string): Promise<string | null> {
    const scope = this.scope(input);
    const issuedAt = this.clock();
    const claim = { ...scope, issuerRef, challengeId: this.challengeId(), issuedAt,
      expiresAt: issuedAt + MAX_LEAD_BINDING_CHALLENGE_MS };
    // Validate before persistence; never return a token for a failed insert.
    const token = this.codec.encode(claim);
    return this.authority.withCurrentIssuer(scope, issuerRef, async store => {
      await (store ?? this.store).issue(claim);
      return token;
    });
  }

  async redeem(input: HostedLeadBindingScope, token: unknown, principal: HostedPrincipal) {
    const scope = this.scope(input);
    if (!isHostedPrincipal(principal)) return null;
    const claim = this.codec.decode(token, scope, this.clock());
    if (!claim) return null;
    return this.authority.withCurrentIssuer(scope, claim.issuerRef,
      store => (store ?? this.store).redeem(claim, principal));
  }

  async read(input: HostedLeadBindingScope, principal: HostedPrincipal) {
    const scope = this.scope(input);
    if (!isHostedPrincipal(principal)) return null;
    return this.authority.withCurrentSubject(scope, store => (store ?? this.store).read(scope, principal));
  }

  async revoke(input: HostedLeadBindingScope, principal: HostedPrincipal): Promise<boolean> {
    const scope = this.scope(input);
    if (!isHostedPrincipal(principal)) return false;
    return (await this.authority.withCurrentSubject(scope, store => (store ?? this.store).revoke(scope, principal))) === true;
  }
}
