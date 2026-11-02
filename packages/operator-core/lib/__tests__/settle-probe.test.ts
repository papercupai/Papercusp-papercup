/**
 * EI-19385008818210514 — headless UI verification must not read a GUARDED
 * component's absence as a missing feature.
 *
 * The subject (`scripts/settle-probe.mjs`) exists to stop a specific WRONG
 * CONCLUSION, not to produce a prettier measurement, so these tests are aimed at
 * the conclusion:
 *
 *  1. `inFlight: null` MUST be `unknown`, never `settled`. metrics.ts reports null
 *     when no concurrency gate is registered or the gate probe threw — reading it
 *     as zero would rebuild the confident false-negative inside the fix.
 *  2. A SETTLED page MUST produce NO note (the permanent negative control). A
 *     caveat printed on every failure is one readers learn to skip.
 *
 * Both controls are permanent and deliberate. `naiveSettleVerdict` below is a
 * deliberately-WRONG implementation kept in this file as the calibration control:
 * it is what the subject would be if it treated null as zero, and the tests assert
 * that the two DISAGREE on exactly the sample that matters. Without it, a subject
 * that silently regressed to two-state logic would still pass every "settled means
 * settled" assertion.
 */
import { describe, expect, it } from 'vitest';
// prettier-ignore
import {
  SETTLE_EVAL_EXPRESSION,
  SETTLE_EXIT_CODES,
  SETTLE_USAGE,
  SETTLE_VERDICTS,
  buildSettleEvalExpression,
  buildEvalArgs,
  evaluateSettleSample,
  formatSettleNote,
  nextQuietAnchor,
  normaliseCount,
  parseSettleCliArgs,
  parseSettleSample,
  resolveSettleTimeoutSec,
  settleExitCode,
  // TS reports a module-resolution error on the SPECIFIER's line, which for a
  // multi-line import is this closing line — so the suppression has to sit here,
  // not above `import {`, or it silences nothing.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs verification script, no declaration file.
} from '../../../../scripts/settle-probe.mjs';

type Sample = {
  metricsPresent?: boolean;
  transport?: { inFlight: number | null; queued: number | null; limit: number | null } | null;
  domNodes?: number | null;
  domSignature?: string | null;
  readySelector?: string | null;
  readySelectorPresent?: boolean;
  takenAtMs?: number;
  error?: string;
};

const idle = (over: Partial<Sample> = {}): Sample => ({
  metricsPresent: true,
  transport: { inFlight: 0, queued: 0, limit: 6 },
  domNodes: 812,
  domSignature: '812:41231',
  takenAtMs: 1_000,
  ...over,
});

/**
 * THE CALIBRATION CONTROL — a deliberately wrong two-state implementation, kept
 * permanently. It is exactly the shape the subject must never take: `?? 0` reads
 * "no gate registered" as "nothing in flight".
 */
function naiveSettleVerdict(sample: Sample): 'settled' | 'busy' {
  const inFlight = sample?.transport?.inFlight ?? 0;
  const queued = sample?.transport?.queued ?? 0;
  return inFlight > 0 || queued > 0 ? 'busy' : 'settled';
}

