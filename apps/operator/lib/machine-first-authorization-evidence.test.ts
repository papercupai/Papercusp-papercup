import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readMachineFirstAuthorization, validateMachineFirstAuthorization } from './machine-first-authorization-evidence';

const identity = { portalRelease: 'retained-release', portalSourceDigest: 'a'.repeat(64), fixedPageSha: 'b'.repeat(64) };
function fixture() {
  const origin = 'https://localhost:1234';
  const selected = ['A', 'B'].map(id => ({ label: 'authorized-selected-workspace', account: `account-${id}`, tenant: `tenant-${id}`,
    selectedWorkspace: `workspace-${id}`, target: `machine-${id}`, connection: `connection-${id}`, expected: 200, observedStatus: 200, error: null,
    route: '/api/hosted/browser/rest-query?name=workspaceHosts.control&args=%7B%7D',
    rows: [{ kind: 'workspace', id: `machine-${id}` }, { kind: 'connection', id: `connection-${id}` }] }));
  const help = 'SSH psu --connect=my-computer';
  const empty = { label: 'hosted-empty-workspace', account: 'account-empty', tenant: 'tenant-empty', selectedWorkspace: null,
    target: null, connection: null, expected: 403, observedStatus: 403, error: 'workspace_not_selected', rows: null };
  const hosted = { observedAt: '2026-10-16T23:35:59Z', build: { origin, release: identity.portalRelease, sourceDigest: identity.portalSourceDigest, fixedPageSha: identity.fixedPageSha },
    cases: [...selected, empty, ...selected.flatMap((c, i) => ['machine', 'connection'].map(kind => ({ ...c,
      label: `cross-tenant-${kind}-denial`, target: null, connection: null, rows: null, expected: 403, observedStatus: 403,
      error: 'workspace_binding_mismatch', route: kind === 'machine' ? c.route : `/api/hosted/workspaces/${selected[1 - i].selectedWorkspace}/connectors/session-ticket` }))),
    ...selected.map(c => ({ ...c, label: 'hosted-browser-selected', sessionStatus: 200, machineSelectorCount: 1, connectActionCount: 1,
      visibleText: 'Connect your computer', guidance: help, screenshot: 'selected.png', navigationDestination: `${origin}/?app=workspaces`, errors: [] })),
    { ...empty, label: 'hosted-browser-empty', observedStatus: 200, sessionStatus: 200, machineSelectorCount: 0, connectActionCount: 1,
      visibleText: 'Choose a workspace to connect a machine', guidance: help, screenshot: 'empty.png', navigationDestination: `${origin}/?app=workspaces`, errors: [] }],
    cleanup: ['A', 'B', 'empty'].map(id => ({ organizationId: `tenant-${id}`, ok: true })) };
  const local = { observedAt: '2026-10-16T23:55:12Z', build: { origin, operatorOrigin: 'http://localhost:1235', portalRelease: identity.portalRelease, fixedPageSha: identity.fixedPageSha },
    case: 'local-private-empty-inventory', account: 'explicit-local-owner', selectedWorkspace: null, target: 'local', status: 200,
    inventory: { route: '/api/operator-sync/rest-query?name=workspaceHosts.control&args=%7B%7D', status: 200, body: { rows: [] } },
    combobox: { text: 'This computer', disabled: false }, body: 'No agent desktops on this computer', guidance: help, screenshots: ['local.png', 'help.png'], errors: [] };
  return { hosted, local };
}

