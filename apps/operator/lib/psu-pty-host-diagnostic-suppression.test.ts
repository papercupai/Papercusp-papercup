/**
 * psu-pty-turn-boundary-generalization-2026-09-22 P-006 — a ROUTINE defer diagnostic must
 * never reach the OWNER's terminal.
 *
 * `psu-launcher.mjs` imports `psu-pty-host.mjs` IN-PROCESS, and `bridgeTty` defaults to
 * `stdin.isTTY`, so a bare `process.stderr.write` from a gated-delivery defer interleaves
 * straight into the agent TUI the owner is reading. That is how
 * `psu-pty-host: turn DEFERRED/REFUSED … (agent mid-turn > 180000ms cap)` became a
 * user-visible "error" — reported by the owner on 2026-09-22 against session
 * 25a7969c-c4ae-42ed-ac2f-357845447a84.
 *
 * The defer it announces was CORRECT: the native Claude transcript for that session shows an
 * unbroken tool_use/tool_result chain across the whole 05:15:38–05:18:38 wait window, and the
 * ledger recorded `observedMaxQuietMs` 276ms against a 1500ms threshold. So the fix is not to
 * stop deferring — it is to stop SHOUTING a correct, already-durably-recorded outcome into a
 * human's chat window.
 *
 * Scope discipline this test pins: suppression applies to the ROUTINE defer diagnostics only.
 * Host lifecycle and genuinely-unexpected failures must keep writing unconditionally, or we
 * would trade a cosmetic problem for an undiagnosable one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The subject path is OVERRIDABLE (`PROBE_SCRIPT`) and the subject is imported DYNAMICALLY
 * from that path. A static `import … from '../scripts/psu-pty-host.mjs'` pins the real file,
 * so a copy-out mutation probe (scripts/mutation-probe.sh, tier 2) never loads its mutant and
 * every mutant falsely SURVIVES — measured by the psu-pty acceptance grader on 2026-09-22
 * (`return !bridgeTty` → `return true` survived on a copy). Both the behavioural cases and the
 * source-text guard below read the SAME subject path.
 */
const HOST_SRC_PATH =
  process.env.PROBE_SCRIPT ?? fileURLToPath(new URL('../scripts/psu-pty-host.mjs', import.meta.url));
const HOST_SRC = readFileSync(HOST_SRC_PATH, 'utf8');
const { shouldWriteHostDiagnostic } = (await import(pathToFileURL(HOST_SRC_PATH).href)) as {
  shouldWriteHostDiagnostic: (opts?: { bridgeTty?: boolean; env?: Record<string, string | undefined> }) => boolean;
};

type Gate = typeof shouldWriteHostDiagnostic;

/** The behavioural contract, as data, so it can be replayed against the controls below. */
const CONTRACT: ReadonlyArray<{ name: string; args: Parameters<Gate>[0]; want: boolean }> = [
  { name: 'suppresses on a bridged TTY', args: { bridgeTty: true, env: {} }, want: false },
  { name: 'writes with no bridged terminal', args: { bridgeTty: false, env: {} }, want: true },
  { name: 'DIAG=1 forces it on', args: { bridgeTty: true, env: { PAPERCUSP_PTY_HOST_DIAG: '1' } }, want: true },
  ...['0', '', 'true', 'yes', 'on'].map((value) => ({
    name: `DIAG=${JSON.stringify(value)} does not re-enable`,
    args: { bridgeTty: true, env: { PAPERCUSP_PTY_HOST_DIAG: value } },
    want: false,
  })),
];

const violations = (gate: Gate) => CONTRACT.filter((c) => gate(c.args) !== c.want).map((c) => c.name);

describe('shouldWriteHostDiagnostic', () => {
  it('SUPPRESSES on a bridged TTY — this is the owner-visible case', () => {
    expect(shouldWriteHostDiagnostic({ bridgeTty: true, env: {} })).toBe(false);
  });

  it('WRITES when there is no bridged terminal (headless member, nobody is reading)', () => {
    expect(shouldWriteHostDiagnostic({ bridgeTty: false, env: {} })).toBe(true);
  });

  it('PAPERCUSP_PTY_HOST_DIAG=1 forces the line back on for interactive debugging', () => {
    expect(
      shouldWriteHostDiagnostic({ bridgeTty: true, env: { PAPERCUSP_PTY_HOST_DIAG: '1' } }),
    ).toBe(true);
  });

  it('only the exact opt-in value re-enables it — a stray truthy string does not', () => {
    for (const value of ['0', '', 'true', 'yes', 'on']) {
      expect(
        shouldWriteHostDiagnostic({ bridgeTty: true, env: { PAPERCUSP_PTY_HOST_DIAG: value } }),
      ).toBe(false);
    }
  });

  it('defaults are safe when called with no arguments at all', () => {
    expect(() => shouldWriteHostDiagnostic()).not.toThrow();
  });
});

