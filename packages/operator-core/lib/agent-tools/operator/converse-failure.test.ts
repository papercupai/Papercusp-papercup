import { describe, expect, it } from 'vitest';
import { BRAIN_NO_OUTPUT_PREFIX, brainNoOutputMessage } from './converse-failure';

const one = (engine: string | null | undefined, model: string | null | undefined, error: string | null | undefined) => ({
  attempts: [{ engine, model, error }],
});

describe('brainNoOutputMessage — a failed converse turn says WHY (WI-10003188)', () => {
  it("carries the backend's own error line plus the backend and model that ran", () => {
    const msg = brainNoOutputMessage(
      one('codex', 'gpt-5.6-luna:low', 'codex: not logged in (run `codex login`)\n--- noise on a later line ---'),
    );
    expect(msg.startsWith(BRAIN_NO_OUTPUT_PREFIX)).toBe(true);
    expect(msg).toContain('codex, model gpt-5.6-luna:low');
    expect(msg).toContain('codex: not logged in');
    // Only the first line travels; the rest stays in the host journal.
    expect(msg).not.toContain('noise on a later line');
    expect(msg.endsWith(')')).toBe(true);
  });

  it('with no backend error, names the backend and points at its credential instead of a bare "failure"', () => {
    const msg = brainNoOutputMessage(one('codex', 'gpt-5.6-luna:low', null));
    expect(msg).toContain('codex, model gpt-5.6-luna:low returned an empty turn and reported no error');
    expect(msg).toContain('working codex credential');
    // The old fixed text said nothing actionable; this must never regress to it.
    expect(msg).not.toBe('operator brain produced no output (agent backend failure)');
  });

  it('keeps the legacy prefix so existing log greps still match', () => {
    expect(BRAIN_NO_OUTPUT_PREFIX).toBe('operator brain produced no output (agent backend failure');
  });

  it('caps a runaway backend error line and skips blank leading lines', () => {
    const msg = brainNoOutputMessage(one('claude', null, `\n   \n${'x'.repeat(1000)}`));
    expect(msg).toContain(': claude: ');
    expect(msg).not.toContain('model');
    const backendPart = msg.slice(msg.indexOf(': claude: ') + ': claude: '.length, -1);
    expect(backendPart.length).toBeLessThanOrEqual(240);
    expect(backendPart.endsWith('…')).toBe(true);
  });

  it('degrades to a generic label when the backend is unknown or no attempt was recorded', () => {
    expect(brainNoOutputMessage(one(undefined, undefined, ''))).toContain('unknown backend returned an empty turn');
    expect(brainNoOutputMessage({ attempts: [] })).toContain('unknown backend returned an empty turn');
  });
});

describe('brainNoOutputMessage — every backend the turn tried (WI-10004897)', () => {
  const CAP = "claude-code exited 1: You've hit your limit · resets Oct 6, 9pm (UTC)";
  const CODEX_401 = 'codex exited 1: unexpected status 401 Unauthorized: Your authentication token has expired.';

  it('a failed-over turn names the first backend’s cause AND the alternate’s, in order', () => {
    const msg = brainNoOutputMessage({
      attempts: [
        { engine: 'claude-code', model: 'sonnet:low', error: CAP },
        { engine: 'codex', model: 'gpt-5.6-luna:low', error: CODEX_401 },
      ],
    });
    expect(msg).toBe(
      `${BRAIN_NO_OUTPUT_PREFIX}: claude-code, model sonnet:low: ${CAP}; then codex, model gpt-5.6-luna:low: ${CODEX_401})`,
    );
  });

  it('repeated identical attempts on one backend read as one entry with a count', () => {
    const msg = brainNoOutputMessage({
      attempts: [
        { engine: 'codex', model: 'gpt-5.6-luna:low', error: CODEX_401 },
        { engine: 'codex', model: 'gpt-5.6-luna:low', error: CODEX_401 },
      ],
    });
    expect(msg).toContain('codex, model gpt-5.6-luna:low (2 attempts): ');
    expect(msg).not.toContain('; then ');
  });

  it('a skipped failover is named with the credential reason', () => {
    const msg = brainNoOutputMessage({
      attempts: [{ engine: 'claude-code', model: 'sonnet:low', error: CAP }],
      skippedFailover: { engine: 'codex', model: 'gpt-5.6-luna:low', credential: 'expired-no-refresh' },
    });
    expect(msg).toContain(`claude-code, model sonnet:low: ${CAP}`);
    expect(msg).toContain(
      "failover to codex (model gpt-5.6-luna:low) skipped: this host's codex login has expired and has no refresh token",
    );
    expect(
      brainNoOutputMessage({
        attempts: [{ engine: 'codex', model: 'm', error: 'x' }],
        skippedFailover: { engine: 'claude-code', model: 'sonnet:low', credential: 'absent' },
      }),
    ).toContain('skipped: this host has no claude-code credential');
  });
});
