/**
 * journal-read — guards for the semantics that are expensive to relearn.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-023 (D-027).
 *
 * Every case below pins something that has ALREADY gone wrong once in this repo
 * or is a quiet-wrongness trap of the same shape:
 *  - exit 1 vs a real failure (soak-report's fail-soft catch returned zeros and
 *    the OOM gate reported CLEAN while bg-host had restarted 9 times);
 *  - "no journal" vs "no lines" (ABSENT EVIDENCE MUST NEVER READ AS EVIDENCE OF
 *    ABSENCE);
 *  - the `--grep` PUSH-DOWN, which is the tool's entire reason to exist and would
 *    be silently undone by a refactor that filtered client-side instead.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildMacLogArgs,
  buildMacLogPredicate,
  buildHistoricalJournalctlArgs,
  buildJournalctlArgs,
  buildJournalReadSlices,
  clampLimit,
  classifyJournalctlFailure,
  collapseConsecutive,
  defaultUnitCanonicalizer,
  decodeMacPriority,
  decodeMacTimestamp,
  decodeMessage,
  defaultUnitLoadProbe,
  decodePriority,
  decodeRealtime,
  decodeUnit,
  journalBackendForPlatform,
  JOURNAL_READ_DEFAULT_LIMIT,
  JOURNAL_READ_DEFAULT_SINCE,
  JOURNAL_READ_MAX_LIMIT,
  normalizeJournalWindow,
  resolveRelativeWindowInProcess,
  UNIT_ID_CACHE_TTL_MS,
  parseMacLogJson,
  parseJournalJson,
  mergeJournalRecords,
  readJournal as readJournalImpl,
  type JournalScope,
  type JournalExec,
  type UnitCanonicalizer,
} from './journal-read';

/** Build one journalctl `-o json` line. */
function jsonLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ __REALTIME_TIMESTAMP: '1785110000000000', PRIORITY: '6', ...fields });
}

const execReturning = (stdout: string): JournalExec => async () => ({ stdout });

/** Default probe stub for the cases that are not ABOUT unknown units — without
 *  it an empty-result case would shell out to a real `systemctl`. */
const noUnknownUnits = async () => [];
const keepRequestedUnitNames: UnitCanonicalizer = async (units) => units;

// Most cases isolate journal parsing/diagnosis from systemd's external alias lookup.
const readJournal = (
  opts: Parameters<typeof readJournalImpl>[0],
  exec?: Parameters<typeof readJournalImpl>[1],
  probeUnits?: Parameters<typeof readJournalImpl>[2],
  resolveWindow?: Parameters<typeof readJournalImpl>[3],
) => readJournalImpl(opts, exec, probeUnits, resolveWindow, keepRequestedUnitNames);

