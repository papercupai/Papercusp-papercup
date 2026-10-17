/** D-255: private source fixture; never reads or restores an installed seed. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeedObserverFixtureInput {
  phase: 'verify' | 'restore';
  files: { path: string; sha256: string }[];
  buildSha: string;
  entrySha256: string;
}
export interface SeedObserverFixtureEvent {
  kind: 'ready' | 'held' | 'finished';
  phase: 'verify' | 'restore';
  pid: number;
  processInstanceId: string;
  entry: string;
  sourceSha256: string;
  buildSha: string;
  files: SeedObserverFixtureInput['files'];
  marker: string;
}

const entry = fileURLToPath(import.meta.url);
const root = resolve(dirname(entry), '../../../..');
const phase = process.argv[2];
assert.ok(phase === 'verify' || phase === 'restore');
const input: SeedObserverFixtureInput = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const files = input.files.map((file: { path: string; sha256: string }) => {
  assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
  const sha256 = hash(readFileSync(join(root, file.path)));
  assert.equal(sha256, file.sha256, 'fixture source changed before import: ' + file.path);
  return { path: file.path, sha256 };
});
assert.equal(hash(JSON.stringify(files)), input.buildSha);
assert.equal(input.phase, phase);
const sourceSha256 = hash(readFileSync(entry));
assert.equal(sourceSha256, input.entrySha256);
const processInstanceId = randomUUID();
assert.match(process.env.PAPERCUSP_WORKSPACE_ID ?? '', /^test-runtime-/);
const pg = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
assert.equal(pg.port, process.env.PAPERCUSP_PG_PORT);
assert.notEqual(pg.port, '5432');
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
const marker = join(process.env.HOME!, 'seed-restore-observer-marker.json');
writeFileSync(marker, JSON.stringify({ pid: process.pid, processInstanceId, phase }), { flag: 'wx' });

// Import the real implementation after validating the independently supplied
// source receipt. Only the provider await is controlled by this fixture.
const { restoreSeed } = await import('../../../../libs/generic/seed-bundle/src/restore.ts');
const { SeedProviderRegistry } = await import('../../../../libs/generic/seed-bundle/src/registry.ts');
let release!: () => void;
let finish!: () => void;
const held = new Promise<void>(resolve => { release = resolve; });
const finished = new Promise<void>(resolve => { finish = resolve; });
let ongoing: ReturnType<typeof restoreSeed> | undefined;
let watchdogFired = false;
const emit = (kind: SeedObserverFixtureEvent['kind']) => console.log('SEED_RESTORE_OBSERVER_EVENT ' + JSON.stringify({
  kind, phase, pid: process.pid, processInstanceId, entry, sourceSha256,
  buildSha: input.buildSha, files, marker,
}));
const registry = new SeedProviderRegistry().register({
  kind: 'corestore',
  cut: async () => { throw new Error('cut is outside this fixture'); },
  verify: async () => {
    if (phase === 'verify') { emit('held'); await held; }
    return { ok: true };
  },
  restore: async () => { if (phase === 'restore') { emit('held'); await held; } },
});
const controlKey = Symbol.for('@papercusp/test.seed-restore-observer-control');
const global = globalThis as unknown as Record<symbol, unknown>;
global[controlKey] = {
  begin() {
    assert.equal(ongoing, undefined, 'one restore per original worker');
    ongoing = restoreSeed({ seedFormatVersion: 1, potId: 'observer-fixture',
      cutAtEpoch: 0, cutHlc: 'fixture', cutTs: 1,
      stores: [{ kind: 'corestore', hash: 'hash', sizeBytes: 0,
        source: { type: 'resource', path: 'private-empty-fixture' } }] },
    registry, async () => new Uint8Array(), {
      diagnosticIdentity: { processInstanceId, buildSha: input.buildSha, sourceSha256, script: entry },
    });
    return true;
  },
  release() { release(); return true; },
  finish() {
    // Let Runtime.evaluate deliver its response before normal process exit.
    setTimeout(finish, 250);
    return true;
  },
};
const watchdog = setTimeout(() => { watchdogFired = true; release(); finish(); }, 120_000);
try {
  emit('ready');
  await finished;
  assert.ok(!watchdogFired, 'fixture observation deadline exceeded');
  assert.ok(ongoing, 'parent must run the original restore');
  const result = await ongoing;
  assert.ok(result.ok && result.outcomes.every(outcome => outcome.ok));
  emit('finished');
} finally {
  release();
  clearTimeout(watchdog);
  delete global[controlKey];
}
