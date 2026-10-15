/**
 * pui must read a >1 KiB input burst in full, without waiting for another key
 * (WI-10006651).
 *
 * crossterm's default Unix input source registers the tty with mio, which is
 * EDGE-triggered epoll. Its `try_read` reads one 1024-byte chunk, returns the
 * first parsed event and does not drain the fd, so bytes beyond that chunk
 * produce no further readiness edge. They sat unread, with pui idle at 0 CPU,
 * until the NEXT keypress re-armed the edge. Measured on the shipped binary:
 * 504 bytes then `@cal` drew the file picker at once; 2204 bytes left it
 * undrawn for 60 s, and a later Tab brought all of it through together.
 *
 * The fix is crossterm's `use-dev-tty` feature (apps/tui/Cargo.toml), whose
 * source is level-triggered poll(2). This suite is the recurrence guard: it is
 * deliberately end-to-end (built binary, real PTY, one burst written at once),
 * because the defect lives in the dependency's input source, below every pui
 * reducer test.
 *
 * Hermetic: no operator is needed. The composer and the `@` picker are local,
 * so PUI_OPERATOR points at a closed port.
 */
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ensurePuiBinary } from './pui-binary';
import { describeObserverBlock, pollUntil } from './poll-until';
import { screenContains, VtScreen } from './vt-screen';

const ROWS = 40;
const COLS = 120;
/** Well past crossterm's 1024-byte read chunk, so at least two chunks remain. */
const BURST_BACKSPACES = 3000;
/** Under one chunk: the calibration that must pass on any build. */
const CALIBRATION_BACKSPACES = 40;
const PICKER_TITLE = 'Attach a file';

/** The environment a stock user launch would see, minus fleet identity. */
function launchEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(PAPERCUSP_|PSU_|PUI_|CLAUDECODE$|CLAUDE_CODE_|ANTHROPIC_|OPENAI_|CODEX_)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Port 9 (discard) is closed here: the operator is deliberately absent.
    PUI_OPERATOR: 'http://127.0.0.1:9',
  };
}

class PuiPty {
  readonly pty: IPty;
  private raw = '';

  constructor(bin: string, cwd: string) {
    this.pty = ptySpawn(bin, ['--solo'], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env: launchEnv() });
    this.pty.onData((chunk) => {
      this.raw += chunk;
    });
  }

  screen(): string {
    const vt = new VtScreen(ROWS, COLS);
    vt.feed(this.raw);
    return vt.text();
  }

  async waitFor(needle: string, timeoutMs: number): Promise<void> {
    const { ok, maxLateMs } = await pollUntil(() => screenContains(this.screen(), needle), { timeoutMs });
    if (ok) return;
    throw new Error(
      `timed out (${timeoutMs}ms) waiting for ${JSON.stringify(needle)}${describeObserverBlock(maxLateMs)}:\n${this.screen()}`,
    );
  }

  kill(): void {
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
  }
}

describe('pui reads a large input burst without a further keypress (WI-10006651)', () => {
  let bin = '';
  let project = '';
  let pui: PuiPty | null = null;

  beforeAll(() => {
    bin = ensurePuiBinary();
  }, 900_000);

  afterEach(() => {
    pui?.kill();
    pui = null;
    if (project) rmSync(project, { recursive: true, force: true });
    project = '';
  });

  async function openComposerIn(): Promise<PuiPty> {
    project = mkdtempSync(path.join(tmpdir(), 'pui-input-burst-'));
    writeFileSync(path.join(project, 'calc.js'), 'module.exports = 1;\n');
    writeFileSync(path.join(project, 'calc.test.js'), "require('./calc');\n");
    const p = new PuiPty(bin, project);
    // The chat-first composer's footer hint is the ready signal.
    await p.waitFor('for shortcuts', 60_000);
    return p;
  }

  /**
   * Writes `count` Backspaces and `@cal` as ONE write, so the whole burst is in
   * the tty input queue together, then waits for the picker WITHOUT sending
   * any later key. Before the fix, a later key was what made it appear.
   */
  async function burstThenMention(p: PuiPty, count: number): Promise<void> {
    p.pty.write('\x7f'.repeat(count) + '@cal');
    await p.waitFor(PICKER_TITLE, 10_000);
    // The picker's filter shows every character after the burst arrived.
    await p.waitFor('@cal · Enter attaches/removes', 5_000);
  }

  test('calibration: a burst under one read chunk opens the @ picker', async () => {
    pui = await openComposerIn();
    await burstThenMention(pui, CALIBRATION_BACKSPACES);
    expect(screenContains(pui.screen(), '2 matches')).toBe(true);
  }, 120_000);

  test(`a ${BURST_BACKSPACES}-byte burst is read in full and the @ picker draws`, async () => {
    pui = await openComposerIn();
    await burstThenMention(pui, BURST_BACKSPACES);
    expect(screenContains(pui.screen(), '2 matches')).toBe(true);
  }, 120_000);
});
