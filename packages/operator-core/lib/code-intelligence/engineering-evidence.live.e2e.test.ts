/** Live producer for P-007. The maintained Vitest reporter owns case/run rows;
 * this suite supplies only the receipt returned by the actual serving boundary.
 * Run explicitly with PAPERCUSP_ENGINEERING_PRODUCER_LIVE=1, a frozen inputs
 * file, an output path and PAPERCUSP_TEST_RUN_RECEIPT_FILE. Select
 * ee.live-boundary to produce the receipt, then ee.real- with the assembled
 * PAPERCUSP_ENGINEERING_JOURNEY_INPUTS manifest. Missing live proof fails the
 * enabled run; ordinary collection skips this opt-in live suite. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { parseExecutionBoundaryReceipt } from '@papercusp/test-config/execution-details';
import type { EngineeringQueryReport } from './engineering-evidence';
import { verifyProducerBuildIdentity } from './engineering-evidence-producer';
import { readEngineeringJourneyConfig } from '../../../../apps/operator/e2e/_engineering-evidence-journey-config';
import { readEngineeringRuntimeHealth, readEngineeringTool } from '../../../../scripts/verify-engineering-evidence-tauri.mjs';

const live = process.env.PAPERCUSP_ENGINEERING_PRODUCER_LIVE === '1';

it.skipIf(!live)('ee.live-boundary: records an actual sampled serving graph boundary under the framework case identity', async context => {
  const inputsPath = process.env.PAPERCUSP_ENGINEERING_PRODUCER_INPUTS;
  const outputPath = process.env.PAPERCUSP_ENGINEERING_PRODUCER_OUTPUT;
  expect(inputsPath, 'frozen canonical selectors are required').toBeTruthy();
  expect(outputPath, 'retain the actual response for manifest assembly').toBeTruthy();
  expect(process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE, 'the reporter must retain its insertion receipt').toBeTruthy();
  const input = JSON.parse(readFileSync(inputsPath!, 'utf8')) as {
    workspaceId: string; clientId: string; harness: string; plan: string; item: string;
    buildSha: string; origin: string; symbol: { path: string; name: string };
  };
  expect(input.workspaceId).toBe(process.env.PAPERCUSP_TEST_RUN_WORKSPACE ?? process.env.PAPERCUSP_WORKSPACE);
  expect(input.harness).toBe(process.env.PAPERCUSP_TEST_RUN_HARNESS);
  expect(input.clientId).toBe(process.env.PAPERCUSP_SID);
  expect(input.buildSha).toMatch(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
  verifyProducerBuildIdentity(input.buildSha);
  const origin = new URL(input.origin);
  expect(['http://127.0.0.1:3170', 'http://127.0.0.1:3070']).toContain(origin.origin);
  expect(origin.href).toBe(origin.origin + '/');
  const token = readFileSync(join(process.env.PAPERCUSP_HOME ?? join(homedir(), '.papercusp'), 'superuser-token'), 'utf8').trim();
  expect(token.length).toBeGreaterThan(0);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    'x-papercusp-workspace': input.workspaceId, 'x-papercusp-client': input.clientId,
    traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01` };
  const health = async () => {
    const response = await fetch(origin.origin + '/api/health', { headers, signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; service: string; sha: string; bundleStale?: unknown };
    expect(body.ok).toBe(true); expect(body.service).toBe('papercusp-operator');
    expect(body.bundleStale).toBeFalsy(); expect(body.sha).toMatch(/^[a-f0-9]{10,64}$/);
    expect(input.buildSha.startsWith(body.sha)).toBe(true);
    return body.sha;
  };
  const before = await health();
  const response = await fetch(origin.origin + '/api/agent-mcp/run-tool', { method: 'POST', headers,
    body: JSON.stringify({ name: 'graph:query', harness: input.harness, confirmed: true,
      args: { op: 'evidence', harnesses: [input.harness], file_path: input.symbol.path, name: input.symbol.name,
        payloadTier: 'full' } }),
    signal: AbortSignal.timeout(120_000) });
  expect(response.status).toBe(200);
  const envelope = await response.json() as { ok: boolean; result: unknown };
  expect(envelope.ok).toBe(true);
  let value = envelope.result;
  // Preserve the handler envelope: unwrapping its data alone drops the receipt.
  for (let depth = 0; depth < 5; depth++) {
    if (!value || typeof value !== 'object') break;
    const row = value as Record<string, unknown>;
    expect(row.isError).not.toBe(true); expect(row.ok).not.toBe(false);
    if ('boundaryObservation' in row || 'boundaryObservationGap' in row) break;
    if (row.structuredContent) { value = row.structuredContent; continue; }
    if (Array.isArray(row.content)) {
      const block = row.content.find((entry: { type?: string }) => entry.type === 'text');
      value = JSON.parse(block?.text ?? 'null'); continue;
    }
    if (row.data) { value = row.data; continue; }
    break;
  }
  const observed = value as EngineeringQueryReport & { data?: EngineeringQueryReport };
  expect(observed.boundaryObservationGap).toBeUndefined();
  const receipt = parseExecutionBoundaryReceipt(observed.boundaryObservation);
  expect(receipt, 'an actual child receipt is required, not a parent trace').toBeDefined();
  expect(receipt).toMatchObject({ boundary: 'graph:query:evidence', workspaceId: input.workspaceId,
    harness: input.harness, outcome: 'ok' });
  expect(receipt!.buildSha).toBe(before);
  expect(receipt!.traceFlags & 1).toBe(1);
  expect(receipt!.spanId).not.toBe(receipt!.parentSpanId);
  expect(receipt!.artifactFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt!.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const report = observed.data ?? observed;
  expect(report.status).toBe('measured');
  expect(report.evidence?.nodes.some(node => node.kind === 'item'
    && node.data.plan === input.plan && node.data.item === input.item)).toBe(true);
  expect(await health()).toBe(before);
  verifyProducerBuildIdentity(input.buildSha);
  context.task.meta.papercuspExecutionObservations = [receipt!];
  mkdirSync(dirname(outputPath!), { recursive: true });
  writeFileSync(outputPath!, JSON.stringify({ input, observedAt: new Date().toISOString(), before,
    after: before, receipt, report }, null, 2));
}, 180_000);

// These cases consume the actual producer receipt through the frozen journey
// manifest. Their framework identities are separate from the producing case;
// the existing owned Tauri executor still verifies the mounted product UI.
async function recordedJourney() {
  const config = readEngineeringJourneyConfig();
  expect(process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE, 'retain each framework insertion receipt').toBeTruthy();
  expect(config.workspace).toBe(process.env.PAPERCUSP_TEST_RUN_WORKSPACE ?? process.env.PAPERCUSP_WORKSPACE);
  expect(config.input.harness).toBe(process.env.PAPERCUSP_TEST_RUN_HARNESS);
  expect(config.client).toBe(config.input.clientId);
  verifyProducerBuildIdentity(config.input.buildSha);
  const health = () => readEngineeringRuntimeHealth({ origin: config.origin, buildSha: config.input.buildSha });
  const before = await health();
  const runtime = config.plane === 'final-release' ? 'release-operator' : 'staging-operator';
  for (const pin of config.input.sourcePins) {
    const measured = await readEngineeringTool(config, 'dev:pipeline_position', {
      path: pin.path, expectedSourceSha256: pin.sha256, sourceRuntimeOnly: true,
    }) as { acceptedSource?: { matches?: boolean; runtimeContainment?: Record<string, boolean> } };
    expect(measured.acceptedSource?.matches, pin.path).toBe(true);
    expect(measured.acceptedSource?.runtimeContainment?.[runtime], pin.path).toBe(true);
  }
  const query = (selectors: Record<string, unknown>) => readEngineeringTool(config, 'graph:query', {
    op: 'evidence', harnesses: [config.input.harness], ...selectors,
  }) as Promise<unknown> as Promise<EngineeringQueryReport>;
  const retain = async (scenario: string, report: EngineeringQueryReport) => {
    const after = await health();
    expect(after).toBe(before);
    verifyProducerBuildIdentity(config.input.buildSha);
    const output = process.env.PAPERCUSP_ENGINEERING_JOURNEY_OUTPUT;
    expect(output, 'retain the live scenario response in the parent-owned evidence directory').toBeTruthy();
    mkdirSync(output!, { recursive: true });
    writeFileSync(join(output!, scenario + '.json'), JSON.stringify({ scenario, plane: config.plane,
      buildSha: config.input.buildSha, observedAt: new Date().toISOString(), before, after, report }, null, 2));
  };
  return { input: config.input, workspace: config.workspace, query, retain };
}

it.skipIf(!live)('ee.real-tool: resolves the exact symbol, intent and observed case through the selected serving route', async () => {
  const { input, workspace, query, retain } = await recordedJourney();
  const report = await query({ file_path: input.symbol.path, name: input.symbol.name });
  expect(report.status).toBe('measured');
  const graph = report.evidence!;
  expect(graph.scope.workspaceId).toBe(workspace);
  expect(graph.nodes.some(node => node.kind === 'item' && node.data.plan === input.plan && node.data.item === input.item)).toBe(true);
  expect(graph.nodes.some(node => node.kind === 'spec' && node.data.id === input.spec.id && node.data.revision === input.spec.revision)).toBe(true);
  const decision = graph.nodes.find(node => node.kind === 'decision' && node.data.decision === input.decisionId);
  expect(decision).toBeDefined();
  expect(graph.edges.some(edge => edge.from === decision!.id && edge.basis === 'decision-item-ref')).toBe(true);
  expect(graph.nodes.some(node => node.kind === 'test-case' && node.data.runId === input.runId
    && node.data.key === input.caseKey && node.data.occurrence === input.occurrence)).toBe(true);
  expect(graph.execution.scope).toBe('instrumented-boundaries-only');
  expect(graph.execution.observations).toContainEqual(expect.objectContaining({ runId: input.runId,
    invocationId: input.observation.invocationId, caseKey: input.caseKey, occurrence: input.occurrence,
    receipt: expect.objectContaining({ boundary: 'graph:query:evidence', traceId: input.observation.traceId,
      spanId: input.observation.spanId, sourceFingerprint: input.observation.sourceFingerprint,
      artifactFingerprint: input.observation.artifactFingerprint, environmentFingerprint: input.observation.environmentFingerprint }) }));
  await retain('ee.real-tool', report);
}, 180_000);

it.skipIf(!live).each(['foreign-workspace', 'stale', 'unobserved'] as const)(
  'ee.real-negative: %s preserves its explicit evidence limit on the selected serving artifact', async scenario => {
    const { input, workspace, query, retain } = await recordedJourney();
    const selectors = scenario === 'foreign-workspace'
      ? { plan: input.plan, item: input.item, workspace: workspace + '-unauthorized-control' }
      : input[scenario];
    const report = await query(selectors);
    if (scenario === 'foreign-workspace') {
      expect(report.status).toBe('unknown');
      expect(report.evidence).toBeNull();
    } else {
      expect(report.status).toBe('measured');
      expect(report.evidence!.scope.workspaceId).toBe(workspace);
      if (scenario === 'stale') {
        expect(report.evidence!.nodes.some(node => node.state === 'stale' || node.state === 'historical')).toBe(true);
      } else {
        expect(report.evidence!.execution.status).toBe('unobserved');
        expect(report.evidence!.execution.observations ?? []).toEqual([]);
      }
    }
    await retain('ee.real-negative-' + scenario, report);
  }, 180_000);
