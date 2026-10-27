/**
 * EI-7517 — resolve an omitted `scopeRef` from the CALLER's ctx for the
 * self-scoped fact scopes (owner=me, harness=this harness, role=my role), so an
 * agent asserting / listing / retracting a fact about "just me" needn't look up
 * and pass its own id (the recurring "scope 'owner' requires scope_ref"
 * structural error, watchdog-flagged).
 *
 * Identity is resolved ONLY when a default is actually needed — an explicit
 * scopeRef, or a scope with no ctx default (workspace / work_item), skips the
 * resolve entirely, so a read caller that passes an explicit ref is never
 * forced through attribution (resolveAgentIdentity throws on an unattributable
 * ctx). facts:assert resolves identity anyway (for createdBy) and calls the
 * pure {@link resolveFactScopeRef} directly.
 */
import { resolveFactScopeRef, type FactScope } from '../../agent-facts/store';
import type { ResolveIdentityCtx } from '../coordination/identity';

/**
 * EI-7371 — tolerate common MISNAMED scopeRef aliases instead of silently
 * dropping them. zod strips unrecognized keys before the handler ever sees
 * them, so a caller that typed `scope_ref` (snake_case), bare `ref`, or (for
 * scope:'harness') `harness` — all real, evidenced shapes from
 * harness_shared.tool_invocations, 2026-07-02..04, 13 identical structural
 * errors — got the ref-bearing arg thrown away and then hit "requires
 * scope_ref" despite having supplied a value. Each tool's zod schema must
 * declare these as optional passthrough fields for this to see them; an
 * explicit canonical `scopeRef` always wins over any alias.
 */
export interface ScopeRefAliasArgs {
  scopeRef?: string | null;
  scope_ref?: string | null;
  ref?: string | null;
  harness?: string | null;
}

export function resolveScopeRefAlias(scope: FactScope, args: ScopeRefAliasArgs): string | null | undefined {
  if ((args.scopeRef ?? '').trim()) return args.scopeRef;
  if ((args.scope_ref ?? '').trim()) return args.scope_ref;
  if ((args.ref ?? '').trim()) return args.ref;
  if (scope === 'harness' && (args.harness ?? '').trim()) return args.harness;
  return args.scopeRef;
}

/**
 * WI-6554700010029664 — `scope_ref` and `ref` are folded into `scopeRef` BEFORE parse
 * (wrap the tool's args in `z.preprocess(foldScopeRefAliases, …)`) instead of being
 * declared as sibling schema fields. Declared, they cost ~60 B of compact schema on
 * every seeded turn (facts:list and facts:retract are both seed tools, and the seed
 * has a 100,000 B budget) while only ever meaning `scopeRef`. Still accepted, never
 * advertised — same pattern as plans:items' `normalizePlansItemsArgs`.
 *
 * Precedence is {@link resolveScopeRefAlias}'s: a non-blank `scopeRef` wins, then
 * `scope_ref`, then `ref`. `harness` stays a declared field because it only means
 * scopeRef when scope is 'harness'.
 */
const FOLDED_SCOPE_REF_ALIASES = ['scope_ref', 'ref'] as const;

export function foldScopeRefAliases(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!FOLDED_SCOPE_REF_ALIASES.some((key) => r[key] !== undefined)) return raw;
  const rest: Record<string, unknown> = { ...r };
  const nonBlank = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
  let scopeRef = rest.scopeRef;
  for (const key of FOLDED_SCOPE_REF_ALIASES) {
    const value = rest[key];
    delete rest[key];
    // A non-string alias value is carried into scopeRef (when nothing else filled it) so the
    // schema still REJECTS it with a type error instead of the fold silently dropping it.
    const wrongType = value !== undefined && value !== null && typeof value !== 'string';
    if (!nonBlank(scopeRef) && (nonBlank(value) || (scopeRef === undefined && wrongType))) scopeRef = value;
  }
  return scopeRef === undefined ? rest : { ...rest, scopeRef };
}

export async function resolveScopeRefFromCtx(
  scope: FactScope,
  scopeRef: string | null | undefined,
  ctx: ResolveIdentityCtx,
): Promise<string | null | undefined> {
  const needsDefault =
    !(scopeRef ?? '').trim() && (scope === 'owner' || scope === 'harness' || scope === 'role');
  if (!needsDefault) return scopeRef;
  const {
    resolveAgentIdentity,
    deriveAgentRole,
    verifiedSpawnSessionAlias,
  } = await import('../coordination/identity');
  const identity = resolveAgentIdentity(ctx);
  // A trusted signed spawn speaks as `system:<role>/<sessionId>`, but its
  // owner-scoped facts are keyed by the verified bare session id. Reuse the
  // coordination identity's narrow alias guard; never strip an arbitrary
  // principal prefix from an untrusted bearer/client identity.
  const ownerId =
    scope === 'owner'
      ? verifiedSpawnSessionAlias(ctx, identity.ownerId) ?? identity.ownerId
      : identity.ownerId;
  return resolveFactScopeRef(scope, scopeRef, {
    ownerId,
    harnessSlug: ctx.harnessSlug,
    role: deriveAgentRole(identity),
  });
}
