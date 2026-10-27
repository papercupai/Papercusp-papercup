import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decodeNativeBridgeJson } from './_native-bridge-json';
import { ownerQuestionButtonSelector, ownerQuestionDelivery } from '../lib/owner-question-native-contract.mts';

// Run with scripts/run-operator-e2e-isolated.sh and
// VERIFY_TAURI_ISOLATED_SEED=ready. Exercise the real owner UI and disposable
// backend, without opening the owner's inbox or requiring a human answer.
// This verifies durable delivery/answering, not a live agent's pickup.
const run = promisify(execFile);
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for isolated native question verification`);
  return value;
}
function unpack(stdout: string): Record<string, any> {
  const result = JSON.parse(stdout.trim());
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((part: { type: string }) => part.type === 'text')?.text;
  return text ? JSON.parse(text) : result;
}

test('owner questions and choices survive reopening and accept an answer in the native Inbox', async ({}, info) => {
  test.setTimeout(240_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(required('VERIFY_TAURI_SEED')).toBe('ready');
  const workspace = required('PAPERCUSP_WORKSPACE_ID');
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
  const session = required('PAPERCUSP_SID');
  const port = required('VERIFY_TAURI_PORT');
  const origin = required('VERIFY_TAURI_DEV_URL');
  const pid = required('VERIFY_TAURI_PID');
  const bridge = required('VERIFY_TAURI_AGENT_TOOLS_BIN');
  const liveness = required('VERIFY_TAURI_LIVENESS_CHECK');
  const group = required('PAPERCUSP_TEST_RUN_GROUP');
  const command = fileURLToPath(new URL('../../../scripts/mcp-call.mjs', import.meta.url));
  const evidence: Record<string, unknown> = {
    schemaVersion: 1, group, workspace, startedAt: new Date().toISOString(),
    runtime: { pid, port, origin, sourceRef: required('VERIFY_TAURI_SOURCE_REF') },
    scope: 'Native durable owner channel; no live requester pickup or independent review dispatch claim.',
  };
  async function invoke(name: string, args: Record<string, unknown>) {
    const result = await run(process.execPath, [command, name, JSON.stringify(args),
      '--client', session, '--workspace', workspace, '--harness', 'papercusp', '--port', port], {
      timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    const body = unpack(result.stdout);
    if (body.ok === false) throw new Error(`${name} refused: ${JSON.stringify(body)}`);
    return body;
  }
  async function native(name: string, ...args: string[]) {
    await run('bash', [liveness], { timeout: 10_000 });
    const result = await run(bridge, [name, '--pid', pid, ...args], {
      timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    });
    return decodeNativeBridgeJson(result.stdout, name);
  }
  const measure = (expression: string) => native('eval', expression, '--json');
  const findRow = (text: string) => `Array.from(document.querySelectorAll('[data-testid^="inbox-row-"]')).find(row => row.textContent?.includes(${JSON.stringify(text)}))`;
  async function openRow(text: string) {
    await expect.poll(() => measure(`!!(${findRow(text)})`), { timeout: 45_000 }).toBe(true);
    const selector = await measure(`(() => { const row = ${findRow(text)}; return '[data-testid=' + JSON.stringify(row.getAttribute('data-testid')) + ']'; })()`);
    await native('click', String(selector), '--json');
  }
  async function clickButton(label: string) {
    const selector = await measure(ownerQuestionButtonSelector(label));
    expect(selector, `Expanded owner question must expose ${label}`).toBeTruthy();
    await native('click', String(selector), '--json');
  }
  const prompt = `Isolated choice ${group}`;
  const question = `Isolated headless question ${group}`;
  const answer = `Recorded owner answer ${group}`;
  try {
    // Navigation is part of the fixture: never let an ambient workspace
    // selection turn a missing row into a false delivery failure.
    const inboxUrl = new URL('/adv', origin);
    inboxUrl.searchParams.set('opcv', 'inbox');
    inboxUrl.searchParams.set('ws', workspace);
    inboxUrl.searchParams.set('verify-tauri-isolated', '1');
    await native('navigate', inboxUrl.href, '--json');
    await expect.poll(async () => {
      const state = await measure(`({ workspace: window.__PAPERCUSP_WS__ || new URL(location.href).searchParams.get('ws'), origin: location.origin, url: location.href })`) as Record<string, unknown>;
      evidence.browserScope = state;
      return { workspace: state.workspace, origin: state.origin };
    }, { timeout: 30_000 }).toEqual({ workspace, origin });
    const choice = await invoke('coord:escalate', {
      severity: 'question', summary: prompt,
      body: 'Choose one of these two isolated rehearsal options.',
      options: [{ id: 'continue', label: 'Continue rehearsal' }, { id: 'pause', label: 'Pause rehearsal' }],
    });
    const ask = await invoke('coord:ask-owner', {
      question, body: 'A headless requester uses the durable owner channel.', timeout_s: 0, poll_ms: 100,
    });
    expect(ask.conversation_id).toBeTruthy();
    expect(ask.answered).toBe(false);
    evidence.opened = { choice, ask };
    // Distinguish durable delivery from UI selection. Retain this source
    // readback before any row wait, so failures name the layer that lost it.
    await expect.poll(async () => {
      const feed = await invoke('plans:attention', { harness: 'papercusp', output: 'feed', ownerAgentId: session });
      evidence.deliveryReadback = ownerQuestionDelivery(feed, choice.msg_id, ask.conversation_id);
      const delivery = evidence.deliveryReadback as ReturnType<typeof ownerQuestionDelivery>;
      return { choice: Boolean(delivery.choice), question: Boolean(delivery.question) };
    }, { timeout: 45_000 }).toEqual({ choice: true, question: true });
    await openRow(prompt);
    const choicesVisible = `(() => {
      const buttons = Array.from(document.querySelectorAll('[data-testid^="inbox-expanded-"] button')).map(el => el.textContent?.trim());
      return buttons.includes('Continue rehearsal') && buttons.includes('Pause rehearsal');
    })()`;
    await expect.poll(() => measure(choicesVisible), { timeout: 30_000 }).toBe(true);
    // Navigate away from the choice and reload: the reopened card must reconstruct
    // the same stored options, rather than depend on a transient question dialog.
    await openRow(question);
    await native('eval', 'window.__questionRehearsalOldDocument = true; location.reload(); true', '--json');
    await expect.poll(() => measure(`window.__questionRehearsalOldDocument === true`), { timeout: 30_000 }).toBe(false);
    await openRow(prompt);
    await expect.poll(() => measure(choicesVisible), { timeout: 30_000 }).toBe(true);
    evidence.reopenedChoices = true;
    await clickButton('Continue rehearsal');
    await expect.poll(() => measure(`!(${findRow(prompt)})`), { timeout: 45_000 }).toBe(true);
    // A neighbouring unresolved question must survive resolving the choice.
    await openRow(question);
    await clickButton('Answer');
    const input = '[data-testid^="inbox-expanded-"] textarea';
    await expect.poll(() => measure(`!!document.querySelector(${JSON.stringify(input)})`), { timeout: 30_000 }).toBe(true);
    await native('type', input, answer, '--json');
    await expect.poll(async () => {
      const state = await measure(`(() => {
        const input = document.querySelector(${JSON.stringify(input)});
        const submit = Array.from(document.querySelectorAll('[data-testid^="inbox-expanded-"] button')).find(button => button.textContent?.trim() === 'Submit');
        return { value: input?.value ?? null, enabled: !!submit && !submit.disabled };
      })()`);
      evidence.answerInput = state;
      return state;
    }, { timeout: 30_000 }).toEqual({ value: answer, enabled: true });
    await clickButton('Submit');
    await expect.poll(async () => {
      const result = await invoke('conversations:get', { id: ask.conversation_id });
      const conversation = result.results?.[0]?.conversation;
      evidence.answerReadback = conversation;
      return { state: conversation?.state, answer: conversation?.accepted_answer };
    }, { timeout: 45_000 }).toEqual({ state: 'resolved', answer });
    await expect.poll(() => measure(`!(${findRow(question)})`), { timeout: 45_000 }).toBe(true);
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.outcome = 'failed';
    evidence.failure = String(error);
    try {
      evidence.dom = await measure('({url:location.href,workspace:window.__PAPERCUSP_WS__ ?? null,body:document.body.innerText.slice(0,4000)})');
      evidence.registry = await measure(`(async () => ({
        http: await fetch('/api/workspaces').then(r => r.json()),
        native: window.__TAURI_INTERNALS__ ? await window.__TAURI_INTERNALS__.invoke('workspaces_list') : null
      }))()`);
    }
    catch (diagnosticError) { evidence.diagnosticError = String(diagnosticError); }
    throw error;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    const path = info.outputPath('owner-question-native-receipt.json');
    await writeFile(path, JSON.stringify(evidence, null, 2));
    await info.attach('owner-question-native-receipt', { path, contentType: 'application/json' });
  }
});
