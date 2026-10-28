/**
 * decision-provenance-record — a plan decision's provenance as a FIELD, not a text tag.
 *
 * one-work-graph-structured-holds-2026-10-26 P-018 (WI-6554700010030925); shape fixed by
 * one-work-graph-structured-holds-2026-10-26#D-012, bar reading in #D-008 ("a decision's
 * provenance is a field: an owner turn ref, or the agent").
 *
 * The row lives in harness_shared.plan_decision_provenance (migration 1603), NOT on
 * harness_shared.plan_decisions: that table is rebuilt from the plan body on every plan write
 * (plan-index-rows.ts writePlanIndexRows deletes then inserts), so a column only the decision
 * tools write would be wiped by the next unrelated edit.
 *
 * Rules (each has a positive and a negative test in decision-provenance-record.test.ts):
 *   1. `kind:'agent'` records the CALLER's identity as agent_id. It is never a caller argument.
 *   2. `kind:'owner'` needs a `[turn:<session>@<ts>]` ref that the turn-provenance ledger
 *      resolves to a verdict in OWNER_TURN_VERDICTS. A ref that does not parse, cannot be
 *      checked, is not found, or resolves to a non-owner turn is REFUSED: an owner claim needs
 *      positive evidence, so "could not check" is not good enough.
 *   3. A body carrying an `[owner:…]` tag is refused unless the provenance kind is owner. The
 *      tag is what this field replaces; leaving it in agent-kind bodies keeps the old ambiguity.
 *      `[turn:…]` refs stay allowed as citations.
 *
 * Resolution does transcript IO (verifyTurnRefs), so call {@link resolveDecisionProvenance}
 * BEFORE taking the plan lock, like decision-provenance.ts. The row write happens after the
 * lock, once the decision id is known.
 */

import { z } from 'zod';
import { withWorkspace } from '@papercusp/db-org';
import { OWNER_TURN_VERDICTS } from '../../carry-surface-provenance-stamp';
import {
  parseTurnRefs,
  verifyTurnRefs,
  type RecordedTurnVerdict,
  type TurnRefVerdict,
} from '../../turn-provenance/turn-ref';
import { resolveAgentIdentity } from '../coordination/identity';

/**
 * The tool argument is a flat turn-ref string, not a {kind} union. plans:add-decision is a floor
 * tool, so its schema counts against the 100_000 B tool-delivery seed (psu-launcher.test.ts
 * BUDGET), and compactInputSchema drops descriptions, so the cost is the schema STRUCTURE.
 * Measured 2026-10-28 (`npm run gen:tool-delivery -- --report`): a {kind} discriminated union,
 * top-level plus per item, overran the seed by 548 B (EI-27076355939117314).
 * The length bounds are enforced in {@link resolveDecisionProvenance} (OWNER_TURN_REF_MAX and the
 * one-ref parse), not here: a schema-level min/max cost ~30 floor bytes and added no guard the
 * resolver lacked (WI-6554700010030925, 2026-10-28).
 */
export const ownerTurnRefArg = z.string();

/** Longest ownerTurnRef the resolver will parse; a longer value is refused as unparseable. */
export const OWNER_TURN_REF_MAX = 200;

/** The internal form {@link resolveDecisionProvenance} takes. Undefined means the recording agent. */
export type DecisionProvenanceArg = { kind: 'agent' } | { kind: 'owner'; turnRef: string };

/**
 * Map the flat `ownerTurnRef` tool argument to the internal form. undefined → undefined
 * (add-decision: the agent; set-decision-body: keep the stored row). null → the agent
 * (set-decision-body only, to correct a mis-attributed owner decision). A string → owner,
 * verified by {@link resolveDecisionProvenance}.
 */
export function provenanceFromOwnerTurnRef(ref: string | null | undefined): DecisionProvenanceArg | undefined {
  if (ref === undefined) return undefined;
  if (ref === null) return { kind: 'agent' };
  return { kind: 'owner', turnRef: ref };
}

export type OwnerTurnVerdict = 'owner-typed' | 'owner-turn' | 'owner-dialog';

export type ResolvedDecisionProvenance =
  | { kind: 'agent'; agentId: string }
  | { kind: 'owner'; agentId: string; ownerTurnRef: string; ownerTurnVerdict: OwnerTurnVerdict };

