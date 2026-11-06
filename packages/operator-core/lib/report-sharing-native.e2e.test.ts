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
  it('shares the selected harmless edition, checks its Copy control, reads Pages anonymously and stops sharing', async () => {
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
    const initialStatus = await call(`fetch('/api/zero-harness/rest-query?name=reports.sharing&args='+encodeURIComponent(JSON.stringify({reportId:${JSON.stringify(reportId)}}))).then(response=>response.json())`);
    const accountId = initialStatus.rows?.[0]?.accountId;
    expect(Number.isSafeInteger(accountId)).toBe(true);
    expect(accountId).toBeGreaterThan(0);
    expect(initialStatus.rows[0].login).toBe(process.env.VERIFY_TAURI_GITHUB_AUTH_LOGIN);
    const evidence: Record<string, unknown> = { schemaVersion: 1, reportId, sourceCommit: receipt.sourceCommit,
      sourceReceipt: process.env.VERIFY_TAURI_SOURCE_RECEIPT, scope: 'current-build', phase: 'published-local-fixture',
      selectedAccount: { id: accountId, login: initialStatus.rows[0].login } };
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
      // The isolated WebKit permission-error path is useful native coverage.
      // Successful clipboard CONTENTS are mandatory in the deployed-browser test.
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
        // Persisted before Share: a later missing status row cannot skip cleanup.
        const cleanup = await call(`fetch('/api/reports/sharing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ reportId, accountId, action: 'stop' })})}).then(async response=>({status:response.status,body:await response.json()}))`);
        evidence.cleanup = cleanup; save();
        expect(cleanup.status).toBe(200);
        expect(cleanup.body.sharing?.phase).toBe('inactive');
      }
      await tool('reports:retire', { id: reportId, reason: 'Harmless native sharing acceptance fixture finished.' });
    }
  }, 240_000);

  it('exercises Share, Copy and Stop through the exact shipped operator UI', async () => {
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
    const browser = await chromium.launch({ headless: true });
    const owner = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await owner.newPage();
    const deployed: Record<string, unknown> = { sourceCommit: receipt.sourceCommit, health,
      baseUrl: 'http://127.0.0.1:3070', phase: 'before-publication' };
    evidence.deployedJourney = deployed;
    const save = () => writeFileSync(process.env.PAPERCUSP_REPORT_SHARING_NATIVE_EVIDENCE!, JSON.stringify(evidence, null, 2));
    const tool = async (name: string, args: object) => {
      const response = await owner.request.post('http://127.0.0.1:3070/api/agent-mcp/run-tool',
        { data: { name, args, confirmed: true } });
      expect(response.ok()).toBe(true);
      const payload = await response.json();
      expect(payload.result?.isError).not.toBe(true);
      const result = payload.result;
      return result.data ?? JSON.parse(result.content.find((item: { type: string }) => item.type === 'text').text);
    };
    const status = async (reportId: string) => {
      const response = await owner.request.get('http://127.0.0.1:3070/api/zero-harness/rest-query',
        { params: { name: 'reports.sharing', args: JSON.stringify({ reportId }) } });
      expect(response.ok()).toBe(true);
      return (await response.json()).rows?.[0];
    };
    const removed = async (url: string) => {
      const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const reader = await anonymous.newPage();
        const responses: { url: string; status: number }[] = [];
        reader.on('response', response => {
          if (response.url().startsWith('https://api.github.com/gists/'))
            responses.push({ url: response.url(), status: response.status() });
        });
        await reader.goto(url);
        await expect.poll(async () => {
          if (await reader.getByRole('alert').isVisible()) return true;
          await reader.reload();
          return false;
        }, { timeout: 60_000, interval: 3000 }).toBe(true);
        expect(await reader.locator('#report').isVisible()).toBe(false);
        expect(responses.some(response => response.status === 404)).toBe(true);
        return responses;
      } finally { await anonymous.close(); }
    };
    const key = 'deployed-sharing-' + randomUUID();
    let reportId: string | undefined;
    let accountId: number | undefined;
    let url: string | undefined;
    let publicationAttempted = false;
    let cleanupConfirmed = false;
    try {
      const published = await tool('reports:publish', { title: 'Deployed report sharing fixture',
        body_md: '# Deployed sharing fixture\n\nHarmless acceptance fixture ' + key
          + '\n\n## Findings\n\n| Check | Result |\n|---|---|\n| Deployed UI | exercised |\n\n```mermaid\ngraph TD; A[Shared] --> B[Read]\n```',
        visibility: 'owner', request_key: key });
      expect(published.ok).toBe(true);
      reportId = published.report_id;
      expect(reportId).toBeTruthy();
      deployed.reportId = reportId; save();
      const selected = await status(reportId!);
      expect(Number.isSafeInteger(selected?.accountId)).toBe(true);
      expect(selected.accountId).toBeGreaterThan(0);
      expect(selected.login).toBe(process.env.VERIFY_TAURI_GITHUB_AUTH_LOGIN);
      accountId = selected.accountId;
      deployed.selectedAccount = { id: accountId, login: selected.login }; save();
      await page.goto(new URL(published.path, 'http://127.0.0.1:3070').href);
      await expect.poll(() => page.locator('.reports-reader').textContent()).toContain(key);
      const actions = page.getByRole('region', { name: 'Report sharing' });
      // <section aria-label> is exposed as a region. Use real browser clicks so
      // clipboard success is measured with the browser's permission policy.
      await expect.poll(() => actions.getByRole('button', { name: 'Share', exact: true }).isEnabled()).toBe(true);
      publicationAttempted = true; deployed.phase = 'sharing'; save();
      await actions.getByRole('button', { name: 'Share', exact: true }).click();
      const link = page.getByLabel('Shared link', { exact: true });
      await expect.poll(async () => {
        if (await link.count()) return link.inputValue();
        const retry = actions.getByRole('button', { name: 'Check sharing', exact: true });
        if (await retry.count() && await retry.isEnabled()) await retry.click();
        return null;
      }, { timeout: 120_000, interval: 3000 }).toMatch(/^https:\/\/[^/]+\.github\.io\//);
      url = await link.inputValue(); deployed.url = url; save();
      await actions.getByRole('button', { name: 'Copy shared link', exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
      deployed.copiedUrl = url;
      const shareUrl = new URL(url);
      const fragment = new URLSearchParams(shareUrl.hash.slice(1));
      expect(fragment.get('gist')).toMatch(/^[a-z\d][a-z\d-]{0,38}\/[a-f\d]{32}$/i);
      const [gistLogin, gistId] = fragment.get('gist')!.split('/');
      expect(gistLogin.toLowerCase()).toBe(selected.login.toLowerCase());
      expect(shareUrl.hostname.toLowerCase()).toBe(selected.login.toLowerCase() + '.github.io');
      const gistResponse = await fetch('https://api.github.com/gists/' + gistId + '?read=' + randomUUID(),
        { signal: AbortSignal.timeout(15_000) });
      expect(gistResponse.ok).toBe(true);
      const gist = await gistResponse.json();
      const repoResponse = await fetch('https://api.github.com/repos/' + encodeURIComponent(selected.login) + '/papercusp-reports',
        { signal: AbortSignal.timeout(15_000) });
      expect(repoResponse.ok).toBe(true);
      const repo = await repoResponse.json();
      expect(gist.public).toBe(false);
      expect(gist.owner.id).toBe(accountId);
      expect(repo.owner.id).toBe(accountId);
      deployed.ownership = { gistId: gist.id, secret: gist.public === false,
        gistOwnerId: gist.owner.id, repoId: repo.id, repoOwnerId: repo.owner.id };
      const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const reader = await anonymous.newPage();
        const requests: { url: string; credential: boolean }[] = [];
        reader.on('request', request => requests.push({ url: request.url(), credential: !!request.headers().authorization }));
        await reader.goto(url);
        await expect.poll(() => reader.locator('#report').textContent()).toContain(key);
        await reader.locator('.diagram svg').waitFor();
        expect(await reader.getByRole('table').textContent()).toContain('Deployed UI');
        expect(requests.some(request => request.credential || /https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(request.url))).toBe(false);
        deployed.anonymousRequests = requests;
      } finally { await anonymous.close(); }
      await actions.getByRole('button', { name: 'Stop sharing', exact: true }).click();
      await expect.poll(() => actions.textContent()).toContain('Sharing stopped.');
      expect(await link.count()).toBe(0);
      deployed.afterDeletion = await removed(url);
      cleanupConfirmed = true;
      const endHealth = await fetch('http://127.0.0.1:3070/api/health', { signal: AbortSignal.timeout(15_000) });
      expect(endHealth.ok).toBe(true);
      const endIdentity = await endHealth.json();
      expect(endIdentity.sha).toBe(sha);
      expect(endIdentity.bundleStale).toBeUndefined();
      deployed.endHealth = endIdentity; deployed.phase = 'removed'; deployed.verifiedAt = new Date().toISOString();
      evidence.scope = 'exact-deployed-artifact'; evidence.deployedHealth = health; save();
    } finally {
      try {
        if (publicationAttempted && !cleanupConfirmed) {
          // The account was persisted BEFORE Share: an absent status row cannot
          // silently skip cleanup after an ambiguous publication response.
          const cleanup = await owner.request.post('http://127.0.0.1:3070/api/reports/sharing',
            { data: { reportId, accountId, action: 'stop' } });
          deployed.cleanup = { status: cleanup.status(), body: await cleanup.json() }; save();
          expect(cleanup.ok()).toBe(true);
          expect((deployed.cleanup as { body: { sharing?: { phase?: string } } }).body.sharing?.phase).toBe('inactive');
          if (url) deployed.afterDeletion = await removed(url);
          cleanupConfirmed = true; deployed.phase = 'removed-after-failure'; save();
        }
        // Keep the recovery report visible if remote cleanup is unconfirmed.
        if (reportId && (!publicationAttempted || cleanupConfirmed))
          await tool('reports:retire', { id: reportId, reason: 'Harmless deployed sharing fixture finished.' });
      } finally { await browser.close(); }
    }
  }, 300_000);
});
