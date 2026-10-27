import { z } from 'zod';

/**
 * chat:ask_choice option coercion — the ONE place that knows a model may hand
 * us `options` as a JSON STRING instead of an array.
 *
 * Why this exists (WI-5175, owner repro 2026-07-17):
 * `operator_turns.tools` persists the model's RAW input, and models sometimes
 * emit `options: "[{…}]"` (stringified) rather than `options: [{…}]`. Every
 * reader of that payload must therefore coerce before touching it as an array.
 *
 * Two readers exist, and they disagreed — which is exactly the bug:
 *   - apps/operator/lib/chat-cards/AskChoiceCardEntry.tsx (render) parsed the
 *     string, so the card rendered fine.
 *   - packages/operator-core/lib/endpoint-route/routes/operator/turn-answer.ts
 *     (answer) did `(args?.options ?? []).map(...)`. `??` only catches
 *     null/undefined, so a STRING sails straight through and `.map` throws —
 *     surfacing to the owner as
 *     `turn-answer failed: ((intermediate value) ?? []).map is not a function`.
 * Net effect: the card rendered and then 500'd on click. Fixing only the
 * server would leave the next reader to re-discover this, so the knowledge
 * lives here once and both sides import it.
 *
 * Returns a real array, or null when the payload is unusable. Never throws:
 * callers are on a render path and a user-click path, and neither should
 * explode on a malformed model payload.
 */

/** A single ask_choice option as the model may supply it (id/label are best-effort). */
export type AskChoiceOptionLike = Record<string, unknown>;

/**
 * Coerce a raw `options` payload into an array.
 *
 * Accepts an array (returned as-is) or a JSON string encoding an array
 * (parsed). Anything else — an object, a non-JSON string, a number, a string
 * encoding a non-array — yields null.
 */
export function coerceAskChoiceOptions(raw: unknown): AskChoiceOptionLike[] | null {
  if (Array.isArray(raw)) return raw as AskChoiceOptionLike[];
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as AskChoiceOptionLike[];
    } catch {
      /* not JSON — fall through to null */
    }
  }
  return null;
}

/**
 * The option ids present in a raw `options` payload.
 *
 * Used by the answer path to validate a pick against the offered set. An
 * uncoercible payload yields an EMPTY set, which callers treat as "cannot
 * validate" (skip validation) rather than "no options are valid" — rejecting a
 * legitimate pick because the model stringified its own payload would be the
 * same defect wearing a different hat.
 */
export function askChoiceOptionIds(raw: unknown): Set<string> {
  const options = coerceAskChoiceOptions(raw);
  if (!options) return new Set<string>();
  return new Set(
    options
      .map((o) => (o && typeof o === 'object' ? (o as { id?: unknown }).id : undefined))
      .filter((s): s is string => typeof s === 'string' && s.length > 0),
  );
}

const MAX_OPTIONS = 6;
const MAX_QUESTION_LEN = 500;
const MAX_LABEL_LEN = 80;
const MAX_HINT_LEN = 120;
const MAX_ID_LEN = 32;

const optionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(MAX_ID_LEN)
    .regex(/^[a-zA-Z0-9_-]+$/, 'option.id must be [a-zA-Z0-9_-]+'),
  label: z.string().min(1).max(MAX_LABEL_LEN),
  hint: z.string().max(MAX_HINT_LEN).optional(),
  style: z.enum(['default', 'primary', 'danger']).optional(),
});

const optionsArraySchema = z
  .array(optionSchema, {
    error:
      'chat:ask_choice needs `options`: 1-6 clickable choices, each { id, label }. For an OPEN-ENDED question (describe / paste), use plain text instead.',
  })
  .min(
    1,
    'chat:ask_choice needs at least one option (each { id, label }) — provide 2-3 for a yes/no or pick-one decision.',
  )
  .max(MAX_OPTIONS, `chat:ask_choice accepts at most ${MAX_OPTIONS} options.`);