export type DecisionProvenanceRefusalCode =
  | 'provenance_owner_turn_unparseable'
  | 'provenance_owner_turn_unverified'
  | 'provenance_owner_turn_not_owner'
  | 'provenance_owner_tag_without_owner_kind'
  | 'provenance_unattributable';

export interface DecisionProvenanceRefusal {
  ok: false;
  error: DecisionProvenanceRefusalCode;
  /** The argument path that failed, so the caller knows what to change. */
  field: string;
  message: string;
  verdict?: TurnRefVerdict;
}

export type DecisionProvenanceResolution =
  | { ok: true; provenance: ResolvedDecisionProvenance }
  | DecisionProvenanceRefusal;

export interface DecisionProvenanceDeps {
  verify: (ownerId: string, refs: ReturnType<typeof parseTurnRefs>) => Promise<TurnRefVerdict[]>;
}

const defaultDeps: DecisionProvenanceDeps = { verify: (ownerId, refs) => verifyTurnRefs(ownerId, refs) };

// An owner-authority tag is `[owner]`, or `[owner` + a separator (colon, whitespace, comma, `=`, `-`)
// + content, closed by `]` on the same line. A sentence that merely names the tag syntax has no
// closing bracket and is not a tag. Requiring a separator keeps `[ownerId]` and `[owners]` out.
// Measured 2026-10-28 over 16,870 papercusp-workspace decisions (first tag per body): colon 1,041,
// `[owner 2026-…]` 48, dash (`[owner-ratified …]`, `[owner-reviewed …]`) 19, bare `[owner]` 19,
// comma or space+word 8. A colon-only pattern let about 9% of owner claims past the D-012 refusal.
// One body in the census used `[owner-gated]` as a status marker; it is refused too, and rewording it
// is cheap.
const OWNER_TAG_RE = /\[\s*owner(?:\]|[\s:=,-][^\]\n]{0,160}\])/i;

/** Text outside fenced blocks and inline code spans: quoting a tag is not carrying one. */
function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** The first owner-authority tag (`[owner:…]`, `[owner …]`, `[owner-…]`, `[owner]`) in the body's prose, or null. */
export function findOwnerTag(text: string): string | null {
  return OWNER_TAG_RE.exec(proseOnly(text))?.[0] ?? null;
}

function isOwnerVerdict(v: RecordedTurnVerdict | null): v is OwnerTurnVerdict {
  return v !== null && OWNER_TURN_VERDICTS.has(v);
}

/**
 * Resolve the provenance for a decision write. `arg` undefined means agent kind.
 * `body` is the full text being written (title + body), checked for `[owner:…]` tags.
 */
