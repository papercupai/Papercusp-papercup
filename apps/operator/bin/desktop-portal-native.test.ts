import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { EnvInfo, IpcStatus, Registry } from '@papercusp/operator-core/lib/tauri-bindings';

const pid = process.env.VERIFY_TAURI_PID;
const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN;
const run = promisify(execFile);

// Run only in the verifier-owned native process. No browser imitation or
// intercepted requests: the actual desktop bootstrap installs the transport.
it.skipIf(!pid || !tool)('opens the portal shell with desktop environments and routes its API through Rust IPC', async () => {
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.PAPERCUSP_DESKTOP_INTERFACE).toBe('portal-candidate');
  const evaluate = async (expression: string) => {
    const { stdout } = await run(tool!, ['eval', '--pid', pid!, expression, '--json'], { timeout: 15_000 });
    const response = JSON.parse(stdout);
    expect(Object.hasOwn(response, 'result')).toBe(true);
    return response.result;
  };
  await expect.poll(() => evaluate(`Boolean(
    document.querySelector('meta[name="papercusp-desktop-interface"]')?.content === 'portal-candidate'
    && document.querySelector('[aria-label="Papercusp Portal"]')
    && document.querySelector('[aria-label="Apps"]')
    && document.querySelector('[aria-label="Environment switcher"]')
    && window.__TAURI_INTERNALS__?.invoke
  )`), { timeout: 60_000 }).toBe(true);
  const envs: EnvInfo[] = await evaluate('window.__TAURI_INTERNALS__.invoke("list_envs")');
  expect(envs.map(env => env.id)).toEqual(expect.arrayContaining(['local', 'dev', 'prod', 'staging']));
  const registry: Registry = await evaluate('window.__TAURI_INTERNALS__.invoke("workspaces_list")');
  // The maintained isolated rig writes this registry before boot. Matching its
  // actual native value prevents a shell showing the owner's workspace from
  // passing merely because it painted a portal heading.
  expect(registry.current).toMatch(/^verify-tauri-isolated-\d+$/);
  expect(registry.workspaces.some(workspace => workspace.id === registry.current)).toBe(true);
  const selection = () => evaluate(`(() => {
    const workspace = document.querySelector('select[aria-label="Workspace"]');
    return { workspace: workspace?.value, label: workspace?.selectedOptions[0]?.textContent,
      origin: location.origin, path: location.pathname,
      workspaceParam: new URL(location.href).searchParams.get('ws'),
      machineVisible: Boolean(document.querySelector('[aria-label="Machine selection"]')),
      environmentsVisible: Boolean(document.querySelector('[aria-label="Environment switcher"]')) };
  })()`);
  await expect.poll(async () => (await selection()).workspace, { timeout: 60_000 }).toBe(registry.current);
  await expect.poll(async () => (await selection()).machineVisible, { timeout: 60_000 }).toBe(true);
  const selectedBefore = await selection();
  expect(selectedBefore.workspaceParam).toBe(registry.current);
  expect(selectedBefore.label).toBe('Isolated verifier');
  expect(selectedBefore.machineVisible).toBe(true);
  expect(selectedBefore.environmentsVisible).toBe(true);
  const before: IpcStatus = await evaluate('window.__TAURI_INTERNALS__.invoke("endpoint_ipc_status")');
  await evaluate(`(() => {
    window.__desktopPortalProbe = null;
    Promise.all(['/api/apps', '/api/preferences'].map(path => fetch(path).then(async response => ({
      status: response.status, body: await response.json()
    })))).then(result => { window.__desktopPortalProbe = { result }; },
      error => { window.__desktopPortalProbe = { error: String(error) }; });
    return true;
  })()`);
  await expect.poll(() => evaluate('window.__desktopPortalProbe !== null'), { timeout: 60_000 }).toBe(true);
  const probe = await evaluate('window.__desktopPortalProbe');
  expect(probe.error).toBeUndefined();
  expect(probe.result.map((response: { status: number }) => response.status)).toEqual([200, 200]);
  expect(probe.result[0].body.apps.some((app: { slug: string }) => app.slug === 'home')).toBe(true);
  expect(probe.result[1].body.preferences.theme).toBe('dark');
  const after: IpcStatus = await evaluate('window.__TAURI_INTERNALS__.invoke("endpoint_ipc_status")');
  expect(after.client).toBe('connected');
  expect(after.ownerIsContentOrigin).toBe(true);
  expect(after.invokes).toBeGreaterThan(before.invokes);

  // The marker belongs to the old document. Waiting for it to disappear proves
  // a real reload occurred before checking durable selection and transport.
  await evaluate(`(() => {
    window.__desktopPortalReloadPending = true;
    setTimeout(() => location.reload(), 100);
    return true;
  })()`);
  await expect.poll(() => evaluate('typeof window.__desktopPortalReloadPending === "undefined"'),
    { timeout: 60_000 }).toBe(true);
  await expect.poll(selection, { timeout: 60_000 }).toEqual(selectedBefore);
  const selectedAfter = await selection();
  expect(selectedAfter).toEqual(selectedBefore);
  const registryAfter: Registry = await evaluate('window.__TAURI_INTERNALS__.invoke("workspaces_list")');
  expect(registryAfter.current).toBe(registry.current);
  const envsAfter: EnvInfo[] = await evaluate('window.__TAURI_INTERNALS__.invoke("list_envs")');
  expect(envsAfter.map(env => ({ id: env.id, port: env.port, origin: env.origin })))
    .toEqual(envs.map(env => ({ id: env.id, port: env.port, origin: env.origin })));
  await expect.poll(async () => {
    const status: IpcStatus = await evaluate('window.__TAURI_INTERNALS__.invoke("endpoint_ipc_status")');
    return status.client === 'connected' && status.ownerIsContentOrigin;
  }, { timeout: 60_000 }).toBe(true);
  console.log(JSON.stringify({ schemaVersion: 'desktop-portal-native-selection-v1',
    before: selectedBefore, after: selectedAfter, workspace: registry.current,
    environments: envsAfter.map(env => ({ id: env.id, port: env.port, origin: env.origin })),
    scope: 'Actual isolated local desktop selection and reload; remote, cross-environment navigation and installed/offline acceptance remain separate.' }));
}, 300_000);