describe('buildJournalctlArgs', () => {
  it('normalizes compact relative lookbacks while preserving native timestamp grammar', () => {
    const args = buildJournalctlArgs({ units: ['a.service'], since: '40m', until: '-2h' });
    expect(args[args.indexOf('--since') + 1]).toBe('-40 minutes');
    expect(args[args.indexOf('--until') + 1]).toBe('-2 hours');
    expect(buildJournalctlArgs({ units: ['a.service'], since: '2026-07-26 00:00' }))
      .toContain('2026-07-26 00:00');
  });

  it('normalizes all supported compact duration units to past windows', () => {
    expect(normalizeJournalWindow('5s')).toBe('-5 seconds');
    expect(normalizeJournalWindow('10m')).toBe('-10 minutes');
    expect(normalizeJournalWindow('-2h')).toBe('-2 hours');
    expect(normalizeJournalWindow('3d')).toBe('-3 days');
    expect(normalizeJournalWindow('1w')).toBe('-1 weeks');
  });

  it('normalizes bare spaced durations such as the documented `30 min` lookback', () => {
    expect(normalizeJournalWindow('30 min')).toBe('-30 minutes');
    expect(normalizeJournalWindow('  40 min  ')).toBe('-40 minutes');
    expect(normalizeJournalWindow('2 hours')).toBe('-2 hours');
    expect(normalizeJournalWindow('-3 days')).toBe('-3 days');
    expect(normalizeJournalWindow('30 minutes ago')).toBe('30 minutes ago');
    expect(normalizeJournalWindow('2026-07-26 00:00')).toBe('2026-07-26 00:00');
  });

  it('PUSHES grep down to --grep — the whole reason this tool exists', () => {
    const args = buildJournalctlArgs({ units: ['papercup-bg-host.service'], grep: 'oom|killed process' });
    const at = args.indexOf('--grep');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('oom|killed process');
    // Case-insensitive, matching the `grep -i` the corpus hand-wrote.
    expect(args).toContain('--case-sensitive=false');
  });

  it('builds a bounded unscoped fallback for an exited transient unit', () => {
    const args = buildHistoricalJournalctlArgs(
      { units: ['gone.service'], since: '-20m', grep: 'error|failed' },
      ['gone.service'],
      4,
    );
    expect(args).not.toContain('-u');
    expect(args[args.indexOf('--since') + 1]).toBe('-20 minutes');
    expect(args[args.indexOf('-n') + 1]).toBe('5');
    // Preserve the caller's grep server-side; unit attribution is checked from
    // decoded fields/message after this bounded unscoped read.
    expect(args[args.indexOf('--grep') + 1]).toBe('error|failed');
  });

  it('omits --grep entirely when no pattern is given (never an empty filter)', () => {
    expect(buildJournalctlArgs({ units: ['u.service'] })).not.toContain('--grep');
  });

  it('unit-scopes with -u per unit, and merges several units into one stream', () => {
    const args = buildJournalctlArgs({ units: ['a.service', 'b.timer'] });
    expect(args.filter((a) => a === '-u')).toHaveLength(2);
    expect(args).toContain('a.service');
    expect(args).toContain('b.timer');
  });

  it('defaults the window rather than reading unbounded history', () => {
    const args = buildJournalctlArgs({ units: ['a.service'] });
    expect(args[args.indexOf('--since') + 1]).toBe(JOURNAL_READ_DEFAULT_SINCE);
  });

  it('reads --user by default and --system only when asked (kernel/OOM records)', () => {
    expect(buildJournalctlArgs({ units: ['a.service'] })).toContain('--user');
    expect(buildJournalctlArgs({ units: ['a.service'], scope: 'system' })).toContain('--system');
    expect(buildJournalctlArgs({ units: ['a.service'], scope: 'system' })).not.toContain('--user');
  });

  it("scope 'all' passes NEITHER flag — that IS how journalctl says 'everything I can see'", () => {
    const args = buildJournalctlArgs({ units: ['a.service'], scope: 'all' });
    expect(args).not.toContain('--user');
    expect(args).not.toContain('--system');
    // …and it is still a real read, not an empty argv.
    expect(args).toContain('-u');
  });

  it('asks journalctl for limit+1 rows so `truncated` is measured, not guessed', () => {
    const args = buildJournalctlArgs({ units: ['a.service'], limit: 25 });
    expect(args[args.indexOf('-n') + 1]).toBe('26');
  });

  it('always disables the pager (a pager on a pipe hangs the read)', () => {
    expect(buildJournalctlArgs({ units: ['a.service'] })).toContain('--no-pager');
  });

  it('restricts --output-fields so -o json stays affordable', () => {
    const args = buildJournalctlArgs({ units: ['a.service'] });
    const flag = args.find((a) => a.startsWith('--output-fields='));
    expect(flag).toBeDefined();
    expect(flag).toContain('MESSAGE');
    expect(flag).toContain('_SYSTEMD_UNIT');
    expect(flag).toContain('__REALTIME_TIMESTAMP');
  });

  it('passes level through as journalctl -p (this level AND more severe)', () => {
    const args = buildJournalctlArgs({ units: ['a.service'], level: 'err' });
    expect(args[args.indexOf('-p') + 1]).toBe('err');
  });
});

describe('time-sliced journal reads', () => {
  it('builds newest-first @epoch slices without local-time parsing', () => {
    expect(buildJournalReadSlices(0, 3 * 60 * 60 * 1000, 60 * 60 * 1000)).toEqual([
      { since: '@7200', until: '@10800' },
      { since: '@3600', until: '@7200' },
      { since: '@0', until: '@3600' },
    ]);
  });

  it('merges slices chronologically and removes only boundary duplicates', () => {
    const record = (ts: string, message: string) => ({
      ts,
      unit: 'a.service',
      level: 'info' as const,
      message,
      clipped: false,
    });
    expect(mergeJournalRecords([
      [record('2026-08-24T01:00:00.000Z', 'old'), record('2026-08-24T02:00:00.000Z', 'edge')],
      [record('2026-08-24T02:00:00.000Z', 'edge'), record('2026-08-24T03:00:00.000Z', 'new')],
    ]).map((entry) => entry.message)).toEqual(['old', 'edge', 'new']);
  });
});

