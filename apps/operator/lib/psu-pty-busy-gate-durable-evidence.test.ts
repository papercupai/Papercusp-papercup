/**
 * WI-2141048 — the psu-pty busy gate must leave DURABLE evidence for every deferred mode,
 * not just `carry-respawn`.
 *
 * When `agentBusyGate.waitAtPrompt()` defers, the host drops the live inject/kill rather than
 * wedge a mid-turn agent. That is correct behaviour, but it is also the exact moment a wake
 * stops being observable: the message is returned as `deferred-busy-gate` and the only trace
 * was a stderr line, which no later reader can query. `appendHostEvent` was called ONLY inside
 * `if (msg.mode === 'carry-respawn')`, so a `turn`/`reset`/`recycle` killed by this gate left
 * nothing durable at all — and "member booted and never took a turn" is precisely the failure
 * a fleet leader has to diagnose after the fact.
 *
 * MEASURED 2026-09-02 over the full `~/.papercusp/psu-pty` population (6,795 event logs):
 * 11,544 `carry-respawn-busy-gate-expired` rows and ZERO turn-mode siblings of any spelling.
 * The other defer paths in this same handler (`turn-deferred-quota-blocked`,
 * `turn-deferred-for-owner-input`, `wake-turn-deferred-for-pending-respawn`) all DO record
 * durably, which is what isolates the gap to the busy-gate path specifically.
 *
 * EI-19480099650947832 is why the payload carries `observedMaxQuietMs` alongside `quietMs`:
 * a genuinely-busy agent (longest quiet gap ~0ms, something redrawing the pty) and a near-miss
 * (gap ~quietMs, threshold too tight) are indistinguishable from the kind name alone and have
 * OPPOSITE fixes. Dropping that pair on the non-respawn path discarded the diagnostic on the
 * majority of defers.
 *
 * This is a SOURCE-STRUCTURE guard by necessity: the branch lives inside `runGatedDelivery`,
 * deep within `hostThroughPty`, which no test drives end-to-end (it needs a real pty + control
 * socket). It therefore asserts the one property that regressed — the emission is a SIBLING of
 * the carry-respawn branch rather than nested inside it — and refuses to pass vacuously if it
 * cannot locate the block it is supposed to be judging.
 *
 * Falsifiability (tier 2, no in-tree mutation): point PSU_PTY_HOST_SOURCE at a mutated COPY.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/** Overridable so a mutation probe can aim this at a copy OUTSIDE the shared tree. */
const HOST_SOURCE = process.env.PSU_PTY_HOST_SOURCE
  ? resolve(process.env.PSU_PTY_HOST_SOURCE)
  : resolve(__dirname, '../scripts/psu-pty-host.mjs');

/** The stderr line every deferred mode writes — unique in the file, so it anchors the block. */
const DEFER_ANCHOR = 'DEFERRED/REFUSED';
/** The terminal statement of the busy-gate defer block. */
const DEFER_RETURN = "return { ok: false, reason: 'deferred-busy-gate' };";
const RESPAWN_BRANCH = "if (msg.mode === 'carry-respawn') {";
const EMIT_CALL = "appendHostEvent(ownerId, 'busy-gate-expired', busyGateEvent);";

/**
 * The source span of the busy-gate defer handler: from `if (atPrompt.deferred) {` through the
 * `deferred-busy-gate` return. Throws rather than returning empty — a guard that cannot find
 * its subject must FAIL, not report a clean pass over nothing.
 */
function busyGateDeferBlock(): string {
  const src = readFileSync(HOST_SOURCE, 'utf-8');

  const anchor = src.indexOf(DEFER_ANCHOR);
  if (anchor === -1) {
    throw new Error(
      `psu-pty-host.mjs no longer contains the ${DEFER_ANCHOR} defer diagnostic — this guard ` +
        'cannot locate the busy-gate handler and must not pass vacuously. Re-anchor it.',
    );
  }

  const openIdx = src.lastIndexOf('if (atPrompt.deferred) {', anchor);
  if (openIdx === -1) {
    throw new Error(
      'psu-pty-host.mjs: found the defer diagnostic but no enclosing `if (atPrompt.deferred) {` ' +
        'above it — the handler was restructured; re-anchor this guard.',
    );
  }

  const endIdx = src.indexOf(DEFER_RETURN, openIdx);
  if (endIdx === -1) {
    throw new Error(
      `psu-pty-host.mjs: no ${DEFER_RETURN} terminating the busy-gate defer block — re-anchor.`,
    );
  }

  const block = src.slice(openIdx, endIdx + DEFER_RETURN.length);
  // A block far shorter than the real handler means the anchors matched something else.
  if (block.length < 400) {
    throw new Error(`psu-pty-host.mjs: busy-gate defer block implausibly short (${block.length} chars).`);
  }
  return block;
}

