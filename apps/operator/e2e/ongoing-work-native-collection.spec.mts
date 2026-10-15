import { test, expect, type TestInfo } from '@playwright/test';
import type { OrderedSelectionPolicy } from '../../../packages/operator-core/lib/typed-properties';
import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { isWorkOnEverything } from '../app/adv/hud/ongoing-work-draft.mts';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeNativeBridgeJson } from './_native-bridge-json';

// Native failures can happen in the initial API read before a browser is
// navigated or a cockpit screenshot exists. The default on-first-retry trace
// records nothing when this owned, expensive verifier runs without retries.
test.use({ trace: 'retain-on-failure' });

function nativeCliArgs(command: string, pid: string, args: string[], windowId?: string) {
  // PID selects the bridge. document.title can differ from the OS window title.
  if (command === 'screenshot' && !windowId) throw new Error('Screenshots require an owned native window id');
  return [command, '--pid', pid,
    ...(command === 'eval' ? ['--json'] : []),
    ...(command === 'screenshot' ? ['--selector', 'html', '--window-id', windowId!] : []), ...args];
}

async function nativeCliInvocation(command: string, pid: string, args: string[],
  display = process.env.VERIFY_TAURI_DISPLAY,
  search = async (ownedPid: string, env: NodeJS.ProcessEnv) => {
    const result = await promisify(execFile)('xdotool', ['search', '--onlyvisible', '--pid', ownedPid],
      { timeout: 10_000, env });
    return result.stdout;
  }) {
  if (command !== 'screenshot') return { args: nativeCliArgs(command, pid, args), env: process.env };
  if (!display || !/^:\d+$/.test(display)) throw new Error('Screenshots require the verifier X11 display');
  const env = { ...process.env, DISPLAY: display, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' };
  const windowIds = (await search(pid, env)).trim().split(/\s+/).filter(Boolean);
  if (windowIds.length !== 1 || !/^[1-9]\d*$/.test(windowIds[0])) {
    throw new Error(`Expected one visible window owned by native PID ${pid}; found ${windowIds.length}`);
  }
  return { args: nativeCliArgs(command, pid, args, windowIds[0]), env };
}

test('native screenshot command passes target validation without a running app', async ({}, info) => {
  const run = promisify(execFile);
  const args = nativeCliArgs('screenshot', '2147483647', ['--output', info.outputPath('absent-app.png')], '2147483647');
  const error = await run(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools', args, { timeout: 10_000 })
    .then(() => null, (value: Error & { stderr?: string; killed?: boolean }) => value);
  expect(error, 'an absent app cannot provide a screenshot').not.toBeNull();
  expect(error?.killed, 'target validation must fail before waiting on an absent bridge').not.toBe(true);
  expect(error?.message).not.toContain('Either --selector');
  expect(error?.stderr).toMatch(/pid|process|bridge|app/i);
});

test('native screenshot uses the owned window when document and OS titles differ', async () => {
  const invocation = await nativeCliInvocation('screenshot', '123', [], ':999', async (pid, env) => {
    expect(pid).toBe('123');
    expect(env.DISPLAY).toBe(':999');
    expect(env.XDG_SESSION_TYPE).toBe('x11');
    expect(env.WAYLAND_DISPLAY).toBe('');
    return '4194306\n';
  });
  // Exercise the installed CLI's actual resolver, including the failing title
  // path. An absent-app check alone cannot detect this screenshot contract.
  const run = promisify(execFile);
  const executable = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools';
  const cliPath = await realpath(executable.includes('/') ? executable : (await run('which', [executable])).stdout.trim());
  const { resolveWindowId } = await import(pathToFileURL(`${dirname(cliPath)}/commands/shared.js`).href);
  const adapter = { findWindow: async (title: string) => { throw new Error(`No window found matching: ${title}`); } };
  const bridge = { getDocumentTitle: async () => 'Papercusp Operator' };
  await expect(resolveWindowId(adapter, bridge, {})).rejects.toThrow('No window found matching: Papercusp Operator');
  const windowId = invocation.args[invocation.args.indexOf('--window-id') + 1];
  await expect(resolveWindowId(adapter, bridge, { windowId })).resolves.toBe('4194306');
});

test('native screenshot refuses missing display and absent or ambiguous owned windows', async () => {
  await expect(nativeCliInvocation('screenshot', '123', [], '')).rejects.toThrow('verifier X11 display');
  for (const windows of ['', '11\n22\n', 'invalid\n']) {
    await expect(nativeCliInvocation('screenshot', '123', [], ':999', async () => windows))
      .rejects.toThrow('Expected one visible window owned by native PID 123');
  }
  expect(() => nativeCliArgs('screenshot', '123', [])).toThrow('owned native window id');
});

test('native CLI JSON boundary preserves scalar and JSON-looking string values', () => {
  // Captured CLI output from the real HUD assertion must remain a string.
  expect(decodeNativeBridgeJson('"hud"')).toBe('hud');
  expect(decodeNativeBridgeJson('"false"')).toBe('false');
  expect(decodeNativeBridgeJson(JSON.stringify('{"value":1}'))).toBe('{"value":1}');
  expect(decodeNativeBridgeJson('false')).toBe(false);
  expect(decodeNativeBridgeJson('0')).toBe(0);
  expect(decodeNativeBridgeJson('null')).toBeNull();
  expect(decodeNativeBridgeJson('{"value":1}')).toEqual({ value: 1 });
  expect(decodeNativeBridgeJson('[1,"hud"]')).toEqual([1, 'hud']);
  expect(() => decodeNativeBridgeJson('not JSON')).toThrow();
});

test('native eval transport preserves empty and JSON-looking strings through the installed formatter', async () => {
  const run = promisify(execFile);
  const executable = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools';
  const cliPath = await realpath(executable.includes('/') ? executable : (await run('which', [executable])).stdout.trim());
  const source = (await readFile(`${dirname(cliPath)}/commands/eval.js`, 'utf8'))
    .replace(/^import .*;$/gm, '').replace('export function registerEval', 'function registerEval');
  let action!: (expression: string, opts: { json: boolean }) => Promise<void>;
  class Command {
    description() { return this; }
    argument() { return this; }
    option() { return this; }
    addHelpText() { return this; }
    action(callback: typeof action) { action = callback; return this; }
  }
  let value: unknown;
  const output: string[] = [];
  runInNewContext(`${source}\nregisterEval({ addCommand() {} });`, {
    Command, addBridgeOptions() {}, resolveBridge: async () => ({}),
    evaluateExpression: async () => ({ value }),
    console: { log: (text: string) => output.push(text) },
  });
  const args = nativeCliArgs('eval', '123', ['fixture expression']);
  for (const expected of ['', 'false', '0', '{"value":1}', 'null', 'hud', false, 0, null, [1, 'hud'], { value: 1 }]) {
    value = expected;
    output.length = 0;
    await action('fixture expression', { json: args.includes('--json') });
    expect(decodeNativeBridgeJson(output.join('\n'), 'eval')).toEqual(expected);
  }
});

test('native eval transport rejects absent or malformed result envelopes', () => {
  for (const stdout of ['', '{}', '[]', 'null', '{"value":1}', 'not JSON']) {
    expect(() => decodeNativeBridgeJson(stdout, 'eval')).toThrow();
  }
  expect(decodeNativeBridgeJson('{"result":null}', 'eval')).toBeNull();
});

async function attachNativeEvidence(info: TestInfo, name: string,
  attachment: { body: string; contentType: string }) {
  // Body-only attachments disappear when a successful trace is discarded.
  // Keep the original measurement in the retained assertion output as well.
  const file = info.outputPath(`${name}.${attachment.contentType === 'application/json' ? 'json' : 'txt'}`);
  await writeFile(file, attachment.body);
  await info.attach(name, { path: file, contentType: attachment.contentType });
}

async function runNativeActionWithFailureCapture<T>(action: () => Promise<T>,
  capture: (failure: unknown) => Promise<void>): Promise<T> {
  try {
    return await action();
  } catch (failure) {
    try {
      await capture(failure);
    } catch (captureFailure) {
      throw new AggregateError([failure, captureFailure],
        'Native action failed and its post-action evidence could not be retained');
    }
    throw failure;
  }
}

test('native action rejection captures post-action state before preserving the original error', async () => {
  const actionFailure = new Error('native click deadline after dispatch');
  let dispatched = false;
  let captured: { dispatched: boolean; failure: unknown } | undefined;

  await expect(runNativeActionWithFailureCapture(async () => {
    dispatched = true;
    throw actionFailure;
  }, async failure => {
    captured = { dispatched, failure };
  })).rejects.toBe(actionFailure);

  expect(captured).toEqual({ dispatched: true, failure: actionFailure });
});

test('native JSON evidence survives successful trace disposal', async ({}, info) => {
  const name = 'native-retained-evidence-guard';
  const evidence = { viewport: { width: 1280, height: 900 },
    rows: [{ id: 'plan-a', height: 80, visibleHeight: 80 }],
    nativeKeys: [{ key: ' ', trusted: true }] };
  const legacyName = `${name}-body-only`;
  await info.attach(legacyName, { body: JSON.stringify(evidence), contentType: 'application/json' });
  const legacy = info.attachments.find(value => value.name === legacyName);
  expect(legacy?.path).toBeUndefined();
  expect(legacy?.body?.toString('utf8')).toBe(JSON.stringify(evidence));
  await expect(readFile(info.outputPath(`${legacyName}.json`), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await attachNativeEvidence(info, name, {
    body: JSON.stringify(evidence), contentType: 'application/json',
  });
  const attachment = info.attachments.find(value => value.name === name);
  expect(attachment?.path, 'Evidence must have a file independent of retained traces').toBeTruthy();
  expect(attachment?.body).toBeUndefined();
  expect(JSON.parse(await readFile(attachment!.path!, 'utf8'))).toEqual(evidence);
  expect(JSON.parse(await readFile(info.outputPath(`${name}.json`), 'utf8'))).toEqual(evidence);
});
import { insertNativeCollectionGoal, insertNativeCollectionPlan, nativeCollectionDeclaration, setNativeCollectionPlanArchived,
  recordNativeCollectionJourney } from './_ongoing-work-native-fixture';

async function recordJourney(info: TestInfo, run: () => Promise<void>) {
  expect(process.env.VH_PHASE_DIR, 'Owned verifier assertion phase required').toBeTruthy();
  const sourceReceipt = JSON.parse(await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
  const completedRuntime = await recordNativeCollectionJourney({ sourceReceipt,
    sourceRoot: process.env.OPERATOR_SOURCE_ROOT!,
    verifierRunId: basename(dirname(dirname(process.env.VH_PHASE_DIR!))),
    testPath: 'apps/operator/e2e/ongoing-work-native-collection.spec.mts', run });
  await attachNativeEvidence(info, 'native-completed-runtime', { body: JSON.stringify({ completedRuntime,
    runtimeUnits: [`verify-tauri-headless:${process.env.VERIFY_TAURI_PID}`] }), contentType: 'application/json' });
}

function nativeCollectionDocumentReady(editor: string) {
  return `window.__nativeCollectionPreviousDocument !== true && document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(editor)}) && document.querySelector(${JSON.stringify(editor)})?.getBoundingClientRect().height > 0`;
}

function nativeWorklistKeyReceived(key: string, target: string) {
  return `window.__nativeWorklistKeys.some(e => e.key === ${JSON.stringify(key)} && e.trusted === true && e.target === ${JSON.stringify(target)})`;
}

test('native keyboard receipt rejects unidentified, untrusted and wrong-target keys', () => {
  const target = 'Move Design search reliability up';
  const window = { __nativeWorklistKeys: [{ key: 'Unidentified', trusted: true, target }] };
  const script = nativeWorklistKeyReceived('Shift', target);
  expect(runInNewContext(script, { window })).toBe(false);
  window.__nativeWorklistKeys = [{ key: 'Shift', trusted: false, target }];
  expect(runInNewContext(script, { window })).toBe(false);
  window.__nativeWorklistKeys = [{ key: 'Shift', trusted: true, target: 'Other control' }];
  expect(runInNewContext(script, { window })).toBe(false);
  window.__nativeWorklistKeys = [{ key: 'Shift', trusted: true, target }];
  expect(runInNewContext(script, { window })).toBe(true);
  expect(runInNewContext(nativeWorklistKeyReceived(' ', target), { window })).toBe(false);
  window.__nativeWorklistKeys = [{ key: ' ', trusted: true, target }];
  expect(runInNewContext(nativeWorklistKeyReceived(' ', target), { window })).toBe(true);
});

test('native reload readiness rejects a still-visible previous document', () => {
  const window: { __nativeCollectionPreviousDocument?: boolean } = { __nativeCollectionPreviousDocument: true };
  let height = 20;
  const document = { readyState: 'complete', querySelector: () => ({ getBoundingClientRect: () => ({ height }) }) };
  const script = nativeCollectionDocumentReady('[data-testid="goal-data"]');
  // The bridge acknowledges location assignment while this old editor is still
  // painted. Presence/visibility alone must never satisfy reload readiness.
  expect(runInNewContext(script, { window, document })).toBe(false);
  delete window.__nativeCollectionPreviousDocument;
  expect(runInNewContext(script, { window, document })).toBe(true);
  document.readyState = 'loading';
  expect(runInNewContext(script, { window, document })).toBe(false);
  document.readyState = 'complete';
  height = 0;
  expect(runInNewContext(script, { window, document })).toBe(false);
});

// An explicit ESM entry keeps the backend writer graph on Playwright's ESM loader.
function nativeWorklistRowGeometry(selector: string) {
  return `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    const rect = row.getBoundingClientRect();
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    const clips = [];
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (!['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) continue;
      const bounds = parent.getBoundingClientRect();
      const clipTop = bounds.top + parent.clientTop;
      const clipBottom = clipTop + parent.clientHeight;
      top = Math.max(top, clipTop); bottom = Math.min(bottom, clipBottom);
      clips.push({ className: parent.className, height: bounds.height,
        clientHeight: parent.clientHeight, overflowY: style.overflowY, flexShrink: style.flexShrink });
    }
    return { top: rect.top, bottom: rect.bottom, height: rect.height,
      visibleHeight: Math.max(0, bottom - top), clips };
  })()`;
}

test('native row geometry rejects DOM rows clipped by a shrunken table wrapper', () => {
  const wrapper = { className: 'woe__table-wrap', clientTop: 1, clientHeight: 22,
    parentElement: null, getBoundingClientRect: () => ({ top: 708, bottom: 732, height: 24 }) };
  const row = { parentElement: wrapper, getBoundingClientRect: () => ({ top: 739, bottom: 787, height: 48 }) };
  const context = { document: { querySelector: () => row }, innerHeight: 900,
    getComputedStyle: () => ({ overflowY: 'hidden', flexShrink: '1' }) };
  expect(runInNewContext(nativeWorklistRowGeometry('row'), context)).toMatchObject({ height: 48, visibleHeight: 0 });
  wrapper.clientHeight = 180;
  expect(runInNewContext(nativeWorklistRowGeometry('row'), context)).toMatchObject({ height: 48, visibleHeight: 48 });
});

async function loadNativeCollectionWriter() {
  const { default: postgres } = await import('postgres');
  const { applyGoalPropertyWrite } = await import('../../../packages/operator-core/lib/typed-properties-db');
  const { ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } = await import('../../../packages/operator-core/lib/goals/package-property-datatypes');
  const { claimNextWorkItem, releaseWorkItem } = await import('../../../packages/operator-core/lib/work-items');
  const { readGoalPortfolioBrief } = await import('../../../packages/operator-core/lib/goal-launch-settings');
  const { FLAGS } = await import('@papercusp/flags');
  const { setFlagOverridesForTest } = await import('@papercusp/flags/test');
  // These overrides belong only to this isolated fixture process. They mirror
  // the canonical claim-boundary integration suite's raw-row test route.
  const schedulerFixtureFlags = (enabled: boolean) => setFlagOverridesForTest(enabled
    ? { [FLAGS.SCHEDULER_MAINTAINED_READY]: false } : {});
  return { postgres, applyGoalPropertyWrite, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype,
    claimNextWorkItem, releaseWorkItem, readGoalPortfolioBrief, schedulerFixtureFlags };
}

// This uses the same Node loader and complete graph as the native fixture, but
// needs no browser or database. Run it before booting the costly owned rig.
test('native collection fixture writer graph loads under the Playwright Node loader', async () => {
  // With a cold Playwright transform cache this graph load measured 1.1m at load ~380
  // (WI-6554700010009809), at the edge of the default 60s budget; budget it like the other
  // cold-graph tests in this file.
  test.setTimeout(180_000);
  const singleton = await import('@papercusp/module-singleton');
  await test.info().attach('singleton-loader-exports', { body: JSON.stringify({
    keys: Object.keys(singleton), pin: typeof singleton.pinModuleState,
    node: process.version, execArgv: process.execArgv,
  }), contentType: 'application/json' });
  expect(typeof singleton.pinModuleState).toBe('function');
  const writer = await loadNativeCollectionWriter();
  for (const method of Object.values(writer)) expect(typeof method).toBe('function');
  const { runHarness, defaultEvidenceRoot } = await import('@papercusp/verification-harness');
  expect(typeof runHarness).toBe('function');
  expect(typeof defaultEvidenceRoot).toBe('function');
});

test('real Work on Everything goal exposes its saved picks in the native progress table without writes', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the maintained native rig');
  test.setTimeout(240_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).not.toBe('1');
  const workspaceId = 'papercusp-workspace';
  const goalId = 'work-on-everything-fresh-grading-and-improvement-60d3a8';
  const panel = '[data-testid="work-on-everything-console"]';
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL!, {
    max: 1, connect_timeout: 5, idle_timeout: 5,
  });
  const run = promisify(execFile), bridge = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  const native = async (command: string, ...args: string[]) => {
    await run('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 10_000 });
    const invocation = await nativeCliInvocation(command, process.env.VERIFY_TAURI_PID!, args);
    const result = await run(bridge, invocation.args, { timeout: 20_000, env: invocation.env });
    if (command === 'screenshot') return result.stdout.trim();
    return decodeNativeBridgeJson(result.stdout, command);
  };
  const measure = (expression: string) => native('eval', expression);
  const ready = (expression: string) => expect.poll(() => measure(expression), {
    timeout: 90_000, intervals: [500, 1000],
  }).toBe(true);
  try {
    await recordJourney(info, async () => {
      // The independent oracle is the saved goal, not the collection renderer.
      // This connection only performs bounded SELECTs in read-only transactions.
      const readSaved = () => sql.begin('read only', async tx => {
        const [goal] = await tx`SELECT property_schema, properties FROM harness_shared.goals
          WHERE workspace_id=${workspaceId} AND id=${goalId}`;
        expect(goal, 'The actual owner goal must exist; never seed a substitute').toBeTruthy();
        return goal;
      });
      const before = await readSaved();
      const refs = before.properties.worklist.value as string[];
      expect(refs).toHaveLength(10);
      expect(before.property_schema.worklist.collection.defaultSelected).toBe(false);
      const plans = await sql.begin('read only', tx => tx`SELECT plan_slug, title
        FROM harness_shared.harness_plans WHERE workspace_id=${workspaceId}
          AND harness_slug='papercusp' AND plan_slug=ANY(${refs.map(ref => ref.split('/').slice(1).join('/'))})`);
      const expected = refs.map(id => ({ id, label: plans.find(p => p.plan_slug === id.split('/').slice(1).join('/'))?.title }));
      expect(expected.every(row => typeof row.label === 'string')).toBe(true);
      const migration = await sql.begin('read only', tx => tx`SELECT filename, sha256
        FROM harness_shared.schema_migrations WHERE filename='1430-woe-worklist-only-picked-plans.sql'`);
      expect(migration).toHaveLength(1);
      const detailResponse = await request.get(`${process.env.VERIFY_TAURI_DEV_URL}/api/zero-harness/rest-query`, {
        params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }) },
        headers: { 'x-papercusp-workspace': workspaceId },
      });
      expect(detailResponse.ok()).toBe(true);
      const detail = (await detailResponse.json()).rows[0];
      expect(detail.goal.id).toBe(goalId);
      expect(detail.goalData.collections.worklist.selection.selected.slice().sort()).toEqual(refs.slice().sort());

      await native('navigate', `${process.env.VERIFY_TAURI_DEV_URL}/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=${workspaceId}&hudgoal=${goalId}&hudwoeedit=false&hudwoescope=all&hudwoesearch=&hudwoestate=&hudwoeempty=true`, '--json');
      await ready(`!!document.querySelector('${panel} [aria-label="Goal health"]') && !!document.querySelector('${panel} .woe__header button[aria-pressed="false"]')`);
      await measure(`(() => {
        const original = window.fetch.bind(window);
        window.__realWoeWrites = [];
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
          if (!['GET', 'HEAD'].includes(method) && new URL(url, location.href).pathname.startsWith('/api/admin/goals/')) {
            window.__realWoeWrites.push({ url, method });
            return Promise.reject(new Error('Read-only actual-goal verification refuses goal writes'));
          }
          return original(input, init);
        };
        return true;
      })()`);
      // Edit priorities changes URL view state. Do not click membership,
      // reorder, review/apply, pause or any other live mutation control.
      await native('click', `${panel} .woe__header button[aria-pressed="false"]`, '--json');
      await ready(`new URL(location.href).searchParams.get('hudwoeedit') === 'true' && document.querySelectorAll('${panel} [data-testid="ongoing-worklist-row"]').length > 0`);
      const dom = await measure(`(() => {
        const root = document.querySelector('${panel}');
        return {
          url: location.pathname + location.search,
          rows: root.querySelectorAll('[data-testid="ongoing-worklist-row"]').length,
          selected: Array.from(root.querySelectorAll('.woe__scope--in')).map(button => ({
            id: button.closest('[data-worklist-id]').dataset.worklistId,
            label: button.getAttribute('aria-label').replace(/^Remove /, ''),
          })),
          inScope: Array.from(root.querySelectorAll('[aria-label="Scope"] button')).find(b => /^In worklist/.test(b.textContent))?.textContent,
          totals: root.querySelector('[aria-label="Totals"]')?.children.length ?? 0,
          chart: root.querySelector('.woe__chart svg[role="img"]')?.getAttribute('aria-label'),
          unavailable: !!root.querySelector('.woe__unavailable'),
          pending: !!root.querySelector('[aria-label="Pending changes"]'),
          writes: window.__realWoeWrites,
        };
      })()`);
      const after = await readSaved();
      await attachNativeEvidence(info, 'real-goal-table-readback', { body: JSON.stringify({ goalId, before, expected, dom, after, migration }), contentType: 'application/json' });
      expect(dom.rows).toBeGreaterThan(0);
      expect(dom.selected.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)))
        .toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
      expect(dom.inScope).toMatch(/In worklist\s*·\s*10\s*$/);
      expect(dom.totals).toBe(6);
      expect(dom.chart).toMatch(/work items finished in the last \d+ days/);
      expect(dom.unavailable).toBe(false);
      expect(dom.pending).toBe(false);
      expect(dom.writes).toEqual([]);
      expect(after).toEqual(before);
      // Capture this owned display directly: the platform window title differs
      // between desktop builds, while DISPLAY is verifier-provenanced.
      const screenshot = info.outputPath('real-goal-progress-table.png');
      await run('import', ['-display', process.env.VERIFY_TAURI_DISPLAY!, '-window', 'root', screenshot], { timeout: 20_000 });
      await info.attach('real-goal-progress-table', { path: screenshot, contentType: 'image/png' });
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test('Work on Everything Design C cockpit and priority editor stay readable in the native viewport', async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires the maintained isolated native rig');
  await recordJourney(info, async () => {
  test.setTimeout(180_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspaceId).toMatch(/^verify-tauri-isolated-/);
  const { postgres, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } = await loadNativeCollectionWriter();
  const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL!, { max: 1, connect_timeout: 5 });
  const run = promisify(execFile), bridge = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(bridge).toBeTruthy();
  const sourceReceiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
  expect(sourceReceiptPath, 'Native acceptance must identify its immutable source').toBeTruthy();
  const sourceReceipt = JSON.parse(await readFile(sourceReceiptPath!, 'utf8'));
  async function native(command: string, ...args: string[]) {
    await run('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { timeout: 10_000 });
    const invocation = await nativeCliInvocation(command, process.env.VERIFY_TAURI_PID!, args);
    const result = await run(bridge, invocation.args, { timeout: 20_000, env: invocation.env });
    if (command === 'screenshot') return result.stdout.trim();
    return decodeNativeBridgeJson(result.stdout, command);
  }
  const measure = (expression: string) => native('eval', expression);
  let readyFailureCount = 0;
  const ready = async (expression: string) => {
    try {
      await expect.poll(() => measure(expression), { timeout: 45_000, intervals: [300, 1000] }).toBe(true);
    } catch (error) {
      const failure = ++readyFailureCount;
      try {
        const state = await measure(`({
          expression: ${JSON.stringify(expression)}, url: location.href,
          routerSearch: window.__TSR_ROUTER__?.latestLocation?.search ?? window.__TSR_ROUTER__?.state?.location?.search ?? null,
          priorityIds: Array.from(document.querySelectorAll('[data-testid="ongoing-priority-row"]')).map(n => n.dataset.worklistId),
          buttons: Array.from(document.querySelectorAll('[data-testid="work-on-everything-console"] button')).map(n => ({
            text: n.textContent, pressed: n.getAttribute('aria-pressed'), disabled: n.disabled,
          })),
          alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(n => n.textContent),
          body: document.body.innerText,
        })`);
        await attachNativeEvidence(info, `native-ready-failure-${failure}`, {
          body: JSON.stringify({ state, sourceReceipt }), contentType: 'application/json',
        });
        await native('screenshot', '--output', info.outputPath(`ready-failure-${failure}.png`));
      } catch (captureError) {
        await attachNativeEvidence(info, `native-ready-capture-error-${failure}`, {
          body: String(captureError), contentType: 'text/plain',
        });
      }
      throw error;
    }
  };
  const panel = '[data-testid="work-on-everything-console"]';
  const goalId = 'native-worklist-design';
  const ids = ['desktop', 'search', 'mobile'].map(slug => `plan:native-design/${slug}`);
  const labels = ['Design desktop release', 'Design search reliability', 'Design mobile workspace'];
  try {
    await ensureOrderedSelectionPolicyDatatype(sql, workspaceId);
    await ensurePlanRefListDatatype(sql, workspaceId);
    await insertNativeCollectionGoal(sql, { workspaceId, goalId, title: 'Work on everything · design acceptance', schema: {
      worklist: { datatype: 'plan-ref-list', editable_by: 'both', default: ids,
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: false } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: ids, included: ids.slice(0, 2), excluded: [ids[2]] } },
    } });
    // Match the real pre-package goal: its stored worklist seeds two picks,
    // while the declaration discovers all three plans. No package metadata.
    await sql`UPDATE harness_shared.goals SET properties = ${JSON.stringify({ worklist: {
      value: ids.slice(0, 2), version: 1,
    } })}::text::jsonb
      WHERE workspace_id=${workspaceId} AND id=${goalId}`;
    for (const [index, slug] of ['desktop', 'search', 'mobile'].entries()) {
      await insertNativeCollectionPlan(sql, { workspaceId, harness: 'native-design', slug,
        title: labels[index], status: 'active' });
    }
    const readback = await request.get(`${process.env.VERIFY_TAURI_DEV_URL}/api/zero-harness/rest-query`, {
      params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }) },
      headers: { 'x-papercusp-workspace': workspaceId },
    });
    expect(readback.ok()).toBe(true);
    const detail = (await readback.json()).rows[0];
    expect(detail.goal.goalPackage).toBeNull();
    expect(detail.goalData.collections.worklist.selection.configured).toBe(true);
    expect(detail.goalData.collections.worklist.selection.selected).toEqual(ids.slice(0, 2));
    expect(detail.goalData.collections.worklist.rows.map((r: { id: string }) => r.id).sort())
      .toEqual([...ids].sort());
    // insertNativeCollectionPlan seeds one real todo item per plan. Two
    // measured selected plans are not an empty or unknown progress fixture.
    expect(detail.goalData.collections.worklist.rows.filter((r: { selected: boolean }) => r.selected)
      .map((r: { counts: { todo: number; done: number } }) => ({ todo: r.counts.todo, done: r.counts.done })))
      .toEqual([{ todo: 1, done: 0 }, { todo: 1, done: 0 }]);
    expect(detail.rubricStewardship).toMatchObject({
      rubricRef: 'work-on-everything-stewardship-health', cycles: [], error: null,
    });
    await native('navigate', `${process.env.VERIFY_TAURI_DEV_URL}/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=${encodeURIComponent(workspaceId)}&hudgoal=${goalId}&hudwoesearch=Design&hudwoesort=rank`, '--json');
    await ready(`document.querySelectorAll('${panel} [data-testid="ongoing-priority-row"]').length === 2`);
    const cockpit = await measure(`(() => {
      const root = document.querySelector('${panel}');
      return {
        priorities: Array.from(root.querySelectorAll('[data-testid="ongoing-priority-row"]')).map(n => n.dataset.worklistId),
        health: !!root.querySelector('[aria-label="Goal health"]'),
        needsYou: !!root.querySelector('[aria-label="Needs you"]'),
        activity: !!root.querySelector('[aria-label="Recent activity"]'),
        progressText: root.querySelector('[aria-label="Selected plan progress"]')?.textContent,
        overflowingPanel: root.scrollWidth > root.clientWidth + 1,
        columns: getComputedStyle(root.querySelector('.woe__cockpit')).gridTemplateColumns,
        hasDraftControls: !!root.querySelector('button[aria-label^="Remove "]'),
      };
    })()`);
    // Preserve the native view and canonical readback even when an assertion
    // fails, before the owned rig tears down its temporary source and profile.
    await native('screenshot', '--output', info.outputPath('goal-cockpit.png'));
    await attachNativeEvidence(info, 'native-design-c-cockpit', {
      body: JSON.stringify({ cockpit, detail, sourceReceipt }), contentType: 'application/json',
    });
    expect(cockpit.priorities).toEqual(ids.slice(0, 2));
    expect(cockpit.health).toBe(true); expect(cockpit.needsYou).toBe(true); expect(cockpit.activity).toBe(true);
    expect(cockpit.progressText).toContain('0 of 2 items done');
    expect(cockpit.progressText).toContain('0% of measured items complete');
    expect(cockpit.progressText).toContain('2 of 2 selected plans measured');
    expect(cockpit.overflowingPanel).toBe(false);
    expect(cockpit.hasDraftControls).toBe(false);
    const browse = `${panel} .woe__priority .woe__actions button:last-child`;
    expect(await measure(`document.querySelector(${JSON.stringify(browse)})?.textContent`)).toBe('Browse all plans');
    await runNativeActionWithFailureCapture(
      () => native('click', browse, '--json'),
      async failure => {
        let state: unknown;
        let stateError: string | undefined;
        try {
          state = await measure(`({
            url: location.href,
            routerSearch: window.__TSR_ROUTER__?.latestLocation?.search ?? window.__TSR_ROUTER__?.state?.location?.search ?? null,
            browseQuery: new URL(location.href).searchParams.get('hudwoebrowse'),
            priorityIds: Array.from(document.querySelectorAll('[data-testid="ongoing-priority-row"]')).map(n => n.dataset.worklistId),
            worklistIds: Array.from(document.querySelectorAll('[data-testid="ongoing-worklist-row"]')).map(n => n.dataset.worklistId),
            buttons: Array.from(document.querySelectorAll('${panel} button')).map(n => ({
              text: n.textContent, pressed: n.getAttribute('aria-pressed'), disabled: n.disabled,
            })),
            alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(n => n.textContent),
          })`);
        } catch (error) {
          stateError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }

        const screenshotPath = info.outputPath('native-browse-action-failure.png');
        let screenshotError: string | undefined;
        try {
          await native('screenshot', '--output', screenshotPath);
          await info.attach('native-browse-action-failure-screenshot', {
            path: screenshotPath, contentType: 'image/png',
          });
        } catch (error) {
          screenshotError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        await attachNativeEvidence(info, 'native-browse-action-failure', {
          body: JSON.stringify({
            action: 'Browse all plans',
            error: failure instanceof Error
              ? { name: failure.name, message: failure.message, stack: failure.stack }
              : String(failure),
            state,
            stateError,
            screenshotError,
            sourceReceipt,
          }),
          contentType: 'application/json',
        });
      },
    );
    await ready(`new URL(location.href).searchParams.get('hudwoebrowse') === 'true'`);
    await ready(`document.querySelectorAll('${panel} [data-testid="ongoing-priority-row"]').length === 3`);
    expect(await measure(`!!document.querySelector('${panel} .woe__draft-bar')`)).toBe(false);
    await native('click', '.woe__header button[aria-pressed]', '--json');
    await ready(`document.querySelectorAll('${panel} [data-testid="ongoing-worklist-row"]').length === 3`);
    // An empty isolated goal must expose its duties without inventing measured
    // quality or a completed grading cycle. Exercise the actual native view.
    const stewardship = await measure(`(() => {
      const quality = document.querySelector('${panel} [aria-label="Rubric stewardship"]');
      return quality ? {
        duties: Array.from(quality.querySelectorAll('h4')).map(n => n.textContent),
        states: Array.from(quality.querySelectorAll('.woe__quality-duties .woe__state')).map(n => n.textContent),
        empty: quality.textContent.includes('No goal-attributed grading cycles are recorded'),
        claimsImprovement: quality.textContent.includes('Improvement verified'),
        rubricLink: quality.querySelector('a')?.getAttribute('href'),
      } : null;
    })()`);
    expect(stewardship).toEqual({
      duties: ['Maintain rubric coverage', 'Improve rubric quality', 'Grade, improve and re-grade'],
      states: ['Not measured', 'Not measured', 'Not measured'],
      empty: true, claimsImprovement: false, rubricLink: '/rubrics',
    });
    await attachNativeEvidence(info, 'native-rubric-stewardship-empty-goal', {
      body: JSON.stringify({ stewardship, reading: detail.rubricStewardship, sourceReceipt }),
      contentType: 'application/json',
    });
    const layout = await measure(`(() => {
      const root = document.querySelector('${panel}');
      return { width: innerWidth, height: innerHeight,
        headings: Array.from(root.querySelectorAll('.woe__table th')).map(n => n.textContent),
        selected: root.querySelectorAll('.woe__scope--in').length,
        unselected: root.querySelectorAll('button[aria-label^="Add "]').length,
        totals: !!root.querySelector('[role="group"][aria-label="Totals"]'),
        chart: !!root.querySelector('.woe__chart svg[role="img"]'),
        overflowingPanel: root.scrollWidth > root.clientWidth + 1,
        nextSteps: Array.from(root.querySelectorAll('.woe__table tbody tr td:last-child')).map(n => n.textContent) };
    })()`);
    const expectedWidth = Number(process.env.VERIFY_TAURI_WINDOW?.split('x')[0] ?? 1280);
    expect(layout.width).toBe(expectedWidth);
    expect(layout.overflowingPanel).toBe(false);
    expect(layout.headings).toEqual(['Worklist', 'Plan', 'Progress', 'State', 'Why / next step']);
    expect(layout.selected).toBe(2);
    expect(layout.unselected).toBe(1);
    expect(layout.totals).toBe(true);
    expect(layout.chart).toBe(true);
    for (const next of layout.nextSteps) expect(next.trim().length).toBeGreaterThan(0);
    const captureRows = async () => {
      const rows = [];
      for (const id of ids) {
        const selector = `${panel} [data-testid="ongoing-worklist-row"][data-worklist-id="${id}"]`;
        await native('eval', `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
        rows.push({ id, ...await measure(nativeWorklistRowGeometry(selector)) });
      }
      return rows;
    };
    const rowGeometry = await captureRows();
    const firstRow = `${panel} [data-testid="ongoing-worklist-row"]`;
    const table = `document.querySelector(${JSON.stringify(firstRow)}).closest('.woe__table-wrap')`;
    const originalShrink = await measure(`${table}.style.flexShrink`);
    expect(await measure(`getComputedStyle(${table}).flexShrink`)).toBe('0');
    let oldShrinkRows;
    try {
      // Restore the original CSS in the same native renderer. DOM row counts
      // still pass, while the visibility detector must catch the regression.
      await native('eval', `${table}.style.flexShrink = '1'`);
      oldShrinkRows = await captureRows();
      await native('screenshot', '--output', info.outputPath(`worklist-old-shrink-${expectedWidth}.png`));
    } finally {
      await native('eval', `${table}.style.flexShrink = ${JSON.stringify(originalShrink)}`);
    }
    await attachNativeEvidence(info, 'native-worklist-row-geometry', {
      body: JSON.stringify({ viewport: { width: layout.width, height: layout.height },
        rows: rowGeometry, oldShrinkRows, sourceReceipt }),
      contentType: 'application/json',
    });
    await native('screenshot', '--output', info.outputPath(`worklist-${expectedWidth}.png`));
    expect(oldShrinkRows.some(row => row.visibleHeight < Math.min(row.height, 32) - 1),
      'the original flex shrink clips a row despite its presence in the DOM').toBe(true);
    for (const row of rowGeometry) {
      expect(row.height, `plan ${row.id} has a rendered row`).toBeGreaterThan(0);
      expect(row.visibleHeight, `plan ${row.id} is visible beyond all clipping ancestors`)
        .toBeGreaterThanOrEqual(Math.min(row.height, 32) - 1);
    }
    // Drive an offered draft control through trusted native keyboard input.
    const toggle = 'button[aria-label="Move Design search reliability up"]';
    await native('focus', toggle, '--json');
    const xEnv = { ...process.env, DISPLAY: process.env.VERIFY_TAURI_DISPLAY! };
    expect(xEnv.DISPLAY).toMatch(/^:\d+$/);
    const windows = await run('xdotool', ['search', '--onlyvisible', '--pid', process.env.VERIFY_TAURI_PID!],
      { timeout: 10_000, env: xEnv });
    const windowIds = windows.stdout.trim().split(/\s+/);
    expect(windowIds).toHaveLength(1);
    await run('xdotool', ['windowfocus', '--sync', windowIds[0]], { timeout: 10_000, env: xEnv });
    const focused = await run('xdotool', ['getwindowfocus'], { timeout: 10_000, env: xEnv });
    expect(focused.stdout.trim(), 'Keyboard input must stay on the owned native window').toBe(windowIds[0]);
    await native('focus', toggle, '--json');
    await native('eval', `(() => {
      window.__nativeWorklistKeys = [];
      document.addEventListener('keydown', e => window.__nativeWorklistKeys.push({
        key: e.key, code: e.code, altKey: e.altKey, trusted: e.isTrusted,
        target: e.target?.getAttribute?.('aria-label'),
      }), true);
      return true;
    })()`);
    try {
      // Without --window, xdotool uses XTest delivery to the verified focus;
      // --window uses XSendEvent, which is not an equivalent WebKit input path.
      // This WebKit runtime maps F23 to a trusted Unidentified key. A neutral
      // modifier has a named DOM key and leaves the offered control unchanged.
      await run('xdotool', ['key', '--clearmodifiers', 'Shift_L'], { timeout: 10_000, env: xEnv });
      await ready(nativeWorklistKeyReceived('Shift', 'Move Design search reliability up'));
      await run('xdotool', ['key', '--clearmodifiers', 'space'], { timeout: 10_000, env: xEnv });
      await ready(nativeWorklistKeyReceived(' ', 'Move Design search reliability up'));
      await ready(`document.querySelector('${panel} [data-testid="ongoing-worklist-row"] td:nth-child(2)')?.textContent?.trim().startsWith(${JSON.stringify(labels[1])})`);
      await attachNativeEvidence(info, 'native-key-delivery-success', { body: JSON.stringify({
        keys: await measure('window.__nativeWorklistKeys'), sourceReceipt, nativeKeyboardReorder: true,
      }), contentType: 'application/json' });
    } catch (error) {
      await attachNativeEvidence(info, 'native-key-delivery', { body: JSON.stringify(await measure(`({
        keys: window.__nativeWorklistKeys, tab: new URL(location.href).searchParams.get('tab'),
        focusedControl: document.activeElement?.getAttribute('aria-label'),
        included: Array.from(document.querySelectorAll('${panel} .woe__scope--in')).map(e => e.getAttribute('aria-label')),
      })`)), contentType: 'application/json' });
      await native('screenshot', '--output', info.outputPath('keyboard-failure.png'));
      throw error;
    }
    expect(await measure(`new URL(location.href).searchParams.get('tab')`)).toBe('hud');
    await ready(`!!document.querySelector('${panel} .woe__draft-bar')`);
    await native('click', 'button[aria-label="Remove Design desktop release"]', '--json');
    await ready(`document.querySelectorAll('${panel} .woe__scope--in').length === 1`);
    await native('click', '.woe__draft-bar .pc-ctl-act--primary', '--json');
    await ready(`Array.from(document.querySelectorAll('[role="dialog"]')).some(n => n.textContent.includes('After apply'))`);
    expect((await measure(`Array.from(document.querySelectorAll('.woe__diff li')).map(n => n.textContent)`))
      .some((text: string) => text.includes(labels[1]))).toBe(true);
    await native('screenshot', '--output', info.outputPath(`review-${expectedWidth}.png`));
    await native('eval', `(() => { const button = Array.from(document.querySelectorAll('.woe__review button')).find(n => n.textContent === 'Keep editing'); button.click(); return true; })()`);
    await ready(`!document.querySelector('.woe__review')`);
    await native('eval', `(() => { const button = Array.from(document.querySelectorAll('.woe__draft-bar button')).find(n => n.textContent === 'Discard'); button.click(); return true; })()`);
    await ready(`!document.querySelector('.woe__draft-bar') && document.querySelectorAll('${panel} .woe__scope--in').length === 2`);
    const [saved] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${workspaceId} AND id=${goalId}`;
    expect(saved.properties?.worklist_policy).toBeUndefined();
    await attachNativeEvidence(info, 'native-design-layout', { body: JSON.stringify({ layout, sourceReceipt,
      nativeKeys: await measure('window.__nativeWorklistKeys'),
      fixture: { goalId, labels }, legacyWithoutPackage: true, nativeKeyboardReorder: true,
      globalHudTabRetained: true, scopeStaged: true, reviewOpened: true, discardRestored: true,
      applyClicked: false }), contentType: 'application/json' });
  } finally {
    await sql.end();
  }
  });
});

// Each declaration is an independent journey with its own unchanged deadline.
// Combining them spent 139s on plans before tea exhausted the shared 180s
// budget (EI-25643731791540466); separate cases also permit a focused re-run.
for (const kind of ['plans', 'tea'] as const) {
test(`native declared collections persist controls and reject a barrier-controlled stale save (${kind})`, async ({ request }, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Run with scripts/run-operator-e2e-isolated.sh for the owned Tauri bridge');
  await recordJourney(info, async () => {
  test.setTimeout(180_000);
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
  const adminUrl = process.env.HARNESS_ADMIN_DATABASE_URL!;
  expect(process.env.VERIFY_TAURI_ISOLATED_DB, 'Native writes require the maintained private database').toBe('1');
  expect(workspaceId).toMatch(/^verify-tauri-isolated-/);
  expect(adminUrl).toBeTruthy();
  expect(adminUrl).not.toBe(process.env.PAPERCUSP_TEST_RUNS_DB_URL);
  console.log(`WOE_NATIVE_POPULATION kind=${kind} stage=load-writer`);
  const { postgres, applyGoalPropertyWrite, ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype,
    claimNextWorkItem, releaseWorkItem, readGoalPortfolioBrief, schedulerFixtureFlags } = await test.step(
      `Load ${kind} native fixture writer`, loadNativeCollectionWriter);
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 5 });
  const run = promisify(execFile);
  const bridge = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(bridge).toBeTruthy();
  const evidence: unknown[] = [];
  async function native(command: string, ...args: string[]) {
    return test.step(`native ${command}: ${(args[0] ?? '').slice(0,100)}`, async () => {
      const invocation = await nativeCliInvocation(command, process.env.VERIFY_TAURI_PID!, args);
      const result = await run(bridge, invocation.args, { timeout: 15_000, env: invocation.env });
      if (command === 'screenshot') return result.stdout.trim();
      return decodeNativeBridgeJson(result.stdout, command);
    });
  }
  const measure = (expression: string) => native('eval', expression);
  const editor = '[data-testid="goal-data"]';
  async function ready(expression: string) {
    await expect.poll(() => measure(expression), { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(true);
  }
  async function clickControl(selector: string) {
    // The native click bridge does not provide Playwright's enabled check.
    await ready(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); return !!control && !control.disabled && control.getAttribute('aria-disabled') !== 'true'; })()`);
    await native('click', selector, '--json');
  }
  async function observeWrites() {
    await native('eval', `(() => {
      if (window.__nativeCollectionWrites) return true;
      window.__nativeCollectionWrites = [];
      const original = window.fetch;
      window.fetch = async (input, init) => {
        if (!String(input).includes('/api/admin/goals/set-property')) return original(input, init);
        const entry = { body: JSON.parse(init.body), startedAt: Date.now(), settled: false };
        window.__nativeCollectionWrites.push(entry);
        try {
          const response = await original(input, init);
          entry.status = response.status;
          entry.response = await response.clone().json();
          return response;
        } catch (error) { entry.error = String(error); throw error; }
        finally { entry.settled = true; entry.elapsedMs = Date.now() - entry.startedAt; }
      };
      return true;
    })()`);
  }
  async function clickAndSave(selector: string, expectedVersion: number) {
    const count = await measure('window.__nativeCollectionWrites.length');
    await clickControl(selector);
    await ready(`window.__nativeCollectionWrites.length === ${count + 1}`);
    await ready(`window.__nativeCollectionWrites[${count}].settled === true`);
    const receipt = await measure(`window.__nativeCollectionWrites[${count}]`);
    evidence.push({ writeReceipt: receipt });
    expect(receipt.body.expectedVersion).toBe(expectedVersion);
    expect(receipt.error).toBeUndefined();
    expect(receipt.status).toBe(200);
    expect(receipt.response.ok).toBe(true);
  }
  try {
    schedulerFixtureFlags(true);
    await ensureOrderedSelectionPolicyDatatype(sql, workspaceId);
    await ensurePlanRefListDatatype(sql, workspaceId);
    console.log(`WOE_NATIVE_POPULATION kind=${kind} stage=seed-and-controls`);
      const goalId = `native-collection-${kind}`;
      const harness = 'native-collection';
      const labels = kind === 'plans' ? ['Native alpha', 'Native beta', 'Native blocked'] : ['mint', 'chamomile', 'rooibos'];
      const ids = kind === 'plans' ? ['alpha', 'beta', 'blocked'].map((slug) => `plan:${harness}/${slug}`) : labels;
      const dormant = kind === 'plans' ? `plan:${harness}/dormant` : 'lavender';
      const { property, policyName, schema } = nativeCollectionDeclaration(kind, ids,
        { order: [ids[0], dormant], excluded: [dormant] });
      // These real records live only in the rig's verified throwaway database.
      await insertNativeCollectionGoal(sql, { workspaceId, goalId, title: `Native ${kind} collection`, schema });
      if (kind === 'plans') {
        for (const [index, slug] of ['alpha', 'beta', 'blocked'].entries()) {
          await insertNativeCollectionPlan(sql, { workspaceId, harness, slug, title: labels[index],
            status: slug === 'blocked' ? 'draft' : 'active' });
        }
        await sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,title,status,op_status)
          VALUES (${workspaceId},'native-unrelated','preserved','Unrelated preserved plan','active',NULL)`;
        // Validate admission premises before native navigation or owner writes.
        // A metadata-only seed has no canonical actionable item.
        const seeded = await readGoalPortfolioBrief({ workspaceId, goalId, sql, claimability: 'skip' });
        evidence.push({ seededAdmission: seeded?.worklist.map(plan => ({ slug: plan.slug, next: plan.next,
          state: plan.placement.state, reason: plan.placement.reconciliation.reason })) });
        expect(seeded?.worklist.find(plan => plan.slug === 'alpha')?.next?.id).toBe('P-001');
        expect(seeded?.worklist.find(plan => plan.slug === 'beta')?.next?.id).toBe('P-001');
      }
      const url = `${process.env.VERIFY_TAURI_DEV_URL}/adv?tab=hud&scope=all&hudtab=goals&welcome=0&hudgoal=${goalId}`;
      const policy = async () => {
        const [row] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${workspaceId} AND id=${goalId}`;
        return row.properties[policyName] as { value: OrderedSelectionPolicy; version: number; provenance: string } | undefined;
      };
      async function reload() {
        evidence.push({ writesBeforeNavigation: await measure('window.__nativeCollectionWrites ?? []') });
        // navigate acknowledges location assignment before the old document
        // unloads. An editor already on that document is not reload evidence.
        await native('eval', 'window.__nativeCollectionPreviousDocument = true; true');
        await native('navigate', url, '--json');
        await ready(nativeCollectionDocumentReady(editor));
        await observeWrites();
      }
      async function readback() {
        const response = await request.get(`${process.env.VERIFY_TAURI_DEV_URL}/api/zero-harness/rest-query`, {
          params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }) },
        });
        expect(response.ok()).toBe(true);
        const detail = (await response.json()).rows[0];
        expect(isWorkOnEverything(detail), 'Generic native fixture must use the generic goal-data presentation').toBe(false);
        const data = detail.goalData.collections[property];
        expect(data.selection).toMatchObject({ ok: true, configured: true, collection: { policy: policyName } });
        evidence.push({ kind, policy: await policy(), collection: data });
        return data;
      }
      const checkbox = (label: string) => `${editor} [role="checkbox"][aria-label=${JSON.stringify(`Include ${label}`)}]`;
      // Check the actual resolver declaration before spending a native readiness deadline.
      await readback();
      await reload();
      const initial = await readback();
      const initialIds: string[] = initial.rows.map((row: { id: string }) => row.id);
      // A migrated workspace also contains maintained rubric plans. Pin our
      // independently seeded controls and preserve the complete discovered
      // population through edits instead of assuming the database is empty.
      expect(initialIds.slice(0, ids.length)).toEqual(ids);
      expect(new Set(initialIds).size).toBe(initialIds.length);
      if (kind === 'plans') {
        expect(initialIds).toContain('plan:native-unrelated/preserved');
        expect(initial.rows[2].reason).toBeTruthy();
        await ready(`document.querySelector(${JSON.stringify(editor)})?.textContent.includes(${JSON.stringify(initial.rows[2].reason)}) === true`);
      } else expect(initialIds).toEqual(ids);
      const reorderedIds = [initialIds[1], initialIds[0], ...initialIds.slice(2)];
      await clickAndSave(`${editor} button[aria-label=${JSON.stringify(`Move ${labels[1]} up`)}]`, 0);
      await expect.poll(async () => (await policy())?.version).toBe(1);
      expect((await policy())?.value.order).toEqual([...reorderedIds, dormant]);
      expect((await policy())?.provenance).toBe('owner-edit');
      await reload();
      // Capture the independent HTTP snapshot before a renderer predicate can
      // time out. This distinguishes persistence/resolver failures from native
      // query-cache or renderer state using the same saved owner revision.
      const reloaded = await readback();
      const nativeReadbackUrl = `/api/zero-harness/rest-query?${new URLSearchParams({
        name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }),
      })}`;
      await native('eval', `(() => { window.__nativeCollectionReloadReadback = null;
        fetch(${JSON.stringify(nativeReadbackUrl)}).then(async response => {
          window.__nativeCollectionReloadReadback = { status: response.status, body: await response.json() };
        }).catch(error => { window.__nativeCollectionReloadReadback = { error: String(error) }; });
        return true; })()`);
      await ready('window.__nativeCollectionReloadReadback !== null');
      const nativeReadback = await measure('window.__nativeCollectionReloadReadback');
      evidence.push({ afterReorderReload: { kind, rows: reloaded.rows,
        nativeReadback,
        nativeRows: await measure(`Array.from(document.querySelectorAll(${JSON.stringify(`${editor} li`)})).map(row => row.textContent)`),
        nativeDocument: await measure('({ url: location.href, previous: window.__nativeCollectionPreviousDocument === true, ready: document.readyState })'),
      } });
      expect(reloaded.rows.map((row: { id: string }) => row.id)).toEqual(reorderedIds);
      await ready(`document.querySelector(${JSON.stringify(`${editor} li`)})?.textContent.includes(${JSON.stringify(labels[1])}) === true`);
      expect((await readback()).rows.map((row: { id: string }) => row.id)).toEqual(reorderedIds);
      if (kind === 'plans') {
        // Pick real goal-stamped rows after the ACTUAL native owner write. A
        // display-only reorder cannot change this canonical claim result.
        for (const [index, slug] of ['alpha', 'beta'].entries()) {
          await sql`INSERT INTO harness_shared.work_items
            (workspace_id,harness_slug,feature_id,item_kind,title,status,admission,goal_id,source_plan_slug,created_ts,updated_ts,payload)
            VALUES (${workspaceId},${harness},${`WI-native-${slug}`},'feature',${`Native ${slug}`},'open','admitted',
              ${goalId},${slug},${index + 1},0,'{}'::jsonb)`;
        }
        const picked = await claimNextWorkItem({ harness, assignee: 'native-policy-picker' });
        expect(picked?.id).toBe('WI-native-beta');
        evidence.push({ canonicalPickAfterNativeReorder: picked?.id });
        // Fill both eligible lanes through the canonical claim boundary. A
        // later requester must preserve those claims after the native reorder.
        const peerPick = await claimNextWorkItem({ harness, assignee: 'native-peer-holder' });
        expect(peerPick?.id).toBe('WI-native-alpha');
        const refused = await claimNextWorkItem({ harness, assignee: 'native-later-requester' });
        expect(refused).toBeNull();
        const heldRows = await sql`SELECT feature_id, taken_by FROM harness_shared.work_items
          WHERE workspace_id=${workspaceId} AND harness_slug=${harness}
            AND feature_id IN ('WI-native-alpha', 'WI-native-beta') ORDER BY feature_id`;
        expect(heldRows.map(row => ({ id: row.feature_id, assignee: row.taken_by }))).toEqual([
          { id: 'WI-native-alpha', assignee: 'native-peer-holder' },
          { id: 'WI-native-beta', assignee: 'native-policy-picker' },
        ]);
        evidence.push({ peerClaimRefusedAfterNativeReorder: refused, retainedHolders: heldRows });
        await releaseWorkItem('WI-native-alpha', { harness });
        await releaseWorkItem('WI-native-beta', { harness });
        const portfolio = await readGoalPortfolioBrief({ workspaceId, goalId, sql, claimability: 'skip' });
        evidence.push({ admissionAfterNativeReorder: portfolio?.worklist.map(plan => ({
          slug: plan.slug, state: plan.placement.state, reason: plan.placement.reconciliation.reason,
          nextCall: plan.placement.reconciliation.toolCall,
        })) });
        expect(portfolio).not.toBeNull();
        expect(portfolio!.worklist.find(plan => plan.slug === 'blocked')?.placement.reconciliation.toolCall).toBeNull();
        expect(portfolio!.worklist.find(plan => plan.slug === 'blocked')?.placement.reconciliation.reason).toMatch(/draft.*cannot launch/i);
        expect(portfolio!.worklist.find(plan => plan.placement.reconciliation.toolCall !== null)?.slug).toBe('beta');
      }
      await clickAndSave(checkbox(labels[1]), 1);
      await expect.poll(async () => (await policy())?.version).toBe(2);
      expect((await policy())?.value.excluded).toEqual([dormant, ids[1]]);
      await reload();
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[1]))})?.getAttribute('aria-checked') === 'false' && document.querySelector(${JSON.stringify(`${editor} li`)})?.textContent.includes('Excluded') === true`);
      expect((await readback()).rows.filter((row: { selected: boolean }) => row.selected).map((row: { id: string }) => row.id))
        .toEqual(initialIds.filter((id) => id !== ids[1]));
      if (kind === 'plans') {
        const picked = await claimNextWorkItem({ harness, assignee: 'native-policy-picker' });
        expect(picked?.id).toBe('WI-native-alpha');
        await releaseWorkItem('WI-native-alpha', { harness });
        // Remove beta from both source legs, then rediscover it. The stored
        // owner overlay must survive every reload and source reconciliation.
        await setNativeCollectionPlanArchived(sql, { workspaceId, harness, slug: 'beta', archived: true });
        const sourceWrite = await sql.begin(tx => applyGoalPropertyWrite(tx as unknown as typeof sql, {
          workspaceId, goalId, property, value: [ids[0], ids[2]], expectedVersion: 0,
          provenance: 'agent-edit', actorId: 'native-fixture-agent', confirmShrink: true,
        }));
        expect(sourceWrite).toMatchObject({ ok: true });
        await reload();
        expect((await readback()).rows.map((row: { id: string }) => row.id)).not.toContain(ids[1]);
        expect((await policy())?.value.excluded).toEqual([dormant, ids[1]]);
        await setNativeCollectionPlanArchived(sql, { workspaceId, harness, slug: 'beta', archived: false });
        const [reactivated] = await sql`SELECT status,op_status,archived FROM harness_shared.harness_plans
          WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`;
        evidence.push({ reactivatedLifecycle: reactivated });
        expect(reactivated).toMatchObject({ status: 'active', archived: false });
        const rediscovered = await readback();
        expect(rediscovered.rows.map((row: { id: string }) => row.id)).toEqual(reorderedIds);
        expect(rediscovered.rows.find((row: { id: string }) => row.id === ids[1])).toMatchObject({ selected: false });
        await reload();
        await expect.poll(() => measure(`(() => { const control = document.querySelector(${JSON.stringify(checkbox(labels[1]))}); return { present: !!control, checked: control?.getAttribute('aria-checked') ?? null, labels: Array.from(document.querySelectorAll(${JSON.stringify(`${editor} [role="checkbox"]`)})).map(n => n.getAttribute('aria-label')) }; })()`),
          { timeout: 30_000, intervals: [200, 500, 1000] }).toMatchObject({ present: true, checked: 'false' });
        expect((await readback()).rows.map((row: { id: string }) => row.id)).toEqual(reorderedIds);
        expect((await policy())?.version).toBe(2);
        expect((await policy())?.value.order).toEqual([...reorderedIds, dormant]);
        evidence.push({ archiveReactivateAndAgentRefresh: true, ownerPolicy: await policy() });
      }
      await clickAndSave(checkbox(labels[1]), 2);
      await expect.poll(async () => (await policy())?.version).toBe(3);
      await reload();
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[1]))})?.getAttribute('aria-checked') === 'true'`);
      // Hold the actual UI request, advance the canonical owner revision, then
      // release the original body. A synthetic 409 cannot satisfy this test.
      await native('eval', `(() => { const original = window.fetch; window.__nativeCollectionBarrier = { release: null, body: null }; window.fetch = async (input, init) => { if (String(input).includes('/api/admin/goals/set-property')) { window.__nativeCollectionBarrier.body = JSON.parse(init.body); await new Promise(resolve => { window.__nativeCollectionBarrier.release = resolve; }); } return original(input, init); }; return true; })()`);
      await clickControl(checkbox(labels[0]));
      await ready('window.__nativeCollectionBarrier?.body?.expectedVersion === 3');
      const currentPolicy = (await policy())!;
      const competing = await sql.begin((tx) => applyGoalPropertyWrite(tx as unknown as typeof sql, {
        workspaceId, goalId, property: policyName, value: currentPolicy.value,
        expectedVersion: currentPolicy.version, provenance: 'owner-edit', actorId: 'native-fixture-owner',
      }));
      expect(competing.ok).toBe(true);
      await native('eval', 'window.__nativeCollectionBarrier.release(); true');
      await ready(`document.querySelector(${JSON.stringify(`${editor} [role="alert"]`)})?.textContent.includes('stale') === true`);
      expect((await policy())?.version).toBe(4);
      expect((await policy())?.value.excluded).toEqual([dormant]);
      await ready(`document.querySelector(${JSON.stringify(checkbox(labels[0]))})?.getAttribute('aria-checked') === 'true'`);
      await readback();
      const screenshot = info.outputPath(`native-collection-${kind}.png`);
      await native('screenshot', '--output', screenshot);
      await info.attach(`native-collection-${kind}`, { path: screenshot, contentType: 'image/png' });
      // Positive subject guard precedes the deliberately missing selector.
      await expect(run(bridge, ['check', '--pid', process.env.VERIFY_TAURI_PID!, '--selector', `${editor} .native-missing-control`, '--json'], { timeout: 15_000 })).rejects.toThrow();
    console.log(`WOE_NATIVE_POPULATION kind=${kind} stage=controls-complete`);
  } finally {
    try {
      evidence.push({ finalWrites: await measure('window.__nativeCollectionWrites ?? []'),
        controls: await measure(`Array.from(document.querySelectorAll(${JSON.stringify(`${editor} [role="checkbox"]`)})).map(control => ({ label: control.getAttribute('aria-label'), disabled: control.disabled, checked: control.getAttribute('aria-checked') }))`) });
    } catch (error) { evidence.push({ writeDiagnosticsError: String(error) }); }
    const screenshot = info.outputPath('native-collection-final.png');
    try {
      await native('screenshot', '--output', screenshot);
      await info.attach('native-collection-final', { path: screenshot, contentType: 'image/png' });
    } catch (error) { evidence.push({ screenshotError: String(error) }); }
    await attachNativeEvidence(info, 'native-collection-readbacks', { body: JSON.stringify(evidence), contentType: 'application/json' });
    schedulerFixtureFlags(false);
    await sql.end({ timeout: 5 });
  }
  });
});
}
