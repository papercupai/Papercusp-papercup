/**
 * session-confinement-port — the host seam that carries a launch-declared confinement
 * to the dispatch seat (directed-pair-work-items-2026-08-25 P-003, ruling D-015).
 *
 * WHY THIS IS A SEPARATE FILE FROM `session-confinement.ts`
 * --------------------------------------------------------
 * The pure module must never see privilege — that absence is guarantee (A), and its
 * guard test pins it by asserting the source contains no `isSuperuser` / `UnifiedToolContext`
 * reference. This file necessarily touches `UnifiedToolContext` (that is its whole job),
 * so it lives next door rather than trip that guard. The split is the architecture, not
 * a workaround: DECISION stays privilege-blind, TRANSPORT knows about sessions.
 *
 * WHY THE DENY IS NOT FLAG-GATED
 * ------------------------------
 * The capability envelope reads `FLAGS.CAPABILITY_ENVELOPE` to choose enforce-vs-observe,
 * because it applies to every fleet role and a bad envelope would break the fleet. This
 * gate has the opposite blast radius: it returns null — completely inert — for any session
 * with no declared confinement, which is every session in existence until a paired fleet
 * launches one. So there is no shadow period to serve; an observe-only mode here would
 * only mean the one thing it is for does not work. It ships enforcing.
 *
 * WHY `pinModuleState` AND NOT A BARE MODULE-SCOPED `let`
 * ------------------------------------------------------
 * A resolver seam that splits across two module records fails OPEN: the record the
 * dispatcher imports has no resolver, `resolveConfinement` returns undefined, and every
 * confined session silently becomes unconfined — with nothing thrown and nothing logged.
 * That is precisely the partial-view failure `@papercusp/module-singleton` exists for, and
 * a security gate is the worst place to discover it the expensive way.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type { CapabilityEnvelopeVerdict } from '@papercusp/tooldef';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { evaluateSessionConfinement, validWorkItemBoundary, type SessionToolConfinement } from './session-confinement';
import { isHookReleasedOperationContinuationCall } from '../released-operation-continuation-door';

/**
 * Resolves the confinement declared for the calling session, or null/undefined if the
 * session is unconfined. Installed once by the host at boot.
 *
 * ⚠ The resolver MUST read server-side state keyed by the session's own identity. It must
 * never read a confinement out of the request/args: a confinement the caller supplies is
 * one the caller can omit, which is not a confinement.
 */
export type SessionConfinementResolver = (
  ctx: UnifiedToolContext,
  phases?: UnifiedToolContext['phases'],
) => SessionToolConfinement | null | undefined | Promise<SessionToolConfinement | null | undefined>;

const state = pinModuleState('@papercusp/operator-core.session-confinement-port', () => ({
  resolver: undefined as SessionConfinementResolver | undefined,
  ensureReady: undefined as (() => Promise<void>) | undefined,
}));

/**
 * Install (or clear, with `undefined`) the host resolver.
 *
 * Optional `ensureReady` is awaited before consulting the resolver. A host may
 * memoize initialization, but the installed store resolver independently reads
 * authoritative per-workspace policy on every call, including after restart.
 */
export function setSessionConfinementResolver(
  fn: SessionConfinementResolver | undefined,
  opts?: { ensureReady?: () => Promise<void> },
): void {
  state.resolver = fn;
  state.ensureReady = opts?.ensureReady;
}

/** Whether a resolver is installed — for boot assertions and tests. */
export function hasSessionConfinementResolver(): boolean {
  return state.resolver !== undefined;
}

/** Read the same host policy as dispatch before producing OR serving context.
 * The lookup context identifies the hook's session; it executes no tool and
 * grants no authority. Missing/unreadable policy suppresses optional context.
 * Unbound human conversations retain their ordinary behavior. A pinned native
 * session needs a readable host policy, including during bootstrap. */
export async function sessionAllowsAmbientContext(input: {
  ownerId?: string | null; workspaceId: string;
}): Promise<boolean> {
  try { return (await sessionPromptPolicy(input)).ambientContextAllowed; }
  catch { return false; }
}

/** One authoritative read for prompt composition. A frozen exact-item ceiling
 * without any ledger/plan verb delegates those mechanics to its existing host.
 * This derives from the immutable policy; there is no caller-controlled flag.
 * Unreadable bound policy refuses a launch instead of rendering unknown workflow. */