describe('macOS unified-log backend', () => {
  it('selects the native unified log only on Darwin and reports unsupported hosts explicitly', () => {
    expect(journalBackendForPlatform('darwin')).toBe('macos-unified');
    expect(journalBackendForPlatform('linux')).toBe('systemd');
    expect(journalBackendForPlatform('win32')).toBe('none');
  });

  it('pushes unit, grep, and severity filters into log show predicates', () => {
    const predicate = buildMacLogPredicate({
      units: ['papercup-bg-host.service'],
      identifier: 'papercup',
      grep: 'oom|killed process',
      level: 'err',
    });
    expect(predicate).toContain('process == "papercup-bg-host"');
    expect(predicate).toContain('processImagePath ENDSWITH "/papercup-bg-host"');
    expect(predicate).toContain('eventMessage MATCHES[c] "oom|killed process"');
    expect(predicate).toContain('messageType IN {"fault", "error"}');
    expect(predicate).toContain('subsystem == "papercup"');
  });

  it('builds a bounded-window log show command and translates compact lookbacks', () => {
    const args = buildMacLogArgs({ units: ['papercup-bg-host.service'], since: '40m', limit: 25 });
    expect(args.slice(0, 5)).toEqual(['show', '--no-pager', '--style', 'json', '--info']);
    expect(args[args.indexOf('--last') + 1]).toBe('40m');
    expect(args).toContain('--predicate');
    expect(args.join(' ')).not.toContain('journalctl');
  });

  it.each([
    ['-10 min', '10m'],
    ['-5 sec', '5s'],
    ['-2 hrs', '2h'],
  ])('translates signed spaced lookback %s into log show --last %s', (since, last) => {
    const args = buildMacLogArgs({ units: ['papercup-bg-host.service'], since });
    expect(args.slice(args.indexOf('--last'), args.indexOf('--last') + 2)).toEqual(['--last', last]);
    expect(args).not.toContain('--start');
  });

  it('decodes Apple timestamps and messageType values onto the shared result scale', () => {
    expect(decodeMacTimestamp('2026-08-20 12:34:56.123 -0400')).toBe('2026-08-20T16:34:56.123Z');
    expect(decodeMacPriority('fault')).toBe('crit');
    expect(decodeMacPriority('error')).toBe('err');
    expect(decodeMacPriority('default')).toBe('notice');
    expect(decodeMacPriority('unknown')).toBeNull();
  });

  it('parses both event arrays and the terminal finished marker from ndjson-like output', () => {
    const out = parseMacLogJson(JSON.stringify([
      {
        timestamp: '2026-08-20 12:34:56.123 -0400',
        process: 'papercup-bg-host',
        messageType: 'error',
        eventMessage: 'boom',
      },
      { finished: true },
    ]));
    expect(out).toEqual([{
      ts: '2026-08-20T16:34:56.123Z',
      unit: 'papercup-bg-host',
      level: 'err',
      message: 'boom',
      clipped: false,
    }]);
  });

  it('reads Darwin logs through `log show`, reports the selected backend, and caps newest rows', async () => {
    const stdout = [0, 1, 2].map((i) => JSON.stringify({
      timestamp: `2026-08-20 12:34:5${i}.123 -0400`,
      process: 'papercup-bg-host',
      messageType: 'error',
      eventMessage: `line-${i}`,
    })).join('\n');
    const out = await readJournal(
      { platform: 'darwin', units: ['papercup-bg-host.service'], limit: 2 },
      execReturning(stdout),
      vi.fn(async () => ['should-not-run']),
    );
    expect(out.backend).toBe('macos-unified');
    expect(out.journalAvailable).toBe(true);
    expect(out.journalError).toBeNull();
    expect(out.truncated).toBe(true);
    expect(out.matched).toBe(3);
    expect(out.entries.map((entry) => entry.message)).toEqual(['line-1', 'line-2']);
    expect(out.command).toMatch(/^log show /);
  });

  it('falls back to backend:none when the native log binary is absent', async () => {
    const exec: JournalExec = async () => {
      throw Object.assign(new Error('spawn log ENOENT'), { code: 'ENOENT' });
    };
    const out = await readJournal({ platform: 'darwin', units: ['papercup-bg-host.service'] }, exec);
    expect(out).toMatchObject({
      backend: 'none',
      journalAvailable: false,
      journalError: null,
      entries: [],
    });
  });

  it('does not invoke a journal command on an unsupported platform', async () => {
    const exec = vi.fn(async () => ({ stdout: 'should-not-run' }));
    const out = await readJournal({ platform: 'win32', units: ['papercup-bg-host.service'] }, exec);
    expect(exec).not.toHaveBeenCalled();
    expect(out).toMatchObject({ backend: 'none', journalAvailable: false, entries: [] });
  });
});

