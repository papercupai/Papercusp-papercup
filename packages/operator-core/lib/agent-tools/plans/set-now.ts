/**
 * plans:set-now — write the plan's Now note.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2: the Now is the cold-resume
 * anchor, a state+next pair.
 *
 * derived-status-not-hand-written-2026-10-12 P-004 (D-007/D-008): the note is
 * stored as structured fields in harness_plans.now_note (text, author,
 * written-at, the now_updated event's id), NOT rewritten into the plan's
 * markdown. The content, its hash and the version are untouched, so a Now
 * update records no revision. Readers take the note over any content `## Now`
 * section, which stays only as frozen legacy text (now-note-store.ts).
 *
 * Writes inside the plan lock; the Now/item omission guard evaluates the plan
 * as it will read with the new note.
 *
 * P-006 (D-011): a note may mention finished items. Item status is derived from
 * the item rows, so the note is narration only; set-now no longer refuses a note
 * that names a done item, and no terminal/greenlit stamp is written into it.
 *
 * `replaceNowBlock` below is the content-section writer used by the
 * plan-scope-cascade banners (stampMootCarrierNowBlock / stampBarReadinessNowBlock).
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { newMsgId } from '@papercusp/coordination/core';
import { withPlanLock } from './with-plan-lock';
import { maskFences, parsePlan } from './parser';
import { detectNowItemOmissions, type NowItemOmission } from './now-item-contradictions';
import { applyNowNoteToParsed, buildSetNowNote, type PlanNowNote } from './now-note-store';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { softText, clampText } from '../limits';
import {
  detectEphemeralDeliverableReferences,
  renderEphemeralDeliverableWarning,
} from '../../turn-end-tracking';
import { provenanceLintField } from '../../carry-surface-provenance-lint';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).optional(),
  slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to update with the same Now block in one call.'),
  state: softText(2000, { min: 1 }).describe(
    'One paragraph (≤2000 chars) describing where the plan currently stands. Keep it tight — the Now block is a cold-resume anchor, NOT a log. Auto-truncated to 2000 chars if longer (reported as `clamped`); put long-form detail in the plan body via plans:set-content / set-content-chunk, not here.',
  ),
  next: softText(8000, { min: 1 })
    .describe('One sentence (≤8000 chars) — the single next concrete action and who should do it. Auto-truncated to 8000 chars if longer; multi-step detail belongs in plan items or the body.'),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — a short why behind this state change, stored on the Now note. Routine progress updates can omit it.',
    ),
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
});

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type SetNowValue =
  | { ok: true }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'now_item_omission'; omissions: NowItemOmission[] };

export function replaceNowBlock(body: string, state: string, next: string): string {
  const block = `## Now\n\n**State:** ${state.trim()}\n\n**Next:** ${next.trim()}\n`;

  // Tolerant match — accept any "## [N.] Now" heading. The capture runs
  // from just after the heading line to the next `## ` heading OR the
  // end of the document. NOTE: JavaScript regex has no `\Z` anchor —
  // a literal `\Z` matches the character "Z" — so end-of-input must be
  // spelled `(?![\s\S])` ("no character follows"). The earlier `\Z`
  // form truncated the match at the first capital Z in the Now text
  // (corrupting the file), and when the Now block had no following
  // `## ` heading it failed to match at all and got duplicated by the
  // insert branch below.
  const nowRe = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Now\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m;
  // Locate against the fence-masked body so a `## Now` heading inside a
  // worked-example code fence is never matched. m.index / m[0].length
  // are valid against the real body (maskFences preserves length); the
  // splice replaces the whole old block, so any fenced content that was
  // inside it is correctly discarded with it. Index splice rather than
  // body.replace also keeps user-supplied state/next literal.
  const m = nowRe.exec(maskFences(body));
  if (m) {
    return body.slice(0, m.index) + block + '\n' + body.slice(m.index + m[0].length);
  }
  // No Now block: insert after frontmatter close (or at top if none).
  if (body.startsWith('---')) {
    const close = body.indexOf('\n---', 3);
    if (close !== -1) {
      const afterClose = body.indexOf('\n', close + 4);
      const insertAt = afterClose === -1 ? body.length : afterClose + 1;
      return body.slice(0, insertAt) + '\n' + block + '\n' + body.slice(insertAt);
    }
  }
  return block + '\n' + body;
}

/**
 * Pure decision core for plans:set-now. Keeping the omission check in the
 * same evaluator used by the handler makes the structured write guard
 * unit-testable without the SU lock side-database.
 *
 * derived-status-not-hand-written-2026-10-12 P-004 (D-007/D-008): the Now is a
 * structured note, not a content section. The evaluator never returns a body
 * (`newBody` is always null, so the plan's markdown, content hash and version
 * are untouched and no revision is recorded); on success it returns the note
 * withPlanLock stores in `now_note`. The guards run on the plan as readers will
 * see it: the current content with its Now replaced by the new note.
 */
