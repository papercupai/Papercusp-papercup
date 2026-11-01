// The native executor for the existing engineering-evidence composite. The
// headless wrapper owns its display/process; the webview loads the selected
// operator itself, including the exact deployed origin for final acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { readEngineeringJourneyConfig } from '../apps/operator/e2e/_engineering-evidence-journey-config.ts';
import { assertPlanAuditReleaseHealth } from '../apps/operator/e2e/_plan-audit-release-config.ts';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** Reusable before native boot and inside the journey. Keep the actual failed
 * health response so an artifact mismatch is distinguishable from an outage. */
export async function readEngineeringRuntimeHealth({ origin, buildSha }, {
  request = globalThis.fetch, retain = () => {},
} = {}) {
  const response = await request(origin + '/api/health', { signal: AbortSignal.timeout(30_000) });
  const bytes = await response.text();
  retain(response.status, bytes);
  assert.equal(response.status, 200, 'Selected engineering runtime health returned HTTP ' + response.status);
  return assertPlanAuditReleaseHealth(JSON.parse(bytes), buildSha);
}
/** Product readers use this authenticated typed route, whose structured result
 * remains complete even when the agent-context MCP preview needs truncation. */
export async function readEngineeringTool(config, name, args, {
  request = globalThis.fetch, read = readFileSync, retain = () => {},
} = {}) {
  const token = String(read(join(config.home, 'superuser-token'), 'utf8')).trim();
  assert(token, 'A tracked authenticated tool reader is required.');
  const response = await request(config.origin + '/api/agent-mcp/run-tool', {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'x-papercusp-workspace': config.workspace, 'x-papercusp-client': config.client },
    body: JSON.stringify({ name, harness: config.input.harness, confirmed: true,
      args: { ...args, payloadTier: 'full' } }),
  });
  const bytes = await response.text();
  retain(name, response.status, bytes);
  assert(response.ok, `${name} returned HTTP ${response.status}.`);
  const envelope = JSON.parse(bytes);
  assert.equal(envelope.ok, true, `${name} refused the canonical read.`);
  let value = envelope.result;
  for (let depth = 0; depth < 6; depth++) {
    assert(value && typeof value === 'object' && !Array.isArray(value), `${name} returned no canonical object.`);
    assert(value.ok !== false && !value.isError && !value._partial && !value._projection?.truncated,
      `${name} returned refused or incomplete evidence.`);
    if (value.structuredContent) { value = value.structuredContent; continue; }
    if (Array.isArray(value.content)) {
      const block = value.content.find(entry => entry.type === 'text');
      value = JSON.parse(block?.text ?? 'null'); continue;
    }
    if (value.data) { value = value.data; continue; }
    return value;
  }
  throw new Error(`${name} returned an unsupported tool envelope.`);
}
export async function verifyEngineeringTauri(env = process.env) {
  const config = readEngineeringJourneyConfig(env), { input } = config;
  assert(env.VERIFY_TAURI_PID && env.VERIFY_TAURI_AGENT_TOOLS_BIN && env.VERIFY_TAURI_POLL,
    'The engineering journey must run inside its owned Tauri verifier.');
  assert(env.PAPERCUSP_ENGINEERING_JOURNEY_NONCE, 'A fresh parent invocation nonce is required.');
  assert(env.PAPERCUSP_ENGINEERING_JOURNEY_OUTPUT, 'A parent-owned evidence directory is required.');
  const output = env.PAPERCUSP_ENGINEERING_JOURNEY_OUTPUT;
  mkdirSync(output, { recursive: true });
  const checks = [];
  let ordinal = 0;
  function child(label, command, args, options = {}) {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024, ...options });
    const id = `${++ordinal}-${label}`, stdoutPath = join(output, `${id}.stdout.log`), stderrPath = join(output, `${id}.stderr.log`);
    const stdout = String(result.stdout ?? ''), stderr = String(result.stderr ?? '');
    writeFileSync(stdoutPath, stdout); writeFileSync(stderrPath, stderr);
    const record = { label, status: result.status, signal: result.signal ?? null,
      error: result.error ? String(result.error.message) : null, stdoutPath, stderrPath,
      stdoutSha256: digest(stdout), stderrSha256: digest(stderr) };
    writeFileSync(join(output, `${id}.json`), JSON.stringify(record));
    checks.push(record);
    assert(!result.error && !result.signal && result.status === 0, `${label} did not complete; evidence=${stdoutPath}`);
    return stdout;
  }
  const bridge = (label, verb, args) => child(label, env.VERIFY_TAURI_AGENT_TOOLS_BIN,
    [verb, '--pid', env.VERIFY_TAURI_PID, ...args]);
  const check = (label, expression) => bridge(label, 'check', ['--eval', expression, '--json']);
  const wait = (label, expression) => child(label, 'bash', [env.VERIFY_TAURI_POLL,
    '--require', 'body', '--eval', expression]);
  const call = (name, args) => readEngineeringTool(config, name, args, { retain(name, status, bytes) {
    const id = `${++ordinal}-${name.replaceAll(':', '-')}`, stdoutPath = join(output, `${id}.stdout.log`);
    writeFileSync(stdoutPath, bytes);
    const record = { label: name, httpStatus: status, stdoutPath, stdoutSha256: digest(bytes) };
    writeFileSync(join(output, `${id}.json`), JSON.stringify(record)); checks.push(record);
  } });
  async function health() {
    return readEngineeringRuntimeHealth({ origin: config.origin, buildSha: input.buildSha }, {
      retain(status, bytes) {
        const id = `${++ordinal}-health`, stdoutPath = join(output, `${id}.stdout.log`);
        writeFileSync(stdoutPath, bytes);
        const record = { label: 'selected-runtime-health', httpStatus: status, stdoutPath, stdoutSha256: digest(bytes) };
        writeFileSync(join(output, `${id}.json`), JSON.stringify(record)); checks.push(record);
      },
    });
  }
  const before = await health();
  const promotion = config.plane === 'final-release' ? await call('release:deploy', { op: 'status' }) : null;
  if (promotion) {
    assert.equal(promotion.gate?.green, true);
    assert.equal(promotion.deploy?.greenPinSha, input.buildSha);
    assert.equal(promotion.deploy?.deployedSha, input.buildSha);
    assert.equal(promotion.gate?.lastVerdict?.logPath, input.promotionReceipt);
  }
  const runtime = config.plane === 'final-release' ? 'release-operator' : 'staging-operator';
  const sourceReceipts = [];
  for (const pin of input.sourcePins) {
    const measured = await call('dev:pipeline_position', { path: pin.path, expectedSourceSha256: pin.sha256, sourceRuntimeOnly: true });
    assert.equal(measured.acceptedSource?.matches, true, pin.path);
    assert.equal(measured.acceptedSource?.runtimeContainment?.[runtime], true, pin.path);
    sourceReceipts.push(measured);
  }
  const selected = await call('graph:query', { op: 'evidence', harnesses: [input.harness], file_path: input.symbol.path, name: input.symbol.name });
  assert.equal(selected.status, 'measured');
  const graph = selected.evidence;
  assert.equal(graph.scope.workspaceId, config.workspace);
  assert(graph.nodes.some(n => n.kind === 'item' && n.data.plan === input.plan && n.data.item === input.item));
  assert(graph.nodes.some(n => n.kind === 'spec' && n.data.id === input.spec.id && n.data.revision === input.spec.revision));
  const decision = graph.nodes.find(n => n.kind === 'decision' && n.data.decision === input.decisionId);
  assert(decision && graph.edges.some(e => e.from === decision.id && e.basis === 'decision-item-ref'));
  assert(graph.nodes.some(n => n.kind === 'test-case' && n.data.runId === input.runId
    && n.data.key === input.caseKey && n.data.occurrence === input.occurrence));
  assert.equal(graph.execution.scope, 'instrumented-boundaries-only');
  assert(graph.execution.observations.some(o => o.runId === input.runId && o.invocationId === input.observation.invocationId
    && o.caseKey === input.caseKey && o.occurrence === input.occurrence
    && o.receipt?.boundary === 'graph:query:evidence'
    && ['traceId', 'spanId', 'sourceFingerprint', 'artifactFingerprint', 'environmentFingerprint']
      .every(key => o.receipt[key] === input.observation[key])));
  const foreign = await call('graph:query', { op: 'evidence', harnesses: [input.harness], plan: input.plan, item: input.item,
    workspace: `${config.workspace}-unauthorized-control` });
  assert.equal(foreign.status, 'unknown'); assert.equal(foreign.evidence, null);
  const stale = await call('graph:query', { op: 'evidence', harnesses: [input.harness], ...input.stale });
  assert(stale.evidence.nodes.some(n => n.state === 'stale' || n.state === 'historical'));
  const unobserved = await call('graph:query', { op: 'evidence', harnesses: [input.harness], ...input.unobserved });
  assert.equal(unobserved.evidence.execution.status, 'unobserved');

  const url = new URL('/plans', config.origin);
  url.searchParams.set('ws', config.workspace);
  url.searchParams.set('pdash', `${input.harness}::${input.plan}`);
  bridge('navigate-selected-runtime', 'navigate', [url.href]);
  const identity = `location.origin === ${JSON.stringify(config.origin)} && !!window.__TAURI_INTERNALS__ && window.__PAPERCUSP_WS__ === ${JSON.stringify(config.workspace)}`;
  wait('selected-runtime-ready', identity);
  check('selected-runtime-identity', identity);
  const runtimeHealth = `(async () => { const response = await fetch('/api/health'); const h = await response.json();
    return response.ok && h.ok && h.service === 'papercusp-operator' && !h.bundleStale
      && typeof h.sha === 'string' && ${JSON.stringify(input.buildSha)}.startsWith(h.sha); })()`;
  check('webview-build-identity', runtimeHealth);
  const button = label => `Array.from(document.querySelectorAll('button')).find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)} || el.textContent.trim() === ${JSON.stringify(label)})`;
  const open = `Inspect engineering evidence for ${input.item}`;
  wait('evidence-action-ready', `!!(${button(open)})`);
  bridge('open-evidence', 'eval', [`${button(open)}.click()`]);
  const panel = `document.querySelector('[data-testid="plan-engineering-evidence"]')`;
  wait('evidence-panel-ready', `${panel}?.getAttribute('aria-label') === ${JSON.stringify(`Engineering evidence for ${input.item}`)}`);
  const exact = `document.querySelector('[aria-label="Exact evidence record"]')?.textContent`;
  const actions = [
    { label: `${input.spec.id} · revision ${input.spec.revision}`, expected: [input.spec.id, `"revision": ${input.spec.revision}`] },
    { prefix: `${input.decisionId} ·`, expected: [input.decisionId] },
    { label: `${input.caseKey} · occurrence ${input.occurrence}`, expected: [input.caseKey] },
  ];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const target = `Array.from(${panel}.querySelectorAll('button')).find(el => ${action.prefix
      ? `el.textContent.trim().startsWith(${JSON.stringify(action.prefix)})`
      : `el.textContent.trim() === ${JSON.stringify(action.label)}`})`;
    wait(`reference-${i}-ready`, `!!(${target})`);
    bridge(`reference-${i}-click`, 'eval', [`${target}.click()`]);
    const assertion = action.expected.map(text => `${exact}?.includes(${JSON.stringify(text)})`).join(' && ');
    wait(`reference-${i}-settled`, assertion);
    check(`reference-${i}-exact`, assertion);
  }
  check('knowledge-labels', ['Recorded test result', 'Observed instrumented boundary', 'Inferred relationships are not measured here']
    .map(text => `${panel}?.textContent.includes(${JSON.stringify(text)})`).join(' && '));
  check('final-webview-identity', identity);
  check('final-webview-build-identity', runtimeHealth);
  const after = await health(); assert.equal(after, before);
  const receipt = { driver: 'tauri-agent-tools', bridgePid: Number(env.VERIFY_TAURI_PID), webviewOrigin: config.origin,
    plane: config.plane, buildSha: input.buildSha, promotionReceipt: input.promotionReceipt ?? null,
    manifestSha256: digest(readFileSync(config.inputsPath)), nonce: env.PAPERCUSP_ENGINEERING_JOURNEY_NONCE,
    observedAt: new Date().toISOString(), before, after, promotion, selected, stale, unobserved, foreign, sourceReceipts, checks };
  const receiptPath = join(output, 'native-engineering-evidence-journey.json'), bytes = JSON.stringify(receipt);
  writeFileSync(receiptPath, bytes);
  console.log('ENGINEERING_EVIDENCE_JOURNEY_VERIFIED ' + JSON.stringify({ plane: config.plane, buildSha: input.buildSha,
    manifestSha256: receipt.manifestSha256, nonce: receipt.nonce, receiptPath, receiptSha256: digest(bytes) }));
  return receipt;
}
if (isCliEntry(import.meta.url)) {
  // The verification-harness contract (contract-lint R-10): the run is recorded under the shared
  // evidence root. A failed assertion still fails the process instead of being absorbed.
  const { defaultEvidenceRoot, runHarness } = await import('@papercusp/verification-harness');
  let thrown = null;
  await runHarness({
    contract: { name: 'engineering-evidence-tauri', phases: [{ id: 'verify' }] },
    evidenceRoot: defaultEvidenceRoot('engineering-evidence-tauri'),
    async runPhase(ctx) {
      ctx.markStep('verify-journey');
      try {
        await verifyEngineeringTauri();
        return { ok: true };
      } catch (error) {
        thrown = error;
        throw error;
      }
    },
  });
  if (thrown) throw thrown;
}
