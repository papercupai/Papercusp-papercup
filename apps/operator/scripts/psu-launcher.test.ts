import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumeGovernedResumeReservation,
  freshSuBootstrapBody,
  GOVERNED_RESUME_RESERVATION_ENV,
  routeFreshKickoff,
  tagKickoffProvenance,
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

describe('loop-fire provenance through a fresh successor launch', () => {
  const sid = 'su-loop-fire-provenance-test';
  const identity = { routineId: 'routine-cold-successor', wakeCount: 7 };

  it('recovers a verified inner identity and keeps the loop TTL when the private hint is legacy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-loop-fire-provenance-'));
    try {
      const nowMs = Date.now();
      const seedEnv = { PAPERCUSP_TURN_PROVENANCE_DIR: dir };
      const taggedWake = tagKickoffProvenance(
        'Continue from the loop checkpoint', sid, seedEnv, nowMs, 'loop-fire', identity,
      );
      const env = {
        ...seedEnv,
        PAPERCUSP_SID: sid,
        PAPERCUSP_KICKOFF_PROMPT: taggedWake,
        PAPERCUSP_INTERNAL_KICKOFF_ORIGIN: 'loop-fire',
      };

      const kickoff = routeFreshKickoff('codex', {}, { picker: false }, env);
      const rows = readFileSync(join(dir, `${sid}.jsonl`), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));

      expect(kickoff.managedKickoff).toContain('⟦turn-origin:loop-fire nonce:');
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        sid,
        origin: 'loop-fire',
        ttlMs: 65 * 60 * 1000,
        loopFire: identity,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not inherit identity from a prior prompt whose payload hash no longer matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-loop-fire-provenance-'));
    try {
      const nowMs = Date.now();
      const seedEnv = { PAPERCUSP_TURN_PROVENANCE_DIR: dir };
      const taggedWake = tagKickoffProvenance(
        'Continue from the loop checkpoint', sid, seedEnv, nowMs, 'loop-fire', identity,
      );
      const tamperedWake = taggedWake.replace('Continue from the loop checkpoint', 'Changed prompt');
      const env = {
        ...seedEnv,
        PAPERCUSP_SID: sid,
        PAPERCUSP_KICKOFF_PROMPT: tamperedWake,
        PAPERCUSP_INTERNAL_KICKOFF_ORIGIN: 'loop-fire',
      };

      routeFreshKickoff('codex', {}, { picker: false }, env);
      const rows = readFileSync(join(dir, `${sid}.jsonl`), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));

      expect(rows[1]).toMatchObject({ sid, origin: 'loop-fire', ttlMs: 65 * 60 * 1000 });
      expect(rows[1]).not.toHaveProperty('loopFire');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
