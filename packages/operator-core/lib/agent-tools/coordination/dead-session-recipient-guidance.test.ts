/**
 * knowledge-at-symptom-time-2026-08-09 P-005 — a dead SESSION id in a coord:send
 * must teach the durable ROLE address, at the moment of refusal.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyUnknownRecipients,
  isSessionShapedOwnerId,
  roleAddressingGuidance,
} from './dead-session-recipient-guidance';

/** The real id from the incident P-005 was filed for. */
const INCIDENT_ID = 'su-fcdb9a01-2f4e-4c7b-9d3a-11b2c3d4e5f6';

describe('session-shaped ownerId detection', () => {
  it('recognizes the ownerId shapes this runtime issues', () => {
    // Measured against harness_shared.adv_sessions and fleet respawn ID writers.
    expect(isSessionShapedOwnerId('su-6dc49b99-310f-47cd-ad9c-eb22231c1d8e')).toBe(true);
    expect(isSessionShapedOwnerId('s-1786248683393-d2f09ca1')).toBe(true);
    expect(isSessionShapedOwnerId('su-respawn-1529d5283907a0f8c68b462778e0d1e3')).toBe(true);
    expect(isSessionShapedOwnerId('su-respawn-0123456789abcdef')).toBe(true);
    expect(isSessionShapedOwnerId('su-respawn-8a3f0001-1111-4111-8111-111111111111')).toBe(true);
    expect(isSessionShapedOwnerId(INCIDENT_ID)).toBe(true);
  });

  it('is shape-based, not prefix-based — another role\'s session is just as mortal', () => {
    // Binding to the literal `su-` would go silent for every other role, whose
    // sessions die identically. That would be a guard that only covers the one
    // case someone happened to hit first.
    expect(isSessionShapedOwnerId('mug-6dc49b99-310f-47cd-ad9c-eb22231c1d8e')).toBe(true);
    expect(isSessionShapedOwnerId('kettle-6dc49b99-310f-47cd-ad9c-eb22231c1d8e')).toBe(true);
  });

  it('does NOT fire on a handle, a role selector, or a system sender', () => {
    // The scoping that keeps the common typo path free of noise.
    for (const id of ['93a38', 'human', '*', '@role:mug', '@fleet:nonp2p-bug-drain', 'su-respawn-not-a-token', 'task-manager', 'supervision-reconciler']) {
      expect(isSessionShapedOwnerId(id), id).toBe(false);
    }
  });
});

describe('classification', () => {
  it('names the death when the session is a known ended one', async () => {
    const out = await classifyUnknownRecipients([INCIDENT_ID], async () =>
      new Map([[INCIDENT_ID, '2026-08-08T19:04:11.000Z']]),
    );
    expect(out[0].kind).toBe('ended');
    expect(out[0].endedAt).toBe('2026-08-08T19:04:11.000Z');
  });

  it('degrades to session-shaped — never to silence — when the lookup THROWS', async () => {
    // The failure this fail-soft exists for: an error path that swallowed the
    // guidance would reproduce the exact stranding P-005 is about.
    const out = await classifyUnknownRecipients([INCIDENT_ID], async () => {
      throw new Error('pg down');
    });
    expect(out[0].kind).toBe('session-shaped');
    expect(roleAddressingGuidance(out)).toContain('@role:<slot>');
  });

  it('degrades to session-shaped when no ended row is found (other tenant / never recorded)', async () => {
    const out = await classifyUnknownRecipients([INCIDENT_ID], async () => new Map());
    expect(out[0].kind).toBe('session-shaped');
  });
});