describe('clampLimit', () => {
  it('defaults, floors and ceilings without ever returning 0 or NaN', () => {
    expect(clampLimit(undefined)).toBe(JOURNAL_READ_DEFAULT_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(JOURNAL_READ_DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(10_000)).toBe(JOURNAL_READ_MAX_LIMIT);
    expect(clampLimit(37.9)).toBe(37);
  });
});

describe('classifyJournalctlFailure', () => {
  it('treats exit 1 with EMPTY stderr as NO MATCH — a clean window, not a failure', () => {
    expect(classifyJournalctlFailure({ code: 1, stderr: '' })).toMatchObject({ kind: 'no-match' });
    expect(classifyJournalctlFailure({ code: 1, stderr: '   \n' })).toMatchObject({ kind: 'no-match' });
  });

  it('treats exit 1 WITH stderr as a real error — the read did not succeed', () => {
    const out = classifyJournalctlFailure({ code: 1, stderr: 'Failed to add match: Invalid argument' });
    expect(out.kind).toBe('error');
    expect(out.message).toContain('Invalid argument');
  });

  it('treats ENOENT as NO SYSTEMD — a platform capability, not an error', () => {
    expect(classifyJournalctlFailure({ code: 'ENOENT' })).toMatchObject({ kind: 'no-systemd' });
  });

  it('falls back to the error message when there is no stderr', () => {
    expect(classifyJournalctlFailure(new Error('spawn timed out')).message).toContain('spawn timed out');
  });

  it('classifies an exec-TIMEOUT kill as `timeout`, not a bare generic error (EI-19980767336148101)', () => {
    // Node's own execFile({ timeout }) contract on a killed child: killed:true,
    // code:null, and (because the child never got to print anything) empty
    // stderr — measured live against a slow --grep + wide `since` + `-n` tail
    // cap scan of a chatty unit. This shape used to fall through to the
    // catch-all `error` branch with an opaque "Command failed: <argv>" message.
    const out = classifyJournalctlFailure({ killed: true, code: null, signal: 'SIGTERM', stderr: '' });
    expect(out.kind).toBe('timeout');
    expect(out.message).toContain('killed');
    expect(out.message).toContain('SIGTERM');
  });

  it('a TIMEOUT kill is never misread as the --grep-matched-nothing clean case', () => {
    // Both share `code` outside {1, 'ENOENT'} and empty stderr, so a naive
    // check could conflate them — a timeout must never come back as 'no-match'.
    expect(classifyJournalctlFailure({ killed: true, code: null, stderr: '' }).kind).not.toBe('no-match');
  });
});

describe('parseJournalJson', () => {
  it('decodes a MESSAGE stored as an ARRAY OF BYTES (non-UTF8 payloads)', () => {
    const bytes = [...Buffer.from('build failed', 'utf8')];
    expect(parseJournalJson(jsonLine({ MESSAGE: bytes }))[0].message).toBe('build failed');
  });

  it('never renders a byte-array message as "72,101,..." — that looks like data and is not', () => {
    const bytes = [...Buffer.from('hi', 'utf8')];
    expect(parseJournalJson(jsonLine({ MESSAGE: bytes }))[0].message).not.toContain(',');
  });

  it('SKIPS malformed lines instead of failing the whole read', () => {
    const stdout = ['-- No entries --', jsonLine({ MESSAGE: 'real' }), 'not json at all'].join('\n');
    const out = parseJournalJson(stdout);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('real');
  });

  it('drops a record with no MESSAGE rather than emitting an empty row', () => {
    expect(parseJournalJson(jsonLine({ MESSAGE: null }))).toHaveLength(0);
  });

  it('clips an oversized message and flags it', () => {
    const out = parseJournalJson(jsonLine({ MESSAGE: 'x'.repeat(5000) }))[0];
    expect(out.clipped).toBe(true);
    expect(out.message.length).toBeLessThan(5000);
  });
});

describe('field decoding', () => {
  it('reads __REALTIME_TIMESTAMP as MICROSECONDS since the epoch', () => {
    // 1_785_110_000_000_000µs = 1_785_110_000_000ms
    expect(decodeRealtime('1785110000000000')).toBe(new Date(1_785_110_000_000).toISOString());
  });

  it('returns an empty ts rather than an Invalid Date for junk', () => {
    expect(decodeRealtime('nope')).toBe('');
    expect(decodeRealtime(undefined)).toBe('');
  });

  it('maps the numeric-string PRIORITY to a severity name', () => {
    expect(decodePriority('0')).toBe('emerg');
    expect(decodePriority('3')).toBe('err');
    expect(decodePriority('7')).toBe('debug');
    expect(decodePriority('8')).toBeNull();
    expect(decodePriority(undefined)).toBeNull();
  });

  it('prefers _SYSTEMD_USER_UNIT over _SYSTEMD_UNIT — the latter is the SESSION CONTAINER for a user unit', () => {
    // Live verification caught this: every bg-host line came back attributed to
    // `user@1000.service` because only `_SYSTEMD_UNIT` was read.
    expect(decodeUnit({
      _SYSTEMD_UNIT: 'user@1000.service',
      _SYSTEMD_USER_UNIT: 'papercup-bg-host.service',
    })).toBe('papercup-bg-host.service');
  });

  it('falls back from _SYSTEMD_UNIT to SYSLOG_IDENTIFIER, then null', () => {
    expect(decodeUnit({ _SYSTEMD_UNIT: 'a.service', SYSLOG_IDENTIFIER: 'x' })).toBe('a.service');
    expect(decodeUnit({ SYSLOG_IDENTIFIER: 'oddsmith-alert' })).toBe('oddsmith-alert');
    expect(decodeUnit({})).toBeNull();
  });

  it('asks journalctl for the user-unit field, or the fix above can never fire', () => {
    const flag = buildJournalctlArgs({ units: ['a.service'] }).find((a) => a.startsWith('--output-fields='));
    expect(flag).toContain('_SYSTEMD_USER_UNIT');
  });

  it('decodeMessage passes a plain string straight through', () => {
    expect(decodeMessage('plain')).toBe('plain');
    expect(decodeMessage(42)).toBeNull();
  });
});

describe('collapseConsecutive', () => {
  const rec = (ts: string, message: string, unit = 'a.service') =>
    ({ ts, unit, level: 'info' as const, message, clipped: false });

  it('collapses a consecutive run into one row with a count and the LAST ts', () => {
    const { entries, collapsed } = collapseConsecutive([
      rec('t1', 'retrying'), rec('t2', 'retrying'), rec('t3', 'retrying'),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ repeat: 3, ts: 't1', lastTs: 't3' });
    expect(collapsed).toBe(2);
  });

  it('does NOT collapse identical lines separated by a different line — chronology survives', () => {
    const { entries, collapsed } = collapseConsecutive([
      rec('t1', 'tick'), rec('t2', 'boom'), rec('t3', 'tick'),
    ]);
    expect(entries).toHaveLength(3);
    expect(collapsed).toBe(0);
  });

  it('does not merge the same message from DIFFERENT units', () => {
    const { entries } = collapseConsecutive([rec('t1', 'up', 'a.service'), rec('t2', 'up', 'b.service')]);
    expect(entries).toHaveLength(2);
  });

  it('leaves an uncollapsed row at repeat:1 with no lastTs', () => {
    const [entry] = collapseConsecutive([rec('t1', 'once')]).entries;
    expect(entry.repeat).toBe(1);
    expect(entry.lastTs).toBeUndefined();
  });
});

describe('readJournal', () => {
  it('reports a NO-MATCH exit as a clean readable window, NOT an error', async () => {
    const exec: JournalExec = async () => { throw Object.assign(new Error('exit 1'), { code: 1, stderr: '' }); };
    const out = await readJournal({ units: ['a.service'], grep: 'nope' }, exec, noUnknownUnits);
    expect(out.entries).toEqual([]);
    expect(out.journalAvailable).toBe(true);
    expect(out.journalError).toBeNull();
  });

  it('reports an absent journal as journalAvailable:false — never as an empty log', async () => {
    const exec: JournalExec = async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    const out = await readJournal({ units: ['a.service'] }, exec);
    expect(out.journalAvailable).toBe(false);
    expect(out.journalError).toBeNull();
    expect(out.entries).toEqual([]);
  });

  it('reports a FAILED read with journalError set, so empty entries cannot be read as clean', async () => {
    const exec: JournalExec = async () => {
      throw Object.assign(new Error('boom'), { code: 1, stderr: 'Failed to add match' });
    };
    const out = await readJournal({ units: ['a.service'] }, exec);
    expect(out.journalError).toContain('Failed to add match');
    expect(out.journalAvailable).toBe(true);
  });

  it('keeps the NEWEST rows and flags truncation when the read exceeds `limit`', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      jsonLine({ MESSAGE: `line-${i}`, __REALTIME_TIMESTAMP: String(1785110000000000 + i * 1_000_000) }));
    const out = await readJournal({ units: ['a.service'], limit: 3 }, execReturning(lines.join('\n')));
    expect(out.truncated).toBe(true);
    expect(out.matched).toBe(5);
    expect(out.entries.map((e) => e.message)).toEqual(['line-2', 'line-3', 'line-4']);
  });

  it('does not flag truncation when the read fits', async () => {
    const out = await readJournal({ units: ['a.service'], limit: 10 }, execReturning(jsonLine({ MESSAGE: 'one' })));
    expect(out.truncated).toBe(false);
    expect(out.matched).toBe(1);
  });

  it('counts `matched` BEFORE dedup, and reports what dedup removed', async () => {
    const lines = Array.from({ length: 4 }, (_, i) =>
      jsonLine({ MESSAGE: 'same', _SYSTEMD_UNIT: 'a.service', __REALTIME_TIMESTAMP: String(1785110000000000 + i) }));
    const out = await readJournal({ units: ['a.service'] }, execReturning(lines.join('\n')));
    expect(out.matched).toBe(4);
    expect(out.collapsed).toBe(3);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].repeat).toBe(4);
  });

  it('keeps a reverse-scanned grep run chronological before collapsing its timestamp bounds', async () => {
    const baseMicros = 1785110000000000;
    // journalctl --grep can return a narrow capped scan newest-first. Keep this
    // order in the fixture so the read path must normalize it before collapsing.
    const lines = [2, 1, 0].map((index) => jsonLine({
      MESSAGE: 'socket reset',
      _SYSTEMD_UNIT: 'a.service',
      __REALTIME_TIMESTAMP: String(baseMicros + index * 1_000_000),
    }));
    const sinceMs = Date.now() - 50_000;
    const out = await readJournal(
      { units: ['a.service'], grep: 'socket reset', since: '50s', limit: 10 },
      execReturning(lines.join('\n')),
      noUnknownUnits,
      async () => sinceMs,
    );

    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      ts: new Date(baseMicros / 1000).toISOString(),
      lastTs: new Date((baseMicros + 2_000_000) / 1000).toISOString(),
      repeat: 3,
    });
    expect(out.collapsed).toBe(2);
  });

  it('echoes the exact argv so any result is reproducible by hand', async () => {
    const out = await readJournal({ units: ['a.service'], grep: 'boom' }, execReturning(''), noUnknownUnits);
    expect(out.command).toContain('journalctl');
    expect(out.command).toContain('--grep boom');
    expect(out.command).toContain('-u a.service');
  });

  it('reports the window it actually used, including the defaulted one', async () => {
    const out = await readJournal({ units: ['a.service'] }, execReturning(''), noUnknownUnits);
    expect(out.window.since).toBe(JOURNAL_READ_DEFAULT_SINCE);
    expect(out.window.until).toBeNull();
    // P-022: these reads are EMPTY, so the absolute window is resolved and stated
    // too. Asserted by shape, not value — the default resolver shells out to the
    // host's systemd-analyze, so `sinceUtc` is legitimately null where that is
    // absent, while the object itself is present either way (see the field doc:
    // `resolved: null` means NOT ATTEMPTED, which is a different answer).
    expect(out.window.resolved).not.toBeNull();
    expect(out.window.resolved!.untilRequested).toBe(false);
    expect(out.window.resolved!.invertedHint).toBeNull();
  });

  it('reports the normalized window for compact relative lookbacks', async () => {
    const out = await readJournal({ units: ['a.service'], since: '40m' }, execReturning(''), noUnknownUnits);
    expect(out.window.since).toBe('-40 minutes');
    expect(out.window.until).toBeNull();
    expect(out.command).toContain('--since -40 minutes');
  });

  it('splits a wide grep window, merges slices, and applies the global newest-row cap', async () => {
    const calls: string[][] = [];
    const sinceMs = Date.now() - 3 * 60 * 60 * 1000;
    const exec: JournalExec = async (args) => {
      calls.push(args);
      const index = calls.length;
      return {
        stdout: jsonLine({
          MESSAGE: `slice-${index}`,
          __REALTIME_TIMESTAMP: String(1785110000000000 + index * 1_000_000),
        }),
      };
    };
    const out = await readJournal(
      { units: ['a.service'], grep: 'needle', since: '-3 hours', limit: 2 },
      exec,
      noUnknownUnits,
      async () => sinceMs,
    );

    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((args) => args.includes('--until'))).toBe(true);
    expect(calls.every((args) => args.some((arg) => arg.startsWith('@')))).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.matched).toBe(3); // limit + 1, the same bounded floor as one read
    expect(out.entries.map((entry) => entry.message)).toEqual([
      `slice-${calls.length - 1}`,
      `slice-${calls.length}`,
    ]);
  });
});

