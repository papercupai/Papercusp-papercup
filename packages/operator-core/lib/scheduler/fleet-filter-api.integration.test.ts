import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const claimSource = 'packages/operator-core/lib/scheduler/get-next.ts';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

// Reuse the maintained request-only profile: its PG, registry, identity, sidecar
// and disabled background owners are private. No shared API or agent is touched.
const journey = String.raw`
import assert from 'node:assert/strict';
import { appendFileSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import postgres from 'postgres';
const dir = process.env.FLEET_FILTER_PROOF_DIR;
const ws = process.env.PAPERCUSP_WORKSPACE_ID;
const base = process.env.PAPERCUSP_OPERATOR_URL;
assert.match(ws, /^test-runtime-/);
assert.notEqual(new URL(process.env.HARNESS_ADMIN_DATABASE_URL).port, '5432');
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
const leader = 'su-fleet-filter-leader-' + randomUUID();
const member = 'su-fleet-filter-member-' + randomUUID();
const solo = 'su-fleet-filter-solo-' + randomUUID();
writeFileSync(join(process.env.PAPERCUSP_HOME, 'superuser-token'), randomBytes(32).toString('hex'), { mode: 0o600 });
const log = openSync(join(dir, 'host.log'), 'a');
let host;
const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
const receipts = [];
function verifyMiss(result) {
  assert.equal(result.ok, false);
  assert.equal(result.workItem ?? null, null);
  assert.equal(result.possiblyClaimed ?? false, false, 'Timeout is not a verified miss');
  // Claim correctness is independent of the issue-only miss diagnosis. The
  // feature-family false authoring alert is tracked separately as
  // EI-24905216534076710; preserve its exact reason in the proof receipts.
  if (result.reason === 'all_matches_gated') {
    assert.match(result.error, /POOL BLOCKED, NOT SPEC-BROKEN/);
  } else if (result.reason !== 'spec_exhausted' && result.reason !== 'spec_matches_nothing') {
    assert.match(result.error, /no claimable work-item matched/);
  }
}
function call(owner, name, args, refusal = false) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['apps/operator/scripts/ptool.mjs', name,
      '--url=' + base, '--workspace=' + ws, '--harness=' + ws, '--json', '-'], {
      env: { ...process.env, PAPERCUSP_SID: owner, PAPERCUSP_HARNESS_SLUG: ws },
      timeout: 45000, maxBuffer: 2000000,
    }, (error, out, err) => {
      const receipt = { name, args, code: error?.code ?? 0, durationMs: performance.now() - start, out, err };
      appendFileSync(join(dir, 'requests.jsonl'), JSON.stringify(receipt) + '\n');
      try {
        assert.equal(receipt.code, refusal ? 5 : 0, err.slice(-1500));
        const result = JSON.parse(out);
        if (name === 'coord:whoami') {
          assert.equal(result.ownerId, owner); assert.equal(result.workspaceId, ws);
        } else {
          assert.equal(result.ok, !refusal, out.slice(-1500));
          if (refusal) verifyMiss(result);
        }
        resolve({ result, durationMs: receipt.durationMs });
      } catch (error) { reject(new Error(name + ': ' + error + ' ' + out.slice(-1500))); }
    });
    child.stdin.end(JSON.stringify(args));
  });
}
const claims = () => sql.unsafe('SELECT feature_id,taken_by FROM harness_shared.work_items WHERE workspace_id=$1 AND taken_by IS NOT NULL', [ws]);
const settle = id => sql.unsafe('UPDATE harness_shared.work_items SET status=$3,taken_by=NULL,taken_at=NULL WHERE workspace_id=$1 AND feature_id=$2', [ws,id,'done']);
const seed = (id, kind, title, order) => sql.unsafe('INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,status,origin,title,created_ts,updated_ts,feature_order) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$7,$8)', [ws,id,kind,'open','local',title,Date.now(),order]);
const spec = (id, filter, priority) => ({ specVersion:'1.0',specId:id,revision:6,
  view:{filter},rank:{mode:'lexicographic',terms:priority
    ? [{expr:'priority',dir:'desc'},{expr:'age',dir:'asc'}] : [{expr:'age',dir:'asc'}]},
  limits:{maxConcurrentClaims:1},states:['open'] });
const strictFilter = {all:[{field:'kind',op:'in',value:['feature']},
  {not:{field:'title',op:'word',value:'p2p'}}]};
try {
  // Both prior harness failure classes are checked before booting a host:
  // tool-specific refusal envelopes and object-valued JSONB fixture writes.
  verifyMiss({ok:false,error:'SPEC EXHAUSTED',reason:'spec_exhausted'});
  verifyMiss({ok:false,error:'SPEC MATCHES NOTHING',reason:'spec_matches_nothing'});
  verifyMiss({ok:false,error:'POOL BLOCKED, NOT SPEC-BROKEN (expected held feature)',reason:'all_matches_gated'});
  verifyMiss({ok:false,error:'no claimable work-item matched'});
  assert.throws(()=>verifyMiss({ok:false,error:'timeout',possiblyClaimed:true}));
  const holdStatement = "UPDATE harness_shared.work_items SET payload=jsonb_build_object('_claimHold',true) WHERE workspace_id=$1 AND feature_id=$2";
  const [holdControl] = await sql.unsafe("SELECT jsonb_typeof(jsonb_build_object('_claimHold',true)) AS kind, jsonb_build_object('_claimHold',true)->>'_claimHold' AS held");
  assert.equal(holdControl.kind,'object'); assert.equal(holdControl.held,'true');
  await sql.unsafe('EXPLAIN ' + holdStatement,[ws,'F-FILTER-FLOORED']);
  await sql.unsafe('EXPLAIN UPDATE harness_shared.work_items SET status=$3,taken_by=NULL,taken_at=NULL WHERE workspace_id=$1 AND feature_id=$2',[ws,'F-FILTER-INSIDE','done']);
  await sql.unsafe('EXPLAIN SELECT feature_id,taken_by FROM harness_shared.work_items WHERE workspace_id=$1 AND taken_by IS NOT NULL',[ws]);
  await sql.unsafe('EXPLAIN INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,status,origin,title,created_ts,updated_ts,feature_order) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$7,$8)',[ws,'F-FILTER-INSIDE','feature','open','local','Admitted feature',Date.now(),100]);
  host = spawn(process.execPath, [join(dir, 'hono-host.mjs')], {env:process.env,stdio:['ignore',log,log]});
  let health;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, 'Private host exited before readiness');
    try {
      const response = await fetch(base + '/api/health', {signal:AbortSignal.timeout(2000)});
      if (response.ok) { health = await response.json(); break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(health, 'Private host never served its liveness route');
  const readinessResponse = await fetch(base + '/api/health/ready', {signal:AbortSignal.timeout(5000)});
  const readiness = await readinessResponse.json();
  assert.equal(readinessResponse.status, 200, 'Private Hono host readiness route did not return 200');
  assert.equal(readiness.ready, true);
  await call(leader,'coord:whoami',{});
  const created = await call(leader,'fleet:create',{name:'private-filter-fleet'});
  const fleet = created.result.fleet?.slug ?? created.result.slug;
  assert.equal(fleet,'private-filter-fleet');
  // Seed an admitted feature before authoring the standing fleet spec, avoiding
  // the write-time empty-pool guard without overriding it.
  await seed('F-FILTER-INSIDE','feature','Admitted feature',100);
  await seed('WI-FILTER-OUTSIDE','change','Adjacent change',1);
  await seed('F-FILTER-P2P','feature','p2p excluded feature',0);
  // A nonterminal feature keeps an empty claimable lane distinct from terminal
  // exhaustion. Its ordinary claim hold must survive every pull unchanged.
  await seed('F-FILTER-FLOORED','feature','Nonterminal held feature',100);
  await sql.unsafe(holdStatement,[ws,'F-FILTER-FLOORED']);
  const [heldControl] = await sql.unsafe('SELECT jsonb_typeof(payload) AS kind,payload FROM harness_shared.work_items WHERE workspace_id=$1 AND feature_id=$2',[ws,'F-FILTER-FLOORED']);
  assert.equal(heldControl.kind,'object'); assert.equal(heldControl.payload._claimHold,true);
  await call(leader,'scheduler:set_claim_spec',{fleet,harness:ws,spec:spec('strict-feature-fleet',strictFilter,false)});
  await call(member,'fleet:join',{fleet,as:'member'});
  const inherited = await call(member,'scheduler:get_claim_spec',{cupId:member});
  assert.equal(inherited.result.source,'fleet');
  assert.equal(inherited.result.fleetSlug,fleet);
  const positive = await call(member,'scheduler:get_next',{harness:ws});
  assert.equal(positive.result.claimReceipt?.committed,true);
  assert.equal(positive.result.workItem?.id,'F-FILTER-INSIDE');
  assert.deepEqual((await claims()).map(row=>({...row})),[{feature_id:'F-FILTER-INSIDE',taken_by:member}]);
  receipts.push({phase:'feature-pickup',durationMs:positive.durationMs,receipt:positive.result.claimReceipt});
  await settle('F-FILTER-INSIDE');
  for (const priority of [false,true]) {
    if (priority) {
      // The admitted row is only needed for the spec write, then settled before
      // pulling. This leaves the higher-priority CHANGE and excluded P2P row.
      await seed('F-FILTER-SPEC-WRITE','feature','Admitted write-time control',100);
      await call(leader,'scheduler:set_claim_spec',{fleet,harness:ws,spec:spec('strict-feature-fleet',strictFilter,true)});
      await settle('F-FILTER-SPEC-WRITE');
    }
    const miss = await call(member,'scheduler:get_next',{harness:ws},true);
    assert.equal((await claims()).length,0,'A strict fleet miss must never claim adjacent work');
    const [outside] = await sql.unsafe('SELECT taken_by,updated_ts,payload FROM harness_shared.work_items WHERE workspace_id=$1 AND feature_id=$2',[ws,'WI-FILTER-OUTSIDE']);
    assert.equal(outside.taken_by,null);
    assert.equal(outside.payload?.claim_history_post_id,undefined,'Post-claim rejection is too late');
    receipts.push({phase:'strict-miss',priority,durationMs:miss.durationMs,noClaims:true,
      noClaimHistory:true,diagnosticReason:miss.result.reason ?? null});
  }
  const mixedFilter = {all:[{any:[{field:'kind',op:'=',value:'feature'},
    {field:'id',op:'=',value:'WI-FILTER-OUTSIDE'}]},
    {not:{field:'title',op:'word',value:'p2p'}}]};
  await call(leader,'scheduler:set_claim_spec',{fleet,harness:ws,spec:spec('mixed-family-fleet',mixedFilter,true)});
  const mixed = await call(member,'scheduler:get_next',{harness:ws});
  assert.equal(mixed.result.workItem?.id,'WI-FILTER-OUTSIDE');
  assert.equal(mixed.result.claimReceipt?.committed,true);
  assert.deepEqual((await claims()).map(row=>({...row})),[{feature_id:'WI-FILTER-OUTSIDE',taken_by:member}]);
  receipts.push({phase:'mixed-issue-pickup',durationMs:mixed.durationMs,receipt:mixed.result.claimReceipt});
  await settle('WI-FILTER-OUTSIDE');
  await seed('WI-FILTER-SOLO','change','Solo default fallback',1);
  const soloClaim = await call(solo,'scheduler:get_next',{harness:ws});
  assert.equal(soloClaim.result.workItem?.id,'WI-FILTER-SOLO');
  assert.equal(soloClaim.result.claimReceipt?.committed,true);
  assert.deepEqual((await claims()).map(row=>({...row})),[{feature_id:'WI-FILTER-SOLO',taken_by:solo}]);
  receipts.push({phase:'solo-issue-pickup',durationMs:soloClaim.durationMs,receipt:soloClaim.result.claimReceipt});
  const proof = {health,readiness,workspace:ws,privateDatabase:true,receipts};
  writeFileSync(join(dir,'proof.json'),JSON.stringify(proof,null,2));
  console.log('FLEET_FILTER_API_PROOF=' + JSON.stringify(proof));
} finally {
  await sql.end({timeout:3});
  if (host) {
    host.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>host.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);
    if(host.exitCode===null)host.kill('SIGKILL');
  }
}
`;

