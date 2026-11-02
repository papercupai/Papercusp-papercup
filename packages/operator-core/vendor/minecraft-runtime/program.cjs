'use strict';
// Untrusted program execution belongs in THIS container, never in bot.cjs.
const http = require('node:http');
const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const rpc = (operation, args = {}) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ participant: request.participant, operation, args });
  const req = http.request({ socketPath: '/bridge/bot.sock', path: '/', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
    let output = '';
    res.on('data', chunk => { output += chunk; if (output.length > 131072) req.destroy(Error('RPC output limit')); });
    res.on('end', () => { try { const data = JSON.parse(output); data.ok ? resolve(data.value) : reject(Error(data.error)); }
      catch (error) { reject(error); } });
  });
  req.setTimeout(request.timeoutMs, () => req.destroy(Error('RPC deadline')));
  req.on('error', reject); req.end(body);
});
const api = Object.freeze(Object.fromEntries([
  'position', 'health', 'inventory', 'blocks', 'entities', 'advancements', 'team-chat',
  'move', 'mine', 'craft', 'interact', 'attack',
].map(name => [name, args => rpc(name, args)])));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
Promise.resolve().then(() => new AsyncFunction('bot', request.source)(api))
  .then(value => { process.stdout.write(JSON.stringify({ ok: true, value: value ?? null })); process.exit(0); })
  .catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: String(error.message).slice(0, 2000) })); process.exit(1); });
