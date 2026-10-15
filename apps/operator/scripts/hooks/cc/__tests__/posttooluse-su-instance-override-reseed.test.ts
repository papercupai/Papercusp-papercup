/**
 * WI-10004699 — recurrence guard for WI-10004556: editing the papercusp su instance
 * override source must re-seed promptOverride.su at edit time, so the fail-closed
 * launch check never refuses every fresh su launch over a forgotten manual re-seed.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

const HOOK = resolve(__dirname, '../posttooluse-su-instance-override-reseed.mjs');
const ROOT = '/home/u/papercupai-workspace/papercusp';
const SOURCE = `${ROOT}/apps/operator/prompts/pot-instances/papercup-pot.su.md`;

async function hookMod() {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain runtime hook exercised from TypeScript; it has no declaration file.
  return (await import(`file://${HOOK}`)) as typeof import('../posttooluse-su-instance-override-reseed.mjs');
}

function okResponse(body: unknown = { ok: true }) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('posttooluse-su-instance-override-reseed', () => {
  it('targets only the canonical source, for native and MCP edit tools, absolute or relative', async () => {
    const { targetPath } = await hookMod();
    expect(targetPath({ tool_name: 'Edit', tool_input: { file_path: SOURCE } }, ROOT)).toBe(SOURCE);
    expect(
      targetPath(
        {
          tool_name: 'mcp__papercusp-su__capability_write',
          tool_input: { file_path: 'apps/operator/prompts/pot-instances/papercup-pot.su.md' },
        },
        ROOT,
      ),
    ).toBe(SOURCE);
    // Unrelated file, non-edit tool, projection copies: no-op.
    expect(targetPath({ tool_name: 'Edit', tool_input: { file_path: `${ROOT}/README.md` } }, ROOT)).toBeNull();
    expect(targetPath({ tool_name: 'Read', tool_input: { file_path: SOURCE } }, ROOT)).toBeNull();
    expect(
      targetPath(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: `${ROOT}/papercusp-desktop/src-tauri/env-sidecars/staging/prompts/pot-instances/papercup-pot.su.md`,
          },
        },
        ROOT,
      ),
    ).toBeNull();
    expect(
      targetPath(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/home/u/papercupai-workspace/papercup-release/apps/operator/prompts/pot-instances/papercup-pot.su.md' },
        },
        ROOT,
      ),
    ).toBeNull();
  });

  it('re-seeds promptOverride.su for pot papercusp with the exact file contents', async () => {
    const { reseedIfTarget } = await hookMod();
    const fetch = vi.fn(async () => okResponse());
    const result = await reseedIfTarget(
      { tool_name: 'Edit', tool_input: { file_path: SOURCE } },
      { cwd: ROOT, readFile: () => '# su override\nbody\n', fetch, baseUrl: 'http://127.0.0.1:3070' },
    );
    expect(result).toMatchObject({ ok: true, filePath: SOURCE });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3070/api/agent-mcp/pot-override-set');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      potSlug: 'papercusp',
      kind: 'prompt',
      name: 'su',
      value: '# su override\nbody\n',
    });
  });

  it('does nothing for an unrelated edit (no request sent)', async () => {
    const { reseedIfTarget } = await hookMod();
    const fetch = vi.fn();
    const result = await reseedIfTarget(
      { tool_name: 'Edit', tool_input: { file_path: `${ROOT}/apps/operator/prompts/other.md` } },
      { cwd: ROOT, readFile: () => 'x', fetch },
    );
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never clears the override from an empty source', async () => {
    const { reseedIfTarget } = await hookMod();
    const fetch = vi.fn();
    const result = await reseedIfTarget(
      { tool_name: 'Write', tool_input: { file_path: SOURCE } },
      { cwd: ROOT, readFile: () => '   \n', fetch },
    );
    expect(result).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a failed re-seed loudly with the manual recovery command', async () => {
    const { reseedIfTarget, formatResult } = await hookMod();
    const refused = await reseedIfTarget(
      { tool_name: 'Edit', tool_input: { file_path: SOURCE } },
      {
        cwd: ROOT,
        readFile: () => 'body',
        fetch: async () =>
          ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'forbidden' }) }) as unknown as Response,
      },
    );
    expect(refused).toMatchObject({ ok: false });
    expect(refused!.detail).toContain('HTTP 403');

    const down = await reseedIfTarget(
      { tool_name: 'Edit', tool_input: { file_path: SOURCE } },
      {
        cwd: ROOT,
        readFile: () => 'body',
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    );
    expect(down).toMatchObject({ ok: false });
    const msg = formatResult(down!);
    expect(msg).toContain('FAILED');
    expect(msg).toContain('EVERY fresh papercusp su launch is refused');
    expect(msg).toContain('/api/agent-mcp/pot-override-set');
  });

  it('treats an { ok:false } JSON body as a failure even on HTTP 200', async () => {
    const { reseedIfTarget } = await hookMod();
    const result = await reseedIfTarget(
      { tool_name: 'Edit', tool_input: { file_path: SOURCE } },
      { cwd: ROOT, readFile: () => 'body', fetch: async () => okResponse({ ok: false, error: 'boom' }) },
    );
    expect(result).toMatchObject({ ok: false });
  });
});
