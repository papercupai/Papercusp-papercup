/**
 * Regression guard for tool-contract-repair-2026-09-05 P-005 (the loop family).
 *
 * Each `it` below pins ONE repair that closed filings in that lane. The lane's
 * value is self-reproducing prevention: every filing was a caller who guessed a
 * name a reasonable person would guess, so an accidental revert re-opens the
 * class rather than failing loudly on its own.
 *
 * These assert against the tools' REAL parsed argument schemas — never a
 * substring match on a rendered schema summary, which is the false negative the
 * plan's standing rules call out (a `one-of` group hides a declared field from a
 * text search, and the miss looks exactly like a clean result).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceCarryRowShape, coerceWallRowShape } from '../../carry-note';
import type { CarryArgRepair } from '../../carry-note';
import loopArm from './arm';
import loopCheckpoint from './checkpoint';
import loopEnd from './end';
import loopStatus from './status';

/**
 * Render a tool's arg schema the way defineTool registration does.
 *
 * The cast goes through `unknown` deliberately: `z.toJSONSchema` is overloaded, so
 * `Parameters<typeof z.toJSONSchema>[0]` resolves to the `$ZodRegistry` overload and TS2352
 * rejects a ZodObject against it — a type-only break that a green vitest run cannot see,
 * because vitest transforms via esbuild and never typechecks.
 */
function renderToJSONSchema(schema: unknown): { properties?: Record<string, unknown>; required?: string[] } {
  // Cast the FUNCTION, not the argument — the argument cast is what picks the wrong overload.
  const render = z.toJSONSchema as unknown as (s: unknown) => {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return render(schema);
}

/** Parse through the tool's own declared arg schema, as the dispatcher does. */
function parseArgs(tool: { args: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } } }, value: unknown) {
  return tool.args.safeParse(value);
}

