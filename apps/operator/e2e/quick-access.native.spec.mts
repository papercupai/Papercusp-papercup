import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { publishReport } from '../../../packages/operator-core/lib/report-library';
import { insertNativeCollectionPlan } from './_ongoing-work-native-fixture';
import { decodeNativeBridgeJson } from './_native-bridge-json';
import { sampleNativePopup, withNativePopupFailure } from './_native-popup-diagnostics';

const exec = promisify(execFile);

test('Quick Access opens as an independent native launcher with reports and exact conversations', async ({}, info) => {
  test.setTimeout(240_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_ISOLATED_SEED).toBe('ready');
  expect(process.env.VERIFY_TAURI_ISOLATED_SHORTCUT).toBe('CmdOrCtrl+Shift+K');
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['localhost', '127.0.0.1']).toContain(database.hostname);
  expect(database.port).not.toBe('5432');
  expect(database.port).not.toBe('');
  const pid = process.env.VERIFY_TAURI_PID!;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(pid).toBeTruthy(); expect(tool).toBeTruthy();
  const displayEnv = { ...process.env, DISPLAY: process.env.VERIFY_TAURI_DISPLAY!, WAYLAND_DISPLAY: '' };
  const sql = postgres(database.toString(), { max: 1, onnotice: () => {} });
  const label = 'docs-search-palette';
  const owner = 'su-native-quick-access';
  const decoyOwner = 'su-native-decoy-quick-access';
  const terminal = spawn('xterm', ['-T', 'Quick Access decoy fixture', '-e', 'sleep', '240'], { env: displayEnv, stdio: 'ignore' });
  const targetTerminal = spawn('xterm', ['-T', 'Quick Access exact fixture', '-e', 'sleep', '240'], { env: displayEnv, stdio: 'ignore' });
  async function evaluate(expression: string, window = label) {
    await exec('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 15_000 });
    const { stdout } = await exec(tool, ['eval', '--pid', pid, '--window-label', window, expression, '--json'], { timeout: 30_000 });
    return decodeNativeBridgeJson(stdout, 'eval');
  }
  async function wait(expression: string) {
    try {
      await expect.poll(() => evaluate(expression), { timeout: 60_000 }).toBe(true);
    } catch (error) {
      // Playwright's own page is not this native webview. Capture the actual
      // failing window before the isolated harness tears it down.
      try {
        const snapshot = await evaluate('({url:location.href,body:document.body.innerText,dialogs:Array.from(document.querySelectorAll("[role=dialog]")).map(d=>d.outerHTML),errors:window.__quickAccessErrors||[]})');
        await info.attach('Native predicate failure', { body: JSON.stringify({ expression, snapshot }), contentType: 'application/json' });
      } catch (captureError) {
        await info.attach('Native diagnostic failure', { body: String(captureError), contentType: 'text/plain' });
      }
      throw error;
    }
  }
  async function click(selector: string) {
    expect(await evaluate('(() => { const e=document.querySelector(' + JSON.stringify(selector) + '); if(!e || e.disabled) return false; e.click(); return true; })()')).toBe(true);
  }
  async function popupWindows(onlyVisible = true) {
    const found = await exec('xdotool', ['search', '--all', ...(onlyVisible ? ['--onlyvisible'] : []),
      '--pid', pid, '--name', '^Quick Access$'], { env: displayEnv, timeout: 5_000 })
      .catch(() => ({ stdout: '' }));
    return found.stdout.trim().split('\n').filter(Boolean);
  }
  async function escape() {
    const windows = await popupWindows();
    expect(windows).toHaveLength(1);
    await exec('xdotool', ['windowactivate', '--sync', windows[0]], { env: displayEnv, timeout: 15_000 });
    await expect.poll(async () => (await exec('xdotool', ['getwindowfocus'], { env: displayEnv })).stdout.trim(), { timeout: 15_000 }).toBe(windows[0]);
    await exec('xdotool', ['key', '--clearmodifiers', 'Escape'], { env: displayEnv, timeout: 15_000 });
  }
  async function setQuery(query: string) {
    await evaluate('(() => { const input=document.querySelector(".pc-qa__search input"); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set; setter.call(input,' + JSON.stringify(query) + '); input.dispatchEvent(new Event("input",{bubbles:true})); input.focus(); })()');
  }
  async function expectDefaultTabs() {
    expect(await evaluate('Array.from(document.querySelectorAll("[aria-label=\\"Quick Panel tabs\\"] [role=tab]")).map(e=>({name:e.textContent.trim(),selected:e.getAttribute("aria-selected")}))'))
      .toEqual([{ name: 'Quick Access', selected: 'true' }, { name: 'Prompts', selected: 'false' },
        { name: 'Brainstorm', selected: 'false' }, { name: 'Docs', selected: 'false' }]);
  }
  const visible = () => evaluate('window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", {label:"docs-search-palette"})');
  async function recordPopup(stage: string) {
    const snapshot = await sampleNativePopup(stage, async () => {
      const focus = await exec('xdotool', ['getwindowfocus'], { env: displayEnv, timeout: 5_000 });
      const active = await exec('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { env: displayEnv, timeout: 5_000 });
      const windows = await Promise.all((await popupWindows(false)).map(async id => ({ id,
        state: (await exec('xwininfo', ['-id', id], { env: displayEnv, timeout: 5_000 })).stdout,
      })));
      return { focus: focus.stdout.trim(), active: active.stdout.trim(), windows };
    }, () => evaluate('Promise.all([window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", {label:"docs-search-palette"})]).then(([visible])=>({visible,documentFocused:document.hasFocus(),url:location.href,errors:window.__quickAccessErrors||[]}))'));
    await info.attach('Quick Access popup ' + stage, { body: JSON.stringify(snapshot), contentType: 'application/json' });
  }
  async function expectUsable(selectors: string[]) {
    for (const selector of selectors) {
      await wait('(() => { const e=document.querySelector(' + JSON.stringify(selector) + '); if(!e) return false; const r=e.getBoundingClientRect(); const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return r.width>0 && r.height>0 && r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight && !!top && (top===e || e.contains(top)); })()');
    }
  }
  async function ready() {
    await wait('!!document.querySelector("[aria-label=\\"Quick Access launcher\\"]")');
    await evaluate('(() => { if(window.__quickAccessErrors) return; window.__quickAccessErrors=[]; addEventListener("error", e=>window.__quickAccessErrors.push(String(e.error||e.message)),true); addEventListener("unhandledrejection", e=>window.__quickAccessErrors.push(String(e.reason))); })()');
  }
  async function open() {
    if (!(await visible())) {
      await evaluate('window.__TAURI_INTERNALS__.invoke("open_docs_search_palette")', 'main');
    }
    await ready();
    await expect.poll(visible).toBe(true);
  }
  try {
    // xdotool exits 1 before the new X window is mapped; --sync waits for it
    // instead of rejecting the first expect.poll callback before it can retry.
    const { stdout: fixtureWindows } = await exec('xdotool',
      ['search', '--sync', '--onlyvisible', '--pid', String(terminal.pid)],
      { env: displayEnv, timeout: 15_000 });
    const decoyWindowId = fixtureWindows.trim().split('\n')[0];
    const { stdout: targetWindows } = await exec('xdotool',
      ['search', '--sync', '--onlyvisible', '--pid', String(targetTerminal.pid)],
      { env: displayEnv, timeout: 15_000 });
    const windowId = targetWindows.trim().split('\n')[0];
    expect(decoyWindowId).toMatch(/^\d+$/);
    expect(windowId).toMatch(/^\d+$/);
    expect(windowId).not.toBe(decoyWindowId);
    await insertNativeCollectionPlan(sql, { workspaceId: workspace, harness: 'papercusp', slug: 'native-quick-access', title: 'Native launcher plan', status: 'active' });
    // Model a terminal server: two agents report the same PID but have distinct
    // launch identities and windows. A PID or first-window fallback must fail.
    for (const [fixtureOwner, name, fixtureWindow] of [
      [decoyOwner, 'Native launcher decoy', decoyWindowId],
      [owner, 'Native launcher agent', windowId],
    ]) {
      await sql.unsafe('INSERT INTO harness_shared.coord_presence (workspace_id,owner_id,owner_label,source,host,pid,intent,heartbeat_at,last_active_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())',
        [workspace, fixtureOwner, name, 'isolated-native-assertion', hostname(), process.pid, 'Native launcher verification ' + fixtureOwner]);
      await sql.unsafe('INSERT INTO harness_shared.adv_sessions (workspace_id,mode,agent,coord_owner_id,plan_slug,label,window_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [workspace, 'omp', 'codex', fixtureOwner, 'native-quick-access', name, fixtureWindow]);
    }
    const report = await publishReport(sql, { workspaceId: workspace, title: 'Native launcher report',
      bodyMd: '# Verified report\n\nQuick Access native body.', visibility: 'owner', requestKey: 'quick-access-native-report' });
    // First entry MUST be the real OS accelerator, not the popup IPC command.
    // The verifier seeds the chosen preset only in its private PAPERCUSP_HOME.
    const configHome = process.env.PAPERCUSP_HOME!;
    expect(configHome).toMatch(/\/papercusp-home$/);
    expect(JSON.parse(await readFile(configHome + '/docs-search-shortcut.json', 'utf8')))
      .toEqual({ accelerator: 'CmdOrCtrl+Shift+K' });
    await test.step('R-1: OS shortcut, hidden main window, retained tools and singleton reentry', () => withNativePopupFailure(async () => {
      // Hide the real X11 window without asking the webview for an ungranted
      // core:window:allow-hide permission. Before first entry only main exists.
      const { stdout: mainWindows } = await exec('xdotool',
        ['search', '--sync', '--onlyvisible', '--pid', pid], { env: displayEnv, timeout: 15_000 });
      const mainWindowIds = mainWindows.trim().split('\n').filter(Boolean);
      expect(mainWindowIds).toHaveLength(1);
      const mainWindowId = mainWindowIds[0];
      expect(mainWindowId).toMatch(/^\d+$/);
      await exec('xdotool', ['windowunmap', '--sync', mainWindowId], { env: displayEnv, timeout: 15_000 });
      const { stdout: mainWindowState } = await exec('xwininfo', ['-id', mainWindowId], { env: displayEnv, timeout: 5_000 });
      expect(mainWindowState).toMatch(/Map State:\s+IsUnMapped/);
      await info.attach('X11-unmapped main window (app visibility unchanged)', {
        body: JSON.stringify({ mainWindowId, method: 'xdotool windowunmap --sync', mainWindowState,
          limitation: 'OS-level unmapping does not update Tauri application visibility state.' }),
        contentType: 'application/json',
      });
      async function shortcut(fromOutside = true) {
        if (fromOutside) {
          await exec('xdotool', ['windowactivate', '--sync', decoyWindowId], { env: displayEnv, timeout: 15_000 });
          await expect.poll(async () => (await exec('xdotool', ['getwindowfocus'], { env: displayEnv })).stdout.trim(), { timeout: 15_000 }).toBe(decoyWindowId);
        }
        await exec('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+k'], { env: displayEnv, timeout: 15_000 });
      }
      await shortcut();
      await expect.poll(async () => (await popupWindows()).length, { timeout: 30_000 }).toBe(1);
      await recordPopup('first-os-entry');
      await ready();
      await recordPopup('after-ready');
      expect(await popupWindows(false)).toHaveLength(1);
      await expectDefaultTabs();
      await recordPopup('after-default-tabs');
      // The established shortcut toggles the existing popup off, then on.
      // Keep focus on the visible popup: activating the decoy would blur-hide
      // it before the keypress and accidentally test reopening instead.
      await expect.poll(visible).toBe(true);
      await shortcut(false);
      await expect.poll(visible).toBe(false);
      expect(await popupWindows(false)).toHaveLength(1);
      await shortcut();
      await ready();
      await expect.poll(visible).toBe(true);
      expect(await popupWindows(false)).toHaveLength(1);
      await expectDefaultTabs();
      // A real departure must still dismiss. Unlike the passive shortcut
      // grab above, the X server moves input focus to this other application.
      await exec('xdotool', ['windowactivate', '--sync', decoyWindowId], { env: displayEnv, timeout: 15_000 });
      await expect.poll(async () => (await exec('xdotool', ['getwindowfocus'], { env: displayEnv })).stdout.trim()).toBe(decoyWindowId);
      await expect.poll(visible).toBe(false);
      expect(await popupWindows(false)).toHaveLength(1);
      await shortcut();
      await ready();
      await expect.poll(visible).toBe(true);
    }, () => recordPopup('R-1-failure')));
    await info.attach('OS shortcut entry', { body: JSON.stringify({
      accelerator: 'CmdOrCtrl+Shift+K', outsideWindowId: decoyWindowId, configHome,
      popupVisible: await visible(), entry: 'OS keypress through native startup registrar',
    }), contentType: 'application/json' });
    expect(await evaluate('({ path:location.pathname, native:window.__PAPERCUSP_QUICK_PANEL_WINDOW__, width:innerWidth, height:innerHeight })'))
      .toMatchObject({ path: '/quick-panel', native: true, width: 1000, height: 665 });
    await wait('document.querySelector(".pc-qa__results")?.textContent.includes("Native launcher plan") === true');
    await wait('document.querySelector(".pc-qa__preview")?.textContent.includes("Native launcher agent") === true');
    await expectUsable(['.pc-qa__search input', '.pc-qa__scopes', '.pc-qa__results', '.pc-qa__preview',
      '[aria-label="Talk to Native launcher agent"]', '[aria-label="Focus Native launcher agent window"]']);
    await test.step('R-3: conversation resolves the selected owner among shared-PID agents', async () => {
      await setQuery('Native launcher agent');
      await wait('!!document.querySelector("[aria-label=\\"Talk to Native launcher agent\\"]")');
      await click('[aria-label="Talk to Native launcher agent"]');
      // The centred chat has no Close conversation button: that control only
      // exists when maximized. Observe the conversation itself in either mode.
      await wait('!!document.querySelector("[role=\\"dialog\\"] [data-testid=\\"session-chat-conversation\\"]")');
      // The resolved native roster's objective identifies the selected owner.
      await wait('Array.from(document.querySelectorAll("[role=\\"dialog\\"]")).some(d => { const title=document.getElementById(d.getAttribute("aria-labelledby")); return title?.textContent.includes(' + JSON.stringify('Native launcher verification ' + owner) + ') === true; })');
      await expectUsable(['[role="dialog"]', '[data-testid="session-chat-full-window"]']);
    });
    await test.step('R-5: OS Escape dismisses conversation before clearing its query', async () => {
      await escape();
      await wait('!document.querySelector("[data-testid=\\"session-chat-conversation\\"]")');
      expect(await evaluate('document.querySelector(".pc-qa__search input")?.value')).toBe('Native launcher agent');
      expect(await visible()).toBe(true);
      await escape();
      await wait('document.querySelector(".pc-qa__search input")?.value === ""');
      expect(await visible()).toBe(true);
    });
    await test.step('R-3: authorized report stays inside the popup', async () => {
      await click('[aria-label="Search scope"] button:nth-child(4)');
      await wait('document.querySelector(".pc-qa__preview")?.textContent.includes("Quick Access native body.") === true');
      expect(await evaluate('location.pathname === "/quick-panel" && !!document.querySelector(".pc-qa__report")')).toBe(true);
      await click('.pc-qa__preview button');
      await wait('!!document.querySelector("[role=\\"dialog\\"]")');
      await wait('document.querySelector("[role=\\"dialog\\"] .pc-qa__report")?.textContent.includes("Quick Access native body.") === true');
      expect(await evaluate('location.pathname === "/quick-panel"')).toBe(true);
      await expectUsable(['[role="dialog"]']);
    });
    await test.step('R-5: OS Escape dismisses report, then clears a query without closing the popup', async () => {
      await escape();
      await wait('!document.querySelector("[role=\\"dialog\\"]")');
      expect(await visible()).toBe(true);
      await setQuery('nonexistent-native-query');
      await wait('document.querySelector(".pc-qa__results")?.textContent.includes("No matching") === true');
      await escape();
      await wait('document.querySelector(".pc-qa__search input")?.value === ""');
      expect(await visible()).toBe(true);
    });
    const windows = await popupWindows();
    expect(windows).toHaveLength(1);
    const screenshot = info.outputPath('quick-access-native.png');
    await exec(tool, ['screenshot', '--pid', pid, '--window-id', windows[0], '--output', screenshot], { env: displayEnv, timeout: 30_000 });
    await info.attach('Quick Access native popup', { path: screenshot, contentType: 'image/png' });
    await test.step('R-4: focus the exact second window despite a shared reported PID', async () => {
      await setQuery('Native launcher agent');
      await click('[aria-label="Search scope"] button:nth-child(3)');
      await wait('!!document.querySelector("[aria-label=\\"Focus Native launcher agent window\\"]:not(:disabled)")');
      await click('[aria-label="Focus Native launcher agent window"]');
      await expect.poll(async () => (await exec('xdotool', ['getwindowfocus'], { env: displayEnv })).stdout.trim(), { timeout: 15_000 }).toBe(windowId);
      expect((await exec('xdotool', ['getwindowfocus'], { env: displayEnv })).stdout.trim()).not.toBe(decoyWindowId);
    });
    await test.step('R-5: final OS Escape hides the singleton popup', async () => {
      await open();
      await setQuery('');
      await wait('document.querySelector(".pc-qa__search input")?.value === ""');
      await escape();
      await expect.poll(visible).toBe(false);
    });
    if (process.env.VERIFY_TAURI_SOURCE_RECEIPT) await info.attach('source receipt', {
      body: await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT), contentType: 'application/json',
    });
    await info.attach('fixture identities', { body: JSON.stringify({ owner, windowId, decoyOwner, decoyWindowId,
      sharedReportedPid: process.pid, reportId: report.reportId, workspace }), contentType: 'application/json' });
  } finally {
    terminal.kill();
    targetTerminal.kill();
    await sql.end({ timeout: 5 });
  }
});
