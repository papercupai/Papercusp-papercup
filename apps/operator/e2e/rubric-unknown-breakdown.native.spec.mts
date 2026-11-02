import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { decodeNativeBridgeJson } from './_native-bridge-json';

const exec = promisify(execFile);

function breakdownVisible(selector: string) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
      && rect.right <= innerWidth && rect.bottom <= innerHeight
      && !!hit && (hit === element || element.contains(hit));
  })()`;
}

async function screenshot(tool: string, pid: string, output: string, display = process.env.VERIFY_TAURI_DISPLAY) {
  // Reuse the native collection journey's process-scoped X11 targeting.
  // Document and OS titles differ; neither identifies the owned native window.
  expect(display).toMatch(/^:\d+$/);
  const env = { ...process.env, DISPLAY: display, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' };
  const { stdout } = await exec('xdotool', ['search', '--onlyvisible', '--pid', pid],
    { env, timeout: 10_000 });
  const windows = stdout.trim().split('\n').filter(Boolean);
  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatch(/^[1-9]\d*$/);
  await exec(tool, ['screenshot', '--pid', pid, '--window-id', windows[0],
    '--output', output], { env, timeout: 30_000 });
}

test('rubric screenshot captures an owned X11 window without assuming its title', async ({}, info) => {
  test.setTimeout(30_000);
  const server = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '640x480x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let window: ReturnType<typeof spawn> | undefined;
  try {
    const [number] = await once(server.stdout!, 'data', { signal: AbortSignal.timeout(10_000) });
    const display = `:${number.toString().trim()}`;
    expect(display).toMatch(/^:\d+$/);
    const env = { ...process.env, DISPLAY: display };
    window = spawn('xmessage', ['-title', 'Papercusp', '-buttons', '', 'Native rubric capture contract'],
      { env, stdio: 'ignore' });
    const pid = String(window.pid);
    let id = '';
    await expect.poll(async () => {
      const result = await exec('xdotool', ['search', '--onlyvisible', '--name', '^Papercusp$'],
        { env, timeout: 2_000 }).catch(() => ({ stdout: '' }));
      id = result.stdout.trim();
      return /^\d+$/.test(id);
    }, { timeout: 10_000 }).toBe(true);
    // Xt does not publish _NET_WM_PID; explicitly model the native app's
    // process ownership on this disposable display before exercising capture.
    await exec('xprop', ['-id', id, '-f', '_NET_WM_PID', '32c', '-set', '_NET_WM_PID', pid], { env });
    const path = info.outputPath('rubric-screenshot-contract.png');
    await screenshot(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools', pid, path, display);
    expect((await readFile(path)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await info.attach('Screenshot CLI contract fixture (not product acceptance)', { path, contentType: 'image/png' });
  } finally {
    window?.kill();
    server.kill();
  }
});

test('rubric capture rejects a count row clipped below a scroll container', async ({ page }) => {
  await page.setContent(`<div style="height:100px;overflow:auto">
    <div style="height:300px"></div>
    <p aria-label="Unknown rating breakdown">Grader incomplete: 0 · Instrument unavailable: 0.</p>
  </div>`);
  const selector = '[aria-label="Unknown rating breakdown"]';
  // Positive DOM dimensions do not establish that the screenshot contains it.
  expect(await page.evaluate(breakdownVisible(selector))).toBe(false);
  await page.locator(selector).evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  expect(await page.evaluate(breakdownVisible(selector))).toBe(true);
});

test('rubric unknown reasons match the current native trend window', async ({}, info) => {
  test.setTimeout(180_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_SEED).toBe('ready');
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['localhost', '127.0.0.1']).toContain(database.hostname);
  expect(database.port).not.toBe('5432');
  expect(database.port).not.toBe('');
  // The ready seed completes onboarding; production-authored grading-integrity
  // is not a bundled rubric. Use the same real plan-row fixture as the canonical
  // rubric integration tests, strictly inside this disposable database.
  const rubricRef = 'native-unknown-breakdown';
  const sql = postgres(database.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,
       created,updated,owner,archived,template,template_data,template_slug,origin)
      VALUES (${workspace},'papercusp',${rubricRef},'',md5(${rubricRef}),1,
        'Native unknown rating breakdown','active','2026-11-02','2026-11-02',
        'native-rubric-fixture',false,'rubric',${JSON.stringify({
          kind: 'standard', characteristic: 'native-breakdown-fixture',
          description: 'Isolated real-store fixture for the rubric trend UI.',
          ratingScale: ['pass', 'fail', 'unknown'], methodRef: null,
          criteria: [{ key: 'observed', title: 'Observed behavior', model: 'The observed behavior is correct.',
            method: 'Read the retained native result.', driftMarkers: 'The observed result differs.' }],
        })}::text::jsonb,null,'local')`;
    // Direct fixture writes do not send the production mutation's invalidation.
    // Remove only this private workspace's cached list so its real producer
    // reads the inserted rubric even if the shell warmed the empty list earlier.
    await sql`DELETE FROM harness_shared.derived_read_snapshots
      WHERE workspace_id=${workspace} AND key='rubrics.list'`;
    const fixture = await sql`SELECT plan_slug,workspace_id,template,current_database() AS database,
      inet_server_port() AS port FROM harness_shared.harness_plans
      WHERE workspace_id=${workspace} AND plan_slug=${rubricRef}`;
    expect(fixture).toMatchObject([{ plan_slug: rubricRef, workspace_id: workspace, template: 'rubric' }]);
    await writeFile(info.outputPath('rubric-fixture.json'), JSON.stringify(fixture, null, 2));
  } finally { await sql.end({ timeout: 5 }); }
  const pid = process.env.VERIFY_TAURI_PID!;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(pid).toBeTruthy();
  expect(tool).toBeTruthy();

  async function native(command: string, ...args: string[]) {
    await exec('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 15_000 });
    const { stdout } = await exec(tool, [command, '--pid', pid, ...args, '--json'], { timeout: 30_000 });
    return decodeNativeBridgeJson(stdout, command);
  }
  const evaluate = (expression: string) => native('eval', expression);
  const wait = (expression: string) => expect.poll(() => evaluate(expression), { timeout: 60_000 }).toBe(true);
  const origin = await evaluate('location.origin');
  // Rubrics lives in the maintained Learning pane; /rubrics is a retired
  // Next page and is not registered by the live SPA. Deep selection also
  // reaches an unscored rubric whose overview list starts collapsed.
  const target = new URL('/adv', origin);
  target.searchParams.set('tab', 'learning');
  target.searchParams.set('lview', 'rubrics');
  target.searchParams.set('rrubric', rubricRef);
  target.searchParams.set('ws', workspace);
  target.searchParams.set('verify-tauri-isolated', '1');
  await native('navigate', target.href);
  // Native navigation must retain the disposable workspace, as the maintained
  // owner-question journey does. A missing row alone cannot prove that scope.
  await expect.poll(async () => evaluate(`({
    workspace: window.__PAPERCUSP_WS__ || new URL(location.href).searchParams.get('ws'),
    origin: location.origin
  })`), { timeout: 30_000 }).toEqual({ workspace, origin });
  let list: { status: number; body: { rows: { rubricId: string }[] } } | undefined;
  const listPath = info.outputPath('rubric-list-precondition.json');
  try {
    // A cold derived read intentionally returns [] while its real producer
    // fills the snapshot. Wait for that convergence before judging the fixture.
    await expect.poll(async () => {
      list = await evaluate(`fetch('/api/zero-harness/rest-query?name=rubrics.list&args=%7B%7D', {
        headers: {'x-papercusp-workspace': ${JSON.stringify(workspace)}}
      }).then(async response => ({status: response.status, body: await response.json(), url: location.href}))`);
      return list?.status === 200 && list.body.rows.some(row => row.rubricId === rubricRef);
    }, { timeout: 60_000, message: 'The real rubric producer must expose the inserted fixture' }).toBe(true);
  } finally {
    await writeFile(listPath, JSON.stringify(list ?? null, null, 2));
    await info.attach('native rubric list precondition', { path: listPath, contentType: 'application/json' });
  }
  expect(list).toBeDefined();
  await wait(`!!document.querySelector('[aria-label="Rubric evidence"]')`);
  const selector = '[aria-label="Unknown rating breakdown"]';
  await wait(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-evidence') === 'window'`);

  // Read the same persisted trend through the real browser endpoint. No query,
  // component, IPC or network interception supplies the expected counts.
  const query = `/api/zero-harness/rest-query?name=rubrics.trend&args=${encodeURIComponent(JSON.stringify({ rubricRef, limit: 500 }))}`;
  const current = await evaluate(`fetch(${JSON.stringify(query)}, {
    headers: {'x-papercusp-workspace': ${JSON.stringify(workspace)}}
  }).then(async response => ({status: response.status, body: await response.json()}))`);
  expect(current.status).toBe(200);
  const breakdown = current.body.rows[0].unknownBreakdown;
  expect(Number.isInteger(breakdown.graderIncomplete)).toBe(true);
  expect(Number.isInteger(breakdown.instrumentUnavailable)).toBe(true);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', inline: 'nearest' })`);
  await wait(breakdownVisible(selector));
  const dom = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const rect = element.getBoundingClientRect();
    return {text: element.textContent, evidence: element.dataset.evidence,
      width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom,
      left: rect.left, right: rect.right, viewport: { width: innerWidth, height: innerHeight }, url: location.href,
      browserWorkspace: window.__PAPERCUSP_WS__ || null};
  })()`);
  expect(dom.text).toContain(`Grader incomplete: ${breakdown.graderIncomplete}`);
  expect(dom.text).toContain(`Instrument unavailable: ${breakdown.instrumentUnavailable}`);
  expect(dom.text).toContain('Criterion ratings in this trend window');
  expect(dom.evidence).toBe('window');
  expect(dom.width).toBeGreaterThan(0);
  expect(dom.height).toBeGreaterThan(0);
  // Ready isolated state has no grading history: zeros must be visibly measured.
  expect(breakdown.graderIncomplete).toBe(0);
  expect(breakdown.instrumentUnavailable).toBe(0);

  const receipt = info.outputPath('rubric-unknown-breakdown.json');
  const source = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
  expect(source).toBeTruthy();
  await writeFile(receipt, JSON.stringify({ current, dom, source: JSON.parse(await readFile(source!, 'utf8')) }, null, 2));
  await info.attach('native rubric unknown breakdown', { path: receipt, contentType: 'application/json' });
  const screenshotPath = info.outputPath('rubric-unknown-breakdown.png');
  await wait(breakdownVisible(selector));
  await screenshot(tool, pid, screenshotPath);
  await info.attach('native rubric unknown breakdown screenshot', { path: screenshotPath, contentType: 'image/png' });
});

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN;
  const pid = process.env.VERIFY_TAURI_PID;
  if (!tool || !pid) return;
  const captures = await Promise.allSettled([
    (async () => {
      const { stdout } = await exec(tool, ['eval', '--pid', pid, `({
        url: location.href, workspace: window.__PAPERCUSP_WS__ || null,
        body: document.body.innerText.slice(0, 5000),
        rubricRows: Array.from(document.querySelectorAll('.pc-rubrics tbody tr')).map(row => row.textContent)
      })`, '--json'], { timeout: 30_000 });
      const path = info.outputPath('rubric-failure-dom.json');
      await writeFile(path, stdout);
      await info.attach('failed native rubric DOM', { path, contentType: 'application/json' });
    })(),
    (async () => {
      const path = info.outputPath('rubric-unknown-breakdown-failure.png');
      await screenshot(tool, pid, path);
      await info.attach('failed native rubric screenshot', { path, contentType: 'image/png' });
    })(),
  ]);
  const path = info.outputPath('rubric-diagnostic-captures.json');
  await writeFile(path, JSON.stringify(captures.map(result => result.status === 'fulfilled'
    ? { status: result.status } : { status: result.status, error: String(result.reason) }), null, 2));
  await info.attach('native rubric diagnostic capture results', { path, contentType: 'application/json' });
});
