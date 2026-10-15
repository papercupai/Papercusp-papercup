/**
 * psu-launch-log.test.ts — WI-37841.
 *
 * The invariant under test is not "these functions work" but "the writer and the
 * reader cannot disagree about WHERE the evidence is". A failed HUD launch leaves
 * exactly one artifact, written by psu-launcher.mjs (bare node) and read by the
 * operator (TypeScript); if those two ever derive different paths the system
 * reports "the launch left no diagnostic" while the diagnostic sits on disk. That
 * failure is silent in both directions, which is why the path derivation is a
 * single shared module and why the drift guard at the bottom of this file exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  PSU_LAUNCH_LOG_DIRNAME,
  PSU_LAUNCH_LOG_TTL_MS,
  HEADLESS_LAUNCH_LOG_SCAN_BYTES,
  psuLaunchLogRoot,
  psuLaunchLogPath,
  prunePsuLaunchLogs,
  readPsuLaunchLogTail,
  detectPsuHeadlessLaunchBlockHint,
  isCodexWorkspaceDiscoveryTimeout,
  readPsuHeadlessLaunchBlockHintAsync,
  readPsuLaunchLogTailAsync,
  ensurePsuLaunchLogPath,
} from './psu-launch-log.mjs';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'psu-launch-log-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const OWNER = 'su-b053c5b3-8059-4a12-b17f-8225a3dcb6a4';

describe('psuLaunchLogPath', () => {
  it('derives a per-owner file under ~/.papercusp/<dirname>', () => {
    expect(psuLaunchLogPath(OWNER, { home })).toBe(
      join(home, '.papercusp', PSU_LAUNCH_LOG_DIRNAME, `${OWNER}.log`),
    );
    expect(psuLaunchLogRoot(home)).toBe(join(home, '.papercusp', PSU_LAUNCH_LOG_DIRNAME));
  });

  it('is PURE — asking for a path creates nothing', () => {
    // The readers call this on a display path. If merely asking the question
    // created a directory, a roster poll would litter the filesystem.
    psuLaunchLogPath(OWNER, { home });
    expect(existsSync(psuLaunchLogRoot(home))).toBe(false);
  });

  it('gives each launch its own file, so no launch can read another one', () => {
    // Owner ids are minted per launch; this is what makes truncate-on-open safe
    // and what stops a stale diagnostic being reported for a fresh failure.
    expect(psuLaunchLogPath('su-aaa', { home })).not.toBe(psuLaunchLogPath('su-bbb', { home }));
  });

  describe('rejects an owner id it cannot safely make a path from', () => {
    // SECURITY, not tidiness: this value becomes a path segment AND is
    // interpolated into a shell one-liner by launch-su's receipt path.
    it.each([
      ['traversal', '../../../../etc/passwd'],
      ['a slash', 'su-abc/def'],
      ['a shell metacharacter', 'su-abc;rm -rf /'],
      ['a quote', "su-abc'"],
      ['a space', 'su abc'],
      ['a newline', 'su-abc\nrm'],
      ['empty', ''],
      ['null', null],
      ['undefined', undefined],
      ['a non-string', 12345 as unknown as string],
      ['over-long', 'a'.repeat(129)],
    ])('%s', (_label, bad) => {
      expect(psuLaunchLogPath(bad as string | null | undefined, { home })).toBeNull();
      expect(ensurePsuLaunchLogPath(bad as string | null | undefined, { home })).toBeNull();
    });

    it('accepts the real minted shape (su-<uuid>)', () => {
      expect(psuLaunchLogPath(OWNER, { home })).not.toBeNull();
    });
  });
});

describe('readPsuLaunchLogTail', () => {
  it('distinguishes NO LOG (null) from A LOG THAT SAID NOTHING (empty string)', () => {
    // The whole point of the distinction: null means "we captured nothing, so
    // say nothing and fall back to the generic banner", while '' means "the
    // launch ran and printed nothing" — itself a finding. Collapsing them would
    // make a silent launch indistinguishable from an un-instrumented one.
    expect(readPsuLaunchLogTail(OWNER, { home })).toBeNull();

    const file = ensurePsuLaunchLogPath(OWNER, { home })!;
    writeFileSync(file, '   \n  ');
    expect(readPsuLaunchLogTail(OWNER, { home })).toBe('');
  });

  it('returns the TAIL, not the head — the failure is the last thing printed', () => {
    const file = ensurePsuLaunchLogPath(OWNER, { home })!;
    writeFileSync(file, `${'boot chatter\n'.repeat(200)}psu: the actual reason it died\n`);
    const tail = readPsuLaunchLogTail(OWNER, { home, chars: 60 })!;
    expect(tail).toContain('psu: the actual reason it died');
    expect(tail.length).toBeLessThanOrEqual(60);
  });

  it('never throws on an unreadable path — it is read on a display path', () => {
    // A directory where a file should be: readFileSync throws EISDIR.
    mkdirSync(join(psuLaunchLogRoot(home), `${OWNER}.log`), { recursive: true });
    expect(readPsuLaunchLogTail(OWNER, { home })).toBeNull();
  });

  it('returns null for a rejected owner id rather than reaching outside the dir', () => {
    expect(readPsuLaunchLogTail('../../etc/passwd', { home })).toBeNull();
  });
});

describe('readPsuLaunchLogTailAsync (EI-24748208098755918 — polled roster path)', () => {
  it('keeps the sync contract: null for no log, empty string for a silent one, and the TAIL', async () => {
    expect(await readPsuLaunchLogTailAsync(OWNER, { home })).toBeNull();

    const file = ensurePsuLaunchLogPath(OWNER, { home })!;
    writeFileSync(file, '   \n  ');
    expect(await readPsuLaunchLogTailAsync(OWNER, { home })).toBe('');

    writeFileSync(file, `${'boot chatter\n'.repeat(200)}psu: the actual reason it died\n`);
    const tail = (await readPsuLaunchLogTailAsync(OWNER, { home, chars: 60 }))!;
    expect(tail).toContain('psu: the actual reason it died');
    expect(tail.length).toBeLessThanOrEqual(60);
    // Same answer as the sync reader, byte for byte.
    expect(tail).toBe(readPsuLaunchLogTail(OWNER, { home, chars: 60 }));
  });

  it('never rejects: an unreadable path or a rejected owner id is null', async () => {
    mkdirSync(join(psuLaunchLogRoot(home), `${OWNER}.log`), { recursive: true });
    await expect(readPsuLaunchLogTailAsync(OWNER, { home })).resolves.toBeNull();
    await expect(readPsuLaunchLogTailAsync('../../etc/passwd', { home })).resolves.toBeNull();
  });
});

describe('headless pre-turn launch blockage', () => {
  const receiptFor = (file: string) => `headless (log: ${file})`;
  const headlessLog = (name = 'claude-headless-123-456.log') =>
    join(home, '.papercusp', 'fleet-logs', name);

  it('recognizes the live Claude weekly-limit dialog through ANSI/TUI paint', () => {
    const raw =
      '\x1b[?25l\x1b[12A\x1b[38;2;255;107;128m' +
      "You've hit your weekly limit \u00b7 resets 7am (America/New_York)\r" +
      '\x1b[1B\x1b[39m\x07';
    expect(detectPsuHeadlessLaunchBlockHint(raw)).toBe(
      "Claude's weekly usage limit was reached; it resets 7am (America/New_York). " +
        'Launch with Codex or an available account, or retry after the reset.',
    );
  });

  it('recognizes the live Codex ChatGPT invalid-model JSON instead of leaving the popup generic', () => {
    const raw =
      '\x1b[31m{"error":{"message":"The \'sol\' model is not supported when using Codex with a ChatGPT account.",' +
      '"type":"invalid_request_error"}}\x1b[0m';
    expect(detectPsuHeadlessLaunchBlockHint(raw)).toBe(
      'Codex rejected model `sol` for this ChatGPT account. ' +
        'Retry with a supported full Codex model id or choose another model.',
    );
  });

  it('does not turn ordinary boot chatter or a generic reset word into a diagnosis', () => {
    expect(detectPsuHeadlessLaunchBlockHint('Claude Code booting\nMCP connected')).toBeNull();
    expect(detectPsuHeadlessLaunchBlockHint('settings reset at 7am')).toBeNull();
  });

  it('identifies the measured native workspace-discovery timeout through TUI paint', () => {
    const raw = '\x1b[?25h\x1b[0 qError: account/read failed during TUI bootstrap: ' +
      'account/read failed: workspace routing discovery timed out (code -32603)\r\n';
    expect(isCodexWorkspaceDiscoveryTimeout(raw)).toBe(true);
    expect(detectPsuHeadlessLaunchBlockHint(raw)).toBe(
      'Codex timed out discovering its ChatGPT account workspace before model requests. ' +
      'Retry after connectivity recovers, or use --account=auto to route through the inference gateway.',
    );
    for (const unrelated of ['workspace routing discovery timed out',
      'Error: account/read failed during TUI bootstrap: invalid token',
      'Error: model request failed: quota exceeded', null]) {
      expect(isCodexWorkspaceDiscoveryTimeout(unrelated)).toBe(false);
      expect(detectPsuHeadlessLaunchBlockHint(unrelated)).toBeNull();
    }
  });

  it('reads only the bounded tail of the persisted headless receipt', async () => {
    const file = headlessLog();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      "You've hit your weekly limit \u00b7 resets 1am\n" + 'x'.repeat(HEADLESS_LAUNCH_LOG_SCAN_BYTES + 20),
    );
    expect(await readPsuHeadlessLaunchBlockHintAsync(receiptFor(file))).toBeNull();

    writeFileSync(file, `${'x'.repeat(200)}\nYou've hit your weekly limit \u00b7 resets 7am\n`);
    expect(await readPsuHeadlessLaunchBlockHintAsync(receiptFor(file), { scanBytes: 100 })).toContain(
      'resets 7am',
    );
  });

  it('rejects arbitrary paths and malformed receipts instead of becoming a file reader', async () => {
    const arbitrary = join(home, 'secret.log');
    writeFileSync(arbitrary, "You've hit your weekly limit \u00b7 resets 7am");
    expect(await readPsuHeadlessLaunchBlockHintAsync(receiptFor(arbitrary))).toBeNull();
    expect(await readPsuHeadlessLaunchBlockHintAsync(arbitrary)).toBeNull();
    expect(await readPsuHeadlessLaunchBlockHintAsync('headless (log: ../../secret.log)')).toBeNull();
  });

  it('degrades to null for a valid receipt whose file is absent', async () => {
    await expect(readPsuHeadlessLaunchBlockHintAsync(receiptFor(headlessLog()))).resolves.toBeNull();
  });
});

describe('prunePsuLaunchLogs', () => {
  it('removes logs past the TTL and keeps fresh ones', () => {
    const dir = psuLaunchLogRoot(home);
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'su-stale.log');
    const fresh = join(dir, 'su-fresh.log');
    writeFileSync(stale, 'old');
    writeFileSync(fresh, 'new');
    const longAgo = (Date.now() - PSU_LAUNCH_LOG_TTL_MS * 2) / 1000;
    utimesSync(stale, longAgo, longAgo);

    expect(prunePsuLaunchLogs({ home })).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('ignores non-log files and a missing directory, and never throws', () => {
    expect(prunePsuLaunchLogs({ home })).toBe(0); // no directory at all

    const dir = psuLaunchLogRoot(home);
    mkdirSync(dir, { recursive: true });
    const notALog = join(dir, 'README.txt');
    writeFileSync(notALog, 'x');
    const longAgo = (Date.now() - PSU_LAUNCH_LOG_TTL_MS * 2) / 1000;
    utimesSync(notALog, longAgo, longAgo);

    expect(prunePsuLaunchLogs({ home })).toBe(0);
    expect(existsSync(notALog)).toBe(true);
  });
});

describe('ensurePsuLaunchLogPath', () => {
  it('creates the directory (the WRITER seam) and returns the same path as the pure reader', () => {
    const written = ensurePsuLaunchLogPath(OWNER, { home });
    expect(written).toBe(psuLaunchLogPath(OWNER, { home }));
    expect(existsSync(psuLaunchLogRoot(home))).toBe(true);
    expect(readdirSync(psuLaunchLogRoot(home))).toEqual([]); // the dir, not the file
  });
});

/*
 * ⚠ THE WRITER↔READER AGREEMENT IS NOT ASSERTED HERE, DELIBERATELY.
 *
 * The invariant that actually matters — psu-launcher.mjs WRITES the file
 * adv-roster.ts READS — is only provable by EXECUTION: a source-text check that
 * each file mentions 'psu-launch-log.mjs' cannot tell an import from a comment,
 * and would keep passing while one side quietly derived a different path (the
 * exact silent-drift failure this module exists to prevent). So each half is
 * pinned where it can actually be run:
 *
 *   • WRITER → apps/operator/scripts/psu-launcher-boot-log.test.ts, which runs
 *     installBootLogCapture against a temp home and asserts the file it created
 *     is byte-identical to psuLaunchLogPath()'s answer.
 *   • RECEIPT → launch-su.test.ts, which drives the real route and asserts the
 *     tee target inside the emitted shell one-liner is psuLaunchLogPath(ownerId)
 *     for the owner the route actually minted.
 */
