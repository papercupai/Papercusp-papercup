import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db-encryption', () => ({ dbEncryptionKeyFilePath: () => '/mounted/secrets/db-key' }));
vi.mock('../superuser-token', () => ({ superuserTokenPath: () => '/scoped/home/superuser-token' }));
vi.mock('../workspace-registry', () => ({
  workspacesRoot: () => '/relocated/workspaces',
  readRegistry: () => ({ workspaces: [{ id: 'registered-project' }] }),
}));
vi.mock('../scratch-uri', () => ({ scratchRoot: () => '/relocated/cache/spills' }));
vi.mock('../oauth/providers', () => ({ googleOAuthClientPath: () => '/fixture/config/papercusp/google-oauth-client.json' }));
vi.mock('../identity/keychain', () => ({ identityDir: () => '/fixture/sensitive/identity' }));
vi.mock('../cupboard/ledger-anchor-eas', () => ({ anchorKeyFilePath: () => '/fixture/sensitive/anchor-key' }));
vi.mock('../papercusp-root', () => ({ papercuspRoot: () => '/relocated/workspaces/registered-project/.papercusp' }));
import { databaseCensusEntries, physicalDatabaseCensusEntries, integrationBaselineCensusDeclarations, secretCensusProducers, unitCensusEntries, unitCensusDeclarations, verifyHostStateCensus, workspaceRegistryCensusProducer, scratchCensusProducer, installedRootCensusProducers, mergeNestedCensusRoots, postgresStorageDeclaration, gitStorageDeclaration } from './state-census-producers';
import { mkdtemp, writeFile, rm, symlink, readFile, mkdir, chmod, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CensusDeclaration } from '@papercusp/backup';
import { collectStateCensus } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { templateDatabaseCensusDeclarations, maintenanceDatabaseCensusDeclarations } from './state-census-producers';
import { hostedConfigurationCensusProducers, configuredOperatorDatabaseCensusDeclarations, unitDatabaseCensusDeclarations } from './state-census-producers';
import { migrationProducerTables, migrationDatabaseCensusDeclarations, registeredProjectMigrationSources, sqlMigrationCensusSource, canonicalSqlMigrationCensusSources } from './state-census-producers';
import { identityKeychainCensusProducer, anchorSecretCensusProducer, runtimeRetainedCensusProducer, accountCredentialCensusProducer, runtimeSidefileCensusProducer, cliSetupHomeCensusProducer, templateStoreCensusProducer } from './state-census-producers';
import { peerStorageDeclaration, portalReleaseStorageDeclaration, restoredCloneCensusDeclarations, stripRangeCacheCensusProducer, virtualenvCacheDeclaration, affectedTestCacheCensusProducer } from './state-census-producers';
import { planTemplateStoreCensusProducer, historicalGitBlobIdentityResolver, workspaceTemplateStoreCensusProducer } from './state-census-producers';
import { execFileSync } from 'node:child_process';
import { reapArchiveCensusProducer } from './state-census-producers';
import { archiveReapTail, REAP_TAIL_MAX_BYTES } from '../task-manager/reap-archive';
import { historicalHostedProfileConstruction, historicalHostedProfileCensusProducer } from './state-census-producers';
import { historicalPlaywrightStateConstruction, historicalPlaywrightStateCensusProducer, recoverHistoricalCensusWriterEvidence } from './state-census-producers';
import { createCipheriv, scryptSync, randomBytes, createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

describe('historical hosted profile construction proof', () => {
  // The measured archived writer, with relocated names to prove that attribution
  // depends on command semantics and current content, not a filename roster.
  const program = `import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createCipheriv,scryptSync,randomBytes} from 'node:crypto';
import {hostname,userInfo} from 'node:os';
import {runInNewContext} from 'node:vm';
const fixture=resolve(userInfo().homedir,'.config/papercusp/arbitrary-input.json');
const destination=resolve(userInfo().homedir,'.config/papercusp/arbitrary-profile.enc');
if(existsSync(destination)) throw new Error('Destination exists: inspect before overwrite');
if((statSync(fixture).mode&0o777)!==0o600) throw new Error('Fixture must remain private');
const source=readFileSync('node_modules/verdict-cli/src/server.mjs','utf8');
const start=source.indexOf('const MACHINE_KEY =');
const end=source.indexOf('function decryptData',start);
const encrypt=runInNewContext(source.slice(start,end)+'\\nencryptData;', {hostname,userInfo,scryptSync,randomBytes,createCipheriv,Buffer});
const state=JSON.parse(readFileSync(fixture,'utf8'));
writeFileSync(destination,encrypt({cookies:state.cookies,storage:{localStorage:{},sessionStorage:{}},url:'https://example.test/',savedAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({profile:destination,mode:'0600',cookieCount:state.cookies.length,expirationPreserved:true,valuesPrinted:false}));`;
  const input = (source = program) => `text(await tools.exec_command({cmd:${JSON.stringify("node --input-type=module <<'JS'\n" + source + '\nJS')},yield_time_ms:30000,max_output_tokens:1000}));`;
  it('rejects altered programs, extra writes, unquoted heredocs and paths outside the configuration root', () => {
    expect(historicalHostedProfileConstruction(input(), '/fixture')).toMatchObject({
      input: '/fixture/.config/papercusp/arbitrary-input.json', output: '/fixture/.config/papercusp/arbitrary-profile.enc', url: 'https://example.test/',
    });
    for (const changed of [program + "\nwriteFileSync(destination,'other');", program.replace('cookies:state.cookies', 'cookies:[]'),
      program.replace('arbitrary-profile.enc', '../../outside.enc'), program.replace("flag:'wx'", "flag:'w'")]) {
      expect(historicalHostedProfileConstruction(input(changed), '/fixture')).toBeNull();
    }
    expect(historicalHostedProfileConstruction(input().replace("<<'JS'", '<<JS'), '/fixture')).toBeNull();
    expect(historicalHostedProfileConstruction(input() + '\ntext(await tools.exec_command({cmd:"verdict --session pilot snapshot -i"}));', '/fixture')).not.toBeNull();
    expect(historicalHostedProfileConstruction(input() + '\ntext(await tools.exec_command({cmd:"rm .config/papercusp/arbitrary-profile.enc"}));', '/fixture')).toBeNull();
  });
  it('qualifies only current private content matching the full historical transform and time window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hosted-profile-proof-'));
    const config = join(home, '.config', 'papercusp');
    const cookies = [{ name: 'session', value: 'private-value', expires: 1234 }];
    const value = { cookies, storage: { localStorage: {}, sessionStorage: {} }, url: 'https://example.test/', savedAt: '2026-09-05T19:50:00Z' };
    const evidence = [{ ref: 'fixture:writer:38', toolInput: input(), startedAt: '2026-09-05T19:49:59Z', finishedAt: '2026-09-05T19:50:01Z' }];
    const output = join(config, 'arbitrary-profile.enc');
    const writeProfile = async (profile: object) => {
      const iv = randomBytes(16); const key = scryptSync(`${hostname()}-${userInfo().username}-verdict-cli`, 'verdict-cli-salt-v1', 32);
      const cipher = createCipheriv('aes-256-cbc', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(profile), 'utf8'), cipher.final()]);
      await writeFile(output, JSON.stringify({ iv: iv.toString('hex'), data: data.toString('hex') }), { mode: 0o600 });
    };
    try {
      await mkdir(config, { recursive: true });
      await writeFile(join(config, 'arbitrary-input.json'), JSON.stringify({ cookies, origins: [{ origin: 'https://example.test/' }] }), { mode: 0o600 });
      await writeFile(join(config, 'neighbor.enc'), 'unproven', { mode: 0o600 });
      await writeProfile(value);
      const result = await historicalHostedProfileCensusProducer(evidence, home);
      expect(result.declarations).toEqual([{ kind: 'path', root: 'hosted-profile-0', name: 'arbitrary-profile.enc', classification: 'secret', producer: 'historical-hosted-profile:fixture:writer:38' }]);
      expect(JSON.stringify(result)).not.toContain('private-value');
      const manifest = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(manifest.residue.map(entry => entry.name)).toContain('neighbor.enc');
      expect(manifest.residue.map(entry => entry.name)).toContain('arbitrary-input.json');
      for (const changed of [{ ...value, cookies: [] }, { ...value, savedAt: '2026-09-06T00:00:00Z' },
        { ...value, url: 'https://elsewhere.test/' }, { ...value, storage: { localStorage: { unexpected: 'value' }, sessionStorage: {} } },
        { ...value, unexpected: true }]) {
        await writeProfile(changed);
        expect((await historicalHostedProfileCensusProducer(evidence, home)).declarations).toEqual([]);
      }
      await writeProfile(value); await chmod(output, 0o644);
      expect((await historicalHostedProfileCensusProducer(evidence, home)).declarations).toEqual([]);
      await rm(output); await symlink(join(config, 'neighbor.enc'), output);
      expect((await historicalHostedProfileCensusProducer(evidence, home)).declarations).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe('historical Playwright storage-state proof', () => {
  // SHA-verified archived custom_tool_call, relocated to prove semantic ownership.
  const archivedInput = "const r=await tools.exec_command({\n  cmd:\"node - <<'NODE'\\nconst { chromium }=require('./node_modules/@playwright/test');\\nconst fs=require('fs');\\nconst identity=JSON.parse(fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/identity.json','utf8'));\\nconst password=fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/password','utf8').trim();\\nconst statePath='/fixture/.config/papercusp/arbitrary-browser.json';\\n(async()=>{\\n  const browser=await chromium.launch({headless:true,proxy:{server:'socks5://127.0.0.1:18029'}});\\n  const c=await browser.newContext({serviceWorkers:'block'});const p=await c.newPage();\\n  await p.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces',{waitUntil:'domcontentloaded',timeout:60000});\\n  for(let i=0;i<3;i++){\\n    const pw=p.locator('input[type=password],input[name=password]').first();if(await pw.isVisible().catch(()=>false))break;\\n    const em=p.locator('input[name=email],input[type=email]').first();await em.waitFor({state:'visible',timeout:30000});await em.fill(identity.email);\\n    await p.getByRole('button',{name:/continue with email|continue|sign in/i}).first().click();await p.waitForTimeout(2500);\\n  }\\n  const pw=p.locator('input[type=password],input[name=password]').first();await pw.waitFor({state:'visible',timeout:30000});await pw.fill(password);\\n  await p.getByRole('button',{name:/sign in|continue/i}).first().click();\\n  await p.waitForURL(u=>u.hostname==='app.papercusp.com'&&u.pathname!=='/api/hosted/auth/callback',{timeout:60000,waitUntil:'domcontentloaded'});\\n  const session=await p.evaluate(async()=>{const r=await fetch('/api/hosted/auth/session',{cache:'no-store'});const b=await r.json().catch(()=>null);return{status:r.status,ok:b?.ok===true,session:b?.session?{workspaceId:b.session.workspaceId??null,organizationId:b.session.organizationId??null,expiresAtMs:b.session.expiresAtMs??null,sessionVersion:b.session.sessionVersion??null}:null,error:b?.error??null}});\\n  await c.storageState({path:statePath});fs.chmodSync(statePath,0o600);const st=fs.statSync(statePath);\\n  console.log(JSON.stringify({final:{host:new URL(p.url()).host,path:new URL(p.url()).pathname},session,storageState:{path:statePath,mode:(st.mode&0o777).toString(8),bytes:st.size}},null,2));\\n  await browser.close();\\n})().catch(e=>{console.error(JSON.stringify({error:String(e),name:e?.name||null}));process.exit(1)});\\nNODE\",\n  workdir:\"/fixture/papercupai-workspace/papercusp\",\n  yield_time_ms:30000,max_output_tokens:3000\n}); text(r.output);\n";
  it('recognizes the complete measured writer and rejects changed semantics or additional commands', () => {
    expect(historicalPlaywrightStateConstruction(archivedInput, '/fixture')).toEqual({ output: '/fixture/.config/papercusp/arbitrary-browser.json' });
    for (const changed of [
      archivedInput.replace('0o600', '0o644'),
      archivedInput.replace('storageState({path:statePath})', 'storageState({path:identity})'),
      archivedInput.replace('arbitrary-browser.json', '../../outside.json'),
      archivedInput.replace("<<'NODE'", '<<NODE'),
      archivedInput.slice(0, 1000),
      archivedInput + '\nawait tools.exec_command({cmd:"rm /fixture/.config/papercusp/arbitrary-browser.json"});',
    ]) expect(historicalPlaywrightStateConstruction(changed, '/fixture')).toBeNull();
  });
  it('resolves a const command only within the exact successful-envelope polling wrapper', () => {
    const command = JSON.parse(archivedInput.match(/cmd:("(?:[^"\\]|\\.)*")/)![1]);
    const wrapped = `const cmd = ${JSON.stringify(command)};
let r=await tools.exec_command({cmd,workdir:'/fixture/papercupai-workspace/papercusp',yield_time_ms:30000,max_output_tokens:3000});
while('session_id'in r&&!Object.prototype.hasOwnProperty.call(r,'exit_code'))r=await tools.write_stdin({session_id:r.session_id,chars:'',yield_time_ms:30000,max_output_tokens:3000});
text(r);`;
    expect(historicalPlaywrightStateConstruction(wrapped, '/fixture')).toEqual({ output: '/fixture/.config/papercusp/arbitrary-browser.json' });
    for (const altered of [wrapped.replace('const cmd', 'let cmd'),
      wrapped.replace('text(r);', 'text(r); cmd = "other";'),
      wrapped.replace('chars:\'\'', 'chars:\'overwrite\''),
      wrapped.replace('0o600', '0o644'),
      wrapped.replace('max_output_tokens:3000', 'max_output_tokens:1')]) {
      expect(historicalPlaywrightStateConstruction(altered, '/fixture')).toBeNull();
    }
  });
  it('recognizes the SHA-verified Sept6 whole writer while rejecting changed authentication and writes', async () => {
    const input = "const cmd = \"node - <<'NODE'\\nconst { chromium } = require('./node_modules/@playwright/test');\\nconst fs = require('fs');\\nconst crypto = require('crypto');\\nconst identity = JSON.parse(fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/identity.json', 'utf8'));\\nconst password = fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/password', 'utf8').trim();\\nconst statePath = '/fixture/.config/papercusp/p031-hosted-storage-state.json';\\n(async () => {\\n  const startedAt = Date.now();\\n  const browser = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:18029' } });\\n  try {\\n    const context = await browser.newContext({ serviceWorkers: 'block' });\\n    const page = await context.newPage();\\n    await page.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces', { waitUntil: 'domcontentloaded', timeout: 60000 });\\n    const editableEmail = page.locator('input[name=email]:not([readonly]),input[type=email]:not([readonly])').first();\\n    const passwordInput = page.locator('input[type=password],input[name=password]').first();\\n    await Promise.race([editableEmail.waitFor({ state: 'visible', timeout: 30000 }), passwordInput.waitFor({ state: 'visible', timeout: 30000 })]);\\n    if (await editableEmail.isVisible().catch(() => false)) {\\n      await editableEmail.fill(identity.email);\\n      await page.getByRole('button', { name: /continue with email|continue|sign in/i }).first().click();\\n    }\\n    await passwordInput.waitFor({ state: 'visible', timeout: 30000 });\\n    await passwordInput.fill(password);\\n    await page.getByRole('button', { name: /sign in|continue/i }).first().click();\\n    await page.waitForURL((url) => url.hostname === 'app.papercusp.com', { timeout: 60000 });\\n    let session = null;\\n    for (let attempt = 0; attempt < 30; attempt += 1) {\\n      const response = await context.request.get('https://app.papercusp.com/api/hosted/auth/session', { failOnStatusCode: false });\\n      const body = await response.json().catch(() => null);\\n      if (response.status() === 200 && body?.ok === true && body?.session?.sessionId && body?.session?.userId && body?.session?.organizationId) {\\n        session = body.session;\\n        break;\\n      }\\n      await page.waitForTimeout(1000);\\n    }\\n    if (!session) throw new Error('authenticated session metadata did not become available');\\n    await context.storageState({ path: statePath });\\n    fs.chmodSync(statePath, 0o600);\\n    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));\\n    const appCookie = saved.cookies.find((cookie) => cookie.name === '__Host-papercusp_session');\\n    console.log(JSON.stringify({\\n      ok: true,\\n      statePath,\\n      mode: (fs.statSync(statePath).mode & 0o777).toString(8),\\n      sessionHash: crypto.createHash('sha256').update(session.sessionId).digest('hex').slice(0, 12),\\n      userPresent: Boolean(session.userId),\\n      organizationPresent: Boolean(session.organizationId),\\n      workspaceBound: Boolean(session.workspaceId),\\n      cookiePresent: Boolean(appCookie),\\n      cookieExpires: appCookie?.expires ?? null,\\n      durationMs: Date.now() - startedAt,\\n    }));\\n  } finally {\\n    await browser.close();\\n  }\\n})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });\\nNODE\";\nlet r=await tools.exec_command({cmd,workdir:\"/fixture/papercupai-workspace/papercusp\",yield_time_ms:30000,max_output_tokens:3000});\nwhile(\"session_id\"in r&&!Object.prototype.hasOwnProperty.call(r,\"exit_code\"))r=await tools.write_stdin({session_id:r.session_id,chars:\"\",yield_time_ms:30000,max_output_tokens:3000});\ntext(r);\n";
    expect(historicalPlaywrightStateConstruction(input, '/fixture')).toEqual({ output: '/fixture/.config/papercusp/p031-hosted-storage-state.json' });
    for (const changed of [
      input.replace('body?.session?.organizationId', 'body?.session?.workspaceId'),
      input.replace('await context.storageState', 'await context.clearCookies(); await context.storageState'),
      input.replace('0o600', '0o644'),
      input.replace('app.papercusp.com/api/hosted/auth/session', 'elsewhere.test/api/hosted/auth/session'),
      input.replace("update(session.sessionId)", "update(session.userId)"),
      input.replace('process.exitCode = 1', 'process.exitCode = 0'),
    ]) expect(historicalPlaywrightStateConstruction(changed, '/fixture')).toBeNull();
    // This writer proves construction, but its receipt cannot bind every cookie
    // and local-storage value to the installed file. Session identity is insufficient.
    const home = await mkdtemp(join(tmpdir(), 'sept6-state-proof-'));
    const output = join(home, '.config', 'papercusp', 'p031-hosted-storage-state.json');
    const startedAt = '2026-09-06T12:00:00Z';
    const finishedAt = '2026-09-06T12:00:30Z';
    const cookie = { name: '__Host-papercusp_session', value: 'fixture-session', domain: 'app.papercusp.com',
      path: '/', expires: 1789000000, httpOnly: true, secure: true, sameSite: 'Lax' };
    const receipt = { ok: true, statePath: output, mode: '600',
      sessionHash: createHash('sha256').update(cookie.value).digest('hex').slice(0, 12),
      userPresent: true, organizationPresent: true, workspaceBound: true,
      cookiePresent: true, cookieExpires: cookie.expires, durationMs: 1000 };
    const record = { ref: 'archive:sept6:full-writer',
      toolInput: input.replaceAll('/fixture', home), startedAt, finishedAt, receipt: JSON.stringify(receipt) };
    try {
      await mkdir(join(home, '.config', 'papercusp'), { recursive: true });
      expect(historicalPlaywrightStateConstruction(record.toolInput, home)).toEqual({ output });
      for (const state of [
        { cookies: [cookie], origins: [] },
        { cookies: [cookie, { ...cookie, name: 'unbound', value: 'different-cookie' }], origins: [] },
        { cookies: [cookie], origins: [{ origin: 'https://app.papercusp.com',
          localStorage: [{ name: 'unbound', value: 'different-storage' }] }] },
      ]) {
        await writeFile(output, JSON.stringify(state), { mode: 0o600 });
        await utimes(output, new Date(startedAt), new Date(startedAt));
        expect(await historicalPlaywrightStateCensusProducer([record], home)).toEqual({ roots: [], declarations: [] });
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('recovers full custom/native calls by timestamp and call id from verified source, rejecting corrupt and ambiguous archives', async () => {
    const candidate = { ref: 'indexed:part121', sessionId: 'native-session', toolInput: archivedInput.slice(0, 1000),
      startedAt: '2026-09-05T19:49:31.511Z', finishedAt: '2026-09-05T19:49:41.364Z' };
    const receipt = JSON.stringify({ storageState: { mode: '600', bytes: 6625 } });
    const writer = { type: 'response_item', timestamp: candidate.startedAt,
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'writer-call', input: archivedInput } };
    const output = { type: 'response_item', timestamp: candidate.finishedAt,
      payload: { type: 'custom_tool_call_output', call_id: 'writer-call', output: [{ type: 'input_text', text: receipt }] } };
    const source = (...rows: object[]) => {
      const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const unrelated = { ...output, payload: { ...output.payload, call_id: 'another-call', output: [{ type: 'input_text', text: 'unrelated' }] } };
    const read = vi.fn(async () => source(writer, unrelated, output));
    const recovered = await recoverHistoricalCensusWriterEvidence([candidate], read);
    expect(read).toHaveBeenCalledExactlyOnceWith('native-session');
    expect(recovered).toMatchObject([{ indexedRef: candidate.ref, toolInput: archivedInput, receipt, startedAt: candidate.startedAt, finishedAt: candidate.finishedAt }]);
    expect(recovered[0].ref).toContain(':line:1:call:writer-call');
    expect(historicalPlaywrightStateConstruction(recovered[0].toolInput, '/fixture')).not.toBeNull();
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, unrelated))).toEqual([]);
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, output, output))).toEqual([]);
    expect(await recoverHistoricalCensusWriterEvidence([{ ...candidate, startedAt: '2026-09-06T00:00:00Z' }], read)).toEqual([]);
    await expect(recoverHistoricalCensusWriterEvidence([candidate], async () => ({ ...source(writer, output), sha256: '0'.repeat(64) }))).rejects.toThrow('SHA/size mismatch');
    await expect(recoverHistoricalCensusWriterEvidence([candidate], async () => { throw new Error('canonical native archive sha mismatch'); })).rejects.toThrow('sha mismatch');
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => { throw new Error('canonical codex archive not found'); })).toEqual([]);
    const native = { ...writer, payload: { type: 'function_call', name: 'exec', call_id: 'writer-call', arguments: JSON.stringify({ code: archivedInput }) } };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(native, output)))[0].toolInput).toBe(archivedInput);
    const nestedOutput = (envelope: object) => ({ ...output, payload: { ...output.payload,
      output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' },
        { type: 'input_text', text: JSON.stringify(envelope) }] } });
    const envelope = { exit_code: 0, output: receipt + '\n', chunk_id: 'completed-command' };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(envelope))))[0].receipt).toBe(receipt);
    const sessionReceipt = { ok: true, statePath: '/fixture/.config/papercusp/arbitrary-browser.json',
      mode: '600', sessionHash: '33cd423ed43d' };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer,
      nestedOutput({ ...envelope, output: JSON.stringify(sessionReceipt) }))))[0].receipt).toBe(JSON.stringify(sessionReceipt));
    const stripeReceipt = { accountId: 'acct_fixture', accountName: 'Fixture', mode: 'test',
      plans: [{ planKey: 'cloud', priceId: 'price_fixture', productId: 'prod_fixture', label: 'Cloud', description: 'Fixture' }],
      portalConfigurationId: 'bpc_fixture', webhookEndpointId: 'we_fixture', webhookUrl: 'https://example.test/hook', workItem: 'WI-fixture' };
    const stripeEnvelope = { ...envelope, output: JSON.stringify(stripeReceipt) };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer,
      nestedOutput(stripeEnvelope))))[0].receipt).toBe(JSON.stringify(stripeReceipt));
    for (const invalid of [{ ...stripeEnvelope, exit_code: 1 }, { ...stripeEnvelope, session_id: 123 },
      { ...stripeEnvelope, output: JSON.stringify({ ...stripeReceipt, mode: 'live' }) },
      { ...stripeEnvelope, output: JSON.stringify({ ...stripeReceipt, plans: [{}] }) }]) {
      expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(invalid))))[0].receipt).toBe('');
    }
    for (const invalid of [{ ...envelope, exit_code: 1 }, { output: receipt, session_id: 123 },
      { ...envelope, session_id: 123 }, { ...envelope, output: 'not JSON' }, { ...envelope, output: 'null' },
      { value: envelope }]) {
      expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(invalid))))[0].receipt).toBe('');
    }
    const ambiguousOutput = { ...output, payload: { ...output.payload, output: [
      { type: 'input_text', text: receipt }, { type: 'input_text', text: JSON.stringify(envelope) }] } };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, ambiguousOutput)))[0].receipt).toBe('');
  });
  it('requires a matching successful receipt, private no-follow file and original write window without exposing values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'playwright-state-proof-'));
    const config = join(home, '.config', 'papercusp'); const output = join(config, 'arbitrary-browser.json');
    const state = { cookies: [{ name: 'session', value: 'sensitive-test-cookie', domain: 'app.papercusp.com', path: '/',
      expires: 1788638077, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
    const body = JSON.stringify(state);
    const receipt = { final: { host: 'app.papercusp.com', path: '/cloud-workspaces' },
      session: { status: 200, ok: true, error: null }, storageState: { path: output, mode: '600', bytes: Buffer.byteLength(body) } };
    const record = { ref: 'archive:sha:line463:call-id', toolInput: archivedInput.replaceAll('/fixture/.config/papercusp/arbitrary-browser.json', output),
      startedAt: '2026-09-05T19:49:31.511Z', finishedAt: '2026-09-05T19:49:41.364Z', receipt: JSON.stringify(receipt) };
    try {
      await mkdir(config, { recursive: true }); await writeFile(output, body, { mode: 0o600 });
      await utimes(output, new Date('2026-09-05T19:49:40Z'), new Date('2026-09-05T19:49:40Z'));
      const result = await historicalPlaywrightStateCensusProducer([record], home);
      expect(result.declarations).toEqual([{ kind: 'path', root: 'playwright-state-0', name: 'arbitrary-browser.json',
        classification: 'secret', producer: 'historical-playwright-storage-state:archive:sha:line463:call-id' }]);
      expect(JSON.stringify(result)).not.toContain('sensitive-test-cookie');
      expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: 'null' }], home)).declarations).toEqual([]);
      for (const altered of [
        { ...receipt, session: { status: 401, ok: false, error: 'unauthorized' } },
        { ...receipt, storageState: { ...receipt.storageState, bytes: body.length + 1 } },
        { ...receipt, storageState: { ...receipt.storageState, path: join(config, 'neighbor.json') } },
      ]) expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify(altered) }], home)).declarations).toEqual([]);
      await chmod(output, 0o644);
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await chmod(output, 0o600); await utimes(output, new Date(), new Date());
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await rm(output); await writeFile(join(config, 'neighbor.json'), body, { mode: 0o600 }); await symlink(join(config, 'neighbor.json'), output);
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await rm(output); await writeFile(output, 'invalid json', { mode: 0o600 }); await utimes(output, new Date(record.startedAt), new Date(record.startedAt));
      expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify({ ...receipt, storageState: { ...receipt.storageState, bytes: 12 } }) }], home)).declarations).toEqual([]);
      for (const invalid of [null, { cookies: [null], origins: [] }, { ...state, origins: [null] }, { ...state, cookies: [{ ...state.cookies[0], domain: 'elsewhere.test' }] }]) {
        const content = JSON.stringify(invalid); await writeFile(output, content);
        await utimes(output, new Date(record.startedAt), new Date(record.startedAt));
        expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify({ ...receipt, storageState: { ...receipt.storageState, bytes: Buffer.byteLength(content) } }) }], home)).declarations).toEqual([]);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe('reaper archive writer census', () => {
  it('looks up old archive identities in bounded exact batches and rejects unrelated returned ids', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-lookup-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive', '2026-10-11');
      await mkdir(archive, { recursive: true });
      await Promise.all(Array.from({ length: 1001 }, (_, n) => writeFile(join(archive, `old-${n}.tail.log`), 'tail')));
      const lookup = vi.fn(async (ids: string[]) => ids.includes('old-0') ? ['old-0', 'unrequested'] : []);
      const result = await reapArchiveCensusProducer(home, [], lookup);
      expect(lookup.mock.calls.map(([ids]) => ids.length)).toEqual([1000, 1]);
      expect(new Set(lookup.mock.calls.flatMap(([ids]) => ids)).size).toBe(1001);
      const tails = result.declarations.filter(row => row.name.endsWith('.tail.log')).map(row => row.name);
      expect(tails).toEqual(['reap-archive/2026-10-11/old-0.tail.log']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('verifies writer receipts after ledger GC and exposes corrupt, mismatched and linked receipts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-receipt-'));
    try {
      const source = join(home, 'source.log');
      await writeFile(source, Buffer.alloc(REAP_TAIL_MAX_BYTES + 20, 'x'));
      const tail = await archiveReapTail('expired-task', source, home, new Date('2026-10-11T12:00:00Z'));
      expect((await readFile(tail)).length).toBe(REAP_TAIL_MAX_BYTES);
      const receiptPath = `${tail}.receipt.json`;
      const original = await readFile(receiptPath, 'utf8');
      const names = async () => (await reapArchiveCensusProducer(home, [])).declarations.map(row => row.name);
      expect(await names()).toContain('reap-archive/2026-10-11/expired-task.tail.log');
      expect(await names()).toContain('reap-archive/2026-10-11/expired-task.tail.log.receipt.json');
      await writeFile(tail, Buffer.alloc(REAP_TAIL_MAX_BYTES, 'y'));
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(tail, Buffer.alloc(REAP_TAIL_MAX_BYTES, 'x'));
      await writeFile(receiptPath, original.replace('expired-task', 'another-task'));
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(receiptPath, 'null');
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(source, original);
      await rm(receiptPath);
      await symlink(source, receiptPath);
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await expect(archiveReapTail('../escape', source, home)).rejects.toThrow('Invalid reaper task id');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('requires retained task identity, regular files and the writer size bound for tails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-census-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive', '2026-10-11');
      await mkdir(archive, { recursive: true });
      await writeFile(join(archive, 'known.tail.log'), 'tail');
      await writeFile(join(archive, 'unknown.tail.log'), 'tail');
      await writeFile(join(archive, 'large.tail.log'), Buffer.alloc(128 * 1024 + 1));
      await symlink(join(archive, 'known.tail.log'), join(archive, 'linked.tail.log'));
      await mkdir(join(archive, 'directory.tail.log'));
      const result = await reapArchiveCensusProducer(home, ['known', 'large', 'linked', 'directory', '../unknown']);
      expect(result.declarations.map(row => row.name)).toEqual([
        'reap-archive', 'reap-archive/2026-10-11', 'reap-archive/2026-10-11/known.tail.log',
      ]);
      expect(result.declarations.every(row => !row.descendants)).toBe(true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('uses OS home and leaves links, invalid dates and unproven tails as residue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-census-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive');
      await mkdir(join(archive, '2026-10-11'), { recursive: true });
      await mkdir(join(archive, '2026-02-30'));
      await mkdir(join(archive, 'unexpected'));
      await writeFile(join(archive, '2026-10-11', 'unknown.tail.log'), 'fixture');
      await symlink(join(archive, '2026-10-11'), join(archive, '2026-10-12'));
      const producer = await reapArchiveCensusProducer(home);
      expect(producer.roots[0].path).toBe(join(home, '.papercusp'));
      expect(producer.declarations.map(row => row.name)).toEqual(['reap-archive', 'reap-archive/2026-10-11']);
      expect(producer.declarations.every(row => !row.descendants)).toBe(true);
      const otherHome = join(home, 'other');
      await mkdir(join(otherHome, '.papercusp'), { recursive: true });
      await symlink(archive, join(otherHome, '.papercusp', 'reap-archive'));
      expect((await reapArchiveCensusProducer(otherHome)).declarations).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

afterEach(() => vi.clearAllMocks());
describe('secret census producer adapters', () => {
  it('discovers historical workspace stores without following linked workspace homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-template-census-'));
    try {
      const home = join(root, 'retired', '.papercusp');
      await mkdir(join(home, 'templates', 'app'), { recursive: true });
      await writeFile(join(home, 'templates', 'app', 'template.yaml'), 'manifest');
      await writeFile(join(home, 'templates', 'app', 'old.ts'), 'historical bytes');
      const source = join(root, 'source.ts');
      await writeFile(source, 'current bytes');
      await symlink(join(root, 'retired'), join(root, 'linked-workspace'));
      await mkdir(join(root, 'linked-home'));
      await symlink(home, join(root, 'linked-home', '.papercusp'));
      const resolver = vi.fn(async (path: string, bytes: Buffer) => path === source && bytes.equals(Buffer.from('historical bytes')));
      const result = await workspaceTemplateStoreCensusProducer(root, new Map([['app/old.ts', source]]), resolver);
      expect(result.roots).toEqual([{ id: 'workspace-template-store:retired', path: home }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/app', 'templates/app/template.yaml', 'templates/app/old.ts'].sort());
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(result.declarations.every(entry => entry.root === result.roots[0].id && !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('proves historical bytes only at the same regular Git source path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'historical-template-identity-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
      git('init', '-q');
      await writeFile(join(root, 'source.ts'), 'old source');
      await writeFile(join(root, 'other.ts'), 'other path only');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old');
      await writeFile(join(root, 'source.ts'), 'new source');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'new');
      const matches = historicalGitBlobIdentityResolver(root);
      expect(await matches(join(root, 'source.ts'), Buffer.from('old source'))).toBe(true);
      expect(await matches(join(root, 'source.ts'), Buffer.from('new source'))).toBe(true);
      expect(await matches(join(root, 'source.ts'), Buffer.from('other path only'))).toBe(false);
      expect(await matches(join(root, 'source.ts'), Buffer.from('drift'))).toBe(false);
      expect(await matches(join(root, 'missing.ts'), Buffer.from('old source'))).toBe(false);
      expect(await matches(join(root, '..', 'outside.ts'), Buffer.from('old source'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes exact mirror source while exposing drift, unknown siblings and linked parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'template-identity-census-'));
    try {
      await mkdir(join(root, 'templates', 'app', 'src'), { recursive: true });
      await writeFile(join(root, 'templates', 'app', 'template.yaml'), 'manifest');
      const source = join(root, 'canonical.ts');
      await writeFile(source, 'canonical source');
      await writeFile(join(root, 'templates', 'app', 'src', 'same.ts'), 'canonical source');
      await writeFile(join(root, 'templates', 'app', 'src', 'drift.ts'), 'changed source');
      await writeFile(join(root, 'templates', 'app', 'src', 'unknown.ts'), 'canonical source');
      await symlink(source, join(root, 'templates', 'app', 'src', 'link.ts'));
      await symlink(join(root, 'templates', 'app', 'src'), join(root, 'templates', 'app', 'linked'));
      const expected = new Map(['src/same.ts', 'src/drift.ts', 'src/link.ts', 'linked/same.ts', 'src/missing.ts'].map(name => [`app/${name}`, source]));
      const result = await templateStoreCensusProducer(root, expected);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/app', 'templates/app/template.yaml', 'templates/app/src', 'templates/app/src/same.ts'].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains parsed plan templates while exposing incomplete bundles, links and extra files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-template-census-'));
    try {
      for (const name of ['valid', 'legacy', 'incomplete', 'linked']) await mkdir(join(root, 'plan-templates', name), { recursive: true });
      const valid = join(root, 'plan-templates', 'valid');
      await writeFile(join(valid, 'plan.md'), '---\nslug: fixture\ntitle: Fixture\nstatus: draft\n---\n\n# Fixture\n\n- **P-001** `todo` Build fixture\n');
      await writeFile(join(valid, 'listing.json'), '{}');
      await writeFile(join(valid, 'unknown.ts'), 'source');
      await writeFile(join(root, 'plan-templates', 'legacy', 'plan.md'), '# Legacy');
      await writeFile(join(root, 'plan-templates', 'incomplete', 'listing.json'), '{}');
      await symlink(join(valid, 'plan.md'), join(root, 'plan-templates', 'linked', 'plan.md'));
      await symlink(valid, join(root, 'plan-templates', 'linked-dir'));
      const result = await planTemplateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['plan-templates', 'plan-templates/valid', 'plan-templates/valid/plan.md', 'plan-templates/valid/listing.json'].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes installed template metadata without claiming source, bytecode or incomplete bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'template-store-census-'));
    try {
      for (const name of ['valid', 'incomplete', 'linked-manifest']) await mkdir(join(root, 'templates', name), { recursive: true });
      for (const name of ['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md', 'source.ts', 'module.pyc']) await writeFile(join(root, 'templates', 'valid', name), 'opaque');
      await writeFile(join(root, 'templates', 'incomplete', 'listing.json'), '{}');
      await symlink(join(root, 'templates', 'valid', 'template.yaml'), join(root, 'templates', 'linked-manifest', 'template.yaml'));
      await symlink(join(root, 'templates', 'valid'), join(root, 'templates', 'linked-bundle'));
      const result = await templateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/valid', ...['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md'].map(name => `templates/valid/${name}`)].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      const writer = await readFile(new URL('../cupboard/install-template-core.ts', import.meta.url), 'utf8');
      expect(writer).toContain("existsSync(join(srcDir, 'template.yaml'))");
      const store = await readFile(new URL('../cupboard/template-store.ts', import.meta.url), 'utf8');
      expect(store).toContain("papercuspPath('templates')");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes historical versioned metadata only with matching identity and regular paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-template-census-'));
    try {
      const valid = join(root, 'templates', 'legacy', '0.1.0');
      await mkdir(join(valid, '.harness'), { recursive: true });
      await writeFile(join(valid, 'papercusp.json'), JSON.stringify({ name: 'legacy', version: '0.1.0', kind: 'template' }));
      for (const file of ['SPEC.md', 'README.md', '.published.json', 'unexpected.ts', '.harness/config.json', '.harness/unexpected.ts']) await writeFile(join(valid, file), 'fixture');
      await symlink(join(valid, 'SPEC.md'), join(valid, 'AGENTS.md'));
      await symlink(join(valid, 'SPEC.md'), join(valid, '.harness/validation-contract.md'));
      for (const version of ['0.2.0', 'invalid']) {
        await mkdir(join(root, 'templates', 'legacy', version), { recursive: true });
        await writeFile(join(root, 'templates', 'legacy', version, 'papercusp.json'), JSON.stringify({ name: 'wrong', version, kind: 'template' }));
      }
      await symlink(valid, join(root, 'templates', 'legacy', '0.3.0'));
      const result = await templateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/legacy', 'templates/legacy/0.1.0', ...['papercusp.json', 'SPEC.md', 'README.md', '.published.json', '.harness', '.harness/config.json'].map(file => `templates/legacy/0.1.0/${file}`)].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves completed setup credentials without claiming copied source or unknown homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-census-'));
    try {
      const parent = join(root, 'deploy-credentials');
      const names = ['.codex-setup-acme-1234abcd', '.setup-acme-1234abcd', '.codex-setup-acme-invalid'];
      for (const name of names) await mkdir(join(parent, name), { recursive: true });
      await writeFile(join(parent, names[0], 'auth.json'), 'opaque credential');
      await writeFile(join(parent, names[0], 'source.ts'), 'source');
      await mkdir(join(parent, names[0], 'log'));
      await writeFile(join(parent, names[0], 'log', 'codex-login.log'), 'login diagnostic');
      await writeFile(join(parent, names[0], 'log', 'foreign.log'), 'foreign');
      await symlink(join(parent, names[0]), join(parent, '.codex-setup-link-1234abcd'));
      const result = await cliSetupHomeCensusProducer(root);
      expect(result.declarations.map(entry => [entry.name, entry.classification])).toEqual([
        [`deploy-credentials/${names[0]}`, 'state'],
        [`deploy-credentials/${names[0]}/auth.json`, 'secret'],
        [`deploy-credentials/${names[0]}/log`, 'state'],
        [`deploy-credentials/${names[0]}/log/codex-login.log`, 'state'],
        [`deploy-credentials/${names[1]}`, 'state'],
      ]);
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      await rm(join(parent, names[0], 'log', 'codex-login.log'));
      await symlink(join(parent, names[0], 'auth.json'), join(parent, names[0], 'log', 'codex-login.log'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name))
        .not.toContain(`deploy-credentials/${names[0]}/log/codex-login.log`);
      await rm(join(parent, names[0], 'log'), { recursive: true });
      await symlink(join(parent, names[1]), join(parent, names[0], 'log'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name))
        .not.toContain(`deploy-credentials/${names[0]}/log`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('classifies exact Codex arg0 directories and locks without claiming helpers or foreign descendants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-census-'));
    try {
      const home = 'deploy-credentials/.codex-setup-acme-1234abcd';
      const arg0 = `${home}/tmp/arg0`;
      const session = `${arg0}/codex-arg0PSchFu`;
      await mkdir(join(root, session), { recursive: true });
      await mkdir(join(root, arg0, 'foreign'));
      await writeFile(join(root, session, '.lock'), '');
      await writeFile(join(root, session, 'foreign.txt'), 'foreign');
      await symlink('/unverified/codex', join(root, session, 'apply_patch'));
      await symlink(join(root, session), join(root, arg0, 'codex-arg0ABC123'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).toEqual([
        home, `${home}/tmp`, arg0, session, `${session}/.lock`,
      ]);
      expect((await cliSetupHomeCensusProducer(root)).declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      await rm(join(root, session, '.lock'));
      await symlink(join(root, session, 'foreign.txt'), join(root, session, '.lock'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).not.toContain(`${session}/.lock`);
      await rm(join(root, home, 'tmp'), { recursive: true });
      await symlink(root, join(root, home, 'tmp'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).toEqual([home]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('requires helper symlinks to resolve to the selected native Codex executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-identity-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const native = join(root, 'native-codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await writeFile(join(root, 'foreign-codex'), 'foreign');
      await symlink(native, join(root, session, 'apply_patch'));
      await symlink(native, join(root, session, 'applypatch'));
      await symlink(join(root, 'foreign-codex'), join(root, session, 'codex-linux-sandbox'));
      await symlink(join(root, 'missing'), join(root, session, 'codex-execve-wrapper'));
      await symlink(native, join(root, session, 'foreign-helper'));
      const names = (await cliSetupHomeCensusProducer(root, native)).declarations.map(entry => entry.name);
      expect(names).toContain(`${session}/apply_patch`);
      expect(names).toContain(`${session}/applypatch`);
      for (const name of ['codex-linux-sandbox', 'codex-execve-wrapper', 'foreign-helper']) expect(names).not.toContain(`${session}/${name}`);
      expect((await cliSetupHomeCensusProducer(root, null)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
      const packageRoot = join(root, 'npm-codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
      const launcher = join(packageRoot, 'bin/codex.js');
      await writeFile(launcher, '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const vendor = join(packageRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      await symlink(native, join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).toContain(`${session}/apply_patch`);
      await rm(join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
      const optionalRoot = join(packageRoot, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`);
      await mkdir(join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin'), { recursive: true });
      await writeFile(join(optionalRoot, 'package.json'), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
      const optionalNative = join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
      await symlink(native, optionalNative);
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).toContain(`${session}/apply_patch`);
      // An installed optional package owns resolution; a stale bundled binary
      // must not classify helpers if the selected optional binary is missing.
      await symlink(native, join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      await rm(optionalNative);
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains exact pacing and gym sidefiles while leaving unknown siblings and links visible', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sidefile-census-'));
    try {
      const pacing = 'google-vertex-gemini-3.1-pro-preview.json';
      const temporary = `${pacing}.tmp-123-12345678-1234-1234-1234-123456789abc`;
      for (const directory of ['provider-pacing', 'template-gym']) await mkdir(join(home, '.papercusp', directory), { recursive: true });
      for (const file of [pacing, `${pacing}.lock`, temporary, `${pacing}.tmp-unknown`, 'unknown']) await writeFile(join(home, '.papercusp', 'provider-pacing', file), 'opaque');
      await writeFile(join(home, '.papercusp', 'template-gym', 'last-run.json'), '{}');
      await symlink(join(home, '.papercusp', 'template-gym', 'last-run.json'), join(home, '.papercusp', 'template-gym', 'runs.jsonl'));
      const result = await runtimeSidefileCensusProducer(home);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['provider-pacing', ...[pacing, `${pacing}.lock`, temporary].map(file => `provider-pacing/${file}`), 'template-gym', 'template-gym/last-run.json'].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      const hook = await readFile(new URL('../../../../apps/operator/scripts/hooks/omp/coord-hook.ts', import.meta.url), 'utf8');
      expect(hook).toContain(`'${pacing}'`);
      expect(hook).toContain('`${statePath}.tmp-${process.pid}-${randomUUID()}`');
      const gym = await readFile(new URL('../harness/routines/template-gym-runner.ts', import.meta.url), 'utf8');
      for (const name of ['template-gym', 'last-run.json', 'runs.jsonl']) expect(gym).toContain(`'${name}'`);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('inventories referenced auth and atomic refresh files without importing unrelated CLI state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'account-census-'));
    try {
      await mkdir(join(home, 'build'));
      await mkdir(join(home, '__pycache__'));
      for (const name of ['auth.json', 'auth.json.123.tmp', 'auth.json.unknown.tmp', 'unknown']) await writeFile(join(home, name), 'must not read');
      await writeFile(join(home, 'build', 'template.ts'), 'source');
      await writeFile(join(home, '__pycache__', 'module.pyc'), 'bytecode');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` }, { credentialRef: 'keychain:external' }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['auth.json', 'auth.json.123.tmp']);
      expect(result.declarations.every(entry => entry.classification === 'secret' && !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.ok).toBe(true);
      expect(census.inventory.map(entry => entry.name).sort()).toEqual(['auth.json', 'auth.json.123.tmp']);
      const full = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'installed', path: home }], declarations: result.declarations });
      expect(full.roots).toEqual([{ id: 'installed', path: home }]);
      expect((await collectStateCensus({ ...full, readCatalogs: async () => [] })).residue.map(entry => entry.name)).toContain('unknown');
      const writer = await readFile(new URL('../inference-gateway/codex-oauth-proxy.ts', import.meta.url), 'utf8');
      expect(writer).toContain('`${target}.${process.pid}.tmp`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('unions external references without allowing a selected parent to hide an installed child', () => {
    const result = mergeNestedCensusRoots({ roots: [
      { id: 'a', path: '/external', fileNames: ['auth.json'] },
      { id: 'b', path: '/external', fileNames: ['token'] },
      { id: 'child', path: '/external/installed' },
    ], declarations: [] });
    expect(result.roots).toEqual([
      { id: 'a', path: '/external', fileNames: ['auth.json', 'token'] },
      { id: 'child', path: '/external/installed' },
    ]);
  });
  it('recognizes exact affected-test cache writers without claiming unrelated files or symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'affected-cache-census-'));
    try {
      const directory = join(home, '.papercusp', 'cache');
      await mkdir(directory, { recursive: true });
      const ordinary = 'papercusp-affected-passing-verdicts-v2-0123456789abcdef.json';
      const committed = 'papercusp-affected-passing-verdicts-v2-committed-fedcba9876543210.json';
      await writeFile(join(directory, ordinary), '{}');
      await writeFile(join(directory, committed), '{}');
      await writeFile(join(directory, 'unknown.json'), '{}');
      await symlink(join(directory, 'unknown.json'), join(directory, 'papercusp-affected-passing-verdicts-v2-aaaaaaaaaaaaaaaa.json'));
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', join(home, 'history', 'custom.json'));
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', join(home, 'verdict', 'custom.json'));
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['custom.json', 'custom.json', ordinary, committed].sort());
      expect(result.declarations.every(entry => entry.classification === 'cache' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.map(root => root.path)).toContain(join(home, 'history'));
      const writer = await readFile(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
      expect(writer).toContain('papercusp-affected-task-durations-v1.json');
      expect(writer).toContain('papercusp-affected-passing-verdicts-v2-${TASK_VERDICT_CACHE_ROOT_SCOPE}.json');
      const committedWriter = await readFile(new URL('../../../../scripts/lint-as-committed.mjs', import.meta.url), 'utf8');
      expect(committedWriter).toContain('papercusp-affected-passing-verdicts-v2-committed-${scope}.json');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('retains runtime writer directories under the relocated active workspace without pruning credentials or diagnostics', async () => {
    const result = runtimeRetainedCensusProducer();
    expect(result.roots).toEqual([{ id: 'runtime-retained', path: '/relocated/workspaces/registered-project/.papercusp' }]);
    expect(result.declarations.map(entry => [entry.name, entry.classification, entry.prune])).toEqual([
      ['deploy-credentials', 'state', undefined], ['crash-reports', 'state', undefined], ['snapshot-fold-checkpoints', 'state', undefined],
    ]);
    const writers = [
      ['../deployment/account-link-cli.ts', "papercuspPath('deploy-credentials'"],
      ['../process-supervision/fatal-diagnostics.ts', "papercuspPath('crash-reports')"],
      ['../sync/hyperbee/boot.ts', "'snapshot-fold-checkpoints'"],
    ];
    for (const [path, marker] of writers) expect(await readFile(new URL(path, import.meta.url), 'utf8')).toContain(marker);
    const installed = installedRootCensusProducers();
    expect(installed.declarations.find(entry => entry.producer === 'deployment-account-link')).toMatchObject({
      root: 'install-root-0', name: 'registered-project/.papercusp/deploy-credentials', classification: 'state',
    });
    expect(installed.declarations.find(entry => entry.producer === 'deployment-account-link')?.descendants).toBeUndefined();
  });
  it('uses the anchor producer path without resolving a backend or reading private key bytes', () => {
    expect(anchorSecretCensusProducer()).toEqual({ roots: [{ id: 'anchor-key-parent', path: '/fixture/sensitive' }],
      declarations: [{ kind: 'path', root: 'anchor-key-parent', name: 'anchor-key', classification: 'secret', producer: 'ledger-anchor-key' }] });
  });
  it('retains the keychain writer directory as sensitive state without pruning it', () => {
    expect(identityKeychainCensusProducer()).toEqual({ roots: [{ id: 'identity-keychain-parent', path: '/fixture/sensitive' }],
      declarations: [{ kind: 'path', root: 'identity-keychain-parent', name: 'identity', classification: 'secret', producer: 'identity-keychain', descendants: true }] });
  });
  it('derives retained database schema footprints from literal migration arrays without executing source', () => {
    const tables = migrationProducerTables('// CREATE TABLE fake (id text)\nexport const APP_MIGRATIONS = [`CREATE TABLE IF NOT EXISTS records (id text)`, `CREATE TABLE receipts (id text)`] as const;\nthrow new Error("must not execute");');
    expect(tables).toEqual(['public.records', 'public.receipts']);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
    const sources = [{ producer: 'fixture:migrations', tables }];
    expect(migrationDatabaseCensusDeclarations(entry, ['public.records'], sources)).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, tables, sources)[0]).toMatchObject({ name: 'arbitrary', classification: 'state', producer: 'fixture:migrations' });
    expect(migrationDatabaseCensusDeclarations(entry, tables, [{ producer: 'fixture:migrations', tables: [...tables, 'public.new_feature'] }])[0])
      .toMatchObject({ classification: 'state', producer: 'fixture:migrations:migration-prefix:2/3' });
  });
  it('retains canonical consult schema only with matching column names and types', async () => {
    const source = (await canonicalSqlMigrationCensusSources()).find(source => source.producer === 'canonical-sql-migration:834-consult-threads.sql');
    expect(source).toBeDefined();
    expect(source!.tables).toEqual(['harness_shared.consult_state', 'harness_shared.consult_post_meta']);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
    const columns = source!.columns!;
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns)[0])
      .toMatchObject({ classification: 'state', producer: source!.producer });
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!])).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns.filter(column => column.name !== 'routing'))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns.map(column => column.name === 'routing' ? { ...column, type: 'text' } : column))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables.map(table => table.replace('harness_shared.', 'public.')), [source!], columns)).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], [...columns, { table: source!.tables[0], name: 'dispatch_attempts', type: 'integer' }])[0]?.classification).toBe('state');
  });
  it('ignores SQL prose and rejects unsupported or unterminated schema evidence', () => {
    expect(sqlMigrationCensusSource("-- CREATE TABLE fake.first (id text);\nSELECT $$CREATE TABLE fake.second (id text);$$;", 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE x.first (id text); CREATE TABLE x.second (id unsupported);', 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE x.first (id text); CREATE TABLE x.second (id text', 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource("CREATE TABLE x.first (id text DEFAULT 'a,b)'); CREATE TABLE x.second (id bigint, CHECK (id > 0));", 'fixture')?.tables).toEqual(['x.first', 'x.second']);
  });
  it('matches declared enum identities and rejects missing, wrong-case or wrong-schema metadata', () => {
    const source = sqlMigrationCensusSource('CREATE TYPE public."Role" AS ENUM(\'BUYER\'); CREATE TABLE first (role public."Role"); CREATE TABLE second (role public."Role" NOT NULL);', 'enum');
    expect(source?.columns).toHaveLength(2);
    expect(source?.columns?.[0]).toMatchObject({ type: 'USER-DEFINED', udtSchema: 'public', udtName: 'Role' });
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    for (const patch of [{ udtName: 'role' }, { udtSchema: 'other' }, { udtName: undefined }, { type: 'text' }]) {
      expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column => ({ ...column, ...patch })))).toEqual([]);
    }
    expect(sqlMigrationCensusSource('CREATE TABLE first (id text); CREATE TABLE second (role "Role");', 'missing')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE first (id text[]); CREATE TABLE second (id text);', 'array')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE first (id timestamp nonsense); CREATE TABLE second (id text);', 'unsupported')).toBeNull();
  });
  it('distinguishes timestamp zones and matches double precision metadata', () => {
    const source = sqlMigrationCensusSource('CREATE TABLE "Records" ("Created" timestamp without time zone, score double precision); CREATE TABLE receipts (created timestamp, received timestamptz, updated timestamp with time zone);', 'drizzle');
    expect(source?.columns?.map(column => column.type)).toEqual([
      'timestamp without time zone', 'double precision', 'timestamp without time zone',
      'timestamp with time zone', 'timestamp with time zone',
    ]);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column =>
      column.name === 'Created' ? { ...column, type: 'timestamp with time zone' } : column))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column =>
      column.name === 'score' ? { ...column, type: 'real' } : column))).toEqual([]);
  });
  it('preserves quoted identifier case while rejecting SQL-looking identifier prose', () => {
    const source = sqlMigrationCensusSource('CREATE TABLE "Records" ("Id" text); CREATE TABLE public."Receipts" (id bigint);', 'quoted');
    expect(source?.tables).toEqual(['public.Records', 'public.Receipts']);
    expect(source?.columns).toEqual([{ table: 'public.Records', name: 'Id', type: 'text' }, { table: 'public.Receipts', name: 'id', type: 'bigint' }]);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables.map(name => name.toLowerCase()), [source!], source!.columns)).toEqual([]);
    expect(sqlMigrationCensusSource('SELECT "CREATE TABLE x.first (id text); CREATE TABLE x.second (id text)";', 'spoof')).toBeNull();
    expect(sqlMigrationCensusSource('/* outer /* CREATE TABLE x.first (id text) */ CREATE TABLE x.second (id text) */', 'spoof')).toBeNull();
  });
  it.skipIf(process.getuid?.() === 0)('does not classify unreadable installed source roots or abort readable source discovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unreadable-migration-census-'));
    const privateRoot = join(directory, 'private');
    const app = join(directory, 'app');
    try {
      await mkdir(privateRoot);
      await mkdir(join(app, 'drizzle'), { recursive: true });
      await writeFile(join(app, 'drizzle.config.ts'), "export default defineConfig({ out: './drizzle' });");
      await writeFile(join(app, 'drizzle/0000.sql'), 'CREATE TABLE public.first (id text); CREATE TABLE public.second (id text);');
      await chmod(privateRoot, 0);
      const sources = await registeredProjectMigrationSources([{ slug: 'private', path: privateRoot }, { slug: 'app', path: app }]);
      expect(sources).toHaveLength(1);
      expect(sources[0].producer).toContain('registry:app:');
    } finally { await chmod(privateRoot, 0o700); await rm(directory, { recursive: true, force: true }); }
  });
  it('discovers registered sibling migrations while excluding linked and missing sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'registered-migration-census-'));
    try {
      const app = join(directory, 'sibling');
      const linked = join(directory, 'linked');
      for (const path of [app, linked]) await mkdir(join(path, 'packages/data/src'), { recursive: true });
      const source = join(app, 'packages/data/src/migrations.ts');
      await writeFile(source, 'export const CALENDAR_MIGRATIONS = [`CREATE TABLE calendars (id text)`, `CREATE TABLE calendar_events (id text)`]; throw new Error("must not execute");');
      await symlink(source, join(linked, 'packages/data/src/migrations.ts'));
      const result = await registeredProjectMigrationSources([
        { slug: 'calendar', path: app }, { slug: 'duplicate', path: app },
        { slug: 'linked', path: linked }, { slug: 'missing', path: join(directory, 'absent') },
      ]);
      expect(result).toEqual([{ producer: `app-migrations:registry:calendar:${app}`, tables: ['public.calendars', 'public.calendar_events'] }]);
      expect(migrationDatabaseCensusDeclarations({ kind: 'database', root: 'postgres-cluster:123', name: 'calendar_app' }, result[0].tables, result)[0])
        .toMatchObject({ classification: 'state', producer: result[0].producer });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('discovers literal Drizzle SQL from registered and installed-unit roots without executing config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drizzle-census-'));
    try {
      const app = join(directory, 'app');
      await mkdir(join(app, 'drizzle'), { recursive: true });
      const config = join(app, 'drizzle.config.ts');
      await writeFile(config, "export default defineConfig({ out: './drizzle' }); throw new Error('must not execute');");
      await writeFile(join(app, 'drizzle/0000_init.sql'), 'CREATE TABLE "Records" ("Id" text); CREATE TABLE "Receipts" (id bigint);');
      await writeFile(join(directory, 'app.service'), `[Unit]\nWorkingDirectory=/not/source\n[Service]\nWorkingDirectory=${app}\nEnvironmentFile=/must/not/read\n`);
      const units = await unitCensusDeclarations(directory, 'user');
      const registered = await registeredProjectMigrationSources([{ slug: 'app', path: app }]);
      expect(registered[0]?.tables).toEqual(['public.Records', 'public.Receipts']);
      const installed = await registeredProjectMigrationSources([], units);
      expect(installed[0]?.tables).toEqual(registered[0].tables);
      expect(installed[0]?.producer).toContain('unit:systemd-user:app.service');
      for (const out of ["process.env.OUT", "'../outside'", "'./linked'", "'./drizzle', ...overrides"]) {
        await writeFile(config, `export default defineConfig({ out: ${out} });`);
        expect(await registeredProjectMigrationSources([], units)).toEqual([]);
      }
      await symlink(join(app, 'drizzle'), join(app, 'linked'));
      await writeFile(config, "export default defineConfig({ out: './linked' });");
      expect(await registeredProjectMigrationSources([], units)).toEqual([]);
      await rm(config);
      await writeFile(join(directory, 'external-config.ts'), "export default defineConfig({ out: './drizzle' });");
      await symlink(join(directory, 'external-config.ts'), config);
      expect(await registeredProjectMigrationSources([], units)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('joins local service database config with the measured catalogue and excludes remote endpoints', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-db-census-'));
    try {
      await writeFile(join(path, 'app.service'), '[Service]\nEnvironment="APP_DATABASE_URL=postgresql://user:private@127.0.0.1:5432/app" "OTHER_DATABASE_URL=postgresql://remote:private@example.com/app"\n');
      const units = await unitCensusDeclarations(path, 'user');
      const databases = [{ kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' }];
      const result = await unitDatabaseCensusDeclarations(units, databases, 'postgresql://localhost/operator');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'app', classification: 'state', producer: 'unit-database-config:systemd-user:app.service:APP_DATABASE_URL' });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(await unitDatabaseCensusDeclarations(units, [], 'postgresql://localhost/operator')).toEqual([]);
      await writeFile(join(path, 'runtime.env'), 'APP_DATABASE_URL=postgresql://user:private@localhost:5432/app\n');
      await writeFile(join(path, 'app.service'), `[Service]\nEnvironmentFile=${join(path, 'runtime.env')}\nEnvironmentFile=-${join(path, 'missing.env')}\n`);
      expect(await unitDatabaseCensusDeclarations(units, databases, 'postgresql://localhost/operator')).toHaveLength(1);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('continues inspecting surviving units when a discovered transient definition disappears', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-db-disappeared-'));
    try {
      const definition = '[Service]\nEnvironment=APP_DATABASE_URL=postgresql://localhost:5432/app\n';
      await writeFile(join(path, 'gone.service'), definition);
      await writeFile(join(path, 'live.service'), definition);
      const units = await unitCensusDeclarations(path, 'user');
      await rm(join(path, 'gone.service'));
      const result = await unitDatabaseCensusDeclarations(units,
        [{ kind: 'database', root: 'postgres-cluster:123', name: 'app' }], 'postgresql://localhost/operator');
      expect(result).toHaveLength(1);
      expect(result[0].producer).toContain('live.service');
      // Unexpected inspection errors still fail closed.
      await writeFile(join(path, 'live.service'), 'x'.repeat(65_537));
      await expect(unitDatabaseCensusDeclarations(units, [], 'postgresql://localhost/operator'))
        .rejects.toThrow('Service database config bound exceeded');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('derives hosted config paths from writer overrides and keeps credentials secret', async () => {
    const writer = await readFile(new URL('../../../../apps/operator/scripts/systemd/deploy-hosted-control-plane.sh', import.meta.url), 'utf8');
    expect(writer).toContain('PAPERCUSP_HOSTED_CP_ENV_FILE');
    expect(writer).toContain('hosted-control-plane.env');
    vi.stubEnv('PAPERCUSP_HOSTED_CP_ENV_FILE', '/fixture/credentials/hosted.env');
    vi.stubEnv('PUI_PORTAL_LINKS_ENV', '/fixture/config/links.env');
    try {
      const result = hostedConfigurationCensusProducers();
      expect(result.declarations.find(entry => entry.producer === 'deploy-hosted-control-plane')).toMatchObject({ name: 'hosted.env', classification: 'secret' });
      expect(result.declarations.find(entry => entry.producer === 'publish-tui-release')).toMatchObject({ name: 'links.env', classification: 'config' });
    } finally { vi.unstubAllEnvs(); }
  });
  it('qualifies operator state from the configured URL and pins the SU side-db to its writer', async () => {
    const source = await readFile(new URL('../../../../libs/papercusp/packages/locks/src/su-lock-store.ts', import.meta.url), 'utf8');
    expect(source).toContain("'/papercusp_su$1'");
    expect(configuredOperatorDatabaseCensusDeclarations('postgres-cluster:123', 'postgresql://user:password@localhost:5432/relocated')).toEqual([
      { kind: 'database', root: 'postgres-cluster:123', name: 'relocated', classification: 'state', producer: 'embedded-pg-discovery-operator' },
      { kind: 'database', root: 'postgres-cluster:123', name: 'papercusp_su', classification: 'state', producer: 'su-lock-store' },
    ]);
    expect(() => configuredOperatorDatabaseCensusDeclarations('port:5432', 'postgresql://localhost/db')).toThrow('identity');
  });
  it('retains the initdb maintenance database only with fixed catalog identity on the measured cluster', async () => {
    const marker = 'default administrative connection database';
    const catalog = { oid: 5, datname: 'postgres', datistemplate: false, marker };
    const sql = vi.fn().mockResolvedValueOnce([{ system_identifier: '123' }]).mockResolvedValueOnce([catalog]);
    expect(await maintenanceDatabaseCensusDeclarations(sql as unknown as Sql, 'postgres-cluster:123')).toEqual([
      { kind: 'database', root: 'postgres-cluster:123', name: 'postgres', classification: 'state', producer: 'postgres-initdb-maintenance' },
    ]);
    for (const impostor of [{ ...catalog, oid: 12345 }, { ...catalog, marker: null },
      { ...catalog, datname: 'customer' }, { ...catalog, datistemplate: true }]) {
      const other = vi.fn().mockResolvedValueOnce([{ system_identifier: '123' }]).mockResolvedValueOnce([impostor]);
      expect(await maintenanceDatabaseCensusDeclarations(other as unknown as Sql, 'postgres-cluster:123')).toEqual([]);
    }
    const foreign = vi.fn().mockResolvedValue([{ system_identifier: '456' }]);
    await expect(maintenanceDatabaseCensusDeclarations(foreign as unknown as Sql, 'postgres-cluster:123')).rejects.toThrow('mismatch');
    expect(foreign).toHaveBeenCalledTimes(1);
    await expect(maintenanceDatabaseCensusDeclarations(sql as unknown as Sql, 'port:5432')).rejects.toThrow('identity');
  });
  it('uses the template producer readiness marker rather than treating similar database names as disposable', async () => {
    const source = await readFile(new URL('../../../../libs/test-config/src/pg-migrate.ts', import.meta.url), 'utf8');
    expect(source).toContain("const TEMPLATE_READY_MARK = 'pc-template-ready';");
    const sql = vi.fn(async () => [{ datname: 'tmpl_fixture', marker: 'pc-template-ready' },
      { datname: 'tmpl_customer', marker: null }, { datname: 'customer', marker: 'pc-template-ready' }]);
    expect(await templateDatabaseCensusDeclarations(sql as unknown as Sql, 'postgres-cluster:123')).toEqual([
      { kind: 'database', root: 'postgres-cluster:123', name: 'tmpl_fixture', classification: 'dev-only', producer: 'pg-migrate-template-ready' },
    ]);
    await expect(templateDatabaseCensusDeclarations(sql as unknown as Sql, 'port:5432')).rejects.toThrow('identity');
  });
  it('qualifies arbitrarily named Python environments by marker and package layout', async () => {
    const path = await mkdtemp(join(tmpdir(), 'virtualenv-census-'));
    try {
      const environment = join(path, 'arbitrary');
      await mkdir(join(environment, 'lib', 'python3.12', 'site-packages'), { recursive: true });
      await mkdir(join(environment, 'bin'));
      await writeFile(join(environment, 'bin', 'python'), 'fixture');
      await writeFile(join(environment, 'pyvenv.cfg'), 'home = /usr/bin\nversion_info = 3.12.3\ninclude-system-site-packages = false\n');
      expect(await virtualenvCacheDeclaration({ id: 'fixture', path }, 'arbitrary')).toMatchObject({ name: 'arbitrary', classification: 'cache', prune: true });
      await rm(join(environment, 'lib'), { recursive: true });
      await expect(virtualenvCacheDeclaration({ id: 'fixture', path }, 'arbitrary')).rejects.toThrow();
      await expect(virtualenvCacheDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('pins analysis-cache ownership to the actual writer and honors relocation', async () => {
    const writer = await readFile(new URL('../../../../scripts/lib/strip-comments-and-strings.mjs', import.meta.url), 'utf8');
    expect(writer).toContain('process.env.PAPERCUSP_STRIP_CACHE_DIR');
    expect(writer).toContain("path.join(os.homedir(), '.papercusp', 'cache', 'strip-ranges')");
    vi.stubEnv('PAPERCUSP_STRIP_CACHE_DIR', '/fixture/analysis/cache');
    try {
      expect(stripRangeCacheCensusProducer()).toMatchObject({ roots: [{ path: '/fixture/analysis' }],
        declarations: [{ name: 'cache', classification: 'cache', prune: true }] });
    } finally { vi.unstubAllEnvs(); }
  });
  it('retains only completed direct restore clones and refuses active or symlinked targets', async () => {
    const path = await mkdtemp(join(tmpdir(), 'restore-census-'));
    try {
      const target = join(path, '.restored', 'snapshot', 'clone');
      await mkdir(target, { recursive: true });
      const rows = [{ id: '123', target, phase: 'done' }, { id: '124', target: join(path, '.restored', 'active', 'clone'), phase: 'started' }];
      const sql = vi.fn(async () => rows) as unknown as Sql;
      const declarations = await restoredCloneCensusDeclarations(sql, 'workspace', path, [{ id: 'home', path }]);
      expect(declarations).toHaveLength(1);
      expect(declarations[0]).toMatchObject({ name: '.restored/snapshot/clone', classification: 'state', recoveryStorage: { restoreEventId: '123' } });
      await rm(target, { recursive: true });
      await symlink(path, target, 'dir');
      expect(await restoredCloneCensusDeclarations(sql, 'workspace', path, [{ id: 'home', path }])).toEqual([]);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('preserves published portal generations only after matching their producer manifest', async () => {
    const path = await mkdtemp(join(tmpdir(), 'release-census-'));
    try {
      await mkdir(join(path, 'generation'));
      const manifest = { schemaVersion: 2, release: 'generation', buildId: 'build', sourceRoot: '/source', publishedAt: '2026-10-08T00:00:00Z' };
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify(manifest));
      await writeFile(join(path, 'generation', 'standalone-entry.mjs'), 'fixture');
      const owner = await portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation');
      expect(owner.classification).toBe('state');
      expect(owner.releaseStorage?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify({ ...manifest, sourceRoot: 'C:\\portal' }));
      expect((await portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation')).classification).toBe('state');
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify({ ...manifest, release: 'other' }));
      await expect(portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation')).rejects.toThrow('manifest');
      await expect(portalReleaseStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('reads peer marker evidence without modifying storage and rejects malformed or linked markers', async () => {
    const path = await mkdtemp(join(tmpdir(), 'peer-census-'));
    try {
      await mkdir(join(path, 'hyperbee', 'db'), { recursive: true });
      const marker = 'device/platform=linux\ndevice/inode=123\ndevice/created=456\n';
      await writeFile(join(path, 'hyperbee', 'CORESTORE'), marker);
      const declaration = await peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee');
      expect(declaration.peerStorage?.markerSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(join(path, 'hyperbee', 'CORESTORE'), 'utf8')).toBe(marker);
      await writeFile(join(path, 'hyperbee', 'CORESTORE'), 'not a device file');
      await expect(peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee')).rejects.toThrow('marker');
      await rm(join(path, 'hyperbee', 'CORESTORE'));
      await writeFile(join(path, 'elsewhere'), marker);
      await symlink(join(path, 'elsewhere'), join(path, 'hyperbee', 'CORESTORE'));
      await expect(peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee')).rejects.toThrow();
      await expect(peerStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('measures primary Git metadata and preserves linked pointers within the same inventory root', async () => {
    const path = await mkdtemp(join(tmpdir(), 'git-storage-census-'));
    try {
      const git = join(path, 'primary', '.git');
      await mkdir(join(git, 'objects'), { recursive: true });
      await mkdir(join(git, 'refs'), { recursive: true });
      await writeFile(join(git, 'HEAD'), `${'a'.repeat(40)}\n`);
      const primary = await gitStorageDeclaration({ id: 'fixture', path }, 'primary');
      expect(primary.gitStorage?.head).toBe('a'.repeat(40));
      const linked = join(git, 'worktrees', 'linked');
      await mkdir(linked, { recursive: true });
      await writeFile(join(linked, 'HEAD'), `${'a'.repeat(40)}\n`);
      await writeFile(join(linked, 'commondir'), '../..\n');
      await mkdir(join(path, 'linked'));
      await writeFile(join(path, 'linked', '.git'), `gitdir: ${linked}\n`);
      const pointer = await gitStorageDeclaration({ id: 'fixture', path }, 'linked');
      expect(pointer.producer).toBe('git-worktree-pointer');
      expect(pointer.gitStorage).toBeUndefined();
      const worktree = await gitStorageDeclaration({ id: 'fixture', path }, 'linked', true);
      expect(worktree.name).toBe('linked');
      expect(worktree.gitStorage?.head).toBe('a'.repeat(40));
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('refuses repository traversal before invoking Git', async () => {
    await expect(gitStorageDeclaration({ id: 'fixture', path: '/fixture' }, '../outside'))
      .rejects.toThrow('Invalid repository path');
  });
  it('refuses unverified PG storage and traversal paths before creating ownership', async () => {
    const path = await mkdtemp(join(tmpdir(), 'pg-storage-owner-'));
    try {
      await writeFile(join(path, 'PG_VERSION'), 'not-postgres');
      await expect(postgresStorageDeclaration({ id: 'fixture', path }, '.')).rejects.toThrow('Invalid PG storage version');
      await expect(postgresStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('Invalid PG storage path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('pins baseline classification to the current producer identity format', async () => {
    const producer = await readFile(new URL('../../../../libs/test-config/src/baseline-schema-global-setup.ts', import.meta.url), 'utf8');
    expect(producer).toContain('const dbName = `papercusp_it_baseline_${randomBytes(6).toString(\'hex\')}`;');
  });
  it('classifies only exact producer-shaped integration baselines, not similar production names', () => {
    const entries = ['papercusp_it_baseline_123456abcdef', 'papercusp_it_baseline_customer', 'scratch_customer'].map(name =>
      ({ kind: 'database' as const, root: 'cluster', name }));
    expect(integrationBaselineCensusDeclarations(entries).map(entry => entry.name))
      .toEqual(['papercusp_it_baseline_123456abcdef']);
  });
  it('qualifies catalog entries with measured physical PG identity, not a port or DB name', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray): Promise<Record<string, string>[]> => [])
      .mockResolvedValueOnce([{ system_identifier: '123456789' }])
      .mockResolvedValueOnce([{ datname: 'app' }]);
    expect(await physicalDatabaseCensusEntries(sql as unknown as Sql)).toEqual([
      { kind: 'database', root: 'postgres-cluster:123456789', name: 'app' },
    ]);
    await expect(physicalDatabaseCensusEntries(vi.fn(async () => []) as unknown as Sql))
      .rejects.toThrow('physical database cluster identity');
  });
  it('merges nested roots without losing child-relative secret ownership or conflating prefixes', () => {
    const parent = join(tmpdir(), 'nested-census', 'app');
    const sibling = `${parent}-other`;
    const result = mergeNestedCensusRoots({ roots: [
      { id: 'child', path: join(parent, 'secrets') }, { id: 'parent', path: parent },
      { id: 'sibling', path: sibling },
    ], declarations: [{ kind: 'path', root: 'child', name: 'key', classification: 'secret', producer: 'key' }] });
    expect(result.roots.map(root => root.id)).toEqual(['parent', 'sibling']);
    expect(result.roots.map(root => root.path)).toEqual([parent, sibling]);
    expect(result.declarations[0]).toMatchObject({ root: 'parent', name: 'secrets/key', classification: 'secret' });
  });
  it('composes writer roots and rewrites declaration identities consistently', () => {
    const result = installedRootCensusProducers();
    expect(new Set(result.roots.map(root => root.path)).size).toBe(result.roots.length);
    expect(result.declarations.every(entry => result.roots.some(root => root.id === entry.root))).toBe(true);
    expect(result.declarations.some(entry => entry.name === 'db-key' && entry.classification === 'secret')).toBe(true);
  });
  it('derives scratch cache ownership from the relocated writer root', () => {
    const result = scratchCensusProducer();
    expect(result.roots[0].path).toBe('/relocated/cache');
    expect(result.declarations[0]).toMatchObject({ name: 'spills', classification: 'cache', prune: true });
  });
  it('derives unit classification from installer sources, not installed-unit observations', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-producer-'));
    try {
      await writeFile(join(path, 'app.service'), '[Service]');
      await symlink('/dev/null', join(path, 'masked.service'));
      await writeFile(join(path, 'data.mount'), '[Mount]');
      await writeFile(join(path, 'README.md'), 'not a unit');
      const declarations = await unitCensusDeclarations(path, 'user');
      expect(declarations.map(entry => entry.name).sort()).toEqual(['app.service', 'data.mount', 'masked.service']);
      expect(declarations[0].classification).toBe('config');
      expect(declarations[0].producer).toBe(`unit-definition:${path}`);
      expect((await unitCensusDeclarations(path, 'user', 'dev-only'))[0].classification).toBe('dev-only');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('uses the registry writer root without blanket-classifying sibling workspaces', () => {
    const producer = workspaceRegistryCensusProducer();
    expect(producer.roots).toEqual([{ id: 'workspace-registry', path: '/relocated/workspaces' }]);
    expect(producer.declarations).toEqual([{
      kind: 'path', root: 'workspace-registry', name: 'registry.json',
      classification: 'config', producer: 'workspace-registry',
    }, {
      kind: 'path', root: 'workspace-registry', name: 'registered-project',
      classification: 'state', producer: 'workspace-registry',
    }]);
  });
  it('verifies filesystem and all catalogs together and fails on a new host entry', async () => {
    const path = await mkdtemp(join(tmpdir(), 'host-census-'));
    try {
      await writeFile(join(path, 'config'), 'fixture');
      const declarations: CensusDeclaration[] = [
        { kind: 'path', root: 'home', name: 'config', classification: 'config', producer: 'fixture' },
        { kind: 'database', root: 'cluster', name: 'db', classification: 'state', producer: 'fixture' },
        { kind: 'unit', root: 'systemd-user', name: 'app.service', classification: 'config', producer: 'fixture' },
        { kind: 'secret', root: 'vault', name: 'key', classification: 'secret', producer: 'fixture' },
      ];
      const input = { roots: [{ id: 'home', path }], declarations,
        readDatabases: async () => declarations.filter(entry => entry.kind === 'database'),
        readUnits: async () => declarations.filter(entry => entry.kind === 'unit'),
        readSecrets: async () => declarations.filter(entry => entry.kind === 'secret'),
      };
      expect((await verifyHostStateCensus(input)).inventory).toHaveLength(4);
      await writeFile(join(path, 'unowned'), 'new state');
      await expect(verifyHostStateCensus(input)).rejects.toThrow('unclassified:path:home:unowned');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('inventories disabled installed units and distinguishes system/user scopes', async () => {
    const read = async () => '[{"unit_file":"backup.service","state":"disabled"}]';
    expect(await unitCensusEntries('user', read)).toEqual([
      { kind: 'unit', root: 'systemd-user', name: 'backup.service' },
    ]);
    expect((await unitCensusEntries('system', read))[0].root).toBe('systemd-system');
  });
  it('rejects malformed or failed unit catalogs instead of treating them as empty', async () => {
    for (const body of ['{}', '[{}]', 'not-json']) {
      await expect(unitCensusEntries('user', async () => body)).rejects.toThrow();
    }
    await expect(unitCensusEntries('user', async () => { throw new Error('systemd unavailable'); }))
      .rejects.toThrow('systemd unavailable');
  });
  it('inventories every returned database without silently classifying unexpected databases', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray) => [{ datname: 'papercusp' }, { datname: 'unexpected' }]);
    const entries = await databaseCensusEntries(sql as unknown as Sql, 'cluster-123');
    expect(entries).toEqual([
      { kind: 'database', root: 'cluster-123', name: 'papercusp' },
      { kind: 'database', root: 'cluster-123', name: 'unexpected' },
    ]);
    expect(sql.mock.calls[0][0].join('')).toContain('WHERE NOT datistemplate');
  });

  it('propagates catalog failures and refuses unqualified cluster identity', async () => {
    const sql = vi.fn(async () => { throw new Error('unavailable'); });
    await expect(databaseCensusEntries(sql as unknown as Sql, 'cluster-123')).rejects.toThrow('unavailable');
    await expect(databaseCensusEntries(sql as unknown as Sql, '')).rejects.toThrow('cluster identity');
  });
  it('uses producer-resolved paths rather than assuming both secrets live in the default home', () => {
    const result = secretCensusProducers();
    expect(result.roots.map(root => root.path)).toEqual(['/mounted/secrets', '/scoped/home', '/fixture/config/papercusp']);
    expect(result.declarations.map(entry => [entry.name, entry.classification, entry.producer]))
      .toEqual([['db-key', 'secret', 'db-encryption'], ['superuser-token', 'secret', 'superuser-token'],
        ['google-oauth-client.json', 'secret', 'google-oauth-desktop-client']]);
  });
});