describe('P-005 loop family — argument contract repairs', () => {
  describe('loop:status / loop:end accept `harness` (the largest fingerprint in the lane)', () => {
    // ~29 filings, all "Unrecognized key: harness; accepts only ownerId". Loops are
    // keyed by owner, so the value cannot change the answer — accepted and ignored.
    it('loop:status accepts harness', () => {
      const parsed = parseArgs(loopStatus, { harness: 'papercusp' });
      expect(parsed.success).toBe(true);
    });

    it('loop:end accepts harness', () => {
      const parsed = parseArgs(loopEnd, { harness: 'papercusp' });
      expect(parsed.success).toBe(true);
    });

    it('the accepted `harness` is declared, not silently swallowed by a loose schema', () => {
      // The distinction that makes the assertion above meaningful: an undeclared key
      // must still be REFUSED, which is the loud behaviour the plan preserves.
      const parsed = parseArgs(loopStatus, { harnesss: 'papercusp' });
      expect(parsed.success).toBe(false);
    });
  });

  describe('loop:status accepts `owner` as an alias for `ownerId` (EI-21206535634211412)', () => {
    it('accepts owner', () => {
      // WI-6554700010029664 folds the `owner` synonym into `ownerId` BEFORE parse, so the
      // accepted value arrives as `ownerId` and `owner` itself is gone from the parsed args.
      const parsed = parseArgs(loopStatus, { owner: 'su-abc' });
      expect(parsed.success).toBe(true);
      const data = parsed.data as { owner?: string; ownerId?: string };
      expect(data.ownerId).toBe('su-abc');
      expect(data.owner).toBeUndefined();
    });

    it('an explicit ownerId wins over the owner synonym', () => {
      const parsed = parseArgs(loopStatus, { owner: 'su-abc', ownerId: 'su-def' });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { ownerId?: string }).ownerId).toBe('su-def');
    });

    it('still refuses a key that is neither', () => {
      expect(parseArgs(loopStatus, { ownerid: 'su-abc' }).success).toBe(false);
    });
  });

  describe('loop:arm — the carry-only retune the continuation guidance prescribes', () => {
    // The plan named this the clearest GUIDANCE defect in the set: loop:checkpoint's
    // continuation prose told callers to run `loop:arm { carry: 'cold' }`, which the
    // schema then rejected for missing intervalSec/goal — a tool prescribing a call
    // that cannot succeed. ~7 filings.
    it('accepts a carry-only retune with no intervalSec and no goal', () => {
      const parsed = parseArgs(loopArm, { carry: 'cold' });
      expect(parsed.success).toBe(true);
    });

    it('accepts a bare-string blockedOn, mapping it to { reason } (EI-21266013579763384)', () => {
      const parsed = parseArgs(loopArm, { carry: 'cold', blockedOn: 'green gate red, blocking every deploy' });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { blockedOn?: { reason?: string } }).blockedOn).toEqual({
        reason: 'green gate red, blocking every deploy',
      });
    });

    it('an empty bare-string blockedOn still fails on reason.min(1), not on the shape', () => {
      // The repair must not convert a real problem into a silently-accepted empty
      // blocker: routing it through means the schema names the actual fault.
      expect(parseArgs(loopArm, { carry: 'cold', blockedOn: '' }).success).toBe(false);
    });

    it('an object blockedOn is untouched by the preprocessor', () => {
      const parsed = parseArgs(loopArm, {
        carry: 'cold',
        blockedOn: { reason: 'gate red', event: 'gate:green' },
      });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { blockedOn?: { event?: string } }).blockedOn?.event).toBe('gate:green');
    });
  });

  describe('loop:checkpoint — the aliases that close the `checkpoint`/row-shape filings', () => {
    it('accepts the `checkpoint` key as a string alias for `note`', () => {
      // ~9 filings across 6 fingerprints: callers mirror work_items:checkpoint's
      // { id, checkpoint } shape onto this tool.
      expect(parseArgs(loopCheckpoint, { checkpoint: 'carry state' }).success).toBe(true);
    });

    it('accepts keyInsight / nextAction / goal as carry-field aliases', () => {
      expect(parseArgs(loopCheckpoint, { keyInsight: 'a', nextAction: 'b' }).success).toBe(true);
      expect(parseArgs(loopCheckpoint, { goal: 'c' }).success).toBe(true);
    });

    it('accepts a walls row written with `description` instead of `claim`', () => {
      // EI-20256358119840421 / EI-21123164129476823: the byte-identical key was
      // already accepted on a CHECKS row, so the rejection was an asymmetry inside
      // one tool's own two row types, not a contract.
      const parsed = parseArgs(loopCheckpoint, { walls: [{ description: 'owner must arm capital' }] });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { walls?: { claim?: string }[] }).walls?.[0]?.claim).toBe('owner must arm capital');
    });

    it('accepts a walls row written with `key` instead of `id`', () => {
      const parsed = parseArgs(loopCheckpoint, { walls: [{ key: 'w1', claim: 'owner sign-off' }] });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { walls?: { id?: string }[] }).walls?.[0]?.id).toBe('w1');
    });

    it('accepts a checks row written with `description`', () => {
      const parsed = parseArgs(loopCheckpoint, { checks: [{ description: 'suite green' }] });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { checks?: { claim?: string }[] }).checks?.[0]?.claim).toBe('suite green');
    });
  });

  describe('the walls repair is the ALIAS half only — WI-7264 stays in force', () => {
    // WI-7264 decided walls must NOT get the {status, evidence} coercion: a wall has
    // no `verified` field, so mapping `evidence` would have to DROP the caller's data
    // (EI-18723223344390510). If a future change routes walls through the full
    // coerceCarryRowShape, this test is what catches it.
    it('coerceWallRowShape leaves status/evidence alone so the row still fails loudly', () => {
      const repairs: CarryArgRepair[] = [];
      const out = coerceWallRowShape({ claim: 'x', status: 'verified', evidence: 'ran it' }, 'walls[0]', repairs);
      expect(out).toEqual({ claim: 'x', status: 'verified', evidence: 'ran it' });
      expect(repairs).toHaveLength(0);
    });

    it('a walls row carrying evidence is still refused by the schema', () => {
      expect(parseArgs(loopCheckpoint, { walls: [{ claim: 'x', evidence: 'ran it' }] }).success).toBe(false);
    });

    it('coerceWallRowShape does not treat `kind` as a claim alias for walls', () => {
      // coerceCarryRowShape documents this exclusion for owner-gated walls; the
      // narrow wall coercer must not quietly widen it.
      const repairs: CarryArgRepair[] = [];
      const out = coerceWallRowShape({ kind: 'approval' }, 'walls[0]', repairs);
      expect(out).toEqual({ kind: 'approval' });
      expect(repairs).toHaveLength(0);
    });

    it('reports the rename it DID make, so the repair is observable rather than silent', () => {
      const repairs: CarryArgRepair[] = [];
      coerceWallRowShape({ description: 'owner call' }, 'walls[0]', repairs);
      expect(repairs.map((r) => r.field)).toContain('walls[0].description');
    });

    it('keeps a canonical claim when both claim and an alias are supplied', () => {
      const repairs: CarryArgRepair[] = [];
      const out = coerceWallRowShape({ claim: 'canonical', description: 'alias' }, 'walls[0]', repairs);
      expect((out as { claim: string }).claim).toBe('canonical');
    });

    it('passes non-object rows straight through', () => {
      const repairs: CarryArgRepair[] = [];
      expect(coerceWallRowShape('a compact claim', 'walls[0]', repairs)).toBe('a compact claim');
      expect(coerceWallRowShape(null, 'walls[0]', repairs)).toBe(null);
      expect(repairs).toHaveLength(0);
    });
  });

  describe('loop:arm accepts `workItem: null` — the unfixed half of a shared payload (EI-20248542835326817)', () => {
    // loop:arm and loop:checkpoint share a carry payload, and an explicit null is the
    // shape that payload takes for a slot with no value. checkpoint.ts was widened to
    // `.nullish()` for that reason (EI-21719647580242620); arm.ts was left `.optional()`,
    // so a fleet wake-recovery carry that armed with `workItem: null` was refused and the
    // loop never armed at all.
    it('accepts an explicit null workItem', () => {
      const parsed = parseArgs(loopArm, { intervalSec: 120, goal: 'drive the lane', workItem: null });
      expect(parsed.success).toBe(true);
    });

    it('still accepts the canonical string form', () => {
      const parsed = parseArgs(loopArm, { intervalSec: 120, goal: 'drive the lane', workItem: 'WI-2145859' });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { workItem?: string }).workItem).toBe('WI-2145859');
    });

    it('NEGATIVE CONTROL: a non-string, non-null workItem is still refused', () => {
      // Without this the test above passes just as well against a field widened all the
      // way to `z.any()`, which would be a vacuous repair rather than the narrow one made.
      expect(parseArgs(loopArm, { intervalSec: 120, goal: 'g', workItem: 42 }).success).toBe(false);
    });

    it('loop:checkpoint (the other half of the pair) also takes null', () => {
      // Pins the PAIR, not just this file: if either half regresses to `.optional()` the
      // shared-payload case breaks again on whichever tool the carry happens to call.
      // The null must ride ALONGSIDE a real write — a bare `{ workItem: null }` is refused
      // by the object refine that counts writes, which is the OTHER half of the same
      // EI-21719647580242620 repair (a null must not count as a write). Asserting the bare
      // form here would pin that repair backwards.
      expect(parseArgs(loopCheckpoint, { workItem: null, did: 'one unit of work' }).success).toBe(true);
    });

    it('and a null STILL does not count as a write on either tool', () => {
      expect(parseArgs(loopCheckpoint, { workItem: null }).success).toBe(false);
    });
  });

  describe('`value` is a CONDITIONAL claim alias — the {key,value} row shape (EI-21270302136437045)', () => {
    // Two independent filings, one per surface: loop:checkpoint ("the declared checks
    // schema rejects {key,value}") and work_items:checkpoint ("checks.0 and checks.1
    // rejected unrecognized key value"). `key` was already an id alias, so `value` was
    // the only remaining reason the whole write failed.
    it('maps value to claim on a claimless {key,value} row', () => {
      const repairs: CarryArgRepair[] = [];
      const out = coerceCarryRowShape({ key: 'suite', value: 'green on the candidate' }, 'checks[0]', repairs);
      expect(out).toMatchObject({ id: 'suite', claim: 'green on the candidate' });
      expect(repairs.map((r) => r.field)).toContain('checks[0].value');
    });

    it('applies on a walls row too, where the shape is identical', () => {
      const repairs: CarryArgRepair[] = [];
      const out = coerceWallRowShape({ key: 'owner-signoff', value: 'awaiting the owner call' }, 'walls[0]', repairs);
      expect(out).toMatchObject({ id: 'owner-signoff', claim: 'awaiting the owner call' });
    });

    it('THE CONDITION — a row that already has a claim keeps `value` undeclared, so it fails LOUDLY', () => {
      // This is the whole reason `value` is not a seventh entry in CARRY_CLAIM_ALIASES.
      // The resolver DELETES an alias when a canonical claim is present — right for
      // `label`/`text`/`summary`, which say the same thing, and destructive for `value`,
      // which on such a row plainly says something else (often the evidence). Leaving it
      // undeclared means the caller is told, instead of having the data silently dropped.
      const repairs: CarryArgRepair[] = [];
      const out = coerceCarryRowShape({ claim: 'the suite is green', value: 'exit 0' }, 'checks[0]', repairs);
      expect((out as { claim: string }).claim).toBe('the suite is green');
      expect((out as { value?: string }).value).toBe('exit 0');
      // Undeclared on the strict row schema ⇒ the write is refused rather than repaired.
      expect(parseArgs(loopCheckpoint, { checks: [{ claim: 'the suite is green', value: 'exit 0' }] }).success).toBe(
        false,
      );
    });

    it('THE CONDITION, other direction — a real claim alias also suppresses `value`', () => {
      const repairs: CarryArgRepair[] = [];
      const out = coerceCarryRowShape({ summary: 'the real claim', value: 'exit 0' }, 'checks[0]', repairs);
      expect((out as { claim: string }).claim).toBe('the real claim');
      expect((out as { value?: string }).value).toBe('exit 0');
    });

    it('the repaired {key,value} row passes the real loop:checkpoint schema end to end', () => {
      // The coercion runs inside loop:checkpoint's own preprocessor, so this is the
      // assertion that the filed call now succeeds — not just that a helper returns a
      // tidy object.
      const parsed = parseArgs(loopCheckpoint, { checks: [{ key: 'suite', value: 'green on the candidate' }] });
      expect(parsed.success).toBe(true);
    });

    it('NEGATIVE CONTROL: a genuinely unmappable row is still refused', () => {
      expect(parseArgs(loopCheckpoint, { checks: [{ valu: 'typo', whatever: 1 }] }).success).toBe(false);
    });
  });

  describe('every repaired schema still RENDERS to JSON Schema', () => {
    // The blast radius that makes this worth its own guard: `z.toJSONSchema(def.args)`
    // runs at defineTool registration with NO try/catch (limits.ts, work_items/comment.ts),
    // so a single unrepresentable schema does not break one tool — it crashes tools/list
    // for the WHOLE catalog. Widening a field is exactly the edit that can do it, and the
    // damage lands nowhere near the file that caused it.
    const tools: Array<[string, { args: unknown }]> = [
      ['loop:arm', loopArm],
      ['loop:checkpoint', loopCheckpoint],
      ['loop:status', loopStatus],
      ['loop:end', loopEnd],
    ];

    for (const [name, tool] of tools) {
      it(`${name} renders without throwing`, () => {
        expect(() => renderToJSONSchema(tool.args)).not.toThrow();
      });
    }

    it('the widened loop:arm workItem is PUBLISHED as nullable, not merely tolerated server-side', () => {
      // A client validates the published schema before the server ever sees the call, so a
      // repair that lives only in the parser still reports invalid_args to the caller —
      // the EI-21575304064818009 precedent that put `description`/`key` in the walls row.
      const rendered = renderToJSONSchema(loopArm.args);
      const workItem = rendered.properties?.workItem as { anyOf?: Array<{ type?: string }> } | undefined;
      expect(workItem).toBeDefined();
      // The assertion has to be this specific to mean anything: `.optional()` renders a
      // bare `{ type: 'string' }` and is ALSO absent from `required`, so a
      // presence-and-not-required check passes just as well against the unrepaired field.
      // Only the published `null` branch distinguishes the two, and it is what a
      // client-side validator reads before the server is ever reached.
      expect(workItem?.anyOf?.map((b) => b.type)).toEqual(expect.arrayContaining(['string', 'null']));
      // Never required — a null must be as acceptable as an omission.
      expect(rendered.required ?? []).not.toContain('workItem');
    });

    it('CONTROL: the same assertion FAILS against a deliberately unrepaired `.optional()` field', () => {
      // Falsifiability, proven without mutating the shared tree — the tier the repo's
      // mutation-probe guidance prescribes for a subject you `import` rather than read
      // from a path. Measured: `.optional()` renders `{type:'string',maxLength:120}` with
      // NO `anyOf` at all, while `.nullish()` renders the two-branch union asserted above.
      // If this control ever passes, the assertion above has stopped discriminating and is
      // silently vacuous — which is the failure mode a guard cannot report about itself.
      const unrepaired = z.toJSONSchema(z.object({ workItem: z.string().max(120).optional() })) as {
        properties?: { workItem?: { anyOf?: Array<{ type?: string }> } };
      };
      expect(unrepaired.properties?.workItem?.anyOf).toBeUndefined();
    });
  });
});
