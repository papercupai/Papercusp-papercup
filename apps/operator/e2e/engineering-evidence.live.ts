import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, expect } from './_egress';
import { readEngineeringJourneyConfig } from './_engineering-evidence-journey-config';
import { assertPlanAuditReleaseHealth } from './_plan-audit-release-config';
import type { EngineeringQueryReport } from '@papercusp/operator-core/lib/code-intelligence/engineering-evidence';
import { encodeScopedRef } from '@papercusp/operator-ui/papercup-chat/chat-ref-popup-params';
import { POSTHOG_PUBLIC_DEFAULTS } from '../../../packages/operator-core/lib/posthog-public-defaults';

// Match the existing real-workspace proof policy: configured opt-in telemetry
// has one declared origin, while the shared fixture guards every other request.
test.use({ egressAllowedOrigins: [new URL(POSTHOG_PUBLIC_DEFAULTS.host).origin] });

test('ee.current-or-shipped: exact native graph, browser references and negative controls on the pinned artifact', async ({ page, request }, info) => {
  const config = readEngineeringJourneyConfig();
  const { input } = config;
  const token = readFileSync(join(config.home, 'superuser-token'), 'utf8').trim();
  if (!token) throw new Error('Live journey authentication is unavailable.');
  const headers = { Authorization: `Bearer ${token}`, 'x-papercusp-workspace': config.workspace, 'x-papercusp-client': config.client };
  await page.context().setExtraHTTPHeaders(headers);
  const health = async () => {
    const response = await request.get(config.origin + '/api/health', { headers });
    expect(response.status()).toBe(200);
    return assertPlanAuditReleaseHealth(await response.json(), input.buildSha);
  };
  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const response = await request.post(config.origin + '/api/agent-mcp/run-tool', { headers,
      data: { name, args: { ...args, payloadTier: 'full' }, harness: input.harness, confirmed: true }, timeout: 90_000 });
    expect(response.status(), name).toBe(200);
    const envelope = await response.json(); expect(envelope.ok).toBe(true);
    let result = envelope.result;
    expect(result?.isError).not.toBe(true);
    if (result?.structuredContent) result = result.structuredContent;
    else if (Array.isArray(result?.content)) result = JSON.parse(result.content.find((block: any) => block.type === 'text')?.text ?? 'null');
    expect(result?.ok).not.toBe(false);
    return result?.data ?? result;
  }
  const before = await health();
  const promotion = config.plane === 'final-release' ? await call('release:deploy', { op: 'status' }) : null;
  if (promotion) {
    expect(promotion.gate?.green).toBe(true);
    expect(promotion.deploy?.greenPinSha).toBe(input.buildSha);
    expect(promotion.deploy?.deployedSha).toBe(input.buildSha);
    expect(promotion.gate?.lastVerdict?.logPath).toBe(input.promotionReceipt);
  }
  const runtime = config.plane === 'final-release' ? 'release-operator' : 'staging-operator';
  const sourceReceipts = [];
  for (const pin of input.sourcePins) {
    const measured = await call('dev:pipeline_position', { path: pin.path, expectedSourceSha256: pin.sha256, sourceRuntimeOnly: true });
    expect(measured.acceptedSource?.matches, pin.path).toBe(true);
    expect(measured.acceptedSource?.runtimeContainment?.[runtime], pin.path).toBe(true);
    sourceReceipts.push(measured);
  }
  const selected = await call('graph:query', { op: 'evidence', harnesses: [input.harness], file_path: input.symbol.path, name: input.symbol.name }) as EngineeringQueryReport;
  expect(selected.status).toBe('measured');
  const graph = selected.evidence!;
  expect(graph.scope.workspaceId).toBe(config.workspace);
  expect(graph.nodes.some(node => node.kind === 'item' && node.data.plan === input.plan && node.data.item === input.item)).toBe(true);
  expect(graph.nodes.some(node => node.kind === 'spec' && node.data.id === input.spec.id && node.data.revision === input.spec.revision)).toBe(true);
  const decision = graph.nodes.find(node => node.kind === 'decision' && node.data.decision === input.decisionId)!;
  expect(graph.edges.some(edge => edge.from === decision.id && edge.basis === 'decision-item-ref')).toBe(true);
  expect(graph.nodes.some(node => node.kind === 'test-case' && node.data.runId === input.runId
    && node.data.key === input.caseKey && node.data.occurrence === input.occurrence)).toBe(true);
  expect(graph.execution.scope).toBe('instrumented-boundaries-only');
  expect(graph.execution.observations).toContainEqual(expect.objectContaining({ runId: input.runId,
    invocationId: input.observation.invocationId, caseKey: input.caseKey, occurrence: input.occurrence,
    receipt: expect.objectContaining({ boundary: 'graph:query:evidence', traceId: input.observation.traceId, spanId: input.observation.spanId,
      sourceFingerprint: input.observation.sourceFingerprint, artifactFingerprint: input.observation.artifactFingerprint,
      environmentFingerprint: input.observation.environmentFingerprint }) }));

  const foreign = await call('graph:query', { op: 'evidence', harnesses: [input.harness], plan: input.plan, item: input.item,
    workspace: `${config.workspace}-unauthorized-control` });
  expect(foreign.status).toBe('unknown'); expect(foreign.evidence).toBeNull();
  const stale = await call('graph:query', { op: 'evidence', harnesses: [input.harness], ...input.stale });
  expect(stale.evidence.nodes.some((node: any) => node.state === 'stale' || node.state === 'historical')).toBe(true);
  const unobserved = await call('graph:query', { op: 'evidence', harnesses: [input.harness], ...input.unobserved });
  expect(unobserved.evidence.execution.status).toBe('unobserved');

  await page.goto(config.origin + '/plans?pdash=' + encodeURIComponent(encodeScopedRef(input.harness, input.plan)));
  await page.getByRole('button', { name: `Inspect engineering evidence for ${input.item}`, exact: true }).click();
  const panel = page.getByRole('region', { name: `Engineering evidence for ${input.item}`, exact: true });
  await expect(panel).toBeVisible();
  const specLabel = `${input.spec.id} · revision ${input.spec.revision}`;
  await panel.getByRole('button', { name: specLabel, exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Exact evidence record' })).toContainText(input.spec.id);
  await expect(panel.getByRole('region', { name: 'Exact evidence record' })).toContainText(`"revision": ${input.spec.revision}`);
  await panel.getByRole('button', { name: new RegExp('^' + input.decisionId + ' ·') }).click();
  await expect(panel.getByRole('region', { name: 'Exact evidence record' })).toContainText(input.decisionId);
  await panel.getByRole('button', { name: `${input.caseKey} · occurrence ${input.occurrence}`, exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Exact evidence record' })).toContainText(input.caseKey);
  await expect(panel).toContainText('Recorded test result');
  await expect(panel).toContainText('Observed instrumented boundary');
  await expect(panel).toContainText('Inferred relationships are not measured here');
  const after = await health(); expect(after).toBe(before);
  const receipt = { plane: config.plane, buildSha: input.buildSha, promotionReceipt: input.promotionReceipt ?? null,
    manifestSha256: createHash('sha256').update(readFileSync(config.inputsPath)).digest('hex'),
    nonce: process.env.PAPERCUSP_ENGINEERING_JOURNEY_NONCE ?? null,
    observedAt: new Date().toISOString(), before, after, promotion, selected, stale, unobserved, foreign, sourceReceipts };
  const receiptPath = info.outputPath('native-engineering-evidence-journey.json');
  mkdirSync(dirname(receiptPath), { recursive: true });
  const bytes = JSON.stringify(receipt); writeFileSync(receiptPath, bytes);
  await info.attach('native-engineering-evidence-journey', { path: receiptPath, contentType: 'application/json' });
  console.log('ENGINEERING_EVIDENCE_JOURNEY_VERIFIED ' + JSON.stringify({ plane: config.plane, buildSha: input.buildSha,
    manifestSha256: receipt.manifestSha256, nonce: receipt.nonce, receiptPath,
    receiptSha256: createHash('sha256').update(bytes).digest('hex') }));
});
