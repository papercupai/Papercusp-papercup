/** Explicit live acceptance only: ordinary CI cannot publish a GitHub fixture. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const live = process.env.PAPERCUSP_REPORT_SHARING_NATIVE_LIVE === '1';

describe.skipIf(!live)('report sharing through the owned native operator', () => {
  it('shares the selected harmless edition, copies its URL, reads Pages anonymously and stops sharing', async () => {
    expect(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED).toBe('1');
    const pid = process.env.VERIFY_TAURI_PID!;
    const profile = JSON.parse(readFileSync(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!, 'utf8'));
    const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
    expect(Number(pid)).toBe(profile.tauriPID);
    expect(receipt.schemaVersion).toBe('verifier-source-v1');
    expect(receipt.sourceCommit).toBe(process.env.VERIFY_TAURI_SOURCE_REF);
    expect(process.env.OPERATOR_SOURCE_ROOT).toBeTruthy();
    expect(process.env.PAPERCUSP_TEST_RUNS_DB_URL).toBeTruthy();
    const evidencePath = process.env.PAPERCUSP_REPORT_SHARING_NATIVE_EVIDENCE!;
    expect(evidencePath?.startsWith('/')).toBe(true);
    const env = { ...process.env, TMPDIR: profile.nativeTmpDir };
    const native = async (command: string, ...args: string[]) => {
      await execute('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { env, timeout: 15_000 });
      const result = await execute(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!,
        [command, ...args, '--pid', pid], { env, timeout: 30_000 });
      return result.stdout.trim();
    };
    const evaluate = async (expression: string) => JSON.parse(await native('eval', `JSON.stringify(${expression})`));
    const wait = async (expression: string) => expect.poll(() => evaluate(expression), { timeout: 60_000 }).toBe(true);
    const call = async (expression: string) => {
      await native('eval', `window.__sharingAcceptance={done:false};void(async()=>{try{
        window.__sharingAcceptance={done:true,value:await(${expression})};
      }catch(error){window.__sharingAcceptance={done:true,error:String(error)};}})()`);
      await wait('window.__sharingAcceptance?.done===true');
      const result = await evaluate('window.__sharingAcceptance');
      expect(result.error).toBeUndefined();
      return result.value;
    };
    const tool = async (name: string, args: object) => {
      const result = await call(`fetch('/api/agent-mcp/run-tool',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify(${JSON.stringify({ name, args, confirmed: true })})}).then(async response=>({status:response.status,body:await response.json()}))`);
      expect(result.status).toBe(200);
      expect(result.body.result?.isError).not.toBe(true);
      const value = result.body.result;
      return value.data ?? JSON.parse(value.content.find((entry: { type: string }) => entry.type === 'text').text);
    };
    const click = (label: string) => native('eval', `(()=>{const buttons=[...document.querySelectorAll('[aria-label="Report sharing"] button')]
      .filter(button=>button.textContent.trim()===${JSON.stringify(label)}&&!button.disabled);
      if(buttons.length!==1)throw Error('Expected one enabled sharing action');buttons[0].click();return true;})()`);
    const key = 'native-sharing-' + randomUUID();
    const body = '# Native sharing fixture\n\nHarmless acceptance fixture ' + key
      + '\n\n## Findings\n\n| Check | Result |\n|---|---|\n| Native journey | exercised |\n\n```mermaid\ngraph TD; A[Shared] --> B[Read]\n```';
    const published = await tool('reports:publish', { title: 'Native report sharing fixture', body_md: body,
      visibility: 'owner', request_key: key });
    expect(published.ok).toBe(true);
    const reportId = published.report_id;
    expect(reportId).toBeTruthy();
    const evidence: Record<string, unknown> = { schemaVersion: 1, reportId, sourceCommit: receipt.sourceCommit,
      sourceReceipt: process.env.VERIFY_TAURI_SOURCE_RECEIPT, scope: 'current-build', phase: 'published-local-fixture' };
    const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    save(); // Recovery knows the selected edition before the first outward action.
    let stopped = false;
    const browser = await chromium.launch({ headless: true });
    try {
      await native('navigate', published.path);
      await wait(`document.querySelector('.reports-reader')?.textContent.includes(${JSON.stringify(key)})===true`);
      await wait(`[...document.querySelectorAll('[aria-label="Report sharing"] button')].some(button=>button.textContent.trim()==='Share'&&!button.disabled)`);
      await click('Share');
      await expect.poll(async () => {
        const value = await evaluate(`document.querySelector('[aria-label="Shared link"]')?.value??null`);
        if (value) return value;
        const check = await evaluate(`[...document.querySelectorAll('[aria-label="Report sharing"] button')].some(button=>button.textContent.trim()==='Check sharing'&&!button.disabled)`);
        if (check) await click('Check sharing');
        return null;
      }, { timeout: 120_000, interval: 3000 }).toMatch(/^https:\/\/[^/]+\.github\.io\//);
      const url = await evaluate(`document.querySelector('[aria-label="Shared link"]').value`);
      evidence.url = url; evidence.phase = 'shared'; save();
      await click('Copy shared link');
      await wait(`document.querySelector('[aria-label="Report sharing"]')?.textContent.match(/Shared link copied|Clipboard access was denied/)!=null`);
      expect(await evaluate(`document.querySelector('[aria-label="Shared link"]').value`)).toBe(url);
      evidence.copyStatus = await evaluate(`[...document.querySelectorAll('[aria-label="Report sharing"] [role="status"]')].map(node=>node.textContent)`);
      await native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', evidencePath + '.png');
      evidence.nativeScreenshot = evidencePath + '.png'; save();
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const page = await context.newPage();
        const requests: { url: string; credential: boolean }[] = [];
        page.on('request', request => requests.push({ url: request.url(), credential: !!request.headers().authorization }));
        await page.goto(url);
        await expect.poll(() => page.locator('#report').textContent()).toContain(key);
        await page.locator('.diagram svg').waitFor();
        expect(await page.getByRole('table').textContent()).toContain('Native journey');
        expect(requests.some(request => request.credential || /https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(request.url))).toBe(false);
        evidence.anonymousRequests = requests;
      } finally { await context.close(); }
      await click('Stop sharing');
      await wait(`document.querySelector('[aria-label="Report sharing"]')?.textContent.includes('Sharing stopped.')===true`);
      stopped = true;
      expect(await evaluate(`document.querySelector('[aria-label="Shared link"]')===null`)).toBe(true);
      const contextAfter = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const page = await contextAfter.newPage();
        const responses: { url: string; status: number }[] = [];
        page.on('response', response => { if (response.url().startsWith('https://api.github.com/gists/')) responses.push({ url: response.url(), status: response.status() }); });
        await page.goto(url);
        await page.getByRole('alert').waitFor();
        expect(await page.locator('#report').isVisible()).toBe(false);
        expect(responses.some(response => response.status === 404)).toBe(true);
        evidence.afterDeletion = responses;
      } finally { await contextAfter.close(); }
      evidence.phase = 'removed'; evidence.verifiedAt = new Date().toISOString(); save();
      console.log('REPORT_SHARING_NATIVE_EVIDENCE=' + evidencePath);
    } finally {
      await browser.close();
      if (!stopped) {
        // The product reconciles its saved operation; never delete an arbitrary Gist.
        const status = await call(`fetch('/api/zero-harness/rest-query?name=reports.sharing&args='+encodeURIComponent(JSON.stringify({reportId:${JSON.stringify(reportId)}}))).then(response=>response.json())`);
        const accountId = status.rows?.[0]?.accountId;
        if (accountId) {
          const cleanup = await call(`fetch('/api/reports/sharing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ reportId, accountId, action: 'stop' })})}).then(async response=>({status:response.status,body:await response.json()}))`);
          evidence.cleanup = cleanup; save();
          expect(cleanup.body.sharing?.phase).toBe('inactive');
        }
      }
      await tool('reports:retire', { id: reportId, reason: 'Harmless native sharing acceptance fixture finished.' });
    }
  }, 240_000);

  it('binds the journey to the exact shipped operator artifact', async () => {
    // A current-build run is useful, but cannot pass this release obligation.
    expect(process.env.PAPERCUSP_REPORT_SHARING_FINAL_RELEASE).toBe('1');
    const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
    const evidence = JSON.parse(readFileSync(process.env.PAPERCUSP_REPORT_SHARING_NATIVE_EVIDENCE!, 'utf8'));
    const response = await fetch('http://127.0.0.1:3070/api/health', { signal: AbortSignal.timeout(15_000) });
    expect(response.ok).toBe(true);
    const health = await response.json();
    const sha = health.sha;
    expect(sha).toMatch(/^[a-f0-9]{10,64}$/);
    expect(health.bundleStale).toBeUndefined();
    expect(receipt.sourceCommit.startsWith(sha)).toBe(true);
    expect(evidence.sourceCommit).toBe(receipt.sourceCommit);
    expect(evidence.phase).toBe('removed');
    expect(evidence.afterDeletion.some((item: { status: number }) => item.status === 404)).toBe(true);
    const route = await fetch('http://127.0.0.1:3070/api/reports/sharing', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000),
    });
    expect(route.status).toBe(400); // The shipped route validates input; an absent route is 404.
    evidence.scope = 'exact-deployed-artifact'; evidence.deployedHealth = health;
    writeFileSync(process.env.PAPERCUSP_REPORT_SHARING_NATIVE_EVIDENCE!, JSON.stringify(evidence, null, 2));
  }, 30_000);
});