describe('settle-probe — the three-state rule', () => {
  it('CONTROL: inFlight null is UNKNOWN, never settled — and the naive reading disagrees', () => {
    const nullGate = idle({ transport: { inFlight: null, queued: null, limit: null } });

    // The control proves the sample is one a two-state implementation gets wrong.
    expect(naiveSettleVerdict(nullGate)).toBe('settled');
    // The subject must NOT agree with it.
    const verdict = evaluateSettleSample(nullGate, { quietMs: 0 });
    expect(verdict.verdict).toBe(SETTLE_VERDICTS.UNKNOWN);
    expect(verdict.verdict).not.toBe(SETTLE_VERDICTS.SETTLED);
    expect(verdict.reason).toBe('gate-unregistered');
  });

  it('CONTROL: a HALF-null gate (inFlight known, queued null) is still UNKNOWN', () => {
    const half = idle({ transport: { inFlight: 0, queued: null, limit: 6 } });
    expect(naiveSettleVerdict(half)).toBe('settled');
    expect(evaluateSettleSample(half, { quietMs: 0 }).verdict).toBe(SETTLE_VERDICTS.UNKNOWN);
  });

  it('CALIBRATION: on a genuinely idle page the subject and the control agree', () => {
    // Without this, the controls above would also pass if the subject answered
    // "unknown" to everything.
    expect(naiveSettleVerdict(idle())).toBe('settled');
    expect(evaluateSettleSample(idle(), { quietMs: 0 }).verdict).toBe(SETTLE_VERDICTS.SETTLED);
  });

  it('reports busy while requests are in flight or queued', () => {
    const inFlight = evaluateSettleSample(idle({ transport: { inFlight: 3, queued: 0, limit: 6 } }), { quietMs: 0 });
    expect(inFlight.verdict).toBe(SETTLE_VERDICTS.BUSY);
    expect(inFlight.reason).toBe('requests-in-flight');

    const queued = evaluateSettleSample(idle({ transport: { inFlight: 0, queued: 2, limit: 6 } }), {
      quietMs: 0,
    });
    expect(queued.verdict).toBe(SETTLE_VERDICTS.BUSY);
  });

  it('treats a missing metrics global, a missing transport, a thrown probe and a junk sample as UNKNOWN', () => {
    for (const sample of [
      null,
      undefined,
      'not-a-sample',
      { metricsPresent: false, transport: null },
      { metricsPresent: true, transport: null },
      { error: 'ReferenceError: window is not defined' },
    ]) {
      expect(evaluateSettleSample(sample as Sample, { quietMs: 0 }).verdict).toBe(SETTLE_VERDICTS.UNKNOWN);
    }
  });

  it('never reads a non-numeric counter as zero', () => {
    expect(normaliseCount(0)).toBe(0);
    expect(normaliseCount(4)).toBe(4);
    for (const junk of [null, undefined, NaN, '0', {}, []]) {
      expect(normaliseCount(junk)).toBeNull();
    }
  });
});

describe('settle-probe — the DOM quiet window', () => {
  it('is measured from the anchor of the streak, so a persistently quiet page does settle', () => {
    // The regression this guards: measuring between CONSECUTIVE samples makes
    // elapsed permanently equal the polling interval, so a page that is quiet
    // forever never reaches settled and every assertion inherits a false note.
    const anchor = idle({ takenAtMs: 1_000 });
    const later = idle({ takenAtMs: 1_250 });
    const muchLater = idle({ takenAtMs: 1_600 });

    expect(evaluateSettleSample(later, { previous: anchor, quietMs: 400 }).verdict).toBe(SETTLE_VERDICTS.BUSY);
    // The anchor is KEPT across the quiet streak...
    expect(nextQuietAnchor(anchor, later, { verdict: SETTLE_VERDICTS.BUSY })).toBe(anchor);
    // ...so the window eventually elapses against it.
    expect(evaluateSettleSample(muchLater, { previous: anchor, quietMs: 400 }).verdict).toBe(SETTLE_VERDICTS.SETTLED);
  });

  it('restarts the window when the DOM mutates', () => {
    const anchor = idle({ takenAtMs: 1_000, domSignature: '812:41231' });
    const mutated = idle({ takenAtMs: 1_900, domSignature: '907:52118' });
    const verdict = evaluateSettleSample(mutated, { previous: anchor, quietMs: 400 });
    expect(verdict.verdict).toBe(SETTLE_VERDICTS.BUSY);
    expect(verdict.reason).toBe('dom-mutating');
    expect(nextQuietAnchor(anchor, mutated, verdict)).toBe(mutated);
  });

  it('will not settle on the first sample when a quiet window is required', () => {
    const verdict = evaluateSettleSample(idle(), { previous: null, quietMs: 400 });
    expect(verdict.verdict).toBe(SETTLE_VERDICTS.BUSY);
    expect(verdict.reason).toBe('quiet-window-pending');
  });

  it('starts the quiet window only after the route selector appears and its sync request starts', () => {
    const readySelector = '[data-testid="plan-provenance-audit"]';
    const beforeRoute = idle({ takenAtMs: 1_000, readySelectorPresent: false });
    const routeNotReady = evaluateSettleSample(beforeRoute, {
      readySelector,
      quietMs: 400,
    });
    expect(routeNotReady.verdict).toBe(SETTLE_VERDICTS.BUSY);
    expect(routeNotReady.reason).toBe('route-not-ready');
    expect(nextQuietAnchor(null, beforeRoute, routeNotReady)).toBeNull();

    const mounted = idle({ takenAtMs: 2_000, readySelectorPresent: true });
    const mountedVerdict = evaluateSettleSample(mounted, {
      previous: null,
      readySelector,
      quietMs: 400,
    });
    expect(mountedVerdict.reason).toBe('quiet-window-pending');
    const mountedAnchor = nextQuietAnchor(null, mounted, mountedVerdict);

    const requestStarts = idle({
      takenAtMs: 2_100,
      readySelectorPresent: true,
      transport: { inFlight: 1, queued: 0, limit: 6 },
    });
    const requestVerdict = evaluateSettleSample(requestStarts, {
      previous: mountedAnchor,
      readySelector,
      quietMs: 400,
    });
    expect(requestVerdict.reason).toBe('requests-in-flight');
    expect(nextQuietAnchor(mountedAnchor, requestStarts, requestVerdict)).toBeNull();

    const idleAgain = idle({ takenAtMs: 2_200, readySelectorPresent: true });
    const firstQuiet = evaluateSettleSample(idleAgain, {
      previous: null,
      readySelector,
      quietMs: 400,
    });
    expect(firstQuiet.reason).toBe('quiet-window-pending');
    const settled = evaluateSettleSample(
      idle({ takenAtMs: 2_600, readySelectorPresent: true }),
      { previous: idleAgain, readySelector, quietMs: 400 },
    );
    expect(settled.verdict).toBe(SETTLE_VERDICTS.SETTLED);
  });

  it('drops the anchor when the streak breaks — a busy gate, an unknown reading, or a bad sample', () => {
    const anchor = idle();
    expect(nextQuietAnchor(anchor, idle(), { reason: 'requests-in-flight' })).toBeNull();
    expect(nextQuietAnchor(anchor, idle(), { verdict: SETTLE_VERDICTS.UNKNOWN })).toBeNull();
    expect(nextQuietAnchor(anchor, { error: 'boom' }, { verdict: SETTLE_VERDICTS.UNKNOWN })).toBeNull();
    expect(nextQuietAnchor(anchor, null, {})).toBeNull();
  });

  it('reports UNKNOWN rather than settled when the samples carry no clock', () => {
    const anchor = idle({ takenAtMs: undefined });
    const later = idle({ takenAtMs: undefined });
    expect(evaluateSettleSample(later, { previous: anchor, quietMs: 400 }).verdict).toBe(SETTLE_VERDICTS.UNKNOWN);
  });
});

