// @vitest-environment node
/**
 * psu-pty-host-classifier-fixtures.test.ts — P-010: every REGISTERED turn-row
 * classifier, exercised against a REAL captured transcript.
 *
 * WHY A REAL TRANSCRIPT AND NOT A MOCK
 * ------------------------------------
 * D-003 is the reason this file exists. Porting codex's "a user row resets the
 * latch" rule to claude is the obvious move and it is silently wrong: Claude
 * Code writes TOOL RESULTS as `type:'user'` rows (measured: 449 of 489 user
 * rows on one real 3,071-row session), so the naive port resets the latch once
 * per tool call and native turn verification returns false FOREVER. Nothing
 * throws. A hand-written mock authored by someone holding that belief would
 * have encoded the belief and passed.
 *
 * So the fixtures are captured from real on-disk transcripts by
 * `scripts/capture-turn-classifier-fixtures.mjs`, which drops every field the
 * classifier does not read (no prompts, no tool arguments, no file contents)
 * and PROVES at capture time that sanitizing did not change any row's verdict.
 *
 * WHAT MAKES THIS TEST FALSIFIABLE
 * --------------------------------
 * Per the repo's falsifiability guidance for a module you `import`: two
 * deliberately-WRONG implementations live permanently in this file as controls,
 * alongside the real classifiers. Each is a mistake a competent engineer would
 * plausibly make. If a control ever agrees with the real classifier, the
 * fixture has stopped discriminating and the suite says so — instead of
 * reporting a comfortable green over a fixture that cannot fail.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TURN_ROW_CLASSIFIERS, nativeTurnCompletedInTranscript } from '../scripts/psu-pty-host.mjs';

/**
 * Overridable ON PURPOSE. Pointing the fixture directory at a copy is what
 * makes `scripts/mutation-probe.sh`'s copy-out tier usable against this suite:
 * falsifiability can then be proven by mutating a COPY outside the tree,
 * instead of mutating a tracked file on a shared checkout that git-sync sweeps
 * into a commit every few minutes. Defaults to the real fixtures.
 */
const FIXTURE_DIR = process.env.PSU_PTY_CLASSIFIER_FIXTURE_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'turn-transcripts');

type Verdict = 'ignore' | 'turn-started' | 'turn-completed';
type Ctx = { receivedAtMs: number; nowMs: number };
type Classifier = (row: unknown, ctx: Ctx) => Verdict;

/**
 * The host's latch loop, mirrored exactly (psu-pty-host.mjs,
 * nativeTurnCompletedInTranscript): a completion latches true, a turn-start
 * clears it, and 'ignore' leaves it alone. The three-valued contract is the
 * whole point — several row kinds legitimately occur AFTER the final
 * completion, and a boolean contract would discard a true completion.
 */
function replay(classify: Classifier, rows: unknown[], ctx: Ctx): boolean {
  let completed = false;
  for (const row of rows) {
    const verdict = classify(row, ctx);
    if (verdict === 'turn-completed') completed = true;
    else if (verdict === 'turn-started') completed = false;
  }
  return completed;
}

