import { describe, expect, it } from 'vitest';
import {
  assertAuthorizedByocClientKey,
  authorizeByocClientKey,
  revokeAuthorizedByocClientKey,
  rotateAuthorizedByocClientKey,
  type ByocClientAuthorizationRecord,
  type ByocClientAuthorizationStore,
} from './byoc-client-authorization';

const scope = { organizationId: 'org-1', workspaceId: 'ws-1', hostId: 'host-1', clientId: 'desktop-1' };
const oldKey = Buffer.alloc(32, 3).toString('base64');
const nextKey = Buffer.alloc(32, 4).toString('base64');

class MemoryStore implements ByocClientAuthorizationStore {
  value: ByocClientAuthorizationRecord | null = null;
  async read() { return this.value; }
  async write(record: ByocClientAuthorizationRecord) { this.value = record; }
}

describe('customer-host BYOC client authorization', () => {
  it('pins one key, advances generation on an authorized rotation, and rejects the old key', async () => {
    const store = new MemoryStore();
    await expect(authorizeByocClientKey(store, scope, oldKey)).resolves.toMatchObject({
      publicKeyBase64: oldKey, generation: 1, status: 'authorized',
    });
    await expect(rotateAuthorizedByocClientKey(store, scope, oldKey, nextKey)).resolves.toMatchObject({
      publicKeyBase64: nextKey, generation: 2, status: 'authorized',
    });
    await expect(assertAuthorizedByocClientKey(store, scope, oldKey)).rejects.toThrow(/not authorized/);
    await expect(assertAuthorizedByocClientKey(store, scope, nextKey, 1)).rejects.toThrow(/not authorized/);
    await expect(assertAuthorizedByocClientKey(store, scope, nextKey, 2)).resolves.toMatchObject({ generation: 2 });
  });

  it('treats post-rotation revocation of the old key as an idempotent confirmation', async () => {
    const store = new MemoryStore();
    await authorizeByocClientKey(store, scope, oldKey);
    await rotateAuthorizedByocClientKey(store, scope, oldKey, nextKey);
    await expect(revokeAuthorizedByocClientKey(store, scope, oldKey)).resolves.toMatchObject({
      publicKeyBase64: nextKey, generation: 2, status: 'authorized',
    });
  });

  it('marks a directly revoked key and refuses every later assertion', async () => {
    const store = new MemoryStore();
    await authorizeByocClientKey(store, scope, oldKey);
    await expect(revokeAuthorizedByocClientKey(store, scope, oldKey)).resolves.toMatchObject({ status: 'revoked' });
    await expect(assertAuthorizedByocClientKey(store, scope, oldKey)).rejects.toThrow(/not authorized/);
  });
});
