/**
 * no-raw-goal-holder-read-guard.test.ts — the goal-holder CI guard's detection
 * predicate (goal-live-holder-guarantee-2026-08-18, P-001 / D-003).
 *
 * The guard (`scripts/check-no-raw-goal-holder-read.mjs`) runs green on the clean
 * tree, which only exercises the no-false-positive direction. A guard nobody has
 * ever seen FAIL is not a guard, so this locks the direction D-003 actually asks
 * for: that it FLAGS a NEW raw "who holds this goal" read which skips the
 * liveness fold, while NOT flagging owner-keyed mode reads, sanctioned call
 * sites, or prose.
 *
 * Why it matters: a goal-mode row OUTLIVES the session that wrote it and nothing
 * clears it on death, so `WHERE mode='goal' AND subject=$1` keeps naming a
 * holder forever. Measured 2026-08-16: 4 of 6 active goals dark 2–5 days while
 * every count-based surface called them held. Measured 2026-08-18: the Blender's
 * steward gone six days, still named. The fold that fixes this was never hard to
 * WRITE — it was easy to FORGET, and forgetting it fails nothing. A behaviour
 * test cannot observe a call site that never calls the module under test; that
 * is the gap this guard closes and this test verifies.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only. Kept on ONE line: @ts-ignore suppresses the NEXT LINE only, and tsc reports TS7016 on the `from` clause, so a wrapped import silently escapes the suppression.
// prettier-ignore
import { readsRawGoalHolder, readsGoalStarterAsHolder, ALLOWLIST, STARTER_READ_ALLOWLIST, BASELINE, isExcluded } from '../../../../scripts/check-no-raw-goal-holder-read.mjs';

describe('no-raw-goal-holder-read guard predicate (P-001 / D-003)', () => {
  describe('FLAGS a bypassing read — the direction the guard exists for', () => {
    it('flags the exact shape that shipped the bug: mode + subject, no fold', () => {
      expect(
        readsRawGoalHolder(
          "const rows = await sql`SELECT owner_id FROM harness_shared.agent_modes " +
            "WHERE mode = 'goal' AND subject = ${goalId}`;",
        ),
      ).toBe(true);
    });

    it('flags a COUNT over holder rows — the "1 holder, therefore staffed" read', () => {
      expect(
        readsRawGoalHolder(
          "await sql`SELECT count(*) FROM harness_shared.agent_modes " +
            "WHERE mode='goal' AND subject IS NOT NULL`;",
        ),
      ).toBe(true);
    });

    /**
     * Both spellings of the mode filter are live in the tree today. A guard that
     * saw only the string literal would be defeated by importing the constant —
     * an entirely natural refactor, which is what makes it a realistic bypass
     * rather than a contrived one.
     */
    it('flags the GOAL_MODE constant form, not just the string literal', () => {
      expect(
        readsRawGoalHolder(
          'await sql`SELECT m.owner_id FROM harness_shared.agent_modes m ' +
            'WHERE m.mode = ${GOAL_MODE} AND m.subject = ${goalId}`;',
        ),
      ).toBe(true);
    });

    it('flags a JOIN form — goals joined to their holder rows', () => {
      expect(
        readsRawGoalHolder(
          'await sql`SELECT g.id FROM harness_shared.goals g ' +
            "JOIN harness_shared.agent_modes m ON m.subject = g.id AND m.mode = 'goal'`;",
        ),
      ).toBe(true);
    });

    it('flags a MULTI-LINE query — a reformat must not defeat it', () => {
      expect(
        readsRawGoalHolder(
          'await sql`\n  SELECT owner_id\n    FROM harness_shared.agent_modes\n' +
            "   WHERE mode = 'goal'\n     AND subject = ${goalId}\n`;",
        ),
      ).toBe(true);
    });
  });

  describe('does NOT flag — the false-positive direction', () => {
    /**
     * The inverse question. "What modes does THIS session carry" is owner-keyed
     * and legitimate: the session asking is trivially live, because it is
     * executing. Flagging it would push every mode read through a liveness fold
     * that answers nothing, and the resulting noise is how a guard gets
     * allowlisted into uselessness.
     */
    it('does not flag an OWNER-keyed mode read with no subject filter', () => {
      expect(
        readsRawGoalHolder(
          'await sql`SELECT owner_id, mode, subject FROM harness_shared.agent_modes ' +
            'WHERE workspace_id = ${ws} AND owner_id = ANY(${ownerIds})`;',
        ),
      ).toBe(false);
    });

    it('does not flag a non-goal mode axis', () => {
      expect(
        readsRawGoalHolder(
          "await sql`SELECT subject FROM harness_shared.agent_modes WHERE mode = 'auto'`;",
        ),
      ).toBe(false);
    });

    it('does not flag a raw read that DOES fold liveness — the property enforced', () => {
      expect(
        readsRawGoalHolder(
          "const rows = await sql`SELECT owner_id FROM harness_shared.agent_modes " +
            "WHERE mode = 'goal' AND subject = ${goalId}`;\n" +
            'const verdicts = await resolveHolderLiveness(rows.map((r) => r.owner_id));',
        ),
      ).toBe(false);
    });

    it('is cleared by ANY holder-module entry point', () => {
      const raw =
        "await sql`SELECT owner_id FROM harness_shared.agent_modes WHERE mode='goal' AND subject=${g}`;\n";
      for (const entry of [
        'resolveGoalHolders(sql, { workspaceId, goalId })',
        'readGoalHolderRows(sql)',
        'resolveGoalHoldersFromRows(goalId, ws, rows, verdicts)',
        'resolveGoalHoldersBatch(sql, goals)',
        'holderCountsAsAlive(v)',
      ]) {
        expect(readsRawGoalHolder(raw + entry)).toBe(false);
      }
    });

    /**
     * Prose about goal holders is everywhere in this codebase — including in the
     * guard's own docblock and in the module it points at. A guard that flagged
     * its own explanation would be unusable.
     */
    it('does not flag PROSE — comments are stripped first', () => {
      expect(
        readsRawGoalHolder(
          "// A goal's holder is a harness_shared.agent_modes row (mode = 'goal', subject=<id>),\n" +
            '// which outlives the session that wrote it.\n' +
            'const x = 1;',
        ),
      ).toBe(false);
      expect(
        readsRawGoalHolder(
          "/* harness_shared.agent_modes with mode = 'goal' and a subject is the holder shape. */\n" +
            'export const y = 2;',
        ),
      ).toBe(false);
    });

    it('does not flag the bare table name in prose without the schema qualifier', () => {
      expect(
        readsRawGoalHolder("const q = `SELECT * FROM agent_modes WHERE mode='goal' AND subject=$1`;"),
      ).toBe(false);
    });
  });

  describe('scan configuration', () => {
    /**
     * BASELINE must stay EMPTY. The tree was clean when this guard landed, so a
     * hit is always a genuine new bypass — and a baseline that can grow is a
     * ratchet pointing the wrong way: it turns "fix the call site" into "add a
     * line", which is exactly how the fold went missing from four surfaces in
     * the first place.
     */
    it('BASELINE is empty and must stay empty — shrink-only, no grandfathered debt', () => {
      expect([...BASELINE]).toEqual([]);
    });

    /**
     * Every allowlist entry is a claim that liveness is IRRELEVANT to that
     * file's question — not that the fold was inconvenient there. Pinning the
     * set means a new entry is a deliberate, reviewable act rather than a quiet
     * append.
     *
     * `holder-authority.ts` is the one entry that arrived by a module SPLIT
     * rather than by a new call site: it is the authority half of the canonical
     * holder subsystem, carved out of holder.ts because compact control-context
     * construction sits on the agent-MCP bootstrap path and importing the full
     * liveness graph there cycles. It is therefore the same category as the
     * holder.ts entry beside it — the module others route THROUGH, not a
     * consumer routing around it — which is exactly the case holder.ts's own
     * comment anticipates when it says renaming the exports must not turn the
     * module into its own first offender.
     *
     * Unlike holder.ts and modes/store.ts it is LOAD-BEARING: the predicate
     * genuinely fires on it. It fires because the `elected` CTE self-joins on
     * `subject` to run the lease-epoch election, even though the read is
     * OWNER-keyed on `owner_id` — the trivially-live direction the
     * false-positive block above declines to flag. And its risk points the
     * other way from the bug this guard exists for: it decides whether the CALLING
     * session may act, so a dead elected holder yields 'superseded' and REFUSES
     * authority. Folding liveness in would widen authority, never narrow it; it
     * can never produce the "1 holder, therefore staffed" claim over a dark
     * session. Succession here is governed by goal_lease_epoch and handoff
     * expiry, which is why liveness is irrelevant to its question.
     *
     * `agent-run-evidence-record.ts` labels a PAST agent-run window with the goal
     * its holder was pursuing then (owner-keyed reverse lookup). The run is over,
     * so its holder is usually gone by design; folding present-tense liveness in
     * would erase the goal link from exactly the records it exists to label. It
     * never answers "who holds goal X now" (WI-10003582).
     */
    it('ALLOWLIST holds only the eight files with a written reason', () => {
      expect([...ALLOWLIST].sort()).toEqual(
        [
          'packages/agent-mcp/src/tools/goals/create.ts',
          'packages/operator-core/lib/agent-tools/scorecards/agent-run-evidence-record.ts',
          'packages/operator-core/lib/goals/holder-authority.ts',
          'packages/operator-core/lib/goals/holder.ts',
          'packages/operator-core/lib/goals/spend-rollup.ts',
          'packages/operator-core/lib/modes/store.ts',
          'packages/operator-core/lib/projected-tool-deps.ts',
          'packages/operator-core/lib/system-health/goal-edit-claim-watchdog.ts',
        ].sort(),
      );
    });

    it('excludes tests, vendored trees, and SQL migration copies', () => {
      expect(isExcluded('packages/operator-core/lib/goals/holder.test.ts')).toBe(true);
      expect(isExcluded('node_modules/x/index.ts')).toBe(true);
      expect(isExcluded('papercusp-desktop/src-tauri/sidecar/db-sql/500-agent-modes.sql')).toBe(true);
      expect(isExcluded('packages/operator-core/lib/goals/holder.ts')).toBe(false);
    });
  });
});