describe('psu-pty busy-gate defer leaves durable evidence for EVERY mode (WI-2141048)', () => {
  it('locates a plausible busy-gate defer block (refuses to judge nothing)', () => {
    const block = busyGateDeferBlock();
    expect(block).toContain(DEFER_ANCHOR);
    expect(block).toContain(RESPAWN_BRANCH);
  });

  it('emits a durable host event on the defer path', () => {
    expect(busyGateDeferBlock()).toContain(EMIT_CALL);
  });

  it('emits it OUTSIDE the carry-respawn branch — the regression this guard exists for', () => {
    const block = busyGateDeferBlock();
    const emitIdx = block.indexOf(EMIT_CALL);
    const respawnIdx = block.indexOf(RESPAWN_BRANCH);

    expect(emitIdx).toBeGreaterThan(-1);
    expect(respawnIdx).toBeGreaterThan(-1);
    // Emitted before the branch opens ⇒ every deferred mode reaches it. Nesting it back inside
    // the branch (the pre-fix shape) puts emitIdx after respawnIdx and fails here.
    expect(emitIdx).toBeLessThan(respawnIdx);
  });

  it('records the DEFERRED MODE rather than a hardcoded carry-respawn literal', () => {
    const block = busyGateDeferBlock();
    const payloadStart = block.indexOf('const busyGateEvent = {');
    const respawnIdx = block.indexOf(RESPAWN_BRANCH);
    expect(payloadStart).toBeGreaterThan(-1);
    expect(payloadStart).toBeLessThan(respawnIdx);
    const payload = block.slice(payloadStart, respawnIdx);
    expect(payload).toContain('mode: msg.mode');
    expect(payload).not.toContain("mode: 'carry-respawn'");
  });

  it('carries the EI-19480099650947832 diagnostic pair that distinguishes busy from near-miss', () => {
    const block = busyGateDeferBlock();
    const payloadStart = block.indexOf('const busyGateEvent = {');
    const emitIdx = block.indexOf(EMIT_CALL);
    expect(payloadStart).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(payloadStart);
    const payload = block.slice(payloadStart, emitIdx);
    for (const field of ['capMs:', 'observedMaxQuietMs:', 'quietMs:']) {
      expect(payload).toContain(field);
    }
  });

  it('writes exactly ONE row per defer', () => {
    const block = busyGateDeferBlock();
    const emissions = block.split("appendHostEvent(ownerId, 'busy-gate-expired'").length - 1;
    expect(emissions).toBe(1);
  });

  it('retires the carry-respawn-only kind — mode is a field now, not part of the name', () => {
    expect(readFileSync(HOST_SOURCE, 'utf-8')).not.toContain("'carry-respawn-busy-gate-expired'");
  });
});

describe('pending carry-respawn wake deferral is durable-only (WI-10001960)', () => {
  function pendingRespawnDeferralBlocks(src: string): string[] {
    const parsed = ts.createSourceFile('psu-pty-host.mjs', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const blocks: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'shouldDeferWakeForPendingRespawn') {
        blocks.push(node.thenStatement.getText(parsed));
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parsed, visit);
    if (blocks.length === 0) {
      throw new Error(
        'psu-pty-host.mjs no longer contains the pending carry-respawn wake guard; ' +
          'this regression guard cannot pass vacuously.',
      );
    }
    return blocks;
  }

  function assertDurableOnly(block: string): void {
    expect(block).toContain("appendHostEvent(ownerId, 'wake-turn-deferred-for-pending-respawn',");
    expect(block).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*'(?:deferred-)?carry-respawn-pending'/);
    expect(block).not.toContain('process.stderr.write');
    expect(block).not.toContain('successor');
  }

  it('records the deferral durably without writing an internal warning into the owner TUI', () => {
    const blocks = pendingRespawnDeferralBlocks(readFileSync(HOST_SOURCE, 'utf-8'));
    expect(blocks).toHaveLength(3); // admission, rearmed pre-write, and final pre-write boundaries
    for (const block of blocks) assertDurableOnly(block);
  });

  const fixture = [
    "if (shouldDeferWakeForPendingRespawn(mode, pending)) {",
    "  appendHostEvent(ownerId, 'wake-turn-deferred-for-pending-respawn', { phase: 'pre-write' });",
    "  return { ok: false, reason: 'carry-respawn-pending' };",
    "}",
    "process.stderr.write('unrelated delivery diagnostic');",
    "if (shouldDeferWakeForPendingRespawn(msg.mode, pending)) {",
    "  appendHostEvent(ownerId, 'wake-turn-deferred-for-pending-respawn', dropExtra);",
    "  return { ok: false, reason: 'deferred-carry-respawn-pending' };",
    "}",
  ].join('\n');

  it('isolates both return variants without including the diagnostic between branches', () => {
    const blocks = pendingRespawnDeferralBlocks(fixture);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) assertDurableOnly(block);
  });

  it.each([0, 1])('detects a TUI write or missing durable event in branch %s', (index) => {
    const block = pendingRespawnDeferralBlocks(fixture)[index]!;
    expect(() => assertDurableOnly(block.replace('return {', "process.stderr.write('warning'); return {")))
      .toThrow();
    expect(() => assertDurableOnly(block.replace('appendHostEvent', 'discardHostEvent'))).toThrow();
  });

  it('refuses to pass when the pending-respawn guards disappear', () => {
    expect(() => pendingRespawnDeferralBlocks('return { ok: true };')).toThrow('cannot pass vacuously');
  });
});