describe('the guidance itself', () => {
  it('CONTROL: the real incident input produces role-addressing guidance', async () => {
    // PERMANENT falsifiability control. P-005's incident verbatim: memory named
    // a session as the inference-gateway owner, the session was dead, coord:send
    // refused, and the escalation path evaporated. If this ever stops producing
    // guidance, the fix has been reverted into a no-op.
    const classified = await classifyUnknownRecipients([INCIDENT_ID], async () =>
      new Map([[INCIDENT_ID, '2026-08-08T19:04:11.000Z']]),
    );
    const text = roleAddressingGuidance(classified);
    expect(text).toBeTruthy();
    expect(text).toContain('@role:<slot>');
    expect(text).toContain('ENDED');
    // It must say WHY coord:presence — the advice the old refusal gave — cannot
    // help, or the caller follows that advice straight back into the dead end.
    expect(text).toContain('coord:presence');
    // And it must name the stored record as the real defect, so the next agent
    // is not stranded by the same memory/fact.
    expect(text?.toLowerCase()).toContain('re-record');
  });

  it('does not claim an ended ownerId can never become live again', () => {
    for (const kind of ['ended', 'session-shaped'] as const) {
      const text = roleAddressingGuidance([{ id: INCIDENT_ID, kind }]) ?? '';
      expect(text).toContain('identity-preserving resume may make the same ownerId live again');
      expect(text).not.toContain('no send to it can ever succeed again');
      expect(text).not.toContain('no live session will ever hold that id again');
    }
  });

  it('CONTROL: a plain typo gets NO extra guidance', () => {
    // Calibration — without this, the control above would also pass if the
    // function simply appended the lecture to every refusal, which would train
    // agents to skim the one message that most needs reading.
    const classified = [{ id: '93a38', kind: 'other' as const }];
    expect(roleAddressingGuidance(classified)).toBeNull();
  });

  it('leads with the operative clause (P-002 of this same plan)', () => {
    const text = roleAddressingGuidance([{ id: INCIDENT_ID, kind: 'session-shaped' }]) ?? '';
    // An agent that reads only the first sentence must still learn the fact
    // that changes what it does next: this id is a session, not a role.
    const firstSentence = text.split('.')[0];
    expect(firstSentence).toContain('SESSION');
    expect(firstSentence).toContain('not a standing responsibility');
  });

  it('handles several dead ids without naming one of them as if it were all', () => {
    const text =
      roleAddressingGuidance([
        { id: INCIDENT_ID, kind: 'ended', endedAt: '2026-08-08T19:04:11.000Z' },
        { id: 's-1786248683393-d2f09ca1', kind: 'session-shaped' },
      ]) ?? '';
    expect(text).toContain('2 of these ids');
  });

  it('adds the durable fleet-leader selector when the sender has named-fleet membership', () => {
    const text =
      roleAddressingGuidance(
        [{ id: INCIDENT_ID, kind: 'session-shaped' }],
        'nonp2p-bug-drain-luna-max-0811',
      ) ?? '';
    expect(text).toContain('@fleet-leader:nonp2p-bug-drain-luna-max-0811');
    expect(text).toMatch(/fleet registry/i);
    expect(text).toContain('@role:<slot>');
  });

  // EI-22180848452883121: this guidance is handed to an agent AT the moment a dead
  // recipient stranded them, so a promise it cannot keep sends them straight back
  // into the failure. It used to claim the selector "resolves the fleet registry's
  // LIVE leader and survives this leader session ending" — both false when the
  // registry pointer still names a reaped session.
  it('does not promise the fleet-leader selector is liveness-gated', () => {
    const text =
      roleAddressingGuidance([{ id: INCIDENT_ID, kind: 'session-shaped' }], 'some-fleet') ?? '';
    expect(text).not.toMatch(/resolves the fleet registry's live leader/i);
    // It must say what the selector actually does — follow a POINTER — and name the
    // refusal the caller will now get instead of a silent success receipt.
    expect(text).toMatch(/pointer/i);
    expect(text).toContain('recipients_unreachable');
  });

  it('does not invent a fleet selector when no fleet membership is available', () => {
    const text = roleAddressingGuidance([{ id: INCIDENT_ID, kind: 'session-shaped' }]) ?? '';
    expect(text).not.toContain('@fleet-leader:');
  });
});
