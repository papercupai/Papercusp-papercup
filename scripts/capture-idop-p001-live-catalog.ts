import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureIdopLiveCatalog } from '../packages/operator-core/lib/agent-identities/idop-p001-live-catalog';

// Run INSIDE the actual newly launched Codex caller. No config/client/role overrides.
async function main() {
  const [output] = process.argv.slice(2);
  if (!output || process.argv.length !== 3 || !process.env.CODEX_HOME)
    throw new Error('Usage: tsx scripts/capture-idop-p001-live-catalog.ts <new-output.json> (inside actual Codex caller)');
  const configPath = join(process.env.CODEX_HOME, 'config.toml');
  const artifact = await captureIdopLiveCatalog(readFileSync(configPath, 'utf8'), process.env);
  writeFileSync(output, JSON.stringify({ ...artifact, configPath }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, complete: artifact.complete, pages: artifact.pages.length,
    toolCount: artifact.toolCount, failure: artifact.failure }));
  if (!artifact.complete) process.exitCode = 2;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
