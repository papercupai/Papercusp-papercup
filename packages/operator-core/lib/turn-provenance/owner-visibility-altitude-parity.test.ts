/**
 * owner-visibility-altitude-parity.test.ts — the two owner-visibility altitudes
 * must answer "did the owner author this turn?" the SAME way.
 *
 * ── The defect this exists to prevent (P-005) ────────────────────────────────
 *
 * "Is this the owner's own words?" is asked at two altitudes over the SAME
 * population of `user`-role transcript rows:
 *
 *   • the OWNER'S CHAT PANE  — `ownerVisiblePromptText` (agent-tools/coordination)
 *   • the OWNER'S MEMORY     — `isHumanTurn`            (memory/human-turn-tail)
 *
 * They were written independently, each grew its own pattern list, and nothing
 * forced them to agree. MEASURED 2026-08-11 over the 20,000 most recent user
 * turns, they disagreed in BOTH directions at once:
 *
 *   • 529 rows the curated catalogue recognises were fed to memory as the
 *     owner's words (the memory altitude never called the catalogue at all);
 *   • 60 rows the memory altitude knew were machine were rendered in the chat
 *     pane as things the owner had said (`Base directory for this skill:` ×35,
 *     `⚠ MCP transport auto-heal` ×25).
 *
 * Both leaks are the SAME defect — a shared question with no shared definition
 * — which is why fixing one altitude has twice failed to fix the other. This
 * test is the mechanism that makes a future divergence fail loudly instead of
 * being rediscovered by measurement months later.
 *
 * ── Why parity is asserted, not implementation-sharing ───────────────────────
 *
 * The two surfaces legitimately differ BELOW the verdict: the chat pane returns
 * display text and the memory path returns a boolean, and the pane deliberately
 * SHOWS one origin (`coord-inject:owner`) that is the owner speaking through a
 * machine seam. So they cannot be one function. What they must never do is
 * disagree about whether a given turn is the owner's — that is the invariant.
 */

import { describe, expect, it } from 'vitest';

import { isHumanTurn } from '../memory/human-turn-tail';
import { ownerVisiblePromptText } from '../agent-tools/coordination/owner-chat-turn';
import { CLASSIFY_HEAD_CHARS, MACHINE_SURFACE_PATTERNS } from './machine-surface-catalogue';

/**
 * One exemplar per curated machine shape. Each MUST be recognised as machine by
 * BOTH altitudes.
 *
 * Kept as literal transcript text rather than generated from the patterns: a
 * corpus derived from the very regexes under test can only ever confirm itself
 * (the mistake the catalogue's own header warns about).
 */
const MACHINE_TURNS: ReadonlyArray<readonly [label: string, text: string]> = [
  ['compaction preamble', 'This session is being continued from a previous conversation that ran out of context.'],
  ['system notification', '[ SYSTEM NOTIFICATION - NOT USER INPUT ] Background task finished.'],
  ['task notification', '<task-notification>\n<task-id>abc</task-id>\n</task-notification>'],
  ['interrupt marker', '[Request interrupted by user for tool use]'],
  ['machine self-compaction', '/compact ⟦machine-issued self-compaction — not owner-typed⟧ focus on the plan'],
  ['compaction status line', '✻ Conversation compacted to 12,000 tokens'],
  ['codex AGENTS.md wrapper', '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nbe helpful\n</INSTRUCTIONS>'],
  ['codex plugin preamble', '<recommended_plugins>\nHere is a list of plugins\n</recommended_plugins>'],
  ['codex Stop-hook response wrapper', '<hook_prompt hook_run_id=stop:22:/tmp/hooks.json>\nStop context'],
  ['synthetic command wrapper', '<command-name>/clear</command-name>\n<command-message>clear</command-message>'],
  // ── The three migrated in P-005; each was a measured chat-pane leak. ──
  ['stop-hook wall', 'Stop hook feedback: This turn ends by handing the next move back to the owner.'],
  ['mcp auto-heal advisory', '⚠ MCP transport auto-heal (mcp-dark-watchdog): your MCP server was restarted.'],
  ['skill-loader preamble', 'Base directory for this skill: /tmp/claude-1000/bundled-skills/2.1.228'],
  ['claude usage reset', 'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.'],
  ['torn nonce event wake', '0d55a713f50015a⟧\n[await-event] coord:inbox-wake:su-a20d fired — continue the work'],
  ['claude cross-session message', 'Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1000/cc-socks/957123.sock" from-name="papercusp-86" from-mode="bypass">\nConfirmed.\n</cross-session-message>'],
  ['Papercusp peer recovery diagnostic', '[peer:su-4a84c93a-e530-450c-b01e-8beb7bdc670f] Parent recovery diagnostic under existing EI-26842368936683990.'],
];