/**
 * Permanently-kept WRONG implementations (rubric bar R-5, falsifiability). Each is a
 * plausible regression of the gate; the contract above must reject every one. The
 * calibration case pins that the REAL subject satisfies the same contract — without it,
 * a broken contract (e.g. every `want` inverted) would make the controls "fail" vacuously.
 */
describe('contract falsifiability controls', () => {
  it('CALIBRATION: the real subject satisfies the whole contract', () => {
    expect(violations(shouldWriteHostDiagnostic)).toEqual([]);
  });

  const WRONG: ReadonlyArray<[string, Gate]> = [
    ['always writes (the pre-P-006 behaviour)', () => true],
    ['never writes (silences headless members too)', () => false],
    ['ignores the DIAG opt-in', ({ bridgeTty } = {}) => !bridgeTty],
    ['treats any truthy DIAG as opt-in', ({ bridgeTty, env = {} } = {}) => Boolean(env.PAPERCUSP_PTY_HOST_DIAG) || !bridgeTty],
    ['inverts the tty test', ({ bridgeTty, env = {} } = {}) => env.PAPERCUSP_PTY_HOST_DIAG === '1' || Boolean(bridgeTty)],
  ];

  it.each(WRONG)('rejects the wrong implementation: %s', (_name, gate) => {
    expect(violations(gate).length).toBeGreaterThan(0);
  });
});

describe('routine host diagnostics are routed, not bare', () => {
  /**
   * Source-text guard. The subject is `psu-pty-host.mjs`, a DIFFERENT file from this one, so
   * the self-match trap that bites a guard whose fixture lives inside its own subject does not
   * apply here — but the guard is still written against the CALL, not against prose, so a
   * comment mentioning `process.stderr.write` (the helper's own docstring does) can never
   * satisfy or break it.
   */
  const ROUTINE_DEFER_MARKERS = [
    'DEFERRED for ${ownerId} (${reason})',
    'DEFERRED/REFUSED for ${ownerId}',
    'DEFERRED for ${ownerId} (quota-blocked;',
    'submit not confirmed for ${ownerId} — resubmit CR #${n}',
    "mcp-reconnect ${outcome.ok ? 'OK' : 'FAILED'} for ${ownerId}",
  ];

  it.each(ROUTINE_DEFER_MARKERS)('%s is emitted via writeHostDiagnostic', (marker) => {
    const at = HOST_SRC.indexOf(marker);
    // Positive control: if the marker itself has been reworded, this guard is measuring
    // NOTHING and must fail loudly rather than pass vacuously.
    expect(at, `defer marker not found in psu-pty-host.mjs — reword the guard: ${marker}`).
      toBeGreaterThan(-1);

    // The emitting call is the nearest preceding statement. Look back a bounded window and
    // require the router, not a bare stderr write.
    const window = HOST_SRC.slice(Math.max(0, at - 400), at);
    expect(window).toContain('writeHostDiagnostic(');
    expect(window).not.toContain('process.stderr.write(');
  });

  it('the router itself is the ONLY place these lines can reach stderr', () => {
    expect(HOST_SRC).toContain('const writeHostDiagnostic = (text) => {');
    expect(HOST_SRC).toContain('if (!shouldWriteHostDiagnostic({ bridgeTty, env })) return false;');
  });

  it('host lifecycle/unexpected-failure writes are NOT suppressed', () => {
    // The gated-delivery pipeline's unexpected-throw path must still write unconditionally:
    // silencing it would make a real host fault invisible.
    expect(HOST_SRC).toContain('gated delivery pipeline threw for');
    const at = HOST_SRC.indexOf('gated delivery pipeline threw for');
    const window = HOST_SRC.slice(Math.max(0, at - 300), at);
    expect(window).toContain('writeTerminalDiagnostic(');
    expect(window).not.toContain('writeHostDiagnostic(');
  });

  it('routes every runtime diagnostic through the asynchronous terminal writer', () => {
    const runtime = HOST_SRC.slice(HOST_SRC.indexOf('export function hostThroughPty(o) {'));
    expect(runtime).toContain('const diagnosticOutput = createTerminalOutput({');
    expect(runtime).toContain('stdout: process.stderr,');
    expect(runtime).toContain('terminalOutput.finish(), diagnosticOutput.finish(),');
    expect(runtime).not.toContain('process.stderr.write(');
  });
});