export const askChoiceArgsSchema = z.object({
  // Caller-DX (watchdog P-006): actionable validation messages — an empty
  // `options` array previously failed with a bare "Array must contain at least
  // 1 element(s)" that gave the agent no idea what to supply.
  question: z
    .string({ error: 'chat:ask_choice needs a `question` — the prompt shown to the user.' })
    .min(1, '`question` must be a non-empty prompt.')
    .max(MAX_QUESTION_LEN),
  options: z.preprocess(
    // Models sometimes STRINGIFY the options array — `options: "[{…}]"` —
    // observed live from the operator brain (operator_turns seq 11831,
    // 2026-07-16): the first ask_choice call failed validation on exactly
    // this and burned a full retry round-trip. It is an encoding slip, not a
    // semantic error, so parse it; anything that isn't a JSON array falls
    // through to the normal schema error.
    (v) => {
      if (typeof v === 'string') {
        try {
          const parsed: unknown = JSON.parse(v);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          /* fall through to the schema error */
        }
      }
      return v;
    },
    z.union([
      optionsArraySchema,
      // The string form must ALSO be part of the schema TYPE, not only the
      // preprocess: the calling harness validates the model's raw input
      // against the ADVERTISED JSON schema before the server's zod ever
      // runs, and the preprocess-only form advertises array-only — so the
      // string slip was rejected client-side and the model reported the
      // card tool as down (operator_turns seq 12076, 2026-07-17). At
      // runtime the preprocess above has already parsed any valid
      // JSON-array string, so this branch only catches — and clearly
      // rejects — strings that are not a JSON array.
      z
        .string()
        .refine(
          (s) => {
            try {
              return Array.isArray(JSON.parse(s));
            } catch {
              return false;
            }
          },
          'chat:ask_choice `options` given as a string must be a JSON array of { id, label } objects.',
        ),
    ]),
  ),
  /** Multi-select. Default false (radio: one pick commits). */
  multi: z.boolean().optional(),
  /** Show Skip affordance. Default true. */
  allowDecline: z.boolean().optional(),
  /**
   * Single-select cards only (multi !== true). When true, voice users
   * can answer this card by speaking the option label or id; the
   * voice-card router resolves the card via /card-response. Default
   * false: voice users hear fallbackText (announce-only) and must
   * click on the chat surface. Plan §C.3 (default false / H3 review).
   */
  voiceAnswerable: z.boolean().optional(),
  /**
   * B-17/P-040 decision-context: when an AUTONOMOUS agent (bee) asks, declare WHAT
   * the decision is about so the autonomy gate can route it (reversible + in-envelope
   * + below-ceiling → the bee may self-decide; else → the owner Queue). Ignored for
   * interactive callers and while the autonomy gate is disarmed (owner P-092 OFF).
   */
  decision: z
    .object({
      action: z
        .string()
        .max(120)
        .optional()
        .describe('Tool/verb or short slug of the action the decision is about (maps to an autonomy category, B-04).'),
      riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
      authority: z.enum(['system', 'owner']).optional(),
      reversibility: z.enum(['reversible', 'irreversible', 'unknown']).optional(),
    })
    .optional()
    .describe('Decision-context for the autonomy gate (B-17/P-040) — only the cup self-answer path uses it; omit for ordinary human-facing questions.'),
});

export function normalizeParsedChoiceArgs(args: z.output<typeof askChoiceArgsSchema>) {
  // The dispatch layer already parsed these args. Never feed schema output
  // back into the input parser: transforms/preprocessing run only once.
  if (!Array.isArray(args.options)) throw new Error('invalid-ask-choice-options');
  return { ...args, options: args.options.map(option => ({ ...option, id: option.id.toLowerCase() })) };
}

/** Native tool_call events contain RAW args, before the dispatcher parsed
 * them. Parse that separate input exactly once, then use the handler's same
 * canonical form when comparing with its prepared durable card. */
export function canonicalAskChoiceInput(raw: unknown) {
  const parsed = askChoiceArgsSchema.safeParse(raw);
  return parsed.success ? normalizeParsedChoiceArgs(parsed.data) : null;
}
