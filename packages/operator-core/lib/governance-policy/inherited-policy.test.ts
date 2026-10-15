import { describe, expect, it } from 'vitest';
import {
  evaluateInheritedPolicy,
  isActiveException,
  matchPolicyPattern,
  simulateInheritedPolicy,
  type PolicyLayer,
} from './inherited-policy';

const NOW = new Date('2026-10-14T00:00:00Z');
const FUTURE = '2026-10-20T00:00:00Z';
const PAST = '2026-10-01T00:00:00Z';

const org = (rules: PolicyLayer['rules'], exceptions?: PolicyLayer['exceptions']): PolicyLayer => ({
  layerId: 'org-acme',
  level: 'organization',
  version: 3,
  rules,
  ...(exceptions ? { exceptions } : {}),
});
const dept = (rules: PolicyLayer['rules'], exceptions?: PolicyLayer['exceptions']): PolicyLayer => ({
  layerId: 'dept-eng',
  level: 'department',
  version: 1,
  rules,
  ...(exceptions ? { exceptions } : {}),
});
const ws = (rules: PolicyLayer['rules'], exceptions?: PolicyLayer['exceptions']): PolicyLayer => ({
  layerId: 'ws-papercusp',
  level: 'workspace',
  version: 7,
  rules,
  ...(exceptions ? { exceptions } : {}),
});

describe('evaluateInheritedPolicy — inherited org/department/workspace policy (P-005)', () => {
  it('legitimate inherited permission works: an org allow-list value passes every layer', () => {
    const chain = [org({ tools: { allow: ['coord:*', 'work_items:*'] } }), dept({}), ws({})];
    const v = evaluateInheritedPolicy(chain, { tools: ['coord:send'] }, NOW);
    expect(v.allow).toBe(true);
    expect(v.trace.map((s) => s.outcome)).toEqual(['pass', 'pass', 'pass']);
  });

  it('adversarial override: a workspace allow can NOT widen an organization deny', () => {
    const chain = [
      org({ tools: { deny: ['capability:bash'] } }),
      dept({ tools: { allow: ['*'] } }),
      ws({ tools: { allow: ['capability:bash'] } }),
    ];
    const v = evaluateInheritedPolicy(chain, { tools: ['capability:bash'] }, NOW);
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.code).toBe('org_policy:denied');
    expect(v.decidedBy).toMatchObject({ level: 'organization', layerId: 'org-acme', version: 3, outcome: 'deny-rule' });
    expect(v.reason).toContain('organization policy org-acme v3 denies tools');
  });

  it('adversarial override: a workspace allow-list cannot add a model outside the org allow-list', () => {
    const chain = [org({ models: { allow: ['claude-sonnet-*'] } }), ws({ models: { allow: ['claude-sonnet-*', 'gpt-*'] } })];
    const v = evaluateInheritedPolicy(chain, { models: ['gpt-5.5'] }, NOW);
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.decidedBy).toMatchObject({ level: 'organization', outcome: 'not-allowed', value: 'gpt-5.5' });
  });

  it('a workspace-level exception can not lift an organization refusal', () => {
    const chain = [
      org({ plugins: { deny: ['firecrawl'] } }),
      ws({}, [{ category: 'plugins', pattern: 'firecrawl', reason: 'need it', expiresAt: FUTURE }]),
    ];
    const v = evaluateInheritedPolicy(chain, { plugins: ['firecrawl'] }, NOW);
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.decidedBy.level).toBe('organization');
  });

  it('an active exception declared by the refusing layer lifts only that layer', () => {
    const chain = [
      org({ egress: { allow: ['*.papercusp.com'] } }, [
        { category: 'egress', pattern: 'api.github.com', reason: 'pilot', approvedBy: 'admin', expiresAt: FUTURE },
      ]),
      ws({}),
    ];
    const v = evaluateInheritedPolicy(chain, { egress: ['api.github.com'] }, NOW);
    expect(v.allow).toBe(true);
    expect(v.trace[0]).toMatchObject({ outcome: 'excepted', expiresAt: FUTURE });
  });

  it('expired, missing and malformed exception expiries fail closed', () => {
    for (const expiresAt of [PAST, undefined, 'next tuesday']) {
      const chain = [org({ dataUse: { deny: ['training'] } }, [{ category: 'dataUse', pattern: 'training', reason: 'x', expiresAt }])];
      const v = evaluateInheritedPolicy(chain, { dataUse: ['training'] }, NOW);
      expect(v.allow, `expiresAt=${String(expiresAt)}`).toBe(false);
    }
    expect(isActiveException({ category: 'dataUse', pattern: 'training', reason: 'x', expiresAt: FUTURE }, NOW.getTime())).toBe(true);
    expect(isActiveException({ category: 'bogus', pattern: 'training', reason: 'x', expiresAt: FUTURE }, NOW.getTime())).toBe(false);
  });

  it('a malformed layer refuses everything it is asked about', () => {
    const chain = [org({}), { layerId: 'ws-bad', level: 'workspace', version: 1, rules: { tools: { allow: 'everything' } } }];
    const v = evaluateInheritedPolicy(chain, { tools: ['coord:send'] }, NOW);
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.code).toBe('org_policy:malformed');
  });

  it('deny beats allow within one layer, and an empty allow-list admits nothing', () => {
    expect(evaluateInheritedPolicy([org({ actions: { allow: ['*'], deny: ['destructive'] } })], { actions: ['destructive'] }, NOW).allow).toBe(false);
    expect(evaluateInheritedPolicy([org({ actions: { allow: [] } })], { actions: ['read'] }, NOW).allow).toBe(false);
  });

  it('a department can narrow what the organization permits', () => {
    const chain = [org({ tools: { allow: ['*'] } }), dept({ tools: { deny: ['release:*'] } }), ws({})];
    const v = evaluateInheritedPolicy(chain, { tools: ['release:deploy'] }, NOW);
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.decidedBy.level).toBe('department');
  });
});

