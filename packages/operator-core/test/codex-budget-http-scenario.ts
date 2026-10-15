/** Registered budgets through the real bootstrap HTTP route, in private state. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { getPresence, setCompactionLimit, writePresence } from '../lib/agent-tools/coordination/presence';
import { suWrapperExtraArgs } from '../../../apps/operator/scripts/psu-launcher.mjs';

type Options = { workspace: string; base: string; headers: Record<string, string>; evidenceDir: string };

export async function measureCodexBudgetScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const cases = [
    { name: 'stale-argv', current: 225_000, argv: ['psu', '--compaction-limit=250000'], expected: 225_000 },
    { name: 'absent-argv', current: 225_000, argv: ['psu'], expected: 225_000 },
    { name: 'legacy-argv', current: null, argv: ['psu', '--compaction-limit=250000'], expected: 250_000 },
  ];
  const results = [];
  for (const entry of cases) {
    const owner = `su-private-budget-${randomUUID()}`;
    await writePresence({ ownerId: owner, ownerLabel: 'Private budget control', source: 'test', workspaceId: o.workspace });
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
    const threshold = Math.floor(entry.expected * 0.8);
    assert.equal(config.model_auto_compact_token_limit, threshold);
    const argv = suWrapperExtraArgs('codex', { model: result.model, compactionLimit: result.compactionLimit });
    assert.ok(argv.includes(`model_auto_compact_token_limit=${threshold}`), JSON.stringify(argv));
    const presence = await getPresence(owner);
    if (entry.current !== null) assert.equal(presence?.compactionLimit, entry.current);
    results.push({ name: entry.name, owner, sessionId: result.sessionId,
      registeredBudget: presence?.compactionLimit ?? null, responseBudget: result.compactionLimit,
      configThreshold: config.model_auto_compact_token_limit, argvThreshold: threshold });
  }
  const receipt = { workspace: o.workspace, cases: results, nativeLaunched: false };
  await writeFile(join(o.evidenceDir, 'codex-budget-receipt.json'), JSON.stringify(receipt), { flag: 'wx' });
  return receipt;
}
