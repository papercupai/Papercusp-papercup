// P-003 / R-1 live probe, stage 2: reuse the judge launch from stage 1 (argv[2] = stage-1
// report, argv[3] = output). Reads the launch record from Postgres, exercises the signed judge
// MCP grant on :3170 at dispatch, then ends the probe session (no agent process is started).
//
// PROBE_GOVERNED declares whether the worn stack's compiled identity carries
// `configuration.grants` (1) or not (0). The expectation comes from the code's contract, not
// from the result: bootstrap-role.ts persists an identity-bearing launch record ONLY for a
// grant-bearing artifact, so a governed launch must leave a record naming role judge and the
// exact stack, and an ungoverned one must leave none. Running both stacks covers both branches.
//
// The governed ceiling oracle is the administrator pot source read independently here
// (.papercusp/blueprint.yaml fleet.workerRoles): identity-grants-port.ts readIdentityGrantPolicy
// refuses ("policy-unavailable") when the pot declares no capability ceiling for the role, so a
// governed judge in a pot with no judge ceiling must be granted NOTHING; with a declared
// ceiling the read must pass and the outside tools must still be refused.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const [stage1Path, OUT] = process.argv.slice(2);
if (!stage1Path || !OUT) throw new Error('usage: stage2-exercise.mjs <stage1-report.json> <report.json>');
if (!['0', '1'].includes(process.env.PROBE_GOVERNED ?? '')) throw new Error('PROBE_GOVERNED must be 0 or 1');
const GOVERNED = process.env.PROBE_GOVERNED === '1';
const stage1 = JSON.parse(readFileSync(stage1Path, 'utf8'));
const body = JSON.parse(readFileSync(stage1Path.replace(/\.json$/, '.launch-body.json'), 'utf8'));
const report = { startedAt: new Date().toISOString(), stage1: stage1Path, stack: stage1.stack, governedDeclared: GOVERNED,
  sessionId: body.sessionId, assertions: [...stage1.assertions] };
const assert = (id, passed, evidence) => { report.assertions.push({ id, passed: Boolean(passed), evidence }); };
const psql = (sql) => execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-At', '-c', sql], { encoding: 'utf8' }).trim();
const OUTSIDE = ['capability:bash', 'processes:kill', 'capability:grant_role', 'dev:restart', 'work_items:create'];
const POLICY_UNAVAILABLE = /Identity capability \(unresolved\): policy-unavailable/;
const JUDGE_MISSING_CAPABILITY = /missing_capability: Principal .{0,4}system:judge.{0,4} lacks capability/;

