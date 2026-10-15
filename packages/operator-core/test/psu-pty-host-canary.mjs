/** Dedicated real PSU host for the registered private HTTP integration suite. */
import assert from 'node:assert/strict';
import { hostThroughPty } from '../../../apps/operator/scripts/psu-pty-host.mjs';

const ownerId = process.argv[2];
const advSessionId = Number(process.argv[3]);
assert.equal(process.env.PAPERCUSP_SID, ownerId);
assert.ok(ownerId?.startsWith('su-rs-') && Number.isSafeInteger(advSessionId) && advSessionId > 0);
assert.ok(process.env.PAPERCUSP_PSU_PTY_DIR);
assert.equal(process.env.PAPERCUSP_LAUNCHED_BY, 'su-private-roster-acceptance');
// Serialize directly to keep newline delimiters intact across the child boundary.
function echoCanary() {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      process.stdout.write('ECHO:' + buffer.slice(0, index) + '\n');
      buffer = buffer.slice(index + 1);
    }
  });
  setTimeout(() => process.exit(0), 120_000);
}
await hostThroughPty({ command: process.execPath,
  args: ['-e', '(' + echoCanary.toString() + ')()'],
  cwd: process.cwd(), env: process.env, ownerId, advSessionId, bridgeTty: false,
  reapScopeResidue: () => ({ killedPids: [], failedPids: [] }), activityPersistMs: 50,
  onExit: (code, signal) => {
    process.stdout.write('\nROSTER_CANARY_EXIT ' + JSON.stringify({ ownerId, advSessionId, code, signal }) + '\n');
    process.exit(code);
  },
});
