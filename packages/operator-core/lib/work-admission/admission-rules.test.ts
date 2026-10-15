/**
 * Pure admission-rule matching and validation (plan enterprise-data-sources-2026-10-01 P-020,
 * D-004, D-030). The integration test (data-sources/ticket-admission.integration.test.ts) proves
 * the rules admit real tickets; this file pins the matcher's semantics without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  admittedKindFor,
  matchAdmissionRule,
  TICKET_RULE_PRESETS,
  ticketRulePreset,
  validateAdmissionMatch,
  type AdmissionMatch,
} from './admission-rules';

/** Canonical tickets as the Linear and Asana packages emit them (D-010, D-011, D-012). */
const LINEAR_DELEGATED = {
  provider: 'linear', externalId: 'uuid-1', container: 'ENG', title: 'Fix login', state: 'open',
  assignees: ['Avi'], delegates: ['Papercusp'], selfRoles: ['delegate'], labels: ['Bug', 'auth'], projects: ['Q4 Hardening'],
};
const LINEAR_OTHER_AGENT = { ...LINEAR_DELEGATED, externalId: 'uuid-2', delegates: ['Other Agent'], selfRoles: undefined, labels: ['auth'] };
const ASANA_ASSIGNED = {
  provider: 'asana', externalId: '1201', container: 'Launch', title: 'Draft checklist', state: 'open',
  assignees: ['Papercusp'], selfRoles: ['assignee'], labels: ['docs'], projects: ['Launch', 'Marketing'],
};
const ASANA_SOMEONE_ELSES = { ...ASANA_ASSIGNED, externalId: '1202', assignees: ['Papercusp'], selfRoles: undefined };

describe('ticket rule presets (D-012)', () => {
  const matches = (preset: (typeof TICKET_RULE_PRESETS)[number], value: string | undefined, ticket: Record<string, unknown>) => {
    const match = ticketRulePreset(preset, value);
    validateAdmissionMatch(match);
    return matchAdmissionRule(match, ticket);
  };

  it('delegated/assigned-to-papercusp match the connected account, never a display name', () => {
    expect(matches('delegated-to-papercusp', undefined, LINEAR_DELEGATED)).toBe(true);
    expect(matches('delegated-to-papercusp', undefined, LINEAR_OTHER_AGENT)).toBe(false);
    expect(matches('assigned-to-papercusp', undefined, ASANA_ASSIGNED)).toBe(true);
    // A person whose display name happens to be "Papercusp" is not the connected account.
    expect(matches('assigned-to-papercusp', undefined, ASANA_SOMEONE_ELSES)).toBe(false);
    // Delegation and assignment are different roles.
    expect(matches('assigned-to-papercusp', undefined, LINEAR_DELEGATED)).toBe(false);
    expect(matches('delegated-to-papercusp', undefined, ASANA_ASSIGNED)).toBe(false);
  });

  it('label, team and project match their canonical fields case-insensitively', () => {
    expect(matches('label', 'bug', LINEAR_DELEGATED)).toBe(true);
    expect(matches('label', 'DOCS', ASANA_ASSIGNED)).toBe(true); // an Asana tag
    expect(matches('label', 'docs', LINEAR_DELEGATED)).toBe(false);
    expect(matches('team', 'eng', LINEAR_DELEGATED)).toBe(true);
    expect(matches('team', 'OPS', LINEAR_DELEGATED)).toBe(false);
    expect(matches('project', 'marketing', ASANA_ASSIGNED)).toBe(true); // a multi-homed task
    expect(matches('project', 'Q4 Hardening', LINEAR_DELEGATED)).toBe(true);
    expect(matches('project', 'Launch', LINEAR_DELEGATED)).toBe(false);
  });

  it('refuses a missing value where one is needed and a value where none is', () => {
    for (const preset of ['label', 'team', 'project'] as const) {
      expect(() => ticketRulePreset(preset, '  ')).toThrow(/^admission_rule_invalid: preset '.*' needs a value/);
    }
    expect(() => ticketRulePreset('delegated-to-papercusp', 'Papercusp')).toThrow(/^admission_rule_invalid: .* takes no value/);
  });

  it('every preset produces a valid match (the vocabulary is closed)', () => {
    for (const preset of TICKET_RULE_PRESETS) {
      const value = preset === 'label' || preset === 'team' || preset === 'project' ? 'x' : undefined;
      expect(() => validateAdmissionMatch(ticketRulePreset(preset, value))).not.toThrow();
    }
  });
});

describe('admittedKindFor (D-012)', () => {
  it('a ticket the provider labels bug is a bug, whatever the rule says', () => {
    expect(admittedKindFor('change', LINEAR_DELEGATED)).toBe('bug'); // "Bug"
    expect(admittedKindFor('task', { labels: ['BUG'] })).toBe('bug');
  });

  it('otherwise the rule’s kind; a label merely containing "bug" does not count', () => {
    expect(admittedKindFor('task', ASANA_ASSIGNED)).toBe('task');
    expect(admittedKindFor('change', { labels: ['debugging', 'bugfix-later'] })).toBe('change');
    expect(admittedKindFor('change', {})).toBe('change');
    expect(admittedKindFor('change', { labels: 'bug' })).toBe('change');
  });
});

