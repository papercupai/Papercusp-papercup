/**
 * result-door-prompt.ts — the standing-context teaching for the per-result door
 * (agent-context-firewall P-015).
 *
 * The load-bearing property is ANTI-DRIFT, and it is the only one worth testing
 * hard: the number the agent is TAUGHT must be the number the door ENFORCES. A
 * test that merely asserted "the section mentions 1500" would keep passing after
 * someone changed DOOR_SPLIT — the prompt would then confidently teach a cap that
 * no longer exists, which is worse than teaching nothing, because an agent that
 * trusts a stated cap stops checking. So the assertions below drive the renderer
 * with NON-DEFAULT constants and require the output to follow them.
 */

import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { BAKED_DOOR_CONSTANTS, computeTurnDoors, type DoorConstants } from './context-doors';
import { RESULT_DOOR_TOKENS } from './result-door';
import { MAX_PICK_PATHS } from './result-projection/parse';
import { resolveCapabilityPolicy } from '@papercusp/orchestrator/managed-capability-policy';

// Let the standard copy-out probe judge a mutated subject without dirtying the checkout.
const { renderClientResultDoorSection, renderCodexOutputGuidance, renderResultDoorSection, resultDoorPromptSlots, resultDoorPromptTokens } =
  await import(process.env.PROBE_SCRIPT ? pathToFileURL(process.env.PROBE_SCRIPT).href : './result-door-prompt');

/** A deliberately non-default constant set: floor doubled, so every door moves. */
const RAISED: DoorConstants = { ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 16_000 };

