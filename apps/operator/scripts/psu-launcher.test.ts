import { describe, expect, it } from 'vitest';
import {
  consumeGovernedResumeReservation,
  freshSuBootstrapBody,
  GOVERNED_RESUME_RESERVATION_ENV,
} from './psu-launcher.mjs';

describe('headless task enrollment identity in bootstrap', () => {
  const selections = { agent: 'claude', workspace: 'default', harness: 'papercup', plan: null };
  const taskId = '0123456789abcdefghj';

  it('forwards the exact owner-stamped task id only for a headless launch', () => {
    expect(freshSuBootstrapBody(selections, { headless: true }, { agentTaskId: taskId }))
      .toMatchObject({ agent_task_id: taskId });
    expect(freshSuBootstrapBody(selections, {}, { agentTaskId: taskId }))
      .not.toHaveProperty('agent_task_id');
  });

  it('drops malformed task ids', () => {
    expect(freshSuBootstrapBody(selections, { headless: true }, { agentTaskId: 'bad/id' }))
      .not.toHaveProperty('agent_task_id');
  });
});

describe('governed exact resume reservation', () => {
  const session = { id: 11, coordOwnerId: 'ended-source' };
  const reservation = { advSessionId: 11, ownerId: 'ended-source', claimKey: 'exact-attempt', expiresAtMs: 60_000 };

  it('consumes the pre-admission key for the exact child and removes it from the child environment', () => {
    const env = { [GOVERNED_RESUME_RESERVATION_ENV]: JSON.stringify(reservation) };
    expect(consumeGovernedResumeReservation(env, session, 50_000)).toEqual(reservation);
    expect(env).toEqual({});
    expect(consumeGovernedResumeReservation(env, session, 50_000)).toBeNull();
  });

  it.each([
    { advSessionId: 12 }, { ownerId: 'another-owner' }, { claimKey: '' },
    { expiresAtMs: 50_000 }, { expiresAtMs: 350_001 }, { expiresAtMs: null },
  ])('refuses mismatched or expired custody: %j', (override) => {
    const env = { [GOVERNED_RESUME_RESERVATION_ENV]: JSON.stringify({ ...reservation, ...override }) };
    expect(() => consumeGovernedResumeReservation(env, session, 50_000)).toThrow(/reservation/);
    expect(env).toEqual({});
  });
});
