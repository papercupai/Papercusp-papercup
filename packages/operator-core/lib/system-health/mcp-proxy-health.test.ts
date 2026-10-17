/**
 * mcp-proxy-health.test — the MCP tool-call-transport SLO reader + summarizer
 * (backend-reliability-100pct-2026-07-03 W8 / P-008). Pins:
 *  - the PURE classification (hard vs soft vs otherNon2xx) + the stale-socket-400 signature,
 *  - the window + future-skew filtering,
 *  - the bounded TAIL reader against real temp files (absent = healthy zero, partial leading
 *    line dropped, malformed line skipped, genuine error → null).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  summarizeMcpProxyHealth,
  isSoftBeatFailure,
  isStaleSocket400,
  isBenignProbe,
  isNonInstanceRecord,
  readMcpProxyFailureTail,
  mcpProxyFailureLogPath,
  MCP_PROXY_FAILURE_LOG_MAX_BYTES,
  MCP_PROXY_READ_CAP_BYTES,
  type McpProxyFailureRecord,
} from './mcp-proxy-health';

const NOW = 1_760_000_000_000; // fixed epoch — hermetic
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function rec(o: Partial<McpProxyFailureRecord> & { kind: string }): McpProxyFailureRecord {
  return { ts: iso(1000), ...o };
}

describe('isStaleSocket400 — the W1.3 signature (HTTP 400 + connection:close)', () => {
  it('true for status 400 + connection close (any case)', () => {
    expect(isStaleSocket400({ status: 400, connection: 'close' })).toBe(true);
    expect(isStaleSocket400({ status: 400, connection: 'Close' })).toBe(true);
    expect(isStaleSocket400({ status: 400, connection: 'keep-alive, close' })).toBe(true);
  });
  it('false for a 400 WITHOUT connection:close (a genuine bad-request, not a stale socket)', () => {
    expect(isStaleSocket400({ status: 400, connection: 'keep-alive' })).toBe(false);
    expect(isStaleSocket400({ status: 400, connection: null })).toBe(false);
    expect(isStaleSocket400({ status: 400 })).toBe(false);
  });
  it('false for other statuses', () => {
    expect(isStaleSocket400({ status: 502, connection: 'close' })).toBe(false);
    expect(isStaleSocket400({ status: 503, connection: 'close' })).toBe(false);
  });
});

describe('summarizeMcpProxyHealth — classification', () => {
  it('soft-beat exhausted misses stay out of hardFailures while real MCP failures remain hard', () => {
    const d = summarizeMcpProxyHealth(
      [
        rec({
          kind: 'exhausted_refused',
          status: 503,
          path: '/api/agent-mcp/console/bootstrap-su/heartbeat',
        }),
        rec({ kind: 'exhausted_refused', status: 503, path: '/api/mcp' }),
      ],
      NOW,
    );
    expect(d.softBeatFailures).toBe(1);
    expect(d.hardFailures).toBe(1);
    expect(d.total).toBe(2);
  });

  it('path-aware soft classification covers terminal error kinds but not intermediate retry markers', () => {
    expect(isSoftBeatFailure({ kind: 'exhausted_refused', path: '/api/agent-mcp/mid-turn-context?client=abc' })).toBe(true);
    expect(isSoftBeatFailure({ kind: 'upstream_error', path: '/api/agent-mcp/turn-start-memory/' })).toBe(true);
    expect(isSoftBeatFailure({ kind: 'upstream_non2xx', path: '/api/admin/owner-presence/touch' })).toBe(true);
    expect(isSoftBeatFailure({ kind: 'post_connect_retry', path: '/api/agent-mcp/console/bootstrap-su/heartbeat' })).toBe(false);
    expect(isSoftBeatFailure({ kind: 'exhausted_refused', path: '/api/mcp' })).toBe(false);
  });

  it('exhausted_refused and upstream_error are HARD failures', () => {
    const d = summarizeMcpProxyHealth(
      [rec({ kind: 'exhausted_refused', status: 503 }), rec({ kind: 'upstream_error', status: 502 })],
      NOW,
    );
    expect(d.hardFailures).toBe(2);
    expect(d.recovered).toBe(0);
    expect(d.otherNon2xx).toBe(0);
    expect(d.total).toBe(2);
  });

  it('recovered is SOFT (informational — the proxy absorbed a deploy blip)', () => {
    const d = summarizeMcpProxyHealth([rec({ kind: 'recovered', status: 200, attempts: 3 })], NOW);
    expect(d.hardFailures).toBe(0);
    expect(d.recovered).toBe(1);
    expect(d.total).toBe(1);
  });

  // D-005 (outage-must-not-be-silent-2026-08-02). Before these branches existed,
  // `handshake_timeout_retry` and `shed_max_in_flight` matched NO classification arm and
  // survived only as a `byKind` tally — so nothing could alarm on them. Ordinary queue-full
  // shedding later exposed the same fallthrough for a second admission class. That mattered most
  // for the handshake stall: WI-6740's marker for the upstream silence that leaves an MCP
  // session tool-dark for its whole life (269 stalls 2026-07-10..08-01). Verified live
  // 2026-08-02: the fleet-facing proxy (pid 2704092, listenPort 9071) emits these in prod.
  describe('kinds that used to fall through into byKind only (D-005)', () => {
    it('handshake_timeout_retry is counted as a first-class handshakeStall', () => {
      const d = summarizeMcpProxyHealth([rec({ kind: 'handshake_timeout_retry', listenPort: 9071 })], NOW);
      expect(d.handshakeStalls).toBe(1);
      expect(d.total).toBe(1);
    });

    it('a handshake stall is NOT a hard failure — the replay is WI-6740 working, not an agent-facing error', () => {
      const d = summarizeMcpProxyHealth([rec({ kind: 'handshake_timeout_retry', listenPort: 9071 })], NOW);
      expect(d.hardFailures).toBe(0);
      expect(d.recovered).toBe(0);
      expect(d.otherNon2xx).toBe(0);
      expect(d.benign).toBe(0);
    });

    it('both admission-shed kinds are first-class sheds, not hard failures', () => {
      const d = summarizeMcpProxyHealth(
        [
          rec({ kind: 'shed_max_in_flight', listenPort: 9071 }),
          rec({ kind: 'shed_ordinary_queue_full', listenPort: 9071 }),
        ],
        NOW,
      );
      expect(d.shed).toBe(2);
      expect(d.hardFailures).toBe(0);
      expect(d.byKind['shed_max_in_flight']).toBe(1);
      expect(d.byKind['shed_ordinary_queue_full']).toBe(1);
    });

    it('the listenPort:0 exclusion still applies to the new classes — a test/sidecar writer never alarms', () => {
      // ~18% of live ledger records carry listenPort:0 (tests append to the production
      // ledger: a sampled shed record read {"listenPort":0,"maxInFlight":2}, and 2 is a
      // fixture value — the real default is 200). Those must not reach an alarm class.
      const d = summarizeMcpProxyHealth(
        [
          rec({ kind: 'handshake_timeout_retry', listenPort: 0 }),
          rec({ kind: 'shed_max_in_flight', listenPort: 0 }),
          rec({ kind: 'shed_ordinary_queue_full', listenPort: 0 }),
        ],
        NOW,
      );
      expect(d.handshakeStalls).toBe(0);
      expect(d.shed).toBe(0);
      expect(d.nonInstance).toBe(3);
      expect(d.byKind['handshake_timeout_retry']).toBe(1); // forensically visible, never alarming
      expect(d.byKind['shed_ordinary_queue_full']).toBe(1); // visible, but excluded from alarm classes
    });

    it('a stall and a hard failure stay distinguishable in one window', () => {
      const d = summarizeMcpProxyHealth(
        [
          rec({ kind: 'handshake_timeout_retry', listenPort: 9071 }),
          rec({ kind: 'handshake_timeout_retry', listenPort: 9071 }),
          rec({ kind: 'exhausted_refused', status: 503, listenPort: 9071 }),
        ],
        NOW,
      );
      expect(d.handshakeStalls).toBe(2);
      expect(d.hardFailures).toBe(1);
    });
  });

  it('upstream_non2xx WITH the stale-socket-400 signature is HARD (W1.3 regression)', () => {
    const d = summarizeMcpProxyHealth([rec({ kind: 'upstream_non2xx', status: 400, connection: 'close' })], NOW);
    expect(d.hardFailures).toBe(1);
    expect(d.otherNon2xx).toBe(0);
  });

  it('upstream_non2xx WITHOUT the stale-socket signature is otherNon2xx (genuine upstream 4xx/5xx)', () => {
    const d = summarizeMcpProxyHealth(
      [
        rec({ kind: 'upstream_non2xx', status: 404, connection: 'keep-alive' }),
        rec({ kind: 'upstream_non2xx', status: 500, connection: null }),
      ],
      NOW,
    );
    expect(d.hardFailures).toBe(0);
    expect(d.otherNon2xx).toBe(2);
  });

  // P-006: benign probe/heartbeat non-2xx must be split OUT of hardFailures AND otherNon2xx.
  it('a 408 heartbeat and a GET-405 probe are BENIGN (not hard, not otherNon2xx)', () => {
    const d = summarizeMcpProxyHealth(
      [
        rec({ kind: 'upstream_non2xx', status: 408, method: 'GET' }),
        rec({ kind: 'upstream_non2xx', status: 408, method: 'POST' }), // 408 is benign regardless of method (heartbeat lapse)
        rec({ kind: 'upstream_non2xx', status: 405, method: 'GET' }),
      ],
      NOW,
    );
    expect(d.benign).toBe(3);
    expect(d.hardFailures).toBe(0);
    expect(d.otherNon2xx).toBe(0);
    expect(d.total).toBe(3);
  });

  it('a POST-405 (not a GET probe) stays otherNon2xx — only GET-405 is a benign probe', () => {
    const d = summarizeMcpProxyHealth([rec({ kind: 'upstream_non2xx', status: 405, method: 'POST' })], NOW);
    expect(d.benign).toBe(0);
    expect(d.otherNon2xx).toBe(1);
  });

  it('isBenignProbe: 408 (any method) and GET-405 only', () => {
    expect(isBenignProbe({ status: 408, method: 'POST' })).toBe(true);
    expect(isBenignProbe({ status: 405, method: 'GET' })).toBe(true);
    expect(isBenignProbe({ status: 405, method: 'POST' })).toBe(false);
    expect(isBenignProbe({ status: 500, method: 'GET' })).toBe(false);
  });

  it('post_connect_retry (P-005 marker) is neither hard nor a failure class — only byKind', () => {
    const d = summarizeMcpProxyHealth(
      [rec({ kind: 'post_connect_retry', method: 'POST' }), rec({ kind: 'recovered', status: 200 })],
      NOW,
    );
    expect(d.hardFailures).toBe(0);
    expect(d.otherNon2xx).toBe(0);
    expect(d.benign).toBe(0);
    expect(d.recovered).toBe(1);
    expect(d.byKind.post_connect_retry).toBe(1);
  });

  describe('critical continuation queue dwell alarm', () => {
    it('keeps a single normal low-volume wait below the five-minute floor out of the alarm', () => {
      const d = summarizeMcpProxyHealth(
        [rec({ kind: 'critical_continuation_queue_wait', traceId: 'checkpoint-1', waitedMs: 61_800 })],
        NOW,
      );
      expect(d.criticalContinuationQueueStalls).toBe(0);
      expect(d.criticalContinuationQueueMaxWaitMs).toBe(61_800);
    });

    it('counts sustained waits once per trace despite periodic samples', () => {
      const d = summarizeMcpProxyHealth(
        [
          rec({ kind: 'critical_continuation_queue_wait', traceId: 'checkpoint-1', waitedMs: 300_000, listenPort: 9071 }),
          rec({ kind: 'critical_continuation_queue_wait', traceId: 'checkpoint-1', waitedMs: 701_000, listenPort: 9071 }),
          rec({ kind: 'critical_continuation_queue_wait', traceId: 'checkpoint-2', waitedMs: 600_000, listenPort: 9071 }),
        ],
        NOW,
      );
      expect(d.criticalContinuationQueueStalls).toBe(2);
      expect(d.criticalContinuationQueueMaxWaitMs).toBe(701_000);
      expect(d.byKind.critical_continuation_queue_wait).toBe(3);
    });

    it('does not alarm on non-instance sidecar records', () => {
      const d = summarizeMcpProxyHealth(
        [rec({ kind: 'critical_continuation_queue_wait', traceId: 'checkpoint-test', waitedMs: 700_000, listenPort: 0 })],
        NOW,
      );
      expect(d.criticalContinuationQueueStalls).toBe(0);
      expect(d.nonInstance).toBe(1);
    });
  });

  it('byKind tallies every kind; newestAt is the freshest in-window record', () => {
    const d = summarizeMcpProxyHealth(
      [
        rec({ kind: 'recovered', ts: iso(5000) }),
        rec({ kind: 'exhausted_refused', ts: iso(1000) }),
        rec({ kind: 'exhausted_refused', ts: iso(3000) }),
      ],
      NOW,
    );
    expect(d.byKind).toEqual({ recovered: 1, exhausted_refused: 2 });
    expect(d.newestAt).toBe(NOW - 1000);
  });

  // EI-12102/EI-12211: a record with listenPort:0 never came from a real listening proxy
  // instance any client could route through (the desktop-sidecar-startup-race signature) —
  // it must be excluded from every alarm-relevant class, while staying visible in
  // total/byKind/nonInstance for forensic purposes.
  describe('isNonInstanceRecord (EI-12102/EI-12211) — listenPort:0 exclusion', () => {
    it('isNonInstanceRecord is true only for an explicit listenPort:0', () => {
      expect(isNonInstanceRecord({ listenPort: 0 })).toBe(true);
      expect(isNonInstanceRecord({ listenPort: 9071 })).toBe(false);
      expect(isNonInstanceRecord({ listenPort: undefined })).toBe(false);
      expect(isNonInstanceRecord({})).toBe(false);
    });

    it('a listenPort:0 hard-failure record is excluded from hardFailures but counted in total/nonInstance/byKind', () => {
      const d = summarizeMcpProxyHealth(
        [
          rec({ kind: 'exhausted_refused', status: 503, listenPort: 0, pid: 1234, target: '127.0.0.1:54321' }),
          rec({ kind: 'upstream_error', status: 502, listenPort: 0, pid: 5678, target: '127.0.0.1:44821' }),
        ],
        NOW,
      );
      expect(d.hardFailures).toBe(0);
      expect(d.otherNon2xx).toBe(0);
      expect(d.benign).toBe(0);
      expect(d.nonInstance).toBe(2);
      expect(d.total).toBe(2);
      expect(d.byKind).toEqual({ exhausted_refused: 1, upstream_error: 1 });
    });

    it('a listenPort:0 upstream_non2xx (even matching the stale-socket-400 signature) is excluded, not promoted to hardFailures', () => {
      const d = summarizeMcpProxyHealth(
        [rec({ kind: 'upstream_non2xx', status: 400, connection: 'close', listenPort: 0 })],
        NOW,
      );
      expect(d.hardFailures).toBe(0);
      expect(d.otherNon2xx).toBe(0);
      expect(d.nonInstance).toBe(1);
      expect(d.total).toBe(1);
    });

    it('a real-instance record (nonzero listenPort) is classified normally and does NOT count toward nonInstance', () => {
      const d = summarizeMcpProxyHealth(
        [rec({ kind: 'exhausted_refused', status: 503, listenPort: 9071, pid: 42, target: '127.0.0.1:3070' })],
        NOW,
      );
      expect(d.hardFailures).toBe(1);
      expect(d.nonInstance).toBe(0);
    });

    it('a legacy record with NO listenPort field at all is NOT excluded (pre-P-006 rows keep counting)', () => {
      const d = summarizeMcpProxyHealth([rec({ kind: 'exhausted_refused', status: 503 })], NOW);
      expect(d.hardFailures).toBe(1);
      expect(d.nonInstance).toBe(0);
    });

    it('mixed listenPort:0 and real-instance records: only the real one counts toward hardFailures', () => {
      const d = summarizeMcpProxyHealth(
        [
          rec({ kind: 'exhausted_refused', status: 503, listenPort: 0 }),
          rec({ kind: 'exhausted_refused', status: 503, listenPort: 9071 }),
        ],
        NOW,
      );
      expect(d.hardFailures).toBe(1);
      expect(d.nonInstance).toBe(1);
      expect(d.total).toBe(2);
    });
  });
});

describe('summarizeMcpProxyHealth — window + skew filtering', () => {
  it('drops records older than the window', () => {
    const windowMs = 60 * 60_000;
    const d = summarizeMcpProxyHealth(
      [rec({ kind: 'exhausted_refused', ts: iso(windowMs + 60_000) }), rec({ kind: 'exhausted_refused', ts: iso(1000) })],
      NOW,
      windowMs,
    );
    expect(d.hardFailures).toBe(1); // only the in-window one
    expect(d.total).toBe(1);
  });

  it('drops far-future records (clock-skew garbage) but tolerates minor skew', () => {
    const d = summarizeMcpProxyHealth(
      [
        rec({ kind: 'exhausted_refused', ts: new Date(NOW + 5 * 60_000).toISOString() }), // far future → dropped
        rec({ kind: 'exhausted_refused', ts: new Date(NOW + 10_000).toISOString() }), // +10s minor skew → kept
      ],
      NOW,
    );
    expect(d.hardFailures).toBe(1);
  });

  it('ignores records with an unparseable ts', () => {
    const d = summarizeMcpProxyHealth([{ ts: 'not-a-date', kind: 'exhausted_refused' }], NOW);
    expect(d.total).toBe(0);
  });

  it('empty input → all-zero summary', () => {
    const d = summarizeMcpProxyHealth([], NOW);
    expect(d).toMatchObject({ total: 0, hardFailures: 0, recovered: 0, otherNon2xx: 0, newestAt: null });
  });
});

describe('readMcpProxyFailureTail — bounded, fail-soft reader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function tmpFile(name = 'mcp-proxy-failures.jsonl'): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-proxy-health-'));
    dirs.push(dir);
    return join(dir, name);
  }

  it('absent ledger → [] (a healthy zero, NOT an error)', () => {
    expect(readMcpProxyFailureTail(join(tmpdir(), 'definitely-absent-xyz.jsonl'))).toEqual([]);
  });

  it('empty ledger → []', () => {
    const f = tmpFile();
    writeFileSync(f, '');
    expect(readMcpProxyFailureTail(f)).toEqual([]);
  });

  it('shares the writer rotation bound and keeps one-hour failures beyond the former 256KiB tail', () => {
    const f = tmpFile();
    const missed = JSON.stringify({ ts: iso(30 * 60_000), kind: 'exhausted_refused', status: 503 });
    const filler = JSON.stringify({ ts: iso(1000), kind: 'recovered', pad: 'x'.repeat(1024) });
    const body = `${missed}\n${Array.from({ length: 300 }, () => filler).join('\n')}\n`;
    expect(MCP_PROXY_READ_CAP_BYTES).toBe(MCP_PROXY_FAILURE_LOG_MAX_BYTES);
    expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThan(MCP_PROXY_READ_CAP_BYTES);
    writeFileSync(f, body);

    const recs = readMcpProxyFailureTail(f);
    expect(recs).not.toBeNull();
    expect(summarizeMcpProxyHealth(recs!, NOW).hardFailures).toBe(1);
  });

  it('reads a retained rotation so the health window survives one file rollover', () => {
    const f = tmpFile();
    writeFileSync(`${f}.1`, JSON.stringify({ ts: iso(30 * 60_000), kind: 'exhausted_refused', status: 503 }) + '\n');
    writeFileSync(f, JSON.stringify({ ts: iso(1000), kind: 'recovered' }) + '\n');

    const recs = readMcpProxyFailureTail(f);
    expect(recs).not.toBeNull();
    expect(summarizeMcpProxyHealth(recs!, NOW).hardFailures).toBe(1);
    expect(recs).toHaveLength(2);
  });

  it('parses well-formed JSONL records and round-trips through the summarizer', () => {
    const f = tmpFile();
    writeFileSync(
      f,
      [
        JSON.stringify({ ts: iso(1000), kind: 'exhausted_refused', status: 503, attempts: 4 }),
        JSON.stringify({ ts: iso(2000), kind: 'recovered', status: 200, attempts: 2 }),
        JSON.stringify({ ts: iso(3000), kind: 'upstream_non2xx', status: 400, connection: 'close' }),
      ].join('\n') + '\n',
    );
    const recs = readMcpProxyFailureTail(f);
    expect(recs).not.toBeNull();
    expect(recs).toHaveLength(3);
    const d = summarizeMcpProxyHealth(recs!, NOW);
    expect(d.hardFailures).toBe(2); // exhausted_refused + stale-socket-400
    expect(d.recovered).toBe(1);
  });

  it('skips malformed / partial lines without failing the whole read', () => {
    const f = tmpFile();
    writeFileSync(
      f,
      [
        JSON.stringify({ ts: iso(1000), kind: 'exhausted_refused' }),
        '{ this is not json',
        '',
        JSON.stringify({ ts: iso(2000), kind: 'recovered' }),
      ].join('\n') + '\n',
    );
    const recs = readMcpProxyFailureTail(f);
    expect(recs).toHaveLength(2);
  });

  it('a record missing ts or kind is skipped (schema guard)', () => {
    const f = tmpFile();
    writeFileSync(
      f,
      [
        JSON.stringify({ ts: iso(1000) }), // no kind
        JSON.stringify({ kind: 'exhausted_refused' }), // no ts
        JSON.stringify({ ts: iso(1000), kind: 'exhausted_refused' }), // valid
      ].join('\n') + '\n',
    );
    expect(readMcpProxyFailureTail(f)).toHaveLength(1);
  });

  it('TAIL read: drops the partial leading line when the file exceeds the byte cap', () => {
    const f = tmpFile();
    // Write a big first record (guaranteed partial-clipped by a small cap) then two clean ones.
    const big = JSON.stringify({ ts: iso(9000), kind: 'recovered', pad: 'x'.repeat(400) });
    writeFileSync(f, big + '\n');
    appendFileSync(f, JSON.stringify({ ts: iso(1000), kind: 'exhausted_refused' }) + '\n');
    appendFileSync(f, JSON.stringify({ ts: iso(500), kind: 'upstream_error' }) + '\n');
    // Cap smaller than the big record → the tail starts mid-first-line → it is dropped,
    // and only the two trailing whole records survive (no parse error).
    const recs = readMcpProxyFailureTail(f, 200);
    expect(recs).not.toBeNull();
    expect(recs!.every((r) => r.kind !== 'recovered')).toBe(true);
    expect(recs!.length).toBeGreaterThanOrEqual(1);
    expect(recs!.length).toBeLessThanOrEqual(2);
  });
});

describe('mcpProxyFailureLogPath — matches the proxy writer contract', () => {
  const prev = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prev;
  });
  it('honours the env override (the same var the proxy writer reads)', () => {
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = '/tmp/custom-proxy-fail.jsonl';
    expect(mcpProxyFailureLogPath()).toBe('/tmp/custom-proxy-fail.jsonl');
  });
  it('defaults under ~/.papercusp when the env var is unset', () => {
    delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    expect(mcpProxyFailureLogPath()).toMatch(/\.papercusp[/\\]mcp-proxy-failures\.jsonl$/);
  });
});
