/**
 * psu-launcher-slow-operator-notice.test.ts — WI-10006057.
 *
 * While the operator behind the MCP proxy is down, the proxy holds psu's request
 * for its ~90s retry window, and psu used to print nothing at all. These tests
 * pin the wiring in fetchWithResilience: a request still pending after
 * slowNoticeAfterMs prints the diagnosis, and a response that arrives first
 * silences it. The diagnosis itself is covered in
 * psu-operator-down-diagnosis.test.ts.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-slow-operator-notice.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStartupStepRunner, fetchWithResilience, installBootLogCapture,
  traceFirstPromptOutput } from './psu-launcher.mjs';

const URL = 'http://127.0.0.1:9171/api/agent-mcp/console/bootstrap-su';
const NOTICE = 'psu: still waiting. The operator on :3170 is not answering\n';

function respondAfter(ms: number) {
  return () =>
    new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('{"status":"ok"}', { status: 200 })), ms));
}

async function launch(fetchDelayMs: number, noticeDelayMs = 0) {
  const notices: string[] = [];
  let asked = 0;
  const res = await fetchWithResilience(URL, {}, {
    fetchImpl: respondAfter(fetchDelayMs) as unknown as typeof fetch,
    onNotice: (msg: string) => {
      notices.push(msg);
      return true;
    },
    slowNoticeAfterMs: 5,
    slowRequestNotice: async ({ url }: { url: string }) => {
      asked += 1;
      expect(url).toBe(URL);
      await new Promise((r) => setTimeout(r, noticeDelayMs));
      return NOTICE;
    },
  });
  expect(res.status).toBe(200);
  return { notices, asked };
}

describe('psu explains a slow request while it is still waiting', () => {
  it('prints the diagnosis once the request has been pending past the threshold', async () => {
    const { notices, asked } = await launch(60);
    expect(asked).toBe(1);
    expect(notices).toEqual([NOTICE]);
  });

  it('does not ask when the response arrives before the threshold', async () => {
    const { notices, asked } = await launch(0);
    expect(asked).toBe(0);
    expect(notices).toEqual([]);
  });

  it('drops a diagnosis that finishes after the response already arrived', async () => {
    const { notices, asked } = await launch(20, 80);
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toBe(1);
    expect(notices).toEqual([]);
  });
});

describe('local startup measures the blocking hop before the menu', () => {
  it('names a pending asynchronous hop once, without attributing it to the terminal notice', async () => {
    vi.useFakeTimers();
    try {
      const rows: any[] = [];
      const notice = vi.fn();
      const step = createStartupStepRunner({ record: (row) => rows.push(row), notice });
      let resolve!: () => void;
      step('terminal-notice', () => undefined);
      const pending = step('recovery-audit-reconciliation', () => new Promise<void>((r) => { resolve = r; }));
      await vi.advanceTimersByTimeAsync(35_000);
      expect(notice).toHaveBeenCalledTimes(1);
      expect(notice.mock.calls[0][0]).toBe('recovery-audit-reconciliation');
      resolve();
      await pending;
      expect(rows.at(-1)).toMatchObject({ step: 'recovery-audit-reconciliation', phase: 'finished', elapsedMs: 35_000 });
      expect(rows.filter((r) => r.step === 'terminal-notice')).toEqual([
        expect.objectContaining({ phase: 'started', elapsedMs: 0 }),
        expect.objectContaining({ phase: 'finished', elapsedMs: 0 }),
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('records synchronous terminal-write time even when it also blocks the slow timer', () => {
    let clock = 0;
    const rows: any[] = [];
    const notice = vi.fn();
    const step = createStartupStepRunner({ now: () => clock, record: (row) => rows.push(row), notice });
    expect(step('terminal-notice', () => { clock = 35_000; return 'written'; })).toBe('written');
    expect(notice).toHaveBeenCalledWith('terminal-notice', 35_000);
    expect(rows.at(-1)).toMatchObject({ phase: 'finished', elapsedMs: 35_000 });
  });

  it('measures actual menu output and excludes a human taking 30 seconds to answer', async () => {
    let clock = 0;
    const rows: any[] = [];
    const notice = vi.fn();
    const step = createStartupStepRunner({ now: () => clock, record: (row) => rows.push(row), notice });
    const output = { write: vi.fn((_chunk: string) => { clock += 3; return false; }) };
    const original = output.write;
    let answer!: (value: boolean) => void;
    const pending = traceFirstPromptOutput('Subagents', () => {
      output.write('? Subagents');
      return new Promise<boolean>((resolve) => { answer = resolve; });
    }, { step, output });
    await Promise.resolve();
    expect(output.write).toBe(original);
    expect(rows.at(-1)).toMatchObject({ phase: 'finished', elapsedMs: 3 });
    clock = 30_003;
    answer(false);
    await expect(pending).resolves.toBe(false);
    expect(notice).not.toHaveBeenCalled();
    expect(output.write).toHaveBeenCalledWith('? Subagents');
  });

  it('restores output after a pre-render failure and preserves the actual failure', async () => {
    const rows: any[] = [];
    const output = { write: vi.fn(() => true) };
    const original = output.write;
    const failure = new Error('prompt failed');
    await expect(traceFirstPromptOutput('Subagents', () => Promise.reject(failure), {
      step: createStartupStepRunner({ record: (row) => rows.push(row) }), output,
    })).rejects.toBe(failure);
    expect(output.write).toBe(original);
    expect(rows.at(-1)).toMatchObject({ phase: 'failed' });
  });

  it('uses bounded boot-log readback without capturing plain-launch terminal text', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-startup-trace-'));
    try {
      const stream = { write: vi.fn((_chunk: string) => true) };
      const original = stream.write;
      const log = installBootLogCapture('startup-test', { home, stream, argv: [], captureStream: false, prune: false })!;
      const step = createStartupStepRunner({ record: (row) => log.record(`# startup ${JSON.stringify(row)}\n`) });
      step('host-handoff-lookup', () => null);
      stream.write('unrecorded terminal contents');
      log.uninstall();
      expect(stream.write).toBe(original);
      const text = readFileSync(log.path, 'utf8');
      expect(text).toContain('"step":"host-handoff-lookup","phase":"finished"');
      expect(text).not.toContain('unrecorded terminal contents');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
