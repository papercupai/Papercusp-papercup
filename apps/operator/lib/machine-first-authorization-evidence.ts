import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

type Row = Record<string, any>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const guidance = (value: unknown) => text(value) && value.includes('SSH') && value.includes('psu --connect=');

export interface AuthorizationEvidenceIdentity {
  portalRelease: string;
  portalSourceDigest: string;
  fixedPageSha: string;
}

/** Assess retained browser observations, never a new browser run or shipment claim.
 * R1 switching, launch resolution and agent continuity are deliberately outside this assessment.
 */
export function validateMachineFirstAuthorization(hostedRaw: unknown, localRaw: unknown,
  expected: AuthorizationEvidenceIdentity) {
  const hosted = row(hostedRaw), local = row(localRaw);
  const cases = rows(hosted.cases), build = row(hosted.build), localBuild = row(local.build);
  const assertions: { id: string; passed: boolean }[] = [];
  const check = (id: string, passed: boolean) => { assertions.push({ id, passed }); };
  check('exact-recorded-build', text(expected.portalRelease) && digest(expected.portalSourceDigest) && digest(expected.fixedPageSha) &&
    build.release === expected.portalRelease && build.sourceDigest === expected.portalSourceDigest && build.fixedPageSha === expected.fixedPageSha &&
    localBuild.portalRelease === expected.portalRelease && localBuild.fixedPageSha === expected.fixedPageSha);
  check('recorded-origins-and-times', [build.origin, localBuild.origin, localBuild.operatorOrigin].every(value => {
    try { return text(value) && ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
  }) && [hosted.observedAt, local.observedAt].every(value => text(value) && Number.isFinite(Date.parse(value))));

  const selected = cases.filter(c => c.label === 'authorized-selected-workspace');
  const browsers = cases.filter(c => c.label === 'hosted-browser-selected');
  check('two-independent-selected-tenants', selected.length === 2 &&
    ['account', 'tenant', 'selectedWorkspace', 'target', 'connection'].every(key =>
      selected.every(c => text(c[key])) && new Set(selected.map(c => c[key])).size === 2) &&
    selected.every(c => c.expected === 200 && c.observedStatus === 200 && c.error === null &&
      c.route === '/api/hosted/browser/rest-query?name=workspaceHosts.control&args=%7B%7D' &&
      // This disposable fixture owns exactly one machine and connection per
      // tenant. Finding those rows alone would also accept a leaked inventory.
      Array.isArray(c.rows) && c.rows.length === 2 &&
      rows(c.rows).filter(r => r.kind === 'workspace' && r.id === c.target).length === 1 &&
      rows(c.rows).filter(r => r.kind === 'connection' && r.id === c.connection).length === 1));
  const empty = cases.filter(c => c.label === 'hosted-empty-workspace');
  check('hosted-null-workspace-denied', empty.length === 1 && empty.every(c => text(c.account) && text(c.tenant) &&
    c.selectedWorkspace === null && c.target === null && c.connection === null &&
    c.expected === 403 && c.observedStatus === 403 && c.error === 'workspace_not_selected' && c.rows === null));
  for (const label of ['cross-tenant-machine-denial', 'cross-tenant-connection-denial']) {
    const denied = cases.filter(c => c.label === label);
    check(label, denied.length === 2 && selected.length === 2 && selected.every(tenant => {
      const matches = denied.filter(c => c.account === tenant.account && c.tenant === tenant.tenant && c.selectedWorkspace === tenant.selectedWorkspace);
      const other = selected.find(c => c.account !== tenant.account);
      return matches.length === 1 && matches.every(c => c.expected === 403 && c.observedStatus === 403 &&
        c.error === 'workspace_binding_mismatch' && c.rows === null && c.target === null && c.connection === null &&
        (label === 'cross-tenant-machine-denial'
          ? c.route === '/api/hosted/browser/rest-query?name=workspaceHosts.control&args=%7B%7D'
          : c.route === `/api/hosted/workspaces/${other?.selectedWorkspace}/connectors/session-ticket`));
    }));
  }
  check('selected-browser-navigation-and-help', browsers.length === 2 && selected.length === 2 && selected.every(tenant => {
    const matches = browsers.filter(c => c.account === tenant.account && c.tenant === tenant.tenant && c.selectedWorkspace === tenant.selectedWorkspace);
    return matches.length === 1 && matches.every(c => c.observedStatus === 200 && c.sessionStatus === 200 &&
      c.machineSelectorCount === 1 && c.connectActionCount === 1 && text(c.visibleText) &&
      c.visibleText.includes('Connect your computer') && text(c.screenshot) && guidance(c.guidance) &&
      c.navigationDestination === `${build.origin}/?app=workspaces` && rows(c.errors).length === 0 && Array.isArray(c.errors));
  }));
  const emptyBrowser = cases.filter(c => c.label === 'hosted-browser-empty');
  check('hosted-empty-browser-truthful', emptyBrowser.length === 1 && empty.length === 1 && emptyBrowser.every(c =>
    c.account === empty[0].account && c.tenant === empty[0].tenant && c.selectedWorkspace === null &&
    c.observedStatus === 200 && c.sessionStatus === 200 && c.machineSelectorCount === 0 && c.connectActionCount === 1 &&
    text(c.visibleText) && c.visibleText.includes('Choose a workspace to connect a machine') && !c.visibleText.includes('This computer') &&
    guidance(c.guidance) && text(c.screenshot) && c.navigationDestination === `${build.origin}/?app=workspaces` &&
    Array.isArray(c.errors) && c.errors.length === 0));
  const inventory = row(local.inventory), combo = row(local.combobox);
  check('local-empty-inventory-and-help', local.case === 'local-private-empty-inventory' && local.account === 'explicit-local-owner' &&
    local.selectedWorkspace === null && local.target === 'local' && local.status === 200 &&
    inventory.route === '/api/operator-sync/rest-query?name=workspaceHosts.control&args=%7B%7D' && inventory.status === 200 &&
    Array.isArray(row(inventory.body).rows) && row(inventory.body).rows.length === 0 &&
    combo.disabled === false && combo.text === 'This computer' && text(local.body) && local.body.includes('No agent desktops on this computer') &&
    guidance(local.guidance) && Array.isArray(local.screenshots) && local.screenshots.length >= 2 && local.screenshots.every(text) &&
    Array.isArray(local.errors) && local.errors.length === 0);
  const cleanup = rows(hosted.cleanup);
  const tenants = [...selected.map(c => c.tenant), ...empty.map(c => c.tenant)];
  check('test-tenant-cleanup', tenants.length === 3 && new Set(tenants).size === 3 && cleanup.length === 3 &&
    tenants.every(id => cleanup.filter(c => c.organizationId === id && c.ok === true).length === 1));
  check('complete-case-population', cases.length === 10 && cases.every(c => [
    'authorized-selected-workspace', 'hosted-empty-workspace', 'cross-tenant-machine-denial',
    'cross-tenant-connection-denial', 'hosted-browser-selected', 'hosted-browser-empty',
  ].includes(c.label)));
  return { passed: assertions.every(a => a.passed), assertions,
    checked: assertions.filter(a => a.passed).map(a => a.id), missing: assertions.filter(a => !a.passed).map(a => a.id),
    identity: expected,
    limitation: 'Assessment of retained R6 browser/API observations only; does not rerun browsers, verify screenshot pixels, establish current runtime liveness, R1 switching/agent continuity, unit prerequisites, or R7 shipment.' };
}

/** Hash the original bytes before parsing; changed or substituted receipts fail closed. */
export function readMachineFirstAuthorization(hosted: { path: string; sha256: string }, local: { path: string; sha256: string },
  expected: AuthorizationEvidenceIdentity, read: (path: string) => Buffer = readFileSync) {
  const captured = [hosted, local].map(input => {
    const bytes = read(input.path);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (!digest(input.sha256) || actual !== input.sha256) throw new Error(`Receipt digest mismatch: ${input.path}`);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  });
  return { ...validateMachineFirstAuthorization(captured[0], captured[1], expected), receipts: [hosted, local] };
}
