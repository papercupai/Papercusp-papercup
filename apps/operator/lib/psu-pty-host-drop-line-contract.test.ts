// @vitest-environment node
/**
 * psu-pty-host-drop-line-contract.test.ts — WI-10004926.
 *
 * psu-pty-host writes a startup-turn drop receipt to stderr:
 *
 *   psu-pty-host: launch kickoff DROPPED for <owner> (<reason text> within <N>ms over <N> attempt(s))
 *
 * packages/operator-core/lib/acceptance-grader.ts PARSES that line with
 * `$`-anchored regexes to retire a judge whose brief never landed
 * (WI-10000940 quota leg, WI-10002903 non-quota leg). The two sides used to
 * meet only through HAND-WRITTEN fixture strings in the grader's tests, so a
 * host-side format change passed every test while production drop detection
 * silently stopped matching. That nearly shipped during WI-10004919: a
 * `; reason=<code>` suffix inside the parens, caught only by reading the parser.
 *
 * This file joins the two REAL sides: every drop reason goes through the host's
 * own `formatStartupTurnDroppedLine` and into the grader's own classifier.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_KICKOFF_DROP_RE,
  LAUNCHER_QUOTA_KICKOFF_DROP_RE,
  classifyAcceptanceGraderTerminalFailure,
} from '@papercusp/operator-core/lib/acceptance-grader';
import {
  STARTUP_TURN_DROP_REASON_TEXT,
  describeStartupTurnDropReason,
  formatStartupTurnDroppedLine,
} from '../scripts/psu-pty-host.mjs';

const OWNER = 'su-0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011';
const QUOTA_REASON = 'submit-verification-aborted-quota-blocked';

/** Every reason the host can put on the line: the mapped table (derived, not
 *  restated), the prefix family, the two reasons the inject loop produces with
 *  no table entry, and a reason that does not exist yet. */
const NON_QUOTA_REASONS = [
  ...Object.keys(STARTUP_TURN_DROP_REASON_TEXT),
  'submit-verification-aborted-max-resubmits-without-output',
  'headless-claude-composer-not-ready',
  'owner-input',
  'a-reason-added-after-this-test',
];

function dropLine(dropReason: string, label = 'launch kickoff'): string {
  return formatStartupTurnDroppedLine({ label, ownerId: OWNER, dropReason, budgetMs: 600_000, attempts: 3 });
}

/** A launcher log shaped like a real one: the receipt is mid-log, not the
 *  whole input, so the `$`/`m` anchoring is exercised the way production is.
 *  Nothing here may look like first-turn progress (no tool-call words). */
function launcherLog(line: string): string {
  return `psu: launching claude for ${OWNER}\npsu-pty-host: child started\n${line}psu: host idle\n`;
}

const classify = (log: string) =>
  classifyAcceptanceGraderTerminalFailure(log, { allowLauncherQuotaDrop: true, allowLauncherKickoffDrop: true });

describe('psu-pty-host DROPPED receipt ↔ acceptance-grader parser (WI-10004926)', () => {
  it('the mapped-reason table is non-empty, so the enumeration below is not vacuous', () => {
    expect(Object.keys(STARTUP_TURN_DROP_REASON_TEXT).length).toBeGreaterThanOrEqual(9);
    expect(STARTUP_TURN_DROP_REASON_TEXT).toHaveProperty('never-settled');
    expect(STARTUP_TURN_DROP_REASON_TEXT).toHaveProperty('codex-backend-frame-not-observed');
  });

  it.each(NON_QUOTA_REASONS)('non-quota reason %s is retired as launch_kickoff_dropped', (reason) => {
    const line = dropLine(reason);
    expect(line.endsWith(' attempt(s))\n')).toBe(true);
    expect(line).toMatch(LAUNCHER_KICKOFF_DROP_RE);
    expect(line).not.toMatch(LAUNCHER_QUOTA_KICKOFF_DROP_RE);
    expect(classify(launcherLog(line))?.code).toBe('launch_kickoff_dropped');
  });

  it('the quota reason gets its dedicated code and matches ONLY the quota pattern', () => {
    const line = dropLine(QUOTA_REASON);
    expect(line).toMatch(LAUNCHER_QUOTA_KICKOFF_DROP_RE);
    expect(line).not.toMatch(LAUNCHER_KICKOFF_DROP_RE);
    expect(classify(launcherLog(line))?.code).toBe('model_quota_exhausted');
  });

  it('an unmapped reason is still NAMED on the line (WI-10004919)', () => {
    for (const reason of ['headless-claude-composer-not-ready', 'owner-input', 'a-reason-added-after-this-test']) {
      expect(describeStartupTurnDropReason(reason)).toContain(`[reason ${reason}]`);
    }
  });

  // Deliberate, measured: 61 `launch kickoff (model-turn retry)` drops in 3,574
  // host event files (2026-10-01). The retry fires only AFTER the first kickoff
  // was delivered and submitted, and a retry drop is mostly `never-settled`,
  // i.e. the child was busy with a late-starting first turn. So it is not proof
  // the judge never got its brief, and retiring on it would kill live judges.
  // The managed `session-port seed` label is likewise not a grader receipt
  // (0 drops in the same sample). Change these together with the grader if
  // that judgement changes.
  it.each(['launch kickoff (model-turn retry)', 'session-port seed'])(
    'label %s is intentionally NOT a grader retirement signal',
    (label) => {
      expect(classify(launcherLog(dropLine('never-settled', label)))).toBeNull();
      expect(classify(launcherLog(dropLine(QUOTA_REASON, label)))).toBeNull();
    },
  );

  // CONTROL: the exact drift this file exists to catch. If this ever starts
  // classifying, the parser has loosened and the contract above proves less.
  it('CONTROL: a suffix inside the parens defeats both parsers', () => {
    const drifted = dropLine('codex-backend-frame-not-observed').replace(
      ' attempt(s))\n',
      ' attempt(s); reason=codex-backend-frame-not-observed)\n',
    );
    expect(drifted).not.toMatch(LAUNCHER_KICKOFF_DROP_RE);
    expect(classify(launcherLog(drifted))).toBeNull();
    const driftedQuota = dropLine(QUOTA_REASON).replace(' attempt(s))\n', ' attempt(s); reason=quota)\n');
    expect(classify(launcherLog(driftedQuota))).toBeNull();
  });

  it('the host builds the receipt in exactly one place, and the drop path writes it through the formatter', () => {
    const src = readFileSync(fileURLToPath(new URL('../scripts/psu-pty-host.mjs', import.meta.url)), 'utf8');
    // The template that opens the parenthesised reason. A second copy means a
    // second, unpinned writer of the parsed line.
    expect(src.match(/DROPPED for \$\{ownerId\} \(\$\{/g)?.length).toBe(1);
    // Written through the non-blocking terminal writer over stderr (where the
    // grader reads launcher logs), never the suppressible writeHostDiagnostic.
    expect(src.match(/writeTerminalDiagnostic\(formatStartupTurnDroppedLine\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/writeHostDiagnostic\(formatStartupTurnDroppedLine\(/);
    expect(src).toMatch(/const diagnosticOutput = createTerminalOutput\(\{\s*stdout: process\.stderr,/);
    expect(src).toMatch(/const writeTerminalDiagnostic = \(text\) => diagnosticOutput\.write\(text\);/);
  });
});