export async function resolveDecisionProvenance(
  arg: DecisionProvenanceArg | undefined,
  body: string,
  ctx: unknown,
  deps: DecisionProvenanceDeps = defaultDeps,
): Promise<DecisionProvenanceResolution> {
  const kind = arg?.kind ?? 'agent';
  const tag = findOwnerTag(body);
  if (tag && kind !== 'owner') {
    return {
      ok: false,
      error: 'provenance_owner_tag_without_owner_kind',
      field: 'ownerTurnRef',
      message:
        `The body carries the owner tag ${tag}, but provenance is '${kind}'. Owner provenance is a field now: ` +
        "pass ownerTurnRef:'[turn:<session>@<ts>]' naming the owner's turn, or remove the tag " +
        'if the ruling is your own. one-work-graph-structured-holds-2026-10-26#D-012.',
    };
  }

  let agentId: string | null = null;
  try {
    agentId = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId ?? null;
  } catch {
    agentId = null;
  }

  // SPEC-P-018: a decision write with no provenance is refused, never landed 'unrecorded'.
  // Same contract as resolveAgentIdentity: a missing identity is a hard error, not an anonymous write.
  if (!agentId) {
    return {
      ok: false,
      error: 'provenance_unattributable',
      field: 'provenance',
      message:
        kind === 'owner'
          ? 'Owner provenance needs a caller identity: the owner turn is verified against your own transcript chain.'
          : 'A decision records who made it, and this caller has no resolvable identity. Call it as an attributed ' +
            'agent session (coord identity) so the decision lands with agent provenance. one-work-graph-structured-holds-2026-10-26#D-012.',
    };
  }

  if (!arg || arg.kind === 'agent') {
    return { ok: true, provenance: { kind: 'agent', agentId } };
  }
  const trimmed = arg.turnRef.trim();
  const wrapped = trimmed.startsWith('[') ? trimmed : `[turn:${trimmed}]`;
  // The schema is a bare string (floor bytes), so empty and over-long values are refused here.
  const refs = trimmed.length > 0 && arg.turnRef.length <= OWNER_TURN_REF_MAX ? parseTurnRefs(wrapped) : [];
  if (refs.length !== 1) {
    return {
      ok: false,
      error: 'provenance_owner_turn_unparseable',
      field: 'ownerTurnRef',
      message:
        `ownerTurnRef must be exactly one [turn:<session-prefix>@<iso-ts>] ref of at most ${OWNER_TURN_REF_MAX} chars; ` +
        `got ${JSON.stringify(arg.turnRef.slice(0, OWNER_TURN_REF_MAX))}${arg.turnRef.length > OWNER_TURN_REF_MAX ? '…' : ''}.`,
    };
  }
  let verdicts: TurnRefVerdict[] = [];
  try {
    verdicts = await deps.verify(agentId, refs);
  } catch {
    verdicts = [];
  }
  const v = verdicts[0];
  if (!v || !v.checked || !v.found) {
    return {
      ok: false,
      error: 'provenance_owner_turn_unverified',
      field: 'ownerTurnRef',
      message:
        `Owner turn ${refs[0].raw} could not be ${v?.checked ? 'found in' : 'checked against'} your transcript chain. ` +
        'An owner claim needs positive evidence; cite a turn the turn-provenance ledger can resolve, or record the decision as agent.',
      ...(v ? { verdict: v } : {}),
    };
  }
  if (!isOwnerVerdict(v.verdict)) {
    return {
      ok: false,
      error: 'provenance_owner_turn_not_owner',
      field: 'ownerTurnRef',
      message: `Turn ${refs[0].raw} resolved to verdict '${v.verdict ?? 'none'}', which is not the owner speaking. Record the decision as agent.`,
      verdict: v,
    };
  }
  return {
    ok: true,
    provenance: { kind: 'owner', agentId, ownerTurnRef: refs[0].raw, ownerTurnVerdict: v.verdict },
  };
}

export interface DecisionKey {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  decisionId: string;
}

/** What a decision read returns. 'unrecorded' = no row (a decision written before P-018 and not yet converted). */
export type DecisionProvenanceView =
  | { kind: 'agent'; agentId: string; source: 'write' | 'conversion'; recordedAt: string }
  | {
      kind: 'owner';
      agentId: string;
      ownerTurnRef: string;
      ownerTurnVerdict: OwnerTurnVerdict;
      source: 'write' | 'conversion';
      recordedAt: string;
    }
  | { kind: 'unrecorded' };

export const UNRECORDED_PROVENANCE: DecisionProvenanceView = { kind: 'unrecorded' };

/** Insert or replace the row for one decision (source 'write'). */
export async function upsertDecisionProvenance(key: DecisionKey, p: ResolvedDecisionProvenance): Promise<void> {
  const turnRef = p.kind === 'owner' ? p.ownerTurnRef : null;
  const verdict = p.kind === 'owner' ? p.ownerTurnVerdict : null;
  await withWorkspace(key.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.plan_decision_provenance
        (workspace_id, harness_slug, plan_slug, decision_id, kind, owner_turn_ref, owner_turn_verdict, agent_id, source)
      VALUES (${key.workspaceId}, ${key.harnessSlug}, ${key.planSlug}, ${key.decisionId},
              ${p.kind}, ${turnRef}, ${verdict}, ${p.agentId}, 'write')
      ON CONFLICT (workspace_id, harness_slug, plan_slug, decision_id) DO UPDATE SET
        kind = EXCLUDED.kind,
        owner_turn_ref = EXCLUDED.owner_turn_ref,
        owner_turn_verdict = EXCLUDED.owner_turn_verdict,
        agent_id = EXCLUDED.agent_id,
        source = 'write',
        updated_at = now()`;
  });
}

/** What a decision WRITE reports: the row it recorded, or why no row was recorded. */
export type RecordedDecisionProvenance =
  | Exclude<DecisionProvenanceView, { kind: 'unrecorded' }>
  | { kind: 'unrecorded'; reason: string };

/**
 * Record the resolved provenance after the decision write landed. Never throws: the decision
 * is already in the plan, so failing the call would report a written decision as not written.
 * A missing row is reported in the result instead, and P-019's conversion backfills it.
 */
export async function recordDecisionProvenance(
  key: DecisionKey | null,
  provenance: ResolvedDecisionProvenance | null,
  unrecordedReason = 'no provenance resolved',
): Promise<RecordedDecisionProvenance> {
  if (!provenance) return { kind: 'unrecorded', reason: unrecordedReason };
  if (!key) return { kind: 'unrecorded', reason: 'plan scope unresolved; no row written' };
  try {
    await upsertDecisionProvenance(key, provenance);
  } catch (e) {
    return { kind: 'unrecorded', reason: `provenance row write failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ...provenance, source: 'write', recordedAt: new Date().toISOString() };
}

