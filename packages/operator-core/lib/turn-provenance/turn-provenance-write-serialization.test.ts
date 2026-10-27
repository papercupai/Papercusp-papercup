/**
 * WI-10005327: the ledger write path is async, so two writes to one ledger file
 * in the same process can interleave. Compaction is read-then-rewrite. An append
 * that lands between another chain's read and its rewrite is wiped by that
 * rewrite, and the wiped turn then classifies as unverified at the hook.
 * `serializeByPath` exists to make that impossible.
 *
 * Deterministic on purpose. Measured: twelve concurrent appends with plain fs
 * lose ZERO rows even WITHOUT serialization, because equal-cost async phases
 * advance in lockstep (every rewrite finishes before any append). This test
 * holds the first compaction rewrite until another append has landed (or
 * 100 ms pass), which is exactly the losing interleaving. Without
 * serialization, the second append lands during the hold and is wiped. With
 * serialization, it queues behind the first append, so the hold times out and
 * nothing is lost.
 *
 * PROBE_TURN_PROVENANCE_FILE points the test at a mutated COPY of the module
 * (scripts/mutation-probe.sh copy-out mode), so falsifiability is provable
 * without editing the shared tree.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({
  holdFirstRewrite: false,
  rewriteHeld: false,
  onRewriteHeld: null as null | (() => void),
  onAppended: null as null | (() => void),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof real.writeFile = async (...args) => {
    if (gate.holdFirstRewrite && !gate.rewriteHeld) {
      gate.rewriteHeld = true;
      const appended = new Promise<void>((resolve) => {
        gate.onAppended = resolve;
      });
      gate.onRewriteHeld?.();
      await Promise.race([appended, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
    return real.writeFile(...args);
  };
  const appendFile: typeof real.appendFile = async (...args) => {
    await real.appendFile(...args);
    gate.onAppended?.();
  };
  return { ...real, writeFile, appendFile, default: { ...real, writeFile, appendFile } };
});

const SUBJECT =
  process.env.PROBE_TURN_PROVENANCE_FILE ?? fileURLToPath(new URL('./turn-provenance.ts', import.meta.url));

const SID = 'su-serialize-0000';
const NOW = 1_760_000_000_000;
const TTL = 600_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turn-prov-serialize-'));
  gate.holdFirstRewrite = false;
  gate.rewriteHeld = false;
  gate.onRewriteHeld = null;
  gate.onAppended = null;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const row = (nonce: string, ts: number) => ({ sid: SID, nonce, origin: 'wake-pump', sha256: 'x', ts });

describe('turn-provenance ledger writes to one file are serialized (WI-10005327)', () => {
  it('an append that arrives while a compaction rewrite is in flight is not wiped', async () => {
    const mod = (await import(/* @vite-ignore */ SUBJECT)) as typeof import('./turn-provenance');
    const p = mod.ledgerPathForSid(SID, dir);
    // Past 32 KiB, with every padding row beyond TTL + historical grace.
    const expiredLine = JSON.stringify(row('e'.repeat(16), NOW - TTL - mod.LEDGER_GC_GRACE_MS - 60_000)) + '\n';
    writeFileSync(p, expiredLine.repeat(Math.ceil((40 * 1024) / expiredLine.length)));

    gate.holdFirstRewrite = true;
    const rewriteHeld = new Promise<void>((resolve) => {
      gate.onRewriteHeld = resolve;
    });
    const first = mod.appendLedgerRow(row('1'.repeat(16), NOW), { dir, nowMs: NOW, ttlMs: TTL });
    await rewriteHeld; // the first append has read the file and is about to rewrite it
    const second = mod.appendLedgerRow(row('2'.repeat(16), NOW), { dir, nowMs: NOW, ttlMs: TTL });

    expect(await Promise.all([first, second])).toEqual([true, true]);
    const live = mod.readLedgerRows(SID, { dir, nowMs: NOW, ttlMs: TTL });
    expect(live.map((r) => r.nonce).sort()).toEqual(['1'.repeat(16), '2'.repeat(16)]);
    expect(mod.readLedgerRows(SID, { dir, nowMs: NOW, ttlMs: TTL, includeExpired: true })).toHaveLength(2);
  });
});