describe('readJournal — all-journal unit selection', () => {
  it.each<{ scope: JournalScope; messages: string[] }>([
    { scope: 'user', messages: ['user scope marker'] },
    { scope: 'system', messages: ['system scope marker'] },
    { scope: 'all', messages: ['system scope marker', 'user scope marker'] },
  ])('reads the requested unit in scope $scope', async ({ scope, messages }) => {
    const unit = 'papercup-mcp-proxy-staging.service';
    // journalctl -u selects system units unless --user remaps it. Without a
    // scope flag, --user-unit adds the user-unit arm to the same OR query.
    const exec: JournalExec = async (args) => {
      const selects = (option: string) => args.some((arg, index) =>
        arg === option && args[index + 1] === unit);
      const rows: string[] = [];
      if (!args.includes('--user') && selects('-u')) {
        rows.push(jsonLine({ _SYSTEMD_UNIT: unit, MESSAGE: 'system scope marker' }));
      }
      if ((args.includes('--user') && selects('-u')) || selects('--user-unit')) {
        rows.push(jsonLine({
          _SYSTEMD_UNIT: 'user@1000.service',
          _SYSTEMD_USER_UNIT: unit,
          MESSAGE: 'user scope marker',
          __REALTIME_TIMESTAMP: '1785110001000000',
        }));
      }
      return { stdout: rows.join('\n') };
    };
    const out = await readJournal({ units: [unit], scope }, exec, noUnknownUnits);

    expect(out.entries.map((entry) => entry.message)).toEqual(messages);
    expect(out.entries.every((entry) => entry.unit === unit)).toBe(true);
    expect(out.unitsUnknown).toEqual([]);
    expect(out.matched).toBe(messages.length);
  });
});

