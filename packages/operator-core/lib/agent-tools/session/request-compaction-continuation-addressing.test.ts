/**
 * WI-2140968 — the successor's first prompt must name the owner it was written FOR.
 *
 * Incident (measured 2026-09-02): su-97f1e9d6's continuation text opened a turn
 * in su-40c2fa3a's prompt stream — turn 0 of native session df60ac80…, at
 * 04:35:45.828Z, 9.6s after su-97f1e9d6's OWN carry was delivered to
 * su-97f1e9d6 with turnStartVerified:true. The peer was not starved, so this was
 * a duplicate delivery, not a misroute. Acting on it would have sent a duplicate
 * owner report and re-decided a deploy gate a live peer held.
 *
 * The delivery path is still unidentified and the obvious guards are all intact
 * (findLiveHost's EI-151 ownerId match, psu-pty-host's `ownerId-mismatch`
 * rejection, the explicit `ownerId` on the carry-respawn payload, owner-keyed
 * host paths). That is exactly why the check under test rides on the CONTENT:
 * it holds for whichever path leaked, instead of guarding one guessed path.
 *
 * Run: cd packages/operator-core && npx vitest run \
 *   lib/agent-tools/session/request-compaction-continuation-addressing.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressContinuationToOwner } from './request-compaction';

const OWNER = 'su-40c2fa3a-eeb6-4d0d-8875-64f527fac01f';
const PEER = 'su-97f1e9d6-f75b-4880-b0bb-71018531d679';

describe('addressContinuationToOwner', () => {
  it('names the owner the continuation was written for', () => {
    const out = addressContinuationToOwner('Then resume: the lane.', OWNER);
    expect(out).toContain(OWNER);
  });

  it('puts the address line FIRST, ahead of the instructions it governs', () => {
    const out = addressContinuationToOwner('Then resume: the lane.', OWNER);
    // The reader must hit the ownership check before the directives; an address
    // line buried under the instructions is read after the damage is done.
    expect(out.indexOf(OWNER)).toBeLessThan(out.indexOf('Then resume:'));
    expect(out.startsWith('ADDRESSED TO ')).toBe(true);
  });

  it('preserves the note body verbatim', () => {
    const note = 'Then resume: AUTO+GRADE lane. WI-2140701 (c)+(b) DONE; NEXT (a).';
    expect(addressContinuationToOwner(note, OWNER)).toContain(note);
  });

  it('delegates the identity check to the host without requiring a model tool call', () => {
    const out = addressContinuationToOwner('x', OWNER);
    // A warning with no instruction leaves the judgment call that failed here.
    expect(out).toContain('host checks this address');
    expect(out).not.toMatch(/coord:orient/);
    expect(out).not.toMatch(/self\.ownerId/);
    expect(out).not.toMatch(/coord:whoami/);
  });

  it('makes the incident detectable: the leaked block names the PEER, not the receiver', () => {
    // Reconstructs the failure — a block minted for the peer, read by us.
    const leaked = addressContinuationToOwner('Then resume: AUTO+GRADE lane.', PEER);
    expect(leaked).toContain(PEER);
    expect(leaked).not.toContain(OWNER);
  });

  it('is a no-op for a blank ownerId rather than emitting an empty address', () => {
    // An "ADDRESSED TO  —" line with no id is worse than none: it looks like a
    // performed check while asserting nothing.
    expect(addressContinuationToOwner('body', '')).toBe('body');
    expect(addressContinuationToOwner('body', '   ')).toBe('body');
  });
});

describe('the addressing is applied where a caller-supplied note cannot bypass it', () => {
  // Subject path is overridable so `scripts/mutation-probe.sh --against-commit`
  // can point this at a frozen pre-fix snapshot OUTSIDE the tree — proving the
  // guard falsifiable without mutating the shared checkout that git-sync sweeps.
  const SOURCE = readFileSync(
    process.env.WI2140968_SUBJECT ?? join(__dirname, 'request-compaction.ts'),
    'utf8',
  );

  it('wraps the continueNote ?? defaultContinueNote expression, not just the default', () => {
    // The bypass is the case worth guarding: `continueNote` REPLACES the default
    // note entirely, so addressing applied inside defaultContinueNote would ship
    // caller-authored continuations unaddressed. EI-22131227584499489 (the focus-
    // integrity warning) introduced an intermediate `rawNote` binding between the
    // `??` expression and the addressing call, and the later retraction guard added
    // a safe alternate branch before that fallback. Assert that the non-retracted
    // branch still contains the complete `continueNote ?? defaultContinueNote(...)`
    // expression, and that `rawNote` — not some other value — flows into addressing.
    const rawNoteIsTheOrExpression =
      /const\s+rawNote\s*=\s*[\s\S]{0,320}?\(\s*args\.continueNote\s*\?\?\s*defaultContinueNote\(/;
    const addressingWrapsRawNote = /addressContinuationToOwner\(\s*[\s\S]{0,120}?rawNote/;
    expect(SOURCE).toMatch(rawNoteIsTheOrExpression);
    expect(SOURCE).toMatch(addressingWrapsRawNote);
  });

  it('addresses the note BEFORE tagTurnForInjection hashes it', () => {
    // tagTurnForInjection writes sha256(payload) to the trust ledger. Addressing
    // after the tag would leave the line outside the hashed payload.
    const addressAt = SOURCE.indexOf('addressContinuationToOwner(\n');
    const tagAt = SOURCE.indexOf("origin: 'self-compaction'");
    expect(addressAt).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(-1);
    expect(addressAt).toBeLessThan(tagAt);
  });
});
