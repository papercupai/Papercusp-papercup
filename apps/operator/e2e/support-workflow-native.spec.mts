import { test, expect, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeNativeBridgeJson } from './_native-bridge-json';
import type { SupportWorkflowNativeFixture, SupportWorkflowReviewerAccess, SupportWorkflowAccessSelection } from './_support-workflow-native-fixture';

// P-012c, D-028/D-031/D-050. Run through verify-tauri-headless.sh with
// VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready. This spec uses
// the owned native webview, never a Playwright browser or mocked API responses.
// The shared P-012b fixture supplies input and distinct cookie-authenticated
// actors, never an execution/completion receipt or business acceptance.
type Verdict = { step: string; status: 'PASS' | 'FAIL' | 'ABSENT'; detail: string; source: string };
const run = promisify(execFile);
const form = 'section[aria-label="Prepare support handoff"]';
const receipt = 'section[aria-label="Operation result"]';
type Actor = keyof SupportWorkflowNativeFixture['actors'];
type NativeFixture = SupportWorkflowAccessSelection & Pick<SupportWorkflowNativeFixture,
  'workspaceId' | 'harnessSlug' | 'operationId' | 'supportCaseId' | 'query' | 'documentTitle' |
  'documentId' | 'approvedRevision' | 'candidateRevision'> & {
    actors: Record<Actor, { id: string }>;
    loginScripts: Record<Actor, string>;
  };

async function retain(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}

async function native(command: string, ...args: string[]) {
  const pid = process.env.VERIFY_TAURI_PID!;
  const executable = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(executable, 'The owned verifier must supply the bridge executable').toBeTruthy();
  await run('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 10_000 });
  const result = await run(executable, [command, '--pid', pid,
    ...(command === 'eval' ? ['--json'] : []), ...args], { timeout: 20_000 });
  return decodeNativeBridgeJson(result.stdout, command);
}
const measure = (expression: string) => native('eval', expression);
async function check(expression: string) {
  await expect.poll(() => measure(expression), { timeout: 45_000, intervals: [500, 1500] }).toBe(true);
  await native('check', '--eval', expression, '--json');
}
async function navigate(params: Record<string, string> = {}) {
  const url = new URL('/adv', process.env.VERIFY_TAURI_DEV_URL!);
  url.search = new URLSearchParams({ tab: 'enterprise', welcome: '0',
    ws: process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE!, ...params }).toString();
  await native('navigate', url.toString(), '--json');
  await check('new URL(location.href).searchParams.get("tab")==="enterprise" && !!document.querySelector("section[aria-label=\"Enterprise workspace\"]") && document.querySelector(".pc-wf__title")?.textContent==="Enterprise"');
}

async function fixtureProcess(seed: boolean, permissions?: {
  selection: SupportWorkflowAccessSelection; access: SupportWorkflowReviewerAccess;
}): Promise<NativeFixture | { seed: string; login: string } | { access: string; allowed: boolean; documentIds: string[]; reason: string | null }> {
  // Reuse the native fixture route used by plan-cleanup-review-native: the
  // production graph needs tsx's Node resolution, not Playwright transforms.
  const sourceRoot = process.env.OPERATOR_SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));
  const result = await run(process.execPath, ['--import', resolve(sourceRoot, 'scripts/lib/committed-source-loader.mjs'),
    '--import', 'tsx', '--input-type=module', '-e', `
      const { seedSupportWorkflowNativeFixture: seed, supportWorkflowNativeLoginScript: login,
        setSupportWorkflowNativeReviewerAccess: setAccess } =
        await import('./apps/operator/e2e/_support-workflow-native-fixture.ts');
      if (process.env.P012_NATIVE_SEED !== '1' && !process.env.P012_NATIVE_PERMISSIONS) {
        console.log(JSON.stringify({ seed: typeof seed, login: typeof login }));
        process.exit(0);
      }
      const { default: postgres } = await import('postgres');
      const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL, { max: 1, connect_timeout: 5, idle_timeout: 5 });
      try {
        if (process.env.P012_NATIVE_PERMISSIONS) {
          const { selection, access } = JSON.parse(process.env.P012_NATIVE_PERMISSIONS);
          console.log(JSON.stringify(await setAccess(sql, selection, access)));
        } else {
        const f = await seed(sql, { workspaceId: process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE });
        const { workspaceId, harnessSlug, operationId, supportCaseId, query, documentTitle, documentId,
          listId, role, identities, approvedRevision, candidateRevision } = f;
        const actors = Object.fromEntries(Object.entries(f.actors).map(([actor, value]) => [actor, { id: value.id }]));
        const loginScripts = Object.fromEntries(Object.keys(actors).map(actor => [actor, login(f, actor)]));
        console.log(JSON.stringify({ workspaceId, harnessSlug, operationId, supportCaseId, query, documentTitle,
          documentId, listId, role, identities, approvedRevision, candidateRevision, actors, loginScripts }));
        }
      } finally { await sql.end({ timeout: 5 }); }
    `], { cwd: sourceRoot, env: { ...process.env, P012_NATIVE_SEED: seed ? '1' : '0',
      P012_NATIVE_PERMISSIONS: permissions ? JSON.stringify(permissions) : '' },
    timeout: 150_000, maxBuffer: 2 * 1024 * 1024 });
  // Login scripts are ephemeral test secrets: never attach subprocess stdout.
  return JSON.parse(result.stdout.trim());
}

