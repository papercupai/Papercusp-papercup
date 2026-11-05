/** Registered budgets through the real bootstrap HTTP route, in private state. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';

type Options = { workspace: string; base: string; headers: Record<string, string>; evidenceDir: string };

/** The direct bootstrap checks native auth even when no CLI is launched.
 * Match the maintained private native fixture's deliberately invalid login,
 * without installing hooks, registering an account or forwarding inference. */
export async function prepareCodexBudgetScenario(workspace: string) {
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_WORKSPACE_ID, workspace);
  assert.equal(process.env.PC_ISOLATED_RUNTIME_PROOF, '1');
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  const home = process.env.HOME!;
  assert.ok(home, 'private HOME required');
  assert.equal(process.env.PAPERCUSP_HOME, join(home, '.papercusp'));
  const authDir = join(home, '.codex');
  await mkdir(authDir, { recursive: true });
  await writeFile(join(authDir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { access_token: `private-budget-no-provider-${randomUUID()}`, account_id: 'private-budget' } }),
  { flag: 'wx', mode: 0o600 });
}

export async function measureCodexBudgetScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  await prepareCodexBudgetScenario(o.workspace);
  // Credential preparation is filesystem-only. Load production state only
  // after the measurement has established its private runtime boundary.
  const [{ getPresence, setCompactionLimit, writePresence }, { suWrapperExtraArgs }] = await Promise.all([
    import('../lib/agent-tools/coordination/presence'),
    import('../../../apps/operator/scripts/psu-launcher.mjs'),
  ]);
  const cases = [
    { name: 'stale-argv', current: 225_000, argv: ['psu', '--compaction-limit=250000'], expected: 225_000 },
    { name: 'absent-argv', current: 225_000, argv: ['psu'], expected: 225_000 },
    { name: 'legacy-argv', current: null, argv: ['psu', '--compaction-limit=250000'], expected: 250_000 },
    { name: 'fresh-argv', current: null, argv: ['psu', '--compaction-limit=20000'], expected: 20_000 },
  ];
  const results = [];
  for (const entry of cases) {
    const owner = `su-private-budget-${randomUUID()}`;
    // The native regression starts without a presence row and never runs a
    // watchdog. Bootstrap itself must register the explicit ceiling.
    if (entry.name !== 'fresh-argv')
      await writePresence({ ownerId: owner, ownerLabel: 'Private budget control', source: 'omp-hook-session', workspaceId: o.workspace, userId: null });
    if (entry.current !== null) await setCompactionLimit(owner, entry.current, { explicit: true });
    const response = await fetch(o.base + '/api/agent-mcp/console/bootstrap-su', {
      method: 'POST', headers: o.headers, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ agent: 'codex', workspace: o.workspace, owner_id: owner,
        model: 'gpt-6.1-sol:xhigh', model_source: 'explicit', account: 'default',
        cwd: process.cwd(), context_size: 'trimmed', launch_argv: entry.argv,
        bootstrap_idempotency_key: `private-budget-${entry.name}-${owner}` }),
    });
    const result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.envelopeEnv.PAPERCUSP_SID, owner);
    assert.equal(result.compactionLimit, entry.expected);
    assert.ok(result.codexHome.startsWith(process.env.HOME!), 'bootstrap escaped private HOME');
    const config = parseToml(await readFile(join(result.codexHome, 'config.toml'), 'utf8'));
    // Managed host pressure and Codex's native startup floor are different
    // controls. A small host ceiling must not compact the initial prompt.
    const startupFloorTokens = result.contextBudget.baselineTokens + result.contextBudget.reserveTokens;
    assert.ok(Number.isSafeInteger(startupFloorTokens) && startupFloorTokens > 0);
    const threshold = Math.min(Number(config.model_context_window),
      Math.max(Math.floor(entry.expected * 0.8), startupFloorTokens));
    assert.equal(config.model_auto_compact_token_limit, threshold);
    const argv = suWrapperExtraArgs('codex', { model: result.model, compactionLimit: result.compactionLimit,
      startupFloorTokens, codexHome: result.codexHome });
    assert.ok(argv.includes(`model_auto_compact_token_limit=${threshold}`), JSON.stringify(argv));
    const presence = await getPresence(owner);
    assert.equal(presence?.compactionLimit, entry.expected);
    assert.equal(presence?.compactionLimitExplicit, true);
    results.push({ name: entry.name, owner, sessionId: result.sessionId,
      registeredBudget: presence?.compactionLimit ?? null, responseBudget: result.compactionLimit,
      configThreshold: config.model_auto_compact_token_limit, argvThreshold: threshold });
  }
  const receipt = { workspace: o.workspace, cases: results, nativeLaunched: false };
  await writeFile(join(o.evidenceDir, 'codex-budget-receipt.json'), JSON.stringify(receipt), { flag: 'wx' });
  return receipt;
}
