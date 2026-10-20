// P-003 / R-1 live probe, stage 1 (identity-system-everything-migration-2026-10-18,
// WI-6554700010017314). Launch a JUDGE through the live :3170 role door (bootstrap-role)
// wearing a real identity stack, and check that (a) the served build carries the P-003 source
// and (b) the role door accepts the launch. Writes a JSON report to argv[2]; the launch body
// (which carries per-session env) is written beside it as <report>.launch-body.json and is
// NOT part of the committed evidence. Stage 2 (stage2-exercise.mjs) reuses the launch.
// Run from the repository root through a host-context shell: it calls `sudo -n -u postgres`.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:3170';
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: stage1-launch.mjs <report.json>');
const STACK = (process.env.PROBE_STACK ?? 'ideation:su.mode-ideate').split(',');
const SOURCES = [
  'packages/operator-core/lib/agent-identities/wearer-authority.ts',
  'packages/operator-core/lib/agent-identities/wearer-launch-record.ts',
  'packages/operator-core/lib/role-launch-spec.ts',
  'packages/operator-core/lib/capability-envelope/identity-grants-port.ts',
  'packages/operator-core/lib/adv-sessions.ts',
  'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-role.ts',
];
const report = { startedAt: new Date().toISOString(), base: BASE, stack: STACK, assertions: [] };
const assert = (id, passed, evidence) => { report.assertions.push({ id, passed: Boolean(passed), evidence }); };
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const blob = (ref, p) => { try { return git('rev-parse', `${ref}:${p}`); } catch { return null; } };

try {
  // (a) served build
  const health = await (await fetch(`${BASE}/api/health`)).json();
  const sha = health.buildSha ?? health.build?.sha ?? health.sha ?? health.commit ?? null;
  report.health = { sha, keys: Object.keys(health) };
  const full = sha ? git('rev-parse', sha) : null;
  report.servedSha = full;
  const sourceBlobs = SOURCES.map((p) => ({ path: p, served: full && blob(full, p), head: blob('HEAD', p) }));
  report.sourceBlobs = sourceBlobs;
  assert('served-build-carries-p003-source', full && sourceBlobs.every((s) => s.served && s.served === s.head),
    `${BASE} /api/health build ${full}; ${sourceBlobs.filter((s) => s.served === s.head).length}/${SOURCES.length} P-003 source blobs equal HEAD`);

  // (b) launch a judge wearing the stack through the live role door
  const res = await fetch(`${BASE}/api/agent-mcp/console/bootstrap-role`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'judge', agent: 'claude', workspace: 'papercusp-workspace', harness_slug: 'papercusp',
      stack: STACK, launched_by: process.env.PAPERCUSP_SID,
      bootstrap_idempotency_key: `p003-live-judge-probe-${Date.now()}` }),
  });
  const body = await res.json();
  report.launch = { httpStatus: res.status, status: body.status, error: body.error ?? null, keys: Object.keys(body) };
  writeFileSync(OUT.replace(/\.json$/, '.launch-body.json'), JSON.stringify(body, null, 1));
  assert('role-door-accepts-judge-with-stack', res.status === 200 && body.status !== 'error', `HTTP ${res.status} status=${body.status} error=${body.error ?? 'none'}`);
} catch (e) {
  report.fatal = String(e?.stack ?? e);
}
report.finishedAt = new Date().toISOString();
report.exitCode = report.fatal || report.assertions.some((a) => !a.passed) ? 1 : 0;
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ exitCode: report.exitCode, assertions: report.assertions, launch: report.launch, fatal: report.fatal ?? null }, null, 1));
process.exitCode = report.exitCode;
