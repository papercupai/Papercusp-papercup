import { request, type FullConfig } from '@playwright/test';
import { resolveTestRunWorkspaceId } from '@papercusp/test-config/admin-test-runs-reporter';
import warmDevServer from './_warm-dev-server';

/** Validate the selected artifact, then prepare the real HUD dependency graph. */
export default async function warmOngoingWork(config: FullConfig): Promise<void> {
  const workspaceId = resolveTestRunWorkspaceId();
  if (!workspaceId) throw new Error('The ongoing-work rehearsal requires an explicit workspace');

  const baseURL = config.projects[0]?.use?.baseURL;
  if (typeof baseURL !== 'string' || !baseURL) {
    throw new Error('The ongoing-work rehearsal requires an explicit artifact URL');
  }
  const expectedSha = process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA?.trim();
  if (!expectedSha || !/^[a-f0-9]{10,40}$/.test(expectedSha)) {
    throw new Error('The ongoing-work rehearsal requires the independently resolved artifact SHA');
  }

  const api = await request.newContext({ baseURL });
  try {
    const healthResponse = await api.get('/api/health', { timeout: 10_000 });
    if (!healthResponse.ok()) {
      throw new Error(`/api/health returned HTTP ${healthResponse.status()}`);
    }
    const health = await healthResponse.json() as { bundleStale?: unknown; sha?: unknown };
    if (health.bundleStale !== undefined) {
      throw new Error('/api/health reported a fallback bundle');
    }
    if (health.sha !== expectedSha) {
      throw new Error(`/api/health SHA mismatch (expected ${expectedSha}, received ${String(health.sha ?? 'missing')})`);
    }
  } catch (error) {
    throw new Error(
      `Ongoing-work artifact preflight failed at ${new URL('/api/health', baseURL)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await api.dispose();
  }

  await warmDevServer(config, {
    paths: [`/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=${encodeURIComponent(workspaceId)}`],
    readySelector: '[role="tablist"][aria-label="HUD board"]',
    strict: true,
  });
}
