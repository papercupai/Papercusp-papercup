import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { publishReport } from '../../../packages/operator-core/lib/report-library';
import { decodeNativeBridgeJson } from './_native-bridge-json';

const exec = promisify(execFile);

test.describe.configure({ mode: 'serial' });

test('P010 native converse parity', async ({}, info) => {
  test.setTimeout(180_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_ISOLATED_SEED).toBe('ready');
  expect(process.env.VERIFY_TAURI_SEED).toBe('ready');
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['localhost', '127.0.0.1']).toContain(database.hostname);
  expect(database.port).not.toBe('5432');
  expect(database.port).not.toBe('');
  const pid = process.env.VERIFY_TAURI_PID!;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(pid).toBeTruthy(); expect(tool).toBeTruthy();
  async function native(command: string, ...args: string[]) {
    await exec('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 15_000 });
    const { stdout } = await exec(tool, [command, '--pid', pid, ...args, '--json'], { timeout: 30_000 });
    return decodeNativeBridgeJson(stdout, command);
  }
  const evaluate = (expression: string) => native('eval', expression);
  const wait = (expression: string) => expect.poll(() => evaluate(expression), { timeout: 60_000 }).toBe(true);
  const sql = postgres(database.toString(), { max: 1, onnotice: () => {} });
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const body = 'Native current resource. [Safe link](https://example.com/p010)\n\n'
    + '<script>window.__p010Executed=true</script><img src=x onerror="window.__p010Executed=true">\n\n'
    + '[Unsafe link](javascript:window.__p010Executed=true)';
  try {
    const report = await publishReport(sql, { workspaceId: workspace, title: 'P010 authorized native report',
      bodyMd: body, visibility: 'owner', requestKey: `p010-native-${turnId}` });
    const blocks = [{ id: 'p010-native-report', kind: 'report', title: 'Stale model title',
      sources: [{ ref: `report:${report.reportId}` }],
      actions: [{ id: 'open', kind: 'open', label: 'Open P010 report', ref: `report:${report.reportId}` }] }];
    await sql.unsafe(`INSERT INTO harness_shared.operator_conversations
      (id,workspace_id,status,started_at,subject_kind) VALUES ($1,$2,'active',$3,'global')`,
    [conversationId, workspace, Date.now() + 10_000]);
    // Real persisted history is the ingress; no network interception or component injection.
    await sql.unsafe(`INSERT INTO harness_shared.operator_turns
      (id,conversation_id,workspace_id,seq,role,text,source,created_at,chat_state)
      VALUES ($1,$2,$3,0,'assistant','Native result reply','text_typed',$4,$5::jsonb)`,
    [turnId, conversationId, workspace, Date.now(), sql.json({ schemaVersion: 1, results: blocks })]);
    const fixture = await sql.unsafe(`SELECT id,workspace_id,status,subject_kind,subject_ref,
      current_database() AS database,inet_server_port() AS port FROM harness_shared.operator_conversations
      WHERE id=$1`, [conversationId]);
    const query = `/api/zero-harness/rest-query?name=operatorConversations.current&args=${encodeURIComponent(JSON.stringify({ workspaceId: workspace }))}`;
    const current = await evaluate(`fetch(${JSON.stringify(query)}, {
      headers: {'x-papercusp-workspace': ${JSON.stringify(workspace)}}
    }).then(async response => ({status: response.status, body: await response.json(),
      url: location.href, browserWorkspace: window.__PAPERCUSP_WS__ || null}))`);
    await info.attach('p010-native-fixture-readback', { body: JSON.stringify({ fixture, current }), contentType: 'application/json' });
    expect(fixture).toMatchObject([{ id: conversationId, workspace_id: workspace, status: 'active', subject_ref: null }]);
    expect(current).toMatchObject({ status: 200, body: { rows: [{ id: conversationId, workspaceId: workspace }] } });
    // Root gateways to /adv and discards its query on native navigation.
    // Address the actual product surface so the requested chat is open.
    await native('navigate', '/adv?tab=harnesses&chat=true');
    await wait(`new URLSearchParams(location.search).get('chat') === 'true' && !!document.querySelector('[aria-label="Papercup chat"]')`);
    // Other browser journeys have already changed this rig's active global
    // conversation. Direct SQL fixtures do not emit query invalidations, and
    // native route navigation can retain the previous query-client instance.
    // Start a fresh document against the verified fixture before testing UI.
    const previousDocument = await evaluate('performance.timeOrigin');
    await evaluate('setTimeout(() => window.location.reload(), 0); true');
    await wait(`performance.timeOrigin !== ${JSON.stringify(previousDocument)} && !!document.querySelector('[aria-label="Papercup chat"]')`);
    await wait(`!!document.querySelector('[data-turn="${turnId}"]')`);
    await info.attach('p010-native-conversation-binding', { body: JSON.stringify(await evaluate(`({
      timeOrigin: performance.timeOrigin,
      turns: [...document.querySelectorAll('[data-turn]')].map(element => element.getAttribute('data-turn')),
      workspace: window.__PAPERCUSP_WS__ || null
    })`)), contentType: 'application/json' });
    const selector = '[data-result-id="p010-native-report"]';
    await wait(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes('P010 authorized native report') === true`);
    await wait(`(() => {
      const result = document.querySelector(${JSON.stringify(selector)});
      const link = result?.querySelector('a[href="https://example.com/p010"]');
      return !!result && !!link && link.target === '_blank' && link.rel.includes('noopener')
        && !result.querySelector('script,img,[onerror],a[href^="javascript:"],a[href^="data:"]')
        && window.__p010Executed !== true;
    })()`);
    await native('click', `${selector} [data-action-id="open"]`);
    await wait(`location.pathname === '/reports' && new URLSearchParams(location.search).get('sel') === ${JSON.stringify(report.reportId)}`);
    await wait(`document.querySelector('.reports-reader')?.textContent.includes('Native current resource.') === true`);
    await native('navigate', '/adv?tab=harnesses&chat=true');
    await wait(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes('P010 authorized native report') === true`);
    // Remove authority while the authorized reference is already rendered.
    await sql.unsafe('DELETE FROM harness_shared.report_library WHERE workspace_id=$1 AND report_id=$2', [workspace, report.reportId]);
    await native('click', `${selector} [data-action-id="open"]`);
    await wait(`(() => {
      const sidebar = document.querySelector('[aria-label="Papercup chat"]');
      return !!sidebar && /unavailable/i.test(sidebar.textContent ?? '') && location.pathname === '/adv';
    })()`);
    await info.attach('native-converse-result-dom', { body: JSON.stringify(await evaluate(`({
      url: location.href, text: document.querySelector('[aria-label="Papercup chat"]')?.textContent,
      executed: window.__p010Executed === true, conversationId: ${JSON.stringify(conversationId)}
    })`)), contentType: 'application/json' });
    if (process.env.VERIFY_TAURI_SOURCE_RECEIPT) await info.attach('native-converse-source', {
      body: await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT), contentType: 'application/json',
    });
    const count = await sql.unsafe('SELECT count(*)::integer AS count FROM harness_shared.operator_turns WHERE conversation_id=$1', [conversationId]);
    expect(count[0].count).toBe(1); // Opening/reloading results never dispatches another turn.
  } finally { await sql.end({ timeout: 5 }); }
});