export function evaluateNowUpdate(
  current: string | null,
  state: string,
  next: string,
  slug: string,
  meta: {
    author: string | null;
    eventId: string | null;
    rationale?: string | null;
    writtenAt?: Date;
  } = {
    author: null,
    eventId: null,
  },
): { newBody: null; nowNote?: PlanNowNote; value: SetNowValue } {
  if (current === null) {
    return { newBody: null, value: { ok: false, code: 'not_found' } };
  }

  const nowNote = buildSetNowNote({ state, next, ...meta });
  const asRead = applyNowNoteToParsed(parsePlan(current, { filePath: `${slug}.md` }), nowNote);
  // P-006: no contradiction refusal — a note naming a done item is narration.
  const omissions = detectNowItemOmissions(asRead);
  if (omissions.length > 0) {
    return {
      newBody: null,
      value: { ok: false, code: 'now_item_omission', omissions },
    };
  }
  return { newBody: null, nowNote, value: { ok: true } };
}

export default defineTool({
  name: 'plans:set-now',
  description:
    "Write the plan's Now note (state + next, stored as structured fields; the plan markdown and version are untouched). The Now is the cold-resume anchor — the single most-read field, NOT a log: keep State ≤2000 chars + Next ≤800 (both auto-truncate, reported as `clamped`; long-form detail belongs in the plan body via plans:set-content / set-content-chunk).",
  guidance: {
    when: 'Plan state advances meaningfully — phase boundaries, blocking discovery, finishing a chunk of work, picking up a new direction.',
    notWhen:
      'Per-item flip — that\'s plans:set-status. Or a decision — that\'s plans:add-decision.',
    chaining:
      'plans:set-status to flip current item → plans:set-now reflecting the new state. Keep State ≤2000 chars / Next ≤800 — an overflow auto-truncates (see `clamped`); offload long-form detail to plans:set-content / set-content-chunk.',
    seeAlso: [
      'plans:set-status (flip an item\'s lifecycle, not the narration)',
      'plans:add-decision (record a durable decision, not a now-note)',
      'plans:set-content (offload overflow detail out of the Now)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    // softText `next` + `state` (P-002): never bounced on length — clamp to cap
    // here. `state` was a hardText reject until EI-20020322245949080: the Now
    // block is echoed prose with no downstream bound, so per limits.ts policy it
    // is a soft field, and bouncing it cost a full round-trip per attempt (five
    // in a row, shaving 4-14 chars each). The clamp is REPORTED rather than
    // silent — this is the cold-resume anchor, so a dropped tail must be visible.
    const next = clampText(args.next, 8000);
    const state = clampText(args.state, 2000);
    const clamped = [
      ...(args.state.length > 2000
        ? [{ field: 'state' as const, fromChars: args.state.length, toChars: 2000 }]
        : []),
      ...(args.next.length > 8000
        ? [{ field: 'next' as const, fromChars: args.next.length, toChars: 8000 }]
        : []),
    ];
    const slugs = mergeIds(args.slug, args.slugs);
    let author: string | null = null;
    try {
      author = resolveAgentIdentity(ctx as ResolveIdentityCtx).ownerId;
    } catch {
      author = null;
    }
    const env = await runBulk(
      slugs,
      async (slug) => {
        // P-004: the note names its own now_updated event. The id is minted
        // before the locked write and the event is emitted with it after the
        // commit (emission stays outside the lock and best-effort).
        const eventId = newMsgId();
        let writtenNote: PlanNowNote | undefined;
        const result = await withPlanLock<SetNowValue>(
          ctx as never,
          {
            slug,
            intent: `plans:set-now`,
            ...(harnessSlug ? { harnessSlug } : {}),
          },
          async (current) => {
            const evaluated = evaluateNowUpdate(current, state, next, slug, {
              author,
              eventId,
              rationale: args.rationale?.trim() || null,
            });
            writtenNote = evaluated.nowNote;
            return evaluated;
          },
        );

        if (result.kind === 'refused') return { slug, error: result.value.code, ...result.value };
        if (result.kind === 'busy') {
          return {
            ok: false as const,
            slug,
            error: 'busy',
            busy: result.busy.map((b) => ({
              path: b.path,
              owner_label: b.owner_label,
              intent: b.intent,
              expires_ts: b.expires_ts,
            })),
          };
        }

        if (!result.value.ok) {
          return {
            ok: false as const,
            slug,
            error: result.value.code,
            ...(result.value.code === 'now_item_omission'
              ? { omissions: result.value.omissions }
              : {}),
          };
        }

        // EI-20268156880922192: a Now block is durable, but it may still point
        // successors at a session-local scratch path or account-local artifact
        // URL that evaporates. Warn after the write succeeds; this guard is
        // deliberately advisory/fail-open so a detector fault never loses the
        // state update it is meant to protect.
        let ephemeralDeliverableWarning: string | undefined;
        try {
          const references = detectEphemeralDeliverableReferences(`${args.state}\n${next}`);
          ephemeralDeliverableWarning = renderEphemeralDeliverableWarning(
            `plans:set-now for ${slug}`,
            references,
          );
        } catch {
          /* fail-open: the Now write already landed */
        }

        // WI-41690 / EI-21459558956325262: the Now block is re-injected verbatim
        // to every future reader as binding context, so an owner-attribution
        // asserted here ("Approved by <owner>") is read as authorization by
        // agents that never saw the conversation. That is the WI-3532
        // telephone-game shape, observed live on
        // llm-agent-evaluation-measurement-integrity-2026-08-25: a self-authored
        // approval line was quoted back as authority by a later session and came
        // one call short of activating a five-item plan.
        //
        // facts:assert, loop:checkpoint, work_items:checkpoint and
        // session:request-compaction already run this same shared lint. The plan
        // Now block was the one carry surface left unguarded — despite having the
        // widest blast radius of the five, since the others are read mainly by
        // their own author and this one is delivered to everyone.
        //
        // Deliberately the SYNC provenanceLintField, not the async
        // carryProvenanceFields the other four use: this runs inside the plan
        // lock, and carryProvenanceFields performs turn-ref IO under a 3s budget.
        // Paying IO inside a held lock to buy ref VERIFICATION is the wrong trade
        // for an advisory detector — the flag and its remedy note are the
        // load-bearing part, and they need no IO.
        //
        // Advisory and fail-open, exactly like the ephemeral guard above: a
        // detector fault must never lose the state update it exists to protect.
        let provenanceLint: ReturnType<typeof provenanceLintField>;
        try {
          provenanceLint = provenanceLintField(`${state}\n${next}`);
        } catch {
          /* fail-open: the Now write already landed */
        }

        const emitted = await emitPlanEventForCaller(ctx, {
          planSlug: slug,
          event: 'now_updated',
          after: next,
          detail: state.slice(0, 200),
          msgId: eventId,
        });

        return {
          ok: true as const,
          slug,
          filePath: result.filePath,
          // P-004: the note is stored beside the content, so the plan markdown,
          // content hash and version are unchanged and no revision is recorded.
          revision: null,
          note: {
            writtenAt: writtenNote?.writtenAt ?? null,
            // null when the best-effort event emit failed (the note keeps the
            // pre-minted id, which then names no event).
            eventId: emitted,
          },
          ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
          ...(ephemeralDeliverableWarning ? { ephemeralDeliverableWarning } : {}),
          ...(provenanceLint ? { provenanceLint } : {}),
          ...(clamped.length ? { clamped } : {}),
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    return bulkContent(env);
  },
});