describe('settle-probe — the note attached to a failing assertion', () => {
  it('PERMANENT NEGATIVE CONTROL: a settled page produces NO note at all', () => {
    // Deliberate. A caveat that prints on every failure is a caveat readers learn
    // to skip, and this one has to be believed on the run where it matters.
    expect(formatSettleNote(evaluateSettleSample(idle(), { quietMs: 0 }))).toBe('');
    expect(formatSettleNote(null)).toBe('');
    expect(formatSettleNote(undefined)).toBe('');
  });

  it('names the WRONG CONCLUSION and its falsifier, not just the measurement', () => {
    // The measurement was already correct in the incident this came from; what was
    // missing was a caveat aimed at the verb the reader was about to perform.
    const note = formatSettleNote(
      evaluateSettleSample(idle({ transport: { inFlight: 2, queued: 1, limit: 6 } }), {
        quietMs: 0,
      }),
    );
    expect(note).not.toBe('');
    expect(note).toMatch(/STILL LOADING/);
    expect(note).toMatch(/Do NOT conclude/);
    expect(note).toMatch(/VERIFY_TAURI_SETTLE/);
    expect(note).toMatch(/RACE/);
    expect(note).toMatch(/2 sync request\(s\) in flight, 1 queued/);
  });

  it('says UNKNOWN is not evidence that loading finished', () => {
    const note = formatSettleNote(
      evaluateSettleSample(idle({ transport: { inFlight: null, queued: null, limit: null } }), {
        quietMs: 0,
      }),
    );
    expect(note).toMatch(/UNKNOWN/);
    expect(note).toMatch(/NOT evidence/);
    expect(note).toMatch(/Do NOT conclude/);
  });

  it('honours a prefix so it can be indented inside another diagnostic', () => {
    const note = formatSettleNote(evaluateSettleSample(null, { quietMs: 0 }), { prefix: '  ' });
    for (const line of note.split('\n')) expect(line.startsWith('  ')).toBe(true);
  });
});

