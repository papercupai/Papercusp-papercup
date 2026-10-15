// Test-only sandboxed provider daemon (plan cupboard-distributable-integrations-2026-10-10 R-2).
// Cupboard-installed providers must run as runtime.kind "daemon" (install-plugin-core
// inspectProviderForInstall), so this fixture speaks the provider daemon protocol: line-delimited
// JSON-RPC 2.0 over stdio (packages/operator-core/lib/integrations/daemon-provider.ts).
// No network: syncPage yields nothing, chat.channels answers a fixed channel list and
// ticket.containers a fixed project list, so a private operator can prove the whole setup on
// Settings -> Integrations (connect, choose channels, choose the destination project, arm) is
// driven from the installed descriptor alone.
import fs from 'node:fs';
import readline from 'node:readline';

const manifest = JSON.parse(fs.readFileSync(new URL('./papercusp.json', import.meta.url), 'utf8'));
const DESCRIPTOR = manifest.provider;

const CHANNELS = [
  { value: 'C-general', label: '#general' },
  { value: 'C-bugs', label: '#bugs', description: 'Bug reports' },
];

const PROJECTS = [
  { value: 'PRJ-roadmap', label: 'Roadmap' },
  { value: 'PRJ-bugs', label: 'Bug inbox', description: 'Where reported bugs are filed' },
];

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

async function handle(method, params) {
  if (method === 'papercup.ping') return 'pong';
  if (method === 'provider.describe') return DESCRIPTOR;
  if (method === 'provider.syncPage') return { records: [], nextCursor: null, hasMore: false };
  if (method === 'provider.invoke') {
    const request = params?.request ?? {};
    if (request.capability === 'chat.channels') return { options: CHANNELS };
    if (request.capability === 'ticket.containers') return { options: PROJECTS };
    const err = new Error(`provider_capability_unsupported:${request.capability}`);
    err.code = -32000;
    throw err;
  }
  const err = new Error(`method not found: ${method}`);
  err.code = -32601;
  throw err;
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined) return; // this fixture never issues host.fetch, so no replies to match
  try {
    send({ jsonrpc: '2.0', id: message.id, result: await handle(message.method, message.params) });
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32000, message: error.message } });
  }
});
