import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './_egress';
import { assertPlanAuditReleaseHealth } from './_plan-audit-release-config';
import { encodeScopedRef } from '@papercusp/operator-ui/papercup-chat/chat-ref-popup-params';
import { POSTHOG_PUBLIC_DEFAULTS } from '../../../packages/operator-core/lib/posthog-public-defaults';

// Real-workspace proof retains its configured opt-in telemetry. Declare that
// reviewed origin explicitly; the shared fixture still rejects other origins.
test.use({ egressAllowedOrigins: [new URL(POSTHOG_PUBLIC_DEFAULTS.host).origin] });

// This controlled response seam exercises the actual mounted app and its shared
// primitives. It supplies no canonical graph or execution proof for P-007.
test('ee.shared-controls: real-app checkbox and evidence-repair input states', async ({ page, request }, info) => {
  const origin = new URL(process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3170');
  const buildSha = process.env.PAPERCUSP_ENGINEERING_CONTROLS_BUILD_SHA ?? '';
  const sourceSha256 = process.env.PAPERCUSP_ENGINEERING_CONTROLS_SOURCE_SHA256 ?? '';
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  const client = process.env.PAPERCUSP_SID;
  if (origin.origin !== 'http://127.0.0.1:3170' || !/^[a-f0-9]{40}$/.test(buildSha)
    || !/^[a-f0-9]{64}$/.test(sourceSha256) || !workspace || !client)
    throw new Error('Shared-control capture requires the maintained current build, source pin and session scope.');
  const token = readFileSync(join(process.env.PAPERCUSP_HOME ?? join(homedir(), '.papercusp'), 'superuser-token'), 'utf8').trim();
  const headers = { Authorization: `Bearer ${token}`, 'x-papercusp-workspace': workspace, 'x-papercusp-client': client };
  await page.context().setExtraHTTPHeaders(headers);
  const health = async () => {
    const response = await request.get(origin.origin + '/api/health', { headers, timeout: 90_000 })
      .catch(() => { throw new Error('Authenticated health read failed.'); });
    expect(response.status()).toBe(200);
    return assertPlanAuditReleaseHealth(await response.json(), buildSha);
  };
  const before = await health();
  const sourceResponse = await request.post(origin.origin + '/api/agent-mcp/run-tool', { headers, timeout: 90_000, data: {
    name: 'dev:pipeline_position', harness: 'papercusp', confirmed: true,
    args: { path: 'apps/operator/app/_components/plans/PlanEngineeringEvidence.tsx',
      expectedSourceSha256: sourceSha256, sourceRuntimeOnly: true },
  } }).catch(() => { throw new Error('Authenticated source-containment read failed.'); });
  expect(sourceResponse.status()).toBe(200);
  const sourceEnvelope = await sourceResponse.json();
  expect(sourceEnvelope.ok).toBe(true);
  const sourceResult = sourceEnvelope.result?.structuredContent ?? JSON.parse(
    sourceEnvelope.result?.content?.find((block: any) => block.type === 'text')?.text ?? 'null');
  const source = sourceResult?.data ?? sourceResult;
  expect(source?.acceptedSource?.matches).toBe(true);
  expect(source?.acceptedSource?.runtimeContainment?.['staging-operator']).toBe(true);

  const plan = 'native-engineering-evidence-graph-2026-10-23', item = 'P-006', spec = 'UI-CONTROL-ONLY';
  const graphCalls: Record<string, any>[] = [], bindings: Record<string, any>[] = [];
  let releaseBind: (() => void) | undefined;
  const bindGate = new Promise<void>(resolve => { releaseBind = resolve; });
  await page.route('**/api/agent-mcp/run-tool', async route => {
    const call = route.request().postDataJSON();
    if (call.name === 'graph:query' && call.args?.op === 'evidence' && call.args.plan === plan && call.args.item === item) {
      graphCalls.push(call);
      await route.fulfill({ json: { ok: true, result: { structuredContent: { status: 'measured', evidence: {
        scope: { workspaceId: workspace, harness: 'papercusp' }, nodes: [], edges: [], truncated: false,
        execution: { status: 'unobserved', reason: 'Controlled UI responses do not measure execution.' },
        gaps: [{ code: 'no-visible-proof', at: { tool: 'plans:get-specs',
          args: { slug: plan, specIds: [spec], revision: 2 } } }],
      } } } } });
    } else if (call.name === 'plans:bind-spec-evidence') {
      bindings.push(call);
      await bindGate;
      await route.fulfill({ json: { ok: true, result: { structuredContent: { ok: true } } } });
    } else await route.continue();
  });
  // Navigation completes before the live sync feed hydrates. Wait for its
  // actual response before asserting virtualizer geometry or rendered rows.
  const planFeed = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/zero-harness/rest-query' && url.searchParams.get('name') === 'plans.list';
  }, { timeout: 90_000 });
  await page.goto(origin.origin + '/plans?pdash=' + encodeURIComponent(encodeScopedRef('papercusp', plan)));
  const hydratedPlans = await planFeed;
  expect(hydratedPlans.status()).toBe(200);
  expect((await hydratedPlans.json()).rows.length).toBeGreaterThan(0);
  // Exercise the standalone route: portalEmbed must not be needed to bound the
  // canonical virtualizer. A content-sized list used to mount the whole roster
  // and delay the dashboard's first actionable render (EI-26802306660063941).
  const list = page.locator('.plans-pane__list');
  await expect(list.locator('[data-index]').first()).toBeVisible();
  const geometry = await list.evaluate(element => ({
    height: element.clientHeight, viewport: window.innerHeight,
    content: element.scrollHeight, mounted: element.querySelectorAll('[data-index]').length,
  }));
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.height).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.content).toBeGreaterThan(geometry.height);
  expect(geometry.mounted).toBeLessThan(80);
  const lastIndex = Number(await page.getByTestId('plans-pane-count-value').innerText()) - 1;
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => list.locator('[data-index]').first().getAttribute('data-index')).not.toBe('0');
  await expect(list.locator(`[data-index="${lastIndex}"]`)).toBeVisible();
  await list.evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByRole('button', { name: `Inspect engineering evidence for ${item}`, exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: `Inspect engineering evidence for ${item}`, exact: true }).click();
  const panel = page.getByRole('region', { name: `Engineering evidence for ${item}`, exact: true });
  const checkbox = panel.getByRole('checkbox', { name: 'Include unscoped decision context' });
  const states: { name: string; screenshot: string; accessibility: string }[] = [];
  async function capture(name: string) {
    const screenshot = info.outputPath(name + '.png'), accessibility = info.outputPath(name + '.aria.txt');
    await panel.screenshot({ path: screenshot });
    writeFileSync(accessibility, await panel.ariaSnapshot());
    await info.attach(name, { path: screenshot, contentType: 'image/png' });
    await info.attach(name + '-accessibility', { path: accessibility, contentType: 'text/plain' });
    states.push({ name, screenshot, accessibility });
  }
  await expect(panel.getByRole('button', { name: `Bind test evidence for ${spec}`, exact: true })).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  expect(graphCalls.at(-1)?.args.include_context).toBe(false);
  await capture('context-unchecked');
  await checkbox.check();
  await expect.poll(() => graphCalls.at(-1)?.args.include_context).toBe(true);
  await expect(checkbox).toBeChecked();
  await capture('context-checked');
  await checkbox.uncheck();
  await expect.poll(() => graphCalls.at(-1)?.args.include_context).toBe(false);
  await expect(checkbox).not.toBeChecked();
  await panel.getByRole('button', { name: `Bind test evidence for ${spec}`, exact: true }).click();
  const owner = panel.getByRole('textbox', { name: 'Owning work item' });
  const run = panel.getByRole('spinbutton', { name: 'Recorded test run' });
  const submit = panel.getByRole('button', { name: 'Bind evidence', exact: true });
  await expect(owner).toHaveValue(''); await expect(run).toHaveValue('');
  await capture('repair-empty');
  await owner.fill('EI-123'); await run.fill('17'); await submit.click();
  expect(await owner.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
  expect(bindings).toHaveLength(0);
  await capture('repair-invalid-owner');
  await owner.fill('WI-123'); await run.fill('0'); await submit.click();
  expect(await run.evaluate((input: HTMLInputElement) => input.validity.rangeUnderflow)).toBe(true);
  expect(bindings).toHaveLength(0);
  await capture('repair-invalid-run');
  await run.fill('17');
  await expect(owner).toHaveValue('WI-123'); await expect(run).toHaveValue('17');
  await capture('repair-valid');
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect.poll(() => bindings.length).toBe(1);
  expect(bindings[0]).toMatchObject({ name: 'plans:bind-spec-evidence', harness: 'papercusp', confirmed: true,
    args: { slug: plan, harness: 'papercusp', binding: { workItemId: 'WI-123', specId: spec, specRevision: 2, fromTestRun: 17 } } });
  await capture('repair-busy');
  releaseBind!();
  await expect(owner).toHaveCount(0);
  await capture('repair-complete');
  await panel.getByRole('button', { name: `Bind test evidence for ${spec}`, exact: true }).click();
  await panel.getByRole('button', { name: 'Cancel repair', exact: true }).click();
  await expect(owner).toHaveCount(0); expect(bindings).toHaveLength(1);
  await capture('repair-cancelled');
  const after = await health(); expect(after).toBe(before);
  const receiptPath = info.outputPath('shared-controls.json');
  writeFileSync(receiptPath, JSON.stringify({ plane: 'current-build', scope: 'real-app-controls-with-controlled-tool-responses',
    canonicalGraphProof: false, buildSha, sourceSha256, before, after, source, graphCalls, bindings, states }, null, 2));
  await info.attach('shared-controls-receipt', { path: receiptPath, contentType: 'application/json' });
});

