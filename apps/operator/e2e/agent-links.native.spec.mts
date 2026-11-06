import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import postgres from 'postgres';
import { publishReport } from '../../../packages/operator-core/lib/report-library';
import { decodeNativeBridgeJson } from './_native-bridge-json';
import { recordNativeCollectionJourney } from './_ongoing-work-native-fixture';

const exec = promisify(execFile);
const TEST_PATH = 'apps/operator/e2e/agent-links.native.spec.mts';
// The instrument binder can verify the committed runner used by this spec.
const NATIVE_RUNNER = 'scripts/verify-tauri-headless.sh';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// This test never mounts a component or substitutes a router/PTY. Persisted
// history and real shell output enter through the same paths as owner traffic.
test('native agent links select exact reports from chat, cards and wrapped PTY output', async ({}, info) => {
  test.setTimeout(300_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_ISOLATED_SEED).toBe('ready');
  expect(process.env.VERIFY_TAURI_SEED).toBe('ready');
  const root = process.env.OPERATOR_SOURCE_ROOT!;
  const receiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT!;
  const phase = process.env.VH_PHASE_DIR!;
  const pid = process.env.VERIFY_TAURI_PID!;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(root).toBeTruthy(); expect(receiptPath).toBeTruthy(); expect(phase).toBeTruthy();
  expect(pid).toMatch(/^[1-9]\d*$/); expect(tool).toBeTruthy();
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
  const sourceReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  for (const path of [TEST_PATH, 'apps/operator/lib/terminal-links.ts',
    'packages/operator-ui/src/papercup-chat/remark-work-refs.ts',
    'apps/operator/app/dev/_components/TerminalTab.tsx']) {
    expect(sourceReceipt.testedInputs.some((file: { path: string }) => file.path === path), path).toBe(true);
  }
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['localhost', '127.0.0.1']).toContain(database.hostname);
  expect(database.port).not.toBe('5432'); expect(database.port).not.toBe('');
  const sql = postgres(database.toString(), { max: 1, onnotice: () => {} });
  const xenv = { ...process.env, DISPLAY: process.env.VERIFY_TAURI_DISPLAY,
    XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' };
  const observations: Array<Record<string, unknown>> = [];
  const retained: Array<{ path: string; sha256: string }> = [];
  async function native(command: string, ...args: string[]) {
    await exec('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 15_000 });
    const { stdout } = await exec(tool, [command, '--pid', pid, ...args, '--json'], { timeout: 30_000 });
    return decodeNativeBridgeJson(stdout, command);
  }
  const evaluate = (expression: string) => native('eval', expression);
  const wait = (expression: string) => expect.poll(() => evaluate(expression), { timeout: 60_000 }).toBe(true);
  const conversationId = randomUUID(), turnId = randomUUID(), reportTurnId = randomUUID();
  let windowId = '';
  async function capture(name: string) {
    const state = await evaluate(`({ url: location.href, origin: location.origin,
      workspace: window.__PAPERCUSP_WS__ || null, timeOrigin: performance.timeOrigin,
      selectedReport: new URLSearchParams(location.search).get('sel'),
      external: window.__agentLinksExternal || [],
      chat: document.querySelector('[aria-label="Papercup chat"]')?.outerHTML,
      reader: document.querySelector('.reports-reader')?.outerHTML,
      terminal: document.querySelector('.xterm')?.outerHTML })`);
    const dom = info.outputPath(`${name}.json`);
    await writeFile(dom, JSON.stringify({ state, sourceReceipt, pid, conversationId, turnId, reportTurnId }, null, 2));
    const png = info.outputPath(`${name}.png`);
    await exec(tool, ['screenshot', '--pid', pid, '--window-id', windowId, '--output', png],
      { env: xenv, timeout: 30_000 });
    for (const path of [dom, png]) retained.push({ path, sha256: sha(await readFile(path)) });
    await info.attach(name, { path: png, contentType: 'image/png' });
    observations.push({ scenario: name, state });
  }
  async function noExternalization() {
    expect(await evaluate('window.__agentLinksExternal')).toEqual([]);
  }
  async function select(href: string, reportId: string, marker: string, scenario: string) {
    await native('click', `[data-turn="${turnId}"] a[href=${JSON.stringify(href)}]`);
    const target = new URL(href, 'https://native.invalid');
    await wait(`location.pathname === '/reports'
      && new URLSearchParams(location.search).get('sel') === ${JSON.stringify(reportId)}
      && location.hash === ${JSON.stringify(target.hash)}
      && document.querySelector('.reports-reader')?.textContent.includes(${JSON.stringify(marker)}) === true`);
    for (const [key, value] of target.searchParams) {
      expect(await evaluate(`new URLSearchParams(location.search).get(${JSON.stringify(key)})`)).toBe(value);
    }
    await noExternalization(); await capture(scenario);
  }
  async function chat() {
    await native('navigate', '/adv?tab=harnesses&chat=true');
    await wait(`!!document.querySelector('[data-turn="${turnId}"]')`);
  }
  try {
    const completedRuntime = await recordNativeCollectionJourney({ sourceRoot: root, sourceReceipt,
      verifierRunId: basename(dirname(phase)), testPath: TEST_PATH, run: async () => {
        const environ = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
        expect(environ).toContain(`PAPERCUSP_SID=${process.env.VERIFY_TAURI_OWNER_SID}`);
        expect(environ).toContain(`PAPERCUSP_TAURI_LAUNCH_PROVENANCE=${process.env.VERIFY_TAURI_LAUNCH_PROVENANCE}`);
        const windows = (await exec('xdotool', ['search', '--onlyvisible', '--pid', pid],
          { env: xenv, timeout: 10_000 })).stdout.trim().split('\n');
        expect(windows).toHaveLength(1); windowId = windows[0];
        const first = await publishReport(sql, { workspaceId: workspace, title: 'Agent links native target A',
          bodyMd: 'Exact native report A marker.', visibility: 'owner', requestKey: `agent-links-a-${turnId}` });
        const second = await publishReport(sql, { workspaceId: workspace, title: 'Agent links native target B',
          bodyMd: 'Exact native report B marker.', visibility: 'owner', requestKey: `agent-links-b-${turnId}` });
        const href = `/reports?sel=${first.reportId}&view=all#details`;
        const secondHref = `/reports?sel=${second.reportId}`;
        const missing = `rpt_${randomUUID()}`;
        const text = `Native bare report ${first.reportId}\n\nNative route ${href}\n\n`
          + `Legacy route /reports/${second.reportId}\n\n`
          + `Unavailable ${missing}\n\nRejected /api/reports?sel=${first.reportId} and /reports/%2e%2e/settings`;
        const results = [{ id: 'agent-links-native-card', kind: 'report', title: 'Old model title',
          sources: [{ ref: `report:${second.reportId}` }],
          actions: [{ id: 'open', kind: 'open', label: 'Open native target B', ref: `report:${second.reportId}` }] }];
        await sql.unsafe(`INSERT INTO harness_shared.operator_conversations
          (id,workspace_id,status,started_at,subject_kind) VALUES ($1,$2,'active',$3,'global')`,
        [conversationId, workspace, Date.now() + 10_000]);
        const reportCard = { title: 'Agent links report lines', plans: [{ title: 'Native reference check',
          items: [{ text: `Report card route ${href}`, status: 'done' }] }] };
        await sql.unsafe(`INSERT INTO harness_shared.operator_turns
          (id,conversation_id,workspace_id,seq,role,text,source,created_at,chat_state)
          VALUES ($1,$2,$3,0,'assistant',$4,'text_typed',$5,$6::jsonb)`,
        [turnId, conversationId, workspace, text, Date.now(), sql.json({ schemaVersion: 1, results })]);
        await sql.unsafe(`INSERT INTO harness_shared.operator_turns
          (id,conversation_id,workspace_id,seq,role,text,source,created_at,report)
          VALUES ($1,$2,$3,1,'assistant','Report card fixture','text_typed',$4,$5::jsonb)`,
        [reportTurnId, conversationId, workspace, Date.now() + 1, sql.json(reportCard)]);
        const fixture = await sql.unsafe(`SELECT id,workspace_id,text,chat_state,current_database() AS database,
          inet_server_port() AS port FROM harness_shared.operator_turns WHERE id=$1`, [turnId]);
        expect(fixture).toMatchObject([{ id: turnId, workspace_id: workspace, text }]);
        await writeFile(info.outputPath('fixture.json'), JSON.stringify({ fixture, first, second, missing, conversationId }));
        await native('navigate', '/adv?tab=harnesses&chat=true');
        const previous = await evaluate('performance.timeOrigin');
        await evaluate('setTimeout(() => location.reload(), 0); true');
        await wait(`performance.timeOrigin !== ${previous} && !!document.querySelector('[data-turn="${turnId}"]')`);
        // Observe real external opener calls while retaining their behavior.
        await evaluate(`(() => {
          window.__agentLinksExternal = [];
          const original = window.open;
          window.open = function(...args) { window.__agentLinksExternal.push({kind:'window.open',args}); return original.apply(this,args); };
          const internals = window.__TAURI_INTERNALS__;
          if (!internals || typeof internals.invoke !== 'function') throw new Error('Native invoke bridge missing');
          const invoke = internals.invoke;
          internals.invoke = function(command, args, ...rest) {
            if (/opener|open_url|shell.*open/.test(command)) window.__agentLinksExternal.push({kind:command,args});
            return invoke.call(this, command, args, ...rest);
          };
          return true;
        })()`);
        await wait(`!!document.querySelector(${JSON.stringify(`[data-turn="${turnId}"] a[href=${JSON.stringify(href)}]`)})`);
        const routes = await evaluate(`Array.from(document.querySelectorAll('[data-turn="${turnId}"] a')).map(a => a.getAttribute('href'))`);
        expect(routes).toContain(href); expect(routes).toContain(secondHref);
        expect(routes.some((route: string) => route?.startsWith('/api/') || route?.includes('%2e'))).toBe(false);
        await select(`/reports?sel=${first.reportId}`, first.reportId, 'Exact native report A marker.', 'native-chat');
        await chat();
        await wait(`!!document.querySelector('[data-turn="${reportTurnId}"] .pc-chat__report')`);
        await native('click', `[data-turn="${reportTurnId}"] .pc-chat__report a[href=${JSON.stringify(href)}]`);
        await wait(`location.pathname === '/reports' && location.hash === '#details'
          && new URLSearchParams(location.search).get('sel') === ${JSON.stringify(first.reportId)}
          && new URLSearchParams(location.search).get('view') === 'all'
          && document.querySelector('.reports-reader')?.textContent.includes('Exact native report A marker.') === true`);
        await noExternalization(); await capture('native-report-card-lines');
        await chat();
        await native('click', '[data-result-id="agent-links-native-card"] [data-action-id="open"]');
        await wait(`location.pathname === '/reports' && new URLSearchParams(location.search).get('sel') === ${JSON.stringify(second.reportId)}
          && document.querySelector('.reports-reader')?.textContent.includes('Exact native report B marker.') === true`);
        await noExternalization(); await capture('native-report-card');
        await chat(); await select(secondHref, second.reportId, 'Exact native report B marker.', 'app-reference-route-map');
        await chat();
        await native('click', `[data-turn="${turnId}"] a[href=${JSON.stringify(`/reports?sel=${missing}`)}]`);
        await wait(`location.pathname === '/reports' && new URLSearchParams(location.search).get('sel') === ${JSON.stringify(missing)}
          && /unavailable|not found|no report/i.test(document.querySelector('.reports-reader')?.textContent ?? '')`);
        await noExternalization(); await capture('unavailable-reader-policy');

        await native('navigate', '/dev?tab=terminal');
        await wait(`!!document.querySelector('.xterm-rows') && /status:.*live/s.test(document.body.textContent)`);
        // Resize the actual native window, then type into its real PTY. The
        // long query guarantees the target crosses at least one cell row.
        await exec('xdotool', ['windowsize', '--sync', windowId, '720', '720'], { env: xenv, timeout: 15_000 });
        await native('click', '.xterm-screen');
        const terminalHref = `/reports?sel=${first.reportId}&probe=${'w'.repeat(160)}#wrapped`;
        const output = `\x1b[2J\x1b[HAGENT_LINK_NATIVE ${terminalHref}\r\n`;
        const command = `printf %s '${Buffer.from(output).toString('base64')}' | base64 -d`;
        await exec('xdotool', ['type', '--clearmodifiers', '--delay', '1', command], { env: xenv, timeout: 15_000 });
        await exec('xdotool', ['key', '--clearmodifiers', 'Return'], { env: xenv, timeout: 15_000 });
        await wait(`document.querySelector('.xterm-rows')?.textContent.includes('AGENT_LINK_NATIVE /reports?sel=') === true`);
        const point = await evaluate(`(() => {
          const rows = [...document.querySelectorAll('.xterm-rows > div')];
          const row = rows.find(element => element.textContent.startsWith('AGENT_LINK_NATIVE '));
          if (!row) throw new Error('Actual PTY output row absent');
          const next = rows[rows.indexOf(row) + 1];
          if (!next?.textContent.includes('w')) throw new Error('Reference did not wrap across physical rows');
          const walker = document.createTreeWalker(next, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode, index = node.textContent.indexOf('w');
            if (index < 0) continue;
            const range = document.createRange(); range.setStart(node,index); range.setEnd(node,index+1);
            const r = range.getBoundingClientRect();
            return { x: r.x+r.width/2, y: r.y+r.height/2, row: row.textContent, continuation: next.textContent };
          }
          throw new Error('Wrapped reference cell absent');
        })()`);
        expect(point.x).toBeGreaterThan(0); expect(point.y).toBeGreaterThan(0);
        await capture('native-terminal-wrapped-before');
        // XTest delivers an actual pointer event through the WebView/xterm
        // hit-test path, including asynchronous link-provider hover discovery.
        const geometry = (await exec('xwininfo', ['-id', windowId], { env: xenv })).stdout;
        const ox = Number(/Absolute upper-left X:\s*(-?\d+)/.exec(geometry)?.[1]);
        const oy = Number(/Absolute upper-left Y:\s*(-?\d+)/.exec(geometry)?.[1]);
        expect(Number.isFinite(ox) && Number.isFinite(oy)).toBe(true);
        await exec('xdotool', ['mousemove', '--sync', String(Math.round(ox + point.x)), String(Math.round(oy + point.y))], { env: xenv });
        await wait(`getComputedStyle(document.querySelector('.xterm-screen')).cursor === 'pointer'
          || document.querySelector('.xterm')?.classList.contains('xterm-cursor-pointer') === true`);
        await exec('xdotool', ['click', '1'], { env: xenv });
        await wait(`location.pathname === '/reports' && location.hash === '#wrapped'
          && new URLSearchParams(location.search).get('sel') === ${JSON.stringify(first.reportId)}
          && new URLSearchParams(location.search).get('probe') === ${JSON.stringify('w'.repeat(160))}
          && document.querySelector('.reports-reader')?.textContent.includes('Exact native report A marker.') === true`);
        await noExternalization(); await capture('native-terminal-wrapped');
        expect((await sql.unsafe('SELECT count(*)::integer AS count FROM harness_shared.operator_turns WHERE conversation_id=$1', [conversationId]))[0].count).toBe(2);
      } });
    const proof = { sourceReceipt, completedRuntime, runtimeUnits: [`verify-tauri-headless:${pid}`],
      fixture: { workspace, conversationId, turnId, reportTurnId, database: database.pathname, port: database.port },
      runner: NATIVE_RUNNER, observations, retained, pid, launchProvenance: process.env.VERIFY_TAURI_LAUNCH_PROVENANCE };
    const proofPath = info.outputPath('native-agent-links-proof.json');
    await writeFile(proofPath, JSON.stringify(proof, null, 2));
    await info.attach('native-completed-runtime', { body: JSON.stringify({ completedRuntime,
      runtimeUnits: proof.runtimeUnits }), contentType: 'application/json' });
    await info.attach('native-agent-links-proof', { path: proofPath, contentType: 'application/json' });
    // Keep a stable retained path for the operational importer after rig cleanup.
    await writeFile(join(phase, 'native-agent-links-proof.json'), JSON.stringify(proof, null, 2));
  } finally {
    if (windowId) await capture('native-final-state').catch(() => {});
    await sql.end({ timeout: 5 });
  }
});