interface ProvenanceRow {
  decision_id: string;
  kind: 'owner' | 'agent';
  owner_turn_ref: string | null;
  owner_turn_verdict: OwnerTurnVerdict | null;
  agent_id: string;
  source: 'write' | 'conversion';
  recorded_at: Date | string;
}

export function rowToView(r: ProvenanceRow): DecisionProvenanceView {
  const recordedAt = r.recorded_at instanceof Date ? r.recorded_at.toISOString() : String(r.recorded_at);
  if (r.kind === 'owner' && r.owner_turn_ref && r.owner_turn_verdict) {
    return {
      kind: 'owner',
      agentId: r.agent_id,
      ownerTurnRef: r.owner_turn_ref,
      ownerTurnVerdict: r.owner_turn_verdict,
      source: r.source,
      recordedAt,
    };
  }
  return { kind: 'agent', agentId: r.agent_id, source: r.source, recordedAt };
}

/** Provenance for the given decisions of one plan; ids with no row map to 'unrecorded'. */
export async function loadDecisionProvenance(
  scope: Omit<DecisionKey, 'decisionId'>,
  decisionIds: readonly string[],
): Promise<Map<string, DecisionProvenanceView>> {
  const out = new Map<string, DecisionProvenanceView>();
  for (const id of decisionIds) out.set(id, UNRECORDED_PROVENANCE);
  if (decisionIds.length === 0) return out;
  const rows = await withWorkspace(scope.workspaceId, async (tx) =>
    tx<ProvenanceRow[]>`
      SELECT decision_id, kind, owner_turn_ref, owner_turn_verdict, agent_id, source, recorded_at
        FROM harness_shared.plan_decision_provenance
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${scope.planSlug}
         AND decision_id = ANY(${[...decisionIds]})`,
  );
  for (const r of rows) out.set(r.decision_id, rowToView(r));
  return out;
}

/**
 * What a decision READ carries (D-012 item 4). 'unavailable' is distinct from 'unrecorded':
 * 'unrecorded' asserts that no row exists, so a failed or unscoped read must never report it.
 */
export type DecisionProvenanceReadView = DecisionProvenanceView | { kind: 'unavailable'; reason: string };

/**
 * Attach `provenance` to each decision of ONE plan — the join behind plans:get and the claim
 * planDecisions block. Never throws: a failed load marks every decision 'unavailable'.
 */
export async function withDecisionProvenance<T extends { id: string }>(
  scope: Omit<DecisionKey, 'decisionId'>,
  decisions: readonly T[],
  load: typeof loadDecisionProvenance = loadDecisionProvenance,
): Promise<Array<T & { provenance: DecisionProvenanceReadView }>> {
  if (decisions.length === 0) return [];
  let byId: Map<string, DecisionProvenanceView>;
  try {
    byId = await load(scope, decisions.map((d) => d.id));
  } catch (e) {
    const provenance: DecisionProvenanceReadView = {
      kind: 'unavailable',
      reason: `provenance read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
    return decisions.map((d) => ({ ...d, provenance }));
  }
  return decisions.map((d) => ({ ...d, provenance: byId.get(d.id) ?? UNRECORDED_PROVENANCE }));
}