describe('WI-10002617: named fleet filtering through the private operator API', () => {
  it('filters before claiming and preserves admitted feature, mixed issue and solo pickup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-fleet-filter-api-'));
    try {
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
      const before = hash(join(root, claimSource));
      // The host bundle's restricted-hold gate must use the same test-only
      // census seam as the isolated runtime. Without this explicit empty
      // census, the bundle subprocess probes the protected global org-admin
      // database before the private PostgreSQL fixture starts.
      const censusPath = join(dir, 'restricted-hold-census.json');
      writeFileSync(censusPath, '[]\n');
      const build = spawnSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'),
        'bin/hono-host.ts', join(dir, 'hono-host.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: censusPath },
      });
      const buildEvidence = {
        status: build.status,
        signal: build.signal,
        error: build.error ? {
          name: build.error.name,
          code: (build.error as NodeJS.ErrnoException).code ?? null,
          message: build.error.message,
        } : null,
        stdoutTail: (build.stdout ?? '').slice(-8000),
        stderrTail: (build.stderr ?? '').slice(-8000),
      };
      writeFileSync(join(dir, 'build.log'), JSON.stringify(buildEvidence, null, 2));
      expect(build.status, 'Private bundle failed; evidence: ' + dir + '\n' + JSON.stringify(buildEvidence, null, 2)).toBe(0);
      expect(hash(join(root, claimSource)), 'Claim source changed during bundle build').toBe(before);
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '--input-type=module', '-e', journey], {
        cwd: root, encoding: 'utf8', timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, FLEET_FILTER_PROOF_DIR: dir },
      });
      const journeyOutput = (result.stdout ?? '') + (result.stderr ?? '');
      writeFileSync(join(dir, 'journey.log'), journeyOutput);
      expect(result.status, 'Private API proof failed; evidence: ' + dir + '\n' + result.stderr?.slice(-2000)).toBe(0);
      const poolBudgetMatch = journeyOutput.match(/\[with-test-pg\] private pool budget (\{[^\n]+\})/);
      expect(poolBudgetMatch, 'Isolated Hono journey did not report its private PG budget').not.toBeNull();
      const poolBudget = JSON.parse(poolBudgetMatch![1]);
      expect(poolBudget).toMatchObject({ maxConnections: 100, superuserReserved: 3, expectedProcesses: 3, poolMax: 4 });
      const hostOutput = readFileSync(join(dir, 'host.log'), 'utf8');
      const admissionRefusals = (journeyOutput + '\n' + hostOutput).match(
        /sorry, too many clients already|remaining connection slots are reserved/gi,
      ) ?? [];
      expect(admissionRefusals, 'Private PostgreSQL refused an Hono connection').toHaveLength(0);
      expect(hash(join(root, claimSource)), 'Claim source changed during API proof').toBe(before);
      const proof = JSON.parse(readFileSync(join(dir, 'proof.json'), 'utf8'));
      expect(proof.receipts.map((row: { phase: string }) => row.phase)).toEqual([
        'feature-pickup', 'strict-miss', 'strict-miss', 'mixed-issue-pickup', 'solo-issue-pickup',
      ]);
      console.log('FLEET_FILTER_API_EVIDENCE=' + JSON.stringify({
        dir, claimSourceSha256: before, bundleSha256: hash(join(dir, 'hono-host.mjs')),
        poolBudget, postgresAdmissionRefusals: admissionRefusals.length, ...proof,
      }));
    } finally {
      // Keep failed/successful receipts available for diagnosing the expensive
      // journey. The maintained runner disposes all private runtime processes.
      rmSync(join(dir, 'node_modules'), { force: true });
    }
  }, 560_000);
});
