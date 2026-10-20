import { describe, expect, it } from 'vitest';

import {
  OUTSIDE_JUDGE_CEILING,
  classifyRefusal,
  judgeDispatch,
  judgeGrantScope,
  judgeLaunchRecord,
  judgeToolList,
  leakedTools,
  readSucceeded,
} from './judge-wearer-live-oracle.mjs';

// Reply texts copied from the live probe's recorded replies
// (docs/evidence/p003-judge-wearer-live-2026-10-20/{governed,ungoverned}-report.json, refusals[].text).
const POLICY_UNAVAILABLE_TEXT =
  'authorization_denied: Kernel preflight denied tool "tools:invoke": Identity capability (unresolved): policy-unavailable (tools:invoke) — lifts when: the identity policy for this pot and role can be read again, or a ceiling policy is published for it.';
const POLICY_UNAVAILABLE_REPLY = JSON.stringify({ result: { content: [{ type: 'text', text: POLICY_UNAVAILABLE_TEXT }], isError: true }, jsonrpc: '2.0' });
const JUDGE_ENVELOPE_REPLY = JSON.stringify({
  result: {
    content: [{ type: 'text', text: 'handler_error: missing_capability: Principal "system:judge" lacks capability "capability:bash" (tool: capability:bash) — This is a judge-scoped MCP session' }],
    isError: true,
  },
  jsonrpc: '2.0',
});
const SLUG = 'identity-system-everything-migration';
const READ_OK = { result: { content: [{ type: 'text', text: `{"slug":"${SLUG}-2026-10-18","heading":"Now"}` }] } };
const READ_POLICY_UNAVAILABLE = { result: { content: [{ type: 'text', text: POLICY_UNAVAILABLE_TEXT }], isError: true } };
const STACK = ['domain:blueprint-operation-worker'];

describe('P-003 judge-wearer live oracle — launch record', () => {
  it('passes a governed record naming judge, the exact stack and grants', () => {
    expect(judgeLaunchRecord({ governed: true, stack: STACK, row: { role: 'judge', specRole: 'judge', stack: STACK, hasGrants: true } }))
      .toEqual({ id: 'governed-launch-record-names-judge-and-stack', passed: true });
  });

  it('fails a governed record for another role, another stack, or without grants', () => {
    const base = { role: 'judge', specRole: 'judge', stack: STACK, hasGrants: true };
    for (const row of [
      { ...base, specRole: 'su' },
      { ...base, stack: ['domain:other'] },
      { ...base, hasGrants: false },
    ]) {
      expect(judgeLaunchRecord({ governed: true, stack: STACK, row }).passed).toBe(false);
    }
  });

  it('passes an ungoverned launch only when it wrote no identity record', () => {
    const none = { role: 'judge', specRole: null, stack: null, hasGrants: false };
    expect(judgeLaunchRecord({ governed: false, stack: STACK, row: none }))
      .toEqual({ id: 'ungoverned-launch-writes-no-identity-record', passed: true });
    expect(judgeLaunchRecord({ governed: false, stack: STACK, row: { ...none, specRole: 'judge', stack: STACK } }).passed).toBe(false);
    expect(judgeLaunchRecord({ governed: false, stack: STACK, row: { ...none, role: 'su' } }).passed).toBe(false);
  });
});

describe('P-003 judge-wearer live oracle — grant and tool list', () => {
  it('accepts a judge-scoped grant and refuses a superuser or non-judge one', () => {
    expect(judgeGrantScope(new URL('http://127.0.0.1:3170/api/mcp?role=judge&client=x')).passed).toBe(true);
    expect(judgeGrantScope(new URL('http://127.0.0.1:3170/api/mcp?role=judge&superuser=1')).passed).toBe(false);
    expect(judgeGrantScope(new URL('http://127.0.0.1:3170/api/mcp?role=su')).passed).toBe(false);
  });

  it('flags an outside-ceiling tool by colon or client-mangled name', () => {
    expect(leakedTools(['plans:get', 'coord:orient'])).toEqual([]);
    expect(leakedTools(['plans:get', 'mcp__papercusp-su__capability_bash'])).toEqual(['capability:bash']);
    expect(leakedTools(['dev:restart'])).toEqual(['dev:restart']);
    for (const tool of OUTSIDE_JUDGE_CEILING) expect(judgeToolList(['plans:get', tool]).passed).toBe(false);
  });

  it('refuses an empty tool list (nothing was measured)', () => {
    expect(judgeToolList([]).passed).toBe(false);
    expect(judgeToolList(['plans:get']).passed).toBe(true);
  });
});

