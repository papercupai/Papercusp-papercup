import { execFileSync } from 'node:child_process';
import { promises as fsp, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexLockOwnerMarkerName,
  readCodexLockRuntimeVerdict,
  readCodexLockRuntimeVerdictAsync,
} from './codex-lock-runtime';

const dirs: string[] = [];
const owner = 'su-test:owner';
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-lock-runtime-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function marker(dir: string, kind: 'decision' | 'success' | 'error', value: object) {
  writeFileSync(join(dir, codexLockOwnerMarkerName(owner, kind)), JSON.stringify(value));
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('readCodexLockRuntimeVerdict', () => {
  it('fails closed to manual when hooks are missing', () => {
    expect(readCodexLockRuntimeVerdict({ ownerId: owner, hooksConfigured: false, cacheDir: temp() })).toMatchObject({
      lockMode: 'manual',
      hookHealth: 'missing',
      runtimeProbed: false,
    });
  });

  it('treats configured-without-owner-proof as manual', () => {
    expect(readCodexLockRuntimeVerdict({ ownerId: owner, hooksConfigured: true, cacheDir: temp() })).toMatchObject({
      lockMode: 'manual',
      hookHealth: 'configured-unverified',
    });
  });

  it('selects automatic only for a fresh owner-scoped decision and success', () => {
    const dir = temp();
    marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner, decision: 'granted' });
    marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner });
    expect(
      readCodexLockRuntimeVerdict({
        ownerId: owner,
        hooksConfigured: true,
        cacheDir: dir,
        nowMs: Date.parse('2026-07-13T20:01:00Z'),
      }),
    ).toMatchObject({
      lockMode: 'automatic',
      hookHealth: 'verified',
      runtimeProbed: true,
      effectiveInstruction: expect.stringContaining('verified PreToolUse hook'),
    });
  });

  it('returns manual when a later owner-scoped error supersedes success', () => {
    const dir = temp();
    marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner, decision: 'granted' });
    marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner });
    marker(dir, 'error', { ts: '2026-07-13T20:00:02Z', owner, detail: 'offline' });
    expect(readCodexLockRuntimeVerdict({ ownerId: owner, hooksConfigured: true, cacheDir: dir })).toMatchObject({
      lockMode: 'manual',
      hookHealth: 'unhealthy',
    });
  });

  it('does not accept a decision written for a different owner', () => {
    const dir = temp();
    marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner: 'su-peer', decision: 'granted' });
    marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner: 'su-peer' });
    expect(readCodexLockRuntimeVerdict({ ownerId: owner, hooksConfigured: true, cacheDir: dir })).toMatchObject({
      lockMode: 'manual',
      hookHealth: 'configured-unverified',
    });
  });
});

describe('readCodexLockRuntimeVerdictAsync — the request-path reader (WI-10004754)', () => {
  it('returns exactly the synchronous verdict for every marker state', async () => {
    const seeds: Array<(dir: string) => void> = [
      () => {},
      (dir) => {
        marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner, decision: 'granted' });
        marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner });
      },
      (dir) => {
        marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner, decision: 'granted' });
        marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner });
        marker(dir, 'error', { ts: '2026-07-13T20:00:02Z', owner, detail: 'offline' });
      },
      (dir) => {
        marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner: 'su-peer', decision: 'granted' });
        marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner: 'su-peer' });
      },
      (dir) => writeFileSync(join(dir, codexLockOwnerMarkerName(owner, 'error')), 'not json'),
    ];
    for (const seed of seeds) {
      for (const hooksConfigured of [false, true]) {
        const dir = temp();
        seed(dir);
        for (const nowMs of [Date.parse('2026-07-13T20:01:00Z'), Date.parse('2026-08-13T20:01:00Z')]) {
          const input = { ownerId: owner, hooksConfigured, cacheDir: dir, nowMs };
          expect(await readCodexLockRuntimeVerdictAsync(input)).toEqual(readCodexLockRuntimeVerdict(input));
        }
      }
    }
    // A missing cache directory: generation 0 on both paths.
    const absent = { ownerId: owner, hooksConfigured: true, cacheDir: join(temp(), 'absent') };
    const sync = readCodexLockRuntimeVerdict(absent);
    expect(sync.generation).toBe(0);
    expect(await readCodexLockRuntimeVerdictAsync(absent)).toEqual(sync);
  });

  it('keeps the event loop turning while a marker open(2) is blocked', async () => {
    // A FIFO parks open(2) until a writer arrives — the same wait the main thread
    // sat in for 10s on the contended locks-cache directory (wchan open_last_lookups).
    const dir = temp();
    const fifo = join(dir, codexLockOwnerMarkerName(owner, 'error'));
    execFileSync('mkfifo', [fifo]);
    let settled = false;
    const pending = readCodexLockRuntimeVerdictAsync({ ownerId: owner, hooksConfigured: true, cacheDir: dir }).then((v) => {
      settled = true;
      return v;
    });

    let turns = 0;
    await new Promise<void>((resolve) => {
      const spin = () => {
        turns += 1;
        if (turns >= 50) resolve();
        else setImmediate(spin);
      };
      setImmediate(spin);
    });
    expect(turns).toBe(50);
    expect(settled).toBe(false);

    const writer = await fsp.open(fifo, 'w');
    await writer.writeFile(JSON.stringify({ ts: '2026-07-13T20:00:02Z', owner, detail: 'offline' }));
    await writer.close();
    const verdict = await pending;
    expect(verdict.lastErrorAt).toBe('2026-07-13T20:00:02Z');
    expect(verdict.hookHealth).toBe('unhealthy');
  });

  it('is what coord:orient uses — the orient request path never reads the markers synchronously', () => {
    const orient = readFileSync(
      fileURLToPath(new URL('./agent-tools/coordination/tools/orient.ts', import.meta.url)),
      'utf8',
    );
    expect(orient).toContain('await readCodexLockRuntimeVerdictAsync(');
    expect(orient).not.toMatch(/\breadCodexLockRuntimeVerdict\(/);
  });
});