try {
  if (stage1.exitCode !== 0) throw new Error(`stage 1 did not pass (exitCode ${stage1.exitCode}); refusing to exercise its launch`);
  const prompt = readFileSync(body.promptFile, 'utf8');
  const LAYER_MARK = process.env.PROBE_LAYER_MARK ?? "## IDEATE mode — the owner's switch";
  assert('judge-prompt-renders-worn-layer', prompt.includes(LAYER_MARK),
    `${body.promptFile} (${prompt.length} chars) contains the worn layer text ${JSON.stringify(LAYER_MARK)}; launch role=${body.role}, compositionSource=${body.compositionSource}`);

  // (c) the launch record, as bootstrap-role recorded it
  const id = Number(body.sessionId);
  const row = JSON.parse(psql(`SELECT json_build_object('owner', coord_owner_id, 'role', role, 'specRole', launch_spec->>'role', 'stack', launch_spec->'stack', 'specRev', launch_spec->>'specificationRevision', 'hasGrants', (launch_spec->'specificationArtifact'->'configuration'->>'grants') IS NOT NULL) FROM harness_shared.adv_sessions WHERE id = ${id}`));
  report.launchRecord = row;
  const recordEvidence = `adv_sessions ${id}: role=${row.role}, launch_spec.role=${row.specRole}, launch_spec.stack=${JSON.stringify(row.stack)}, artifact grants present=${row.hasGrants}, owner=${row.owner}`;
  if (GOVERNED) {
    assert('governed-launch-record-names-judge-and-stack', row.specRole === 'judge' && row.hasGrants === true &&
      JSON.stringify(row.stack) === JSON.stringify(stage1.stack), recordEvidence);
  } else {
    assert('ungoverned-launch-writes-no-identity-record', row.role === 'judge' && row.specRole === null && row.stack === null &&
      row.hasGrants === false, `${recordEvidence} (bootstrap-role.ts records an identity launch only when the artifact carries configuration.grants)`);
  }

  // The administrator pot's own ceiling for the judge role, read independently.
  const potRoles = parseYaml(readFileSync('.papercusp/blueprint.yaml', 'utf8'))?.fleet?.workerRoles ?? [];
  const judgeCeiling = potRoles.find((r) => r.id === 'judge')?.capabilities;
  report.potJudgeCeiling = judgeCeiling ?? null;
  report.potRolesWithCeiling = potRoles.filter((r) => r.capabilities !== undefined).map((r) => r.id);

  // (d) the signed grant, exercised at dispatch
  const mcp = JSON.parse(readFileSync(body.mcpJsonPath, 'utf8'));
  const server = Object.values(mcp.mcpServers ?? {})[0];
  const url = new URL(server.url);
  report.grantUrl = { origin: url.origin, role: url.searchParams.get('role'), superuser: url.searchParams.get('superuser'), tools: url.searchParams.get('tools') };
  assert('grant-is-judge-scoped', url.searchParams.get('role') === 'judge' && !url.searchParams.has('superuser'),
    `signed MCP URL role=${url.searchParams.get('role')}, superuser param ${url.searchParams.has('superuser') ? 'PRESENT' : 'absent'}`);
  let sessionHeader = null;
  const rpc = async (method, params, rid) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(server.headers ?? {}) };
    if (sessionHeader) headers['mcp-session-id'] = sessionHeader;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(rid != null ? { id: rid } : {}) }) });
    sessionHeader = r.headers.get('mcp-session-id') ?? sessionHeader;
    const text = await r.text();
    const dataLine = text.split('\n').filter((l) => l.startsWith('data:')).pop();
    try { return JSON.parse(dataLine ? dataLine.slice(5) : text); } catch { return { raw: text.slice(0, 400), http: r.status }; }
  };
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p003-live-probe', version: '1' } }, 1);
  await rpc('notifications/initialized', {});
  // A launched agent's first turn: the UserPromptSubmit hook's turn-start call marks the
  // activation prepared and coord:orient applies it, so dispatch judges the grant itself.
  const owner = row.owner;
  const activation = () => psql(`SELECT coalesce(control_state->'activation'->>'status','none') || ' applied=' || coalesce(left(control_state->'activation'->'applied'->>'specificationRevision', 12),'none') FROM harness_shared.session_briefs WHERE owner_id = '${owner.replace(/'/g, "''")}'`) || 'no-brief';
  report.activationBefore = activation();
  const ts = await fetch(`${stage1.base}/api/agent-mcp/turn-start-memory`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner, prompt: 'P-003 live judge-wearer probe: first turn', workspace: 'papercusp-workspace',
      harness: 'papercusp', client: 'claude', cwd: body.cwd, memoryEnabled: false, wallMs: 20000 }),
  });
  report.turnStart = { http: ts.status, body: (await ts.text()).slice(0, 400) };
  report.activationAfterTurnStart = activation();
  const orient = await rpc('tools/call', { name: 'tools:invoke', arguments: { name: 'coord:orient', args: { afterCompaction: true, projection: { pick: ['ok'] } } } }, 3);
  report.orient = JSON.stringify(orient).slice(0, 500);
  report.activationAfter = activation();
  const list = await rpc('tools/list', {}, 2);
  const names = (list.result?.tools ?? []).map((t) => t.name);
  report.toolsListed = names.length;
  const leaked = OUTSIDE.filter((n) => names.some((x) => x === n || x.endsWith(n.replace(':', '_'))));
  assert('judge-tool-list-excludes-su-tools', names.length > 0 && leaked.length === 0,
    `tools/list via the signed judge URL returned ${names.length} tools; su-only/outside-ceiling tools listed: ${leaked.length ? leaked.join(',') : 'none'} (checked ${OUTSIDE.join(',')})`);
  const refusals = [];
  for (const [i, name] of ['capability:bash', 'processes:kill'].entries()) {
    const out = await rpc('tools/call', { name: 'tools:invoke', arguments: { name, args: name === 'capability:bash' ? { command: 'true' } : { taskId: 'p003-probe-none' } } }, 10 + i);
    const text = JSON.stringify(out).slice(0, 600);
    refusals.push({ name, refused: /missing_capability|not permitted|denied|not allowed|outside|forbidden|unknown tool|not in (the )?allow/i.test(text),
      policyUnavailable: POLICY_UNAVAILABLE.test(text), judgeMissingCapability: JUDGE_MISSING_CAPABILITY.test(text), text });
  }
  report.refusals = refusals;
  assert('dispatch-refuses-outside-judge-ceiling', refusals.every((r) => r.refused),
    refusals.map((r) => `${r.name}: ${r.refused ? 'refused' : 'NOT refused'} (${r.text.slice(0, 160)})`).join(' | '));
  const read = await rpc('tools/call', { name: 'tools:invoke', arguments: { name: 'plans:get', args: { slug: 'identity-system-everything-migration-2026-10-18', harness: 'papercusp', heading: 'Now' } } }, 20);
  const readFull = JSON.stringify(read);
  report.allowedRead = readFull.slice(0, 1200);
  const readOk = !read.error && !(read.result?.isError) && !/missing_capability|not permitted|denied/i.test(readFull) &&
    /identity-system-everything-migration/.test(readFull);
  const readEvidence = `plans:get through the judge grant: ${read.result?.isError ? 'isError' : 'ok'}, ${readFull.length} chars, names the plan slug=${/identity-system-everything-migration/.test(readFull)}, policy-unavailable=${POLICY_UNAVAILABLE.test(readFull)}`;
  if (GOVERNED && judgeCeiling === undefined) {
    // No pot ceiling for judge: the grant kernel must fail closed on every call, the read included.
    assert('governed-judge-without-pot-ceiling-is-granted-nothing',
      refusals.every((r) => r.policyUnavailable) && !readOk && POLICY_UNAVAILABLE.test(readFull),
      `pot .papercusp/blueprint.yaml declares worker-role ceilings for [${report.potRolesWithCeiling.join(', ')}] and none for judge; ` +
      `${refusals.map((r) => `${r.name} policy-unavailable=${r.policyUnavailable}`).join(', ')}; ${readEvidence}`);
  } else {
    if (!GOVERNED) {
      assert('ungoverned-dispatch-refuses-by-judge-envelope', refusals.every((r) => r.judgeMissingCapability),
        refusals.map((r) => `${r.name}: judge missing_capability=${r.judgeMissingCapability}`).join(' | '));
    }
    assert('dispatch-allows-read-inside-judge-ceiling', readOk, readEvidence);
  }
} catch (e) {
  report.fatal = String(e?.stack ?? e);
} finally {
  // end the probe session (it never started an agent process)
  try {
    const r = await fetch(`${stage1.base}/api/agent-mcp/console/bootstrap-su/session-ended`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ advSessionId: Number(body.sessionId), endAttemptKey: `p003-live-probe-end-${body.sessionId}`, exitCode: 0 }),
    });
    report.sessionEnded = { http: r.status, body: (await r.text()).slice(0, 300) };
  } catch (e) { report.sessionEnded = { error: String(e) }; }
}
report.finishedAt = new Date().toISOString();
report.exitCode = report.fatal || report.assertions.some((a) => !a.passed) ? 1 : 0;
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ exitCode: report.exitCode, assertions: report.assertions.map((a) => `${a.passed ? 'PASS' : 'FAIL'} ${a.id}: ${a.evidence.slice(0, 220)}`), fatal: report.fatal ?? null, sessionEnded: report.sessionEnded }, null, 1));
process.exitCode = report.exitCode;