describe('readJournal — canonical systemd unit names', () => {
  it('queries the systemd Id for an alias instead of returning a false clean zero', async () => {
    const requestedUnit = 'papercup-bg-host.service';
    const canonicalUnit = 'papercusp-bg-host.service';
    const calls: string[][] = [];
    const runSystemctl = vi.fn(async (_file: string, _args: string[]) => ({
      stdout: `${canonicalUnit}\n`,
      stderr: '',
    }));
    const exec: JournalExec = async (args) => {
      calls.push(args);
      return {
        stdout: args.includes(canonicalUnit)
          ? jsonLine({
            _SYSTEMD_USER_UNIT: canonicalUnit,
            MESSAGE: 'own_log_compaction completed',
          })
          : '',
      };
    };
    const canonicalizeUnits = vi.fn((units: string[], scope: JournalScope) =>
      defaultUnitCanonicalizer(units, scope, runSystemctl),
    );
    const out = await readJournalImpl(
      { units: [requestedUnit], grep: 'own_log_compaction' },
      exec,
      noUnknownUnits,
      async () => null,
      canonicalizeUnits,
    );

    expect(canonicalizeUnits).toHaveBeenCalledWith([requestedUnit], 'user');
    expect(runSystemctl).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'show', '-p', 'Id', '--value', requestedUnit],
      { timeout: 3000 },
    );
    expect(calls[0]).toContain(canonicalUnit);
    expect(out.command).toContain(canonicalUnit);
    expect(out.units).toEqual([requestedUnit]);
    expect(out.entries.map((entry) => entry.message)).toEqual(['own_log_compaction completed']);
  });

  it('keeps the requested name when the manager cannot supply a canonical Id', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await expect(defaultUnitCanonicalizer(['gone.service'], 'user', runSystemctl))
      .resolves.toEqual(['gone.service']);
  });

  it('resolves both journal managers when the caller asks for scope all', async () => {
    const runSystemctl = vi.fn(async (_file: string, args: string[]) => ({
      stdout: args[0] === '--user' ? 'user-alias.service\n' : 'system-alias.service\n',
      stderr: '',
    }));
    await expect(defaultUnitCanonicalizer(['alias.service'], 'all', runSystemctl))
      .resolves.toEqual(['user-alias.service', 'system-alias.service']);
    expect(runSystemctl).toHaveBeenCalledTimes(2);
  });

  // WI-6554700010008328: each systemctl call is a fork of the multi-GB bg-host.
  it('reuses a resolved Id instead of spawning systemctl on every read', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: 'canonical.service\n', stderr: '' }));
    await expect(defaultUnitCanonicalizer(['alias.service'], 'user', runSystemctl))
      .resolves.toEqual(['canonical.service']);
    await expect(defaultUnitCanonicalizer(['alias.service'], 'user', runSystemctl))
      .resolves.toEqual(['canonical.service']);
    expect(runSystemctl).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight lookup between concurrent reads of the same unit', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: 'canonical.service\n', stderr: '' }));
    const both = await Promise.all([
      defaultUnitCanonicalizer(['alias.service'], 'user', runSystemctl),
      defaultUnitCanonicalizer(['alias.service'], 'user', runSystemctl),
    ]);
    expect(both).toEqual([['canonical.service'], ['canonical.service']]);
    expect(runSystemctl).toHaveBeenCalledTimes(1);
  });

  it('does not cache a non-answer, so a unit installed later resolves at once', async () => {
    const runSystemctl = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('systemctl timed out'))
      .mockResolvedValueOnce({ stdout: 'late.service\n', stderr: '' });
    await expect(defaultUnitCanonicalizer(['late-alias.service'], 'user', runSystemctl))
      .resolves.toEqual(['late-alias.service']);
    await expect(defaultUnitCanonicalizer(['late-alias.service'], 'user', runSystemctl))
      .resolves.toEqual(['late-alias.service']);
    await expect(defaultUnitCanonicalizer(['late-alias.service'], 'user', runSystemctl))
      .resolves.toEqual(['late.service']);
    expect(runSystemctl).toHaveBeenCalledTimes(3);
  });

  it('asks systemd again once the cached Id is older than the TTL', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-11T08:00:00Z'));
      const runSystemctl = vi.fn()
        .mockResolvedValueOnce({ stdout: 'old.service\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'new.service\n', stderr: '' });
      await expect(defaultUnitCanonicalizer(['alias.service'], 'user', runSystemctl))
        .resolves.toEqual(['old.service']);
      vi.setSystemTime(Date.now() + UNIT_ID_CACHE_TTL_MS - 1);
      await expect(defaultUnitCanonicalizer(['alias.service'], 'user', runSystemctl))
        .resolves.toEqual(['old.service']);
      vi.setSystemTime(Date.now() + 2);
      await expect(defaultUnitCanonicalizer(['alias.service'], 'user', runSystemctl))
        .resolves.toEqual(['new.service']);
      expect(runSystemctl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the user and system managers apart in the cache', async () => {
    const runSystemctl = vi.fn(async (_file: string, args: string[]) => ({
      stdout: args[0] === '--user' ? 'user-id.service\n' : 'system-id.service\n',
      stderr: '',
    }));
    await expect(defaultUnitCanonicalizer(['shared.service'], 'user', runSystemctl))
      .resolves.toEqual(['user-id.service']);
    await expect(defaultUnitCanonicalizer(['shared.service'], 'system', runSystemctl))
      .resolves.toEqual(['system-id.service']);
    expect(runSystemctl).toHaveBeenCalledTimes(2);
  });
});

