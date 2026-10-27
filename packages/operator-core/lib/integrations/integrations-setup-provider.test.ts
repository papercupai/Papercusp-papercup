import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { JsonRpcBridge } from '@papercusp/plugin-loader/daemon';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';

it('the setup fixture offers a writable project and implements its ticket creation contract', async () => {
  const child = spawn(process.execPath, [resolve(import.meta.dirname,
    '../../test/fixtures/integrations-setup-chat/daemon.mjs')], {
    // The runner's NODE_OPTIONS can substitute committed source. This contract
    // must execute the fixture bytes being tested and needs no environment.
    env: {}, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const closed = once(child, 'close');
  const bridge = new JsonRpcBridge(child.stdout!, child.stdin!);
  try {
    const descriptor = await bridge.call<ProviderDescriptor>('provider.describe');
    expect(descriptor.datatypes).toContain('ticket');
    expect(descriptor.capabilities).toEqual(expect.arrayContaining(['ticket.containers', 'ticket.create']));
    const invoke = (capability: string, args: Record<string, unknown>) => bridge.call<Record<string, unknown>>(
      'provider.invoke', { request: { source: 'fixture-source', capability, args } });
    const listed = await invoke('ticket.containers', { purpose: 'create' });
    expect(listed.options).toContainEqual(expect.objectContaining({ value: 'PRJ-bugs' }));
    const args = { containerId: 'PRJ-bugs', title: 'A bug', body: 'Observed failure', correlationId: 'fixture-attempt' };
    const created = await invoke('ticket.create', args);
    expect(created.externalRef).toEqual(expect.any(String));
    expect(created.externalRef).not.toBe('');
    const recovered = await invoke('ticket.create', { ...args, recoveryOnly: true });
    expect(recovered).toMatchObject({ externalRef: created.externalRef, recovered: true });
    await expect(invoke('ticket.create', { ...args, containerId: 'not-offered' })).rejects.toThrow();
  } finally {
    child.stdin!.end();
    child.kill('SIGKILL');
    await closed;
  }
});