test('support fixture writer loads under the native acceptance Node loader', async () => {
  test.setTimeout(180_000);
  expect(await fixtureProcess(false)).toEqual({ seed: 'function', login: 'function' });
});

async function submitNativeSupport(selection: NativeFixture) {
  await navigate({ wfSelId: `operation:${selection.harnessSlug}:${selection.operationId}` });
  await check(`!!document.querySelector(${JSON.stringify(form)}) && document.querySelector(${JSON.stringify(form)})?.getAttribute('aria-busy') !== 'true'`);
  await measure(`(() => { const s=document.querySelector(${JSON.stringify(form)}); for (const [label,id] of [['Support case reference','p012-case'],['Find case evidence','p012-query']]) { const input=Array.from(s.querySelectorAll('label')).find(l=>l.textContent.includes(label))?.querySelector('input'); if (!input) throw new Error('Missing '+label); input.id=id; } return true; })()`);
  await native('type', '#p012-case', selection.supportCaseId, '--json');
  await native('type', '#p012-query', selection.query, '--json');
  await measure(`(() => { const b=Array.from(document.querySelectorAll(${JSON.stringify(`${form} button`)})).find(b=>b.textContent==='Search allowed sources'); if (!b || b.disabled) throw new Error('Search unavailable'); b.click(); return true; })()`);
  await check(`(() => { const s=document.querySelector(${JSON.stringify(form)}); return s?.getAttribute('aria-busy')==='false' && Array.from(s.querySelectorAll('label')).some(l=>l.textContent.includes(${JSON.stringify(selection.documentTitle)}) && l.querySelector('[role=checkbox]')); })()`);
  await measure(`(() => { const l=Array.from(document.querySelectorAll(${JSON.stringify(`${form} label`)})).find(l=>l.textContent.includes(${JSON.stringify(selection.documentTitle)}) && l.querySelector('[role=checkbox]')); l.querySelector('[role=checkbox]').click(); return true; })()`);
  await check(`Array.from(document.querySelectorAll(${JSON.stringify(`${form} button`)})).some(b=>b.textContent==='Prepare handoff' && !b.disabled)`);
  await measure(`(() => { Array.from(document.querySelectorAll(${JSON.stringify(`${form} button`)})).find(b=>b.textContent==='Prepare handoff').click(); return true; })()`);
  await check(`!!new URL(location.href).searchParams.get('wfRun') && !!document.querySelector(${JSON.stringify(receipt)})`);
  const handle = await measure('JSON.parse(new URL(location.href).searchParams.get("wfRun"))');
  expect(handle).toMatchObject({ workspaceId: selection.workspaceId, harnessSlug: selection.harnessSlug,
    operationId: selection.operationId, specificationRevision: selection.approvedRevision, receiptId: expect.any(Number) });
  expect(handle.receiptId).toBeGreaterThan(0);
  return handle;
}