export async function sessionPromptPolicy(input: {
  ownerId?: string | null; workspaceId: string;
}): Promise<{ ambientContextAllowed: boolean; workItemWorkflow: 'agent-managed' | 'host-managed' }> {
  const ordinary = { ambientContextAllowed: true, workItemWorkflow: 'agent-managed' as const };
  if (!input.ownerId) return ordinary;
  const resolver = state.resolver;
  if (!resolver) throw new Error('Session prompt policy is unavailable.');
  await state.ensureReady?.();
  const confinement = await resolver({ uiClientId: input.ownerId,
    workspaceId: input.workspaceId, isSuperuser: true } as UnifiedToolContext);
  if (!confinement) return ordinary;
  if (confinement.denyWorkItemsOutside !== undefined && !validWorkItemBoundary(confinement.denyWorkItemsOutside))
    throw new Error('Session prompt workflow assignment boundary is invalid.');
  const hostManaged = confinement.denyAmbientContext === true && confinement.denyWorkItemsOutside !== undefined &&
    confinement.denyOutside !== undefined && !confinement.denyOutside.some(name => /^(?:work_items|plans):/.test(name));
  return { ambientContextAllowed: confinement.denyAmbientContext === undefined,
    workItemWorkflow: hostManaged ? 'host-managed' : 'agent-managed' };
}

/**
 * The gate, in the shape the dispatcher's capability-envelope port already returns.
 *
 * Returns null when there is nothing to say (no resolver, unconfined session, or a tool
 * the confinement permits) so the caller falls through to the ordinary envelope check.
 *
 * Note what is NOT consulted here: `ctx.isSuperuser`, `ctx.isPowerUser`, `ctx.role`. A
 * confined session is confined at every privilege level — that is the entire point of
 * D-015, and it is what makes this gate bind where `ROLE_ENVELOPES` cannot.
 */
export async function checkSessionConfinement(input: {
  toolName: string;
  ctx: UnifiedToolContext;
  args?: unknown;
  phases?: UnifiedToolContext['phases'];
}): Promise<CapabilityEnvelopeVerdict | null> {
  const resolver = state.resolver;
  if (!resolver) return null;

  const ensureReady = state.ensureReady;
  if (ensureReady) {
    try {
      // Memoized by the host: one await per process, not one per dispatch.
      const prepare = () => ensureReady();
      if (input.phases) await input.phases.track('capability-envelope.session-confinement.ensure-ready', prepare);
      else await prepare();
    } catch {
      return { decision: 'deny', posture: 'rejected', applied: true,
        reason: 'Session confinement policy is unavailable; refusing the call until its authority can be read.' };
    }
  }

  let confinement: SessionToolConfinement | null | undefined;
  try {
    const resolve = () => resolver(input.ctx, input.phases);
    if (input.phases) confinement = await input.phases.track('capability-envelope.session-confinement.resolver', resolve);
    else confinement = await resolve();
  } catch {
    // Unknown confinement is unknown authority. A rejected read must never turn
    // a confined caller into an ordinary unconfined session, including on restart.
    console.error('[session-confinement] resolver failed — refusing dispatch until policy is readable');
    return { decision: 'deny', posture: 'rejected', applied: true,
      reason: 'Session confinement policy is unavailable; refusing the call until its authority can be read.' };
  }
  if (!confinement) return null;

  // The recovery door is not added to (and therefore cannot widen) a frozen
  // assignment ceiling. A readable confinement may stand down only for this
  // hook-declared call; the handler then proves that the current identity is an
  // accepted-operation worker with an exact released claim and captured owner
  // turn. Unreadable confinement still fails closed above.
  if (isHookReleasedOperationContinuationCall({ toolName: input.toolName, ctx: input.ctx })) return null;

  const decision = evaluateSessionConfinement({ toolName: input.toolName, args: input.args, confinement });
  if (decision.allowed) {
    if (input.toolName.trim() === 'work_items:complete' && confinement.denyWorkItemsOutside) {
      try {
        const root = await realpath(confinement.denyWorkItemsOutside.checkout);
        const row = input.args as { completion: { filesChanged?: string[]; filesDeleted?: string[] } };
        for (const path of [...row.completion.filesChanged ?? [], ...row.completion.filesDeleted ?? []]) {
          let target = resolve(root, path);
          // Deleted/new files may not exist. Resolve their nearest existing
          // parent to catch symlinks without rejecting ordinary evidence.
          while (true) {
            try { target = await realpath(target); break; }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(target) === target) throw error;
              target = dirname(target);
            }
          }
          const rel = relative(root, target);
          if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('proof path escapes checkout');
        }
      } catch {
        return { decision: 'deny', posture: 'rejected', applied: true,
          reason: 'Completion proof paths must remain inside the launch-declared assignment checkout.' };
      }
    }
    return null;
  }

  return {
    decision: 'deny',
    posture: 'rejected',
    applied: true,
    reason: decision.reason,
  };
}
