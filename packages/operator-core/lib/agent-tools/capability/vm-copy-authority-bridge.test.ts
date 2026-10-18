import { beforeEach, describe, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../agent-mcp-client', () => ({ connectAgentMcp: wire.connect }));
import { callVmCopyAuthorityFromInstallation } from './vm-copy-authority-bridge';
import { fixture } from './__fixtures__/vm-copy-authority';

beforeEach(() => { wire.connect.mockReset(); });
describe('installed transport admission before credential send', () => {
  it.each(['http://external.invalid/api/mcp', 'http://localhost/api/mcp', 'https://127.0.0.1/api/mcp',
    'http://user:pass@127.0.0.1/api/mcp', 'http://127.0.0.1/other',
    'http://127.0.0.1/api/mcp?client=foreign', 'http://127.0.0.1/api/mcp#fragment', 'not-a-url'])
  ('refuses an invalid installed endpoint %s before connecting', async url => {
    const f = fixture();
    await expect(callVmCopyAuthorityFromInstallation({ url, bearer: 'must-not-send', devicePubkey: f.host.devicePubkey,
      scope: f.scope }, f.raw, 'preflight')).rejects.toThrow('installed-target-invalid');
    expect(wire.connect).not.toHaveBeenCalled();
  });
  it('refuses a missing pinned key before sending credentials', async () => {
    const f = fixture();
    await expect(callVmCopyAuthorityFromInstallation({ url: 'http://127.0.0.1:1234/api/mcp', bearer: 'must-not-send',
      devicePubkey: '', scope: f.scope }, f.raw, 'preflight')).rejects.toThrow('installed-target-invalid');
    expect(wire.connect).not.toHaveBeenCalled();
  });
  it('closes without executing inspect if authenticated session resolution disagrees', async () => {
    const f = fixture(); const close = vi.fn(); const callTool = vi.fn(async () => ({ content: [{ type: 'text',
      text: JSON.stringify({ workspaceId: f.scope.workspaceId, ownerId: 'foreign' }) }] }));
    wire.connect.mockResolvedValue({ client: { listTools: vi.fn(), callTool, close } });
    await expect(callVmCopyAuthorityFromInstallation({ url: 'http://127.0.0.1:1234/api/mcp', bearer: 'private-token',
      devicePubkey: f.host.devicePubkey, scope: f.scope }, f.raw, 'preflight')).rejects.toThrow('authenticated-session-mismatch');
    expect(callTool).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });
});