describe('retained machine-first authorization receipt assessment', () => {
  it('accepts a complete two-tenant case population while preserving the observation boundary', () => {
    const { hosted, local } = fixture();
    const result = validateMachineFirstAuthorization(hosted, local, identity);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.limitation).toContain('R1 switching/agent continuity');
    expect(result.limitation).toContain('does not rerun browsers');
  });

  it('rejects missing, duplicate or unknown case rows rather than trusting a recorded verdict', () => {
    for (const alter of [
      (h: any) => h.cases.pop(),
      (h: any) => { h.cases[1] = h.cases[0]; },
      (h: any) => { h.cases[0].label = 'skipped'; },
    ]) {
      const { hosted, local } = fixture(); alter(hosted);
      expect(validateMachineFirstAuthorization(hosted, local, identity).passed).toBe(false);
    }
  });

  it('rejects another artifact, missing source pin, or a local artifact differing from the hosted run', () => {
    for (const alter of [
      (h: any, l: any) => { h.build.sourceDigest = 'c'.repeat(64); },
      (h: any, l: any) => { l.build.portalRelease = 'another-release'; },
      (h: any, l: any) => { l.build.fixedPageSha = null; },
    ]) {
      const { hosted, local } = fixture(); alter(hosted, local);
      expect(validateMachineFirstAuthorization(hosted, local, identity).passed).toBe(false);
    }
  });

  it('requires both independently authenticated denial directions and no leaked rows', () => {
    for (const alter of [
      (h: any) => { h.cases[3].observedStatus = 200; },
      (h: any) => { h.cases[3].rows = [{ id: 'foreign-machine' }]; },
      (h: any) => { h.cases[4].route = '/api/hosted/workspaces/workspace-A/connectors/session-ticket'; },
      (h: any) => { h.cases[1].tenant = h.cases[0].tenant; },
    ]) {
      const { hosted, local } = fixture(); alter(hosted);
      expect(validateMachineFirstAuthorization(hosted, local, identity).passed).toBe(false);
    }
  });

  it('rejects foreign, duplicate and malformed rows even in successful inventory responses', () => {
    for (const extra of [
      { kind: 'workspace', id: 'machine-B' },
      { kind: 'connection', id: 'connection-B' },
      { kind: 'workspace', id: 'machine-A' },
      { kind: 'connection', id: 'connection-A' },
      { kind: 'unknown', id: 'foreign-content' },
      null,
    ]) {
      const { hosted, local } = fixture();
      (hosted.cases[0].rows as unknown[]).push(extra);
      const result = validateMachineFirstAuthorization(hosted, local, identity);
      expect(result.missing).toContain('two-independent-selected-tenants');
      expect(result.passed).toBe(false);
    }
  });

  it('rejects misleading empty state, broken navigation, absent help and wrong local inventory route', () => {
    for (const alter of [
      (h: any, l: any) => { h.cases[9].visibleText += ' This computer'; },
      (h: any, l: any) => { h.cases[7].navigationDestination = '/wrong'; },
      (h: any, l: any) => { l.guidance = ''; },
      (h: any, l: any) => { l.inventory.route = '/api/rest-query'; },
      (h: any, l: any) => { l.inventory.body.rows.push({ id: 'saved-machine' }); },
      (h: any, l: any) => { l.combobox.disabled = true; },
      (h: any, l: any) => { h.cleanup[0].ok = false; },
      (h: any, l: any) => { h.cases[7].errors = ['browser failed']; },
    ]) {
      const { hosted, local } = fixture(); alter(hosted, local);
      expect(validateMachineFirstAuthorization(hosted, local, identity).passed).toBe(false);
    }
  });

  it('fails closed on absent receipts and checks original bytes before parsing', () => {
    expect(validateMachineFirstAuthorization({}, null, identity).passed).toBe(false);
    const { hosted, local } = fixture();
    const captures = [Buffer.from(JSON.stringify(hosted)), Buffer.from(JSON.stringify(local))];
    const inputs = captures.map((bytes, i) => ({ path: String(i), sha256: createHash('sha256').update(bytes).digest('hex') }));
    expect(readMachineFirstAuthorization(inputs[0], inputs[1], identity, p => captures[Number(p)]).passed).toBe(true);
    expect(() => readMachineFirstAuthorization(inputs[0], inputs[1], identity, () => Buffer.from('not JSON'))).toThrow('Receipt digest mismatch');
  });
});
