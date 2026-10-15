/** Real native create/read/reload and signed governance, registered in the surface suite. */
// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,PAPERCUSP_TEST_RUN_WORKSPACE
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';
import { insertHiveIfAbsent } from '../packages/operator-core/lib/hive-store.ts';
import { loadHarnessRegistry, saveHarnessRegistry } from '../packages/operator-core/lib/harness-registry.ts';
import { upsertHiveMember } from '../packages/operator-core/lib/hive-membership-store.ts';
import { resolveFederatedPotScope } from '../packages/operator-core/lib/federated-pot-scope.ts';
import { createDeviceAttestationBody } from '../packages/operator-core/lib/identity/attest.ts';
import { authorHivePolicy } from '../packages/operator-core/lib/hive-policy-author.ts';
import { DEFAULT_PLAN_ADMISSION_POLICY } from '../packages/operator-core/lib/agent-tools/plans/plan-admission-policy.ts';
import { readPlanAdmissionGovernanceSnapshot } from '../packages/operator-core/lib/agent-tools/plans/plan-admission-governance-store.ts';
import { getPlanRow } from '../packages/operator-core/lib/agent-tools/plans/source.ts';
import { readNativeHostHealth } from './fixtures/dao-workbench-identity.mjs';
import { WORKBENCH_FIELD_SELECTOR, workbenchTextField, openWorkbenchSelect, chooseWorkbenchOption, reviewWorkbenchProposal } from './lib/dao-workbench-controls.mts';
import { DAO_SECTIONS } from '../apps/operator-vite/src/components/dao/dao-navigation.ts';