describe('settle-probe — page-side expression and CLI plumbing', () => {
  it('reads the production sync-metrics global and reports absence instead of throwing', () => {
    expect(SETTLE_EVAL_EXPRESSION).toContain('__sync_metrics__');
    expect(SETTLE_EVAL_EXPRESSION).toContain('metricsPresent: false');
    expect(SETTLE_EVAL_EXPRESSION).toContain('catch');
    // It must forward null through unchanged — a `|| 0` here would defeat the
    // three-state rule at the source, before evaluateSettleSample ever sees it.
    expect(SETTLE_EVAL_EXPRESSION).not.toMatch(/inFlight[^,\n]*\|\|\s*0/);
    expect(SETTLE_EVAL_EXPRESSION).not.toMatch(/inFlight[^,\n]*\?\?\s*0/);
  });

  it('embeds an escaped readiness selector in the page-side probe', () => {
    const selector = '[data-testid="plan-provenance-audit"]';
    const expression = buildSettleEvalExpression(selector);
    expect(expression).toContain(JSON.stringify(selector));
    expect(expression).toContain('doc.querySelector(readySelector)');
  });

  it('puts tauri-agent-tools flags AFTER the subcommand', () => {
    const args = buildEvalArgs({ pid: '4242' });
    expect(args[0]).toBe('eval');
    expect(args.indexOf('--pid')).toBeGreaterThan(0);
    expect(args[args.indexOf('--pid') + 1]).toBe('4242');
    expect(args[args.length - 1]).toBe(SETTLE_EVAL_EXPRESSION);
    const selector = '[data-testid="plan-provenance-audit"]';
    const guardedArgs = buildEvalArgs({ pid: '4242', readySelector: selector });
    expect(guardedArgs[guardedArgs.length - 1]).toBe(buildSettleEvalExpression(selector));
  });

  it('LIVE REGRESSION: never sends --pid and --port together, and never defaults the port from VERIFY_TAURI_PORT', () => {
    // Measured 2026-08-31 against a booted headless instance: sending both made
    // tauri-agent-tools answer `Bridge error (404)`, which this probe then
    // reported as `unknown` on a page that was in fact perfectly idle. And
    // VERIFY_TAURI_PORT is the webview's Hono+SPA origin, not the agent-tools
    // bridge port — precisely the wrong number to volunteer.
    const both = buildEvalArgs({ pid: '4242', port: '33701' });
    expect(both).toContain('--pid');
    expect(both).not.toContain('--port');
    // Port alone still works, for a caller who genuinely has a bridge port.
    expect(buildEvalArgs({ port: '33701' })).toContain('--port');
    expect(parseSettleCliArgs([], { VERIFY_TAURI_PID: '77', VERIFY_TAURI_PORT: '33701' }).port).toBe('');
  });

  it('LIVE REGRESSION: reads the PRETTY-PRINTED multi-line output the bridge actually returns', () => {
    // Measured 2026-08-31: `eval` pretty-prints an object result across many
    // lines even though the expression returns JSON.stringify(...) — the same
    // trap agent-e2e documents for `grep '"ok":true'`. A line-at-a-time reader
    // finds valid JSON on NO line and reports "printed no reading", which lands
    // as `unknown` on a healthy page — a false caveat on every assertion.
    const pretty = [
      '{',
      '  "metricsPresent": true,',
      '  "transport": {',
      '    "inFlight": 0,',
      '    "queued": 0,',
      '    "limit": 24',
      '  },',
      '  "domNodes": 812,',
      '  "domSignature": "812:41231",',
      '  "takenAtMs": 1000',
      '}',
    ].join('\n');
    const parsed = parseSettleSample(pretty);
    expect(parsed.ok).toBe(true);
    expect(parsed.sample.transport.limit).toBe(24);
    expect(evaluateSettleSample(parsed.sample, { quietMs: 0 }).verdict).toBe(SETTLE_VERDICTS.SETTLED);
    // ...and still when the bridge prefixes it with chatter.
    expect(parseSettleSample(`[probe] connected\n${pretty}`).ok).toBe(true);
  });

  it('recovers a sample from raw, double-encoded, and log-prefixed probe output', () => {
    const sample = idle();
    const raw = JSON.stringify(sample);
    expect(parseSettleSample(raw).sample).toEqual(sample);
    expect(parseSettleSample(JSON.stringify(raw)).sample).toEqual(sample);
    expect(parseSettleSample(`connecting to bridge...\n${raw}\n`).sample).toEqual(sample);
  });

  it('turns unparseable or empty probe output into an UNKNOWN verdict, never an idle one', () => {
    for (const raw of ['', '   ', 'error: bridge closed', undefined]) {
      const parsed = parseSettleSample(raw as string);
      expect(parsed.ok).toBe(false);
      expect(evaluateSettleSample(parsed.sample, { quietMs: 0 }).verdict).toBe(SETTLE_VERDICTS.UNKNOWN);
    }
  });

  it('exits distinctly on settled / busy / unknown', () => {
    expect(settleExitCode({ verdict: SETTLE_VERDICTS.SETTLED })).toBe(SETTLE_EXIT_CODES.settled);
    expect(settleExitCode({ verdict: SETTLE_VERDICTS.BUSY })).toBe(SETTLE_EXIT_CODES.busy);
    expect(settleExitCode({ verdict: SETTLE_VERDICTS.UNKNOWN })).toBe(SETTLE_EXIT_CODES.unknown);
    expect(settleExitCode(null)).toBe(SETTLE_EXIT_CODES.unknown);
    // Distinct is the requirement — an author must be able to tell "never went
    // quiet" from "could not tell".
    expect(new Set(Object.values(SETTLE_EXIT_CODES)).size).toBe(3);
  });

  it('parses CLI args and falls back to the verifier environment', () => {
    const selector = '[data-testid="plan-provenance-audit"]';
    const fromEnv = parseSettleCliArgs([], {
      VERIFY_TAURI_PID: '77',
      VERIFY_TAURI_PORT: '3199',
      VERIFY_TAURI_READY_SELECTOR: selector,
    });
    expect(fromEnv.pid).toBe('77');
    // The pid is the only target taken from the environment — see the port
    // regression test above for why VERIFY_TAURI_PORT is deliberately ignored.
    expect(fromEnv.port).toBe('');
    expect(fromEnv.readySelector).toBe(selector);
    expect(parseSettleCliArgs(['--port', '3199'], {}).port).toBe('3199');

    const explicit = parseSettleCliArgs(
      [
        '--pid',
        '99',
        '--ready-selector',
        selector,
        '--timeout',
        '5',
        '--quiet-ms',
        '150',
        '--note-only',
        '--json',
      ],
      {},
    );
    expect(explicit).toMatchObject({
      pid: '99',
      readySelector: selector,
      timeoutSec: 5,
      quietMs: 150,
      noteOnly: true,
      json: true,
    });

    expect(parseSettleCliArgs(['--nope'], {}).error).toMatch(/unknown option/);
    expect(parseSettleCliArgs(['--ready-selector'], {}).error).toMatch(/non-empty CSS selector/);
  });

  it('inherits the guarded DOM budget unless a settle-specific timeout overrides it', () => {
    expect(resolveSettleTimeoutSec({})).toBe(20);
    expect(resolveSettleTimeoutSec({ VERIFY_TAURI_DOM_TIMEOUT: '30' })).toBe(30);
    expect(
      resolveSettleTimeoutSec({
        VERIFY_TAURI_DOM_TIMEOUT: '30',
        VERIFY_TAURI_SETTLE_TIMEOUT: '12',
      }),
    ).toBe(12);

    expect(parseSettleCliArgs([], { VERIFY_TAURI_DOM_TIMEOUT: '30' }).timeoutSec).toBe(30);
    expect(parseSettleCliArgs(['--timeout', '7'], { VERIFY_TAURI_DOM_TIMEOUT: '30' }).timeoutSec).toBe(7);
  });

  it('documents the three exit codes in its usage text', () => {
    expect(SETTLE_USAGE).toMatch(/settled/);
    expect(SETTLE_USAGE).toMatch(/UNKNOWN/);
    expect(SETTLE_USAGE).toMatch(/--note-only/);
    expect(SETTLE_USAGE).toMatch(/VERIFY_TAURI_DOM_TIMEOUT/);
    expect(SETTLE_USAGE).toMatch(/--ready-selector/);
  });
});
