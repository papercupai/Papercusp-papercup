/**
 * Unit tests for the capability-envelope policy evaluator
 * (agent-capability-confinement-2026-06-13 B-06 / P-012). Pure, no PG.
 * EI-2048: the suites below verify the ENVELOPE's own deny logic, so they force
 * the testing-phase full-access exemption OFF; the exemption is covered by its
 * own suite at the bottom.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateCapabilityEnvelope,
  FLEET_ENVELOPE_ROLES,
  PROTECTED_CAPABILITY_GLOBS,
} from './policy';

const base = { toolName: 'plans.set-status', capabilities: ['plans:write'] as const };

// EI-2048: disable the testing-phase full-access exemption for the envelope-logic
// suites (otherwise the testing roles — operator/queen/bee/overwatch/sentinel/scout
// — would bypass their per-role denies, masking the deny assertions).
const prevTestingFlag = process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES;
beforeAll(() => { process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = 'off'; });
afterAll(() => {
  if (prevTestingFlag === undefined) delete process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES;
  else process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = prevTestingFlag;
});

describe('evaluateCapabilityEnvelope — exemptions (D-002)', () => {
  it('exempts a superuser caller (applied=false)', () => {
    const d = evaluateCapabilityEnvelope({ ...base, ctx: { role: 'worker', isSuperuser: true } });
    expect(d.applied).toBe(false);
    expect(d.withinEnvelope).toBe(true);
  });

  it('exempts a power-user caller', () => {
    expect(evaluateCapabilityEnvelope({ ...base, ctx: { role: 'worker', isPowerUser: true } }).applied).toBe(false);
  });

  it('exempts a roleless caller (e.g. a bearer API call)', () => {
    expect(evaluateCapabilityEnvelope({ ...base, ctx: {} }).applied).toBe(false);
  });

  it('exempts the interactive chat roles (operator / oracle)', () => {
    expect(evaluateCapabilityEnvelope({ ...base, ctx: { role: 'operator' } }).applied).toBe(false);
    expect(evaluateCapabilityEnvelope({ ...base, ctx: { role: 'oracle' } }).applied).toBe(false);
  });
});

describe('evaluateCapabilityEnvelope — fleet roles', () => {
  it('applies to a fleet role; a normal capability is within the envelope', () => {
    const d = evaluateCapabilityEnvelope({ ...base, ctx: { role: 'worker' } });
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it('denies a protected capability (secrets:*) for a fleet role', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'secrets.read',
      capabilities: ['secrets:read:db'],
      ctx: { role: 'worker' },
    });
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(false);
    expect(d.reason).toContain('protected');
  });

  it('denies processes:kill for a fleet role (e.g. the Queen)', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'processes.kill',
      capabilities: ['processes:kill'],
      ctx: { role: 'mug' },
    });
    expect(d.withinEnvelope).toBe(false);
  });

  it('a multi-capability tool is beyond-envelope if ANY capability is protected', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'mixed.tool',
      capabilities: ['plans:write', 'secrets:read:x'],
      ctx: { role: 'worker' },
    });
    expect(d.withinEnvelope).toBe(false);
  });
});

describe('evaluateCapabilityEnvelope — bee write-capable (confinement LIFTED 2026-06-14)', () => {
  const bee = (capabilities: readonly string[], toolName = 't') =>
    evaluateCapabilityEnvelope({ toolName, capabilities, ctx: { role: 'cup' } });

  it('ALLOWS capability:fs-write for the bee (write/edit opened — owner-directed full autonomy)', () => {
    const d = bee(['capability:fs-write'], 'capability:write');
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(true);
  });

  it('ALLOWS capability:bash for the bee (exec opened — it must land fixes, not just diagnose)', () => {
    expect(bee(['capability:bash'], 'capability:bash').withinEnvelope).toBe(true);
  });

  it('still allows capability:fs-read + capability:code-inspect for the bee (read + verify stay open)', () => {
    expect(bee(['capability:fs-read'], 'capability:read').withinEnvelope).toBe(true);
    expect(bee(['capability:code-inspect'], 'capability:inspect').withinEnvelope).toBe(true);
  });

  it('leaves the coordination plane open (the bee must report + escalate)', () => {
    for (const cap of ['coord:write', 'work_items:write', 'plans:write', 'messages:write']) {
      expect(bee([cap]).withinEnvelope, `${cap} should stay within the bee envelope`).toBe(true);
    }
  });

  it('STILL denies the universal protected set for the bee (secrets / processes:kill — the floor holds)', () => {
    expect(bee(['secrets:read:x']).withinEnvelope).toBe(false);
    expect(bee(['processes:kill']).withinEnvelope).toBe(false);
  });

  it('the pipeline worker role is likewise write-capable (unchanged)', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'capability:write',
      capabilities: ['capability:fs-write'],
      ctx: { role: 'worker' },
    });
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(true);
  });
});

describe('evaluateCapabilityEnvelope — dedicated acceptance judge', () => {
  const judge = (capability: string, toolName = 't') =>
    evaluateCapabilityEnvelope({ toolName, capabilities: [capability], ctx: { role: 'judge' } });

  it('denies broad implementation, memory, and search while leaving narrow evidence reads open', () => {
    for (const capability of ['capability:fs-write', 'capability:bash', 'capability:git', 'memory:read', 'search:read']) {
      expect(judge(capability).withinEnvelope, capability).toBe(false);
    }
    expect(judge('capability:fs-read', 'capability:read').withinEnvelope).toBe(true);
    expect(judge('capability:git-evidence:read', 'capability:git-evidence').withinEnvelope).toBe(true);
    expect(judge('memory:search:read', 'memory:search').withinEnvelope).toBe(true);
    expect(judge('sessions:read', 'sessions:read').withinEnvelope).toBe(true);
    expect(judge('coord:write', 'scorecards:emit').withinEnvelope).toBe(true);
  });
});

describe('evaluateCapabilityEnvelope — overwatch read+nudge confinement (overwatch-role-2026-06-15 B-01 / D-002)', () => {
  const ow = (capabilities: readonly string[], toolName = 't') =>
    evaluateCapabilityEnvelope({ toolName, capabilities, ctx: { role: 'kettle' } });

  it('DENIES capability:fs-write for the overwatch (it nudges + observes, it never edits code)', () => {
    const d = ow(['capability:fs-write'], 'capability:write');
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(false);
    expect(d.reason).toContain('kettle');
  });

  it('DENIES capability:bash for the overwatch (no shell — it acts on AGENTS, never on the box)', () => {
    expect(ow(['capability:bash'], 'capability:bash').withinEnvelope).toBe(false);
  });

  it('leaves its read + nudge/observe plane open (coord:write nudges, messages:write directives, reads)', () => {
    for (const cap of ['coord:write', 'messages:write']) {
      expect(ow([cap]).withinEnvelope, `${cap} should stay within the overwatch envelope`).toBe(true);
    }
    expect(ow(['capability:fs-read'], 'capability:read').withinEnvelope).toBe(true);
  });

  it('STILL denies the universal protected set (the floor holds for the watcher too)', () => {
    expect(ow(['secrets:read:x']).withinEnvelope).toBe(false);
    expect(ow(['processes:kill']).withinEnvelope).toBe(false);
  });
});

describe('evaluateCapabilityEnvelope — sentinel/Herald read+suggest confinement (Sentinel-as-Herald)', () => {
  const sn = (capabilities: readonly string[], toolName = 't') =>
    evaluateCapabilityEnvelope({ toolName, capabilities, ctx: { role: 'papercup' } });

  it('DENIES capability:fs-write for the sentinel (the Herald suggests + hands off, it never edits code)', () => {
    const d = sn(['capability:fs-write'], 'capability:write');
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(false);
    expect(d.reason).toContain('papercup');
  });

  it('DENIES capability:bash for the sentinel (no shell — it files work + nudges the Queen, never runs anything)', () => {
    expect(sn(['capability:bash'], 'capability:bash').withinEnvelope).toBe(false);
  });

  it('leaves the Herald plane open: converse + voice + file-a-work_item + nudge + reads', () => {
    // CAN talk / drive voice / file the user's ask / nudge the Queen / read state.
    for (const cap of [
      'operator:converse',
      'operator:read',
      'operator:write',
      'work_items:write', // work_items:create / set_priority (file the ask)
      'coord:write', // coord:send / escalate (nudge the Queen)
      'curation:read',
      'plans:read',
    ]) {
      expect(sn([cap]).withinEnvelope, `${cap} should stay within the sentinel envelope`).toBe(true);
    }
    expect(sn(['capability:fs-read'], 'capability:read').withinEnvelope).toBe(true);
  });

  it('STILL denies the universal protected set (the floor holds for the Herald too)', () => {
    expect(sn(['secrets:read:x']).withinEnvelope).toBe(false);
    expect(sn(['processes:kill']).withinEnvelope).toBe(false);
  });
});

describe('evaluateCapabilityEnvelope — testing-phase full access (EI-2048)', () => {
  // Flag ON (default / unset): the testing roles bypass their per-role denies, but
  // the universal protected floor still holds.
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES; delete process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES; });
  afterEach(() => { if (prev === undefined) delete process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES; else process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = prev; });

  it('a testing role (overwatch) is now ALLOWED its per-role-denied caps (fs-write/bash)', () => {
    expect(evaluateCapabilityEnvelope({ toolName: 'capability:write', capabilities: ['capability:fs-write'], ctx: { role: 'kettle' } }).withinEnvelope).toBe(true);
    expect(evaluateCapabilityEnvelope({ toolName: 'capability:bash', capabilities: ['capability:bash'], ctx: { role: 'kettle' } }).withinEnvelope).toBe(true);
  });

  it('but the universal PROTECTED floor STILL holds for a testing role (secrets / processes:kill)', () => {
    expect(evaluateCapabilityEnvelope({ toolName: 'secrets.read', capabilities: ['secrets:read:x'], ctx: { role: 'kettle' } }).withinEnvelope).toBe(false);
    expect(evaluateCapabilityEnvelope({ toolName: 'processes.kill', capabilities: ['processes:kill'], ctx: { role: 'mug' } }).withinEnvelope).toBe(false);
  });

  it('kill-switch: PAPERCUSP_TESTING_FULL_ACCESS_ROLES=off restores the per-role deny', () => {
    process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = 'off';
    expect(evaluateCapabilityEnvelope({ toolName: 'capability:write', capabilities: ['capability:fs-write'], ctx: { role: 'kettle' } }).withinEnvelope).toBe(false);
  });
});

describe('envelope constants', () => {
  it('FLEET_ENVELOPE_ROLES excludes the chat roles but includes the autonomous fleet', () => {
    expect(FLEET_ENVELOPE_ROLES.has('operator')).toBe(false);
    expect(FLEET_ENVELOPE_ROLES.has('oracle')).toBe(false);
    expect(FLEET_ENVELOPE_ROLES.has('worker')).toBe(true);
    expect(FLEET_ENVELOPE_ROLES.has('mug')).toBe(true);
    expect(FLEET_ENVELOPE_ROLES.has('cup')).toBe(true);
    expect(FLEET_ENVELOPE_ROLES.has('judge')).toBe(true);
  });

  it('the protected set is non-empty (the only active B-06 constraint)', () => {
    expect(PROTECTED_CAPABILITY_GLOBS.length).toBeGreaterThan(0);
  });
});
