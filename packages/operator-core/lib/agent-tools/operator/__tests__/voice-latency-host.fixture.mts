/** Private current-build API for the paid voice latency acceptance test.
 * Bundle with apps/operator/bin/bundle-host.sh, then run with plain Node.
 * Reuses the production handler without bootstrap, watchers, routines or UI.
 */
import { createAdaptorServer } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handler } from '../../../../../../apps/operator/bin/host-handler';

if (process.env.PAPERCUSP_SERVE_UI !== '0') throw new Error('Voice latency fixture requires PAPERCUSP_SERVE_UI=0');
const bundleSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const server = createAdaptorServer({ fetch: handler });
server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No private API port');
  const url = `http://127.0.0.1:${address.port}`;
  process.env.PAPERCUSP_SELF_URL = url;
  const health = await fetch(`${url}/api/health`).then(response => response.json());
  console.log(`VOICE_CURRENT_BUILD_READY ${JSON.stringify({ url, health, bundleSha256, pid: process.pid, bootstrap: false, ui: false })}`);
});
const finish = () => server.close(() => process.exit(0));
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
