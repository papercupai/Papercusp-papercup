/** Synthetic identity transport for the isolated native Workbench suite only. */
import childProcess from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const nativeHiveSlugs = ['workbench-native', 'workbench-native-baseline', 'workbench-native-copy-baseline', 'workbench-native-mutant'];

/** Resolve the same per-DAO identity for registration, signing and epoch lookup. */
export function identityFixtureHive(fixture, slug) {
  if (!nativeHiveSlugs.includes(slug)) throw new Error('Synthetic fixture refuses unknown hive scope');
  const hive = slug === 'workbench-native'
    ? { ...fixture.hive, epoch0: fixture.hiveEpoch0 }
    : fixture.hives?.[slug];
  if (!hive || typeof hive.publicKey !== 'string' || Buffer.from(hive.publicKey, 'base64').length !== 32
    || typeof hive.privateKeyDer !== 'string' || typeof hive.epoch0 !== 'string' || Buffer.from(hive.epoch0, 'base64').length !== 32)
    throw new Error('Synthetic fixture has no hive identity for ' + slug);
  return hive;
}

/** Read the instance exported by the maintained verifier, never the caller's operator. */
export async function readNativeHostHealth(env = process.env) {
  if (!env.VERIFY_TAURI_DEV_URL) throw new Error('Native health proof requires VERIFY_TAURI_DEV_URL');
  const origin = new URL(env.VERIFY_TAURI_DEV_URL).origin;
  const response = await fetch(new URL('/api/health', origin), {
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (response.status !== 200) throw new Error('Native host health read failed: HTTP ' + response.status);
  return { origin, health: await response.json() };
}

export function prepareIdentityFixture(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pair = () => {
    const key = generateKeyPairSync('ed25519');
    return { publicKey: key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
      privateKeyDer: key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  };
  const runId = randomBytes(12).toString('hex');
  const actor = (githubUserId, githubLogin, email, keychainId) => ({ githubUserId, githubLogin,
    email, keychainId: keychainId + '-' + runId, device: pair(), token: 'synthetic-workbench-' + randomBytes(24).toString('hex') });
  const actors = {
    admin: actor(90007527, 'native-workbench-member', 'admin@daohr.test', 'dao-native-fixture-device'),
    approver: actor(90007528, 'native-workbench-approver', 'approver@daohr.test', 'dao-native-fixture-approver'),
    candidate: actor(90007529, 'native-workbench-candidate', 'candidate@daohr.test', 'dao-native-fixture-candidate'),
  };
  // Keep the original top-level identity for the existing Workbench journey.
  const fixture = { kind: 'dao-workbench-synthetic-identity-v1', ...actors.admin, actors, hive: pair(),
    hiveEpoch0: randomBytes(32).toString('base64'),
    hives: Object.fromEntries(nativeHiveSlugs.slice(1).map(slug => [slug,
      { ...pair(), epoch0: randomBytes(32).toString('base64') }])) };
  const path = join(directory, 'identity.json');
  writeFileSync(path, JSON.stringify(fixture), { mode: 0o600 });
  writeAnnounce(directory, actors.admin);
  return path;
}

function writeAnnounce(directory, actor) {
  const path = join(directory, 'announce.json');
  // One atomic cache replacement selects both the GitHub transport and signer.
  const pending = path + '.next';
  writeFileSync(pending, JSON.stringify({ version: 1, savedAt: Date.now(),
    githubUserId: actor.githubUserId, githubLogin: actor.githubLogin, keychainId: actor.keychainId,
    devicePubkeyBase64: actor.device.publicKey, attestationGistId: 'synthetic-native-gist' }), { mode: 0o600 });
  renameSync(pending, path);
}

/** Switch credentials only; the native journey still performs all product actions through its UI. */
export function selectIdentityFixtureActor(path, name, env = process.env) {
  if (env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1')
    throw new Error('Synthetic Workbench actor selection requires explicit isolated native verification');
  const fixture = JSON.parse(readFileSync(path, 'utf8'));
  const actor = fixture.kind === 'dao-workbench-synthetic-identity-v1' && fixture.actors?.[name];
  if (!actor) throw new Error('Unknown synthetic Workbench actor');
  writeAnnounce(dirname(path), actor);
}

export function installIdentityFixture(fixture, env = process.env) {
  if (env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1' || fixture.kind !== 'dao-workbench-synthetic-identity-v1')
    throw new Error('Synthetic Workbench identity requires explicit isolated native verification');
  const originalExec = childProcess.execFile;
  const originalFetch = globalThis.fetch;
  const priorToken = Object.getOwnPropertyDescriptor(globalThis, '__ghAuthToken');
  const actors = Object.values(fixture.actors ?? { admin: fixture });
  const tokenFor = actor => actor.token ?? 'synthetic-workbench-token';
  const activeActor = () => {
    if (!env.DAO_WORKBENCH_IDENTITY_FIXTURE) return fixture;
    const announce = JSON.parse(readFileSync(join(dirname(env.DAO_WORKBENCH_IDENTITY_FIXTURE), 'announce.json'), 'utf8'));
    const actor = actors.find(actor => actor.githubUserId === announce.githubUserId
      && actor.keychainId === announce.keychainId && actor.device.publicKey === announce.devicePubkeyBase64);
    if (!actor) throw new Error('Synthetic fixture refuses an unknown announce identity');
    return actor;
  };
  // getGhAuthToken reads this on every call. Rotating the token makes the real
  // 60-second resolveLocalGithubIdentity cache miss without resetting it.
  Object.defineProperty(globalThis, '__ghAuthToken', { configurable: true,
    get: () => ({ token: tokenFor(activeActor()), fetchedAt: Date.now(), githubLogin: env.PAPERCUSP_GITHUB_LOGIN || null }),
    set: () => {},
  });
  const intercepted = (file, args) => {
    if (file === 'gh') {
      if (args[0] === 'auth' && args[1] === 'token') return { stdout: tokenFor(activeActor()) + '\n', stderr: '' };
      throw new Error('Synthetic fixture refuses other GitHub CLI commands');
    }
    if (file !== 'secret-tool' && file !== 'security') return null;
    if (file !== 'secret-tool' || args[0] !== 'lookup') throw new Error('Synthetic fixture refuses OS keychain writes');
    const account = args[args.indexOf('account') + 1];
    const service = args[args.indexOf('service') + 1];
    const actor = actors.find(actor => actor.keychainId === account);
    if (actor && service === 'papercusp-device-keypair')
      return { stdout: actor.device.privateKeyDer, stderr: '' };
    const hiveAccount = /^hive:verify-tauri-isolated-\d+:(workbench-native(?:-(?:baseline|copy-baseline|mutant))?)$/.exec(account);
    if (hiveAccount && service === 'papercusp-hive-keypair')
      return { stdout: identityFixtureHive(fixture, hiveAccount[1]).privateKeyDer, stderr: '' };
    // The owned hive's canonical scope is its home slug. Member admission
    // distributes its existing epoch zero; the request-only sidecar cannot mint it.
    const epochAccount = /^(workbench-native(?:-(?:baseline|copy-baseline|mutant))?):0$/.exec(account);
    if (epochAccount && service === 'papercusp-hive-epoch-key')
      return { stdout: identityFixtureHive(fixture, epochAccount[1]).epoch0, stderr: '' };
    throw new Error('Synthetic fixture refuses unknown keychain identity');
  };
  const replacement = function(file, args = [], ...rest) {
    if (!['gh', 'secret-tool', 'security'].includes(file)) return originalExec.call(this, file, args, ...rest);
    const callback = rest.findLast(value => typeof value === 'function');
    queueMicrotask(() => {
      try { const result = intercepted(file, args); callback?.(null, result.stdout, result.stderr); }
      catch (error) { callback?.(error, '', ''); }
    });
    return new EventEmitter();
  };
  replacement[promisify.custom] = async (file, args = [], ...rest) => {
    if (!['gh', 'secret-tool', 'security'].includes(file)) return promisify(originalExec)(file, args, ...rest);
    return intercepted(file, args);
  };
  childProcess.execFile = replacement;
  syncBuiltinESMExports();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.github.com') return originalFetch(input, init);
    if (!['/user', '/user/emails'].includes(url.pathname) || (init?.method || (input instanceof Request ? input.method : 'GET')) !== 'GET')
      throw new Error('Synthetic fixture refuses outbound GitHub requests');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const actor = actors.find(actor => ['token ' + tokenFor(actor), 'Bearer ' + tokenFor(actor)].includes(headers.get('authorization')));
    if (!actor)
      throw new Error('Synthetic fixture refuses real GitHub credentials');
    if (url.pathname === '/user/emails') {
      if (!actor.email) throw new Error('Synthetic fixture has no verified email');
      return Response.json([{ email: actor.email, verified: true, primary: true, visibility: 'private' }]);
    }
    return Response.json({ id: actor.githubUserId, login: actor.githubLogin });
  };
  return () => {
    childProcess.execFile = originalExec; syncBuiltinESMExports(); globalThis.fetch = originalFetch;
    if (priorToken) Object.defineProperty(globalThis, '__ghAuthToken', priorToken);
    else delete globalThis.__ghAuthToken;
  };
}

if (process.argv.includes('--prepare')) {
  console.log(prepareIdentityFixture(process.argv[process.argv.indexOf('--prepare') + 1]));
} else if (process.env.DAO_WORKBENCH_IDENTITY_FIXTURE) {
  const path = process.env.DAO_WORKBENCH_IDENTITY_FIXTURE;
  process.env.PAPERCUSP_ANNOUNCE_IDENTITY_CACHE = join(dirname(path), 'announce.json');
  process.env.PAPERCUSP_IDENTITY_MODE = 'load-only';
  installIdentityFixture(JSON.parse(readFileSync(path, 'utf8')));
}
