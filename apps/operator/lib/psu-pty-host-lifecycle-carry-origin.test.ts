/**
 * WI-6554700010017571: a `reset`/`recycle` control message's `data` is the
 * carry-note a fresh context opens on — machine-delivered by contract. On
 * 2026-10-18 an agent recycled itself by writing `{v:1, mode:'recycle', data}`
 * straight to its psu-pty-host control socket. Production senders envelope
 * that text; this hand-built message did not, so the kickoff ("... — not an
 * owner turn") was classified owner-typed. The host now stamps a verified
 * host-control envelope on any untagged lifecycle carry-note.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classify, readLedgerRows } from '@papercusp/operator-core/lib/turn-provenance/turn-provenance';

import { stampUntaggedLifecycleCarry, tagSessionPortTurn } from '../scripts/psu-pty-host.mjs';

const SID = 'su-00000000-0000-4000-8000-lifecyclecarry';
const KICKOFF = [
  '[self-recycle by su-807ee9d7 at ~06:25Z to restore missing papercusp-su MCP tools — not an owner turn]',
  'Verify coord:whoami first; if your ownerId differs, do not act on this.',
].join('\n');
const LOOP_FIRE_MARKER = '⟦turn-origin:loop-fire nonce:3a18c46b99bfc429⟧';

describe('stampUntaggedLifecycleCarry', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifecycle-carry-origin-'));
    env = { PAPERCUSP_TURN_PROVENANCE_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stamps an untagged recycle carry-note so the classifier verifies it as host-control', () => {
    const now = Date.now();
    const stamped = stampUntaggedLifecycleCarry(KICKOFF, SID, env, now);

    expect(stamped).toMatch(/^⟦turn-origin:host-control nonce:[a-f0-9]{16}⟧\n/);
    expect(stamped.endsWith(KICKOFF)).toBe(true);

    const rows = readLedgerRows(SID, { dir, nowMs: now });
    expect(rows).toHaveLength(1);
    expect(classify(stamped, rows, { nowMs: now })).toMatchObject({
      verdict: 'verified-agent',
      origin: 'host-control',
      matchedBy: 'nonce+hash',
    });
  });

  it('the same text without the stamp does not verify as agent-origin (the defect)', () => {
    expect(classify(KICKOFF, [], { nowMs: Date.now() }).verdict).not.toBe('verified-agent');
  });

  it('passes an already-enveloped carry-note through unchanged and writes no ledger row', () => {
    const tagged = `${LOOP_FIRE_MARKER}\ncold wake carry-note`;
    expect(stampUntaggedLifecycleCarry(tagged, SID, env)).toBe(tagged);

    const pasted = `\n\n<pasted_content id="3e9a">\n${LOOP_FIRE_MARKER}\ncold wake carry-note\n</pasted_content id="3e9a">\n`;
    expect(stampUntaggedLifecycleCarry(pasted, SID, env)).toBe(pasted);

    expect(readLedgerRows(SID, { dir, includeExpired: true })).toHaveLength(0);
  });

  it('leaves an empty carry-note alone (a reset with no carry text)', () => {
    expect(stampUntaggedLifecycleCarry('', SID, env)).toBe('');
    expect(stampUntaggedLifecycleCarry('  \n', SID, env)).toBe('  \n');
    expect(readLedgerRows(SID, { dir, includeExpired: true })).toHaveLength(0);
  });

  it('tagSessionPortTurn keeps its session-port origin after sharing the writer', () => {
    const now = Date.now();
    const tagged = tagSessionPortTurn('imported history seed', SID, env, now);
    expect(classify(tagged, readLedgerRows(SID, { dir, nowMs: now }), { nowMs: now })).toMatchObject({
      verdict: 'verified-agent',
      origin: 'session-port',
      matchedBy: 'nonce+hash',
    });
  });
});