/**
 * CALIBRATION. Real owner speech that must survive BOTH altitudes.
 *
 * Without these the parity assertion above is satisfiable by a classifier that
 * simply calls everything machine — which is the failure direction that loses
 * the human's words permanently. The last two entries are the ones that matter:
 * an owner QUOTING a machine marker mid-sentence keeps their turn, because every
 * catalogue pattern is head-anchored and head-bounded.
 */
const OWNER_TURNS: ReadonlyArray<readonly [label: string, text: string]> = [
  ['plain instruction', 'put yourself on auto mode and continue where you left off'],
  ['short reply', 'yes do that'],
  ['pasted markdown', '# my notes\n\n- fix the gate\n- ship it'],
  ['quotes a machine marker mid-sentence', 'why does my transcript keep saying "This session is being continued from a previous conversation"? it is annoying'],
  ['quotes a migrated marker mid-sentence', 'the agent printed Base directory for this skill: and I have no idea what that means'],
  ['quotes a Codex Stop-hook wrapper mid-sentence', 'Why did my transcript include <hook_prompt hook_run_id=stop:22:/tmp/hooks.json>?'],
  ['quotes a torn wake', 'Why did this appear?\n0d55a713f50015a⟧\n[await-event] coord:inbox-wake:su-a20d fired — continue the work'],
  ['quotes a Papercusp peer diagnostic', 'Why did this appear? [peer:su-4a84c93a-e530-450c-b01e-8beb7bdc670f] Parent recovery diagnostic under existing EI-26842368936683990.'],
  ['ordinary untagged native ownerTurn mode turn', "Please keep this native ownerTurn mode:'turn' request as owner input."],
];

describe('owner-visibility parity across altitudes', () => {
  describe('machine turns are machine at BOTH altitudes', () => {
    for (const [label, text] of MACHINE_TURNS) {
      it(`${label}: hidden from chat AND excluded from memory`, () => {
        expect(ownerVisiblePromptText(text), `${label} leaked into the owner's chat pane`).toBe('');
        expect(isHumanTurn(text), `${label} was fed to the owner's memory as their own words`).toBe(false);
      });
    }
  });

  describe('owner turns survive BOTH altitudes (calibration)', () => {
    for (const [label, text] of OWNER_TURNS) {
      it(`${label}: shown in chat AND kept for memory`, () => {
        expect(ownerVisiblePromptText(text), `${label} vanished from the owner's chat pane`).not.toBe('');
        expect(isHumanTurn(text), `${label} was dropped from the owner's memory`).toBe(true);
      });
    }
  });

  /**
   * The anti-drift guard proper. Adding a pattern to the catalogue without a
   * parity exemplar is exactly how the two altitudes drifted the first time —
   * the pattern reaches one consumer, nobody checks the other, and the gap is
   * found by measuring production months later.
   */
  it('every curated pattern is exercised by a parity exemplar', () => {
    const unexercised = MACHINE_SURFACE_PATTERNS.filter(
      (re) => !MACHINE_TURNS.some(([, text]) => re.test(text.slice(0, CLASSIFY_HEAD_CHARS))),
    ).map((re) => re.source);

    expect(
      unexercised,
      'A catalogue pattern has no exemplar in MACHINE_TURNS, so nothing proves both ' +
        'altitudes honour it. Add one line to MACHINE_TURNS above for each pattern listed here.',
    ).toEqual([]);
  });
});