const ticket = {
  state: 'open',
  project: 'Tulip',
  priority: 2,
  blocked: false,
  assignees: ['papercusp-agents', 'carol-gh'],
  labels: ['bug'],
};

describe('matchAdmissionRule', () => {
  it('matches eq case-insensitively on strings, numbers and booleans', () => {
    expect(matchAdmissionRule({ project: { eq: 'tulip' } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ priority: { eq: 2 } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ priority: { eq: '2' } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ blocked: { eq: false } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ project: { eq: 'rose' } }, ticket)).toBe(false);
  });

  it('matches in against a list of scalars', () => {
    expect(matchAdmissionRule({ state: { in: ['closed', 'OPEN'] } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ state: { in: ['closed'] } }, ticket)).toBe(false);
  });

  it('matches contains only against an array field', () => {
    expect(matchAdmissionRule({ assignees: { contains: 'papercusp-agents' } }, ticket)).toBe(true);
    expect(matchAdmissionRule({ assignees: { contains: 'dave-gh' } }, ticket)).toBe(false);
    // A scalar field never satisfies contains, even when the value is a substring.
    expect(matchAdmissionRule({ project: { contains: 'tul' } }, ticket)).toBe(false);
  });

  it('requires every field condition to hold', () => {
    const both: AdmissionMatch = { assignees: { contains: 'papercusp-agents' }, labels: { contains: 'bug' } };
    expect(matchAdmissionRule(both, ticket)).toBe(true);
    expect(matchAdmissionRule(both, { ...ticket, labels: ['feature'] })).toBe(false);
  });

  it('never matches a missing field, an empty match, or an unknown operator', () => {
    expect(matchAdmissionRule({ milestone: { eq: 'v1' } }, ticket)).toBe(false);
    expect(matchAdmissionRule({ assignees: { contains: 'x' } }, { ...ticket, assignees: undefined })).toBe(false);
    expect(matchAdmissionRule({}, ticket)).toBe(false);
    expect(matchAdmissionRule({ state: { like: 'op%' } } as unknown as AdmissionMatch, ticket)).toBe(false);
  });

  it('never treats an object or null field as a scalar', () => {
    expect(matchAdmissionRule({ owner: { eq: '[object Object]' } }, { owner: { login: 'x' } })).toBe(false);
    expect(matchAdmissionRule({ owner: { eq: 'null' } }, { owner: null })).toBe(false);
  });
});

describe('validateAdmissionMatch', () => {
  it('enforces an explicit creation-time boundary with offset-aware timestamps', () => {
    const cutoff = '2026-10-08T12:00:00.000Z';
    const match = { createdAt: { after: cutoff }, provider: { eq: 'asana' } };
    expect(() => validateAdmissionMatch(match)).not.toThrow();
    for (const createdAt of ['2026-10-08T12:00:00.001Z', '2026-10-08T08:00:01-04:00']) {
      expect(matchAdmissionRule(match, { provider: 'asana', createdAt })).toBe(true);
    }
    for (const createdAt of [cutoff, '2026-10-08T11:59:59.999Z', '2026-10-08T08:00:00-04:00',
      undefined, null, 1791450000, 'yesterday', '2026-10-08T13:00:00', '2026-02-30T13:00:00Z']) {
      expect(matchAdmissionRule(match, { provider: 'asana', createdAt })).toBe(false);
    }
    expect(matchAdmissionRule(match, { provider: 'other', createdAt: '2026-10-08T12:00:01Z' })).toBe(false);
    expect(matchAdmissionRule({ createdAt: { after: 'bad' } }, { createdAt: '2026-10-08T12:00:01Z' })).toBe(false);
    for (const after of ['today', 1, null, '2026-10-08T12:00:00', '2026-02-30T12:00:00Z']) {
      expect(() => validateAdmissionMatch({ createdAt: { after } })).toThrow(/ISO timestamp with timezone/);
    }
  });
  it('accepts well-formed matches', () => {
    expect(() => validateAdmissionMatch({ assignees: { contains: 'papercusp-agents' } })).not.toThrow();
    expect(() => validateAdmissionMatch({ state: { in: ['open', 'reopened'] }, priority: { eq: 1 } })).not.toThrow();
  });

  it.each([
    ['a non-object', 'assignees', /match must be an object/],
    ['an array', [], /match must be an object/],
    ['an empty match', {}, /at least one field/],
    ['an empty field name', { ' ': { eq: 'x' } }, /empty field name/],
    ['a field without a condition object', { state: 'open' }, /must map to/],
    ['a field with no operator', { state: {} }, /has no condition/],
    ['an unknown operator', { state: { like: 'op%' } }, /unknown operator 'like'/],
    ['an empty in list', { state: { in: [] } }, /non-empty array of scalars/],
    ['an in list with an object', { state: { in: [{ a: 1 }] } }, /non-empty array of scalars/],
    ['a non-scalar eq value', { state: { eq: ['open'] } }, /must be a string, number or boolean/],
    ['a null contains value', { assignees: { contains: null } }, /must be a string, number or boolean/],
  ])('rejects %s', (_label, match, why) => {
    expect(() => validateAdmissionMatch(match)).toThrow(/^admission_rule_invalid/);
    expect(() => validateAdmissionMatch(match)).toThrow(why);
  });
});