/**
 * The second tell (plan goal-holder-plans-ideation-truthful-reports-2026-10-03 P-006,
 * D-003). `goals.metadata.agentOwnerId` names the agent that STARTED a goal; lease
 * succession never updates it. Measured 2026-10-03 02:50Z it named su-6aab097a while
 * su-9e72a11f held lease epoch 18, so any reader treating it as the holder is wrong.
 */
describe('no-raw-goal-holder-read guard: goal STARTER read as holder (P-006 / D-003)', () => {
  describe('FLAGS a starter read', () => {
    it('flags the exact shape findGoal shipped with: metadata ->> agentOwnerId = holder', () => {
      expect(
        readsGoalStarterAsHolder(
          'await sql`SELECT id FROM harness_shared.goals WHERE workspace_id = ${ws} ' +
            "AND metadata ->> 'agentOwnerId' = ${holder}`;",
        ),
      ).toBe(true);
    });

    it('flags the unspaced, single-arrow, path and alias forms', () => {
      for (const read of [
        "metadata->>'agentOwnerId'",
        "metadata -> 'agentOwnerId'",
        "g.metadata #>> '{agentOwnerId}'",
        "g.metadata->>'agentOwnerId' AS holder",
      ]) {
        expect(readsGoalStarterAsHolder(`await sql\`SELECT ${read} FROM harness_shared.goals g\`;`)).toBe(true);
      }
    });

    it('flags a JSON containment test on the key', () => {
      expect(
        readsGoalStarterAsHolder(
          'await sql`SELECT id FROM harness_shared.goals ' +
            'WHERE metadata @> ${JSON.stringify({ agentOwnerId: holder })}::jsonb`;',
        ),
      ).toBe(true);
    });
  });

  describe('does NOT flag', () => {
    it('does not flag a WRITER of the key (goals/start.ts stamps it once)', () => {
      expect(
        readsGoalStarterAsHolder(
          "await sql`UPDATE harness_shared.goals SET metadata = jsonb_set(metadata, '{agentOwnerId}', ${owner}) WHERE id = ${id}`;",
        ),
      ).toBe(false);
      expect(
        readsGoalStarterAsHolder(
          'await sql`UPDATE harness_shared.goals SET metadata = metadata || ${JSON.stringify({ agentOwnerId: owner })}::jsonb`;',
        ),
      ).toBe(false);
    });

    it('does not flag the key on a table other than goals', () => {
      expect(
        readsGoalStarterAsHolder("await sql`SELECT metadata ->> 'agentOwnerId' FROM harness_shared.goals_archive`;"),
      ).toBe(false);
      expect(readsGoalStarterAsHolder("const owner = mailbox.metadata?.agentOwnerId ?? null;")).toBe(false);
    });

    it('does not flag PROSE — comments are stripped first', () => {
      expect(
        readsGoalStarterAsHolder(
          "// harness_shared.goals metadata ->> 'agentOwnerId' names the starter, not the holder.\nconst x = 1;",
        ),
      ).toBe(false);
    });
  });

  describe('scan configuration', () => {
    it('STARTER_READ_ALLOWLIST holds only the two "who started it" readers', () => {
      expect([...STARTER_READ_ALLOWLIST].sort()).toEqual(
        [
          'packages/operator-core/lib/agent-tools/scorecards/agent-run-evidence-record.ts',
          'packages/operator-core/lib/system-health/goal-liveness-watchdog.ts',
        ].sort(),
      );
    });

    /**
     * An allowlist entry that no longer matches is a silent exemption for whatever
     * that file reads next. Each entry must still be load-bearing on the real tree.
     */
    it('every STARTER_READ_ALLOWLIST entry still triggers the predicate on the live file', () => {
      for (const f of STARTER_READ_ALLOWLIST as Set<string>) {
        const text = readFileSync(new URL(`../../../../${f}`, import.meta.url), 'utf8');
        expect(readsGoalStarterAsHolder(text), f).toBe(true);
      }
    });
  });
});
