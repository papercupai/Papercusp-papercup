/** D-255: private source fixture; never reads or restores an installed seed. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeedObserverFixtureInput {
  phase: 'verify' | 'restore' | 'bootstrap';
  files: { path: string; sha256: string }[];
  buildSha: string;
  entrySha256: string;
}
export interface SeedObserverFixtureEvent {
  kind: 'ready' | 'held' | 'finished';
  phase: SeedObserverFixtureInput['phase'];
  pid: number;
  processInstanceId: string | null;
  entry: string;
  sourceSha256: string;
  buildSha: string;
  files: SeedObserverFixtureInput['files'];
  marker: string;
  bootstrap?: {
    sourceReceiptSha256: string;
    buildInfo: { sha: string | null; version: string };
    buildProvenance: string;
    paths: { sourceDir: string; seedDir: string; targetStoreDir: string; targetRepoDir: string };
    runtime: { home: string; workspaceId: string; workspacesRoot: string; pgPort: string; skipDiscovery: string };
    coreKeyHex: string;
    manifest: unknown;
    manifestSha256: string;
    payloadHash: string;
    payloadBytes: number;
    records: unknown[];
    seedBefore: string;
    sourceBefore: string;
    seedAfter?: string;
    sourceAfter?: string;
    restoredRecords?: unknown[];
    joinCalls: number;
    progress: string[];
    unexpectedEffects: string[];
  };
}

const entry = fileURLToPath(import.meta.url);
const root = resolve(dirname(entry), '../../../..');
const phase = process.argv[2];
assert.ok(phase === 'verify' || phase === 'restore' || phase === 'bootstrap');
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
const processInstanceId = phase === 'bootstrap' ? null : randomUUID();
assert.match(process.env.PAPERCUSP_WORKSPACE_ID ?? '', /^test-runtime-/);
const pg = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
assert.equal(pg.port, process.env.PAPERCUSP_PG_PORT);
assert.notEqual(pg.port, '5432');
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
const marker = join(process.env.HOME!, 'seed-restore-observer-marker.json');
writeFileSync(marker, JSON.stringify({ pid: process.pid, processInstanceId, phase }), { flag: 'wx' });

if (phase === 'bootstrap') {
  await qualifyProductionBootstrap();
} else {
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
}

/** The only held collaborator is admission, AFTER the unmodified real restore. */
async function qualifyProductionBootstrap(): Promise<void> {
  interface FixtureCore {
    ready(): Promise<void>;
    append(value: unknown): Promise<unknown>;
    key: Buffer;
    length: number;
    get(index: number, options: { wait: false }): Promise<unknown>;
  }
  const { default: Corestore } = await import('corestore');
  const { createCorestoreSeedProvider } = await import('../../lib/sync/hyperbee/seed-provider-corestore.ts');
  const { encodeManifest, SEED_FORMAT_VERSION } = await import('../../../../libs/generic/seed-bundle/src/manifest.ts');
  const sourceDir = join(process.env.HOME!, 'bootstrap-source');
  const stagingDir = join(process.env.HOME!, 'bootstrap-cut');
  const seedDir = join(process.env.HOME!, 'bootstrap-seed');
  const records = [
    { type: 'put', table: 'fixture-records', hbKey: 'first', value: { fixture: 'bootstrap-alpha' } },
    { type: 'put', table: 'fixture-records', hbKey: 'second', value: { fixture: 'bootstrap-beta' } },
  ];
  const source = new Corestore(sourceDir);
  let cut: Awaited<ReturnType<ReturnType<typeof createCorestoreSeedProvider>['cut']>>;
  let coreKeyHex: string;
  try {
    await source.ready();
    const core = source.get({ name: 'private-bootstrap-fixture', valueEncoding: 'json' }) as unknown as FixtureCore;
    await core.ready();
    for (const record of records) await core.append(record);
    coreKeyHex = core.key.toString('hex');
    cut = await createCorestoreSeedProvider().cut({ sourceStore: source, coreKeys: [coreKeyHex], stagingDir });
  } finally { await source.close(); }
  mkdirSync(seedDir);
  // Copy (not rename) to exercise the real read-only moved-seed path.
  cpSync(stagingDir, join(seedDir, 'corestore'), { recursive: true });
  rmSync(stagingDir, { recursive: true });
  const manifest = { seedFormatVersion: SEED_FORMAT_VERSION,
    potId: 'bootstrap-fixture', cutAtEpoch: 0, cutHlc: 'fixture', cutTs: 1,
    stores: [{ ...cut.entry, source: { type: 'resource' as const, path: 'corestore' } }] };
  const manifestBytes = encodeManifest(manifest);
  writeFileSync(join(seedDir, 'manifest.json'), manifestBytes);
  const permissions = (path: string, readOnly: boolean): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!readOnly) chmodSync(path, 0o700);
      for (const child of readdirSync(path)) permissions(join(path, child), readOnly);
    }
    chmodSync(path, stat.isDirectory() ? (readOnly ? 0o555 : 0o700) : (readOnly ? 0o444 : 0o600));
  };
  const treeHash = (path: string): string => {
    const inventory: unknown[] = [];
    const visit = (dir: string, prefix = ''): void => {
      for (const name of readdirSync(dir).sort()) {
        const file = join(dir, name), relative = prefix + name;
        const stat = statSync(file);
        inventory.push({ path: relative, mode: stat.mode & 0o777,
          ...(stat.isDirectory() ? { directory: true } : { size: stat.size, sha256: hash(readFileSync(file)) }) });
        if (stat.isDirectory()) visit(file, relative + '/');
      }
    };
    visit(path);
    return hash(JSON.stringify(inventory));
  };
  permissions(seedDir, true);
  try {
  process.env.PAPERCUSP_SEED_DIR = seedDir;
  assert.equal(process.env.PAPERCUSP_NO_SEED, undefined);
  assert.notEqual(process.env.PAPERCUSP_DISABLE_DOGFOOD_HIVE, '1');
  assert.equal(process.argv[1], entry, 'real entry argv, never a fixture override');
  const { bootstrapPapercuspHive, seedBundleEnabled, seedTargetDirs } =
    await import('../../lib/harness/bootstrap-papercusp-hive.ts');
  const { resolveSeedDir } = await import('../../lib/sync/hyperbee/restore-hive-seed.ts');
  const { getBuildInfo } = await import('../../lib/build-info.ts');
  assert.equal(await seedBundleEnabled(), true, 'default seed flag must permit real restore');
  assert.equal(resolveSeedDir().seedDir, seedDir);
  const buildInfo = getBuildInfo();
  assert.ok(buildInfo.sha && /^[0-9a-f]{7,40}$/.test(buildInfo.sha), 'actual development build identity');
  assert.equal(process.env.PAPERCUSP_BUILD_SHA, undefined, 'no inherited build override');
  const { execFileSync } = await import('node:child_process');
  const observedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.ok(observedHead.startsWith(buildInfo.sha), 'actual build revision agrees with current development source');
  const paths = { sourceDir, seedDir, ...seedTargetDirs() };
  for (const path of Object.values(paths)) assert.ok(path.startsWith(dirname(process.env.HOME!) + '/'));
  assert.ok(!existsSync(paths.targetStoreDir), 'no pre-existing target can satisfy restored-data assertions');
  const state: NonNullable<SeedObserverFixtureEvent['bootstrap']> = {
    sourceReceiptSha256: input.buildSha, buildInfo, buildProvenance: 'bare-tsx development git fallback: ' + observedHead,
    paths, runtime: { home: process.env.HOME!, workspaceId: process.env.PAPERCUSP_WORKSPACE_ID!,
      workspacesRoot: process.env.PAPERCUSP_WORKSPACES_ROOT!, pgPort: pg.port,
      skipDiscovery: process.env.PAPERCUSP_SKIP_PG_DISCOVERY! },
    coreKeyHex, manifest, manifestSha256: hash(manifestBytes), payloadHash: cut.entry.hash,
    payloadBytes: cut.entry.sizeBytes, records, seedBefore: treeHash(seedDir), sourceBefore: treeHash(sourceDir),
    joinCalls: 0, progress: [], unexpectedEffects: [],
  };
  let release!: () => void, finish!: () => void;
  const joined = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let ongoing: ReturnType<typeof bootstrapPapercuspHive> | undefined;
  let watchdogFired = false;
  const emit = (kind: SeedObserverFixtureEvent['kind']) => console.log('SEED_RESTORE_OBSERVER_EVENT ' + JSON.stringify({
    kind, phase, pid: process.pid, processInstanceId: null, entry, sourceSha256,
    buildSha: buildInfo.sha, files, marker, bootstrap: state,
  }));
  const forbidden = (name: string): never => { state.unexpectedEffects.push(name); throw Error('unrelated fixture effect: ' + name); };
  const key = Symbol.for('@papercusp/test.seed-restore-observer-control');
  const global = globalThis as unknown as Record<symbol, unknown>;
  global[key] = {
    begin() {
      assert.equal(ongoing, undefined, 'one bootstrap per original worker');
      ongoing = bootstrapPapercuspHive({
        loadRegistry: async () => ({ projects: [] }),
        canonicalInvite: { pubkeyBase64: Buffer.alloc(32, 7).toString('base64'), inviteSecret: 'private-fixture-only' },
        findJoinedCanonical: async () => null,
        joinCanonical: async () => {
          state.joinCalls++;
          assert.equal(state.joinCalls, 1);
          assert.deepEqual(state.progress.filter(line => /^seed: corestore (verify|restore) /.test(line)), [
            'seed: corestore verify started', 'seed: corestore verify succeeded',
            'seed: corestore restore started', 'seed: corestore restore succeeded',
          ], 'join cannot precede real provider completion');
          const target = new Corestore(paths.targetStoreDir, { readOnly: true, wait: false });
          try {
            await target.ready();
            const core = target.get({ key: Buffer.from(coreKeyHex, 'hex'), valueEncoding: 'json' }) as unknown as FixtureCore;
            await core.ready();
            assert.equal(core.length, 2);
            state.restoredRecords = [await core.get(0, { wait: false }), await core.get(1, { wait: false })];
            assert.deepEqual(state.restoredRecords, records);
          } finally { await target.close(); }
          state.seedAfter = treeHash(seedDir);
          state.sourceAfter = treeHash(sourceDir);
          assert.equal(state.seedAfter, state.seedBefore);
          assert.equal(state.sourceAfter, state.sourceBefore);
          emit('held');
          await joined;
          return { state: 'joined', slug: 'private-bootstrap-fixture' };
        },
        recordProgress: (_step, _status, extra) => { if (extra?.detail) state.progress.push(extra.detail); },
        detectRoot: () => forbidden('detectRoot'), clone: async () => forbidden('clone'),
        ensureHive: async () => forbidden('ensureHive'), setHomeWorkspace: () => forbidden('setHomeWorkspace'),
        ensureWorkspaceListed: () => forbidden('ensureWorkspaceListed'), initSubmodules: () => forbidden('initSubmodules'),
        adoptShare: async () => forbidden('adoptShare'), goShare: async () => forbidden('goShare'),
        shareExisting: async () => forbidden('shareExisting'), submodulesNeedUpdate: async () => forbidden('submodulesNeedUpdate'),
        selfAdmitCanonical: async () => forbidden('selfAdmitCanonical'), bootActiveWorkspace: async () => forbidden('bootActiveWorkspace'),
        restoreDeferredGitSeed: async () => forbidden('restoreDeferredGitSeed'), scheduleGitSeedRetry: () => forbidden('scheduleGitSeedRetry'),
      });
      void ongoing.catch(() => { finish(); });
      return true;
    },
    release() { release(); return true; },
    finish() { setTimeout(finish, 250); return true; },
  };
  const watchdog = setTimeout(() => { watchdogFired = true; release(); finish(); }, 120_000);
  try {
    emit('ready');
    await finished;
    assert.ok(!watchdogFired, 'fixture observation deadline exceeded');
    assert.ok(ongoing);
    assert.equal((await ongoing).state, 'cloned-and-created');
    assert.equal(state.joinCalls, 1);
    assert.deepEqual(state.unexpectedEffects, []);
    emit('finished');
  } finally {
    release(); clearTimeout(watchdog); delete global[key];
  }
  } finally {
    // Even a setup/flag/identity failure must leave fixture-owned dirs removable.
    permissions(seedDir, false);
  }
}
