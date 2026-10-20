// The verdict oracle of the P-003 / R-1 live judge-wearer probe
// (docs/evidence/p003-judge-wearer-live-2026-10-20/stage2-exercise.mjs).
//
// stage2 collects observations from a running operator: the launch record bootstrap-role wrote
// to adv_sessions, the pot's own worker-role ceiling for judge, the tool list and dispatch
// replies seen through the signed judge MCP grant. Every pass/fail decision over those
// observations lives here, as pure functions, so the decisions are covered by a committed test
// (judge-wearer-live-oracle.test.ts) and a binding can cite this file as its instrument.
//
// The expectations come from the code's contract, not from a probe result:
//   - bootstrap-role.ts persists an identity-bearing launch record ONLY for a grant-bearing
//     artifact, so a governed launch names role judge and the exact worn stack, and an
//     ungoverned launch leaves no identity record;
//   - identity-grants-port.ts readIdentityGrantPolicy refuses ("policy-unavailable") when the pot
//     declares no capability ceiling for the role, so a governed judge in a pot without a judge
//     ceiling is granted NOTHING, reads included;
//   - with a ceiling (or ungoverned, under the judge role envelope) tools outside the ceiling are
//     refused and a read inside it succeeds.

/** su-only or outside-the-judge-ceiling tools; none may be listed through a judge grant. */
export const OUTSIDE_JUDGE_CEILING = Object.freeze([
  'capability:bash',
  'processes:kill',
  'capability:grant_role',
  'dev:restart',
  'work_items:create',
]);

/** The dispatch tools the probe calls and expects to be refused. */
export const REFUSAL_PROBE_TOOLS = Object.freeze(['capability:bash', 'processes:kill']);

const POLICY_UNAVAILABLE = /Identity capability \(unresolved\): policy-unavailable/;
const JUDGE_MISSING_CAPABILITY = /missing_capability: Principal .{0,4}system:judge.{0,4} lacks capability/;
const REFUSED = /missing_capability|not permitted|denied|not allowed|outside|forbidden|unknown tool|not in (the )?allow/i;
const READ_REFUSED = /missing_capability|not permitted|denied/i;

/** True when a reply carries the grant kernel's fail-closed "policy-unavailable" refusal. */
export function isPolicyUnavailable(text) {
  return POLICY_UNAVAILABLE.test(text);
}

/**
 * Judge the launch record bootstrap-role wrote.
 * @param {{ governed: boolean, row: { role: string|null, specRole: string|null, stack: unknown, hasGrants: boolean|null }, stack: string[] }} input
 * @returns {{ id: string, passed: boolean }}
 */
export function judgeLaunchRecord({ governed, row, stack }) {
  if (governed) {
    return {
      id: 'governed-launch-record-names-judge-and-stack',
      passed: row.specRole === 'judge' && row.hasGrants === true && JSON.stringify(row.stack) === JSON.stringify(stack),
    };
  }
  return {
    id: 'ungoverned-launch-writes-no-identity-record',
    passed: row.role === 'judge' && row.specRole === null && row.stack === null && row.hasGrants === false,
  };
}

/**
 * The signed MCP URL must name role judge and carry no superuser parameter.
 * @param {URL} url
 */
export function judgeGrantScope(url) {
  return { id: 'grant-is-judge-scoped', passed: url.searchParams.get('role') === 'judge' && !url.searchParams.has('superuser') };
}

/**
 * Tools from OUTSIDE_JUDGE_CEILING that a judge tool list exposes (by colon name or by the
 * client-mangled `<server>_<group>_<verb>` suffix).
 * @param {string[]} names
 */
export function leakedTools(names) {
  return OUTSIDE_JUDGE_CEILING.filter((n) => names.some((x) => x === n || x.endsWith(n.replace(':', '_'))));
}

/** @param {string[]} names */
export function judgeToolList(names) {
  const leaked = leakedTools(names);
  return { id: 'judge-tool-list-excludes-su-tools', passed: names.length > 0 && leaked.length === 0, leaked };
}

/**
 * Classify one dispatch reply for a tool the judge must not reach.
 * @param {string} name
 * @param {string} text the serialized JSON-RPC reply
 */
export function classifyRefusal(name, text) {
  return {
    name,
    refused: REFUSED.test(text),
    policyUnavailable: POLICY_UNAVAILABLE.test(text),
    judgeMissingCapability: JUDGE_MISSING_CAPABILITY.test(text),
    text,
  };
}

/**
 * Did a read inside the ceiling succeed?
 * @param {{ error?: unknown, result?: Record<string, unknown> & { isError?: boolean } }} reply the JSON-RPC reply
 * @param {string} readMarker text a successful read must contain (e.g. the plan slug it asked for)
 */
export function readSucceeded(reply, readMarker) {
  if (!readMarker) throw new Error('readSucceeded needs a non-empty readMarker');
  const text = JSON.stringify(reply);
  return !reply.error && !(reply.result?.isError) && !READ_REFUSED.test(text) && text.includes(readMarker);
}

/**
 * The dispatch verdicts, given every refusal and the inside-ceiling read.
 * @param {{ governed: boolean, judgeCeiling: unknown, refusals: ReturnType<typeof classifyRefusal>[], readReply: object, readMarker: string }} input
 * @returns {{ id: string, passed: boolean }[]}
 */
export function judgeDispatch({ governed, judgeCeiling, refusals, readReply, readMarker }) {
  const out = [{ id: 'dispatch-refuses-outside-judge-ceiling', passed: refusals.length > 0 && refusals.every((r) => r.refused) }];
  const readOk = readSucceeded(readReply, readMarker);
  if (governed && judgeCeiling === undefined) {
    // No pot ceiling for judge: the grant kernel must fail closed on every call, the read included.
    out.push({
      id: 'governed-judge-without-pot-ceiling-is-granted-nothing',
      passed: refusals.every((r) => r.policyUnavailable) && !readOk && isPolicyUnavailable(JSON.stringify(readReply)),
    });
    return out;
  }
  if (!governed) {
    out.push({ id: 'ungoverned-dispatch-refuses-by-judge-envelope', passed: refusals.every((r) => r.judgeMissingCapability) });
  }
  out.push({ id: 'dispatch-allows-read-inside-judge-ceiling', passed: readOk });
  return out;
}
