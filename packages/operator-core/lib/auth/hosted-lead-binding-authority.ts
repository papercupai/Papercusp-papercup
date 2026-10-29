/** D-052 production authority: existing operator sessions + canonical graph.
 * Authorization and receipt storage share ONE transaction. Connection loss or
 * a callback failure rolls back both; a separate lock transaction would allow
 * a storage commit after its authorization lock had already disappeared. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { parseHostedLeadBindingScope, type HostedLeadBindingScope } from './hosted-lead-binding';
import type { HostedLeadBindingAuthority, HostedLeadBindingStorage } from './hosted-lead-binding-service';
import { PostgresHostedLeadBindingStore } from './hosted-lead-binding-postgres';

/** Only a server-resolved opaque operator cookie may be supplied here. */
export function hostedLeadBindingIssuerRef(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('lead_binding_operator_session_invalid');
  return `operator-session:${createHash('sha256').update(token).digest('hex')}`;
}
export type LeadBindingAuthorityRunner = <T>(workspace: string, fn: (sql: Sql) => Promise<T>) => Promise<T>;
const runAuthority: LeadBindingAuthorityRunner = async (workspace, fn) => {
  // Like getSessionUser, this auth boundary uses the org admin pool to read
  // session secrets. It never returns them. Exact server-owned workspace is
  // required in every graph/session predicate as well as the transaction GUC.
  return await getOrgPg().sql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
    return fn(tx as unknown as Sql);
  }) as Awaited<ReturnType<typeof fn>>;
};

export class PostgresHostedLeadBindingAuthority implements HostedLeadBindingAuthority {
  constructor(private readonly graphWorkspaceId: string, private readonly run: LeadBindingAuthorityRunner = runAuthority) {
    if (!graphWorkspaceId.trim() || graphWorkspaceId.trim() !== graphWorkspaceId || graphWorkspaceId === '*') {
      throw new Error('lead_binding_graph_workspace_invalid');
    }
  }

  private async authorize<T>(input: HostedLeadBindingScope, issuerRef: string | null,
    operation: (store?: HostedLeadBindingStorage) => Promise<T>): Promise<T | null> {
    const scope = parseHostedLeadBindingScope(input);
    if (scope.graphWorkspaceId !== this.graphWorkspaceId) return null;
    if (issuerRef !== null && !/^operator-session:[a-f0-9]{64}$/.test(issuerRef)) return null;
    return this.run(this.graphWorkspaceId, async sql => {
      if (issuerRef !== null) {
        const issuer = await sql`SELECT s.user_id FROM harness_shared.user_sessions s
          JOIN harness_shared.users u ON u.id = s.user_id
          WHERE s.workspace_id = ${this.graphWorkspaceId} AND s.expires_at > clock_timestamp()
            AND u.is_active = true AND s.capabilities @> ARRAY['*']::text[]
            AND encode(sha256(convert_to(s.token, 'UTF8')), 'hex') = ${issuerRef.slice('operator-session:'.length)}
          FOR SHARE OF s, u`;
        if (issuer.length !== 1) return null;
      }
      // Exact canonical id, never a source row or an automatically followed
      // merge. A merge invalidates the old signed challenge.
      const person = await sql`SELECT feature_id FROM harness_shared.work_items
        WHERE workspace_id = ${this.graphWorkspaceId} AND feature_id = ${scope.personRef}
          AND item_kind = 'person' AND nature = 'record' AND payload->>'canonical' = 'true'
          AND NOT (payload ? 'mergedInto') AND NOT (payload ? 'retiredAt') FOR SHARE`;
      if (person.length !== 1) return null;
      // Reuse the production storage adapter on THIS transaction; switching
      // role preserves held row locks and narrows all receipt operations.
      await sql.unsafe('SET LOCAL ROLE hosted_service');
      return operation(new PostgresHostedLeadBindingStore(fn => fn(sql)));
    });
  }

  withCurrentIssuer<T>(scope: HostedLeadBindingScope, issuerRef: string,
    operation: (store?: HostedLeadBindingStorage) => Promise<T>): Promise<T | null> {
    return this.authorize(scope, issuerRef, operation);
  }
  withCurrentSubject<T>(scope: HostedLeadBindingScope,
    operation: (store?: HostedLeadBindingStorage) => Promise<T>): Promise<T | null> {
    return this.authorize(scope, null, operation);
  }
}