test.afterEach(async ({}, info) => {
  const pid = process.env.VERIFY_TAURI_PID;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN;
  if (!pid || !tool) return;
  const { stdout } = await exec(tool, ['eval', '--pid', pid, `(() => {
    const capture = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const ancestors = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        ancestors.push({ tag: parent.tagName, className: parent.className,
          willChange: style.willChange, transform: style.transform, contain: style.contain });
      }
      return { html: element.outerHTML, rect: element.getBoundingClientRect().toJSON(), ancestors };
    };
    return JSON.stringify({ url: location.href, viewport: { width: innerWidth, height: innerHeight },
      chat: capture('[aria-label="Papercup chat"]'),
      reader: capture('.reports-reader'), work: capture('[data-testid="dock-fullscreen-surface"]') });
  })()`, '--json'], { timeout: 30_000 });
  // Body attachments live only in the reporter/trace buffer; successful runs
  // discard the trace. A file survives in the verifier's retained output.
  const capturePath = info.outputPath('native-fullscreen-dom.json');
  await writeFile(capturePath, String(decodeNativeBridgeJson(stdout, 'eval')), 'utf8');
  await info.attach('native-fullscreen-dom', { path: capturePath, contentType: 'application/json' });
});

test('Reports reader and individual Work panes fullscreen and restore their layout', async () => {
  test.setTimeout(240_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_SEED).toBe('ready');
  const pid = process.env.VERIFY_TAURI_PID;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN;
  if (!pid || !tool) throw new Error('Run inside the isolated native Tauri verifier');
  async function native(command: string, ...args: string[]) {
    const { stdout } = await exec(tool!, [command, '--pid', pid!, ...args, '--json'], { timeout: 30_000 });
    return decodeNativeBridgeJson(stdout, command);
  }
  const evaluate = (expression: string) => native('eval', expression);
  const click = (label: string) => native('click', `[aria-label=${JSON.stringify(label)}]`);
  const visible = (selector: string) => evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    const r = e?.getBoundingClientRect();
    return !!r && r.width > 0 && r.height > 0;
  })()`);
  const fillsViewport = (selector: string) => evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return !!r && Math.abs(r.x) < 2 && Math.abs(r.y) < 2
      && Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
  })()`);
  const wait = (probe: () => Promise<unknown>) => expect.poll(probe, { timeout: 60_000 }).toBe(true);

  await native('navigate', '/reports');
  await wait(() => visible('[aria-label="Fullscreen report reader"]'));
  await click('Fullscreen report reader');
  await wait(() => fillsViewport('.reports-reader--fullscreen'));
  await click('Restore report reader');
  await wait(() => evaluate('!document.querySelector(".reports-reader--fullscreen")'));
  // Exercise the app's Escape path inside the native WebView as well.
  await click('Fullscreen report reader');
  await wait(() => fillsViewport('.reports-reader--fullscreen'));
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await wait(() => evaluate('!document.querySelector(".reports-reader--fullscreen")'));

  await native('navigate', '/adv?tab=harnesses&slug=papercusp&scope=self&welcome=false');
  // Work titles include live counts; an untitled graph may use its panel id.
  // Bind the control to the seeded pane identity rather than its changing label.
  const panes = [
    { id: 'p-adv-work-items', name: 'Work items' },
    { id: 'p-adv-dep-graph', name: 'Dependency graph' },
    { id: 'p-adv-detail', name: 'Detail' },
  ];
  const paneButton = (id: string) => `button[data-dock-pane-id=${JSON.stringify(id)}]`;
  await wait(() => visible(paneButton(panes[0].id)));
  // The private profile starts from the default layout; retain actual geometry
  // to verify that maximize never overwrites its split ratios.
  const layout = () => evaluate(`JSON.stringify(${JSON.stringify(panes)}.map(({ id, name }) => {
    const e = document.querySelector('button[data-dock-pane-id="' + id + '"]')?.closest('.dv-groupview');
    const r = e?.getBoundingClientRect();
    return r ? [name, ...[r.x, r.y, r.width, r.height].map(Math.round)] : [name, null];
  }))`);
  const before = await layout();
  for (const [index, pane] of panes.entries()) {
    await native('click', paneButton(pane.id));
    await wait(() => fillsViewport('[data-testid="dock-fullscreen-surface"][data-fullscreen="true"]'));
    await wait(() => evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(paneButton(pane.id))})?.closest('.dv-groupview');
      const r = e?.getBoundingClientRect();
      return !!r && r.width > innerWidth - 20 && r.height > innerHeight - 60;
    })()`));
    if (index === 1) {
      await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    } else await native('click', paneButton(pane.id));
    await wait(() => evaluate(`document.querySelector(${JSON.stringify(paneButton(pane.id))})
      ?.getAttribute('aria-label')?.startsWith('Fullscreen ') === true`));
    await expect.poll(layout, { timeout: 15_000 }).toBe(before);
  }
});
