/** Current-build local usage and disclosure acceptance in the maintained native rig. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeChildEnvironment, nativeTestDatabaseEnvironment,
  type NativeLiveProfile } from '../../../scripts/tauri-surface-verify-reports.mts';

const execute = promisify(execFile);
const isolated = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1';

describe.skipIf(!isolated)('Cloud monitoring in the isolated native desktop', () => {
  let nativeEnv: NodeJS.ProcessEnv;
  let profile: NativeLiveProfile;
  let sql: Awaited<ReturnType<typeof import('@papercusp/db-org')['getOrgPg']>>['sql'];
  const harness = 'cloud-monitoring-native';
  const sourceRoot = process.env.OPERATOR_SOURCE_ROOT;

  const native = async (...args: string[]) => (await execute(
    process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!, [...args, '--pid', String(profile.tauriPID)],
    { env: nativeEnv, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  )).stdout;
  const poll = async (expression: string, selector: string) => {
    try {
      return await execute(process.env.VERIFY_TAURI_POLL!,
        ['--require', selector, '--eval', expression],
        { env: { ...nativeEnv, VERIFY_TAURI_DOM_TIMEOUT: '60' }, timeout: 90_000 });
    } catch (error) {
      // Retain the actual page on failure; a timeout alone cannot distinguish a
      // missing static artifact, a client route, and an incompletely loaded page.
      const page = await native('eval', `JSON.stringify({ url: location.href,
        readyState: document.readyState, title: document.title,
        body: document.body?.textContent?.slice(0, 16000) })`)
        .catch(cause => String(cause));
      console.error('CLOUD_MONITORING_NATIVE_FAILED_PAGE ' + page);
      throw error;
    }
  };

  beforeAll(async () => {
    expect(sourceRoot).toBeTruthy();
    expect(process.env.VERIFY_TAURI_SOURCE_RECEIPT).toBeTruthy();
    profile = JSON.parse(readFileSync(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!, 'utf8'));
    nativeEnv = nativeChildEnvironment(profile);
    // This check admits only the verifier-owned throwaway postmaster before any write.
    nativeTestDatabaseEnvironment(profile);
    expect(profile.workspaceId).toMatch(/^verify-tauri-isolated-\d+$/);
    const { getOrgPg } = await import('@papercusp/db-org');
    sql = getOrgPg().sql;
    const { mutateHarnessRegistry } = await import('./harness-registry');
    await mutateHarnessRegistry(reg => ({ ...reg, projects: [
      ...reg.projects.filter(project => project.slug !== harness), { slug: harness, path: sourceRoot! },
    ] }), profile.workspaceId);
    const at = Date.now();
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, harness_slug, ts, bucket_key, provider, model_class, source,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source)
      VALUES
      (${profile.workspaceId}, ${harness}, ${at}, 'native', 'openai', 'native-reported', 'jsonl', 100, 20, 50, 5, 0.2, 'provider'),
      (${profile.workspaceId}, ${harness}, ${at - 1}, 'native', 'openai', 'native-estimated', 'jsonl', 200, 30, 60, 6, 0.1, 'estimated'),
      (${profile.workspaceId}, ${harness}, ${at - 2}, 'native', 'other', 'native-unknown', 'jsonl', NULL, 40, 0, NULL, NULL, NULL),
      (${profile.workspaceId + '-foreign'}, ${harness}, ${at}, 'native', 'other', 'foreign-private', 'jsonl', 99999, 99999, 99999, 99999, 99999, 'provider'),
      (${profile.workspaceId}, ${harness + '-foreign'}, ${at}, 'native', 'other', 'other-harness-private', 'jsonl', 99999, 99999, 99999, 99999, 99999, 'provider')`;
    console.info('CLOUD_MONITORING_NATIVE_SOURCE ' + JSON.stringify({
      source: process.env.VERIFY_TAURI_SOURCE_REF, receipt: process.env.VERIFY_TAURI_SOURCE_RECEIPT,
      workspace: profile.workspaceId, pid: profile.tauriPID, harness,
    }));
  }, 120_000);

  afterAll(async () => { await sql?.end({ timeout: 2 }); });

  it('renders scoped local per-call costs and unknown counters without analytics consent', async () => {
    await native('navigate', '/adv?' + new URLSearchParams({ tab: 'insights', slug: harness,
      insightView: 'tokens', ws: profile.workspaceId }), '--json');
    await poll(`(() => {
      const view = document.querySelector('[data-testid="insights-tokens-view"]');
      const text = view?.textContent ?? '';
      return text.includes('native-reported') && text.includes('native-estimated')
        && text.includes('native-unknown') && text.includes('provider reported')
        && text.includes('estimated') && text.includes('Unknown')
        && document.querySelector('[data-testid="tokens-stat-runs"]')?.textContent.includes('3')
        && !text.includes('foreign-private') && !text.includes('other-harness-private');
    })()`, '[data-testid="insights-tokens-view"]');
    const observed = JSON.parse(await native('eval', `JSON.stringify({
      url: location.href, text: document.querySelector('[data-testid="insights-tokens-view"]')?.textContent,
      rows: Array.from(document.querySelectorAll('[aria-label="Recent local call usage"] tbody tr'))
        .map(row => row.textContent),
    })`));
    expect(observed.text).toContain('Calls observed by this runtime');
    expect(observed.text).toContain('Customer usage stays local');
    expect(observed.text).toContain('Cost is unknown for 1 call(s)');
    expect(observed.text).not.toContain('foreign-private');
    expect(observed.rows).toHaveLength(3);
    // A missing-row control is checked against the populated native DOM.
    expect(await native('eval', `document.body.textContent.includes('foreign-private')`)).toMatch(/false/);
    console.info('CLOUD_MONITORING_NATIVE_LOCAL ' + JSON.stringify(observed));
  }, 150_000);

  it('opens the maintained disclosure reader with the production event population and export terms', async () => {
    const documentPath = join(sourceRoot!, 'apps/operator-docs/src/content/docs/posthog/index.mdx');
    const markdown = readFileSync(documentPath, 'utf8');
    // Names come from the maintained disclosure's actual population; the existing
    // AST-derived guard separately enforces equality with the production schema.
    const disclosedEvents = [...new Set(markdown.match(/cloud_[a-z_]+/g) ?? [])];
    expect(disclosedEvents.length).toBeGreaterThan(0);
    const readerUrl = new URL('/internal/docs/posthog', process.env.VERIFY_TAURI_DEV_URL).href;
    const response = await fetch(readerUrl, { signal: AbortSignal.timeout(10_000) });
    expect(response.status, 'The isolated host must serve the built disclosure before native navigation').toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    for (const event of disclosedEvents) expect(html).toContain(event);
    console.info('CLOUD_MONITORING_NATIVE_DOCS_HTTP ' + JSON.stringify({ url: response.url,
      sha256: createHash('sha256').update(html).digest('hex'), events: disclosedEvents }));
    // Relative navigate uses pushState, which cannot load this server-rendered
    // Starlight page. An absolute target performs the real document navigation.
    await native('navigate', readerUrl, '--json');
    await poll(`document.body.textContent.includes('PostHog') &&
      ${JSON.stringify(disclosedEvents)}.every(event => document.body.textContent.includes(event))`, 'body');
    const body = JSON.parse(await native('eval', 'JSON.stringify(document.body.textContent)')) as string;
    for (const event of disclosedEvents) expect(body).toContain(event);
    expect(body.toLowerCase()).toContain('retention');
    expect(body.toLowerCase()).toContain('revocation');
    expect(body).toContain('flags.papercuspai.com');
    console.info('CLOUD_MONITORING_NATIVE_READER ' + JSON.stringify({ documentPath,
      events: disclosedEvents,
      url: await native('eval', 'location.href'), source: process.env.VERIFY_TAURI_SOURCE_REF }));
  }, 150_000);
});