describe('result-door standing-context section', () => {
  it('TE-GUIDANCE-CAP: scopes the shared cap to the Papercusp door on every client', () => {
    for (const client of ['claude', 'omp', 'codex']) {
      const text = renderClientResultDoorSection(client);
      expect(text).toContain("Papercusp's per-result door defaults to");
      expect(text).toContain('not a universal cap on every client tool');
      expect(text).not.toContain('Every tool result is capped at');
    }
  });

  it('TE-GUIDANCE-INTERIM: Codex gets all five reduction instructions while exec remains available', () => {
    const policy = resolveCapabilityPolicy({ client: 'codex', surface: 'launch', audience: 'interactive-su' });
    expect(policy.deniedNames).not.toContain('exec');
    const text = renderCodexOutputGuidance(policy);
    expect(text).toContain('Print only the fields you will use');
    expect(text).toContain('Spill large data to a file and read selected slices');
    expect(text).toContain('Filter nested shell output');
    expect(text).toContain('// @exec: {"max_output_tokens": 1000}');
    expect(text).toContain('Prefer `code:run` for multi-tool scripts');
    expect(text).toContain('10,000 tokens');
    expect(renderClientResultDoorSection('claude')).not.toContain('Codex native tool output');
    expect(renderClientResultDoorSection('omp')).not.toContain('// @exec:');
  });

  it('TE-GUIDANCE-RETIRE: actual exec restrictions omit interim advice; unrelated native restrictions retain it', () => {
    for (const denied of ['exec', 'functions.exec', 'functions.*', '*']) {
      const text = renderClientResultDoorSection('codex', { deniedNames: [denied] });
      expect(text).not.toContain('Codex native tool output');
      expect(text).not.toContain('// @exec:');
      expect(text).toContain("Papercusp's per-result door");
    }
    expect(renderCodexOutputGuidance({ deniedNames: ['Bash', 'exec_command'] })).toContain('// @exec:');
  });

  it('teaches the SAME number the door enforces', () => {
    // result-door.ts derives RESULT_DOOR_TOKENS from computeTurnDoors(0).resultEach;
    // this is the pin between the enforcement path and the prompt.
    expect(resultDoorPromptTokens()).toBe(RESULT_DOOR_TOKENS);
    expect(resultDoorPromptTokens()).toBe(computeTurnDoors(0).resultEach);
  });

  it('BITES on drift — a changed door constant changes the rendered number', () => {
    const baseline = resultDoorPromptTokens();
    const raised = resultDoorPromptTokens(RAISED);
    expect(raised).not.toBe(baseline); // the fixture must actually move the door

    const text = renderResultDoorSection(RAISED);
    expect(text).toContain(raised.toLocaleString('en-US'));
    // The stale default must NOT appear — that is exactly the drift being guarded.
    expect(text).not.toContain(`~${baseline.toLocaleString('en-US')} tokens`);
  });

  it('renders the char budget from the token budget, not a second hardcoded number', () => {
    const text = renderResultDoorSection(RAISED);
    const chars = resultDoorPromptTokens(RAISED) * 4;
    expect(text).toContain(chars.toLocaleString('en-US'));
  });

  it('states the slot count from the same source', () => {
    expect(resultDoorPromptSlots()).toBe(computeTurnDoors(0).resultSlots);
    expect(renderResultDoorSection()).toContain(`${resultDoorPromptSlots()} result slots`);
  });

  it('teaches pick for JSON and keeps pipe for line-oriented text', () => {
    // Measured 2026-08-02: an MCP result is one-line JSON, so head/grep are
    // all-or-nothing on it and only `pick` reduces it. If this guidance is ever
    // softened back to "use pipe for tool output", agents get the all-or-nothing
    // behaviour and conclude the knob is broken.
    const text = renderResultDoorSection();
    expect(text).toMatch(/ONE line/);
    expect(text).toMatch(/`pick`/);
    expect(text).toMatch(/line-oriented text/);
  });

  it('teaches JavaScript RegExp syntax and the ignoreCase alternative to inline PCRE flags', () => {
    const text = renderResultDoorSection();

    expect(text).toContain('JavaScript `RegExp` syntax, not PCRE/GNU grep.');
    expect(text).toMatch(/inline PCRE\s+flags such as `\(\?i\)`/);
    expect(text).toContain('`ignoreCase: true`');
    expect(text).toContain('pattern: "error", ignoreCase: true');
    expect(text).toContain('`fixed: true` for literal substrings.');
  });

  it('teaches the parser-enforced maximum pick-list size', () => {
    expect(renderResultDoorSection()).toContain(`at most ${MAX_PICK_PATHS} paths`);
  });

  it('teaches that BOTH tools:invoke projection placements work', () => {
    // The nested form WAS rejected as an unknown key (EI-19386035445533031,
    // 2026-08-02), and this prompt documented that. It was then fixed on both
    // sides — the dispatch layer strips a nested `projection` before the target's
    // schema sees it, and `forwardToolsInvokeProjection` moves an outer one into
    // `args` — so the old text taught agents away from a working form, citing a
    // closed bug (EI-20345793765413803). Pin the corrected claim, not the stale one.
    const text = renderResultDoorSection();
    expect(text).toMatch(/BOTH placements work/);
    expect(text).not.toMatch(/NOT nested in `args`/);
  });

  it('teaches the real roots of the high-risk keyed envelopes', () => {
    const text = renderResultDoorSection();

    // events:status keeps exact-key inspection under event_inspection, while
    // work_items:get nests the work-item record inside each result row and
    // leaves checkpoint on that row. Generic roots such as event.current_state
    // and results[].state silently match nothing and can be misread as null.
    expect(text).toContain('event_inspection.current_generation');
    expect(text).toContain('event_inspection.current_state');
    expect(text).toContain('results[].id", "results[].workItem.state');
    expect(text).toContain('results[].workItem.state');
    expect(text).toContain('results[].workItem.assignee');
    expect(text).toContain('results[].checkpoint');
    expect(text).not.toContain('results[].state');
  });

  it('teaches plans:items as a keyed envelope rather than a bare array', () => {
    const text = renderResultDoorSection();

    expect(text).toContain('items[].item.id');
    expect(text).toContain('items[].item.effectiveStatus');
    expect(text).toContain('plans:items uses `items[].item.id`');
  });

  it('never emits a literal splice marker (psu-prompt-isolation)', () => {
    expect(renderResultDoorSection()).not.toContain('<!-- PAPERCUSP-SU:');
  });
});