describe('P-003 judge-wearer live oracle — dispatch', () => {
  const policyRefusals = ['capability:bash', 'processes:kill'].map((n) => classifyRefusal(n, POLICY_UNAVAILABLE_REPLY));
  const envelopeRefusals = ['capability:bash', 'processes:kill'].map((n) => classifyRefusal(n, JUDGE_ENVELOPE_REPLY));

  it('classifies the two refusal sources distinctly', () => {
    expect(policyRefusals[0]).toMatchObject({ refused: true, policyUnavailable: true, judgeMissingCapability: false });
    expect(envelopeRefusals[0]).toMatchObject({ refused: true, policyUnavailable: false, judgeMissingCapability: true });
    expect(classifyRefusal('capability:bash', '{"result":{"content":[{"text":"exit 0"}]}}').refused).toBe(false);
  });

  it('governed judge with no pot ceiling: passes only when every call, the read included, fails closed', () => {
    const verdicts = judgeDispatch({ governed: true, judgeCeiling: undefined, refusals: policyRefusals, readReply: READ_POLICY_UNAVAILABLE, readMarker: SLUG });
    expect(verdicts).toEqual([
      { id: 'dispatch-refuses-outside-judge-ceiling', passed: true },
      { id: 'governed-judge-without-pot-ceiling-is-granted-nothing', passed: true },
    ]);
  });

  it('governed judge with no pot ceiling: a read that succeeds is a grant beyond the ceiling', () => {
    const verdicts = judgeDispatch({ governed: true, judgeCeiling: undefined, refusals: policyRefusals, readReply: READ_OK, readMarker: SLUG });
    expect(verdicts.find((v) => v.id === 'governed-judge-without-pot-ceiling-is-granted-nothing')?.passed).toBe(false);
  });

  it('governed judge with no pot ceiling: a refusal from another source is not the fail-closed policy', () => {
    const verdicts = judgeDispatch({ governed: true, judgeCeiling: undefined, refusals: envelopeRefusals, readReply: READ_POLICY_UNAVAILABLE, readMarker: SLUG });
    expect(verdicts.find((v) => v.id === 'governed-judge-without-pot-ceiling-is-granted-nothing')?.passed).toBe(false);
  });

  it('an outside tool that is NOT refused fails dispatch, and so does an empty refusal set', () => {
    const leaked = [classifyRefusal('capability:bash', '{"result":{"content":[{"text":"exit 0"}]}}'), envelopeRefusals[1]];
    expect(judgeDispatch({ governed: false, judgeCeiling: undefined, refusals: leaked, readReply: READ_OK, readMarker: SLUG })[0].passed).toBe(false);
    expect(judgeDispatch({ governed: false, judgeCeiling: undefined, refusals: [], readReply: READ_OK, readMarker: SLUG })[0].passed).toBe(false);
  });

  it('ungoverned judge: refusals must come from the judge envelope and the read inside it must succeed', () => {
    expect(judgeDispatch({ governed: false, judgeCeiling: undefined, refusals: envelopeRefusals, readReply: READ_OK, readMarker: SLUG })).toEqual([
      { id: 'dispatch-refuses-outside-judge-ceiling', passed: true },
      { id: 'ungoverned-dispatch-refuses-by-judge-envelope', passed: true },
      { id: 'dispatch-allows-read-inside-judge-ceiling', passed: true },
    ]);
    const viaPolicy = judgeDispatch({ governed: false, judgeCeiling: undefined, refusals: policyRefusals, readReply: READ_OK, readMarker: SLUG });
    expect(viaPolicy.find((v) => v.id === 'ungoverned-dispatch-refuses-by-judge-envelope')?.passed).toBe(false);
    const readDenied = judgeDispatch({ governed: false, judgeCeiling: undefined, refusals: envelopeRefusals, readReply: READ_POLICY_UNAVAILABLE, readMarker: SLUG });
    expect(readDenied.find((v) => v.id === 'dispatch-allows-read-inside-judge-ceiling')?.passed).toBe(false);
  });

  it('governed judge WITH a pot ceiling: outside refused, inside read allowed', () => {
    const verdicts = judgeDispatch({ governed: true, judgeCeiling: ['plans:get'], refusals: envelopeRefusals, readReply: READ_OK, readMarker: SLUG });
    expect(verdicts).toEqual([
      { id: 'dispatch-refuses-outside-judge-ceiling', passed: true },
      { id: 'dispatch-allows-read-inside-judge-ceiling', passed: true },
    ]);
  });

  it('a read that never names its marker did not read the plan', () => {
    expect(readSucceeded({ result: { content: [{ text: '{"slug":"some-other-plan"}' }] } }, SLUG)).toBe(false);
    expect(readSucceeded({ error: { code: -32000 }, result: undefined } as never, SLUG)).toBe(false);
    expect(() => readSucceeded(READ_OK, '')).toThrow(/readMarker/);
  });
});