/**
 * WI-6554700010008328: the window specs this module produces are resolved without
 * spawning systemd-analyze. Parity with systemd was measured on 2026-10-11 for
 * every accepted form (difference = the spawn's own latency, 10–13 ms); the
 * fallbacks below are forms whose meaning only systemd can supply.
 */
describe('resolveRelativeWindowInProcess', () => {
  const now = Date.parse('2026-10-11T08:00:00Z');

  it.each([
    ['-30 minutes', now - 30 * 60_000],
    ['-10 min', now - 10 * 60_000],
    ['-5m', now - 5 * 60_000],
    ['-2h', now - 2 * 3_600_000],
    ['-90s', now - 90_000],
    ['2 hours ago', now - 2 * 3_600_000],
    ['3 days ago', now - 3 * 86_400_000],
    ['-1 w', now - 604_800_000],
    ['@1791706800', 1_791_706_800_000],
    ['@1791706800.5', 1_791_706_800_500],
  ])('resolves %s in-process', (spec, expected) => {
    expect(resolveRelativeWindowInProcess(spec, now)).toBe(expected);
  });

  it('round-trips every lookback normalizeJournalWindow produces', () => {
    for (const shorthand of ['30m', '2h', '1d', '1w', '45 s', '-15m']) {
      expect(resolveRelativeWindowInProcess(normalizeJournalWindow(shorthand), now))
        .not.toBeUndefined();
    }
  });

  it.each([
    // systemd reads capital M as MONTHS, not minutes.
    '-5 M',
    '1 month ago',
    'yesterday',
    'today',
    '-1h30min',
    '2026-10-11 08:00:00 UTC',
    '-5 msec',
    '',
  ])('leaves %j to systemd-analyze', (spec) => {
    expect(resolveRelativeWindowInProcess(spec, now)).toBeUndefined();
  });
});

