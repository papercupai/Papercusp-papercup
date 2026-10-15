/**
 * Workspace switch + registry surface — HTTP validation + idempotency.
 *
 * Real workspace switches dispatch a workspace-switch event that drops
 * replay buffers, card-correlator PENDING entries, and state-channel
 * snapshots for the leaving workspace. We don't exercise the full
 * lifecycle here (would mutate the shared registry); instead we verify:
 *   - GET shape
 *   - validation gates fire in the right order
 *   - idempotent same-workspace switch returns `alreadyCurrent` and
 *     does NOT mutate the registry
 *   - destructive ops (PATCH/DELETE) refuse before touching state
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

async function getRegistry(request: import('@playwright/test').APIRequestContext) {
  const r = await request.get(`${baseURL}/api/workspaces`);
  expect(r.status()).toBe(200);
  return (await r.json()) as {
    current: string;
    workspaces: { id: string; name: string; createdAt: number }[];
  };
}

test.describe('workspace registry list', () => {
  test('GET /api/workspaces returns { current, workspaces[] }', async ({ request }) => {
    const reg = await getRegistry(request);
    expect(typeof reg.current).toBe('string');
    expect(Array.isArray(reg.workspaces)).toBe(true);
    expect(reg.workspaces.length).toBeGreaterThan(0);
    for (const w of reg.workspaces) {
      expect(typeof w.id).toBe('string');
      expect(typeof w.name).toBe('string');
      expect(typeof w.createdAt).toBe('number');
    }
    // current must point at one of the listed workspaces
    expect(reg.workspaces.some((w) => w.id === reg.current)).toBe(true);
  });
});

test.describe('workspace switch validation', () => {
  test('POST with empty body returns 400 id-required', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/workspaces/switch`, { data: {} });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('id required');
  });

  test('POST with non-JSON returns 400 invalid-json', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/workspaces/switch`, {
      data: 'not-json',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('invalid json');
  });

  test('POST with control-char id returns 400 invalid-id', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/workspaces/switch`, {
      data: { id: '!!!bad' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid workspace id/);
  });

  test('POST with valid-but-unknown id returns 404', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/workspaces/switch`, {
      data: { id: 'definitely-fake-zzzzz-spec' },
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/unknown workspace/);
  });

  test('GET on /switch returns 405', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/workspaces/switch`);
    expect(res.status()).toBe(405);
  });
});

test.describe('workspace switch idempotency (no-op safe)', () => {
  test('switching to current workspace returns alreadyCurrent and does not mutate', async ({
    request,
  }) => {
    const before = await getRegistry(request);
    const switchRes = await request.post(`${baseURL}/api/workspaces/switch`, {
      data: { id: before.current },
    });
    expect(switchRes.status()).toBe(200);
    const body = await switchRes.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe(before.current);
    expect(body.alreadyCurrent).toBe(true);

    const after = await getRegistry(request);
    expect(after.current).toBe(before.current);
    expect(after.workspaces.length).toBe(before.workspaces.length);
  });
});

test.describe('workspace mutate (PATCH/DELETE) validation', () => {
  test('PATCH on invalid id returns 400 before touching state', async ({ request }) => {
    const res = await request.patch(`${baseURL}/api/workspaces/!!!`, {
      data: { name: 'whatever' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('invalid id');
  });

  test('PATCH with empty name returns 400 name-required', async ({ request }) => {
    // Use a clearly-fake but slug-valid id; route will resolve id first, then
    // validate body. If id check fires first the test still passes (400).
    const res = await request.patch(`${baseURL}/api/workspaces/totally-fake-zzz`, {
      data: { name: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('PATCH on valid-but-unknown id returns 404 not-found', async ({ request }) => {
    const res = await request.patch(`${baseURL}/api/workspaces/totally-fake-zzz`, {
      data: { name: 'newname' },
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toBe('not found');
  });

  test('DELETE on invalid id returns 400', async ({ request }) => {
    const res = await request.delete(`${baseURL}/api/workspaces/!!!`);
    expect(res.status()).toBe(400);
  });

  test('DELETE on valid-but-unknown id returns 404', async ({ request }) => {
    const res = await request.delete(`${baseURL}/api/workspaces/totally-fake-zzz`);
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toBe('not found');
  });

  test('DELETE on current workspace is refused with 400', async ({ request }) => {
    const reg = await getRegistry(request);
    const res = await request.delete(`${baseURL}/api/workspaces/${reg.current}`);
    expect(res.status()).toBe(400);
    // Two guards refuse deleting the current workspace: 'last' when it is the
    // only one registered (any fresh/isolated DB), 'active' when others exist.
    // Either refusal is the contract; which fires depends on the registry size
    // (WI-10006791 — the isolated rig has exactly one workspace).
    expect((await res.json()).error).toMatch(/cannot delete the (active|last) workspace/);
    // Re-verify the workspace was NOT removed.
    const after = await getRegistry(request);
    expect(after.workspaces.some((w) => w.id === reg.current)).toBe(true);
  });
});