test.describe('P-012 current-build native acceptance', () => {
  // All cases drive one owned webview/cookie jar. The default project enables
  // fullyParallel, which must not race actor switches across these journeys.
  test.describe.configure({ mode: 'default' });
  test.beforeEach(() => {
    test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the maintained owned Tauri rig');
    expect(process.env.VERIFY_TAURI_ISOLATED_DB, 'Write paths require the throwaway database').toBe('1');
    expect(process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE).toMatch(/^verify-tauri-isolated-/);
  });

  test('accountable owner administers local revisions, funding, stop and revocation through native controls', async ({}, info) => {
    test.setTimeout(360_000);
    const adminPanel = 'section[aria-label="Workflow administration"]';
    const panel = JSON.stringify(adminPanel);
    const selection = await fixtureProcess(true) as NativeFixture;
    const login = async (actor: Actor) => {
      const identity = await measure(selection.loginScripts[actor]).catch(() => {
        throw new Error(`Production cookie identity switch failed for ${actor}`);
      });
      expect(identity).toMatchObject({ actor, userId: selection.actors[actor].id, workspaceId: selection.workspaceId });
      await retain(info, `p012-admin-${actor}-identity`, identity);
    };
    const click = async (text: string) => measure(`(() => { const b=Array.from(document.querySelectorAll(${JSON.stringify(`${adminPanel} button`)})).find(b=>b.textContent===${JSON.stringify(text)}); if (!b || b.disabled) throw new Error('Unavailable admin control'); b.click(); return true; })()`);
    const refresh = async () => { await click('Refresh administration'); await check(`document.querySelector(${panel})?.getAttribute('aria-busy')==='false'`); };
    try {
      expect(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'Admin acceptance requires the exact frozen source receipt').toBeTruthy();
      await retain(info, 'p012-native-admin-source', JSON.parse(await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8')));
      await navigate();
      await login('employee');
      const handle = await submitNativeSupport(selection);
      const selectedUrl = await measure('location.href') as string;
      for (const actor of ['employee', 'reviewer'] as const) {
        await login(actor);
        await native('navigate', selectedUrl + '&wfAdmin=true', '--json');
        await check(`!!document.querySelector(${panel})`);
        await refresh();
        await check(`(() => { const s=document.querySelector(${panel}); return !!s.querySelector('[role=alert]') && !s.textContent.includes('Approved version'); })()`);
      }
      await login('admin');
      await native('navigate', selectedUrl + '&wfAdmin=true', '--json');
      await check(`!!document.querySelector(${panel})`);
      await refresh();
      await check(`(() => { const s=document.querySelector(${panel}); return s.textContent.includes('Approved version 1') && s.textContent.includes(${JSON.stringify(selection.actors.admin.id)}) && s.textContent.includes(${JSON.stringify(selection.actors.reviewer.id)}) && s.textContent.includes('Finite allocation: $1.000000') && s.textContent.includes('Actual model cost: Unknown'); })()`);
      await measure(`(() => { const s=document.querySelector(${panel}); const input=s.querySelector('textarea'); input.id='p012-admin-reason'; return true; })()`);
      await native('type', '#p012-admin-reason', 'Internal native admin acceptance', '--json');
      const choose = async (target: string) => {
        // Drive the maintained Select's real option, rather than replacing its
        // React state or invoking an administrative API from the test.
        await measure(`(() => { const s=document.querySelector(${panel}); const b=s.querySelector('[aria-label="Retained local revision"]'); if (!b) throw new Error('Missing retained revision selector'); b.click(); return true; })()`);
        await check(`Array.from(document.querySelectorAll('[role=option]')).some(o=>o.textContent.includes(${JSON.stringify(target)}))`);
        await measure(`(() => { const o=Array.from(document.querySelectorAll('[role=option]')).find(o=>o.textContent.includes(${JSON.stringify(target)})); o.click(); return true; })()`);
      };
      await choose(selection.candidateRevision);
      await click('Promote revision');
      await check(`document.querySelector(${panel})?.textContent.includes('Approved version 2') && document.querySelector(${panel})?.getAttribute('aria-busy')==='false'`);
      expect(await measure('JSON.parse(new URL(location.href).searchParams.get("wfRun"))')).toEqual(handle);
      await choose(selection.approvedRevision);
      await click('Roll back revision');
      await check(`document.querySelector(${panel})?.textContent.includes('Approved version 1') && document.querySelector(${panel})?.getAttribute('aria-busy')==='false'`);
      await choose(selection.candidateRevision);
      await click('Promote revision');
      await check(`document.querySelector(${panel})?.textContent.includes('Approved version 2') && document.querySelector(${panel})?.getAttribute('aria-busy')==='false'`);
      await choose(selection.approvedRevision);
      await click('Roll back revision');
      await check(`document.querySelector(${panel})?.textContent.includes('Approved version 1') && document.querySelector(${panel})?.getAttribute('aria-busy')==='false'`);
      await click('Stop selected run');
      await check(`document.querySelector(${panel})?.textContent.includes('Cancellation settlement is still pending') && document.querySelector(${panel})?.getAttribute('aria-busy')==='false'`);
      await click('Revoke employee source access');
      await check(`document.querySelector(${panel})?.textContent.includes('revoke request saved') && document.querySelector(${panel})?.getAttribute('aria-busy')==='false'`);
      const history = await measure(`document.querySelector(${panel}).innerText`);
      await native('navigate', selectedUrl + '&wfAdmin=true', '--json');
      await check(`!!document.querySelector(${panel})`);
      await refresh();
      await check(`(() => { const t=document.querySelector(${panel}).textContent; return ['Approved version 1','promote by','rollback by','stop by','revoke by'].every(v=>t.includes(v)); })()`);
      await login('employee');
      await navigate({ wfSelId: `operation:${selection.harnessSlug}:${selection.operationId}` });
      await check(`!!document.querySelector(${JSON.stringify(form)})`);
      // A live source search after revocation must refuse the employee. The
      // exact grant effect is also asserted in the canonical PG regression.
      await measure(`(() => { const s=document.querySelector(${JSON.stringify(form)}); const input=Array.from(s.querySelectorAll('label')).find(l=>l.textContent.includes('Find case evidence'))?.querySelector('input'); input.id='p012-revoked-query'; return true; })()`);
      await native('type', '#p012-revoked-query', selection.query, '--json');
      await measure(`(() => { Array.from(document.querySelectorAll(${JSON.stringify(`${form} button`)})).find(b=>b.textContent==='Search allowed sources').click(); return true; })()`);
      await check(`(() => { const s=document.querySelector(${JSON.stringify(form)}); return s?.getAttribute('aria-busy')==='false' && !!s.querySelector('[role=alert]')?.textContent.includes('Support sources are unavailable or access was refused') && !s.querySelector('[role=checkbox]'); })()`);
      await retain(info, 'p012-native-admin-history', { status: 'PASS', history, handle,
        approvedRevision: selection.approvedRevision, candidateRevision: selection.candidateRevision,
        boundary: 'Administrative controls only; no worker completion, distinct business acceptance or shipment claim' });
    } finally {
      await retain(info, 'p012-native-admin-dom', await measure('({url:location.href,text:document.body.innerText.slice(0,18000)})'));
    }
  });

  test('owned Enterprise workspace and falsifiable missing-control guard', async ({}, info) => {
    test.setTimeout(180_000);
    try {
      await navigate();
      await check('(() => { const s=document.querySelector("section[aria-label=\"Enterprise workspace\"]"); return !!s?.querySelector("[aria-label=\"Enterprise journey\"]") && !!s.querySelector("[aria-label=\"Departmental workflow\"]") && s.querySelectorAll("nav[aria-label=\"Supporting workspace evidence\"] button").length===6 && Array.from(s.querySelectorAll("button")).some(b=>b.textContent?.includes("Manage workflows")); })()');
      // The check command must reject a missing subject. eval/probe success
      // alone cannot establish either a positive or a negative UI assertion.
      const negative = await native('check', '--selector', '#p012-deliberately-absent-control', '--json')
        .then(() => null, error => error as { code?: number; stdout?: string });
      expect(negative?.code).toBe(1);
      await retain(info, 'p012-native-frame', { status: 'PASS',
        url: await measure('location.href'), negativeControl: negative?.stdout,
        sourceReceipt: process.env.VERIFY_TAURI_SOURCE_RECEIPT
          ? JSON.parse(await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'utf8')) : null });
    } finally {
      await retain(info, 'p012-native-frame-dom', await measure('({url:location.href,text:document.body.innerText.slice(0,12000)})'));
    }
  });

  for (const decision of ['accept', 'reject', 'rework'] as const) {
  test(`employee receives actual ready output and distinct reviewer records ${decision} through native controls`, async ({}, info) => {
    test.setTimeout(600_000);
    const matrix: Verdict[] = [
      { step: 'employee-submit', status: 'ABSENT', detail: 'The isolated fixture and employee cookie identity have not been verified',
        source: 'apps/operator-vite/src/components/adv/WorkflowSupportForm.tsx' },
      { step: 'worker-ready-output', status: 'ABSENT',
        detail: 'Requires a real worker completion accepted by the production result gate; fixture completion/model receipts are forbidden',
        source: 'packages/operator-core/lib/blueprint/operation-service.ts' },
      { step: `reviewer-${decision}`, status: 'ABSENT',
        detail: 'Requires an actual distinct-reviewer decision and reload readback; a review checkbox is not an identity switch',
        source: 'apps/operator-vite/src/components/adv/WorkflowOperationResult.tsx' },
      { step: 'reviewer-live-corpus-negative-control', status: 'ABSENT',
        detail: 'Requires allowlisted reviewer denied without live corpus grant/source ACL, then allowed with both actors authorized (D-031)',
        source: 'packages/operator-core/lib/blueprint/support-workflow-case.ts' },
    ];
    try {
      expect(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'Business acceptance requires the exact frozen source receipt').toBeTruthy();
      await retain(info, 'p012-native-business-source', JSON.parse(await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8')));
      await navigate();
      const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE!;
      const adminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
      expect(adminUrl, 'The maintained rig must supply its isolated PostgreSQL connection').toBeTruthy();
      const database = new URL(adminUrl!);
      expect(['localhost', '127.0.0.1']).toContain(database.hostname);
      expect(database.port).not.toBe('5432');
      const selection = await fixtureProcess(true) as NativeFixture;
      expect(selection.workspaceId).toBe(process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE);
      for (const key of ['harnessSlug', 'operationId', 'supportCaseId', 'query', 'documentTitle'] as const) {
        expect(typeof selection[key]).toBe('string');
        expect(selection[key].trim()).not.toBe('');
      }
      // Passwords and cookies stay out of retained evidence. The login helper
      // measures production /login + /me inside this owned webview.
      for (const actor of ['reviewer', 'admin', 'employee'] as const) {
        const identity = await measure(selection.loginScripts[actor]).catch(() => {
          // execFile's default error includes argv, which contains the private
          // fixture password. Retain a secret-free failure at this boundary.
          throw new Error(`Production cookie identity switch failed for ${actor}`);
        });
        expect(identity).toMatchObject({ userId: selection.actors[actor].id, workspaceId, actor });
        await retain(info, `p012-${actor}-identity`, identity);
      }
      await retain(info, 'p012-fixture-selection', { workspaceId, harnessSlug: selection.harnessSlug,
        operationId: selection.operationId, supportCaseId: selection.supportCaseId,
        documentId: selection.documentId, approvedRevision: selection.approvedRevision,
        actors: Object.fromEntries(Object.entries(selection.actors).map(([actor, value]) => [actor, value.id])) });
      matrix[0].status = 'FAIL';
      matrix[0].detail = 'Submitting through native controls; canonical receipt has not passed';
      const handle = await submitNativeSupport(selection);
      matrix[0] = { ...matrix[0], status: 'PASS', detail: 'Native form returned a server-issued revision-pinned operation receipt; business acceptance remains separate' };
      await retain(info, 'p012-employee-receipt', handle);
      const panel = JSON.stringify(receipt);
      const refresh = async () => {
        await check(`!!document.querySelector(${panel}) && document.querySelector(${panel}).getAttribute('aria-busy')==='false'`);
        await measure(`(() => { const b=Array.from(document.querySelectorAll(${JSON.stringify(`${receipt} button`)})).find(b=>b.textContent==='Refresh result'); if (!b || b.disabled) throw new Error('Result refresh unavailable'); b.click(); return true; })()`);
        await check(`document.querySelector(${panel})?.getAttribute('aria-busy')==='false'`);
      };
      const ready = `!!document.querySelector(${JSON.stringify(`${receipt} section[aria-label="Prepared support handoff"]`)}) && document.querySelector(${panel})?.textContent.includes('Prepared result · Evidence')`;
      matrix[1].status = 'FAIL';
      await expect.poll(async () => { await refresh(); return measure(ready); },
        { timeout: 180_000, intervals: [1000, 3000] }).toBe(true);
      await check(ready);
      await check(`document.querySelector(${panel})?.textContent.includes(${JSON.stringify(selection.supportCaseId)}) && document.querySelector(${panel})?.textContent.includes(${JSON.stringify(selection.documentId)}) && document.querySelector(${panel})?.textContent.includes('Business outcome: pending')`);
      matrix[1] = { ...matrix[1], status: 'PASS', detail: 'Production result gate exposes actual worker-ready output bound to this case, citation and receipt' };
      const selected = new URL(await measure('location.href') as string);
      selected.searchParams.set('wfReview', 'true');
      const identity = await measure(selection.loginScripts.reviewer).catch(() => {
        throw new Error('Production cookie identity switch failed for reviewer');
      });
      expect(identity).toMatchObject({ userId: selection.actors.reviewer.id, workspaceId, actor: 'reviewer' });
      expect(selection.actors.reviewer.id).not.toBe(selection.actors.employee.id);
      await native('navigate', selected.toString(), '--json');
      await check(`!!document.querySelector(${panel})`);
      const { loginScripts: _secrets, ...accessSelection } = selection;
      matrix[3].status = 'FAIL';
      for (const access of ['no-grant', 'no-source-acl'] as const) {
        expect(await fixtureProcess(false, { selection: accessSelection, access })).toMatchObject({
          access, documentIds: [], ...(access === 'no-grant' ? { allowed: false } : { allowed: true }),
        });
        await refresh();
        await check(`(() => { const s=document.querySelector(${panel}); return s.textContent.includes('unavailable:') && !s.querySelector('[aria-label="Prepared support handoff"]') && !Array.from(s.querySelectorAll('button')).some(b=>b.textContent==='Accept result'); })()`);
        expect(await fixtureProcess(false, { selection: accessSelection, access: 'allowed' }))
          .toMatchObject({ allowed: true, documentIds: [selection.documentId] });
        await refresh();
        await check(ready);
      }
      matrix[3] = { ...matrix[3], status: 'PASS', detail: 'Same allowlisted reviewer denied without personal grant and without source ACL; production UI restored only with both' };
      matrix[2].status = 'FAIL';
      await measure(`(() => { const t=document.querySelector(${panel}).querySelector('textarea'); if (!t) throw new Error('Review reason missing'); t.id='p012-business-reason'; return true; })()`);
      const reason = `Native distinct reviewer ${decision} for receipt ${handle.receiptId}`;
      await native('type', '#p012-business-reason', reason, '--json');
      const button = decision === 'accept' ? 'Accept result' : decision === 'reject' ? 'Reject result' : 'Request rework';
      await check(`Array.from(document.querySelectorAll(${JSON.stringify(`${receipt} button`)})).some(b=>b.textContent===${JSON.stringify(button)} && !b.disabled)`);
      await measure(`(() => { Array.from(document.querySelectorAll(${JSON.stringify(`${receipt} button`)})).find(b=>b.textContent===${JSON.stringify(button)}).click(); return true; })()`);
      const outcome = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'rework';
      const reviewed = `(() => { const s=document.querySelector(${panel}); return s?.getAttribute('aria-busy')==='false' && s.textContent.includes(${JSON.stringify(`Business outcome: ${outcome}`)}) && s.textContent.includes(${JSON.stringify(`Reviewed by ${selection.actors.reviewer.id}: ${reason}`)}) && !s.querySelector('textarea'); })()`;
      await check(reviewed);
      const saved = await measure(`Array.from(document.querySelector(${panel}).querySelectorAll('code')).map(c=>c.textContent)`);
      await native('navigate', selected.toString(), '--json');
      await check(reviewed);
      expect(await measure(`Array.from(document.querySelector(${panel}).querySelectorAll('code')).map(c=>c.textContent)`)).toEqual(saved);
      matrix[2] = { ...matrix[2], status: 'PASS', detail: `Native ${decision} persisted for the distinct reviewer and survived navigation with identical evidence refs` };
      expect(matrix.filter(row => row.status !== 'PASS'), 'Business acceptance has unexecuted legs').toEqual([]);
      await retain(info, 'p012-business-verdict', { decision, handle, evidenceRefs: saved,
        boundary: 'Business/reviewer evidence only; native admin acceptance and shipment remain separate' });
    } finally {
      await retain(info, 'p012-journey-matrix', matrix);
      await retain(info, 'p012-journey-dom', await measure('({url:location.href,text:document.body.innerText.slice(0,12000)})'));
    }
  });
  }
});
