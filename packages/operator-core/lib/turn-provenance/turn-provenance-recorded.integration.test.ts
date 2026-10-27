/**
 * D-019 acceptance for EI-26995183706038210.
 * Inputs are verbatim native transcript/index records, with source coordinates
 * and hashes in the checked-in corpus. Only the compaction padding and clock
 * are controlled. This exercises the production append/read/classify/display
 * chain; it does not claim that the separate live loop-delivery fault is fixed.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerVisiblePromptText } from '../agent-tools/coordination/owner-chat-turn';
import { isHumanTurn } from '../memory/human-turn-tail';
import {
  appendLedgerRow, classify, LEDGER_GC_GRACE_MS, LEDGER_TTL_MS_DEFAULT,
  ledgerPathForSid, parseEnvelope, payloadSha256, readLedgerRows, type LedgerRow,
} from './turn-provenance';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/retention-recorded-turns.json', import.meta.url), 'utf8'));
const enrollment: LedgerRow = corpus.machine.enrollment;
const recordedAt = Date.parse(corpus.machine.timestamp);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recorded-retention-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('real recorded-turn retention and owner visibility (D-019)', () => {
  it('retains an actual expired enrollment through compaction without promoting or showing its recorded machine turn', async () => {
    const prompt: string = corpus.machine.text;
    expect(createHash('sha256').update(prompt).digest('hex')).toBe(corpus.machine.textSha256);
    const envelope = parseEnvelope(prompt)!;
    expect(envelope).toMatchObject({ origin: enrollment.origin, nonce: enrollment.nonce });
    expect(payloadSha256(envelope.payload)).toBe(enrollment.sha256);
    expect(recordedAt - enrollment.ts).toBeGreaterThan(LEDGER_TTL_MS_DEFAULT);
    expect(recordedAt - enrollment.ts).toBeLessThan(LEDGER_TTL_MS_DEFAULT + LEDGER_GC_GRACE_MS);

    // Only padding is synthetic. The observed prompt and its enrollment stay
    // byte-for-byte unchanged, including their measured payload hash match.
    const padding = { ...enrollment, nonce: 'f'.repeat(16),
      ts: recordedAt - LEDGER_TTL_MS_DEFAULT - LEDGER_GC_GRACE_MS - 1 };
    const line = JSON.stringify(padding) + '\n';
    const path = ledgerPathForSid(enrollment.sid, dir);
    writeFileSync(path, line.repeat(Math.ceil(40 * 1024 / line.length)) + JSON.stringify(enrollment) + '\n');
    expect(statSync(path).size).toBeGreaterThan(32 * 1024);
    expect(await appendLedgerRow({ ...enrollment, nonce: 'e'.repeat(16), ts: recordedAt },
      { dir, nowMs: recordedAt, ttlMs: LEDGER_TTL_MS_DEFAULT })).toBe(true);
    expect(statSync(path).size).toBeLessThan(32 * 1024);

    const history = readLedgerRows(enrollment.sid, { dir, nowMs: recordedAt, includeExpired: true });
    expect(history).toContainEqual(enrollment);
    expect(history.some(row => row.nonce === padding.nonce)).toBe(false);
    expect(readLedgerRows(enrollment.sid, { dir, nowMs: recordedAt })
      .some(row => row.nonce === enrollment.nonce)).toBe(false);
    expect(classify(prompt, history, { nowMs: recordedAt })).toMatchObject({
      verdict: 'unverified-claim', origin: enrollment.origin, nonce: enrollment.nonce,
    });
    expect(classify(prompt, history, { nowMs: enrollment.ts + 1 })).toMatchObject({
      verdict: 'verified-agent', matchedBy: 'nonce+hash',
    });
    // Simulate loss of the envelope with the real, unchanged recorded payload.
    // Compaction must not erase its expired hash and grant owner authority.
    expect(classify(envelope.payload, history, { nowMs: recordedAt }).verdict).toBe('unverified-claim');
    expect(ownerVisiblePromptText(prompt)).toBe('');
    expect(isHumanTurn(prompt)).toBe(false);
    expect(ownerVisiblePromptText(corpus.owner.text)).toBe(corpus.owner.text);
  });

  it('preserves the exact recorded instruction beside retained expired machine history', async () => {
    const text: string = corpus.owner.text;
    expect(corpus.owner.ref).toBe('session_turn:codex:01a16517-9e1a-7d52-9b2a-48374ad88b6a:11');
    expect(corpus.owner.persistedOriginVerdict).toBe('unenrolled-origin');
    expect(text).toBe('put yourself on auto mode and carry this plan to shipped status yourself now');
    expect(await appendLedgerRow(enrollment, { dir, nowMs: recordedAt })).toBe(true);
    const history = readLedgerRows(enrollment.sid, { dir, nowMs: recordedAt, includeExpired: true });
    // This is the live classifier's result, not a retrospective upgrade of the
    // corpus index's unknown-authorship stamp.
    expect(classify(text, history, { nowMs: recordedAt }).verdict).toBe('owner-interactive');
    expect(ownerVisiblePromptText(text)).toBe(text);
    expect(isHumanTurn(text)).toBe(true);
  });
});