async function main() {
if (process.argv.includes('--check-imports')) {
  assert.equal(typeof authorHivePolicy, 'function'); assert.equal(typeof getPlanRow, 'function');
  console.log('DAO_WORKBENCH_IMPORTS_OK'); process.exit(0);
}
const viewportOnly = process.argv.includes('--viewport-only');
if (process.argv.includes('--e2e')) {
  const { runNativeE2e } = await import('./tauri-surface-verify-reports.mts');
  await runNativeE2e([
    'packages/operator-core/lib/dao-workbench-native.e2e.test.ts',
    ...(!viewportOnly ? ['packages/operator-core/lib/dao-workbench-native-signature.integration.test.ts'] : []),
  ], { runtimeUnit: viewportOnly ? 'dao-workbench-native-narrow' : 'dao-workbench-native-desktop',
    nativeScripts: ['scripts/tauri-surface-verify-dao-workbench.mts'] });
  process.exit(0);
}
const harnessName = viewportOnly ? 'dao-workbench-viewport-tauri' : 'dao-workbench-tauri';
console.log('DAO_NATIVE_READY at=' + new Date().toISOString());
const selection = parseSelectionArgs(process.argv.slice(2).filter(arg => arg !== '--viewport-only'));
const result = await runHarness({ contract: { name: harnessName, phases: [{ id: 'native',
  description: 'Product switch, persisted proposal, real signed member decision and responsive workspaces' }] },
  evidenceRoot: defaultEvidenceRoot(harnessName), selection, reuseFrom: selection.reuse,
  async runPhase(ctx) {
    assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1');
    const pg = resolveScriptPgUrl();
    assert.ok(pg.source === 'env' && 'via' in pg && pg.via === 'HARNESS_ADMIN_DATABASE_URL');
    const ws = process.env.PAPERCUSP_WORKSPACE_ID!;
    assert.match(ws, /^verify-tauri-isolated-\d+$/);
    const sql = postgres(pg.url, { max: 1, onnotice: () => {} });
    const fixture = JSON.parse(readFileSync(process.env.DAO_WORKBENCH_IDENTITY_FIXTURE!, 'utf8'));
    const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools';
    const native = (...args: string[]) => {
      const started = Date.now();
      console.log(`DAO_NATIVE_OPERATION command=${args[0]} status=start at=${new Date(started).toISOString()}`);
      try {
        return execFileSync(tool, [...args, '--pid', process.env.VERIFY_TAURI_PID!], { encoding: 'utf8', timeout: 65_000 });
      } finally { console.log(`DAO_NATIVE_OPERATION command=${args[0]} status=end elapsedMs=${Date.now() - started}`); }
    };
    const ev = (code: string) => native('eval', code);
    const wait = (code: string) => native('wait', '--eval', code, '--timeout', '60000', '--interval', '500');
    const click = (text: string, scope = 'document') => ev(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button '+${JSON.stringify(text)});b.click();return true})()`);
    const field = (label: string, value: string) => ev(workbenchTextField(label, value));
    const selectProposal = (title: string) => {
      ev(openWorkbenchSelect('Review proposal'));
      wait(`!![...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.trim()===${JSON.stringify(title)})`);
      ev(chooseWorkbenchOption(title));
    };
    const capture = (name: string) => {
      writeFileSync(join(ctx.evidenceDir, name + '.json'), ev('JSON.stringify({url:location.href,text:document.body.innerText})'));
      native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', join(ctx.evidenceDir, name + '.png'));
    };
    const workControlLayout = () => {
      const controls = JSON.parse(ev(`JSON.stringify([...document.querySelectorAll('.dao-execution label')].map(label=>{
        const field=label.querySelector(${JSON.stringify(WORKBENCH_FIELD_SELECTOR)});
        if(!field)throw Error('Missing layout control '+label.textContent.trim());
        const range=document.createRange();range.selectNodeContents(label.firstChild);
        const title=range.getBoundingClientRect(),box=field.getBoundingClientRect(),container=label.getBoundingClientRect();
        return {name:label.firstChild.textContent.trim(),titleBottom:title.bottom,fieldTop:box.top,
          fieldLeft:box.left,fieldRight:box.right,fieldWidth:box.width,left:container.left,right:container.right,width:container.width};
      }))`));
      assert.deepEqual(controls.map((control: { name: string }) => control.name), ['Project scope', 'Find work', 'Work title', 'Work brief']);
      for (const control of controls) {
        assert.ok(control.fieldTop >= control.titleBottom + 3, control.name + ' label must sit above its field');
        assert.ok(control.fieldLeft >= control.left - 1 && control.fieldRight <= control.right + 1, control.name + ' field must fit its container');
        assert.ok(control.fieldWidth >= Math.min(240, control.width * .75), control.name + ' field must remain usable');
      }
      return controls;
    };
    const linkedPlanLayout = () => {
      const plans = JSON.parse(ev("JSON.stringify([...document.querySelectorAll('.dao-execution article li')].map(row=>{const link=row.querySelector('a'),status=row.querySelector('small');return {title:link.textContent,status:status.textContent,titleBottom:link.getBoundingClientRect().bottom,statusTop:status.getBoundingClientRect().top};}))"));
      assert.ok(plans.length > 0, 'Persisted proposal must appear in linked plans');
      for (const plan of plans) {
        assert.ok(plan.statusTop >= plan.titleBottom + 3, plan.title + ' plan status must sit below its title');
      }
      return plans;
    };
    try {
      ctx.markStep('frozen-host-source-identity');
      const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
      const { origin, health } = await readNativeHostHealth();
      writeFileSync(join(ctx.evidenceDir, 'host-source-identity.json'), JSON.stringify({ sourceCommit: receipt.sourceCommit, origin, health }, null, 2));
      assert.equal(health.sha, receipt.sourceCommit.slice(0, 12), 'Frozen host must report the validated archive commit');
      ctx.markStep('native-capture-preflight');
      capture('capture-preflight');
      ctx.markStep('isolated-owner-policy-and-member-fixture');
      const slug = 'workbench-native';
      const home = join(process.env.PAPERCUSP_HOME!, slug); mkdirSync(home, { recursive: true });
      await insertHiveIfAbsent({ workspaceId: ws, homeSlug: slug, pubkeyBase64: fixture.hive.publicKey,
        keychainId: 'hive:' + ws + ':' + slug, title: 'Native Workbench DAO', description: 'Isolated native acceptance' }, sql);
      const registry = await loadHarnessRegistry(ws);
      await saveHarnessRegistry({ ...registry, projects: [...registry.projects, { slug, path: home, harness_kind: 'hive' }] }, ws);
      const attestation = await createDeviceAttestationBody({ keychainId: fixture.keychainId,
        pubkeyBase64: fixture.device.publicKey, deviceLabel: 'Isolated native fixture',
        githubUserId: fixture.githubUserId, githubLogin: fixture.githubLogin });
      await upsertHiveMember({ workspaceId: ws, potHomeSlug: await resolveFederatedPotScope(ws, slug, { sql }), githubUserId: fixture.githubUserId,
        githubUsername: fixture.githubLogin, bindingStatus: 'verified', deviceAttestations: [{
          device_pubkey: attestation.device_pubkey, gist_id: 'synthetic-native-gist',
          gist_url: 'https://gist.github.com/' + fixture.githubLogin + '/synthetic-native-gist',
          device_label: attestation.device_label, created_at: attestation.created_at,
          signature_by_device: attestation.signature_by_device,
        }] }, sql);
      const policy = await authorHivePolicy({ workspaceId: ws, potHomeSlug: slug, policy: { membership: 'open', governance: {
        planAdmission: DEFAULT_PLAN_ADMISSION_POLICY, signingAuthority: { members: [{ memberId: fixture.githubLogin,
          publicKey: fixture.device.publicKey, originPeerIds: [fixture.device.publicKey], keyEpoch: 1,
          roles: ['round-open', 'vote', 'finalize'], weight: 1 }], delegations: [] } } } });
      assert.equal(policy.ok, true, 'Synthetic owner could not author a real signed policy');
      ctx.markStep('top-level-product-switch-and-directory');
      native('navigate', '/daos', '--json'); wait("!!document.querySelector('[data-testid=dao-workspace]')");
      wait("!document.body.classList.contains('has-left-sidebar') && !document.body.classList.contains('has-op-chat')");
      click('Refresh'); wait("[...document.querySelectorAll('.dao-card h2')].some(e=>e.textContent==='Native Workbench DAO')");
      click('Open workspace →'); wait("document.querySelector('.dao-page-header h1')?.textContent==='Overview'");
      click('Proposals'); wait("!!document.querySelector('.dao-governance')");
      let proposalHash: string | undefined;
      let authenticatedEventKinds: string[] = [];
      if (!viewportOnly) {
      ctx.markStep('create-real-proposal-through-native-form');
      ev("(()=>{const original=window.fetch;window.__WORKBENCH_PROPOSAL_RESPONSE__=null;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/api/admin/plans/new'))window.__WORKBENCH_PROPOSAL_RESPONSE__={request:args[1]?.body,status:response.status,body:await response.clone().text()};return response};return true})()");
      ev("document.querySelector('.dao-governance details').open=true");
      field('Proposal title', 'Native proposal'); field('Purpose & scope', 'Produce an isolated native record');
      field('How members will verify success', 'Native record persists and its signed decision reloads');
      click('Save draft proposal'); wait("document.querySelector('.dao-governance')?.innerText.includes('Proposal saved as a draft')");
      writeFileSync(join(ctx.evidenceDir, 'proposal-response.json'), ev('JSON.stringify(window.__WORKBENCH_PROPOSAL_RESPONSE__)'));
      const proposalSlug = ev('JSON.parse(window.__WORKBENCH_PROPOSAL_RESPONSE__.body).slug').trim().replace(/^"|"$/g, '');
      assert.match(proposalSlug, /^native-proposal-\d{4}-\d{2}-\d{2}$/, 'Creation receipt must contain the canonical dated plan slug');
      const persistedScopes = await sql`SELECT workspace_id, harness_slug, plan_slug, title FROM harness_shared.harness_plans WHERE plan_slug = ${proposalSlug}`;
      writeFileSync(join(ctx.evidenceDir, 'proposal-scopes.json'), JSON.stringify(persistedScopes, null, 2));
      const row = await getPlanRow(proposalSlug, { workspaceId: ws, harnessSlug: slug });
      assert.ok(row, 'Native draft did not persist');
      assert.equal(row.title, 'Native proposal');
      selectProposal('Native proposal · ' + slug); wait("document.querySelector('.dao-governance')?.innerText.includes('Deciding as native-workbench-member')");
      assert.equal(ev("String([...document.querySelectorAll('.dao-governance button')].find(e=>e.textContent==='Open voting round').disabled)").trim().replace(/^"|"$/g, ''), 'true');
      ev(reviewWorkbenchProposal());
      wait("document.querySelector('.dao-governance [role=checkbox]')?.getAttribute('aria-checked')==='true'");
      ctx.markStep('real-device-signatures-and-policy-verification');
      click('Open voting round'); wait("document.querySelector('.dao-governance')?.innerText.includes('Voting round opened.')");
      click('Approve'); wait("document.querySelector('.dao-governance')?.innerText.includes('Your approve vote was recorded.')");
      click('Finalize result'); wait("document.querySelector('.dao-governance')?.innerText.includes('Plan admission approved')");
      const snapshot = await readPlanAdmissionGovernanceSnapshot({ workspaceId: ws, potHomeSlug: slug });
      assert.deepEqual(snapshot.integrityErrors, []);
      assert.deepEqual(snapshot.events.map(e => e.body.kind).sort(), ['finalize', 'round-open', 'vote']);
      assert.equal(snapshot.events.find(e => e.body.kind === 'finalize')?.body.kind, 'finalize');
      proposalHash = row.contentHash;
      authenticatedEventKinds = snapshot.events.map(e => e.body.kind);
      capture('signed-decision');
      ctx.markStep('reload-and-independent-product-selections');
      ev('location.reload()'); wait("!!document.querySelector('.dao-governance')");
      selectProposal('Native proposal · ' + slug); wait("document.querySelector('.dao-governance')?.innerText.includes('Plan admission approved')");
      ev("document.querySelector('a[aria-label=Ops]').click()"); wait("!location.pathname.startsWith('/daos')");
      ev("document.querySelector('a[aria-label=\"DAO Management\"]').click()");
      wait("location.pathname==='/daos' && new URLSearchParams(location.search).get('dao')==='workbench-native' && !!document.querySelector('.dao-governance')");
      }
      ctx.markStep('nineteen-sections-and-responsive-layout');
      const sections = DAO_SECTIONS.map(({ id, label }) => [id, label]);
      assert.deepEqual(sections.map(([id]) => id), [
        'directory', 'overview', 'join', 'members', 'proposals', 'vote', 'delegation', 'work',
        'jobs', 'treasury', 'funding', 'billing', 'ownership', 'returns', 'reputation',
        'marketplace', 'records', 'settings', 'inbox',
      ], 'Native acceptance must cover every required Workbench area');
      for (const [id, heading] of sections) {
        ctx.markStep('section-' + id);
        console.log(`DAO_NATIVE_SECTION id=${id} at=${new Date().toISOString()}`);
        ev(`window.__TSR_ROUTER__.navigate({to:'/daos',search:{dao:${JSON.stringify(slug)},daoSection:${JSON.stringify(id)}}})`);
        wait(`new URLSearchParams(location.search).get('daoSection')===${JSON.stringify(id)} && document.querySelector('.dao-page-header h1')?.textContent===${JSON.stringify(heading)}`);
        if (id === 'work') {
          writeFileSync(join(ctx.evidenceDir, 'work-control-layout.json'), JSON.stringify(workControlLayout(), null, 2));
          // Prove the detector catches the original unformatted controls.
          ev("window.__DAO_FORMATTED_FORMS__=[...document.querySelectorAll('.dao-execution .dao-form')];window.__DAO_FORMATTED_FORMS__.forEach(form=>form.classList.remove('dao-form'));true");
          try { assert.throws(workControlLayout, /label must sit above its field/); }
          finally { ev("window.__DAO_FORMATTED_FORMS__.forEach(form=>form.classList.add('dao-form'));delete window.__DAO_FORMATTED_FORMS__;true"); }
          workControlLayout();
          if (!viewportOnly) {
            writeFileSync(join(ctx.evidenceDir, 'work-linked-plan-layout.json'), JSON.stringify(linkedPlanLayout(), null, 2));
            ev("window.__DAO_FORMATTED_PLAN_LISTS__=[...document.querySelectorAll('.dao-execution .dao-plan-list')];window.__DAO_FORMATTED_PLAN_LISTS__.forEach(list=>list.classList.remove('dao-plan-list'));true");
            try { assert.throws(linkedPlanLayout, /plan status must sit below its title/); }
            finally { ev("window.__DAO_FORMATTED_PLAN_LISTS__.forEach(list=>list.classList.add('dao-plan-list'));delete window.__DAO_FORMATTED_PLAN_LISTS__;true"); }
            linkedPlanLayout();
          }
        }
        capture('section-' + id);
      }
      const expectedWidth = Number(process.env.DAO_WORKBENCH_VIEWPORT?.split('x')[0]);
      assert.equal(expectedWidth, viewportOnly ? 390 : 1440, 'Native viewport must be selected before boot');
      wait(`Math.abs(innerWidth-${expectedWidth})<=4 && document.documentElement.scrollWidth<=innerWidth+2`);
      capture(viewportOnly ? 'mobile-inbox' : 'desktop-inbox');
      assert.throws(() => native('check', '--selector', '.dao-intentionally-missing', '--json'), 'Missing selector negative control must fail');
      return { ok: true, proposalHash, authenticatedEventKinds, sectionIds: sections.map(([id]) => id), viewportWidth: expectedWidth };
    } catch (error) {
      try { writeFileSync(join(ctx.evidenceDir, 'proposal-response.json'), ev('JSON.stringify(window.__WORKBENCH_PROPOSAL_RESPONSE__ ?? null)')); } catch {}
      try {
        const scopes = await sql`SELECT workspace_id, harness_slug, plan_slug, title FROM harness_shared.harness_plans WHERE title = 'Native proposal' OR plan_slug LIKE 'native-proposal%' OR plan_slug LIKE 'proposal%'`;
        writeFileSync(join(ctx.evidenceDir, 'proposal-scopes.json'), JSON.stringify(scopes, null, 2));
      } catch {}
      try { capture('failure'); } catch {}
      throw error;
    }
    finally { await sql.end(); }
  },
});
console.log(`P019_TAURI_SURFACE_VERIFY_${result.verdict === 'pass' ? 'OK' : 'FAIL'} leg=dao-workbench output=${result.evidenceDir}`);
process.exitCode = result.verdict === 'pass' ? 0 : 1;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