describe('matchPolicyPattern — host-suffix and prefix patterns', () => {
  it('a leading-* pattern matches a subdomain suffix, never the bare apex or a look-alike', () => {
    expect(matchPolicyPattern('*.acme.example', 'docs.acme.example')).toBe(true);
    expect(matchPolicyPattern('*.acme.example', 'a.b.acme.example')).toBe(true);
    expect(matchPolicyPattern('*.acme.example', 'acme.example')).toBe(false);
    expect(matchPolicyPattern('*.acme.example', 'evilacme.example')).toBe(false);
    expect(matchPolicyPattern('*.acme.example', '')).toBe(false);
  });

  it('trailing-* prefix, exact and match-all patterns keep their shared semantics', () => {
    expect(matchPolicyPattern('release:*', 'release:deploy')).toBe(true);
    expect(matchPolicyPattern('release:*', 'coord:send')).toBe(false);
    expect(matchPolicyPattern('coord:send', 'coord:send')).toBe(true);
    expect(matchPolicyPattern('coord:send', 'coord:sendx')).toBe(false);
    expect(matchPolicyPattern('*', 'anything')).toBe(true);
  });

  it('an egress host-suffix allow-list governs through the evaluator', () => {
    const chain = [org({ egress: { allow: ['*.acme.example'] } })];
    expect(evaluateInheritedPolicy(chain, { egress: ['api.acme.example'] }, NOW).allow).toBe(true);
    expect(evaluateInheritedPolicy(chain, { egress: ['api.other.example'] }, NOW).allow).toBe(false);
  });
});

describe('simulateInheritedPolicy — explanation/simulation without writing', () => {
  it('reports which requests a proposed workspace layer would change, and that it cannot widen the org', () => {
    const chain = [org({ tools: { deny: ['capability:bash'] } }), ws({})];
    const proposed = ws({ tools: { allow: ['capability:bash', 'coord:*'] } });
    const { cases } = simulateInheritedPolicy(chain, { ...proposed, version: 8 }, [
      { tools: ['capability:bash'] },
      { tools: ['coord:send'] },
      { tools: ['plans:get'] },
    ], NOW);
    expect(cases.map((c) => [c.before.allow, c.after.allow, c.changed])).toEqual([
      [false, false, false],
      [true, true, false],
      [true, false, true],
    ]);
  });
});
