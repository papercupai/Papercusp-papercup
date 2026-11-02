/** Production PDP adapter over existing owner-signed Hive policy + plugin grants.
 * FOR SHARE pins the policy, signing identity and granted rows until execution
 * ends. A revocation cannot acknowledge a commit while an older invocation is
 * active. No TTL cache, notification lag, new table or parallel approval store.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { DispatchProjectedDeps, AuthDecision, AuthzQuery } from '@papercusp/agent-mcp';
import type { HostPluginInvocationPolicy } from './plugin-invocation-policy';
import { canonicalJson } from './authority/authority-rpc-envelope';
import { coerceHivePolicyInput, hivePolicySignedBytes } from './hive-policy-schema';
import { verifyEd25519 } from './identity/ed25519';

type Request = Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0];
export const pluginInvocationInputSha256 = (input: unknown): string =>
  createHash('sha256').update(canonicalJson(input)).digest('hex');

export async function withPinnedPluginInvocationPolicy<T>(request: Request,
  invoke: (policy: HostPluginInvocationPolicy, grants: string[]) => Promise<T>,
  opts: { sql?: postgres.Sql } = {},
): Promise<T> {
  // Snapshot only host metadata; caller arguments remain untrusted query data.
  const installation = request.tool.pluginInstallation && { ...request.tool.pluginInstallation };
  const { workspaceId, harnessSlug, principal, signal } = request.ctx;
  const pluginName = request.tool.pluginName, toolName = request.toolName, callId = request.callId;
  if (!installation || !workspaceId || !harnessSlug || !principal || signal.aborted) {
    throw new Error('Authenticated installation scope required');
  }
  const caller = { slug: principal.slug, kind: principal.kind, authMethod: principal.authMethod };
  const sql = opts.sql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
  let active = false;
  try {
    // postgres.begin races its callback against connection.onclose. The outer
    // finally also invalidates detached continuations if the connection dies
    // before their callback returns (including an idle transaction disconnect).
    return await sql.begin(async tx => {
      const rows = await tx<{ policy_json: string; owner_pubkey: string; signature: string;
        policy_version: number; public_key: Buffer }[]>`
        SELECT p.policy_json, p.owner_pubkey, p.signature, p.policy_version, h.public_key
          FROM harness_shared.pot_policy p
          JOIN harness_shared.pots h ON h.workspace_id = p.workspace_id AND h.pot_home_slug = p.harness_slug
         WHERE p.workspace_id = ${workspaceId} AND p.harness_slug = ${harnessSlug}
         FOR SHARE OF p, h`;
      const row = rows[0];
      if (rows.length !== 1 || row.owner_pubkey !== Buffer.from(row.public_key).toString('base64')
        || !Number.isSafeInteger(Number(row.policy_version)) || Number(row.policy_version) < 1
        || !verifyEd25519(hivePolicySignedBytes({ workspaceId, potHomeSlug: harnessSlug,
          policyVersion: Number(row.policy_version), canonicalPolicyJson: row.policy_json }),
        row.owner_pubkey, Buffer.from(row.signature, 'base64'))) {
        throw new Error('A current owner-signed Hive policy is required');
      }
      const parsed = coerceHivePolicyInput(JSON.parse(row.policy_json));
      if (!parsed.ok || !parsed.policy.pluginInvocations) throw new Error('No exact host invocation approvals');
      const approvals = structuredClone(parsed.policy.pluginInvocations.approvals);
      const grants = await tx<{ capability: string }[]>`
        SELECT capability FROM harness_shared.plugin_capability_grants
         WHERE plugin_name = ${pluginName} AND plugin_version = ${installation.version}
           AND harness_slug IN (${harnessSlug}, '') FOR SHARE`;
      let issuedQuery: string | undefined, issuedDecision: string | undefined, expiresAt = 0;
      const policy: HostPluginInvocationPolicy = {
        decide(query: AuthzQuery): AuthDecision {
          if (!active || signal.aborted || issuedQuery !== undefined) return { allow: false };
          const attrs = query.resource?.attributes;
          const approval = approvals.find(a => a.pluginName === pluginName && a.pluginVersion === installation.version
            && a.installationPath === installation.path && a.installationSource === installation.source
            && a.toolName === toolName && a.principalSlug === caller.slug && a.principalKind === caller.kind
            && a.authMethod === caller.authMethod && a.expiresAt > Date.now()
            && a.inputSha256 === pluginInvocationInputSha256(query.context?.input));
          if (!approval || query.action !== toolName || query.principal.slug !== caller.slug
            || query.principal.kind !== caller.kind || query.principal.authMethod !== caller.authMethod
            || query.principal.workspaceId !== workspaceId || query.context?.callId !== callId
            || typeof query.context?.invocationBinding !== 'string' || !/^[a-f0-9]{64}$/.test(query.context.invocationBinding)
            || query.resource?.type !== 'plugin-installation' || query.resource.id !== `${pluginName}@${installation.version}`
            || attrs?.harnessSlug !== harnessSlug || attrs.path !== installation.path
            || attrs.version !== installation.version || attrs.source !== installation.source) return { allow: false };
          const decision: AuthDecision = { allow: true, obligations: { pluginInvocation: {
            binding: query.context.invocationBinding, capabilities: [...approval.capabilities], expiresAt: approval.expiresAt,
            policyVersion: Number(row.policy_version),
          } } };
          issuedQuery = canonicalJson(query); issuedDecision = canonicalJson(decision); expiresAt = approval.expiresAt;
          return decision;
        },
        isCurrent: (query, decision) => active && !signal.aborted && Date.now() < expiresAt
          && issuedQuery !== undefined && canonicalJson(query) === issuedQuery && canonicalJson(decision) === issuedDecision,
      };
      active = true;
      let abort: () => void = () => {};
      try {
        return await Promise.race([
          Promise.resolve().then(() => { if (signal.aborted) throw new Error('Invocation aborted');
            return invoke(policy, grants.map(g => g.capability)); }),
          new Promise<never>((_, reject) => {
            abort = () => { active = false; reject(new Error('Invocation aborted')); };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally { active = false; signal.removeEventListener('abort', abort); }
    }) as T;
  } finally { active = false; }
}
