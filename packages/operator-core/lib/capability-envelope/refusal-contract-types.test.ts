/**
 * Pins `refusal-contract-types.ts` as an import-free leaf (WI-10005197).
 *
 * The hosted auth/billing runtimes are esbuild-prebundled by the portal and
 * `hosted-auth-runtime.bundle-cone.test.ts` walks every static `import`/`export … from`
 * edge — `import type` included — so a refusal contract can only be attached there if
 * the shape module reaches nothing heavy. A single import added to the leaf would
 * silently re-widen the cone of every light consumer; this fails at the leaf instead of
 * at a distant bundle-cone red.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RefusalContract as ViaIdentityModule } from './identity-refusal-contract';
import type { RefusalContract as ViaLeaf } from './refusal-contract-types';

describe('refusal-contract-types leaf', () => {
  it('has no import or re-export edges (its static cone is just itself)', () => {
    const source = readFileSync(resolve(__dirname, 'refusal-contract-types.ts'), 'utf8')
      // strip comments so the header prose cannot trip (or hide) the match
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(source.match(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"][^'"]+['"]/g) ?? []).toEqual([]);
    expect(source.match(/(?:^|\n)\s*import\s*['"][^'"]+['"]/g) ?? []).toEqual([]);
  });

  it('is the same type the identity module re-exports (no forked shape)', () => {
    const contract: ViaLeaf = { observed: { a: 'b' }, liftsWhen: 'x', whoCanMakeItTrue: ['owner'] };
    const sameShape: ViaIdentityModule = contract;
    const back: ViaLeaf = sameShape;
    expect(back).toBe(contract);
  });
});
