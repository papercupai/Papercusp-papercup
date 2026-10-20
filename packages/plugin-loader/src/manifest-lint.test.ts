/**
 * Tests for manifest-lint.ts.
 *
 * @plugin claimed "8/8 tests pass via bun" in the commit message for
 * 87626906 but the test file itself wasn't included. Adding the
 * coverage so the claim is true on origin/main.
 */

import { describe, it, expect } from 'vitest';
import {
  lintBareWildcardCaps,
  lintWasmActionsAgainstWit,
  lintIframeSameOrigin,
  lintManifest,
  lintToolCapabilityParity,
  type ManifestForLint,
} from './manifest-lint';

describe('lintBareWildcardCaps', () => {
  it('warns on bare-* leaf cap', () => {
    const r = lintBareWildcardCaps({
      name: 'p',
      capabilities: ['compute:exec:*'],
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.rule).toBe('bare-wildcard-cap');
    expect(r[0]!.level).toBe('warning');
  });

  it('accepts subdomain wildcard', () => {
    const r = lintBareWildcardCaps({
      name: 'p',
      capabilities: ['http:fetch:*.example.com'],
    });
    expect(r).toHaveLength(0);
  });

  it('accepts prefix wildcard', () => {
    const r = lintBareWildcardCaps({
      name: 'p',
      capabilities: ['secrets:read:MY_*'],
    });
    expect(r).toHaveLength(0);
  });

  it('checks action-scoped capabilities too', () => {
    const r = lintBareWildcardCaps({
      name: 'p',
      capabilities: [],
      actions: [{ name: 'doStuff', capabilities: ['compute:exec:*'] }],
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.where).toContain('actions[doStuff]');
  });
});

describe('lintWasmActionsAgainstWit', () => {
  it('returns no findings when runtime is not wasm', async () => {
    const r = await lintWasmActionsAgainstWit(
      { name: 'p', runtime: { kind: 'js' } } as ManifestForLint,
      async () => 'export function whatever(): void;',
    );
    expect(r).toHaveLength(0);
  });

  it('warns when .d.ts is not findable', async () => {
    const r = await lintWasmActionsAgainstWit(
      { name: 'p', runtime: { kind: 'wasm', wasmPath: 'pkg/p.wasm' }, actions: [{ name: 'foo' }] },
      async () => null,
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.rule).toBe('wasm-no-dts');
  });

  it('warns when declared action is not in the .d.ts surface', async () => {
    const r = await lintWasmActionsAgainstWit(
      {
        name: 'p',
        runtime: { kind: 'wasm', wasmPath: 'pkg/p.wasm' },
        actions: [{ name: 'doStuff' }, { name: 'doOther' }],
      },
      async () => 'export function doStuff(input: string): string;\n',
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.rule).toBe('wasm-action-not-in-wit');
    expect(r[0]!.message).toContain('doOther');
  });
});

describe('lintIframeSameOrigin', () => {
  it('returns no findings for non-iframe ui entries', () => {
    const r = lintIframeSameOrigin(
      { name: 'p', ui: [{ type: 'react', slug: 'tab' }] },
      () => null,
    );
    expect(r).toHaveLength(0);
  });

  it('errors when iframe entry HTML cannot be read', () => {
    const r = lintIframeSameOrigin(
      { name: 'p', ui: [{ type: 'iframe', iframeEntry: 'missing.html', slug: 'tab' }] },
      () => null,
    );
    expect(r[0]!.rule).toBe('iframe-entry-missing');
    expect(r[0]!.level).toBe('error');
  });

  it('warns on external scripts without a covering http:fetch: cap', () => {
    const r = lintIframeSameOrigin(
      { name: 'p', capabilities: [], ui: [{ type: 'iframe', iframeEntry: 'i.html', slug: 'tab' }] },
      () => '<script src="https://cdn.example.com/lib.js"></script>',
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.rule).toBe('iframe-external-asset');
  });

  it('accepts external scripts when host is in declared http:fetch: caps', () => {
    const r = lintIframeSameOrigin(
      {
        name: 'p',
        capabilities: ['http:fetch:cdn.example.com'],
        ui: [{ type: 'iframe', iframeEntry: 'i.html', slug: 'tab' }],
      },
      () => '<script src="https://cdn.example.com/lib.js"></script>',
    );
    expect(r).toHaveLength(0);
  });
});

describe('lintToolCapabilityParity', () => {
  it('errors on a tools: capability that no declared tool claims (WI-6554700010012944 shape)', () => {
    const r = lintToolCapabilityParity({
      name: 'firecrawl-like',
      capabilities: ['tools:fc:scrape', 'tools:fc:crawl', 'http:fetch:api.example.com'],
      tools: [{ name: 'scrape', capabilities: ['tools:fc:scrape', 'http:fetch:api.example.com'] }],
    });
    expect(r).toEqual([
      expect.objectContaining({ level: 'error', rule: 'tool-cap-without-tool', where: 'firecrawl-like.capabilities' }),
    ]);
    expect(r[0]!.message).toContain("'tools:fc:crawl'");
  });

  it('accepts a manifest whose every tools: capability is claimed by a tool', () => {
    expect(
      lintToolCapabilityParity({
        name: 'p',
        capabilities: ['tools:fc:scrape', 'tools:fc:crawl', 'secrets:read:KEY'],
        tools: [
          { name: 'scrape', capabilities: ['tools:fc:scrape'] },
          { name: 'crawl', capabilities: ['tools:fc:crawl', 'secrets:read:KEY'] },
        ],
      }),
    ).toEqual([]);
  });

  it('skips a dynamic-tools plugin that declares capabilities but no static tools', () => {
    expect(
      lintToolCapabilityParity({ name: 'gitnexus-like', capabilities: ['tools:gx:query', 'tools:gx:context'] }),
    ).toEqual([]);
    expect(
      lintToolCapabilityParity({ name: 'gitnexus-like', capabilities: ['tools:gx:query'], tools: [] }),
    ).toEqual([]);
  });

  it('ignores non-tools capabilities that no tool claims', () => {
    expect(
      lintToolCapabilityParity({
        name: 'p',
        capabilities: ['tools:fc:scrape', 'events:listen:x', 'http:fetch:api.example.com'],
        tools: [{ name: 'scrape', capabilities: ['tools:fc:scrape'] }],
      }),
    ).toEqual([]);
  });
});

describe('lintManifest (compound)', () => {
  it('includes tool-capability parity findings', async () => {
    const r = await lintManifest({
      name: 'p',
      capabilities: ['tools:p:a', 'tools:p:b'],
      tools: [{ name: 'a', capabilities: ['tools:p:a'] }],
    });
    expect(r.map((f) => f.rule)).toEqual(['tool-cap-without-tool']);
  });

  it('aggregates findings from all 3 linters', async () => {
    const r = await lintManifest(
      {
        name: 'p',
        capabilities: ['compute:exec:*'],
        runtime: { kind: 'wasm', wasmPath: 'p.wasm' },
        actions: [{ name: 'doStuff' }],
        ui: [{ type: 'iframe', iframeEntry: 'i.html', slug: 'tab' }],
      },
      {
        wasmDts: async () => 'export function somethingElse(): void;',
        iframeHtml: () => '<script src="https://evil.com/x.js"></script>',
      },
    );
    expect(r.length).toBeGreaterThanOrEqual(3);
    const rules = new Set(r.map((f) => f.rule));
    expect(rules.has('bare-wildcard-cap')).toBe(true);
    expect(rules.has('wasm-action-not-in-wit')).toBe(true);
    expect(rules.has('iframe-external-asset')).toBe(true);
  });
});
