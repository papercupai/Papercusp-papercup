/** Full product journey in the owned native desktop; only external identity, wallet and chain transports are fixtures. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { chromium } from 'playwright-core';
import { decodeFunctionResult, encodeFunctionData, stringToHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { nativeChildEnvironment } from '../../../../scripts/tauri-surface-verify-reports.mts';
import { readNativeHostHealth, selectIdentityFixtureActor } from '../../../../scripts/fixtures/dao-workbench-identity.mjs';
import { assertCompletionResponse, sign } from '../../../../scripts/fixtures/dao-hr-documenso-ui';
import { workbenchTextField, workbenchTextFieldReady, workbenchButtonReady, workbenchControlDiagnostics, openWorkbenchDisclosure, openWorkbenchSelect, chooseWorkbenchOption, captureWorkbenchResponses, workbenchVerifiedWallet, clickWorkbenchButton } from '../../../../scripts/lib/dao-workbench-controls.mts';
import { insertHiveIfAbsent } from '../hive-store';
import { loadHarnessRegistry, saveHarnessRegistry } from '../harness-registry';
import { upsertHiveMember } from '../hive-membership-store';
import { resolveFederatedPotScope } from '../federated-pot-scope';
import { createDeviceAttestationBody } from '../identity/attest';
import { authorHivePolicy } from '../hive-policy-author';
import { grantDaoHrAdmin, installSampleTemplates } from './contract-templates';
import { saveWorkProfile, linkMemberIdentity } from './work-profile';
import { updateEquityPolicy } from './equity-policy';
import { getContractExecution } from './contracts-esign';
import { DocumensoAdapter, DocumensoError } from './documenso';
import type { DaoCapTable, DaoWorkspaceView } from '../dao-workspace-types';
import type { EquityArtifacts } from '../equity/compile';
import { nativeHttpPhase } from './native-bootstrap-runtime';

describe.skipIf(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1' || !process.env.DAO_HR_NATIVE_CONFIG)('P012 actual native hiring journey', () => {
  it('creates, approves, signs, votes, accepts and admits one candidate, then reads People, org and cap table', async () => {
    const config = JSON.parse(readFileSync(process.env.DAO_HR_NATIVE_CONFIG!, 'utf8'));
    const fixturePath = process.env.DAO_WORKBENCH_IDENTITY_FIXTURE!;
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const profile = JSON.parse(readFileSync(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!, 'utf8'));
    const privateEnv = nativeChildEnvironment(profile);
    const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL!, { max: 1, onnotice: () => {} });
    const ws = profile.workspaceId, slug = 'workbench-native', key = { workspaceId: ws, daoSlug: slug };
    const retainHttpFailure = (diagnostic: object) => writeFileSync(config.resultPath + '.http-failure.json', JSON.stringify(diagnostic), { mode: 0o600 });
    const browser = await chromium.launch({ headless: true });
    const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN || 'tauri-agent-tools';
    const native = (...args: string[]) => execFileSync(tool, [...args, '--pid', String(profile.tauriPID)], { encoding: 'utf8', env: privateEnv, timeout: 65_000 });
    const ev = (code: string) => native('eval', code);
    const value = <T = any>(code: string): T => JSON.parse(ev('JSON.stringify(' + code + ')'));
    const reload = () => native('navigate', value<string>('location.href'), '--json');
    const wait = (code: string) => native('wait', '--eval', code, '--timeout', '60000', '--interval', '500');
    const withControlDiagnostics = (kind: string, label: string, action: () => string) => {
      try { return action(); }
      catch (cause) {
        let dom: unknown;
        try { dom = value(workbenchControlDiagnostics('[data-testid=dao-workspace]')); }
        catch (captureError) { dom = { captureError: String(captureError) }; }
        writeFileSync(config.resultPath + '.control-failure.json', JSON.stringify({ kind, label, error: String(cause), dom }, null, 2));
        throw cause;
      }
    };
    const click = (text: string, scope = 'document') => withControlDiagnostics('button', text, () => {
      wait(workbenchButtonReady(text, scope)); return ev(clickWorkbenchButton(text, scope));
    });
    const field = (label: string, input: string) => withControlDiagnostics('field', label, () => {
      wait(workbenchTextFieldReady(label, '[data-testid=dao-workspace]'));
      return ev(workbenchTextField(label, input, '[data-testid=dao-workspace]'));
    });
    const textHas = (text: string) => {
      try { wait('document.body.innerText.includes(' + JSON.stringify(text) + ')'); }
      catch (cause) {
        writeFileSync(config.resultPath + '.text-failure.json', JSON.stringify({ expectedText: text,
          ...value<object>('({url:location.href,text:document.body.innerText,alerts:[...document.querySelectorAll(\'[role=alert]\')].map(e=>e.textContent),disclosures:[...document.querySelectorAll(\'details\')].map(e=>({summary:e.querySelector(\'summary\')?.textContent,open:e.open}))})') }, null, 2));
        throw cause;
      }
    };
    const select = (label: string, option: string) => {
      ev(openWorkbenchSelect(label, '[data-testid=dao-workspace]'));
      wait('[...document.querySelectorAll(\'[role=option]\')].some(e=>e.textContent.trim()===' + JSON.stringify(option) + ')');
      ev(chooseWorkbenchOption(option));
    };
    const navigate = (search: object) => {
      ev("window.__TSR_ROUTER__.navigate({to:'/daos',search:" + JSON.stringify({ dao: slug, daoSection: 'members', ...search }) + "})");
      wait("!!document.querySelector('[data-testid=dao-workspace]')");
    };
    const response = (op: string) => {
      const expression = 'window.__DAO_HR_CAPTURE__?.responses[' + JSON.stringify(op) + ']';
      try { wait('!!' + expression); }
      catch (error) {
        writeFileSync(config.resultPath + '.response-failure.json', JSON.stringify(value('({responses:window.__DAO_HR_CAPTURE__?.responses,alerts:[...document.querySelectorAll(\'[role=alert]\')].map(e=>e.textContent),text:document.body.innerText})')));
        throw error;
      }
      const result = value(expression);
      expect(result.status, 'Product response for ' + op).toBe(200);
      expect(result.body.ok, 'Product result for ' + op).toBe(true); return result.body;
    };
    const captureResponses = () => ev(captureWorkbenchResponses());
    const rpc = async (method: string, params: unknown[] = []) => nativeHttpPhase('wallet-rpc', async () => {
      const r = await fetch(config.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const result = await r.json(); if (result.error) throw new Error('Test wallet RPC: ' + result.error.message); return result.result;
    }, retainHttpFailure);
    const equityAbi = (JSON.parse(readFileSync(new URL('../equity/artifacts.json', import.meta.url), 'utf8')) as EquityArtifacts).contracts.PapercuspEquityV2.abi;
    const equitySnapshot = (title: 'Cap table' | 'My equity') => {
      const section = 'document.querySelector(' + JSON.stringify('section[aria-label="' + title + '"]') + ')';
      wait('!!' + section + '?.querySelector(\'[role="table"]\')');
      return value<{ marker: string; blockNumber: string; headings: string[]; rows: string[][] }>("(()=>{const section=" + section + ";const rows=[...section.querySelectorAll('[role=table] [role=row]')];return {marker:section.querySelector('[role=note]')?.innerText,blockNumber:section.innerText.match(/block (\\d+)/)?.[1],headings:[...rows[0].children].map(cell=>cell.innerText.trim()),rows:rows.slice(1).map(row=>[...row.firstElementChild.children].map(cell=>cell.innerText.trim()))}})()");
    };
    const workspaceDto = () => {
      const url = '/api/discovery/pots?potId=' + encodeURIComponent(slug) + '&includeLocalViews=true';
      ev("(()=>{window.__DAO_HR_WORKSPACE_DTO__=null;fetch(" + JSON.stringify(url) + ").then(async r=>{window.__DAO_HR_WORKSPACE_DTO__={status:r.status,body:await r.json()}}).catch(e=>{window.__DAO_HR_WORKSPACE_DTO__={error:String(e)}});return true})()");
      wait('window.__DAO_HR_WORKSPACE_DTO__!==null');
      const result = value<{ status: number; body: { workspace: DaoWorkspaceView } }>('window.__DAO_HR_WORKSPACE_DTO__');
      expect(result.status).toBe(200);
      expect(result.body.workspace.directoryId).toBe(slug);
      expect(result.body.workspace.capTable?.status).toBe('ready');
      return (result.body.workspace.capTable as { status: 'ready'; value: DaoCapTable }).value;
    };
    const confirmations = async () => { await rpc('evm_mine'); await rpc('evm_mine'); };
    const signWallet = async (tx: any) => {
      const hash = await rpc('eth_sendTransaction', [{ ...tx, value: '0x0', chainId: '0x1' }]);
      await confirmations(); return hash as string;
    };
    const actor = (name: string) => { selectIdentityFixtureActor(fixturePath, name, privateEnv); };
    // The fixture rotates server credentials; it emits no browser auth event.
    // Re-read actor-scoped workspace permissions before navigating within the DAO.
    const browserActor = (name: string) => { actor(name); reload(); };
    const bindFinanceWallet = async (account: string) => {
      navigate({ daoSection: 'ownership' }); textHas('Your verified wallet:'); captureResponses();
      field('Wallet address', account); field('Wallet chain ID', '1'); click('Request wallet signing challenge');
      const challenge = response('wallet-challenge').value;
      const signature = await rpc('personal_sign', [stringToHex(challenge.message), account]);
      field('Wallet signature', signature); click('Verify wallet signature'); response('wallet-verify');
      try { wait(workbenchVerifiedWallet(account, 1)); }
      catch (cause) {
        writeFileSync(config.resultPath + '.wallet-render-failure.json', JSON.stringify(value('({body:document.body.innerText,responses:window.__DAO_HR_CAPTURE__?.responses})'), null, 2));
        throw cause;
      }
    };
    const prepareGovernor = async (name: string, args: unknown[]) => {
      navigate({ daoSection: 'ownership' }); textHas('Equity deployment & holder records'); captureResponses();
      select('Equity action', 'EquityGovernorV2 · ' + name);
      field('Action arguments (JSON array)', JSON.stringify(args)); click('Prepare unsigned wallet transaction');
      return signWallet(response('prepare-equity').unsignedTransaction);
    };
    try {
      expect(/^verify-tauri-isolated-\d+$/.test(ws)).toBe(true);
      const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
      const health = await readNativeHostHealth(privateEnv);
      expect(health.health.sha).toBe(receipt.sourceCommit.slice(0, 12));
      const home = join(process.env.PAPERCUSP_HOME!, slug); mkdirSync(home, { recursive: true });
      await insertHiveIfAbsent({ workspaceId: ws, homeSlug: slug, pubkeyBase64: fixture.hive.publicKey, keychainId: 'hive:' + ws + ':' + slug,
        title: 'Native DAO HR', description: 'Non-binding isolated hiring verification' }, sql);
      const registry = await loadHarnessRegistry(ws);
      await saveHarnessRegistry({ ...registry, projects: [...registry.projects, { slug, path: home, harness_kind: 'hive' }] }, ws);
      const scope = await resolveFederatedPotScope(ws, slug, { sql });
      for (const name of ['admin', 'approver', 'candidate']) {
        const a = fixture.actors[name], personId = 'PER-native-' + name;
        await sql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,title,payload)
          VALUES (${ws},'papercusp',${personId},'person',${name === 'candidate' ? 'Native candidate' : 'Native ' + name},${sql.json({ email: a.email })})`;
        if (name === 'candidate') continue;
        actor(name);
        const attestation = await createDeviceAttestationBody({ keychainId: a.keychainId, pubkeyBase64: a.device.publicKey, deviceLabel: 'Isolated HR actor',
          githubUserId: a.githubUserId, githubLogin: a.githubLogin });
        await upsertHiveMember({ workspaceId: ws, potHomeSlug: scope, githubUserId: a.githubUserId, githubUsername: a.githubLogin, bindingStatus: 'verified',
          deviceAttestations: [{ device_pubkey: attestation.device_pubkey, gist_id: 'synthetic-native-gist',
            gist_url: 'https://gist.github.com/' + a.githubLogin + '/synthetic-native-gist', device_label: attestation.device_label,
            created_at: attestation.created_at, signature_by_device: attestation.signature_by_device }] }, sql);
        await saveWorkProfile({ ...key, personId, title: 'HR admin', engagementType: 'employee', jurisdiction: 'US-DE' }, { sql });
        await linkMemberIdentity({ ...key, personId, member: { githubUserId: a.githubUserId } }, { sql });
      }
      actor('admin');
      await grantDaoHrAdmin({ ...key, personId: 'PER-native-admin', bootstrapOperator: 'isolated-native-fixture' }, { sql });
      await grantDaoHrAdmin({ ...key, personId: 'PER-native-approver', grantedBy: 'PER-native-admin' }, { sql });
      await installSampleTemplates({ ...key, actorPersonId: 'PER-native-admin' }, { sql });
      await updateEquityPolicy({ ...key, actorPersonId: 'PER-native-admin', changes: { startRule: 'hire_passed' } }, { sql });
      const signed = await authorHivePolicy({ workspaceId: ws, potHomeSlug: slug, policy: { membership: 'open',
        finance: { equity: { chainId: 1, equity: config.equity, governor: config.governor, timelock: config.timelock } } } });
      expect(signed.ok).toBe(true);
      native('navigate', '/daos', '--json'); wait("!!document.querySelector('[data-testid=dao-workspace]')");
      await bindFinanceWallet(config.accounts[0]);
      navigate({ peopleTab: 'hiring' }); textHas('Create a role');
      ev(openWorkbenchDisclosure('Create a role', '[data-testid=dao-workspace]')); textHas('Create role'); captureResponses();
      field('Role title', 'Native engineer'); field('Level', 'L3'); click('Create role'); response('role');
      textHas('Native engineer'); click('Native engineer'); textHas('Add candidate');
      select('Candidate', 'Native candidate'); click('Add candidate'); response('candidate');
      field('Jurisdiction', 'US-DE'); field('Pay amount', '5000'); field('Shares override', '1000'); click('Create offer'); response('offer');
      textHas('Native candidate'); click('Native candidate'); textHas('Another HR admin must approve your offer.');
      expect(value("[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve offer').disabled")).toBe(true);
      const offerId = value("new URLSearchParams(location.search).get('hiringOffer')") as string; expect(offerId).toBeTruthy();
      browserActor('approver'); textHas('Approve offer'); captureResponses(); click('Approve offer'); response('approve'); textHas('Generate contract');
      select('Company countersigner', 'Native approver'); field('Start date', '2026-11-01'); click('Generate contract'); response('prepare');
      textHas('Non-binding sample.'); click('Start signatures'); response('start');
      const contract = await getContractExecution({ ...key, offerId }, { sql });
      expect(contract.can_bind).toBe(false);
      const candidateContext = await browser.newContext({ storageState: config.candidateSession });
      const companyContext = await browser.newContext({ storageState: config.companySession });
      await sign(await candidateContext.newPage(), contract.signing_links!.find(link => link.email === fixture.actors.candidate.email)!.signingUrl);
      await sign(await companyContext.newPage(), contract.signing_links!.find(link => link.email === fixture.actors.approver.email)!.signingUrl);
      // The provider's signing UI finishes before envelope finalization. Reuse
      // the real sandbox test's strict readiness check before delivering its event.
      const provider = DocumensoAdapter.configured();
      const completionEvent = { event: 'DOCUMENT_COMPLETED' as const, createdAt: new Date().toISOString(),
        payload: { envelopeId: contract.envelope_id!, externalId: contract.contract_id, status: 'COMPLETED' as const } };
      // Reconcile can observe the provider's COMPLETED status before its signed
      // document and certificate downloads are ready. Require the same strict
      // proof used by the webhook handler before delivering the event.
      await expect.poll(async () => {
        const status = await provider.reconcile({ contractId: contract.contract_id, envelopeId: contract.envelope_id!,
          signers: contract.signers, pdf: contract.source_pdf });
        if (status !== 'COMPLETED') return false;
        try {
          await provider.completed(completionEvent, { contractId: contract.contract_id, envelopeId: contract.envelope_id!, signers: contract.signers });
          return true;
        } catch (error) {
          if (error instanceof DocumensoError && error.code === 'invalid_completion') return false;
          throw error;
        }
      }, { timeout: 30_000 }).toBe(true);
      // Delivery transport only; completion verifies the provider accounts, signatures and sealed artifacts itself.
      await nativeHttpPhase('provider-completion-webhook', async () => {
        const completed = await fetch(health.origin + '/api/dao-hr/documenso/webhook', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Documenso-Secret': process.env.DOCUMENSO_WEBHOOK_SECRET! },
          body: JSON.stringify(completionEvent) });
        await assertCompletionResponse(completed, diagnostic => writeFileSync(config.resultPath + '.completion-response.json', JSON.stringify(diagnostic, null, 2)));
      }, retainHttpFailure);
      reload(); textHas('Executed document hash:');
      for (const kind of ['sealed', 'certificate']) {
        await nativeHttpPhase(kind === 'sealed' ? 'sealed-document' : 'audit-certificate', async () => {
          const artifact = await fetch(health.origin + '/api/pot/' + slug + '/contracts/' + offerId + '/document?kind=' + kind);
          expect(artifact.status).toBe(200); expect(Buffer.from(await artifact.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
        }, retainHttpFailure);
      }
      browserActor('candidate'); navigate({ peopleTab: 'onboarding', onboardingOffer: offerId }); textHas('Request wallet challenge'); captureResponses();
      field('Wallet address', config.accounts[1]); field('Wallet chain ID', '1'); click('Request wallet challenge');
      const challenge = response('wallet-challenge').result;
      field('Wallet signature', await rpc('personal_sign', [stringToHex(challenge.message), config.accounts[1]])); click('Verify wallet signature'); response('wallet-verify');
      click('Verify my identity and bound wallet'); response('verify-identity');
      browserActor('admin'); navigate({ peopleTab: 'hiring', hiringOffer: offerId }); textHas('Prepare hire vote'); captureResponses();
      click('Prepare hire vote'); const prepared = response('prepare-hire').result, plan = prepared.plan;
      const proposalHash = await signWallet(prepared.unsignedTransaction);
      field('Transaction hash', proposalHash); click('Verify hire proposal transaction'); response('record-proposal');
      await rpc('evm_increaseTime', ['61']); await rpc('evm_mine');
      await prepareGovernor('castVote', [plan.proposalId, '1']);
      await rpc('evm_increaseTime', ['604801']); await rpc('evm_mine');
      await prepareGovernor('queue', [plan.targets, plan.values, plan.calldatas, plan.descriptionHash]);
      await rpc('evm_increaseTime', ['86401']); await rpc('evm_mine');
      const executionHash = await prepareGovernor('execute', [plan.targets, plan.values, plan.calldatas, plan.descriptionHash]);
      navigate({ peopleTab: 'hiring', hiringOffer: offerId }); textHas('Verify hire execution transaction'); captureResponses();
      field('Transaction hash', executionHash); click('Verify hire execution transaction'); response('record-execution');
      browserActor('candidate'); navigate({ peopleTab: 'onboarding', onboardingOffer: offerId }); textHas('Prepare my terms acceptance'); captureResponses();
      click('Prepare my terms acceptance'); const acceptanceHash = await signWallet(response('prepare-acceptance').result);
      field('Transaction hash', acceptanceHash); click('Verify acceptance and admit me'); response('admit'); textHas('DAO membership admitted');
      const [member] = await sql`SELECT admitted_at FROM harness_shared.dao_hr_contracts WHERE contract_id=${contract.contract_id}`;
      expect(member?.admitted_at).toBeTruthy();
      reload(); navigate({ peopleTab: 'directory' }); textHas('Native candidate'); click('Native candidate'); textHas('Native engineer');
      expect(value("document.body.innerText.includes('5000')")).toBe(true);
      browserActor('admin'); navigate({ peopleTab: 'org' }); textHas('Native candidate');
      navigate({ peopleTab: 'cap' });
      const cap = equitySnapshot('Cap table'), capDto = workspaceDto();
      expect(cap.marker).toBe('test chain - non-binding');
      expect(capDto.nonBinding).toBe(true);
      expect(cap.headings).toEqual(['Holder', 'Wallet', 'Shares owned', 'Grants committed', 'Grants earned', 'Grants claimed',
        'Grants unvested', 'Return entitlements', 'Returns unclaimed', '% owned', '% fully diluted']);
      expect(cap.blockNumber).toBe(capDto.blockNumber);
      expect(cap.rows.map(row => row[1].toLowerCase()).sort()).toEqual(config.accounts.slice(0, 2).map((address: string) => address.toLowerCase()).sort());
      expect(cap.rows).toHaveLength(capDto.positions.length);
      const balances = [];
      for (const row of cap.rows) {
        const wallet = row[1] as Address;
        const result = await rpc('eth_call', [{ to: config.equity, data: encodeFunctionData({ abi: equityAbi, functionName: 'balanceOf', args: [wallet] }) },
          '0x' + BigInt(cap.blockNumber).toString(16)]) as Hex;
        const shares = String(decodeFunctionResult({ abi: equityAbi, functionName: 'balanceOf', data: result }));
        expect(row[2], 'Displayed shares at block ' + cap.blockNumber + ' for ' + wallet).toBe(shares);
        const position = capDto.positions.find(position => position.wallet.toLowerCase() === wallet.toLowerCase())!;
        expect(position, 'Public DTO holder for ' + wallet).toBeTruthy();
        expect(row).toEqual([position.displayName, position.wallet, position.shares, position.committed, position.earned, position.claimed,
          position.unvested, position.returnEntitlements, position.unclaimedReturns, position.ownershipPercent + '%', position.fullyDilutedPercent + '%']);
        balances.push({ wallet, displayed: row[2], chain: shares });
      }
      const candidatePosition = capDto.positions.find(position => position.wallet.toLowerCase() === config.accounts[1].toLowerCase())!;
      expect(candidatePosition).toMatchObject({ personId: 'PER-native-candidate', displayName: 'Native candidate', committed: '1000' });
      browserActor('candidate'); navigate({ peopleTab: 'my' });
      const mine = equitySnapshot('My equity'), myDto = workspaceDto();
      expect(mine.marker).toBe('test chain - non-binding');
      expect(myDto.positions.filter(position => position.isSelf).map(position => position.wallet.toLowerCase())).toEqual([config.accounts[1].toLowerCase()]);
      expect(mine.rows).toEqual(cap.rows.filter(row => row[1].toLowerCase() === config.accounts[1].toLowerCase()));
      expect(mine.rows).toHaveLength(1);
      const final = { sourceCommit: receipt.sourceCommit, workspaceId: ws, offerId, contractId: contract.contract_id,
        hireExecuted: true, acceptanceVerified: true, memberAdmitted: true, nonBinding: true, proposalHash, executionHash, acceptanceHash,
        capTableVerified: true, myEquityVerified: true, nonBindingVisible: true,
        equityObservation: { blockNumber: cap.blockNumber, balances, capRows: cap.rows, myRows: mine.rows, capDto, myDto } };
      writeFileSync(config.resultPath, JSON.stringify(final), { mode: 0o600 });
    } finally { await browser.close(); await sql.end(); }
  }, 600_000);
});