function loadFixture(agent: string): { rows: unknown[]; meta: Record<string, unknown> } {
  const rows = readFileSync(join(FIXTURE_DIR, `${agent}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
  const meta = JSON.parse(readFileSync(join(FIXTURE_DIR, `${agent}.meta.json`), 'utf8')) as Record<string, unknown>;
  return { rows, meta };
}

/** Fence the replay inside the captured window's own real timestamps. */
function contextFor(rows: unknown[]): Ctx {
  const stamps = rows
    .map((row) => Date.parse((row as { timestamp?: string })?.timestamp ?? ''))
    .filter((n) => Number.isFinite(n));
  return { receivedAtMs: Math.min(...stamps), nowMs: Math.max(...stamps) + 1 };
}

// ---------------------------------------------------------------------------
// Permanently-wrong control implementations. NEVER "fix" these to match the
// real classifiers — they are the instrument that proves the fixture can fail.
// ---------------------------------------------------------------------------

/**
 * CONTROL 1 (claude-specific, D-003): the naive port of codex's reset rule,
 * where EVERY `type:'user'` row is treated as a fresh turn start. This is the
 * bug the decision was written to prevent.
 */
const naiveCodexPortToClaude: Classifier = (row, ctx) => {
  const r = row as { type?: string; message?: { stop_reason?: string }; timestamp?: string; uuid?: string };
  if (r?.type === 'user') return 'turn-started';
  if (r?.type !== 'assistant') return 'ignore';
  if (r.message?.stop_reason !== 'end_turn') return 'ignore';
  const at = Date.parse(r.timestamp ?? '');
  const ok = Number.isFinite(at) && at >= ctx.receivedAtMs && at <= ctx.nowMs
    && typeof r.uuid === 'string' && r.uuid.length > 0;
  return ok ? 'turn-completed' : 'turn-started';
};

/**
 * CONTROL 2 (both backends): a fence-LESS classifier that accepts any
 * completion-shaped row regardless of whether it happened after the inject was
 * received. This is the "it says task_complete, ship it" mistake — and it is
 * the dangerous direction, because it releases an inject on a STALE completion
 * from a previous turn.
 */
function fencelessFor(agent: string): Classifier {
  return (row) => {
    const r = row as { type?: string; payload?: { type?: string }; message?: { role?: string; stopReason?: string; stop_reason?: string } };
    if (agent === 'codex') {
      if (r?.type !== 'event_msg') return 'ignore';
      if (r.payload?.type === 'task_complete' || r.payload?.type === 'turn_completed') return 'turn-completed';
      if (['task_started', 'user_message', 'turn_aborted'].includes(r.payload?.type ?? '')) return 'turn-started';
      return 'ignore';
    }
    if (agent === 'omp' && r?.type === 'message' && r.message?.role === 'assistant'
      && r.message.stopReason && !['tooluse', 'tool_use', 'tool_calls'].includes(r.message.stopReason.toLowerCase())) return 'turn-completed';
    if (r?.type === 'assistant' && r.message?.stop_reason === 'end_turn') return 'turn-completed';
    return 'ignore';
  };
}

/** Per-agent proof that the captured window still exercises the real trap. */
const DISCRIMINATORS: Record<string, { describe: string; count: (rows: unknown[]) => number }> = {
  omp: {
    describe: 'native toolResult messages',
    count: rows => rows.filter(row => (row as { message?: { role?: string } })?.message?.role === 'toolResult').length,
  },
  claude: {
    describe: "type:'user' rows carrying a tool_result block (the D-003 trap)",
    count: (rows) => rows.filter((row) => {
      const r = row as { type?: string; isMeta?: boolean; message?: { content?: { type?: string }[] } };
      return r?.type === 'user' && !r.isMeta && Array.isArray(r.message?.content)
        && r.message.content.some((b) => b?.type === 'tool_result');
    }).length,
  },
  codex: {
    describe: 'ignorable event_msg rows between the turn start and the completion',
    count: (rows) => rows.filter((row) => {
      const r = row as { type?: string; payload?: { type?: string } };
      return r?.type === 'event_msg'
        && !['task_started', 'user_message', 'turn_aborted', 'task_complete', 'turn_completed']
          .includes(r.payload?.type ?? '');
    }).length,
  },
};

const REGISTERED = Object.keys(TURN_ROW_CLASSIFIERS as Record<string, Classifier>).sort();

describe('registered turn-row classifiers vs real captured transcripts (P-010)', () => {
  it('registers at least one classifier, so the suite below is not vacuously empty', () => {
    expect(REGISTERED.length).toBeGreaterThan(0);
  });

  /**
   * The enumerating guard. This is the durable half of the item: a third
   * backend added to TURN_ROW_CLASSIFIERS without a captured transcript fails
   * HERE, at the moment it is registered, rather than shipping unverified and
   * failing silently forever in production.
   */
  it('has a captured fixture for EVERY registered classifier, and no orphan fixtures', () => {
    const missing = REGISTERED.filter((agent) => !existsSync(join(FIXTURE_DIR, `${agent}.jsonl`)));
    expect(
      missing,
      `Registered classifier(s) with no captured transcript: ${missing.join(', ')}. `
      + 'Capture one with scripts/capture-turn-classifier-fixtures.mjs — do not hand-write it.',
    ).toEqual([]);

    const onDisk = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''))
      .sort();
    expect(
      onDisk,
      'Fixture set and classifier registry disagree — a fixture outlived its classifier, or one is missing.',
    ).toEqual(REGISTERED);
  });

  it.each(REGISTERED)('every registered agent has a discriminator defined: %s', (agent) => {
    expect(
      DISCRIMINATORS[agent],
      `No discriminator defined for '${agent}'. Without one its fixture could go vacuous unnoticed.`,
    ).toBeDefined();
  });

  describe.each(REGISTERED)('%s', (agent) => {
    const classify = (TURN_ROW_CLASSIFIERS as Record<string, Classifier>)[agent];
    const { rows, meta } = loadFixture(agent);
    const ctx = contextFor(rows);

    it('fixture provenance matches the fixture actually on disk', () => {
      // Guards a hand-edit: if someone trims the .jsonl, its recorded capture
      // count no longer matches and the drift is reported instead of trusted.
      expect(meta.agent).toBe(agent);
      expect(meta.capturedRowCount).toBe(rows.length);
      expect(meta.generator).toBe('scripts/capture-turn-classifier-fixtures.mjs');
    });

    it('is still DISCRIMINATING — the fixture has not gone vacuous', () => {
      const found = DISCRIMINATORS[agent].count(rows);
      expect(
        found,
        `Captured window contains no ${DISCRIMINATORS[agent].describe}. `
        + 'The controls below would then agree with the real classifier and this suite would pass '
        + 'without testing anything. Re-capture from a transcript with real activity.',
      ).toBeGreaterThan(0);
    });

    it('recognises the real completed turn', () => {
      expect(replay(classify, rows, ctx)).toBe(true);
    });

    it('refuses a completion that predates the inject (the freshness fence is live)', () => {
      const stale: Ctx = { receivedAtMs: ctx.nowMs + 1_000, nowMs: ctx.nowMs + 2_000 };
      expect(replay(classify, rows, stale)).toBe(false);
    });

    it('CONTROL: a fence-less classifier disagrees on the stale-inject case', () => {
      const stale: Ctx = { receivedAtMs: ctx.nowMs + 1_000, nowMs: ctx.nowMs + 2_000 };
      // The real classifier refuses; the fenceless one would release the inject
      // on a completion from a previous turn. Disagreement here is what proves
      // the fence is load-bearing rather than decorative.
      expect(replay(fencelessFor(agent), rows, stale)).toBe(true);
      expect(replay(classify, rows, stale)).toBe(false);
    });
  });

  /**
   * D-003 / D-009. Read D-009 before changing anything here.
   *
   * The original form of this block asserted that the naive codex port "can
   * never latch a completion" on a real transcript. It FAILED against real
   * data, which is how D-003's overstated consequence was caught: Claude Code
   * always writes `end_turn` AFTER the final tool_result, so every spurious
   * reset the naive port performs is immediately overwritten. Measured over the
   * source transcript: 3,066 poll points, ONE divergence (0.03%), and that one
   * is the isMeta branch — not the tool_result branch D-003 named.
   *
   * So the assertions below are deliberately per-ROW rather than per-replay.
   * The row level is where the two implementations genuinely disagree, and a
   * per-replay assertion here would be asserting something false.
   */
  describe('claude — D-003 carve-outs, scoped per D-009', () => {
    const { rows } = loadFixture('claude');
    const ctx = contextFor(rows);
    const claude = TURN_ROW_CLASSIFIERS.claude as Classifier;

    it('disagrees with the naive port on EVERY captured tool_result row', () => {
      const toolResultRows = rows.filter((row) => {
        const r = row as { type?: string; isMeta?: boolean; message?: { content?: { type?: string }[] } };
        return r?.type === 'user' && !r.isMeta && Array.isArray(r.message?.content)
          && r.message.content.some((b) => b?.type === 'tool_result');
      });
      expect(toolResultRows.length).toBeGreaterThan(0);
      for (const row of toolResultRows) {
        expect(claude(row, ctx)).toBe('ignore');
        expect(naiveCodexPortToClaude(row, ctx)).toBe('turn-started');
      }
    });

    it('ignores a meta user row — the carve-out that measurably changes the verdict', () => {
      // D-009: this, not tool_result, produced the single real divergence
      // across 3,066 poll points on the source transcript.
      const meta = { type: 'user', isMeta: true, message: { content: [{ type: 'text' }] } };
      expect(claude(meta, ctx)).toBe('ignore');
      expect(naiveCodexPortToClaude(meta, ctx)).toBe('turn-started');
    });

    it('treats a tool_result user row as ignorable and a real user row as a turn start', () => {
      const toolResult = { type: 'user', message: { content: [{ type: 'tool_result' }] } };
      const realTurn = { type: 'user', message: { content: [{ type: 'text' }] } };
      expect(claude(toolResult, ctx)).toBe('ignore');
      expect(claude(realTurn, ctx)).toBe('turn-started');
    });

    /**
     * The ordering that WOULD break the naive port. D-009 measured it as absent
     * from today's transcripts (zero occurrences in 3,071 rows), so this is
     * explicitly a constructed sequence guarding a plausible future ordering —
     * a backgrounded tool landing its result after the turn's final message.
     * Labelled as constructed so nobody later mistakes it for captured data.
     */
    it('survives a tool_result arriving AFTER the completion (constructed; absent from real data today)', () => {
      const completion = rows.find((row) => {
        const r = row as { type?: string; message?: { stop_reason?: string } };
        return r?.type === 'assistant' && r.message?.stop_reason === 'end_turn';
      });
      expect(completion).toBeDefined();
      const lateToolResult = { type: 'user', message: { content: [{ type: 'tool_result' }] } };
      const sequence = [completion, lateToolResult];

      expect(replay(claude, sequence, ctx)).toBe(true);
      // The naive port discards the true completion in exactly this case.
      expect(replay(naiveCodexPortToClaude, sequence, ctx)).toBe(false);
    });
  });
});

/**
 * END-TO-END through the host's REAL entry point (R-2 / P-001, P-002).
 *
 * Everything above replays a MIRROR of the host's latch loop, calling the
 * registered classifier directly. That leaves the host's own dispatch
 * unexercised: a mutation probe that replaced
 * `TURN_ROW_CLASSIFIERS[agent]` inside nativeTurnCompletedInTranscript with a
 * hardcoded codex classifier SURVIVED this whole suite (2026-09-22). This block
 * closes that gap by driving nativeTurnCompletedInTranscript itself, per
 * registered backend, over its captured transcript placed inside a throwaway
 * ISOLATED root (D-002 — never the shared native root).
 */
describe('nativeTurnCompletedInTranscript dispatches through the registry (R-2)', () => {
  /** Transcript subdirectory beneath each backend's isolated root, per the host. */
  const ISOLATED_LAYOUT: Record<string, { envKey: string; subdir: string }> = {
    claude: { envKey: 'CLAUDE_CONFIG_DIR', subdir: 'projects' },
    codex: { envKey: 'CODEX_HOME', subdir: 'sessions' },
    omp: { envKey: 'PI_CONFIG_DIR', subdir: 'agent/sessions' },
  };

  it.each(REGISTERED)('every registered agent has an isolated-root layout defined: %s', (agent) => {
    expect(
      ISOLATED_LAYOUT[agent],
      `No isolated-root layout for '${agent}' — add it so the end-to-end dispatch below covers it.`,
    ).toBeDefined();
  });

  it('CONTROL: each captured transcript is backend-specific — a foreign classifier does not certify it', () => {
    // Without this, the end-to-end assertion could pass even if the host used the
    // WRONG backend's classifier, because both might happen to latch true.
    const classifiers = TURN_ROW_CLASSIFIERS as Record<string, Classifier>;
    for (const agent of REGISTERED) {
      const { rows } = loadFixture(agent);
      const ctx = contextFor(rows);
      for (const other of REGISTERED.filter((a) => a !== agent)) {
        expect(replay(classifiers[other], rows, ctx), `${other} classifier certified the ${agent} fixture`).toBe(false);
      }
    }
  });

  it.each(REGISTERED)('recognises the real completed %s turn via the host entry point', (agent) => {
    const layout = ISOLATED_LAYOUT[agent];
    const { rows } = loadFixture(agent);
    const ctx = contextFor(rows);
    const root = mkdtempSync(join(tmpdir(), `psu-pty-e2e-${agent}-`));
    try {
      const dir = join(root, layout.subdir, 'session');
      mkdirSync(dir, { recursive: true });
      const transcriptPath = join(dir, 'transcript.jsonl');
      writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      const env = { [layout.envKey]: root };
      expect(
        nativeTurnCompletedInTranscript({ agent, env, transcriptPath, receivedAtMs: ctx.receivedAtMs, nowMs: ctx.nowMs }),
      ).toBe(true);
      // The freshness fence is honoured end-to-end too, not only in the mirror.
      expect(
        nativeTurnCompletedInTranscript({
          agent, env, transcriptPath, receivedAtMs: ctx.nowMs + 1_000, nowMs: ctx.nowMs + 2_000,
        }),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