/**
 * The trap this section guards: journalctl exits 0 with ZERO lines for a unit
 * that has never existed. So a typo'd unit name is byte-identical to a healthy,
 * silent service — the absent-evidence-reads-as-evidence-of-absence shape again,
 * now in the one place a caller is most likely to act on it ("no errors logged").
 */
describe('readJournal — an empty result from a unit that does not exist', () => {
  const probeSaying = (unknown: string[]) => async () => unknown;

  it('names the unknown unit instead of reporting a clean window', async () => {
    const out = await readJournal(
      { units: ['papercup-typo.service'] },
      execReturning(''),
      probeSaying(['papercup-typo.service']),
    );
    expect(out.entries).toEqual([]);
    expect(out.unitsUnknown).toEqual(['papercup-typo.service']);
  });

  it('reports no unknown units when the unit exists and the window is simply clean', async () => {
    const out = await readJournal({ units: ['papercup-bg-host.service'] }, execReturning(''), probeSaying([]));
    expect(out.unitsUnknown).toEqual([]);
  });

  it('recovers historical records after a transient unit leaves systemd', async () => {
    const unit = 'papercup-green-checkpoint-manual-1fxzuva.service';
    const calls: string[][] = [];
    const exec: JournalExec = async (args) => {
      calls.push(args);
      return { stdout: args.includes('-u') ? '' : jsonLine({ MESSAGE: `${unit}: Consumed 56s CPU time.` }) };
    };
    const out = await readJournal(
      { units: [unit], since: '-20 min' },
      exec,
      probeSaying([unit]),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain('-u');
    expect(out.entries[0]?.message).toContain(unit);
    expect(out.unitsUnknown).toEqual([]);
    expect(out.unitsHistorical).toEqual([unit]);
    expect(out.historicalCommand).toContain('--grep');
    expect(out.matched).toBe(1);
  });

  it('also resolves the ambiguity on the --grep-matched-nothing exit path', async () => {
    const exec: JournalExec = async () => { throw Object.assign(new Error('exit 1'), { code: 1, stderr: '' }); };
    const out = await readJournal({ units: ['gone.service'], grep: 'x' }, exec, probeSaying(['gone.service']));
    expect(out.journalError).toBeNull();
    expect(out.unitsUnknown).toEqual(['gone.service']);
  });

  it('does NOT pay for the probe when lines came back', async () => {
    const probe = vi.fn(async () => ['never.service']);
    const out = await readJournal({ units: ['a.service'] }, execReturning(jsonLine({ MESSAGE: 'x' })), probe);
    expect(probe).not.toHaveBeenCalled();
    expect(out.unitsUnknown).toEqual([]);
  });

  it('does NOT probe when no unit was named — there is nothing to be wrong about', async () => {
    const probe = vi.fn(async () => []);
    await readJournal({ since: '-10 min' }, execReturning(''), probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it('does NOT probe when the host has no journal at all', async () => {
    const probe = vi.fn(async () => []);
    const exec: JournalExec = async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    await readJournal({ units: ['a.service'] }, exec, probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it('tells the probe WHICH journal was read, so it asks the right systemd manager', async () => {
    const probe = vi.fn(async () => []);
    await readJournal({ units: ['systemd-oomd.service'], scope: 'system' }, execReturning(''), probe);
    expect(probe).toHaveBeenCalledWith(['systemd-oomd.service'], 'system');
  });
});

/**
 * The false-zero this whole module now guards against directly
 * (EI-19980767336148101): a FAILED or TIMED-OUT read must never report
 * `matched: 0` — that is byte-identical to a genuinely clean window unless the
 * caller separately checks `journalError`, and a slow `--grep` + wide `since`
 * + `-n` tail cap against a chatty unit hits the exec timeout for real.
 */
describe('readJournal — a failed or timed-out read never reports matched:0', () => {
  it('reports matched:null (not 0) on a generic journalctl error', async () => {
    const exec: JournalExec = async () => {
      throw Object.assign(new Error('boom'), { code: 1, stderr: 'Failed to add match: Invalid argument' });
    };
    const out = await readJournal({ units: ['a.service'], grep: 'x' }, exec, noUnknownUnits);
    expect(out.journalError).not.toBeNull();
    expect(out.matched).toBeNull();
    expect(out.entries).toEqual([]);
  });

  it('reports matched:null (not 0) when the scan is killed by the exec timeout', async () => {
    const exec: JournalExec = async () => {
      throw Object.assign(new Error('journalctl <args>'), { killed: true, code: null, signal: 'SIGTERM', stderr: '' });
    };
    const out = await readJournal(
      { units: ['papercup-bg-host.service'], grep: 'channel CLOSED', since: '-48 hours' },
      exec,
      noUnknownUnits,
    );
    expect(out.journalError).not.toBeNull();
    expect(out.journalError).toContain('killed');
    expect(out.matched).toBeNull();
    expect(out.entries).toEqual([]);
    expect(out.journalAvailable).toBe(true); // a timeout is not "no journal at all"
  });

});

describe('defaultUnitLoadProbe', () => {
  it('is exported so the seam has a real implementation, not just a test double', () => {
    expect(typeof defaultUnitLoadProbe).toBe('function');
  });
});
